/**
 * H3.3 — autonomous full Bomb match on The Square.
 *
 * Unlike bombtest's boundary fixtures, this harness never writes an actor position or
 * objective state. Eleven real Bot instances choose routes, traverse the baked nav graph,
 * fight, recover dropped bombs, plant, defend, retake and defuse through the same intent
 * API used by a client. BombRules remains the only writer of objective truth.
 */
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';
import { FIXED_DT } from '../src/core/mathUtils.js';
import { BOMB_PARAMS } from '../src/game/bomb.js';
import { GameServer, ObjectiveEvidence } from '../src/net/server.js';
import { buildCanonicalTerminalResult, evidenceDigest, reconstructEvidenceResult } from '../server/result.js';
import { expireUnjoinedSeats } from '../server/tickets.js';
import { submittableResultProblems } from '../platform/src/core/store.js';
import { ulid } from '../platform/src/core/ids.js';

let checks = 0;
const failures = [];
const check = (condition, message, detail = '') => {
  checks++;
  if (!condition) failures.push(`${message}${detail ? ` — ${detail}` : ''}`);
};

// Repinned for the 2.0.0 symmetric ruleset (the old attacker/defender baseline is void):
// this seed's series plants at BOTH authored sites, by BOTH teams, on both sides of the
// side switch, and contains defuses — the full owner-directive surface in one series.
const SEED = 20260822;
const MAX_TICKS = 120 * 60 * 35;
// bomb-rules §13.11: contest (race the neutral/dropped bomb), carry/escort (deliver to the
// one legal target), defend (home site), retake/defusing (own site planted), postplant hold.
const REQUIRED_ROLES = Object.freeze([
  'contest', 'carry', 'planting', 'escort', 'defend', 'retake', 'defusing', 'postplant',
]);

const game = new Game({ headless: true });
await game.initHeadless({ presenter: new NullPresenter() });
const authority = new GameServer(game);
const matchId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
authority.evidence.identify({ matchId, rulesetVersion: 'bomb-1.0.0', serverBuild: '1.0.0' });
game.startMatch({ mode: 'bomb', botCount: 11, difficulty: 'regular', seed: SEED });

// Skip only the legacy three-second presentation countdown. The Bomb freeze, round clocks,
// round-end delays and whole MR12/first-to-seven series run at their frozen durations.
game.match.phase = 'live';
game.match.countdown = 0;
const bomb = game.match.bombRules;

// A headless Game still owns one Player entity. Disconnect it before the first Bomb tick so
// every carrier, kill and interaction in this acceptance match belongs to autonomous bots.
bomb.noteDisconnect(game.player);

const botIds = new Set(game.bots.bots.map((bot) => bot.id));
const previous = new Map();
const routeDistance = new Map();
let priorRound = 0;
let priorLive = false;
let maxLiveStep = 0;
let ticks = 0;
let liveRespawns = 0;
const stopSpawnWatch = game.bus.on('spawn', () => {
  if (bomb.liveRound) liveRespawns++;
});

while (!bomb.series && ticks < MAX_TICKS) {
  const liveBefore = bomb.liveRound;
  const roundBefore = bomb.roundNumber;
  game._fixedUpdate(FIXED_DT);
  ticks++;

  // Measure movement rather than assuming it. Reset at a round boundary because fixed Bomb
  // spawns legitimately place actors for the next round; inside a live round, no step may
  // resemble a test teleport.
  const sameLiveRound = priorLive && liveBefore && priorRound === roundBefore
    && bomb.roundNumber === roundBefore;
  for (const bot of game.bots.bots) {
    const old = previous.get(bot.id);
    if (sameLiveRound && old && bot.alive) {
      const dx = bot.position.x - old.x;
      const dz = bot.position.z - old.z;
      const d = Math.hypot(dx, dz);
      maxLiveStep = Math.max(maxLiveStep, d);
      routeDistance.set(bot.id, (routeDistance.get(bot.id) ?? 0) + d);
    }
    previous.set(bot.id, { x: bot.position.x, z: bot.position.z });
  }
  priorLive = bomb.liveRound;
  priorRound = bomb.roundNumber;
}

const events = bomb.events;
const event = (kind) => events.filter((row) => row.kind === kind);
const plants = event('plantComplete');
const defuses = event('defuseComplete');
const drops = event('bombDropped');
const recoveries = event('bombPickedUp').filter((row) => row.reason === 'pickup');
const roles = new Set(game.bots.objectiveLog.map((row) => row.role));

check(bomb.series !== null, 'a complete legal Bomb series finishes inside the guard');
check(bomb.phase === 'matchEnd', 'the autonomous match reaches matchEnd', bomb.phase);
check(ticks < MAX_TICKS, 'the match cannot hang at a site or on a dropped bomb', `${ticks} ticks`);
check(game.match.modeId === 'bomb', 'the real Bomb mode remained active for the full match');
check(game.world.manifest?.mapId === 'the-square', 'the match ran on The Square');
check(game.bots._pathCount > 0, 'bots consumed real baked-nav paths', `${game.bots._pathCount}`);
check(maxLiveStep < 0.75, 'no actor teleported inside a live round', `${maxLiveStep.toFixed(4)}m max step`);
check(liveRespawns === 0, 'eliminated bots never respawn during a live Bomb round', `${liveRespawns}`);
check([...routeDistance.values()].some((distance) => distance > 40),
  'objective actors traversed substantial world distance', JSON.stringify([...routeDistance.values()].map((n) => +n.toFixed(1))));

check(plants.length >= 2, 'bots complete multiple authoritative plants', `${plants.length}`);
check(defuses.length >= 1, 'bots complete an authoritative retake and defuse', `${defuses.length}`);
check(drops.length >= 1, 'a carrier death drops the authoritative bomb', `${drops.length}`);
check(recoveries.length >= 1, 'a bot autonomously picks up a neutral/dropped bomb', `${recoveries.length}`);
check(new Set(plants.map((row) => row.site)).size === 2, 'bots choose and plant both authored sites');
check(plants.every((row) => botIds.has(row.entityId)), 'every planter is an autonomous bot');
check(defuses.every((row) => botIds.has(row.entityId)), 'every defuser is an autonomous bot');
check(recoveries.every((row) => botIds.has(row.entityId)), 'every recovery is by an autonomous bot');
for (const role of REQUIRED_ROLES) check(roles.has(role), `objective planner exercises ${role}`);

// Owner-directive acceptance (bomb-rules §13): BOTH teams plant across the series. The
// per-round `plantedByTeam` is the authoritative record of who converted possession.
const rounds = bomb.rounds;
const teamOfBot = new Map(game.bots.bots.map((bot) => [bot.id, bot.team]));
const plantingTeams = new Set(rounds.filter((row) => row.plantedByTeam !== null)
  .map((row) => row.plantedByTeam));
check(plantingTeams.has(0) && plantingTeams.has(1),
  'both teams plant across the series (owner directive)',
  `plantedByTeam values ${[...plantingTeams].join(',') || 'none'}`);

// The mandated headless-series evidence: a bomb dropped by one team and RE-PICKED by the
// other, inside one round, with that round still resolving legally. Walked over the
// authoritative event log, not inferred.
let crossPickup = false;
for (let i = 0; i < events.length; i++) {
  const drop = events[i];
  if (drop.kind !== 'bombDropped' || !teamOfBot.has(drop.entityId)) continue;
  for (let j = i + 1; j < events.length && events[j].round === drop.round; j++) {
    const pick = events[j];
    if (pick.kind === 'bombPickedUp' && pick.reason === 'pickup'
      && teamOfBot.has(pick.entityId) && teamOfBot.get(pick.entityId) !== teamOfBot.get(drop.entityId)) {
      crossPickup = true;
      break;
    }
    if (pick.kind === 'bombDropped') break; // next possession chain
  }
  if (crossPickup) break;
}
check(crossPickup,
  'a dropped bomb is re-picked by the OTHER team inside one round (contested pickup, §13.3)');

check(rounds.length >= BOMB_PARAMS.roundsToWin && rounds.length <= BOMB_PARAMS.maxRounds,
  'series length stays inside the frozen first-to-seven/MR12 bounds', `${rounds.length}`);
check(rounds.every((row, index) => row.round === index + 1), 'round records are contiguous');
check(rounds.every((row) => ['elimination', 'defuse', 'detonation', 'timer'].includes(row.reason)),
  'every autonomous round has a legal closed reason');
check(rounds.every((row) => (row.winnerTeam === -1) === (row.reason === 'timer'
  || (row.reason === 'elimination' && row.alive[0] === 0 && row.alive[1] === 0))),
'a drawn round is exactly a §13.5.3 timer expiry or a mutual wipe', JSON.stringify(rounds.map((r) => [r.winnerTeam, r.reason])));
// §13.1: home sites swap exactly after round six, and every record carries them.
check(rounds.every((row) => {
  const first = row.round <= BOMB_PARAMS.sideSwitchAfterRound;
  return row.homeSites && row.homeSites[0] === (first ? 'A' : 'B') && row.homeSites[1] === (first ? 'B' : 'A');
}), 'home sites swap exactly after round six (§13.1)', JSON.stringify(rounds.map((r) => r.homeSites)));
const [alpha, bravo] = bomb.series?.roundWins ?? [-1, -1];
check(Math.max(alpha, bravo) === BOMB_PARAMS.roundsToWin
  || (rounds.length === BOMB_PARAMS.maxRounds
    && ['roundWins', 'draw'].includes(bomb.series?.reason)),
  'series ends at seven wins, or at regulation by §13.6 more-wins/equal-wins arithmetic',
  `${alpha}-${bravo} (${bomb.series?.reason})`);

// Feed the actual Game.matchEnd payload and GameServer objective evidence into the shipping
// dedicated-server result builder. This is the real autonomous series above, not a fabricated
// status response, and the platform's own closed validator is the consumer.
const startedAt = Date.parse('2026-08-20T00:00:00.000Z');
const roster = new Map();
const entitiesByAccount = new Map();
const accountByEntity = new Map();
for (const [index, bot] of game.bots.bots.entries()) {
  const accountId = ulid(startedAt + index);
  roster.set(accountId, { displayName: `Bot ${index + 1}`, team: bot.team === 1 ? 'bravo' : 'alpha',
    joined: true, joinedAt: startedAt, connected: true, connectedAt: startedAt, connectedMs: 0 });
  entitiesByAccount.set(accountId, bot);
  accountByEntity.set(bot.id, accountId);
  authority.evidence.recordConnection({ kind: 'connected', accountId, entityId: bot.id,
    at: new Date(startedAt).toISOString() });
}
const terminalWithEvidence = buildCanonicalTerminalResult({
  allocation: { matchId, roomId: '01BX5ZZKBKACTAV9WEVGEMMVS0', mode: 'bomb', mapId: 'the-square',
    mapVersion: '1.0.0', rulesetVersion: 'bomb-1.0.0', serverBuild: '1.0.0',
    region: 'iad', startedAt, roster },
  matchResult: game.match.result, match: game.match, entitiesByAccount,
  evidence: authority.evidence, endedAt: startedAt + Math.round(ticks * FIXED_DT * 1000),
});
const { evidence: terminalEvidence, ...terminal } = terminalWithEvidence;
const resultProblems = submittableResultProblems(terminal);
check(resultProblems.length === 0, 'real matchEnd builds one exact submittable TerminalResult',
  JSON.stringify(resultProblems.slice(0, 3)));
check(terminal.rounds.length === rounds.length && terminal.players.length === roster.size,
  'terminal result contains the complete authoritative round and roster projections');
check(terminal.rounds.some((round) => round.plant?.accountId)
  && terminal.rounds.some((round) => round.defuse?.accountId),
  'objective evidence resolves plant and defuse actors to authoritative accounts');
const objectiveRows = terminalEvidence.objectives;
check(terminal.rounds.every((round) => {
  const plant = objectiveRows.find((row) => row.kind === 'plantComplete' && row.roundIndex === round.index);
  const defuse = objectiveRows.find((row) => row.kind === 'defuseComplete' && row.roundIndex === round.index);
  return (plant ? round.plant?.accountId === accountByEntity.get(plant.actorId) : round.plant === null)
    && (defuse ? round.defuse?.accountId === accountByEntity.get(defuse.actorId) : round.defuse === null);
}), 'planted/unplanted and defused/non-defused rounds keep exact zero-based evidence attribution');
check(terminalEvidence.result.matchId === terminal.matchId
  && terminalEvidence.objectives.some((row) => row.kind === 'matchOutcome'),
  'evidence retains the reconstructable result and terminal match outcome');
check(terminalEvidence.combatSamples.length > 0 && terminalEvidence.combatSummary.length === roster.size
  && terminalEvidence.connectionSummary.length === roster.size
  && Array.isArray(terminalEvidence.antiCheatFlags),
  'evidence contains combat/position samples, full counter summaries, connection facts, and anti-cheat flags');
check(terminalEvidence.combatSummary.every((summary) => {
  const player = terminal.players.find((row) => row.accountId === summary.accountId);
  return player && ['kills', 'deaths', 'assists', 'suicides', 'teamKills', 'headshots',
    'shotsFired', 'shotsHit', 'damageDealt', 'plants', 'defuses', 'roundsPlayed', 'score']
    .every((key) => player[key] === summary[key])
    && JSON.stringify(player.weapons) === JSON.stringify(summary.weapons);
}), 'discarding the embedded result still reconstructs every canonical player counter');
// `roundsPlayed` was silently 0 for every player of every Bomb series: `Match` subscribed to a
// bare `'roundStart'` bus event, but the ruleset publishes every objective fact under the single
// `'objective'` topic with a `kind`, so the handler was dead code. The field was listed in the
// counter sweep above, which only compares two copies of the SAME wrong number — equal and both
// zero passes. This asserts the value is real: a multi-round series must record rounds played.
check(terminal.rounds.length > 1 && terminal.players.length > 0
  && terminal.players.every((player) => player.roundsPlayed === terminal.rounds.length),
'every player records the series actual round count, not zero',
`rounds=${terminal.rounds.length} roundsPlayed=[${terminal.players.map((p) => p.roundsPlayed).join(',')}]`);
const { evidenceRef: _terminalEvidenceRef, ...terminalCore } = terminal;
check(evidenceDigest(reconstructEvidenceResult({ ...terminalEvidence, result: undefined }))
  === evidenceDigest(terminalCore),
  'discarding the embedded result independently reconstructs the exact TerminalResult');
check(terminalEvidence.eventTimeline.length > terminalEvidence.objectives.length
  && terminalEvidence.eventTimeline.every((row, index, all) => index === 0
    || row.eventSeq > all[index - 1].eventSeq),
  'evidence provides one strictly ordered objective/combat/connection event timeline');
const rosterWithNeverConnected = new Map(roster);
rosterWithNeverConnected.set('never-connected-account', {
  displayName: 'Never Connected', team: 'bravo', joined: false, released: false,
  connectBy: startedAt + 60_000, joinedAt: null, connected: false, connectedAt: null, connectedMs: 0,
});
const expiredNeverConnected = expireUnjoinedSeats(rosterWithNeverConnected, startedAt + 60_001);
const omittedNeverConnected = buildCanonicalTerminalResult({
  allocation: { matchId, roomId: '01BX5ZZKBKACTAV9WEVGEMMVS0', mode: 'bomb', mapId: 'the-square',
    mapVersion: '1.0.0', rulesetVersion: 'bomb-1.0.0', serverBuild: '1.0.0',
    region: 'iad', startedAt, roster: rosterWithNeverConnected },
  matchResult: game.match.result, match: game.match, entitiesByAccount,
  evidence: authority.evidence, endedAt: startedAt + Math.round(ticks * FIXED_DT * 1000),
});
const { evidence: _neverEvidence, ...omittedNeverConnectedResult } = omittedNeverConnected;
check(expiredNeverConnected === 1 && rosterWithNeverConnected.get('never-connected-account').released
  && !omittedNeverConnected.roster.some((row) => row.accountId === 'never-connected-account')
  && !omittedNeverConnected.players.some((row) => row.accountId === 'never-connected-account')
  && !omittedNeverConnected.evidence.participants.some((row) => row.accountId === 'never-connected-account')
  && !omittedNeverConnected.evidence.connectionSummary.some((row) => row.accountId === 'never-connected-account')
  && submittableResultProblems(omittedNeverConnectedResult).length === 0,
'ticket-TTL expiry releases never-connected seats from result roster/players/evidence and remains valid');
const reverseKeys = (value) => Array.isArray(value) ? value.map(reverseKeys)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])])) : value;
const reordered = reverseKeys(terminalEvidence);
const changed = structuredClone(reordered);
changed.result.teamScores.alpha++;
check(evidenceDigest(reordered) === terminal.evidenceRef.slice('sha256:'.length)
  && evidenceDigest(changed) !== terminal.evidenceRef.slice('sha256:'.length),
  'evidence digest is recursively key-order invariant and changes with semantic content');
const overflow = new ObjectiveEvidence({ limit: 1 }).identify({ matchId,
  rulesetVersion: 'bomb-1.0.0', serverBuild: '1.0.0' });
overflow.record({ kind: 'roundStart', roundIndex: 0 });
overflow.record({ kind: 'roundOutcome', roundIndex: 0 });
let overflowCode = null;
try {
  buildCanonicalTerminalResult({ allocation: { matchId, roomId: '01BX5ZZKBKACTAV9WEVGEMMVS0',
    mode: 'bomb', mapId: 'the-square', mapVersion: '1.0.0',
    rulesetVersion: 'bomb-1.0.0', serverBuild: '1.0.0', region: 'iad', startedAt, roster },
  matchResult: game.match.result, match: game.match, entitiesByAccount, evidence: overflow,
  endedAt: startedAt + 1_000 });
} catch (error) { overflowCode = error?.code; }
check(overflowCode === 'EVIDENCE_INCOMPLETE',
  'evidence overflow fails closed instead of certifying incomplete completed stats');
const sampleOverflow = new ObjectiveEvidence({ limit: 1 }).identify({ matchId,
  rulesetVersion: 'bomb-1.0.0', serverBuild: '1.0.0' });
sampleOverflow.recordCombat({ kind: 'kill' });
sampleOverflow.recordCombat({ kind: 'kill' });
sampleOverflow.recordConnection({ kind: 'allocated' });
sampleOverflow.recordConnection({ kind: 'connected' });
let sampleOverflowCode = null;
try {
  buildCanonicalTerminalResult({ allocation: { matchId, roomId: '01BX5ZZKBKACTAV9WEVGEMMVS0',
    mode: 'bomb', mapId: 'the-square', mapVersion: '1.0.0',
    rulesetVersion: 'bomb-1.0.0', serverBuild: '1.0.0', region: 'iad', startedAt, roster },
  matchResult: game.match.result, match: game.match, entitiesByAccount, evidence: sampleOverflow,
  endedAt: startedAt + 1_000 });
} catch (error) { sampleOverflowCode = error?.code; }
check(sampleOverflowCode === 'EVIDENCE_INCOMPLETE',
  'combat or connection truncation also fails closed');

stopSpawnWatch();
game.dispose();

if (failures.length) {
  console.error(`\nBomb bot acceptance: FAIL — ${failures.length}/${checks}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`\nBomb bot acceptance: PASS — ${checks} checks, ${rounds.length} rounds, `
  + `${plants.length} plants, ${defuses.length} defuses, ${recoveries.length} recoveries, `
  + `${(ticks * FIXED_DT).toFixed(1)} simulated seconds`);
process.exit(0);
