/**
 * HTTP surface for auth and onboarding.  contracts/http-api.md §3, §3a, §11.8.
 *
 * Handlers are thin on purpose: parse, call the service, shape the response. Nothing here
 * decides anything about identity, so a rule cannot be enforced on one route and forgotten on
 * another.
 *
 * **One seam this needs from `core/http.js`.** `createApp` has no hook for response headers,
 * and signup, signin, refresh, signout, and signout-all all have to set or clear the refresh
 * cookie (§3a.4, §11.1). Handlers therefore push cookie strings onto `ctx.cookies` and the
 * composition root applies them with `applyCookies(ctx, res)` below. That file is owned
 * elsewhere; until it grows the hook, the cookie is assembled correctly and simply not
 * written, which is a wiring gap and not a policy gap.
 */
import { ApiError } from '../../core/errors.js';
import { raw } from '../../core/http.js';

const bearer = (headers) => {
  const h = headers?.authorization || headers?.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : null;
};

/** Apply whatever the handlers queued. Called by the composition root once it has `res`. */
export function applyCookies(ctx, res) {
  if (ctx.cookies?.length) res.setHeader('Set-Cookie', ctx.cookies);
}

export function createAuthRoutes({ service, sessions, limiter }) {
  const queueCookie = (ctx, value) => { (ctx.cookies ??= []).push(value); };

  /** **A** — required. Throws `AUTH_REQUIRED` before the handler sees a request. */
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

    router.post('/v1/onboarding/eligibility', handlers.eligibility);
    router.get('/v1/onboarding/consent', handlers.getConsent, O);
    router.put('/v1/onboarding/consent', handlers.putConsent, O);

    router.post('/v1/auth/signup', handlers.signup);
    router.post('/v1/auth/signin', handlers.signin);
    router.post('/v1/auth/refresh', handlers.refresh);
    router.post('/v1/auth/signout', handlers.signout, A);
    router.post('/v1/auth/signout-all', handlers.signoutAll, A);
    router.get('/v1/auth/sessions', handlers.listSessions, A);
    router.delete('/v1/auth/sessions/:id', handlers.revokeSession, A);
    router.post('/v1/auth/recovery/start', handlers.recoveryStart);
    router.post('/v1/auth/recovery/complete', handlers.recoveryComplete);

    router.post('/v1/onboarding/verify/resend', handlers.verifyResend, A);
    router.post('/v1/onboarding/verify/complete', handlers.verifyComplete, A);
    router.get('/v1/onboarding/terms', handlers.terms);
    router.post('/v1/onboarding/terms/accept', handlers.acceptTerms, A);
    return router;
  }

  return { register, handlers, requireAuth, optionalAuth };
}
