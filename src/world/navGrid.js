import * as THREE from 'three';
import { clamp } from '../core/mathUtils.js';

/**
 * NavGrid — layered walkability grid + budgeted A* for the AI.
 *
 * The world is a soup of axis-aligned boxes (ARCHITECTURE.md §5), which means a
 * single XZ column can hold several navigable surfaces: the street, the first
 * floor of a building, and its roof. So this is not a 2D grid — every column
 * stores up to MAX_LAYERS {floorY, clearance} entries and links are resolved
 * per-layer. That is what lets bots take the stairs onto a roof and drop off the
 * far side instead of orbiting the building forever.
 *
 * Everything after bake() is allocation-free: node state lives in typed arrays
 * that are stamped with a search generation rather than cleared, the open list
 * is a flat binary heap over node ids, and path output reuses the Vector3s
 * already present in the caller's array.
 */

const CELL = 0.75;
const MAX_LAYERS = 4;

const STAND_CLEARANCE = 1.9;   // metres of headroom required to call a surface walkable
/**
 * The largest rise the MOVER will actually take, which is not the constant it advertises.
 *
 * `World._tryStepUp` computes `targetY = _sweepTop + SKIN` and then refuses when
 * `targetY - y > MAX_STEP_HEIGHT` — so a step of exactly 0.55 is measured as 0.555 and
 * rejected. Nav compared the raw 0.55 with `<=` and authorised it, which is how 27 links
 * came to cross the plaza monument's third tier: a 0.550 m step no player can climb, that
 * the AI was routed over and stalled on. Matching the mover's arithmetic here keeps the two
 * honest with each other.
 */
const SKIN = 0.005;
const STEP_HEIGHT = 0.55 - SKIN;
const DROP_HEIGHT = 2.6;       // a one-way link a bot may fall down but not climb
const INFLATE = 0.30;          // lateral padding so paths keep the 0.36 m body off walls
const FOOT_EPS = 0.06;
const COVER_LOW = 0.15;        // vertical band that counts as "cover" beside a cell
const COVER_HIGH = 1.35;
const MAX_SPANS = 48;          // per-column solid spans considered

// -- staircase probe (see _stairLink)
//
// A cell is 0.75 m; a tread is ~0.36 m deep and rises ~0.22 m. So consecutive
// cell CENTRES on a stair sit two or three treads apart, and the sampled rise
// between neighbouring cells is 0.44 m most of the time but 0.66 m wherever the
// aliasing lands on three treads. 0.66 > STEP_HEIGHT, so the plain height test
// in _bakeLinks read a perfectly climbable staircase as a cliff and dropped the
// link — one missing rung is enough to make the AI route around the whole run.
// When the plain test fails, walk the segment between the two cell centres in
// sub-steps shorter than a tread and ask the geometry the same question the
// player's mover asks: is every individual step at most STEP_HEIGHT?
const SUBSTEP = 0.18;          // < the shallowest tread going on the map (0.29 m)
const STAIR_MAX_RISE = 1.50;   // per cell; past this we do not even probe
const STAIR_HEADROOM = 1.00;   // clearance required over an intermediate sample
// How far ABOVE a path endpoint a surface may sit and still be taken to be where
// that endpoint is. Past this, _endpoint prefers the ring search: a position with
// no floor of its own (inside a wall, under a mezzanine) used to resolve to the
// ROOF several metres up, and the path then started on the roof.
const MAX_SNAP_ABOVE = 1.20;

const F_WALKABLE = 1;
const F_NEARCOVER = 2;

// 8-way neighbours: 0..3 orthogonal, 4..7 diagonal.
const DX = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
// For each diagonal, the two orthogonal directions that must ALSO be open
// (prevents corner-cutting through a wall join).
const DIAG_A = [0, 0, 0, 0, 0, 0, 1, 1];
const DIAG_B = [0, 0, 0, 0, 2, 3, 2, 3];

const SQRT2 = Math.SQRT2;
const HEAP_CAP = 1 << 15;
const NODE_BUDGET = 1800;      // hard cap on expansions; best partial path is returned
// A goal on a different navigable layer (roof, gantry, basement) defeats the
// octile heuristic: it points straight through the floor, so the search floods
// the level below before it finds the stairs. Without a bigger allowance the
// best partial always stops directly under the goal and the bot livelocks
// there, re-pathing to the same spot forever. Multi-level goals are rare, so
// they get a larger one-off budget instead.
// 5000 was measured against a goal one storey up. It is not enough for two.
// Re-measured, spawn -> every roof point of interest on the shipping map:
//
//   budget   5000 -> 59/252 goals actually reached, 0.75 ms/search
//   budget  10000 -> 216/252,                       1.17 ms/search
//   budget  20000 -> 216/252,                       1.19 ms/search
//
// So 5000 sat just under the knee for an 8 m goal and the search gave up in the
// hall below the roof every time — which is why the roof stair, the mezzanine
// stair and the rampart were unreachable in practice even though the bake says
// they are connected. 10000 is the real knee: everything past it buys nothing
// because the remaining failures are goals that genuinely have no route.
// Cost is bounded by BotManager's one-search-per-two-ticks budget, and only a
// cross-layer goal ever draws on it.
const NODE_BUDGET_MULTI = 10000;
const REV_CAP = 4096;

/** What `bake()` sees when the map supplies no §3.5 hints. Frozen so nothing writes it. */
const EMPTY_HINTS = Object.freeze({
  walkable: Object.freeze([]),
  blocked: Object.freeze([]),
  links: Object.freeze([]),
  cover: Object.freeze([]),
});

/**
 * The map-data.md §3 manifest, or null.
 *
 * `world.manifest` is null before `World.init()` and an object after, and its `navHints`
 * key is always present once it exists — so this checks for the KEY rather than for
 * truthiness, which would happily accept a world whose manifest is an unrelated object.
 */
function readManifest(world) {
  const m = world.manifest;
  if (m === null || typeof m !== 'object') return null;
  if (!Object.hasOwn(m, 'navHints') || !Object.hasOwn(m, 'provenance')) return null;
  return m;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _scratchPoint = new THREE.Vector3();

/** Grow an array of Vector3 in place without churning objects. */
function vecAt(arr, i) {
  let v = arr[i];
  if (!v || !v.isVector3) { v = new THREE.Vector3(); arr[i] = v; }
  return v;
}

export class NavGrid {
  constructor(game) {
    this.game = game;
    this.world = null;

    this.cell = CELL;
    this.maxLayers = MAX_LAYERS;
    this.cols = 0;
    this.rows = 0;
    this.nodeCount = 0;
    this.ready = false;

    this.originX = 0;
    this.originZ = 0;
    this.minY = 0;
    this.maxY = 0;

    // --- per-column
    this.layerCount = null;    // Uint8Array(cols*rows)

    // --- per-node (column * MAX_LAYERS + layer)
    this.floorY = null;        // Float32Array
    this.clearance = null;     // Float32Array
    this.flags = null;         // Uint8Array
    this.coverX = null;        // Float32Array — unit vector toward adjacent geometry
    this.coverZ = null;        // Float32Array
    this.danger = null;        // Float32Array, decayed over time
    this.linkMask = null;      // Uint8Array, bit d = direction d is traversable
    this.dropMask = null;      // Uint8Array, bit d = that link is a one-way drop
    this.linkLayer = null;     // Uint8Array(node*8) — destination layer for direction d
    this.reachable = null;     // Uint8Array — forward-reachable from a spawn point

    // --- A* scratch (allocated once)
    this._gScore = null;
    this._fScore = null;
    this._cameFrom = null;
    this._stamp = null;
    this._state = null;        // 1 = open, 2 = closed (valid only when stamp === gen)
    this._heap = new Int32Array(HEAP_CAP);
    this._heapSize = 0;
    this._gen = 0;
    this._rev = new Int32Array(REV_CAP);

    // --- misc scratch
    this._spanMin = new Float32Array(MAX_SPANS);
    this._spanMax = new Float32Array(MAX_SPANS);
    this._spanClass = new Uint8Array(MAX_SPANS);
    this._spanBox = new Int32Array(MAX_SPANS);
    this._cand = new Float32Array(MAX_SPANS + 2);
    this._candCount = 0;

    this._coverCand = new Int32Array(64);
    this._coverScore = new Float32Array(64);

    this.nodeBudget = NODE_BUDGET;
    this.nodeBudgetMulti = NODE_BUDGET_MULTI;

    this._decayCursor = 0;
    this._debug = null;
    this._debugOn = false;

    /**
     * map-data.md §3.5 links that the 8-neighbour grid cannot express — a mantle across a
     * gap, a stair between non-adjacent cells. Map of node -> [{to, cost, kind, oneWay}].
     * Empty when the producer supplies no hints, which is the current MERIDIAN case.
     */
    this.hintLinks = new Map();

    /**
     * What the manifest actually changed, so a harness can assert on it with numbers
     * instead of trusting that the hints were read. Every field is a count of nodes or
     * links the hints MOVED, not of hints supplied — a hint that resolves to nothing is
     * the failure mode worth catching.
     */
    this.hintStats = {
      source: 'none',
      walkableBoxes: 0, blockedBoxes: 0, coverHints: 0, linkHints: 0,
      forcedWalkable: 0, reaffirmedWalkable: 0, forcedBlocked: 0, coverApplied: 0, linksResolved: 0,
      unresolvedWalkable: 0, unresolvedBlocked: 0, unresolvedCover: 0, unresolvedLinks: 0,
    };

    this.stats = { bakeMs: 0, searches: 0, expansions: 0, partials: 0 };
  }

  // ------------------------------------------------------------------ lifecycle

  async init() {
    this.world = this.game.world;
    // Yield once so the boot screen can paint before a ~50 ms synchronous bake.
    await new Promise((r) => setTimeout(r, 0));
    this.bake();
  }

  reset() {
    if (this.danger) this.danger.fill(0);
    // Which slice decays first is part of the simulation — see fixedUpdate. Left
    // running, it leaked across matches.
    this._decayCursor = 0;
    this.stats.searches = 0;
    this.stats.expansions = 0;
    this.stats.partials = 0;
  }

  /**
   * Bleed off danger a slice at a time so it costs nothing.
   *
   * This is SIMULATION, despite looking like housekeeping: `danger` is an A* step cost
   * (see `_search`) and a cover-scoring term, so how fast it decays changes where bots
   * go. It used to run in `update(dtFrame)` on the render clock, which meant danger
   * persisted longer on a slow client than a fast one — and on a headless server, where
   * `update()` is never called at all, it never decayed, so bots progressively refused
   * to path anywhere a shot had ever been fired.
   */
  fixedUpdate(dt) {
    if (!this.ready) return;
    const d = this.danger;
    const n = d.length;
    const slice = Math.min(n, Math.max(1024, (n / 8) | 0));
    // Each cell is visited every n/slice ticks, so scale the rate to match and the
    // decay stays independent of grid size.
    const k = Math.exp(-0.55 * dt * (n / slice));
    let i = this._decayCursor;
    for (let c = 0; c < slice; c++) {
      const v = d[i];
      if (v > 0.001) d[i] = v * k;
      else if (v !== 0) d[i] = 0;
      i++;
      if (i >= n) i = 0;
    }
    this._decayCursor = i;
  }

  /** Render-only: the debug overlay tints by live danger. */
  update() {
    if (this._debugOn) this._updateDebug();
  }

  dispose() {
    this._debugOn = false;
    if (this._debug) {
      const { points, lines } = this._debug;
      points.parent?.remove(points);
      lines.parent?.remove(lines);
      points.geometry.dispose();
      points.material.dispose();
      lines.geometry.dispose();
      lines.material.dispose();
      this._debug = null;
    }
  }

  // ---------------------------------------------------------------------- bake

  bake() {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const world = this.world;
    if (!world || !world.bounds) { console.warn('[nav] no world bounds; nav disabled'); return; }

    // map-data.md §3: bounds come from the manifest when the producer declares them, and
    // from the built world otherwise. `world.bounds` is already the manifest's bounds in
    // the declared case (World.init applies them), so this reads one source either way.
    const manifest = readManifest(world);
    const hints = manifest === null ? EMPTY_HINTS : manifest.navHints;
    this.hintStats.source = manifest === null ? 'none' : manifest.provenance.navHints;
    this.hintStats.walkableBoxes = hints.walkable.length;
    this.hintStats.blockedBoxes = hints.blocked.length;
    this.hintStats.coverHints = hints.cover.length;
    this.hintStats.linkHints = hints.links.length;

    const bmin = world.bounds.min;
    const bmax = world.bounds.max;
    this.originX = bmin.x;
    this.originZ = bmin.z;
    this.minY = bmin.y;
    this.maxY = bmax.y;
    this.cols = Math.max(1, Math.ceil((bmax.x - bmin.x) / CELL));
    this.rows = Math.max(1, Math.ceil((bmax.z - bmin.z) / CELL));

    const cells = this.cols * this.rows;
    const n = cells * MAX_LAYERS;
    this.nodeCount = n;

    this.layerCount = new Uint8Array(cells);
    this.floorY = new Float32Array(n);
    this.clearance = new Float32Array(n);
    this.flags = new Uint8Array(n);
    this.coverX = new Float32Array(n);
    this.coverZ = new Float32Array(n);
    this.danger = new Float32Array(n);
    this.linkMask = new Uint8Array(n);
    this.dropMask = new Uint8Array(n);
    this.linkLayer = new Uint8Array(n * 8);
    this.reachable = new Uint8Array(n);

    this._gScore = new Float32Array(n);
    this._fScore = new Float32Array(n);
    this._cameFrom = new Int32Array(n);
    this._stamp = new Uint32Array(n);
    this._state = new Uint8Array(n);

    this.hintLinks = new Map();
    this.hintStats.forcedWalkable = 0;
    this.hintStats.reaffirmedWalkable = 0;
    this.hintStats.forcedBlocked = 0;
    this.hintStats.coverApplied = 0;
    this.hintStats.linksResolved = 0;
    this.hintStats.unresolvedWalkable = 0;
    this.hintStats.unresolvedBlocked = 0;
    this.hintStats.unresolvedCover = 0;
    this.hintStats.unresolvedLinks = 0;

    const boxes = world.boxes || [];
    const { start, list } = this._rasterizeBoxes(boxes);
    this._bakeColumns(boxes, start, list);
    // §3.5 order matters: force-walkable first so a hinted ledge can then be linked, then
    // force-blocked so a sill the raster wrongly liked is gone BEFORE links are cut — a
    // blocked node that keeps its links is exactly the phantom this repository shipped.
    this._applyWalkableHints(boxes, start, list, hints.walkable);
    this._applyBlockedHints(hints.blocked);
    this._bakeLinks(boxes, start, list);
    this._applyLinkHints(hints.links);
    this._applyCoverHints(hints.cover);
    // Before _bakeReachability, which seeds itself through `nodeAt` — and `nodeAt`
    // refuses to answer until the grid says it is ready.
    this.ready = true;
    this._bakeReachability();
    this.stats.bakeMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

    let walkable = 0;
    for (let i = 0; i < n; i++) if (this.flags[i] & F_WALKABLE) walkable++;
    this.walkableCount = walkable;
    const hs = this.hintStats;
    const hintNote = hs.source === 'declared'
      ? ` — hints: +${hs.forcedWalkable} walkable, -${hs.forcedBlocked} blocked, `
        + `${hs.linksResolved}/${hs.linkHints} links, ${hs.coverApplied}/${hs.coverHints} cover`
      : ` — no manifest nav hints (${hs.source})`;
    if (typeof process !== 'undefined' && process.env?.OVERSTRIKE_STRUCTURED_LOGS === 'true') {
      console.info(JSON.stringify({ ts: new Date().toISOString(), level: 'info', service: 'match-server',
        event: 'nav.baked', cols: this.cols, rows: this.rows, cellMeters: CELL, walkable,
        bakeMs: Number(this.stats.bakeMs.toFixed(1)), hintSource: hs.source }));
    } else console.info(
      `[nav] baked ${this.cols}x${this.rows} @ ${CELL}m — ${walkable} walkable nodes in ${this.stats.bakeMs.toFixed(1)} ms${hintNote}`,
    );
  }

  // ------------------------------------------------------- §3.5 nav hint application

  /**
   * Insert a walkable node at `y` in a column, keeping layers sorted by height.
   *
   * Sorted because everything downstream relies on it: `_groundNodeAt` takes the FIRST
   * walkable layer as "the ground here", and `samplePoints` pass 2 skips the first as
   * pass 1's business. An out-of-order insert would put a hinted roof ledge in the ground
   * lattice. Returns the node id, or -1 if the column is full.
   */
  _insertNode(col, y, clearance) {
    const base = col * MAX_LAYERS;
    let count = this.layerCount[col];
    for (let l = 0; l < count; l++) {
      if (Math.abs(this.floorY[base + l] - y) < 0.05) return base + l;   // already there
    }
    if (count >= MAX_LAYERS) return -1;
    let at = count;
    while (at > 0 && this.floorY[base + at - 1] > y) at--;
    for (let l = count; l > at; l--) {
      const dst = base + l, srcN = base + l - 1;
      this.floorY[dst] = this.floorY[srcN];
      this.clearance[dst] = this.clearance[srcN];
      this.flags[dst] = this.flags[srcN];
      this.coverX[dst] = this.coverX[srcN];
      this.coverZ[dst] = this.coverZ[srcN];
    }
    const node = base + at;
    this.floorY[node] = y;
    this.clearance[node] = clearance;
    // Created UNFLAGGED. The caller decides walkability, which is what lets it tell a
    // node it just created apart from one the raster had already found — and a counter
    // that cannot tell those apart is a counter that reports success for a hint that
    // changed nothing.
    this.flags[node] = 0;
    this.coverX[node] = 0;
    this.coverZ[node] = 0;
    this.layerCount[col] = count + 1;
    return node;
  }

  /**
   * §3.5 `walkable`: force-walkable volumes for surfaces the raster misses.
   *
   * The hint is a VOLUME, and which surface inside it is meant matters:
   *
   *   - if a real collider top lies inside the volume, THAT is the surface. The hint is
   *     saying "the thing in here is walkable", and the node goes on the geometry.
   *   - only when the volume contains no collider top does the volume's own top face
   *     become the surface — the thin-ledge case the contract describes.
   *
   * Reading it the other way round — always using the volume's top face — is not a
   * theoretical distinction. The Square hints its whole ground plane as the volume
   * y ∈ [-0.1, 0.35] over a slab whose top is y = 0; taking the top face put a second
   * walkable layer 0.35 m above every square metre of the district, 10,909 extra nodes
   * standing on nothing, and the bake read 47% phantom — the exact defect this
   * repository has already shipped once.
   *
   * Clearance is measured from real geometry either way: a hint cannot conjure headroom,
   * or bots path into a ceiling.
   */
  _applyWalkableHints(boxes, start, list, hintBoxes) {
    for (const hb of hintBoxes) {
      const cx0 = clamp(Math.floor((hb.min.x - this.originX) / CELL), 0, this.cols - 1);
      const cx1 = clamp(Math.floor((hb.max.x - this.originX) / CELL), 0, this.cols - 1);
      const cz0 = clamp(Math.floor((hb.min.z - this.originZ) / CELL), 0, this.rows - 1);
      const cz1 = clamp(Math.floor((hb.max.z - this.originZ) / CELL), 0, this.rows - 1);
      let applied = 0, reaffirmed = 0;
      for (let cz = cz0; cz <= cz1; cz++) {
        const wz = this.originZ + (cz + 0.5) * CELL;
        if (wz < hb.min.z || wz > hb.max.z) continue;
        for (let cx = cx0; cx <= cx1; cx++) {
          const wx = this.originX + (cx + 0.5) * CELL;
          if (wx < hb.min.x || wx > hb.max.x) continue;
          const col = cz * this.cols + cx;
          const y = this._surfaceInBand(boxes, start, list, wx, wz, hb.min.y, hb.max.y);
          const clear = this._clearanceAt(boxes, start, list, wx, wz, y);
          if (clear < STAND_CLEARANCE) continue;   // no headroom: the hint is simply wrong
          const node = this._insertNode(col, y, clear);
          if (node < 0) continue;
          // Counted separately on purpose. A hint over ground the raster already liked
          // changes nothing, and folding the two together would let a hint that does
          // nothing at all report a healthy number.
          if (this.flags[node] & F_WALKABLE) { reaffirmed++; continue; }
          this.flags[node] |= F_WALKABLE;
          applied++;
        }
      }
      this.hintStats.forcedWalkable += applied;
      this.hintStats.reaffirmedWalkable += reaffirmed;
      if (applied === 0 && reaffirmed === 0) this.hintStats.unresolvedWalkable++;
    }
  }

  /**
   * The highest collider top at (x, z) inside [`lo`, `hi`], or `hi` when the band holds
   * no geometry — i.e. "the surface this force-walkable volume is talking about".
   */
  _surfaceInBand(boxes, start, list, x, z, lo, hi) {
    const col = this.colOf(x, z);
    if (col < 0) return hi;
    let best = -Infinity;
    for (let k = start[col]; k < start[col + 1]; k++) {
      const bx = boxes[list[k]];
      if (x < bx.min.x || x > bx.max.x || z < bx.min.z || z > bx.max.z) continue;
      const t = bx.max.y;
      if (t < lo - 1e-4 || t > hi + 1e-4) continue;
      if (t > best) best = t;
    }
    return best === -Infinity ? hi : best;
  }

  /** Headroom above `y` at (x, z) from the real box set. */
  _clearanceAt(boxes, start, list, x, z, y) {
    const col = this.colOf(x, z);
    if (col < 0) return 0;
    let clear = this.maxY - y;
    for (let k = start[col]; k < start[col + 1]; k++) {
      const bx = boxes[list[k]];
      if (x < bx.min.x - INFLATE || x > bx.max.x + INFLATE) continue;
      if (z < bx.min.z - INFLATE || z > bx.max.z + INFLATE) continue;
      if (bx.max.y > y + FOOT_EPS && bx.min.y < y + FOOT_EPS) return 0;   // solid at foot level
      if (bx.min.y >= y + FOOT_EPS) {
        const c = bx.min.y - y;
        if (c < clear) clear = c;
      }
    }
    return clear;
  }

  /**
   * §3.5 `blocked`: force-unwalkable. Window sills, parapet caps, decorative ledges — the
   * surfaces the baker cheerfully calls walkable and bots then stand on. A hint that
   * matches no node is counted, not ignored: it means the geometry moved out from under
   * the hint, which is the same class of drift as a stale nav bake.
   */
  _applyBlockedHints(hintBoxes) {
    for (const hb of hintBoxes) {
      const cx0 = clamp(Math.floor((hb.min.x - this.originX) / CELL), 0, this.cols - 1);
      const cx1 = clamp(Math.floor((hb.max.x - this.originX) / CELL), 0, this.cols - 1);
      const cz0 = clamp(Math.floor((hb.min.z - this.originZ) / CELL), 0, this.rows - 1);
      const cz1 = clamp(Math.floor((hb.max.z - this.originZ) / CELL), 0, this.rows - 1);
      let applied = 0;
      for (let cz = cz0; cz <= cz1; cz++) {
        const wz = this.originZ + (cz + 0.5) * CELL;
        if (wz < hb.min.z || wz > hb.max.z) continue;
        for (let cx = cx0; cx <= cx1; cx++) {
          const wx = this.originX + (cx + 0.5) * CELL;
          if (wx < hb.min.x || wx > hb.max.x) continue;
          const col = cz * this.cols + cx;
          const nl = this.layerCount[col];
          for (let l = 0; l < nl; l++) {
            const node = col * MAX_LAYERS + l;
            if (!(this.flags[node] & F_WALKABLE)) continue;
            const y = this.floorY[node];
            // A foot standing at `y` is inside the volume if the volume covers the band
            // from the surface up to knee height; matching only the exact top face would
            // miss a sill hinted as a whole solid.
            if (y < hb.min.y - 0.05 || y > hb.max.y + 0.05) continue;
            this.flags[node] &= ~F_WALKABLE;
            this.linkMask[node] = 0;
            this.dropMask[node] = 0;
            applied++;
          }
        }
      }
      this.hintStats.forcedBlocked += applied;
      if (applied === 0) this.hintStats.unresolvedBlocked++;
    }
  }

  /**
   * §3.5 `links`: affordances the 8-neighbour raster cannot express — a mantle over a
   * gap, a stair between cells that are not neighbours. Stored as an explicit adjacency
   * consulted by reachability and A*, so a hinted route is a route bots really take
   * rather than a comment in the manifest.
   *
   * `drop` is one-way, matching the baked drop semantics: you may fall down it, not climb
   * it. `stair` and `mantle` are two-way.
   */
  _applyLinkHints(links) {
    for (const l of links) {
      const a = this._hintNode(l.from);
      const b = this._hintNode(l.to);
      if (a < 0 || b < 0 || a === b) { this.hintStats.unresolvedLinks++; continue; }
      const ax = this.cellCenterX((a / MAX_LAYERS) | 0), az = this.cellCenterZ((a / MAX_LAYERS) | 0);
      const bx = this.cellCenterX((b / MAX_LAYERS) | 0), bz = this.cellCenterZ((b / MAX_LAYERS) | 0);
      const dist = Math.hypot(bx - ax, bz - az) + Math.abs(this.floorY[b] - this.floorY[a]) * 0.9;
      const penalty = l.kind === 'mantle' ? 1.2 : l.kind === 'drop' ? 1.6 : 0.2;
      this._addHintLink(a, b, dist + penalty, l.kind);
      if (l.kind !== 'drop') this._addHintLink(b, a, dist + penalty, l.kind);
      this.hintStats.linksResolved++;
    }
  }

  _addHintLink(from, to, cost, kind) {
    const arr = this.hintLinks.get(from);
    if (arr === undefined) this.hintLinks.set(from, [{ to, cost, kind }]);
    else arr.push({ to, cost, kind });
  }

  /**
   * The walkable node a hint point refers to, or -1.
   *
   * The hint's own column first, then its eight neighbours — a hint is authored at a
   * position, not on a 0.75 m lattice, and the foot of a stair lands a few centimetres
   * either side of a cell boundary depending on where the stair was drawn. One cell of
   * tolerance, no more.
   *
   * VERTICAL tolerance is the strict one: 1.2 m, so a hint authored at head height or at
   * the foot of a step resolves, and a hint a whole storey off does NOT. Snapping that
   * one to the nearest floor is how a link ends up on the wrong level, and a link on the
   * wrong level is worse than no link — it is a route the bake swears exists.
   */
  _hintNode(p) {
    let best = -1, bestErr = Infinity, bestDist = Infinity;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const col = this.colOf(p.x + dx * CELL, p.z + dz * CELL);
        if (col < 0) continue;
        const lateral = Math.hypot(this.cellCenterX(col) - p.x, this.cellCenterZ(col) - p.z);
        const nl = this.layerCount[col];
        for (let l = 0; l < nl; l++) {
          const node = col * MAX_LAYERS + l;
          if (!(this.flags[node] & F_WALKABLE)) continue;
          const err = Math.abs(this.floorY[node] - p.y);
          if (err > 1.2) continue;
          // Height agreement dominates: a node on the right floor one cell away beats a
          // node in the exact column on the floor below.
          if (err < bestErr - 0.05 || (err < bestErr + 0.05 && lateral < bestDist)) {
            bestErr = err; bestDist = lateral; best = node;
          }
        }
      }
    }
    return best;
  }

  /**
   * §3.5 `cover`: an authored cover node with a facing. Overrides the derived cover
   * direction, which is a centroid of nearby geometry and cannot know that a designer
   * means "this corner, looking down that lane".
   */
  _applyCoverHints(cover) {
    for (const c of cover) {
      const node = this._hintNode(c.position);
      if (node < 0) { this.hintStats.unresolvedCover++; continue; }
      this.flags[node] |= F_NEARCOVER;
      this.coverX[node] = -Math.sin(c.facing);
      this.coverZ[node] = -Math.cos(c.facing);
      this.hintStats.coverApplied++;
    }
  }

  /**
   * CSR bucket of box indices per column, using an INFLATED footprint so a cell
   * only survives if a 0.36 m body actually fits there.
   */
  _rasterizeBoxes(boxes) {
    const cells = this.cols * this.rows;
    const counts = new Int32Array(cells + 1);
    const cols = this.cols, rows = this.rows;

    for (let b = 0; b < boxes.length; b++) {
      const bx = boxes[b];
      if (!bx || !bx.min || !bx.max) continue;
      const x0 = clamp(Math.floor((bx.min.x - INFLATE - this.originX) / CELL), 0, cols - 1);
      const x1 = clamp(Math.floor((bx.max.x + INFLATE - this.originX) / CELL), 0, cols - 1);
      const z0 = clamp(Math.floor((bx.min.z - INFLATE - this.originZ) / CELL), 0, rows - 1);
      const z1 = clamp(Math.floor((bx.max.z + INFLATE - this.originZ) / CELL), 0, rows - 1);
      if (x1 < x0 || z1 < z0) continue;
      for (let cz = z0; cz <= z1; cz++) {
        const row = cz * cols;
        for (let cx = x0; cx <= x1; cx++) counts[row + cx + 1]++;
      }
    }
    for (let i = 0; i < cells; i++) counts[i + 1] += counts[i];
    const total = counts[cells];
    const list = new Int32Array(total);
    const cursor = counts.slice(0, cells);

    for (let b = 0; b < boxes.length; b++) {
      const bx = boxes[b];
      if (!bx || !bx.min || !bx.max) continue;
      const x0 = clamp(Math.floor((bx.min.x - INFLATE - this.originX) / CELL), 0, cols - 1);
      const x1 = clamp(Math.floor((bx.max.x + INFLATE - this.originX) / CELL), 0, cols - 1);
      const z0 = clamp(Math.floor((bx.min.z - INFLATE - this.originZ) / CELL), 0, rows - 1);
      const z1 = clamp(Math.floor((bx.max.z + INFLATE - this.originZ) / CELL), 0, rows - 1);
      if (x1 < x0 || z1 < z0) continue;
      for (let cz = z0; cz <= z1; cz++) {
        const row = cz * cols;
        for (let cx = x0; cx <= x1; cx++) list[cursor[row + cx]++] = b;
      }
    }
    return { start: counts, list };
  }

  _bakeColumns(boxes, start, list) {
    const cols = this.cols, rows = this.rows;
    const spanMin = this._spanMin, spanMax = this._spanMax;
    const spanClass = this._spanClass, spanBox = this._spanBox;
    const cand = this._cand;

    for (let cz = 0; cz < rows; cz++) {
      const wz = this.originZ + (cz + 0.5) * CELL;
      for (let cx = 0; cx < cols; cx++) {
        const wx = this.originX + (cx + 0.5) * CELL;
        const col = cz * cols + cx;
        const s0 = start[col], s1 = start[col + 1];

        // -- gather solid spans, classified against THIS cell centre.
        //    The CSR bucket is built at cell-index granularity, so it lists
        //    boxes up to a cell away. Classifying here is what keeps a crate
        //    from sterilising the walkable cells around it:
        //      2 = centre inside the box            -> supplies a floor, blocks
        //      1 = centre inside the box + INFLATE  -> blocks (body clearance)
        //      0 = merely nearby                    -> cover only
        let ns = 0;
        for (let k = s0; k < s1 && ns < MAX_SPANS; k++) {
          const b = list[k];
          const bx = boxes[b];
          let cls = 0;
          if (wx >= bx.min.x - INFLATE && wx <= bx.max.x + INFLATE
            && wz >= bx.min.z - INFLATE && wz <= bx.max.z + INFLATE) {
            cls = (wx >= bx.min.x && wx <= bx.max.x && wz >= bx.min.z && wz <= bx.max.z) ? 2 : 1;
          }
          spanMin[ns] = bx.min.y;
          spanMax[ns] = bx.max.y;
          spanClass[ns] = cls;
          spanBox[ns] = b;
          ns++;
        }

        // -- candidate floor heights: world floor + the top of every covering box
        let nc = 0;
        // `minY` is the world's lower BOUND, not a surface. Seeding it unconditionally
        // gave every column a walkable node in the void under the terrain slab (which is
        // only 1 m thick), i.e. a complete wall-free copy of the map 3 m down — and it
        // burned one of the MAX_LAYERS slots everywhere. Only use it where the column
        // holds no geometry at all; otherwise the ground is the top of the lowest box,
        // which the loop below already contributes.
        let roofed = false;
        for (let i = 0; i < ns; i++) {
          if (spanClass[i] === 2 && spanMin[i] > this.minY) { roofed = true; break; }
        }
        // A column with no box UNDER ITS CENTRE has no floor, and `minY` is a bound, not a
        // surface. Seeding it manufactured playspace out of the void: on The Square, 235
        // walkable nodes 4 m below the district in the half-cell the grid overhangs its
        // bounds by, and in the skirt around the boundary wall where the only geometry
        // near the cell centre is beside it rather than beneath it. Every real floor —
        // including the ground slab — arrives below as the top of a class-2 span.
        let hasFloor = false;
        for (let i = 0; i < ns; i++) if (spanClass[i] === 2) { hasFloor = true; break; }
        if (!roofed && hasFloor) cand[nc++] = this.minY;
        for (let i = 0; i < ns; i++) {
          if (spanClass[i] !== 2) continue;
          const y = spanMax[i];
          if (y > this.maxY - STAND_CLEARANCE * 0.5) continue;
          cand[nc++] = y;
        }
        // tiny insertion sort + dedupe (nc is small)
        for (let i = 1; i < nc; i++) {
          const v = cand[i];
          let j = i - 1;
          while (j >= 0 && cand[j] > v) { cand[j + 1] = cand[j]; j--; }
          cand[j + 1] = v;
        }

        let layers = 0;
        let prev = -Infinity;
        for (let ci = 0; ci < nc && layers < MAX_LAYERS; ci++) {
          const y = cand[ci];
          if (y - prev < 0.28) continue;

          // -- clearance / blocking
          let clear = this.maxY - y;
          let blocked = false;
          for (let i = 0; i < ns; i++) {
            if (spanClass[i] === 0) continue;
            const smin = spanMin[i], smax = spanMax[i];
            if (smax > y + FOOT_EPS && smin < y + FOOT_EPS) {
              // A kerb or plinth the body simply steps onto is not an obstruction:
              // World lets a mover step up STEP_HEIGHT. This only applies to class-1
              // spans — the INFLATE skirt, where the cell centre is NEXT to the box,
              // not on it. A class-2 span underfoot already contributes its own top as
              // a floor candidate, so leaving it blocking is correct.
              if (spanClass[i] === 1 && smax <= y + STEP_HEIGHT) continue;
              blocked = true; break;
            }
            if (smin >= y + FOOT_EPS) {
              const c = smin - y;
              if (c < clear) clear = c;
            }
          }
          if (blocked || clear < STAND_CLEARANCE) continue;

          // -- cover: nearby geometry (not underfoot) in the chest band
          let cvx = 0, cvz = 0, cvn = 0;
          for (let i = 0; i < ns; i++) {
            if (spanClass[i] === 2) continue;
            if (spanMax[i] <= y + COVER_LOW || spanMin[i] >= y + COVER_HIGH) continue;
            const bx = boxes[spanBox[i]];
            cvx += (bx.min.x + bx.max.x) * 0.5 - wx;
            cvz += (bx.min.z + bx.max.z) * 0.5 - wz;
            cvn++;
          }

          const node = col * MAX_LAYERS + layers;
          this.floorY[node] = y;
          this.clearance[node] = clear;
          let f = F_WALKABLE;
          if (cvn > 0) {
            const len = Math.hypot(cvx, cvz);
            if (len > 1e-4) {
              this.coverX[node] = cvx / len;
              this.coverZ[node] = cvz / len;
              f |= F_NEARCOVER;
            }
          }
          this.flags[node] = f;
          layers++;
          prev = y;
        }
        this.layerCount[col] = layers;
      }
    }
  }

  /**
   * Highest solid top under (x, z) that a mover standing at `fromY` could step onto,
   * or -Infinity if the point has no support or is inside something solid.
   *
   * Deliberately a point test, not the INFLATE footprint used for cells: this probes
   * the middle of a stair run, where the stringers and the wall beside the treads are
   * within the skirt of every sample and would veto the whole staircase.
   */
  _supportAt(boxes, start, list, x, z, fromY) {
    const col = this.colOf(x, z);
    if (col < 0) return -Infinity;
    const s0 = start[col], s1 = start[col + 1];
    const ceilY = fromY + STEP_HEIGHT + 1e-4;
    let best = -Infinity;
    for (let k = s0; k < s1; k++) {
      const bx = boxes[list[k]];
      if (x < bx.min.x || x > bx.max.x || z < bx.min.z || z > bx.max.z) continue;
      const t = bx.max.y;
      if (t <= ceilY && t > best) best = t;
    }
    if (best === -Infinity) return -Infinity;
    for (let k = s0; k < s1; k++) {
      const bx = boxes[list[k]];
      if (x < bx.min.x || x > bx.max.x || z < bx.min.z || z > bx.max.z) continue;
      // Something standing ON that surface — a wall, a crate — is not a step.
      if (bx.max.y > best + FOOT_EPS && bx.min.y < best + STAIR_HEADROOM) return -Infinity;
    }
    return best;
  }

  /**
   * Is the height difference between two cell centres a staircase rather than a cliff?
   * True only when every sub-step of the segment between them is within STEP_HEIGHT,
   * which is exactly the rule World's mover applies.
   */
  _stairLink(boxes, start, list, x0, z0, y0, x1, z1, y1) {
    const dx = x1 - x0, dz = z1 - z0;
    const steps = Math.max(2, Math.ceil(Math.hypot(dx, dz) / SUBSTEP));
    let prev = y0;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const y = i === steps
        ? y1
        : this._supportAt(boxes, start, list, x0 + dx * t, z0 + dz * t, prev);
      if (!(Math.abs(y - prev) <= STEP_HEIGHT)) return false;   // also catches -Infinity
      prev = y;
    }
    return true;
  }

  _bakeLinks(boxes, start, list) {
    const cols = this.cols, rows = this.rows;
    const lc = this.layerCount, floorY = this.floorY, flags = this.flags;

    for (let cz = 0; cz < rows; cz++) {
      for (let cx = 0; cx < cols; cx++) {
        const col = cz * cols + cx;
        const nl = lc[col];
        for (let l = 0; l < nl; l++) {
          const node = col * MAX_LAYERS + l;
          if (!(flags[node] & F_WALKABLE)) continue;
          const y = floorY[node];
          let mask = 0, drops = 0;

          const wx = this.originX + (cx + 0.5) * CELL;
          const wz = this.originZ + (cz + 0.5) * CELL;

          for (let d = 0; d < 8; d++) {
            const nx = cx + DX[d], nz = cz + DZ[d];
            if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
            const ncol = nz * cols + nx;
            const count = lc[ncol];
            const wnx = this.originX + (nx + 0.5) * CELL;
            const wnz = this.originZ + (nz + 0.5) * CELL;
            let best = -1, bestDiff = Infinity, bestDrop = 0;
            for (let k = 0; k < count; k++) {
              const nn = ncol * MAX_LAYERS + k;
              if (!(flags[nn] & F_WALKABLE)) continue;
              const dy = floorY[nn] - y;
              const ady = Math.abs(dy);
              let isDrop = 0;
              if (ady > STEP_HEIGHT) {
                // A staircase samples as a run of small cliffs (see SUBSTEP): if the
                // geometry in between really is treads, this is an ordinary two-way
                // link, up or down. Otherwise: falling is allowed (one-way), climbing
                // is not.
                const stair = ady <= STAIR_MAX_RISE
                  && this._stairLink(boxes, start, list, wx, wz, y, wnx, wnz, floorY[nn]);
                if (!stair) {
                  if (dy < 0 && ady <= DROP_HEIGHT) isDrop = 1;
                  else continue;
                }
              }
              const score = ady + isDrop * 0.9;
              if (score < bestDiff) { bestDiff = score; best = k; bestDrop = isDrop; }
            }
            if (best >= 0) {
              mask |= (1 << d);
              if (bestDrop) drops |= (1 << d);
              this.linkLayer[node * 8 + d] = best;
            }
          }

          // No corner-cutting: a diagonal needs both of its orthogonal partners.
          for (let d = 4; d < 8; d++) {
            if (!(mask & (1 << d))) continue;
            const a = 1 << DIAG_A[d], b = 1 << DIAG_B[d];
            if (!(mask & a) || !(mask & b)) mask &= ~(1 << d);
          }
          this.linkMask[node] = mask;
          this.dropMask[node] = drops & mask;
        }
      }
    }
  }

  /**
   * Which nodes a bot that starts at a spawn point can actually walk to.
   *
   * The bake is generous — it calls any box top with headroom walkable — so the grid
   * contains a lot of surface no one can get to: perimeter parapets, the tops of the
   * skyline blocks, decorative ledges. Measured on the shipping map that is 4129 of
   * 15997 walkable nodes, ALL of the 983 at y=15 and every node above y=8.
   *
   * That is harmless while the AI only ever samples the ground, and actively dangerous
   * the moment it does not: `samplePoints` would hand the sweep board a point of
   * interest on an unclimbable roof, `findPath` would return the best partial (which
   * stops directly underneath it), and the bot would stand there re-pathing until the
   * patrol timer expired. So the set is computed once, here, and anything that picks a
   * DESTINATION filters by it.
   *
   * Forward BFS, because drops are one-way: reachability means "a bot can get there",
   * not "the surfaces touch". If the world has no spawn points yet, everything is
   * marked reachable, which is exactly the pre-existing behaviour.
   */
  _bakeReachability() {
    const reach = this.reachable;
    const spawns = this.world?.spawnPoints;
    if (!spawns || spawns.length === 0) { reach.fill(1); return; }

    // Each node is pushed at most once (it is marked as it is pushed), so this is
    // an exact bound. One-off bake allocation; nothing here runs per frame.
    const queue = new Int32Array(this.nodeCount);
    let top = 0;
    for (let i = 0; i < spawns.length; i++) {
      const p = spawns[i]?.position;
      if (!p) continue;
      // +0.2: a spawn sits ON the floor, and nodeAt prefers a surface at or below.
      const node = this.nodeAt(p.x, p.y + 0.2, p.z);
      if (node >= 0 && !reach[node]) { reach[node] = 1; queue[top++] = node; }
    }
    if (top === 0) { reach.fill(1); return; }

    const cols = this.cols, rows = this.rows;
    const flags = this.flags, linkMask = this.linkMask, linkLayer = this.linkLayer;
    while (top > 0) {
      const cur = queue[--top];
      const col = (cur / MAX_LAYERS) | 0;
      const cx = col % cols, cz = (col / cols) | 0;
      // §3.5 hinted links are traversable, so they carry reachability. A hinted mantle
      // that the flood ignored would leave its destination marked unreachable, and every
      // destination picker filters by `reachable` — the hint would exist and do nothing.
      const extra = this.hintLinks.get(cur);
      if (extra !== undefined) {
        for (const e of extra) {
          if (!(flags[e.to] & F_WALKABLE) || reach[e.to]) continue;
          reach[e.to] = 1;
          queue[top++] = e.to;
        }
      }
      const mask = linkMask[cur];
      if (mask === 0) continue;
      for (let d = 0; d < 8; d++) {
        if (!(mask & (1 << d))) continue;
        const nx = cx + DX[d], nz = cz + DZ[d];
        if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
        const nn = (nz * cols + nx) * MAX_LAYERS + linkLayer[cur * 8 + d];
        if (!(flags[nn] & F_WALKABLE) || reach[nn]) continue;
        reach[nn] = 1;
        queue[top++] = nn;
      }
    }
  }

  // ------------------------------------------------------------------- queries

  colOf(x, z) {
    const cx = Math.floor((x - this.originX) / CELL);
    const cz = Math.floor((z - this.originZ) / CELL);
    if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) return -1;
    return cz * this.cols + cx;
  }

  cellCenterX(col) { return this.originX + ((col % this.cols) + 0.5) * CELL; }
  cellCenterZ(col) { return this.originZ + (((col / this.cols) | 0) + 0.5) * CELL; }

  isWalkable(node) { return node >= 0 && (this.flags[node] & F_WALKABLE) !== 0; }

  /**
   * Does this node connect to anything at all?
   *
   * Grid links OR a §3.5 hinted link. Every "is this an island" test has to ask both:
   * a ledge whose only way off is an authored mantle has `linkMask === 0`, and the four
   * destination pickers that used to test the mask alone would have refused to send a
   * bot anywhere the manifest had just made reachable.
   */
  _linked(node) { return this.linkMask[node] !== 0 || this.hintLinks.has(node); }
  isNearCover(node) { return node >= 0 && (this.flags[node] & F_NEARCOVER) !== 0; }

  /** Node whose floor best matches a world position, or -1. */
  nodeAt(x, y, z) {
    if (!this.ready) return -1;
    const col = this.colOf(x, z);
    if (col < 0) return -1;
    const n = this.layerCount[col];
    let best = -1, bestErr = Infinity;
    for (let l = 0; l < n; l++) {
      const node = col * MAX_LAYERS + l;
      if (!(this.flags[node] & F_WALKABLE)) continue;
      const dy = y - this.floorY[node];
      // Prefer a surface at or just below the query point.
      const err = dy >= -0.6 ? dy : (-dy) * 3 + 2;
      if (err < bestErr) { bestErr = err; best = node; }
    }
    return best;
  }

  nodeCenter(node, out) {
    const col = (node / MAX_LAYERS) | 0;
    out.set(this.cellCenterX(col), this.floorY[node], this.cellCenterZ(col));
    return out;
  }

  /**
   * Nearest walkable node centre to `pos`. Returns `out` or null.
   *
   * Prefers a node a bot can actually get to. The bake calls the top of every skyline
   * block walkable, so an unfiltered nearest-hit near the map edge snapped destinations
   * onto 15 m roofs with no route up — a retreat or a flank would aim at one, walk into
   * the wall underneath it and burn the state timer. `reachableOnly = false` is the
   * escape hatch for callers that are locating a BODY rather than choosing a
   * destination, where the answer must exist even if it is an island.
   *
   * `maxAbove` refuses a surface that sits more than that far OVER `pos` — see
   * _endpoint, whose whole problem is columns whose only layer is the roof.
   */
  nearestWalkable(pos, out = _scratchPoint, reachableOnly = false, maxAbove = Infinity) {
    if (!this.ready) return null;
    let node = this.nodeAt(pos.x, pos.y, pos.z);
    if (node >= 0 && (!reachableOnly || this.reachable[node])
      && this.floorY[node] - pos.y <= maxAbove) return this.nodeCenter(node, out);

    const cx0 = Math.floor((pos.x - this.originX) / CELL);
    const cz0 = Math.floor((pos.z - this.originZ) / CELL);
    for (let r = 1; r <= 10; r++) {
      let best = -1, bestD = Infinity;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const cx = cx0 + dx, cz = cz0 + dz;
          if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) continue;
          const col = cz * this.cols + cx;
          const n = this.layerCount[col];
          for (let l = 0; l < n; l++) {
            const node2 = col * MAX_LAYERS + l;
            if (!(this.flags[node2] & F_WALKABLE)) continue;
            if (reachableOnly && !this.reachable[node2]) continue;
            if (this.floorY[node2] - pos.y > maxAbove) continue;
            const ddx = this.cellCenterX(col) - pos.x;
            const ddz = this.cellCenterZ(col) - pos.z;
            const ddy = (this.floorY[node2] - pos.y) * 2.2;
            const d = ddx * ddx + ddz * ddz + ddy * ddy;
            if (d < bestD) { bestD = d; best = node2; }
          }
        }
      }
      if (best >= 0) return this.nodeCenter(best, out);
    }
    // Nothing reachable within ten rings — better an island than no answer at all.
    return reachableOnly ? this.nearestWalkable(pos, out, false, maxAbove) : null;
  }

  /**
   * A random reachable-looking point within `radius` of `pos`. Returns `out` or null.
   *
   * `rng` is the CALLER's stream. Drawing from `game.rng` here made one bot's patrol
   * destination depend on how many draws every other bot had made first, which is the
   * coupling per-bot streams exist to remove.
   */
  randomPointNear(pos, radius, out = _scratchPoint, rng = this.game.rng) {
    if (!this.ready) return null;
    const cells = Math.max(1, Math.round(radius / CELL));
    const cx0 = Math.floor((pos.x - this.originX) / CELL);
    const cz0 = Math.floor((pos.z - this.originZ) / CELL);
    for (let attempt = 0; attempt < 24; attempt++) {
      const a = rng() * Math.PI * 2;
      const r = cells * Math.sqrt(rng());
      const cx = cx0 + Math.round(Math.cos(a) * r);
      const cz = cz0 + Math.round(Math.sin(a) * r);
      if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) continue;
      const col = cz * this.cols + cx;
      const n = this.layerCount[col];
      if (n === 0) continue;
      // Bias to the layer closest to the query height so we stay on our floor.
      let best = -1, bestErr = Infinity;
      for (let l = 0; l < n; l++) {
        const node = col * MAX_LAYERS + l;
        if (!(this.flags[node] & F_WALKABLE)) continue;
        if (!this._linked(node)) continue;
        const err = Math.abs(this.floorY[node] - pos.y);
        if (err < bestErr) { bestErr = err; best = node; }
      }
      if (best < 0 || bestErr > 4.5) continue;
      return this.nodeCenter(best, out);
    }
    return null;
  }

  /**
   * A walkable cell near `pos` that is at least `minRise` metres ABOVE it — a balcony,
   * a mezzanine, a roof. Returns `out` or null.
   *
   * This exists because "go upstairs" and "walk somewhere" are not the same query, and
   * treating them as one is why bots never used the vertical half of the map. Every
   * other destination picker resolves a point to the layer nearest the bot's own
   * height, so a bot standing in a hall asks for a spot 6 m away and is answered with
   * the floor it is already on — the mezzanine directly overhead is never a candidate.
   *
   * Deliberately LOCAL. Sending a bot to a roof across the map does not work: measured,
   * the walk takes ~20 s, and a patrol leg lasts 14-22 s before contact or the state
   * timer takes the bot off it, so the leg is abandoned on the stairs every time. A
   * rise found within a few metres is a leg the bot actually completes.
   *
   * Scored by travel cost, not by height: the nearest way up wins, so this reads as
   * "take those stairs" rather than "teleport to the highest thing in range". No
   * raycasts — it is called on a state transition and must stay cheap.
   */
  elevatedPointNear(pos, radius, minRise, out = _scratchPoint, rng = null) {
    if (!this.ready) return null;
    const cells = Math.max(1, Math.round(radius / CELL));
    const cx0 = Math.floor((pos.x - this.originX) / CELL);
    const cz0 = Math.floor((pos.z - this.originZ) / CELL);
    const cand = this._coverCand, score = this._coverScore;
    const capacity = cand.length;
    let nc = 0;

    for (let dz = -cells; dz <= cells; dz++) {
      const cz = cz0 + dz;
      if (cz < 0 || cz >= this.rows) continue;
      for (let dx = -cells; dx <= cells; dx++) {
        const cx = cx0 + dx;
        if (cx < 0 || cx >= this.cols) continue;
        if (dx * dx + dz * dz > cells * cells) continue;
        const col = cz * this.cols + cx;
        const n = this.layerCount[col];
        for (let l = 0; l < n; l++) {
          const node = col * MAX_LAYERS + l;
          if (!(this.flags[node] & F_WALKABLE)) continue;
          if (!this._linked(node) || !this.reachable[node]) continue;
          const rise = this.floorY[node] - pos.y;
          if (rise < minRise) continue;
          const wx = this.cellCenterX(col), wz = this.cellCenterZ(col);
          const s = Math.hypot(wx - pos.x, wz - pos.z) + rise * 0.8 + this.danger[node] * 3;
          if (nc < capacity) { cand[nc] = node; score[nc] = s; nc++; }
          else {
            let worst = 0;
            for (let i = 1; i < capacity; i++) if (score[i] > score[worst]) worst = i;
            if (s < score[worst]) { cand[worst] = node; score[worst] = s; }
          }
        }
      }
    }
    if (nc === 0) return null;

    let best = 0;
    for (let i = 1; i < nc; i++) if (score[i] < score[best]) best = i;
    if (rng && nc > 1) {
      // Second-best occasionally, so a squad does not stack onto one balcony corner.
      let second = -1;
      for (let i = 0; i < nc; i++) {
        if (i === best) continue;
        if (second < 0 || score[i] < score[second]) second = i;
      }
      if (second >= 0 && rng() < 0.35) best = second;
    }
    return this.nodeCenter(cand[best], out);
  }

  /**
   * Cells near `pos` that break line of sight to `threatPos` (pass the threat's
   * EYE position, not its feet).
   *
   * Fills `out` with Vector3 (reusing existing entries) and returns the count.
   * Ranked by distance to the bot, then closeness to the threat, then how far
   * the cell sits off the direct bot->threat axis (prefers a slight flank).
   *
   * A cell counts as cover if the standing sightline (floor + 1.6) is blocked —
   * hard cover — or if only the crouched line (floor + 0.95) is blocked, which
   * is low cover a bot can duck behind and peek over. Low cover is the more
   * useful kind in a firefight, so it is accepted and scored just below hard
   * cover rather than discarded.
   */
  coverPointsNear(pos, threatPos, radius, out, maxOut = 4) {
    if (!this.ready || !out) return 0;
    const world = this.world;
    const cells = Math.max(1, Math.round(radius / CELL));
    const cx0 = Math.floor((pos.x - this.originX) / CELL);
    const cz0 = Math.floor((pos.z - this.originZ) / CELL);
    const cand = this._coverCand, score = this._coverScore;
    const capacity = cand.length;
    let nc = 0;

    const axX = threatPos.x - pos.x, axZ = threatPos.z - pos.z;
    const axLen = Math.hypot(axX, axZ) || 1;
    const nax = axX / axLen, naz = axZ / axLen;

    for (let dz = -cells; dz <= cells; dz++) {
      const cz = cz0 + dz;
      if (cz < 0 || cz >= this.rows) continue;
      for (let dx = -cells; dx <= cells; dx++) {
        const cx = cx0 + dx;
        if (cx < 0 || cx >= this.cols) continue;
        if (dx * dx + dz * dz > cells * cells) continue;
        const col = cz * this.cols + cx;
        const n = this.layerCount[col];
        for (let l = 0; l < n; l++) {
          const node = col * MAX_LAYERS + l;
          if ((this.flags[node] & (F_WALKABLE | F_NEARCOVER)) !== (F_WALKABLE | F_NEARCOVER)) continue;
          if (Math.abs(this.floorY[node] - pos.y) > 2.2) continue;
          const wx = this.cellCenterX(col), wz = this.cellCenterZ(col);
          const dToBot = Math.hypot(wx - pos.x, wz - pos.z);
          const dToThreat = Math.hypot(wx - threatPos.x, wz - threatPos.z);
          if (dToThreat < 5.5) continue;             // don't hug cover in their face
          // Perpendicular offset from the bot->threat axis, rewarded a little.
          const relX = wx - pos.x, relZ = wz - pos.z;
          const perp = Math.abs(relX * naz - relZ * nax);
          const s = dToBot * 1.0 + dToThreat * 0.22 - Math.min(perp, 6) * 0.35
            + this.danger[node] * 4.0;

          if (nc < capacity) {
            cand[nc] = node; score[nc] = s; nc++;
          } else {
            // replace the worst
            let worst = 0;
            for (let i = 1; i < capacity; i++) if (score[i] > score[worst]) worst = i;
            if (s < score[worst]) { cand[worst] = node; score[worst] = s; }
          }
        }
      }
    }
    if (nc === 0) return 0;

    // Sort candidates ascending (insertion sort — nc <= 64, runs rarely).
    for (let i = 1; i < nc; i++) {
      const sv = score[i], cv = cand[i];
      let j = i - 1;
      while (j >= 0 && score[j] > sv) { score[j + 1] = score[j]; cand[j + 1] = cand[j]; j--; }
      score[j + 1] = sv; cand[j + 1] = cv;
    }

    // LOS-test the best few only; each test is a world raycast (<= 2 per cell).
    let found = 0;
    const tests = Math.min(nc, 16);
    const los = world && world.losClear ? world : null;
    _v2.copy(threatPos);
    for (let i = 0; i < tests && found < maxOut; i++) {
      const node = cand[i];
      this.nodeCenter(node, _v1);
      _v1.y += 1.6;
      if (los) {
        if (los.losClear(_v1, _v2)) {
          _v1.y -= 0.65;                       // crouched line
          if (los.losClear(_v1, _v2)) continue; // fully exposed either way
        }
      }
      const v = vecAt(out, found);
      this.nodeCenter(node, v);
      found++;
    }
    return found;
  }

  /**
   * A coarse lattice of walkable points spanning the whole map, used by the AI as its
   * patrol/sweep graph. Built once per match (never per frame).
   *
   * Two passes, and the second one is the whole reason bots use the upper half of a
   * map at all:
   *
   *   1. the ground lattice — every `spacing` metres, the LOWEST walkable, linked node
   *      in that column: the street rather than the roof. If the exact column is solid
   *      (inside a building wall) we spiral out a little rather than punching a hole in
   *      the coverage, which is what keeps the sweep from ignoring whole buildings.
   *   2. the layers ABOVE it, on a finer lattice.
   *
   * Pass 2 used not to exist, and the consequence was not subtle: on the shipping map
   * exactly 8 of 66 points of interest sat above y=1, all of them stairs and plinths
   * rather than floors, so the team board could not contain a rooftop and no bot ever
   * chose to go to one. Every stair, mezzanine and rampart in the level was dead to the
   * AI. A roof is a POSITION, not scenery, so it has to be on the board to be contested.
   *
   * The finer lattice for pass 2 is deliberate: upper floors and roofs cover a small
   * fraction of the map's footprint, so sampling them at the street's spacing lands one
   * point on a whole rooftop, or none. Filtering by `reachable` is what stops that
   * generosity turning into bots staring up at parapets they cannot climb.
   *
   * Fills `out` with Vector3 (reusing existing entries) and returns the count.
   */
  samplePoints(spacing, out, maxOut = 256) {
    if (!this.ready || !out) return 0;
    const step = Math.max(1, Math.round(spacing / CELL));
    const half = step >> 1;
    const slack = Math.max(1, half - 1);
    let n = 0;
    for (let cz = half; cz < this.rows && n < maxOut; cz += step) {
      for (let cx = half; cx < this.cols && n < maxOut; cx += step) {
        let node = this._groundNodeAt(cx, cz);
        for (let r = 1; node < 0 && r <= slack; r++) {
          for (let dz = -r; dz <= r && node < 0; dz++) {
            for (let dx = -r; dx <= r && node < 0; dx++) {
              if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
              const nx = cx + dx, nz = cz + dz;
              if (nx < 0 || nz < 0 || nx >= this.cols || nz >= this.rows) continue;
              node = this._groundNodeAt(nx, nz);
            }
          }
        }
        if (node < 0) continue;
        this.nodeCenter(node, vecAt(out, n));
        n++;
      }
    }

    // -- pass 2: everything above the ground layer.
    const ustep = Math.max(1, Math.round(step * 0.5));
    const uhalf = ustep >> 1;
    for (let cz = uhalf; cz < this.rows && n < maxOut; cz += ustep) {
      for (let cx = uhalf; cx < this.cols && n < maxOut; cx += ustep) {
        const col = cz * this.cols + cx;
        const lc = this.layerCount[col];
        let seenGround = false;
        for (let l = 0; l < lc && n < maxOut; l++) {
          const node = col * MAX_LAYERS + l;
          if (!(this.flags[node] & F_WALKABLE) || !this._linked(node)) continue;
          // The lowest linked layer is pass 1's business, and a column whose lowest
          // surface is already a roof (solid building underneath) got it from there.
          if (!seenGround) { seenGround = true; continue; }
          if (!this.reachable[node]) continue;
          this.nodeCenter(node, vecAt(out, n));
          n++;
        }
      }
    }
    if (out.length < n) out.length = n;
    return n;
  }

  /** Lowest walkable + linked + reachable node in a column, or -1. */
  _groundNodeAt(cx, cz) {
    const col = cz * this.cols + cx;
    const lc = this.layerCount[col];
    for (let l = 0; l < lc; l++) {
      const node = col * MAX_LAYERS + l;
      if (!(this.flags[node] & F_WALKABLE)) continue;
      if (!this._linked(node)) continue;
      // A column filled solid by a skyline block has exactly one walkable layer — its
      // 15 m roof — and nothing links it to the map. Emitting it as "the ground here"
      // put a point of interest on top of a building with no way up.
      if (!this.reachable[node]) continue;
      return node;
    }
    return -1;
  }

  /**
   * The inverse of coverPointsNear: the nearest walkable cell that CAN see
   * `targetEye`. This is the peek — a bot pinned behind a crate uses it to step
   * back into the angle instead of sitting there until the round ends.
   *
   * Returns `out` or null. Costs at most `maxTests` LOS probes, and is called
   * on a state transition, never per frame.
   */
  visiblePointNear(pos, targetEye, radius, out = _scratchPoint, maxTests = 10) {
    if (!this.ready) return null;
    const world = this.world;
    if (!world || !world.losClear) return null;
    const cells = Math.max(1, Math.round(radius / CELL));
    const cx0 = Math.floor((pos.x - this.originX) / CELL);
    const cz0 = Math.floor((pos.z - this.originZ) / CELL);
    const cand = this._coverCand, score = this._coverScore;
    const capacity = cand.length;
    let nc = 0;

    for (let dz = -cells; dz <= cells; dz++) {
      const cz = cz0 + dz;
      if (cz < 0 || cz >= this.rows) continue;
      for (let dx = -cells; dx <= cells; dx++) {
        const cx = cx0 + dx;
        if (cx < 0 || cx >= this.cols) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 > cells * cells || d2 === 0) continue;
        const col = cz * this.cols + cx;
        const n = this.layerCount[col];
        for (let l = 0; l < n; l++) {
          const node = col * MAX_LAYERS + l;
          if (!(this.flags[node] & F_WALKABLE)) continue;
          if (Math.abs(this.floorY[node] - pos.y) > 1.6) continue;
          const wx = this.cellCenterX(col), wz = this.cellCenterZ(col);
          // Cheap and close: a peek is a step out of cover, not a relocation.
          const s = Math.hypot(wx - pos.x, wz - pos.z) + this.danger[node] * 2.5;
          if (nc < capacity) { cand[nc] = node; score[nc] = s; nc++; }
          else {
            let worst = 0;
            for (let i = 1; i < capacity; i++) if (score[i] > score[worst]) worst = i;
            if (s < score[worst]) { cand[worst] = node; score[worst] = s; }
          }
        }
      }
    }
    if (nc === 0) return null;

    for (let i = 1; i < nc; i++) {
      const sv = score[i], cv = cand[i];
      let j = i - 1;
      while (j >= 0 && score[j] > sv) { score[j + 1] = score[j]; cand[j + 1] = cand[j]; j--; }
      score[j + 1] = sv; cand[j + 1] = cv;
    }

    const tests = Math.min(nc, maxTests);
    _v2.copy(targetEye);
    for (let i = 0; i < tests; i++) {
      this.nodeCenter(cand[i], _v1);
      _v1.y += 1.6;
      if (!world.losClear(_v1, _v2)) continue;
      return this.nodeCenter(cand[i], out);
    }
    return null;
  }

  /** Cover direction stored at a node (unit XZ pointing at the geometry). */
  coverDirAt(pos, out) {
    const node = this.nodeAt(pos.x, pos.y, pos.z);
    if (node < 0 || !(this.flags[node] & F_NEARCOVER)) return null;
    out.set(this.coverX[node], 0, this.coverZ[node]);
    return out;
  }

  /** Bump the danger scalar in a radius — decays via update(). */
  addDanger(pos, amount = 1, radius = 4) {
    if (!this.ready) return;
    const cells = Math.max(1, Math.round(radius / CELL));
    const cx0 = Math.floor((pos.x - this.originX) / CELL);
    const cz0 = Math.floor((pos.z - this.originZ) / CELL);
    for (let dz = -cells; dz <= cells; dz++) {
      const cz = cz0 + dz;
      if (cz < 0 || cz >= this.rows) continue;
      for (let dx = -cells; dx <= cells; dx++) {
        const cx = cx0 + dx;
        if (cx < 0 || cx >= this.cols) continue;
        const d2 = dx * dx + dz * dz;
        if (d2 > cells * cells) continue;
        const fall = 1 - Math.sqrt(d2) / cells;
        const col = cz * this.cols + cx;
        const n = this.layerCount[col];
        for (let l = 0; l < n; l++) {
          const node = col * MAX_LAYERS + l;
          if (Math.abs(this.floorY[node] - pos.y) > 3) continue;
          this.danger[node] = Math.min(6, this.danger[node] + amount * fall);
        }
      }
    }
  }

  dangerAt(pos) {
    const node = this.nodeAt(pos.x, pos.y, pos.z);
    return node < 0 ? 0 : this.danger[node];
  }

  // ---------------------------------------------------------------------- A*

  /**
   * Resolve one end of a search to a node.
   *
   * `nodeAt` answers with the best layer in the column, however far above the query
   * that layer is — which for a position with no floor of its own (inside a wall, in
   * a doorway recess, under a mezzanine) is the CEILING. Pathing from there put the
   * whole route on the roof: the foot of the market hall stair resolved to the roof
   * node 7.9 m up and the "bottom -> top" path went round the building at y = 8.05
   * instead of up 18 perfectly good treads. A cell one step sideways is a far better
   * answer than a surface a storey overhead, so past MAX_SNAP_ABOVE we hand over to
   * the ring search. Confined to path endpoints on purpose: `nodeAt`/`nearestWalkable`
   * are also how the AI picks DESTINATIONS, and tightening those changes which places
   * bots decide to go, which is not this function's business.
   */
  _endpoint(vec) {
    const node = this.nodeAt(vec.x, vec.y, vec.z);
    if (node >= 0 && this.floorY[node] - vec.y <= MAX_SNAP_ABOVE) return node;
    const p = this.nearestWalkable(vec, _v3, false, MAX_SNAP_ABOVE);
    if (!p) return node;
    const alt = this.nodeAt(p.x, p.y, p.z);
    return alt >= 0 ? alt : node;
  }

  /**
   * A* with an octile heuristic and a binary heap.
   * Fills `out` with waypoints (reusing existing Vector3s) and returns the
   * waypoint count. If the expansion budget is exhausted the best-so-far
   * partial path is returned, which is exactly what you want for a bot — it
   * starts moving in roughly the right direction and re-paths later.
   */
  findPath(fromVec3, toVec3, out) {
    if (!this.ready || !out) return 0;

    const startNode = this._endpoint(fromVec3);
    const goalNode = this._endpoint(toVec3);
    if (startNode < 0 || goalNode < 0) return 0;
    if (startNode === goalNode) {
      const v = vecAt(out, 0);
      this.nodeCenter(goalNode, v);
      if (out.length < 1) out.length = 1;
      return 1;
    }

    if (this._gen >= 0xfffffff0) { this._stamp.fill(0); this._gen = 0; }
    const gen = ++this._gen;
    const g = this._gScore, f = this._fScore, came = this._cameFrom;
    const stamp = this._stamp, state = this._state;
    const flags = this.flags, linkMask = this.linkMask, dropMask = this.dropMask;
    const linkLayer = this.linkLayer, floorY = this.floorY, danger = this.danger;
    const cols = this.cols, rows = this.rows;

    const gcol = (goalNode / MAX_LAYERS) | 0;
    const gx = gcol % cols, gz = (gcol / cols) | 0;
    const gy = floorY[goalNode];

    this._heapSize = 0;
    g[startNode] = 0;
    f[startNode] = this._heuristic(startNode, gx, gz, gy);
    came[startNode] = -1;
    stamp[startNode] = gen;
    state[startNode] = 1;
    this._heapPush(startNode);

    let expanded = 0;
    let bestNode = startNode;
    let bestH = f[startNode];
    let reached = false;
    const budget = Math.abs(floorY[startNode] - gy) > STEP_HEIGHT
      ? this.nodeBudgetMulti : this.nodeBudget;

    while (this._heapSize > 0 && expanded < budget) {
      const cur = this._heapPop();
      if (stamp[cur] !== gen || state[cur] === 2) continue;
      state[cur] = 2;
      expanded++;

      if (cur === goalNode) { reached = true; bestNode = cur; break; }

      const h = f[cur] - g[cur];
      if (h < bestH) { bestH = h; bestNode = cur; }

      const col = (cur / MAX_LAYERS) | 0;
      const cx = col % cols, cz = (col / cols) | 0;
      const cy = floorY[cur];

      // §3.5 hinted links, expanded exactly like grid neighbours so a mantle or an
      // out-of-band stair is a route the search can actually take.
      const extra = this.hintLinks.get(cur);
      if (extra !== undefined) {
        for (const e of extra) {
          const nnode = e.to;
          if (!(flags[nnode] & F_WALKABLE)) continue;
          if (stamp[nnode] === gen && state[nnode] === 2) continue;
          const tentative = g[cur] + e.cost + danger[nnode] * 1.35;
          if (stamp[nnode] !== gen) { stamp[nnode] = gen; state[nnode] = 0; g[nnode] = Infinity; }
          if (tentative >= g[nnode]) continue;
          g[nnode] = tentative;
          came[nnode] = cur;
          f[nnode] = tentative + this._heuristic(nnode, gx, gz, gy);
          state[nnode] = 1;
          this._heapPush(nnode);
        }
      }

      const mask = linkMask[cur];
      if (mask === 0) continue;

      for (let d = 0; d < 8; d++) {
        if (!(mask & (1 << d))) continue;
        const nx = cx + DX[d], nz = cz + DZ[d];
        if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
        const nnode = (nz * cols + nx) * MAX_LAYERS + linkLayer[cur * 8 + d];
        if (!(flags[nnode] & F_WALKABLE)) continue;
        if (stamp[nnode] === gen && state[nnode] === 2) continue;

        let step = d < 4 ? CELL : CELL * SQRT2;
        const dy = floorY[nnode] - cy;
        step += Math.abs(dy) * 0.9;
        if (dropMask[cur] & (1 << d)) step += 1.6;      // prefer stairs over jumping off
        step += danger[nnode] * 1.35;
        if (flags[nnode] & F_NEARCOVER) step -= 0.06;   // gentle hug-the-walls bias

        const tentative = g[cur] + step;
        if (stamp[nnode] !== gen) {
          stamp[nnode] = gen;
          state[nnode] = 0;
          g[nnode] = Infinity;
        }
        if (tentative >= g[nnode]) continue;
        g[nnode] = tentative;
        came[nnode] = cur;
        f[nnode] = tentative + this._heuristic(nnode, gx, gz, gy);
        state[nnode] = 1;
        this._heapPush(nnode);
      }
    }

    this.stats.searches++;
    this.stats.expansions += expanded;
    const endNode = reached ? goalNode : bestNode;
    if (!reached) this.stats.partials++;

    // -- reconstruct (reverse walk into scratch, then emit forwards)
    let count = 0;
    let node = endNode;
    while (node >= 0 && count < REV_CAP) {
      this._rev[count++] = node;
      if (node === startNode) break;
      node = came[node];
      if (stamp[node] !== gen) break;
    }
    if (count === 0) return 0;

    // path[0] is the start cell — kept so smoothPath() has a valid anchor. The
    // bot consumes it immediately because it is already standing on it.
    let emit = 0;
    for (let i = count - 1; i >= 0; i--) {
      const v = vecAt(out, emit);
      this.nodeCenter(this._rev[i], v);
      emit++;
    }
    if (out.length < emit) out.length = emit;
    return emit;
  }

  _heuristic(node, gx, gz, gy) {
    const col = (node / MAX_LAYERS) | 0;
    const cx = col % this.cols, cz = (col / this.cols) | 0;
    const dx = Math.abs(cx - gx), dz = Math.abs(cz - gz);
    const lo = dx < dz ? dx : dz;
    const hi = dx < dz ? dz : dx;
    return (hi + (SQRT2 - 1) * lo) * CELL + Math.abs(this.floorY[node] - gy) * 0.55;
  }

  _heapPush(node) {
    let i = this._heapSize;
    if (i >= HEAP_CAP) return;
    this._heapSize = i + 1;
    const heap = this._heap, f = this._fScore;
    heap[i] = node;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f[heap[p]] <= f[heap[i]]) break;
      const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
      i = p;
    }
  }

  _heapPop() {
    const heap = this._heap, f = this._fScore;
    const top = heap[0];
    const n = --this._heapSize;
    heap[0] = heap[n];
    let i = 0;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let m = i;
      if (l < n && f[heap[l]] < f[heap[m]]) m = l;
      if (r < n && f[heap[r]] < f[heap[m]]) m = r;
      if (m === i) break;
      const t = heap[m]; heap[m] = heap[i]; heap[i] = t;
      i = m;
    }
    return top;
  }

  /**
   * String-pulling. Removes waypoints that are redundant because the bot can
   * see straight past them. Two LOS probes per test (ankle-ish and chest) so a
   * waist-high crate can't be smoothed through. Compacts `path` in place and
   * returns the new length; the array is never shortened so its Vector3s stay
   * available for the next search.
   */
  smoothPath(path, len = path.length) {
    if (!this.ready || len <= 2) return len;
    const world = this.world;
    if (!world || !world.losClear) return len;

    // path[0] is the anchor (the cell the bot stands on) and always survives.
    let write = 1;
    let i = 0;
    const LOOKAHEAD = 10;
    while (i < len - 1) {
      let furthest = i + 1;
      const limit = Math.min(len - 1, i + LOOKAHEAD);
      for (let j = limit; j > i + 1; j--) {
        const a = path[i], b = path[j];
        // Never smooth across a level change — that is a stair or a drop.
        if (Math.abs(b.y - a.y) > STEP_HEIGHT) continue;
        _v1.set(a.x, a.y + 0.55, a.z);
        _v2.set(b.x, b.y + 0.55, b.z);
        if (!world.losClear(_v1, _v2)) continue;
        _v1.y = a.y + 1.45;
        _v2.y = b.y + 1.45;
        if (!world.losClear(_v1, _v2)) continue;
        furthest = j;
        break;
      }
      // In-place compaction is safe: `write` never runs ahead of `furthest`.
      if (write !== furthest) path[write].copy(path[furthest]);
      write++;
      i = furthest;
    }
    return write;
  }

  // ------------------------------------------------------------------- debug

  debugDraw(enabled) {
    this._debugOn = !!enabled;
    if (!this.ready) return;
    if (enabled && !this._debug) this._buildDebug();
    if (this._debug) {
      this._debug.points.visible = this._debugOn;
      this._debug.lines.visible = this._debugOn;
      if (this._debugOn) this._updateDebug();
    }
  }

  _buildDebug() {
    const scene = this.game.scene;
    if (!scene) { this._debugOn = false; return; }

    let count = 0;
    for (let i = 0; i < this.nodeCount; i++) if (this.flags[i] & F_WALKABLE) count++;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const linePos = [];
    let p = 0;
    for (let node = 0; node < this.nodeCount; node++) {
      if (!(this.flags[node] & F_WALKABLE)) continue;
      const c = (node / MAX_LAYERS) | 0;
      const x = this.cellCenterX(c), y = this.floorY[node] + 0.06, z = this.cellCenterZ(c);
      pos[p * 3] = x; pos[p * 3 + 1] = y; pos[p * 3 + 2] = z;
      const cover = (this.flags[node] & F_NEARCOVER) ? 1 : 0;
      col[p * 3] = cover ? 1 : 0.25;
      col[p * 3 + 1] = cover ? 0.65 : 0.95;
      col[p * 3 + 2] = cover ? 0.15 : 0.55;
      p++;
      if (cover && linePos.length < 60000) {
        linePos.push(x, y, z, x + this.coverX[node] * 0.4, y + 0.35, z + this.coverZ[node] * 0.4);
      }
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pg.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const points = new THREE.Points(pg, new THREE.PointsMaterial({
      size: 0.11, vertexColors: true, sizeAttenuation: true, depthTest: true,
    }));
    points.frustumCulled = false;
    points.renderOrder = 900;

    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(linePos, 3));
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0xff8844 }));
    lines.frustumCulled = false;

    scene.add(points);
    scene.add(lines);
    this._debug = { points, lines, colorAttr: pg.getAttribute('color') };
  }

  /** Tint debug points by live danger — cheap, only while the overlay is on. */
  _updateDebug() {
    const dbg = this._debug;
    if (!dbg) return;
    const attr = dbg.colorAttr;
    const arr = attr.array;
    let p = 0;
    for (let node = 0; node < this.nodeCount; node++) {
      if (!(this.flags[node] & F_WALKABLE)) continue;
      const dgr = Math.min(1, this.danger[node] * 0.4);
      const cover = (this.flags[node] & F_NEARCOVER) ? 1 : 0;
      arr[p * 3] = (cover ? 1 : 0.25) * (1 - dgr) + dgr;
      arr[p * 3 + 1] = (cover ? 0.65 : 0.95) * (1 - dgr);
      arr[p * 3 + 2] = (cover ? 0.15 : 0.55) * (1 - dgr);
      p++;
    }
    attr.needsUpdate = true;
  }
}

// Re-exported so AI code can share the constants without magic numbers.
export const NAV_CELL = CELL;
export const NAV_STEP_HEIGHT = STEP_HEIGHT;
export const NAV_STAND_CLEARANCE = STAND_CLEARANCE;
