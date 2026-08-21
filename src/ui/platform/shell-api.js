import { createUlid } from './ids.js';
import { PlatformClientError } from './errors.js';
import { validateRoamingSettings } from '../../../platform/src/modules/profile/settings.js';

const encode = encodeURIComponent;
const LEGACY_PROGRESSION_KEY = 'overstrike.progress.v1';
const LEGACY_IMPORT_MARKER_KEY = 'overstrike.progress.imported.v1';

function query(path, payload, keys) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = payload?.[key];
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

const bodyWith = (source, keys) => Object.fromEntries(keys
  .filter((key) => source?.[key] !== undefined)
  .map((key) => [key, source[key]]));

const record = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0;
const nullableText = (value) => value === null || text(value);
// Contract timestamps are UTC instants, not implementation-dependent Date.parse inputs. The
// round trip rejects calendar rollover (`2026-02-30`), offsets, missing zones and extra text.
const iso = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && (() => { const parsed = new Date(value); return !Number.isNaN(parsed.getTime())
    && parsed.toISOString() === value; })();
const integer = (value) => Number.isInteger(value);
const count = (value) => integer(value) && value >= 0;
const bool = (value) => typeof value === 'boolean';
const closed = (value, required, optional = []) => record(value)
  && required.every((key) => Object.hasOwn(value, key))
  && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

const PROFILE_KEYS = ['accountId', 'displayName', 'createdAt', 'privacy', 'consent', 'moderation',
  'flags', 'correlationId'];
function validProfile(value, { embedded = false } = {}) {
  const keys = embedded ? PROFILE_KEYS.filter((key) => key !== 'correlationId') : PROFILE_KEYS;
  return closed(value, keys)
    && text(value.accountId) && text(value.displayName) && iso(value.createdAt)
    && closed(value.privacy, ['presenceVisibility', 'statsVisibility'])
    && ['everyone', 'friends', 'nobody'].includes(value.privacy.presenceVisibility)
    && ['everyone', 'nobody'].includes(value.privacy.statsVisibility)
    && (value.consent === null || (closed(value.consent,
      ['telemetryPersonal', 'policyVersion', 'decidedAt'])
      && bool(value.consent.telemetryPersonal) && integer(value.consent.policyVersion)
      && iso(value.consent.decidedAt)))
    && closed(value.moderation, ['status', 'activeSanctions'])
    && ['clear', 'restricted', 'banned'].includes(value.moderation.status)
    && Array.isArray(value.moderation.activeSanctions)
    && value.moderation.activeSanctions.length === 0
    && closed(value.flags, ['nameChangeAvailableAt', 'setupNextStep'])
    && (value.flags.nameChangeAvailableAt === null || iso(value.flags.nameChangeAvailableAt))
    && [null, 'eligibility', 'consent', 'display-name', 'verify', 'terms',
      'essential-settings'].includes(value.flags.setupNextStep)
    && (embedded || text(value.correlationId));
}

function validSessionAuth(value) {
  return closed(value, ['accessToken', 'expiresAt', 'session', 'profile', 'consentReceipt',
    'correlationId']) && text(value.accessToken) && iso(value.expiresAt)
    && closed(value.session, ['sessionId', 'deviceLabel', 'createdAt'])
    && text(value.session.sessionId) && text(value.session.deviceLabel) && iso(value.session.createdAt)
    && validProfile(value.profile, { embedded: true })
    && nullableText(value.consentReceipt) && text(value.correlationId);
}

function validSettings(value) {
  return closed(value, ['schemaVersion', 'version', 'values', 'updatedAt', 'correlationId'])
    && integer(value.schemaVersion) && integer(value.version) && record(value.values)
    && validateRoamingSettings(value.values).errors.length === 0
    && iso(value.updatedAt) && text(value.correlationId);
}

const correlationOnly = (value) => closed(value, ['correlationId']) && text(value.correlationId);
const empty204 = (value, response) => value == null && response?.status === 204
  && text(response.correlationId);
const validEligibility = (value) => closed(value,
  ['eligible', 'receipt', 'expiresAt', 'policyVersion', 'correlationId'])
  && value.eligible === true && text(value.receipt) && iso(value.expiresAt)
  && integer(value.policyVersion) && text(value.correlationId);
const NAME_RULES = ['length', 'charset', 'reserved', 'impersonation', 'profanity', 'confusable'];
const validDisplayNameCheck = (value) => closed(value, ['available', 'policy', 'correlationId'])
  && bool(value.available) && (value.policy === null || (closed(value.policy, ['rule'])
    && NAME_RULES.includes(value.policy.rule))) && text(value.correlationId);
const validTerms = (value) => closed(value, ['version', 'url', 'publishedAt', 'correlationId'])
  && integer(value.version) && text(value.url) && iso(value.publishedAt) && text(value.correlationId);

const validPresenceItem = (value) => closed(value,
  ['accountId', 'displayName', 'state', 'joinable', 'roomId'])
  && text(value.accountId) && text(value.displayName)
  && ['online', 'in-lobby', 'in-match'].includes(value.state)
  && bool(value.joinable) && nullableText(value.roomId);
const validPresencePage = (value) => closed(value, ['items', 'nextCursor', 'correlationId'])
  && Array.isArray(value.items) && value.items.every(validPresenceItem)
  && nullableText(value.nextCursor) && text(value.correlationId);

// http-api.md §11.6. `probeUrl` is nullable by contract: a region with no registered server has
// nothing honest to point at, and naming a host that will not answer would have the client
// record a timeout as a latency.
const validRegion = (value) => closed(value, ['id', 'label', 'probeUrl', 'available'])
  && text(value.id) && text(value.label) && nullableText(value.probeUrl) && bool(value.available);
const validRegionList = (value) => closed(value, ['regions'], ['correlationId'])
  && Array.isArray(value.regions) && value.regions.every(validRegion);

const validSession = (value) => closed(value,
  ['sessionId', 'deviceLabel', 'userAgentClass', 'ipClass', 'createdAt', 'lastSeenAt', 'isCurrent'])
  && text(value.sessionId) && text(value.deviceLabel) && text(value.userAgentClass)
  && text(value.ipClass) && iso(value.createdAt) && iso(value.lastSeenAt) && bool(value.isCurrent);
const validSessions = (value) => closed(value, ['sessions', 'correlationId'])
  && Array.isArray(value.sessions) && value.sessions.every(validSession) && text(value.correlationId);

const TOTAL_KEYS = ['kills', 'deaths', 'assists', 'suicides', 'teamKills', 'headshots',
  'shotsFired', 'shotsHit', 'damageDealt', 'plants', 'defuses', 'matches', 'wins', 'losses',
  'draws', 'roundsPlayed', 'timePlayedSec'];
const validTotals = (value) => closed(value, TOTAL_KEYS) && TOTAL_KEYS.every((key) => count(value[key]));
const validWeaponCounters = (value) => closed(value, ['shots', 'hits', 'kills', 'headshots'])
  && ['shots', 'hits', 'kills', 'headshots'].every((key) => count(value[key]));
const validWeapons = (value) => record(value) && Object.values(value).every(validWeaponCounters);
const validModeStats = (value, { correlation = false } = {}) => closed(value,
  ['accountId', 'mode', 'statDefinitionVersion', 'totals', 'weapons',
    ...(correlation ? ['correlationId'] : [])])
  && text(value.accountId) && ['tdm', 'bomb'].includes(value.mode)
  && text(value.statDefinitionVersion)
  && (value.totals === null || validTotals(value.totals))
  && (value.weapons === null || validWeapons(value.weapons))
  && (!correlation || text(value.correlationId));

const validHistoryItem = (value) => closed(value,
  ['matchId', 'status', 'mode', 'mapId', 'mapVersion', 'endedAt', 'result', 'teamScores',
    'playerSummary'])
  && text(value.matchId) && ['pending', 'completed', 'aborted', 'invalidated'].includes(value.status)
  && ['tdm', 'bomb'].includes(value.mode) && text(value.mapId) && text(value.mapVersion)
  && (value.endedAt === null || iso(value.endedAt))
  && (value.status === 'pending'
    ? value.result === null && value.teamScores === null && value.playerSummary === null
    : ['win', 'loss', 'draw', null].includes(value.result)
      && (value.teamScores === null || (closed(value.teamScores, ['alpha', 'bravo'])
        && count(value.teamScores.alpha) && count(value.teamScores.bravo)))
      && (value.playerSummary === null || (closed(value.playerSummary,
        ['kills', 'deaths', 'assists', 'score'])
        && ['kills', 'deaths', 'assists', 'score'].every((key) => count(value.playerSummary[key])))));
const validHistoryPage = (value) => closed(value, ['items', 'nextCursor', 'correlationId'])
  && (value.items === null || (Array.isArray(value.items) && value.items.every(validHistoryItem)))
  && nullableText(value.nextCursor) && text(value.correlationId);

const ROOM_CORE_KEYS = ['roomId', 'name', 'region', 'mapId', 'mapVersion', 'mode',
  'rulesetVersion', 'build', 'status', 'capacity', 'playerCount', 'joinable',
  'joinBlockedReason', 'hasPassword', 'ownerAccountId', 'estimatedRttMs', 'settings'];
function validRoomCore(value) {
  return closed(value, ROOM_CORE_KEYS) && ROOM_CORE_KEYS.slice(0, 8).every((key) => text(value[key]))
    && ['tdm', 'bomb'].includes(value.mode)
    && ['open', 'countdown', 'in-progress', 'closing'].includes(value.status)
    && integer(value.capacity) && integer(value.playerCount) && bool(value.joinable)
    && nullableText(value.joinBlockedReason) && bool(value.hasPassword) && text(value.ownerAccountId)
    && (value.estimatedRttMs === null || Number.isFinite(value.estimatedRttMs))
    && closed(value.settings, ['killLimit', 'roundsToWin', 'maxRounds', 'roundLengthSec',
      'backfill', 'requiredReady', 'minPlayers'])
    && ['killLimit', 'roundsToWin', 'maxRounds', 'roundLengthSec']
      .every((key) => value.settings[key] === null || count(value.settings[key]))
    && ['requiredReady', 'minPlayers'].every((key) => count(value.settings[key]))
    && bool(value.settings.backfill);
}

const validRoomMember = (value) => closed(value,
  ['accountId', 'displayName', 'team', 'ready', 'isOwner', 'isLocal', 'connection',
    'estimatedRttMs', 'loadout', 'joinedAt'])
  && text(value.accountId) && text(value.displayName) && ['alpha', 'bravo'].includes(value.team)
  && bool(value.ready) && bool(value.isOwner) && bool(value.isLocal)
  && ['connected', 'reconnecting'].includes(value.connection)
  && (value.estimatedRttMs === null || (Number.isFinite(value.estimatedRttMs)
    && value.estimatedRttMs >= 0))
  && closed(value.loadout, ['primaryIdx', 'secondaryIdx'])
  && count(value.loadout.primaryIdx) && count(value.loadout.secondaryIdx) && iso(value.joinedAt);
const validCountdown = (value) => value === null || (closed(value,
  ['endsAt', 'requiredReady', 'currentReady']) && iso(value.endsAt)
  && count(value.requiredReady) && count(value.currentReady));

function validRoomDetail(value) {
  return closed(value, [...ROOM_CORE_KEYS, 'roster', 'countdown', 'correlationId'])
    && validRoomCore(Object.fromEntries(ROOM_CORE_KEYS.map((key) => [key, value[key]])))
    && Array.isArray(value.roster) && value.roster.every(validRoomMember)
    && validCountdown(value.countdown)
    && text(value.correlationId);
}

const reservation = (value) => closed(value,
  ['reservationId', 'expiresAt', 'lobbySocketUrl', 'lobbyTicket', 'correlationId'])
  && text(value.reservationId) && iso(value.expiresAt) && text(value.lobbySocketUrl)
  && text(value.lobbyTicket) && text(value.correlationId);

const activeMatch = (value) => value == null || (closed(value,
  ['matchId', 'roomId', 'graceEndsAt', 'serverNow', 'correlationId'])
  && text(value.matchId) && text(value.roomId) && iso(value.graceEndsAt)
    && iso(value.serverNow) && text(value.correlationId));

const validHandoff = (value) => closed(value,
  ['matchId', 'serverUrl', 'sessionTicket', 'expiresAt', 'reconnectGraceMs', 'protocolVersion',
    'mapId', 'mapVersion', 'mode', 'rulesetVersion', 'region', 'serverBuild', 'series',
    'spectatorPolicyVersion', 'sites'])
  && text(value.matchId) && text(value.serverUrl) && text(value.sessionTicket) && iso(value.expiresAt)
  && count(value.reconnectGraceMs) && integer(value.protocolVersion) && text(value.mapId)
  && text(value.mapVersion) && ['tdm', 'bomb'].includes(value.mode)
  && text(value.rulesetVersion) && text(value.region) && text(value.serverBuild)
  && closed(value.series, ['roundsToWin', 'maxRounds', 'sideSwitchAfter', 'overtime'])
  && ['roundsToWin', 'maxRounds', 'sideSwitchAfter'].every((key) => count(value.series[key]))
  && bool(value.series.overtime) && integer(value.spectatorPolicyVersion)
  && Array.isArray(value.sites) && value.sites.every((site) => closed(site,
    ['id', 'site', 'callout', 'center', 'box']) && text(site.id) && ['A', 'B'].includes(site.site)
    && text(site.callout) && closed(site.center, ['x', 'y', 'z'])
    && ['x', 'y', 'z'].every((key) => Number.isFinite(site.center[key]))
    && closed(site.box, ['min', 'max'])
    && ['min', 'max'].every((edge) => closed(site.box[edge], ['x', 'y', 'z'])
      && ['x', 'y', 'z'].every((key) => Number.isFinite(site.box[edge][key]))));

const TERMINAL_MATCH_KEYS = ['matchId', 'status', 'rulesetVersion', 'statDefinitionVersion',
  'rulesSnapshot', 'serverBuild', 'mapId', 'mapVersion', 'region', 'mode', 'startedAt', 'endedAt',
  'terminationReason', 'outcomeReason', 'winnerTeam', 'invalidationReason', 'roster', 'teamScores',
  'rounds', 'players', 'evidenceRef', 'correlationId'];
const RULE_KEYS = ['killLimit', 'roundsToWin', 'maxRounds', 'sideSwitchAfter',
  'roundLengthSec', 'bombTimerSec', 'defuseSec', 'plantSec', 'freezeSec', 'overtime'];
const validRules = (value, mode) => closed(value, RULE_KEYS)
  && (mode === 'tdm'
    ? count(value.killLimit) && RULE_KEYS.slice(1).every((key) => value[key] === null)
    : value.killLimit === null
      && RULE_KEYS.slice(1, -1).every((key) => count(value[key])) && bool(value.overtime));
const validRosterEntry = (value) => closed(value, ['accountId', 'team', 'joinedAt', 'leftAt'])
  && text(value.accountId) && ['alpha', 'bravo'].includes(value.team) && iso(value.joinedAt)
  && (value.leftAt === null || iso(value.leftAt));
const validObjective = (value, plant = false) => value === null || (closed(value,
  plant ? ['accountId', 'site', 'at'] : ['accountId', 'at'])
  && (value.accountId === null || text(value.accountId)) && (!plant || ['A', 'B'].includes(value.site))
  && iso(value.at));
const validRound = (value) => closed(value,
  ['index', 'winner', 'reason', 'startedAt', 'endedAt', 'roles', 'plant', 'defuse'])
  && count(value.index) && ['alpha', 'bravo'].includes(value.winner)
  && ['elimination', 'defuse', 'detonation', 'timer'].includes(value.reason)
  && iso(value.startedAt) && iso(value.endedAt)
  && closed(value.roles, ['alpha', 'bravo'])
  && ['attacker', 'defender'].includes(value.roles.alpha)
  && ['attacker', 'defender'].includes(value.roles.bravo)
  && validObjective(value.plant, true) && validObjective(value.defuse, false);
const PLAYER_COUNT_KEYS = ['kills', 'deaths', 'assists', 'suicides', 'teamKills', 'headshots',
  'shotsFired', 'shotsHit', 'damageDealt', 'plants', 'defuses', 'roundsPlayed', 'timePlayedSec'];
const validPlayer = (value) => closed(value,
  ['accountId', 'displayName', 'team', 'role', ...PLAYER_COUNT_KEYS, 'score', 'disconnected',
    'abandoned', 'joinedAt', 'leftAt', 'weapons'])
  && text(value.accountId) && text(value.displayName) && ['alpha', 'bravo'].includes(value.team)
  && (value.role === null || ['attacker', 'defender'].includes(value.role))
  && PLAYER_COUNT_KEYS.every((key) => count(value[key])) && integer(value.score)
  && bool(value.disconnected) && bool(value.abandoned) && iso(value.joinedAt)
  && (value.leftAt === null || iso(value.leftAt)) && validWeapons(value.weapons);
function validMatch(value) {
  if (!record(value)) return false;
  if (value.status === 'pending') return closed(value,
    ['matchId', 'status', 'mode', 'mapId', 'mapVersion', 'startedAt', 'endedAt', 'retryAfterMs',
      'correlationId']) && text(value.matchId) && ['tdm', 'bomb'].includes(value.mode)
      && text(value.mapId) && text(value.mapVersion)
      && (value.startedAt === null || iso(value.startedAt))
      && (value.endedAt === null || iso(value.endedAt)) && integer(value.retryAfterMs)
      && text(value.correlationId);
  return closed(value, TERMINAL_MATCH_KEYS)
    && text(value.matchId) && ['completed', 'aborted', 'invalidated'].includes(value.status)
    && value.terminationReason === value.status && ['tdm', 'bomb'].includes(value.mode)
    && text(value.rulesetVersion) && text(value.statDefinitionVersion)
    && validRules(value.rulesSnapshot, value.mode) && text(value.serverBuild)
    && text(value.mapId) && text(value.mapVersion) && text(value.region)
    && iso(value.startedAt) && iso(value.endedAt)
    && ['elimination', 'defuse', 'detonation', 'timer', 'forfeit', 'abandon', 'no-contest']
      .includes(value.outcomeReason)
    && [null, 'alpha', 'bravo', 'draw'].includes(value.winnerTeam)
    && [null, 'cheat-detected', 'server-fault', 'roster-fault', 'admin-review']
      .includes(value.invalidationReason)
    && Array.isArray(value.roster) && value.roster.every(validRosterEntry)
    && closed(value.teamScores, ['alpha', 'bravo'])
    && count(value.teamScores.alpha) && count(value.teamScores.bravo)
    && Array.isArray(value.rounds) && value.rounds.every(validRound)
    && Array.isArray(value.players) && value.players.every(validPlayer)
    && value.roster.length === value.players.length
    && value.roster.every((seat) => value.players.some((player) =>
      player.accountId === seat.accountId && player.team === seat.team))
    && new Set(value.roster.map((seat) => seat.accountId)).size === value.roster.length
    && (value.evidenceRef === null || text(value.evidenceRef)) && text(value.correlationId)
    && (value.status === 'completed'
      ? value.invalidationReason === null
        && ['elimination', 'defuse', 'detonation', 'timer'].includes(value.outcomeReason)
        && (value.winnerTeam === 'draw' ? value.outcomeReason === 'timer'
          : ['alpha', 'bravo'].includes(value.winnerTeam))
      : value.status === 'aborted'
        ? value.invalidationReason === null
          && ['forfeit', 'abandon', 'no-contest'].includes(value.outcomeReason)
          && (value.outcomeReason === 'no-contest' ? value.winnerTeam === null
            : ['alpha', 'bravo'].includes(value.winnerTeam))
        : value.outcomeReason === 'no-contest' && value.winnerTeam === null
          && value.invalidationReason !== null);
}

function shellRoom(room) {
  if (!room || typeof room !== 'object') return room;
  return {
    ...room,
    id: room.roomId,
    map: room.mapId,
    occupancy: `${room.playerCount} / ${room.capacity}`,
  };
}

function shellMatch(match) {
  if (!match || typeof match !== 'object') return match;
  return { ...match, id: match.matchId };
}

function teamValue(value) {
  if (value === 'A') return 'alpha';
  if (value === 'B') return 'bravo';
  return value;
}

/**
 * Named operations consumed by the out-of-match shell. This is a shape adapter only: every
 * network call below maps to a frozen HTTP endpoint. Lobby chat remains a WebSocket concern
 * and is deliberately not fabricated as an HTTP operation.
 *
 * @param {{client: import('./client.js').PlatformClient,
 * telemetry?: import('./telemetry.js').TelemetryClient|null, settings?: object|null,
 * ulid?: () => string}} options
 */
export function createShellApi({ client, telemetry = null, settings = null, ulid = createUlid,
  legacyStorage = globalThis.localStorage } = {}) {
  if (!client) throw new TypeError('createShellApi requires a PlatformClient.');
  let ownProfile = null;
  let settingsEtag = null;
  let legacyImportTask = null;
  const data = async (path, options, validate = null) => {
    const response = await client.request(path, options);
    const body = response.data;
    if (response.status !== 204
      && (!body || typeof body !== 'object' || Array.isArray(body))) {
      throw new PlatformClientError('CLIENT_PROTOCOL',
        'The platform returned an invalid success projection.', {
          correlationId: response.correlationId,
        });
    }
    if (validate && !validate(body, response)) protocol(response.correlationId ?? body?.correlationId);
    return body;
  };
  const key = (operation) => `shell:${operation}:${ulid()}`;
  const protocol = (correlationId) => {
    throw new PlatformClientError('CLIENT_PROTOCOL',
      'The platform returned an invalid success projection.', { correlationId });
  };

  const rememberAuth = (result) => {
    if (!validSessionAuth(result)) protocol(result?.correlationId);
    ownProfile = result?.profile || ownProfile;
    const consent = result?.profile?.consent;
    if (telemetry && consent === null) telemetry.setConsent({ telemetryPersonal: null });
    else if (telemetry && consent && result.consentReceipt) {
      telemetry.setConsent({
        telemetryPersonal: consent.telemetryPersonal,
        receipt: result.consentReceipt,
      });
    }
    return result;
  };

  const validateLegacyImport = (result, correlationId = result?.correlationId) => {
    const lifetimeKeys = ['kills', 'deaths', 'assists', 'headshots', 'longshots', 'shotsFired',
      'shotsHit', 'wins', 'losses', 'draws', 'matches', 'playtime', 'longestShot', 'bestStreak',
      'score', 'captures', 'confirms', 'denies', 'streaksEarned'];
    const weaponKeys = ['xp', 'kills', 'headshots', 'shotsFired', 'shotsHit'];
    if (!closed(result, ['source', 'verified', 'importedAt', 'data', 'alreadyImported',
      'correlationId'])
      || result.source !== 'localStorage:overstrike.progress.v1'
      || result.verified !== false || typeof result.alreadyImported !== 'boolean'
      || !iso(result.importedAt) || !text(result.correlationId)
      || !closed(result.data, ['schema', 'xp', 'lifetime', 'weapons', 'challenges'])
      || !integer(result.data.schema) || !integer(result.data.xp)
      || !closed(result.data.lifetime, lifetimeKeys)
      || !lifetimeKeys.every((key) => count(result.data.lifetime[key]))
      || !record(result.data.weapons)
      || !Object.values(result.data.weapons).every((row) => closed(row, weaponKeys)
        && weaponKeys.every((key) => count(row[key])))
      || !Array.isArray(result.data.challenges) || !result.data.challenges.every(text)) {
      protocol(correlationId);
    }
    return result;
  };

  async function importLegacyProgression(progress) {
    return validateLegacyImport(await data('/v1/profile/me/progression-import', {
      method: 'POST', body: { progress }, maxAttempts: 1,
    }));
  }

  function maybeImportLegacyProgression() {
    if (legacyImportTask) return legacyImportTask;
    let raw = null;
    try {
      if (legacyStorage?.getItem?.(LEGACY_IMPORT_MARKER_KEY) === 'done') return null;
      raw = legacyStorage?.getItem?.(LEGACY_PROGRESSION_KEY);
    } catch { return null; }
    if (!raw) return null;
    let progress;
    try { progress = JSON.parse(raw); } catch { return null; }
    if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return null;
    legacyImportTask = importLegacyProgression(progress).then((result) => {
      // Preserve the legacy blob for local practice and support/debug visibility. The marker is
      // separate and records only that the server accepted the inert unverified projection.
      try { legacyStorage?.setItem?.(LEGACY_IMPORT_MARKER_KEY, 'done'); } catch { /* retry next auth */ }
      return result;
    }).catch((error) => {
      legacyImportTask = null;
      throw error;
    });
    return legacyImportTask;
  }

  const settingsProjection = (body, etag) => ({
    ...body,
    bindings: body?.values?.keybinds || {},
    etag: etag || (Number.isInteger(body?.version) ? `"${body.version}"` : null),
  });

  const getOwnProfile = async () => {
    ownProfile = await data('/v1/profile/me', undefined, validProfile);
    await maybeImportLegacyProgression();
    return ownProfile;
  };

  const getOwnStats = async (mode = 'all') => {
    const profile = ownProfile || await getOwnProfile();
    return data(`/v1/profile/${encode(profile.accountId)}/stats?mode=${encode(mode)}`, undefined,
      (value) => mode === 'all'
        ? closed(value, ['accountId', 'modes', 'correlationId']) && text(value.accountId)
          && closed(value.modes, ['tdm', 'bomb'])
          && validModeStats(value.modes.tdm) && value.modes.tdm.mode === 'tdm'
          && validModeStats(value.modes.bomb) && value.modes.bomb.mode === 'bomb'
          && value.modes.tdm.accountId === value.accountId
          && value.modes.bomb.accountId === value.accountId && text(value.correlationId)
        : validModeStats(value, { correlation: true }) && value.mode === mode);
  };

  const operations = {
    getFlags() { return data('/v1/config/flags', undefined, (value) => closed(value,
      ['version', 'evaluatedAt', 'expiresAt', 'flags', 'correlationId'])
      && integer(value.version) && iso(value.evaluatedAt) && iso(value.expiresAt)
      && record(value.flags) && Object.values(value.flags).every(bool) && text(value.correlationId)); },

    async checkEligibility(payload = {}) {
      return data('/v1/onboarding/eligibility', {
        method: 'POST', auth: false,
        body: { dateOfBirth: payload.dateOfBirth ?? payload.birthdate, jurisdiction: payload.jurisdiction },
        maxAttempts: 1,
      }, validEligibility);
    },

    async getConsent() {
      const signedOut = !client.sessionState?.authenticated;
      if (signedOut && !telemetry?.getClientSessionId?.()) {
        throw new TypeError('Signed-out consent requires a telemetry client session id.');
      }
      const path = signedOut
        ? `/v1/onboarding/consent?clientSessionId=${encode(telemetry?.getClientSessionId?.() || '')}`
        : '/v1/onboarding/consent';
      const result = await data(path, { auth: !signedOut }, (value) => closed(value,
        ['telemetryPersonal', 'policyVersion', 'decidedAt', 'currentPolicyVersion', 'subject',
          'receipt', 'correlationId'])
        && (value.telemetryPersonal === null || bool(value.telemetryPersonal))
        && (value.policyVersion === null || integer(value.policyVersion))
        && (value.decidedAt === null || iso(value.decidedAt)) && integer(value.currentPolicyVersion)
        && ['account', 'client-session'].includes(value.subject)
        && nullableText(value.receipt) && text(value.correlationId));
      telemetry?.setConsent({
        telemetryPersonal: result.telemetryPersonal,
        receipt: result.receipt,
      });
      return result;
    },

    async setConsent(payload = {}) {
      const signedOut = !client.sessionState?.authenticated;
      if (signedOut && !telemetry?.getClientSessionId?.()) {
        throw new TypeError('Signed-out consent requires a telemetry client session id.');
      }
      const result = await data('/v1/onboarding/consent', {
        method: 'PUT', auth: !signedOut,
        body: {
          telemetryPersonal: payload.telemetryPersonal ?? payload.allowed,
          policyVersion: payload.policyVersion,
          clientSessionId: telemetry?.getClientSessionId?.(),
        },
      }, (value) => closed(value,
        ['telemetryPersonal', 'policyVersion', 'decidedAt', 'subject', 'receipt', 'correlationId'])
        && bool(value.telemetryPersonal) && integer(value.policyVersion) && iso(value.decidedAt)
        && ['account', 'client-session'].includes(value.subject)
        && text(value.receipt) && text(value.correlationId));
      telemetry?.setConsent({ telemetryPersonal: result.telemetryPersonal, receipt: result.receipt });
      return result;
    },

    checkDisplayName(payload = {}) {
      return data('/v1/auth/display-name/check', {
        method: 'POST', auth: false, body: { displayName: payload.displayName }, maxAttempts: 1,
      }, validDisplayNameCheck);
    },

    async signIn(payload = {}) {
      const result = (await client.signIn({
        email: payload.email ?? payload.identifier, password: payload.password,
      }, { validateSuccess: validSessionAuth })).data;
      rememberAuth(result);
      await maybeImportLegacyProgression();
      return result;
    },

    async signUp(payload = {}) {
      const clientSessionId = payload.clientSessionId || telemetry?.getClientSessionId?.();
      if (!clientSessionId) throw new TypeError('Signup requires a clientSessionId.');
      const result = (await client.signUp({
        email: payload.email,
        password: payload.password,
        displayName: payload.displayName,
        eligibilityReceipt: payload.eligibilityReceipt,
        clientSessionId,
        consentReceipt: payload.consentReceipt,
      }, { validateSuccess: validSessionAuth })).data;
      rememberAuth(result);
      await maybeImportLegacyProgression();
      return result;
    },

    startRecovery(payload = {}) {
      return data('/v1/auth/recovery/start', {
        method: 'POST', auth: false, body: { email: payload.email ?? payload.identifier }, maxAttempts: 1,
      }, correlationOnly);
    },

    completeRecovery(payload = {}) {
      return data('/v1/auth/recovery/complete', {
        method: 'POST', auth: false,
        body: { token: payload.token, newPassword: payload.newPassword }, maxAttempts: 1,
      }, empty204);
    },

    completeVerification(payload = {}) {
      return data('/v1/onboarding/verify/complete', {
        method: 'POST', body: { token: payload.token }, maxAttempts: 1,
      }, empty204);
    },

    resendVerification() {
      return data('/v1/onboarding/verify/resend', { method: 'POST', body: {}, maxAttempts: 1 },
        correlationOnly);
    },

    getTerms() { return data('/v1/onboarding/terms', { auth: false }, validTerms); },
    acceptTerms(payload = {}) {
      return data('/v1/onboarding/terms/accept', {
        method: 'POST', body: { version: payload.version }, maxAttempts: 1,
      }, empty204);
    },

    async getProfile() {
      const profile = await getOwnProfile();
      try {
        const publicProjection = await data(`/v1/profile/${encode(profile.accountId)}`, undefined,
          (value) => closed(value, ['accountId', 'displayName', 'createdAt', 'stats', 'presence',
            'correlationId']) && text(value.accountId) && text(value.displayName)
            && iso(value.createdAt) && (value.stats === null || validModeStats(value.stats))
            && (value.presence === null || (closed(value.presence, ['state', 'joinable', 'roomId'])
              && ['online', 'in-lobby', 'in-match'].includes(value.presence.state)
              && bool(value.presence.joinable) && nullableText(value.presence.roomId)))
            && text(value.correlationId));
        return { ...profile, presence: publicProjection.presence ?? null };
      } catch (error) {
        if (error?.code === 'CLIENT_PROTOCOL') throw error;
        // Presence is a privacy-filtered routing hint, never identity authority. An unavailable
        // public projection must not turn a valid cookie refresh into an auth failure.
        return profile;
      }
    },
    importLegacyProgression,
    updateProfile(payload = {}) {
      return data('/v1/profile/me', {
        method: 'PATCH', body: bodyWith(payload, ['displayName', 'privacy']),
        idempotencyKey: payload.idempotencyKey || key('profile'),
      }, validProfile);
    },

    async listRooms(payload = {}) {
      const headers = {};
      if (payload.regionRtt) headers['X-Region-Rtt'] = payload.regionRtt;
      const result = await data(query('/v1/rooms', payload,
        ['region', 'mode', 'hasSpace', 'limit', 'cursor']), { headers }, (value) => closed(value,
        ['items', 'nextCursor', 'correlationId']) && Array.isArray(value.items)
        && value.items.every(validRoomCore) && nullableText(value.nextCursor)
        && text(value.correlationId));
      const fetchedAt = new Date().toISOString();
      const response = { ...result, fetchedAt, items: result.items.map(shellRoom), rooms: result.items.map(shellRoom) };
      // Presence and room cursors are independent opaque namespaces. Load the initial
      // privacy-filtered presence projection once; room pagination must never replay its cursor
      // into the presence endpoint or overwrite a previously valid presence list.
      if (!payload.cursor) {
        response.online = [];
        response.presenceUnavailable = false;
        try {
          const presence = await data(query('/v1/presence/online', payload, ['limit']),
            undefined, validPresencePage);
          response.online = presence.items;
        } catch (error) {
          if (error?.code === 'CLIENT_PROTOCOL') throw error;
          response.presenceUnavailable = true;
        }

        // §11.6's region list, sideloaded like presence and for the same reason: the create
        // form needs it and it is not worth a second round trip on every page.
        //
        // The form used to ask for a free-text region. `yyz`/`ord`/`iad` are datacenter codes
        // no player knows, so typing "Canada" and then "US" produced two VALIDATION_FAILEDs
        // that named nothing acceptable. A closed set the server owns belongs in a dropdown,
        // and §11.6 exists to deliver it.
        //
        // A failure here is NOT fatal to the page — rooms still list and still join. It sets a
        // flag the form reads, so the fallback is a visible explanation rather than an empty
        // dropdown that looks like the deployment has no regions at all.
        response.regions = [];
        response.regionsUnavailable = false;
        try {
          const list = await data('/v1/config/regions', undefined, validRegionList);
          response.regions = list.regions;
        } catch {
          // EVERY failure degrades, including CLIENT_PROTOCOL — deliberately unlike the presence
          // sideload directly above, which rethrows it.
          //
          // Presence is CONTENT of this page; a protocol violation there means what the player
          // is reading is not what the contract describes, and that must be loud. Regions are
          // input options for an optional sub-form. Letting a malformed region list take down
          // the entire room browser — no listing, no joining — would be a far larger outage than
          // the one it reports, and browsing and joining do not depend on it at all.
          //
          // Not silent: `regionsUnavailable` renders as a notice on the form and disables
          // submission, so the failure is visible exactly where it has consequences.
          response.regionsUnavailable = true;
        }
      }
      return response;
    },

    getOnlinePresence(payload = {}) {
      return data(query('/v1/presence/online', payload, ['limit', 'cursor']),
        undefined, validPresencePage);
    },

    createRoom(payload = {}) {
      return data('/v1/rooms', {
        method: 'POST',
        body: bodyWith(payload, ['name', 'region', 'mapId', 'mode', 'capacity', 'password', 'settings']),
        idempotencyKey: payload.idempotencyKey || key('create-room'),
        maxAttempts: 1,
      }, (value) => closed(value, ['room', 'roster', 'countdown', 'reservationId', 'expiresAt',
        'lobbySocketUrl', 'lobbyTicket', 'correlationId']) && validRoomCore(value.room)
        && Array.isArray(value.roster) && value.roster.every(validRoomMember)
        && validCountdown(value.countdown) && text(value.reservationId)
        && iso(value.expiresAt) && text(value.lobbySocketUrl) && text(value.lobbyTicket)
        && text(value.correlationId));
    },

    async getRoom(payload = {}) {
      return shellRoom(await data(`/v1/rooms/${encode(payload.roomId)}`, undefined, validRoomDetail));
    },

    async getLobbySnapshot(payload = {}) {
      const result = await data(`/v1/rooms/${encode(payload.roomId)}`, undefined, validRoomDetail);
      return {
        room: shellRoom(result), members: result.roster, roster: result.roster,
        countdown: result.countdown,
        selfReady: result.roster?.find((member) => member.isLocal)?.ready ?? false,
        correlationId: result.correlationId,
      };
    },

    async joinRoom(payload = {}) {
      const result = await data(`/v1/rooms/${encode(payload.roomId)}/join`, {
        method: 'POST',
        body: { password: payload.password ?? null, preferredTeam: teamValue(payload.preferredTeam) || 'auto' },
        idempotencyKey: payload.idempotencyKey || key('join-room'),
        signal: payload.signal,
      }, reservation);
      // The frozen response is a reservation and does not repeat the path id. The shell needs
      // it for navigation, so retain the already-known request value without claiming a new
      // backend response field.
      return { ...result, roomId: payload.roomId };
    },

    leaveRoom(payload = {}) {
      return data(`/v1/rooms/${encode(payload.roomId)}/leave`, {
        method: 'POST', body: {}, idempotent: true,
      }, empty204);
    },

    setTeam(payload = {}) {
      return data(`/v1/rooms/${encode(payload.roomId)}/team`, {
        method: 'POST', body: { team: teamValue(payload.team) }, maxAttempts: 1,
      }, validRoomDetail);
    },

    setReady(payload = {}) {
      return data(`/v1/rooms/${encode(payload.roomId)}/ready`, {
        method: 'POST', body: { ready: payload.ready }, maxAttempts: 1,
      }, validRoomDetail);
    },

    setLoadout(payload = {}) {
      return data(`/v1/rooms/${encode(payload.roomId)}/loadout`, {
        method: 'POST', body: { primaryIdx: payload.primaryIdx, secondaryIdx: payload.secondaryIdx },
        maxAttempts: 1,
      }, validRoomDetail);
    },

    launchRoom(payload = {}) {
      return data(`/v1/rooms/${encode(payload.roomId)}/launch`, {
        method: 'POST', body: {}, maxAttempts: 1,
      }, correlationOnly);
    },

    reconnectRoom(payload = {}) {
      return data(`/v1/rooms/${encode(payload.roomId)}/reconnect-ticket`, {
        method: 'POST', body: {}, maxAttempts: 1,
      }, (value) => closed(value,
        ['lobbySocketUrl', 'lobbyTicket', 'expiresAt', 'graceEndsAt', 'correlationId'])
        && text(value.lobbySocketUrl) && text(value.lobbyTicket) && iso(value.expiresAt)
        && iso(value.graceEndsAt) && text(value.correlationId));
    },

    async getCareerOverview() {
      const result = await getOwnStats('all');
      if (!result.modes || typeof result.modes !== 'object' || Array.isArray(result.modes)) {
        protocol(result.correlationId);
      }
      // The frozen contract forbids summing modes. Expose them; combined cards stay unavailable.
      return { modes: result.modes, matchesPlayed: null, wins: null, winRate: null,
        correlationId: result.correlationId };
    },

    async getCareerModes() {
      const result = await getOwnStats('all');
      if (!result.modes || typeof result.modes !== 'object' || Array.isArray(result.modes)) {
        protocol(result.correlationId);
      }
      return {
        modes: Object.entries(result.modes).map(([id, stats]) => ({
          id, name: id === 'tdm' ? 'Team deathmatch' : id === 'bomb' ? 'Bomb' : id,
          ...stats.totals,
          winRate: stats.totals.matches ? stats.totals.wins / stats.totals.matches : null,
        })),
        correlationId: result.correlationId,
      };
    },

    async getCareerWeapons() {
      const result = await getOwnStats('all');
      if (!result.modes || typeof result.modes !== 'object' || Array.isArray(result.modes)) {
        protocol(result.correlationId);
      }
      const weapons = [];
      for (const [mode, stats] of Object.entries(result.modes)) {
        for (const [id, counters] of Object.entries(stats.weapons)) {
          weapons.push({
            id: `${mode}:${id}`,
            name: id,
            mode,
            ...counters,
            eliminations: counters.kills,
            accuracy: counters.shots > 0 ? counters.hits / counters.shots : null,
          });
        }
      }
      return { weapons, correlationId: result.correlationId };
    },

    async listMatches(payload = {}) {
      const profile = ownProfile || await getOwnProfile();
      const result = await data(query(`/v1/profile/${encode(profile.accountId)}/matches`, payload,
        ['limit', 'cursor']), undefined, validHistoryPage);
      if (result.items === null) return { ...result, items: null, matches: null };
      return { ...result, items: result.items.map(shellMatch), matches: result.items.map(shellMatch) };
    },

    async getMatch(payload = {}) {
      return shellMatch(await data(`/v1/matches/${encode(payload.matchId)}`, undefined,
        validMatch));
    },

    async getResult(payload = {}) {
      const result = shellMatch(await data(`/v1/matches/${encode(payload.matchId)}`, undefined,
        validMatch));
      return { result, correlationId: result.correlationId };
    },

    getActiveMatch() { return data('/v1/matches/active', undefined, activeMatch); },
    async reconnectMatch(payload = {}) {
      const active = payload.matchId ? { matchId: payload.matchId }
        : await data('/v1/matches/active', undefined, activeMatch);
      if (!active?.matchId) return active;
      return data(`/v1/matches/${encode(active.matchId)}/reconnect-ticket`, {
        method: 'POST', body: {}, maxAttempts: 1,
      }, (value) => closed(value, ['handoff', 'graceEndsAt', 'serverNow', 'correlationId'])
        && validHandoff(value.handoff) && iso(value.graceEndsAt)
        && iso(value.serverNow) && text(value.correlationId));
    },

    async listSessions() {
      const result = await data('/v1/auth/sessions', undefined, validSessions);
      return {
        ...result,
        sessions: result.sessions.map((session) => ({
          ...session, id: session.sessionId, device: session.deviceLabel, current: session.isCurrent,
        })),
      };
    },

    async revokeSession(payload = {}) {
      const result = await data(`/v1/auth/sessions/${encode(payload.sessionId)}`,
        { method: 'DELETE' }, empty204);
      client.session?.announceRevocation?.(payload.sessionId, 'revoked-by-user');
      return result;
    },

    async signOutAll() {
      const result = await client.signOut({ all: true, validateSuccess: empty204 });
      telemetry?.setConsent({ telemetryPersonal: null });
      return result;
    },

    async signOut() {
      const result = await client.signOut({ all: false, validateSuccess: empty204 });
      telemetry?.setConsent({ telemetryPersonal: null });
      return result;
    },

    async getSettings() {
      const response = await client.request('/v1/profile/me/settings');
      if (!validSettings(response.data)) protocol(response.correlationId);
      settingsEtag = response.headers.get('ETag');
      const projection = settingsProjection(response.data, settingsEtag);
      settings?.hydrate?.(response.data);
      return projection;
    },

    async saveSettings(payload = {}) {
      const etag = payload.etag
        || (Number.isInteger(payload.version) ? `"${payload.version}"` : null)
        || settingsEtag;
      try {
        const response = await client.request('/v1/profile/me/settings', {
          method: 'PUT',
          headers: etag ? { 'If-Match': etag } : {},
          body: { schemaVersion: payload.schemaVersion ?? 1, values: payload.values },
        });
        if (!validSettings(response.data)) protocol(response.correlationId);
        settingsEtag = response.headers.get('ETag');
        return settingsProjection(response.data, settingsEtag);
      } catch (error) {
        if (error?.code === 'CONFLICT' && Number.isInteger(error.details?.currentVersion)
          && error.details?.values) {
          settingsEtag = `"${error.details.currentVersion}"`;
          return {
            conflict: true,
            current: settingsProjection({
              schemaVersion: payload.schemaVersion ?? 1,
              version: error.details.currentVersion,
              values: error.details.values,
              updatedAt: null,
              correlationId: error.correlationId,
            }, `"${error.details.currentVersion}"`),
          };
        }
        throw error;
      }
    },
  };

  return Object.freeze({
    ...operations,
    perform(operation, payload) {
      const fn = operations[operation];
      if (typeof fn !== 'function') throw new TypeError(`Unknown shell operation: ${operation}`);
      return fn(payload);
    },
  });
}
