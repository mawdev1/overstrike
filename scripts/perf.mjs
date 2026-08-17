/**
 * OVERSTRIKE — real-GPU performance report.
 *
 *   node scripts/perf.mjs                       full baseline (prod build, 1080p + 1440p, 3 repeats)
 *   node scripts/perf.mjs --quick               one repeat, shorter samples — for a fast check
 *   node scripts/perf.mjs --scenarios=typical,heavy --res=1920x1080
 *   node scripts/perf.mjs --out=perf/after-culling.json
 *   node scripts/perf.mjs --dev                 measure the dev server instead (misleading; don't)
 *
 * Writes a machine-readable report to perf/<name>.json and prints an aligned table.
 *
 * READ THIS BEFORE TRUSTING A NUMBER
 * ----------------------------------
 * GPU frame time is measured with EXT_disjoint_timer_query_webgl2 against the real
 * Radeon, not SwiftShader. Every scenario runs `--repeats` times and the report keeps the
 * BEST repeat (lowest median GPU frame time) — GPU clocks throttle and background noise
 * only ever makes a run slower. The spread between repeats is printed; if it is wide, the
 * machine was busy and the run should be repeated.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, startServer, launchBrowser, EARLY_SRC, PAGE_SRC, settingsInitScript,
  stat, worstMean, histogram, HIST_EDGES, printTable, r2, r3,
} from './perflib.mjs';

// ───────────────────────────────────────────────────────────────────── args ──

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const has = (k) => argv.includes('--' + k);

const QUICK = has('quick');
const CFG = {
  dev: has('dev'),
  build: !has('no-build'),
  headed: has('headed'),
  repeats: Number(arg('repeats', QUICK ? 1 : 3)),
  warmup: Number(arg('warmup', 120)),
  frames: Number(arg('frames', QUICK ? 240 : 600)),
  passFrames: Number(arg('passframes', QUICK ? 200 : 400)),
  hitchFrames: Number(arg('hitchframes', 300)),
  settleFrames: Number(arg('settleframes', QUICK ? 300 : 900)),
  burnInMs: Number(arg('burnin', 3000)),
  simSteps: Number(arg('simsteps', QUICK ? 1200 : 2400)),
  port: Number(arg('port', 5391)),
  out: arg('out', 'perf/baseline.json'),
  resolutions: arg('res', '1920x1080,2560x1440').split(',').map((s) => {
    const [w, h] = s.trim().split('x').map(Number);
    return { w, h, label: w + 'x' + h };
  }),
  only: arg('scenarios', '').split(',').map((s) => s.trim()).filter(Boolean),
};

// ──────────────────────────────────────────────────────────────── scenarios ──

/**
 * `view` names a vantage point derived from the level geometry at runtime (see
 * P.viewpoints in perflib): `long` = the longest clear sightline anywhere on the map
 * (most geometry in frustum), `mid` = a representative open position, `tight` = enclosed.
 * The exact coordinates chosen are recorded in the JSON so a level change that moves them
 * is visible in the diff instead of silently invalidating the baseline.
 */
const SCENARIOS = [
  { name: 'menu', kind: 'menu', bots: 0, difficulty: 'regular', seed: 1001, view: 'mid', fire: false, streaks: false,
    note: 'main menu idle' },
  { name: 'light', kind: 'match', bots: 2, difficulty: 'recruit', seed: 2002, view: 'tight', fire: false, streaks: false,
    note: '2 bots, enclosed viewpoint' },
  { name: 'typical', kind: 'match', bots: 8, difficulty: 'veteran', seed: 3003, view: 'mid', fire: false, streaks: false,
    note: 'TDM, 8 bots veteran, representative viewpoint' },
  { name: 'heavy', kind: 'match', bots: 24, difficulty: 'veteran', seed: 4004, view: 'mid', fire: true, streaks: false,
    note: 'max roster, player firing continuously' },
  { name: 'worstcase', kind: 'match', bots: 24, difficulty: 'veteran', seed: 5005, view: 'long', fire: true, streaks: true,
    note: 'heavy + gunship/sentries/UAV/airstrike, longest sightline' },
];

const PASS_ORDER = ['ShadowMap', 'RenderPass', 'DepthAO', 'ViewLayer', 'Bloom', 'Output', 'Composite', 'frame'];

// ───────────────────────────────────────────────────────────────── reducing ──

function col(raw, key, warmup) { return raw[key].slice(warmup); }

/** Per-frame GPU segment table -> { label: number[] } plus a summed total. */
function gpuSegments(gpu, warmup) {
  const out = {};
  const total = [];
  for (let i = warmup; i < gpu.length; i++) {
    const s = gpu[i];
    if (!s) continue;
    let t = 0;
    for (const k of Object.keys(s)) {
      (out[k] || (out[k] = [])).push(s[k]);
      t += s[k];
    }
    total.push(t);
  }
  return { segs: out, total };
}

function reduceMain(raw, warmup) {
  const dt = col(raw, 'dt', warmup);
  const loop = col(raw, 'loop', warmup);
  const fixed = col(raw, 'fixed', warmup);
  const upd = col(raw, 'upd', warmup);
  const engUpd = col(raw, 'engUpd', warmup);
  const engRender = col(raw, 'engRender', warmup);
  const other = loop.map((v, i) => Math.max(0, v - fixed[i] - upd[i] - engUpd[i] - engRender[i]));

  const g = gpuSegments(raw.gpu, warmup);
  const gpuFrame = g.segs.frame || [];

  const med = stat(dt) ? stat(dt).median : 0;
  const stutter = dt.filter((v) => v > med * 2).length;

  // Keep the full split for the five worst frames. When a spike shows up here with a
  // small `loop` but a huge `interval`, the stall was outside our JS (compositor, driver,
  // shader link) and no amount of gameplay-code optimisation will move it.
  const worst = dt
    .map((v, i) => ({ i, interval: r2(v), loop: r2(loop[i]), fixed: r2(fixed[i]), update: r2(upd[i]),
      engUpdate: r2(engUpd[i]), engRender: r2(engRender[i]),
      gpu: raw.gpu[i + warmup] ? r2(raw.gpu[i + warmup].frame) : null }))
    .sort((a, b) => b.interval - a.interval)
    .slice(0, 5);

  return {
    frames: dt.length,
    gpuFrameMs: stat(gpuFrame),
    gpuFrames: gpuFrame.length,
    fps: {
      meanFromInterval: med ? r2(1000 / (dt.reduce((a, b) => a + b, 0) / dt.length)) : null,
      medianFromInterval: med ? r2(1000 / med) : null,
    },
    cpu: {
      frameTotalMs: stat(loop),
      fixedSimMs: stat(fixed),
      updateMs: stat(upd),
      engineUpdateMs: stat(engUpd),
      engineRenderJsMs: stat(engRender),
      otherMs: stat(other),
      substepsPerFrame: stat(col(raw, 'steps', warmup)),
    },
    pacing: {
      intervalMs: stat(dt),
      worst1pctMs: worstMean(dt, 1),
      worst01pctMs: worstMean(dt, 0.1),
      stutterFrames: stutter,
      stutterPct: r2((stutter / Math.max(1, dt.length)) * 100),
      histEdges: HIST_EDGES.map((e) => (e === Infinity ? null : e)),
      histCounts: histogram(dt),
      worstFrames: worst,
    },
    counters: raw.counters,
    drawCallsStat: stat(col(raw, 'draws', warmup)),
    trianglesStat: stat(col(raw, 'tris', warmup)),
    timer: raw.timer,
    state: raw.state,
    bots: raw.bots,
    botsAlive: raw.botsAlive,
  };
}

function reducePasses(raw, warmup) {
  const g = gpuSegments(raw.gpu, warmup);
  const passes = {};
  const keys = Object.keys(g.segs).sort(
    (a, b) => (PASS_ORDER.indexOf(a) + 99 * (PASS_ORDER.indexOf(a) < 0)) - (PASS_ORDER.indexOf(b) + 99 * (PASS_ORDER.indexOf(b) < 0)),
  );
  for (const k of keys) passes[k === 'frame' ? 'other(non-pass)' : k] = stat(g.segs[k]);
  return {
    frames: g.total.length,
    totalMs: stat(g.total),
    passes,
    timer: raw.timer,
    // A pass that early-returns costs 0 ms and looks identical in the table to a pass
    // that is genuinely free. This says which one it is.
    aoActuallyRan: raw.diag ? raw.diag.aoDepthFrames + '/' + raw.diag.aoFrames : null,
  };
}

function reduceHitch(raw) {
  const dt = raw.dt.slice(1);
  const s = stat(dt);
  const med = s ? s.median : 0;
  const long = [];
  for (let i = 0; i < dt.length; i++) {
    if (med && dt[i] > med * 2) long.push({ frame: i + 1, ms: r2(dt[i]) });
  }
  return {
    frames: dt.length,
    simSeconds: r2(raw.dt.length / 60),
    intervalMs: s,
    maxMs: s ? s.max : null,
    longFrames: long.length,
    worstFive: long.sort((a, b) => b.ms - a.ms).slice(0, 5),
    engineRenderJsMs: stat(raw.engRender.slice(1)),
  };
}

// ────────────────────────────────────────────────────────────────── driving ──

async function runScenario(page, sc, view) {
  const out = { scenario: sc.name, note: sc.note, bots: sc.bots, difficulty: sc.difficulty, seed: sc.seed, viewName: sc.view, view };

  // ONE call across the Playwright boundary for the entire scenario — see P.runScenario.
  const raw = await page.evaluate(
    (a) => window.__P.runScenario(a.sc, a.cfg),
    {
      sc: { ...sc, view },
      cfg: {
        hitchFrames: CFG.hitchFrames,
        settleFrames: CFG.settleFrames,
        settleMax: CFG.settleFrames * 2,
        settleQuiet: 150,
        warmup: CFG.warmup,
        frames: CFG.frames,
        passFrames: CFG.passFrames,
        simSteps: CFG.simSteps,
      },
    },
  );

  out.setup = raw.setup;
  out.streaks = raw.streaks;
  out.settle = raw.settle;
  out.heapBefore = raw.heapBefore;
  out.heapAfter = raw.heapAfter;

  out.hitch = reduceHitch(raw.hitch);
  out.hitch.programsBefore = raw.programsBefore;
  out.hitch.programsAfter = raw.hitch.counters.programs;
  out.hitch.programsCompiled = raw.hitch.counters.programs - raw.programsBefore;

  const mainRaw = raw.main;
  out.main = reduceMain(mainRaw, CFG.warmup);
  // If this is non-zero the sample was contaminated by a shader link and its pacing
  // numbers should be treated as an upper bound.
  out.main.programsCompiledDuringSample = mainRaw.counters.programs - raw.programsAtSample;

  out.passBreakdown = reducePasses(raw.passes, CFG.warmup);

  out.sim = { msPerFixedStep: stat(raw.stepped) };
  if (out.sim.msPerFixedStep) {
    out.sim.pctOf120HzBudget = r2((out.sim.msPerFixedStep.median / 8.333) * 100);
    out.sim.sixSubstepCatchUpMs = r3(out.sim.msPerFixedStep.median * 6);
  }

  if (out.heapBefore && out.heapAfter) {
    out.heap = {
      beforeMB: r2(out.heapBefore.used / 1048576),
      afterMB: r2(out.heapAfter.used / 1048576),
      growthMB: r2((out.heapAfter.used - out.heapBefore.used) / 1048576),
    };
  }
  // In-flight heap samples (every 30th frame of the headline phase) — a rising line here
  // with a flat post-GC delta means garbage churn rather than a leak.
  const live = mainRaw.heap.filter((v) => v > 0);
  if (live.length > 2) {
    out.heapDuringMB = {
      first: r2(live[0] / 1048576),
      last: r2(live[live.length - 1] / 1048576),
      max: r2(Math.max(...live) / 1048576),
      slopeMBPerKFrame: r2(((live[live.length - 1] - live[0]) / 1048576) / (mainRaw.heap.length / 1000)),
    };
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────── run ──

/**
 * Pick the repeat to report.
 *
 * Preference order: (1) repeats where no shader linked during the sample — a link stalls
 * the frame for up to two seconds and destroys the pacing statistics for that repeat;
 * (2) lowest median GPU frame time. Background noise and GPU throttling can only ever
 * make a run slower, so the fastest of N is the closest to the machine's true cost.
 */
function bestOf(repeats) {
  let ok = repeats.filter((r) => r && !r.error && r.main && r.main.gpuFrameMs);
  if (!ok.length) return { best: repeats.find((r) => r && !r.error) || null, spread: null };
  const clean = ok.filter((r) => !r.main.programsCompiledDuringSample);
  if (clean.length) ok = clean;
  const sorted = [...ok].sort((a, b) => a.main.gpuFrameMs.median - b.main.gpuFrameMs.median);
  const meds = ok.map((r) => r.main.gpuFrameMs.median);
  const lo = Math.min(...meds), hi = Math.max(...meds);
  return {
    best: sorted[0],
    spread: {
      repeats: ok.length,
      gpuMedianMin: r3(lo),
      gpuMedianMax: r3(hi),
      spreadPct: r2(lo ? ((hi - lo) / lo) * 100 : 0),
      allMedians: meds.map(r3),
    },
  };
}

const report = {
  meta: {
    generatedAt: new Date().toISOString(),
    tool: 'scripts/perf.mjs',
    config: { ...CFG, resolutions: CFG.resolutions.map((r) => r.label) },
    argv,
  },
  scenarios: {},
};

let server, browser;
const failures = [];

try {
  console.log('[perf] starting server (' + (CFG.dev ? 'dev' : 'production build') + ') ...');
  server = await startServer({ dev: CFG.dev, port: CFG.port, doBuild: CFG.build });
  report.meta.serverMode = server.mode;
  report.meta.url = server.url;
  console.log('[perf] ' + server.mode + ' server at ' + server.url);

  const scenarios = CFG.only.length ? SCENARIOS.filter((s) => CFG.only.includes(s.name)) : SCENARIOS;
  const total = CFG.resolutions.length * CFG.repeats * scenarios.length;
  let done = 0;
  const t0 = Date.now();

  for (const res of CFG.resolutions) {
    for (let rep = 0; rep < CFG.repeats; rep++) {
      // A whole fresh BROWSER per repeat, not just a context.
      //
      // Measured: with one browser and a new context per repeat, repeat 1 came in at
      // 1.65 ms and repeats 2 and 3 at 2.17/2.10 ms — a 31% "spread" that was entirely
      // systematic. Chromium keeps one GPU process for the whole browser, and the GPU-side
      // resources of a closed context are not reclaimed before the next one starts
      // measuring. Relaunching makes repeats independent, which is the only thing that
      // makes best-of-N meaningful.
      browser = await launchBrowser({ headed: CFG.headed });
      const ctx = await browser.newContext({
        viewport: { width: res.w, height: res.h },
        deviceScaleFactor: 1,
      });
      const page = await ctx.newPage();
      page.setDefaultTimeout(600000);
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e.message)));

      await page.addInitScript({ content: EARLY_SRC });
      await page.addInitScript({ content: settingsInitScript() });

      const bootT0 = Date.now();
      await page.goto(server.url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => window.__GAME__ && window.__GAME__.state === 'menu', null,
        { timeout: 300000, polling: 100 });
      const bootMs = Date.now() - bootT0;

      const installed = await page.evaluate(PAGE_SRC);
      if (!installed || !installed.ok) throw new Error('probe install failed: ' + JSON.stringify(installed));
      const info = await page.evaluate(() => window.__P.info());
      if (!info.timerQuery) throw new Error('EXT_disjoint_timer_query_webgl2 unavailable — GPU timing impossible');

      if (!report.meta.gpu) {
        report.meta.gpu = info.renderer;
        report.meta.vendor = info.vendor;
        report.meta.passChain = info.passes;
        report.meta.settings = {
          renderScale: info.renderScale, shadows: info.shadows,
          shadowQuality: info.shadowQuality, postFx: info.postFx, fov: info.fov,
        };
        console.log('[perf] gpu: ' + info.renderer);
      }

      const views = await page.evaluate(() => window.__P.viewpoints());
      report.meta.viewpoints = views;

      // Get the GPU off its idle clocks before the first measurement of this session.
      const burn = await page.evaluate((ms) => window.__P.burnIn(ms), CFG.burnInMs);
      report.meta.burnIn = burn;

      const bootInfo = {
        bootMs,
        timeToFirstFrameMs: info.boot ? r2(info.boot.firstFrameMs) : null,
        programsAtFirstFrame: info.boot ? info.boot.firstFrameProgs : null,
        bootFrameCount: info.boot ? info.boot.bootFrames.length : 0,
        bootFrameMaxMs: info.boot && info.boot.bootFrames.length ? r2(Math.max(...info.boot.bootFrames)) : null,
      };
      if (!report.meta.boot) report.meta.boot = bootInfo;

      for (const sc of scenarios) {
        const key = sc.name + '@' + res.label;
        const slot = report.scenarios[key] || (report.scenarios[key] = {
          scenario: sc.name, resolution: res.label, note: sc.note, repeats: [],
        });
        const t = Date.now();
        try {
          const r = await runScenario(page, sc, views[sc.view]);
          r.viewport = res.label;
          r.drawingBuffer = info.drawingBuffer;
          r.repeat = rep + 1;
          r.boot = bootInfo;
          r.pageErrors = [...new Set(pageErrors)].slice(0, 5);
          slot.repeats.push(r);
        } catch (err) {
          // One bad scenario must never take the whole run down — the point of this
          // harness is a comparable table, and a missing row is far better than none.
          const msg = String(err && err.message ? err.message : err);
          failures.push(key + ' (rep ' + (rep + 1) + '): ' + msg);
          slot.repeats.push({ scenario: sc.name, repeat: rep + 1, error: msg });
          console.log('  !! ' + key + ' rep ' + (rep + 1) + ' FAILED: ' + msg.slice(0, 160));
          // Try to get the page back into a sane state for the next scenario.
          try { await page.evaluate(() => window.__GAME__.returnToMenu()); } catch { /* gone */ }
        }
        done++;
        const each = (Date.now() - t0) / done;
        console.log('  [' + done + '/' + total + '] ' + key + ' rep ' + (rep + 1) +
          '  ' + ((Date.now() - t) / 1000).toFixed(1) + 's' +
          '  (eta ' + (((total - done) * each) / 1000).toFixed(0) + 's)');
      }

      await ctx.close();
      await browser.close();
      browser = null;
    }
  }

  for (const key of Object.keys(report.scenarios)) {
    const s = report.scenarios[key];
    const { best, spread } = bestOf(s.repeats);
    s.best = best;
    s.spread = spread;
  }
} catch (err) {
  failures.push('harness: ' + (err && err.stack ? err.stack : err));
  console.error('[perf] fatal:', err);
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
}

report.failures = failures;

// ──────────────────────────────────────────────────────────────────── output ──

const outPath = path.resolve(ROOT, CFG.out);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 1));

const keys = Object.keys(report.scenarios);
const rows = keys.map((k) => ({ k, s: report.scenarios[k], b: report.scenarios[k].best })).filter((r) => r.b && r.b.main);

console.log('\n' + '='.repeat(112));
console.log('OVERSTRIKE PERFORMANCE BASELINE   ' + (report.meta.gpu || 'unknown gpu'));
console.log('build: ' + report.meta.serverMode + '   repeats: ' + CFG.repeats +
  ' (best-of shown)   sample: ' + CFG.frames + ' frames after ' + CFG.warmup + ' warmup');
console.log('='.repeat(112));

console.log('\n── HEADLINE ── GPU frame time is the whole frame\'s GL work, measured on the GPU itself.\n');
printTable(rows, [
  { h: 'scenario', f: (r) => r.s.scenario },
  { h: 'res', f: (r) => r.s.resolution },
  { h: 'GPU ms', r: true, f: (r) => r.b.main.gpuFrameMs?.median?.toFixed(2) },
  { h: 'p95', r: true, f: (r) => r.b.main.gpuFrameMs?.p95?.toFixed(2) },
  { h: 'p99', r: true, f: (r) => r.b.main.gpuFrameMs?.p99?.toFixed(2) },
  { h: 'max', r: true, f: (r) => r.b.main.gpuFrameMs?.max?.toFixed(2) },
  { h: 'CPU ms', r: true, f: (r) => r.b.main.cpu.frameTotalMs?.median?.toFixed(2) },
  { h: 'fps', r: true, f: (r) => r.b.main.fps.medianFromInterval?.toFixed(0) },
  { h: '1% low ms', r: true, f: (r) => r.b.main.pacing.worst1pctMs?.toFixed(2) },
  { h: 'stutter%', r: true, f: (r) => r.b.main.pacing.stutterPct?.toFixed(2) },
  { h: 'draws', r: true, f: (r) => r.b.main.counters.drawCalls },
  { h: 'tris', r: true, f: (r) => r.b.main.counters.triangles.toLocaleString('en-US') },
  { h: 'rep spread', r: true, f: (r) => (r.s.spread ? r.s.spread.spreadPct.toFixed(1) + '%' : '-') },
]);

console.log('\n── CPU FRAME BREAKDOWN (median ms) ── engine.render is JS submit cost, not GPU time.\n');
printTable(rows, [
  { h: 'scenario', f: (r) => r.s.scenario },
  { h: 'res', f: (r) => r.s.resolution },
  { h: 'frame', r: true, f: (r) => r.b.main.cpu.frameTotalMs?.median?.toFixed(3) },
  { h: 'fixed sim', r: true, f: (r) => r.b.main.cpu.fixedSimMs?.median?.toFixed(3) },
  { h: 'update', r: true, f: (r) => r.b.main.cpu.updateMs?.median?.toFixed(3) },
  { h: 'eng.update', r: true, f: (r) => r.b.main.cpu.engineUpdateMs?.median?.toFixed(3) },
  { h: 'eng.render', r: true, f: (r) => r.b.main.cpu.engineRenderJsMs?.median?.toFixed(3) },
  { h: 'other', r: true, f: (r) => r.b.main.cpu.otherMs?.median?.toFixed(3) },
  { h: 'ms/1‑120step', r: true, f: (r) => r.b.sim?.msPerFixedStep?.median?.toFixed(3) },
  { h: '%120Hz', r: true, f: (r) => r.b.sim?.pctOf120HzBudget?.toFixed(1) },
]);

console.log('\n── PER-PASS GPU COST (median ms, exclusive) ── the single most useful table here.');
console.log('   RenderPass excludes ShadowMap. "other" = composer clears/blits between passes.');
console.log('   SUM is measured with split timer queries; "whole" is one query around the entire');
console.log('   frame. The gap between them is GPU idle waiting on CPU submission, not a pass.\n');
const passKeys = [...new Set(rows.flatMap((r) => Object.keys(r.b.passBreakdown?.passes || {})))];
const ordered = [...PASS_ORDER.filter((k) => passKeys.includes(k)), ...passKeys.filter((k) => !PASS_ORDER.includes(k))];
printTable(rows, [
  { h: 'scenario', f: (r) => r.s.scenario },
  { h: 'res', f: (r) => r.s.resolution },
  ...ordered.map((k) => ({
    h: k === 'other(non-pass)' ? 'other' : k,
    r: true,
    f: (r) => r.b.passBreakdown?.passes?.[k]?.median?.toFixed(3) ?? '-',
  })),
  { h: 'SUM', r: true, f: (r) => r.b.passBreakdown?.totalMs?.median?.toFixed(3) ?? '-' },
  { h: 'whole', r: true, f: (r) => r.b.main.gpuFrameMs?.median?.toFixed(3) },
  { h: 'idle gap', r: true, f: (r) => {
    const s = r.b.passBreakdown?.totalMs?.median, w = r.b.main.gpuFrameMs?.median;
    return s != null && w != null ? (w - s).toFixed(3) : '-';
  } },
]);

const aoRow = rows.find((r) => r.b.passBreakdown?.aoActuallyRan);
if (aoRow) {
  const [ran, of] = aoRow.b.passBreakdown.aoActuallyRan.split('/').map(Number);
  if (ran === 0 && of > 0) {
    console.log('\n   !! DepthAO reads a buffer with no depth texture on ' + of + '/' + of + ' frames and');
    console.log('      early-returns. Its 0.000 ms is a pass that never runs, not a pass that is free.');
    console.log('      SSAO is not being drawn at all — see src/core/engine.js DepthAOPass.render().');
  }
}

console.log('\n── FRAME PACING (ms between rAF callbacks) ──\n');
printTable(rows, [
  { h: 'scenario', f: (r) => r.s.scenario },
  { h: 'res', f: (r) => r.s.resolution },
  { h: 'median', r: true, f: (r) => r.b.main.pacing.intervalMs?.median?.toFixed(2) },
  { h: 'mean', r: true, f: (r) => r.b.main.pacing.intervalMs?.mean?.toFixed(2) },
  { h: 'std', r: true, f: (r) => r.b.main.pacing.intervalMs?.std?.toFixed(2) },
  { h: 'p95', r: true, f: (r) => r.b.main.pacing.intervalMs?.p95?.toFixed(2) },
  { h: 'p99', r: true, f: (r) => r.b.main.pacing.intervalMs?.p99?.toFixed(2) },
  { h: 'max', r: true, f: (r) => r.b.main.pacing.intervalMs?.max?.toFixed(2) },
  { h: '1% low', r: true, f: (r) => r.b.main.pacing.worst1pctMs?.toFixed(2) },
  { h: '>2x med', r: true, f: (r) => r.b.main.pacing.stutterFrames },
  { h: 'of', r: true, f: (r) => r.b.main.frames },
]);

if (rows.length) {
  console.log('\n   histogram of frame intervals (' + rows[0].s.scenario + ' … all rows in the JSON):');
  const edges = HIST_EDGES;
  const labels = edges.slice(0, -1).map((e, i) => (edges[i + 1] === Infinity ? '>' + e : e + '-' + edges[i + 1]));
  printTable(rows, [
    { h: 'scenario', f: (r) => r.s.scenario + '@' + r.s.resolution.split('x')[0] },
    ...labels.map((l, i) => ({ h: l, r: true, f: (r) => r.b.main.pacing.histCounts[i] || '' })),
  ]);
}

console.log('\n── RENDERER COUNTERS + HEAP + SHADER HITCHING ──\n');
printTable(rows, [
  { h: 'scenario', f: (r) => r.s.scenario },
  { h: 'res', f: (r) => r.s.resolution },
  { h: 'draws', r: true, f: (r) => r.b.main.counters.drawCalls },
  { h: 'tris', r: true, f: (r) => r.b.main.counters.triangles.toLocaleString('en-US') },
  { h: 'programs', r: true, f: (r) => r.b.main.counters.programs },
  { h: 'geoms', r: true, f: (r) => r.b.main.counters.geometries },
  { h: 'texs', r: true, f: (r) => r.b.main.counters.textures },
  { h: 'heap MB', r: true, f: (r) => r.b.heap?.afterMB?.toFixed(1) ?? '-' },
  { h: 'growth MB', r: true, f: (r) => r.b.heap?.growthMB?.toFixed(2) ?? '-' },
  { h: 'progs@hitch', r: true, f: (r) => r.b.hitch?.programsCompiled ?? '-' },
  { h: 'progs@sample', r: true, f: (r) => r.b.main?.programsCompiledDuringSample ?? '-' },
  { h: 'settle frames', r: true, f: (r) => r.b.settle?.frames ?? '-' },
  { h: 'hitch >2x', r: true, f: (r) => r.b.hitch?.longFrames ?? '-' },
  { h: 'hitch max ms', r: true, f: (r) => r.b.hitch?.maxMs?.toFixed(1) ?? '-' },
]);

if (report.meta.boot) {
  console.log('\nboot: ' + report.meta.boot.bootMs + ' ms to menu   time-to-first-rendered-frame ' +
    report.meta.boot.timeToFirstFrameMs + ' ms   programs at first frame ' +
    report.meta.boot.programsAtFirstFrame + '   worst boot render frame ' +
    report.meta.boot.bootFrameMaxMs + ' ms');
}
if (report.meta.viewpoints) {
  console.log('viewpoints (derived from the level, recorded in the JSON):');
  for (const [k, v] of Object.entries(report.meta.viewpoints)) {
    console.log('  ' + k.padEnd(6) + ' pos [' + v.pos.map((n) => n.toFixed(1)).join(', ') +
      '] yaw ' + v.yaw.toFixed(3) + ' pitch ' + v.pitch + '  sightline ' + v.sightline + ' m');
  }
}

const timerNoise = rows.map((r) => r.b.main.timer).filter(Boolean);
const disjoint = timerNoise.reduce((a, t) => a + (t.disjoint || 0), 0);
const starved = timerNoise.reduce((a, t) => a + (t.starved || 0), 0);
if (disjoint || starved) console.log('\ntimer-query noise: ' + disjoint + ' disjoint flush(es), ' + starved + ' pool starvation(s)');

if (failures.length) {
  console.log('\n' + failures.length + ' FAILURE(S):');
  for (const f of failures.slice(0, 20)) console.log('  x ' + f.split('\n')[0]);
}

console.log('\nwrote ' + path.relative(ROOT, outPath));
console.log('compare with:  node scripts/perfcompare.mjs ' + path.relative(ROOT, outPath) + ' perf/<new>.json\n');

process.exit(failures.length ? 1 : 0);
