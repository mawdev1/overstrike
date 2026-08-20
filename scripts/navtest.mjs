/**
 * navtest — the nav bake, and the map-data.md §3.5 hint path that feeds it.
 *
 * Required by `docs/contracts/map-data.md` §6 and Build Plan §3.3. Three parts:
 *
 *   A. THE MANIFEST IS THERE AND IS CONSUMED. §3's required exports, and what the
 *      producer still owes, reported as a list rather than assumed.
 *
 *   B. THE BAKE IS HONEST about the real map. Every walkable node stands on a real
 *      collider top or on a surface the manifest explicitly force-walked; nothing floats;
 *      nothing is buried; the reachable set covers every spawn, every objective volume
 *      and every elevated callout region.
 *
 *   C. THE §3.5 HINTS ACTUALLY MOVE THE GRAPH. Hint-reading code that is never exercised
 *      is code nobody can tell is broken, so each hint kind is driven with a fixture
 *      authored against the REAL geometry of the REAL world and the bake is re-run
 *      through the ordinary path. The world, the colliders and the NavGrid are the
 *      shipping ones; only the extra hint is authored, which is exactly the input Codex
 *      supplies.
 *
 * NOTHING here is keyed to a particular map's geography. Zones come from the manifest and
 * fixtures are found by probing the bake, so this harness follows the map instead of
 * having to be rewritten every time the geometry moves.
 *
 * This repository has shipped a bake with every upper floor unreachable and 46% of its
 * nodes underground, and a probe that stood on a parapet to measure the terrace below.
 * Every assertion below is a measured number against a threshold.
 *
 *   node scripts/navtest.mjs [--verbose] [--map=<id>]
 *
 * `--map` selects any REGISTERED map, in or out of rotation — which is how the retained
 * MERIDIAN fixture (map-data.md §9) stays testable after it leaves rotation, and how a
 * regression can be pinned against frozen geometry while the live map is being authored.
 */
import * as THREE from 'three';
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';
import { manifestGaps, mapRotation, listMaps, selectMap, getMapEntry } from '../src/world/world.js';

const VERBOSE = process.argv.includes('--verbose');
const MAP_ARG = process.argv.slice(2).find((a) => a.startsWith('--map='));
if (MAP_ARG) {
  const id = MAP_ARG.slice('--map='.length);
  if (getMapEntry(id) === null) {
    console.error(`navtest: no registered map '${id}'. Registered: ${listMaps().map((m) => m.id).join(', ')}`);
    process.exit(2);
  }
  selectMap(id);
}

let failures = 0;
const ok = (n, d = '') => console.log(`  ok   ${n}${d ? `  (${d})` : ''}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const fmt = (v) => (typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v));
const atLeast = (name, got, min, unit = '') => {
  if (got >= min) ok(name, `${fmt(got)}${unit} >= ${fmt(min)}${unit}`);
  else bad(name, `${fmt(got)}${unit} < required ${fmt(min)}${unit}`);
};
const atMost = (name, got, max, unit = '') => {
  if (got <= max) ok(name, `${fmt(got)}${unit} <= ${fmt(max)}${unit}`);
  else bad(name, `${fmt(got)}${unit} > allowed ${fmt(max)}${unit}`);
};
const exactly = (name, got, want) => {
  if (got === want) ok(name, `${fmt(got)}`);
  else bad(name, `got ${fmt(got)}, expected ${fmt(want)}`);
};

const F_WALKABLE = 1;
const F_NEARCOVER = 2;

const game = new Game({ headless: true });
await game.initHeadless({ presenter: new NullPresenter() });
const world = game.world;
const nav = game.nav;
const MAXL = nav.maxLayers;
const manifest = world.manifest;

// ════════════════════════════════════════════════════ A. the §3 contract surface

console.log(`\nmap '${manifest.mapId}' v${manifest.mapVersion} — manifest ${manifest.source}`);
console.log(`  rotation: ${mapRotation().join(', ')} · registered: ${listMaps().map((m) => m.id).join(', ')}`);
/**
 * §3 conformance is required of a map IN ROTATION. A map registered only as a fixture
 * (map-data.md §9 keeps MERIDIAN as one) is a frozen comparison target, not a competitive
 * map, and holding it to the Bomb-era contract would either fail the suite forever or
 * force the contract down to what the fixture happens to have. So: asserted for rotation
 * maps, reported for fixtures — and the fixture still gets every bake assertion below,
 * which is what it is retained for.
 */
const IN_ROTATION = mapRotation().includes(manifest.mapId);
const rAtLeast = (name, got, min, unit = '') => (IN_ROTATION
  ? atLeast(name, got, min, unit)
  : console.log(`  note (fixture) ${name}: ${fmt(got)}${unit} (rotation maps must reach ${fmt(min)}${unit})`));

{
  const gaps = manifestGaps(manifest);
  if (gaps.length === 0) ok('the producer declares every §3 export', 'nothing outstanding');
  else if (IN_ROTATION) bad('the producer declares every §3 export', `still owed: ${gaps.join(', ')}`);
  else console.log(`  note (fixture) undeclared §3 exports: ${gaps.join(', ')}`);

  // Each of these is read by a different consumer, and an empty one is not a map that
  // happens to be simple — it is a consumer that will fail at match time.
  rAtLeast('§3.2 spawn markers', manifest.spawns.length, 8);
  rAtLeast('§3.3 objective volumes', manifest.objectives.length, 2);
  rAtLeast('§3.4 callout regions', manifest.callouts.length, 6);
  atLeast('§3.6 collider budget', manifest.budgets.colliders, 1);
  atMost('colliders against the §3.6 budget', manifest.measured.colliders, manifest.budgets.colliders);

  // Ids are what evidence and analytics reference forever (§3.2, §3.3, §3.4).
  const ids = new Set();
  let dupes = 0, blank = 0;
  for (const rec of [...manifest.spawns, ...manifest.objectives, ...manifest.callouts]) {
    const id = rec.id;
    if (typeof id !== 'string' || id.length === 0) { blank++; continue; }
    if (ids.has(id)) dupes++;
    ids.add(id);
  }
  exactly('every spawn, objective and callout carries an id', blank, 0);
  exactly('no two of them share an id', dupes, 0);

  // §3.1: a box authored min > max is silently dropped by the spatial hash.
  let malformed = 0;
  for (const rec of [...manifest.objectives, ...manifest.callouts, ...manifest.boundary]) {
    if (rec.box === undefined ? rec.inverted : rec.box.inverted) malformed++;
  }
  exactly('no manifest volume is authored inverted', malformed, 0);

  // §3.2 minimums, per team.
  for (const team of [0, 1]) {
    const spawns = world.spawnsFor('tdm', team).filter((s) => s.team === team);
    const groups = new Set(spawns.map((s) => s.group));
    rAtLeast(`team ${team} TDM spawns`, spawns.length, 8);
    rAtLeast(`team ${team} TDM spawn groups`, groups.size, 3);
    const bomb = world.spawnsFor('bomb', team).filter((s) => s.team === team);
    const byGroup = new Map();
    for (const s of bomb) byGroup.set(s.group, (byGroup.get(s.group) ?? 0) + 1);
    const biggest = Math.max(0, ...byGroup.values());
    rAtLeast(`team ${team} has a protected Bomb group of >= 5`, biggest, 5);
  }

  // §3.4: every point a player can stand on resolves to exactly one region.
  let standables = 0, unnamed = 0;
  const unnamedAt = [];
  for (let node = 0; node < nav.nodeCount; node++) {
    if (!(nav.flags[node] & F_WALKABLE) || !nav.reachable[node]) continue;
    standables++;
    const col = (node / MAXL) | 0;
    const x = nav.cellCenterX(col), z = nav.cellCenterZ(col), y = nav.floorY[node];
    if (world.calloutAt(x, y + 0.1, z) === null) {
      unnamed++;
      if (unnamedAt.length < 5) unnamedAt.push(`(${x.toFixed(1)}, ${y.toFixed(2)}, ${z.toFixed(1)})`);
    }
  }
  if (unnamed === 0) ok(`all ${standables} reachable standing positions resolve to a callout region`);
  else if (!IN_ROTATION) console.log(`  note (fixture) ${unnamed} of ${standables} standing positions have no callout name`);
  else bad('every reachable standing position has a callout name',
    `${unnamed} of ${standables} (${(100 * unnamed / standables).toFixed(2)}%) resolve to nothing: ${unnamedAt.join(' ')}`);
}

// ════════════════════════════════════════════════════ B. the bake against real geometry

/** Walkable nodes, and how many of them stand on something real. */
function auditNodes(g) {
  const boxes = world.boxes;
  const hinted = g.world.manifest === null ? [] : g.world.manifest.navHints.walkable;
  let walkable = 0, reachable = 0, linked = 0, cover = 0;
  let unsupported = 0, buried = 0, outOfBounds = 0, noHeadroom = 0, hintExplained = 0;
  const examples = [];
  const bmin = world.bounds.min, bmax = world.bounds.max;
  for (let node = 0; node < g.nodeCount; node++) {
    if (!(g.flags[node] & F_WALKABLE)) continue;
    walkable++;
    if (g.reachable[node]) reachable++;
    if (g.linkMask[node] !== 0 || g.hintLinks.has(node)) linked++;
    if (g.flags[node] & F_NEARCOVER) cover++;
    const col = (node / MAXL) | 0;
    const x = g.cellCenterX(col), z = g.cellCenterZ(col), y = g.floorY[node];
    if (y < bmin.y - 1e-3 || y > bmax.y + 1e-3) outOfBounds++;
    if (g.clearance[node] < 1.9 - 1e-3) noHeadroom++;
    let supported = false, inside = false;
    for (const b of boxes) {
      if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
      if (Math.abs(b.max.y - y) <= 0.01) supported = true;
      if (y > b.min.y + 0.02 && y < b.max.y - 0.02) inside = true;
    }
    if (!supported) {
      // A node with no collider under it is a phantom UNLESS the manifest explicitly
      // force-walked that volume — which is what §3.5 `walkable` is for.
      let explained = false;
      for (const hb of hinted) {
        if (x < hb.min.x || x > hb.max.x || z < hb.min.z || z > hb.max.z) continue;
        if (y < hb.min.y - 0.05 || y > hb.max.y + 0.05) continue;
        explained = true; break;
      }
      if (explained) hintExplained++;
      else {
        unsupported++;
        if (examples.length < 6) examples.push(`floating at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);
      }
    }
    if (inside) {
      buried++;
      if (examples.length < 6) examples.push(`inside solid at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`);
    }
  }
  return { walkable, reachable, linked, cover, unsupported, buried, outOfBounds, noHeadroom, hintExplained, examples };
}

const shipped = auditNodes(nav);
console.log(`\nnav bake — grid ${nav.cols}x${nav.rows} @ ${nav.cell} m, ${nav.nodeCount} slots`);
console.log(`  ${shipped.walkable} walkable · ${shipped.reachable} reachable · ${shipped.linked} linked · ${shipped.cover} near cover`);
console.log(`  hints: ${JSON.stringify(nav.hintStats)}`);

{
  const phantoms = shipped.unsupported + shipped.buried;
  if (phantoms === 0) {
    ok(`no phantom nodes among ${shipped.walkable} walkable`,
      `0 floating, 0 buried, ${shipped.hintExplained} standing on force-walkable hints`);
  } else {
    bad('every walkable node stands on a real collider top or a declared force-walkable volume',
      `${shipped.unsupported} floating + ${shipped.buried} buried = ${phantoms} of ${shipped.walkable} `
      + `(${(100 * phantoms / shipped.walkable).toFixed(2)}%)\n       ${shipped.examples.join('\n       ')}`);
  }
}
exactly('no walkable node sits outside world bounds', shipped.outOfBounds, 0);
exactly('every walkable node has the standing clearance it claims', shipped.noHeadroom, 0);
atLeast('reachable fraction of the walkable set', 100 * shipped.reachable / shipped.walkable, 70, '%');
atLeast('linked fraction of the walkable set', 100 * shipped.linked / shipped.walkable, 99, '%');
atLeast('nodes flagged near cover', 100 * shipped.cover / shipped.walkable, 5, '%');

// -- spawns are on the graph.
const spawnNodes = [];
{
  const orphans = [];
  for (const sp of manifest.spawns) {
    const node = nav.nodeAt(sp.position.x, sp.position.y + 0.2, sp.position.z);
    if (node < 0 || !(nav.flags[node] & F_WALKABLE)) { orphans.push(`${sp.id}: no walkable node`); continue; }
    if (!nav.reachable[node]) { orphans.push(`${sp.id}: node not reachable`); continue; }
    const rise = nav.floorY[node] - sp.position.y;
    if (Math.abs(rise) > 0.6) {
      orphans.push(`${sp.id}: nearest walkable floor is ${Math.abs(rise).toFixed(2)} m `
        + `${rise > 0 ? 'ABOVE' : 'below'} the spawn — it is not standing on it`);
      continue;
    }
    spawnNodes.push({ id: sp.id, node, pos: sp.position });
  }
  exactly(`every one of ${manifest.spawns.length} spawns resolves to a reachable node`, orphans.length, 0);
  if (orphans.length) console.log(`       ${orphans.join('\n       ')}`);
}

// -- §3.2: "reachable from every objective volume by the nav graph". This is the
//    invariant Bomb rests on — a site nobody can walk to from a spawn is not a site.
{
  const path = [];
  const siteNodes = [];
  for (const obj of manifest.objectives) {
    let inside = 0, reach = 0, sample = -1;
    for (let node = 0; node < nav.nodeCount; node++) {
      if (!(nav.flags[node] & F_WALKABLE)) continue;
      const col = (node / MAXL) | 0;
      const x = nav.cellCenterX(col), z = nav.cellCenterZ(col), y = nav.floorY[node];
      if (x < obj.box.min.x || x > obj.box.max.x || z < obj.box.min.z || z > obj.box.max.z) continue;
      if (y < obj.box.min.y - 0.05 || y > obj.box.max.y) continue;
      inside++;
      if (nav.reachable[node]) { reach++; if (sample < 0) sample = node; }
    }
    atLeast(`${obj.id} contains reachable standing space`, reach, 8);
    if (VERBOSE) console.log(`       ${obj.id}: ${reach}/${inside} nodes reachable`);
    if (sample >= 0) siteNodes.push({ id: obj.id, node: sample });
  }

  // Every spawn group must be able to walk to every site.
  //
  // Asked as an EXHAUSTIVE forward BFS over the graph, not as `findPath`. `findPath` is
  // budgeted and returns a partial on a long route by design, so a budget exhaustion and
  // a genuinely severed site look identical through it — and this is the invariant Bomb
  // rests on, so it has to be the exact question.
  let checked = 0, unreachable = 0;
  const failed = [];
  const groups = new Map();
  for (const sp of spawnNodes) {
    const g = manifest.spawns.find((s) => s.id === sp.id).group;
    if (!groups.has(g)) groups.set(g, sp);
  }
  for (const [gname, sp] of groups) {
    const seen = floodFrom(sp.node);
    for (const site of siteNodes) {
      checked++;
      if (!seen[site.node]) { unreachable++; failed.push(`${gname} -> ${site.id}`); }
    }
  }
  if (unreachable === 0) ok(`all ${checked} spawn-group-to-objective pairs are connected`, 'exhaustive BFS');
  else bad('every spawn group can walk to every objective volume',
    `${unreachable} of ${checked} severed:\n       ${failed.slice(0, 6).join('\n       ')}`);

  // A* has to be able to work the same graph at bot range, or bots never arrive whatever
  // the BFS says. Measured as how much of the straight-line gap the route closes.
  let worst = 1, worstAt = null;
  for (const [gname, sp] of groups) {
    for (const site of siteNodes) {
      const out = new THREE.Vector3();
      nav.nodeCenter(site.node, out);
      const straight = Math.hypot(sp.pos.x - out.x, sp.pos.z - out.z);
      const n = nav.findPath(sp.pos, out, path);
      const end = n > 0 ? path[n - 1] : null;
      const gap = end === null ? Infinity : Math.hypot(end.x - out.x, end.z - out.z);
      const progress = gap === Infinity ? 0 : 1 - gap / straight;
      if (progress < worst) { worst = progress; worstAt = `${gname} -> ${site.id} (${straight.toFixed(0)} m, stopped ${gap.toFixed(1)} m short)`; }
    }
  }
  if (checked === 0) console.log('  note: no objective volumes to route to');
  else if (worst >= 0.70) ok('every spawn-group-to-objective route closes at least 70% of the gap', `worst ${(worst * 100).toFixed(1)}%`);
  else bad('every spawn-group-to-objective route closes most of the gap', `worst ${(worst * 100).toFixed(1)}% on ${worstAt}`);
}

// -- vertical playspace, taken from the manifest rather than from a hardcoded map tour.
//    A callout region whose box starts above head height is an upper floor by definition:
//    someone named it, so players are meant to be able to go there.
{
  const upper = manifest.callouts.filter((c) => c.box.min.y >= 2.0);
  if (upper.length === 0) {
    console.log('  note: the manifest names no region above 2 m — no upper playspace to check');
  }
  for (const region of upper) {
    let total = 0, reach = 0;
    for (let node = 0; node < nav.nodeCount; node++) {
      if (!(nav.flags[node] & F_WALKABLE)) continue;
      const y = nav.floorY[node];
      if (y < region.box.min.y - 0.05 || y > region.box.max.y) continue;
      const col = (node / MAXL) | 0;
      const x = nav.cellCenterX(col), z = nav.cellCenterZ(col);
      if (x < region.box.min.x || x > region.box.max.x || z < region.box.min.z || z > region.box.max.z) continue;
      total++;
      if (nav.reachable[node]) reach++;
    }
    if (total === 0) bad(`'${region.name}' has walkable surface in it`, 'the named region contains no walkable node at all');
    else if (reach >= Math.ceil(total * 0.5)) ok(`'${region.name}' is reachable on foot`, `${reach}/${total} nodes`);
    else bad(`'${region.name}' is reachable on foot`, `only ${reach} of ${total} walkable nodes there are reachable`);
  }
}

// -- unreachable playspace anywhere. A generous bake calls parapet caps walkable; the
//    manifest's `blocked` hints are how a producer says which ones are not playspace.
{
  const stranded = shipped.walkable - shipped.reachable;
  atMost('stranded walkable nodes as a share of the graph',
    100 * stranded / shipped.walkable, 30, '%');
}

// ════════════════════════════════════════════ C. the §3.5 hint path, on real geometry

console.log('\nmap-data.md §3.5 nav hints');

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const declared = {
  walkable: [...manifest.navHints.walkable],
  blocked: [...manifest.navHints.blocked],
  links: [...manifest.navHints.links],
  cover: [...manifest.navHints.cover],
};
/** Re-bake with the map's declared hints PLUS a fixture, through the ordinary path. */
const withExtra = (extra = {}) => {
  world.manifest.navHints = {
    walkable: [...declared.walkable, ...(extra.walkable ?? [])],
    blocked: [...declared.blocked, ...(extra.blocked ?? [])],
    links: [...declared.links, ...(extra.links ?? [])],
    cover: [...declared.cover, ...(extra.cover ?? [])],
  };
  nav.bake();
};
const withNone = () => {
  world.manifest.navHints = { walkable: [], blocked: [], links: [], cover: [] };
  nav.bake();
};
const restore = () => { world.manifest.navHints = { ...declared }; nav.bake(); };

// -- determinism. Without this the deltas below mean nothing.
{
  withExtra();
  const again = auditNodes(nav);
  exactly('re-baking the declared hints reproduces the walkable count', again.walkable, shipped.walkable);
  exactly('re-baking the declared hints reproduces the reachable count', again.reachable, shipped.reachable);
}

// -- the declared hints are load-bearing. If dropping every one of them changes nothing,
//    either the map does not need them or this consumer is not reading them, and those
//    two look identical from the outside.
{
  withNone();
  const bare = auditNodes(nav);
  const delta = Math.abs(bare.walkable - shipped.walkable)
    + Math.abs(bare.reachable - shipped.reachable) + nav.hintLinks.size;
  const declaredCount = declared.walkable.length + declared.blocked.length
    + declared.links.length + declared.cover.length;
  if (declaredCount === 0) console.log('  note: this map declares no §3.5 hints, so there is nothing to drop');
  else atLeast('dropping the declared hints visibly changes the graph', delta, 1, ' nodes/links');
  if (VERBOSE) console.log(`       without hints: ${bare.walkable} walkable, ${bare.reachable} reachable`);
  exactly('and no hinted links survive', nav.hintLinks.size, 0);
}

// -- `blocked`: force-unwalkable. The fixture is FOUND, by looking for a volume of the
//    real map that really does hold walkable nodes, so it cannot rot when geometry moves.
{
  withExtra();
  const declaredBlocked = nav.hintStats.forcedBlocked;
  const box = findDenseBox(40);
  if (box === null) bad('a blocked-hint fixture could be found', 'no 6 m box on this map holds 40 walkable nodes');
  else {
    const expect = countIn(box);
    atLeast('the blocked-hint fixture covers real walkable nodes', expect, 40);
    withExtra({ blocked: [box] });
    const after = auditNodes(nav);
    exactly('a blocked hint un-walks exactly the nodes inside it',
      nav.hintStats.forcedBlocked - declaredBlocked, expect);
    exactly('the walkable set shrinks by exactly that many', shipped.walkable - after.walkable, expect);
    let kept = 0;
    for (let node = 0; node < nav.nodeCount; node++) {
      if (nav.flags[node] & F_WALKABLE) continue;
      if (nav.linkMask[node] !== 0) kept++;
    }
    exactly('no blocked node keeps its links', kept, 0);
  }
}

// -- a hint that matches nothing must SAY so. Geometry drifting out from under a hint is
//    the same class of defect as a stale bake, and it is silent.
{
  const b = world.bounds;
  withExtra({ blocked: [{ min: V(b.min.x - 3, b.max.y - 1, b.min.z - 3), max: V(b.min.x - 2, b.max.y, b.min.z - 2) }] });
  atLeast('a blocked hint over empty space is reported unresolved', nav.hintStats.unresolvedBlocked, 1);
}

// -- `walkable`: force-walkable surfaces the raster misses. Fixture found by probing for
//    open air with real headroom and no node.
{
  withExtra();
  const before = auditNodes(nav);
  const spot = findOpenAir(2.5, 3);
  if (spot === null) bad('a walkable-hint fixture could be found', 'no 3 m patch of clear open air at 2.5 m');
  else {
    withExtra({ walkable: [spot.box] });
    const after = auditNodes(nav);
    exactly('a walkable hint creates a node on every covered cell centre', nav.hintStats.forcedWalkable, spot.cells);
    exactly('the walkable set grows by exactly that many', after.walkable - before.walkable, spot.cells);
    let atHeight = 0, thin = 0;
    for (let node = 0; node < nav.nodeCount; node++) {
      if (!(nav.flags[node] & F_WALKABLE)) continue;
      if (Math.abs(nav.floorY[node] - spot.box.max.y) > 0.05) continue;
      const col = (node / MAXL) | 0;
      if (nav.cellCenterX(col) < spot.box.min.x || nav.cellCenterX(col) > spot.box.max.x) continue;
      if (nav.cellCenterZ(col) < spot.box.min.z || nav.cellCenterZ(col) > spot.box.max.z) continue;
      atHeight++;
      if (nav.clearance[node] < 1.9) thin++;
    }
    exactly('every hinted node landed at the hinted height', atHeight, spot.cells);
    exactly('and every one of them has real headroom', thin, 0);
  }
}

// -- a force-walkable volume that CONTAINS a real surface must use that surface, not its
//    own lid. Taking the lid put a duplicate walkable layer over every square metre of
//    The Square's ground plane — 47% of the graph reading as phantom.
{
  withExtra();
  const before = auditNodes(nav);
  const ground = findGroundPatch(3);
  if (ground === null) bad('a ground-surface fixture could be found', 'no flat walkable patch located');
  else {
    withExtra({ walkable: [{ min: V(ground.x0, ground.y - 0.1, ground.z0), max: V(ground.x1, ground.y + 0.35, ground.z1) }] });
    const after = auditNodes(nav);
    exactly('a force-walkable volume over existing ground creates no duplicate layer',
      after.walkable - before.walkable, 0);
    atLeast('and reports the surface it reaffirmed', nav.hintStats.reaffirmedWalkable, ground.cells);
  }
}

// -- a walkable hint with no headroom must be refused: a hint cannot conjure headroom,
//    and honouring it paths bots into a ceiling.
{
  const under = findUnderCeiling();
  if (under === null) console.log('  note: no low-headroom volume on this map to test refusal against');
  else {
    withExtra({ walkable: [under] });
    exactly('a walkable hint with no headroom is refused', nav.hintStats.forcedWalkable, 0);
    atLeast('and is reported unresolved', nav.hintStats.unresolvedWalkable, 1);
  }
}

// -- `links`: an affordance the 8-neighbour raster cannot express, authored between a
//    reachable node and a real walkable node the bake leaves stranded. The property under
//    test is "does the manifest make unreachable playspace reachable", which is the whole
//    reason §3.5 links exist.
{
  withExtra();
  const before = auditNodes(nav);
  const pair = findStrandedPair();
  if (pair === null) {
    console.log('  note: this map has no stranded walkable node — link fixture skipped');
  } else {
    const { from, to } = pair;
    if (VERBOSE) console.log(`       link fixture: (${from.x.toFixed(1)},${from.y.toFixed(2)},${from.z.toFixed(1)}) -> (${to.x.toFixed(1)},${to.y.toFixed(2)},${to.z.toFixed(1)})`);
    withExtra({ links: [{ from, to, kind: 'mantle' }] });
    exactly('every declared link plus the fixture resolves', nav.hintStats.unresolvedLinks, 0);
    const fromNode = nav._hintNode(from), toNode = nav._hintNode(to);
    const fwd = (nav.hintLinks.get(fromNode) ?? []).filter((e) => e.to === toNode).length;
    const rev = (nav.hintLinks.get(toNode) ?? []).filter((e) => e.to === fromNode).length;
    exactly('a mantle hint is traversable outbound', fwd, 1);
    exactly('and inbound', rev, 1);
    const after = auditNodes(nav);
    atLeast('the hinted link makes stranded playspace reachable', after.reachable - before.reachable, 1);

    const node = nav.nodeAt(to.x, to.y + 0.2, to.z);
    if (node < 0 || !nav.reachable[node]) bad('the hinted destination is reachable after the bake', `node ${node}`);
    else {
      // Start from a reachable node 8-20 m away, not from a spawn: `findPath` is budgeted
      // (NODE_BUDGET expansions) and a 75 m route returns a partial by design, so a spawn
      // on the far side of the map would be testing the budget rather than the hint.
      const start = findReachableNear(from, 8, 20);
      if (start === null) { bad('a start point for the hinted route could be found', 'no reachable node 8-20 m away'); }
      else {
      const path = [];
      const n = nav.findPath(start, to, path);
      const end = n > 0 ? path[n - 1] : null;
      // Must land ON the hinted node, not near it. "Within a metre" is satisfied by the
      // ordinary grid route stopping on the neighbouring cell it could already reach —
      // exactly the case where the hint is being ignored — so a proximity test here
      // cannot fail and proves nothing.
      const gap = end === null ? Infinity : Math.hypot(end.x - to.x, end.z - to.z) + Math.abs(end.y - to.y);
      atMost('A* routes onto the far side of the hinted link', gap, 0.05, ' m');
      atLeast('and that route is a real path', n, 5, ' waypoints');
      }
    }

    // A `drop` is one-way. Climbing back up a hinted drop is the mistake the baked
    // dropMask exists to prevent; the hint path must not reintroduce it.
    withExtra({ links: [{ from, to, kind: 'drop' }] });
    const back = nav.hintLinks.get(nav._hintNode(to)) ?? [];
    const climbs = back.filter((e) => e.to === nav._hintNode(from)).length;
    exactly('a drop hint is stored one-way only', climbs, 0);
  }
}

// -- a link endpoint a storey off its surface must be refused, not snapped to the floor
//    it happens to be over.
{
  const sp = manifest.spawns[0].position;
  withExtra({ links: [{ from: V(sp.x, sp.y, sp.z), to: V(sp.x + 1.5, sp.y + 9.0, sp.z), kind: 'mantle' }] });
  exactly('a link endpoint with no surface near it is refused',
    nav.hintStats.linksResolved, declared.links.length);
  atLeast('and is reported unresolved', nav.hintStats.unresolvedLinks, 1);
}

// -- `cover`: an authored facing overrides the derived centroid.
{
  const sp = manifest.spawns[0].position;
  const facing = 1.0;
  withExtra({ cover: [{ position: V(sp.x, sp.y, sp.z), facing }] });
  exactly('every declared cover hint plus the fixture resolves',
    nav.hintStats.coverApplied, declared.cover.length + 1);
  const node = nav._hintNode(V(sp.x, sp.y, sp.z));
  if (node < 0) bad('the cover hint landed on a node', 'no node within a cell of the spawn');
  else {
    const col = (node / MAXL) | 0;
    const off = Math.hypot(nav.cellCenterX(col) - sp.x, nav.cellCenterZ(col) - sp.z);
    atMost('the cover hint landed within one cell of where it was authored', off, nav.cell * 1.5, ' m');
    if (nav.flags[node] & F_NEARCOVER) ok('a cover hint flags its node as cover');
    else bad('a cover hint flags its node as cover', `flags ${nav.flags[node]}`);
    const dx = nav.coverX[node] - -Math.sin(facing);
    const dz = nav.coverZ[node] - -Math.cos(facing);
    atMost('the stored cover direction is the authored facing', Math.hypot(dx, dz), 1e-6);
  }
}

// -- and the shipping state comes back.
{
  restore();
  const back = auditNodes(nav);
  exactly('restoring the declared hints restores the walkable count', back.walkable, shipped.walkable);
  exactly('restoring the declared hints restores the reachable count', back.reachable, shipped.reachable);
}

console.log(failures ? `\n${failures} FAILED` : '\nthe nav graph and the §3.5 hint path both hold up');
process.exit(failures ? 1 : 0);

// ───────────────────────────────────────────────────── fixture finders (probe, never guess)

function countIn(box) {
  let n = 0;
  for (let node = 0; node < nav.nodeCount; node++) {
    if (!(nav.flags[node] & F_WALKABLE)) continue;
    const y = nav.floorY[node];
    if (y < box.min.y - 0.05 || y > box.max.y + 0.05) continue;
    const col = (node / MAXL) | 0;
    const x = nav.cellCenterX(col), z = nav.cellCenterZ(col);
    if (x < box.min.x || x > box.max.x || z < box.min.z || z > box.max.z) continue;
    n++;
  }
  return n;
}

/** A 6 m box somewhere on the map holding at least `want` walkable nodes at one height. */
function findDenseBox(want) {
  const b = world.bounds;
  const heights = new Map();
  for (let node = 0; node < nav.nodeCount; node++) {
    if (!(nav.flags[node] & F_WALKABLE)) continue;
    const key = Math.round(nav.floorY[node] * 2) / 2;
    heights.set(key, (heights.get(key) ?? 0) + 1);
  }
  const ordered = [...heights.entries()].sort((p, q) => q[1] - p[1]).map(([y]) => y);
  for (const y of ordered) {
    for (let x = b.min.x; x < b.max.x; x += 6) {
      for (let z = b.min.z; z < b.max.z; z += 6) {
        const box = { min: V(x, y - 0.5, z), max: V(x + 6, y + 0.5, z + 6) };
        if (countIn(box) >= want) return box;
      }
    }
  }
  return null;
}

/**
 * A `size` m square of clear air at height `y`: standing headroom, no collider at foot
 * level, no existing node at that height, and room for another layer in every column.
 * Returns the box and the exact number of cell centres it covers — the consumer's own
 * rule, so the expected count is arithmetic rather than a guess.
 */
function findOpenAir(y, size) {
  const b = world.bounds;
  for (let x = b.min.x + 2; x < b.max.x - size - 2; x += 1.5) {
    for (let z = b.min.z + 2; z < b.max.z - size - 2; z += 1.5) {
      const box = { min: V(x, y - 0.5, z), max: V(x + size, y, z + size) };
      let cells = 0, spoiled = false;
      for (let cx = 0; cx < nav.cols && !spoiled; cx++) {
        const wx = nav.cellCenterX(cx);
        if (wx < box.min.x || wx > box.max.x) continue;
        for (let cz = 0; cz < nav.rows && !spoiled; cz++) {
          const col = cz * nav.cols + cx;
          const wz = nav.cellCenterZ(col);
          if (wz < box.min.z || wz > box.max.z) continue;
          if (nav.layerCount[col] >= MAXL) { spoiled = true; break; }
          for (let l = 0; l < nav.layerCount[col]; l++) {
            if (Math.abs(nav.floorY[col * MAXL + l] - y) < 0.05) { spoiled = true; break; }
          }
          if (spoiled) break;
          if (!clearAt(wx, wz, y)) { spoiled = true; break; }
          cells++;
        }
      }
      if (!spoiled && cells >= 9) return { box, cells };
    }
  }
  return null;
}

/** Standing clearance at a point, measured against the real box set. */
function clearAt(x, z, y) {
  let clear = world.bounds.max.y - y;
  for (const bx of world.boxes) {
    if (x < bx.min.x - 0.30 || x > bx.max.x + 0.30) continue;
    if (z < bx.min.z - 0.30 || z > bx.max.z + 0.30) continue;
    if (bx.max.y > y + 0.06 && bx.min.y < y + 0.06) return false;
    if (bx.min.y >= y + 0.06) clear = Math.min(clear, bx.min.y - y);
  }
  return clear >= 1.9;
}

/** A flat patch of existing walkable ground, for the "no duplicate layer" test. */
function findGroundPatch(size) {
  const b = world.bounds;
  for (let x = b.min.x + 4; x < b.max.x - size - 4; x += 2) {
    for (let z = b.min.z + 4; z < b.max.z - size - 4; z += 2) {
      let y = null, cells = 0, ok2 = true;
      for (let px = x; px <= x + size && ok2; px += nav.cell) {
        for (let pz = z; pz <= z + size && ok2; pz += nav.cell) {
          const node = nav.nodeAt(px, 0.3, pz);
          if (node < 0) { ok2 = false; break; }
          const ny = nav.floorY[node];
          if (y === null) y = ny;
          else if (Math.abs(ny - y) > 0.02) { ok2 = false; break; }
          cells++;
        }
      }
      if (ok2 && y !== null && cells >= 9) {
        return { x0: x, z0: z, x1: x + size, z1: z + size, y, cells: 9 };
      }
    }
  }
  return null;
}

/** A volume under a real ceiling, where standing clearance is genuinely short. */
function findUnderCeiling() {
  for (const bx of world.boxes) {
    const height = bx.min.y;
    if (height < 2.4 || height > 12) continue;           // a floor slab or a roof, not a kerb
    if ((bx.max.x - bx.min.x) * (bx.max.z - bx.min.z) < 12) continue;
    const y = height - 1.0;                               // 1.0 m of headroom: too little
    if (y < 0.5) continue;
    const cx = (bx.min.x + bx.max.x) / 2, cz = (bx.min.z + bx.max.z) / 2;
    if (clearAt(cx, cz, y)) continue;                     // must really be short
    return { min: V(cx - 1, y - 0.2, cz - 1), max: V(cx + 1, y, cz + 1) };
  }
  return null;
}

/** Exhaustive forward BFS from one node over grid links and §3.5 hinted links. */
function floodFrom(startNode) {
  const seen = new Uint8Array(nav.nodeCount);
  const queue = new Int32Array(nav.nodeCount);
  const DX = [1, -1, 0, 0, 1, 1, -1, -1];
  const DZ = [0, 0, 1, -1, 1, -1, 1, -1];
  let top = 0;
  seen[startNode] = 1; queue[top++] = startNode;
  while (top > 0) {
    const cur = queue[--top];
    const col = (cur / MAXL) | 0;
    const cx = col % nav.cols, cz = (col / nav.cols) | 0;
    const extra = nav.hintLinks.get(cur);
    if (extra !== undefined) {
      for (const e of extra) {
        if (!(nav.flags[e.to] & F_WALKABLE) || seen[e.to]) continue;
        seen[e.to] = 1; queue[top++] = e.to;
      }
    }
    const mask = nav.linkMask[cur];
    for (let d = 0; d < 8; d++) {
      if (!(mask & (1 << d))) continue;
      const nx = cx + DX[d], nz = cz + DZ[d];
      if (nx < 0 || nz < 0 || nx >= nav.cols || nz >= nav.rows) continue;
      const nn = (nz * nav.cols + nx) * MAXL + nav.linkLayer[cur * 8 + d];
      if (!(nav.flags[nn] & F_WALKABLE) || seen[nn]) continue;
      seen[nn] = 1; queue[top++] = nn;
    }
  }
  return seen;
}

/** A reachable node between `lo` and `hi` metres from `p`, or null. */
function findReachableNear(p, lo, hi) {
  let best = null, bestD = Infinity;
  for (let node = 0; node < nav.nodeCount; node++) {
    if (!(nav.flags[node] & F_WALKABLE) || !nav.reachable[node]) continue;
    const col = (node / MAXL) | 0;
    const x = nav.cellCenterX(col), z = nav.cellCenterZ(col);
    const d = Math.hypot(x - p.x, z - p.z) + Math.abs(nav.floorY[node] - p.y);
    if (d < lo || d > hi) continue;
    if (d < bestD) { bestD = d; best = V(x, nav.floorY[node], z); }
  }
  return best;
}

/** A stranded walkable node and the nearest reachable node to it. */
function findStrandedPair() {
  const centre = (node) => {
    const col = (node / MAXL) | 0;
    return V(nav.cellCenterX(col), nav.floorY[node], nav.cellCenterZ(col));
  };
  const reach = [], stranded = [];
  for (let node = 0; node < nav.nodeCount; node++) {
    if (!(nav.flags[node] & F_WALKABLE)) continue;
    (nav.reachable[node] ? reach : stranded).push(node);
  }
  if (stranded.length === 0 || reach.length === 0) return null;
  let bestFrom = -1, bestTo = -1, bestD = Infinity;
  for (const s of stranded) {
    const sp = centre(s);
    for (const r of reach) {
      const rp = centre(r);
      const d = Math.hypot(sp.x - rp.x, sp.z - rp.z) + Math.abs(sp.y - rp.y);
      if (d < bestD) { bestD = d; bestFrom = r; bestTo = s; }
    }
    if (bestD < 1.0) break;
  }
  if (bestFrom < 0) return null;
  return { from: centre(bestFrom), to: centre(bestTo) };
}
