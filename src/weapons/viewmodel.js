import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { assets } from '../core/assets.js';
import { clamp, damp, lerp, smoothstep } from '../core/mathUtils.js';

/**
 * OVERSTRIKE — first-person viewmodel.
 *
 * Every weapon is built out of primitives at runtime from its `def.viewmodel` block and
 * lives in `engine.viewScene`, which renders after the world with a cleared depth buffer
 * so the gun never clips a wall.
 *
 * ── DRAW CALLS ─────────────────────────────────────────────────────────────────
 * A gun with real detail is 80-140 primitives. As individual meshes that would be
 * 80-140 draw calls, which on its own is most of the §11 budget. So the builder is a
 * BATCHER: every primitive is baked into a merged BufferGeometry per (node, material),
 * and a finished weapon is 6-10 draws total — one per material it actually uses, plus
 * a couple for the parts that have to move independently (magazine, bolt, pump).
 *
 * Scene graph:
 *
 *   root ─ pose ─ kick ─ gun ─ { static merged meshes, magNode, boltNode, pumpNode,
 *                               muzzlePoint, ejectPoint, reticlePoint }
 *
 *   pose  : hip / ADS / sprint blend + sway + breathing + bob + reload + inspect + melee
 *   kick  : per-shot recoil impulse (translation + rotational snap), spring-damped
 *   gun   : the weapon itself, never touched after build
 *
 * ── MATERIALS ──────────────────────────────────────────────────────────────────
 * Six shared materials from `core/assets.js` (never construct one here):
 *   gunmetal   dark anodised steel, metalness 0.92 — barrels, bolts, rails, hardware
 *   gunPolymer matte charcoal furniture
 *   gunTan     matte FDE furniture — the loudest identity lever in the palette
 *   rubber     near-black — grips, buttpads, and the thin inset grooves that break
 *              a receiver up into an upper and a lower instead of one grey brick
 *   brass      belts, casings, illuminated reticles, small hardware
 *   glassOptic lens glass
 *
 * ── FRAMING ────────────────────────────────────────────────────────────────────
 * The rest pose is COMPUTED, not authored (see `_frame`). Every gun is placed so its
 * rearmost point clears the camera by `nearClear`, its optic sits a fixed fraction of
 * the screen below the crosshair and its lowest point stays inside the bottom edge.
 * That holds for a pistol and an LMG without ten hand-tuned magic triples, and it is
 * aspect-ratio independent because every fraction is expressed in HALF-HEIGHTS (three
 * keeps vertical FOV fixed, so 16:9 and 21:9 crop and extend horizontally only).
 *
 * ── ADS ALIGNMENT ──────────────────────────────────────────────────────────────
 * The optic's reticle marker is a real node in the gun's local space. The ADS pose is
 * `-reticleLocal` plus the def's `adsDepth`, which puts the reticle exactly on the
 * camera axis — screen centre, at any FOV or aspect ratio. Every additive animation
 * term is faded out by `adsAmount`, so at full ADS the alignment is exact rather than
 * approximately right.
 */

const VIEW_FOV_HIP = 70;
const DEG = Math.PI / 180;

/** Rest-pose framing, all fractions expressed in screen HALF-HEIGHTS. */
const FRAME = {
  relX: 0.55,        // receiver centre, right of screen centre (≈67 % across at 16:9)
  relY: 0.19,        // optic reticle, below screen centre
  nearClear: 0.20,   // metres of daylight between the camera and the buttpad
  bottomMax: 0.98,   // lowest point of the gun, as a fraction of the half-height
  minDepth: 0.44,
  maxDepth: 1.15,
};

// ------------------------------------------------------------------ scratch

const _v = new THREE.Vector3();
const _bb = new THREE.Box3();
const _m4 = new THREE.Matrix4();
const _eul = new THREE.Euler();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

// ------------------------------------------------------------------ primitives

/** Shared unit primitives — one source geometry for every box in every gun. */
let _unitBox = null;
const _cylCache = new Map();

function unitBox() {
  if (!_unitBox) _unitBox = new THREE.BoxGeometry(1, 1, 1);
  return _unitBox;
}

/** Cylinders are cached by (radiusTop, radiusBottom, segments) at unit height. */
function unitCyl(rt, rb, seg, open = false) {
  const key = `${rt.toFixed(4)}|${rb.toFixed(4)}|${seg}|${open ? 'o' : 'c'}`;
  let g = _cylCache.get(key);
  if (!g) {
    g = new THREE.CylinderGeometry(rt, rb, 1, seg, 1, open);
    _cylCache.set(key, g);
  }
  return g;
}

function mat(name) { return assets.mat(name); }

/**
 * Collects primitives and bakes them down to one merged geometry per material.
 * Build-time only — nothing here runs after a weapon is first equipped.
 */
class Batch {
  constructor() {
    this.byMat = new Map();
    this.tris = 0;
  }

  _push(matName, src, w, h, d, x, y, z, rx, ry, rz) {
    let arr = this.byMat.get(matName);
    if (!arr) { arr = []; this.byMat.set(matName, arr); }
    _eul.set(rx || 0, ry || 0, rz || 0);
    _q.setFromEuler(_eul);
    _p.set(x, y, z);
    _s.set(w, h, d);
    _m4.compose(_p, _q, _s);
    const g = src.clone().applyMatrix4(_m4);
    arr.push(g);
    this.tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    return this;
  }

  /** Axis-aligned box part. Sizes are metres in view space. */
  box(matName, w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
    return this._push(matName, unitBox(), w, h, d, x, y, z, rx, ry, rz);
  }

  /** Cylinder along an axis: 'x' | 'y' | 'z'. `r2` tapers the far end. */
  /**
   * `open` drops the end caps, leaving a hollow shell.
   *
   * This is what makes a sight a sight. An optic body built from a capped cylinder is a
   * SOLID bar of metal: aiming down it puts you nose-to-nose with a flat end cap, and no
   * amount of transparency on the lens disc in front of it can help, because the tube
   * behind the lens is filled in. Every red dot, holo and scope in the game was blocking
   * the middle of the screen for exactly this reason. Open-ended, you see down the bore.
   *
   * Backface culling does the rest: the far inner wall is culled, so the bore reads as a
   * clean aperture rather than as the inside of a pipe.
   */
  cyl(matName, r, len, axis, x, y, z, seg = 8, r2 = r, open = false) {
    const rx = axis === 'z' ? Math.PI / 2 : 0;
    const rz = axis === 'x' ? Math.PI / 2 : 0;
    return this._push(matName, unitCyl(r, r2, seg, open), 1, len, 1, x, y, z, rx, 0, rz);
  }

  /** Picatinny: a solid base strip plus evenly spaced ribs. */
  rail(matName, count, len, w, x, y, zCentre, h = 0.0045) {
    if (count <= 0 || len <= 0) return this;
    this.box(matName, w, h * 0.7, len, x, y - h * 0.3, zCentre);
    const step = len / count;
    for (let i = 0; i < count; i++) {
      this.box(matName, w * 0.86, h, step * 0.42, x, y + h * 0.22, zCentre + len / 2 - step * (i + 0.5));
    }
    return this;
  }

  /** Merge everything collected into one mesh per material and parent them. */
  flush(parent, out) {
    for (const [matName, arr] of this.byMat) {
      const merged = arr.length === 1 ? arr[0] : mergeGeometries(arr, false);
      if (!merged) continue;
      if (arr.length > 1) for (const g of arr) g.dispose();
      const m = new THREE.Mesh(merged, mat(matName));
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
      parent.add(m);
      out.push(merged);
    }
    this.byMat.clear();
    return this;
  }
}

// ==================================================================== Viewmodel

export class Viewmodel {
  constructor(game) {
    this.game = game;
    this.engine = game.engine;

    this.root = new THREE.Group();
    this.pose = new THREE.Group();
    this.kick = new THREE.Group();
    this.root.add(this.pose);
    this.pose.add(this.kick);

    /** Built weapons, keyed by weapon id. */
    this.cache = new Map();
    this.current = null;
    this.def = null;

    // --- animation state
    this.time = 0;
    this.bobPhase = 0;
    this.breathPhase = 0;
    this.swayX = 0; this.swayY = 0;
    this.sprintAmount = 0;
    this.lowerAmount = 0;
    this.adsAmount = 0;

    this.kickZ = 0; this.kickY = 0; this.kickPitch = 0; this.kickYaw = 0; this.kickRoll = 0;
    this.kickVelZ = 0; this.kickVelPitch = 0;

    this.boltT = 0; this.boltDur = 0.06;
    this.pumpT = 0; this.pumpDur = 0.4;
    this.boltLocked = false;

    this.reloadActive = false;
    this.reloadEmpty = false;
    this.reloadDur = 1;
    this.reloadP = 0;
    this._reloadStage = 0;
    /** True while a recorded whole-reload take is covering the per-stage handling sounds. */
    this._reloadComposite = false;

    this.switchT = 0; this.switchDur = 0; this.switchDir = 0;   // -1 lower, +1 raise
    this.inspectT = 0; this.inspectDur = 2.1;
    this.meleeT = 0; this.meleeDur = 0.55;
    this.throwT = 0;
    this.flinchPitch = 0; this.flinchYaw = 0;

    this._lastYaw = 0; this._lastPitch = 0; this._haveLast = false;

    /**
     * True while the gun is hidden behind a scope's sight picture. Separate from
     * `group.visible` meaning "this weapon is equipped", because a hidden gun still has
     * a live muzzle — tracers and shell ejection must keep coming out of the right
     * place while the player is scoped in.
     */
    this._scopeHidden = false;

    // --- falling magazine prop (one, reused)
    this.dropMag = null;
    this.dropMagLife = 0;
    this.dropMagVel = new THREE.Vector3();
    this.dropMagSpin = new THREE.Vector3();
  }

  async init() {
    const cam = this.engine?.viewCamera;
    if (cam) cam.add(this.root);
    else this.engine?.viewScene?.add(this.root);

    // Reusable dropped magazine.
    this.dropMag = new THREE.Mesh(unitBox(), mat('gunPolymer'));
    this.dropMag.scale.set(0.028, 0.17, 0.056);
    this.dropMag.visible = false;
    this.dropMag.frustumCulled = false;
    this.engine?.viewScene?.add(this.dropMag);
  }

  // ------------------------------------------------------------- weapon build

  /** Swap the model. Builds on first use, then reuses the cached group forever. */
  setWeapon(def) {
    if (!def) return;
    if (this.current && this.current.def === def) return;
    if (this.current) this.current.group.visible = false;

    let entry = this.cache.get(def.id);
    if (!entry) {
      entry = this._build(def);
      this.cache.set(def.id, entry);
      this.kick.add(entry.group);
    }
    entry.group.visible = true;
    this._scopeHidden = false;
    this.current = entry;
    this.def = def;

    // Reset transient animation so a swap never inherits the last gun's pose.
    this.kickZ = this.kickY = this.kickPitch = this.kickYaw = this.kickRoll = 0;
    this.kickVelZ = this.kickVelPitch = 0;
    this.boltT = this.pumpT = 0;
    this.boltLocked = false;
    this.reloadActive = false;
    this.inspectT = 0;
    this.meleeT = 0;
    if (this.dropMag && entry.magSize) this.dropMag.scale.copy(entry.magSize);
    this._applyRestPose();
  }

  /**
   * Build a weapon from its `viewmodel` block.
   * Coordinates: -Z is downrange, +X is right, +Y is up. Origin sits at the centre of
   * the receiver so every part is authored relative to something physical.
   */
  _build(def) {
    const vm = def.viewmodel || {};
    if (vm.knife) return this._buildKnife(def);
    if (vm.grenade) return this._buildGrenade(def);
    return this._buildGun(def);
  }

  // ------------------------------------------------------------------- firearm

  /* eslint-disable-next-line complexity */
  _buildGun(def) {
    const vm = def.viewmodel || {};
    const group = new THREE.Group();
    const parts = {};
    const geos = [];

    const body = vm.body || { mat: 'gunmetal', len: 0.3, h: 0.075, w: 0.05 };
    const upper = vm.upper || { mat: 'gunmetal', len: 0.3, h: 0.03, w: 0.042, railSlots: 6 };
    const hg = vm.handguard || { mat: 'gunPolymer', len: 0.2, h: 0.055, w: 0.05, railSlots: 4, vents: 3 };
    const bar = vm.barrel || { mat: 'gunmetal', len: 0.2, r: 0.011 };
    const mz = vm.muzzle || { type: 'none', len: 0, r: 0.016 };
    const st = vm.stock || { type: 'none', mat: 'gunPolymer', len: 0, h: 0, drop: 0 };
    const gr = vm.grip || { mat: 'gunPolymer', len: 0.11, angle: 0.38 };
    const mg = vm.mag || { type: 'box', mat: 'gunPolymer', len: 0.15, w: 0.026, d: 0.05, curve: 0 };
    const op = vm.optic || { type: 'irons', mat: 'gunmetal', height: 0.045, len: 0.06, w: 0.03, reticle: 'dot' };
    const ch = vm.charging || { side: 'none', len: 0 };

    const metal = vm.metalMat || 'gunmetal';
    const accent = vm.accentMat || 'gunmetal';
    const padMat = vm.padMat || 'rubber';
    const DK = 'rubber';                       // the inset-groove / shadow-line material

    const bw = body.w, bh = body.h;
    const halfBody = body.len / 2;
    const top = bh / 2;
    const bot = -bh / 2;
    const es = vm.ejectSide ?? 1;

    const B = new Batch();                      // static gun
    const Bm = new Batch();                     // magazine node
    const Bb = new Batch();                     // bolt / slide node
    const Bp = hg.pump ? new Batch() : null;    // pump node

    // ══════════════════════════════════════════════════════ lower receiver ══
    B.box(body.mat, bw, bh, body.len, 0, 0, 0);
    // Chamfer shadow lines top and bottom — this is what splits the "brick" into
    // an upper and a lower at a glance.
    B.box(DK, bw + 0.0014, 0.0035, body.len * 0.985, 0, top - 0.002, 0);
    B.box(DK, bw + 0.0014, 0.0035, body.len * 0.985, 0, bot + 0.002, 0);
    // Recessed side panel.
    B.box(DK, bw + 0.0018, bh * 0.30, body.len * 0.40, 0, -bh * 0.08, halfBody * 0.16);

    // Ejection port: a dark hole, a metal dust cover under it, a brass deflector.
    const ex = es * (bw / 2 + 0.0012);
    const portZ = -halfBody * 0.22;
    B.box(DK, 0.0045, 0.026, 0.054, ex, bh * 0.16, portZ);
    B.box(metal, 0.006, 0.019, 0.050, ex + 0.0035, bh * 0.02, portZ);
    B.box('brass', 0.0055, 0.007, 0.052, ex + 0.003, bh * 0.31, portZ);
    // Forward assist + bolt catch.
    B.cyl(metal, 0.0075, 0.016, 'x', ex + 0.008, bh * 0.05, portZ + 0.040, 6);
    B.box(metal, 0.006, 0.012, 0.020, -es * (bw / 2 + 0.004), bh * 0.02, portZ + 0.030);

    // ══════════════════════════════════════════════════════ upper receiver ══
    const upperY = top + upper.h / 2;
    const upperZ = vm.upperZ ?? -0.01;
    const railY = upperY + upper.h / 2 + 0.003;
    const slideSide = ch.side === 'slide';
    const UB = slideSide ? Bb : B;              // a pistol's upper IS the slide
    UB.box(upper.mat, upper.w, upper.h, upper.len, 0, upperY, upperZ);
    UB.box(DK, upper.w + 0.0012, 0.003, upper.len * 0.98, 0, upperY - upper.h / 2 + 0.002, upperZ);
    UB.rail(metal, upper.railSlots || 0, upper.len * 0.94, upper.w * 0.62, 0, railY, upperZ);

    // ═══════════════════════════════════════════════════════════ handguard ══
    const hgZ = -halfBody - hg.len / 2;
    const HB = Bp || B;
    if (hg.len > 0) {
      HB.box(hg.mat, hg.w, hg.h, hg.len, 0, -0.002, hgZ);
      HB.box(DK, hg.w + 0.0016, 0.0035, hg.len * 0.96, 0, hg.h / 2 - 0.004, hgZ);
      HB.box(DK, hg.w + 0.0016, 0.0035, hg.len * 0.96, 0, -hg.h / 2 + 0.002, hgZ);
      this._handguardStyle(HB, vm, hg, hgZ, metal, DK);
      // End cap / barrel shroud collar.
      HB.box(metal, hg.w * 0.94, hg.h * 0.94, 0.014, 0, -0.002, hgZ - hg.len / 2 + 0.007);
    }

    // ═════════════════════════════════════════════════════ barrel + muzzle ══
    const barZ = hgZ - hg.len / 2 - bar.len / 2;
    const barFront = barZ - bar.len / 2;
    B.cyl(metal, bar.r, bar.len, 'z', 0, -0.001, barZ, 8);
    B.cyl(metal, bar.r * 1.45, 0.018, 'z', 0, -0.001, hgZ - hg.len / 2 - 0.009, 8);
    if (vm.fluted) {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + 0.4;
        B.box(DK, 0.004, 0.004, bar.len * 0.55,
          Math.cos(a) * bar.r, -0.001 + Math.sin(a) * bar.r, barZ - bar.len * 0.1);
      }
    }
    const muzzleZ = this._muzzleDevice(B, mz, bar, barFront, metal, DK);

    // Gas block + folding front sight — the irons every rifle wears under its optic.
    const gasZ = barFront + bar.len * 0.26;
    if (vm.gasBlock !== false) B.box(metal, 0.020, 0.026, 0.026, 0, 0.012, gasZ);
    if (vm.irons !== false) {
      B.box(metal, 0.005, 0.020, 0.005, 0, 0.032, gasZ);
      B.box(metal, 0.004, 0.016, 0.004, -0.008, 0.030, gasZ);
      B.box(metal, 0.004, 0.016, 0.004, 0.008, 0.030, gasZ);
    }

    // ═══════════════════════════════════════════════════════════════ stock ══
    this._stock(B, vm, st, body, halfBody, top, bot, bw, metal, padMat, DK);

    // ═════════════════════════════════════════════════════════ pistol grip ══
    const gripZ = mg.inGrip ? 0.012 : halfBody * 0.40;
    const ga = -(gr.angle || 0.36);             // negative rakes the butt BACKWARD
    const ca = Math.cos(ga), sa = Math.sin(ga);
    const gy = bot - gr.len / 2 + 0.006;
    B.box(gr.mat, bw * 0.70, gr.len, 0.040, 0, gy, gripZ, ga);
    // Front/back straps and a base cap, all in the dark material: the grip stops
    // being a slab and starts having a front and a back.
    B.box(DK, bw * 0.73, gr.len * 0.60, 0.009, 0, gy - gr.len * 0.05 * ca, gripZ - 0.021 - gr.len * 0.05 * sa, ga);
    B.box(DK, bw * 0.73, gr.len * 0.72, 0.009, 0, gy, gripZ + 0.021, ga);
    B.box(DK, bw * 0.74, 0.010, 0.044, 0, gy - (gr.len / 2) * ca, gripZ - (gr.len / 2) * sa, ga);
    // Trigger guard + trigger.
    B.box(metal, bw * 0.46, 0.005, 0.058, 0, bot - 0.030, gripZ - 0.036);
    B.box(metal, bw * 0.46, 0.030, 0.005, 0, bot - 0.017, gripZ - 0.062);
    B.box(metal, bw * 0.46, 0.008, 0.012, 0, bot - 0.004, gripZ - 0.059);
    B.box(accent, 0.007, 0.020, 0.006, 0, bot - 0.015, gripZ - 0.042, 0.28);
    // Selector switch + two takedown pins on the left flat. Deliberately NOT brass:
    // small gold specks on a receiver read as stray lights, not hardware.
    const lx = -(bw / 2 + 0.003);
    B.cyl(metal, 0.0085, 0.006, 'x', lx, bot + 0.016, gripZ - 0.016, 8);
    B.box(metal, 0.006, 0.007, 0.024, lx - 0.004, bot + 0.016, gripZ - 0.006);
    B.cyl(metal, 0.006, 0.005, 'x', lx, 0, halfBody * 0.62, 6);
    B.cyl(metal, 0.006, 0.005, 'x', lx, bot + 0.010, -halfBody * 0.55, 6);

    // ═══════════════════════════════════════════════════════════ magazine ══
    const magNode = new THREE.Group();
    const magZ = mg.inGrip ? gripZ + 0.004 : (mg.rearMounted ? halfBody * 0.52 : -halfBody * 0.30);
    magNode.position.set(0, bot - 0.012, magZ);
    group.add(magNode);
    parts.mag = magNode;
    parts.magRest = magNode.position.clone();
    parts.magDrops = mg.type !== 'tube';

    if (!mg.inGrip && mg.type !== 'tube' && mg.type !== 'belt') {
      // Magwell flare — a real gun has one, and it hides the mag/receiver seam.
      B.box(body.mat, bw * 0.98, 0.030, mg.d * 1.16, 0, bot - 0.012, magZ);
      B.box(DK, bw * 1.01, 0.005, mg.d * 1.20, 0, bot - 0.028, magZ);
    }
    const tubeY = -0.001 - bar.r - (mg.w || 0.026) / 2 - 0.003;
    this._magazine(Bm, B, mg, metal, padMat, DK, ga, tubeY);
    parts.magSize = new THREE.Vector3(
      Math.max(0.02, mg.w * 1.1), Math.max(0.05, mg.len * 0.8), Math.max(0.02, mg.d));

    // ══════════════════════════════════════════════════════════════ optic ══
    const opticBase = railY + 0.002;
    const reticle = this._optic(B, op, opticBase, upperZ, metal, DK);
    const reticlePoint = new THREE.Object3D();
    reticlePoint.position.set(0, reticle.y, reticle.z);
    group.add(reticlePoint);
    parts.reticle = reticlePoint;
    // Rear iron sight, folded up behind the optic.
    if (vm.irons !== false && op.type !== 'irons' && op.type !== 'scope') {
      B.box(metal, 0.020, 0.004, 0.006, 0, opticBase + 0.006, upperZ + upper.len * 0.42);
      B.box(metal, 0.005, 0.014, 0.005, -0.008, opticBase + 0.013, upperZ + upper.len * 0.42);
      B.box(metal, 0.005, 0.014, 0.005, 0.008, opticBase + 0.013, upperZ + upper.len * 0.42);
    }

    // ══════════════════════════════════════════ charging handle / bolt node ══
    const boltNode = new THREE.Group();
    group.add(boltNode);
    parts.bolt = boltNode;
    parts.boltRest = boltNode.position.clone();
    if (slideSide) {
      // Slide serrations, front and rear.
      for (let i = 0; i < 6; i++) {
        Bb.box(DK, upper.w + 0.0012, upper.h * 0.62, 0.0035, 0, upperY, 0.030 + i * 0.0085);
      }
      for (let i = 0; i < 3; i++) {
        Bb.box(DK, upper.w + 0.0012, upper.h * 0.62, 0.0035, 0, upperY, -0.052 - i * 0.0085);
      }
      Bb.box(DK, 0.0045, 0.020, 0.046, es * (upper.w / 2 + 0.001), upperY + 0.002, -0.012);
    } else if (ch.side === 'top') {
      Bb.box(metal, 0.013, 0.014, ch.len, 0, upperY + upper.h * 0.5 + 0.007, 0.02);
      Bb.box(DK, 0.016, 0.008, 0.012, 0, upperY + upper.h * 0.5 + 0.012, 0.02 + ch.len * 0.4);
    } else if (ch.side === 'left' || ch.side === 'right') {
      const sx = (ch.side === 'right' ? 1 : -1) * (bw / 2 + 0.008);
      Bb.box(metal, 0.016, 0.012, ch.len, sx, bh * 0.22, halfBody * 0.15);
      Bb.box(DK, 0.019, 0.014, 0.010, sx, bh * 0.22, halfBody * 0.15 + ch.len * 0.42);
      if (ch.bolt) {
        Bb.cyl(metal, 0.009, 0.034, 'x', sx + 0.016, bh * 0.22, halfBody * 0.15, 8);
        Bb.cyl(metal, 0.013, 0.014, 'x', sx + 0.034, bh * 0.22, halfBody * 0.15, 8);
        Bb.box(metal, 0.010, 0.010, 0.050, sx, bh * 0.22, halfBody * 0.15 + 0.025);
      }
    }

    // ═══════════════════════════════════════════════════ accessories / rig ══
    if (vm.foregrip) {
      const fz = hgZ - hg.len * 0.16;
      B.box(gr.mat, 0.026, 0.070, 0.030, 0, -hg.h / 2 - 0.034, fz, -0.16);
      B.box(DK, 0.028, 0.050, 0.010, 0, -hg.h / 2 - 0.040, fz - 0.015, -0.16);
      B.box(metal, 0.030, 0.012, 0.026, 0, -hg.h / 2 - 0.006, fz);
    }
    if (vm.bipod) {
      // Folded forward along the barrel, so it reads without eating the frame.
      const bz = hgZ - hg.len * 0.30;
      B.box(metal, 0.030, 0.014, 0.020, 0, -hg.h / 2 - 0.008, bz);
      B.box(metal, 0.008, 0.010, 0.090, -0.016, -hg.h / 2 - 0.014, bz - 0.046, 0.12);
      B.box(metal, 0.008, 0.010, 0.090, 0.016, -hg.h / 2 - 0.014, bz - 0.046, 0.12);
    }
    if (vm.laser) {
      B.box(metal, 0.020, 0.018, 0.036, -(hg.w / 2 + 0.010), 0.004, hgZ + hg.len * 0.22);
      B.box('glassOptic', 0.012, 0.011, 0.004, -(hg.w / 2 + 0.010), 0.004, hgZ + hg.len * 0.22 - 0.019);
    }
    if (vm.sling !== false) {
      B.box(metal, 0.005, 0.016, 0.014, -(bw / 2 + 0.004), -0.006, halfBody * 0.78);
      B.box(metal, 0.005, 0.016, 0.014, -(hg.w / 2 + 0.004), -0.008, hgZ - hg.len * 0.28);
    }
    if (vm.carryHandle) {
      // Folded to the left, the way a real LMG carries one — centred on the rail it sat
      // dead on the iron sightline (the irons anchor at railY + ~0.030, the handle body
      // spanned railY + 0.025..0.039) and filled the middle of the ADS picture.
      const chx = -0.034;
      const chz = upperZ - upper.len * 0.10;
      B.box(metal, 0.014, 0.010, 0.090, chx, railY + 0.030, chz, 0, 0, 0.35);
      B.box(metal, 0.014, 0.026, 0.010, chx * 0.55, railY + 0.014, chz - 0.044, 0, 0, 0.6);
      B.box(metal, 0.014, 0.026, 0.010, chx * 0.55, railY + 0.014, chz + 0.044, 0, 0, 0.6);
      B.box(DK, 0.017, 0.008, 0.070, chx, railY + 0.034, chz, 0, 0, 0.35);
    }

    // ------------------------------------------------------------ bake it down
    B.flush(group, geos);
    Bm.flush(magNode, geos);
    Bb.flush(boltNode, geos);
    if (Bp) {
      const pumpNode = new THREE.Group();
      group.add(pumpNode);
      Bp.flush(pumpNode, geos);
      parts.pump = pumpNode;
    }
    const tris = B.tris + Bm.tris + Bb.tris + (Bp ? Bp.tris : 0);

    // ---------------------------------------------------------------- anchors
    const muzzlePoint = new THREE.Object3D();
    muzzlePoint.position.set(0, -0.001, muzzleZ - 0.006);
    group.add(muzzlePoint);

    const ejectPoint = new THREE.Object3D();
    ejectPoint.position.set(es * (bw / 2 + 0.014), bh * 0.18, portZ);
    group.add(ejectPoint);

    const entry = {
      def, group, parts, geos, tris,
      muzzle: muzzlePoint,
      eject: ejectPoint,
      reticle: reticlePoint,
      magSize: parts.magSize,
      adsPos: new THREE.Vector3(
        -reticlePoint.position.x,
        -reticlePoint.position.y,
        (vm.adsDepth ?? -0.33) - reticlePoint.position.z,
      ),
      hipPos: new THREE.Vector3(),
      hipRot: new THREE.Euler().fromArray(vm.hipRot || [0, 0, 0]),
      boltThrow: vm.boltThrow || 0,
      pumpThrow: vm.pumpThrow || 0,
      boltLock: vm.boltLock !== false && (vm.boltThrow || 0) > 0,
      vmFovAds: vm.vmFovAds || 55,
      kickMul: vm.kickMul ?? 1,
      isMelee: false,
    };
    this._frame(entry, group, vm);
    return entry;
  }

  // ----------------------------------------------------------- part builders

  _handguardStyle(B, vm, hg, hgZ, metal, DK) {
    const style = vm.hgStyle || 'mlok';
    const n = Math.max(1, hg.railSlots || 4);
    const span = hg.len - 0.05;
    const step = span / n;
    const z0 = hgZ + hg.len / 2 - 0.028;

    if (style === 'quad') {
      B.rail(metal, n, hg.len * 0.9, 0.006, hg.w / 2 + 0.003, -0.004, hgZ);
      B.rail(metal, n, hg.len * 0.9, 0.006, -(hg.w / 2 + 0.003), -0.004, hgZ);
      if (!vm.foregrip) B.rail(metal, n, hg.len * 0.9, hg.w * 0.55, 0, -hg.h / 2 - 0.004, hgZ);
      return;
    }
    if (style === 'ribbed') {
      for (let i = 0; i < n; i++) {
        B.box(hg.mat, hg.w + 0.004, hg.h * 0.92, 0.010, 0, -0.002, z0 - i * step);
      }
      return;
    }
    if (style === 'shield') {
      // LMG heat shield: long louvres cut through both flanks.
      for (let i = 0; i < n; i++) {
        B.box(DK, hg.w + 0.0022, 0.013, step * 0.62, 0, hg.h * 0.16, z0 - i * step);
        B.box(DK, hg.w + 0.0022, 0.013, step * 0.62, 0, -hg.h * 0.20, z0 - i * step);
      }
      return;
    }
    if (style === 'pump') {
      // A forend has to look like something a hand grabs: fatter than the receiver,
      // with deep finger grooves and a rubber wrap.
      B.box(hg.mat, hg.w * 1.16, hg.h * 0.55, hg.len * 0.94, 0, -hg.h * 0.16, hgZ);
      for (let i = 0; i < 6; i++) {
        B.box(DK, hg.w * 1.20, 0.010, 0.012, 0, -hg.h * 0.10,
          hgZ + hg.len / 2 - 0.028 - i * (hg.len - 0.05) / 6);
      }
      B.box(DK, hg.w * 1.18, hg.h * 0.22, hg.len * 0.30, 0, -hg.h * 0.40, hgZ + hg.len * 0.05);
      B.box(metal, hg.w * 0.30, hg.h * 0.30, hg.len * 0.98, 0, hg.h * 0.34, hgZ);
      return;
    }
    // 'mlok' (default): three rows of slots, plus a short top rail section.
    for (let i = 0; i < n; i++) {
      const z = z0 - i * step;
      B.box(DK, hg.w + 0.0022, 0.010, step * 0.52, 0, hg.h * 0.10, z);
      B.box(DK, hg.w * 0.5, 0.010, step * 0.52, 0, -hg.h / 2 - 0.0015, z);
    }
    for (let i = 0; i < (hg.vents || 0); i++) {
      B.box(DK, hg.w + 0.0026, 0.012, 0.009, 0, -hg.h * 0.24,
        hgZ + hg.len / 2 - 0.035 - i * (hg.len - 0.06) / Math.max(1, hg.vents));
    }
  }

  _muzzleDevice(B, mz, bar, barFront, metal, DK) {
    if (!mz || mz.type === 'none' || !(mz.len > 0)) return barFront;
    const zc = barFront - mz.len / 2;
    if (mz.type === 'suppressor') {
      B.cyl(metal, mz.r, mz.len, 'z', 0, -0.001, zc, 10);
      B.cyl(DK, mz.r * 1.02, 0.006, 'z', 0, -0.001, barFront - 0.006, 10);
      B.cyl(DK, mz.r * 1.02, 0.006, 'z', 0, -0.001, barFront - mz.len * 0.55, 10);
      B.cyl(DK, mz.r * 0.72, 0.005, 'z', 0, -0.001, barFront - mz.len + 0.004, 10);
    } else if (mz.type === 'brake') {
      B.cyl(metal, mz.r, mz.len, 'z', 0, -0.001, zc, 8);
      for (let i = 0; i < 3; i++) {
        B.box(DK, mz.r * 2.3, 0.007, 0.009, 0, -0.001, barFront - mz.len * (0.25 + i * 0.25));
      }
      B.cyl(DK, mz.r * 0.55, 0.006, 'z', 0, -0.001, barFront - mz.len + 0.004, 8);
    } else if (mz.type === 'flash') {
      B.cyl(metal, mz.r * 0.62, mz.len, 'z', 0, -0.001, zc, 8, mz.r);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.78;
        B.box(DK, 0.005, 0.005, mz.len * 0.7,
          Math.cos(a) * mz.r * 0.7, -0.001 + Math.sin(a) * mz.r * 0.7, zc - mz.len * 0.1);
      }
    } else if (mz.type === 'breach') {
      B.cyl(metal, mz.r, mz.len, 'z', 0, -0.001, zc, 8);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        B.box(metal, 0.009, 0.015, 0.016,
          Math.cos(a) * mz.r * 0.8, -0.001 + Math.sin(a) * mz.r * 0.8, barFront - mz.len);
      }
      B.cyl(DK, mz.r * 0.62, 0.006, 'z', 0, -0.001, barFront - mz.len + 0.004, 8);
    }
    return barFront - mz.len;
  }

  _stock(B, vm, st, body, halfBody, top, bot, bw, metal, padMat, DK) {
    if (!st || st.type === 'none') return;
    const stZ = halfBody + st.len / 2;
    const drop = st.drop || 0;

    if (st.type === 'bullpup') {
      B.box(body.mat, bw * 0.96, st.h, 0.034, 0, -0.004, halfBody - 0.016);
      B.box(padMat, bw * 1.02, st.h * 0.98, 0.014, 0, -0.004, halfBody + 0.004);
      B.box(body.mat, bw * 0.60, 0.018, body.len * 0.44, 0, top + 0.006, halfBody * 0.36);
      B.box(DK, bw * 0.64, 0.006, body.len * 0.40, 0, top + 0.016, halfBody * 0.36);
      return;
    }
    if (st.type === 'carbine') {
      // Buffer tube with the stock body riding on it — the AR silhouette.
      B.cyl(metal, 0.0165, st.len * 0.98, 'z', 0, top - 0.018 - drop, stZ, 8);
      B.box(st.mat, bw * 0.78, st.h * 0.58, st.len * 0.62, 0, top - 0.020 - drop, stZ + st.len * 0.10);
      B.box(st.mat, bw * 0.52, 0.014, st.len * 0.50, 0, top + 0.002 - drop, stZ - st.len * 0.06);
      B.box(DK, bw * 0.80, 0.005, st.len * 0.58, 0, top - 0.020 - drop - st.h * 0.30, stZ + st.len * 0.10);
      // Sling slot through the stock body — the last big unbroken flat on the gun.
      B.box(DK, bw * 0.80, st.h * 0.26, st.len * 0.24, 0, top - 0.018 - drop, stZ + st.len * 0.16);
      B.box(st.mat, bw * 0.84, st.h, 0.024, 0, top - 0.026 - drop - st.h * 0.14, stZ + st.len / 2 - 0.012);
      B.box(padMat, bw * 0.88, st.h * 1.04, 0.014, 0, top - 0.026 - drop - st.h * 0.14, stZ + st.len / 2 + 0.002);
      B.box(metal, 0.005, 0.014, 0.012, -(bw * 0.44), top - 0.030 - drop, stZ + st.len * 0.34);
      return;
    }
    if (st.type === 'skeleton') {
      B.box(st.mat, bw * 0.66, 0.018, st.len, 0, top - 0.012 - drop, stZ);
      B.box(st.mat, bw * 0.66, 0.016, st.len * 0.78, 0, bot + 0.008 - drop, stZ + 0.012);
      B.box(DK, bw * 0.70, 0.005, st.len * 0.92, 0, top - 0.021 - drop, stZ);
      // Adjustable cheek riser on a post.
      B.box(st.mat, bw * 0.54, 0.016, st.len * 0.52, 0, top + 0.014 - drop, stZ - st.len * 0.10);
      B.box(metal, 0.008, 0.014, 0.008, 0, top + 0.001 - drop, stZ - st.len * 0.28);
      B.box(st.mat, bw * 0.80, st.h, 0.020, 0, -drop, stZ + st.len / 2 - 0.010);
      B.box(padMat, bw * 0.86, st.h * 0.98, 0.013, 0, -drop, stZ + st.len / 2 + 0.004);
      B.box(metal, bw * 0.30, 0.020, 0.030, 0, -drop - st.h * 0.52, stZ + st.len / 2 - 0.020);
      return;
    }
    if (st.type === 'folding') {
      B.box(metal, 0.010, 0.010, st.len, -bw * 0.42, top * 0.30, stZ);
      B.box(metal, 0.010, 0.010, st.len, bw * 0.42, top * 0.30, stZ);
      B.box(metal, bw * 0.95, 0.010, 0.012, 0, top * 0.30, stZ + st.len / 2 - 0.008);
      B.box(padMat, bw * 1.04, st.h, 0.014, 0, top * 0.30, stZ + st.len / 2);
      B.box(metal, 0.014, 0.016, 0.016, -bw * 0.42, top * 0.30, halfBody + 0.010);
      B.box(metal, 0.014, 0.016, 0.016, bw * 0.42, top * 0.30, halfBody + 0.010);
      return;
    }
    if (st.type === 'brace') {
      B.cyl(metal, 0.014, st.len * 0.8, 'z', 0, 0.004 - drop, stZ - st.len * 0.08, 8);
      B.box(st.mat, bw * 0.56, 0.028, st.len * 0.7, 0, 0.004 - drop, stZ + st.len * 0.10);
      B.box(st.mat, bw * 0.72, st.h, 0.020, 0, -drop, stZ + st.len / 2 - 0.010);
      B.box(padMat, bw * 0.80, st.h * 1.02, 0.014, 0, -drop, stZ + st.len / 2 + 0.003);
      return;
    }
    // 'fixed'
    B.box(st.mat, bw * 0.86, st.h * 0.58, st.len, 0, -drop, stZ);
    B.box(DK, bw * 0.90, 0.005, st.len * 0.92, 0, -drop - st.h * 0.29, stZ);
    // Lightening cut through the flank — stops a comb-to-toe slab reading as a plank.
    B.box(DK, bw * 0.89, st.h * 0.22, st.len * 0.40, 0, -drop - st.h * 0.06, stZ - st.len * 0.10);
    B.box(DK, bw * 0.89, 0.004, st.len * 0.86, 0, -drop + st.h * 0.28, stZ);
    B.box(st.mat, bw * 0.60, 0.016, st.len * 0.64, 0, top - 0.002 - drop, stZ - st.len * 0.06);
    B.box(st.mat, bw * 0.78, st.h, 0.028, 0, -drop - st.h * 0.14, stZ + st.len / 2 - 0.014);
    B.box(padMat, bw * 0.84, st.h * 1.03, 0.014, 0, -drop - st.h * 0.14, stZ + st.len / 2 + 0.002);
    B.box(metal, 0.005, 0.014, 0.012, -(bw * 0.44), -drop, stZ + st.len * 0.30);
  }

  /**
   * @param {Batch} Bm the magazine node's batch (moves during a reload)
   * @param {Batch} B  the static batch (for anything that stays with the gun)
   */
  _magazine(Bm, B, mg, metal, padMat, DK, ga, tubeY) {
    if (mg.type === 'belt') {
      // Belt-fed box + the brass hanging out of the feed tray. Unmistakable.
      Bm.box(mg.mat, mg.w, mg.len, mg.d, 0, -mg.len / 2, 0);
      Bm.box(DK, mg.w + 0.002, 0.006, mg.d * 0.94, 0, -mg.len * 0.30, 0);
      Bm.box(DK, mg.w + 0.002, 0.006, mg.d * 0.94, 0, -mg.len * 0.70, 0);
      Bm.box(metal, mg.w * 0.42, 0.012, 0.030, 0, -0.004, -mg.d * 0.36);
      for (let i = 0; i < 5; i++) {
        Bm.box('brass', mg.w * 0.62, 0.007, 0.010, 0, 0.004 + i * 0.004, -mg.d * 0.30 - i * 0.011);
      }
      return;
    }
    if (mg.type === 'tube') {
      // Under-barrel magazine tube plus the two bands that clamp it to the barrel.
      B.cyl(metal, mg.w / 2, mg.len, 'z', 0, tubeY, -mg.len / 2 + 0.02, 8);
      B.cyl(metal, mg.w * 0.60, 0.014, 'z', 0, tubeY, -mg.len + 0.037, 8);
      B.box(DK, mg.w * 1.35, 0.008, 0.012, 0, tubeY, -mg.len * 0.30);
      B.box(metal, mg.w * 1.15, -tubeY * 1.6, 0.012, 0, tubeY * 0.42, -mg.len * 0.62);
      B.box(metal, mg.w * 1.15, -tubeY * 1.6, 0.012, 0, tubeY * 0.42, -mg.len * 0.94);
      return;
    }
    if (mg.inGrip) {
      Bm.box(mg.mat, mg.w, mg.len, mg.d, 0, -mg.len / 2 + 0.006, 0, ga);
      Bm.box(metal, mg.w * 1.35, 0.008, mg.d * 1.20, 0,
        -(mg.len - 0.006) * Math.cos(ga), 0.006 - (mg.len - 0.006) * Math.sin(ga), ga);
      return;
    }
    // Curved / straight box magazine, built from four tapering segments.
    const segs = 4;
    const seg = mg.len / segs;
    const curve = mg.curve || 0;
    for (let i = 0; i < segs; i++) {
      const t = i / (segs - 1);
      Bm.box(mg.mat, mg.w, seg * 1.03, mg.d * (1 - t * 0.10),
        0, -seg * (i + 0.5), curve * t * t * 0.95, curve * 0.95 * t, 0, 0);
    }
    // Witness holes and a grip texture band down the flank.
    for (let i = 0; i < 3; i++) {
      Bm.box(DK, mg.w + 0.0022, 0.006, 0.008, 0, -mg.len * (0.28 + i * 0.20), curve * 0.4);
    }
    Bm.box(metal, mg.w * 1.16, 0.008, mg.d * 1.06, 0, -mg.len - 0.002, curve * 0.72, curve * 0.9);
    Bm.box(padMat, mg.w * 1.18, 0.007, mg.d * 1.08, 0, -mg.len - 0.009, curve * 0.78, curve * 0.9);
  }

  /** Returns the reticle anchor { y, z } in gun-local space. */
  _optic(B, op, opticBase, upperZ, metal, DK) {
    const m = op.mat || metal;
    const h = op.height, L = op.len, w = op.w;
    const y = opticBase + h;
    const z = upperZ;

    if (op.type === 'scope') {
      // Hollow: the sight line runs straight down the bore. See `cyl`'s `open` note.
      B.cyl(m, w / 2, L * 0.62, 'z', 0, y, z, 8, w / 2, true);
      B.cyl(m, w / 2 + 0.007, L * 0.20, 'z', 0, y, z - L * 0.40, 8, w / 2 + 0.007, true); // objective bell
      B.cyl(m, w / 2 + 0.005, L * 0.17, 'z', 0, y, z + L * 0.41, 8, w / 2 + 0.005, true); // ocular
      B.cyl(DK, w / 2 + 0.008, 0.012, 'z', 0, y, z + L * 0.30, 8, w / 2 + 0.008, true);   // mag ring
      B.cyl(metal, 0.010, 0.016, 'y', 0, y + w / 2 + 0.006, z - L * 0.06, 6);  // elevation turret
      B.cyl(metal, 0.009, 0.014, 'x', w / 2 + 0.006, y, z - L * 0.06, 6);      // windage turret
      B.box(m, 0.016, h * 0.92, 0.020, 0, opticBase + h * 0.46, z - L * 0.26); // rings
      B.box(m, 0.016, h * 0.92, 0.020, 0, opticBase + h * 0.46, z + L * 0.26);
      B.box(DK, 0.020, 0.008, 0.024, 0, opticBase + h * 0.06, z - L * 0.26);
      B.box(DK, 0.020, 0.008, 0.024, 0, opticBase + h * 0.06, z + L * 0.26);
      B.cyl('glassOptic', w / 2 - 0.003, 0.004, 'z', 0, y, z + L * 0.47, 8);
      const rz = z + L * 0.44;
      this._reticleMarks(B, op, y, rz, w);
      return { y, z: rz };
    }
    if (op.type === 'holo') {
      B.box(m, w, h * 0.52, L, 0, opticBase + h * 0.28, z);
      B.box(DK, w + 0.002, 0.005, L * 0.9, 0, opticBase + h * 0.52, z);
      // Hood: posts OUTSIDE the glass, top bar ABOVE it. The reticle anchors at
      // h*0.88 and the glass runs to h*1.25, so a hood bar at h*1.00 was an opaque
      // strip crossing the sight picture ~1-2° above the reticle — exactly where a
      // player tracks a target ("the top of the scope blocks the view"). The bar now
      // clears the glass top on every holo def, and the posts are slimmer and pushed
      // to the window's edge so they frame the picture instead of eating into it.
      B.box(m, w * 0.16, h * 0.95, 0.014, -w * 0.44, opticBase + h * 0.95, z - L * 0.34);  // hood posts
      B.box(m, w * 0.16, h * 0.95, 0.014, w * 0.44, opticBase + h * 0.95, z - L * 0.34);
      B.box(m, w, 0.010, 0.016, 0, opticBase + h * 1.40, z - L * 0.34);                    // hood top
      B.box('glassOptic', w * 0.78, h * 0.74, 0.004, 0, y - h * 0.12, z - L * 0.30);
      B.box(DK, w * 0.5, 0.010, 0.012, 0, opticBase + h * 0.10, z + L * 0.42);       // buttons
      const rz = z - L * 0.30;
      this._reticleMarks(B, op, y - h * 0.12, rz, w);
      return { y: y - h * 0.12, z: rz };
    }
    if (op.type === 'reddot') {
      // Hollow, for the same reason the scope is — this is the tube you look down.
      B.cyl(m, w / 2, L, 'z', 0, y, z, 8, w / 2, true);
      B.cyl(DK, w / 2 + 0.002, 0.006, 'z', 0, y, z - L * 0.30, 8, w / 2 + 0.002, true);
      B.cyl(DK, w / 2 + 0.002, 0.006, 'z', 0, y, z + L * 0.30, 8, w / 2 + 0.002, true);
      B.box(m, 0.014, h, 0.020, 0, opticBase + h * 0.5, z + L * 0.20);
      B.box(m, 0.014, h, 0.020, 0, opticBase + h * 0.5, z - L * 0.20);
      B.box(DK, 0.020, 0.007, 0.026, 0, opticBase + h * 0.05, z);
      B.cyl(metal, 0.007, 0.010, 'x', w / 2 + 0.004, y, z + L * 0.10, 6);
      B.cyl('glassOptic', w / 2 - 0.003, 0.004, 'z', 0, y, z + L * 0.46, 8);
      B.cyl('glassOptic', w / 2 - 0.003, 0.004, 'z', 0, y, z - L * 0.46, 8);
      const rz = z + L * 0.44;
      this._reticleMarks(B, op, y, rz, w);
      return { y, z: rz };
    }
    // Irons. The anchor is the REAR APERTURE, so full ADS puts the camera behind the
    // hole and the brass bead on the front post lands dead centre — the sight picture
    // is geometrically real rather than an approximation that happens to look close.
    const ry = opticBase + h * 0.62;
    const rz = z + L * 0.5;
    B.box(m, 0.024, 0.006, 0.006, 0, opticBase + 0.004, rz);      // base
    // The camera sits behind the aperture (the anchor below), so the top bar's height
    // over `ry` IS the ceiling of the sight picture. At +0.010 it hung ~1.2° above the
    // reticle and read as "the sight blocks everything above the dot"; +0.015 keeps the
    // ghost-ring silhouette but opens the window a player actually aims through.
    B.box(m, 0.005, 0.030, 0.005, -0.009, ry + 0.002, rz);        // aperture ears
    B.box(m, 0.005, 0.030, 0.005, 0.009, ry + 0.002, rz);
    B.box(m, 0.021, 0.005, 0.005, 0, ry + 0.015, rz);             // aperture top
    B.box(m, 0.005, h * 0.62, 0.005, 0, opticBase + h * 0.31, z - L * 0.5);   // front post
    B.box('brass', 0.0045, 0.0045, 0.0045, 0, ry, z - L * 0.5);   // bead, at post top
    B.box(m, 0.004, h * 0.74, 0.004, -0.008, opticBase + h * 0.37, z - L * 0.5);
    B.box(m, 0.004, h * 0.74, 0.004, 0.008, opticBase + h * 0.37, z - L * 0.5);
    return { y: ry, z: rz - 0.004 };
  }

  /** Illuminated marks, in brass so they actually read as lit against the glass. */
  _reticleMarks(B, op, y, z, w) {
    const zz = z - 0.0025;
    if (op.reticle === 'cross') {
      B.box('brass', w * 0.55, 0.0012, 0.001, 0, y, zz);
      B.box('brass', 0.0012, w * 0.55, 0.001, 0, y, zz);
      B.box('brass', 0.0026, 0.0026, 0.001, 0, y, zz - 0.001);
    } else if (op.reticle === 'ring') {
      B.box('brass', 0.0024, 0.0024, 0.001, 0, y, zz);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        B.box('brass', 0.0030, 0.0012, 0.001,
          Math.cos(a) * w * 0.26, y + Math.sin(a) * w * 0.26, zz, 0, 0, a);
      }
    } else if (op.reticle === 'chevron') {
      B.box('brass', 0.0055, 0.0012, 0.001, -0.0016, y + 0.0012, zz, 0, 0, 0.6);
      B.box('brass', 0.0055, 0.0012, 0.001, 0.0016, y + 0.0012, zz, 0, 0, -0.6);
    } else if (op.reticle === 'post' || op.reticle === 'bead') {
      B.box('brass', 0.0028, 0.0028, 0.0028, 0, y, zz);
    } else {
      B.box('brass', 0.0026, 0.0026, 0.001, 0, y, zz);
    }
  }

  /**
   * Compute the rest pose. Pushes the gun out until its rearmost point clears the
   * camera, its optic sits `relY` half-heights below the crosshair and its lowest
   * point still fits inside the frame. Beats ten hand-tuned magic triples.
   */
  _frame(entry, group, vm) {
    const f = vm.frame || {};
    const relX = f.relX ?? FRAME.relX;
    const relY = f.relY ?? FRAME.relY;
    const near = f.near ?? FRAME.nearClear;
    const bottomMax = f.bottomMax ?? FRAME.bottomMax;
    const minDepth = f.minDepth ?? FRAME.minDepth;
    const maxDepth = f.maxDepth ?? FRAME.maxDepth;
    const bias = vm.hipBias || [0, 0, 0];
    const t = Math.tan((VIEW_FOV_HIP * DEG) / 2);

    group.updateMatrixWorld(true);
    _bb.setFromObject(group);

    let z = -(near + Math.max(0, _bb.max.z));
    if (z > -minDepth) z = -minDepth;
    let y = 0, x = 0;
    for (let i = 0; i < 64; i++) {
      const half = -z * t;
      y = -relY * half - entry.reticle.position.y;
      x = relX * half;
      if (y + _bb.min.y >= -bottomMax * half || -z >= maxDepth) break;
      z -= 0.012;
    }
    entry.hipPos.set(x + bias[0], y + bias[1], z + bias[2]);
    entry.bbox = { minY: _bb.min.y, maxZ: _bb.max.z, minZ: _bb.min.z, maxX: _bb.max.x };
  }

  // ------------------------------------------------------------------- melee

  /** Knife: blade, fuller, guard, wrapped grip. */
  _buildKnife(def) {
    const vm = def.viewmodel;
    const k = vm.knife;
    const group = new THREE.Group();
    const geos = [];
    const B = new Batch();

    B.box(k.gripMat, 0.026, k.gripLen, 0.020, 0, 0, 0.05);
    for (let i = 0; i < 5; i++) {
      B.box('gunmetal', 0.028, 0.003, 0.022, 0, -k.gripLen * 0.34 + i * 0.017, 0.05);
    }
    B.box('gunmetal', 0.030, 0.014, 0.024, 0, -k.gripLen * 0.56, 0.05);          // pommel
    B.box(k.mat, 0.052, 0.010, 0.026, 0, k.gripLen * 0.55, 0.038);               // guard
    B.box(k.mat, k.bladeW, k.bladeT, k.bladeLen, 0, k.gripLen * 0.6 + 0.004, 0.03 - k.bladeLen / 2);
    B.box('rubber', k.bladeW * 0.42, k.bladeT * 0.7, k.bladeLen * 0.72,
      0, k.gripLen * 0.6 + 0.005, 0.03 - k.bladeLen * 0.52);                     // fuller
    B.box(k.mat, k.bladeW * 0.55, k.bladeT * 0.85, k.bladeLen * 0.18,
      0, k.gripLen * 0.6 + 0.004, 0.03 - k.bladeLen * 0.94);                     // point
    B.flush(group, geos);

    const anchor = new THREE.Object3D();
    anchor.position.set(0, k.gripLen * 0.6, 0.03 - k.bladeLen);
    group.add(anchor);
    return {
      def, group, parts: {}, geos, tris: B.tris,
      muzzle: anchor, eject: anchor, reticle: anchor,
      adsPos: new THREE.Vector3(0, -0.06, -0.34),
      hipPos: new THREE.Vector3().fromArray(vm.hipPos || [0.16, -0.18, -0.34]),
      hipRot: new THREE.Euler().fromArray(vm.hipRot || [0, 0, 0]),
      boltThrow: 0, pumpThrow: 0, boltLock: false, vmFovAds: 70, kickMul: 1, isMelee: true,
    };
  }

  /** Grenade in hand: body, lever, pin ring. */
  _buildGrenade(def) {
    const vm = def.viewmodel;
    const g = vm.grenade;
    const group = new THREE.Group();
    const geos = [];
    const B = new Batch();

    if (g.cylinder) {
      B.cyl(g.mat, g.r, g.len, 'y', 0, 0, 0, 10);
      B.cyl('rubber', g.r * 1.02, 0.006, 'y', 0, g.len * 0.22, 0, 10);
      B.cyl('rubber', g.r * 1.02, 0.006, 'y', 0, -g.len * 0.22, 0, 10);
      B.box('gunmetal', g.r * 1.5, 0.010, g.r * 1.5, 0, g.len / 2, 0);
    } else {
      B.cyl(g.mat, g.r, g.r * 1.7, 'y', 0, 0, 0, 10, g.r * 0.82);
      for (let i = 0; i < 4; i++) B.box('rubber', g.r * 2.08, 0.004, g.r * 2.08, 0, -g.r * 0.5 + i * g.r * 0.42, 0);
      B.box('gunmetal', g.r * 0.7, 0.014, g.r * 0.7, 0, g.r * 0.92, 0);
    }
    B.box(g.leverMat, 0.010, g.r * 1.9, 0.008, g.r * 0.85, g.r * 0.2, 0);
    B.cyl(g.leverMat, 0.012, 0.004, 'y', g.r * 0.6, g.r * 1.0, -g.r * 0.5, 8);
    B.flush(group, geos);

    const anchor = new THREE.Object3D();
    group.add(anchor);
    return {
      def, group, parts: {}, geos, tris: B.tris,
      muzzle: anchor, eject: anchor, reticle: anchor,
      adsPos: new THREE.Vector3(0, -0.06, -0.32),
      hipPos: new THREE.Vector3().fromArray(vm.hipPos || [0.15, -0.2, -0.3]),
      hipRot: new THREE.Euler().fromArray(vm.hipRot || [0, 0, 0]),
      boltThrow: 0, pumpThrow: 0, boltLock: false, vmFovAds: 70, kickMul: 1, isMelee: true,
    };
  }

  // ------------------------------------------------------------- animation hooks

  /** A round left the barrel. */
  onFire(scale = 1) {
    const c = this.current;
    if (!c) return;
    const rc = this.def?.recoil || { kick: 0.05 };
    const k = (rc.kick || 0.05) * scale * (c.kickMul || 1);
    const rng = this.game.rng;

    this.kickVelZ += k * 26;
    this.kickVelPitch += k * 30;
    this.kickY += k * 0.16;
    this.kickYaw += (rng() - 0.5) * k * 1.1;
    this.kickRoll += (rng() - 0.5) * k * 1.6;

    this.boltT = 1;
    this.boltDur = clamp((this.def?.rechamberTime ? 0.16 : 60 / (this.def?.rpm || 700)) * 0.75, 0.035, 0.22);
    if (c.pumpThrow > 0) { this.pumpT = 1; this.pumpDur = (this.def?.rechamberTime || 0.45) * 0.9; }

    // Muzzle light lives in the view scene so the gun self-illuminates on every shot.
    const light = this.engine?.viewMuzzleLight;
    if (light) {
      c.muzzle.getWorldPosition(_v);
      light.position.copy(_v);
      light.color.setHex(0xffca7a);
      light.intensity = this.def?.class === 'sniper' || this.def?.class === 'lmg' ? 14 : 9;
    }
  }

  onReloadStart(duration, isEmpty) {
    this.reloadActive = true;
    this.reloadEmpty = !!isEmpty;
    this.reloadDur = Math.max(0.2, duration);
    this.reloadP = 0;
    this._reloadStage = 0;
    this.inspectT = 0;
  }

  onReloadCancel() {
    this.reloadActive = false;
    this.reloadP = 0;
    this._reloadStage = 0;
    const c = this.current;
    if (c?.parts?.mag && c.parts.magRest) {
      c.parts.mag.position.copy(c.parts.magRest);
      c.parts.mag.rotation.z = 0;
      c.parts.mag.visible = true;
    }
  }

  onSwitchOut(duration) {
    this.switchDir = -1;
    this.switchDur = Math.max(0.05, duration);
    this.switchT = this.switchDur;
    this.reloadActive = false;
    this.inspectT = 0;
  }

  onSwitchIn(duration) {
    this.switchDir = 1;
    this.switchDur = Math.max(0.05, duration);
    this.switchT = this.switchDur;
    this.lowerAmount = 1;
    this.reloadActive = false;
  }

  onInspect() {
    if (this.reloadActive || this.switchT > 0 || this.meleeT > 0) return;
    this.inspectT = this.inspectDur;
  }

  onMelee(duration = 0.55) {
    this.meleeDur = duration;
    this.meleeT = duration;
    this.inspectT = 0;
  }

  onThrow() { this.throwT = 0.55; }

  /** Damage flinch — a shove on the gun, damped back out. */
  onFlinch(amount = 1) {
    const rng = this.game.rng;
    this.flinchPitch += clamp(amount, 0, 1) * 0.10;
    this.flinchYaw += (rng() - 0.5) * clamp(amount, 0, 1) * 0.14;
  }

  // ------------------------------------------------------------- world anchors

  /**
   * Muzzle position in WORLD space (main scene), so tracers and impacts line up with
   * what the player sees. The viewmodel lives under a separate camera with its own FOV,
   * so the offset is rescaled by the tangent ratio before being pushed into world space —
   * without that the streak leaves the barrel a few centimetres off on screen.
   * @returns {boolean} true when `out` was written
   */
  getMuzzleWorldPosition(out) {
    return this._anchorToWorld(this.current?.muzzle, out);
  }

  getEjectWorldPosition(out) {
    return this._anchorToWorld(this.current?.eject, out);
  }

  _anchorToWorld(node, out) {
    if (!node || !this.current) return false;
    if (!this.current.group.visible && !this._scopeHidden) return false;
    const engine = this.engine;
    const viewCam = engine?.viewCamera;
    const mainCam = this.game.camera;
    if (!viewCam || !mainCam) return false;

    node.getWorldPosition(out);
    viewCam.updateWorldMatrix(true, false);
    viewCam.worldToLocal(out);

    const k = Math.tan((mainCam.fov * DEG) / 2) / Math.tan((viewCam.fov * DEG) / 2);
    out.x *= k;
    out.y *= k;

    mainCam.updateWorldMatrix(true, false);
    mainCam.localToWorld(out);
    return true;
  }

  // ------------------------------------------------------------- per-frame

  /**
   * @param {number} dtFrame real frame delta (already clamped by the game loop)
   * @param {object|null} inst the player's WeaponInstance
   * @param {object|null} owner the player entity
   */
  update(dtFrame, inst, owner) {
    const dt = clamp(dtFrame, 0, 0.05);
    this.time += dt;
    const c = this.current;
    if (!c) return;

    const ads = inst ? inst.adsAmount : 0;
    this.adsAmount = ads;

    // ---------------------------------------------------------- scope takeover
    // At full ADS a telescopic optic sits ON the camera axis, so the tube, the turrets
    // and the objective bell fill the middle of the screen — the gun is standing in
    // front of its own sight picture. Once the aperture has closed to the width of the
    // ocular there is nothing left of the model worth drawing, so it goes away, exactly
    // as it does in every game that ships a sniper rifle. `_scopeHidden` keeps the
    // muzzle and eject anchors live while it is gone.
    const scopeAmt = this.engine?.scope?.amount ?? 0;
    const hide = scopeAmt > 0.5;
    if (hide !== this._scopeHidden) {
      this._scopeHidden = hide;
      c.group.visible = !hide;
      if (this.dropMag && hide) this.dropMag.visible = false;
    }

    // ---------------------------------------------------------- sprint / lower
    const sprinting = !!(owner?.sprinting) && ads < 0.02 && !(inst?.triggerDown)
      && !this.reloadActive && this.meleeT <= 0;
    this.sprintAmount = damp(this.sprintAmount, sprinting ? 1 : 0, sprinting ? 9 : 13, dt);

    if (this.switchT > 0) {
      this.switchT -= dt;
      const t = clamp(1 - this.switchT / this.switchDur, 0, 1);
      this.lowerAmount = this.switchDir < 0 ? smoothstep(t) : 1 - smoothstep(t);
      if (this.switchT <= 0) { this.lowerAmount = this.switchDir < 0 ? 1 : 0; this.switchDir = 0; }
    } else if (this.switchDir === 0) {
      this.lowerAmount = damp(this.lowerAmount, 0, 12, dt);
    }

    // ---------------------------------------------------------- reload timing
    // Progress is read straight off the instance so the animation always lands on the
    // frame the magazine actually goes in, even if the simulation hitched.
    if (inst && inst.isReloading) {
      this.reloadActive = true;
      this.reloadEmpty = inst.reloadIsEmpty;
      this.reloadDur = inst.stateDuration;
      const p = clamp(inst.stateProgress, 0, 1);
      this._reloadStages(p);
      this.reloadP = p;
    } else if (this.reloadActive) {
      this._reloadStages(1);
      this.reloadActive = false;
      this.reloadP = 0;
      if (c.parts.mag && c.parts.magRest) {
        c.parts.mag.position.copy(c.parts.magRest);
        c.parts.mag.rotation.z = 0;
        c.parts.mag.visible = true;
      }
    }

    // Bolt hold-open on a dry magazine — the clearest "you are empty" tell there is.
    // It latches: once the bolt is back it STAYS back through the whole reload and is
    // released by the bolt-release beat at 84 %, which is what the slam you hear is.
    if (c.boltLock && inst) {
      if (inst.ammo <= 0 && !this.reloadActive) this.boltLocked = true;
      else if (inst.ammo > 0) this.boltLocked = false;
    } else {
      this.boltLocked = false;
    }

    // ---------------------------------------------------------- one-shot timers
    if (this.inspectT > 0) this.inspectT -= dt;
    if (this.meleeT > 0) this.meleeT -= dt;
    if (this.throwT > 0) this.throwT -= dt;
    if (this.boltT > 0) this.boltT = Math.max(0, this.boltT - dt / this.boltDur);
    if (this.pumpT > 0) this.pumpT = Math.max(0, this.pumpT - dt / this.pumpDur);

    // ---------------------------------------------------------- recoil spring
    // Critically-ish damped: a hard impulse, a fast return, a touch of overshoot.
    const rec = (this.def?.recoil?.recovery || 8);
    const stiff = rec * 9;
    const dampC = rec * 1.15;
    this.kickVelZ += (-this.kickZ * stiff - this.kickVelZ * dampC) * dt;
    this.kickZ += this.kickVelZ * dt;
    this.kickVelPitch += (-this.kickPitch * stiff - this.kickVelPitch * dampC) * dt;
    this.kickPitch += this.kickVelPitch * dt;
    this.kickY = damp(this.kickY, 0, rec * 1.4, dt);
    this.kickYaw = damp(this.kickYaw, 0, rec * 1.2, dt);
    this.kickRoll = damp(this.kickRoll, 0, rec * 1.1, dt);
    this.flinchPitch = damp(this.flinchPitch, 0, 6.5, dt);
    this.flinchYaw = damp(this.flinchYaw, 0, 6.5, dt);

    this.kick.position.set(0, this.kickY * 0.35, this.kickZ);
    this.kick.rotation.set(-this.kickPitch, this.kickYaw, this.kickRoll);

    // ---------------------------------------------------------- look sway
    let dYaw = 0, dPitch = 0;
    if (owner) {
      if (this._haveLast) {
        dYaw = this._angleDelta(this._lastYaw, owner.yaw);
        dPitch = owner.pitch - this._lastPitch;
      }
      this._lastYaw = owner.yaw;
      this._lastPitch = owner.pitch;
      this._haveLast = true;
    }
    const settingSway = clamp(Number(this.game?.settings?.get?.('weaponSway')) || 0, 0, 1);
    const swayScale = (1 - ads) * (1 - this.lowerAmount) * settingSway;
    this.swayX = damp(this.swayX, clamp(-dYaw * 2.4, -0.05, 0.05), 9, dt);
    this.swayY = damp(this.swayY, clamp(-dPitch * 2.0, -0.05, 0.05), 9, dt);

    // ---------------------------------------------------------- bob + breathing
    let speed = 0;
    let grounded = true;
    if (owner) {
      const vx = owner.velocity?.x || 0, vz = owner.velocity?.z || 0;
      speed = Math.sqrt(vx * vx + vz * vz);
      grounded = owner.grounded !== false;
    }
    const bobSpeed = grounded ? clamp(speed / 5.2, 0, 1.6) : 0;
    this.bobPhase += dt * (7.0 + bobSpeed * 5.5) * (bobSpeed > 0.02 ? 1 : 0.0);
    this.breathPhase += dt * 1.35;

    const bobAmp = bobSpeed * 0.016 * (1 - ads * 0.88) * (1 - this.lowerAmount) * settingSway;
    const bobX = Math.sin(this.bobPhase) * bobAmp;
    const bobY = -Math.abs(Math.cos(this.bobPhase)) * bobAmp * 0.9;
    const breath = Math.sin(this.breathPhase) * 0.0026 * (1 - ads * 0.55) * (1 - bobSpeed * 0.5) * settingSway;
    const idleX = Math.sin(this.time * 0.72) * 0.0022 * (1 - ads) * (1 - bobSpeed) * settingSway;
    const idleY = Math.cos(this.time * 0.53) * 0.0018 * (1 - ads) * (1 - bobSpeed) * settingSway;

    // ---------------------------------------------------------- pose blend
    // hip -> ADS. The ADS position is derived from the optic so the reticle lands on
    // the crosshair exactly; nothing additive survives at adsAmount === 1.
    const hip = c.hipPos, adsP = c.adsPos, hipR = c.hipRot;
    let px = lerp(hip.x, adsP.x, ads);
    let py = lerp(hip.y, adsP.y, ads);
    let pz = lerp(hip.z, adsP.z, ads);
    let rx = lerp(hipR.x, 0, ads);
    let ry = lerp(hipR.y, 0, ads);
    let rz = lerp(hipR.z, 0, ads);

    // ADS travel arc: the gun swings in rather than sliding on a rail. Peaks at the
    // halfway point and is exactly zero at both ends, so alignment is untouched.
    const swing = ads * (1 - ads) * 4;
    if (swing > 0.001) {
      px += 0.030 * swing;
      py += -0.014 * swing;
      rz += -0.10 * swing;
    }

    // Sprint pose: gun canted down and out to the right, muzzle low and inboard.
    const s = this.sprintAmount;
    if (s > 0.001) {
      px = lerp(px, hip.x + 0.045, s);
      py = lerp(py, hip.y - 0.055, s);
      pz = lerp(pz, hip.z + 0.150, s);
      rx = lerp(rx, 0.30, s);
      ry = lerp(ry, -0.70, s);
      rz = lerp(rz, 0.60, s);
      // Run cycle: a heavier, slower swing than the walk bob.
      const rc2 = Math.sin(this.bobPhase * 0.5) * s;
      px += rc2 * 0.020;
      py += Math.abs(Math.cos(this.bobPhase * 0.5)) * -0.014 * s;
      ry += rc2 * 0.10;
    }

    // Lowered for a weapon switch.
    if (this.lowerAmount > 0.001) {
      const l = this.lowerAmount;
      py += -0.26 * l;
      pz += 0.05 * l;
      rx += 0.85 * l;
      rz += 0.18 * l;
    }

    // Additive animation layers (all fade with ADS so alignment stays exact).
    px += (bobX + idleX + this.swayX) * swayScale;
    py += (bobY + idleY + breath * 3) * swayScale;
    rx += (this.swayY * 0.9 + this.flinchPitch) * (1 - ads * 0.55);
    ry += (this.swayX * 1.6 + this.flinchYaw) * (1 - ads * 0.55);
    rz += this.swayX * 2.2 * swayScale;

    // Reload gun tilt.
    if (this.reloadActive) {
      const p = this.reloadP;
      const shape = Math.sin(clamp(p, 0, 1) * Math.PI);
      px += -0.055 * shape;
      py += -0.045 * shape;
      pz += 0.030 * shape;
      rx += 0.16 * shape;
      ry += 0.34 * shape;
      rz += -0.42 * shape;
      // Mag-tap snap, then the bolt release slap on an empty reload.
      const tap = this._pulse(p, 0.70, 0.06);
      py += -0.016 * tap;
      rx += 0.05 * tap;
      if (this.reloadEmpty) {
        const slap = this._pulse(p, 0.86, 0.05);
        px += 0.012 * slap;
        rz += -0.06 * slap;
      }
    }

    // Inspect: raise, roll to show the left side, roll back.
    if (this.inspectT > 0) {
      const p = 1 - this.inspectT / this.inspectDur;
      const env = Math.sin(clamp(p, 0, 1) * Math.PI);
      px += -0.075 * env;
      py += 0.030 * env;
      pz += 0.075 * env;
      ry += 1.05 * env * (p < 0.5 ? 1 : 0.55);
      rz += -0.55 * env;
      rx += 0.12 * Math.sin(p * Math.PI * 2) * env;
    }

    // Melee: pull back, swipe across, recover.
    if (this.meleeT > 0) {
      const p = 1 - this.meleeT / this.meleeDur;
      const windup = clamp(p / 0.28, 0, 1);
      const swipe = clamp((p - 0.28) / 0.34, 0, 1);
      const back = clamp((p - 0.62) / 0.38, 0, 1);
      const e = smoothstep(windup) - smoothstep(swipe) * 1.9 + smoothstep(back) * 0.9;
      px += 0.10 * e;
      pz += 0.10 * smoothstep(windup) - 0.16 * smoothstep(swipe) + 0.06 * smoothstep(back);
      ry += 0.85 * e;
      rz += -0.70 * e;
      rx += 0.20 * smoothstep(windup) - 0.30 * smoothstep(swipe);
    }

    // Grenade throw: overhand arc.
    if (this.throwT > 0) {
      const p = 1 - this.throwT / 0.55;
      const env = Math.sin(clamp(p, 0, 1) * Math.PI);
      py += 0.10 * env;
      pz += 0.06 * env;
      rx += -0.75 * env;
    }

    this.pose.position.set(px, py, pz);
    this.pose.rotation.set(rx, ry, rz);

    // ---------------------------------------------------------- moving parts
    this._animateParts();

    // ---------------------------------------------------------- view FOV + light
    // The viewmodel camera's FOV is owned here (PlayerCamera publishes the settings
    // scale but deliberately does not write it) so a scoped weapon can pull the
    // model in without the two systems fighting over the same field every frame.
    const viewCam = this.engine?.viewCamera;
    if (viewCam) {
      const scale = this.game.player?.camera?.viewFovScale || 1;
      const targetFov = lerp(VIEW_FOV_HIP, c.vmFovAds, ads) * scale;
      if (Math.abs(viewCam.fov - targetFov) > 0.02) {
        viewCam.fov = targetFov;
        viewCam.updateProjectionMatrix();
      }
    }
    const light = this.engine?.viewMuzzleLight;
    if (light && light.intensity > 0.01) {
      c.muzzle.getWorldPosition(_v);
      light.position.copy(_v);
    }

    this._updateDropMag(dt);
  }

  /** Bolt / slide / pump travel, and the magazine while reloading. */
  _animateParts() {
    const c = this.current;
    const parts = c.parts;

    if (parts.bolt && c.boltThrow > 0) {
      // Fast rearward snap, slower return — reads as a violent cycle.
      const t = this.boltT;
      const travel = this.boltLocked ? 1 : (t > 0.55 ? (1 - t) / 0.45 : t / 0.55);
      parts.bolt.position.z = c.parts.boltRest.z + clamp(travel, 0, 1) * c.boltThrow;
    }

    if (parts.pump && c.pumpThrow > 0) {
      const t = this.pumpT;
      const travel = t > 0.5 ? (1 - t) / 0.5 : t / 0.5;
      parts.pump.position.z = clamp(travel, 0, 1) * c.pumpThrow;
    }
  }

  /** Fires the discrete beats of the reload at fixed fractions of its duration. */
  _reloadStages(p) {
    const c = this.current;
    if (!c) return;
    const parts = c.parts;
    const pos = this.game.player?.position;
    const audio = this.game.audio;
    const drops = parts.magDrops !== false;

    /*
     * A recorded reload is ONE take of the whole handling sequence — mag out, mag in, tap,
     * bolt — so when the sample bank has one it plays at stage 1 and the per-stage synth
     * clicks that would otherwise double it are skipped. Without it (offline, still
     * loading, decode failed) `composite` is null and every stage below fires exactly as
     * it always has.
     *
     * The class split is here because this is the only place that knows it: `weaponSystem`
     * plays reloads by name for entities with no viewmodel (bots), where a pistol and a
     * rifle sound the same from thirty metres and nobody can tell.
     */
    let composite = null;
    if (this._reloadStage < 1 && p >= 0.18 && typeof audio?.isSampled === 'function') {
      const name = c.def?.class === 'pistol' ? 'reloadPistol' : 'reloadRifle';
      if (audio.isSampled(name)) composite = name;
    }

    // Stage 1 — mag release and drop.
    if (this._reloadStage < 1 && p >= 0.18) {
      this._reloadStage = 1;
      this._reloadComposite = !!composite;
      audio?.play?.(composite || 'magOut', { position: pos, volume: 0.85 });
      if (drops) this._spawnDropMag();
    }
    // Stage 2 — new mag seated.
    if (this._reloadStage < 2 && p >= 0.52) {
      this._reloadStage = 2;
      if (!this._reloadComposite) audio?.play?.('magIn', { position: pos, volume: 0.9 });
    }
    // Stage 3 — mag tap.
    if (this._reloadStage < 3 && p >= 0.72) {
      this._reloadStage = 3;
      if (!this._reloadComposite) audio?.play?.('magIn', { position: pos, volume: 0.4, rate: 1.5 });
    }
    // Stage 4 — bolt release (empty reloads only).
    if (this._reloadStage < 4 && p >= 0.84) {
      this._reloadStage = 4;
      if (this.reloadEmpty) {
        if (!this._reloadComposite) audio?.play?.('boltForward', { position: pos, volume: 0.9 });
        this.boltLocked = false;
        this.boltT = 1;
        this.boltDur = 0.12;
      }
    }
    if (p >= 1) this._reloadStage = 0;

    // Magazine travel: out of the well, gone, then back up into it.
    if (drops && parts.mag && parts.magRest) {
      let dy = 0, dz = 0, roll = 0;
      if (p >= 0.18 && p < 0.50) {
        const t = clamp((p - 0.18) / 0.32, 0, 1);
        dy = -0.22 * t;
        dz = 0.02 * t;
        roll = 0.5 * t;
      } else if (p >= 0.50 && p < 0.72) {
        const t = clamp((p - 0.50) / 0.22, 0, 1);
        dy = -0.22 * (1 - smoothstep(t));
        dz = 0.02 * (1 - t);
        roll = 0.5 * (1 - t);
      }
      parts.mag.position.set(parts.magRest.x, parts.magRest.y + dy, parts.magRest.z + dz);
      parts.mag.rotation.z = roll;
      parts.mag.visible = !(p >= 0.30 && p < 0.50);
    }
  }

  /** Throw a physical magazine out of the gun; it falls out of view and recycles. */
  _spawnDropMag() {
    const c = this.current;
    if (!this.dropMag || !c?.parts?.mag) return;
    const rng = this.game.rng;
    c.parts.mag.getWorldPosition(_v);
    this.dropMag.position.copy(_v);
    this.dropMag.rotation.set(rng() * 0.4, rng() * 0.6, rng() * 0.3);
    this.dropMagVel.set(rng.range(-0.06, 0.06), -0.12, rng.range(-0.02, 0.06));
    this.dropMagSpin.set(rng.range(-3, 3), rng.range(-2, 2), rng.range(-4, 4));
    this.dropMag.visible = true;
    this.dropMagLife = 1.1;
  }

  _updateDropMag(dt) {
    if (!this.dropMag || this.dropMagLife <= 0) return;
    this.dropMagLife -= dt;
    if (this.dropMagLife <= 0) { this.dropMag.visible = false; return; }
    this.dropMagVel.y -= 3.2 * dt;
    this.dropMag.position.addScaledVector(this.dropMagVel, dt);
    this.dropMag.rotation.x += this.dropMagSpin.x * dt;
    this.dropMag.rotation.y += this.dropMagSpin.y * dt;
    this.dropMag.rotation.z += this.dropMagSpin.z * dt;
  }

  // ------------------------------------------------------------- utils

  _pulse(p, at, width) {
    const d = Math.abs(p - at);
    return d > width ? 0 : 1 - d / width;
  }

  _angleDelta(a, b) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  _applyRestPose() {
    const c = this.current;
    if (!c) return;
    this.pose.position.copy(c.hipPos);
    this.pose.rotation.copy(c.hipRot);
    this.kick.position.set(0, 0, 0);
    this.kick.rotation.set(0, 0, 0);
  }

  reset() {
    this.sprintAmount = 0;
    this.lowerAmount = 0;
    this.reloadActive = false;
    this._reloadStage = 0;
    this.inspectT = this.meleeT = this.throwT = 0;
    this.kickZ = this.kickY = this.kickPitch = this.kickYaw = this.kickRoll = 0;
    this.kickVelZ = this.kickVelPitch = 0;
    this.flinchPitch = this.flinchYaw = 0;
    this.boltT = this.pumpT = 0;
    this.boltLocked = false;
    this._haveLast = false;
    if (this._scopeHidden) {
      this._scopeHidden = false;
      if (this.current) this.current.group.visible = true;
    }
    if (this.dropMag) { this.dropMag.visible = false; this.dropMagLife = 0; }
    this._applyRestPose();
  }

  dispose() {
    // Each weapon owns its baked geometry; the unit primitives are shared and freed
    // once at the end (a traversal would double-dispose them).
    for (const entry of this.cache.values()) {
      entry.group.parent?.remove(entry.group);
      if (entry.geos) for (const g of entry.geos) g.dispose();
    }
    this.cache.clear();
    for (const g of _cylCache.values()) g.dispose();
    _cylCache.clear();
    _unitBox?.dispose();
    _unitBox = null;
    this.dropMag?.parent?.remove(this.dropMag);
    this.root.parent?.remove(this.root);
    this.current = null;
  }
}
