/**
 * OVERSTRIKE — persistent player progression.
 *
 * Everything lives in one localStorage blob (`overstrike.progress.v1`). The store is
 * treated as hostile input: any missing, mistyped or out-of-range field is coerced back
 * onto the defaults rather than throwing, so a corrupt save degrades to a fresh profile
 * instead of a black screen.
 *
 * No three.js, no `game` reference — this module is pure data and is safe to import from
 * the menu, the HUD or a headless test.
 */

const STORAGE_KEY = 'overstrike.progress.v1';
const SCHEMA = 1;

export const LEVEL_MAX = 55;

/**
 * XP required to go from `level` to `level + 1`.
 * Quadratic-ish: ~900 XP for the first level, ~92k for the last, ~1.88M to hit 55.
 * A good match is worth 3–8k, so max rank is a long-haul goal without the early
 * levels feeling stingy.
 */
export function levelCost(level) {
  const k = Math.max(0, level - 1);
  return Math.round(900 + 350 * k + 26 * k * k);
}

/** CUMULATIVE[l] = total lifetime XP needed to BE level l. CUMULATIVE[1] === 0. */
const CUMULATIVE = (() => {
  const t = new Array(LEVEL_MAX + 2).fill(0);
  let acc = 0;
  for (let l = 1; l < LEVEL_MAX; l++) {
    acc += levelCost(l);
    t[l + 1] = acc;
  }
  t[LEVEL_MAX + 1] = acc; // sentinel: nothing beyond max
  return t;
})();

export const XP_TO_MAX = CUMULATIVE[LEVEL_MAX];

/** Rank titles, applied to the highest band whose `at` is <= level. */
const RANKS = [
  { at: 1, name: 'RECRUIT' },
  { at: 4, name: 'PRIVATE' },
  { at: 8, name: 'CORPORAL' },
  { at: 12, name: 'SERGEANT' },
  { at: 17, name: 'STAFF SERGEANT' },
  { at: 22, name: 'GUNNERY SERGEANT' },
  { at: 27, name: 'LIEUTENANT' },
  { at: 32, name: 'CAPTAIN' },
  { at: 37, name: 'MAJOR' },
  { at: 42, name: 'COLONEL' },
  { at: 47, name: 'BRIGADIER' },
  { at: 51, name: 'GENERAL' },
  { at: 55, name: 'OVERSTRIKE' },
];

/** XP awarded per event. Match XP is the sum of these plus flat bonuses. */
export const XP_VALUES = {
  kill: 100,
  assist: 25,
  headshot: 25,
  longshot: 50,
  confirm: 60,
  deny: 40,
  capture: 200,
  defend: 75,
  streak: 150,
  matchComplete: 250,
  win: 500,
  scoreDivisor: 4, // match score / 4 folded in, so objective play pays
};

/**
 * Medals. `stat` names a key on lifetime stats; progress is read straight off it so a
 * challenge can never drift out of sync with the numbers on the after-action report.
 */
export const CHALLENGES = [
  { id: 'headhunter', name: 'HEADHUNTER', desc: 'Get 50 headshots', stat: 'headshots', goal: 50, xp: 2500 },
  { id: 'marksman', name: 'MARKSMAN', desc: 'Get 10 longshots (45m+)', stat: 'longshots', goal: 10, xp: 2000 },
  { id: 'victor', name: 'VICTOR', desc: 'Win 5 matches', stat: 'wins', goal: 5, xp: 3000 },
  { id: 'veteran', name: 'VETERAN', desc: 'Get 500 total kills', stat: 'kills', goal: 500, xp: 5000 },
  { id: 'unstoppable', name: 'UNSTOPPABLE', desc: 'Earn 25 killstreaks', stat: 'streaksEarned', goal: 25, xp: 2500 },
  { id: 'operator', name: 'OPERATOR', desc: 'Play 25 matches', stat: 'matches', goal: 25, xp: 2000 },
];

const LIFETIME_KEYS = [
  'kills', 'deaths', 'assists', 'headshots', 'longshots', 'shotsFired', 'shotsHit',
  'wins', 'losses', 'draws', 'matches', 'playtime', 'longestShot', 'bestStreak',
  'score', 'captures', 'confirms', 'denies', 'streaksEarned',
];

function makeLifetime() {
  const o = {};
  for (const k of LIFETIME_KEYS) o[k] = 0;
  return o;
}

function makeDefaults() {
  return {
    schema: SCHEMA,
    xp: 0,
    level: 1,
    weapons: {},          // id -> { xp, kills, headshots, shotsFired, shotsHit }
    lifetime: makeLifetime(),
    challenges: {},       // id -> { done: bool, claimedAt: number }
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Coerce anything to a finite, non-negative-ish number. */
function num(v, fallback = 0) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function makeWeaponRow() {
  return { xp: 0, kills: 0, headshots: 0, shotsFired: 0, shotsHit: 0 };
}

export class Progression {
  constructor(storageKey = STORAGE_KEY) {
    this.key = storageKey;
    /** @type {null | ((level:number, prevLevel:number, self:Progression) => void)} */
    this.onLevelUp = null;
    /** @type {null | ((challenge:object, self:Progression) => void)} */
    this.onChallengeComplete = null;
    /** @type {null | ((id:string, level:number) => void)} */
    this.onUnlock = null;

    this.data = makeDefaults();
    /** @type {Array<object>|null} weapon defs registered by the weapon system. */
    this._weaponDefs = null;
    this._saveQueued = false;
    this._flush = () => { this._saveQueued = false; this._write(); };

    this.load();
  }

  // ------------------------------------------------------------------ storage

  load() {
    const fresh = makeDefaults();
    let parsed = null;
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(this.key) : null;
      if (raw) parsed = JSON.parse(raw);
    } catch (e) {
      console.warn('[progression] unreadable save, starting fresh', e);
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') {
      this.data = fresh;
      return false;
    }

    fresh.xp = Math.max(0, Math.min(XP_TO_MAX * 4, Math.floor(num(parsed.xp))));
    fresh.createdAt = num(parsed.createdAt, Date.now());
    fresh.updatedAt = num(parsed.updatedAt, Date.now());

    if (parsed.lifetime && typeof parsed.lifetime === 'object') {
      for (const k of LIFETIME_KEYS) fresh.lifetime[k] = Math.max(0, num(parsed.lifetime[k]));
    }

    if (parsed.weapons && typeof parsed.weapons === 'object') {
      for (const [id, row] of Object.entries(parsed.weapons)) {
        if (typeof id !== 'string' || !row || typeof row !== 'object') continue;
        const w = makeWeaponRow();
        for (const k of Object.keys(w)) w[k] = Math.max(0, num(row[k]));
        fresh.weapons[id] = w;
      }
    }

    if (parsed.challenges && typeof parsed.challenges === 'object') {
      for (const c of CHALLENGES) {
        const row = parsed.challenges[c.id];
        if (row && typeof row === 'object' && row.done) {
          fresh.challenges[c.id] = { done: true, claimedAt: num(row.claimedAt, Date.now()) };
        }
      }
    }

    fresh.level = this._levelForXp(fresh.xp);
    this.data = fresh;
    return true;
  }

  save() {
    // Coalesce bursts of writes (a match end touches a dozen fields) into one flush.
    this.data.updatedAt = Date.now();
    if (this._saveQueued) return;
    this._saveQueued = true;
    if (typeof queueMicrotask === 'function') queueMicrotask(this._flush);
    else this._flush();
  }

  _write() {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(this.key, JSON.stringify(this.data));
    } catch (e) {
      // Private mode / quota. Progression is a nicety, never a hard failure.
      console.warn('[progression] save failed', e);
    }
  }

  reset() {
    this.data = makeDefaults();
    try { localStorage?.removeItem(this.key); } catch { /* ignore */ }
    this._write();
    return this.data;
  }

  // -------------------------------------------------------------------- level

  _levelForXp(xp) {
    let lo = 1;
    for (let l = LEVEL_MAX; l >= 1; l--) {
      if (xp >= CUMULATIVE[l]) { lo = l; break; }
    }
    return lo;
  }

  getLevel() { return this.data.level; }
  getXp() { return this.data.xp; }
  getRankName(level = this.data.level) {
    let name = RANKS[0].name;
    for (const r of RANKS) if (level >= r.at) name = r.name;
    return name;
  }

  /** { level, rank, xp, intoLevel, needed, ratio, maxed } */
  getSummary() {
    const level = this.data.level;
    const maxed = level >= LEVEL_MAX;
    const base = CUMULATIVE[level];
    const needed = maxed ? 0 : CUMULATIVE[level + 1] - base;
    const into = this.data.xp - base;
    return {
      level,
      rank: this.getRankName(level),
      xp: this.data.xp,
      intoLevel: into,
      needed,
      ratio: maxed ? 1 : Math.max(0, Math.min(1, into / Math.max(1, needed))),
      maxed,
    };
  }

  /**
   * Award XP. Returns a report the HUD/after-action screen can render.
   * @returns {{ gained:number, xp:number, level:number, prevLevel:number, leveledUp:boolean, unlocked:string[] }}
   */
  addXp(amount, reason = '') {
    const gained = Math.max(0, Math.round(num(amount)));
    const prevLevel = this.data.level;
    if (gained > 0) {
      this.data.xp = Math.min(XP_TO_MAX, this.data.xp + gained);
      this.data.level = this._levelForXp(this.data.xp);
    }
    const leveledUp = this.data.level > prevLevel;
    let unlocked = [];
    if (leveledUp) {
      unlocked = this.getUnlockedBetween(prevLevel, this.data.level);
      try { this.onLevelUp?.(this.data.level, prevLevel, this); } catch (e) { console.error(e); }
      if (this.onUnlock) {
        for (const id of unlocked) {
          try { this.onUnlock(id, this.data.level); } catch (e) { console.error(e); }
        }
      }
    }
    if (gained > 0) this.save();
    return { gained, reason, xp: this.data.xp, level: this.data.level, prevLevel, leveledUp, unlocked };
  }

  // ------------------------------------------------------------------ unlocks

  /** The weapon system hands us its def list once so `getUnlocked()` can stay arg-less. */
  registerWeapons(defs) {
    if (Array.isArray(defs)) this._weaponDefs = defs;
    else if (defs && typeof defs === 'object') this._weaponDefs = Object.values(defs);
    return this._weaponDefs;
  }

  get weaponDefs() { return this._weaponDefs || []; }

  isUnlocked(def, level = this.data.level) {
    if (!def) return false;
    return level >= Math.max(1, num(def.unlockLevel, 1));
  }

  /** @returns {string[]} ids of every weapon available at the current level. */
  getUnlocked(defs = this._weaponDefs) {
    const list = Array.isArray(defs) ? defs : (defs ? Object.values(defs) : this.weaponDefs);
    const level = this.data.level;
    const out = [];
    for (const d of list) if (d && this.isUnlocked(d, level)) out.push(d.id);
    return out;
  }

  /** ids unlocked strictly after `fromLevel` and up to `toLevel`. */
  getUnlockedBetween(fromLevel, toLevel, defs = this._weaponDefs) {
    const list = Array.isArray(defs) ? defs : (defs ? Object.values(defs) : this.weaponDefs);
    const out = [];
    for (const d of list) {
      if (!d) continue;
      const u = Math.max(1, num(d.unlockLevel, 1));
      if (u > fromLevel && u <= toLevel) out.push(d.id);
    }
    return out;
  }

  /** Next locked weapon, for the "unlocks at rank N" line in the menu. */
  getNextUnlock(defs = this._weaponDefs) {
    const list = Array.isArray(defs) ? defs : (defs ? Object.values(defs) : this.weaponDefs);
    let best = null;
    for (const d of list) {
      if (!d || this.isUnlocked(d)) continue;
      const u = Math.max(1, num(d.unlockLevel, 1));
      if (!best || u < best.unlockLevel) best = { id: d.id, name: d.name || d.id, unlockLevel: u };
    }
    return best;
  }

  // ------------------------------------------------------------------ weapons

  /**
   * Only ids in the registered arsenal get a row. Auto-creating one for any string
   * means a typo'd or stale weapon id silently grows the saved profile forever, and
   * the whole table is re-serialised on every save.
   */
  weaponRow(id) {
    if (!id) return null;
    let row = this.data.weapons[id];
    if (row) return row;
    const known = this.weaponDefs?.some?.((d) => d && d.id === id);
    if (known === false) return null;
    return (this.data.weapons[id] = makeWeaponRow());
  }

  addWeaponXp(id, xp, kills = 0, headshots = 0) {
    const row = this.weaponRow(id);
    if (!row) return null;
    row.xp += Math.max(0, Math.round(num(xp)));
    row.kills += Math.max(0, Math.round(num(kills)));
    row.headshots += Math.max(0, Math.round(num(headshots)));
    return row;
  }

  /** Sorted descending by kills — ready for a "top weapons" panel. */
  getWeaponStats() {
    const out = [];
    for (const [id, row] of Object.entries(this.data.weapons)) {
      const def = this.weaponDefs.find((d) => d && d.id === id);
      out.push({
        id,
        name: def?.name || id,
        xp: row.xp,
        kills: row.kills,
        headshots: row.headshots,
        accuracy: row.shotsFired > 0 ? row.shotsHit / row.shotsFired : 0,
      });
    }
    out.sort((a, b) => b.kills - a.kills || b.xp - a.xp);
    return out;
  }

  // --------------------------------------------------------------- challenges

  getChallenges() {
    const lt = this.data.lifetime;
    return CHALLENGES.map((c) => {
      const value = Math.max(0, num(lt[c.stat]));
      const done = !!this.data.challenges[c.id]?.done || value >= c.goal;
      return {
        id: c.id,
        name: c.name,
        desc: c.desc,
        goal: c.goal,
        value: Math.min(value, c.goal),
        ratio: Math.max(0, Math.min(1, value / c.goal)),
        done,
        xp: c.xp,
      };
    });
  }

  /** @returns {Array<object>} challenges completed by this call (for the medal popup). */
  _settleChallenges() {
    const lt = this.data.lifetime;
    const earned = [];
    for (const c of CHALLENGES) {
      if (this.data.challenges[c.id]?.done) continue;
      if (Math.max(0, num(lt[c.stat])) < c.goal) continue;
      this.data.challenges[c.id] = { done: true, claimedAt: Date.now() };
      earned.push(c);
    }
    return earned;
  }

  // -------------------------------------------------------------------- stats

  getStats() {
    const lt = this.data.lifetime;
    const s = { ...lt };
    s.kd = lt.deaths > 0 ? lt.kills / lt.deaths : lt.kills;
    s.accuracy = lt.shotsFired > 0 ? lt.shotsHit / lt.shotsFired : 0;
    s.winRate = lt.matches > 0 ? lt.wins / lt.matches : 0;
    s.level = this.data.level;
    s.rank = this.getRankName();
    s.xp = this.data.xp;
    return s;
  }

  /**
   * Fold one finished match into the profile.
   *
   * @param {object} stats accepts the shape produced by Match._buildProgressionStats():
   *   { kills, deaths, assists, headshots, longshots, shotsFired, shotsHit, score,
   *     longestShot, bestStreak, streaksEarned, captures, confirms, denies,
   *     durationSec, result:'win'|'loss'|'draw', weapons:{ id:{kills,headshots,shotsFired,shotsHit} } }
   * @returns {{ xp:number, breakdown:object, levelUp:object, medals:Array<object> }}
   */
  recordMatch(stats = {}) {
    const s = stats || {};
    const kills = Math.max(0, Math.round(num(s.kills)));
    const deaths = Math.max(0, Math.round(num(s.deaths)));
    const assists = Math.max(0, Math.round(num(s.assists)));
    const headshots = Math.max(0, Math.round(num(s.headshots)));
    const longshots = Math.max(0, Math.round(num(s.longshots)));
    const confirms = Math.max(0, Math.round(num(s.confirms)));
    const denies = Math.max(0, Math.round(num(s.denies)));
    const captures = Math.max(0, Math.round(num(s.captures)));
    const defends = Math.max(0, Math.round(num(s.defends)));
    const streaks = Math.max(0, Math.round(num(s.streaksEarned)));
    const score = Math.max(0, Math.round(num(s.score)));
    const won = s.result === 'win';

    const V = XP_VALUES;
    const breakdown = {
      kills: kills * V.kill,
      assists: assists * V.assist,
      headshots: headshots * V.headshot,
      longshots: longshots * V.longshot,
      confirms: confirms * V.confirm,
      denies: denies * V.deny,
      captures: captures * V.capture,
      defends: defends * V.defend,
      streaks: streaks * V.streak,
      score: Math.round(score / V.scoreDivisor),
      completion: XP_VALUES.matchComplete,
      win: won ? V.win : 0,
    };
    let total = 0;
    for (const v of Object.values(breakdown)) total += v;

    const lt = this.data.lifetime;
    lt.kills += kills;
    lt.deaths += deaths;
    lt.assists += assists;
    lt.headshots += headshots;
    lt.longshots += longshots;
    lt.shotsFired += Math.max(0, Math.round(num(s.shotsFired)));
    lt.shotsHit += Math.max(0, Math.round(num(s.shotsHit)));
    lt.captures += captures;
    lt.confirms += confirms;
    lt.denies += denies;
    lt.streaksEarned += streaks;
    lt.score += score;
    lt.matches += 1;
    lt.playtime += Math.max(0, num(s.durationSec));
    if (won) lt.wins += 1;
    else if (s.result === 'draw') lt.draws += 1;
    else lt.losses += 1;
    lt.longestShot = Math.max(lt.longestShot, num(s.longestShot));
    lt.bestStreak = Math.max(lt.bestStreak, num(s.bestStreak));

    if (s.weapons && typeof s.weapons === 'object') {
      for (const [id, w] of Object.entries(s.weapons)) {
        if (!w || typeof w !== 'object') continue;
        const row = this.weaponRow(id);
        const wk = Math.max(0, Math.round(num(w.kills)));
        const wh = Math.max(0, Math.round(num(w.headshots)));
        row.kills += wk;
        row.headshots += wh;
        row.shotsFired += Math.max(0, Math.round(num(w.shotsFired)));
        row.shotsHit += Math.max(0, Math.round(num(w.shotsHit)));
        row.xp += wk * V.kill + wh * V.headshot;
      }
    }

    const medals = this._settleChallenges();
    for (const m of medals) {
      total += m.xp;
      try { this.onChallengeComplete?.(m, this); } catch (e) { console.error(e); }
    }

    const levelUp = this.addXp(total, 'match');
    this.save();
    return { xp: total, breakdown, levelUp, medals };
  }
}

/** Shared singleton — the game only ever has one local profile. */
export const progression = new Progression();
export default progression;
