/** TEMP (world lane): dump world.group draw-call breakdown. */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';

const ROOT = 'C:/Users/Jamie/Desktop/Code Projects/overstrike';
const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5231, strictPort: false }, logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 180000, polling: 250 });

const out = await page.evaluate(() => {
  const w = window.__GAME__.world;
  const rows = [];
  for (const c of w.group.children) {
    const geo = c.geometry;
    const tri = geo ? (geo.index ? geo.index.count : geo.attributes.position.count) / 3 : 0;
    const n = c.isInstancedMesh ? c.count : 1;
    rows.push({ name: c.name || c.type, kind: c.isInstancedMesh ? 'INST' : 'MESH', n, tri: Math.round(tri * n), cast: c.castShadow });
  }
  return { rows, stats: w.buildStats, children: w.group.children.length };
});
out.rows.sort((a, b) => b.tri - a.tri);
console.log('children:', out.children, 'stats:', JSON.stringify(out.stats));
if (process.argv.includes('--all')) {
  for (const r of out.rows) console.log(`${r.kind}\t${r.cast ? 'S' : ' '}\t${String(r.n).padStart(4)}\t${String(r.tri).padStart(7)}\t${r.name}`);
}
const shadow = out.rows.filter((r) => r.cast).length;
console.log('shadow casters', shadow, 'world draw estimate', out.children + shadow);
if (errs.length) console.log('ERRORS:', [...new Set(errs)].slice(0, 10));
await browser.close();
await server.close();
