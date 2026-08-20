/**
 * Client telemetry validation.  contracts/telemetry.md §3.3, §3.3.1, §3.4, §3.5, §3.5.1.
 *
 * Two levels, and the difference matters:
 *
 *  - **Event-level rejection.** An unknown name, an out-of-bounds number, a stale timestamp,
 *    a personal event with no consent receipt. These are counted and dropped; the batch still
 *    succeeds (§3.3). One bad event must not cost the other forty-nine.
 *  - **Batch-level rejection.** The §3.5.1 unlinkability rules. These cannot be repaired by
 *    dropping an event, because the violation is the *combination* — a `funnel.preconsent`
 *    travelling next to a personal event has already been linked by the fact that they arrived
 *    together, whichever one we drop afterwards.
 */
import { ApiError } from '../../core/errors.js';
import { isUlid } from '../../core/ids.js';
import { lookupEvent } from './registry.js';

export const LIMITS = {
  maxEvents: 50,
  maxBytes: 64 * 1024,
  maxAgeMs: 30 * 60 * 1000,     // §3.3: older events are dropped, not backdated
  maxFutureSkewMs: 2 * 60 * 1000,
  schemaVersion: 1,
};

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate one payload against its closed registry entry.
 * Returns `{ payload }` on success or `{ reason }` on rejection. Unlisted keys are DROPPED
 * here — they never reach the sink, so there is nothing downstream to filter.
 */
export function validatePayload(spec, raw) {
  if (!isPlainObject(raw)) return { reason: 'payload_not_object' };

  const out = {};
  for (const [key, field] of Object.entries(spec.fields)) {
    const value = raw[key];

    if (value === null) {
      if (!field.nullable) return { reason: `field_null:${key}` };
      out[key] = null;
      continue;
    }
    if (value === undefined) return { reason: `field_missing:${key}` };

    if (field.kind === 'bool') {
      if (typeof value !== 'boolean') return { reason: `field_type:${key}` };
      out[key] = value;
    } else if (field.kind === 'enum') {
      if (typeof value !== 'string' || !field.values.includes(value)) {
        return { reason: `field_enum:${key}` };
      }
      out[key] = value;
    } else if (field.kind === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { reason: `field_type:${key}` };
      if (field.integer && !Number.isInteger(value)) return { reason: `field_not_integer:${key}` };
      // Rejected, not clamped (§3.3.1). Clamping turns a sender bug into a plausible datapoint.
      if (value < field.min || value > field.max) return { reason: `field_out_of_bounds:${key}` };
      out[key] = value;
    } else {
      return { reason: `field_unknown_kind:${key}` };
    }
  }

  if (spec.invariant) {
    const problem = spec.invariant(out);
    if (problem) return { reason: `invariant:${problem}` };
  }
  return { payload: out };
}

/**
 * Batch-level shape and caps. Throws `VALIDATION_FAILED` — these are malformed requests, not
 * partially usable ones.
 */
export function validateBatchShape(body) {
  if (!isPlainObject(body)) throw new ApiError('VALIDATION_FAILED', 'Body must be an object.');
  if (body.schemaVersion !== LIMITS.schemaVersion) {
    throw new ApiError('VALIDATION_FAILED', 'Unsupported telemetry schema version.',
      { details: { expected: LIMITS.schemaVersion } });
  }
  if (!Array.isArray(body.events) || body.events.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'events must be a non-empty array.');
  }
  if (body.events.length > LIMITS.maxEvents) {
    throw new ApiError('PAYLOAD_TOO_LARGE', 'Too many events in one batch.',
      { details: { max: LIMITS.maxEvents } });
  }
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (bytes > LIMITS.maxBytes) {
    throw new ApiError('PAYLOAD_TOO_LARGE', 'Telemetry batch is too large.',
      { details: { max: LIMITS.maxBytes } });
  }
  if (body.clientSessionId !== undefined && !isUlid(body.clientSessionId)) {
    throw new ApiError('VALIDATION_FAILED', 'clientSessionId must be a ULID when present.');
  }
  return { bytes };
}

/**
 * The §3.5.1 unlinkability rules for `funnel.preconsent`.
 *
 * "No correlation to any later event" is only real if the correlation ID cannot be the link.
 * Reusing the eligibility request's id would re-link the visitor through the server logs of a
 * request they made two screens earlier — precisely the linkage this class exists to prevent.
 *
 * Throws `VALIDATION_FAILED` on violation. There is no partial acceptance here on purpose:
 * a client that sends a linked pre-consent event is a client that must be fixed, and quietly
 * dropping the event would leave the defect shipping.
 */
export function enforcePreconsentRules(body, { requestCorrelationId, seenCorrelation }) {
  const indices = [];
  let personalPresent = false;

  // BOTH sides of this classification use the same (name, version) lookup. Classifying
  // pre-consent by name alone while classifying "personal" by lookup let an event this server
  // does not know — `funnel.preconsent` at a version that was never registered — turn an
  // ordinary batch into a pre-consent batch, stripping its clientSessionId and applying rules
  // to events that are about to be rejected as unknown anyway.
  body.events.forEach((e, i) => {
    if (!isPlainObject(e)) return;
    const spec = lookupEvent(e.name, e.version);
    if (!spec) return;
    if (spec.unlinked) { indices.push(i); return; }
    if (spec.privacyClass === 'personal') personalPresent = true;
  });

  if (indices.length === 0) return { preconsentIndices: [] };

  // Rule: a batch containing funnel.preconsent carries no personal-class events. The two never
  // travel together, because arriving together is itself the correlation.
  if (personalPresent) {
    throw new ApiError('VALIDATION_FAILED',
      'A pre-consent batch may not carry personal-class events.',
      { details: { rule: 'preconsent_batch_mixing' } });
  }

  // Rule: clientSessionId absent from the event and from any batch containing one.
  if (body.clientSessionId !== undefined && body.clientSessionId !== null) {
    throw new ApiError('VALIDATION_FAILED',
      'A batch containing funnel.preconsent must omit clientSessionId.',
      { details: { rule: 'preconsent_client_session' } });
  }
  // A receipt on such a batch is an identifier with no purpose (§3.3).
  if (body.consentReceipt !== undefined && body.consentReceipt !== null) {
    throw new ApiError('VALIDATION_FAILED',
      'A batch containing funnel.preconsent must omit consentReceipt.',
      { details: { rule: 'preconsent_receipt' } });
  }

  // Rule: correlationId freshly generated per event — never the request's, never the batch's,
  // never reused between two funnel.preconsent events.
  const withinBatch = new Set();
  for (const i of indices) {
    const e = body.events[i];
    if (!isUlid(e.correlationId)) {
      throw new ApiError('VALIDATION_FAILED',
        'funnel.preconsent requires a freshly generated ULID correlationId.',
        { details: { rule: 'preconsent_correlation_shape', index: i } });
    }
    if (e.clientSessionId !== undefined) {
      throw new ApiError('VALIDATION_FAILED',
        'funnel.preconsent may not carry a clientSessionId.',
        { details: { rule: 'preconsent_client_session', index: i } });
    }
    if (e.correlationId === requestCorrelationId || e.correlationId === body.correlationId) {
      throw new ApiError('VALIDATION_FAILED',
        'funnel.preconsent may not reuse the request or batch correlation id.',
        { details: { rule: 'preconsent_correlation_reuse', index: i } });
    }
    if (withinBatch.has(e.correlationId)) {
      throw new ApiError('VALIDATION_FAILED',
        'Two funnel.preconsent events share a correlation id.',
        { details: { rule: 'preconsent_correlation_reuse', index: i } });
    }
    if (seenCorrelation && seenCorrelation.has(e.correlationId)) {
      throw new ApiError('VALIDATION_FAILED',
        'funnel.preconsent correlation id has been seen before.',
        { details: { rule: 'preconsent_correlation_reuse', index: i } });
    }
    withinBatch.add(e.correlationId);
  }
  for (const id of withinBatch) if (seenCorrelation) seenCorrelation.add(id);

  return { preconsentIndices: indices };
}

/** §3.3: max event age 30 minutes. Older is dropped, never backdated to now. */
export function checkFreshness(occurredAt, nowMs) {
  if (typeof occurredAt !== 'string') return 'occurred_at_missing';
  const t = Date.parse(occurredAt);
  if (Number.isNaN(t)) return 'occurred_at_invalid';
  if (nowMs - t > LIMITS.maxAgeMs) return 'too_old';
  if (t - nowMs > LIMITS.maxFutureSkewMs) return 'occurred_in_future';
  return null;
}
