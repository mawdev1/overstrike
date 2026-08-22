/**
 * P3-07 CX acceptance — client sector streaming, LOD/visibility gating, extraction/POI
 * signage and sponsor-slot placeholders on map 'square-extraction'.
 *
 * Four proof obligations, all headless (no browser, no GL):
 *
 *  A. Dressing changes NOTHING the server checks: the colliders-only build of the raid
 *     map with signage+sponsor dressing ON is byte-identical to the build with it OFF.
 *     Colliders are the substrate of collision, shot traces and the nav bake, so this is
 *     the "placeholders do not affect sightlines or collision" DoD, proven, not asserted.
 *
 *  B. Every declared signage/sponsor panel is FLUSH-MOUNTED on existing opaque colliding
 *     architecture: each panel's face sits ≤0.30 m proud of a collider face behind it and
 *     its whole rectangle is backed by collider volume — a panel can never occlude
 *     anything its backing wall did not already occlude.
 *
 *  C. The Builder buckets visuals per sector (`sector:<id>` groups) and the streaming
 *     controller drives sector-graph-relevance tiers exactly as sector-interest.md §5.1
 *     reads for a client: occupied+transition = FULL, adjacent = NEAR (visible, shadow
 *     casting stripped), out-of-graph = HIDDEN after the §4.1-shaped cooldown. BOTH
 *     tier edges carry that cooldown: FULL→NEAR is hysteretic too, and the pacing test
 *     below proves crossing the 6 m transition-zone edge never toggles a neighbour
 *     sector's castShadow (with a cooldownS=0 failing control proving the assertion is
 *     live). Includes a REAL failing control for graph-drivenness: severing the
 *     neighbour graph must hide a geometrically adjacent sector — distance-driven
 *     streaming would pass the happy path and fail this.
 *
 *  D. Budget accounting: raid collider count stays inside EXTRACTION_MANIFEST.budgets,
 *     and on a P4-01-shaped 5-sector chain the hidden tier sheds ≥50% of mesh draws
 *     while the §5.1-relevant neighbourhood stays fully visible.
 *
 * Renderer-measured budgets for the competitive map remain `scripts/mapperf.mjs`'s gate.
 * The RENDERER-measured numbers for THIS map — real draw calls with streaming on vs off,
 * incl. the per-sector bucket-split cost against an unsectored build — are
 * `scripts/uistreamperf.mjs`'s gate; this harness is the headless sector-graph mechanism
 * proof (the shipped map's three sectors are mutually adjacent, so §5.1 keeps all of
 * them visible — correctly — and only uistreamperf can price what NEAR sheds).
 */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  SQUARE_EXTRACTION, EXTRACTION_SECTORS, EXTRACTION_MANIFEST,
  EXTRACTION_SIGNAGE, SPONSOR_SLOTS, SECTOR_SIGN_COLORS,
  buildExtractionLevel, createSectorStreaming, STREAM_TIER,
} from '../src/world/level.js';
import { Builder, setCollidersOnly } from '../src/world/props.js';
import { SectorInterest, SECTOR_COOLDOWN_S, TRANSITION_ZONE_M } from '../src/game/sectorInterest.js';
import { createRNG } from '../src/core/rng.js';

let checks = 0;
const failures = [];
const check = (condition, message) => {
  checks++;
  if (condition) console.log(`  ok   ${message}`);
  else { failures.push(message); console.log(`  FAIL ${message}`); }
};

// ── stubs ────────────────────────────────────────────────────────────────────────────

function stubWorld() {
  return {
    group: new THREE.Group(),
    boxes: [],
    buildStats: {},
    setBounds() {},
    addBoxRaw(x0, y0, z0, x1, y1, z1, surface) {
      const box = {
        min: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) },
        max: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) },
        surface,
      };
      this.boxes.push(box);
      return box;
    },
  };
}
const stubGame = (seed = 0x50e07) => ({ rng: createRNG(seed) });

function collidersOnlyBuild(opts) {
  setCollidersOnly(true);
  const world = stubWorld();
  try {
    buildExtractionLevel(stubGame(), world, opts);
  } finally {
    setCollidersOnly(false);
  }
  return world;
}

const round = (v) => Math.round(v * 1000) / 1000;
const serializeBoxes = (world) => JSON.stringify(world.boxes.map((b) => [
  round(b.min.x), round(b.min.y), round(b.min.z),
  round(b.max.x), round(b.max.y), round(b.max.z), b.surface,
]));

// ── A. dressing leaves the collider set byte-identical ───────────────────────────────

console.log('\n── A. signage + sponsor dressing vs the collider set');
const dressed = collidersOnlyBuild({});
const bare = collidersOnlyBuild({ dressing: false });
check(dressed.boxes.length > 0, `raid map builds colliders headlessly (${dressed.boxes.length})`);
check(serializeBoxes(dressed) === serializeBoxes(bare),
  'collider set with dressing ON is byte-identical to dressing OFF (no collision/sightline change)');
const rebuilt = collidersOnlyBuild({});
check(serializeBoxes(dressed) === serializeBoxes(rebuilt),
  'control: the dressed build itself is deterministic (identity check is not vacuous)');
check(dressed.boxes.length <= EXTRACTION_MANIFEST.budgets.colliders,
  `collider count stays inside the manifest budget (${dressed.boxes.length} ≤ ${EXTRACTION_MANIFEST.budgets.colliders})`);

// ── B. every declared panel is flush-mounted on colliding architecture ───────────────

console.log('\n── B. panel backing: flush on existing opaque colliders');
const AXIS = { '+z': ['z', +1], '-z': ['z', -1], '+x': ['x', +1], '-x': ['x', -1] };
const MAX_PROUD = 0.30;   // plane offset (≤0.03) + thickest chopped board (≤~0.11) + margin

/** Is the (a, y) sample point backed by a collider whose face sits 0..MAX_PROUD behind
 *  the panel plane? `a` is the in-plane horizontal coordinate (x for z-normals, z for
 *  x-normals). */
function sampleBacked(spec, a, y) {
  const [axis, sign] = AXIS[spec.normal];
  const plane = axis === 'z' ? spec.z : spec.x;
  const aAxis = axis === 'z' ? 'x' : 'z';
  for (const b of dressed.boxes) {
    const face = sign > 0 ? b.max[axis] : b.min[axis];
    const depth = (plane - face) * sign;
    if (depth < 0 || depth > MAX_PROUD) continue;
    if (a < b.min[aAxis] - 1e-6 || a > b.max[aAxis] + 1e-6) continue;
    if (y < b.min.y - 1e-6 || y > b.max.y + 1e-6) continue;
    return true;
  }
  return false;
}

function checkPanel(spec) {
  const [axis] = AXIS[spec.normal];
  const aCentre = axis === 'z' ? spec.x : spec.z;
  let backed = true;
  for (const fa of [0.02, 0.25, 0.5, 0.75, 0.98]) {
    for (const fy of [0.02, 0.5, 0.98]) {
      const a = aCentre - spec.w / 2 + fa * spec.w;
      const y = spec.y + fy * spec.h;
      if (!sampleBacked(spec, a, y)) backed = false;
    }
  }
  check(backed, `${spec.id}: whole panel rect is flush-backed by colliding architecture`);
}
for (const spec of [...EXTRACTION_SIGNAGE, ...SPONSOR_SLOTS]) checkPanel(spec);

// A real failing control for the backing check itself: a panel floated mid-air must fail.
{
  const floating = { id: 'control-floating', normal: '+z', x: 0, z: -50, y: 2, w: 2, h: 1 };
  check(!sampleBacked(floating, 0, 2.5), 'control: a free-floating panel is rejected by the backing check');
}

// ── vocabulary: ids, colours, placement language ─────────────────────────────────────

console.log('\n── signage/sponsor vocabulary');
{
  const sectorIds = new Set(EXTRACTION_SECTORS.map((s) => s.id));
  const exitIds = new Set(SQUARE_EXTRACTION.EXTRACTION_EXITS.map((e) => e.id));
  const allIds = [...EXTRACTION_SIGNAGE, ...SPONSOR_SLOTS].map((s) => s.id);
  check(new Set(allIds).size === allIds.length, 'panel ids are unique');
  check(EXTRACTION_SIGNAGE.every((s) => sectorIds.has(s.sectorId))
    && SPONSOR_SLOTS.every((s) => sectorIds.has(s.sectorId)),
  'every panel is placed in a declared sector');
  const exits = EXTRACTION_SIGNAGE.filter((s) => s.kind === 'exit');
  check(exits.length >= 2 && SQUARE_EXTRACTION.EXTRACTION_EXITS
    .every((e) => exits.some((s) => s.refId === e.id)),
  'both authored exits carry exit signage');
  check(exits.every((s) => exitIds.has(s.refId)), 'exit signage references only authored exit ids');
  for (const e of SQUARE_EXTRACTION.EXTRACTION_EXITS) {
    const near = exits.filter((s) => s.refId === e.id).every((s) => {
      const v = e.volume;
      return s.x >= v.min.x - 10 && s.x <= v.max.x + 10 && s.z >= v.min.z - 10 && s.z <= v.max.z + 10;
    });
    check(near, `${e.id}: its signage sits within 10 m of the exit volume`);
  }
  const sectorsSigned = EXTRACTION_SIGNAGE.filter((s) => s.kind === 'sector');
  check([...sectorIds].every((id) => sectorsSigned.some((s) => s.refId === id)),
    'every sector has at least one name/wayfinding surface');
  check(sectorsSigned.every((s) => s.color === SECTOR_SIGN_COLORS[s.refId]),
    'sector surfaces use exactly the SECTOR_SIGN_COLORS vocabulary for the sector they name');
  const reserved = new Set([...Object.values(SECTOR_SIGN_COLORS), 0xe8c24a]);
  check(SPONSOR_SLOTS.every((s) => !reserved.has(s.color)),
    'sponsor placeholders never borrow sector or hazard colours');
  const b = EXTRACTION_MANIFEST.bounds;
  check([...EXTRACTION_SIGNAGE, ...SPONSOR_SLOTS].every((s) => s.x >= b.min.x && s.x <= b.max.x
    && s.z >= b.min.z && s.z <= b.max.z && s.y >= 0 && s.y + s.h <= b.max.y),
  'every panel sits inside the map bounds');
}

// ── C1. Builder buckets visuals per sector ───────────────────────────────────────────

console.log('\n── C1. per-sector visual bucketing (Builder routing)');
{
  const world = stubWorld();
  const B = new Builder(stubGame(), world);
  B.setSector('alpha');
  B.box(0, 0, 0, 1, 1, 1, 'concrete');
  B.prop('sign', 0, 0, 0, 0, { color: 0xffffff, collide: false });
  B.setSector('beta');
  B.box(2, 0, 0, 3, 1, 1, 'concrete');
  B.setSector(null);
  B.box(4, 0, 0, 5, 1, 1, 'concrete');

  const staticBuckets = [...B._static.values()];
  check(staticBuckets.some((bk) => bk.sector === 'alpha') && staticBuckets.some((bk) => bk.sector === 'beta')
    && staticBuckets.some((bk) => bk.sector === null || bk.sector === undefined),
  'same-material geometry splits into per-sector static buckets (plus a shared bucket)');
  check([...B._inst.values()].every((bk) => bk.sector === 'alpha'),
    'instanced props inherit the sector active at stamp time');
  const gAlpha = B._sectorGroup('alpha');
  const gBeta = B._sectorGroup('beta');
  check(gAlpha.name === 'sector:alpha' && gAlpha.userData.sectorId === 'alpha'
    && gAlpha.parent === world.group && gBeta !== gAlpha,
  'sector groups are named, tagged children of the world group');
  check(B._sectorGroup(null) === world.group, 'sectorless output attaches directly to the world group');
  check(world.boxes.length === 3, 'sector tagging never touches colliders (3 boxes from 3 collidable calls)');
}

// ── C2. streaming tiers on the real three-sector map ─────────────────────────────────

console.log('\n── C2. streaming controller on square-extraction (complete graph)');
const fakeGroup = (n = 4) => ({
  visible: true,
  children: Array.from({ length: n }, () => ({ isMesh: true, castShadow: true, userData: {} })),
});
function controllerFor(sectors, meshesPerSector = 4) {
  const groups = new Map(sectors.map((s) => [s.id, fakeGroup(meshesPerSector)]));
  return { c: createSectorStreaming({ sectors, groups }), groups };
}
{
  const { c, groups } = controllerFor(EXTRACTION_SECTORS);
  c.update(1 / 60, { x: 0, y: 0.1, z: 0 });   // centre of The Square
  check(c.tierOf('square') === STREAM_TIER.FULL, 'occupied sector renders FULL');
  check(c.tierOf('north-yard') === STREAM_TIER.NEAR && c.tierOf('east-docks') === STREAM_TIER.NEAR,
    'adjacent sectors render NEAR — never hidden, exactly the §5.1 relevant set');
  check([...groups.values()].every((g) => g.visible), 'the whole §5.1 neighbourhood stays visible');
  check(groups.get('square').children.every((m) => m.castShadow)
    && groups.get('north-yard').children.every((m) => !m.castShadow),
  'NEAR strips shadow casting; FULL keeps it');

  // Transition zone: within 6 m of the north-yard boundary both sectors are occupied.
  c.update(1 / 60, { x: 0, y: 0.1, z: -(44 - TRANSITION_ZONE_M + 1) });
  check(c.tierOf('square') === STREAM_TIER.FULL && c.tierOf('north-yard') === STREAM_TIER.FULL,
    `transition zone (§3, ${TRANSITION_ZONE_M} m) renders both boundary sectors FULL`);
  check(groups.get('north-yard').children.every((m) => m.castShadow),
    'entering the transition zone restores the neighbour sector\'s shadow casting');

  // Fail-open: no viewer, or a viewer outside every sector, renders everything FULL.
  c.update(1 / 60, null);
  check(EXTRACTION_SECTORS.every((s) => c.tierOf(s.id) === STREAM_TIER.FULL),
    'fail-open: no viewer position renders everything FULL');
  c.update(1 / 60, { x: 500, y: 0, z: 500 });
  check(EXTRACTION_SECTORS.every((s) => c.tierOf(s.id) === STREAM_TIER.FULL),
    'fail-open: a viewer outside every sector renders everything FULL');
}
{
  // FULL↔NEAR hysteresis at the transition-zone edge. On the shipped map this is the
  // ONLY tier transition that can occur (complete graph — nothing is ever HIDDEN), so
  // the one artifact the feature can produce is a whole-sector shadow pop while pacing
  // the 6 m boundary. The controller must hold FULL for SECTOR_COOLDOWN_S after the
  // sector leaves the occupied set; NEAR→FULL stays instant.
  const inZone = { x: 0, y: 0.1, z: -(44 - TRANSITION_ZONE_M + 1) };  // north-yard occupied
  const outOfZone = { x: 0, y: 0.1, z: -20 };                          // square only
  const flipsWith = (cooldownS) => {
    const groups = new Map(EXTRACTION_SECTORS.map((s) => [s.id, fakeGroup(3)]));
    const c = createSectorStreaming({ sectors: EXTRACTION_SECTORS, groups, ...(cooldownS !== undefined ? { cooldownS } : {}) });
    c.update(1 / 60, inZone);                    // reach FULL once, first
    const mesh = groups.get('north-yard').children[0];
    let last = mesh.castShadow;
    let flips = 0;
    for (let i = 0; i < 240; i++) {              // 4 s of pacing across the boundary
      c.update(1 / 60, i % 20 < 10 ? inZone : outOfZone);
      if (mesh.castShadow !== last) { flips++; last = mesh.castShadow; }
    }
    return { c, groups, mesh, flips };
  };
  const paced = flipsWith(undefined);
  check(paced.flips === 0 && paced.mesh.castShadow === true
    && paced.c.tierOf('north-yard') === STREAM_TIER.FULL,
  'pacing the transition-zone edge never toggles the neighbour sector\'s castShadow (FULL held through the cooldown)');
  // The hysteresis is a delay, not a disable: parked outside the zone past the cooldown,
  // the sector must still decay to NEAR and shed its shadow casting.
  paced.c.update(SECTOR_COOLDOWN_S + 0.1, outOfZone);
  check(paced.c.tierOf('north-yard') === STREAM_TIER.NEAR
    && paced.groups.get('north-yard').children.every((m) => !m.castShadow),
  `after ${SECTOR_COOLDOWN_S} s clear of the boundary the sector still decays to NEAR (hysteresis delays, never disables, shedding)`);
  // NEAR→FULL stays instant: stepping back into the zone restores shadows immediately.
  paced.c.update(1 / 60, inZone);
  check(paced.c.tierOf('north-yard') === STREAM_TIER.FULL && paced.mesh.castShadow === true,
    'stepping back into the zone restores FULL with no warm-up delay');
  // REAL failing control: with the cooldown removed the same pacing MUST thrash — this
  // proves the assertion above can detect a lost hysteresis, not that pacing is benign.
  const thrash = flipsWith(0);
  check(thrash.flips >= 10,
    `failing control: cooldownS=0 makes the same pacing toggle castShadow ${thrash.flips}× — the hysteresis assertion is live`);
}
{
  // Authored-false castShadow must survive a FULL→NEAR→FULL round trip (receive-only
  // ground planes exist in every sector).
  const sectors = EXTRACTION_SECTORS;
  const groups = new Map(sectors.map((s) => [s.id, fakeGroup(2)]));
  groups.get('north-yard').children[0].castShadow = false;
  const c = createSectorStreaming({ sectors, groups });
  c.update(1 / 60, { x: 0, y: 0.1, z: 0 });          // north-yard NEAR
  c.update(1 / 60, { x: 0, y: 0.1, z: -50 });        // north-yard FULL
  check(groups.get('north-yard').children[0].castShadow === false
    && groups.get('north-yard').children[1].castShadow === true,
  'restoring FULL re-applies each mesh\'s AUTHORED castShadow, not a blanket true');
}

// ── C3+D. deeper graph: hidden tier, cooldown, graph-driven control, draw shedding ───

console.log('\n── C3. P4-01-shaped 5-sector chain: hidden tier + cooldown + failing control');
const chain = (neighboursOverride = null) => Array.from({ length: 5 }, (_, i) => ({
  id: `s${i + 1}`,
  box: { min: { x: i * 20, y: -1, z: -10 }, max: { x: (i + 1) * 20, y: 10, z: 10 } },
  neighbours: neighboursOverride ? neighboursOverride(i)
    : [i > 0 && `s${i}`, i < 4 && `s${i + 2}`].filter(Boolean),
  populationCap: 8,
  baseThinkStride: 8,
}));
{
  const sectors = chain();
  const { c } = controllerFor(sectors, 10);
  const inSector = (i) => ({ x: i * 20 - 10, y: 0.1, z: 0 });
  c.update(1 / 60, inSector(1));
  check(c.tierOf('s1') === STREAM_TIER.FULL && c.tierOf('s2') === STREAM_TIER.NEAR,
    'chain: own sector FULL, direct neighbour NEAR');
  check(c.tierOf('s3') === STREAM_TIER.HIDDEN && c.tierOf('s5') === STREAM_TIER.HIDDEN,
    'chain: sectors past one hop render NOT AT ALL (never-relevant, no grace owed)');
  const far = c.stats();
  check(far.hiddenMeshes === 30 && far.visibleMeshes === 20,
    `hidden tier sheds ${far.hiddenMeshes}/${far.hiddenMeshes + far.visibleMeshes} meshes (≥50%) while the relevant neighbourhood stays whole`);

  // Cross the map: instant FULL where the viewer lands, cooldown grace where they left.
  c.update(1 / 60, inSector(4));
  check(c.tierOf('s4') === STREAM_TIER.FULL && c.tierOf('s3') === STREAM_TIER.NEAR
    && c.tierOf('s5') === STREAM_TIER.NEAR,
  'chain: relevance follows the viewer with no warm-up delay');
  check(c.tierOf('s1') === STREAM_TIER.NEAR && c.tierOf('s2') === STREAM_TIER.NEAR,
    `recently-relevant sectors hold a ${SECTOR_COOLDOWN_S} s grace tier instead of snapping off (§4.1's cooldown shape)`);
  c.update(SECTOR_COOLDOWN_S + 0.1, inSector(4));
  check(c.tierOf('s1') === STREAM_TIER.HIDDEN && c.tierOf('s2') === STREAM_TIER.HIDDEN,
    'after the cooldown elapses the abandoned sectors hide');
}
{
  // REAL failing control: sever s1↔s2 in the graph. The sectors remain geometrically
  // adjacent, so any distance-driven implementation would still show s2; the contract
  // demands the GRAPH decides.
  const sectors = chain((i) => (i === 0 ? [] : i === 1 ? ['s3'] : [i > 1 && `s${i}`, i < 4 && `s${i + 2}`].filter(Boolean)));
  const { c } = controllerFor(sectors, 10);
  c.update(1 / 60, { x: 10, y: 0.1, z: 0 });   // inside s1, 10 m from s2 geometry
  check(c.tierOf('s2') === STREAM_TIER.HIDDEN,
    'failing control: severing the neighbour graph hides a geometrically adjacent sector — streaming is sector-graph-driven, not distance-driven');
}
{
  // The controller and the simulation's own SectorInterest must agree on relevance —
  // §5.1's "one relevant sector set" rule, checked against the CC module directly.
  const c = createSectorStreaming({ sectors: EXTRACTION_SECTORS, groups: new Map() });
  const si = new SectorInterest(EXTRACTION_SECTORS);
  for (const p of [{ x: 0, y: 0.1, z: 0 }, { x: 0, y: 0.1, z: -70 }, { x: 70, y: 0.1, z: 0 }, { x: 0, y: 0.1, z: -43 }]) {
    c.update(1 / 60, p);
    const rel = si.relevantSetFor(p);
    const shown = EXTRACTION_SECTORS.filter((s) => c.tierOf(s.id) !== STREAM_TIER.HIDDEN).map((s) => s.id);
    assert.deepEqual(new Set(shown).size >= rel.size && [...rel].every((id) => shown.includes(id)), true);
  }
  check(true, 'every §5.1-relevant sector is visible at every probed viewpoint (client never under-renders the server\'s relevant set)');
}

// ── result ───────────────────────────────────────────────────────────────────────────

console.log(`\nuistream: ${failures.length ? 'FAIL' : 'PASS'} — ${checks} checks, ${failures.length} failures`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
