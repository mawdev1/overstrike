import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';

const MODE = process.argv[2] || 'all';
const ROOT = 'C:/Users/Jamie/Desktop/Code Projects/overstrike';
const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 0, strictPort: false }, logLevel: 'info',
});
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(180000);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));
page.on('crash', () => errs.push('PAGE CRASHED'));
page.on('framenavigated', (f) => { if (f === page.mainFrame()) errs.push('NAVIGATED ' + f.url()); });
page.on('console', (m) => { const t = m.text(); if (/error|lost|Lost|WARN|fail/i.test(t)) errs.push('[c] ' + t.slice(0,200)); });
page.on('requestfailed', (r) => errs.push('REQFAIL ' + r.url().slice(0,120)));
await page.addInitScript(() => {
  try {
    const KEY = 'overstrike.settings.v1';
    const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
    localStorage.setItem(KEY, JSON.stringify({ ...cur, renderScale: 0.6 }));
  } catch { /* private mode */ }
});
const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 180000, polling: 250 });
console.log('boot ms', Date.now() - t0);
await page.evaluate((m) => {
  const e = window.__GAME__.engine;
  if (m === 'noao') e.aoPass.enabled = false;
  if (m === 'nobloom') e.bloomPass.enabled = false;
  if (m === 'noview') e.viewPass.enabled = false;
  if (m === 'nopost') { e.aoPass.enabled = false; e.bloomPass.enabled = false; }
  window.__GAME__.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'regular' });
}, MODE);
if (MODE === 'bench') {
  const cfgs = [
    ['all',      () => {}],
    ['noshadow', (e) => { e.renderer.shadowMap.enabled = false; }],
    ['nopost',   (e) => { e.aoPass.enabled = false; e.bloomPass.enabled = false; e.compositePass.enabled = false; }],
    ['nosky',    (e) => { e.sky.visible = false; }],
    ['basicmat', (e) => { e.scene.overrideMaterial = e.sky.material.constructor === Object ? null : new (Object.getPrototypeOf(window.__GAME__.assets.mat('rubber')).constructor)({}); }],
  ];

  for (const [name, fn] of cfgs) {
    await page.evaluate(`(${fn.toString()})(window.__GAME__.engine)`);
    await page.waitForTimeout(1500);
    const f0 = await page.evaluate(() => window.__GAME__.frame);
    await page.waitForTimeout(6000);
    const f1 = await page.evaluate(() => window.__GAME__.frame);
    console.log(name.padEnd(9), ((f1 - f0) / 6).toFixed(2), 'fps  ', (6000 / Math.max(1, f1 - f0)).toFixed(0), 'ms/frame');
  }
} else {
  await page.waitForTimeout(5000);
}
try {
  const stats = await page.evaluate(() => {
    const g = window.__GAME__;
    return { state: g.state, draws: g.engine.stats.drawCalls, tris: g.engine.stats.triangles, fps: g.engine.stats.fps, ms: Math.round(g.engine.stats.frameMs) };
  });
  console.log('stats', JSON.stringify(stats));
} catch { console.log('stats unavailable (page gone)'); }
try {
  await page.screenshot({ path: `shots/probe-${MODE}.png`, timeout: 60000 });
  console.log('shot ok', MODE);
} catch { console.log('shot FAIL', MODE); }
if (MODE === 'ctxloss') {
  const r = await page.evaluate(async () => {
    const g = window.__GAME__;
    const seen = [];
    g.bus.on('contextLost', () => seen.push('lost'));
    g.bus.on('contextRestored', () => seen.push('restored'));
    const ext = g.renderer.getContext().getExtension('WEBGL_lose_context');
    ext.loseContext();
    await new Promise((res) => setTimeout(res, 800));
    const mid = { events: seen.slice(), running: g.engine._contextLost };
    ext.restoreContext();
    await new Promise((res) => setTimeout(res, 2500));
    return { mid, events: seen.slice(), lostFlag: g.engine._contextLost, frame: g.frame, draws: g.engine.stats.drawCalls };
  });
  console.log('ctxloss', JSON.stringify(r));
  await page.waitForTimeout(1500);
  try { await page.screenshot({ path: 'shots/probe-ctxloss-after.png', timeout: 60000 }); console.log('post-restore shot ok'); }
  catch { console.log('post-restore shot FAIL'); }
}
console.log('errors', JSON.stringify([...new Set(errs)].slice(0, 8)));
await browser.close();
await server.close();
