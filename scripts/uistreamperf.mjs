/**
 * P3-07 renderer measurement — REAL draw-call numbers for sector streaming on map
 * 'square-extraction', mapperf-style (vite dev server + headless Chromium on
 * SwiftShader, a real WebGLRenderer, counts read from `renderer.info.render`).
 *
 * `scripts/uistream.mjs` proves the streaming MECHANISM headlessly; this harness prices
 * it, closing the review gap "measurably reduces draw cost on square-extraction is a
 * claim, not a number". Per gameplay pose it measures four states (see the page module
 * `scripts/uistreamperf.page.mjs`): the merged pre-P3-07 baseline, the sectored build
 * with streaming off, streaming on, and a forced-castShadow control, and asserts:
 *
 *   1. streaming ON sheds draw calls vs streaming OFF (> 0 — the shadow passes of the
 *      NEAR sectors; on this complete-graph map nothing is ever HIDDEN, so castShadow
 *      stripping is the entire effect and this is the number that was missing);
 *   2. the control (castShadow forced back on) measures exactly the OFF number — the
 *      delta is proven to be shadow-pass stripping, not noise or lost geometry;
 *   3. the per-sector bucket split's price stays BOUNDED. Measured verdict (2026-08-22,
 *      SwiftShader, two gameplay poses): the split costs +19..+23 draw calls over the
 *      merged pre-P3-07 build and NEAR stripping earns back 10, so the shipped map pays
 *      a NET +9..+13 draw calls for sector gating. The round-1 claim that streaming
 *      "measurably reduces draw cost on square-extraction" was WRONG — the reviewer's
 *      suspicion is confirmed by this harness — and the feature's real return (whole
 *      sectors HIDDEN) only exists on P4-01-shaped deeper graphs. The bounds below
 *      (split ≤ +25, net ≤ +15) pin today's measured price so it cannot silently grow;
 *   4. the shipped state (sectored, streaming on) stays inside
 *      EXTRACTION_MANIFEST.budgets drawCalls/triangles.
 *
 * Run: node scripts/uistreamperf.mjs   (npm run uistreamperf; in the ci chain)
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server;
let browser;
let checks = 0;
let failures = 0;
function check(condition, name, detail = '') {
  checks++;
  if (condition) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

try {
  server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    server: { port: 0, strictPort: false, hmr: false, watch: null },
    logLevel: 'error',
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.setDefaultTimeout(180000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.route('**/__uistreamperf.html', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body><canvas id="c" width="960" height="540"></canvas>'
      + '<script type="module" src="/scripts/uistreamperf.page.mjs"></script></body></html>',
  }));
  await page.goto(new URL('/__uistreamperf.html', url).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__STREAMPERF__ || window.__STREAMPERF_ERROR__);
  const err = await page.evaluate(() => window.__STREAMPERF_ERROR__ || null);
  if (err) throw new Error(`page measurement failed:\n${err}`);
  const R = await page.evaluate(() => window.__STREAMPERF__);

  console.log(`\n── square-extraction renderer measurement (real WebGL, shadow passes included)`);
  check(R.sectors.groups.length >= 3 && R.sectors.meshCount > 0,
    'raid map builds real visuals with per-sector groups',
    `${R.sectors.groups.length} sector groups, ${R.sectors.meshCount} meshes`);

  for (const p of R.poses) {
    console.log(`\n  pose ${p.id} — tiers ${JSON.stringify(p.tiers)}`);
    console.log(`    merged baseline (pre-P3-07, no sector split): ${p.merged.calls} calls / ${p.merged.triangles} tris`);
    console.log(`    sectored, streaming OFF:                      ${p.off.calls} calls (bucket-split cost ${p.bucketSplitCost >= 0 ? '+' : ''}${p.bucketSplitCost})`);
    console.log(`    sectored, streaming ON:                       ${p.on.calls} calls (shadow draws saved ${p.shadowDrawsSaved})`);
    check(Object.values(p.tiers).includes('near'),
      `${p.id}: viewer position makes at least one sector NEAR (measurement is not vacuous)`);
    check(p.shadowDrawsSaved > 0,
      `${p.id}: streaming ON sheds shadow-pass draw calls vs OFF`,
      `${p.off.calls} → ${p.on.calls} (−${p.shadowDrawsSaved})`);
    check(p.control.calls === p.off.calls,
      `${p.id}: forcing castShadow back on restores exactly the OFF number — the saving IS shadow stripping`,
      `control ${p.control.calls} vs off ${p.off.calls}`);
    check(p.on.calls === p.off.calls - p.shadowDrawsSaved && p.on.triangles <= p.off.triangles,
      `${p.id}: streaming ON never adds draws or triangles over OFF`);
    check(p.bucketSplitCost <= 25 && p.netVsMerged <= 15,
      `${p.id}: sector-gating price stays at its measured bound (split ≤ +25, net ≤ +15 draw calls vs merged)`,
      `split +${p.bucketSplitCost}, net ${p.netVsMerged >= 0 ? '+' : ''}${p.netVsMerged} (${p.on.calls} on vs ${p.merged.calls} merged)`);
    check(p.on.calls <= R.budgets.drawCalls,
      `${p.id}: shipped state stays inside the manifest drawCalls budget`,
      `${p.on.calls} ≤ ${R.budgets.drawCalls}`);
    check(p.on.triangles <= R.budgets.triangles,
      `${p.id}: shipped state stays inside the manifest triangles budget`,
      `${p.on.triangles} ≤ ${R.budgets.triangles}`);
  }
  check(pageErrors.length === 0, 'no page errors during measurement', pageErrors.join(' | '));

  console.log(`\nuistreamperf: ${failures ? 'FAIL' : 'PASS'} — ${checks} checks, ${failures} failures`);
} finally {
  await browser?.close();
  await server?.close();
}
process.exit(failures ? 1 : 0);
