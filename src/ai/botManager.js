import * as THREE from 'three';
import { Bot, DIFFICULTY, PERSONALITY_NAMES } from './bot.js';
import { disposeBotRigs } from './botModel.js';
import { BOT_NAMES } from './botNames.js';
import { clamp } from '../core/mathUtils.js';
import { createRNG, mixSeed } from '../core/rng.js';

/**
 * BotManager — roster, respawns, and the tick budget.
 *
 * The expensive part of AI is not the state machine, it is the raycasts: line
 * of sight and A*. Both are throttled here rather than inside Bot so the cost
 * is global and predictable:
 *
 *   • think() (senses + LOS + transitions) runs on a per-bot stride of 8 fixed
 *     steps out of combat and 4 in combat, phase-offset by roster index. With
 *     12 bots and stride 8 that is ~1.5 bots thinking per fixed step, and the
 *     phase offsets spread them across the stride rather than bunching them.
 *   • findPath() is capped at PATH_BUDGET searches every PATH_INTERVAL ticks,
 *     served round-robin so no bot can starve.
 *   • fixedUpdate() (steering + one world.move) runs for every bot every step;
 *     it is the same per-entity cost the player pays.
 *
 * Everything here is budgeted on the SIMULATION clock, never on `game.frame`.
 * Keying AI to a render counter makes bot behaviour a function of frame rate and
 * leaves a headless server — which has no frames — with no cadence at all.
 *
 * Measured shape of the budget at 120 Hz (12 bots):
 *   12 x world.move + ~1.5 x (LOS pair) + <=1 x A* ≈ well under 1.5 ms.
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
// One A* every PATH_INTERVAL ticks: 60 searches/s at the 120 Hz fixed step, against a
// demand of roughly 10/s for 12 bots, so the round-robin still clears its queue with
// five times the headroom. The old budget was per RENDERED FRAME, which meant it
// delivered 60/s on a 60 fps client and 144/s on a 144 Hz one — the AI literally got
// smarter on better hardware. Keying it to the simulation clock costs a 144 Hz client
// some of that surplus and buys a bot roster that behaves identically everywhere,
// including on a server with no frames at all.
const PATH_BUDGET = 1;
const PATH_INTERVAL = 2;
const MAX_BOTS = 24;
// Mirrors MAX_SPAWNS_PER_STEP in game/match.js.
const MAX_FALLBACK_SPAWNS_PER_STEP = 2;

export const TEAM_COLORS = [new THREE.Color(0xd9b45a), new THREE.Color(0xe0453f)];

// --- team blackboard tuning
const CONTACT_MEMORY = 9;      // s a called contact keeps pulling the sweep
const SHARE_RADIUS = 78;       // m a contact call carries (the map is 86 m across)
const POI_SPACING = 10.5;      // m between sweep lattice points
const POI_MAX = 160;
const POI_REVISIT = 34;        // s before a swept point is interesting again

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();

const OBJECTIVE_LOG_MAX = 512;
const OFFGRAPH_LOG_MAX = 256;

function objectiveCentre(box, out) {
  return out.set(
    (box.min.x + box.max.x) * 0.5,
    box.min.y,
    (box.min.z + box.max.z) * 0.5,
  );
}

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
    this.difficulty = 'regular';

    this._unsub = [];
    this._tick = 0;
    this._pathCursor = 0;
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

    // Bounded, deterministic evidence for H3.3. These rows describe AI intent only;
    // BombRules.events remains the authority for objective completion.
    this.objectiveLog = [];

    /**
     * Bounded ledger of `Bot._recoverOffGraph` relocations, kept HERE rather than only on
     * the bot because the number that matters is a roster-wide rate: one bot stranded once
     * is geometry the bake does not describe, the same bot stranded ten times is a pocket
     * the AI keeps walking back into. `scripts/bottest.mjs` asserts on both.
     */
    this.offGraphLog = [];
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
    // The A* round-robin cursor is match state, not manager state. Left running, the
    // first match of a session served paths in a different order from every match after
    // it — same seed, different bots — because the cursor carried its residue over.
    this._pathCursor = 0;
    this._pathCount = 0;
    this._statTimer = 0;
    this.objectiveLog.length = 0;
    this.offGraphLog.length = 0;
  }

  /**
   * Recorded by `Bot._recoverOffGraph` when it has had to lift a bot back onto the nav
   * graph. Position is the place the bot was STRANDED, not where it was put down: that is
   * the coordinate a map or bake fix needs, and averaging the landing points would hide it.
   */
  noteOffGraphRecovery(bot) {
    if (this.offGraphLog.length >= OFFGRAPH_LOG_MAX) return;
    this.offGraphLog.push({
      tick: this.game.match?._elapsedTicks ?? 0,
      botId: bot.id,
      x: bot.position.x,
      y: bot.position.y,
      z: bot.position.z,
    });
  }

  /**
   * Match tells us the roster size it booked. Idempotent: it early-returns when the
   * count already matches, which is what makes the call right after reset() free.
   *
   * It is NOT free when the count differs — `_configureRoster` re-derives every bot's
   * RNG stream from its slot index, so a mid-match resize rewinds each surviving bot's
   * draws to the start of its stream. That is deterministic, but it is a rewind; do not
   * call this mid-match expecting continuity.
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
      // Its own stream, derived from the match seed and roster slot. Sharing `game.rng`
      // made every bot's draws depend on how many draws the bots before it happened to
      // make that tick, so behaviour varied with think scheduling — and therefore with
      // frame rate. Independent streams are reproducible and individually snapshottable.
      b.rng = createRNG(mixSeed(game.matchSeed, i));
      b.setPersonality(PERSONALITY_NAMES[(i + offset) % PERSONALITY_NAMES.length]);
      b._poiClaim = -1;
      b.stats.kills = 0;
      b.stats.deaths = 0;
      b.stats.score = 0;
      b.stats.streak = 0;
      b.configure(this.difficulty);
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
      // Where the other team lives, so each squad sweeps toward contested ground.
      let sx = 0, sz = 0, en = 0;
      if (sp) {
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
    const rng = bot.rng;
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
    if (!bot || !enemy) return;
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
    // Split evenly, with the enemy side taking the odd bot so the player's
    // squad is never the larger one.
    const friendly = Math.floor(total / 2);
    return index < friendly ? (playerTeam === 0 ? 0 : 1) : (playerTeam === 0 ? 1 : 0);
  }

  _resizeRoster(count) {
    if (this.bots.length === count) return;
    while (this.bots.length > count) {
      const b = this.bots.pop();
      b.dispose();
    }
    while (this.bots.length < count) {
      this.bots.push(new Bot(this.game, 1, 'BOT'));
    }
    // `game.entityById` reindexes off this. `dispose()` reports separately.
    this.game.rosterChanged();
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

  /**
   * sector-interest.md §4.3 — population cap is per declared sector, enforced against
   * arrivals only ("refused outright... no queueing, no eviction"). Counts live bots
   * currently resolved into the sector the candidate spawn point would place this bot in;
   * `Match.spawner` picks the actual point, so this is necessarily an estimate keyed to
   * `_chooseSpawnPoint`'s own candidate, not a hard pre-check against every possible point.
   */
  _sectorAdmits(sectors, bot) {
    const sp = this._chooseSpawnPoint(bot);
    const pos = sp?.position;
    if (!pos) return true; // nothing to check against — do not block placement on this alone
    const sectorId = sectors.sectorOf(pos);
    if (!sectorId) return true;
    let count = 0;
    for (const b of this.bots) {
      if (b === bot || !b.alive) continue;
      if (sectors.sectorOf(b.position) === sectorId) count++;
    }
    return sectors.canAdmit(sectorId, count);
  }

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
      const p = nav?.randomPointNear?.(_v1, 25, _v2, bot.rng) || _v1;
      bot.spawn(p, bot.rng.range(-Math.PI, Math.PI));
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

    const rng = bot.rng;
    const ents = this.game.entities;
    // Snapshot the hostile list — game.entities returns a shared array.
    const hostiles = this._spawnScratch;
    hostiles.length = 0;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e !== bot && e.alive && e.team !== bot.team) hostiles.push(e);
    }

    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (!p || !p.position) continue;
      if (p.team !== -1 && p.team !== undefined && p.team !== bot.team) continue;

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

    // ---- the budget -----------------------------------------------------------
    //
    // think() and A* are budgeted per TICK. They used to be budgeted per rendered
    // frame, keyed off `game.frame`, for a real reason: the engine takes up to
    // MAX_SUBSTEPS=6 substeps in one frame and only ever takes more than one when that
    // frame is ALREADY LATE, so a naive per-step budget multiplied the most expensive
    // AI work by 6 at exactly the moment it had to shrink (measured ~7.2 ms of A* on a
    // 6-substep frame against ~1.2 ms on a normal one).
    //
    // But keying anything in the simulation to a RENDER counter makes bot behaviour a
    // function of frame rate: two clients at 60 and 144 fps collapse a different number
    // of ticks into each think pass, so the same seed produces different bots. A
    // headless server has no frames at all. That is fatal for an authoritative
    // simulation, and no re-arm fallback fixes it — it just invents a third cadence.
    //
    // Evaluating each bot's stride per tick is a straight win for think(): a bot with
    // stride 8 thinks every 8 ticks whatever the frame rate, and because the phases are
    // spread over the stride only a fraction of the roster thinks on any one tick —
    // where the old pass fired every due bot on the first step of a frame, which is
    // where the burst came from in the first place.
    //
    // The A* budget is an honest trade, not a win. PATH_BUDGET searches every
    // PATH_INTERVAL ticks cannot bound cost per FRAME, because the sim does not know
    // what a frame is — a late 6-substep frame now carries up to 3 searches (~3.6 ms)
    // where the old per-frame cap guaranteed 1 (~1.2 ms). That is the price of a
    // simulation that runs identically on a server, and it is bounded: MAX_SUBSTEPS
    // caps the burst at 3, and `game.js` drops the backlog rather than spiralling.

    // 1) staggered thinking + respawn timers
    //
    // Same ceiling Match applies: a scored spawn is the most expensive thing either
    // class does, so the safety net must never turn into a burst of its own.
    const sectors = game.sectorInterest?.hasSectors() ? game.sectorInterest : null;
    let fallbackSpawns = 0;
    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];
      if (!b.alive) {
        // The fallback is only a placement safety net; it is not a second respawn
        // authority. Bomb explicitly forbids respawn after the warmup. Match begins each
        // new round by placing connected actors itself, so respecting the mode here cannot
        // strand a legal round spawn and prevents eliminated bots reappearing mid-round.
        if (game.match?.mode?.allowRespawn?.(game.match, b) === false) continue;
        if (fallbackSpawns >= MAX_FALLBACK_SPAWNS_PER_STEP) continue;
        // sector-interest.md §4.3 overflow rule — refused outright, no queueing, no
        // eviction. A bot the sector cannot admit stays dead this tick and is retried
        // (via the same respawn-delay/fallback path) once population frees up.
        if (sectors && !this._sectorAdmits(sectors, b)) continue;
        // Never placed at all: Match owns the initial placement, so only step in
        // as a safety net if it has not done so a second into the match.
        if (!b._everSpawned) { if (now > 1.5) { this._spawnBot(b); fallbackSpawns++; } continue; }
        if (now - b.deathTime >= RESPAWN_DELAY) { this._spawnBot(b); fallbackSpawns++; }
        continue;
      }
      // sector-interest.md §4.1/§4.3 — a `dormant` sector's AI gets zero think ticks; a
      // `warming` sector's stride is doubled relative to its configured base. A bot whose
      // sector cannot be resolved (map has no sectors, or the bot is off-map transiently)
      // falls back to its own configured stride, i.e. unthrottled — current behaviour.
      const botSectorId = sectors ? sectors.sectorOf(b.position) : null;
      if (sectors && botSectorId && !sectors.thinkEnabled(botSectorId)) continue;
      const baseStride = b.thinkStride || 8;
      const stride = sectors && botSectorId ? sectors.thinkStrideFor(botSectorId, baseStride) : baseStride;
      if ((tick + b.thinkPhase) % stride === 0) {
        const last = b._lastThinkTime ?? now;
        b._lastThinkTime = now;
        b.think(clamp(now - last, dt, 0.25));
      }
    }

    // Objective intent is applied after ordinary combat thinking so a patrol/cover state
    // cannot overwrite the route to the bomb or site on the same tick. Combat perception,
    // aim and firing remain active while following that route.
    for (let i = 0; i < bots.length; i++) this._applyBombObjective(bots[i]);

    // 2) global A* budget, round-robin so nobody starves
    //
    // sector-interest.md §4.3 — "shared across all active+warming sectors, served
    // round-robin ... a sector with more relevant AI does not starve a smaller one". A
    // warming sector's share is halved: its bots are skipped on odd passes through this
    // block rather than removed from the round-robin entirely, so they still eventually
    // get served (no starvation) at roughly half the rate of an active-sector bot.
    if (tick % PATH_INTERVAL === 0) {
      let served = 0;
      for (let n = 0; n < bots.length && served < PATH_BUDGET; n++) {
        const b = bots[this._pathCursor % bots.length];
        this._pathCursor++;
        if (!b.alive || !b.pathPending) continue;
        if (sectors) {
          const bSector = sectors.sectorOf(b.position);
          const share = bSector ? sectors.pathShareFor(bSector) : 1;
          if (share < 1 && (this._pathCursor & 1) === 0) continue;
        }
        b.servicePath();
        served++;
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

  _setObjective(bot, role, site = null) {
    if (bot.objectiveRole === role && bot.objectiveSite === site) return;
    bot.objectiveRole = role;
    bot.objectiveSite = site;
    this.objectiveLog.push({
      tick: this.game.match?._elapsedTicks ?? 0,
      round: this.game.match?.bombRules?.roundNumber ?? 0,
      botId: bot.id,
      team: bot.team,
      role,
      site,
    });
    if (this.objectiveLog.length > OBJECTIVE_LOG_MAX) this.objectiveLog.shift();
  }

  _teamSlot(bot) {
    let slot = 0;
    for (let i = 0; i < this.bots.length; i++) {
      const other = this.bots[i];
      if (other === bot) return slot;
      if (other.team === bot.team) slot++;
    }
    return slot;
  }

  /**
   * The bot's slot among its LIVING teammates, in roster order. The §13.11 contest/defend
   * split must be computed over the living — a split over the full roster froze every
   * survivor into whatever duty the round started them with, and once the contest slots
   * were all dead a dropped bomb lay untouched while both teams stood at their home sites
   * running the clock into a §13.5.3 draw. Deterministic: roster order and elimination
   * state are simulation facts, identical across replays of one seed.
   */
  _livingTeamSlot(bot, rules) {
    let slot = 0;
    for (let i = 0; i < this.bots.length; i++) {
      const other = this.bots[i];
      if (other === bot) return slot;
      if (other.team === bot.team && other.alive && rules.isAlive(other)) slot++;
    }
    return slot;
  }

  /** §13.11 defend-home: hold the plant volume of the site this team must not lose. */
  _defendHome(bot, rules) {
    const homeId = rules.homeSiteOf(bot.team);
    const home = rules.sites.get(homeId);
    if (!home) { this._setObjective(bot, 'none', null); return; }
    this._setObjective(bot, 'defend', homeId);
    objectiveCentre(home.plant, _v1);
    bot.moveMode = bot.targetVisible ? 'combat' : 'run';
    bot.setDestination(_v1, 1.8);
  }

  /**
   * Autonomous Bomb objective layer — SYMMETRIC demolition (bomb-rules §13.11).
   *
   * The attacker/defender split is gone: every decision derives from the bot's team's HOME
   * site (defend, defuse) and TARGET site (the enemy's home — the only legal plant), both
   * published per-round by BombRules (§13.1). Per-team states, all deterministic per
   * (seed, round, team): CONTEST the neutral/dropped bomb, CARRY/ESCORT it to the one legal
   * target, DEFEND-HOME, RETAKE/DEFUSE when the own site is planted, and POST-PLANT hold at
   * the enemy site. Which bots contest vs defend at round start is a deterministic id-parity
   * split (`_teamSlot`), the same discipline the old lurk split used.
   *
   * This layer chooses destinations and submits held interaction intent. It never moves an
   * actor, changes bomb state or awards a round: Bot pathing/world collision performs the
   * travel and BombRules revalidates the request on every fixed step.
   */
  _applyBombObjective(bot) {
    const rules = this.game.match?.bombRules;
    if (!rules || !rules.liveRound || !bot.alive || !rules.isAlive(bot)) {
      this._setObjective(bot, 'none', null);
      return;
    }

    const targetSiteId = rules.targetSiteOf(bot.team);
    const targetSite = targetSiteId ? rules.sites.get(targetSiteId) : null;
    if (!targetSite) {
      this._setObjective(bot, 'none', null);
      return;
    }

    // An objective decision outranks a stale sightseeing/climb commitment.
    bot.climbLock = 0;

    if (rules.phase === 'live') {
      // CARRY: deliver to the fixed target site. There is exactly one legal target
      // (§13.11), so the old per-round site memoisation is simply the target itself.
      if (rules.bomb.state === 'carried' && rules.bomb.carrierId === bot.id) {
        objectiveCentre(targetSite.plant, _v1);
        bot.moveMode = bot.targetVisible ? 'combat' : 'sprint';
        bot.setDestination(_v1, 0.4);
        if (rules.siteAt(bot.position, 'plant')?.site === targetSiteId && bot.grounded !== false
          && rules.requestInteract(bot, 'plant')) {
          this._setObjective(bot, 'planting', targetSiteId);
        } else {
          this._setObjective(bot, 'carry', targetSiteId);
        }
        return;
      }

      // Deterministic per-team split, ROTATED by round index so no bot draws home-guard
      // duty every round (§13.11 allows any deterministic (seed, round, team) function; a
      // fixed parity left the same bots idling at the site for a whole series, which both
      // starves their navigation sample and wastes half the squad every round).
      const slot = this._livingTeamSlot(bot, rules);
      const rot = slot + rules.roundIndex;
      // Numbers-aware pressing, from PUBLIC state only (§8 puts alive counts on the wire):
      // a team that outnumbers the enemy stops garrisoning its home and converts — sitting
      // on a site you already outman is how a won fight rots into a §13.5.3 timer draw.
      const alive = rules.aliveCounts();
      const press = alive[bot.team] > alive[bot.team === 0 ? 1 : 0];
      const forward = press || rot % 3 !== 1;

      if (rules.bomb.state === 'dropped') {
        // CONTEST: race to the neutral/dropped bomb (§13.3 — both teams may pick it up).
        if (forward) {
          this._setObjective(bot, 'contest', null);
          bot.moveMode = 'sprint';
          bot.setDestination(rules.bomb.position, 0.65);
        } else {
          this._defendHome(bot, rules);
        }
        return;
      }

      // Someone carries. Teammate → ESCORT toward the target with the bulk of the squad
      // (a home site the enemy must retake-proof is defended by the PLANT, not by bodies
      // left behind); enemy → the bomb is coming to OUR home: forward slots intercept the
      // carrier, the rest fall back and defend.
      const carrier = this.game.entityById?.(rules.bomb.carrierId) ?? null;
      if (carrier && carrier.team === bot.team) {
        if (!press && (rot & 3) === 1) {
          this._defendHome(bot, rules);
        } else {
          this._setObjective(bot, 'escort', targetSiteId);
          objectiveCentre(targetSite.plant, _v1);
          bot.moveMode = bot.targetVisible ? 'combat' : 'run';
          bot.setDestination(_v1, 2.2);
        }
        return;
      }
      if (carrier && forward) {
        this._setObjective(bot, 'contest', null);
        bot.moveMode = 'sprint';
        bot.setDestination(rules.bomb.position, 0.9);
        return;
      }
      this._defendHome(bot, rules);
      return;
    }

    // planted
    const plantedSiteId = rules.bomb.siteId;
    const plantedSite = rules.sites.get(plantedSiteId);
    if (!plantedSite) return;
    objectiveCentre(plantedSite.defuse, _v1);
    if (rules.siteOwner(plantedSiteId) !== bot.team) {
      // POST-PLANT hold: we planted at the enemy's home; deny the retake.
      this._setObjective(bot, 'postplant', plantedSiteId);
      bot.moveMode = bot.targetVisible ? 'combat' : 'run';
      bot.setDestination(_v1, 2.0);
      return;
    }

    // RETAKE/DEFUSE: our own home site is planted (§13.4 — only the owner may defuse).
    bot.moveMode = bot.targetVisible ? 'combat' : 'sprint';
    bot.setDestination(_v1, 0.4);
    if (rules.siteAt(bot.position, 'defuse')?.site === plantedSiteId
      && rules.requestInteract(bot, 'defuse')) {
      this._setObjective(bot, 'defusing', plantedSiteId);
    } else {
      this._setObjective(bot, 'retake', plantedSiteId);
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
    for (const b of this.bots) b.configure(name);
  }

  dispose() {
    for (const un of this._unsub) { try { un(); } catch { /* already gone */ } }
    this._unsub.length = 0;
    for (const b of this.bots) b.dispose();
    this.bots.length = 0;
    // Teardown changes the roster like any other path. Without this the registry keeps
    // handing back disposed bots — and strongly retaining them.
    this.game.rosterChanged();
    disposeBotRigs();
  }
}

export default BotManager;
