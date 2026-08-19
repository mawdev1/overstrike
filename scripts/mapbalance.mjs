/**
 * Map balance, measured.
 *
 * Layout quality is where FPS design usually stops being falsifiable and starts being
 * taste. It does not have to. Most of what makes a competitive map fair or unfair is
 * measurable against the real collision and navigation data:
 *
 *   - can one team reach the contested ground before the other, every round?
 *   - is there a position that sees most of the map?
 *   - can a spawn be shot from another spawn?
 *   - is there cover where a player needs it?
 *   - are the sightlines short enough that a rifle cannot hold the whole map?
 *
 * This reports those as numbers so a change can be judged rather than argued about. It is
 * a REPORT, not a gate — it exits 0 unless something is outright broken (a spawn pair with
 * line of sight, or an unreachable objective), because the rest are trade-offs a designer
 * makes deliberately.
 *
 *   node scripts/mapbalance.mjs
 */
import * as THREE from 'three';
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const note = (n) => console.log(`  --   ${n}`);

const game = new Game({ headless: true });
await game.initHeadless({ presenter: new NullPresenter() });
const w = game.world;
const nav = game.nav;
const EYE = 1.62;

console.log(`\nmap balance (${w.boxes.length} colliders, ${w.spawnPoints.length} spawns)`);

// Key positions a match is fought over. Named so a regression reads as "team 1 lost their
// route to the warehouse" rather than as a number moving.
const OBJECTIVES = [
  { name: 'market hall roof', at: new THREE.Vector3(0, 8.05, 0) },
  { name: 'market hall L1', at: new THREE.Vector3(0, 4.15, -8) },
  { name: 'warehouse mezzanine', at: new THREE.Vector3(25, 4.0, -30) },
  { name: 'warehouse floor', at: new THREE.Vector3(25, 0.15, -24) },
  { name: 'customs L1', at: new THREE.Vector3(25, 4.15, 20) },
  { name: 'old town rampart', at: new THREE.Vector3(-27, 3.95, -8) },
  { name: 'plaza centre', at: new THREE.Vector3(0, 0, 22) },
];

// `findPath` fills an ARRAY of Vector3-like waypoints and grows it as needed — not a
// packed Float32Array. Handing it a typed array silently returns 0 for every query, which
// reads as "the whole map is unreachable" rather than as a type error.
const path = [];
/** Geodesic path length over the nav mesh, or Infinity if unreachable. */
function pathLen(from, to) {
  const n = nav.findPath(from, to, path);
  if (!n) return Infinity;
  let d = 0;
  let px = from.x, py = from.y, pz = from.z;
  for (let i = 0; i < n; i++) {
    const p = path[i];
    d += Math.hypot(p.x - px, p.y - py, p.z - pz);
    px = p.x; py = p.y; pz = p.z;
  }
  return d;
}

// ── spawn safety ─────────────────────────────────────────────────────────────────────
{
  const spawns = w.spawnPoints;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), d = new THREE.Vector3();
  let crossTeamLos = 0;
  const offenders = [];
  for (let i = 0; i < spawns.length; i++) {
    for (let j = i + 1; j < spawns.length; j++) {
      const ta = spawns[i].team ?? -1, tb = spawns[j].team ?? -1;
      if (ta < 0 || tb < 0 || ta === tb) continue;         // only opposing pairs matter
      a.copy(spawns[i].position); a.y += EYE;
      b.copy(spawns[j].position); b.y += EYE;
      d.subVectors(b, a);
      const dist = d.length();
      d.normalize();
      const hit = w.raycast(a, d, dist);
      if (!hit) { crossTeamLos++; offenders.push(`#${i}(t${ta}) <-> #${j}(t${tb}) at ${dist.toFixed(1)} m`); }
    }
  }
  if (crossTeamLos === 0) ok('no opposing spawn pair can see each other');
  else bad('opposing spawns cannot see each other', `${crossTeamLos}:\n       ${offenders.slice(0, 5).join('\n       ')}`);
}

// ── who gets there first ─────────────────────────────────────────────────────────────
//
// The one that decides whether a map is fair. If a team reaches the contested centre
// earlier every single round, no amount of good geometry compensates.
{
  const spawns = w.spawnPoints;
  const byTeam = [[], []];
  for (const sp of spawns) {
    const t = sp.team ?? -1;
    if (t === 0 || t === 1) byTeam[t].push(sp.position);
  }
  const SPRINT = 7.2;                                   // m/s, from TUNE
  console.log('\n  travel from each team\'s nearest spawn:');
  let worstName = null, worstDelta = 0;
  for (const obj of OBJECTIVES) {
    const best = [Infinity, Infinity];
    for (const t of [0, 1]) {
      for (const from of byTeam[t]) {
        const d = pathLen(from, obj.at);
        if (d < best[t]) best[t] = d;
      }
    }
    if (!Number.isFinite(best[0]) && !Number.isFinite(best[1])) {
      bad(`${obj.name} is reachable`, 'neither team can path to it');
      continue;
    }
    const delta = Math.abs(best[0] - best[1]);
    const secs = delta / SPRINT;
    const who = best[0] < best[1] ? 'team 0' : 'team 1';
    console.log(`     ${obj.name.padEnd(22)} t0 ${best[0].toFixed(1).padStart(6)} m   t1 ${best[1].toFixed(1).padStart(6)} m   ${who} by ${delta.toFixed(1)} m (${secs.toFixed(1)} s)`);
    // The CENTRE is the one that has to be even; a forward building being closer to the
    // team it is forward of is the point of a forward building.
    if (obj.name.startsWith('market hall') && delta > worstDelta) { worstDelta = delta; worstName = obj.name; }
  }
  const centreSecs = worstDelta / SPRINT;
  if (centreSecs <= 0.45) ok(`the contested centre is even within ${centreSecs.toFixed(2)} s`);
  else note(`the contested centre favours one team by ${centreSecs.toFixed(2)} s (${worstName}) — target is under 0.45 s`);
}

// ── sightlines ───────────────────────────────────────────────────────────────────────
{
  const o = new THREE.Vector3(), d = new THREE.Vector3();
  const lens = [];
  for (let x = -38; x <= 38; x += 2) {
    for (let z = -38; z <= 38; z += 2) {
      if (w.pointInSolid(x, EYE, z)) continue;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        o.set(x, EYE, z);
        d.set(Math.cos(a), 0, Math.sin(a));
        const hit = w.raycast(o, d, 90);
        lens.push(hit ? hit.distance : 90);
      }
    }
  }
  lens.sort((p, q) => p - q);
  const pct = (f) => lens[Math.floor(lens.length * f)];
  const over55 = lens.filter((v) => v > 55).length / lens.length * 100;
  console.log(`\n  sightlines (${lens.length} rays): median ${pct(0.5).toFixed(1)} m, p90 ${pct(0.9).toFixed(1)}, p99 ${pct(0.99).toFixed(1)}, max ${lens[lens.length - 1].toFixed(1)}`);
  if (over55 < 1) ok(`${(100 - over55).toFixed(2)}% of sightlines are under 55 m`);
  else note(`${over55.toFixed(2)}% of sightlines exceed 55 m — a rifle can hold those lanes`);
}

// ── is anywhere too strong ───────────────────────────────────────────────────────────
//
// A position that sees a third of the map is a strong hold; one that sees half is a
// problem no counter-play fixes.
{
  const ground = [];
  for (let x = -38; x <= 38; x += 3) {
    for (let z = -38; z <= 38; z += 3) {
      const h = w.sampleGroundHeight(x, z, 6);
      if (h === null || h > 5) continue;
      if (w.pointInSolid(x, h + EYE, z)) continue;
      ground.push(new THREE.Vector3(x, h + EYE, z));
    }
  }
  const from = new THREE.Vector3(), dir = new THREE.Vector3();
  let best = 0, bestAt = null;
  const scores = [];
  for (const obj of OBJECTIVES) {
    from.copy(obj.at); from.y += EYE;
    if (w.pointInSolid(from.x, from.y, from.z)) continue;
    let seen = 0;
    for (const g of ground) {
      dir.subVectors(g, from);
      const dist = dir.length();
      if (dist < 0.5 || dist > 90) continue;
      dir.normalize();
      if (!w.raycast(from, dir, dist - 0.3)) seen++;
    }
    const frac = seen / ground.length;
    scores.push(`${obj.name} ${(frac * 100).toFixed(1)}%`);
    if (frac > best) { best = frac; bestAt = obj.name; }
  }
  console.log(`\n  ground visible from each objective (${ground.length} sample points):`);
  console.log(`     ${scores.join(' · ')}`);
  if (best < 0.40) ok(`the strongest objective sees ${(best * 100).toFixed(1)}% of the ground (${bestAt})`);
  else note(`${bestAt} sees ${(best * 100).toFixed(1)}% of the ground — verging on dominant`);
}

// ── cover ────────────────────────────────────────────────────────────────────────────
{
  const dists = [];
  for (let x = -38; x <= 38; x += 2) {
    for (let z = -38; z <= 38; z += 2) {
      if (w.pointInSolid(x, EYE, z)) continue;
      let near = Infinity;
      for (const b of w.boxes) {
        if (b.max.y < 0.8 || b.min.y > 1.8) continue;      // waist-to-chest cover only
        const dx = Math.max(b.min.x - x, 0, x - b.max.x);
        const dz = Math.max(b.min.z - z, 0, z - b.max.z);
        const d = Math.hypot(dx, dz);
        if (d < near) near = d;
      }
      if (Number.isFinite(near)) dists.push(near);
    }
  }
  dists.sort((p, q) => p - q);
  const pct = (f) => dists[Math.floor(dists.length * f)];
  console.log(`\n  distance to nearest cover: median ${pct(0.5).toFixed(2)} m, p90 ${pct(0.9).toFixed(2)}, max ${dists[dists.length - 1].toFixed(2)}`);
  if (dists[dists.length - 1] < 9) ok('nowhere is more than 9 m from cover');
  else note(`the most exposed point is ${dists[dists.length - 1].toFixed(1)} m from cover`);
}

console.log(failures ? `\n${failures} FAILED` : '\nbalance report complete');
process.exit(failures ? 1 : 0);
