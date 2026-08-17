/**
 * THROWAWAY REVIEW PROBE — hand-built, game-realistic frag scenarios,
 * baseline (2e69c49) vs HEAD `applyExplosionDamage`.
 *
 * Uses the real M67 FRAG numbers from weaponDefs.js: radius 6.5, damage 130, falloffPow 1.35.
 */
import * as THREE from 'three';
import * as HEAD from '../src/weapons/ballistics.js';
import * as BASE from './review_base_ballistics.js';

const FRAG = { radius: 6.5, damage: 130, falloff: 1.35 };

function rayAabb(o, d, box, maxDist) {
  let tmin = -Infinity, tmax = Infinity;
  for (let a = 0; a < 3; a++) {
    const oo = a === 0 ? o.x : a === 1 ? o.y : o.z;
    const dd = a === 0 ? d.x : a === 1 ? d.y : d.z;
    const lo = box.min[a], hi = box.max[a];
    if (Math.abs(dd) < 1e-9) { if (oo < lo || oo > hi) return null; continue; }
    const inv = 1 / dd;
    let t1 = (lo - oo) * inv, t2 = (hi - oo) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  const t = tmin < 0 ? 0 : tmin;
  return t > maxDist ? null : t;
}

function makeWorld(boxes) {
  const d = new THREE.Vector3();
  return {
    raycast() { return null; },   // unused by applyExplosionDamage
    losClear(a, b) {
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) return true;
      d.set(dx / len, dy / len, dz / len);
      for (const box of boxes) {
        const t = rayAabb(a, d, box, len - 1e-4);
        if (t !== null && t > 1e-4) return false;
      }
      return true;
    },
  };
}

function ent(x, z, height) {
  return {
    id: 1, isPlayer: true, team: 0, alive: true, name: 'victim',
    position: new THREE.Vector3(x, 0, z), velocity: new THREE.Vector3(),
    yaw: 0, pitch: 0, height, radius: 0.36, eyeHeight: height * 0.9,
    health: 1e9, maxHealth: 100, armor: 0, hitboxes: [],
    stats: { kills: 0, deaths: 0, score: 0, streak: 0 },
    getEyePosition(o) { return o.set(this.position.x, this.position.y + this.eyeHeight, this.position.z); },
    getAimDirection(o) { return o.set(0, 0, -1); },
    applyDamage(a) { this.health -= a; },
    die() {},
  };
}

function run(mod, boxes, e, blastPoint) {
  const game = {
    bus: { emit() {}, on() { return () => {}; } },
    world: makeWorld(boxes),
    entities: [e], player: e, match: null,
    fx: {}, audio: {},
  };
  e.health = 1e9;
  mod.applyExplosionDamage(game, {
    point: blastPoint, radius: FRAG.radius, damage: FRAG.damage,
    attacker: null, weaponId: 'frag', falloff: FRAG.falloff, selfMul: 1,
  });
  return 1e9 - e.health;
}

const CASES = [];

// ── CASE A ────────────────────────────────────────────────────────────────────
// Fully exposed target in the open, 4.5 m from the burst (0.69 r — just past the
// 60 % gate). Nothing in the world at all except a ground slab well below.
CASES.push({
  name: 'A. open ground, standing, 4.5 m (0.69r) — fully exposed',
  boxes: [{ min: [-50, -2, -50], max: [50, -1.5, 50] }],
  e: ent(4.5, 0, 1.8),
  point: new THREE.Vector3(0, 0.99, 0),   // frag resting on the floor, chest-line level
});

// ── CASE B ────────────────────────────────────────────────────────────────────
// Same, but at 3.5 m (0.54 r) — INSIDE the 60 % gate, so the full 3-probe path runs.
CASES.push({
  name: 'B. open ground, standing, 3.5 m (0.54r) — inside the near gate',
  boxes: [{ min: [-50, -2, -50], max: [50, -1.5, 50] }],
  e: ent(3.5, 0, 1.8),
  point: new THREE.Vector3(0, 0.99, 0),
});

// ── CASE C ────────────────────────────────────────────────────────────────────
// Head and feet occluded, chest clear, 4.5 m: a target standing in a window slot /
// under a catwalk with a low crate at his shins. Baseline exposure 0.5 -> HEAD 0.75.
CASES.push({
  name: 'C. window slot (head + feet blocked, chest clear), 4.5 m (0.69r)',
  boxes: [
    { min: [-50, -2, -50], max: [50, -1.5, 50] },          // ground, well below
    { min: [2.0, 1.20, -2], max: [2.3, 6.0, 2] },          // lintel / catwalk above the slot
    { min: [2.0, -0.5, -2], max: [2.3, 0.60, 2] },         // sill / crate below the slot
  ],
  e: ent(4.5, 0, 1.8),
  point: new THREE.Vector3(0, 0.99, 0),
});

// ── CASE D ────────────────────────────────────────────────────────────────────
// Crouched behind a low crate at 4.5 m: chest BLOCKED, head clear over the top.
// Baseline gives the head its 0.25. HEAD zeroes it because 4.5 m > 0.6r.
CASES.push({
  name: 'D. head over a low crate, chest blocked, 4.5 m (0.69r)',
  boxes: [
    { min: [-50, -2, -50], max: [50, -1.5, 50] },
    { min: [2.0, -0.5, -2], max: [2.3, 1.10, 2] },         // crate up to 1.10 m
  ],
  e: ent(4.5, 0, 1.8),
  point: new THREE.Vector3(0, 0.99, 0),
});

// ── CASE E ────────────────────────────────────────────────────────────────────
// Prone-ish / feet-only exposure under a gap at 4.5 m: chest AND head blocked, feet clear.
// Baseline 0.25; HEAD 0 (far branch) — and even inside 0.6r HEAD would give 0 because the
// far-side branch only ever probes the HEAD, never the feet.
CASES.push({
  name: 'E. feet visible under a gap, chest+head blocked, 4.5 m (0.69r)',
  boxes: [
    { min: [-50, -2, -50], max: [50, -1.5, 50] },
    { min: [2.0, 0.35, -2], max: [2.3, 6.0, 2] },          // wall from 0.35 m up
  ],
  e: ent(4.5, 0, 1.8),
  point: new THREE.Vector3(0, 0.20, 0),
});

// ── CASE F ────────────────────────────────────────────────────────────────────
// Same feet-only geometry but INSIDE the near gate (3.0 m = 0.46r): the chest-blocked
// near branch probes only the head, so the clear feet are still never counted.
CASES.push({
  name: 'F. feet visible under a gap, chest+head blocked, 3.0 m (0.46r) — INSIDE the gate',
  boxes: [
    { min: [-50, -2, -50], max: [50, -1.5, 50] },
    { min: [1.4, 0.35, -2], max: [1.7, 6.0, 2] },
  ],
  e: ent(3.0, 0, 1.8),
  point: new THREE.Vector3(0, 0.20, 0),
});

console.log('=== M67 FRAG (r=6.5, dmg=130, pow=1.35) — baseline vs HEAD ===\n');
let worst = 0;
for (const c of CASES) {
  const b = run(BASE, c.boxes, c.e, c.point);
  const h = run(HEAD, c.boxes, c.e, c.point);
  const d = h - b;
  if (Math.abs(d) > Math.abs(worst)) worst = d;
  const flag = Math.abs(d) < 1e-9 ? 'same' : (d > 0 ? `+${d.toFixed(2)} HP  *** MORE DAMAGE ***` : `${d.toFixed(2)} HP  <-- LESS DAMAGE`);
  console.log(c.name);
  console.log(`   base=${b.toFixed(2)} HP   head=${h.toFixed(2)} HP   delta=${flag}\n`);
}
console.log(`worst delta: ${worst.toFixed(2)} HP on a single frag`);
