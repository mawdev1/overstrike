import * as THREE from 'three';
import { Builder } from './props.js';
// Client sector streaming (P3-07) deliberately answers "which sectors are near this
// viewer" with the SAME geometry module the simulation's activation gating uses
// (sector-interest.md §5.1's "one relevant sector set" rule) — never a second,
// renderer-local notion of nearby. The module is CC-owned; importing it is the point.
import { SectorInterest, SECTOR_COOLDOWN_S } from '../game/sectorInterest.js';

/**
 * MERIDIAN — a Mediterranean coastal military compound.
 *
 * 86 × 86 m of playable space inside a walled perimeter, laid out as three lanes running
 * north (−Z, team 1) to south (+Z, team 0):
 *
 *   LEFT  (x −41…−13)  OLD TOWN   two brick blocks against the town wall, an elevated
 *                                 rampart linking their roof terraces over a dirt
 *                                 courtyard. Tight, lots of doorways, short sightlines.
 *   MID   (x −13…+13)  PLAZA      the two-storey MARKET HALL sits dead centre with an
 *                                 accessible roof — the contested high ground. Balconies
 *                                 on three faces, four ground entrances, punched windows.
 *   RIGHT (x +13…+41)  HARBOUR    a wide asphalt quay road with the WAREHOUSE (north) and
 *                                 CUSTOMS OFFICE (south), broken by container barricades,
 *                                 trucks and a gantry crane.
 *
 * Every lane connects to its neighbours at least four times, so the map plays as loops
 * rather than corridors, and every room has at least two entrances.
 *
 * Sightlines (measured, eye 1.62 m, 36.8k rays over every walkable ground tile in eight
 * directions): 99.7% under 55 m. The only exceptions are pure 45° corner-to-corner
 * diagonals through the plaza, which top out at ~70 m — they require standing in a
 * specific map corner and are covered from three elevated positions.
 */

// ── site plan ─────────────────────────────────────────────────────────────────────────
const EDGE = 43;          // outer wall face
const IN = 41;            // inner wall face — playable extent
// Tall enough that nothing a player can reach can see over the perimeter into the void.
//
// The binding constraint is not the market-hall roof deck (eye 9.67, comfortably held by
// 12.0) but the rooftop plant a player can air-mantle onto: the warehouse AC unit puts
// the eye at 12.32 and the market-hall plant at 12.07, and from either, 65% of horizontal
// rays used to escape the level. 13.4 matches the east wall, which was already taller,
// and clears the highest reachable eye by a metre.
//
// Sized against the highest JUMPING eye on the map, not a standing one.
//
// 12.0 let a player on rooftop plant see out. 13.4 fixed the standing case (10.70 + 1.62)
// and not the jumping one (10.70 + 1.146 + 1.62 = 13.47). 14.0 fixed that and not the
// market-hall lantern deck at 11.67, which a jump-and-air-mantle off the roof plant
// reaches: eye 14.44.
//
// Lowering the plant to break that route was tried and does not: the lantern only needs
// feet within mantle range on the way past, and the apex from a shorter plant still
// passes through that band. Rather than tune a prop until the route barely fails — which
// is the kind of margin that comes back the next time anything near it moves — the wall
// simply clears the highest eye the movement rules can produce, with 0.56 m to spare.
//
// Bullets and line-of-sight only see colliders, so the visual coping course above this
// does not count toward it.
//
// scripts/maptest.mjs asserts against the jump eye, and that no surface within mantling
// reach of a perimeter face comes within a jump-plus-mantle of its top, so a future prop
// cannot quietly reopen this.
const WALL_H = 15.0;

const PLINTH = 0.15;      // buildings sit on a low stone plinth
const L1 = 4.15;          // first-floor walking level
const L1_UNDER = 3.85;    // ⌐ slab underside
const L2 = 8.05;          // market hall roof deck
const L2_UNDER = 7.75;
const TER = 3.95;         // old-town terrace / rampart level
const TER_UNDER = 3.65;

const CONTAINER_COLORS = [0xb4483c, 0x3f6f8c, 0x6f8a4a, 0xa8763a, 0x8d9199, 0x9c4f6e];
const BARREL_COLORS = [0xb2543f, 0x4a6f8e, 0x7d8a52, 0xa8a49b];
const AWNING_COLORS = [0xc85a4a, 0xd9c07a, 0x5e8ea8, 0xb9784e];

// ── lane palettes ─────────────────────────────────────────────────────────────────────
//
// Silhouette alone is not enough to orient by: in a firefight you register colour long
// before you register shape. Each lane therefore owns a paint family, applied to the
// things a player actually looks at — shutters, signage, painted plinths, laundry.
//
//   OLD TOWN  terracotta, ochre and dusty blue over red brick and whitewash
//   PLAZA     verdigris and sea-green over cream limewash
//   HARBOUR   marine green, rust and hazard yellow over grey steel
//
// These are per-INSTANCE tints multiplied into an existing material, so the whole scheme
// costs zero extra materials and zero extra draw calls (ARCHITECTURE.md §11).
const OT_SHUTTERS = [0x9ab6c4, 0xd8b070, 0xa8b39a, 0xc09a80, 0x8fa8b8];
const PZ_SHUTTERS = [0x7fc8d0, 0x6fb0c0, 0x9fd0c4, 0x86bcd4];
const OT_PAINT = 0xd7a05a;      // ochre signwriting
const PZ_PAINT = 0x59c6c6;      // verdigris band + market signage
const HB_PAINT = 0x5f9a86;      // marine green ironwork
const HB_RUST = 0xa4643a;       // red-oxide primer
const HAZARD = 0xe8c24a;        // safety yellow
// Cloth is tinted sandbag weave (a warm mid-tan), so a tint of 0x808080 comes out almost
// black. Laundry and bunting therefore use near-maximum saturation to survive the
// multiply and still read as distinct colours at 30 m.
const LAUNDRY = [0xffffff, 0x7fd4ff, 0xff9a7a, 0xa8f088, 0xffd24a, 0xd0a8ff, 0xffffff, 0x9fe8e0];

// ── The Square — competitive map-data 1.2 producer ────────────────────────────────

export const MAP_ID = 'the-square';
// 2.0.0 is a MAJOR bump under map-data.md §8: site-A's plant volume MOVED, which rewrites
// the meaning of every match result recorded against 1.0.0. Landed with CCR-001.
export const MAP_VERSION = '2.0.0';

const SQUARE_EDGE = 44;
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const volume = (x0, y0, z0, x1, y1, z1) => ({ min: v3(x0, y0, z0), max: v3(x1, y1, z1) });

/**
 * Competitive containment is deliberately data, not district architecture. P6 can embed
 * the district by omitting this layer without deleting or re-authoring any civic building.
 */
export const COMPETITIVE_BOUNDARY = Object.freeze([
  volume(-44, -1, -44, -42, 15, 44),
  volume(42, -1, -44, 44, 15, 44),
  volume(-42, -1, -44, 42, 15, -42),
  volume(-42, -1, 42, 42, 15, 44),
]);

const squareSpawns = Object.freeze([
  // Alpha protected Bomb group, south service court.
  ['alpha-court-1', -10, 0, 34, 0, 0, 'alpha-main'],
  ['alpha-court-2', -8, 0, 34, 0, 0, 'alpha-main'],
  ['alpha-court-3', -6, 0, 34, 0, 0, 'alpha-main'],
  ['alpha-court-4', -4, 0, 34, 0, 0, 'alpha-main'],
  ['alpha-court-5', -2, 0, 34, 0, 0, 'alpha-main'],
  ['alpha-market-1', 34, 0, 31, -0.35, 0, 'alpha-market'],
  ['alpha-transit-1', 31, 0, 32, 0.35, 0, 'alpha-transit'],
  ['alpha-plaza-1', -34, 0, 38, 0.15, 0, 'alpha-plaza'],
  // Bravo protected Bomb group, north municipal court.
  ['bravo-court-1', 36, 0, -28, -Math.PI / 2, 1, 'bravo-main'],
  ['bravo-court-2', 36, 0, -26, -Math.PI / 2, 1, 'bravo-main'],
  ['bravo-court-3', 36, 0, -24, -Math.PI / 2, 1, 'bravo-main'],
  ['bravo-court-4', 36, 0, -22, -Math.PI / 2, 1, 'bravo-main'],
  ['bravo-court-5', 36, 0, -20, -Math.PI / 2, 1, 'bravo-main'],
  ['bravo-market-1', -38, 0, -28, Math.PI + 0.35, 1, 'bravo-market'],
  ['bravo-transit-1', 31, 0, -32, Math.PI - 0.35, 1, 'bravo-transit'],
  ['bravo-plaza-1', 34, 0, -38, Math.PI - 0.15, 1, 'bravo-plaza'],
].map(([id, x, y, z, yaw, team, group]) => Object.freeze({
  id, position: v3(x, y, z), yaw, team, group, protectionRadius: 4,
  modes: Object.freeze(['tdm', 'bomb']),
})));

const squareCallouts = Object.freeze([
  // The low-priority district catch-all guarantees one spoken name for every standable
  // point; named subregions win deterministically where they overlap it.
  { id: 'district', name: 'District', box: volume(-42, -4, -42, 42, 14, 42), priority: -100 },
  { id: 'alpha-court', name: 'South Court', box: volume(-14, -1, 30, 14, 4, 42), priority: 10 },
  { id: 'bravo-court', name: 'North Court', box: volume(-14, -1, -42, 14, 4, -30), priority: 10 },
  { id: 'plaza-fountain', name: 'Fountain', box: volume(-13, -1, -12, 13, 4, 12), priority: 20 },
  { id: 'plaza-east', name: 'Plaza East', box: volume(13, -1, -18, 25, 5, 18), priority: 12 },
  { id: 'plaza-west', name: 'Plaza West', box: volume(-25, -1, -18, -13, 5, 18), priority: 12 },
  { id: 'civic-archive', name: 'Civic Archive', box: volume(-42, -1, -29, -20, 10, -5), priority: 30 },
  { id: 'civic-court', name: 'Archive Court', box: volume(-30, -1, -12, -16, 5, 11), priority: 25 },
  { id: 'market-arcade', name: 'Market Arcade', box: volume(-42, -1, 7, -20, 8, 29), priority: 20 },
  { id: 'market-alley', name: 'Delivery Alley', box: volume(-42, -1, 29, -14, 5, 42), priority: 18 },
  { id: 'transit-control', name: 'Transit Control', box: volume(20, -1, 5, 42, 10, 29), priority: 30 },
  { id: 'transit-platform', name: 'Platform', box: volume(16, -1, -14, 42, 5, 8), priority: 22 },
  { id: 'service-tunnel', name: 'Service Tunnel', box: volume(14, -1, 20, 42, 5, 42), priority: 18 },
  { id: 'upper-walk', name: 'Upper Walk', box: volume(-20, 3.5, -8, 20, 8, 8), priority: 40 },
]);

// The four pylons that flank the two ground-to-L1 ramps, as [x0, z0, x1, z1] footprints.
// They were 2.8 m cover blocks, and 2.8 m is the one height that is too tall to be cover
// and too short to be a wall: nothing can be reached from the ground, and a player who
// steps off the ramp deck lands on top of one with an eye at 4.42 m and an uninterrupted
// 63 m read straight across the district. §7.0's ceiling is 48 m. They are building
// height now, so the surface a player was standing on no longer exists.
const SQUARE_PYLONS = Object.freeze([
  Object.freeze([-21, -8, -17.5, -5.8]), Object.freeze([-21, -1.2, -17.5, 8]),
  Object.freeze([17.5, -8, 21, 1.2]), Object.freeze([17.5, 5.8, 21, 8]),
]);
const PYLON_H = 7.4;

// Elevated massing, as [x0, z0, x1, z1] footprints capped at UPPER_H.
//
// §7.0's 48 m ceiling and an 84 m district with three usable levels are in tension, and the
// tension is entirely above head height: at eye 1.62 m the plaza is already chopped into
// sub-16 m reads, while the upper walk (deck y 4), the two ramps and the signal deck (y 8)
// looked straight over every one of those breaks. So the breaks grow upward. Each footprint
// below is a blocker that ALREADY existed at 3.0–3.4 m; only its top moves. No footprint
// changes, so no nav node, no route, no cover distance and no ground sightline moves — the
// only rays that change are the ones that were passing over a wall at 5 m of eye height.
const SQUARE_UPPER_CAPS = Object.freeze([
  Object.freeze([-29, -13, -27, 13]), Object.freeze([27, -13, 29, 13]),
  Object.freeze([-18, -1, -11, 1]), Object.freeze([11, -1, 18, 1]),
  Object.freeze([-1, -16.5, 1, -11]), Object.freeze([-1, -8.5, 1, -5]),
  Object.freeze([-1, 5, 1, 8.5]), Object.freeze([-1, 11, 1, 16.5]),
  Object.freeze([-15, -34, -11, -13]), Object.freeze([11, 13, 15, 34]),
  Object.freeze([13, -27, 15, -18]), Object.freeze([-15, 18, -13, 27]),
]);
const UPPER_H = 7.4;   // = PYLON_H: one massing height, and 3.4 m clear of the walk deck

const squareRoofBlockers = Object.freeze([
  // Archive/market and transit roofs are backdrop, not traversable playspace. The
  // three usable levels are the plaza ground, upper walk, and signal bridge.
  volume(-42, 3.5, -42, -20, 4.5, 42),
  volume(20, 3.5, -42, 42, 4.5, 42),
  // Pylon caps, for the same reason and by the same rule. The nearest standable surface
  // is the upper walk at y 4, 5.5 m away horizontally and 3.4 m below — no step, no
  // mantle, no drop reaches them. Left unblocked the baker rasters four islands that are
  // walkable, unreachable, and counted as playspace by the analytics: the phantom-node
  // failure §3.5 names.
  ...SQUARE_PYLONS.map(([x0, z0, x1, z1]) => volume(x0, PYLON_H - 0.6, z0, x1, PYLON_H + 0.6, z1)),
  // Same rule and same height for the elevated massing caps. 7.4 m is not a round number:
  // the player's jump apex is 1.15 m and MANTLE_MAX_H is 1.35 m, so 2.50 m is exactly what
  // can be climbed, and a cap 3.4 m above the walk deck is the first height that cannot be.
  // A cap the player CAN reach is playspace and must not be declared blocked here.
  ...SQUARE_UPPER_CAPS.map(([x0, z0, x1, z1]) => volume(x0, UPPER_H - 0.6, z0, x1, UPPER_H + 0.6, z1)),
]);

export const MAP_MANIFEST = Object.freeze({
  bounds: Object.freeze(volume(-SQUARE_EDGE, -4, -SQUARE_EDGE, SQUARE_EDGE, 18, SQUARE_EDGE)),
  spawns: squareSpawns,
  objectives: Object.freeze([
    { id: 'site-A', kind: 'plant', site: 'A', box: volume(-21.75, 0, -19, -19.5, 2.4, -16.75), requiresGround: true },
    { id: 'site-B', kind: 'plant', site: 'B', box: volume(16, 0, 26, 18, 2.4, 28), requiresGround: true },
  ]),
  callouts: squareCallouts,
  navHints: Object.freeze({
    walkable: Object.freeze([
      volume(-42, -0.1, -42, 42, 0.35, 42),
      volume(-12, 3.8, -5, 12, 4.25, 5),
      volume(-2, 7.8, -5, 2, 8.25, 5),
    ]),
    // Boundary caps are unwalkable only while that removable layer is installed. Reuse
    // the layer objects instead of cloning them so consumers can subtract it exactly.
    blocked: Object.freeze([...squareRoofBlockers, ...COMPETITIVE_BOUNDARY]),
    links: Object.freeze([
      { from: v3(-21.5, 0, -3), to: v3(-12, 4, -3), kind: 'stair' },
      { from: v3(21.5, 0, 3), to: v3(12, 4, 3), kind: 'stair' },
      { from: v3(-9.5, 4, 3), to: v3(-1.5, 8, 3), kind: 'stair' },
      { from: v3(9.5, 4, -3), to: v3(1.5, 8, -3), kind: 'stair' },
    ]),
    cover: Object.freeze([
      { position: v3(-8, 0, -9), facing: 0 }, { position: v3(8, 0, 9), facing: Math.PI },
      { position: v3(-25, 0, -10), facing: Math.PI / 2 }, { position: v3(25, 0, 10), facing: -Math.PI / 2 },
    ]),
  }),
  budgets: Object.freeze({
    profileId: 'ref-integrated-1080p', drawCalls: 140, triangles: 300000,
    materials: 48, lights: 6, colliders: 1200,
  }),
});

/** Exact manifest projection for embedding the district without its competitive wall. */
export function squareManifest({ competitiveBoundary = true } = {}) {
  if (competitiveBoundary) return MAP_MANIFEST;
  return Object.freeze({
    ...MAP_MANIFEST,
    navHints: Object.freeze({
      ...MAP_MANIFEST.navHints,
      blocked: squareRoofBlockers,
    }),
  });
}

/** Empty, collision-free commercial placements. They are metadata, never ad content. */
export const COMMERCIAL_ANCHORS = Object.freeze([
  { id: 'sponsor.event.plaza-east', position: v3(17, 2.2, -7), yaw: -Math.PI / 2, maxSize: v3(3.6, 1.8, 0.08), visibleFrom: ['plaza-fountain'], emissiveMax: 0.15 },
  { id: 'sponsor.rooftop.transit', position: v3(30, 7.2, 17), yaw: Math.PI, maxSize: v3(4.0, 1.4, 0.08), visibleFrom: ['transit-platform'], emissiveMax: 0.1 },
  { id: 'sponsor.billboard.market-north', position: v3(-30, 4.8, 8), yaw: 0, maxSize: v3(4.5, 2.0, 0.08), visibleFrom: ['market-arcade'], emissiveMax: 0.12 },
  { id: 'storefront.market.01', position: v3(-40, 2.0, 13), yaw: Math.PI / 2, maxSize: v3(2.4, 1.2, 0.05), visibleFrom: ['market-arcade'], emissiveMax: 0 },
  { id: 'storefront.market.02', position: v3(-40, 2.0, 21), yaw: Math.PI / 2, maxSize: v3(2.4, 1.2, 0.05), visibleFrom: ['market-arcade'], emissiveMax: 0 },
  { id: 'storefront.civic.01', position: v3(-27, 2.0, -28), yaw: 0, maxSize: v3(2.4, 1.2, 0.05), visibleFrom: ['civic-archive'], emissiveMax: 0 },
  { id: 'storefront.civic.02', position: v3(-35, 2.0, -28), yaw: 0, maxSize: v3(2.4, 1.2, 0.05), visibleFrom: ['civic-archive'], emissiveMax: 0 },
]);

/** Build The Square. Architecture remains when COMPETITIVE_BOUNDARY is omitted in P6. */
export function buildLevel(game, world, { competitiveBoundary = true } = {}) {
  const B = new Builder(game, world);
  world.manifest = squareManifest({ competitiveBoundary });
  world.setBounds(MAP_MANIFEST.bounds.min, MAP_MANIFEST.bounds.max);
  buildSquareGround(B);
  buildSquareDistrict(B);
  if (competitiveBoundary) buildSquareBoundary(B);
  const stats = B.finish();
  world.buildStats.drawCalls = stats.meshes + stats.instanced;
  world.buildStats.triangles = Math.round(stats.triangles);
  world.buildStats.colliders = world.boxes.length;
}

/**
 * MERIDIAN — un-retired into the lobby offering by owner decision (map-data.md §9, 1.4.0
 * amendment): rooms may select it explicitly for TDM and Bomb alongside 'the-square'.
 *
 * The manifest is deliberately PARTIAL: only `objectives` is declared. The two site boxes
 * are the volumes `scripts/bottest.mjs` proved 65 rounds of autonomous Bomb against
 * (plants and defuses at both) — each a 3 m box centred on a `nav.nearestWalkable`
 * point at opposite corners of the district. Everything else (bounds, spawns) stays
 * DERIVED from the built geometry, which keeps `provenance.spawns === 'derived'` and
 * therefore keeps the spawner's mode-filter fallback in play — derived spawns carry
 * `modes: ['tdm']` as a stamp, not an authored answer. Callouts, navHints and a
 * COMPETITIVE_BOUNDARY remain unauthored and are recorded as gaps by `manifestGaps()`.
 *
 * Version 1.0.0-fixture → 1.1.0: declaring objective volumes is map data, not test data,
 * and a map offered to a lobby room should not carry a '-fixture' version on the wire.
 */
export const MERIDIAN_FIXTURE = Object.freeze({
  MAP_ID: 'meridian',
  MAP_VERSION: '1.1.0',
  buildLevel: buildMeridianFixture,
  MAP_MANIFEST: Object.freeze({
    // §3.6 — the contract-default allocation, declared because geomtest requires
    // `budgets.colliders` to be a declared, finite number (measured: 1085, comfortably in).
    budgets: Object.freeze({
      profileId: 'ref-integrated-1080p', drawCalls: 140, triangles: 300000,
      materials: 48, lights: 6, colliders: 1200,
    }),
    objectives: Object.freeze([
      { id: 'site-A', kind: 'plant', site: 'A', box: volume(-26.88, 0, -21.63, -23.88, 2.4, -18.63), requiresGround: true },
      { id: 'site-B', kind: 'plant', site: 'B', box: volume(23.38, 0, 18.88, 26.38, 2.4, 21.88), requiresGround: true },
    ]),
  }),
});

function buildSquareGround(B) {
  B.groundPlane(-42, -42, 42, 42, 0, 'concreteDark', 'concrete');
  B.floorFinish(-14, -14, 14, 14, 0.02, 'tile', { cast: false });
  B.floorFinish(-41, 8, -20, 29, 0.025, 'brick', { cast: false });
  B.floorFinish(20, -14, 41, 29, 0.025, 'asphalt', { cast: false });
  // Directional paving breaks orientation without introducing a second callout vocabulary.
  for (let z = -36; z <= 36; z += 8) B.deco(-1.8, 0.03, z, 1.8, 0.045, z + 2.4, 'concrete', { cast: false });
}

function buildingShell(B, x0, z0, x1, z1, material, doors = []) {
  const t = 0.45;
  const bySide = (side) => doors.filter((d) => d.side === side).map((d) => ({
    a0: d.a0, a1: d.a1, y0: 0, y1: 2.8, frame: 'door',
  }));
  B.wall(x0, z0, x1, z0 + t, 0, 7.4, material, 'concrete', { openings: bySide('north') });
  B.wall(x0, z1 - t, x1, z1, 0, 7.4, material, 'concrete', { openings: bySide('south') });
  B.wall(x0, z0, x0 + t, z1, 0, 7.4, material, 'concrete', { openings: bySide('west') });
  B.wall(x1 - t, z0, x1, z1, 0, 7.4, material, 'concrete', { openings: bySide('east') });
  B.box(x0, 3.8, z0, x1, 4.0, z1, 'concreteDark', 'concrete');
}

function buildSquareDistrict(B) {
  // Civic Archive / Site A: orthogonal cover, two public entries and a service court.
  buildingShell(B, -40, -29, -20, -7, 'plaster', [
    { side: 'south', a0: -36, a1: -32 }, { side: 'east', a0: -20, a1: -16 },
    { side: 'north', a0: -28, a1: -24 },
  ]);
  B.box(-38, 0, -26, -36, 2.3, -14, 'concreteDark', 'concrete');
  B.box(-31, 0, -23, -29, 1.5, -12, 'concrete', 'concrete');
  B.box(-25, 0, -25, -22, 1.1, -20, 'concrete', 'concrete');
  B.parapet(-40, -29, -20, -29, 4, 1.0, 'concreteDark');
  B.parapet(-40, -7, -20, -7, 4, 1.0, 'concreteDark');

  // Transit Control / Site B: broken machinery cover and an independently reachable mezzanine.
  buildingShell(B, 20, 7, 40, 29, 'concreteDark', [
    { side: 'north', a0: 24, a1: 28 }, { side: 'west', a0: 12, a1: 16 },
    { side: 'south', a0: 31, a1: 35 },
  ]);
  B.box(23, 0, 11, 27, 1.4, 15, 'metal', 'metal');
  B.box(31, 0, 14, 34, 2.0, 17, 'concrete', 'concrete');
  B.box(36, 0, 19, 38, 1.2, 26, 'metal', 'metal');
  B.box(25, 0, 16, 30.5, 3.0, 26, 'concreteDark', 'concrete');
  B.parapet(20, 7, 40, 7, 4, 1.0, 'metal');
  B.parapet(20, 29, 40, 29, 4, 1.0, 'metal');

  // Market Row and service tunnel form the concealed rotations around the open plaza.
  for (const z of [9, 17, 25]) {
    B.box(-41, 0, z, -34, 3.4, z + 5, 'brick', 'concrete');
    B.deco(-33.95, 2.2, z + 0.4, -33.85, 2.45, z + 4.6, 'tile', { cast: false });
  }
  B.box(-29, 0, 8, -27, 2.1, 28, 'concreteDark', 'concrete');
  B.box(27, 0, 30, 29, 2.5, 41, 'concreteDark', 'concrete');
  B.box(36, 0, 30, 38, 2.5, 41, 'concreteDark', 'concrete');

  // Framed transit glazing is consistent and shoot-through: movement is blocked, sight is
  // not. Panels are freestanding in their openings so no glass is entombed in masonry.
  for (const x of [-18, 18]) {
    for (const z of [-37, -29, -21, -13, -5, 13, 21, 29, 37]) {
      if ((x === -18 || x === 18) && z === -5) continue; // ramp mouths / cross-lane screen
      B.box(x - 0.025, 0.35, z - 1.7, x + 0.025, 3.05, z + 1.7, 'glass', 'glass',
        { cast: false, receive: false });
    }
  }
  for (const z of [-18, 18]) {
    for (const x of [-12, -7, -2, 3, 8]) {
      B.box(x, 0.35, z - 0.025, x + 3.5, 3.05, z + 0.025, 'glass', 'glass',
        { cast: false, receive: false });
    }
  }

  // Central square: broken cover and a dry fountain around the offset Signal Spire.
  B.box(-11, 0, -10, -7, 1.0, -4, 'concrete', 'concrete');
  B.box(7, 0, 4, 11, 1.0, 10, 'concrete', 'concrete');
  B.box(-10, 0, 7, -4, 0.75, 10, 'concrete', 'concrete');
  B.box(4, 0, -10, 10, 0.75, -7, 'concrete', 'concrete');
  // The civic memorial wall breaks the spawn-to-spawn axis and makes the fast plaza
  // route commit to an east or west shoulder instead of becoming an 88 m rifle lane.
  B.box(-13, 0, -1, 13, 3.0, 1, 'plaster', 'concrete');
  B.cylinder(-15, 0, 0, 1.45, 10.5, 12, 'metal', 'metal', { collide: true });
  B.cylinder(-15, 10.5, 0, 0.45, 2.2, 10, 'metal', 'metal', { collide: false });
  // The upper information route crosses the plaza but never becomes a dominant roof.
  B.box(-12, 3.8, -5, 12, 4.0, 5, 'concreteDark', 'concrete');
  B.box(-2, 7.8, -5, 2, 8.0, 5, 'concreteDark', 'concrete');
  B.box(-12, 7.8, -5, -10, 8.0, 1.5, 'concreteDark', 'concrete');
  B.box(10, 7.8, -1.5, 12, 8.0, 5, 'concreteDark', 'concrete');
  B.ramp({ x0: -20, z0: -5, x1: -12, z1: -2, y0: 0, y1: 4, dir: '+x', matName: 'concrete' });
  B.ramp({ x0: 12, z0: 2, x1: 20, z1: 5, y0: 0, y1: 4, dir: '-x', matName: 'concrete' });
  B.ramp({ x0: -10, z0: 2, x1: -2, z1: 5, y0: 4, y1: 8, dir: '+x', matName: 'concrete' });
  B.ramp({ x0: 2, z0: -5, x1: 10, z1: -2, y0: 4, y1: 8, dir: '-x', matName: 'concrete' });
  B.parapet(-12, -5, 2, -5, 8, 1.0, 'concreteDark');
  B.parapet(-2, 5, 12, 5, 8, 1.0, 'concreteDark');

  // Deliberate sightline breaks between opposing courts and across the service routes.
  // The two long court slabs and the two middle baffle segments carry the elevated
  // diagonals off the ramps as well as the ground read, so they run to UPPER_H. At 4.2 m
  // and 3.4 m a player on either ramp looked straight over them and out to the district
  // edge; nothing at ground level changes, because a 1.62 m eye never saw past them.
  B.box(-15, 0, -34, -11, UPPER_H, -13, 'plaster', 'concrete');
  B.box(11, 0, 13, 15, UPPER_H, 34, 'concreteDark', 'concrete');
  B.box(-4, 0, -28, 4, 2.2, -24, 'concrete', 'concrete');
  B.box(-4, 0, 24, 4, 2.2, 28, 'concrete', 'concrete');
  B.box(-8, 0, -21, 8, 2.8, -19, 'plaster', 'concrete');
  B.box(-8, 0, 19, 8, 2.8, 21, 'plaster', 'concrete');
  // These pylons flank rather than occupy the two ground-to-L1 ramps: each ramp mouth
  // keeps its 4.6 m gap, so no route through them changes.
  for (const [x0, z0, x1, z1] of SQUARE_PYLONS) {
    B.box(x0, 0, z0, x1, PYLON_H, z1, 'concreteDark', 'concrete');
  }
  // The two long plaza-flank screens carry the cardinal east/west read off the upper walk,
  // which is why they run to UPPER_H rather than the 3.0 m that only stopped a ground eye.
  B.box(-29, 0, -13, -27, UPPER_H, 13, 'concreteDark', 'concrete');
  B.box(27, 0, -13, 29, UPPER_H, 13, 'concreteDark', 'concrete');
  // Long baffles are deliberately broken into staggered segments. Solid lines across a
  // district make a fine ray-test wall and an unplayable map: these gaps preserve the
  // sightline break while keeping every court connected to both sites.
  // The middle segment is emitted only on the side where the taller sightline-break slab
  // above does not already occupy it. West of the plaza that slab spans x -15..-11 over
  // z -34..-13 and swallowed the x=-14 / z -27..-18 segment whole; the mirror swallowed
  // x=+14 / z 18..27. A box wholly inside another is inert — it blocks nothing the
  // enclosing box did not already block, contradicts §3.1's "no third state", and still
  // costs every move/raycast/losClear query against the §3.6 collider budget.
  for (const x of [-14, 14]) {
    // The outer segments end at |z| = 30, not 31. At 31 they left a 1 m slot that the
    // nav raster samples at z = -30.9 and z = 30.6, and that slot was a clear 52 m
    // ground lane the length of the service road — the only >48 m reads left at eye
    // height. The staggered gap that keeps the courts connected is 3 m instead of 4.
    B.box(x - 1, 0, -42, x + 1, 3.4, -30, 'plaster', 'concrete');
    if (x > 0) B.box(x - 1, 0, -27, x + 1, UPPER_H, -18, 'plaster', 'concrete');
    if (x < 0) B.box(x - 1, 0, 18, x + 1, UPPER_H, 27, 'plaster', 'concrete');
    B.box(x - 1, 0, 30, x + 1, 3.4, 42, 'plaster', 'concrete');
  }
  // Offset cover closes the only >48 m diagonal through the north-east service gap
  // without turning that gap into a sealed wall.
  B.box(11, 0, -30.5, 16, 2.8, -27, 'concreteDark', 'concrete');
  B.box(25.5, 0, -19, 30, 2.8, -17, 'plaster', 'concrete');
  B.box(-30, 0, -19, -27, 2.8, -17, 'plaster', 'concrete');
  // The outer cross-runs stop at |x| = 29, not 29.5. The half-metre slot they left between
  // themselves and the plaza-flank screens at |x| 27..29 was a 48 m north-south ground lane
  // the full depth of the market and transit flanks — the last one at eye height. The
  // rotation gap between the two runs is 2 m rather than 2.5 and is still walkable.
  for (const z of [-14, 14]) {
    B.box(-42, 0, z - 1, -29, 3.4, z + 1, 'concreteDark', 'concrete');
    B.box(-27, 0, z - 1, -19, 3.4, z + 1, 'concreteDark', 'concrete');
    B.box(19, 0, z - 1, 27, 3.4, z + 1, 'concreteDark', 'concrete');
    B.box(29, 0, z - 1, 42, 3.4, z + 1, 'concreteDark', 'concrete');
  }
  // Upper-storey skyline returns: a closed clerestory ring 29.5 m out, from y 3.0 — clear of
  // a standing player — to y 12. It is the ONLY thing on this map that bounds an elevated
  // ray without shortening it: a lane off the walk or the signal deck used to run to the
  // 42 m boundary at 48–63 m, and it now ends at the ring at 30–38 m, which is still inside
  // §7.1's long band. Blocking the same lane close to its source would have satisfied the
  // ceiling by deleting the long read instead of framing it.
  //
  // The four faces run unbroken. They were authored with a 16 m opening on each face on the
  // argument that it preserved the cardinal reads, and the opening was exactly where every
  // remaining breach went: the elevated routes sit on the spine, so the spine axes are the
  // lanes, and an opening centred on them opens the only ones that were over.
  //
  // Nothing below 3.0 m exists here, so no ground route, ground sightline, cover distance
  // or nav node is touched — the ring is invisible to everything except an elevated eye.
  // 29.5, not 30: the last ray over the ceiling was the 45-degree diagonal off the signal
  // ramp into the ring's inside corner, at 48.3 m. The corner is the furthest point of a
  // square ring from its centre, so it is the one place the ring is weakest, and half a
  // metre of inset is what that corner was over by.
  for (const x of [-29.5, 29.5]) B.box(x - 0.5, 3.0, -29.5, x + 0.5, 12, 29.5, 'plaster', 'concrete');
  for (const z of [-29.5, 29.5]) B.box(-29.5, 3.0, z - 0.5, 29.5, 12, z + 0.5, 'concreteDark', 'concrete');
  // The four spine fins run to UPPER_H: at 3.4 m their tops were a step down off the walk
  // deck, so a player who left the walk stood at eye 5.02 m with the plaza spine to
  // themselves. There is no surface there now.
  B.box(-1, 0, -16.5, 1, UPPER_H, -11, 'plaster', 'concrete');
  B.box(-1, 0, -8.5, 1, UPPER_H, -5, 'plaster', 'concrete');
  B.box(-1, 0, 5, 1, UPPER_H, 8.5, 'plaster', 'concrete');
  B.box(-1, 0, 11, 1, UPPER_H, 16.5, 'plaster', 'concrete');
  B.box(-18, 0, -1, -11, UPPER_H, 1, 'concreteDark', 'concrete');
  B.box(-7, 0, -1, -5, 3.4, 1, 'concreteDark', 'concrete');
  B.box(5, 0, -1, 7, 3.4, 1, 'concreteDark', 'concrete');
  B.box(11, 0, -1, 18, UPPER_H, 1, 'concreteDark', 'concrete');
  for (const x of [-14, 14]) {
    for (const z of [-14, 14]) {
      B.box(x - 3, 0, z - 3, x + 3, 2.8, z + 3, 'concrete', 'concrete');
    }
  }
}

function buildSquareBoundary(B) {
  for (const box of COMPETITIVE_BOUNDARY) {
    B.box(box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z,
      'concreteDark', 'boundary');
  }
}

// ── SQUARE EXTRACTION — P3-06 graybox expansion ──────────────────────────────────────
//
// The Square district embedded as the central high-risk POI of an extraction raid map,
// with two adjoining graybox sectors around it:
//
//   RAIL YARD  (north, z −100…−44)  a freight yard: warehouse with a mezzanine interior,
//                                   container alleys, a watchtower over the approach into
//                                   the district's north court, and the RAIL GATE exit.
//   EAST DOCKS (east, x 44…100)     a quay: customs shed interior, crane, container
//                                   stacks, an elevated pier walk along the sea wall, and
//                                   the FERRY LANDING exit.
//
// This is a NEW map entry (map-data.md's registry pattern, same shape as
// MERIDIAN_FIXTURE), NOT a mutation of the competitive Square: 'the-square' keeps its
// certified geometry, manifest, and version untouched — sectortest.mjs explicitly asserts
// the competitive map declares no sectors, and its siteoutcome/sightline certification
// must not be re-litigated by a graybox slice. The district builder functions are reused
// verbatim; only the removable COMPETITIVE_BOUNDARY layer is omitted (map-data.md §5 —
// which is exactly what that layer exists for).
//
// Sectors follow sector-interest.md §3/§3.1: three AABBs that tile the playable bounds
// with no gaps and no overlap; ids are stable strings, never indices. Extraction exits
// and loot-container spawn points follow extraction-match.md §4 / §3.1 and are exported
// on the map entry in exactly the shapes `ExtractionRun` consumes (`opts.exits`,
// `opts.containers`).

const XM_ID = 'square-extraction';
const XM_VERSION = '0.1.0';

// Playable bounds. The three sector boxes below tile this exactly:
//   square      (−44…44)  × (−44…44)
//   north-yard  (−44…44)  × (−100…−44)
//   east-docks  (44…100)  × (−100…44)
const XM_BOUNDS = Object.freeze(volume(-44, -4, -100, 100, 18, 44));

export const EXTRACTION_SECTORS = Object.freeze([
  {
    id: 'square',
    box: volume(-44, -4, -44, 44, 18, 44),
    neighbours: Object.freeze(['north-yard', 'east-docks']),
    populationCap: 12,
    baseThinkStride: 8,
  },
  {
    id: 'north-yard',
    box: volume(-44, -4, -100, 44, 18, -44),
    neighbours: Object.freeze(['square', 'east-docks']),
    populationCap: 10,
    baseThinkStride: 12,
  },
  {
    id: 'east-docks',
    box: volume(44, -4, -100, 100, 18, 44),
    neighbours: Object.freeze(['square', 'north-yard']),
    populationCap: 10,
    baseThinkStride: 12,
  },
]);

/**
 * Extraction exits — extraction-match.md §4's `ExtractionExit` shape verbatim, consumable
 * as `ExtractionRun`'s `opts.exits`. Both are conditional, per the Build Plan's "two
 * conditional exits" slice, and every condition references only vocabulary the shipped
 * P3-11 content module defines (`src/game/extractionContent.js` — the single authored
 * catalog `scripts/extractiontest.mjs` validates):
 *   - rail-gate is window-gated (activeWindow, run-relative ticks at the 120 Hz fixed
 *     step): open from infil until the RUN_RULES collapse warning — 840 s of the 900 s
 *     hard timeout — so a run that never finds a keycard is never stranded; only the
 *     final collapse minute has no item-free way out.
 *   - ferry-landing is item-gated on `keycard_transit` (P3-11's epic material, which
 *     rolls only from `lt.tier2.cache` — the district's tier-2 caches — so risk buys
 *     the quay exit).
 *
 * This array is THE authoritative exit set for map 'square-extraction' (its ids anchor
 * to the rail-gate / ferry-landing callouts and built geometry above). The content
 * module's own `EXTRACTION_EXITS` (exit-transit-gate / exit-market-van) were authored
 * concurrently against the district-only slice; REQ-CC-074 reconciles the two so runs
 * on this map consume exactly one set.
 */
export const EXTRACTION_EXITS = Object.freeze([
  {
    id: 'exit-rail-gate',
    volume: volume(-40, 0, -98, -32, 3, -92),
    // 0…840 s at 120 Hz: closes when RUN_RULES' 60 s collapse warning begins, mirroring
    // the P3-11 window exit so an item-less player always has an exit before collapse.
    activeWindow: Object.freeze([0, 100800]),
    durationSeconds: 6,
  },
  {
    id: 'exit-ferry-landing',
    volume: volume(88, 0, 32, 98, 3, 40),
    requiresItemDefId: 'keycard_transit',   // P3-11 item; rolls from lt.tier2.cache
    durationSeconds: 8,
  },
]);

/**
 * Static loot-container spawn points — extraction-match.md §3.1's static-container shape,
 * consumable as `ExtractionRun`'s `opts.containers`. Two tiers, per §3.1 (`tier` is an
 * int, 1|2 for this slice) and the Build Plan's two-tier slice; `lootTableId` values are
 * the shipped P3-11 tables (`LOOT_TABLES` in `src/game/extractionContent.js`), so every
 * roll resolves against defined contents. The Square POI carries tier 2 (risk pays — and
 * `keycard_transit`, the ferry exit's gate, rolls only there); the flanking sectors carry
 * tier 1. Container ids are stable forever (evidence's `lootEvents` reference them).
 *
 * As with the exits above, this is THE authoritative container set for map
 * 'square-extraction'; the content module's district-only `STATIC_CONTAINERS` are the
 * concurrent duplicate REQ-CC-074 reconciles.
 */
export const LOOT_CONTAINERS = Object.freeze([
  { containerId: 'c-square-fountain', tier: 2, lootTableId: 'lt.tier2.cache', position: v3(5.5, 0, -5.5) },
  { containerId: 'c-square-transit', tier: 2, lootTableId: 'lt.tier2.cache', position: v3(33, 0, 11.5) },
  { containerId: 'c-square-archive', tier: 2, lootTableId: 'lt.tier2.cache', position: v3(-27, 0, -26) },
  { containerId: 'c-warehouse-mezz', tier: 1, lootTableId: 'lt.tier1.cache', position: v3(-28, 3.6, -77) },
  { containerId: 'c-warehouse-floor', tier: 1, lootTableId: 'lt.tier1.cache', position: v3(-14, 0, -84) },
  { containerId: 'c-customs-shed', tier: 1, lootTableId: 'lt.tier1.cache', position: v3(71, 0, -14) },
  { containerId: 'c-pier-walk', tier: 1, lootTableId: 'lt.tier1.cache', position: v3(96, 3.8, -20) },
  { containerId: 'c-container-alley', tier: 1, lootTableId: 'lt.tier1.cache', position: v3(14, 0, -83) },
  { containerId: 'c-quay-open', tier: 1, lootTableId: 'lt.tier1.cache', position: v3(56, 0, 20) },
]);

// Raid perimeter — the extraction map's own outer wall, reused for collision AND for the
// nav `blocked` list so the baker never rasters phantom nodes on the 1 m wall tops (the
// same double duty COMPETITIVE_BOUNDARY performs on the competitive map).
const XM_PERIMETER = Object.freeze([
  volume(-44, 0, -100, 100, 15, -99),   // north
  volume(-44, 0, 43, 100, 15, 44),      // south
  volume(-44, 0, -100, -43, 15, 44),    // west
  volume(99, 0, -100, 100, 15, 44),     // east
]);

// Freight containers, as [x0, z0, x1, z1] footprints at CONTAINER_H. 2.8 m: above the
// 2.50 m jump-plus-mantle ceiling, so tops are NOT playspace and every one gets a blocked
// cap below (the phantom-node rule, map-data.md §3.5).
const XM_CONTAINERS = Object.freeze([
  // Rail-yard rows A/B — two staggered rows forming an east-west alley.
  Object.freeze([4, -88, 10, -85.4]), Object.freeze([12, -88, 18, -85.4]),
  Object.freeze([20, -88, 26, -85.4]), Object.freeze([28, -88, 34, -85.4]),
  Object.freeze([8, -80, 14, -77.4]), Object.freeze([16, -80, 22, -77.4]),
  Object.freeze([24, -80, 30, -77.4]), Object.freeze([32, -80, 38, -77.4]),
  // Dock stacks, scattered on the north quay.
  Object.freeze([52, -90, 58, -87.4]), Object.freeze([62, -84, 68, -81.4]),
  Object.freeze([74, -92, 80, -89.4]), Object.freeze([82, -78, 88, -75.4]),
  Object.freeze([54, -66, 60, -63.4]), Object.freeze([70, -60, 76, -57.4]),
]);
const CONTAINER_H = 2.8;
// One double-stack landmark on the quay; its cap is blocked at its own height.
const XM_STACK = Object.freeze([64, -74, 70, -71.4]);
const STACK_H = 5.6;

const xmRoofBlockers = Object.freeze([
  // District roofs, pylon caps and upper-massing caps: same surfaces, same rule.
  ...squareRoofBlockers,
  // Container and stack tops (see XM_CONTAINERS above).
  ...XM_CONTAINERS.map(([x0, z0, x1, z1]) => volume(x0, CONTAINER_H - 0.6, z0, x1, CONTAINER_H + 0.6, z1)),
  volume(XM_STACK[0], STACK_H - 0.6, XM_STACK[1], XM_STACK[2], STACK_H + 0.6, XM_STACK[3]),
  // The raid perimeter wall tops.
  ...XM_PERIMETER,
]);

const xmSpawns = Object.freeze([
  // Extraction infil points sit in the flanking sectors, never inside the POI. Team −1:
  // extraction squads are not alpha/bravo. 'tdm' is retained so headless harnesses that
  // spawn probe bots by mode (vertprobe) can drive the map.
  ['xs-rail-1', -38, 0, -70, Math.PI / 2, 'infil-rail'],
  ['xs-rail-2', -38, 0, -75, Math.PI / 2, 'infil-rail'],
  ['xs-rail-3', -38, 0, -80, Math.PI / 2, 'infil-rail'],
  ['xs-depot-1', 32, 0, -52, Math.PI, 'infil-depot'],
  ['xs-depot-2', 36, 0, -56, Math.PI, 'infil-depot'],
  ['xs-depot-3', 30, 0, -60, Math.PI, 'infil-depot'],
  ['xs-quay-1', 84, 0, 26, -Math.PI / 2, 'infil-quay'],
  ['xs-quay-2', 88, 0, 22, -Math.PI / 2, 'infil-quay'],
  ['xs-quay-3', 80, 0, 18, -Math.PI / 2, 'infil-quay'],
].map(([id, x, y, z, yaw, group]) => Object.freeze({
  id, position: v3(x, y, z), yaw, team: -1, group, protectionRadius: 4,
  modes: Object.freeze(['extraction', 'tdm']),
})));

const xmCallouts = Object.freeze([
  // Whole-map catch-all first (lowest priority), then the district's own vocabulary —
  // the SAME names players already use on the competitive Square — then the new ground.
  { id: 'outlands', name: 'Outlands', box: volume(-44, -4, -100, 100, 14, 44), priority: -200 },
  ...squareCallouts,
  { id: 'rail-yard', name: 'Rail Yard', box: volume(-43, -1, -99, 44, 10, -44), priority: -50 },
  { id: 'warehouse', name: 'Warehouse', box: volume(-32, -1, -90, -8, 8, -64), priority: 20 },
  { id: 'warehouse-mezzanine', name: 'Warehouse Mezzanine', box: volume(-32, 3.4, -90, -24, 5.4, -64), priority: 40 },
  { id: 'container-rows', name: 'Container Rows', box: volume(2, -1, -92, 40, 6, -72), priority: 15 },
  { id: 'watchtower', name: 'Watchtower', box: volume(-2, 3.5, -56, 4, 5.6, -50), priority: 40 },
  { id: 'rail-gate', name: 'Rail Gate', box: volume(-42, -1, -99, -30, 5, -90), priority: 30 },
  { id: 'east-docks', name: 'East Docks', box: volume(44, -1, -99, 99, 10, 43), priority: -50 },
  { id: 'customs-shed', name: 'Customs Shed', box: volume(60, -1, -20, 84, 8, 4), priority: 20 },
  { id: 'pier-walk', name: 'Pier Walk', box: volume(93, 3.5, -45, 98.5, 5.6, 15), priority: 40 },
  { id: 'crane-yard', name: 'Crane Yard', box: volume(48, -1, -95, 92, 8, -48), priority: 10 },
  { id: 'ferry-landing', name: 'Ferry Landing', box: volume(86, -1, 30, 99, 5, 43), priority: 30 },
]);

export const EXTRACTION_MANIFEST = Object.freeze({
  bounds: XM_BOUNDS,
  spawns: xmSpawns,
  // No bomb sites on a raid map: extraction "objectives" are the exits/containers above,
  // which are extraction-match.md's vocabulary, not map-data §3.3's.
  objectives: Object.freeze([]),
  callouts: xmCallouts,
  sectors: EXTRACTION_SECTORS,
  navHints: Object.freeze({
    walkable: Object.freeze([
      volume(-43, -0.1, -99, 99, 0.35, 43),
      // District elevated route (identical to the competitive declaration).
      volume(-12, 3.8, -5, 12, 4.25, 5),
      volume(-2, 7.8, -5, 2, 8.25, 5),
      // Warehouse mezzanine, watchtower deck, pier walk.
      volume(-32, 3.4, -90, -24, 3.85, -64),
      volume(-2, 3.6, -56, 4, 4.05, -50),
      volume(93, 3.6, -45, 98.5, 4.05, 15),
    ]),
    blocked: xmRoofBlockers,
    links: Object.freeze([
      // District (identical to the competitive declaration).
      { from: v3(-21.5, 0, -3), to: v3(-12, 4, -3), kind: 'stair' },
      { from: v3(21.5, 0, 3), to: v3(12, 4, 3), kind: 'stair' },
      { from: v3(-9.5, 4, 3), to: v3(-1.5, 8, 3), kind: 'stair' },
      { from: v3(9.5, 4, -3), to: v3(1.5, 8, -3), kind: 'stair' },
      // Warehouse mezzanine stair, watchtower ramp, pier stairs, pier drop-down.
      { from: v3(-16, 0, -76.8), to: v3(-25, 3.6, -76.8), kind: 'stair' },
      { from: v3(13, 0, -54), to: v3(1, 3.8, -54), kind: 'stair' },
      { from: v3(94.7, 0, 20), to: v3(94.7, 3.8, 13), kind: 'stair' },
      { from: v3(94.7, 0, -50), to: v3(94.7, 3.8, -43), kind: 'stair' },
    ]),
    cover: Object.freeze([
      { position: v3(-8, 0, -9), facing: 0 }, { position: v3(8, 0, 9), facing: Math.PI },
      { position: v3(14, 0, -84), facing: Math.PI }, { position: v3(-20, 0, -62), facing: 0 },
      { position: v3(66, 0, -76), facing: -Math.PI / 2 }, { position: v3(90, 0, 0), facing: -Math.PI / 2 },
    ]),
  }),
  budgets: Object.freeze({
    // Graybox raid allocation: ~2.7× the competitive footprint, still inside the
    // ARCHITECTURE.md §11 whole-scene ceiling with the same reserved shares.
    profileId: 'ref-integrated-1080p', drawCalls: 180, triangles: 360000,
    materials: 48, lights: 6, colliders: 1800,
  }),
});

/**
 * Build the extraction raid map: the district POI plus the two graybox sectors.
 *
 * P3-07: every sector's visuals are built inside `B.setSector(...)` so the Builder lands
 * them in one `sector:<id>` group per EXTRACTION_SECTORS entry (colliders are never
 * sector-tagged — see the Builder's own note). `opts.dressing === false` skips the
 * signage and sponsor-slot dressing layers; the P3-07 harness (`scripts/uistream.mjs`)
 * builds the map both ways in colliders-only mode and asserts the collider sets are
 * BYTE-IDENTICAL — the proof that dressing changes neither collision nor any
 * server-checked sightline.
 */
export function buildExtractionLevel(game, world, opts = {}) {
  const dressing = opts.dressing !== false;
  const B = new Builder(game, world);
  world.setBounds(XM_BOUNDS.min, XM_BOUNDS.max);
  // The Square district, verbatim, WITHOUT its removable competitive boundary layer.
  B.setSector('square');
  buildSquareGround(B);
  buildSquareDistrict(B);
  buildExtractionGround(B);          // sets its own per-tile sectors
  B.setSector('north-yard');
  buildRailYard(B);
  B.setSector('east-docks');
  buildEastDocks(B);
  // The raid perimeter spans all three sectors: shared, never streamed out.
  B.setSector(null);
  buildExtractionPerimeter(B);
  buildLootMarkers(B);
  if (dressing) {
    buildExtractionSignage(B);
    buildSponsorSlots(B);
  }
  B.setSector(null);
  const stats = B.finish();
  world.buildStats.drawCalls = stats.meshes + stats.instanced;
  world.buildStats.triangles = Math.round(stats.triangles);
  world.buildStats.colliders = world.boxes.length;
  // Client-side streaming controller, driven per-frame from the FX facade (CX-owned
  // frame hook). Hangs off the THREE group's userData so no CC-owned object grows a
  // new property. Inert headlessly: colliders-only builds produce no sector groups.
  world.group.userData.sectorStreaming = createSectorStreaming({
    sectors: EXTRACTION_SECTORS,
    groups: B.sectorGroups,
  });
}

/** Registry entry, same shape as MERIDIAN_FIXTURE. Out of rotation: extraction runs
 *  select this map by id; the competitive rotation stays TDM/Bomb on 'the-square'. */
export const SQUARE_EXTRACTION = Object.freeze({
  MAP_ID: XM_ID,
  MAP_VERSION: XM_VERSION,
  MAP_MANIFEST: EXTRACTION_MANIFEST,
  // Deliberately empty, not absent: this map HAS no competitive boundary — that is the
  // §5 embedding — and an empty declared layer says so, where a missing export would
  // read as an unfinished manifest.
  COMPETITIVE_BOUNDARY: Object.freeze([]),
  EXTRACTION_EXITS,
  LOOT_CONTAINERS,
  buildLevel: buildExtractionLevel,
});

function buildExtractionGround(B) {
  // Non-overlapping tiles around the district's own −42…42 ground, each tagged with the
  // sector its area lies in so streaming can gate whole ground zones.
  B.setSector('north-yard');
  B.groundPlane(-43, -99, 44, -42, 0, 'concreteDark', 'concrete');   // rail yard + north rim
  B.setSector('square');
  B.groundPlane(-43, -42, -42, 43, 0, 'concreteDark', 'concrete');   // west rim
  B.groundPlane(-42, 42, 42, 43, 0, 'concreteDark', 'concrete');     // south rim
  B.setSector('east-docks');
  B.groundPlane(44, -99, 99, -42, 0, 'asphalt', 'concrete');         // dock quay north
  B.groundPlane(42, -42, 99, 43, 0, 'asphalt', 'concrete');          // dock quay east
  // Rail-gate and ferry pads read as landmarks from across their sectors.
  B.setSector('north-yard');
  B.floorFinish(-40, -98, -32, -92, 0.03, 'tile', { cast: false });
  B.setSector('east-docks');
  B.floorFinish(88, 32, 98, 40, 0.03, 'tile', { cast: false });
}

function buildRailYard(B) {
  // Warehouse shell with two-way interiors: every room has at least two entrances.
  const t = 0.45;
  B.wall(-32, -90, -8, -90 + t, 0, 6.5, 'metal', 'metal', {
    openings: [{ a0: -26, a1: -23, y0: 0, y1: 2.8, frame: 'door' }],
  });
  B.wall(-32, -64 - t, -8, -64, 0, 6.5, 'metal', 'metal', {
    openings: [
      { a0: -28, a1: -25, y0: 0, y1: 2.8, frame: 'door' },
      { a0: -14, a1: -11, y0: 0, y1: 2.8, frame: 'door' },
    ],
  });
  B.wall(-32, -90, -32 + t, -64, 0, 6.5, 'metal', 'metal', {
    openings: [{ a0: -80, a1: -77, y0: 0, y1: 2.8, frame: 'door' }],
  });
  B.wall(-8 - t, -90, -8, -64, 0, 6.5, 'metal', 'metal', {
    openings: [
      { a0: -86, a1: -83, y0: 0, y1: 2.8, frame: 'door' },
      { a0: -72, a1: -69, y0: 0, y1: 2.8, frame: 'door' },
    ],
  });
  // Mezzanine over the west half, with a guarded edge and one stair down to the floor.
  B.box(-32, 3.4, -90, -24, 3.6, -64, 'concreteDark', 'concrete');
  B.stairs({ x0: -24, z0: -78, x1: -17.2, z1: -75.6, y0: 0, y1: 3.6, dir: '-x', matName: 'metal', surface: 'metal', rail: true });
  B.parapet(-24, -90, -24, -78.2, 3.6, 1.0, 'metal');
  B.parapet(-24, -75.4, -24, -64, 3.6, 1.0, 'metal');
  // Floor clutter so the hall is cover, not a shooting gallery.
  B.box(-20, 0, -86, -16, 1.4, -82, 'metal', 'metal');
  B.box(-14, 0, -74, -10, 1.1, -70, 'wood', 'wood');
  B.box(-22, 0, -70, -18, 2.0, -67, 'concrete', 'concrete');

  // Container rows (footprints shared with the blocked caps).
  for (const [x0, z0, x1, z1] of XM_CONTAINERS.slice(0, 8)) {
    B.box(x0, 0, z0, x1, CONTAINER_H, z1, 'metal', 'metal');
  }

  // Watchtower over the approach into the district's north court.
  for (const [px, pz] of [[-1.8, -55.8], [3.4, -55.8], [-1.8, -50.6], [3.4, -50.6]]) {
    B.box(px, 0, pz, px + 0.4, 3.6, pz + 0.4, 'metal', 'metal');
  }
  B.box(-2, 3.6, -56, 4, 3.8, -50, 'metal', 'metal');
  B.ramp({ x0: 4, z0: -55.2, x1: 12, z1: -52.8, y0: 0, y1: 3.8, dir: '-x', matName: 'metal', surface: 'metal' });
  B.parapet(-2, -56, 4, -56, 3.8, 1.0, 'metal');
  B.parapet(-2, -56, -2, -50, 3.8, 1.0, 'metal');
  B.parapet(-2, -50, 4, -50, 3.8, 1.0, 'metal');

  // Open-yard cover between the warehouse and the district edge.
  B.box(-22, 0, -60, -18, 1.4, -57, 'concrete', 'concrete');
  B.box(-6, 0, -63, -2, 1.1, -60, 'wood', 'wood');
  B.box(14, 0, -62, 18, 1.4, -59, 'concrete', 'concrete');
  B.box(24, 0, -50, 28, 1.1, -47, 'wood', 'wood');
  // Rail-gate frame: two posts flanking the exit pad.
  B.box(-41, 0, -92.6, -40.2, 4.5, -91.8, 'metal', 'metal');
  B.box(-31.8, 0, -92.6, -31, 4.5, -91.8, 'metal', 'metal');
}

function buildEastDocks(B) {
  // Customs shed, four ways in.
  const t = 0.45;
  B.wall(60, -20, 84, -20 + t, 0, 6.5, 'concreteDark', 'concrete', {
    openings: [{ a0: 70, a1: 73, y0: 0, y1: 2.8, frame: 'door' }],
  });
  B.wall(60, 4 - t, 84, 4, 0, 6.5, 'concreteDark', 'concrete', {
    openings: [
      { a0: 64, a1: 67, y0: 0, y1: 2.8, frame: 'door' },
      { a0: 76, a1: 79, y0: 0, y1: 2.8, frame: 'door' },
    ],
  });
  B.wall(60, -20, 60 + t, 4, 0, 6.5, 'concreteDark', 'concrete', {
    openings: [{ a0: -14, a1: -11, y0: 0, y1: 2.8, frame: 'door' }],
  });
  B.wall(84 - t, -20, 84, 4, 0, 6.5, 'concreteDark', 'concrete', {
    openings: [{ a0: -6, a1: -3, y0: 0, y1: 2.8, frame: 'door' }],
  });
  B.box(64, 0, -16, 68, 1.4, -12, 'metal', 'metal');
  B.box(74, 0, -10, 78, 2.0, -6, 'concrete', 'concrete');
  B.box(66, 0, -4, 70, 1.1, 0, 'metal', 'metal');

  // Dock container stacks (footprints shared with the blocked caps) and the crane.
  for (const [x0, z0, x1, z1] of XM_CONTAINERS.slice(8)) {
    B.box(x0, 0, z0, x1, CONTAINER_H, z1, 'metal', 'metal');
  }
  B.box(XM_STACK[0], 0, XM_STACK[1], XM_STACK[2], STACK_H, XM_STACK[3], 'metal', 'metal');
  B.cylinder(64, 0, -70, 1.45, 10.5, 12, 'metal', 'metal', { collide: true });

  // Pier walk: the docks' elevated read over the quay, stairs at both ends. The west
  // parapet runs UNBROKEN: a gap in a mostly-barriered roof edge is exactly the
  // walk-straight-over trap maptest's roof-barrier check exists to catch, and it did.
  B.box(93, 3.6, -45, 98.5, 3.8, 15, 'metal', 'metal');
  B.stairs({ x0: 93.5, z0: 15, x1: 95.9, z1: 22.2, y0: 0, y1: 3.8, dir: '-z', matName: 'metal', surface: 'metal', rail: true });
  B.stairs({ x0: 93.5, z0: -52.2, x1: 95.9, z1: -45, y0: 0, y1: 3.8, dir: '+z', matName: 'metal', surface: 'metal', rail: true });
  B.parapet(93, -45, 93, 15, 3.8, 1.0, 'metal');

  // Quay cover so the open asphalt is crossable.
  B.box(50, 0, -30, 54, 1.4, -27, 'concrete', 'concrete');
  B.box(60, 0, -44, 64, 1.1, -41, 'wood', 'wood');
  B.box(76, 0, -34, 80, 1.4, -31, 'concrete', 'concrete');
  B.box(52, 0, 6, 56, 1.1, 9, 'wood', 'wood');
  B.box(68, 0, 16, 72, 1.4, 19, 'concrete', 'concrete');
  B.box(84, 0, 8, 88, 1.1, 11, 'wood', 'wood');
  // Ferry-landing frame posts flanking the exit pad.
  B.box(87.4, 0, 35.2, 88.2, 4.5, 36, 'metal', 'metal');
  B.box(97.8, 0, 35.2, 98.6, 4.5, 36, 'metal', 'metal');
}

function buildExtractionPerimeter(B) {
  for (const box of XM_PERIMETER) {
    B.box(box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z,
      'concreteDark', 'concrete');
  }
}

function buildLootMarkers(B) {
  // Graybox stand-ins at every static container spawn point, so the placement is visible
  // in-world and in screenshots. LOOT_CONTAINERS is the authoritative list. Each marker
  // is tagged with the sector its placement point resolves to (sector-interest.md §3's
  // placement-point rule), so streaming gates it with the sector it belongs to.
  for (const c of LOOT_CONTAINERS) {
    const p = c.position;
    B.setSector(extractionSectorAt(p.x, p.y, p.z));
    B.box(p.x - 0.6, p.y, p.z - 0.6, p.x + 0.6, p.y + 0.9, p.z + 0.6, 'wood', 'wood');
  }
  B.setSector(null);
}

/** Sector id containing a point, from the authored EXTRACTION_SECTORS boxes (or null). */
function extractionSectorAt(x, y, z) {
  for (const s of EXTRACTION_SECTORS) {
    const b = s.box;
    if (x >= b.min.x && x <= b.max.x && y >= b.min.y && y <= b.max.y
      && z >= b.min.z && z <= b.max.z) return s.id;
  }
  return null;
}

// ── P3-07: POI/extraction signage language + sponsor-slot placeholders ───────────────
//
// Every surface below is FLUSH-MOUNTED dressing on an existing opaque, colliding wall:
// board/paint props collide:false by contract ("signage must never snag a player"), and
// because each panel is backed by solid architecture it can never occlude anything the
// wall behind it did not already occlude — no collision change, no sightline change.
// `scripts/uistream.mjs` proves both: byte-identical collider sets with dressing
// on/off, and a backing-collider containment check for every declared panel.

/** One colour per sector — the raid's wayfinding vocabulary. Sign boards, and later the
 *  minimap/compass language, all read from this single table. */
export const SECTOR_SIGN_COLORS = Object.freeze({
  square: 0xd7a05a,        // The Square keeps its ochre signwriting colour (OT_PAINT)
  'north-yard': 0xa4643a,  // rail yard: red-oxide primer (HB_RUST)
  'east-docks': 0x5f9a86,  // docks: marine-green ironwork (HB_PAINT)
});

/** Neutral placeholder grey — deliberately NOT a sector or hazard colour. */
const SPONSOR_GREY = 0x9aa0a6;

/**
 * Declared signage surfaces — graybox wayfinding language for the raid map.
 * `normal` is the axis direction the panel faces ('+z'|'-z'|'+x'|'-x'; every mounting
 * wall on this map is axis-aligned); (x, z) is the panel centre ON the wall plane
 * (already nudged proud, same ±0.03 m convention the district's paintBands use),
 * `y` the bottom edge. kind: 'exit' surfaces mark extraction-match.md exits (refId =
 * exit id, hazard yellow); 'sector' surfaces carry sector-name/wayfinding colour
 * (refId = the sector they NAME, sectorId = the sector they are physically in).
 */
export const EXTRACTION_SIGNAGE = Object.freeze([
  // Rail-gate exit (exit-rail-gate volume x −40…−32, z −98…−92).
  { id: 'sg-exit-rail-wall', kind: 'exit', refId: 'exit-rail-gate', sectorId: 'north-yard',
    normal: '+z', x: -36, z: -98.97, y: 3.2, w: 8, h: 1.2, color: HAZARD },
  { id: 'sg-exit-rail-post-w', kind: 'exit', refId: 'exit-rail-gate', sectorId: 'north-yard',
    normal: '+z', x: -40.6, z: -91.77, y: 0.9, w: 0.72, h: 2.4, color: HAZARD },
  { id: 'sg-exit-rail-post-e', kind: 'exit', refId: 'exit-rail-gate', sectorId: 'north-yard',
    normal: '+z', x: -31.4, z: -91.77, y: 0.9, w: 0.72, h: 2.4, color: HAZARD },
  // Ferry-landing exit (exit-ferry-landing volume x 88…98, z 32…40).
  { id: 'sg-exit-ferry-wall', kind: 'exit', refId: 'exit-ferry-landing', sectorId: 'east-docks',
    normal: '-x', x: 98.97, z: 36, y: 3.2, w: 6, h: 1.2, color: HAZARD },
  { id: 'sg-exit-ferry-post-s', kind: 'exit', refId: 'exit-ferry-landing', sectorId: 'east-docks',
    normal: '-z', x: 87.8, z: 35.17, y: 0.9, w: 0.72, h: 2.4, color: HAZARD },
  { id: 'sg-exit-ferry-post-n', kind: 'exit', refId: 'exit-ferry-landing', sectorId: 'east-docks',
    normal: '-z', x: 98.2, z: 35.17, y: 0.9, w: 0.72, h: 2.4, color: HAZARD },
  // Sector-name callout surfaces on the perimeter walls, one per sector.
  { id: 'sg-name-square', kind: 'sector', refId: 'square', sectorId: 'square',
    normal: '+x', x: -42.97, z: -14, y: 4.6, w: 9, h: 1.1, color: SECTOR_SIGN_COLORS.square },
  { id: 'sg-name-north-yard', kind: 'sector', refId: 'north-yard', sectorId: 'north-yard',
    normal: '+z', x: 10, z: -98.97, y: 4.6, w: 9, h: 1.1, color: SECTOR_SIGN_COLORS['north-yard'] },
  { id: 'sg-name-east-docks', kind: 'sector', refId: 'east-docks', sectorId: 'east-docks',
    normal: '-x', x: 98.97, z: -54, y: 4.6, w: 9, h: 1.1, color: SECTOR_SIGN_COLORS['east-docks'] },
  // Boundary wayfinding: what lies THROUGH this face, in that sector's colour.
  { id: 'sg-way-north-yard', kind: 'sector', refId: 'north-yard', sectorId: 'north-yard',
    normal: '+z', x: -20, z: -63.97, y: 4.9, w: 8, h: 1.0, color: SECTOR_SIGN_COLORS['north-yard'] },
  { id: 'sg-way-east-docks', kind: 'sector', refId: 'east-docks', sectorId: 'east-docks',
    normal: '-x', x: 59.97, z: -8, y: 4.9, w: 6, h: 1.0, color: SECTOR_SIGN_COLORS['east-docks'] },
  { id: 'sg-way-square', kind: 'sector', refId: 'square', sectorId: 'north-yard',
    normal: '+x', x: -7.97, z: -77, y: 4.9, w: 6, h: 1.0, color: SECTOR_SIGN_COLORS.square },
  { id: 'sg-way-square-docks', kind: 'sector', refId: 'square', sectorId: 'east-docks',
    normal: '-z', x: 72, z: -20.03, y: 4.9, w: 6, h: 1.0, color: SECTOR_SIGN_COLORS.square },
]);

/**
 * Inert sponsor-slot placeholder surfaces (Build Plan P3-07). Same flush-mounted,
 * never-colliding contract as the signage above — a placeholder that changed collision
 * or hid a player would be a map defect, and `scripts/uistream.mjs` asserts it can't.
 * Neutral grey on purpose: nothing here may read as gameplay language.
 */
export const SPONSOR_SLOTS = Object.freeze([
  { id: 'sp-square-west', sectorId: 'square', normal: '+x', x: -42.97, z: 8, y: 1.6, w: 6, h: 3, color: SPONSOR_GREY },
  { id: 'sp-yard-north', sectorId: 'north-yard', normal: '+z', x: 26, z: -98.97, y: 1.6, w: 6, h: 3, color: SPONSOR_GREY },
  { id: 'sp-docks-east', sectorId: 'east-docks', normal: '-x', x: 98.97, z: -34, y: 1.6, w: 6, h: 3, color: SPONSOR_GREY },
  { id: 'sp-docks-shed', sectorId: 'east-docks', normal: '+z', x: 71.5, z: 4.03, y: 3.4, w: 5, h: 2.4, color: SPONSOR_GREY },
]);

const NORMAL_YAW = Object.freeze({ '+z': 0, '-z': Math.PI, '+x': Math.PI / 2, '-x': -Math.PI / 2 });

/**
 * Stamp one declared panel as chopped ≤3 m sign boards (the same "no absurdly thick
 * instance" rule paintBand applies — the sign prop's depth scales with its width).
 */
function panelBoards(B, spec) {
  B.setSector(spec.sectorId);
  const yaw = NORMAL_YAW[spec.normal];
  const alongX = spec.normal === '+z' || spec.normal === '-z';
  const a = alongX ? spec.x : spec.z;
  const n = Math.max(1, Math.round(spec.w / 3.0));
  const w = spec.w / n;
  for (let i = 0; i < n; i++) {
    const c = a + (i - (n - 1) / 2) * w;
    if (alongX) board(B, c, spec.y, spec.z, yaw, w, spec.h, spec.color);
    else board(B, spec.x, spec.y, c, yaw, w, spec.h, spec.color);
  }
}

function buildExtractionSignage(B) {
  for (const spec of EXTRACTION_SIGNAGE) panelBoards(B, spec);
  B.setSector(null);
}

function buildSponsorSlots(B) {
  for (const spec of SPONSOR_SLOTS) panelBoards(B, spec);
  B.setSector(null);
}

// ── P3-07: client sector streaming controller ────────────────────────────────────────

/** Render tiers. FULL = as authored; NEAR = visible but shadow-casting stripped (a
 *  neighbour sector the viewer has not entered); HIDDEN = not rendered at all. */
export const STREAM_TIER = Object.freeze({ FULL: 'full', NEAR: 'near', HIDDEN: 'hidden' });

/**
 * Client-side sector streaming (sector-interest.md §5.1 mirrored for rendering).
 *
 * Tier rule, per frame, from the viewer's feet position:
 *   - every sector in `occupiedSectorsFor(viewer)` (own sector + any neighbour whose
 *     boundary the viewer is inside the 6 m transition zone of) renders FULL;
 *   - every other sector in `relevantSetFor(viewer)` (direct neighbours) renders NEAR —
 *     still fully visible (a client IS shown its neighbour sectors, §5.1; hiding one
 *     would desync what the player sees from what the server sends), but its meshes stop
 *     casting shadows, which is pure cost with zero gameplay information;
 *   - FULL→NEAR is hysteretic: a sector that reached FULL holds FULL for the same
 *     SECTOR_COOLDOWN_S grace after it leaves the occupied set, as long as it stays
 *     relevant. Without this, pacing the 6 m transition-zone edge would flip every
 *     mesh's castShadow in the neighbour sector once per crossing — on the shipped
 *     three-sector map (complete graph, nothing ever HIDDEN) that whole-sector shadow
 *     pop is the ONLY artifact this feature can produce, so it gets the same cooldown
 *     shape the HIDDEN edge already had. NEAR→FULL stays instant (restoring detail
 *     must never lag);
 *   - a sector outside the relevant set renders NOT AT ALL, after the same
 *     SECTOR_COOLDOWN_S grace the server applies to activation (§4.1), so pacing a
 *     boundary never thrashes visibility.
 *
 * On today's three-sector map the graph is complete, so nothing ever reaches HIDDEN —
 * that is contract-correct (§5.1 shows a client every adjacent sector), and the HIDDEN
 * path is exercised against P4-01-shaped deeper graphs by `scripts/uistream.mjs`.
 *
 * COST, measured (`scripts/uistreamperf.mjs`, real renderer): on the shipped map this
 * is NOT a net draw-call win. The per-sector bucket split costs ~+20 draw calls over
 * the pre-P3-07 merged build and NEAR shadow-stripping earns back ~10, so sector gating
 * runs at a net ~+10 draw calls (bounded by that harness, well inside the manifest
 * budget). The mechanism's real return — whole sectors HIDDEN — arrives with P4-01's
 * deeper sector graphs; today's price buys the machinery, not a saving.
 *
 * Fail-open by design: no viewer position, or a viewer outside every sector, renders
 * everything FULL. A rendering optimisation must never be able to blank the world.
 *
 * `groups` is a Map<sectorId, groupLike> where groupLike is a THREE.Group (or any
 * `{ visible, children: [{ castShadow, userData }] }` — the harness drives plain
 * objects). Memory is untouched by tiering: geometry stays resident, only `visible`
 * and `castShadow` flip, so the map's memory budget is exactly the built map's.
 */
export function createSectorStreaming({ sectors = [], groups = new Map(), cooldownS = SECTOR_COOLDOWN_S } = {}) {
  const interest = new SectorInterest(sectors);
  const lastRelevant = new Map();
  const lastOccupied = new Map();
  const tiers = new Map();
  let clock = 0;

  function apply(id, tier) {
    tiers.set(id, tier);
    const group = groups.get(id);
    if (!group) return;
    group.visible = tier !== STREAM_TIER.HIDDEN;
    for (const mesh of group.children || []) {
      if (!mesh || typeof mesh.castShadow !== 'boolean') continue;
      if (mesh.userData && mesh.userData.p307Cast === undefined) mesh.userData.p307Cast = mesh.castShadow;
      mesh.castShadow = tier === STREAM_TIER.FULL
        ? (mesh.userData?.p307Cast ?? mesh.castShadow)
        : false;
    }
  }

  return {
    interest,
    tiers,
    tierOf(id) { return tiers.get(id) ?? STREAM_TIER.FULL; },

    /**
     * @param {number} dt seconds since last frame
     * @param {{x,y,z}|null} viewerPos the LOCAL viewer's feet (player position; a dead
     *   player's last position stands in for §5.1's last-alive-sector rule)
     */
    update(dt, viewerPos) {
      clock += Math.max(0, dt || 0);
      if (!interest.hasSectors()) return;
      const own = viewerPos ? interest.sectorOf(viewerPos) : null;
      if (!own) {
        for (const s of interest.sectors) apply(s.id, STREAM_TIER.FULL);
        return;
      }
      const occupied = interest.occupiedSectorsFor(viewerPos);
      const relevant = interest.relevantSetFor(viewerPos);
      for (const s of interest.sectors) {
        const id = s.id;
        if (occupied.has(id)) {
          lastRelevant.set(id, clock);
          lastOccupied.set(id, clock);
          apply(id, STREAM_TIER.FULL);
        } else if (relevant.has(id)) {
          lastRelevant.set(id, clock);
          // FULL→NEAR hysteresis: hold FULL through the cooldown after the sector was
          // last occupied, so pacing the transition-zone edge never toggles castShadow
          // per crossing (whole-sector shadow pop). A never-occupied neighbour goes
          // straight to NEAR — this is a decay grace, not a warm-up delay.
          const occ = lastOccupied.get(id);
          apply(id, occ !== undefined && clock - occ < cooldownS
            ? STREAM_TIER.FULL : STREAM_TIER.NEAR);
        } else {
          const last = lastRelevant.get(id);
          // Grace period: recently-relevant sectors decay through NEAR, never snap off.
          if (last !== undefined && clock - last < cooldownS) apply(id, STREAM_TIER.NEAR);
          else apply(id, STREAM_TIER.HIDDEN);
        }
      }
    },

    /** Render-cost accounting for harnesses: mesh/draw-shaped counts per tier. */
    stats() {
      let visibleMeshes = 0;
      let castingMeshes = 0;
      let hiddenMeshes = 0;
      for (const [id, group] of groups) {
        const n = (group.children || []).length;
        if (tiers.get(id) === STREAM_TIER.HIDDEN) { hiddenMeshes += n; continue; }
        visibleMeshes += n;
        for (const mesh of group.children || []) if (mesh?.castShadow) castingMeshes++;
      }
      return { visibleMeshes, castingMeshes, hiddenMeshes, tiers: Object.fromEntries(tiers) };
    },
  };
}

/**
 * Painted board flat on a wall face, `w` wide × `h` high, bottom edge at `y`.
 * The sign/cloth/shutter family faces +Z at yaw 0, so: +Z → 0, -Z → π, +X → π/2, -X → -π/2.
 * Non-colliding by contract — signage must never snag a player.
 */
function board(B, x, y, z, yaw, w, h, color) {
  B.prop('sign', x, y, z, yaw, { scale: w, scaleY: h / w, color, collide: false });
}

/**
 * A painted band running along a wall face, broken by `gaps` (doorways, windows) and
 * chopped into ≤3 m boards so no single instance ends up absurdly thick. This is the
 * workhorse of lane colour identity: one call paints a whole elevation.
 */
function paintBand(B, alongX, a0, a1, b, y, h, color, gaps = [], yaw = 0) {
  const segs = [];
  let cur = a0;
  for (const [g0, g1] of gaps.slice().sort((p, q) => p[0] - q[0])) {
    if (g0 > cur) segs.push([cur, Math.min(g0, a1)]);
    cur = Math.max(cur, g1);
  }
  if (cur < a1) segs.push([cur, a1]);
  for (const [s0, s1] of segs) {
    const len = s1 - s0;
    if (len < 0.35) continue;
    const n = Math.max(1, Math.round(len / 3.0));
    const w = len / n;
    for (let i = 0; i < n; i++) {
      const c = s0 + (i + 0.5) * w;
      if (alongX) board(B, c, y, b, yaw, w, h, color);
      else board(B, b, y, c, yaw, w, h, color);
    }
  }
}

/** A hanging cloth of width `w`, dropping `h` below the line it is pegged to. */
function hang(B, x, y, z, yaw, w, h, color) {
  B.prop('cloth', x, y, z, yaw, { scale: w, scaleY: h / w, color, collide: false });
}

/**
 * Build the retained MERIDIAN fixture. Called synchronously by an explicit fixture entry;
 * everything below runs in
 * well under 250 ms because all geometry is merged/instanced in a single pass at the end.
 */
export function buildMeridianFixture(game, world) {
  const B = new Builder(game, world);
  const rng = game.rng;

  world.setBounds({ x: -EDGE, y: -4, z: -EDGE }, { x: EDGE, y: 18, z: EDGE });

  buildGround(B);
  buildPerimeter(B);
  buildMarketHall(B);
  buildOldTown(B);
  buildWarehouse(B);
  buildCustoms(B);
  buildPlaza(B, rng);
  buildHarbour(B, rng);
  buildSpawnYards(B, rng);
  scatterDressing(B, rng);
  dressPerimeter(B, rng);
  placeSpawns(world);

  const stats = B.finish();
  world.buildStats.drawCalls = stats.meshes + stats.instanced;
  world.buildStats.triangles = Math.round(stats.triangles);
  world.buildStats.colliders = world.boxes.length;
}

// ──────────────────────────────────────────────────────────────────────── ground

function buildGround(B) {
  // Six zones, each one mesh with its own assets.tiled() repeat, plus a 1 m collider
  // slab carrying the right impact surface.
  B.groundPlane(-IN, -IN, -13, -16, 0, 'concreteDark', 'concrete');   // old-town north lanes
  B.groundPlane(-IN, -16, -13, 10, 0, 'dirt', 'dirt');                // courtyard
  B.groundPlane(-IN, 10, -13, IN, 0, 'concreteDark', 'concrete');     // old-town south lanes
  B.groundPlane(-13, -IN, 13, IN, 0, 'tile', 'concrete');             // central plaza
  B.groundPlane(13, -IN, 36, IN, 0, 'asphalt', 'concrete');           // harbour road
  B.groundPlane(36, -IN, IN, IN, 0, 'concrete', 'concrete');          // quay

  // Sand drifts along the quay — surface variety for footsteps and impacts.
  B.box(36.4, 0, -13, 40.6, 0.05, -2, 'dirt', 'sand', { cast: false });
  B.box(36.4, 0, 14, 40.6, 0.05, 25, 'dirt', 'sand', { cast: false });
  B.box(-34, 0, -6, -28, 0.05, 2, 'dirt', 'sand', { cast: false });

  // Road markings — pure dressing, sits 1 cm proud of the asphalt.
  for (let z = -38; z < 40; z += 6) {
    B.deco(24.7, 0.01, z, 25.3, 0.02, z + 3.2, 'concrete', { cast: false, receive: true });
  }
}

// ─────────────────────────────────────────────────────────────────────── perimeter

function buildPerimeter(B) {
  // Town wall (west) and cliff retaining walls — nothing here is climbable.
  B.box(-EDGE, 0, -EDGE, -IN, WALL_H, EDGE, 'brick', 'concrete');
  B.box(IN, 0, -EDGE, EDGE, WALL_H + 1.4, EDGE, 'concreteDark', 'concrete');
  B.box(-EDGE, 0, -EDGE, EDGE, WALL_H, -IN, 'concreteDark', 'concrete');
  B.box(-EDGE, 0, IN, EDGE, WALL_H, EDGE, 'concreteDark', 'concrete');

  // Buttresses so the walls do not read as flat cardboard.
  for (let z = -38; z <= 38; z += 8) {
    B.deco(-IN, 0, z - 0.6, -IN + 0.55, 8.2, z + 0.6, 'brick');
    B.deco(IN - 0.55, 0, z - 0.7, IN, 9.0, z + 0.7, 'concreteDark');
  }
  for (let x = -38; x <= 38; x += 8) {
    B.deco(x - 0.6, 0, -IN, x + 0.6, 8.2, -IN + 0.55, 'concreteDark');
    B.deco(x - 0.6, 0, IN - 0.55, x + 0.6, 8.2, IN, 'concreteDark');
  }
  // Coping course along the top of every wall.
  B.deco(-EDGE, WALL_H, -EDGE, -IN + 0.25, WALL_H + 0.3, EDGE, 'concreteDark');
  B.deco(-EDGE, WALL_H, -EDGE, EDGE, WALL_H + 0.3, -IN + 0.25, 'concreteDark');
  B.deco(-EDGE, WALL_H, IN - 0.25, EDGE, WALL_H + 0.3, EDGE, 'concreteDark');
}

// ──────────────────────────────────────────────────────────────────── market hall

/**
 * MARKET HALL — x[−10,10] z[−11,11]. Ground market floor, first floor with an interior
 * room and three balconies, roof deck with a crenellated parapet. Three independent
 * routes up: interior stair (NE), exterior stair to the south balcony, exterior stair to
 * the west balcony; and a fourth from the first floor to the roof.
 */
function buildMarketHall(B) {
  const X0 = -10, X1 = 10, Z0 = -11, Z1 = 11, T = 0.4;
  const STAIR = [6.2, -9.5, 8.6, -2.7];        // ground → L1 well
  const ROOF_STAIR = [-8.6, 2.6, -6.2, 9.4];   // L1 → roof well

  // Plinth + ground floor deck.
  B.box(X0 - 0.6, 0, Z0 - 0.6, X1 + 0.6, PLINTH, Z1 + 0.6, 'concreteDark', 'concrete');
  B.deco(X0 - 0.75, 0, Z0 - 0.75, X1 + 0.75, 0.08, Z1 + 0.75, 'concreteDark');
  B.floorFinish(X0, Z0, X1, Z1, PLINTH, 'tile');

  // ── ground floor shell
  const groundDoor = { y0: PLINTH, y1: 2.5, frame: 'door' };
  const groundWin = { y0: 1.15, y1: 2.45, frame: 'window', stain: 1 };
  const shut = { shutterColors: PZ_SHUTTERS };
  B.wall(X0, Z1 - T, X1, Z1, PLINTH, L1_UNDER, 'plaster', 'concrete', {
    openings: [
      { a0: -6.2, a1: -3.6, ...groundDoor },
      { a0: 3.6, a1: 6.2, ...groundDoor },
      { a0: -8.6, a1: -6.6, ...groundWin, glass: true },
      { a0: 6.6, a1: 8.6, ...groundWin, glass: true },
    ],
  });
  B.wall(X0, Z0, X1, Z0 + T, PLINTH, L1_UNDER, 'plaster', 'concrete', {
    openings: [
      { a0: -6.2, a1: -3.6, ...groundDoor },
      { a0: 3.6, a1: 6.2, ...groundDoor },
      { a0: -1.3, a1: 1.3, ...groundWin, glass: true, shutter: -1, ...shut },
    ],
  });
  B.wall(X1 - T, Z0, X1, Z1, PLINTH, L1_UNDER, 'plaster', 'concrete', {
    openings: [
      { a0: -1.7, a1: 1.7, y0: PLINTH, y1: 2.8, frame: 'door' },
      { a0: -8.2, a1: -5.4, y0: 1.1, y1: 2.4, glass: true, frame: 'window', stain: 1, shutter: 1, ...shut },
      { a0: 5.4, a1: 8.2, y0: 1.1, y1: 2.4, glass: true, frame: 'window', stain: 1, shutter: 1, ...shut },
    ],
  });
  B.wall(X0, Z0, X0 + T, Z1, PLINTH, L1_UNDER, 'plaster', 'concrete', {
    openings: [
      // Deliberately NOT aligned with the east door — otherwise the hall is a tunnel.
      { a0: -5.2, a1: -2.0, y0: PLINTH, y1: 2.8, frame: 'door' },
      // Broken pane — shoot through. The missing shutter leaf tells you so from outside.
      { a0: -8.6, a1: -6.2, y0: 1.1, y1: 2.4, frame: 'window', stain: 1.4, shutter: -1, shutterW: 0.85, ...shut },
      { a0: 5.4, a1: 8.2, y0: 1.1, y1: 2.4, glass: true, frame: 'window', stain: 1, shutter: -1, ...shut },
    ],
  });

  // Interior partitions: a north-west stock room and a south-east office, each with
  // three ways in so neither is a trap.
  B.wall(-3.7, Z0, -3.3, -5, PLINTH, L1_UNDER, 'plaster', 'concrete', {
    openings: [{ a0: -9.6, a1: -7.2, y0: PLINTH, y1: 2.4, frame: 'door' }],
  });
  B.wall(X0, -5.2, -3.3, -4.8, PLINTH, L1_UNDER, 'plaster', 'concrete', {
    openings: [{ a0: -9.3, a1: -6.9, y0: PLINTH, y1: 2.4, frame: 'door' }],
  });
  B.wall(3.3, 5, 3.7, Z1, PLINTH, L1_UNDER, 'plaster', 'concrete', {
    openings: [{ a0: 7.2, a1: 9.6, y0: PLINTH, y1: 2.4, frame: 'door' }],
  });
  // 3.3, mirroring the -3.3 partition opposite. At 3.5 it left a 0.2 x 0.2 m notch in the
  // inside corner — a copy-paste-and-nudge, not a design.
  B.wall(3.3, 4.8, X1, 5.2, PLINTH, L1_UNDER, 'plaster', 'concrete', {
    openings: [{ a0: 6.9, a1: 9.3, y0: PLINTH, y1: 2.4, frame: 'door' }],
  });

  // Roof beams over the market floor.
  for (let x = -8; x <= 8; x += 2.65) B.deco(x - 0.14, L1_UNDER - 0.34, Z0, x + 0.14, L1_UNDER, Z1, 'wood');

  // ── first floor
  B.stairs({ x0: 6.2, z0: -9.5, x1: 8.6, z1: -2.7, y0: PLINTH, y1: L1, dir: '+z', matName: 'concreteDark', surface: 'concrete', rail: true });
  B.slab(X0, Z0, X1, Z1, L1_UNDER, L1, 'concrete', 'concrete', { hole: STAIR, cast: true, receive: true });
  B.floorFinish(X0, Z0, X1, Z1, L1, 'tile');

  const upWin = { y0: 5.15, y1: 6.65, frame: 'window', stain: 1, ...shut };
  B.wall(X0, Z1 - T, X1, Z1, L1, L2_UNDER, 'plaster', 'concrete', {
    openings: [
      { a0: -0.6, a1: 2.2, y0: L1, y1: 6.5, frame: 'door' },
      { a0: -8, a1: -5, ...upWin, glass: true, shutter: 1 },
      { a0: 5, a1: 8, ...upWin, glass: true, shutter: 1 },
    ],
  });
  B.wall(X0, Z0, X1, Z0 + T, L1, L2_UNDER, 'plaster', 'concrete', {
    openings: [
      { a0: -2.2, a1: 0.6, y0: L1, y1: 6.5, frame: 'door' },
      { a0: -8, a1: -5, ...upWin, glass: true, shutter: -1 },
      { a0: 5, a1: 8, ...upWin, glass: true, shutter: -1 },
    ],
  });
  B.wall(X1 - T, Z0, X1, Z1, L1, L2_UNDER, 'plaster', 'concrete', {
    openings: [
      { a0: -8.2, a1: -5.2, ...upWin, glass: true, shutter: 1 },
      { a0: -1.8, a1: 1.8, ...upWin },                    // open — the classic window peek
      { a0: 5.2, a1: 8.2, ...upWin, glass: true, shutter: 1 },
    ],
  });
  B.wall(X0, Z0, X0 + T, Z1, L1, L2_UNDER, 'plaster', 'concrete', {
    openings: [
      { a0: -2.4, a1: 1.2, y0: L1, y1: 6.5, frame: 'door' },
      { a0: -8.2, a1: -5.2, ...upWin, glass: true, shutter: -1 },
      { a0: 5.2, a1: 8.2, ...upWin, shutter: -1 },
    ],
  });

  // Upper interior room — two doors, two open windows.
  B.wall(-3.2, -4, -2.8, 4, L1, L2_UNDER, 'plaster', 'concrete', {
    openings: [{ a0: -1.5, a1: 1.5, y0: 5.1, y1: 6.5, frame: 'window' }],
  });
  B.wall(2.8, -4, 3.2, 4, L1, L2_UNDER, 'plaster', 'concrete', {
    openings: [{ a0: -1.5, a1: 1.5, y0: 5.1, y1: 6.5, frame: 'window' }],
  });
  B.wall(-3, -4.2, 3, -3.8, L1, L2_UNDER, 'plaster', 'concrete', {
    openings: [{ a0: -2.2, a1: 0.2, y0: L1, y1: 6.4, frame: 'door' }],
  });
  B.wall(-3, 3.8, 3, 4.2, L1, L2_UNDER, 'plaster', 'concrete', {
    openings: [{ a0: 0.4, a1: 2.8, y0: L1, y1: 6.4, frame: 'door' }],
  });

  // ── roof
  B.stairs({ x0: -8.6, z0: 2.6, x1: -6.2, z1: 9.4, y0: L1, y1: L2, dir: '-z', matName: 'concreteDark', surface: 'concrete', rail: true });
  B.slab(X0, Z0, X1, Z1, L2_UNDER, L2, 'concrete', 'concrete', { hole: ROOF_STAIR });
  B.parapet(X0, Z1, X1, Z1, L2, 1.05, 'plaster', 'concrete', { gaps: [[-6.5, -3.5], [3.5, 6.5]] });
  B.parapet(X0, Z0, X1, Z0, L2, 1.05, 'plaster', 'concrete', { gaps: [[-6.5, -3.5], [3.5, 6.5]] });
  B.parapet(X1, Z0, X1, Z1, L2, 1.05, 'plaster', 'concrete', { gaps: [[-7, -4], [4, 7]] });
  B.parapet(X0, Z0, X0, Z1, L2, 1.05, 'plaster', 'concrete', { gaps: [[-7, -4], [4, 7]] });
  B.prop('acUnit', 4.6, L2, -6.2, 0.3);
  B.prop('acUnit', 6.4, L2, -4.4, -0.2);
  B.prop('acUnit', -4.2, L2, -7.4, 1.4);
  B.prop('crate', 2.2, L2, 6.4, 0.5);
  marketLantern(B);
  dressHallRoof(B);

  // ── balconies
  // North (over the plaza approach from team 1's side).
  B.slab(-8, -13.6, 8, Z0, L1_UNDER, L1, 'concrete', 'concrete');
  B.parapet(-8, -13.6, 8, -13.6, L1, 1.0, 'plaster', 'concrete', { gaps: [[-5, -2.5], [2.5, 5]] });
  B.parapet(-8, -13.6, -8, Z0, L1, 1.0, 'plaster', 'concrete');
  B.parapet(8, -13.6, 8, Z0, L1, 1.0, 'plaster', 'concrete');
  for (const x of [-8, 8]) B.deco(x - 0.2, PLINTH, -13.6, x + 0.2, L1_UNDER, Z0, 'plaster');

  // South, with the exterior stair up from the plaza.
  B.slab(-8, Z1, 8, 13.6, L1_UNDER, L1, 'concrete', 'concrete');
  // Split, rather than a `gaps` entry at the stair mouth. `Builder.parapet` does not OPEN
  // a gap — it lowers that span to `y + MAX_STEP + 0.07`, which is a crenel you shoot over,
  // not a doorway. When the crenel-safety pass raised that from 0.44 to 0.62 it crossed
  // MAX_STEP (0.55), and a 0.62 m bar appeared across the full width of this staircase's
  // head. The stair has been impassable in both directions ever since, silently: the
  // player just stops. The crenel at [4, 6.5] is a genuine firing position and stays.
  B.parapet(-8, 13.6, -2.2, 13.6, L1, 1.0, 'plaster', 'concrete');
  B.parapet(0.4, 13.6, 8, 13.6, L1, 1.0, 'plaster', 'concrete', { gaps: [[4, 6.5]] });
  B.parapet(-8, Z1, -8, 13.6, L1, 1.0, 'plaster', 'concrete');
  B.parapet(8, Z1, 8, 13.6, L1, 1.0, 'plaster', 'concrete');
  for (const x of [-8, 8]) B.deco(x - 0.2, PLINTH, Z1, x + 0.2, L1_UNDER, 13.6, 'plaster');
  B.stairs({ x0: -2.2, z0: 13.6, x1: 0.4, z1: 20.4, y0: 0, y1: L1, dir: '-z', matName: 'concreteDark', surface: 'concrete', rail: true });

  // West, with the exterior stair up from the courtyard side.
  B.slab(-13.6, -2.6, X0, 4.4, L1_UNDER, L1, 'concrete', 'concrete');
  B.parapet(-13.6, -2.6, -13.6, 4.4, L1, 1.0, 'plaster', 'concrete', { gaps: [[-1.2, 1.8]] });
  B.parapet(-13.6, -2.6, X0, -2.6, L1, 1.0, 'plaster', 'concrete');
  for (const z of [-2.6, 4.4]) B.deco(-13.6, PLINTH, z - 0.2, X0, L1_UNDER, z + 0.2, 'plaster');
  B.stairs({ x0: -13.6, z0: 4.4, x1: -11.2, z1: 11.2, y0: 0, y1: L1, dir: '-z', matName: 'concreteDark', surface: 'concrete', rail: true });

  // Arcade colonnade down the east flank — cover, and it breaks the flanking sightline.
  // These lintels sit directly on top of the pillars' flat, standable tops (pillar()
  // collider height == visual height, props.js:1247-1249). A non-colliding `deco` beam
  // there let a mantled player clip up into/through it onto an unintended perch — the
  // beam must collide so it caps the pillar tops instead of opening into them.
  for (const z of [-9, -5.4, -1.8, 1.8, 5.4, 9]) B.prop('pillar', 11.7, 0, z, 0, { variant: '3.9' });
  B.box(10.9, 3.9, -9.6, 12.5, 4.35, 9.6, 'concreteDark', 'concrete');
  for (const z of [-9.5, -6]) B.prop('pillar', -11.7, 0, z, 0, { variant: '3.9' });
  B.box(-12.5, 3.9, -10.2, -10.9, 4.35, -5.4, 'concreteDark', 'concrete');

  // Awnings and signage on the ground-floor faces.
  B.prop('awning', -4.9, 2.62, 11.9, 0);
  B.prop('awning', 4.9, 2.62, 11.9, 0);
  B.prop('awning', -4.9, 2.62, -11.9, Math.PI);
  B.prop('awning', 4.9, 2.62, -11.9, Math.PI);

  dressMarketHall(B, X0, X1, Z0, Z1);
  dressMarketInterior(B);
}

/**
 * THE LANTERN — the plaza's landmark.
 *
 * The hall roof was a bare 20 × 22 m plate: the most contested position on the map and
 * the least readable object on the skyline. A glazed roof lantern with a stepped cap
 * fixes both at once — it gives the centre lane a silhouette you can navigate by from any
 * corner of the map, and it gives the roof deck the central cover a duelling ground needs.
 * It sits clear of both the stair well and every parapet gap, so no route changes.
 */
function marketLantern(B) {
  const y = L2;
  // Stepped base — waist-high, so it is usable cover before you even reach the glazing.
  B.box(-3.4, y, -3.4, 3.4, y + 0.32, 3.4, 'concreteDark', 'concrete');
  B.box(-3.0, y + 0.32, -3.0, 3.0, y + 1.05, 3.0, 'plaster', 'concrete');
  B.deco(-3.15, y + 1.02, -3.15, 3.15, y + 1.18, 3.15, 'concreteDark');

  // Clerestory: piers on the corners, glazing between, so it reads as a lantern and not
  // as a shed. The glass is a collider (surface 'glass') like every other pane on the map.
  // The clerestory is SEALED from the base top (y+1.05) to the cap (y+3.3).
  //
  // It was not. The piers started at y+1.18 while the base topped out at y+1.05, so they
  // floated 0.13 m; the glass ran y+1.35 to y+3.1, leaving a 0.30 m open ring at 9.10-9.40
  // and a second 0.20 m ring at 11.15-11.35, on all four faces — 4 x 4.83 m of aperture.
  // The lower ring sits 1.05-1.35 m above the roof deck, which is exactly chest height on
  // the most contested position on the map: you could see, shoot and be shot straight
  // through the middle of the lantern. Only the non-colliding coping and mullions were in
  // those bands, so nothing was stopping anything.
  for (const sx of [-2.72, 2.72]) for (const sz of [-2.72, 2.72]) {
    B.box(sx - 0.28, y + 1.05, sz - 0.28, sx + 0.28, y + 3.3, sz + 0.28, 'plaster', 'concrete');
  }
  for (const s of [-2.85, 2.85]) {
    B.box(-2.44, y + 1.05, s - 0.05, 2.44, y + 3.3, s + 0.05, 'glass', 'glass', { cast: false, receive: false });
    B.box(s - 0.05, y + 1.05, -2.44, s + 0.05, y + 3.3, 2.44, 'glass', 'glass', { cast: false, receive: false });
    for (const m of [-1.22, 0, 1.22]) {
      B.deco(m - 0.06, y + 1.05, s - 0.1, m + 0.06, y + 3.3, s + 0.1, 'metal', { cast: false });
      B.deco(s - 0.1, y + 1.05, m - 0.06, s + 0.1, y + 3.3, m + 0.06, 'metal', { cast: false });
    }
  }
  // Stepped cap.
  B.box(-3.3, y + 3.3, -3.3, 3.3, y + 3.62, 3.3, 'concreteDark', 'concrete');
  B.deco(-2.6, y + 3.62, -2.6, 2.6, y + 4.15, 2.6, 'brick');
  B.deco(-1.7, y + 4.15, -1.7, 1.7, y + 4.62, 1.7, 'brick');
  B.deco(-0.85, y + 4.62, -0.85, 0.85, y + 5.0, 0.85, 'concreteDark');

  // Clock face on the south pier band + a flag mast the whole map can see.
  for (const sz of [3.17, -3.17]) B.deco(-0.95, y + 1.35, sz - 0.05, 0.95, y + 2.72, sz + 0.05, 'concreteDark', { cast: false });
  board(B, 0, y + 1.5, 3.24, 0, 1.15, 1.15, 0xe6dcc4);
  board(B, 0, y + 1.5, -3.24, Math.PI, 1.15, 1.15, 0xe6dcc4);
  for (const sgn of [1, -1]) {
    B.deco(-0.05, y + 2.05, sgn * 3.27, 0.05, y + 2.52, sgn * 3.3, 'concreteDark', { cast: false });
    B.deco(-0.04, y + 2.03, sgn * 3.27, 0.34, y + 2.11, sgn * 3.3, 'concreteDark', { cast: false });
  }
  B.cylinder(0, y + 5.0, 0, 0.09, 4.6, 8, 'metal', 'metal');
  B.cylinder(0, y + 9.6, 0, 0.16, 0.2, 8, 'metal', 'metal');
  hang(B, 0.95, y + 9.3, 0, Math.PI / 2, 1.7, 1.05, PZ_PAINT);
  for (const a of [0.7, 2.8, 4.9]) {
    B.cable(0, y + 9.4, 0, Math.cos(a) * 3.1, y + 3.62, Math.sin(a) * 3.1, 0.35, 0.04, 'metal');
  }
}

/**
 * Market hall façades. Four twenty-metre elevations of flat render is what made the
 * centre lane read as a placeholder; the fix is a painted plinth band (the plaza's
 * colour signature), pilasters and a string course to catch the sun, downpipes, hoardings
 * over the doors, and grime where people and water actually go.
 */
function dressMarketHall(B, X0, X1, Z0, Z1) {
  const rng = B.rng;
  const doorsNS = [[-6.4, -3.4], [3.4, 6.4]];
  const bandY = PLINTH + 0.02, bandH = 0.92;

  // Verdigris plinth band, all four elevations.
  paintBand(B, true, X0, X1, Z1 + 0.03, bandY, bandH, PZ_PAINT, doorsNS, 0);
  paintBand(B, true, X0, X1, Z0 - 0.03, bandY, bandH, PZ_PAINT, doorsNS, Math.PI);
  paintBand(B, false, Z0, Z1, X1 + 0.03, bandY, bandH, PZ_PAINT, [[-1.9, 1.9]], Math.PI / 2);
  paintBand(B, false, Z0, Z1, X0 - 0.03, bandY, bandH, PZ_PAINT, [[-5.4, -1.8]], -Math.PI / 2);

  // Pilasters and the string course between the storeys. Both are pure shadow-catchers:
  // 12 cm of relief is the difference between a wall and a photograph of a wall.
  for (const x of [-9.4, -4.9, 0, 4.9, 9.4]) {
    B.deco(x - 0.28, PLINTH, Z1, x + 0.28, L2_UNDER, Z1 + 0.13, 'plaster');
    B.deco(x - 0.28, PLINTH, Z0 - 0.13, x + 0.28, L2_UNDER, Z0, 'plaster');
  }
  for (const z of [-9.9, -5.2, 0, 5.2, 9.9]) {
    B.deco(X1, PLINTH, z - 0.28, X1 + 0.13, L2_UNDER, z + 0.28, 'plaster');
    B.deco(X0 - 0.13, PLINTH, z - 0.28, X0, L2_UNDER, z + 0.28, 'plaster');
  }
  for (const y of [L1_UNDER - 0.28, L2_UNDER - 0.34]) {
    B.deco(X0 - 0.2, y, Z1, X1 + 0.2, y + 0.2, Z1 + 0.2, 'concreteDark');
    B.deco(X0 - 0.2, y, Z0 - 0.2, X1 + 0.2, y + 0.2, Z0, 'concreteDark');
    B.deco(X1, y, Z0 - 0.2, X1 + 0.2, y + 0.2, Z1 + 0.2, 'concreteDark');
    B.deco(X0 - 0.2, y, Z0 - 0.2, X0, y + 0.2, Z1 + 0.2, 'concreteDark');
  }

  // Downpipes off every corner, with the wet stain each one leaves behind it.
  for (const [px, pz] of [[X0 - 0.1, Z0 - 0.1], [X1 + 0.1, Z0 - 0.1], [X0 - 0.1, Z1 + 0.1], [X1 + 0.1, Z1 + 0.1]]) {
    B.cylinder(px, PLINTH, pz, 0.09, L2_UNDER - PLINTH, 6, 'metal', 'metal');
    B.cylinder(px, L2_UNDER - 0.1, pz, 0.13, 0.22, 6, 'metal', 'metal');
    B.deco(px - 0.19, PLINTH, pz - 0.19, px + 0.19, 1.9, pz + 0.19, 'concreteDark', { cast: false });
  }

  // Trader hoardings over the four ground entrances, plus a big gable sign facing north
  // — the first thing team 1 sees coming down the plaza.
  for (const [d0, d1] of doorsNS) {
    board(B, (d0 + d1) / 2, 2.62, Z1 + 0.16, 0, 2.7, 0.72, rng.pick([PZ_PAINT, OT_PAINT, 0xc4705a]));
    board(B, (d0 + d1) / 2, 2.62, Z0 - 0.16, Math.PI, 2.7, 0.72, rng.pick([PZ_PAINT, OT_PAINT, 0xc4705a]));
  }
  board(B, 0, 6.9, Z0 - 0.24, Math.PI, 7.4, 1.5, 0xe6dcc4);
  board(B, 0, 6.9, Z1 + 0.24, 0, 7.4, 1.5, 0xe6dcc4);
  board(B, X1 + 0.24, 2.9, -6.8, Math.PI / 2, 2.4, 0.9, PZ_PAINT);
  board(B, X0 - 0.24, 2.9, 7.0, -Math.PI / 2, 2.4, 0.9, OT_PAINT);

  // Footfall: the tile is worn through to dirt in the doorways and along the arcade.
  for (const [d0, d1] of doorsNS) {
    B.wear(d0 - 0.3, Z1 - 0.5, d1 + 0.3, Z1 + 2.6);
    B.wear(d0 - 0.3, Z0 - 2.6, d1 + 0.3, Z0 + 0.5);
  }
  B.wear(X1 - 0.5, -2.0, X1 + 2.8, 2.0);
  B.wear(X0 - 2.8, -5.5, X0 + 0.5, -1.7);
  B.wear(10.9, -9.8, 12.5, 9.8);

  // Rubbish blown into the angle between plinth and pavement.
  B.debris(-9.2, Z1 + 0.9, 0.9, 8, 0, { mats: ['wood', 'rubber', 'concreteDark'] });
  B.debris(8.6, Z0 - 0.9, 0.8, 7, 0, { mats: ['wood', 'rubber'] });
  B.debris(X1 + 1.1, 8.4, 1.0, 8, 0, { mats: ['wood', 'concreteDark'] });
  B.prop('barrel', X0 - 1.0, 0, -9.4, 0.4, { color: BARREL_COLORS[3] });
  B.prop('crate', X1 + 1.2, 0, -9.6, 0.3, { variant: 'small' });
}

/**
 * Inside the hall. An empty market hall is a warehouse; what makes it a market is
 * counters to fight across, produce stacked in the aisles, and bunting overhead.
 * Everything solid here is deliberately chest-high so it reads as cover, and the aisles
 * between are kept ≥ 1.8 m so bots path through exactly as they did before.
 */
function dressMarketInterior(B) {
  const rng = B.rng;
  const y = PLINTH;

  // Two trading counters down the spine of the hall, with a wide aisle between them.
  for (const [cx0, cx1] of [[-4.0, -0.9], [0.9, 4.0]]) {
    B.box(cx0, y, -2.35, cx1, y + 0.86, -1.45, 'wood', 'wood');
    B.deco(cx0 - 0.09, y + 0.86, -2.44, cx1 + 0.09, y + 0.98, -1.36, 'concreteDark');
    for (let x = cx0 + 0.4; x < cx1; x += 0.72) B.deco(x - 0.05, y + 0.1, -2.3, x + 0.05, y + 0.84, -1.5, 'wood', { cast: false });
    B.deco(cx0 + 0.1, y + 0.98, -2.2, cx0 + 0.7, y + 1.28, -1.7, 'wood');
    B.prop('crate', (cx0 + cx1) / 2 + 0.6, y, -2.9, rng.range(-0.4, 0.4), { variant: 'small' });
  }
  B.prop('stall', -6.6, y, 0.6, 0, { color: AWNING_COLORS[1] });
  B.prop('stall', 6.4, y, 3.0, Math.PI / 2, { color: AWNING_COLORS[0] });
  B.prop('crate', -8.4, y, 2.6, 0.35);
  B.prop('crate', -8.6, y, 3.7, -0.2, { variant: 'small' });
  B.prop('pallets', 8.6, y, 1.4, 0.15);

  // Stock room (north-west): steel racking against the back wall, sacks and pallets.
  B.box(-6.5, y, -10.5, -4.0, y + 0.12, -9.8, 'metal', 'metal');
  for (const ry of [1.02, 1.92]) {
    B.deco(-6.5, y + ry, -10.5, -4.0, y + ry + 0.1, -9.8, 'metal');
    B.deco(-6.5, y + ry - 0.06, -10.52, -4.0, y + ry, -10.44, 'metal', { cast: false });
  }
  for (const rx of [-6.42, -4.08]) B.box(rx - 0.07, y, -10.48, rx + 0.07, y + 2.16, -9.84, 'metal', 'metal');
  for (let i = 0; i < 4; i++) {
    B.deco(-6.3 + i * 0.6, y + 1.14, -10.42, -5.85 + i * 0.6, y + 1.6, -9.9, 'sandbag');
    if (i % 2 === 0) B.deco(-6.3 + i * 0.6, y + 2.04, -10.42, -5.85 + i * 0.6, y + 2.4, -9.9, 'wood');
  }
  B.prop('pallets', -8.4, y, -9.6, 0.1, { variant: 'tall' });
  B.prop('crate', -8.6, y, -6.4, 0.5);
  B.prop('crate', -7.7, y, -6.9, -0.35, { variant: 'small' });
  B.prop('barrel', -4.6, y, -6.6, 0, { color: BARREL_COLORS[1] });

  // Office (south-east): desk, screen wall, filing.
  B.box(8.4, y, 5.9, 9.5, y + 0.74, 8.1, 'wood', 'wood');
  B.deco(8.3, y + 0.74, 5.8, 9.6, y + 0.82, 8.2, 'concreteDark');
  // West of the south-east doorway (x 3.6..6.2), not across the middle of it. This screen
  // stood 0.5 m behind the door covering 1.1 m of a 2.6 m opening, so only one of five
  // lateral lanes could pass — the 0.80 m slot between its east face and the jamb, against
  // a 0.72 m body. The mirror door opposite is clean, which is what gave it away.
  B.box(1.6, y, 9.8, 2.7, y + 1.35, 10.3, 'metal', 'metal');
  B.deco(1.6, y + 0.32, 9.74, 2.7, y + 0.38, 9.8, 'metal', { cast: false });
  B.deco(1.6, y + 0.86, 9.74, 2.7, y + 0.92, 9.8, 'metal', { cast: false });
  B.prop('crate', 6.6, y, 10.0, 0.2, { variant: 'small' });
  board(B, 6.9, 2.5, 5.24, 0, 1.5, 0.5, PZ_PAINT);

  // Bunting and hanging banners between the roof beams — reads instantly as "market",
  // costs nothing, and every panel is 2.4 m up so nobody can walk into one.
  const bunting = [0xc4705a, 0xe6dcc4, PZ_PAINT, OT_PAINT, 0x7fa8c4];
  for (let i = 0; i < 7; i++) {
    const x = -8 + i * 2.65;
    hang(B, x, 3.48, -0.3 + (i % 3) * 3.1, 0, 0.85, 1.0, bunting[i % bunting.length]);
  }
  for (const z of [-8.4, -4.2, 4.6, 8.6]) B.cable(-9.4, 3.42, z, 9.4, 3.42, z, 0.55, 0.035, 'metal', { segs: 6 });
  for (let i = 0; i < 10; i++) {
    hang(B, -8.6 + i * 1.9, 3.34 - Math.sin((i / 9) * Math.PI) * 0.42, -8.4, 0, 0.42, 0.5, bunting[(i + 2) % bunting.length]);
    hang(B, -8.6 + i * 1.9, 3.34 - Math.sin((i / 9) * Math.PI) * 0.42, 4.6, 0, 0.42, 0.5, bunting[(i + 4) % bunting.length]);
  }

  // Trodden aisles through the tile.
  B.wear(-5.2, -9.4, -3.8, 9.4, y);
  B.wear(-1.2, -1.2, 1.2, 9.6, y);
  B.wear(4.2, -9.4, 5.6, 4.6, y);
  B.debris(-9.0, 6.8, 0.9, 6, y, { mats: ['wood', 'sandbag'] });
  B.debris(9.0, -8.0, 0.8, 6, y, { mats: ['wood', 'rubber'] });

  // Upper floor: the room in the middle is somebody's office.
  // Beside the north doorway (x -2.2..0.2), not inside it — the desk overlapped 1.2 m of
  // the 2.4 m opening, leaving a 0.49 m straight lane against a 0.72 m body.
  B.box(0.6, L1, -3.5, 2.2, L1 + 0.76, -2.4, 'wood', 'wood');
  B.deco(-2.7, L1 + 0.76, -3.6, -0.9, L1 + 0.84, -2.3, 'concreteDark');
  // Likewise beside the south doorway (x 0.4..2.8), which it used to stand in: 0.29 m of
  // straight lane. The two pieces now sit on opposite sides of the room from their doors.
  B.box(-2.6, L1, 2.6, -1.4, L1 + 1.3, 3.6, 'metal', 'metal');
  B.prop('crate', 2.1, L1, -3.0, 0.4, { variant: 'small' });
  B.prop('sandbags', 8.6, L1, 0, Math.PI / 2);
  B.prop('sandbags', -8.6, L1, 6.6, Math.PI / 2, { variant: 'low' });
  B.wear(-9.4, -1.6, 9.4, -0.2, L1);
  B.wear(-0.8, -9.6, 0.8, 9.6, L1);
}

/** Rooftop services on the market hall — the deck should look worked on, not swept. */
function dressHallRoof(B) {
  const y = L2;
  // Cistern on a stand, plumbed back down through the roof.
  // Slid 1.2 m east, clear of ROOF_STAIR's well (x -8.6..-6.2). It used to overlap half
  // the 2.40 m width with its underside at 8.05 over treads topping out at 6.32-7.18 —
  // 0.87 m of headroom, so a standing player was stopped and only the narrow west lane
  // walked. The height below is what matters for the launch geometry, not the x, so
  // sliding it does not reopen that.
  B.box(-6.2, y, 4.2, -3.8, y + 0.9, 6.6, 'metal', 'metal');
  for (const sx of [-6.0, -4.0]) for (const sz of [4.4, 6.4]) B.deco(sx - 0.08, y, sz - 0.08, sx + 0.08, y + 0.9, sz + 0.08, 'metal');
  // 1.3 tall, not 1.5. At 1.5 its top sat at 10.45, which is the one place on the map a
  // player can jump-and-air-mantle onto the 11.67 lantern deck — 14,441 valid launch
  // solutions over a 2.8-8.4 m/s speed window, so a route rather than a trick. From the
  // roof deck (8.05), the parapet (9.10) and the low roof AC (9.15) there are zero. Two
  // decimetres removes the only ladder to the map's highest surface.
  B.cylinder(-5.0, y + 0.9, 5.4, 1.05, 1.3, 14, 'metal', 'metal', { collide: true });
  B.cylinder(-5.0, y + 2.4, 5.4, 1.12, 0.12, 14, 'metal', 'metal');
  B.beam(-5.0, y + 0.95, 4.4, -5.0, y + 0.2, 2.6, 0.08, 'metal');
  B.beam(-5.0, y + 0.2, 2.6, -2.0, y + 0.2, 2.6, 0.08, 'metal');

  // Aerial mast with guys, and a dish — cheap, tall, and it breaks the roofline.
  B.cylinder(7.6, y, -8.6, 0.08, 4.4, 6, 'metal', 'metal');
  for (let i = 0; i < 5; i++) B.beam(7.2, y + 2.0 + i * 0.42, -8.6, 8.0, y + 2.0 + i * 0.42, -8.6, 0.045, 'metal');
  for (const a of [0.4, 2.5, 4.6]) B.cable(7.6, y + 4.2, -8.6, 7.6 + Math.cos(a) * 2.4, y + 0.05, -8.6 + Math.sin(a) * 2.4, 0.15, 0.035, 'metal');
  B.cylinder(8.9, y + 1.3, 6.4, 0.62, 0.16, 12, 'metal', 'metal', { rz: 0.9 });
  B.beam(8.9, y + 1.3, 6.4, 8.9, y, 6.4, 0.08, 'metal');

  // Cable tray hopping between the plant, plus a run of conduit along the parapet.
  B.cable(-5.0, y + 0.9, 5.4, 4.6, y + 1.05, -6.2, 0.55, 0.04, 'metal', { segs: 6 });
  B.cable(6.4, y + 1.05, -4.4, 7.6, y + 3.2, -8.6, 0.3, 0.035, 'metal', { segs: 4 });
  for (const sz of [-10.6, 10.6]) B.deco(-9.4, y + 0.62, sz - 0.05, 9.4, y + 0.74, sz + 0.05, 'metal', { cast: false });

  // Somebody has been fighting from up here: sandbags built into three of the parapet
  // crenellations, and duckboards worn between them.
  B.prop('sandbags', -5.0, y, -10.2, 0, { variant: 'low' });
  B.prop('sandbags', 5.0, y, 10.2, Math.PI, { variant: 'low' });
  B.prop('sandbags', 9.2, y, 5.5, -Math.PI / 2, { variant: 'low' });
  B.prop('crate', -8.8, y, -8.6, 0.4);
  B.prop('crate', -8.2, y, -7.6, -0.3, { variant: 'small' });
  B.prop('barrel', 8.9, y, -2.2, 0.2, { color: BARREL_COLORS[2] });
  for (let i = 0; i < 9; i++) B.deco(-1.2 + i * 0.42, y + 0.02, -9.6, -0.9 + i * 0.42, y + 0.08, -4.2, 'wood', { cast: false });
  for (let i = 0; i < 9; i++) B.deco(4.2, y + 0.02, 3.0 + i * 0.42, 9.6, y + 0.08, 3.3 + i * 0.42, 'wood', { cast: false });

  // Weathering: standing water stains and a patch of failed asphalt roofing.
  B.wear(-2.0, -9.4, 3.4, -7.2, y, 'concreteDark');
  B.wear(4.0, 7.4, 8.8, 10.2, y, 'concreteDark');
  B.debris(8.2, 8.6, 1.1, 7, y, { mats: ['concreteDark', 'wood'] });
}

// ────────────────────────────────────────────────────────────────────── old town

/**
 * Two brick blocks built against the west town wall, their roof terraces joined by a
 * raised rampart over the courtyard. Terraces are strong but exposed to the market hall
 * roof and to the courtyard below — power positions with counters.
 */
function buildOldTown(B) {
  oldTownBlock(B, -32, -16, 'A');
  oldTownBlock(B, 10, 28, 'B');
  cisternTower(B);

  // ── rampart: solid mass between the two terraces, flush at both ends
  B.box(-IN, 0, -16, -36, TER_UNDER, 10, 'brick', 'concrete');
  B.box(-IN, TER_UNDER, -16, -36, TER, 10, 'concreteDark', 'concrete');
  B.parapet(-36, -16, -36, 10, TER, 1.05, 'brick', 'concrete', {
    gaps: [[-13, -10], [-4, -1], [4, 7]],
  });
  // Blind arcade in the mass so it reads as masonry, not a slab.
  for (let z = -14; z < 9; z += 3.2) {
    B.deco(-36.35, 0.9, z, -36, 3.0, z + 2.1, 'concreteDark', { cast: false });
  }
  B.prop('crate', -38.4, TER, -8.6, 0.4);
  B.prop('crate', -38.4, TER, 4.2, -0.5, { variant: 'small' });
  B.prop('sandbags', -37.4, TER, -2.0, Math.PI / 2, { variant: 'low' });

  // ── old-town gate wall: gives the courtyard a defined edge with three arched
  // gateways, and is the single most effective sightline breaker on the map — without it
  // the courtyard and the plaza merge into one 75 m diagonal.
  B.wall(-14.2, -16, -13.8, 10, 0, 4.6, 'brick', 'concrete', {
    openings: [
      // The third gateway used to sit at z 5.0-8.5, which is 85% filled by the market hall's
      // west balcony stair — that run climbs z 11.2 -> 4.4 half a metre behind this wall, so
      // at 5.0-8.5 it is 2.5-4 m of solid tread. Measured clear rectangle 1.23 x 0.80 m: an
      // arch you could see through and not walk through, with a beaten-track wear decal
      // painted across it advertising a route that did not exist. Moved into the clear span
      // between the other two, the only part of this wall the stair does not stand behind.
      { a0: -12.5, a1: -8.5, y0: 0, y1: 3.2 },
      { a0: -7.5, a1: -4.0, y0: 0, y1: 3.2 },
      { a0: -2.5, a1: 1.5, y0: 0, y1: 3.2 },
    ],
  });
  for (const [a0, a1] of [[-12.5, -8.5], [-7.5, -4.0], [-2.5, 1.5]]) {
    B.deco(-14.45, 3.2, a0 - 0.3, -13.55, 3.62, a1 + 0.3, 'concreteDark');
    B.deco(-14.45, 0, a0 - 0.3, -13.55, 3.2, a0, 'concreteDark');
    B.deco(-14.45, 0, a1, -13.55, 3.2, a1 + 0.3, 'concreteDark');
  }
  B.deco(-14.5, 4.6, -16, -13.5, 4.95, 10, 'concreteDark');
  B.prop('streetlight', -12.9, 0, -13.6, Math.PI / 2);

  // Courtyard furniture.
  B.prop('well', -27, 0, -3, 0.3);
  B.prop('palm', -32.5, 0, 6.5, 0.4, { variant: 'tall' });
  B.prop('palm', -20.5, 0, -12.5, 2.1);
  B.prop('palm', -30.5, 0, -13.5, 1.2);
  B.prop('stall', -22.5, 0, 1.5, Math.PI / 2, { color: AWNING_COLORS[0] });
  B.prop('stall', -22.5, 0, -6.5, Math.PI / 2, { color: AWNING_COLORS[1] });
  B.prop('stall', -31, 0, 1.2, 0, { color: AWNING_COLORS[3] });
  B.prop('jersey', -17.5, 0, -3.4, 0);
  B.prop('jersey', -17.5, 0, -0.9, 0);
  B.prop('sandbags', -25.5, 0, -13.4, 0);
  B.prop('sandbags', -27.4, 0, -13.4, 0);
  B.prop('crate', -34.5, 0, -11.5, 0.3);
  B.prop('crate', -33.6, 0, -12.3, -0.4, { variant: 'small' });
  B.prop('barrel', -35.2, 0, 8.4, 0.2, { color: BARREL_COLORS[0] });
  B.prop('barrel', -34.4, 0, 7.7, 0.9, { color: BARREL_COLORS[2] });
  B.prop('streetlight', -19.4, 0, -8.5, Math.PI);
  B.prop('streetlight', -19.4, 0, 5.5, Math.PI);

  dressOldTownCourt(B);
}

/**
 * The courtyard between the two blocks. What a lived-in square has that an empty one
 * does not: washing strung overhead, bills pasted on the gate wall, a beaten track worn
 * through each archway, and rubbish where the wind puts it.
 */
function dressOldTownCourt(B) {
  const rng = B.rng;

  // Washing lines spanning the square, tied off on the streetlight masts on the way.
  for (const z of [-11.0, -2.0, 6.4]) {
    B.cable(-35.6, 5.7, z, -14.4, 5.5, z, 1.15, 0.035, 'metal', { segs: 7 });
    for (let i = 0; i < 9; i++) {
      const f = (i + 0.5) / 9;
      const x = -35.6 + 21.2 * f;
      hang(B, x, 5.7 - 1.15 * 4 * f * (1 - f) - 0.04, z, 0, rng.range(0.42, 1.05), rng.range(0.5, 1.3), rng.pick(LAUNDRY));
    }
  }

  // Whitewashed gate wall with bill posters and an ochre name band over the centre arch.
  B.deco(-14.28, PLINTH, -16, -14.18, 1.75, 10, 'plaster', { cast: false });
  B.deco(-13.82, PLINTH, -16, -13.72, 1.75, 10, 'plaster', { cast: false });
  for (let i = 0; i < 7; i++) {
    const z = rng.range(-15, 9);
    if (Math.abs(z + 10.5) < 2.6 || Math.abs(z + 0.5) < 2.6 || Math.abs(z - 6.75) < 2.4) continue;
    const w = rng.range(0.7, 1.25);
    board(B, -14.32, rng.range(0.9, 2.4), z, -Math.PI / 2, w, w * rng.range(1.1, 1.6),
      rng.pick([0xe0d3b0, OT_PAINT, 0xc4705a, 0x9ab6c4]));
  }
  board(B, -14.4, 3.75, -0.5, -Math.PI / 2, 3.6, 0.78, OT_PAINT);
  board(B, -13.6, 3.75, -0.5, Math.PI / 2, 3.6, 0.78, OT_PAINT);

  // Beaten tracks through the three archways and across to the well.
  for (const [a0, a1] of [[-12.5, -8.5], [-7.5, -4.0], [-2.5, 1.5]]) {
    B.wear(-17.2, a0 - 0.4, -11.6, a1 + 0.4);
  }
  B.wear(-29.5, -5.5, -16.0, -0.6);
  B.wear(-30.5, -4.6, -23.5, 4.4);
  B.wear(-24.6, -14.0, -21.4, -3.0);
  B.debris(-14.9, -13.6, 1.2, 9, 0, { mats: ['wood', 'rubber', 'concreteDark'] });
  B.debris(-35.2, -14.2, 1.1, 8, 0, { mats: ['concreteDark', 'brick', 'wood'] });
  B.debris(-21.6, 8.4, 1.3, 9, 0, { mats: ['wood', 'rubber'] });
  B.prop('barrel', -15.4, 0, 8.6, 0.5, { color: BARREL_COLORS[1] });
  B.prop('crate', -16.2, 0, 7.6, -0.4, { variant: 'small' });
  B.prop('tyres', -34.6, 0, -4.2, 0.7);

  // Terracotta pantile roll along the rampart coping, and awnings over the block doors.
  // Skip the crenellation gaps so the roll never floats over a firing slot.
  for (let z = -15.6; z < 9.6; z += 0.62) {
    if ((z > -13.4 && z < -9.6) || (z > -4.4 && z < -0.6) || (z > 3.6 && z < 7.4)) continue;
    B.cylinder(-36, TER + 1.14, z, 0.16, 0.6, 6, 'brick', 'concrete', { rx: Math.PI / 2, cast: false });
  }
  B.prop('awning', -29.7, 2.62, -15.9, 0);
  B.prop('awning', -31.7, 2.62, 10.1, Math.PI);
  B.prop('awning', -24.5, 2.62, 10.1, Math.PI);
  board(B, -29.7, 2.66, -16.14, Math.PI, 2.3, 0.6, PZ_PAINT);
  board(B, -31.7, 2.66, 10.34, 0, 2.3, 0.6, 0xc4705a);
}

/**
 * One old-town block: x[−41, −21] × z[z0, z1], ground floor split into two through-rooms,
 * open roof terrace at TER reached by an internal stair.
 */
function oldTownBlock(B, z0, z1, tag) {
  const X0 = -IN, X1 = -21, T = 0.4;
  const mid = (z0 + z1) / 2;
  // Stairwell sits on the EAST side of the block: the west strip x[−41,−36] must stay a
  // clear deck, because that is where the rampart meets the terrace.
  const stair = [-26.4, mid - 3.4, -24.0, mid + 3.4];

  B.box(X0, 0, z0 - 0.5, X1 + 0.5, PLINTH, z1 + 0.5, 'concreteDark', 'concrete');

  // Shell. The west side is the town wall itself, so only three faces need walls.
  const otWin = { y0: 1.2, y1: 2.5, frame: 'window', stain: 1.2, shutterColors: OT_SHUTTERS };
  B.wall(X0, z0, X1, z0 + T, PLINTH, TER_UNDER, 'brick', 'concrete', {
    openings: tag === 'A'
      ? [{ a0: -31, a1: -28.4, y0: PLINTH, y1: 2.45, frame: 'door' },
         { a0: -37, a1: -34, ...otWin, glass: true, shutter: -1 }]
      : [{ a0: -33, a1: -30.4, y0: PLINTH, y1: 2.45, frame: 'door' },
         { a0: -27, a1: -24, ...otWin, shutter: -1 }],
  });
  B.wall(X0, z1 - T, X1, z1, PLINTH, TER_UNDER, 'brick', 'concrete', {
    openings: tag === 'A'
      ? [{ a0: -33, a1: -30.4, y0: PLINTH, y1: 2.45, frame: 'door' },
         { a0: -26, a1: -23, ...otWin, shutter: 1 }]
      : [{ a0: -31, a1: -28.4, y0: PLINTH, y1: 2.45, frame: 'door' },
         { a0: -37, a1: -34, ...otWin, glass: true, shutter: 1 }],
  });
  B.wall(X1 - T, z0, X1, z1, PLINTH, TER_UNDER, 'brick', 'concrete', {
    openings: [
      { a0: mid - 4.4, a1: mid - 1.8, y0: PLINTH, y1: 2.45, frame: 'door' },
      { a0: mid + 2.6, a1: mid + 5.4, y0: 1.15, y1: 2.45, glass: true, frame: 'window', stain: 1.2, shutter: 1, ...{ shutterColors: OT_SHUTTERS } },
      // No shutters on this one: it sits shoulder-to-shoulder with the door reveal.
      //
      // z0 + 0.6, not z0 + 1.6. The door opposite is `mid`-relative and this is `z0`-relative,
      // so the two only clear each other when the block is long enough — block B is 18 m and
      // clears by 0.4 m, block A is 16 m and OVERLAPPED by 0.60 m, putting the window's sill
      // course inside the doorway and narrowing it to 2.00 m of an authored 2.60.
      { a0: z0 + 0.6, a1: z0 + 3.2, y0: 1.15, y1: 2.45, frame: 'window', stain: 1 },
    ],
  });

  // Internal spine wall with two doorways — every room has ≥2 exits.
  B.wall(-31.2, z0, -30.8, z1, PLINTH, TER_UNDER, 'plaster', 'concrete', {
    openings: [
      { a0: z0 + 2.4, a1: z0 + 5.0, y0: PLINTH, y1: 2.45, frame: 'door' },
      { a0: z1 - 5.0, a1: z1 - 2.4, y0: PLINTH, y1: 2.45, frame: 'door' },
    ],
  });

  // Terrace + stair.
  B.stairs({
    x0: stair[0], z0: stair[1], x1: stair[2], z1: stair[3],
    y0: PLINTH, y1: TER, dir: tag === 'A' ? '+z' : '-z',
    matName: 'concreteDark', surface: 'concrete', rail: true,
  });
  B.slab(X0, z0, X1, z1, TER_UNDER, TER, 'concrete', 'concrete', { hole: stair });
  // Parapets — but the edge that faces the rampart is left bare over x[−41,−36] so the
  // terrace and the rampart deck read (and walk) as one continuous surface.
  if (tag === 'A') {
    B.parapet(X0, z0, X1, z0, TER, 1.05, 'brick', 'concrete', { gaps: [[-34, -31], [-27, -24]] });
    B.parapet(-36, z1, X1, z1, TER, 1.05, 'brick', 'concrete', { gaps: [[-34, -31], [-27, -24]] });
  } else {
    B.parapet(-36, z0, X1, z0, TER, 1.05, 'brick', 'concrete', { gaps: [[-34, -31], [-27, -24]] });
    B.parapet(X0, z1, X1, z1, TER, 1.05, 'brick', 'concrete', { gaps: [[-34, -31], [-27, -24]] });
  }
  B.parapet(X1, z0, X1, z1, TER, 1.05, 'brick', 'concrete', { gaps: [[mid - 2, mid + 2]] });
  B.prop('acUnit', -24.5, TER, z0 + 3.2, 0.4);
  B.prop('crate', -27.5, TER, z1 - 3.4, 0.2);
  B.prop('barrel', -34.2, TER, z0 + 2.6, 0, { color: BARREL_COLORS[1] });
  B.prop('vent', -21.1, 2.2, mid + 7.4, -Math.PI / 2, { collide: false });

  // Interior clutter.
  B.prop('crate', -28.5, PLINTH, mid - 5.5, 0.5);
  B.prop('crate', -27.6, PLINTH, mid - 6.2, -0.3, { variant: 'small' });
  B.prop('pallets', -36.5, PLINTH, mid + 5.5, 0.2);
  B.prop('barrel', -24.5, PLINTH, mid + (tag === 'A' ? 4.5 : -4.5), 0, { color: BARREL_COLORS[3] });

  dressOldTownBlock(B, z0, z1, mid, tag);
}

/**
 * Old-town façade and terrace dressing.
 *
 * Twenty metres of unbroken brick was the worst-reading surface on the map. The cure is
 * the real Mediterranean vocabulary: a whitewashed lower storey, a stone band at first
 * floor, deep eaves in terracotta, painted shutters, rain staining, washing lines, and
 * the clutter of a roof terrace people actually use.
 */
function dressOldTownBlock(B, z0, z1, mid, tag) {
  const rng = B.rng;
  const X0 = -IN, X1 = -21;

  // Whitewashed lower storey with a stone band on top of it — instantly two-tone.
  for (const [alongX, a0, a1, b] of [
    [true, X0, X1, z0 - 0.06],
    [true, X0, X1, z1 + 0.06],
    [false, z0, z1, X1 + 0.06],
  ]) {
    if (alongX) {
      B.deco(a0, PLINTH, b - 0.05, a1, 1.62, b + 0.05, 'plaster');
      B.deco(a0, 1.62, b - 0.11, a1, 1.78, b + 0.11, 'concreteDark');
    } else {
      B.deco(b - 0.05, PLINTH, a0, b + 0.05, 1.62, a1, 'plaster');
      B.deco(b - 0.11, 1.62, a0, b + 0.11, 1.78, a1, 'concreteDark');
    }
  }

  // Deep terracotta eaves under the terrace, carried on timber corbels.
  for (const [alongX, b, sgn] of [[true, z0, -1], [true, z1, 1], [false, X1, 1]]) {
    if (alongX) {
      B.deco(X0, TER_UNDER - 0.34, b + sgn * 0.06, X1, TER_UNDER - 0.06, b + sgn * 0.52, 'brick');
      for (let x = X0 + 1.2; x < X1; x += 2.1) {
        B.deco(x - 0.09, TER_UNDER - 0.78, b + sgn * 0.06, x + 0.09, TER_UNDER - 0.34, b + sgn * 0.44, 'wood', { cast: false });
      }
    } else {
      B.deco(b + 0.06, TER_UNDER - 0.34, z0, b + 0.52, TER_UNDER - 0.06, z1, 'brick');
      for (let z = z0 + 1.2; z < z1; z += 2.1) {
        B.deco(b + 0.06, TER_UNDER - 0.78, z - 0.09, b + 0.44, TER_UNDER - 0.34, z + 0.09, 'wood', { cast: false });
      }
    }
  }

  // Downpipes and their stains, and a patch where the render has fallen off the brick.
  for (const [px, pz] of [[X1 + 0.12, z0 + 0.4], [X1 + 0.12, z1 - 0.4], [-30.9, z0 - 0.12], [-30.9, z1 + 0.12]]) {
    B.cylinder(px, PLINTH, pz, 0.075, TER_UNDER - 0.5 - PLINTH, 6, 'metal', 'metal');
    B.deco(px - 0.16, PLINTH, pz - 0.16, px + 0.16, 1.5, pz + 0.16, 'concreteDark', { cast: false });
  }
  // Surviving patches of limewash render clinging to the brick above the whitewash line.
  for (let i = 0; i < 4; i++) {
    const w = rng.range(1.6, 3.4), h = rng.range(0.9, 1.7);
    const x = rng.range(X0 + 1, X1 - w - 1);
    const yy = rng.range(1.82, TER_UNDER - 1.9);
    const b = rng.chance(0.5) ? z0 - 0.07 : z1 + 0.07;
    B.deco(x, yy, b - 0.03, x + w, yy + h, b + 0.03, 'plaster', { cast: false });
    B.deco(x + rng.range(0.2, 0.7), yy - rng.range(0.2, 0.6), b - 0.028, x + w - rng.range(0.2, 0.9), yy, b + 0.028, 'plaster', { cast: false });
  }

  // Terrace: chimney, cistern, aerial, washing, and the odd rubbish pile.
  B.deco(-33.4, TER, mid - 1.4, -32.4, TER + 1.9, mid - 0.4, 'brick');
  B.deco(-33.55, TER + 1.9, mid - 1.55, -32.25, TER + 2.1, mid - 0.25, 'concreteDark');
  B.cylinder(-32.9, TER + 2.1, mid - 0.9, 0.16, 0.36, 8, 'brick', 'concrete');
  B.cylinder(-29.5, TER, mid + (tag === 'A' ? 4.4 : -4.4), 0.95, 1.35, 12, 'metal', 'metal', { collide: true });
  B.cylinder(-29.5, TER + 1.35, mid + (tag === 'A' ? 4.4 : -4.4), 1.02, 0.1, 12, 'metal', 'metal');
  B.cylinder(-22.6, TER, z0 + 2.0, 0.07, 3.2, 6, 'metal', 'metal');
  for (let i = 0; i < 4; i++) B.beam(-23.0, TER + 1.6 + i * 0.38, z0 + 2.0, -22.2, TER + 1.6 + i * 0.38, z0 + 2.0, 0.04, 'metal');
  B.cylinder(-23.4, TER + 1.0, z1 - 2.2, 0.55, 0.14, 10, 'metal', 'metal', { rz: 1.0 });
  B.beam(-23.4, TER + 1.0, z1 - 2.2, -23.4, TER, z1 - 2.2, 0.07, 'metal');

  // A washing line strung the length of the terrace — the single most human thing on a
  // roof, and every panel is 1 m above head height so it can never be walked into.
  const wl = TER + 2.5;
  B.cable(-38.6, wl, mid - 5.6, -22.4, wl, mid - 5.6, 0.42, 0.035, 'metal', { segs: 6 });
  for (let i = 0; i < 8; i++) {
    const x = -37.4 + i * 2.0;
    const f = (x + 38.6) / 16.2;
    hang(B, x, wl - 0.36 * Math.sin(f * Math.PI) - 0.04, mid - 5.6, 0, rng.range(0.45, 0.95), rng.range(0.5, 1.15), rng.pick(LAUNDRY));
  }
  B.debris(-26.0, mid + 6.0, 1.2, 8, TER, { mats: ['wood', 'concreteDark', 'rubber'] });
  B.wear(-27.2, mid - 4.6, -24.6, mid + 4.6, TER, 'concreteDark');
  B.prop('barrel', -22.2, TER, mid - 2.4, 0.6, { color: BARREL_COLORS[0] });
  B.prop('tyres', -35.2, TER, z1 - 2.6, 0.3);

  // Interior: a shelf run and a table in each half, and worn floor through the doorways.
  for (const s of [-1, 1]) {
    const zc = mid + s * 4.2;
    B.box(-40.4, PLINTH, zc - 1.2, -39.6, PLINTH + 1.9, zc + 1.2, 'wood', 'wood');
    for (const sy of [0.62, 1.24]) B.deco(-40.5, PLINTH + sy, zc - 1.25, -39.5, PLINTH + sy + 0.07, zc + 1.25, 'wood');
    B.deco(-40.3, PLINTH + 0.69, zc - 1.0, -39.7, PLINTH + 1.05, zc - 0.2, 'sandbag');
    B.deco(-40.3, PLINTH + 1.31, zc + 0.2, -39.7, PLINTH + 1.62, zc + 0.9, 'wood');
  }
  B.box(-27.4, PLINTH, mid - 0.6, -25.6, PLINTH + 0.78, mid + 0.6, 'wood', 'wood');
  B.deco(-27.5, PLINTH + 0.78, mid - 0.7, -25.5, PLINTH + 0.86, mid + 0.7, 'wood');
  B.wear(-34.0, mid - 1.2, -22.0, mid + 1.2, PLINTH, 'concreteDark');
  B.debris(-37.5, mid - 6.5, 1.0, 7, PLINTH, { mats: ['wood', 'rubber'] });
}

/**
 * THE CISTERN TOWER — the old town's landmark.
 *
 * The west lane's silhouette was two flat-topped brick boxes and a rampart; nothing you
 * could name from across the map. This is a nineteen-metre stone water tower built into
 * the town wall: visible from every lane, unmistakable against the sky, and — because it
 * pinches the rampart deck from 5 m to 3.3 m — it also breaks the one 26 m straight run
 * up there without closing the route.
 */
function cisternTower(B) {
  const x0 = -42.6, x1 = -39.3, z0 = -5.4, z1 = -1.6;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;

  B.box(x0 - 0.25, 0, z0 - 0.25, x1 + 0.25, 2.1, z1 + 0.25, 'brick', 'concrete');   // battered base
  B.box(x0, 2.1, z0, x1, 14.6, z1, 'brick', 'concrete');                            // shaft
  for (const y of [4.2, 7.6, 11.0]) B.deco(x0 - 0.16, y, z0 - 0.16, x1 + 0.16, y + 0.26, z1 + 0.16, 'concreteDark');
  // Slit windows, deeply recessed — free relief, and they give the shaft scale.
  for (const y of [5.2, 8.6, 12.0]) {
    B.deco(x1 - 0.02, y, cz - 0.22, x1 + 0.09, y + 1.1, cz + 0.22, 'concreteDark', { cast: false });
    B.deco(cx - 0.22, y, z1 - 0.02, cx + 0.22, y + 1.1, z1 + 0.09, 'concreteDark', { cast: false });
  }
  // Belfry stage: corner piers with open arches between them.
  B.box(x0 - 0.3, 14.6, z0 - 0.3, x1 + 0.3, 15.0, z1 + 0.3, 'concreteDark', 'concrete');
  for (const px of [x0 - 0.18, x1 + 0.18]) for (const pz of [z0 - 0.18, z1 + 0.18]) {
    B.box(px - 0.42, 15.0, pz - 0.42, px + 0.42, 17.6, pz + 0.42, 'brick', 'concrete');
  }
  B.deco(x0 - 0.6, 17.0, z0 - 0.6, x1 + 0.6, 17.6, z1 + 0.6, 'brick');
  B.box(x0 + 0.2, 15.0, z0 + 0.2, x1 - 0.2, 17.0, z1 - 0.2, 'concreteDark', 'concrete');
  // Cornice and stepped cap.
  B.deco(x0 - 0.66, 17.6, z0 - 0.66, x1 + 0.66, 18.1, z1 + 0.66, 'concreteDark');
  B.deco(x0 - 0.35, 18.1, z0 - 0.35, x1 + 0.35, 18.8, z1 + 0.35, 'brick');
  B.deco(x0 + 0.35, 18.8, z0 + 0.35, x1 - 0.35, 19.4, z1 - 0.35, 'brick');
  B.deco(cx - 0.35, 19.4, cz - 0.35, cx + 0.35, 19.8, cz + 0.35, 'concreteDark');
  B.cylinder(cx, 19.8, cz, 0.07, 2.4, 6, 'metal', 'metal');
  for (const a of [0.5, 2.6, 4.7]) B.cable(cx, 22.0, cz, cx + Math.cos(a) * 1.3, 19.0, cz + Math.sin(a) * 1.3, 0.1, 0.03, 'metal');

  // Painted name board on the town-facing elevation, and washing strung off the base to
  // the nearest block — it is somebody's back yard as well as a monument.
  board(B, x1 + 0.1, 9.0, cz, Math.PI / 2, 1.9, 1.9, OT_PAINT);
  B.wear(x1, z0 - 1.2, x1 + 2.6, z1 + 1.2, TER, 'concreteDark');
  B.debris(x1 + 1.4, z1 + 2.2, 0.9, 6, TER, { mats: ['concreteDark', 'brick'] });
}

// ─────────────────────────────────────────────────────────────────────── warehouse

/**
 * HARBOUR WAREHOUSE — x[15,35] z[−33,−15]. Big open hall, mezzanine along the north end,
 * roof reached by an external switchback stair on the east face (which also feeds the
 * mezzanine at its half landing).
 */
function buildWarehouse(B) {
  const X0 = 15, X1 = 35, Z0 = -33, Z1 = -15, T = 0.4;
  const MEZZ = 4.0, MEZZ_UNDER = 3.7, ROOF = 7.9, ROOF_UNDER = 7.6;

  B.box(X0 - 0.5, 0, Z0 - 0.5, X1 + 0.5, PLINTH, Z1 + 0.5, 'concreteDark', 'concrete');

  // Corrugated shell over a concrete base course. The cladding is `metalGreen` — the
  // harbour's colour signature, and the one existing material nothing else on the map
  // uses, so it costs a single extra merge bucket and marks the whole east lane.
  const shell = (x0, z0, x1, z1, openings) => {
    B.wall(x0, z0, x1, z1, PLINTH, 1.3, 'concrete', 'concrete', { openings });
    B.wall(x0, z0, x1, z1, 1.3, ROOF_UNDER, 'metalGreen', 'metal', { openings });
  };
  shell(X0, Z1 - T, X1, Z1, [
    { a0: 18, a1: 23, y0: PLINTH, y1: 4.4 },
    { a0: 27, a1: 32, y0: PLINTH, y1: 4.4 },
  ]);
  shell(X0, Z0, X1, Z0 + T, [
    // Ground entrance on the NORTH face. Without it this elevation — the one pointed
    // straight at the north spawns, 2 m away — was two high windows and nothing else, so
    // reaching the building from the side of the map that looks onto it meant walking
    // round to the south roller doors: a 15 m sightline became a 54 m path, against 26 m
    // for the other team to their own forward building. It sits in the clear span between
    // the two windows.
    { a0: 23.5, a1: 26.5, y0: PLINTH, y1: 3.0, frame: 'door' },
    { a0: 19, a1: 23, y0: 4.6, y1: 6.3, glass: true, frame: 'window' },
    { a0: 27, a1: 31, y0: 4.6, y1: 6.3, glass: true, frame: 'window' },
  ]);
  shell(X0, Z0, X0 + T, Z1, [
    // At the south end, not z -25..-22.6. The internal stair runs z -25.5..-18.7 half a
    // metre behind this wall, and at -25..-22.6 it is near its top — so the door opened
    // onto a solid wall of concrete treads. Measured clear rectangle: 0.00 x 0.00 m.
    { a0: -18, a1: -15.6, y0: PLINTH, y1: 2.5, frame: 'door' },
    { a0: -31, a1: -28, y0: 4.6, y1: 6.3, glass: true, frame: 'window' },
    { a0: -21, a1: -18, y0: 1.2, y1: 2.6, glass: true, frame: 'window' },
  ]);
  shell(X1 - T, Z0, X1, Z1, [
    { a0: -25, a1: -23, y0: MEZZ, y1: 6.3, frame: 'door' },
    { a0: -20, a1: -17, y0: 1.2, y1: 2.6, glass: true, frame: 'window' },
  ]);

  // Roller-door surrounds + hoods.
  for (const x of [20.5, 29.5]) {
    B.deco(x - 2.7, PLINTH, Z1 - 0.55, x + 2.7, 4.7, Z1 - 0.35, 'metal');
    B.deco(x - 2.9, 4.7, Z1 - 0.9, x + 2.9, 5.05, Z1 + 0.25, 'metal');
  }

  // Roof: shallow butterfly of two decks so it is not a flat plate.
  B.slab(X0, Z0, X1, Z1, ROOF_UNDER, ROOF, 'metal', 'metal');
  B.parapet(X0, Z0, X1, Z0, ROOF, 1.0, 'metal', 'metal', { gaps: [[19, 23], [27, 31]], capMat: 'metal' });
  B.parapet(X0, Z1, X1, Z1, ROOF, 1.0, 'metal', 'metal', { gaps: [[18, 22], [28, 32]], capMat: 'metal' });
  B.parapet(X0, Z0, X0, Z1, ROOF, 1.0, 'metal', 'metal', { gaps: [[-30, -26], [-22, -18]], capMat: 'metal' });
  // Split at the stair mouth, not a `gaps` entry — the same fault, and the same fix, as the
  // market hall's south balcony. `Builder.parapet` LOWERS a gap to `y + MAX_STEP + 0.07`
  // (0.62 m) rather than opening it, which is over the 0.55 m step limit. So the roof this
  // building's whole external switchback exists to reach could not be walked onto: the
  // player climbed both flights, stood on the landing at 7.90, and stopped dead at x 35.49.
  // Measured, walk-only: 0 of 30,900 standing states on the warehouse roof. It was
  // mantle-only, and the comment above claims it is reached by the stair.
  // `extendStart: false`: this run starts AT the stair mouth, so squaring that end would
  // close 0.13 m of the only walk-on route to this roof.
  B.parapet(X1, -31.4, X1, Z1, ROOF, 1.0, 'metal', 'metal', { gaps: [[-22, -18]], capMat: 'metal', extendStart: false });
  B.prop('acUnit', 22.5, ROOF, -19.5, 0);
  B.prop('acUnit', 24.2, ROOF, -19.5, 0);
  B.prop('acUnit', 30.5, ROOF, -28.5, 1.2);
  B.prop('pallets', 18.5, ROOF, -30.5, 0.4);
  for (let x = 17.5; x < 34; x += 4.2) B.deco(x - 0.16, ROOF, -32.6, x + 0.16, ROOF + 0.5, -15.4, 'metal');

  // Mezzanine + internal stair.
  B.stairs({ x0: 15.6, z0: -25.5, x1: 18, z1: -18.7, y0: PLINTH, y1: MEZZ, dir: '-z', matName: 'metal', surface: 'metal', rail: true });
  B.slab(X0, Z0, X1, -25.5, MEZZ_UNDER, MEZZ, 'metal', 'metal');
  // East return, so the mezzanine door in the east wall has a floor behind it.
  //
  // That door (x 34.6-35, z -25..-23, y 4.00-6.30) is fed by the external switchback's half
  // landing, and the mezzanine stopped at z -25.5 — so stepping through it dropped you
  // 3.85 m to the ground floor. The documented route existed in the walls and not in the
  // geometry. Kept east of x 20 so it does not bury the top of the internal stair, which
  // arrives at z -25.5.
  B.slab(20, -25.5, X1, -22.8, MEZZ_UNDER, MEZZ, 'metal', 'metal');
  B.railing(18, -25.5, 20, -25.5, MEZZ, { height: 1.05 });
  B.railing(20, -25.5, 20, -22.8, MEZZ, { height: 1.05 });
  B.railing(20, -22.8, X1, -22.8, MEZZ, { height: 1.05 });
  for (const x of [26, 32]) B.deco(x - 0.22, PLINTH, -23.5, x + 0.22, MEZZ_UNDER, -23.1, 'metal');
  B.deco(19.78, PLINTH, -26.2, 20.22, MEZZ_UNDER, -25.8, 'metal');
  B.prop('crate', 21, MEZZ, -28.5, 0.3);
  B.prop('crate', 22, MEZZ, -29.3, -0.5);
  B.prop('crate', 21.6, MEZZ + 0.94, -28.9, 0.9, { variant: 'small' });
  B.prop('pallets', 30, MEZZ, -30, 0.1, { variant: 'tall' });
  B.prop('barrel', 33.2, MEZZ, -27.5, 0, { color: BARREL_COLORS[1] });
  B.prop('sandbags', 27.5, MEZZ, -26.1, 0);

  // External switchback to the roof.
  B.stairs({ x0: 35.2, z0: -23, x1: 37.6, z1: -16, y0: 0, y1: MEZZ, dir: '-z', matName: 'metal', surface: 'metal', rail: true });
  B.slab(35, -25.2, 37.6, -23, MEZZ_UNDER, MEZZ, 'metal', 'metal');
  B.railing(37.6, -25.2, 37.6, -23, MEZZ, {});
  B.stairs({ x0: 35.2, z0: -32.2, x1: 37.6, z1: -25.2, y0: MEZZ, y1: ROOF, dir: '-z', matName: 'metal', surface: 'metal', rail: true });
  B.slab(35, -33, 37.6, -31.4, ROOF_UNDER, ROOF, 'metal', 'metal');
  B.railing(37.6, -33, 37.6, -31.4, ROOF, {});
  // NOT railed along z = -33. A reviewer flagged the landing's north edge as a 7.90 m fall,
  // and it is — but so is every other roof edge on this map, by design. Railing it cost
  // more than it bought: the rail sits 0.71 m beyond the top tread, which stalls anyone
  // walking straight off the stair and, worse, blocked the nav link so the AI stopped
  // routing up the run at all. The exit from this landing is WEST onto the roof deck,
  // through the parapet opening above, not north over the edge.

  // Interior gantry + stock.
  for (const x of [19, 31]) B.deco(x - 0.2, PLINTH, -24.8, x + 0.2, 6.4, -24.4, 'metal');
  B.deco(18.6, 6.4, -24.9, 31.4, 6.9, -24.3, 'metal');
  B.prop('container', 22.5, PLINTH, -21.5, 0, { color: CONTAINER_COLORS[1] });
  // Pulled deeper into the shed. At z -18.2 its 6.2 m flank stood across the whole of the
  // eastern roller door (x 27-32), leaving 1.63 m of clear height in a 4.25 m opening — the
  // building's main vehicle entrance, half filled by its own dressing.
  B.prop('container', 30, PLINTH, -22.6, Math.PI / 2, { color: CONTAINER_COLORS[3] });
  B.prop('crate', 26.5, PLINTH, -22.5, 0.2);
  B.prop('crate', 27.4, PLINTH, -21.6, -0.6);
  B.prop('crate', 26.9, PLINTH + 0.94, -22.1, 0.4);
  // Out of the west doorway's throat as well as off the stair foot. Moving these clear of
  // the stair put them 1.3 m behind the door that was relocated to z -18..-15.6 in the same
  // pass, narrowing it to 0.80 m against a 0.72 m body — two fixes colliding with each other.
  B.prop('pallets', 22.0, PLINTH, -17.0, 0, { variant: 'tall' });
  B.prop('barrel', 33.5, PLINTH, -21, 0, { color: BARREL_COLORS[0] });
  B.prop('tyres', 16.6, PLINTH, -29.5, 0);
  // Moved clear of the north door (x 23.5-26.5). Parked at x=25.5 it plus its nav skirt
  // covered every usable cell in the opening, which is why widening the door to 4, 6 and
  // 8 m changed nothing — that widens the wall, not the truck.
  B.prop('truck', 19.5, PLINTH, -29, Math.PI / 2, { color: 0x6d7a5e });

  dressWarehouse(B, X0, X1, Z0, Z1, MEZZ, ROOF);
}

/**
 * Warehouse services and wear. A shed this size is defined by the stuff bolted to it:
 * pipe runs, downpipes, extractor cowls, cable trays, hazard paint round the doors and
 * rust weeping out of every fixing.
 */
function dressWarehouse(B, X0, X1, Z0, Z1, MEZZ, ROOF) {
  const rng = B.rng;

  // Horizontal service run down the west elevation, dropping into the building.
  for (const [b, sgn] of [[X0 - 0.14, -1], [X1 + 0.14, 1]]) {
    B.beam(b, 5.9, Z0 + 0.6, b, 5.9, Z1 - 0.6, 0.15, 'metal');
    B.beam(b + sgn * 0.02, 5.35, Z0 + 0.6, b + sgn * 0.02, 5.35, Z1 - 0.6, 0.1, 'metal');
    for (let z = Z0 + 2.0; z < Z1 - 1.0; z += 3.4) {
      B.deco(b - 0.16, 5.2, z - 0.07, b + 0.16, 6.1, z + 0.07, 'metal', { cast: false });
    }
    for (const z of [Z0 + 1.2, Z1 - 1.2]) {
      B.cylinder(b, PLINTH, z, 0.1, ROOF - PLINTH - 0.4, 6, 'metal', 'metal');
      B.deco(b - 0.2, PLINTH, z - 0.2, b + 0.2, 2.4, z + 0.2, 'concreteDark', { cast: false });
    }
  }
  // Elbows taking the run up over the parapet to the roof plant.
  B.beam(X1 + 0.14, 5.9, -18.0, X1 + 0.14, ROOF + 0.4, -18.0, 0.15, 'metal');
  B.beam(X1 + 0.14, ROOF + 0.4, -18.0, 30.5, ROOF + 0.4, -18.0, 0.15, 'metal');
  B.beam(30.5, ROOF + 0.4, -18.0, 30.5, ROOF + 0.4, -27.4, 0.15, 'metal');

  // Roller-door surrounds get hazard paint and a stencilled bay number.
  for (const [i, x] of [[1, 20.5], [2, 29.5]]) {
    for (const sx of [-3.0, 3.0]) {
      for (let k = 0; k < 5; k++) board(B, x + sx, PLINTH + k * 0.62, Z1 + 0.12, 0, 0.42, 0.6, k % 2 ? 0x2a2c30 : HAZARD);
    }
    board(B, x, 5.25, Z1 + 0.12, 0, 1.5, 0.8, i === 1 ? HAZARD : HB_PAINT);
    B.wear(x - 3.4, Z1 - 0.6, x + 3.4, Z1 + 4.6, 0, 'concreteDark');
  }
  board(B, 25.0, 6.6, Z1 + 0.12, 0, 5.2, 1.1, 0xdad2c0);
  board(B, X0 - 0.12, 5.0, -26.0, -Math.PI / 2, 3.2, 1.0, HB_RUST);

  // Rust weeping from the sheeting joints — a few dozen thin plates, one draw call.
  for (let i = 0; i < 26; i++) {
    const side = rng.int(4);
    const w = rng.range(0.1, 0.3), h = rng.range(0.7, 2.4);
    const y = rng.range(1.6, 4.6);
    if (side < 2) {
      const x = rng.range(X0 + 1, X1 - 1);
      board(B, x, y, side ? Z0 - 0.12 : Z1 + 0.12, side ? Math.PI : 0, w, h, HB_RUST);
    } else {
      const z = rng.range(Z0 + 1, Z1 - 1);
      board(B, side === 2 ? X0 - 0.12 : X1 + 0.12, y, z, side === 2 ? -Math.PI / 2 : Math.PI / 2, w, h, HB_RUST);
    }
  }

  // Roof plant: extractor cowls, a header tank on a stand, mast with guys, cable tray.
  for (const [cx, cz] of [[19.0, -22.5], [21.6, -22.5], [27.2, -25.0]]) {
    B.cylinder(cx, ROOF, cz, 0.46, 0.9, 10, 'metal', 'metal');
    B.cylinder(cx, ROOF + 0.9, cz, 0.62, 0.34, 10, 'metal', 'metal', { rTop: 0.28 });
    B.cylinder(cx, ROOF + 1.24, cz, 0.2, 0.16, 8, 'metal', 'metal');
  }
  B.box(29.4, ROOF, -28.6, 31.6, ROOF + 1.1, -26.2, 'metal', 'metal');
  B.cylinder(30.5, ROOF + 1.1, -27.4, 1.15, 1.7, 12, 'metal', 'metal', { collide: true });
  B.cylinder(30.5, ROOF + 2.8, -27.4, 1.22, 0.12, 12, 'metal', 'metal');
  B.cylinder(17.4, ROOF, -18.6, 0.09, 5.2, 6, 'metal', 'metal');
  for (let i = 0; i < 6; i++) B.beam(16.9, ROOF + 2.2 + i * 0.46, -18.6, 17.9, ROOF + 2.2 + i * 0.46, -18.6, 0.045, 'metal');
  for (const a of [0.5, 2.6, 4.7]) B.cable(17.4, ROOF + 5.0, -18.6, 17.4 + Math.cos(a) * 2.6, ROOF + 0.05, -18.6 + Math.sin(a) * 2.6, 0.18, 0.035, 'metal');
  B.cable(21.6, ROOF + 1.0, -22.5, 29.4, ROOF + 1.0, -27.0, 0.5, 0.04, 'metal', { segs: 5 });
  B.wear(18.0, -26.0, 24.0, -20.0, ROOF, 'concreteDark');
  B.debris(32.4, -20.0, 1.2, 8, ROOF, { mats: ['metal', 'wood', 'rubber'] });
  B.prop('barrel', 33.0, ROOF, -24.0, 0.4, { color: BARREL_COLORS[0] });
  B.prop('crate', 26.0, ROOF, -17.2, 0.3, { variant: 'small' });

  // Interior: pallet racking along the west bay, oil, and a hazard line on the floor.
  for (const z of [-31.0, -27.6]) {
    for (const rx of [16.2, 18.4]) B.box(rx - 0.09, PLINTH, z - 0.5, rx + 0.09, PLINTH + 3.6, z + 0.5, 'metal', 'metal');
    for (const ry of [0.9, 2.0, 3.1]) {
      B.deco(16.1, PLINTH + ry, z - 0.55, 18.5, PLINTH + ry + 0.11, z + 0.55, 'metal');
      B.deco(16.4, PLINTH + ry + 0.11, z - 0.42, 18.2, PLINTH + ry + 0.62, z + 0.42, 'wood');
    }
    B.beam(16.2, PLINTH + 3.6, z, 18.4, PLINTH + 3.6, z, 0.09, 'metal');
  }
  B.wear(18.0, -24.4, 33.0, -23.2, PLINTH, 'concreteDark');
  B.wear(24.0, -32.0, 27.2, -16.0, PLINTH, 'concreteDark');
  B.debris(32.0, -31.0, 1.3, 9, PLINTH, { mats: ['wood', 'rubber', 'metal'] });
  B.debris(19.5, -16.6, 1.0, 7, PLINTH, { mats: ['wood', 'rubber'] });
  // Hazard-painted kerbs at the base of the columns holding the mezzanine up.
  for (const x of [20, 26, 32]) {
    board(B, x, PLINTH, -25.72, 0, 0.66, 0.42, HAZARD);
    board(B, x, PLINTH, -26.28, Math.PI, 0.66, 0.42, HAZARD);
  }
  board(B, 26.5, MEZZ + 0.06, -25.62, 0, 3.4, 0.34, HB_PAINT);
}

// ───────────────────────────────────────────────────────────────────────── customs

/**
 * CUSTOMS OFFICE — x[17,33] z[12,28]. Two storeys, west balcony over the harbour road,
 * internal stair plus an external stair on the north face.
 */
function buildCustoms(B) {
  const X0 = 17, X1 = 33, Z0 = 12, Z1 = 28, T = 0.4;
  const ROOF = 7.9, ROOF_UNDER = 7.6;
  const STAIR = [17.6, 14.2, 20, 19.8];

  B.box(X0 - 0.5, 0, Z0 - 0.5, X1 + 0.5, PLINTH, Z1 + 0.5, 'concreteDark', 'concrete');
  B.floorFinish(X0, Z0, X1, Z1, PLINTH, 'tile');

  B.wall(X0, Z0, X1, Z0 + T, PLINTH, L1_UNDER, 'concrete', 'concrete', {
    openings: [
      { a0: 24, a1: 26.6, y0: PLINTH, y1: 2.5, frame: 'door' },
      { a0: 28.5, a1: 31.5, y0: 1.15, y1: 2.5, glass: true, frame: 'window' },
    ],
  });
  B.wall(X0, Z1 - T, X1, Z1, PLINTH, L1_UNDER, 'concrete', 'concrete', {
    openings: [
      { a0: 21, a1: 23.6, y0: PLINTH, y1: 2.5, frame: 'door' },
      { a0: 27, a1: 30, y0: 1.15, y1: 2.5, frame: 'window' },
    ],
  });
  B.wall(X0, Z0, X0 + T, Z1, PLINTH, L1_UNDER, 'concrete', 'concrete', {
    openings: [
      // South of the stairwell, not at z 15-17.6. STAIR occupies z 14.2-19.8 just 0.2 m
      // behind this wall, so the door was 84% filled by its own staircase — 1.02 x 0.56 m
      // of a 2.60 x 2.35 opening.
      { a0: 24.8, a1: 27.4, y0: PLINTH, y1: 2.5, frame: 'door' },
      { a0: 21, a1: 24, y0: 1.15, y1: 2.5, glass: true, frame: 'window' },
    ],
  });
  B.wall(X1 - T, Z0, X1, Z1, PLINTH, L1_UNDER, 'concrete', 'concrete', {
    openings: [
      { a0: 16, a1: 19, y0: 1.15, y1: 2.5, glass: true, frame: 'window' },
      { a0: 22, a1: 25, y0: 1.15, y1: 2.5, frame: 'window' },
    ],
  });
  // Interior partition — reception vs back office, two doors.
  B.wall(X0, 20.8, X1, 21.2, PLINTH, L1_UNDER, 'plaster', 'concrete', {
    openings: [
      { a0: 21.5, a1: 24, y0: PLINTH, y1: 2.45, frame: 'door' },
      { a0: 28, a1: 30.5, y0: PLINTH, y1: 2.45, frame: 'door' },
    ],
  });

  // First floor.
  // Foot at 14.2, not 13.0. The north wall's inner face is at z 12.40, so a run starting
  // at 13.0 left 0.60 m of standing room in front of the bottom tread against a 0.72 m
  // player — there was nowhere to stand to begin the climb.
  B.stairs({ x0: 17.6, z0: 14.2, x1: 20, z1: 19.8, y0: PLINTH, y1: L1, dir: '+z', matName: 'concrete', surface: 'concrete', rail: true });
  B.slab(X0, Z0, X1, Z1, L1_UNDER, L1, 'concrete', 'concrete', { hole: STAIR });
  B.floorFinish(X0, Z0, X1, Z1, L1, 'tile');

  B.wall(X0, Z0, X1, Z0 + T, L1, ROOF_UNDER, 'plaster', 'concrete', {
    openings: [
      { a0: 19, a1: 21.4, y0: L1, y1: 6.4, frame: 'door' },
      { a0: 25, a1: 28, y0: 5.15, y1: 6.55, glass: true, frame: 'window' },
    ],
  });
  B.wall(X0, Z1 - T, X1, Z1, L1, ROOF_UNDER, 'plaster', 'concrete', {
    openings: [
      { a0: 19, a1: 22, y0: 5.15, y1: 6.55, glass: true, frame: 'window' },
      { a0: 26, a1: 29, y0: 5.15, y1: 6.55, frame: 'window' },
    ],
  });
  B.wall(X0, Z0, X0 + T, Z1, L1, ROOF_UNDER, 'plaster', 'concrete', {
    openings: [
      { a0: 18, a1: 21, y0: L1, y1: 6.4, frame: 'door' },
      { a0: 23.5, a1: 26.5, y0: 5.15, y1: 6.55, glass: true, frame: 'window' },
    ],
  });
  B.wall(X1 - T, Z0, X1, Z1, L1, ROOF_UNDER, 'plaster', 'concrete', {
    openings: [
      { a0: 15, a1: 18, y0: 5.15, y1: 6.55, glass: true, frame: 'window' },
      { a0: 22, a1: 25, y0: 5.15, y1: 6.55, glass: true, frame: 'window' },
    ],
  });

  // Roof (visual only — no route up, it just closes the silhouette).
  B.slab(X0, Z0, X1, Z1, ROOF_UNDER, ROOF, 'concrete', 'concrete');
  B.parapet(X0, Z0, X1, Z0, ROOF, 0.95, 'plaster', 'concrete');
  B.parapet(X0, Z1, X1, Z1, ROOF, 0.95, 'plaster', 'concrete');
  B.parapet(X0, Z0, X0, Z1, ROOF, 0.95, 'plaster', 'concrete');
  B.parapet(X1, Z0, X1, Z1, ROOF, 0.95, 'plaster', 'concrete');

  // West balcony over the harbour road.
  B.slab(15, 14, X0, 26, L1_UNDER, L1, 'concrete', 'concrete');
  B.parapet(15, 14, 15, 26, L1, 1.0, 'plaster', 'concrete', { gaps: [[16.5, 19], [21.5, 24]] });
  B.parapet(15, 14, X0, 14, L1, 1.0, 'plaster', 'concrete');
  B.parapet(15, 26, X0, 26, L1, 1.0, 'plaster', 'concrete');
  for (const z of [14.4, 25.6]) B.deco(15.1, PLINTH, z - 0.2, 15.5, L1_UNDER, z + 0.2, 'concrete');
  B.prop('sandbags', 16, L1, 17.5, Math.PI / 2);
  B.prop('sandbags', 16, L1, 22.5, Math.PI / 2);

  // External stair on the north face + landing bridging the wall.
  B.stairs({ x0: 19, z0: 5, x1: 21.4, z1: 11.6, y0: 0, y1: L1, dir: '+z', matName: 'concrete', surface: 'concrete', rail: true });
  B.slab(18.8, 11.4, 21.6, Z0 + 0.1, L1_UNDER, L1, 'concrete', 'concrete');

  // Interior + exterior dressing.
  B.prop('crate', 30.5, PLINTH, 15.5, 0.4);
  B.prop('pallets', 22, PLINTH, 26, 0.1);
  B.prop('barrel', 31.5, PLINTH, 25.5, 0, { color: BARREL_COLORS[3] });
  B.prop('crate', 25, L1, 25, 0.2);
  B.prop('crate', 30, L1, 15.5, -0.3, { variant: 'small' });
  B.prop('vent', 33.1, 5.4, 20, Math.PI / 2, { collide: false });
  B.prop('awning', 25.3, 2.62, 11.85, Math.PI);
  B.prop('streetlight', 14.2, 0, 9, 0);

  dressCustoms(B, X0, X1, Z0, Z1, ROOF);
}

/**
 * Customs office — the harbour's civil building, so it gets institutional signage,
 * a counter you can fight across and a roof that closes the skyline properly.
 */
function dressCustoms(B, X0, X1, Z0, Z1, ROOF) {
  const rng = B.rng;

  // Signage over the north entrance, plus a painted plinth in harbour green.
  board(B, 25.3, 2.72, Z0 - 0.14, Math.PI, 4.6, 0.92, 0xdad2c0);
  board(B, 22.3, 2.6, Z1 + 0.14, 0, 2.6, 0.66, HB_PAINT);
  paintBand(B, true, X0, X1, Z0 - 0.04, PLINTH, 0.86, HB_PAINT, [[23.8, 26.8]], Math.PI);
  paintBand(B, true, X0, X1, Z1 + 0.04, PLINTH, 0.86, HB_PAINT, [[20.8, 23.8]], 0);
  paintBand(B, false, Z0, Z1, X1 + 0.04, PLINTH, 0.86, HB_PAINT, [], Math.PI / 2);

  // Storey band and downpipes with their stains.
  for (const y of [L1_UNDER - 0.26]) {
    B.deco(X0 - 0.16, y, Z0 - 0.16, X1 + 0.16, y + 0.18, Z0, 'concreteDark');
    B.deco(X0 - 0.16, y, Z1, X1 + 0.16, y + 0.18, Z1 + 0.16, 'concreteDark');
    B.deco(X1, y, Z0 - 0.16, X1 + 0.16, y + 0.18, Z1 + 0.16, 'concreteDark');
  }
  for (const [px, pz] of [[X1 + 0.1, Z0 + 0.35], [X1 + 0.1, Z1 - 0.35], [X0 - 0.1, Z1 - 0.35]]) {
    B.cylinder(px, PLINTH, pz, 0.09, ROOF - 0.5 - PLINTH, 6, 'metal', 'metal');
    B.deco(px - 0.18, PLINTH, pz - 0.18, px + 0.18, 2.1, pz + 0.18, 'concreteDark', { cast: false });
  }

  // Roof: no route up, so this is pure silhouette — tank, plant deck, mast, aerials.
  B.box(27.6, ROOF, 15.6, 30.4, ROOF + 1.0, 18.4, 'metal', 'metal');
  B.cylinder(29.0, ROOF + 1.0, 17.0, 1.2, 1.9, 12, 'metal', 'metal');
  B.cylinder(29.0, ROOF + 2.9, 17.0, 1.28, 0.12, 12, 'metal', 'metal');
  B.cylinder(20.4, ROOF, 24.5, 0.09, 4.8, 6, 'metal', 'metal');
  for (let i = 0; i < 6; i++) B.beam(19.9, ROOF + 1.9 + i * 0.44, 24.5, 20.9, ROOF + 1.9 + i * 0.44, 24.5, 0.045, 'metal');
  for (const a of [0.6, 2.7, 4.8]) B.cable(20.4, ROOF + 4.6, 24.5, 20.4 + Math.cos(a) * 2.3, ROOF + 0.05, 24.5 + Math.sin(a) * 2.3, 0.16, 0.035, 'metal');
  B.prop('acUnit', 24.6, ROOF, 13.6, 0.2);
  B.prop('acUnit', 26.4, ROOF, 13.6, 0.2);
  B.cylinder(31.4, ROOF + 1.1, 24.0, 0.7, 0.16, 12, 'metal', 'metal', { rz: -0.85 });
  B.beam(31.4, ROOF + 1.1, 24.0, 31.4, ROOF, 24.0, 0.08, 'metal');

  // Reception: a counter across the north room with a glazed screen over it.
  B.box(23.0, PLINTH, 16.6, 29.4, PLINTH + 0.98, 17.5, 'wood', 'wood');
  B.deco(22.9, PLINTH + 0.98, 16.5, 29.5, PLINTH + 1.1, 17.6, 'concreteDark');
  for (let x = 23.4; x < 29.4; x += 1.5) B.deco(x - 0.05, PLINTH + 1.1, 16.95, x + 0.05, PLINTH + 2.2, 17.05, 'metal', { cast: false });
  B.box(23.0, PLINTH + 1.1, 16.96, 26.0, PLINTH + 2.2, 17.04, 'glass', 'glass', { cast: false, receive: false });
  B.box(27.4, PLINTH + 1.1, 16.96, 29.4, PLINTH + 2.2, 17.04, 'glass', 'glass', { cast: false, receive: false });

  // Back office: desks, filing, and a wall of forms nobody has filed.
  B.box(18.4, PLINTH, 22.4, 19.6, PLINTH + 0.76, 25.4, 'wood', 'wood');
  B.deco(18.3, PLINTH + 0.76, 22.3, 19.7, PLINTH + 0.84, 25.5, 'concreteDark');
  B.box(30.6, PLINTH, 22.0, 32.4, PLINTH + 0.76, 23.2, 'wood', 'wood');
  B.deco(30.5, PLINTH + 0.76, 21.9, 32.5, PLINTH + 0.84, 23.3, 'concreteDark');
  for (const z of [24.0, 25.2, 26.4]) {
    B.box(31.4, PLINTH, z - 0.5, 32.4, PLINTH + 1.42, z + 0.5, 'metal', 'metal');
    for (const sy of [0.34, 0.9]) B.deco(31.34, PLINTH + sy, z - 0.44, 31.4, PLINTH + sy + 0.06, z + 0.44, 'metal', { cast: false });
  }
  B.prop('crate', 21.5, PLINTH, 18.8, 0.3, { variant: 'small' });
  B.prop('sandbags', 19.0, PLINTH, 11.4, 0);      // clear of the stairwell foot at z 14.2
  board(B, 25.3, 2.1, 20.74, 0, 1.9, 0.9, HAZARD);
  board(B, 30.0, 1.9, 21.26, Math.PI, 1.4, 1.0, 0xdad2c0);

  // Upstairs: a desk at the window that overlooks the road, and worn traffic lines.
  // Clear of the stairwell. It used to stand over it — x 17.60-18.80 of the 2.40 m well —
  // with its underside at 4.15 above treads topping out at 3.49-3.93, leaving 0.22 m of
  // headroom over the last two metres of the climb.
  B.box(20.4, L1, 18.0, 21.6, L1 + 0.78, 20.6, 'wood', 'wood');
  B.deco(20.3, L1 + 0.78, 17.9, 21.7, L1 + 0.86, 20.7, 'concreteDark');
  B.prop('sandbags', 18.2, L1, 23.4, 0);
  B.wear(19.6, 13.0, 22.4, 27.4, PLINTH, 'concreteDark');
  B.wear(19.6, 19.4, 32.4, 22.0, PLINTH, 'concreteDark');
  B.wear(18.0, 13.2, 20.4, 26.4, L1, 'concreteDark');
  B.debris(31.6, 27.0, 1.1, 8, PLINTH, { mats: ['wood', 'rubber'] });
  B.debris(15.9, 24.6, 0.9, 6, 0, { mats: ['wood', 'concreteDark'] });
  for (let i = 0; i < 8; i++) {
    board(B, rng.range(X0 + 1, X1 - 1), rng.range(2.2, 6.4), Z1 + 0.14, 0, rng.range(0.12, 0.28), rng.range(0.7, 2.0), 0x6b6357);
  }
}

// ─────────────────────────────────────────────────────────────────────────── plaza

function buildPlaza(B, rng) {
  // North monument — breaks the long plaza sightline into two ~21 m halves and gives
  // the northern approach real cover.
  B.box(-7, 0, -20, 7, 0.5, -14, 'concreteDark', 'concrete');
  B.box(-5.6, 0.5, -18.6, 5.6, 0.95, -15.4, 'concrete', 'concrete');
  // Top at 1.45, not 1.50. From tier 2 at 0.95 that was a rise of exactly 0.550 — and
  // `_tryStepUp` measures `top + SKIN`, so 0.555 against a 0.55 limit: refused. The tier
  // looked like a step, read like a step, and could not be climbed from any of its four
  // sides. 0.50 clears with margin.
  B.box(-2.2, 0.95, -18.0, 2.2, 1.45, -16.0, 'concreteDark', 'concrete');
  B.box(-1.1, 1.5, -17.5, 1.1, 5.6, -16.5, 'concrete', 'concrete');
  B.deco(-1.35, 5.6, -17.75, 1.35, 5.95, -16.25, 'concreteDark');
  for (const sx of [-4.4, 4.4]) B.prop('bollard', sx, 0.95, -17, 0);
  B.prop('palm', -8.6, 0, -16.5, 0.6);
  B.prop('palm', 8.6, 0, -16.5, 2.6);
  B.prop('jersey', -9.5, 0, -21.5, 0);
  B.prop('jersey', 9.5, 0, -21.5, 0);

  // South market awnings — the mirror-image blocker.
  for (let i = 0; i < 3; i++) {
    B.prop('stall', 4 + i * 2.6, 0, 15.5, 0, { color: AWNING_COLORS[i % AWNING_COLORS.length] });
    B.prop('stall', 4 + i * 2.6, 0, 19.5, Math.PI, { color: AWNING_COLORS[(i + 2) % AWNING_COLORS.length] });
  }
  B.prop('stall', -9.5, 0, 16.5, Math.PI / 2, { color: AWNING_COLORS[1] });
  B.prop('stall', -9.5, 0, 20.5, Math.PI / 2, { color: AWNING_COLORS[2] });
  B.box(-11.5, 0, 22.5, -3.5, 1.15, 23.3, 'concreteDark', 'concrete');   // planter run
  B.box(3.5, 0, 22.5, 11.5, 1.15, 23.3, 'concreteDark', 'concrete');
  B.deco(-11.6, 1.15, 22.4, -3.4, 1.32, 23.4, 'dirt');
  B.deco(3.4, 1.15, 22.4, 11.6, 1.32, 23.4, 'dirt');
  B.prop('palm', -7.5, 1.15, 22.9, 0.2);
  B.prop('palm', 7.5, 1.15, 22.9, 2.2);

  // Flank blockers: without these the 3 m gaps beside the hall would run the full map.
  B.prop('container', 11.8, 0, -19, 0, { color: CONTAINER_COLORS[0] });
  B.prop('container', 11.8, 0, 19, 0, { color: CONTAINER_COLORS[2] });
  B.box(-13, 0, -20.2, -10.2, 3.1, -17.6, 'plaster', 'concrete');       // transformer hut
  B.deco(-13.2, 3.1, -20.4, -10, 3.4, -17.4, 'concreteDark');
  B.box(-13, 0, 17.6, -10.2, 3.1, 20.2, 'plaster', 'concrete');
  B.deco(-13.2, 3.1, 17.4, -10, 3.4, 20.4, 'concreteDark');
  B.prop('windowFrame', -11.6, 1.35, -17.52, 0, { variant: '1.4x1.1' });
  // 17.52, mirroring the -17.52 above: the hut's face is at z=17.6, so the frame sits
  // just OUTSIDE it. At 17.68 the frame — and the glass pane it carries — was 8 cm inside
  // a solid block, an invisible pane entombed in plaster.
  B.prop('windowFrame', -11.6, 1.35, 17.52, Math.PI, { variant: '1.4x1.1' });
  B.prop('barrel', -14.2, 0, -18.4, 0, { color: BARREL_COLORS[rng.int(BARREL_COLORS.length)] });
  B.prop('barrel', -14.2, 0, -19.4, 0.4, { color: BARREL_COLORS[rng.int(BARREL_COLORS.length)] });

  B.prop('streetlight', -12.4, 0, -6, Math.PI / 2);
  B.prop('streetlight', -12.4, 0, 26, Math.PI / 2);
  B.prop('streetlight', 12.4, 0, -26, -Math.PI / 2);
  B.prop('streetlight', 12.4, 0, 6, -Math.PI / 2);

  dressPlaza(B, rng);
}

/**
 * The plaza floor. A twenty-six metre tiled square reads as a car park unless something
 * happens on it: bunting strung between the lamp standards, market pitches worn into the
 * tile, litter where the stalls are, and a painted dedication on the monument.
 */
function dressPlaza(B, rng) {
  // Bunting between the four lamp standards and the hall — the plaza's ceiling.
  const lampY = 5.9;
  for (const [x0, z0, x1, z1] of [
    [-12.4, -6, -10.3, -2.6], [12.4, 6, 10.3, 2.6],
    [-12.4, 26, -8.1, 13.9], [12.4, -26, 8.1, -13.9],
  ]) {
    B.cable(x0, lampY, z0, x1, 4.3, z1, 0.55, 0.03, 'metal', { segs: 5 });
    for (let i = 0; i < 6; i++) {
      const f = (i + 0.5) / 6;
      const x = x0 + (x1 - x0) * f, z = z0 + (z1 - z0) * f;
      const y = lampY + (4.3 - lampY) * f - 0.55 * 4 * f * (1 - f);
      hang(B, x, y - 0.03, z, 0, 0.4, 0.5, rng.pick([PZ_PAINT, 0xe0d3b0, 0xc4705a, OT_PAINT]));
    }
  }

  // Monument: a bronze dedication panel and the wear of everyone who walks round it.
  board(B, 0, 1.15, -15.94, 0, 1.8, 0.85, 0x9a7b40);
  board(B, 0, 1.15, -18.06, Math.PI, 1.8, 0.85, 0x9a7b40);
  B.wear(-8.6, -21.4, 8.6, -19.6);
  B.wear(-8.6, -14.6, 8.6, -12.8);
  B.wear(-9.4, -20.4, -7.2, -13.6);
  B.wear(7.2, -20.4, 9.4, -13.6);

  // Market pitches: the tile is scrubbed pale where the stalls stand, filthy between.
  B.wear(2.4, 13.8, 12.2, 21.4, 0, 'concreteDark');
  B.wear(-11.6, 14.6, -7.4, 22.2, 0, 'concreteDark');
  B.debris(0.6, 17.4, 1.5, 11, 0, { mats: ['wood', 'sandbag', 'rubber'] });
  B.debris(-6.2, 20.8, 1.2, 8, 0, { mats: ['wood', 'sandbag'] });
  B.debris(10.4, -20.6, 1.1, 8, 0, { mats: ['wood', 'rubber', 'concreteDark'] });
  B.prop('crate', 1.2, 0, 21.6, 0.4, { variant: 'small' });
  B.prop('barrel', 12.6, 0, 15.4, 0.2, { color: BARREL_COLORS[2] });
  B.prop('pallets', -12.2, 0, 13.9, 0.3);         // 0.64 m from the stair foot was inside it

  // Main desire lines through the square, north to south past the hall.
  B.wear(-12.4, -30.0, -10.2, -22.0);
  B.wear(10.2, 22.0, 12.4, 30.0);
  B.wear(-2.0, 24.0, 1.0, 34.0);
  B.wear(-1.0, -34.0, 2.0, -24.0);

  // Painted advertising on the transformer huts, plus a graffiti tag on each.
  for (const z of [-18.9, 18.9]) {
    board(B, -13.14, 1.6, z, -Math.PI / 2, 2.0, 1.1, rng.pick([0xc4705a, PZ_PAINT, OT_PAINT]));
    board(B, -11.6, 0.55, z > 0 ? 20.34 : -17.54, z > 0 ? 0 : Math.PI, 1.7, 0.85, rng.pick([0x8a6fb0, 0x4f9a6a]));
  }
}

// ───────────────────────────────────────────────────────────────────────── harbour

function buildHarbour(B, rng) {
  // Container barricade across the road — the main east-lane chokepoint. Two gaps.
  B.prop('container', 16.5, 0, -1, 0, { color: CONTAINER_COLORS[0] });
  B.prop('container', 26, 0, -1, 0, { color: CONTAINER_COLORS[1] });
  B.prop('container', 26, 2.6, -1, 0, { color: CONTAINER_COLORS[4] });
  B.prop('container', 38, 0, -1, 0, { color: CONTAINER_COLORS[3] });
  B.prop('jersey', 21.3, 0, -3.6, 0);
  B.prop('jersey', 30.9, 0, 1.6, 0);
  B.prop('sandbags', 20.2, 0, 1.4, 0);
  B.prop('sandbags', 22.0, 0, 1.4, 0);

  // Ramp onto the western container of the barricade — a small piece of verticality on
  // the road that lets you shoot over the whole barricade, counterable from both
  // buildings and from the plaza arcade.
  // y1 matches the container top (2.61), not 2.60. `_tryStepUp` refuses any rise under
  // MIN_STEP_HEIGHT (0.02 m), so a 1 cm lip is not a small step — it is a wall. The ramp
  // was a one-way trap: you could come down it and never go up.
  B.ramp({ x0: 14.6, z0: 0.22, x1: 18.4, z1: 4.6, y0: 0, y1: 2.61, dir: '-z', matName: 'metal', surface: 'metal' });
  B.prop('jersey', 13.6, 0, 2.4, Math.PI / 2);
  B.prop('jersey', 19.4, 0, 2.4, Math.PI / 2);
  B.prop('sandbags', 15.4, 2.6, -1.9, 0);
  B.prop('sandbags', 17.3, 2.6, -1.9, 0);

  // Quayside: crane, bollards, cargo.
  B.prop('crane', 36.5, 0, -8, Math.PI / 2);
  for (let z = -34; z <= 36; z += 7) B.prop('bollard', 40.2, 0, z, 0);
  B.railing(40.6, -38, 40.6, -12, 0, { height: 1.05 });
  B.railing(40.6, 4, 40.6, 38, 0, { height: 1.05 });
  // At z -36, not -26. The stack is 2.44 x 6.20 m, so at -26 it ran from z -29.13 to
  // -22.93 and straight through the warehouse's external switchback (x 35.2-37.6): it
  // overlapped the landing by 0.82 m, cut into nine treads of the upper flight, and
  // entombed the landing railing completely. Descending the lower flight stalled on it.
  B.prop('container', 38, 0, -36, Math.PI / 2, { color: CONTAINER_COLORS[2] });
  B.prop('container', 38, 2.6, -36, Math.PI / 2, { color: CONTAINER_COLORS[5] });
  B.prop('container', 38, 0, 12, Math.PI / 2, { color: CONTAINER_COLORS[4] });
  B.prop('container', 38, 0, 20, Math.PI / 2, { color: CONTAINER_COLORS[1] });
  B.prop('container', 38, 2.6, 20, Math.PI / 2, { color: CONTAINER_COLORS[0] });
  B.prop('waterTower', 38.5, 0, 32, 0);

  // Loose barrels and tyres along the quay.
  for (let i = 0; i < 7; i++) {
    const x = rng.range(36.6, 40.2), z = rng.range(-36, 36);
    // The quay container stack moved from z -26 to z -36; this exclusion band followed it,
    // or a scatter barrel ends up 0.33 m inside the stack while the old band is kept
    // pointlessly clear.
    if (Math.abs(z + 1) < 4 || Math.abs(z + 36) < 5 || Math.abs(z - 16) < 6 || Math.abs(z - 32) < 5) continue;
    B.prop('barrel', x, 0, z, rng.range(0, 6.28), { color: BARREL_COLORS[rng.int(BARREL_COLORS.length)] });
  }
  B.prop('tyres', 36.9, 0, 6.5, 0);
  B.prop('tyres', 37.9, 0, 7.2, 0.5);
  B.prop('palm', 14.4, 0, -6, 0.8);
  B.prop('palm', 14.4, 0, 22, 2.4);
  B.prop('streetlight', 35.4, 0, -12, -Math.PI / 2);
  B.prop('streetlight', 35.4, 0, 18, -Math.PI / 2);
  B.prop('streetlight', 35.4, 0, 36, -Math.PI / 2);
  B.prop('truck', 28.5, 0, 5.5, Math.PI / 2, { color: 0x8a7f6b });
  B.prop('truck', 31.5, 0, -9, -Math.PI / 2, { color: 0x5f6b74 });

  // Old-town lane chokepoints — without these the x[−21,−13] lane runs 66 m unbroken.
  B.prop('container', -17.5, 0, -24, 0, { color: CONTAINER_COLORS[4] });
  B.prop('container', -17.5, 0, 24, 0, { color: CONTAINER_COLORS[3] });
  B.prop('barrel', -14.0, 0, -21.6, 0, { color: BARREL_COLORS[2] });
  B.prop('crate', -14.2, 0, 21.4, 0.4);

  dressHarbour(B, rng);
}

/**
 * Quay and road wear. The east lane already had the strongest silhouette on the map (the
 * crane); what it lacked was the grubby detail of a working dock — hazard paint, mooring
 * ropes, spilled oil, tyre marks and rubbish blown against the containers.
 */
function dressHarbour(B, rng) {
  // Hazard kerb the length of the quay edge, broken where the railings run.
  for (let z = -37; z < 38; z += 1.3) {
    if ((z > -38 && z < -12) || (z > 4 && z < 38)) continue;         // railed sections
    board(B, 40.55, 0.02, z, -Math.PI / 2, 1.2, 0.34, (Math.round((z + 37) / 1.3) % 2) ? 0x2a2c30 : HAZARD);
  }
  // Mooring ropes from the bollards out over the edge, and coiled rope on the quay.
  for (let z = -34; z <= 36; z += 14) {
    B.cable(40.2, 0.8, z, 41.6, -1.2, z + 2.6, 0.5, 0.05, 'wood', { segs: 4 });
    for (let i = 0; i < 3; i++) {
      B.cylinder(39.2, 0.02 + i * 0.09, z + 3.4, 0.42 - i * 0.05, 0.09, 10, 'wood', 'wood', { rTop: 0.42 - i * 0.05 });
    }
  }

  // Painted lane markings and tyre rubber on the asphalt road.
  for (let z = -36; z < 38; z += 8.5) {
    B.wear(17.4, z, 18.1, z + 4.4, 0, 'concreteDark');
    B.wear(33.2, z + 2, 33.9, z + 6.4, 0, 'concreteDark');
  }
  B.wear(19.6, -6.0, 24.4, 6.0, 0, 'concreteDark');
  B.wear(27.0, -12.0, 32.4, -6.0, 0, 'concreteDark');
  B.wear(35.4, 12.0, 40.0, 26.0, 0, 'concreteDark');
  B.wear(14.6, 4.6, 19.4, 9.0, 0, 'concreteDark');

  // Oil under every parked vehicle, rubbish against every container.
  for (const [x, z] of [[28.5, 5.5], [31.5, -9.0], [25.5, -29.0]]) B.wear(x - 1.6, z - 1.1, x + 1.6, z + 1.1, 0, 'concreteDark');
  for (const [x, z] of [[16.5, -1], [26, -1], [38, -26], [38, 12], [38, 20]]) {
    B.debris(x + rng.range(-2.4, 2.4), z + rng.range(1.6, 2.6), 1.0, 7, 0, { mats: ['wood', 'rubber', 'metal'] });
  }
  B.prop('crate', 34.6, 0, 3.4, 0.4);
  B.prop('crate', 35.4, 0, 4.3, -0.3, { variant: 'small' });
  // Beside the external stair, not in its mouth. At z -16.5 it stood ON treads 1-2; at
  // -15.2 it merely stood 0.29 m in front of them, which is the same problem one step
  // removed — descending, you step off the bottom tread onto a 0.45 m pallet.
  B.prop('pallets', 39.0, 0, -16.5, 0.2);
  B.prop('barrel', 15.6, 0, 12.4, 0.3, { color: BARREL_COLORS[1] });
  B.prop('barrel', 16.4, 0, 13.2, 0.9, { color: BARREL_COLORS[3] });
  B.prop('tyres', 21.0, 0, 30.0, 0.2);

  // Crane: the hoist paid out well above head height, plus a warning band on each leg.
  // The jib runs south from the tower, so the fall lands over the open quay at z ≈ 8.
  B.beam(36.5, 10.4, 8.0, 36.5, 4.7, 8.0, 0.05, 'metal');
  B.cylinder(36.5, 4.2, 8.0, 0.3, 0.55, 8, 'metal', 'metal');
  B.beam(36.5, 4.2, 7.7, 36.5, 3.7, 8.3, 0.1, 'metal');
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const px = 36.5 + sz * 3.2, pz = -8.0 - sx * 3.2;
    for (let k = 0; k < 4; k++) {
      board(B, px, 0.7 + k * 0.42, pz + 0.24, 0, 0.5, 0.4, k % 2 ? 0x2a2c30 : HAZARD);
      board(B, px, 0.7 + k * 0.42, pz - 0.24, Math.PI, 0.5, 0.4, k % 2 ? 0x2a2c30 : HAZARD);
    }
  }

  // A tarpaulin lashed over the end of the stacked containers on the north quay.
  for (let i = 0; i < 3; i++) hang(B, 37.25 + i * 0.72, 5.22, -22.9, 0, 0.76, 1.1, 0x5a6a72);
  B.cable(36.9, 5.24, -22.9, 39.1, 5.24, -22.9, 0.06, 0.035, 'metal', { segs: 2 });
}

// ────────────────────────────────────────────────────────────────── spawn yards

/**
 * Open-fronted shed built hard against a perimeter wall: two side walls, a front wall
 * with a vehicle/personnel opening, and a roof. These both give the spawn areas real
 * cover AND cut the 3 m strip behind them, which would otherwise be an 82 m rifle lane.
 * `opening` = [a0, a1, height]; `glazed` adds a door reveal and a glass window.
 */
function shed(B, x0, x1, zBack, zFront, h, matName, opening, glazed = false) {
  const T = 0.4;
  const za = Math.min(zBack, zFront), zb = Math.max(zBack, zFront);
  const s = Math.sign(zBack - zFront);
  const fa = Math.min(zFront, zFront + T * s), fb = Math.max(zFront, zFront + T * s);
  B.box(x0, 0, za, x0 + T, h, zb, matName, 'concrete');
  B.box(x1 - T, 0, za, x1, h, zb, matName, 'concrete');
  const ops = [{ a0: opening[0], a1: opening[1], y0: 0, y1: opening[2], frame: glazed ? 'door' : null }];
  if (glazed) ops.push({ a0: opening[1] + 1.0, a1: opening[1] + 2.2, y0: 1.1, y1: 2.3, glass: true, frame: 'window' });
  // Inset the front wall to span BETWEEN the side walls. Running it x0..x1 duplicated the
  // side-wall columns: the end segments were wholly inside the boxes above — geomtest
  // ENTOMBED defects (§3.1 inert colliders) — with identical collision either way.
  B.wall(x0 + T, fa, x1 - T, fb, 0, h, matName, 'concrete', { openings: ops });
  B.box(x0 - 0.25, h, za, x1 + 0.25, h + 0.35, zb, 'metal', 'metal', { receive: false });
  B.deco(x0 - 0.3, h - 0.14, fa - 0.28, x1 + 0.3, h + 0.02, fb + 0.28, 'concreteDark');
}

function buildSpawnYards(B, rng) {
  // ── north (team 1)
  shed(B, -21, -14, -IN, -34, 3.4, 'concrete', [-19.6, -16.4, 3.0]);    // vehicle garage
  B.doorFrame(-18, 0, -34.15, 0, 3.0, 2.9);
  B.prop('truck', -17.5, 0, -31, 0, { color: 0x6d7a5e });
  B.prop('tyres', -20.2, 0, -32.6, 0);
  B.prop('barrel', -13.2, 0, -36.5, 0, { color: BARREL_COLORS[0] });

  shed(B, -4, 2, -IN, -34, 3.2, 'plaster', [-3.0, -0.6, 2.45], true);   // checkpoint hut
  B.prop('sandbags', 4.2, 0, -34.5, 0);
  B.prop('sandbags', 6.1, 0, -34.5, 0);
  B.prop('sandbags', 8.0, 0, -34.5, 0);
  // 2.4 m pitch, matching the prop's own width. At 2.5 m the run had a 10 cm slit —
  // not passable, but it reads as a barrier line nobody bothered to close.
  B.prop('jersey', -7.6, 0, -33.5, 0);
  B.prop('jersey', -10, 0, -33.5, 0);
  B.prop('jersey', 5.2, 0, -29.5, 0);
  B.prop('container', 8.5, 0, -25.5, 0, { color: CONTAINER_COLORS[3] });
  B.prop('container', -8.5, 0, -25.5, 0, { color: CONTAINER_COLORS[5] });
  B.prop('crate', 3.5, 0, -30.5, 0.3);
  B.prop('crate', 4.4, 0, -31.3, -0.4, { variant: 'small' });

  // Warehouse north yard.
  B.prop('container', 20, 0, -37, 0, { color: CONTAINER_COLORS[2] });
  B.prop('container', 20, 2.6, -37, 0, { color: CONTAINER_COLORS[0] });
  B.prop('container', 30, 0, -37, 0, { color: CONTAINER_COLORS[4] });
  // Shifted clear of the warehouse's north door (x 23.5-26.5). A 0.92 m barrier parked
  // squarely in a doorway's mouth does not read as cover, it reads as the door being
  // decorative — and the nav bake agreed, routing 68.7 m around a door 8 m away.
  B.prop('jersey', 21.0, 0, -34.5, 0);
  B.prop('pallets', 16.5, 0, -34.5, 0.2, { variant: 'tall' });

  // ── south (team 0)
  shed(B, -21, -14, IN, 34, 3.4, 'concrete', [-19.6, -16.4, 3.0]);      // depot
  B.doorFrame(-18, 0, 34.15, Math.PI, 3.0, 2.9);
  B.prop('truck', -17.5, 0, 31, Math.PI, { color: 0x7a6f58 });
  B.prop('pallets', -13.2, 0, 33, 0.3, { variant: 'tall' });

  shed(B, -2, 4, IN, 34, 3.2, 'plaster', [-1.0, 1.4, 2.45], true);      // kiosk
  B.prop('sandbags', -5.2, 0, 34.5, 0);
  B.prop('sandbags', -7.1, 0, 34.5, 0);
  B.prop('sandbags', -9.0, 0, 34.5, 0);
  B.prop('jersey', 7.6, 0, 33.5, 0);
  B.prop('jersey', 10, 0, 33.5, 0);
  B.prop('jersey', -5.2, 0, 29.5, 0);
  B.prop('container', -8.5, 0, 26.5, 0, { color: CONTAINER_COLORS[1] });
  B.prop('container', 8.5, 0, 26.5, 0, { color: CONTAINER_COLORS[3] });
  B.prop('crate', -3.5, 0, 30.5, 0.3);
  B.prop('crate', -4.4, 0, 31.3, -0.4, { variant: 'small' });

  // Motor pool (south-east).
  B.prop('truck', 20, 0, 34, Math.PI, { color: 0x5f6b74 });
  B.prop('truck', 27, 0, 34, Math.PI, { color: 0x6d7a5e });
  B.prop('container', 22, 0, 39, 0, { color: CONTAINER_COLORS[5] });
  B.prop('container', 32, 0, 39, 0, { color: CONTAINER_COLORS[2] });
  // Clear of the customs west wall (x 17.00-17.40). At x 18 this 2.44 m-wide container
  // straddled the wall and reached 1.82 m INTO the ground floor, and it stood across the
  // door relocated there — 1.07 m of a 2.60 m opening. Moving that door out from behind its
  // own staircase had put it behind a container instead.
  // North of the customs west door (z 24.8-27.4), not across it. Moving this out of the
  // wall it was clipping through parked it 0.78 m off the door face covering 1.53 m of the
  // 2.60 m opening — 6 cm of straight-through latitude. Two fixes in a row put the same
  // doorway behind something.
  B.prop('container', 15, 0, 33, Math.PI / 2, { color: CONTAINER_COLORS[0] });
  B.prop('jersey', 25.5, 0, 30.5, 0);
  B.prop('tyres', 16.5, 0, 36, 0);
  B.prop('tyres', 17.4, 0, 36.8, 0.4);
  rng();   // keep the dressing stream aligned even if this block is edited

  dressSpawnYards(B, rng);
}

/**
 * Spawn yards. These are the first three seconds of every life, so they have to say
 * "friendly rear area" instantly: unit stencils on the shed fronts, vehicle oil, tyre
 * scrub, and enough litter that they do not look freshly poured.
 */
function dressSpawnYards(B, rng) {
  // Shed fronts: painted band, bay number and a stencil, mirrored north and south.
  for (const [x0, x1, zf, sgn, tag] of [
    [-21, -14, -34, -1, HAZARD], [-4, 2, -34, -1, HB_PAINT],
    [-21, -14, 34, 1, HAZARD], [-2, 4, 34, 1, HB_PAINT],
  ]) {
    const zb = zf + sgn * 0.5;
    const yaw = sgn > 0 ? 0 : Math.PI;
    board(B, (x0 + x1) / 2, 3.05, zb, yaw, Math.min(4.4, x1 - x0 - 0.6), 0.5, tag);
    board(B, x0 + 0.6, 1.5, zb, yaw, 0.9, 1.1, 0xdad2c0);
    B.deco(x0 - 0.3, 0, zf - 0.04, x1 + 0.3, 0.42, zf + 0.04, 'concreteDark', { cast: false });
    B.wear(x0 - 0.6, zf + sgn * 0.4, x1 + 0.6, zf + sgn * 5.4);
  }

  // Vehicle oil, tyre scrub and litter through both yards.
  for (const [x, z] of [[-17.5, -31], [-17.5, 31], [20, 34], [27, 34]]) {
    B.wear(x - 1.8, z - 1.2, x + 1.8, z + 1.2, 0, 'concreteDark');
    B.wear(x - 1.1, z - 7.5, x - 0.4, z + 7.5, 0, 'concreteDark');
    B.wear(x + 0.4, z - 7.5, x + 1.1, z + 7.5, 0, 'concreteDark');
  }
  for (const [x, z] of [[-11.5, -36.5], [11.5, -32.0], [-11.5, 32.0], [12.5, 36.5], [24.0, -33.0], [30.5, 31.5]]) {
    B.debris(x, z, 1.3, 9, 0, { mats: ['wood', 'rubber', 'concreteDark'] });
  }
  B.prop('barrel', 11.8, 0, -33.4, 0.3, { color: BARREL_COLORS[rng.int(BARREL_COLORS.length)] });
  B.prop('barrel', 12.6, 0, -32.6, 1.1, { color: BARREL_COLORS[rng.int(BARREL_COLORS.length)] });
  B.prop('barrel', -11.8, 0, 33.4, 0.3, { color: BARREL_COLORS[rng.int(BARREL_COLORS.length)] });
  B.prop('tyres', 33.6, 0, 32.0, 0.4);
  B.prop('pallets', 34.6, 0, -31.0, 0.2);
}

/**
 * Perimeter. The walls are 12 m of blank cladding on three sides — the largest surfaces
 * in the level and, until now, the emptiest. Service cabling slung between the
 * buttresses, fly-posting at eye level and streaked rainwater fix that without touching
 * a single collider.
 */
function dressPerimeter(B, rng) {
  const POSTER = [0xc4705a, 0xe0d3b0, OT_PAINT, PZ_PAINT, 0x8a6fb0, 0x4f9a6a, 0x9ab6c4];

  // [runs along X?, face coordinate, inward sign, sign yaw facing inward]
  for (const [alongX, b, inw, yaw] of [
    [true, -IN + 0.12, 1, 0],
    [true, IN - 0.12, -1, Math.PI],
    [false, IN - 0.12, -1, -Math.PI / 2],
  ]) {
    // Service cable slung buttress to buttress.
    for (let a = -38; a < 38; a += 8) {
      const c = b + inw * 0.4;
      if (alongX) B.cable(a, 8.4, c, a + 8, 8.4, c, 0.9, 0.035, 'metal', { segs: 4 });
      else B.cable(c, 8.4, a, c, 8.4, a + 8, 0.9, 0.035, 'metal', { segs: 4 });
    }
    // Rain streaks weeping down from the coping, and fly-posting at eye level.
    for (let i = 0; i < 16; i++) {
      const a = rng.range(-39, 39);
      const w = rng.range(0.12, 0.4), h = rng.range(2.4, 6.0);
      const y = WALL_H - h - rng.range(0, 1.2);
      if (alongX) board(B, a, y, b, yaw, w, h, 0x6b6357);
      else board(B, b, y, a, yaw, w, h, 0x6b6357);
    }
    for (let i = 0; i < 9; i++) {
      const a = rng.range(-38, 38);
      const w = rng.range(0.8, 1.5);
      const y = rng.range(0.5, 2.2);
      const c = rng.pick(POSTER);
      if (alongX) board(B, a, y, b, yaw, w, w * rng.range(1.0, 1.6), c);
      else board(B, b, y, a, yaw, w, w * rng.range(1.0, 1.6), c);
    }
  }

  // Rubbish drifted into the angle of the wall, well clear of every spawn.
  for (const [x, z] of [[-30, -39.2], [6, -39.4], [-24, 39.4], [30, 39.2], [39.3, -30], [39.3, 30]]) {
    B.debris(x, z, 1.4, 10, 0, { mats: ['wood', 'rubber', 'concreteDark'] });
  }
}

// ──────────────────────────────────────────────────────────────────────── dressing

/** Deterministic loose clutter — never blocks a route, only softens the silhouettes. */
function scatterDressing(B, rng) {
  const spots = [
    [-24, -20], [-24, 20], [-17, -12], [6, 28], [-6, -28], [23, 4],
  ];
  for (const [x, z] of spots) {
    const r = rng();
    if (r < 0.34) {
      B.prop('crate', x, 0, z, rng.range(0, 6.28), { variant: rng.chance(0.4) ? 'small' : undefined });
    } else if (r < 0.62) {
      B.prop('barrel', x, 0, z, rng.range(0, 6.28), { color: BARREL_COLORS[rng.int(BARREL_COLORS.length)] });
      B.prop('barrel', x + rng.range(-0.9, 0.9), 0, z + rng.range(-0.9, 0.9), rng.range(0, 6.28),
        { color: BARREL_COLORS[rng.int(BARREL_COLORS.length)] });
    } else if (r < 0.82) {
      B.prop('pallets', x, 0, z, rng.range(0, 6.28), { variant: rng.chance(0.35) ? 'tall' : undefined });
    } else {
      B.prop('tyres', x, 0, z, rng.range(0, 6.28));
    }
  }

  // Tags at eye level on the flattest, most-walked-past surfaces. Hand-placed rather
  // than scattered, because graffiti on a wall nobody passes reads as noise.
  const TAG = [0x8a6fb0, 0x4f9a6a, 0xc4705a, 0xdad2c0, 0x3f7fb0];
  const tags = [
    [-10.07, 1.05, 6.4, -Math.PI / 2, 2.1],     // market hall, west flank
    [10.07, 1.15, -7.6, Math.PI / 2, 1.8],      // market hall, arcade side
    [-3.4, 1.0, 11.07, 0, 1.6],                 // market hall, south face
    [-13.74, 1.1, -6.0, Math.PI / 2, 1.9],      // gate-wall, plaza side
    [14.93, 1.15, -20.0, -Math.PI / 2, 2.2],    // warehouse base course
    [16.93, 1.2, 19.0, -Math.PI / 2, 1.7],      // customs, road side
    [-20.93, 1.05, -24.0, Math.PI / 2, 1.5],    // old-town block A, lane side
    [-20.93, 1.15, 18.0, Math.PI / 2, 1.8],     // old-town block B, lane side
  ];
  for (const [x, y, z, yaw, w] of tags) {
    board(B, x, y, z, yaw, w, w * rng.range(0.38, 0.62), rng.pick(TAG));
  }
}

// ────────────────────────────────────────────────────────────────────────── spawns

/**
 * 18 spawns: 6 per team at opposite ends plus 6 neutral in the middle third.
 * Every one is tucked against a wall, container or hut so a spawning player is never
 * standing in the open at the end of a long lane. `yaw` faces into the map.
 */
function placeSpawns(world) {
  const S = [
    // team 0 — south, facing north (-Z, yaw ≈ 0)
    [-30.0, 0.00, 33.0, 0.10, 0],
    [-17.5, 0.00, 38.5, 0.00, 0],
    [-8.0, 0.00, 37.0, 0.15, 0],
    [3.0, 0.00, 39.5, -0.10, 0],
    [20.0, 0.00, 36.4, 0.00, 0],
    [33.8, 0.00, 35.6, -0.25, 0],
    // team 1 — north, facing south (+Z, yaw ≈ π)
    [-30.0, 0.00, -35.5, Math.PI, 1],
    [-17.5, 0.00, -39.0, Math.PI, 1],
    [-8.0, 0.00, -36.5, Math.PI - 0.15, 1],
    [5.5, 0.00, -37.5, Math.PI + 0.10, 1],
    [20.0, 0.00, -35.2, Math.PI, 1],
    [33.8, 0.00, -34.6, Math.PI + 0.25, 1],
    // neutral — middle third
    [-30.0, 0.00, -9.0, -1.00, -1],
    [-25.0, 0.00, 5.0, 2.20, -1],
    [-5.0, PLINTH, 7.5, -0.60, -1],
    [4.6, PLINTH, -7.5, 2.60, -1],
    [16.5, 0.00, 5.0, 1.50, -1],
    [24.0, 0.00, -8.0, -1.70, -1],
  ];
  world.spawnPoints.length = 0;
  for (const [x, y, z, yaw, team] of S) {
    world.spawnPoints.push({ position: new THREE.Vector3(x, y, z), yaw, team });
  }
}
