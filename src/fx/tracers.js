import * as THREE from 'three';
import { createRNG } from '../core/rng.js';

/**
 * OVERSTRIKE — pooled tracer system.
 *
 * Bullets are hitscan, but a bullet that arrives instantly reads as nothing at all, so
 * the *visual* tracer travels: the head advances from the muzzle at ~380 u/s, the tail
 * follows one streak-length behind, and when the head reaches the impact point the tail
 * keeps going so the streak drains into the wall. Long-range shots therefore read as a
 * line of light crossing the map, which is the whole point.
 *
 * Rendering: one `InstancedMesh` of unit quads (cap 128) whose vertices are placed
 * entirely in the vertex shader from per-instance `aStart`/`aEnd` — a camera-facing
 * stretched billboard, additive, bright core / dim tail. A second instanced batch
 * (cap 24) draws sniper vapour ribbons with the soft 'smoke' texture.
 *
 * Two draw calls, zero allocation per spawn or per frame.
 */

const CAP = 128;
const VAPOUR_CAP = 24;

export const TRACER_NORMAL = 0;
export const TRACER_SNIPER = 1;
export const TRACER_SHIMMER = 2;   // the "1 in 3 didn't get a tracer" heat streak

const DEFAULT_SPEED = 380;
const WHIZBY_RADIUS = 4.0;         // camera proximity that earns a brightness boost
const WHIZBY_BOOST = 0.9;

const rnd = createRNG(0x7ace45);

// ---------------------------------------------------------------- scratch
const _camPos = new THREE.Vector3();
const _seg = new THREE.Vector3();

const TRACER_VERT = /* glsl */`
  attribute vec3 aStart;
  attribute vec3 aEnd;
  attribute vec3 aColor;
  attribute vec2 aParams;   // x: half width (m), y: alpha

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vFogDepth;

  void main() {
    vUv = uv;
    vColor = aColor;
    vAlpha = aParams.y;

    vec3 axis = aEnd - aStart;
    float len = length(axis);
    vec3 dir = len > 1e-5 ? axis / len : vec3(0.0, 1.0, 0.0);

    vec3 p = aStart + axis * uv.x;
    vec3 toCam = cameraPosition - p;
    vec3 side = cross(dir, toCam);
    float sl = length(side);
    side = sl > 1e-5 ? side / sl : vec3(1.0, 0.0, 0.0);
    p += side * ((uv.y - 0.5) * 2.0) * aParams.x;

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    vFogDepth = -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

// three's fragment prefix already declares the tonemapping / colorspace helpers.
const TRACER_FRAG = /* glsl */`
  uniform sampler2D uMap;
  uniform float uUseMap;    // 0: procedural gradient (tracer), 1: texture (vapour)
  uniform float uFogMode;   // 0: additive fade-to-black, 1: mix to fog colour
  uniform vec3 fogColor;
  uniform float fogDensity;
  uniform float fogNear;
  uniform float fogFar;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vFogDepth;

  void main() {
    float across = abs(vUv.y - 0.5) * 2.0;
    float core = 1.0 - across;
    core = core * core * core;                 // tight bright core
    float along = vUv.x;                       // 0 = tail, 1 = head
    float head = along * along;

    vec4 tex = texture2D(uMap, vUv);
    float shape = mix(core, tex.a * (1.0 - across * across), uUseMap);

    float a = shape * (0.12 + 0.88 * head) * vAlpha;
    if (a < 0.004) discard;

    vec3 col = vColor * mix(0.35 + 1.9 * core, 1.0, uUseMap) * (0.3 + 0.7 * head);

    float fd = fogDensity * vFogDepth;
    float fogFactor = 1.0 - exp(-fd * fd);
    col = mix(col * (1.0 - fogFactor), mix(col, fogColor, fogFactor), uFogMode);

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

class StreakBatch {
  constructor(cap, texture, blending, useMap, fogMode, renderOrder) {
    this.cap = cap;
    this.count = 0;

    this.start = new Float32Array(cap * 3);
    this.end = new Float32Array(cap * 3);
    this.color = new Float32Array(cap * 3);
    this.params = new Float32Array(cap * 2);

    const geo = new THREE.PlaneGeometry(1, 1);
    this.startAttr = new THREE.InstancedBufferAttribute(this.start, 3).setUsage(THREE.DynamicDrawUsage);
    this.endAttr = new THREE.InstancedBufferAttribute(this.end, 3).setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.InstancedBufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage);
    this.paramsAttr = new THREE.InstancedBufferAttribute(this.params, 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aStart', this.startAttr);
    geo.setAttribute('aEnd', this.endAttr);
    geo.setAttribute('aColor', this.colorAttr);
    geo.setAttribute('aParams', this.paramsAttr);
    this.geo = geo;

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: texture },
        uUseMap: { value: useMap },
        uFogMode: { value: fogMode },
        fogColor: { value: new THREE.Color(0x8b98ab) },
        fogDensity: { value: 0.0075 },
        fogNear: { value: 1 },
        fogFar: { value: 400 },
      },
      vertexShader: TRACER_VERT,
      fragmentShader: TRACER_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending,
      side: THREE.DoubleSide,
      fog: true,
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

  flush() {
    this.mesh.count = this.count;
    markAll(this.startAttr, this.count * 3);
    markAll(this.endAttr, this.count * 3);
    markAll(this.colorAttr, this.count * 3);
    markAll(this.paramsAttr, this.count * 2);
  }

  dispose() {
    this.mesh.dispose();
    this.geo.dispose();
    this.mat.dispose();
  }
}

export class TracerSystem {
  constructor(game) {
    this.game = game;
    this.batch = null;
    this.vapour = null;
    this._scene = null;

    // Live tracer state (packed [0, count) — the tail is the free list).
    this.ox = new Float32Array(CAP); this.oy = new Float32Array(CAP); this.oz = new Float32Array(CAP);
    this.dx = new Float32Array(CAP); this.dy = new Float32Array(CAP); this.dz = new Float32Array(CAP);
    this.dist = new Float32Array(CAP);
    this.travel = new Float32Array(CAP);
    this.speed = new Float32Array(CAP);
    this.streak = new Float32Array(CAP);
    this.width = new Float32Array(CAP);
    this.cr = new Float32Array(CAP); this.cg = new Float32Array(CAP); this.cb = new Float32Array(CAP);
    this.fade = new Float32Array(CAP);      // seconds of post-arrival fade left
    this.fadeMax = new Float32Array(CAP);

    // Vapour ribbon state.
    this.vAge = new Float32Array(VAPOUR_CAP);
    this.vLife = new Float32Array(VAPOUR_CAP);
    this.vWidth = new Float32Array(VAPOUR_CAP);
  }

  init(scene) {
    if (this.batch) return;
    const assets = this.game.assets;
    this.batch = new StreakBatch(CAP, assets.tex('glow'), THREE.AdditiveBlending, 0, 0, 11);
    this.vapour = new StreakBatch(VAPOUR_CAP, assets.tex('smoke'), THREE.NormalBlending, 1, 1, 7);
    this._scene = scene;
    scene.add(this.batch.mesh);
    scene.add(this.vapour.mesh);
  }

  get liveCount() { return this.batch ? this.batch.count : 0; }

  /**
   * §8 `tracer(from, to, speed, width, color)` — the FX facade forwards straight here.
   * @param {number} kind TRACER_NORMAL | TRACER_SNIPER | TRACER_SHIMMER
   */
  spawn(from, to, speed = DEFAULT_SPEED, width = 0.035, r = 1.9, g = 1.35, b = 0.6, kind = TRACER_NORMAL) {
    const b0 = this.batch;
    if (!b0) return -1;

    let dxx = to.x - from.x, dyy = to.y - from.y, dzz = to.z - from.z;
    const dist = Math.sqrt(dxx * dxx + dyy * dyy + dzz * dzz);
    if (dist < 0.2) return -1;
    const inv = 1 / dist;
    dxx *= inv; dyy *= inv; dzz *= inv;

    let i;
    if (b0.count < CAP) {
      i = b0.count++;
    } else {
      // Full: steal the oldest (largest travelled fraction) rather than dropping the shot.
      i = 0;
      let best = -1;
      for (let k = 0; k < CAP; k++) {
        const f = this.dist[k] > 0 ? this.travel[k] / this.dist[k] : 1;
        if (f > best) { best = f; i = k; }
      }
    }

    let streak, sp, w, fade;
    if (kind === TRACER_SNIPER) {
      streak = 34; sp = speed * 1.35; w = width * 1.5; fade = 0.09;
    } else if (kind === TRACER_SHIMMER) {
      streak = 5.5; sp = speed * 1.8; w = width * 0.55; fade = 0.03;
    } else {
      streak = 13; sp = speed; w = width; fade = 0.06;
    }

    this.ox[i] = from.x; this.oy[i] = from.y; this.oz[i] = from.z;
    this.dx[i] = dxx; this.dy[i] = dyy; this.dz[i] = dzz;
    this.dist[i] = dist;
    this.travel[i] = 0;
    this.speed[i] = sp;
    this.streak[i] = Math.min(streak, dist + streak * 0.35);
    this.width[i] = w;
    this.cr[i] = r; this.cg[i] = g; this.cb[i] = b;
    this.fade[i] = fade;
    this.fadeMax[i] = fade;

    // Prime the instance so a tracer spawned late in the frame is never a stale quad.
    const i3 = i * 3, i2 = i * 2;
    b0.start[i3] = from.x; b0.start[i3 + 1] = from.y; b0.start[i3 + 2] = from.z;
    b0.end[i3] = from.x; b0.end[i3 + 1] = from.y; b0.end[i3 + 2] = from.z;
    b0.color[i3] = r; b0.color[i3 + 1] = g; b0.color[i3 + 2] = b;
    b0.params[i2] = w; b0.params[i2 + 1] = 0;

    if (kind === TRACER_SNIPER) this._spawnVapour(from, to, dist);
    return i;
  }

  /**
   * The subtle streak drawn for the ~2 of 3 bullets that do NOT get a full tracer, and
   * for rounds cracking past the camera. Dim, thin, very fast.
   */
  whizbyStreak(from, to, speed = DEFAULT_SPEED) {
    return this.spawn(from, to, speed, 0.03, 0.85, 0.95, 1.25, TRACER_SHIMMER);
  }

  _spawnVapour(from, to, dist) {
    const v = this.vapour;
    if (!v) return;
    let i;
    if (v.count < VAPOUR_CAP) i = v.count++;
    else {
      i = 0;
      let oldest = -1;
      for (let k = 0; k < VAPOUR_CAP; k++) {
        const f = this.vLife[k] > 0 ? this.vAge[k] / this.vLife[k] : 1;
        if (f > oldest) { oldest = f; i = k; }
      }
    }
    const i3 = i * 3, i2 = i * 2;
    // The ribbon covers the first ~70% of the flight path — it dissipates from the muzzle end.
    const t = 0.7;
    v.start[i3] = from.x; v.start[i3 + 1] = from.y; v.start[i3 + 2] = from.z;
    v.end[i3] = from.x + (to.x - from.x) * t;
    v.end[i3 + 1] = from.y + (to.y - from.y) * t;
    v.end[i3 + 2] = from.z + (to.z - from.z) * t;
    v.color[i3] = 0.82; v.color[i3 + 1] = 0.86; v.color[i3 + 2] = 0.92;
    v.params[i2] = 0.04;
    v.params[i2 + 1] = 0;
    this.vAge[i] = 0;
    this.vLife[i] = 0.85 + rnd() * 0.35;
    this.vWidth[i] = 0.045 + Math.min(dist, 120) * 0.0006;
  }

  update(dt) {
    const b0 = this.batch;
    if (!b0) return;

    const cam = this.game.camera;
    if (cam) _camPos.setFromMatrixPosition(cam.matrixWorld);

    let i = 0;
    while (i < b0.count) {
      const dist = this.dist[i];
      let travel = this.travel[i] + this.speed[i] * dt;
      let alpha = 1;

      if (travel >= dist) {
        travel = dist;
        const f = this.fade[i] - dt;
        this.fade[i] = f;
        if (f <= 0) { this._kill(i); continue; }
        alpha = f / this.fadeMax[i];
      }
      this.travel[i] = travel;

      const dxx = this.dx[i], dyy = this.dy[i], dzz = this.dz[i];
      const headT = travel;
      let tailT = travel - this.streak[i];
      if (tailT < 0) tailT = 0;
      if (headT - tailT < 0.05) { this._kill(i); continue; }

      const ox = this.ox[i], oy = this.oy[i], oz = this.oz[i];
      const hx = ox + dxx * headT, hy = oy + dyy * headT, hz = oz + dzz * headT;
      const tx = ox + dxx * tailT, ty = oy + dyy * tailT, tz = oz + dzz * tailT;

      // Whizby: brightness boost when the live segment passes close to the listener.
      let boost = 1;
      if (cam) {
        _seg.set(hx - tx, hy - ty, hz - tz);
        const segLen2 = _seg.lengthSq();
        let px = _camPos.x - tx, py = _camPos.y - ty, pz = _camPos.z - tz;
        let s = segLen2 > 1e-6 ? (px * _seg.x + py * _seg.y + pz * _seg.z) / segLen2 : 0;
        s = s < 0 ? 0 : s > 1 ? 1 : s;
        px -= _seg.x * s; py -= _seg.y * s; pz -= _seg.z * s;
        const d2 = px * px + py * py + pz * pz;
        if (d2 < WHIZBY_RADIUS * WHIZBY_RADIUS) {
          boost = 1 + WHIZBY_BOOST * (1 - Math.sqrt(d2) / WHIZBY_RADIUS);
        }
      }

      const i3 = i * 3, i2 = i * 2;
      b0.start[i3] = tx; b0.start[i3 + 1] = ty; b0.start[i3 + 2] = tz;
      b0.end[i3] = hx; b0.end[i3 + 1] = hy; b0.end[i3 + 2] = hz;
      b0.color[i3] = this.cr[i] * boost;
      b0.color[i3 + 1] = this.cg[i] * boost;
      b0.color[i3 + 2] = this.cb[i] * boost;
      b0.params[i2] = this.width[i];
      b0.params[i2 + 1] = alpha;
      i++;
    }
    b0.flush();

    const v = this.vapour;
    let j = 0;
    while (j < v.count) {
      const age = this.vAge[j] + dt;
      this.vAge[j] = age;
      const life = this.vLife[j];
      if (age >= life) { this._killVapour(j); continue; }
      const t = age / life;
      const i2 = j * 2;
      v.params[i2] = this.vWidth[j] * (1 + t * 2.4);
      v.params[i2 + 1] = (1 - t) * 0.34 * (t < 0.12 ? t / 0.12 : 1);
      j++;
    }
    v.flush();
  }

  _kill(i) {
    const b0 = this.batch;
    const last = --b0.count;
    if (i === last) return;
    const i3 = i * 3, l3 = last * 3, i2 = i * 2, l2 = last * 2;
    b0.start[i3] = b0.start[l3]; b0.start[i3 + 1] = b0.start[l3 + 1]; b0.start[i3 + 2] = b0.start[l3 + 2];
    b0.end[i3] = b0.end[l3]; b0.end[i3 + 1] = b0.end[l3 + 1]; b0.end[i3 + 2] = b0.end[l3 + 2];
    b0.color[i3] = b0.color[l3]; b0.color[i3 + 1] = b0.color[l3 + 1]; b0.color[i3 + 2] = b0.color[l3 + 2];
    b0.params[i2] = b0.params[l2]; b0.params[i2 + 1] = b0.params[l2 + 1];
    this.ox[i] = this.ox[last]; this.oy[i] = this.oy[last]; this.oz[i] = this.oz[last];
    this.dx[i] = this.dx[last]; this.dy[i] = this.dy[last]; this.dz[i] = this.dz[last];
    this.dist[i] = this.dist[last];
    this.travel[i] = this.travel[last];
    this.speed[i] = this.speed[last];
    this.streak[i] = this.streak[last];
    this.width[i] = this.width[last];
    this.cr[i] = this.cr[last]; this.cg[i] = this.cg[last]; this.cb[i] = this.cb[last];
    this.fade[i] = this.fade[last];
    this.fadeMax[i] = this.fadeMax[last];
  }

  _killVapour(i) {
    const v = this.vapour;
    const last = --v.count;
    if (i === last) return;
    const i3 = i * 3, l3 = last * 3, i2 = i * 2, l2 = last * 2;
    v.start[i3] = v.start[l3]; v.start[i3 + 1] = v.start[l3 + 1]; v.start[i3 + 2] = v.start[l3 + 2];
    v.end[i3] = v.end[l3]; v.end[i3 + 1] = v.end[l3 + 1]; v.end[i3 + 2] = v.end[l3 + 2];
    v.color[i3] = v.color[l3]; v.color[i3 + 1] = v.color[l3 + 1]; v.color[i3 + 2] = v.color[l3 + 2];
    v.params[i2] = v.params[l2]; v.params[i2 + 1] = v.params[l2 + 1];
    this.vAge[i] = this.vAge[last];
    this.vLife[i] = this.vLife[last];
    this.vWidth[i] = this.vWidth[last];
  }

  clear() {
    if (!this.batch) return;
    this.batch.count = 0;
    this.batch.mesh.count = 0;
    this.vapour.count = 0;
    this.vapour.mesh.count = 0;
  }

  dispose() {
    if (!this.batch) return;
    this._scene?.remove(this.batch.mesh);
    this._scene?.remove(this.vapour.mesh);
    this.batch.dispose();
    this.vapour.dispose();
    this.batch = null;
    this.vapour = null;
  }
}

export const TRACER_CAP = CAP;
export const TRACER_SPEED = DEFAULT_SPEED;
