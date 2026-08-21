import {
  MODES, MODE_LIST, getMode, DEFAULT_MODE, TEAM_NAMES, getWeaponDefs,
  DEFAULT_KILL_LIMIT, normalizeKillLimit,
} from './modes.js';
import { resolveMapManifest } from './bomb.js';
import { Spawner, SPAWN_PROTECTION } from './spawner.js';
import { Killstreaks } from './killstreaks.js';
import { progression } from './progression.js';
import { FIXED_DT } from '../core/mathUtils.js';

/**
 * OVERSTRIKE — the referee.
 *
 * Match owns the clock, the stat book, respawns, spawn protection and the scoring table.
 * The mode object owns what a kill *means*; the Match owns what a kill *costs and pays*.
 *
 * All rule timing runs on the fixed 1/120 step. Only HUD pushes happen per frame, and
 * only when a displayed value actually changed.
 */

const COUNTDOWN = 3.0;
const PLAYER_RESPAWN = 4.0;
const PLAYER_SKIP_AFTER = 1.5;   // press fire after this to cut the wait short
// BotManager keeps its own 4.0 s fallback timer. Coming in under it — including the
// jitter below — means the scored spawn here wins the race in practice, and the fallback
// stays as a pure safety net.
const BOT_RESPAWN = 3.4;
/**
 * Deaths cluster: one airstrike, one grenade or one gunship burst kills four bots on the
 * SAME fixed step. With a fixed delay those four then share one respawn deadline, so four
 * fully-scored spawn searches land on a single 1/120 s step — and up to six such steps can
 * land inside one rendered frame. Spreading the deadline over +/- this many seconds costs
 * nothing that a player can perceive and turns the burst back into a trickle.
 *
 * Drawn from `game.rng`, never `Math.random` — same seed must mean same match (§1).
 */
const BOT_RESPAWN_JITTER = 0.4;
/**
 * Hard ceiling on scored spawns per fixed step. The jitter above makes a pile-up
 * unlikely; this makes it impossible. A deferred spawn slips by 1/120 s per step, which
 * is three orders of magnitude below the respawn delay itself.
 */
const MAX_SPAWNS_PER_STEP = 2;
const ASSIST_WINDOW = 4.0;
const MULTIKILL_WINDOW = 4.0;
const LONGSHOT_DISTANCE = 45;
const STREAK_MILESTONES = [3, 5, 7, 10];
const DAMAGE_LOG_MAX = 8;

/** Score awards. Kills pay the base; everything else is a bonus on top. */
export const SCORE = {
  kill: 100,
  headshot: 50,
  assist: 25,
  revenge: 75,
  longshot: 150,
  doubleKill: 100,
  tripleKill: 200,
  multiKill: 300,
  teamKillPenalty: -100,
  suicidePenalty: -50,
  // bomb-rules §10 — objective awards. Values are balance and belong to the human owner
  // alongside §2; the rules hold for any values here.
  plant: 250,
  defuse: 250,
  roundWin: 200,
  clutch: 300,
};

/** bomb-rules §10 award ids, so a typo at a call site is a crash and not a silent zero. */
const OBJECTIVE_AWARDS = Object.freeze({
  plant: SCORE.plant, defuse: SCORE.defuse, roundWin: SCORE.roundWin, clutch: SCORE.clutch,
});

export class Match {
  constructor(game) {
    this.game = game;

    this.modes = MODES;
    this.modeList = MODE_LIST;
    this.modeId = DEFAULT_MODE;
    this.mode = getMode(DEFAULT_MODE);
    this.modeState = {};
    /**
     * Bomb's round state machine (`bomb.js`), or null in every other mode. Created by
     * `BOMB.init` and torn down by `BOMB.cleanup`, so the referee never carries dormant
     * objective state through a TDM match.
     *
     * The flat, replication-facing view of it is the getter block further down
     * (`bomb`, `roundPhase`, `aliveCounts`, `interaction`, …) — that is what
     * `src/net/server.js` reads, and it is deliberately plain data.
     */
    this.bombRules = null;
    /** Staged replication values for harnesses; ignored whenever `bombRules` exists. */
    this._bombView = {};
    /**
     * The map manifest the objective volumes come from (`map-data.md` §3.3). Resolved
     * from the map at `begin()`, or supplied explicitly by a harness building against a
     * map whose objectives are not authored yet. Never coordinates in the ruleset.
     */
    this.mapManifest = null;

    /** Team scores. Index === team for team modes. */
    this.scores = [0, 0];
    this.phase = 'idle';        // 'idle' | 'countdown' | 'live' | 'ended'
    this._elapsedTicks = 0;
    this.timeLimit = 600;
    this.killLimit = DEFAULT_KILL_LIMIT;
    this.countdown = 0;
    this.playerTeam = 0;
    this.botCount = 7;
    this.difficulty = 'regular';
    this.result = null;
    this.lastProgression = null;

    this.spawner = new Spawner(game, this);
    this.killstreaks = new Killstreaks(game, this);

    /** @type {Map<number, object>} entity.id -> stat row */
    this._book = new Map();
    /** @type {Map<number, Array<{id:number, amount:number, time:number}>>} */
    this._damageLog = new Map();
    /** @type {Map<number, number>} entity.id -> protection expiry */
    this._protect = new Map();
    /** @type {Map<number, number>} entity.id -> elapsed time of its last booked death */
    this._deathGuard = new Map();
    /** @type {Array<{entity:object, at:number, minAt:number, killerName:string}>} */
    this._respawns = [];
    this._moments = [];
    this._rows = [];
    this._rowPool = [];
    this._hudScores = [0, 0];
    this._lastHudA = -1;
    this._lastHudB = -1;
    this._lastHudTime = -1;
    this._lastCountdownShown = -1;
    this._playerWeapons = new Map();
    this._firstBlood = true;
    this._unsub = [];

    this._onKill = this._onKill.bind(this);
    this._onDamage = this._onDamage.bind(this);
    this._onSpawn = this._onSpawn.bind(this);
    this._onShot = this._onShot.bind(this);
    this._onHit = this._onHit.bind(this);
  }

  async init() {
    this.spawner.init();
    await this.killstreaks.init();
    progression.registerWeapons(getWeaponDefs(this.game));

    // Keep the one-entry mode hook in the boot lifecycle so the rules contract remains
    // explicit if TDM ever gains prewarmed presentation resources.
    for (const m of this.modeList) {
      try { m.prewarm?.(this); } catch (err) { console.warn('[match] mode prewarm', m.id, err); }
    }

    const bus = this.game.bus;
    this._unsub.push(bus.on('kill', this._onKill));
    this._unsub.push(bus.on('damage', this._onDamage));
    this._unsub.push(bus.on('spawn', this._onSpawn));
    this._unsub.push(bus.on('shot', this._onShot));
    this._unsub.push(bus.on('hit', this._onHit));
  }

  // ------------------------------------------------------------------ lifecycle

  /**
   * Called by Game.startMatch() for every system before begin().
   * Systems reset in order and BotManager (which runs after us) reads `game.match.mode`
   * to decide its roster, so the mode must be resolved here, not in begin().
   */
  reset(opts = {}) {
    this.mode?.cleanup?.(this);
    this.modeId = this._resolveModeId(opts);
    this.mode = getMode(this.modeId);
    this.timeLimit = this.mode.timeLimit;
    this.killLimit = normalizeKillLimit(
      opts.killLimit ?? this.game.settings?.get?.('killLimit') ?? this.killLimit,
    );
    this.modeState = {};
    this.scores[0] = 0;
    this.scores[1] = 0;
    this.phase = 'idle';
    this._elapsedTicks = 0;
    this.countdown = 0;
    this.result = null;
    this.lastProgression = null;
    this._book.clear();
    this._damageLog.clear();
    this._protect.clear();
    this._deathGuard.clear();
    this._respawns.length = 0;
    this._moments.length = 0;
    this._playerWeapons.clear();
    this._firstBlood = true;
    this._lastHudA = this._lastHudB = this._lastHudTime = -1;
    this._lastCountdownShown = -1;
    this.killstreaks.reset();
    this.spawner.reset();
  }

  /**
   * Start a match.
   * @param {{killLimit?:number, botCount?:number, difficulty?:string}} opts
   */
  begin(opts = {}) {
    const settings = this.game.settings;
    this.modeId = this._resolveModeId(opts);
    this.mode = getMode(this.modeId);
    // Game.startMatch() writes `mode` into settings before systems reset, and it writes the
    // DEFAULT there because it does not resolve modes itself. The referee is what decides
    // which ruleset is being played, so it has the last word on what settings, the menu and
    // the next match's default read back.
    //
    // For 'bomb' this write is currently DISCARDED: `Settings.ENUMS.mode` is `['tdm']` and
    // `settings.js` is Codex-owned, so the enum entry is filed as REQ-CX-008 rather than
    // edited here. Nothing depends on it sticking — every caller that wants Bomb passes
    // `opts.mode`, which wins over the setting in `_resolveModeId` — but a Bomb match
    // followed by a `startMatch()` with no options does fall back to TDM until it lands.
    settings?.set?.('mode', this.modeId);
    this.mapManifest = opts.mapManifest ?? resolveMapManifest(this.game);
    this.modeState = {};
    this.botCount = Math.max(0, opts.botCount ?? settings?.get?.('botCount') ?? this.botCount);
    this.difficulty = opts.difficulty ?? settings?.get?.('difficulty') ?? this.difficulty;
    this.timeLimit = this.mode.timeLimit;
    this.killLimit = normalizeKillLimit(
      opts.killLimit ?? settings?.get?.('killLimit') ?? this.killLimit,
    );

    this.scores[0] = 0;
    this.scores[1] = 0;
    this._elapsedTicks = 0;
    this.result = null;
    this.lastProgression = null;
    this._book.clear();
    this._damageLog.clear();
    this._protect.clear();
    this._deathGuard.clear();
    this._respawns.length = 0;
    this._moments.length = 0;
    this._playerWeapons.clear();
    this._firstBlood = true;
    this._lastHudA = this._lastHudB = this._lastHudTime = -1;

    // Bot population + skill, if the AI system exposes them.
    this.game.bots?.setCount?.(this.botCount);
    this.game.bots?.setDifficulty?.(this.difficulty);

    this._assignTeams();
    this.spawner.reset();
    this.killstreaks.reset();
    this.mode.init?.(this);

    // Register and place everyone.
    const ents = this.game.entities;
    for (let i = 0; i < ents.length; i++) {
      this._register(ents[i]);
      this.spawner.spawnEntity(ents[i]);
    }

    this.phase = 'countdown';
    this.countdown = COUNTDOWN;
    this._lastCountdownShown = -1;

    this.notice(this.mode.name, this.mode.hudLabels?.objective || this.mode.description, 2.6);
    this.game.present.play('matchStart', { volume: 0.9 });
    this._pushHud(true);
  }

  /**
   * Which ruleset this match is played under.
   *
   * `opts.mode` first (the caller asked for it), then the stored setting, then the
   * default. Unknown or stale ids resolve to the default rather than failing — see
   * `getMode`.
   */
  _resolveModeId(opts = {}) {
    return getMode(opts.mode ?? this.game.settings?.get?.('mode') ?? DEFAULT_MODE).id;
  }

  /** Assign the two Team Deathmatch squads. */
  _assignTeams() {
    const ents = this.game.entities;
    {
      this.playerTeam = 0;
      // BotManager has already dealt the roster into two sides and baked a model
      // colourway per bot. Only intervene if that split is actually wrong — a team
      // flip here would leave a bot wearing the other side's kit.
      // Only the LOCAL player is pinned. `isPlayer` is true of every networked client's
      // entity too, and pinning all of them put every human on team 0 — on a server that
      // meant humans could never damage each other, and with the bot roster dealt evenly
      // it meant half the enemies on screen were teammates who took zero damage. The
      // symptom is not "friendly fire is off", it is `damageScale` returning 0 and
      // `fireHitscan` then nulling the hit outright: no hitmarker, no blood, no sound.
      // Indistinguishable from the bullet missing.
      const local = this.game.player;
      let a = 0;
      let b = 0;
      let dirty = false;
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        if (e === local) { if (e.team !== 0) { e.team = 0; dirty = true; } a++; continue; }

        // Networked humans are DEALT, not merely counted. Leaving them on their default
        // team 0 and trusting `_rebalance` to sort it out does not work: rebalance moves
        // whichever team-0 entity it meets first, and `game.entities` lists bots before
        // joined players, so it emptied team 0 of BOTS and left every human standing on
        // one side. Dealing them to the smaller side as we go puts humans on both.
        if (e.isPlayer) {
          const want = a <= b ? 0 : 1;
          if (e.team !== want) { e.team = want; dirty = true; }
          (want === 1 ? b++ : a++);
          continue;
        }

        if (e.team !== 0 && e.team !== 1) { e.team = i % 2 === 0 ? 0 : 1; dirty = true; }
        (e.team === 1 ? b++ : a++);
      }
      if (dirty || Math.abs(a - b) > 1) this._rebalance();
    }
  }

  _rebalance() {
    const ents = this.game.entities;
    const local = this.game.player;
    let a = 0;
    let b = 0;
    for (let i = 0; i < ents.length; i++) (ents[i].team === 1 ? b++ : a++);
    while (Math.abs(a - b) > 1) {
      const from = a > b ? 0 : 1;
      const to = from === 0 ? 1 : 0;
      let moved = false;
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        if (e === local || e.team !== from) continue;
        e.team = to;
        // The bot's model colourway is baked per team; rebuild it to match.
        e.ensureTeamModel?.();
        const st = this._book.get(e.id);
        if (st) st.team = to;
        moved = true;
        break;
      }
      if (!moved) break;
      if (from === 0) { a--; b++; } else { a++; b--; }
    }
  }

  // -------------------------------------------------------------------- stats

  _register(entity) {
    if (!entity) return null;
    let st = this._book.get(entity.id);
    if (st) return st;
    st = {
      id: entity.id,
      entity,
      name: entity.name || (entity.isPlayer ? 'YOU' : `BOT ${entity.id}`),
      isPlayer: !!entity.isPlayer,
      team: entity.team,
      kills: 0, deaths: 0, assists: 0, score: 0,
      streak: 0, bestStreak: 0, headshots: 0, longshots: 0,
      longestShot: 0, shotsFired: 0, shotsHit: 0, damageDealt: 0,
      captures: 0, defends: 0, confirms: 0, denies: 0,
      // bomb-rules §10 — completions only.
      plants: 0, defuses: 0, roundWins: 0, clutches: 0,
      streaksEarned: 0, tier: 0,
      lastKillTime: -99, multiCount: 0, lastKilledBy: -1,
      _hitThisShot: false,
    };
    this._book.set(entity.id, st);
    // Mirror into the shared entity contract so HUD/AI can read it without us.
    if (entity.stats) {
      entity.stats.kills = 0;
      entity.stats.deaths = 0;
      entity.stats.score = 0;
      entity.stats.streak = 0;
    }
    return st;
  }

  _isLiveEntity(entity) {
    // Identity, not id: an id that resolves to a DIFFERENT object means this entity is a
    // stale reference, which is exactly the case worth rejecting.
    return !!entity && this.game.entityById(entity.id) === entity;
  }

  /** Stat row for an entity, or null for non-combatants (sentries, gunships, world). */
  statsFor(entity) {
    if (!entity) return null;
    const st = this._book.get(entity.id);
    if (st) return st;
    if (!this._isLiveEntity(entity)) return null;
    return this._register(entity);
  }

  /** Streak hardware credits its owner. */
  _resolveAttacker(attacker) {
    if (!attacker) return null;
    if (attacker.ownerEntity) return attacker.ownerEntity;
    return attacker;
  }

  areEnemies(a, b) {
    if (!a || !b || a === b) return false;
    return a.team !== b.team;
  }

  teamOf(entity) { return entity?.team ?? -1; }

  // ------------------------------------------------------------------- events

  _onShot(p) {
    const shooter = this._resolveAttacker(p?.shooter);
    // Firing gives away your position — and your spawn protection.
    //
    // Resolved, not raw. Streak hardware is not in `game.entities` and carries its own
    // id space, so a raw `p.shooter.id` from a sentry or gunship deleted whichever
    // ENTITY happened to share that number. It always did: sentry #1 and the player were
    // both id 1, so every sentry burst — five a second — stripped the player's spawn
    // protection. Resolving to `ownerEntity` also matches the intent: it is the operator
    // who gave their position away, and their own turret firing is not them firing.
    if (shooter) this._protect.delete(shooter.id);
    const st = this.statsFor(shooter);
    if (!st) return;
    st.shotsFired++;
    st._hitThisShot = false;
    if (st.isPlayer && p.weaponId) {
      const w = this._weaponRow(p.weaponId);
      w.shotsFired++;
    }
  }

  _onHit(p) {
    // An absorbed round stopped on a spawn-protected enemy and did nothing. Counting it
    // as a hit credited 100% accuracy for zero damage.
    if (p?.absorbed) return;
    const shooter = this._resolveAttacker(p?.shooter);
    const st = this.statsFor(shooter);
    if (!st || st._hitThisShot) return;
    // One shot counts once, however many pellets connected.
    st._hitThisShot = true;
    st.shotsHit++;
    if (st.isPlayer) {
      const id = p.weaponId || shooter?.weapon?.def?.id;
      if (id) this._weaponRow(id).shotsHit++;
    }
  }

  _onDamage(p) {
    const victim = p?.target;
    const attacker = this._resolveAttacker(p?.attacker);
    if (!victim || !attacker || attacker === victim) return;
    if (!this.areEnemies(attacker, victim)) return;

    const st = this.statsFor(attacker);
    if (st) st.damageDealt += p.amount || 0;

    let log = this._damageLog.get(victim.id);
    if (!log) this._damageLog.set(victim.id, (log = []));
    const now = this.elapsed;
    let row = null;
    for (let i = 0; i < log.length; i++) if (log[i].id === attacker.id) { row = log[i]; break; }
    if (row) {
      row.amount += p.amount || 0;
      row.time = now;
    } else {
      if (log.length >= DAMAGE_LOG_MAX) {
        // Drop the stalest contributor rather than growing without bound.
        let oldest = 0;
        for (let i = 1; i < log.length; i++) if (log[i].time < log[oldest].time) oldest = i;
        log.splice(oldest, 1);
      }
      log.push({ id: attacker.id, amount: p.amount || 0, time: now });
    }
  }

  _onSpawn(p) {
    const e = p?.entity;
    if (!e) return;
    const st = this._register(e);
    if (st) st.team = e.team;
    this._protect.set(e.id, this.elapsed + SPAWN_PROTECTION);
    this._damageLog.delete(e.id);
    this.mode.onSpawn?.(this, e);
  }

  _onKill(p) {
    if (this.phase === 'ended') return;
    const victim = p?.victim;
    if (!victim) return;
    // Deaths can be reported by the entity (bots), by us on the player's behalf, or by
    // a system probing both paths. Book each death exactly once.
    const lastDeath = this._deathGuard.get(victim.id);
    if (lastDeath !== undefined && this.elapsed - lastDeath < 0.3) return;
    this._deathGuard.set(victim.id, this.elapsed);

    const attacker = this._resolveAttacker(p.attacker);
    const now = this.elapsed;
    const vst = this._register(victim);
    const ast = attacker ? this._register(attacker) : null;

    // ---- victim bookkeeping
    vst.deaths++;
    if (vst.streak >= 3) this._addMoment('streakEnd', `${vst.name} streak ended`, `${vst.streak} kills`, vst.streak * 8);
    vst.streak = 0;
    vst.multiCount = 0;
    if (victim.stats) { victim.stats.deaths = vst.deaths; victim.stats.streak = 0; }
    if (attacker && attacker !== victim) vst.lastKilledBy = attacker.id;
    this.spawner.noteDeath(victim, victim.position);
    this.killstreaks.onDeath(victim);
    victim.alive = false;

    const friendly = attacker && attacker !== victim && !this.areEnemies(attacker, victim);
    const suicide = !attacker || attacker === victim;

    // ---- attacker bookkeeping
    if (suicide) {
      this._addScore(vst, SCORE.suicidePenalty, null);
    } else if (friendly) {
      this._addScore(ast, SCORE.teamKillPenalty, null);
      if (attacker.isPlayer) this.notice('FRIENDLY FIRE', 'Watch your fire', 1.4);
    } else if (ast) {
      ast.kills++;
      ast.streak++;
      ast.bestStreak = Math.max(ast.bestStreak, ast.streak);
      if (attacker.stats) { attacker.stats.kills = ast.kills; attacker.stats.streak = ast.streak; }

      let award = SCORE.kill;
      let label = null;

      if (p.headshot) {
        award += SCORE.headshot;
        ast.headshots++;
        label = 'HEADSHOT';
        if (attacker.isPlayer) this._weaponRow(p.weaponId).headshots++;
      }

      const dist = p.distance || 0;
      if (dist > ast.longestShot) ast.longestShot = dist;
      if (dist > LONGSHOT_DISTANCE) {
        award += SCORE.longshot;
        ast.longshots++;
        label = 'LONGSHOT';
        this._addMoment('longshot', `${ast.name} longshot`, `${dist.toFixed(0)} m`, 90 + dist);
      }

      if (vst.id === ast.lastKilledBy) {
        award += SCORE.revenge;
        ast.lastKilledBy = -1;
        label = label || 'REVENGE';
      }

      // Multikills.
      if (now - ast.lastKillTime <= MULTIKILL_WINDOW) ast.multiCount++;
      else ast.multiCount = 1;
      ast.lastKillTime = now;
      if (ast.multiCount === 2) {
        award += SCORE.doubleKill;
        label = 'DOUBLE KILL';
        this._addMoment('multi', `${ast.name} double kill`, '', 120);
      } else if (ast.multiCount === 3) {
        award += SCORE.tripleKill;
        label = 'TRIPLE KILL';
        this._addMoment('multi', `${ast.name} triple kill`, '', 200);
      } else if (ast.multiCount >= 4) {
        award += SCORE.multiKill;
        label = `${ast.multiCount}x MULTI KILL`;
        this._addMoment('multi', `${ast.name} ${ast.multiCount}x multikill`, '', 240 + ast.multiCount * 10);
      }

      this._addScore(ast, award, null);
      if (label && attacker.isPlayer) this.notice(label, `+${award}`, 1.2);

      if (attacker.isPlayer && p.weaponId) this._weaponRow(p.weaponId).kills++;

      if (this._firstBlood) {
        this._firstBlood = false;
        this._addMoment('firstBlood', `${ast.name} drew first blood`, vst.name, 70);
        if (attacker.isPlayer) this.notice('FIRST BLOOD', '', 1.4);
      }

      this._awardAssists(victim, attacker);
      this._checkStreak(attacker, ast);
    }

    this._killfeed(p, attacker, victim, friendly, suicide);
    this._damageLog.delete(victim.id);

    // Mode rules get the resolved attacker so streak kills score correctly.
    const resolved = p.attacker === attacker ? p : {
      victim, attacker, weaponId: p.weaponId, headshot: p.headshot, distance: p.distance,
    };
    this.mode.onKill?.(this, resolved);

    this._queueRespawn(victim, attacker);
    this._checkEnd();
  }

  _awardAssists(victim, killer) {
    const log = this._damageLog.get(victim.id);
    if (!log) return;
    const now = this.elapsed;
    for (let i = 0; i < log.length; i++) {
      const row = log[i];
      if (row.id === killer.id) continue;
      if (now - row.time > ASSIST_WINDOW) continue;
      const st = this._book.get(row.id);
      if (!st || !st.entity || !this.areEnemies(st.entity, victim)) continue;
      st.assists++;
      this._addScore(st, SCORE.assist, null);
      if (st.isPlayer) this.notice('ASSIST', `+${SCORE.assist}`, 0.9);
    }
  }

  _checkStreak(entity, st) {
    if (STREAK_MILESTONES.indexOf(st.streak) < 0) return;
    st.streaksEarned++;
    this.game.bus.emit('killstreak', { entity, count: st.streak });
    if (entity.isPlayer) this.notice(`${st.streak} KILLSTREAK`, '', 1.4);
    this._addMoment('streak', `${st.name} ${st.streak} killstreak`, '', 60 + st.streak * 18);
  }

  /**
   * The HUD subscribes to `kill` and renders its own killfeed row from the canonical
   * payload, so pushing one from here as well would double every line. We only call
   * `hud.killfeed()` for a HUD that does NOT self-feed (`hud.killfeedFromBus === false`),
   * and otherwise let the event carry it.
   */
  _killfeed(p, attacker, victim, friendly, suicide) {
    const hud = this.game.hud;
    if (!hud?.killfeed || hud.killfeedFromBus !== false) return;
    const vst = this._book.get(victim.id);
    const ast = attacker ? this._book.get(attacker.id) : null;
    const player = this.game.player;
    // The killfeed resolves names/teams off the entity refs and falls back to the
    // explicit strings, so send both.
    this.game.present.killfeed({
      attacker: suicide ? null : attacker,
      victim,
      killer: suicide ? null : (ast?.name || attacker?.name || 'UNKNOWN'),
      victimName: vst?.name || victim.name || 'UNKNOWN',
      killerTeam: suicide ? -1 : (attacker?.team ?? -1),
      victimTeam: victim.team ?? -1,
      mine: !!(player && (attacker === player || victim === player)),
      weaponId: p.weaponId || null,
      headshot: !!p.headshot,
      distance: p.distance || 0,
      teamkill: !!friendly,
      suicide: !!suicide,
    });
  }

  _weaponRow(id) {
    if (!id) id = 'unknown';
    let row = this._playerWeapons.get(id);
    if (!row) this._playerWeapons.set(id, (row = { kills: 0, headshots: 0, shotsFired: 0, shotsHit: 0 }));
    return row;
  }

  _addMoment(type, label, detail, weight) {
    this._moments.push({ type, label, detail, weight, time: this.elapsed });
    // Keep the buffer bounded; the weakest moment goes first.
    if (this._moments.length > 40) {
      let worst = 0;
      for (let i = 1; i < this._moments.length; i++) {
        if (this._moments[i].weight < this._moments[worst].weight) worst = i;
      }
      this._moments.splice(worst, 1);
    }
  }

  // ------------------------------------------------------------------ scoring

  _addScore(st, points, reason) {
    if (!st || !points) return;
    st.score = Math.max(0, st.score + points);
    if (st.entity?.stats) st.entity.stats.score = st.score;
    if (reason && st.isPlayer) this.notice(reason, `+${points}`, 0.9);
  }

  /** Public: modes and killstreaks award personal score through here. */
  addScore(entity, points, reason = null) {
    const st = this.statsFor(entity);
    if (!st) return;
    this._addScore(st, points, reason);
  }

  /**
   * bomb-rules §10 objective awards. The ruleset names an award; the referee owns what it
   * pays and books the completion counters. An unknown award id throws rather than paying
   * nothing quietly — a typo that silently zeroes a payout is indistinguishable from a
   * balance decision.
   */
  awardObjective(entity, award) {
    const points = OBJECTIVE_AWARDS[award];
    if (points === undefined) throw new Error(`match: unknown objective award "${award}"`);
    if (!entity) return null;
    const st = this.statsFor(entity);
    if (!st) return null;
    if (award === 'plant') st.plants++;
    else if (award === 'defuse') st.defuses++;
    else if (award === 'roundWin') st.roundWins++;
    else if (award === 'clutch') st.clutches++;
    this._addScore(st, points, null);
    return st;
  }

  /**
   * Client → server objective request (§6, §7). The client only ASKS; every precondition,
   * the accumulation and the interruption all happen inside the ruleset on the fixed step.
   * Returns false in any mode that has no objectives.
   */
  requestInteract(entity, kind) { return this.bombRules ? this.bombRules.requestInteract(entity, kind) : false; }

  /** Key released. §6: progress resets to zero — no partial credit, no resume. */
  releaseInteract(entity) { this.bombRules?.releaseInteract(entity); }

  // ─────────────────────────────────────────── the replication view of the Bomb ruleset
  //
  // `src/net/server.js` (`readBombMatchState`) and the HUD read THESE, never the rules
  // object: everything below is plain data with a documented shape, so the wire cannot
  // acquire a dependency on the ruleset's internals. Each returns a TDM-safe default so a
  // non-Bomb match produces an honest empty frame rather than throwing in the tick loop.
  //
  // Each one is WRITABLE, and the write is only honoured while no ruleset is loaded. That
  // is for harnesses (`nettest.mjs`) that stage one frame of Bomb state on a real Match to
  // test replication without running a match: with a ruleset present the derived value
  // always wins, so a staged value can never mask the live one in a real match.

  /** bomb-rules §5, the bomb object: `{ state, carrierId, siteId, position }`. */
  get bomb() { return this.bombRules ? this.bombRules.bomb : (this._bombView.bomb ?? null); }
  set bomb(v) { this._bombView.bomb = v; }

  /**
   * bomb-rules §3 round phase — `warmup | freeze | live | planted | roundEnd | matchEnd`.
   *
   * NOT the same thing as `match.phase`, which is the MATCH's own lifecycle
   * (`idle | countdown | live | ended`) and is what TDM, the HUD timer and `canFire` read.
   * A Bomb round can be in `freeze` while the match is `live`.
   */
  get roundPhase() { return this.bombRules ? this.bombRules.phase : (this._bombView.roundPhase ?? this.phase); }
  set roundPhase(v) { this._bombView.roundPhase = v; }

  /** 0-based index of the round being played; `roundNumber` is the 1-based one. */
  get roundIndex() { return this.bombRules ? this.bombRules.roundIndex : (this._bombView.roundIndex ?? 0); }
  set roundIndex(v) { this._bombView.roundIndex = v; }

  get roundNumber() { return this.roundIndex + 1; }

  get attackingTeam() { return this.bombRules ? this.bombRules.attackingTeam : (this._bombView.attackingTeam ?? 0); }
  set attackingTeam(v) { this._bombView.attackingTeam = v; }

  /** True once the §2 side switch has happened, i.e. from round 7 on. */
  get sideSwitched() { return this.bombRules ? this.bombRules.sideSwitched : !!this._bombView.sideSwitched; }
  set sideSwitched(v) { this._bombView.sideSwitched = v; }

  /** Living, connected, non-eliminated players per side. Public to both teams (§8). */
  get aliveCounts() {
    if (!this.bombRules) return this._bombView.aliveCounts ?? { alpha: 0, bravo: 0 };
    const [alpha, bravo] = this.bombRules.aliveCounts();
    return { alpha, bravo };
  }
  set aliveCounts(v) { this._bombView.aliveCounts = v; }

  /** Milliseconds left on whichever clock this phase runs (§3). */
  get phaseRemainingMs() {
    if (!this.bombRules) return this._bombView.phaseRemainingMs ?? 0;
    return Math.round(this.bombRules.displayTime * 1000);
  }
  set phaseRemainingMs(v) { this._bombView.phaseRemainingMs = v; }

  /** The objective interaction being shown: `{ kind, actorId, progress }`, progress 0..1. */
  get interaction() {
    if (!this.bombRules) return this._bombView.interaction ?? { kind: 'none', actorId: 0, progress: 0 };
    return this.bombRules.interaction;
  }
  set interaction(v) { this._bombView.interaction = v; }

  /** Public: modes award team score through here. */
  addTeamScore(team, points) {
    const t = team === 1 ? 1 : 0;
    this.scores[t] = Math.max(0, this.scores[t] + points);
  }

  // ----------------------------------------------------------------- respawns

  _queueRespawn(entity, killer) {
    const isPlayer = !!entity.isPlayer;
    // bomb-rules §8: in a live Bomb round a death is an ELIMINATION, and the player stays
    // out until the next freeze. The mode decides; TDM has no opinion and respawns.
    if (this.mode.allowRespawn?.(this, entity) === false) {
      if (isPlayer) {
        this.game.present.deathScreen({
          victim: entity,
          killer: killer && killer !== entity ? killer : null,
          killerName: killer ? (this._book.get(killer.id)?.name || killer.name || '') : '',
          killerHealth: killer?.health ?? 0,
          respawnIn: 0,
          eliminated: true,
        });
      }
      return;
    }
    // The player's countdown is shown on the death screen and must stay exact; only bots
    // get the de-clustering jitter.
    const delay = isPlayer
      ? PLAYER_RESPAWN
      : BOT_RESPAWN + (this.game.rng?.range?.(-BOT_RESPAWN_JITTER, BOT_RESPAWN_JITTER) ?? 0);
    this._respawns.push({
      entity,
      at: this.elapsed + delay,
      minAt: this.elapsed + (isPlayer ? PLAYER_SKIP_AFTER : delay),
      killerName: killer && killer !== entity ? (this._book.get(killer.id)?.name || killer.name || '') : '',
    });
    if (isPlayer) {
      this.game.present.deathScreen({
        victim: entity,
        killer: killer && killer !== entity ? killer : null,
        killerName: killer ? (this._book.get(killer.id)?.name || killer.name || '') : '',
        killerHealth: killer?.health ?? 0,
        respawnIn: delay,
      });
    }
  }

  /**
   * Put the dead back in the world.
   *
   * Skipped entirely on a networked CLIENT. The server owns respawn timing, spawn choice
   * and the roster; a client running this too was spawning entities from its own shadow
   * copy — including bots it had already torn down at join — which threw inside
   * `Spawner.spawnEntity` and, through `Game._safe`, isolated `match.fixed` for the whole
   * session. From then on the match clock, scoring and spawn protection were all dead on
   * that client.
   */
  _updateRespawns(dt) {
    if (this.game.net) return;
    return this._updateRespawnsImpl(dt);
  }

  _updateRespawnsImpl(dt) {
    if (this._respawns.length === 0) return;
    const now = this.elapsed;
    // Scored spawning is the single most expensive thing this class does (a full
    // candidate sweep with LOS marches per point). Never run more than
    // MAX_SPAWNS_PER_STEP of them on one 1/120 s step, whatever the deadlines say.
    let spawned = 0;
    for (let i = this._respawns.length - 1; i >= 0; i--) {
      const r = this._respawns[i];
      const e = r.entity;
      if (!e) { this._respawns.splice(i, 1); continue; }
      let go = now >= r.at;
      // `_firePressedThisFrame` (latched by Player._buildLocalCommand) rather than
      // reading game.input directly — the player controller is the only thing allowed
      // to touch input; everything downstream reads its resolved command instead. This
      // must NOT be `_edge`, which Player clears at the end of every fixed SUBSTEP —
      // Match runs after Player in the same substep and would never see it.
      if (!go && e.isPlayer && now >= r.minAt && e._firePressedThisFrame) go = true;
      if (!go) continue;
      // Budget is spent only by entries that will actually reach spawnEntity(); an
      // already-alive entity below is dropped for free and must not consume it.
      if (spawned >= MAX_SPAWNS_PER_STEP && !e.alive) continue;
      this._respawns.splice(i, 1);
      if (this.phase === 'ended') continue;
      // BotManager keeps a fallback respawn timer of its own; if it got there first,
      // the entity is already back in the world and must not be moved again.
      if (e.alive) continue;
      if (!e.isPlayer) this._rebalanceOnRespawn(e);
      this.spawner.spawnEntity(e);
      spawned++;
      if (e.isPlayer) this.game.present.deathScreen(null, e);
    }
  }

  /** Keep the sides even as bots cycle through; only ever moves a dead bot. */
  _rebalanceOnRespawn(bot) {
    const ents = this.game.entities;
    let a = 0;
    let b = 0;
    for (let i = 0; i < ents.length; i++) {
      if (ents[i] === bot) continue;
      (ents[i].team === 1 ? b++ : a++);
    }
    const mine = bot.team === 1 ? 1 : 0;
    let changed = false;
    if (mine === 0 && a > b) { bot.team = 1; changed = true; }
    else if (mine === 1 && b > a) { bot.team = 0; changed = true; }
    if (changed) bot.ensureTeamModel?.();
    const st = this._book.get(bot.id);
    if (st) st.team = bot.team;
  }

  /** Seconds until the player respawns, or 0. For the HUD death screen. */
  get playerRespawnIn() {
    const p = this.game.player;
    if (!p) return 0;
    for (let i = 0; i < this._respawns.length; i++) {
      if (this._respawns[i].entity === p) return Math.max(0, this._respawns[i].at - this.elapsed);
    }
    return 0;
  }

  get playerCanRespawnNow() {
    const p = this.game.player;
    if (!p) return false;
    for (let i = 0; i < this._respawns.length; i++) {
      if (this._respawns[i].entity === p) return this.elapsed >= this._respawns[i].minAt;
    }
    return false;
  }

  // -------------------------------------------------------- protection / rules

  /** True while the entity still has spawn protection. Ballistics should check this. */
  isProtected(entity) {
    if (!entity) return false;
    const end = this._protect.get(entity.id);
    if (end === undefined) return false;
    if (this.elapsed >= end) { this._protect.delete(entity.id); return false; }
    return true;
  }

  /** Multiplier ballistics can fold straight into the damage it is about to apply. */
  damageMultiplierFor(entity) { return this.isProtected(entity) ? 0 : 1; }

  /**
   * Explicitly drop protection (fired a weapon, threw a grenade, took an objective).
   *
   * The firing case is NOT handled here — `_onShot` already deletes the entry inline, and
   * has to, because it resolves streak hardware back to its operator first. This method is
   * the public entry point for the other cases and for tests. It has no callers in `src/`
   * today, which reads like dead code and is not: the behaviour its name describes is
   * implemented, just not through it.
   */
  clearProtection(entity) { if (entity) this._protect.delete(entity.id); }

  /** Pre-round freeze + death + post-match lockout, in one question. */
  canFire(entity) {
    if (this.phase !== 'live') return false;
    if (entity && entity.alive === false) return false;
    // A mode with its own round phases (Bomb: freeze and roundEnd both lock weapons, and
    // the eliminated never fire — bomb-rules §3, §8) gets the final say.
    if (this.mode.canFire && this.mode.canFire(this, entity) === false) return false;
    return true;
  }

  get frozen() { return this.phase !== 'live'; }

  uavActive(team) { return this.killstreaks.uavActive(team); }

  notice(text, sub = '', duration = 1.6) {
    this.game.bus.emit('notice', { text, sub, duration });
  }

  // ------------------------------------------------------ external entry points

  /** HUD/scoreboard read this for the mode caption. */
  get modeName() { return this.mode?.name || ''; }

  /** Scoreboard column headers. */
  get teamNames() { return TEAM_NAMES; }

  /** HUD death-screen countdown length. */
  get respawnDelay() { return PLAYER_RESPAWN; }

  /**
   * Player.js routes the `killstreak` action here (it probes useKillstreak /
   * activateKillstreak / triggerKillstreak, so all three exist).
   */
  useKillstreak(entity = this.game.player) {
    if (!entity?.alive || this.phase !== 'live') return false;
    const ok = this.killstreaks.activate(entity);
    if (!ok && entity.isPlayer) this.game.present.play('dryfire', { volume: 0.5 });
    return ok;
  }

  activateKillstreak(entity) { return this.useKillstreak(entity); }
  triggerKillstreak(entity) { return this.useKillstreak(entity); }

  /**
   * Player.die() reports here instead of emitting `kill` (ballistics does not emit it
   * and the player must not duplicate the bots' path). We raise the canonical event so
   * every listener — killfeed, AI, our own book — sees exactly one shape of death.
   */
  onPlayerDeath(entity, info = {}) {
    const victim = entity || this.game.player;
    if (!victim) return;
    const attacker = info?.attacker ?? null;
    this.game.bus.emit('kill', {
      victim,
      attacker,
      weaponId: info?.weaponId ?? null,
      headshot: !!info?.headshot || info?.hitPart === 'head',
      distance: attacker?.position ? attacker.position.distanceTo(victim.position) : 0,
    });
  }

  onEntityDeath(entity, info) { this.onPlayerDeath(entity, info); }
  reportDeath(entity, info) { this.onPlayerDeath(entity, info); }

  // -------------------------------------------------------------------- clock

  /**
   * Seconds of LIVE match time — frozen through the countdown and after the final
   * whistle, which is why it is its own clock and not `game.time`.
   *
   * Counted in whole ticks and multiplied out, never accumulated: spawn protection,
   * respawn deadlines, the death guard and the round timer are all comparisons against
   * this, and an accumulated float lands somewhere fractionally different depending on
   * how many additions got it there — which a replayed or rewound match must not do.
   */
  get elapsed() { return this._elapsedTicks * FIXED_DT; }

  get timeRemaining() {
    return Math.max(0, this.timeLimit - this.elapsed);
  }

  fixedUpdate(dt) {
    if (this.phase === 'idle' || this.phase === 'ended') return;

    if (this.phase === 'countdown') {
      this.countdown -= dt;
      const whole = Math.ceil(this.countdown);
      if (whole !== this._lastCountdownShown && whole > 0) {
        this._lastCountdownShown = whole;
        this.notice(String(whole), '', 0.9);
        this.game.present.play('uiClick', { volume: 0.5, rate: 1 + (3 - whole) * 0.12 });
      }
      if (this.countdown <= 0) {
        this.phase = 'live';
        this.notice('ENGAGE', this.mode.hudLabels?.objective || '', 1.2);
        this.game.present.play('matchStart', { volume: 0.7, rate: 1.25 });
      }
      // Everything below is live-only; hardware and modes stay frozen during the count.
      return;
    }

    this._elapsedTicks++;

    this._updateRespawns(dt);
    this.killstreaks.fixedUpdate(dt);
    this.mode.onTick?.(this, dt);
    this._checkEnd();
  }

  update(dtFrame) {
    if (this.phase === 'idle') return;
    this.killstreaks.update(dtFrame);
    this._pushHud(false);
  }

  _pushHud(force) {
    const hud = this.game.hud;
    if (!hud) return;
    const out = this.mode.hudScores ? this.mode.hudScores(this, this._hudScores) : this._hudScores;
    if (force || out[0] !== this._lastHudA || out[1] !== this._lastHudB) {
      this._lastHudA = out[0];
      this._lastHudB = out[1];
      hud.setScore?.(out[0], out[1]);
    }
    // A mode with its own clocks publishes them (Bomb: the bomb timer REPLACES the round
    // timer at plant — bomb-rules §3).
    const t = this.mode.hudTime
      ? this.mode.hudTime(this)
      : (this.phase === 'countdown' ? this.timeLimit : this.timeRemaining);
    const whole = Math.ceil(t);
    if (force || whole !== this._lastHudTime) {
      this._lastHudTime = whole;
      hud.setTimer?.(t);
    }
  }

  // ---------------------------------------------------------------- match end

  _checkEnd() {
    if (this.phase !== 'live') return;
    const res = this.mode.checkEnd?.(this);
    if (!res) return;
    this._end(res);
  }

  _end(res) {
    this.phase = 'ended';
    this._respawns.length = 0;

    const playerWon = this._didPlayerWin(res);
    const outcome = res.reason === 'draw' || res.winner === -1 ? 'draw' : (playerWon ? 'win' : 'loss');

    const result = {
      mode: this.modeId,
      modeName: this.mode.name,
      scores: [this.scores[0], this.scores[1]],
      killLimit: this.killLimit,
      reason: res.reason,
      // Always a team id: the after-action screen compares it against `player.team`.
      winner: res.winnerTeam >= 0 ? res.winnerTeam : (res.winnerEntity?.team ?? -1),
      winnerTeam: res.winnerTeam ?? -1,
      winnerEntity: res.winnerEntity ?? null,
      winnerName: this._winnerName(res),
      playerWon,
      outcome,
      duration: this.elapsed,
      // Snapshot: the live rows are pooled and will be rewritten by the next call.
      rows: this.getScoreboardRows().map((r) => ({ ...r })),
      moments: this.getBestMoments(),
      teamNames: TEAM_NAMES,
    };

    // The ruleset adds what only it knows (Bomb: the round log, the series record and the
    // objective evidence — bomb-rules §10). Before progression, so the payload the
    // `roundEnd`/`matchEnd` consumers see is the complete one.
    this.mode.decorateResult?.(this, result);

    // `match-result.md` §6.1: an aborted/no-contest match is "recorded and not aggregated"
    // — counters not applied, `matches` +0, no W/L/D. The ruleset says which outcomes those
    // are (`result.aggregate`); the referee is what makes it true, and until this line it
    // did not: `_awardProgression` ran unconditionally, so a match nobody finished banked a
    // completion bonus and a lifetime draw. §4.3 also fixes the per-player result at null
    // when there is no winner — `winnerTeam: null` means *no winner*, never *draw* (§4.0).
    if (result.aggregate === false) result.outcome = null;

    const prog = result.aggregate === false ? null : this._awardProgression(result.outcome);
    result.progression = prog;
    this.lastProgression = prog;
    this.result = result;

    // The end sequence is intentionally ordered: freeze and snapshot first, announce the
    // final result second, then Game.endMatch emits `matchEnd` and opens After Action.
    // Consumers that want a final-kill camera/announcer hook use `roundEnd`; persistence
    // and results consumers use the immutable `matchEnd` payload that follows it.
    this.game.bus.emit('roundEnd', result);

    this.notice(
      result.outcome === 'win' ? 'VICTORY'
        : result.outcome === 'draw' ? 'DRAW'
          // A no-contest is neither a defeat nor a stalemate; announcing DEFEAT for a match
          // that paid nothing tells the player they lost something they did not.
          : result.outcome === null ? 'NO CONTEST' : 'DEFEAT',
      result.winnerName ? `${result.winnerName} wins` : '',
      4,
    );
    this.game.present.play('matchEnd', { volume: 0.9 });
    this.mode.cleanup?.(this);

    // Game.endMatch() emits the canonical `matchEnd` with this payload.
    this.game.endMatch(result);
  }

  _didPlayerWin(res) {
    const player = this.game.player;
    if (!player) return false;
    return res.winnerTeam === player.team;
  }

  _winnerName(res) {
    if (res.winner === -1 || res.reason === 'draw') return '';
    if (res.winnerTeam >= 0) return TEAM_NAMES[res.winnerTeam] || `TEAM ${res.winnerTeam}`;
    return '';
  }

  _awardProgression(outcome) {
    const player = this.game.player;
    const st = player ? this._book.get(player.id) : null;
    if (!st) return null;
    const weapons = {};
    for (const [id, row] of this._playerWeapons) {
      weapons[id] = { kills: row.kills, headshots: row.headshots, shotsFired: row.shotsFired, shotsHit: row.shotsHit };
    }
    return progression.recordMatch({
      kills: st.kills,
      deaths: st.deaths,
      assists: st.assists,
      headshots: st.headshots,
      longshots: st.longshots,
      shotsFired: st.shotsFired,
      shotsHit: st.shotsHit,
      score: st.score,
      longestShot: st.longestShot,
      bestStreak: st.bestStreak,
      streaksEarned: st.streaksEarned,
      captures: st.captures,
      defends: st.defends,
      confirms: st.confirms,
      denies: st.denies,
      durationSec: this.elapsed,
      result: outcome,
      weapons,
    });
  }

  // -------------------------------------------------------------------- views

  /**
   * Scoreboard rows, sorted (score, then kills, then fewest deaths).
   * Rows are pooled objects — render them, do not retain them.
   */
  getScoreboardRows() {
    const rows = this._rows;
    rows.length = 0;
    let i = 0;
    for (const st of this._book.values()) {
      const e = st.entity;
      // Reuse the row object from the previous call — the scoreboard is held down for
      // seconds at a time and must not generate garbage every frame.
      let r = this._rowPool[i];
      if (!r) r = this._rowPool[i] = {};
      i++;
      r.id = st.id;
      r.name = st.name;
      r.isPlayer = st.isPlayer;
      r.team = e?.team ?? st.team;
      r.kills = st.kills;
      r.deaths = st.deaths;
      r.assists = st.assists;
      r.score = st.score;
      r.streak = st.streak;
      r.bestStreak = st.bestStreak;
      r.headshots = st.headshots;
      r.tier = st.tier;
      r.captures = st.captures;
      r.plants = st.plants;
      r.defuses = st.defuses;
      r.confirms = st.confirms;
      r.denies = st.denies;
      r.alive = !!e?.alive;
      r.kd = st.deaths > 0 ? st.kills / st.deaths : st.kills;
      r.accuracy = st.shotsFired > 0 ? st.shotsHit / st.shotsFired : 0;
      r.longestShot = st.longestShot;
      rows.push(r);
    }
    rows.sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);
    return rows;
  }

  /** The five highlights worth putting on the after-action screen. */
  getBestMoments(limit = 5) {
    const out = this._moments.slice();
    out.sort((a, b) => b.weight - a.weight);
    return out.slice(0, limit);
  }

  /**
   * Best shot of the match — the after-action screen reads `{ distance, name }`.
   * Built on demand (match end / scoreboard), never per frame.
   */
  get longestShot() {
    let best = null;
    for (const st of this._book.values()) {
      if (st.longestShot > 0 && (!best || st.longestShot > best.distance)) {
        best = { distance: st.longestShot, name: st.name, entity: st.entity };
      }
    }
    return best;
  }

  /** Convenience for the HUD: the player's own row. */
  getPlayerStats() {
    const p = this.game.player;
    return p ? this._book.get(p.id) || null : null;
  }

  dispose() {
    for (const u of this._unsub) u?.();
    this._unsub.length = 0;
    this.mode?.cleanup?.(this);
    // The rules list owns any prewarmed presentation resources it created.
    for (const m of this.modeList) m.dispose?.();
    this.killstreaks.dispose();
    this.spawner.dispose();
    this._book.clear();
    this._damageLog.clear();
    this._protect.clear();
    this._deathGuard.clear();
  }
}
