import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatClock,
  isBombMatch,
  measuredRttMs,
  projectScoreboardHeader,
  projectScoreboardRow,
  scoreboardBindingLabel,
  scoreboardRoundHistory,
} from './scoreboard.js';

const rows = [
  { id: 1, name: 'Ace', isPlayer: true, team: 0, alive: true, kills: 8, deaths: 2,
    assists: 3, kd: 4, accuracy: 0.5, score: 900, bestStreak: 4, plants: 2, defuses: 0 },
  { id: 2, name: 'Bolt', team: 1, alive: false, kills: 4, deaths: 6,
    assists: 1, kd: 2 / 3, accuracy: 0.25, score: 500, bestStreak: 2, plants: 0, defuses: 1 },
];

test('TDM projection keeps kill-limit, match clock, score and combat columns', () => {
  const match = {
    modeId: 'tdm', modeName: 'TEAM DEATHMATCH', mode: { id: 'tdm', hudLabels: { objective: 'ELIMINATE HOSTILES' } },
    timeRemaining: 119.1, killLimit: 75, scores: [23, 19], teamNames: ['Alpha', 'Bravo'],
  };
  const header = projectScoreboardHeader(match, rows, 999);
  assert.equal(header.bomb, false);
  assert.equal(header.objective, 'ELIMINATE HOSTILES · FIRST TO 75');
  assert.equal(header.clock, '2:00');
  assert.deepEqual(header.scores, ['23', '19']);
  assert.deepEqual(header.teamLabels, ['ALPHA', 'BRAVO']);
  assert.equal(header.history, '');

  const row = projectScoreboardRow(rows[0]);
  assert.deepEqual(
    { kd: row.kd, accuracy: row.accuracy, streak: row.bestStreak, ping: row.rttMs },
    { kd: '4.00', accuracy: '50%', streak: '4', ping: '—' },
  );
});

test('Bomb projection uses round score, phase clock, planted objective, roles and alive counts', () => {
  const rounds = [
    { round: 1, winnerTeam: 0, reason: 'elimination' },
    { round: 2, winnerTeam: 1, reason: 'defuse' },
  ];
  const match = {
    modeId: 'bomb', modeName: 'BOMB',
    mode: { id: 'bomb', hudLabels: { objective: 'PLANT THE BOMB — OR STOP IT' }, hudTime: () => 31.2 },
    timeRemaining: 999, scores: [99, 99], teamNames: ['Alpha', 'Bravo'], attackingTeam: 1,
    roundNumber: 7, roundPhase: 'planted', bomb: { state: 'planted', siteId: 'B' },
    aliveCounts: { alpha: 2, bravo: 4 }, bombRules: { rounds, roundWins: [4, 2] },
  };
  assert.equal(isBombMatch(match), true);
  const header = projectScoreboardHeader(match, rows, 888);
  assert.equal(header.clock, '0:32', 'Bomb uses phase time rather than match.timeRemaining/external time');
  assert.equal(header.objective, 'ROUND 7 · BOMB PLANTED · SITE B');
  assert.deepEqual(header.scores, ['4', '2']);
  assert.deepEqual(header.teamLabels, ['ALPHA · DEFENDERS', 'BRAVO · ATTACKERS']);
  assert.equal(header.alive, 'ALPHA 2 ALIVE · BRAVO 4 ALIVE');
  assert.equal(header.history, 'R1 A ELIM · R2 B DEFUSE');
  assert.equal(scoreboardRoundHistory(match), header.history);

  const row = projectScoreboardRow(rows[0], { bomb: true });
  assert.deepEqual(
    { plants: row.plants, defuses: row.defuses, status: row.status },
    { plants: '2', defuses: '0', status: 'ALIVE' },
  );
});

test('latency is measured with facade metadata or remains null', () => {
  assert.equal(measuredRttMs({ rttMs: 42 }), null, 'a bare plausible number is rejected');
  assert.equal(measuredRttMs({ rttMs: 42.4, sampledAt: 1000, windowMs: 5000, snapshotAgeMs: 25 }), 42);

  const noMeasurement = projectScoreboardRow({ ...rows[0], rttMs: 17 }, { bomb: true });
  assert.equal(noMeasurement.rttMs, '—', 'legacy/synthetic row ping is ignored');

  const measured = projectScoreboardRow(rows[0], {
    bomb: true,
    netView: {
      state: 'reconnecting',
      netStats: { rttMs: 42.4, sampledAt: 1000, windowMs: 5000, snapshotAgeMs: 25 },
    },
  });
  assert.equal(measured.rttMs, '42');
  assert.equal(measured.status, 'RECONNECTING');
});

test('incomplete authoritative rows fail closed instead of fabricating zeroes or death', () => {
  const projected = projectScoreboardRow({ name: 'Unknown', team: 0 }, { bomb: true });
  assert.deepEqual({
    kills: projected.kills,
    kd: projected.kd,
    accuracy: projected.accuracy,
    plants: projected.plants,
    status: projected.status,
    ping: projected.rttMs,
  }, { kills: '—', kd: '—', accuracy: '—', plants: '—', status: 'UNKNOWN', ping: '—' });

  const header = projectScoreboardHeader({ modeId: 'bomb', scores: [0, 0] }, [{ team: 0 }]);
  assert.equal(header.alive, 'ALPHA — ALIVE · BRAVO 0 ALIVE');
});

test('scoreboard hint follows current bindings and fails closed when unbound', () => {
  assert.equal(scoreboardBindingLabel({ get: () => ({ KeyM: 'scoreboard' }) }), 'M');
  assert.equal(scoreboardBindingLabel({ getSnapshot: () => ({
    bindings: { scoreboard: { primary: 'KeyM', secondary: 'Mouse4' } },
  }) }), 'M / MOUSE 4');
  assert.equal(scoreboardBindingLabel({ get: () => ({ Tab: 'chat' }) }), 'UNBOUND');
  assert.equal(scoreboardBindingLabel(null), 'UNBOUND');
  assert.equal(formatClock(0), '0:00');
});
