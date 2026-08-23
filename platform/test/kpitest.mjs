/**
 * P4-05 KPI instrumentation.  contracts/telemetry-kpi.md.
 *
 * Two halves:
 *   1. `run.settled`'s real emission (through `createSettlementService`, exactly the
 *      settlementtest.mjs harness) actually carries `exitId`/`deathCause` now — proving the
 *      shape on a REAL run-lifecycle transition, not a hand-built envelope.
 *   2. `kpi.js`'s aggregations, over hand-seeded outbox rows (`buildEvent`/`toRow`), proving
 *      each dashboard number counts what its doc claims it counts.
 *
 *   node platform/test/kpitest.mjs
 */
import { ulid } from '../src/core/ids.js';
import { createMemoryStore } from '../src/core/store/memory.js';
import { createOutbox } from '../src/modules/events/outbox.js';
import { buildEvent, toRow } from '../src/modules/events/envelope.js';
import { createMemoryInventoryStore } from '../src/modules/inventory/store.js';
import { createInventoryService } from '../src/modules/inventory/index.js';
import { createSettlementService, idempotencyKeyFor } from '../src/modules/settlement/index.js';
import { createKpiService } from '../src/modules/telemetry/kpi.js';

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const check = (n, cond, d = '') => (cond ? ok(n) : bad(n, d));

const SERVICE_ACTOR = { kind: 'service', id: 'raid-server-1', role: 'service' };

async function seedAccount(store, accountId) {
  return store.accounts.create({
    accountId, status: 'active', emailHash: `hash:${accountId}`,
    displayName: accountId, displayNameFolded: accountId, roles: ['player'],
  });
}

function runResult({ runId, participants }) {
  return {
    runId, participants,
    startedAt: '2026-08-22T12:00:00.000Z', endedAt: '2026-08-22T12:30:00.000Z',
    serverBuild: 'build-1', sectorSet: ['sector-7'], evidenceRef: `sha256:${ulid()}`,
  };
}

// ─────────────────────────────────────────────────────────────── run.settled carries exitId/deathCause

async function testSettledPayloadShape() {
  console.log('run.settled — exitId/deathCause on the real transition (settlement/index.js)');
  const store = createMemoryStore({ storage: 'memory' });
  const outbox = createOutbox({ store, logger: null });
  const inventoryStore = createMemoryInventoryStore();
  const inventoryService = createInventoryService({ store: inventoryStore, emit: null });
  const settlement = createSettlementService({ store, inventoryService, outbox });

  const runId = ulid();
  const [extracted, died, aborted] = [ulid(), ulid(), ulid()];
  for (const id of [extracted, died, aborted]) await seedAccount(store, id);
  await store.matches.allocateRun({
    matchId: runId, region: 'yyz', mapId: 'sector-7', serverBuild: 'build-1',
    participants: [extracted, died, aborted],
  });

  await settlement.submitRunResult({
    actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId),
    runResult: runResult({
      runId,
      participants: [
        { accountId: extracted, outcome: 'extracted', exitId: 'exit_north' },
        { accountId: died, outcome: 'died', deathCause: 'ai' },
        { accountId: aborted, outcome: 'aborted' },
      ],
    }),
  });

  const settledEvents = await store.outbox.listByType('run.settled');
  const byAccount = new Map(settledEvents.map((e) => [e.payload.accountId, e.payload]));

  check('extracted event carries exitId', byAccount.get(extracted)?.exitId === 'exit_north',
    JSON.stringify(byAccount.get(extracted)));
  check('extracted event has null deathCause', byAccount.get(extracted)?.deathCause === null);
  check('died event carries deathCause', byAccount.get(died)?.deathCause === 'ai',
    JSON.stringify(byAccount.get(died)));
  check('died event has null exitId', byAccount.get(died)?.exitId === null);
  check('aborted event has both null',
    byAccount.get(aborted)?.exitId === null && byAccount.get(aborted)?.deathCause === null,
    JSON.stringify(byAccount.get(aborted)));
}

// ─────────────────────────────────────────────────────────────────────────── kpi.js aggregation

function seedEvent(store, type, subjectId, payload, occurredAt) {
  const event = buildEvent({
    type, actor: SERVICE_ACTOR, subject: { kind: 'match', id: subjectId },
    correlationId: ulid(), payload, occurredAt,
  });
  return store.outbox.insert(toRow(event));
}

/** deployment.reserved's real subject is an account, not a match — matched here for realism. */
function seedAccountEvent(store, type, accountId, payload, occurredAt) {
  const event = buildEvent({
    type, actor: { kind: 'player', id: accountId }, subject: { kind: 'account', id: accountId },
    correlationId: ulid(), payload, occurredAt,
  });
  return store.outbox.insert(toRow(event));
}

async function testExtractionFunnel() {
  console.log('kpi.extractionFunnel — deploy/raid/exit stage counts');
  const store = createMemoryStore({ storage: 'memory' });
  const kpi = createKpiService({ store });

  await seedAccountEvent(store, 'deployment.reserved', 'a1', { reservationId: 'r1' }, '2026-08-23T00:00:00.000Z');
  await seedAccountEvent(store, 'deployment.reserved', 'a2', { reservationId: 'r2' }, '2026-08-23T00:00:01.000Z');
  await seedAccountEvent(store, 'deployment.reserved', 'a3', { reservationId: 'r3' }, '2026-08-23T00:00:02.000Z');
  // a1 never becomes a run — reservation released before admission (deploy-stage drop).
  await seedAccountEvent(store, 'deployment.released', 'a1', { reservationId: 'r1', releasedReason: 'abort' }, '2026-08-23T00:00:05.000Z');
  // a2 and a3 are admitted into a run.
  await seedEvent(store, 'deployment.snapshot.consumed', 'run1', { accountId: 'a2' }, '2026-08-23T00:00:10.000Z');
  await seedEvent(store, 'deployment.snapshot.consumed', 'run1', { accountId: 'a3' }, '2026-08-23T00:00:10.000Z');
  // a2 dies mid-raid, a3 extracts.
  await seedEvent(store, 'run.settled', 'run1', { accountId: 'a2', outcome: 'died' }, '2026-08-23T00:00:20.000Z');
  await seedEvent(store, 'run.settled', 'run1', { accountId: 'a3', outcome: 'extracted' }, '2026-08-23T00:00:20.000Z');

  const funnel = await kpi.extractionFunnel({});
  check('deploy.reserved counts every reservation', funnel.deploy.reserved === 3, JSON.stringify(funnel));
  check('deploy.released counts the drop', funnel.deploy.released === 1, JSON.stringify(funnel));
  check('raid.admitted counts both admissions', funnel.raid.admitted === 2, JSON.stringify(funnel));
  check('raid.byOutcome splits died/extracted', funnel.raid.byOutcome.died === 1 && funnel.raid.byOutcome.extracted === 1,
    JSON.stringify(funnel));
  check('exit.extracted is the extracted count', funnel.exit.extracted === 1, JSON.stringify(funnel));

  const windowed = await kpi.extractionFunnel({ since: '2026-08-23T00:00:09.000Z' });
  check('since filters out events before the window', windowed.deploy.reserved === 0, JSON.stringify(windowed));
  check('since keeps events at/after the boundary', windowed.raid.admitted === 2, JSON.stringify(windowed));
}

async function testAbandonment() {
  console.log('kpi.abandonment — deploy/raid/settlement-stall stages');
  const store = createMemoryStore({ storage: 'memory' });
  const kpi = createKpiService({ store });

  await seedAccountEvent(store, 'deployment.released', 'a1', { releasedReason: 'timeout' });
  await seedAccountEvent(store, 'deployment.released', 'a2', { releasedReason: 'timeout' });
  await seedAccountEvent(store, 'deployment.released', 'a3', { releasedReason: 'expiry' });
  await seedEvent(store, 'run.settled', 'run1', { accountId: 'a4', outcome: 'aborted' });
  await seedEvent(store, 'run.settled', 'run1', { accountId: 'a5', outcome: 'extracted' });
  await seedEvent(store, 'run.exception.opened', 'run2', { accountId: 'a6', trigger: 'stall' });

  const a = await kpi.abandonment({});
  check('deployStage groups by releasedReason', a.deployStage.timeout === 2 && a.deployStage.expiry === 1,
    JSON.stringify(a));
  check('raidStage counts only aborted outcomes', a.raidStage.aborted === 1, JSON.stringify(a));
  check('settlementStage counts stall exceptions', a.settlementStage.stall === 1, JSON.stringify(a));
}

async function testQueueHealth() {
  console.log('kpi.queueHealth — reservation admission rate');
  const store = createMemoryStore({ storage: 'memory' });
  const kpi = createKpiService({ store });

  const empty = await kpi.queueHealth({});
  check('empty window reports null rate, not NaN or 0', empty.admissionRate === null, JSON.stringify(empty));

  await seedAccountEvent(store, 'deployment.reserved', 'a1', {});
  await seedAccountEvent(store, 'deployment.reserved', 'a2', {});
  await seedAccountEvent(store, 'deployment.reserved', 'a3', {});
  await seedAccountEvent(store, 'deployment.reserved', 'a4', {});
  await seedEvent(store, 'deployment.snapshot.consumed', 'run1', { accountId: 'a1' });
  await seedEvent(store, 'deployment.snapshot.rejected', 'run1', { reason: 'expired' });

  const h = await kpi.queueHealth({});
  check('reserved counts every reservation', h.reserved === 4, JSON.stringify(h));
  check('admitted counts consumed snapshots', h.admitted === 1, JSON.stringify(h));
  check('rejected counts rejected snapshots', h.rejected === 1, JSON.stringify(h));
  check('admissionRate is admitted/reserved', h.admissionRate === 1 / 4, JSON.stringify(h));
}

async function testExtractionBalance() {
  console.log('kpi.extractionBalance — exit distribution and instance disposition sums');
  const store = createMemoryStore({ storage: 'memory' });
  const kpi = createKpiService({ store });

  await seedEvent(store, 'run.settled', 'run1',
    { accountId: 'a1', outcome: 'extracted', exitId: 'exit_north', instancesConverted: 4, instancesLost: 0 });
  await seedEvent(store, 'run.settled', 'run1',
    { accountId: 'a2', outcome: 'extracted', exitId: 'exit_north', instancesConverted: 2, instancesLost: 0 });
  await seedEvent(store, 'run.settled', 'run1',
    { accountId: 'a3', outcome: 'extracted', exitId: 'exit_south', instancesConverted: 3, instancesLost: 0 });
  await seedEvent(store, 'run.settled', 'run1',
    { accountId: 'a4', outcome: 'died', deathCause: 'ai', instancesConverted: 0, instancesLost: 5 });
  await seedEvent(store, 'run.settled', 'run1',
    { accountId: 'a5', outcome: 'died', deathCause: 'player', instancesConverted: 0, instancesLost: 2 });

  const b = await kpi.extractionBalance({});
  check('exitCounts splits by exit', b.exitCounts.exit_north === 2 && b.exitCounts.exit_south === 1,
    JSON.stringify(b));
  check('deathCauseCounts splits by cause', b.deathCauseCounts.ai === 1 && b.deathCauseCounts.player === 1,
    JSON.stringify(b));
  check('instances.converted sums extracted runs', b.instances.converted === 9, JSON.stringify(b));
  check('instances.lost sums died/aborted runs', b.instances.lost === 7, JSON.stringify(b));
}

async function testKpiServiceRequiresOutbox() {
  console.log('createKpiService — refuses a store with no outbox.listByType');
  try {
    createKpiService({ store: {} });
    bad('throws without outbox.listByType', 'constructed successfully');
  } catch (err) {
    check('throws without outbox.listByType', err instanceof Error, err?.message);
  }
}

async function main() {
  await testSettledPayloadShape();
  await testExtractionFunnel();
  await testAbandonment();
  await testQueueHealth();
  await testExtractionBalance();
  await testKpiServiceRequiresOutbox();

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — kpitest`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
