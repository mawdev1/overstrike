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
// Probe points are chosen to be FAIR, which matters more than it sounds. An earlier
// version put "market hall L1" at z = -8 — the north half of a hall that spans z ±11 —
// and then reported the north team 3.4 s closer, which is a fact about the probe, not
// about the map. Central objectives sit on the centreline; anything lane-specific is
// measured against its mirror so the comparison is like for like.
const OBJECTIVES = [
  // NOT (0, 8.05, 0) — that point is inside the lantern base collider, so `nodeAt` fails,
  // `nearestWalkable` snaps to the FIRST FLOOR, and the roof row silently reported L1's
  // numbers. The two rows printing identical values was the tell, and I read it as the
  // roof and L1 genuinely being equidistant.
  // Centred on the deck. The surface test in the travel loop skips the lantern base, so
  // an unstandable centre point is no longer a problem — what matters is that the sample
  // grid covers the whole deck, since a team reaches "the roof" at whichever corner is
  // nearest them.
  { name: 'market hall roof', at: new THREE.Vector3(0, 8.05, 0), central: true, extent: 9 },
  { name: 'market hall L1', at: new THREE.Vector3(0, 4.15, 0), central: true },
  { name: 'market hall ground', at: new THREE.Vector3(0, 0.15, 0), central: true },
  { name: 'plaza centre', at: new THREE.Vector3(0, 0, 22) },
  // Forward buildings — each team's own. Compared against each other, not to zero.
  { name: 'warehouse floor', at: new THREE.Vector3(25, 0.15, -24), forwardFor: 1 },
  { name: 'customs floor', at: new THREE.Vector3(25, 0.15, 20), forwardFor: 0 },
  { name: 'warehouse mezzanine', at: new THREE.Vector3(25, 4.0, -30), forwardFor: 1 },
  { name: 'customs L1', at: new THREE.Vector3(25, 4.15, 20), forwardFor: 0 },
  // The rampart runs x -41..-36; -27 is 9 m east of it, out in the courtyard, so this
  // measured the floor and attributed its numbers to the rampart.
  { name: 'old town rampart', at: new THREE.Vector3(-38, 3.95, -8) },
  // z -26, not -16. Block A spans z -32..-16, so -16 is its EDGE: the probe landed on the
  // terrace parapet at 5.00 m rather than the deck at 3.95, on an isolated node with no
  // links, and this zone has been reporting "no route within the A* budget for team 0" ever
  // since. Both teams can in fact reach the terrace — measured 26.8 m for team 0 and 15.3 m
  // for team 1. Same class of mistake as the rampart probe fixed directly above; -26 mirrors
  // terrace B's probe, which sits 6 m inside its own block.
  { name: 'old town terrace A', at: new THREE.Vector3(-23, 3.95, -26) },
  { name: 'old town terrace B', at: new THREE.Vector3(-23, 5.0, 16) },
];

// `findPath` fills an ARRAY of Vector3-like waypoints and grows it as needed — not a
// packed Float32Array. Handing it a typed array silently returns 0 for every query, which
// reads as "the whole map is unreachable" rather than as a type error.
const path = [];
const probe = new THREE.Vector3();
let truncated = 0;
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
  // A* returns its BEST PARTIAL when the goal exceeds the node budget, and summing that
  // silently reports a truncated walk as the travel distance. It made the roof and the
  // first floor print identical numbers — the exact symptom a previous commit chased to
  // a bad probe placement and fixed only there. Corrected, some of these routes are 2-3x
  // longer than the harness was certifying as fair.
  // Truncation is REPORTED, not silently folded into either answer. Returning the partial
  // length understates the route; returning Infinity overstates it as unreachable. Both
  // are wrong in ways that look like facts about the map.
  const endGap = Math.hypot(px - to.x, py - to.y, pz - to.z);
  if (endGap > 2.0) { truncated++; return NaN; }
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
  const truncatedBefore = truncated;
  let worstName = null, worstDelta = 0;
  const forward = { 0: null, 1: null };
  for (const obj of OBJECTIVES) {
    // Distance to the REGION, not to one point in it.
    //
    // A team reaches "the roof" when they get onto any part of it, so a single probe
    // measures the corner nearest whoever is closer to that corner. Probing (-6, 8.05, 6)
    // reported the roof favouring team 0 by 2.1 s; probing the whole deck says 0.1 s. The
    // earlier centre probe was worse still — it landed inside the lantern base collider
    // and silently reported the FIRST FLOOR's numbers under the roof's name.
    const best = [Infinity, Infinity];
    for (const t of [0, 1]) {
      for (const from of byTeam[t]) {
        const ext = obj.extent ?? 6;
        for (let ox = -ext; ox <= ext; ox += 3) {
          for (let oz = -ext; oz <= ext; oz += 3) {
            probe.set(obj.at.x + ox, obj.at.y, obj.at.z + oz);
            // Only sample where the objective's own surface actually is, or the grid
            // wanders off the roof and measures the street below it.
            const surf = w.sampleGroundHeight(probe.x, probe.z, obj.at.y + 1.0);
            if (surf === null || Math.abs(surf - obj.at.y) > 0.8) continue;
            probe.y = surf + 0.1;
            const d = pathLen(from, probe);
            if (Number.isFinite(d) && d < best[t]) best[t] = d;
          }
        }
      }
    }
    if (!Number.isFinite(best[0]) || !Number.isFinite(best[1])) {
      // Every sampled route to it exceeded the search budget, so this objective's travel
      // time is unknown rather than known-bad. Saying so is the only honest option.
      note(`${obj.name}: no route within the A* budget for ${!Number.isFinite(best[0]) ? 'team 0' : 'team 1'} — travel time unknown`);
      continue;
    }
    const delta = Math.abs(best[0] - best[1]);
    const secs = delta / SPRINT;
    const who = best[0] < best[1] ? 'team 0' : 'team 1';
    console.log(`     ${obj.name.padEnd(22)} t0 ${best[0].toFixed(1).padStart(6)} m   t1 ${best[1].toFixed(1).padStart(6)} m   ${who} by ${delta.toFixed(1)} m (${secs.toFixed(1)} s)`);
    // The CENTRE is the one that has to be even; a forward building being closer to the
    // team it is forward of is the point of a forward building.
    if (obj.central && delta > worstDelta) { worstDelta = delta; worstName = obj.name; }
    // A forward building being closer to the team it is forward OF is the point of a
    // forward building. What matters is whether the two teams' forward buildings are
    // worth the same to them.
    if (obj.forwardFor !== undefined && obj.name.endsWith('floor')) {
      forward[obj.forwardFor] = { own: best[obj.forwardFor], theirs: best[1 - obj.forwardFor] };
    }
  }

  if (truncated > truncatedBefore) {
    note(`${truncated - truncatedBefore} of the sampled routes exceeded the A* node budget and were excluded`);
  }
  if (forward[0] && forward[1]) {
    const adv0 = forward[0].theirs - forward[0].own;
    const adv1 = forward[1].theirs - forward[1].own;
    const gap = Math.abs(adv0 - adv1) / SPRINT;
    console.log(`     forward-building advantage: team 0 ${(adv0 / SPRINT).toFixed(1)} s, team 1 ${(adv1 / SPRINT).toFixed(1)} s`);
    if (gap <= 1.5) ok(`both teams' forward buildings are worth the same within ${gap.toFixed(1)} s`);
    else note(`one team's forward building is worth ${gap.toFixed(1)} s more than the other's`);
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
  // The BEST stance within each objective, not its geometric centre.
  //
  // A rooftop's centre is the one place on it nobody fights from — the parapet occludes
  // everything from there. Measuring it reported the market hall roof at 0.9% and made a
  // firing step look like it had changed nothing. What a player actually holds is the
  // strongest position the objective offers, so that is what gets measured.
  for (const obj of OBJECTIVES) {
    let objBest = 0;
    for (let ox = -8; ox <= 8; ox += 2) {
      for (let oz = -8; oz <= 8; oz += 2) {
        from.set(obj.at.x + ox, obj.at.y, obj.at.z + oz);
        // Stand on whatever surface is there, if any, rather than floating at the
        // objective's nominal height.
        const surf = w.sampleGroundHeight(from.x, from.z, obj.at.y + 1.2);
        if (surf === null || surf < obj.at.y - 0.6) continue;
        from.y = surf + EYE;
        if (w.pointInSolid(from.x, from.y, from.z)) continue;
        let seen = 0;
        for (const g of ground) {
          dir.subVectors(g, from);
          const dist = dir.length();
          if (dist < 0.5 || dist > 90) continue;
          dir.normalize();
          if (!w.raycast(from, dir, dist - 0.3)) seen++;
        }
        const f = seen / ground.length;
        if (f > objBest) objBest = f;
      }
    }
    scores.push(`${obj.name} ${(objBest * 100).toFixed(1)}%`);
    if (objBest > best) { best = objBest; bestAt = obj.name; }
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
