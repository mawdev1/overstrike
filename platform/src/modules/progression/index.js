/**
 * P4-04 — the OP ledger, repair, upgrade, and the read surface for level/XP.
 *
 * contracts/progression-economy.md, migration 0031. Composes with `items-inventory.md`'s
 * module (repair/upgrade mutate `item_instances.durability`/`attachments` through
 * `inventoryService.mutateInstance` — this module never touches that table directly) and with
 * `settlement.md`'s module (`awardForRun` is called by `settlement/index.js` per participant;
 * see that module's own note on why this is a third, independently-committing store rather
 * than literally the same transaction — the "two-store limitation" `deployment/index.js` and
 * `settlement/index.js` already document for their own pairs, extended here to a third).
 *
 * ── Compensation, not a real rollback, across the OP/item boundary ─────────────────────────
 * Repair and upgrade both debit OP first (the ledger's own idempotency and balance CHECK are
 * the authoritative gate), then mutate the item. If the item mutation loses a race against a
 * fresh deployment lock (`ITEM_LOCKED`), the OP spend already committed in a different store
 * that this module cannot roll back with the item write. `compensate()` below issues a reversing
 * `admin-adjustment` ledger entry rather than leaving the debit stranded — an approximation of
 * "the whole transaction including the OP debit" the contract's §5.3/§6.3 SQL sketches assume a
 * single store would give for free. Recorded here as a documented divergence, the same posture
 * this codebase already takes toward its other cross-store writes.
 */
import { ApiError } from '../../core/errors.js';
import {
  BASE_EXTRACT_OP, PER_OBJECTIVE_OP, SURVIVAL_TIME_OP_PER_MINUTE, MAX_SURVIVAL_OP,
  XP_PER_EXTRACT, XP_PER_OBJECTIVE, XP_SURVIVAL_PER_MINUTE, MAX_SURVIVAL_XP, LEVEL_CURVE,
  REPAIR_COST_PER_POINT, upgradeCostForTier,
} from './tuning.js';

export * from './tuning.js';

const SERVICE_ACTOR = { kind: 'service', id: 'service:progression', role: 'service' };
const playerActor = (accountId) => ({ kind: 'player', id: accountId, role: 'player' });

function currentUpgradeTier(attachments) {
  const entry = (attachments ?? []).find((a) => a?.kind === 'upgrade');
  return entry?.tier ?? 0;
}

// ── §10 event envelopes ───────────────────────────────────────────────────────────────────
// Built INSIDE the ledger write's own transaction (see store.js's `buildEvent` contract) so an
// outbox refusal rolls the OP/XP write back with it, mirroring `inventory/index.js`'s
// `itemCreatedEvent` convention.

function opEarnedEvent(entry, correlationId) {
  return {
    type: 'op.earned', subject: { kind: 'account', id: entry.accountId }, actor: SERVICE_ACTOR,
    privacyClass: 'internal', retentionClass: 'audit', correlationId: correlationId ?? entry.correlationId,
    payload: { entryId: entry.entryId, runId: entry.runId, reason: entry.reason, delta: entry.delta, balanceAfter: entry.balanceAfter },
  };
}

function opSpentEvent(entry, accountId, correlationId) {
  return {
    type: 'op.spent', subject: { kind: 'account', id: entry.accountId }, actor: playerActor(accountId),
    privacyClass: 'internal', retentionClass: 'audit', correlationId: correlationId ?? entry.correlationId,
    payload: { entryId: entry.entryId, reason: entry.reason, instanceId: entry.instanceId, delta: entry.delta, balanceAfter: entry.balanceAfter },
  };
}

function xpEarnedEvent(entry, account, { xpDelta, leveledUp }, correlationId) {
  return {
    type: 'progression.xp.earned', subject: { kind: 'account', id: entry.accountId }, actor: SERVICE_ACTOR,
    privacyClass: 'internal', retentionClass: 'standard', correlationId: correlationId ?? entry.correlationId,
    payload: { runId: entry.runId, xpDelta, level: account.level, leveledUp },
  };
}

function itemRepairedEvent(entry, accountId, { durability, opSpent }, correlationId) {
  return {
    type: 'item.repaired', subject: { kind: 'item', id: entry.instanceId }, actor: playerActor(accountId),
    privacyClass: 'internal', retentionClass: 'standard', correlationId: correlationId ?? entry.correlationId,
    payload: { instanceId: entry.instanceId, durability, opSpent },
  };
}

function itemUpgradedEvent(entry, accountId, { tier, opSpent }, correlationId) {
  return {
    type: 'item.upgraded', subject: { kind: 'item', id: entry.instanceId }, actor: playerActor(accountId),
    privacyClass: 'internal', retentionClass: 'standard', correlationId: correlationId ?? entry.correlationId,
    payload: { instanceId: entry.instanceId, tier, opSpent },
  };
}

export function createProgressionService({ store, inventoryService, emit = null }) {
  if (!store) throw new Error('createProgressionService: store is required');
  if (!inventoryService) throw new Error('createProgressionService: inventoryService is required');

  // ------------------------------------------------------------------------------------- §4

  async function getProgression(accountId, { limit = 20 } = {}) {
    const account = await store.accounts.get(accountId);
    const recent = await store.ledger.listRecentForAccount(accountId, { limit });
    return { account, recentLedger: recent };
  }

  // ------------------------------------------------------------------------------------- §3.3/§3.4

  /**
   * Called by settlement per resolved participant (never for `exception-open` and never for a
   * `void` exception resolution — settlement's own module only calls this on a real
   * extracted/died/aborted disposition). Independently idempotent per reason, per §3.2's
   * `op-award:<runId>:<accountId>:<reason>` construction — safe to call again on a retry.
   *
   * `objectiveCount` defaults to 0: P4-02's dynamic-event/objective system (the actual source
   * of a real count, per §3.3's own text) is not part of this work item, and `RunResult`'s
   * closed key set (`settlement.md` §5.1) carries no such field yet. `run-objective` therefore
   * never fires today — a documented gap, not a silent zero pretending to be a real count.
   */
  async function awardForRun({ runId, accountId, outcome, survivedSeconds = 0, objectiveCount = 0,
    correlationId }) {
    const awards = [];

    if (outcome === 'extracted') {
      awards.push({ reason: 'run-reward', op: BASE_EXTRACT_OP, xp: XP_PER_EXTRACT });
    }
    if (objectiveCount > 0) {
      awards.push({
        reason: 'run-objective', op: PER_OBJECTIVE_OP * objectiveCount, xp: XP_PER_OBJECTIVE * objectiveCount,
      });
    }
    if (outcome === 'extracted' || outcome === 'died') {
      const minutes = Math.floor(Math.max(0, survivedSeconds) / 60);
      const op = Math.min(MAX_SURVIVAL_OP, SURVIVAL_TIME_OP_PER_MINUTE * minutes);
      const xp = Math.min(MAX_SURVIVAL_XP, XP_SURVIVAL_PER_MINUTE * minutes);
      if (op > 0 || xp > 0) awards.push({ reason: 'run-survival', op, xp });
    }

    const results = [];
    for (const award of awards) {
      const current = await store.accounts.get(accountId);
      const nextXp = current.xp + award.xp;
      // eslint-disable-next-line no-await-in-loop -- three independent ledger rows, deliberately
      // sequential so one reason's idempotency replay never races another's balance read.
      const applied = await store.ledger.apply({
        accountId, delta: award.op, reason: award.reason, runId, instanceId: null,
        correlationId: correlationId || runId,
        idempotencyKey: `op-award:${runId}:${accountId}:${award.reason}`,
        xpDelta: award.xp, level: LEVEL_CURVE(nextXp),
        emit,
        buildEvent: (entry, account) => {
          const events = [opEarnedEvent(entry, correlationId || runId)];
          if (award.xp > 0) {
            events.push(xpEarnedEvent(entry, account,
              { xpDelta: award.xp, leveledUp: account.level > current.level }, correlationId || runId));
          }
          return events;
        },
      });
      results.push(applied);
    }
    return results;
  }

  // ------------------------------------------------------------------------------------- §5.3/§6.3

  /** Reverses a debit that outlived the item write it was paying for (see module header). */
  async function compensate({ accountId, instanceId, cost, reason, correlationId, idempotencyKey }) {
    await store.ledger.apply({
      accountId, delta: cost, reason: 'admin-adjustment', runId: null, instanceId,
      correlationId, idempotencyKey: `${idempotencyKey}:compensate:${reason}`, xpDelta: 0, level: null,
      emit,
      buildEvent: (entry) => opEarnedEvent(entry, correlationId),
    });
  }

  async function repairInstance({ accountId, instanceId, idempotencyKey, correlationId }) {
    const instance = await inventoryService.getInstance(instanceId);
    if (!instance || instance.ownerAccountId !== accountId || instance.location !== 'permanent'
      || instance.status !== 'active' || instance.locked) {
      throw new ApiError('ITEM_NOT_REPAIRABLE', 'Instance is not owned, idle, and repairable.', { details: { instanceId } });
    }
    const def = await inventoryService.getDefinition(instance.itemId);
    if (!def || def.durabilityMax == null || instance.durability >= def.durabilityMax) {
      throw new ApiError('ITEM_NOT_REPAIRABLE', 'Instance has no durability model, or is already at full durability.', {
        details: { instanceId },
      });
    }

    const cost = REPAIR_COST_PER_POINT * (def.durabilityMax - instance.durability);
    const ledgerKey = `op-repair:${instanceId}:${idempotencyKey}`;
    const { account } = await store.ledger.apply({
      accountId, delta: -cost, reason: 'repair', runId: null, instanceId,
      correlationId: correlationId || instanceId, idempotencyKey: ledgerKey, xpDelta: 0, level: null,
      emit,
      // Repair always restores to full — the resulting durability is known before the item
      // mutation below runs, so `item.repaired` can be built alongside `op.spent` here.
      buildEvent: (entry) => [
        opSpentEvent(entry, accountId, correlationId || instanceId),
        itemRepairedEvent(entry, accountId, { durability: def.durabilityMax, opSpent: cost }, correlationId || instanceId),
      ],
    });

    let updated;
    try {
      updated = await inventoryService.mutateInstance(instanceId, { durability: def.durabilityMax });
    } catch (err) {
      await compensate({ accountId, instanceId, cost, reason: 'repair', correlationId, idempotencyKey: ledgerKey });
      throw err;
    }

    return {
      instanceId, durability: updated.durability, durabilityMax: def.durabilityMax,
      opSpent: cost, opBalance: account.opBalance, correlationId: correlationId || instanceId,
    };
  }

  async function upgradeInstance({ accountId, instanceId, idempotencyKey, correlationId }) {
    const instance = await inventoryService.getInstance(instanceId);
    if (!instance || instance.ownerAccountId !== accountId || instance.location !== 'permanent'
      || instance.status !== 'active') {
      throw new ApiError('LOADOUT_ITEM_NOT_OWNED', 'Instance is not owned and idle.', { details: { instanceId } });
    }
    if (instance.locked) {
      throw new ApiError('ITEM_LOCKED', 'Instance is locked.', {
        details: { instanceId, lockedByDeploymentId: instance.lockedByDeploymentId },
      });
    }
    const def = await inventoryService.getDefinition(instance.itemId);
    if (def?.durabilityMax != null && instance.durability === 0) {
      throw new ApiError('ITEM_BROKEN', 'A broken instance cannot be upgraded.', { details: { instanceId } });
    }
    // migration 0031's column comment is explicit: a definition with no authored
    // `maxUpgradeTier` has no upgrade path at all — same posture `durabilityMax == null`
    // already takes for repair (ITEM_NOT_REPAIRABLE above) — rather than silently defaulting
    // to DEFAULT_MAX_UPGRADE_TIER for gear nobody authored an upgrade curve for.
    if (def?.maxUpgradeTier == null) {
      throw new ApiError('ITEM_MAX_TIER', 'Instance has no authored upgrade path.', { details: { instanceId } });
    }
    const maxTier = def.maxUpgradeTier;
    const currentTier = currentUpgradeTier(instance.attachments);
    if (currentTier >= maxTier) {
      throw new ApiError('ITEM_MAX_TIER', 'Instance is already at its maximum upgrade tier.', {
        details: { instanceId, tier: currentTier, maxUpgradeTier: maxTier },
      });
    }
    const nextTier = currentTier + 1;
    const cost = upgradeCostForTier(nextTier);
    if (cost == null) {
      throw new ApiError('ITEM_MAX_TIER', 'No upgrade cost is authored for this tier.', {
        details: { instanceId, tier: nextTier },
      });
    }

    const ledgerKey = `op-upgrade:${instanceId}:${idempotencyKey}`;
    const { account } = await store.ledger.apply({
      accountId, delta: -cost, reason: 'upgrade', runId: null, instanceId,
      correlationId: correlationId || instanceId, idempotencyKey: ledgerKey, xpDelta: 0, level: null,
      emit,
      // `nextTier` is known before the item mutation below runs, so `item.upgraded` can be
      // built alongside `op.spent` here.
      buildEvent: (entry) => [
        opSpentEvent(entry, accountId, correlationId || instanceId),
        itemUpgradedEvent(entry, accountId, { tier: nextTier, opSpent: cost }, correlationId || instanceId),
      ],
    });

    let updated;
    try {
      // §6.1/§9 invariant 9: at most one `kind:"upgrade"` element, ever — filter the prior one
      // out before appending the new tier.
      const nextAttachments = (instance.attachments ?? []).filter((a) => a?.kind !== 'upgrade');
      nextAttachments.push({ kind: 'upgrade', tier: nextTier, appliedAt: new Date().toISOString() });
      updated = await inventoryService.mutateInstance(instanceId, { attachments: nextAttachments });
    } catch (err) {
      await compensate({ accountId, instanceId, cost, reason: 'upgrade', correlationId, idempotencyKey: ledgerKey });
      throw err;
    }

    return {
      instanceId, tier: currentUpgradeTier(updated.attachments), maxUpgradeTier: maxTier,
      opSpent: cost, opBalance: account.opBalance, correlationId: correlationId || instanceId,
    };
  }

  return { getProgression, awardForRun, repairInstance, upgradeInstance };
}

export { createMemoryProgressionStore, createPostgresProgressionStore } from './store.js';
export { registerProgressionRoutes } from './routes.js';
