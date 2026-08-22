import { createHash } from 'node:crypto';

/** Stable canonical JSON used by both match authority and platform evidence verification. */
export function stableEvidenceJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableEvidenceJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableEvidenceJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export const evidenceDigest = (value) => createHash('sha256')
  .update(stableEvidenceJson(value)).digest('hex');

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const ulid = (value) => typeof value === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
const finiteInt = (value) => Number.isSafeInteger(value);
const iso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const forbiddenKey = (value) => {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => /secret|token|password|credential|raw/i.test(key)
    || forbiddenKey(child));
};

/** Exact, bounded AuthoritativeEvidenceV1 validator shared by producer and durable sink. */
export function authoritativeEvidenceProblems(evidence) {
  const problems = [];
  const fail = (path, reason) => problems.push({ path, reason });
  const top = ['version', 'matchId', 'rulesetVersion', 'serverBuild', 'protocolVersion',
    'objectives', 'eventTimeline', 'combatSamples', 'combatSampling', 'droppedCombatSamples',
    'connectionFacts', 'droppedConnectionFacts', 'antiCheatFlags', 'droppedAntiCheatFlags',
    'droppedRows', 'authority', 'terminalSummary', 'roster', 'participants', 'roundSummary',
    'combatSummary', 'connectionSummary', 'result'];
  if (!exact(evidence, top)) fail('evidence', 'unknown-or-missing-key');
  // wire-protocol.md's PROTOCOL_VERSION — bumped to 4 by sector-interest.md §6's appended
  // 'off-sector' REFUSAL_REASONS entry. Extend, never replace: evidence recorded under an
  // older still-supported wire version must keep verifying exactly as it always has.
  if (evidence?.version !== 1 || ![2, 3, 4].includes(evidence?.protocolVersion)) fail('evidence.version', 'unsupported');
  if (!ulid(evidence?.matchId)) fail('evidence.matchId', 'ulid');
  if (Buffer.byteLength(stableEvidenceJson(evidence ?? null)) > 2 * 1024 * 1024) fail('evidence', 'too-large');
  if (forbiddenKey(evidence)) fail('evidence', 'forbidden-sensitive-key');
  const arrays = ['objectives', 'eventTimeline', 'combatSamples', 'connectionFacts', 'antiCheatFlags',
    'roster', 'participants', 'roundSummary', 'combatSummary', 'connectionSummary'];
  for (const key of arrays) if (!Array.isArray(evidence?.[key]) || evidence[key].length > 4096) fail(`evidence.${key}`, 'bounded-array');
  for (const key of ['droppedRows', 'droppedCombatSamples', 'droppedConnectionFacts', 'droppedAntiCheatFlags']) {
    if (evidence?.[key] !== 0) fail(`evidence.${key}`, 'must-be-zero');
  }
  const authorityKeys = ['matchId', 'rulesetVersion', 'statDefinitionVersion', 'rulesSnapshot',
    'serverBuild', 'mapId', 'mapVersion', 'region', 'mode', 'startedAt'];
  if (!exact(evidence?.authority, authorityKeys)) fail('evidence.authority', 'exact-shape');
  const terminalKeys = ['status', 'endedAt', 'terminationReason', 'outcomeReason', 'winnerTeam',
    'invalidationReason', 'teamScores', 'failureReason'];
  if (!exact(evidence?.terminalSummary, terminalKeys)) fail('evidence.terminalSummary', 'exact-shape');
  if (evidence?.authority?.matchId !== evidence?.matchId
    || evidence?.authority?.rulesetVersion !== evidence?.rulesetVersion
    || evidence?.authority?.serverBuild !== evidence?.serverBuild) fail('evidence.authority', 'identity-mismatch');
  if (!iso(evidence?.authority?.startedAt) || !iso(evidence?.terminalSummary?.endedAt)) fail('evidence.authority', 'timestamp');
  if (!exact(evidence?.combatSampling,
    ['observed', 'every', 'retained', 'killsAlwaysRetained'])
    || !finiteInt(evidence?.combatSampling?.observed) || evidence?.combatSampling?.observed < 0
    || evidence?.combatSampling?.every !== 16 || evidence?.combatSampling?.killsAlwaysRetained !== true
    || evidence?.combatSampling?.retained !== evidence?.combatSamples?.length) fail('evidence.combatSampling', 'invalid');

  const participantKeys = ['accountId', 'displayName', 'team', 'role'];
  const combatKeys = ['accountId', 'kills', 'deaths', 'assists', 'suicides', 'teamKills',
    'headshots', 'shotsFired', 'shotsHit', 'damageDealt', 'plants', 'defuses', 'roundsPlayed', 'score', 'weapons'];
  const connectionKeys = ['accountId', 'joinedAt', 'leftAt', 'timePlayedSec', 'disconnected', 'abandoned'];
  const seen = new Set();
  for (const [index, row] of (evidence?.participants || []).entries()) {
    if (!exact(row, participantKeys) || !ulid(row.accountId) || seen.has(row.accountId)
      || !['alpha', 'bravo'].includes(row.team) || !(row.role === null || ['attacker', 'defender'].includes(row.role))) {
      fail(`evidence.participants[${index}]`, 'invalid');
    }
    seen.add(row.accountId);
  }
  for (const [section, keys] of [['combatSummary', combatKeys], ['connectionSummary', connectionKeys]]) {
    const ids = new Set();
    for (const [index, row] of (evidence?.[section] || []).entries()) {
      if (!exact(row, keys) || !ulid(row.accountId) || ids.has(row.accountId)) fail(`evidence.${section}[${index}]`, 'invalid');
      ids.add(row.accountId);
      if (section === 'combatSummary' && keys.slice(1, -1).some((key) => !finiteInt(row[key]) || row[key] < 0)) {
        fail(`evidence.${section}[${index}]`, 'counter');
      }
      if (section === 'connectionSummary' && (!iso(row.joinedAt) || !(row.leftAt === null || iso(row.leftAt))
        || !finiteInt(row.timePlayedSec) || row.timePlayedSec < 0
        || typeof row.disconnected !== 'boolean' || typeof row.abandoned !== 'boolean')) fail(`evidence.${section}[${index}]`, 'connection');
    }
    if (ids.size !== seen.size || [...seen].some((id) => !ids.has(id))) fail(`evidence.${section}`, 'roster-mismatch');
  }
  const rowShapes = {
    objective: ['channel', 'seq', 'eventSeq', 'kind', 'tick', 'serverTimeMs', 'roundIndex', 'phase',
      'actorId', 'actorTeam', 'site', 'position', 'reason', 'requestedKind', 'progress'],
    combat: ['channel', 'seq', 'eventSeq', 'kind', 'tick', 'serverTimeMs', 'actorId', 'targetId',
      'weaponId', 'amount', 'headshot', 'position', 'targetPosition'],
    connection: ['channel', 'seq', 'eventSeq', 'kind', 'tick', 'serverTimeMs', 'accountId', 'entityId', 'at', 'reason'],
    antiCheat: ['channel', 'seq', 'eventSeq', 'kind', 'tick', 'serverTimeMs', 'accountId', 'severity', 'details'],
  };
  let previous = -1;
  for (const [index, row] of (evidence?.eventTimeline || []).entries()) {
    if (!rowShapes[row?.channel] || !exact(row, rowShapes[row.channel]) || !finiteInt(row.eventSeq)
      || row.eventSeq <= previous) fail(`evidence.eventTimeline[${index}]`, 'ordered-exact-row');
    previous = row?.eventSeq ?? previous;
  }
  const expectedTimeline = [
    ...(evidence?.objectives || []).map((row) => ({ channel: 'objective', ...row })),
    ...(evidence?.combatSamples || []).map((row) => ({ channel: 'combat', ...row })),
    ...(evidence?.connectionFacts || []).map((row) => ({ channel: 'connection', ...row })),
    ...(evidence?.antiCheatFlags || []).map((row) => ({ channel: 'antiCheat', ...row })),
  ].sort((a, b) => a.eventSeq - b.eventSeq);
  if (stableEvidenceJson(expectedTimeline) !== stableEvidenceJson(evidence?.eventTimeline || [])) {
    fail('evidence.eventTimeline', 'section-mismatch');
  }
  return problems;
}

/**
 * Rebuild TerminalResult (without evidenceRef) from the independent authoritative sections
 * of a v1 evidence record. Deliberately ignores `evidence.result`: that sibling is the bound
 * copy a reviewer compares against, not an input to reconstruction.
 */
export function reconstructEvidenceResult(evidence) {
  const authority = evidence?.authority;
  const terminal = evidence?.terminalSummary;
  const participants = Array.isArray(evidence?.participants) ? evidence.participants : [];
  const combat = Array.isArray(evidence?.combatSummary) ? evidence.combatSummary : [];
  const connections = Array.isArray(evidence?.connectionSummary) ? evidence.connectionSummary : [];
  const roster = Array.isArray(evidence?.roster) ? evidence.roster : [];
  if (!authority || !terminal || !Array.isArray(evidence?.roundSummary)) return null;
  const byAccount = (rows) => new Map(rows.map((row) => [row.accountId, row]));
  const identities = byAccount(participants);
  const counters = byAccount(combat);
  const sessions = byAccount(connections);
  const players = roster.map(({ accountId }) => {
    const identity = identities.get(accountId);
    const stats = counters.get(accountId);
    const connection = sessions.get(accountId);
    if (!identity || !stats || !connection) return null;
    return { ...identity, ...stats, ...connection };
  });
  if (players.some((row) => row === null)) return null;
  return {
    matchId: authority.matchId,
    status: terminal.status,
    rulesetVersion: authority.rulesetVersion,
    statDefinitionVersion: authority.statDefinitionVersion,
    rulesSnapshot: authority.rulesSnapshot,
    serverBuild: authority.serverBuild,
    mapId: authority.mapId,
    mapVersion: authority.mapVersion,
    region: authority.region,
    mode: authority.mode,
    startedAt: authority.startedAt,
    endedAt: terminal.endedAt,
    terminationReason: terminal.terminationReason,
    outcomeReason: terminal.outcomeReason,
    winnerTeam: terminal.winnerTeam,
    invalidationReason: terminal.invalidationReason,
    roster,
    teamScores: terminal.teamScores,
    rounds: evidence.roundSummary,
    players,
  };
}
