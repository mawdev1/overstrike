import * as THREE from 'three';
import { createRNG } from '../core/rng.js';

/**
 * OVERSTRIKE — pooled GPU particle system.
 *
 * Design notes
 * ------------
 * • Three `THREE.Points` batches (three draw calls total) grouped by blending mode +
 *   source texture:
 *     'add'    — additive, 'glow' texture   → sparks, embers, fireballs (colours > 1 so
 *                the UnrealBloomPass in engine.js picks them up after ACES).
 *     'smoke'  — normal blended, 'smoke'    → dust, smoke, blood mist, water spray.
 *     'debris' — normal blended, 'glow' with a hardened alpha ramp → chips, splinters,
 *                shards, blood droplets (reads as a solid speck, not a soft blob).
 * • Every buffer is preallocated in `init()`. Live particles are kept **packed** in
 *   `[0, count)` — the tail of each array *is* the free list, so recycling a dead
 *   particle is a swap-remove with zero allocation and the per-frame upload range is
 *   exactly the live set (`addUpdateRange(0, count * itemSize)`), never the 4000-slot
 *   capacity.
 * • Emitters are frozen data presets. `emit()` performs no allocation whatsoever:
 *   all vector maths runs through module-scope scratch vectors.
 *
 * Simulation is visual-only and runs on the real frame delta (§2 lifecycle).
 */

const TAU = Math.PI * 2;
const WORLD_GRAVITY = -22; // ARCHITECTURE §1

/**
 * Point-size clamps, expressed as a FRACTION OF THE DRAWING BUFFER HEIGHT rather than
 * as an absolute pixel count.
 *
 * `gl_PointSize` is in pixels, so a fixed px clamp means a completely different sprite
 * at every resolution: the old flat 512 let one smoke puff cover 28% of a 720p screen,
 * 12.6% of 1080p and 7.1% of 1440p — the same explosion was three different effects,
 * and the cheapest configuration (low `renderScale`, the one §11 actually targets) got
 * the *most* expensive smoke. Because the projected size of a sprite is
 * `world * 0.5 * proj[1][1] / dist` in units of buffer heights, a fraction of the
 * buffer height is the resolution-invariant quantity: pick it once and the effect
 * looks identical, and costs the same share of the frame, everywhere.
 *
 * Values are tuned by eye against `scripts/fillprobe.mjs` screenshots (frag at 3/6/12 m,
 * smoke cloud from inside):
 *   smoke 0.34 — a 4.42 m explosion column at 3 m still reads as one solid bank; at
 *                0.27 it visibly breaks into separate blobs, so 0.34 keeps a margin.
 *   add   0.38 — additive is the fireball. It is looser than the smoke because a
 *                grenade at your feet SHOULD fill the view with fire, and because the
 *                measured additive term is a third of the smoke term to begin with.
 *   debris 0.27 — debris sprites are centimetres across and never reach this; it exists
 *                only to bound a pathological near-camera case.
 */
const MAX_SIZE_FRAC = { smoke: 0.34, debris: 0.27, add: 0.38 };
const FALLBACK_BUFFER_H = 720;

/** Private stream — never touch `game.rng`, that one is simulation-deterministic. */
const rnd = createRNG(0x51ed17a3);

// ---------------------------------------------------------------- scratch (module scope, §1)
const _dir = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _alt = new THREE.Vector3(1, 0, 0);
const _drawSize = new THREE.Vector2();

// ---------------------------------------------------------------- presets

const MODE_CONE = 0;
const MODE_PLANE = 1;
const MODE_SPHERE = 2;

const MODES = { cone: MODE_CONE, plane: MODE_PLANE, sphere: MODE_SPHERE };

/**
 * Fade curve ids — evaluated in the vertex shader.
 *   0 linear · 1 spark (sharp attack, quadratic decay) · 2 smoke (fade in, long out)
 *   3 hot flash (near-instant, fast out) · 4 flicker (ember crackle)
 */
function def(o) {
  const c = o.color || [1, 1, 1];
  const ce = o.colorEnd || c;
  return Object.freeze({
    group: o.group || 'add',
    mode: MODES[o.mode || 'cone'],
    countMin: o.count ? o.count[0] : 4,
    countMax: o.count ? o.count[1] : 8,
    lifeMin: o.life ? o.life[0] : 0.4,
    lifeMax: o.life ? o.life[1] : 0.8,
    speedMin: o.speed ? o.speed[0] : 1,
    speedMax: o.speed ? o.speed[1] : 3,
    cone: o.cone !== undefined ? o.cone : 0.6,
    sizeMin: o.size ? o.size[0] : 0.05,
    sizeMax: o.size ? o.size[1] : 0.1,
    sizeEnd: o.sizeEnd !== undefined ? o.sizeEnd : 1,
    r0: c[0], g0: c[1], b0: c[2],
    r1: ce[0], g1: ce[1], b1: ce[2],
    vary: o.vary !== undefined ? o.vary : 0.12,
    drag: o.drag !== undefined ? o.drag : 1,
    gravity: o.gravity !== undefined ? o.gravity : 0,
    curve: o.curve !== undefined ? o.curve : 0,
    spin: o.spin !== undefined ? o.spin : 0,
    offset: o.offset !== undefined ? o.offset : 0,
    scatter: o.scatter !== undefined ? o.scatter : 0,
    upBias: o.upBias !== undefined ? o.upBias : 0,
    bounce: o.bounce !== undefined ? o.bounce : 0,
  });
}

export const PARTICLE_PRESETS = Object.freeze({
  // --- impacts -------------------------------------------------------------
  sparks: def({
    group: 'add', count: [3, 6], life: [0.12, 0.3], speed: [4, 10], cone: 0.85,
    size: [0.03, 0.055], sizeEnd: 0.2, color: [6.0, 3.4, 1.2], colorEnd: [2.2, 0.45, 0.06],
    drag: 2.4, gravity: 0.8, curve: 1, scatter: 0.02,
  }),
  metalSparks: def({
    group: 'add', count: [12, 20], life: [0.16, 0.48], speed: [6, 16], cone: 1.05,
    size: [0.025, 0.05], sizeEnd: 0.12, color: [10.0, 5.6, 1.8], colorEnd: [3.4, 0.6, 0.08],
    drag: 1.7, gravity: 1.1, curve: 4, bounce: 0.3, scatter: 0.02,
  }),
  dust: def({
    group: 'smoke', count: [4, 7], life: [0.5, 1.0], speed: [0.5, 1.7], cone: 1.0,
    size: [0.18, 0.34], sizeEnd: 2.6, color: [0.62, 0.60, 0.57], colorEnd: [0.5, 0.49, 0.47],
    drag: 2.6, gravity: -0.02, curve: 2, spin: 1.2, scatter: 0.05,
  }),
  concreteChips: def({
    group: 'debris', count: [5, 9], life: [0.5, 1.1], speed: [2, 6], cone: 0.9,
    size: [0.02, 0.045], sizeEnd: 0.9, color: [0.56, 0.55, 0.51],
    drag: 0.6, gravity: 1, curve: 0, spin: 8, bounce: 0.25, scatter: 0.03,
  }),
  woodSplinters: def({
    group: 'debris', count: [6, 11], life: [0.5, 1.2], speed: [2.5, 6.5], cone: 0.95,
    size: [0.018, 0.05], sizeEnd: 0.85, color: [0.44, 0.30, 0.16],
    drag: 0.7, gravity: 1, curve: 0, spin: 10, bounce: 0.2, scatter: 0.03,
  }),
  glassShards: def({
    group: 'debris', count: [9, 16], life: [0.7, 1.4], speed: [2, 6], cone: 1.15,
    size: [0.02, 0.05], sizeEnd: 0.9, color: [0.82, 0.98, 1.08], colorEnd: [0.6, 0.74, 0.84],
    drag: 0.5, gravity: 1, curve: 0, spin: 12, bounce: 0.35, scatter: 0.04,
  }),
  bloodMist: def({
    group: 'smoke', count: [5, 9], life: [0.35, 0.7], speed: [1, 3.2], cone: 1.0,
    size: [0.1, 0.22], sizeEnd: 2.2, color: [0.34, 0.03, 0.035], colorEnd: [0.16, 0.02, 0.02],
    drag: 3.5, gravity: 0.15, curve: 2, scatter: 0.04,
  }),
  bloodDroplets: def({
    group: 'debris', count: [8, 14], life: [0.4, 0.9], speed: [2.5, 7], cone: 0.9,
    size: [0.015, 0.035], sizeEnd: 0.8, color: [0.36, 0.02, 0.02],
    drag: 0.8, gravity: 1.15, curve: 0, spin: 4, scatter: 0.03,
  }),
  smokePuff: def({
    group: 'smoke', count: [2, 4], life: [1.1, 2.0], speed: [0.3, 1.0], cone: 1.2,
    size: [0.3, 0.55], sizeEnd: 3.2, color: [0.33, 0.33, 0.35], colorEnd: [0.42, 0.42, 0.44],
    drag: 1.8, gravity: -0.03, curve: 2, spin: 0.8, scatter: 0.08,
  }),

  // --- explosions ----------------------------------------------------------
  explosionFireball: def({
    group: 'add', count: [14, 20], life: [0.28, 0.5], speed: [3, 9], cone: 1.6,
    size: [0.5, 1.1], sizeEnd: 2.2, color: [7.0, 3.2, 0.8], colorEnd: [1.6, 0.28, 0.05],
    drag: 3.2, gravity: -0.1, curve: 3, spin: 3, scatter: 0.15,
  }),
  explosionSmoke: def({
    group: 'smoke', count: [16, 24], life: [1.6, 3.2], speed: [1.5, 5], cone: 1.5,
    size: [0.6, 1.3], sizeEnd: 3.4, color: [0.14, 0.13, 0.13], colorEnd: [0.36, 0.35, 0.34],
    drag: 1.5, gravity: -0.05, curve: 2, spin: 1, scatter: 0.2, upBias: 1.4,
  }),
  /** Extra (beyond the required set): the ground-hugging shockwave ring of an explosion. */
  explosionDustRing: def({
    group: 'smoke', mode: 'plane', count: [10, 16], life: [0.7, 1.4], speed: [6, 13],
    size: [0.35, 0.7], sizeEnd: 3.6, color: [0.44, 0.42, 0.39], colorEnd: [0.34, 0.33, 0.31],
    drag: 2.2, gravity: -0.01, curve: 2, spin: 1.4, upBias: 0.5, scatter: 0.12,
  }),
  explosionEmbers: def({
    group: 'add', mode: 'sphere', count: [18, 28], life: [0.5, 1.3], speed: [4, 14], cone: 1.9,
    size: [0.03, 0.07], sizeEnd: 0.3, color: [8.0, 3.4, 0.7], colorEnd: [2.6, 0.4, 0.05],
    drag: 1.1, gravity: 0.9, curve: 4, bounce: 0.3, scatter: 0.1,
  }),

  // --- bomb detonation ------------------------------------------------------
  //
  // The site column. Both presets are authored for LANDMARK scale: metres-wide sprites,
  // multi-second lives and a strong buoyancy term (negative gravity => lift against
  // WORLD_GRAVITY, terminal rise ≈ 22·|g|/drag m/s), so the plume climbs 25-35 m and
  // stays readable from the far corner of the 88 m map. Deliberately NOT reused for
  // frags — `fx.bombDetonation()` is the only caller.
  bombFireColumn: def({
    group: 'add', count: [16, 22], life: [0.8, 1.7], speed: [8, 20], cone: 0.32,
    size: [1.6, 3.2], sizeEnd: 2.8, color: [7.5, 3.1, 0.7], colorEnd: [1.7, 0.28, 0.04],
    drag: 1.2, gravity: -0.45, curve: 3, spin: 2.2, scatter: 1.2, upBias: 2.6,
  }),
  bombSmokeColumn: def({
    group: 'smoke', count: [16, 24], life: [5, 8.5], speed: [6, 13], cone: 0.26,
    size: [2.2, 4.0], sizeEnd: 4.6, color: [0.2, 0.19, 0.18], colorEnd: [0.5, 0.49, 0.47],
    drag: 0.75, gravity: -0.28, curve: 2, spin: 0.7, scatter: 1.6, upBias: 2.4,
  }),

  // --- weapon / ambient ----------------------------------------------------
  muzzleSmoke: def({
    group: 'smoke', count: [2, 4], life: [0.35, 0.8], speed: [1.2, 3.2], cone: 0.35,
    size: [0.06, 0.14], sizeEnd: 4.0, color: [0.46, 0.45, 0.43], colorEnd: [0.4, 0.4, 0.4],
    drag: 4.5, gravity: -0.05, curve: 2, spin: 2, offset: 0.12,
  }),
  footstepDust: def({
    group: 'smoke', mode: 'plane', count: [2, 4], life: [0.4, 0.8], speed: [0.4, 1.2],
    size: [0.12, 0.24], sizeEnd: 2.4, color: [0.55, 0.5, 0.44], colorEnd: [0.46, 0.43, 0.39],
    drag: 3, gravity: -0.01, curve: 2, spin: 1, upBias: 0.35, scatter: 0.06,
  }),
  shellSmoke: def({
    group: 'smoke', count: [1, 2], life: [0.25, 0.5], speed: [0.3, 0.9], cone: 0.9,
    size: [0.035, 0.075], sizeEnd: 3.0, color: [0.5, 0.49, 0.47],
    drag: 5, gravity: -0.04, curve: 2, spin: 2,
  }),
  waterSplash: def({
    group: 'smoke', count: [8, 14], life: [0.4, 0.85], speed: [2, 6], cone: 0.7,
    size: [0.05, 0.12], sizeEnd: 1.6, color: [0.78, 0.88, 0.95], colorEnd: [0.6, 0.7, 0.78],
    drag: 1.6, gravity: 1.0, curve: 2, upBias: 1.2, scatter: 0.05,
  }),
});

// ---------------------------------------------------------------- shaders

const PARTICLE_VERT = /* glsl */`
  uniform float uScale;     // 0.5 * drawingBufferHeight * proj[1][1]
  uniform float uMaxSize;   // px clamp — bounds overdraw for near particles

  attribute vec3 aColor;
  attribute float aSize;
  attribute vec4 aParams;   // x: age 0..1, y: roll, z: curve id, w: seed

  varying vec3 vColor;
  varying float vAlpha;
  varying float vRot;
  varying float vFogDepth;

  float curveAlpha(float t, float id, float seed) {
    if (id < 0.5) return 1.0 - t;
    if (id < 1.5) { float x = 1.0 - t; return x * x; }
    if (id < 2.5) return smoothstep(0.0, 0.16, t) * (1.0 - smoothstep(0.28, 1.0, t));
    if (id < 3.5) { float x = 1.0 - t; return sqrt(x) * x; }
    return (1.0 - t) * (0.55 + 0.45 * sin(t * 42.0 + seed * 6.2831));
  }

  void main() {
    vColor = aColor;
    vRot = aParams.y;
    vAlpha = clamp(curveAlpha(aParams.x, aParams.z, aParams.w), 0.0, 1.0);

    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vFogDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
    gl_PointSize = min(aSize * uScale / max(-mvPosition.z, 0.05), uMaxSize);
  }
`;

// NOTE: three's fragment prefix already declares tonemapping/colorspace helpers for
// ShaderMaterial, so only the *_fragment chunks may be included here.
const PARTICLE_FRAG = /* glsl */`
  uniform sampler2D uMap;
  uniform float uHard;      // 0 = soft sprite, 1 = hardened speck
  uniform float uFogMode;   // 0 = additive (fade to black), 1 = alpha (mix to fog colour)
  uniform vec3 fogColor;
  uniform float fogDensity;
  uniform float fogNear;
  uniform float fogFar;

  #ifdef SOFT_PARTICLES
    uniform sampler2D uDepth;   // scene depth, NOT the buffer we are drawing into
    uniform vec2 uInvRes;       // 1 / drawingBufferSize
    uniform vec2 uNearFar;      // camera.near, camera.far
    uniform float uSoftDist;    // metres over which a sprite fades into geometry
  #endif

  varying vec3 vColor;
  varying float vAlpha;
  varying float vRot;
  varying float vFogDepth;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float c = cos(vRot), s = sin(vRot);
    uv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y) + 0.5;

    vec4 tex = texture2D(uMap, uv);
    float soft = tex.a;
    float hard = smoothstep(0.30, 0.62, tex.a);
    float a = mix(soft, hard, uHard) * vAlpha;

    #ifdef SOFT_PARTICLES
      // Depth fade. Without it every sprite hard-cuts against geometry and a smoke
      // bank reads as a stack of cards leaning on the wall behind it. Linearising a
      // perspective depth buffer: dist = n*f / (f - d*(f-n)); d == 1 (sky) gives far,
      // so open sky never fades anything. vFogDepth is the sprite CENTRE's view
      // depth — the standard point-sprite approximation, and correct to well within a
      // sprite radius for the soft blobs this actually matters for.
      float d = texture2D(uDepth, gl_FragCoord.xy * uInvRes).x;
      float sceneDist = (uNearFar.x * uNearFar.y) / (uNearFar.y - d * (uNearFar.y - uNearFar.x));
      a *= clamp((sceneDist - vFogDepth) / uSoftDist, 0.0, 1.0);
    #endif

    if (a < 0.004) discard;

    vec3 col = tex.rgb * vColor;

    float fd = fogDensity * vFogDepth;
    float fogFactor = 1.0 - exp(-fd * fd);
    col = mix(col * (1.0 - fogFactor), mix(col, fogColor, fogFactor), uFogMode);

    gl_FragColor = vec4(col, a);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------- helpers

/**
 * Upload only `[0, count)` of an attribute. `addUpdateRange()` allocates a range object
 * per call, so we keep one per attribute and re-push it — the renderer empties the array
 * after every upload, and pushing a retained object into an emptied array is free.
 */
function markRange(attr, count) {
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

/** Orthonormal basis around `_dir` → `_t1`, `_t2`. Allocation free. */
function basisFromDir() {
  const ax = Math.abs(_dir.y) > 0.95 ? _alt : _up;
  _t1.crossVectors(_dir, ax);
  if (_t1.lengthSq() < 1e-8) _t1.set(1, 0, 0);
  _t1.normalize();
  _t2.crossVectors(_t1, _dir).normalize();
}

// ---------------------------------------------------------------- system

class ParticleGroup {
  constructor(cap, texture, blending, hard, fogMode, renderOrder, maxSizeFrac) {
    this.cap = cap;
    this.count = 0;
    /** Point-size clamp as a fraction of drawing-buffer height — see MAX_SIZE_FRAC. */
    this.maxSizeFrac = maxSizeFrac;

    // GPU attributes
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.siz = new Float32Array(cap);
    this.par = new Float32Array(cap * 4);

    // CPU-only state
    this.vel = new Float32Array(cap * 3);
    this.cA = new Float32Array(cap * 3);
    this.cB = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.s0 = new Float32Array(cap);
    this.s1 = new Float32Array(cap);
    this.spin = new Float32Array(cap);
    this.floor = new Float32Array(cap);
    this.rest = new Float32Array(cap);

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    this.sizAttr = new THREE.BufferAttribute(this.siz, 1).setUsage(THREE.DynamicDrawUsage);
    this.parAttr = new THREE.BufferAttribute(this.par, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aColor', this.colAttr);
    geo.setAttribute('aSize', this.sizAttr);
    geo.setAttribute('aParams', this.parAttr);
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geo = geo;

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uScale: { value: 600 },
        uMaxSize: { value: maxSizeFrac * FALLBACK_BUFFER_H },
        uHard: { value: hard },
        uFogMode: { value: fogMode },
        fogColor: { value: new THREE.Color(0x8b98ab) },
        fogDensity: { value: 0.0075 },
        fogNear: { value: 1 },
        fogFar: { value: 400 },
        // Soft-particle block. Inert (and stripped from the compiled program) unless
        // ParticleSystem.setSceneDepth() turns the SOFT_PARTICLES define on.
        uDepth: { value: null },
        uInvRes: { value: new THREE.Vector2(1 / 1280, 1 / FALLBACK_BUFFER_H) },
        uNearFar: { value: new THREE.Vector2(0.05, 900) },
        uSoftDist: { value: 0.65 },
      },
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending,
      fog: true,
    });

    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    this.points.matrixAutoUpdate = false;
    this.points.updateMatrix();
  }

  /** Swap-remove: the tail of the packed range doubles as the free list. */
  kill(i) {
    const last = --this.count;
    if (i === last) return;
    const i3 = i * 3, l3 = last * 3, i4 = i * 4, l4 = last * 4;
    this.pos[i3] = this.pos[l3]; this.pos[i3 + 1] = this.pos[l3 + 1]; this.pos[i3 + 2] = this.pos[l3 + 2];
    this.col[i3] = this.col[l3]; this.col[i3 + 1] = this.col[l3 + 1]; this.col[i3 + 2] = this.col[l3 + 2];
    this.vel[i3] = this.vel[l3]; this.vel[i3 + 1] = this.vel[l3 + 1]; this.vel[i3 + 2] = this.vel[l3 + 2];
    this.cA[i3] = this.cA[l3]; this.cA[i3 + 1] = this.cA[l3 + 1]; this.cA[i3 + 2] = this.cA[l3 + 2];
    this.cB[i3] = this.cB[l3]; this.cB[i3 + 1] = this.cB[l3 + 1]; this.cB[i3 + 2] = this.cB[l3 + 2];
    this.par[i4] = this.par[l4]; this.par[i4 + 1] = this.par[l4 + 1];
    this.par[i4 + 2] = this.par[l4 + 2]; this.par[i4 + 3] = this.par[l4 + 3];
    this.siz[i] = this.siz[last];
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.drag[i] = this.drag[last];
    this.grav[i] = this.grav[last];
    this.s0[i] = this.s0[last];
    this.s1[i] = this.s1[last];
    this.spin[i] = this.spin[last];
    this.floor[i] = this.floor[last];
    this.rest[i] = this.rest[last];
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
  }
}

export class ParticleSystem {
  constructor(game) {
    this.game = game;
    /** Global emit multiplier — lower it for weak GPUs. */
    this.quality = 1;
    this.groups = null;
    this._order = null;
    this._scene = null;
    this._soft = false;
  }

  init(scene) {
    if (this.groups) return;
    const tex = this.game.assets;
    const glow = tex.tex('glow');
    const smoke = tex.tex('smoke');

    // renderOrder: smoke/debris first, additive last so glow sits over the haze.
    // The point-size clamps bound fill cost — a smoke puff detonating in your face is
    // the single biggest overdraw risk in the whole FX budget. See MAX_SIZE_FRAC.
    this.groups = {
      smoke: new ParticleGroup(1600, smoke, THREE.NormalBlending, 0, 1, 8, MAX_SIZE_FRAC.smoke),
      debris: new ParticleGroup(1200, glow, THREE.NormalBlending, 1, 1, 9, MAX_SIZE_FRAC.debris),
      add: new ParticleGroup(1200, glow, THREE.AdditiveBlending, 0, 0, 10, MAX_SIZE_FRAC.add),
    };
    this._order = [this.groups.smoke, this.groups.debris, this.groups.add];

    this._scene = scene;
    for (let i = 0; i < this._order.length; i++) scene.add(this._order[i].points);
  }

  /**
   * Turn on soft particles (depth fade against scene geometry).
   *
   * PASS A DEPTH TEXTURE THAT IS **NOT** THE DEPTH ATTACHMENT OF THE FRAMEBUFFER THE
   * SCENE IS BEING RENDERED INTO. Sampling the attachment you are drawing into is a
   * feedback loop: undefined in WebGL, and engine.js already documents it hanging
   * outright under a software rasteriser (see the `renderTarget2.depthTexture` comment
   * there). Today the particles are drawn inside `RenderPass`, whose target owns that
   * depth texture, so this stays OFF until the engine can offer either a copy of the
   * depth buffer or a separate pass for the transparent layer. Everything on this side
   * is finished and costs nothing while it is off — the define is not set, so the fade
   * is not even compiled into the program.
   *
   * @param {?THREE.Texture} depthTexture  scene depth, or null to switch soft off
   * @param {THREE.Camera} [camera]        supplies near/far for linearisation
   * @param {number} [fadeDistance]        metres of fade at a geometry contact
   */
  setSceneDepth(depthTexture, camera, fadeDistance = 0.65) {
    if (!this._order) return;
    const on = !!depthTexture;
    this._soft = on;
    for (let i = 0; i < this._order.length; i++) {
      const mat = this._order[i].mat;
      const u = mat.uniforms;
      u.uDepth.value = depthTexture || null;
      u.uSoftDist.value = fadeDistance;
      if (camera) u.uNearFar.value.set(camera.near, camera.far);
      const has = mat.defines && mat.defines.SOFT_PARTICLES !== undefined;
      if (on === has) continue;
      mat.defines = mat.defines || {};
      if (on) mat.defines.SOFT_PARTICLES = '';
      else delete mat.defines.SOFT_PARTICLES;
      mat.needsUpdate = true;   // one recompile per toggle, never per frame
    }
  }

  get liveCount() {
    if (!this._order) return 0;
    let n = 0;
    for (let i = 0; i < this._order.length; i++) n += this._order[i].count;
    return n;
  }

  /**
   * Spawn a burst. Zero allocation.
   * @param {string} name     preset key
   * @param {THREE.Vector3} point  origin
   * @param {THREE.Vector3} dir    emission axis (need not be normalized)
   * @param {number} scale    count multiplier
   * @param {number} floorY   optional bounce plane (use -Infinity for none)
   */
  emit(name, point, dir, scale, floorY) {
    return this.emitTinted(name, point, dir, scale, floorY, 1, 1, 1);
  }

  /** As `emit`, with a per-burst colour multiplier (lets one preset serve dirt + concrete). */
  emitTinted(name, point, dir, scale = 1, floorY = -Infinity, tr = 1, tg = 1, tb = 1) {
    const p = PARTICLE_PRESETS[name];
    if (!p || !this.groups) return 0;
    const g = this.groups[p.group];

    let n = Math.round((p.countMin + rnd() * (p.countMax - p.countMin)) * scale * this.quality);
    if (n <= 0) return 0;
    const room = g.cap - g.count;
    if (n > room) n = room;
    if (n <= 0) return 0;

    if (dir) _dir.set(dir.x, dir.y, dir.z);
    else _dir.set(0, 1, 0);
    if (_dir.lengthSq() < 1e-8) _dir.set(0, 1, 0);
    _dir.normalize();
    basisFromDir();

    const dx = _dir.x, dy = _dir.y, dz = _dir.z;
    const t1x = _t1.x, t1y = _t1.y, t1z = _t1.z;
    const t2x = _t2.x, t2y = _t2.y, t2z = _t2.z;
    const ox = point.x + dx * p.offset;
    const oy = point.y + dy * p.offset;
    const oz = point.z + dz * p.offset;

    const cosMax = Math.cos(p.cone);
    const useFloor = floorY !== undefined && floorY > -1e30;

    for (let k = 0; k < n; k++) {
      const i = g.count++;
      const i3 = i * 3, i4 = i * 4;

      // --- direction
      let vx, vy, vz;
      const a = rnd() * TAU;
      if (p.mode === MODE_PLANE) {
        const ca = Math.cos(a), sa = Math.sin(a);
        vx = t1x * ca + t2x * sa;
        vy = t1y * ca + t2y * sa;
        vz = t1z * ca + t2z * sa;
      } else if (p.mode === MODE_SPHERE) {
        const cz = rnd() * 2 - 1;
        const sz = Math.sqrt(Math.max(0, 1 - cz * cz));
        const ca = Math.cos(a), sa = Math.sin(a);
        vx = dx * cz + (t1x * ca + t2x * sa) * sz;
        vy = dy * cz + (t1y * ca + t2y * sa) * sz;
        vz = dz * cz + (t1z * ca + t2z * sa) * sz;
      } else {
        const cz = 1 - rnd() * (1 - cosMax);
        const sz = Math.sqrt(Math.max(0, 1 - cz * cz));
        const ca = Math.cos(a), sa = Math.sin(a);
        vx = dx * cz + (t1x * ca + t2x * sa) * sz;
        vy = dy * cz + (t1y * ca + t2y * sa) * sz;
        vz = dz * cz + (t1z * ca + t2z * sa) * sz;
      }

      const sp = p.speedMin + rnd() * (p.speedMax - p.speedMin);
      g.vel[i3] = vx * sp;
      g.vel[i3 + 1] = vy * sp + p.upBias;
      g.vel[i3 + 2] = vz * sp;

      // --- position
      const sc = p.scatter;
      g.pos[i3] = ox + (sc > 0 ? (rnd() * 2 - 1) * sc : 0);
      g.pos[i3 + 1] = oy + (sc > 0 ? (rnd() * 2 - 1) * sc : 0);
      g.pos[i3 + 2] = oz + (sc > 0 ? (rnd() * 2 - 1) * sc : 0);

      // --- colour (start/end, with a little per-particle variance)
      const v = 1 + (rnd() * 2 - 1) * p.vary;
      g.cA[i3] = p.r0 * v * tr; g.cA[i3 + 1] = p.g0 * v * tg; g.cA[i3 + 2] = p.b0 * v * tb;
      g.cB[i3] = p.r1 * v * tr; g.cB[i3 + 1] = p.g1 * v * tg; g.cB[i3 + 2] = p.b1 * v * tb;
      g.col[i3] = g.cA[i3]; g.col[i3 + 1] = g.cA[i3 + 1]; g.col[i3 + 2] = g.cA[i3 + 2];

      // --- life / size / spin
      const life = p.lifeMin + rnd() * (p.lifeMax - p.lifeMin);
      const size = p.sizeMin + rnd() * (p.sizeMax - p.sizeMin);
      g.life[i] = life;
      g.maxLife[i] = life;
      g.s0[i] = size;
      g.s1[i] = size * p.sizeEnd;
      g.siz[i] = size;
      g.drag[i] = p.drag;
      g.grav[i] = p.gravity;
      g.spin[i] = p.spin > 0 ? (rnd() * 2 - 1) * p.spin : 0;
      g.floor[i] = useFloor ? floorY : -Infinity;
      g.rest[i] = p.bounce;

      g.par[i4] = 0;
      g.par[i4 + 1] = rnd() * TAU;
      g.par[i4 + 2] = p.curve;
      g.par[i4 + 3] = rnd();
    }
    return n;
  }

  update(dt) {
    if (!this._order) return;

    // Point size is in world units — convert with the live projection + buffer height.
    const renderer = this.game.renderer;
    const cam = this.game.camera;
    let scale = 600;
    let bufW = 1280, bufH = FALLBACK_BUFFER_H;
    if (renderer && cam) {
      renderer.getDrawingBufferSize(_drawSize);
      bufW = _drawSize.x || bufW;
      bufH = _drawSize.y || bufH;
      scale = 0.5 * bufH * cam.projectionMatrix.elements[5];
    }

    for (let gi = 0; gi < this._order.length; gi++) {
      const g = this._order[gi];
      const uni = g.mat.uniforms;
      uni.uScale.value = scale;
      // Resolution-invariant sprite clamp — the buffer size changes with the window
      // AND with the `renderScale` setting, so this has to be re-derived every frame.
      uni.uMaxSize.value = g.maxSizeFrac * bufH;
      if (this._soft) {
        uni.uInvRes.value.set(1 / bufW, 1 / bufH);
        if (cam) uni.uNearFar.value.set(cam.near, cam.far);
      }

      const pos = g.pos, vel = g.vel, col = g.col, siz = g.siz, par = g.par;
      const cA = g.cA, cB = g.cB;

      let i = 0;
      while (i < g.count) {
        const life = g.life[i] - dt;
        if (life <= 0) { g.kill(i); continue; }
        g.life[i] = life;

        const ml = g.maxLife[i];
        const t = 1 - life / ml;
        const i3 = i * 3, i4 = i * 4;

        // Integrate (linear drag approximation — exp() per particle is not worth it).
        let d = 1 - g.drag[i] * dt;
        if (d < 0) d = 0;
        let vx = vel[i3] * d;
        let vy = vel[i3 + 1] * d + WORLD_GRAVITY * g.grav[i] * dt;
        let vz = vel[i3 + 2] * d;

        let px = pos[i3] + vx * dt;
        let py = pos[i3 + 1] + vy * dt;
        let pz = pos[i3 + 2] + vz * dt;

        const fy = g.floor[i];
        if (py < fy && vy < 0) {
          const e = g.rest[i];
          py = fy + (fy - py) * e;
          vy = -vy * e;
          vx *= 0.72; vz *= 0.72;
        }

        vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
        pos[i3] = px; pos[i3 + 1] = py; pos[i3 + 2] = pz;

        siz[i] = g.s0[i] + (g.s1[i] - g.s0[i]) * t;
        col[i3] = cA[i3] + (cB[i3] - cA[i3]) * t;
        col[i3 + 1] = cA[i3 + 1] + (cB[i3 + 1] - cA[i3 + 1]) * t;
        col[i3 + 2] = cA[i3 + 2] + (cB[i3 + 2] - cA[i3 + 2]) * t;

        par[i4] = t;
        par[i4 + 1] += g.spin[i] * dt;

        i++;
      }

      const n = g.count;
      g.geo.setDrawRange(0, n);
      markRange(g.posAttr, n * 3);
      markRange(g.colAttr, n * 3);
      markRange(g.sizAttr, n);
      markRange(g.parAttr, n * 4);
    }
  }

  clear() {
    if (!this._order) return;
    for (let i = 0; i < this._order.length; i++) {
      const g = this._order[i];
      g.count = 0;
      g.geo.setDrawRange(0, 0);
    }
  }

  dispose() {
    if (!this._order) return;
    for (let i = 0; i < this._order.length; i++) {
      const g = this._order[i];
      this._scene?.remove(g.points);
      g.dispose();
    }
    this.groups = null;
    this._order = null;
  }
}
