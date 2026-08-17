/**
 * Boot profiler: loads the game N times with the REAL GPU and reports the boot timeline.
 * Usage: node bootprof.mjs [--runs=3] [--prod] [--label=before]
 */
import { createServer, preview, build } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';

const ROOT = 'C:/Users/Jamie/Desktop/Code Projects/overstrike';
const argv = process.argv.slice(2);
const arg = (k, d) => { const h = argv.find((a) => a.startsWith(`--${k}=`)); return h ? h.split('=').slice(1).join('=') : d; };
const RUNS = Number(arg('runs', 3));
const PROD = argv.includes('--prod');
const LABEL = arg('label', 'run');

let server, url;
if (PROD) {
  await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error' });
  server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), preview: { port: 5222, strictPort: false }, logLevel: 'error' });
  url = server.resolvedUrls.local[0];
} else {
  server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), server: { port: 5221, strictPort: false }, logLevel: 'error' });
  await server.listen();
  url = server.resolvedUrls.local[0];
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'],
});

// Warm the dev server (dep pre-bundling triggers a full reload on the first hit,
// which would destroy the execution context mid-measurement) and the disk cache.
{
  const w = await browser.newPage();
  await w.goto(url, { waitUntil: 'domcontentloaded' });
  await w.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 180000, polling: 100 }).catch(() => {});
  await w.close();
}

const results = [];
for (let i = 0; i < RUNS; i++) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(180000);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

  // Longest-task observer: how long is the main thread actually blocked?
  await page.addInitScript(() => {
    window.__LONGTASKS__ = [];
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__LONGTASKS__.push([+e.startTime.toFixed(1), +e.duration.toFixed(1)]); })
        .observe({ entryTypes: ['longtask'] });
    } catch { /* unsupported */ }
    window.__PAINTS__ = [];
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__PAINTS__.push([e.name, +e.startTime.toFixed(1)]); })
        .observe({ entryTypes: ['paint'] });
    } catch { /* unsupported */ }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__BOOTPROF__?.firstFrame > 0, null, { timeout: 180000, polling: 50 });
  const r = await page.evaluate(() => ({
    prof: window.__BOOTPROF__,
    longtasks: window.__LONGTASKS__,
    paints: window.__PAINTS__,
    nav: performance.getEntriesByType('navigation').map((n) => ({ dcl: +n.domContentLoadedEventStart.toFixed(1) })),
  }));
  r.errors = errs;
  results.push(r);
  await ctx.close();
}

await browser.close();
if (PROD) server.httpServer?.close?.(); else await server.close();

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pick = (f) => med(results.map(f));

console.log(`\n===== BOOT PROFILE [${LABEL}] ${PROD ? 'PROD' : 'DEV'} — median of ${RUNS} =====`);
console.log(`first-paint         ${med(results.map((r) => r.paints.find((p) => p[0] === 'first-paint')?.[1] ?? -1)).toFixed(1)} ms`);
console.log(`first-contentful    ${med(results.map((r) => r.paints.find((p) => p[0] === 'first-contentful-paint')?.[1] ?? -1)).toFixed(1)} ms`);
console.log(`module eval         ${pick((r) => r.prof.moduleEval).toFixed(1)} ms`);
console.log(`boot UI painted     ${pick((r) => r.prof.bootPainted).toFixed(1)} ms`);
console.log(`Game constructed    ${pick((r) => r.prof.gameConstructed).toFixed(1)} ms`);
console.log(`MENU (interactive)  ${pick((r) => r.prof.menu).toFixed(1)} ms`);
console.log(`first rendered frm  ${pick((r) => r.prof.firstFrame).toFixed(1)} ms`);
console.log('--- phases (ms, median) ---');
const names = results[0].prof.phases.map((p) => p[0]);
for (let i = 0; i < names.length; i++) {
  console.log(`  ${names[i].padEnd(24)} ${med(results.map((r) => r.prof.phases[i]?.[1] ?? 0)).toFixed(1)}`);
}
console.log('--- long tasks (>50ms blocking), median run ---');
const mid = results[Math.floor(results.length / 2)];
let blocked = 0;
for (const [s, d] of mid.longtasks) { blocked += d - 50; console.log(`  @${s.toFixed(0).padStart(6)} ms  for ${d.toFixed(0)} ms`); }
console.log(`  total blocking time (TBT): ${blocked.toFixed(0)} ms over ${mid.longtasks.length} long tasks`);
const allErrs = [...new Set(results.flatMap((r) => r.errors))];
if (allErrs.length) console.log('ERRORS:\n  ' + allErrs.slice(0, 10).join('\n  '));
console.log('='.repeat(58) + '\n');
