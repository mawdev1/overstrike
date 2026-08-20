/**
 * Client telemetry ingest, in plain Node.  contracts/telemetry.md §3.
 *
 * The rules under test are all rules about what the SERVER refuses to believe. A client can
 * send anything; the question is whether an accountId, a privacy class, or a link between a
 * pre-consent count and a person can be established by asking nicely. Every claim is paired
 * with the control that would pass if the rule were absent.
 *
 *   node platform/test/telemetrytest.mjs
 */
import { createTelemetryService, createCorrelationSeen } from '../src/modules/telemetry/service.js';
import { createConsentReceipts } from '../src/modules/telemetry/consent.js';
import { lookupEvent, REGISTRY } from '../src/modules/telemetry/registry.js';
import { LIMITS } from '../src/modules/telemetry/validate.js';
import { ulid } from '../src/core/ids.js';
import { createHmac } from 'node:crypto';

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const assert = (n, cond, detail = '') => (cond ? ok(n) : bad(n, detail));

async function refuses(name, fn, match) {
  try { await fn(); bad(name, 'expected a refusal, got acceptance'); }
  catch (err) {
    const text = `${err.code || ''} ${err.message} ${JSON.stringify(err.details || {})}`;
    if (match && !text.includes(match)) bad(name, `refused for the wrong reason: ${text}`);
    else ok(name);
  }
}

const fakeClock = (start = Date.parse('2026-08-19T12:00:00.000Z')) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

const capturingLogger = () => {
  const lines = [];
  const rec = (level) => (event, fields = {}) => lines.push({ level, event, ...fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
};

/** The warehouse writer. Everything the server decided to keep lands here and nowhere else. */
const capturingSink = () => {
  const records = [];
  return { records, write: (rows) => { records.push(...rows); } };
};

const SECRET = 'test-secret-at-least-16-chars';

function harness({ clock = fakeClock(), seen = createCorrelationSeen() } = {}) {
  const logger = capturingLogger();
  const sink = capturingSink();
  const consent = createConsentReceipts({ secret: SECRET, clock });
  const service = createTelemetryService({ sink, logger, consent, clock, seenCorrelation: seen });
  return { service, sink, logger, consent, clock, seen };
}

const at = (clock) => new Date(clock.now()).toISOString();

const batch = (events, extra = {}) => ({ schemaVersion: 1, events, ...extra });

const ev = (name, payload, clock, extra = {}) =>
  ({ name, version: 1, occurredAt: at(clock), ...extra, payload });

// =============================================================================================
console.log('\nthe registry is the allowlist');
// =============================================================================================
{
  assert('every registry entry declares a privacy and a retention class',
    [...REGISTRY.values()].every((s) => s.privacyClass && s.retentionClass));
  assert('every registry entry has a closed payload',
    [...REGISTRY.values()].every((s) => s.fields && Object.keys(s.fields).length > 0));
  assert('privacy class is looked up by (name, version), not by name alone',
    lookupEvent('flow.step', 1) !== null && lookupEvent('flow.step', 2) === null);
  assert('flow.step begins at signup — the earlier steps precede the consent decision',
    !REGISTRY.get('flow.step').fields.step.values.includes('landing')
    && REGISTRY.get('funnel.preconsent').fields.step.values.includes('landing'));
  assert('funnel.preconsent cannot carry the decision value',
    !Object.keys(REGISTRY.get('funnel.preconsent').fields).includes('decision'));
  assert('client.error carries a class, never a raw message',
    Object.keys(REGISTRY.get('client.error').fields).join(',') === 'errorClass,fatal');
}

// =============================================================================================
console.log('\n§3.3 accountId is derived server-side, never taken from the client');
// =============================================================================================
{
  const clock = fakeClock();
  const { service, sink, consent } = harness({ clock });

  // Signed out, and the client claims to be somebody.
  const anon = await service.ingest({
    body: batch([ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock)],
      { accountId: 'ACCOUNT-I-WISH-I-WAS' }),
    actor: null,
    correlationId: ulid(),
  });
  assert('a signed-out batch is accepted', anon.accepted === 1, JSON.stringify(anon.rejections));
  assert('the client-supplied accountId is discarded, not stored',
    sink.records[0].accountId === null, String(sink.records[0].accountId));

  // Signed in as someone else entirely, still claiming a third identity. A PERSONAL event,
  // because the point is bearer-derived attribution — and §3.5.0 now stores internal records
  // with no account at all, so `client.fps` could not demonstrate this even when it worked.
  const authed = await service.ingest({
    body: batch([ev('flow.step', { step: 'signup', outcome: 'completed', errorCode: null }, clock)],
      { accountId: 'ACCOUNT-I-WISH-I-WAS',
        consentReceipt: consent.issue({ subject: 'account', subjectId: 'REAL-ACCOUNT-01', telemetryPersonal: true, policyVersion: 1 }) }),
    actor: { accountId: 'REAL-ACCOUNT-01' },
    correlationId: ulid(),
  });
  assert('the accountId comes from the bearer token', authed.accountId === 'REAL-ACCOUNT-01');
  const personalRecord = sink.records.find((r) => r.name === 'flow.step');
  assert('and that is what is stored on a PERSONAL record',
    personalRecord?.accountId === 'REAL-ACCOUNT-01', String(personalRecord?.accountId));

  // §3.5.0: an authenticated INTERNAL record is stored with no account linkage at all. An
  // account id is personal linkage, so a linked record is not internal whatever its class says.
  await service.ingest({
    body: batch([ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock)]),
    actor: { accountId: 'REAL-ACCOUNT-01' },
    correlationId: ulid(),
  });
  const internalRecord = sink.records.find((r) => r.name === 'client.fps');
  assert('an authenticated INTERNAL record stores no accountId',
    internalRecord?.accountId === null && internalRecord?.clientSessionId === null,
    JSON.stringify({ a: internalRecord?.accountId, c: internalRecord?.clientSessionId }));
  // CONTROL: if the body were trusted, this value would have reached the warehouse.
  assert('CONTROL: the forged value appears nowhere in the stored records',
    !JSON.stringify(sink.records).includes('ACCOUNT-I-WISH-I-WAS'));
}

// =============================================================================================
console.log('\n§3.3.1 the privacy class is derived, never accepted from the client');
// =============================================================================================
{
  const { service, sink, consent } = harness();
  const clock = fakeClock();
  const receipt = consent.issue({ subject: 'account', subjectId: 'A1', telemetryPersonal: true, policyVersion: 1 });

  const res = await service.ingest({
    body: batch([
      // A modified client declaring its funnel event harmless, and its health event precious.
      ev('flow.step', { step: 'signup', outcome: 'completed', errorCode: null }, clock, { privacyClass: 'internal' }),
      ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock, { privacyClass: 'sensitive' }),
    ], { consentReceipt: receipt, privacyClass: 'internal' }),
    actor: { accountId: 'A1' },
    correlationId: ulid(),
  });

  assert('both events are accepted', res.accepted === 2, JSON.stringify(res.rejections));
  const flow = sink.records.find((r) => r.name === 'flow.step');
  const fps = sink.records.find((r) => r.name === 'client.fps');
  assert('flow.step is stored as personal despite the client saying internal',
    flow.privacyClass === 'personal', flow.privacyClass);
  assert('client.fps is stored as internal despite the client saying sensitive',
    fps.privacyClass === 'internal', fps.privacyClass);
  assert('retention comes from the registry too, not from the batch',
    flow.retentionClass === 'standard' && fps.retentionClass === 'short',
    `${flow.retentionClass}/${fps.retentionClass}`);

  // CONTROL: the same client-declared class on a batch with NO consent must not rescue the
  // personal event — proving the class, not the label, is what gates it.
  const { service: s2, sink: sink2 } = harness();
  const res2 = await s2.ingest({
    body: batch([ev('flow.step', { step: 'signup', outcome: 'completed', errorCode: null }, clock, { privacyClass: 'internal' })]),
    actor: { accountId: 'A1' },
    correlationId: ulid(),
  });
  assert('CONTROL: declaring a personal event "internal" does not bypass consent',
    res2.accepted === 0 && sink2.records.length === 0 && res2.rejections[0].reason === 'receipt_absent',
    JSON.stringify(res2.rejections));
}

// =============================================================================================
console.log('\n§3.3/§3.4 consent gating — personal rejected, internal still accepted');
// =============================================================================================
{
  const { service, sink } = harness();
  const clock = fakeClock();
  const mixed = () => batch([
    ev('flow.step', { step: 'display-name', outcome: 'completed', errorCode: null }, clock),
    ev('client.fps', { p50: 58, p01: 22, windowSec: 60 }, clock),
    ev('lobby.abandoned', { lastState: 'countdown', dwellSec: 12 }, clock),
  ], { clientSessionId: ulid() });

  const noReceipt = await service.ingest({ body: mixed(), actor: { accountId: 'A1' }, correlationId: ulid() });
  assert('the batch as a whole still succeeds', noReceipt.accepted + noReceipt.rejected === 3);
  assert('personal events without a receipt are rejected',
    noReceipt.rejected === 2 && noReceipt.rejections.every((r) => r.reason === 'receipt_absent'),
    JSON.stringify(noReceipt.rejections));
  assert('internal events in the same batch are accepted',
    noReceipt.accepted === 1 && sink.records[0].name === 'client.fps');

  const forged = await service.ingest({
    body: { ...mixed(), consentReceipt: 'not.a.real.receipt' },
    actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('a forged receipt is rejected by signature',
    forged.accepted === 1 && forged.rejections.every((r) => r.reason === 'receipt_signature_invalid'),
    JSON.stringify(forged.rejections));

  // A receipt issued for a DIFFERENT subject must not travel.
  const { consent } = harness();
  const someoneElse = consent.issue({ subject: 'account', subjectId: 'A2', telemetryPersonal: true, policyVersion: 1 });
  const replayed = await service.ingest({
    body: { ...mixed(), consentReceipt: someoneElse },
    actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  // The counts are asserted with the reason on purpose: `[].every(...)` is true, so a binding
  // check that had stopped refusing altogether would have satisfied the reason clause alone.
  assert('a valid receipt belonging to another subject is rejected',
    replayed.accepted === 1 && replayed.rejected === 2
    && replayed.rejections.every((r) => r.reason === 'receipt_subject_mismatch'),
    JSON.stringify(replayed));

  const declined = consent.issue({ subject: 'account', subjectId: 'A1', telemetryPersonal: false, policyVersion: 1 });
  const declinedRes = await service.ingest({
    body: { ...mixed(), consentReceipt: declined }, actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('a receipt recording a DECLINE is not consent',
    declinedRes.rejections.every((r) => r.reason === 'consent_declined'), JSON.stringify(declinedRes.rejections));
  assert('a player who declined still produces internal telemetry', declinedRes.accepted === 1);

  // CONTROL: with a valid, subject-bound receipt all three land — so the rejections above are
  // about consent and not about the events being unacceptable for some other reason.
  const good = consent.issue({ subject: 'account', subjectId: 'A1', telemetryPersonal: true, policyVersion: 1 });
  const okRes = await service.ingest({
    body: { ...mixed(), consentReceipt: good }, actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('CONTROL: with a valid receipt every event is accepted',
    okRes.accepted === 3 && okRes.rejected === 0, JSON.stringify(okRes.rejections));

  // Expiry: signed-out consent has a 30-day TTL (http-api.md §3a.4).
  const clock2 = fakeClock();
  const h2 = harness({ clock: clock2 });
  const sessionId = ulid();
  const sessionReceipt = h2.consent.issue({ subject: 'client-session', subjectId: sessionId, telemetryPersonal: true, policyVersion: 1 });
  clock2.advance(31 * 24 * 60 * 60 * 1000);
  const expired = await h2.service.ingest({
    body: batch([ev('flow.step', { step: 'signup', outcome: 'completed', errorCode: null }, clock2)],
      { clientSessionId: sessionId, consentReceipt: sessionReceipt }),
    actor: null, correlationId: ulid(),
  });
  assert('an expired receipt is not consent',
    expired.rejections[0]?.reason === 'receipt_expired', JSON.stringify(expired.rejections));
}

// =============================================================================================
console.log('\n§3.5.1 funnel.preconsent is unlinked, enforceably');
// =============================================================================================
{
  const clock = fakeClock();
  const { service, sink, consent } = harness({ clock });
  const requestId = ulid();

  const clean = await service.ingest({
    body: batch([
      ev('funnel.preconsent', { step: 'landing', outcome: 'viewed' }, clock, { correlationId: ulid() }),
      ev('funnel.preconsent', { step: 'consent', outcome: 'viewed' }, clock, { correlationId: ulid() }),
    ]),
    actor: null, correlationId: requestId,
  });
  assert('a clean pre-consent batch is accepted', clean.accepted === 2, JSON.stringify(clean.rejections));
  assert('nothing stored carries a join key',
    sink.records.every((r) => r.accountId === null && r.clientSessionId === null && r.unlinked === true));
  assert('the stored correlation id is the event\'s own, not the request\'s',
    sink.records.every((r) => r.correlationId !== requestId));

  // A pre-consent event must never share a batch with a personal-class event.
  await refuses('a funnel.preconsent event sharing a batch with a personal event is rejected',
    () => service.ingest({
      body: batch([
        ev('funnel.preconsent', { step: 'landing', outcome: 'viewed' }, clock, { correlationId: ulid() }),
        ev('flow.step', { step: 'signup', outcome: 'viewed', errorCode: null }, clock),
      ]),
      actor: { accountId: 'A1' }, correlationId: ulid(),
    }),
    'preconsent_batch_mixing');

  // The correlation id must be fresh. Reusing the request's id would re-link the visitor
  // through the server logs of a request they made two screens earlier.
  const reusedRequestId = ulid();
  await refuses('reusing the request correlation id on funnel.preconsent is rejected',
    () => service.ingest({
      body: batch([ev('funnel.preconsent', { step: 'eligibility', outcome: 'completed' }, clock, { correlationId: reusedRequestId })]),
      actor: null, correlationId: reusedRequestId,
    }),
    'preconsent_correlation_reuse');

  const shared = ulid();
  await refuses('two funnel.preconsent events sharing a correlation id are rejected',
    () => service.ingest({
      body: batch([
        ev('funnel.preconsent', { step: 'landing', outcome: 'viewed' }, clock, { correlationId: shared }),
        ev('funnel.preconsent', { step: 'consent', outcome: 'viewed' }, clock, { correlationId: shared }),
      ]),
      actor: null, correlationId: ulid(),
    }),
    'preconsent_correlation_reuse');

  const once = ulid();
  await service.ingest({
    body: batch([ev('funnel.preconsent', { step: 'landing', outcome: 'viewed' }, clock, { correlationId: once })]),
    actor: null, correlationId: ulid(),
  });
  await refuses('a correlation id reused across two batches is rejected',
    () => service.ingest({
      body: batch([ev('funnel.preconsent', { step: 'consent', outcome: 'viewed' }, clock, { correlationId: once })]),
      actor: null, correlationId: ulid(),
    }),
    'preconsent_correlation_reuse');

  await refuses('a pre-consent batch carrying a clientSessionId is rejected',
    () => service.ingest({
      body: batch([ev('funnel.preconsent', { step: 'landing', outcome: 'viewed' }, clock, { correlationId: ulid() })],
        { clientSessionId: ulid() }),
      actor: null, correlationId: ulid(),
    }),
    'preconsent_client_session');

  await refuses('a pre-consent event carrying its own clientSessionId is rejected',
    () => service.ingest({
      body: batch([ev('funnel.preconsent', { step: 'landing', outcome: 'viewed' }, clock,
        { correlationId: ulid(), clientSessionId: ulid() })]),
      actor: null, correlationId: ulid(),
    }),
    'preconsent_client_session');

  await refuses('a consent receipt on a pre-consent batch is rejected — an identifier with no purpose',
    () => service.ingest({
      body: batch([ev('funnel.preconsent', { step: 'landing', outcome: 'viewed' }, clock, { correlationId: ulid() })],
        { consentReceipt: consent.issue({ subject: 'account', subjectId: 'A1', telemetryPersonal: true, policyVersion: 1 }) }),
      actor: null, correlationId: ulid(),
    }),
    'preconsent_receipt');

  // This control previously asserted that an ordinary INTERNAL batch may carry a
  // clientSessionId. That contradicts §3.5, which says the field "is present only when the
  // batch contains at least one personal-class event" — so an internal-only batch must omit
  // it, whether or not a funnel.preconsent event happens to be present. The test was asserting
  // the linkage the class exists to prevent, and a passing test that contradicts its contract
  // is worse than a missing one: it defends the defect.
  await refuses('an internal-only batch may NOT carry a clientSessionId',
    () => service.ingest({
      body: batch([ev('client.fps', { p50: 60, p01: 40, windowSec: 30 }, clock)], { clientSessionId: ulid() }),
      actor: null, correlationId: ulid(),
    }),
    'internal_only_client_session');

  // CONTROL: the same events with no linkage are accepted, so the rule is not a blanket ban.
  const control = await service.ingest({
    body: batch([ev('client.fps', { p50: 60, p01: 40, windowSec: 30 }, clock)]),
    actor: null, correlationId: ulid(),
  });
  assert('CONTROL: an unlinked internal batch is accepted', control.accepted === 1,
    JSON.stringify(control.rejections));
}

// =============================================================================================
console.log('\n§3.3.1 payloads — bounds rejected not clamped, unlisted keys dropped');
// =============================================================================================
{
  const clock = fakeClock();
  const { service, sink } = harness({ clock });

  const res = await service.ingest({
    body: batch([
      ev('client.frame_time', { p50Ms: 8, p95Ms: 20, p99Ms: 900000 }, clock),        // 900 s frame
      ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock),
      ev('client.heap', { usedMb: -1, sampledAtSec: 10 }, clock),
      ev('client.asset_build', { ms: 1200 }, clock),
    ]),
    actor: null, correlationId: ulid(),
  });

  assert('an out-of-bounds numeric is rejected',
    res.rejections.some((r) => r.name === 'client.frame_time' && r.reason === 'field_out_of_bounds:p99Ms'),
    JSON.stringify(res.rejections));
  assert('a negative value below the floor is rejected',
    res.rejections.some((r) => r.name === 'client.heap' && r.reason === 'field_out_of_bounds:usedMb'));
  assert('the out-of-bounds value was NOT clamped into the warehouse',
    !sink.records.some((r) => r.name === 'client.frame_time'),
    JSON.stringify(sink.records.map((r) => r.name)));
  assert('valid events in the same batch still land', res.accepted === 2);

  // CONTROL: the same event at the ceiling is accepted, so the rejection is about the bound
  // and not about the field being unusable.
  const edge = await service.ingest({
    body: batch([ev('client.frame_time', { p50Ms: 0, p95Ms: 10000, p99Ms: 10000 }, clock)]),
    actor: null, correlationId: ulid(),
  });
  assert('CONTROL: a value exactly at the bound is accepted', edge.accepted === 1, JSON.stringify(edge.rejections));

  // Unlisted keys are dropped before storage, not stored and filtered.
  const dropped = await service.ingest({
    body: batch([ev('client.error', { errorClass: 'net-decode', fatal: false, rawMessage: 'Ghost said hi in chat' }, clock)]),
    actor: null, correlationId: ulid(),
  });
  const stored = sink.records.find((r) => r.name === 'client.error');
  assert('an unlisted payload key never reaches the sink',
    dropped.accepted === 1 && stored.payload.rawMessage === undefined
    && !JSON.stringify(sink.records).includes('Ghost said hi in chat'),
    JSON.stringify(stored.payload));

  // settings.friction is personal-class, so it needs a receipt before the payload rule is
  // even reached — otherwise this would assert the consent gate a second time by accident.
  const { service: sEnum, consent: cEnum } = harness({ clock });
  const enumReceipt = cEnum.issue({ subject: 'account', subjectId: 'A1', telemetryPersonal: true, policyVersion: 1 });
  const enumBad = await sEnum.ingest({
    body: batch([
      ev('settings.friction', { category: 'Audio & Captions', duringFirstSession: true }, clock),
      ev('client.error', { errorClass: 'the disk exploded', fatal: true }, clock),
    ], { consentReceipt: enumReceipt, clientSessionId: ulid() }),
    actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('a display label where a vocabulary id belongs is rejected',
    enumBad.rejections.some((r) => r.reason === 'field_enum:category'), JSON.stringify(enumBad.rejections));
  assert('an error class outside the closed set is rejected',
    enumBad.rejections.some((r) => r.reason === 'field_enum:errorClass'));

  const missing = await service.ingest({
    body: batch([ev('client.fps', { p50: 60, p01: 30 }, clock)]),
    actor: null, correlationId: ulid(),
  });
  assert('a missing required field is rejected',
    missing.rejections[0].reason === 'field_missing:windowSec', JSON.stringify(missing.rejections));

  // flow.step's invariant: errorCode required on failure, null otherwise.
  const { service: s3, consent: c3 } = harness({ clock });
  const receipt = c3.issue({ subject: 'account', subjectId: 'A1', telemetryPersonal: true, policyVersion: 1 });
  const inv = await s3.ingest({
    body: batch([
      ev('flow.step', { step: 'verify', outcome: 'failed', errorCode: null }, clock),
      ev('flow.step', { step: 'verify', outcome: 'failed', errorCode: 'AUTH_TOKEN_EXPIRED' }, clock),
    ], { consentReceipt: receipt, clientSessionId: ulid() }),
    actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('a failed step with no error code is rejected; the one with a code is kept',
    inv.accepted === 1 && inv.rejections[0].reason.startsWith('invariant:'), JSON.stringify(inv.rejections));
}

// =============================================================================================
console.log('\n§3.3 unknown names, stale events, and batch caps');
// =============================================================================================
{
  const clock = fakeClock();
  const { service, sink, logger } = harness({ clock });

  const res = await service.ingest({
    body: batch([
      ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock),
      ev('weapon.fired', { weapon: 'ar' }, clock),                        // never registered
      ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock, { version: 7 }),  // future version
    ]),
    actor: null, correlationId: ulid(),
  });
  assert('an unknown event name is rejected without failing the batch',
    res.accepted === 1 && res.rejected === 2
    && res.rejections.every((r) => r.reason === 'unknown_event'), JSON.stringify(res.rejections));
  assert('the unknown name never reaches the sink',
    !sink.records.some((r) => r.name === 'weapon.fired'));
  assert('rejections are counted in the log for whoever owns the client',
    logger.lines.some((l) => l.event === 'telemetry.rejected'));

  // §3.3: max event age 30 minutes. Older is dropped, never backdated to now.
  const stale = { ...ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock) };
  clock.advance(31 * 60 * 1000);
  const staleRes = await service.ingest({ body: batch([stale]), actor: null, correlationId: ulid() });
  assert('an event older than 30 minutes is dropped, not backdated',
    staleRes.rejections[0].reason === 'too_old', JSON.stringify(staleRes.rejections));
  // CONTROL: the same event 29 minutes old is accepted.
  const fresh = ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock);
  clock.advance(29 * 60 * 1000);
  const freshRes = await service.ingest({ body: batch([fresh]), actor: null, correlationId: ulid() });
  assert('CONTROL: a 29-minute-old event is still accepted', freshRes.accepted === 1,
    JSON.stringify(freshRes.rejections));

  await refuses('a batch over the 50-event cap is refused',
    () => service.ingest({
      body: batch(Array.from({ length: LIMITS.maxEvents + 1 },
        () => ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock))),
      actor: null, correlationId: ulid(),
    }),
    'PAYLOAD_TOO_LARGE');

  await refuses('a batch over the 64 KB cap is refused',
    () => service.ingest({
      body: batch([ev('client.error', { errorClass: 'other', fatal: false, pad: 'x'.repeat(70000) }, clock)]),
      actor: null, correlationId: ulid(),
    }),
    'PAYLOAD_TOO_LARGE');

  await refuses('an unknown schemaVersion is refused',
    () => service.ingest({ body: { schemaVersion: 99, events: [] }, actor: null, correlationId: ulid() }),
    'VALIDATION_FAILED');

  await refuses('an empty batch is refused',
    () => service.ingest({ body: batch([]), actor: null, correlationId: ulid() }),
    'VALIDATION_FAILED');
}

// =============================================================================================
console.log('\n§3.3.1 the field checks, and §3.3 the timestamp checks');
// =============================================================================================
// A mutation sweep deleted each of these guards in turn and this suite stayed green every
// time — the payload section above covers bounds, enums, missing keys and the invariant, and
// nothing covered nullability, primitive type, integrality, or an unparseable timestamp. Each
// case below was watched to fail with its guard removed.
{
  const clock = fakeClock();
  const { service, sink } = harness({ clock });

  // validate.js:41 — `null` in a field that is not declared nullable. Deleting the guard
  // stores `errorClass: null`, which is a row in the warehouse that answers no question and
  // silently widens every closed enum to "or nothing".
  const nulled = await service.ingest({
    body: batch([ev('client.error', { errorClass: null, fatal: false }, clock)]),
    actor: null, correlationId: ulid(),
  });
  assert('a null in a non-nullable field is rejected',
    nulled.accepted === 0 && nulled.rejections[0].reason === 'field_null:errorClass',
    JSON.stringify(nulled.rejections));
  assert('the null never reaches the sink',
    !sink.records.some((r) => r.name === 'client.error'),
    JSON.stringify(sink.records.map((r) => r.name)));

  // validate.js:48 — a bool field that is not a boolean. `'yes'` and `1` are both truthy, and
  // a truthiness test downstream would read them as `true` while a strict one reads them as
  // neither: the same stored row means two different things to two consumers.
  const bools = await service.ingest({
    body: batch([
      ev('client.error', { errorClass: 'other', fatal: 'yes' }, clock),
      ev('client.error', { errorClass: 'other', fatal: 1 }, clock),
      ev('client.webgl_context_lost', { recovered: 'true', uptimeSec: 10 }, clock),
    ]),
    actor: null, correlationId: ulid(),
  });
  assert('a string, a number and the word "true" are all refused where a boolean belongs',
    bools.accepted === 0 && bools.rejections.length === 3
    && bools.rejections.every((r) => /^field_type:(fatal|recovered)$/.test(r.reason)),
    JSON.stringify(bools.rejections));

  // validate.js:56 — a number field that is not a finite number. `'60' > 1000` is false and
  // `NaN > 1000` is false, so the bounds check below waves both straight through: without the
  // type guard the range guard is not a second line of defence, it is no defence at all.
  const numbers = await service.ingest({
    body: batch([
      ev('client.fps', { p50: '60', p01: 30, windowSec: 60 }, clock),
      ev('client.fps', { p50: NaN, p01: 30, windowSec: 60 }, clock),
      ev('client.fps', { p50: Infinity, p01: 30, windowSec: 60 }, clock),
      ev('client.heap', { usedMb: null, sampledAtSec: 5 }, clock),
    ]),
    actor: null, correlationId: ulid(),
  });
  assert('a numeric string, NaN and Infinity are all refused where a number belongs',
    numbers.accepted === 0
    && numbers.rejections.filter((r) => r.reason === 'field_type:p50').length === 3,
    JSON.stringify(numbers.rejections));
  assert('a null in a numeric field is refused as a null, before the type check',
    numbers.rejections.some((r) => r.reason === 'field_null:usedMb'),
    JSON.stringify(numbers.rejections));
  assert('no fps row reached the sink carrying a non-number',
    !sink.records.some((r) => r.name === 'client.fps'),
    JSON.stringify(sink.records.map((r) => r.name)));

  // validate.js:57 — a fractional value in a field declared `integer`. A browser major of
  // 120.5 is a sender bug, and storing it produces a version nobody shipped.
  const fractional = await service.ingest({
    body: batch([ev('client.unsupported',
      { reason: 'webgl2', browser: 'chrome', browserMajor: 120.5, os: 'macos' }, clock)]),
    actor: null, correlationId: ulid(),
  });
  assert('a fractional value in an integer field is rejected',
    fractional.accepted === 0
    && fractional.rejections[0].reason === 'field_not_integer:browserMajor',
    JSON.stringify(fractional.rejections));

  // CONTROLS. Every rejection above must be about the VALUE, not about the field being
  // unusable — so the same events with correct values are accepted and stored.
  const { service: sOk, sink: sinkOk } = harness({ clock });
  const good = await sOk.ingest({
    body: batch([
      ev('client.error', { errorClass: 'other', fatal: false }, clock),
      ev('client.webgl_context_lost', { recovered: true, uptimeSec: 10 }, clock),
      ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock),
      ev('client.heap', { usedMb: 512, sampledAtSec: 5 }, clock),
      ev('client.unsupported',
        { reason: 'webgl2', browser: 'chrome', browserMajor: 120, os: 'macos' }, clock),
    ]),
    actor: null, correlationId: ulid(),
  });
  assert('CONTROL: the same five events with well-typed values are all accepted',
    good.accepted === 5 && good.rejections.length === 0, JSON.stringify(good.rejections));
  assert('CONTROL: `false` and `0` survive — the type check is not a truthiness check',
    sinkOk.records.find((r) => r.name === 'client.error').payload.fatal === false,
    JSON.stringify(sinkOk.records.map((r) => r.payload)));

  // CONTROL for nullability: a field the registry DOES declare nullable takes a null. Without
  // this, "a null is rejected" would also pass for a validator that banned null everywhere.
  const { service: sNull, sink: sinkNull, consent: cNull } = harness({ clock });
  const receipt = cNull.issue({ subject: 'account', subjectId: 'A1', telemetryPersonal: true, policyVersion: 1 });
  const nullable = await sNull.ingest({
    body: batch([ev('flow.step', { step: 'verify', outcome: 'completed', errorCode: null }, clock)],
      { consentReceipt: receipt, clientSessionId: ulid() }),
    actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('CONTROL: a null in a field the registry declares nullable is accepted and stored',
    nullable.accepted === 1
    && sinkNull.records.find((r) => r.name === 'flow.step').payload.errorCode === null,
    JSON.stringify(nullable.rejections));

  // validate.js:212 — an `occurredAt` that is a string but not a date. Deleting this guard is
  // not a quiet acceptance: `checkFreshness` returns null, the service then calls
  // `new Date(NaN).toISOString()` and THROWS, so one malformed timestamp takes down the whole
  // batch — the exact opposite of §3.3's "one bad event must not cost the other forty-nine".
  const { service: sTime, sink: sinkTime } = harness({ clock });
  const invalidTime = await sTime.ingest({
    body: batch([
      ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock, { occurredAt: 'not-a-date' }),
      ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock, { occurredAt: '2026-13-45T99:99:99Z' }),
      ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock),
    ]),
    actor: null, correlationId: ulid(),
  });
  assert('an unparseable occurredAt is rejected as occurred_at_invalid',
    invalidTime.rejections.length === 2
    && invalidTime.rejections.every((r) => r.reason === 'occurred_at_invalid'),
    JSON.stringify(invalidTime.rejections));
  assert('and the batch still succeeds — the sibling event lands',
    invalidTime.accepted === 1 && sinkTime.records.length === 1,
    `accepted=${invalidTime.accepted} stored=${sinkTime.records.length}`);
  assert('nothing was stored with an Invalid Date',
    sinkTime.records.every((r) => !Number.isNaN(Date.parse(r.occurredAt))),
    JSON.stringify(sinkTime.records.map((r) => r.occurredAt)));

  // An occurredAt that is not a string at all is a different reason, and the epoch number a
  // client might send must not be read as a date.
  const notString = await sTime.ingest({
    body: batch([ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock,
      { occurredAt: clock.now() })]),
    actor: null, correlationId: ulid(),
  });
  assert('a numeric epoch where an ISO string belongs is occurred_at_missing',
    notString.rejections[0].reason === 'occurred_at_missing', JSON.stringify(notString.rejections));

  // validate.js:214 — the future skew bound. A client with a wrong clock, or one deliberately
  // post-dating, otherwise writes events that a retention sweep will not reach for as long as
  // it likes and that sort ahead of everything real.
  const { service: sFuture, sink: sinkFuture } = harness({ clock });
  const future = await sFuture.ingest({
    body: batch([
      ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock,
        { occurredAt: new Date(clock.now() + LIMITS.maxFutureSkewMs + 1000).toISOString() }),
      ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock,
        { occurredAt: new Date(clock.now() + 365 * 24 * 3600 * 1000).toISOString() }),
    ]),
    actor: null, correlationId: ulid(),
  });
  assert('an event dated past the skew allowance is dropped as occurred_in_future',
    future.accepted === 0 && future.rejections.length === 2
    && future.rejections.every((r) => r.reason === 'occurred_in_future'),
    JSON.stringify(future.rejections));
  assert('the future-dated event never reaches the sink', sinkFuture.records.length === 0,
    JSON.stringify(sinkFuture.records.map((r) => r.occurredAt)));

  // CONTROL: modest clock skew is TOLERATED. Rejecting everything ahead of the server clock
  // would drop honest traffic, so the bound is a bound and not a ban.
  const withinSkew = await sFuture.ingest({
    body: batch([ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock,
      { occurredAt: new Date(clock.now() + LIMITS.maxFutureSkewMs - 1000).toISOString() })]),
    actor: null, correlationId: ulid(),
  });
  assert('CONTROL: an event inside the two-minute skew allowance is accepted',
    withinSkew.accepted === 1, JSON.stringify(withinSkew.rejections));
}

// =============================================================================================
console.log('\n§3.5 nothing identifying is carried');
// =============================================================================================
{
  const clock = fakeClock();
  const { service, sink, consent } = harness({ clock });
  const receipt = consent.issue({ subject: 'account', subjectId: 'A1', telemetryPersonal: true, policyVersion: 1 });
  await service.ingest({
    body: batch([
      ev('lobby.abandoned', { lastState: 'in-lobby', dwellSec: 44, opponentName: 'Ghost', ip: '203.0.113.9' }, clock),
      ev('client.net_health', { rttMs: 40, jitterMs: 5, lossPct: 0.2, correctionRatePerSec: 1, snapshotAgeMs: 60 }, clock),
    ], { consentReceipt: receipt, clientSessionId: ulid() }),
    actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  const blob = JSON.stringify(sink.records);
  assert('another player\'s display name is not stored', !blob.includes('Ghost'), blob);
  assert('an IP address smuggled into a payload is not stored', !blob.includes('203.0.113.9'));
  assert('the accepted events themselves did land',
    sink.records.length === 2, String(sink.records.length));
}

// =============================================================================================
console.log('\n§3.4 a receipt expires, and it expires against the policy it was given for');
// =============================================================================================
{
  const clock = fakeClock();
  const { service, sink } = harness({ clock });

  // A correctly SIGNED receipt whose expiry cannot be read. `Date.parse` gives NaN and every
  // comparison with NaN is false, so the bare `<= now` check made this receipt immortal.
  const forge = (claims) => {
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const mac = createHmac('sha256', SECRET).update(body).digest('base64url');
    return `${body}.${mac}`;
  };
  const baseClaims = {
    subject: 'account', subjectId: 'A1', telemetryPersonal: true, policyVersion: 1,
    decidedAt: new Date(clock.now()).toISOString(),
  };
  const personal = () => batch([ev('flow.step', { step: 'signup', outcome: 'completed', errorCode: null }, clock)]);

  for (const expiresAt of ['soon', '', null, undefined, 'never', {}]) {
    const res = await service.ingest({
      body: { ...personal(), consentReceipt: forge({ ...baseClaims, expiresAt }) },
      actor: { accountId: 'A1' }, correlationId: ulid(),
    });
    assert(`an expiry of ${JSON.stringify(expiresAt)} is not consent`,
      res.accepted === 0 && res.rejections[0]?.reason === 'receipt_expiry_invalid',
      JSON.stringify(res.rejections));
  }
  assert('no event slipped through on an unreadable expiry', sink.records.length === 0,
    JSON.stringify(sink.records.map((r) => r.name)));

  // CONTROL: the same forged receipt with a readable, future expiry is accepted — so the
  // rejections above are about the expiry and not about the forging.
  const good = await service.ingest({
    body: {
      ...personal(),
      consentReceipt: forge({ ...baseClaims, expiresAt: new Date(clock.now() + 3600e3).toISOString() }),
    },
    actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('CONTROL: a readable future expiry is accepted', good.accepted === 1, JSON.stringify(good.rejections));

  // The policy version the subject actually agreed to. Consent to policy 1 is not consent to 2.
  const clock2 = fakeClock();
  const { service: s2, consent: c2 } = harness({ clock: clock2 });
  const oldPolicy = c2.issue({ subject: 'account', subjectId: 'A1', telemetryPersonal: true, policyVersion: 0 });
  const stale = await s2.ingest({
    body: { ...personal(), consentReceipt: oldPolicy }, actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('a receipt for a different policy version is not consent',
    stale.accepted === 0 && stale.rejections[0]?.reason === 'receipt_policy_stale',
    JSON.stringify(stale.rejections));

  // CONTROL 1: the same receipt against a verifier configured for that policy is accepted.
  const c0 = createConsentReceipts({ secret: SECRET, clock: clock2, policyVersion: 0 });
  assert('CONTROL: the same receipt verifies under the policy it was issued for',
    c0.verify(oldPolicy, { accountId: 'A1' }).ok === true,
    JSON.stringify(c0.verify(oldPolicy, { accountId: 'A1' })));
  // CONTROL 2: a receipt for the CURRENT policy is accepted by the current verifier.
  const current = c2.issue({ subject: 'account', subjectId: 'A1', telemetryPersonal: true, policyVersion: 1 });
  const fresh = await s2.ingest({
    body: { ...personal(), consentReceipt: current }, actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('CONTROL: a receipt for the current policy is accepted', fresh.accepted === 1,
    JSON.stringify(fresh.rejections));
}

// =============================================================================================
console.log('\n§3.5.1 pre-consent is classified by (name, version), like everything else');
// =============================================================================================
{
  const clock = fakeClock();
  const { service, sink, consent } = harness({ clock });
  const sessionId = ulid();
  const receipt = consent.issue({
    subject: 'client-session', subjectId: sessionId, telemetryPersonal: true, policyVersion: 1,
  });

  // A version this server never registered. Classifying pre-consent by NAME alone let this
  // event impose the §3.5.1 rules on a batch it is not part of — the whole batch lost its
  // clientSessionId, or was refused outright for "mixing".
  const res = await service.ingest({
    body: batch([
      ev('funnel.preconsent', { step: 'landing', outcome: 'viewed' }, clock,
        { version: 99, correlationId: ulid() }),
      ev('lobby.abandoned', { lastState: 'in-lobby', dwellSec: 30 }, clock),
    ], { clientSessionId: sessionId, consentReceipt: receipt }),
    actor: null, correlationId: ulid(),
  });
  assert('an unregistered funnel.preconsent version is just an unknown event',
    res.accepted === 1 && res.rejections.length === 1 && res.rejections[0].reason === 'unknown_event',
    JSON.stringify(res.rejections));
  const stored = sink.records.find((r) => r.name === 'lobby.abandoned');
  assert('the batch keeps its clientSessionId — a bogus version cannot strip it',
    stored?.clientSessionId === sessionId, String(stored?.clientSessionId));

  // CONTROL: the REGISTERED version of the same event still imposes every §3.5.1 rule.
  await refuses('CONTROL: a real funnel.preconsent in that batch is still refused for mixing',
    () => service.ingest({
      body: batch([
        ev('funnel.preconsent', { step: 'landing', outcome: 'viewed' }, clock, { correlationId: ulid() }),
        ev('lobby.abandoned', { lastState: 'in-lobby', dwellSec: 30 }, clock),
      ], { clientSessionId: ulid() }),
      actor: null, correlationId: ulid(),
    }),
    'preconsent_batch_mixing');
}

// =============================================================================================
console.log('\n§3.4 the receipt is bound to ONE subject and ONE subject class');
// =============================================================================================
//
// WHERE THIS RUNS, AND WHERE IT DOES NOT. `app.js` replaces this module's verifier with
// `adaptAuthConsent(deps.auth.receipts, config)` whenever the auth module is present — which in
// production is always, since `REQUIRED_MODULES` includes auth and a process missing it refuses
// to boot. `createConsentReceipts` is what a process composed WITHOUT auth deploys, and what the
// service is built on when it is composed alone. The binding rules therefore have two
// implementations and both need asserting; neither of these places is redundant:
//
//   - HERE, against this module's verifier, driven through the REAL `createTelemetryService`.
//   - In apptest.mjs §3b and §3d, over a real socket against the assembled app, which is the
//     ONLY place the deployed adapter's copy of these rules can be observed at all.
//
// That distinction is not pedantry. A decline test lived in this file for months while the
// deployed gate — a different function, in app.js — accepted personal telemetry from players
// who had said no, because nothing exercised the code the request actually reached.
//
// Every check below states the EXACT refusal reason. `rejections.every(...)` on its own is
// vacuously true of an empty array, so a gate that stopped refusing entirely would satisfy it:
// the accepted/rejected counts are asserted alongside for that reason.
{
  const clock = fakeClock();
  const { service, consent } = harness({ clock });
  // flow.step is personal-class: the class the receipt gates. Nothing else in the batch, so
  // one refusal is one dropped event and the counts are unambiguous.
  const personal = (extra = {}) => batch(
    [ev('flow.step', { step: 'signup', outcome: 'completed', errorCode: null }, clock)], extra,
  );
  const grant = (subject, subjectId) =>
    consent.issue({ subject, subjectId, telemetryPersonal: true, policyVersion: 1 });

  const S1 = ulid();
  const S2 = ulid();

  // ── the authenticated branch: subject class `account`, id = the bearer's account ────────
  const otherAccount = await service.ingest({
    body: personal({ consentReceipt: grant('account', 'A2') }),
    actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert("another account's receipt does not authorise this account's personal event",
    otherAccount.accepted === 0 && otherAccount.rejected === 1
    && otherAccount.rejections[0].reason === 'receipt_subject_mismatch',
    JSON.stringify(otherAccount.rejections));

  // The CLASS check on its own. Same id on both sides — only `subject` differs — so the id
  // comparison beside it cannot be what refuses this.
  const sessionShaped = await service.ingest({
    body: personal({ consentReceipt: grant('client-session', 'A1') }),
    actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('a CLIENT-SESSION receipt naming the account id does not authorise an authenticated batch',
    sessionShaped.accepted === 0 && sessionShaped.rejected === 1
    && sessionShaped.rejections[0].reason === 'receipt_subject_mismatch',
    JSON.stringify(sessionShaped.rejections));

  // ── the signed-out branch: subject class `client-session`, id = the batch's session ─────
  const crossSession = await service.ingest({
    body: personal({ clientSessionId: S1, consentReceipt: grant('client-session', S2) }),
    actor: null, correlationId: ulid(),
  });
  assert("session B's receipt does not authorise session A — a receipt is not a bearer token",
    crossSession.accepted === 0 && crossSession.rejected === 1
    && crossSession.rejections[0].reason === 'receipt_subject_mismatch',
    JSON.stringify(crossSession.rejections));

  const accountShaped = await service.ingest({
    body: personal({ clientSessionId: S1, consentReceipt: grant('account', S1) }),
    actor: null, correlationId: ulid(),
  });
  assert('an ACCOUNT receipt naming that same id does not authorise a signed-out batch',
    accountShaped.accepted === 0 && accountShaped.rejected === 1
    && accountShaped.rejections[0].reason === 'receipt_subject_mismatch',
    JSON.stringify(accountShaped.rejections));

  // ── neither: there is nothing to bind to, so the receipt proves nothing about this sender ──
  const unbound = await service.ingest({
    body: personal({ consentReceipt: grant('client-session', S1) }),
    actor: null, correlationId: ulid(),
  });
  assert('a personal batch with no account and no client session is refused as UNBOUND',
    unbound.accepted === 0 && unbound.rejected === 1
    && unbound.rejections[0].reason === 'receipt_unbound',
    JSON.stringify(unbound.rejections));
  assert('and the 202 names that specific fault so the client can act on it',
    unbound.consentReceiptError?.code === 'CONSENT_RECEIPT_INVALID'
    && unbound.consentReceiptError?.reason === 'receipt_unbound',
    JSON.stringify(unbound.consentReceiptError));

  // CONTROLS: each of those same receipts IS accepted by the subject it was issued to, so the
  // five refusals above are the binding rule and not a gate that refuses everything.
  const asAccount = await service.ingest({
    body: personal({ consentReceipt: grant('account', 'A1') }),
    actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('CONTROL: the account receipt authorises the account it names',
    asAccount.accepted === 1 && asAccount.rejected === 0 && asAccount.consentReceiptError === null,
    JSON.stringify(asAccount.rejections));

  const asSession = await service.ingest({
    body: personal({ clientSessionId: S1, consentReceipt: grant('client-session', S1) }),
    actor: null, correlationId: ulid(),
  });
  assert('CONTROL: the client-session receipt authorises the session it names',
    asSession.accepted === 1 && asSession.rejected === 0,
    JSON.stringify(asSession.rejections));
}

// =============================================================================================
console.log('\n§3.4 a receipt that is not a receipt, and the key that signs one');
// =============================================================================================
{
  const clock = fakeClock();
  const { service } = harness({ clock });
  const personal = (extra = {}) => batch(
    [ev('flow.step', { step: 'signup', outcome: 'completed', errorCode: null }, clock)], extra,
  );

  // A receipt is `body.signature`. Without the separator there is no signature to check, and
  // reporting it as a bad signature would send a client off to look for a key problem it does
  // not have — `lastIndexOf('.')` on a string with no dot returns -1, which silently splits the
  // token one character from its end and compares that to a MAC.
  const noSeparator = await service.ingest({
    body: personal({ consentReceipt: 'this-token-has-no-separator-at-all' }),
    actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('a receipt with no body/signature separator is MALFORMED, not badly signed',
    noSeparator.accepted === 0 && noSeparator.rejected === 1
    && noSeparator.rejections[0].reason === 'receipt_malformed'
    && noSeparator.consentReceiptError?.reason === 'receipt_malformed',
    JSON.stringify({ r: noSeparator.rejections, e: noSeparator.consentReceiptError }));

  // CONTROL: the same rubbish WITH a separator is a different, more specific refusal — so the
  // reason above distinguishes the two cases rather than being the module's only word for bad.
  const separated = await service.ingest({
    body: personal({ consentReceipt: 'this-token.has-a-separator' }),
    actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('CONTROL: a separated but unsigned token fails on the SIGNATURE instead',
    separated.accepted === 0 && separated.rejections[0].reason === 'receipt_signature_invalid',
    JSON.stringify(separated.rejections));

  // The signing key. A receipt is worth exactly what its key is worth, so a key short enough to
  // be guessed is refused at construction rather than at the first forged batch.
  const build = (secret) => {
    try { createConsentReceipts({ secret }); return null; }
    catch (err) { return err.message; }
  };
  assert('a 15-character secret is refused, by name',
    (build('x'.repeat(15)) ?? '').includes('at least 16 characters'), String(build('x'.repeat(15))));
  assert('a missing secret is refused the same way',
    (build(undefined) ?? '').includes('at least 16 characters'), String(build(undefined)));
  assert('CONTROL: 16 characters is enough — the refusal is the length, not the call',
    build('x'.repeat(16)) === null, String(build('x'.repeat(16))));
}

// =============================================================================================
console.log('\n§3.5.1 the pre-consent correlation memory is bounded, and a replay cannot flush it');
// =============================================================================================
{
  const ids = [ulid(), ulid(), ulid()];
  const seen = createCorrelationSeen({ capacity: 3 });
  for (const id of ids) seen.add(id);
  assert('CONTROL: everything inside the capacity is remembered',
    seen.size() === 3 && ids.every((i) => seen.has(i)), String(seen.size()));

  const extra = ulid();
  seen.add(extra);
  assert('at capacity the OLDEST id is evicted and the newest kept — the set does not grow forever',
    seen.size() === 3 && !seen.has(ids[0]) && seen.has(ids[1]) && seen.has(ids[2]) && seen.has(extra),
    JSON.stringify({ size: seen.size(), oldest: seen.has(ids[0]), newest: seen.has(extra) }));

  // A repeat must not be QUEUED twice. If it is, the second copy of the id in the eviction
  // queue evicts the id itself — and "never reused" (§3.5.1) stops holding for precisely the
  // correlation id that was replayed, which is the one an attacker replays.
  const replayed = createCorrelationSeen({ capacity: 3 });
  const [a, b, c] = [ulid(), ulid(), ulid()];
  replayed.add(a);
  replayed.add(a);
  replayed.add(b);
  replayed.add(c);
  assert('re-adding a known id does not queue it again, so it cannot evict itself',
    replayed.size() === 3 && replayed.has(a) && replayed.has(b) && replayed.has(c),
    JSON.stringify({ size: replayed.size(), a: replayed.has(a), b: replayed.has(b), c: replayed.has(c) }));
}

// =============================================================================================
console.log('\n§3.3 a client that supplies a server-owned field is discarded AND reported');
// =============================================================================================
{
  const clock = fakeClock();
  const { service, logger } = harness({ clock });
  await service.ingest({
    body: batch([ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock)],
      { accountId: 'A-FORGED', geo: 'NZ' }),
    actor: null, correlationId: 'CORR-FORGED-1',
  });
  const warned = logger.lines.filter((l) => l.event === 'telemetry.client_supplied_server_field');
  assert('one warning, naming every forbidden field the body carried and the request it came on',
    warned.length === 1 && warned[0].level === 'warn'
    && warned[0].fields.join(',') === 'accountId,geo'
    && warned[0].correlationId === 'CORR-FORGED-1',
    JSON.stringify(warned));

  // CONTROL: a batch claiming nothing produces no such line, so the assertion above is about
  // the forgery and not about the handler logging on every request.
  const clean = harness({ clock });
  await clean.service.ingest({
    body: batch([ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock)]),
    actor: null, correlationId: ulid(),
  });
  assert('CONTROL: a batch that claims nothing is not reported',
    clean.logger.lines.every((l) => l.event !== 'telemetry.client_supplied_server_field'),
    JSON.stringify(clean.logger.lines.map((l) => l.event)));
}

// =============================================================================================
console.log('\n§3.3 an event that is not an object, and a payload that is not a payload');
// =============================================================================================
{
  const clock = fakeClock();
  const { service, sink } = harness({ clock });

  const res = await service.ingest({
    body: batch([
      null,
      ['client.fps', 60],
      'client.fps',
      ev('client.asset_build', { ms: 1200 }, clock),
    ]),
    actor: null, correlationId: ulid(),
  });
  assert('each non-object event is rejected as such, by index, and the real event still lands',
    res.accepted === 1 && res.rejected === 3
    && res.rejections.map((r) => `${r.index}:${r.name}:${r.reason}`).join(' ')
       === '0:null:event_not_object 1:null:event_not_object 2:null:event_not_object',
    JSON.stringify(res.rejections));
  assert('CONTROL: the one well-formed event in that batch reached the warehouse',
    sink.records.length === 1 && sink.records[0].name === 'client.asset_build',
    JSON.stringify(sink.records.map((r) => r.name)));

  // A well-formed EVENT whose payload is not an object. Rejected on the payload's shape —
  // reporting it as a missing field would name a field the sender never had a chance to send.
  const shapes = await service.ingest({
    body: batch([
      ev('client.fps', ['p50', 60], clock),
      ev('client.heap', 'usedMb=12', clock),
      ev('client.asset_build', { ms: 1200 }, clock),
    ]),
    actor: null, correlationId: ulid(),
  });
  assert('an array and a string payload are both rejected on SHAPE, not as missing fields',
    shapes.accepted === 1 && shapes.rejected === 2
    && shapes.rejections.every((r) => r.reason === 'payload_not_object'),
    JSON.stringify(shapes.rejections));
}

// =============================================================================================
console.log('\nthe 202 reports a receipt fault only when a receipt actually cost an event');
// =============================================================================================
{
  const clock = fakeClock();
  const { service, consent } = harness({ clock });
  const personalEvent = () => ev('flow.step', { step: 'signup', outcome: 'completed', errorCode: null }, clock);
  const internalEvent = () => ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock);

  // An internal-only batch legitimately carries no receipt (§3.3). Nothing was dropped for the
  // absent receipt, so telling this sender its receipt is invalid would route a pre-consent
  // visitor to a consent screen it is already looking at.
  const internalOnly = await service.ingest({
    body: batch([internalEvent()]), actor: null, correlationId: ulid(),
  });
  assert('an internal-only batch with no receipt reports NO receipt fault',
    internalOnly.accepted === 1 && internalOnly.consentReceiptError === null,
    JSON.stringify(internalOnly.consentReceiptError));

  // CONTROL: the same absent receipt, on a batch where it DID cost an event, is reported.
  const personalNoReceipt = await service.ingest({
    body: batch([personalEvent()]), actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('CONTROL: an absent receipt that dropped a personal event IS reported, typed',
    personalNoReceipt.accepted === 0
    && personalNoReceipt.consentReceiptError?.code === 'CONSENT_RECEIPT_INVALID'
    && personalNoReceipt.consentReceiptError?.reason === 'receipt_absent',
    JSON.stringify(personalNoReceipt.consentReceiptError));

  // A valid receipt recording a DECLINE is the system working, not a broken receipt. Reporting
  // it as one asks the player the question they already answered.
  const declined = await service.ingest({
    body: batch([personalEvent()], {
      consentReceipt: consent.issue({
        subject: 'account', subjectId: 'A1', telemetryPersonal: false, policyVersion: 1,
      }),
    }),
    actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('a DECLINE drops the personal event and reports NO receipt fault',
    declined.accepted === 0 && declined.rejected === 1
    && declined.rejections[0].reason === 'consent_declined'
    && declined.consentReceiptError === null,
    JSON.stringify({ r: declined.rejections, e: declined.consentReceiptError }));

  // CONTROL: a working receipt reports null too, so `null` is not simply what this field always
  // says — the three cases above and this one are told apart by it.
  const accepted = await service.ingest({
    body: batch([personalEvent()], {
      consentReceipt: consent.issue({
        subject: 'account', subjectId: 'A1', telemetryPersonal: true, policyVersion: 1,
      }),
    }),
    actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('CONTROL: an accepted personal event reports no fault either',
    accepted.accepted === 1 && accepted.consentReceiptError === null,
    JSON.stringify(accepted.consentReceiptError));
}

// =============================================================================================
console.log('\n§3.3 batch shape — each refusal names its own problem');
// =============================================================================================
//
// Every check here asserts the SPECIFIC refusal, never merely "it was refused". These rules sit
// in one function and throw the same `VALIDATION_FAILED` code, so a test that only counted
// refusals would be satisfied by whichever guard happened to survive a refactor — and would say
// nothing at all about the other five.
{
  const clock = fakeClock();
  const { service } = harness({ clock });
  const good = () => [ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock)];

  for (const body of [[], 'schemaVersion=1', 42]) {
    await refuses(`a body that is ${JSON.stringify(body)} is refused as a body, not as a version`,
      () => service.ingest({ body, actor: null, correlationId: ulid() }),
      'Body must be an object');
  }

  await refuses('a batch declaring a schema version this server does not speak is refused by version',
    () => service.ingest({
      body: { schemaVersion: 2, events: good() }, actor: null, correlationId: ulid(),
    }),
    'Unsupported telemetry schema version');
  await refuses('and the refusal states the version the server DOES speak',
    () => service.ingest({
      body: { schemaVersion: 2, events: good() }, actor: null, correlationId: ulid(),
    }),
    '"expected":1');
  await refuses('a batch with no schemaVersion at all is refused the same way',
    () => service.ingest({ body: { events: good() }, actor: null, correlationId: ulid() }),
    'Unsupported telemetry schema version');
  await refuses('the version is a number — the string "1" is not version 1',
    () => service.ingest({
      body: { schemaVersion: '1', events: good() }, actor: null, correlationId: ulid(),
    }),
    'Unsupported telemetry schema version');

  // §3.5: clientSessionId is a ULID. A free-form string here is a client inventing its own
  // identifier scheme, and an identifier nobody minted is one nothing can expire.
  await refuses('a clientSessionId that is not a ULID is refused, by that name',
    () => service.ingest({
      body: batch([ev('flow.step', { step: 'signup', outcome: 'completed', errorCode: null }, clock)],
        { clientSessionId: 'session-7' }),
      actor: null, correlationId: ulid(),
    }),
    'clientSessionId must be a ULID');

  // CONTROL: the same batch with a real ULID gets past the shape check — the refusal above is
  // about the shape of the id and not about the field being present.
  const sid = ulid();
  const shaped = await service.ingest({
    body: batch([ev('flow.step', { step: 'signup', outcome: 'completed', errorCode: null }, clock)],
      { clientSessionId: sid }),
    actor: null, correlationId: ulid(),
  });
  assert('CONTROL: a ULID clientSessionId passes the shape check and reaches the consent gate',
    shaped.rejected === 1 && shaped.rejections[0].reason === 'receipt_absent',
    JSON.stringify(shaped.rejections));

  // §3.5: an internal-only batch carries no receipt. A receipt is an identifier, and one with
  // no purpose on this batch is linkage the class exists to prevent.
  await refuses('an internal-only batch carrying a consent receipt is refused by that rule',
    () => service.ingest({
      body: batch(good(), {
        consentReceipt: harness({ clock }).consent.issue({
          subject: 'account', subjectId: 'A1', telemetryPersonal: true, policyVersion: 1,
        }),
      }),
      actor: null, correlationId: ulid(),
    }),
    'internal_only_receipt');

  // CONTROL: the SAME receipt on a batch that contains a personal event is not refused — the
  // rule is about the receipt having nothing to authorise, not about receipts.
  const withPersonal = harness({ clock });
  const okReceipt = withPersonal.consent.issue({
    subject: 'account', subjectId: 'A1', telemetryPersonal: true, policyVersion: 1,
  });
  const mixed = await withPersonal.service.ingest({
    body: batch([
      ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock),
      ev('flow.step', { step: 'signup', outcome: 'completed', errorCode: null }, clock),
    ], { consentReceipt: okReceipt }),
    actor: { accountId: 'A1' }, correlationId: ulid(),
  });
  assert('CONTROL: a receipt beside a personal event is accepted, not refused as purposeless',
    mixed.accepted === 2 && mixed.rejected === 0, JSON.stringify(mixed.rejections));
}

// =============================================================================================
console.log('\n§3.5.1 a pre-consent correlation id is a FRESH ULID, and rubbish in the batch cannot hide one');
// =============================================================================================
{
  const clock = fakeClock();
  const { service, sink } = harness({ clock });

  for (const correlationId of ['corr-1', '', undefined, 12345]) {
    await refuses(`a funnel.preconsent correlationId of ${JSON.stringify(correlationId)} is refused on SHAPE`,
      () => service.ingest({
        body: batch([ev('funnel.preconsent', { step: 'landing', outcome: 'viewed' }, clock, { correlationId })]),
        actor: null, correlationId: ulid(),
      }),
      'preconsent_correlation_shape');
  }

  // CONTROL: a fresh ULID on the same event is accepted and stored with no join key, so the
  // refusals above are about the id's shape and not about the event.
  const fresh = ulid();
  const accepted = await service.ingest({
    body: batch([ev('funnel.preconsent', { step: 'landing', outcome: 'viewed' }, clock, { correlationId: fresh })]),
    actor: null, correlationId: ulid(),
  });
  const stored = sink.records.find((r) => r.name === 'funnel.preconsent');
  assert('CONTROL: a fresh ULID correlationId is accepted and stored unlinked',
    accepted.accepted === 1 && stored?.correlationId === fresh
    && stored?.accountId === null && stored?.clientSessionId === null && stored?.unlinked === true,
    JSON.stringify(stored));

  // The §3.5.1 classification pass walks the raw events. A non-object among them is skipped
  // there and rejected later by the service — it must not derail the classification, and it
  // must not let a real funnel.preconsent slip past the rules by travelling next to it.
  await refuses('a null event beside a funnel.preconsent does not exempt the batch from §3.5.1',
    () => service.ingest({
      body: batch([null, ev('funnel.preconsent', { step: 'consent', outcome: 'viewed' }, clock,
        { correlationId: ulid() })], { clientSessionId: ulid() }),
      actor: null, correlationId: ulid(),
    }),
    'preconsent_client_session');

  const withJunk = await service.ingest({
    body: batch([null, ev('funnel.preconsent', { step: 'consent', outcome: 'viewed' }, clock,
      { correlationId: ulid() })]),
    actor: null, correlationId: ulid(),
  });
  assert('and a clean pre-consent event beside that null is still accepted, unlinked',
    withJunk.accepted === 1 && withJunk.rejected === 1
    && withJunk.rejections[0].reason === 'event_not_object',
    JSON.stringify(withJunk.rejections));
}

console.log(failures ? `\n${failures} FAILED` : '\nclient telemetry runs clean');
process.exit(failures ? 1 : 0);
