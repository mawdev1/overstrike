/**
 * The outbox relay.  contracts/event-envelope.md §3 and §4.
 *
 * Claims unpublished rows, publishes, marks published. At-least-once by construction: it may
 * publish, fail before marking, and publish the same event again after a restart. That is not
 * a defect to be engineered away — it is the trade §3 makes, and it is why every consumer
 * dedupes on `eventId`.
 *
 * Ordering is per `(subject.kind, subject.id)`, NOT global. Two events about one match arrive
 * in order; two events about different matches have no relationship, and pretending otherwise
 * would serialise the entire platform behind its slowest consumer.
 */
import { orderingKey, fromRow } from './envelope.js';

const DEFAULTS = {
  batchSize: 100,
  maxAttempts: 5,          // the retry budget; after this the row is dead-lettered with an alert
  baseBackoffMs: 250,
  maxBackoffMs: 60_000,
};

/**
 * @param {object} deps
 * @param {import('../../core/store.js').Store} deps.store
 * @param {(event: object) => Promise<void>} deps.publish  the transport; may throw
 * @param {object} deps.logger
 * @param {{now: () => number}} [deps.clock]
 * @param {object} [deps.config]
 * @param {(info: object) => void} [deps.onDeadLetter]  paging hook; the log line is the record
 */
export function createRelay({ store, publish, logger, clock = Date, config = {}, onDeadLetter = null }) {
  const cfg = { ...DEFAULTS, ...config };

  /**
   * Retry schedule, in memory and deliberately so.
   *
   * The outbox table records `attempts` but not "not before"; a restart therefore retries
   * everything immediately. That is safe precisely because delivery is at-least-once — the
   * worst case is an early retry, not a lost or duplicated-beyond-tolerance event. Persisting
   * a wake time would buy nothing a consumer's idempotency does not already provide.
   */
  const notBefore = new Map();

  const backoffMs = (attempts) =>
    Math.min(cfg.maxBackoffMs, cfg.baseBackoffMs * 2 ** Math.max(0, attempts - 1));

  const stats = { published: 0, failed: 0, deadLettered: 0 };

  /**
   * One pass. Returns what it did, so a caller can loop until idle in a test and a scheduler
   * can back off when there is nothing to do.
   */
  async function runOnce() {
    const claimed = await store.outbox.claimUnpublished(cfg.batchSize);
    const now = clock.now();
    const due = claimed.filter((e) => (notBefore.get(e.eventId) ?? 0) <= now);
    if (due.length === 0) return { claimed: claimed.length, published: 0, failed: 0, deadLettered: 0 };

    // Group by ordering key. Within a group, strictly sequential and stop-on-failure: letting
    // event 2 pass while event 1 is retrying is exactly the reordering §3 promises never
    // happens for one subject. Across groups, independent.
    //
    // The store hands back `events_outbox` rows (db-schema.md §5); consumers are owed §2
    // envelopes. The rehydration happens here so the relay is the only place that knows both.
    const groups = new Map();
    for (const row of due) {
      const key = orderingKey(fromRow(row));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1
        : (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0)));
    }

    const pass = { claimed: claimed.length, published: 0, failed: 0, deadLettered: 0 };

    await Promise.all([...groups.entries()].map(async ([, list]) => {
      for (const row of list) {
        const event = fromRow(row);
        try {
          await publish(event);
          // Publish-then-mark. The reverse order would lose an event on a crash in between,
          // and losing one is strictly worse than delivering one twice (§3).
          await store.outbox.markPublished([event.eventId], new Date(clock.now()).toISOString());
          notBefore.delete(event.eventId);
          pass.published++; stats.published++;
        } catch (err) {
          const message = String(err && err.message ? err.message : err);
          const attempts = (row.attempts ?? 0) + 1;
          await store.outbox.recordFailure(event.eventId, message);
          pass.failed++; stats.failed++;

          if (attempts >= cfg.maxAttempts) {
            await store.outbox.deadLetter(event.eventId, new Date(clock.now()).toISOString());
            notBefore.delete(event.eventId);
            pass.deadLettered++; stats.deadLettered++;
            // §3: "a silently dropped event is the worst outcome available." This line is the
            // alert. It is error level and it names the subject so the state can be rebuilt.
            logger.error('outbox.dead_letter', {
              eventId: event.eventId, type: event.type, attempts,
              subjectKind: event.subject.kind, subjectId: event.subject.id,
              correlationId: event.correlationId, lastError: message,
            });
            if (onDeadLetter) onDeadLetter({ event, attempts, error: err });
          } else {
            notBefore.set(event.eventId, clock.now() + backoffMs(attempts));
            logger.warn('outbox.publish_failed', {
              eventId: event.eventId, type: event.type, attempts,
              retryInMs: backoffMs(attempts), correlationId: event.correlationId,
            });
          }
          // Head-of-line block for THIS subject only; other subjects continue.
          break;
        }
      }
    }));

    return pass;
  }

  let timer = null;
  let stopped = false;

  /** Poll loop. Unref'd so a relay never keeps a process alive on its own. */
  function start({ intervalMs = 200 } = {}) {
    stopped = false;
    const tick = async () => {
      if (stopped) return;
      try { await runOnce(); }
      catch (err) { logger.error('outbox.relay_error', { cause: String(err && err.stack || err) }); }
      if (!stopped) { timer = setTimeout(tick, intervalMs); timer.unref?.(); }
    };
    timer = setTimeout(tick, intervalMs); timer.unref?.();
  }

  function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; }

  /** Drain until nothing more can be published. Bounded so a permanently failing row cannot spin. */
  async function drain({ maxPasses = 1000 } = {}) {
    const total = { published: 0, failed: 0, deadLettered: 0, passes: 0 };
    for (let i = 0; i < maxPasses; i++) {
      const pass = await runOnce();
      total.passes++;
      total.published += pass.published;
      total.failed += pass.failed;
      total.deadLettered += pass.deadLettered;
      if (pass.published === 0 && pass.failed === 0) break;
    }
    return total;
  }

  return { runOnce, drain, start, stop, stats, backoffMs };
}
