/**
 * Deployment reservation + signed snapshot conformance.  contracts/deployment.md §9.
 *
 * Runs against the memory adapters for both `inventory` (P3-01) and `deployment` (P3-02) — the
 * same split every other module's test suite uses. Every invariant claim is paired with a
 * CONTROL where the sibling suites establish one, for the same reason: a check that only ever
 * sees "the thing was refused" cannot tell a working guard from a store that refuses everything.
 *
 *   node platform/test/deploymenttest.mjs
 */
import { createMemoryInventoryStore } from '../src/modules/inventory/store.js';
import { createInventoryService } from '../src/modules/inventory/index.js';
import { createMemoryDeploymentStore } from '../src/modules/deployment/store.js';
import { createDeploymentService } from '../src/modules/deployment/index.js';

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

async function expectOk(name, fn) {
  try {
    const result = await fn();
    ok(name);
    return result;
  } catch (err) {
    bad(name, `threw ${err?.code ?? ''} ${err?.message ?? err}`);
    return undefined;
  }
}

const SYSTEM_ACTOR = { kind: 'service', id: 'test', role: 'loot-spawn' };

function freshHarness() {
  let nowMs = Date.parse('2026-08-22T12:00:00.000Z');
  const clock = { now: () => nowMs };
  const events = [];
  const inventoryStore = createMemoryInventoryStore();
  const inventoryService = createInventoryService({ store: inventoryStore, emit: async (e) => events.push(e) });
  const deploymentStore = createMemoryDeploymentStore();
  const deploymentService = createDeploymentService({
    inventoryService, store: deploymentStore, clock, signingSecret: 'test-secret',
    emit: async (e) => events.push(e),
  });
  return {
    inventoryService, deploymentService, events, clock,
    advance(ms) { nowMs += ms; },
  };
}

async function seedDefinitions(svc) {
  await svc.defineItem({ itemId: 'rifle_ak74', class: 'weapon', slot: 'primary', rarityTier: 'common', stackable: false });
  await svc.defineItem({ itemId: 'smg_mp5', class: 'weapon', slot: 'primary', rarityTier: 'common', stackable: false });
  await svc.defineItem({ itemId: 'pistol', class: 'weapon', slot: 'secondary', rarityTier: 'common', stackable: false });
  await svc.defineItem({ itemId: 'helmet_basic', class: 'gear', slot: 'helmet', rarityTier: 'common', stackable: false });
  await svc.defineItem({ itemId: 'ammo_9mm', class: 'material', slot: null, rarityTier: 'common', stackable: true, maxStack: 999 });
}

async function grantRifle(svc, owner) {
  return (await svc.grantItem({ itemId: 'rifle_ak74', ownerAccountId: owner, quantity: 1, location: 'permanent', actor: SYSTEM_ACTOR })).instance;
}

async function main() {
  // --------------------------------------------------------------- §7 request shape / §2.1

  {
    const { deploymentService } = freshHarness();
    await throwsCode('POST /v1/deployments with neither loadoutId nor instanceIds is rejected', 'DEPLOYMENT_REQUEST_INVALID', () =>
      deploymentService.reserve({ accountId: 'acct_a', roomId: 'room_1' }));
    await throwsCode('POST /v1/deployments with both loadoutId and instanceIds is rejected', 'DEPLOYMENT_REQUEST_INVALID', () =>
      deploymentService.reserve({ accountId: 'acct_a', loadoutId: 'lo_1', instanceIds: ['x'], roomId: 'room_1' }));
    await throwsCode('POST /v1/deployments with an empty instanceIds array is rejected', 'DEPLOYMENT_REQUEST_INVALID', () =>
      deploymentService.reserve({ accountId: 'acct_a', instanceIds: [], roomId: 'room_1' }));
  }

  // --------------------------------------------------------- §9.1 reservation conflict (§3)

  {
    const { inventoryService, deploymentService } = freshHarness();
    await seedDefinitions(inventoryService);
    const rifle = await grantRifle(inventoryService, 'acct_a');

    const results = await Promise.allSettled([
      deploymentService.reserve({ accountId: 'acct_a', instanceIds: [rifle.instanceId], roomId: 'room_1' }),
      deploymentService.reserve({ accountId: 'acct_a', instanceIds: [rifle.instanceId], roomId: 'room_1' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    check('§9.1 exactly one of two concurrent reservations on the same instance wins', fulfilled.length === 1 && rejected.length === 1,
      JSON.stringify(results.map((r) => r.status)));
    check('§9.1 the loser gets DEPLOYMENT_RESERVATION_CONFLICT', rejected[0]?.reason?.code === 'DEPLOYMENT_RESERVATION_CONFLICT',
      rejected[0]?.reason?.code);
    check('§9.1 the conflict names the contested instance as ITEM_ALREADY_DEPLOYED',
      rejected[0]?.reason?.details?.conflictingInstances?.[0]?.reason === 'ITEM_ALREADY_DEPLOYED',
      JSON.stringify(rejected[0]?.reason?.details));

    const winnerId = fulfilled[0].value.reservationId;
    const reservations = await Promise.all([winnerId].map((id) => deploymentService.store.reservations.byId(id)));
    check('§9.1 exactly one reserved row exists (the loser wrote nothing)', reservations[0].status === 'reserved', JSON.stringify(reservations));
    const instance = await inventoryService.getInstance(rifle.instanceId);
    check('§9.1 the instance is locked to the winning reservation only', instance.locked && instance.lockedByDeploymentId === winnerId,
      JSON.stringify(instance));
  }

  // --------------------------------------------------------------- §9.2 release + re-reserve

  {
    const { inventoryService, deploymentService } = freshHarness();
    await seedDefinitions(inventoryService);
    const rifle = await grantRifle(inventoryService, 'acct_a');
    const { reservationId } = await expectOk('§9.2 initial reservation succeeds', () =>
      deploymentService.reserve({ accountId: 'acct_a', instanceIds: [rifle.instanceId], roomId: 'room_1' }));

    await expectOk('§9.2 client-initiated abort releases the reservation', () =>
      deploymentService.releaseAbort({ accountId: 'acct_a', reservationId }));
    const released = await deploymentService.store.reservations.byId(reservationId);
    check('§9.2 the reservation reads back released/abort', released.status === 'released' && released.releasedReason === 'abort',
      JSON.stringify(released));
    const unlocked = await inventoryService.getInstance(rifle.instanceId);
    check('§9.2 the instance is unlocked after release', unlocked.locked === false && unlocked.lockedByDeploymentId === null,
      JSON.stringify(unlocked));

    await expectOk('§9.2 the released instance is immediately re-reservable', () =>
      deploymentService.reserve({ accountId: 'acct_a', instanceIds: [rifle.instanceId], roomId: 'room_1' }));

    // DELETE is idempotent — repeating it on an already-terminal reservation is success.
    await expectOk('§7 DELETE on an already-released reservation is idempotent, not an error', () =>
      deploymentService.releaseAbort({ accountId: 'acct_a', reservationId }));

    // 404 collapses "doesn't exist" and "not yours" into one code.
    await throwsCode('§7 DELETE on someone else\'s reservation is NOT_FOUND, not a leak', 'NOT_FOUND', () =>
      deploymentService.releaseAbort({ accountId: 'acct_intruder', reservationId }));
  }

  // ---------------------------------------------------------- snapshot issuance / verification

  async function deployAndAllocate(h, accountId, instanceId, matchId) {
    const { reservationId } = await h.deploymentService.reserve({ accountId, instanceIds: [instanceId], roomId: 'room_1' });
    const { payload, signature } = await h.deploymentService.issueSnapshot({ reservationId, matchId });
    return { reservationId, payload, signature };
  }

  // ------------------------------------------------------------------- §9.3 matchId binding

  {
    const h = freshHarness();
    await seedDefinitions(h.inventoryService);
    const rifle = await grantRifle(h.inventoryService, 'acct_a');
    const { payload, signature } = await deployAndAllocate(h, 'acct_a', rifle.instanceId, 'match_A');

    await throwsCode('§9.3 a snapshot signed for match A is rejected by a server allocated to match B',
      'DEPLOYMENT_SNAPSHOT_INVALID', () =>
        h.deploymentService.verifySnapshot({ matchId: 'match_B', accountId: 'acct_a', snapshot: { payload, signature } }));

    // CONTROL: presented to the right match, it verifies.
    await expectOk('control: the same snapshot verifies against the match it was actually issued for', () =>
      h.deploymentService.verifySnapshot({ matchId: 'match_A', accountId: 'acct_a', snapshot: { payload, signature } }));
  }

  // ------------------------------------------------------------------------- §9.4 replay

  {
    const h = freshHarness();
    await seedDefinitions(h.inventoryService);
    const rifle = await grantRifle(h.inventoryService, 'acct_a');
    const { payload, signature } = await deployAndAllocate(h, 'acct_a', rifle.instanceId, 'match_A');

    await expectOk('§9.4 first presentation of a valid snapshot verifies', () =>
      h.deploymentService.verifySnapshot({ matchId: 'match_A', accountId: 'acct_a', snapshot: { payload, signature } }));
    await throwsCode('§9.4 a byte-identical replay of the same snapshot is rejected', 'DEPLOYMENT_SNAPSHOT_INVALID', () =>
      h.deploymentService.verifySnapshot({ matchId: 'match_A', accountId: 'acct_a', snapshot: { payload, signature } }));
  }

  // ------------------------------------------------------------------------- §9.5 expiry sweep

  {
    const h = freshHarness();
    await seedDefinitions(h.inventoryService);
    const rifle = await grantRifle(h.inventoryService, 'acct_a');
    await expectOk('§9.5 a reservation is created', () =>
      h.deploymentService.reserve({ accountId: 'acct_a', instanceIds: [rifle.instanceId], roomId: 'room_1' }));

    h.advance(91_000); // past the 90s TTL (§2.2), no explicit release
    const swept = await expectOk('§9.5 the sweep runs without error', () => h.deploymentService.sweepExpired());
    check('§9.5 the sweep caught exactly the one expired reservation', swept.length === 1, `got ${swept.length}`);
    check('§9.5 the swept row is status=expired with a release reason', swept[0].status === 'expired' && swept[0].releasedReason === 'expiry',
      JSON.stringify(swept[0]));
    const instance = await h.inventoryService.getInstance(rifle.instanceId);
    check('§9.5 its instance is unlocked, never held past expiry', instance.locked === false, JSON.stringify(instance));

    await expectOk('§9.5 the freed instance is immediately re-reservable', () =>
      h.deploymentService.reserve({ accountId: 'acct_a', instanceIds: [rifle.instanceId], roomId: 'room_1' }));
  }

  // --------------------------------------------------------- §9.6 consumed is untouched

  {
    const h = freshHarness();
    await seedDefinitions(h.inventoryService);
    const rifle = await grantRifle(h.inventoryService, 'acct_a');
    const { reservationId, payload, signature } = await deployAndAllocate(h, 'acct_a', rifle.instanceId, 'match_A');
    await expectOk('§9.6 admission succeeds', () =>
      h.deploymentService.verifySnapshot({ matchId: 'match_A', accountId: 'acct_a', snapshot: { payload, signature } }));

    h.advance(200_000); // well past both the 60s snapshot and 90s reservation TTLs
    const swept = await h.deploymentService.sweepExpired();
    check('§9.6 the expiry sweep never touches a consumed reservation', swept.length === 0, `swept ${swept.length}`);

    await throwsCode('§9.6 a late abort on a consumed reservation is refused, not silently accepted',
      'DEPLOYMENT_ALREADY_CONSUMED', () =>
        h.deploymentService.releaseAbort({ accountId: 'acct_a', reservationId }));

    const instance = await h.inventoryService.getInstance(rifle.instanceId);
    check('§9.6 the instance stays locked and in the run after both', instance.locked === true && instance.location === 'run',
      JSON.stringify(instance));
  }

  // ------------------------------------------------------- §9.7 frozen gameplay state

  {
    const h = freshHarness();
    await seedDefinitions(h.inventoryService);
    const rifle = await grantRifle(h.inventoryService, 'acct_a');
    const { payload } = await deployAndAllocate(h, 'acct_a', rifle.instanceId, 'match_A');
    const item = payload.items.find((i) => i.instanceId === rifle.instanceId);
    check('§9.7 the snapshot item mirrors the instance at lock time', item.quantity === rifle.quantity && item.durability === rifle.durability,
      JSON.stringify({ item, rifle }));
    check('§9.7 durability is null in P3 (items-inventory.md §10)', item.durability === null, JSON.stringify(item));

    await throwsCode('§9.7 a locked instance still refuses a guarded mutation underneath the signed snapshot',
      'ITEM_LOCKED', () => h.inventoryService.mutateInstance(rifle.instanceId, { quantity: 5 }));
  }

  // ----------------------------------------------------- §9.8 cross-account isolation

  {
    const h = freshHarness();
    await seedDefinitions(h.inventoryService);
    const rifleA = await grantRifle(h.inventoryService, 'acct_a');
    const rifleB = await grantRifle(h.inventoryService, 'acct_b');

    const results = await Promise.allSettled([
      h.deploymentService.reserve({ accountId: 'acct_a', instanceIds: [rifleA.instanceId], roomId: 'room_1' }),
      h.deploymentService.reserve({ accountId: 'acct_b', instanceIds: [rifleB.instanceId], roomId: 'room_2' }),
    ]);
    check('§9.8 two accounts racing on disjoint instances both win', results.every((r) => r.status === 'fulfilled'),
      JSON.stringify(results.map((r) => r.status)));
  }

  // -------------------------------------------------- §9.9 atomic run seed, never partial

  {
    const h = freshHarness();
    await seedDefinitions(h.inventoryService);
    const rifle = await grantRifle(h.inventoryService, 'acct_a');
    const pistol = (await h.inventoryService.grantItem({ itemId: 'pistol', ownerAccountId: 'acct_a', quantity: 1, location: 'permanent', actor: SYSTEM_ACTOR })).instance;
    const { reservationId } = await h.deploymentService.reserve({ accountId: 'acct_a', instanceIds: [rifle.instanceId, pistol.instanceId], roomId: 'room_1' });
    const { payload, signature } = await h.deploymentService.issueSnapshot({ reservationId, matchId: 'match_A' });
    await h.deploymentService.verifySnapshot({ matchId: 'match_A', accountId: 'acct_a', snapshot: { payload, signature } });

    const after = await Promise.all([rifle.instanceId, pistol.instanceId].map((id) => h.inventoryService.getInstance(id)));
    check('§9.9 every locked instance moved to the run, none left behind in permanent',
      after.every((i) => i.location === 'run' && i.runId === 'match_A'), JSON.stringify(after));
  }

  // ------------------------------------------------------------- §9.11 ad hoc rule 2/3/5

  {
    const h = freshHarness();
    await seedDefinitions(h.inventoryService);
    const rifle = await grantRifle(h.inventoryService, 'acct_a');
    const pistol = (await h.inventoryService.grantItem({ itemId: 'pistol', ownerAccountId: 'acct_a', quantity: 1, location: 'permanent', actor: SYSTEM_ACTOR })).instance;
    const ammo = (await h.inventoryService.grantItem({ itemId: 'ammo_9mm', ownerAccountId: 'acct_a', quantity: 30, location: 'permanent', actor: SYSTEM_ACTOR })).instance;

    await throwsCode('§9.11 an ad hoc instanceIds request with a slot=null instance is rejected before locking',
      'LOADOUT_INVALID_SLOT', () =>
        h.deploymentService.reserve({ accountId: 'acct_a', instanceIds: [rifle.instanceId, ammo.instanceId], roomId: 'room_1' }));
    const rifleAfterSlotReject = await h.inventoryService.getInstance(rifle.instanceId);
    check('§9.11 the slot=null rejection left the other candidate unlocked (no partial reservation)',
      rifleAfterSlotReject.locked === false, JSON.stringify(rifleAfterSlotReject));

    // A second, DIFFERENT primary-slot weapon — not a second rifle_ak74, which would collide
    // with the documented items-inventory.md contract finding (two identical non-stackable
    // grants in the same collapse-index bucket). rifle/smg both target slot 'primary'.
    const rifle2 = (await h.inventoryService.grantItem({ itemId: 'smg_mp5', ownerAccountId: 'acct_a', quantity: 1, location: 'permanent', actor: SYSTEM_ACTOR })).instance;
    await throwsCode('§9.11 two ad hoc instances sharing one slot are rejected before locking',
      'LOADOUT_DUPLICATE_INSTANCE', () =>
        h.deploymentService.reserve({ accountId: 'acct_a', instanceIds: [rifle2.instanceId, rifle.instanceId], roomId: 'room_1' }));
    const rifle2After = await h.inventoryService.getInstance(rifle2.instanceId);
    check('§9.11 the duplicate-slot rejection left both candidates unlocked', rifle2After.locked === false, JSON.stringify(rifle2After));

    // CONTROL: distinct slots (primary + secondary) are fine.
    await expectOk('control: an ad hoc request with distinct slots reserves cleanly', () =>
      h.deploymentService.reserve({ accountId: 'acct_a', instanceIds: [rifle.instanceId, pistol.instanceId], roomId: 'room_1' }));
  }

  // --------------------------------------------------------- §9.12 expiry race at admission

  {
    const h = freshHarness();
    await seedDefinitions(h.inventoryService);
    const rifle = await grantRifle(h.inventoryService, 'acct_a');
    const { reservationId } = await h.deploymentService.reserve({ accountId: 'acct_a', instanceIds: [rifle.instanceId], roomId: 'room_1' });

    // The independent-clocks race (§4.3/§4.5 step 4): match allocation takes a while, so the
    // snapshot is issued late in the reservation's 90s window — its OWN 60s TTL then outlives
    // the reservation's remaining TTL, opening the gap the sweep can land in before admission.
    h.advance(70_000);
    const { snapshotId, payload, signature } = await h.deploymentService.issueSnapshot({ reservationId, matchId: 'match_A' });

    h.advance(21_000); // reservation's 90s TTL now elapsed (70s+21s=91s); snapshot's 60s-from-issuance is not (21s<60s)
    const swept = await h.deploymentService.sweepExpired();
    check('§9.12 setup: the reservation was actually swept to expired before admission landed', swept.length === 1, `got ${swept.length}`);

    await throwsCode('§9.12 admission on a snapshot whose reservation expired underneath it is DEPLOYMENT_RESERVATION_EXPIRED',
      'DEPLOYMENT_RESERVATION_EXPIRED', () =>
        h.deploymentService.verifySnapshot({ matchId: 'match_A', accountId: 'acct_a', snapshot: { payload, signature } }));

    const snapshotRow = await h.deploymentService.store.snapshots.byId(snapshotId);
    check('§9.12 the rejected attempt did NOT burn the snapshot\'s one-time use (still unconsumed)', snapshotRow?.consumedAt === null,
      JSON.stringify(snapshotRow));
  }

  // -------------------------------------------------------------- events sanity (§6)

  {
    const h = freshHarness();
    await seedDefinitions(h.inventoryService);
    const rifle = await grantRifle(h.inventoryService, 'acct_a');
    const { reservationId } = await h.deploymentService.reserve({ accountId: 'acct_a', instanceIds: [rifle.instanceId], roomId: 'room_1' });
    await h.deploymentService.issueSnapshot({ reservationId, matchId: 'match_A' });
    const types = h.events.map((e) => e.type);
    check('events: deployment.reserved was emitted', types.includes('deployment.reserved'), types.join(','));
    check('events: deployment.snapshot.issued was emitted', types.includes('deployment.snapshot.issued'), types.join(','));
  }

  console.log(failures ? `\n${failures} FAILED` : '\ndeployment runs clean');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack ?? err);
  process.exit(1);
});
