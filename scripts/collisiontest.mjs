/**
 * PLAYER COLLISION INTEGRITY.
 *
 * `maptest.mjs` proves bullets cannot pass through walls. Nothing proved that PLAYERS
 * cannot. This does.
 *
 * Everything below drives the REAL solver (`world.move`, via `Player.fixedUpdate` on the
 * real 1/120 fixed step) against the REAL collider set, booted headlessly. No hand-rolled
 * integrator, no synthetic geometry.
 *
 * Failure classes are kept distinct, because they have different causes and fixes:
 *
 *   THROUGH           the body ended up fully on the far side of the box it was driven at,
 *                     without going over the top or under the bottom
 *   INSIDE            the body's AABB overlaps a collider by more than the solver's skin
 *   STUCK             …and 1 s of movement in 8 directions cannot get it out
 *   WRONG-SIDE        the depenetrator ejected the body through the OPPOSITE face of a
 *                     collider at least as thick as the body
 *   OOB               the body left `world.bounds`, or ended up under the world floor
 *   CROUCH-FIT        a gap shorter than the crouched body admitted it
 *   SLIT              a gap narrower than the body admitted it
 *
 * Two classes are reported but do NOT fail the run, because they are inherent rather than
 * defects in the solver — read the notes on each:
 *
 *   MANTLE-TRANSIENT  `_mantleStep` is a scripted lerp with no collision, so a vault puts
 *                     the body briefly inside the ledge. Measured, bounded, self-recovering.
 *   THIN-WALL-EJECT   a collider thinner than the 0.72 m body has no "correct" side to be
 *                     pushed out to once the body is centred on it.
 *
 * Tests: tunnel, corner, mantle, slide, stance, fall, escape, crouch, depen, slit.
 *
 *   node scripts/collisiontest.mjs [--quick] [--only=tunnel,mantle,…] [--verbose]
 */
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';

const argv = process.argv.slice(2);
const has = (k) => argv.includes(`--${k}`);
const val = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const QUICK = has('quick');
const VERBOSE = has('verbose');
const ONLY = val('only', '').split(',').filter(Boolean);
const want = (n) => ONLY.length === 0 || ONLY.includes(n);

const FIXED_DT = 1 / 120;
const RADIUS = 0.36;
const STAND = 1.8;
const CROUCH = 1.1;
/** Overlap deeper than this is a real interpenetration, not solver skin. */
const PEN_TOL = 0.02;

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };

// ── boot ─────────────────────────────────────────────────────────────────────────────
const game = new Game({ headless: true });
await game.initHeadless({ presenter: new NullPresenter() });
game.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 1234 });
game.match.phase = 'live';
game.match.countdown = 0;

const world = game.world;
const boxes = world.boxes;
const player = game.player;
const bounds = world.bounds;

console.log(`\nplayer collision integrity — ${boxes.length} colliders, `
  + `bounds x[${bounds.min.x.toFixed(1)},${bounds.max.x.toFixed(1)}] `
  + `y[${bounds.min.y.toFixed(1)},${bounds.max.y.toFixed(1)}] `
  + `z[${bounds.min.z.toFixed(1)},${bounds.max.z.toFixed(1)}]`);

// ── collider census ──────────────────────────────────────────────────────────────────
//
// Why tunnelling is bounded in principle, stated in numbers: the solver caps a substep at
// SUBSTEP_DIST = 0.4 m and sweeps each axis analytically inside it, so it can only miss a
// collider thinner than one substep's travel. Top speeds are 11 u/s horizontal
// (AIR_MAX_SPEED) and 60 u/s vertical (TERMINAL) → 0.092 m and 0.500 m per 1/120 s tick.
{
  let thinnest = Infinity, underTravel = 0;
  for (const b of boxes) {
    const t = Math.min(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
    if (t < thinnest) thinnest = t;
    if (t < 0.4) underTravel++;
  }
  console.log(`  thinnest collider ${thinnest.toFixed(3)} m; ${underTravel} of ${boxes.length} `
    + `are thinner than one 0.4 m substep. Max per-tick travel: 0.092 m horizontal, `
    + `0.500 m vertical.`);
}

// ── the harness ──────────────────────────────────────────────────────────────────────

const EMPTY_CMD = {
  wishForward: 0, wishRight: 0,
  jump: false, crouchPressed: false, reload: false, melee: false, grenade: false,
  interact: false, inspect: false, killstreak: false, lastWeapon: false,
  sprintDown: false, sprintUp: false, firePressed: false, aimButtonPressed: false,
  crouchHeld: false, toggleAdsMode: false, aimButtonHeld: false, fireHeld: false,
  sprintKeyHeld: false, breathHold: false, leanKeyHeld: false, leanRightKeyHeld: false,
  slot: -1, wheel: 0, deltaYaw: 0, deltaPitch: 0,
};
const cmd = { ...EMPTY_CMD };
const resetCmd = () => Object.assign(cmd, EMPTY_CMD);

/** Put the player somewhere with a known stance/state. Never touches the world. */
function place(x, y, z, { yaw = 0, height = STAND, vel = null, grounded = false, state = 'air' } = {}) {
  player.alive = true;
  player.health = player.maxHealth;
  player.position.set(x, y, z);
  player.velocity.set(0, 0, 0);
  if (vel) player.velocity.set(vel.x, vel.y, vel.z);
  player.height = height;
  player.eyeHeight = height === CROUCH ? 0.95 : 1.62;
  player.eyeSmooth = player.eyeHeight;
  player.eyeStep = 0; player.eyeLand = 0; player.eyeLandVel = 0;
  player.crouchHeld = false;
  player.crouchFrac = height === CROUCH ? 1 : 0;
  player.grounded = grounded;
  player.moveState = state;
  player.slideTimer = 0; player.slideAmount = 0;
  player.sprinting = false; player.sprintRamp = 0;
  player.lean = 0;
  player._airPeakY = y;
  player._lastGroundedAt = grounded ? game.time : -99;
  player._jumpBufferAt = -99;
  player._slideCooldownUntil = -99;
  player._mantleCooldownUntil = -99;
  player._mantleUsedInAir = false;
  player._mantleT = 0;
  player.setAngles(yaw, 0);
  Object.assign(player._held, {
    wishForward: 0, wishRight: 0, crouchHeld: false, toggleAdsMode: false,
    aimButtonHeld: false, fireHeld: false, sprintKeyHeld: false, breathHold: false,
    leanKeyHeld: false, leanRightKeyHeld: false,
  });
  resetCmd();
}

/** One real fixed tick. `held` is merged into the player's held state first. */
function tick(held) {
  if (held) Object.assign(player._held, held);
  game.tick++;
  player.applyCommand(cmd);
  resetCmd();
  player.fixedUpdate(FIXED_DT);
}

// ── penetration queries ──────────────────────────────────────────────────────────────

/** How deep the player's AABB is inside box `b`, in metres (0 = not overlapping). */
function depthIn(b, p = player.position, h = player.height) {
  const ox = Math.min(p.x + RADIUS, b.max.x) - Math.max(p.x - RADIUS, b.min.x);
  if (ox <= 0) return 0;
  const oy = Math.min(p.y + h, b.max.y) - Math.max(p.y, b.min.y);
  if (oy <= 0) return 0;
  const oz = Math.min(p.z + RADIUS, b.max.z) - Math.max(p.z, b.min.z);
  if (oz <= 0) return 0;
  return Math.min(ox, oy, oz);
}

/** Deepest collider the player is currently inside, or null. Uses the real broadphase. */
function insideAny(tol = PEN_TOL) {
  const p = player.position, h = player.height;
  const n = world._query(p.x - RADIUS, p.y, p.z - RADIUS, p.x + RADIUS, p.y + h, p.z + RADIUS);
  let worst = 0, hit = -1;
  for (let k = 0; k < n; k++) {
    const bi = world._cand[k];
    const d = depthIn(boxes[bi]);
    if (d > worst) { worst = d; hit = bi; }
  }
  return worst > tol ? { index: hit, box: boxes[hit], depth: worst } : null;
}

function outOfBounds() {
  const p = player.position;
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return 'non-finite';
  const m = 0.5;
  if (p.x < bounds.min.x - m || p.x > bounds.max.x + m) return 'x';
  if (p.z < bounds.min.z - m || p.z > bounds.max.z + m) return 'z';
  if (p.y < bounds.min.y - m) return 'below floor';
  if (p.y > bounds.max.y + m) return 'above roof';
  return null;
}

/** Can the player get out from where it is? 8 directions, 1 s each. */
function tryEscape() {
  const save = player.position.clone();
  for (let d = 0; d < 8; d++) {
    const a = (d / 8) * Math.PI * 2;
    place(save.x, save.y, save.z, { yaw: a, grounded: false, state: 'air' });
    for (let t = 0; t < 120; t++) tick({ wishForward: 1 });
    if (!insideAny()) { player.position.copy(save); return true; }
  }
  player.position.copy(save);
  return false;
}

/**
 * The highest feet-Y a player can plausibly reach on this box's top face, in ONE move
 * from an adjacent standable surface: jump apex 1.15 m plus the 1.35 m mantle window.
 * Sampled at 12 points around the perimeter. This is a single-hop approximation — a
 * multi-hop staircase of crates would read as unreachable — so it is used only to skip
 * obviously-unreachable starts (perimeter wall tops at y = 15), never to pass a test.
 */
const REACH = 2.55;
function reachTop(b) {
  const pad = RADIUS + 0.05;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const x = Math.max(b.min.x - pad, Math.min(b.max.x + pad, (b.min.x + b.max.x) / 2 + Math.cos(a) * ((b.max.x - b.min.x) / 2 + pad)));
    const z = Math.max(b.min.z - pad, Math.min(b.max.z + pad, (b.min.z + b.max.z) / 2 + Math.sin(a) * ((b.max.z - b.min.z) / 2 + pad)));
    const g = world.sampleGroundHeight(x, z, b.max.y - 0.01);
    if (g !== null && b.max.y - g <= REACH) return Infinity;
  }
  return -Infinity;
}

const fmtB = (b) => `[${b.min.x.toFixed(2)},${b.min.y.toFixed(2)},${b.min.z.toFixed(2)}]..`
  + `[${b.max.x.toFixed(2)},${b.max.y.toFixed(2)},${b.max.z.toFixed(2)}] ${b.surface}`;
const fmtP = (p) => `(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)})`;

// Global finding sink, deduped by a signature so one geometric defect reports once.
const findings = new Map();
function report(kind, sig, detail) {
  const key = `${kind}|${sig}`;
  const cur = findings.get(key);
  if (cur) { cur.count++; return; }
  findings.set(key, { kind, sig, detail, count: 1 });
}

// ═════════════════════════════════════════════════════════════ 1. TUNNELLING ═════════
//
// Every lateral face of every box, driven at every attainable speed and a spread of
// incidence angles, from outside. The drive is KINEMATIC: the velocity is re-asserted
// every tick so the approach vector is exact, but the SOLVER is the real one — the whole
// point is to test `world.move`'s sweep, not the player's accelerator.

/** Speeds a player can actually reach. See player.js TUNE. */
const SPEEDS = QUICK ? [7.2, 11] : [4.6, 7.2, 8.6, 9.5, 11];
/** Incidence angle off the face normal, degrees. 85 is a near-parallel graze. */
const ANGLES = QUICK ? [0, 45, 85] : [0, 15, 30, 45, 60, 75, 85];
/** Vertical component, m/s. -60 is terminal velocity; +7.1 is a jump. */
const VERTS = QUICK ? [0, -60] : [0, -22, -60, 7.1];

const FACES = [
  { axis: 0, sign: +1 }, { axis: 0, sign: -1 },
  { axis: 2, sign: +1 }, { axis: 2, sign: -1 },
];

function tunnelTest() {
  let facesReachable = 0, facesTotal = 0, samples = 0, runs = 0;
  const through = [];
  const inside = [];
  const step = QUICK ? 7 : 1;

  for (let bi = 0; bi < boxes.length; bi += step) {
    const b = boxes[bi];
    const spanY = b.max.y - b.min.y;
    // A box whose top is below the ankles cannot be walked into; a box entirely above
    // reach cannot either. Both still get tested if any part is in the body's band.
    for (const f of FACES) {
      facesTotal++;
      const nrm = [0, 0, 0];
      nrm[f.axis] = f.sign;
      const facePos = f.sign > 0 ? b.max : b.min;
      const faceVal = f.axis === 0 ? facePos.x : facePos.z;
      // Lateral axis of this face (the other horizontal one).
      const lat = f.axis === 0 ? 2 : 0;
      const latMin = lat === 0 ? b.min.x : b.min.z;
      const latMax = lat === 0 ? b.max.x : b.max.z;

      // Sample points across the face: centre plus quarter points.
      const latFracs = QUICK ? [0.5] : [0.5, 0.15, 0.85];
      // Feet heights that make the body straddle the box.
      const yFracs = spanY < 0.9 ? [-0.4] : [0, 0.5];

      let reachable = false;
      for (const lf of latFracs) {
        const latAt = latMin + (latMax - latMin) * lf;
        for (const yf of yFracs) {
          const feetY = b.min.y + spanY * yf;
          // Standoff: clear of the face, plus half a tick of travel.
          const d = RADIUS + 0.25;
          const sx = f.axis === 0 ? faceVal + f.sign * d : latAt;
          const sz = f.axis === 2 ? faceVal + f.sign * d : latAt;
          place(sx, feetY, sz);
          // Only a start position that is itself in free air is a position a player
          // could ever occupy. Anything else is not a reachable approach.
          if (world._overlapAny(sx, feetY, sz, RADIUS, STAND)) continue;
          reachable = true;
          samples++;

          for (const sp of SPEEDS) {
            for (const ang of ANGLES) {
              for (const side of (ang === 0 ? [1] : [1, -1])) {
                for (const vy of VERTS) {
                  runs++;
                  const a = ang * Math.PI / 180;
                  // Approach vector: -normal rotated by `ang` toward the lateral axis.
                  const vN = -Math.cos(a) * sp * f.sign;
                  const vL = Math.sin(a) * sp * side;
                  const vx = f.axis === 0 ? vN : vL;
                  const vz = f.axis === 2 ? vN : vL;
                  place(sx, feetY, sz);
                  let worstDepth = 0, crossed = false;
                  // A body that gets ON TOP of the box (a legal step-up or jump) or drops
                  // BELOW it has gone around, not through — anything it does afterwards is
                  // not a penetration, so the crossing test is disarmed from then on.
                  let wentOver = false;
                  const TICKS = 40;
                  for (let t = 0; t < TICKS; t++) {
                    player.velocity.set(vx, vy, vz);
                    tick();
                    const p = player.position;
                    const d2 = depthIn(b, p, player.height);
                    if (d2 > worstDepth) worstDepth = d2;
                    if (p.y >= b.max.y - 0.01 || p.y + player.height <= b.min.y + 0.01) wentOver = true;
                    if (wentOver) continue;
                    // Fully on the far side of the box, still within its footprint?
                    const pn = f.axis === 0 ? p.x : p.z;
                    const far = f.sign > 0 ? (f.axis === 0 ? b.min.x : b.min.z)
                      : (f.axis === 0 ? b.max.x : b.max.z);
                    const beyond = f.sign > 0 ? pn < far - RADIUS : pn > far + RADIUS;
                    const pl = lat === 0 ? p.x : p.z;
                    const withinLat = pl > latMin && pl < latMax;
                    // Going OVER the top (a legal step-up/jump) or UNDER the bottom is not
                    // passing through. Only a body genuinely straddling the slab counts.
                    const withinY = p.y + player.height > b.min.y + 0.06 && p.y < b.max.y - 0.06;
                    if (beyond && withinLat && withinY) { crossed = true; break; }
                  }
                  if (crossed) {
                    through.push({ bi, b, from: [sx, feetY, sz], vel: [vx, vy, vz], at: player.position.clone() });
                    report('THROUGH', `box${bi}`,
                      `box ${fmtB(b)}\n       from ${fmtP({ x: sx, y: feetY, z: sz })} `
                      + `vel (${vx.toFixed(1)},${vy.toFixed(1)},${vz.toFixed(1)}) `
                      + `→ ended ${fmtP(player.position)}`);
                  } else if (worstDepth > PEN_TOL) {
                    inside.push({ bi, b, depth: worstDepth, vel: [vx, vy, vz], from: [sx, feetY, sz] });
                    report('INSIDE', `box${bi}`,
                      `box ${fmtB(b)}\n       from ${fmtP({ x: sx, y: feetY, z: sz })} `
                      + `vel (${vx.toFixed(1)},${vy.toFixed(1)},${vz.toFixed(1)}) `
                      + `→ embedded ${worstDepth.toFixed(3)} m`);
                  }
                }
              }
            }
          }
        }
      }
      if (reachable) facesReachable++;
    }
  }

  console.log(`\n  tunnelling: ${facesReachable}/${facesTotal} lateral faces reachable across `
    + `${Math.ceil(boxes.length / step)} boxes, ${samples} approach points, ${runs} drives`);
  console.log(`              speeds ${SPEEDS.join('/')} u/s × ${ANGLES.length} incidence angles `
    + `(0°–85°) × ${VERTS.length} vertical components`);
  if (through.length === 0) ok('no box was passed through');
  else bad('no box was passed through', `${through.length} drives ended on the far side`);
  if (inside.length === 0) ok('no box was penetrated (embedded > 20 mm)');
  else bad('no box was penetrated', `${inside.length} drives left the body inside the collider`);
}

// ═════════════════════════════════════════════════════════ 2. CORNERS & SEAMS ════════
//
// Diagonal movement into a junction is the classic escape from an axis-separated solver:
// the X sweep sees no blocker at the old Z, the Z sweep sees no blocker at the new X.
// Every vertical edge of every box, plus every seam between two abutting boxes.

function cornerTest() {
  let edges = 0, runs = 0;
  const fails = [];
  const step = QUICK ? 7 : 1;
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

  for (let bi = 0; bi < boxes.length; bi += step) {
    const b = boxes[bi];
    const spanY = b.max.y - b.min.y;
    for (const [sx, sz] of DIAG) {
      // The exterior corner of this box on this diagonal.
      const cx = sx > 0 ? b.max.x : b.min.x;
      const cz = sz > 0 ? b.max.z : b.min.z;
      for (const yf of (spanY < 0.9 ? [-0.4] : [0, 0.5])) {
        const feetY = b.min.y + spanY * yf;
        const d = RADIUS + 0.3;
        const px = cx + sx * d, pz = cz + sz * d;
        if (world._overlapAny(px, feetY, pz, RADIUS, STAND)) continue;
        edges++;
        // Drive straight at the corner, and at the two half-diagonals either side.
        for (const [ax, az] of [[-sx, -sz], [-sx, -sz * 0.25], [-sx * 0.25, -sz]]) {
          const l = Math.hypot(ax, az);
          for (const sp of (QUICK ? [11] : [7.2, 9.5, 11])) {
            runs++;
            const vx = (ax / l) * sp, vz = (az / l) * sp;
            place(px, feetY, pz);
            let worst = 0;
            for (let t = 0; t < 45; t++) {
              player.velocity.set(vx, 0, vz);
              tick();
              const hit = insideAny();
              if (hit && hit.depth > worst) worst = hit.depth;
              if (worst > 0.05) break;
            }
            if (worst > PEN_TOL) {
              const h = insideAny();
              fails.push({ bi, worst });
              report('CORNER', `box${bi}`,
                `corner of ${fmtB(b)}\n       diagonal drive from ${fmtP({ x: px, y: feetY, z: pz })} `
                + `at ${sp} u/s → embedded ${worst.toFixed(3)} m`
                + (h ? ` in ${fmtB(h.box)}` : ''));
            }
          }
        }
      }
    }
  }

  // Wall/floor seams and stacked-box seams: drive along the join line itself.
  let seams = 0, seamsSkipped = 0;
  for (let bi = 0; bi < boxes.length; bi += step) {
    const b = boxes[bi];
    // Feet exactly on the top face of this box, driving in all 4 axis directions —
    // this is the wall/floor and stacked-box seam, tested at the exact junction Y.
    const y = b.max.y;
    // Only tops a player can actually reach. A 15 m perimeter wall's top face is not a
    // place a body can be, so walking off it is not a defect the player can produce.
    // (`reachTop` is single-hop, so also cap at the map's real playable ceiling — the
    // 15 m perimeter walls are not somewhere a body can be.)
    // 12.0, not 8.5. The old cap skipped every corner and seam above 8.5 m — 92 of 997
    // colliders top out higher, including the market hall lantern deck at 11.67, which this
    // project's own commit messages call the most contested position on the map. A coverage
    // gate set below the interesting geometry makes a PASS mean less than it looks.
    if (y > reachTop(b) || y > 12.0) { seamsSkipped++; continue; }
    for (const [vx, vz] of [[1, 0], [-1, 0], [0, 1], [0, 1e-9], [0, -1]]) {
      const px = (b.min.x + b.max.x) / 2, pz = (b.min.z + b.max.z) / 2;
      if (world._overlapAny(px, y, pz, RADIUS, STAND)) continue;
      seams++;
      place(px, y, pz, { grounded: true, state: 'ground' });
      for (let t = 0; t < 60; t++) { player.velocity.set(vx * 8.6, -2, vz * 8.6); tick(); }
      const hit = insideAny();
      if (hit) {
        report('SEAM', `box${bi}`,
          `walking off the top of ${fmtB(b)} → embedded ${hit.depth.toFixed(3)} m in ${fmtB(hit.box)}`);
        fails.push({ bi, worst: hit.depth });
      }
      const oob = outOfBounds();
      if (oob) report('OOB', `seam${bi}`, `walking off ${fmtB(b)} → ${oob} at ${fmtP(player.position)}`);
    }
  }

  console.log(`\n  corners/seams: ${edges} reachable exterior corners, ${runs} diagonal drives, `
    + `${seams} top-face seam walks`);
  if (fails.length === 0) ok('no corner or seam admits the body');
  else bad('no corner or seam admits the body', `${fails.length} events`);
}

// ═══════════════════════════════════════════════════════════════ 3. MANTLE ═══════════
//
// `_tryMantle` scripts the body along a lerp with NO collision test on the path or the
// destination beyond one zero-radius up-ray. Every ledge on the map is tried.

function mantleTest() {
  let ledges = 0, attempts = 0, mantled = 0, transient = 0, worstTransient = 0, heightRegrown = 0, standingClip = 0;
  const embedded = [];
  const step = QUICK ? 5 : 1;

  for (let bi = 0; bi < boxes.length; bi += step) {
    const b = boxes[bi];
    const top = b.max.y;
    for (const f of FACES) {
      const facePos = f.sign > 0 ? b.max : b.min;
      const faceVal = f.axis === 0 ? facePos.x : facePos.z;
      const lat = f.axis === 0 ? 2 : 0;
      const latMin = lat === 0 ? b.min.x : b.min.z;
      const latMax = lat === 0 ? b.max.x : b.max.z;
      for (const lf of (QUICK ? [0.5] : [0.5, 0.2, 0.8])) {
        const latAt = latMin + (latMax - latMin) * lf;
        // Feet at a height that puts the ledge in the mantle window (0.55–1.35 m).
        for (const h of [0.7, 1.0, 1.3]) {
          const feetY = top - h;
          const d = RADIUS + 0.12;
          const px = f.axis === 0 ? faceVal + f.sign * d : latAt;
          const pz = f.axis === 2 ? faceVal + f.sign * d : latAt;
          if (world._overlapAny(px, feetY, pz, RADIUS, STAND)) continue;
          // Must be standable ground there, or the player could not be at that height.
          const g = world.sampleGroundHeight(px, pz, feetY + 0.05);
          if (g === null || Math.abs(g - feetY) > 0.1) continue;
          ledges++;
          attempts++;
          // Face the wall.
          const yaw = Math.atan2(
            -(f.axis === 0 ? -f.sign : 0),
            -(f.axis === 2 ? -f.sign : 0),
          );
          place(px, feetY, pz, { yaw, grounded: true, state: 'ground' });
          // Walk in, then jump — the vault is automatic.
          for (let t = 0; t < 12; t++) tick({ wishForward: 1 });
          cmd.jump = true;
          tick({ wishForward: 1 });
          if (player.moveState !== 'mantle') continue;
          mantled++;
          // Ride the mantle out, measuring the body's peak interpenetration ALONG the
          // scripted lerp — `_mantleStep` runs no collision at all, so this is where the
          // body is inside the world if it ever is.
          let worst = 0, worstBox = null, worstH = 0;
          for (let t = 0; t < 60 && player.moveState === 'mantle'; t++) {
            tick({ wishForward: 1 });
            const hit = insideAny(0);
            if (hit && hit.depth > worst) { worst = hit.depth; worstBox = hit.box; worstH = player.height; }
          }
          if (player.height > CROUCH + 0.05) heightRegrown++;
          for (let t = 0; t < 40; t++) {
            tick();
            const hit = insideAny(0);
            if (hit && hit.depth > worst) { worst = hit.depth; worstBox = hit.box; worstH = player.height; }
          }
          const resting = insideAny();
          const oob = outOfBounds();
          if (resting) {
            const stuck = tryEscape() ? '' : ' (STUCK — no escape in 8 directions)';
            embedded.push({ bi, depth: resting.depth });
            report('MANTLE-INSIDE', `box${bi}-${f.axis}${f.sign}`,
              `mantling ${fmtB(b)} from ${fmtP({ x: px, y: feetY, z: pz })} `
              + `left the body ${resting.depth.toFixed(3)} m inside ${fmtB(resting.box)}${stuck}`);
          } else if (worst > 0.06 && worstBox) {
            transient++;
            if (worst > worstTransient) worstTransient = worst;
            if (worstH > CROUCH + 0.15) standingClip++;
            report('MANTLE-TRANSIENT', `box${bi}-${f.axis}${f.sign}`,
              `mantling ${fmtB(b)} put the body ${worst.toFixed(3)} m inside `
              + `${fmtB(worstBox)} mid-vault (capsule height ${worstH.toFixed(2)} m); `
              + `it recovered on landing`);
          }
          if (oob) {
            report('OOB', `mantle${bi}`, `mantling ${fmtB(b)} → ${oob} at ${fmtP(player.position)}`);
          }
        }
      }
    }
  }

  console.log(`\n  mantle: ${ledges} reachable ledge approaches, ${attempts} vault attempts, `
    + `${mantled} vaults actually triggered`);
  console.log(`          ${transient} vaults clipped through geometry mid-flight `
    + `(worst ${worstTransient.toFixed(3)} m, ${standingClip} of them at STANDING height inside the ledge); ${heightRegrown}/${mantled} finished the vault at `
    + `more than crouch height despite _tryMantle committing at CROUCH_HEIGHT`);
  if (embedded.length === 0) ok('no vault leaves the body inside geometry');
  else bad('no vault leaves the body inside geometry', `${embedded.length} vaults did`);
}

// ═══════════════════════════════════════════════════════ 4. SLIDE / CROUCH / GAP ═════

function slideTest() {
  let runs = 0;
  const fails = [];
  const step = QUICK ? 9 : 2;

  for (let bi = 0; bi < boxes.length; bi += step) {
    const b = boxes[bi];
    // Only boxes with a gap under them are slide-under candidates, but sliding INTO a
    // face is the more common failure — do both from every face.
    for (const f of FACES) {
      const facePos = f.sign > 0 ? b.max : b.min;
      const faceVal = f.axis === 0 ? facePos.x : facePos.z;
      const lat = f.axis === 0 ? 2 : 0;
      const latAt = ((lat === 0 ? b.min.x : b.min.z) + (lat === 0 ? b.max.x : b.max.z)) / 2;
      const run = 4.0;   // room to build sprint speed before the slide
      const px = f.axis === 0 ? faceVal + f.sign * (RADIUS + run) : latAt;
      const pz = f.axis === 2 ? faceVal + f.sign * (RADIUS + run) : latAt;
      const g = world.sampleGroundHeight(px, pz, b.max.y);
      if (g === null) continue;
      if (world._overlapAny(px, g, pz, RADIUS, STAND)) continue;
      const yaw = f.axis === 0
        ? (f.sign > 0 ? Math.PI / 2 : -Math.PI / 2)
        : (f.sign > 0 ? 0 : Math.PI);
      runs++;
      place(px, g, pz, { yaw, grounded: true, state: 'ground' });
      // Sprint up, slide, then keep pushing.
      for (let t = 0; t < 45; t++) tick({ wishForward: 1, sprintKeyHeld: true });
      cmd.crouchPressed = true;
      tick({ wishForward: 1, sprintKeyHeld: true, crouchHeld: true });
      for (let t = 0; t < 150; t++) tick({ wishForward: 1, crouchHeld: t < 110 });
      const hit = insideAny();
      const oob = outOfBounds();
      if (hit) {
        const stuck = tryEscape() ? '' : ' (STUCK)';
        fails.push(bi);
        report('SLIDE-INSIDE', `box${bi}-${f.axis}${f.sign}`,
          `sprint-slide into ${fmtB(b)} from ${fmtP({ x: px, y: g, z: pz })} `
          + `left the body ${hit.depth.toFixed(3)} m inside ${fmtB(hit.box)}${stuck}`);
      }
      if (oob) {
        fails.push(bi);
        report('OOB', `slide${bi}`, `sprint-slide at ${fmtB(b)} → ${oob} at ${fmtP(player.position)}`);
      }
    }
  }
  console.log(`\n  slide: ${runs} sprint-slide approaches (entry 9.5 u/s, crouch-fit, stand-up)`);
  if (fails.length === 0) ok('no slide ends inside geometry or out of bounds');
  else bad('no slide ends inside geometry', `${fails.length} events`);
}

// ═════════════════════════════════════════════════════ 5. STANCE CHANGE / OVERHANG ═══
//
// Anywhere the collision height CHANGES is a candidate: `_canStand` probes 5 zero-radius
// rays at 0.72 × radius, so it cannot see the outer 0.10 m of the body or its corners.

function stanceTest() {
  let runs = 0;
  const fails = [];
  const step = QUICK ? 5 : 1;
  for (let bi = 0; bi < boxes.length; bi += step) {
    const b = boxes[bi];
    // An overhang: something to stand UNDER. Only boxes with headroom below them.
    if (b.min.y < 0.9 || b.min.y > 2.4) continue;
    // Sample the underside footprint, including hard against each edge and each corner.
    const xs = [b.min.x + 0.02, (b.min.x + b.max.x) / 2, b.max.x - 0.02,
      b.min.x - RADIUS + 0.06, b.max.x + RADIUS - 0.06];
    const zs = [b.min.z + 0.02, (b.min.z + b.max.z) / 2, b.max.z - 0.02,
      b.min.z - RADIUS + 0.06, b.max.z + RADIUS - 0.06];
    for (const x of xs) {
      for (const z of zs) {
        const g = world.sampleGroundHeight(x, z, b.min.y);
        if (g === null) continue;
        if (b.min.y - g > STAND) continue;          // full standing room — nothing to test
        if (b.min.y - g < CROUCH + 0.02) continue;  // cannot even crouch there
        if (world._overlapAny(x, g, z, RADIUS, CROUCH)) continue;
        runs++;
        place(x, g, z, { height: CROUCH, grounded: true, state: 'ground' });
        // Crouch-walk in, then release crouch and try to stand.
        for (let t = 0; t < 30; t++) tick({ crouchHeld: true });
        for (let t = 0; t < 90; t++) tick();
        const hit = insideAny();
        if (hit) {
          const stuck = tryEscape() ? '' : ' (STUCK)';
          fails.push(bi);
          report('STAND-INSIDE', `box${bi}`,
            `standing up under ${fmtB(b)} at ${fmtP({ x, y: g, z })} `
            + `embedded ${hit.depth.toFixed(3)} m in ${fmtB(hit.box)}${stuck} `
            + `(height ${player.height.toFixed(2)})`);
        }
        const oob = outOfBounds();
        if (oob) report('OOB', `stand${bi}`, `standing under ${fmtB(b)} → ${oob}`);
      }
    }
  }
  console.log(`\n  stance: ${runs} crouch-under-overhang → stand-up attempts`);
  if (fails.length === 0) ok('standing up never forces the body into geometry');
  else bad('standing up never forces the body into geometry', `${fails.length} events`);
}

// ═══════════════════════════════════════════════════════════ 6. FALL / SPAWN OOB ═════
//
// Long free-falls from the ceiling onto every part of the map: the highest-energy thing
// a player can do to the solver. Plus a containment sweep from every spawn.

function fallTest() {
  const grid = QUICK ? 3.0 : 1.5;
  let drops = 0;
  const fails = [];
  const y0 = bounds.max.y + 3;
  for (let x = bounds.min.x + 1; x < bounds.max.x - 1; x += grid) {
    for (let z = bounds.min.z + 1; z < bounds.max.z - 1; z += grid) {
      drops++;
      place(x, y0, z, { vel: { x: 0, y: -60, z: 0 } });
      for (let t = 0; t < 400; t++) {
        player.alive = true;   // fall damage must not end the drop early
        player.health = 100;
        tick();
        if (player.grounded && Math.abs(player.velocity.y) < 0.01) break;
      }
      const hit = insideAny();
      const oob = outOfBounds();
      if (hit) {
        fails.push([x, z]);
        report('FALL-INSIDE', `cell${Math.round(x)},${Math.round(z)}`,
          `terminal-velocity drop at (${x.toFixed(1)},${z.toFixed(1)}) rested `
          + `${hit.depth.toFixed(3)} m inside ${fmtB(hit.box)} at ${fmtP(player.position)}`);
      }
      if (oob) {
        fails.push([x, z]);
        report('OOB', `fall${Math.round(x)},${Math.round(z)}`,
          `terminal-velocity drop at (${x.toFixed(1)},${z.toFixed(1)}) → ${oob} at ${fmtP(player.position)}`);
      }
    }
  }
  console.log(`\n  fall: ${drops} terminal-velocity (-60 u/s) drops from y=${y0.toFixed(1)} `
    + `on a ${grid} m lattice`);
  if (fails.length === 0) ok('no terminal-velocity drop lands inside geometry or out of bounds');
  else bad('no terminal-velocity drop lands cleanly', `${fails.length} of ${drops} cells`);
}

// ══════════════════════════════════════════════════════════ 7. PERIMETER ESCAPE ══════
//
// From every spawn, brute-force the perimeter: sprint, slide-jump and mantle at the
// world edge for 20 s on a spread of headings, and assert containment throughout.

function escapeTest() {
  let runs = 0, mantleClip = 0, transientClip = 0, maxClipTicks = 0, maxClipAt = null;
  const fails = [];
  const headings = QUICK ? 8 : 24;
  for (const sp of world.spawnPoints) {
    for (let hI = 0; hI < headings; hI++) {
      runs++;
      const yaw = (hI / headings) * Math.PI * 2;
      place(sp.position.x, sp.position.y, sp.position.z, { yaw, grounded: true, state: 'ground' });
      for (let t = 0; t < 2400; t++) {
        // Sprint constantly; jump every 24 ticks (bunny/mantle); slide every 180.
        if (t % 24 === 0) cmd.jump = true;
        if (t % 180 === 90) cmd.crouchPressed = true;
        tick({ wishForward: 1, sprintKeyHeld: true, crouchHeld: (t % 180) >= 90 && (t % 180) < 140 });
        const oob = outOfBounds();
        if (oob) {
          fails.push(yaw);
          report('OOB', `escape-${oob}`,
            `sprint/jump/slide from spawn ${fmtP(sp.position)} heading `
            + `${(yaw * 180 / Math.PI).toFixed(0)}° left the map (${oob}) at ${fmtP(player.position)}`);
          break;
        }
        const hit = insideAny(0.06);
        if (hit) {
          // Transient or persistent? Stop steering and let the solver have 0.25 s.
          const state0 = player.moveState;
          const h0 = player.height;
          const at0 = player.position.clone();
          const wasMantling = state0 === 'mantle' || player._mantleT > 0;
          let held = 0;
          for (let k = 0; k < 240; k++) { tick(); if (insideAny(0.06)) held = k + 1; }
          const still = insideAny(0.06);
          if (held > maxClipTicks) {
            maxClipTicks = held;
            maxClipAt = `entered ${fmtB(hit.box)} while '${state0}' at ${fmtP(at0)}`;
          }
          if (!still) {
            if (wasMantling) mantleClip++; else transientClip++;
            continue;
          }
          const escaped = tryEscape();
          fails.push(yaw);
          report('ESCAPE-INSIDE', `spawn-${fmtP(sp.position)}-${still.index}`,
            `sprint/jump/slide from spawn ${fmtP(sp.position)} heading `
            + `${(yaw * 180 / Math.PI).toFixed(0)}° entered ${fmtB(still.box)} at ${fmtP(at0)} `
            + `while '${state0}' (capsule ${h0.toFixed(2)} m) and was STILL `
            + `${still.depth.toFixed(3)} m inside it ${(held / 120).toFixed(2)} s later at `
            + `${fmtP(player.position)}${escaped ? ' — walks out with input' : ' — STUCK, cannot walk out'}`);
          break;
        }
      }
    }
  }
  console.log(`\n  containment: ${runs} × 20 s sprint/jump/slide runs from `
    + `${world.spawnPoints.length} spawns on ${headings} headings `
    + `(${mantleClip} mid-vault clips, ${transientClip} other clips, all self-recovered)`);
  console.log(`               worst clip persisted ${(maxClipTicks / 120).toFixed(2)} s`
    + (maxClipAt ? ` (${maxClipAt})` : ''));
  if (fails.length === 0) ok('the player never leaves the map or enters geometry');
  else bad('the player never leaves the map', `${fails.length} runs escaped or embedded`);
}

// ═════════════════════════════════════════════════ 7b. CROUCH-FIT / SLIDE-UNDER ═════
//
// The other stance. A crouched body is 1.10 m tall instead of 1.80, so it sees a
// different set of blockers — and a SLIDING body is crouched AND moving at 9.5 u/s.
// Every box with an air gap beneath it gets a crouched drive and a slide from all four
// sides: the body must fit under a gap ≥ 1.10 m and must never fit under a smaller one.

function crouchTest() {
  let gaps = 0, drives = 0, fitted = 0;
  const fails = [];
  const step = QUICK ? 5 : 1;
  for (let bi = 0; bi < boxes.length; bi += step) {
    const b = boxes[bi];
    for (const f of FACES) {
      const facePos = f.sign > 0 ? b.max : b.min;
      const faceVal = f.axis === 0 ? facePos.x : facePos.z;
      const lat = f.axis === 0 ? 2 : 0;
      const latAt = ((lat === 0 ? b.min.x : b.min.z) + (lat === 0 ? b.max.x : b.max.z)) / 2;
      const run = 4.0;
      const px = f.axis === 0 ? faceVal + f.sign * (RADIUS + run) : latAt;
      const pz = f.axis === 2 ? faceVal + f.sign * (RADIUS + run) : latAt;
      const g = world.sampleGroundHeight(px, pz, b.min.y);
      if (g === null) continue;
      // Gap measured UNDER the box, not at the approach point.
      const gUnder = world.sampleGroundHeight((b.min.x + b.max.x) / 2, (b.min.z + b.max.z) / 2, b.min.y - 0.01);
      if (gUnder === null) continue;
      const gap = b.min.y - gUnder;
      if (gap <= 0.05 || gap > STAND) continue;     // no gap, or full standing room
      if (world._overlapAny(px, g, pz, RADIUS, CROUCH)) continue;
      gaps++;
      const yaw = f.axis === 0
        ? (f.sign > 0 ? Math.PI / 2 : -Math.PI / 2)
        : (f.sign > 0 ? 0 : Math.PI);
      // (a) crouch-walk under, (b) sprint-slide under.
      for (const mode of ['crouch', 'slide']) {
        drives++;
        place(px, g, pz, { yaw, height: CROUCH, grounded: true, state: 'ground' });
        if (mode === 'crouch') {
          for (let t = 0; t < 260; t++) tick({ wishForward: 1, crouchHeld: true });
        } else {
          for (let t = 0; t < 45; t++) tick({ wishForward: 1, sprintKeyHeld: true });
          cmd.crouchPressed = true;
          tick({ wishForward: 1, sprintKeyHeld: true, crouchHeld: true });
          for (let t = 0; t < 200; t++) tick({ wishForward: 1, crouchHeld: t < 160 });
        }
        // Did the body get UNDER the box — inside its footprint and below its underside?
        const q = player.position;
        const under = q.x > b.min.x && q.x < b.max.x && q.z > b.min.z && q.z < b.max.z
          && q.y < b.min.y - 0.01 && q.y > gUnder - 0.05;
        if (under) fitted++;
        const hit = insideAny();
        const oob = outOfBounds();
        if (under && gap < CROUCH - 0.02) {
          fails.push(bi);
          report('CROUCH-FIT', `box${bi}-${f.axis}${f.sign}`,
            `a ${gap.toFixed(2)} m gap under ${fmtB(b)} admitted the 1.10 m crouched body `
            + `(${mode}) — it reached ${fmtP(player.position)}`);
        }
        if (hit) {
          fails.push(bi);
          const stuck = tryEscape() ? '' : ' (STUCK)';
          report('CROUCH-INSIDE', `box${bi}-${f.axis}${f.sign}`,
            `${mode} under ${fmtB(b)} (gap ${gap.toFixed(2)} m) left the body `
            + `${hit.depth.toFixed(3)} m inside ${fmtB(hit.box)}${stuck}`);
        }
        if (oob) {
          fails.push(bi);
          report('OOB', `crouch${bi}`, `${mode} under ${fmtB(b)} → ${oob}`);
        }
      }
    }
  }
  console.log(`\n  crouch/slide-under: ${gaps} sub-standing-height gaps found, ${drives} drives, `
    + `${fitted} got the body under`);
  if (fails.length === 0) ok('crouching and sliding never fit the body where it does not belong');
  else bad('crouching and sliding never fit the body where it does not belong', `${fails.length} events`);
}

// ═══════════════════════════════════════════════════════════ 8. DEPENETRATION ═══════
//
// The mirror bug: getting STUCK, and being pushed out to the WRONG SIDE.
//
// A body ends up inside a collider through routes the sweep never sees: a scripted vault
// (`_mantleStep` runs no collision at all — see MANTLE-TRANSIENT), a respawn onto occupied
// ground, a stance change that grows the capsule. `World._depenetrate` (world.js:627) is
// the only thing that gets it out, and it is a 4-pass push along each box's own
// minimum-overlap axis with NO memory of which side the body came from.
//
// So: shove the body 0.20 m through each lateral face of every box — the depth a vault
// actually produces — and check it comes back out the side it went in.

function depenTest() {
  let runs = 0, freed = 0, thinEject = 0;
  const stuck = [];
  const wrongSide = [];
  const step = QUICK ? 5 : 1;
  const EMBED = 0.20;
  for (let bi = 0; bi < boxes.length; bi += step) {
    const b = boxes[bi];
    const spanY = b.max.y - b.min.y;
    if (spanY < 0.5) continue;
    for (const f of FACES) {
      const facePos = f.sign > 0 ? b.max : b.min;
      const faceVal = f.axis === 0 ? facePos.x : facePos.z;
      const lat = f.axis === 0 ? 2 : 0;
      const latAt = ((lat === 0 ? b.min.x : b.min.z) + (lat === 0 ? b.max.x : b.max.z)) / 2;
      const feetY = Math.max(b.min.y, b.max.y - STAND);
      // Outside reference point on this face — where a correct push-out lands.
      const ox = f.axis === 0 ? faceVal + f.sign * (RADIUS + 0.05) : latAt;
      const oz = f.axis === 2 ? faceVal + f.sign * (RADIUS + 0.05) : latAt;
      if (world._overlapAny(ox, feetY, oz, RADIUS, STAND)) continue;   // face not exposed
      // …and exposed to somewhere a player can BE. The outer face of a perimeter wall is
      // "free air" only because it is outside the map.
      if (ox < bounds.min.x || ox > bounds.max.x || oz < bounds.min.z || oz > bounds.max.z) continue;
      if (world.sampleGroundHeight(ox, oz, feetY + 0.5) === null) continue;
      // Thickness of this box along the approach axis. A wall thinner than the 0.72 m
      // body cannot have a "correct" side once the body is centred on it — which side it
      // pops out is decided by which side of the wall's midplane the body's centre is.
      const thickness = f.axis === 0 ? b.max.x - b.min.x : b.max.z - b.min.z;
      // Embedded start: same point pushed EMBED metres into the box.
      const px = f.axis === 0 ? ox - f.sign * (RADIUS + EMBED) : ox;
      const pz = f.axis === 2 ? oz - f.sign * (RADIUS + EMBED) : oz;
      runs++;
      place(px, feetY, pz, { grounded: false, state: 'air' });
      // The push-out happens on the first `world.move`. Read the side it chose BEFORE
      // gravity carries the body anywhere.
      for (let t = 0; t < 3; t++) tick();
      const endN = f.axis === 0 ? player.position.x : player.position.z;
      const farVal = f.axis === 0 ? (f.sign > 0 ? b.min.x : b.max.x) : (f.sign > 0 ? b.min.z : b.max.z);
      const lp = lat === 0 ? player.position.x : player.position.z;
      const inFootprint = lp > (lat === 0 ? b.min.x : b.min.z) && lp < (lat === 0 ? b.max.x : b.max.z);
      // Escaping SIDEWAYS out of a thin wall is a correct minimum-translation escape.
      // Only ending up beyond the OPPOSITE face, still within the box's footprint, is
      // the body being delivered to the far side of the wall it was inside.
      const pushedThrough = inFootprint
        && (f.sign > 0 ? endN < farVal - RADIUS : endN > farVal + RADIUS);
      for (let t = 0; t < 240; t++) tick();
      const hit = insideAny();
      const oob = outOfBounds();
      if (!hit && !oob && !pushedThrough) { freed++; continue; }
      if (hit) {
        const escaped = tryEscape();
        report(escaped ? 'DEPEN-SLOW' : 'STUCK', `box${bi}-${f.axis}${f.sign}`,
          `a body ${EMBED} m inside the ${f.axis === 0 ? 'X' : 'Z'}${f.sign > 0 ? '+' : '-'} face of `
          + `${fmtB(b)} is still ${hit.depth.toFixed(3)} m inside ${fmtB(hit.box)} after 2 s`
          + (escaped ? ' (walks out with input)' : ' and cannot walk out in any of 8 directions'));
        if (!escaped) stuck.push(bi);
      }
      if (pushedThrough) {
        if (thickness >= 2 * RADIUS) {
          wrongSide.push(bi);
          report('WRONG-SIDE', `box${bi}-${f.axis}${f.sign}`,
            `a body ${EMBED} m inside the ${f.axis === 0 ? 'X' : 'Z'}${f.sign > 0 ? '+' : '-'} face of `
            + `${thickness.toFixed(2)} m thick ${fmtB(b)} was pushed out through the OPPOSITE face `
            + `(${endN.toFixed(2)} vs far face ${farVal.toFixed(2)})`);
        } else {
          thinEject++;
          report('THIN-WALL-EJECT', `box${bi}-${f.axis}`,
            `${fmtB(b)} is only ${thickness.toFixed(2)} m thick — thinner than the 0.72 m body — `
            + `so a body embedded in it is ejected to whichever side its CENTRE happens to be on. `
            + `Embedded ${EMBED} m through the ${f.axis === 0 ? 'X' : 'Z'}${f.sign > 0 ? '+' : '-'} `
            + `face it came out the far side at ${endN.toFixed(2)}`);
        }
      }
      if (oob) {
        stuck.push(bi);
        report('OOB', `depen${bi}`,
          `a body ${EMBED} m inside ${fmtB(b)} was ejected out of the map (${oob}) `
          + `to ${fmtP(player.position)}`);
      }
    }
  }
  console.log(`\n  depenetration: ${runs} bodies embedded ${EMBED} m through an exposed face, `
    + `${freed} pushed back out the way they came in`);
  if (stuck.length === 0) ok('no collider can permanently trap the body');
  else bad('no collider can permanently trap the body', `${stuck.length} colliders can`);
  console.log(`                 ${thinEject} faces of colliders THINNER than the 0.72 m body ejected `
    + `the body to the far side (inherent: a body wider than the wall has no correct side)`);
  if (wrongSide.length === 0) ok('the depenetrator never pushes the body through to the far side');
  else bad('the depenetrator never pushes the body to the far side', `${wrongSide.length} faces do`);
}

// ═════════════════════════════════════════════════════════════════ 9. SLITS ══════════
//
// Two boxes that were meant to touch but leave a gap. A gap narrower than the body
// (0.72 m) must not be passable at any speed or angle; a gap wider than it must not
// wedge the body. Every co-planar pair on the map is measured, then driven at.

function slitTest() {
  const slits = [];
  const n = boxes.length;
  for (let i = 0; i < n; i++) {
    const a = boxes[i];
    for (let j = i + 1; j < n; j++) {
      const c = boxes[j];
      // Both must be tall enough to be WALLS — a 15 cm kerb is stepped over, not
      // squeezed between — and they must share at least a body's worth of height.
      if (a.max.y - a.min.y < 1.0 || c.max.y - c.min.y < 1.0) continue;
      const yOverlap = Math.min(a.max.y, c.max.y) - Math.max(a.min.y, c.min.y);
      if (yOverlap < 1.0) continue;
      for (const ax of [0, 2]) {
        const other = ax === 0 ? 2 : 0;
        const k = ax === 0 ? 'x' : 'z', ko = other === 0 ? 'x' : 'z';
        if (a.min[ko] > c.max[ko] - 0.3 || c.min[ko] > a.max[ko] - 0.3) continue;
        const gap = a.min[k] > c.max[k] ? a.min[k] - c.max[k]
          : c.min[k] > a.max[k] ? c.min[k] - a.max[k] : -1;
        if (gap <= 0.001 || gap > 1.4) continue;
        const lo = a.min[k] > c.max[k] ? c.max[k] : a.max[k];
        slits.push({ a, c, ax, gap, mid: lo + gap / 2 });
      }
    }
  }

  let drives = 0;
  const fails = [];
  const narrow = slits.filter((s) => s.gap < 0.72);
  for (const s of slits) {
    const { a, c, ax } = s;
    const other = ax === 0 ? 2 : 0;
    const ko = other === 0 ? 'x' : 'z';
    const oLo = Math.max(a.min[ko], c.min[ko]), oHi = Math.min(a.max[ko], c.max[ko]);
    const oMid = (oLo + oHi) / 2;
    const yLo = Math.max(a.min.y, c.min.y) + 0.02;
    for (const dir of [1, -1]) {
      const start = { x: 0, y: yLo, z: 0 };
      start[ax === 0 ? 'x' : 'z'] = s.mid;
      start[ko] = oMid - dir * 1.6;
      if (world._overlapAny(start.x, start.y, start.z, RADIUS, STAND)) continue;
      for (const sp of (QUICK ? [11] : [4.6, 9.5, 11])) {
        drives++;
        place(start.x, start.y, start.z);
        const v = { x: 0, y: 0, z: 0 };
        v[ko] = dir * sp;
        let through = false, worst = 0;
        for (let t = 0; t < 80; t++) {
          player.velocity.set(v.x, 0, v.z);
          tick();
          const hit = insideAny(0);
          if (hit && hit.depth > worst) worst = hit.depth;
          const cur = player.position[ko];
          if (dir > 0 ? cur > oMid + 0.9 : cur < oMid - 0.9) { through = true; break; }
        }
        if (through && s.gap < 0.72) {
          fails.push(s);
          report('SLIT', `${s.gap.toFixed(2)}m@${s.mid.toFixed(1)}`,
            `a ${(s.gap * 100).toFixed(0)} cm gap between ${fmtB(a)} and ${fmtB(c)} `
            + `let a 72 cm body through at ${sp} u/s`);
        }
        if (worst > PEN_TOL) {
          fails.push(s);
          report('SLIT-INSIDE', `${s.gap.toFixed(2)}m@${s.mid.toFixed(1)}`,
            `driving the ${(s.gap * 100).toFixed(0)} cm gap between ${fmtB(a)} and ${fmtB(c)} `
            + `embedded the body ${worst.toFixed(3)} m`);
        }
      }
    }
  }
  console.log(`\n  slits: ${slits.length} co-planar gaps under 1.4 m found `
    + `(${narrow.length} narrower than the 0.72 m body), ${drives} drives`);
  if (fails.length === 0) ok('no gap narrower than the body is passable, and none wedges it');
  else bad('no gap narrower than the body is passable', `${fails.length} events`);
}

// ── run ──────────────────────────────────────────────────────────────────────────────
const t0 = Date.now();
if (want('tunnel')) tunnelTest();
if (want('corner')) cornerTest();
if (want('mantle')) mantleTest();
if (want('slide')) slideTest();
if (want('stance')) stanceTest();
if (want('fall')) fallTest();
if (want('escape')) escapeTest();
if (want('crouch')) crouchTest();
if (want('depen')) depenTest();
if (want('slit')) slitTest();

console.log(`\n─── findings ───────────────────────────────────────────────────────────`);
if (findings.size === 0) {
  console.log('  none.');
} else {
  const byKind = new Map();
  for (const f of findings.values()) {
    if (!byKind.has(f.kind)) byKind.set(f.kind, []);
    byKind.get(f.kind).push(f);
  }
  for (const [kind, list] of byKind) {
    const total = list.reduce((a, f) => a + f.count, 0);
    console.log(`\n  ${kind} — ${list.length} distinct sites, ${total} reproductions`);
    const show = VERBOSE ? list : list.slice(0, 12);
    for (const f of show) console.log(`    • ${f.detail}${f.count > 1 ? `  (×${f.count})` : ''}`);
    if (show.length < list.length) console.log(`    … ${list.length - show.length} more (--verbose)`);
  }
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`} — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(failures === 0 ? 0 : 1);
