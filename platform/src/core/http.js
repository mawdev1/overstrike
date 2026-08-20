/**
 * The HTTP layer.  contracts/http-api.md §1–§2.
 *
 * Hand-rolled on `node:http`, no framework — the same call this repository already makes for
 * its wire protocol and its collision system. A router, a body reader, and a response writer
 * is roughly 250 lines; a framework is a dependency tree we would then own the security of.
 *
 * Everything a request needs is assembled here so handlers never touch raw node objects:
 * correlation id, auth context, parsed body, typed errors, and the response envelope.
 *
 * ── The rule this file exists to obey ────────────────────────────────────────────────────
 * **Every statement that touches the request runs inside the try.** An earlier version parsed
 * the URL one line above it, and `GET // HTTP/1.1` — twenty bytes, unauthenticated — threw
 * `ERR_INVALID_URL` outside any catch, which in an async handler is an unhandled rejection,
 * which Node exits on. One request killed the platform. Nothing here may sit outside the
 * guard, including the response write and the log line.
 */
import { createServer } from 'node:http';
import { ApiError, toApiError } from './errors.js';
import { ulid, isUlid } from './ids.js';

const MAX_BODY_BYTES = 256 * 1024;

/** Route table: method -> [{ segments, handler, opts }]. Matching is exact-length, no regex. */
export class Router {
  constructor() {
    this.routes = { GET: [], POST: [], PUT: [], PATCH: [], DELETE: [] };
    /**
     * Middleware that runs before EVERY matched route.
     *
     * Exists for the stub layer, which has to be able to answer any contracted endpoint
     * without each module remembering to ask it. Global middleware is a blunt tool and is
     * deliberately the only one: it runs after routing, so an unknown path is still a 404, and
     * it cannot see a request the router would not have served anyway.
     */
    this.globalMiddleware = [];
  }

  useGlobal(fn) { this.globalMiddleware.push(fn); return this; }

  add(method, path, handler, opts = {}) {
    const segments = path.split('/').filter(Boolean).map((s) =>
      (s.startsWith(':') ? { param: s.slice(1) } : { literal: s }));
    this.routes[method].push({ segments, handler, opts });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes[method] || []) {
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i];
        if (seg.literal !== undefined) { if (seg.literal !== parts[i]) { ok = false; break; } }
        else {
          // A malformed percent-escape is a CLIENT error. Letting URIError propagate turned
          // `/v1/thing/%ZZ` into a 500 with a stack in the error log, reporting our fault for
          // their typo.
          let decoded;
          try { decoded = decodeURIComponent(parts[i]); }
          catch { throw new ApiError('VALIDATION_FAILED', 'Malformed path parameter.'); }
          // Decoding happens after the split, so an encoded slash would smuggle a separator
          // into a value the router promised was one segment.
          if (decoded.includes('/')) throw new ApiError('VALIDATION_FAILED', 'Malformed path parameter.');
          params[seg.param] = decoded;
        }
      }
      if (ok) return { route, params };
    }
    return null;
  }
}

/**
 * Parse the request target.
 *
 * `new URL(req.url, base)` treats a leading `//` as an authority, so `//evil.com/v1/health`
 * routes as `/v1/health` — a front proxy matching the literal request line and this router
 * would disagree about what was requested. Concatenating onto the origin instead makes the
 * authority unreachable, and anything not starting with a single `/` is refused outright.
 */
function parseTarget(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('/') || rawUrl.startsWith('//')) {
    throw new ApiError('NOT_FOUND', 'No such endpoint.');
  }
  try { return new URL(`http://localhost${rawUrl}`); }
  catch { throw new ApiError('NOT_FOUND', 'No such endpoint.'); }
}

/**
 * Read and parse a JSON body.
 *
 * Bounded before it is buffered, not after: the length check has to happen as bytes arrive or
 * a large body is already in memory by the time we object to it. Same lesson as
 * MAX_COMMANDS_PER_BATCH on the wire.
 */
async function readJson(req) {
  if (req.method === 'GET' || req.method === 'DELETE') return {};

  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError('PAYLOAD_TOO_LARGE', 'Request body is too large.');
    chunks.push(chunk);
  }
  if (size === 0) return {};

  // §1 says JSON in, JSON out. Parsing `text/plain` as JSON accepts a shape the contract does
  // not describe, and content-type confusion is a standing source of parser mismatches.
  if (type && type !== 'application/json') {
    throw new ApiError('VALIDATION_FAILED', 'Request body must be application/json.');
  }

  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError('VALIDATION_FAILED', 'Request body is not valid JSON.'); }

  // `null`, `12345`, `"str"`, `true` and arrays are all valid JSON and none is a request body.
  // Letting them through means the first property access in a handler is a TypeError, which
  // `toApiError` reports as INTERNAL_ERROR — our fault, for their malformed input.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError('VALIDATION_FAILED', 'Request body must be a JSON object.');
  }
  return parsed;
}

/**
 * Compare two build strings numerically.
 *
 * `'1.10.0' < '1.2.0'` is true as strings, which locks out every client past 1.9.x — the
 * kind of comparison that looks obviously fine and ships a total outage.
 */
const BUILD_RE = /^\d+(\.\d+)*$/;

/** A build string the contract recognises: dot-separated integers, nothing else. */
export const isWellFormedBuild = (b) => typeof b === 'string' && b !== '' && BUILD_RE.test(b);

/**
 * Compare two build strings numerically.
 *
 * Two traps, both hit. `'1.10.0' < '1.2.0'` is true as STRINGS, which locks out every client
 * past 1.9.x. And `parseInt('2garbage')` is 2, so a malformed build sailed past floor 2 —
 * the comparison happily read a prefix and ignored the rest. Format is validated by the
 * caller before this runs, so anything reaching here is already dot-separated integers.
 */
function buildBelowFloor(build, floor) {
  const a = String(build).split('.').map(Number);
  const b = String(floor).split('.').map(Number);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isInteger(a[i]) ? a[i] : 0;
    const y = Number.isInteger(b[i]) ? b[i] : 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * Derive the client IP.
 *
 * `X-Forwarded-For` is client-controlled and trusting it blindly lets anyone forge their
 * rate-limit identity. Trusting it NEVER is also wrong once a proxy is in front: every caller
 * then shares the proxy's address, so §9's per-IP bucket becomes one global 10/min bucket and
 * a single bad actor locks out every sign-in on the platform.
 *
 * So it is explicit. `trustedProxyHops` says how many proxies we actually run; we take the
 * entry that many positions from the RIGHT, because everything to the right was appended by
 * infrastructure we control and everything to the left is attacker-supplied. Zero hops means
 * the header is ignored entirely, which is the correct default for a directly-exposed process.
 */
function clientIp(req, config) {
  const socketIp = req.socket.remoteAddress || '';
  const hops = config.trustedProxyHops || 0;
  if (hops <= 0) return socketIp;

  const header = req.headers['x-forwarded-for'];
  if (typeof header !== 'string' || !header) return socketIp;

  const chain = header.split(',').map((s) => s.trim()).filter(Boolean);
  // The socket address is itself the last hop, so N trusted proxies means the client is N
  // entries from the end of the header.
  const idx = chain.length - hops;
  return (idx >= 0 && idx < chain.length) ? chain[idx] : socketIp;
}

/**
 * Build the app.
 *
 * `deps` is everything a handler may reach: store, config, clock, logger, and the domain
 * services. Handlers receive it explicitly rather than importing singletons, so a test can
 * substitute any of them without a module registry.
 */
export function createApp({ router, deps, onRequestEnd = null, preRoute = [] }) {
  const { logger, config } = deps;

  return createServer((req, res) => {
    // Deliberately not an async function: an async listener's rejection is an unhandled
    // rejection. This wrapper owns the promise and can never leak one.
    handle(req, res).catch((err) => {
      try {
        logger.error('request.unhandled', { cause: String(err && err.stack || err) });
        if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); }
        res.end('{"error":{"code":"INTERNAL_ERROR","message":"Something went wrong on our end."}}');
      } catch { /* the socket is already gone; there is nothing left to say */ }
    });
  });

  async function handle(req, res) {
    const startedAt = process.hrtime.bigint();
    let correlationId = ulid();
    let status = 500;
    let payload = null;
    let extraHeaders = null;
    let pathForLog = '-';
    let ctxRef = null;

    try {
      // §1: the client's id is echoed — but only if it IS one. An unvalidated header is
      // reflected into a response header, a JSON body, and every log line this request
      // writes, which lets a caller poison the trace support depends on, or make ten
      // thousand requests share one id.
      const supplied = req.headers['x-correlation-id'];
      if (typeof supplied === 'string' && isUlid(supplied)) correlationId = supplied;
      else if (supplied !== undefined) {
        logger.warn('correlation.rejected', { correlationId, suppliedLength: String(supplied).length });
      }

      const url = parseTarget(req.url);
      pathForLog = url.pathname;

      // The stub layer runs BEFORE routing, deliberately. It has to answer contracted
      // endpoints the platform has not implemented yet — the whole point is that the other
      // lane can build against P2's lobby and match surfaces while P1 is still being written.
      // After routing it could only ever serve what already exists, which is the opposite.
      if (preRoute.length) {
        const early = { correlationId, method: req.method, path: url.pathname,
          query: url.searchParams, headers: req.headers, deps };
        for (const mw of preRoute) {
          const answered = await mw(early, req);
          if (answered) {
            if (answered.__dropSocket) { try { res.destroy(); } catch { /* gone */ } return; }
            status = answered.status ?? 200;
            extraHeaders = answered.headers || null;
            const b = answered.body;
            const isObject = b && typeof b === 'object' && !Array.isArray(b);
            // An error envelope already carries its id INSIDE `error`. Adding a top-level one
            // gave the response two correlation ids that could disagree, plus a key §11's
            // "anything not stated is forbidden" does not allow on that shape.
            payload = (isObject && !b.error) ? { ...b, correlationId } : b;
            return finish();
          }
        }
      }

      const hit = router.match(req.method, url.pathname);
      if (!hit) throw new ApiError('NOT_FOUND', 'No such endpoint.');

      // §1 says every request carries X-Client-Build. Skipping the check when it is absent
      // means the floor is bypassed by omitting the header the contract requires — the check
      // has to fail closed or it is not a floor.
      if (hit.route.opts.requireBuild !== false) {
        const build = req.headers['x-client-build'];
        // §1: "Every request carries X-Client-Build." Skipping the check when no floor is
        // configured meant a DEFAULT deployment — which is most of them — accepted a request
        // that omitted a header the contract requires, so the field was optional in practice
        // exactly where it was least examined.
        // A build we cannot parse is not a build we can compare, and treating it as passing
        // is the fail-open we already fixed once for the absent header. `2garbage` reached
        // business logic through a numeric prefix.
        if (!isWellFormedBuild(build)) {
          throw new ApiError('UNSUPPORTED_CLIENT', 'Please update the game to continue.',
            { details: { reason: 'build' } });
        }
        if (config.minClientBuild !== null && config.minClientBuild !== undefined) {
          // A floor we cannot parse cannot be enforced, and treating it as "no floor" is a
          // misconfiguration that silently disables a gate. Fail closed and make the operator
          // fix the value.
          if (!isWellFormedBuild(config.minClientBuild)) {
            throw new ApiError('SERVICE_UNAVAILABLE', 'Client version policy is misconfigured.',
              { details: { reason: 'floor-malformed' } });
          }
          if (buildBelowFloor(build, config.minClientBuild)) {
            throw new ApiError('UNSUPPORTED_CLIENT', 'Please update the game to continue.',
              { details: { reason: 'build' } });
          }
        }
      }

      const ctx = {
        correlationId,
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        params: hit.params,
        body: await readJson(req),
        actor: null,          // filled by auth middleware when a token is present
        deps,
        ip: clientIp(req, config),
        // Set-Cookie is the one response header a handler legitimately needs and cannot
        // express through a return value: auth §3 requires the refresh cookie to be set on
        // signup/signin/refresh and CLEARED on signout, and a cookie that is assembled and
        // never written is a session that silently does not persist.
        cookies: [],
      };
      ctxRef = ctx;

      for (const mw of hit.route.opts.middleware || []) await mw(ctx);

      const result = await hit.route.handler(ctx);
      if (result && result.__raw) {
        status = result.status;
        extraHeaders = result.headers || null;
        // §1: every success body carries the correlation id, including the ones a handler
        // shaped itself.
        payload = (result.body && typeof result.body === 'object' && !Array.isArray(result.body))
          ? { ...result.body, correlationId }
          : result.body;
      } else if (result === undefined || result === null) {
        status = 204; payload = null;
      } else {
        status = 200;
        extraHeaders = result.__headers || null;
        const body = result.__headers ? { ...result } : result;
        delete body.__headers;
        payload = { ...body, correlationId };
      }
    } catch (err) {
      const apiErr = toApiError(err);
      status = apiErr.status;
      payload = apiErr.toEnvelope(correlationId);
      extraHeaders = null;
      // The cause stays here. The response carries only the envelope.
      logger.error('request.failed', {
        correlationId, code: apiErr.code, method: req.method, path: pathForLog, status,
        cause: apiErr.cause ? String(apiErr.cause.stack || apiErr.cause) : null,
      });
    }

    return finish();

    function finish() {
    try {
      // §3a.2: a 204 still carries the correlation id — it is the only place it can travel.
      res.setHeader('X-Correlation-Id', correlationId);
      if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
      // Cookies survive the error path deliberately: signout must clear the refresh cookie
      // even when the response it accompanies is a failure.
      if (ctxRef && ctxRef.cookies && ctxRef.cookies.length) res.setHeader('Set-Cookie', ctxRef.cookies);
      if (status === 204 || payload === null) { res.writeHead(status); res.end(); }
      else {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      }
    } catch (err) {
      logger.error('response.write.failed', { correlationId, cause: String(err && err.message) });
      try { res.destroy(); } catch { /* already gone */ }
    }

    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info('request', { correlationId, method: req.method, path: pathForLog, status, ms });
    if (onRequestEnd) { try { onRequestEnd({ status, ms, correlationId }); } catch { /* never fatal */ } }
    }
  }
}

/** Handlers return this when they need a status, or headers, other than the default. */
export const raw = (status, body, headers = null) => ({ __raw: true, status, body, headers });

/** Attach response headers to an ordinary 200 result (an ETag, for instance). */
export const withHeaders = (body, headers) => ({ ...body, __headers: headers });
