/**
 * Simulation determinism harness.
 *
 * The authoritative-server work rests on one property: **the simulation must be a pure
 * function of (seed, tick sequence)** — never of the render clock. A browser at 144 fps,
 * a browser at 30 fps and a headless server that has no frames at all must all produce
 * bit-identical state from the same seed.
 *
 * This drives `game._fixedUpdate()` directly, which is what the server will do, and
 * varies only how `game.frame` advances underneath it, so anything in the simulation
 * that reads the render counter shows up as a divergence.
 *
 * Its blind spot is input: it injects none, so a frame-gated INPUT path cannot diverge
 * here however wrong it is. `Player._pumpLook()` still gates on `game.frame` and is
 * invisible to this harness for exactly that reason — it is covered by the command
 * refactor, not by this file.
 *
 * Usage: node scripts/determinism.mjs [--ticks=2400] [--headed]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const TICKS = Number(arg('ticks', 2400));          // 20 s of simulation at 120 Hz
const HEADED = argv.includes('--headed');

let server, browser, failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };

try {
  server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    server: { port: 5197, strictPort: false },
    logLevel: 'error',
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];

  browser = await chromium.launch({
    headless: !HEADED,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
  page.on('pageerror', (e) => bad('page error', e.message));

  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => window.__GAME__ && window.__BOOTPROF__?.menu > 0, null, { timeout: 180000 });

  /**
   * Run a match for `ticks` fixed steps, advancing `game.frame` once every
   * `ticksPerFrame` steps to imitate a given render rate, and digest the result.
   *
   * The game loop is bypassed entirely: `_fixedUpdate` is called directly, exactly as a
   * server would. `stop()` first, or rAF would keep stepping underneath us.
   */
  const run = async (ticksPerFrame, ticks, seed) => page.evaluate(
    ({ ticksPerFrame, ticks, seed }) => {
      const g = window.__GAME__;
      g.stop();
      g.startMatch({ mode: 'tdm', botCount: 8, difficulty: 'regular', seed });
      const DT = 1 / 120;
      for (let i = 0; i < ticks; i++) {
        if (ticksPerFrame > 0 && i % ticksPerFrame === 0) g.frame++;
        g._fixedUpdate(DT);
      }
      const r = (v) => Number(v).toFixed(4);
      const rows = [];
      for (const b of g.bots.bots) {
        rows.push([
          b.id, b.team, b.alive ? 1 : 0,
          r(b.position.x), r(b.position.y), r(b.position.z),
          r(b.velocity.x), r(b.velocity.z),
          r(b.yaw), r(b.pitch), r(b.health),
          b.state ?? '-', b.stats.kills, b.stats.deaths,
        ].join(','));
      }
      return { bots: rows.join('|'), scores: g.match.scores.join(':') };
    },
    { ticksPerFrame, ticks, seed },
  );

  console.log(`\nsimulation determinism (${TICKS} ticks, 8 bots, seed 12345)`);

  // 2 ticks/frame = a 60 fps client; 1 = 120 fps; 6 = a client stuck at 20 fps taking
  // the maximum substep burst; 0 = a headless server that never advances `frame`.
  const at60 = await run(2, TICKS, 12345);
  const at120 = await run(1, TICKS, 12345);
  const at20 = await run(6, TICKS, 12345);
  const headless = await run(0, TICKS, 12345);

  const cmp = (name, got) => {
    if (got.bots === at60.bots && got.scores === at60.scores) { ok(name); return; }
    const a = at60.bots.split('|'), b = got.bots.split('|');
    let detail = `scores ${at60.scores} vs ${got.scores}`;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) { detail = `first divergent bot:\n         60fps: ${a[i]}\n         this:  ${b[i]}`; break; }
    }
    bad(name, detail);
  };

  cmp('120 fps matches 60 fps', at120);
  cmp('20 fps (6-substep bursts) matches 60 fps', at20);
  cmp('headless (frame never advances) matches 60 fps', headless);

  // A different seed must actually change the outcome, or the checks above are vacuous.
  const other = await run(2, TICKS, 99999);
  if (other.bots === at60.bots) bad('a different seed changes the outcome', 'seed 99999 produced identical state — the digest is not sensitive');
  else ok('a different seed changes the outcome');

  // And the same seed at the same rate must repeat.
  const repeat = await run(2, TICKS, 12345);
  cmp('the same seed replays identically', repeat);

  // ── the clock ──────────────────────────────────────────────────────────────────
  //
  // Every deadline in the game is a comparison against `game.time`. It must be a pure
  // function of the tick, not an accumulation, or a state replayed forward lands on a
  // slightly different clock than it had the first time and deadlines flip.
  console.log('\nsimulation clock');
  const clock = await page.evaluate(() => {
    const g = window.__GAME__;
    g.stop();
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 3 });
    const DT = 1 / 120;
    for (let i = 0; i < 5000; i++) g._fixedUpdate(DT);
    const straight = g.time;
    const tick = g.tick;

    // The same 5000 ticks, reached in bursts of varying size the way a stuttering client
    // takes them. An accumulated clock is sensitive to the grouping; a derived one is not.
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 3 });
    const BURSTS = [1, 6, 2, 6, 3, 1, 6, 4];
    let n = 0, bi = 0;
    while (n < 5000) {
      const burst = Math.min(BURSTS[bi++ % BURSTS.length], 5000 - n);
      for (let k = 0; k < burst; k++, n++) g._fixedUpdate(DT);
    }

    // Getter-only, so an assignment either throws (strict mode — all game source) or is
    // a silent no-op (sloppy mode — here). Either way the clock stays tied to the tick.
    const before = g.time;
    try { g.time = 123; } catch { /* strict-mode callers get the throw */ }
    const survivedWrite = g.time === before;
    return { straight, bursty: g.time, tick, exact: tick * DT, survivedWrite };
  });

  if (clock.straight === clock.bursty) ok('the clock is identical however the ticks were batched');
  else bad('the clock is identical however the ticks were batched', `${clock.straight} vs ${clock.bursty}`);
  if (clock.straight === clock.exact) ok('time is exactly tick × 1/120 (derived, not accumulated)');
  else bad('time is exactly tick × 1/120', `${clock.straight} vs ${clock.exact} — the clock is being accumulated`);
  if (clock.survivedWrite) ok('game.time cannot be assigned away from the tick');
  else bad('game.time cannot be assigned away from the tick', 'a plain assignment changed it — the clock is not derived');

  // ── the eye invariant ──────────────────────────────────────────────────────────
  //
  // Bullets leave from `getEyePosition()`, and the camera renders from that same point
  // plus decorative bob/shake/punch. The eye springs (crouch smoothing, stair step,
  // landing) are simulation and must therefore be INSIDE the eye — when they lived on
  // the camera, the bullet left from up to 0.24 m away from the point the player was
  // looking through, at every range, because the offset translates the whole ray.
  console.log('\neye / fire-origin agreement');
  const eye = await page.evaluate(() => {
    const g = window.__GAME__;
    g.stop();
    g.startMatch({ mode: 'tdm', botCount: 2, difficulty: 'regular', seed: 7 });
    const THREE = g.player.position.constructor;
    const o = new THREE(); const e = new THREE();
    let worstOriginVsEye = 0, worstCamVsOrigin = 0, sawStep = 0, sawLand = 0, sawSlide = 0;
    for (let i = 0; i < 1500; i++) {
      // Every eye term has to actually move, or the two checks below prove nothing.
      // Walking onto stairs and sliding both need input plumbing that does not exist
      // until the command refactor, so those two are driven directly.
      if (i % 300 === 50) { g.player.position.y += 5; g.player.velocity.set(0, 0, 0); }
      if (i % 300 === 200) g.player.addEyeStep(0.25);
      g.player.slideAmount = (i % 300 >= 240 && i % 300 < 280) ? 1 : 0;
      g.frame++;
      g._fixedUpdate(1 / 120);
      g.player.camera.update(1 / 120);          // compose the render camera
      g.weapons.getFireOrigin(g.player, o);
      g.player.getEyePosition(e);
      worstOriginVsEye = Math.max(worstOriginVsEye, o.distanceTo(e));
      g.camera.getWorldPosition(e);
      worstCamVsOrigin = Math.max(worstCamVsOrigin, o.distanceTo(e));
      sawStep = Math.max(sawStep, Math.abs(g.player.eyeStep));
      sawLand = Math.max(sawLand, Math.abs(g.player.eyeLand));
      sawSlide = Math.max(sawSlide, Math.abs(g.player.slideDip));
    }
    return { worstOriginVsEye, worstCamVsOrigin, sawStep, sawLand, sawSlide };
  });

  if (eye.worstOriginVsEye < 1e-9) ok('the fire origin IS the simulated eye');
  else bad('the fire origin IS the simulated eye', `diverged by ${eye.worstOriginVsEye}`);

  // Bob/shake/punch are the only permitted disagreement, and this probe never moves or
  // fires, so all three are ~0 here. The threshold is set well below the smallest eye
  // term (slideDip, 13 cm) so that a spring escaping back onto the camera fails loudly
  // rather than hiding under a slack bound.
  const CAM_TOL = 0.05;
  if (eye.worstCamVsOrigin < CAM_TOL) ok(`camera sits on the eye to within ${(eye.worstCamVsOrigin * 100).toFixed(2)} cm (decorative only)`);
  else bad('camera sits on the eye', `worst disagreement ${(eye.worstCamVsOrigin * 100).toFixed(2)} cm — an eye term is on the camera but not in the eye`);

  // EVERY eye term must have moved, or the checks above are vacuous for the ones that
  // did not. Deliberately AND, not OR: an OR here let the landing half be entirely dead.
  const moved = [['step', eye.sawStep], ['land', eye.sawLand], ['slide dip', eye.sawSlide]];
  const dead = moved.filter(([, v]) => v <= 1e-4).map(([n]) => n);
  if (!dead.length) ok(`every eye term exercised (${moved.map(([n, v]) => `${n} ${v.toFixed(3)} m`).join(', ')})`);
  else bad('every eye term exercised', `never moved: ${dead.join(', ')} — untested for those terms`);
} finally {
  await browser?.close();
  await server?.close();
}

console.log(failures ? `\n${failures} FAILED` : '\nall determinism checks passed');
process.exit(failures ? 1 : 0);
