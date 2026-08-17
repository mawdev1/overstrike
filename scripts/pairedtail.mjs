/**
 * OVERSTRIKE — PAIRED before/after tail measurement on the real GPU.
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/perf.mjs` is the right tool for an absolute baseline, but two engineers on
 * this machine have now measured the SAME unmodified code swinging by an order of
 * magnitude between sequential runs, because several agents drive GPU probes
 * concurrently. Frame-pacing tail statistics — 1% low, max frame, stutter% — are exactly
 * the numbers that contention destroys: one 40 ms scheduling gap moves `max` by 40 ms,
 * whatever the game did.
 *
 * The fix is pairing. Both variants are built up front into two dist trees and served
 * simultaneously from two preview servers, then measured ALTERNATELY, one immediately
 * after the other, in an A-B-B-A order that also cancels any first-run-of-a-pair bias.
 * Each PAIR therefore samples the same machine weather, and the statistic that matters
 * is the distribution of the WITHIN-PAIR difference, not the two absolute levels.
 *
 * Everything else — the page-side probe, camera pinning, the locked 1/60 dtFrame, the
 * settle, the killstreak arming — is `scripts/perflib.mjs` unchanged, so the numbers are
 * directly comparable to `perf.mjs` output.
 *
 *   node scripts/pairedtail.mjs --before=<dir> [--pairs=6] [--scenario=worstcase]
 *                               [--res=1920x1080] [--no-build]
 *
 * `--before` is a directory holding a complete `src/` tree for the BEFORE variant. The
 * project's own `src/` is the AFTER variant and ends the run byte-identical to how it
 * started: the before build swaps in only the files that actually differ, holds the
 * originals in memory, and restores them in a `finally`. See buildBefore() for why a
 * whole-directory rename is not usable on this machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { build, preview } from 'vite';
import {
  ROOT, launchBrowser, EARLY_SRC, PAGE_SRC, settingsInitScript,
  ISOLATION_HEADERS, stat, worstMean, r2, r3, printTable,
} from './perflib.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const has = (k) => argv.includes('--' + k);

const BEFORE_SRC = arg('before', '');
const PAIRS = Number(arg('pairs', 6));
const SC_NAME = arg('scenario', 'worstcase');
const [RW, RH] = arg('res', '1920x1080').split('x').map(Number);
const PORT_A = Number(arg('portA', 5411));
const PORT_B = Number(arg('portB', 5412));
const OUT = arg('out', 'perf/paired-tail.json');

const SCENARIOS = {
  typical: { name: 'typical', kind: 'match', bots: 8, difficulty: 'veteran', seed: 3003, view: 'mid', fire: false, streaks: false },
  heavy: { name: 'heavy', kind: 'match', bots: 24, difficulty: 'veteran', seed: 4004, view: 'mid', fire: true, streaks: false },
  worstcase: { name: 'worstcase', kind: 'match', bots: 24, difficulty: 'veteran', seed: 5005, view: 'long', fire: true, streaks: true },
};
const WANT = SC_NAME.split(',').map((s) => s.trim()).filter(Boolean);
for (const w of WANT) if (!SCENARIOS[w]) throw new Error('unknown scenario ' + w);

const CFG = {
  hitchFrames: 300, settleFrames: 900, settleMax: 1800, settleQuiet: 150,
  warmup: 120, frames: 600, passFrames: 60, simSteps: 1200,
};

const SRC = path.join(ROOT, 'src');

// ─────────────────────────────────────────────────────────────────────  build ──

async function buildInto(outDir) {
  await build({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    build: { outDir, emptyOutDir: true },
    logLevel: 'error',
  });
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

/**
 * Build the BEFORE variant by swapping only the FILES that actually differ, in place.
 *
 * Renaming `src/` wholesale is the obvious approach and does not work here: Windows
 * refuses (`EPERM`) whenever any process holds a handle inside the directory, and other
 * engineers keep dev servers and watchers open on this tree. Per-file content swapping
 * touches only the handful of files that differ and restores them in a `finally`, so an
 * interrupted run leaves the working tree exactly as it found it. The originals are held
 * in memory, never on disk, so there is no half-restored state to clean up.
 */
async function buildBefore(outDir) {
  const saved = [];
  const swapped = [];
  for (const rel of walk(BEFORE_SRC)) {
    const dst = path.join(SRC, rel);
    if (!fs.existsSync(dst)) continue;
    const from = fs.readFileSync(path.join(BEFORE_SRC, rel));
    const cur = fs.readFileSync(dst);
    if (from.equals(cur)) continue;
    saved.push([dst, cur]);
    swapped.push(rel);
  }
  if (!swapped.length) throw new Error('before tree is identical to src/ — nothing to compare');
  console.log('[paired] swapping ' + swapped.length + ' file(s): ' + swapped.join(', '));
  try {
    for (const [dst] of saved) {
      fs.writeFileSync(dst, fs.readFileSync(path.join(BEFORE_SRC, path.relative(SRC, dst))));
    }
    await buildInto(outDir);
  } finally {
    for (const [dst, buf] of saved) fs.writeFileSync(dst, buf);
  }
}

// ─────────────────────────────────────────────────────────────────  measuring ──

/** One full scenario measurement against one url. Mirrors perf.mjs exactly. */
async function measure(url, sc) {
  const browser = await launchBrowser({});
  try {
    const ctx = await browser.newContext({ viewport: { width: RW, height: RH }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.setDefaultTimeout(600000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    await page.addInitScript({ content: EARLY_SRC });
    await page.addInitScript({ content: settingsInitScript() });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__GAME__ && window.__GAME__.state === 'menu', null,
      { timeout: 300000, polling: 100 });

    const installed = await page.evaluate(PAGE_SRC);
    if (!installed?.ok) throw new Error('probe install failed');
    const info = await page.evaluate(() => window.__P.info());
    if (!info.timerQuery) throw new Error('no EXT_disjoint_timer_query_webgl2');
    await page.evaluate(() => window.__P.burnIn(3000));
    const views = await page.evaluate(() => window.__P.viewpoints());

    const raw = await page.evaluate(
      (a) => window.__P.runScenario(a.sc, a.cfg),
      { sc: { ...sc, view: views[sc.view] }, cfg: CFG },
    );

    const dt = raw.main.dt.slice(CFG.warmup);
    const loop = raw.main.loop.slice(CFG.warmup);
    const gpu = [];
    for (let i = CFG.warmup; i < raw.main.gpu.length; i++) {
      if (raw.main.gpu[i]) gpu.push(raw.main.gpu[i].frame);
    }
    const s = stat(dt);
    const med = s.median;
    const stutter = dt.filter((v) => v > med * 2).length;
    return {
      frames: dt.length,
      medianMs: r3(med),
      meanMs: r3(s.mean),
      p95Ms: r3(s.p95),
      p99Ms: r3(s.p99),
      maxMs: r3(s.max),
      worst1pctMs: worstMean(dt, 1),
      worst01pctMs: worstMean(dt, 0.1),
      stutterFrames: stutter,
      stutterPct: r2((stutter / Math.max(1, dt.length)) * 100),
      cpuFrameMs: stat(loop),
      gpuFrameMs: stat(gpu),
      msPerFixedStep: stat(raw.stepped),
      programsDuringSample: raw.main.counters.programs - raw.programsAtSample,
      hitchLongFrames: (() => {
        const h = raw.hitch.dt.slice(1);
        const hs = stat(h);
        return h.filter((v) => v > hs.median * 2).length;
      })(),
      hitchMaxMs: r2(stat(raw.hitch.dt.slice(1)).max),
      drawCalls: raw.main.counters.drawCalls,
      triangles: raw.main.counters.triangles,
      botsAlive: raw.main.botsAlive,
      pageErrors: [...new Set(errors)].slice(0, 3),
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ────────────────────────────────────────────────────────────────────────  run ──

const report = {
  generatedAt: new Date().toISOString(),
  tool: 'scripts/pairedtail.mjs',
  pairs: PAIRS,
  resolution: RW + 'x' + RH,
  scenarios: WANT,
  order: 'ABBA (variant order alternates every pair)',
  results: {},
};

let srvA, srvB;
try {
  if (!BEFORE_SRC || !fs.existsSync(path.join(BEFORE_SRC, 'main.js'))) {
    throw new Error('--before=<dir> must point at a directory containing a full src/ tree');
  }

  if (!has('no-build')) {
    console.log('[paired] building BEFORE -> dist-before ...');
    await buildBefore('dist-before');
    console.log('[paired] building AFTER  -> dist-after ...');
    await buildInto('dist-after');
  }

  srvA = await preview({
    root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
    build: { outDir: 'dist-before' },
    preview: { port: PORT_A, strictPort: false, host: '127.0.0.1', open: false, headers: ISOLATION_HEADERS },
    logLevel: 'error',
  });
  srvB = await preview({
    root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
    build: { outDir: 'dist-after' },
    preview: { port: PORT_B, strictPort: false, host: '127.0.0.1', open: false, headers: ISOLATION_HEADERS },
    logLevel: 'error',
  });
  const urlBefore = srvA.resolvedUrls.local[0];
  const urlAfter = srvB.resolvedUrls.local[0];
  console.log('[paired] before ' + urlBefore + '   after ' + urlAfter);

  const t0 = Date.now();
  let done = 0;
  const total = WANT.length * PAIRS * 2;

  for (const name of WANT) {
    const sc = SCENARIOS[name];
    const rows = [];
    for (let p = 0; p < PAIRS; p++) {
      // ABBA: on odd pairs the AFTER build goes first, so any "first measurement of a
      // pair is systematically faster/slower" effect averages out instead of accruing
      // to one variant.
      const order = p % 2 === 0 ? ['before', 'after'] : ['after', 'before'];
      const pair = { pair: p + 1, order: order.join('>') };
      for (const which of order) {
        const t = Date.now();
        try {
          pair[which] = await measure(which === 'before' ? urlBefore : urlAfter, sc);
        } catch (err) {
          pair[which] = { error: String(err?.message || err) };
        }
        done++;
        console.log('  [' + done + '/' + total + '] ' + name + ' pair' + (p + 1) + ' ' + which +
          '  ' + ((Date.now() - t) / 1000).toFixed(1) + 's  (eta ' +
          (((total - done) * ((Date.now() - t0) / done)) / 1000).toFixed(0) + 's)');
      }
      rows.push(pair);
    }
    report.results[name] = rows;
  }
} catch (err) {
  report.error = String(err?.stack || err);
  console.error('[paired] fatal:', err);
} finally {
  await srvA?.close?.().catch?.(() => {});
  await srvB?.close?.().catch?.(() => {});
}

const outPath = path.resolve(ROOT, OUT);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 1));

// ─────────────────────────────────────────────────────────────────────  report ──

const METRICS = [
  ['1% low ms', 'worst1pctMs'],
  ['max ms', 'maxMs'],
  ['stutter %', 'stutterPct'],
  ['p99 ms', 'p99Ms'],
  ['median ms', 'medianMs'],
  ['CPU frame ms', null, (r) => r.cpuFrameMs?.median],
  ['GPU frame ms', null, (r) => r.gpuFrameMs?.median],
  ['ms/fixed step', null, (r) => r.msPerFixedStep?.median],
  ['hitch >2x', 'hitchLongFrames'],
  ['hitch max ms', 'hitchMaxMs'],
];

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

console.log('\n' + '='.repeat(104));
console.log('PAIRED TAIL MEASUREMENT — ' + RW + 'x' + RH + '   ' + PAIRS + ' pairs, ABBA order');
console.log('Each pair measures both builds back to back, so the WITHIN-PAIR delta is the signal.');
console.log('='.repeat(104));

for (const name of Object.keys(report.results)) {
  const rows = report.results[name].filter((p) => p.before && p.after && !p.before.error && !p.after.error);
  console.log('\n── ' + name + ' ── ' + rows.length + '/' + report.results[name].length + ' pairs usable\n');
  if (!rows.length) continue;

  printTable(METRICS.map(([label, key, fn]) => {
    const get = fn || ((r) => r[key]);
    const before = rows.map((p) => get(p.before)).filter(Number.isFinite);
    const after = rows.map((p) => get(p.after)).filter(Number.isFinite);
    const deltas = rows.map((p) => get(p.after) - get(p.before)).filter(Number.isFinite);
    return {
      label,
      before: median(before),
      after: median(after),
      dMed: median(deltas),
      // Lower is better for every metric in this table, so a negative delta is a win.
      wins: deltas.filter((d) => d < 0).length + '/' + deltas.length,
      per: deltas.map(r2).join(' '),
    };
  }), [
    { h: 'metric', f: (r) => r.label },
    { h: 'before (med of pairs)', r: true, f: (r) => (r.before == null ? '-' : r.before.toFixed(3)) },
    { h: 'after (med of pairs)', r: true, f: (r) => (r.after == null ? '-' : r.after.toFixed(3)) },
    { h: 'median paired delta', r: true, f: (r) => (r.dMed == null ? '-' : (r.dMed > 0 ? '+' : '') + r.dMed.toFixed(3)) },
    { h: 'pairs improved', r: true, f: (r) => r.wins },
    { h: 'per-pair delta', f: (r) => r.per },
  ]);
}

console.log('\nwrote ' + path.relative(ROOT, outPath));
if (report.error) { console.log('ERROR: ' + report.error.split('\n')[0]); process.exit(1); }
