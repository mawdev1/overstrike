import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { assets } from '../core/assets.js';

/**
 * props.js — level construction kit.
 *
 * Two halves:
 *
 *  1. `Builder` — the thing level.js actually talks to. It owns two batchers:
 *       • a STATIC batcher that buckets geometry by (material, shadow flags) and merges
 *         each bucket into one BufferGeometry at finish() time, so ~700 authored boxes
 *         collapse into ~20 draw calls;
 *       • an INSTANCE batcher that turns any prop placed more than once into an
 *         InstancedMesh (one per material part of the prop).
 *     Colliders are always registered individually on the World as AABBs.
 *
 *  2. `PROPS` — a table of prop *templates*. A template is authored once in local space
 *     (origin at its ground centre, facing -Z) as `{ parts:[{geo, mat, tint, cast,
 *     receive}], colliders:[{x0,y0,z0,x1,y1,z1,surface}] }`, then stamped anywhere with
 *     `builder.prop(name, x, y, z, yaw, opts)`. Per-instance colour gives colour
 *     variation for free (containers, barrels, awnings) without extra materials.
 *
 * ── UV policy ─────────────────────────────────────────────────────────────────────────
 * Textures tile at a constant `UV` repeats per metre (1 repeat / 2 m) — never stretched.
 * Static architecture uses WORLD-SPACE planar projection (`projectWorldUV`) so that
 * hundreds of differently-sized boxes can share one material and be merged while their
 * tiling still lines up across seams; props bake the same density into their local UVs.
 * Large single-mesh surfaces (the ground zones) instead use `assets.tiled(name, rx, ry)`
 * as the architecture contract prescribes, since a whole-mesh repeat is the natural
 * expression there.
 */

export const UV = 0.5;   // texture repeats per metre

// ────────────────────────────────────────────────────────────────────── uv helpers

/** Scale a BoxGeometry's 0..1 face UVs so each face tiles at `uv` repeats/metre. */
export function scaleBoxUV(geo, sx, sy, sz, uv = UV) {
  const a = geo.attributes.uv;
  // BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z — 4 verts each.
  const du = [sz, sz, sx, sx, sx, sx];
  const dv = [sy, sy, sz, sz, sy, sy];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      a.setXY(k, a.getX(k) * du[f] * uv, a.getY(k) * dv[f] * uv);
    }
  }
  a.needsUpdate = true;
  return geo;
}

/**
 * Planar world-space UV projection driven by each vertex's dominant normal axis.
 * Apply AFTER the geometry has been placed in world space.
 */
export function projectWorldUV(geo, uv = UV) {
  const p = geo.attributes.position, n = geo.attributes.normal, a = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); }
    else if (ax >= az) { u = p.getZ(i); v = p.getY(i); }
    else { u = p.getX(i); v = p.getY(i); }
    a.setXY(i, u * uv, v * uv);
  }
  a.needsUpdate = true;
  return geo;
}

/** Scale a cylinder's UVs to the same density (side wrap × height). */
export function scaleCylUV(geo, radius, h, uv = UV) {
  const a = geo.attributes.uv;
  const su = Math.max(0.25, 2 * Math.PI * radius * uv);
  const sv = Math.max(0.25, h * uv);
  for (let i = 0; i < a.count; i++) a.setXY(i, a.getX(i) * su, a.getY(i) * sv);
  a.needsUpdate = true;
  return geo;
}

// ────────────────────────────────────────────────────────────────── template builder

/**
 * Tiny local-space geometry accumulator used to author prop templates.
 * Everything it emits is indexed with (position, normal, uv) so it merges cleanly.
 */
/**
 * Build colliders without geometry (the headless server).
 *
 * The one rule, and it is not optional: the skip must happen at `addGeo` and NEVER any
 * higher up the call chain. Decoration code — `_stain`, `_shutters`, `debris` — draws
 * from the shared `game.rng` while producing nothing but appearance. Those functions
 * must still RUN, and still consume exactly the draws they always did; only the geometry
 * they hand to `addGeo` is discarded. Short-circuiting a caller instead would leave the
 * server's stream a different number of draws along than every client's, and the whole
 * map would then be built from different randomness — with no error and no test to catch
 * it beyond the collider hash in scripts/headless.mjs.
 */
/** Must match World's MAX_STEP_HEIGHT — a lip below this is a step, not a barrier. */
const MAX_STEP = 0.55;

let COLLIDERS_ONLY = false;
export function setCollidersOnly(v) { COLLIDERS_ONLY = !!v; }

function templateBuilder() {
  const parts = new Map();     // matName -> { mat, tint, cast, receive, geos: [] }
  const colliders = [];

  function bucket(matName, tint, cast, receive, plain) {
    const key = `${matName}|${tint || ''}|${cast ? 1 : 0}${receive ? 1 : 0}|${plain ? 1 : 0}`;
    let b = parts.get(key);
    if (!b) { b = { mat: matName, tint: tint || null, cast, receive, plain, geos: [] }; parts.set(key, b); }
    return b;
  }

  const api = {
    /**
     * Add a pre-transformed local-space geometry.
     * `o.plain` marks a part that ignores the per-instance colour, so a prop can be
     * tinted (an awning canopy, a painted shutter) while its ironmongery stays grey.
     */
    add(geo, matName, o = {}) {
      bucket(matName, o.tint, o.cast !== false, o.receive !== false, !!o.plain).geos.push(geo);
    },
    /** Box centred at (cx,cy,cz); optional local rotation applied before translation. */
    box(cx, cy, cz, sx, sy, sz, matName, o = {}) {
      const g = new THREE.BoxGeometry(sx, sy, sz);
      scaleBoxUV(g, sx, sy, sz, o.uv ?? UV);
      if (o.rz) g.rotateZ(o.rz);
      if (o.rx) g.rotateX(o.rx);
      if (o.ry) g.rotateY(o.ry);
      g.translate(cx, cy, cz);
      api.add(g, matName, o);
      return g;
    },
    /** Cylinder standing on Y, centred at (cx,cy,cz). */
    cyl(cx, cy, cz, rTop, rBot, h, seg, matName, o = {}) {
      const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, !!o.open);
      scaleCylUV(g, Math.max(rTop, rBot), h, o.uv ?? UV);
      if (o.rz) g.rotateZ(o.rz);
      if (o.rx) g.rotateX(o.rx);
      if (o.ry) g.rotateY(o.ry);
      g.translate(cx, cy, cz);
      api.add(g, matName, o);
      return g;
    },
    /** Local-space collider AABB. */
    col(x0, y0, z0, x1, y1, z1, surface) {
      colliders.push({ x0, y0, z0, x1, y1, z1, surface });
    },
    finish() {
      const out = [];
      // Colliders are pure numbers from `col()` and owe nothing to the geometry, so the
      // merge is skipped wholesale. The geometries themselves were still built — see the
      // note on COLLIDERS_ONLY: the factories that make them also draw RNG.
      if (COLLIDERS_ONLY) {
        for (const b of parts.values()) for (const g of b.geos) g.dispose();
        return { parts: out, colliders };
      }
      for (const b of parts.values()) {
        const geo = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
        if (!geo) continue;
        if (b.geos.length > 1) for (const g of b.geos) g.dispose();
        geo.computeBoundingSphere();
        out.push({ geo, mat: b.mat, tint: b.tint, cast: b.cast, receive: b.receive, plain: b.plain });
      }
      return { parts: out, colliders };
    },
  };
  return api;
}

// ─────────────────────────────────────────────────────────────────────── Builder

const _c = new THREE.Color();
const _c2 = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);

/**
 * Give `geo` a flat `color` attribute. Used to bake a prop's tint / per-instance colour
 * into geometry so it can join a static merge bucket instead of holding an InstancedMesh
 * open on its own. Values are linear-space, exactly like `InstancedMesh.setColorAt()`
 * writes them, and three multiplies both into `vColor` identically.
 */
function fillVertexColor(geo, color) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = color.r; arr[i * 3 + 1] = color.g; arr[i * 3 + 2] = color.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/**
 * `vertexColors` is a shader define, so a bucket carrying baked tints needs its own
 * material. Cached by base-material name — there are only ever a couple of these, and
 * the alternative (flipping the shared library material) would render every other user
 * of it black for want of a `color` attribute.
 *
 * `Material.copy()` does NOT carry `onBeforeCompile`, and assets.js hangs the shared
 * macro/aerial-perspective hook there, so it is reattached by hand. It is the same
 * function object as the base's, which keeps three's default `customProgramCacheKey()`
 * in agreement with the rest of the library.
 */
const _vcMats = new Map();
function vertexColorMat(name) {
  let m = _vcMats.get(name);
  if (m) return m;
  const base = assets.mat(name);
  m = base.clone();
  m.vertexColors = true;
  m.onBeforeCompile = base.onBeforeCompile;
  m.userData.macro = base.userData.macro;
  m.userData.surface = base.userData.surface || name;
  m.needsUpdate = true;
  _vcMats.set(name, m);
  return m;
}
const _m4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
const _xAxis = new THREE.Vector3(1, 0, 0);

/**
 * Painted-timber shutter palette. Faded Mediterranean blues, greens and ochres — the
 * cheapest possible way to make a plastered façade read as *lived in* rather than as an
 * untextured box, and the main carrier of per-lane colour identity.
 */
export const SHUTTER_COLORS = [0x4d7f96, 0x3f6b5a, 0x9a6b3f, 0x7d8c9e, 0x8a5347, 0x5c6f8a];

export class Builder {
  constructor(game, world) {
    this.game = game;
    this.world = world;
    this.group = world.group;
    this.rng = game.rng;

    this._static = new Map();      // key -> { mat, cast, receive, geos: [] }
    this._inst = new Map();        // key -> { geo, mat, cast, receive, items: [] }
    this._templates = new Map();   // per-build template cache
    this._singles = [];            // non-merged meshes (ground zones)
    this.stats = { meshes: 0, instanced: 0, triangles: 0, colliders: 0 };
  }

  // ── raw plumbing ────────────────────────────────────────────────────────────────

  /**
   * @param {boolean} [colored] true when `geo` carries a baked `color` attribute. The
   *   bucket then renders with a vertexColors variant of the material and every other
   *   geometry in it gets a white `color` attribute at merge time — mergeGeometries
   *   requires a matching attribute set across the whole bucket.
   */
  addGeo(geo, matName, cast = true, receive = true, colored = false) {
    // THE skip point. See COLLIDERS_ONLY above before moving this anywhere else.
    if (COLLIDERS_ONLY) { geo?.dispose?.(); return; }
    const key = `${matName}|${cast ? 1 : 0}${receive ? 1 : 0}`;
    let b = this._static.get(key);
    if (!b) { b = { mat: matName, cast, receive, colored: false, geos: [] }; this._static.set(key, b); }
    if (colored) b.colored = true;
    b.geos.push(geo);
  }

  collider(x0, y0, z0, x1, y1, z1, surface) {
    this.world.addBoxRaw(x0, y0, z0, x1, y1, z1, surface);
    this.stats.colliders++;
  }

  // ── architecture primitives ─────────────────────────────────────────────────────

  /**
   * The workhorse: an axis-aligned world-space box with a matching collider.
   * opts: { collide=true, cast=true, receive=true, uv=UV, visual=true }
   */
  box(x0, y0, z0, x1, y1, z1, matName, surface = 'concrete', opts = {}) {
    const sx = Math.abs(x1 - x0), sy = Math.abs(y1 - y0), sz = Math.abs(z1 - z0);
    if (sx < 1e-4 || sy < 1e-4 || sz < 1e-4) return;
    if (opts.visual !== false) {
      const g = new THREE.BoxGeometry(sx, sy, sz);
      g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      projectWorldUV(g, opts.uv ?? UV);
      this.addGeo(g, matName, opts.cast !== false, opts.receive !== false);
    }
    if (opts.collide !== false) this.collider(x0, y0, z0, x1, y1, z1, surface);
  }

  /** Visual only — no collider (trim, cornices, signage). */
  deco(x0, y0, z0, x1, y1, z1, matName, opts = {}) {
    this.box(x0, y0, z0, x1, y1, z1, matName, 'concrete', { ...opts, collide: false });
  }

  /**
   * Horizontal slab (floor / ceiling / roof deck) with an optional rectangular hole
   * (stairwell). The hole splits the slab into up to four rectangles.
   * hole: [hx0, hz0, hx1, hz1]
   */
  slab(x0, z0, x1, z1, y0, y1, matName, surface, opts = {}) {
    const h = opts.hole;
    if (!h) { this.box(x0, y0, z0, x1, y1, z1, matName, surface, opts); return; }
    const [hx0, hz0, hx1, hz1] = h;
    const cx0 = Math.max(x0, hx0), cx1 = Math.min(x1, hx1);
    const cz0 = Math.max(z0, hz0), cz1 = Math.min(z1, hz1);
    if (cx1 <= cx0 || cz1 <= cz0) { this.box(x0, y0, z0, x1, y1, z1, matName, surface, opts); return; }
    if (cz0 > z0) this.box(x0, y0, z0, x1, y1, cz0, matName, surface, opts);        // south of hole
    if (cz1 < z1) this.box(x0, y0, cz1, x1, y1, z1, matName, surface, opts);        // north of hole
    if (cx0 > x0) this.box(x0, y0, cz0, cx0, y1, cz1, matName, surface, opts);      // west strip
    if (cx1 < x1) this.box(cx1, y0, cz0, x1, y1, cz1, matName, surface, opts);      // east strip
  }

  /**
   * Tiled/screeded floor finish laid over a structural deck whose walking surface is at
   * `y` — the interior floor of a building, as opposed to the slab holding it up.
   *
   * The finish sits 8 mm proud, and that lift is the whole point. Laid flush, its top
   * face is *exactly* coplanar with the deck top it covers, and two opaque faces in one
   * plane z-fight: every tiled interior in the map strobed as the camera moved. With
   * near 0.10 / far 400 and a 24-bit depth buffer the resolvable gap at 60 m is about
   * 2 mm, so 8 mm clears the whole 86 m map with room to spare while staying half the
   * lift `wear()` already gets away with underfoot.
   *
   * Visual only: the deck below keeps the collider, so the lift never moves the surface
   * the player actually stands on.
   */
  floorFinish(x0, z0, x1, z1, y, matName, opts = {}) {
    this.box(x0, y - 0.02, z0, x1, y + 0.008, z1, matName, 'concrete',
      { ...opts, cast: false, collide: false });
  }

  /**
   * Big flat ground zone. One mesh, one `assets.tiled()` material, receive-only shadows,
   * plus a 1 m-thick collider slab beneath it carrying the correct impact surface.
   */
  groundPlane(x0, z0, x1, z1, y, matName, surface, opts = {}) {
    const w = x1 - x0, d = z1 - z0;
    // The only primitive that builds a mesh without going through addGeo, and the one
    // that actually throws headlessly: `assets.tiled` clones a material that was never
    // generated. It draws no RNG, so short-circuiting to the collider is safe here.
    if (COLLIDERS_ONLY) {
      if (opts.collide !== false) this.collider(x0, y - 1, z0, x1, y, z1, surface);
      return;
    }
    const g = new THREE.PlaneGeometry(w, d, 1, 1);
    g.rotateX(-Math.PI / 2);
    g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
    const mat = assets.tiled(matName, w * UV, d * UV);
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    this._singles.push(mesh);
    if (opts.collide !== false) this.collider(x0, y - 1, z0, x1, y, z1, surface);
  }

  /**
   * Wall run with openings. The footprint rect (x0,z0)-(x1,z1) is the actual wall
   * volume; the long horizontal axis is the "run" axis.
   * openings: [{ a0, a1, y0, y1, glass, frame:'door'|'window'|null }] in world coords
   * along the run axis.
   */
  wall(x0, z0, x1, z1, y0, y1, matName, surface = 'concrete', opts = {}) {
    const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
    const a0 = alongX ? x0 : z0;
    const a1 = alongX ? x1 : z1;
    const b0 = alongX ? z0 : x0;
    const b1 = alongX ? z1 : x1;
    const emit = (ea0, ea1, ey0, ey1, mat = matName, surf = surface, o = opts) => {
      if (ea1 - ea0 < 1e-3 || ey1 - ey0 < 1e-3) return;
      if (alongX) this.box(ea0, ey0, b0, ea1, ey1, b1, mat, surf, o);
      else this.box(b0, ey0, ea0, b1, ey1, ea1, mat, surf, o);
    };

    const ops = (opts.openings || []).slice().sort((p, q) => p.a0 - q.a0);
    let cursor = a0;
    for (const op of ops) {
      const oa0 = Math.max(a0, op.a0), oa1 = Math.min(a1, op.a1);
      if (oa1 <= oa0) continue;
      const oy0 = Math.max(y0, op.y0 ?? y0), oy1 = Math.min(y1, op.y1 ?? y1);
      // The opening's height range may not intersect this band at all — walls are built
      // in courses, and a window at 4.6-6.3 m simply does not cut the 0.15-1.3 m base
      // course. Skipping without advancing `cursor` leaves the span to be emitted as
      // solid wall by the next `emit`, which is what a course below a window should be.
      //
      // Unhandled, this was a shoot-through generator. `oy0`/`oy1` are clamped
      // independently, so a non-intersecting opening inverts them (oy0 = 4.6 > oy1 = 1.3)
      // and then: the sill `emit(oa0, oa1, y0, oy0)` builds a box 3.3 m TALLER than its
      // own band, and `_glassPane` receives an inverted range that `addBoxRaw` silently
      // normalises into a real pane — entombed inside the oversized sill. Four such panes
      // existed, three in the warehouse, and each turned its patch of 0.40 m concrete
      // into a free window for every rifle on the map.
      if (oy1 <= oy0) continue;
      if (oa0 > cursor) emit(cursor, oa0, y0, y1);
      if (oy0 > y0) emit(oa0, oa1, y0, oy0);          // sill
      if (oy1 < y1) emit(oa0, oa1, oy1, y1);          // lintel
      if (op.glass) this._glassPane(alongX, oa0, oa1, oy0, oy1, b0, b1);
      if (op.frame) this._openingFrame(alongX, oa0, oa1, oy0, oy1, b0, b1, op.frame, op);
      if (op.shutter) this._shutters(alongX, oa0, oa1, oy0, oy1, b0, b1, op.shutter, op.shutterColors, op.shutterW);
      if (op.stain) this._stain(alongX, oa0, oa1, oy0, b0, b1, op.stain);
      cursor = Math.max(cursor, oa1);
    }
    if (cursor < a1) emit(cursor, a1, y0, y1);
  }

  _glassPane(alongX, a0, a1, y0, y1, b0, b1) {
    const bc = (b0 + b1) / 2, t = 0.05;
    const opt = { cast: false, receive: false, collide: true };
    // The pane FILLS its opening, and laps 1 cm into the wall on every side.
    //
    // It used to be inset 0.06 m at the jambs and 0.05 m at head and sill inside a hole
    // that goes all the way through, which left an open slot around all four edges of
    // every glazed opening on the map — 32 panes, 257 m of open perimeter, about 10 m2 of
    // aperture. Every one of them leaked sightline, shot and sound straight past the glass,
    // which is the one thing a window is supposed to stop. The lap is hidden inside the
    // wall and behind the reveal trim, which is `deco` and does not collide, so nothing
    // here can z-fight.
    const L = 0.01;
    if (alongX) this.box(a0 - L, y0 - L, bc - t / 2, a1 + L, y1 + L, bc + t / 2, 'glass', 'glass', opt);
    else this.box(bc - t / 2, y0 - L, a0 - L, bc + t / 2, y1 + L, a1 + L, 'glass', 'glass', opt);
  }

  /**
   * Reveal trim around a door/window opening. Visual only — it hides the wall's guts and,
   * more importantly, gives the façade a shadow line: jamb + head, then a stone lintel
   * over the head and a projecting cill under every window. That projection is what stops
   * a plastered box reading as a flat card at 40 m.
   */
  _openingFrame(alongX, a0, a1, y0, y1, b0, b1, kind, op = {}) {
    const mat = kind === 'door' ? 'wood' : 'metal';
    const t = 0.08;
    const put = (ea0, ea1, ey0, ey1, m = mat, e = 0.05) => {
      if (alongX) this.deco(ea0, ey0, b0 - e, ea1, ey1, b1 + e, m, { cast: false });
      else this.deco(b0 - e, ey0, ea0, b1 + e, ey1, ea1, m, { cast: false });
    };
    put(a0, a0 + t, y0, y1);
    put(a1 - t, a1, y0, y1);
    put(a0, a1, y1 - t, y1);
    if (kind === 'window') put(a0, a1, y0, y0 + t);
    if (op.trim === false) return;
    const stone = op.trimMat || 'concreteDark';
    put(a0 - 0.17, a1 + 0.17, y1 + 0.01, y1 + 0.17, stone, 0.12);       // lintel
    if (kind === 'window') put(a0 - 0.15, a1 + 0.15, y0 - 0.12, y0 + 0.01, stone, 0.17);  // cill
  }

  /**
   * Rain-wash staining below a cill: one broad wash plus a few narrow runoff streaks,
   * a centimetre proud of the render. Dirt under windows is the single cheapest cue that
   * a building has stood in weather, and it breaks up big blank façades for free — these
   * merge into the existing concreteDark bucket.
   */
  _stain(alongX, a0, a1, y0, b0, b1, amount) {
    const w = a1 - a0;
    if (w < 0.4 || y0 < 0.8) return;
    const k = typeof amount === 'number' ? amount : 1;
    const e = 0.02;
    const put = (ea0, ea1, ey0, ey1) => {
      if (alongX) this.deco(ea0, ey0, b0 - e, ea1, ey1, b1 + e, 'concreteDark', { cast: false });
      else this.deco(b0 - e, ey0, ea0, b1 + e, ey1, ea1, 'concreteDark', { cast: false });
    };
    const drop = Math.min(y0 - 0.15, this.rng.range(0.5, 0.95) * k);
    put(a0 - 0.1, a1 + 0.1, y0 - drop * 0.42, y0 - 0.04);
    const n = 2 + this.rng.int(3);
    for (let i = 0; i < n; i++) {
      const cx = a0 + this.rng.range(0.05, w - 0.05);
      const sw = this.rng.range(0.06, 0.2);
      put(cx - sw / 2, cx + sw / 2, y0 - drop * this.rng.range(0.75, 1.25), y0 - 0.04);
    }
  }

  /**
   * Painted timber shutter leaves folded flat against the wall either side of a window.
   * `side` is +1 for the larger-b face, −1 for the smaller. Non-colliding by design:
   * nothing that hangs off a wall may ever catch a player.
   */
  _shutters(alongX, a0, a1, y0, y1, b0, b1, side, colors, maxW) {
    // Leaves fold flat against the wall BESIDE the reveal, so the caller has to cap the
    // width wherever a door or another window is close enough to be fouled.
    const lw = Math.min(maxW ?? 0.98, (a1 - a0) / 2);
    const h = Math.min(1.9, y1 - y0 - 0.02);
    if (lw < 0.25 || h < 0.5) return;
    const s = lw / 0.62;
    const sy = h / (1.3 * s);
    const bo = side > 0 ? Math.max(b0, b1) + 0.05 : Math.min(b0, b1) - 0.05;
    const yaw = (alongX ? 0 : Math.PI / 2) + (side > 0 ? 0 : Math.PI);
    const pal = colors && colors.length ? colors : SHUTTER_COLORS;
    // Both leaves of one window share a colour — a pair of mismatched shutters reads as
    // an authoring bug, not as character.
    const col = this.rng.pick(pal);
    for (const sgn of [-1, 1]) {
      const a = sgn < 0 ? a0 - lw / 2 - 0.06 : a1 + lw / 2 + 0.06;
      const o = { scale: s, scaleY: sy, color: col, collide: false };
      if (alongX) this.prop('shutter', a, y0 + 0.01, bo, yaw, o);
      else this.prop('shutter', bo, y0 + 0.01, a, yaw, o);
    }
  }

  // ── free-form static detail ─────────────────────────────────────────────────────
  //
  // Everything below emits into the SAME merge buckets as box()/deco(), so cabling,
  // aerials, pipe runs and rooftop tanks cost triangles but no extra draw call.

  /**
   * Static box of arbitrary orientation spanning two points — cables, guy wires, aerials,
   * pipe runs, diagonal bracing, leaning debris. Never collides: a wire you can snag on
   * is a bug, and every caller of this is decoration.
   */
  beam(x0, y0, z0, x1, y1, z1, t = 0.06, matName = 'metal', opts = {}) {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-3) return;
    const g = new THREE.BoxGeometry(len, t, opts.t2 ?? t);
    _dir.set(dx / len, dy / len, dz / len);
    _quat.setFromUnitVectors(_xAxis, _dir);
    g.applyQuaternion(_quat);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    projectWorldUV(g, opts.uv ?? UV);
    this.addGeo(g, matName, opts.cast !== false, opts.receive !== false);
  }

  /** Sagging catenary run of `segs` beams — power lines, washing lines, mooring rope. */
  cable(x0, y0, z0, x1, y1, z1, sag = 0.5, t = 0.045, matName = 'metal', opts = {}) {
    const segs = opts.segs ?? 5;
    let px = x0, py = y0, pz = z0;
    for (let i = 1; i <= segs; i++) {
      const f = i / segs;
      const cx = x0 + (x1 - x0) * f;
      const cz = z0 + (z1 - z0) * f;
      const cy = y0 + (y1 - y0) * f - sag * 4 * f * (1 - f);
      this.beam(px, py, pz, cx, cy, cz, t, matName, opts);
      px = cx; py = cy; pz = cz;
    }
  }

  /**
   * Static cylinder — water tanks, chimney pots, pipe stacks, silos.
   * `y` is the BASE unless a rotation is given, in which case it is the centre.
   */
  cylinder(x, y, z, r, h, seg, matName, surface = 'metal', opts = {}) {
    const g = new THREE.CylinderGeometry(opts.rTop ?? r, r, h, seg, 1, !!opts.open);
    scaleCylUV(g, r, h, opts.uv ?? UV);
    const rot = opts.rx || opts.rz;
    if (opts.rx) g.rotateX(opts.rx);
    if (opts.rz) g.rotateZ(opts.rz);
    g.translate(x, rot ? y : y + h / 2, z);
    this.addGeo(g, matName, opts.cast !== false, opts.receive !== false);
    if (opts.collide) this.collider(x - r, y, z - r, x + r, y + h, z + r, surface);
  }

  /**
   * Straight staircase. `dir` is the direction of ascent: '+x' | '-x' | '+z' | '-z'.
   * Emits one collider per tread (each ≤ 0.55 so World.move()'s step-up walks it) plus
   * side stringers.
   */
  stairs(opts) {
    const { x0, z0, x1, z1, y0, y1, dir, matName = 'concrete', surface = 'concrete' } = opts;
    const alongX = dir === '+x' || dir === '-x';
    const runLen = alongX ? (x1 - x0) : (z1 - z0);
    const width = alongX ? (z1 - z0) : (x1 - x0);
    const rise = y1 - y0;
    const steps = opts.steps || Math.max(2, Math.round(rise / 0.22));
    const riser = rise / steps;
    const tread = runLen / steps;
    const asc = dir === '+x' || dir === '+z';

    for (let i = 0; i < steps; i++) {
      const t0 = asc ? i * tread : runLen - (i + 1) * tread;
      const top = y0 + (i + 1) * riser;
      if (alongX) this.box(x0 + t0, y0 - 0.2, z0, x0 + t0 + tread, top, z1, matName, surface);
      else this.box(x0, y0 - 0.2, z0 + t0, x1, top, z0 + t0 + tread, matName, surface);
    }
    // Stringers: a solid skirt each side so you never see the step ends floating.
    if (opts.stringer !== false) {
      const st = 0.16;
      if (alongX) {
        this.deco(x0, y0 - 0.25, z0 - st, x1, y1, z0, matName, { cast: true });
        this.deco(x0, y0 - 0.25, z1, x1, y1, z1 + st, matName, { cast: true });
      } else {
        this.deco(x0 - st, y0 - 0.25, z0, x0, y1, z1, matName, { cast: true });
        this.deco(x1, y0 - 0.25, z0, x1 + st, y1, z1, matName, { cast: true });
      }
    }
    if (opts.rail) {
      if (alongX) {
        this.railingSloped(x0, z0 - 0.1, x1, z0 - 0.1, y0, y1, asc);
        this.railingSloped(x0, z1 + 0.1, x1, z1 + 0.1, y0, y1, asc);
      } else {
        this.railingSloped(x0 - 0.1, z0, x0 - 0.1, z1, y0, y1, asc);
        this.railingSloped(x1 + 0.1, z0, x1 + 0.1, z1, y0, y1, asc);
      }
    }
    return { riser, tread, steps, width };
  }

  /**
   * Visual ramp (a genuine slope) with a hidden stepped collider underneath, so the
   * player walks a smooth incline without the engine needing slope support.
   */
  ramp(opts) {
    const { x0, z0, x1, z1, y0, y1, dir, matName = 'concrete', surface = 'concrete' } = opts;
    const alongX = dir === '+x' || dir === '-x';
    const runLen = alongX ? (x1 - x0) : (z1 - z0);
    const rise = y1 - y0;
    const asc = dir === '+x' || dir === '+z';
    const steps = Math.max(4, Math.round(rise / 0.17));
    const riser = rise / steps, tread = runLen / steps;

    // Collider-only stepped core.
    for (let i = 0; i < steps; i++) {
      const t0 = asc ? i * tread : runLen - (i + 1) * tread;
      const top = y0 + (i + 1) * riser;
      if (alongX) this.collider(x0 + t0, y0 - 0.3, z0, x0 + t0 + tread, top, z1, surface);
      else this.collider(x0, y0 - 0.3, z0 + t0, x1, top, z0 + t0 + tread, surface);
    }
    // Visual wedge.
    const w = alongX ? (z1 - z0) : (x1 - x0);
    const len = Math.hypot(runLen, rise);
    const ang = Math.atan2(rise, runLen);
    const g = new THREE.BoxGeometry(alongX ? len : w, 0.3, alongX ? w : len);
    if (alongX) g.rotateZ(asc ? ang : -ang);
    else g.rotateX(asc ? -ang : ang);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2 - 0.1, (z0 + z1) / 2);
    projectWorldUV(g, UV);
    this.addGeo(g, matName, true, true);
    // Side cheeks.
    if (alongX) {
      this.deco(x0, y0 - 0.4, z0 - 0.14, x1, y0 + rise * 0.5, z0, matName);
      this.deco(x0, y0 - 0.4, z1, x1, y0 + rise * 0.5, z1 + 0.14, matName);
    } else {
      this.deco(x0 - 0.14, y0 - 0.4, z0, x0, y0 + rise * 0.5, z1, matName);
      this.deco(x1, y0 - 0.4, z0, x1 + 0.14, y0 + rise * 0.5, z1, matName);
    }
  }

  /**
   * Solid low parapet with a coping cap — rooftops and balconies.
   * `gaps` are [a0,a1] cut-outs along the run that drop the wall to `gapY` (crenellations
   * that give a sightline without giving total safety).
   */
  parapet(x0, z0, x1, z1, y, h, matName = 'concrete', surface = 'concrete', opts = {}) {
    const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
    const t = opts.thickness ?? 0.26;
    const bx0 = alongX ? x0 : x0 - t / 2, bx1 = alongX ? x1 : x0 + t / 2;
    const bz0 = alongX ? z0 - t / 2 : z0, bz1 = alongX ? z0 + t / 2 : z1;
    // Along-Z runs are extended half a thickness at each end so corners CLOSE.
    //
    // An along-X run covers x from x0 to x1 with its thickness centred on z0; an along-Z run
    // covers z from z0 to z1 centred on x0. Where the two meet, the quadrant
    // [x1, x1 + t/2] x [z0 - t/2, z0] belongs to neither, leaving a 0.13 x 0.13 m hole
    // through the parapet for its full height. Enumerated across the map: 25 such corners,
    // including all four on the market hall roof deck — see-through and shoot-through at
    // ankle-to-chest height on a roof edge, with the coping cap above making it look closed.
    // Extending one axis is enough to cover the square, and avoids double-overhang.
    // ...but only where the end actually meets something. `extendStart`/`extendEnd: false`
    // opts out per end: extending an end that is a deliberate OPENING closes 0.13 m of it,
    // and the warehouse roof's east parapet was split precisely to leave a stair mouth
    // there — the extension took 16% off the width the split existed to create.
    const ext = alongX ? 0 : t / 2;
    const ext0 = opts.extendStart === false ? 0 : ext;
    const ext1 = opts.extendEnd === false ? 0 : ext;
    const ax0 = (alongX ? x0 : z0) - ext0, ax1 = (alongX ? x1 : z1) + ext1;
    const gaps = (opts.gaps || []).slice().sort((p, q) => p[0] - q[0]);
    // A crenellation must be a firing slit, not a doorway.
    //
    // `h * 0.42` is 0.44 m on a 1.05 m parapet, and `World`'s MAX_STEP_HEIGHT is 0.55 —
    // so every crenel on the map was something a player walks straight over while holding
    // forward. Seven of the market hall's eight gaps, the warehouse roof's north gap and
    // the north balcony were all 8 m falls waiting for someone to strafe into them. Some
    // had sandbags in front, which is what had been holding them: those colliders clear
    // the step by 2 cm.
    //
    // 0.62 m clears the step with margin and still reads as a crenel from either side.
    const gapY = opts.gapY ?? Math.max(y + h * 0.42, y + MAX_STEP + 0.07);

    const seg = (a0, a1, top) => {
      if (a1 - a0 < 1e-3) return;
      if (alongX) this.box(a0, y, bz0, a1, top, bz1, matName, surface);
      else this.box(bx0, y, a0, bx1, top, a1, matName, surface);
    };
    let cur = ax0;
    for (const [g0, g1] of gaps) {
      const c0 = Math.max(ax0, g0), c1 = Math.min(ax1, g1);
      if (c1 <= c0) continue;
      seg(cur, c0, y + h);
      seg(c0, c1, gapY);
      cur = c1;
    }
    seg(cur, ax1, y + h);

    // Coping cap, slightly proud — reads as stone, and catches the sun.
    if (opts.cap !== false) {
      const ct = t + 0.12;
      if (alongX) this.deco(x0 - 0.06, y + h, z0 - ct / 2, x1 + 0.06, y + h + 0.09, z0 + ct / 2, opts.capMat || 'concreteDark');
      else this.deco(x0 - ct / 2, y + h, z0 - 0.06, x0 + ct / 2, y + h + 0.09, z1 + 0.06, opts.capMat || 'concreteDark');
    }
  }

  /** Metal railing run: instanced posts + merged top/mid rails + one thin collider. */
  railing(x0, z0, x1, z1, y, opts = {}) {
    const h = opts.height ?? 1.05;
    const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
    const len = alongX ? (x1 - x0) : (z1 - z0);
    if (len < 0.4) return;
    const n = Math.max(2, Math.round(len / 1.6));
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const px = alongX ? x0 + len * f : x0;
      const pz = alongX ? z0 : z0 + len * f;
      this.prop('railPost', px, y, pz, 0, { scaleY: h / 1.05 });
    }
    const t = 0.05;
    for (const ry of [y + h - 0.05, y + h * 0.52]) {
      if (alongX) this.deco(x0, ry - t, z0 - t, x1, ry + t, z0 + t, 'metal', { cast: false });
      else this.deco(x0 - t, ry - t, z0, x0 + t, ry + t, z1, 'metal', { cast: false });
    }
    if (opts.collide !== false) {
      if (alongX) this.collider(x0, y, z0 - 0.09, x1, y + h, z0 + 0.09, 'metal');
      else this.collider(x0 - 0.09, y, z0, x0 + 0.09, y + h, z1, 'metal');
    }
  }

  /** Railing that follows a stair pitch. Visual only (the stair blocks the body). */
  railingSloped(x0, z0, x1, z1, y0, y1, asc) {
    const alongX = Math.abs(x1 - x0) >= Math.abs(z1 - z0);
    const runLen = alongX ? (x1 - x0) : (z1 - z0);
    const n = Math.max(2, Math.round(runLen / 1.5));
    for (let i = 0; i <= n; i++) {
      const f = i / n;
      const yy = y0 + (y1 - y0) * (asc ? f : 1 - f);
      const px = alongX ? x0 + runLen * f : x0;
      const pz = alongX ? z0 : z0 + runLen * f;
      this.prop('railPost', px, yy, pz, 0, {});
    }
    const len = Math.hypot(runLen, y1 - y0);
    const ang = Math.atan2(y1 - y0, runLen) * (asc ? 1 : -1);
    const g = new THREE.BoxGeometry(alongX ? len : 0.07, 0.07, alongX ? 0.07 : len);
    if (alongX) g.rotateZ(ang); else g.rotateX(-ang);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2 + 1.0, (z0 + z1) / 2);
    projectWorldUV(g, UV);
    this.addGeo(g, 'metal', false, false);
  }

  /**
   * Thin ground overlay 1.5 cm proud — the worn dirt track through a gateway, an oil
   * stain under a truck, a spill on the quay. Reads as ground wear, never trips anyone.
   */
  wear(x0, z0, x1, z1, y = 0, matName = 'dirt') {
    this.deco(x0, y + 0.005, z0, x1, y + 0.02, z1, matName, { cast: false, receive: true });
  }

  /**
   * Loose rubble and rubbish scattered in a disc. Every piece is a tumbled beam, so a
   * pile reads as spill rather than as a row of dice. Visual only — nothing here is
   * tall enough to matter as cover and nothing may catch a player's feet.
   */
  debris(cx, cz, radius, count, y = 0, opts = {}) {
    const mats = opts.mats || ['concreteDark', 'wood', 'rubber'];
    const sc = opts.scale ?? 1;
    for (let i = 0; i < count; i++) {
      const a = this.rng.range(0, Math.PI * 2);
      const d = radius * Math.sqrt(this.rng());
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      const l = this.rng.range(0.14, 0.42) * sc;
      const th = this.rng.range(0.05, 0.16) * sc;
      const dir = this.rng.range(0, Math.PI * 2);
      const tilt = this.rng.range(-0.28, 0.28);
      this.beam(
        x - Math.cos(dir) * l / 2, y + th / 2 - Math.sin(tilt) * l / 2, z - Math.sin(dir) * l / 2,
        x + Math.cos(dir) * l / 2, y + th / 2 + Math.sin(tilt) * l / 2, z + Math.sin(dir) * l / 2,
        th, this.rng.pick(mats), { t2: th * this.rng.range(0.8, 2.2) },
      );
    }
  }

  /** Freestanding door frame with an ajar leaf — dresses a wall opening. */
  doorFrame(x, y, z, yaw, width = 1.2, height = 2.2, opts = {}) {
    this.prop('doorFrame', x, y, z, yaw, { variant: `${width.toFixed(2)}x${height.toFixed(2)}`, ...opts });
  }

  // ── props ───────────────────────────────────────────────────────────────────────

  /**
   * Stamp a prop template. Repeated names automatically become InstancedMeshes.
   * opts: { scale, scaleY, color (hex), variant, collide }
   */
  prop(name, x, y, z, yaw = 0, opts = {}) {
    const factory = PROPS[name];
    if (!factory) { console.warn(`[props] unknown prop "${name}"`); return; }
    const vkey = `${name}|${opts.variant || ''}`;
    let tpl = this._templates.get(vkey);
    if (!tpl) { tpl = factory(opts.variant); tpl.key = vkey; this._templates.set(vkey, tpl); }

    const s = opts.scale ?? 1;
    const sy = (opts.scaleY ?? 1) * s;
    for (let i = 0; i < tpl.parts.length; i++) {
      const part = tpl.parts[i];
      const key = `${vkey}#${i}`;
      let b = this._inst.get(key);
      if (!b) {
        b = { key, geo: part.geo, mat: part.mat, tint: part.tint, cast: part.cast, receive: part.receive, items: [] };
        this._inst.set(key, b);
      }
      b.items.push(x, y, z, yaw, s, sy, (part.plain || opts.color == null) ? -1 : opts.color);
    }
    if (opts.collide === false) return;
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    for (const c of tpl.colliders) {
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (let k = 0; k < 4; k++) {
        const lx = (k & 1) ? c.x1 : c.x0;
        const lz = (k & 2) ? c.z1 : c.z0;
        const wx = (lx * cos + lz * sin) * s;
        const wz = (-lx * sin + lz * cos) * s;
        if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
        if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
      }
      this.collider(x + minX, y + c.y0 * sy, z + minZ, x + maxX, y + c.y1 * sy, z + maxZ, c.surface);
    }
  }

  // ── output ──────────────────────────────────────────────────────────────────────

  /**
   * An InstancedMesh that holds one or two copies is a whole draw call (plus a second
   * one in the shadow pass) spent on a handful of triangles. Bake those few copies into
   * the matching static merge bucket instead — the result is pixel-identical and free.
   *
   * Tint used to disqualify a bucket, because the only place a per-instance colour could
   * live was `instanceColor`. That excluded genuinely silly cases: `crane|#3` is ONE
   * instance of TWELVE triangles holding a whole draw call plus its shadow twin purely
   * because it is painted yellow. So the tint is now baked into a vertex-colour
   * attribute instead — `instanceColor` and `color` multiply into `vColor` by exactly
   * the same shader path, so the pixels are identical either way.
   */
  _foldSingletons(maxCount = 3, maxTris = 3200) {
    for (const [key, b] of this._inst) {
      const n = b.items.length / 7;
      if (n === 0) { this._inst.delete(key); continue; }
      if (n > maxCount) continue;
      const tris = (b.geo.index ? b.geo.index.count : b.geo.attributes.position.count) / 3;
      if (tris * n > maxTris) continue;
      for (let i = 0; i < n; i++) {
        const o = i * 7;
        _pos.set(b.items[o], b.items[o + 1], b.items[o + 2]);
        _quat.setFromAxisAngle(_up, b.items[o + 3]);
        _scl.set(b.items[o + 4], b.items[o + 5], b.items[o + 4]);
        _m4.compose(_pos, _quat, _scl);
        const g = b.geo.clone().applyMatrix4(_m4);
        const col = b.items[o + 6];
        const colored = col >= 0 || !!b.tint;
        if (colored) {
          // Same product finish() would have handed setColorAt().
          _c.setHex(col >= 0 ? col : 0xffffff);
          if (b.tint) { _c2.setHex(b.tint); _c.multiply(_c2); }
          fillVertexColor(g, _c);
        }
        this.addGeo(g, b.mat, b.cast, b.receive, colored);
      }
      this._inst.delete(key);
    }
  }

  /** Merge every static bucket, build every InstancedMesh, attach to the world group. */
  finish() {
    // `stats` is still returned: level.js reads drawCalls/triangles off it, and
    // `colliders` was counted as they were added, independently of any geometry.
    if (COLLIDERS_ONLY) {
      for (const b of this._static.values()) for (const g of b.geos) g.dispose();
      this._static.clear();
      this._inst.clear();
      return this.stats;
    }
    this._foldSingletons();

    for (const b of this._static.values()) {
      if (!b.geos.length) continue;
      // mergeGeometries() demands an identical attribute set across the bucket, so once
      // one folded prop has brought a baked tint in, everything else needs a white one.
      if (b.colored) for (const g of b.geos) if (!g.attributes.color) fillVertexColor(g, WHITE);
      const geo = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
      if (!geo) { console.warn(`[props] merge failed for material ${b.mat}`); continue; }
      if (b.geos.length > 1) for (const g of b.geos) g.dispose();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, b.colored ? vertexColorMat(b.mat) : assets.mat(b.mat));
      mesh.name = `static_${b.mat}`;
      mesh.castShadow = b.cast;
      mesh.receiveShadow = b.receive;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      this.stats.meshes++;
      this.stats.triangles += (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
      b.geos.length = 0;
    }
    this._static.clear();

    for (const b of this._inst.values()) {
      const n = b.items.length / 7;
      if (!n) continue;
      const mesh = new THREE.InstancedMesh(b.geo, assets.mat(b.mat), n);
      mesh.name = `inst_${b.key || b.mat}`;
      mesh.castShadow = b.cast;
      mesh.receiveShadow = b.receive;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      for (let i = 0; i < n; i++) {
        const o = i * 7;
        _pos.set(b.items[o], b.items[o + 1], b.items[o + 2]);
        _quat.setFromAxisAngle(_up, b.items[o + 3]);
        _scl.set(b.items[o + 4], b.items[o + 5], b.items[o + 4]);
        _m4.compose(_pos, _quat, _scl);
        mesh.setMatrixAt(i, _m4);
        const col = b.items[o + 6];
        // setColorAt() lazily allocates instanceColor pre-filled with white, so
        // untinted instances need no call at all.
        if (col >= 0 || b.tint) {
          _c.setHex(col >= 0 ? col : 0xffffff);
          if (b.tint) { _c2.setHex(b.tint); _c.multiply(_c2); }
          mesh.setColorAt(i, _c);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      this.stats.instanced++;
      const tris = (b.geo.index ? b.geo.index.count : b.geo.attributes.position.count) / 3;
      this.stats.triangles += tris * n;
    }
    this._inst.clear();

    this.stats.meshes += this._singles.length;
    return this.stats;
  }
}

// ───────────────────────────────────────────────────────────────── prop templates

/**
 * Every entry: `(variant?) => { parts, colliders }` in LOCAL space, origin at the
 * ground-plane centre, long axis on X, facing -Z.
 */
export const PROPS = {

  /** ISO shipping container — corrugated flanks, corner castings, locking-bar doors. */
  container(variant) {
    const t = templateBuilder();
    const long = variant === 'short' ? 3.0 : 6.06;
    const H = 2.59, W = 2.44;
    t.box(0, H / 2, 0, long - 0.12, H - 0.1, W - 0.12, 'metal');
    const ribs = Math.floor((long - 0.5) / 0.4);
    for (let i = 0; i < ribs; i++) {
      const x = -(long - 0.5) / 2 + (i + 0.5) * 0.4;
      t.box(x, H / 2, W / 2 - 0.05, 0.13, H - 0.36, 0.09, 'metal');
      t.box(x, H / 2, -W / 2 + 0.05, 0.13, H - 0.36, 0.09, 'metal');
    }
    // Top & bottom rails.
    for (const y of [H - 0.05, 0.06]) {
      t.box(0, y, W / 2 - 0.04, long, 0.11, 0.12, 'metal');
      t.box(0, y, -W / 2 + 0.04, long, 0.11, 0.12, 'metal');
    }
    // Corner castings.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0.13, H - 0.13]) {
      t.box(sx * (long / 2 - 0.09), y, sz * (W / 2 - 0.09), 0.19, 0.26, 0.19, 'rubber');
    }
    // Doors on +X.
    for (const sz of [-1, 1]) {
      t.box(long / 2 + 0.02, H / 2, sz * 0.6, 0.06, H - 0.24, W / 2 - 0.14, 'metal');
      for (const o of [0.22, 0.62]) {
        t.box(long / 2 + 0.07, H / 2, sz * o, 0.06, H - 0.3, 0.06, 'rubber');
        t.box(long / 2 + 0.09, 1.2, sz * o, 0.11, 0.2, 0.11, 'rubber');
      }
    }
    t.col(-long / 2 - 0.04, 0, -W / 2, long / 2 + 0.1, H + 0.02, W / 2, 'metal');
    return t.finish();
  },

  /** 200 L drum with rolling hoops and a bung lid. */
  barrel() {
    const t = templateBuilder();
    t.cyl(0, 0.44, 0, 0.285, 0.285, 0.88, 14, 'metal');
    for (const y of [0.26, 0.62]) t.cyl(0, y, 0, 0.305, 0.305, 0.075, 14, 'metal');
    t.cyl(0, 0.885, 0, 0.295, 0.295, 0.05, 14, 'metal');
    t.cyl(0.13, 0.915, 0.06, 0.055, 0.055, 0.035, 8, 'rubber');
    t.col(-0.3, 0, -0.3, 0.3, 0.9, 0.3, 'metal');
    return t.finish();
  },

  /** Braced wooden crate. */
  crate(variant) {
    const t = templateBuilder();
    const s = variant === 'small' ? 0.62 : 0.94;
    const h = s;
    t.box(0, h / 2, 0, s - 0.07, h - 0.07, s - 0.07, 'wood');
    const b = 0.075;
    for (const sy of [b, h - b]) {
      t.box(0, sy, s / 2 - 0.02, s, b * 1.5, 0.05, 'wood');
      t.box(0, sy, -s / 2 + 0.02, s, b * 1.5, 0.05, 'wood');
      t.box(s / 2 - 0.02, sy, 0, 0.05, b * 1.5, s, 'wood');
      t.box(-s / 2 + 0.02, sy, 0, 0.05, b * 1.5, s, 'wood');
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      t.box(sx * (s / 2 - 0.04), h / 2, sz * (s / 2 - 0.04), 0.09, h, 0.09, 'wood');
    }
    t.col(-s / 2, 0, -s / 2, s / 2, h, s / 2, 'wood');
    return t.finish();
  },

  /** Staggered three-course sandbag revetment — chest-high cover. */
  sandbags(variant) {
    const t = templateBuilder();
    const rows = variant === 'low' ? 2 : 3;
    const bw = 0.5, bh = 0.3, bd = 0.56;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * bw * 0.5;
      const cnt = 4;
      for (let i = 0; i < cnt; i++) {
        const x = -0.75 + off + i * bw;
        if (x > 0.9) continue;
        t.box(x, bh / 2 + r * (bh - 0.03), 0, bw - 0.03, bh, bd, 'sandbag',
          { ry: (i % 2 ? 0.05 : -0.04), rz: (r % 2 ? 0.03 : -0.03) });
      }
    }
    const h = rows * (bh - 0.03) + 0.03;
    t.col(-0.95, 0, -0.3, 0.95, h, 0.3, 'dirt');
    return t.finish();
  },

  /** Jersey barrier — tapered concrete profile with a reflective band. */
  jersey() {
    const t = templateBuilder();
    t.box(0, 0.09, 0, 2.4, 0.18, 0.62, 'concrete');
    t.box(0, 0.36, 0, 2.4, 0.4, 0.42, 'concrete');
    t.box(0, 0.72, 0, 2.4, 0.34, 0.26, 'concrete');
    t.box(0, 0.9, 0, 2.42, 0.04, 0.28, 'concrete');
    for (const sx of [-0.72, 0.72]) t.box(sx, 0.56, 0.135, 0.34, 0.1, 0.02, 'metal', { tint: 0xffd166 });
    t.col(-1.2, 0, -0.32, 1.2, 0.92, 0.32, 'concrete');
    return t.finish();
  },

  /** Market stall — trestle table, produce boxes, striped awning. */
  stall() {
    const t = templateBuilder();
    t.box(0, 0.92, 0, 2.3, 0.09, 1.24, 'wood');
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      t.box(sx * 1.02, 0.46, sz * 0.5, 0.09, 0.92, 0.09, 'wood');
    }
    t.box(0, 0.32, 0, 2.1, 0.06, 0.9, 'wood');
    t.box(-0.6, 1.05, 0.1, 0.6, 0.22, 0.45, 'wood');
    t.box(0.55, 1.06, -0.1, 0.5, 0.24, 0.4, 'wood');
    for (const sx of [-1, 1]) t.box(sx * 1.06, 1.45, -0.62, 0.07, 1.9, 0.07, 'metal');
    for (const sx of [-1, 1]) t.box(sx * 1.06, 1.45, 0.62, 0.07, 1.9, 0.07, 'metal');
    // Awning: two shallow panels meeting at a ridge.
    t.box(0, 2.42, 0.44, 2.5, 0.06, 1.05, 'sandbag', { rx: -0.28 });
    t.box(0, 2.42, -0.44, 2.5, 0.06, 1.05, 'sandbag', { rx: 0.28 });
    t.box(0, 2.55, 0, 2.5, 0.08, 0.1, 'metal');
    t.col(-1.15, 0, -0.65, 1.15, 1.0, 0.65, 'wood');
    return t.finish();
  },

  /** Parked flatbed truck / technical. */
  truck() {
    const t = templateBuilder();
    t.box(0, 0.72, 0, 5.4, 0.3, 2.05, 'metal');                    // chassis
    t.box(-1.6, 1.42, 0, 1.85, 1.1, 2.1, 'metal');                 // cab
    t.box(-1.62, 2.02, 0, 1.7, 0.16, 2.06, 'metal');               // roof
    t.box(-2.52, 1.5, 0, 0.06, 0.72, 1.72, 'glass', { cast: false, receive: false });
    for (const sz of [-1, 1]) t.box(-1.5, 1.5, sz * 1.03, 1.1, 0.6, 0.05, 'glass', { cast: false, receive: false });
    t.box(0.95, 1.02, 0, 3.2, 0.34, 2.1, 'wood');                  // bed deck
    for (const sz of [-1, 1]) t.box(0.95, 1.42, sz * 1.0, 3.2, 0.7, 0.1, 'wood');
    t.box(2.52, 1.42, 0, 0.1, 0.7, 2.0, 'wood');
    t.box(-2.76, 0.86, 0, 0.18, 0.42, 2.16, 'rubber');             // bumper
    t.box(2.72, 0.86, 0, 0.14, 0.36, 2.1, 'rubber');
    for (const sz of [-1, 1]) {
      t.cyl(-1.72, 0.52, sz * 1.02, 0.52, 0.52, 0.32, 14, 'rubber', { rx: Math.PI / 2 });
      t.cyl(1.62, 0.52, sz * 1.02, 0.52, 0.52, 0.32, 14, 'rubber', { rx: Math.PI / 2 });
      t.cyl(-1.72, 0.52, sz * 1.02, 0.22, 0.22, 0.34, 10, 'metal', { rx: Math.PI / 2 });
      t.cyl(1.62, 0.52, sz * 1.02, 0.22, 0.22, 0.34, 10, 'metal', { rx: Math.PI / 2 });
    }
    for (const sz of [-1, 1]) t.box(-2.76, 1.22, sz * 0.72, 0.12, 0.22, 0.34, 'metal', { tint: 0xffe9c0 });
    t.col(-2.85, 0, -1.12, 2.85, 2.15, 1.12, 'metal');
    return t.finish();
  },

  /** Date palm — leaning segmented trunk, radial fronds. */
  palm(variant) {
    const t = templateBuilder();
    const H = variant === 'tall' ? 7.2 : 5.4;
    const segs = 6, lean = variant === 'tall' ? 0.055 : 0.085;
    let x = 0, y = 0;
    for (let i = 0; i < segs; i++) {
      const sh = H / segs;
      const r0 = 0.3 - (i / segs) * 0.13;
      const r1 = 0.3 - ((i + 1) / segs) * 0.13;
      t.cyl(x + Math.sin(i * lean) * 0.18, y + sh / 2, 0, r1, r0, sh + 0.04, 9, 'wood', { rz: -lean });
      t.cyl(x, y + sh, 0, r1 + 0.035, r1 + 0.035, 0.07, 9, 'wood');
      x += Math.sin(lean) * sh; y += sh;
    }
    const top = y;
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const droop = -0.55 - (i % 3) * 0.12;
      const g = new THREE.BoxGeometry(2.9, 0.07, 0.46);
      scaleBoxUV(g, 2.9, 0.07, 0.46, UV);
      g.translate(1.5, 0, 0);
      g.rotateZ(droop);
      g.rotateY(a);
      g.translate(x, top + 0.25, 0);
      t.add(g, 'dirt', { tint: 0x4e7a35, receive: false });
    }
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.4;
      t.box(x + Math.cos(a) * 0.42, top + 0.05, Math.sin(a) * 0.42, 0.34, 0.3, 0.34, 'dirt', { tint: 0x8a6a2c });
    }
    t.col(-0.28, 0, -0.28, 0.28 + x, top, 0.28, 'wood');
    return t.finish();
  },

  /** Harbour streetlight with an emissive lens. */
  streetlight() {
    const t = templateBuilder();
    t.cyl(0, 0.16, 0, 0.24, 0.3, 0.32, 10, 'concrete');
    t.cyl(0, 3.1, 0, 0.075, 0.11, 6.0, 10, 'metal');
    t.box(0.5, 6.16, 0, 1.1, 0.1, 0.1, 'metal', { rz: 0.18 });
    t.box(1.02, 6.26, 0, 0.66, 0.16, 0.34, 'metal');
    t.box(1.02, 6.15, 0, 0.5, 0.06, 0.24, 'glassOptic', { cast: false });
    // Collider only needs to block the base of the mast at a normal standing height —
    // the full 6.3 m visual pole made its flat top standable and fed a mantle route onto
    // nearby rooftops (project_map_open_items item 4). 2.2 m still blocks the pole solidly
    // without offering a climbable surface near roof height.
    t.col(-0.28, 0, -0.28, 0.28, 2.2, 0.28, 'metal');
    return t.finish();
  },

  /** Rooftop AC condenser. */
  acUnit() {
    const t = templateBuilder();
    t.box(0, 0.5, 0, 1.16, 0.98, 0.86, 'metal');
    t.box(0, 1.02, 0, 1.2, 0.07, 0.9, 'metal');
    for (let i = 0; i < 5; i++) t.box(0, 0.28 + i * 0.13, 0.45, 1.06, 0.07, 0.05, 'metal', { rx: 0.3 });
    t.cyl(0, 1.07, 0, 0.34, 0.34, 0.06, 12, 'rubber');
    for (let i = 0; i < 4; i++) t.box(0, 1.1, 0, 0.62, 0.03, 0.09, 'rubber', { ry: i * 0.8 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) t.box(sx * 0.5, 0.05, sz * 0.36, 0.14, 0.1, 0.14, 'rubber');
    t.col(-0.62, 0, -0.47, 0.62, 1.1, 0.47, 'metal');
    return t.finish();
  },

  /** Stack of euro pallets. */
  pallets(variant) {
    const t = templateBuilder();
    const n = variant === 'tall' ? 6 : 3;
    for (let p = 0; p < n; p++) {
      const y = p * 0.15;
      for (let i = 0; i < 5; i++) t.box(-0.56 + i * 0.28, y + 0.125, 0, 0.2, 0.03, 0.8, 'wood');
      for (const sz of [-0.34, 0, 0.34]) t.box(0, y + 0.055, sz, 1.2, 0.09, 0.13, 'wood');
      t.box(0, y + 0.01, 0, 1.2, 0.03, 0.8, 'wood');
    }
    t.col(-0.6, 0, -0.4, 0.6, n * 0.15, 0.4, 'wood');
    return t.finish();
  },

  /** Tyre stack. */
  tyres() {
    const t = templateBuilder();
    for (let i = 0; i < 4; i++) {
      t.cyl(((i % 2) - 0.5) * 0.06, 0.13 + i * 0.24, ((i % 3) - 1) * 0.05, 0.44, 0.44, 0.25, 14, 'rubber');
      t.cyl(((i % 2) - 0.5) * 0.06, 0.13 + i * 0.24, ((i % 3) - 1) * 0.05, 0.2, 0.2, 0.27, 10, 'metal');
    }
    t.col(-0.48, 0, -0.48, 0.48, 1.0, 0.48, 'dirt');
    return t.finish();
  },

  /** Water tower on braced legs — the tallest landmark on the skyline. */
  waterTower() {
    const t = templateBuilder();
    const legH = 7.4, r = 2.1;
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2 + Math.PI / 4;
      const bx = Math.cos(a) * (r + 0.35), bz = Math.sin(a) * (r + 0.35);
      t.box(bx, legH / 2, bz, 0.22, legH + 0.4, 0.22, 'metal');
      t.box(bx, 0.14, bz, 0.62, 0.28, 0.62, 'concrete');
    }
    for (const y of [2.4, 5.0]) {
      t.box(0, y, r * 0.5, r * 1.5, 0.11, 0.11, 'metal');
      t.box(0, y, -r * 0.5, r * 1.5, 0.11, 0.11, 'metal');
      t.box(r * 0.5, y, 0, 0.11, 0.11, r * 1.5, 'metal');
      t.box(-r * 0.5, y, 0, 0.11, 0.11, r * 1.5, 'metal');
    }
    t.box(0, legH + 0.1, 0, r * 2.2, 0.2, r * 2.2, 'metal');
    t.cyl(0, legH + 1.7, 0, r, r, 3.1, 16, 'metal');
    for (const y of [legH + 0.55, legH + 2.85]) t.cyl(0, y, 0, r + 0.07, r + 0.07, 0.14, 16, 'metal');
    t.cyl(0, legH + 3.6, 0, 0.35, r, 0.85, 16, 'metal');
    t.cyl(0, legH + 4.15, 0, 0.16, 0.16, 0.4, 8, 'metal');
    t.col(-r, 0, -r, r, legH + 3.4, r, 'metal');
    return t.finish();
  },

  /** Quayside gantry crane — silhouette + climbable-free structural legs. */
  crane() {
    const t = templateBuilder();
    const H = 13.5;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      t.box(sx * 3.2, H / 2, sz * 3.2, 0.42, H, 0.42, 'metal', { tint: 0xf0b429 });
      t.box(sx * 3.2, 0.3, sz * 3.2, 1.3, 0.6, 1.3, 'concrete');
    }
    for (const y of [3.5, 7.5, 11]) {
      for (const sz of [-1, 1]) t.box(0, y, sz * 3.2, 6.6, 0.2, 0.2, 'metal', { tint: 0xf0b429 });
      for (const sx of [-1, 1]) t.box(sx * 3.2, y, 0, 0.2, 0.2, 6.6, 'metal', { tint: 0xf0b429 });
    }
    t.box(0, H + 0.8, 0, 7.4, 1.6, 7.4, 'metal', { tint: 0xf0b429 });
    t.box(-9.5, H + 1.4, 0, 24, 0.9, 1.5, 'metal', { tint: 0xf0b429 });
    t.box(-9.5, H + 2.1, 0, 24, 0.5, 0.5, 'metal');
    t.box(-16, H + 0.2, 0, 1.8, 1.4, 2.2, 'metal', { tint: 0x2f3a45 });
    t.box(-16, H - 1.6, 0, 0.5, 2.4, 0.5, 'metal');
    t.box(-16, H - 3.0, 0, 1.6, 0.5, 1.6, 'rubber');
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) t.col(sx * 3.2 - 0.5, 0, sz * 3.2 - 0.5, sx * 3.2 + 0.5, H, sz * 3.2 + 0.5, 'metal');
    return t.finish();
  },

  /** Stone well head for the courtyard. */
  well() {
    const t = templateBuilder();
    t.cyl(0, 0.45, 0, 1.35, 1.45, 0.9, 12, 'brick');
    t.cyl(0, 0.93, 0, 1.42, 1.42, 0.14, 12, 'concreteDark');
    t.cyl(0, 0.5, 0, 1.05, 1.05, 0.9, 12, 'concreteDark');
    for (const sx of [-1, 1]) t.box(sx * 1.2, 1.6, 0, 0.16, 1.3, 0.16, 'wood');
    t.box(0, 2.24, 0, 2.7, 0.12, 0.9, 'wood', { rx: 0.22 });
    t.cyl(0, 2.0, 0, 0.13, 0.13, 2.2, 8, 'wood', { rz: Math.PI / 2 });
    t.col(-1.5, 0, -1.5, 1.5, 1.05, 1.5, 'concrete');
    return t.finish();
  },

  /** Mooring bollard. */
  bollard() {
    const t = templateBuilder();
    t.cyl(0, 0.06, 0, 0.28, 0.32, 0.12, 10, 'metal');
    t.cyl(0, 0.42, 0, 0.16, 0.2, 0.72, 10, 'metal');
    t.cyl(0, 0.82, 0, 0.24, 0.18, 0.16, 10, 'metal');
    t.col(-0.26, 0, -0.26, 0.26, 0.9, 0.26, 'metal');
    return t.finish();
  },

  /** Arcade / colonnade pillar. Variant = height in metres, e.g. '4.0'. */
  pillar(variant) {
    const t = templateBuilder();
    const h = parseFloat(variant) || 3.7;
    t.box(0, 0.11, 0, 0.92, 0.22, 0.92, 'concreteDark');
    t.box(0, h / 2, 0, 0.66, h, 0.66, 'concrete');
    t.box(0, h - 0.13, 0, 0.9, 0.26, 0.9, 'concreteDark');
    t.col(-0.46, 0, -0.46, 0.46, h, 0.46, 'concrete');
    return t.finish();
  },

  /** Railing post — placed in runs by Builder.railing(). */
  railPost() {
    const t = templateBuilder();
    t.box(0, 0.53, 0, 0.08, 1.06, 0.08, 'metal');
    t.box(0, 0.03, 0, 0.18, 0.06, 0.18, 'metal');
    return t.finish();
  },

  /** Standalone door frame + ajar leaf. Variant = "WxH". */
  doorFrame(variant) {
    const t = templateBuilder();
    const [w, h] = (variant || '1.2x2.2').split('x').map(Number);
    const jw = 0.11;
    for (const sx of [-1, 1]) t.box(sx * (w / 2 + jw / 2), h / 2, 0, jw, h, 0.28, 'wood');
    t.box(0, h + jw / 2, 0, w + jw * 2, jw, 0.3, 'wood');
    // Leaf, swung open ~70°.
    const g = new THREE.BoxGeometry(w - 0.05, h - 0.08, 0.06);
    scaleBoxUV(g, w - 0.05, h - 0.08, 0.06, UV);
    g.translate((w - 0.05) / 2, 0, 0);
    g.rotateY(-1.22);
    g.translate(-w / 2, (h - 0.08) / 2, 0.1);
    t.add(g, 'wood');
    return t.finish();
  },

  /** Window frame + mullion + panes. Variant = "WxH". Panes get glass colliders. */
  windowFrame(variant) {
    const t = templateBuilder();
    const [w, h] = (variant || '1.6x1.3').split('x').map(Number);
    const f = 0.1;
    for (const sx of [-1, 1]) t.box(sx * (w / 2 - f / 2), h / 2, 0, f, h, 0.16, 'metal');
    for (const sy of [f / 2, h - f / 2]) t.box(0, sy, 0, w, f, 0.16, 'metal');
    t.box(0, h / 2, 0, 0.07, h, 0.14, 'metal');
    t.box(0, h / 2, 0, w - f * 2, h - f * 2, 0.04, 'glass', { cast: false, receive: false });
    t.col(-w / 2, 0.02, -0.03, w / 2, h - 0.02, 0.03, 'glass');
    return t.finish();
  },

  /** Wall-mounted air vent / grille cluster — cheap façade detail. */
  vent() {
    const t = templateBuilder();
    t.box(0, 0.4, 0, 0.86, 0.8, 0.18, 'metal');
    for (let i = 0; i < 5; i++) t.box(0, 0.12 + i * 0.15, 0.1, 0.76, 0.07, 0.06, 'metal', { rx: 0.35 });
    return t.finish();
  },

  /**
   * One louvred shutter leaf, 0.62 × 1.3 m, hinged flat against the wall, origin at its
   * bottom edge. NOTE: shutter/sign/cloth face **+Z at yaw 0** (the wall-mounted family),
   * unlike the free-standing props which face -Z — that is the orientation
   * Builder._shutters() derives from the wall face it is dressing.
   * Placed in pairs; the per-instance colour is what carries the lane palette, so the
   * whole leaf is a single tintable part.
   */
  shutter() {
    const t = templateBuilder();
    t.box(0, 0.65, -0.02, 0.62, 1.3, 0.035, 'wood');                              // backing board
    for (const sx of [-0.27, 0.27]) t.box(sx, 0.65, 0.01, 0.08, 1.3, 0.05, 'wood');   // stiles
    for (const sy of [0.06, 0.65, 1.24]) t.box(0, sy, 0.01, 0.62, 0.08, 0.05, 'wood'); // rails
    for (let i = 0; i < 6; i++) t.box(0, 0.2 + i * 0.16, 0.012, 0.46, 0.075, 0.045, 'wood', { rx: -0.42 });
    return t.finish();
  },

  /**
   * Flat painted board, 1 × 1 m, origin at its bottom edge, facing +Z. Scaled and tinted
   * at stamp time it becomes shop signage, a painted dado band, a hoarding, a graffiti
   * patch or a roller-door leaf — every one of them sharing a single InstancedMesh.
   * Matte plaster, so per-instance colour reads as paint rather than as tinted steel.
   */
  sign() {
    const t = templateBuilder();
    // cast:false — a 2 cm board flat on a wall contributes nothing to the shadow map but
    // would cost a whole extra draw call in the shadow pass.
    t.box(0, 0.5, 0, 1.0, 1.0, 0.022, 'plaster', { cast: false });
    t.box(0, 0.5, 0.012, 0.9, 0.9, 0.03, 'plaster', { cast: false });
    return t.finish();
  },

  /**
   * Hanging cloth — laundry, banners, tarpaulin. Origin at the TOP edge so it hangs
   * DOWN from a line: 1 m wide × 1 m deep at scale 1, facing +Z. Three panels with a
   * slight flutter so it does not read as a playing card.
   */
  cloth() {
    const t = templateBuilder();
    for (let i = 0; i < 3; i++) {
      const x = (i - 1) * 0.33;
      t.box(x, -0.5, (i - 1) * 0.035, 0.34, 1.0, 0.02, 'sandbag', { rz: (i - 1) * 0.05 });
    }
    return t.finish();
  },

  /** Awning over a doorway — pure dressing, no collider. */
  awning() {
    const t = templateBuilder();
    t.box(0, 0.06, 0.55, 2.6, 0.1, 1.5, 'sandbag', { rx: -0.26 });
    t.box(0, 0.2, -0.18, 2.6, 0.1, 0.14, 'metal');
    for (const sx of [-1, 1]) t.box(sx * 1.2, -0.28, 0.1, 0.06, 0.75, 0.06, 'metal', { rx: -0.5 });
    return t.finish();
  },
};
