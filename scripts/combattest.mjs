/**
 * Does a shot fired by a real client actually hit anybody?
 *
 * Everything else in this repo proves movement. Nothing fires a weapon end to end, which
 * is why "shots do not hit enemies" can be true while the whole suite is green. This
 * closes that: a real Chromium page, the real client module graph, a real dedicated
 * server in another process, a real bot — and a real burst of bullets.
 *
 * Two cases, deliberately ordered so a failure narrows itself:
 *
 *   A. HEADLESS POINT BLANK — one process, loopback transport, shooter and target placed
 *      three metres apart with clear line of sight. If this fails the fault is in
 *      ballistics, lag compensation, or the damage gate. No network involved.
 *
 *   B. BROWSER vs BOT — the real thing. The client paths across the map on the nav grid,
 *      steers its aim onto a bot's torso, and pulls the trigger ONLY on ticks where the
 *      bot is in clear line of sight and the composed aim is within 0.02 rad of it. A
 *      burst fired at a wall, or while mis-aimed, proves nothing, so the test refuses to
 *      draw any conclusion from one — `fireTicks` is itself an assertion.
 *
 * Server-side truth comes from `/health?debug=1`, which carries per-entity health and a
 * tally of `shot`/`damage` bus events — see the debug block in server/index.js. Reading
 * the client's own opinion of whether it hit would be exactly the thing under suspicion.
 *
 * The assertions are ordered so the first failure names the stage: client fired ->
 * commands arrived -> server fired -> server hit -> target lost health. A failure at
 * "server fired" but not "client fired" is the command path; a failure at "server hit"
 * with the server firing is ballistics or lag compensation.
 *
 *   node scripts/combattest.mjs [--bots=6] [--headless-only]
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as THREE from 'three';
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';
import { GameServer } from '../src/net/server.js';
import { NetClient } from '../src/net/client.js';
import { createLoopbackPair } from '../src/net/transport.js';
import { Player } from '../src/player/player.js';
import { FIXED_DT } from '../src/core/mathUtils.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? Number(hit.split('=')[1]) : d;
};
const BOTS = arg('bots', 4);
const HEADLESS_ONLY = argv.includes('--headless-only');
const GS_PORT = 8179;

/**
 * Point the whole test at an already-running server instead of a local one.
 *
 *   node scripts/combattest.mjs --against=https://overstrike.fly.dev \
 *                               --server=wss://overstrike-gs.fly.dev \
 *                               --health=https://overstrike-gs.fly.dev
 *
 * Exists because "it works locally" is not the claim under test when a user reports that
 * their shots do not land in PRODUCTION. Real latency, a server that has been up for hours
 * with a tick count in the millions, a full bot roster and a match that has restarted
 * several times are all things a freshly spawned local server does not reproduce.
 */
const argOf = (k) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : null;
};
const AGAINST = argOf('against');          // page URL, or null for a local vite dev server
const REMOTE_WS = argOf('server');         // wss:// URL, or null for the local game server
const REMOTE_HEALTH = argOf('health');     // https:// origin serving /health

let failures = 0;
const ok = (n) => { console.log(`  ok   ${n}`); };
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const note = (n) => console.log(`       · ${n}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A command with everything off — the shape `Player.applyCommand` expects. */
const emptyCommand = () => ({
  wishForward: 0, wishRight: 0,
  jump: false, crouchPressed: false, reload: false, melee: false, grenade: false,
  interact: false, inspect: false, killstreak: false, lastWeapon: false,
  sprintDown: false, sprintUp: false, firePressed: false, aimButtonPressed: false,
  crouchHeld: false, toggleAdsMode: false, aimButtonHeld: false, fireHeld: false,
  sprintKeyHeld: false, breathHold: false, leanKeyHeld: false, leanRightKeyHeld: false,
  slot: -1, wheel: 0, deltaYaw: 0, deltaPitch: 0, baseYaw: 0, basePitch: 0, tick: 0,
});

const wrap = (a) => { let x = a; while (x > Math.PI) x -= Math.PI * 2; while (x < -Math.PI) x += Math.PI * 2; return x; };

// ═══════════════════════════════════════════════ A. headless, point blank ══
//
// The control. One process, no browser, no wire latency, no ambiguity about where the
// target is — the shooter is looking straight at a torso three metres away.

console.log('\ncombat: does a fired shot land?\n');
console.log('A. headless point blank');

async function headlessCase() {
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter() });
  game.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 4242 });
  game.match.phase = 'live';
  game.match.countdown = 0;

  const server = new GameServer(game);

  const [cT, sT] = createLoopbackPair({ latencyMs: 0, loss: 0 });
  const shooter = game.player;
  const session = server.addClient(sT, shooter);
  const client = new NetClient(cT);

  // The victim: a second Player, on the OTHER team so friendly fire cannot mask a hit.
  const target = new Player(game);
  await target.init();
  game.addEntity(target);
  game.weapons.giveLoadout(target, ['ar_vector', 'pistol_sidewinder']);
  target.respawn?.();
  target.team = shooter.team === 0 ? 1 : 0;

  // Both on flat open ground, target three metres due -Z of the shooter (which is yaw 0
  // by `dirFromAngles`). Placed from the shooter's own spawn so the surface underfoot is
  // real map geometry rather than a guess.
  // `heal` is deliberately separate from `pin`: pinning runs every tick to hold the target
  // still, and a version of this that also reset health every tick reported 8 damage
  // events against a target whose health "never changed".
  const pin = () => {
    target.position.set(shooter.position.x, shooter.position.y, shooter.position.z - 3);
    target.velocity.set(0, 0, 0);
    target._updateHitboxes?.();
  };
  const heal = () => { target.alive = true; target.health = 100; };
  pin(); heal();

  // Spawn protection would refuse the damage for a reason that has nothing to do with
  // ballistics. Reported rather than silently cleared, then cleared, so the test measures
  // one thing.
  const wasProtected = game.match.isProtected(target);
  game.match.clearProtection(target);
  game.match.clearProtection(shooter);

  // Aim at the torso. hitboxes[1] is the torso box, centred at height*0.611.
  const eye = new THREE.Vector3();
  shooter.getEyePosition(eye);
  const tx = target.position.x, ty = target.position.y + target.height * 0.611, tz = target.position.z;
  const dx = tx - eye.x, dy = ty - eye.y, dz = tz - eye.z;
  const wantYaw = Math.atan2(-dx, -dz);
  const wantPitch = Math.asin(dy / Math.hypot(dx, dy, dz));
  shooter.setAngles(wantYaw, wantPitch);

  // The loopback delivers on a clock the caller advances — `pump()` with no argument is
  // `Math.max(now, undefined)` = NaN and delivers nothing at all, silently.
  let ms = 0;
  const stepOnce = (mut) => {
    const cmd = emptyCommand();
    cmd.tick = client.latestTick;
    cmd.baseYaw = shooter.baseYaw;
    cmd.basePitch = shooter.basePitch;
    mut?.(cmd);
    client.sendCommand(cmd);
    ms += FIXED_DT * 1000;
    sT.pump(ms);
    server.tick();
    cT.pump(ms);
  };

  // Settle first: lag compensation rewinds ~100 ms, and a target teleported one tick ago
  // has no history at the new spot. 40 ticks (> HISTORY_TICKS) fills the ring, which is
  // also what a standing player in a real match looks like.
  for (let i = 0; i < 40; i++) { pin(); heal(); stepOnce(); }

  const healthBefore = target.health;
  const shotsBefore = shooter.weapon?.shotsFired ?? 0;

  let damageEvents = 0, damageTotal = 0, shotEvents = 0;
  game.bus.on('shot', (e) => { if (e.shooter === shooter) shotEvents++; });
  game.bus.on('damage', (e) => {
    if (e.attacker === shooter && e.target === target) { damageEvents++; damageTotal += e.amount || 0; }
  });

  // The burst: firePressed on the first tick, fireHeld throughout — the shape a real
  // client sends, and `_updateWeapon` only pulls the trigger on `fireHeld`.
  for (let i = 0; i < 90; i++) {
    pin();
    stepOnce((c) => { c.fireHeld = true; if (i === 0) c.firePressed = true; });
  }

  const out = {
    wasProtected,
    healthBefore, healthAfter: target.health,
    rounds: (shooter.weapon?.shotsFired ?? 0) - shotsBefore,
    shotEvents, damageEvents, damageTotal: +damageTotal.toFixed(1),
    ammo: shooter.weapon?.ammo, weapon: shooter.weapon?.def?.id,
    rttMs: +session.rttMs.toFixed(1),
    rewinds: server.lag.stats.rewinds,
    distance: 3,
    targetTeam: target.team, shooterTeam: shooter.team,
  };

  note(`weapon ${out.weapon}, ${out.rounds} rounds left the barrel, ammo ${out.ammo}`);
  note(`server rtt ${out.rttMs} ms, ${out.rewinds} lag-comp rewinds`);
  note(`teams: shooter ${out.shooterTeam} vs target ${out.targetTeam}, spawn-protected at start: ${out.wasProtected}`);
  note(`damage events ${out.damageEvents}, total ${out.damageTotal}`);

  if (out.rounds === 0) bad('the weapon actually fires', 'no rounds left the barrel — the trigger never resolved');
  else ok(`the weapon fired ${out.rounds} rounds`);

  if (out.healthAfter < out.healthBefore) {
    ok(`point-blank burst took the target from ${out.healthBefore} to ${out.healthAfter}`);
  } else {
    bad('a point-blank burst damages the target',
      `health unchanged at ${out.healthAfter} after ${out.rounds} rounds`);
  }
  return out;
}

await headlessCase();

if (HEADLESS_ONLY) {
  console.log(failures ? `\n${failures} FAILED` : '\nheadless combat lands');
  process.exit(failures ? 1 : 0);
}

// ═══════════════════════════════════════════════════ B. browser vs bot ══

console.log('\nB. browser client vs a server bot');

const { createServer } = await import('vite');
const { chromium } = await import('playwright');

const gs = REMOTE_WS ? null : spawn(process.execPath, [path.join(ROOT, 'server/index.js'), `--port=${GS_PORT}`, `--bots=${BOTS}`], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
});
let gsLog = '';
gs?.stdout.on('data', (d) => { gsLog += d; });
gs?.stderr.on('data', (d) => { gsLog += d; });

const HEALTH_ORIGIN = REMOTE_HEALTH || `http://127.0.0.1:${GS_PORT}`;
const health = async (debug = false) => (await fetch(`${HEALTH_ORIGIN}/health${debug ? '?debug=1' : ''}`)).json();

let up = false;
for (let i = 0; i < 120 && !up; i++) {
  await sleep(200);
  try { up = (await fetch(`${HEALTH_ORIGIN}/health`)).ok; } catch { /* not yet */ }
}
if (!up) { bad('the game server starts', gsLog.slice(-800)); gs?.kill('SIGKILL'); process.exit(1); }
ok(`the dedicated server is up with ${BOTS} bots`);

const vite = AGAINST ? null : await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5225, strictPort: false, hmr: false, watch: null }, logLevel: 'error',
});
if (vite) await vite.listen();
const url = AGAINST || vite.resolvedUrls.local[0];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__GAME__ && window.__BOOTPROF__?.menu > 0, null, { timeout: 240000 });

// The render loop is deliberately not used: SwiftShader runs at ~10 fps and this test
// would end up measuring the software rasteriser. The session is stepped by hand, exactly
// as mptest.mjs does.
/**
 * Where `MultiplayerSession` lives in the page's module graph.
 *
 * A dev server serves the source path; a production build serves a hashed chunk, and the
 * hash changes every deploy. Discovered from the shipped entry chunk rather than
 * hardcoded, so this keeps working across deploys.
 */
let SESSION_MODULE = '/src/net/session.js';
if (AGAINST) {
  const html = await (await fetch(AGAINST)).text();
  const entry = html.match(/\/assets\/index-[A-Za-z0-9_.-]+\.js/)?.[0];
  const js = entry ? await (await fetch(new URL(entry, AGAINST))).text() : '';
  const chunk = js.match(/\.\/(session-[A-Za-z0-9_.-]+\.js)/)?.[1];
  if (!chunk) { bad('the shipped bundle contains the netcode', `no session chunk referenced from ${entry}`); }
  else SESSION_MODULE = `/assets/${chunk}`;
  note(`page ${AGAINST} -> ${SESSION_MODULE}`);
}

const joined = await page.evaluate(async ([gsUrl, sessionModule]) => {
  const g = window.__GAME__;
  g.stop();
  g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 1234 });
  g.match.phase = 'live'; g.match.countdown = 0;
  const { MultiplayerSession } = await import(sessionModule);
  try {
    const session = await MultiplayerSession.connect(g, gsUrl);
    window.__SESSION__ = session;

    // Command factory and one hand-driven tick, installed once so every phase below
    // sends exactly the same command shape a real client sends.
    window.__MK__ = () => ({
      wishForward: 0, wishRight: 0, jump: false, crouchPressed: false, reload: false,
      melee: false, grenade: false, interact: false, inspect: false, killstreak: false,
      lastWeapon: false, sprintDown: false, sprintUp: false, firePressed: false,
      aimButtonPressed: false, crouchHeld: false, toggleAdsMode: false,
      aimButtonHeld: false, fireHeld: false, sprintKeyHeld: false, breathHold: false,
      leanKeyHeld: false, leanRightKeyHeld: false, slot: -1, wheel: 0,
      deltaYaw: 0, deltaPitch: 0, baseYaw: 0, basePitch: 0, tick: 0,
    });
    return { ok: true, entityId: session.net.entityId, clientId: session.net.clientId };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}, [REMOTE_WS || `ws://127.0.0.1:${GS_PORT}`, SESSION_MODULE]);

if (!joined.ok) {
  bad('the browser joins the server', joined.error);
} else {
  ok(`the browser joined as entity ${joined.entityId}`);
}

/** Step the session `n` ticks with a per-tick command mutator, in the page. */
const drive = (n) => page.evaluate(async ({ n: ticks }) => {
  const s = window.__SESSION__;
  const g = window.__GAME__;
  for (let i = 0; i < ticks; i++) {
    const cmd = window.__MK__();
    s.sendCommand(cmd);
    s.updateRemotes();
    await new Promise((r) => setTimeout(r, 11));
  }
  return {
    snapshots: s.net.stats.snapshots,
    sent: s.net.stats.sent,
    remotes: [...s.remotes.values()].map((r) => ({ id: r.id, x: r.x, y: r.y, z: r.z, alive: r.alive, health: r.health, team: r.team })),
    self: { x: g.player.position.x, y: g.player.position.y, z: g.player.position.z, team: g.player.team, health: g.player.health, alive: g.player.alive },
  };
}, { n });

// Fill the snapshot buffer. Nothing can be aimed at before there is something to
// interpolate between.
const warm = await drive(60);
if (warm.snapshots > 10) ok(`snapshot buffer filled (${warm.snapshots} snapshots)`);
else bad('the client receives snapshots', `only ${warm.snapshots}`);

// ── acquisition, aim, and the burst ─────────────────────────────────────────────────
//
// Aim is client-owned: the server integrates `deltaYaw`/`deltaPitch` and only checks
// `baseYaw`/`basePitch` as a checksum. Steering means feeding deltas tick by tick,
// exactly as a mouse would.
//
// Three things this phase refuses to fudge:
//
//   TARGET  the nearest bot is usually behind a wall. A burst into concrete proves
//           nothing, so the target must have CLEAR LINE OF SIGHT from the eye, tested
//           with the client's own world raycast.
//   AIM     the trigger is only pulled on ticks where the composed aim (`yaw`/`pitch`,
//           recoil included — that is what shoots) is within 0.02 rad of the torso.
//   INPUT   `game.input` is live in a browser, and `Player._refreshHeldState` re-reads it
//           every fixed substep. A synthesized `fireHeld` alone is overwritten before the
//           weapon is updated, so the mouse button is held down for real.

const before = await health(true);
const beforeShots = (before.debug?.shots ?? []).find((s) => s.id === joined.entityId)?.n ?? 0;
const beforeSess = (before.sessions ?? [])[0] ?? {};

const engage = await page.evaluate(async () => {
  const s = window.__SESSION__;
  const g = window.__GAME__;
  const P = g.player;
  const wrap = (a) => { let x = a; while (x > Math.PI) x -= Math.PI * 2; while (x < -Math.PI) x += Math.PI * 2; return x; };
  const V = Object.getPrototypeOf(P.position).constructor;
  const eye = new V(), dir = new V();

  /**
   * The nearest living enemy the client can actually SEE, and where its torso is.
   * `hitboxes[1]` — the torso — is centred at height * 0.611, and `height` only exists
   * on the wire entity, not on the interpolated remote.
   */
  const pick = () => {
    const frame = s.net.interpolationAt();
    s.updateRemotes();
    P.getEyePosition(eye);
    let best = null;
    for (const r of s.remotes.values()) {
      if (!r.alive || r.team === P.team) continue;
      const wire = frame?.b?.entities.find((e) => e.id === r.id);
      const h = wire?.height ?? 1.8;
      const tx = r.x, ty = r.y + h * 0.611, tz = r.z;
      const dx = tx - eye.x, dy = ty - eye.y, dz = tz - eye.z;
      const dist = Math.hypot(dx, dy, dz);
      if (best && dist >= best.dist) continue;
      dir.set(dx / dist, dy / dist, dz / dist);
      const wall = g.world?.raycast?.(eye, dir, dist) ?? null;
      // Half a metre of slack: the ray ends inside the target's own volume, and a
      // world hit at exactly the target distance is the floor behind it.
      const clear = !wall || wall.distance >= dist - 0.5;
      best = {
        id: r.id, dist, clear,
        wallDist: wall ? wall.distance : Infinity,
        yaw: Math.atan2(-dx, -dz), pitch: Math.asin(dy / dist), tx, ty, tz,
        health: wire?.health ?? -1,
      };
    }
    return best;
  };

  // Below AIM_RESYNC_RAD (0.05) on purpose: a per-tick delta above that trips the
  // server's aim checksum, and this phase is measuring ballistics, not the checksum.
  // The checksum gets its own probe below.
  const MAX_STEP = 0.04;
  const AIM_OK = 0.02;

  let fired = 0, predictedHits = 0, hitmarkers = 0;
  // The user-visible symptom, measured where the player actually experiences it: the
  // hitmarker. It can arrive two ways — the client predicting the hit itself, or the
  // server replaying the feedback it recorded — and this counts either.
  const realHitmarker = g.present.hitmarker.bind(g.present);
  g.present.hitmarker = (...a) => { hitmarkers++; return realHitmarker(...a); };
  const onHit = (e) => { if (e.shooter === P) predictedHits++; };
  const onShot = (e) => { if (e.shooter === P) fired++; };
  g.bus.on('hit', onHit);
  g.bus.on('shot', onShot);

  /**
   * Engagement range, in metres.
   *
   * A client standing on its spawn never has a bot in the open — measured, not assumed:
   * the first version of this test sat still for 700 ticks with the nearest enemy 55 m
   * away and behind geometry on every single one. So the client WALKS at whatever it can
   * see until it is close and unobstructed, which is also what a player does.
   */
  const ENGAGE_M = 25;

  // Walking is done on the NAV GRID, not in a straight line.
  //
  // Measured, not assumed: a version of this that simply held W towards the nearest bot
  // wedged itself against a wall 28 m out and reported 0 clear-line-of-sight ticks in
  // 2400. The map has walls; a client that cannot path around them never gets a shot off,
  // and would have reported that as a combat failure. `game.nav` is the same A* the bots
  // walk on, and it is already built on the client.
  const waypoints = [];
  let wpCount = 0, wpIndex = 0, repathIn = 0;
  const goal = new V();
  const repath = (t) => {
    goal.set(t.tx, t.ty - 1.1, t.tz);
    wpCount = g.nav?.ready ? (g.nav.findPath(P.position, goal, waypoints) || 0) : 0;
    wpIndex = 0;
    repathIn = 60;
  };

  const trace = [];
  let ticks = 0, losTicks = 0, aimedTicks = 0, fireTicks = 0, noTargetTicks = 0, walkTicks = 0;
  let bestErr = Infinity, closest = Infinity;
  let pathFailures = 0;
  const seenIds = new Set();
  const wasEnabled = g.input.enabled;
  g.input.enabled = true;
  let stuckAt = null, stuckFor = 0;

  // 6000, not 2400. The engagement has to EARN its firing opportunity by pathing to a bot
  // that is itself moving and taking cover, so how long that takes varies a lot: observed
  // 0, 13, 18, 18, 46 and 184 aimed-and-unobstructed ticks across runs of 2400. Everything
  // below is gated on getting a real burst, so a short run did not fail honestly — it
  // cascaded six failures that all said "we never got to test this". Buying more time is
  // the cheap fix; the alternative is a test that reports flaky netcode when it means the
  // bot walked behind a wall.
  for (let i = 0; i < 6000; i++) {
    ticks++;
    const t = pick();
    const cmd = window.__MK__();
    let err = Infinity;
    if (t) {
      seenIds.add(t.id);
      if (t.dist < closest) closest = t.dist;
      if (t.clear) losTicks++;
      cmd.deltaYaw = Math.max(-MAX_STEP, Math.min(MAX_STEP, wrap(t.yaw - P.baseYaw)));
      cmd.deltaPitch = Math.max(-MAX_STEP, Math.min(MAX_STEP, t.pitch - P.basePitch));
      // Composed aim, not the base: recoil is part of where the bullet goes.
      err = Math.hypot(wrap(t.yaw - P.yaw), t.pitch - P.pitch);
      if (err < bestErr) bestErr = err;
      if (err < AIM_OK) aimedTicks++;
    } else {
      noTargetTicks++;
    }

    // Only shoot when the shot is honest: a visible enemy, and the crosshair on it.
    const shoot = !!(t && t.clear && err < AIM_OK && t.dist < ENGAGE_M);
    if (!shoot && t) {
      walkTicks++;
      if (--repathIn <= 0 || wpIndex >= wpCount) repath(t);
      if (wpCount === 0) pathFailures++;
      while (wpIndex < wpCount
        && Math.hypot(waypoints[wpIndex].x - P.position.x, waypoints[wpIndex].z - P.position.z) < 1.2) {
        wpIndex++;
      }
      if (wpIndex < wpCount) {
        // Move towards the waypoint while STILL FACING THE TARGET — the aim has to stay
        // converged, so this strafes rather than turning. The player's basis: forward is
        // (-sin yaw, -cos yaw), right is (cos yaw, -sin yaw).
        const wx = waypoints[wpIndex].x - P.position.x;
        const wz = waypoints[wpIndex].z - P.position.z;
        const wl = Math.hypot(wx, wz) || 1;
        const sy = Math.sin(P.yaw), cy = Math.cos(P.yaw);
        // Quantisation in `sendCommand` snaps this to one of the nine legal directions,
        // which is exactly what a keyboard produces anyway.
        cmd.wishForward = (wx / wl) * -sy + (wz / wl) * -cy;
        cmd.wishRight = (wx / wl) * cy + (wz / wl) * -sy;
      }
      const moved = Math.hypot(P.position.x - (stuckAt?.x ?? 1e9), P.position.z - (stuckAt?.z ?? 1e9));
      if (moved < 0.02) stuckFor++; else { stuckFor = 0; stuckAt = { x: P.position.x, z: P.position.z }; }
      // Wedged on a step: jump, and force a fresh path.
      if (stuckFor > 40 && stuckFor % 40 === 0) { cmd.jump = true; repathIn = 0; }
    }
    if (shoot) {
      fireTicks++;
      cmd.fireHeld = true;
      if (!window.__WASFIRING__) { cmd.firePressed = true; window.__WASFIRING__ = true; }
    } else {
      window.__WASFIRING__ = false;
    }
    // The real mouse button, because `_refreshHeldState` re-reads it every substep.
    g.input.buttons[0] = shoot;

    s.sendCommand(cmd);
    if (i % 100 === 0) {
      trace.push({
        i, id: t?.id ?? null,
        dist: t ? +t.dist.toFixed(1) : null,
        clear: t?.clear ?? null,
        wall: t ? +t.wallDist.toFixed(1) : null,
        me: [+P.position.x.toFixed(1), +P.position.y.toFixed(1), +P.position.z.toFixed(1)],
        him: t ? [+t.tx.toFixed(1), +t.ty.toFixed(1), +t.tz.toFixed(1)] : null,
        err: Number.isFinite(err) ? +err.toFixed(4) : null,
        fired,
      });
    }
    await new Promise((r) => setTimeout(r, 11));
  }

  g.input.buttons[0] = false;
  g.input.enabled = wasEnabled;
  // Let the trigger release reach the server and a few snapshots settle.
  for (let i = 0; i < 25; i++) {
    s.sendCommand(window.__MK__());
    s.updateRemotes();
    await new Promise((r) => setTimeout(r, 11));
  }
  g.present.hitmarker = realHitmarker;
  g.bus.off('hit', onHit);
  g.bus.off('shot', onShot);

  const lo = g.weapons?.getLoadout?.(P);
  return {
    ticks, losTicks, aimedTicks, fireTicks, noTargetTicks, walkTicks, closest, pathFailures,
    bestErr, trace,
    seenIds: [...seenIds],
    predictedShots: fired, predictedHits, hitmarkers,
    shotsFired: P.weapon?.shotsFired ?? 0,
    ammo: P.weapon?.ammo, weapon: P.weapon?.def?.id, slot: lo?.index ?? -1,
    alive: P.alive, health: P.health, sprinting: P.sprinting, moveState: P.moveState,
    sent: s.net.stats.sent, snapshots: s.net.stats.snapshots,
    // What the CLIENT's own simulation can shoot at. Remote players are held as plain
    // state in `session.remotes`, not as entities, so this is the set
    // `raycastEntities` sees during prediction.
    clientEntities: g.entities.length,
    clientEntityIds: g.entities.map((e) => e.id),
    remoteCount: s.remotes.size,
    corrections: s.prediction?.stats.corrections ?? -1,
    worstLiving: s.prediction?.stats.worstErrorLiving ?? -1,
  };
});


await sleep(300);
const after = await health(true);
const afterShots = (after.debug?.shots ?? []).find((s) => s.id === joined.entityId)?.n ?? 0;
const sess = (after.debug?.sessionRtt ?? []).find((s) => s.entity === joined.entityId);
const srvStats = (after.sessions ?? [])[0] ?? {};
// Every enemy this client shot at, not just one: the trigger follows whichever bot is
// visible, and pinning the assertion to a single id would report a miss whenever the
// engagement moved on.
const dmgRows = (after.debug?.damage ?? []).filter((d) => d.pair.startsWith(`${joined.entityId}>`));
const dmgHits = dmgRows.reduce((a, d) => a + d.hits, 0);
const dmgTotal = dmgRows.reduce((a, d) => a + d.total, 0);
const healthNow = new Map((after.debug?.entities ?? []).map((e) => [e.id, e]));
const healthWas = new Map((before.debug?.entities ?? []).map((e) => [e.id, e]));
// Health alone is not enough: a bot that took damage and then respawned is back at 100.
// The damage tally is the durable record; this is the corroboration.
const hurt = [...healthNow.values()].filter((e) => {
  const w = healthWas.get(e.id);
  return w && e.id !== joined.entityId && (e.health < w.health || (!e.alive && w.alive));
});

console.log('\n  ── diagnostics ──');
note(`engage:  ${engage.ticks} ticks — ${engage.noTargetTicks} no enemy, ${engage.walkTicks} closing, ${engage.losTicks} clear LOS, ${engage.aimedTicks} on target, ${engage.fireTicks} firing; closest approach ${engage.closest.toFixed(1)} m, ${engage.pathFailures} nav path failures`);
note(`engage:  enemies seen ${engage.seenIds.join(',') || 'none'}; best aim error ${(engage.bestErr * 1000).toFixed(2)} mrad`);
note(`engage:  trace ${engage.trace.map((t) => `
         ${t.i}: id${t.id ?? '-'} d${t.dist ?? '-'} wall${t.wall ?? '-'} ${t.clear ? 'LOS' : 'blk'} err${t.err ?? '-'} me${JSON.stringify(t.me)} him${JSON.stringify(t.him)}`).join(' ')}`);
note(`client:  weapon ${engage.weapon} slot ${engage.slot}, ammo ${engage.ammo}, ${engage.shotsFired} rounds fired locally`);
note(`client:  predicted shot events ${engage.predictedShots}, predicted entity hits ${engage.predictedHits}, hitmarkers shown ${engage.hitmarkers}`);
note(`client:  simulation holds ${engage.clientEntities} entities [${engage.clientEntityIds.join(",")}] and ${engage.remoteCount} interpolated remotes`);
note(`client:  shooter alive=${engage.alive} health=${engage.health} sprinting=${engage.sprinting} state=${engage.moveState}`);
note(`client:  prediction corrections ${engage.corrections}, worst live error ${(+engage.worstLiving).toFixed(3)} m`);
note(`wire:    commands sent ${engage.sent}, server consumed ${srvStats.commands ?? '?'}, ${srvStats.dropped ?? '?'} dropped, ${srvStats.duplicates ?? '?'} dup, ${srvStats.resyncs ?? '?'} aim resyncs`);
note(`server:  rtt ${sess?.rttMs ?? '?'} ms, queue ${sess?.queued ?? '?'}, lag-comp rewinds ${after.debug?.lagcomp?.rewinds ?? '?'} (missing history ${after.debug?.lagcomp?.missing ?? '?'})`);
note(`server:  rounds attributed to entity ${joined.entityId}: ${afterShots - beforeShots}`);
note(`server:  damage from ${joined.entityId}: ${dmgRows.length ? dmgRows.map((d) => `${d.pair} ${d.hits}x ${d.total.toFixed(0)} ${JSON.stringify(d.parts)}`).join(' | ') : 'NONE'}`);
note(`server:  entities that lost health: ${hurt.length ? hurt.map((e) => `${e.id}(${healthWas.get(e.id).health}->${e.health}${e.alive ? '' : ' dead'})`).join(' ') : 'none'}`);
note(`server:  match phase ${after.debug?.matchPhase}`);
console.log('');

// ── the assertions, ordered so the first failure names the stage ────────────────────

if (engage.seenIds.length > 0) ok(`the client saw ${engage.seenIds.length} enemy bot(s) in its snapshots`);
else bad('the client can see an enemy bot', 'no living enemy remote appeared in the interpolated set at all');

if (engage.losTicks > 0) ok(`clear line of sight on ${engage.losTicks}/${engage.ticks} ticks`);
else bad('a bot ever comes into the open', 'every enemy was behind map geometry for the whole engagement');

// The gate on everything below. Firing at a wall, or while mis-aimed, would produce a
// miss that says nothing about the netcode, so the test refuses to draw a conclusion.
if (engage.fireTicks > 20) ok(`the trigger was held for ${engage.fireTicks} ticks, all of them aimed and unobstructed`);
else {
  // NOT a failure. How big a burst the client earns depends on whether a bot happens to
  // hold still in the open, which is a property of the map and the AI, not of the netcode:
  // observed 14, 46, 144, 184 and 828 aimed-and-unobstructed ticks on identical builds.
  // Failing here made a working build red roughly one run in three, and the message said
  // "the netcode is broken" when it meant "the bot went behind a wall".
  //
  // The checks below are guarded on shots actually being fired instead, and the invariant
  // that matters — the shooter sees a hitmarker for every hit the server records — holds at
  // any burst size. The deterministic gate on hit registration is the headless point-blank
  // case above, which does not depend on bot behaviour at all.
  note(`thin engagement: only ${engage.fireTicks} aimed+visible ticks over ${engage.ticks} — ` +
    'conclusions below are drawn from a small burst');
}

// Counted from the client's own `shot` events, NOT from `weapon.shotsFired`. That counter
// is reset by a reload, and an engagement long enough to earn a real burst always reloads —
// so it read 0 while the client was demonstrably predicting 41 shots.
// Only assert the client fired if it ever had a chance to.
if (engage.fireTicks > 0 && engage.predictedShots > 0) ok(`the client predicted ${engage.predictedShots} rounds`);
else if (engage.fireTicks > 0) bad('the client fires at all', `${engage.fireTicks} ticks with the trigger held, ammo ${engage.ammo}, alive ${engage.alive} — the trigger never resolved on the client`);
else note('the client never had an aimed, unobstructed target to fire at');

if ((srvStats.commands ?? 0) > 100) ok(`the server consumed ${srvStats.commands} commands from this client`);
else bad('commands reach the server', `only ${srvStats.commands ?? 0} consumed of ${engage.sent} sent, ${srvStats.dropped ?? 0} dropped`);

// Guarded on the client actually having pulled the trigger: with no burst there is nothing
// to conclude, and asserting anyway reports the map as a netcode fault.
if (engage.predictedShots > 0) {
  if (afterShots - beforeShots > 0) ok(`the SERVER fired ${afterShots - beforeShots} rounds for this client`);
  else bad('the server runs the shot', 'the client fired but the server emitted no shot for this entity — the fire input did not survive the wire');

  if (dmgHits > 0) ok(`the server registered ${dmgHits} hits for ${dmgTotal.toFixed(1)} damage`);
  else note(`the server fired ${afterShots - beforeShots} rounds and landed none — plausible at range, inconclusive`);
} else {
  note('the client never fired, so the server-side chain is untested this run');
}

// What the SHOOTER experiences, as opposed to what the server records.
//
// Hitmarkers, blood and the flesh-hit sound are all produced by the CLIENT's own
// prediction, inside `fireHitscan` -> `raycastEntities` -> `game.entities`. If the client
// never predicts a hit the server is landing, the player gets no feedback whatsoever from
// a bullet that did 25 damage — which is indistinguishable, from behind the screen, from
// the shot not registering at all.
if (dmgHits > 0 && engage.hitmarkers === 0) {
  bad('the shooter gets feedback for the hits the server lands',
    `the server landed ${dmgHits} hits and the shooter was shown 0 hitmarkers. `
    + `The client predicted ${engage.predictedHits} hits of its own: its simulation holds `
    + `${engage.clientEntities} entit${engage.clientEntities === 1 ? 'y' : 'ies'} `
    + `(${engage.clientEntityIds.join(',')}) while tracking ${engage.remoteCount} remotes, so `
    + 'client-side ballistics has nothing to hit — and nothing arrives from the server either. '
    + 'From behind the screen a bullet that did 25 damage is indistinguishable from a miss');
} else if (dmgHits > 0) {
  ok(`the shooter was shown ${engage.hitmarkers} hitmarkers for ${dmgHits} server hits`);
}

if (hurt.length > 0 || dmgHits > 0) ok(`a bot took damage on the server: ${hurt.length ? hurt.map((e) => `${e.id} ${healthWas.get(e.id).health}->${e.health}`).join(', ') : `${dmgTotal.toFixed(0)} dealt (already respawned)`}`);
else bad('the target takes damage on the server', 'no entity lost health while this client was shooting at it');

// ── the aim checksum ────────────────────────────────────────────────────────────────
//
// A separate, narrow probe, because it confounds everything above when it fires.
// `GameServer._applyCommand` snaps a client's aim when its `baseYaw` checksum disagrees
// with the server's integration. The docs are explicit that this should only happen when
// a command is LOST. With zero dropped commands on a loopback-quality local socket, any
// resync at all is the server disagreeing with a client it received perfectly.
const resyncBefore = (beforeSess.resyncs ?? 0);
const fastTurn = await page.evaluate(async () => {
  const s = window.__SESSION__;
  // 0.07 rad per tick — a brisk but entirely ordinary flick, and above the 0.05 rad
  // AIM_RESYNC_RAD threshold.
  for (let i = 0; i < 60; i++) {
    const cmd = window.__MK__();
    cmd.deltaYaw = 0.07;
    s.sendCommand(cmd);
    await new Promise((r) => setTimeout(r, 11));
  }
  for (let i = 0; i < 20; i++) { s.sendCommand(window.__MK__()); await new Promise((r) => setTimeout(r, 11)); }
  return { baseYaw: window.__GAME__.player.baseYaw };
});
await sleep(200);
const afterTurn = await health(true);
const turnStats = (afterTurn.sessions ?? [])[0] ?? {};
const turnEnt = (afterTurn.debug?.entities ?? []).find((e) => e.id === joined.entityId);
const resyncsFromTurn = (turnStats.resyncs ?? 0) - (srvStats.resyncs ?? 0);
note(`turn:    60 commands of +0.07 rad yaw, ${turnStats.dropped ?? '?'} commands dropped, ${resyncsFromTurn} aim resyncs`);
note(`turn:    client baseYaw ${fastTurn.baseYaw.toFixed(4)} vs server yaw ${turnEnt?.yaw?.toFixed?.(4)}`);
if ((turnStats.dropped ?? 0) === 0 && resyncsFromTurn === 0) {
  ok('a fast turn over a clean connection causes no aim resync');
} else if ((turnStats.dropped ?? 0) === 0) {
  bad('a fast turn over a clean connection causes no aim resync',
    `${resyncsFromTurn} resyncs with 0 dropped commands — the server is snapping an aim it agreed with`);
}

const realErrors = pageErrors.filter((e) => !/WebGL|SwiftShader|KHR_parallel|GL Driver/i.test(e));
if (realErrors.length === 0) ok('the page logged no errors');
else bad('the page logs no errors', realErrors.slice(0, 4).join('\n       '));

await browser.close();
if (vite) await vite.close();
gs?.kill('SIGTERM');
await sleep(400);
gs?.kill('SIGKILL');

console.log(failures ? `\n${failures} FAILED` : '\nshots fired from a browser hit bots on the server');
process.exit(failures ? 1 : 0);
