import * as THREE from 'three';
import { Bot, DIFFICULTY, PERSONALITY_NAMES } from './bot.js';
import { disposeBotRigs } from './botModel.js';
import { BOT_NAMES } from './botNames.js';
import { clamp } from '../core/mathUtils.js';

/**
 * BotManager — roster, respawns, and the frame budget.
 *
 * The expensive part of AI is not the state machine, it is the raycasts: line
 * of sight and A*. Both are throttled here rather than inside Bot so the cost
 * is global and predictable:
 *
 *   • think() (senses + LOS + transitions) runs on a per-bot stride of 8 fixed
 *     steps out of combat and 4 in combat, phase-offset by roster index. With
 *     12 bots and stride 8 that is ~1.5 bots thinking per fixed step. The pass
 *     itself runs at most ONCE per rendered frame (see fixedUpdate).
 *   • findPath() is capped at PATH_BUDGET searches per RENDERED FRAME, served
 *     round-robin so no bot can starve. Per-frame, not per-step: a frame only ever
 *     takes several substeps when it is already late, so a per-step budget scaled
 *     the AI cost up by 6x on exactly the frames that had no room for it.
 *   • fixedUpdate() (steering + one world.move) runs for every bot every step;
 *     it is the same per-entity cost the player pays.
 *
 * Measured shape of the budget at 120 fps (1 substep/frame, 12 bots):
 *   12 x world.move + ~1.5 x (LOS pair) + <=2 x A* ≈ well under 1.5 ms.
 */

/**
 * Pure safety net. Match owns bot respawns and schedules them at 3.4 s +/- 0.4 s of
 * jitter, capped at two scored spawns per fixed step, precisely so a cluster of deaths
 * does not become a cluster of spawn searches. This timer must therefore sit clear of the
 * TOP of that window (3.8 s): at the old 3.5 s it pre-empted the late half of the jitter
 * and re-clustered exactly the spawns the jitter had just spread out — every bot the
 * jitter pushed past 3.5 s came back on the one step where the fallback fired.
 */
const RESPAWN_DELAY = 4.0;
// One A* per RENDERED FRAME. At 120 fps that serves 120 searches/s against a demand of
// roughly 10/s for 12 bots, and it hard-bounds the worst frame: a single cross-layer
// search (~1.2 ms) can never be doubled up, not even on a frame that took six substeps.
const PATH_BUDGET = 1;
// Mirrors MAX_SUBSTEPS in core/game.js. Only used to recognise a headless harness that
// drives _fixedUpdate() directly and therefore never advances `game.frame`.
const MAX_STEPS_PER_FRAME = 6;
const MAX_BOTS = 24;
// Mirrors MAX_SPAWNS_PER_STEP in game/match.js.
const MAX_FALLBACK_SPAWNS_PER_STEP = 2;

export const TEAM_COLORS = [new THREE.Color(0xd9b45a), new THREE.Color(0xe0453f)];

const FFA_MODES = new Set(['ffa', 'dm', 'freeforall', 'free-for-all', 'deathmatch']);

// --- team blackboard tuning
const CONTACT_MEMORY = 9;      // s a called contact keeps pulling the sweep
const SHARE_RADIUS = 78;       // m a contact call carries (the map is 86 m across)
const POI_SPACING = 10.5;      // m between sweep lattice points
const POI_MAX = 160;
const POI_REVISIT = 34;        // s before a swept point is interesting again

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/**
 * Everything one team knows collectively.
 *
 * Two jobs. (1) Contact: where an enemy was last actually seen by ANY member,
 * how confident and how fresh — this is what a bot pushes toward when its own
 * eyes have nothing. (2) Sweep bookkeeping: per point-of-interest, how contested
 * it is for this team, when the team last covered it, and who is currently
 * walking to it. The claim array is the anti-funnel — two bots cannot pick the
 * same lane, so the squad fans out instead of forming a conga line.
 *
 * Everything is typed arrays sized once at reset. Nothing here allocates.
 */
class TeamBoard {
  constructor() {
    this.contact = new THREE.Vector3();
    this.contactEnemy = null;
    this.contactTime = -999;
    this.contactStrength = 0;
    this.weight = null;   // Float32Array — contested-ness of each POI, 0..1
    this.visit = null;    // Float32Array — game.time this POI was last taken
    this.claim = null;    // Int32Array   — entity id walking there, or -1
  }

  resize(n) {
    if (!this.weight || this.weight.length !== n) {
      this.weight = new Float32Array(n);
      this.visit = new Float32Array(n);
      this.claim = new Int32Array(n);
    }
    this.visit.fill(-999);
    this.claim.fill(-1);
    this.contactEnemy = null;
    this.contactTime = -999;
    this.contactStrength = 0;
  }
}

export class BotManager {
  constructor(game) {
    this.game = game;
    /** @type {Bot[]} */
    this.bots = [];
    this.ffa = false;
    this.difficulty = 'regular';

    this._unsub = [];
    this._tick = 0;
    this._pathCursor = 0;
    // Per-rendered-frame budget bookkeeping — see fixedUpdate().
    this._budgetFrame = -1;
    this._stepsThisFrame = 0;
    this._pathsThisFrame = 0;
    this._thinkTick = 0;
    this._namePool = [];
    this._nameCursor = 0;
    this._spawnScratch = [];
    this.stats = { thinkMs: 0, botCount: 0, pathsPerSec: 0 };
    this._pathCount = 0;
    this._statTimer = 0;

    // --- team awareness
    /** @type {THREE.Vector3[]} */
    this.poi = [];
    this.poiCount = 0;
    this.boards = [new TeamBoard(), new TeamBoard()];
  }

  async init() {
    const bus = this.game.bus;
    if (bus) {
      this._unsub.push(bus.on('shot', (p) => this._onShot(p)));
      this._unsub.push(bus.on('explosion', (p) => this._onExplosion(p)));
      this._unsub.push(bus.on('kill', (p) => this._onKill(p)));
    }
  }

  // ------------------------------------------------------------------ roster

  /**
   * Build the roster. Deliberately does NOT place anyone: `Match.begin()` runs
   * the fully-scored spawner (LOS to enemies, recent-use decay, died-here
   * penalties) over every entity immediately after this, and having two systems
   * place bots meant the number of spawn scorings — and therefore the number of
   * RNG draws — depended on whether the PREVIOUS match had left them alive. Same
   * seed, different match. Match is the single placement authority; `_spawnBot`
   * below is for mid-match respawns only.
   */
  reset(opts = {}) {
    const game = this.game;
    const settings = game.settings;
    const count = clamp(Math.round(settings?.get('botCount') ?? 7), 0, MAX_BOTS);
    this.difficulty = DIFFICULTY[settings?.get('difficulty')] ? settings.get('difficulty') : 'regular';

    const mode = String(opts.mode ?? game.match?.mode ?? 'tdm').toLowerCase();
    this.ffa = FFA_MODES.has(mode);

    this._buildNamePool();
    this._buildSweepBoard();
    // A lobby should feel like people, not one bot copied N times: deal the four
    // temperaments round-robin from a random offset, so every match has a
    // different mix but always has all four represented. Drawn once, here, and
    // reused by setCount() so a later resize consumes no extra randomness.
    this._personaOffset = game.rng.int(PERSONALITY_NAMES.length);

    this._resizeRoster(count);
    this._configureRoster();
    this._tick = 0;
    this._thinkTick = 0;
    this._budgetFrame = -1;
    this._stepsThisFrame = 0;
    this._pathsThisFrame = 0;
  }

  /**
   * Match tells us the roster size it booked. Idempotent, and consumes no RNG
   * beyond the name pool cursor, so calling it right after reset() with the same
   * number is free.
   */
  setCount(n) {
    const count = clamp(Math.round(n ?? this.bots.length), 0, MAX_BOTS);
    if (count === this.bots.length) return;
    this._resizeRoster(count);
    this._configureRoster();
  }

  /** Teams, names, colours, temperament, difficulty — everything but position. */
  _configureRoster() {
    const game = this.game;
    const playerTeam = game.player?.team ?? 0;
    const offset = this._personaOffset ?? 0;
    this._nameCursor = 0;
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      b.team = this._teamFor(i, this.bots.length, playerTeam);
      b.name = this._nextName();
      b.color = TEAM_COLORS[b.team];
      b.thinkPhase = i % 8;
      b.thinkStride = 8;
      b.setPersonality(PERSONALITY_NAMES[(i + offset) % PERSONALITY_NAMES.length]);
      b._poiClaim = -1;
      b.stats.kills = 0;
      b.stats.deaths = 0;
      b.stats.score = 0;
      b.stats.streak = 0;
      b.configure(this.difficulty, this.ffa);
      // The model's colourway is baked per team, so a team change needs a new one.
      b.ensureTeamModel();
      b.deactivate();
    }
    this.stats.botCount = this.bots.length;
  }

  // ------------------------------------------------------------ team awareness

  /**
   * Build the sweep graph: a coarse lattice of walkable ground points covering
   * the whole map, plus every spawn point (spawns are where players actually
   * are, so they are always worth clearing). Then score each point per team by
   * how contested it is — closeness to the enemy team's spawn anchor, weighted
   * with closeness to the middle of the map.
   *
   * Runs once per match. Cost is one nav lattice walk, ~0.3 ms.
   */
  _buildSweepBoard() {
    const nav = this.game.nav;
    const world = this.game.world;
    const poi = this.poi;
    let n = nav?.samplePoints ? nav.samplePoints(POI_SPACING, poi, POI_MAX) : 0;
    // The nav bake is async; if the roster reset beat it, remember to rebuild
    // once the grid exists rather than sweeping spawn points forever.
    this._navPoi = n > 0;

    const sp = world?.spawnPoints;
    if (sp) {
      for (let i = 0; i < sp.length && n < POI_MAX; i++) {
        const p = sp[i]?.position;
        if (!p) continue;
        let dup = false;
        for (let k = 0; k < n; k++) {
          if (poi[k].distanceToSquared(p) < 20) { dup = true; break; }
        }
        if (dup) continue;
        if (!poi[n]) poi[n] = new THREE.Vector3();
        poi[n].copy(p);
        n++;
      }
    }
    this.poiCount = n;
    this.boards[0].resize(n);
    this.boards[1].resize(n);
    if (n === 0) return;

    const bounds = world?.bounds;
    const cx = bounds ? (bounds.min.x + bounds.max.x) * 0.5 : 0;
    const cz = bounds ? (bounds.min.z + bounds.max.z) * 0.5 : 0;
    const span = bounds
      ? Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z)
      : 80;

    for (let t = 0; t < 2; t++) {
      // Where the OTHER side lives. In FFA there is no other side, so the whole
      // team weights toward the middle and the sweep stays map-wide.
      let sx = 0, sz = 0, en = 0;
      if (!this.ffa && sp) {
        for (let i = 0; i < sp.length; i++) {
          const s = sp[i];
          if (!s || s.team === t || s.team === -1 || s.team == null) continue;
          sx += s.position.x; sz += s.position.z; en++;
        }
      }
      const ex = en ? sx / en : cx;
      const ez = en ? sz / en : cz;
      const board = this.boards[t];
      for (let i = 0; i < n; i++) {
        const p = poi[i];
        const wEnemy = clamp(1 - Math.hypot(p.x - ex, p.z - ez) / (span * 0.85), 0, 1);
        const wCentre = clamp(1 - Math.hypot(p.x - cx, p.z - cz) / (span * 0.55), 0, 1);
        board.weight[i] = wEnemy * 0.58 + wCentre * 0.42;
      }
    }
  }

  /**
   * Choose this bot's next sweep leg. Scores every point of interest by:
   *   + how contested it is for this team (enemy half / middle of the map)
   *   + how close it is to the team's last radio contact, while that is fresh
   *   - travel distance (a hunt, not a marathon)
   *   - how recently the team already covered it
   *   - hard penalty if a teammate has claimed it  <- the anti-funnel
   *
   * Returns true and writes the point into `out`, or false if the board is empty.
   */
  pickSweepPoint(bot, out) {
    if (!this._navPoi && this.game.nav?.ready) this._buildSweepBoard();
    const n = this.poiCount;
    if (n === 0 || !out) return false;
    const board = this.boards[bot.team & 1];
    const now = this.game.time;
    const rng = this.game.rng;
    const sweep = bot.persona.sweep * (bot.cfg.sweepUrgency ?? 1);
    const hot = now - board.contactTime < CONTACT_MEMORY ? board.contactStrength : 0;

    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = this.poi[i];
      const d = Math.hypot(p.x - bot.position.x, p.z - bot.position.z);
      if (d < 7) continue;                       // already standing there
      // Contested-ness has to beat the travel penalty outright, otherwise the
      // cheapest leg always wins and a team never leaves its own half — which
      // is how a "patrol" degenerates back into orbiting the spawn.
      let s = board.weight[i] * 34 * sweep - d * 0.22;
      if (hot > 0) {
        const dc = Math.hypot(p.x - board.contact.x, p.z - board.contact.z);
        s += 46 * hot * Math.exp(-dc / 20);
      }
      const age = now - board.visit[i];
      if (age < POI_REVISIT) s -= (POI_REVISIT - age) * 0.95;
      const claim = board.claim[i];
      if (claim >= 0 && claim !== bot.id) s -= 55;
      s += rng() * 12;
      if (s > bestScore) { bestScore = s; best = i; }
    }
    if (best < 0) return false;

    this.releaseSweepClaim(bot);
    board.claim[best] = bot.id;
    // Marked as visited on assignment, not on arrival: a teammate already
    // walking there means the team has that ground covered.
    board.visit[best] = now;
    bot._poiClaim = best;
    out.copy(this.poi[best]);
    return true;
  }

  releaseSweepClaim(bot) {
    const idx = bot._poiClaim;
    if (idx === undefined || idx < 0) return;
    const board = this.boards[bot.team & 1];
    if (board.claim && idx < board.claim.length && board.claim[idx] === bot.id) {
      board.claim[idx] = -1;
    }
    bot._poiClaim = -1;
  }

  /**
   * A bot has eyes on an enemy (or is being shot by one). Post it to the team
   * board and radio it to everyone in range.
   *
   * Deliberately NOT a wallhack: teammates receive a *point to walk to* with a
   * confidence, smeared by their difficulty's comms quality. They still have to
   * see the enemy themselves before they can shoot at them.
   */
  reportContact(bot, enemy, strength = 1) {
    if (!bot || !enemy || this.ffa) return;
    const board = this.boards[bot.team & 1];
    board.contact.copy(enemy.position);
    board.contactEnemy = enemy;
    board.contactTime = this.game.time;
    board.contactStrength = clamp(strength, 0, 1);

    const bots = this.bots;
    for (let i = 0; i < bots.length; i++) {
      const m = bots[i];
      if (m === bot || !m.alive || m.team !== bot.team) continue;
      const d = m.position.distanceTo(enemy.position);
      if (d > SHARE_RADIUS) continue;
      const s = clamp(strength * (0.35 + 0.65 * (1 - d / SHARE_RADIUS)), 0, 1);
      m.receiveContactCall(enemy.position, enemy, s);
    }
  }

  /** Freshest team contact, or null if it has gone cold. */
  teamContact(team) {
    const board = this.boards[team & 1];
    return this.game.time - board.contactTime < CONTACT_MEMORY ? board : null;
  }

  /**
   * Lane index for a bot converging on a contact: 0, -1, +1, -2, +2 ...
   * Derived from roster order among the teammates currently closing, so it is
   * stable, allocation-free and guarantees the squad approaches on a spread of
   * angles rather than all down the same sightline.
   */
  approachSlot(bot) {
    const bots = this.bots;
    let idx = 0;
    for (let i = 0; i < bots.length; i++) {
      const o = bots[i];
      if (o === bot) break;
      if (!o.alive || o.team !== bot.team) continue;
      if (o.state === 'pushOrFlank' || o.state === 'engage' || o.state === 'investigate') idx++;
    }
    const k = (idx + 1) >> 1;
    return (idx & 1) ? -k : k;
  }

  _teamFor(index, total, playerTeam) {
    if (this.ffa) return 1;
    // Split evenly, with the enemy side taking the odd bot so the player's
    // squad is never the larger one.
    const friendly = Math.floor(total / 2);
    return index < friendly ? (playerTeam === 0 ? 0 : 1) : (playerTeam === 0 ? 1 : 0);
  }

  _resizeRoster(count) {
    while (this.bots.length > count) {
      const b = this.bots.pop();
      b.dispose();
    }
    while (this.bots.length < count) {
      this.bots.push(new Bot(this.game, 1, 'BOT'));
    }
  }

  _buildNamePool() {
    const rng = this.game.rng;
    const pool = this._namePool;
    pool.length = 0;
    for (let i = 0; i < BOT_NAMES.length; i++) pool.push(BOT_NAMES[i]);
    // Fisher-Yates with the seeded RNG so a replayed seed gets the same lobby.
    for (let i = pool.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
    }
    this._nameCursor = 0;
  }

  _nextName() {
    const pool = this._namePool;
    if (!pool.length) return 'BOT';
    const n = pool[this._nameCursor % pool.length];
    this._nameCursor++;
    return this._nameCursor > pool.length ? `${n}-${this._nameCursor - pool.length}` : n;
  }

  // ------------------------------------------------------------------ spawns

  _spawnBot(bot) {
    // Match owns respawn timing and runs the fully-scored spawner (LOS to enemies,
    // recent-use decay, died-here penalties). If it already put this bot back in the
    // world, do not spawn it a second time.
    if (bot.alive) return;
    const spawner = this.game.match?.spawner;
    if (spawner?.spawnEntity) {
      spawner.spawnEntity(bot);
      if (bot.alive) { bot._lastThinkTime = this.game.time; return; }
    }

    const sp = this._chooseSpawnPoint(bot);
    if (sp) {
      bot.spawn(sp.position, sp.yaw ?? 0);
    } else {
      const nav = this.game.nav;
      const b = this.game.world?.bounds;
      _v1.set(
        b ? (b.min.x + b.max.x) * 0.5 : 0,
        b ? b.min.y : 0,
        b ? (b.min.z + b.max.z) * 0.5 : 0,
      );
      const p = nav?.randomPointNear?.(_v1, 25, _v2) || _v1;
      bot.spawn(p, this.game.rng.range(-Math.PI, Math.PI));
    }
    bot._lastThinkTime = this.game.time;
  }

  /**
   * Pick the spawn point that is furthest from live enemies, heavily penalising
   * any point an enemy can currently see. Scored, not random, so bots do not
   * materialise in someone's crosshair.
   */
  _chooseSpawnPoint(bot) {
    const world = this.game.world;
    const points = world?.spawnPoints;
    if (!points || points.length === 0) return null;

    const rng = this.game.rng;
    const ents = this.game.entities;
    // Snapshot the hostile list — game.entities returns a shared array.
    const hostiles = this._spawnScratch;
    hostiles.length = 0;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e !== bot && e.alive && (this.ffa ? e !== bot : e.team !== bot.team)) hostiles.push(e);
    }

    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!p || !p.position) continue;
      if (!this.ffa && p.team !== -1 && p.team !== undefined && p.team !== bot.team) continue;

      let nearest = Infinity;
      let nearestEnt = null;
      for (let k = 0; k < hostiles.length; k++) {
        const d = hostiles[k].position.distanceTo(p.position);
        if (d < nearest) { nearest = d; nearestEnt = hostiles[k]; }
      }
      if (nearest === Infinity) nearest = 60;

      let score = Math.min(nearest, 60) + rng() * 7;
      // One LOS probe against the closest threat only — respawns are rare, but
      // this still needs to stay off the hot path.
      if (nearestEnt && nearest < 45 && world.losClear) {
        _v1.set(p.position.x, p.position.y + 1.5, p.position.z);
        if (nearestEnt.getEyePosition) nearestEnt.getEyePosition(_v2);
        else _v2.copy(nearestEnt.position).y += 1.6;
        if (world.losClear(_v1, _v2)) score -= 55;
      }
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  // -------------------------------------------------------------- simulation

  fixedUpdate(dt) {
    const game = this.game;
    const bots = this.bots;
    if (bots.length === 0) return;
    const debug = game.debug;
    const t0 = debug ? performance.now() : 0;

    const tick = ++this._tick;
    const now = game.time;

    // ---- the frame budget -----------------------------------------------------
    //
    // think() and A* are budgeted per RENDERED FRAME, not per fixed step. The engine
    // takes up to MAX_SUBSTEPS=6 substeps in one frame, and it only ever takes more
    // than one when that frame is ALREADY LATE — so a per-step budget multiplied the
    // most expensive AI work by up to 6x at exactly the moment it had to shrink. That
    // is what turned one dropped frame into a visible multi-frame stutter (measured
    // ~7.2 ms of A* on a 6-substep frame against ~1.2 ms on a normal one).
    //
    // `game.frame` identifies the frame. The offline harnesses in scripts/ drive
    // `game._fixedUpdate()` in a tight loop with no rAF at all, so `frame` never
    // advances there; after MAX_STEPS_PER_FRAME steps carrying the same frame id we
    // re-arm and treat it as a new frame. The real loop can never exceed that count,
    // so the fallback is inert in the game and keeps the harnesses honest.
    const frame = game.frame;
    let firstStepOfFrame = false;
    if (frame !== this._budgetFrame || this._stepsThisFrame >= MAX_STEPS_PER_FRAME) {
      this._budgetFrame = frame;
      this._stepsThisFrame = 0;
      this._pathsThisFrame = 0;
      firstStepOfFrame = true;
    }
    this._stepsThisFrame++;

    // 1) staggered thinking + respawn timers
    //
    // The think pass runs once per frame. A bot is due when its stride boundary falls
    // anywhere in the ticks since the previous pass, so the stride still means "every
    // N fixed steps" and no phase can starve — a 6-substep frame just collapses the six
    // opportunities into the single think() the bot would have wanted anyway.
    const prevTick = this._thinkTick;
    if (firstStepOfFrame) this._thinkTick = tick;
    // Same ceiling Match applies: a scored spawn is the most expensive thing either
    // class does, so the safety net must never turn into a burst of its own.
    let fallbackSpawns = 0;
    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];
      if (!b.alive) {
        if (fallbackSpawns >= MAX_FALLBACK_SPAWNS_PER_STEP) continue;
        // Never placed at all: Match owns the initial placement, so only step in
        // as a safety net if it has not done so a second into the match.
        if (!b._everSpawned) { if (now > 1.5) { this._spawnBot(b); fallbackSpawns++; } continue; }
        if (now - b.deathTime >= RESPAWN_DELAY) { this._spawnBot(b); fallbackSpawns++; }
        continue;
      }
      if (!firstStepOfFrame) continue;
      const stride = b.thinkStride || 8;
      const ph = b.thinkPhase;
      if (Math.floor((tick + ph) / stride) !== Math.floor((prevTick + ph) / stride)) {
        const last = b._lastThinkTime ?? now;
        b._lastThinkTime = now;
        b.think(clamp(now - last, dt, 0.25));
      }
    }

    // 2) global A* budget, round-robin so nobody starves
    for (let n = 0; n < bots.length && this._pathsThisFrame < PATH_BUDGET; n++) {
      const b = bots[this._pathCursor % bots.length];
      this._pathCursor++;
      if (b.alive && b.pathPending) {
        b.servicePath();
        this._pathsThisFrame++;
        this._pathCount++;
      }
    }

    // 3) cheap per-step simulation for everyone
    for (let i = 0; i < bots.length; i++) bots[i].fixedUpdate(dt);

    if (debug) {
      this.stats.thinkMs = performance.now() - t0;
      this._statTimer += dt;
      if (this._statTimer >= 1) {
        this.stats.pathsPerSec = this._pathCount / this._statTimer;
        this._pathCount = 0;
        this._statTimer = 0;
      }
    }
  }

  update(dtFrame) {
    const bots = this.bots;
    for (let i = 0; i < bots.length; i++) bots[i].update(dtFrame);
  }

  // ------------------------------------------------------------------ events

  _onShot(p) {
    if (!p) return;
    const shooter = p.shooter;
    // Tell the bot its WeaponInstance already ran ballistics for this trigger
    // pull, so it does not fire a duplicate bullet.
    if (shooter && shooter.isPlayer === false && typeof shooter.noteExternalShot === 'function') {
      shooter.noteExternalShot();
    }
    const origin = p.origin;
    if (!origin) return;
    this.game.nav?.addDanger?.(origin, 0.6, 6);
    const bots = this.bots;
    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];
      if (!b.alive || b === shooter) continue;
      b.onHeard(origin, 'shot', shooter ? b.isEnemy(shooter) : true);
    }
  }

  _onExplosion(p) {
    if (!p || !p.point) return;
    this.game.nav?.addDanger?.(p.point, 2.5, Math.max(6, (p.radius ?? 5) * 1.6));
    const bots = this.bots;
    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];
      if (!b.alive) continue;
      b.onHeard(p.point, 'explosion', true);
    }
  }

  _onKill(p) {
    if (!p || !p.victim) return;
    const bots = this.bots;
    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];
      if (!b.alive || b.target !== p.victim) continue;
      b.forgetTarget();
      // Take a beat and relocate — standing where you just traded is how you die.
      if (b.state === 'engage' || b.state === 'takeCover') b.setState('reposition');
    }
  }

  // ------------------------------------------------------------------- misc

  /** Live bots on a team (or all live bots if `team` is omitted). */
  aliveCount(team) {
    let n = 0;
    for (const b of this.bots) {
      if (!b.alive) continue;
      if (team === undefined || b.team === team) n++;
    }
    return n;
  }

  setDifficulty(name) {
    if (!DIFFICULTY[name]) return;
    this.difficulty = name;
    for (const b of this.bots) b.configure(name, this.ffa);
  }

  dispose() {
    for (const un of this._unsub) { try { un(); } catch { /* already gone */ } }
    this._unsub.length = 0;
    for (const b of this.bots) b.dispose();
    this.bots.length = 0;
    disposeBotRigs();
  }
}

export default BotManager;
