/**
 * P3-01 — item definitions, item instances, loadouts, and item locks.
 *
 * contracts/items-inventory.md, migration 0027. This is the module every other P3-0x module
 * (deployment reservation P3-02, run/permanent split P3-03, settlement P3-04) is meant to build
 * against — the exported shape below IS the API surface, not an implementation detail.
 *
 * ── What this module owns vs. what it hands off ─────────────────────────────────────────
 * This module owns the schema (0027), the four §6 lock invariants, and loadout validation
 * (§3.1). It exposes the primitives `reserveInstances`/`releaseInstances`/`mutateInstance` for
 * §3-02/03/04 to build the actual deployment/extract/settlement lifecycle on top of — this
 * module does not itself know what a "deployment" or a "run" IS beyond the columns §2 already
 * defines (`location`, `run_id`, `locked_by_deployment_id`). Those are P3-02/03/04's contracts.
 *
 * ── Events ───────────────────────────────────────────────────────────────────────────────
 * §6.3 specifies `item.created`'s wire shape as a provisional extension of `event-envelope.md`
 * §6 (that document is FROZEN and does not yet catalogue it). This module never writes to an
 * outbox directly — it has no `matches`/`accounts`-scoped transaction to write one inside —
 * so every instance-creating call returns the envelope-shaped event alongside the row, and an
 * `emit` dependency (typically `store.outbox.insert` from `core/store.js`, called by whatever
 * higher module wires this one to the platform's real database) is invoked with it inside the
 * SAME `store.tx` the row was created in, when the caller passes one. Passing no `emit`
 * degrades to "row created, no event" — correct for unit tests, wrong for production, and
 * deliberately visible rather than silently swallowed (see `grantItem` below).
 */
import { ApiError } from '../../core/errors.js';

/** Loadout slot keys, per items-inventory.md §2's item_definitions.slot CHECK. */
export const EQUIPPABLE_SLOTS = Object.freeze([
  'primary', 'secondary', 'melee', 'helmet', 'vest', 'backpack', 'rig', 'consumable',
]);

export const ITEM_CLASSES = Object.freeze(['weapon', 'gear', 'consumable', 'material', 'cosmetic']);
export const RARITY_TIERS = Object.freeze(['common', 'uncommon', 'rare', 'epic', 'legendary']);

function assertDefinitionShape(row) {
  if (typeof row.itemId !== 'string' || row.itemId === '') {
    throw new ApiError('VALIDATION_FAILED', 'itemId is required.');
  }
  if (!ITEM_CLASSES.includes(row.class)) {
    throw new ApiError('VALIDATION_FAILED', `Unknown item class: ${row.class}`, { details: { field: 'class' } });
  }
  if (row.slot != null && !EQUIPPABLE_SLOTS.includes(row.slot)) {
    throw new ApiError('VALIDATION_FAILED', `Unknown item slot: ${row.slot}`, { details: { field: 'slot' } });
  }
  if (!RARITY_TIERS.includes(row.rarityTier)) {
    throw new ApiError('VALIDATION_FAILED', `Unknown rarity tier: ${row.rarityTier}`, { details: { field: 'rarityTier' } });
  }
  if (row.stackable && row.maxStack != null && row.maxStack < 1) {
    throw new ApiError('VALIDATION_FAILED', 'maxStack must be >= 1 when set.', { details: { field: 'maxStack' } });
  }
}

/**
 * §6.3's `item.created` envelope. `actor` follows the closed shape the contract specifies —
 * never `{ kind: 'player' }`, because no player-initiated call creates an instance directly.
 */
function itemCreatedEvent({ instance, actor, correlationId }) {
  return {
    type: 'item.created',
    subject: { kind: 'item', id: instance.instanceId },
    actor,
    privacyClass: 'internal',
    retentionClass: 'audit',
    correlationId,
    payload: { itemId: instance.itemId, ownerAccountId: instance.ownerAccountId,
      quantity: instance.quantity, location: instance.location },
  };
}

export function createInventoryService({ store, emit = null }) {
  if (!store) throw new Error('createInventoryService: store is required');

  // ------------------------------------------------------------------------------ definitions

  async function defineItem(row) {
    assertDefinitionShape(row);
    return store.definitions.create(row);
  }

  async function getDefinition(itemId) {
    return store.definitions.byId(itemId);
  }

  async function listDefinitions() {
    return store.definitions.list();
  }

  // -------------------------------------------------------------------------------- instances

  /**
   * The only creation path (§6.3): loot spawn, purchase, craft, or admin grant. Never call
   * `store.instances.create` directly outside this function — that is what keeps "every
   * instance-creating write carries an `item.created` event" true structurally rather than by
   * convention at every call site.
   *
   * Stackable definitions collapse into the existing active/unlocked row at the same
   * (owner, item, location, run, container) key (§2) instead of creating a second one — this
   * is what §9 invariant 2 (no duplication via two rows) tests.
   */
  async function grantItem({ itemId, ownerAccountId = null, quantity = 1, location, runId = null,
    containerId = null, actor, correlationId = null }) {
    if (quantity < 1) throw new ApiError('VALIDATION_FAILED', 'quantity must be >= 1.');
    if (!actor || !actor.kind) {
      throw new ApiError('VALIDATION_FAILED', 'actor is required for item.created (§6.3).');
    }

    return store.tx(async () => {
      const def = await store.definitions.byId(itemId);
      if (!def) throw new ApiError('VALIDATION_FAILED', `Unknown item definition: ${itemId}`);

      let instance;
      if (def.stackable) {
        const existing = await store.instances.findActiveUnlocked({ ownerAccountId, itemId, location, runId, containerId });
        if (existing) {
          const nextQty = existing.quantity + quantity;
          if (def.maxStack != null && nextQty > def.maxStack) {
            throw new ApiError('VALIDATION_FAILED', `Stack exceeds maxStack (${def.maxStack}).`, {
              details: { itemId, maxStack: def.maxStack, attempted: nextQty },
            });
          }
          instance = await store.instances.mutate(existing.instanceId, { quantity: nextQty });
        } else {
          instance = await store.instances.create({ itemId, ownerAccountId, quantity, location, runId, containerId });
        }
      } else {
        if (quantity !== 1) {
          throw new ApiError('ITEM_NOT_STACKABLE', `${itemId} is not stackable; quantity must be 1.`, {
            details: { itemId, quantity },
          });
        }
        instance = await store.instances.create({ itemId, ownerAccountId, quantity: 1, location, runId, containerId });
      }

      const event = itemCreatedEvent({ instance, actor, correlationId });
      if (emit) await emit(event);
      return { instance, event };
    });
  }

  async function getInstance(instanceId) {
    return store.instances.byId(instanceId);
  }

  async function listPermanentInventory(accountId) {
    return store.instances.listForOwner(accountId, 'permanent');
  }

  async function listRunInventory(runId) {
    return store.instances.listForRun(runId);
  }

  /**
   * §6.4's guard, exposed for P3-02/03/04's lifecycle writers. Rejects a mutation of
   * `itemId`/`quantity`/`attachments`/`durability`/`status` on a locked row with `ITEM_LOCKED`
   * unless `allowLocked` is set — which only the deployment lifecycle transition itself (the
   * same call that clears the lock) should ever pass.
   */
  async function mutateInstance(instanceId, patch, { allowLocked = false } = {}) {
    return store.instances.mutate(instanceId, patch, { allowLocked });
  }

  // --------------------------------------------------------------------------------- loadouts

  /**
   * §3.1 rules 1, 2, 3, 5. Rule 4 (idle instance shared across saved loadouts) is intentionally
   * NOT enforced here — it is exactly what the contract says is legal at save time; only a
   * deployment lock (`reserveInstances`) makes it illegal, and that check lives there, not here.
   */
  async function validateLoadoutSlots(accountId, slots) {
    const entries = Object.entries(slots ?? {});
    const seen = new Set();
    for (const [slotKey, instanceId] of entries) {
      if (instanceId == null) continue;
      if (!EQUIPPABLE_SLOTS.includes(slotKey)) {
        throw new ApiError('LOADOUT_INVALID_SLOT', `${slotKey} is not an equippable slot.`, {
          details: { slot: slotKey },
        });
      }
      if (seen.has(instanceId)) {
        throw new ApiError('LOADOUT_DUPLICATE_INSTANCE', `Instance ${instanceId} used twice in one loadout.`, {
          details: { instanceId },
        });
      }
      seen.add(instanceId);

      const instance = await store.instances.byId(instanceId);
      if (!instance || instance.ownerAccountId !== accountId || instance.location !== 'permanent'
        || instance.status !== 'active' || instance.locked) {
        throw new ApiError('LOADOUT_ITEM_NOT_OWNED', `Instance ${instanceId} is not owned and idle.`, {
          details: { instanceId },
        });
      }
      const def = await store.definitions.byId(instance.itemId);
      if (!def || def.slot !== slotKey) {
        throw new ApiError('LOADOUT_INVALID_SLOT', `Instance ${instanceId} does not fit slot ${slotKey}.`, {
          details: { instanceId, slot: slotKey, definitionSlot: def?.slot ?? null },
        });
      }
      // progression-economy.md §5.2's additive amendment to rule 1: a durability=0 instance
      // cannot be placed in a loadout slot. Only reachable for definitions with a durability
      // model at all (durabilityMax non-null) — every other definition is exempt, exactly as
      // it is exempt from every other durability-shaped rule.
      if (def.durabilityMax != null && instance.durability === 0) {
        throw new ApiError('ITEM_BROKEN', `Instance ${instanceId} is broken and cannot be equipped.`, {
          details: { instanceId },
        });
      }
    }
  }

  async function createLoadout(accountId, { name, slots = {}, isDefault = false }) {
    await validateLoadoutSlots(accountId, slots);
    return store.loadouts.create({ accountId, name, slots, isDefault });
  }

  async function updateLoadout(accountId, loadoutId, patch) {
    const existing = await store.loadouts.byId(loadoutId);
    if (!existing || existing.accountId !== accountId) {
      throw new ApiError('NOT_FOUND', `Loadout ${loadoutId} not found.`);
    }
    if (patch.slots) await validateLoadoutSlots(accountId, patch.slots);
    return store.loadouts.update(loadoutId, patch);
  }

  async function listLoadouts(accountId) {
    return store.loadouts.listForAccount(accountId);
  }

  async function deleteLoadout(accountId, loadoutId) {
    const existing = await store.loadouts.byId(loadoutId);
    if (!existing || existing.accountId !== accountId) {
      throw new ApiError('NOT_FOUND', `Loadout ${loadoutId} not found.`);
    }
    return store.loadouts.delete(loadoutId);
  }

  async function setDefaultLoadout(accountId, loadoutId) {
    const existing = await store.loadouts.byId(loadoutId);
    if (!existing || existing.accountId !== accountId) {
      throw new ApiError('NOT_FOUND', `Loadout ${loadoutId} not found.`);
    }
    return store.loadouts.update(loadoutId, { isDefault: true });
  }

  // --------------------------------------------------------------------------------- locks

  /**
   * §6.2's reservation — the mechanism behind double-equip prevention (§6.1) and
   * concurrent-deployment prevention (§6.2) both. Atomic: locks every instance in
   * `instanceIds` iff all are `owner=accountId, location='permanent', status='active',
   * locked=false`, or locks none.
   */
  async function reserveInstances({ accountId, instanceIds, deploymentId }) {
    const unique = [...new Set(instanceIds)];
    if (unique.length !== instanceIds.length) {
      throw new ApiError('LOADOUT_DUPLICATE_INSTANCE', 'An instance was named twice in one reservation.');
    }
    return store.tx(async () => {
      const result = await store.instances.lockMany(unique, accountId, deploymentId);
      if (!result.locked) {
        const rows = await store.instances.byIds(result.ineligible);
        const alreadyDeployed = result.ineligible.filter((id, i) => rows[i]?.locked);
        if (alreadyDeployed.length > 0) {
          throw new ApiError('ITEM_ALREADY_DEPLOYED', 'One or more instances are already locked into another deployment.', {
            details: { instanceIds: alreadyDeployed },
          });
        }
        throw new ApiError('LOADOUT_ITEM_NOT_OWNED', 'One or more instances are not owned and idle.', {
          details: { instanceIds: result.ineligible },
        });
      }
      return { deploymentId, lockedInstanceIds: unique };
    });
  }

  /** Clears every lock held by `deploymentId`. Idempotent — a second call unlocks zero rows. */
  async function releaseInstances({ deploymentId }) {
    return store.instances.unlockMany(deploymentId);
  }

  /**
   * deployment.md §4.5 step 4 — the "run inventory seeded from the locked loadout at
   * deployment" transition. Every instance still locked to `deploymentId` moves
   * `location='run', run_id=matchId` in one statement; the lock itself is untouched (stays
   * `true` through the raid per items-inventory.md §4, cleared only at P3-04 settlement).
   * Idempotent in the sense unlockMany is: a deploymentId with no locked rows left moves zero.
   */
  async function moveLockedToRun({ deploymentId, matchId }) {
    return store.instances.moveLockedToRun(deploymentId, matchId);
  }

  /**
   * settlement.md §6 (P3-04) — the bulk extract/lose sweep for one participant's surviving run
   * inventory. `disposition` is `'permanent'` (extracted) or `'lost'` (died/aborted); settlement
   * itself decides which, per §4's matrix — this module only knows the two dispositions
   * `items-inventory.md` §4 defines, same posture `mutateInstance`'s guard already takes.
   */
  async function settleRunInstances({ runId, accountId, disposition, durabilityLossPerRun = 0 }) {
    if (disposition !== 'permanent' && disposition !== 'lost') {
      throw new ApiError('VALIDATION_FAILED', "settleRunInstances: disposition must be 'permanent' or 'lost'.");
    }
    return store.instances.settleRun({ runId, accountId, disposition, durabilityLossPerRun });
  }

  return {
    store,
    defineItem, getDefinition, listDefinitions,
    grantItem, getInstance, listPermanentInventory, listRunInventory, mutateInstance,
    validateLoadoutSlots, createLoadout, updateLoadout, listLoadouts, deleteLoadout, setDefaultLoadout,
    reserveInstances, releaseInstances, moveLockedToRun, settleRunInstances,
  };
}

export { createMemoryInventoryStore, createPostgresInventoryStore } from './store.js';
export { registerInventoryRoutes } from './routes.js';
