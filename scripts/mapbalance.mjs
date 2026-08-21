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
 *   node scripts/mapbalance.mjs --geom-only     skip the 33 headless spawn matches
 *   node scripts/mapbalance.mjs --baseline      zero the P3.A2 scoring terms, for a
 *                                               before/after delta (see BASELINE below)
 *   node scripts/mapbalance.mjs --degrade=los|death|hostile|stick
 *                                               deliberately break one part of the real
 *                                               scorer, to prove a threshold can fail
 *   node scripts/mapbalance.mjs --degrade=cover|open|arena|sites-adjacent|no-sites [--strict]
 *                                               deliberately break the GEOMETRY or the §3
 *                                               manifest, to prove a sightline threshold
 *                                               can fail
 *
 * ── P3 exit criterion 4: sightlines (map-data.md §7.0/§7.1) ──────────────────────────
 *
 * The sightline section below is a rewrite, and it measures three things the contract
 * names: the length distribution over close/medium/long bands read out of the weapon
 * table, the §7.0 48 m hard ceiling, and "no single uncontested angle covering both
 * sites" made operational. It reports both The Square and the MERIDIAN fixture (§9).
 *
 * A §7 envelope breach on The Square is [CX]'s geometry work and prints as PENDING, the
 * same treatment `navtest.mjs` §7.1 gives route timings. `--strict` makes it fatal, which
 * is how each threshold below was proven failable. Every number here was RE-MEASURED after
 * the length distribution moved onto the glass-transparent ray (see "which ray is a
 * sightline" in `sightlines`); the old table was taken on the ballistics ray and its long
 * band read 0.3 points lower:
 *
 *   threshold                        restored      degraded
 *   ──────────────────────────────── ───────────── ────────────────────────────────────
 *   bands all ≥ 5% of rays           long 4.9% ✗   arena: 30.7/23.9/45.4, all pass ✓
 *                                    meridian ✓    (the long band separates 4.9 / 11.0 /
 *                                    (long 11.0%)   45.4 — see the section comment for
 *                                                   what close and medium cannot do)
 *   longest ≤ 48 m (§7.0 hard)       72.6 m ✗      arena: 117.9 m ✗
 *   no uncontested dual-site angle   0 of 13 ✓     sites-adjacent: 57 of 376 ✗
 *   a rotation map declares 2 sites  2 ✓           no-sites: 0 — FAIL, not ABSENT
 *
 * The dual-site row is the one that matters and it moves cleanly: on the map as authored 13
 * standing positions see both sites, the least exposed of them sees 23.0% of the playspace
 * and none clears the 5% exposure bar; move site B onto walkable ground 8 m from site A and
 * 376 positions see both, 57 of them from cover. So the threshold is exercised 13 times on
 * the shipped map rather than passing for want of a candidate — and when a map DOES have no
 * candidates, the run says so on its own line instead of printing a bare `ok`.
 *
 * `no-sites` is the last row's degradation and it exists because that row used to report
 * ABSENT for The Square — the rotation map — citing the map-data.md §9 FIXTURE clause, and
 * exit 0. A fixture with no sites is a schedule; a rotation map with no sites is a Bomb map
 * that cannot be played. `navtest.mjs` §7.1 already made that distinction; this file now
 * does too, and it is a hard FAIL in the default (ci) mode rather than a `--strict` one.
 */
import * as THREE from 'three';
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';
import { SPAWN_WEIGHTS, SPAWN_POLICY } from '../src/game/spawner.js';
import { MODES } from '../src/game/modes.js';
import { WEAPONS } from '../src/weapons/weaponDefs.js';
import { DEFAULTS } from '../src/core/settings.js';
import { mapRotation } from '../src/world/world.js';

const ARGV = process.argv.slice(2);
const flag = (k) => ARGV.includes(`--${k}`);
const opt = (k, d = null) => {
  const hit = ARGV.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const SPAWN_ONLY = flag('spawn-only');
const BASELINE = flag('baseline');
const DEGRADE = opt('degrade', '');
const STRICT = flag('strict');
const GEOM_ONLY = flag('geom-only');
const TOP_RAYS = flag('top-rays');
/** `navGrid.js` F_WALKABLE. Used by the sightline sampler and by the site degradation. */
const F_WALKABLE_BIT = 1;

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const note = (n) => console.log(`  --   ${n}`);
/**
 * A §7 envelope number outside its band on The Square is [CX]'s geometry work, tracked as
 * REQ-CX-008 — the same PENDING treatment `navtest.mjs` §7.1 and `maptest.mjs`'s §3
 * manifest guard already give it, and for the same reason: failing here would either block
 * every backend commit behind another lane's map edit or get the band widened until
 * nothing could trip it. `--strict` makes them fatal, and is how each one is proven
 * failable without leaving a live gate on somebody else's file.
 */
const pendingEnvelope = (n, d) => {
  if (STRICT) { failures++; console.log(`  FAIL ${n}\n       ${d}`); return; }
  console.log(`  PENDING  ${n}: ${d} — REQ-CX-008 (geometry, [CX]).`);
};

/**
 * `--degrade=cover` — delete the map's cover volumes and re-run every geometry section
 * against the result.
 *
 * A cover volume is identified by shape, not by a tag the level does not carry: a box
 * standing ON the ground whose top is between waist and just over head height, with a
 * footprint small enough to walk around. That is a crate, a planter, a barrier, a
 * market stall counter — and not a building, a floor or a wall, which are taller, and not
 * a kerb, which is lower.
 *
 * The spatial hash is rebuilt from the survivors; the nav graph is deliberately NOT
 * re-baked. Holding the standpoint set fixed is what makes the before/after comparable —
 * re-baking changes which positions are sampled at the same time as it changes what they
 * can see, and the first run of this degradation moved the numbers the WRONG WAY for
 * exactly that reason: removing crates deleted the nodes standing on top of them, taking
 * the map's elevated long views out of the sample and making the map look tighter after
 * its cover was removed. The cost of holding the graph fixed is that a handful of
 * standpoints now float where a crate used to be, which lengthens sightlines slightly —
 * in the same direction as the degradation, so it cannot manufacture a pass.
 */
function stripCover(g) {
  const world = g.world;
  const before = world.boxes.length;
  world.boxes = world.boxes.filter((b) => {
    const top = b.max.y - b.min.y;
    const foot = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
    const standsOnGround = b.min.y <= 0.6;
    const waistToHead = b.max.y >= 0.6 && b.max.y <= 2.0;
    return !(standsOnGround && waistToHead && foot <= 6 && top <= 2.0);
  });
  world.build();
  return before - world.boxes.length;
}

/**
 * `--degrade=open` — every collider deleted except the ones that reach above head height.
 *
 * The map with all of its mid-height obstruction taken away and its buildings left standing.
 * Harsher than `cover` and aimed squarely at the band-representation floor: with nothing
 * below 2.4 m to break a line, the close band has to collapse. Same fixed-nav-graph
 * discipline as `stripCover`, for the same reason.
 */
function stripLowGeometry(g) {
  const world = g.world;
  const before = world.boxes.length;
  world.boxes = world.boxes.filter((b) => b.max.y > 2.4);
  world.build();
  return before - world.boxes.length;
}

/**
 * `--degrade=arena` — everything but the floor and the competitive boundary deleted.
 *
 * The map as an empty box. This is the degradation the band-representation floor is proven
 * against, because `cover` and `open` cannot trip it: The Square's occlusion comes almost
 * entirely from buildings, so deleting its 21 cover volumes moves the close band by 0.0
 * points (78.2% either way) and deleting all 42 of its sub-head-height colliders moves it by
 * 3.2, to 75.0% — and the floor is on the LONG band, which those two push the wrong way
 * (4.9% -> 4.9% and 5.2%). That is a finding about the map, not a reason to keep quiet — a
 * floor that only ever fires on geometry nobody would author is a weak floor, and it is
 * recorded as such in the header. Re-measured on the glass-transparent ray.
 *
 * "Boundary" is identified by position, not by a tag the compiled boxes do not carry: a box
 * that reaches the edge of the declared bounds on any axis. That is the §5 removable layer
 * plus the outermost walls, which is exactly what has to stay for the rays to terminate.
 */
function stripToArena(g) {
  const world = g.world;
  const bounds = world.manifest?.bounds ?? world.bounds;
  const EDGE = 2.0;
  const before = world.boxes.length;
  world.boxes = world.boxes.filter((b) => {
    if (b.max.y <= 0.2) return true;                                    // the ground itself
    return b.min.x <= bounds.min.x + EDGE || b.max.x >= bounds.max.x - EDGE
      || b.min.z <= bounds.min.z + EDGE || b.max.z >= bounds.max.z - EDGE;
  });
  world.build();
  return before - world.boxes.length;
}

/**
 * `--degrade=sites-adjacent` — move site B's plant volume alongside site A's.
 *
 * The specific map defect the "no single uncontested angle covering both sites" row exists
 * to catch: two objectives placed so close together that holding one position holds both.
 * It edits `world.manifest.objectives`, the same normalised manifest the Bomb ruleset, the
 * bots and the HUD read, so it is the defect a map author would actually ship.
 */
function sitesAdjacent(g) {
  const objectives = g.world.manifest?.objectives;
  if (!Array.isArray(objectives) || objectives.length === 0) return 'no objective volumes to move';
  const a = objectives.find((o) => o.kind === 'plant' && o.site === 'A');
  const b = objectives.find((o) => o.kind === 'plant' && o.site === 'B');
  if (!a || !b) return 'this map does not declare a plant volume for both A and B';

  // The destination is chosen from the NAV GRAPH, not by arithmetic on site A's corner. A
  // hand-computed offset landed the volume six metres inside a wall, where it contained no
  // standable ground — and the harness correctly refused to measure coverage against an
  // empty target set, which meant the degradation proved nothing. A degradation has to
  // produce a map that is wrong in the intended way, not one that is broken in another.
  const nav = g.nav;
  const MAXL = nav.maxLayers;
  const cx = (a.box.min.x + a.box.max.x) / 2;
  const cy = a.box.min.y;
  const cz = (a.box.min.z + a.box.max.z) / 2;
  let bestX = null, bestZ = null, bestY = 0, bestScore = Infinity;
  for (let node = 0; node < nav.nodeCount; node++) {
    if (!(nav.flags[node] & F_WALKABLE_BIT) || !nav.reachable[node]) continue;
    const col = (node / MAXL) | 0;
    const x = nav.cellCenterX(col), z = nav.cellCenterZ(col), y = nav.floorY[node];
    if (Math.abs(y - cy) > 0.6) continue;
    const d = Math.hypot(x - cx, z - cz);
    if (d < 6 || d > 10) continue;
    // Deterministic: the candidate closest to 8 m, ties broken by coordinate order.
    const score = Math.abs(d - 8) * 1000 + x * 0.001 + z * 0.000001;
    if (score < bestScore) { bestScore = score; bestX = x; bestZ = z; bestY = y; }
  }
  if (bestX === null) return 'no standable ground 6-10 m from site A — nothing to move site B onto';
  const dx = b.box.max.x - b.box.min.x;
  const dz = b.box.max.z - b.box.min.z;
  const dy = b.box.max.y - b.box.min.y;
  b.box.min.set(bestX - dx / 2, bestY, bestZ - dz / 2);
  b.box.max.set(bestX + dx / 2, bestY + dy, bestZ + dz / 2);
  return `site B's plant volume moved onto walkable ground at (${bestX.toFixed(1)}, ${bestY.toFixed(2)}, ${bestZ.toFixed(1)}), `
    + `${Math.hypot(bestX - cx, bestZ - cz).toFixed(1)} m from site A`;
}

/**
 * `--degrade=no-sites` — empty `world.manifest.objectives`.
 *
 * A Bomb map whose plant volumes stopped resolving: the §3.3 export gone from the same
 * normalised manifest the ruleset, the bots and the HUD read. It exists to prove the row
 * directly above `sitesAdjacent` can fail — the in-rotation guard on the dual-site row —
 * because "the map declares no sites" is otherwise the one input that makes that row
 * report success by not running. Meant with `--geom-only`; the P3.A2 spawn matches below
 * play Bomb and have nothing to plant.
 */
function stripSites(g) {
  const objectives = g.world.manifest?.objectives;
  if (!Array.isArray(objectives)) return 'this map declares no objectives array to empty';
  const n = objectives.length;
  objectives.length = 0;
  return `${n} objective volume(s) deleted from the §3 manifest`;
}

const game = new Game({ headless: true });
await game.initHeadless({ presenter: new NullPresenter() });
const w = game.world;
const nav = game.nav;
const EYE = 1.62;

/**
 * Geometry degradations, applied to the real world before a single ray is cast. Each one
 * exists to prove one sightline threshold can fail; the header records what each measured.
 */
const GEOM_DEGRADES = new Set(['cover', 'open', 'arena', 'sites-adjacent', 'no-sites']);
function degradeGeometry(g, label) {
  if (DEGRADE === 'cover') {
    const removed = stripCover(g);
    if (removed === 0) bad(`--degrade=cover removed something from ${label}`, 'no box matched the cover shape — the degradation is a no-op and would prove nothing');
    else note(`DEGRADED ${label}: ${removed} cover volumes deleted (nav graph held fixed)`);
  } else if (DEGRADE === 'open') {
    const removed = stripLowGeometry(g);
    if (removed === 0) bad(`--degrade=open removed something from ${label}`, 'no box was below head height — the degradation is a no-op');
    else note(`DEGRADED ${label}: ${removed} colliders below 2.4 m deleted (nav graph held fixed)`);
  } else if (DEGRADE === 'arena') {
    const removed = stripToArena(g);
    if (removed === 0) bad(`--degrade=arena removed something from ${label}`, 'every collider touched the bounds — the degradation is a no-op');
    else note(`DEGRADED ${label}: ${removed} interior colliders deleted, floor and boundary kept (nav graph held fixed)`);
  } else if (DEGRADE === 'sites-adjacent') {
    note(`DEGRADED ${label}: ${sitesAdjacent(g)}`);
  } else if (DEGRADE === 'no-sites') {
    note(`DEGRADED ${label}: ${stripSites(g)}`);
  }
}
if (GEOM_DEGRADES.has(DEGRADE)) degradeGeometry(game, 'the-square');

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

// ── sightlines — map-data.md §7.0 ceiling and §7.1 distribution ───────────────────────
//
// The version of this section that shipped first sampled a 2 m lattice at y = 1.62 and
// cast 16 flat rays from each point. Two things were wrong with it, and both flattered
// the map:
//
//   - it sampled a PLANE, not the playspace. Every point was at eye height above y = 0,
//     so the upper walk and the signal bridge — the two levels a §7.0 "3 usable levels"
//     map is supposed to have — contributed nothing, and points floating inside the first
//     floor contributed rays no player could ever take. The standpoints below come from
//     the baked nav graph: walkable, reachable, at their real floor height, on every level;
//   - it capped rays at 90 m and compared against 55 m. §7.0's ceiling is 48 m and it is
//     called a HARD ceiling. 55 m was not the contract's number.
//
// ── what counts as close, medium and long ───────────────────────────────────────────
//
// Not taste, and not round numbers. The bands are read out of the weapon table, because a
// sightline is only "long" relative to what a player is holding. Two named reference
// weapons define the edges:
//
//   close  ≤ smg_kestrel.falloffStart   the roster's baseline SMG ("the safe pick",
//                                       weaponDefs.js) is still at full damage, so no
//                                       class has a range advantage;
//   medium ≤ ar_vector.falloffStart     the roster's baseline AR ("5.56 workhorse. No
//                                       weakness, no gimmick") is still at full damage;
//   long   > that                       past the workhorse AR's falloff — a marksman's
//                                       band, and the one §7.0 caps at 48 m.
//
// Both ids are asserted present rather than read optimistically: if the roster is
// re-authored and either disappears, this section fails instead of silently bucketing
// against `undefined`.
//
// "All represented" is ≥ REPRESENTED_MIN of rays in each band. The floor is 5%, calibrated
// against the retained comparison fixture rather than picked: MERIDIAN's thinnest band is
// 11.0%, so the floor sits under half of it, and half of the only shipped map this
// repository has is a defensible "this band is a curiosity rather than a way the map is
// played".
//
// WHAT THIS FLOOR CAN AND CANNOT SEPARATE — stated, because two thirds of it is weak.
//
// Measured across every configuration tried. RE-MEASURED in full on the glass-transparent
// ray — every row below moved, because 7.8% of The Square's rays and 7.0% of MERIDIAN's
// pass through at least one pane, and the old table stopped every one of them at the glass:
//
//                                 close    medium    long
//   the-square as shipped         78.2%     16.9%    4.9%   ← long breaches the floor
//   the-square --degrade=cover    78.2%     16.9%    4.9%
//   the-square --degrade=open     75.0%     19.8%    5.2%
//   the-square --degrade=arena    30.7%     23.9%   45.4%
//   meridian as shipped           71.3%     17.6%   11.0%
//   meridian --degrade=arena      26.3%     22.4%   51.3%
//
// The LONG band discriminates: it separates The Square (4.9%) from MERIDIAN (11.0%) from an
// empty arena (45.4%), and it fires on The Square as authored.
//
// The CLOSE and MEDIUM bands do NOT. Close never fell below 26.3% and medium never below
// 16.9% — not with every cover volume deleted, not with every collider below head height
// deleted, and not with the entire interior of the map deleted. Rays are cast from
// standing positions that are mostly near something, so short rays are unavoidable. Those
// two assertions are therefore tripwires against a pathological map, not guards that have
// ever been observed to fire, and they are reported as such instead of being presented as
// evidence the map passed something.
//
// One consequence of the bands worth naming: §7.0 caps sightlines at 48 m and the long
// band starts at 34 m, so a fully compliant map has only a 14 m window in which to be
// "long". The Square's 4.9% is 0.1 points under the floor — a real signal, but a marginal
// one, and the two numbers should be read together rather than the verdict alone. It was
// 0.4 points under on the ballistics ray, which is the whole reason the choice of ray had
// to be settled: the instrument's error was larger than the margin it was reporting on.
//
// ── "no single uncontested angle covering both sites" ───────────────────────────────
//
// Made operational, because as prose it cannot pass or fail. A standpoint p (a walkable,
// reachable nav node, at eye height) is an UNCONTESTED DUAL-SITE ANGLE when all four hold:
//
//   1. p has clear line of sight (`world.losClear` — the LOS query, which per map-data.md
//      §3.1 sees through glass; a bullet uses `world.raycast`, which does not) to a
//      standable point inside site A's plant volume, at most SIGHT_CEILING metres away;
//   2. the same for site B;
//   3. p is EXPOSED to at most EXPOSURE_MAX of the playspace — the share of sampled
//      standpoints with clear line of sight to p. This is what "uncontested" means: a spot
//      that watches both sites and that almost nowhere can shoot back at. A spot that
//      watches both sites from the middle of the plaza is a strong angle, not a broken
//      one, because it can be traded.
//
// Threshold: zero such standpoints. The distance cap in 1–2 is §7.0's own 48 m ceiling —
// past it the angle is already a §7.0 breach and is counted there, not laundered into
// this row as well.
//
// A FOURTH condition was tried and REMOVED, and it is worth recording because it made the
// row unfailable. It required the two view directions to be within one screen width of
// each other (a horizontal FOV derived from `DEFAULTS.fov` at 16:9, ≈117°) on the reasoning
// that "one angle" means both sites are visible at once. On any map whose sites are on
// opposite sides — which is every Bomb map — a position between them sees them roughly
// 180° apart, so the condition zeroed the count by construction and no degradation could
// move it. It was also wrong on its own terms: turning is free in an FPS, and a spot you
// can flick between two sites from is exactly the problem the row names. The angular
// separation is now REPORTED as data and constrains nothing.
//
// A map OUT OF ROTATION that declares no objective volumes (MERIDIAN, retained as a fixture
// by §9) is reported ABSENT for this row. It is NOT reported as a pass: `[].every()` is
// `true`, and a vacuous pass on the fixture is exactly how this row would stop guarding
// anything. A map IN ROTATION that declares no sites is the opposite case and is a hard
// FAIL — see the guard in `sightlines`. Prove it with `--degrade=no-sites`.
const SIGHT_CEILING = 48;                       // §7.0, hard
const REPRESENTED_MIN = 0.05;
const EXPOSURE_MAX = 0.05;
const AZIMUTHS = 24;
/** Horizontal FOV from the game's own default vertical FOV at 16:9. */
const HFOV = 2 * Math.atan(Math.tan((DEFAULTS.fov * Math.PI / 180) / 2) * (16 / 9)) * 180 / Math.PI;

/** Walkable, reachable standing eyes on every level of the baked graph. */
function standEyes(nav) {
  const MAXL = nav.maxLayers;
  const out = [];
  for (let node = 0; node < nav.nodeCount; node++) {
    if (!(nav.flags[node] & F_WALKABLE_BIT) || !nav.reachable[node]) continue;
    const col = (node / MAXL) | 0;
    out.push(new THREE.Vector3(nav.cellCenterX(col), nav.floorY[node] + EYE, nav.cellCenterZ(col)));
  }
  return out;
}

function sightlines(label, world, nav, manifest) {
  console.log(`\n  sightlines — ${label}`);
  const eyes = standEyes(nav);
  if (eyes.length < 200) {
    bad(`${label}: the nav graph offers standing positions to measure from`,
      `${eyes.length} walkable reachable nodes — every distribution below would be computed over almost nothing`);
    return;
  }

  const kestrel = WEAPONS.smg_kestrel;
  const vector = WEAPONS.ar_vector;
  if (!kestrel || !vector || !Number.isFinite(kestrel.falloffStart) || !Number.isFinite(vector.falloffStart)) {
    bad(`${label}: the sightline bands come from the weapon table`,
      'smg_kestrel / ar_vector falloffStart is missing — the close/medium/long boundaries cannot be derived');
    return;
  }
  const CLOSE_MAX = kestrel.falloffStart;
  const MED_MAX = vector.falloffStart;

  // The map diagonal, so an unobstructed ray reports its real length instead of a cap that
  // would quietly become the maximum sightline.
  const span = manifest.bounds.max.clone().sub(manifest.bounds.min);
  const REACH = Math.ceil(Math.hypot(span.x, span.z)) + 1;

  // ── which ray is a sightline ────────────────────────────────────────────────────────
  //
  // `world.raycast` is the BALLISTICS ray. It calls `_march(..., skipGlass = false)`
  // (world.js), so it stops at the first pane — correct for a bullet, which resolves
  // against glass, and wrong for a sightline. map-data.md §3.1: "Glass is tagged
  // transparent: it blocks movement but not line of sight." The Square has 41 glass boxes.
  //
  // This section measures SIGHTLINES: it is named for them, it is checked against the §7.0
  // sightline ceiling, and the dual-site row four screens below already uses
  // `world.losClear`, which DOES skip glass. Measuring the length distribution with the
  // opaque-and-glass ray while measuring site coverage with the glass-transparent one made
  // one section disagree with itself, and the disagreement was the same size as the signal:
  // the long band sits 0.4 points under its 5% floor and the two rays differ by 0.3 points.
  // So the distribution moves onto the transparent ray, and both rows now mean the same
  // thing by "can be seen".
  //
  // `losClear` answers a yes/no over a segment and cannot report a LENGTH, and `_march` is
  // private. So the length is walked with the public raycast: stop at the first opaque hit,
  // and step just past any pane and keep going. The ballistics length is kept from the same
  // rays and reported alongside, because the difference between the two is the map's glass
  // and is worth seeing rather than asserting once in a comment.
  const GLASS_STEP = 0.05;    // > 0, so a pane can never be re-entered at the same distance
  const GLASS_MAX = 128;      // 41 panes = 82 faces on The Square; an exhausted ray is a bug
  const o = new THREE.Vector3(), d = new THREE.Vector3(), march = new THREE.Vector3();
  const lens = [];            // to the first OPAQUE hit — the sightline
  const ballistic = [];       // to the first hit of ANY kind — what a bullet meets
  const rayRows = TOP_RAYS ? [] : null;
  let escaped = 0, throughGlass = 0, glassMetres = 0, exhausted = 0;
  for (const e of eyes) {
    for (let i = 0; i < AZIMUTHS; i++) {
      const a = (i / AZIMUTHS) * Math.PI * 2;
      d.set(Math.cos(a), 0, Math.sin(a));
      march.copy(e);
      let travelled = 0, panes = 0, first = -1;
      for (;;) {
        const hit = world.raycast(march, d, REACH - travelled);
        // The result is POOLED (a ring of 8), so both fields are read before the next cast.
        if (hit === null) { travelled = -1; break; }
        const dist = hit.distance;
        const glass = hit.surface === 'glass';
        if (first < 0) first = travelled + dist;
        if (!glass) { travelled += dist; break; }
        panes++;
        if (panes > GLASS_MAX) { exhausted++; travelled += dist; break; }
        travelled += dist + GLASS_STEP;
        if (travelled >= REACH) { travelled = -1; break; }
        march.copy(e).addScaledVector(d, travelled);
      }
      ballistic.push(first < 0 ? REACH : Math.min(first, REACH));
      const sightLength = travelled < 0 ? REACH : travelled;
      if (travelled < 0) escaped++;
      lens.push(sightLength);
      if (rayRows) rayRows.push({
        length: sightLength,
        x: e.x,
        y: e.y,
        z: e.z,
        dx: d.x,
        dz: d.z,
        azimuth: i,
      });
      if (panes > 0) {
        throughGlass++;
        glassMetres += (travelled < 0 ? REACH : travelled) - (first < 0 ? REACH : first);
      }
    }
  }
  if (exhausted > 0) {
    bad(`${label}: the sightline walk terminates`,
      `${exhausted} ray(s) hit ${GLASS_MAX} panes without reaching opaque geometry or leaving the map — `
      + 'the glass-skipping walk is not making progress, so every length below is suspect');
  }
  ballistic.sort((p, q) => p - q);
  lens.sort((p, q) => p - q);
  const pct = (f) => lens[Math.min(lens.length - 1, Math.floor(lens.length * f))];
  const close = lens.filter((v) => v <= CLOSE_MAX).length;
  const med = lens.filter((v) => v > CLOSE_MAX && v <= MED_MAX).length;
  const long = lens.length - close - med;
  const share = (n) => n / lens.length;

  console.log(`     ${eyes.length} standing positions × ${AZIMUTHS} azimuths = ${lens.length} rays, reach ${REACH} m`);
  console.log(`     length: median ${pct(0.5).toFixed(1)} m · p90 ${pct(0.9).toFixed(1)} · p99 ${pct(0.99).toFixed(1)} · max ${lens[lens.length - 1].toFixed(1)}`);
  console.log(`     bands:  close ≤${CLOSE_MAX} m ${(share(close) * 100).toFixed(1)}%`
    + ` · medium ≤${MED_MAX} m ${(share(med) * 100).toFixed(1)}%`
    + ` · long >${MED_MAX} m ${(share(long) * 100).toFixed(1)}%`);
  if (rayRows) {
    rayRows.sort((a, b) => b.length - a.length);
    console.log('     longest ray origins/directions:');
    for (const r of rayRows.slice(0, 24)) {
      console.log(`       ${r.length.toFixed(2)}m from (${r.x.toFixed(2)},${r.y.toFixed(2)},${r.z.toFixed(2)})`
        + ` dir (${r.dx.toFixed(3)},${r.dz.toFixed(3)}) azimuth ${r.azimuth}/${AZIMUTHS}`);
    }
    const overRows = rayRows.filter((r) => r.length > SIGHT_CEILING);
    const origins = new Map();
    const directions = new Map();
    const elevations = new Map();
    for (const r of overRows) {
      const originKey = `${r.x.toFixed(2)},${r.y.toFixed(2)},${r.z.toFixed(2)}`;
      origins.set(originKey, (origins.get(originKey) ?? 0) + 1);
      directions.set(r.azimuth, (directions.get(r.azimuth) ?? 0) + 1);
      const elevationKey = r.y.toFixed(2);
      elevations.set(elevationKey, (elevations.get(elevationKey) ?? 0) + 1);
    }
    console.log(`     >${SIGHT_CEILING}m offender origins: `
      + [...origins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([k, n]) => `${k} ×${n}`).join(' | '));
    console.log(`     >${SIGHT_CEILING}m offender directions: `
      + [...directions.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}/${AZIMUTHS} ×${n}`).join(' | '));
    console.log(`     >${SIGHT_CEILING}m offender eye elevations: `
      + [...elevations.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}m ×${n}`).join(' | '));
  }
  // What the choice of ray is worth, on this map, on this run — so "glass is transparent to
  // LOS" is a measured difference here rather than a claim in a comment. Zero on a map with
  // no glass, and then the two rows are the same measurement and say so.
  {
    const bpct = (f) => ballistic[Math.min(ballistic.length - 1, Math.floor(ballistic.length * f))];
    const bClose = ballistic.filter((v) => v <= CLOSE_MAX).length;
    const bMed = ballistic.filter((v) => v > CLOSE_MAX && v <= MED_MAX).length;
    const bLong = ballistic.length - bClose - bMed;
    const bShare = (n) => n / ballistic.length;
    console.log(`     the same rays as BALLISTICS (world.raycast, stops at glass): median ${bpct(0.5).toFixed(1)} m`
      + ` · p90 ${bpct(0.9).toFixed(1)} · max ${ballistic[ballistic.length - 1].toFixed(1)}`
      + ` · close ${(bShare(bClose) * 100).toFixed(1)}% / medium ${(bShare(bMed) * 100).toFixed(1)}%`
      + ` / long ${(bShare(bLong) * 100).toFixed(1)}%`);
    console.log(`     ${throughGlass} of ${lens.length} rays (${(throughGlass / lens.length * 100).toFixed(2)}%) pass through`
      + ` at least one pane, adding ${glassMetres.toFixed(0)} m in total`
      + ` — the long band moves ${((share(long) - bShare(bLong)) * 100 >= 0 ? '+' : '')}`
      + `${((share(long) - bShare(bLong)) * 100).toFixed(2)} points on the transparent ray`);
  }
  if (escaped > 0) {
    note(`${label}: ${escaped} rays left the map without hitting anything — they are counted at the ${REACH} m reach`);
  }

  const bands = [['close', close], ['medium', med], ['long', long]];
  const missing = bands.filter(([, n]) => share(n) < REPRESENTED_MIN);
  if (missing.length === 0) {
    ok(`${label}: close, medium and long are all represented (each ≥ ${(REPRESENTED_MIN * 100).toFixed(0)}% of rays)`);
  } else {
    pendingEnvelope(`${label}: close, medium and long are all represented`,
      `${missing.map(([n, c]) => `${n} ${(share(c) * 100).toFixed(1)}%`).join(', ')} — under the ${(REPRESENTED_MIN * 100).toFixed(0)}% floor`);
  }

  const longest = lens[lens.length - 1];
  if (longest <= SIGHT_CEILING) ok(`${label}: the longest sightline is ${longest.toFixed(1)} m (§7.0 hard ceiling ${SIGHT_CEILING} m)`);
  else {
    const over = lens.filter((v) => v > SIGHT_CEILING).length;
    pendingEnvelope(`${label}: the longest sightline is at or under the §7.0 ${SIGHT_CEILING} m ceiling`,
      `${longest.toFixed(1)} m, and ${(share(over) * 100).toFixed(2)}% of rays exceed it`);
  }

  // ── the dual-site angle ────────────────────────────────────────────────────────────
  // `Array.isArray`, not truthiness: a manifest with no `objectives` key at all and one
  // with an empty list are different answers, and only the second is "this map declares no
  // sites". The first is a broken manifest and has to say so.
  if (!Array.isArray(manifest.objectives)) {
    bad(`${label}: the manifest exposes an objectives list`, 'manifest.objectives is not an array — the dual-site row cannot be evaluated');
    return;
  }
  const plants = manifest.objectives.filter((ob) => ob.kind === 'plant' && typeof ob.site === 'string' && ob.site !== '');
  const sites = [...new Set(plants.map((ob) => ob.site))].sort();
  /**
   * ABSENT is a schedule; a rotation map with no sites is a DEFECT.
   *
   * These two look identical from inside this function and are opposites. MERIDIAN is a
   * retained §9 fixture that declares no §3.3 objective volumes at all, so there is
   * genuinely nothing to measure and saying so is the honest answer. The Square is the
   * Bomb map this repository ships: if its plant volumes stop resolving, Bomb cannot be
   * played, and printing "nothing to measure" about it is the harness helping the defect
   * hide. `navtest.mjs` §7.1 already draws exactly this line with `IN_ROTATION`; this row
   * did not, so an in-rotation map that lost its sites exited 0 with the row unmeasured
   * even under `--strict`.
   *
   * Note this is a hard `bad`, not `pendingEnvelope`: a missing site is not a §7 envelope
   * number that [CX] is scheduled to tune, it is a manifest that no longer describes a
   * playable Bomb map.
   */
  if (sites.length < 2) {
    if (mapRotation().includes(manifest.mapId)) {
      bad(`${label}: a rotation map declares the two bomb sites the dual-site row measures`,
        `${sites.length} site${sites.length === 1 ? '' : 's'} resolved from ${manifest.objectives.length} objective volume(s)`
        + ' — §3.3 requires two plant volumes on a Bomb map, and without them this row measures nothing'
        + ' while still reporting success');
      return;
    }
    console.log(`  ABSENT   ${label}: declares ${sites.length} bomb site${sites.length === 1 ? '' : 's'},`
      + ' so "no single uncontested angle covering both sites" has nothing to measure.'
      + ` (not in rotation${sites.length === 0 ? '; map-data.md §9 fixture' : ''})`);
    return;
  }

  // Standable points inside each plant volume, from the graph — never the box centre, which
  // can sit inside a collider and would silently make the site invisible from everywhere.
  const targets = new Map();
  for (const site of sites) {
    // Non-empty by construction — `site` came out of `plants` — but asserted rather than
    // assumed, because `[].some()` is `false` and would report the site as unseeable from
    // anywhere, which reads as a very strong pass on the row below.
    const boxes = plants.filter((ob) => ob.site === site).map((ob) => ob.box);
    if (boxes.length === 0) { targets.set(site, []); continue; }
    const inside = eyes.filter((e) => boxes.some((b) => e.x >= b.min.x && e.x <= b.max.x
      && e.z >= b.min.z && e.z <= b.max.z
      && e.y - EYE >= b.min.y - 0.35 && e.y - EYE <= b.max.y));
    targets.set(site, inside);
  }
  const emptySite = sites.filter((s) => targets.get(s).length === 0);
  if (emptySite.length > 0) {
    bad(`${label}: every plant volume contains standable ground to be seen from`,
      `${emptySite.join(', ')} contains no walkable reachable nav node — §3.3 requires standing-clear space, and a coverage test against an empty target set passes vacuously`);
    return;
  }

  /** Nearest visible point of `site` from `e`, within the §7.0 ceiling, or null. */
  const coverDir = (e, site) => {
    let best = null, bestD = Infinity;
    for (const t of targets.get(site)) {
      const dist = e.distanceTo(t);
      if (dist > SIGHT_CEILING || dist >= bestD) continue;
      if (!world.losClear(e, t)) continue;
      bestD = dist; best = t;
    }
    return best === null ? null : { dir: best.clone().sub(e).normalize(), dist: bestD };
  };

  const dual = [];
  for (const e of eyes) {
    const a = coverDir(e, sites[0]);
    if (a === null) continue;
    const b = coverDir(e, sites[1]);
    if (b === null) continue;
    dual.push({ e, a: a.dist, b: b.dist, sep: Math.acos(Math.min(1, Math.max(-1, a.dir.dot(b.dir)))) * 180 / Math.PI });
  }

  // The exposure reference set: a fixed-size, evenly strided sample of the playspace, so
  // the fraction means the same thing on both maps and does not drift with node count.
  const REF = 800;
  const stride = Math.max(1, Math.floor(eyes.length / REF));
  const ref = eyes.filter((_, i) => i % stride === 0);
  const exposure = (e) => {
    let seen = 0;
    for (const r of ref) {
      if (r === e) continue;
      if (world.losClear(e, r)) seen++;
    }
    return seen / ref.length;
  };

  const uncontested = [];
  let leastExposed = Infinity;
  for (const cand of dual) {
    const x = exposure(cand.e);
    if (x < leastExposed) leastExposed = x;
    if (x <= EXPOSURE_MAX) uncontested.push({ ...cand, exposure: x });
  }
  uncontested.sort((p, q) => p.exposure - q.exposure);

  const seps = dual.map((c) => c.sep).sort((p, q) => p - q);
  console.log(`     dual-site angles: ${dual.length} of ${eyes.length} standing positions see both ${sites[0]} and ${sites[1]}`
    + ` inside ${SIGHT_CEILING} m`
    + (dual.length === 0 ? '' : ` (they are ${seps[0].toFixed(0)}–${seps[seps.length - 1].toFixed(0)}° apart; one screen at ${HFOV.toFixed(0)}°)`)
    + ` · ${uncontested.length} of those are exposed to ≤ ${(EXPOSURE_MAX * 100).toFixed(0)}% of the playspace (${ref.length} reference points)`);
  // How hard the row worked, printed rather than assumed. A pass with no dual-site
  // candidates at all is a pass in which EXPOSURE_MAX was never evaluated once — true and
  // fine, but it has to be legible as such, because it is the shape that would also be
  // produced by a coverage test that had quietly stopped finding anything.
  if (dual.length === 0) {
    note(`${label}: no position sees both sites, so the ${(EXPOSURE_MAX * 100).toFixed(0)}% exposure threshold was not evaluated`
      + ' — this row passed without testing its threshold');
  } else {
    console.log(`     the exposure threshold was evaluated ${dual.length} time${dual.length === 1 ? '' : 's'};`
      + ` the least exposed dual-site position sees ${(leastExposed * 100).toFixed(1)}% of the playspace`
      + ` (threshold ${(EXPOSURE_MAX * 100).toFixed(0)}%)`);
  }
  if (uncontested.length === 0) {
    ok(`${label}: no single uncontested angle covers both sites`);
  } else {
    pendingEnvelope(`${label}: no single uncontested angle covers both sites`,
      `${uncontested.length} position${uncontested.length === 1 ? '' : 's'}, worst at `
      + uncontested.slice(0, 3).map((u) => `(${u.e.x.toFixed(1)}, ${(u.e.y - EYE).toFixed(2)}, ${u.e.z.toFixed(1)}) exposure ${(u.exposure * 100).toFixed(1)}%`).join(' · '));
  }
}

if (!SPAWN_ONLY) {
  sightlines('the-square', w, nav, w.manifest);

  // §9 keeps MERIDIAN as a fixture, and the contract's sightline row is a property of a
  // map rather than of the rotation, so the fixture is measured too — it is the only
  // comparison baseline this repository has for what these numbers look like on geometry
  // that was not authored against this envelope.
  {
    const mg = new Game({ headless: true });
    await mg.initHeadless({ presenter: new NullPresenter(), mapId: 'meridian' });
    if (GEOM_DEGRADES.has(DEGRADE)) degradeGeometry(mg, 'meridian');
    sightlines('meridian (fixture)', mg.world, mg.nav, mg.world.manifest);
  }
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

// `--geom-only` stops here. The spawn section below plays 33 headless matches and takes
// most of this harness's runtime; when the question is a sightline number, paying for it
// only makes the evidence harder to read.
if (GEOM_ONLY) {
  console.log(failures ? `\n${failures} FAILED` : '\ngeometry report complete');
  process.exit(failures ? 1 : 0);
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
} else if (GEOM_DEGRADES.has(DEGRADE)) {
  // Already applied to the geometry above, before a single ray was cast. Named here so the
  // dispatcher's unknown-mode failure below still catches a typo.
  note(`the '${DEGRADE}' degradation applies to the geometry sections, not to the spawn scorer`);
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
