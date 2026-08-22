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
import { requireCapability } from '../events/rbac.js';
import { sign, verify, opaqueToken, handleOf } from './crypto.js';
import { playerActor, SYSTEM_ACTOR, correlationFor } from './events.js';
import { internalise } from './faults.js';

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
  const { store, config, clock, logger, geo = null, outbox, audit } = deps;
  if (!outbox || !audit) throw new Error('auth/sessions: an outbox and an audit log are required');
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
    return actorFromClaims(claims);
  }

  /**
   * The actor shape, in one place, and it is the shape `rbac.check()` reads.
   *
   * It used to be `{ accountId, sessionId, roles }` while `check()` read `actor.role` and
   * `actor.id`, so every real actor came back `unknown_role` and every capability check in the
   * platform refused — which is only invisible because nothing called one. `accountId` and
   * `roles` stay for the handlers that already use them; `id`, `role`, `kind` and `mfa` are
   * what authorization and the audit trail consume.
   */
  function actorFromClaims(claims) {
    const roles = Array.isArray(claims.r) && claims.r.length ? claims.r : ['player'];
    return {
      kind: 'player',
      id: claims.sub,
      accountId: claims.sub,
      sessionId: claims.sid,
      role: roles[0],
      roles,
      // §10's second factor. Absent from the token today, so an elevated role authenticated
      // here cannot pass an elevated capability check — which is the correct direction to fail.
      mfa: claims.m === true,
      expiresAtMs: claims.exp,
    };
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
      // `issuedAt`, which is the column. `refresh_tokens` has no `createdAt` in either
      // adapter (db-schema.md §2), and sending one made every token mint a schema error.
      issuedAt: iso(clock.now()),
    }, tx);
    return raw;
  }

  /**
   * Create a session and its first token pair. Called by signup and signin.
   *
   * Takes the transaction AND the outbox emitter bound to it: the session row and
   * `session.started` are one write or neither (§4).
   */
  async function start({ accountId, roles = ['player'], ip, userAgent, deviceLabel }, tx, emit) {
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
    await emit({
      type: 'session.started',
      actor: playerActor(accountId, roles),
      subject: { kind: 'session', id: sessionId },
      payload: { deviceLabel: session.deviceLabel, ipClass: session.ipClass, userAgentClass: session.userAgentClass },
      occurredAt: iso(now),
    });
    return {
      accessToken: access.accessToken,
      expiresAt: access.expiresAt,
      refreshToken,
      session: { sessionId, deviceLabel: session.deviceLabel, createdAt: session.createdAt },
    };
  }

  /**
   * Revoke a reused family and say so, in a transaction of its own.
   *
   * This is separate from `rotateOnce` because it CANNOT share its transaction. The revocation
   * and the `session.reuse_detected` event used to be written inside the rotation transaction
   * and then the refusal was thrown from inside it too — and the throw rolled both back. The
   * observable result of "reuse detected" was: `revokedAt` still null, no event in the outbox,
   * the access token still valid, and the family still minting. The detection ran and
   * detected; nothing else was true.
   *
   * So: commit the response first, then refuse. The refusal is a return value up to here.
   */
  async function revokeReusedFamily(row, correlationId) {
    const now = clock.now();
    await internalise(() => audit.recordWithEvent(
      outbox,
      { correlationId, actor: SYSTEM_ACTOR, eventActor: SYSTEM_ACTOR },
      {
        action: 'session.reuse_revoke',
        capability: null,             // system-initiated security response; no operator acted
        subject: { kind: 'session', id: row.sessionId },
        reasonCode: 'security_incident',
        before: { familyId: row.familyId, revoked: false },
        after: { familyId: row.familyId, revoked: true },
      },
      {
        type: 'session.reuse_detected',
        actor: SYSTEM_ACTOR,
        subject: { kind: 'session', id: row.sessionId },
        payload: { familyId: row.familyId, accountId: row.accountId, firstUsedAt: row.usedAt },
        occurredAt: iso(now),
      },
      (tx) => store.sessions.revokeFamily(row.familyId, 'refresh-reuse', iso(now), tx),
    ));
    logger.warn('session.reuse_detected', { familyId: row.familyId, accountId: row.accountId, correlationId });
  }

  async function rotateOnce(raw, { correlationId = null } = {}) {
    const tokenId = handleOf(raw);
    const now = clock.now();
    const outcome = await internalise(() => store.tx(async (tx) => {
      const row = await store.refreshTokens.byId(tokenId, tx);
      if (!row) throw new ApiError('AUTH_TOKEN_INVALID', 'Sign in again.');

      // A used token is theft until proven otherwise, and it cannot be proven otherwise: a
      // legitimate client never replays one. Revoke the family, not just the token — the
      // attacker may already hold the successor. Returned as a sentinel, not thrown: see
      // `revokeReusedFamily`.
      if (row.usedAt) return { reuse: row };

      if (now >= new Date(row.expiresAt).getTime()) throw new ApiError('AUTH_TOKEN_INVALID', 'Sign in again.');

      const session = await store.sessions.byId(row.sessionId, tx);
      if (!session || session.revokedAt) throw new ApiError('AUTH_SESSION_REVOKED', 'You were signed out. Sign in again.');

      // The guard against double-use is `markUsed`'s conditional UPDATE, not the `usedAt`
      // check above — that check only catches reuse this transaction's own SELECT already
      // saw. A genuinely concurrent rotation (another process, another overlapping
      // transaction) races past it and loses here instead: `markUsed` throws CONFLICT when
      // its guarded UPDATE affects zero rows. That loss is still reuse — the token existed
      // and was already spent by the time this call reached it — so it gets the same
      // sentinel treatment as the pre-check above, not a bare error the caller learns
      // nothing from.
      try {
        await store.refreshTokens.markUsed(tokenId, iso(now), tx);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'CONFLICT') {
          const reuseRow = await store.refreshTokens.byId(tokenId, tx);
          return { reuse: reuseRow ?? row };
        }
        throw err;
      }
      const account = await store.accounts.byId(row.accountId, tx);
      const roles = account?.roles ?? ['player'];
      const refreshToken = await mintRefresh(
        { accountId: row.accountId, sessionId: row.sessionId, familyId: row.familyId }, tx);
      const access = issueAccessToken({ accountId: row.accountId, sessionId: row.sessionId, roles });
      return {
        issued: {
          accessToken: access.accessToken,
          expiresAt: access.expiresAt,
          refreshToken,
          session: { sessionId: session.sessionId, deviceLabel: session.deviceLabel, createdAt: session.createdAt },
        },
      };
    }));

    if (outcome.reuse) {
      await revokeReusedFamily(outcome.reuse, correlationFor(correlationId, now));
      throw new ApiError('AUTH_SESSION_REVOKED', 'You were signed out. Sign in again.');
    }
    return outcome.issued;
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

  async function list(accountIdOrActor, currentSessionId) {
    // Accepts an actor or a bare account id: the routes hand over the authenticated actor and
    // the check applies; internal callers and tests that hold only an id read without one.
    const actor = typeof accountIdOrActor === 'object' && accountIdOrActor !== null ? accountIdOrActor : null;
    const accountId = actor ? actor.accountId : accountIdOrActor;
    if (actor) requireCapability(actor, 'session:list', { accountId });
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

  /**
   * Revoke one session.
   *
   * `actor` is the authenticated actor, not a caller-supplied role string: the previous
   * signature took `actorRole` and wrote whatever it was handed into the event, which is an
   * attribution the caller gets to choose. The capability is asserted here rather than in the
   * route, so calling the service directly cannot skip it.
   */
  async function revoke({ actor, accountId = actor?.accountId, sessionId, reason = 'user-signout', correlationId = null }) {
    requireCapability(actor, 'session:revoke', { accountId });
    const session = await store.sessions.byId(sessionId);
    // NOT_FOUND rather than FORBIDDEN for someone else's session: whether a session id exists
    // is not something one account gets to learn about another.
    if (!session || session.accountId !== accountId) {
      throw new ApiError('NOT_FOUND', 'No such session.');
    }
    const now = clock.now();
    await internalise(() => audit.recordWithEvent(
      outbox,
      { correlationId: correlationFor(correlationId, now), actor },
      {
        action: 'session.revoke',
        subject: { kind: 'session', id: sessionId },
        target: { accountId },
        reasonCode: 'account_self_service',
        before: { revokedAt: null }, after: { revokedAt: iso(now), reason },
      },
      {
        type: 'session.revoked',
        actor: playerActor(accountId, actor.roles),
        subject: { kind: 'session', id: sessionId },
        payload: { reason },
        occurredAt: iso(now),
      },
      (tx) => store.sessions.revoke(sessionId, reason, iso(now), tx),
    ));
  }

  /**
   * Revoke every session for an account, one `session.revoked` per session.
   *
   * Not one event for the account: §6 registers `session.revoked` against a **session**
   * subject, and §3 orders events per subject — a single account-subject event is both
   * off-catalogue (it was rejected outright by the envelope validator) and unorderable against
   * the session it silently ends.
   *
   * `actor` is optional: recovery completion revokes on the account holder's behalf without an
   * authenticated session, so it passes the account itself as the actor and no capability
   * check applies (proving control of the recovery token is the authorization).
   */
  async function revokeAll({ actor = null, accountId = actor?.accountId, reason = 'signout-all', correlationId = null }) {
    if (actor) requireCapability(actor, 'session:revoke', { accountId });
    const now = clock.now();
    const live = (await store.sessions.listForAccount(accountId)).filter((s) => !s.revokedAt);
    // Nothing to revoke is not a state change, and a unit of work that changes nothing must
    // not write an event or an audit row claiming it did.
    if (!live.length) return 0;

    const auditActor = actor ?? playerActor(accountId);
    const { result } = await internalise(() => outbox.commit(
      { correlationId: correlationFor(correlationId, now), actor: auditActor },
      async (tx, emit) => {
        const count = await store.sessions.revokeAllForAccount(accountId, reason, iso(now), tx);
        for (const s of live) {
          await emit({
            type: 'session.revoked',
            actor: playerActor(accountId, actor?.roles),
            subject: { kind: 'session', id: s.sessionId },
            payload: { reason },
            occurredAt: iso(now),
          });
        }
        await audit.record({
          actor: { ...auditActor, accountId },
          action: 'session.revoke_all',
          // Named, not derived: the action is `revoke_all`, the capability is still
          // `session:revoke`. Null only for the recovery path, which has no operator actor.
          capability: actor ? 'session:revoke' : null,
          subject: { kind: 'account', id: accountId },
          target: { accountId },
          reasonCode: reason === 'recovery-completed' ? 'account_recovery' : 'account_self_service',
          before: { liveSessions: live.length }, after: { liveSessions: 0, reason },
          correlationId: correlationFor(correlationId, now),
        }, tx);
        return count;
      },
    ));
    return result;
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
