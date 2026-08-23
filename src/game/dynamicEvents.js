import { createRNG } from '../core/rng.js';
import { FIXED_DT } from '../core/mathUtils.js';
import { containerSeed } from './extraction.js';

/**
 * OVERSTRIKE — dynamic events, locked zones, and the AI population director.
 *
 * Implements `docs/contracts/dynamic-events.md` (contract 20, FROZEN 1.0.0). Every rule below
 * cites the section it comes from; if this file and the contract disagree, the contract wins
 * and this file is the bug — same posture `extraction.js`'s own header states for
 * `extraction-match.md`.
 *
 * This module is additive to three systems that already ship (§1 of the contract): it reads
 * `sector-interest.md`'s `populationCap`/activation state and `extractionContent.js`'s
 * `AI_PROFILES.budget` without ever raising either, it produces `world_loot_containers` rows
 * `extraction.js` already knows how to open/pick up (§5), and it schedules using the exact
 * `hash(runSeed, id)` / `mulberry32` construction `extraction.js`'s `containerSeed` already
 * pins (§6.1) — reused directly, not reimplemented.
 *
 * Two independent halves, per the contract's own split:
 *   §3/§4/§5/§6/§8   — event scheduling, lifecycle, and the container-level gate. Consumed by
 *                       `ExtractionRun` (`extraction.js`), which owns the actual container/
 *                       instance mutation — this module computes WHAT should happen and WHEN,
 *                       never mutates `item_instances`/`world_loot_containers` itself.
 *   §7                — `PopulationDirector`, a pure calculator over sector state + active
 *                       event pressure. It requests; it never spawns, evicts, or touches
 *                       `src/ai/bot.js`'s state machine (§7.1, §10 non-goals).
 */

// ─────────────────────────────────────────────────────────────────────────── §4.1 lifecycle

export const EVENT_STATE = Object.freeze({
  SCHEDULED: 'scheduled',
  ANNOUNCED: 'announced',
  ACTIVE: 'active',
  RESOLVED: 'resolved',
  EXPIRED: 'expired',
  DESPAWNED: 'despawned',
});

// ─────────────────────────────────────────────────────────────────────────────── §8 tuning

/** §8.2 — probability of an event slot rolling each rarity tier, per event type. */
const RARITY_CURVE = Object.freeze({
  cache_drop: Object.freeze([
    { id: 'r1-common', tier: 'common', weight: 0.35 },
    { id: 'r2-uncommon', tier: 'uncommon', weight: 0.30 },
    { id: 'r3-rare', tier: 'rare', weight: 0.22 },
    { id: 'r4-epic', tier: 'epic', weight: 0.11 },
    { id: 'r5-legendary', tier: 'legendary', weight: 0.02 },
  ]),
  locked_zone: Object.freeze([
    { id: 'r1-common', tier: 'common', weight: 0.05 },
    { id: 'r2-uncommon', tier: 'uncommon', weight: 0.15 },
    { id: 'r3-rare', tier: 'rare', weight: 0.35 },
    { id: 'r4-epic', tier: 'epic', weight: 0.35 },
    { id: 'r5-legendary', tier: 'legendary', weight: 0.10 },
  ]),
});

/** §8.2 — pull on AI density, deliberately NOT derived from the probability weights above. */
const RARITY_WEIGHT = Object.freeze({
  common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5,
});

/**
 * §8.3's `REWARD_VALUE_BUDGET_PER_RUN` is denominated in the same units as
 * `baseStats.salvageValue` (`extractionContent.js` §2's authored field) plus its "+40 per
 * non-salvage rare/epic/legendary" credit. This module never sees `ITEM_DEFINITIONS`
 * (`extraction.js`'s `itemDefs` projection only carries `{stackable}`), so the scheduler and
 * the resolved-event telemetry both use this authored per-tier estimate as their expected/
 * actual value proxy — a deliberate approximation documented here, not a silent one; a content
 * author retuning `REWARD_VALUE_BUDGET_PER_RUN` against real rolled economies (§12's own
 * "pending measurement" note) retunes this table alongside it.
 */
const EXPECTED_VALUE_BY_TIER = Object.freeze({
  common: 10, uncommon: 25, rare: 60, epic: 120, legendary: 220,
});

export const DYNAMIC_EVENTS_CONFIG = Object.freeze({
  MAX_CONCURRENT_EVENTS_PER_RUN: 4,
  MAX_CONCURRENT_EVENTS_PER_SECTOR: 2,
  EVENT_ANNOUNCE_LEAD_S: 20,
  CACHE_DROP_WINDOW_S: Object.freeze([180, 300]),
  LOCKED_ZONE_WINDOW_S: Object.freeze([300, 600]),
  REWARD_VALUE_BUDGET_PER_RUN: 220,
  DIRECTOR_INTERVAL_S: 5,
  DENSITY_PER_PRESSURE: 0.15, // x populationCap, per unit pressure (§8.3)
  MAX_ELITE_SHARE: 0.5,
  EVENT_POPULATION_DECAY_S: 25,
  RARITY_CURVE,
  RARITY_WEIGHT,
  EXPECTED_VALUE_BY_TIER,
});

/** §8.4 — kill switch name, `feature-flags.md` §2 vocabulary. */
export const EVENTS_DYNAMIC_ENABLED_FLAG = 'events.dynamic.enabled';

// ────────────────────────────────────────────────────────────────────────────── seeded rolls

/**
 * §8.2 — "the identical fixed-order, weighted-sampling algorithm `extraction-match.md` §3.1.1
 * already pins for loot tables ... applied to 'which rarity does this event slot roll'".
 * `rollLootTable` samples each entry independently (0..N hits); picking exactly one rarity
 * tier needs a single weighted pick instead, so this walks the SAME fixed ascending-`id`
 * order with the SAME `mulberry32` stream but accumulates a cumulative distribution and
 * returns the first entry whose cumulative weight exceeds one draw — the minimal reshaping
 * "pick one of N" requires over "sample each of N", not a new random source.
 */
export function rollEventRarity(type, seed, config = DYNAMIC_EVENTS_CONFIG) {
  const curve = config.RARITY_CURVE[type];
  if (!curve || curve.length === 0) return null;
  const entries = [...curve].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const total = entries.reduce((s, e) => s + e.weight, 0);
  const rng = createRNG(seed);
  const draw = rng() * total;
  let acc = 0;
  for (const e of entries) {
    acc += e.weight;
    if (draw < acc) return e.tier;
  }
  return entries[entries.length - 1].tier;
}

/** §8.3 — activeWindow length rolled within the type's `[min,max]` range, ticks (run-relative). */
export function rollEventWindowTicks(type, seed, config = DYNAMIC_EVENTS_CONFIG) {
  const range = type === 'cache_drop' ? config.CACHE_DROP_WINDOW_S : config.LOCKED_ZONE_WINDOW_S;
  const rng = createRNG(seed);
  const seconds = range[0] + rng() * (range[1] - range[0]);
  return Math.max(1, Math.round(seconds / FIXED_DT));
}

/** Deterministic start-offset roll, ticks, within `[0, runDurationTicks - windowTicks]`. */
function rollEventStartTicks(seed, windowTicks, runDurationTicks) {
  const span = Math.max(0, runDurationTicks - windowTicks);
  if (span === 0) return 0;
  const rng = createRNG(seed);
  return Math.round(rng() * span);
}

export function expectedValueOf(tier, config = DYNAMIC_EVENTS_CONFIG) {
  return config.EXPECTED_VALUE_BY_TIER[tier] ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────── §6.1 scheduling

/**
 * §6.1 — "computed once at `spinning-up`, deterministically, from `hash(runSeed,
 * eventSlotId)`". `candidates` is authored data (§8.1's `eventSlotId, type, sectorId,
 * anchorContainerId, poiTags?, requiresItemDefId?` — everything NOT itself a roll), processed
 * in fixed ascending-`eventSlotId` order so two runs from the same seed and candidate set
 * schedule identically regardless of authoring/array order (§11 item 6).
 *
 * Enforces §4.2's concurrency budgets (a candidate is dropped, never deferred, if admitting it
 * would push its sector or the run over `MAX_CONCURRENT_EVENTS_PER_*` for the whole span its
 * own rolled `activeWindow` covers) and §8.3's `REWARD_VALUE_BUDGET_PER_RUN` (a candidate is
 * dropped if admitting it would push the roster's summed `expectedValue` over budget) — §11
 * items 7/11's "never produces a roster whose expected value exceeds budget" is enforced HERE,
 * at schedule time, not by a later runtime check.
 *
 * @param {object} opts
 * @param {string} opts.runSeed
 * @param {Array<{eventSlotId:string,type:'cache_drop'|'locked_zone',sectorId:string,anchorContainerId:string,poiTags?:string[],requiresItemDefId?:string}>} opts.candidates
 * @param {number} opts.runDurationTicks
 * @param {object} [opts.config]
 * @returns {Array<object>} scheduled `DynamicEventDefinition` rows (§8.1), state `'scheduled'`
 */
export function scheduleDynamicEvents({ runSeed, candidates = [], runDurationTicks, config = DYNAMIC_EVENTS_CONFIG }) {
  const ordered = [...candidates].sort((a, b) => (a.eventSlotId < b.eventSlotId ? -1 : a.eventSlotId > b.eventSlotId ? 1 : 0));
  const accepted = [];
  let totalExpectedValue = 0;
  const perSectorCount = new Map();

  for (const cand of ordered) {
    const seed = containerSeed(runSeed, cand.eventSlotId);
    const rarityTier = rollEventRarity(cand.type, seed, config);
    const windowTicks = rollEventWindowTicks(cand.type, seed, config);
    const startTick = rollEventStartTicks(seed, windowTicks, runDurationTicks ?? windowTicks);
    const endTick = startTick + windowTicks;
    const expectedValue = expectedValueOf(rarityTier, config);

    // §4.2 concurrency: this candidate's own scheduled/announced/active span overlaps any
    // already-accepted event's span in the same sector / run at all (a coarse but deterministic
    // proxy for "counted while in scheduled|announced|active" — the announce lead only shifts
    // visibility, not the underlying window, so window overlap is the right test).
    const overlapping = accepted.filter((e) => e.sectorId === cand.sectorId
      && startTick <= e.activeWindow[1] && endTick >= e.activeWindow[0]);
    const sectorCount = (perSectorCount.get(cand.sectorId) ?? 0);
    if (sectorCount >= config.MAX_CONCURRENT_EVENTS_PER_SECTOR && overlapping.length > 0) continue;
    if (accepted.length >= config.MAX_CONCURRENT_EVENTS_PER_RUN) continue;
    if (totalExpectedValue + expectedValue > config.REWARD_VALUE_BUDGET_PER_RUN) continue;

    accepted.push({
      eventSlotId: cand.eventSlotId,
      type: cand.type,
      sectorId: cand.sectorId,
      anchorContainerId: cand.anchorContainerId,
      poiTags: cand.poiTags ?? [],
      rarityTier,
      lootTableId: cand.lootTableId ?? null,
      requiresItemDefId: cand.type === 'locked_zone' ? (cand.requiresItemDefId ?? null) : null,
      activeWindow: [startTick, endTick],
      expectedValue,
      state: EVENT_STATE.SCHEDULED,
    });
    totalExpectedValue += expectedValue;
    perSectorCount.set(cand.sectorId, sectorCount + 1);
  }
  return accepted;
}

// ───────────────────────────────────────────────────────────────────── §7 population director

/**
 * §7 — pure per-pass calculator. Reads `sector-interest.md`'s `populationCap`/activation state
 * and `AI_PROFILES.budget`; never mutates either, never spawns/evicts, never touches
 * `src/ai/bot.js` (§7.1, §10). A caller (raid director / `botManager.js`-adjacent glue, not
 * this module) is the one that turns a returned `target`/`eliteCount` into real spawn
 * requests against the existing sector-admit path (`SectorInterest.canAdmit`,
 * `BotManager._sectorAdmits`) — this class only ever computes the request.
 */
export class PopulationDirector {
  /** @param {object} [config] `DYNAMIC_EVENTS_CONFIG`-shaped; only the §7/§8.3 knobs are read. */
  constructor(config = DYNAMIC_EVENTS_CONFIG) {
    this.config = config;
  }

  /**
   * One director pass (§7.2), over every sector `sectorInterest` knows about.
   *
   * @param {object} opts
   * @param {import('./sectorInterest.js').SectorInterest} opts.sectorInterest
   * @param {Array<{sectorId:string, rarityTier:string}>} opts.activeEvents — events in state
   *   `'active'` (§4.1) right now, i.e. the ones counting toward §7.2's `pressure` sum.
   * @param {Map<string,number>} [opts.existingCounts] — sectorId -> live AI count, for
   *   `refusedCount` bookkeeping (§7.3). Sectors absent from the map are treated as 0.
   * @param {Map<string,number>} [opts.baselinePopulation] — sectorId -> non-event-pressured
   *   floor population (§7.2's `S.baseline`; `sector-interest.md`'s own manifest carries no
   *   such field, so a caller supplies it — e.g. a raid director's own match sizing — and 0
   *   is a safe default that lets event pressure alone drive `target`).
   * @param {Array<{profileId:string, budget:{maxActivePerSector:number}}>} [opts.aiProfiles]
   *   — `AI_PROFILES`-shaped; only `sentinel-elite`'s `budget.maxActivePerSector` is read (§7.2).
   * @returns {Array<{sectorId:string, pressure:number, target:number, eliteShare:number,
   *   eliteCount:number, admittedDelta:number, refusedCount:number}>}
   */
  pass({ sectorInterest, activeEvents = [], existingCounts = new Map(), baselinePopulation = new Map(), aiProfiles = [] }) {
    const cfg = this.config;
    const eliteProfile = aiProfiles.find((p) => p.profileId === 'sentinel-elite');
    const eliteCap = eliteProfile?.budget?.maxActivePerSector ?? Infinity;
    const out = [];

    for (const sector of sectorInterest.sectors) {
      const id = sector.id;
      const state = sectorInterest.stateOf(id);
      // §7.2 — "if dormant: skip — no population decision to make for AI that isn't
      // thinking anyway".
      if (state === 'dormant') continue;

      const cap = Number.isFinite(sector.populationCap) ? sector.populationCap : Infinity;
      const pressure = activeEvents
        .filter((e) => e.sectorId === id)
        .reduce((s, e) => s + (cfg.RARITY_WEIGHT[e.rarityTier] ?? 0), 0);

      const baseline = baselinePopulation.get(id) ?? 0;
      const rawTarget = baseline + pressure * cfg.DENSITY_PER_PRESSURE * (Number.isFinite(cap) ? cap : 0);
      const target = clamp(rawTarget, 0, cap);

      // §7.3 — "warming sectors get zero elite bias"; only `active` ever applies eliteShare.
      const eliteShare = state === 'active'
        ? clamp(pressure / Math.max(1, Number.isFinite(cap) ? cap : 1), 0, cfg.MAX_ELITE_SHARE)
        : 0;
      const eliteCount = Math.min(Math.round(target * eliteShare), eliteCap);

      const existing = existingCounts.get(id) ?? 0;
      const requestedDelta = target - existing;
      // §7.3 — "refused, not queued"; §4.3's own overflow rule, applied here as a direct
      // clamp against the sector's cap rather than a retried/queued request.
      let admittedDelta = 0;
      let refusedCount = 0;
      if (requestedDelta > 0 && Number.isFinite(cap)) {
        const room = Math.max(0, cap - existing);
        admittedDelta = Math.min(requestedDelta, room);
        refusedCount = Math.max(0, requestedDelta - admittedDelta);
      } else if (requestedDelta > 0) {
        admittedDelta = requestedDelta;
      }
      // §7.3 — "no eviction": a negative requestedDelta (pressure decayed) requests nothing;
      // existing population only falls through ordinary attrition, never a forced despawn.

      out.push({ sectorId: id, pressure, target, eliteShare, eliteCount, admittedDelta, refusedCount });
    }
    return out;
  }
}

function clamp(v, lo, hi) {
  return Math.min(Math.max(v, lo), hi);
}
