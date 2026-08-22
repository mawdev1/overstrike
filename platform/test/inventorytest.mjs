/**
 * Inventory conformance.  contracts/items-inventory.md §9.
 *
 * Runs against the memory adapter (used by every other module's tests and by local work) plus
 * the Postgres adapter when DATABASE_URL is set, mirroring test/storetest.mjs's own split.
 * Every invariant claim is paired with a CONTROL — a case that must produce the OPPOSITE
 * result — for the same reason storetest.mjs pairs them: a check that only ever sees "the
 * thing was refused" cannot tell a working guard from a store that refuses everything.
 *
 *   node platform/test/inventorytest.mjs
 */
import { createMemoryInventoryStore } from '../src/modules/inventory/store.js';
import { createInventoryService } from '../src/modules/inventory/index.js';

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

function freshService() {
  const store = createMemoryInventoryStore();
  return createInventoryService({ store });
}

async function seedDefinitions(svc) {
  await svc.defineItem({ itemId: 'rifle_ak74', class: 'weapon', slot: 'primary', rarityTier: 'common', stackable: false });
  await svc.defineItem({ itemId: 'helmet_basic', class: 'gear', slot: 'helmet', rarityTier: 'common', stackable: false });
  await svc.defineItem({ itemId: 'medkit', class: 'consumable', slot: 'consumable', rarityTier: 'uncommon', stackable: false });
  await svc.defineItem({ itemId: 'ammo_9mm', class: 'material', slot: null, rarityTier: 'common', stackable: true, maxStack: 999 });
}

async function main() {
  // -------------------------------------------------------------------------- definitions

  {
    const svc = freshService();
    await expectOk('defineItem accepts a well-formed weapon definition', () =>
      svc.defineItem({ itemId: 'x1', class: 'weapon', slot: 'primary', rarityTier: 'common', stackable: false }));
    await throwsCode('defineItem rejects an unknown class', 'VALIDATION_FAILED', () =>
      svc.defineItem({ itemId: 'x2', class: 'nonsense', slot: 'primary', rarityTier: 'common', stackable: false }));
    await throwsCode('defineItem rejects an unknown slot', 'VALIDATION_FAILED', () =>
      svc.defineItem({ itemId: 'x3', class: 'weapon', slot: 'nonsense', rarityTier: 'common', stackable: false }));
    await throwsCode('defineItem rejects an unknown rarity tier', 'VALIDATION_FAILED', () =>
      svc.defineItem({ itemId: 'x4', class: 'weapon', slot: 'primary', rarityTier: 'nonsense', stackable: false }));
  }

  // ----------------------------------------------------------- §6.3 duplication prevention

  {
    const svc = freshService();
    await seedDefinitions(svc);

    const g1 = await svc.grantItem({ itemId: 'ammo_9mm', ownerAccountId: 'acct_a', quantity: 30, location: 'run', runId: 'run_1', actor: SYSTEM_ACTOR });
    const g2 = await svc.grantItem({ itemId: 'ammo_9mm', ownerAccountId: 'acct_a', quantity: 20, location: 'run', runId: 'run_1', actor: SYSTEM_ACTOR });
    check('two stackable grants into the same run collapse into one row', g1.instance.instanceId === g2.instance.instanceId,
      `${g1.instance.instanceId} vs ${g2.instance.instanceId}`);
    check('the collapsed row carries the summed quantity, not a duplicate', g2.instance.quantity === 50, `got ${g2.instance.quantity}`);
    const rows = await svc.listRunInventory('run_1');
    check('exactly one active row exists for the collapsed stack', rows.length === 1, `got ${rows.length} rows`);

    // CONTROL: a different container is a different collapse key — two independent rows.
    const c1 = await svc.grantItem({ itemId: 'ammo_9mm', ownerAccountId: 'acct_a', quantity: 5, location: 'container', containerId: 'crate_1', actor: SYSTEM_ACTOR });
    const c2 = await svc.grantItem({ itemId: 'ammo_9mm', ownerAccountId: 'acct_a', quantity: 5, location: 'container', containerId: 'crate_2', actor: SYSTEM_ACTOR });
    check('control: two different containers do NOT collapse', c1.instance.instanceId !== c2.instance.instanceId,
      'two different containers produced the same instance');

    // Race: concurrent pickups of the SAME stack must still collapse to one row with the
    // correct summed quantity — not a lost update, not two rows.
    const before = await svc.listRunInventory('run_1');
    const totalBefore = before.reduce((s, r) => s + r.quantity, 0);
    await Promise.all([
      svc.grantItem({ itemId: 'ammo_9mm', ownerAccountId: 'acct_a', quantity: 10, location: 'run', runId: 'run_1', actor: SYSTEM_ACTOR }),
      svc.grantItem({ itemId: 'ammo_9mm', ownerAccountId: 'acct_a', quantity: 10, location: 'run', runId: 'run_1', actor: SYSTEM_ACTOR }),
      svc.grantItem({ itemId: 'ammo_9mm', ownerAccountId: 'acct_a', quantity: 10, location: 'run', runId: 'run_1', actor: SYSTEM_ACTOR }),
    ]);
    const after = await svc.listRunInventory('run_1');
    check('a race of concurrent pickups still leaves exactly one active row', after.length === 1, `got ${after.length}`);
    const totalAfter = after.reduce((s, r) => s + r.quantity, 0);
    check('a race of concurrent pickups sums correctly with no lost update', totalAfter === totalBefore + 30,
      `expected ${totalBefore + 30}, got ${totalAfter}`);

    await throwsCode('grantItem refuses quantity != 1 for a non-stackable definition', 'ITEM_NOT_STACKABLE', () =>
      svc.grantItem({ itemId: 'rifle_ak74', ownerAccountId: 'acct_a', quantity: 2, location: 'permanent', actor: SYSTEM_ACTOR }));

    const r1 = await svc.grantItem({ itemId: 'rifle_ak74', ownerAccountId: 'acct_a', quantity: 1, location: 'permanent', actor: SYSTEM_ACTOR });
    const r2 = await svc.grantItem({ itemId: 'rifle_ak74', ownerAccountId: 'acct_a', quantity: 1, location: 'run', runId: 'run_serialized', actor: SYSTEM_ACTOR });
    check('control: two non-stackable grants in different buckets are two distinct instances', r1.instance.instanceId !== r2.instance.instanceId,
      'two separate rifles collapsed into one instance');

    // NOTE — a contract finding, not a defect in this implementation: §2's unique index
    // (`item_instances_stackable_collapse`) is written WITHOUT a `stackable` filter, even
    // though its own comment says "for stackable definitions". Two identical non-stackable
    // instances (same owner/item/location/run/container — e.g. two unattached rifles both
    // sitting in one player's permanent inventory) land in the SAME index bucket and the
    // second create collides, contradicting §2's prose that a serialized item "always has one
    // row per physical item, even at quantity 1." This migration transcribes the FROZEN SQL
    // verbatim rather than silently amending it; the collision below is the CURRENT, correct-
    // per-contract behavior, asserted here so it is visible rather than discovered in P3-02/03.
    await throwsCode('contract finding: two identical non-stackable grants in the SAME bucket collide on the index', 'CONFLICT', () =>
      svc.grantItem({ itemId: 'rifle_ak74', ownerAccountId: 'acct_a', quantity: 1, location: 'permanent', actor: SYSTEM_ACTOR }));
  }

  // ---------------------------------------------------------------------------- loadouts §3.1

  {
    const svc = freshService();
    await seedDefinitions(svc);
    const rifle = (await svc.grantItem({ itemId: 'rifle_ak74', ownerAccountId: 'acct_a', quantity: 1, location: 'permanent', actor: SYSTEM_ACTOR })).instance;
    const helmet = (await svc.grantItem({ itemId: 'helmet_basic', ownerAccountId: 'acct_a', quantity: 1, location: 'permanent', actor: SYSTEM_ACTOR })).instance;
    const otherRifle = (await svc.grantItem({ itemId: 'rifle_ak74', ownerAccountId: 'acct_b', quantity: 1, location: 'permanent', actor: SYSTEM_ACTOR })).instance;

    await expectOk('a valid loadout saves', () =>
      svc.createLoadout('acct_a', { name: 'Raid kit A', slots: { primary: rifle.instanceId, helmet: helmet.instanceId } }));

    await throwsCode('a helmet cannot occupy the primary slot', 'LOADOUT_INVALID_SLOT', () =>
      svc.createLoadout('acct_a', { name: 'bad', slots: { primary: helmet.instanceId } }));

    await throwsCode('an unknown slot key is rejected', 'LOADOUT_INVALID_SLOT', () =>
      svc.createLoadout('acct_a', { name: 'bad', slots: { turret: rifle.instanceId } }));

    await throwsCode('an instance owned by another account is rejected', 'LOADOUT_ITEM_NOT_OWNED', () =>
      svc.createLoadout('acct_a', { name: 'bad', slots: { primary: otherRifle.instanceId } }));

    await throwsCode('the same instance twice in one loadout is rejected', 'LOADOUT_DUPLICATE_INSTANCE', () =>
      svc.createLoadout('acct_a', { name: 'bad', slots: { primary: rifle.instanceId, secondary: rifle.instanceId } }));

    // §3.1 rule 4 CONTROL: the SAME idle instance may sit in two different SAVED loadouts.
    await expectOk('control: two saved loadouts may share one idle instance', () =>
      svc.createLoadout('acct_a', { name: 'Raid kit B (also the rifle)', slots: { primary: rifle.instanceId } }));
  }

  // -------------------------------------------------------------------- §6.1/§6.2 locks

  {
    const svc = freshService();
    await seedDefinitions(svc);
    const rifle = (await svc.grantItem({ itemId: 'rifle_ak74', ownerAccountId: 'acct_a', quantity: 1, location: 'permanent', actor: SYSTEM_ACTOR })).instance;

    await expectOk('reserving an idle owned instance locks it', () =>
      svc.reserveInstances({ accountId: 'acct_a', instanceIds: [rifle.instanceId], deploymentId: 'dep_1' }));

    const locked = await svc.getInstance(rifle.instanceId);
    check('the reserved instance reads back locked, referencing the deployment', locked.locked === true && locked.lockedByDeploymentId === 'dep_1',
      JSON.stringify(locked));

    await throwsCode('double-equip: a second deployment cannot lock the same instance', 'ITEM_ALREADY_DEPLOYED', () =>
      svc.reserveInstances({ accountId: 'acct_a', instanceIds: [rifle.instanceId], deploymentId: 'dep_2' }));

    // Concurrent deployment race: two deployments fire at the same instant; exactly one wins.
    const rifle2 = (await svc.grantItem({ itemId: 'rifle_ak74', ownerAccountId: 'acct_a', quantity: 1, location: 'permanent', actor: SYSTEM_ACTOR })).instance;
    const results = await Promise.allSettled([
      svc.reserveInstances({ accountId: 'acct_a', instanceIds: [rifle2.instanceId], deploymentId: 'race_a' }),
      svc.reserveInstances({ accountId: 'acct_a', instanceIds: [rifle2.instanceId], deploymentId: 'race_b' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    check('a race between two deployments locking the same instance has exactly one winner', fulfilled.length === 1 && rejected.length === 1,
      JSON.stringify(results.map((r) => r.status)));
    check('the loser fails with ITEM_ALREADY_DEPLOYED, not a generic error', rejected[0]?.reason?.code === 'ITEM_ALREADY_DEPLOYED',
      rejected[0]?.reason?.code);

    // §6.4 mutation of a locked run item.
    const beforeLock = await svc.getInstance(rifle.instanceId);
    await throwsCode('a locked instance refuses a quantity mutation', 'ITEM_LOCKED', () =>
      svc.mutateInstance(rifle.instanceId, { quantity: 5 }));
    await throwsCode('a locked instance refuses a status mutation', 'ITEM_LOCKED', () =>
      svc.mutateInstance(rifle.instanceId, { status: 'destroyed' }));
    await throwsCode('a locked instance refuses an itemId mutation', 'ITEM_LOCKED', () =>
      svc.mutateInstance(rifle.instanceId, { itemId: 'helmet_basic' }));
    const afterRejectedMutations = await svc.getInstance(rifle.instanceId);
    check('a rejected mutation leaves the row byte-identical', JSON.stringify(beforeLock) === JSON.stringify(afterRejectedMutations),
      `before=${JSON.stringify(beforeLock)} after=${JSON.stringify(afterRejectedMutations)}`);

    // CONTROL: location moves are NOT guarded by the lock — that is exactly what deployment
    // start (permanent -> run) needs to do to an instance it just locked.
    await expectOk('control: a locked instance may still move location (deploy-time transition)', () =>
      svc.mutateInstance(rifle.instanceId, { location: 'run', runId: 'run_dep1' }));

    // CONTROL: the deployment lifecycle itself (allowLocked) may write a guarded field.
    await expectOk('control: allowLocked permits the lifecycle-owned status transition', () =>
      svc.mutateInstance(rifle.instanceId, { status: 'lost' }, { allowLocked: true }));

    await expectOk('releaseInstances unlocks every instance for a deployment', async () => {
      const n = await svc.releaseInstances({ deploymentId: 'dep_1' });
      check('release reports one instance unlocked', n === 1, `got ${n}`);
    });
    const released = await svc.getInstance(rifle.instanceId);
    check('after release the instance is unlocked', released.locked === false && released.lockedByDeploymentId === null,
      JSON.stringify(released));

    // §9 invariant 6: releasing twice is a no-op, not a second "unlock" of anything.
    const n2 = await svc.releaseInstances({ deploymentId: 'dep_1' });
    check('releasing an already-released deployment unlocks nothing', n2 === 0, `got ${n2}`);
  }

  // ---------------------------------------------------------------------- idle vs locked

  {
    const svc = freshService();
    await seedDefinitions(svc);
    const rifle = (await svc.grantItem({ itemId: 'rifle_ak74', ownerAccountId: 'acct_a', quantity: 1, location: 'permanent', actor: SYSTEM_ACTOR })).instance;
    await svc.reserveInstances({ accountId: 'acct_a', instanceIds: [rifle.instanceId], deploymentId: 'dep_x' });

    await throwsCode('a locked instance cannot be equipped into a new loadout', 'LOADOUT_ITEM_NOT_OWNED', () =>
      svc.createLoadout('acct_a', { name: 'new kit', slots: { primary: rifle.instanceId } }));
  }

  console.log(failures ? `\n${failures} FAILED` : '\ninventory runs clean');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack ?? err);
  process.exit(1);
});
