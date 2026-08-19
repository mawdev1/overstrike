import * as THREE from 'three';
import { Builder } from './props.js';

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
 * Build the entire map. Called synchronously from World.init(); everything below runs in
 * well under 250 ms because all geometry is merged/instanced in a single pass at the end.
 */
export function buildLevel(game, world) {
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
  B.wall(3.5, 4.8, X1, 5.2, PLINTH, L1_UNDER, 'plaster', 'concrete', {
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
  B.parapet(-8, 13.6, 8, 13.6, L1, 1.0, 'plaster', 'concrete', { gaps: [[-2.2, 0.4], [4, 6.5]] });
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
  for (const z of [-9, -5.4, -1.8, 1.8, 5.4, 9]) B.prop('pillar', 11.7, 0, z, 0, { variant: '3.9' });
  B.deco(10.9, 3.9, -9.6, 12.5, 4.35, 9.6, 'concreteDark');
  for (const z of [-9.5, -6]) B.prop('pillar', -11.7, 0, z, 0, { variant: '3.9' });
  B.deco(-12.5, 3.9, -10.2, -10.9, 4.35, -5.4, 'concreteDark');

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
  for (const sx of [-2.72, 2.72]) for (const sz of [-2.72, 2.72]) {
    B.box(sx - 0.28, y + 1.18, sz - 0.28, sx + 0.28, y + 3.3, sz + 0.28, 'plaster', 'concrete');
  }
  for (const s of [-2.85, 2.85]) {
    B.box(-2.44, y + 1.35, s - 0.05, 2.44, y + 3.1, s + 0.05, 'glass', 'glass', { cast: false, receive: false });
    B.box(s - 0.05, y + 1.35, -2.44, s + 0.05, y + 3.1, 2.44, 'glass', 'glass', { cast: false, receive: false });
    for (const m of [-1.22, 0, 1.22]) {
      B.deco(m - 0.06, y + 1.3, s - 0.1, m + 0.06, y + 3.15, s + 0.1, 'metal', { cast: false });
      B.deco(s - 0.1, y + 1.3, m - 0.06, s + 0.1, y + 3.15, m + 0.06, 'metal', { cast: false });
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
  B.box(4.3, y, 9.8, 5.4, y + 1.35, 10.3, 'metal', 'metal');
  B.deco(4.3, y + 0.32, 9.74, 5.4, y + 0.38, 9.8, 'metal', { cast: false });
  B.deco(4.3, y + 0.86, 9.74, 5.4, y + 0.92, 9.8, 'metal', { cast: false });
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
  B.box(-2.6, L1, -3.5, -1.0, L1 + 0.76, -2.4, 'wood', 'wood');
  B.deco(-2.7, L1 + 0.76, -3.6, -0.9, L1 + 0.84, -2.3, 'concreteDark');
  B.box(1.4, L1, 2.6, 2.6, L1 + 1.3, 3.6, 'metal', 'metal');
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
  B.box(-7.4, y, 4.2, -5.0, y + 0.9, 6.6, 'metal', 'metal');
  for (const sx of [-7.2, -5.2]) for (const sz of [4.4, 6.4]) B.deco(sx - 0.08, y, sz - 0.08, sx + 0.08, y + 0.9, sz + 0.08, 'metal');
  // 1.3 tall, not 1.5. At 1.5 its top sat at 10.45, which is the one place on the map a
  // player can jump-and-air-mantle onto the 11.67 lantern deck — 14,441 valid launch
  // solutions over a 2.8-8.4 m/s speed window, so a route rather than a trick. From the
  // roof deck (8.05), the parapet (9.10) and the low roof AC (9.15) there are zero. Two
  // decimetres removes the only ladder to the map's highest surface.
  B.cylinder(-6.2, y + 0.9, 5.4, 1.05, 1.3, 14, 'metal', 'metal', { collide: true });
  B.cylinder(-6.2, y + 2.4, 5.4, 1.12, 0.12, 14, 'metal', 'metal');
  B.beam(-6.2, y + 0.95, 4.4, -6.2, y + 0.2, 2.6, 0.08, 'metal');
  B.beam(-6.2, y + 0.2, 2.6, -3.2, y + 0.2, 2.6, 0.08, 'metal');

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
      { a0: -12.5, a1: -8.5, y0: 0, y1: 3.2 },
      { a0: -2.5, a1: 1.5, y0: 0, y1: 3.2 },
      { a0: 5.0, a1: 8.5, y0: 0, y1: 3.2 },
    ],
  });
  for (const [a0, a1] of [[-12.5, -8.5], [-2.5, 1.5], [5.0, 8.5]]) {
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
  for (const [a0, a1] of [[-12.5, -8.5], [-2.5, 1.5], [5.0, 8.5]]) {
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
      { a0: z0 + 1.6, a1: z0 + 4.2, y0: 1.15, y1: 2.45, frame: 'window', stain: 1 },
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
  B.prop('barrel', -24.5, PLINTH, mid + 4.5, 0, { color: BARREL_COLORS[3] });

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
    { a0: -25, a1: -22.6, y0: PLINTH, y1: 2.5, frame: 'door' },
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
  B.parapet(X1, Z0, X1, Z1, ROOF, 1.0, 'metal', 'metal', { gaps: [[-33, -31.4], [-22, -18]], capMat: 'metal' });
  B.prop('acUnit', 22.5, ROOF, -19.5, 0);
  B.prop('acUnit', 24.2, ROOF, -19.5, 0);
  B.prop('acUnit', 30.5, ROOF, -28.5, 1.2);
  B.prop('pallets', 18.5, ROOF, -30.5, 0.4);
  for (let x = 17.5; x < 34; x += 4.2) B.deco(x - 0.16, ROOF, -32.6, x + 0.16, ROOF + 0.5, -15.4, 'metal');

  // Mezzanine + internal stair.
  B.stairs({ x0: 15.6, z0: -25.5, x1: 18, z1: -18.7, y0: PLINTH, y1: MEZZ, dir: '-z', matName: 'metal', surface: 'metal', rail: true });
  B.slab(X0, Z0, X1, -25.5, MEZZ_UNDER, MEZZ, 'metal', 'metal');
  B.railing(18, -25.5, X1, -25.5, MEZZ, { height: 1.05 });
  for (const x of [20, 26, 32]) B.deco(x - 0.22, PLINTH, -26.2, x + 0.22, MEZZ_UNDER, -25.8, 'metal');
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

  // Interior gantry + stock.
  for (const x of [19, 31]) B.deco(x - 0.2, PLINTH, -24.8, x + 0.2, 6.4, -24.4, 'metal');
  B.deco(18.6, 6.4, -24.9, 31.4, 6.9, -24.3, 'metal');
  B.prop('container', 22.5, PLINTH, -21.5, 0, { color: CONTAINER_COLORS[1] });
  B.prop('container', 30, PLINTH, -18.2, Math.PI / 2, { color: CONTAINER_COLORS[3] });
  B.prop('crate', 26.5, PLINTH, -22.5, 0.2);
  B.prop('crate', 27.4, PLINTH, -21.6, -0.6);
  B.prop('crate', 26.9, PLINTH + 0.94, -22.1, 0.4);
  B.prop('pallets', 17.5, PLINTH, -17.5, 0, { variant: 'tall' });
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
  const STAIR = [17.6, 13, 20, 19.8];

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
      { a0: 15, a1: 17.6, y0: PLINTH, y1: 2.5, frame: 'door' },
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
  B.stairs({ x0: 17.6, z0: 13, x1: 20, z1: 19.8, y0: PLINTH, y1: L1, dir: '+z', matName: 'concrete', surface: 'concrete', rail: true });
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
  B.prop('sandbags', 19.0, PLINTH, 14.2, 0);
  board(B, 25.3, 2.1, 20.74, 0, 1.9, 0.9, HAZARD);
  board(B, 30.0, 1.9, 21.26, Math.PI, 1.4, 1.0, 0xdad2c0);

  // Upstairs: a desk at the window that overlooks the road, and worn traffic lines.
  B.box(17.6, L1, 18.0, 18.8, L1 + 0.78, 20.6, 'wood', 'wood');
  B.deco(17.5, L1 + 0.78, 17.9, 18.9, L1 + 0.86, 20.7, 'concreteDark');
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
  B.box(-2.2, 0.95, -18.0, 2.2, 1.5, -16.0, 'concreteDark', 'concrete');
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
  B.prop('pallets', -12.2, 0, 12.4, 0.3);

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
  B.ramp({ x0: 14.6, z0: 0.22, x1: 18.4, z1: 4.6, y0: 0, y1: 2.6, dir: '-z', matName: 'metal', surface: 'metal' });
  B.prop('jersey', 13.6, 0, 2.4, Math.PI / 2);
  B.prop('jersey', 19.4, 0, 2.4, Math.PI / 2);
  B.prop('sandbags', 15.4, 2.6, -1.9, 0);
  B.prop('sandbags', 17.3, 2.6, -1.9, 0);

  // Quayside: crane, bollards, cargo.
  B.prop('crane', 36.5, 0, -8, Math.PI / 2);
  for (let z = -34; z <= 36; z += 7) B.prop('bollard', 40.2, 0, z, 0);
  B.railing(40.6, -38, 40.6, -12, 0, { height: 1.05 });
  B.railing(40.6, 4, 40.6, 38, 0, { height: 1.05 });
  B.prop('container', 38, 0, -26, Math.PI / 2, { color: CONTAINER_COLORS[2] });
  B.prop('container', 38, 2.6, -26, Math.PI / 2, { color: CONTAINER_COLORS[5] });
  B.prop('container', 38, 0, 12, Math.PI / 2, { color: CONTAINER_COLORS[4] });
  B.prop('container', 38, 0, 20, Math.PI / 2, { color: CONTAINER_COLORS[1] });
  B.prop('container', 38, 2.6, 20, Math.PI / 2, { color: CONTAINER_COLORS[0] });
  B.prop('waterTower', 38.5, 0, 32, 0);

  // Loose barrels and tyres along the quay.
  for (let i = 0; i < 7; i++) {
    const x = rng.range(36.6, 40.2), z = rng.range(-36, 36);
    if (Math.abs(z + 1) < 4 || Math.abs(z + 26) < 4 || Math.abs(z - 16) < 6 || Math.abs(z - 32) < 5) continue;
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
  B.prop('pallets', 36.4, 0, -16.5, 0.2);
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
  B.wall(x0, fa, x1, fb, 0, h, matName, 'concrete', { openings: ops });
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
  B.prop('container', 18, 0, 29, Math.PI / 2, { color: CONTAINER_COLORS[0] });
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
