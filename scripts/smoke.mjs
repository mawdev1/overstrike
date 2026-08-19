/**
 * Headless runtime verification for OVERSTRIKE.
 *
 * Boots a real Vite dev server, opens the game in headless Chromium with a software
 * GL backend, drives the player with synthetic input, and reports:
 *   - any console error / page exception / failed request
 *   - boot success and time
 *   - frame rate, draw calls, triangle count under load
 *   - that the player actually moves, shoots, hits, and that bots are alive and moving
 *   - screenshots at each stage
 *
 * Usage: node scripts/smoke.mjs [--headed] [--seconds=12] [--out=shots]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const HEADED = argv.includes('--headed');
const PLAY_SECONDS = Number(arg('seconds', 12));
const OUT = path.resolve(ROOT, arg('out', 'shots'));

const report = {
  ok: false,
  bootMs: null,
  errors: [],
  warnings: [],
  stages: {},
  perf: null,
  gameplay: null,
};

const fail = (msg) => { report.errors.push(msg); };

let server, browser;
try {
  await mkdir(OUT, { recursive: true });

  server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    server: { port: 5199, strictPort: false },
    logLevel: 'warn',
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  console.log(`[smoke] dev server ${url}`);

  browser = await chromium.launch({
    headless: !HEADED,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--disable-gpu-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--window-size=1600,900',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.setDefaultTimeout(120000);

  // Headless Chromium rasterises through SwiftShader on the CPU, so a full-resolution
  // bloom + composite chain can take seconds per frame. Drop the internal render scale
  // for the harness only — it changes nothing about the logic under test.
  await page.addInitScript(() => {
    try {
      const KEY = 'overstrike.settings.v1';
      const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
      // Render scale only — shadow and post settings stay at their defaults so the
      // screenshots represent what a player actually sees.
      localStorage.setItem(KEY, JSON.stringify({ ...cur, renderScale: 0.5 }));
    } catch { /* private mode */ }
  });

  const IGNORE = [
    /Multiple instances of Three.js/i,
    /WebGL.*deprecated/i,
    /SwiftShader/i,
    /Automatic fallback to software WebGL/i,
    /GroupMarkerNotSet/i,
  ];
  page.on('console', (m) => {
    const text = m.text();
    if (IGNORE.some((r) => r.test(text))) return;
    if (m.type() === 'error') report.errors.push(`console.error: ${text}`);
    else if (m.type() === 'warning') report.warnings.push(`console.warn: ${text}`);
  });
  page.on('pageerror', (e) => report.errors.push(`pageerror: ${e.message}\n${(e.stack || '').split('\n').slice(0, 5).join('\n')}`));
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText || '';
    if (/ERR_ABORTED/.test(f)) return;
    report.errors.push(`requestfailed: ${r.url()} — ${f}`);
  });

  // ---------------------------------------------------------------- boot
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const booted = await page
    .waitForFunction(() => {
      const g = window.__GAME__;
      return !!(g && g.state === 'menu');
    }, null, { timeout: 120000, polling: 250 })
    .then(() => true)
    .catch(() => false);

  report.bootMs = Date.now() - t0;

  if (!booted) {
    const bootErr = await page.evaluate(() => document.querySelector('#boot .boot-error pre')?.textContent || null);
    fail(`game did not reach the menu within 120 s${bootErr ? `\n  boot error: ${bootErr}` : ''}`);
    await page.screenshot({ path: path.join(OUT, '00-boot-failed.png') });
    throw new Error('boot failed');
  }
  console.log(`[smoke] booted in ${report.bootMs} ms`);
  await page.screenshot({ path: path.join(OUT, '01-menu.png') });
  report.stages.menu = true;

  // A short settle so the menu animation finishes before we measure anything.
  await page.waitForTimeout(600);

  // ---------------------------------------------------------------- start match
  const started = await page.evaluate(() => {
    const g = window.__GAME__;
    try {
      g.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'regular' });
      return { ok: true, state: g.state };
    } catch (e) {
      return { ok: false, error: e.message + '\n' + (e.stack || '') };
    }
  });
  if (!started.ok) fail(`startMatch threw: ${started.error}`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, '02-match-start.png') });
  report.stages.matchStarted = started.ok;

  // ---------------------------------------------------------------- drive the player
  // Pointer lock is unavailable headless, so we poke the input layer directly.
  await page.evaluate(() => {
    const g = window.__GAME__;
    g.__probe = {
      startPos: g.player.position.clone(),
      lastPos: g.player.position.clone(),
      startTime: g.time,
      pathLen: 0,
      maxSpeed: 0,
      shots: 0,
      hits: 0,
      damageEvents: 0,
      kills: 0,
      deaths: 0,
      botMoved: 0,
      fpsSamples: [],
      drawCalls: 0,
      triangles: 0,
      errors: [],
    };
    const p = g.__probe;
    g.bus.on('shot', () => p.shots++);
    g.bus.on('hit', () => p.hits++);
    g.bus.on('damage', () => p.damageEvents++);
    g.bus.on('kill', (e) => {
      p.kills += e.attacker === g.player ? 1 : 0;
      p.deaths += e.victim === g.player ? 1 : 0;
    });

    // Synthetic input driver: walks, looks around, and fires in bursts.
    // It steers away from obstructions, otherwise it grinds into the first wall it
    // meets and the "did the player move" assertion measures nothing.
    let t = 0;
    let stuckFor = 0;
    let turning = 0;
    const botStart = (g.bots?.bots || []).map((b) => b.position.clone());
    g.__driver = setInterval(() => {
      t += 1 / 30;
      const inp = g.input;
      inp.enabled = true;
      inp.actions.clear();

      const speed = Math.hypot(g.player.velocity.x, g.player.velocity.z);
      if (speed < 1.2) stuckFor += 1 / 30; else stuckFor = Math.max(0, stuckFor - 1 / 15);
      // Blocked for a moment → commit to a hard turn for ~0.6 s.
      if (stuckFor > 0.5 && turning <= 0) { turning = 0.6; stuckFor = 0; }

      inp.actions.add('forward');
      if (turning > 0) {
        turning -= 1 / 30;
        inp.mouseDX += 26;                       // swing away from the obstruction
        inp.actions.add(Math.sin(t) > 0 ? 'left' : 'right');
      } else {
        if (Math.sin(t * 0.7) > 0.3) inp.actions.add('left');
        if (Math.sin(t * 0.7) < -0.3) inp.actions.add('right');
        if (Math.sin(t * 0.31) > 0.5) inp.actions.add('sprint');
        if (Math.sin(t * 1.9) > 0.93) inp.actions.add('jump');
        inp.mouseDX += Math.cos(t * 0.55) * 9;
        inp.mouseDY += Math.sin(t * 0.37) * 2.2;
      }
      // Fire in bursts, aim down sights half the time.
      inp.buttons[0] = Math.sin(t * 2.3) > 0.1;
      inp.buttons[2] = Math.sin(t * 0.9) > 0.4;

      const sp = Math.hypot(g.player.velocity.x, g.player.velocity.z);
      if (sp > p.maxSpeed) p.maxSpeed = sp;
      // DISTANCE TRAVELLED, accumulated. The assertion used straight-line displacement
      // from the spawn, which is not the same thing at all: the driver steers with a sine
      // wave, so a run that happens to curve back scores near zero having moved the whole
      // time. That made this fail about one run in three (4.8, 9.1, 2.8 m against a 3 m
      // gate) with nothing wrong.
      p.pathLen += g.player.position.distanceTo(p.lastPos);
      p.lastPos.copy(g.player.position);
      p.fpsSamples.push(g.engine.stats.fps);
      p.drawCalls = Math.max(p.drawCalls, g.engine.stats.drawCalls);
      p.triangles = Math.max(p.triangles, g.engine.stats.triangles);

      const bots = g.bots?.bots || [];
      let moved = 0;
      for (let i = 0; i < bots.length; i++) {
        if (botStart[i] && bots[i].position.distanceTo(botStart[i]) > 1.5) moved++;
      }
      p.botMoved = Math.max(p.botMoved, moved);
    }, 1000 / 30);
  });

  const half = Math.max(1, Math.floor(PLAY_SECONDS / 2));
  await page.waitForTimeout(half * 1000);
  await page.screenshot({ path: path.join(OUT, '03-gameplay-a.png') });
  await page.waitForTimeout(half * 1000);
  await page.screenshot({ path: path.join(OUT, '04-gameplay-b.png') });

  const probe = await page.evaluate(() => {
    const g = window.__GAME__;
    clearInterval(g.__driver);
    g.input.actions.clear();
    g.input.buttons[0] = g.input.buttons[2] = false;
    const p = g.__probe;
    const fps = p.fpsSamples.filter((v) => v > 0);
    fps.sort((a, b) => a - b);
    return {
      moved: p.pathLen,
      displaced: g.player.position.distanceTo(p.startPos),
      // Per SIMULATED second, not per wall-clock second. Under SwiftShader this page runs
      // at roughly 10 fps, and how much simulation fits in the fixed play window swings
      // with machine load — so raw distance swung 6.6-15.6 m on a build that was working
      // perfectly. Average speed is the property actually being asserted: that the player
      // moves when told to.
      simSeconds: Math.max(0.001, g.time - p.startTime),
      avgSpeed: p.pathLen / Math.max(0.001, g.time - p.startTime),
      maxSpeed: p.maxSpeed,
      shots: p.shots,
      hits: p.hits,
      damageEvents: p.damageEvents,
      kills: p.kills,
      deaths: p.deaths,
      botCount: (g.bots?.bots || []).length,
      botsAlive: (g.bots?.bots || []).filter((b) => b.alive).length,
      botMoved: p.botMoved,
      playerHealth: g.player.health,
      playerAmmo: g.player.weapon?.ammo ?? null,
      playerWeapon: g.player.weapon?.def?.name ?? null,
      matchTime: g.match?.timeRemaining ?? null,
      scores: g.match?.scores ?? null,
      fpsMedian: fps.length ? fps[Math.floor(fps.length / 2)] : 0,
      fpsMin: fps.length ? fps[0] : 0,
      fpsP10: fps.length ? fps[Math.floor(fps.length * 0.1)] : 0,
      drawCalls: p.drawCalls,
      triangles: p.triangles,
      state: g.state,
    };
  });
  report.gameplay = probe;
  report.perf = {
    fpsMedian: probe.fpsMedian, fpsP10: probe.fpsP10, fpsMin: probe.fpsMin,
    drawCalls: probe.drawCalls, triangles: probe.triangles,
  };

  // ---------------------------------------------------------------- assertions
  if (probe.avgSpeed < 0.6) {
    fail(`player barely moved (${probe.moved.toFixed(2)} m over ${probe.simSeconds.toFixed(1)} s of simulation, ` +
      `${probe.avgSpeed.toFixed(2)} m/s average) — movement or collision is broken`);
  }
  if (probe.maxSpeed < 2) fail(`player never reached walking speed (max ${probe.maxSpeed.toFixed(2)} u/s)`);
  if (probe.shots < 5) fail(`only ${probe.shots} shots fired in ${PLAY_SECONDS}s — weapons are not firing`);
  if (probe.botCount === 0) fail('no bots spawned');
  else if (probe.botMoved === 0) fail('no bot moved more than 1.5 m — AI navigation is dead');
  if (probe.drawCalls > 400) report.warnings.push(`draw calls high: ${probe.drawCalls}`);
  if (probe.triangles > 900000) report.warnings.push(`triangle count high: ${probe.triangles}`);
  if (probe.state !== 'playing' && probe.state !== 'gameover') fail(`unexpected game state "${probe.state}"`);

  // ---------------------------------------------------------------- pause + menus
  await page.evaluate(() => window.__GAME__.setPaused(true));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '05-pause.png') });
  report.stages.paused = await page.evaluate(() => window.__GAME__.state === 'paused');
  if (!report.stages.paused) fail('setPaused(true) did not put the game in the paused state');

  await page.evaluate(() => window.__GAME__.setPaused(false));
  await page.waitForTimeout(300);

  await page.evaluate(() => window.__GAME__.returnToMenu());
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, '06-back-to-menu.png') });
  report.stages.returnedToMenu = await page.evaluate(() => window.__GAME__.state === 'menu');
  if (!report.stages.returnedToMenu) fail('returnToMenu() did not return to the menu state');

  report.ok = report.errors.length === 0;
} catch (err) {
  fail(`harness: ${err.message}`);
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
}

await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

console.log('\n================ SMOKE REPORT ================');
console.log(`boot: ${report.bootMs} ms`);
if (report.perf) {
  console.log(`perf: fps median ${report.perf.fpsMedian} / p10 ${report.perf.fpsP10} / min ${report.perf.fpsMin}` +
    `  draws ${report.perf.drawCalls}  tris ${report.perf.triangles}`);
}
if (report.gameplay) {
  const g = report.gameplay;
  console.log(`play: moved ${g.moved?.toFixed(1)} m (${g.avgSpeed?.toFixed(2)} m/s avg), maxSpeed ${g.maxSpeed?.toFixed(1)}, shots ${g.shots}, hits ${g.hits}, ` +
    `damage ${g.damageEvents}, kills ${g.kills}, deaths ${g.deaths}, bots ${g.botsAlive}/${g.botCount} (moved ${g.botMoved}), ` +
    `hp ${g.playerHealth}, ammo ${g.playerAmmo}, weapon ${g.playerWeapon}`);
}
if (report.warnings.length) {
  console.log(`\n${report.warnings.length} warning(s):`);
  for (const w of [...new Set(report.warnings)].slice(0, 20)) console.log('  ! ' + w);
}
if (report.errors.length) {
  console.log(`\n${report.errors.length} ERROR(S):`);
  for (const e of [...new Set(report.errors)].slice(0, 30)) console.log('  ✗ ' + e);
}
console.log(`\nscreenshots -> ${OUT}`);
console.log(report.ok ? '✓ SMOKE PASSED' : '✗ SMOKE FAILED');
console.log('==============================================\n');
process.exit(report.ok ? 0 : 1);
