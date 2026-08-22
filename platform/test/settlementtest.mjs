/**
 * Settlement conformance.  contracts/settlement.md §10.
 *
 * Same split every P3-0x suite uses: real memory adapters for the core store (matches,
 * match_participants, settlement_exceptions, idempotency, outbox) and for inventory
 * (item_instances), wired together exactly the way `platform/src/modules/settlement/index.js`'s
 * header says production would wire them — two independently-pooled stores, one outbox.
 *
 *   node platform/test/settlementtest.mjs
 */
import { ulid } from '../src/core/ids.js';
import { createMemoryStore } from '../src/core/store/memory.js';
import { createOutbox } from '../src/modules/events/outbox.js';
import { createMemoryInventoryStore } from '../src/modules/inventory/store.js';
import { createInventoryService } from '../src/modules/inventory/index.js';
import { createSettlementService, idempotencyKeyFor } from '../src/modules/settlement/index.js';

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const check = (n, cond, d = '') => (cond ? ok(n) : bad(n, d));

async function throwsCode(name, code, fn) {
  try {
    await fn();
    bad(name, `expected ${code}, but the call succeeded`);
  } catch (err) {
    if (err?.code === code) ok(name);
    else bad(name, `expected ${code}, got ${err?.code ?? err?.stack ?? err}`);
  }
}

const SERVICE_ACTOR = { kind: 'service', id: 'raid-server-1', role: 'service' };
const SYSTEM_ACTOR = { kind: 'service', id: 'test', role: 'loot-spawn' };

async function freshHarness() {
  const store = createMemoryStore({ storage: 'memory' });
  const outbox = createOutbox({ store, logger: null });
  const inventoryStore = createMemoryInventoryStore();
  const inventoryService = createInventoryService({ store: inventoryStore, emit: null });
  const settlement = createSettlementService({ store, inventoryService, outbox });
  return { store, outbox, inventoryStore, inventoryService, settlement };
}

async function seedAccount(store, accountId) {
  return store.accounts.create({
    accountId, status: 'active', emailHash: `hash:${accountId}`,
    displayName: accountId, displayNameFolded: accountId, roles: ['player'],
  });
}

async function seedDefinition(inventoryService, itemId = 'rifle_ak74') {
  await inventoryService.defineItem({ itemId, class: 'weapon', slot: 'primary', rarityTier: 'common', stackable: false });
}

/** A participant's run-location loadout instance, already locked (as deployment.md §4.5 leaves it). */
async function seedRunInstance(inventoryStore, { runId, accountId, itemId = 'rifle_ak74', instanceId }) {
  const row = await inventoryStore.instances.create({
    instanceId: instanceId ?? ulid(), itemId, ownerAccountId: accountId, quantity: 1,
    location: 'run', runId, containerId: null,
  });
  // The reservation lock stays true through the raid (items-inventory.md §4) — `lockMany` only
  // locks a `location='permanent'` row (it is the deploy-time primitive), so a row already
  // seeded straight into `run` is stamped locked directly, simulating what
  // `deployment.md` §4.5 step 4 would have already left in place by the time a run ends.
  await inventoryStore.instances.mutate(row.instanceId,
    { locked: true, lockedByDeploymentId: `dep_${row.instanceId}` }, { allowLocked: true });
  return row.instanceId;
}

async function allocateRun(store, { runId, accountIds }) {
  for (const id of accountIds) await seedAccount(store, id);
  return store.matches.allocateRun({
    matchId: runId, region: 'yyz', mapId: 'sector-7', serverBuild: 'build-1', participants: accountIds,
  });
}

function runResult({ runId, participants, status = undefined }) {
  const body = {
    runId, participants,
    startedAt: '2026-08-22T12:00:00.000Z', endedAt: '2026-08-22T12:30:00.000Z',
    serverBuild: 'build-1', sectorSet: ['sector-7'], evidenceRef: `sha256:${ulid()}`,
  };
  if (status !== undefined) body.status = status;
  return body;
}

async function main() {
  // ------------------------------------------------------------------------- basic dispositions

  {
    const { store, inventoryStore, inventoryService, settlement } = await freshHarness();
    const runId = ulid();
    const [a, b] = [ulid(), ulid()];
    await allocateRun(store, { runId, accountIds: [a, b] });
    await seedDefinition(inventoryService);
    const instA = await seedRunInstance(inventoryStore, { runId, accountId: a });
    const instB = await seedRunInstance(inventoryStore, { runId, accountId: b });

    const res = await settlement.submitRunResult({
      actor: SERVICE_ACTOR,
      idempotencyKey: idempotencyKeyFor(runId),
      runResult: runResult({
        runId,
        participants: [
          { accountId: a, outcome: 'extracted', exitId: 'exit_north' },
          { accountId: b, outcome: 'died', deathCause: 'player' },
        ],
      }),
    });

    check('extracted participant settles', res.participants.find((p) => p.accountId === a)?.settlementStatus === 'settled');
    check('died participant settles', res.participants.find((p) => p.accountId === b)?.settlementStatus === 'settled');
    check('run has no run-level exception', res.runLevelException === null);

    const rowA = await inventoryStore.instances.byId(instA);
    check('extracted instance converts to permanent', rowA.location === 'permanent' && rowA.runId === null,
      JSON.stringify(rowA));
    check('extracted instance unlocked', rowA.locked === false);

    const rowB = await inventoryStore.instances.byId(instB);
    check('died instance is lost', rowB.status === 'lost', JSON.stringify(rowB));
    check('died instance stays in place otherwise', rowB.location === 'run');

    const runRow = await store.matches.byId(runId);
    check('run transitions to completed', runRow.status === 'completed');
  }

  // ------------------------------------------------------------------------------ disconnects

  {
    const { store, inventoryStore, inventoryService, settlement } = await freshHarness();
    const runId = ulid();
    const a = ulid();
    await allocateRun(store, { runId, accountIds: [a] });
    await seedDefinition(inventoryService);
    const inst = await seedRunInstance(inventoryStore, { runId, accountId: a });

    const res = await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId),
      runResult: runResult({ runId, participants: [{ accountId: a, outcome: 'aborted' }] }),
    });
    check('disconnect (aborted) settles', res.participants[0].settlementStatus === 'settled');
    check('disconnect outcome recorded as aborted', res.participants[0].outcome === 'aborted');
    const row = await inventoryStore.instances.byId(inst);
    check('disconnected participant loses their run inventory', row.status === 'lost');
  }

  // A run nobody ever spawned into: empty participants[] derives status='aborted' (§1.1, module header).
  {
    const { store, settlement } = await freshHarness();
    const runId = ulid();
    await allocateRun(store, { runId, accountIds: [] });
    await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId),
      runResult: runResult({ runId, participants: [] }),
    });
    const runRow = await store.matches.byId(runId);
    check('a run nobody spawned into is aborted, not completed', runRow.status === 'aborted');
  }

  // --------------------------------------------------------------------- server-failure mid-run

  {
    const { store, inventoryStore, inventoryService, settlement } = await freshHarness();
    const runId = ulid();
    const [a, b] = [ulid(), ulid()];
    await allocateRun(store, { runId, accountIds: [a, b] });
    await seedDefinition(inventoryService);
    const instA = await seedRunInstance(inventoryStore, { runId, accountId: a });
    const instB = await seedRunInstance(inventoryStore, { runId, accountId: b });

    const res = await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId),
      runResult: runResult({
        runId,
        participants: [
          { accountId: a, outcome: 'server-failure', lastKnownState: { phase: 'at-exit', exitId: 'exit_north' } },
          { accountId: b, outcome: 'server-failure', lastKnownState: { phase: 'looting', exitId: null } },
        ],
      }),
    });

    const pa = res.participants.find((p) => p.accountId === a);
    const pb = res.participants.find((p) => p.accountId === b);
    check('server-failure at-exit-with-exitId resolves to extracted', pa.outcome === 'extracted', JSON.stringify(pa));
    check('server-failure looting resolves to aborted (full loss)', pb.outcome === 'aborted', JSON.stringify(pb));
    check('server-failure extracted converts the instance', (await inventoryStore.instances.byId(instA)).location === 'permanent');
    check('server-failure aborted loses the instance', (await inventoryStore.instances.byId(instB)).status === 'lost');

    await throwsCode('server-failure with no lastKnownState is refused at submission', 'VALIDATION_FAILED', () => {
      const runId2 = ulid();
      return settlement.submitRunResult({
        actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId2),
        runResult: runResult({ runId: runId2, participants: [{ accountId: a, outcome: 'server-failure' }] }),
      });
    });
  }

  // -------------------------------------------------------------------------------------- retries

  {
    const { store, inventoryStore, inventoryService, settlement } = await freshHarness();
    const runId = ulid();
    const a = ulid();
    await allocateRun(store, { runId, accountIds: [a] });
    await seedDefinition(inventoryService);
    const inst = await seedRunInstance(inventoryStore, { runId, accountId: a });
    const payload = runResult({ runId, participants: [{ accountId: a, outcome: 'extracted', exitId: 'exit_north' }] });

    const first = await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId), runResult: payload,
    });
    const second = await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId), runResult: payload,
    });
    check('a retried identical submission returns the same response', first.resultAppliedAt === second.resultAppliedAt);
    check('a retry settles the instance exactly once (no double-conversion, no duplicate loss)',
      (await inventoryStore.instances.byId(inst)).location === 'permanent');

    // duplicate callbacks arriving CONCURRENTLY — 10x, same payload, same key.
    const runId2 = ulid();
    const b = ulid();
    await allocateRun(store, { runId: runId2, accountIds: [b] });
    const inst2 = await seedRunInstance(inventoryStore, { runId: runId2, accountId: b });
    const payload2 = runResult({ runId: runId2, participants: [{ accountId: b, outcome: 'died', deathCause: 'ai' }] });
    const results = await Promise.all(Array.from({ length: 10 }, () => settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId2), runResult: payload2,
    })));
    const settledCount = results.filter((r) => r.participants[0].settlementStatus === 'settled').length;
    check('10 concurrent identical submissions all report settled', settledCount === 10);
    const row2 = await inventoryStore.instances.byId(inst2);
    check('10 concurrent identical submissions settle inventory exactly once', row2.status === 'lost');

    // a DIFFERENT payload under the same key is a CONFLICT, not a silent second truth.
    const runId3 = ulid();
    const c = ulid();
    await allocateRun(store, { runId: runId3, accountIds: [c] });
    await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId3),
      runResult: runResult({ runId: runId3, participants: [{ accountId: c, outcome: 'died', deathCause: 'player' }] }),
    });
    await throwsCode('a different payload for an already-submitted run is CONFLICT', 'CONFLICT', () =>
      settlement.submitRunResult({
        actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId3),
        runResult: runResult({ runId: runId3, participants: [{ accountId: c, outcome: 'aborted' }] }),
      }));
  }

  // ------------------------------------------------------------------------------ service-only

  {
    const { store, settlement } = await freshHarness();
    const runId = ulid();
    await allocateRun(store, { runId, accountIds: [] });
    await throwsCode('a browser/player-origin submission is refused', 'AUTH_FORBIDDEN', () =>
      settlement.submitRunResult({
        actor: { kind: 'player', id: 'acct_x' }, idempotencyKey: idempotencyKeyFor(runId),
        runResult: runResult({ runId, participants: [] }),
      }));
  }

  // ------------------------------------------------------------------------------ missing participant

  {
    const { store, inventoryStore, inventoryService, settlement } = await freshHarness();
    const runId = ulid();
    const [a, b] = [ulid(), ulid()];
    await allocateRun(store, { runId, accountIds: [a, b] });
    await seedDefinition(inventoryService);
    const instA = await seedRunInstance(inventoryStore, { runId, accountId: a });

    const res = await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId),
      // b has a match_participants row (from allocateRun) but never appears here.
      runResult: runResult({ runId, participants: [{ accountId: a, outcome: 'extracted', exitId: 'exit_north' }] }),
    });
    check('a submission missing a rostered participant opens a run-level exception',
      res.runLevelException !== null && res.runLevelException.trigger === 'missing-participant');
    check('the named participant still settles despite the run-level exception',
      res.participants[0].settlementStatus === 'settled');
    check('the run-level exception is queryable by run', (await store.settlementExceptions.listByRun(runId))
      .some((e) => e.accountId === null && e.trigger === 'missing-participant'));
    check('extracted instance still converts', (await inventoryStore.instances.byId(instA)).location === 'permanent');
  }

  // ------------------------------------------------------------------------------- lock-mismatch

  {
    const { store, inventoryStore, inventoryService, settlement } = await freshHarness();
    const runId = ulid();
    const a = ulid();
    await allocateRun(store, { runId, accountIds: [a] });
    await seedDefinition(inventoryService);
    // A run-location row that somehow lost its lock before settlement — the invariant §7.1 flags.
    const row = await inventoryStore.instances.create({
      itemId: 'rifle_ak74', ownerAccountId: a, quantity: 1, location: 'run', runId,
    });

    const res = await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId),
      runResult: runResult({ runId, participants: [{ accountId: a, outcome: 'extracted', exitId: 'exit_north' }] }),
    });
    check('an unlocked surviving run row opens an exception instead of settling',
      res.participants[0].settlementStatus === 'exception-open' && res.participants[0].trigger === 'lock-mismatch');
    const after = await inventoryStore.instances.byId(row.instanceId);
    check('no item_instances mutation happens for an opened exception', after.location === 'run' && after.status === 'active');
  }

  // -------------------------------------------------------------------------------- stall detector

  {
    const { store, settlement } = await freshHarness();

    // A run that ended just now, with no RunResult ever submitted for it — too fresh to stall.
    const runIdFresh = ulid();
    const a = ulid();
    await allocateRun(store, { runId: runIdFresh, accountIds: [a] });
    const now = new Date().toISOString();
    await store.matches.transitionRunEnded(runIdFresh, { status: 'completed', startedAt: now, endedAt: now });
    const tooSoon = await settlement.checkStalls({ timeoutMs: 60_000 });
    check('the stall detector does not fire before the timeout', !tooSoon.some((e) => e.accountId === a));

    // A run that ended well in the past — same "RunResult never arrives" case, aged out.
    const runIdStale = ulid();
    const b = ulid();
    await allocateRun(store, { runId: runIdStale, accountIds: [b] });
    const old = new Date(Date.now() - 120_000).toISOString();
    await store.matches.transitionRunEnded(runIdStale, { status: 'completed', startedAt: old, endedAt: old });
    const fired = await settlement.checkStalls({ timeoutMs: 60_000 });
    check('the stall detector opens an exception once the timeout has elapsed', fired.some((e) => e.accountId === b));
    const exRows = await store.settlementExceptions.listByRun(runIdStale);
    check('the stalled exception is trigger=stall, participant-level', exRows.some((e) => e.trigger === 'stall' && e.accountId === b));

    const again = await settlement.checkStalls({ timeoutMs: 60_000 });
    check('re-running the stall sweep does not open a second exception for the same participant',
      !again.some((e) => e.accountId === b));
  }

  // ------------------------------------------------------------------------------ exception resolution

  {
    const { store, inventoryStore, inventoryService, settlement } = await freshHarness();
    const runId = ulid();
    const a = ulid();
    await allocateRun(store, { runId, accountIds: [a] });
    await seedDefinition(inventoryService);
    const inst = await seedRunInstance(inventoryStore, { runId, accountId: a });
    await inventoryStore.instances.mutate(inst, { locked: false }, { allowLocked: true });

    const res = await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId),
      runResult: runResult({ runId, participants: [{ accountId: a, outcome: 'extracted', exitId: 'exit_north' }] }),
    });
    const exceptionId = res.participants[0].exceptionId;
    check('setup: an exception is open to resolve', !!exceptionId);

    const openRow = await store.settlementExceptions.byId(exceptionId);
    const claimed = await settlement.claimException({
      exceptionId, operatorId: 'op_1', expectedUpdatedAt: openRow.updatedAt,
    });
    check('claim moves the exception to in-review', claimed.status === 'in-review');

    await throwsCode('a stale claim (wrong expectedUpdatedAt) is refused', 'CONFLICT', () =>
      settlement.claimException({ exceptionId, operatorId: 'op_2', expectedUpdatedAt: openRow.updatedAt }));

    const resolved = await settlement.resolveException({
      exceptionId, resolution: 'settle-as-extracted', resolutionNotes: 'reviewed evidence, confirmed extraction',
      reviewedBy: 'op_1',
    });
    check('resolution settles as extracted', resolved.settlementStatus === 'exception-resolved' && resolved.outcome === 'extracted');
    check('resolution converts the instance', (await inventoryStore.instances.byId(inst)).location === 'permanent');
    const exAfter = await store.settlementExceptions.byId(exceptionId);
    check('the exception row itself is resolved', exAfter.status === 'resolved' && exAfter.resolution === 'settle-as-extracted');

    await throwsCode('resolutionNotes is required and must be non-blank', 'VALIDATION_FAILED', () =>
      settlement.resolveException({ exceptionId, resolution: 'void', resolutionNotes: '   ', reviewedBy: 'op_1' }));
  }

  // void resolution: no item mutation, no run.settled for that participant.
  {
    const { store, inventoryStore, inventoryService, settlement, outbox } = await freshHarness();
    const runId = ulid();
    const a = ulid();
    await allocateRun(store, { runId, accountIds: [a] });
    await seedDefinition(inventoryService);
    const inst = await seedRunInstance(inventoryStore, { runId, accountId: a });
    await inventoryStore.instances.mutate(inst, { locked: false }, { allowLocked: true });

    const res = await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId),
      runResult: runResult({ runId, participants: [{ accountId: a, outcome: 'extracted', exitId: 'exit_north' }] }),
    });
    const exceptionId = res.participants[0].exceptionId;

    const openRow = await store.settlementExceptions.byId(exceptionId);
    await settlement.claimException({ exceptionId, operatorId: 'op_1', expectedUpdatedAt: openRow.updatedAt });

    const resolved = await settlement.resolveException({
      exceptionId, resolution: 'void', resolutionNotes: 'duplicate allocation, run invalid', reviewedBy: 'op_1',
    });
    check('void resolution reports outcome null', resolved.outcome === null && resolved.settlementStatus === 'exception-resolved');
    const after = await inventoryStore.instances.byId(inst);
    check('void resolution issues NO item_instances mutation', after.location === 'run' && after.status === 'active');

    const events = await store.outbox.list({});
    const forRun = events.filter((e) => e.subjectId === runId);
    check('void resolution emits run.exception.resolved', forRun.some((e) => e.eventType === 'run.exception.resolved'));
    check('void resolution emits NO run.settled', !forRun.some((e) => e.eventType === 'run.settled'));
    void outbox;
  }

  // ------------------------------------------------------- resolving twice is refused, not re-run
  {
    const { store, inventoryStore, inventoryService, settlement } = await freshHarness();
    const runId = ulid();
    const a = ulid();
    await allocateRun(store, { runId, accountIds: [a] });
    await seedDefinition(inventoryService);
    const inst = await seedRunInstance(inventoryStore, { runId, accountId: a });
    await inventoryStore.instances.mutate(inst, { locked: false }, { allowLocked: true });

    const res = await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId),
      runResult: runResult({ runId, participants: [{ accountId: a, outcome: 'extracted', exitId: 'exit_north' }] }),
    });
    const exceptionId = res.participants[0].exceptionId;
    const openRow = await store.settlementExceptions.byId(exceptionId);

    // A call for an exception that is still 'open' (nobody has claimed it) must not be able to
    // resolve — this is §7.4 step 3's optimistic lock, checked before resolveException does
    // anything, and it holds even before the claim/resolve race this block goes on to exercise.
    await throwsCode('resolveException on a not-yet-claimed (still "open") exception is refused', 'CONFLICT', () =>
      settlement.resolveException({
        exceptionId, resolution: 'settle-as-died', resolutionNotes: 'never claimed', reviewedBy: 'op_evil',
      }));

    await settlement.claimException({ exceptionId, operatorId: 'op_1', expectedUpdatedAt: openRow.updatedAt });

    const resolved = await settlement.resolveException({
      exceptionId, resolution: 'settle-as-extracted', resolutionNotes: 'first review, confirmed extraction',
      reviewedBy: 'op_1',
    });
    check('first resolve settles as extracted', resolved.settlementStatus === 'exception-resolved' && resolved.outcome === 'extracted');
    const exAfter = await store.settlementExceptions.byId(exceptionId);

    const eventsBefore = await store.outbox.list({});
    const settledBefore = eventsBefore.filter((e) => e.eventType === 'run.settled' && e.subjectId === runId).length;
    check('exactly one run.settled after the first resolve', settledBefore === 1, `count=${settledBefore}`);

    // The double-write hazard claimException's optimistic lock exists to prevent (settlement.md
    // §7.4 step 3): a second call for the SAME exceptionId, whether a genuine concurrent racer or
    // a naive retry, must be refused — not re-run settleParticipant (which would re-emit
    // run.settled and rewrite match_participants.stats) and must not clobber the first operator's
    // audit trail (resolution/resolutionNotes/reviewedBy/reviewedAt) with a second operator's.
    await throwsCode('resolving an already-resolved exception a second time is refused', 'CONFLICT', () =>
      settlement.resolveException({
        exceptionId, resolution: 'settle-as-died', resolutionNotes: 'a different, later operator',
        reviewedBy: 'op_2',
      }));

    const exAfterSecondAttempt = await store.settlementExceptions.byId(exceptionId);
    check('the audit trail from the first resolve is untouched by the refused second call',
      exAfterSecondAttempt.resolution === 'settle-as-extracted'
        && exAfterSecondAttempt.resolutionNotes === 'first review, confirmed extraction'
        && exAfterSecondAttempt.reviewedBy === 'op_1'
        && exAfterSecondAttempt.reviewedAt === exAfter.reviewedAt,
      JSON.stringify(exAfterSecondAttempt));

    const eventsAfter = await store.outbox.list({});
    const settledAfter = eventsAfter.filter((e) => e.eventType === 'run.settled' && e.subjectId === runId).length;
    check('the refused second call did NOT re-emit run.settled', settledAfter === settledBefore, `count=${settledAfter}`);
    const resolvedAfter = eventsAfter.filter((e) => e.eventType === 'run.exception.resolved' && e.subjectId === runId).length;
    check('the refused second call did NOT emit a second run.exception.resolved either', resolvedAfter === 1, `count=${resolvedAfter}`);

    check('the participant stats from the first resolve are untouched',
      (await store.matches.getParticipant(runId, a)).stats.outcome === 'extracted');
    check('the instance conversion from the first resolve is untouched',
      (await inventoryStore.instances.byId(inst)).location === 'permanent');
  }

  // -------------------------------------------------- a real disposition is ONE transaction (§6.1)
  {
    const { store, inventoryStore, inventoryService, settlement } = await freshHarness();
    const runId = ulid();
    const a = ulid();
    await allocateRun(store, { runId, accountIds: [a] });
    await seedDefinition(inventoryService);
    const inst = await seedRunInstance(inventoryStore, { runId, accountId: a });
    await inventoryStore.instances.mutate(inst, { locked: false }, { allowLocked: true });

    const res = await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId),
      runResult: runResult({ runId, participants: [{ accountId: a, outcome: 'extracted', exitId: 'exit_north' }] }),
    });
    const exceptionId = res.participants[0].exceptionId;
    const openRow = await store.settlementExceptions.byId(exceptionId);
    await settlement.claimException({ exceptionId, operatorId: 'op_1', expectedUpdatedAt: openRow.updatedAt });

    // `store.tx` is where the memory adapter opens (or joins) a transaction — a nested call
    // inside an already-open transaction runs against the OUTER handle instead of opening a new
    // one (memory.js's `tx()`). So counting only the calls that actually open a NEW transaction
    // is a direct, faithful measurement of how many separate core-store transactions this call
    // used — not a proxy for it. §6.1 requires the `match_participants` write, the
    // `settlement_exceptions` write, and both events to be ONE unit, not two independent
    // `outbox.commit`s that could commit one without the other on a crash in between.
    const realTx = store.tx.bind(store);
    let newTxOpens = 0;
    let insideOne = false;
    store.tx = async (fn) => realTx(async (handle) => {
      const wasInside = insideOne;
      if (!wasInside) { newTxOpens++; insideOne = true; }
      try {
        return await fn(handle);
      } finally {
        if (!wasInside) insideOne = false;
      }
    });

    await settlement.resolveException({
      exceptionId, resolution: 'settle-as-extracted', resolutionNotes: 'single-transaction check',
      reviewedBy: 'op_1',
    });

    store.tx = realTx;
    check('a real-disposition resolution opens exactly ONE core-store transaction', newTxOpens === 1,
      `newTxOpens=${newTxOpens}`);
  }

  // ----------------------- match-result.md §4.4 — the extraction run-result read projection

  {
    const { createStatsService } = await import('../src/modules/profile/stats.js');
    const { createOutbox: mkOutbox } = await import('../src/modules/events/outbox.js');
    const { store, inventoryStore, inventoryService, settlement } = await freshHarness();
    const stats = createStatsService({ store, outbox: mkOutbox({ store, logger: null }) });
    const runId = ulid();
    const [a, b, c] = [ulid(), ulid(), ulid()];
    // Three on the roster, TWO submitted: c is settlement.md §7.1's run-level trigger.
    await allocateRun(store, { runId, accountIds: [a, b, c] });
    await seedDefinition(inventoryService);
    await seedRunInstance(inventoryStore, { runId, accountId: a });
    await seedRunInstance(inventoryStore, { runId, accountId: b });

    await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId),
      runResult: runResult({
        runId,
        participants: [
          { accountId: a, outcome: 'extracted', exitId: 'exit-rail-gate' },
          { accountId: b, outcome: 'died', deathCause: 'player' },
        ],
      }),
    });

    const proj = await stats.getMatch(runId, { viewer: { accountId: a } });
    check('§4.4: terminal run projects mode extraction', proj.mode === 'extraction' && proj.status === 'completed');
    check('§4.4: no PvP keys are null-stuffed onto a run projection',
      !('winnerTeam' in proj) && !('teamScores' in proj) && !('rounds' in proj)
      && !('players' in proj) && !('rulesSnapshot' in proj) && !('outcomeReason' in proj),
      JSON.stringify(Object.keys(proj)));
    check('§4.4: roster covers the full participant set with team null',
      proj.roster.length === 3 && proj.roster.every((r) => r.team === null));
    const pa = proj.settlement.participants.find((p) => p.accountId === a);
    const pb = proj.settlement.participants.find((p) => p.accountId === b);
    const pc = proj.settlement.participants.find((p) => p.accountId === c);
    check('§4.4: extracted participant carries settled + outcome + exitId',
      pa?.settlementStatus === 'settled' && pa?.outcome === 'extracted' && pa?.exitId === 'exit-rail-gate'
      && pa?.deathCause === null && pa?.exceptionId === null && pa?.trigger === null, JSON.stringify(pa));
    check('§4.4: died participant carries settled + deathCause, exitId null',
      pb?.settlementStatus === 'settled' && pb?.outcome === 'died' && pb?.deathCause === 'player'
      && pb?.exitId === null, JSON.stringify(pb));
    check('§4.4: the never-submitted participant reads as ended with every fact null',
      pc?.settlementStatus === 'ended' && pc?.outcome === null && pc?.exitId === null
      && pc?.exceptionId === null && pc?.trigger === null, JSON.stringify(pc));
    check('§4.4: the run-level exception surfaces through settlement.runLevelException',
      proj.settlement.runLevelException !== null
      && proj.settlement.runLevelException.trigger === 'missing-participant'
      && typeof proj.settlement.runLevelException.exceptionId === 'string',
      JSON.stringify(proj.settlement.runLevelException));
    check('§4.4: evidenceRef withheld from a participant caller', proj.evidenceRef === null);
    const svc = await stats.getMatch(runId, { viewer: { kind: 'service' } });
    check('§4.4: evidenceRef real for a service caller', typeof svc.evidenceRef === 'string'
      && svc.evidenceRef.startsWith('sha256:'));

    // A participant-level exception projects as exception-open with its trigger; a PvP match
    // is untouched by any of this (control: the tdm path still returns the §4.2 union).
    const runId2 = ulid();
    const d = ulid();
    await allocateRun(store, { runId: runId2, accountIds: [d] });
    // Unlocked surviving instance → §7.1 lock-mismatch → exception-open.
    const inst = await inventoryStore.instances.create({
      instanceId: ulid(), itemId: 'rifle_ak74', ownerAccountId: d, quantity: 1,
      location: 'run', runId: runId2, containerId: null,
    });
    void inst;
    await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId2),
      runResult: runResult({
        runId: runId2,
        participants: [{ accountId: d, outcome: 'extracted', exitId: 'exit-rail-gate' }],
      }),
    });
    const proj2 = await stats.getMatch(runId2, { viewer: { accountId: d } });
    const pd = proj2.settlement.participants.find((p) => p.accountId === d);
    check('§4.4: an exception-open participant carries exceptionId + trigger and a null outcome',
      pd?.settlementStatus === 'exception-open' && pd?.outcome === null
      && typeof pd?.exceptionId === 'string' && pd?.trigger === 'lock-mismatch', JSON.stringify(pd));
    check('§4.4: a clean run carries runLevelException null', proj2.settlement.runLevelException === null);
  }
}

main().then(() => {
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — settlementtest`);
  process.exit(failures ? 1 : 0);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
