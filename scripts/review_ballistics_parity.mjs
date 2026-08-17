/**
 * THROWAWAY REVIEW PROBE — baseline (2e69c49) vs HEAD ballistics parity.
 *
 * Runs the SAME seeded shot / blast sequences through both implementations against an
 * identical fake world + entity set and diffs every numeric gameplay output:
 * damage dealt, hit part, hit point, distance, penetration, kills, and the ORDER +
 * payload of every bus event emitted.
 */
import * as THREE from 'three';
import * as HEAD from '../src/weapons/ballistics.js';
import * as BASE from './review_base_ballistics.js';

// ---------------------------------------------------------------- seeded rng
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- fake world
// A handful of AABBs: a thick pillar, a thin plywood panel (penetrable), a low crate,
// and a big ground slab.
const BOXES = [
  { min: [-60, -1, -60], max: [60, 0, 60], surface: 'concrete' },        // ground
  { min: [4, 0, -1.5], max: [4.18, 3.0, 1.5], surface: 'wood' },         // thin panel (0.18 m)
  { min: [10, 0, -2], max: [11.2, 3.2, 2], surface: 'concrete' },        // thick pillar 1.2 m
  { min: [-3, 0, 2.4], max: [3, 1.05, 3.0], surface: 'metal' },          // low crate
  { min: [-8, 0, -9], max: [8, 4, -8.6], surface: 'concrete' },          // back wall
];

function rayAabb(o, d, box, maxDist) {
  let tmin = -Infinity, tmax = Infinity, axis = 0, sign = -1;
  for (let a = 0; a < 3; a++) {
    const oo = a === 0 ? o.x : a === 1 ? o.y : o.z;
    const dd = a === 0 ? d.x : a === 1 ? d.y : d.z;
    const lo = box.min[a], hi = box.max[a];
    if (Math.abs(dd) < 1e-9) { if (oo < lo || oo > hi) return null; continue; }
    const inv = 1 / dd;
    let t1 = (lo - oo) * inv, t2 = (hi - oo) * inv, sg = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
    if (t1 > tmin) { tmin = t1; axis = a; sign = sg; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  const t = tmin < 0 ? 0 : tmin;
  if (t > maxDist) return null;
  return { t, axis, sign };
}

const _wp = new THREE.Vector3();
const _wn = new THREE.Vector3();
const _wres = { point: _wp, normal: _wn, distance: 0, surface: 'concrete' };

const world = {
  raycast(origin, dir, maxDist) {
    let best = Infinity, bestBox = null, bestAxis = 0, bestSign = -1;
    for (const b of BOXES) {
      const h = rayAabb(origin, dir, b, maxDist);
      if (!h || h.t >= best) continue;
      best = h.t; bestBox = b; bestAxis = h.axis; bestSign = h.sign;
    }
    if (!bestBox) return null;
    _wp.set(origin.x + dir.x * best, origin.y + dir.y * best, origin.z + dir.z * best);
    _wn.set(0, 0, 0);
    if (bestAxis === 0) _wn.x = bestSign; else if (bestAxis === 1) _wn.y = bestSign; else _wn.z = bestSign;
    _wres.distance = best;
    _wres.surface = bestBox.surface;
    return _wres;
  },
  losClear(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return true;
    const d = new THREE.Vector3(dx / len, dy / len, dz / len);
    for (const box of BOXES) {
      const h = rayAabb(a, d, box, len - 1e-4);
      if (h && h.t > 1e-4) return false;
    }
    return true;
  },
};

// ---------------------------------------------------------------- entities
function makeEntity(id, isPlayer, team, x, z, yaw, height = 1.8) {
  return {
    id, isPlayer, team, alive: true, name: 'E' + id,
    position: new THREE.Vector3(x, 0, z),
    velocity: new THREE.Vector3(),
    yaw, pitch: 0, height, radius: 0.36, eyeHeight: height * 0.9,
    health: 100, maxHealth: 100, armor: 0,
    hitboxes: [
      { part: 'head', offset: new THREE.Vector3(0, height * 0.91, 0), size: new THREE.Vector3(0.30, 0.30, 0.30) },
      { part: 'torso', offset: new THREE.Vector3(0, height * 0.60, 0), size: new THREE.Vector3(0.52, 0.72, 0.36) },
      { part: 'limb', offset: new THREE.Vector3(0, height * 0.22, 0), size: new THREE.Vector3(0.46, 0.66, 0.34) },
      { part: 'limb', offset: new THREE.Vector3(0, height * 0.60, 0), size: new THREE.Vector3(0.92, 0.60, 0.30) },
    ],
    weapon: null,
    stats: { kills: 0, deaths: 0, score: 0, streak: 0 },
    getEyePosition(out) { return out.set(this.position.x, this.position.y + this.eyeHeight, this.position.z); },
    getAimDirection(out) { return out.set(0, 0, -1); },
    applyDamage(amount, info) {
      this._log.push(['applyDamage', this.id, r6(amount), info.hitPart, !!info.headshot]);
      this.health -= amount;
      if (this.health <= 0) { this.health = 0; this.alive = false; }
    },
    die() { this.alive = false; },
    _log: null,
  };
}

const r6 = (n) => (typeof n === 'number' ? Number(n.toFixed(6)) : n);
const v6 = (v) => [r6(v.x), r6(v.y), r6(v.z)];

// ---------------------------------------------------------------- fake game
function makeGame(log) {
  const bus = {
    emit(name, p) {
      // Snapshot the POOLED payload immediately (contract: read synchronously).
      const rec = { ev: name };
      if (p.point) rec.point = v6(p.point);
      if (p.normal) rec.normal = v6(p.normal);
      if (p.dir) rec.dir = v6(p.dir);
      if (p.origin) rec.origin = v6(p.origin);
      if (p.amount !== undefined) rec.amount = r6(p.amount);
      if (p.hitPart !== undefined) rec.hitPart = p.hitPart;
      if (p.headshot !== undefined) rec.headshot = !!p.headshot;
      if (p.surface !== undefined) rec.surface = p.surface;
      if (p.weaponId !== undefined) rec.weaponId = p.weaponId;
      if (p.radius !== undefined) rec.radius = r6(p.radius);
      if (p.damage !== undefined) rec.damage = r6(p.damage);
      rec.target = p.target ? p.target.id : null;
      rec.shooter = p.shooter ? p.shooter.id : (p.attacker ? p.attacker.id : null);
      log.push(rec);
    },
    on() { return () => {}; },
  };
  return {
    bus,
    world,
    entities: [],
    player: null,
    match: null,
    // fx / audio recorded so we can also see feedback-call divergence
    fx: {
      impact: (p, n, s) => log.push({ fx: 'impact', point: v6(p), surface: s }),
      decal: (p, n, s, size) => log.push({ fx: 'decal', point: v6(p), surface: s, size: r6(size) }),
      bloodSpray: (p, n, a) => log.push({ fx: 'bloodSpray', point: v6(p), amount: r6(a) }),
      tracer: (a, b) => log.push({ fx: 'tracer', from: v6(a), to: v6(b) }),
    },
    audio: { play: (name) => log.push({ audio: name }) },
  };
}

// ---------------------------------------------------------------- scenarios

function runHitscanSuite(mod, tag) {
  const log = [];
  const game = makeGame(log);
  const rng = mulberry32(0xC0FFEE);
  const results = [];

  const shooter = makeEntity(1, true, 0, 0, 0, 0);
  shooter._log = log;

  const WEAPONS = [
    { id: 'ar_vector', damage: 27, range: 120, falloffStart: 30, falloffEnd: 74, falloffMin: 0.62, penetration: 0.42, headshotMul: 4.2 },
    { id: 'sn_reaver', damage: 112, range: 300, falloffStart: 120, falloffEnd: 250, falloffMin: 0.85, penetration: 0.8, headshotMul: 4.2 },
    { id: 'sg_breach', damage: 16, range: 40, falloffStart: 8, falloffEnd: 22, falloffMin: 0.3, penetration: 0, headshotMul: 2.0 },
    { id: 'lmg_atlas', damage: 31, range: 140, falloffStart: 34, falloffEnd: 90, falloffMin: 0.55, penetration: 0.55 },
  ];

  for (let shot = 0; shot < 4000; shot++) {
    // Rebuild the entity set deterministically for every shot.
    const n = 2 + Math.floor(rng() * 4);
    const ents = [shooter];
    for (let i = 0; i < n; i++) {
      const e = makeEntity(10 + i, false, rng() < 0.5 ? 0 : 1,
        (rng() - 0.5) * 40, (rng() - 0.5) * 40, rng() * Math.PI * 2,
        rng() < 0.3 ? 1.1 : 1.8);
      e._log = log;
      e.health = 40 + rng() * 160;
      e.alive = rng() > 0.05;
      ents.push(e);
    }
    game.entities = ents;
    game.player = shooter;
    // Friendly fire OFF half the time so damageScale's gate is exercised both ways.
    game.match = rng() < 0.5 ? null : { mode: { teamBased: false } };
    shooter.team = 0;

    const w = WEAPONS[Math.floor(rng() * WEAPONS.length)];
    const origin = new THREE.Vector3((rng() - 0.5) * 6, 1.2 + rng() * 0.8, (rng() - 0.5) * 6);
    // Aim at a random entity's random body height most of the time, else a random dir.
    const dir = new THREE.Vector3();
    if (rng() < 0.75) {
      const t = ents[1 + Math.floor(rng() * (ents.length - 1))];
      dir.set(t.position.x - origin.x,
        t.position.y + t.height * (0.15 + rng() * 0.85) - origin.y,
        t.position.z - origin.z).normalize();
      // jitter by up to ~3 degrees so we straddle hitbox edges
      dir.x += (rng() - 0.5) * 0.05; dir.y += (rng() - 0.5) * 0.05; dir.z += (rng() - 0.5) * 0.05;
      dir.normalize();
    } else {
      const yaw = rng() * Math.PI * 2, pitch = (rng() - 0.5) * 1.0;
      dir.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    }

    log.push({ mark: 'shot', i: shot, w: w.id });
    const res = mod.fireHitscan(game, {
      shooter, weaponId: w.id, origin, dir,
      damage: w.damage, range: w.range,
      falloffStart: w.falloffStart, falloffEnd: w.falloffEnd, falloffMin: w.falloffMin,
      penetration: w.penetration, headshotMul: w.headshotMul,
      tracer: rng() < 0.34,
      decalSize: w.id === 'sg_breach' ? 0.09 : 0.16,
      emitShot: true,
    });
    results.push({
      i: shot, w: w.id,
      hit: res.hitEntity ? res.hitEntity.id : null,
      point: v6(res.point), dist: r6(res.distance), head: !!res.headshot,
      part: res.part, surface: res.surface, pen: !!res.penetrated,
      dmg: r6(res.damageDealt), killed: !!res.killed,
    });
  }
  return { tag, results, log };
}

function runExplosionSuite(mod, tag) {
  const log = [];
  const game = makeGame(log);
  const rng = mulberry32(0xBEEF01);
  const results = [];

  for (let blast = 0; blast < 3000; blast++) {
    const n = 3 + Math.floor(rng() * 5);
    const ents = [];
    for (let i = 0; i < n; i++) {
      const e = makeEntity(10 + i, i === 0, i % 2, (rng() - 0.5) * 24, (rng() - 0.5) * 24,
        rng() * Math.PI * 2, rng() < 0.35 ? 1.1 : 1.8);
      e._log = log;
      e.health = 1e9;             // never dies, so every blast reports full damage
      ents.push(e);
    }
    game.entities = ents;
    game.player = ents[0];
    game.match = null;
    const attacker = rng() < 0.5 ? ents[0] : null;

    const point = new THREE.Vector3((rng() - 0.5) * 24, 0.1 + rng() * 2.2, (rng() - 0.5) * 24);
    const radius = [6.5, 5.0, 12.0, 3.0][Math.floor(rng() * 4)];
    const damage = [130, 90, 6, 200][Math.floor(rng() * 4)];

    log.push({ mark: 'blast', i: blast });
    const count = mod.applyExplosionDamage(game, {
      point, radius, damage, attacker, weaponId: 'frag', falloff: 1.35, selfMul: 0.75,
    });
    results.push({
      i: blast, count, radius, damage,
      per: ents.map((e) => r6(1e9 - e.health)),
    });
  }
  return { tag, results, log };
}

// ---------------------------------------------------------------- diff
function diff(name, a, b, limit = 12) {
  const sa = JSON.stringify(a.results);
  const sb = JSON.stringify(b.results);
  if (sa === sb) {
    console.log(`  PARITY OK  ${name}: ${a.results.length} cases identical`);
    return 0;
  }
  let n = 0;
  for (let i = 0; i < Math.max(a.results.length, b.results.length); i++) {
    const x = JSON.stringify(a.results[i]);
    const y = JSON.stringify(b.results[i]);
    if (x === y) continue;
    n++;
    if (n <= limit) {
      console.log(`  DIFF #${i}`);
      console.log(`    base: ${x}`);
      console.log(`    head: ${y}`);
    }
  }
  console.log(`  !! ${name}: ${n} / ${a.results.length} cases DIVERGE`);
  return n;
}

function diffLog(name, a, b, limit = 14) {
  const A = a.log, B = b.log;
  const sa = JSON.stringify(A), sb = JSON.stringify(B);
  if (sa === sb) { console.log(`  EVENT/FX LOG OK  ${name}: ${A.length} entries identical`); return 0; }
  console.log(`  !! ${name}: event/fx log diverges (base ${A.length} entries, head ${B.length})`);
  let shown = 0;
  const m = Math.max(A.length, B.length);
  for (let i = 0, j = 0; (i < A.length || j < B.length) && shown < limit;) {
    const x = JSON.stringify(A[i]), y = JSON.stringify(B[j]);
    if (x === y) { i++; j++; continue; }
    console.log(`    base[${i}]: ${x}`);
    console.log(`    head[${j}]: ${y}`);
    shown++;
    // resync heuristic: skip whichever side has an extra entry
    if (JSON.stringify(A[i + 1]) === y) { i += 2; j += 1; }
    else if (JSON.stringify(B[j + 1]) === x) { i += 1; j += 2; }
    else { i++; j++; }
  }
  // Summarise by kind so the shape of the divergence is legible.
  const kind = (r) => r.ev || (r.fx ? 'fx.' + r.fx : (r.audio ? 'audio.' + r.audio : (r.mark ? 'mark' : (r[0] || '?'))));
  const tally = (L) => { const t = {}; for (const r of L) { const k = Array.isArray(r) ? r[0] : kind(r); t[k] = (t[k] || 0) + 1; } return t; };
  console.log('    base tally:', JSON.stringify(tally(A)));
  console.log('    head tally:', JSON.stringify(tally(B)));
  return 1;
}

// ---------------------------------------------------------------- run
console.log('=== BALLISTICS PARITY: 2e69c49 (base) vs HEAD ===\n');

console.log('[1] fireHitscan — 4000 seeded shots');
const hb = runHitscanSuite(BASE, 'base');
const hh = runHitscanSuite(HEAD, 'head');
const hd = diff('fireHitscan results', hb, hh);
diffLog('fireHitscan', hb, hh);

// Is the ONLY event/fx divergence the removed fx.decal calls? Filter them out of the
// baseline log and re-compare byte for byte.
{
  const bf = hb.log.filter((r) => r.fx !== 'decal');
  const hf = hh.log.filter((r) => r.fx !== 'decal');
  const same = JSON.stringify(bf) === JSON.stringify(hf);
  console.log(`  minus fx.decal: base=${bf.length} head=${hf.length} -> ${same
    ? 'IDENTICAL (event order + payloads intact; fx.decal removal is the ONLY delta)'
    : '*** STILL DIVERGES ***'}`);
  if (!same) {
    for (let i = 0; i < Math.max(bf.length, hf.length); i++) {
      if (JSON.stringify(bf[i]) === JSON.stringify(hf[i])) continue;
      console.log(`    first delta @${i}\n      base: ${JSON.stringify(bf[i])}\n      head: ${JSON.stringify(hf[i])}`);
      break;
    }
  }
}

console.log('\n[2] applyExplosionDamage — 3000 seeded blasts');
const eb = runExplosionSuite(BASE, 'base');
const eh = runExplosionSuite(HEAD, 'head');
const ed = diff('applyExplosionDamage results', eb, eh);

// Quantify explosion divergence magnitude.
if (ed) {
  let worstAbs = 0, worstCase = null, totalBase = 0, totalHead = 0;
  let moreCases = 0, lessCases = 0, zeroedCases = 0, newDamageCases = 0;
  for (let i = 0; i < eb.results.length; i++) {
    const B = eb.results[i].per, H = eh.results[i].per;
    for (let k = 0; k < B.length; k++) {
      totalBase += B[k]; totalHead += H[k];
      const d = H[k] - B[k];
      if (Math.abs(d) > worstAbs) {
        worstAbs = Math.abs(d);
        worstCase = { blast: i, ent: k, base: B[k], head: H[k], radius: eb.results[i].radius, dmg: eb.results[i].damage };
      }
      if (d > 1e-9) moreCases++;
      if (d < -1e-9) lessCases++;
      if (B[k] > 0 && H[k] === 0) zeroedCases++;
      if (B[k] === 0 && H[k] > 0) newDamageCases++;
    }
  }
  console.log(`\n  explosion damage totals: base=${totalBase.toFixed(1)} head=${totalHead.toFixed(1)} (${((totalHead / totalBase - 1) * 100).toFixed(2)}%)`);
  console.log(`  entities taking MORE damage than baseline: ${moreCases}`);
  console.log(`  entities taking LESS damage than baseline: ${lessCases}`);
  console.log(`  entities that used to be damaged and now take ZERO: ${zeroedCases}`);
  console.log(`  entities that took zero and NOW TAKE DAMAGE: ${newDamageCases}`);
  console.log(`  worst single-entity swing: ${worstAbs.toFixed(2)} HP  ${JSON.stringify(worstCase)}`);
}

console.log(`\n=== SUMMARY: hitscan diffs=${hd}, explosion diffs=${ed} ===`);
process.exit(0);
