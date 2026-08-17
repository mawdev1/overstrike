/**
 * Diff two perf reports produced by scripts/perf.mjs.
 *
 *   node scripts/perfcompare.mjs perf/baseline.json perf/after-my-change.json
 *   node scripts/perfcompare.mjs base.json new.json --passes      # per-pass deltas too
 *
 * Exits non-zero if anything regressed, so it can gate a change.
 *
 * The thresholds below are deliberately asymmetric and tight on GPU frame time: the
 * harness measures the same deterministic work every run and the repeat-to-repeat spread
 * on a quiet machine is ~1-2%, so 3% is a real signal rather than noise. Draw calls and
 * triangle counts are exact integers — ANY increase is a regression, not a fluctuation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, printTable, r2 } from './perflib.mjs';

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith('--'));
const has = (k) => argv.includes('--' + k);

if (files.length !== 2) {
  console.error('usage: node scripts/perfcompare.mjs <baseline.json> <new.json> [--passes] [--json]');
  process.exit(2);
}

const load = (f) => {
  const p = path.resolve(ROOT, f);
  if (!fs.existsSync(p)) { console.error('no such report: ' + p); process.exit(2); }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
};
const A = load(files[0]);
const B = load(files[1]);

/** name -> [worseIsPositive, regressionThresholdPct, exactIntegerMetric] */
const METRICS = [
  { key: 'gpu.median', label: 'GPU ms', pct: 3, get: (s) => s.main?.gpuFrameMs?.median },
  { key: 'gpu.p95', label: 'GPU p95', pct: 5, get: (s) => s.main?.gpuFrameMs?.p95 },
  { key: 'gpu.p99', label: 'GPU p99', pct: 8, get: (s) => s.main?.gpuFrameMs?.p99 },
  { key: 'cpu.frame', label: 'CPU ms', pct: 3, get: (s) => s.main?.cpu?.frameTotalMs?.median },
  { key: 'cpu.render', label: 'render JS', pct: 4, get: (s) => s.main?.cpu?.engineRenderJsMs?.median },
  { key: 'cpu.sim', label: 'sim ms/step', pct: 6, get: (s) => s.sim?.msPerFixedStep?.median },
  { key: 'pacing.low1', label: '1% low ms', pct: 6, get: (s) => s.main?.pacing?.worst1pctMs },
  { key: 'pacing.stutter', label: 'stutter %', abs: 0.5, get: (s) => s.main?.pacing?.stutterPct },
  { key: 'draws', label: 'draws', exact: true, get: (s) => s.main?.counters?.drawCalls },
  { key: 'tris', label: 'tris', pct: 1, get: (s) => s.main?.counters?.triangles },
  { key: 'programs', label: 'programs', exact: true, get: (s) => s.main?.counters?.programs },
  { key: 'heap', label: 'heap MB', pct: 10, get: (s) => s.heap?.afterMB },
];

const keys = [...new Set([...Object.keys(A.scenarios || {}), ...Object.keys(B.scenarios || {})])].sort();

const findings = [];
const rows = [];

for (const k of keys) {
  const a = A.scenarios?.[k]?.best;
  const b = B.scenarios?.[k]?.best;
  if (!a || !b) {
    findings.push({ sev: 'missing', key: k, text: k + ' present in only one report' });
    continue;
  }
  for (const m of METRICS) {
    const va = m.get(a);
    const vb = m.get(b);
    if (va == null || vb == null) continue;
    const d = vb - va;
    const pct = va !== 0 ? (d / va) * 100 : (d === 0 ? 0 : Infinity);
    let regressed = false;
    if (m.exact) regressed = d > 0;
    else if (m.abs != null) regressed = d > m.abs;
    else regressed = pct > m.pct;
    const improved = m.exact ? d < 0 : (m.abs != null ? d < -m.abs : pct < -m.pct);
    rows.push({
      scenario: k, metric: m.label, a: va, b: vb, d, pct,
      flag: regressed ? 'REGRESSION' : (improved ? 'better' : ''),
    });
    if (regressed) {
      findings.push({
        sev: 'regression', key: k,
        text: k + '  ' + m.label + '  ' + fmt(va) + ' -> ' + fmt(vb) +
          '  (' + (d > 0 ? '+' : '') + fmt(d) + ', ' + (pct > 0 ? '+' : '') + pct.toFixed(1) + '%)',
      });
    }
  }
}

function fmt(v) {
  if (v == null) return '-';
  if (Number.isInteger(v)) return String(v);
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3);
}
const sign = (v, digits = 1) => (v > 0 ? '+' : '') + v.toFixed(digits);

// ─────────────────────────────────────────────────────────────────── output ──

console.log('\n' + '='.repeat(100));
console.log('PERF DIFF');
console.log('  baseline : ' + files[0] + '   ' + (A.meta?.generatedAt || '?') + '   ' + (A.meta?.serverMode || '?'));
console.log('  new      : ' + files[1] + '   ' + (B.meta?.generatedAt || '?') + '   ' + (B.meta?.serverMode || '?'));
console.log('='.repeat(100));

if (A.meta?.gpu && B.meta?.gpu && A.meta.gpu !== B.meta.gpu) {
  console.log('\n!! DIFFERENT GPUS — these reports are not comparable:');
  console.log('   ' + A.meta.gpu + '\n   ' + B.meta.gpu);
}
if (A.meta?.serverMode !== B.meta?.serverMode) {
  console.log('\n!! One report is a dev build and the other is production — not comparable.');
}
const va = JSON.stringify(A.meta?.viewpoints), vb = JSON.stringify(B.meta?.viewpoints);
if (va && vb && va !== vb) {
  console.log('\n!! The derived viewpoints moved between runs (the level geometry changed).');
  console.log('   Scenario framing is not identical, so per-scenario deltas are only indicative.');
}

const byScenario = new Map();
for (const r of rows) {
  if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, {});
  byScenario.get(r.scenario)[r.metric] = r;
}

const headline = ['GPU ms', 'GPU p95', 'CPU ms', 'render JS', 'sim ms/step', '1% low ms', 'draws', 'tris'];
const table = [...byScenario.entries()].map(([k, m]) => ({ k, m }));

console.log('\n── HEADLINE DELTAS (new vs baseline, negative = faster) ──\n');
printTable(table, [
  { h: 'scenario', f: (r) => r.k },
  ...headline.flatMap((h) => [
    { h: h, r: true, f: (r) => (r.m[h] ? fmt(r.m[h].a) + '→' + fmt(r.m[h].b) : '-') },
    { h: '%', r: true, f: (r) => (r.m[h] ? (r.m[h].flag === 'REGRESSION' ? '! ' : r.m[h].flag === 'better' ? '  ' : '  ') + sign(r.m[h].pct) : '-') },
  ]),
]);

if (has('passes')) {
  const passNames = [...new Set(keys.flatMap((k) => [
    ...Object.keys(A.scenarios?.[k]?.best?.passBreakdown?.passes || {}),
    ...Object.keys(B.scenarios?.[k]?.best?.passBreakdown?.passes || {}),
  ]))];
  console.log('\n── PER-PASS GPU DELTAS (median ms) ──\n');
  printTable(keys.filter((k) => A.scenarios?.[k]?.best && B.scenarios?.[k]?.best).map((k) => ({ k })), [
    { h: 'scenario', f: (r) => r.k },
    ...passNames.map((p) => ({
      h: p === 'other(non-pass)' ? 'other' : p,
      r: true,
      f: (r) => {
        const x = A.scenarios[r.k].best.passBreakdown?.passes?.[p]?.median;
        const y = B.scenarios[r.k].best.passBreakdown?.passes?.[p]?.median;
        if (x == null || y == null) return '-';
        return y.toFixed(3) + ' (' + sign(y - x, 3) + ')';
      },
    })),
  ]);
}

const regressions = findings.filter((f) => f.sev === 'regression');
const others = findings.filter((f) => f.sev !== 'regression');

console.log('');
if (others.length) {
  console.log(others.length + ' structural difference(s):');
  for (const f of others) console.log('  ? ' + f.text);
  console.log('');
}
if (regressions.length) {
  console.log('REGRESSIONS (' + regressions.length + '):');
  for (const f of regressions) console.log('  ! ' + f.text);
} else {
  console.log('No regressions past threshold (GPU +3%, CPU +3%, render JS +4%, sim +6%,');
  console.log('1% low +6%, tris +1%, any increase in draw calls or program count).');
}

const improved = rows.filter((r) => r.flag === 'better');
if (improved.length) {
  console.log('\nIMPROVED (' + improved.length + '):');
  for (const r of improved.slice(0, 25)) {
    console.log('  + ' + r.scenario + '  ' + r.metric + '  ' + fmt(r.a) + ' -> ' + fmt(r.b) + '  (' + sign(r.pct) + '%)');
  }
}

// Repeat spread from both reports — a wide spread means the machine, not the code.
const spreads = keys.flatMap((k) => [A.scenarios?.[k]?.spread?.spreadPct, B.scenarios?.[k]?.spread?.spreadPct])
  .filter((v) => typeof v === 'number');
if (spreads.length) {
  const worst = Math.max(...spreads);
  console.log('\nworst repeat-to-repeat spread in either report: ' + worst.toFixed(1) + '%' +
    (worst > 5 ? '  <- noisy machine; deltas under this are not trustworthy' : ''));
}

if (has('json')) {
  console.log('\n' + JSON.stringify({ rows, findings }, null, 1));
}
console.log('');

process.exit(regressions.length ? 1 : 0);
