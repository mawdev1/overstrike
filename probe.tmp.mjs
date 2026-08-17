/** Triangle / draw-call / framing census for every weapon. No screenshots. */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';

const ROOT = 'C:/Users/Jamie/Desktop/Code Projects/overstrike';
const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5298, strictPort: false }, logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.setDefaultTimeout(300000);
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 300000, polling: 250 });
await page.evaluate(() => window.__GAME__.startMatch({ mode: 'tdm', botCount: 1, difficulty: 'regular' }));
await page.waitForTimeout(1500);

const out = await page.evaluate(() => {
  const g = window.__GAME__;
  const p = g.player;
  const ids = ['ar_vector', 'ar_havoc', 'ar_falcon', 'smg_wasp', 'smg_kestrel',
    'lmg_bulwark', 'sr_reaver', 'dmr_meridian', 'sg_breacher', 'pistol_viper'];
  const vm = g.weapons.viewmodel;
  const rows = [];
  const FOV = 70, T = Math.tan(FOV * Math.PI / 360);
  // Build every weapon through the public path.
  g.weapons.giveLoadout(p, ids);
  for (let i = 0; i < ids.length; i++) g.weapons.switchTo(p, i, true);
  for (const id of ids) {
    const e = vm.cache.get(id);
    if (!e) { rows.push({ id, missing: true }); continue; }
    let meshes = 0, tris = 0;
    const mats = new Set();
    e.group.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      mats.add(o.material.name || [...g.assets.materials.entries()].find((kv) => kv[1] === o.material)?.[0] || '?');
      const idx = o.geometry.index;
      tris += (idx ? idx.count : o.geometry.attributes.position.count) / 3;
    });
    // Screen framing at 16:9 and 21:9 (three keeps vertical fov, so only x changes).
    const depth = -e.hipPos.z;
    const half = depth * T;
    const bottom = (e.hipPos.y + e.bbox.minY) / (-(e.hipPos.z) * T);
    rows.push({
      id, meshes, tris,
      mats: [...mats].sort().join(','),
      hip: e.hipPos.toArray().map((v) => +v.toFixed(3)),
      reticleY: +e.reticle.position.y.toFixed(4),
      opticBelowCentrePct: +(100 * (-e.hipPos.y - e.reticle.position.y) / half).toFixed(1),
      lowestPointPctOfHalfHeight: +(100 * -bottom).toFixed(1),
      xPct169: +(100 * e.hipPos.x / (half * 16 / 9)).toFixed(1),
      xPct219: +(100 * e.hipPos.x / (half * 21 / 9)).toFixed(1),
      adsPos: e.adsPos.toArray().map((v) => +v.toFixed(3)),
    });
  }
  return { rows, draws: g.engine.stats.drawCalls, tris: g.engine.stats.triangles };
});

for (const r of out.rows) {
  if (r.missing) { console.log(r.id, 'MISSING'); continue; }
  console.log(
    `${r.id.padEnd(14)} tri=${String(r.tris).padStart(4)} draws=${String(r.meshes).padStart(2)}` +
    ` optic=-${String(r.opticBelowCentrePct).padStart(4)}%h  low=${String(r.lowestPointPctOfHalfHeight).padStart(5)}%h` +
    ` x16:9=${String(r.xPct169).padStart(4)}%  x21:9=${String(r.xPct219).padStart(4)}%  hip=[${r.hip}]  mats=${r.mats}`);
}
console.log('scene draws', out.draws, 'scene tris', out.tris);
if (errs.length) console.log('ERRORS', [...new Set(errs)].slice(0, 6));
await browser.close();
await server.close();
