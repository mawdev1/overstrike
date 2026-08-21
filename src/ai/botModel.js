import * as THREE from 'three';
import { assets } from '../core/assets.js';
import { clamp, lerp, damp, angleDelta, moveAngleTowards } from '../core/mathUtils.js';
import { createRNG, mixSeed } from '../core/rng.js';

/**
 * Procedural soldier — geometry, rig and animation, no external assets.
 *
 * Draw-call strategy (ARCHITECTURE.md §11): a naive Object3D-with-box-children
 * rig costs one draw call per bone per bot, which is ~144 calls for 12 bots and
 * eats two thirds of the whole budget. So the *bones* stay a plain Object3D
 * hierarchy (cheap, readable, easy to animate) but the *meshes* are shared
 * InstancedMeshes keyed by (team, bone). Each frame we update the bone matrices
 * locally and blit `bone.matrixWorld` into the instance buffer.
 *
 * Cost: 12 bones x 2 teams = 24 draw calls for any number of bots.
 * Geometry: 49 boxes = 588 triangles per soldier.
 */

const BONES = [
  'hips', 'torso', 'head',
  'upperArmL', 'foreArmL', 'upperArmR', 'foreArmR',
  'thighL', 'shinL', 'thighR', 'shinR',
  'weapon',
];
const BONE_COUNT = BONES.length;
const RIG_CAPACITY = 32;

const MAX_TWIST = 1.047;        // 60° of torso-vs-legs separation
const HIP_Y_STAND = 0.94;
const HIP_Y_CROUCH = 0.58;
const HEAD_Y_STAND = 0.56;      // local to torso; puts the skull at 1.66 (hitbox centre)
const HEAD_Y_CROUCH = 0.24;
const DEATH_DURATION = 0.62;

/**
 * Colourways. At 40 m a soldier is roughly 45 px tall, so anything under about
 * 5 cm is sub-pixel and only three things actually read: the outline, big blocks
 * of tonal contrast, and one saturated team colour. Both palettes are therefore
 * built as LIGHT fatigues against a NEAR-BLACK plate carrier — the carrier reads
 * as a dark core inside a lighter body even when every edge has blurred — with
 * the accent reserved for four large contiguous patches (helmet band, both
 * shoulder caps, chest stripe, rear pack) rather than sprinkled piping.
 */
const PALETTES = [
  { // team 0 — desert tan fatigues, olive carrier, amber accent
    fatigue: 0xbba274, fatigueDark: 0x8f7c55, vest: 0x3f4632, webbing: 0x34381f,
    helmet: 0x6e6a48, boot: 0x2a241c, skin: 0xb08a62, visor: 0x15181b,
    gun: 0x35353a, gunPoly: 0x6b5f45, accent: 0xffb524,
  },
  { // team 1 — urban slate fatigues, black carrier, red accent
    fatigue: 0x767d88, fatigueDark: 0x4d535b, vest: 0x22262b, webbing: 0x1b1e22,
    helmet: 0x3d434a, boot: 0x17191c, skin: 0xb08a62, visor: 0x101316,
    gun: 0x26282c, gunPoly: 0x353940, accent: 0xf03a2e,
  },
];

// ---------------------------------------------------------------- geometry

const _c = new THREE.Color();

/** Appends axis-aligned boxes with baked vertex colours into flat arrays. */
class BoxBuilder {
  constructor() { this.pos = []; this.nrm = []; this.col = []; }

  box(cx, cy, cz, sx, sy, sz, hex) {
    // setHex() already converts from sRGB into the renderer's working space
    // when ColorManagement is enabled (three >= r152), so no manual convert.
    _c.setHex(hex);
    const r = _c.r, g = _c.g, b = _c.b;
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const x0 = cx - hx, x1 = cx + hx;
    const y0 = cy - hy, y1 = cy + hy;
    const z0 = cz - hz, z1 = cz + hz;
    // 6 faces, CCW when viewed from outside.
    this._quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, r, g, b);   // +Z
    this._quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, r, g, b);  // -Z
    this._quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, r, g, b);   // +X
    this._quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, r, g, b);  // -X
    this._quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0, r, g, b);   // +Y
    this._quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0, r, g, b);  // -Y
    return this;
  }

  _quad(ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx, dy, dz, nx, ny, nz, r, g, b) {
    const p = this.pos, n = this.nrm, c = this.col;
    p.push(ax, ay, az, bx, by, bz, cx2, cy2, cz2);
    p.push(ax, ay, az, cx2, cy2, cz2, dx, dy, dz);
    for (let i = 0; i < 6; i++) { n.push(nx, ny, nz); c.push(r, g, b); }
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * 49 boxes = 588 triangles per soldier, laid out for readability at range.
 *
 * The rules the shapes follow, in priority order:
 *  1. OUTLINE — helmet dome wider than the skull with a rim that overhangs it,
 *     a shoulder yoke that squares off the top of the torso, and a body that
 *     tapers to the boots. At 40 m the outline is most of what a player sees,
 *     so a soldier must not be a stack of similar boxes.
 *  2. VALUE — the plate carrier is near-black on both teams and steps proud of
 *     the chest on all four sides, giving a dark core inside lighter fatigues
 *     that survives any amount of blur.
 *  3. TEAM COLOUR — four large contiguous accent patches (helmet band, both
 *     shoulder caps, chest stripe, rear pack) instead of thin piping, so team
 *     ID is readable from front, back and either flank.
 *  4. Detail (pouches, holster, NVG mount, knee-height boot cuffs) last, and
 *     only where it also serves 1-3.
 *
 * The `head` bone sits at world 1.66 (hips 0.94 + torso 0.16 + head 0.56) and
 * all helmet geometry stays inside ±0.14, so the visible skull matches the
 * `head` hitbox (offset y = height - 0.14, size 0.30 x 0.28 x 0.30) exactly.
 */
function buildBoneGeometries(p) {
  const out = {};

  // ---- hips: pelvis, a wide belt line, dump pouch and holster (4)
  out.hips = new BoxBuilder()
    .box(0, -0.04, 0, 0.34, 0.22, 0.24, p.fatigue)
    .box(0, 0.075, 0, 0.38, 0.09, 0.28, p.webbing)
    .box(-0.20, -0.06, 0.03, 0.11, 0.16, 0.13, p.webbing)
    .box(0.20, -0.08, -0.01, 0.10, 0.17, 0.11, p.gun)
    .build();

  // ---- torso: abdomen, chest, four-sided plate carrier, mag pouches, pack,
  //      shoulder yoke, neck, chest accent (13)
  out.torso = new BoxBuilder()
    .box(0, 0.10, 0, 0.33, 0.24, 0.23, p.fatigue)
    .box(0, 0.35, 0, 0.44, 0.32, 0.25, p.fatigue)
    // plate carrier — proud of the chest so it casts its own edge
    .box(0, 0.33, -0.155, 0.38, 0.40, 0.075, p.vest)
    .box(0, 0.33, 0.155, 0.38, 0.40, 0.075, p.vest)
    .box(0.215, 0.33, 0, 0.06, 0.36, 0.24, p.vest)
    .box(-0.215, 0.33, 0, 0.06, 0.36, 0.24, p.vest)
    // three mag pouches read as one horizontal band across the belly
    .box(-0.115, 0.19, -0.205, 0.105, 0.16, 0.10, p.webbing)
    .box(0.005, 0.19, -0.205, 0.105, 0.16, 0.10, p.webbing)
    .box(0.125, 0.19, -0.205, 0.105, 0.16, 0.10, p.webbing)
    // rear pack, in team colour — the back view needs an ID too
    .box(0, 0.31, 0.235, 0.30, 0.28, 0.10, p.accent)
    // shoulder yoke squares off the top of the silhouette
    .box(0, 0.47, 0, 0.48, 0.09, 0.23, p.vest)
    .box(0, 0.51, 0, 0.13, 0.09, 0.13, p.skin)
    // chest stripe
    .box(0, 0.455, -0.16, 0.32, 0.07, 0.075, p.accent)
    .build();

  // ---- head: skull, helmet dome + overhanging rim, visor, NVG mount, team
  //      band, nape pad (7). Everything stays within the head hitbox.
  out.head = new BoxBuilder()
    .box(0, -0.01, 0.01, 0.20, 0.22, 0.21, p.skin)
    .box(0, 0.055, 0, 0.275, 0.155, 0.285, p.helmet)
    .box(0, -0.03, 0, 0.29, 0.055, 0.30, p.helmet)
    .box(0, -0.005, -0.125, 0.215, 0.075, 0.055, p.visor)
    .box(0, 0.075, -0.155, 0.055, 0.055, 0.06, p.gun)
    .box(0, 0.132, 0, 0.245, 0.035, 0.255, p.accent)
    .box(0, -0.08, 0.095, 0.19, 0.09, 0.09, p.webbing)
    .build();

  // ---- arms: sleeve + a big accent shoulder cap (2 each)
  const upperArm = () => new BoxBuilder()
    .box(0, -0.15, 0, 0.115, 0.30, 0.125, p.fatigue)
    .box(0, -0.02, 0, 0.15, 0.11, 0.16, p.accent)
    .build();
  const foreArm = () => new BoxBuilder()
    .box(0, -0.13, 0, 0.10, 0.26, 0.10, p.fatigueDark)
    // elbow pad caps the joint so the bend reads as a bend, not a gap
    .box(0, -0.005, -0.005, 0.105, 0.09, 0.115, p.webbing)
    .box(0, -0.29, 0, 0.095, 0.11, 0.115, p.boot)
    .build();
  out.upperArmL = upperArm();
  out.upperArmR = upperArm();
  out.foreArmL = foreArm();
  out.foreArmR = foreArm();

  // ---- legs: thigh, shin, and a boot that flares at the sole so the figure
  //      plants on the ground instead of tapering into it (1 + 2 each)
  const thigh = () => new BoxBuilder()
    .box(0, -0.20, 0, 0.15, 0.40, 0.17, p.fatigue)
    .build();
  const shin = () => new BoxBuilder()
    .box(0, -0.18, 0, 0.125, 0.36, 0.145, p.fatigueDark)
    // knee pad — sits proud of the shin's front face and caps the hinge
    .box(0, -0.035, -0.075, 0.13, 0.13, 0.06, p.webbing)
    .box(0, -0.40, -0.03, 0.14, 0.10, 0.26, p.boot)
    .build();
  out.thighL = thigh();
  out.thighR = thigh();
  out.shinL = shin();
  out.shinR = shin();

  out.weapon = new BoxBuilder()
    .box(0, 0, -0.02, 0.06, 0.10, 0.44, p.gun)
    .box(0, 0.01, -0.36, 0.05, 0.06, 0.30, p.gun)
    .box(0, 0.01, -0.53, 0.045, 0.045, 0.07, p.gun)
    .box(0, -0.01, 0.22, 0.05, 0.09, 0.20, p.gunPoly)
    .box(0, -0.12, -0.06, 0.05, 0.18, 0.09, p.gunPoly)
    .box(0, -0.09, 0.07, 0.045, 0.12, 0.07, p.gunPoly)
    .box(0, 0.08, -0.06, 0.04, 0.06, 0.12, p.gun)
    .build();

  return out;
}

// ------------------------------------------------------------- shared pool

const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
const _moveMatrix = new THREE.Matrix4();
const _upAxis = new THREE.Vector3(0, 1, 0);

/**
 * Slop added to the per-team bounding sphere. The reach term it is added to is already
 * exact (bone transforms are rigid, so a bone's local bounding sphere radius carries into
 * world space unchanged), so this only has to cover float error — but a bot vanishing is
 * far worse than a bot rasterising, so it is deliberately generous.
 */
const BOUND_MARGIN = 0.25;

/**
 * Radius the shared spheres start at, and the value they keep until the first bot blits.
 * `_prewarmShaders()` in game.js builds a throwaway rig, force-shows the scene and renders
 * once to force the shadow-depth programs to compile — without ever calling update(). With
 * culling now enabled that render must not cull the rig, or the depth variants compile
 * lazily during the first firefight instead. An unblitted rig therefore reads as "infinite".
 */
const BOUND_UNBOUNDED = 1e6;

const RIG = {
  material: null,
  // Monotonic counter, purely for deriving each model's decoration RNG. It must NOT be
  // `live`, which is a live *count*: releasing one model and building another reuses the
  // number, and two models sharing a seed means two soldiers walking in perfect lockstep
  // with identical death sprawls.
  serial: 0,
  geos: [null, null],
  meshes: [null, null],
  // The pool is kept EXACTLY packed: slots 0..count-1 are occupied, nothing above is.
  // `owner[team][slot]` is the BotModel holding it, so a release can pull the top model
  // down into the hole. That replaces the old free list entirely — a free list cannot
  // keep `count` tight, and `count` is the whole point (see applyCount).
  owner: [new Array(RIG_CAPACITY).fill(null), new Array(RIG_CAPACITY).fill(null)],
  count: [0, 0],
  // One Sphere per team, SHARED by all 12 of that team's InstancedMeshes (three reads
  // `object.boundingSphere` in Frustum.intersectsObject, for both the colour and the
  // shadow pass). Mutating it in place therefore re-aims all 12 culling tests at once.
  sphere: [null, null],
  // max over the team's bone geometries of (|bs.center| + bs.radius) + BOUND_MARGIN:
  // how far any vertex can sit from its bone's origin.
  reach: [0, 0],
  // `game.frame` of the last blit, per team — drives the once-per-frame accumulator reset.
  stamp: [-1, -1],
  scene: null,
  live: 0,
};

/**
 * Greedy in-place union of the sphere (cx, cy, cz, r) into `s`. `s.radius < 0` means empty.
 * Not the minimal enclosing sphere (that needs the whole point set at once), but it is
 * strictly conservative, which is the only property culling correctness depends on.
 */
function unionSphere(s, cx, cy, cz, r) {
  if (s.radius < 0) { s.center.set(cx, cy, cz); s.radius = r; return; }
  const dx = cx - s.center.x, dy = cy - s.center.y, dz = cz - s.center.z;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d + r <= s.radius) return;                          // already contained
  if (d + s.radius <= r) { s.center.set(cx, cy, cz); s.radius = r; return; }
  // Neither contains the other, so d > 0 and the division below is safe.
  const R = (s.radius + r + d) * 0.5;
  const t = (R - s.radius) / d;
  s.center.x += dx * t; s.center.y += dy * t; s.center.z += dz * t;
  s.radius = R;
}

/**
 * Push `RIG.count[team]` onto every bone mesh.
 *
 * An InstancedMesh created at RIG_CAPACITY submits RIG_CAPACITY copies of its geometry to
 * the vertex stage every pass, forever. The parked slots hold a zero-scale matrix so they
 * collapse to a degenerate point and cost no raster — but they are still transformed, and
 * they are transformed TWICE (colour + shadow). At 12 bots that is 34,560 triangles
 * submitted for 6,480 needed. `count` is the only knob that removes the work.
 */
function applyCount(team) {
  const meshes = RIG.meshes[team];
  if (!meshes) return;
  const n = RIG.count[team];
  for (let i = 0; i < BONE_COUNT; i++) meshes[i].count = n;
}

function rigMaterial() {
  if (RIG.material) return RIG.material;
  // Registered in the shared assets cache so nothing here is per-object and
  // assets.dispose() sweeps it up with everything else.
  let m = assets.materials.get('botBody');
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.86, metalness: 0.06,
    });
    m.userData.surface = 'flesh';
    assets.materials.set('botBody', m);
  }
  RIG.material = m;
  return m;
}

function ensureTeam(game, team) {
  if (RIG.meshes[team]) return;
  const geos = buildBoneGeometries(PALETTES[team] || PALETTES[0]);
  const mat = rigMaterial();
  // How far a vertex can be from its bone origin, over every bone in this colourway.
  // Bone matrices are rigid (position + quaternion, never scale), so a local radius is
  // also a world radius and this bound is exact before BOUND_MARGIN is added.
  let reach = 0;
  for (let i = 0; i < BONE_COUNT; i++) {
    const g = geos[BONES[i]];
    if (!g.boundingSphere) g.computeBoundingSphere();
    const bs = g.boundingSphere;
    if (bs) reach = Math.max(reach, bs.center.length() + bs.radius);
  }
  RIG.reach[team] = reach + BOUND_MARGIN;

  const sphere = new THREE.Sphere(new THREE.Vector3(), BOUND_UNBOUNDED);
  RIG.sphere[team] = sphere;

  const meshes = new Array(BONE_COUNT);
  for (let i = 0; i < BONE_COUNT; i++) {
    const im = new THREE.InstancedMesh(geos[BONES[i]], mat, RIG_CAPACITY);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.castShadow = true;
    im.receiveShadow = true;
    // Culling IS enabled, against a sphere we maintain ourselves over the live slots
    // (see _blit). three's own InstancedMesh bound would be wrong here — it is computed
    // once from a buffer we rewrite every frame — and leaving culling off meant all 24
    // meshes rasterised into the shadow cascade with both teams behind the camera.
    // The mesh is never transformed, so the sphere is used directly as world space.
    im.frustumCulled = true;
    im.boundingSphere = sphere;
    im.name = `bot${team}_${BONES[i]}`;
    for (let s = 0; s < RIG_CAPACITY; s++) im.setMatrixAt(s, _zeroMatrix);
    im.count = RIG.count[team];
    meshes[i] = im;
    if (game.scene) game.scene.add(im);
  }
  RIG.geos[team] = geos;
  RIG.meshes[team] = meshes;
  RIG.scene = game.scene;
}

function acquireSlot(game, team, model) {
  ensureTeam(game, team);
  const slot = RIG.count[team];
  if (slot >= RIG_CAPACITY) {
    console.warn('[botModel] rig capacity exhausted; extra bots will be invisible');
    return -1;
  }
  RIG.owner[team][slot] = model;
  RIG.count[team] = slot + 1;
  applyCount(team);
  return slot;
}

/**
 * Release `slot`, pulling the model in the top slot down into the hole so the pool stays
 * packed and `count` stays equal to the number of live models.
 *
 * Compaction is not a nicety here. BotManager builds the whole roster on one team and
 * then reassigns half of it, so a free-list pool ends a normal 12-bot match with team 1
 * holding slots 6..11 and a `count` of 12 — i.e. half of team 1's submitted soldiers are
 * holes. Measured: 20 occupied-or-holed slots for 12 bots without this, 12 with it.
 *
 * The moved model's matrices are copied across immediately rather than waiting for its
 * next `_blit()`, so it never renders a frame from a stale slot.
 */
function releaseSlot(team, slot, model) {
  const meshes = RIG.meshes[team];
  if (slot < 0 || !meshes) return;
  const owner = RIG.owner[team];
  if (owner[slot] !== model) return;       // already released, or never really owned

  const last = RIG.count[team] - 1;
  if (slot !== last) {
    const moved = owner[last];
    owner[slot] = moved;
    if (moved) moved.slot = slot;
    for (let i = 0; i < BONE_COUNT; i++) {
      meshes[i].getMatrixAt(last, _moveMatrix);
      meshes[i].setMatrixAt(slot, _moveMatrix);
    }
  }
  owner[last] = null;
  RIG.count[team] = last;
  for (let i = 0; i < BONE_COUNT; i++) {
    meshes[i].setMatrixAt(last, _zeroMatrix);
    meshes[i].instanceMatrix.needsUpdate = true;
  }
  applyCount(team);
}

/** Tear down every shared rig resource. Called by BotManager.dispose(). */
export function disposeBotRigs() {
  for (let t = 0; t < 2; t++) {
    const meshes = RIG.meshes[t];
    if (meshes) {
      for (const im of meshes) {
        if (im.parent) im.parent.remove(im);
        im.dispose();
      }
    }
    const geos = RIG.geos[t];
    if (geos) for (const k of BONES) geos[k]?.dispose();
    RIG.meshes[t] = null;
    RIG.geos[t] = null;
    RIG.owner[t].fill(null);
    RIG.count[t] = 0;
    RIG.sphere[t] = null;
    RIG.reach[t] = 0;
    RIG.stamp[t] = -1;
  }
  RIG.material = null;
  RIG.scene = null;
  RIG.live = 0;
}

// ------------------------------------------------------------------- model

export class BotModel {
  /**
   * @param {object} game
   * @param {0|1} team
   */
  constructor(game, team) {
    this.game = game;
    this.team = team === 1 ? 1 : 0;
    // The model's own stream. Gait phase and limp sprawl are pure decoration, but
    // `respawn()` runs on the SIMULATION path (Bot.spawn calls it), so drawing them
    // from `game.rng` moved the shared stream by two per bot life — and only when a
    // model existed. A headless server, which builds no models, would then be two
    // draws per spawn out of step with every client. Its own stream cannot desync
    // anything. It is seeded from a monotonic serial, so it is stable for the life of
    // a model but deliberately NOT reproducible across sessions — nothing it feeds is
    // simulation, and a per-match seed would be a lie about what this stream is for.
    this._rng = createRNG(mixSeed(game?.matchSeed ?? 0, RIG.serial++));
    // `slot` is not stable for the lifetime of the model: releaseSlot() compacts the
    // pool and may move this model down into another model's slot. Nothing outside this
    // file reads it, and every read inside it goes through `this.slot`.
    this.slot = acquireSlot(game, this.team, this);
    this.visible = true;
    this.disposed = false;
    RIG.live++;

    // --- bone hierarchy (transforms only; the meshes live in the shared pool)
    const O = () => { const o = new THREE.Object3D(); o.matrixAutoUpdate = true; return o; };
    this.root = O();
    this.bones = {};

    const hips = O(); hips.position.set(0, HIP_Y_STAND, 0); this.root.add(hips);
    const torso = O(); torso.position.set(0, 0.16, 0); hips.add(torso);
    const head = O(); head.position.set(0, HEAD_Y_STAND, 0); torso.add(head);

    const upperArmL = O(); upperArmL.position.set(-0.26, 0.42, 0); torso.add(upperArmL);
    const foreArmL = O(); foreArmL.position.set(0, -0.28, 0); upperArmL.add(foreArmL);
    const upperArmR = O(); upperArmR.position.set(0.26, 0.42, 0); torso.add(upperArmR);
    const foreArmR = O(); foreArmR.position.set(0, -0.28, 0); upperArmR.add(foreArmR);

    const thighL = O(); thighL.position.set(-0.11, -0.06, 0); hips.add(thighL);
    const shinL = O(); shinL.position.set(0, -0.40, 0); thighL.add(shinL);
    const thighR = O(); thighR.position.set(0.11, -0.06, 0); hips.add(thighR);
    const shinR = O(); shinR.position.set(0, -0.40, 0); thighR.add(shinR);

    const weapon = O(); torso.add(weapon);

    Object.assign(this.bones, {
      hips, torso, head, upperArmL, foreArmL, upperArmR, foreArmR,
      thighL, shinL, thighR, shinR, weapon,
    });
    this._boneList = BONES.map((n) => this.bones[n]);

    // --- animation state
    // NOTE: no game.rng draws in this constructor. Models are built lazily and
    // reused across matches, so a constructor-time draw makes the RNG consumer
    // count depend on match history and the same seed stops reproducing a match.
    // Per-life randomisation lives in respawn(), which runs every time.
    this.legYaw = 0;
    this.gait = 0;
    this.speedSmooth = 0;
    this.aimBlend = 0;
    this.crouchBlend = 0;
    this.reloadBlend = 0;
    this.sprintBlend = 0;
    this.airBlend = 0;
    this.landDip = 0;
    this.breath = 0;
    this._wasGrounded = true;
    this._peakFall = 0;
    this.flinch = 0;
    this.flinchDir = 0;
    this.deathT = 0;
    this._deathAxis = new THREE.Vector3(1, 0, 0);
    this._qTip = new THREE.Quaternion();
    this._qYaw = new THREE.Quaternion();
    this._wasAlive = true;
    this._limpSeed = 0.5;
  }

  setVisible(v) {
    v = !!v;
    if (v === this.visible) return;
    this.visible = v;
    if (!v && this.slot >= 0 && RIG.meshes[this.team]) {
      const meshes = RIG.meshes[this.team];
      for (let i = 0; i < BONE_COUNT; i++) {
        meshes[i].setMatrixAt(this.slot, _zeroMatrix);
        meshes[i].instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** Reset pose bookkeeping when the bot respawns. */
  respawn(yaw = 0) {
    // Per-life randomisation: gait phase so a squad's legs are out of step, and
    // the limp seed that gives each ragdoll its own sprawl.
    const rng = this._rng;
    this.gait = rng() * Math.PI * 2;
    this._limpSeed = rng();
    this.breath = rng() * Math.PI * 2;   // desynced chests across a squad
    this.legYaw = yaw;
    this.sprintBlend = 0;
    this.airBlend = 0;
    this.landDip = 0;
    this._wasGrounded = true;
    this._peakFall = 0;
    this.deathT = 0;
    this.flinch = 0;
    this.reloadBlend = 0;
    this.aimBlend = 0;
    this.speedSmooth = 0;
    this._wasAlive = true;
    this.root.rotation.set(0, yaw, 0);
    this.setVisible(true);
  }

  /** Register a hit so the torso flinches. `dirWorld` is the incoming direction. */
  hitReaction(strength = 1, dirYaw = 0) {
    this.flinch = Math.min(1, this.flinch + strength);
    this.flinchDir = dirYaw;
  }

  /**
   * @param {number} dt real frame delta
   * @param {object} bot the Bot instance — reads position/yaw/pitch/velocity/
   *   height/alive plus the optional `bot.anim` block { aim, reload, crouch,
   *   deathYaw }.
   */
  update(dt, bot) {
    if (this.disposed || !this.visible || this.slot < 0) return;
    if (dt > 0.1) dt = 0.1;

    const anim = bot.anim || null;
    const alive = bot.alive !== false;
    const vx = bot.velocity ? bot.velocity.x : 0;
    const vz = bot.velocity ? bot.velocity.z : 0;
    const speed = Math.hypot(vx, vz);

    if (alive) {
      this._wasAlive = true;
      this._poseAlive(dt, bot, anim, speed, vx, vz);
    } else {
      if (this._wasAlive) {
        this._wasAlive = false;
        this.deathT = 0;
        // `deathYaw` is the yaw the killing blow pushed the body toward. The
        // body tips about the horizontal axis perpendicular to it, pivoting on
        // the feet — a 90° rotation lands it flat on the ground.
        const dirYaw = anim && typeof anim.deathYaw === 'number' ? anim.deathYaw : bot.yaw;
        const px = -Math.sin(dirYaw), pz = -Math.cos(dirYaw);
        this._deathAxis.set(pz, 0, -px).normalize();
      }
      this._poseDead(dt);
    }

    this.root.position.copy(bot.position);
    // No `force`. Every node in this rig has matrixAutoUpdate on, and updateMatrix()
    // unconditionally raises matrixWorldNeedsUpdate, so the dirty flag is already true
    // for all 13 nodes — forcing it only defeats three's skip without changing a result.
    this.root.updateMatrixWorld();
    this._blit();
  }

  _poseAlive(dt, bot, anim, speed, vx, vz) {
    const bones = this.bones;

    // ---- facing: legs follow motion, torso twists to the aim within ±60°
    const aimYaw = bot.yaw || 0;
    let desiredLeg = this.legYaw;
    if (speed > 0.7) desiredLeg = Math.atan2(-vx, -vz);
    let twist = angleDelta(desiredLeg, aimYaw);
    if (Math.abs(twist) > MAX_TWIST) desiredLeg = aimYaw - Math.sign(twist) * MAX_TWIST;
    const turnRate = (speed > 0.7 ? 9 : 5.5) * dt;
    this.legYaw = moveAngleTowards(this.legYaw, desiredLeg, turnRate);
    twist = clamp(angleDelta(this.legYaw, aimYaw), -MAX_TWIST, MAX_TWIST);
    this.root.rotation.set(0, this.legYaw, 0);

    // ---- blends
    const height = typeof bot.height === 'number' ? bot.height : 1.8;
    const crouchTarget = clamp((1.8 - height) / 0.7, 0, 1);
    this.crouchBlend = damp(this.crouchBlend, crouchTarget, 12, dt);
    this.aimBlend = damp(this.aimBlend, anim ? clamp(anim.aim || 0, 0, 1) : 0, 9, dt);
    this.reloadBlend = damp(this.reloadBlend, anim ? clamp(anim.reload || 0, 0, 1) : 0, 14, dt);
    this.flinch = Math.max(0, this.flinch - dt * 3.4);
    this.speedSmooth = damp(this.speedSmooth, speed, 10, dt);

    // Grounded / vertical state. Bots carry `grounded` and a real vy; avatars derive
    // both from the interpolated position stream. Undefined means "assume grounded"
    // so a caller that predates these fields keeps the old behaviour.
    const grounded = bot.grounded !== false;
    const vy = bot.velocity ? (bot.velocity.y || 0) : 0;
    // The instantaneous vy at the grounded transition is useless for the landing dip:
    // bots zero velocity.y in the same physics tick they become grounded, and avatars
    // derive vy from a position stream that has already stopped moving. So the hardest
    // downward speed is banked while airborne and spent on the transition instead.
    if (!grounded) this._peakFall = Math.max(this._peakFall, -vy);
    if (grounded && !this._wasGrounded) {
      // Landing dip, scaled by how hard the fall was. Fold onto whatever is left of
      // the previous dip rather than resetting, so a quick double-hop still reads.
      this.landDip = clamp(Math.max(this.landDip, this._peakFall / 9), 0, 1);
      this._peakFall = 0;
    }
    this._wasGrounded = grounded;
    this.landDip = Math.max(0, this.landDip - dt * 3.2);
    this.airBlend = damp(this.airBlend, grounded ? 0 : 1, 12, dt);

    // Sprint reads off the mover's own flag (bots: moveMode, avatars: anim.sprint)
    // gated on actually moving; shouldering the weapon always wins over the sprint
    // carry, exactly as the movement code stops sprinting when firing starts.
    const sprinting = (bot.moveMode === 'sprint' || !!(anim && anim.sprint))
      && speed > 2.0 && grounded;
    this.sprintBlend = damp(this.sprintBlend, sprinting ? 1 : 0, 8, dt);

    const cr = this.crouchBlend;
    const aim = this.aimBlend;
    const sp = this.speedSmooth;
    const air = this.airBlend;
    const spr = this.sprintBlend * (1 - aim);
    const dip = this.landDip * this.landDip;   // ease the tail of the recovery

    // ---- idle breathing: only surfaces once the gait and the fall are out of the way
    this.breath += dt * 1.9;
    if (this.breath > Math.PI * 200) this.breath -= Math.PI * 200;

    // ---- gait: sprint lengthens the stride instead of just spinning it faster
    const strideLen = lerp(1.55, 2.55, clamp(sp / 6.5, 0, 1)) * lerp(1, 0.86, spr);
    this.gait += sp * strideLen * dt * (1 - air * 0.85);
    if (this.gait > Math.PI * 200) this.gait -= Math.PI * 200;
    const gaitAmp = clamp(sp / 5.0, 0, 1) * (1 - air);
    const s = Math.sin(this.gait);
    const s2 = Math.sin(this.gait * 2);
    const breathAmp = (1 - gaitAmp) * (1 - air) * (1 - this.flinch);
    const br = Math.sin(this.breath) * breathAmp;

    // ---- hips
    bones.hips.position.y = lerp(HIP_Y_STAND, HIP_Y_CROUCH, cr)
      + s2 * lerp(0.032, 0.05, spr) * gaitAmp
      - dip * 0.16 + air * 0.06;
    bones.hips.rotation.set(
      lerp(0, 0.28, cr) + gaitAmp * lerp(0.05, 0.14, spr) + dip * 0.10,
      0,
      s * lerp(0.045, 0.07, spr) * gaitAmp,
    );

    // ---- torso: twist + aim pitch + sprint lean + bob + breath + flinch
    const pitch = bot.pitch || 0;
    bones.torso.rotation.y = twist;
    bones.torso.rotation.x = -pitch * 0.42 * aim + lerp(0.06, 0.30, cr)
      + gaitAmp * 0.10 + spr * 0.22 + air * 0.10 + dip * 0.18
      + br * 0.022 - this.flinch * 0.22;
    bones.torso.rotation.z = -s * lerp(0.05, 0.08, spr) * gaitAmp
      + this.flinch * 0.09 * Math.sin(this.flinchDir);

    // ---- head: remaining pitch (counter the sprint lean so the eyes stay level)
    bones.head.position.y = lerp(HEAD_Y_STAND, HEAD_Y_CROUCH, cr);
    bones.head.rotation.x = -pitch * lerp(0.88, 0.55, aim) - spr * 0.18
      - br * 0.015 - this.flinch * 0.25;
    bones.head.rotation.y = 0;
    bones.head.rotation.z = 0;

    // ---- legs
    const kneeIdle = lerp(0.12, 0.95, cr) + dip * 0.85;
    const thighIdle = lerp(-0.04, -0.62, cr) - dip * 0.35;
    const swingAmp = lerp(0.72, 0.98, spr) * gaitAmp;
    const swing = s * swingAmp;
    const swingOff = Math.sin(this.gait + Math.PI) * swingAmp;
    // In the air the legs split into a trail pose — lead leg reaches, rear leg tucks.
    const airLead = air * -0.55, airTrail = air * 0.35;
    const airKnee = air * 0.75;
    bones.thighL.rotation.set(thighIdle + swing + airLead, 0, lerp(0, -0.18, cr));
    bones.thighR.rotation.set(thighIdle + swingOff + airTrail, 0, lerp(0, 0.18, cr));
    bones.shinL.rotation.x = -(kneeIdle + airKnee * 0.5
      + Math.max(0, -Math.sin(this.gait - 0.9)) * lerp(1.05, 1.35, spr) * gaitAmp);
    bones.shinR.rotation.x = -(kneeIdle + airKnee
      + Math.max(0, -Math.sin(this.gait + Math.PI - 0.9)) * lerp(1.05, 1.35, spr) * gaitAmp);

    // ---- arms: blend relaxed carry -> shouldered aim, with the sprint pump and the
    //      reload layered on top
    const rl = this.reloadBlend;
    const rlWave = Math.sin(rl * Math.PI);

    // right arm keeps the grip in every pose; sprinting pumps it with the stride
    const ruX = lerp(-0.35 - swingOff * 0.55, -0.62, aim)
      + spr * (0.10 - swingOff * 0.45) + air * -0.25 + br * 0.02;
    const ruZ = lerp(0.10, 0.34, aim) + spr * 0.06 + air * 0.20;
    bones.upperArmR.rotation.set(ruX, 0, ruZ);
    bones.foreArmR.rotation.set(lerp(-0.75, -1.32, aim) - spr * 0.35 - air * 0.20, 0, 0);

    // left arm supports the handguard, and drops to the magwell on reload
    const luX = lerp(-0.35 - swing * 0.55, -0.95, aim)
      + spr * (0.10 - swing * 0.45) + air * -0.25 + br * 0.02;
    const luZ = lerp(-0.10, -0.55, aim) - spr * 0.06 - air * 0.20;
    bones.upperArmL.rotation.set(luX + rlWave * 0.55, rlWave * 0.35, luZ + rlWave * 0.30);
    bones.foreArmL.rotation.set(lerp(-0.75, -1.15, aim) - spr * 0.30 - rlWave * 0.85, 0, 0);

    // ---- weapon: shouldered vs slung-low vs the sprint carry (muzzle down and
    //      across the chest), plus the reload tilt. Outside ADS the muzzle still
    //      tracks a fraction of the aim pitch so hip fire points where it shoots.
    const wx = lerp(0.20, 0.055, aim) - spr * 0.04;
    const wy = lerp(0.24, 0.40, aim) - cr * 0.04 - spr * 0.10;
    const wz = lerp(-0.10, -0.26, aim) + spr * 0.06;
    bones.weapon.position.set(wx, wy, wz - rlWave * 0.05);
    bones.weapon.rotation.set(
      lerp(0.55, 0, aim) + spr * 0.45 - pitch * lerp(0.22, 0.55, aim) * (1 - spr)
        + rlWave * 0.30 + s2 * 0.03 * gaitAmp,
      lerp(-0.32, 0, aim) - spr * 0.35 + rlWave * 0.22,
      lerp(0.25, 0, aim) + spr * 0.15 - rlWave * 0.45,
    );
  }

  _poseDead(dt) {
    const bones = this.bones;
    const t = this.deathT = Math.min(1, this.deathT + dt / DEATH_DURATION);
    // Ease-in for the tip-over, so the body accelerates like it lost its legs.
    const e = t * t * (3 - 2 * t);
    const settle = t * t;

    this._qYaw.setFromAxisAngle(_upAxis, this.legYaw);
    this._qTip.setFromAxisAngle(this._deathAxis, e * 1.52);
    this.root.quaternion.copy(this._qTip).multiply(this._qYaw);

    const limp = 1 - Math.exp(-t * 4.5);
    const r = this._limpSeed;
    bones.hips.position.y = lerp(HIP_Y_STAND, 0.42, settle);
    bones.hips.rotation.set(lerp(0, 0.25, limp), 0, lerp(0, (r - 0.5) * 0.5, limp));
    bones.torso.rotation.set(lerp(0, -0.35, limp), lerp(0, (r - 0.5) * 0.7, limp), 0);
    bones.head.rotation.set(lerp(0, 0.55, limp), lerp(0, (0.5 - r) * 0.9, limp), 0);
    bones.head.position.y = HEAD_Y_STAND;

    bones.upperArmL.rotation.set(lerp(0, 0.9 + r * 0.6, limp), 0, lerp(0, -0.7, limp));
    bones.upperArmR.rotation.set(lerp(0, 0.7 + (1 - r) * 0.7, limp), 0, lerp(0, 0.75, limp));
    bones.foreArmL.rotation.set(lerp(0, -0.45, limp), 0, 0);
    bones.foreArmR.rotation.set(lerp(0, -0.60, limp), 0, 0);

    bones.thighL.rotation.set(lerp(0, -0.55 - r * 0.4, limp), 0, lerp(0, -0.30, limp));
    bones.thighR.rotation.set(lerp(0, -0.30 - (1 - r) * 0.4, limp), 0, lerp(0, 0.34, limp));
    bones.shinL.rotation.x = lerp(0, -0.95, limp);
    bones.shinR.rotation.x = lerp(0, -0.70, limp);

    // Rifle slips out of the hands and lands beside the body.
    bones.weapon.position.set(lerp(0.20, 0.34, settle), lerp(0.24, -0.20, settle), lerp(-0.10, 0.12, settle));
    bones.weapon.rotation.set(lerp(0.55, 1.5, settle), lerp(-0.32, 0.9, settle), 0);

    this.aimBlend = 0;
    this.reloadBlend = 0;
  }

  /**
   * Copy this bot's 12 bone matrices into the shared instance buffers, and fold its
   * extent into the team's culling sphere.
   *
   * Two things are hoisted to once-per-team-per-frame rather than once per bone per bot:
   *
   *  - `instanceMatrix.needsUpdate`. It used to be set inside this loop, i.e. 12xN times
   *    a frame on 12 attributes that only need it once each. The setter only bumps the
   *    attribute's version; WebGLAttributes reads the array at render time. So raising it
   *    on the FIRST bot of the frame still publishes every later bot's writes, and no
   *    frame of latency is introduced.
   *  - the bounding-sphere accumulator reset. Every bot then unions itself in, so by the
   *    time the frame renders the sphere covers exactly the bots that blitted — no stale
   *    frame, no respawn pop.
   */
  _blit() {
    const team = this.team;
    const meshes = RIG.meshes[team];
    if (!meshes) return;
    const slot = this.slot;
    const list = this._boneList;
    const sphere = RIG.sphere[team];

    const stamp = this.game.frame;
    if (RIG.stamp[team] !== stamp || stamp === undefined) {
      RIG.stamp[team] = stamp;
      for (let i = 0; i < BONE_COUNT; i++) meshes[i].instanceMatrix.needsUpdate = true;
      if (sphere) sphere.radius = -1;      // empty; the unions below refill it
    }

    // Bone ORIGINS give the AABB; RIG.reach then covers the geometry hanging off each of
    // them. That is pose-independent, so it stays correct through the crouch, the twist
    // and the whole death tip-over without special-casing any of them.
    let minx = Infinity, miny = Infinity, minz = Infinity;
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = 0; i < BONE_COUNT; i++) {
      const m = list[i].matrixWorld;
      meshes[i].setMatrixAt(slot, m);
      const e = m.elements;
      const x = e[12], y = e[13], z = e[14];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }

    if (sphere) {
      const hx = (maxx - minx) * 0.5, hy = (maxy - miny) * 0.5, hz = (maxz - minz) * 0.5;
      unionSphere(sphere, minx + hx, miny + hy, minz + hz,
        Math.sqrt(hx * hx + hy * hy + hz * hz) + RIG.reach[team]);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    releaseSlot(this.team, this.slot, this);
    this.slot = -1;
    RIG.live = Math.max(0, RIG.live - 1);
    if (RIG.live === 0) disposeBotRigs();
  }
}

export default BotModel;
