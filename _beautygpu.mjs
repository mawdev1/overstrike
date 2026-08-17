/**
 * Beauty shots from fixed vantage points.
 *
 * The smoke harness wanders randomly, which makes it useless for judging whether a
 * lighting or material change actually helped. This parks the camera at the same
 * handful of viewpoints every run so screenshots are comparable between iterations.
 *
 * Usage: node scripts/beauty.mjs [--out=shots/beauty] [--scale=1]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const OUT = path.resolve(ROOT, arg('out', 'shots/beauty'));
const SCALE = Number(arg('scale', 0.6));

await mkdir(OUT, { recursive: true });

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5206, strictPort: false }, logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(180000);
await page.addInitScript((s) => {
  try {
    const KEY = 'overstrike.settings.v1';
    const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
    localStorage.setItem(KEY, JSON.stringify({ ...cur, renderScale: s }));
  } catch { /* private mode */ }
}, SCALE);

const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 180000, polling: 250 });

await page.evaluate(() => {
  const g = window.__GAME__;
  g.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'regular' });
});
await page.waitForTimeout(2500);

/**
 * Pick vantage points from the map itself rather than hand-guessed coordinates:
 * sweep every spawn point for the heading with the longest clear view, keep the most
 * open ones, and spread them across the map so we do not shoot the same corner twice.
 */
const SHOTS = await page.evaluate(() => {
  const g = window.__GAME__;
  const THREE_V = g.player.position.constructor;
  const eye = new THREE_V(), dir = new THREE_V();
  const cands = [];
  for (const sp of g.world.spawnPoints) {
    for (let i = 0; i < 24; i++) {
      const yaw = (i / 24) * Math.PI * 2;
      eye.set(sp.position.x, sp.position.y + 1.62, sp.position.z);
      dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      const hit = g.world.raycast(eye, dir, 90);
      const openness = hit ? hit.distance : 90;
      cands.push({ x: sp.position.x, y: sp.position.y, z: sp.position.z, yaw, openness });
    }
  }
  cands.sort((a, b) => b.openness - a.openness);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= 6) break;
    // Spread the shots out — at least 14 m between chosen viewpoints.
    if (picked.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 14)) continue;
    picked.push(c);
  }
  return picked.map((c, i) => ({
    name: `view-${i + 1}-open${Math.round(c.openness)}m`,
    pos: [c.x, c.y, c.z],
    yaw: c.yaw,
    pitch: -0.04,
  }));
});
console.log('[beauty] vantage points:', SHOTS.map((s) => s.name).join(', '));

for (const s of SHOTS) {
  await page.evaluate((shot) => {
    const g = window.__GAME__;
    const p = g.player;
    p.position.set(shot.pos[0], shot.pos[1], shot.pos[2]);
    p.velocity.set(0, 0, 0);
    p.yaw = shot.yaw;
    p.pitch = shot.pitch;
    if (p.camera) {
      p.camera.baseYaw = shot.yaw;
      p.camera.basePitch = shot.pitch;
      p.camera.recoilPitch = p.camera.recoilYaw = 0;
      p.camera.recoilPitchTarget = p.camera.recoilYawTarget = 0;
    }
    // Hold the trigger off and let a couple of frames settle the camera rig.
    g.input.actions.clear();
    g.input.buttons[0] = g.input.buttons[2] = false;
  }, s);
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, `${s.name}.png`) });
  console.log(`[beauty] ${s.name}`);
}

const stats = await page.evaluate(() => ({
  draws: window.__GAME__.engine.stats.drawCalls,
  tris: window.__GAME__.engine.stats.triangles,
  exposure: window.__GAME__.engine.renderer.toneMappingExposure,
  sun: window.__GAME__.engine.sun.intensity,
}));
console.log('[beauty] stats', JSON.stringify(stats));
if (errs.length) console.log('[beauty] page errors:', [...new Set(errs)].slice(0, 5));
console.log(`[beauty] -> ${OUT}`);

await browser.close();
await server.close();
