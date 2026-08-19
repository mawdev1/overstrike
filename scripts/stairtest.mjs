/**
 * Stair audit — every staircase on the map, measured against the colliders the player
 * actually touches, then walked by a real Player in a real headless Game.
 *
 * Two independent passes, because they catch different classes of defect:
 *
 *   GEOMETRY  Instruments Builder.stairs()/ramp() so each call's colliders are captured
 *             as a labelled set, then measures rise/going/continuity/landings/headroom/
 *             width against MAX_STEP (0.55) and the player capsule (r 0.36, h 1.80).
 *             This is where a silently-unclimbable tread or a floating landing shows up.
 *
 *   WALK      Boots a headless Game, teleports a Player to the foot of each run and
 *             holds forward at FIXED_DT until it either reaches the top or stalls; then
 *             repeats downward. A stair that measures fine but cannot be walked is
 *             still broken, and vice versa.
 *
 *   NAV       Cross-checks navGrid: can the AI step onto the run from the floor, and
 *             walk it to the top without leaving the stair's own footprint?
 *
 *   node scripts/stairtest.mjs [--verbose]
 */
import * as THREE from 'three';
import { Builder } from '../src/world/props.js';
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';

const VERBOSE = process.argv.includes('--verbose');

const MAX_STEP = 0.55;
const RADIUS = 0.36;
const STAND = 1.80;
const CROUCH = 1.10;

// ───────────────────────────────────────────────────────── instrument the builder

const RUNS = [];
for (const fn of ['stairs', 'ramp']) {
  const orig = Builder.prototype[fn];
  Builder.prototype[fn] = function patched(opts) {
    const start = this.world.boxes.length;
    // level.js frame of the caller, so every finding maps to a line to edit.
    const site = (new Error().stack || '').split('\n')
      .find((l) => l.includes('level.js')) || '?';
    const m = site.match(/level\.js:(\d+):/);
    const out = orig.call(this, opts);
    RUNS.push({
      kind: fn,
      opts: { ...opts },
      line: m ? Number(m[1]) : 0,
      i0: start,
      i1: this.world.boxes.length,
    });
    return out;
  };
}

// ────────────────────────────────────────────────────────────────────────── boot

const game = new Game({ headless: true });
await game.initHeadless({ presenter: new NullPresenter() });
const world = game.world;
const B = world.boxes;

const ov = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);

/**
 * Highest solid top face under (x,z) below `yMax`.
 * Centre-point containment, not a radius footprint: a kerb or parapet BESIDE the
 * landing is not the floor the player stands on, and treating it as one produced
 * spurious "landing undershoot" readings on every stair with a rail.
 */
function groundUnder(x, z, yMax, skip) {
  let best = -Infinity, bi = -1;
  for (let i = 0; i < B.length; i++) {
    if (skip && skip.has(i)) continue;
    const b = B[i];
    if (b.max.y > yMax + 1e-6) continue;
    if (!(b.min.x <= x + 1e-6 && b.max.x >= x - 1e-6)) continue;
    if (!(b.min.z <= z + 1e-6 && b.max.z >= z - 1e-6)) continue;
    if (b.max.y > best) { best = b.max.y; bi = i; }
  }
  return { y: best, i: bi };
}

/** Lowest solid bottom face genuinely OVERHEAD at (x,z) — centre-point containment. */
function ceilingAbove(x, z, yMin, skip) {
  let best = Infinity, bi = -1;
  for (let i = 0; i < B.length; i++) {
    if (skip && skip.has(i)) continue;
    const b = B[i];
    if (b.min.y < yMin - 1e-6) continue;        // starts below the feet — not a ceiling
    if (!(b.min.x <= x + 1e-6 && b.max.x >= x - 1e-6)) continue;
    if (!(b.min.z <= z + 1e-6 && b.max.z >= z - 1e-6)) continue;
    if (b.min.y < best) { best = b.min.y; bi = i; }
  }
  return { y: best, i: bi };
}

/** Anything overlapping the standing capsule AABB at (x, y, z)? */
function overlaps(x, y, z, h, skip, r = RADIUS) {
  const hits = [];
  for (let i = 0; i < B.length; i++) {
    if (skip && skip.has(i)) continue;
    const b = B[i];
    if (!(b.min.x < x + r - 1e-6 && b.max.x > x - r + 1e-6)) continue;
    if (!(b.min.z < z + r - 1e-6 && b.max.z > z - r + 1e-6)) continue;
    if (!(b.min.y < y + h - 1e-6 && b.max.y > y + 1e-6)) continue;
    hits.push(i);
  }
  return hits;
}

// ───────────────────────────────────────────────────────────── geometry analysis

function analyse(run) {
  const o = run.opts;
  const alongX = o.dir === '+x' || o.dir === '-x';
  const asc = o.dir === '+x' || o.dir === '+z';
  const A = alongX ? 'x' : 'z';           // run axis
  const C = alongX ? 'z' : 'x';           // cross axis
  const a0 = alongX ? o.x0 : o.z0, a1 = alongX ? o.x1 : o.z1;
  const c0 = alongX ? o.z0 : o.x0, c1 = alongX ? o.z1 : o.x1;

  const own = new Set();
  for (let i = run.i0; i < run.i1; i++) own.add(i);

  // Treads = the run's own colliders, sorted along the direction of ascent.
  const treads = [];
  for (let i = run.i0; i < run.i1; i++) {
    const b = B[i];
    treads.push({
      i, top: b.max.y, bot: b.min.y,
      a0: b.min[A], a1: b.max[A], c0: b.min[C], c1: b.max[C],
    });
  }
  treads.sort((p, q) => p.top - q.top);

  const R = {
    run, A, C, asc, alongX, own, treads,
    aLo: Math.min(a0, a1), aHi: Math.max(a0, a1),
    cLo: Math.min(c0, c1), cHi: Math.max(c0, c1),
    yBot: o.y0, yTop: o.y1,
    fail: [], warn: [], m: {},
  };

  // ── 1. tread rise ──────────────────────────────────────────────────────────
  let maxRise = 0, minRise = Infinity;
  const rises = [];
  let prev = o.y0;
  for (const t of treads) {
    const r = t.top - prev;
    rises.push(r);
    if (r > maxRise) maxRise = r;
    if (r < minRise) minRise = r;
    prev = t.top;
  }
  R.m.rises = rises;
  R.m.maxRise = maxRise;
  R.m.minRise = minRise;
  R.m.steps = treads.length;
  if (maxRise > MAX_STEP + 1e-6) R.fail.push(`tread rise ${maxRise.toFixed(3)} > MAX_STEP ${MAX_STEP}`);

  // ── 2. continuity / going ──────────────────────────────────────────────────
  let minGoing = Infinity, maxGap = 0;
  const ordered = treads.slice().sort((p, q) => (asc ? p.a0 - q.a0 : q.a0 - p.a0));
  for (let k = 0; k < ordered.length; k++) {
    const t = ordered[k];
    minGoing = Math.min(minGoing, t.a1 - t.a0);
    if (k + 1 < ordered.length) {
      const n = ordered[k + 1];
      // Exposed going: the part of this tread not buried by the next one up.
      const gap = asc ? (n.a0 - t.a1) : (t.a0 - n.a1);
      if (gap > maxGap) maxGap = gap;
    }
  }
  R.m.going = minGoing;
  R.m.maxGap = maxGap;
  if (maxGap > 1e-4) R.fail.push(`gap between treads ${maxGap.toFixed(3)} m`);
  if (minGoing < 0.24) R.warn.push(`going ${minGoing.toFixed(3)} m is tight`);

  // ── 5. clear width (rails, clutter and walls eating the run) ───────────────
  // Sample the cross-axis in 5 cm steps at each tread's mid-going and take the LONGEST
  // CONTIGUOUS free span — a mid-run obstruction leaves two narrow lanes, and taking the
  // outer envelope (as a min/max scan does) would call that a full-width stair.
  const SAMP = 0.05;
  let minClear = Infinity, clearAt = null;
  const lanePts = [];
  for (const t of treads) for (const f of [0.15, 0.5, 0.85]) lanePts.push({ t, f });
  for (const { t, f } of lanePts) {
    const aMid = t.a0 + (t.a1 - t.a0) * f;
    const y = t.top;
    let best = 0, run = 0, bestHi = 0;
    for (let c = R.cLo + SAMP / 2; c < R.cHi; c += SAMP) {
      let free = true;
      for (let i = 0; i < B.length && free; i++) {
        if (own.has(i)) continue;
        const b = B[i];
        if (!(b.min[A] < aMid - 1e-6 && b.max[A] > aMid + 1e-6)) continue;
        if (!(b.min[C] < c - 1e-6 && b.max[C] > c + 1e-6)) continue;
        // A solid whose top is within MAX_STEP of the tread is a STEP, not a wall —
        // the solver walks straight over it. Only what stands proud of the step-up
        // allowance actually narrows the run.
        if (b.max.y > y + MAX_STEP && b.min.y < y + STAND) free = false;
      }
      if (free) { run += SAMP; if (run > best) { best = run; bestHi = c + SAMP / 2; } }
      else run = 0;
    }
    if (best < minClear) { minClear = best; clearAt = { aMid, lo: bestHi - best, hi: bestHi, y }; }
  }
  R.m.clearWidth = minClear;
  R.m.nominalWidth = R.cHi - R.cLo;
  R.m.clearAt = clearAt;
  if (minClear < 2 * RADIUS) R.fail.push(`clear width ${minClear.toFixed(3)} < player diameter ${(2 * RADIUS).toFixed(2)}`);
  else if (minClear < 2 * RADIUS + 0.12) R.warn.push(`clear width ${minClear.toFixed(3)} m is tight`);

  // ── 3. both ends ───────────────────────────────────────────────────────────
  const cMid = (R.cLo + R.cHi) / 2;
  const first = ordered[0], last = ordered[ordered.length - 1];

  // Bottom: the floor just OUTSIDE the foot of the run.
  const footA = asc ? R.aLo - RADIUS - 0.05 : R.aHi + RADIUS + 0.05;
  const fp = alongX ? { x: footA, z: cMid } : { x: cMid, z: footA };
  // Ceiling on the search: a surface more than one step above the tread is not a floor
  // the player arrives on, it is an object standing on the floor. Without this, a
  // market stall or a crenel at the head reads as "the landing", and the landing-
  // mismatch number becomes the height of the furniture.
  const gBot = groundUnder(fp.x, fp.z, first.top + MAX_STEP, own);
  R.m.floorBottom = gBot.y;
  R.m.bottomLip = first.top - gBot.y;        // first tread top relative to the floor
  if (!isFinite(gBot.y)) R.fail.push('no floor at the foot of the run');
  else if (R.m.bottomLip > MAX_STEP + 1e-6) R.fail.push(`first tread is ${R.m.bottomLip.toFixed(3)} above the floor it starts from`);
  else if (R.m.bottomLip < -0.02) R.warn.push(`first tread is buried ${(-R.m.bottomLip).toFixed(3)} below the start floor`);

  // Top: the floor just BEYOND the head of the run.
  const headA = asc ? R.aHi + RADIUS + 0.05 : R.aLo - RADIUS - 0.05;
  const hp = alongX ? { x: headA, z: cMid } : { x: cMid, z: headA };
  const gTop = groundUnder(hp.x, hp.z, last.top + MAX_STEP, own);
  R.m.floorTop = gTop.y;
  R.m.topStep = gTop.y - last.top;           // destination slab relative to the last tread
  if (!isFinite(gTop.y)) R.fail.push('no floor at the head of the run — the top tread lands on nothing');
  else if (Math.abs(R.m.topStep) > 1e-3) {
    if (R.m.topStep > MAX_STEP + 1e-6) R.fail.push(`top tread undershoots the landing by ${R.m.topStep.toFixed(3)} (> MAX_STEP)`);
    else if (R.m.topStep < -MAX_STEP - 1e-6) R.fail.push(`top tread overshoots the landing by ${(-R.m.topStep).toFixed(3)} (> MAX_STEP drop)`);
    else R.warn.push(`landing mismatch ${R.m.topStep >= 0 ? '+' : ''}${R.m.topStep.toFixed(3)} m at the head`);
  }

  // ── 4. headroom along the whole path ───────────────────────────────────────
  // Sampled across the width and reduced with MAX, not the centreline alone: a player
  // may pick a lane, so the stair is only impassable when EVERY lane is low.
  let minHead = Infinity, headAt = null;
  const probes = [];
  probes.push({ a: footA, y: gBot.y });
  for (const t of ordered) probes.push({ a: (t.a0 + t.a1) / 2, y: t.top });
  probes.push({ a: headA, y: isFinite(gTop.y) ? gTop.y : o.y1 });
  for (const pr of probes) {
    let bestH = -Infinity, bestC = null;
    for (let c = R.cLo + 0.1; c <= R.cHi - 0.1 + 1e-9; c += 0.1) {
      const q = alongX ? { x: pr.a, z: c } : { x: c, z: pr.a };
      const hit = ceilingAbove(q.x, q.z, pr.y + 0.02, own);
      const h = hit.y - pr.y;
      if (h > bestH) { bestH = h; bestC = { c, ci: hit.i, cy: hit.y }; }
    }
    if (bestH < minHead) { minHead = bestH; headAt = { ...pr, ...bestC }; }
  }
  R.m.headroom = minHead;
  R.m.headAt = headAt;
  if (minHead < CROUCH) R.fail.push(`headroom ${minHead.toFixed(3)} m — impassable even crouched`);
  else if (minHead < STAND) R.fail.push(`headroom ${minHead.toFixed(3)} m — a standing player is blocked`);
  else if (minHead < STAND + 0.15) R.warn.push(`headroom ${minHead.toFixed(3)} m is marginal`);

  // ── 6. alignment: does the run clip a wall, or leave a side gap? ───────────
  // Any non-own collider intruding into the tread footprint between foot level and
  // stand height above the tread is a clip.
  const clips = [];
  for (const t of ordered) {
    const y = t.top;
    for (let i = 0; i < B.length; i++) {
      if (own.has(i)) continue;
      const b = B[i];
      const oa = ov(b.min[A], b.max[A], t.a0, t.a1);
      const oc = ov(b.min[C], b.max[C], t.c0, t.c1);
      if (oa <= 0.02 || oc <= 0.02) continue;
      if (b.max.y <= y + 0.02 || b.min.y >= y + STAND) continue;
      clips.push({ i, tread: t.i, oa, oc, by0: b.min.y, by1: b.max.y });
    }
  }
  R.m.clips = clips;

  // ── 7. room to stand at either end ─────────────────────────────────────────
  // A landing you cannot occupy is a stair you can only enter by side-stepping.
  // Tried in every lane: one clear lane is enough to enter the stair on foot.
  const standRoom = (a, y) => {
    for (let c = R.cLo + RADIUS; c <= R.cHi - RADIUS + 1e-9; c += 0.1) {
      const q = alongX ? { x: a, z: c } : { x: c, z: a };
      if (overlaps(q.x, y + 0.02, q.z, STAND - 0.04, own).length === 0) return true;
    }
    return false;
  };
  R.m.footRoom = isFinite(gBot.y) ? standRoom(footA, gBot.y) : false;
  R.m.headRoom2 = isFinite(gTop.y) ? standRoom(headA, gTop.y) : false;
  if (!R.m.footRoom) R.fail.push('no room to stand directly in front of the bottom tread');
  if (!R.m.headRoom2) R.fail.push('no room to stand directly beyond the top tread');
  if (clips.length) {
    const worst = clips.reduce((p, q) => (q.oa * q.oc > p.oa * p.oc ? q : p));
    const msg = `${clips.length} collider(s) intrude into the run (worst ${worst.oa.toFixed(2)}×${worst.oc.toFixed(2)} m, box #${worst.i} y[${worst.by0.toFixed(2)},${worst.by1.toFixed(2)}])`;
    // Only a fail if it actually narrows the walkable lane below the player.
    (minClear < 2 * RADIUS + 0.02 ? R.fail : R.warn).push(msg);
  }

  return R;
}

const analyses = RUNS.map(analyse);

// ───────────────────────────────────────────────────────────────── walk the runs

const { Player } = await import('../src/player/player.js');
const { FIXED_DT } = await import('../src/core/mathUtils.js');

game.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 99 });
game.match.phase = 'live';
game.match.countdown = 0;

const emptyCommand = () => ({
  wishForward: 0, wishRight: 0,
  jump: false, crouchPressed: false, reload: false, melee: false, grenade: false,
  interact: false, inspect: false, killstreak: false, lastWeapon: false,
  sprintDown: false, sprintUp: false, firePressed: false, aimButtonPressed: false,
  crouchHeld: false, toggleAdsMode: false, aimButtonHeld: false, fireHeld: false,
  sprintKeyHeld: false, breathHold: false, leanKeyHeld: false, leanRightKeyHeld: false,
  slot: -1, wheel: 0, deltaYaw: 0, deltaPitch: 0, baseYaw: 0, basePitch: 0, tick: 0,
});

const p = game.player;

/** Yaw that points +x / -x / +z / -z, in this project's convention (probed, not assumed). */
function yawFor(dx, dz) {
  // Probe: apply a yaw, step once from rest, see which way we moved.
  return Math.atan2(-dx, -dz);
}

function walk(R, up, laneFrac = 0.5) {
  const o = R.run.opts;
  const cMid = R.cLo + (R.cHi - R.cLo) * laneFrac;
  const startA = up
    ? (R.asc ? R.aLo - RADIUS - 0.15 : R.aHi + RADIUS + 0.15)
    : (R.asc ? R.aHi + RADIUS + 0.15 : R.aLo - RADIUS - 0.15);
  const goalA = up
    ? (R.asc ? R.aHi + RADIUS + 0.15 : R.aLo - RADIUS - 0.15)
    : (R.asc ? R.aLo - RADIUS - 0.15 : R.aHi + RADIUS + 0.15);
  const sy = up ? (isFinite(R.m.floorBottom) ? R.m.floorBottom : o.y0)
                : (isFinite(R.m.floorTop) ? R.m.floorTop : o.y1);
  const sp = R.alongX ? { x: startA, z: cMid } : { x: cMid, z: startA };
  const dx = R.alongX ? Math.sign(goalA - startA) : 0;
  const dz = R.alongX ? 0 : Math.sign(goalA - startA);

  p.position.set(sp.x, sy + 0.05, sp.z);
  p.velocity.set(0, 0, 0);
  p.baseYaw = yawFor(dx, dz);
  p.basePitch = 0;
  p.recoilYaw = 0; p.recoilPitch = 0; p.scopeSwayYaw = 0; p.scopeSwayPitch = 0;
  p._writeAngles();
  p.height = STAND;
  p.grounded = true;
  p.health = p.maxHealth ?? 100;
  p.moveState = 'walk';

  const targetY = up ? Math.max(o.y0, o.y1) : Math.min(o.y0, o.y1);
  let best = -Infinity, stuckAt = null, reached = false, maxDrop = 0;
  let prevY = p.position.y;
  const trace = [];

  for (let t = 0; t < 420; t++) {
    const cmd = emptyCommand();
    cmd.wishForward = 1;
    cmd.baseYaw = p.baseYaw;
    cmd.basePitch = 0;
    cmd.tick = t;
    // Held state is the command's, verbatim — exactly what GameServer._applyCommand does.
    // `_refreshHeldState` returns early with no input device, so nothing else sets it and
    // without this the player stands still for 420 ticks and every stair reads "STUCK".
    p._held.wishForward = 1;
    p._held.wishRight = 0;
    p._held.sprintKeyHeld = false;
    p._held.crouchHeld = false;
    p.applyCommand(cmd);
    p.fixedUpdate?.(FIXED_DT);
    const a = R.alongX ? p.position.x : p.position.z;
    const prog = (goalA - startA) > 0 ? a - startA : startA - a;
    const drop = prevY - p.position.y;
    if (drop > maxDrop) maxDrop = drop;
    prevY = p.position.y;
    trace.push({ t, a: +a.toFixed(3), y: +p.position.y.toFixed(3), st: p.moveState, c: +p.position[R.C].toFixed(3), g: p.grounded ? 1 : 0, v: +Math.hypot(p.velocity.x, p.velocity.z).toFixed(2) });
    if (prog > best) { best = prog; stuckAt = { a, y: p.position.y, t }; }
    const done = (goalA - startA) > 0 ? a >= goalA - 0.05 : a <= goalA + 0.05;
    if (done && Math.abs(p.position.y - targetY) < 0.6) { reached = true; break; }
    if (p.position.y < Math.min(o.y0, o.y1) - 1.5) break;   // fell off
  }
  // What stopped us? Sweep the capsule 0.5 m further along the run from the stall
  // point and name every collider it hits — that is the box to edit in level.js.
  let blockers = [];
  if (!reached && stuckAt) {
    const dir = Math.sign(goalA - startA);
    const a = stuckAt.a + dir * (RADIUS + 0.08);
    const q = R.alongX ? { x: a, z: cMid } : { x: cMid, z: a };
    for (const yOff of [0.02, 0.30, 0.60, 1.00, 1.50]) {
      for (const i of overlaps(q.x, stuckAt.y + yOff, q.z, 0.05)) {
        if (!blockers.some((b) => b.i === i)) {
          const b = B[i];
          blockers.push({
            i, yOff,
            box: `x[${b.min.x.toFixed(2)},${b.max.x.toFixed(2)}] y[${b.min.y.toFixed(2)},${b.max.y.toFixed(2)}] z[${b.min.z.toFixed(2)},${b.max.z.toFixed(2)}] ${b.surface}`,
            own: R.own.has(i),
          });
        }
      }
    }
  }
  // `maxDrop` was computed and never asserted, so a descent that FELL down the stairwell
  // counted as "walked down". A tread is 0.22 m; anything past half a metre in one step is
  // a fall, not a step.
  const fell = maxDrop > 0.5;
  return { reached, best, stuckAt, maxDrop, fell, endY: p.position.y, trace, blockers, dir: Math.sign(goalA - startA), lane: cMid, span: Math.abs(goalA - startA) };
}

// Three lanes, not one. A stair with an AC unit or a market stall dumped on half of it
// is passable down the free side and impassable down the middle — reporting only the
// centreline would call it broken, reporting only the best lane would call it fine.
// Both facts matter, so both are recorded.
const LANES = [0.22, 0.5, 0.78];
for (const R of analyses) {
  try {
    const ups = LANES.map((f) => ({ f, w: walk(R, true, f) }));
    const dns = LANES.map((f) => ({ f, w: walk(R, false, f) }));
    const pick = (arr) => arr.find((e) => e.w.reached) || arr.reduce((p, q) => (q.w.best > p.w.best ? q : p));
    R.upAll = ups; R.downAll = dns;
    R.up = pick(ups).w; R.upLane = pick(ups).f;
    R.down = pick(dns).w; R.downLane = pick(dns).f;
    // A lane only counts if it walked the run — not if it FELL down it. `maxDrop` was
    // recorded and never used, so a descent that dropped off the side scored as a success.
    R.upLanesOK = ups.filter((e) => e.w.reached && !e.w.fell).length;
    R.downLanesOK = dns.filter((e) => e.w.reached && !e.w.fell).length;
    R.fellUp = ups.filter((e) => e.w.fell).length;
    R.fellDown = dns.filter((e) => e.w.fell).length;
  } catch (e) {
    R.walkError = e.message;
  }
}

// ────────────────────────────────────────────────────────────────────── nav path

const nav = game.nav && game.nav.ready ? game.nav : null;
const _pathOut = [];

function navCheck(R) {
  if (!nav) return { error: 'nav not baked' };
  const cMid = (R.cLo + R.cHi) / 2;
  const o = R.run.opts;
  const botA = R.asc ? R.aLo - 0.8 : R.aHi + 0.8;
  const topA = R.asc ? R.aHi + 0.8 : R.aLo - 0.8;
  const yb = isFinite(R.m.floorBottom) ? R.m.floorBottom : o.y0;
  const yt = isFinite(R.m.floorTop) ? R.m.floorTop : o.y1;
  const b = R.alongX ? new THREE.Vector3(botA, yb + 0.1, cMid) : new THREE.Vector3(cMid, yb + 0.1, botA);
  const t = R.alongX ? new THREE.Vector3(topA, yt + 0.1, cMid) : new THREE.Vector3(cMid, yt + 0.1, topA);
  const out = {};
  try {
    out.bottomNode = nav.nodeAt(b.x, b.y, b.z);
    out.topNode = nav.nodeAt(t.x, t.y, t.z);
    // Does the grid even KNOW about the treads? A detour-free path is not proof the AI
    // uses the stair; a walkable node standing on each tread is.
    let covered = 0;
    for (const tr of R.treads) {
      const a = (tr.a0 + tr.a1) / 2;
      const q = R.alongX ? { x: a, z: cMid } : { x: cMid, z: a };
      const n = nav.nodeAt(q.x, tr.top + 0.1, q.z);
      if (n >= 0 && nav.isWalkable(n)) covered++;
    }
    out.treadNodes = covered;
    out.treads = R.treads.length;

    // Where does the chain actually break? Walk the treads in ascending order and path
    // between neighbours; the first pair that needs a long way round names the tread
    // whose nav link is missing.
    const seq = R.treads.slice().sort((u, v) => u.top - v.top);
    const pt = (tr) => {
      const a = (tr.a0 + tr.a1) / 2;
      return R.alongX ? new THREE.Vector3(a, tr.top + 0.1, cMid) : new THREE.Vector3(cMid, tr.top + 0.1, a);
    };
    // Path from the foot to EACH tread in turn. Comparing neighbouring treads directly
    // gives false alarms — two treads 0.38 m apart often share one 0.75 m nav column, and
    // two layers of one column are never linked to each other. Pathing from the foot each
    // time asks the question that matters: how far up the run can the AI actually get?
    // Anchored on the FIRST TREAD, not on the floor in front of it: if the foot probe
    // happens to land on an unwalkable cell the whole run would look unreachable for a
    // reason that has nothing to do with the stair.
    const anchor = pt(seq[0]);
    out.reachTread = 0;
    for (let k = 1; k < seq.length; k++) {
      const n = nav.findPath(anchor, pt(seq[k]), _pathOut);
      const stray = n > 0 ? strayDist(R, _pathOut, n) : Infinity;
      if (stray > 3) break;
      out.reachTread = k;
    }
    // Separately: can the AI get ONTO the run from the floor at all, and onto which tread?
    out.floorWalkable = out.bottomNode >= 0 && nav.isWalkable(out.bottomNode);
    out.entryTread = -1;
    for (let k = 0; k < seq.length; k++) {
      const n = nav.findPath(b, pt(seq[k]), _pathOut);
      if (n > 0 && strayDist(R, _pathOut, n) <= 3) { out.entryTread = k; break; }
    }
    out.firstBadTread = out.reachTread + 1 < seq.length ? {
      k: out.reachTread + 1,
      y: seq[out.reachTread + 1].top,
      a: (seq[out.reachTread + 1].a0 + seq[out.reachTread + 1].a1) / 2,
    } : null;
    // A path is only evidence the STAIR works if it stays near the stair. A long
    // detour round the building would read as success and hide the hole.
    const nUp = nav.findPath(b, t, _pathOut);
    out.up = nUp > 0;
    out.upLen = nUp;
    out.upDetour = nUp > 0 ? pathLength(_pathOut, nUp) / Math.max(0.1, b.distanceTo(t)) : Infinity;
    out.upStrays = nUp > 0 ? strayDist(R, _pathOut, nUp) : Infinity;
    const nDn = nav.findPath(t, b, _pathOut);
    out.down = nDn > 0;
    out.downLen = nDn;
    out.downDetour = nDn > 0 ? pathLength(_pathOut, nDn) / Math.max(0.1, b.distanceTo(t)) : Infinity;
  } catch (e) { out.error = e.message; }
  return out;
}

/**
 * How far the path wanders outside the stair's own footprint. A path that exists is not
 * a path that uses the STAIR — the A* will happily route round a building — so this is
 * the number that says whether the AI can actually climb this run.
 */
function strayDist(R, pts, n) {
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const dA = Math.max(R.aLo - p[R.A], p[R.A] - R.aHi, 0);
    const dC = Math.max(R.cLo - p[R.C], p[R.C] - R.cHi, 0);
    worst = Math.max(worst, Math.hypot(dA, dC));
  }
  return worst;
}

function pathLength(pts, n) {
  let d = 0;
  for (let i = 1; i < n; i++) d += pts[i].distanceTo(pts[i - 1]);
  return d;
}
for (const R of analyses) R.nav = navCheck(R);

// ───────────────────────────────────────────────────────────────────────── report

const NAMES = new Map(); // filled by caller expectations; label falls back to line no.

const label = (R) => {
  const o = R.run.opts;
  return `${R.run.kind}@L${R.run.line} ${R.alongX ? 'x' : 'z'}${R.asc ? '+' : '-'} ` +
    `[${R.aLo.toFixed(1)}..${R.aHi.toFixed(1)}] ${R.alongX ? 'z' : 'x'}[${R.cLo.toFixed(1)}..${R.cHi.toFixed(1)}] ` +
    `y ${o.y0.toFixed(2)}→${o.y1.toFixed(2)}`;
};

console.log(`\n${RUNS.length} stair/ramp runs, ${B.length} world colliders\n`);
const hdr = ['line', 'kind', 'axis', 'y0→y1', 'n', 'maxRise', 'going', 'gap', 'width', 'clear', 'head', 'botLip', 'topΔ', 'up', 'down'];
console.log(hdr.join('\t'));
for (const R of analyses) {
  const o = R.run.opts;
  console.log([
    R.run.line, R.run.kind, `${R.alongX ? 'x' : 'z'}${R.asc ? '+' : '-'}`,
    `${o.y0.toFixed(2)}→${o.y1.toFixed(2)}`,
    R.m.steps,
    R.m.maxRise.toFixed(3),
    R.m.going.toFixed(3),
    R.m.maxGap.toFixed(3),
    R.m.nominalWidth.toFixed(2),
    isFinite(R.m.clearWidth) ? R.m.clearWidth.toFixed(3) : 'inf',
    isFinite(R.m.headroom) ? R.m.headroom.toFixed(2) : 'inf',
    R.m.bottomLip.toFixed(3),
    R.m.topStep.toFixed(3),
    R.up ? (R.up.reached ? `OK${R.upLanesOK}/3` : `STUCK@${R.up.best.toFixed(2)}/${R.up.span.toFixed(2)}`) : '?',
    R.down ? (R.down.reached ? `OK${R.downLanesOK}/3` : `STUCK@${R.down.best.toFixed(2)}/${R.down.span.toFixed(2)}`) : '?',
  ].join('\t'));
}

console.log('\n── findings ──');
let nFail = 0, nWarn = 0, nClean = 0;
for (const R of analyses) {
  const fails = R.fail.slice();
  const warns = R.warn.slice();
  const stall = (w, dirName) => {
    if (!w || w.reached) return;
    fails.push(`WALK ${dirName} failed: stalled at ${w.best.toFixed(2)} of ${w.span.toFixed(2)} m, y=${w.stuckAt?.y.toFixed(2)}`);
    for (const b of w.blockers.slice(0, 4)) {
      fails.push(`     blocked by box #${b.i}${b.own ? ' (the stair itself)' : ''} at +${b.yOff.toFixed(2)} above the feet: ${b.box}`);
    }
  };
  stall(R.up, 'UP');
  stall(R.down, 'DOWN');
  if (R.up?.reached && R.upLanesOK < LANES.length) warns.push(`only ${R.upLanesOK}/${LANES.length} lanes walk UP (clear lane at ${(R.upLane * 100) | 0}% of the width)`);
  if (R.down?.reached && R.downLanesOK < LANES.length) warns.push(`only ${R.downLanesOK}/${LANES.length} lanes walk DOWN (clear lane at ${(R.downLane * 100) | 0}% of the width)`);
  if (R.walkError) fails.push(`walk harness error: ${R.walkError}`);
  if (R.nav && R.nav.up === false) fails.push('nav: no AI path bottom→top');
  else if (R.nav && R.nav.upStrays > 4) fails.push(`nav: the bottom→top path leaves the stair by ${R.nav.upStrays.toFixed(1)} m (detour ×${R.nav.upDetour.toFixed(1)}) — the AI routes AROUND rather than up this run`);
  else if (R.nav && R.nav.upDetour > 3) warns.push(`nav: bottom→top path detours ×${R.nav.upDetour.toFixed(1)}`);
  if (R.nav && R.nav.treadNodes !== undefined && R.nav.treadNodes < R.nav.treads) {
    const miss = R.nav.treads - R.nav.treadNodes;
    (R.nav.treadNodes === 0 ? fails : warns).push(
      `nav: ${miss}/${R.nav.treads} treads have no walkable nav node — the AI cannot use ${R.nav.treadNodes === 0 ? 'this stair at all' : 'the whole run'}`);
  }
  if (R.nav && R.nav.down === false) fails.push('nav: no AI path top→bottom');
  else if (R.nav && R.nav.downDetour > 3) warns.push(`nav: top→bottom path detours ×${R.nav.downDetour.toFixed(1)}`);
  if (R.nav && R.nav.error) warns.push(`nav: ${R.nav.error}`);
  if (!fails.length && !warns.length) { nClean++; console.log(`  CLEAN  ${label(R)}`); continue; }
  nFail += fails.length; nWarn += warns.length;
  console.log(`  ${fails.length ? 'FAIL' : 'warn'}   ${label(R)}`);
  for (const f of fails) console.log(`         ✗ ${f}`);
  for (const w of warns) console.log(`         · ${w}`);
  if (VERBOSE) {
    console.log(`         rises: ${R.m.rises.map((r) => r.toFixed(3)).join(' ')}`);
    if (R.m.headAt) console.log(`         tightest headroom at a=${R.m.headAt.a.toFixed(2)} y=${R.m.headAt.y.toFixed(2)} ceiling=${R.m.headAt.cy.toFixed(2)} (box #${R.m.headAt.ci})`);
    if (R.m.clearAt) console.log(`         narrowest lane at a=${R.m.clearAt.aMid.toFixed(2)}: [${R.m.clearAt.lo.toFixed(2)}..${R.m.clearAt.hi.toFixed(2)}]`);
    if (R.nav) {
      console.log(`         nav: floor node at the foot ${R.nav.floorWalkable ? 'is walkable' : 'is NOT walkable'}; first tread the AI can step onto from the floor: ${R.nav.entryTread >= 0 ? `#${R.nav.entryTread + 1}` : 'NONE'}`);
    }
    if (R.nav?.firstBadTread) {
      console.log(`         nav reaches tread ${R.nav.reachTread + 1}/${R.nav.treads} from the foot; first unreachable tread is #${R.nav.firstBadTread.k + 1} at ${R.C === 'x' ? 'z' : 'x'}=${R.nav.firstBadTread.a.toFixed(2)}, top y=${R.nav.firstBadTread.y.toFixed(2)}`);
    }
    for (const [dirName, all] of [['UP', R.upAll], ['DOWN', R.downAll]]) {
      if (!all) continue;
      console.log(`         ${dirName} per lane: ${all.map((e) => `${(e.f * 100) | 0}%→${e.w.reached ? 'OK' : `stall a=${e.w.stuckAt.a.toFixed(2)} y=${e.w.stuckAt.y.toFixed(2)}`}`).join('  ')}`);
    }
    for (const w of [R.up, R.down]) {
      if (!w || w.reached) continue;
      console.log(`         last 8 samples: ${w.trace.slice(-8).map((s) => `a=${s.a} ${R.C}=${s.c} y=${s.y} ${s.st} v=${s.v}`).join('  ')}`);
      if (w.blockers.length) continue;
      // Exactly the volume the solver sweeps through: the standing capsule's AABB at
      // the stall point, extended 0.6 m along the direction of travel.
      const lane = R.cLo + (R.cHi - R.cLo) * (w === R.up ? R.upLane : R.downLane);
      const d = w.dir;
      const aLo2 = Math.min(w.stuckAt.a - RADIUS, w.stuckAt.a + d * 0.6 - RADIUS);
      const aHi2 = Math.max(w.stuckAt.a + RADIUS, w.stuckAt.a + d * 0.6 + RADIUS);
      console.log(`         stalled with nothing 0.44 m ahead — feet y=${w.stuckAt.y.toFixed(3)}, a=${w.stuckAt.a.toFixed(3)}, lane ${R.C}=${lane.toFixed(2)}; solids in the swept volume:`);
      // Ask the solver itself rather than re-deriving its rules: place the capsule at the
      // stall point, push it 1 m along the run, and report what it actually did.
      {
        const pos = new THREE.Vector3();
        const vel = new THREE.Vector3();
        pos[R.A] = w.stuckAt.a; pos[R.C] = lane; pos.y = w.stuckAt.y;
        vel[R.A] = d * 4;
        const res = world.move(pos, vel, RADIUS, STAND, 1 / 120);
        console.log(`            world.move() from there → moved ${(res.position[R.A] - w.stuckAt.a).toFixed(5)} m, grounded=${res.grounded}, y=${res.position.y.toFixed(3)}`);
        const q = new THREE.Vector3(); q.copy(pos); q[R.A] += d * 0.5;
        for (let i = 0; i < B.length; i++) {
          const b = B[i];
          if (b.min.x >= q.x + RADIUS || b.max.x <= q.x - RADIUS) continue;
          if (b.min.z >= q.z + RADIUS || b.max.z <= q.z - RADIUS) continue;
          if (b.min.y >= q.y + STAND || b.max.y <= q.y) continue;
          console.log(`            OVERLAP 0.5 m ahead: #${i} x[${b.min.x.toFixed(2)},${b.max.x.toFixed(2)}] y[${b.min.y.toFixed(2)},${b.max.y.toFixed(2)}] z[${b.min.z.toFixed(2)},${b.max.z.toFixed(2)}] ${b.surface}${R.own.has(i) ? ' (stair)' : ''}`);
        }
      }
      for (let i = 0; i < B.length; i++) {
        const b = B[i];
        if (b.max[R.A] <= aLo2 || b.min[R.A] >= aHi2) continue;
        if (b.max[R.C] <= lane - RADIUS || b.min[R.C] >= lane + RADIUS) continue;
        if (b.max.y <= w.stuckAt.y || b.min.y >= w.stuckAt.y + STAND) continue;
        console.log(`            #${i} x[${b.min.x.toFixed(2)},${b.max.x.toFixed(2)}] y[${b.min.y.toFixed(2)},${b.max.y.toFixed(2)}] z[${b.min.z.toFixed(2)},${b.max.z.toFixed(2)}] ${b.surface}${R.own.has(i) ? ' (stair)' : ''}`);
      }
    }
  }
}
console.log(`\n${nClean} clean, ${nFail} failures, ${nWarn} warnings across ${analyses.length} runs`);
process.exit(nFail ? 1 : 0);
