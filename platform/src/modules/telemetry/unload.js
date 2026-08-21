/** Subject-bound, same-origin sendBeacon ingress. telemetry.md §3.3.2. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../../core/errors.js';
import { isUlid, ulid } from '../../core/ids.js';
import { isWellFormedBuild, buildBelowFloor, raw } from '../../core/http.js';

const TTL_MS = 15 * 60 * 1000;
const COOKIE = 'os_tu';

const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const mac = (secret, body) => createHmac('sha256', secret).update(body).digest('base64url');

function verifySigned(secret, token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const got = Buffer.from(token.slice(dot + 1), 'base64url');
  const want = Buffer.from(mac(secret, body), 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}

function cookieValue(header) {
  for (const part of String(header || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

export function createUnloadIngress({ config, clock = Date, service, store }) {
  if (!store?.tx || !store?.idempotency) throw new Error('telemetry/unload: a durable store is required');
  const currentNonce = new Map();
  const issue = (actor) => {
    const now = clock.now();
    const nonce = ulid(now);
    currentNonce.set(actor.sessionId, nonce);
    const body = enc({ k: 'telemetry-unload', aid: actor.accountId, sid: actor.sessionId,
      iat: now, exp: now + TTL_MS, n: nonce });
    return `${body}.${mac(config.tokenSecret, body)}`;
  };
  const setCookie = (token) => `${COOKIE}=${token}; Path=/v1/telemetry/unload; Max-Age=${TTL_MS / 1000}; HttpOnly; SameSite=Strict${config.env === 'production' ? '; Secure' : ''}`;

  async function actorFrom(ctx) {
    const claims = verifySigned(config.tokenSecret, cookieValue(ctx.headers.cookie));
    if (!claims || claims.k !== 'telemetry-unload' || typeof claims.aid !== 'string'
        || typeof claims.sid !== 'string' || typeof claims.n !== 'string'
        || !Number.isFinite(claims.exp) || clock.now() >= claims.exp
        || currentNonce.get(claims.sid) !== claims.n) {
      return null;
    }
    // The credential is only a transport seam, not a second session system. Revocation of the
    // platform session is authoritative immediately, even while this 15-minute cookie remains.
    const session = await store.sessions.byId(claims.sid);
    if (!session || session.revokedAt || session.accountId !== claims.aid) return null;
    return { kind: 'user', accountId: claims.aid, sessionId: claims.sid };
  }

  async function ingest(ctx) {
    const body = ctx.body || {};
    if (!isUlid(body.correlationId) || !isUlid(body.deliveryId)) {
      throw new ApiError('VALIDATION_FAILED', 'Unload metadata requires ULID correlationId and deliveryId.');
    }
    if (!isWellFormedBuild(body.clientBuild)) {
      throw new ApiError('VALIDATION_FAILED', 'Unload metadata requires a valid clientBuild.');
    }
    if (config.minClientBuild && buildBelowFloor(body.clientBuild, config.minClientBuild)) {
      throw new ApiError('UNSUPPORTED_CLIENT', 'This client build is no longer supported.', {
        details: { reason: 'build', minimumBuild: config.minClientBuild },
      });
    }
    // Reserve before sending to the sink. A crash after this point can lose best-effort
    // telemetry, but can never turn a browser retry into duplicate KPI rows. The transaction
    // advisory lock closes the concurrent first-delivery race on Postgres.
    const dedupeKey = `telemetry-unload:${body.deliveryId}`;
    const actorId = 'telemetry-unload';
    const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const first = await store.tx(async (tx) => {
      await store.idempotency.acquire(dedupeKey, actorId, tx);
      if (await store.idempotency.get(dedupeKey, actorId, tx)) return false;
      await store.idempotency.put({ key: dedupeKey, actorId, requestHash,
        responseStatus: 202, responseBody: { reserved: true },
        expiresAt: new Date(clock.now() + 30 * 60 * 1000).toISOString() }, tx);
      return true;
    });
    if (!first) return raw(202, { accepted: 0, rejected: 0, duplicate: true });

    const actor = await actorFrom(ctx); // never body.accountId
    const result = await service.ingest({ body, actor, correlationId: body.correlationId });
    return raw(202, {
      accepted: result.accepted, rejected: result.rejected, duplicate: false,
      consentReceiptError: result.consentReceiptError,
    });
  }

  return { issue, setCookie, ingest, actorFrom };
}

export function registerUnloadRoutes(router, { ingress, requireAuth }) {
  router.post('/v1/telemetry/unload/credential', async (ctx) => {
    (ctx.cookies ??= []).push(ingress.setCookie(ingress.issue(ctx.actor)));
    return undefined;
  }, { middleware: [requireAuth] });
  // sendBeacon cannot set global headers. This route alone revalidates their exact equivalents
  // from the body before ingestion; every other route retains the global rule.
  router.post('/v1/telemetry/unload', ingress.ingest, { requireBuild: false });
}
