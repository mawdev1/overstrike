/**
 * AUDIT B — every mode runs, every mode ends, and state resets between matches.
 *
 * For each of tdm / ffa / gungame / domination / killconfirmed:
 *   1. start it, let it play naturally for 45 simulated seconds and record whether the
 *      mode's own machinery actually moved (team score, kills, tiers, zones, tags),
 *   2. force it to its SCORE win condition and assert `matchEnd` fires with a sane result,
 *   3. force it to its CLOCK win condition and assert the same.
 * Then: menu -> start -> menu -> start repeatedly and diff the "clean state" snapshot.
 */
import { boot, report } from './auditlib.mjs';

const h = await boot({ port: 5302, viewport: { width: 640, height: 480 } });
const { page } = h;

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  const R = { modes: {}, resets: [], checks: [] };
  const ok = (name, cond, detail) => R.checks.push({ name, pass: !!cond, detail: String(detail) });
  const sim = (n) => { for (let i = 0; i < n; i++) g._fixedUpdate(1 / 120); };

  const MODES = ['tdm', 'ffa', 'gungame', 'domination', 'killconfirmed'];

  /** A snapshot of everything that MUST be clean at the start of a match. */
  const cleanSnapshot = () => {
    const m = g.match;
    return {
      phase: m.phase,
      scores: [m.scores[0], m.scores[1]],
      elapsed: +m.elapsed.toFixed(3),
      book: m._book.size,
      bookKills: [...m._book.values()].reduce((a, s) => a + s.kills, 0),
      bookDeaths: [...m._book.values()].reduce((a, s) => a + s.deaths, 0),
      bookScore: [...m._book.values()].reduce((a, s) => a + s.score, 0),
      damageLog: m._damageLog.size,
      respawns: m._respawns.length,
      moments: m._moments.length,
      deathGuard: m._deathGuard.size,
      playerWeapons: m._playerWeapons.size,
      firstBlood: m._firstBlood,
      gameTime: +g.time.toFixed(3),
      playerKills: g.player.stats.kills,
      playerDeaths: g.player.stats.deaths,
      playerStreak: g.player.stats.streak,
      playerScore: g.player.stats.score,
      playerHealth: g.player.health,
      playerAlive: g.player.alive,
      botCount: g.bots.bots.length,
      botsAlive: g.bots.bots.filter((b) => b.alive).length,
      botKills: g.bots.bots.reduce((a, b) => a + b.stats.kills, 0),
      botHealth: g.bots.bots.reduce((a, b) => a + b.health, 0),
      decalsActive: g.fx?.decals?.active ?? g.fx?.decals?._active ?? null,
      activeStreaks: g.match.killstreaks?._active?.length ?? null,
      sceneChildren: g.scene.children.length,
      hudKillfeedRows: document.querySelectorAll('#hud .kf-row, #hud .killfeed-row').length,
    };
  };

  const enemiesOf = (e) => g.bots.bots.filter((b) => b.alive && g.match.areEnemies(e, b));

  // ------------------------------------------------------------- per-mode runs
  for (const mode of MODES) {
    const rec = { mode };
    let endPayload = null;
    const offEnd = g.bus.on('matchEnd', (p) => { endPayload = p; });

    // ---- 1. natural play
    g.startMatch({ mode, botCount: 7, difficulty: 'regular', seed: 4242 });
    rec.modeIdResolved = g.match.modeId;
    rec.teamBased = g.match.mode.teamBased;
    rec.botTeams = g.bots.bots.map((b) => b.team).join(',');
    sim(600); // countdown
    rec.phaseAfterCountdown = g.match.phase;

    const beforeScores = [g.match.scores[0], g.match.scores[1]];
    let kills = 0;
    const offKill = g.bus.on('kill', () => kills++);
    for (let i = 0; i < 120 * 45; i++) g._fixedUpdate(1 / 120);
    offKill();
    rec.naturalKills = kills;
    rec.scoresAfter45s = [g.match.scores[0], g.match.scores[1]];
    rec.scoreMoved = g.match.scores[0] !== beforeScores[0] || g.match.scores[1] !== beforeScores[1];
    rec.stillPlaying = g.state === 'playing';
    rec.modeStateKeys = Object.keys(g.match.modeState);
    if (mode === 'gungame') {
      rec.ladderLen = g.match.modeState.ladder?.length ?? 0;
      rec.tiers = [...(g.match.modeState.tiers?.values() ?? [])];
      rec.maxTier = Math.max(0, ...rec.tiers);
    }
    if (mode === 'domination') {
      rec.zones = (g.match.modeState.zones || []).map((z) => ({ l: z.letter, owner: z.owner, prog: +z.progress.toFixed(2) }));
    }
    if (mode === 'killconfirmed') {
      rec.tagsActive = (g.match.modeState.tags || []).filter((t) => t.active).length;
      rec.confirms = [...g.match._book.values()].reduce((a, s) => a + (s.confirms || 0), 0);
    }

    // ---- 2. force the SCORE win condition
    // Drive kills directly through the canonical death path until the mode ends.
    let guard = 0;
    while (g.match.phase === 'live' && guard < 400) {
      guard++;
      const foes = enemiesOf(g.player);
      const victim = foes[0];
      if (victim) {
        victim.die({ attacker: g.player, weaponId: 'ar_vector', point: victim.position.clone() });
      } else {
        // Nobody to kill (all dead, respawn pending) — let the sim breathe.
        sim(60);
      }
      sim(12);
      if (mode === 'domination' || mode === 'killconfirmed') {
        // These modes do not end on kills; push their own objective instead.
        if (mode === 'domination') {
          const zs = g.match.modeState.zones || [];
          for (const z of zs) { z.owner = 0; }
          sim(360);
        } else {
          // Walk the player over every live tag.
          for (const t of (g.match.modeState.tags || [])) {
            if (!t.active) continue;
            g.player.position.set(t.position.x, t.position.y - 0.4, t.position.z);
            sim(2);
          }
          sim(30);
        }
      }
    }
    rec.forcedScoreIterations = guard;
    rec.endedOnScore = g.match.phase === 'ended';
    rec.stateAfterScoreEnd = g.state;
    rec.scoreEndResult = g.match.result ? {
      reason: g.match.result.reason,
      winner: g.match.result.winner,
      winnerTeam: g.match.result.winnerTeam,
      winnerName: g.match.result.winnerName,
      outcome: g.match.result.outcome,
      rows: g.match.result.rows?.length ?? 0,
      hasProgression: !!g.match.result.progression,
      scores: g.match.result.scores,
    } : null;
    rec.matchEndEventFired = !!endPayload;
    rec.matchEndPayloadKeys = endPayload ? Object.keys(endPayload).sort() : null;

    // Simulate past the end — nothing should keep ticking or throw.
    const elapsedAtEnd = g.match.elapsed;
    sim(600);
    rec.elapsedFrozenAfterEnd = g.match.elapsed === elapsedAtEnd;

    // ---- 3. force the CLOCK win condition
    endPayload = null;
    g.startMatch({ mode, botCount: 7, difficulty: 'regular', seed: 99 });
    sim(600);
    g.match.timeLimit = g.match.elapsed + 5;
    sim(120 * 8);
    rec.endedOnClock = g.match.phase === 'ended';
    rec.clockEndReason = g.match.result?.reason ?? null;
    rec.clockEndOutcome = g.match.result?.outcome ?? null;
    rec.clockMatchEndFired = !!endPayload;

    offEnd();
    R.modes[mode] = rec;

    ok(`${mode}:runs`, rec.phaseAfterCountdown === 'live', `phase=${rec.phaseAfterCountdown}`);
    ok(`${mode}:endsOnScore`, rec.endedOnScore, `after ${rec.forcedScoreIterations} forced kills, phase=${g.match.phase}`);
    ok(`${mode}:endsOnClock`, rec.endedOnClock, `reason=${rec.clockEndReason}`);
    ok(`${mode}:matchEndEvent`, rec.matchEndEventFired, `payload=${rec.matchEndPayloadKeys}`);
    ok(`${mode}:frozenAfterEnd`, rec.elapsedFrozenAfterEnd, 'match.elapsed stops advancing');

    g.returnToMenu();
  }

  // -------------------------------------------------- repeated restart cleanliness
  for (let i = 0; i < 5; i++) {
    g.startMatch({ mode: i % 2 ? 'ffa' : 'tdm', botCount: 7, difficulty: 'regular', seed: 7 });
    const atStart = cleanSnapshot();
    sim(600 + 120 * 20);
    // Kill a few things so there is state to clean up.
    for (const b of g.bots.bots.slice(0, 3)) if (b.alive) b.die({ attacker: g.player, weaponId: 'ar_vector' });
    sim(120 * 5);
    const dirty = cleanSnapshot();
    g.returnToMenu();
    R.resets.push({ i, atStart, dirty });
  }

  // ---------------------------------- match 1 vs match 2, identical seed & script
  const scripted = (seed) => {
    g.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'veteran', seed });
    let shots = 0;
    const off = g.bus.on('shot', () => shots++);
    for (let i = 0; i < 120 * 40; i++) g._fixedUpdate(1 / 120);
    off();
    const digest = {
      shots,
      scores: [g.match.scores[0], g.match.scores[1]],
      kills: [...g.match._book.values()].reduce((a, s) => a + s.kills, 0),
      deaths: [...g.match._book.values()].reduce((a, s) => a + s.deaths, 0),
      botNames: g.bots.bots.map((b) => b.name).join(','),
      botTeams: g.bots.bots.map((b) => b.team).join(','),
      botPositions: g.bots.bots.map((b) => `${b.position.x.toFixed(2)},${b.position.z.toFixed(2)}`).join('|'),
      playerHealth: g.player.health,
      elapsed: +g.match.elapsed.toFixed(3),
    };
    g.returnToMenu();
    return digest;
  };
  const d1 = scripted(31337);
  const d2 = scripted(31337);
  R.determinism = { d1, d2, identical: JSON.stringify(d1) === JSON.stringify(d2) };
  ok('sameSeedSameMatch', R.determinism.identical,
    R.determinism.identical ? 'match 2 reproduced match 1 exactly'
      : `diverged: ${Object.keys(d1).filter((k) => JSON.stringify(d1[k]) !== JSON.stringify(d2[k])).join(',')}`);

  return R;
});

console.log('\n=========== AUDIT B — MODES ===========');
for (const [mode, r] of Object.entries(out.modes)) {
  console.log(`\n--- ${mode} ---`);
  console.log(JSON.stringify(r, null, 1));
}

console.log('\n=========== RESTART CLEANLINESS ===========');
const base = out.resets[0].atStart;
for (const r of out.resets) {
  const diff = {};
  for (const k of Object.keys(base)) {
    if (JSON.stringify(r.atStart[k]) !== JSON.stringify(base[k])) diff[k] = `${JSON.stringify(base[k])} -> ${JSON.stringify(r.atStart[k])}`;
  }
  console.log(`restart ${r.i}: ${Object.keys(diff).length ? JSON.stringify(diff) : 'identical to first start'}`);
}
console.log('\nfull first-start snapshot:', JSON.stringify(base, null, 1));
console.log('\nend-of-match-0 dirty snapshot:', JSON.stringify(out.resets[0].dirty, null, 1));

console.log('\n=========== DETERMINISM ===========');
console.log(JSON.stringify(out.determinism, null, 1));

console.log('\n=========== CHECKS ===========');
let fails = 0;
for (const c of out.checks) { if (!c.pass) fails++; console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`); }
console.log(`  ${out.checks.length - fails}/${out.checks.length} passed`);

if (h.errors.length) console.log('\npage errors:', [...new Set(h.errors)].slice(0, 12));
if (h.consoleErrors.length) console.log('\nconsole errors:', [...new Set(h.consoleErrors)].slice(0, 12));

await h.close();
