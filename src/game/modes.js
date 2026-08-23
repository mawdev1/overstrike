import { WEAPON_LIST } from '../weapons/weaponDefs.js';
import { BombRules, BOMB_PARAMS, resolveMapManifest, compileObjectives } from './bomb.js';
import { ExtractionRules } from './extractionRules.js';
import { RUN_RULES } from './extractionContent.js';

/**
 * OVERSTRIKE has three rulesets: Team Deathmatch, Bomb, and Extraction.
 *
 * TDM proves movement, shooting, hit registration, respawns, teams, scoring, replication,
 * reconnect and persistence. Bomb (`docs/contracts/bomb-rules.md`) proves round state,
 * no-respawn play, planting and defusing, spectating and match-series logic. Extraction
 * (`docs/contracts/extraction-match.md`, the P3 vertical slice) proves loot, conditional
 * exits, the extraction channel and terminal per-participant outcomes.
 *
 * **The table's exact contents are the freeze** (bomb-rules §1, amended 1.8.0 when
 * extraction-match.md's `mode='extraction'` landed as the P3 third entry). `tdmtest.mjs`
 * and `bombtest.mjs` assert exactly these three ids, so a fourth mode — or a competitive
 * third — fails CI. The teeth stay; the count moved with the contract that moved it.
 *
 * The configured kill limit lives on Match so every TDM round can choose its own limit
 * without mutating a singleton; the Bomb series parameters are frozen in `bomb.js`, and
 * the Extraction run parameters are P3-11 data (`extractionContent.js` `RUN_RULES`).
 */

export const TEAM_COLORS = [0x4ea6ff, 0xff7a3c];
export const TEAM_NAMES = ['ALPHA', 'BRAVO'];

export const DEFAULT_KILL_LIMIT = 75;
export const MIN_KILL_LIMIT = 1;
export const MAX_KILL_LIMIT = 500;

const MINUTES = (m) => m * 60;

/** Convert menu, CLI, and API input into a safe whole-number team kill limit. */
export function normalizeKillLimit(value, fallback = DEFAULT_KILL_LIMIT) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(MIN_KILL_LIMIT, Math.min(MAX_KILL_LIMIT, Math.round(n)));
}

/** Weapon definitions used by progression registration. */
export function getWeaponDefs(game) {
  const w = game?.weapons;
  const cand = w?.list ?? w?.WEAPON_LIST ?? w?.weaponDefs ?? null;
  if (Array.isArray(cand) && cand.length) return cand;
  if (cand && typeof cand === 'object') {
    const vals = Object.values(cand);
    if (vals.length) return vals;
  }
  return WEAPON_LIST;
}

function checkTeamDeathmatchEnd(match) {
  const scores = match.scores;
  const limit = normalizeKillLimit(match.killLimit);
  if (scores[0] >= limit) {
    return { winner: 0, winnerTeam: 0, winnerEntity: null, reason: 'killLimit' };
  }
  if (scores[1] >= limit) {
    return { winner: 1, winnerTeam: 1, winnerEntity: null, reason: 'killLimit' };
  }
  if (match.timeRemaining <= 0) {
    if (scores[0] === scores[1]) {
      return { winner: -1, winnerTeam: -1, winnerEntity: null, reason: 'draw' };
    }
    const team = scores[0] > scores[1] ? 0 : 1;
    return { winner: team, winnerTeam: team, winnerEntity: null, reason: 'time' };
  }
  return null;
}

export const TDM = {
  id: 'tdm',
  name: 'TEAM DEATHMATCH',
  description: 'Two squads. First team to the configured kill limit wins.',
  teamBased: true,
  timeLimit: MINUTES(10),
  hudLabels: {
    left: TEAM_NAMES[0],
    right: TEAM_NAMES[1],
    metric: 'KILLS',
    objective: 'ELIMINATE THE ENEMY TEAM',
  },

  init() {},
  cleanup() {},
  onSpawn() {},

  onKill(match, payload) {
    const attacker = payload.attacker;
    const victim = payload.victim;
    if (!attacker || !victim) return;
    if (attacker === victim) {
      match.addTeamScore(victim.team, -1);
      return;
    }
    if (attacker.team === victim.team) {
      match.addTeamScore(attacker.team, -1);
      return;
    }
    match.addTeamScore(attacker.team, 1);
  },

  onTick() {},
  checkEnd(match) { return checkTeamDeathmatchEnd(match); },
  hudScores(match, out) {
    out[0] = match.scores[0];
    out[1] = match.scores[1];
    return out;
  },
};

// ─────────────────────────────────────────────────────────────────────────────── Bomb
//
// The rules themselves live in `bomb.js`; this object is the thin adapter between the
// referee's lifecycle and that state machine. Every hook cites the contract section.

/**
 * Can this game host Bomb? A map that publishes no objective volumes (`map-data.md` §3.3)
 * cannot, and the menu is expected to ask before offering the mode. Compiling here rather
 * than merely checking for a key means a MALFORMED manifest reports as unavailable too,
 * instead of throwing halfway through `startMatch`.
 */
export function bombAvailable(game, manifest = null) {
  try {
    compileObjectives(manifest ?? resolveMapManifest(game));
    return true;
  } catch {
    return false;
  }
}

/**
 * `match-result.md` §4.0's closed `outcomeReason` enum, split by termination reason. Stated
 * here because this file is where a series reason becomes a result field, and a value that
 * leaves the enum is refused by the platform's shared validator AND by a database `CHECK`
 * (`platform/migrations/0016`) — a rejected submission, not a cosmetic mismatch.
 */
const COMPLETED_REASONS = Object.freeze(['elimination', 'defuse', 'detonation', 'timer']);

/**
 * The §4.0 `outcomeReason` for a finished Bomb series.
 *
 * Three cases, and none of them is the raw series reason:
 *
 * - **The abort paths already name one.** `bomb.js` records `forfeit` / `no-contest`
 *   directly (bomb-rules §9), and those are enum values; they pass through.
 * - **`draw` → `timer`.** §4.0: "A draw is regulation expiring at 6-6 with no overtime in
 *   Alpha… There is no other way for a `completed` match to have no winner", and §4.2:
 *   "`winnerTeam: "draw"` requires `outcomeReason: "timer"`, and only `timer`". `draw` is
 *   not in the enum at all; the reason a drawn series ends is that regulation ran out.
 * - **`roundsToWin` → the deciding round's reason.** §4.0's `completed` rows offer exactly
 *   `elimination | defuse | detonation | timer`, and every one of them names *how the match
 *   was decided*. "Reached seven" is the series arithmetic, not a reason in that sense: the
 *   round that took the series was itself won by an elimination, a defuse, a detonation or
 *   the round clock, and that is the fact §4.0 is asking for — the same vocabulary §4.1
 *   already uses for `rounds[].reason`. Picking a constant instead (say, always
 *   `elimination`) would report a series clinched by a detonation as an elimination, which
 *   is exactly the "two truths in one row" §4.2 refuses.
 */
function seriesOutcomeReason(bomb, series) {
  if (!series) return 'timer';
  if (series.outcomeReason) return series.outcomeReason;
  if (series.reason === 'draw') return 'timer';
  // §13.6: unequal round wins after 12 rounds (draws having eaten rounds). The fact that
  // decided the series is regulation running out, and `timer` is the §4.0 reason for that.
  if (series.reason === 'roundWins') return 'timer';
  if (series.reason === 'roundsToWin') {
    const last = bomb.rounds[bomb.rounds.length - 1]?.reason;
    // Unreachable while `_endRound` is the only writer — it passes one of the four. The
    // fallback is `timer` because it is the one reason legal beside every winnerTeam.
    return COMPLETED_REASONS.includes(last) ? last : 'timer';
  }
  return COMPLETED_REASONS.includes(series.reason) ? series.reason : 'timer';
}

/**
 * The §4.0 `winnerTeam`: `alpha` | `bravo` | `draw` | `null`.
 *
 * The engine's `-1` is two different facts and the contract separates them — §4.0:
 * "`winnerTeam: null` means *no winner*, never *draw*". A drawn regulation is `draw`; a
 * no-contest (both teams gone, bomb-rules §9) is `null`, and `draw` is legal only when the
 * reason is `timer`, so the reason decides which `-1` this is.
 */
function seriesWinnerTeam(series, outcomeReason) {
  const team = series ? series.winnerTeam : -1;
  if (team === 0) return 'alpha';
  if (team === 1) return 'bravo';
  return outcomeReason === 'timer' ? 'draw' : null;
}

export const BOMB = {
  id: 'bomb',
  name: 'BOMB',
  description: 'One neutral bomb. Grab it, plant at the enemy site, defend your own. First to 7 rounds.',
  teamBased: true,
  /**
   * Bomb has no match clock — the round timer and the bomb timer are the only clocks, and
   * both live in the ruleset (§3). `hudTime` below is what the HUD reads; Match's own
   * `timeRemaining` is not consulted by `checkEnd`, so a zero here ends nothing.
   */
  timeLimit: 0,
  /**
   * §2/§8: Bomb uses FIXED protected team spawns. Without this the spawner's default is
   * 'dynamic', so Bomb was silently placing players through the TDM enemy-distance scorer —
   * the one thing the ruleset says it must not do. A protected spawn that is chosen by
   * looking at where the enemies are is not protected; it is just a different guess.
   *
   * No `fixedSpawnGroup` is declared, so the spawner uses each team's largest own-team group
   * (`alpha-main` / `bravo-main`). That matches how the map declares its groups —
   * `map-data.md` §3.2 asks for "1 protected group of >=5 adjacent points" PER TEAM, and The
   * Square supplies exactly that — so a team keeps its physical spawn across the round-6 side
   * switch and changes role, rather than teleporting to the other end of the district.
   *
   * That is only FAIR while the two mains are equidistant from the sites, and on The Square
   * today they are not: alpha-main is 18.5 m from site-B, bravo-main is 63.7 m. §3.2's own
   * table requires both sites within 15% of each other. Filed as part of REQ-CX-008; it is a
   * geometry defect, not a rules defect, and no spawn policy here can correct it.
   */
  spawnPolicy: 'fixed',
  roundsToWin: BOMB_PARAMS.roundsToWin,
  maxRounds: BOMB_PARAMS.maxRounds,
  hudLabels: {
    left: TEAM_NAMES[0],
    right: TEAM_NAMES[1],
    metric: 'ROUNDS',
    objective: 'PLANT THE BOMB — OR STOP IT',
  },

  /** Throws if the map publishes no usable objective volumes; see `bombAvailable`. */
  init(match) {
    match.bombRules = new BombRules(match, { manifest: match.mapManifest ?? null });
    for (const e of match.game.entities) {
      if (e.team === 0 || e.team === 1) match.bombRules.noteConnect(e);
    }
  },
  /**
   * Release the ruleset. Called by `Match.reset()` (the next match) and `Match.dispose()`,
   * NOT by `Match._end()`: the series ending puts the ruleset in `matchEnd` (§3), a phase
   * the match sits in, and everything §8/§9 says about that phase — full free camera, late
   * reconnects, and the phase byte `wire-protocol.md` §8.6 calls `5 = matchEnd` — is
   * answered by this object. Freeing it at the whistle published `warmup` for the finished
   * match. See the note in `Match._end()`.
   */
  cleanup(match) { if (match) match.bombRules = null; },
  onSpawn() {},

  /** §8 death in live/planted is elimination; §5 a dying carrier drops the bomb. */
  onKill(match, payload) { match.bombRules?.onKill(payload?.victim, payload?.attacker); },

  /** One fixed 1/120 s step of the round state machine (§3). */
  onTick(match) { match.bombRules?.tick(); },

  /** §2.1a the series, stated once: first to 7, MR12, 6-6 is a draw. */
  checkEnd(match) {
    const series = match.bombRules?.series;
    if (!series) return null;
    return {
      winner: series.winnerTeam,
      winnerTeam: series.winnerTeam,
      winnerEntity: null,
      reason: series.winnerTeam < 0 && series.reason === 'draw' ? 'draw' : series.reason,
    };
  },

  hudScores(match, out) {
    const wins = match.bombRules?.roundWins;
    out[0] = wins ? wins[0] : 0;
    out[1] = wins ? wins[1] : 0;
    return out;
  },

  /** §3 the bomb timer REPLACES the round timer at plant. */
  hudTime(match) { return match.bombRules?.displayTime ?? 0; },

  /** §8 no respawns once the round is live; the eliminated wait for the next freeze. */
  allowRespawn(match) { return match.bombRules ? match.bombRules.allowRespawn() : true; },

  /** §3 weapons are locked outside live/planted, and the eliminated never fire. */
  canFire(match, entity) { return match.bombRules ? match.bombRules.canFire(entity) : true; },

  /** Round-by-round evidence on the match result (§10, match-result.md §3). */
  decorateResult(match, result) {
    const bomb = match.bombRules;
    if (!bomb) return;
    const series = bomb.series;
    result.roundWins = [bomb.roundWins[0], bomb.roundWins[1]];
    result.rounds = bomb.rounds.map((r) => ({ ...r }));
    result.maxRounds = BOMB_PARAMS.maxRounds;
    result.roundsToWin = BOMB_PARAMS.roundsToWin;
    // §13.7: `attackingTeam` is gone from the record; the per-round `homeSites` in
    // `result.rounds` carries ownership, and this is the CURRENT assignment for the HUD.
    result.homeSites = { ...bomb.homeSites };
    result.winnerTeam = series ? series.winnerTeam : -1;
    // `reason` stays the raw series reason — the HUD, the round log and bombtest read it.
    // Everything below is the §4.0 projection of that same fact, and the two are kept
    // apart deliberately: `roundsToWin` is a true statement about the series and is not a
    // legal `outcomeReason`, so translating in place would lose one of them.
    result.terminationReason = series?.terminationReason ?? 'completed';
    result.outcomeReason = seriesOutcomeReason(bomb, series);
    result.winnerLabel = seriesWinnerTeam(series, result.outcomeReason);
    // §6.1: a no-contest is the ONLY Bomb outcome that records without aggregating, and
    // that follows from the outcome reason rather than from a flag anyone can forget to
    // set. Derived, not copied, so the two can never disagree.
    result.aggregate = result.outcomeReason !== 'no-contest';
    result.objectiveEvents = bomb.events.map((e) => ({ ...e }));
  },
};

// ─────────────────────────────────────────────────────────────────────────── Extraction
//
// The rules themselves live in `extraction.js` (extraction-match.md, FROZEN); the client
// runtime adapter is `extractionRules.js`, and this object is the same thin lifecycle
// shim BOMB is for `bomb.js`. Local vertical slice (P3): one local participant, the map
// entry's authoritative exits/containers, the P3-11 catalog, and the raid HUD's
// `match.raidView()` sample + `raid` bus topic.

export const EXTRACTION = {
  id: 'extraction',
  name: 'EXTRACTION',
  description: 'Deploy, loot the district, reach an exit. Death loses everything carried.',
  // Bots on a raid map are hostile POPULATION, not a second squad: they are dealt across
  // the two team ids purely so the existing combat/team plumbing treats them as valid
  // combatants. A loot-then-exit bot objective is P3-05 follow-up, not this adapter's.
  teamBased: true,
  /** §1.1 — the run's hard timeout is the only match clock (P3-11 `RUN_RULES`). */
  timeLimit: RUN_RULES.hardTimeoutSeconds,
  hudLabels: {
    left: TEAM_NAMES[0],
    right: TEAM_NAMES[1],
    metric: 'RAID',
    objective: 'LOOT — THEN GET OUT',
  },

  /** Throws if the map entry declares no extraction exits; raids name their map by id. */
  init(match) { match.extractionRules = new ExtractionRules(match); },
  /** Same deferred-teardown rule as Bomb: released by `Match.reset()`/`dispose()`. */
  cleanup(match) {
    if (!match) return;
    match.extractionRules?.dispose();
    match.extractionRules = null;
  },
  onSpawn() {},

  /** §1 — a participant death is terminal; the run records outcome and cause. */
  onKill(match, payload) { match.extractionRules?.onKill(payload?.victim, payload?.attacker); },

  /** One fixed 1/120 s step of the run (§4.1's "validated every server tick"). */
  onTick(match) { match.extractionRules?.tick(); },

  /** The run resolves the match: extracted, died, or aborted (hard timeout). */
  checkEnd(match) { return match.extractionRules ? match.extractionRules.checkEnd() : null; },

  /** A dead participant stays dead (§1); bots respawn as ongoing map population. */
  allowRespawn(match, entity) { return !entity?.isPlayer; },

  hudScores(match, out) { out[0] = 0; out[1] = 0; return out; },

  /** The §6 RunResult rides the match result; a raid has no winning team to name. */
  decorateResult(match, result) {
    const rules = match.extractionRules;
    if (!rules) return;
    result.raid = { runResult: rules.run.buildRunResult() };
    result.winnerName = '';
  },
};

// These exports are the closed public contract for Match and Menu. The exact contents are
// the freeze (bomb-rules §1, 1.8.0) — adding an entry is a contract change, not a code
// change, and the mode tests assert the table verbatim.
export const MODES = Object.freeze({ [TDM.id]: TDM, [BOMB.id]: BOMB, [EXTRACTION.id]: EXTRACTION });
export const MODE_LIST = Object.freeze([TDM, BOMB, EXTRACTION]);
export const DEFAULT_MODE = TDM.id;

for (const m of MODE_LIST) {
  Object.defineProperty(m, 'toString', {
    value() { return this.id; },
    enumerable: false,
  });
}

/** Unknown or stale mode ids always resolve to the default ruleset. */
export function getMode(id) {
  // `hasOwn`, not a plain lookup: `getMode('constructor')` must be TDM, not Object.
  return (typeof id === 'string' && Object.hasOwn(MODES, id)) ? MODES[id] : TDM;
}

/** The id `getMode` would resolve to — what settings, events and results record. */
export function normalizeModeId(id) { return getMode(id).id; }
