import { createRNG } from '../core/rng.js';
import { FIXED_DT } from '../core/mathUtils.js';

/**
 * OVERSTRIKE — the Bomb ruleset.
 *
 * Implements `docs/contracts/bomb-rules.md` v1.7.0. Every rule below cites the section it
 * comes from; if this file and the contract disagree, the contract wins and this file is
 * the bug.
 *
 * Three properties are structural, not incidental:
 *
 *  1. **Server-authoritative.** A client REQUESTS an interaction (`requestInteract`) and
 *     displays what comes back. Preconditions, accumulation and interruption all happen
 *     here (§6, §7). There is no client-side prediction of objective progress.
 *  2. **Deterministic.** Every duration is an integer count of 1/120 s steps, never a
 *     float accumulated across frames, and the only randomness is a per-round stream
 *     derived from the match seed (§3). No `Math.random`, no wall clock.
 *  3. **One ordered resolution.** All win conditions are evaluated once per step, in the
 *     order §4 states, by `_resolve()` — never by whichever event handler happens to run
 *     first. That is the whole point of §4 having a precedence list.
 */

// ── §2 parameters — DECIDED (D4). Values belong to the human owner; rules hold for any. ──
export const BOMB_PARAMS = Object.freeze({
  roundsToWin: 7,             // §2.1a early win — reaching 7 ends the match immediately
  maxRounds: 12,              // §2.1a MR12 regulation
  sideSwitchAfterRound: 6,    // §2 both teams attack and defend equally
  roundSeconds: 105,          // §2 1:45 pre-plant
  freezeSeconds: 8,           // §2
  plantSeconds: 3.0,          // §2
  defuseSeconds: 7.0,         // §2 (no kit in Alpha)
  bombTimerSeconds: 40,       // §2.1 derived: 22 s rotation + 7 s defuse + 11 s site fight
  roundEndSeconds: 5,         // §2
  reconnectGraceSeconds: 90,  // §2 / auth.md §7
  abandonRounds: 2,           // §2 consecutive rounds absent
  defuseKit: false,           // §2 none in Alpha
  overtime: false,            // §2.2 6-6 is a draw
});

/** Durations as whole fixed steps. Comparisons are integer, so replays cannot drift. */
const T = Object.freeze({
  round: Math.round(BOMB_PARAMS.roundSeconds / FIXED_DT),
  freeze: Math.round(BOMB_PARAMS.freezeSeconds / FIXED_DT),
  plant: Math.round(BOMB_PARAMS.plantSeconds / FIXED_DT),
  defuse: Math.round(BOMB_PARAMS.defuseSeconds / FIXED_DT),
  bomb: Math.round(BOMB_PARAMS.bombTimerSeconds / FIXED_DT),
  roundEnd: Math.round(BOMB_PARAMS.roundEndSeconds / FIXED_DT),
});
export const BOMB_TICKS = T;

/** §11 `interactRefused` (event kind 20) carries one of these. Closed set, on the wire. */
export const REFUSE = Object.freeze({
  wrongPhase: 'wrongPhase',
  dead: 'dead',
  wrongTeam: 'wrongTeam',
  notCarrying: 'notCarrying',
  outsideVolume: 'outsideVolume',
  notGrounded: 'notGrounded',
  alreadyPlanted: 'alreadyPlanted',
  notPlanted: 'notPlanted',
  released: 'released',
  roundOver: 'roundOver',
  disconnected: 'disconnected',
});

/** Pickup range for a dropped bomb (§5 "contact-range"). Metres. */
const PICKUP_RANGE = 1.6;
const PICKUP_RANGE_SQ = PICKUP_RANGE * PICKUP_RANGE;
/** Bounded evidence log. Long enough for a full 12-round match of objective traffic. */
const EVENT_LOG_MAX = 4096;

// ────────────────────────────────────────────────────────────── map manifest (map-data §3)

/**
 * Bomb sites come from the MAP MANIFEST, never from constants in here (`map-data.md` §3.3).
 * A map that does not publish objective volumes cannot host Bomb, and saying so loudly at
 * match start is the only honest failure: the alternative is a mode that silently plays on
 * coordinates baked into the ruleset and drifts away from the geometry it is played on.
 *
 * `game.mapManifest` first — that is the explicit override, and it is how a harness plays
 * Bomb on a map whose objective volumes have not been authored yet. Otherwise the compiled
 * §3 manifest `World.init()` built from the producer's `MAP_MANIFEST` export. MERIDIAN
 * declares none, so its `objectives` is `[]` and `compileObjectives` says so out loud.
 */
export function resolveMapManifest(game) {
  return game?.mapManifest
    ?? game?.world?.manifest
    ?? game?.world?.MAP_MANIFEST
    ?? null;
}

const VALID_KINDS = new Set(['plant', 'defuse', 'zone']);

function checkBox(box, where) {
  if (!box || typeof box !== 'object') throw new Error(`${where}: objective has no box`);
  const { min, max } = box;
  for (const p of [min, max]) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      throw new Error(`${where}: box corner is not a finite point`);
    }
  }
  // Same rule map-data.md §3.1 applies to collision boxes: an inverted box is rejected
  // rather than silently containing nothing. `world.js` normalizes the corners but CARRIES
  // the fact as `inverted`, so an authored inversion is still rejected here after it has
  // been through the manifest builder.
  if (min.x > max.x || min.y > max.y || min.z > max.z || box.inverted === true) {
    throw new Error(`${where}: box has min > max on an axis`);
  }
  return { min: { x: min.x, y: min.y, z: min.z }, max: { x: max.x, y: max.y, z: max.z } };
}

/**
 * Compile `manifest.objectives` (map-data.md §3.3) into the site table the ruleset reads.
 *
 * @returns {Map<string, {site:string, plantId:string, plant:object, defuseId:string,
 *                        defuse:object, requiresGround:boolean}>}
 */
export function compileObjectives(manifest) {
  const list = manifest?.objectives;
  if (!Array.isArray(list)) throw new Error('bomb: map manifest publishes no objectives array (map-data.md §3.3)');
  const sites = new Map();
  const seenIds = new Set();
  for (const o of list) {
    if (!o || typeof o.id !== 'string' || o.id === '') throw new Error('bomb: objective volume has no id');
    if (seenIds.has(o.id)) throw new Error(`bomb: duplicate objective id "${o.id}"`);
    seenIds.add(o.id);
    if (!VALID_KINDS.has(o.kind)) throw new Error(`bomb: objective "${o.id}" has unknown kind "${o.kind}"`);
    if (o.kind === 'zone') continue;
    if (typeof o.site !== 'string' || o.site === '') throw new Error(`bomb: objective "${o.id}" names no site`);
    const box = checkBox(o.box, `bomb: objective "${o.id}"`);
    let row = sites.get(o.site);
    if (!row) {
      row = { site: o.site, plantId: null, plant: null, defuseId: null, defuse: null, requiresGround: true };
      sites.set(o.site, row);
    }
    if (o.kind === 'plant') {
      if (row.plant) throw new Error(`bomb: site "${o.site}" has two plant volumes`);
      row.plantId = o.id;
      row.plant = box;
      row.requiresGround = o.requiresGround !== false;
    } else {
      if (row.defuse) throw new Error(`bomb: site "${o.site}" has two defuse volumes`);
      row.defuseId = o.id;
      row.defuse = box;
    }
  }
  if (sites.size === 0) throw new Error('bomb: map manifest declares no bomb site');
  for (const row of sites.values()) {
    if (!row.plant) throw new Error(`bomb: site "${row.site}" has a defuse volume but no plant volume`);
    // §3.3: "if defuse is omitted it defaults to the plant volume".
    if (!row.defuse) { row.defuse = row.plant; row.defuseId = row.plantId; }
  }
  // Sorted so iteration order never depends on manifest authoring order.
  return new Map([...sites.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

function inBox(box, p) {
  return p.x >= box.min.x && p.x <= box.max.x
    && p.y >= box.min.y && p.y <= box.max.y
    && p.z >= box.min.z && p.z <= box.max.z;
}

function clampToBox(box, p) {
  return {
    x: Math.min(box.max.x, Math.max(box.min.x, p.x)),
    y: Math.min(box.max.y, Math.max(box.min.y, p.y)),
    z: Math.min(box.max.z, Math.max(box.min.z, p.z)),
  };
}

// ────────────────────────────────────────────────────────────────────── the state machine

export class BombRules {
  /**
   * @param {object} match  the referee (`match.js`)
   * @param {object} [opts] `{ manifest }` — an explicit manifest overrides the map's own
   */
  constructor(match, opts = {}) {
    this.match = match;
    this.game = match.game;
    this.manifest = opts.manifest ?? resolveMapManifest(this.game);
    this.sites = compileObjectives(this.manifest);
    this.siteIds = [...this.sites.keys()];

    /** §3 `warmup → freeze → live → [planted] → roundEnd → freeze → … → matchEnd` */
    this.phase = 'warmup';
    this.phaseTicks = 0;
    this.roundTicks = 0;
    this.bombTicks = 0;
    /** 0-based index of the round being played. `roundNumber` is this + 1. */
    this.roundIndex = 0;
    this.roundWins = [0, 0];
    this.attackingTeam = 0;
    this.rounds = [];
    this.series = null;              // set once, at matchEnd

    /** §5 the bomb object. `state` ∈ carried | dropped | planted | defused | detonated */
    this.bomb = {
      state: 'carried', carrierId: -1, siteId: null,
      position: { x: 0, y: 0, z: 0 },
      lastValid: { x: 0, y: 0, z: 0 },
    };

    /** entity id → { kind, ticks, site } — server-side objective progress (§6, §7) */
    this._progress = new Map();
    /** entity id → { kind } — the held request a client has made */
    this._requests = new Map();
    /** entity ids eliminated for this round (§8) */
    this.eliminated = new Set();
    /**
     * Deaths reported since the referee last resolved — see `_commitDeaths()`. The engine
     * produces kills in the WEAPONS phase, which `game.js` runs BEFORE the rules, so every
     * real kill is already in hand by the time this ruleset steps.
     */
    this._freshDeaths = new Set();
    /** entity id → { connected, sinceTick, absentRounds } (§9) */
    this._conn = new Map();
    /** Completion latch. Once set inside a step it cannot be revoked by anything in it. */
    this._completed = null;
    /** entity id → { plants, defuses } (§10, completions only) */
    this.objectiveStats = new Map();
    /** Ordered evidence log; the wire and the after-action record read the same rows. */
    this.events = [];
    /** Dead-player chat held until the next freeze (§8). */
    this._deferredChat = [];
    /** Clutch bookkeeping (§10): team → { id, enemiesAlive } when it dropped to one alive. */
    this._clutch = [null, null];
    this._lastAlive = [-1, -1];
    this._refusals = [];
    /**
     * entity id → last `${kind}:${reason}` this entity was refused for (§8.7 `interactRefused`
     * evidence dedupe). `requestInteract` runs every tick while a client holds the interact
     * key (§6.4), and a client that simply holds the key while ineligible would otherwise
     * refuse — and evidence-record — once per tick indefinitely, exhausting the shared
     * evidence buffer (`ObjectiveEvidence.record`, `server.js`) within a minute or two and
     * silently dropping every objective fact after it, including the plant/defuse that
     * decides the round. One row per state transition is the §8.7 fact; every tick after
     * that is the same fact repeated.
     */
    this._lastRefusal = new Map();
  }

  // ───────────────────────────────────────────────────────────────────── small accessors

  get defendingTeam() { return this.attackingTeam === 0 ? 1 : 0; }
  get roundNumber() { return this.roundIndex + 1; }
  get planted() { return this.phase === 'planted'; }
  get liveRound() { return this.phase === 'live' || this.phase === 'planted'; }
  get roundTimeRemaining() { return Math.max(0, (T.round - this.roundTicks) * FIXED_DT); }
  get bombTimeRemaining() { return Math.max(0, (T.bomb - this.bombTicks) * FIXED_DT); }
  get freezeTimeRemaining() { return Math.max(0, (T.freeze - this.phaseTicks) * FIXED_DT); }

  /** What the HUD clock shows: the bomb timer replaces the round timer at plant (§3). */
  get displayTime() {
    if (this.phase === 'planted') return this.bombTimeRemaining;
    if (this.phase === 'freeze') return this.freezeTimeRemaining;
    if (this.phase === 'live') return this.roundTimeRemaining;
    return 0;
  }

  statsFor(id) {
    let row = this.objectiveStats.get(id);
    if (!row) this.objectiveStats.set(id, (row = { plants: 0, defuses: 0 }));
    return row;
  }

  /**
   * Combatants only — streak hardware and world entities carry no team.
   *
   * Cached per step against the roster version, because `aliveCount` is called several
   * times inside one ordered resolution and a fresh sorted array each time is exactly the
   * per-step garbage a fixed-timestep loop notices. The cache holds entity REFERENCES, so
   * liveness and position are always read fresh.
   */
  _roster() {
    const ver = this.game._rosterVersion ?? 0;
    const tick = this.match._elapsedTicks;
    if (this._rosterCache && this._rosterVer === ver && this._rosterTick === tick) return this._rosterCache;
    const out = [];
    const ents = this.game.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.team !== 0 && e.team !== 1) continue;
      out.push(e);
    }
    // Sorted by id: every iteration that can influence the simulation must be ordered.
    out.sort((a, b) => a.id - b.id);
    this._rosterCache = out;
    this._rosterVer = ver;
    this._rosterTick = tick;
    return out;
  }

  isConnected(id) {
    const row = this._conn.get(id);
    return row ? row.connected : true;
  }

  isAlive(entity) {
    if (!entity) return false;
    if (this.eliminated.has(entity.id)) return false;
    if (!this.isConnected(entity.id)) return false;
    return entity.alive !== false;
  }

  /**
   * §4 simultaneity, expressed as one predicate.
   *
   * A death reported since the referee last resolved happened *on this tick*, and §4 says a
   * tie between an action a player took and anything else resolves in favour of the action:
   * "if the last defender dies on the same tick a defuse completes, the defuse wins — it
   * completed". So for the two places that decide whether an in-progress objective survives
   * this tick — carrying the bomb, and accumulating plant/defuse progress — a player who
   * died this tick is still acting. `_commitDeaths()` applies the death immediately
   * afterwards, before anything reads `aliveCount`, so the death is late by nothing.
   *
   * Everything else — pickup, alive counts, clutch, spectating — uses `isAlive`, where the
   * death is already in effect. A corpse does not pick the bomb up.
   */
  _actingThisTick(entity) {
    if (!entity) return false;
    if (this._freshDeaths.has(entity.id)) return this.isConnected(entity.id);
    return this.isAlive(entity);
  }

  aliveCount(team) {
    let n = 0;
    for (const e of this._roster()) if (e.team === team && this.isAlive(e)) n++;
    return n;
  }

  aliveCounts() { return [this.aliveCount(0), this.aliveCount(1)]; }

  _entity(id) { return this.game.entityById?.(id) ?? null; }

  _emit(kind, data = {}) {
    const row = { kind, tick: this.match._elapsedTicks, round: this.roundNumber, ...data };
    this.events.push(row);
    if (this.events.length > EVENT_LOG_MAX) this.events.shift();
    this.game.bus?.emit?.('objective', row);
    return row;
  }

  /**
   * @param {boolean} [repeat] when true, always emit — used by `_accumulate`'s already-in-
   *   progress path, which fires at most once per hold because the request is removed from
   *   `_requests` on the same refusal. The per-tick spam this guards against is entirely
   *   `requestInteract`'s ineligible-on-every-call path (§6.4), which passes this false.
   */
  _refuse(entityId, kind, reason, repeat = true) {
    if (!repeat) {
      const sig = `${kind}:${reason}`;
      if (this._lastRefusal.get(entityId) === sig) return null;
      this._lastRefusal.set(entityId, sig);
    }
    // §11 event kind 20: requested kind + refusal reason, to the requester only.
    const row = this._emit('interactRefused', { entityId, requested: kind, reason });
    this._refusals.push(row);
    if (this._refusals.length > 64) this._refusals.shift();
    return row;
  }

  // ───────────────────────────────────────────────────────────────────────── round phases

  /**
   * Per-round RNG (§5 bomb spawn). Derived from the match seed and the round index rather
   * than drawn from `game.rng`: the shared stream is also consumed by respawn jitter and
   * bot behaviour, so taking a draw from it would make the carrier depend on how many
   * bots happened to die last round. Same seed must mean the same match.
   */
  _roundRng() {
    const seed = ((this.game.matchSeed >>> 0) ^ Math.imul(0x9e3779b9, this.roundIndex + 1)) >>> 0;
    return createRNG(seed);
  }

  /** §3 freeze: roster locked, movement restricted, round timer paused. */
  beginFreeze() {
    this.phase = 'freeze';
    this.phaseTicks = 0;
    this.roundTicks = 0;
    this.bombTicks = 0;
    this._completed = null;
    this._progress.clear();
    this._requests.clear();
    this.eliminated.clear();
    this._freshDeaths.clear();
    this._clutch = [null, null];
    this._lastAlive = [-1, -1];
    // A new round is a new set of facts — the same reason refused in the round just ended
    // must be told again if it recurs here.
    this._lastRefusal.clear();

    // §9 absence bookkeeping drives the `abandoned` stat.
    for (const [id, row] of this._conn) {
      if (!row.connected) row.absentRounds++;
      else row.absentRounds = 0;
      void id;
    }

    // Everyone who is connected comes back for the new round (§8: elimination lasts
    // until the next freeze).
    for (const e of this._roster()) {
      if (!this.isConnected(e.id)) continue;
      e.alive = false;
      this.match.spawner.spawnEntity(e);
    }

    this._giveBombToRandomAttacker();
    this._flushDeferredChat();
    this._emit('roundStart', {
      attackingTeam: this.attackingTeam,
      roundWins: [this.roundWins[0], this.roundWins[1]],
    });
  }

  /** §5 spawn: one random eligible attacker at freeze. */
  _giveBombToRandomAttacker() {
    const rng = this._roundRng();
    const eligible = this._roster().filter((e) => e.team === this.attackingTeam && this.isConnected(e.id));
    this.bomb.state = 'carried';
    this.bomb.siteId = null;
    if (eligible.length === 0) {
      // No attacker to carry it: it sits at the site-neutral origin until one connects.
      this.bomb.carrierId = -1;
      this.bomb.state = 'dropped';
      return;
    }
    const carrier = eligible[rng.int(eligible.length)];
    this.bomb.carrierId = carrier.id;
    this._setBombPosition(carrier.position);
    this._emit('bombPickedUp', { entityId: carrier.id, reason: 'roundStart' });
  }

  _setBombPosition(p) {
    this.bomb.position.x = p.x; this.bomb.position.y = p.y; this.bomb.position.z = p.z;
    if (this._inBounds(p)) {
      this.bomb.lastValid.x = p.x; this.bomb.lastValid.y = p.y; this.bomb.lastValid.z = p.z;
    }
  }

  _inBounds(p) {
    const b = this.game.world?.bounds;
    if (!b?.min || !b?.max) return true;
    return p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y
      && p.z >= b.min.z && p.z <= b.max.z;
  }

  _beginLive() {
    this.phase = 'live';
    this.phaseTicks = 0;
    this.roundTicks = 0;
    this._emit('liveStart', { attackingTeam: this.attackingTeam });
  }

  // ────────────────────────────────────────────────────────────────────────── the step

  /** One fixed 1/120 s step. Called by the mode from `Match.fixedUpdate`. */
  tick() {
    switch (this.phase) {
      case 'warmup':
        // Pre-match. Free movement, no scoring, respawns on (§3). The first step of a
        // started match opens round 1.
        this.beginFreeze();
        return;
      case 'freeze':
        this.phaseTicks++;
        if (this.phaseTicks >= T.freeze) this._beginLive();
        return;
      case 'live':
      case 'planted':
        this._tickRound();
        return;
      case 'roundEnd':
        this.phaseTicks++;
        if (this.phaseTicks >= T.roundEnd) this._afterRoundEnd();
        return;
      default:
        // matchEnd — the series is over and nothing moves.
    }
  }

  _tickRound() {
    this.phaseTicks++;
    // Bomb carrying and objective progress see the tick's deaths as still-acting players
    // (`_actingThisTick`); `_commitDeaths` then applies those deaths before anything that
    // counts the living runs. That ordering IS §4's simultaneity rule.
    this._updateBomb();
    this._accumulate();
    this._commitDeaths();
    if (this.phase === 'live') this.roundTicks++;
    else this.bombTicks++;
    this._noteClutch();
    this._resolve();
    this._completed = null;
  }

  /**
   * Apply the consequences of every death reported since the last resolution: lost objective
   * progress (§6) and a dropped bomb (§5).
   *
   * These are deferred out of `onKill` rather than applied there because `onKill` runs in the
   * WEAPONS phase of the engine's fixed step and the referee runs LAST (`game.js`
   * `_fixedUpdate`: nav → player → entities → bots → weapons → projectiles → match). Applied
   * on arrival, a death would wipe the progress of an objective that completes on the very
   * same tick, and both §4 simultaneity clauses would invert: the defuse that completed would
   * be reported as a detonation, and the plant that completed as a pre-plant elimination.
   */
  _commitDeaths() {
    if (this._freshDeaths.size === 0) return;
    // Ordered by id: every iteration that can influence the simulation must be ordered.
    for (const id of [...this._freshDeaths].sort((a, b) => a - b)) {
      if (this._completed && this._completed.actorId === id) {
        // Their objective completed on this tick. It is not cancelled by their death (§4),
        // and the bomb is about to be planted or defused rather than dropped — so the
        // request is dropped silently instead of being reported as an interruption.
        this._requests.delete(id);
        this._progress.delete(id);
        continue;
      }
      this._applyDeath(id);
    }
    this._freshDeaths.clear();
  }

  /**
   * §6 progress is lost and §5 the carried bomb drops, at the death position.
   *
   * `entity` is passed in where the caller already holds the victim, so the bomb lands on the
   * body even if the roster can no longer resolve the id.
   */
  _applyDeath(id, entity = this._entity(id)) {
    this._requests.delete(id);
    this._resetProgress(id, REFUSE.dead);
    if (this.bomb.state === 'carried' && this.bomb.carrierId === id) {
      this._dropBomb(entity, 'carrierDeath');
    }
  }

  /** §5 carrier tracking, drop recovery, pickup, out-of-bounds return. */
  _updateBomb() {
    if (this.bomb.state === 'carried') {
      const carrier = this._entity(this.bomb.carrierId);
      // `_actingThisTick`: a carrier killed earlier in this tick still holds it until
      // `_commitDeaths`, so a plant completing on the tick they die is not refused for
      // `notCarrying` (§4). Their death drops it moments later, in the same tick.
      if (!carrier || !this._actingThisTick(carrier) || carrier.team !== this.attackingTeam) {
        this._dropBomb(carrier, 'carrierLost');
      } else {
        this._setBombPosition(carrier.position);
      }
      return;
    }
    if (this.bomb.state !== 'dropped') return;
    // Out of bounds returns to the last valid position — it can never be lost (§5).
    if (!this._inBounds(this.bomb.position)) {
      this.bomb.position.x = this.bomb.lastValid.x;
      this.bomb.position.y = this.bomb.lastValid.y;
      this.bomb.position.z = this.bomb.lastValid.z;
      this._emit('bombRecovered', {});
    }
    // Pickup: any attacker, contact range, no cast time. Defenders cannot (§5).
    let best = null;
    let bestD = PICKUP_RANGE_SQ;
    for (const e of this._roster()) {
      if (e.team !== this.attackingTeam || !this.isAlive(e)) continue;
      const dx = e.position.x - this.bomb.position.x;
      const dy = e.position.y - this.bomb.position.y;
      const dz = e.position.z - this.bomb.position.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d <= bestD) { bestD = d; best = e; }
    }
    if (best) {
      this.bomb.state = 'carried';
      this.bomb.carrierId = best.id;
      this._setBombPosition(best.position);
      this._emit('bombPickedUp', { entityId: best.id, reason: 'pickup' });
    }
  }

  _dropBomb(carrier, reason) {
    if (carrier) this._setBombPosition(carrier.position);
    this.bomb.state = 'dropped';
    const id = this.bomb.carrierId;
    this.bomb.carrierId = -1;
    this._emit('bombDropped', { entityId: id, reason, x: this.bomb.position.x, y: this.bomb.position.y, z: this.bomb.position.z });
  }

  // ────────────────────────────────────────────────────────────── §6 plant / §7 defuse

  /**
   * A client REQUESTS. Nothing accumulates here; the request is a held key and the server
   * decides every step whether it is still valid.
   */
  requestInteract(entity, kind) {
    if (!entity) return false;
    if (kind !== 'plant' && kind !== 'defuse') return false;
    const check = this._validate(entity, kind);
    if (!check.ok) {
      this._requests.delete(entity.id);
      this._resetProgress(entity.id, check.reason);
      // Not `repeat`: a client holding the interact key while ineligible calls this every
      // tick (§6.4), and the refusal is one §8.7 fact per state transition, not per tick.
      this._refuse(entity.id, kind, check.reason, false);
      return false;
    }
    this._requests.set(entity.id, { kind });
    // Eligible again — the next refusal, if any, is a new fact and must be told again.
    this._lastRefusal.delete(entity.id);
    return true;
  }

  /** Key released — §6 "progress resets to zero, no partial credit and no resume". */
  releaseInteract(entity) {
    if (!entity) return;
    // Only an entity that was actually accepted into `_requests` — i.e. `requestInteract`
    // found them eligible at least once this hold — gets a fresh dedupe slate on release.
    // `releaseInteract` runs every tick the wire's `cmd.interactHeld` bit is false
    // (server.js), so an entity that was never accepted (every `requestInteract` this hold
    // was refused) must NOT have `_lastRefusal` cleared here: a client can toggle
    // `interactHeld` true/false every tick, alternating `requestInteract` (refused, deduped)
    // with `releaseInteract` (no-op release), and clearing the dedupe on every release would
    // re-arm it every other tick — reproducing the original per-tick evidence-spam bug this
    // dedupe exists to close (§8.7).
    const wasAccepted = this._requests.has(entity.id);
    this._requests.delete(entity.id);
    this._resetProgress(entity.id, REFUSE.released);
    // The hold ended; a fresh hold's first refusal is a new fact even if the reason repeats.
    if (wasAccepted) this._lastRefusal.delete(entity.id);
  }

  /**
   * Every precondition in §6 / §7, server-side, evaluated fresh every step.
   *
   * @param {boolean} [acting] when true, a player killed earlier in THIS tick still counts as
   *   acting (§4 simultaneity — see `_actingThisTick`). Only `_accumulate` passes it: a NEW
   *   request from a player the engine has already killed is refused as `dead`.
   */
  _validate(entity, kind, acting = false) {
    if (!this.isConnected(entity.id)) return { ok: false, reason: REFUSE.disconnected };
    if (!(acting ? this._actingThisTick(entity) : this.isAlive(entity))) {
      return { ok: false, reason: REFUSE.dead };
    }
    if (kind === 'plant') {
      if (this.phase === 'planted') return { ok: false, reason: REFUSE.alreadyPlanted };
      if (this.phase !== 'live') return { ok: false, reason: REFUSE.wrongPhase };
      if (entity.team !== this.attackingTeam) return { ok: false, reason: REFUSE.wrongTeam };
      if (this.bomb.state !== 'carried' || this.bomb.carrierId !== entity.id) {
        return { ok: false, reason: REFUSE.notCarrying };
      }
      const site = this.siteAt(entity.position, 'plant');
      if (!site) return { ok: false, reason: REFUSE.outsideVolume };
      if (site.requiresGround && entity.grounded === false) return { ok: false, reason: REFUSE.notGrounded };
      return { ok: true, site: site.site };
    }
    if (this.phase !== 'planted') return { ok: false, reason: REFUSE.notPlanted };
    if (entity.team !== this.defendingTeam) return { ok: false, reason: REFUSE.wrongTeam };
    const site = this.sites.get(this.bomb.siteId);
    if (!site || !inBox(site.defuse, entity.position)) return { ok: false, reason: REFUSE.outsideVolume };
    return { ok: true, site: site.site };
  }

  /** The plant volume (map-data §3.3) the point is inside, or null. */
  siteAt(position, kind = 'plant') {
    for (const row of this.sites.values()) {
      if (inBox(kind === 'defuse' ? row.defuse : row.plant, position)) return row;
    }
    return null;
  }

  _resetProgress(id, reason) {
    const prog = this._progress.get(id);
    if (!prog) return;
    this._progress.delete(id);
    this._emit(prog.kind === 'plant' ? 'plantCancel' : 'defuseCancel', { entityId: id, reason, ticks: prog.ticks });
  }

  /** Progress in 0..63, the resolution §11 puts on the wire in the `interact` byte. */
  progressOf(id) {
    const prog = this._progress.get(id);
    if (!prog) return 0;
    const total = prog.kind === 'plant' ? T.plant : T.defuse;
    return Math.min(63, Math.floor((prog.ticks / total) * 63));
  }

  /** The actor the HUD shows a bar for, if any. */
  get progressActor() {
    let best = -1;
    for (const id of this._progress.keys()) if (best < 0 || id < best) best = id;
    return best;
  }

  /** Objective progress as a 0..1 fraction — what the HUD bar and the facade report. */
  progressFraction(id) {
    const prog = this._progress.get(id);
    if (!prog) return 0;
    return Math.min(1, prog.ticks / (prog.kind === 'plant' ? T.plant : T.defuse));
  }

  /** `{ kind, actorId, progress }` — the replication view of §6/§7 progress. */
  get interaction() {
    const actorId = this.progressActor;
    const prog = actorId >= 0 ? this._progress.get(actorId) : null;
    if (!prog) return { kind: 'none', actorId: 0, progress: 0 };
    return { kind: prog.kind, actorId, progress: this.progressFraction(actorId) };
  }

  /** True once the §2 side switch has happened, i.e. from round 7 on. */
  get sideSwitched() { return this.roundIndex >= BOMB_PARAMS.sideSwitchAfterRound; }

  _accumulate() {
    // Ordered by entity id so two simultaneous defusers always resolve the same way.
    const ids = [...this._requests.keys()].sort((a, b) => a - b);
    for (const id of ids) {
      const req = this._requests.get(id);
      const entity = this._entity(id);
      const check = entity ? this._validate(entity, req.kind, true) : { ok: false, reason: REFUSE.disconnected };
      if (!check.ok) {
        this._requests.delete(id);
        this._resetProgress(id, check.reason);
        this._refuse(id, req.kind, check.reason);
        continue;
      }
      let prog = this._progress.get(id);
      if (prog && prog.kind !== req.kind) { this._resetProgress(id, REFUSE.wrongPhase); prog = null; }
      if (!prog) {
        prog = { kind: req.kind, ticks: 0, site: check.site };
        this._progress.set(id, prog);
        this._emit(req.kind === 'plant' ? 'plantStart' : 'defuseStart', { entityId: id, site: check.site });
      }
      prog.ticks++;
      const total = prog.kind === 'plant' ? T.plant : T.defuse;
      // §7: two defenders do NOT stack. Each accumulates its own progress at the same
      // rate, so the pair completes on exactly the tick one of them would have.
      if (prog.ticks >= total && !this._completed) {
        // Completion is LATCHED here and consumed by `_resolve()` later in this same step.
        // Nothing between the latch and the resolution can revoke it, and `_tickRound`
        // clears it once the resolution has read it.
        //
        // The latch alone does NOT make §4's "if the last defender dies on the same tick a
        // defuse completes, the defuse wins" true, and an earlier comment here claimed the
        // opposite on the strength of an ordering the engine does not have: `game.systems`
        // is consumed by the RENDER path only, while the simulation step is hand-ordered in
        // `game.js` `_fixedUpdate` and runs the rules LAST. Every real kill therefore lands
        // BEFORE this loop, not after it. What makes the rule true is `_actingThisTick`
        // above plus `_commitDeaths` below.
        this._completed = { kind: prog.kind, actorId: id, site: prog.site };
      }
    }
  }

  // ───────────────────────────────────────────────────────────── §4 win + precedence

  /**
   * The single ordered resolution. Called once per step, after everything that could
   * change the outcome has been applied. Order is §4's, literally.
   */
  _resolve() {
    if (this.phase === 'live') {
      // 1. Bomb planted → transition to `planted`. Not a win, a phase change. It is FIRST,
      //    so a plant completing on the same step as the last attacker's death is a plant,
      //    and the defenders are not awarded an elimination win for it.
      if (this._completed && this._completed.kind === 'plant') {
        this._completePlant(this._completed);
        // fall through into the post-plant order below, on this same step
      } else {
        if (this.aliveCount(this.attackingTeam) === 0) return this._endRound(this.defendingTeam, 'elimination');
        if (this.aliveCount(this.defendingTeam) === 0) return this._endRound(this.attackingTeam, 'elimination');
        if (this.roundTicks >= T.round) return this._endRound(this.defendingTeam, 'timer');
        return;
      }
    }
    if (this.phase === 'planted') {
      // 1. Bomb defused → defenders win. First, so it beats both the expiring bomb timer
      //    and the death of the last defender on the same step (§4 simultaneity).
      if (this._completed && this._completed.kind === 'defuse') return this._completeDefuse(this._completed);
      // 2. Bomb timer expires → attackers win.
      if (this.bombTicks >= T.bomb) return this._endRound(this.attackingTeam, 'detonation');
      // 3. All defenders eliminated → attackers win; the bomb still detonates for show.
      if (this.aliveCount(this.defendingTeam) === 0) return this._endRound(this.attackingTeam, 'elimination');
      // 4. All attackers eliminated does NOT win for the defenders. Deliberate no-op —
      //    the bomb is planted and they must defuse it (§4, the load-bearing rule).
    }
  }

  _completePlant(completed) {
    this.phase = 'planted';
    this.phaseTicks = 0;
    this.bombTicks = 0;
    this.bomb.state = 'planted';
    this.bomb.siteId = completed.site;
    const planter = this._entity(completed.actorId);
    if (planter) this._setBombPosition(planter.position);
    this.bomb.carrierId = -1;
    this._progress.clear();
    this._requests.clear();
    this.statsFor(completed.actorId).plants++;
    this.match.awardObjective?.(planter, 'plant');
    // All players are notified regardless of line of sight (§6).
    this._emit('plantComplete', { entityId: completed.actorId, site: completed.site });
  }

  _completeDefuse(completed) {
    this.bomb.state = 'defused';
    this.statsFor(completed.actorId).defuses++;
    this.match.awardObjective?.(this._entity(completed.actorId), 'defuse');
    this._emit('defuseComplete', { entityId: completed.actorId, site: this.bomb.siteId });
    this._endRound(this.defendingTeam, 'defuse');
  }

  /** §10 clutch: a team that dropped to one living player against two or more. */
  _noteClutch() {
    for (const team of [0, 1]) {
      const n = this.aliveCount(team);
      if (n === this._lastAlive[team]) continue;
      this._lastAlive[team] = n;
      if (n !== 1) { this._clutch[team] = null; continue; }
      const enemies = this.aliveCount(team === 0 ? 1 : 0);
      if (enemies < 2) { this._clutch[team] = null; continue; }
      let survivor = null;
      for (const e of this._roster()) if (e.team === team && this.isAlive(e)) { survivor = e; break; }
      this._clutch[team] = survivor ? { id: survivor.id, enemiesAlive: enemies } : null;
    }
  }

  /**
   * The single ordered end-of-round sequence — the discipline `match.js` already applies
   * to the end of a TDM match. Resolve, record, pay, freeze, announce. Nothing after this
   * can change the round's outcome.
   */
  _endRound(winnerTeam, reason) {
    if (this.phase === 'roundEnd' || this.phase === 'matchEnd') return;
    // 1. Resolve: no further objective progress exists.
    this._progress.clear();
    this._requests.clear();
    this._completed = null;
    // 2. A planted bomb that was not defused detonates, whatever won the round (§4.3).
    const detonated = this.bomb.state === 'planted';
    if (detonated) {
      this.bomb.state = 'detonated';
      this._emit('bombDetonated', {
        site: this.bomb.siteId,
        x: this.bomb.position.x, y: this.bomb.position.y, z: this.bomb.position.z,
      });
    }
    // 3. Record.
    const alive = this.aliveCounts();
    const clutch = this._clutch[winnerTeam];
    const record = {
      round: this.roundNumber,
      winnerTeam,
      reason,
      attackingTeam: this.attackingTeam,
      planted: this.bomb.siteId !== null,
      site: this.bomb.siteId,
      aliveAttackers: alive[this.attackingTeam],
      aliveDefenders: alive[this.defendingTeam],
      clutchBy: clutch ? clutch.id : -1,
      endedAtTick: this.match._elapsedTicks,
    };
    this.rounds.push(record);
    this.roundWins[winnerTeam]++;
    // The referee's team score IS the round score in Bomb — the HUD, the scoreboard and
    // `MSG_MATCHSTATE` all read `match.scores`, and a Bomb match that left it at 0-0 would
    // replicate a blank scoreline while the round record said 4-2.
    this.match.scores[winnerTeam] = this.roundWins[winnerTeam];
    // 4. Pay.
    for (const e of this._roster()) {
      if (e.team === winnerTeam) this.match.awardObjective?.(e, 'roundWin');
    }
    if (clutch) this.match.awardObjective?.(this._entity(clutch.id), 'clutch');
    // 5. Freeze the round.
    this.phase = 'roundEnd';
    this.phaseTicks = 0;
    // 6. Announce.
    this._emit('roundEnd', record);
  }

  /** After the 5 s round-end delay: series check (§2.1a), side switch (§2), next round. */
  _afterRoundEnd() {
    this.roundIndex++;
    // §8.9's `outcomeReason` must describe how the match actually ended, and for an early
    // series win that is how the DECIDING round ended (elimination/defuse/detonation/timer) —
    // not the literal 'roundsToWin' label, which is a series-progress fact, not a §8.9 reason.
    // The deciding round is always the one just recorded by `_endRound`.
    const decidingReason = this.rounds[this.rounds.length - 1]?.reason ?? 'elimination';
    if (this.roundWins[0] >= BOMB_PARAMS.roundsToWin) {
      return this._endMatch(0, 'roundsToWin', { outcomeReason: decidingReason });
    }
    if (this.roundWins[1] >= BOMB_PARAMS.roundsToWin) {
      return this._endMatch(1, 'roundsToWin', { outcomeReason: decidingReason });
    }
    if (this.roundIndex >= BOMB_PARAMS.maxRounds) return this._endMatch(-1, 'draw');
    // §2.1a side switch after round 6, so each side plays 6 attacking and 6 defending.
    if (this.roundIndex === BOMB_PARAMS.sideSwitchAfterRound) {
      this.attackingTeam = this.defendingTeam;
      this._emit('sideSwitch', { attackingTeam: this.attackingTeam });
    }
    this.beginFreeze();
  }

  /**
   * @param {boolean} [override] replace an already-recorded PRESENCE abort. A match decided
   *   by play is final; a forfeit is not, because the fact it rests on ("that team is gone")
   *   can still change when the other team goes too, and §9 says both gone is a no-contest.
   */
  _endMatch(winnerTeam, reason, extra = {}, override = false) {
    if (this.phase === 'matchEnd' && !(override && this.series?.terminationReason === 'aborted')) return;
    this.phase = 'matchEnd';
    this.phaseTicks = 0;
    this.series = {
      winnerTeam,
      // §2.1a: 6-6 after 12 rounds is a draw, and the record says so in words.
      winnerLabel: winnerTeam < 0 ? 'draw' : String(winnerTeam),
      reason,
      roundWins: [this.roundWins[0], this.roundWins[1]],
      roundsPlayed: this.rounds.length,
      maxRounds: BOMB_PARAMS.maxRounds,
      ...extra,
    };
    this._emit('matchEnd', this.series);
  }

  // ────────────────────────────────────────────────────────────────── §8 elimination

  /**
   * Called from the mode's `onKill`. Death in `live` OR `planted` is elimination (§8) —
   * both, which is why this reads `liveRound` and not `phase === 'live'`.
   *
   * The elimination itself is recorded HERE, so `aliveCount` is right for every reader from
   * this instant. What is deferred to `_commitDeaths` is only what could destroy an
   * objective that completes on this same tick (§4): the progress reset and the bomb drop.
   */
  onKill(victim, attacker) {
    void attacker;
    if (!victim) return;
    if (!this.liveRound) {
      // No round is running, so there is no objective tick for this death to be
      // simultaneous with. Apply it now.
      this._applyDeath(victim.id, victim);
      return;
    }
    this.eliminated.add(victim.id);
    this._freshDeaths.add(victim.id);
  }

  /** §3: respawns are on in warmup only; in live/planted a death is an elimination. */
  allowRespawn() { return this.phase === 'warmup'; }

  /** §3 freeze/roundEnd lock weapons; the eliminated never fire. */
  canFire(entity) {
    if (!this.liveRound) return false;
    return this.isAlive(entity);
  }

  // ──────────────────────────────────────────────────────────── §8 spectator limits

  /**
   * A dead player may spectate ONLY their own team's living players during a live round.
   * This is an anti-abuse rule: spectating an enemy is a live enemy-position feed.
   */
  canSpectate(viewer, target) {
    if (!viewer || !target) return false;
    if (this.phase === 'roundEnd' || this.phase === 'matchEnd') return true;  // nothing left to leak
    if (!this.liveRound) return false;
    if (this.isAlive(viewer)) return false;                                    // living players do not spectate
    if (!this.isAlive(target)) return false;
    return viewer.team === target.team;
  }

  /** No free camera during a live round; full free camera once the round is decided. */
  canFreeCam() { return this.phase === 'roundEnd' || this.phase === 'matchEnd'; }

  /** Dead players cannot use live team chat or pings; it is delivered at the next freeze. */
  submitChat(entity, text) {
    if (entity && this.liveRound && !this.isAlive(entity)) {
      this._deferredChat.push({ entityId: entity.id, team: entity.team, text });
      return { delivered: false, deferredUntil: 'freeze' };
    }
    this.game.bus?.emit?.('chat', { entityId: entity?.id ?? -1, team: entity?.team ?? -1, text });
    return { delivered: true, deferredUntil: null };
  }

  canPing(entity) { return !this.liveRound || this.isAlive(entity); }

  _flushDeferredChat() {
    for (const row of this._deferredChat) {
      this.game.bus?.emit?.('chat', { ...row, deferred: true });
    }
    this._deferredChat.length = 0;
  }

  // ─────────────────────────────────────────────────────── §9 backfill / disconnects

  /** Bomb does not inject players into an active competitive round. */
  canJoin() {
    if (this.phase === 'warmup' || this.phase === 'matchEnd') return { allowed: true, reason: null };
    return { allowed: false, reason: 'ROOM_IN_PROGRESS' };
  }

  noteConnect(entity) {
    this._conn.set(entity.id, { connected: true, sinceTick: this.match._elapsedTicks, absentRounds: 0 });
  }

  /** Disconnect: the bomb drops, progress resets, and the team may fall below one living. */
  noteDisconnect(entity) {
    if (!entity) return;
    const row = this._conn.get(entity.id)
      ?? { connected: true, sinceTick: this.match._elapsedTicks, absentRounds: 0 };
    row.connected = false;
    row.sinceTick = this.match._elapsedTicks;
    this._conn.set(entity.id, row);
    this._requests.delete(entity.id);
    this._resetProgress(entity.id, REFUSE.disconnected);
    if (this.bomb.state === 'carried' && this.bomb.carrierId === entity.id) {
      this._dropBomb(entity, 'carrierDisconnect');
    }
    this._emit('disconnect', { entityId: entity.id });
    this._checkTeamPresence();
  }

  /**
   * Reconnect inside grace rebinds to the existing entity; if the player was eliminated
   * they come back as a spectator. After grace, refused until matchEnd (§9).
   */
  canReconnect(entityId) {
    const row = this._conn.get(entityId);
    if (!row || row.connected) return { allowed: true, asSpectator: false, reason: null };
    const elapsedTicks = this.match._elapsedTicks - row.sinceTick;
    if (elapsedTicks * FIXED_DT > BOMB_PARAMS.reconnectGraceSeconds) {
      if (this.phase === 'matchEnd') return { allowed: true, asSpectator: false, reason: null };
      return { allowed: false, asSpectator: false, reason: 'GRACE_EXPIRED' };
    }
    return { allowed: true, asSpectator: this.eliminated.has(entityId), reason: null };
  }

  noteReconnect(entity) {
    const verdict = this.canReconnect(entity.id);
    if (!verdict.allowed) return verdict;
    const row = this._conn.get(entity.id);
    if (row) { row.connected = true; row.sinceTick = this.match._elapsedTicks; row.absentRounds = 0; }
    this._emit('reconnect', { entityId: entity.id, asSpectator: verdict.asSpectator });
    return verdict;
  }

  /** True once a player has missed `abandonRounds` consecutive rounds (§2, the stat). */
  abandoned(entityId) {
    const row = this._conn.get(entityId);
    return !!row && !row.connected && row.absentRounds >= BOMB_PARAMS.abandonRounds;
  }

  _connectedCount(team) {
    let n = 0;
    for (const e of this._roster()) if (e.team === team && this.isConnected(e.id)) n++;
    return n;
  }

  /** §9: a team at zero connected forfeits; both at zero is a no-contest abort. */
  _checkTeamPresence() {
    const a = this._connectedCount(0);
    const b = this._connectedCount(1);
    if (a === 0 && b === 0) {
      return this._endMatch(
        -1, 'no-contest',
        { terminationReason: 'aborted', outcomeReason: 'no-contest', aggregate: false },
        true,
      );
    }
    if (a === 0) return this._endMatch(1, 'forfeit', { terminationReason: 'aborted', outcomeReason: 'forfeit', aggregate: true });
    if (b === 0) return this._endMatch(0, 'forfeit', { terminationReason: 'aborted', outcomeReason: 'forfeit', aggregate: true });
    return undefined;
  }

  // ──────────────────────────────────────────────────────────────────────── §11 state

  /**
   * The serialisable ruleset state. This is the shape the wire additions (§11) carry and
   * the shape `bombtest` compares byte-for-byte across two identical runs, so everything
   * that can influence an outcome must appear here and nothing that cannot may.
   */
  state() {
    const alive = this.aliveCounts();
    return {
      phase: this.phase,
      roundNumber: this.roundNumber,
      roundIndex: this.roundIndex,
      attackingTeam: this.attackingTeam,
      roundWins: [this.roundWins[0], this.roundWins[1]],
      phaseTicks: this.phaseTicks,
      roundTicks: this.roundTicks,
      bombTicks: this.bombTicks,
      aliveCounts: alive,
      bomb: {
        state: this.bomb.state,
        carrierId: this.bomb.carrierId,
        siteId: this.bomb.siteId,
        x: this.bomb.position.x, y: this.bomb.position.y, z: this.bomb.position.z,
      },
      progress: [...this._progress.entries()]
        .sort((p, q) => p[0] - q[0])
        .map(([id, prog]) => ({ id, kind: prog.kind, ticks: prog.ticks, wire: this.progressOf(id) })),
      progressActor: this.progressActor,
      eliminated: [...this.eliminated].sort((p, q) => p - q),
      objectiveStats: [...this.objectiveStats.entries()]
        .sort((p, q) => p[0] - q[0])
        .map(([id, row]) => ({ id, plants: row.plants, defuses: row.defuses })),
      rounds: this.rounds.map((r) => ({ ...r })),
      series: this.series ? { ...this.series } : null,
      events: this.events.map((e) => ({ ...e })),
    };
  }
}
