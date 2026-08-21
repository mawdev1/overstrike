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
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  Router, createApp, buildBelowFloor, isWellFormedBuild, raw, withHeaders,
} from '../src/core/http.js';
import { createRateLimiter, CLASSES } from '../src/core/ratelimit.js';
import { ApiError, CODES, toApiError } from '../src/core/errors.js';
import {
  loadMigrations, planMigrations, runMigrations, migrateCli,
} from '../src/core/migrate.js';
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
async function withServer(config, fn, opts = {}) {
  const handlerCalls = [];
  const router = new Router();

  // Routes a section needs for its own claim, registered on the SAME real router. `opts.deps`
  // adds to what handlers receive — a real `createRateLimiter()` for the sections about §9,
  // never a fake, because a fake limiter proves the test can call one and nothing else.
  for (const [method, path, handler, routeOpts] of opts.routes || []) {
    router.add(method, path, async (ctx) => {
      handlerCalls.push({ path: ctx.path, params: ctx.params });
      return handler(ctx);
    }, routeOpts);
  }

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

  const server = createApp({ router, deps: { logger: opts.logger || silent(), config, ...opts.deps } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

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
    return { status: res.status, body: json, text, headers: res.headers, transportFailed: false };
  };

  try { return await fn({ call, handlerCalls, port, raw: (lines, o) => rawRequest(port, lines, o) }); }
  finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}

/**
 * Speak HTTP on a socket, byte for byte.
 *
 * `fetch` is a client that obeys the specification: it normalises `//evil.com/v1/health` before
 * it leaves, and it will not send a body on a GET. Both of those are exactly the request shapes
 * `parseTarget` and `readJson` exist to survive, so a test written with `fetch` cannot reach
 * them — the request under test is one a compliant client will not make.
 *
 * `body` is written verbatim and MAY be shorter than the declared Content-Length: that is how a
 * request that never finishes arriving is expressed, and `timedOut` is then the answer.
 */
function rawRequest(port, lines, { body = '', timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let text = '';
    let socket = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { socket?.destroy(); } catch { /* already gone */ }
      resolve(result);
    };
    const parse = (timedOut) => {
      const status = text.match(/^HTTP\/1\.[01] (\d{3})/);
      done({ timedOut, text, status: status ? Number(status[1]) : null });
    };
    const timer = setTimeout(() => parse(true), timeoutMs);
    socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`);
    });
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
      // Headers complete is enough: every assertion here is about the status line, and waiting
      // for the socket to close would hang on a keep-alive response.
      if (text.includes('\r\n\r\n')) { clearTimeout(timer); parse(false); }
    });
    socket.on('error', () => { clearTimeout(timer); parse(false); });
    socket.on('close', () => { clearTimeout(timer); parse(false); });
  });
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

/** Run `fn` and return whatever it threw, or null. Never returns a value on success. */
const caught = (fn) => { try { fn(); return null; } catch (err) { return err; } };
const caughtAsync = async (fn) => { try { await fn(); return null; } catch (err) { return err; } };

// =============================================================================================
section('core/config.js — the loader refuses what it cannot use');
// =============================================================================================
//
// Six of this file's seven guards survived deletion. Nothing in 1780 checks noticed that
// `PLATFORM_PORT=0x1F90` was accepted as 8080, that `PLATFORM_STORAGE=mysql` loaded, or that
// the production secrets stopped being required in production — the file whose entire stated
// purpose is "fails fast on anything missing or malformed rather than defaulting silently".
//
// `loadConfig` takes its source as an argument, so these drive the real loader with a literal
// environment. That is not a substitution: the source object IS the parameter the function is
// written to take, and `app.js` passes `process.env` into the same one.
{
  /** The environment a production process actually gets, minus whatever a case is removing. */
  const PROD = {
    NODE_ENV: 'production',
    PLATFORM_TOKEN_SECRET: 'a-sufficiently-long-production-secret-value',
    PLATFORM_MATCH_TICKET_SECRET: 'a-separate-production-match-ticket-secret',
    PLATFORM_MATCH_CONTROL_SECRET: 'a-separate-production-match-control-secret',
    PLATFORM_SERVICE_TOKEN: 'a-sufficiently-long-production-service-token',
    PLATFORM_MATCH_SERVER_URL: 'wss://match.example.invalid',
    PLATFORM_IDENTITY_PROVIDER: 'supabase',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    PLATFORM_MAIL_TRANSPORT: 'resend',
    PLATFORM_MAIL_FROM: 'accounts@example.invalid',
    PLATFORM_MAIL_API_KEY: 'test-resend-api-key',
  };

  // ── :36 — the secrets are required in PRODUCTION, and only there ──
  const noSecrets = caught(() => loadConfig({ NODE_ENV: 'production' }));
  check(noSecrets instanceof Error && Array.isArray(noSecrets.problems)
    && noSecrets.problems.includes('PLATFORM_TOKEN_SECRET is required in production')
    && noSecrets.problems.includes('PLATFORM_SERVICE_TOKEN is required in production'),
  'a production process with no signing secrets REFUSES to load config',
  JSON.stringify(noSecrets?.problems ?? String(noSecrets)));

  // The failure this prevents, spelled out: without the guard the loader hands back
  // `tokenSecret: null` and the process boots — signing with a null key in production.
  const half = caught(() => loadConfig({ ...PROD, PLATFORM_TOKEN_SECRET: undefined }));
  check(half instanceof Error && half.problems?.length === 1
    && half.problems[0] === 'PLATFORM_TOKEN_SECRET is required in production',
  'and it names exactly the one that is missing, not both',
  JSON.stringify(half?.problems ?? String(half)));

  const empty = caught(() => loadConfig({ ...PROD, PLATFORM_SERVICE_TOKEN: '' }));
  check(empty instanceof Error && empty.problems?.includes('PLATFORM_SERVICE_TOKEN is required in production'),
    'an EMPTY secret is a missing secret, not a secret',
    JSON.stringify(empty?.problems ?? String(empty)));

  // CONTROL 1: with both present, production loads — the refusals above are the guard and not
  // production being unloadable.
  const prod = loadConfig(PROD);
  check(prod.env === 'production' && prod.tokenSecret === PROD.PLATFORM_TOKEN_SECRET
    && prod.serviceToken === PROD.PLATFORM_SERVICE_TOKEN,
  'CONTROL: production with both secrets loads and carries them',
  JSON.stringify({ env: prod.env, secret: typeof prod.tokenSecret }));
  const badAlertScheme = caught(() => loadConfig({ ...PROD,
    PLATFORM_ALERT_WEBHOOK_URL: 'http://alerts.example.invalid/route' }));
  const badAlertUrl = caught(() => loadConfig({ ...PROD,
    PLATFORM_ALERT_WEBHOOK_URL: 'not-a-url' }));
  const goodAlert = loadConfig({ ...PROD,
    PLATFORM_ALERT_WEBHOOK_URL: 'https://alerts.example.invalid/secret-route' });
  check(/must use https/.test(badAlertScheme?.message || '')
    && /must be an absolute URL/.test(badAlertUrl?.message || '')
    && goodAlert.alertWebhookUrl.startsWith('https://'),
  'production alert routing accepts only an absolute HTTPS webhook');

  // CONTROL 2: outside production the same absence is fine, and is filled with a value nobody
  // could mistake for a real one. Without this control the check above passes for a loader that
  // demands the secrets everywhere, which would stop every developer.
  const dev = loadConfig({ NODE_ENV: 'development' });
  check(dev.tokenSecret === 'DEV-ONLY-INSECURE-TOKEN-SECRET-do-not-ship'
    && dev.serviceToken === 'DEV-ONLY-INSECURE-SERVICE-TOKEN-do-not-ship',
  'CONTROL: development fills the secrets with an obviously-fake value instead',
  JSON.stringify(dev.tokenSecret));

  // ── :46 — an integer is an integer, not whatever `Number()` will take ──
  for (const [raw, why] of [
    ['0x1F90', 'hex — `Number()` reads this as 8080 and the port silently moves'],
    ['1e4', 'exponent notation'],
    ['8090.5', 'a fraction is not a port'],
    ['', 'the empty string, which `Number()` calls 0'],
    ['  ', 'whitespace, which `Number()` also calls 0'],
    ['eight', 'plain nonsense'],
  ]) {
    const err = caught(() => loadConfig({ PLATFORM_PORT: raw }));
    // '' and '  ' take the absent branch / the regex branch respectively; both must refuse to
    // produce a number out of a string that is not one. The empty string is the DEFAULT branch,
    // so it is the one case here that legitimately loads — asserted as such below.
    if (raw === '') {
      check(err === null, 'an unset PLATFORM_PORT falls back to the default', String(err));
      continue;
    }
    check(err instanceof Error && /PLATFORM_PORT must be an integer/.test(err.message),
      `PLATFORM_PORT=${JSON.stringify(raw)} is refused (${why})`, String(err?.message).split('\n').join(' '));
  }
  // CONTROLS: the shapes an operator legitimately writes still load, including the surrounding
  // whitespace a YAML file adds and the 0 that means "let the OS choose".
  check(loadConfig({ PLATFORM_PORT: '8091' }).port === 8091, 'CONTROL: a plain integer loads');
  check(loadConfig({ PLATFORM_PORT: ' 8091 ' }).port === 8091, 'CONTROL: whitespace is trimmed, not refused');
  check(loadConfig({ PLATFORM_PORT: '0' }).port === 0, 'CONTROL: port 0 means "ask the OS" and is legal');

  // ── :50 — a value past 2^53 is out of range, and SAYS so ──
  //
  // Every int in SPEC is bounded, so deleting this line does not let the value through: it
  // falls to the min/max check one line down and is still refused. What it changes is the
  // sentence the operator reads at 3am — `PLATFORM_PORT is out of range: "99999999999999999999"`
  // becomes `PLATFORM_PORT must be <= 65535, got 100000000000000000000`, a number that is not
  // the one they typed and cannot be found in their config. That message is the guard's whole
  // observable effect, so it is what is asserted.
  const huge = caught(() => loadConfig({ PLATFORM_PORT: '99999999999999999999' }));
  check(huge instanceof Error
    && huge.problems?.some((p) => p === 'PLATFORM_PORT is out of range: "99999999999999999999"'),
  'a value past Number.MAX_SAFE_INTEGER is reported AS TYPED, not as the float it rounded to',
  JSON.stringify(huge?.problems ?? String(huge)));
  check(huge instanceof Error && !huge.problems.some((p) => /100000000000000000000/.test(p)),
    'and the rounded value never appears in the message',
    JSON.stringify(huge?.problems));

  // CONTROL: an in-range value at the same boundary loads, so the refusal is about the size.
  check(loadConfig({ PLATFORM_REFRESH_TTL: '86400' }).refreshTokenTtlSec === 86400,
    'CONTROL: a large but safe integer loads');

  // ── :55 — an enum takes its own values and nothing else ──
  const storage = caught(() => loadConfig({ PLATFORM_STORAGE: 'mysql' }));
  check(storage instanceof Error && /PLATFORM_STORAGE must be one of memory\|postgres/.test(storage.message),
    'PLATFORM_STORAGE=mysql is refused at load, not at the first query',
    String(storage?.message).split('\n').join(' '));
  const level = caught(() => loadConfig({ PLATFORM_LOG_LEVEL: 'verbose' }));
  check(level instanceof Error && /PLATFORM_LOG_LEVEL must be one of debug\|info\|warn\|error/.test(level.message),
    'PLATFORM_LOG_LEVEL=verbose is refused', String(level?.message).split('\n').join(' '));
  // Case matters: the values are literals, and `Memory` is not one of them.
  check(caught(() => loadConfig({ PLATFORM_STORAGE: 'Memory' })) instanceof Error,
    'the enum is compared literally — `Memory` is not `memory`');
  check(loadConfig({ PLATFORM_STORAGE: 'memory' }).storage === 'memory',
    'CONTROL: a listed value loads');

  // ── :59 — postgres without a URL is a configuration that cannot work ──
  const pgNoUrl = caught(() => loadConfig({ PLATFORM_STORAGE: 'postgres' }));
  check(pgNoUrl instanceof Error
    && pgNoUrl.problems?.includes('DATABASE_URL is required when PLATFORM_STORAGE=postgres'),
  'PLATFORM_STORAGE=postgres with no DATABASE_URL is refused',
  JSON.stringify(pgNoUrl?.problems ?? String(pgNoUrl)));
  check(caught(() => loadConfig({ PLATFORM_STORAGE: 'postgres', DATABASE_URL: '' })) instanceof Error,
    'an empty DATABASE_URL is a missing one');
  const pgOk = loadConfig({ PLATFORM_STORAGE: 'postgres', DATABASE_URL: 'postgres://u@h/db' });
  check(pgOk.storage === 'postgres' && pgOk.databaseUrl === 'postgres://u@h/db',
    'CONTROL: postgres WITH a URL loads', JSON.stringify(pgOk.storage));
  // CONTROL: the pairing is specific to postgres — memory does not need a URL.
  check(loadConfig({ PLATFORM_STORAGE: 'memory' }).databaseUrl === null,
    'CONTROL: memory storage needs no URL');

  // ── :68 — problems are THROWN, not collected and returned ──
  //
  // Delete this and every case above returns a config object with the bad values in it: the
  // whole file becomes a validator that reports to nobody. Each check above already fails in
  // that world; this one names the mechanism.
  const collected = caught(() => loadConfig({ PLATFORM_PORT: 'nope', PLATFORM_STORAGE: 'mysql' }));
  check(collected instanceof Error && collected.problems?.length === 2,
    'every problem is collected and reported at once, not one per boot attempt',
    JSON.stringify(collected?.problems ?? String(collected)));
  check(collected instanceof Error && /Invalid configuration:/.test(collected.message)
    && collected.problems.every((p) => collected.message.includes(p)),
  'and the message contains all of them', String(collected?.message).split('\n').join(' | '));

  // A loaded config is FROZEN: a caller cannot patch a value the loader validated.
  const frozen = loadConfig({});
  const before = frozen.port;
  try { frozen.port = 1; } catch { /* strict mode in a module: assignment throws */ }
  check(frozen.port === before && Object.isFrozen(frozen),
    'a loaded config is frozen, so a validated value cannot be replaced afterwards');
}

// =============================================================================================
section('core/errors.js — the envelope');
// =============================================================================================
{
  // :91 — a code that is not in the contract is a PROGRAMMING error and says so. Without the
  // line the constructor still fails, but with `Cannot read properties of undefined (reading
  // 'status')`, which sends the reader to the wrong file.
  const unknown = caught(() => new ApiError('NOT_A_REAL_CODE', 'x'));
  check(unknown instanceof Error && /ApiError: unknown code NOT_A_REAL_CODE/.test(unknown.message),
    'an unknown error code names itself and the code', String(unknown?.message));

  // CONTROL: every code the contract lists constructs, so the refusal above is about THIS code
  // and not about the constructor being broken.
  const unconstructable = Object.keys(CODES)
    .filter((code) => caught(() => new ApiError(code, 'm')) instanceof Error);
  check(unconstructable.length === 0, 'CONTROL: every code in contracts/errors.md constructs',
    unconstructable.join(', '));

  // :128 — an ApiError passes through `toApiError` unchanged. Wrapping it would turn every
  // contracted 4xx in the platform into a 500 INTERNAL_ERROR.
  const typed = new ApiError('NAME_TAKEN', 'taken');
  check(toApiError(typed) === typed && toApiError(typed).status === 409,
    'toApiError returns a contracted error unchanged, code and status intact',
    `${toApiError(typed).code}/${toApiError(typed).status}`);
  // CONTROL: something that is NOT one is wrapped, and the cause is kept off the envelope.
  const wrapped = toApiError(new TypeError('x is not a function'));
  check(wrapped.code === 'INTERNAL_ERROR' && wrapped.status === 500
    && wrapped.cause instanceof TypeError
    && !JSON.stringify(wrapped.toEnvelope('c')).includes('is not a function'),
  'CONTROL: an unexpected throw becomes INTERNAL_ERROR and the cause never reaches the envelope',
  JSON.stringify(wrapped.toEnvelope('c')));
}

// =============================================================================================
section('core/migrate.js — the runner refuses what would diverge the schema');
// =============================================================================================
//
// Six of twelve guards here survived deletion. `storetest.mjs` covers the Pool check and the
// live apply; nothing covered the three rules the file header states as its reason to exist —
// forward-only, checksum-verified, in order — and all three are pure functions that need no
// database at all.
{
  const tmpDirs = [];
  /** A migration directory on disk, because `loadMigrations` reads one. */
  const migrationDir = async (files) => {
    const dir = await mkdtemp(join(tmpdir(), 'overstrike-migrate-'));
    tmpDirs.push(dir);
    for (const [name, sql] of files) await writeFile(join(dir, name), sql);
    return dir;
  };
  const applied = (files, over = {}) => files.map((f) => ({
    version: f.version, name: f.name, checksum: f.checksum, ...over[f.version],
  }));

  // ── :43 — the filename IS the version, so a filename that does not state one is refused ──
  for (const name of ['1_init.sql', '0001-init.sql', '0001_Init.sql', 'init_0001.sql', '001_init.sql']) {
    const dir = await migrationDir([[name, 'select 1;']]);
    const err = await caughtAsync(() => loadMigrations(dir));
    check(err instanceof Error && /bad migration filename/.test(err.message),
      `${name} is refused with a message that states the wanted shape`, String(err?.message));
  }
  // CONTROL: the shape the rule describes loads, and yields the version and name it encodes.
  {
    const dir = await migrationDir([['0007_add_index.sql', 'create index x on y (z);']]);
    const files = await loadMigrations(dir);
    check(files.length === 1 && files[0].version === 7 && files[0].name === 'add_index'
      && /^[0-9a-f]{64}$/.test(files[0].checksum),
    'CONTROL: a well-named migration loads with its version, name and checksum',
    JSON.stringify(files[0] && { v: files[0].version, n: files[0].name }));
  }

  // ── :45 — two files claiming one version ──
  //
  // The merge of two branches that each added `0008_*.sql`. Without the guard both load, both
  // apply, and the schema depends on which sorted first — the exact divergence the header
  // describes, arriving silently.
  {
    const dir = await migrationDir([
      ['0008_add_column.sql', 'alter table a add column b int;'],
      ['0008_add_table.sql', 'create table c (d int);'],
    ]);
    const err = await caughtAsync(() => loadMigrations(dir));
    check(err instanceof Error && /duplicate migration version 0008/.test(err.message),
      'two migrations numbered 0008 are refused, naming the number', String(err?.message));
  }
  // CONTROL: distinct numbers in the same directory load, sorted by version and not by string.
  {
    const dir = await migrationDir([
      ['0002_b.sql', 'select 2;'], ['0010_c.sql', 'select 10;'], ['0001_a.sql', 'select 1;'],
    ]);
    const files = await loadMigrations(dir);
    check(files.map((f) => f.version).join(',') === '1,2,10',
      'CONTROL: distinct versions load in numeric order (10 after 2, not before)',
      files.map((f) => f.version).join(','));
  }

  // ── planMigrations: the three rules, on a real file set ──
  const dir = await migrationDir([
    ['0001_a.sql', 'select 1;'], ['0002_b.sql', 'select 2;'], ['0004_d.sql', 'select 4;'],
  ]);
  const files = await loadMigrations(dir);

  // :93 — the database is AHEAD of the checkout. Rolling back a deploy past a migration is how
  // a schema and the code that reads it stop matching, and the runner has to say which way.
  const ahead = caught(() => planMigrations(files, [
    ...applied(files), { version: 9, name: 'from_the_future', checksum: 'x' },
  ]));
  check(ahead instanceof Error && /migration 9 \(from_the_future\) which this checkout does not/.test(ahead.message)
    && /roll forward, do not roll back/.test(ahead.message),
  'a database holding a migration this checkout lacks refuses, and says roll forward',
  String(ahead?.message));

  // :98 — an APPLIED migration was edited afterwards.
  const edited = caught(() => planMigrations(files, applied(files, { 2: { checksum: 'deadbeef' } })));
  check(edited instanceof Error && /0002_b\.sql has changed since it was applied/.test(edited.message)
    && /a correction is a new migration, never an edit/.test(edited.message),
  'an edited migration is caught by checksum and names the file',
  String(edited?.message));

  // :106 — nothing pending is an empty plan, not a crash and not a re-apply.
  let nothing = 'it threw';
  try { nothing = planMigrations(files, applied(files)); } catch (err) { nothing = String(err.message); }
  check(Array.isArray(nothing) && nothing.length === 0,
    'a database that is fully up to date plans nothing',
    JSON.stringify(nothing));

  // :110 — a migration numbered BELOW the highest applied one.
  const late = await migrationDir([
    ['0001_a.sql', 'select 1;'], ['0002_b.sql', 'select 2;'],
    ['0003_c.sql', 'select 3;'], ['0004_d.sql', 'select 4;'],
  ]);
  const withThree = await loadMigrations(late);
  const outOfOrder = caught(() => planMigrations(withThree, applied(files)));
  check(outOfOrder instanceof Error
    && /0003_c\.sql is older than applied migration 4/.test(outOfOrder.message)
    && /Renumber it above the highest applied version/.test(outOfOrder.message),
  'a migration numbered below the highest applied one is refused, and says how to fix it',
  String(outOfOrder?.message));

  // CONTROL: the same file set one number higher IS the pending list, so the refusal above is
  // the ordering rule and not a runner that plans nothing.
  const next = await migrationDir([
    ['0001_a.sql', 'select 1;'], ['0002_b.sql', 'select 2;'],
    ['0004_d.sql', 'select 4;'], ['0005_e.sql', 'select 5;'],
  ]);
  const withFive = await loadMigrations(next);
  const plan = planMigrations(withFive, applied(files));
  check(Array.isArray(plan) && plan.length === 1 && plan[0].filename === '0005_e.sql',
    'CONTROL: a migration above the highest applied one is planned',
    JSON.stringify(plan instanceof Error ? String(plan) : plan.map((f) => f.filename)));

  // ── :157 — a runner with no connection and no URL says so instead of dialling nothing ──
  const noTarget = await caughtAsync(() => runMigrations({}));
  check(noTarget instanceof Error && /need a client or a databaseUrl/.test(noTarget.message),
    'runMigrations with neither a client nor a URL refuses before it opens anything',
    String(noTarget?.message));

  // ── :131 — something that is not a connection at all ──
  //
  // `storetest.mjs` covers the Pool case one line below this. Nothing covered the case where
  // the argument cannot run a query at all: without the guard the runner reads `totalCount` off
  // it and reports `Cannot read properties of undefined`, which names neither the parameter nor
  // what it wanted.
  for (const [client, what] of [[{}, 'an object with no query method'],
    [{ query: 'select 1' }, 'an object whose `query` is not a function']]) {
    const err = await caughtAsync(() => runMigrations({ client }));
    check(err instanceof Error && /must be a connected pg Client \(it has no \.query\)/.test(err.message),
      `${what} is refused by name`, String(err?.message));
  }

  // ── :214 — the deploy entry point without DATABASE_URL ──
  //
  // `out` is the sink the function takes as a parameter — console by default — not a stand-in
  // for the thing under test. What is asserted is what `migrateCli` DID: it reported, it
  // returned `ok: false`, and it never tried to connect.
  const lines = [];
  const out = { log: (m) => lines.push(`log:${m}`), error: (m) => lines.push(`error:${m}`) };
  // The env var has to be genuinely absent, not passed as `undefined`: `migrateCli`'s default
  // parameter reads `process.env.DATABASE_URL`, and a default fires on `undefined` — so
  // `migrateCli({ databaseUrl: undefined })` MIGRATES THE REAL DATABASE under `pgtest`, which
  // is what this test did on its first run. It passed on memory, where the variable happens to
  // be unset. The deploy case is that the variable is not set at all, so that is what is built.
  //
  // BOTH variables, because migrateCli now prefers MIGRATION_DATABASE_URL — 0018 requires the
  // owner that migrates and the role the app connects as to be different credentials. Clearing
  // only DATABASE_URL would leave the other one live and migrate the real database again, which
  // is the same false green this comment already exists to describe.
  const saved = process.env.DATABASE_URL;
  const savedMigration = process.env.MIGRATION_DATABASE_URL;
  delete process.env.DATABASE_URL;
  delete process.env.MIGRATION_DATABASE_URL;
  let cli;
  try { cli = await migrateCli({}, out); }
  finally {
    if (saved !== undefined) process.env.DATABASE_URL = saved;
    if (savedMigration !== undefined) process.env.MIGRATION_DATABASE_URL = savedMigration;
  }
  check(cli.ok === false && cli.applied.length === 0 && cli.alreadyApplied === 0,
    'migrateCli with no DATABASE_URL returns ok:false rather than throwing at a connection',
    JSON.stringify(cli));
  check(lines.length === 1
    && lines[0] === 'error:neither MIGRATION_DATABASE_URL nor DATABASE_URL is set',
    'and it names BOTH variables, so an operator who set only one is not left guessing',
    JSON.stringify(lines));

  // ── :229 — and the CLI turns that into a NON-ZERO EXIT ──
  //
  // A deploy step that prints an error and exits 0 is a deploy that continues onto an
  // unmigrated database. Driven as the deploy drives it: a real process, its real exit code.
  {
    const env = { ...process.env };
    // BOTH, for the same reason as above: migrateCli prefers MIGRATION_DATABASE_URL, so
    // clearing one and leaving the other would spawn a migrator that runs successfully against
    // the real database and then assert it exited 2.
    delete env.DATABASE_URL;                       // pgtest sets one; the deploy case is that it does not
    delete env.MIGRATION_DATABASE_URL;
    const r = spawnSync(process.execPath, [join(ROOT, 'platform/src/core/migrate.js')],
      { encoding: 'utf8', env });
    check(r.status === 2,
      'node platform/src/core/migrate.js with no DATABASE_URL exits 2, not 0',
      `exit ${r.status}: ${(r.stdout || '') + (r.stderr || '')}`);
    check(/neither MIGRATION_DATABASE_URL nor DATABASE_URL is set/.test(`${r.stdout}${r.stderr}`),
      'and the operator is told why, naming both variables',
      `${r.stdout}${r.stderr}`.slice(0, 200));
  }

  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
}

// =============================================================================================
section('core/http.js — parseTarget refuses an authority-shaped target (core/http.js:91)');
// =============================================================================================
//
// The header above this guard explains the two-argument `new URL(req.url, base)` trap, which
// this file avoids by concatenating onto the origin. Measured, that concatenation alone does
// NOT make the guard redundant, and the reason is one line further on: `Router.match` splits
// the path and drops empty segments with `filter(Boolean)`. So `//v1/health` yields pathname
// `//v1/health`, which splits to `['v1','health']` — and MATCHES `/v1/health`.
//
// A front proxy that routes, authorises or rate-limits on the literal request line sees a path
// it does not recognise; this router serves the endpoint. Two components disagreeing about what
// was requested is the whole of request smuggling, and the guard is what keeps them agreeing.
//
// `fetch` normalises the target before it leaves, so this can only be driven on a socket.
await withServer(NO_FLOOR, async ({ raw, handlerCalls }) => {
  const doubled = await raw(['GET //v1/health HTTP/1.1', 'Host: 127.0.0.1',
    'X-Client-Build: 1.0.0', 'Connection: close']);
  check(doubled.status === 404,
    'GET //v1/health is 404 — an empty leading segment does not collapse into a match',
    `${doubled.status} ${doubled.text.split('\r\n')[0]}`);
  check(!/"ok":true/.test(doubled.text),
    'and the health handler did not answer it', doubled.text.slice(0, 120));

  const tripled = await raw(['GET ///v1/health HTTP/1.1', 'Host: 127.0.0.1',
    'X-Client-Build: 1.0.0', 'Connection: close']);
  check(tripled.status === 404, 'nor does a tripled one', `${tripled.status}`);

  const authority = await raw(['GET //evil.com/v1/health HTTP/1.1', 'Host: 127.0.0.1',
    'X-Client-Build: 1.0.0', 'Connection: close']);
  check(authority.status === 404,
    'GET //evil.com/v1/health is 404 — the authority form never reaches /v1/health',
    `${authority.status} ${authority.text.split('\r\n')[0]}`);

  const deeper = await raw(['GET //v1/probe/x HTTP/1.1', 'Host: 127.0.0.1',
    'X-Client-Build: 1.0.0', 'Connection: close']);
  check(deeper.status === 404 && !handlerCalls.some((c) => c.path?.startsWith('/v1/probe')),
    'a doubled slash does not reach a parameterised route either — and no handler ran',
    `${deeper.status} ${JSON.stringify(handlerCalls)}`);

  // CONTROL: one slash, same path, same socket path through the code — served.
  const single = await raw(['GET /v1/health HTTP/1.1', 'Host: 127.0.0.1', 'Connection: close']);
  check(single.status === 200 && /"ok":true/.test(single.text),
    'CONTROL: GET /v1/health on the same raw socket is 200',
    `${single.status} ${single.text.split('\r\n\r\n')[1] || ''}`);
});

// =============================================================================================
section('core/http.js — readJson: the empty body, the content type, and the shape');
// =============================================================================================
await withServer(NO_FLOOR, async ({ call, handlerCalls }) => {
  // :116 — a POST with NO body at all is `{}`, not a parse failure. `POST /v1/auth/signout`
  // and `POST /v1/onboarding/verify/resend` are exactly this request: their whole content is
  // the URL and the token. Without the guard `JSON.parse('')` throws and both become 400.
  const bodiless = await call('POST', '/v1/echo');
  check(bodiless.status === 200 && bodiless.body?.keys === 0,
    'a POST with no body at all is an empty object, not a parse error',
    `${bodiless.status} ${JSON.stringify(bodiless.body)}`);
  const emptyWithType = await call('POST', '/v1/echo',
    { rawBody: '', headers: { 'content-type': 'application/json' } });
  check(emptyWithType.status === 200 && emptyWithType.body?.keys === 0,
    'and a zero-length body with a JSON content-type is too',
    `${emptyWithType.status} ${JSON.stringify(emptyWithType.body)}`);

  // :120 — §1 says JSON in, JSON out. A body that ANNOUNCES another type is refused even when
  // its bytes happen to parse, because content-type confusion is how two parsers disagree.
  const plain = await call('POST', '/v1/echo',
    { rawBody: '{"a":1}', headers: { 'content-type': 'text/plain' } });
  check(plain.status === 400 && plain.body?.error?.code === 'VALIDATION_FAILED'
    && /application\/json/.test(plain.body?.error?.message ?? ''),
  'a text/plain body is refused even though its bytes are valid JSON',
  `${plain.status} ${plain.body?.error?.code}`);
  check(!handlerCalls.some((c) => c.path === '/v1/echo' && c.bytes === 7),
    'and it never reached the handler', JSON.stringify(handlerCalls));
  const form = await call('POST', '/v1/echo',
    { rawBody: '{"a":1}', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  check(form.status === 400 && form.body?.error?.code === 'VALIDATION_FAILED',
    'a form content-type is refused too', `${form.status} ${form.body?.error?.code}`);

  // CONTROLS: the declared type is honoured with its parameters, and an absent one is allowed —
  // so the refusals above are about the type stated, not about POST bodies being broken.
  const withCharset = await call('POST', '/v1/echo',
    { rawBody: '{"a":1}', headers: { 'content-type': 'application/json; charset=utf-8' } });
  check(withCharset.status === 200 && withCharset.body?.keys === 1,
    'CONTROL: application/json with a charset parameter is accepted',
    `${withCharset.status} ${JSON.stringify(withCharset.body)}`);
  const upperType = await call('POST', '/v1/echo',
    { rawBody: '{"a":1}', headers: { 'content-type': 'APPLICATION/JSON' } });
  check(upperType.status === 200,
    'CONTROL: the type is compared case-insensitively, as HTTP requires', `${upperType.status}`);

  // :131 — `null`, `12`, `"s"`, `true` and arrays are all valid JSON and none is a request
  // body. Letting one through means the first property access in a handler is a TypeError,
  // which `toApiError` then reports as INTERNAL_ERROR — our fault, for their input.
  for (const [rawBody, why] of [
    ['null', 'null'], ['12345', 'a number'], ['"str"', 'a string'], ['true', 'a boolean'],
    ['[{"a":1}]', 'an array of objects — the shape a client sends by mistake'],
    ['[]', 'an empty array'],
  ]) {
    const res = await call('POST', '/v1/echo', { rawBody, headers: { 'content-type': 'application/json' } });
    check(res.status === 400 && res.body?.error?.code === 'VALIDATION_FAILED',
      `a body of ${why} is 400 VALIDATION_FAILED, never 500`,
      `${res.status} ${res.body?.error?.code}`);
  }
  const malformed = await call('POST', '/v1/echo',
    { rawBody: '{"a":', headers: { 'content-type': 'application/json' } });
  check(malformed.status === 400 && /not valid JSON/.test(malformed.body?.error?.message ?? ''),
    'CONTROL: truncated JSON is refused as unparseable, a different message from the shape check',
    `${malformed.status} ${malformed.body?.error?.message}`);
  const object = await call('POST', '/v1/echo',
    { rawBody: '{"a":1,"b":2}', headers: { 'content-type': 'application/json' } });
  check(object.status === 200 && object.body?.keys === 2,
    'CONTROL: a JSON object is accepted and parsed', `${object.status} ${JSON.stringify(object.body)}`);
});

// =============================================================================================
section('core/http.js — a GET body is never read (core/http.js:106)');
// =============================================================================================
//
// Deleting the early return does not merely make a GET body readable: it makes the server WAIT
// for it. `for await (const chunk of req)` on a request whose Content-Length has not arrived
// suspends until the client sends the rest, so a GET that declares 100 bytes and sends 5 pins
// the handler open — an unauthenticated slowloris on every read endpoint in the platform,
// costing the sender one socket.
//
// The assertion is therefore not "the body was ignored" but "the request was ANSWERED".
await withServer(NO_FLOOR, async ({ raw }) => {
  const starved = await raw(
    ['GET /v1/probe/x HTTP/1.1', 'Host: 127.0.0.1', 'X-Client-Build: 1.0.0',
      'Content-Type: application/json', 'Content-Length: 100', 'Connection: close'],
    { body: '{"a":1' });                            // 6 of the promised 100 bytes, then silence
  check(starved.timedOut === false && starved.status === 200,
    'a GET declaring a body it never sends is answered anyway, not held open',
    `timedOut=${starved.timedOut} status=${starved.status}`);
  check(/"accountId":"x"/.test(starved.text),
    'and the handler ran with the routed parameter, not with the unsent body',
    starved.text.split('\r\n\r\n')[1] || starved.text.slice(0, 120));

  const deleteStarved = await raw(
    ['DELETE /v1/probe/x HTTP/1.1', 'Host: 127.0.0.1', 'X-Client-Build: 1.0.0',
      'Content-Length: 100', 'Connection: close'],
    { body: '{' });
  check(deleteStarved.timedOut === false && deleteStarved.status === 404,
    'the same holds for DELETE — 404 because no DELETE route matches, but ANSWERED',
    `timedOut=${deleteStarved.timedOut} status=${deleteStarved.status}`);

  // CONTROL: a POST that starves its body IS held, because a POST body is content the handler
  // needs and there is nothing else to answer with. Without this control the checks above pass
  // for a server that never reads a body at all.
  const post = await raw(
    ['POST /v1/echo HTTP/1.1', 'Host: 127.0.0.1', 'X-Client-Build: 1.0.0',
      'Content-Type: application/json', 'Content-Length: 100', 'Connection: close'],
    { body: '{"a":1', timeoutMs: 1000 });
  check(post.timedOut === true && post.status === null,
    'CONTROL: a POST whose body never arrives is NOT answered — the GET exemption is specific',
    `timedOut=${post.timedOut} status=${post.status}`);
});

// =============================================================================================
section('core/http.js — a route\'s declared rate-limit class is the one applied (:178)');
// =============================================================================================
//
// §9 assigns a class by METHOD, and a handful of routes are named in the table specifically.
// `rateLimitClass` is how a route says which one it is. Delete the line that reads it and every
// override silently becomes the method default: a `report` route capped at 5/hour starts
// serving 120/min, and a route that opts out with `rateLimitClass: null` starts being capped.
//
// The limiter is the REAL `createRateLimiter()` and the counting is done by the server, over a
// socket. Building the middleware here and calling it in a loop is the exact defect that let
// the limiter go unconsulted for a dozen review rounds.
{
  const limiter = createRateLimiter();
  await withServer(NO_FLOOR, async ({ call }) => {
    // A route the §9 table names specifically: report, 5 per HOUR.
    const reportCap = CLASSES.report.perMin;
    let firstRefusal = 0;
    for (let i = 1; i <= reportCap + 3; i++) {
      const res = await call('GET', '/v1/reports');
      if (res.status !== 200) { firstRefusal = i; break; }
    }
    check(firstRefusal === reportCap + 1,
      `a route declaring rateLimitClass:'report' is refused at ${reportCap + 1}, not at 121`,
      `first refusal at ${firstRefusal}`);

    // The opt-out. `rateLimitClass: null` is a route saying the table exempts it; without the
    // line that reads the option it is charged `read` like any other GET.
    let served = 0;
    for (let i = 1; i <= CLASSES.read.perMin + 5; i++) {
      const res = await call('GET', '/v1/exempt');
      if (res.status !== 200) break;
      served++;
    }
    check(served === CLASSES.read.perMin + 5,
      `a route declaring rateLimitClass:null serves all ${CLASSES.read.perMin + 5} calls`,
      `served ${served}`);

    // CONTROL: an ordinary GET on the same server, same limiter, no declaration — capped at the
    // method default. Without this the two checks above pass for a limiter nobody consulted.
    let readRefusal = 0;
    for (let i = 1; i <= CLASSES.read.perMin + 2; i++) {
      const res = await call('GET', '/v1/probe/rl');
      if (res.status !== 200) { readRefusal = i; break; }
    }
    check(readRefusal === CLASSES.read.perMin + 1,
      `CONTROL: an undeclared GET is charged the read class and refused at ${CLASSES.read.perMin + 1}`,
      `first refusal at ${readRefusal}`);
  }, {
    deps: { rateLimiter: limiter },
    routes: [
      ['GET', '/v1/reports', async () => ({ items: [] }), { rateLimitClass: 'report' }],
      ['GET', '/v1/exempt', async () => ({ ok: true }), { rateLimitClass: null }],
    ],
  });
}

// =============================================================================================
section('core/http.js — X-Forwarded-For is ignored at zero trusted hops');
// =============================================================================================
//
// EQUIVALENT MUTANT, measured: `clientIp`'s `if (hops <= 0) return socketIp` (core/http.js:211)
// cannot change an answer. With `hops === 0` the code below it computes
// `idx = chain.length - 0 = chain.length`, and `idx < chain.length` is then false for every
// possible header, so the fall-through returns `socketIp` — the same value, on every input.
// Measured by running both versions of the file over 1, 2 and 8-entry chains, an empty header,
// a whitespace-only header, an absent header and a non-string header, at hops 0: identical IPs
// in all 14 comparisons. The guard stays because reading a client-controlled header we have
// decided not to trust is work with no purpose.
//
// The SECURITY property underneath it is not equivalent, and is asserted here: at the default
// of zero hops a forged X-Forwarded-For must not move a caller into someone else's rate-limit
// bucket, nor buy them a fresh one.
{
  const limiter = createRateLimiter();
  await withServer(NO_FLOOR, async ({ call }) => {
    let refusal = 0;
    for (let i = 1; i <= CLASSES.read.perMin + 2; i++) {
      // A different forged address on EVERY request. If the header were trusted, each one would
      // be a fresh subject and the cap would never be reached.
      const res = await call('GET', '/v1/probe/xff', { headers: { 'x-forwarded-for': `198.51.100.${i}` } });
      if (res.status !== 200) { refusal = i; break; }
    }
    check(refusal === CLASSES.read.perMin + 1,
      'a forged X-Forwarded-For does not buy a fresh rate-limit bucket at zero trusted hops',
      `first refusal at ${refusal}`);

    // And the caller cannot escape their own exhausted bucket by claiming to be someone else.
    const escape = await call('GET', '/v1/probe/xff',
      { headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.1' } });
    check(escape.status === 429 && escape.body?.error?.code === 'RATE_LIMITED',
      'nor escape an exhausted one with a longer chain', `${escape.status} ${escape.body?.error?.code}`);
  }, { deps: { rateLimiter: limiter } });
}

// =============================================================================================
section('core/http.js — a handler\'s response headers are actually written');
// =============================================================================================
//
// `raw(status, body, headers)` and `withHeaders(body, headers)` are the only two ways a handler
// can put a header on a response. Delete the one line in `finish` that reads them and both
// become silent no-ops: the status and the body still look right, so every existing assertion
// passes, while `Retry-After` stops arriving on a 429 and `ETag` stops arriving on a settings
// read — and a conditional-request client then re-fetches forever without ever being told it
// could stop.
await withServer(NO_FLOOR, async ({ call }) => {
  const rawRes = await call('GET', '/v1/hdr-raw');
  check(rawRes.status === 503 && rawRes.headers?.get('retry-after') === '5',
    'raw(status, body, headers) puts its headers on the wire',
    `${rawRes.status} retry-after=${rawRes.headers?.get('retry-after')}`);
  check(rawRes.body?.reason === 'draining',
    'CONTROL: and the body it shaped arrives too', JSON.stringify(rawRes.body));

  const tagged = await call('GET', '/v1/hdr-etag');
  check(tagged.status === 200 && tagged.headers?.get('etag') === '"v7"',
    'withHeaders(body, headers) puts its headers on the wire',
    `${tagged.status} etag=${tagged.headers?.get('etag')}`);
  check(tagged.body?.version === 7 && tagged.body?.__headers === undefined,
    'CONTROL: the body is the handler\'s, with the header carrier stripped out of it',
    JSON.stringify(tagged.body));

  // CONTROL: a plain handler sets no stray headers, so the two above are the handlers speaking
  // and not something the response writer adds to everything.
  const plain = await call('GET', '/v1/probe/h');
  check(plain.headers?.get('etag') === null && plain.headers?.get('retry-after') === null,
    'CONTROL: an ordinary response carries neither header',
    `${plain.headers?.get('etag')}/${plain.headers?.get('retry-after')}`);
}, {
  routes: [
    ['GET', '/v1/hdr-raw', async () => raw(503, { reason: 'draining' }, { 'Retry-After': '5' }), {}],
    ['GET', '/v1/hdr-etag', async () => withHeaders({ version: 7 }, { ETag: '"v7"' }), {}],
  ],
});

// =============================================================================================
section('core/http.js — the last-resort handler cannot take the process down');
// =============================================================================================
//
// THE DEFECT THIS FOUND. `createApp`'s `handle(req, res).catch(...)` is the wrapper the file
// header is about: "One request killed the platform. Nothing here may sit outside the guard."
// Two statements do sit outside `finish`'s inner try — the request log line and the
// `onRequestEnd` hook — and both run AFTER the response has been written and ended. A throw
// there rejects `handle`, the catch runs, and its `res.end(...)` lands on an ended response.
//
// That does not throw on the catch's stack, so the `try` around it never sees it: Node emits
// `error` on the ServerResponse asynchronously, and an unhandled 'error' event exits the
// process. `ERR_STREAM_WRITE_AFTER_END`, uncaught, from one request — inside the handler whose
// entire job is to make sure one request cannot do that.
//
// This section is written in-process deliberately. If the fault returns, this file does not
// report a failure: it DIES, and `platformtest` reports the suite as failing, which is the
// honest signal for a defect that kills processes.
{
  // A logger that throws exactly where the fault needs it: on the request log line at the end
  // of `finish`, after the response has gone out. It is the LOGGER, not the code under test.
  const explosive = () => {
    const noop = () => {};
    return {
      debug: noop,
      warn: noop,
      error: noop,                      // the catch-all logs here; it must not throw as well
      info: (event) => { if (event === 'request') throw new Error('logger exploded'); },
    };
  };

  await withServer(NO_FLOOR, async ({ call }) => {
    const first = await call('GET', '/v1/probe/x');
    check(first.status === 200 && first.body?.accountId === 'x',
      'a request whose tail logging throws is still answered normally',
      `${first.status} ${first.text?.slice(0, 80)}`);

    // The process is still here to answer this one. Reaching this line at all is the assertion.
    const second = await call('GET', '/v1/probe/y');
    check(second.status === 200 && second.body?.accountId === 'y',
      'and the server survives it — the next request is served',
      `${second.status} ${second.text?.slice(0, 80)}`);

    // The error path too: a handler that throws AND a logger that throws on the way out.
    const thrown = await call('GET', '/v1/boom');
    check(thrown.status === 500 && thrown.body?.error?.code === 'INTERNAL_ERROR',
      'a failing handler still produces the INTERNAL_ERROR envelope under the same logger',
      `${thrown.status} ${thrown.body?.error?.code}`);
    const third = await call('GET', '/v1/probe/z');
    check(third.status === 200, 'and the server survives that too', `${third.status}`);
  }, {
    logger: explosive(),
    routes: [['GET', '/v1/boom', async () => { throw new Error('handler exploded'); }, {}]],
  });
}

// =============================================================================================
section('core/health.js — the readiness timeout does not hold the process open');
// =============================================================================================
//
// §7.1's probes are bounded at 2 s so a hung dependency cannot hang the check. The timer that
// bounds them is unref'd, and deleting that line makes every readiness probe hold the event
// loop open for its full 2 s even after the answer is known — so a CLI or a one-shot ops task
// that asks for readiness pauses for two seconds per call before it can exit.
//
// A held event loop is only observable from outside the process, so this is measured as the
// deploy would feel it: a real child, and the wall clock on its exit.
{
  const script = `
    import { createHealth } from '${join(ROOT, 'platform/src/core/health.js')}';
    const health = createHealth({ deps: { healthProbes: {
      // A dependency that never answers — the case the timeout exists for.
      db: () => new Promise(() => {}),
    } } });
    health.ready().then((r) => process.stdout.write('READY ' + JSON.stringify(r)));
    process.stdout.write('CALLED\\n');
  `;
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  const elapsed = Date.now() - started;
  check(/CALLED/.test(r.stdout ?? ''), 'control: the child really did call ready()',
    `${r.stdout}${r.stderr}`.slice(0, 200));
  check(elapsed < 1500,
    'a process with nothing else to do exits without waiting out the 2 s probe timeout',
    `it took ${elapsed} ms`);
  // CONTROL: the timeout is still a timeout. With something else holding the loop open — a
  // server, in a real process — it fires and reports the dependency down rather than hanging,
  // so the exit above is not achieved by having no timer at all.
  const waited = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createHealth } from '${join(ROOT, 'platform/src/core/health.js')}';
    const health = createHealth({ deps: { healthProbes: { db: () => new Promise(() => {}) } } });
    const keepAlive = setTimeout(() => {}, 10_000);   // stands in for the server that is running
    const r = await health.ready();
    clearTimeout(keepAlive);
    process.stdout.write(JSON.stringify(r));
  `], { encoding: 'utf8' });
  check(waited.stdout === '{"ok":false,"dependencies":{"db":"down"}}',
    'CONTROL: awaited, a hung dependency is reported down — the bound is real',
    `${waited.stdout}${waited.stderr}`.slice(0, 200));
}

console.log(failures ? `\n${failures} FAILED` : '\ncore http and rate limiting run clean');
process.exit(failures ? 1 : 0);
