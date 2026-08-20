/**
 * Vertical playspace probe — map-data.md §6: "every intended upper floor and rooftop
 * reachable; no unreachable playspace."
 *
 * Two halves, and the split matters:
 *
 *   1. REACHABILITY, asserted. Taken from the nav graph, which is deterministic: for each
 *      upper region the map NAMES, how many of its walkable nodes a bot starting from a
 *      spawn can actually get to. This is the property the contract requires, and it
 *      either holds or it does not.
 *
 *   2. OCCUPANCY, reported. How much time bots actually spend up there over a real match.
 *      Stochastic, and a threshold on it would fail on an unlucky seed — so it is printed
 *      as a design signal, not asserted.
 *
 * The regions are read from the manifest's §3.4 callouts rather than from a hardcoded
 * tour of one particular map: a region someone bothered to NAME is a place players are
 * meant to be able to reach, and a probe with the map's geography typed into it goes
 * stale the first time the map moves. This repository has already shipped a probe that
 * measured a terrace while standing on its own parapet.
 *
 * node scripts/vertprobe.mjs [--ticks=24000] [--bots=8] [--seeds=1,2,3] [--map=<id>]
 */
import * as THREE from 'three';
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';
import { selectMap, getMapEntry, listMaps } from '../src/world/world.js';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const TICKS = Number(arg('ticks', 24000));
const BOTS = Number(arg('bots', 8));
const SEEDS = String(arg('seeds', '12345,777,20260819')).split(',').map(Number);
const SAMPLE = 15;

const MAP_ID = arg('map', null);
if (MAP_ID !== null) {
  if (getMapEntry(MAP_ID) === null) {
    console.error(`vertprobe: no registered map '${MAP_ID}'. Registered: ${listMaps().map((m) => m.id).join(', ')}`);
    process.exit(2);
  }
  selectMap(MAP_ID);
}

const F_WALKABLE = 1;
let failures = 0;
const ok = (n, d = '') => console.log(`  ok   ${n}${d ? `  (${d})` : ''}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };

/**
 * The upper regions to probe, derived from the map.
 *
 * A §3.4 callout whose box starts at or above `MIN_UPPER` is an upper floor by the
 * producer's own declaration. When a map declares no callouts (the retained MERIDIAN
 * fixture does not), fall back to the nav graph's own height bands so the probe still
 * measures something real instead of quietly measuring nothing.
 */
const MIN_UPPER = 2.5;
function upperRegions(world, nav) {
  const named = world.manifest.callouts
    .filter((c) => c.box.min.y >= MIN_UPPER)
    .map((c) => ({
      name: c.name,
      test: (x, y, z) => x >= c.box.min.x && x <= c.box.max.x
        && z >= c.box.min.z && z <= c.box.max.z
        && y >= c.box.min.y - 0.05 && y <= c.box.max.y,
      at: new THREE.Vector3((c.box.min.x + c.box.max.x) / 2, (c.box.min.y + c.box.max.y) / 2,
        (c.box.min.z + c.box.max.z) / 2),
      ylo: c.box.min.y - 0.05,
      yhi: c.box.max.y,
      r: Math.max(c.box.max.x - c.box.min.x, c.box.max.z - c.box.min.z) / 2,
    }));
  if (named.length > 0) return { regions: named, declared: true, source: '§3.4 callouts' };

  // No declared regions. Height bands from the nav graph, REPORTED not asserted — see
  // the guard below for why.
  const bands = new Map();
  for (let node = 0; node < nav.nodeCount; node++) {
    if (!(nav.flags[node] & F_WALKABLE)) continue;
    const y = nav.floorY[node];
    if (y < MIN_UPPER) continue;
    const key = Math.round(y);
    bands.set(key, (bands.get(key) ?? 0) + 1);
  }
  const regions = [...bands.entries()]
    .filter(([, n]) => n >= 30)
    .sort((a, b) => a[0] - b[0])
    .map(([y]) => ({
      name: `level y≈${y} m`,
      test: (x, ny) => ny >= y - 0.6 && ny <= y + 0.6,
      at: new THREE.Vector3(0, y, 0),
      ylo: y - 0.6, yhi: y + 0.6, r: Infinity,
    }));
  return { regions, declared: false, source: 'nav height bands — the map declares no §3.4 callouts' };
}

// ── 1. reachability, from the nav graph (asserted) ───────────────────────────────────

const probe = new Game({ headless: true });
await probe.initHeadless({ presenter: new NullPresenter() });
const { regions: ZONES, declared: ZONES_DECLARED, source: ZONE_SOURCE } = upperRegions(probe.world, probe.nav);
const IN_ROTATION = (await import('../src/world/world.js')).mapRotation().includes(probe.world.manifest.mapId);

console.log(`\nupper playspace reachability — map '${probe.world.manifest.mapId}' `
  + `v${probe.world.manifest.mapVersion}, regions from ${ZONE_SOURCE}`);
if (ZONES.length === 0) {
  bad('the map has upper playspace to probe',
    `no walkable surface and no named region above ${MIN_UPPER} m — either the map is flat `
    + '(it should not be: §7.0 requires 3 usable levels) or the bake lost every upper floor');
} else if (!ZONES_DECLARED) {
  // Height bands are surfaces, not INTENT. A map's skyline blocks, parapet caps and
  // decorative ledges are walkable surfaces nobody is meant to reach — MERIDIAN has 983
  // of them at y=15 — so asserting "every height band must be reachable" fails on
  // deliberate scenery and teaches everyone to ignore the harness. What makes a surface
  // intended playspace is that the producer NAMED it (§3.4), which is exactly why the
  // contract requires callouts. So: with no callouts there is nothing to prove here.
  const nav = probe.nav;
  for (const Z of ZONES) {
    let total = 0, reach = 0;
    for (let node = 0; node < nav.nodeCount; node++) {
      if (!(nav.flags[node] & F_WALKABLE)) continue;
      const col = (node / nav.maxLayers) | 0;
      if (!Z.test(nav.cellCenterX(col), nav.floorY[node], nav.cellCenterZ(col))) continue;
      total++;
      if (nav.reachable[node]) reach++;
    }
    Z.navTotal = total; Z.navReach = reach;
    console.log(`  note   ${Z.name}: ${reach}/${total} walkable nodes reachable`);
  }
  if (IN_ROTATION) {
    bad('the map names its upper regions',
      'a map in rotation declares no §3.4 callouts, so there is no declaration of which '
      + 'upper surfaces are playspace and vertprobe cannot prove anything about them');
  } else {
    console.log('  note   fixture map declares no §3.4 callouts — reachability reported, not asserted');
  }
} else {
  const nav = probe.nav;
  for (const Z of ZONES) {
    let total = 0, reach = 0;
    for (let node = 0; node < nav.nodeCount; node++) {
      if (!(nav.flags[node] & F_WALKABLE)) continue;
      const col = (node / nav.maxLayers) | 0;
      const x = nav.cellCenterX(col), z = nav.cellCenterZ(col), y = nav.floorY[node];
      if (!Z.test(x, y, z)) continue;
      total++;
      if (nav.reachable[node]) reach++;
    }
    Z.navTotal = total;
    Z.navReach = reach;
    if (total === 0) {
      bad(`'${Z.name}' has walkable surface`, 'the named region contains no walkable node at all');
    } else if (reach === 0) {
      bad(`'${Z.name}' is reachable on foot`,
        `all ${total} walkable nodes there are unreachable from every spawn — this is unreachable playspace`);
    } else if (reach < total * 0.5) {
      bad(`'${Z.name}' is reachable on foot`,
        `only ${reach} of ${total} walkable nodes (${(100 * reach / total).toFixed(1)}%) are reachable`);
    } else {
      ok(`'${Z.name}' is reachable on foot`, `${reach}/${total} nodes, ${(100 * reach / total).toFixed(1)}%`);
    }
  }
}
probe.dispose?.();

// ── 2. occupancy, from real matches (reported) ───────────────────────────────────────

const results = [];
for (const SEED of SEEDS) {
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter() });
  game.startMatch({ mode: 'tdm', botCount: BOTS, difficulty: 'regular', seed: SEED });
  game.match.phase = 'live';
  game.match.countdown = 0;

  const zoneHits = new Array(ZONES.length).fill(0);
  const yhist = new Array(24).fill(0);
  let samples = 0;
  let above3 = 0, above1 = 0;
  const DT = 1 / 120;
  const t0 = performance.now();
  for (let i = 0; i < TICKS; i++) {
    game._fixedUpdate(DT);
    if (i % SAMPLE !== 0) continue;
    for (const b of game.bots.bots) {
      if (!b.alive) continue;
      samples++;
      const y = b.position.y;
      const bin = Math.min(yhist.length - 1, Math.max(0, Math.round(y)));
      yhist[bin]++;
      if (y > 3) above3++;
      if (y > 1) above1++;
      for (let z = 0; z < ZONES.length; z++) {
        if (ZONES[z].test(b.position.x, y, b.position.z)) zoneHits[z]++;
      }
    }
  }
  const ms = performance.now() - t0;
  results.push({ SEED, zoneHits, yhist, samples, above3, above1,
    kills: game.match.scores.reduce((a, b) => a + b, 0), ms });
}

const pc = (a, b) => b ? (100 * a / b).toFixed(2) + '%' : 'n/a';
console.log(`\nvertical occupancy — ${BOTS} bots, ${TICKS} ticks (${(TICKS / 120) | 0}s), seeds ${SEEDS.join(',')}`);
for (let z = 0; z < ZONES.length; z++) {
  const row = results.map((r) => pc(r.zoneHits[z], r.samples).padStart(8)).join(' ');
  const nav = `${ZONES[z].navReach}/${ZONES[z].navTotal} reachable`;
  console.log(`  ${ZONES[z].name.padEnd(22)}${row}   ${nav}`);
}
console.log(`  ${'ANY y>3m'.padEnd(22)}${results.map((r) => pc(r.above3, r.samples).padStart(8)).join(' ')}`);
console.log(`  ${'ANY y>1m'.padEnd(22)}${results.map((r) => pc(r.above1, r.samples).padStart(8)).join(' ')}`);
for (const r of results) {
  const bins = r.yhist.map((v, i) => (v ? `${i}m ${pc(v, r.samples)}` : null)).filter(Boolean);
  console.log(`  seed ${r.SEED}: ${bins.join(' · ')}`);
  console.log(`    kills ${r.kills}, samples ${r.samples}, ${Math.round(r.ms)} ms`);
}
console.log(failures
  ? `\n${failures} FAILED — there is playspace nobody can reach`
  : '\nevery named upper region is reachable on foot');
process.exit(failures ? 1 : 0);
