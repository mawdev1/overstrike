/**
 * P4-05 KPI aggregation.  contracts/telemetry-kpi.md §3–§6.
 *
 * "Build the DASHBOARDS/DEFINITIONS, not the analysis — there is no usage data yet." This
 * module is the query surface those definitions need: it reads durable platform events
 * (`event-envelope.md`, already flowing through the existing outbox — no second pipeline) and
 * turns them into the counts telemetry-kpi.md names. It draws no conclusions and sets no
 * thresholds; a caller decides what a number means.
 *
 * Every function is a read over `store.outbox.listByType` plus, where the funnel needs a
 * ratio, simple in-memory grouping. Nothing here writes anything or touches the tick loop —
 * this is the admin/dashboard path, explicitly out of the match server's way.
 */

const bucket = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const asObject = (map) => Object.fromEntries(map);

/**
 * @param {object} deps
 * @param {{outbox: {listByType: Function}}} deps.store
 */
export function createKpiService({ store }) {
  if (!store || typeof store.outbox?.listByType !== 'function') {
    throw new Error('createKpiService: store.outbox.listByType is required');
  }

  const eventsSince = (type, since) => store.outbox.listByType(type, { since });

  /**
   * telemetry-kpi.md §3 — the run-failure funnel: where do extraction runs die.
   *
   * Three stages, each backed by events that already exist and already flow through the
   * outbox (no new instrumentation was added to produce them):
   *   deploy → `deployment.reserved` vs `deployment.released` (reservation never became a run)
   *   raid   → `deployment.snapshot.consumed` (admitted) vs `run.settled` outcome died/aborted
   *   exit   → `run.settled` outcome extracted
   */
  async function extractionFunnel({ since = null } = {}) {
    const [reserved, released, admitted, settled] = await Promise.all([
      eventsSince('deployment.reserved', since),
      eventsSince('deployment.released', since),
      eventsSince('deployment.snapshot.consumed', since),
      eventsSince('run.settled', since),
    ]);

    const settledByOutcome = new Map();
    for (const e of settled) bucket(settledByOutcome, e.payload?.outcome ?? 'unknown');

    return {
      windowSince: since,
      deploy: { reserved: reserved.length, released: released.length },
      raid: { admitted: admitted.length, byOutcome: asObject(settledByOutcome) },
      exit: { extracted: settledByOutcome.get('extracted') ?? 0 },
    };
  }

  /**
   * telemetry-kpi.md §4 — abandonment points, one per stage a player can leave from.
   *
   *   pre-deploy    → not this store's concern; `lobby.abandoned` (telemetry.md §3.1) lives in
   *                   the client-telemetry warehouse, out of this platform store's reach
   *   deploy-stage  → `deployment.released`, grouped by `releasedReason` (abort/timeout/expiry)
   *   raid-stage    → `run.settled` outcome `aborted` (disconnect past grace, hard timeout —
   *                   extraction-match.md §2's "quit or stall gets the loss anyway" cases)
   *   stalled       → `run.exception.opened` trigger `stall` (settlement.md §7.2: a terminal
   *                   run whose settlement never arrived at all)
   */
  async function abandonment({ since = null } = {}) {
    const [released, settled, exceptions] = await Promise.all([
      eventsSince('deployment.released', since),
      eventsSince('run.settled', since),
      eventsSince('run.exception.opened', since),
    ]);

    const byReleaseReason = new Map();
    for (const e of released) bucket(byReleaseReason, e.payload?.releasedReason ?? 'unknown');

    const raidAborted = settled.filter((e) => e.payload?.outcome === 'aborted').length;

    const byExceptionTrigger = new Map();
    for (const e of exceptions) bucket(byExceptionTrigger, e.payload?.trigger ?? 'unknown');

    return {
      windowSince: since,
      deployStage: asObject(byReleaseReason),
      raidStage: { aborted: raidAborted },
      settlementStage: asObject(byExceptionTrigger),
    };
  }

  /**
   * telemetry-kpi.md §5 — queue health for the extraction admission path: reservation held →
   * either admitted into a run or released, with the split by reason. There is no separate
   * "queue" table in this slice (deployment.md §2's reservation IS the queue) — this reads the
   * same lifecycle events §3/§4 already read, from the admission side.
   */
  async function queueHealth({ since = null } = {}) {
    const [reserved, consumed, rejected, released] = await Promise.all([
      eventsSince('deployment.reserved', since),
      eventsSince('deployment.snapshot.consumed', since),
      eventsSince('deployment.snapshot.rejected', since),
      eventsSince('deployment.released', since),
    ]);
    const total = reserved.length;
    const admitted = consumed.length;
    return {
      windowSince: since,
      reserved: total,
      admitted,
      rejected: rejected.length,
      released: released.length,
      // null rather than 0/0 = NaN or a fabricated 0 — an empty window answers "no data",
      // not "0% admission", and a dashboard that cannot tell the two apart reads a lull as
      // an outage (same posture telemetry.md's numeric bounds take toward clamping a bug).
      admissionRate: total > 0 ? admitted / total : null,
    };
  }

  /**
   * telemetry-kpi.md §6 — extraction-exit and item-disposition balance signals, read straight
   * off `run.settled` (enriched, additive: `exitId`, `deathCause` — settlement.md's own
   * computed values, not re-derived here). Per-item (weapon/loot) balance is a documented gap:
   * `run.settled` carries instance COUNTS, not item identities, and settlement.md's wire
   * contract is `FROZEN` — recorded rather than worked around (telemetry-kpi.md §6.1).
   */
  async function extractionBalance({ since = null } = {}) {
    const settled = await eventsSince('run.settled', since);

    const byExit = new Map();
    const byDeathCause = new Map();
    let instancesConverted = 0;
    let instancesLost = 0;
    for (const e of settled) {
      const p = e.payload ?? {};
      if (p.outcome === 'extracted' && p.exitId) bucket(byExit, p.exitId);
      if (p.outcome === 'died' && p.deathCause) bucket(byDeathCause, p.deathCause);
      instancesConverted += p.instancesConverted ?? 0;
      instancesLost += p.instancesLost ?? 0;
    }

    return {
      windowSince: since,
      exitCounts: asObject(byExit),
      deathCauseCounts: asObject(byDeathCause),
      instances: { converted: instancesConverted, lost: instancesLost },
    };
  }

  return { extractionFunnel, abandonment, queueHealth, extractionBalance };
}

export { registerKpiRoutes } from './kpiRoutes.js';
