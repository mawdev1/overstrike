import * as THREE from 'three';
import { createRNG } from '../core/rng.js';

/**
 * OVERSTRIKE — pooled decal system.  ARCHITECTURE §8: cap 256, oldest recycled.
 *
 * Everything lives in **one** `THREE.InstancedMesh` (1 draw call for all 256 decals).
 * The five procedural decal textures from `core/assets.js` ('bulletHole',
 * 'bulletHoleMetal', 'bulletHoleGlass', 'blood', 'scorch') are blitted once at init
 * into a 3x2 atlas canvas; each instance carries a `aUvRect` telling the shader which
 * cell to sample. All source tiles fade to alpha 0 at their borders, so mip bleed
 * between cells is invisible and mipmapping stays on.
 *
 * Per-instance opacity is a proper instanced attribute (not an `onBeforeCompile` hack)
 * driving a hand-written `ShaderMaterial` that also does:
 *   • a cheap half-lambert against the engine sun so decals sit in the lighting,
 *   • exponential-squared fog matching `scene.fog`,
 *   • ACES tone mapping via the standard three chunks (so it matches everything else),
 *   • polygon offset + a normal-space push so it can never z-fight.
 *
 * Slot allocation is a ring buffer — that IS the "recycle oldest" rule, allocation free.
 */

const CAP = 256;
const TILE = 128;
const ATLAS_COLS = 3;
const ATLAS_ROWS = 2;
const LIFE = 35;          // §8 lifetime
const FADE_IN = 0.08;
const FADE_OUT = 4.0;
const PUSH = 0.014;       // metres along the normal

const TILE_HOLE = 0;
const TILE_HOLE_METAL = 1;
const TILE_HOLE_GLASS = 2;
const TILE_BLOOD = 3;
const TILE_SCORCH = 4;

const rnd = createRNG(0xdeca1);

// ---------------------------------------------------------------- scratch
const _m = new THREE.Matrix4();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _b = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _alt = new THREE.Vector3(1, 0, 0);
const _down = new THREE.Vector3(0, -1, 0);
const _origin = new THREE.Vector3();

/** surface (§3) → atlas tile + default size/tint. */
const SURFACE_TILE = {
  concrete: TILE_HOLE,
  wood: TILE_HOLE,
  dirt: TILE_HOLE,
  sand: TILE_HOLE,
  metal: TILE_HOLE_METAL,
  glass: TILE_HOLE_GLASS,
  flesh: TILE_BLOOD,
  blood: TILE_BLOOD,
  scorch: TILE_SCORCH,
};

const DECAL_VERT = /* glsl */`
  attribute vec4 aUvRect;
  attribute float aOpacity;
  attribute vec3 aTint;

  varying vec2 vUv;
  varying float vOpacity;
  varying vec3 vTint;
  varying vec3 vNormal;
  varying float vFogDepth;

  void main() {
    vUv = aUvRect.xy + uv * aUvRect.zw;
    vOpacity = aOpacity;
    vTint = aTint;
    // The mesh itself is identity at the origin, so instanceMatrix is the world matrix.
    vNormal = normalize(mat3(instanceMatrix) * vec3(0.0, 0.0, 1.0));
    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vFogDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

// three's fragment prefix already declares the tonemapping / colorspace helpers.
const DECAL_FRAG = /* glsl */`
  uniform sampler2D uMap;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform vec3 fogColor;
  uniform float fogDensity;
  uniform float fogNear;
  uniform float fogFar;

  varying vec2 vUv;
  varying float vOpacity;
  varying vec3 vTint;
  varying vec3 vNormal;
  varying float vFogDepth;

  void main() {
    vec4 tex = texture2D(uMap, vUv);
    float a = tex.a * vOpacity;
    if (a < 0.005) discard;

    // Half-lambert keeps back-facing decals readable instead of pure black.
    float ndl = dot(normalize(vNormal), uSunDir) * 0.5 + 0.5;
    vec3 light = uAmbient + uSunColor * (ndl * ndl);
    vec3 col = tex.rgb * vTint * light;

    float fd = fogDensity * vFogDepth;
    float fogFactor = 1.0 - exp(-fd * fd);
    col = mix(col, fogColor, fogFactor);

    gl_FragColor = vec4(col, a);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** Upload only `[0, count)`; the range object is retained so marking never allocates. */
function markAll(attr, count) {
  if (count <= 0) return;
  const ranges = attr.updateRanges;
  if (ranges) {
    let r = attr._fxRange;
    if (r === undefined) { r = { start: 0, count: 0 }; attr._fxRange = r; }
    r.start = 0;
    r.count = count;
    ranges.length = 0;
    ranges.push(r);
  } else if (attr.updateRange) {
    attr.updateRange.offset = 0;
    attr.updateRange.count = count;
  }
  attr.needsUpdate = true;
}

export class DecalSystem {
  constructor(game) {
    this.game = game;
    this.mesh = null;
    this._scene = null;

    // Per-slot state (preallocated; the ring head is the "oldest" pointer).
    this.age = new Float32Array(CAP);
    this.life = new Float32Array(CAP);
    this.alive = new Uint8Array(CAP);
    this.maxOpacity = new Float32Array(CAP);
    this._head = 0;
    this._used = 0;   // slots ever touched — bounds mesh.count
  }

  init(scene) {
    if (this.mesh) return;
    const assets = this.game.assets;

    // --- atlas ------------------------------------------------------------
    const cv = document.createElement('canvas');
    cv.width = TILE * ATLAS_COLS;
    cv.height = TILE * ATLAS_ROWS;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    const blit = (name, idx) => {
      const src = assets.tex(name);
      const img = src && src.image;
      if (!img) return;
      const col = idx % ATLAS_COLS;
      const row = (idx / ATLAS_COLS) | 0;
      ctx.drawImage(img, col * TILE, row * TILE, TILE, TILE);
    };
    blit('bulletHole', TILE_HOLE);
    blit('bulletHoleMetal', TILE_HOLE_METAL);
    blit('bulletHoleGlass', TILE_HOLE_GLASS);
    blit('blood', TILE_BLOOD);
    blit('scorch', TILE_SCORCH);

    const atlas = new THREE.CanvasTexture(cv);
    atlas.colorSpace = THREE.SRGBColorSpace;
    atlas.wrapS = atlas.wrapT = THREE.ClampToEdgeWrapping;
    atlas.anisotropy = 8;
    atlas.needsUpdate = true;
    this.atlas = atlas;

    // Half-texel inset so bilinear taps never reach the neighbouring cell.
    const insetU = 0.5 / cv.width;
    const insetV = 0.5 / cv.height;
    this._uvRects = new Float32Array(ATLAS_COLS * ATLAS_ROWS * 4);
    for (let i = 0; i < ATLAS_COLS * ATLAS_ROWS; i++) {
      const col = i % ATLAS_COLS;
      const row = (i / ATLAS_COLS) | 0;
      // Canvas rows run top-down, UV runs bottom-up.
      const v0 = 1 - (row + 1) / ATLAS_ROWS;
      this._uvRects[i * 4] = col / ATLAS_COLS + insetU;
      this._uvRects[i * 4 + 1] = v0 + insetV;
      this._uvRects[i * 4 + 2] = 1 / ATLAS_COLS - insetU * 2;
      this._uvRects[i * 4 + 3] = 1 / ATLAS_ROWS - insetV * 2;
    }

    // --- mesh -------------------------------------------------------------
    const geo = new THREE.PlaneGeometry(1, 1);
    this.uvRect = new Float32Array(CAP * 4);
    this.opacity = new Float32Array(CAP);
    this.tint = new Float32Array(CAP * 3);
    this.uvRectAttr = new THREE.InstancedBufferAttribute(this.uvRect, 4).setUsage(THREE.DynamicDrawUsage);
    this.opacityAttr = new THREE.InstancedBufferAttribute(this.opacity, 1).setUsage(THREE.DynamicDrawUsage);
    this.tintAttr = new THREE.InstancedBufferAttribute(this.tint, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aUvRect', this.uvRectAttr);
    geo.setAttribute('aOpacity', this.opacityAttr);
    geo.setAttribute('aTint', this.tintAttr);
    this.geo = geo;

    const sun = this.game.engine?.sun;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: atlas },
        uSunDir: { value: new THREE.Vector3(0.55, 0.72, 0.4).normalize() },
        uSunColor: { value: new THREE.Color(0.72, 0.66, 0.55) },
        uAmbient: { value: new THREE.Color(0.42, 0.46, 0.54) },
        fogColor: { value: new THREE.Color(0x8b98ab) },
        fogDensity: { value: 0.0075 },
        fogNear: { value: 1 },
        fogFar: { value: 400 },
      },
      vertexShader: DECAL_VERT,
      fragmentShader: DECAL_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.FrontSide,
      polygonOffset: true,
      polygonOffsetFactor: -6,
      polygonOffsetUnits: -14,
      fog: true,
    });
    this.mat = mat;
    if (sun) {
      mat.uniforms.uSunDir.value.copy(sun.position).normalize();
      mat.uniforms.uSunColor.value.copy(sun.color).multiplyScalar(Math.min(sun.intensity, 2.4) * 0.32);
    }
    const hemi = this.game.engine?.hemi;
    if (hemi) mat.uniforms.uAmbient.value.copy(hemi.color).multiplyScalar(hemi.intensity * 0.62);

    const mesh = new THREE.InstancedMesh(geo, mat, CAP);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 4;
    mesh.count = 0;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    // Park every slot: zero scale + zero opacity.
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < CAP; i++) mesh.setMatrixAt(i, _m);

    this.mesh = mesh;
    this._scene = scene;
    scene.add(mesh);
  }

  get liveCount() {
    let n = 0;
    for (let i = 0; i < this._used; i++) if (this.alive[i]) n++;
    return n;
  }

  /**
   * §8 `decal(point, normal, surface, size)`.
   * @param {THREE.Vector3} point   world hit point
   * @param {THREE.Vector3} normal  surface normal
   * @param {string} surface        §3 surface name, or 'blood' / 'scorch'
   * @param {number} size           quad width in metres
   */
  add(point, normal, surface, size = 0.16, opacity = 1, life = LIFE) {
    if (!this.mesh) return -1;
    const tile = SURFACE_TILE[surface] !== undefined ? SURFACE_TILE[surface] : TILE_HOLE;
    return this._place(point, normal, tile, size, size, opacity, life, 1, 1, 1);
  }

  /** Blood pool / drip — squashed quad, dark red tint variation. */
  addBlood(point, normal, size, opacity = 1, life = LIFE) {
    if (!this.mesh) return -1;
    const squash = 0.7 + rnd() * 0.6;
    const v = 0.75 + rnd() * 0.45;
    return this._place(point, normal, TILE_BLOOD, size, size * squash, opacity, life, v, v * 0.9, v * 0.9);
  }

  _place(point, normal, tile, sx, sy, opacity, life, tr, tg, tb) {
    const mesh = this.mesh;
    const i = this._head;
    this._head = (this._head + 1) % CAP;
    if (this._used < CAP) this._used = Math.max(this._used, i + 1);

    _n.set(normal.x, normal.y, normal.z);
    if (_n.lengthSq() < 1e-8) _n.set(0, 1, 0);
    _n.normalize();

    const ax = Math.abs(_n.y) > 0.94 ? _alt : _up;
    _t.crossVectors(ax, _n);
    if (_t.lengthSq() < 1e-8) _t.set(1, 0, 0);
    _t.normalize();
    _b.crossVectors(_n, _t).normalize();

    // Random roll about the normal.
    const roll = rnd() * Math.PI * 2;
    const c = Math.cos(roll), s = Math.sin(roll);
    const tx = _t.x * c + _b.x * s, ty = _t.y * c + _b.y * s, tz = _t.z * c + _b.z * s;
    const bx = -_t.x * s + _b.x * c, by = -_t.y * s + _b.y * c, bz = -_t.z * s + _b.z * c;
    _t.set(tx * sx, ty * sx, tz * sx);
    _b.set(bx * sy, by * sy, bz * sy);

    _m.makeBasis(_t, _b, _n);
    _m.setPosition(
      point.x + _n.x * PUSH,
      point.y + _n.y * PUSH,
      point.z + _n.z * PUSH,
    );
    mesh.setMatrixAt(i, _m);

    const i4 = i * 4, i3 = i * 3;
    this.uvRect[i4] = this._uvRects[tile * 4];
    this.uvRect[i4 + 1] = this._uvRects[tile * 4 + 1];
    this.uvRect[i4 + 2] = this._uvRects[tile * 4 + 2];
    this.uvRect[i4 + 3] = this._uvRects[tile * 4 + 3];
    this.tint[i3] = tr; this.tint[i3 + 1] = tg; this.tint[i3 + 2] = tb;
    this.opacity[i] = 0;

    this.age[i] = 0;
    this.life[i] = life;
    this.alive[i] = 1;
    this.maxOpacity[i] = opacity;

    mesh.count = this._used;
    mesh.instanceMatrix.needsUpdate = true;
    markAll(this.uvRectAttr, this._used * 4);
    markAll(this.tintAttr, this._used * 3);
    return i;
  }

  /**
   * Ground blood beneath a hit — one downward raycast, then a pool plus a few drips.
   * Allocation free (world.raycast may allocate; it is called at most once per call).
   */
  bloodOnGround(point, size = 0.34, drips = 3) {
    const world = this.game.world;
    if (!world || !world.raycast) return;
    _origin.set(point.x, point.y + 0.05, point.z);
    const hit = world.raycast(_origin, _down, 3.2);
    if (!hit) return;
    this.addBlood(hit.point, hit.normal, size * (0.85 + rnd() * 0.5), 0.92, LIFE);
    for (let i = 0; i < drips; i++) {
      const a = rnd() * Math.PI * 2;
      const r = size * (0.5 + rnd() * 1.4);
      _origin.set(
        hit.point.x + Math.cos(a) * r,
        hit.point.y,
        hit.point.z + Math.sin(a) * r,
      );
      this.addBlood(_origin, hit.normal, size * (0.16 + rnd() * 0.22), 0.8, LIFE * 0.7);
    }
  }

  update(dt) {
    const used = this._used;
    if (!this.mesh || used === 0) return;
    const age = this.age, life = this.life, alive = this.alive, op = this.opacity, mo = this.maxOpacity;
    let dirty = false;
    for (let i = 0; i < used; i++) {
      if (!alive[i]) continue;
      const a = age[i] + dt;
      age[i] = a;
      const l = life[i];
      if (a >= l) {
        alive[i] = 0;
        op[i] = 0;
        dirty = true;
        continue;
      }
      let o = mo[i];
      if (a < FADE_IN) o *= a / FADE_IN;
      const remain = l - a;
      if (remain < FADE_OUT) o *= remain / FADE_OUT;
      if (op[i] !== o) { op[i] = o; dirty = true; }
    }
    if (dirty) markAll(this.opacityAttr, used);
  }

  clear() {
    if (!this.mesh) return;
    this.alive.fill(0);
    this.opacity.fill(0);
    this.age.fill(0);
    this._head = 0;
    this._used = 0;
    this.mesh.count = 0;
    markAll(this.opacityAttr, CAP);
  }

  dispose() {
    if (!this.mesh) return;
    this._scene?.remove(this.mesh);
    this.mesh.dispose();
    this.geo.dispose();
    this.mat.dispose();
    this.atlas.dispose();
    this.mesh = null;
  }
}

export const DECAL_CAP = CAP;
