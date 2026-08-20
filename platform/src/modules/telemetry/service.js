/**
 * Client telemetry ingest.  contracts/telemetry.md §3.3.
 *
 *   POST /v1/telemetry/client        auth OPTIONAL
 *
 * Auth is optional because the landing, sign-up, and display-name steps are the most important
 * events in the funnel and every one of them happens before an account exists.
 *
 * `accountId` is therefore derived SERVER-SIDE from the bearer token and is `null` otherwise.
 * A client-supplied `accountId` would be an attribution forgery primitive, so a field of that
 * name in the body is discarded without ceremony — and counted, because a client sending one
 * is a client someone should look at.
 *
 * Telemetry never blocks the player: this handler answers 202 for anything it can partially
 * accept, and rejections are counts in the response rather than an error the UI must handle.
 */
import { raw } from '../../core/http.js';
import { lookupEvent } from './registry.js';
import {
  LIMITS, validatePayload, validateBatchShape, enforcePreconsentRules, checkFreshness,
} from './validate.js';

/** Bounded memory of pre-consent correlation ids, to make "never reused" enforceable (§3.5.1). */
export function createCorrelationSeen({ capacity = 200_000 } = {}) {
  const seen = new Set();
  const order = [];
  return {
    has: (id) => seen.has(id),
    add: (id) => {
      if (seen.has(id)) return;
      seen.add(id); order.push(id);
      if (order.length > capacity) seen.delete(order.shift());
    },
    size: () => seen.size,
  };
}

/**
 * Fields the client may never decide for itself. Listed by name so the rejection is explicit
 * rather than an accident of which keys the validator happens to copy.
 */
const CLIENT_FORBIDDEN_FIELDS = ['accountId', 'privacyClass', 'retentionClass', 'ip', 'geo'];

/**
 * @param {object} deps
 * @param {{write: (records: object[]) => Promise<void>|void}} deps.sink  warehouse/metrics writer
 * @param {object} deps.logger
 * @param {{verify: Function}} deps.consent
 * @param {{now: () => number}} [deps.clock]
 * @param {{has: Function, add: Function}} [deps.seenCorrelation]
 */
export function createTelemetryService({
  sink, logger, consent, clock = Date, seenCorrelation = createCorrelationSeen(),
}) {

  /**
   * @param {object} args
   * @param {object} args.body            the parsed request body
   * @param {object|null} args.actor      the authenticated actor, or null. THE ONLY accountId source.
   * @param {string} args.correlationId   the request's correlation id
   */
  async function ingest({ body, actor = null, correlationId }) {
    validateBatchShape(body);

    // Derived server-side, full stop. Whatever the body claims is noise.
    const accountId = actor && typeof actor.accountId === 'string' ? actor.accountId : null;
    const forged = CLIENT_FORBIDDEN_FIELDS.filter((f) => body[f] !== undefined);
    if (forged.length) {
      logger.warn('telemetry.client_supplied_server_field', { correlationId, fields: forged });
    }

    // §3.5.1 first: these are properties of the batch, and an event-by-event pass would have
    // already accepted half of a batch that must not exist at all.
    const { preconsentIndices } = enforcePreconsentRules(body, {
      requestCorrelationId: correlationId, seenCorrelation,
    });
    const isPreconsentBatch = preconsentIndices.length > 0;

    const clientSessionId = isPreconsentBatch ? null : (body.clientSessionId ?? null);

    // Verify the receipt once per batch, not per event. `consentOk` false means every
    // personal-class event is rejected while internal-class ones are still accepted (§3.3).
    let consentVerdict = { ok: false, reason: 'receipt_absent' };
    if (typeof body.consentReceipt === 'string' && body.consentReceipt.length > 0) {
      consentVerdict = consent.verify(body.consentReceipt, { accountId, clientSessionId });
    }

    const nowMs = clock.now();
    const accepted = [];
    const rejected = [];
    const reject = (index, name, reason) => rejected.push({ index, name: name ?? null, reason });

    body.events.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reject(index, null, 'event_not_object');

      const spec = lookupEvent(raw.name, raw.version);
      if (!spec) {
        // §3.3: unknown `name` is rejected server-side and counted; the batch still succeeds.
        // Same for a version this server does not know — a newer client is not a failed batch.
        return reject(index, typeof raw.name === 'string' ? raw.name : null, 'unknown_event');
      }

      const stale = checkFreshness(raw.occurredAt, nowMs);
      if (stale) return reject(index, raw.name, stale);

      // §3.4: personal-class requires consent.telemetryPersonal. Internal-class is sent always,
      // because refusing to diagnose a crash is not a privacy win for anyone.
      if (spec.privacyClass === 'personal' && !consentVerdict.ok) {
        return reject(index, raw.name, consentVerdict.reason);
      }

      const result = validatePayload(spec, raw.payload);
      if (result.reason) return reject(index, raw.name, result.reason);

      const record = {
        name: raw.name,
        version: spec.version,
        // Derived from (name, version). Never read from the body — a compromised client would
        // simply declare everything `internal`.
        privacyClass: spec.privacyClass,
        retentionClass: spec.retentionClass,
        occurredAt: new Date(Date.parse(raw.occurredAt)).toISOString(),
        receivedAt: new Date(nowMs).toISOString(),
        payload: result.payload,
      };

      if (spec.unlinked) {
        // §3.5.1: "Stored without any join key. There is no column to correlate on, so the
        // guarantee survives a future query nobody has written yet." No accountId, no
        // clientSessionId, and the event's own fresh id rather than the request's.
        record.accountId = null;
        record.clientSessionId = null;
        record.correlationId = raw.correlationId;
        record.unlinked = true;
      } else if (spec.privacyClass === 'internal') {
        // REQ-CC-055. An account id IS personal linkage, so a record carrying one is not
        // `internal` whatever its class field says — the contract asserted both "internal
        // means no personal data" and "accountId is bearer-derived", and an authenticated
        // client.fps was landing in storage linked to an account.
        //
        // The linkage is dropped, not the event: crash and performance data stays useful in
        // aggregate, and the request correlation id is retained so an operator can still
        // follow one request across tiers. Reclassifying these events as `personal` was the
        // alternative, and it would have made ordinary crash reporting require consent.
        record.accountId = null;
        record.clientSessionId = null;
        record.correlationId = typeof raw.correlationId === 'string' ? raw.correlationId : correlationId;
      } else {
        record.accountId = accountId;
        record.clientSessionId = clientSessionId;
        record.correlationId = typeof raw.correlationId === 'string' ? raw.correlationId : correlationId;
      }

      accepted.push(record);
    });

    if (accepted.length) await sink.write(accepted);

    if (rejected.length) {
      const byReason = {};
      for (const r of rejected) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
      logger.info('telemetry.rejected', { correlationId, count: rejected.length, byReason });
    }

    return {
      accepted: accepted.length,
      rejected: rejected.length,
      rejections: rejected,
      records: accepted,
      accountId,
      consent: consentVerdict.ok,
      consentReceiptError: receiptFault(consentVerdict, rejected),
    };
  }

  return { ingest, seenCorrelation };
}

/**
 * The receipt verdicts that mean "this receipt is not usable", as opposed to "this player said
 * no".  errors.md `CONSENT_RECEIPT_INVALID`, telemetry.md §3.3.
 *
 * `consent_declined` is deliberately absent. A valid receipt recording a decline is the system
 * working: the personal events are dropped and the client must NOT be sent back to the consent
 * screen to be asked the same question it already answered.
 */
const RECEIPT_FAULT_REASONS = new Set([
  'receipt_absent', 'receipt_malformed', 'receipt_signature_invalid',
  'receipt_expiry_invalid', 'receipt_expired', 'receipt_policy_stale',
  'receipt_subject_mismatch', 'receipt_unbound',
]);

/**
 * The typed verdict the 202 carries, or null.
 *
 * Non-null only when a personal event was ACTUALLY dropped for the receipt. An internal-only
 * batch legitimately carries no receipt (§3.3), so reporting `receipt_absent` on one would tell
 * every pre-consent sender to route its visitor to a screen it is already on.
 *
 * This exists because the reason previously lived in a server log line and nowhere else: an
 * expired or subject-mismatched receipt silently discarded the whole personal funnel, the
 * client saw `202 {accepted: 0}`, and the one recovery available to it — re-obtaining consent —
 * was unreachable because nothing told it which of a dozen causes it was looking at.
 */
function receiptFault(verdict, rejected) {
  if (verdict.ok || !RECEIPT_FAULT_REASONS.has(verdict.reason)) return null;
  if (!rejected.some((r) => r.reason === verdict.reason)) return null;
  return { code: 'CONSENT_RECEIPT_INVALID', reason: verdict.reason };
}

/**
 * Route registration. Kept separate from `ingest` so tests exercise the rules directly rather
 * than through a socket, and so the endpoint's wire shape is visible in one place.
 */
export function registerTelemetryRoutes(router, { service, optionalAuth = null }) {
  router.post('/v1/telemetry/client', async (ctx) => {
    const result = await service.ingest({
      body: ctx.body,
      actor: ctx.actor,               // set by auth middleware when a token is present; null otherwise
      correlationId: ctx.correlationId,
    });
    // 202: accepted for processing. Telemetry has no synchronous meaning to the client, and the
    // per-EVENT reasons stay in the log — a client cannot act on a payload it already sent.
    //
    // `consentReceiptError` is the one exception, and it is always present so that null is a
    // stated "the receipt was fine" rather than a key the client has to test for existence.
    // There IS an action behind it: go back to consent and get a new receipt.
    return raw(202, {
      accepted: result.accepted, rejected: result.rejected,
      consentReceiptError: result.consentReceiptError,
      correlationId: ctx.correlationId,
    });
    // `{ auth: 'optional' }` was not an option core/http.js reads — it honours `middleware`
    // and `requireBuild` only. So no middleware ran, ctx.actor was permanently undefined, and
    // an authenticated player's telemetry could never be attributed or bound to an
    // account-scoped receipt. An option a router ignores is worse than no option: it reads
    // like a guarantee.
  }, optionalAuth ? { middleware: [optionalAuth] } : {});
  return router;
}

export { LIMITS };
