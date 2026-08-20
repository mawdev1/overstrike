/**
 * Tokens and sessions.  contracts/auth.md §3–§5, contracts/http-api.md §11.1.
 *
 * Two tokens, not one. A short-lived signed access token that lives in memory on the client,
 * and an opaque rotating refresh handle that lives in an httpOnly cookie. The split exists so
 * that XSS in a page rendering player-authored names and chat gets at most fifteen minutes and
 * cannot exfiltrate anything durable.
 *
 * The rules that are ours to implement rather than to assume from a provider:
 *   - rotation on every refresh, with reuse of a rotated token treated as theft;
 *   - revocation that takes effect on the next request, not at the next expiry.
 */
import { ApiError } from '../../core/errors.js';
import { ulid } from '../../core/ids.js';
import { sign, verify, opaqueToken, handleOf } from './crypto.js';
import { makeEvent, emit } from './events.js';

export const REFRESH_COOKIE = 'os_rt';

/**
 * A session list is readable by whoever holds the account — including whoever just stole it.
 * Handing that person the owner's home address makes a compromise materially worse, so the
 * row stores a class and the raw address never reaches the database at all.
 */
export function classifyIp(ip, geo = null) {
  if (!ip) return 'unknown';
  const addr = String(ip).replace(/^::ffff:/, '');
  if (addr === '127.0.0.1' || addr === '::1') return 'local';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd)/i.test(addr)) return 'private';
  // Real geo resolution is an infrastructure concern; without it we say so rather than
  // storing the address "temporarily", which is how addresses end up stored permanently.
  return geo?.classify?.(addr) ?? 'unknown';
}

/** Coarse enough to recognise your own device in the list, too coarse to fingerprint you. */
export function classifyUserAgent(ua) {
  const s = String(ua || '');
  if (!s) return 'unknown';
  const engine = /Firefox\//.test(s) ? 'firefox'
    : /Edg\//.test(s) ? 'edge'
    : /Chrome\//.test(s) ? 'chrome'
    : /Safari\//.test(s) ? 'safari'
    : 'other';
  const platform = /Android|iPhone|iPad|Mobile/.test(s) ? 'mobile' : 'desktop';
  return `${engine}-${platform}`;
}

export function createSessionService(deps) {
  const { store, config, clock, logger, geo = null } = deps;
  const accessTtlMs = config.accessTokenTtlSec * 1000;
  const refreshTtlMs = config.refreshTokenTtlSec * 1000;

  /**
   * Server-side single-flight, keyed by refresh handle.
   *
   * `auth.md` §4 makes single-flight the *client's* obligation and calls it the most likely
   * bug in the contract. This is the server's half of that: ten concurrent presentations of
   * one token are serialised, so exactly one of them rotates and the other nine are seen for
   * what they are — replays of a used token. Without the queue they interleave between the
   * `usedAt` read and the write, and several succeed silently, which is precisely the outcome
   * reuse detection exists to make impossible.
   */
  const inflight = new Map();

  const iso = (ms) => new Date(ms).toISOString();

  function issueAccessToken({ accountId, sessionId, roles }) {
    const issuedAt = clock.now();
    const expiresAt = issuedAt + accessTtlMs;
    // `jti` is not used for revocation — that is `sid`, per §5 — but without it two tokens
    // issued for one session in the same millisecond are byte-identical, and then a log
    // cannot tell one issuance from the next.
    const token = sign(config.tokenSecret, {
      k: 'access', sub: accountId, sid: sessionId, r: roles, iat: issuedAt, exp: expiresAt,
      jti: ulid(issuedAt),
    });
    return { accessToken: token, expiresAt: iso(expiresAt), expiresAtMs: expiresAt };
  }

  /**
   * Signature first, expiry second.
   *
   * A forged token is `AUTH_TOKEN_INVALID` even when its `exp` claim is in the past; checking
   * expiry first would let an attacker learn that a forgery was otherwise well-formed by the
   * code it came back with, and `AUTH_TOKEN_EXPIRED` is the one code the client retries.
   */
  function verifyAccessToken(token) {
    if (!token) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
    const claims = verify(config.tokenSecret, token);
    if (!claims || claims.k !== 'access') throw new ApiError('AUTH_TOKEN_INVALID', 'Sign in again.');
    if (clock.now() >= claims.exp) throw new ApiError('AUTH_TOKEN_EXPIRED', 'Your session expired. Sign in again.');
    return { accountId: claims.sub, sessionId: claims.sid, roles: claims.r || ['player'], expiresAtMs: claims.exp };
  }

  /**
   * The denylist check of §5, and the reason revocation is immediate: a valid signature is
   * necessary but not sufficient, on every request, until the token's natural expiry passes.
   */
  async function authenticate(token) {
    const actor = verifyAccessToken(token);
    const session = await store.sessions.byId(actor.sessionId);
    if (!session || session.revokedAt) {
      throw new ApiError('AUTH_SESSION_REVOKED', 'You were signed out. Sign in again.');
    }
    if (store.sessions.touch) await store.sessions.touch(actor.sessionId, iso(clock.now()));
    return actor;
  }

  async function mintRefresh({ accountId, sessionId, familyId }, tx) {
    const raw = opaqueToken();
    await store.refreshTokens.create({
      tokenId: handleOf(raw),
      familyId,
      accountId,
      sessionId,
      expiresAt: iso(clock.now() + refreshTtlMs),
      usedAt: null,
      createdAt: iso(clock.now()),
    }, tx);
    return raw;
  }

  /** Create a session and its first token pair. Called by signup, signin, and recovery. */
  async function start({ accountId, roles = ['player'], ip, userAgent, deviceLabel, correlationId = null }, tx) {
    const now = clock.now();
    const sessionId = ulid(now);
    const familyId = ulid(now);
    const session = await store.sessions.create({
      sessionId,
      accountId,
      deviceLabel: deviceLabel || classifyUserAgent(userAgent),
      userAgentClass: classifyUserAgent(userAgent),
      ipClass: classifyIp(ip, geo),
      createdAt: iso(now),
      lastSeenAt: iso(now),
      revokedAt: null,
      revokedReason: null,
      refreshFamilyId: familyId,
    }, tx);
    const refreshToken = await mintRefresh({ accountId, sessionId, familyId }, tx);
    const access = issueAccessToken({ accountId, sessionId, roles });
    await emit(store, makeEvent('session.started', {
      actor: { kind: 'player', id: accountId, role: roles[0] ?? 'player' },
      subject: { kind: 'session', id: sessionId },
      payload: { deviceLabel: session.deviceLabel, ipClass: session.ipClass, userAgentClass: session.userAgentClass },
      correlationId, occurredAt: now,
    }), tx);
    return {
      accessToken: access.accessToken,
      expiresAt: access.expiresAt,
      refreshToken,
      session: { sessionId, deviceLabel: session.deviceLabel, createdAt: session.createdAt },
    };
  }

  async function rotateOnce(raw, { correlationId = null } = {}) {
    const tokenId = handleOf(raw);
    const now = clock.now();
    return store.tx(async (tx) => {
      const row = await store.refreshTokens.byId(tokenId, tx);
      if (!row) throw new ApiError('AUTH_TOKEN_INVALID', 'Sign in again.');

      // A used token is theft until proven otherwise, and it cannot be proven otherwise: a
      // legitimate client never replays one. Revoke the family, not just the token — the
      // attacker may already hold the successor.
      if (row.usedAt) {
        await store.sessions.revokeFamily(row.familyId, 'refresh-reuse', iso(now), tx);
        await emit(store, makeEvent('session.reuse_detected', {
          actor: { kind: 'system', id: 'auth', role: 'service' },
          subject: { kind: 'session', id: row.sessionId },
          payload: { familyId: row.familyId, accountId: row.accountId, firstUsedAt: row.usedAt },
          correlationId, occurredAt: now,
        }), tx);
        logger.warn('session.reuse_detected', { familyId: row.familyId, accountId: row.accountId, correlationId });
        throw new ApiError('AUTH_SESSION_REVOKED', 'You were signed out. Sign in again.');
      }

      if (now >= new Date(row.expiresAt).getTime()) throw new ApiError('AUTH_TOKEN_INVALID', 'Sign in again.');

      const session = await store.sessions.byId(row.sessionId, tx);
      if (!session || session.revokedAt) throw new ApiError('AUTH_SESSION_REVOKED', 'You were signed out. Sign in again.');

      await store.refreshTokens.markUsed(tokenId, iso(now), tx);
      const account = await store.accounts.byId(row.accountId, tx);
      const roles = account?.roles ?? ['player'];
      const refreshToken = await mintRefresh(
        { accountId: row.accountId, sessionId: row.sessionId, familyId: row.familyId }, tx);
      const access = issueAccessToken({ accountId: row.accountId, sessionId: row.sessionId, roles });
      return {
        accessToken: access.accessToken,
        expiresAt: access.expiresAt,
        refreshToken,
        session: { sessionId: session.sessionId, deviceLabel: session.deviceLabel, createdAt: session.createdAt },
      };
    });
  }

  /** Serialised per token handle — see `inflight` above. */
  function rotate(raw, meta = {}) {
    if (typeof raw !== 'string' || !raw) throw new ApiError('AUTH_TOKEN_INVALID', 'Sign in again.');
    const key = handleOf(raw);
    const previous = inflight.get(key) ?? Promise.resolve();
    const run = previous.then(() => rotateOnce(raw, meta));
    // The queue tail must never reject, or the next waiter inherits someone else's failure.
    const tail = run.then(() => {}, () => {});
    inflight.set(key, tail);
    tail.then(() => { if (inflight.get(key) === tail) inflight.delete(key); });
    return run;
  }

  async function list(accountId, currentSessionId) {
    const rows = await store.sessions.listForAccount(accountId);
    return rows.filter((s) => !s.revokedAt).map((s) => ({
      sessionId: s.sessionId,
      deviceLabel: s.deviceLabel,
      userAgentClass: s.userAgentClass,
      ipClass: s.ipClass,               // a class. Never an address. auth.md §5.
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      isCurrent: s.sessionId === currentSessionId,
    }));
  }

  async function revoke({ accountId, sessionId, reason = 'user-signout', correlationId = null, actorRole = 'player' }) {
    const session = await store.sessions.byId(sessionId);
    // NOT_FOUND rather than FORBIDDEN for someone else's session: whether a session id exists
    // is not something one account gets to learn about another.
    if (!session || session.accountId !== accountId) {
      throw new ApiError('NOT_FOUND', 'No such session.');
    }
    const now = clock.now();
    await store.tx(async (tx) => {
      await store.sessions.revoke(sessionId, reason, iso(now), tx);
      await emit(store, makeEvent('session.revoked', {
        actor: { kind: 'player', id: accountId, role: actorRole },
        subject: { kind: 'session', id: sessionId },
        payload: { reason },
        correlationId, occurredAt: now,
      }), tx);
    });
  }

  async function revokeAll({ accountId, reason = 'signout-all', correlationId = null }) {
    const now = clock.now();
    return store.tx(async (tx) => {
      const count = await store.sessions.revokeAllForAccount(accountId, reason, iso(now), tx);
      await emit(store, makeEvent('session.revoked', {
        actor: { kind: 'player', id: accountId, role: 'player' },
        subject: { kind: 'account', id: accountId },
        payload: { reason, count },
        correlationId, occurredAt: now,
      }), tx);
      return count;
    });
  }

  /**
   * `Path=/v1/auth` so the credential is not attached to every request in the app, and
   * `SameSite=Lax` so a cross-site POST cannot silently spend it.
   */
  function refreshCookie(raw) {
    const maxAge = Math.floor(refreshTtlMs / 1000);
    return `${REFRESH_COOKIE}=${raw}; Max-Age=${maxAge}; Path=/v1/auth; Secure; HttpOnly; SameSite=Lax`;
  }

  const clearRefreshCookie = () =>
    `${REFRESH_COOKIE}=; Max-Age=0; Path=/v1/auth; Secure; HttpOnly; SameSite=Lax`;

  function readRefreshCookie(headers = {}) {
    const raw = headers.cookie || headers.Cookie || '';
    for (const part of String(raw).split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === REFRESH_COOKIE) return part.slice(eq + 1).trim();
    }
    return null;
  }

  return {
    issueAccessToken, verifyAccessToken, authenticate,
    start, rotate, list, revoke, revokeAll,
    refreshCookie, clearRefreshCookie, readRefreshCookie,
  };
}
