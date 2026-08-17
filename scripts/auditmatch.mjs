/**
 * AUDIT PROBE 2 — match lifecycle, mode coverage and cross-match state.
 *
 * A) Every mode (tdm, ffa, gungame, domination, killconfirmed) is started with a
 *    temporarily lowered score limit and simulated until it ends. We assert the
 *    phase progression idle -> countdown -> live -> ended, a well-formed result,
 *    and that game.state becomes 'gameover'.
 * B) Two identical matches (same seed) are run back to back through
 *    startMatch -> returnToMenu -> startMatch and the resulting world state is
 *    compared. Any divergence is state leaking across matches.
 * C) A fresh match is inspected the instant it starts, before any simulation, to
 *    verify every counter really was reset.
 * D) startMatch({ botCount }) is checked against the roster it actually produces.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5212, strictPort: false }, logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 180000, polling: 200 });

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  const R = { checks: [], modes: [], notes: [] };
  const ok = (name, cond, detail) => R.checks.push({ name, pass: !!cond, detail: String(detail) });

  const step = () => { g.time += 1 / 120; g.frame++; g._fixedUpdate(1 / 120); g._update(1 / 120); };
  const sim = (sec) => { const n = Math.round(sec * 120); for (let i = 0; i < n; i++) step(); };

  // ---------------------------------------------------------------- A) modes
  const MODE_SETUP = {
    tdm: { scoreLimit: 6 },
    ffa: { scoreLimit: 3 },
    gungame: { scoreLimit: null },   // derived from the ladder; leave alone
    domination: { scoreLimit: 25 },
    killconfirmed: { scoreLimit: 6 },
  };

  for (const id of Object.keys(MODE_SETUP)) {
    const rec = { id };
    try {
      g.startMatch({ mode: id, difficulty: 'regular', seed: 99 });
      rec.modeIdResolved = g.match.modeId;
      rec.phaseAtStart = g.match.phase;
      rec.teamBased = !!g.match.mode.teamBased;
      rec.botCount = g.bots.bots.length;
      rec.teams = g.bots.bots.map((b) => b.team).join(',');

      const origLimit = g.match.mode.scoreLimit;
      if (MODE_SETUP[id].scoreLimit != null) g.match.mode.scoreLimit = MODE_SETUP[id].scoreLimit;
      g.match.timeLimit = 100000;   // force the score path, not the clock

      sim(4);
      rec.phaseAfterCountdown = g.match.phase;

      let elapsed = 0;
      const LIMIT = 480;            // 8 simulated minutes
      while (g.match.phase !== 'ended' && elapsed < LIMIT) { sim(2); elapsed += 2; }
      rec.simSecondsToEnd = elapsed;
      rec.phaseAtEnd = g.match.phase;
      rec.gameState = g.state;
      rec.scores = [g.match.scores[0], g.match.scores[1]];
      rec.result = g.match.result ? {
        reason: g.match.result.reason,
        winner: g.match.result.winner,
        winnerName: g.match.result.winnerName,
        outcome: g.match.result.outcome,
        rows: g.match.result.rows?.length ?? 0,
        duration: +(g.match.result.duration ?? 0).toFixed(1),
      } : null;
      rec.totalKills = [...g.match._book.values()].reduce((a, s) => a + s.kills, 0);

      g.match.mode.scoreLimit = origLimit;

      ok(`${id}:reachesLive`, rec.phaseAfterCountdown === 'live', `phase=${rec.phaseAfterCountdown}`);
      ok(`${id}:reachesWinCondition`, rec.phaseAtEnd === 'ended', `phase=${rec.phaseAtEnd} after ${elapsed}s sim`);
      ok(`${id}:gameoverState`, rec.gameState === 'gameover', `state=${rec.gameState}`);
      ok(`${id}:resultWellFormed`, !!rec.result && rec.result.rows > 0, JSON.stringify(rec.result));
      ok(`${id}:scoringHappened`, rec.totalKills > 0 || rec.scores[0] + rec.scores[1] > 0,
        `kills=${rec.totalKills} scores=${rec.scores}`);
    } catch (e) {
      rec.error = String(e && e.stack || e);
      ok(`${id}:noThrow`, false, rec.error.slice(0, 300));
    }
    R.modes.push(rec);
    g.returnToMenu();
  }

  // -------------------------------------------------- C) reset cleanliness
  // Play a messy match first so there is plenty of state to fail to clear.
  g.startMatch({ mode: 'tdm', difficulty: 'hardened', seed: 7 });
  g.match.timeLimit = 100000;
  sim(90);
  const dirty = {
    scores: [g.match.scores[0], g.match.scores[1]],
    kills: [...g.match._book.values()].reduce((a, s) => a + s.kills, 0),
    decals: g.fx.decals.count ?? g.fx.decals._count ?? -1,
    particles: Object.values(g.fx.particles.groups || {}).reduce((a, x) => a + (x.count || 0), 0),
    tracers: g.fx.tracers.batch?.count ?? g.fx.tracers.count ?? -1,
    respawns: g.match._respawns.length,
    moments: g.match._moments.length,
    deathGuard: g.match._deathGuard.size,
    damageLog: g.match._damageLog.size,
    protect: g.match._protect.size,
    ksInventory: g.match.killstreaks.inventory?.length ?? -1,
    playerWeapons: g.match._playerWeapons.size,
    spawnerDeaths: g.match.spawner._deaths?.length ?? g.match.spawner._deaths?.size ?? -1,
    projectiles: g.projectiles.active?.length ?? g.projectiles.count ?? -1,
  };
  R.dirty = dirty;

  g.returnToMenu();
  g.startMatch({ mode: 'tdm', difficulty: 'hardened', seed: 7 });
  const clean = {
    scores: [g.match.scores[0], g.match.scores[1]],
    kills: [...g.match._book.values()].reduce((a, s) => a + s.kills, 0),
    deaths: [...g.match._book.values()].reduce((a, s) => a + s.deaths, 0),
    decals: g.fx.decals.count ?? g.fx.decals._count ?? -1,
    particles: Object.values(g.fx.particles.groups || {}).reduce((a, x) => a + (x.count || 0), 0),
    tracers: g.fx.tracers.batch?.count ?? g.fx.tracers.count ?? -1,
    respawns: g.match._respawns.length,
    moments: g.match._moments.length,
    deathGuard: g.match._deathGuard.size,
    damageLog: g.match._damageLog.size,
    ksInventory: g.match.killstreaks.inventory?.length ?? -1,
    playerWeapons: g.match._playerWeapons.size,
    spawnerDeaths: g.match.spawner._deaths?.length ?? g.match.spawner._deaths?.size ?? -1,
    projectiles: g.projectiles.active?.length ?? g.projectiles.count ?? -1,
    elapsed: g.match.elapsed,
    playerHealth: g.player.health,
    playerAlive: g.player.alive,
    playerStats: { ...g.player.stats },
    botStatsSum: g.bots.bots.reduce((a, b) => a + b.stats.kills + b.stats.deaths + b.stats.score, 0),
    botsAlive: g.bots.bots.filter((b) => b.alive).length,
    botsTotal: g.bots.bots.length,
    ammoFull: g.player.weapon ? g.player.weapon.ammo === g.player.weapon.def.magSize : null,
    reserveFull: g.player.weapon ? g.player.weapon.reserve === g.player.weapon.def.reserve : null,
  };
  R.clean = clean;

  ok('reset:scoresZero', clean.scores[0] === 0 && clean.scores[1] === 0, JSON.stringify(clean.scores));
  ok('reset:statsZero', clean.kills === 0 && clean.deaths === 0, `k=${clean.kills} d=${clean.deaths}`);
  ok('reset:decalsCleared', clean.decals === 0, `${dirty.decals} -> ${clean.decals}`);
  ok('reset:particlesCleared', clean.particles === 0, `${dirty.particles} -> ${clean.particles}`);
  ok('reset:tracersCleared', clean.tracers === 0, `${dirty.tracers} -> ${clean.tracers}`);
  ok('reset:respawnQueueEmpty', clean.respawns === 0, `${clean.respawns}`);
  ok('reset:momentsCleared', clean.moments === 0, `${dirty.moments} -> ${clean.moments}`);
  ok('reset:deathGuardCleared', clean.deathGuard === 0, `${dirty.deathGuard} -> ${clean.deathGuard}`);
  ok('reset:killstreakInvEmpty', clean.ksInventory === 0, `${dirty.ksInventory} -> ${clean.ksInventory}`);
  ok('reset:weaponRowsCleared', clean.playerWeapons === 0, `${dirty.playerWeapons} -> ${clean.playerWeapons}`);
  ok('reset:spawnerDeathsCleared', clean.spawnerDeaths === 0, `${dirty.spawnerDeaths} -> ${clean.spawnerDeaths}`);
  ok('reset:projectilesCleared', clean.projectiles === 0, `${dirty.projectiles} -> ${clean.projectiles}`);
  ok('reset:playerFullHealth', clean.playerHealth === g.player.maxHealth && clean.playerAlive, JSON.stringify(clean));
  ok('reset:botStatsZero', clean.botStatsSum === 0, `${clean.botStatsSum}`);
  ok('reset:allBotsAlive', clean.botsAlive === clean.botsTotal, `${clean.botsAlive}/${clean.botsTotal}`);
  ok('reset:ammoFull', clean.ammoFull !== false, `ammo full=${clean.ammoFull} reserve full=${clean.reserveFull}`);
  g.returnToMenu();

  // ------------------------------------------------- B) two identical matches
  const snap = () => ({
    scores: [g.match.scores[0], g.match.scores[1]],
    elapsed: +g.match.elapsed.toFixed(4),
    player: [+g.player.position.x.toFixed(4), +g.player.position.y.toFixed(4), +g.player.position.z.toFixed(4), g.player.health],
    bots: g.bots.bots.map((b) => [
      b.name, b.team, b.alive ? 1 : 0, +b.health.toFixed(2),
      +b.position.x.toFixed(3), +b.position.y.toFixed(3), +b.position.z.toFixed(3),
      b.stats.kills, b.stats.deaths, b.stats.score,
    ].join('|')),
    book: [...g.match._book.values()].map((s) => `${s.name}:${s.kills}/${s.deaths}/${s.score}`).sort(),
  });

  const runOne = (seed) => {
    g.startMatch({ mode: 'tdm', difficulty: 'regular', seed });
    g.match.timeLimit = 100000;
    sim(60);
    const s = snap();
    g.returnToMenu();
    return s;
  };
  const A = runOne(4242);
  const B = runOne(4242);
  R.runA = A; R.runB = B;
  const same = JSON.stringify(A) === JSON.stringify(B);
  const diffs = [];
  if (!same) {
    if (JSON.stringify(A.scores) !== JSON.stringify(B.scores)) diffs.push(`scores ${A.scores} vs ${B.scores}`);
    if (JSON.stringify(A.player) !== JSON.stringify(B.player)) diffs.push(`player ${A.player} vs ${B.player}`);
    for (let i = 0; i < Math.max(A.bots.length, B.bots.length); i++) {
      if (A.bots[i] !== B.bots[i]) diffs.push(`bot[${i}] ${A.bots[i]} vs ${B.bots[i]}`);
    }
    if (JSON.stringify(A.book) !== JSON.stringify(B.book)) diffs.push(`book ${JSON.stringify(A.book)} vs ${JSON.stringify(B.book)}`);
  }
  R.determinismDiffs = diffs.slice(0, 12);
  ok('sameSeedSameMatch', same, diffs.slice(0, 4).join(' ; ') || 'identical');

  // -------------------------------------------------------- D) botCount option
  for (const n of [0, 3, 12, 24]) {
    g.startMatch({ mode: 'tdm', botCount: n, difficulty: 'regular', seed: 5 });
    const got = g.bots.bots.length;
    ok(`botCount:${n}`, got === n, `asked ${n}, got ${got}`);
    if (n === 0) {
      // Zero bots must not crash and must not hang the match forever.
      let threw = null;
      try { sim(20); } catch (e) { threw = String(e && e.message || e); }
      ok('botCount:0 simulates', !threw, threw || 'ok');
      R.zeroBotPhase = g.match.phase;
      R.zeroBotScores = [g.match.scores[0], g.match.scores[1]];
    }
    g.returnToMenu();
  }

  // Settings-driven path (which is what the menu uses).
  for (const n of [0, 24]) {
    g.settings.set('botCount', n);
    g.startMatch({ mode: 'tdm', difficulty: 'regular', seed: 5 });
    ok(`settingsBotCount:${n}`, g.bots.bots.length === n, `got ${g.bots.bots.length}`);
    if (n === 24) {
      let threw = null;
      try { sim(20); } catch (e) { threw = String(e && e.message || e); }
      ok('24 bots simulate', !threw, threw || 'ok');
      const t0 = performance.now();
      sim(2);
      R.msPerStep24 = +((performance.now() - t0) / 240).toFixed(4);
    }
    g.returnToMenu();
  }
  g.settings.set('botCount', 7);

  return R;
});

console.log('\n=============== MATCH LIFECYCLE AUDIT ===============');
for (const c of out.checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(30)} ${c.detail}`);
console.log('\n--- per-mode ---');
for (const m of out.modes) console.log('  ' + JSON.stringify(m));
console.log('\n--- state after a dirty match ---\n  ' + JSON.stringify(out.dirty));
console.log('--- state at the start of the next match ---\n  ' + JSON.stringify(out.clean));
if (out.determinismDiffs?.length) {
  console.log('\n--- same-seed divergence ---');
  for (const d of out.determinismDiffs) console.log('  ' + d);
}
console.log(`\nzeroBots: phase=${out.zeroBotPhase} scores=${out.zeroBotScores}  |  24-bot sim cost ${out.msPerStep24} ms/step`);
if (logs.length) { console.log('\nconsole errors:'); for (const l of [...new Set(logs)].slice(0, 25)) console.log('  ' + l); }
const pass = out.checks.filter((c) => c.pass).length;
console.log(`\n${pass}/${out.checks.length} checks passed`);
console.log('=====================================================\n');
fs.writeFileSync(path.join(ROOT, 'shots', 'auditmatch.json'), JSON.stringify(out, null, 1));

await browser.close();
await server.close();
