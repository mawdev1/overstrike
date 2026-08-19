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
 *   NAV       Cross-checks navGrid: can the AI path bottom→top and top→bottom?
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

const box = (i) => B[i];
const ov = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);

/** Highest solid top face under (x,z) strictly below `yMax`, ignoring a set of indices. */
function groundUnder(x, z, yMax, skip, r = RADIUS) {
  let best = -Infinity, bi = -1;
  for (let i = 0; i < B.length; i++) {
    if (skip && skip.has(i)) continue;
    const b = B[i];
    if (b.max.y > yMax + 1e-6) continue;
    if (!(b.min.x < x + r - 1e-6 && b.max.x > x - r + 1e-6)) continue;
    if (!(b.min.z < z + r - 1e-6 && b.max.z > z - r + 1e-6)) continue;
    if (b.max.y > best) { best = b.max.y; bi = i; }
  }
  return { y: best, i: bi };
}

/** Lowest solid bottom face above `yMin` over the capsule footprint at (x,z). */
function ceilingAbove(x, z, yMin, skip, r = RADIUS) {
  let best = Infinity, bi = -1;
  for (let i = 0; i < B.length; i++) {
    if (skip && skip.has(i)) continue;
    const b = B[i];
    if (b.min.y < yMin - 1e-6) continue;        // starts below the feet — not a ceiling
    if (!(b.min.x < x + r - 1e-6 && b.max.x > x - r + 1e-6)) continue;
    if (!(b.min.z < z + r - 1e-6 && b.max.z > z - r + 1e-6)) continue;
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

  // ── 5. clear width (rails/stringers/walls eating the run) ──────────────────
  // Sample the free cross-axis span at mid-height of each tread.
  let minClear = Infinity, clearAt = null;
  for (const t of treads) {
    const aMid = (t.a0 + t.a1) / 2;
    const y = t.top + 0.05;
    let lo = R.cLo, hi = R.cHi;
    for (let i = 0; i < B.length; i++) {
      if (own.has(i)) continue;
      const b = B[i];
      if (!(b.min[A] < aMid - 1e-6 && b.max[A] > aMid + 1e-6)) continue;
      if (!(b.min.y < y + STAND - 1e-6 && b.max.y > y + 1e-6)) continue;
      const bl = b.min[C], bh = b.max[C];
      if (bh > lo && bh < (lo + hi) / 2) lo = bh;
      if (bl < hi && bl > (lo + hi) / 2) hi = bl;
    }
    const w = hi - lo;
    if (w < minClear) { minClear = w; clearAt = { aMid, lo, hi, y }; }
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
  const gBot = groundUnder(fp.x, fp.z, o.y0 + MAX_STEP + 0.5, own);
  R.m.floorBottom = gBot.y;
  R.m.bottomLip = first.top - gBot.y;        // first tread top relative to the floor
  if (!isFinite(gBot.y)) R.fail.push('no floor at the foot of the run');
  else if (R.m.bottomLip > MAX_STEP + 1e-6) R.fail.push(`first tread is ${R.m.bottomLip.toFixed(3)} above the floor it starts from`);
  else if (R.m.bottomLip < -0.02) R.warn.push(`first tread is buried ${(-R.m.bottomLip).toFixed(3)} below the start floor`);

  // Top: the floor just BEYOND the head of the run.
  const headA = asc ? R.aHi + RADIUS + 0.05 : R.aLo - RADIUS - 0.05;
  const hp = alongX ? { x: headA, z: cMid } : { x: cMid, z: headA };
  const gTop = groundUnder(hp.x, hp.z, o.y1 + MAX_STEP + 0.5, own);
  R.m.floorTop = gTop.y;
  R.m.topStep = gTop.y - last.top;           // destination slab relative to the last tread
  if (!isFinite(gTop.y)) R.fail.push('no floor at the head of the run — the top tread lands on nothing');
  else if (Math.abs(R.m.topStep) > 1e-3) {
    if (R.m.topStep > MAX_STEP + 1e-6) R.fail.push(`top tread undershoots the landing by ${R.m.topStep.toFixed(3)} (> MAX_STEP)`);
    else if (R.m.topStep < -MAX_STEP - 1e-6) R.fail.push(`top tread overshoots the landing by ${(-R.m.topStep).toFixed(3)} (> MAX_STEP drop)`);
    else R.warn.push(`landing mismatch ${R.m.topStep >= 0 ? '+' : ''}${R.m.topStep.toFixed(3)} m at the head`);
  }

  // ── 4. headroom along the whole path ───────────────────────────────────────
  let minHead = Infinity, headAt = null;
  const probes = [];
  probes.push({ a: footA, y: gBot.y });
  for (const t of ordered) probes.push({ a: (t.a0 + t.a1) / 2, y: t.top });
  probes.push({ a: headA, y: isFinite(gTop.y) ? gTop.y : o.y1 });
  for (const p of probes) {
    const q = alongX ? { x: p.a, z: cMid } : { x: cMid, z: p.a };
    const c = ceilingAbove(q.x, q.z, p.y + 0.02, own);
    const h = c.y - p.y;
    if (h < minHead) { minHead = h; headAt = { ...p, ci: c.i, cy: c.y }; }
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

function walk(R, up) {
  const o = R.run.opts;
  const cMid = (R.cLo + R.cHi) / 2;
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
  p.yaw = yawFor(dx, dz);
  p.pitch = 0;
  p.height = STAND;
  p.grounded = true;
  p._dead = false;
  p.health = p.maxHealth ?? 100;

  const targetY = up ? Math.max(o.y0, o.y1) : Math.min(o.y0, o.y1);
  let best = -Infinity, stuckAt = null, reached = false, maxDrop = 0;
  let prevY = p.position.y;
  const trace = [];

  for (let t = 0; t < 420; t++) {
    const cmd = emptyCommand();
    cmd.wishForward = 1;
    cmd.baseYaw = p.yaw;
    cmd.basePitch = 0;
    cmd.tick = t;
    p.applyCommand(cmd, FIXED_DT);
    p.fixedUpdate?.(FIXED_DT);
    const a = R.alongX ? p.position.x : p.position.z;
    const prog = (goalA - startA) > 0 ? a - startA : startA - a;
    const drop = prevY - p.position.y;
    if (drop > maxDrop) maxDrop = drop;
    prevY = p.position.y;
    trace.push({ t, a: +a.toFixed(3), y: +p.position.y.toFixed(3) });
    if (prog > best) { best = prog; stuckAt = { a, y: p.position.y, t }; }
    const done = (goalA - startA) > 0 ? a >= goalA - 0.05 : a <= goalA + 0.05;
    if (done && Math.abs(p.position.y - targetY) < 0.6) { reached = true; break; }
    if (p.position.y < Math.min(o.y0, o.y1) - 1.5) break;   // fell off
  }
  return { reached, best, stuckAt, maxDrop, endY: p.position.y, trace, span: Math.abs(goalA - startA) };
}

for (const R of analyses) {
  try {
    R.up = walk(R, true);
    R.down = walk(R, false);
  } catch (e) {
    R.walkError = e.message;
  }
}

// ────────────────────────────────────────────────────────────────────── nav path

let nav = null;
try {
  nav = game.world.nav || game.nav || game.bots?.nav || null;
} catch { /* ignore */ }

function navCheck(R) {
  if (!nav) return null;
  const cMid = (R.cLo + R.cHi) / 2;
  const o = R.run.opts;
  const botA = R.asc ? R.aLo - 0.6 : R.aHi + 0.6;
  const topA = R.asc ? R.aHi + 0.6 : R.aLo - 0.6;
  const b = R.alongX ? new THREE.Vector3(botA, o.y0 + 0.1, cMid) : new THREE.Vector3(cMid, o.y0 + 0.1, botA);
  const t = R.alongX ? new THREE.Vector3(topA, o.y1 + 0.1, cMid) : new THREE.Vector3(cMid, o.y1 + 0.1, topA);
  const out = {};
  try {
    const nb = nav.nodeAt?.(b) ?? nav.nearestNode?.(b);
    const nt = nav.nodeAt?.(t) ?? nav.nearestNode?.(t);
    out.bottomNode = nb; out.topNode = nt;
    const path = nav.findPath?.(b, t);
    out.up = !!(path && (path.length ?? path.nodes?.length));
    const back = nav.findPath?.(t, b);
    out.down = !!(back && (back.length ?? back.nodes?.length));
  } catch (e) { out.error = e.message; }
  return out;
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
    R.up ? (R.up.reached ? 'OK' : `STUCK@${R.up.best.toFixed(2)}/${R.up.span.toFixed(2)}`) : '?',
    R.down ? (R.down.reached ? 'OK' : `STUCK@${R.down.best.toFixed(2)}/${R.down.span.toFixed(2)}`) : '?',
  ].join('\t'));
}

console.log('\n── findings ──');
let nFail = 0, nWarn = 0, nClean = 0;
for (const R of analyses) {
  const fails = R.fail.slice();
  const warns = R.warn.slice();
  if (R.up && !R.up.reached) fails.push(`WALK UP failed: stalled at ${R.up.best.toFixed(2)} of ${R.up.span.toFixed(2)} m, y=${R.up.stuckAt?.y.toFixed(2)}`);
  if (R.down && !R.down.reached) fails.push(`WALK DOWN failed: stalled at ${R.down.best.toFixed(2)} of ${R.down.span.toFixed(2)} m, y=${R.down.stuckAt?.y.toFixed(2)}`);
  if (R.walkError) fails.push(`walk harness error: ${R.walkError}`);
  if (R.nav && R.nav.up === false) fails.push('nav: no AI path bottom→top');
  if (R.nav && R.nav.down === false) fails.push('nav: no AI path top→bottom');
  if (!fails.length && !warns.length) { nClean++; console.log(`  CLEAN  ${label(R)}`); continue; }
  nFail += fails.length; nWarn += warns.length;
  console.log(`  ${fails.length ? 'FAIL' : 'warn'}   ${label(R)}`);
  for (const f of fails) console.log(`         ✗ ${f}`);
  for (const w of warns) console.log(`         · ${w}`);
  if (VERBOSE) {
    console.log(`         rises: ${R.m.rises.map((r) => r.toFixed(3)).join(' ')}`);
    if (R.m.headAt) console.log(`         tightest headroom at a=${R.m.headAt.a.toFixed(2)} y=${R.m.headAt.y.toFixed(2)} ceiling=${R.m.headAt.cy.toFixed(2)} (box #${R.m.headAt.ci})`);
    if (R.m.clearAt) console.log(`         narrowest lane at a=${R.m.clearAt.aMid.toFixed(2)}: [${R.m.clearAt.lo.toFixed(2)}..${R.m.clearAt.hi.toFixed(2)}]`);
  }
}
console.log(`\n${nClean} clean, ${nFail} failures, ${nWarn} warnings across ${analyses.length} runs`);
process.exit(nFail ? 1 : 0);
