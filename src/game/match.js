import { MODES, MODE_LIST, getMode, DEFAULT_MODE, TEAM_NAMES, getWeaponDefs } from './modes.js';
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
};

export class Match {
  constructor(game) {
    this.game = game;

    this.modes = MODES;
    this.modeList = MODE_LIST;
    this.modeId = DEFAULT_MODE;
    this.mode = getMode(DEFAULT_MODE);
    this.modeState = {};

    /** Team scores. Index === team for team modes. */
    this.scores = [0, 0];
    this.phase = 'idle';        // 'idle' | 'countdown' | 'live' | 'ended'
    this._elapsedTicks = 0;
    this.timeLimit = 600;
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

    // Park every mode's objective rig in the scene now, hidden. This runs during boot,
    // one phase ahead of `Game._prewarmShaders()`, which force-shows the whole scene and
    // links everything in it — so an objective mesh that exists here never links a shader
    // program inside a gameplay frame later. Measured before this: the first DOMINATION
    // match of a session linked 2 programs and the first KILL CONFIRMED linked 1, all
    // after match start.
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
    const requested = opts.mode ?? this.modeId ?? DEFAULT_MODE;
    this.modeId = MODES[requested] ? requested : DEFAULT_MODE;
    this.mode = getMode(this.modeId);
    this.timeLimit = this.mode.timeLimit;
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
   * @param {{mode?:string, botCount?:number, difficulty?:string}} opts
   */
  begin(opts = {}) {
    const settings = this.game.settings;
    const requested = opts.mode ?? this.modeId ?? DEFAULT_MODE;
    this.modeId = MODES[requested] ? requested : DEFAULT_MODE;
    this.mode = getMode(this.modeId);
    this.modeState = {};
    this.botCount = Math.max(0, opts.botCount ?? settings?.get?.('botCount') ?? this.botCount);
    this.difficulty = opts.difficulty ?? settings?.get?.('difficulty') ?? this.difficulty;
    this.timeLimit = this.mode.timeLimit;

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

  /** Teams for team modes; unique per-entity ids for free-for-all. */
  _assignTeams() {
    const ents = this.game.entities;
    if (this.mode.teamBased) {
      this.playerTeam = 0;
      // BotManager has already dealt the roster into two sides and baked a model
      // colourway per bot. Only intervene if that split is actually wrong — a team
      // flip here would leave a bot wearing the other side's kit.
      let a = 0;
      let b = 0;
      let dirty = false;
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        if (e.isPlayer) { if (e.team !== 0) { e.team = 0; dirty = true; } a++; continue; }
        if (e.team !== 0 && e.team !== 1) { e.team = i % 2 === 0 ? 0 : 1; dirty = true; }
        (e.team === 1 ? b++ : a++);
      }
      if (dirty || Math.abs(a - b) > 1) this._rebalance();
    } else {
      // Everyone hostile. The player keeps team 0 so HUD colouring stays sane; bots
      // take unique ids from 2 upward. `areEnemies()` is the real authority here.
      this.playerTeam = 0;
      let t = 2;
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        e.team = e.isPlayer ? 0 : t++;
      }
    }
  }

  _rebalance() {
    if (!this.mode.teamBased) return;
    const ents = this.game.entities;
    let a = 0;
    let b = 0;
    for (let i = 0; i < ents.length; i++) (ents[i].team === 1 ? b++ : a++);
    while (Math.abs(a - b) > 1) {
      const from = a > b ? 0 : 1;
      const to = from === 0 ? 1 : 0;
      let moved = false;
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        if (e.isPlayer || e.team !== from) continue;
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
    const ents = this.game.entities;
    for (let i = 0; i < ents.length; i++) if (ents[i] === entity) return true;
    return false;
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
    if (!this.mode.teamBased) return true;
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

  /** Public: modes award team score through here. */
  addTeamScore(team, points) {
    const t = team === 1 ? 1 : 0;
    this.scores[t] = Math.max(0, this.scores[t] + points);
  }

  // ----------------------------------------------------------------- respawns

  _queueRespawn(entity, killer) {
    const isPlayer = !!entity.isPlayer;
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
        killer: killer && killer !== entity ? killer : null,
        killerName: killer ? (this._book.get(killer.id)?.name || killer.name || '') : '',
        killerHealth: killer?.health ?? 0,
        respawnIn: delay,
      });
    }
  }

  _updateRespawns(dt) {
    if (this._respawns.length === 0) return;
    const now = this.elapsed;
    const input = this.game.input;
    // Scored spawning is the single most expensive thing this class does (a full
    // candidate sweep with LOS marches per point). Never run more than
    // MAX_SPAWNS_PER_STEP of them on one 1/120 s step, whatever the deadlines say.
    let spawned = 0;
    for (let i = this._respawns.length - 1; i >= 0; i--) {
      const r = this._respawns[i];
      const e = r.entity;
      if (!e) { this._respawns.splice(i, 1); continue; }
      let go = now >= r.at;
      if (!go && e.isPlayer && now >= r.minAt && input?.firePressed) go = true;
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
      if (e.isPlayer) this.game.present.deathScreen(null);
    }
  }

  /** Keep the sides even as bots cycle through; only ever moves a dead bot. */
  _rebalanceOnRespawn(bot) {
    if (!this.mode.teamBased) return;
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

  /** Explicitly drop protection (fired a weapon, threw a grenade, took an objective). */
  clearProtection(entity) { if (entity) this._protect.delete(entity.id); }

  /** Pre-round freeze + death + post-match lockout, in one question. */
  canFire(entity) {
    if (this.phase !== 'live') return false;
    if (entity && entity.alive === false) return false;
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
    const t = this.phase === 'countdown' ? this.timeLimit : this.timeRemaining;
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
      reason: res.reason,
      // Always a team id: the after-action screen compares it against `player.team`.
      // In free-for-all every entity carries a unique team, so this still resolves.
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

    const prog = this._awardProgression(outcome);
    result.progression = prog;
    this.lastProgression = prog;
    this.result = result;

    this.notice(
      outcome === 'win' ? 'VICTORY' : outcome === 'draw' ? 'DRAW' : 'DEFEAT',
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
    if (res.winnerEntity) return res.winnerEntity === player;
    if (this.mode.teamBased) return res.winnerTeam === player.team;
    return res.winner === player;
  }

  _winnerName(res) {
    if (res.winner === -1 || res.reason === 'draw') return '';
    if (res.winnerEntity) return this._book.get(res.winnerEntity.id)?.name || res.winnerEntity.name || '';
    if (this.mode.teamBased && res.winnerTeam >= 0) return TEAM_NAMES[res.winnerTeam] || `TEAM ${res.winnerTeam}`;
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
    // Modes are singletons and each keeps its own lazily-built GPU rig, so every mode
    // that ever ran this session holds one — not just the one that happens to be
    // selected now.
    for (const m of this.modeList) m.dispose?.();
    this.killstreaks.dispose();
    this.spawner.dispose();
    this._book.clear();
    this._damageLog.clear();
    this._protect.clear();
    this._deathGuard.clear();
  }
}
