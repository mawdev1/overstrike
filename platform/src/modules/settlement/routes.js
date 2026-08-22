/**
 * Settlement routes.  contracts/settlement.md §5 (run-result submission) and §7 (the
 * exception queue's operational surface), http-api.md §1/§2/§8.
 *
 * Every route here is service-gated. §5 rule 1 makes result submission service-only outright —
 * a client that can post its own run outcome grants itself loot. The §7 queue endpoints are the
 * Admin Portal / support-operator surface; until an admin-authenticated HTTP surface exists
 * (auth.md §10's elevated roles have no route-level middleware yet), they take the same
 * service-token gate as every other S route, and `operatorId`/`reviewedBy` in the body is the
 * attributed human — the same posture §7.4 step 6's audit rows require. Loosening this to real
 * admin sessions is an additive change to these routes, not a reshape.
 */
import { ApiError } from '../../core/errors.js';
import { requireServiceCaller } from '../../app.js';

const requiredString = (value, key, problems) => {
  if (typeof value !== 'string' || !value.trim()) problems.push({ key, reason: 'required' });
};

export function registerSettlementRoutes(router, { service, store }) {
  const S = { requireBuild: false };

  const handlers = {
    /**
     * §5 `POST /v1/runs/:runId/result` [SERVICE ONLY].
     *
     * §5 rule 6: the path `runId` is authoritative, the body's must match it, and the
     * Idempotency-Key must be exactly `run-result:<runId>` — the service validates the key;
     * the path/body agreement is a statement about the request and is checked here.
     */
    async submitRunResult(ctx) {
      requireServiceCaller(ctx);
      const runId = ctx.params.runId;
      const body = ctx.body ?? {};
      if (body.runId !== undefined && body.runId !== runId) {
        throw new ApiError('VALIDATION_FAILED', 'The result names a different run than the path.', {
          details: { fields: [{ key: 'runId', reason: 'path-mismatch', expected: runId, got: body.runId }] },
        });
      }
      const header = ctx.headers?.['idempotency-key'];
      return service.submitRunResult({
        actor: { kind: 'service', id: 'match-server', role: 'service' },
        runResult: { ...body, runId },
        idempotencyKey: typeof header === 'string' && header.trim() ? header.trim() : null,
        correlationId: ctx.correlationId,
      });
    },

    /** §7.4 step 2 — the queryable queue: filter by status/runId/accountId/trigger. */
    async listExceptions(ctx) {
      requireServiceCaller(ctx);
      const status = ctx.query.get('status');
      if (status !== null && !['open', 'in-review', 'resolved'].includes(status)) {
        throw new ApiError('VALIDATION_FAILED', 'Unknown exception status.', {
          details: { fields: [{ key: 'status', reason: 'enum', allowed: ['open', 'in-review', 'resolved'] }] },
        });
      }
      const items = await store.settlementExceptions.list({
        status: status ?? null,
        runId: ctx.query.get('runId') || null,
        accountId: ctx.query.get('accountId') || null,
        trigger: ctx.query.get('trigger') || null,
      });
      return { items };
    },

    async getException(ctx) {
      requireServiceCaller(ctx);
      const row = await store.settlementExceptions.byId(ctx.params.exceptionId);
      if (!row) throw new ApiError('NOT_FOUND', 'No such settlement exception.');
      return row;
    },

    /** §7.4 step 3 — optimistic-locked claim on `updatedAt`. */
    async claimException(ctx) {
      requireServiceCaller(ctx);
      const { operatorId, expectedUpdatedAt } = ctx.body ?? {};
      const problems = [];
      requiredString(operatorId, 'operatorId', problems);
      requiredString(expectedUpdatedAt, 'expectedUpdatedAt', problems);
      if (problems.length) {
        throw new ApiError('VALIDATION_FAILED', 'operatorId and expectedUpdatedAt are required.', {
          details: { fields: problems },
        });
      }
      return service.claimException({
        exceptionId: ctx.params.exceptionId, operatorId, expectedUpdatedAt,
      });
    },

    /** §7.4 step 4 — resolve with one of §4's dispositions, or `void`. Notes are required. */
    async resolveException(ctx) {
      requireServiceCaller(ctx);
      const { resolution, resolutionNotes, resolutionEvidenceRef = null, reviewedBy } = ctx.body ?? {};
      const problems = [];
      requiredString(resolution, 'resolution', problems);
      requiredString(reviewedBy, 'reviewedBy', problems);
      if (problems.length) {
        throw new ApiError('VALIDATION_FAILED', 'resolution and reviewedBy are required.', {
          details: { fields: problems },
        });
      }
      return service.resolveException({
        exceptionId: ctx.params.exceptionId,
        resolution, resolutionNotes, resolutionEvidenceRef, reviewedBy,
        correlationId: ctx.correlationId,
      });
    },

    /**
     * §7.2's stall detector, ops-triggered. The timeout is `SETTLEMENT_STALL_MS` platform
     * config, never hardcoded and never caller-chosen — an operator who could pass 0 could
     * open an exception on every freshly-ended run.
     */
    async checkStalls(ctx) {
      requireServiceCaller(ctx);
      const opened = await service.checkStalls({
        timeoutMs: ctx.deps.config.settlementStallMs,
        correlationId: ctx.correlationId,
      });
      return { opened };
    },
  };

  router.post('/v1/runs/:runId/result', handlers.submitRunResult, S);
  router.get('/v1/settlement/exceptions', handlers.listExceptions, S);
  router.get('/v1/settlement/exceptions/:exceptionId', handlers.getException, S);
  router.post('/v1/settlement/exceptions/:exceptionId/claim', handlers.claimException, S);
  router.post('/v1/settlement/exceptions/:exceptionId/resolve', handlers.resolveException, S);
  router.post('/v1/settlement/stall-check', handlers.checkStalls, S);
  return router;
}
