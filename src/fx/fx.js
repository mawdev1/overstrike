import * as THREE from 'three';
import { createRNG } from '../core/rng.js';
import { clamp } from '../core/mathUtils.js';
import { ParticleSystem } from './particles.js';
import { DecalSystem, DECAL_CAP } from './decals.js';
import { TracerSystem, TRACER_NORMAL, TRACER_SNIPER, TRACER_SPEED } from './tracers.js';
import { SiteRings } from './siteRings.js';

/**
 * OVERSTRIKE — FX facade (ARCHITECTURE §8).
 *
 * Owns every visual impact-feedback pool in the game and exposes exactly the §8 API.
 * Nothing here allocates after `init()`: all vectors, matrices, quaternions and the
 * audio option bag are module-scope scratch, and every pool is a packed array whose
 * tail doubles as the free list.
 *
 * Draw calls added (see `debugInfo()`):
 *   3  particles (smoke / debris / additive)
 *   1  decals    (single atlased InstancedMesh, cap 256)
 *   2  tracers   (streaks + sniper vapour ribbons)
 *   2  billboards (world flash batch + viewScene flash batch)
 *   1  shell casings
 *   = 9 total, well inside the <15 budget of §11.
 *
 * Lights: 5 pooled world PointLights (§ "never exceed ~6") + the engine-owned
 * `viewScene` muzzle light, which we only nudge — that is 6 concurrent lights maximum.
 * They are created once and never added/removed at runtime, because add/remove forces a
 * full shader recompile of every lit material mid-firefight.
 */

/** Private stream — `game.rng` drives simulation determinism and must stay untouched. */
const rnd = createRNG(0x5eedfa11);

const MAX_LIGHTS = 5;
const SHELL_CAP = 40;
const FLASH_CAP_WORLD = 24;
const FLASH_CAP_VIEW = 8;

const WORLD_GRAVITY = -22;

// Beyond this the full recipe is pointless — trim particle counts hard.
const FX_NEAR = 34;
const FX_FAR = 110;

// ---------------------------------------------------------------- scratch (§1)
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _mat = new THREE.Matrix4();
const _scale = new THREE.Vector3(1, 1, 1);
const _col = new THREE.Color();
const _down = new THREE.Vector3(0, -1, 0);
const _up = new THREE.Vector3(0, 1, 0);

/** Reused audio option bag — AudioEngine.play() consumes it synchronously. */
const _audioOpts = { position: null, volume: 1, rate: 1, delay: 0 };

// ---------------------------------------------------------------- billboard batch

const BILLBOARD_VERT = /* glsl */`
  attribute vec3 aCenter;
  attribute vec3 aColor;
  attribute vec3 aParams;   // x: size (m), y: roll, z: alpha

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vUv = uv;
    vColor = aColor;
    vAlpha = aParams.z;
    vec4 mvPosition = modelViewMatrix * vec4(aCenter, 1.0);
    float c = cos(aParams.y), s = sin(aParams.y);
    vec2 q = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
    mvPosition.xy += q * aParams.x;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

// three's fragment prefix already declares the tonemapping / colorspace helpers.
const BILLBOARD_FRAG = /* glsl */`
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vec4 tex = texture2D(uMap, vUv);
    float a = tex.a * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(tex.rgb * vColor, a);
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

/** Additive, camera-facing, rolled quads. One draw call per batch. */
class BillboardBatch {
  constructor(cap, texture, renderOrder) {
    this.cap = cap;
    this.count = 0;

    this.center = new Float32Array(cap * 3);
    this.color = new Float32Array(cap * 3);
    this.params = new Float32Array(cap * 3);

    // CPU state
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.s0 = new Float32Array(cap);
    this.s1 = new Float32Array(cap);
    this.c0 = new Float32Array(cap * 3);
    this.c1 = new Float32Array(cap * 3);
    this.spin = new Float32Array(cap);
    this.pow = new Float32Array(cap);

    const geo = new THREE.PlaneGeometry(1, 1);
    this.centerAttr = new THREE.InstancedBufferAttribute(this.center, 3).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage);
    this.paramsAttr = new THREE.InstancedBufferAttribute(this.params, 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aCenter', this.centerAttr);
    geo.setAttribute('aColor', this.colorAttr);
    geo.setAttribute('aParams', this.paramsAttr);
    this.geo = geo;

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: texture } },
      vertexShader: BILLBOARD_VERT,
      fragmentShader: BILLBOARD_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });

    this.mesh = new THREE.InstancedMesh(geo, this.mat, cap);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.count = 0;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  spawn(x, y, z, size0, size1, life, r0, g0, b0, r1, g1, b1, alphaPow, spin) {
    let i;
    if (this.count < this.cap) i = this.count++;
    else {
      // Steal the one closest to death.
      i = 0;
      let best = Infinity;
      for (let k = 0; k < this.cap; k++) if (this.life[k] < best) { best = this.life[k]; i = k; }
    }
    const i3 = i * 3;
    this.center[i3] = x; this.center[i3 + 1] = y; this.center[i3 + 2] = z;
    this.c0[i3] = r0; this.c0[i3 + 1] = g0; this.c0[i3 + 2] = b0;
    this.c1[i3] = r1; this.c1[i3 + 1] = g1; this.c1[i3 + 2] = b1;
    this.color[i3] = r0; this.color[i3 + 1] = g0; this.color[i3 + 2] = b0;
    this.params[i3] = size0;
    this.params[i3 + 1] = rnd() * Math.PI * 2;
    this.params[i3 + 2] = 1;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.s0[i] = size0;
    this.s1[i] = size1;
    this.spin[i] = spin;
    this.pow[i] = alphaPow;
    return i;
  }

  update(dt) {
    let i = 0;
    while (i < this.count) {
      const l = this.life[i] - dt;
      if (l <= 0) { this._kill(i); continue; }
      this.life[i] = l;
      const t = 1 - l / this.maxLife[i];
      const i3 = i * 3;
      const inv = 1 - t;
      let a = inv;
      const p = this.pow[i];
      if (p === 2) a = inv * inv;
      else if (p === 3) a = inv * inv * inv;
      else if (p === 0.5) a = Math.sqrt(inv);
      this.params[i3] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.params[i3 + 1] += this.spin[i] * dt;
      this.params[i3 + 2] = a;
      this.color[i3] = this.c0[i3] + (this.c1[i3] - this.c0[i3]) * t;
      this.color[i3 + 1] = this.c0[i3 + 1] + (this.c1[i3 + 1] - this.c0[i3 + 1]) * t;
      this.color[i3 + 2] = this.c0[i3 + 2] + (this.c1[i3 + 2] - this.c0[i3 + 2]) * t;
      i++;
    }
    this.mesh.count = this.count;
    markAll(this.centerAttr, this.count * 3);
    markAll(this.colorAttr, this.count * 3);
    markAll(this.paramsAttr, this.count * 3);
  }

  _kill(i) {
    const last = --this.count;
    if (i === last) return;
    const i3 = i * 3, l3 = last * 3;
    this.center[i3] = this.center[l3]; this.center[i3 + 1] = this.center[l3 + 1]; this.center[i3 + 2] = this.center[l3 + 2];
    this.color[i3] = this.color[l3]; this.color[i3 + 1] = this.color[l3 + 1]; this.color[i3 + 2] = this.color[l3 + 2];
    this.params[i3] = this.params[l3]; this.params[i3 + 1] = this.params[l3 + 1]; this.params[i3 + 2] = this.params[l3 + 2];
    this.c0[i3] = this.c0[l3]; this.c0[i3 + 1] = this.c0[l3 + 1]; this.c0[i3 + 2] = this.c0[l3 + 2];
    this.c1[i3] = this.c1[l3]; this.c1[i3 + 1] = this.c1[l3 + 1]; this.c1[i3 + 2] = this.c1[l3 + 2];
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.s0[i] = this.s0[last];
    this.s1[i] = this.s1[last];
    this.spin[i] = this.spin[last];
    this.pow[i] = this.pow[last];
  }

  clear() {
    this.count = 0;
    this.mesh.count = 0;
  }

  dispose() {
    this.mesh.dispose();
    this.geo.dispose();
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------- surface recipes

/**
 * Per-surface impact recipe. `decal` is the atlas key handed to DecalSystem,
 * `sound` the §9 sound name. Everything else is read by `impact()`.
 */
const SURFACES = Object.freeze({
  concrete: Object.freeze({
    decal: 'concrete', decalSize: 0.155, sound: 'impactConcrete',
    dust: 1, dustTint: 0x9a9791, chips: 'concreteChips', chipScale: 1,
    sparkChance: 0.35, sparks: 'sparks', sparkScale: 0.7, flash: 0,
  }),
  metal: Object.freeze({
    decal: 'metal', decalSize: 0.12, sound: 'impactMetal',
    dust: 0.35, dustTint: 0x8f8f96, chips: null, chipScale: 0,
    sparkChance: 1, sparks: 'metalSparks', sparkScale: 1, flash: 1,
  }),
  wood: Object.freeze({
    decal: 'wood', decalSize: 0.145, sound: 'impactWood',
    dust: 0.55, dustTint: 0x9c7f5c, chips: 'woodSplinters', chipScale: 1,
    sparkChance: 0, sparks: null, sparkScale: 0, flash: 0,
  }),
  dirt: Object.freeze({
    decal: 'dirt', decalSize: 0.2, sound: 'impactDirt',
    dust: 1.7, dustTint: 0x8a7455, chips: 'concreteChips', chipScale: 1.5,
    sparkChance: 0, sparks: null, sparkScale: 0, flash: 0,
  }),
  sand: Object.freeze({
    decal: 'sand', decalSize: 0.22, sound: 'impactDirt',
    dust: 2, dustTint: 0xc0ab7e, chips: 'concreteChips', chipScale: 1.2,
    sparkChance: 0, sparks: null, sparkScale: 0, flash: 0,
  }),
  glass: Object.freeze({
    decal: 'glass', decalSize: 0.19, sound: 'impactGlass',
    dust: 0.25, dustTint: 0xb8ccd6, chips: 'glassShards', chipScale: 1,
    sparkChance: 0, sparks: null, sparkScale: 0, flash: 0,
  }),
  flesh: Object.freeze({
    decal: null, decalSize: 0, sound: 'fleshHit',
    dust: 0, dustTint: 0xffffff, chips: null, chipScale: 0,
    sparkChance: 0, sparks: null, sparkScale: 0, flash: 0,
  }),
});

const SHELL_KINDS = Object.freeze({
  pistol: Object.freeze({ scale: 0.8, r: 0.86, g: 0.68, b: 0.24 }),
  smg: Object.freeze({ scale: 0.82, r: 0.86, g: 0.68, b: 0.24 }),
  ar: Object.freeze({ scale: 1, r: 0.88, g: 0.7, b: 0.26 }),
  rifle: Object.freeze({ scale: 1, r: 0.88, g: 0.7, b: 0.26 }),
  lmg: Object.freeze({ scale: 1.1, r: 0.88, g: 0.7, b: 0.26 }),
  sniper: Object.freeze({ scale: 1.3, r: 0.9, g: 0.72, b: 0.3 }),
  shotgun: Object.freeze({ scale: 1.45, r: 0.62, g: 0.12, b: 0.1 }),
});

// ---------------------------------------------------------------- FX

export class FX {
  constructor(game) {
    this.game = game;

    this.particles = new ParticleSystem(game);
    this.decals = new DecalSystem(game);
    this.tracers = new TracerSystem(game);
    this.siteRings = new SiteRings(game);

    /** Public knobs — other systems may tune these, nothing here reads settings keys. */
    this.quality = 1;            // scales particle counts
    this.tracerRatio = 1 / 3;    // §"only ~1 in 3 bullets draws a full tracer"
    this.playImpactAudio = true; // set false if ballistics/weapons already plays impacts
    this.enabled = true;

    this.flashWorld = null;
    this.flashView = null;
    this.shells = null;

    // --- pooled lights
    this.lights = null;
    this._lightLife = new Float32Array(MAX_LIGHTS);
    this._lightMax = new Float32Array(MAX_LIGHTS);
    this._lightI0 = new Float32Array(MAX_LIGHTS);
    this._lightPow = new Float32Array(MAX_LIGHTS);

    // --- bomb detonation sequencer (see `bombDetonation()`)
    //
    // One live detonation at a time is plenty: Bomb has one bomb, and the round ends on
    // it. Stages are driven from `update()` so the column keeps building for ~2 s after
    // the round-end whistle rather than being one single-frame burst.
    this._deto = {
      active: false, t: 0, next: 0,
      x: 0, y: 0, z: 0, groundY: 0, grounded: false,
    };
    this._ring = null;        // ground shockwave ring mesh (built in init)
    this._ringLife = 0;
    this._ringMax = 1.15;
    this._busUnsubs = [];

    // --- shell casing pool
    this._shellPos = new Float32Array(SHELL_CAP * 3);
    this._shellVel = new Float32Array(SHELL_CAP * 3);
    this._shellQuat = new Float32Array(SHELL_CAP * 4);
    this._shellSpin = new Float32Array(SHELL_CAP * 4); // axis xyz + speed
    this._shellLife = new Float32Array(SHELL_CAP);
    this._shellMaxLife = new Float32Array(SHELL_CAP);
    this._shellScale = new Float32Array(SHELL_CAP);
    this._shellFloor = new Float32Array(SHELL_CAP);
    this._shellBounces = new Uint8Array(SHELL_CAP);
    this._shellCount = 0;
  }

  async init() {
    const scene = this.game.scene;
    const assets = this.game.assets;

    this.particles.init(scene);
    this.particles.quality = this.quality;
    this.decals.init(scene);
    this.tracers.init(scene);
    this.siteRings.init(scene);

    const glow = assets.tex('glow');
    this.flashWorld = new BillboardBatch(FLASH_CAP_WORLD, glow, 12);
    scene.add(this.flashWorld.mesh);

    this.flashView = new BillboardBatch(FLASH_CAP_VIEW, glow, 12);
    const viewScene = this.game.engine?.viewScene;
    if (viewScene) viewScene.add(this.flashView.mesh);

    // --- pooled point lights
    //
    // These are created once, added once, and **never added, removed or hidden again**.
    // Both halves of that sentence matter. `WebGLRenderer.projectObject` skips invisible
    // objects before `pushLight`, so flipping `visible` changes `pointLength`, which bumps
    // `WebGLLights.state.version`, which sets `needsProgramChange` on EVERY lit material
    // in the scene — a full `getParameters()` + `getProgramCacheKey()` per material, and a
    // genuine shader COMPILE for each light count the game has not seen before (measured:
    // +13 programs per extra live light, 35 → 100 across the pool, all of it lazily during
    // a firefight). An idle light costs ~35 ALU per lit pixel and nothing else.
    //
    // So: `visible` is pinned true here for the lifetime of the pool, and `intensity` is
    // the ONLY thing `_light()` / `_updateLights()` drive. Any future code that adds,
    // removes or hides a light reintroduces the stall.
    this.lights = [];
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffb066, 0, 9, 2);
      l.castShadow = false;
      l.visible = true;
      scene.add(l);
      this.lights.push(l);
    }

    // --- shell casings
    const shellGeo = new THREE.CylinderGeometry(0.0052, 0.006, 0.024, 7, 1, false);
    this._shellGeo = shellGeo;
    const shells = new THREE.InstancedMesh(shellGeo, assets.mat('brass'), SHELL_CAP);
    shells.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    shells.frustumCulled = false;
    shells.castShadow = false;
    shells.receiveShadow = false;
    shells.count = 0;
    shells.matrixAutoUpdate = false;
    shells.updateMatrix();
    _col.setRGB(0.88, 0.7, 0.26);
    for (let i = 0; i < SHELL_CAP; i++) shells.setColorAt(i, _col);
    if (shells.instanceColor) shells.instanceColor.needsUpdate = true;
    this.shells = shells;
    scene.add(shells);

    // --- bomb detonation shockwave ring
    //
    // A flat, additive, ground-aligned ring that expands from the site. Camera-facing
    // billboards cannot express "a pressure wave racing along the ground", and the
    // composite pass has no distortion buffer for a true refraction shockwave (see
    // `explosion()`), so this one always-resident mesh is the honest substitute. It is
    // scaled to ~0 and invisible except during the ~1.1 s it plays; toggling MESH
    // visibility is safe — the light-pool recompile hazard is specific to lights.
    const ringGeo = new THREE.RingGeometry(0.82, 1, 48, 1);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffc887, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    ring.renderOrder = 11;
    scene.add(ring);
    this._ring = ring;
    this._ringGeo = ringGeo;
    this._ringMat = ringMat;

    // --- bomb detonation trigger
    //
    // Single player: `game/bomb.js` `_emit('bombDetonated', …)` lands on the bus as an
    // `objective` row with raw x/y/z. Online: `net/session.js` re-emits the wire event
    // as the same bus kind with a `position` object. Both shapes are accepted here, so
    // the one detonation presentation cannot drift between local and networked play.
    const bus = this.game.bus;
    if (bus?.on) {
      const un = bus.on('objective', (row) => {
        if (!row || row.kind !== 'bombDetonated') return;
        const p = row.position
          ?? (typeof row.x === 'number' ? row : null);
        if (!p) return;
        _v4.set(p.x, p.y, p.z);
        this.bombDetonation(_v4);
      });
      if (un) this._busUnsubs.push(un);
    }
  }

  // ================================================================ §8 API

  /**
   * Short additive flash card + fast-decaying light + muzzle smoke.
   *
   * `space` decides which scene the card lives in:
   *   'view'  — the local player's own weapon. The card goes into `engine.viewScene`
   *             so it can never be occluded by the wall the muzzle is clipping into,
   *             and the engine's own `viewMuzzleLight` is kicked. NOTE: the viewScene
   *             is rendered *after* the composer, so it gets no bloom — the view card
   *             is therefore drawn larger and hotter to compensate.
   *   'world' — every other shooter; blooms normally.
   *   'auto'  — (default) picks 'view' when the muzzle is within 1.2 m of the camera,
   *             which is true only for the local viewmodel.
   * `position` is always interpreted as WORLD space; for the view card it is converted
   * through camera→viewCamera so it lands in the right place on screen.
   */
  muzzleFlash(position, dir, scale = 1, space = 'auto') {
    if (!this.enabled || !this.flashWorld) return;
    const cam = this.game.camera;
    let useView = space === 'view' || space === 'viewRaw';
    if (space === 'auto' && cam) {
      _camPos.setFromMatrixPosition(cam.matrixWorld);
      useView = _camPos.distanceToSquared(position) < 1.44;
    }

    const s = scale * (0.85 + rnd() * 0.35);
    _v1.set(dir.x, dir.y, dir.z);
    if (_v1.lengthSq() < 1e-8) _v1.set(0, 0, -1);
    _v1.normalize();

    if (useView) {
      const engine = this.game.engine;
      _v2.copy(position);
      if (space !== 'viewRaw' && cam && engine?.viewCamera) {
        cam.worldToLocal(_v2);
        engine.viewCamera.localToWorld(_v2);
      }
      // Hotter + bigger: no bloom pass runs over the viewScene.
      this.flashView.spawn(_v2.x, _v2.y, _v2.z, 0.30 * s, 0.42 * s, 0.045,
        4.2, 2.9, 1.5, 1.4, 0.6, 0.2, 2, rnd() < 0.5 ? -9 : 9);
      this.flashView.spawn(_v2.x, _v2.y, _v2.z, 0.13 * s, 0.09 * s, 0.035,
        5.5, 4.4, 3.2, 2.0, 1.2, 0.6, 3, 0);
      const vml = engine?.viewMuzzleLight;
      if (vml) {
        vml.intensity = 6.5 * s;
        vml.position.set(_v2.x, _v2.y, _v2.z);
      }
    } else {
      this.flashWorld.spawn(position.x, position.y, position.z, 0.34 * s, 0.5 * s, 0.045,
        6.5, 4.0, 1.7, 2.0, 0.8, 0.25, 2, rnd() < 0.5 ? -9 : 9);
      this.flashWorld.spawn(position.x, position.y, position.z, 0.14 * s, 0.1 * s, 0.035,
        9.0, 7.0, 4.5, 3.0, 1.6, 0.7, 3, 0);
      this._light(position.x, position.y, position.z, 0.95, 0.72, 0.42, 3.4 * s, 0.055, 2);
    }

    // Smoke always lives in the world — it is a real place in front of the barrel.
    _v3.copy(position).addScaledVector(_v1, 0.06);
    this.particles.emit('muzzleSmoke', _v3, _v1, 0.6 * s, -Infinity);
  }

  /**
   * §8 `tracer(from, to, speed, width, color)`.
   * Applies the 1-in-3 rule: a full bright tracer, otherwise a thin heat-shimmer streak,
   * so consecutive rounds never look identical. Pass `kind` explicitly for snipers.
   * @param {number|THREE.Color} [color]
   * @param {'auto'|'normal'|'sniper'|'shimmer'} [kind]
   */
  tracer(from, to, speed = TRACER_SPEED, width = 0.035, color = null, kind = 'auto') {
    if (!this.enabled || !this.tracers.batch) return;
    let r = 1.9, g = 1.35, b = 0.6;
    if (color !== null && color !== undefined) {
      if (typeof color === 'number') {
        r = ((color >> 16) & 255) / 255 * 2.2;
        g = ((color >> 8) & 255) / 255 * 2.2;
        b = (color & 255) / 255 * 2.2;
      } else if (color.isColor) {
        r = color.r * 2.2; g = color.g * 2.2; b = color.b * 2.2;
      }
    }

    if (kind === 'sniper' || (kind === 'auto' && width >= 0.055)) {
      this.tracers.spawn(from, to, speed * 1.1, width, r * 1.5, g * 1.4, b * 1.2, TRACER_SNIPER);
      return;
    }
    if (kind === 'shimmer') { this.tracers.whizbyStreak(from, to, speed); return; }
    if (rnd() < this.tracerRatio) {
      this.tracers.spawn(from, to, speed, width, r, g, b, TRACER_NORMAL);
    } else {
      this.tracers.whizbyStreak(from, to, speed);
    }
  }

  /** Explicit pass-through for callers that always want the thin streak. */
  whizbyStreak(from, to, speed = TRACER_SPEED) {
    if (!this.enabled) return;
    this.tracers.whizbyStreak(from, to, speed);
  }

  /**
   * §8 `impact(point, normal, surface)` — the surface-appropriate combo.
   *
   *   concrete → grey dust puff + chips + an occasional bright spark + bullet hole
   *   metal    → hot additive spark shower + ricochet ping + micro-light + metal hole
   *   wood     → splinters + light tan dust + bullet hole
   *   dirt/sand→ big soft dirt puff, extra debris, NO sparks + soft divot decal
   *   glass    → falling shards (gravity) + shatter decal
   *   flesh    → blood mist + droplets, no decal on the body, blood pooled on the
   *              ground behind/below the hit
   */
  impact(point, normal, surface) {
    if (!this.enabled || !this.particles.groups) return;
    const rec = SURFACES[surface] || SURFACES.concrete;

    // Distance LOD — a hit 90 m away does not deserve a full debris budget.
    const cam = this.game.camera;
    let lod = 1;
    if (cam) {
      _camPos.setFromMatrixPosition(cam.matrixWorld);
      const d = _camPos.distanceTo(point);
      lod = d <= FX_NEAR ? 1 : d >= FX_FAR ? 0.25 : 1 - 0.75 * (d - FX_NEAR) / (FX_FAR - FX_NEAR);
    }

    _v1.set(normal.x, normal.y, normal.z);
    if (_v1.lengthSq() < 1e-8) _v1.set(0, 1, 0);
    _v1.normalize();

    if (surface === 'flesh') {
      this.bloodSpray(point, _v1, 1);
      if (this.playImpactAudio) this._play('fleshHit', point, 0.85, 0.94 + rnd() * 0.14);
      return;
    }

    // Debris bounces on the floor only when we actually hit one (normal points up).
    const floorY = _v1.y > 0.6 ? point.y + 0.005 : -Infinity;

    if (rec.dust > 0) {
      _col.setHex(rec.dustTint);
      this.particles.emitTinted('dust', point, _v1, rec.dust * lod, -Infinity,
        _col.r * 1.6, _col.g * 1.6, _col.b * 1.6);
    }
    if (rec.chips) {
      this.particles.emit(rec.chips, point, _v1, rec.chipScale * lod, floorY);
    }
    if (rec.sparks && rnd() < rec.sparkChance) {
      this.particles.emit(rec.sparks, point, _v1, rec.sparkScale * lod, floorY);
    }
    if (rec.flash > 0 && lod > 0.5) {
      // Micro-light: very short, orange, pooled. Metal only by default.
      this._light(point.x + _v1.x * 0.05, point.y + _v1.y * 0.05, point.z + _v1.z * 0.05,
        1.0, 0.72, 0.36, 1.5 * rec.flash, 0.06, 2);
      this.flashWorld.spawn(point.x + _v1.x * 0.03, point.y + _v1.y * 0.03, point.z + _v1.z * 0.03,
        0.1, 0.03, 0.05, 4.0, 2.4, 0.9, 1.2, 0.4, 0.1, 2, 0);
    }
    if (rec.decal) this.decals.add(point, _v1, rec.decal, rec.decalSize * (0.82 + rnd() * 0.4));

    if (this.playImpactAudio && rec.sound) {
      // Metal gets a wider pitch spread — that variance is the "ricochet ping".
      const spread = surface === 'metal' ? 0.34 : 0.16;
      this._play(rec.sound, point, 0.7, 1 - spread * 0.5 + rnd() * spread);
    }
  }

  /** §8 `bloodSpray(point, normal, amount)` — `amount` ~1 for a body shot, ~2.5 for a headshot. */
  bloodSpray(point, normal, amount = 1) {
    if (!this.enabled || !this.particles.groups) return;
    _v2.set(normal.x, normal.y, normal.z);
    if (_v2.lengthSq() < 1e-8) _v2.set(0, 1, 0);
    _v2.normalize();
    const a = clamp(amount, 0.2, 3);
    this.particles.emit('bloodMist', point, _v2, a, -Infinity);
    this.particles.emit('bloodDroplets', point, _v2, a, -Infinity);
    // A little spray continues *through* the target as well.
    _v3.copy(_v2).multiplyScalar(-1);
    this.particles.emit('bloodDroplets', point, _v3, a * 0.45, -Infinity);
    // Ground blood is rationed: a full magazine into one body must not evict every
    // bullet hole on the map. Big sprays (kills, headshots) always leave a pool.
    if (a >= 1.5 || rnd() < a * 0.3) {
      this.decals.bloodOnGround(point, 0.3 * a, a > 1.6 ? 3 : 1);
    }
  }

  /** §8 `decal(point, normal, surface, size)`. */
  decal(point, normal, surface, size = 0.16) {
    if (!this.enabled) return;
    this.decals.add(point, normal, surface, size);
  }

  /**
   * §8 `explosion(point, radius)` — layered:
   *   white-hot flash light → expanding fireball billboards → embers + debris →
   *   ground-hugging dust ring → lingering smoke column → scorch decal → screen shake.
   * A true refraction shockwave is skipped: the composite pass in engine.js has no
   * distortion uniform, and adding a second fullscreen pass costs more than it sells.
   */
  explosion(point, radius = 4) {
    if (!this.enabled || !this.particles.groups) return;
    const r = clamp(radius, 0.5, 24);

    // Distance LOD, on the same curve impact() uses. A detonation is the single biggest
    // transparent-overdraw spike in the game — ~12x full-screen blended fill at 5 m,
    // every pixel of it above the bloom threshold — and a frag 60 m away was paying the
    // full price for a puff of colour a few dozen pixels across.
    const cam = this.game.camera;
    let camDist = 0;
    let lod = 1;
    if (cam) {
      _camPos.setFromMatrixPosition(cam.matrixWorld);
      camDist = _camPos.distanceTo(point);
      lod = camDist <= FX_NEAR ? 1 : camDist >= FX_FAR ? 0.25
        : 1 - 0.75 * (camDist - FX_NEAR) / (FX_FAR - FX_NEAR);
    }

    // 0. one downward probe — it drives the scorch decal, the debris bounce plane and
    //    the height of the ground ring. Everything else is allocation free.
    let groundY = point.y;
    let grounded = false;
    const world = this.game.world;
    if (world?.raycast) {
      _v2.set(point.x, point.y + 0.1, point.z);
      const hit = world.raycast(_v2, _down, r * 1.5 + 1);
      if (hit) {
        groundY = hit.point.y;
        grounded = true;
        this.decals.add(hit.point, hit.normal, 'scorch', r * 0.9);
      }
    }

    // 1. instantaneous white-hot core
    this.flashWorld.spawn(point.x, point.y, point.z, r * 0.5, r * 1.5, 0.07,
      12, 10.5, 8.0, 4.0, 1.4, 0.4, 3, 0);
    this._light(point.x, point.y + r * 0.15, point.z, 1.0, 0.85, 0.6, 14 + r * 2.2, 0.42, 2, r * 3.5);

    // 2. fireball — the extra billboards are the screen-fillers, so they thin out first
    this.particles.emit('explosionFireball', point, _up, r * 0.35 * lod, -Infinity);
    const puffs = lod >= 0.85 ? 3 : lod >= 0.5 ? 2 : 1;
    for (let i = 0; i < puffs; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = r * 0.22 * rnd();
      this.flashWorld.spawn(
        point.x + Math.cos(a) * rr, point.y + rnd() * r * 0.25, point.z + Math.sin(a) * rr,
        r * 0.3, r * 0.95, 0.18 + rnd() * 0.12,
        7.5, 3.4, 0.9, 0.9, 0.16, 0.03, 2, rnd() < 0.5 ? -2 : 2);
    }

    // 3. embers + debris burst, bouncing on the real floor rather than mid-air
    const floorY = grounded ? groundY : -Infinity;
    this.particles.emit('explosionEmbers', point, _up, r * 0.3 * lod, floorY);
    this.particles.emit('concreteChips', point, _up, r * 0.55 * lod, floorY);

    // 4. ground-hugging shockwave dust ring (plane mode → spreads horizontally, fast)
    _v1.set(point.x, (grounded ? groundY : point.y) + 0.12, point.z);
    this.particles.emitTinted('explosionDustRing', _v1, _up, r * 0.5 * lod, -Infinity, 1.15, 1.05, 0.95);

    // 5. lingering smoke column
    this.particles.emit('explosionSmoke', point, _up, r * 0.32 * lod, -Infinity);

    // 6. shake (distance is already in hand from the LOD probe above)
    //
    // NO audio here. One frag detonation used to grant THREE `explosion` voices: this
    // one, `projectiles._popExplosive`'s own `audio.play`, and the audio engine's
    // `explosion` bus handler (audio.js `_onExplosion`, reached from
    // `applyExplosionDamage`, which emits unconditionally). Measured 3 calls / 3 grants
    // per frag, and since `VOICE_LIMIT.explosion` is 6 that meant TWO overlapping
    // grenades filled the entire explosion voice budget and a third detonation was
    // dropped outright. The bus handler is the one to keep — it is the path the audio
    // engine tuned (priority 100, defendUntil, voice limits) and it also owns the duck
    // and the deafen. Every other `fx.explosion()` caller still plays its own
    // characteristic sound (the flashbang's sharp crack in projectiles.js, the
    // killstreak booms in killstreaks.js), so nothing here goes silent.
    if (cam) {
      const falloff = clamp(1 - camDist / (r * 5 + 6), 0, 1);
      if (falloff > 0.01) this.screenShake(1.15 * falloff, 0.35 + 0.35 * falloff);
    }
  }

  /**
   * The bomb going off — a round-ending landmark event, deliberately NOT `explosion()`
   * at a bigger radius. §8's explosion is tuned to be fair mid-combat; this one is tuned
   * to be WITNESSED: every player on the 88 m map must see it and feel it, wherever they
   * are and whatever is between them and the site.
   *
   *   at the site   — everything `explosion()` does, plus a much larger core flash,
   *                   a ground shockwave ring racing outward, and a debris fountain.
   *   from anywhere — a horizon flash (a huge additive card that reads over rooftops),
   *                   a fire-then-smoke column climbing ~30 m for several seconds,
   *                   a distance-attenuated but never-zero screen shake, and a brief
   *                   white screen flash (the HUD's flashbang layer, which already
   *                   honours the `flashIntensity` / `screenEffectIntensity` settings).
   *
   * The column and late smoke are staged from `update()` over ~2.2 s, so the plume keeps
   * building through the round-end banner instead of popping for one frame. Nothing here
   * reads `game.rng` or mutates sim state — this is presentation only, triggered off the
   * `bombDetonated` objective event.
   */
  bombDetonation(point) {
    if (!this.enabled || !this.particles.groups) return;
    const x = point.x, y = point.y, z = point.z;

    // The full near-field recipe first: fireball, embers, dust ring, scorch, near shake.
    this.explosion(point, 11);

    // Ground probe for the ring / column base (explosion() probed too, but keeps the
    // result to itself — one extra raycast per round is nothing).
    let groundY = y;
    let grounded = false;
    const world = this.game.world;
    if (world?.raycast) {
      _v2.set(x, y + 0.1, z);
      const hit = world.raycast(_v2, _down, 18);
      if (hit) { groundY = hit.point.y; grounded = true; }
    }

    // Camera distance drives every "felt" channel below.
    const cam = this.game.camera;
    let camDist = 0;
    if (cam) {
      _camPos.setFromMatrixPosition(cam.matrixWorld);
      camDist = _camPos.distanceTo(point);
    }
    const settings = this.game.settings;
    const reduceMotion = settings?.get?.('reduceMotion') === true;

    // 1. Core: white-hot cards that grow to ~46 m — the horizon flash. The second card
    //    sits WELL above roof height (sites can be indoors — Civic Archive is), so a
    //    viewer with the site itself fully occluded still sees the sky over it light up.
    this.flashWorld.spawn(x, y + 2.5, z, 7, 46, 0.5, 12, 11, 8.5, 4.2, 1.6, 0.5, 3, 0);
    this.flashWorld.spawn(x, y + 16, z, 6, 40, 0.6, 10, 9, 7, 3.5, 1.3, 0.4, 3, 0);
    // A slower fire dome that hangs for over a second where the site was.
    this.flashWorld.spawn(x, y + 3.5, z, 6, 20, 1.25, 7.5, 3.2, 0.8, 1.2, 0.2, 0.03, 2,
      rnd() < 0.5 ? -1.2 : 1.2);
    // Site-lighting kick, thrown across most of the map.
    this._light(x, y + 3, z, 1.0, 0.82, 0.55, 55, 1.0, 2, 120);

    // 2. Ground shockwave ring.
    if (this._ring) {
      this._ring.position.set(x, (grounded ? groundY : y) + 0.18, z);
      this._ring.visible = true;
      this._ringLife = this._ringMax;
    }

    // 3. Debris fountain + first column burst, immediately.
    _v3.set(x, grounded ? groundY : y, z);
    const floorY = grounded ? groundY : -Infinity;
    this.particles.emit('explosionEmbers', point, _up, 3.2, floorY);
    this.particles.emit('concreteChips', point, _up, 3.0, floorY);
    this.particles.emit('bombFireColumn', _v3, _up, 1, -Infinity);
    this.particles.emit('bombSmokeColumn', _v3, _up, 1, -Infinity);

    // 4. Stage the rest of the column from update().
    const d = this._deto;
    d.active = true;
    d.t = 0;
    d.next = 0.12;
    d.x = x; d.y = y; d.z = z;
    d.groundY = grounded ? groundY : y;
    d.grounded = grounded;

    // 5. Screen feel — attenuated by distance but PRESENT at any distance on the map.
    //    (The far corner of the 88 m map is ~120 m from a site; the floor terms below
    //    are what keep the event felt there.) `reduceMotion` keeps the information —
    //    a short, small shake and a dimmer flash — without the violence.
    if (cam) {
      const far = clamp(1 - camDist / 150, 0, 1);          // 1 near … ~0.2 far corner
      const shakeAmt = Math.max(0.3, 2.3 * far);
      const shakeDur = 0.5 + 0.6 * far;
      const motionScale = reduceMotion ? 0.3 : 1;
      this.screenShake(shakeAmt * motionScale, shakeDur * (reduceMotion ? 0.6 : 1));

      // Brief white flash via the HUD's flashbang layer (never a real blind: even at
      // point blank this stays far below a flashbang's amount/duration).
      const flashAmt = clamp(0.18 + 0.5 * far, 0, 0.7) * (reduceMotion ? 0.5 : 1);
      this.game.bus?.emit?.('flashbang', {
        amount: flashAmt,
        duration: 0.35 + 0.45 * far,
        position: point,
      });

      // Near the blast: a dust kick right at the camera, so the world — not just the
      // HUD — goes briefly thick with the site's dust.
      if (camDist < 22 && !reduceMotion) {
        _v1.set(_camPos.x, _camPos.y - 0.4, _camPos.z);
        this.particles.emitTinted('dust', _v1, _up, 2.2, -Infinity, 1.3, 1.22, 1.1);
      }
    }
  }

  /** Per-frame driver for the staged bomb-detonation column + shockwave ring. */
  _updateDetonation(dt) {
    // Ring: expand fast, fade out. Scale is metres of radius (geometry is unit radius).
    if (this._ringLife > 0 && this._ring) {
      this._ringLife -= dt;
      if (this._ringLife <= 0) {
        this._ringLife = 0;
        this._ring.visible = false;
        this._ringMat.opacity = 0;
      } else {
        const t = 1 - this._ringLife / this._ringMax;   // 0 → 1
        const radius = 1.5 + 52 * t;                     // ~48 m/s pressure front
        this._ring.scale.set(radius, radius, 1);
        this._ringMat.opacity = 0.85 * (1 - t) * (1 - t);
      }
    }

    const d = this._deto;
    if (!d.active) return;
    d.t += dt;
    if (d.t >= 3.2) { d.active = false; return; }
    if (d.t < d.next) return;
    d.next += 0.14;

    // The column is STACKED up a height ramp rather than left to buoyancy alone: the
    // emission head climbs to ~+32 m over the first ~1.8 s, so the plume clears any
    // roof over an indoor site within a second and then keeps drifting up on its own
    // lift. This is the piece that makes the detonation legible from the far corner —
    // a viewer whose sightline to the site is walled off still gets a 30 m tower of
    // fire-then-smoke over the skyline.
    const head = 3 + 33 * clamp(d.t / 1.8, 0, 1);
    // Low churn at the base…
    _v3.set(d.x + (rnd() - 0.5) * 2, d.groundY + 1 + rnd() * 3, d.z + (rnd() - 0.5) * 2);
    this.particles.emit('bombSmokeColumn', _v3, _up, d.t < 1.2 ? 0.7 : 0.4, -Infinity);
    // …a mid-column fill so the tower is continuous rather than a bead chain…
    _v3.set(d.x + (rnd() - 0.5) * 2.5, d.groundY + head * (0.3 + rnd() * 0.35),
      d.z + (rnd() - 0.5) * 2.5);
    this.particles.emit('bombSmokeColumn', _v3, _up, 0.8, -Infinity);
    // …and the rising head, with fire licking up it. The head is the densest part —
    // above the roofline it is all a distant viewer gets of the smoke tower.
    _v3.set(d.x + (rnd() - 0.5) * 2.5, d.groundY + head * (0.75 + rnd() * 0.25),
      d.z + (rnd() - 0.5) * 2.5);
    this.particles.emit('bombSmokeColumn', _v3, _up, 1.5, -Infinity);
    if (d.t < 1.7) {
      this.particles.emit('bombFireColumn', _v3, _up, 1.0, -Infinity);
      // A big hot card at the head: this is the part of the climbing fire that BLOOMS,
      // and at 60-plus metres it is most of what sells the column as burning.
      this.flashWorld.spawn(_v3.x, _v3.y + 1.5, _v3.z, 6, 14, 0.4 + rnd() * 0.25,
        7.5, 3.2, 0.8, 1.3, 0.28, 0.05, 2, rnd() < 0.5 ? -2 : 2);
    }
    if (d.t < 0.6 && rnd() < 0.6) {
      _v3.set(d.x, d.groundY + 0.3, d.z);
      this.particles.emit('explosionEmbers', _v3, _up, 1.2,
        d.grounded ? d.groundY : -Infinity);
    }
  }

  /** §8 `smokeTrail(from, to)` — puffs along a segment (grenade / rocket trails). */
  smokeTrail(from, to) {
    if (!this.enabled || !this.particles.groups) return;
    _v1.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const len = _v1.length();
    if (len < 0.001) return;
    _v1.multiplyScalar(1 / len);
    const step = 1.1;
    const n = Math.min(8, Math.max(1, Math.floor(len / step)));
    for (let i = 0; i < n; i++) {
      const t = (i + rnd()) / n;
      _v2.set(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t);
      this.particles.emit('smokePuff', _v2, _v1, 0.35, -Infinity);
    }
  }

  /**
   * §8 `shellEject(position, dir, kind)` — a real tumbling brass casing.
   * One downward `world.raycast` per bounce (max 3) keeps this effectively free.
   */
  shellEject(position, dir, kind = 'rifle') {
    if (!this.enabled || !this.shells) return;
    const k = SHELL_KINDS[kind] || SHELL_KINDS.rifle;

    let i;
    if (this._shellCount < SHELL_CAP) i = this._shellCount++;
    else {
      i = 0;
      let best = Infinity;
      for (let s = 0; s < SHELL_CAP; s++) if (this._shellLife[s] < best) { best = this._shellLife[s]; i = s; }
    }

    _v1.set(dir.x, dir.y, dir.z);
    if (_v1.lengthSq() < 1e-8) _v1.set(1, 0.4, 0);
    _v1.normalize();

    const i3 = i * 3, i4 = i * 4;
    this._shellPos[i3] = position.x;
    this._shellPos[i3 + 1] = position.y;
    this._shellPos[i3 + 2] = position.z;
    const sp = 1.8 + rnd() * 1.4;
    this._shellVel[i3] = _v1.x * sp + (rnd() - 0.5) * 0.5;
    this._shellVel[i3 + 1] = _v1.y * sp + 1.1 + rnd() * 0.5;
    this._shellVel[i3 + 2] = _v1.z * sp + (rnd() - 0.5) * 0.5;

    _q1.setFromAxisAngle(_up, rnd() * Math.PI * 2);
    this._shellQuat[i4] = _q1.x; this._shellQuat[i4 + 1] = _q1.y;
    this._shellQuat[i4 + 2] = _q1.z; this._shellQuat[i4 + 3] = _q1.w;

    _v2.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5);
    if (_v2.lengthSq() < 1e-6) _v2.set(1, 0, 0);
    _v2.normalize();
    this._shellSpin[i4] = _v2.x;
    this._shellSpin[i4 + 1] = _v2.y;
    this._shellSpin[i4 + 2] = _v2.z;
    this._shellSpin[i4 + 3] = 14 + rnd() * 16;

    this._shellLife[i] = 3.6 + rnd() * 1.2;
    this._shellMaxLife[i] = this._shellLife[i];
    this._shellScale[i] = k.scale;
    this._shellBounces[i] = 0;
    this._shellFloor[i] = this._groundBelow(position.x, position.y, position.z);

    _col.setRGB(k.r, k.g, k.b);
    this.shells.setColorAt(i, _col);
    if (this.shells.instanceColor) this.shells.instanceColor.needsUpdate = true;

    // A wisp of smoke off the hot brass.
    this.particles.emit('shellSmoke', position, _up, 1, -Infinity);
  }

  /** §8 `screenShake(amount, duration)` → routes to the player camera. */
  screenShake(amount, duration = 0.3) {
    this.game.player?.camera?.shake?.(amount, duration);
  }

  /**
   * Pooled micro-light for a bullet impact. Never more than MAX_LIGHTS concurrently —
   * the pool steals the dimmest live light rather than adding a new one.
   */
  bulletImpactFlash(point, r = 1, g = 0.72, b = 0.36, intensity = 1.6, life = 0.06) {
    if (!this.enabled) return;
    this._light(point.x, point.y, point.z, r, g, b, intensity, life, 2);
  }

  // ================================================================ update

  update(dtFrame) {
    // P3-07 sector streaming (level.js `createSectorStreaming`). Lives on the world
    // group's userData so no CC-owned object grows a property; driven from the FX
    // facade because this is the CX-owned once-per-frame hook. The local player's feet
    // are the §5.1 viewpoint; a dead player's last position stands in for the
    // last-alive-sector rule, and a missing player fails open inside the controller.
    const streaming = this.game.world?.group?.userData?.sectorStreaming;
    if (streaming) streaming.update(dtFrame, this.game.player?.position ?? null);
    // Bomb-site ground rings: world-space objective markers (replaces the old
    // projected DOM markers). Guarded internally; independent of the pools below.
    this.siteRings.update(dtFrame);
    if (!this.particles.groups) return;
    const dt = dtFrame > 0.1 ? 0.1 : dtFrame;

    this.particles.quality = this.quality;
    this.particles.update(dt);
    this.decals.update(dt);
    this.tracers.update(dt);
    this.flashWorld.update(dt);
    this.flashView.update(dt);
    this._updateLights(dt);
    this._updateShells(dt);
    this._updateDetonation(dt);
  }

  reset() {
    this.particles.clear();
    this.decals.clear();
    this.tracers.clear();
    this.siteRings.reset();
    this.flashWorld?.clear();
    this.flashView?.clear();
    this._shellCount = 0;
    if (this.shells) this.shells.count = 0;
    this._deto.active = false;
    this._ringLife = 0;
    if (this._ring) { this._ring.visible = false; this._ringMat.opacity = 0; }
    if (this.lights) {
      for (let i = 0; i < MAX_LIGHTS; i++) {
        this.lights[i].intensity = 0;
        this._lightLife[i] = 0;
      }
    }
  }

  dispose() {
    this.particles.dispose();
    this.decals.dispose();
    this.tracers.dispose();
    this.siteRings.dispose();
    if (this.flashWorld) { this.game.scene?.remove(this.flashWorld.mesh); this.flashWorld.dispose(); }
    if (this.flashView) { this.game.engine?.viewScene?.remove(this.flashView.mesh); this.flashView.dispose(); }
    if (this.shells) {
      this.game.scene?.remove(this.shells);
      this.shells.dispose();
      this._shellGeo?.dispose();
    }
    if (this.lights) for (let i = 0; i < MAX_LIGHTS; i++) this.game.scene?.remove(this.lights[i]);
    this.lights = null;
    for (const un of this._busUnsubs) { try { un(); } catch { /* ignore */ } }
    this._busUnsubs.length = 0;
    if (this._ring) {
      this.game.scene?.remove(this._ring);
      this._ringGeo?.dispose();
      this._ringMat?.dispose();
      this._ring = null;
    }
  }

  /** Live pool occupancy — handy for the debug overlay. */
  debugInfo(out) {
    out = out || {};
    out.particles = this.particles.liveCount;
    out.decals = this.decals.liveCount;
    out.decalCap = DECAL_CAP;
    out.tracers = this.tracers.liveCount;
    out.shells = this._shellCount;
    out.flashes = (this.flashWorld?.count || 0) + (this.flashView?.count || 0);
    out.lights = this._liveLights();
    // Counted, never asserted. This used to be a hardcoded `9`, which is a claim rather
    // than a measurement and silently goes stale the first time anyone adds a batch.
    // Every one of these is a single always-resident mesh, so the sum IS the draw-call
    // contribution of the whole facade (the point lights contribute none).
    out.drawCalls =
      (this.particles?.groups ? Object.keys(this.particles.groups).length : 0)
      + (this.decals?.mesh ? 1 : 0)
      + (this.tracers?.batch ? 1 : 0)
      + (this.tracers?.vapour ? 1 : 0)
      + (this.flashWorld ? 1 : 0)
      + (this.flashView ? 1 : 0)
      + (this.shells ? 1 : 0)
      + (this.siteRings?.meshes?.length || 0)
      + (this._ring ? 1 : 0);
    return out;
  }

  // ================================================================ internals

  _play(name, position, volume = 1, rate = 1) {
    const audio = this.game.audio;
    if (!audio?.play) return;
    _audioOpts.position = position;
    _audioOpts.volume = volume;
    _audioOpts.rate = rate;
    _audioOpts.delay = 0;
    audio.play(name, _audioOpts);
    _audioOpts.position = null;
  }

  _liveLights() {
    let n = 0;
    for (let i = 0; i < MAX_LIGHTS; i++) if (this._lightLife[i] > 0) n++;
    return n;
  }

  _light(x, y, z, r, g, b, intensity, life, pow = 2, distance = 9) {
    if (!this.lights) return;
    let idx = -1;
    for (let i = 0; i < MAX_LIGHTS; i++) {
      if (this._lightLife[i] <= 0) { idx = i; break; }
    }
    if (idx < 0) {
      // Steal the dimmest — never exceed the light cap.
      let weakest = Infinity;
      for (let i = 0; i < MAX_LIGHTS; i++) {
        const cur = this.lights[i].intensity;
        if (cur < weakest) { weakest = cur; idx = i; }
      }
      if (this.lights[idx].intensity > intensity) return; // not worth stealing
    }
    const l = this.lights[idx];
    l.position.set(x, y, z);
    l.color.setRGB(r, g, b);
    l.intensity = intensity;
    l.distance = distance;
    // NOTE: never touch `l.visible` — see the pool comment in init().
    this._lightLife[idx] = life;
    this._lightMax[idx] = life;
    this._lightI0[idx] = intensity;
    this._lightPow[idx] = pow;
  }

  _updateLights(dt) {
    if (!this.lights) return;
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = this._lightLife[i];
      if (l <= 0) continue;
      const nl = l - dt;
      if (nl <= 0) {
        this._lightLife[i] = 0;
        // Intensity 0 is the whole retirement — see the pool comment in init().
        this.lights[i].intensity = 0;
        continue;
      }
      this._lightLife[i] = nl;
      const t = nl / this._lightMax[i];
      const p = this._lightPow[i];
      this.lights[i].intensity = this._lightI0[i] * (p === 3 ? t * t * t : p === 2 ? t * t : t);
    }
  }

  _groundBelow(x, y, z) {
    const world = this.game.world;
    if (!world?.raycast) return y - 1.2;
    _v4.set(x, y, z);
    const hit = world.raycast(_v4, _down, 4);
    return hit ? hit.point.y : -Infinity;
  }

  _updateShells(dt) {
    const mesh = this.shells;
    if (!mesh) return;
    let i = 0;
    while (i < this._shellCount) {
      let life = this._shellLife[i] - dt;
      if (life <= 0) { this._killShell(i); continue; }
      this._shellLife[i] = life;

      const i3 = i * 3, i4 = i * 4;
      let vx = this._shellVel[i3], vy = this._shellVel[i3 + 1], vz = this._shellVel[i3 + 2];
      vy += WORLD_GRAVITY * dt;
      let px = this._shellPos[i3] + vx * dt;
      let py = this._shellPos[i3 + 1] + vy * dt;
      let pz = this._shellPos[i3 + 2] + vz * dt;

      const floor = this._shellFloor[i];
      if (py <= floor && vy < 0) {
        const b = this._shellBounces[i];
        if (b < 3) {
          this._shellBounces[i] = b + 1;
          py = floor;
          vy = -vy * 0.34;
          vx *= 0.62; vz *= 0.62;
          this._shellSpin[i4 + 3] *= 0.55;
          _v4.set(px, py, pz);
          this._play('grenadeBounce', _v4, 0.09 + 0.04 * rnd(), 2.6 + rnd() * 0.7);
          // The floor may change as the casing skips along; re-probe.
          this._shellFloor[i] = this._groundBelow(px, py + 0.4, pz);
        } else {
          py = floor;
          vy = 0; vx *= 0.2; vz *= 0.2;
          this._shellSpin[i4 + 3] = 0;
        }
      }

      this._shellVel[i3] = vx; this._shellVel[i3 + 1] = vy; this._shellVel[i3 + 2] = vz;
      this._shellPos[i3] = px; this._shellPos[i3 + 1] = py; this._shellPos[i3 + 2] = pz;

      // Tumble.
      const spin = this._shellSpin[i4 + 3];
      _q1.set(this._shellQuat[i4], this._shellQuat[i4 + 1], this._shellQuat[i4 + 2], this._shellQuat[i4 + 3]);
      if (spin > 0.001) {
        _v4.set(this._shellSpin[i4], this._shellSpin[i4 + 1], this._shellSpin[i4 + 2]);
        _q2.setFromAxisAngle(_v4, spin * dt);
        _q1.multiply(_q2).normalize();
        this._shellQuat[i4] = _q1.x; this._shellQuat[i4 + 1] = _q1.y;
        this._shellQuat[i4 + 2] = _q1.z; this._shellQuat[i4 + 3] = _q1.w;
      }

      // Shrink away over the last 0.35 s instead of popping (shared material → no fade).
      let sc = this._shellScale[i];
      if (life < 0.35) sc *= life / 0.35;
      _v4.set(px, py, pz);
      _scale.set(sc, sc, sc);
      _mat.compose(_v4, _q1, _scale);
      mesh.setMatrixAt(i, _mat);
      i++;
    }
    mesh.count = this._shellCount;
    if (this._shellCount > 0) mesh.instanceMatrix.needsUpdate = true;
  }

  _killShell(i) {
    const last = --this._shellCount;
    if (i === last) return;
    const i3 = i * 3, l3 = last * 3, i4 = i * 4, l4 = last * 4;
    for (let k = 0; k < 3; k++) {
      this._shellPos[i3 + k] = this._shellPos[l3 + k];
      this._shellVel[i3 + k] = this._shellVel[l3 + k];
    }
    for (let k = 0; k < 4; k++) {
      this._shellQuat[i4 + k] = this._shellQuat[l4 + k];
      this._shellSpin[i4 + k] = this._shellSpin[l4 + k];
    }
    this._shellLife[i] = this._shellLife[last];
    this._shellMaxLife[i] = this._shellMaxLife[last];
    this._shellScale[i] = this._shellScale[last];
    this._shellFloor[i] = this._shellFloor[last];
    this._shellBounces[i] = this._shellBounces[last];
    if (this.shells.instanceColor) {
      const c = this.shells.instanceColor.array;
      c[i3] = c[l3]; c[i3 + 1] = c[l3 + 1]; c[i3 + 2] = c[l3 + 2];
      this.shells.instanceColor.needsUpdate = true;
    }
  }
}
