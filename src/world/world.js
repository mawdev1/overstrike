import * as THREE from 'three';
import * as MERIDIAN from './level.js';

/**
 * World — static collision + level geometry.  See ARCHITECTURE.md §5.
 *
 * The world is a soup of axis-aligned boxes (400-900 of them) indexed by a uniform
 * spatial hash with 4 m cells, stored CSR-style (a prefix-summed start table plus a flat
 * item array) so every query is a tight integer loop over a handful of indices with zero
 * allocation.
 *
 * ── Allocation contract ────────────────────────────────────────────────────────────────
 *  `move()`, `raycast()`, `losClear()` and `sampleGroundHeight()` allocate NOTHING.
 *  `move()` returns a single module-scope pooled object; `raycast()` returns one of a
 *  ring of 8 pooled objects.  **Callers must copy anything they intend to keep past the
 *  next call.**  (`result.position.clone()`, `hit.normal.copy(out)`, …)
 */

// ── tuning ────────────────────────────────────────────────────────────────────────────
const CELL = 4;                 // spatial-hash cell size, metres
const INV_CELL = 1 / CELL;
const SKIN = 0.005;             // stop this far short of a surface, kills re-penetration jitter
const EPS = 1e-4;               // "touching does not count as overlapping" tolerance
const MAX_STEP_HEIGHT = 0.55;   // per ARCHITECTURE.md §5
const MIN_STEP_HEIGHT = 0.02;
const GROUND_PROBE = 0.08;      // a floor this far below the feet still counts as grounded
const GROUND_SNAP = 0.55;       // stick to the floor when walking down steps
const SUBSTEP_DIST = 0.4;       // never integrate more than this per substep (anti-tunnel)
const MAX_SUBSTEPS = 24;
const RAY_EPS = 1e-8;

// ── pooled results ────────────────────────────────────────────────────────────────────
/** Scratch for `solidRun` — pairs of [enter, exit]. 256 boxes deep is far past plausible. */
const _runSpans = new Float64Array(512);

const _res = {
  position: new THREE.Vector3(),
  velocity: new THREE.Vector3(),
  grounded: false,
  groundNormal: new THREE.Vector3(0, 1, 0),
  groundSurface: 'concrete',   // bonus: lets the movement system pick footstep sounds
  hitWall: false,
  wallNormal: new THREE.Vector3(),
  steppedUp: false,
};

const RAY_POOL = 8;
const _rayPool = [];
for (let i = 0; i < RAY_POOL; i++) {
  _rayPool.push({
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    distance: 0,
    surface: 'concrete',
    boxIndex: -1,
  });
}
let _rayCursor = 0;

// Module scratch for the axis sweep / DDA march (never read across calls).
let _sweepT = 1;
let _sweepHit = false;
let _sweepTop = -Infinity;
let _marchAxis = 1;
let _marchSign = 1;
let _marchIndex = -1;
let _probeSurface = 'concrete';

// Debug-only line material. Not part of the render budget — created lazily, once,
// and only when debugDraw(true) is first called.
let _debugMat = null;

// ══ the map data contract ═════════════════════════════════════════════════════════════
//
// `docs/contracts/map-data.md` §3. A level module is [CX]-owned art authoring; this lane
// consumes it through a manifest and NEVER by reaching into its internals. Everything
// below is the consumer half of that seam.
//
// Two states, and the difference is recorded rather than smoothed over:
//
//   DECLARED — the level module exports MAP_MANIFEST, so the manifest is read from it.
//   DERIVED  — it does not (MERIDIAN today), so the manifest is reconstructed from what
//              the level actually produced: real bounds, real spawn markers, real box
//              count. Nothing is invented. Fields the contract requires but the producer
//              has not supplied are EMPTY with a `provenance` of 'missing', so a consumer
//              that needs them (the Bomb ruleset needs objectives) fails loudly against a
//              missing key instead of quietly running on a plausible-looking fabrication.
//
// `manifest.provenance` is the machine-readable list of what Codex still owes. Harnesses
// read it; `scripts/maptest.mjs` prints it.

/** Draw/tri/material/light/collider allocation from map-data.md §3.6 (REQ-CC-007). */
const CONTRACT_DEFAULT_BUDGETS = Object.freeze({
  profileId: 'ref-integrated-1080p',
  drawCalls: 140,
  triangles: 300_000,
  materials: 48,
  lights: 6,
  colliders: 1200,
});

/** Present-and-own-property. `x !== null` would accept a key that is not there at all. */
function present(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key);
}

function isVec3Like(v) {
  return v !== null && typeof v === 'object'
    && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function toVec3(v) { return new THREE.Vector3(v.x, v.y, v.z); }

/** A §3.3/§3.4 volume, normalised so min <= max on every axis. Returns null if malformed. */
function normalizeBox(b) {
  if (!present(b, 'min') || !present(b, 'max')) return null;
  if (!isVec3Like(b.min) || !isVec3Like(b.max)) return null;
  return {
    min: new THREE.Vector3(Math.min(b.min.x, b.max.x), Math.min(b.min.y, b.max.y), Math.min(b.min.z, b.max.z)),
    max: new THREE.Vector3(Math.max(b.min.x, b.max.x), Math.max(b.min.y, b.max.y), Math.max(b.min.z, b.max.z)),
    // Whether the AUTHORED box was inverted. §3.1 says the guard rejects min > max rather
    // than letting the spatial hash silently drop it, so the fact is carried, not erased.
    inverted: b.min.x > b.max.x || b.min.y > b.max.y || b.min.z > b.max.z,
  };
}

function pointInBox(box, x, y, z) {
  return x >= box.min.x && x <= box.max.x
    && y >= box.min.y && y <= box.max.y
    && z >= box.min.z && z <= box.max.z;
}

// ── registry ─────────────────────────────────────────────────────────────────────────
//
// Map selection is by MANIFEST ENTRY, not by an import at the top of World.init(). That
// is the whole point: retiring MERIDIAN in favour of The Square must be a change to a
// rotation list, not an edit to the simulation.

const MAP_REGISTRY = new Map();
let _rotation = [];
let _activeMapId = null;

/**
 * Register a level module as a selectable map.
 *
 * `mod` is the module namespace of a [CX]-owned level file. `fallbackId`/`fallbackVersion`
 * are used ONLY while that module has not yet exported MAP_ID / MAP_VERSION; once it does,
 * its own values win and the fallbacks are dead weight.
 */
export function registerMap(mod, { fallbackId, fallbackVersion = '0.0.0-underived', inRotation = true } = {}) {
  if (typeof mod?.buildLevel !== 'function') {
    throw new Error(`registerMap: level module for '${fallbackId}' exports no buildLevel()`);
  }
  const declaresId = present(mod, 'MAP_ID') && typeof mod.MAP_ID === 'string' && mod.MAP_ID.length > 0;
  const declaresVersion = present(mod, 'MAP_VERSION') && typeof mod.MAP_VERSION === 'string';
  const declaresManifest = present(mod, 'MAP_MANIFEST') && mod.MAP_MANIFEST !== null
    && typeof mod.MAP_MANIFEST === 'object';
  const declaresBoundary = present(mod, 'COMPETITIVE_BOUNDARY') && Array.isArray(mod.COMPETITIVE_BOUNDARY);

  const entry = {
    id: declaresId ? mod.MAP_ID : fallbackId,
    version: declaresVersion ? mod.MAP_VERSION : fallbackVersion,
    module: mod,
    declares: {
      MAP_ID: declaresId,
      MAP_VERSION: declaresVersion,
      MAP_MANIFEST: declaresManifest,
      COMPETITIVE_BOUNDARY: declaresBoundary,
    },
    build(game, world) { mod.buildLevel(game, world); },
  };
  if (!entry.id) throw new Error('registerMap: no MAP_ID export and no fallbackId');
  MAP_REGISTRY.set(entry.id, entry);
  if (inRotation && !_rotation.includes(entry.id)) _rotation.push(entry.id);
  if (_activeMapId === null) _activeMapId = entry.id;
  return entry;
}

export function getMapEntry(id) { return MAP_REGISTRY.get(id) ?? null; }
export function listMaps() { return [...MAP_REGISTRY.values()]; }
/** Ids eligible for match rotation, in order. */
export function mapRotation() { return [..._rotation]; }
export function activeMapId() { return _activeMapId; }

/**
 * Replace the rotation. This is the retirement lever: dropping MERIDIAN is
 * `setMapRotation(['the-square'])`, and the map stays registered as a test fixture
 * (map-data.md §9) because registration and rotation are separate lists.
 */
export function setMapRotation(ids) {
  for (const id of ids) {
    if (!MAP_REGISTRY.has(id)) throw new Error(`setMapRotation: '${id}' is not a registered map`);
  }
  _rotation = [...ids];
  if (!_rotation.includes(_activeMapId) && _rotation.length) _activeMapId = _rotation[0];
  return mapRotation();
}

export function selectMap(id) {
  if (!MAP_REGISTRY.has(id)) throw new Error(`selectMap: '${id}' is not a registered map`);
  _activeMapId = id;
  return id;
}

// The Square is the level module's own map. It declares MAP_ID/MAP_VERSION/MAP_MANIFEST,
// so both are read from it and the fallbacks below are never used.
registerMap(MERIDIAN, { fallbackId: 'the-square', fallbackVersion: '0.0.0-underived' });

// map-data.md §9: MERIDIAN is RETAINED as a test fixture and is NOT in rotation. Every
// performance and collision baseline in this repository was measured against it, and a
// comparison against a map you have deleted is not a comparison. `inRotation: false` is
// the whole retirement: registered, selectable by name from a harness, never matched on.
if (Object.hasOwn(MERIDIAN, 'MERIDIAN_FIXTURE')) {
  registerMap(MERIDIAN.MERIDIAN_FIXTURE, { fallbackId: 'meridian', inRotation: false });
}

// ── manifest construction ────────────────────────────────────────────────────────────

/**
 * §3.2 spawn record, normalised.
 *
 * A DERIVED spawn keeps the level's own `{position, yaw, team}` object identity — the
 * spawner and `_faceSpawnsIntoTheOpen` hold references to it — and gains the contract
 * fields. `id` is derived from team and authoring order, which is stable as long as
 * `placeSpawns` is, and is marked derived so nothing treats it as the forever-stable id
 * §3.2 demands.
 */
function deriveSpawns(world, mapId) {
  const out = [];
  const perTeam = new Map();
  for (let i = 0; i < world.spawnPoints.length; i++) {
    const sp = world.spawnPoints[i];
    const team = Number.isFinite(sp.team) ? sp.team : -1;
    const n = (perTeam.get(team) ?? 0) + 1;
    perTeam.set(team, n);
    const label = team === 0 ? 'alpha' : team === 1 ? 'bravo' : 'neutral';
    if (!present(sp, 'id')) sp.id = `${mapId}-${label}-${n}`;
    if (!present(sp, 'group')) sp.group = `${mapId}-${label}`;
    if (!present(sp, 'protectionRadius')) sp.protectionRadius = 4.0;
    if (!present(sp, 'modes')) sp.modes = ['tdm'];
    out.push(sp);
  }
  return out;
}

function readDeclaredSpawns(list, world) {
  const out = [];
  world.spawnPoints.length = 0;
  for (const s of list) {
    if (!present(s, 'position') || !isVec3Like(s.position)) continue;
    const rec = {
      id: present(s, 'id') ? String(s.id) : null,
      position: toVec3(s.position),
      yaw: Number.isFinite(s.yaw) ? s.yaw : 0,
      team: Number.isFinite(s.team) ? s.team : -1,
      group: present(s, 'group') ? String(s.group) : null,
      protectionRadius: Number.isFinite(s.protectionRadius) ? s.protectionRadius : 4.0,
      modes: Array.isArray(s.modes) ? [...s.modes] : ['tdm'],
    };
    world.spawnPoints.push(rec);
    out.push(rec);
  }
  return out;
}

function readVolumes(list, extra) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const v of list) {
    if (!present(v, 'id') || !present(v, 'box')) continue;
    const box = normalizeBox(v.box);
    if (box === null) continue;
    out.push({ id: String(v.id), box, ...extra(v) });
  }
  return out;
}

function readNavHints(src) {
  const boxes = (list) => {
    const out = [];
    if (!Array.isArray(list)) return out;
    for (const b of list) { const nb = normalizeBox(b); if (nb !== null) out.push(nb); }
    return out;
  };
  const links = [];
  if (Array.isArray(src?.links)) {
    for (const l of src.links) {
      if (!present(l, 'from') || !present(l, 'to')) continue;
      if (!isVec3Like(l.from) || !isVec3Like(l.to)) continue;
      const kind = present(l, 'kind') ? String(l.kind) : 'mantle';
      links.push({ from: toVec3(l.from), to: toVec3(l.to), kind });
    }
  }
  const cover = [];
  if (Array.isArray(src?.cover)) {
    for (const c of src.cover) {
      if (!present(c, 'position') || !isVec3Like(c.position)) continue;
      cover.push({ position: toVec3(c.position), facing: Number.isFinite(c.facing) ? c.facing : 0 });
    }
  }
  return {
    walkable: boxes(src?.walkable),
    blocked: boxes(src?.blocked),
    links,
    cover,
  };
}

/**
 * Build the §3 manifest for a built world.
 *
 * Called once, after `build()`, from `World.init()`. Reads the producer's MAP_MANIFEST
 * where it exists and derives the rest from measured geometry.
 */
export function buildManifest(entry, world) {
  const src = entry.declares.MAP_MANIFEST ? entry.module.MAP_MANIFEST : null;
  const provenance = {};

  // -- bounds
  let bounds;
  if (src !== null && present(src, 'bounds') && present(src.bounds, 'min') && present(src.bounds, 'max')
    && isVec3Like(src.bounds.min) && isVec3Like(src.bounds.max)) {
    bounds = { min: toVec3(src.bounds.min), max: toVec3(src.bounds.max) };
    provenance.bounds = 'declared';
  } else {
    bounds = { min: world.bounds.min.clone(), max: world.bounds.max.clone() };
    provenance.bounds = 'derived';
  }

  // -- spawns
  let spawns;
  if (src !== null && Array.isArray(src.spawns) && src.spawns.length > 0) {
    spawns = readDeclaredSpawns(src.spawns, world);
    provenance.spawns = 'declared';
  } else {
    spawns = deriveSpawns(world, entry.id);
    provenance.spawns = 'derived';
  }

  // -- objectives (§3.3). Bomb needs these; nothing plausible is invented for them.
  let objectives = [];
  if (src !== null && Array.isArray(src.objectives)) {
    objectives = readVolumes(src.objectives, (v) => ({
      kind: present(v, 'kind') ? String(v.kind) : 'zone',
      site: present(v, 'site') ? String(v.site) : null,
      requiresGround: present(v, 'requiresGround') ? !!v.requiresGround : true,
    }));
    provenance.objectives = 'declared';
  } else {
    provenance.objectives = 'missing';
  }

  // -- callouts (§3.4)
  let callouts = [];
  if (src !== null && Array.isArray(src.callouts)) {
    callouts = readVolumes(src.callouts, (v) => ({
      name: present(v, 'name') ? String(v.name) : String(v.id),
      priority: Number.isFinite(v.priority) ? v.priority : 0,
    }));
    provenance.callouts = 'declared';
  } else {
    provenance.callouts = 'missing';
  }

  // -- sectors (sector-interest.md §3.1 — additive amendment to MAP_MANIFEST, owed by
  // P3-06). Deliberately NOT added to `provenance` when absent: unlike objectives/callouts,
  // §3's required-export list has not itself been amended to require `sectors` yet — P3-06
  // is the landing of that amendment (map-data.md's own MAP_VERSION-bump rule), so an
  // absent `sectors` array today is schedule, not a partial manifest, and must not turn
  // `manifestGaps()` red on maps that predate P3-06.
  let sectors = [];
  if (src !== null && Array.isArray(src.sectors)) {
    sectors = readVolumes(src.sectors, (v) => ({
      neighbours: Array.isArray(v.neighbours) ? v.neighbours.map(String) : [],
      populationCap: Number.isFinite(v.populationCap) ? v.populationCap : Infinity,
      baseThinkStride: Number.isFinite(v.baseThinkStride) ? v.baseThinkStride : 8,
    }));
    provenance.sectors = 'declared';
  }

  // -- nav hints (§3.5)
  let navHints;
  if (src !== null && present(src, 'navHints')) {
    navHints = readNavHints(src.navHints);
    provenance.navHints = 'declared';
  } else {
    navHints = readNavHints(null);
    provenance.navHints = 'missing';
  }

  // -- budgets (§3.6)
  let budgets;
  if (src !== null && present(src, 'budgets')) {
    budgets = { ...CONTRACT_DEFAULT_BUDGETS, ...src.budgets };
    provenance.budgets = 'declared';
  } else {
    budgets = { ...CONTRACT_DEFAULT_BUDGETS };
    provenance.budgets = 'contract-default';
  }

  // -- §5 removable competitive boundary
  let boundary = [];
  if (entry.declares.COMPETITIVE_BOUNDARY) {
    for (const b of entry.module.COMPETITIVE_BOUNDARY) {
      const nb = normalizeBox(b);
      if (nb !== null) boundary.push(nb);
    }
    provenance.boundary = 'declared';
  } else {
    provenance.boundary = 'missing';
  }

  return {
    mapId: entry.id,
    mapVersion: entry.version,
    source: entry.declares.MAP_MANIFEST ? 'declared' : 'derived',
    declares: { ...entry.declares },
    provenance,
    bounds,
    spawns,
    objectives,
    callouts,
    sectors,
    navHints,
    budgets,
    boundary,
    /** Measured, never declared — the manifest must not be able to lie about this. */
    measured: { colliders: world.boxes.length },
  };
}

/** Everything §3 requires that this manifest's producer has not supplied yet. */
export function manifestGaps(manifest) {
  const gaps = [];
  if (!manifest.declares.MAP_ID) gaps.push('MAP_ID');
  if (!manifest.declares.MAP_VERSION) gaps.push('MAP_VERSION');
  if (!manifest.declares.MAP_MANIFEST) gaps.push('MAP_MANIFEST');
  if (!manifest.declares.COMPETITIVE_BOUNDARY) gaps.push('COMPETITIVE_BOUNDARY');
  for (const [k, v] of Object.entries(manifest.provenance)) {
    if (v === 'missing') gaps.push(`MAP_MANIFEST.${k}`);
  }
  return gaps;
}

export class World {
  constructor(game) {
    this.game = game;

    /** @type {Array<{min:THREE.Vector3, max:THREE.Vector3, surface:string}>} */
    this.boxes = [];
    /** @type {Array<{position:THREE.Vector3, yaw:number, team:number}>} */
    this.spawnPoints = [];

    /**
     * The map-data.md §3 manifest for whatever map is loaded. Null until init() runs —
     * deliberately null rather than an empty object, so a consumer that reads it too
     * early throws instead of silently seeing "a map with no objectives".
     */
    this.manifest = null;
    this.mapId = null;
    this.mapVersion = null;

    this.bounds = {
      min: new THREE.Vector3(-1, -1, -1),
      max: new THREE.Vector3(1, 1, 1),
    };
    this._boundsExplicit = false;

    this.group = new THREE.Group();
    this.group.name = 'world';
    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();
    if (game && game.scene) game.scene.add(this.group);

    /** Stats filled in by level.js — handy in the perf overlay. */
    this.buildStats = { drawCalls: 0, triangles: 0, colliders: 0, buildMs: 0 };

    // Flat, cache-friendly mirror of `boxes`: [minx,miny,minz,maxx,maxy,maxz] × n.
    this._bx = null;
    this._surf = null;
    this._transparent = null;   // 1 = does not block line of sight (glass)
    this._grid = null;
    this._cand = null;
    this._stamp = null;
    this._tick = 0;

    this._debugMesh = null;
    this._debugEnabled = false;
  }

  // ────────────────────────────────────────────────────────────────── lifecycle

  /**
   * Build a map by manifest.
   *
   * `mapId` selects from the registry; omitted, the active rotation entry is used. There
   * is no import of a specific level here on purpose — swapping MERIDIAN for The Square
   * is a registry/rotation change, not a code change in the simulation.
   */
  async init({ mapId = null } = {}) {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    const id = mapId ?? activeMapId();
    const entry = getMapEntry(id);
    if (entry === null) throw new Error(`World.init: no registered map '${id}'`);

    this.mapId = entry.id;
    this.mapVersion = entry.version;
    entry.build(this.game, this);
    this.build();
    // The manifest is read AFTER build() so derived bounds and collider counts are the
    // measured ones, and BEFORE the spawn re-aim so a declared spawn set is what gets
    // re-aimed rather than whatever placeSpawns happened to leave behind.
    this.manifest = buildManifest(entry, this);
    if (this.manifest.provenance.bounds === 'declared') {
      this.setBounds(this.manifest.bounds.min, this.manifest.bounds.max);
    }
    this._faceSpawnsIntoTheOpen();
    this.buildStats.buildMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    this.buildStats.colliders = this.boxes.length;
  }

  // ─────────────────────────────────────────────────────────── manifest queries

  /** Spawns filtered by §3.2 `modes` and team. `team` -1 (or omitted) accepts any. */
  spawnsFor(mode = null, team = -1) {
    const list = this.manifest === null ? this.spawnPoints : this.manifest.spawns;
    const out = [];
    for (const sp of list) {
      if (team !== -1 && sp.team !== -1 && sp.team !== team) continue;
      if (mode !== null && Array.isArray(sp.modes) && !sp.modes.includes(mode)) continue;
      out.push(sp);
    }
    return out;
  }

  /** Distinct §3.2 spawn groups for a team — what the TDM spawn scorer selects between. */
  spawnGroups(team = -1) {
    const groups = new Map();
    for (const sp of this.spawnsFor(null, team)) {
      const key = present(sp, 'group') && sp.group !== null ? sp.group : '(ungrouped)';
      const g = groups.get(key) ?? [];
      g.push(sp);
      groups.set(key, g);
    }
    return groups;
  }

  /** §3.3 objective volume by its never-changing id, or null. */
  objective(id) {
    if (this.manifest === null) return null;
    for (const o of this.manifest.objectives) if (o.id === id) return o;
    return null;
  }

  /** §3.3 volumes for a site, e.g. `objectivesAt('A')`. */
  objectivesAt(site) {
    if (this.manifest === null) return [];
    return this.manifest.objectives.filter((o) => o.site === site);
  }

  /**
   * §3.4: the one callout region a point resolves to, or null when the producer has
   * supplied no callouts. Highest `priority` wins where regions overlap.
   */
  calloutAt(x, y, z) {
    if (this.manifest === null) return null;
    let best = null;
    for (const c of this.manifest.callouts) {
      if (!pointInBox(c.box, x, y, z)) continue;
      if (best === null || c.priority > best.priority) best = c;
    }
    return best;
  }

  /** §5: the removable competitive boundary layer, or an empty list if untagged. */
  boundaryBoxes() {
    return this.manifest === null ? [] : this.manifest.boundary;
  }

  /**
   * Spawning nose-first into a wall is the worst possible first second of a life, and
   * hand-authored yaws drift as geometry moves. After the level is built, re-aim any
   * spawn whose forward view is blocked within MIN_CLEAR at the most open direction
   * available to it. Runs once, costs ~16 rays per spawn.
   */
  _faceSpawnsIntoTheOpen(MIN_CLEAR = 3.5) {
    const eye = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const STEPS = 16;
    for (const sp of this.spawnPoints) {
      eye.set(sp.position.x, sp.position.y + 1.62, sp.position.z);
      dir.set(-Math.sin(sp.yaw), 0, -Math.cos(sp.yaw));
      const ahead = this.raycast(eye, dir, 60);
      if (!ahead || ahead.distance >= MIN_CLEAR) continue;

      let bestYaw = sp.yaw;
      let bestDist = ahead.distance;
      for (let i = 0; i < STEPS; i++) {
        // Sweep outward from the authored yaw so we keep the designer's intent
        // when several directions are equally open.
        const off = ((i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * (Math.PI * 2)) / STEPS;
        const yaw = sp.yaw + off;
        dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        const hit = this.raycast(eye, dir, 60);
        const d = hit ? hit.distance : 60;
        if (d > bestDist) { bestDist = d; bestYaw = yaw; }
        if (bestDist >= MIN_CLEAR * 2) break;
      }
      sp.yaw = bestYaw;
    }
  }

  reset() {
    // Static world — nothing to roll back. Debug overlay is intentionally sticky.
  }

  // ────────────────────────────────────────────────────────────────── authoring

  /**
   * Register an AABB collider. `min`/`max` may be any {x,y,z}; they are copied and
   * normalised so callers can pass scratch vectors.
   * @returns the stored box record.
   */
  addBox(min, max, surface = 'concrete') {
    const b = {
      min: new THREE.Vector3(
        Math.min(min.x, max.x), Math.min(min.y, max.y), Math.min(min.z, max.z),
      ),
      max: new THREE.Vector3(
        Math.max(min.x, max.x), Math.max(min.y, max.y), Math.max(min.z, max.z),
      ),
      surface,
    };
    this.boxes.push(b);
    this._grid = null;   // invalidate — build() must be called again
    return b;
  }

  /** Convenience for level code: raw numbers, no vector churn. */
  addBoxRaw(x0, y0, z0, x1, y1, z1, surface = 'concrete') {
    const b = {
      min: new THREE.Vector3(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)),
      max: new THREE.Vector3(Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)),
      surface,
    };
    this.boxes.push(b);
    this._grid = null;
    return b;
  }

  setBounds(min, max) {
    this.bounds.min.set(min.x, min.y, min.z);
    this.bounds.max.set(max.x, max.y, max.z);
    this._boundsExplicit = true;
  }

  /**
   * Finalise the broadphase. Call once after every addBox().
   * Builds a uniform 3D grid in CSR form: `start[c]..start[c+1]` indexes into `items`.
   */
  build() {
    const n = this.boxes.length;
    this._bx = new Float32Array(Math.max(1, n) * 6);
    this._surf = new Array(n);
    this._transparent = new Uint8Array(Math.max(1, n));
    this._cand = new Int32Array(Math.max(16, n));
    this._stamp = new Int32Array(Math.max(1, n));
    this._tick = 0;

    let minx = Infinity, miny = Infinity, minz = Infinity;
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;

    for (let i = 0; i < n; i++) {
      const b = this.boxes[i];
      const o = i * 6;
      this._bx[o] = b.min.x; this._bx[o + 1] = b.min.y; this._bx[o + 2] = b.min.z;
      this._bx[o + 3] = b.max.x; this._bx[o + 4] = b.max.y; this._bx[o + 5] = b.max.z;
      this._surf[i] = b.surface;
      this._transparent[i] = b.surface === 'glass' ? 1 : 0;
      if (b.min.x < minx) minx = b.min.x;
      if (b.min.y < miny) miny = b.min.y;
      if (b.min.z < minz) minz = b.min.z;
      if (b.max.x > maxx) maxx = b.max.x;
      if (b.max.y > maxy) maxy = b.max.y;
      if (b.max.z > maxz) maxz = b.max.z;
    }

    if (n === 0) {
      minx = miny = minz = -1; maxx = maxy = maxz = 1;
    }

    // Pad by one cell so queries that sit exactly on the rim still land inside the grid.
    const gminx = Math.floor(minx * INV_CELL) * CELL - CELL;
    const gminy = Math.floor(miny * INV_CELL) * CELL - CELL;
    const gminz = Math.floor(minz * INV_CELL) * CELL - CELL;
    const gmaxx = Math.ceil(maxx * INV_CELL) * CELL + CELL;
    const gmaxy = Math.ceil(maxy * INV_CELL) * CELL + CELL;
    const gmaxz = Math.ceil(maxz * INV_CELL) * CELL + CELL;

    const nx = Math.max(1, Math.round((gmaxx - gminx) * INV_CELL));
    const ny = Math.max(1, Math.round((gmaxy - gminy) * INV_CELL));
    const nz = Math.max(1, Math.round((gmaxz - gminz) * INV_CELL));
    const nCells = nx * ny * nz;

    const counts = new Int32Array(nCells + 1);

    // Pass 1 — count.
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      const ix0 = clampInt(Math.floor((this._bx[o] - gminx) * INV_CELL), 0, nx - 1);
      const ix1 = clampInt(Math.floor((this._bx[o + 3] - gminx) * INV_CELL), 0, nx - 1);
      const iy0 = clampInt(Math.floor((this._bx[o + 1] - gminy) * INV_CELL), 0, ny - 1);
      const iy1 = clampInt(Math.floor((this._bx[o + 4] - gminy) * INV_CELL), 0, ny - 1);
      const iz0 = clampInt(Math.floor((this._bx[o + 2] - gminz) * INV_CELL), 0, nz - 1);
      const iz1 = clampInt(Math.floor((this._bx[o + 5] - gminz) * INV_CELL), 0, nz - 1);
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const row = (iy * nz + iz) * nx;
          for (let ix = ix0; ix <= ix1; ix++) counts[row + ix + 1]++;
        }
      }
    }

    // Prefix sum.
    for (let c = 0; c < nCells; c++) counts[c + 1] += counts[c];
    const total = counts[nCells];
    const items = new Int32Array(total);
    const cursor = new Int32Array(nCells);

    // Pass 2 — fill.
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      const ix0 = clampInt(Math.floor((this._bx[o] - gminx) * INV_CELL), 0, nx - 1);
      const ix1 = clampInt(Math.floor((this._bx[o + 3] - gminx) * INV_CELL), 0, nx - 1);
      const iy0 = clampInt(Math.floor((this._bx[o + 1] - gminy) * INV_CELL), 0, ny - 1);
      const iy1 = clampInt(Math.floor((this._bx[o + 4] - gminy) * INV_CELL), 0, ny - 1);
      const iz0 = clampInt(Math.floor((this._bx[o + 2] - gminz) * INV_CELL), 0, nz - 1);
      const iz1 = clampInt(Math.floor((this._bx[o + 5] - gminz) * INV_CELL), 0, nz - 1);
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const row = (iy * nz + iz) * nx;
          for (let ix = ix0; ix <= ix1; ix++) {
            const c = row + ix;
            items[counts[c] + cursor[c]] = i;
            cursor[c]++;
          }
        }
      }
    }

    this._grid = {
      minx: gminx, miny: gminy, minz: gminz,
      maxx: gmaxx, maxy: gmaxy, maxz: gmaxz,
      nx, ny, nz, start: counts, items,
    };

    if (!this._boundsExplicit) {
      this.bounds.min.set(minx, miny, minz);
      this.bounds.max.set(maxx, maxy, maxz);
    }

    // A stale overlay would be lying about the collision data.
    if (this._debugMesh) {
      this.group.remove(this._debugMesh);
      this._debugMesh.geometry.dispose();
      this._debugMesh = null;
    }
  }

  // ────────────────────────────────────────────────────────────────── broadphase

  /**
   * Next visit stamp for the per-query "have I already considered this box" test.
   *
   * `_stamp` is an Int32Array but `_tick` is a plain number, so past 2^31 the store
   * truncates to negative while the counter keeps climbing — `stamp[bi] === tick` can
   * then never match again and the dedup is broken *permanently*, not transiently.
   * Every box in a touched cell gets reconsidered once per cell, and `_cand` (sized to
   * the box count) silently drops the overflow. A tab never runs long enough to see it;
   * a server process serving a full match does, in a matter of hours. Resetting costs
   * one fill of a ~1000-entry array, once per 2^31 queries.
   */
  _nextStamp() {
    if (this._tick >= 0x7ffffffe) { this._stamp.fill(0); this._tick = 0; }
    return ++this._tick;
  }

  /**
   * Gather every box index whose AABB overlaps the query volume into `this._cand`.
   * @returns candidate count. Allocation-free; results are valid until the next query.
   */
  _query(minx, miny, minz, maxx, maxy, maxz) {
    const g = this._grid;
    if (!g) return 0;
    let ix0 = Math.floor((minx - g.minx) * INV_CELL);
    let ix1 = Math.floor((maxx - g.minx) * INV_CELL);
    let iy0 = Math.floor((miny - g.miny) * INV_CELL);
    let iy1 = Math.floor((maxy - g.miny) * INV_CELL);
    let iz0 = Math.floor((minz - g.minz) * INV_CELL);
    let iz1 = Math.floor((maxz - g.minz) * INV_CELL);
    if (ix1 < 0 || iy1 < 0 || iz1 < 0) return 0;
    if (ix0 > g.nx - 1 || iy0 > g.ny - 1 || iz0 > g.nz - 1) return 0;
    if (ix0 < 0) ix0 = 0; if (iy0 < 0) iy0 = 0; if (iz0 < 0) iz0 = 0;
    if (ix1 > g.nx - 1) ix1 = g.nx - 1;
    if (iy1 > g.ny - 1) iy1 = g.ny - 1;
    if (iz1 > g.nz - 1) iz1 = g.nz - 1;

    const tick = this._nextStamp();
    const bx = this._bx, stamp = this._stamp, cand = this._cand;
    const start = g.start, items = g.items, nx = g.nx, nz = g.nz;
    let count = 0;

    for (let iy = iy0; iy <= iy1; iy++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const row = (iy * nz + iz) * nx;
        for (let ix = ix0; ix <= ix1; ix++) {
          const c = row + ix;
          const e = start[c + 1];
          for (let k = start[c]; k < e; k++) {
            const bi = items[k];
            if (stamp[bi] === tick) continue;
            stamp[bi] = tick;
            const o = bi * 6;
            // Exact AABB reject (inclusive — touching must survive for ground probes).
            if (bx[o + 3] < minx - EPS || bx[o] > maxx + EPS) continue;
            if (bx[o + 4] < miny - EPS || bx[o + 1] > maxy + EPS) continue;
            if (bx[o + 5] < minz - EPS || bx[o + 2] > maxz + EPS) continue;
            cand[count++] = bi;
          }
        }
      }
    }
    return count;
  }

  /** True if the given feet-origin capsule box overlaps any collider. */
  _overlapAny(x, y, z, radius, height) {
    const minx = x - radius, maxx = x + radius;
    const miny = y, maxy = y + height;
    const minz = z - radius, maxz = z + radius;
    const n = this._query(minx, miny, minz, maxx, maxy, maxz);
    const bx = this._bx, cand = this._cand;
    for (let k = 0; k < n; k++) {
      const o = cand[k] * 6;
      if (bx[o] < maxx - EPS && bx[o + 3] > minx + EPS &&
          bx[o + 1] < maxy - EPS && bx[o + 4] > miny + EPS &&
          bx[o + 2] < maxz - EPS && bx[o + 5] > minz + EPS) return true;
    }
    return false;
  }

  // ────────────────────────────────────────────────────────────────── movement

  /**
   * Swept AABB move-and-slide. Gravity must already be baked into `velocity` by the
   * caller (ARCHITECTURE.md §5).
   *
   * The mover is an AABB of half-extent `radius` in X/Z and `height` in Y with its
   * ORIGIN AT THE FEET. Axes are integrated separately — Y first so landings and
   * ceilings resolve cleanly, then X, then Z — re-querying the hash each time.
   *
   * Neither `position` nor `velocity` is mutated.
   *
   * @returns the module-scope pooled result. COPY ANYTHING YOU KEEP.
   */
  move(position, velocity, radius, height, dt) {
    const R = _res;
    R.position.copy(position);
    R.velocity.copy(velocity);
    R.grounded = false;
    R.groundNormal.set(0, 1, 0);
    R.groundSurface = 'concrete';
    R.hitWall = false;
    R.wallNormal.set(0, 0, 0);
    R.steppedUp = false;
    if (!this._grid || dt <= 0) return R;

    // Recover from any pre-existing interpenetration (teleports, spawns, knockback).
    this._depenetrate(R.position, radius, height);

    const startTop = this._probeGround(R.position, radius, GROUND_PROBE);
    let onGround = startTop > -Infinity;
    const wasGrounded = onGround;

    // Track the most-opposed wall we touch, measured against the entry direction.
    let hx = velocity.x, hz = velocity.z;
    const hl = Math.hypot(hx, hz);
    if (hl > 1e-5) { hx /= hl; hz /= hl; } else { hx = 0; hz = 0; }
    let bestWallDot = 1;

    // Anti-tunnelling: cap the distance travelled per substep.
    const dist = R.velocity.length() * dt;
    let steps = Math.ceil(dist / SUBSTEP_DIST);
    if (!(steps >= 1)) steps = 1;
    if (steps > MAX_SUBSTEPS) steps = MAX_SUBSTEPS;
    const sdt = dt / steps;

    for (let s = 0; s < steps; s++) {
      if (R.velocity.y > 0.05) onGround = false;

      // ---- Y
      const dy = R.velocity.y * sdt;
      if (dy !== 0) {
        this._sweepAxis(1, dy, radius, height);
        R.position.y += dy * _sweepT;
        if (_sweepHit) {
          if (dy < 0) {
            onGround = true;
            R.grounded = true;
            R.groundNormal.set(0, 1, 0);
          }
          R.velocity.y = 0;
        }
      }

      // ---- X
      const dx = R.velocity.x * sdt;
      if (dx !== 0) {
        this._sweepAxis(0, dx, radius, height);
        R.position.x += dx * _sweepT;
        if (_sweepHit) {
          const rem = dx * (1 - _sweepT);
          if (!this._tryStepUp(R, 0, rem, radius, height, onGround)) {
            const nx = dx > 0 ? -1 : 1;
            const d = nx * hx;
            if (d < bestWallDot) { bestWallDot = d; R.wallNormal.set(nx, 0, 0); }
            R.hitWall = true;
            R.velocity.x = 0;
          } else {
            onGround = true;
          }
        }
      }

      // ---- Z
      const dz = R.velocity.z * sdt;
      if (dz !== 0) {
        this._sweepAxis(2, dz, radius, height);
        R.position.z += dz * _sweepT;
        if (_sweepHit) {
          const rem = dz * (1 - _sweepT);
          if (!this._tryStepUp(R, 2, rem, radius, height, onGround)) {
            const nz = dz > 0 ? -1 : 1;
            const d = nz * hz;
            if (d < bestWallDot) { bestWallDot = d; R.wallNormal.set(0, 0, nz); }
            R.hitWall = true;
            R.velocity.z = 0;
          } else {
            onGround = true;
          }
        }
      }
    }

    // ---- final ground state
    if (R.velocity.y <= 0.001) {
      const top = this._probeGround(R.position, radius, GROUND_PROBE);
      if (top > -Infinity) {
        R.position.y = top;
        R.grounded = true;
        R.groundNormal.set(0, 1, 0);
        R.groundSurface = _probeSurface;
      } else if (wasGrounded && !R.steppedUp) {
        // Walking down stairs / a kerb: stick to the floor instead of micro-launching.
        const deep = this._probeGround(R.position, radius, GROUND_SNAP);
        if (deep > -Infinity && R.position.y - deep <= GROUND_SNAP) {
          R.position.y = deep;
          R.grounded = true;
          R.groundNormal.set(0, 1, 0);
          R.groundSurface = _probeSurface;
          R.velocity.y = 0;
        }
      }
    }

    if (!R.hitWall) R.wallNormal.set(0, 0, 0);
    return R;
  }

  /**
   * Sweep the mover along one axis. Writes `_sweepT` (0..1 fraction of `delta` that is
   * safe to travel), `_sweepHit` and `_sweepTop` (the highest top face among the boxes
   * that blocked us — the step-up candidate).
   */
  _sweepAxis(axis, delta, radius, height) {
    _sweepT = 1; _sweepHit = false; _sweepTop = -Infinity;
    const p = _res.position;
    const minx = p.x - radius, maxx = p.x + radius;
    const miny = p.y, maxy = p.y + height;
    const minz = p.z - radius, maxz = p.z + radius;

    let qminx = minx, qmaxx = maxx, qminy = miny, qmaxy = maxy, qminz = minz, qmaxz = maxz;
    if (axis === 0) { if (delta > 0) qmaxx += delta; else qminx += delta; }
    else if (axis === 1) { if (delta > 0) qmaxy += delta; else qminy += delta; }
    else { if (delta > 0) qmaxz += delta; else qminz += delta; }

    const n = this._query(qminx, qminy, qminz, qmaxx, qmaxy, qmaxz);
    if (n === 0) return;

    const bx = this._bx, cand = this._cand;
    const aMin = axis === 0 ? minx : axis === 1 ? miny : minz;
    const aMax = axis === 0 ? maxx : axis === 1 ? maxy : maxz;
    const adelta = delta > 0 ? delta : -delta;

    // Pass 1 — earliest time of impact.
    for (let k = 0; k < n; k++) {
      const o = cand[k] * 6;
      if (axis !== 0 && !(bx[o] < maxx - EPS && bx[o + 3] > minx + EPS)) continue;
      if (axis !== 1 && !(bx[o + 1] < maxy - EPS && bx[o + 4] > miny + EPS)) continue;
      if (axis !== 2 && !(bx[o + 2] < maxz - EPS && bx[o + 5] > minz + EPS)) continue;
      const gap = delta > 0 ? (bx[o + axis] - aMax) : (aMin - bx[o + 3 + axis]);
      if (gap < -EPS) continue;           // already embedded — _depenetrate owns this case
      if (gap >= adelta) continue;        // out of reach this substep
      let t = (gap - SKIN) / adelta;
      if (t < 0) t = 0;
      if (t < _sweepT) _sweepT = t;
      _sweepHit = true;
    }
    if (!_sweepHit) { _sweepT = 1; return; }

    // Pass 2 — of the boxes that actually block us, which has the highest top face?
    // (`_cand` is still ours; nothing has re-queried in between.)
    const blockGap = _sweepT * adelta + SKIN + EPS;
    for (let k = 0; k < n; k++) {
      const o = cand[k] * 6;
      if (axis !== 0 && !(bx[o] < maxx - EPS && bx[o + 3] > minx + EPS)) continue;
      if (axis !== 1 && !(bx[o + 1] < maxy - EPS && bx[o + 4] > miny + EPS)) continue;
      if (axis !== 2 && !(bx[o + 2] < maxz - EPS && bx[o + 5] > minz + EPS)) continue;
      const gap = delta > 0 ? (bx[o + axis] - aMax) : (aMin - bx[o + 3 + axis]);
      if (gap < -EPS || gap >= adelta) continue;
      if (gap <= blockGap && bx[o + 4] > _sweepTop) _sweepTop = bx[o + 4];
    }
  }

  /**
   * Step-up. Only fires when grounded and blocked by a ledge whose top is within
   * MAX_STEP_HEIGHT of the feet AND where the full standing height fits both above the
   * current spot and at the destination — which is exactly what stops this from being a
   * wall-climb: a wall's top face is metres away, and a low ledge with something on top
   * fails the headroom test.
   */
  _tryStepUp(R, axis, rem, radius, height, onGround) {
    if (!onGround) return false;
    if (_sweepTop === -Infinity) return false;
    const targetY = _sweepTop + SKIN;
    const rise = targetY - R.position.y;
    if (rise < MIN_STEP_HEIGHT || rise > MAX_STEP_HEIGHT) return false;
    // Room to stand at the raised height where we are…
    if (this._overlapAny(R.position.x, targetY, R.position.z, radius, height)) return false;
    // …and room to stand at the destination.
    const dx = axis === 0 ? rem : 0;
    const dz = axis === 2 ? rem : 0;
    if (this._overlapAny(R.position.x + dx, targetY, R.position.z + dz, radius, height)) return false;
    R.position.y = targetY;
    R.position.x += dx;
    R.position.z += dz;
    R.steppedUp = true;
    R.grounded = true;
    R.groundNormal.set(0, 1, 0);
    return true;
  }

  /**
   * Highest top face directly beneath the feet within `depth`, or -Infinity.
   * Also writes `_probeSurface`.
   */
  _probeGround(p, radius, depth) {
    const minx = p.x - radius, maxx = p.x + radius;
    const minz = p.z - radius, maxz = p.z + radius;
    const lo = p.y - depth, hi = p.y + 0.01;
    const n = this._query(minx, lo, minz, maxx, hi, maxz);
    const bx = this._bx, cand = this._cand;
    let best = -Infinity, bestIdx = -1;
    for (let k = 0; k < n; k++) {
      const bi = cand[k], o = bi * 6;
      const top = bx[o + 4];
      if (top < lo || top > hi) continue;
      if (!(bx[o] < maxx - EPS && bx[o + 3] > minx + EPS)) continue;
      if (!(bx[o + 2] < maxz - EPS && bx[o + 5] > minz + EPS)) continue;
      if (top > best) { best = top; bestIdx = bi; }
    }
    _probeSurface = bestIdx >= 0 ? this._surf[bestIdx] : 'concrete';
    return best;
  }

  /** Minimum-translation push-out, up to 4 relaxation passes. */
  /**
   * Push a body out of anything it is inside.
   *
   * Four passes. I raised this to eight claiming it cleared 28 measured sites where a body
   * stayed embedded; an A/B with only the pass count differing produced BYTE-IDENTICAL
   * results — 1676 embedded, 1442 pushed out, the same 28 sites either way. The claim was
   * wrong and the change did nothing, so it is reverted rather than left in as cargo.
   *
   * It resolves the DEEPEST overlap each pass, which looks wrong — minimum-translation is
   * the usual choice — and measurement says otherwise. Switching to the shallowest fixed
   * 27 of the 28 and turned the last into something worse: a body between two stair treads
   * that could not walk out in any of eight directions, because the two shallow pushes
   * alternate and cancel. Deepest-first commits to one escape and finishes it.
   */
  _depenetrate(p, radius, height) {
    for (let pass = 0; pass < 4; pass++) {
      const minx = p.x - radius, maxx = p.x + radius;
      const miny = p.y, maxy = p.y + height;
      const minz = p.z - radius, maxz = p.z + radius;
      const n = this._query(minx, miny, minz, maxx, maxy, maxz);
      const bx = this._bx, cand = this._cand;
      let bestDepth = 0, bestAxis = -1, bestDir = 1;
      for (let k = 0; k < n; k++) {
        const o = cand[k] * 6;
        const ox1 = Math.min(maxx, bx[o + 3]) - Math.max(minx, bx[o]);
        if (ox1 <= EPS) continue;
        const oy1 = Math.min(maxy, bx[o + 4]) - Math.max(miny, bx[o + 1]);
        if (oy1 <= EPS) continue;
        const oz1 = Math.min(maxz, bx[o + 5]) - Math.max(minz, bx[o + 2]);
        if (oz1 <= EPS) continue;
        // Cheapest escape axis for this box.
        let axis = 0, depth = ox1, dir = (minx + maxx) * 0.5 < (bx[o] + bx[o + 3]) * 0.5 ? -1 : 1;
        if (oy1 < depth) {
          axis = 1; depth = oy1;
          dir = (miny + maxy) * 0.5 < (bx[o + 1] + bx[o + 4]) * 0.5 ? -1 : 1;
        }
        if (oz1 < depth) {
          axis = 2; depth = oz1;
          dir = (minz + maxz) * 0.5 < (bx[o + 2] + bx[o + 5]) * 0.5 ? -1 : 1;
        }
        if (depth > bestDepth) { bestDepth = depth; bestAxis = axis; bestDir = dir; }
      }
      if (bestAxis < 0) return;
      const push = (bestDepth + SKIN) * bestDir;
      if (bestAxis === 0) p.x += push;
      else if (bestAxis === 1) p.y += push;
      else p.z += push;
    }
  }

  // ────────────────────────────────────────────────────────────────── queries

  /**
   * Nearest static hit along a ray. `dir` need not be normalised.
   * @returns null, or a POOLED {point, normal, distance, surface} — one of a ring of 8,
   *          so at most 8 results are simultaneously valid. Copy what you keep.
   */
  raycast(origin, dir, maxDist = 1000) {
    if (!this._grid) return null;
    let dx = dir.x, dy = dir.y, dz = dir.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < RAY_EPS) return null;
    const inv = 1 / len;
    dx *= inv; dy *= inv; dz *= inv;

    const t = this._march(origin.x, origin.y, origin.z, dx, dy, dz, maxDist, true, false);
    if (t < 0) return null;

    const r = _rayPool[_rayCursor];
    _rayCursor = (_rayCursor + 1) % RAY_POOL;
    r.distance = t;
    r.point.set(origin.x + dx * t, origin.y + dy * t, origin.z + dz * t);
    r.normal.set(
      _marchAxis === 0 ? _marchSign : 0,
      _marchAxis === 1 ? _marchSign : 0,
      _marchAxis === 2 ? _marchSign : 0,
    );
    r.surface = this._surf[_marchIndex];
    r.boxIndex = _marchIndex;
    return r;
  }

  /**
   * Is the straight segment from → to unobstructed by opaque static geometry?
   * Glass is deliberately transparent to LOS (you can see through a window, and
   * ballistics still resolves the pane via raycast()). Allocation-free, early-outs on
   * the first blocker — this is called by every bot several times a second.
   */
  losClear(from, to) {
    if (!this._grid) return true;
    let dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 1e-4) return true;
    const inv = 1 / dist;
    dx *= inv; dy *= inv; dz *= inv;
    return this._march(from.x, from.y, from.z, dx, dy, dz, dist - 0.01, false, true) < 0;
  }

  /**
   * Voxel-DDA the spatial hash, testing ray-vs-AABB per candidate.
   * @param nearest    true = keep marching for the closest hit; false = bail on first hit
   * @param skipGlass  true = ignore panes (LOS)
   * @returns hit distance, or -1. Writes `_marchAxis`, `_marchSign`, `_marchIndex`.
   */
  _march(ox, oy, oz, dx, dy, dz, maxDist, nearest, skipGlass) {
    const g = this._grid;
    if (maxDist <= 0) return -1;

    // Clip the ray to the grid AABB.
    let t0 = 0, t1 = maxDist;
    if (dx > -RAY_EPS && dx < RAY_EPS) {
      if (ox < g.minx || ox > g.maxx) return -1;
    } else {
      const i2 = 1 / dx;
      let ta = (g.minx - ox) * i2, tb = (g.maxx - ox) * i2;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    }
    if (dy > -RAY_EPS && dy < RAY_EPS) {
      if (oy < g.miny || oy > g.maxy) return -1;
    } else {
      const i2 = 1 / dy;
      let ta = (g.miny - oy) * i2, tb = (g.maxy - oy) * i2;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    }
    if (dz > -RAY_EPS && dz < RAY_EPS) {
      if (oz < g.minz || oz > g.maxz) return -1;
    } else {
      const i2 = 1 / dz;
      let ta = (g.minz - oz) * i2, tb = (g.maxz - oz) * i2;
      if (ta > tb) { const s = ta; ta = tb; tb = s; }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
    }
    if (t0 > t1 || t1 < 0) return -1;
    if (t0 < 0) t0 = 0;

    const ex = ox + dx * t0, ey = oy + dy * t0, ez = oz + dz * t0;
    let ix = clampInt(Math.floor((ex - g.minx) * INV_CELL), 0, g.nx - 1);
    let iy = clampInt(Math.floor((ey - g.miny) * INV_CELL), 0, g.ny - 1);
    let iz = clampInt(Math.floor((ez - g.minz) * INV_CELL), 0, g.nz - 1);

    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    let tMaxX, tMaxY, tMaxZ, tDeltaX, tDeltaY, tDeltaZ;
    if (dx > -RAY_EPS && dx < RAY_EPS) { tMaxX = Infinity; tDeltaX = Infinity; }
    else {
      tDeltaX = CELL / Math.abs(dx);
      tMaxX = (g.minx + (ix + (dx > 0 ? 1 : 0)) * CELL - ox) / dx;
    }
    if (dy > -RAY_EPS && dy < RAY_EPS) { tMaxY = Infinity; tDeltaY = Infinity; }
    else {
      tDeltaY = CELL / Math.abs(dy);
      tMaxY = (g.miny + (iy + (dy > 0 ? 1 : 0)) * CELL - oy) / dy;
    }
    if (dz > -RAY_EPS && dz < RAY_EPS) { tMaxZ = Infinity; tDeltaZ = Infinity; }
    else {
      tDeltaZ = CELL / Math.abs(dz);
      tMaxZ = (g.minz + (iz + (dz > 0 ? 1 : 0)) * CELL - oz) / dz;
    }

    const tick = this._nextStamp();
    const bx = this._bx, stamp = this._stamp, start = g.start, items = g.items;
    const nx = g.nx, nz = g.nz;
    let best = -1;

    for (let guard = 0; guard < 8192; guard++) {
      const c = (iy * nz + iz) * nx + ix;
      const end = start[c + 1];
      for (let k = start[c]; k < end; k++) {
        const bi = items[k];
        if (stamp[bi] === tick) continue;
        stamp[bi] = tick;
        if (skipGlass && this._transparent[bi]) continue;

        const o = bi * 6;
        let tmin = 0, tmax = maxDist, axis = 1, sign = 1;

        if (dx > -RAY_EPS && dx < RAY_EPS) {
          if (ox < bx[o] || ox > bx[o + 3]) continue;
        } else {
          const i2 = 1 / dx;
          let ta = (bx[o] - ox) * i2, tb = (bx[o + 3] - ox) * i2;
          if (ta > tb) { const s = ta; ta = tb; tb = s; }
          if (ta > tmin) { tmin = ta; axis = 0; sign = dx > 0 ? -1 : 1; }
          if (tb < tmax) tmax = tb;
          if (tmin > tmax) continue;
        }
        if (dy > -RAY_EPS && dy < RAY_EPS) {
          if (oy < bx[o + 1] || oy > bx[o + 4]) continue;
        } else {
          const i2 = 1 / dy;
          let ta = (bx[o + 1] - oy) * i2, tb = (bx[o + 4] - oy) * i2;
          if (ta > tb) { const s = ta; ta = tb; tb = s; }
          if (ta > tmin) { tmin = ta; axis = 1; sign = dy > 0 ? -1 : 1; }
          if (tb < tmax) tmax = tb;
          if (tmin > tmax) continue;
        }
        if (dz > -RAY_EPS && dz < RAY_EPS) {
          if (oz < bx[o + 2] || oz > bx[o + 5]) continue;
        } else {
          const i2 = 1 / dz;
          let ta = (bx[o + 2] - oz) * i2, tb = (bx[o + 5] - oz) * i2;
          if (ta > tb) { const s = ta; ta = tb; tb = s; }
          if (ta > tmin) { tmin = ta; axis = 2; sign = dz > 0 ? -1 : 1; }
          if (tb < tmax) tmax = tb;
          if (tmin > tmax) continue;
        }

        if (tmin <= 0 || tmin > maxDist) continue;   // behind us, past the end, or origin inside
        if (best < 0 || tmin < best) {
          best = tmin; _marchAxis = axis; _marchSign = sign; _marchIndex = bi;
          if (!nearest) return best;
        }
      }

      const tExit = tMaxX < tMaxY ? (tMaxX < tMaxZ ? tMaxX : tMaxZ) : (tMaxY < tMaxZ ? tMaxY : tMaxZ);
      if (best >= 0 && best <= tExit) break;
      if (tExit > t1) break;
      if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
        ix += stepX; tMaxX += tDeltaX; if (ix < 0 || ix >= nx) break;
      } else if (tMaxY <= tMaxZ) {
        iy += stepY; tMaxY += tDeltaY; if (iy < 0 || iy >= g.ny) break;
      } else {
        iz += stepZ; tMaxZ += tDeltaZ; if (iz < 0 || iz >= nz) break;
      }
    }
    return best;
  }

  /**
   * Is this point inside solid material?
   *
   * `raycast` deliberately cannot answer this: `_march` skips any box with `tmin <= 0`,
   * so a ray that STARTS inside a box never sees it. That is the right behaviour for a
   * line-of-sight query — a shooter standing a centimetre inside a doorframe should still
   * be able to see — but it means nothing downstream can tell "no face ahead" from
   * "buried in concrete", which is exactly the distinction penetration depends on.
   */
  pointInSolid(x, y, z) {
    if (!this._grid) this.build();
    const n = this._query(x, y, z, x, y, z);
    const bx = this._bx, cand = this._cand;
    for (let k = 0; k < n; k++) {
      const o = cand[k] * 6;
      if (x >= bx[o] && x <= bx[o + 3]
        && y >= bx[o + 1] && y <= bx[o + 4]
        && z >= bx[o + 2] && z <= bx[o + 5]) return true;
    }
    return false;
  }

  /**
   * Thickness of the UNBROKEN run of solid material starting at `origin` along `dir`.
   *
   * Marches forward accumulating the union of every box interval the ray crosses, and
   * returns where that union first has a hole in it — so overlapping and abutting boxes
   * read as one continuous wall, which is what a bullet actually experiences.
   *
   * This exists because measuring one box's slab is not measuring a wall. The previous
   * approach probed BACKWARDS from a fixed distance past the impact and took the first
   * face it met as the far side, which fails in two ways that matter here: a box the
   * probe origin sits inside is invisible (see `pointInSolid`), and a thin collider
   * buried inside a thick one — this level has four glass panes entombed in concrete —
   * reports its own far face as the wall's, turning 0.40 m of concrete into a free
   * window. Measured: 4.29% of all wall hits were leaking, up to 13.7 m of material.
   *
   * @returns {number} metres of solid from `origin` to the first gap, capped at `maxDepth`.
   *   0 means the origin is not in solid at all.
   */
  solidRun(origin, dir, maxDepth) {
    if (!this._grid) this.build();
    const ox = origin.x, oy = origin.y, oz = origin.z;
    const dx = dir.x, dy = dir.y, dz = dir.z;

    // One broadphase query over the whole segment's AABB. Cheaper than marching cells for
    // the short distances penetration cares about, and immune to the DDA's own edge cases.
    const ex = ox + dx * maxDepth, ey = oy + dy * maxDepth, ez = oz + dz * maxDepth;
    const n = this._query(
      Math.min(ox, ex), Math.min(oy, ey), Math.min(oz, ez),
      Math.max(ox, ex), Math.max(oy, ey), Math.max(oz, ez),
    );
    const bx = this._bx, cand = this._cand;

    // Collect [enter, exit] for every box the ray actually crosses, clipped to the segment.
    const spans = _runSpans;
    let count = 0;
    for (let k = 0; k < n; k++) {
      const o = cand[k] * 6;
      let tmin = 0, tmax = maxDepth;
      let ok = true;
      for (let a = 0; a < 3 && ok; a++) {
        const d = a === 0 ? dx : a === 1 ? dy : dz;
        const p = a === 0 ? ox : a === 1 ? oy : oz;
        const lo = bx[o + a], hi = bx[o + 3 + a];
        if (d > -RAY_EPS && d < RAY_EPS) { if (p < lo || p > hi) ok = false; continue; }
        const inv = 1 / d;
        let ta = (lo - p) * inv, tb = (hi - p) * inv;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        if (ta > tmin) tmin = ta;
        if (tb < tmax) tmax = tb;
        if (tmin > tmax) ok = false;
      }
      if (!ok || tmax <= 0) continue;
      spans[count++] = tmin;
      spans[count++] = tmax;
      // Fail CLOSED. Truncating the span list drops intervals, which puts a hole in the
      // union, which SHORTENS the measured run — so an over-capped wall would read as
      // thin and become penetrable. Returning the cap says "at least this thick", which
      // is the safe direction to be wrong in.
      if (count >= spans.length - 1) return maxDepth;
    }
    if (count === 0) return 0;

    // Sweep the union from t=0. The run ends at the first t where nothing covers it.
    let end = 0;
    let advanced = true;
    while (advanced) {
      advanced = false;
      for (let i = 0; i < count; i += 2) {
        // `<=` so exactly-abutting boxes (a wall built from segments) count as continuous.
        if (spans[i] <= end + 1e-6 && spans[i + 1] > end) { end = spans[i + 1]; advanced = true; }
      }
      if (end >= maxDepth) return maxDepth;
    }
    return end;
  }

  /**
   * Height of the highest walkable surface at (x, z) at or below `maxY`.
   * Used by the nav bake and by prop placement. @returns number | null
   */
  sampleGroundHeight(x, z, maxY = this.bounds.max.y) {
    if (!this._grid) return null;
    const lo = this._grid.miny;
    const n = this._query(x - 1e-3, lo, z - 1e-3, x + 1e-3, maxY, z + 1e-3);
    const bx = this._bx, cand = this._cand;
    let best = -Infinity;
    for (let k = 0; k < n; k++) {
      const o = cand[k] * 6;
      const top = bx[o + 4];
      if (top > maxY || top <= best) continue;
      if (x < bx[o] || x > bx[o + 3] || z < bx[o + 2] || z > bx[o + 5]) continue;
      best = top;
    }
    return best === -Infinity ? null : best;
  }

  /** Convenience for match/bot spawning. `team` -1 accepts any. */
  pickSpawn(team, rng) {
    const list = this.spawnPoints;
    if (!list.length) return null;
    let count = 0;
    for (let i = 0; i < list.length; i++) {
      if (team === undefined || team === -1 || list[i].team === team || list[i].team === -1) count++;
    }
    if (count === 0) return list[Math.floor((rng ? rng() : Math.random()) * list.length)];
    let pick = Math.floor((rng ? rng() : Math.random()) * count);
    for (let i = 0; i < list.length; i++) {
      const sp = list[i];
      if (team === undefined || team === -1 || sp.team === team || sp.team === -1) {
        if (pick-- === 0) return sp;
      }
    }
    return list[0];
  }

  // ────────────────────────────────────────────────────────────────── debug

  /**
   * Toggle a single merged wireframe overlay of every collider. Built lazily on first
   * enable so it costs nothing in a normal session.
   */
  debugDraw(enabled) {
    this._debugEnabled = !!enabled;
    if (enabled && !this._debugMesh) this._buildDebugMesh();
    if (this._debugMesh) this._debugMesh.visible = this._debugEnabled;
    return this._debugEnabled;
  }

  _buildDebugMesh() {
    const n = this.boxes.length;
    if (!n) return;
    // 12 edges × 2 endpoints × 3 floats.
    const pos = new Float32Array(n * 72);
    let w = 0;
    const edge = (ax, ay, az, bxx, by, bz) => {
      pos[w++] = ax; pos[w++] = ay; pos[w++] = az;
      pos[w++] = bxx; pos[w++] = by; pos[w++] = bz;
    };
    for (let i = 0; i < n; i++) {
      const b = this.boxes[i];
      const x0 = b.min.x, y0 = b.min.y, z0 = b.min.z;
      const x1 = b.max.x, y1 = b.max.y, z1 = b.max.z;
      edge(x0, y0, z0, x1, y0, z0); edge(x1, y0, z0, x1, y0, z1);
      edge(x1, y0, z1, x0, y0, z1); edge(x0, y0, z1, x0, y0, z0);
      edge(x0, y1, z0, x1, y1, z0); edge(x1, y1, z0, x1, y1, z1);
      edge(x1, y1, z1, x0, y1, z1); edge(x0, y1, z1, x0, y1, z0);
      edge(x0, y0, z0, x0, y1, z0); edge(x1, y0, z0, x1, y1, z0);
      edge(x1, y0, z1, x1, y1, z1); edge(x0, y0, z1, x0, y1, z1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (!_debugMat) {
      _debugMat = new THREE.LineBasicMaterial({
        color: 0x35ff9b, transparent: true, opacity: 0.55, depthTest: true, fog: false,
      });
    }
    this._debugMesh = new THREE.LineSegments(geo, _debugMat);
    this._debugMesh.name = 'worldColliderDebug';
    this._debugMesh.frustumCulled = false;
    this._debugMesh.renderOrder = 900;
    this._debugMesh.visible = false;
    this.group.add(this._debugMesh);
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh || o.isLineSegments || o.isInstancedMesh) o.geometry?.dispose();
    });
    if (this.group.parent) this.group.parent.remove(this.group);
    this.group.clear();
    this.manifest = null;
    // Materials are owned by assets.js — only the debug-only line material is ours.
    if (_debugMat) { _debugMat.dispose(); _debugMat = null; }
    this._debugMesh = null;
    this._grid = null;
    this.boxes.length = 0;
    this.spawnPoints.length = 0;
  }
}

function clampInt(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
