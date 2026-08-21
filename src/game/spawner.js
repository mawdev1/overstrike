import * as THREE from 'three';
import { createRNG } from '../core/rng.js';

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

/**
 * ── The interface this file needs from a MODE ────────────────────────────────────────
 *
 * `src/game/modes.js` and `src/game/match.js` are owned by another lane. The spawner does
 * not import either; it reads two optional properties off `match.mode` and nothing else.
 *
 *   mode.spawnPolicy : 'dynamic' | 'fixed'
 *       ABSENT means 'dynamic'. TDM is dynamic. Bomb declares 'fixed' — bomb-rules.md §2
 *       has no respawn at all, so a round's placement is a positioning ritual at `freeze`,
 *       not a tactical response to a live fight, and running the dynamic scorer over it
 *       would move a team's spawn depending on where the enemy happened to be standing.
 *
 *   mode.fixedSpawnGroup(match, team) -> string | null      (only read when policy==='fixed')
 *       The manifest `group` id that `team` occupies for the CURRENT round. This is where
 *       Bomb's side switch after round 6 lives: the mode returns the other group id, and
 *       the spawner needs to know nothing about rounds. Returning null (or not
 *       implementing it) falls back to that team's largest own-team group, which is
 *       correct for a two-group map and reported by `describeGroups()` either way.
 *
 * Nothing else is consulted. A mode that declares neither property gets exactly today's
 * TDM behaviour.
 */
export const SPAWN_POLICY = Object.freeze({ DYNAMIC: 'dynamic', FIXED: 'fixed' });

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

  // ── added for P3.A2, each one paid for by a metric in scripts/mapbalance.mjs ────────

  /**
   * The point is inside a living enemy's ENGAGEMENT ENVELOPE: close enough to shoot, in
   * front of them, and with a clear line. This is exactly the event
   * `spawn-flip-into-enemy rate` counts, so it gets its own term rather than being left
   * to `losEnemy` — LOS alone fires for an enemy who is 70 m away with their back turned,
   * which is not the failure anybody feels.
   *
   * `enemyConeCos` is cos(50°); a 100° total cone is a little wider than the default
   * 90° horizontal FOV so that "just off screen, one flick away" still counts as caught.
   */
  enemyCone: -1700,
  enemyConeRange: 30,
  enemyConeCos: 0.6428,

  /**
   * Recent death locations — ANYONE's, not just yours. `deathSpot` above only knows where
   * the spawning entity itself died; the plan asks for recent death locations as a
   * tactical input, and a cell where three people have just died in 20 s is contested
   * ground whether or not one of them was you.
   */
  deathHeat: -140,      // per recent death inside `deathHeatRadius`, decayed by age
  deathHeatRadius: 11,
  deathHeatMax: 4,      // cap so one massacre cannot outweigh a live enemy in your face
  deathHeatWindow: 20,

  /**
   * Combat pressure: shots fired and damage landed near the point in the last
   * `pressureWindow` seconds. Deaths are a lagging indicator of a firefight; muzzle
   * flashes are the leading one, and a spawn wants the leading one.
   */
  pressure: -260,
  pressureRadius: 15,
  pressureMax: 6,
  pressureWindow: 7,

  // ── group-level terms (map-data.md §3.2: "group is what the scorer selects between") ──
  groupFriendly: 90,        // per living team-mate anywhere in the group, capped
  groupFriendlyMax: 3,
  groupEnemy: -650,         // per living enemy inside the group's footprint, capped
  groupEnemyMax: 3,
  groupRecentUse: -220,     // the group was used this instant; decays over the window
  groupRecentWindow: 7,
};

const CLAIM_RADIUS = 2.0;      // two entities may never spawn this close together...
const CLAIM_WINDOW = 0.25;     // ...within this many seconds (covers the whole tick)
const SPAWN_PROTECTION = 1.2;  // seconds of invulnerability, cancelled by firing
const EYE_DEFAULT = 1.62;

/**
 * Enemies whose eye-to-eye line is actually marched, per candidate point.
 *
 * `losMaxCount` bounds how many CLEAR lines are priced in; it does not bound the work,
 * because a blocked line costs a full march and is not counted. On a cover-dense map
 * that meant every enemy within `LOS_RANGE` was marched for every point — measured at
 * 220 marches for a single mid-match pick. The three nearest enemies are
 * the only ones whose sightline can plausibly matter, so probing is hard-capped at three
 * regardless of outcome and served nearest-first.
 */
const LOS_PROBE_MAX = 3;
const LOS_RANGE_SQ = 6400;     // 80 m

/**
 * Below this many surviving candidates, a team-mismatched point is scored the old way
 * (with the -500 penalty) instead of being pruned. Pruning is only ever a shortcut for
 * "this point has never won a contest"; it must not be allowed to starve the field.
 */
const MIN_TEAM_CANDIDATES = 6;

/**
 * Groups a DERIVED manifest is split into, per team.
 *
 * map-data.md §3.2 wants ≥3 groups per team and makes `group` the thing the scorer selects
 * between. MERIDIAN predates the contract, so `world.js` derives ONE group per team
 * (`meridian-alpha`, `meridian-bravo`, `meridian-neutral`) — which leaves the group-level
 * terms with nothing to discriminate. When, and only when, the manifest reports its groups
 * as derived, each is split into this many (see `_subCluster`). A map that DECLARES its
 * groups is used exactly as declared and is never re-clustered — this is a compatibility
 * shim for pre-contract geometry, not a policy.
 */
const DERIVED_GROUPS_PER_TEAM = 3;

export class Spawner {
  constructor(game, match = null) {
    this.game = game;
    this.match = match || game.match || null;
    /** @type {Array<{id:string, position:THREE.Vector3, yaw:number, team:number, group:number, groupId:string, protectionRadius:number, lastUsed:number}>} */
    this.points = [];
    /** @type {Array<{id:string, team:number, points:number[], centre:THREE.Vector3, radius:number, lastUsed:number}>} */
    this.groups = [];
    /** Per-group scratch, resized with `groups`. Filled once per pickSpawn(). */
    this._gFriend = [];
    this._gEnemy = [];
    /** Where the spawns came from — 'declared' | 'derived' | 'legacy'. Reported, not asserted on. */
    this.spawnSource = 'legacy';
    /**
     * Last placement made, for harnesses and evidence. Rewritten in place — never kept.
     * @type {{index:number, id:string, groupId:string, policy:string, entityId:number}}
     */
    this.lastPick = { index: -1, id: '', groupId: '', policy: SPAWN_POLICY.DYNAMIC, entityId: -1 };
    /** @type {Array<{x:number,y:number,z:number,t:number}>} */
    this._claims = [];
    /** @type {Map<number, {position:THREE.Vector3, time:number}>} */
    this._deaths = new Map();
    /**
     * Recent death sites and recent gunfire, as flat number records.
     *
     * Deliberately NOT entity references. `auditG.mjs` exists because this class has
     * leaked cross-match entity references before; a ring of plain floats cannot.
     * @type {Array<{x:number,y:number,z:number,t:number}>}
     */
    this._deathHeat = [];
    /** @type {Array<{x:number,y:number,z:number,t:number}>} */
    this._pressure = [];
    this._busUnsub = [];
    /** @type {THREE.Vector3[]} cached open-space samples for spawn analysis/tooling. */
    this._open = null;
    /** The request that produced `_open` — see sampleOpenSpace() for why length is not it. */
    this._openCount = -1;
    this._openSep = -1;
    /**
     * Open-space sampling gets its OWN fixed-seed stream rather than `game.rng`.
     *
     * It is level geometry, not gameplay randomness: the same map must yield the same
     * objective placement on every machine and in every match. Taking it off the sim RNG
     * also removes hundreds of draws from match start, which is what made
     * "cache the sweep" change the RNG stream between the first match of a session and
     * every later one.
     */
    this._sampleRng = createRNG(0x5A17B0FF);

    // Reused scratch — pickSpawn() runs inside fixedUpdate and must not allocate.
    this._pick = { position: new THREE.Vector3(), yaw: 0, index: -1 };
    this._enemies = [];
    this._friends = [];
    this._enemyCentroid = new THREE.Vector3();
    /** Set only for the overflow pass in pickSpawn() — see the comment there. */
    this._ignoreClaims = false;

    // Convenience handle for other systems (documented in the gameplay report).
    game.spawner = this;
  }

  init() {
    this.buildPoints();
    this._subscribe();
  }

  /**
   * Combat pressure comes off the event bus, not from a hook another lane has to remember
   * to call. `shot` is the leading indicator (a muzzle flash means a fight is HAPPENING
   * there); `damage` confirms it. Both carry a world position already, so this costs one
   * push per event and no allocation beyond the ring.
   */
  _subscribe() {
    this._unsubscribe();
    const bus = this.game?.bus;
    if (!bus || typeof bus.on !== 'function') return;
    const push = (v) => {
      if (!v) return;
      this._pressure.push({ x: v.x, y: v.y, z: v.z, t: this.now });
      if (this._pressure.length > 256) this._pressure.shift();
    };
    this._busUnsub.push(bus.on('shot', (p) => push(p?.origin)));
    this._busUnsub.push(bus.on('damage', (p) => push(p?.point)));
  }

  _unsubscribe() {
    for (const off of this._busUnsub) { if (typeof off === 'function') off(); }
    this._busUnsub.length = 0;
  }

  reset() {
    this.buildPoints();
    this._claims.length = 0;
    this._deaths.clear();
    this._deathHeat.length = 0;
    this._pressure.length = 0;
    for (const g of this.groups) g.lastUsed = -999;
    for (const p of this.points) p.lastUsed = -999;
    // The open-space sweep has its own fixed stream (see the constructor) so it cannot
    // be perturbed by gameplay draws — but it still has to be rewound per match, or a
    // sweep that misses the cache (a mode asking for more points than the last one did)
    // runs from wherever the previous match left the stream and places objectives
    // somewhere a fresh process never would.
    this._sampleRng.reseed(0x5A17B0FF);
  }

  get now() { return this.match?.elapsed ?? this.game.time ?? 0; }

  // ------------------------------------------------------------------- points

  /**
   * Snapshot the map's spawn markers; top up with open-space samples if it is thin.
   *
   * The source of truth is the MAP MANIFEST (`world.manifest.spawns`, map-data.md §3.2) —
   * there are no spawn coordinates in this file and there never will be. `world.spawnPoints`
   * is the pre-contract fallback for a world built without a manifest (a bare harness, or
   * a level module that predates `buildManifest`); it carries the same `{position, yaw,
   * team}` records, just without ids, groups or mode tags.
   */
  buildPoints() {
    const world = this.game.world;
    this.points.length = 0;
    this.groups.length = 0;

    const manifest = world?.manifest;
    const declared = manifest !== null && manifest !== undefined && Array.isArray(manifest.spawns);
    const src = declared ? manifest.spawns : (Array.isArray(world?.spawnPoints) ? world.spawnPoints : []);
    this.spawnSource = declared
      ? (manifest.provenance?.spawns === 'declared' ? 'declared' : 'derived')
      : 'legacy';

    /**
     * `modes` is only honoured when the producer AUTHORED it. `world.js` stamps
     * `modes: ['tdm']` onto every derived spawn as a default, so honouring it on a derived
     * manifest would leave Bomb on MERIDIAN with zero candidates — a filter that empties
     * the field is worse than no filter, and "the map never said" is not "the map said no".
     */
    const modeId = this.match?.mode?.id ?? this.match?.modeId ?? null;
    const filterModes = this.spawnSource === 'declared' && typeof modeId === 'string';

    const take = (sp, i) => this.points.push({
      id: typeof sp.id === 'string' ? sp.id : `unnamed-${i}`,
      position: new THREE.Vector3(sp.position.x, sp.position.y, sp.position.z),
      yaw: typeof sp.yaw === 'number' ? sp.yaw : 0,
      team: typeof sp.team === 'number' ? sp.team : -1,
      groupId: typeof sp.group === 'string' ? sp.group : '',
      protectionRadius: typeof sp.protectionRadius === 'number' ? sp.protectionRadius : 4.0,
      group: -1,
      lastUsed: -999,
    });

    for (let i = 0; i < src.length; i++) {
      const sp = src[i];
      if (!sp || !sp.position) continue;
      if (filterModes && Array.isArray(sp.modes) && !sp.modes.includes(modeId)) continue;
      take(sp, i);
    }

    /**
     * A mode filter that leaves a team with nothing is a map-authoring mistake, and the
     * spawner's job is to keep the match playable while making the mistake loud. Falling
     * back to the unfiltered set puts players on the map; refusing to would stack the
     * whole team on the play-space centre, which is how a data error becomes a bug report
     * about spawning.
     */
    if (filterModes) {
      const per = [0, 0];
      for (const p of this.points) { if (p.team === 0 || p.team === 1) per[p.team]++; }
      const rawPer = [0, 0];
      for (const sp of src) { const t = sp?.team; if (t === 0 || t === 1) rawPer[t]++; }
      if ((per[0] === 0 && rawPer[0] > 0) || (per[1] === 0 && rawPer[1] > 0)) {
        console.warn(`[spawner] no '${modeId}' spawns declared for team ${per[0] === 0 ? 0 : 1} on ${manifest.mapId ?? 'this map'} — ignoring the mode filter`);
        this.points.length = 0;
        for (let i = 0; i < src.length; i++) { if (src[i]?.position) take(src[i], i); }
      }
    }

    if (this.points.length < 8) {
      const extra = this.sampleOpenSpace(16 - this.points.length);
      for (let i = 0; i < extra.length; i++) {
        this.points.push({
          id: `open-space-${i}`,
          position: extra[i].clone(),
          yaw: (this.game.rng?.() ?? Math.random()) * Math.PI * 2,
          team: -1,
          groupId: 'open-space',
          protectionRadius: 4.0,
          group: -1,
          lastUsed: -999,
        });
      }
    }

    this._buildGroups();
    return this.points;
  }

  // -------------------------------------------------------------------- groups

  /**
   * Partition the points into the groups the scorer selects between.
   *
   * Declared groups are used verbatim — the producer said what a pocket is and that is
   * the end of it. Derived groups (see GROUP_LINK_FACTOR) are sub-clustered, because
   * "every alpha spawn is one group" gives the group terms nothing to choose between.
   */
  _buildGroups() {
    const byId = new Map();
    for (let i = 0; i < this.points.length; i++) {
      const key = `${this.points[i].groupId}#${this.points[i].team}`;
      let bucket = byId.get(key);
      if (!bucket) byId.set(key, (bucket = []));
      bucket.push(i);
    }

    const emit = (label, team, idxs) => {
      const g = {
        id: label,
        team,
        points: idxs,
        centre: new THREE.Vector3(),
        radius: 0,
        lastUsed: -999,
      };
      for (const i of idxs) g.centre.add(this.points[i].position);
      g.centre.multiplyScalar(1 / Math.max(1, idxs.length));
      for (const i of idxs) {
        const d = this.points[i].position.distanceTo(g.centre);
        if (d > g.radius) g.radius = d;
      }
      // A single-point group still owns the ground around it; use its protection volume.
      g.radius = Math.max(g.radius, this.points[idxs[0]].protectionRadius);
      const gi = this.groups.length;
      this.groups.push(g);
      for (const i of idxs) { this.points[i].group = gi; this.points[i].groupId = label; }
    };

    for (const [key, idxs] of byId) {
      const label = key.slice(0, key.lastIndexOf('#'));
      const team = this.points[idxs[0]].team;
      if (this.spawnSource === 'declared' || idxs.length < 3) { emit(label, team, idxs); continue; }
      const clusters = this._subCluster(idxs);
      if (clusters.length === 1) { emit(label, team, clusters[0]); continue; }
      for (let c = 0; c < clusters.length; c++) emit(`${label}-${c + 1}`, team, clusters[c]);
    }

    this._gFriend.length = this.groups.length;
    this._gEnemy.length = this.groups.length;
    return this.groups;
  }

  /**
   * Split one DERIVED group into the contract's minimum number of groups.
   *
   * `k = min(DERIVED_GROUPS_PER_TEAM, n)`, cut at the k-1 widest gaps along the group's
   * longer horizontal axis. Two properties matter more than cluster quality:
   *
   *  - it is SYMMETRIC. A threshold rule gave MERIDIAN's team 0 two groups and team 1 one,
   *    purely because one lane gap fell either side of the threshold — and then the
   *    group-recency term applied to one team and not the other, which is a spawn-fairness
   *    bug invented by the clustering rule rather than present in the map.
   *  - the count comes from map-data.md §3.2 ("Minimum per team, TDM: 8, spread across ≥3
   *    groups"), not from a tuned metres constant.
   */
  _subCluster(idxs) {
    const n = idxs.length;
    const k = Math.min(DERIVED_GROUPS_PER_TEAM, n);
    if (k < 2) return [idxs];
    const pos = idxs.map((i) => this.points[i].position);
    let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
    for (const p of pos) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    const alongX = (maxX - minX) >= (maxZ - minZ);
    const order = idxs.map((v, j) => j);
    const key = (j) => (alongX ? pos[j].x : pos[j].z);
    // Sort on the axis, ties broken by the other axis then by manifest index: a total
    // order, so the partition cannot depend on the sort implementation.
    order.sort((a, b) => (key(a) - key(b))
      || ((alongX ? pos[a].z - pos[b].z : pos[a].x - pos[b].x))
      || (idxs[a] - idxs[b]));
    const gaps = [];
    for (let j = 1; j < n; j++) gaps.push({ at: j, d: key(order[j]) - key(order[j - 1]) });
    gaps.sort((a, b) => (b.d - a.d) || (a.at - b.at));
    const cuts = new Set(gaps.slice(0, k - 1).map((g) => g.at));
    const out = [];
    let cur = [];
    for (let j = 0; j < n; j++) {
      if (cuts.has(j) && cur.length) { out.push(cur); cur = []; }
      cur.push(idxs[order[j]]);
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /** Human-readable group table. Used by harnesses and the balance report. */
  describeGroups() {
    return this.groups.map((g) => ({
      id: g.id, team: g.team, count: g.points.length,
      centre: { x: g.centre.x, y: g.centre.y, z: g.centre.z }, radius: g.radius,
    }));
  }

  /**
   * Random points on walkable floor with headroom, spread apart. Used to top up thin
   * spawn data and offline map analysis. Called at load/reset only.
   * @returns {THREE.Vector3[]} freshly allocated (not pooled) — safe to keep.
   */
  sampleOpenSpace(count = 12, minSeparation = 6) {
    // Cache on "the sweep has already run for at least this request", NOT on how many
    // points came back. A map that cannot fit `count` points at `minSeparation` can
    // never satisfy a length test, so the old `_open.length >= count` guard re-ran the
    // full max(80, count*40)-attempt sweep — 960 attempts at up to two raycasts each —
    // on every single match start, forever.
    if (this._open && this._openCount >= count && this._openSep === minSeparation) {
      return this._open.slice(0, Math.min(count, this._open.length));
    }
    const world = this.game.world;
    const b = world?.bounds;
    const rng = this._sampleRng;
    const out = [];
    this._openCount = count;
    this._openSep = minSeparation;
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
      const x = minX + rng() * (maxX - minX);
      const z = minZ + rng() * (maxZ - minZ);
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
    // ...and to the shared heat map, which every entity reads. See SPAWN_WEIGHTS.deathHeat.
    this._deathHeat.push({ x: position.x, y: position.y, z: position.z, t: this.now });
    if (this._deathHeat.length > 128) this._deathHeat.shift();
  }

  /** Drop heat and pressure records that have aged out of their windows. */
  _pruneVolatile() {
    const now = this.now;
    const W = SPAWN_WEIGHTS;
    for (let i = this._deathHeat.length - 1; i >= 0; i--) {
      if (now - this._deathHeat[i].t > W.deathHeatWindow) this._deathHeat.splice(i, 1);
    }
    for (let i = this._pressure.length - 1; i >= 0; i--) {
      if (now - this._pressure[i].t > W.pressureWindow) this._pressure.splice(i, 1);
    }
  }

  /**
   * Sum of age-decayed records within `radius` of a point, capped at `cap`.
   * Shared by the death-heat and combat-pressure terms — same shape, same decay.
   */
  _heatAt(list, point, radius, window, cap) {
    const now = this.now;
    const r2 = radius * radius;
    let sum = 0;
    for (let i = 0; i < list.length && sum < cap; i++) {
      const h = list[i];
      const age = now - h.t;
      if (age < 0 || age > window) continue;
      const dx = h.x - point.x;
      const dy = h.y - point.y;
      const dz = h.z - point.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      sum += (1 - age / window) * (1 - Math.sqrt(d2) / radius);
    }
    return Math.min(sum, cap);
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
    this._gatherGroupOccupancy();
  }

  /**
   * Who is standing in each group's footprint right now.
   *
   * Computed once per pick rather than once per candidate point: a group of six points
   * would otherwise re-count the same bodies six times. `radius + 6` because a group is
   * a pocket you spawn INTO and someone six metres outside its outermost point is
   * already in the fight you are about to land in.
   */
  _gatherGroupOccupancy() {
    const gs = this.groups;
    for (let g = 0; g < gs.length; g++) { this._gFriend[g] = 0; this._gEnemy[g] = 0; }
    for (let g = 0; g < gs.length; g++) {
      const grp = gs[g];
      const r = grp.radius + 6;
      const r2 = r * r;
      for (let i = 0; i < this._enemies.length; i++) {
        if (this._enemies[i].position.distanceToSquared(grp.centre) < r2) this._gEnemy[g]++;
      }
      for (let i = 0; i < this._friends.length; i++) {
        if (this._friends[i].position.distanceToSquared(grp.centre) < r2) this._gFriend[g]++;
      }
    }
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

    if (!this._ignoreClaims && this._claimed(point.position)) return -Infinity;

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

    // --- enemies: raw proximity for everyone, line of sight for the three nearest
    //
    // Proximity is a distance test and costs nothing, so it still runs against the whole
    // enemy list. Line of sight is a world march, so it is served nearest-first and hard
    // capped at LOS_PROBE_MAX probes — the old loop bounded only how many CLEAR lines it
    // priced in, which on a cover-dense map bounded nothing at all.
    _eyeA.set(point.position.x, point.position.y + EYE_DEFAULT, point.position.z);
    const enemies = this._enemies;
    const rangeSq = W.proximityRange * W.proximityRange;
    // Three-slot insertion sort of the nearest in-range enemies. Fixed size, no allocation.
    let n0 = null; let n1 = null; let n2 = null;
    let d0 = Infinity; let d1 = Infinity; let d2 = Infinity;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const dSq = point.position.distanceToSquared(e.position);
      if (dSq < rangeSq) {
        // Inverse-square-ish: brutal up close, negligible at the edge of the range.
        score += W.proximity / (1 + dSq * 0.04);
      }
      if (dSq >= LOS_RANGE_SQ) continue;
      if (dSq < d0) { d2 = d1; n2 = n1; d1 = d0; n1 = n0; d0 = dSq; n0 = e; }
      else if (dSq < d1) { d2 = d1; n2 = n1; d1 = dSq; n1 = e; }
      else if (dSq < d2) { d2 = dSq; n2 = e; }
    }
    let losCount = 0;
    const coneRangeSq = W.enemyConeRange * W.enemyConeRange;
    for (let k = 0; k < LOS_PROBE_MAX; k++) {
      const e = k === 0 ? n0 : (k === 1 ? n1 : n2);
      if (!e) break;
      this._eyeOf(e, _eyeB);
      if (world?.losClear && !world.losClear(_eyeA, _eyeB)) continue;
      if (losCount < W.losMaxCount) { losCount++; score += W.losEnemy; }
      // ENGAGEMENT ENVELOPE, not merely a clear line: close, in front of them, visible.
      // The same march has already been paid for, so this term is free.
      const dSq = k === 0 ? d0 : (k === 1 ? d1 : d2);
      if (dSq > coneRangeSq) continue;
      _fwd.set(-Math.sin(e.yaw ?? 0), 0, -Math.cos(e.yaw ?? 0));
      _toEnemy.set(point.position.x - e.position.x, 0, point.position.z - e.position.z);
      if (_toEnemy.lengthSq() < 1e-4) { score += W.enemyCone; continue; }
      _toEnemy.normalize();
      if (_fwd.dot(_toEnemy) >= W.enemyConeCos) score += W.enemyCone;
    }

    // --- contested ground: where people have been dying, and where the shooting is
    score += W.deathHeat * this._heatAt(this._deathHeat, point.position, W.deathHeatRadius, W.deathHeatWindow, W.deathHeatMax);
    score += W.pressure * this._heatAt(this._pressure, point.position, W.pressureRadius, W.pressureWindow, W.pressureMax);

    // --- the group this point belongs to (map-data.md §3.2)
    const gi = point.group;
    if (gi >= 0 && gi < this.groups.length) {
      const grp = this.groups[gi];
      score += W.groupFriendly * Math.min(this._gFriend[gi] ?? 0, W.groupFriendlyMax);
      score += W.groupEnemy * Math.min(this._gEnemy[gi] ?? 0, W.groupEnemyMax);
      const gAge = now - grp.lastUsed;
      if (gAge < W.groupRecentWindow) score += W.groupRecentUse * (1 - gAge / W.groupRecentWindow);
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
    //
    // The ENTITY's own stream where it has one. Drawn from `game.rng`, the number of
    // draws depended on how many candidate points this spawn happened to score, so one
    // bot's spawn shifted the stream for every entity spawned after it in the same tick.
    // `Math.random()` is a last resort that must never be reached in the game; it exists
    // so a bare harness constructing a Spawner without a game cannot hard-fail.
    const rng = entity?.rng ?? this.game.rng;
    score += (typeof rng === 'function' ? rng() : Math.random()) * W.jitter;
    return score;
  }

  /**
   * Best available spawn for `entity`.
   * @returns {{position:THREE.Vector3, yaw:number, index:number}} POOLED — copy what you keep.
   */
  pickSpawn(entity) {
    this._pruneClaims();
    this._pruneVolatile();

    // Bomb (bomb-rules.md §2, §8) never consults the scorer. Branch BEFORE _gatherActors:
    // the fixed path must not even look at where the enemy is standing, or "fixed" is a
    // label rather than a property.
    if (this.policy === SPAWN_POLICY.FIXED) return this._pickFixed(entity);

    this._gatherActors(entity);

    const pts = this.points;
    const myTeam = entity.team === 1 ? 1 : 0;

    // Reject the other side's spawn points BEFORE scoring them rather than after.
    // `teamMismatch` is -500 against a base of 100 plus at most 220+140+90+90 of upside,
    // so a mismatched point can only ever win if EVERY eligible point is worse than
    // -355 — i.e. all of them have an enemy staring down them. Scoring them anyway cost
    // a full LOS sweep per point. The count guard preserves the old behaviour exactly
    // whenever pruning would actually narrow the field.
    let eligible = 0;
    for (let i = 0; i < pts.length; i++) {
      const t = pts[i].team;
      if (t !== 0 && t !== 1) eligible++;
      else if (t === myTeam) eligible++;
    }
    const prune = eligible >= MIN_TEAM_CANDIDATES;

    let best = -Infinity;
    let bestIdx = -1;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (prune && (p.team === 0 || p.team === 1) && p.team !== myTeam) continue;
      const s = this.scorePoint(p, entity);
      if (s > best) { best = s; bestIdx = i; }
    }

    // Overflow pass. Claims never expire inside a single `begin()` — every entity is
    // placed at the same `now` — so a lobby with more entities than spawn points runs
    // out of unclaimed candidates. Measured on this level: 18 points against a 24-bot
    // roster left SEVEN entities with no candidate at all, and the map-centre fallback
    // below stacked all seven on one pixel at the start of every match.
    //
    // Re-scoring with claims ignored is the right answer rather than the centre: the
    // `recentUse` term already carries a full -300 for a point used this instant, so the
    // overflow spreads itself across the least-recently-taken points instead of piling
    // onto one. Only reached when the first pass found nothing, so it costs nothing in
    // the normal case.
    if (bestIdx < 0) {
      this._ignoreClaims = true;
      try {
        for (let i = 0; i < pts.length; i++) {
          const s = this.scorePoint(pts[i], entity);
          if (s > best) { best = s; bestIdx = i; }
        }
      } finally {
        this._ignoreClaims = false;
      }
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

    return this._emit(bestIdx, entity, SPAWN_POLICY.DYNAMIC);
  }

  /** Fill and return the pooled pick record, and log what was chosen. */
  _emit(index, entity, policy) {
    const out = this._pick;
    const p = this.points[index];
    out.position.copy(p.position);
    out.yaw = p.yaw;
    out.index = index;
    const lp = this.lastPick;
    lp.index = index;
    lp.id = p.id;
    lp.groupId = p.groupId;
    lp.policy = policy;
    lp.entityId = entity?.id ?? -1;
    return out;
  }

  // ------------------------------------------------------------- fixed spawns

  /** `'dynamic'` unless the mode says otherwise. See the mode-interface note at the top. */
  get policy() {
    return this.match?.mode?.spawnPolicy === SPAWN_POLICY.FIXED
      ? SPAWN_POLICY.FIXED
      : SPAWN_POLICY.DYNAMIC;
  }

  /**
   * The group `team` occupies this round under a fixed-spawn ruleset.
   *
   * The mode decides (that is where Bomb's side switch lives). With no mode opinion, the
   * team's largest own-team group wins; ties break on group id, never on iteration order,
   * so two processes cannot disagree.
   */
  fixedGroupFor(team) {
    const declared = this.match?.mode?.fixedSpawnGroup?.(this.match, team);
    if (typeof declared === 'string') {
      for (const g of this.groups) if (g.id === declared) return g;
    }
    let best = null;
    for (const g of this.groups) {
      if (g.team !== team) continue;
      if (best === null
        || g.points.length > best.points.length
        || (g.points.length === best.points.length && g.id < best.id)) best = g;
    }
    return best;
  }

  /**
   * Fixed protected spawn (bomb-rules.md §2). No scoring, no LOS marches, no enemy
   * awareness at all — the round has not started, both teams are placed at the same
   * instant in `freeze`, and a "safer" point chosen from where the enemy happens to be
   * would leak enemy positions into a phase where nobody is allowed to know them.
   *
   * Within the team's protected group the choice is least-recently-used, which spreads
   * five players over five points instead of stacking them, with the entity's own seeded
   * stream breaking exact ties. `scorePoint` is never reached from here — asserted in
   * `scripts/mapbalance.mjs`.
   */
  _pickFixed(entity) {
    const team = entity?.team === 1 ? 1 : 0;
    const grp = this.fixedGroupFor(team);
    const pool = grp ? grp.points : null;
    if (!pool || pool.length === 0) {
      const out = this._pick;
      const b = this.game.world?.bounds;
      if (b?.min && b?.max) out.position.set((b.min.x + b.max.x) * 0.5, b.min.y + 0.1, (b.min.z + b.max.z) * 0.5);
      else out.position.set(0, 0.1, 0);
      out.yaw = 0;
      out.index = -1;
      const lp = this.lastPick;
      lp.index = -1; lp.id = ''; lp.groupId = ''; lp.policy = SPAWN_POLICY.FIXED;
      lp.entityId = entity?.id ?? -1;
      return out;
    }
    const rng = entity?.rng ?? this.game.rng;
    let bestIdx = -1;
    let bestKey = Infinity;
    for (let k = 0; k < pool.length; k++) {
      const i = pool[k];
      // Claimed this tick means another team-mate is already standing there.
      const claimPenalty = this._claimed(this.points[i].position) ? 1e6 : 0;
      const key = this.points[i].lastUsed + claimPenalty
        + (typeof rng === 'function' ? rng() : 0) * 1e-3;
      if (key < bestKey) { bestKey = key; bestIdx = i; }
    }
    return this._emit(bestIdx, entity, SPAWN_POLICY.FIXED);
  }

  /**
   * Place `entity` at a scored spawn, restore it to fighting condition and announce it.
   * Spawn protection is granted by the Match (which owns the timer) via its `spawn`
   * listener; see Match.isProtected().
   */
  spawnEntity(entity) {
    if (!entity) return false;
    const pick = this.pickSpawn(entity);

    if (pick.index >= 0) {
      const p = this.points[pick.index];
      p.lastUsed = this.now;
      if (p.group >= 0 && p.group < this.groups.length) this.groups[p.group].lastUsed = this.now;
    }
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
    this._unsubscribe();
    this.points.length = 0;
    this.groups.length = 0;
    this._claims.length = 0;
    this._deathHeat.length = 0;
    this._pressure.length = 0;
    this._deaths.clear();
    if (this.game.spawner === this) this.game.spawner = null;
  }
}

export { SPAWN_PROTECTION };
