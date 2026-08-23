/**
 * Progression routes.  contracts/progression-economy.md §4, §5.3, §6.3, http-api.md §1/§8.
 *
 * Three client-authenticated endpoints: the read surface, repair, upgrade. All three are
 * caller-scoped — a handler never reads an account id from the body (the same rule
 * `inventory/routes.js` states for the identical reason: that is an impersonation surface).
 */
import { ApiError } from '../../core/errors.js';
import { requireIdempotencyKey, withIdempotency } from '../../shared/idempotentRoute.js';

function actorId(ctx) {
  const id = ctx.actor?.accountId;
  if (!id) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
  return id;
}

const ledgerEntryBody = (e) => ({
  entryId: e.entryId, delta: e.delta, balanceAfter: e.balanceAfter, reason: e.reason,
  runId: e.runId ?? null, instanceId: e.instanceId ?? null, createdAt: e.createdAt,
});

export function registerProgressionRoutes(router, { service, coreStore, auth }) {
  const mw = auth ? { middleware: [auth] } : {};

  const handlers = {
    /** §4 `GET /v1/progression`. */
    async getProgression(ctx) {
      const accountId = actorId(ctx);
      const { account, recentLedger } = await service.getProgression(accountId);
      return {
        accountId,
        opBalance: account.opBalance,
        xp: account.xp,
        level: account.level,
        recentLedger: {
          items: recentLedger.map(ledgerEntryBody),
          nextCursor: null,
          correlationId: ctx.correlationId,
        },
        correlationId: ctx.correlationId,
      };
    },

    /** §5.3 `POST /v1/items/:instanceId/repair`. Idempotency-Key required (http-api.md §8). */
    async repair(ctx) {
      const accountId = actorId(ctx);
      const key = requireIdempotencyKey(ctx);
      return withIdempotency(coreStore, {
        key, actorId: accountId,
        request: { op: 'item-repair', instanceId: ctx.params.instanceId },
        clock: { now: () => ctx.deps.clock() },
      }, () => service.repairInstance({
        accountId, instanceId: ctx.params.instanceId, idempotencyKey: key, correlationId: ctx.correlationId,
      }));
    },

    /** §6.3 `POST /v1/items/:instanceId/upgrade`. Idempotency-Key required (http-api.md §8). */
    async upgrade(ctx) {
      const accountId = actorId(ctx);
      const key = requireIdempotencyKey(ctx);
      return withIdempotency(coreStore, {
        key, actorId: accountId,
        request: { op: 'item-upgrade', instanceId: ctx.params.instanceId },
        clock: { now: () => ctx.deps.clock() },
      }, () => service.upgradeInstance({
        accountId, instanceId: ctx.params.instanceId, idempotencyKey: key, correlationId: ctx.correlationId,
      }));
    },
  };

  router.get('/v1/progression', handlers.getProgression, mw);
  router.post('/v1/items/:instanceId/repair', handlers.repair, mw);
  router.post('/v1/items/:instanceId/upgrade', handlers.upgrade, mw);
  return router;
}
