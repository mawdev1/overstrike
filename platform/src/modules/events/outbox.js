/**
 * The transactional outbox.  contracts/event-envelope.md §4.
 *
 * Binding rule: a state change and its event are written in the SAME transaction. The failure
 * this prevents is not exotic — commit, then crash before publish — and it is unrecoverable
 * after the fact, because the surviving state carries no trace of the event that is missing.
 *
 * So the API is shaped to make the wrong thing hard rather than merely discouraged:
 *
 *   - There is no exported `emit(event)`. The only way to obtain an emitter is to be inside
 *     `outbox.commit()`, which owns the transaction.
 *   - The emitter is SEALED when the transaction closes. A handle captured and used later
 *     throws instead of quietly writing an orphan row after the commit it belonged to.
 *   - `commit()` requires at least one event by default. A privileged state change that
 *     explains itself with nothing is exactly the gap §4 exists to close; opting out is
 *     possible but has to be typed out (`requireEvent: false`) and shows up in review.
 */
import { buildEvent, toRow, EventContractError } from './envelope.js';

export { EventContractError };

/**
 * @param {object} deps
 * @param {import('../../core/store.js').Store} deps.store
 * @param {{ now: () => number }} [deps.clock]
 * @param {object} [deps.logger]
 */
export function createOutbox({ store, clock = Date, logger = null }) {
  if (!store || !store.outbox || typeof store.tx !== 'function') {
    throw new EventContractError('createOutbox: store must expose tx() and outbox');
  }

  /**
   * Run `work` in one transaction with an emitter bound to it.
   *
   * `work(tx, emit)` receives the transaction handle for its own writes and the emitter for
   * its events. Both go to the same store call, so either everything commits or nothing does.
   *
   * @param {{correlationId: string, causationId?: string|null, actor?: object,
   *          requireEvent?: boolean}} ctx
   * @param {(tx: any, emit: (spec: object) => Promise<object>) => Promise<any>} work
   * @returns {Promise<{result: any, events: object[]}>}
   */
  async function commit(ctx, work) {
    if (typeof work !== 'function') throw new EventContractError('outbox.commit: work must be a function');
    if (!ctx || typeof ctx.correlationId !== 'string' || !ctx.correlationId) {
      throw new EventContractError('outbox.commit: ctx.correlationId is required');
    }
    const requireEvent = ctx.requireEvent !== false;

    let open = true;
    const events = [];

    const result = await store.tx(async (tx) => {
      const emit = async (spec) => {
        // The whole point. A captured emitter used after its transaction would write a row
        // that no state change accompanies — the mirror image of the bug this pattern fixes.
        if (!open) {
          throw new EventContractError(
            'outbox: emit() called outside its transaction; events are written with their state change (§4)',
            { type: spec && spec.type });
        }
        const event = buildEvent({
          ...spec,
          actor: spec.actor ?? ctx.actor,
          // Causation is the edge, correlation the tree (§2): each event in a unit of work is
          // caused by the one before it unless the caller says otherwise.
          causationId: spec.causationId !== undefined
            ? spec.causationId
            : (events.length ? events[events.length - 1].eventId : (ctx.causationId ?? null)),
        }, { clock, defaults: { correlationId: ctx.correlationId } });

        // The row shape is db-schema.md §5; the envelope shape is §2. Mapped here so no
        // caller and no consumer ever sees a column name.
        await store.outbox.insert(toRow(event), tx);
        events.push(event);
        return event;
      };

      const value = await work(tx, emit);

      if (requireEvent && events.length === 0) {
        // Rolls the whole unit of work back. A state change nobody can explain is worse than
        // a failed request: the request can be retried, the unexplained row cannot be found.
        throw new EventContractError(
          'outbox.commit: the unit of work changed state but emitted no event (§4). '
          + 'Pass requireEvent:false only for genuinely event-free work.');
      }
      return value;
    }).finally(() => { open = false; });

    if (logger) {
      for (const e of events) {
        logger.debug('event.staged', {
          correlationId: e.correlationId, eventId: e.eventId, type: e.type,
          subjectKind: e.subject.kind, subjectId: e.subject.id,
        });
      }
    }
    return { result, events };
  }

  /**
   * Enrol in a transaction the caller already owns (a service composing several units of work
   * under one tx). Still transaction-bound: there is no path here that runs without a handle.
   */
  async function emitIn(tx, ctx, spec) {
    if (tx === undefined || tx === null) {
      throw new EventContractError('outbox.emitIn: a transaction handle is required (§4)');
    }
    const event = buildEvent(
      { ...spec, actor: spec.actor ?? ctx.actor },
      { clock, defaults: { correlationId: ctx.correlationId, causationId: ctx.causationId ?? null } });
    await store.outbox.insert(toRow(event), tx);
    return event;
  }

  return { commit, emitIn };
}
