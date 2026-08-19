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
          origin.set(x, eyeY, z);
          dir.set(Math.cos(a), 0, Math.sin(a));
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

// ── the player cannot leave ──────────────────────────────────────────────────────────
//
// Geometry is the ONLY containment here: nothing clamps to `world.bounds` and there is no
// kill volume. A perch tall enough to mantle the perimeter is therefore an instant
// out-of-map exploit, so the margin is the thing to protect.
{
  const JUMP = 1.146;          // apex from TUNE: v^2 / 2g
  const MANTLE = 1.35;
  const REACH = 0.91;          // player radius + mantle reach
  const climb = JUMP + MANTLE;

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
  const standable = (bx) => (bx.max.x - bx.min.x) >= 0.3 && (bx.max.z - bx.min.z) >= 0.3
    && (bx.max.x - bx.min.x) * (bx.max.z - bx.min.z) >= 0.5;
  const surfaces = boxes.filter(standable);

  const overlapsXZ = (a, c, pad) => a.min.x - pad <= c.max.x && a.max.x + pad >= c.min.x
    && a.min.z - pad <= c.max.z && a.max.z + pad >= c.min.z;

  const reachable = new Set();
  for (const bx of surfaces) if (bx.max.y <= 1.4) reachable.add(bx);   // walk-on from ground
  for (let pass = 0; pass < 12; pass++) {
    let added = 0;
    for (const bx of surfaces) {
      if (reachable.has(bx)) continue;
      for (const from of reachable) {
        if (bx.max.y - from.max.y > climb) continue;
        if (bx.max.y < from.max.y - 6) continue;                       // a drop, fine
        if (!overlapsXZ(bx, from, REACH)) continue;
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
      if (b.max.y >= wall.top - 1.0) continue;         // part of the wall assembly
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
  const EYE = 1.62;
  const minTop = Math.min(...walls.map((x) => x.top));
  let highest = 0, highestAt = null;
  for (const bx of reachable) {
    if (Math.abs(bx.max.x) > 41 || Math.abs(bx.min.x) > 41) continue;
    if (Math.abs(bx.max.z) > 41 || Math.abs(bx.min.z) > 41) continue;
    if (bx.max.y > 13) continue;                       // the perimeter itself
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

console.log(failures ? `\n${failures} FAILED` : '\nthe map holds up');
process.exit(failures ? 1 : 0);
