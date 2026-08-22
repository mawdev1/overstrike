/**
 * Deployment routes.  contracts/deployment.md §7/§7.1, http-api.md §1/§2/§8.
 *
 * Two client endpoints (reserve, abort) and two S-marked service endpoints (verify-snapshot,
 * timeout release). The S routes mirror `POST /v1/matches/:matchId/result`: no auth middleware,
 * no client-build floor — the caller is a match server, not a client build — and
 * `requireServiceCaller` inside the handler is the gate.
 */
import { ApiError } from '../../core/errors.js';
import { requireServiceCaller } from '../../app.js';
import { requireIdempotencyKey, withIdempotency } from '../../shared/idempotentRoute.js';

function actorId(ctx) {
  const id = ctx.actor?.accountId;
  if (!id) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
  return id;
}

export function registerDeploymentRoutes(router, { service, coreStore, auth }) {
  const mw = auth ? { middleware: [auth] } : {};

  const handlers = {
    /**
     * §7 `POST /v1/deployments` — reserve and lock. `Idempotency-Key` required (§8), and the
     * 409 `DEPLOYMENT_RESERVATION_CONFLICT` is cached under it per §7's own note: a
     * byte-identical replay returns the stored refusal without re-attempting the lock;
     * "retry with the remainder" is a different body under a NEW key.
     */
    async reserve(ctx) {
      const accountId = actorId(ctx);
      const key = requireIdempotencyKey(ctx);
      const { loadoutId = null, instanceIds = null, roomId = null } = ctx.body ?? {};
      return withIdempotency(coreStore, {
        key, actorId: accountId,
        request: { op: 'deployment-reserve', loadoutId, instanceIds, roomId },
        clock: { now: () => ctx.deps.clock() },
        cacheableErrorCodes: ['DEPLOYMENT_RESERVATION_CONFLICT'],
      }, () => service.reserve({
        accountId, loadoutId, instanceIds, roomId, correlationId: ctx.correlationId,
      }));
    },

    /** §7 `DELETE /v1/deployments/:reservationId` — client abort. Idempotent 204 (§5.1). */
    async abort(ctx) {
      await service.releaseAbort({
        accountId: actorId(ctx),
        reservationId: ctx.params.reservationId,
        correlationId: ctx.correlationId,
      });
      return undefined;   // 204 — released now, or already terminal
    },

    /** §7.1 `POST /v1/deployments/:reservationId/verify-snapshot` [S] — §4.5 steps 3–4. */
    async verifySnapshot(ctx) {
      requireServiceCaller(ctx);
      const { matchId, accountId, snapshot } = ctx.body ?? {};
      // The check re-derives matchId/accountId from the VERIFIED payload, never the path — the
      // path segment is a routing convenience (§7.1). These are request-shape requirements.
      const problems = [];
      if (typeof matchId !== 'string' || !matchId) problems.push({ key: 'matchId', reason: 'required' });
      if (typeof accountId !== 'string' || !accountId) problems.push({ key: 'accountId', reason: 'required' });
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        problems.push({ key: 'snapshot', reason: 'required' });
      }
      if (problems.length) {
        throw new ApiError('VALIDATION_FAILED', 'matchId, accountId and snapshot are required.', {
          details: { fields: problems },
        });
      }
      return service.verifySnapshot({ matchId, accountId, snapshot, correlationId: ctx.correlationId });
    },

    /** §7.1 `POST /v1/deployments/:reservationId/release` [S] — timeout report, 204. */
    async releaseTimeout(ctx) {
      requireServiceCaller(ctx);
      await service.releaseTimeout({
        reservationId: ctx.params.reservationId,
        // The service refuses anything but 'timeout' — the caller's service identity is what
        // makes that the only literal this path can produce (§7.1).
        reason: ctx.body?.reason ?? 'timeout',
        correlationId: ctx.correlationId,
      });
      return undefined;   // 204 — released now, or already released/expired
    },
  };

  router.post('/v1/deployments', handlers.reserve, mw);
  router.delete('/v1/deployments/:reservationId', handlers.abort, mw);
  router.post('/v1/deployments/:reservationId/verify-snapshot', handlers.verifySnapshot, { requireBuild: false });
  router.post('/v1/deployments/:reservationId/release', handlers.releaseTimeout, { requireBuild: false });
  return router;
}
