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
  const { service, sink } = harness();
  const clock = fakeClock();

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

  // Signed in as someone else entirely, still claiming a third identity.
  const authed = await service.ingest({
    body: batch([ev('client.fps', { p50: 60, p01: 30, windowSec: 60 }, clock)],
      { accountId: 'ACCOUNT-I-WISH-I-WAS' }),
    actor: { accountId: 'REAL-ACCOUNT-01' },
    correlationId: ulid(),
  });
  assert('the accountId comes from the bearer token', authed.accountId === 'REAL-ACCOUNT-01');
  assert('and that is what is stored',
    sink.records[1].accountId === 'REAL-ACCOUNT-01', String(sink.records[1].accountId));
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
  assert('a valid receipt belonging to another subject is rejected',
    replayed.rejections.every((r) => r.reason === 'receipt_subject_mismatch'),
    JSON.stringify(replayed.rejections));

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

  // CONTROL: a batch of INTERNAL non-preconsent events may legitimately carry a
  // clientSessionId, so the rejections above are the §3.5.1 rule and not a blanket ban.
  const control = await service.ingest({
    body: batch([ev('client.fps', { p50: 60, p01: 40, windowSec: 30 }, clock)], { clientSessionId: ulid() }),
    actor: null, correlationId: ulid(),
  });
  assert('CONTROL: an ordinary internal batch may carry a clientSessionId', control.accepted === 1,
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

console.log(failures ? `\n${failures} FAILED` : '\nclient telemetry runs clean');
process.exit(failures ? 1 : 0);
