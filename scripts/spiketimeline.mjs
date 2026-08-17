/**
 * OVERSTRIKE — per-frame spike attribution for the real-GPU `worstcase` scenario.
 *
 * WHY
 * ---
 * `scripts/perf.mjs` reports that `worstcase` has a fine average (3.35 ms GPU, 182 fps)
 * and a terrible tail (1% low 32.6 ms, max frame 38.1 ms, 4.17% of frames past 2x median).
 * It tells you the tail exists; it does not tell you what is IN it. This does.
 *
 * WHAT IT DOES
 * ------------
 * Drives exactly the same scenario, through exactly the same page-side probe
 * (`perflib.PAGE_SRC` — same camera pinning, same locked 1/60 dtFrame, same settle, same
 * killstreak arming), then records a per-frame timeline with attribution:
 *
 *   time    : whole loop, and the fixed-sim split per SYSTEM (player/bots/weapons/
 *             projectiles/match), engine.update, engine.render(JS submit)
 *   work    : fixed substeps, world.losClear marches, world.raycast, A* searches
 *             (nav.findPath), spawnEntity calls, entity deaths, explosions, hitscan
 *             shots, fx particle emissions
 *   stalls  : GL programs linked this frame (a shader link is a hard stall), and
 *             usedJSHeapSize drop (a major GC)
 *
 * It then ranks spike causes by TOTAL CONTRIBUTED MILLISECONDS: for every frame past
 * 2x the median, the excess over median is attributed to whichever signal that frame
 * carries, so "cost 3 ms 40 times" outranks "cost 30 ms once".
 *
 * `src/` is never modified — everything is monkey-patched from inside the page.
 *
 * Usage:
 *   node scripts/spiketimeline.mjs [--label=before] [--port=5399] [--no-build]
 *                                  [--scenario=worstcase] [--frames=900] [--res=1920x1080]
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, startServer, launchBrowser, EARLY_SRC, PAGE_SRC, settingsInitScript, stat, r2,
} from './perflib.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const has = (k) => argv.includes('--' + k);

const LABEL = arg('label', 'before');
const PORT = Number(arg('port', 5399));
const FRAMES = Number(arg('frames', 900));
const SC_NAME = arg('scenario', 'worstcase');
const [RW, RH] = arg('res', '1920x1080').split('x').map(Number);

const SCENARIOS = {
  typical: { name: 'typical', kind: 'match', bots: 8, difficulty: 'veteran', seed: 3003, view: 'mid', fire: false, streaks: false },
  heavy: { name: 'heavy', kind: 'match', bots: 24, difficulty: 'veteran', seed: 4004, view: 'mid', fire: true, streaks: false },
  worstcase: { name: 'worstcase', kind: 'match', bots: 24, difficulty: 'veteran', seed: 5005, view: 'long', fire: true, streaks: true },
};
const SC = SCENARIOS[SC_NAME];
if (!SC) throw new Error('unknown scenario ' + SC_NAME);

// ─────────────────────────────────────────────────── the attribution page probe ──
//
// Installed AFTER perflib's PAGE_SRC, wrapping the loop it already installed. No
// template literals / `${` inside — this lives in a Node-side template literal.
const ATTR_SRC = `
(function () {
  var g = window.__GAME__;
  if (!g) return { ok: false, error: 'no game' };
  if (window.__A) return { ok: true, already: true };

  var A = {};
  var C = {                    // per-frame counters, zeroed at the top of every frame
    los: 0, ray: 0, path: 0, spawn: 0, deaths: 0, explode: 0, shots: 0, hits: 0,
    fxParticles: 0, fxExplosion: 0, fxTracer: 0, streakAct: 0, sentryFire: 0, chopperFire: 0,
  };
  var S = { player: 0, bots: 0, weapons: 0, projectiles: 0, match: 0, bounds: 0 };

  // ── structural counters ───────────────────────────────────────────────────
  var w = g.world;
  var losO = w.losClear.bind(w);
  w.losClear = function (a, b) { C.los++; return losO(a, b); };
  var rayO = w.raycast.bind(w);
  w.raycast = function (o, d, m) { C.ray++; return rayO(o, d, m); };

  if (g.nav && typeof g.nav.findPath === 'function') {
    var fpO = g.nav.findPath.bind(g.nav);
    g.nav.findPath = function (a, b, out) { C.path++; return fpO(a, b, out); };
  }

  var sp = g.match && g.match.spawner;
  if (sp) {
    var seO = sp.spawnEntity.bind(sp);
    sp.spawnEntity = function (e) { C.spawn++; return seO(e); };
  }

  var fx = g.fx;
  if (fx) {
    if (fx.explosion) { var exO = fx.explosion.bind(fx); fx.explosion = function (p, r) { C.fxExplosion++; return exO(p, r); }; }
    if (fx.impact) { var imO = fx.impact.bind(fx); fx.impact = function (a, b, c) { C.fxParticles++; return imO(a, b, c); }; }
    if (fx.bloodSpray) { var bsO = fx.bloodSpray.bind(fx); fx.bloodSpray = function (a, b, c) { C.fxParticles++; return bsO(a, b, c); }; }
    if (fx.tracer) { var trO = fx.tracer.bind(fx); fx.tracer = function (a, b, c, d, e) { C.fxTracer++; return trO(a, b, c, d, e); }; }
  }

  g.bus.on('kill', function () { C.deaths++; });
  g.bus.on('explosion', function () { C.explode++; });
  g.bus.on('shot', function () { C.shots++; });
  g.bus.on('hit', function () { C.hits++; });
  g.bus.on('killstreakActivated', function () { C.streakAct++; });

  // ── per-system fixed-step timing ──────────────────────────────────────────
  // Wrap Game._safe, which is the single funnel every system call in _fixedUpdate goes
  // through. One timestamp pair per system per substep; performance.now() is 5 us
  // clamped under COOP+COEP, and a whole worstcase substep is ~0.4 ms, so a per-frame
  // SUM over 1-6 substeps is well clear of the clamp.
  var safeO = g._safe.bind(g);
  g._safe = function (system, phase, obj, method, a2) {
    if (phase !== 'fixed') return safeO(system, phase, obj, method, a2);
    var t = performance.now();
    safeO(system, phase, obj, method, a2);
    S[system] = (S[system] || 0) + (performance.now() - t);
  };

  // ── the timeline ──────────────────────────────────────────────────────────
  var REC = null;
  var prev = 0;
  var loopO = g._loop;             // perflib's wrapper — keep the whole harness intact

  // Substep count for the frame about to run. perflib's wrapper calls the real loop,
  // which calls _fixedUpdate 0..6 times; counting here is the only place that sees it.
  var stepsThisFrame = 0;
  var fuO = g._fixedUpdate;        // perflib already wrapped this — keep its wrapper
  g._fixedUpdate = function (dt) { stepsThisFrame++; return fuO.call(g, dt); };

  function mk(n) {
    var f = function () { return new Float64Array(n); };
    return {
      want: n, got: 0, done: false, resolve: null,
      dt: f(), loop: f(), fixed: f(), upd: f(), engUpd: f(), engRender: f(), steps: f(),
      sPlayer: f(), sBots: f(), sWeapons: f(), sProjectiles: f(), sMatch: f(),
      los: f(), ray: f(), path: f(), spawn: f(), deaths: f(), explode: f(),
      shots: f(), hits: f(), fxParticles: f(), fxExplosion: f(), fxTracer: f(), streakAct: f(),
      progs: f(), heap: f(), gcDrop: f(), draws: f(), tris: f(),
      elapsed: f(), alive: f(),
    };
  }

  g._loop = function (now) {
    var rec = REC && !REC.done && REC.got < REC.want;
    if (rec) {
      C.los = 0; C.ray = 0; C.path = 0; C.spawn = 0; C.deaths = 0; C.explode = 0;
      C.shots = 0; C.hits = 0; C.fxParticles = 0; C.fxExplosion = 0; C.fxTracer = 0;
      C.streakAct = 0;
      S.player = 0; S.bots = 0; S.weapons = 0; S.projectiles = 0; S.match = 0;
    }
    stepsThisFrame = 0;
    var progsBefore = g.renderer.info.programs ? g.renderer.info.programs.length : 0;
    var heapBefore = performance.memory ? performance.memory.usedJSHeapSize : 0;
    var t0 = performance.now();

    loopO(now);

    var t1 = performance.now();
    if (rec) {
      var i = REC.got++;
      REC.dt[i] = prev ? now - prev : 0;
      REC.loop[i] = t1 - t0;
      REC.steps[i] = stepsThisFrame;
      REC.sPlayer[i] = S.player; REC.sBots[i] = S.bots; REC.sWeapons[i] = S.weapons;
      REC.sProjectiles[i] = S.projectiles; REC.sMatch[i] = S.match;
      REC.los[i] = C.los; REC.ray[i] = C.ray; REC.path[i] = C.path; REC.spawn[i] = C.spawn;
      REC.deaths[i] = C.deaths; REC.explode[i] = C.explode; REC.shots[i] = C.shots;
      REC.hits[i] = C.hits; REC.fxParticles[i] = C.fxParticles;
      REC.fxExplosion[i] = C.fxExplosion; REC.fxTracer[i] = C.fxTracer;
      REC.streakAct[i] = C.streakAct;
      var progsAfter = g.renderer.info.programs ? g.renderer.info.programs.length : 0;
      REC.progs[i] = progsAfter - progsBefore;
      var heapAfter = performance.memory ? performance.memory.usedJSHeapSize : 0;
      REC.heap[i] = heapAfter;
      REC.gcDrop[i] = heapBefore > heapAfter ? (heapBefore - heapAfter) : 0;
      REC.draws[i] = g.renderer.info.render.calls;
      REC.tris[i] = g.renderer.info.render.triangles;
      REC.elapsed[i] = g.match ? g.match.elapsed : 0;
      var n = 0;
      if (g.bots) for (var k = 0; k < g.bots.bots.length; k++) if (g.bots.bots[k].alive) n++;
      REC.alive[i] = n;
      if (REC.got >= REC.want) {
        REC.done = true;
        var r = REC.resolve; REC.resolve = null;
        if (r) r(A.collect());
      }
    }
    prev = now;
  };

  A.record = function (n) {
    REC = mk(n);
    return new Promise(function (res) { REC.resolve = res; });
  };

  A.collect = function () {
    var R = REC;
    if (!R) return null;
    var cut = function (t) { return Array.prototype.slice.call(t, 0, R.got); };
    var out = {
      frames: R.got,
      dt: cut(R.dt), loop: cut(R.loop), steps: cut(R.steps),
      sPlayer: cut(R.sPlayer), sBots: cut(R.sBots), sWeapons: cut(R.sWeapons),
      sProjectiles: cut(R.sProjectiles), sMatch: cut(R.sMatch),
      los: cut(R.los), ray: cut(R.ray), path: cut(R.path), spawn: cut(R.spawn),
      deaths: cut(R.deaths), explode: cut(R.explode), shots: cut(R.shots), hits: cut(R.hits),
      fxParticles: cut(R.fxParticles), fxExplosion: cut(R.fxExplosion), fxTracer: cut(R.fxTracer),
      streakAct: cut(R.streakAct),
      progs: cut(R.progs), heap: cut(R.heap), gcDrop: cut(R.gcDrop),
      draws: cut(R.draws), tris: cut(R.tris),
      elapsed: cut(R.elapsed), alive: cut(R.alive),
    };
    REC = null;
    return out;
  };

  A.armState = function () {
    var ks = g.match && g.match.killstreaks;
    if (!ks) return null;
    return {
      sentries: ks._sentries.filter(function (s) { return s.active; }).length,
      choppers: ks._choppers.filter(function (c) { return c.active; }).length,
      strikes: ks._strikes.filter(function (s) { return s.active; }).length,
      uav: ks.uavActive(g.player.team),
    };
  };

  window.__A = A;
  return { ok: true };
})()
`;

// ────────────────────────────────────────────────────────────────────── reduce ──

function pct(a, p) {
  const s = Float64Array.from(a.filter(Number.isFinite)).sort();
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}

/**
 * Rank spike causes by total contributed ms.
 *
 * For every frame over `2 x median` the EXCESS over median is the hitch cost. That
 * excess is credited to the frame's dominant signal, chosen by a fixed precedence:
 * a shader link or a GC pause explains a frame outright; otherwise the biggest
 * fixed-sim system that also carries structural work wins; otherwise it is charged to
 * whichever timing bucket dominates. Frames with no explanation land in `unattributed`
 * — which is the honest answer when the stall was outside our JS.
 */
function attribute(t) {
  const med = pct(t.dt, 50);
  const buckets = new Map();
  const rows = [];
  const add = (k, ms, frame) => {
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = { cause: k, frames: 0, ms: 0, worstMs: 0, worstFrame: -1 }));
    b.frames++;
    b.ms += ms;
    if (ms > b.worstMs) { b.worstMs = ms; b.worstFrame = frame; }
  };

  for (let i = 0; i < t.frames; i++) {
    const d = t.dt[i];
    if (!(d > med * 2)) continue;
    const excess = d - med;
    const sim = t.sPlayer[i] + t.sBots[i] + t.sWeapons[i] + t.sProjectiles[i] + t.sMatch[i];
    let cause;
    if (t.progs[i] > 0) cause = 'shader link (' + t.progs[i] + ' programs)';
    else if (t.spawn[i] > 0) cause = 'entity respawn (spawner LOS scoring)';
    else if (t.explode[i] > 0 || t.fxExplosion[i] > 0) cause = 'explosion (airstrike/grenade)';
    else if (t.path[i] > 0 && t.sBots[i] > sim * 0.5) cause = 'A* pathfinding';
    else if (t.gcDrop[i] > 1e6) cause = 'GC pause';
    else if (t.sBots[i] > 1.0) cause = 'bot AI (no A*)';
    else if (sim > 2.0) cause = 'fixed sim (other)';
    else if (t.loop[i] < med) cause = 'outside JS (compositor/driver/present)';
    else cause = 'unattributed JS';
    add(cause, excess, i);
    rows.push({
      frame: i, ms: r2(d), loop: r2(t.loop[i]), steps: t.steps[i],
      sim: r2(sim), bots: r2(t.sBots[i]), match: r2(t.sMatch[i]), proj: r2(t.sProjectiles[i]),
      player: r2(t.sPlayer[i]), weapons: r2(t.sWeapons[i]),
      los: t.los[i], ray: t.ray[i], astar: t.path[i], spawn: t.spawn[i],
      deaths: t.deaths[i], explode: t.explode[i], fxExp: t.fxExplosion[i],
      shots: t.shots[i], progs: t.progs[i], gcMB: r2(t.gcDrop[i] / 1048576),
      alive: t.alive[i], elapsed: r2(t.elapsed[i]), cause,
    });
  }
  rows.sort((a, b) => b.ms - a.ms);
  const ranked = [...buckets.values()].sort((a, b) => b.ms - a.ms)
    .map((b) => ({ ...b, ms: r2(b.ms), worstMs: r2(b.worstMs) }));
  return { medianMs: r2(med), spikeFrames: rows.length, ranked, worst: rows.slice(0, 25) };
}

// ───────────────────────────────────────────────────────────────────────── run ──

let server, browser;
const outObj = { label: LABEL, scenario: SC_NAME, generatedAt: new Date().toISOString() };
try {
  server = await startServer({ dev: false, port: PORT, doBuild: !has('no-build') });
  console.log('[spiketimeline] ' + server.mode + ' at ' + server.url);
  browser = await launchBrowser({});
  const ctx = await browser.newContext({ viewport: { width: RW, height: RH }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(600000);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await page.addInitScript({ content: EARLY_SRC });
  await page.addInitScript({ content: settingsInitScript() });
  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__GAME__ && window.__GAME__.state === 'menu', null,
    { timeout: 300000, polling: 100 });

  const inst = await page.evaluate(PAGE_SRC);
  if (!inst?.ok) throw new Error('perflib probe install failed');
  const info = await page.evaluate(() => window.__P.info());
  console.log('[spiketimeline] gpu: ' + info.renderer + '  timerQuery=' + info.timerQuery +
    '  gc=' + info.gc + '  memory=' + info.memory + '  clock=' + info.timerResolutionMs + ' ms');
  outObj.gpu = info.renderer;
  outObj.boot = info.boot ? {
    firstFrameMs: r2(info.boot.firstFrameMs),
    programsAtFirstFrame: info.boot.firstFrameProgs,
    worstBootFrameMs: info.boot.bootFrames.length ? r2(Math.max(...info.boot.bootFrames)) : null,
  } : null;
  outObj.prewarm = await page.evaluate(() => (window.__GAME__.bootProfile || {}).programs || null);

  const inst2 = await page.evaluate(ATTR_SRC);
  if (!inst2?.ok) throw new Error('attribution probe install failed: ' + JSON.stringify(inst2));

  await page.evaluate((ms) => window.__P.burnIn(ms), 3000);
  const views = await page.evaluate(() => window.__P.viewpoints());

  // ── PHASE 1 — match start / settle. This is where the shader hitching lives.
  const settleTimeline = await page.evaluate(async (a) => {
    window.__P.setup(a.sc);
    if (a.sc.streaks) window.__P.arm();
    const p = window.__A.record(a.n);
    return await p;
  }, { sc: { ...SC, view: views[SC.view] }, n: 600 });
  outObj.settlePhase = attribute(settleTimeline);
  outObj.settlePhase.programsLinked = settleTimeline.progs.reduce((x, y) => x + y, 0);
  outObj.settlePhase.programLinkFrames = settleTimeline.progs
    .map((v, i) => ({ i, v, ms: r2(settleTimeline.dt[i]) }))
    .filter((r) => r.v > 0).slice(0, 40);

  // ── PHASE 2 — headline steady state, exactly as perf.mjs samples it.
  const mainTimeline = await page.evaluate(async (a) => {
    const s = await window.__P.settle({ maxFrames: 1800, quiet: 150, padTo: 900 });
    if (a.streaks) window.__P.arm();
    const before = window.__A.armState();
    const t = await window.__A.record(a.n);
    return { t, settle: s, armed: before, after: window.__A.armState() };
  }, { n: FRAMES, streaks: SC.streaks });

  outObj.settle = mainTimeline.settle;
  outObj.armed = mainTimeline.armed;
  outObj.armedAfter = mainTimeline.after;
  const T = mainTimeline.t;
  outObj.main = attribute(T);
  outObj.main.intervalMs = stat(T.dt);
  outObj.main.loopMs = stat(T.loop);
  outObj.main.simMs = stat(T.dt.map((_, i) => T.sPlayer[i] + T.sBots[i] + T.sWeapons[i] + T.sProjectiles[i] + T.sMatch[i]));
  outObj.main.perSystemMedianMs = {
    player: r2(pct(T.sPlayer, 50)), bots: r2(pct(T.sBots, 50)), weapons: r2(pct(T.sWeapons, 50)),
    projectiles: r2(pct(T.sProjectiles, 50)), match: r2(pct(T.sMatch, 50)),
  };
  outObj.main.perSystemP99Ms = {
    player: r2(pct(T.sPlayer, 99)), bots: r2(pct(T.sBots, 99)), weapons: r2(pct(T.sWeapons, 99)),
    projectiles: r2(pct(T.sProjectiles, 99)), match: r2(pct(T.sMatch, 99)),
  };
  outObj.main.totals = {
    los: T.los.reduce((a, b) => a + b, 0), ray: T.ray.reduce((a, b) => a + b, 0),
    astar: T.path.reduce((a, b) => a + b, 0), spawns: T.spawn.reduce((a, b) => a + b, 0),
    deaths: T.deaths.reduce((a, b) => a + b, 0), explosions: T.explode.reduce((a, b) => a + b, 0),
    shots: T.shots.reduce((a, b) => a + b, 0), programsLinked: T.progs.reduce((a, b) => a + b, 0),
  };
  outObj.main.losPerFrame = stat(T.los);
  outObj.main.astarPerFrame = stat(T.path);
  outObj.main.stepsPerFrame = stat(T.steps);
  // Does a 6-substep catch-up frame still multiply AI work?
  const bySteps = {};
  for (let i = 0; i < T.frames; i++) {
    const k = T.steps[i] || 0;
    (bySteps[k] || (bySteps[k] = { n: 0, astar: 0, los: 0, botsMs: 0 }));
    bySteps[k].n++; bySteps[k].astar += T.path[i]; bySteps[k].los += T.los[i]; bySteps[k].botsMs += T.sBots[i];
  }
  outObj.main.bySubstepCount = Object.fromEntries(Object.entries(bySteps).map(([k, v]) => [k, {
    frames: v.n, astarPerFrame: r2(v.astar / v.n), losPerFrame: r2(v.los / v.n), botsMs: r2(v.botsMs / v.n),
  }]));

  outObj.pageErrors = [...new Set(pageErrors)].slice(0, 8);
  await ctx.close();
} catch (err) {
  outObj.error = String(err && err.stack ? err.stack : err);
  console.error(err);
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
}

const outPath = path.resolve(ROOT, 'perf', 'spiketimeline.' + LABEL + '.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(outObj, null, 1));

// ────────────────────────────────────────────────────────────────────── report ──
const P = (s) => console.log(s);
P('\n' + '='.repeat(100));
P('SPIKE ATTRIBUTION — ' + SC_NAME + ' @ ' + RW + 'x' + RH + '   label=' + LABEL);
P('='.repeat(100));
if (outObj.error) { P('ERROR: ' + outObj.error.split('\n')[0]); process.exit(1); }

P('\nboot: ' + JSON.stringify(outObj.boot) + '   prewarm programs: ' + JSON.stringify(outObj.prewarm));
P('settle: ' + JSON.stringify(outObj.settle) + '   armed: ' + JSON.stringify(outObj.armed));

for (const [phase, key] of [['MATCH START / SETTLE', 'settlePhase'], ['STEADY STATE (headline sample)', 'main']]) {
  const a = outObj[key];
  if (!a) continue;
  P('\n── ' + phase + ' ── median frame ' + a.medianMs + ' ms, ' + a.spikeFrames + ' frames >2x median');
  if (key === 'settlePhase') P('   programs linked during phase: ' + a.programsLinked);
  P('   ranked spike causes (total contributed ms over median):');
  for (const b of a.ranked) {
    P('     ' + String(r2(b.ms)).padStart(8) + ' ms  ' + String(b.frames).padStart(4) + ' frames  worst ' +
      String(b.worstMs).padStart(7) + ' ms  ' + b.cause);
  }
}

const m = outObj.main;
if (m) {
  P('\n   interval ms: median ' + m.intervalMs.median + '  p95 ' + m.intervalMs.p95 +
    '  p99 ' + m.intervalMs.p99 + '  max ' + m.intervalMs.max);
  P('   fixed-sim ms per frame by system (median / p99):');
  for (const k of Object.keys(m.perSystemMedianMs)) {
    P('     ' + k.padEnd(12) + String(m.perSystemMedianMs[k]).padStart(7) + '  /  ' + String(m.perSystemP99Ms[k]).padStart(7));
  }
  P('   totals over sample: ' + JSON.stringify(m.totals));
  P('   losClear/frame: ' + JSON.stringify(m.losPerFrame));
  P('   A*/frame: ' + JSON.stringify(m.astarPerFrame));
  P('   substeps/frame: ' + JSON.stringify(m.stepsPerFrame));
  P('   work by substep count: ' + JSON.stringify(m.bySubstepCount));
  P('\n   worst frames:');
  P('   ' + ['frame', 'ms', 'loop', 'sim', 'bots', 'match', 'proj', 'los', 'ray', 'A*', 'spwn', 'dth', 'exp', 'prog', 'gcMB', 'cause'].join('\t'));
  for (const r of m.worst.slice(0, 20)) {
    P('   ' + [r.frame, r.ms, r.loop, r.sim, r.bots, r.match, r.proj, r.los, r.ray, r.astar,
      r.spawn, r.deaths, r.explode, r.progs, r.gcMB, r.cause].join('\t'));
  }
}
if (outObj.pageErrors?.length) P('\npage errors: ' + outObj.pageErrors.join(' | '));
P('\nwrote ' + path.relative(ROOT, outPath));
