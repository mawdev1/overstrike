/**
 * Map integrity.
 *
 * The properties a shooter's map has to hold, checked against the REAL collider set by
 * booting the world headlessly. These are not style checks — each one corresponds to a
 * defect that was actually found and measured in this map:
 *
 *   - rounds passing through solid walls (4.29% of wall hits, up to 13.7 m of material)
 *   - glass panes entombed inside concrete, turning walls into free windows
 *   - the player escaping the level or seeing over the perimeter
 *   - accidental slits between wall segments that were meant to touch
 *
 *   node scripts/maptest.mjs [--rays=40000]
 */
import * as THREE from 'three';
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';

const arg = (k, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return hit ? Number(hit.split('=')[1]) : d;
};
const RAYS = arg('rays', 40000);

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };

const game = new Game({ headless: true });
await game.initHeadless({ presenter: new NullPresenter() });
const w = game.world;
const boxes = w.boxes;

console.log(`\nmap integrity (${boxes.length} colliders, ${w.spawnPoints.length} spawns)`);

// ── no collider entombed inside another ──────────────────────────────────────────────
//
// A thin collider buried inside a thick one is invisible from outside and breaks any
// thickness measurement taken from a single box. Four glass panes were entombed in the
// warehouse's concrete: the penetration probe found a pane's far face 0.23 m back, called
// 0.40 m of concrete thin, and every rifle on the map could shoot through that wall.
{
  // Restricted to GLASS inside opaque, which is the defect class that matters: a window
  // that is really a solid wall. Two solid boxes overlapping is ordinary construction —
  // wall corners join that way by design — so flagging those is noise.
  const buried = [];
  for (const p of boxes) {
    if (p.surface !== 'glass') continue;
    const cx = (p.min.x + p.max.x) / 2, cy = (p.min.y + p.max.y) / 2, cz = (p.min.z + p.max.z) / 2;
    for (const o of boxes) {
      if (o === p || o.surface === 'glass') continue;
      const oThin = Math.min(o.max.x - o.min.x, o.max.y - o.min.y, o.max.z - o.min.z);
      if (oThin <= 0.25) continue;
      if (cx >= o.min.x && cx <= o.max.x && cy >= o.min.y && cy <= o.max.y
        && cz >= o.min.z && cz <= o.max.z) {
        buried.push(`glass at (${cx.toFixed(2)},${cy.toFixed(2)},${cz.toFixed(2)}) inside ${o.surface}`);
        break;
      }
    }
  }
  if (buried.length === 0) ok('no glass pane is entombed in opaque material');
  else bad('no glass pane is entombed', `${buried.length}:\n       ${buried.slice(0, 6).join('\n       ')}`);
}

// ── walls stop bullets ───────────────────────────────────────────────────────────────
//
// The headline check. Fires a dense sweep and, for every wall hit, measures the UNBROKEN
// run of solid material along the ray. A round may only continue if that run is within
// the penetration budget; anything else is a shoot-through.
{
  const PENETRATION_BUDGET = 0.35;
  const { fireHitscan } = await import('../src/weapons/ballistics.js');
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();

  // Deterministic sweep: a fixed lattice of eye positions and directions, so a failure is
  // reproducible and a fix is verifiable.
  let tested = 0, leaks = 0, worst = 0, worstAt = null;
  const bySurface = {};
  const shooter = { id: 999999, isPlayer: false, alive: true, team: 0, position: new THREE.Vector3() };

  const STEP = 3.0;
  const DIRS = 24;
  outer:
  for (let x = -38; x <= 38; x += STEP) {
    for (let z = -38; z <= 38; z += STEP) {
      for (let eyeY of [1.62, 1.10]) {
        if (w.pointInSolid(x, eyeY, z)) continue;
        for (let d = 0; d < DIRS; d++) {
          const a = (d / DIRS) * Math.PI * 2;
          // Pitched, not just horizontal. A horizontal-only sweep cannot see a leak
          // through a wall/floor seam or a shot taken at a downward angle, and the
          // lattice is aligned to the map's own integer coordinates so it systematically
          // misses everything in between.
          const pitch = ((d % 5) - 2) * 0.14;
          origin.set(x, eyeY, z);
          dir.set(Math.cos(a) * Math.cos(pitch), Math.sin(pitch), Math.sin(a) * Math.cos(pitch));
          shooter.position.set(x, 0, z);

          const hit = w.raycast(origin, dir, 120);
          if (!hit) continue;
          tested++;

          // How much contiguous solid is actually behind that face?
          const inside = new THREE.Vector3(
            hit.point.x + dir.x * 1e-3,
            hit.point.y + dir.y * 1e-3,
            hit.point.z + dir.z * 1e-3,
          );
          const run = w.solidRun(inside, dir, 40);

          // Would the shot engine let a round through it?
          const res = fireHitscan(game, {
            shooter, weaponId: 'ar_vector', origin, dir,
            damage: 30, range: 120, penetration: 0.62,
          });
          const surf = hit.surface || 'unknown';
          const rec = bySurface[surf] || (bySurface[surf] = { hits: 0, pen: 0 });
          rec.hits++;
          if (res?.penetrated) rec.pen++;
          if (res?.penetrated && run > PENETRATION_BUDGET + 0.02) {
            leaks++;
            if (run > worst) { worst = run; worstAt = `(${x},${eyeY},${z}) dir ${a.toFixed(2)} through ${run.toFixed(2)} m`; }
          }
          if (tested >= RAYS) break outer;
        }
      }
    }
  }

  if (leaks === 0) ok(`no shot penetrated more than ${PENETRATION_BUDGET} m of solid (${tested} wall hits tested)`);
  else {
    bad('shots only pass through penetrable thickness',
      `${leaks} of ${tested} wall hits leaked (${(leaks / tested * 100).toFixed(2)}%), worst ${worst.toFixed(2)} m at ${worstAt}`);
  }

  // The other half of the contract, and the half a "make walls stop bullets" change is
  // most likely to break. Every check above is satisfied by `probeExit` returning false
  // unconditionally — which would pass the suite and delete the mechanic.
  const glassPen = bySurface.glass ? bySurface.glass.pen / bySurface.glass.hits : 0;
  if (bySurface.glass && glassPen > 0.95) {
    ok(`glass is still shootable through (${(glassPen * 100).toFixed(1)}% of ${bySurface.glass.hits} hits)`);
  } else {
    bad('glass is still shootable through',
      `${bySurface.glass ? (glassPen * 100).toFixed(1) + '%' : 'no glass was hit'} — penetration has been broken, not fixed`);
  }
  const totalPen = Object.values(bySurface).reduce((a, x) => a + x.pen, 0);
  const rate = totalPen / tested;
  if (rate > 0.02) {
    const brk = Object.entries(bySurface)
      .sort((p, q) => q[1].hits - p[1].hits)
      .map(([k, v]) => `${k} ${(v.pen / v.hits * 100).toFixed(1)}%`).join(' · ');
    ok(`penetration still works overall (${(rate * 100).toFixed(2)}% of hits): ${brk}`);
  } else {
    bad('penetration still works', `only ${(rate * 100).toFixed(2)}% of wall hits penetrate — the mechanic is effectively off`);
  }
}

// ── solidRun agrees with reality ─────────────────────────────────────────────────────
//
// The check above trusts `solidRun`, so `solidRun` needs its own. Sample points along a
// measured run and confirm every one of them is genuinely inside a collider.
{
  const origin = new THREE.Vector3(), dir = new THREE.Vector3();
  let checked = 0, wrong = 0;
  for (let x = -36; x <= 36; x += 7) {
    for (let z = -36; z <= 36; z += 7) {
      origin.set(x, 1.62, z);
      dir.set(1, 0, 0);
      const hit = w.raycast(origin, dir, 100);
      if (!hit) continue;
      const inside = new THREE.Vector3(hit.point.x + 1e-3, hit.point.y, hit.point.z);
      const run = w.solidRun(inside, dir, 20);
      if (run <= 0) continue;
      checked++;
      // Every sample strictly inside the run must be solid.
      for (let f = 0.1; f < 1; f += 0.2) {
        if (!w.pointInSolid(inside.x + run * f, inside.y, inside.z)) { wrong++; break; }
      }
    }
  }
  if (checked > 0 && wrong === 0) ok(`solidRun matches point sampling on ${checked} walls`);
  else if (checked === 0) bad('solidRun was exercised', 'no walls were sampled');
  else bad('solidRun matches point sampling', `${wrong} of ${checked} runs contained a gap`);
}

/** Surfaces a player can actually get to. Filled by the containment check below, and
 *  reused by the walk-off check — a barrier on a deck nobody can reach is not a defect. */
let reachable = new Set();

// ── the player cannot leave ──────────────────────────────────────────────────────────
//
// Geometry is the ONLY containment here: nothing clamps to `world.bounds` and there is no
// kill volume. A perch tall enough to mantle the perimeter is therefore an instant
// out-of-map exploit, so the margin is the thing to protect.
{
  // Imported, not hardcoded — this file's own comment argues that hardcoding is the
  // failure a regression test can least afford, and then hardcoded these.
  const { PLAYER_TUNE } = await import('../src/player/player.js');
  // GRAVITY is stored NEGATIVE (-22). Forgetting that made JUMP negative, which made
  // `climb` 0.20 m and quietly collapsed the reachable set from 701 surfaces to 215 —
  // a check that still printed "ok" while testing almost nothing.
  const G = Math.abs(PLAYER_TUNE.GRAVITY);
  const JUMP = (PLAYER_TUNE.JUMP_SPEED ** 2) / (2 * G);
  const MANTLE = PLAYER_TUNE.MANTLE_MAX_H;
  const REACH = PLAYER_TUNE.RADIUS + PLAYER_TUNE.MANTLE_REACH;
  const climb = JUMP + MANTLE;
  // How far a jump CARRIES. The reachability flood previously used `REACH` (0.91 m) as
  // its horizontal pad, which is the distance you can lean — not the distance you can
  // jump. That is why it rated the market-hall lantern unreachable across a 2.2 m gap
  // while 14,441 valid launch solutions existed.
  // Horizontal distance covered by the time the jump reaches its apex — which is where
  // an air-mantle happens, so it is the reach that matters for "can they get up there".
  const JUMP_REACH = PLAYER_TUNE.SPRINT_SPEED * (PLAYER_TUNE.JUMP_SPEED / G);

  // Wall tops are MEASURED, not assumed. Hardcoding them meant the check kept testing
  // against the old heights after the level changed, which is the failure mode a
  // regression test can least afford.
  const wallTop = (axis, at) => {
    let top = 0;
    for (const bx of boxes) {
      const lo = axis === 'x' ? bx.min.x : bx.min.z;
      const hi = axis === 'x' ? bx.max.x : bx.max.z;
      if (at < 0 ? hi > at + 0.6 : lo < at - 0.6) continue;   // must straddle the face
      if (Math.min(Math.abs(lo - at), Math.abs(hi - at)) > 2.5) continue;
      if (bx.max.y > top) top = bx.max.y;
    }
    return top;
  };
  const walls = [
    { name: 'west', axis: 'x', at: -41, top: wallTop('x', -41) },
    { name: 'east', axis: 'x', at: 41, top: wallTop('x', 41) },
    { name: 'north', axis: 'z', at: -41, top: wallTop('z', -41) },
    { name: 'south', axis: 'z', at: 41, top: wallTop('z', 41) },
  ];
  // A surface only matters here if a player can actually REACH it. Footprint alone is not
  // enough — it calls a 1x1 antenna mast at 13.5 m a standing surface, and the market-hall
  // lantern at 11.67 m sits 7 cm above what anything below it can climb to.
  //
  // So: flood up from the ground. A surface joins the reachable set when it is within one
  // jump-plus-mantle of a surface already in it and horizontally close enough to step
  // across. This is the same question the containment argument rests on, asked directly.
  // Area, not a minimum in each axis: a staircase tread is 2.4 m x 0.38 m and is very
  // much standable, and excluding it breaks every route that goes up stairs — which
  // collapsed the reachable set from 10.7 m to 5.4 m and made the whole check vacuous.
  // Area only — NO per-axis minimum.
  //
  // Requiring 0.3 m in both axes was demonstrably wrong: the map's own 0.26 m parapets are
  // provably standable, and a constructed 0.20 m-thick rung ladder up the inside of the
  // perimeter passed this gate while the real controller climbed it to the top of the wall,
  // from which 75.8% of rays leave the level. A surface is standable if a 0.36 m-radius
  // body can be supported on it, which is about area and support, not about being square.
  const standable = (bx) => (bx.max.x - bx.min.x) * (bx.max.z - bx.min.z) >= 0.05
    && Math.max(bx.max.x - bx.min.x, bx.max.z - bx.min.z) >= 0.25;
  const surfaces = boxes.filter(standable);

  const overlapsXZ = (a, c, pad) => a.min.x - pad <= c.max.x && a.max.x + pad >= c.min.x
    && a.min.z - pad <= c.max.z && a.max.z + pad >= c.min.z;

  reachable = new Set();
  for (const bx of surfaces) if (bx.max.y <= 1.4) reachable.add(bx);   // walk-on from ground
  for (let pass = 0; pass < 12; pass++) {
    let added = 0;
    for (const bx of surfaces) {
      if (reachable.has(bx)) continue;
      for (const from of reachable) {
        if (bx.max.y - from.max.y > climb) continue;
        if (bx.max.y < from.max.y - 6) continue;                       // a drop, fine
        if (!overlapsXZ(bx, from, JUMP_REACH)) continue;
        reachable.add(bx); added++; break;
      }
    }
    if (!added) break;
  }

  const risky = [];
  for (const wall of walls) {
    for (const b of reachable) {
      const near = wall.axis === 'x'
        ? Math.min(Math.abs(b.min.x - wall.at), Math.abs(b.max.x - wall.at))
        : Math.min(Math.abs(b.min.z - wall.at), Math.abs(b.max.z - wall.at));
      if (near > REACH + 1) continue;
        if (b.max.y >= wall.top - 0.2) continue;       // the wall's own coping
      if (b.max.y + climb >= wall.top) {
        risky.push(`${wall.name}: reachable surface at y=${b.max.y.toFixed(2)} + ${climb.toFixed(2)} climb >= wall top ${wall.top.toFixed(2)}`);
      }
    }
  }

  if (risky.length === 0) {
    ok(`no reachable surface near a perimeter wall is within ${climb.toFixed(2)} m of its top (${reachable.size} surfaces reachable)`);
  } else {
    bad('the perimeter cannot be climbed', `${risky.length}:\n       ${risky.slice(0, 5).join('\n       ')}`);
  }

  // Climbing the wall is one failure; SEEING over it is the other, and it is the one that
  // actually happened. Two rooftop props put the eye at 12.07 and 12.32 against a 12.0 m
  // wall, and 65% of horizontal rays from them escaped into the void.
  // A jumping eye, not a standing one: 13.4 cleared a standing eye from the highest
  // perch (12.32) and not a jumping one (13.47), and 60% of horizontal rays escaped from
  // the top of a jump.
  const EYE = 1.62 + JUMP;
  const minTop = Math.min(...walls.map((x) => x.top));
  let highest = 0, highestAt = null;
  for (const bx of reachable) {
    if (Math.abs(bx.max.x) > 41 || Math.abs(bx.min.x) > 41) continue;
    if (Math.abs(bx.max.z) > 41 || Math.abs(bx.min.z) > 41) continue;
    // No blanket height exemption. Skipping "anything above 13 m" quietly excused
    // exactly the perches this check exists to find; the perimeter is excluded by being
    // outside the play area, which the bounds test above already does.
    if (bx.max.y > highest) {
      highest = bx.max.y;
      highestAt = `(${((bx.min.x + bx.max.x) / 2).toFixed(1)}, ${bx.max.y.toFixed(2)}, ${((bx.min.z + bx.max.z) / 2).toFixed(1)})`;
    }
  }
  if (highest + EYE < minTop) {
    ok(`the highest standable surface (${highest.toFixed(2)} m) puts the eye ${(minTop - highest - EYE).toFixed(2)} m below the lowest wall top`);
  } else {
    bad('nothing reachable can see over the perimeter',
      `standable surface at ${highest.toFixed(2)} m ${highestAt} gives eye ${(highest + EYE).toFixed(2)} vs wall top ${minTop}`);
  }
}

// ── no walking off a roof by accident ────────────────────────────────────────────────
//
// The highest-frequency player-facing defect on this map, and nothing was looking for it.
// A parapet's crenellation gaps are meant to be firing slits; if the sill is below
// MAX_STEP_HEIGHT the player walks straight over it while holding forward, and on a roof
// that is an 8 m fall. Every crenel on the map was one.
{
  const MAX_STEP = 0.55;
  const offenders = [];
  // Any surface a player can stand on, high enough that falling off it matters.
  for (const deck of boxes) {
    if (deck.max.y < 3.0) continue;
    if ((deck.max.x - deck.min.x) * (deck.max.z - deck.min.z) < 6) continue;   // a real deck
    // Only decks a player can reach. The first version flagged the west gate tower top at
    // 14.6 m, which is part of the perimeter assembly and 9 m above anything anyone can
    // climb to — a barrier nobody can walk off is not a defect.
    if (!reachable.has(deck)) continue;
    // Walk the deck's perimeter looking for a spot where the tallest thing standing on
    // the edge is a step rather than a barrier.
    for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ex = ax !== 0 ? (ax > 0 ? deck.max.x : deck.min.x) : (deck.min.x + deck.max.x) / 2;
      const ez = az !== 0 ? (az > 0 ? deck.max.z : deck.min.z) : (deck.min.z + deck.max.z) / 2;
      const span = ax !== 0 ? deck.max.z - deck.min.z : deck.max.x - deck.min.x;

      // Sample the whole edge, then judge it as a whole.
      //
      // What matters is INCONSISTENCY, not lip height. A uniformly low kerb over a drop
      // is a deliberate drop-down route and every good map has them; what traps a player
      // is an edge that is mostly a barrier — so it reads as safe — with one section they
      // walk straight through. That is exactly what a crenellation gap below step height
      // is, and it is what an earlier version of this check could not tell apart from a
      // ledge you are meant to hop off.
      const samples = [];
      for (let t = -span / 2 + 0.5; t < span / 2; t += 0.5) {
        const px = ax !== 0 ? ex : ex + t;
        const pz = az !== 0 ? ez : ez + t;
        let lip = deck.max.y;
        for (const b2 of boxes) {
          if (b2 === deck) continue;
          if (b2.max.y <= deck.max.y || b2.min.y > deck.max.y + 0.05) continue;
          if (px < b2.min.x - 0.2 || px > b2.max.x + 0.2) continue;
          if (pz < b2.min.z - 0.2 || pz > b2.max.z + 0.2) continue;
          if (b2.max.y > lip) lip = b2.max.y;
        }
        const beyond = w.sampleGroundHeight(px + ax * 0.8, pz + az * 0.8, deck.max.y + 0.5);
        samples.push({ px, pz, rise: lip - deck.max.y, drop: deck.max.y - (beyond === null ? -10 : beyond) });
      }
      if (samples.length < 4) continue;

      const barriered = samples.filter((q) => q.rise > MAX_STEP).length / samples.length;
      if (barriered < 0.6) continue;                 // an open edge, deliberately

      for (const q of samples) {
        if (q.rise > MAX_STEP || q.drop < 2.5) continue;
        offenders.push(`deck y=${deck.max.y.toFixed(2)} at (${q.px.toFixed(1)}, ${q.pz.toFixed(1)}): ${(barriered * 100).toFixed(0)}% of this edge is a barrier, here the lip is ${q.rise.toFixed(2)} m over a ${q.drop.toFixed(1)} m drop`);
      }
    }
  }

  const unique = [...new Set(offenders.map((o) => o.replace(/\(.*\)/, '')))];
  if (offenders.length === 0) ok('no roof edge has a barrier low enough to walk over');
  else {
    bad('roof barriers are either absent or high enough to stop you',
      `${offenders.length} spots, ${unique.length} distinct decks:\n       ${offenders.slice(0, 5).join('\n       ')}`);
  }
}

// ── no accidental slits between wall segments ────────────────────────────────────────
//
// A doorway is a large regular opening; a slit is a few centimetres between two segments
// that were meant to touch. The latter reads as sloppy construction and, on a thin wall,
// is a free sightline.
{
  const slits = [];
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    const aThin = Math.min(a.max.x - a.min.x, a.max.z - a.min.z);
    if (aThin > 0.6 || a.max.y - a.min.y < 0.8) continue;      // wall-like only
    for (let j = i + 1; j < boxes.length; j++) {
      const b2 = boxes[j];
      const bThin = Math.min(b2.max.x - b2.min.x, b2.max.z - b2.min.z);
      if (bThin > 0.6 || b2.max.y - b2.min.y < 0.8) continue;
      // Same COURSE as well as the same plane. Without the height match this catches a
      // staircase (consecutive treads are collinear and 0.38 m apart) and a window's own
      // sill against its lintel — neither of which is a seam.
      if (Math.abs(a.min.y - b2.min.y) > 0.05 || Math.abs(a.max.y - b2.max.y) > 0.05) continue;
      for (const [p, q] of [['x', 'z'], ['z', 'x']]) {
        if (Math.abs(a.min[q] - b2.min[q]) > 0.05 || Math.abs(a.max[q] - b2.max[q]) > 0.05) continue;
        const gap = a.min[p] > b2.max[p] ? a.min[p] - b2.max[p]
          : b2.min[p] > a.max[p] ? b2.min[p] - a.max[p] : -1;
        // Below a third of a metre. Anything wider is a doorway or a deliberate gap; a
        // seam is the few centimetres between two segments that were meant to touch.
        if (gap > 0.005 && gap < 0.33) {
          slits.push(`${gap.toFixed(3)} m at ${p}=${a.min[p].toFixed(2)} ${q}=${a.min[q].toFixed(2)}`);
        }
      }
    }
  }
  const unique = [...new Set(slits)];
  if (unique.length === 0) ok('no sub-player-width slits between wall segments');
  else bad('wall segments meet cleanly', `${unique.length}:\n       ${unique.slice(0, 6).join('\n       ')}`);
}

// ── the collider set itself is well formed ───────────────────────────────────────────
//
// Cheap, and it fails loudly rather than silently: an inverted or zero-extent box is
// invisible to the sweep, so a wall authored with its coordinates the wrong way round is
// simply not there — and nothing else in this file would notice.
{
  const bad2 = [];
  for (const b of w.boxes) {
    const w = b.max.x - b.min.x, h = b.max.y - b.min.y, d = b.max.z - b.min.z;
    if (![b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite)) {
      bad2.push(`non-finite at [${b.min.x},${b.min.y},${b.min.z}]`);
    } else if (w <= 0 || h <= 0 || d <= 0) {
      bad2.push(`inverted ${w.toFixed(3)}x${h.toFixed(3)}x${d.toFixed(3)} at [${b.min.x.toFixed(1)},${b.min.y.toFixed(1)},${b.min.z.toFixed(1)}]`);
    } else if (Math.min(w, h, d) < 0.01) {
      bad2.push(`${(Math.min(w, h, d) * 100).toFixed(1)} cm thin at [${b.min.x.toFixed(1)},${b.min.y.toFixed(1)},${b.min.z.toFixed(1)}]`);
    }
  }
  if (bad2.length === 0) ok(`all ${w.boxes.length} colliders are well formed`);
  else bad('every collider is well formed', `${bad2.length}:\n       ${bad2.slice(0, 6).join('\n       ')}`);
}

// ── there is ground everywhere ───────────────────────────────────────────────────────
//
// A hole in the floor is the most complete version of "walked through a wall": the player
// leaves the map downwards and never comes back. The nav bake once had 46% of its nodes
// underground, so this is not hypothetical geometry paranoia.
{
  const STEP = 0.5;
  let sampled = 0;
  const holes = [];
  for (let x = w.bounds.min.x + 0.25; x <= w.bounds.max.x; x += STEP) {
    for (let z = w.bounds.min.z + 0.25; z <= w.bounds.max.z; z += STEP) {
      sampled++;
      const top = w.sampleGroundHeight(x, z, 20);
      if (!(top > -Infinity) || top < w.bounds.min.y + 0.5) {
        if (holes.length < 8) holes.push(`(${x.toFixed(1)}, ${z.toFixed(1)})`);
      }
    }
  }
  if (holes.length === 0) ok(`solid ground under all ${sampled} sampled columns`);
  else bad('there is ground everywhere', `${holes.length}+ columns with no floor: ${holes.join(' ')}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nthe map holds up');
process.exit(failures ? 1 : 0);
