/**
 * Consumer scaffolding.  contracts/event-envelope.md §3 and §8.
 *
 * Two rules that every consumer in the platform has to obey and that nobody should reimplement:
 *
 *  1. Dedupe on `eventId`. Delivery is at-least-once, so a consumer that double-counts on
 *     replay is a defect, not an operational caveat (§3).
 *  2. Ignore unknown types (§8). A new event type must not require a coordinated deploy of
 *     every consumer, so an unrecognised `type` is a counter, not an exception.
 */

/** Default dedupe memory. A real deployment backs this with a table keyed by (consumer, eventId). */
export function createMemoryDedupe({ capacity = 100_000 } = {}) {
  const seen = new Set();
  const order = [];
  return {
    has: (eventId) => seen.has(eventId),
    add: (eventId) => {
      if (seen.has(eventId)) return;
      seen.add(eventId); order.push(eventId);
      // Bounded so a long-running consumer does not grow without limit; ULIDs are time-ordered
      // so the oldest is also the least likely to be redelivered.
      if (order.length > capacity) seen.delete(order.shift());
    },
    size: () => seen.size,
  };
}

/**
 * @param {object} opts
 * @param {string} opts.name                consumer identity, for logs and dedupe scoping
 * @param {Record<string, (event: object) => any>} opts.handlers  keyed by event type
 * @param {object} opts.logger
 * @param {{has: Function, add: Function}} [opts.dedupe]
 */
export function createConsumer({ name, handlers, logger, dedupe = createMemoryDedupe() }) {
  const stats = { handled: 0, duplicates: 0, unknown: 0, failed: 0 };

  async function deliver(event) {
    if (dedupe.has(event.eventId)) {
      stats.duplicates++;
      return { status: 'duplicate' };
    }
    const handler = handlers[event.type];
    if (!handler) {
      stats.unknown++;
      // §8: ignore and continue. Info, not warn — an unknown type is the expected consequence
      // of another team shipping first, not an incident.
      logger.info('consumer.unknown_type', { consumer: name, type: event.type, eventId: event.eventId });
      // Marked seen: replaying a type this consumer will never handle is pure work.
      dedupe.add(event.eventId);
      return { status: 'ignored' };
    }
    try {
      await handler(event);
    } catch (err) {
      stats.failed++;
      // NOT marked seen: a handler that threw has not applied the event, so redelivery is the
      // correct outcome and the relay's retry budget is what bounds it.
      logger.error('consumer.handler_failed', {
        consumer: name, type: event.type, eventId: event.eventId,
        correlationId: event.correlationId, cause: String(err && err.message ? err.message : err),
      });
      throw err;
    }
    dedupe.add(event.eventId);
    stats.handled++;
    return { status: 'handled' };
  }

  return { name, deliver, stats, dedupe };
}
