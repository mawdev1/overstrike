import * as THREE from 'three';

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const PITCH_LIMIT = 1.5533; // 89°

/**
 * The simulation step. ARCHITECTURE.md §1: `dt` passed to `fixedUpdate` is ALWAYS this.
 * It lives here rather than in core/game.js so the systems that derive clocks from it
 * (Game.time, Match.elapsed) can share one definition without importing the Game module
 * that imports them.
 */
export const FIXED_DT = 1 / 120;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const saturate = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Frame-rate independent exponential approach. `rate` ~= how fast, in 1/s. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

export function dampVec(out, target, rate, dt) {
  const t = 1 - Math.exp(-rate * dt);
  out.x += (target.x - out.x) * t;
  out.y += (target.y - out.y) * t;
  out.z += (target.z - out.z) * t;
  return out;
}

/** Shortest signed angular difference b-a, wrapped to [-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function moveAngleTowards(a, b, maxStep) {
  const d = angleDelta(a, b);
  if (Math.abs(d) <= maxStep) return b;
  return a + Math.sign(d) * maxStep;
}

/** Direction vector from yaw/pitch per the architecture contract. */
export function dirFromAngles(yaw, pitch, out = new THREE.Vector3()) {
  const cp = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

/** Inverse of dirFromAngles. */
export function anglesFromDir(dir, out = { yaw: 0, pitch: 0 }) {
  out.pitch = Math.asin(clamp(dir.y, -1, 1));
  out.yaw = Math.atan2(-dir.x, -dir.z);
  return out;
}

/** Yaw that points from `from` to `to` (ignores Y). */
export function yawTo(from, to) {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

/** Cone-spread a direction by up to `halfAngleRad`, biased toward the centre. */
const _u = new THREE.Vector3(), _r = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
export function spreadDir(dir, halfAngleRad, rng, out = new THREE.Vector3()) {
  out.copy(dir);
  if (halfAngleRad <= 0) return out;
  // Build a basis around dir.
  _r.crossVectors(dir, _up);
  if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0);
  _r.normalize();
  _u.crossVectors(_r, dir).normalize();
  // sqrt() gives uniform disc distribution; ^0.75 tightens it toward centre a touch.
  const a = rng() * Math.PI * 2;
  const r = Math.tan(halfAngleRad) * Math.pow(rng(), 0.62);
  out.addScaledVector(_r, Math.cos(a) * r).addScaledVector(_u, Math.sin(a) * r);
  return out.normalize();
}

export function randomPointInDisc(rng, radius, out) {
  const a = rng() * Math.PI * 2;
  const r = radius * Math.sqrt(rng());
  out.x = Math.cos(a) * r;
  out.y = Math.sin(a) * r;
  return out;
}

/** Ray vs axis-aligned box. Returns entry distance or -1. */
export function rayAABB(ox, oy, oz, dx, dy, dz, minx, miny, minz, maxx, maxy, maxz) {
  const inv = 1 / (dx || 1e-9);
  let t1 = (minx - ox) * inv, t2 = (maxx - ox) * inv;
  let tmin = Math.min(t1, t2), tmax = Math.max(t1, t2);
  const invy = 1 / (dy || 1e-9);
  t1 = (miny - oy) * invy; t2 = (maxy - oy) * invy;
  tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
  const invz = 1 / (dz || 1e-9);
  t1 = (minz - oz) * invz; t2 = (maxz - oz) * invz;
  tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
  if (tmax < 0 || tmin > tmax) return -1;
  return tmin < 0 ? 0 : tmin;
}

/** Format seconds as M:SS. */
export function formatTime(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
