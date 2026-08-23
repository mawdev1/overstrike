/**
 * Progression conformance.  contracts/progression-economy.md §9.
 *
 *   node platform/test/progressiontest.mjs
 */
import { ulid } from '../src/core/ids.js';
import { createMemoryStore } from '../src/core/store/memory.js';
import { createOutbox } from '../src/modules/events/outbox.js';
import { createMemoryInventoryStore } from '../src/modules/inventory/store.js';
import { createInventoryService } from '../src/modules/inventory/index.js';
import { createSettlementService, idempotencyKeyFor } from '../src/modules/settlement/index.js';
import { createMemoryProgressionStore } from '../src/modules/progression/store.js';
import { createProgressionService, DURABILITY_LOSS_PER_RUN } from '../src/modules/progression/index.js';

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

async function freshHarness() {
  const store = createMemoryStore({ storage: 'memory' });
  const outbox = createOutbox({ store, logger: null });
  const inventoryStore = createMemoryInventoryStore();
  const inventoryService = createInventoryService({ store: inventoryStore, emit: null });
  const progressionStore = createMemoryProgressionStore();
  // Records every event `progression`'s ledger writes build, in the SAME shape `app.js`'s
  // `emitDomainEvent` receives — proof §10's op.earned/op.spent/item.repaired/item.upgraded/
  // progression.xp.earned actually fire, not just that the ledger/balance math is right.
  const events = [];
  const emit = async (event) => { events.push(event); };
  const progression = createProgressionService({ store: progressionStore, inventoryService, emit });
  const settlement = createSettlementService({
    store, inventoryService, outbox, progression,
  });
  return { store, outbox, inventoryStore, inventoryService, progressionStore, progression, settlement, events };
}

async function seedAccount(store, accountId) {
  return store.accounts.create({
    accountId, status: 'active', emailHash: `hash:${accountId}`,
    displayName: accountId, displayNameFolded: accountId, roles: ['player'],
  });
}

async function seedWeaponDef(inventoryService, itemId = 'rifle_ak74', { maxUpgradeTier = 3 } = {}) {
  return inventoryService.defineItem({
    itemId, class: 'weapon', slot: 'primary', rarityTier: 'common', stackable: false,
    durabilityMax: 100, maxUpgradeTier,
  });
}

async function permanentInstance(inventoryStore, { accountId, itemId = 'rifle_ak74', durability = 100 }) {
  const row = await inventoryStore.instances.create({
    itemId, ownerAccountId: accountId, quantity: 1, location: 'permanent', durability,
  });
  return row.instanceId;
}

async function seedRunInstance(inventoryStore, { runId, accountId, itemId = 'rifle_ak74', durability = 100 }) {
  const row = await inventoryStore.instances.create({
    instanceId: ulid(), itemId, ownerAccountId: accountId, quantity: 1,
    location: 'run', runId, durability,
  });
  await inventoryStore.instances.mutate(row.instanceId,
    { locked: true, lockedByDeploymentId: `dep_${row.instanceId}` }, { allowLocked: true });
  return row.instanceId;
}

async function grantOp(progressionStore, accountId, amount, tag = ulid()) {
  return progressionStore.ledger.apply({
    accountId, delta: amount, reason: 'admin-grant', runId: null, instanceId: null,
    correlationId: tag, idempotencyKey: `op-admin:${tag}`, xpDelta: 0, level: null,
  });
}

async function main() {
  // ---------------------------------------------------------------------------------- repair

  {
    const { inventoryStore, inventoryService, progression, progressionStore, events } = await freshHarness();
    const a = ulid();
    await seedWeaponDef(inventoryService);
    const inst = await permanentInstance(inventoryStore, { accountId: a, durability: 50 });
    await grantOp(progressionStore, a, 100);

    const res = await progression.repairInstance({ accountId: a, instanceId: inst, idempotencyKey: ulid() });
    check('repair restores durability to max', res.durability === 100, JSON.stringify(res));
    check('repair charges REPAIR_COST_PER_POINT * missing', res.opSpent === 50, JSON.stringify(res));
    check('repair debits the balance', res.opBalance === 50, JSON.stringify(res));

    const row = await inventoryStore.instances.byId(inst);
    check('the stored instance reflects the repair', row.durability === 100);

    // §10: repair emits both a currency event and a gameplay event, in the same ledger tx.
    const spent = events.find((e) => e.type === 'op.spent');
    check('repair emits op.spent', spent?.payload?.reason === 'repair' && spent.payload.delta === -50,
      JSON.stringify(spent));
    check('op.spent is actor:player and audit-retained', spent?.actor?.kind === 'player' && spent.retentionClass === 'audit',
      JSON.stringify(spent));
    const repaired = events.find((e) => e.type === 'item.repaired');
    check('repair emits item.repaired', repaired?.payload?.instanceId === inst && repaired.payload.opSpent === 50,
      JSON.stringify(repaired));
  }

  {
    const { inventoryStore, inventoryService, progression, progressionStore } = await freshHarness();
    const a = ulid();
    await seedWeaponDef(inventoryService);
    const inst = await permanentInstance(inventoryStore, { accountId: a, durability: 50 });
    await grantOp(progressionStore, a, 10); // cost would be 50; balance is 10

    await throwsCode('repair refuses insufficient balance', 'OP_INSUFFICIENT_BALANCE', () =>
      progression.repairInstance({ accountId: a, instanceId: inst, idempotencyKey: ulid() }));
    const row = await inventoryStore.instances.byId(inst);
    check('a refused repair leaves durability untouched', row.durability === 50);
    const account = await progressionStore.accounts.get(a);
    check('a refused repair leaves the balance untouched', account.opBalance === 10, JSON.stringify(account));
  }

  {
    const { inventoryStore, inventoryService, progression, progressionStore } = await freshHarness();
    const a = ulid();
    await seedWeaponDef(inventoryService);
    const inst = await permanentInstance(inventoryStore, { accountId: a, durability: 100 });
    await grantOp(progressionStore, a, 100);
    await throwsCode('repair refuses an already-full instance', 'ITEM_NOT_REPAIRABLE', () =>
      progression.repairInstance({ accountId: a, instanceId: inst, idempotencyKey: ulid() }));
  }

  // --------------------------------------------------------------------------------- upgrade

  {
    const { inventoryStore, inventoryService, progression, progressionStore, events } = await freshHarness();
    const a = ulid();
    await seedWeaponDef(inventoryService, 'rifle_ak74', { maxUpgradeTier: 3 });
    const inst = await permanentInstance(inventoryStore, { accountId: a, durability: 100 });
    await grantOp(progressionStore, a, 300);

    let last;
    for (let i = 0; i < 3; i++) {
      // eslint-disable-next-line no-await-in-loop
      last = await progression.upgradeInstance({ accountId: a, instanceId: inst, idempotencyKey: ulid() });
    }
    check('upgrade reaches maxUpgradeTier', last.tier === 3, JSON.stringify(last));
    check('upgrade spends the tiered cost table (40+80+120=240)', last.opBalance === 60, JSON.stringify(last));

    const upgraded = events.filter((e) => e.type === 'item.upgraded');
    check('upgrade emits item.upgraded once per tier', upgraded.length === 3
      && upgraded.map((e) => e.payload.tier).join(',') === '1,2,3', JSON.stringify(upgraded));
    const spent = events.filter((e) => e.type === 'op.spent' && e.payload.reason === 'upgrade');
    check('upgrade emits op.spent per tier', spent.length === 3, JSON.stringify(spent));

    const row = await inventoryStore.instances.byId(inst);
    check('attachments holds at most one upgrade element', row.attachments.filter((x) => x.kind === 'upgrade').length === 1,
      JSON.stringify(row.attachments));

    await throwsCode('upgrade past maxUpgradeTier is refused', 'ITEM_MAX_TIER', () =>
      progression.upgradeInstance({ accountId: a, instanceId: inst, idempotencyKey: ulid() }));
  }

  {
    // migration 0031: a definition with no authored maxUpgradeTier has no upgrade path at
    // all — refused, not silently defaulted to DEFAULT_MAX_UPGRADE_TIER.
    const { inventoryStore, inventoryService, progression, progressionStore } = await freshHarness();
    const a = ulid();
    await seedWeaponDef(inventoryService, 'rifle_unauthored', { maxUpgradeTier: null });
    const inst = await permanentInstance(inventoryStore, { accountId: a, itemId: 'rifle_unauthored', durability: 100 });
    await grantOp(progressionStore, a, 300);

    await throwsCode('upgrade refuses a definition with no authored maxUpgradeTier', 'ITEM_MAX_TIER', () =>
      progression.upgradeInstance({ accountId: a, instanceId: inst, idempotencyKey: ulid() }));
    const account = await progressionStore.accounts.get(a);
    check('a refused upgrade leaves the balance untouched', account.opBalance === 300, JSON.stringify(account));
  }

  {
    const { inventoryStore, inventoryService, progression, progressionStore } = await freshHarness();
    const a = ulid();
    await seedWeaponDef(inventoryService);
    const inst = await permanentInstance(inventoryStore, { accountId: a, durability: 0 });
    await grantOp(progressionStore, a, 100);
    await throwsCode('a broken instance cannot be upgraded', 'ITEM_BROKEN', () =>
      progression.upgradeInstance({ accountId: a, instanceId: inst, idempotencyKey: ulid() }));
  }

  // ------------------------------------------------------------------------ ITEM_BROKEN loadout

  {
    const { inventoryStore, inventoryService } = await freshHarness();
    const a = ulid();
    await seedWeaponDef(inventoryService);
    const inst = await permanentInstance(inventoryStore, { accountId: a, durability: 0 });
    await throwsCode('a broken instance cannot be placed in a loadout slot', 'ITEM_BROKEN', () =>
      inventoryService.createLoadout(a, { name: 'default', slots: { primary: inst } }));

    await inventoryStore.instances.mutate(inst, { durability: 100 });
    const loadout = await inventoryService.createLoadout(a, { name: 'default', slots: { primary: inst } });
    check('a repaired instance can be equipped', loadout.slots.primary === inst);
  }

  // --------------------------------------------------------------------- run reward + durability

  {
    const { store, inventoryStore, inventoryService, settlement, progressionStore, events } = await freshHarness();
    const runId = ulid();
    const a = ulid();
    await seedAccount(store, a);
    await store.matches.allocateRun({
      matchId: runId, region: 'yyz', mapId: 'sector-7', serverBuild: 'build-1', participants: [a],
    });
    await seedWeaponDef(inventoryService);
    const inst = await seedRunInstance(inventoryStore, { runId, accountId: a, durability: 100 });

    const body = {
      runId, participants: [{ accountId: a, outcome: 'extracted', exitId: 'exit_north' }],
      startedAt: '2026-08-22T12:00:00.000Z', endedAt: '2026-08-22T12:05:00.000Z',
      serverBuild: 'build-1', sectorSet: ['sector-7'], evidenceRef: `sha256:${ulid()}`,
    };

    await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId), runResult: body,
    });

    // 5 survived minutes: BASE_EXTRACT_OP (50) + min(MAX_SURVIVAL_OP, 1*5) = 55.
    const account = await progressionStore.accounts.get(a);
    check('extraction awards run-reward + run-survival OP', account.opBalance === 55, JSON.stringify(account));
    check('extraction awards XP and computes a level', account.xp > 0 && account.level >= 1, JSON.stringify(account));

    // §10: a run award emits op.earned (service actor, audit) per reason, plus
    // progression.xp.earned (standard) for each reason that carries XP.
    const earned = events.filter((e) => e.type === 'op.earned');
    check('run award emits op.earned per reason (run-reward, run-survival)', earned.length === 2
      && earned.every((e) => e.payload.runId === runId) && earned.every((e) => e.actor.kind === 'service')
      && earned.every((e) => e.retentionClass === 'audit'), JSON.stringify(earned));
    const xpEarned = events.filter((e) => e.type === 'progression.xp.earned');
    // 100 + 10 XP total stays under the 500 XP/level curve, so neither reason crosses a level.
    check('run award emits progression.xp.earned per reason, standard-retained, no level crossed',
      xpEarned.length === 2 && xpEarned.every((e) => e.retentionClass === 'standard')
      && xpEarned.every((e) => e.payload.leveledUp === false), JSON.stringify(xpEarned));

    const row = await inventoryStore.instances.byId(inst);
    check('durability depletes exactly DURABILITY_LOSS_PER_RUN on extraction',
      row.durability === 100 - DURABILITY_LOSS_PER_RUN, JSON.stringify(row));

    // Invariant 4 (§9): a run awards each reason at most once per (runId, accountId) — a
    // byte-identical retry of the same submission replays the stored settlement response
    // (settlement.md §5) without re-running settleParticipant, so the OP award never repeats.
    await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId), runResult: body,
    });
    const accountAfterReplay = await progressionStore.accounts.get(a);
    check('a duplicate settlement submission never double-awards OP',
      accountAfterReplay.opBalance === account.opBalance, JSON.stringify(accountAfterReplay));
  }

  // ------------------------------------------------------- crash between settlement and award

  {
    // Economy review, round 1: a transient failure in the progression store between
    // `settleParticipant`'s own transaction committing and the OP award landing must NOT be
    // an unrecoverable loss. Simulate exactly that window — `progression.awardForRun` throws
    // on its first invocation only — and assert a retry of `submitRunResult` (the only avenue
    // available, since `settleParticipant` has no return path back into its own transaction)
    // still lands the award, rather than being permanently swallowed by the 'settled' guard.
    const store = createMemoryStore({ storage: 'memory' });
    const outbox = createOutbox({ store, logger: null });
    const inventoryStore = createMemoryInventoryStore();
    const inventoryService = createInventoryService({ store: inventoryStore, emit: null });
    const progressionStore = createMemoryProgressionStore();
    const realProgression = createProgressionService({ store: progressionStore, inventoryService });
    let awardCalls = 0;
    const flakyProgression = {
      ...realProgression,
      async awardForRun(args) {
        awardCalls++;
        if (awardCalls === 1) throw new Error('simulated transient progression-store failure');
        return realProgression.awardForRun(args);
      },
    };
    const settlement = createSettlementService({ store, inventoryService, outbox, progression: flakyProgression });

    const runId = ulid();
    const a = ulid();
    await seedAccount(store, a);
    await store.matches.allocateRun({
      matchId: runId, region: 'yyz', mapId: 'sector-7', serverBuild: 'build-1', participants: [a],
    });
    await seedWeaponDef(inventoryService);
    await seedRunInstance(inventoryStore, { runId, accountId: a, durability: 100 });

    const body = {
      runId, participants: [{ accountId: a, outcome: 'extracted', exitId: 'exit_north' }],
      startedAt: '2026-08-22T12:00:00.000Z', endedAt: '2026-08-22T12:05:00.000Z',
      serverBuild: 'build-1', sectorSet: ['sector-7'], evidenceRef: `sha256:${ulid()}`,
    };

    let firstErr = null;
    try {
      await settlement.submitRunResult({ actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId), runResult: body });
    } catch (err) {
      firstErr = err;
    }
    check('the first submission surfaces the simulated failure', firstErr !== null, String(firstErr));

    const participantAfterCrash = await store.matches.getParticipant(runId, a);
    check('the item/event transaction still committed despite the later award failure',
      participantAfterCrash?.stats?.settlementStatus === 'settled', JSON.stringify(participantAfterCrash));
    const accountAfterCrash = await progressionStore.accounts.get(a);
    check('no OP was awarded on the failed attempt', accountAfterCrash.opBalance === 0, JSON.stringify(accountAfterCrash));

    // Retry: the outer idempotency record was never written (it is written last, after every
    // participant), so this is a genuine re-run, not a replay short-circuit.
    const retryResult = await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId), runResult: body,
    });
    check('the retry succeeds', retryResult.participants?.[0]?.settlementStatus === 'settled', JSON.stringify(retryResult));

    const accountAfterRetry = await progressionStore.accounts.get(a);
    check('the retry recovers the previously-lost OP/XP award',
      accountAfterRetry.opBalance === 55, JSON.stringify(accountAfterRetry));
    check('awardForRun was attempted exactly twice (lost, then recovered)', awardCalls === 2, String(awardCalls));

    // A further retry (award already idempotent-committed) must not double-credit.
    await settlement.submitRunResult({ actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId), runResult: body });
    const accountAfterSecondRetry = await progressionStore.accounts.get(a);
    check('a subsequent replay never double-awards OP',
      accountAfterSecondRetry.opBalance === 55, JSON.stringify(accountAfterSecondRetry));
  }

  // ------------------------------------------------------------------------ died earns no reward

  {
    const { store, inventoryStore, inventoryService, settlement, progressionStore } = await freshHarness();
    const runId = ulid();
    const a = ulid();
    await seedAccount(store, a);
    await store.matches.allocateRun({
      matchId: runId, region: 'yyz', mapId: 'sector-7', serverBuild: 'build-1', participants: [a],
    });
    await seedWeaponDef(inventoryService);
    await seedRunInstance(inventoryStore, { runId, accountId: a, durability: 100 });

    await settlement.submitRunResult({
      actor: SERVICE_ACTOR, idempotencyKey: idempotencyKeyFor(runId),
      runResult: {
        runId, participants: [{ accountId: a, outcome: 'died', deathCause: 'player' }],
        startedAt: '2026-08-22T12:00:00.000Z', endedAt: '2026-08-22T12:00:30.000Z',
        serverBuild: 'build-1', sectorSet: ['sector-7'], evidenceRef: `sha256:${ulid()}`,
      },
    });
    const account = await progressionStore.accounts.get(a);
    check('death earns no run-reward', account.opBalance === 0, JSON.stringify(account));
  }

  // --------------------------------------------------------------------------- never negative

  {
    const { inventoryStore, inventoryService, progression, progressionStore } = await freshHarness();
    const a = ulid();
    await seedWeaponDef(inventoryService);
    const inst = await permanentInstance(inventoryStore, { accountId: a, durability: 0 });
    await inventoryStore.instances.mutate(inst, { durability: 50 });
    await grantOp(progressionStore, a, 50); // exactly one repair's cost (cost = 50)

    const results = await Promise.allSettled([
      progression.repairInstance({ accountId: a, instanceId: inst, idempotencyKey: ulid() }),
      progression.repairInstance({ accountId: a, instanceId: inst, idempotencyKey: ulid() }),
    ]);
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    check('exactly one of two racing repairs succeeds', succeeded.length === 1, JSON.stringify(results));
    check('the loser is refused for balance, not left partial',
      failed[0]?.reason?.code === 'OP_INSUFFICIENT_BALANCE' || failed[0]?.reason?.code === 'ITEM_NOT_REPAIRABLE',
      JSON.stringify(results));
    const account = await progressionStore.accounts.get(a);
    check('the balance never goes negative', account.opBalance >= 0, JSON.stringify(account));
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} progressiontest`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
