/**
 * SPIKE PROBE — match-start and clustered-respawn frame cost.
 *
 * Targets two measured defects:
 *   A2  match start scores every spawn point for every entity, running one `losClear`
 *       march per enemy per point. Measured as: wall time of `Match.begin()` and of the
 *       whole `startMatch()`, the exact number of `losClear` calls inside `begin()`, and
 *       the isolated cost of a single `Spawner.pickSpawn()` with a full 24-bot lobby.
 *   A3  bots killed on the same simulation step share one respawn deadline, so their
 *       spawn searches land on a single fixed step. Measured as: the worst single fixed
 *       step and the worst 6-step window (one rAF frame at the 6-substep cap from
 *       ARCHITECTURE §1) across a scenario where N bots die on the same step, plus the
 *       exact number of spawns and `losClear` marches on the worst step.
 *
 * Everything is instrumented from the probe side — `src/` is never modified by this
 * file. `losClear` / `raycast` / `spawnEntity` are wrapped with counters so the
 * structural numbers are exact and independent of timer resolution; wall times are
 * reported as min AND median over repeated trials because headless Chromium under
 * SwiftShader is noisy (GC lands on single frames).
 *
 * NOTE ON THE CLOCK: `Game._fixedUpdate()` advances `game.time` itself. Driving it in a
 * loop that ALSO does `g.time += 1/120` (as scripts/auditmatch.mjs does) runs `game.time`
 * at double rate against `match.elapsed`, which silently changes the race between the
 * Match respawn deadline (3.4 s of `match.elapsed`) and BotManager's fallback respawn
 * (3.5 s of `game.time`). This probe advances the clock only through `_fixedUpdate`.
 *
 * Usage: node scripts/spikeprobe.mjs [--label=before] [--bots=24] [--runs=7] [--kills=6]
 */
import { boot, report } from './auditlib.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const LABEL = arg('label', 'run');
const BOTS = Number(arg('bots', 24));
const RUNS = Number(arg('runs', 7));
const KILLS = Number(arg('kills', 6));

const { page, close, consoleErrors, errors } = await boot({ port: 5233 });

const out = await page.evaluate(async ({ BOTS, RUNS, KILLS }) => {
  const g = window.__GAME__;
  const R = { starts: {}, pick: {}, clusters: {}, resetCalls: {}, determinism: {}, notes: [] };

  // ---------------------------------------------------------------- instrumentation
  const world = g.world;
  const losOrig = world.losClear.bind(world);
  let los = 0;
  world.losClear = (a, b) => { los++; return losOrig(a, b); };

  const rayOrig = world.raycast.bind(world);
  let rays = 0;
  world.raycast = (o, d, m) => { rays++; return rayOrig(o, d, m); };

  const spawner = g.match.spawner;
  const spawnOrig = spawner.spawnEntity.bind(spawner);
  let spawns = 0;
  let spawnLog = null;
  let spawnMs = null;
  spawner.spawnEntity = (e) => {
    spawns++;
    if (spawnLog) spawnLog.push(`${e?.name || '?'}@${g.match.elapsed.toFixed(2)}`);
    if (!spawnMs) return spawnOrig(e);
    const t = performance.now();
    const r = spawnOrig(e);
    spawnMs.push(performance.now() - t);
    return r;
  };

  // `scorePoint` calls == candidate spawn points actually scored. This is the direct
  // structural measure of A2's candidate-set pruning, independent of timer noise.
  const scoreOrig = spawner.scorePoint.bind(spawner);
  let scored = 0;
  spawner.scorePoint = (p, e) => { scored++; return scoreOrig(p, e); };

  let fxResets = 0;
  const fxOrig = g.fx.reset.bind(g.fx);
  g.fx.reset = (...a) => { fxResets++; return fxOrig(...a); };
  let projResets = 0;
  const pjOrig = g.projectiles.reset.bind(g.projectiles);
  g.projectiles.reset = (...a) => { projResets++; return pjOrig(...a); };

  // Simulation drivers. `_fixedUpdate` owns the clock — see the header note.
  const step = () => { g.frame++; g._fixedUpdate(1 / 120); };
  const stepFull = () => { g.frame++; g._fixedUpdate(1 / 120); g._update(1 / 120); };
  const sim = (sec) => { const n = Math.round(sec * 120); for (let i = 0; i < n; i++) step(); };
  const simFull = (sec) => { const n = Math.round(sec * 120); for (let i = 0; i < n; i++) stepFull(); };
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(2); };
  const min = (a) => +Math.min(...a).toFixed(2);
  const r2 = (x) => +x.toFixed(2);

  // ---------------------------------------------- baseline: cost of one losClear march
  {
    g.startMatch({ mode: 'tdm', botCount: BOTS, difficulty: 'regular', seed: 11 });
    sim(4);
    const a = { x: 0, y: 1.62, z: 0 };
    const b = { x: 0, y: 1.62, z: 0 };
    const pts = spawner.points;
    const trials = [];
    for (let t = 0; t < 5; t++) {
      const t0 = performance.now();
      const N = 2000;
      for (let i = 0; i < N; i++) {
        const p = pts[i % pts.length].position;
        const q = pts[(i * 7 + 3) % pts.length].position;
        a.x = p.x; a.y = p.y + 1.62; a.z = p.z;
        b.x = q.x; b.y = q.y + 1.62; b.z = q.z;
        losOrig(a, b);
      }
      trials.push((performance.now() - t0) / N * 1000);   // microseconds per march
    }
    R.losMarchUs = { min: min(trials), median: med(trials) };
    g.returnToMenu();
  }

  // ------------------------------------------------------------------ A2: match start
  const beginOrig = g.match.begin;
  function startTimed(opts) {
    let beginMs = 0; let beginLos = 0; let beginRays = 0; let beginSpawns = 0;
    let beginScored = 0; let beginSpawnMs = 0;
    g.match.begin = function (o) {
      spawnMs = [];
      const l0 = los; const r0 = rays; const s0 = spawns; const c0 = scored;
      const t = performance.now();
      beginOrig.call(this, o);
      beginMs = performance.now() - t;
      beginLos = los - l0; beginRays = rays - r0; beginSpawns = spawns - s0;
      beginScored = scored - c0;
      beginSpawnMs = spawnMs.reduce((a, x) => a + x, 0);
      spawnMs = null;
    };
    const l0 = los; const r0 = rays; const t0 = performance.now();
    g.startMatch(opts);
    const totalMs = performance.now() - t0;
    g.match.begin = beginOrig;
    return {
      totalMs: r2(totalMs), beginMs: r2(beginMs), spawnMs: r2(beginSpawnMs),
      beginLos, beginRays, beginSpawns, beginScored,
      totalLos: los - l0, totalRays: rays - r0,
    };
  }

  const MODES = ['tdm'];
  for (const mode of MODES) {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      runs.push(startTimed({ mode, botCount: BOTS, difficulty: 'regular', seed: 99 }));
      g.returnToMenu();
    }
    R.starts[mode] = {
      beginMs: { min: min(runs.map((r) => r.beginMs)), median: med(runs.map((r) => r.beginMs)), first: runs[0].beginMs },
      startMatchMs: { min: min(runs.map((r) => r.totalMs)), median: med(runs.map((r) => r.totalMs)) },
      spawnEntityMs: { min: min(runs.map((r) => r.spawnMs)), median: med(runs.map((r) => r.spawnMs)) },
      beginLos: runs.map((r) => r.beginLos),
      beginRays: runs.map((r) => r.beginRays),
      beginSpawns: runs[0].beginSpawns,
      pointsScored: runs[0].beginScored,
    };
  }
  R.resetCalls = {
    fxResetsPerStart: +(fxResets / (MODES.length * RUNS + 1)).toFixed(2),
    projResetsPerStart: +(projResets / (MODES.length * RUNS + 1)).toFixed(2),
  };

  // ------------------------------- A2 isolated: one pickSpawn against a full live lobby
  // The worst case for the spawn scorer is a live match with every bot alive, which is
  // exactly the mid-match respawn case; `begin()` only ever sees the lobby half-spawned.
  for (const mode of ['tdm']) {
    g.startMatch({ mode, botCount: BOTS, difficulty: 'regular', seed: 21 });
    sim(4);
    const alive = g.bots.bots.filter((b) => b.alive).length;
    const trials = [];
    const losPer = [];
    const scoredPer = [];
    for (let t = 0; t < 5; t++) {
      const N = 200;
      const l0 = los; const c0 = scored; const t0 = performance.now();
      for (let i = 0; i < N; i++) spawner.pickSpawn(g.bots.bots[i % g.bots.bots.length]);
      trials.push((performance.now() - t0) / N);
      losPer.push((los - l0) / N);
      scoredPer.push((scored - c0) / N);
    }
    R.pick[mode] = {
      aliveBots: alive,
      msPerPick: { min: min(trials), median: med(trials) },
      losPerPick: +med(losPer).toFixed(1),
      pointsScoredPerPick: +med(scoredPer).toFixed(1),
    };
    g.returnToMenu();
  }

  // ---------------------------------------------------- A3: clustered respawn spike
  function cluster(mode, killN) {
    g.startMatch({ mode, botCount: BOTS, difficulty: 'regular', seed: 1234 });
    g.match.timeLimit = 100000;
    sim(4.2);                              // through the 3 s countdown, into 'live'

    const victims = g.bots.bots.filter((b) => b.alive).slice(0, killN);
    for (const b of victims) b.die({ attacker: g.player, weaponId: 'ar_vector' });
    const killedAt = g.match.elapsed;

    spawnLog = [];
    spawnMs = [];
    const N = 120 * 8;                     // 8 s covers the respawn window plus jitter
    const ms = new Float64Array(N);
    const lo = new Int32Array(N);
    const sp = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      const l0 = los; const s0 = spawns; const t = performance.now();
      step();
      ms[i] = performance.now() - t; lo[i] = los - l0; sp[i] = spawns - s0;
    }
    const log = spawnLog; spawnLog = null;
    const perSpawn = spawnMs; spawnMs = null;

    let worstMs = 0; let worstIdx = -1;
    let worstLos = 0; let worstLosIdx = -1;
    let maxSpawns = 0; let maxSpawnIdx = -1; let totalSpawns = 0; let sum = 0;
    for (let i = 0; i < N; i++) {
      sum += ms[i];
      if (ms[i] > worstMs) { worstMs = ms[i]; worstIdx = i; }
      if (lo[i] > worstLos) { worstLos = lo[i]; worstLosIdx = i; }
      if (sp[i] > maxSpawns) { maxSpawns = sp[i]; maxSpawnIdx = i; }
      totalSpawns += sp[i];
    }
    // One rAF frame is at most 6 fixed substeps (ARCHITECTURE §1), so the hitch a player
    // actually feels is the worst 6-step window, not the worst single step.
    let worstFrameMs = 0; let worstFrameLos = 0; let worstFrameSpawns = 0;
    for (let i = 0; i + 6 <= N; i++) {
      let m = 0; let l = 0; let s = 0;
      for (let k = 0; k < 6; k++) { m += ms[i + k]; l += lo[i + k]; s += sp[i + k]; }
      if (m > worstFrameMs) { worstFrameMs = m; }
      if (l > worstFrameLos) { worstFrameLos = l; worstFrameSpawns = s; }
    }
    const spawnSteps = [];
    for (let i = 0; i < N; i++) if (sp[i]) spawnSteps.push(`${i}:${sp[i]}`);

    // Noise floor: this machine GCs on individual steps, so a single worst-step number
    // is meaningless without the distribution of steps that did no spawn work at all.
    const quiet = [];
    for (let i = 0; i < N; i++) if (!sp[i]) quiet.push(ms[i]);
    quiet.sort((a, b) => a - b);
    const pct = (p) => r2(quiet[Math.min(quiet.length - 1, Math.floor(quiet.length * p))]);

    const res = {
      killed: victims.length,
      killedAtElapsed: r2(killedAt),
      quietStepMs: { p50: pct(0.5), p99: pct(0.99), max: r2(quiet[quiet.length - 1]) },
      spawnEntityMs: perSpawn.length
        ? { n: perSpawn.length, min: r2(Math.min(...perSpawn)), median: med(perSpawn), max: r2(Math.max(...perSpawn)) }
        : null,
      // The step that did the most spawn work — the defect's actual signature.
      maxSpawnsInStep: maxSpawns,
      msOfMaxSpawnStep: r2(ms[maxSpawnIdx] || 0),
      losOfMaxSpawnStep: lo[maxSpawnIdx] || 0,
      worstLosStep: { los: worstLos, ms: r2(ms[worstLosIdx] || 0), at: worstLosIdx, spawns: sp[worstLosIdx] || 0 },
      worstStepMs: r2(worstMs), worstStepAt: worstIdx, worstStepSpawns: sp[worstIdx] || 0,
      worstFrameMs: r2(worstFrameMs),
      worstFrameLos, worstFrameSpawns,
      meanStepMs: +(sum / N).toFixed(4),
      totalSpawns,
      spawnSteps: spawnSteps.slice(0, 40),
      spawnLog: log.slice(0, 24),
    };
    g.returnToMenu();
    return res;
  }

  // Repeat the whole scenario: a single worst-step reading is dominated by whichever
  // step the GC happened to land on.
  for (const mode of ['tdm']) {
    const trials = [];
    for (let t = 0; t < 5; t++) trials.push(cluster(mode, KILLS));
    R.clusters[mode] = {
      trials,
      maxSpawnsInStep: Math.max(...trials.map((t) => t.maxSpawnsInStep)),
      msOfMaxSpawnStep: { min: min(trials.map((t) => t.msOfMaxSpawnStep)), median: med(trials.map((t) => t.msOfMaxSpawnStep)) },
      losOfMaxSpawnStep: { min: Math.min(...trials.map((t) => t.losOfMaxSpawnStep)), median: med(trials.map((t) => t.losOfMaxSpawnStep)) },
      worstFrameMs: { min: min(trials.map((t) => t.worstFrameMs)), median: med(trials.map((t) => t.worstFrameMs)) },
      worstFrameLos: med(trials.map((t) => t.worstFrameLos)),
      quietStepP99: med(trials.map((t) => t.quietStepMs.p99)),
      spawnSteps: trials[0].spawnSteps,
      spawnEntityMs: trials[0].spawnEntityMs,
    };
  }

  // ------------------------------------------------- controlled spawn determinism
  // auditI/auditJ already root-caused two PRE-EXISTING same-seed breakers that live
  // outside this file's scope (roster construction consumes the sim RNG on the first
  // match of a page; BotManager._spawnBot early-returns for a bot that ended the last
  // match alive). To test the spawn path itself rather than those, every entity is
  // normalised to a canonical live state before each start, and the first trial is
  // discarded so the roster is already built.
  {
    const canonical = () => {
      const ents = g.entities;
      for (let i = 0; i < ents.length; i++) {
        const e = ents[i];
        e.position.set(-20 + i * 1.7, 0, -10 + (i % 5) * 3);
        e.velocity?.set(0, 0, 0);
        e.yaw = 0; e.pitch = 0;
        e.alive = true;
        e.health = e.maxHealth ?? 100;
      }
    };
    const trial = (mode) => {
      canonical();
      g.startMatch({ mode, botCount: 12, difficulty: 'regular', seed: 777 });
      const s = g.entities.map((e) => `${e.name}|${e.position.x.toFixed(3)},${e.position.z.toFixed(3)}|${e.yaw.toFixed(3)}`).join(';');
      g.returnToMenu();
      return s;
    };
    R.spawnDeterminism = {};
    for (const mode of MODES) {
      trial(mode);                       // warm-up, discarded
      const a = trial(mode);
      const b = trial(mode);
      R.spawnDeterminism[mode] = a === b ? 'identical' : 'DIVERGED';
      if (a !== b) R.spawnDeterminism[mode + ':a'] = a.slice(0, 200);
    }
  }

  // --------------------------------------------------------------- determinism
  const snap = () => ({
    scores: [g.match.scores[0], g.match.scores[1]],
    elapsed: +g.match.elapsed.toFixed(4),
    player: [+g.player.position.x.toFixed(4), +g.player.position.y.toFixed(4),
      +g.player.position.z.toFixed(4), g.player.health],
    bots: g.bots.bots.map((b) => [
      b.name, b.team, b.alive ? 1 : 0, +b.health.toFixed(2),
      +b.position.x.toFixed(3), +b.position.y.toFixed(3), +b.position.z.toFixed(3),
      b.stats.kills, b.stats.deaths, b.stats.score,
    ].join('|')),
    book: [...g.match._book.values()].map((s) => `${s.name}:${s.kills}/${s.deaths}/${s.score}`).sort(),
  });
  const runOne = (mode, seed) => {
    g.startMatch({ mode, botCount: 12, difficulty: 'regular', seed });
    g.match.timeLimit = 100000;
    simFull(30);
    const s = snap();
    g.returnToMenu();
    return s;
  };
  for (const mode of MODES) {
    const A = JSON.stringify(runOne(mode, 4242));
    const B = JSON.stringify(runOne(mode, 4242));
    R.determinism[mode] = A === B ? 'identical' : 'DIVERGED';
    if (A !== B) {
      const a = JSON.parse(A); const b = JSON.parse(B);
      const d = [];
      if (JSON.stringify(a.scores) !== JSON.stringify(b.scores)) d.push(`scores ${a.scores} vs ${b.scores}`);
      if (JSON.stringify(a.player) !== JSON.stringify(b.player)) d.push(`player ${a.player} vs ${b.player}`);
      for (let i = 0; i < a.bots.length; i++) if (a.bots[i] !== b.bots[i]) d.push(`bot[${i}] ${a.bots[i]} vs ${b.bots[i]}`);
      R.determinism[mode + ':diffs'] = d.slice(0, 3);
    }
  }

  // ------------------------------------------------- cross-match state carry-over (D1)
  {
    g.startMatch({ mode: 'tdm', botCount: 4, difficulty: 'regular', seed: 3 });
    sim(4.2);
    const p = g.player;
    try {
      g.projectiles.throwGrenade(p,
        { x: p.position.x, y: p.position.y + 1.5, z: p.position.z }, { x: 0, y: 0.2, z: -1 }, 1);
    } catch (e) { R.notes.push('throwGrenade: ' + e.message); }
    const liveBefore = g.projectiles.pool.filter((x) => x.active).length;
    // ...and a smoke cloud, which must emit `smokeEnd` when the match is torn down or
    // the AI's vision-blocking state carries into the next match.
    let smokeBefore = 0;
    try {
      const defs = await import('/src/weapons/weaponDefs.js');
      g.projectiles.throwGrenade(p,
        { x: p.position.x, y: p.position.y + 1.5, z: p.position.z },
        { x: 0, y: 0.1, z: -1 }, 0.4, defs.WEAPONS.smoke);
      sim(3);                          // past the 1.6 s fuse, cloud is live
      smokeBefore = g.projectiles.smokeClouds.filter((c) => c.active).length;
    } catch (e) { R.notes.push('smoke: ' + e.message); }
    let smokeEnds = 0;
    const un = g.bus.on('smokeEnd', () => { smokeEnds++; });
    g.returnToMenu();
    g.startMatch({ mode: 'tdm', botCount: 4, difficulty: 'regular', seed: 3 });
    const liveAfter = g.projectiles.pool.filter((x) => x.active).length;
    const smokeAfter = g.projectiles.smokeClouds.filter((c) => c.active).length;
    un();
    R.carryOver = {
      liveGrenadesBeforeRestart: liveBefore, liveGrenadesAfterRestart: liveAfter,
      smokeCloudsBeforeRestart: smokeBefore, smokeCloudsAfterRestart: smokeAfter,
      smokeEndEventsOnRestart: smokeEnds,
    };
    g.returnToMenu();
  }

  // ------------------------------------------------- A10: sentry id / spawn protection
  {
    g.startMatch({ mode: 'tdm', botCount: 4, difficulty: 'regular', seed: 3 });
    const ks = g.match.killstreaks;
    R.sentryIds = ks._sentries.map((s) => s.id);
    R.chopperIds = ks._choppers.map((c) => c.id);
    R.playerId = g.player.id;
    R.idCollision = ks._sentries.some((s) => s.id === g.player.id);

    // Deploy a sentry for the player, force it to fire, and see whether the player's
    // spawn protection survives it.
    sim(4);
    g.match._protect.set(g.player.id, g.match.elapsed + 5);
    const before = g.match.isProtected(g.player);
    g.bus.emit('shot', {
      shooter: ks._sentries[0], weaponId: 'sentry',
      origin: g.player.position, dir: { x: 0, y: 0, z: -1 }, isPlayer: false,
    });
    R.protectionAfterUnownedSentryShot = g.match.isProtected(g.player);
    ks._sentries[0].ownerEntity = g.player;
    g.match._protect.set(g.player.id, g.match.elapsed + 5);
    g.bus.emit('shot', {
      shooter: ks._sentries[0], weaponId: 'sentry',
      origin: g.player.position, dir: { x: 0, y: 0, z: -1 }, isPlayer: false,
    });
    R.protectionAfterOwnSentryShot = g.match.isProtected(g.player);
    // ...and that the player firing their own gun still burns it.
    g.match._protect.set(g.player.id, g.match.elapsed + 5);
    g.bus.emit('shot', {
      shooter: g.player, weaponId: 'ar_vector',
      origin: g.player.position, dir: { x: 0, y: 0, z: -1 }, isPlayer: true,
    });
    R.protectionAfterOwnShot = g.match.isProtected(g.player);
    R.protectBefore = before;
    g.returnToMenu();
  }

  return R;
}, { BOTS, RUNS, KILLS });

report(`SPIKE PROBE — ${LABEL} (bots=${BOTS}, runs=${RUNS}, kills=${KILLS})`, out);

console.log(`\none losClear march: ${out.losMarchUs.min} us (min) / ${out.losMarchUs.median} us (median)`);
console.log('\n--- A2: match start ---');
for (const [mode, s] of Object.entries(out.starts)) {
  console.log(`  ${mode.padEnd(14)} begin ${String(s.beginMs.min).padStart(6)} / ${String(s.beginMs.median).padStart(6)} ms (min/median)  of which spawnEntity ${String(s.spawnEntityMs.min).padStart(6)} / ${String(s.spawnEntityMs.median).padStart(6)} ms  startMatch ${String(s.startMatchMs.min).padStart(6)} / ${String(s.startMatchMs.median).padStart(6)} ms`);
  console.log(`                 ${s.beginSpawns} spawns, ${s.pointsScored} candidate points scored, losClear ${JSON.stringify(s.beginLos)}, world rays ${JSON.stringify(s.beginRays)}`);
}
console.log('\n--- A2: isolated pickSpawn, full live lobby ---');
for (const [mode, p] of Object.entries(out.pick)) {
  console.log(`  ${mode.padEnd(6)} ${p.aliveBots} bots alive -> ${p.msPerPick.min} / ${p.msPerPick.median} ms per pick (min/median), ${p.losPerPick} losClear per pick, ${p.pointsScoredPerPick} points scored per pick`);
}
console.log('\n--- A3: clustered respawn (5 trials each) ---');
for (const [mode, c] of Object.entries(out.clusters)) {
  console.log(`  ${mode.padEnd(6)} ${KILLS} bots die on one step`);
  console.log(`         max spawns landing on ONE fixed step: ${c.maxSpawnsInStep}`);
  console.log(`         that step: ${c.msOfMaxSpawnStep.min} / ${c.msOfMaxSpawnStep.median} ms (min/median), ${c.losOfMaxSpawnStep.min} / ${c.losOfMaxSpawnStep.median} losClear`);
  console.log(`         worst 6-step frame: ${c.worstFrameMs.min} / ${c.worstFrameMs.median} ms, ${c.worstFrameLos} losClear`);
  console.log(`         noise floor (steps with no spawn): p99 ${c.quietStepP99} ms  |  spawnEntity ${JSON.stringify(c.spawnEntityMs)}`);
  console.log(`         spawn steps (trial 1): ${c.spawnSteps.join(' ')}`);
}
console.log('\n--- controlled spawn determinism (normalised entity state, warm roster) ---');
for (const [k, v] of Object.entries(out.spawnDeterminism)) console.log(`  ${k.padEnd(22)} ${JSON.stringify(v)}`);
console.log('\n--- full-match determinism (same seed, two runs) ---');
for (const [k, v] of Object.entries(out.determinism)) console.log(`  ${k.padEnd(22)} ${JSON.stringify(v)}`);
console.log('\n--- reset wiring / carry-over / sentry ids ---');
console.log('  ' + JSON.stringify(out.resetCalls));
console.log('  ' + JSON.stringify(out.carryOver));
console.log(`  playerId=${out.playerId} sentryIds=${JSON.stringify(out.sentryIds)} chopperIds=${JSON.stringify(out.chopperIds)} collision=${out.idCollision}`);
console.log(`  protection: start=${out.protectBefore} afterUnownedSentryShot=${out.protectionAfterUnownedSentryShot} afterOwnSentryShot=${out.protectionAfterOwnSentryShot} afterOwnShot=${out.protectionAfterOwnShot}`);
if (out.notes?.length) console.log('  notes: ' + out.notes.join(' | '));
if (errors.length) console.log('\npage errors:\n  ' + [...new Set(errors)].slice(0, 10).join('\n  '));
if (consoleErrors.length) console.log('\nconsole errors:\n  ' + [...new Set(consoleErrors)].slice(0, 10).join('\n  '));

fs.mkdirSync(path.join(ROOT, 'shots'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'shots', `spikeprobe.${LABEL}.json`), JSON.stringify(out, null, 1));
console.log(`\nwrote shots/spikeprobe.${LABEL}.json`);

await close();
