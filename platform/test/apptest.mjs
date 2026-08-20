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
  // `process.env` FIRST. `loadConfig` REPLACES the environment rather than merging with it, so
  // a config built from a bare object literal is always `storage: memory` — including under
  // `scripts/pgtest.mjs`, whose whole purpose is to run this suite against a real database.
  // This suite is the composition-root test: every "assembled app works" claim it made under
  // pgtest was made against the memory adapter, which is the one configuration pgtest exists
  // to not test. An `envOverrides` key still wins, so a test that deliberately wants memory
  // can still ask for it explicitly.
  const config = loadConfig({ ...process.env, PLATFORM_PORT: '0', ...envOverrides });
  if (process.env.PLATFORM_STORAGE && !envOverrides.PLATFORM_STORAGE
      && config.storage !== process.env.PLATFORM_STORAGE) {
    throw new Error(`apptest: asked for ${process.env.PLATFORM_STORAGE}, built ${config.storage}`);
  }
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

/**
 * Walk the approved onboarding order and return the artefacts each step yields.
 *
 * Each onboarding gets its OWN email and display name unless the caller pins them.
 *
 * These were fixed literals, which is correct for the memory adapter — every `withApp` builds a
 * fresh store, so the second signup sees an empty account table. Against PostgreSQL the database
 * outlives all of them, so the second `withApp` collided with the first on NAME_TAKEN and every
 * section after the onboarding chain failed at the first request. Those sections were not finding
 * a product defect and were not passing either; they were unreachable.
 *
 * A caller that needs the SAME identity twice (replay, uniqueness) passes it explicitly.
 */
let identity = 0;
async function onboard(call, { sid, email, name } = {}) {
  const n = ++identity;
  email = email ?? `player${n}@example.invalid`;
  name = name ?? `Ravon${n}`;
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

// ── 3c. a recorded DECLINE is not consent — ON THE ADAPTER THAT SHIPS ─────────────────
//
// There has always been a decline assertion in the repository: telemetrytest.mjs §"consent"
// builds its verifier from `modules/telemetry/consent.js createConsentReceipts`. That verifier
// is NEVER DEPLOYED. `app.js` mounts `adaptAuthConsent(deps.auth.receipts, config)` in its
// place whenever the auth module is present, which in production is always. So the only
// decline test in the codebase tested an implementation no request ever reaches, and deleting
// `adaptAuthConsent`'s `telemetryPersonal !== true` line left the whole suite green while the
// platform accepted personal telemetry from a player who had explicitly said no.
//
// Refusing a decline is the single obligation the consent gate exists to discharge. It is
// asserted here, over a socket, against the assembled app.
await withApp(async ({ call }) => {
  section('a recorded DECLINE is not consent');
  const declinedSid = '01M0EFV571B7VBQCNXHAT5WTD1';
  const grantedSid = '01M0EFV571B7VBQCNXHAT5WTD2';
  // `flow.step` is personal-class: it is exactly the class the receipt gates.
  const personal = () => [{
    name: 'flow.step', version: 1, occurredAt: new Date().toISOString(),
    correlationId: CORR, payload: { step: 'signup', outcome: 'completed', errorCode: null },
  }];

  const no = await call('PUT', '/v1/onboarding/consent',
    { telemetryPersonal: false, policyVersion: 1, clientSessionId: declinedSid });
  check(no.status === 200 && typeof no.body?.receipt === 'string',
    'control: a DECLINE is a recorded decision and still issues a receipt',
    `${no.status} ${JSON.stringify(no.body?.error ?? no.body)}`);

  const sent = await call('POST', '/v1/telemetry/client',
    { clientSessionId: declinedSid, consentReceipt: no.body?.receipt, schemaVersion: 1, events: personal() });
  check(sent.status === 202 && sent.body?.accepted === 0 && sent.body?.rejected === 1,
    'a personal event presented under a DECLINED receipt is REFUSED by the assembled app',
    JSON.stringify(sent.body));

  // CONTROL: the same batch, same route, same event, one field different. Without this the
  // refusal above is satisfied by a gate that refuses everything.
  const yes = await call('PUT', '/v1/onboarding/consent',
    { telemetryPersonal: true, policyVersion: 1, clientSessionId: grantedSid });
  const allowed = await call('POST', '/v1/telemetry/client',
    { clientSessionId: grantedSid, consentReceipt: yes.body?.receipt, schemaVersion: 1, events: personal() });
  check(allowed.status === 202 && allowed.body?.accepted === 1 && allowed.body?.rejected === 0,
    'CONTROL: the identical batch under a GRANTED receipt is accepted',
    JSON.stringify(allowed.body));

  // And the decline survives signup: the account carries the recorded "no", and the
  // account-scoped receipt signup hands back must not authorise personal telemetry either.
  const elig = await call('POST', '/v1/onboarding/eligibility',
    { dateOfBirth: '1994-03-02', jurisdiction: 'CA-ON' });
  const signup = await call('POST', '/v1/auth/signup', {
    email: 'declined@example.invalid', password: 'correct horse battery staple',
    displayName: `Declino${Date.now().toString(36).slice(-5)}`,
    eligibilityReceipt: elig.body?.receipt,
    clientSessionId: declinedSid, consentReceipt: no.body?.receipt,
  });
  check(signup.body?.profile?.consent?.telemetryPersonal === false,
    'control: the decline is carried onto the account at signup',
    JSON.stringify(signup.body?.profile?.consent ?? signup.body?.error));

  const asAccount = await call('POST', '/v1/telemetry/client',
    { schemaVersion: 1, consentReceipt: signup.body?.consentReceipt, events: personal() },
    { authorization: `Bearer ${signup.body?.accessToken}` });
  check(asAccount.status === 202 && asAccount.body?.accepted === 0 && asAccount.body?.rejected === 1,
    'an AUTHENTICATED batch under the account receipt of a player who declined is REFUSED',
    JSON.stringify(asAccount.body));
});

// ── 3d. a receipt is bound to a subject CLASS, not only to an id ──────────────────────
//
// `claims.subject !== wantSubject` survived deletion because every existing case that crosses
// the class boundary ALSO crosses the id boundary, so the next line caught it and the class
// check asserted nothing. The case that separates them: an account receipt whose subjectId is
// an account id, replayed by a signed-out caller who names that same id as their client
// session. The ids match; only the class differs.
await withApp(async ({ call }) => {
  section('consent receipt subject CLASS binding');
  const { signup } = await onboard(call, { sid: '01M0EFV571B7VBQCNXHAT5WTD3', email: 'classbind@example.invalid' });
  const accountId = signup.body?.profile?.accountId;
  const accountReceipt = signup.body?.consentReceipt;
  check(typeof accountId === 'string' && typeof accountReceipt === 'string',
    'control: signup yields an account id and an account-scoped receipt',
    `${signup.status} ${signup.body?.error?.code ?? ''}`);

  const ev = [{
    name: 'flow.step', version: 1, occurredAt: new Date().toISOString(),
    correlationId: CORR, payload: { step: 'signup', outcome: 'completed', errorCode: null },
  }];

  // No Authorization header: the expected subject class is `client-session`. The id it wants
  // is `accountId`, which is precisely what the account receipt carries — so ONLY the class
  // check can refuse this.
  const replayed = await call('POST', '/v1/telemetry/client',
    { clientSessionId: accountId, consentReceipt: accountReceipt, schemaVersion: 1, events: ev });
  check(replayed.body?.accepted === 0 && replayed.body?.consentReceiptError?.reason === 'receipt_unbound',
    'an ACCOUNT receipt does not authorise a signed-out batch that names the same id',
    JSON.stringify(replayed.body));

  // CONTROL: the same receipt on the authenticated path, where its class is the right one.
  const proper = await call('POST', '/v1/telemetry/client',
    { schemaVersion: 1, consentReceipt: accountReceipt, events: ev },
    { authorization: `Bearer ${signup.body?.accessToken}` });
  check(proper.body?.accepted === 1 && proper.body?.rejected === 0,
    'CONTROL: the same receipt IS accepted for the account it was issued to',
    JSON.stringify(proper.body));
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
//
// This section was named "rate limiting is actually consulted" and did not test that.
//
// It asserted `typeof app.deps.rateLimit === 'function'`, then BUILT the middleware itself and
// called it in a loop. Both checks passed for two years' worth of review rounds while
// `deps.rateLimit` had zero call sites anywhere in `platform/src` — every read and write in
// the platform was uncapped. A test that constructs the thing under test and drives it by hand
// proves the thing exists, which was never in doubt; it cannot prove a route reaches it.
//
// So the limit is now asserted the only way that distinguishes those: over a socket, against a
// real route, counting what the server actually answers.
await withApp(async ({ call }) => {
  section('rate limiting is consulted BY ROUTES, not merely constructed');

  // §9 read: 120/min per account, keyed on IP for an unauthenticated caller. GET
  // /v1/onboarding/terms is a plain client GET — no auth, no service exemption.
  let firstRefusal = 0;
  let refusedBody = null;
  for (let i = 1; i <= 130; i++) {
    const res = await call('GET', '/v1/onboarding/terms');
    if (res.status === 429) { firstRefusal = i; refusedBody = res.body; break; }
    if (res.status !== 200) { firstRefusal = -i; refusedBody = res.body; break; }
  }
  check(firstRefusal === 121,
    'the 121st read in a minute is refused, exactly as §9 states',
    `first non-200 at attempt ${firstRefusal}: ${JSON.stringify(refusedBody)}`);
  check(refusedBody?.error?.code === 'RATE_LIMITED',
    'refusal is the contracted code, not a generic 4xx',
    JSON.stringify(refusedBody?.error));
  check(typeof refusedBody?.error?.retryAfterMs === 'number' && refusedBody.error.retryAfterMs > 0,
    '§9: the refusal carries retryAfterMs so a client knows when to return',
    JSON.stringify(refusedBody?.error?.retryAfterMs));
});

await withApp(async ({ call }) => {
  section('the §9 exemptions are exemptions, not oversights');

  // "Service: Uncapped, mTLS-gated". Capping the match-result submitter would drop results on
  // a busy shard — so the exemption is load-bearing, and a regression that silently capped it
  // would look like flaky match reporting rather than a rate limit.
  let stillServing = true;
  for (let i = 1; i <= 140; i++) {
    const res = await call('GET', '/v1/health');
    if (res.status !== 200) { stillServing = false; break; }
  }
  check(stillServing, '140 service/health calls are not rate limited', 'a capped health check fails a load balancer');
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

// ── 7b. one Idempotency-Key collapses a concurrent burst, over real HTTP ──────────────
//
// REQ-CC-052 reported that two concurrent identical `PATCH /profile/me` requests under one
// `Idempotency-Key` both proceed. The read-decide-write in `profile.js` is wrapped in a
// transaction, and a transaction alone does not stop it: `idempotency.get` takes no lock and
// there is no row to lock on the first attempt, so on PostgreSQL every racer reads
// `prior = null` inside its own transaction and every racer executes.
//
// This test only means anything against PostgreSQL. The memory adapter serialises every
// transaction through one lock and its `acquire` is a documented no-op, so a green run there
// proves the endpoint works and proves NOTHING about the race. `scripts/pgtest.mjs` runs this
// file against a real database, which is where the claim is settled.
//
// The proof of "executed once" is a side effect that counts: a rename writes exactly one
// `account_name_history` row (auth.md §9). Comparing response bodies is not enough on its own
// — every racer could execute and still be handed an identical final profile.
await withApp(async ({ call, app }) => {
  section('concurrent PATCH /profile/me under one Idempotency-Key');
  const { signup } = await onboard(call, { sid: '01M0EFV571B7VBQCNXHAT5WTC1', name: 'RaceSubject' });
  const token = signup.body?.accessToken;
  const accountId = signup.body?.profile?.accountId;
  check(typeof token === 'string' && typeof accountId === 'string',
    'control: the race subject is signed up and holds a usable token',
    `${signup.status} ${signup.body?.error?.code ?? ''}`);

  const N = 12;
  const patch = (key, displayName) => call('PATCH', '/v1/profile/me', { displayName },
    { authorization: `Bearer ${token}`, 'idempotency-key': key });

  const burst = await Promise.all(Array.from({ length: N }, () => patch('race-key-1', 'RaceWinner')));

  check(burst.every((r) => r.status === 200),
    `all ${N} concurrent retries answer 200`,
    JSON.stringify(burst.map((r) => `${r.status}:${r.body?.error?.code ?? ''}`)));

  // jsonb does not preserve key order, so the replayed body comes back reordered. Compare on
  // content, not on the bytes `JSON.stringify` happens to emit.
  const stable = (v) => (v === null || typeof v !== 'object' ? JSON.stringify(v) ?? 'null'
    : Array.isArray(v) ? `[${v.map(stable).join(',')}]`
      : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`);
  const bodies = new Set(burst.map((r) => stable({ ...r.body, correlationId: undefined })));
  check(bodies.size === 1, 'every retry returns the same response body', [...bodies].join('\n       vs '));

  const history = await app.deps.store.accountNameHistory.listForAccount(accountId, { limit: 100 });
  check(history.length === 1,
    'and the rename EXECUTED EXACTLY ONCE — one name-history row, not one per racer',
    `${history.length} rows: ${JSON.stringify(history.map((h) => h.previousName))}`);

  // CONTROL: the collapsing above is the idempotency key doing work, not the endpoint being
  // inert. The same burst under DISTINCT keys is not one request, and must not be collapsed:
  // it is a rename repeated N times, so §9's 30-day cooldown refuses all but the first.
  const { signup: s2 } = await onboard(call, { sid: '01M0EFV571B7VBQCNXHAT5WTC2', name: 'ControlSubject' });
  const t2 = s2.body?.accessToken;
  const spread = await Promise.all(Array.from({ length: N }, (_, i) =>
    call('PATCH', '/v1/profile/me', { displayName: `Control${i}` },
      { authorization: `Bearer ${t2}`, 'idempotency-key': `control-key-${i}` })));
  const spreadCodes = JSON.stringify(spread.map((r) => `${r.status}:${r.body?.error?.code ?? ''}`));
  check(spread.some((r) => r.status === 200) && spread.some((r) => r.status !== 200),
    'CONTROL: distinct keys are distinct requests and are NOT collapsed — some succeed, the '
    + 'rest hit the §9 rename cooldown',
    spreadCodes);
  // The refusals are the ordinary consequences of N genuinely separate renames racing on one
  // account: the §9 cooldown once a rename has landed, or a unique-name collision between two
  // that have not yet. Either is proof they EXECUTED; what must not appear is an auth or
  // validation code, which would mean the control burst never reached the endpoint at all and
  // the "not collapsed" check above passed for the wrong reason.
  check(spread.filter((r) => r.status !== 200)
    .every((r) => ['NAME_CHANGE_COOLDOWN', 'CONFLICT'].includes(r.body?.error?.code)),
    'CONTROL: and the refusals are rename outcomes, not an auth or validation accident',
    spreadCodes);
});

// ── 7b-bis. the §9 RENAME COOLDOWN survives a concurrent burst ────────────────────────
//
// §7b above proves an Idempotency-Key collapses a burst. Its CONTROL — the same burst under
// DISTINCT keys — asserted only that "some succeed and some do not", and that is satisfied by
// a cooldown that is not enforced at all: `changeDisplayName` reads the account, checks
// `assertCooldown(account.nameChangedAt, now)`, and writes, with NOTHING serialising the three.
// Two renames that arrive together both read `nameChangedAt: null`, both pass the check, and
// both write — so a 30-day cooldown is bypassed by sending two requests instead of one, and
// two name-history rows are retained for what §9 permits once.
//
// `display_name_folded` is UNIQUE, so the database backstops a collision on the same NAME.
// Nothing backstops the COOLDOWN, and distinct names walk straight past the unique index.
//
// DISTINCT Idempotency-Keys, deliberately. §8 makes the header mandatory on this route, and
// the advisory lock profile.js takes is keyed `accountId:idempotencyKey` — so N distinct keys
// take N DIFFERENT locks and serialise nothing. That is the correct behaviour for that lock:
// these are N genuinely separate requests, not retries of one, and §7b's collapsing must not
// apply to them. What has to hold them apart is the §9 rename rule itself.
//
// Like §7b, this claim is settled on PostgreSQL. The memory adapter serialises every
// transaction, so a green run there proves the endpoint works and nothing about the race.
await withApp(async ({ call, app }) => {
  section('§9 rename cooldown under a concurrent burst of DISTINCT requests');
  // Postgres outlives the process, so the subject's name is unique per RUN — a fixed literal
  // collides with the previous run on NAME_TAKEN and every assertion below then fails for a
  // reason that has nothing to do with the cooldown.
  const tag = Date.now().toString(36).slice(-6);
  const startName = `Cooldown${tag}`;
  const { signup } = await onboard(call, {
    sid: '01M0EFV571B7VBQCNXHAT5WTC3', name: startName, email: `cooldown-${tag}@example.invalid`,
  });
  const token = signup.body?.accessToken;
  const accountId = signup.body?.profile?.accountId;
  check(typeof token === 'string' && typeof accountId === 'string',
    'control: the cooldown subject is signed up and holds a usable token',
    `${signup.status} ${signup.body?.error?.code ?? ''}`);
  check(signup.body?.profile?.displayName === startName,
    'control: and it starts on its signup name, having never been renamed',
    JSON.stringify(signup.body?.profile?.displayName));

  // N is deliberately larger than the two racers the defect needs. Moving the read inside the
  // write's transaction NARROWS the window without closing it — a `select` takes no row lock,
  // so two transactions can still both read `nameChangedAt: null` — and with N=10 that variant
  // slipped through roughly one run in three. Only the advisory lock makes "exactly one"
  // deterministic; the larger burst is what stops a partial fix from looking like a whole one.
  const N = 16;
  // DISTINCT names: a unique index cannot save the cooldown from a burst that never collides.
  const burst = await Promise.all(Array.from({ length: N }, (_, i) =>
    call('PATCH', '/v1/profile/me', { displayName: `Racer${tag}x${i}` },
      { authorization: `Bearer ${token}`, 'idempotency-key': `cooldown-${tag}-${i}` })));
  const codes = JSON.stringify(burst.map((r) => `${r.status}:${r.body?.error?.code ?? ''}`));

  const won = burst.filter((r) => r.status === 200);
  check(won.length === 1,
    `EXACTLY ONE of ${N} concurrent renames succeeds — the §9 cooldown is not a race`,
    `${won.length} succeeded: ${codes}`);
  check(burst.filter((r) => r.status !== 200).every((r) => r.body?.error?.code === 'NAME_CHANGE_COOLDOWN'),
    'and every other one is refused as a COOLDOWN — the rule that actually applies',
    codes);

  // The response codes are what the client sees; the history is what happened. A rename that
  // answered 409 having already written its row would satisfy the counts above and still have
  // renamed the account twice.
  const history = await app.deps.store.accountNameHistory.listForAccount(accountId, { limit: 100 });
  check(history.length === 1,
    'and the account has exactly ONE retained previous name, not one per racer',
    `${history.length} rows: ${JSON.stringify(history.map((h) => h.previousName))}`);
  check(history[0]?.previousName === startName,
    'control: and the retained name is the one it actually had before',
    JSON.stringify(history[0]));

  // The winner's name is the one on the account: the losers did not write over it afterwards.
  const me = await call('GET', '/v1/profile/me', undefined, { authorization: `Bearer ${token}` });
  check(me.body?.displayName === won[0]?.body?.displayName,
    'the account carries the winning name, and no loser overwrote it',
    `${me.body?.displayName} vs ${won[0]?.body?.displayName}`);

  // CONTROL: the cooldown is a COOLDOWN and not a one-rename-ever rule, and the endpoint is
  // not simply refusing everything — a case-only edit is not a change under §9 and is allowed
  // through on the same account that just exhausted its window.
  const caseOnly = await call('PATCH', '/v1/profile/me',
    { displayName: String(me.body?.displayName).toUpperCase() },
    { authorization: `Bearer ${token}`, 'idempotency-key': `cooldown-case-${tag}` });
  check(caseOnly.status === 200,
    'CONTROL: a case-only edit still succeeds, so the refusals above are the cooldown rule '
    + 'and not a dead endpoint',
    `${caseOnly.status} ${caseOnly.body?.error?.code ?? ''}`);
});

// ── 7c. consent and idempotency retention actually delete ─────────────────────────────
//
// Both are records with a contracted life — §3a.3 gives signed-out consent 30 days "deleted on
// migration at signup, or on expiry"; §8 gives an idempotency key 24 h for gameplay. Both were
// written with an expiry column that nothing ever acted on, and for the consent row the
// migration path stamped `migrated_at` and kept it. A row we have decided to stop reading is
// not a row we have deleted, and retention is the one obligation that cannot be discharged by
// a read filter.
await withApp(async ({ call, app }) => {
  section('consent and idempotency retention');
  const sid = '01M0EFV571B7VBQCNXHAT5WTC0';

  const consent = await call('PUT', '/v1/onboarding/consent',
    { telemetryPersonal: true, policyVersion: 1, clientSessionId: sid });
  check(consent.status === 200, 'control: a signed-out consent decision is recorded',
    `${consent.status} ${consent.body?.error?.code ?? ''}`);
  check((await app.deps.store.preAuthConsent.get(sid))?.telemetryPersonal === true,
    'control: and the row is on disk before signup');

  const elig = await call('POST', '/v1/onboarding/eligibility',
    { dateOfBirth: '1994-03-02', jurisdiction: 'CA-ON' });
  const signup = await call('POST', '/v1/auth/signup', {
    email: 'retention@example.invalid', password: 'correct horse battery staple',
    displayName: 'RetentionSubject', eligibilityReceipt: elig.body?.receipt,
    clientSessionId: sid, consentReceipt: consent.body?.receipt,
  });
  check(signup.status === 200 || signup.status === 201,
    'control: signup succeeds and carries the decision onto the account',
    `${signup.status} ${signup.body?.error?.code ?? ''}`);
  check(signup.body?.profile?.consent?.telemetryPersonal === true,
    'control: the account holds the decision now',
    JSON.stringify(signup.body?.profile?.consent));
  check((await app.deps.store.preAuthConsent.get(sid)) === null,
    'the signed-out consent row is DELETED at signup, not stamped and retained',
    JSON.stringify(await app.deps.store.preAuthConsent.get(sid)));

  // Signup burns the eligibility receipt's nonce into `idempotency_keys`. That row is
  // onboarding evidence with an expiry nothing used to enforce.
  const actor = signup.body?.profile?.accountId;
  await app.deps.store.idempotency.put({
    key: `retention-live-${actor}`, actorId: actor, requestHash: 'h',
    responseStatus: 200, responseBody: { ok: true },
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await app.deps.store.idempotency.put({
    key: `retention-dead-${actor}`, actorId: actor, requestHash: 'h',
    responseStatus: 200, responseBody: { ok: true },
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const removed = await app.sweepIdempotencyKeys();
  check(removed >= 1, 'the assembled app exposes a retention sweep that deletes', `removed ${removed}`);
  check((await app.deps.store.idempotency.get(`retention-dead-${actor}`, actor)) === null,
    'an idempotency key past its §8 retention is deleted');
  check((await app.deps.store.idempotency.get(`retention-live-${actor}`, actor))?.requestHash === 'h',
    'CONTROL: a key inside its window survives, so the sweep is not simply emptying the table');
});

// ── 7d. THE AUTH ROUTES NOBODY EVER CALLED ────────────────────────────────────────────
//
// V8 coverage of the suite found that 13 of the 16 real auth HTTP routes were never reached by
// any test: signin, refresh, signout, signout-all, list-sessions, revoke-session,
// recovery/start, recovery/complete, GET consent, verify/resend, verify/complete, terms and
// terms/accept. Every rule they enforce was tested against the SERVICE in authtest.mjs — and a
// service test cannot see a route that is registered on the wrong path, declares middleware
// the router does not read, forgets to queue its cookie, or returns a shape the client cannot
// parse. Those are exactly the four defects §"why this file exists" above was written for.
//
// The routes work; this is a guard gap, not a live defect. What follows is the guard.
//
// Split across several `withApp` blocks on purpose: §9's auth class is 10/min per IP and every
// request here arrives from 127.0.0.1, so one long block would start measuring the rate
// limiter instead of the routes. Each block builds its own app, and therefore its own limiter.

const PW = 'correct horse battery staple';
/** Every `Set-Cookie` on a response, as a raw string array. */
const setCookies = (res) => (res.headers.getSetCookie?.() ?? []);
/** The value of the refresh cookie a response sets, or null. */
const refreshCookieValue = (res) => {
  const hit = setCookies(res).find((c) => c.startsWith('os_rt='));
  return hit === undefined ? null : hit.slice('os_rt='.length).split(';')[0];
};

// ── 7d-i. the session lifecycle: signin → refresh → list → revoke → signout(-all) ─────
await withApp(async ({ call }) => {
  section('auth session routes over a real socket');
  const tag = Date.now().toString(36).slice(-6);
  const email = `sessions-${tag}@example.invalid`;
  const { signup } = await onboard(call, {
    sid: '01M0EFV571B7VBQCNXHAT5WTD4', name: `Sess${tag}`, email,
  });
  check(signup.status === 201, 'control: the subject is signed up', JSON.stringify(signup.body?.error));

  // §3a.4/§11.1: the refresh credential travels ONLY as an httpOnly cookie. A cookie that is
  // assembled and never written is a session that silently does not persist across a reload,
  // and no test had ever looked at a response header here.
  const signupCookie = refreshCookieValue(signup);
  check(typeof signupCookie === 'string' && signupCookie.length > 0,
    'signup SETS the refresh cookie', JSON.stringify(setCookies(signup)));
  const attrs = setCookies(signup).find((c) => c.startsWith('os_rt=')) ?? '';
  check(/HttpOnly/i.test(attrs) && /Secure/i.test(attrs) && /SameSite=Lax/i.test(attrs)
    && /Path=\/v1\/auth/i.test(attrs),
    'and it is HttpOnly, Secure, SameSite=Lax and scoped to /v1/auth', attrs);
  check(signup.body?.refreshToken === undefined,
    'and the refresh token is NOT in the body — the cookie is the only channel',
    JSON.stringify(Object.keys(signup.body ?? {})));

  // ── signin ──
  const signin = await call('POST', '/v1/auth/signin', { email, password: PW });
  check(signin.status === 200 && typeof signin.body?.accessToken === 'string',
    'POST /v1/auth/signin issues an access token',
    `${signin.status} ${signin.body?.error?.code ?? ''}`);
  const signinCookie = refreshCookieValue(signin);
  check(typeof signinCookie === 'string' && signinCookie !== signupCookie,
    'signin sets a NEW refresh cookie, not the signup one',
    `${String(signinCookie).slice(0, 8)} vs ${String(signupCookie).slice(0, 8)}`);
  check(signin.body?.profile?.accountId === signup.body?.profile?.accountId,
    'and it is the same account', JSON.stringify(signin.body?.profile?.accountId));

  const wrong = await call('POST', '/v1/auth/signin', { email, password: 'not the password' });
  check(wrong.status === 401 && wrong.body?.error?.code === 'AUTH_INVALID_CREDENTIALS',
    'CONTROL: a wrong password is refused, so signin is checking one',
    `${wrong.status} ${wrong.body?.error?.code}`);

  // ── refresh ── the one route whose credential is a cookie and nothing else.
  const noCookie = await call('POST', '/v1/auth/refresh', {});
  check(noCookie.status === 401 && noCookie.body?.error?.code === 'AUTH_TOKEN_INVALID',
    'POST /v1/auth/refresh with NO cookie is refused',
    `${noCookie.status} ${noCookie.body?.error?.code}`);

  const refreshed = await call('POST', '/v1/auth/refresh', {}, { cookie: `os_rt=${signinCookie}` });
  check(refreshed.status === 200 && typeof refreshed.body?.accessToken === 'string',
    'POST /v1/auth/refresh with the cookie issues a fresh access token',
    `${refreshed.status} ${refreshed.body?.error?.code ?? ''}`);
  const rotated = refreshCookieValue(refreshed);
  check(typeof rotated === 'string' && rotated !== signinCookie,
    'and it ROTATES the cookie — §4 rotation, visible on the wire',
    `${String(rotated).slice(0, 8)} vs ${String(signinCookie).slice(0, 8)}`);

  // Replaying the rotated-away cookie is theft, and the route must show it.
  const replay = await call('POST', '/v1/auth/refresh', {}, { cookie: `os_rt=${signinCookie}` });
  check(replay.status === 401 && replay.body?.error?.code === 'AUTH_SESSION_REVOKED',
    'replaying the SUPERSEDED cookie is refused as a stolen family',
    `${replay.status} ${replay.body?.error?.code}`);

  // That reuse revoked the family the signin session belonged to. The SIGNUP session is a
  // different family and is untouched — which is also the token the rest of this block uses.
  const token = signup.body?.accessToken;

  // ── list sessions ──
  const anon = await call('GET', '/v1/auth/sessions');
  check(anon.status === 401 && anon.body?.error?.code === 'AUTH_REQUIRED',
    'GET /v1/auth/sessions without a token is AUTH_REQUIRED',
    `${anon.status} ${anon.body?.error?.code}`);

  const listed = await call('GET', '/v1/auth/sessions', undefined, { authorization: `Bearer ${token}` });
  check(listed.status === 200 && Array.isArray(listed.body?.sessions) && listed.body.sessions.length >= 1,
    'GET /v1/auth/sessions lists the caller\'s live sessions',
    `${listed.status} ${JSON.stringify(listed.body?.sessions?.length)}`);
  check(listed.body.sessions.filter((s) => s.isCurrent).length === 1,
    'exactly one session is flagged as the caller\'s own',
    JSON.stringify(listed.body.sessions.map((s) => s.isCurrent)));
  // auth.md §5: a class, never an address. The list is readable by whoever holds the account,
  // including whoever just stole it.
  check(listed.body.sessions.every((s) => typeof s.ipClass === 'string' && s.ipClass.length > 0)
    && !JSON.stringify(listed.body).includes('127.0.0.1'),
    'and it carries an ipClass and NO raw address',
    JSON.stringify(listed.body.sessions.map((s) => s.ipClass)));

  // ── revoke one session ──
  const second = await call('POST', '/v1/auth/signin', { email, password: PW });
  check(second.status === 200, 'control: a second session exists to revoke',
    `${second.status} ${second.body?.error?.code ?? ''}`);
  const victim = second.body?.session?.sessionId;
  const revoked = await call('DELETE', `/v1/auth/sessions/${victim}`, undefined,
    { authorization: `Bearer ${token}` });
  check(revoked.status === 204, 'DELETE /v1/auth/sessions/:id revokes it', String(revoked.status));
  const afterRevoke = await call('GET', '/v1/auth/sessions', undefined, { authorization: `Bearer ${token}` });
  check(!afterRevoke.body.sessions.some((s) => s.sessionId === victim),
    'and the revoked session leaves the list',
    JSON.stringify(afterRevoke.body.sessions.map((s) => s.sessionId)));
  check(afterRevoke.body.sessions.some((s) => s.sessionId === listed.body.sessions.find((x) => x.isCurrent)?.sessionId),
    'CONTROL: the caller\'s own session is still there — revoke took ONE, not all');

  // The revoked session's access token stops working on the very NEXT request (§5).
  const deadToken = await call('GET', '/v1/profile/me', undefined,
    { authorization: `Bearer ${second.body?.accessToken}` });
  check(deadToken.status === 401 && deadToken.body?.error?.code === 'AUTH_SESSION_REVOKED',
    'the revoked session\'s access token is refused immediately',
    `${deadToken.status} ${deadToken.body?.error?.code}`);

  // ── signout ── and the CLEARING cookie, which is the whole point of the route.
  const signout = await call('POST', '/v1/auth/signout', {}, { authorization: `Bearer ${token}` });
  check(signout.status === 204, 'POST /v1/auth/signout answers 204', String(signout.status));
  const cleared = setCookies(signout).find((c) => c.startsWith('os_rt=')) ?? '';
  check(/^os_rt=;/.test(cleared) && /Max-Age=0/i.test(cleared),
    'and it CLEARS the refresh cookie — an empty value with Max-Age=0',
    JSON.stringify(setCookies(signout)));
  const afterSignout = await call('GET', '/v1/profile/me', undefined, { authorization: `Bearer ${token}` });
  check(afterSignout.status === 401,
    'and the access token stops working', `${afterSignout.status} ${afterSignout.body?.error?.code}`);
});

// ── 7d-ii. signout-all, recovery, and the routes that end every session ───────────────
await withApp(async ({ call, app }) => {
  section('auth signout-all and recovery routes over a real socket');
  const tag = Date.now().toString(36).slice(-6);
  const email = `recov-${tag}@example.invalid`;
  const { signup } = await onboard(call, {
    sid: '01M0EFV571B7VBQCNXHAT5WTD5', name: `Recv${tag}`, email,
  });
  const token = signup.body?.accessToken;
  check(signup.status === 201 && typeof token === 'string',
    'control: the subject is signed up', JSON.stringify(signup.body?.error));

  const other = await call('POST', '/v1/auth/signin', { email, password: PW });
  check(other.status === 200, 'control: a second device signs in',
    `${other.status} ${other.body?.error?.code ?? ''}`);

  // ── signout-all ──
  const all = await call('POST', '/v1/auth/signout-all', {}, { authorization: `Bearer ${token}` });
  check(all.status === 204, 'POST /v1/auth/signout-all answers 204', String(all.status));
  const clearedAll = setCookies(all).find((c) => c.startsWith('os_rt=')) ?? '';
  check(/^os_rt=;/.test(clearedAll) && /Max-Age=0/i.test(clearedAll),
    'and it clears the refresh cookie too', JSON.stringify(setCookies(all)));
  for (const [label, t] of [['the caller', token], ['the OTHER device', other.body?.accessToken]]) {
    const res = await call('GET', '/v1/profile/me', undefined, { authorization: `Bearer ${t}` });
    check(res.status === 401 && res.body?.error?.code === 'AUTH_SESSION_REVOKED',
      `signout-all ends ${label}'s session, not just the one that asked`,
      `${res.status} ${res.body?.error?.code}`);
  }

  // ── recovery/start ── §8 requires it to be indistinguishable for a real and an unknown
  // address, so the assertion is that the two responses MATCH.
  const known = await call('POST', '/v1/auth/recovery/start', { email });
  const unknown = await call('POST', '/v1/auth/recovery/start', { email: `nobody-${tag}@example.invalid` });
  check(known.status === 202 && unknown.status === 202,
    'POST /v1/auth/recovery/start answers 202 for both a real and an unknown address',
    `${known.status} / ${unknown.status}`);
  check(JSON.stringify({ ...known.body, correlationId: null })
    === JSON.stringify({ ...unknown.body, correlationId: null }),
    'and the two bodies are byte-identical apart from the correlation id',
    `${JSON.stringify(known.body)} vs ${JSON.stringify(unknown.body)}`);

  // The reset token is delivered by mail, and P1 has no mailer wired. Taking it from the
  // service is this test's inbox — the ROUTE under test is `recovery/complete` below, and it
  // is driven over the socket like any client would.
  const { recoveryToken } = await app.deps.auth.service.recoveryStart({ email });
  check(typeof recoveryToken === 'string' && recoveryToken.length > 0,
    'control: a reset token exists to complete with');

  const NEW_PW = 'a brand new passphrase entirely';
  const done = await call('POST', '/v1/auth/recovery/complete',
    { token: recoveryToken, newPassword: NEW_PW });
  check(done.status === 204, 'POST /v1/auth/recovery/complete answers 204',
    `${done.status} ${done.body?.error?.code ?? ''}`);
  const clearedRecovery = setCookies(done).find((c) => c.startsWith('os_rt=')) ?? '';
  check(/^os_rt=;/.test(clearedRecovery),
    'and it clears the refresh cookie — recovery ends every session including this one',
    JSON.stringify(setCookies(done)));

  const withNew = await call('POST', '/v1/auth/signin', { email, password: NEW_PW });
  check(withNew.status === 200, 'the NEW password signs in',
    `${withNew.status} ${withNew.body?.error?.code ?? ''}`);
});

// ── 7d-ii-b. the reset REPLACED the password, and the token is spent ──────────────────
//
// A separate app, and therefore a separate rate limiter: §9's auth class is 10/min per IP and
// every request in this file arrives from 127.0.0.1, so these two assertions were being
// answered by the limiter rather than by the routes they are about.
await withApp(async ({ call, app }) => {
  section('recovery replaces the password and spends the token');
  const tag = Date.now().toString(36).slice(-6);
  const email = `spent-${tag}@example.invalid`;
  const { signup } = await onboard(call, {
    sid: '01M0EFV571B7VBQCNXHAT5WTD7', name: `Spnt${tag}`, email,
  });
  check(signup.status === 201, 'control: the subject is signed up', JSON.stringify(signup.body?.error));

  const bad = await call('POST', '/v1/auth/recovery/complete',
    { token: 'not-a-real-reset-token', newPassword: 'a brand new passphrase' });
  check(bad.status === 400 && bad.body?.error?.code === 'AUTH_RECOVERY_TOKEN_INVALID',
    'POST /v1/auth/recovery/complete refuses a token it never issued',
    `${bad.status} ${bad.body?.error?.code}`);

  // The inbox again: P1 wires no mailer, and the route under test is the completion.
  const { recoveryToken } = await app.deps.auth.service.recoveryStart({ email });
  const NEW_PW = 'a completely different passphrase';
  const done = await call('POST', '/v1/auth/recovery/complete',
    { token: recoveryToken, newPassword: NEW_PW });
  check(done.status === 204, 'control: the reset completes',
    `${done.status} ${done.body?.error?.code ?? ''}`);

  const withOld = await call('POST', '/v1/auth/signin', { email, password: PW });
  check(withOld.status === 401 && withOld.body?.error?.code === 'AUTH_INVALID_CREDENTIALS',
    'the OLD password no longer signs in — the reset actually replaced it',
    `${withOld.status} ${withOld.body?.error?.code}`);
  const withNew = await call('POST', '/v1/auth/signin', { email, password: NEW_PW });
  check(withNew.status === 200,
    'CONTROL: the new one does, so the refusal above is not the account being broken',
    `${withNew.status} ${withNew.body?.error?.code ?? ''}`);

  const reused = await call('POST', '/v1/auth/recovery/complete',
    { token: recoveryToken, newPassword: 'yet another passphrase entirely' });
  check(reused.status === 400 && reused.body?.error?.code === 'AUTH_RECOVERY_TOKEN_INVALID',
    'a reset token is SINGLE USE — the second presentation is refused',
    `${reused.status} ${reused.body?.error?.code}`);
});

// ── 7d-iii. onboarding: GET consent, verification, terms ──────────────────────────────
await withApp(async ({ call, app }) => {
  section('onboarding read/verify/terms routes over a real socket');
  const tag = Date.now().toString(36).slice(-6);
  const sid = '01M0EFV571B7VBQCNXHAT5WTD6';

  // ── GET /v1/onboarding/consent, signed out ── the auth-OPTIONAL route.
  const undecided = await call('GET', '/v1/onboarding/consent?clientSessionId=01M0EFV571B7VBQCNXHAT5WTD9');
  check(undecided.status === 200 && undecided.body?.telemetryPersonal === null
    && undecided.body?.receipt === null,
    'GET /v1/onboarding/consent reports an UNDECIDED session as null, not as a refusal',
    JSON.stringify(undecided.body));

  const put = await call('PUT', '/v1/onboarding/consent',
    { telemetryPersonal: true, policyVersion: 1, clientSessionId: sid });
  check(put.status === 200, 'control: a decision is recorded', JSON.stringify(put.body?.error));
  const got = await call('GET', `/v1/onboarding/consent?clientSessionId=${sid}`);
  check(got.status === 200 && got.body?.telemetryPersonal === true
    && got.body?.subject === 'client-session' && typeof got.body?.receipt === 'string',
    'and GET reads it back with a REISSUED receipt for the same session',
    JSON.stringify(got.body));

  const email = `onboard-${tag}@example.invalid`;
  const { signup } = await onboard(call, { sid, name: `Onbd${tag}`, email });
  const token = signup.body?.accessToken;
  check(signup.status === 201 && typeof token === 'string',
    'control: the subject is signed up', JSON.stringify(signup.body?.error));

  // Signed IN, the same route answers about the ACCOUNT rather than the client session.
  const mine = await call('GET', '/v1/onboarding/consent', undefined, { authorization: `Bearer ${token}` });
  check(mine.status === 200 && mine.body?.subject === 'account' && mine.body?.telemetryPersonal === true,
    'GET /v1/onboarding/consent answers about the ACCOUNT when authenticated',
    JSON.stringify(mine.body));

  // ── verification ──
  check(signup.body?.profile?.emailVerifiedAt === null,
    'control: a new account is unverified', JSON.stringify(signup.body?.profile?.emailVerifiedAt));
  const anonResend = await call('POST', '/v1/onboarding/verify/resend', {});
  check(anonResend.status === 401 && anonResend.body?.error?.code === 'AUTH_REQUIRED',
    'POST /v1/onboarding/verify/resend requires a caller',
    `${anonResend.status} ${anonResend.body?.error?.code}`);

  const resend = await call('POST', '/v1/onboarding/verify/resend', {}, { authorization: `Bearer ${token}` });
  check(resend.status === 202, 'POST /v1/onboarding/verify/resend answers 202',
    `${resend.status} ${resend.body?.error?.code ?? ''}`);
  check(JSON.stringify(resend.body ?? {}).includes('verificationToken') === false,
    'and the token is NOT in the response — it goes to the mailer, not the caller',
    JSON.stringify(resend.body));

  const badVerify = await call('POST', '/v1/onboarding/verify/complete',
    { token: 'not-a-real-verification-token' }, { authorization: `Bearer ${token}` });
  check(badVerify.status === 400 && badVerify.body?.error?.code === 'AUTH_VERIFICATION_TOKEN_INVALID',
    'POST /v1/onboarding/verify/complete refuses a token it never issued',
    `${badVerify.status} ${badVerify.body?.error?.code}`);

  // Again the mailer's job stands in for an inbox; the route below is driven over the socket.
  const actor = await app.deps.auth.sessions.authenticate(token);
  const { verificationToken } = await app.deps.auth.service.verificationResend({ actor });
  const verified = await call('POST', '/v1/onboarding/verify/complete',
    { token: verificationToken }, { authorization: `Bearer ${token}` });
  check(verified.status === 204, 'POST /v1/onboarding/verify/complete answers 204',
    `${verified.status} ${verified.body?.error?.code ?? ''}`);
  // http-api.md §11.8 closes the public profile body to five keys, and `emailVerifiedAt` is
  // not one of them — so the state change is read from the row, not from the projection.
  const accountId = signup.body?.profile?.accountId;
  const row = await app.deps.store.accounts.byId(accountId);
  check(typeof row?.emailVerifiedAt === 'string',
    'and the account is now VERIFIED — the route changed state, not just its status code',
    JSON.stringify(row?.emailVerifiedAt));

  // ── terms ──
  const terms = await call('GET', '/v1/onboarding/terms');
  check(terms.status === 200 && typeof terms.body?.version === 'number'
    && typeof terms.body?.url === 'string' && typeof terms.body?.publishedAt === 'string',
    'GET /v1/onboarding/terms is public and returns version, url and publishedAt',
    JSON.stringify(terms.body));

  const stale = await call('POST', '/v1/onboarding/terms/accept',
    { version: terms.body.version + 1 }, { authorization: `Bearer ${token}` });
  check(stale.status === 409 && stale.body?.error?.code === 'CONFLICT',
    'POST /v1/onboarding/terms/accept refuses a version that is not the current one',
    `${stale.status} ${stale.body?.error?.code}`);
  check(stale.body?.error?.details?.currentVersion === terms.body.version,
    'and it tells the client which version to re-present',
    JSON.stringify(stale.body?.error?.details));

  const accepted = await call('POST', '/v1/onboarding/terms/accept',
    { version: terms.body.version }, { authorization: `Bearer ${token}` });
  check(accepted.status === 204, 'POST /v1/onboarding/terms/accept answers 204',
    `${accepted.status} ${accepted.body?.error?.code ?? ''}`);
  const afterRow = await app.deps.store.accounts.byId(accountId);
  check(afterRow?.termsVersionAccepted === terms.body.version,
    'and the acceptance is recorded on the account',
    JSON.stringify(afterRow?.termsVersionAccepted));
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
