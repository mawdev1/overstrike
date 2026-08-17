/** TEMP: screenshots from hand-chosen vantage points. node _look.mjs [outdir] */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = 'C:/Users/Jamie/Desktop/Code Projects/overstrike';
const OUT = path.resolve(ROOT, process.argv[2] || 'shots/look');
await mkdir(OUT, { recursive: true });

// [name, x, y, z, yaw, pitch]
const SHOTS = [
  ['a-hall-from-south', 0, 0, 26, 0.0, 0.10],
  ['b-hall-from-north', 2, 0, -24, Math.PI, 0.10],
  ['c-hall-roof', 0, 8.05, 9.5, 0.0, 0.06],
  ['d-oldtown-court', -25, 0, 6, 0.35, 0.06],
  ['e-oldtown-rampart', -38.0, 3.95, 8, 0.0, 0.02],
  ['f-harbour-road', 25, 0, 18, 0.02, 0.04],
  ['g-warehouse-in', 25, 0, -20, 0.0, 0.0],
  ['h-quay', 38, 0, 24, 0.1, 0.02],
  ['i-hall-inside', 0, 0.15, 8, 0.0, 0.0],
  ['j-gate', -18.5, 0, -3, 1.5707, 0.02],
  ['k-hall-east', 20, 0, 0, -1.5707, 0.06],
  ['l-oldtown-out', -20, 0, -20, -0.9, 0.10],
];

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5221, strictPort: false }, logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(180000);
await page.addInitScript(() => {
  try {
    const KEY = 'overstrike.settings.v1';
    const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
    localStorage.setItem(KEY, JSON.stringify({ ...cur, renderScale: 0.6 }));
  } catch { /* ignore */ }
});
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 180000, polling: 250 });
await page.evaluate(() => window.__GAME__.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'regular' }));
await page.waitForTimeout(2500);
console.log('[look] state', await page.evaluate(() => (window.__GAME__ ? window.__GAME__.state + ' player=' + !!window.__GAME__.player : 'NO GAME')));
if (errs.length) console.log('[look] boot errors:', [...new Set(errs)].slice(0, 6));

for (const [name, x, y, z, yaw, pitch] of SHOTS) {
  await page.evaluate((s) => {
    const g = window.__GAME__;
    const p = g.player;
    if (!p) return;
    p.alive = true; p.health = p.maxHealth;
    p.position.set(s[1], s[2], s[3]);
    p.velocity.set(0, 0, 0);
    p.yaw = s[4]; p.pitch = s[5];
    if (p.camera) {
      p.camera.baseYaw = s[4]; p.camera.basePitch = s[5];
      p.camera.recoilPitch = p.camera.recoilYaw = 0;
      p.camera.recoilPitchTarget = p.camera.recoilYawTarget = 0;
    }
    g.input.actions.clear();
    g.input.buttons[0] = g.input.buttons[2] = false;
  }, [name, x, y, z, yaw, pitch]);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}
const stats = await page.evaluate(() => ({
  draws: window.__GAME__.engine.stats.drawCalls,
  tris: window.__GAME__.engine.stats.triangles,
  colliders: window.__GAME__.world.buildStats.colliders,
  buildMs: Math.round(window.__GAME__.world.buildStats.buildMs),
}));
console.log('[look] stats', JSON.stringify(stats));
if (errs.length) console.log('[look] errors:', [...new Set(errs)].slice(0, 6));
await browser.close();
await server.close();
