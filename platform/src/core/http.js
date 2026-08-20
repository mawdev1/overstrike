/**
 * The HTTP layer.  contracts/http-api.md §1–§2.
 *
 * Hand-rolled on `node:http`, no framework — the same call this repository already makes for
 * its wire protocol and its collision system. A router, a body reader, and a response writer
 * is roughly 200 lines; a framework is a dependency tree we would then own the security of.
 *
 * Everything a request needs is assembled here so handlers never touch raw node objects:
 * correlation id, auth context, parsed body, typed errors, and the response envelope.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ApiError, toApiError } from './errors.js';
import { ulid } from './ids.js';

const MAX_BODY_BYTES = 256 * 1024;

/** Route table: method -> [{ segments, handler, opts }]. Matching is exact-length, no regex. */
export class Router {
  constructor() { this.routes = { GET: [], POST: [], PUT: [], PATCH: [], DELETE: [] }; }

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
        else params[seg.param] = decodeURIComponent(parts[i]);
      }
      if (ok) return { route, params };
    }
    return null;
  }
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
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError('PAYLOAD_TOO_LARGE', 'Request body is too large.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); }
  catch { throw new ApiError('VALIDATION_FAILED', 'Request body is not valid JSON.'); }
}

/**
 * Build the app.
 *
 * `deps` is everything a handler may reach: db, config, clock, logger, and the domain
 * services. Handlers receive it explicitly rather than importing singletons, so a test can
 * substitute any of them without a module registry.
 */
export function createApp({ router, deps, onRequestEnd = null }) {
  const { logger, config } = deps;

  return createServer(async (req, res) => {
    const startedAt = process.hrtime.bigint();
    // §1: the client's id is echoed; if absent we mint one, because an error path that cannot
    // produce a correlation id is a support ticket nobody can trace.
    const correlationId = req.headers['x-correlation-id'] || ulid();
    const url = new URL(req.url, 'http://localhost');
    const ctx = {
      correlationId,
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      params: {},
      body: {},
      actor: null,          // filled by auth middleware when a token is present
      deps,
      ip: req.socket.remoteAddress || '',
    };

    let status = 500;
    let payload;
    try {
      const hit = router.match(req.method, url.pathname);
      if (!hit) throw new ApiError('NOT_FOUND', 'No such endpoint.');
      ctx.params = hit.params;
      ctx.body = await readJson(req);

      // Client build floor (§1). Checked before the handler so an unsupported client never
      // reaches business logic that assumes a shape it does not send.
      const build = req.headers['x-client-build'];
      if (hit.route.opts.requireBuild !== false && config.minClientBuild && build
          && build < config.minClientBuild) {
        throw new ApiError('UNSUPPORTED_CLIENT', 'Please update the game to continue.',
          { details: { reason: 'build' } });
      }

      for (const mw of hit.route.opts.middleware || []) await mw(ctx);

      const result = await hit.route.handler(ctx);
      if (result && result.__raw) { status = result.status; payload = result.body; }
      else if (result === undefined || result === null) { status = 204; payload = null; }
      else { status = 200; payload = { ...result, correlationId }; }
    } catch (err) {
      const apiErr = toApiError(err);
      status = apiErr.status;
      payload = apiErr.toEnvelope(correlationId);
      // The cause stays here. The response carries only the envelope.
      logger.error('request.failed', {
        correlationId, code: apiErr.code, method: req.method, path: url.pathname,
        status, cause: apiErr.cause ? String(apiErr.cause.stack || apiErr.cause) : null,
      });
    }

    // §11.10: a 204 still carries the correlation id — it is the only place it can travel.
    res.setHeader('X-Correlation-Id', correlationId);
    if (status === 204 || payload === null) { res.writeHead(status); res.end(); }
    else {
      const body = JSON.stringify(payload);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body);
    }

    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info('request', { correlationId, method: req.method, path: url.pathname, status, ms });
    if (onRequestEnd) onRequestEnd({ ctx, status, ms });
  });
}

/** Handlers return this when they need a status other than 200/204. */
export const raw = (status, body) => ({ __raw: true, status, body });

export { randomUUID };
