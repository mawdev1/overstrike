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

/**
 * Cloth/gear textures live in one ATLAS per team (three columns x two rows of one
 * shared CanvasTexture), so every bone mesh keeps a single material and the
 * 12-meshes-x-2-teams = 24 draw-call structure is untouched — the atlas swaps flat
 * colour for texture detail without adding a single call. The camo cell differs per
 * team (camo_alpha vs camo_bravo); the rest are shared imagery.
 *
 * Cell key -> [column, row]. Row 0 is the TOP half of the canvas (v in [0.5, 1] with
 * the default flipY), row 1 the bottom (v in [0, 0.5]). 'flat' is a white cell for
 * parts that stay pure vertex colour (skin, visor, gun metal, accent patches).
 */
const ATLAS_CELLS = {
  camo: [0, 0], gear: [1, 0], helmet: [2, 0],
  boot: [0, 1], glove: [1, 1], flat: [2, 1],
};
/** World metres covered by one full atlas cell of texture. */
const ATLAS_TILE_M = 0.9;
/** UV inset per cell edge so mip bleeding across cells stays off the body. */
const ATLAS_INSET = 0.03;

/** Deterministic 0..1 hash so identical boxes on both teams crop the atlas alike. */
function uvHash(x, y, z, f) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + f * 4.581) * 43758.5453;
  return s - Math.floor(s);
}

/** Appends axis-aligned boxes with baked vertex colours + atlas UVs into flat arrays. */
class BoxBuilder {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.uv = []; }

  /**
   * @param {number} hex  vertex colour; with a textured cell this multiplies the
   *   texel, so it doubles as the part's tint.
   * @param {string} [tex] atlas cell name; omitted = the flat white cell.
   */
  box(cx, cy, cz, sx, sy, sz, hex, tex) {
    // setHex() already converts from sRGB into the renderer's working space
    // when ColorManagement is enabled (three >= r152), so no manual convert.
    _c.setHex(hex);
    const r = _c.r, g = _c.g, b = _c.b;
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const x0 = cx - hx, x1 = cx + hx;
    const y0 = cy - hy, y1 = cy + hy;
    const z0 = cz - hz, z1 = cz + hz;
    const cell = ATLAS_CELLS[tex] || ATLAS_CELLS.flat;
    // Per-face UV rect inside the cell: sized by the face's world extent (so texel
    // density matches across parts), anchored by a hashed offset for variety. Faces
    // never wrap — every face here is far smaller than ATLAS_TILE_M.
    const uvr = (w, h, f) => {
      const cu = cell[0] / 3, cv = cell[1] === 0 ? 0.5 : 0.0;
      const span = Math.max(0.0001, 1 - 2 * ATLAS_INSET);
      const fw = Math.min(w / ATLAS_TILE_M, span), fh = Math.min(h / ATLAS_TILE_M, span);
      const ju = uvHash(cx, cy, cz, f) * (span - fw);
      const jv = uvHash(cy, cz, cx, f + 7) * (span - fh);
      const u0 = cu + (ATLAS_INSET + ju) / 3, v0 = cv + (ATLAS_INSET + jv) / 2;
      return [u0, v0, u0 + fw / 3, v0 + fh / 2];
    };
    // 6 faces, CCW when viewed from outside.
    this._quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, r, g, b, uvr(sx, sy, 0));   // +Z
    this._quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, r, g, b, uvr(sx, sy, 1));  // -Z
    this._quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, r, g, b, uvr(sz, sy, 2));   // +X
    this._quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, r, g, b, uvr(sz, sy, 3));  // -X
    this._quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 0, 1, 0, r, g, b, uvr(sx, sz, 4));   // +Y
    this._quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0, -1, 0, r, g, b, uvr(sx, sz, 5));  // -Y
    return this;
  }

  _quad(ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx, dy, dz, nx, ny, nz, r, g, b, uvq) {
    const p = this.pos, n = this.nrm, c = this.col, t = this.uv;
    p.push(ax, ay, az, bx, by, bz, cx2, cy2, cz2);
    p.push(ax, ay, az, cx2, cy2, cz2, dx, dy, dz);
    for (let i = 0; i < 6; i++) { n.push(nx, ny, nz); c.push(r, g, b); }
    const [u0, v0, u1, v1] = uvq;
    // Corner order matches the quad's a,b,c,d winding above.
    t.push(u0, v0, u1, v0, u1, v1);
    t.push(u0, v0, u1, v1, u0, v1);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Brighten `hex` by 1/luma of the texture that will multiply it, so a textured part
 * keeps roughly the VALUE the flat palette was designed around (the near-black
 * carrier inside light fatigues must survive the texturing — see the palette note).
 */
function lift(hex, k) {
  _c.setHex(hex);
  const r = Math.min(255, Math.round(_c.r * 255 * k));
  const g = Math.min(255, Math.round(_c.g * 255 * k));
  const b = Math.min(255, Math.round(_c.b * 255 * k));
  return (r << 16) | (g << 8) | b;
}
// Approximate average luma of each atlas cell's imagery, measured off the sources.
const LIFT_GEAR = 1.35;     // vest_webbing.jpg is a bright khaki weave (~0.74)
const LIFT_HELMET = 1.7;    // helmet_cover.jpg fabric crop (~0.59)
const LIFT_BOOT = 2.1;      // boots_leather.jpg interior (~0.48)
const LIFT_GLOVE = 2.1;     // gloves_fabric.jpg (~0.47)
// Camo tints are neutral greys: the camo imagery itself carries the team hue.
const CAMO_TINT = 0xf0f0f0;
const CAMO_TINT_DARK = 0xbdbdbd;

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
    .box(0, -0.04, 0, 0.34, 0.22, 0.24, CAMO_TINT, 'camo')
    .box(0, 0.075, 0, 0.38, 0.09, 0.28, lift(p.webbing, LIFT_GEAR), 'gear')
    .box(-0.20, -0.06, 0.03, 0.11, 0.16, 0.13, lift(p.webbing, LIFT_GEAR), 'gear')
    .box(0.20, -0.08, -0.01, 0.10, 0.17, 0.11, p.gun)
    .build();

  // ---- torso: abdomen, chest, four-sided plate carrier, mag pouches, pack,
  //      shoulder yoke, neck, chest accent (13)
  const vestT = lift(p.vest, LIFT_GEAR), webT = lift(p.webbing, LIFT_GEAR);
  out.torso = new BoxBuilder()
    .box(0, 0.10, 0, 0.33, 0.24, 0.23, CAMO_TINT, 'camo')
    .box(0, 0.35, 0, 0.44, 0.32, 0.25, CAMO_TINT, 'camo')
    // plate carrier — proud of the chest so it casts its own edge
    .box(0, 0.33, -0.155, 0.38, 0.40, 0.075, vestT, 'gear')
    .box(0, 0.33, 0.155, 0.38, 0.40, 0.075, vestT, 'gear')
    .box(0.215, 0.33, 0, 0.06, 0.36, 0.24, vestT, 'gear')
    .box(-0.215, 0.33, 0, 0.06, 0.36, 0.24, vestT, 'gear')
    // three mag pouches read as one horizontal band across the belly
    .box(-0.115, 0.19, -0.205, 0.105, 0.16, 0.10, webT, 'gear')
    .box(0.005, 0.19, -0.205, 0.105, 0.16, 0.10, webT, 'gear')
    .box(0.125, 0.19, -0.205, 0.105, 0.16, 0.10, webT, 'gear')
    // rear pack, in team colour — the back view needs an ID too
    .box(0, 0.31, 0.235, 0.30, 0.28, 0.10, p.accent)
    // shoulder yoke squares off the top of the silhouette
    .box(0, 0.47, 0, 0.48, 0.09, 0.23, vestT, 'gear')
    .box(0, 0.51, 0, 0.13, 0.09, 0.13, p.skin)
    // chest stripe
    .box(0, 0.455, -0.16, 0.32, 0.07, 0.075, p.accent)
    .build();

  // ---- head: skull, helmet dome + overhanging rim, visor, NVG mount, team
  //      band, nape pad (7). Everything stays within the head hitbox.
  out.head = new BoxBuilder()
    .box(0, -0.01, 0.01, 0.20, 0.22, 0.21, p.skin)
    .box(0, 0.055, 0, 0.275, 0.155, 0.285, lift(p.helmet, LIFT_HELMET), 'helmet')
    .box(0, -0.03, 0, 0.29, 0.055, 0.30, lift(p.helmet, LIFT_HELMET), 'helmet')
    .box(0, -0.005, -0.125, 0.215, 0.075, 0.055, p.visor)
    .box(0, 0.075, -0.155, 0.055, 0.055, 0.06, p.gun)
    .box(0, 0.132, 0, 0.245, 0.035, 0.255, p.accent)
    .box(0, -0.08, 0.095, 0.19, 0.09, 0.09, lift(p.webbing, LIFT_GEAR), 'gear')
    .build();

  // ---- arms: sleeve + a big accent shoulder cap (2 each)
  const upperArm = () => new BoxBuilder()
    .box(0, -0.15, 0, 0.115, 0.30, 0.125, CAMO_TINT, 'camo')
    .box(0, -0.02, 0, 0.15, 0.11, 0.16, p.accent)
    .build();
  const foreArm = () => new BoxBuilder()
    .box(0, -0.13, 0, 0.10, 0.26, 0.10, CAMO_TINT_DARK, 'camo')
    // elbow pad caps the joint so the bend reads as a bend, not a gap
    .box(0, -0.005, -0.005, 0.105, 0.09, 0.115, lift(p.webbing, LIFT_GEAR), 'gear')
    // hand — gloves_fabric, tinted down toward the palette's dark leather
    .box(0, -0.29, 0, 0.095, 0.11, 0.115, lift(p.boot, LIFT_GLOVE), 'glove')
    .build();
  out.upperArmL = upperArm();
  out.upperArmR = upperArm();
  out.foreArmL = foreArm();
  out.foreArmR = foreArm();

  // ---- legs: thigh, shin, and a boot that flares at the sole so the figure
  //      plants on the ground instead of tapering into it (1 + 2 each)
  const thigh = () => new BoxBuilder()
    .box(0, -0.20, 0, 0.15, 0.40, 0.17, CAMO_TINT, 'camo')
    .build();
  const shin = () => new BoxBuilder()
    .box(0, -0.18, 0, 0.125, 0.36, 0.145, CAMO_TINT_DARK, 'camo')
    // knee pad — sits proud of the shin's front face and caps the hinge
    .box(0, -0.035, -0.075, 0.13, 0.13, 0.06, lift(p.webbing, LIFT_GEAR), 'gear')
    .box(0, -0.40, -0.03, 0.14, 0.10, 0.26, lift(p.boot, LIFT_BOOT), 'boot')
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
  material: [null, null],
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

// ------------------------------------------------------- texture atlas loading

const ATLAS_DIR = '/textures/character/';
/**
 * Source crops: helmet_cover.jpg is a photographed helmet (not a tile) and
 * boots_leather.jpg has a stitched border, so only their usable fabric/leather
 * regions are drawn into the atlas. Everything else is a full seamless tile.
 */
const ATLAS_SOURCES = {
  gear: { file: 'vest_webbing.jpg', crop: [0, 0, 1024, 1024] },
  helmet: { file: 'helmet_cover.jpg', crop: [260, 130, 440, 440] },
  boot: { file: 'boots_leather.jpg', crop: [120, 120, 700, 700] },
  glove: { file: 'gloves_fabric.jpg', crop: [100, 100, 824, 824] },
};
const ATLAS_CAMO = ['camo_alpha.jpg', 'camo_bravo.jpg'];
const ATLAS_CELL_PX = 512;

const ATLAS_STATE = { started: false, tex: [null, null] };

/** Compose one 1536x1024 canvas atlas for `team` from the loaded images. */
function composeAtlas(team, images) {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_CELL_PX * 3;
  canvas.height = ATLAS_CELL_PX * 2;
  const ctx = canvas.getContext('2d');
  const drawCell = (name, img, crop) => {
    const [col, row] = ATLAS_CELLS[name];
    ctx.drawImage(img, crop[0], crop[1], crop[2], crop[3],
      col * ATLAS_CELL_PX, row * ATLAS_CELL_PX, ATLAS_CELL_PX, ATLAS_CELL_PX);
  };
  drawCell('camo', images[ATLAS_CAMO[team]], [0, 0, 1024, 1024]);
  for (const [name, src] of Object.entries(ATLAS_SOURCES)) {
    drawCell(name, images[src.file], src.crop);
  }
  ctx.fillStyle = '#ffffff';
  const [fc, fr] = ATLAS_CELLS.flat;
  ctx.fillRect(fc * ATLAS_CELL_PX, fr * ATLAS_CELL_PX, ATLAS_CELL_PX, ATLAS_CELL_PX);

  // DESATURATE THE CLOTH. The two team palettes are built to be told apart instantly —
  // desert tan + amber against urban slate + red — and the material multiplies this atlas
  // by that vertex tint. Both generated camo sources are *desert* camo, so team 1's slate
  // tint multiplied by sandy imagery came out tan, and a player reported the enemy team
  // looking identical to their own. In a shooter that is not a cosmetic bug.
  //
  // Stripping the atlas's own hue keeps every thread of pattern and wear while handing hue
  // back to the tint, which is the thing that carries team identity. Luma-preserving so the
  // value structure (near-black carrier inside light fatigues) survives intact.
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  ctx.putImageData(px, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** Push any composed atlases onto any existing materials (either may arrive first). */
function applyAtlases() {
  for (let t = 0; t < 2; t++) {
    const m = RIG.material[t];
    const tex = ATLAS_STATE.tex[t];
    if (m && tex && m.map !== tex) { m.map = tex; m.needsUpdate = true; }
  }
}

/**
 * Kick off the one-time async load of the character textures. Fire-and-forget:
 * until the atlases land the rigs render their vertex-colour tints, which are the
 * old readability palette, so a slow network never shows an untinted soldier.
 * No-ops headless (a server import of this module must not touch the DOM).
 */
function ensureAtlases() {
  if (ATLAS_STATE.started || typeof document === 'undefined') return;
  ATLAS_STATE.started = true;
  const files = [...new Set([...ATLAS_CAMO, ...Object.values(ATLAS_SOURCES).map((s) => s.file)])];
  const loader = new THREE.ImageLoader();
  const images = {};
  let left = files.length;
  for (const f of files) {
    loader.load(ATLAS_DIR + f, (img) => {
      images[f] = img;
      if (--left === 0) {
        for (let t = 0; t < 2; t++) {
          ATLAS_STATE.tex[t] = composeAtlas(t, images);
          assets.textures.set(`botAtlas${t}`, ATLAS_STATE.tex[t]);
        }
        applyAtlases();
      }
    }, undefined, () => {
      // A missing texture leaves the flat palette in place — degraded, not broken.
      console.warn(`[botModel] character texture failed to load: ${f}`);
    });
  }
}

function rigMaterial(team) {
  if (RIG.material[team]) return RIG.material[team];
  // Registered in the shared assets cache so nothing here is per-object and
  // assets.dispose() sweeps it up with everything else.
  const key = `botBody${team}`;
  let m = assets.materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.86, metalness: 0.06,
    });
    m.userData.surface = 'flesh';
    assets.materials.set(key, m);
  }
  RIG.material[team] = m;
  ensureAtlases();
  applyAtlases();
  return m;
}

function ensureTeam(game, team) {
  if (RIG.meshes[team]) return;
  const geos = buildBoneGeometries(PALETTES[team] || PALETTES[0]);
  const mat = rigMaterial(team);
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
  RIG.material = [null, null];
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

    // SIGN CONVENTION for everything below: the rig faces LOCAL -Z (visor and muzzle
    // both sit at negative z), so a positive rotation.x tips the top of a bone toward
    // +Z — i.e. it leans torso/head BACKWARD, and it swings a limb that hangs in -Y
    // FORWARD. The pose terms here were once authored with the opposite assumption,
    // which mirrored the whole upper body: arms raised behind the shoulders, crouch
    // leaning backward, muzzle dipping when the aim pitched up. Phase-relative gait
    // terms (arm counter-swing vs the same-side leg) are convention-independent and
    // keep their literal signs.

    // ---- hips: forward tilt into the crouch, the run and the landing dip
    bones.hips.position.y = lerp(HIP_Y_STAND, HIP_Y_CROUCH, cr)
      + s2 * lerp(0.032, 0.05, spr) * gaitAmp
      - dip * 0.16 + air * 0.06;
    bones.hips.rotation.set(
      -(lerp(0, 0.28, cr) + gaitAmp * lerp(0.05, 0.14, spr) + dip * 0.10),
      0,
      s * lerp(0.045, 0.07, spr) * gaitAmp,
    );

    // ---- torso: twist + aim pitch (up-aim leans it back) + forward sprint/crouch
    //      lean + bob + breath + a backward flinch snap
    const pitch = bot.pitch || 0;
    bones.torso.rotation.y = twist;
    bones.torso.rotation.x = pitch * 0.42 * aim - lerp(0.06, 0.30, cr)
      - gaitAmp * 0.10 - spr * 0.22 - air * 0.10 - dip * 0.18
      - br * 0.022 + this.flinch * 0.22;
    bones.torso.rotation.z = -s * lerp(0.05, 0.08, spr) * gaitAmp
      + this.flinch * 0.09 * Math.sin(this.flinchDir);

    // ---- head: remaining pitch (counter the sprint lean so the eyes stay level)
    bones.head.position.y = lerp(HEAD_Y_STAND, HEAD_Y_CROUCH, cr);
    bones.head.rotation.x = pitch * lerp(0.88, 0.55, aim) + spr * 0.18
      + br * 0.015 + this.flinch * 0.25;
    bones.head.rotation.y = 0;
    bones.head.rotation.z = 0;

    // ---- legs
    const kneeIdle = lerp(0.12, 0.95, cr) + dip * 0.85;
    // Crouch drives the thighs FORWARD (positive x) into the squat.
    const thighIdle = lerp(0.04, 0.62, cr) + dip * 0.35;
    const swingAmp = lerp(0.72, 0.98, spr) * gaitAmp;
    const swing = s * swingAmp;
    const swingOff = Math.sin(this.gait + Math.PI) * swingAmp;
    // In the air the legs split into a trail pose — lead leg reaches, rear leg tucks.
    const airLead = air * 0.55, airTrail = air * -0.35;
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

    // right arm keeps the grip in every pose (positive x raises it forward, and the
    // gait term counter-swings it against the right leg); sprinting pumps the stride
    const ruX = lerp(0.35 - swingOff * 0.55, 0.62, aim)
      + spr * (-0.10 - swingOff * 0.45) + air * 0.25 - br * 0.02;
    const ruZ = lerp(0.10, 0.34, aim) + spr * 0.06 + air * 0.20;
    bones.upperArmR.rotation.set(ruX, 0, ruZ);
    // elbows bend forward: the forearm rotates up toward the chest, never past straight
    bones.foreArmR.rotation.set(lerp(0.75, 1.32, aim) + spr * 0.35 + air * 0.20, 0, 0);

    // left arm supports the handguard, and drops to the magwell on reload
    const luX = lerp(0.35 - swing * 0.55, 0.95, aim)
      + spr * (-0.10 - swing * 0.45) + air * 0.25 - br * 0.02;
    const luZ = lerp(-0.10, -0.55, aim) - spr * 0.06 - air * 0.20;
    bones.upperArmL.rotation.set(luX - rlWave * 0.55, rlWave * 0.35, luZ + rlWave * 0.30);
    bones.foreArmL.rotation.set(lerp(0.75, 1.15, aim) + spr * 0.30 + rlWave * 0.85, 0, 0);

    // ---- weapon: shouldered vs slung-low vs the sprint carry (muzzle down and
    //      across the chest), plus the reload tilt. Outside ADS the muzzle still
    //      tracks a fraction of the aim pitch so hip fire points where it shoots.
    const wx = lerp(0.20, 0.055, aim) - spr * 0.04;
    const wy = lerp(0.24, 0.40, aim) - cr * 0.04 - spr * 0.10;
    const wz = lerp(-0.10, -0.26, aim) + spr * 0.06;
    bones.weapon.position.set(wx, wy, wz - rlWave * 0.05);
    bones.weapon.rotation.set(
      // negative x drops the muzzle (it points down -Z): low-ready at rest, further
      // down in the sprint carry, and it RISES with the aim pitch, not against it
      -lerp(0.55, 0, aim) - spr * 0.45 + pitch * lerp(0.22, 0.55, aim) * (1 - spr)
        - rlWave * 0.30 - s2 * 0.03 * gaitAmp,
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
    // Elbows bend forward (positive x) — negative here hyperextended the joint.
    bones.foreArmL.rotation.set(lerp(0, 0.45, limp), 0, 0);
    bones.foreArmR.rotation.set(lerp(0, 0.60, limp), 0, 0);

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
