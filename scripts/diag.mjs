/**
 * Focused diagnostic probe. Boots the game headless and interrogates specific
 * subsystems directly, without the noise of the full smoke run.
 *
 * Because headless Chromium rasterises in software, wall-clock FPS is meaningless here.
 * We measure CPU simulation cost instead (fixedUpdate time), which is the number that
 * actually tells us whether the game logic is fast enough.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5201, strictPort: false }, logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 120000, polling: 200 });

const result = await page.evaluate(async () => {
  const g = window.__GAME__;
  const out = {};
  const V = g.player.position.constructor;

  g.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'regular' });
  await new Promise((r) => setTimeout(r, 500));

  // ---- 1. where did the player spawn, and is it legal?
  const p = g.player;
  out.spawn = { x: +p.position.x.toFixed(2), y: +p.position.y.toFixed(2), z: +p.position.z.toFixed(2) };
  out.spawnPoints = g.world.spawnPoints.length;

  // Is the spawn point inside a collider?
  const inside = g.world.boxes.filter((b) => {
    const eps = 0.001;
    return p.position.x > b.min.x - 0.36 - eps && p.position.x < b.max.x + 0.36 + eps &&
           p.position.y > b.min.y - eps && p.position.y < b.max.y + eps &&
           p.position.z > b.min.z - 0.36 - eps && p.position.z < b.max.z + 0.36 + eps;
  });
  out.spawnInsideColliders = inside.length;

  // ---- 2. can world.move actually translate the player in open air?
  // Drive it directly, bypassing the player controller entirely.
  const testPos = p.position.clone();
  const vel = new V(0, 0, 0);
  let travelled = 0;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  out.moveByDirection = {};
  for (const [dx, dz] of dirs) {
    const pos = p.position.clone();
    const v = new V(dx * 4.6, 0, dz * 4.6);
    for (let i = 0; i < 120; i++) {
      v.y -= 22 * (1 / 120);
      const r = g.world.move(pos, v, 0.36, 1.8, 1 / 120);
      pos.copy(r.position); v.copy(r.velocity);
      v.x = dx * 4.6; v.z = dz * 4.6;
    }
    out.moveByDirection[`${dx},${dz}`] = +pos.distanceTo(p.position).toFixed(2);
  }

  // ---- 3. drive the actual player controller forward for 1 s of sim
  const before = p.position.clone();
  g.input.enabled = true;
  g.input.actions.clear();
  g.input.actions.add('forward');
  for (let i = 0; i < 120; i++) g.player.fixedUpdate(1 / 120);
  out.controllerForward1s = +p.position.distanceTo(before).toFixed(2);
  out.controllerVel = +Math.hypot(p.velocity.x, p.velocity.z).toFixed(2);
  out.grounded = !!p.grounded;
  g.input.actions.clear();

  // ---- 4. CPU simulation cost (the meaningful perf number headless)
  const t0 = performance.now();
  const N = 600;
  for (let i = 0; i < N; i++) g._fixedUpdate(1 / 120);
  out.simMsPerStep = +((performance.now() - t0) / N).toFixed(4);
  out.simStepsPerSecOfGameplay = 120;
  out.simBudgetUsedPct = +((out.simMsPerStep * 120 / 1000) * 100).toFixed(1);

  // ---- 5. weapon / ballistics sanity: shoot a bot point-blank
  const bot = g.bots.bots.find((b) => b.alive);
  out.botCount = g.bots.bots.length;
  if (bot) {
    const hpBefore = bot.health;
    // Put the player right in front of the bot, looking at it.
    p.position.set(bot.position.x, bot.position.y, bot.position.z + 3);
    p.yaw = Math.atan2(-(bot.position.x - p.position.x), -(bot.position.z - p.position.z));
    p.pitch = 0;
    const w = p.weapon;
    out.weapon = w?.def?.id ?? null;
    out.ammoBefore = w?.ammo ?? null;
    let fired = 0;
    for (let i = 0; i < 60; i++) {
      if (w?.tryFire?.()) fired++;
      w?.fixedUpdate?.(1 / 120);
    }
    out.firedShots = fired;
    out.ammoAfter = w?.ammo ?? null;
    out.botHpBefore = hpBefore;
    out.botHpAfter = bot.health;
    out.botDamaged = hpBefore - bot.health;
  }

  // ---- 6. bot movement over 2 s of real sim
  const botsBefore = g.bots.bots.map((b) => b.position.clone());
  for (let i = 0; i < 240; i++) g._fixedUpdate(1 / 120);
  out.botDistances = g.bots.bots.map((b, i) => +b.position.distanceTo(botsBefore[i]).toFixed(2));
  out.botsAlive = g.bots.bots.filter((b) => b.alive).length;

  // ---- 7. nav sanity
  out.navBaked = !!g.nav;
  if (g.nav?.findPath) {
    const a = g.world.spawnPoints[0].position, b = g.world.spawnPoints[g.world.spawnPoints.length - 1].position;
    const arr = [];
    const n = g.nav.findPath(a, b, arr);
    out.pathAcrossMapNodes = typeof n === 'number' ? n : (arr.length || 0);
  }

  out.drawCalls = g.engine.stats.drawCalls;
  out.triangles = g.engine.stats.triangles;
  return out;
});

console.log(JSON.stringify(result, null, 2));
if (logs.length) {
  console.log('\n--- console errors ---');
  for (const l of [...new Set(logs)].slice(0, 20)) console.log('  ' + l);
}

await browser.close();
await server.close();
