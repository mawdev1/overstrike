/**
 * Weapon inspection harness: parks the player at a fixed open viewpoint and
 * screenshots every weapon in the roster, reporting triangle / draw counts.
 *
 * node <this> [--out=shots/guns] [--scale=0.6] [--ads=0] [--only=ar_vector]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = 'C:/Users/Jamie/Desktop/Code Projects/overstrike';
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const OUT = path.resolve(ROOT, arg('out', 'shots/guns'));
const SCALE = Number(arg('scale', 0.6));
const ADS = arg('ads', '0') === '1';
const ONLY = arg('only', '');

await mkdir(OUT, { recursive: true });

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5211, strictPort: false }, logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(240000);
await page.addInitScript((s) => {
  try {
    const KEY = 'overstrike.settings.v1';
    const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
    localStorage.setItem(KEY, JSON.stringify({ ...cur, renderScale: s }));
  } catch { /* private mode */ }
}, SCALE);

const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 240000, polling: 250 });
await page.evaluate(() => window.__GAME__.startMatch({ mode: 'tdm', botCount: 2, difficulty: 'regular' }));
await page.waitForTimeout(2000);

// Park somewhere with a long clear view so the gun reads against distance.
const spot = await page.evaluate(() => {
  const g = window.__GAME__;
  const V = g.player.position.constructor;
  const eye = new V(), dir = new V();
  let best = null;
  for (const sp of g.world.spawnPoints) {
    for (let i = 0; i < 24; i++) {
      const yaw = (i / 24) * Math.PI * 2;
      eye.set(sp.position.x, sp.position.y + 1.62, sp.position.z);
      dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      const hit = g.world.raycast(eye, dir, 90);
      const openness = hit ? hit.distance : 90;
      if (!best || openness > best.openness) {
        best = { x: sp.position.x, y: sp.position.y, z: sp.position.z, yaw, openness };
      }
    }
  }
  return best;
});
console.log('[guns] vantage openness', Math.round(spot.openness), 'm');

const IDS = (await page.evaluate(() => window.__GAME__.weapons && Object.keys(
  Object.fromEntries(Object.entries(window.__WEAPONS__ || {}))
))) || null;

const LIST = ONLY ? ONLY.split(',') : [
  'ar_vector', 'ar_havoc', 'ar_falcon', 'smg_wasp', 'smg_kestrel',
  'lmg_bulwark', 'sr_reaver', 'dmr_meridian', 'sg_breacher', 'pistol_viper',
];

const rows = [];
// One loadout holding the whole roster, then plain slot switches: rebuilding the
// loadout per weapon churned the renderer hard enough to crash swiftshader.
await page.evaluate(({ ids, s }) => {
  const g = window.__GAME__;
  const p = g.player;
  p.position.set(s.x, s.y, s.z);
  p.velocity.set(0, 0, 0);
  p.yaw = s.yaw; p.pitch = -0.04;
  g.weapons.giveLoadout(p, ids);
}, { ids: LIST, s: spot });
await page.waitForTimeout(600);

for (let i = 0; i < LIST.length; i++) {
  const id = LIST[i];
  await page.evaluate(({ i, s, ads }) => {
    const g = window.__GAME__;
    const p = g.player;
    p.position.set(s.x, s.y, s.z);
    p.velocity.set(0, 0, 0);
    p.yaw = s.yaw; p.pitch = -0.04;
    if (p.camera) {
      p.camera.baseYaw = s.yaw; p.camera.basePitch = -0.04;
      p.camera.recoilPitch = p.camera.recoilYaw = 0;
      p.camera.recoilPitchTarget = p.camera.recoilYawTarget = 0;
    }
    g.input.actions.clear();
    g.input.buttons[0] = g.input.buttons[2] = false;
    g.weapons.switchTo(p, i, true);
    const inst = g.weapons.current(p);
    if (inst) { inst.state = 'idle'; inst.stateTimer = 0; inst.wantAds = ads; }
    const vm = g.weapons.viewmodel;
    if (vm) { vm.lowerAmount = 0; vm.switchT = 0; vm.switchDir = 0; }
  }, { i, s: spot, ads: ADS });
  await page.waitForTimeout(ADS ? 1500 : 700);
  await page.screenshot({ path: path.join(OUT, `${id}.png`) });

  const info = await page.evaluate((id) => {
    const g = window.__GAME__;
    const e = g.weapons.viewmodel.cache.get(id);
    if (!e) return null;
    let meshes = 0, tris = 0;
    e.group.traverse((o) => {
      if (o.isMesh) {
        meshes++;
        const idx = o.geometry.index;
        tris += (idx ? idx.count : o.geometry.attributes.position.count) / 3;
      }
    });
    return {
      meshes, tris,
      hip: e.hipPos.toArray().map((v) => +v.toFixed(3)),
      draws: g.engine.stats.drawCalls,
      worldTris: g.engine.stats.triangles,
    };
  }, id);
  rows.push({ id, ...info });
  console.log(`[guns] ${id.padEnd(14)} meshes=${String(info.meshes).padStart(3)} tris=${String(info.tris).padStart(4)} hip=[${info.hip}] draws=${info.draws}`);
}

console.log('[guns] TOTAL draws now', rows[rows.length - 1]?.draws, 'worldTris', rows[rows.length - 1]?.worldTris);
if (errs.length) console.log('[guns] page errors:', [...new Set(errs)].slice(0, 8));
console.log(`[guns] -> ${OUT}`);

await browser.close();
await server.close();
