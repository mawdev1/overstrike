/**
 * HTTP surface for auth and onboarding.  contracts/http-api.md §3, §3a, §11.8.
 *
 * Handlers are thin on purpose: parse, call the service, shape the response. Nothing here
 * decides anything about identity, so a rule cannot be enforced on one route and forgotten on
 * another.
 *
 * **The cookie seam.** Signup, signin, refresh, signout, signout-all and recovery-complete all
 * have to set or clear the refresh cookie (§3a.4, §11.1), and a handler cannot express a
 * response header through a return value. Handlers therefore push cookie strings onto
 * `ctx.cookies`, and `core/http.js` writes them in `finish()` — on the error path too, because
 * signout must clear the credential even when the response it accompanies fails.
 *
 * This file used to also export an `applyCookies(ctx, res)` for a composition root to call,
 * written when `createApp` had no such hook. `core/http.js` grew the hook and nothing ever
 * called the stand-in, so it was a second, dead implementation of the one rule that decides
 * whether a session persists — removed rather than left as a thing to keep in step. The
 * behaviour it described is asserted over a real socket in `apptest.mjs` §7d.
 */
import { ApiError } from '../../core/errors.js';
import { raw } from '../../core/http.js';

const bearer = (headers) => {
  const h = headers?.authorization || headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : null;
};

export function createAuthRoutes({ service, sessions, limiter }) {
  const queueCookie = (ctx, value) => { (ctx.cookies ??= []).push(value); };

  /**
   * **A** — required. Throws `AUTH_REQUIRED` before the handler sees a request.
   *
   * The `!token` line below is a BACKSTOP, not the only check: `sessions.verifyAccessToken`
   * opens with the same refusal, with the same code and the same message. A mutation sweep
   * therefore cannot kill this line — deleting it was measured against every shape a missing
   * credential takes (no header, `Bearer` with only whitespace, a `Basic` header) and the
   * status, code, message and side effects are byte-identical either way. That is a redundancy
   * fact rather than an untested line, and the OBSERVABLE contract it belongs to — an
   * unauthenticated call to an `A` route is 401 `AUTH_REQUIRED` — is asserted over a socket in
   * `apptest.mjs` §7d. Kept because a middleware that reaches into the session service to find
   * out whether it was given a credential is a worse shape than one that checks first.
   */
  const requireAuth = async (ctx) => {
    const token = bearer(ctx.headers);
    if (!token) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
    ctx.actor = await sessions.authenticate(token);
  };

  /**
   * Auth-*optional*, for consent (§3a.3). A bad token here is still a bad token: it is
   * rejected rather than quietly downgraded to signed-out, or an expired session would
   * silently start writing consent against a client session id instead of the account.
   */
  const optionalAuth = async (ctx) => {
    const token = bearer(ctx.headers);
    ctx.actor = token ? await sessions.authenticate(token) : null;
  };

  const issuedBody = (ctx, issued) => {
    queueCookie(ctx, sessions.refreshCookie(issued.refreshToken));
    return {
      accessToken: issued.accessToken,
      expiresAt: issued.expiresAt,
      session: issued.session,
      profile: issued.profile,
      consentReceipt: issued.consentReceipt ?? null,
      correlationId: ctx.correlationId,
    };
  };

  const handlers = {
    async signup(ctx) {
      const issued = await service.signup({
        ...ctx.body, ip: ctx.ip, userAgent: ctx.headers['user-agent'], correlationId: ctx.correlationId,
      });
      // `verificationToken` is a service return, not a response field. It goes to the mailer.
      return raw(201, issuedBody(ctx, issued));
    },

    async signin(ctx) {
      const issued = await service.signin({
        ...ctx.body, ip: ctx.ip, userAgent: ctx.headers['user-agent'], correlationId: ctx.correlationId,
      });
      return issuedBody(ctx, issued);
    },

    /** Empty body by contract: the credential travels only as an httpOnly cookie (§11.1). */
    async refresh(ctx) {
      limiter.enforceAuth({ ip: ctx.ip, subject: null });
      const cookie = sessions.readRefreshCookie(ctx.headers);
      // Same backstop relationship as `requireAuth` above: `sessions.rotate` refuses a
      // non-string or empty handle with this exact code, so deleting this line changes no
      // observable behaviour for any cookie shape (absent, or present but not `os_rt`). The
      // contract — refresh without the credential is 401 `AUTH_TOKEN_INVALID` — is asserted
      // over a socket in `apptest.mjs` §7d.
      if (!cookie) throw new ApiError('AUTH_TOKEN_INVALID', 'Sign in again.');
      const issued = await sessions.rotate(cookie, { correlationId: ctx.correlationId });
      queueCookie(ctx, sessions.refreshCookie(issued.refreshToken));
      return { accessToken: issued.accessToken, expiresAt: issued.expiresAt, session: issued.session };
    },

    /**
     * The actor comes from `sessions.authenticate` and is passed through whole. Handlers used
     * to forward `accountId` alone, which meant the service had no actor to authorise and the
     * §10 capability check had nothing to check.
     */
    async signout(ctx) {
      await sessions.revoke({
        actor: ctx.actor, sessionId: ctx.actor.sessionId,
        reason: 'user-signout', correlationId: ctx.correlationId,
      });
      queueCookie(ctx, sessions.clearRefreshCookie());
    },

    async signoutAll(ctx) {
      await sessions.revokeAll({ actor: ctx.actor, correlationId: ctx.correlationId });
      queueCookie(ctx, sessions.clearRefreshCookie());
    },

    async listSessions(ctx) {
      return { sessions: await sessions.list(ctx.actor, ctx.actor.sessionId) };
    },

    async revokeSession(ctx) {
      await sessions.revoke({
        actor: ctx.actor, sessionId: ctx.params.id,
        reason: 'user-revoked', correlationId: ctx.correlationId,
      });
    },

    /** Always 202. The body is byte-identical whether or not the account exists. */
    async recoveryStart(ctx) {
      await service.recoveryStart({ email: ctx.body.email, ip: ctx.ip, correlationId: ctx.correlationId });
      return raw(202, { correlationId: ctx.correlationId });
    },

    async recoveryComplete(ctx) {
      await service.recoveryComplete({ ...ctx.body, ip: ctx.ip, correlationId: ctx.correlationId });
      queueCookie(ctx, sessions.clearRefreshCookie());
    },

    // §9's auth class covers the whole of onboarding, not just the endpoints with passwords on
    // them: eligibility mints a receipt signup accepts, and consent writes a legally
    // significant row. Both now carry `ip` so the limiter has a subject to count.
    eligibility(ctx) {
      return service.eligibilityPreflight({
        dateOfBirth: ctx.body.dateOfBirth, jurisdiction: ctx.body.jurisdiction ?? null, ip: ctx.ip,
      });
    },

    getConsent(ctx) {
      return service.getConsent({ actor: ctx.actor, clientSessionId: ctx.query.get('clientSessionId') });
    },

    putConsent(ctx) {
      // Spread first: a body field named `ip` or `actor` must not be able to override the
      // request's own.
      return service.putConsent({ ...ctx.body, actor: ctx.actor, ip: ctx.ip, correlationId: ctx.correlationId });
    },

    async checkDisplayName(ctx) {
      // §3b: "a bearer token is accepted and changes nothing" — no auth middleware, and the
      // handler never reads ctx.actor. A signed-in player renaming and a signed-out player
      // choosing a first name get identical verdicts, which is what makes this cacheable in
      // the client's head rather than per-session.
      return service.checkDisplayName({ displayName: ctx.body?.displayName });
    },

    async verifyResend(ctx) {
      await service.verificationResend({ actor: ctx.actor, ip: ctx.ip, correlationId: ctx.correlationId });
      return raw(202, { correlationId: ctx.correlationId });
    },

    async verifyComplete(ctx) {
      await service.verificationComplete({ actor: ctx.actor, token: ctx.body.token, correlationId: ctx.correlationId });
    },

    terms() { return service.termsGet(); },

    async acceptTerms(ctx) {
      await service.termsAccept({ actor: ctx.actor, version: ctx.body.version, correlationId: ctx.correlationId });
    },
  };

  /** Register on a `core/http.js` Router. Order matches the approved onboarding chain. */
  function register(router) {
    const A = { middleware: [requireAuth] };
    const O = { middleware: [optionalAuth] };

    /**
     * §9's Auth class, enforced by this module rather than by the generic method-derived one.
     *
     * `core/http.js` charges every client route a `read` or `write` budget. These five are the
     * ones §9 names for the Auth class instead — 10/min per IP AND 5/min per account, two
     * buckets, which `modules/auth/ratelimit.js` already implements. Letting the generic class
     * apply as well would debit `write` for the same request and make whichever number is
     * stricter a fiction. The rest of this module's routes are ordinary reads and writes.
     */
    const AUTH_CLASS = { rateLimitClass: null };

    router.post('/v1/onboarding/eligibility', handlers.eligibility);
    router.get('/v1/onboarding/consent', handlers.getConsent, O);
    router.put('/v1/onboarding/consent', handlers.putConsent, O);

    router.post('/v1/auth/signup', handlers.signup, AUTH_CLASS);
    router.post('/v1/auth/signin', handlers.signin, AUTH_CLASS);
    router.post('/v1/auth/refresh', handlers.refresh, AUTH_CLASS);
    router.post('/v1/auth/signout', handlers.signout, A);
    router.post('/v1/auth/signout-all', handlers.signoutAll, A);
    router.get('/v1/auth/sessions', handlers.listSessions, A);
    router.delete('/v1/auth/sessions/:id', handlers.revokeSession, A);
    router.post('/v1/auth/recovery/start', handlers.recoveryStart, AUTH_CLASS);
    router.post('/v1/auth/recovery/complete', handlers.recoveryComplete, AUTH_CLASS);

    // §3b availability preflight. Public: the shell calls it before an account exists.
    router.post('/v1/auth/display-name/check', handlers.checkDisplayName);

    router.post('/v1/onboarding/verify/resend', handlers.verifyResend, A);
    router.post('/v1/onboarding/verify/complete', handlers.verifyComplete, A);
    router.get('/v1/onboarding/terms', handlers.terms);
    router.post('/v1/onboarding/terms/accept', handlers.acceptTerms, A);
    return router;
  }

  return { register, handlers, requireAuth, optionalAuth };
}
