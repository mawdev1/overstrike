/**
 * Isolated, repeatable timing for the texture library.
 *
 * Runs against a PRODUCTION build served by `vite preview` — no file watcher, no HMR,
 * so a concurrent edit elsewhere in the repo cannot reload the page mid-measurement
 * (which it does, constantly, on the dev server).
 *
 * Usage: node _assetbench.mjs
 */
import { build, preview } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error' });
const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), preview: { port: 5244, strictPort: false }, logLevel: 'error' });
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'] });
const page = await browser.newPage();
page.setDefaultTimeout(180000);
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 180000, polling: 100 });

const out = await page.evaluate(async () => {
  window.__GAME__.stop();   // the 120 Hz render loop would otherwise steal the timings
  await new Promise((r) => setTimeout(r, 300));
  const Assets = window.__GAME__.assets.constructor;
  const runs = [];
  for (let r = 0; r < 9; r++) {
    const a = new Assets();
    const units = a._plan();
    const times = [];
    const t0 = performance.now();
    for (const u of units) { const t = performance.now(); u(); times.push(+(performance.now() - t).toFixed(2)); }
    a._finish();
    const total = +(performance.now() - t0).toFixed(2);
    a.dispose();
    runs.push({ total, times });
  }
  return runs;
});

console.log('\n=== assets generation, isolated, PROD build (run 0 = cold/un-JITted) ===');
out.forEach((r, i) => console.log(`run ${i}: total ${String(r.total).padStart(7)} ms   units: ${r.times.join(', ')}`));
const totals = out.map((r) => r.total);
const warm = totals.slice(1).sort((a, b) => a - b);
console.log(`\ncold (run 0): ${totals[0]} ms`);
console.log(`warm min:     ${warm[0]} ms   (median ${warm[Math.floor(warm.length / 2)]} ms)`);
const unitMin = out[0].times.map((_, i) => Math.min(...out.slice(1).map((r) => r.times[i])));
console.log(`warm min per unit: ${unitMin.join(', ')}`);
console.log();

await browser.close();
server.httpServer?.close?.();
process.exit(0);
