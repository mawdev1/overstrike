import { BOMB_PARAMS } from '../src/game/bomb.js';
import { evidenceDigest, reconstructEvidenceResult,
  authoritativeEvidenceProblems } from '../platform/src/shared/evidenceDigest.js';

const teamName = (team) => team === 0 ? 'alpha' : team === 1 ? 'bravo' : 'draw';
const iso = (value) => new Date(value).toISOString();
const atFrom = (startedMs, row) => iso(startedMs + Math.max(0, Number(row?.serverTimeMs) || 0));
export { evidenceDigest, reconstructEvidenceResult } from '../platform/src/shared/evidenceDigest.js';

function rulesSnapshot(mode, match) {
  if (mode === 'bomb') return {
    killLimit: null, roundsToWin: BOMB_PARAMS.roundsToWin, maxRounds: BOMB_PARAMS.maxRounds,
    sideSwitchAfter: BOMB_PARAMS.sideSwitchAfterRound, roundLengthSec: BOMB_PARAMS.roundSeconds,
    bombTimerSec: BOMB_PARAMS.bombTimerSeconds, defuseSec: BOMB_PARAMS.defuseSeconds,
    plantSec: BOMB_PARAMS.plantSeconds, freezeSec: BOMB_PARAMS.freezeSeconds,
    overtime: BOMB_PARAMS.overtime,
  };
  return {
    killLimit: Number(match?.killLimit) || 75, roundsToWin: null, maxRounds: null,
    sideSwitchAfter: null, roundLengthSec: null, bombTimerSec: null, defuseSec: null,
    plantSec: null, freezeSec: null, overtime: null,
  };
}

/** Build the exact authoritative match-result.md §4 record exposed by /control/status. */
export function buildCanonicalTerminalResult({ allocation, matchResult, match, entitiesByAccount,
  evidence, endedAt = Date.now() }) {
  if (!allocation?.matchId || !matchResult || !match) throw new TypeError('terminal result inputs are required');
  const startedMs = Number(allocation.startedAt) || endedAt;
  const evidenceBody = evidence?.toJSON?.() ?? evidence ?? { objectives: [], droppedRows: 0 };
  if (['droppedRows', 'droppedCombatSamples', 'droppedConnectionFacts', 'droppedAntiCheatFlags']
    .some((key) => (Number(evidenceBody[key]) || 0) > 0)) {
    const error = new Error('Authoritative evidence is incomplete; a completed result cannot be certified.');
    error.code = 'EVIDENCE_INCOMPLETE';
    throw error;
  }
  const objectiveRows = Array.isArray(evidenceBody.objectives) ? evidenceBody.objectives : [];
  const entityToAccount = new Map();
  for (const [accountId, entity] of entitiesByAccount) if (entity?.id) entityToAccount.set(entity.id, accountId);
  // GameServer normalises Bomb's 1-based event round into a zero-based evidence round once,
  // at ingestion. A compatibility `index + 1` fallback here would steal a later round's plant
  // when the current round had none — producing plausible but false objective attribution.
  const objectiveFor = (kind, index) => objectiveRows.find((row) => row.kind === kind
    && row.roundIndex === index);

  const rawRounds = allocation.mode === 'bomb' && Array.isArray(matchResult.rounds)
    ? matchResult.rounds : [];
  const rounds = rawRounds.map((round, index) => {
    const start = objectiveFor('roundStart', index);
    const finish = objectiveFor('roundOutcome', index);
    const plant = objectiveFor('plantComplete', index);
    const defuse = objectiveFor('defuseComplete', index);
    const attacking = round.attackingTeam;
    return {
      index, winner: teamName(round.winnerTeam),
      reason: ['elimination', 'defuse', 'detonation', 'timer'].includes(round.reason)
        ? round.reason : 'elimination',
      startedAt: atFrom(startedMs, start),
      endedAt: atFrom(startedMs, finish ?? { serverTimeMs: (round.endedAtTick || 0) * (1000 / 120) }),
      roles: { alpha: attacking === 0 ? 'attacker' : 'defender',
        bravo: attacking === 1 ? 'attacker' : 'defender' },
      plant: plant && entityToAccount.has(plant.actorId) ? {
        accountId: entityToAccount.get(plant.actorId), site: plant.site, at: atFrom(startedMs, plant),
      } : null,
      defuse: defuse && entityToAccount.has(defuse.actorId) ? {
        accountId: entityToAccount.get(defuse.actorId), at: atFrom(startedMs, defuse),
      } : null,
    };
  });

  const endedIso = iso(endedAt);
  const firstAttacker = rawRounds[0]?.attackingTeam;
  // Never-connected seats expire out of the authoritative roster at ticket TTL. They did not
  // play and must not be invented as zero-stat career participants by terminal projection.
  const players = [...allocation.roster].filter(([, seat]) => seat.joined).map(([accountId, seat]) => {
    const entity = entitiesByAccount.get(accountId) ?? null;
    const stats = match.canonicalStatsFor(entity);
    const joinedAt = iso(seat.joinedAt || startedMs);
    const connectedMs = (seat.connectedMs || 0)
      + (seat.connected && seat.connectedAt ? Math.max(0, endedAt - seat.connectedAt) : 0);
    const leftAt = seat.connected ? null : iso(seat.disconnectedAt || endedAt);
    return {
      accountId, displayName: seat.displayName, team: seat.team,
      role: allocation.mode === 'bomb'
        ? ((seat.team === 'alpha') === (firstAttacker === 0) ? 'attacker' : 'defender') : null,
      ...stats, timePlayedSec: Math.floor(connectedMs / 1000),
      disconnected: !seat.connected, abandoned: false, joinedAt, leftAt,
    };
  });
  const roster = players.map(({ accountId, team, joinedAt, leftAt }) => ({ accountId, team, joinedAt, leftAt }));
  const outcomeReason = matchResult.outcomeReason
    || (matchResult.reason === 'draw' || matchResult.reason === 'time' ? 'timer'
      : ['defuse', 'detonation', 'timer', 'elimination'].includes(matchResult.reason)
        ? matchResult.reason : 'elimination');
  const winnerTeam = matchResult.winnerTeam < 0 ? 'draw' : teamName(matchResult.winnerTeam);
  const core = {
    matchId: allocation.matchId, status: 'completed',
    rulesetVersion: allocation.rulesetVersion, statDefinitionVersion: '1.0.0',
    rulesSnapshot: rulesSnapshot(allocation.mode, match), serverBuild: allocation.serverBuild,
    mapId: allocation.mapId, mapVersion: allocation.mapVersion, region: allocation.region,
    mode: allocation.mode, startedAt: iso(startedMs), endedAt: endedIso,
    terminationReason: 'completed', outcomeReason, winnerTeam, invalidationReason: null,
    roster, teamScores: { alpha: Number(matchResult.scores?.[0] ?? matchResult.roundWins?.[0]) || 0,
      bravo: Number(matchResult.scores?.[1] ?? matchResult.roundWins?.[1]) || 0 },
    rounds, players,
  };
  const combatSummary = players.map(({ accountId, kills, deaths, assists, suicides, teamKills,
    headshots, shotsFired, shotsHit, damageDealt, plants, defuses, roundsPlayed, score, weapons }) => ({
    accountId, kills, deaths, assists, suicides, teamKills, headshots, shotsFired, shotsHit,
    damageDealt, plants, defuses, roundsPlayed, score, weapons,
  }));
  const connectionSummary = players.map(({ accountId, joinedAt, leftAt, timePlayedSec,
    disconnected, abandoned }) => ({ accountId, joinedAt, leftAt, timePlayedSec, disconnected, abandoned }));
  const participants = players.map(({ accountId, displayName, team, role }) => ({
    accountId, displayName, team, role,
  }));
  const authority = {
    matchId: core.matchId, rulesetVersion: core.rulesetVersion,
    statDefinitionVersion: core.statDefinitionVersion, rulesSnapshot: core.rulesSnapshot,
    serverBuild: core.serverBuild, mapId: core.mapId, mapVersion: core.mapVersion,
    region: core.region, mode: core.mode, startedAt: core.startedAt,
  };
  const terminalSummary = {
    status: core.status, endedAt: core.endedAt, terminationReason: core.terminationReason,
    outcomeReason: core.outcomeReason, winnerTeam: core.winnerTeam,
    invalidationReason: core.invalidationReason, teamScores: core.teamScores, failureReason: null,
  };
  const evidenceRecord = { ...evidenceBody, authority, terminalSummary, roster,
    participants, roundSummary: rounds, combatSummary, connectionSummary, result: core };
  const reconstructed = reconstructEvidenceResult(evidenceRecord);
  const evidenceProblems = authoritativeEvidenceProblems(evidenceRecord);
  if (evidenceProblems.length || !reconstructed || evidenceDigest(reconstructed) !== evidenceDigest(core)) {
    const error = new Error('Authoritative evidence cannot independently reconstruct the terminal result.');
    error.code = 'EVIDENCE_INCOMPLETE';
    error.problems = evidenceProblems;
    throw error;
  }
  const digest = evidenceDigest(evidenceRecord);
  return { ...core, evidenceRef: `sha256:${digest}`, evidence: evidenceRecord };
}
