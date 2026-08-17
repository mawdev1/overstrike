import * as THREE from 'three';

/**
 * OVERSTRIKE — spawn selection.
 *
 * A shooter lives or dies on this file. Spawning into an enemy's crosshair is the single
 * fastest way to make a match feel broken, so every candidate point is scored against the
 * live tactical picture and the worst outcomes (direct line of sight, spawning on top of
 * the guy who just killed you, re-using the point you just died at) are priced out of
 * contention rather than merely discouraged.
 *
 * Scoring is deliberately additive and readable — tuning is a matter of moving one
 * constant, and every term is documented with the feel it protects.
 */

const _eyeA = new THREE.Vector3();
const _eyeB = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _toEnemy = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _up = new THREE.Vector3(0, 1, 0);
const _probe = new THREE.Vector3();

/** Scoring weights. Positive = desirable. */
export const SPAWN_WEIGHTS = {
  base: 100,
  losEnemy: -1400,      // per enemy with clear eye-to-eye LOS (max 2 counted)
  losMaxCount: 2,
  proximity: -800,      // scaled by inverse-square falloff inside `proximityRange`
  proximityRange: 25,
  recentUse: -300,      // decays to 0 over `recentWindow` seconds
  recentWindow: 12,
  deathSpot: -900,      // you died here moments ago; do not put you back
  deathRadius: 8,
  deathWindow: 25,
  friendlyIdeal: 140,   // peak reward for spawning near, but not on top of, a team-mate
  friendlyNearBand: 8,
  friendlyFarBand: 24,
  friendlyCrowd: -90,   // closer than 4 m to a friendly: you two will collide
  facingAway: 90,       // point's authored yaw pointing away from the enemy mass
  teamMatch: 220,       // point tagged for your team
  teamMismatch: -500,   // point tagged for theirs
  jitter: 90,           // random tiebreak so spawns never become campable patterns
};

const CLAIM_RADIUS = 2.0;      // two entities may never spawn this close together...
const CLAIM_WINDOW = 0.25;     // ...within this many seconds (covers the whole tick)
const SPAWN_PROTECTION = 1.2;  // seconds of invulnerability, cancelled by firing
const EYE_DEFAULT = 1.62;

export class Spawner {
  constructor(game, match = null) {
    this.game = game;
    this.match = match || game.match || null;
    /** @type {Array<{position:THREE.Vector3, yaw:number, team:number, lastUsed:number}>} */
    this.points = [];
    /** @type {Array<{x:number,y:number,z:number,t:number}>} */
    this._claims = [];
    /** @type {Map<number, {position:THREE.Vector3, time:number}>} */
    this._deaths = new Map();
    /** @type {THREE.Vector3[]} cached open-space samples, also used by DOMINATION. */
    this._open = null;

    // Reused scratch — pickSpawn() runs inside fixedUpdate and must not allocate.
    this._pick = { position: new THREE.Vector3(), yaw: 0, index: -1 };
    this._enemies = [];
    this._friends = [];
    this._enemyCentroid = new THREE.Vector3();

    // Convenience handle for other systems (documented in the gameplay report).
    game.spawner = this;
  }

  init() { this.buildPoints(); }

  reset() {
    this.buildPoints();
    this._claims.length = 0;
    this._deaths.clear();
    for (const p of this.points) p.lastUsed = -999;
  }

  get now() { return this.match?.elapsed ?? this.game.time ?? 0; }

  // ------------------------------------------------------------------- points

  /** Snapshot the level's spawn points; top up with open-space samples if it is thin. */
  buildPoints() {
    const world = this.game.world;
    this.points.length = 0;
    const src = world?.spawnPoints;
    if (Array.isArray(src)) {
      for (const sp of src) {
        if (!sp?.position) continue;
        this.points.push({
          position: new THREE.Vector3(sp.position.x, sp.position.y, sp.position.z),
          yaw: typeof sp.yaw === 'number' ? sp.yaw : 0,
          team: typeof sp.team === 'number' ? sp.team : -1,
          lastUsed: -999,
        });
      }
    }
    if (this.points.length < 8) {
      const extra = this.sampleOpenSpace(16 - this.points.length);
      for (const p of extra) {
        this.points.push({
          position: p.clone(),
          yaw: (this.game.rng?.() ?? Math.random()) * Math.PI * 2,
          team: -1,
          lastUsed: -999,
        });
      }
    }
    return this.points;
  }

  /**
   * Random points on walkable floor with headroom, spread apart. Used to top up thin
   * spawn data and to place DOMINATION objectives. Called at load/reset only.
   * @returns {THREE.Vector3[]} freshly allocated (not pooled) — safe to keep.
   */
  sampleOpenSpace(count = 12, minSeparation = 6) {
    if (this._open && this._open.length >= count) return this._open.slice(0, count);
    const world = this.game.world;
    const b = world?.bounds;
    const rng = this.game.rng || Math.random;
    const out = [];
    if (!b?.min || !b?.max) { this._open = out; return out; }

    const pad = 2.5;
    const minX = b.min.x + pad;
    const maxX = b.max.x - pad;
    const minZ = b.min.z + pad;
    const maxZ = b.max.z - pad;
    const topY = b.max.y - 0.25;
    const span = (b.max.y - b.min.y) + 2;
    const sepSq = minSeparation * minSeparation;
    const attempts = Math.max(80, count * 40);

    for (let i = 0; i < attempts && out.length < count; i++) {
      const x = minX + (typeof rng === 'function' ? rng() : Math.random()) * (maxX - minX);
      const z = minZ + (typeof rng === 'function' ? rng() : Math.random()) * (maxZ - minZ);
      _probe.set(x, topY, z);
      let y = null;
      if (typeof world.raycast === 'function') {
        const hit = world.raycast(_probe, _down, span);
        if (!hit || !hit.point) continue;
        if (hit.normal && hit.normal.y < 0.7) continue; // wall or ceiling, not floor
        y = hit.point.y + 0.03;
        // Headroom: a standing operator needs ~1.9 m.
        _probe.set(x, y + 0.25, z);
        const up = world.raycast(_probe, _up, 1.75);
        if (up) continue;
      } else {
        y = b.min.y + 0.03;
      }
      let tooClose = false;
      for (const p of out) {
        const dx = p.x - x;
        const dz = p.z - z;
        if (dx * dx + dz * dz < sepSq) { tooClose = true; break; }
      }
      if (tooClose) continue;
      out.push(new THREE.Vector3(x, y, z));
    }
    this._open = out;
    return out;
  }

  // -------------------------------------------------------------------- deaths

  /** Remember where an entity died so we do not feed it straight back in. */
  noteDeath(entity, position = entity?.position) {
    if (!entity || !position) return;
    let rec = this._deaths.get(entity.id);
    if (!rec) this._deaths.set(entity.id, (rec = { position: new THREE.Vector3(), time: 0 }));
    rec.position.copy(position);
    rec.time = this.now;
  }

  // ------------------------------------------------------------------ scoring

  _gatherActors(entity) {
    const enemies = this._enemies;
    const friends = this._friends;
    enemies.length = 0;
    friends.length = 0;
    this._enemyCentroid.set(0, 0, 0);
    const ents = this.game.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e === entity || !e.alive) continue;
      if (this._hostile(entity, e)) {
        enemies.push(e);
        this._enemyCentroid.add(e.position);
      } else {
        friends.push(e);
      }
    }
    if (enemies.length > 0) this._enemyCentroid.multiplyScalar(1 / enemies.length);
  }

  _hostile(a, b) {
    const m = this.match;
    if (m && typeof m.areEnemies === 'function') return m.areEnemies(a, b);
    return a.team !== b.team;
  }

  _eyeOf(entity, out) {
    if (typeof entity.getEyePosition === 'function') {
      const r = entity.getEyePosition(out);
      if (r) return r;
    }
    return out.set(entity.position.x, entity.position.y + (entity.eyeHeight || EYE_DEFAULT), entity.position.z);
  }

  _claimed(point) {
    const now = this.now;
    const claims = this._claims;
    for (let i = 0; i < claims.length; i++) {
      const c = claims[i];
      if (now - c.t > CLAIM_WINDOW) continue;
      const dx = c.x - point.x;
      const dy = c.y - point.y;
      const dz = c.z - point.z;
      if (dx * dx + dy * dy + dz * dz < CLAIM_RADIUS * CLAIM_RADIUS) return true;
    }
    return false;
  }

  _pruneClaims() {
    const now = this.now;
    const claims = this._claims;
    for (let i = claims.length - 1; i >= 0; i--) {
      if (now - claims[i].t > CLAIM_WINDOW) claims.splice(i, 1);
    }
  }

  /** Score one candidate. Higher is better; -Infinity means "never". */
  scorePoint(point, entity) {
    const W = SPAWN_WEIGHTS;
    const world = this.game.world;
    const now = this.now;
    let score = W.base;

    if (this._claimed(point.position)) return -Infinity;

    // --- team ownership of the point
    if (point.team === 0 || point.team === 1) {
      const myTeam = entity.team === 1 ? 1 : 0;
      score += point.team === myTeam ? W.teamMatch : W.teamMismatch;
    }

    // --- recency
    const age = now - point.lastUsed;
    if (age < W.recentWindow) score += W.recentUse * (1 - age / W.recentWindow);

    // --- the spot you just died at
    const death = this._deaths.get(entity.id);
    if (death && now - death.time < W.deathWindow) {
      const d = point.position.distanceTo(death.position);
      if (d < W.deathRadius) score += W.deathSpot * (1 - d / W.deathRadius);
    }

    // --- enemies: line of sight first, then raw proximity
    _eyeA.set(point.position.x, point.position.y + EYE_DEFAULT, point.position.z);
    const enemies = this._enemies;
    let losCount = 0;
    const rangeSq = W.proximityRange * W.proximityRange;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const dSq = point.position.distanceToSquared(e.position);
      if (dSq < rangeSq) {
        // Inverse-square-ish: brutal up close, negligible at the edge of the range.
        score += W.proximity / (1 + dSq * 0.04);
      }
      if (losCount < W.losMaxCount && dSq < 6400) {
        this._eyeOf(e, _eyeB);
        if (!world?.losClear || world.losClear(_eyeA, _eyeB)) {
          losCount++;
          score += W.losEnemy;
        }
      }
    }

    // --- friendlies: spawning with the squad is good, spawning inside them is not
    const friends = this._friends;
    for (let i = 0; i < friends.length; i++) {
      const d = point.position.distanceTo(friends[i].position);
      if (d < 4) score += W.friendlyCrowd;
      else if (d < W.friendlyFarBand) {
        // Peak reward in the middle of the band, tapering to 0 at either end.
        const t = d < W.friendlyNearBand
          ? (d - 4) / Math.max(0.001, W.friendlyNearBand - 4)
          : 1 - (d - W.friendlyNearBand) / (W.friendlyFarBand - W.friendlyNearBand);
        score += W.friendlyIdeal * Math.max(0, t);
      }
    }

    // --- orientation: prefer points whose facing puts the enemy mass behind you,
    //     i.e. you are looking into your own half rather than into their guns.
    if (enemies.length > 0) {
      _fwd.set(-Math.sin(point.yaw), 0, -Math.cos(point.yaw));
      _toEnemy.copy(this._enemyCentroid).sub(point.position).setY(0);
      if (_toEnemy.lengthSq() > 1e-4) {
        _toEnemy.normalize();
        score += W.facingAway * (0.5 - 0.5 * _fwd.dot(_toEnemy));
      }
    }

    // --- tiebreak
    const rng = this.game.rng;
    score += (typeof rng === 'function' ? rng() : Math.random()) * W.jitter;
    return score;
  }

  /**
   * Best available spawn for `entity`.
   * @returns {{position:THREE.Vector3, yaw:number, index:number}} POOLED — copy what you keep.
   */
  pickSpawn(entity) {
    this._pruneClaims();
    this._gatherActors(entity);

    const pts = this.points;
    let best = -Infinity;
    let bestIdx = -1;
    for (let i = 0; i < pts.length; i++) {
      const s = this.scorePoint(pts[i], entity);
      if (s > best) { best = s; bestIdx = i; }
    }

    const out = this._pick;
    if (bestIdx < 0) {
      // Nothing at all (no level data yet). Put them at the origin of the play space
      // rather than at (0,0,0) under the floor.
      const b = this.game.world?.bounds;
      if (b?.min && b?.max) {
        out.position.set((b.min.x + b.max.x) * 0.5, b.min.y + 0.1, (b.min.z + b.max.z) * 0.5);
      } else out.position.set(0, 0.1, 0);
      out.yaw = 0;
      out.index = -1;
      return out;
    }

    const p = pts[bestIdx];
    out.position.copy(p.position);
    out.yaw = p.yaw;
    out.index = bestIdx;
    return out;
  }

  /**
   * Place `entity` at a scored spawn, restore it to fighting condition and announce it.
   * Spawn protection is granted by the Match (which owns the timer) via its `spawn`
   * listener; see Match.isProtected().
   */
  spawnEntity(entity) {
    if (!entity) return false;
    const pick = this.pickSpawn(entity);

    if (pick.index >= 0) this.points[pick.index].lastUsed = this.now;
    this._claims.push({ x: pick.position.x, y: pick.position.y, z: pick.position.z, t: this.now });

    // Prefer the entity's own re-entry routine — it restores the loadout, model,
    // AI blackboard and controller state that we cannot see from here, and emits the
    // canonical `spawn` itself. Bot.spawn(position, yaw) / Player.respawn({position,yaw}).
    if (!entity.isPlayer && typeof entity.spawn === 'function') {
      entity.spawn(pick.position, pick.yaw);
      return true;
    }
    if (typeof entity.respawn === 'function') {
      entity.respawn(pick);
      return true;
    }
    if (typeof entity.spawn === 'function') {
      entity.spawn(pick.position, pick.yaw);
      return true;
    }

    // Fallback: place it ourselves.
    entity.position.copy(pick.position);
    entity.velocity?.set(0, 0, 0);
    entity.yaw = pick.yaw;
    entity.pitch = 0;
    entity.health = entity.maxHealth ?? 100;
    entity.armor = 0;
    entity.alive = true;

    this.refillAmmo(entity);
    entity.onRespawn?.(pick.position, pick.yaw);

    this.game.bus?.emit('spawn', { entity });
    return true;
  }

  /** Top up the current weapon and reserve, whichever API the weapon system exposes. */
  refillAmmo(entity) {
    const w = this.game.weapons;
    if (w) {
      if (typeof w.refill === 'function') { w.refill(entity); return; }
      if (typeof w.resetAmmo === 'function') { w.resetAmmo(entity); return; }
    }
    const inst = entity.weapon;
    if (inst?.def) {
      inst.ammo = inst.def.magSize ?? inst.ammo;
      inst.reserve = inst.def.reserve ?? inst.reserve;
      inst.state = 'idle';
    }
  }

  /** Spawn protection duration used by the Match. */
  static get PROTECTION_TIME() { return SPAWN_PROTECTION; }

  dispose() {
    this.points.length = 0;
    this._claims.length = 0;
    this._deaths.clear();
    if (this.game.spawner === this) this.game.spawner = null;
  }
}

export { SPAWN_PROTECTION };
