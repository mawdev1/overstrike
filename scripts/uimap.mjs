import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';
import { World } from '../src/world/world.js';
import {
  MAP_ID, MAP_VERSION, MAP_MANIFEST, COMPETITIVE_BOUNDARY, buildLevel,
  COMMERCIAL_ANCHORS, MERIDIAN_FIXTURE, squareManifest,
} from '../src/world/level.js';

let checks = 0;
const failures = [];
const check = (condition, message) => { checks++; if (!condition) failures.push(message); };
const unique = (items) => new Set(items).size === items.length;
const finiteVec = (value) => value && ['x', 'y', 'z'].every((key) => Number.isFinite(value[key]));
const validBox = (box) => finiteVec(box?.min) && finiteVec(box?.max)
  && ['x', 'y', 'z'].every((key) => box.min[key] <= box.max[key]);
const contains = (box, x, y, z) => x >= box.min.x && x <= box.max.x
  && y >= box.min.y && y <= box.max.y && z >= box.min.z && z <= box.max.z;

function manifestProblems(manifest, boundary = COMPETITIVE_BOUNDARY, anchors = COMMERCIAL_ANCHORS) {
  const out = [];
  if (!validBox(manifest?.bounds)) out.push('bounds');
  const spawns = Array.isArray(manifest?.spawns) ? manifest.spawns : [];
  if (!unique(spawns.map((spawn) => spawn.id))) out.push('spawn-ids');
  for (const team of [0, 1]) {
    const tdm = spawns.filter((spawn) => spawn.team === team && spawn.modes?.includes('tdm'));
    if (tdm.length < 8) out.push(`tdm-spawns-${team}`);
    if (new Set(tdm.map((spawn) => spawn.group)).size < 3) out.push(`tdm-groups-${team}`);
    const bombGroups = new Map();
    for (const spawn of spawns.filter((item) => item.team === team && item.modes?.includes('bomb'))) {
      const list = bombGroups.get(spawn.group) || [];
      list.push(spawn);
      bombGroups.set(spawn.group, list);
    }
    if (![...bombGroups.values()].some((group) => group.length >= 5)) out.push(`bomb-group-${team}`);
  }
  if (!unique((manifest.objectives || []).map((objective) => objective.id))) out.push('objective-ids');
  for (const site of ['A', 'B']) {
    const objective = (manifest.objectives || []).find((item) => item.site === site && item.kind === 'plant');
    if (!objective || objective.id !== `site-${site}` || !validBox(objective.box) || !objective.requiresGround) {
      out.push(`site-${site}`);
    }
  }
  if (!unique((manifest.callouts || []).map((callout) => callout.id))) out.push('callout-ids');
  for (let x = -42; x <= 42; x += 3) {
    for (let z = -42; z <= 42; z += 3) {
      const candidates = (manifest.callouts || []).filter((callout) => contains(callout.box, x, 0, z));
      if (candidates.length === 0) out.push(`callout-gap:${x},${z}`);
      const priorities = candidates.map((callout) => callout.priority);
      const max = Math.max(...priorities);
      if (priorities.filter((priority) => priority === max).length > 1) out.push(`callout-tie:${x},${z}`);
    }
  }
  if (!Array.isArray(boundary) || boundary.length !== 4 || boundary.some((box) => !validBox(box))) out.push('boundary');
  const budgets = manifest.budgets || {};
  if (budgets.profileId !== 'ref-integrated-1080p' || budgets.drawCalls > 140
    || budgets.triangles > 300000 || budgets.materials > 48
    || budgets.lights > 6 || budgets.colliders > 1200) out.push('budgets');
  const anchorIds = (anchors || []).map((anchor) => anchor.id);
  for (const id of ['sponsor.event.plaza-east', 'sponsor.rooftop.transit',
    'sponsor.billboard.market-north', 'storefront.market.01', 'storefront.civic.01']) {
    if (!anchorIds.includes(id)) out.push(`anchor:${id}`);
  }
  if (!unique(anchorIds)) out.push('anchor-ids');
  if ((anchors || []).some((anchor) => !finiteVec(anchor.position) || !finiteVec(anchor.maxSize)
    || !Array.isArray(anchor.visibleFrom) || !Number.isFinite(anchor.emissiveMax)
    || 'creative' in anchor || 'campaign' in anchor || 'url' in anchor)) out.push('anchor-shape');
  return [...new Set(out)];
}

check(MAP_ID === 'the-square', 'canonical map id');
check(/^\d+\.\d+\.\d+$/.test(MAP_VERSION), 'map version is release-shaped');
check(MAP_MANIFEST.bounds.max.x - MAP_MANIFEST.bounds.min.x === 88, '88 m width');
check(MAP_MANIFEST.bounds.max.z - MAP_MANIFEST.bounds.min.z === 88, '88 m depth');
check(MAP_MANIFEST.spawns.length === 16, 'sixteen stable competitive spawns');
check(MAP_MANIFEST.objectives.length === 2, 'two Bomb plant volumes');
check(MAP_MANIFEST.callouts.length >= 12, 'district has a useful callout vocabulary');
check(MAP_MANIFEST.navHints.links.length >= 4, 'all authored vertical routes are declared');
check(COMPETITIVE_BOUNDARY !== MAP_MANIFEST.navHints.blocked, 'boundary and nav projections are separate layers');
check(MERIDIAN_FIXTURE.MAP_ID === 'meridian' && typeof MERIDIAN_FIXTURE.buildLevel === 'function',
  'MERIDIAN remains an explicit fixture rather than a renamed Square');
assert.deepEqual(manifestProblems(MAP_MANIFEST), []);
checks++;

// A guard that cannot fail is decoration. Exercise three independent defect classes.
const duplicateSpawn = { ...MAP_MANIFEST, spawns: [...MAP_MANIFEST.spawns, MAP_MANIFEST.spawns[0]] };
check(manifestProblems(duplicateSpawn).includes('spawn-ids'), 'duplicate spawn mutation is rejected');
const noCallouts = { ...MAP_MANIFEST, callouts: [] };
check(manifestProblems(noCallouts).some((problem) => problem.startsWith('callout-gap:')),
  'callout coverage mutation is rejected');
const excessiveBudget = { ...MAP_MANIFEST, budgets: { ...MAP_MANIFEST.budgets, drawCalls: 141 } };
check(manifestProblems(excessiveBudget).includes('budgets'), 'budget mutation is rejected');

// The legacy mapbalance report predates The Square and still names MERIDIAN landmarks.
// Keep the frozen P0.3 envelope load-bearing here as well: real shipping World/NavGrid,
// exhaustive A* budget, manifest-projected spawns/sites, and a denser ray lattice than the
// legacy report uses. These assertions are about authored geometry, not declared numbers.
const game = new Game({ headless: true });
await game.initHeadless({ presenter: new NullPresenter() });
const world = game.world;
const boundaryFreeWorld = new World(game);
buildLevel(game, boundaryFreeWorld, { competitiveBoundary: false });
check(!boundaryFreeWorld.boxes.some((box) => box.surface === 'boundary'),
  'competitive boundary can be omitted without changing the architectural producer');
const boundaryFreeManifest = squareManifest({ competitiveBoundary: false });
check(boundaryFreeWorld.manifest?.navHints?.blocked === boundaryFreeManifest.navHints.blocked
  && COMPETITIVE_BOUNDARY.every((box) => !boundaryFreeManifest.navHints.blocked.includes(box))
  && COMPETITIVE_BOUNDARY.every((box) => MAP_MANIFEST.navHints.blocked.includes(box)),
  'boundary-free projection removes the same layer from navigation without cloning authority');
check(world.boxes.filter((box) => box.surface === 'boundary').length === COMPETITIVE_BOUNDARY.length
  && world.boxes.length - boundaryFreeWorld.boxes.length === COMPETITIVE_BOUNDARY.length,
  'boundary-free build removes exactly the complete declared boundary layer');
boundaryFreeWorld.dispose();
const nav = game.nav;
nav.nodeBudget = 100_000;
nav.nodeBudgetMulti = 100_000;
const route = [];
const WALK_MPS = 4.6;

function routeDistance(from, to) {
  route.length = 0;
  const count = nav.findPath(from, to, route);
  if (count === 0 || route[count - 1].distanceTo(to) > 1) return Infinity;
  let distance = 0;
  for (let i = 1; i < count; i++) distance += route[i].distanceTo(route[i - 1]);
  return distance;
}

const centreOf = (box) => new THREE.Vector3(
  (box.min.x + box.max.x) / 2,
  box.min.y + 0.2,
  (box.min.z + box.max.z) / 2,
);
const sites = world.manifest.objectives.map((objective) => centreOf(objective.box));
const alpha = world.manifest.spawns.filter((spawn) => spawn.group === 'alpha-main');
const bravo = world.manifest.spawns.filter((spawn) => spawn.group === 'bravo-main');
const averageNearest = (starts, targets) => starts.reduce((sum, start) => (
  sum + Math.min(...targets.map((target) => routeDistance(start.position, target)))
), 0) / starts.length;
const within = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const relativeGap = (a, b) => Math.abs(a - b) / Math.max(a, b);

const alphaContactSec = averageNearest(alpha, bravo.map((spawn) => spawn.position)) / 2 / WALK_MPS;
const bravoContactSec = averageNearest(bravo, alpha.map((spawn) => spawn.position)) / 2 / WALK_MPS;
check(within(alphaContactSec, 9, 14) && within(bravoContactSec, 9, 14),
  `protected-spawn first contact is 9–14 s (${alphaContactSec.toFixed(2)}/${bravoContactSec.toFixed(2)})`);
check(relativeGap(alphaContactSec, bravoContactSec) <= 0.15,
  'protected-spawn first-contact timing is within 15% by side');

const spawnGroups = new Map();
for (const spawn of world.manifest.spawns) {
  const list = spawnGroups.get(spawn.group) || [];
  list.push(spawn);
  spawnGroups.set(spawn.group, list);
}
for (const [group, starts] of spawnGroups) {
  const team = starts[0].team;
  const opponents = world.manifest.spawns.filter((spawn) => spawn.team !== team);
  const contactSec = averageNearest(starts, opponents.map((spawn) => spawn.position)) / 2 / WALK_MPS;
  check(within(contactSec, 9, 14), `${group} first contact is 9–14 s (${contactSec.toFixed(2)})`);
}

const alphaSiteSec = averageNearest(alpha, sites) / WALK_MPS;
const bravoSiteSec = averageNearest(bravo, sites) / WALK_MPS;
check(within(alphaSiteSec, 12, 16) && within(bravoSiteSec, 12, 16),
  `protected spawn to nearest site is 12–16 s (${alphaSiteSec.toFixed(2)}/${bravoSiteSec.toFixed(2)})`);
check(relativeGap(alphaSiteSec, bravoSiteSec) <= 0.15,
  'nearest-site timing is within 15% by side');

const protectedSiteTimes = { alpha: [], bravo: [] };
for (const [side, starts] of [['alpha', alpha], ['bravo', bravo]]) {
  for (let index = 0; index < sites.length; index++) {
    const seconds = starts.reduce((sum, spawn) => sum + routeDistance(spawn.position, sites[index]), 0)
      / starts.length / WALK_MPS;
    protectedSiteTimes[side].push(seconds);
    check(within(seconds, 12, 16), `${side} protected spawn to site ${index === 0 ? 'A' : 'B'} is 12–16 s (${seconds.toFixed(2)})`);
  }
  check(relativeGap(protectedSiteTimes[side][0], protectedSiteTimes[side][1]) <= 0.15,
    `${side} protected spawn reaches both sites within 15%`);
}

const rotationAB = routeDistance(sites[0], sites[1]) / WALK_MPS;
const rotationBA = routeDistance(sites[1], sites[0]) / WALK_MPS;
check(within(rotationAB, 16, 22) && within(rotationBA, 16, 22),
  `site rotation is 16–22 s both directions (${rotationAB.toFixed(2)}/${rotationBA.toFixed(2)})`);
check(relativeGap(rotationAB, rotationBA) <= 0.15, 'site rotation directions are within 15%');

for (const objective of world.manifest.objectives) {
  let standing = 0;
  for (let node = 0; node < nav.nodeCount; node++) {
    if (!(nav.flags[node] & 1) || !nav.reachable[node]) continue;
    const col = Math.floor(node / nav.maxLayers);
    const x = nav.cellCenterX(col);
    const z = nav.cellCenterZ(col);
    const y = nav.floorY[node];
    if (contains(objective.box, x, y, z)) standing++;
  }
  check(standing >= 8, `${objective.id} has at least eight reachable standing samples`);
  const center = centreOf(objective.box).setY(1.2);
  let visibleApproaches = 0;
  for (const [dx, dz] of [[-8, 0], [8, 0], [0, -8], [0, 8], [-6, -6], [6, 6]]) {
    const approach = new THREE.Vector3(center.x + dx, 1.62, center.z + dz);
    if (!world.pointInSolid(approach.x, approach.y, approach.z) && world.losClear(approach, center)) {
      visibleApproaches++;
    }
  }
  check(visibleApproaches >= 2, `${objective.id} is visible from at least two distinct approach directions`);
}

const origin = new THREE.Vector3();
const direction = new THREE.Vector3();
let longestSightline = 0;
for (let x = -40; x <= 40; x += 1.5) {
  for (let z = -40; z <= 40; z += 1.5) {
    if (world.pointInSolid(x, 1.62, z)) continue;
    for (let i = 0; i < 64; i++) {
      const angle = (i / 64) * Math.PI * 2;
      origin.set(x, 1.62, z);
      direction.set(Math.cos(angle), 0, Math.sin(angle));
      const hit = world.raycast(origin, direction, 90);
      longestSightline = Math.max(longestSightline, hit?.distance ?? 90);
    }
  }
}
check(longestSightline <= 48.0001,
  `dense eye-height probe stays under 48 m (${longestSightline.toFixed(2)} m)`);

const reachableLevels = new Set();
for (let node = 0; node < nav.nodeCount; node++) {
  if (!(nav.flags[node] & 1) || !nav.reachable[node]) continue;
  const y = nav.floorY[node];
  if (y < 1) reachableLevels.add('ground');
  else if (y >= 3.5 && y < 6) reachableLevels.add('upper');
  else if (y >= 7.5) reachableLevels.add('signal');
}
check(reachableLevels.size === 3, 'all three bounded vertical levels are reachable');
game.dispose?.();

if (failures.length) {
  console.error(`✗ The Square producer acceptance failed (${failures.length}/${checks}).`);
  for (const failure of failures) console.error(`  - ${failure}`);
} else {
  console.log(`✓ The Square producer acceptance passed (${checks} assertions).`);
}
// The full Game composition owns page-lifetime timers that are intentionally active in a
// browser. All assertions and disposal are complete here, so terminate the one-shot harness
// instead of making CI wait on those unrelated timers.
process.exit(failures.length ? 1 : 0);
