import * as THREE from 'three';
import { buildLevel } from './level.js';

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

export class World {
  constructor(game) {
    this.game = game;

    /** @type {Array<{min:THREE.Vector3, max:THREE.Vector3, surface:string}>} */
    this.boxes = [];
    /** @type {Array<{position:THREE.Vector3, yaw:number, team:number}>} */
    this.spawnPoints = [];
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

  async init() {
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
    buildLevel(this.game, this);
    this.build();
    this._faceSpawnsIntoTheOpen();
    this.buildStats.buildMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
    this.buildStats.colliders = this.boxes.length;
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
    // Materials are owned by assets.js — only the debug-only line material is ours.
    if (_debugMat) { _debugMat.dispose(); _debugMat = null; }
    this._debugMesh = null;
    this._grid = null;
    this.boxes.length = 0;
    this.spawnPoints.length = 0;
  }
}

function clampInt(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
