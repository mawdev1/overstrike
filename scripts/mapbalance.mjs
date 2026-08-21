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
 * ── P3.A2: the spawn system's quality is measured here too ───────────────────────────
 *
 * Everything above is geometry. The section at the bottom of this file plays real
 * headless bot matches and reports three numbers about SPAWNING, each with a threshold
 * that fails the run:
 *
 *   immediate repeat-death rate · spawn-flip-into-enemy rate · first-death dispersion
 *
 *   node scripts/mapbalance.mjs                 full report, spawn thresholds enforced
 *   node scripts/mapbalance.mjs --spawn-only    skip the geometry sections
 *   node scripts/mapbalance.mjs --baseline      zero the P3.A2 scoring terms, for a
 *                                               before/after delta (see BASELINE below)
 *   node scripts/mapbalance.mjs --degrade=los|death|hostile|stick
 *                                               deliberately break one part of the real
 *                                               scorer, to prove a threshold can fail
 */
import * as THREE from 'three';
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';
import { SPAWN_WEIGHTS, SPAWN_POLICY } from '../src/game/spawner.js';
import { MODES } from '../src/game/modes.js';

const ARGV = process.argv.slice(2);
const flag = (k) => ARGV.includes(`--${k}`);
const opt = (k, d = null) => {
  const hit = ARGV.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const SPAWN_ONLY = flag('spawn-only');
const BASELINE = flag('baseline');
const DEGRADE = opt('degrade', '');

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
if (!SPAWN_ONLY) {
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
if (!SPAWN_ONLY) {
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
if (!SPAWN_ONLY) {
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
if (!SPAWN_ONLY) {
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
if (!SPAWN_ONLY) {
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

// ═════════════════════════════════════════════════════════════════════════════════════
// P3.A2 — SPAWN QUALITY, MEASURED
// ═════════════════════════════════════════════════════════════════════════════════════
//
// A spawn system without numbers is an opinion. These are the numbers, and unlike the
// geometry sections above they are GATES: breaching one fails the run.
//
// Everything below is measured from real headless bot matches — the real Spawner, the
// real World, the real bots, the real 1/120 s step. Nothing here scores a spawn using the
// spawner's own opinion of it; visibility is re-derived from `world.losClear` and the
// enemy's actual yaw, so a scorer that has stopped working cannot mark its own homework.

/** Simulation constants the metric definitions depend on. Stated once, used everywhere. */
const TICK = 1 / 120;
// Sixteen seeds rather than one: a single match is one draw from a very noisy process,
// and a threshold judged on one draw is a coin toss dressed as a gate.
//
// The count is set by the RAREST event measured here, not by taste. 16 × 400 s of 6v6 is
// ~1600 deaths, of which the shipped scorer produces two immediate repeat deaths. At eight
// seeds it produced one, and a gate standing on a single event is a gate standing on
// nothing — one unlucky seed doubles the rate. Two expected events against a threshold of
// six is a margin a Poisson tail respects. It costs ~30 s of wall clock.
const TRIAL_SEEDS = [1337, 90210, 4242, 55555, 8675309, 31415, 271828, 161803,
  112358, 24601, 7777, 606060, 998877, 13, 424242, 909090];
const TRIAL_SECONDS = 400;
const TRIAL_BOTS = 11;              // 12-entity roster: the player plus 11 bots, 6 v 6

// ── metric definitions ───────────────────────────────────────────────────────────────
//
// IMMEDIATE REPEAT-DEATH. A death counts when BOTH hold:
//   - it happened within REPEAT_T seconds of that entity being placed, and
//   - the entity was still within REPEAT_D metres of the point it was placed on.
//
// Both, not either. Time alone convicts a player who sprinted 40 m into the enemy half
// and lost the fight he went looking for — his decision, not the spawner's. Distance
// alone convicts a camper who held his own spawn for two minutes and eventually lost it.
// The pairing isolates the one case the spawner is responsible for: you were put down,
// and you died there, before you had a chance to leave.
//
// REPEAT_T = 5 s is the spawn-protection window (1.2 s) plus the time to cross one
// engagement — long enough that "shot the moment I loaded in" is inside it, short enough
// that a deliberate push is not.
// REPEAT_D = 15 m is two sprint-seconds at TUNE's 7.2 m/s; past it you left the pocket.
const REPEAT_T = 5.0;
const REPEAT_D = 15.0;
// This is a CEILING, not the sharp gate. It is a statement about the player's experience —
// three deaths in a hundred being spawn deaths is where a lobby starts saying the map's
// spawns are broken — and it is deliberately loose, because the absolute rate is a
// property of the geometry as much as of the scorer (measured 0.06% → 0.91% across three
// states of the graybox with no code change at all). The gate that actually discriminates
// is the control-arm ratio further down.
const REPEAT_MAX = 0.03;

// SPAWN-FLIP-INTO-ENEMY. Sampled at the instant of placement, against living enemies:
//   - within FLIP_RANGE metres,                 (they can hurt you)
//   - clear eye-to-eye line via world.losClear, (they can see you)
//   - and the spawn point inside ±FLIP_HALF_ANGLE of their facing. (they are looking)
//
// All three, because that is what "flipped into an enemy" means to the player who
// experiences it. FLIP_RANGE = 30 m is where an AR still trades reliably on this map
// (median sightline is ~11 m; p90 ~34 m). FLIP_HALF_ANGLE = 50° is a little wider than
// the 90° default horizontal FOV, so "just off screen, one flick away" still counts.
const FLIP_RANGE = 30;
const FLIP_HALF_ANGLE = 50;
const FLIP_COS = Math.cos((FLIP_HALF_ANGLE * Math.PI) / 180);
// Also a ceiling: 1% is about one flipped spawn per 400 s match at this roster size, and
// across every run of this harness the shipped scorer has produced between 0 and 1 in two
// thousand placements. The control-arm ratio below is the discriminating gate.
const FLIP_MAX = 0.01;

// FIRST-DEATH LOCATION DISTRIBUTION. Where each life ended, restricted to lives that
// ended within FIRST_DEATH_T seconds of being placed — the deaths the spawn system had a
// hand in. Binned into CELL-metre cells on the XZ plane.
//
// FIRST_DEATH_T = 15 s: long enough to include the fight a placement led you into,
// short enough to exclude the third engagement of a long life, which is about the map
// and not about where you were put.
//
// Two failed definitions are worth recording, because both looked reasonable:
//   - No time limit at all. That histogram is a map of where fights happen; it barely
//     moved when the scorer was reduced to returning the same point every time.
//   - Time AND a "did not get more than 20 m from the spawn" filter, which is far more
//     obviously about spawning — but on this map only ~2% of deaths qualify (14 out of
//     787 in one protocol run). A dispersion statistic over 14 samples is not a statistic.
//
// Dispersion is reported as two numbers, because either alone is gameable:
//   effectiveCells = 1 / Σpᵢ²  (inverse Simpson / Hill number of order 2) — the effective
//       number of distinct places people die. A long tail of one-off cells cannot inflate
//       it the way a raw cell count or plain entropy can.
//   topCellShare = max pᵢ — the single busiest cell's share, which catches one hot spot
//       hiding inside an otherwise healthy spread.
//
// Both thresholds are CALIBRATED against measured endpoints on this map rather than
// picked, and both endpoints are recorded here so the margin is visible:
//
//                              effectiveCells   topCellShare
//   shipped scorer                 12.40–15.15    13.27–18.23%
//   pre-P3.A2 scorer                    11.52          16.67%   (--baseline)
//   visibility terms inverted           10.32          18.39%   (--degrade=los)
//   every varying term zeroed       8.08–9.30    20.00–25.00%   (--degrade=stick)
//   threshold                           ≥ 10          ≤ 25%
//
// `effectiveCells` is the sharper of the two, and both have fired for real: 8.08 under
// --degrade=stick, and 20.47% / 18.23% top-cell on two states of the graybox.
//
// One caveat, stated rather than buried. On the graybox as of this writing the dispersion
// statistics no longer separate the shipped scorer from a stripped one (18.32 vs 19.77
// effective cells). Where people die 15 seconds after spawning is dominated by where the
// LEVEL sends them, and the map moved. So treat these two as a guard on the map/spawn
// combination — which is what they are good at, and which is why they live in a map
// balance report — and treat the control-arm ratios above as the gate on the scorer.
//
// Inverse Simpson grows with sample size, so these numbers are only comparable under the
// fixed protocol above (TRIAL_SEEDS × TRIAL_SECONDS). Change the protocol or change the
// map materially and both thresholds must be re-measured — the same rule the geometry
// budgets in this file already live under.
const FIRST_DEATH_T = 15.0;
const CELL = 8;
const MIN_EFFECTIVE_CELLS = 10;
const MAX_TOP_CELL_SHARE = 0.25;

/**
 * One headless bot match, fully instrumented.
 *
 * Returns the raw event log; every metric is computed from it afterwards so that the
 * same run answers all three questions and the numbers cannot come from three different
 * matches that happened to disagree.
 */
async function runTrial({ seed, seconds = TRIAL_SECONDS, bots = TRIAL_BOTS, mutate = null }) {
  const g = new Game({ headless: true });
  await g.initHeadless({ presenter: new NullPresenter() });
  g.startMatch({ mode: 'tdm', botCount: bots, difficulty: 'regular', killLimit: 5000, seed });
  g.match.phase = 'live';
  g.match.countdown = 0;
  if (typeof mutate === 'function') mutate(g);

  const world = g.world;
  const spawner = g.match.spawner;
  const spawns = [];
  const deaths = [];
  /** entity id -> index into `spawns` of its current life. */
  const life = new Map();

  const eyeA = new THREE.Vector3();
  const eyeB = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const toPoint = new THREE.Vector3();

  /**
   * Who could shoot this placement, right now — recomputed from the world, never asked
   * of the spawner. `losClear` and the enemy's own `yaw` are the same data a bullet uses.
   */
  const witnesses = (entity) => {
    let n = 0;
    eyeA.set(entity.position.x, entity.position.y + EYE, entity.position.z);
    for (const e of g.entities) {
      if (e === entity || !e.alive) continue;
      if (!g.match.areEnemies(entity, e)) continue;
      const d = e.position.distanceTo(entity.position);
      if (d > FLIP_RANGE) continue;
      eyeB.set(e.position.x, e.position.y + EYE, e.position.z);
      if (!world.losClear(eyeA, eyeB)) continue;
      fwd.set(-Math.sin(e.yaw ?? 0), 0, -Math.cos(e.yaw ?? 0));
      toPoint.set(entity.position.x - e.position.x, 0, entity.position.z - e.position.z);
      if (toPoint.lengthSq() < 1e-4) { n++; continue; }
      toPoint.normalize();
      if (fwd.dot(toPoint) >= FLIP_COS) n++;
    }
    return n;
  };

  const realSpawn = spawner.spawnEntity.bind(spawner);
  let scoreCalls = 0;
  const realScore = spawner.scorePoint.bind(spawner);
  spawner.scorePoint = (p, e) => { scoreCalls++; return realScore(p, e); };
  spawner.spawnEntity = (entity) => {
    const r = realSpawn(entity);
    if (!entity) return r;
    const rec = {
      id: entity.id,
      team: entity.team,
      t: g.match.elapsed,
      x: entity.position.x, y: entity.position.y, z: entity.position.z,
      pointId: spawner.lastPick.id,
      groupId: spawner.lastPick.groupId,
      policy: spawner.lastPick.policy,
      witnesses: witnesses(entity),
      dead: false,
    };
    life.set(entity.id, spawns.length);
    spawns.push(rec);
    return r;
  };

  g.bus.on('kill', (p) => {
    const v = p?.victim;
    if (!v) return;
    const li = life.get(v.id);
    // A death with no recorded placement cannot be attributed to a spawn. There are none
    // in practice (match.begin places the whole roster) but counting one would silently
    // shrink the denominator, which flatters every rate below it.
    if (li === undefined) return;
    const s = spawns[li];
    if (s.dead) return;                       // already booked; see Match._deathGuard
    s.dead = true;
    deaths.push({
      id: v.id,
      t: g.match.elapsed,
      x: v.position.x, y: v.position.y, z: v.position.z,
      spawn: li,
      sinceSpawn: g.match.elapsed - s.t,
      fromSpawn: Math.hypot(v.position.x - s.x, v.position.y - s.y, v.position.z - s.z),
    });
    life.delete(v.id);
  });

  const ticks = Math.round(seconds / TICK);
  for (let i = 0; i < ticks; i++) g._fixedUpdate(TICK);

  const groupCount = spawner.groups.length;
  const groups = spawner.describeGroups();
  const sequence = spawns.map((s) => `${s.id}:${s.pointId}@${s.t.toFixed(4)}`).join('|');
  g.match.dispose?.();
  return { spawns, deaths, groupCount, groups, sequence, scoreCalls, source: spawner.spawnSource };
}

/** Fold one or more trials into the three metrics. */
function metrics(trials) {
  const spawns = trials.flatMap((t) => t.spawns);
  const deaths = trials.flatMap((t) => t.deaths);
  const groupCount = trials[0].groupCount;

  // Openers are excluded from BOTH spawn metrics. `match.begin()` places the entire
  // roster inside one tick, so every entity is looking at wherever it was standing at the
  // end of the previous life and half the roster has not been moved yet — a "flip" there
  // is an artifact of simultaneous placement, not a spawn decision. Nobody is shooting at
  // t=0 either. The metric is about respawning into a live match.
  const live = spawns.filter((s) => s.t > 0);
  const flipped = live.filter((s) => s.witnesses > 0);

  const attributable = deaths.filter((d) => d.sinceSpawn <= REPEAT_T && d.fromSpawn <= REPEAT_D);

  const cells = new Map();
  const firstDeaths = deaths.filter((d) => d.sinceSpawn <= FIRST_DEATH_T);
  for (const d of firstDeaths) {
    const key = `${Math.floor(d.x / CELL)},${Math.floor(d.z / CELL)}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  let hhi = 0;
  let top = 0;
  for (const n of cells.values()) {
    const p = n / Math.max(1, firstDeaths.length);
    hhi += p * p;
    if (p > top) top = p;
  }

  return {
    spawnCount: live.length,
    deathCount: deaths.length,
    repeatRate: deaths.length ? attributable.length / deaths.length : 0,
    repeatN: attributable.length,
    flipRate: live.length ? flipped.length / live.length : 0,
    flipN: flipped.length,
    firstDeathCount: firstDeaths.length,
    cellCount: cells.size,
    effectiveCells: hhi > 0 ? 1 / hhi : 0,
    topCellShare: top,
    groupCount,
  };
}

console.log('\n══ spawn quality (P3.A2) ══');

/**
 * BASELINE and DEGRADE both work by editing the REAL weight table the REAL scorer reads.
 * Nothing is stubbed and no second implementation exists — the object mutated here is the
 * one `scorePoint` dereferences on every candidate.
 *
 * `--baseline` zeroes exactly the six terms P3.A2 added. With all six at zero the score
 * of every candidate is arithmetically identical to the pre-P3.A2 scorer, so the numbers
 * it reports are the honest before-figure for the same map, seeds and bot count.
 */
if (BASELINE) {
  SPAWN_WEIGHTS.enemyCone = 0;
  SPAWN_WEIGHTS.deathHeat = 0;
  SPAWN_WEIGHTS.pressure = 0;
  SPAWN_WEIGHTS.groupFriendly = 0;
  SPAWN_WEIGHTS.groupEnemy = 0;
  SPAWN_WEIGHTS.groupRecentUse = 0;
  note('BASELINE: the six P3.A2 scoring terms are zeroed — this is the pre-change scorer');
}
if (DEGRADE === 'los') {
  // Invert the two visibility terms so the scorer PREFERS a point an enemy is looking at.
  // Zeroing them was tried first and moved the flip rate from 0.00% to 1.99% — a real
  // move, but one that squeaks under the threshold, and a degradation that does not
  // actually trip the gate is not evidence the gate works. Targets the flip rate.
  SPAWN_WEIGHTS.losEnemy = 1400;
  SPAWN_WEIGHTS.enemyCone = 1700;
  note('DEGRADED: losEnemy and enemyCone INVERTED — the scorer now seeks enemy sightlines');
} else if (DEGRADE === 'death') {
  // Invert the terms that hold a player away from the body he just left. Inverting
  // deathSpot/deathHeat/pressure ALONE barely moved the number, and the reason is worth
  // recording: those three are radius-limited (8/11/15 m) and most deaths happen well
  // away from any spawn marker, so on this map they are usually inert. Enemy proximity
  // is the term that actually decides most placements, so it is the one to invert.
  // Targets the repeat-death rate.
  SPAWN_WEIGHTS.proximity = 800;
  SPAWN_WEIGHTS.deathSpot = 900;
  SPAWN_WEIGHTS.deathHeat = 900;
  SPAWN_WEIGHTS.pressure = 900;
  note('DEGRADED: proximity, deathSpot, deathHeat and pressure INVERTED — the scorer now seeks the fight');
} else if (DEGRADE === 'hostile') {
  // Every safety term the scorer has, inverted, plus no reason to move off a winner: the
  // worst spawn system that still compiles. This is the one the repeat-death threshold is
  // proven against.
  SPAWN_WEIGHTS.proximity = 800;
  SPAWN_WEIGHTS.losEnemy = 1400;
  SPAWN_WEIGHTS.enemyCone = 1700;
  SPAWN_WEIGHTS.deathSpot = 900;
  SPAWN_WEIGHTS.deathHeat = 900;
  SPAWN_WEIGHTS.pressure = 900;
  SPAWN_WEIGHTS.groupEnemy = 650;
  SPAWN_WEIGHTS.recentUse = 0;
  SPAWN_WEIGHTS.groupRecentUse = 0;
  SPAWN_WEIGHTS.jitter = 0;
  note('DEGRADED: every safety term inverted and every recency term removed');
} else if (DEGRADE === 'stick') {
  // A scorer that scores nothing: every term that varies between candidates is zeroed,
  // so every eligible point ties on `base` and the argmax always returns the same index.
  // Targets the dispersion statistics.
  for (const k of ['losEnemy', 'enemyCone', 'proximity', 'recentUse', 'deathSpot', 'deathHeat',
    'pressure', 'friendlyIdeal', 'friendlyCrowd', 'facingAway', 'jitter',
    'groupFriendly', 'groupEnemy', 'groupRecentUse']) SPAWN_WEIGHTS[k] = 0;
  note('DEGRADED: every candidate-varying term zeroed — one point now wins every contest');
} else if (DEGRADE) {
  bad('--degrade names a known degradation', `unknown mode '${DEGRADE}'`);
}

/**
 * The CONTROL ARM.
 *
 * The absolute thresholds above are calibrated against a map that is still being authored.
 * Across three successive states of The Square's graybox the shipped scorer's repeat-death
 * rate moved from 0.06% to 0.91% without a line of this file or of spawner.js changing —
 * the geometry moved combat closer to the spawn markers, and the number followed. A gate
 * calibrated to 0.5% on Tuesday is a false alarm on Wednesday, and a gate loosened to
 * survive Wednesday is a gate that no degradation can trip.
 *
 * So the sharp gate is a COMPARISON, run in the same process, on the same map, with the
 * same seeds. The control is the real scorer with its three enemy-awareness terms inverted
 * — it still scores, still uses the manifest, still claims points; it simply wants to put
 * you near an enemy instead of away from one. Map drift moves both arms together and
 * cancels out of the ratio; a scorer that has stopped working collapses the ratio to 1.
 *
 * This is not a fake of the thing under test. It is the thing under test, run twice with
 * one input changed — which is the only way to attribute an outcome to the scorer rather
 * than to the level.
 */
const CONTROL_WEIGHTS = { proximity: 800, losEnemy: 1400, enemyCone: 1700 };

/** The shipped scorer must at least halve the control's rate. */
const REPEAT_RATIO_MAX = 0.5;
/** ...and hold flips to a quarter of it. The flip term is the one aimed squarely at this. */
const FLIP_RATIO_MAX = 0.25;
/** Below this many control-arm events the ratio is decided by luck and is not asserted. */
const MIN_CONTROL_EVENTS = 8;

async function runArm(seeds, weights) {
  const saved = {};
  for (const k of Object.keys(weights ?? {})) { saved[k] = SPAWN_WEIGHTS[k]; SPAWN_WEIGHTS[k] = weights[k]; }
  try {
    const out = [];
    for (const seed of seeds) out.push(await runTrial({ seed }));
    return metrics(out);
  } finally {
    for (const k of Object.keys(saved)) SPAWN_WEIGHTS[k] = saved[k];
  }
}

const trials = [];
for (const seed of TRIAL_SEEDS) trials.push(await runTrial({ seed }));
const m = metrics(trials);
const control = await runArm(TRIAL_SEEDS, CONTROL_WEIGHTS);

console.log(`  ${TRIAL_SEEDS.length} × ${TRIAL_SECONDS}s bot matches per arm, ${TRIAL_BOTS + 1} entities, ${m.groupCount} spawn groups (manifest spawns: ${trials[0].source})`);
console.log(`     ${trials[0].groups.map((g) => `${g.id}×${g.count}`).join(' · ')}`);
console.log(`     shipped: ${m.spawnCount} live respawns, ${m.deathCount} deaths   ·   control: ${control.spawnCount} / ${control.deathCount}`);

console.log(`\n  immediate repeat-death rate  ${(m.repeatRate * 100).toFixed(2)}%  (${m.repeatN}/${m.deathCount} deaths within ${REPEAT_T}s and ${REPEAT_D}m of their spawn)`);
console.log(`     control arm ${(control.repeatRate * 100).toFixed(2)}% (${control.repeatN}/${control.deathCount})`);
if (m.deathCount < 100) bad('the trial produced enough deaths to measure', `${m.deathCount} deaths — under 100 the rates are noise`);
else {
  if (m.repeatRate <= REPEAT_MAX) ok(`immediate repeat-death rate ${(m.repeatRate * 100).toFixed(2)}% is at or under the ${(REPEAT_MAX * 100).toFixed(2)}% ceiling`);
  else bad('immediate repeat-death rate is at or under the ceiling', `${(m.repeatRate * 100).toFixed(2)}% > ${(REPEAT_MAX * 100).toFixed(2)}%`);
  if (control.repeatN < MIN_CONTROL_EVENTS) {
    bad('the control arm produces enough repeat deaths to compare against',
      `${control.repeatN} < ${MIN_CONTROL_EVENTS} — this harness cannot tell a working scorer from a broken one on this map, which is the failure mode it exists to prevent`);
  } else if (m.repeatRate <= control.repeatRate * REPEAT_RATIO_MAX) {
    ok(`the scorer holds repeat deaths to ${(m.repeatRate / control.repeatRate * 100).toFixed(0)}% of the enemy-seeking control (need ≤ ${REPEAT_RATIO_MAX * 100}%)`);
  } else {
    bad('the scorer beats the enemy-seeking control on repeat deaths',
      `${(m.repeatRate * 100).toFixed(2)}% vs control ${(control.repeatRate * 100).toFixed(2)}% — ${(m.repeatRate / control.repeatRate * 100).toFixed(0)}% of it, need ≤ ${REPEAT_RATIO_MAX * 100}%`);
  }
}

console.log(`\n  spawn-flip-into-enemy rate   ${(m.flipRate * 100).toFixed(2)}%  (${m.flipN}/${m.spawnCount} placements inside a living enemy's ${FLIP_RANGE}m / ±${FLIP_HALF_ANGLE}° / clear-LOS envelope)`);
console.log(`     control arm ${(control.flipRate * 100).toFixed(2)}% (${control.flipN}/${control.spawnCount})`);
if (m.flipRate <= FLIP_MAX) ok(`spawn-flip-into-enemy rate ${(m.flipRate * 100).toFixed(2)}% is at or under the ${(FLIP_MAX * 100).toFixed(2)}% ceiling`);
else bad('spawn-flip-into-enemy rate is at or under the ceiling', `${(m.flipRate * 100).toFixed(2)}% > ${(FLIP_MAX * 100).toFixed(2)}%`);
if (control.flipN < MIN_CONTROL_EVENTS) {
  bad('the control arm produces enough flips to compare against',
    `${control.flipN} < ${MIN_CONTROL_EVENTS} — the flip gate cannot distinguish a working scorer from a broken one on this map`);
} else if (m.flipRate <= control.flipRate * FLIP_RATIO_MAX) {
  ok(`the scorer holds flips to ${(m.flipRate / control.flipRate * 100).toFixed(0)}% of the enemy-seeking control (need ≤ ${FLIP_RATIO_MAX * 100}%)`);
} else {
  bad('the scorer beats the enemy-seeking control on flips',
    `${(m.flipRate * 100).toFixed(2)}% vs control ${(control.flipRate * 100).toFixed(2)}% — need ≤ ${FLIP_RATIO_MAX * 100}%`);
}

{
  console.log(`\n  first-death distribution     ${m.firstDeathCount} deaths within ${FIRST_DEATH_T}s of spawn over ${m.cellCount} ${CELL}m cells`);
  console.log(`     effective cells ${m.effectiveCells.toFixed(2)} (need \u2265 ${MIN_EFFECTIVE_CELLS})   busiest cell ${(m.topCellShare * 100).toFixed(2)}% (need \u2264 ${(MAX_TOP_CELL_SHARE * 100).toFixed(0)}%)`);
  console.log(`     control arm ${control.effectiveCells.toFixed(2)} / ${(control.topCellShare * 100).toFixed(2)}%`);
  if (m.firstDeathCount < 60) {
    bad('enough spawn-attributable deaths to describe a distribution', `${m.firstDeathCount} — under 60 the dispersion statistics are noise`);
  } else {
    if (m.effectiveCells >= MIN_EFFECTIVE_CELLS) ok(`first deaths are spread over ${m.effectiveCells.toFixed(2)} effective cells`);
    else bad('first deaths are spread over enough effective cells', `${m.effectiveCells.toFixed(2)} < ${MIN_EFFECTIVE_CELLS}`);
    if (m.topCellShare <= MAX_TOP_CELL_SHARE) ok(`the busiest cell holds ${(m.topCellShare * 100).toFixed(2)}% of first deaths`);
    else bad('no single cell dominates the first-death distribution', `${(m.topCellShare * 100).toFixed(2)}% > ${(MAX_TOP_CELL_SHARE * 100).toFixed(0)}%`);
  }
}

// ── determinism ──────────────────────────────────────────────────────────────────────
//
// Two runs at the same seed must place the same entity on the same point at the same
// tick, forever. The comparison is the whole SEQUENCE, not a count or a checksum of the
// final state: a spawner that picked differently but ended up with the same tally would
// pass a summary comparison and fail a replay.
{
  const a = await runTrial({ seed: 777, seconds: 120 });
  const b = await runTrial({ seed: 777, seconds: 120 });
  if (a.sequence.length === 0) {
    bad('the determinism trial spawned anything at all', '0 placements');
  } else if (a.sequence === b.sequence) {
    ok(`two runs at seed 777 produced an identical ${a.spawns.length}-placement spawn sequence`);
  } else {
    const xs = a.sequence.split('|');
    const ys = b.sequence.split('|');
    let at = 'length only';
    for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
      if (xs[i] !== ys[i]) { at = `placement ${i}: '${xs[i]}' vs '${ys[i]}'`; break; }
    }
    bad('two runs at the same seed produce an identical spawn sequence', at);
  }
}

// ── Bomb: fixed protected spawns (bomb-rules.md §2, §8) ──────────────────────────────
//
// `src/game/modes.js` is another lane's file and Bomb is not in it yet. What is under
// test here is the SPAWNER, and the mode is its INPUT — so the input is supplied as a
// mode descriptor of the documented shape (`spawnPolicy`, `fixedSpawnGroup`). The
// spawner, the world, the geometry and the LOS queries are all real. When the real Bomb
// ruleset lands it declares the same two properties and these assertions bind to it
// unchanged.
{
  const g = new Game({ headless: true });
  await g.initHeadless({ presenter: new NullPresenter() });
  g.startMatch({ mode: 'tdm', botCount: 11, difficulty: 'regular', killLimit: 5000, seed: 24601 });
  g.match.phase = 'live';
  g.match.countdown = 0;
  const spawner = g.match.spawner;

  // Where the registered Bomb ruleset actually stands. This is a NOTE, not a gate: the
  // interface is documented at the top of spawner.js and modes.js is another lane's file,
  // so the honest thing is to report the state of the handshake rather than to fail
  // another lane's in-flight work — or, worse, to quietly assume it is done.
  {
    const registered = MODES?.bomb ?? null;
    if (registered === null) note('no `bomb` ruleset is registered yet — the fixed-spawn path below is exercised through a mode descriptor');
    else if (registered.spawnPolicy === SPAWN_POLICY.FIXED) note('the registered Bomb ruleset declares spawnPolicy: fixed');
    else note(`the registered Bomb ruleset does NOT declare spawnPolicy — it currently spawns through the TDM dynamic scorer. One line in modes.js (\`spawnPolicy: '${SPAWN_POLICY.FIXED}'\`) switches it to the fixed protected path proven below`);
  }

  // TDM first: the mode that declares nothing must be dynamic, or "Bomb is fixed" is a
  // statement about nothing.
  if (spawner.policy === SPAWN_POLICY.DYNAMIC) ok('a mode declaring no spawnPolicy is dynamic (TDM)');
  else bad('a mode declaring no spawnPolicy is dynamic', spawner.policy);

  const teamGroups = [0, 1].map((t) => {
    const own = spawner.groups.filter((gr) => gr.team === t);
    own.sort((p, q) => q.points.length - p.points.length || (p.id < q.id ? -1 : 1));
    return own[0];
  });
  if (!teamGroups[0] || !teamGroups[1]) {
    bad('the map offers a protected group per team', `${teamGroups.map((x) => x?.id).join(',')}`);
  }

  let side = 0;   // flipped below to model bomb-rules.md §2's switch after round 6
  const bombMode = {
    id: 'bomb',
    spawnPolicy: SPAWN_POLICY.FIXED,
    fixedSpawnGroup: (_match, team) => teamGroups[team ^ side]?.id ?? null,
  };
  g.match.mode = bombMode;

  const ents = g.entities.filter((e) => e.alive || true);
  let scored = 0;
  const realScore = spawner.scorePoint.bind(spawner);
  spawner.scorePoint = (p, e) => { scored++; return realScore(p, e); };

  const picksFor = (which) => {
    side = which;
    spawner.reset();
    const out = [];
    for (const e of ents) {
      const pick = spawner.pickSpawn(e);
      out.push({ team: e.team, groupId: spawner.lastPick.groupId, pointId: spawner.lastPick.id, policy: spawner.lastPick.policy, x: pick.position.x, y: pick.position.y, z: pick.position.z });
      // Claim it, the way spawnEntity would, so the spread assertion below is real.
      spawner._claims.push({ x: pick.position.x, y: pick.position.y, z: pick.position.z, t: spawner.now });
      if (spawner.lastPick.index >= 0) spawner.points[spawner.lastPick.index].lastUsed = spawner.now;
    }
    return out;
  };

  const first = picksFor(0);
  const second = picksFor(1);

  if (scored === 0) ok(`Bomb made ${first.length + second.length} placements without one call to the dynamic scorer`);
  else bad('Bomb never uses the dynamic spawn scorer', `scorePoint was called ${scored} times under spawnPolicy 'fixed'`);

  const wrongPolicy = first.concat(second).filter((p) => p.policy !== SPAWN_POLICY.FIXED);
  if (wrongPolicy.length === 0) ok('every Bomb placement is recorded as a fixed pick');
  else bad('every Bomb placement is recorded as a fixed pick', `${wrongPolicy.length} were not`);

  const strayed = first.filter((p) => p.groupId !== teamGroups[p.team].id);
  if (strayed.length === 0) ok(`both teams stayed inside their declared protected group (${teamGroups.map((x) => x.id).join(' / ')})`);
  else bad('every Bomb placement lands in the group the mode declared', `${strayed.length} of ${first.length} did not: ${strayed.slice(0, 3).map((p) => `t${p.team}->${p.groupId}`).join(', ')}`);

  const switched = second.filter((p) => p.groupId !== teamGroups[p.team ^ 1].id);
  if (switched.length === 0) ok('the side switch moves both teams to the other protected group');
  else bad('the side switch moves both teams to the other protected group', `${switched.length} of ${second.length} did not`);

  // Spread: a protected group must not stack its own team on one point.
  for (const [label, picks] of [['pre-switch', first], ['post-switch', second]]) {
    for (const t of [0, 1]) {
      const mine = picks.filter((p) => p.team === t);
      const distinct = new Set(mine.map((p) => p.pointId)).size;
      const want = Math.min(mine.length, teamGroups[t ^ (label === 'pre-switch' ? 0 : 1)].points.length);
      if (distinct >= want) ok(`${label}: team ${t}'s ${mine.length} players occupy ${distinct} distinct protected points`);
      else bad(`${label}: a protected group spreads its team over distinct points`, `${distinct} distinct for ${mine.length} players, group holds ${want}`);
    }
  }

  // PROTECTED means protected: no selected spawn may have a clear line to an enemy's
  // selected spawn. Measured against the real geometry, not against a claim.
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (const [label, picks] of [['pre-switch', first], ['post-switch', second]]) {
    const offenders = [];
    for (const p of picks) {
      for (const q of picks) {
        if (p.team === q.team) continue;
        a.set(p.x, p.y + EYE, p.z);
        b.set(q.x, q.y + EYE, q.z);
        if (w.losClear(a, b)) offenders.push(`${p.pointId} -> ${q.pointId} at ${a.distanceTo(b).toFixed(1)} m`);
      }
    }
    if (offenders.length === 0) ok(`${label}: no protected spawn can be shot from an enemy protected spawn`);
    else bad(`${label}: a protected spawn cannot be selected into an enemy's line of fire`, `${offenders.length}:\n       ${offenders.slice(0, 4).join('\n       ')}`);
  }

  g.match.dispose?.();
}

console.log(failures ? `\n${failures} FAILED` : '\nbalance report complete');
process.exit(failures ? 1 : 0);
