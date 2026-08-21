import { WEAPON_LIST } from '../weapons/weaponDefs.js';
import { BombRules, BOMB_PARAMS, resolveMapManifest, compileObjectives } from './bomb.js';

/**
 * OVERSTRIKE has two rulesets: Team Deathmatch and Bomb.
 *
 * TDM proves movement, shooting, hit registration, respawns, teams, scoring, replication,
 * reconnect and persistence. Bomb (`docs/contracts/bomb-rules.md`) proves round state,
 * no-respawn play, planting and defusing, spectating and match-series logic.
 *
 * **Two entries is the freeze** (bomb-rules §1). `tdmtest.mjs` and `bombtest.mjs` assert
 * this table's exact contents, so a third mode fails CI. That is deliberate: the mode
 * freeze needs teeth, not goodwill.
 *
 * The configured kill limit lives on Match so every TDM round can choose its own limit
 * without mutating a singleton; the Bomb series parameters are frozen in `bomb.js`.
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

export const BOMB = {
  id: 'bomb',
  name: 'BOMB',
  description: 'Attackers plant, defenders defuse. No respawns. First to 7 rounds.',
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
    result.attackingTeam = bomb.attackingTeam;
    result.winnerTeam = series ? series.winnerTeam : -1;
    result.winnerLabel = series ? series.winnerLabel : 'draw';
    result.outcomeReason = series?.outcomeReason ?? series?.reason ?? null;
    result.terminationReason = series?.terminationReason ?? 'completed';
    result.aggregate = series?.aggregate ?? true;
    result.objectiveEvents = bomb.events.map((e) => ({ ...e }));
  },
};

// These exports are the two-entry public contract for Match and Menu. Two is the freeze
// (bomb-rules §1) — adding a third entry is a contract change, not a code change.
export const MODES = Object.freeze({ [TDM.id]: TDM, [BOMB.id]: BOMB });
export const MODE_LIST = Object.freeze([TDM, BOMB]);
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
