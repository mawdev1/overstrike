/**
 * Composition-root tests.  platform/src/app.js.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────────────────
 * The second adversarial pass found four defects living entirely in the wiring — the consent
 * verifier auth issues against and telemetry verifies with were different signers; the
 * telemetry route declared an option the router does not read, so no auth middleware ever ran;
 * the outbox relay was never constructed, making `events_outbox` write-only; and the core rate
 * limiter was built, janitored and never consulted.
 *
 * All four survived 752 passing checks, because every one of those checks exercised a module
 * in isolation. `app.js` is the one file whose entire job is knowing how the parts fit, and it
 * was the only file with no test at all.
 *
 * So these tests boot the REAL app over a REAL socket and drive the REAL routes. No module is
 * substituted. If a seam is wrong, it fails here — which is the only place it can fail before
 * production.
 */
import { loadConfig } from '../src/core/config.js';
import { buildApp } from '../src/app.js';

let passed = 0;
let failed = 0;
const check = (cond, label, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); if (detail) console.log(`       ${detail}`); }
};
const section = (name) => console.log(`\n--- ${name} ---`);

/** A quiet logger: these tests assert behaviour, not log volume. */
const silent = () => {
  const noop = () => {};
  const l = { debug: noop, info: noop, warn: noop, error: noop };
  l.child = () => l;
  return l;
};

/**
 * Bind port 0 and ask the OS what it gave us.
 *
 * Fixed ports made this suite collide with stubtest intermittently — one run red, the next
 * green, with no code change between them. A flaky suite is worse than a failing one: it
 * teaches everyone to re-run instead of to look.
 */
async function withApp(fn, envOverrides = {}) {
  const config = loadConfig({ PLATFORM_PORT: '0', ...envOverrides });
  const app = await buildApp(config, { logger: silent() });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      // §1: every client request carries X-Client-Build. The app enforces it on client routes
      // now, including when no floor is configured, so the harness must send it like a client.
      headers: { 'content-type': 'application/json', 'x-client-build': '1.0.0', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json; the test will say so */ }
    return { status: res.status, body: json, headers: res.headers, text };
  };

  try { return await fn({ app, call, config, port }); }
  finally { app.stop(); await new Promise((r) => app.server.close(r)); }
}

/** Walk the approved onboarding order and return the artefacts each step yields. */
async function onboard(call, { sid, email = 'player@example.invalid', name = 'Ravon' } = {}) {
  const elig = await call('POST', '/v1/onboarding/eligibility',
    { dateOfBirth: '1994-03-02', jurisdiction: 'CA-ON' });
  const consent = await call('PUT', '/v1/onboarding/consent',
    { telemetryPersonal: true, policyVersion: 1, clientSessionId: sid });
  const signup = await call('POST', '/v1/auth/signup', {
    email, password: 'correct horse battery staple', displayName: name,
    eligibilityReceipt: elig.body?.receipt,
    clientSessionId: sid,
    consentReceipt: consent.body?.receipt,
  });
  return { elig, consent, signup };
}

const SID = '01M0EFV571B7VBQCNXHAT5WTBR';
const CORR = '01M0EFV571B7VBQCNXHAT5WTBS';

// ── 1. every module actually mounts ───────────────────────────────────────────────────
await withApp(async ({ app }) => {
  section('module mounting');
  for (const name of ['events', 'auth', 'profile', 'telemetry', 'stubs']) {
    check(app.mounted.includes(name), `${name} module mounts`, JSON.stringify(app.mounted));
  }
  check(typeof app.deps.events?.relay?.runOnce === 'function',
    'the outbox relay is CONSTRUCTED, not merely exported',
    'without it events_outbox is a write-only table');
});

// ── 2. the onboarding chain, end to end, over HTTP ─────────────────────────────────────
await withApp(async ({ call }) => {
  section('onboarding chain over HTTP');
  const { elig, consent, signup } = await onboard(call, { sid: SID });

  check(elig.status === 200, 'eligibility returns 200', JSON.stringify(elig.body));
  check(elig.body?.minimumAge === undefined,
    'eligibility never publishes the age it tests against',
    'a neutral gate that states its threshold is not neutral');
  check(typeof elig.body?.receipt === 'string', 'eligibility issues a receipt');
  check(consent.status === 200, 'consent returns 200');
  check(signup.status === 201, 'signup CREATES the account', JSON.stringify(signup.body?.error));

  // The defect this catches: auth wrote raw envelopes into events_outbox, so every write path
  // returned 400 against a real store while the module suite passed with a fake outbox.
  check(signup.body?.error === undefined,
    'signup does not fail on a store schema fault',
    JSON.stringify(signup.body?.error));

  const replay = await call('POST', '/v1/auth/signup', {
    email: 'other@example.invalid', password: 'correct horse battery staple', displayName: 'Other',
    eligibilityReceipt: elig.body?.receipt, clientSessionId: SID, consentReceipt: consent.body?.receipt,
  });
  check(replay.status === 400 && replay.body?.error?.code === 'ELIGIBILITY_RECEIPT_INVALID',
    'an eligibility receipt is single-use',
    `${replay.status} ${replay.body?.error?.code}`);
});

// ── 3. consent receipts cross the auth/telemetry seam ─────────────────────────────────
await withApp(async ({ call }) => {
  section('consent receipt crosses the auth -> telemetry seam');
  const { signup } = await onboard(call, { sid: SID });
  const token = signup.body?.accessToken;
  const receipt = signup.body?.consentReceipt;

  check(typeof receipt === 'string', 'signup returns an account-scoped consent receipt');

  const personal = await call('POST', '/v1/telemetry/client', {
    clientSessionId: SID, consentReceipt: receipt, schemaVersion: 1,
    events: [{
      name: 'flow.step', version: 1, occurredAt: new Date().toISOString(),
      correlationId: CORR, payload: { step: 'signup', outcome: 'completed', errorCode: null },
    }],
  }, { authorization: `Bearer ${token}` });

  // THE defect: auth and telemetry built different signers over the same secret, so the HMAC
  // verified and the claims did not. Every personal event from every consenting player was
  // discarded as `consent_declined`, and no module test could see it.
  check(personal.status === 202 && personal.body?.accepted === 1 && personal.body?.rejected === 0,
    'a personal event is ACCEPTED using the receipt auth actually issued',
    JSON.stringify(personal.body));

  const forged = await call('POST', '/v1/telemetry/client', {
    clientSessionId: SID, consentReceipt: 'ZmFrZQ.ZmFrZQ', schemaVersion: 1,
    events: [{
      name: 'flow.step', version: 1, occurredAt: new Date().toISOString(),
      correlationId: CORR, payload: { step: 'signup', outcome: 'completed', errorCode: null },
    }],
  });
  check(forged.status === 202 && forged.body?.accepted === 0,
    'control: a forged receipt is refused, so acceptance above is not blanket',
    JSON.stringify(forged.body));
});

// ── 3b. a consent receipt binds to EXACTLY ONE subject ────────────────────────────────
await withApp(async ({ call }) => {
  section('consent receipt subject binding');
  const A = '01M0EFV571B7VBQCNXHAT5WTBR';
  const Bs = '01M0EFV571B7VBQCNXHAT5WTBS';
  const ev = [{
    name: 'flow.step', version: 1, occurredAt: new Date().toISOString(),
    correlationId: CORR, payload: { step: 'signup', outcome: 'completed', errorCode: null },
  }];

  const cA = await call('PUT', '/v1/onboarding/consent',
    { telemetryPersonal: true, policyVersion: 1, clientSessionId: A });

  // The vulnerability: the adapter read expect.subject/expect.subjectId while the service
  // sends accountId/clientSessionId, so both were undefined and the `if (expect.x && …)`
  // guards short-circuited to no check. Possession of ANY valid receipt authorised personal
  // telemetry for ANY session.
  const cross = await call('POST', '/v1/telemetry/client',
    { clientSessionId: Bs, consentReceipt: cA.body?.receipt, schemaVersion: 1, events: ev });
  check(cross.body?.accepted === 0,
    "session A's receipt does NOT authorise session B",
    JSON.stringify(cross.body));

  const same = await call('POST', '/v1/telemetry/client',
    { clientSessionId: A, consentReceipt: cA.body?.receipt, schemaVersion: 1, events: ev });
  check(same.body?.accepted === 1,
    'control: the same session IS authorised, so the refusal above is not blanket',
    JSON.stringify(same.body));

  const noSid = await call('POST', '/v1/telemetry/client',
    { consentReceipt: cA.body?.receipt, schemaVersion: 1, events: ev });
  check(noSid.body?.accepted === 0,
    'a personal batch with no subject to bind to is refused',
    JSON.stringify(noSid.body));

  // Cross-class: a client-session receipt presented by an authenticated caller. The expected
  // subject is derived from authenticated state, so this must not satisfy an account subject.
  const { signup } = await onboard(call, { sid: A, email: 'binding@example.invalid' });
  const crossClass = await call('POST', '/v1/telemetry/client',
    { clientSessionId: A, consentReceipt: cA.body?.receipt, schemaVersion: 1, events: ev },
    { authorization: `Bearer ${signup.body?.accessToken}` });
  check(crossClass.body?.accepted === 0,
    'a client-session receipt does not authorise an AUTHENTICATED batch',
    JSON.stringify(crossClass.body));
});

// ── 4. the relay drains the outbox ────────────────────────────────────────────────────
await withApp(async ({ call, app }) => {
  section('outbox relay');
  await onboard(call, { sid: SID });

  const before = await app.deps.store.outbox.claimUnpublished(50);
  check(before.length > 0, 'signup wrote events to the outbox', `${before.length} rows`);

  const pass = await app.deps.events.relay.runOnce();
  check(pass.published === before.length && pass.failed === 0,
    'the relay publishes every claimed row',
    JSON.stringify(pass));

  const after = await app.deps.store.outbox.claimUnpublished(50);
  check(after.length === 0, 'the outbox drains to zero', `${after.length} left`);
});

// ── 4b. the stub layer is REACHABLE over HTTP, not merely constructed ─────────────────
await withApp(async ({ call }) => {
  section('stub layer is mounted');
  // H1.1's blocker: the stub object existed and nothing could reach it, so there was no
  // address for the other lane to build against.
  // `GET /v1/rooms` is an `A` row (§2), and the stub layer now enforces the same auth class
  // production does — so the harness signs in through the stub first, exactly as a client
  // would. It previously reached an authenticated endpoint with no credential at all.
  const asClient = async (scenario, session) => {
    const signin = await call('POST', '/v1/auth/signin', { email: 'a@b.invalid', password: 'p' },
      { 'x-stub-scenario': scenario, 'x-client-session-id': session });
    return call('GET', '/v1/rooms', undefined, {
      'x-stub-scenario': scenario,
      'x-client-session-id': session,
      authorization: `Bearer ${signin.body?.accessToken}`,
    });
  };

  const empty = await asClient('browser-empty', 'apptest-1');
  check(empty.status === 200 && Array.isArray(empty.body?.items) && empty.body.items.length === 0,
    'a stub scenario answers an endpoint the platform has not implemented yet',
    `${empty.status} ${empty.text?.slice(0, 60)}`);
  check(typeof empty.body?.correlationId === 'string',
    'a stub response still carries the correlation id');

  const populated = await asClient('default', 'apptest-2');
  check(populated.body?.items?.length > 0,
    'control: a different scenario returns different data, so the layer is stateful');

  // And the gate is real: the same request without a token is refused by the stub layer,
  // exactly as production would refuse it.
  const unauth = await call('GET', '/v1/rooms', undefined,
    { 'x-stub-scenario': 'default', 'x-client-session-id': 'apptest-3' });
  check(unauth.status === 401,
    'the stub layer enforces the same auth class production does',
    `${unauth.status} ${unauth.body?.error?.code}`);

  const real = await call('GET', '/v1/rooms');
  check(real.status === 404,
    'WITHOUT the header the platform behaves exactly as production does',
    'a stub layer that answers unheadered requests is a stub layer serving real players');
});

// ── 5. rate limiting is actually consulted ────────────────────────────────────────────
await withApp(async ({ app }) => {
  section('rate limiter wiring');
  check(typeof app.deps.rateLimit === 'function',
    'the composition root exposes a rate-limit middleware factory',
    'the limiter was previously constructed, janitored, and never consulted');
  const mw = app.deps.rateLimit('read');
  const ctx = { actor: null, ip: '203.0.113.9', deps: app.deps };
  let refusedAt = 0;
  for (let i = 1; i <= 200; i++) {
    try { await mw(ctx); } catch { refusedAt = i; break; }
  }
  check(refusedAt > 0 && refusedAt <= 121,
    'the read class refuses past its stated limit',
    `refused at attempt ${refusedAt}`);
});

// ── 6. health, and the contract's dependency name ─────────────────────────────────────
await withApp(async ({ call, config }) => {
  section('health endpoints');
  const live = await call('GET', '/v1/health');
  check(live.status === 200 && live.body?.ok === true, 'liveness returns 200');
  check(typeof live.headers.get('x-correlation-id') === 'string',
    'every response carries the correlation id header');

  const denied = await call('GET', '/v1/health/ready');
  check(denied.status === 403, 'readiness FAILS CLOSED without a service token', String(denied.status));

  const ready = await call('GET', '/v1/health/ready', undefined,
    { 'x-service-token': config.serviceToken });
  check(ready.status === 200, 'readiness answers with the service token');
  // §7.1 names this dependency `db`. The shape is contract, not a label we pick.
  check(ready.body?.dependencies?.db === 'up',
    'readiness names the dependency `db`, as §7.1 specifies',
    JSON.stringify(ready.body?.dependencies));
});

// ── 7. auth middleware genuinely protects protected routes ────────────────────────────
await withApp(async ({ call }) => {
  section('auth middleware on protected routes');
  const anon = await call('GET', '/v1/profile/me');
  check(anon.status === 401 && anon.body?.error?.code === 'AUTH_REQUIRED',
    'an unauthenticated profile read is refused',
    `${anon.status} ${anon.body?.error?.code}`);

  const { signup } = await onboard(call, { sid: SID });
  const me = await call('GET', '/v1/profile/me', undefined,
    { authorization: `Bearer ${signup.body?.accessToken}` });
  check(me.status === 200 && me.body?.accountId === signup.body?.profile?.accountId,
    'control: the same route answers with a valid token',
    `${me.status}`);
});

// ── 8. the stub layer refuses to exist in production ──────────────────────────────────
{
  section('stub layer production guard');
  const prodConfig = loadConfig({
    PLATFORM_PORT: '8299', NODE_ENV: 'production',
    PLATFORM_TOKEN_SECRET: 'a-sufficiently-long-production-secret-value',
    PLATFORM_SERVICE_TOKEN: 'a-sufficiently-long-production-service-token',
  });
  const prod = await buildApp(prodConfig, { logger: silent() });
  check(!prod.mounted.includes('stubs') && prod.deps.stubs === undefined,
    'a production process does not load the stub layer at all',
    JSON.stringify(prod.mounted));
  check(['events', 'auth', 'profile', 'telemetry'].every((m) => prod.mounted.includes(m)),
    'control: production still mounts every module it does require',
    JSON.stringify(prod.mounted));
  prod.stop();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('\napp wiring is NOT clean'); process.exit(1); }
console.log('\napp wiring runs clean');
