/**
 * Inventory storage.  contracts/items-inventory.md §2, §3.
 *
 * Scoped to this module's three tables (item_definitions, item_instances, loadouts) rather
 * than folded into `core/store.js`'s Store interface — P3-01 is a self-contained slice with
 * its own migration (0027) and its own lock mechanism (§6), and every other P3-0x module talks
 * to it through `../inventory/index.js`, never through these adapters directly. Same two-adapter
 * split as `core/store`: `memory` for tests, `postgres` for real, one interface for both.
 *
 * `tx(fn)` follows `core/store.js`'s rule 1: a real transaction, because §6.2's lock and §6.3's
 * duplication guarantee are both "this write happens exactly once, atomically" claims that an
 * adapter faking transactions would silently break.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError } from '../../core/errors.js';
import { ulid as defaultUlid } from '../../core/ids.js';

const clone = (v) => (v === null || v === undefined ? null : structuredClone(v));
const key = (...parts) => parts.join('');

// ---------------------------------------------------------------------------------- memory

const TX = Symbol('overstrike.inventory.memtx');
const handleState = new WeakMap();
const txContext = new AsyncLocalStorage();

function emptyState() {
  return {
    definitions: new Map(),
    instances: new Map(),
    loadouts: new Map(),
  };
}

/** Reject a write that would put two active, unlocked rows behind one stackable collapse key. */
function stackableCollapseKey(row) {
  return key(row.ownerAccountId ?? '', row.itemId, row.location, row.runId ?? '', row.containerId ?? '');
}

function assertStackableCollapseFree(state, row, excludeInstanceId) {
  if (row.status !== 'active' || row.locked) return;
  const k = stackableCollapseKey(row);
  for (const other of state.instances.values()) {
    if (other.instanceId === excludeInstanceId) continue;
    if (other.status !== 'active' || other.locked) continue;
    if (stackableCollapseKey(other) === k) {
      throw new ApiError('CONFLICT', 'Two active, unlocked instances collapse to the same stackable slot.', {
        details: { table: 'item_instances', key: k },
      });
    }
  }
}

export function createMemoryInventoryStore(deps = {}) {
  const ulid = deps.ulid ?? defaultUlid;
  let live = emptyState();
  let queue = Promise.resolve();

  function currentState() {
    const enrolled = txContext.getStore();
    if (enrolled) return handleState.get(enrolled);
    return live;
  }

  async function tx(fn) {
    const enrolled = txContext.getStore();
    if (enrolled) return fn(enrolled); // reentrant: join the outer transaction

    const run = async () => {
      const draft = structuredClone(live);
      const handle = { [TX]: true };
      handleState.set(handle, draft);
      try {
        const result = await txContext.run(handle, () => fn(handle));
        live = draft;
        return result;
      } finally {
        handleState.delete(handle);
      }
    };

    // The queue itself must never become a rejected promise: `queue.then` on a rejected
    // promise skips every subsequent `run` forever, so one failed transaction would silently
    // stop the store from ever committing another. The queue therefore chains on a settled
    // marker (`.then(() => {}, () => {})`) while the CALLER still sees `run`'s own outcome —
    // a rollback for THIS transaction, not a wedge for every transaction after it.
    const settled = queue.then(run, run);
    queue = settled.then(() => {}, () => {});
    return settled;
  }

  const definitions = {
    async create(row) {
      const state = currentState();
      if (state.definitions.has(row.itemId)) {
        throw new ApiError('CONFLICT', `Item definition ${row.itemId} already exists.`);
      }
      const now = new Date().toISOString();
      const stored = {
        itemId: row.itemId, class: row.class, slot: row.slot ?? null,
        rarityTier: row.rarityTier, stackable: !!row.stackable, maxStack: row.maxStack ?? null,
        baseStats: clone(row.baseStats ?? {}), durabilityMax: row.durabilityMax ?? null,
        maxUpgradeTier: row.maxUpgradeTier ?? null,
        tradable: !!row.tradable, contentVersion: row.contentVersion ?? 1,
        createdAt: now, updatedAt: now,
      };
      state.definitions.set(row.itemId, stored);
      return clone(stored);
    },
    async byId(itemId) {
      const row = currentState().definitions.get(itemId);
      return row ? clone(row) : null;
    },
    async list() {
      return [...currentState().definitions.values()].map(clone);
    },
  };

  const instances = {
    async create(row) {
      const state = currentState();
      if (!state.definitions.has(row.itemId)) {
        throw new ApiError('VALIDATION_FAILED', `Unknown item definition: ${row.itemId}`);
      }
      const instanceId = row.instanceId ?? ulid();
      if (state.instances.has(instanceId)) {
        throw new ApiError('CONFLICT', `Instance ${instanceId} already exists.`);
      }
      const now = new Date().toISOString();
      const stored = {
        instanceId, itemId: row.itemId,
        ownerAccountId: row.ownerAccountId ?? null,
        quantity: row.quantity ?? 1,
        durability: row.durability ?? null,
        attachments: clone(row.attachments ?? []),
        location: row.location,
        runId: row.runId ?? null,
        containerId: row.containerId ?? null,
        locked: false,
        lockedByDeploymentId: null,
        status: row.status ?? 'active',
        createdAt: now, updatedAt: now,
      };
      if (stored.quantity < 1) throw new ApiError('VALIDATION_FAILED', 'quantity must be >= 1.');
      assertStackableCollapseFree(state, stored, null);
      state.instances.set(instanceId, stored);
      return clone(stored);
    },
    async byId(instanceId) {
      const row = currentState().instances.get(instanceId);
      return row ? clone(row) : null;
    },
    async byIds(instanceIds) {
      const state = currentState();
      return instanceIds.map((id) => { const r = state.instances.get(id); return r ? clone(r) : null; });
    },
    async listForOwner(ownerAccountId, location) {
      const out = [];
      for (const row of currentState().instances.values()) {
        if (row.ownerAccountId === ownerAccountId && row.location === location && row.status === 'active') {
          out.push(clone(row));
        }
      }
      return out;
    },
    async listForRun(runId) {
      const out = [];
      for (const row of currentState().instances.values()) {
        if (row.runId === runId && row.location === 'run') out.push(clone(row));
      }
      return out;
    },

    /** The one row (if any) a stackable pickup would collapse into (§2's unique index key). */
    async findActiveUnlocked({ ownerAccountId, itemId, location, runId, containerId }) {
      const k = key(ownerAccountId ?? '', itemId, location, runId ?? '', containerId ?? '');
      for (const row of currentState().instances.values()) {
        if (row.status !== 'active' || row.locked) continue;
        if (stackableCollapseKey(row) === k) return clone(row);
      }
      return null;
    },

    /**
     * §6.2's atomic reservation. Locks every row in `instanceIds` iff ALL are currently
     * `owner=accountId, location='permanent', status='active', locked=false`. A partial match
     * locks nothing and reports which ids were not eligible, so the caller's "rowcount must
     * equal length(instanceIds) or the whole thing rolls back" reads directly off the result
     * instead of trusting a side effect.
     */
    async lockMany(instanceIds, accountId, deploymentId) {
      const state = currentState();
      const rows = instanceIds.map((id) => state.instances.get(id));
      const ineligible = [];
      rows.forEach((row, i) => {
        if (!row || row.ownerAccountId !== accountId || row.location !== 'permanent'
          || row.status !== 'active' || row.locked) {
          ineligible.push(instanceIds[i]);
        }
      });
      if (ineligible.length > 0) {
        return { locked: false, lockedCount: 0, ineligible };
      }
      const now = new Date().toISOString();
      for (const row of rows) {
        row.locked = true;
        row.lockedByDeploymentId = deploymentId;
        row.updatedAt = now;
      }
      return { locked: true, lockedCount: rows.length, ineligible: [] };
    },

    /**
     * deployment.md §4.5 step 4's bulk seed: every instance still locked to `deploymentId`
     * moves `location='run', run_id=matchId` in one statement, mirroring `unlockMany`'s shape.
     * `location`/`run_id` are exempt from §6.4's lock guard (that guard covers identity/content
     * fields only), so this never needs `allowLocked` — the lock stays true the whole time, per
     * items-inventory.md §4 ("locked stays true through the raid, cleared only at settlement").
     */
    async moveLockedToRun(deploymentId, matchId) {
      const state = currentState();
      const now = new Date().toISOString();
      const moved = [];
      for (const row of state.instances.values()) {
        if (row.lockedByDeploymentId === deploymentId) {
          row.location = 'run';
          row.runId = matchId;
          row.updatedAt = now;
          moved.push(clone(row));
        }
      }
      return moved;
    },

    /**
     * settlement.md §6's bulk disposition sweep. Every surviving (`location='run',
     * status='active'`) row for this (runId, accountId) moves to its terminal state in one pass
     * — `'permanent'` (extracted: `location='permanent', run_id=null`) or `'lost'` (died/aborted:
     * `status='lost'`) — with the lock cleared in the SAME write, per `deployment.md` §5.4's
     * "settlement releases it, in that same transaction." Naturally idempotent at the row level
     * (§6's own text): a retry's WHERE clause matches zero rows once a row has already moved.
     */
    async settleRun({ runId, accountId, disposition, durabilityLossPerRun = 0 }) {
      const state = currentState();
      const now = new Date().toISOString();
      const settled = [];
      for (const row of state.instances.values()) {
        if (row.runId !== runId || row.ownerAccountId !== accountId) continue;
        if (row.location !== 'run' || row.status !== 'active') continue;
        if (disposition === 'permanent') {
          row.location = 'permanent'; row.runId = null;
          // progression-economy.md §5.1 — depletion happens exactly here, the same UPDATE
          // that converts the row to 'permanent', for every surviving row with a durability
          // model (durability is null for anything without one, per items-inventory.md §2).
          if (row.durability !== null && durabilityLossPerRun > 0) {
            row.durability = Math.max(0, row.durability - durabilityLossPerRun);
          }
        } else { row.status = 'lost'; }
        row.locked = false;
        row.lockedByDeploymentId = null;
        row.updatedAt = now;
        settled.push(clone(row));
      }
      return settled;
    },

    /** Clears the lock on every instance of `deploymentId`. Never rejected by §6.4 — this IS the unlock transition. */
    async unlockMany(deploymentId) {
      const state = currentState();
      const now = new Date().toISOString();
      let count = 0;
      for (const row of state.instances.values()) {
        if (row.lockedByDeploymentId === deploymentId) {
          row.locked = false;
          row.lockedByDeploymentId = null;
          row.updatedAt = now;
          count++;
        }
      }
      return count;
    },

    /**
     * §6.4: reject a write to identity/content fields (`itemId`, `quantity`, `attachments`,
     * `durability`, `status`) while `locked = true`, UNLESS `allowLocked` is set by a caller
     * that IS the deployment lifecycle transition itself (extract/death/abort clearing the
     * lock in the same call). `location`/`runId`/`containerId`/`ownerAccountId` are exempt —
     * those are exactly what moves a locked instance permanent<->run at deploy/extract time.
     */
    async mutate(instanceId, patch, { allowLocked = false } = {}) {
      const state = currentState();
      const row = state.instances.get(instanceId);
      if (!row) throw new ApiError('NOT_FOUND', `Instance ${instanceId} not found.`);
      const guarded = ['itemId', 'quantity', 'attachments', 'durability', 'status'];
      const touchesGuarded = guarded.some((f) => Object.prototype.hasOwnProperty.call(patch, f));
      if (row.locked && touchesGuarded && !allowLocked) {
        throw new ApiError('ITEM_LOCKED', `Instance ${instanceId} is locked.`, {
          details: { instanceId, lockedByDeploymentId: row.lockedByDeploymentId },
        });
      }
      const next = { ...row, ...patch, updatedAt: new Date().toISOString() };
      if (next.quantity < 1) throw new ApiError('VALIDATION_FAILED', 'quantity must be >= 1.');
      assertStackableCollapseFree(state, next, instanceId);
      state.instances.set(instanceId, next);
      return clone(next);
    },
  };

  const loadouts = {
    async create(row) {
      const state = currentState();
      const loadoutId = row.loadoutId ?? ulid();
      const now = new Date().toISOString();
      if (row.isDefault) {
        for (const other of state.loadouts.values()) {
          if (other.accountId === row.accountId) other.isDefault = false;
        }
      }
      const stored = {
        loadoutId, accountId: row.accountId, name: row.name, slots: clone(row.slots ?? {}),
        isDefault: !!row.isDefault, createdAt: now, updatedAt: now,
      };
      state.loadouts.set(loadoutId, stored);
      return clone(stored);
    },
    async byId(loadoutId) {
      const row = currentState().loadouts.get(loadoutId);
      return row ? clone(row) : null;
    },
    async listForAccount(accountId) {
      const out = [];
      for (const row of currentState().loadouts.values()) {
        if (row.accountId === accountId) out.push(clone(row));
      }
      return out;
    },
    async update(loadoutId, patch) {
      const state = currentState();
      const row = state.loadouts.get(loadoutId);
      if (!row) throw new ApiError('NOT_FOUND', `Loadout ${loadoutId} not found.`);
      if (patch.isDefault === true) {
        for (const other of state.loadouts.values()) {
          if (other.accountId === row.accountId && other.loadoutId !== loadoutId) other.isDefault = false;
        }
      }
      const next = { ...row, ...patch, updatedAt: new Date().toISOString() };
      state.loadouts.set(loadoutId, next);
      return clone(next);
    },
    async delete(loadoutId) {
      const state = currentState();
      return state.loadouts.delete(loadoutId);
    },
  };

  return {
    driver: 'memory',
    tx,
    definitions, instances, loadouts,
    async close() {},
  };
}

// -------------------------------------------------------------------------------- postgres

const toIso = (v) => (v instanceof Date ? v.toISOString() : v);

function rowToDefinition(r) {
  if (!r) return null;
  return {
    itemId: r.item_id, class: r.class, slot: r.slot, rarityTier: r.rarity_tier,
    stackable: r.stackable, maxStack: r.max_stack, baseStats: r.base_stats,
    durabilityMax: r.durability_max, maxUpgradeTier: r.max_upgrade_tier,
    tradable: r.tradable, contentVersion: r.content_version,
    createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at),
  };
}

function rowToInstance(r) {
  if (!r) return null;
  return {
    instanceId: r.instance_id, itemId: r.item_id, ownerAccountId: r.owner_account_id,
    quantity: r.quantity, durability: r.durability, attachments: r.attachments,
    location: r.location, runId: r.run_id, containerId: r.container_id,
    locked: r.locked, lockedByDeploymentId: r.locked_by_deployment_id, status: r.status,
    createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at),
  };
}

function rowToLoadout(r) {
  if (!r) return null;
  return {
    loadoutId: r.loadout_id, accountId: r.account_id, name: r.name, slots: r.slots,
    isDefault: r.is_default, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at),
  };
}

export function createPostgresInventoryStore(config = {}, deps = {}) {
  // Lazily required so `pg` (an optionalDependency) is never imported by callers that only
  // ever run the memory adapter — same pattern as core/store/postgres.js's own caller.
  const { Pool } = deps.pg ?? requirePg();
  const ulid = deps.ulid ?? defaultUlid;
  const pool = new Pool(config.pool ?? config);
  const pgTxContext = new AsyncLocalStorage();

  function requirePg() {
    // eslint-disable-next-line global-require
    return require('pg');
  }

  async function tx(fn) {
    const enrolled = pgTxContext.getStore();
    if (enrolled) return fn(enrolled);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await pgTxContext.run(client, () => fn(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  function runner(passed) {
    return passed ?? pgTxContext.getStore() ?? pool;
  }

  const definitions = {
    async create(row, t) {
      const q = runner(t);
      try {
        const { rows } = await q.query(
          `insert into item_definitions
             (item_id, class, slot, rarity_tier, stackable, max_stack, base_stats,
              durability_max, max_upgrade_tier, tradable, content_version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
          [row.itemId, row.class, row.slot ?? null, row.rarityTier, !!row.stackable,
            row.maxStack ?? null, JSON.stringify(row.baseStats ?? {}), row.durabilityMax ?? null,
            row.maxUpgradeTier ?? null, !!row.tradable, row.contentVersion ?? 1],
        );
        return rowToDefinition(rows[0]);
      } catch (err) {
        if (err.code === '23505') throw new ApiError('CONFLICT', `Item definition ${row.itemId} already exists.`);
        throw err;
      }
    },
    async byId(itemId, t) {
      const { rows } = await runner(t).query('select * from item_definitions where item_id = $1', [itemId]);
      return rowToDefinition(rows[0]);
    },
    async list(t) {
      const { rows } = await runner(t).query('select * from item_definitions order by item_id');
      return rows.map(rowToDefinition);
    },
  };

  const instances = {
    async create(row, t) {
      const q = runner(t);
      const instanceId = row.instanceId ?? ulid();
      try {
        const { rows } = await q.query(
          `insert into item_instances
             (instance_id, item_id, owner_account_id, quantity, durability, attachments,
              location, run_id, container_id, status)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
          [instanceId, row.itemId, row.ownerAccountId ?? null, row.quantity ?? 1,
            row.durability ?? null, JSON.stringify(row.attachments ?? []), row.location,
            row.runId ?? null, row.containerId ?? null, row.status ?? 'active'],
        );
        return rowToInstance(rows[0]);
      } catch (err) {
        if (err.code === '23505') {
          throw new ApiError('CONFLICT', 'Two active, unlocked instances collapse to the same stackable slot.');
        }
        if (err.code === '23503' || err.code === '23514') {
          throw new ApiError('VALIDATION_FAILED', 'Instance violates a schema constraint.', {
            details: { reason: err.message },
          });
        }
        throw err;
      }
    },
    async byId(instanceId, t) {
      const { rows } = await runner(t).query('select * from item_instances where instance_id = $1', [instanceId]);
      return rowToInstance(rows[0]);
    },
    async byIds(instanceIds, t) {
      if (instanceIds.length === 0) return [];
      const { rows } = await runner(t).query(
        'select * from item_instances where instance_id = any($1)', [instanceIds]);
      const byId = new Map(rows.map((r) => [r.instance_id, rowToInstance(r)]));
      return instanceIds.map((id) => byId.get(id) ?? null);
    },
    async listForOwner(ownerAccountId, location, t) {
      const { rows } = await runner(t).query(
        `select * from item_instances
          where owner_account_id = $1 and location = $2 and status = 'active'
          order by created_at`,
        [ownerAccountId, location],
      );
      return rows.map(rowToInstance);
    },
    async listForRun(runId, t) {
      const { rows } = await runner(t).query(
        `select * from item_instances where run_id = $1 and location = 'run' order by created_at`,
        [runId],
      );
      return rows.map(rowToInstance);
    },
    async findActiveUnlocked({ ownerAccountId, itemId, location, runId, containerId }, t) {
      const { rows } = await runner(t).query(
        `select * from item_instances
          where coalesce(owner_account_id, '') = coalesce($1, '')
            and item_id = $2 and location = $3
            and coalesce(run_id, '') = coalesce($4, '')
            and coalesce(container_id, '') = coalesce($5, '')
            and status = 'active' and locked = false
          limit 1`,
        [ownerAccountId ?? null, itemId, location, runId ?? null, containerId ?? null],
      );
      return rowToInstance(rows[0]);
    },
    async lockMany(instanceIds, accountId, deploymentId, t) {
      const q = runner(t);
      const { rows } = await q.query(
        `update item_instances
            set locked = true, locked_by_deployment_id = $1, updated_at = now()
          where instance_id = any($2)
            and owner_account_id = $3
            and location = 'permanent'
            and status = 'active'
            and locked = false
          returning instance_id`,
        [deploymentId, instanceIds, accountId],
      );
      const lockedIds = new Set(rows.map((r) => r.instance_id));
      const ineligible = instanceIds.filter((id) => !lockedIds.has(id));
      if (ineligible.length > 0) {
        // Partial locks are not a valid state (contract §6.2) — roll every lock this call
        // just took back off before returning.
        if (lockedIds.size > 0) {
          await q.query(
            `update item_instances set locked = false, locked_by_deployment_id = null, updated_at = now()
              where instance_id = any($1) and locked_by_deployment_id = $2`,
            [[...lockedIds], deploymentId],
          );
        }
        return { locked: false, lockedCount: 0, ineligible };
      }
      return { locked: true, lockedCount: rows.length, ineligible: [] };
    },
    async unlockMany(deploymentId, t) {
      const { rowCount } = await runner(t).query(
        `update item_instances set locked = false, locked_by_deployment_id = null, updated_at = now()
          where locked_by_deployment_id = $1`,
        [deploymentId],
      );
      return rowCount;
    },

    /** settlement.md §6 — see the memory adapter's identical note. */
    async settleRun({ runId, accountId, disposition, durabilityLossPerRun = 0 }, t) {
      // progression-economy.md §5.1: depletion rides in the SAME UPDATE that converts a
      // surviving row to 'permanent' — one write, not two competing writers on one row.
      // `durability` stays null for anything without a durability model (the `is not null`
      // guard), and GREATEST(0, …) matches §5.2's "durability never goes negative."
      const params = [runId, accountId];
      let durabilityClause = '';
      if (disposition === 'permanent' && durabilityLossPerRun > 0) {
        params.push(Number(durabilityLossPerRun));
        durabilityClause = `, durability = case when durability is not null
                              then greatest(0, durability - $${params.length}) else durability end`;
      }
      const setClause = disposition === 'permanent'
        ? `location = 'permanent', run_id = null${durabilityClause}`
        : "status = 'lost'";
      const { rows } = await runner(t).query(
        `update item_instances set ${setClause}, locked = false, locked_by_deployment_id = null, updated_at = now()
          where run_id = $1 and owner_account_id = $2 and location = 'run' and status = 'active'
          returning *`,
        params,
      );
      return rows.map(rowToInstance);
    },
    async moveLockedToRun(deploymentId, matchId, t) {
      const { rows } = await runner(t).query(
        `update item_instances set location = 'run', run_id = $2, updated_at = now()
          where locked_by_deployment_id = $1
          returning *`,
        [deploymentId, matchId],
      );
      return rows.map(rowToInstance);
    },
    async mutate(instanceId, patch, opts = {}) {
      const t = opts.tx;
      const allowLocked = !!opts.allowLocked;
      const q = runner(t);
      const guarded = ['itemId', 'quantity', 'attachments', 'durability', 'status'];
      const touchesGuarded = guarded.some((f) => Object.prototype.hasOwnProperty.call(patch, f));
      const cols = [];
      const vals = [];
      let i = 1;
      const colFor = { itemId: 'item_id', ownerAccountId: 'owner_account_id', quantity: 'quantity',
        durability: 'durability', attachments: 'attachments', location: 'location', runId: 'run_id',
        containerId: 'container_id', status: 'status' };
      for (const [k, v] of Object.entries(patch)) {
        const col = colFor[k];
        if (!col) continue;
        cols.push(`${col} = $${i}`);
        vals.push(k === 'attachments' ? JSON.stringify(v) : v);
        i++;
      }
      cols.push('updated_at = now()');
      const guardClause = touchesGuarded && !allowLocked ? ' and locked = false' : '';
      const { rows } = await q.query(
        `update item_instances set ${cols.join(', ')}
          where instance_id = $${i}${guardClause}
          returning *`,
        [...vals, instanceId],
      );
      if (rows.length === 0) {
        const existing = await instances.byId(instanceId, t);
        if (!existing) throw new ApiError('NOT_FOUND', `Instance ${instanceId} not found.`);
        throw new ApiError('ITEM_LOCKED', `Instance ${instanceId} is locked.`, {
          details: { instanceId, lockedByDeploymentId: existing.lockedByDeploymentId },
        });
      }
      return rowToInstance(rows[0]);
    },
  };

  const loadouts = {
    async create(row, t) {
      const q = runner(t);
      const loadoutId = row.loadoutId ?? ulid();
      if (row.isDefault) {
        await q.query('update loadouts set is_default = false, updated_at = now() where account_id = $1', [row.accountId]);
      }
      const { rows } = await q.query(
        `insert into loadouts (loadout_id, account_id, name, slots, is_default)
         values ($1,$2,$3,$4,$5) returning *`,
        [loadoutId, row.accountId, row.name, JSON.stringify(row.slots ?? {}), !!row.isDefault],
      );
      return rowToLoadout(rows[0]);
    },
    async byId(loadoutId, t) {
      const { rows } = await runner(t).query('select * from loadouts where loadout_id = $1', [loadoutId]);
      return rowToLoadout(rows[0]);
    },
    async listForAccount(accountId, t) {
      const { rows } = await runner(t).query(
        'select * from loadouts where account_id = $1 order by created_at', [accountId]);
      return rows.map(rowToLoadout);
    },
    async update(loadoutId, patch, t) {
      const q = runner(t);
      const existing = await loadouts.byId(loadoutId, t);
      if (!existing) throw new ApiError('NOT_FOUND', `Loadout ${loadoutId} not found.`);
      if (patch.isDefault === true) {
        await q.query(
          'update loadouts set is_default = false, updated_at = now() where account_id = $1 and loadout_id <> $2',
          [existing.accountId, loadoutId],
        );
      }
      const cols = [];
      const vals = [];
      let i = 1;
      const colFor = { name: 'name', slots: 'slots', isDefault: 'is_default' };
      for (const [k, v] of Object.entries(patch)) {
        const col = colFor[k];
        if (!col) continue;
        cols.push(`${col} = $${i}`);
        vals.push(k === 'slots' ? JSON.stringify(v) : v);
        i++;
      }
      cols.push('updated_at = now()');
      const { rows } = await q.query(
        `update loadouts set ${cols.join(', ')} where loadout_id = $${i} returning *`,
        [...vals, loadoutId],
      );
      return rowToLoadout(rows[0]);
    },
    async delete(loadoutId, t) {
      const { rowCount } = await runner(t).query('delete from loadouts where loadout_id = $1', [loadoutId]);
      return rowCount > 0;
    },
  };

  return {
    driver: 'postgres',
    tx,
    definitions, instances, loadouts,
    async close() { await pool.end(); },
  };
}
