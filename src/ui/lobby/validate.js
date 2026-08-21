/** Contract validators for realtime-lobby.md 1.8.0. */

import { PLATFORM_ERROR_CODES, PLATFORM_ERROR_SPECS } from '../platform/errors.js';

export class LobbyProtocolError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LobbyProtocolError';
    this.code = 'CLIENT_PROTOCOL';
    this.details = details;
  }
}

const ROOM_KEYS = ['roomId', 'name', 'region', 'mapId', 'mapVersion', 'mode',
  'rulesetVersion', 'build', 'status', 'capacity', 'playerCount', 'joinable',
  'joinBlockedReason', 'hasPassword', 'ownerAccountId', 'estimatedRttMs', 'settings'];
const ROOM_MUTABLE_KEYS = new Set([
  'name', 'status', 'capacity', 'playerCount', 'joinable', 'joinBlockedReason',
  'settings', 'ownerAccountId',
]);
const SETTINGS_KEYS = ['killLimit', 'roundsToWin', 'maxRounds', 'roundLengthSec',
  'backfill', 'requiredReady', 'minPlayers'];
const MEMBER_KEYS = ['accountId', 'displayName', 'team', 'ready', 'isOwner', 'isLocal',
  'connection', 'estimatedRttMs', 'loadout', 'joinedAt'];
const LOADOUT_KEYS = ['primaryIdx', 'secondaryIdx'];
const COUNTDOWN_KEYS = ['endsAt', 'requiredReady', 'currentReady'];
const CHAT_KEYS = ['id', 'accountId', 'displayName', 'text', 'ts', 'filtered'];
const ENVELOPE_KEYS = ['t', 'seq', 'ts', 'correlationId', 'd'];
const PING_KINDS = ['attack-a', 'attack-b', 'defend-a', 'defend-b', 'regroup', 'enemy-spotted'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value) => typeof value === 'string' && value.length > 0;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const UTC_MILLIS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isId = (value) => typeof value === 'string' && ULID_RE.test(value);
const isIso = (value) => {
  if (typeof value !== 'string' || !UTC_MILLIS_RE.test(value)) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
};
const isInt = (value, min = 0) => Number.isInteger(value) && value >= min;
const nullable = (value, predicate) => value === null || predicate(value);
const oneOf = (value, values) => values.includes(value);
const ERROR_CODES = new Set(PLATFORM_ERROR_CODES);

function fail(path, rule, value) {
  throw new LobbyProtocolError(`Invalid lobby payload at ${path}: expected ${rule}.`, {
    path, rule, value,
  });
}

function exactKeys(value, required, optional = [], path = 'value') {
  if (!isObject(value)) fail(path, 'object', value);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${path}.${key}`, 'required', undefined);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, 'closed-key', value[key]);
  return value;
}

function loadout(value, path) {
  exactKeys(value, LOADOUT_KEYS, [], path);
  if (!isInt(value.primaryIdx) || !isInt(value.secondaryIdx)) fail(path, 'non-negative loadout indices', value);
}

function roomSettings(value, mode, path) {
  exactKeys(value, SETTINGS_KEYS, [], path);
  for (const key of ['requiredReady', 'minPlayers']) if (!isInt(value[key], 1)) fail(`${path}.${key}`, 'positive integer', value[key]);
  if (typeof value.backfill !== 'boolean') fail(`${path}.backfill`, 'boolean', value.backfill);
  if (mode === 'tdm') {
    if (!isInt(value.killLimit, 1)) fail(`${path}.killLimit`, 'positive integer', value.killLimit);
    for (const key of ['roundsToWin', 'maxRounds', 'roundLengthSec']) if (value[key] !== null) fail(`${path}.${key}`, 'null for tdm', value[key]);
  } else {
    if (value.killLimit !== null) fail(`${path}.killLimit`, 'null for bomb', value.killLimit);
    for (const key of ['roundsToWin', 'maxRounds', 'roundLengthSec']) if (!isInt(value[key], 1)) fail(`${path}.${key}`, 'positive integer', value[key]);
    if (value.backfill !== false) fail(`${path}.backfill`, 'false for bomb', value.backfill);
  }
}

/** Cross-component invariants shared by welcome/snapshot validation and delta reduction. */
export function validateRosterProjection({ you, room, roster }, path = 'lobby') {
  if (!isObject(you) || !isObject(room) || !Array.isArray(roster)) {
    fail(path, 'room/you/roster projection', { you, room, roster });
  }
  const ids = new Set(roster.map((item) => item.accountId));
  if (ids.size !== roster.length || room.playerCount !== roster.length) {
    fail(`${path}.roster`, 'unique complete roster matching playerCount', roster);
  }
  const self = roster.find((item) => item.accountId === you.accountId);
  if (!self || self.team !== you.team || self.ready !== you.ready || self.isOwner !== you.isOwner) {
    fail(`${path}.you`, 'projection matching roster member', you);
  }
  const localRows = roster.filter((item) => item.isLocal);
  const ownerRows = roster.filter((item) => item.isOwner);
  if (localRows.length !== 1 || localRows[0].accountId !== you.accountId) {
    fail(`${path}.roster`, 'exactly one local member matching you', roster);
  }
  if (ownerRows.length !== 1 || ownerRows[0].accountId !== room.ownerAccountId) {
    fail(`${path}.roster`, 'exactly one owner matching RoomCore', roster);
  }
  return { self, local: localRows[0], owner: ownerRows[0] };
}

export function validateRoomCore(value, path = 'room') {
  exactKeys(value, ROOM_KEYS, [], path);
  for (const key of ['name', 'region', 'mapId', 'mapVersion', 'rulesetVersion', 'build']) {
    if (!isString(value[key])) fail(`${path}.${key}`, 'non-empty string', value[key]);
  }
  for (const key of ['roomId', 'ownerAccountId']) if (!isId(value[key])) fail(`${path}.${key}`, 'ULID', value[key]);
  if (!oneOf(value.mode, ['tdm', 'bomb'])) fail(`${path}.mode`, 'tdm|bomb', value.mode);
  if (!oneOf(value.status, ['open', 'countdown', 'in-progress', 'closing'])) fail(`${path}.status`, 'room status', value.status);
  if (!isInt(value.capacity, 1) || !isInt(value.playerCount) || value.playerCount > value.capacity) fail(path, 'valid capacity/playerCount', value);
  if (typeof value.joinable !== 'boolean' || typeof value.hasPassword !== 'boolean') fail(path, 'boolean joinable/hasPassword', value);
  if (!nullable(value.joinBlockedReason, (item) => oneOf(item, ['full', 'in-progress', 'closing', 'password', 'sanctioned', 'region-restricted', 'build-mismatch', 'banned-from-room']))) {
    fail(`${path}.joinBlockedReason`, 'closed reason|null', value.joinBlockedReason);
  }
  if (!nullable(value.estimatedRttMs, (item) => Number.isFinite(item) && item >= 0 && item <= 5000)) fail(`${path}.estimatedRttMs`, 'measured milliseconds|null', value.estimatedRttMs);
  roomSettings(value.settings, value.mode, `${path}.settings`);
  if (value.settings.requiredReady > value.capacity || value.settings.minPlayers > value.capacity) {
    fail(`${path}.settings`, 'readiness/minimum not exceeding capacity', value.settings);
  }
  return value;
}

export function validateRoomPatch(value, path = 'room.updated.d') {
  if (!isObject(value)) fail(path, 'object', value);
  if (Object.keys(value).length === 0) fail(path, 'non-empty patch', value);
  for (const key of Object.keys(value)) if (!ROOM_MUTABLE_KEYS.has(key)) fail(`${path}.${key}`, 'mutable RoomCore key', value[key]);
  if (Object.hasOwn(value, 'name') && !isString(value.name)) fail(`${path}.name`, 'non-empty string', value.name);
  if (Object.hasOwn(value, 'status') && !oneOf(value.status, ['open', 'countdown', 'in-progress', 'closing'])) fail(`${path}.status`, 'room status', value.status);
  for (const key of ['capacity', 'playerCount']) if (Object.hasOwn(value, key) && !isInt(value[key], key === 'capacity' ? 1 : 0)) fail(`${path}.${key}`, 'integer', value[key]);
  if (Object.hasOwn(value, 'joinable') && typeof value.joinable !== 'boolean') fail(`${path}.joinable`, 'boolean', value.joinable);
  if (Object.hasOwn(value, 'ownerAccountId') && !isId(value.ownerAccountId)) fail(`${path}.ownerAccountId`, 'ULID', value.ownerAccountId);
  if (Object.hasOwn(value, 'joinBlockedReason')
    && !nullable(value.joinBlockedReason, (item) => oneOf(item, ['full', 'in-progress', 'closing', 'password', 'sanctioned', 'region-restricted', 'build-mismatch', 'banned-from-room']))) {
    fail(`${path}.joinBlockedReason`, 'closed reason|null', value.joinBlockedReason);
  }
  if (Object.hasOwn(value, 'settings')) {
    const inferredMode = value.settings?.killLimit === null ? 'bomb' : 'tdm';
    roomSettings(value.settings, inferredMode, `${path}.settings`);
  }
  return value;
}

export function validateRosterMember(value, path = 'member') {
  exactKeys(value, MEMBER_KEYS, [], path);
  if (!isId(value.accountId) || !isString(value.displayName)) fail(path, 'member identity', value);
  if (!oneOf(value.team, ['alpha', 'bravo', 'unassigned'])) fail(`${path}.team`, 'team', value.team);
  if (typeof value.ready !== 'boolean' || typeof value.isOwner !== 'boolean' || typeof value.isLocal !== 'boolean') fail(path, 'member booleans', value);
  if (!oneOf(value.connection, ['connected', 'reconnecting', 'disconnected'])) fail(`${path}.connection`, 'connection state', value.connection);
  if (!nullable(value.estimatedRttMs, (item) => Number.isFinite(item) && item >= 0 && item <= 5000)) fail(`${path}.estimatedRttMs`, 'milliseconds|null', value.estimatedRttMs);
  loadout(value.loadout, `${path}.loadout`);
  if (!isIso(value.joinedAt)) fail(`${path}.joinedAt`, 'ISO timestamp', value.joinedAt);
  return value;
}

export function validateCountdown(value, path = 'countdown') {
  if (value === null) return value;
  exactKeys(value, COUNTDOWN_KEYS, [], path);
  if (!isIso(value.endsAt) || !isInt(value.requiredReady, 1) || !isInt(value.currentReady)) fail(path, 'CountdownState', value);
  return value;
}

export function validateChatMessage(value, path = 'chat') {
  exactKeys(value, CHAT_KEYS, [], path);
  if (!isId(value.id) || !isId(value.accountId) || !isString(value.displayName) || typeof value.text !== 'string') fail(path, 'chat identity/strings', value);
  if (value.text.length > 200 || !isIso(value.ts) || typeof value.filtered !== 'boolean') fail(path, 'ChatMessage', value);
  return value;
}

function validateError(value, path) {
  exactKeys(value, ['error'], [], path);
  exactKeys(value.error, ['code', 'message', 'correlationId', 'retryable', 'retryAfterMs', 'details'], [], `${path}.error`);
  const error = value.error;
  const expectedRetryable = PLATFORM_ERROR_SPECS[error.code]?.[1];
  if (!ERROR_CODES.has(error.code) || typeof error.message !== 'string' || !isId(error.correlationId)
    || error.retryable !== expectedRetryable || !nullable(error.retryAfterMs, isInt)
    || (!error.retryable && error.retryAfterMs !== null) || !isObject(error.details)) fail(path, 'error envelope', value);
}

function validateSnapshot(value, path) {
  exactKeys(value, ['protocol', 'serverTime', 'heartbeatMs', 'graceMs', 'you', 'room', 'roster',
    'countdown', 'chatHistory', 'mutedAccountIds', 'pingCatalog', 'loadoutCatalog'], [], path);
  if (value.protocol !== 1 || !isIso(value.serverTime) || !isInt(value.heartbeatMs, 1) || !isInt(value.graceMs, 1)) fail(path, 'lobby snapshot metadata', value);
  exactKeys(value.you, ['accountId', 'team', 'ready', 'isOwner', 'seatHeldUntil'], [], `${path}.you`);
  if (!isId(value.you.accountId) || !oneOf(value.you.team, ['alpha', 'bravo', 'unassigned'])
    || typeof value.you.ready !== 'boolean' || typeof value.you.isOwner !== 'boolean'
    || !nullable(value.you.seatHeldUntil, isIso)) fail(`${path}.you`, 'connection member', value.you);
  validateRoomCore(value.room, `${path}.room`);
  if (!Array.isArray(value.roster)) fail(`${path}.roster`, 'array', value.roster);
  value.roster.forEach((item, index) => validateRosterMember(item, `${path}.roster[${index}]`));
  validateRosterProjection(value, path);
  validateCountdown(value.countdown, `${path}.countdown`);
  if (value.countdown) {
    const readyCount = value.roster.filter((item) => item.ready).length;
    if (readyCount !== value.countdown.currentReady) {
      fail(`${path}.countdown.currentReady`, 'ready roster count', value.countdown.currentReady);
    }
  }
  if (!Array.isArray(value.chatHistory) || value.chatHistory.length > 50) fail(`${path}.chatHistory`, 'array <= 50', value.chatHistory);
  value.chatHistory.forEach((item, index) => validateChatMessage(item, `${path}.chatHistory[${index}]`));
  if (!Array.isArray(value.mutedAccountIds) || !value.mutedAccountIds.every(isId)
    || new Set(value.mutedAccountIds).size !== value.mutedAccountIds.length
    || value.mutedAccountIds.includes(value.you.accountId)) fail(`${path}.mutedAccountIds`, 'unique non-self account ULIDs', value.mutedAccountIds);
  exactKeys(value.pingCatalog, ['version', 'kinds'], [], `${path}.pingCatalog`);
  if (value.pingCatalog.version !== 1 || !Array.isArray(value.pingCatalog.kinds)
    || value.pingCatalog.kinds.length !== PING_KINDS.length
    || PING_KINDS.some((kind) => !value.pingCatalog.kinds.includes(kind))) fail(`${path}.pingCatalog`, 'closed ping catalog v1', value.pingCatalog);
  exactKeys(value.loadoutCatalog, ['version', 'primary', 'secondary'], [], `${path}.loadoutCatalog`);
  if (!isString(value.loadoutCatalog.version)) fail(`${path}.loadoutCatalog.version`, 'non-empty string', value.loadoutCatalog.version);
  for (const slot of ['primary', 'secondary']) {
    const items = value.loadoutCatalog[slot];
    if (!Array.isArray(items) || items.length < 1) fail(`${path}.loadoutCatalog.${slot}`, 'non-empty catalog', items);
    const indices = new Set();
    for (let i = 0; i < items.length; i++) {
      exactKeys(items[i], ['idx', 'label', 'eligible'], [], `${path}.loadoutCatalog.${slot}[${i}]`);
      if (!isInt(items[i].idx) || indices.has(items[i].idx) || !isString(items[i].label)
        || typeof items[i].eligible !== 'boolean') fail(`${path}.loadoutCatalog.${slot}[${i}]`, 'unique loadout item', items[i]);
      indices.add(items[i].idx);
    }
    const selected = value.roster.find((item) => item.isLocal)?.loadout?.[`${slot}Idx`];
    if (!items.some((item) => item.idx === selected && item.eligible)) fail(`${path}.loadoutCatalog.${slot}`, 'eligible local selection', selected);
  }
}

function validatePingTarget(value, path) {
  exactKeys(value, ['kind'], value?.kind === 'site' ? ['site'] : ['x', 'y', 'z'], path);
  if (value.kind === 'site') {
    exactKeys(value, ['kind', 'site'], [], path);
    if (!oneOf(value.site, ['A', 'B'])) fail(`${path}.site`, 'A|B', value.site);
  } else if (value.kind === 'world') {
    exactKeys(value, ['kind', 'x', 'y', 'z'], [], path);
    if (!['x', 'y', 'z'].every((key) => Number.isFinite(value[key]) && Math.abs(value[key]) <= 1000)) fail(path, 'bounded world vector', value);
  } else fail(`${path}.kind`, 'site|world', value.kind);
}

function validateHandoff(value, path) {
  const keys = ['matchId', 'serverUrl', 'sessionTicket', 'expiresAt', 'reconnectGraceMs',
    'mapId', 'mapVersion', 'mode', 'rulesetVersion', 'region', 'serverBuild',
    'protocolVersion', 'series', 'spectatorPolicyVersion', 'sites'];
  exactKeys(value, keys, [], path);
  for (const key of ['serverUrl', 'sessionTicket', 'mapId', 'mapVersion', 'mode', 'rulesetVersion', 'region', 'serverBuild']) {
    if (!isString(value[key])) fail(`${path}.${key}`, 'non-empty string', value[key]);
  }
  if (!isId(value.matchId)) fail(`${path}.matchId`, 'ULID', value.matchId);
  let serverUrl = null;
  try { serverUrl = new URL(value.serverUrl); } catch { /* reported below */ }
  const loopbackWs = serverUrl?.protocol === 'ws:'
    && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(serverUrl.hostname);
  if (serverUrl?.protocol !== 'wss:' && !loopbackWs) fail(`${path}.serverUrl`, 'wss URL (or loopback ws)', value.serverUrl);
  if (!oneOf(value.mode, ['tdm', 'bomb'])) fail(`${path}.mode`, 'tdm or bomb', value.mode);
  if (!isIso(value.expiresAt) || !isInt(value.reconnectGraceMs, 1)
    || !isInt(value.protocolVersion, 1) || !isInt(value.spectatorPolicyVersion, 1)
    || !isObject(value.series) || !Array.isArray(value.sites)) fail(path, 'MatchHandoff', value);
  exactKeys(value.series, ['roundsToWin', 'maxRounds', 'sideSwitchAfter', 'overtime'], [], `${path}.series`);
  if (!isInt(value.series.roundsToWin, 1) || !isInt(value.series.maxRounds, 1)
    || !isInt(value.series.sideSwitchAfter, 1) || typeof value.series.overtime !== 'boolean') fail(`${path}.series`, 'series policy', value.series);
  for (let i = 0; i < value.sites.length; i++) {
    const site = value.sites[i];
    exactKeys(site, ['id', 'site', 'callout', 'center', 'box'], [], `${path}.sites[${i}]`);
    if (!isString(site.id) || !oneOf(site.site, ['A', 'B']) || !isString(site.callout)
      || !isObject(site.center) || !isObject(site.box)
      || !['x', 'y', 'z'].every((key) => Number.isFinite(site.center[key]))) fail(`${path}.sites[${i}]`, 'site descriptor', site);
    exactKeys(site.center, ['x', 'y', 'z'], [], `${path}.sites[${i}].center`);
    exactKeys(site.box, ['min', 'max'], [], `${path}.sites[${i}].box`);
    for (const edge of ['min', 'max']) {
      exactKeys(site.box[edge], ['x', 'y', 'z'], [], `${path}.sites[${i}].box.${edge}`);
      if (!['x', 'y', 'z'].every((key) => Number.isFinite(site.box[edge][key]))) fail(`${path}.sites[${i}].box.${edge}`, 'finite vector', site.box[edge]);
    }
  }
}

/** Validate a known frame. Unknown types are returned as `{ known:false }` per §2. */
export function validateLobbyFrame(frame) {
  exactKeys(frame, ENVELOPE_KEYS, [], 'frame');
  if (!isString(frame.t) || !isInt(frame.seq) || !isIso(frame.ts) || !isId(frame.correlationId) || !isObject(frame.d)) fail('frame', 'lobby envelope', frame);
  const path = `${frame.t}.d`;
  const d = frame.d;
  switch (frame.t) {
    case 'lobby.welcome':
    case 'state.snapshot': validateSnapshot(d, path); break;
    case 'roster.delta':
      exactKeys(d, ['added', 'updated', 'removed'], [], path);
      if (!Array.isArray(d.added) || !Array.isArray(d.updated) || !Array.isArray(d.removed)) fail(path, 'roster delta arrays', d);
      d.added.forEach((item, i) => validateRosterMember(item, `${path}.added[${i}]`));
      d.updated.forEach((item, i) => validateRosterMember(item, `${path}.updated[${i}]`));
      if (!d.removed.every(isId)) fail(`${path}.removed`, 'account ULIDs', d.removed);
      break;
    case 'presence.delta':
      exactKeys(d, ['accountId', 'state', 'joinable', 'roomId'], [], path);
      if (!isId(d.accountId) || !oneOf(d.state, ['online', 'in-lobby', 'in-match', 'offline'])
        || typeof d.joinable !== 'boolean' || !nullable(d.roomId, isId)) fail(path, 'presence delta', d);
      break;
    case 'room.updated': validateRoomPatch(d, path); break;
    case 'team.changed':
      exactKeys(d, ['accountId', 'team', 'byServer'], [], path);
      if (!isId(d.accountId) || !oneOf(d.team, ['alpha', 'bravo', 'unassigned']) || typeof d.byServer !== 'boolean') fail(path, 'team change', d);
      break;
    case 'ready.changed':
      exactKeys(d, ['accountId', 'ready'], ['clearedReason'], path);
      if (!isId(d.accountId) || typeof d.ready !== 'boolean'
        || (Object.hasOwn(d, 'clearedReason') && !oneOf(d.clearedReason, ['roster-change', 'team-change', 'loadout-change', 'room-change']))) fail(path, 'ready change', d);
      break;
    case 'countdown.started': validateCountdown({ endsAt: d.endsAt, requiredReady: d.requiredReady, currentReady: d.currentReady }, path); exactKeys(d, COUNTDOWN_KEYS, [], path); break;
    case 'countdown.tick': exactKeys(d, ['remainingMs'], [], path); if (!isInt(d.remainingMs)) fail(`${path}.remainingMs`, 'non-negative integer', d.remainingMs); break;
    case 'countdown.aborted':
      exactKeys(d, ['reason'], ['byAccountId'], path);
      if (!oneOf(d.reason, ['player-left', 'player-unready', 'team-imbalance', 'allocation-failed', 'owner-cancelled'])
        || (Object.hasOwn(d, 'byAccountId') && !isId(d.byAccountId))) fail(path, 'countdown abort', d);
      break;
    case 'match.allocating': exactKeys(d, [], [], path); break;
    case 'match.ready': validateHandoff(d, path); break;
    case 'match.failed': validateError(d, path); break;
    case 'chat.message': validateChatMessage(d, path); break;
    case 'chat.removed': exactKeys(d, ['id', 'reason'], [], path); if (!isId(d.id) || !isString(d.reason)) fail(path, 'chat removal', d); break;
    case 'ping.placed':
      exactKeys(d, ['accountId', 'kind'], ['target'], path);
      if (!isId(d.accountId) || !PING_KINDS.includes(d.kind)) fail(path, 'closed ping kind', d);
      if (Object.hasOwn(d, 'target')) validatePingTarget(d.target, `${path}.target`);
      break;
    case 'mute.changed':
      exactKeys(d, ['accountId', 'muted'], [], path);
      if (!isId(d.accountId) || typeof d.muted !== 'boolean') fail(path, 'mute projection', d);
      break;
    case 'error': validateError(d, path); break;
    case 'heartbeat': exactKeys(d, ['serverTime'], [], path); if (!isIso(d.serverTime)) fail(`${path}.serverTime`, 'ISO timestamp', d.serverTime); break;
    default: return { known: false, frame };
  }
  if (frame.t === 'lobby.welcome' && frame.seq !== 0) fail('frame.seq', '0 for lobby.welcome', frame.seq);
  if ((frame.t === 'error' || frame.t === 'match.failed') && d.error.correlationId !== frame.correlationId) {
    fail(`${path}.error.correlationId`, 'same as frame correlationId', d.error.correlationId);
  }
  return { known: true, frame };
}

export const LOBBY_ROOM_MUTABLE_KEYS = Object.freeze([...ROOM_MUTABLE_KEYS]);
