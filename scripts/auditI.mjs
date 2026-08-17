/**
 * AUDIT I — why does the same seed not reproduce the same match?
 *
 * auditD showed two `startMatch({ seed })` calls diverge at fixed step 0, and auditH
 * showed it is not caused by leftover entity positions and is not frame-rate related.
 *
 * This probe wraps `game.rng` (and every bot's captured reference to it) in a tracer,
 * records the call site of every draw, runs the same seed twice, and reports the first
 * index at which the two traces differ — i.e. exactly which consumer of the simulation
 * RNG behaves differently on the second match.
 */
import { boot } from './auditlib.mjs';

const h = await boot({ port: 5341, viewport: { width: 400, height: 300 } });
const { page } = h;

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  const R = { checks: [], data: {} };
  const ok = (name, cond, detail) => R.checks.push({ name, pass: !!cond, detail: String(detail) });

  const realRng = g.rng;
  let trace = null;
  const site = () => {
    const s = new Error().stack || '';
    const lines = s.split('\n');
    // 0 = "Error", 1 = site(), 2 = the wrapper, 3 = the real caller
    return (lines[3] || lines[2] || '?').trim().replace(/https?:\/\/[^/]+/, '');
  };
  const wrap = () => {
    const f = function () {
      const v = realRng();
      if (trace) trace.push({ k: '()', v: +v.toFixed(9), at: site() });
      return v;
    };
    f.range = (a, b) => { const v = realRng.range(a, b); if (trace) trace.push({ k: 'range', v: +v.toFixed(9), at: site() }); return v; };
    f.int = (n) => { const v = realRng.int(n); if (trace) trace.push({ k: 'int', v, at: site() }); return v; };
    f.pick = (arr) => { const v = realRng.pick(arr); if (trace) trace.push({ k: 'pick', v: String(v).slice(0, 12), at: site() }); return v; };
    f.sign = () => { const v = realRng.sign(); if (trace) trace.push({ k: 'sign', v, at: site() }); return v; };
    f.chance = (p) => { const v = realRng.chance(p); if (trace) trace.push({ k: 'chance', v, at: site() }); return v; };
    f.gauss = () => { const v = realRng.gauss(); if (trace) trace.push({ k: 'gauss', v: +v.toFixed(9), at: site() }); return v; };
    f.reseed = (s) => realRng.reseed(s);
    return f;
  };
  const tracer = wrap();
  g.rng = tracer;
  for (const b of g.bots.bots) b.rng = tracer;

  const runTraced = (seed, steps) => {
    trace = [];
    g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'veteran', seed });
    // Newly built bots captured `game.rng` at construction — which is the tracer.
    for (const b of g.bots.bots) b.rng = tracer;
    const atStart = trace.length;
    for (let i = 0; i < steps; i++) g._fixedUpdate(1 / 120);
    const t = trace;
    trace = null;
    g.returnToMenu();
    return { t, atStart };
  };

  const A = runTraced(31337, 120);
  const B = runTraced(31337, 120);

  let firstDiff = -1;
  const n = Math.min(A.t.length, B.t.length);
  for (let i = 0; i < n; i++) {
    const a = A.t[i], b = B.t[i];
    if (a.k !== b.k || String(a.v) !== String(b.v) || a.at !== b.at) { firstDiff = i; break; }
  }
  if (firstDiff === -1 && A.t.length !== B.t.length) firstDiff = n;

  R.data.rngTrace = {
    drawsDuringStartMatch: { a: A.atStart, b: B.atStart },
    totalDraws: { a: A.t.length, b: B.t.length },
    firstDivergingDraw: firstDiff,
    divergedInsideStartMatch: firstDiff >= 0 && firstDiff < Math.min(A.atStart, B.atStart),
    context: firstDiff < 0 ? null : {
      before: A.t.slice(Math.max(0, firstDiff - 3), firstDiff).map((x) => `${x.k}=${x.v} @ ${x.at}`),
      a: A.t[firstDiff] ? `${A.t[firstDiff].k}=${A.t[firstDiff].v} @ ${A.t[firstDiff].at}` : '<end of trace>',
      b: B.t[firstDiff] ? `${B.t[firstDiff].k}=${B.t[firstDiff].v} @ ${B.t[firstDiff].at}` : '<end of trace>',
    },
  };

  // Which call sites drew, and how many times, in each run — a count mismatch names
  // the culprit even when the interleaving is complex.
  const tally = (t) => {
    const m = {};
    for (const x of t) m[x.at] = (m[x.at] || 0) + 1;
    return m;
  };
  const ta = tally(A.t), tb = tally(B.t);
  const sites = [...new Set([...Object.keys(ta), ...Object.keys(tb)])];
  R.data.siteCounts = sites
    .map((s) => ({ site: s, a: ta[s] || 0, b: tb[s] || 0 }))
    .filter((r) => r.a !== r.b)
    .sort((x, y) => Math.abs(y.a - y.b) - Math.abs(x.a - x.b));
  R.data.allSites = sites.map((s) => `${s}  a=${ta[s] || 0} b=${tb[s] || 0}`);

  ok('rng:sameSeedSameStream', firstDiff === -1,
    firstDiff === -1 ? 'identical draw sequence' :
      `first divergence at draw #${firstDiff} (startMatch consumed ${A.atStart} vs ${B.atStart} draws)`);

  // Is the simulation RNG being consumed by non-simulation code?
  R.data.nonSimConsumers = R.data.allSites.filter((s) =>
    /audio|fx|viewmodel|hud|minimap|particles|tracers|decals|footstep/i.test(s));

  g.rng = realRng;
  for (const b of g.bots.bots) b.rng = realRng;
  return R;
});

console.log('\n=========== AUDIT I — RNG TRACE ===========');
let fails = 0;
for (const c of out.checks) { if (!c.pass) fails++; console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`); }
console.log('\nrngTrace:', JSON.stringify(out.data.rngTrace, null, 1));
console.log('\ncall sites with different draw counts between the two runs:');
console.log(JSON.stringify(out.data.siteCounts, null, 1));
console.log('\nnon-simulation consumers of game.rng:', JSON.stringify(out.data.nonSimConsumers, null, 1));
console.log('\nall call sites:', JSON.stringify(out.data.allSites, null, 1));
if (h.errors.length) console.log('\npage errors:', [...new Set(h.errors)].slice(0, 12));

await h.close();
