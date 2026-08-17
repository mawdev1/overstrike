/**
 * AUDIT D — time, the accumulator, and determinism.
 *
 *  1. Fixed step contract: every system's fixedUpdate must receive exactly 1/120.
 *  2. A 5 fps stall must not spiral: the accumulator is capped at 6 substeps and the
 *     backlog is dropped, so simulated time advances at most 6/120 s per frame.
 *  3. A 30 s backgrounded tab must not inject 30 s of simulation.
 *  4. Frame-rate independence: the same number of fixed steps must produce the same
 *     simulation whether they are delivered 1-per-frame or 6-per-frame.
 *  5. Same seed, same start conditions => identical match. If it diverges, bisect and
 *     report the first checkpoint and the first field that differs.
 */
import { boot } from './auditlib.mjs';

const h = await boot({ port: 5304, viewport: { width: 320, height: 240 } });
const { page } = h;

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  const R = { checks: [], data: {} };
  const ok = (name, cond, detail) => R.checks.push({ name, pass: !!cond, detail: String(detail) });
  const sim = (n) => { for (let i = 0; i < n; i++) g._fixedUpdate(1 / 120); };

  // ───────────────────────────────────── 1. dt handed to fixedUpdate is always 1/120
  {
    g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'regular', seed: 555 });
    const seen = new Set();
    const targets = ['player', 'bots', 'weapons', 'projectiles', 'match'];
    const originals = {};
    for (const t of targets) {
      const sys = g[t];
      if (!sys?.fixedUpdate) continue;
      originals[t] = sys.fixedUpdate.bind(sys);
      sys.fixedUpdate = (dt) => { seen.add(dt); return originals[t](dt); };
    }
    // Drive through the REAL frame loop with a variety of frame deltas.
    const realRaf = window.requestAnimationFrame;
    g.stop();
    window.requestAnimationFrame = () => 0;
    g._running = true;
    let now = performance.now();
    for (const dtMs of [8.3, 16.7, 33, 4, 120, 200, 1000, 16.7]) {
      now += dtMs;
      g._loop(now);
    }
    window.requestAnimationFrame = realRaf;
    for (const t of Object.keys(originals)) g[t].fixedUpdate = originals[t];
    g.start();

    R.data.dtValues = [...seen];
    ok('fixedDtIsAlways1over120', seen.size === 1 && Math.abs([...seen][0] - 1 / 120) < 1e-12,
      `distinct dt values seen: ${[...seen].join(', ')}`);
  }

  // ───────────────────────────────────── 2/3. stall + backgrounded tab, via _loop
  {
    g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'regular', seed: 556 });
    const realRaf = window.requestAnimationFrame;
    g.stop();
    window.requestAnimationFrame = () => 0;
    g._running = true;

    const drive = (frames, dtMs) => {
      const rows = [];
      let now = performance.now();
      for (let f = 0; f < frames; f++) {
        now += dtMs;
        const t0 = g.time;
        g._loop(now);
        rows.push({ simAdvance: +(g.time - t0).toFixed(6), accum: +g._accum.toFixed(6) });
      }
      return rows;
    };

    // A sustained 5 fps stall: 200 ms frames.
    const stall = drive(30, 200);
    const maxAdvance = Math.max(...stall.map((r) => r.simAdvance));
    const maxAccum = Math.max(...stall.map((r) => r.accum));
    R.data.stall5fps = { frames: stall.length, maxSimAdvancePerFrame: maxAdvance, maxAccum, sample: stall.slice(0, 5) };
    ok('stall:cappedAt6Substeps', Math.abs(maxAdvance - 6 / 120) < 1e-6,
      `max simulated time per frame = ${maxAdvance.toFixed(5)} s (6 substeps = ${(6 / 120).toFixed(5)} s)`);
    ok('stall:accumulatorCannotSpiral', maxAccum <= 1 / 120 + 1e-9,
      `max leftover accumulator = ${maxAccum.toFixed(6)} s`);

    // A 30 s backgrounded tab arriving as one enormous frame delta.
    const tBefore = g.time;
    let now = performance.now();
    now += 30000;
    g._loop(now);
    const injected = g.time - tBefore;
    R.data.backgrounded30s = { injectedSimSeconds: +injected.toFixed(5), accum: +g._accum.toFixed(6) };
    ok('backgroundedTab:clamped', injected <= 6 / 120 + 1e-6,
      `a 30 s gap injected ${injected.toFixed(4)} s of simulation`);

    window.requestAnimationFrame = realRaf;
    g.start();
  }

  // ───────────────────────────────── 4. frame-rate independence of the simulation
  {
    const digest = () => ({
      time: +g.time.toFixed(6),
      scores: [g.match.scores[0], g.match.scores[1]],
      kills: [...g.match._book.values()].reduce((a, s) => a + s.kills, 0),
      ents: g.entities.map((e) => `${e.position.x.toFixed(4)},${e.position.y.toFixed(4)},${e.position.z.toFixed(4)},${e.yaw.toFixed(4)},${e.health.toFixed(2)}`).join('|'),
    });
    const run = (substepsPerFrame) => {
      g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'regular', seed: 777 });
      const TOTAL = 120 * 30;
      for (let i = 0; i < TOTAL; i++) {
        g._fixedUpdate(1 / 120);
        // Deliver the per-frame visual update at the matching cadence.
        if ((i + 1) % substepsPerFrame === 0) g._update(substepsPerFrame / 120);
      }
      const d = digest();
      g.returnToMenu();
      return d;
    };
    const at1 = run(1);   // 120 fps
    const at6 = run(6);   // 20 fps
    const same = JSON.stringify(at1) === JSON.stringify(at6);
    R.data.frameRateIndependence = { at1: { ...at1, ents: at1.ents.slice(0, 90) }, at6: { ...at6, ents: at6.ents.slice(0, 90) }, same };
    ok('simIndependentOfFrameRate', same,
      same ? '3600 fixed steps produce the same state at 120 fps and 20 fps'
        : `diverged: ${['time', 'scores', 'kills', 'ents'].filter((k) => JSON.stringify(at1[k]) !== JSON.stringify(at6[k])).join(',')}`);
  }

  // ───────────────────────────────── 5. same seed => same match (and bisect if not)
  {
    const entDigest = () => g.entities.map((e) => [
      e.name, e.team, e.alive ? 1 : 0,
      +e.position.x.toFixed(4), +e.position.y.toFixed(4), +e.position.z.toFixed(4),
      +e.yaw.toFixed(4), +e.health.toFixed(2),
      e.state ?? '-', +(e.stateTimer ?? 0).toFixed(3),
      e.target ? e.target.name : '-',
    ].join(':'));

    const CHECKPOINTS = [0, 1, 2, 5, 10, 60, 120, 600, 1200, 2400, 3600];
    const runSeeded = (seed) => {
      g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'veteran', seed });
      const snaps = {};
      let step = 0;
      for (const cp of CHECKPOINTS) {
        while (step < cp) { g._fixedUpdate(1 / 120); step++; }
        snaps[cp] = entDigest();
      }
      g.returnToMenu();
      return snaps;
    };

    const a = runSeeded(31337);
    const b = runSeeded(31337);
    let firstBad = null;
    const diffs = {};
    for (const cp of CHECKPOINTS) {
      const da = a[cp], db = b[cp];
      const bad = [];
      for (let i = 0; i < Math.max(da.length, db.length); i++) {
        if (da[i] !== db[i]) bad.push({ i, a: da[i], b: db[i] });
      }
      if (bad.length) {
        diffs[cp] = bad.slice(0, 4);
        if (firstBad === null) firstBad = cp;
      }
    }
    R.data.determinism = { firstDivergingStep: firstBad, diffs };
    ok('sameSeedSameMatch', firstBad === null,
      firstBad === null ? 'identical through 3600 fixed steps'
        : `first divergence at fixed step ${firstBad}: ${JSON.stringify(diffs[firstBad][0])}`);
  }

  return R;
});

console.log('\n=========== AUDIT D — TIME & DETERMINISM ===========');
let fails = 0;
for (const c of out.checks) { if (!c.pass) fails++; console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`); }
console.log(`\n  ${out.checks.length - fails}/${out.checks.length} passed`);
console.log('\ndata:', JSON.stringify(out.data, null, 1));
if (h.errors.length) console.log('\npage errors:', [...new Set(h.errors)].slice(0, 12));
if (h.consoleErrors.length) console.log('\nconsole errors:', [...new Set(h.consoleErrors)].slice(0, 12));

await h.close();
