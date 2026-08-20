/**
 * coretest — the HTTP core and the core rate limiter.  platform/src/core/http.js,
 * platform/src/core/ratelimit.js.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────────────────
 * A mutation sweep deleted every guard in `platform/src/**` one at a time and re-ran the
 * suite. 146 of 253 deletions changed nothing that any test could see. Three of the worst
 * lived in `core/http.js`, the file every request in the platform passes through:
 *
 *   1. `buildBelowFloor`'s `if (x !== y) return x < y;` — delete it and the comparator
 *      returns `false` for every pair, so the §1 build floor is off. `PLATFORM_MIN_CLIENT_BUILD
 *      =2.0.0` served build `1.9.9` a 200. The suite stayed green because the ONLY test of
 *      numeric floor comparison drove `createStubApi`, and the stub layer held a VERBATIM
 *      COPY of the comparator under a comment claiming it matched this file. The test asserted
 *      against the copy. The original — the one production runs — had no test at all.
 *      That duplication is now deleted: `gates.js` imports `buildBelowFloor`, and the cases
 *      below drive the exported function and a real socket, not a fixture.
 *   2. `readJson`'s `size > MAX_BODY_BYTES` — delete it and an 8 MB body is buffered and
 *      ANSWERED 200 instead of 413.
 *   3. `Router.match`'s `decoded.includes('/')` — delete it and `GET /v1/profile/abc%2F..%2Fdef`
 *      matches, with `accountId` = `abc/../def`. A separator smuggled through a value the
 *      router promised was one segment.
 *
 * And `core/ratelimit.js` had ZERO test hits under V8 coverage — `checkAuth`, `sweep` and
 * `size` were never executed by anything.
 *
 * Every claim here is paired with a control that would pass if the rule were absent, and each
 * was watched to FAIL with its guard deleted before being written down.
 *
 * Run: `node platform/test/coretest.mjs`
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Router, createApp, buildBelowFloor, isWellFormedBuild } from '../src/core/http.js';
import { createRateLimiter, CLASSES } from '../src/core/ratelimit.js';
import { ApiError } from '../src/core/errors.js';
import { checkClientBuild } from '../src/modules/stubs/gates.js';
import { loadConfig } from '../src/core/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const check = (cond, n, d = '') => (cond ? ok(n) : bad(n, d));
const section = (n) => console.log(`\n--- ${n} ---`);

const silent = () => { const noop = () => {}; return { debug: noop, info: noop, warn: noop, error: noop }; };

/**
 * Stand a REAL `createApp` server on a real socket.
 *
 * Port 0 and ask the OS what it gave us — fixed ports made apptest and stubtest collide
 * intermittently, and a flaky suite teaches everyone to re-run instead of to look.
 *
 * The router carries a `handlerCalls` log, because "the request was refused" and "the request
 * reached the handler and the handler happened to say no" are different facts and a status
 * code alone cannot tell them apart.
 */
async function withServer(config, fn) {
  const handlerCalls = [];
  const router = new Router();

  // Public echo: whatever the router decided the params were, spoken back verbatim. This is
  // the one route that can prove a smuggled separator never became a parameter value.
  router.get('/v1/probe/:accountId', async (ctx) => {
    handlerCalls.push({ path: ctx.path, params: ctx.params });
    return { accountId: ctx.params.accountId };
  });

  // The production ordering: routing first, auth middleware second. A path parameter refused
  // during MATCHING never reaches this middleware, so 400-vs-401 says which stage refused.
  router.get('/v1/profile/:accountId', async (ctx) => {
    handlerCalls.push({ path: ctx.path, params: ctx.params });
    return { accountId: ctx.params.accountId };
  }, {
    middleware: [async (ctx) => {
      if (!ctx.headers.authorization) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
    }],
  });

  router.post('/v1/echo', async (ctx) => {
    handlerCalls.push({ path: ctx.path, bytes: JSON.stringify(ctx.body).length });
    return { keys: Object.keys(ctx.body).length };
  });

  // §1's exemption, in core/http.js itself rather than in a fixture that says it copies it.
  router.get('/v1/health', async () => ({ ok: true }), { requireBuild: false });

  const server = createApp({ router, deps: { logger: silent(), config } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { body, headers = {}, rawBody } = {}) => {
    let res;
    try {
      res = await fetch(base + path, {
      method,
      // `connection: close` deliberately. When the body cap fires the server answers 413
      // WITHOUT draining the rest of the request, which is the whole point — the bytes must
      // not be buffered. A kept-alive socket then still has an unread body on it and the next
      // request over that connection hangs. Each call here gets its own connection so the
      // suite measures the response and not undici's pooling.
      headers: { 'x-client-build': '1.0.0', connection: 'close', ...headers },
      body: rawBody !== undefined ? rawBody : (body === undefined ? undefined : JSON.stringify(body)),
      });
    } catch (err) {
      // A refusal that lands before the request finished uploading closes the socket, and
      // undici surfaces that as a transport failure rather than a status. Reported as data so
      // a test can say which outcomes it accepts — never swallowed into a pass.
      return { status: null, body: null, text: '', transportFailed: true,
        transportError: String(err?.cause?.code || err?.message || err) };
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* the test will say so */ }
    return { status: res.status, body: json, text, transportFailed: false };
  };

  try { return await fn({ call, handlerCalls }); }
  finally { await new Promise((r) => server.close(r)); }
}

const NO_FLOOR = { minClientBuild: null, trustedProxyHops: 0 };

// =============================================================================================
section('Router.match — an encoded slash is not a path separator (core/http.js:72)');
// =============================================================================================
{
  // The unit, with no server in the way. Deleting the `decoded.includes('/')` line turns each
  // of these from a throw into a match.
  const r = new Router();
  r.get('/v1/profile/:accountId', async () => ({}));

  const throws = (pathname) => {
    try { r.match('GET', pathname); return null; }
    catch (err) { return err; }
  };

  const smuggled = throws('/v1/profile/abc%2F..%2Fdef');
  check(smuggled instanceof ApiError && smuggled.code === 'VALIDATION_FAILED',
    'an encoded slash in a path parameter is VALIDATION_FAILED, not a match',
    `${smuggled && smuggled.code}`);

  const traversal = throws('/v1/profile/..%2F..%2Fetc%2Fpasswd');
  check(traversal instanceof ApiError && traversal.code === 'VALIDATION_FAILED',
    'a traversal-shaped parameter (..%2F..%2Fetc%2Fpasswd) is refused', `${traversal && traversal.code}`);

  const upper = throws('/v1/profile/abc%2f..%2fdef');
  check(upper instanceof ApiError && upper.code === 'VALIDATION_FAILED',
    'lowercase %2f is refused too — the check reads the decoded value, not the spelling',
    `${upper && upper.code}`);

  const doubled = throws('/v1/profile/a%2F%2Fb');
  check(doubled instanceof ApiError && doubled.code === 'VALIDATION_FAILED',
    'two encoded slashes are refused', `${doubled && doubled.code}`);

  const malformed = throws('/v1/profile/%ZZ');
  check(malformed instanceof ApiError && malformed.code === 'VALIDATION_FAILED',
    'a malformed percent-escape is a client error, not a 500', `${malformed && malformed.code}`);

  // CONTROLS. Without these the checks above would pass for a router that refuses everything,
  // or for one that simply banned the percent sign.
  const plain = r.match('GET', '/v1/profile/abc');
  check(plain !== null && plain.params.accountId === 'abc',
    'CONTROL: an ordinary segment still matches and yields its value', JSON.stringify(plain && plain.params));

  const encoded = r.match('GET', '/v1/profile/a%2Db%20c');
  check(encoded !== null && encoded.params.accountId === 'a-b c',
    'CONTROL: percent-decoding still happens for escapes that are not separators',
    JSON.stringify(encoded && encoded.params));
}

// =============================================================================================
section('the same hole over a real socket');
// =============================================================================================
await withServer(NO_FLOOR, async ({ call, handlerCalls }) => {
  const smuggled = await call('GET', '/v1/profile/abc%2F..%2Fdef', { headers: { authorization: 'Bearer x' } });
  // The reported flip is 400 -> 401: with the guard gone the route MATCHES and the request
  // travels on to auth. Asserting 400 specifically is what distinguishes "refused while
  // routing" from "refused later, for some other reason".
  check(smuggled.status === 400 && smuggled.body?.error?.code === 'VALIDATION_FAILED',
    'GET /v1/profile/abc%2F..%2Fdef is 400 VALIDATION_FAILED — refused while routing',
    `${smuggled.status}/${smuggled.body?.error?.code}`);

  const noAuth = await call('GET', '/v1/profile/abc%2F..%2Fdef');
  check(noAuth.status === 400 && noAuth.body?.error?.code === 'VALIDATION_FAILED',
    'and it is 400 even with no credential — routing refuses before auth is consulted',
    `${noAuth.status}/${noAuth.body?.error?.code}`);

  const echoed = await call('GET', '/v1/probe/abc%2F..%2Fdef');
  check(echoed.status === 400 && !handlerCalls.some((c) => c.path.startsWith('/v1/probe')),
    'the smuggled value never reaches a handler on a route with no auth to stop it',
    `${echoed.status} calls=${JSON.stringify(handlerCalls)}`);
  check(!JSON.stringify(echoed.body).includes('abc/../def'),
    'the decoded separator is not echoed back anywhere in the response', echoed.text);

  // CONTROL: the identical route, identical shape, no encoded separator.
  const control = await call('GET', '/v1/probe/abc..def');
  check(control.status === 200 && control.body.accountId === 'abc..def',
    'CONTROL: dots without a separator are an ordinary value, served 200',
    `${control.status}/${JSON.stringify(control.body)}`);

  const authControl = await call('GET', '/v1/profile/abc');
  check(authControl.status === 401 && authControl.body?.error?.code === 'AUTH_REQUIRED',
    'CONTROL: a well-formed parameter reaches auth, which is where 401 comes from',
    `${authControl.status}/${authControl.body?.error?.code}`);
});

// =============================================================================================
section('readJson — the body cap is enforced as bytes arrive (core/http.js:113)');
// =============================================================================================
await withServer(NO_FLOOR, async ({ call, handlerCalls }) => {
  // MAX_BODY_BYTES is 256 KB. Deleting the cap buffers whatever arrives and answers 200.
  const oversize = JSON.stringify({ pad: 'x'.repeat(400 * 1024) });
  const big = await call('POST', '/v1/echo', {
    rawBody: oversize, headers: { 'content-type': 'application/json' },
  });
  check(big.status === 413 && big.body?.error?.code === 'PAYLOAD_TOO_LARGE',
    'a 400 KB body is 413 PAYLOAD_TOO_LARGE', `${big.status}/${big.body?.error?.code}`);
  check(!handlerCalls.some((c) => c.path === '/v1/echo'),
    'the oversize body never reached a handler', JSON.stringify(handlerCalls));

  // The size the mutation report used. The cap fires 32 times before the body has finished
  // arriving, so the sender may well see its socket cut mid-write rather than read a 413 —
  // which is the bound doing its job, not a flake. What must NEVER happen is the 200 the
  // deleted guard produced, and what must never happen is the handler running.
  const huge = await call('POST', '/v1/echo', {
    rawBody: JSON.stringify({ pad: 'x'.repeat(8 * 1024 * 1024) }),
    headers: { 'content-type': 'application/json' },
  });
  check(huge.status === 413 || huge.transportFailed === true,
    'an 8 MB body is refused — 413, or the socket cut before it finished arriving; never 200',
    `${huge.status}/${huge.body?.error?.code}/${huge.transportError || ''}`);
  check(!handlerCalls.some((c) => c.path === '/v1/echo'),
    'the 8 MB body never reached a handler either', JSON.stringify(handlerCalls));

  // CONTROL: a body comfortably under the cap is accepted and parsed, so the rejections above
  // are about the SIZE and not about POST bodies being broken.
  const small = await call('POST', '/v1/echo', {
    body: { pad: 'x'.repeat(200 * 1024) }, headers: { 'content-type': 'application/json' },
  });
  check(small.status === 200 && small.body.keys === 1,
    'CONTROL: a 200 KB body is accepted and parsed', `${small.status}/${JSON.stringify(small.body)}`);
  check(handlerCalls.some((c) => c.path === '/v1/echo' && c.bytes > 200 * 1024),
    'CONTROL: the handler actually received the whole under-cap body', JSON.stringify(handlerCalls));
});

// =============================================================================================
section('buildBelowFloor — the production comparator, driven directly (core/http.js:163)');
// =============================================================================================
{
  // Deleting `if (x !== y) return x < y;` makes every one of these `false`. Four of the seven
  // expect `true`, so the deletion cannot hide here.
  const cases = [
    ['1.9.9', '2.0.0', true, 'a build below the floor is below it'],
    ['2.0.0', '2.0.0', false, 'the floor itself is not below the floor'],
    ['2.0.1', '2.0.0', false, 'a patch above the floor passes'],
    ['1.2.0', '1.10.0', true, '1.2.0 is BELOW 1.10.0 — numerically, not as strings'],
    ['1.10.0', '1.2.0', false, '1.10.0 is ABOVE 1.2.0 — the string comparison said otherwise'],
    ['2', '2.0.1', true, 'a short build is padded with zeros, not treated as equal'],
    ['2.0.1', '2', false, 'and a longer build above a short floor passes'],
  ];
  for (const [build, floor, expected, label] of cases) {
    const got = buildBelowFloor(build, floor);
    check(got === expected, `${label} (${build} vs ${floor})`, `expected ${expected}, got ${got}`);
  }

  check(isWellFormedBuild('1.10.0') && !isWellFormedBuild('2garbage')
    && !isWellFormedBuild('') && !isWellFormedBuild(undefined),
  'isWellFormedBuild accepts dot-separated integers and nothing else');
}

// =============================================================================================
section('the build floor over a real socket, with a real config');
// =============================================================================================
{
  // The env var an operator actually sets, through the real loader — so "the floor is
  // configured" is not an assumption this file makes about its own literal.
  const configured = loadConfig({ ...process.env, PLATFORM_MIN_CLIENT_BUILD: '2.0.0', PLATFORM_PORT: '0' });
  check(configured.minClientBuild === '2.0.0',
    'PLATFORM_MIN_CLIENT_BUILD reaches config.minClientBuild', String(configured.minClientBuild));

  await withServer(configured, async ({ call, handlerCalls }) => {
    const below = await call('GET', '/v1/probe/x', { headers: { 'x-client-build': '1.9.9' } });
    check(below.status === 426 && below.body?.error?.code === 'UNSUPPORTED_CLIENT'
      && below.body.error.details?.reason === 'build',
    'X-Client-Build 1.9.9 under a 2.0.0 floor is 426 UNSUPPORTED_CLIENT',
    `${below.status}/${below.body?.error?.code}`);
    check(!handlerCalls.length, 'the under-floor request never reached a handler',
      JSON.stringify(handlerCalls));

    const equal = await call('GET', '/v1/probe/x', { headers: { 'x-client-build': '2.0.0' } });
    check(equal.status === 200, 'CONTROL: the floor build itself is served', `${equal.status}`);

    // The string-comparison trap, end to end: '2.10.0' < '2.9.0' as strings.
    const tenth = await call('GET', '/v1/probe/x', { headers: { 'x-client-build': '2.10.0' } });
    check(tenth.status === 200 && tenth.body.accountId === 'x',
      'CONTROL: 2.10.0 is above the 2.0.0 floor and is served', `${tenth.status}`);

    const absent = await call('GET', '/v1/probe/x', { headers: { 'x-client-build': undefined } });
    check(absent.status === 426, 'a request with no X-Client-Build is refused, not exempted',
      `${absent.status}`);

    const junk = await call('GET', '/v1/probe/x', { headers: { 'x-client-build': '2garbage' } });
    check(junk.status === 426, 'a numeric prefix does not sail past the floor', `${junk.status}`);

    const health = await call('GET', '/v1/health', { headers: { 'x-client-build': undefined } });
    check(health.status === 200,
      'requireBuild:false exempts /v1/health in core/http.js itself — a probe has no build',
      `${health.status}`);
  });

  // A floor nobody can parse fails CLOSED. "No floor" would silently disable the gate.
  await withServer({ minClientBuild: 'two-point-oh', trustedProxyHops: 0 }, async ({ call }) => {
    const res = await call('GET', '/v1/probe/x', { headers: { 'x-client-build': '9.9.9' } });
    check(res.status === 503 && res.body?.error?.code === 'SERVICE_UNAVAILABLE'
      && res.body.error.details?.reason === 'floor-malformed',
    'a malformed floor is 503, not "no floor"', `${res.status}/${res.body?.error?.code}`);
  });

  // CONTROL: with no floor configured the header is still REQUIRED, but every well-formed
  // build passes — so the refusals above are the floor and not the header check twice.
  await withServer(NO_FLOOR, async ({ call }) => {
    const old = await call('GET', '/v1/probe/x', { headers: { 'x-client-build': '0.0.1' } });
    check(old.status === 200, 'CONTROL: with no floor, an ancient build is served', `${old.status}`);
    const none = await call('GET', '/v1/probe/x', { headers: { 'x-client-build': undefined } });
    check(none.status === 426, 'with no floor, a MISSING build is still refused', `${none.status}`);
  });
}

// =============================================================================================
section('one comparator, not two — the stub layer must not re-implement it');
// =============================================================================================
{
  // The defect this section exists to prevent is not a wrong answer; it is a SECOND answer.
  // gates.js held a verbatim copy of buildBelowFloor under a comment claiming it matched
  // core/http.js, and the only floor test in the suite asserted against the copy.
  const gatesSrc = readFileSync(join(ROOT, 'platform/src/modules/stubs/gates.js'), 'utf8');
  check(/import\s*\{[^}]*\bbuildBelowFloor\b[^}]*\}\s*from\s*'\.\.\/\.\.\/core\/http\.js'/.test(gatesSrc),
    'gates.js imports buildBelowFloor from core/http.js');
  check(!/function\s+\w*[bB]elowFloor\s*\(/.test(gatesSrc),
    'gates.js defines no floor comparator of its own');

  // And the behavioural version, which survives a rename the regexes would not catch: for
  // every pair, the stub gate refuses exactly when the core comparator says "below".
  const pairs = [['1.9.9', '2.0.0'], ['2.0.0', '2.0.0'], ['1.10.0', '1.2.0'], ['1.2.0', '1.10.0'],
    ['2', '2.0.1'], ['2.0.1', '2'], ['10.0.0', '9.99.99']];
  let agree = true;
  const disagreements = [];
  for (const [build, floor] of pairs) {
    let refused = false;
    try { checkClientBuild({ 'x-client-build': build }, { minClientBuild: floor }); }
    catch { refused = true; }
    const core = buildBelowFloor(build, floor);
    if (refused !== core) { agree = false; disagreements.push(`${build} vs ${floor}: stub=${refused} core=${core}`); }
  }
  check(agree, 'the stub gate and the core comparator agree on every pair', disagreements.join('; '));
}

// =============================================================================================
section('core/ratelimit.js — check()');
// =============================================================================================
{
  let now = 1_000_000;
  const rl = createRateLimiter({ clock: () => now });

  const read = CLASSES.read.perMin;
  const verdicts = Array.from({ length: read }, () => rl.check('read', 'acct-1'));
  check(verdicts.every((v) => v.allowed === true && v.retryAfterMs === null),
    `the first ${read} reads are allowed with no retry hint`,
    JSON.stringify(verdicts.filter((v) => !v.allowed)));

  const denied = rl.check('read', 'acct-1');
  check(denied.allowed === false && denied.retryAfterMs === 60_000,
    'the request over the per-minute cap is denied with a full window to wait',
    JSON.stringify(denied));

  // Separate subjects are separate budgets, or one noisy account rate-limits the platform.
  const other = rl.check('read', 'acct-2');
  check(other.allowed === true, 'CONTROL: a different subject has its own budget', JSON.stringify(other));

  // Separate classes are separate budgets too.
  const write = rl.check('write', 'acct-1');
  check(write.allowed === true, 'CONTROL: a different class has its own budget', JSON.stringify(write));

  // The window SLIDES: it is not a fixed bucket that refills on the minute.
  now += 59_999;
  check(rl.check('read', 'acct-1').allowed === false,
    'one millisecond before the window expires the subject is still denied');
  now += 2;
  check(rl.check('read', 'acct-1').allowed === true,
    'once the oldest hit falls out of the window the subject is served again');

  // The `report` class carries its own hour-long window (spec.windowMs), not the 60 s default.
  let t = 5_000_000;
  const rl2 = createRateLimiter({ clock: () => t });
  for (let i = 0; i < CLASSES.report.perMin; i++) rl2.check('report', 'acct-1');
  const reportDenied = rl2.check('report', 'acct-1');
  check(reportDenied.allowed === false && reportDenied.retryAfterMs === 3_600_000,
    'the report class waits an hour, not a minute', JSON.stringify(reportDenied));
  t += 60_000;
  check(rl2.check('report', 'acct-1').allowed === false,
    'a minute later the report cap still holds — the class window is honoured');
  t += 3_600_000;
  check(rl2.check('report', 'acct-1').allowed === true,
    'and an hour later it is released');

  let threw = null;
  try { rl.check('no-such-class', 'x'); } catch (err) { threw = err; }
  check(threw instanceof Error && /unknown rate limit class/.test(threw.message),
    'an unknown class is a programming error and says so', String(threw));
}

// =============================================================================================
section('core/ratelimit.js — checkAuth() is two buckets, and either one denies');
// =============================================================================================
{
  // §9 specifies TWO auth limits. A single composite `ip+account` key meant rotating source
  // IPs multiplied the per-account budget: 200 IPs bought 2000 attempts against a stated cap
  // of 5. Both of these cases exist to make that regression impossible to reintroduce quietly.
  let now = 2_000_000;
  const rl = createRateLimiter({ clock: () => now });

  // The distributed attempt: one victim account, a fresh IP every time.
  const perAccount = CLASSES.authAccount.perMin;
  const spread = Array.from({ length: perAccount }, (_, i) =>
    rl.checkAuth({ ip: `198.51.100.${i}`, account: 'victim' }));
  check(spread.every((v) => v.allowed === true),
    `the first ${perAccount} attempts on one account are allowed`, JSON.stringify(spread));

  const botnet = rl.checkAuth({ ip: '198.51.100.99', account: 'victim' });
  check(botnet.allowed === false && botnet.retryAfterMs > 0,
    'a brand-new IP does NOT buy another attempt on an already-capped account',
    JSON.stringify(botnet));

  // CONTROL: it is the ACCOUNT that is capped, not the IPs. A different account from the same
  // fresh IP is served, so the denial above is the account bucket and not a global stall.
  const bystander = rl.checkAuth({ ip: '198.51.100.99', account: 'bystander' });
  check(bystander.allowed === true && bystander.retryAfterMs === null,
    'CONTROL: another account from that same IP is still served', JSON.stringify(bystander));

  // The single-host brute force: one IP, a different account every time, so the account
  // bucket can never be what stops it.
  let t = 3_000_000;
  const rl2 = createRateLimiter({ clock: () => t });
  const perIp = CLASSES.authIp.perMin;
  const hammer = Array.from({ length: perIp }, (_, i) =>
    rl2.checkAuth({ ip: '203.0.113.7', account: `enumerate-${i}` }));
  check(hammer.every((v) => v.allowed === true),
    `the first ${perIp} attempts from one IP are allowed`, JSON.stringify(hammer));

  const enumerated = rl2.checkAuth({ ip: '203.0.113.7', account: 'enumerate-999' });
  check(enumerated.allowed === false && enumerated.retryAfterMs > 0,
    'an eleventh account from the same IP is denied — enumeration is the IP bucket\'s job',
    JSON.stringify(enumerated));
  check(rl2.checkAuth({ ip: '203.0.113.8', account: 'enumerate-999' }).allowed === true,
    'CONTROL: the same account from a different IP is served — that denial was the IP bucket');

  // Order matters: when the IP bucket has already denied, the ACCOUNT bucket must not be
  // debited. Otherwise one attacker's exhausted IP silently eats a victim's five attempts and
  // locks the victim out of their own account.
  const refusedForVictim = rl2.checkAuth({ ip: '203.0.113.7', account: 'fresh-victim' });
  check(refusedForVictim.allowed === false,
    'a request on a fresh account from the exhausted IP is refused by the IP bucket',
    JSON.stringify(refusedForVictim));
  const remaining = [];
  for (let i = 0; i < CLASSES.authAccount.perMin; i++) {
    remaining.push(rl2.check('authAccount', 'fresh-victim').allowed);
  }
  check(remaining.every((a) => a === true),
    'the account bucket was untouched by the request the IP bucket refused',
    JSON.stringify(remaining));

  // A pre-auth attempt with no account yet (a signin whose email matched nothing) still burns
  // IP budget — otherwise the IP limit is bypassed by not naming an account.
  let u = 4_000_000;
  const rl3 = createRateLimiter({ clock: () => u });
  const anon = Array.from({ length: perIp }, () => rl3.checkAuth({ ip: '192.0.2.5' }));
  check(anon.every((v) => v.allowed === true), 'accountless attempts are allowed up to the IP cap');
  check(rl3.checkAuth({ ip: '192.0.2.5' }).allowed === false,
    'and are denied past it, so omitting the account is not a bypass');
  check(rl3.check('authAccount', 'unknown').allowed === true,
    'CONTROL: an accountless attempt never touched an account bucket');

  // No IP at all is keyed rather than skipped: `ip || 'unknown'`.
  let v = 6_000_000;
  const rl4 = createRateLimiter({ clock: () => v });
  for (let i = 0; i < perIp; i++) rl4.checkAuth({ ip: undefined, account: `a-${i}` });
  check(rl4.checkAuth({ ip: undefined, account: 'a-999' }).allowed === false,
    'a request with no derivable IP shares one bucket rather than escaping the limit');
}

// =============================================================================================
section('core/ratelimit.js — sweep() and size');
// =============================================================================================
{
  // `check` inserts a key per unique subject and removes none. 50k distinct IPv6 sources
  // retained ~21 MB, which is an inexpensive remote OOM on a 256 MB instance.
  let now = 7_000_000;
  const rl = createRateLimiter({ clock: () => now });

  check(rl.size === 0, 'a fresh limiter holds nothing', String(rl.size));

  for (let i = 0; i < 200; i++) rl.check('read', `sub-${i}`);
  check(rl.size === 200, 'one key per distinct subject', String(rl.size));

  // Two classes for one subject are two keys — the class is part of the identity.
  rl.check('write', 'sub-0');
  check(rl.size === 201, 'class and subject together make the key', String(rl.size));

  // CONTROL: a sweep inside the window drops nothing. Without this, "sweep empties the map"
  // would also pass for a sweep that deletes unconditionally.
  now += 30_000;
  rl.sweep();
  check(rl.size === 201, 'CONTROL: a sweep inside the window keeps every live key', String(rl.size));

  now += 30_001;
  rl.sweep();
  check(rl.size === 0, 'a sweep past the window releases every dead key', String(rl.size));

  // A subject that is still active must survive the sweep that clears the idle ones.
  now += 1;
  rl.check('read', 'idle');
  now += 59_000;
  rl.check('read', 'busy');
  now += 1_500;
  rl.sweep();
  check(rl.size === 1, 'the idle key is dropped and the busy one is kept', String(rl.size));
  check(rl.check('read', 'busy').allowed === true && rl.size === 1,
    'the surviving key is the busy subject, not a fresh insert', String(rl.size));

  // The sweep reads the per-class window, so an hour-window key is not swept on a minute.
  let t = 9_000_000;
  const rl2 = createRateLimiter({ clock: () => t });
  rl2.check('report', 'acct-1');
  rl2.check('read', 'acct-1');
  t += 61_000;
  rl2.sweep();
  check(rl2.size === 1, 'a 60 s class is swept at 61 s while the hour-long class is not',
    String(rl2.size));
  t += 3_600_000;
  rl2.sweep();
  check(rl2.size === 0, 'and the hour-long class is swept once its own window has passed',
    String(rl2.size));

  // The janitor is what calls sweep in a real process, and it must never hold the process
  // open. If it did, this suite would not exit.
  const rl3 = createRateLimiter({ clock: () => Date.now() });
  const stop = rl3.startJanitor(60_000);
  check(typeof stop === 'function', 'startJanitor returns its own stopper');
  stop();
}

console.log(failures ? `\n${failures} FAILED` : '\ncore http and rate limiting run clean');
process.exit(failures ? 1 : 0);
