/**
 * KPI dashboard-query routes.  contracts/telemetry-kpi.md §7.
 *
 * "A lightweight dashboard-query surface... this is instrumentation, not a BI product." Four
 * GET endpoints, each a thin wrapper over one `kpi.js` aggregation, service-gated the same way
 * `settlement.md`'s exception-queue routes are (`settlement/routes.js`'s header note applies
 * verbatim here: real admin sessions are an additive change to these routes, not a reshape).
 */
import { ApiError } from '../../core/errors.js';
import { requireServiceCaller } from '../../app.js';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** `since` is optional; when present it must be a real ISO instant, not a string that merely
 * parses — the same posture event-envelope.md's own `isIsoInstant` takes, restated here rather
 * than importing a module-internal helper across a boundary. */
function readSince(ctx) {
  const raw = ctx.query.get('since');
  if (raw === null || raw === '') return null;
  if (!ISO_RE.test(raw) || Number.isNaN(Date.parse(raw))) {
    throw new ApiError('VALIDATION_FAILED', 'since must be an ISO-8601 UTC instant.', {
      details: { fields: [{ key: 'since', reason: 'not-an-iso-instant' }] },
    });
  }
  return raw;
}

export function registerKpiRoutes(router, { service }) {
  const S = { requireBuild: false };

  const handlers = {
    async extractionFunnel(ctx) {
      requireServiceCaller(ctx);
      return service.extractionFunnel({ since: readSince(ctx) });
    },
    async abandonment(ctx) {
      requireServiceCaller(ctx);
      return service.abandonment({ since: readSince(ctx) });
    },
    async queueHealth(ctx) {
      requireServiceCaller(ctx);
      return service.queueHealth({ since: readSince(ctx) });
    },
    async extractionBalance(ctx) {
      requireServiceCaller(ctx);
      return service.extractionBalance({ since: readSince(ctx) });
    },
  };

  router.get('/v1/admin/kpi/extraction-funnel', handlers.extractionFunnel, S);
  router.get('/v1/admin/kpi/abandonment', handlers.abandonment, S);
  router.get('/v1/admin/kpi/queue-health', handlers.queueHealth, S);
  router.get('/v1/admin/kpi/extraction-balance', handlers.extractionBalance, S);
  return router;
}
