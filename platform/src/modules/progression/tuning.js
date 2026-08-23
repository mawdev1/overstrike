/**
 * Progression tunables.  contracts/progression-economy.md §3.3, §5.3, §6.3, §11.
 *
 * "Data, not fixed by this contract" (§11) — every export here is the P4 slice's initial
 * tuning, the same mechanism/parameter split `sector-interest.md` §8 and `bomb-rules.md` §2
 * already take for their own knobs. Centralised in one file so balance changes never require
 * touching the transactional code around them.
 */

// §3.3 — OP earned from a run.
export const BASE_EXTRACT_OP = 50;
export const PER_OBJECTIVE_OP = 15;
export const SURVIVAL_TIME_OP_PER_MINUTE = 1;
export const MAX_SURVIVAL_OP = 30;

// §3.4 — XP mirrors §3.3's three reasons one-for-one, its own tuning table (no ledger row).
export const XP_PER_EXTRACT = 100;
export const XP_PER_OBJECTIVE = 25;
export const XP_SURVIVAL_PER_MINUTE = 2;
export const MAX_SURVIVAL_XP = 60;

/** §3.4 — a monotonic, deterministic function of total XP alone. Flat 500 XP per level. */
export function LEVEL_CURVE(xp) {
  return 1 + Math.floor(Math.max(0, xp) / 500);
}

// §5.1 — flat per-run durability loss on a surviving, equipped-or-carried instance.
export const DURABILITY_LOSS_PER_RUN = 10;

// §5.3 — repair cost, linear in durability restored.
export const REPAIR_COST_PER_POINT = 1;

// §6.3 — per-tier upgrade cost. Same table for every definition in the P4 slice (a genuine
// per-definition authored table is P4-06's balance-dataset job, not this contract's); grows
// so later tiers cost more, per §6.3's own requirement.
const UPGRADE_TIER_COST = { 1: 40, 2: 80, 3: 120 };
export function upgradeCostForTier(nextTier) {
  return UPGRADE_TIER_COST[nextTier] ?? null;
}

// §6.2 — default bound when a definition authors no maxUpgradeTier of its own.
export const DEFAULT_MAX_UPGRADE_TIER = 3;
