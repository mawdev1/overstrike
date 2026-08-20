/**
 * The stub API.  contracts/http-api.md §11.10, §12; contracts/feature-flags.md §4.
 *
 * Build Plan §0.5 makes this the exit condition for P1: the frontend lane builds the entire
 * shell against these responses and switches to the live services with no UI change. Two
 * properties are what make that possible, and both are enforced here rather than hoped for:
 *
 *   1. **Stateful.** A scenario is advanced by the requests the client actually makes, keyed
 *      per `clientSessionId`. `onboarding-verify-invalid` fails the first verify and succeeds
 *      after a resend; `result-pending-live` returns pending exactly three times. A single
 *      canned response per endpoint cannot express either, which is the review finding that
 *      created this work.
 *   2. **Deterministic.** No wall clock, no randomness, and nothing session-derived in a
 *      payload — so the same scenario replayed from a fresh `clientSessionId` produces
 *      byte-identical responses in the same order, and a snapshot test is possible at all.
 *
 * The layer is behind `platform.api.stub` and refuses to construct in production. A stub flag
 * surviving into production is a way to serve fixtures to players (feature-flags.md §2), so it
 * is an assertion, not a convention.
 */
import { Router } from '../../core/http.js';
import { ApiError, toApiError } from '../../core/errors.js';
import { createClock, DEFAULT_STEP_MS } from './clock.js';
import { checkAuthClass, checkClientBuild } from './gates.js';
import { stubUlid } from './ids.js';
import { ROUTES } from './routes.js';
import { SCENARIOS, SCENARIO_NAMES, initialState } from './scenarios.js';

export const STUB_FLAG = 'platform.api.stub';

/**
 * The one gate.
 *
 * Production is refused **before** the flag is even consulted: a flag misconfigured on in prod
 * must not be the difference between real data and fixtures. `config.env` and `NODE_ENV` are
 * both checked because either one being production is enough to mean production.
 */
export function assertStubAllowed({ config = {}, flags = {}, env = process.env } = {}) {
  const nodeEnv = config.env ?? env.NODE_ENV ?? 'development';
  if (nodeEnv === 'production') {
    throw new Error(`${STUB_FLAG} cannot be enabled in production: the stub API serves fixtures, not data`);
  }
  if (flags[STUB_FLAG] !== true) {
    throw new Error(`${STUB_FLAG} is off: the stub API refuses to serve`);
  }
  return true;
}

function buildRouter() {
  const router = new Router();
  for (const route of ROUTES) {
    router.add(route.method, route.path, route.handler, {
      pattern: `${route.method} ${route.path}`,
      auth: route.auth,
      requireBuild: route.requireBuild !== false,
    });
  }
  return router;
}

const lowerHeaders = (headers) => {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[String(k).toLowerCase()] = v;
  return out;
};

/**
 * Build the stub API.
 *
 * `handle(request)` is a plain function over plain objects, deliberately: it is drivable from a
 * test, from a service worker in the browser, or from a node server, and none of those has to
 * exist for the scenarios to be exercised.
 */
export function createStubApi({
  config = {}, flags = { [STUB_FLAG]: true }, env = process.env,
  // Injectable so a suite can prove the delay is *requested* without spending the wall-clock
  // time on every check. The default is a real sleep, because the default has to be the truth.
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
} = {}) {
  assertStubAllowed({ config, flags, env });
  const router = buildRouter();
  const sessions = new Map();          // `${scenario}::${clientSessionId}` -> { state, clock }

  const sessionFor = (scenarioName, key) => {
    const id = `${scenarioName}::${key}`;
    let entry = sessions.get(id);
    if (!entry) {
      const scenario = SCENARIOS[scenarioName];
      entry = {
        state: initialState(scenarioName),
        clock: createClock(scenario.clockStepMs ?? DEFAULT_STEP_MS),
      };
      if (scenario.init) scenario.init(entry.state);
      sessions.set(id, entry);
    }
    return entry;
  };

  function handle(request) {
    const method = (request.method || 'GET').toUpperCase();
    const path = request.path || '/';
    const query = request.query || {};
    const headers = lowerHeaders(request.headers);
    const body = request.body || {};

    const scenarioName = request.scenario || headers['x-stub-scenario'] || 'default';
    const scenario = SCENARIOS[scenarioName];
    if (!scenario) {
      // An unknown scenario is a client bug worth surfacing loudly; silently serving `default`
      // would make a typo look like a passing test.
      const err = new ApiError('VALIDATION_FAILED', 'Unknown stub scenario.', {
        details: { fields: [{ path: 'X-Stub-Scenario', rule: 'enum', message: `Unknown scenario ${scenarioName}.` }] },
      });
      return { status: err.status, headers: {}, body: err.toEnvelope('stub-no-correlation'), scenario: scenarioName };
    }

    // Header first, then the two places the contract already puts `clientSessionId` (§3a.3
    // query for GET consent, body for PUT consent and signup). A client that sends the header
    // on every request keeps one timeline; a client that only sends it on some requests gets a
    // split one, which is why the header is the documented way to drive a scenario.
    const sessionKey = headers['x-client-session-id'] || query.clientSessionId
      || body.clientSessionId || 'stub-default-session';
    const { state, clock } = sessionFor(scenarioName, sessionKey);

    // `offline` has no HTTP layer to answer with. Returning a synthetic 5xx would be a lie the
    // shell could not distinguish from a real one — a transport failure has no envelope.
    if (scenario.transport === 'fail') {
      state.requests++;
      return { transport: 'failed', scenario: scenarioName, status: null, headers: {}, body: null };
    }

    clock.tick();
    state.requests++;

    // Deterministic and NOT derived from the session key: two fresh sessions replaying one
    // scenario must produce the same bytes, so the id can only depend on the scenario and the
    // step within it.
    const correlationId = headers['x-correlation-id']
      || stubUlid(`corr:${scenarioName}:${state.requests}`, clock.nowMs());

    const hit = router.match(method, path);
    let status;
    let payload;
    let extraHeaders = {};

    const respond = () => {
      // §1 and errors.md §5: every response carries the correlation id, including the 204s —
      // a body-less success is still an event someone has to trace, and the header is the only
      // place the id can travel.
      const outHeaders = { 'X-Correlation-Id': correlationId, ...extraHeaders };
      let outBody = payload;
      if (outBody && !outBody.error) outBody = { ...outBody, correlationId };
      if (status === 204) outBody = null;
      const out = { status, headers: outHeaders, body: outBody, scenario: scenarioName, correlationId };
      if (!scenario.delayMs) return out;
      // `slow` used to return `delayMs` as metadata and nothing applied it — the mounted path
      // in app.js hands the response straight to the writer, so the scenario whose entire
      // subject is a 2 s wait answered instantly. The delay is real now.
      //
      // The response is a plain object AND a thenable: `res.transport`/`res.status` still read
      // synchronously (app.js branches on them before it returns), while any consumer that
      // awaits it — including `return res` from app.js's async preRoute, and core/http.js's
      // `await mw(...)` — waits the scenario's delay first. A sleep inside `handle` itself
      // would have to be synchronous, and a synchronous sleep in a server blocks every other
      // request while proving that one is slow.
      out.delayMs = scenario.delayMs;
      out.then = (resolve, reject) => sleep(scenario.delayMs).then(() => {
        const settled = { ...out };
        delete settled.then;          // or awaiting the result would recurse forever
        resolve(settled);
      }, reject);
      return out;
    };

    try {
      if (!hit) throw new ApiError('NOT_FOUND', 'No such endpoint.');
      // The two checks the stub used to skip by intercepting before routing (§1, §2). Build
      // first: an unsupported client is unsupported whether or not it is signed in, and 426
      // before 401 is the order core/http.js applies.
      checkClientBuild(headers, {
        requireBuild: hit.route.opts.requireBuild,
        minClientBuild: config.minClientBuild ?? null,
      });
      const credential = checkAuthClass(headers, hit.route.opts.auth, {
        serviceToken: config.serviceToken ?? null,
      });
      const ctx = {
        method,
        path,
        pattern: hit.route.opts.pattern,
        auth: hit.route.opts.auth,
        authenticated: credential.authenticated,
        token: credential.token,
        params: hit.params,
        query,
        headers,
        body,
        state,
        clock,
        scenario: scenarioName,
        correlationId,
        accessTokenTtlMs: scenarioName === 'token-expiry' ? 30 * 1000 : 15 * 60 * 1000,
      };

      const base = (c = ctx) => hit.route.handler(c);
      const override = scenario.routes && scenario.routes[ctx.pattern];
      // A `pre` hook may answer the request outright; all the current ones throw instead, which
      // is the same thing routed through the error envelope.
      const result = (scenario.pre && scenario.pre(ctx))
        || (override ? override(ctx, base) : base(ctx));
      status = result.status;
      payload = result.body ?? null;
      extraHeaders = result.headers || {};
    } catch (err) {
      const apiErr = toApiError(err);
      status = apiErr.status;
      payload = apiErr.toEnvelope(correlationId);
    }

    return respond();
  }

  return {
    handle,
    /** Drop all scenario state. A fresh session is the supported way to replay; this is for tests. */
    reset() { sessions.clear(); },
    scenarioNames: SCENARIO_NAMES,
    hasScenario: (name) => Object.hasOwn(SCENARIOS, name),
    routePatterns: ROUTES.map((r) => `${r.method} ${r.path}`),
  };
}

export { SCENARIOS, SCENARIO_NAMES, EXTRA_SCENARIOS } from './scenarios.js';
export { createLobbyStub, LOBBY_SCENARIOS, LOBBY_SCENARIO_NAMES } from './lobby.js';
export { COVERAGE_MAP } from './coverage.js';
