/**
 * P2 presence, rooms, reports and realtime lobby.
 *
 * Room/member/report state is persisted in the configured Store. Alpha deliberately runs one
 * socket authority (fly.platform.toml) until P5 adds brokered cross-instance fanout.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { ApiError } from '../../core/errors.js';
import { raw } from '../../core/http.js';
import { ulid, isUlid } from '../../core/ids.js';
import { LIVE_LOADOUT_CATALOG, publicLoadoutCatalog } from '../../shared/liveCatalog.js';
import { evidenceDigest } from '../../shared/evidenceDigest.js';
import { parseTraceparent, traceparentForCorrelation } from '../../core/observability.js';

const RESERVATION_MS = 30_000;
const GRACE_MS = 90_000;
const HEARTBEAT_MS = 15_000;
const CHAT_WINDOW_MS = 30_000;
const CHAT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const REPORT_CATEGORIES = new Set(['cheating', 'harassment', 'offensive-name', 'griefing', 'other']);
const PING_KINDS = new Set(['attack-a', 'attack-b', 'defend-a', 'defend-b', 'regroup', 'enemy-spotted']);
const VALID_CLIENT_TYPES = new Set(['team.request', 'ready.set', 'loadout.set', 'launch.request',
  'chat.send', 'ping.send', 'mute.set', 'state.resync', 'heartbeat.ack', 'leave']);
const PING_CATALOG = Object.freeze({ version: 1, kinds: [...PING_KINDS] });
const LOADOUT_CATALOG = Object.freeze(publicLoadoutCatalog());
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

const iso = (ms) => new Date(ms).toISOString();
const token = () => randomBytes(32).toString('base64url');
export const roomPasswordHash = (value, secret) => value === null || value === undefined ? null
  : createHmac('sha256', secret).update(String(value)).digest('hex');
export function verifyRoomPassword(value, expected, secret) {
  if (typeof expected !== 'string') return false;
  const actual = Buffer.from(roomPasswordHash(value, secret), 'hex');
  const wanted = Buffer.from(expected, 'hex');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
const clone = (value) => structuredClone(value);
const requestHash = (method, path, body) => createHash('sha256')
  .update(JSON.stringify([method, path, body || {}])).digest('hex');

export async function localChatModerator(value) {
  if (typeof value !== 'string') throw failValidation('Chat is 1–200 characters.', 'text');
  const text = value.normalize('NFKC').replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
    .replace(/\s+/g, ' ').trim();
  if (!text || text.length > 200 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw failValidation('Chat is 1–200 printable characters.', 'text');
  }
  const screened = text.toLocaleLowerCase('en-US')
    .replace(/[013457@]/g, (char) => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a' })[char])
    .replace(/[аɑ]/gu, 'a').replace(/[еҽ]/gu, 'e').replace(/[іӏ]/gu, 'i').replace(/[оο]/gu, 'o');
  if (/\b(?:https?:\/\/|www\.)\S+/iu.test(screened)
    || /\bk+i+l+l+\s*y+o+u+r+s+e+l+f+\b/iu.test(screened)
    || /\bd+o+x+x?\b/iu.test(screened)
    || /\bn+i+g+g+\w*\b/iu.test(screened) || /\bf+a+g+g+\w*\b/iu.test(screened)) {
    return { decision: 'reject', text: null, policyVersion: 'alpha-chat-1' };
  }
  const redacted = text.replace(/\b(?:fuck|shit)\w*\b/giu, '[redacted]');
  return { decision: redacted === text ? 'allow' : 'redact', text: redacted,
    policyVersion: 'alpha-chat-1' };
}

function idempotencyKey(ctx) {
  const key = String(ctx.headers?.['idempotency-key'] || '').trim();
  if (!key || key.length > 128) throw failValidation('Idempotency-Key is required and must be at most 128 characters.', 'Idempotency-Key');
  return key;
}
const failValidation = (message, path = null) => new ApiError('VALIDATION_FAILED', message, {
  details: path ? { fields: [{ path, rule: 'invalid', message }] } : {},
});

function parseLimit(query) {
  const limit = query.get('limit') === null ? 25 : Number(query.get('limit'));
  const cursor = query.get('cursor') === null ? 0 : Number(query.get('cursor'));
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw failValidation('limit must be 1–100.', 'limit');
  if (!Number.isInteger(cursor) || cursor < 0) throw failValidation('cursor is invalid.', 'cursor');
  return { limit, cursor };
}

function parseRtt(value) {
  if (typeof value !== 'string' || !value) return null;
  const pairs = value.split(',');
  if (pairs.length > 8) return null;
  const out = {};
  for (const pair of pairs) {
    const match = /^([a-z]{2,8})=(\d{1,4})$/.exec(pair);
    if (!match || Number(match[2]) > 5000) return null;
    out[match[1]] = Number(match[2]);
  }
  return out;
}

function roomSettings(mode, capacity, supplied = {}) {
  const requiredReady = supplied.requiredReady ?? Math.min(2, capacity);
  const minPlayers = supplied.minPlayers ?? Math.min(2, capacity);
  if (!Number.isInteger(requiredReady) || requiredReady < 1 || requiredReady > capacity
    || !Number.isInteger(minPlayers) || minPlayers < 1 || minPlayers > capacity) {
    throw failValidation('Room readiness settings exceed capacity.', 'settings');
  }
  if (mode === 'bomb') return {
    killLimit: null, roundsToWin: 7, maxRounds: 12, roundLengthSec: 105,
    backfill: false, requiredReady, minPlayers,
  };
  return {
    killLimit: supplied.killLimit ?? 75, roundsToWin: null, maxRounds: null,
    roundLengthSec: null, backfill: supplied.backfill ?? true, requiredReady, minPlayers,
  };
}

function publicSocketUrl(ctx, config) {
  if (config.lobbyPublicUrl) return config.lobbyPublicUrl.replace(/\/$/, '') + '/v1/lobby';
  const host = String(ctx.headers['x-forwarded-host'] || ctx.headers.host || '127.0.0.1:8090').split(',')[0].trim();
  const forwarded = String(ctx.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = forwarded === 'https' || (!forwarded && !/^(localhost|127\.0\.0\.1|\[::1\])(?::|$)/.test(host));
  return `${secure ? 'wss' : 'ws'}://${host}/v1/lobby`;
}

function envelope(error, correlationId) {
  return error.toEnvelope(correlationId);
}

/** A compact HMAC ticket the dedicated server can verify without a platform round-trip. */
export function issueMatchTicket(secret, claims) {
  const mode = claims.mode === 'bomb' ? 'b' : claims.mode === 'tdm' ? 't' : '-';
  const team = claims.team === 'alpha' ? 'a' : claims.team === 'bravo' ? 'b' : 'u';
  const payload = ['1', claims.jti, claims.sub, claims.roomId, claims.matchId,
    Math.trunc(claims.exp).toString(36), mode, team,
    Number(claims.primaryIdx ?? 0).toString(36), Number(claims.secondaryIdx ?? 0).toString(36)].join('~');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function createLobbyModule({ store, config, logger, clock = Date.now, auth, flags = null,
  visibilityFor = null, outbox = null, resultApplier = null, observability = null,
  chatModerator = null }) {
  if (typeof auth !== 'function') throw new Error('lobby: authenticated route middleware is required');
  if (!outbox || typeof outbox.commit !== 'function') throw new Error('lobby: transactional outbox is required');
  if (typeof chatModerator !== 'function') throw new Error('lobby: explicit chat moderation provider is required');
  const rooms = new Map();
  const tickets = new Map();
  const presence = new Map();
  const reports = new Map();
  const reportKeys = new Set();
  const matchTickets = new Map();
  const matches = new Map();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 4096,
    // The second offered subprotocol carries the one-use credential. It authenticates the
    // upgrade but is never reflected as the negotiated protocol where browser code, tooling,
    // and proxy access logs could retain it.
    handleProtocols: (protocols) => protocols.has('overstrike-lobby-v1')
      ? 'overstrike-lobby-v1' : false });
  let attachedServer = null;
  let heartbeatTimer = null;

  const now = () => Number(clock());
  const id = () => ulid(now());
  const A = { middleware: [auth] };
  const ROOM = { middleware: [auth], rateLimitClass: 'room' };
  const REPORT = { middleware: [auth], rateLimitClass: 'report' };
  let hydration = null;

  async function ensureHydrated() {
    if (!hydration) hydration = (async () => {
      if (!store.rooms?.list || !store.roomMembers?.listForRoom) return;
      for (const row of await store.rooms.list()) {
        if (!row.name || !row.mapVersion || !row.rulesetVersion || !row.build) continue;
        // A countdown safely reopens after restart. An in-progress room is restored only when
        // its durable allocated/in-progress match row exists; this prevents both zombies and
        // deletion of a live authority merely because the control plane restarted.
        const activeMatch = row.status === 'in-progress'
          ? await store.matches?.activeForRoom?.(row.roomId) : null;
        const terminalMatch = ['in-progress', 'closing'].includes(row.status) && !activeMatch
          ? await store.matches?.latestTerminalForRoom?.(row.roomId) : null;
        if (row.status === 'in-progress' && !activeMatch && !terminalMatch) { await store.rooms.remove(row.roomId); continue; }
        const persistedMembers = await store.roomMembers.listForRoom(row.roomId);
        if (!persistedMembers.length && !activeMatch && !terminalMatch) { await store.rooms.remove(row.roomId); continue; }
        const room = {
          roomId: row.roomId, name: row.name, region: row.region, mapId: row.mapId,
          mapVersion: row.mapVersion, mode: row.mode, rulesetVersion: row.rulesetVersion,
          build: row.build, status: row.status === 'countdown' ? 'open' : row.status,
          capacity: row.capacity, passwordHash: row.passwordHash ?? null,
          ownerAccountId: row.ownerAccountId, settings: row.settings,
          members: new Map(), pending: new Set(), connections: new Map(), countdown: null,
          chat: [], createdAt: Date.parse(row.createdAt) || now(),
        };
        for (const message of await store.chatMessages?.listForRoom?.(row.roomId, 50, iso(now())) || []) {
          const sender = await accountProjection(message.senderAccountId);
          room.chat.push({ id: message.messageId, accountId: message.senderAccountId,
            displayName: sender.displayName, text: message.text, ts: message.createdAt, filtered: true });
        }
        const persistedIds = new Set(persistedMembers.map((member) => member.accountId));
        const authorityMatch = activeMatch ?? terminalMatch;
        const frozenMissing = await Promise.all((authorityMatch?.participants || [])
          .filter((participant) => !persistedIds.has(participant.accountId)).map(async (participant) => ({
            accountId: participant.accountId,
            displayName: (await accountProjection(participant.accountId)).displayName,
            team: participant.team, ready: false, isOwner: participant.accountId === row.ownerAccountId,
            connection: 'reconnecting', disconnectedAt: now(), estimatedRttMs: null,
            loadout: participant.stats?.loadout || { primaryIdx: 0, secondaryIdx: 0 },
            joinedAt: participant.joinedAt, mutedAccountIds: [],
          })));
        const hydrationMembers = [...persistedMembers, ...frozenMissing];
        for (const saved of hydrationMembers) {
          room.members.set(saved.accountId, {
            accountId: saved.accountId, displayName: saved.displayName,
            team: saved.team || 'unassigned', ready: row.status === 'countdown' ? false : saved.ready,
            isOwner: saved.isOwner, connection: 'reconnecting', disconnectedAt: now(),
            estimatedRttMs: saved.estimatedRttMs ?? null,
            loadout: saved.loadout || { primaryIdx: 0, secondaryIdx: 0 },
            joinedAt: saved.joinedAt, muted: new Set(saved.mutedAccountIds || []), chatTimes: [], pingTimes: [], lastAckAt: now(),
          });
        }
        rooms.set(room.roomId, room);
        if (authorityMatch) {
          const registeredServer = authorityMatch.serverId
            ? await store.matchServers?.byId?.(authorityMatch.serverId) : null;
          matches.set(authorityMatch.matchId, {
            matchId: authorityMatch.matchId, roomId: room.roomId,
            serverId: authorityMatch.serverId ?? registeredServer?.serverId ?? null,
            serverUrl: registeredServer?.address ?? config.matchServerUrl,
            accountIds: new Set(authorityMatch.participants.map((item) => item.accountId)), room,
            graceEnds: new Map(), startedAt: Date.parse(authorityMatch.startedAt) || now(),
            endedAt: null, healthMisses: 0, terminalCommitted: Boolean(terminalMatch),
            correlationId: authorityMatch.matchId,
          });
        }
        await persistRoom(room);
      }
    })();
    return hydration;
  }

  function persistedRoom(room) {
    return {
      roomId: room.roomId, ownerAccountId: room.ownerAccountId, name: room.name,
      region: room.region, mapId: room.mapId, mapVersion: room.mapVersion, mode: room.mode,
      rulesetVersion: room.rulesetVersion, build: room.build, capacity: room.capacity,
      status: room.status, settings: clone(room.settings), passwordHash: room.passwordHash ?? null,
      destroyedAt: null, destroyedReason: null,
    };
  }

  function persistedMember(room, member) {
    return {
      roomId: room.roomId, accountId: member.accountId, displayName: member.displayName,
      team: member.team, ready: member.ready, isOwner: member.isOwner,
      connection: member.connection, disconnectedAt: member.disconnectedAt == null ? null
        : (typeof member.disconnectedAt === 'number' ? iso(member.disconnectedAt) : member.disconnectedAt),
      estimatedRttMs: member.estimatedRttMs, loadout: clone(member.loadout),
      mutedAccountIds: [...member.muted],
      joinedAt: member.joinedAt, leftAt: null,
    };
  }

  async function persistRoom(room, txh = null) {
    if (!store.rooms?.upsert || !rooms.has(room.roomId)) return;
    const write = async (tx) => {
      await store.rooms.upsert(persistedRoom(room), tx);
      for (const member of room.members.values()) await store.roomMembers.upsert(persistedMember(room, member), tx);
    };
    if (txh) await write(txh); else await store.tx(write);
  }

  async function commitEvents(correlationId, actor, specs, work) {
    const list = Array.isArray(specs) ? specs : [specs];
    const committed = await outbox.commit({ correlationId, actor }, async (tx, emit) => {
      const result = await work(tx);
      for (const spec of list) await emit(spec);
      return result;
    });
    return committed.result;
  }

  const playerActor = (accountId) => ({ kind: 'player', id: accountId, role: null });
  const systemActor = () => ({ kind: 'system', id: 'platform-lobby', role: null });
  const serviceActor = () => ({ kind: 'service', id: 'platform-lobby', role: null });
  const roomEvent = (type, room, payload = {}) => ({
    type, actor: undefined, subject: { kind: 'room', id: room.roomId }, payload,
  });

  async function accountProjection(accountId) {
    const account = await store.accounts.byId(accountId);
    return {
      accountId,
      displayName: account?.displayName || `Player-${accountId.slice(-5)}`,
      privacy: account?.privacy || {},
    };
  }

  async function presenceVisible(subjectId, viewerId) {
    if (subjectId === viewerId) return true;
    if (typeof visibilityFor === 'function') return Boolean((await visibilityFor(subjectId, viewerId)).presence);
    // There is no friendship graph in Alpha. `friends` therefore fails closed, just like
    // an unknown/newer privacy value, rather than becoming an accidental public setting.
    const privacy = (await accountProjection(subjectId)).privacy;
    return privacy?.presenceVisibility === 'everyone';
  }

  function touchPresence(accountId, patch = {}) {
    const current = presence.get(accountId) || { state: 'online', joinable: true, roomId: null };
    const next = { ...current, ...patch, lastSeenAt: now() };
    presence.set(accountId, next);
    // Presence is a realtime projection. The REST list is discovery/recovery, not a polling
    // loop; privacy is evaluated separately for every recipient before any delta leaves.
    void (async () => {
      for (const room of rooms.values()) for (const connection of room.connections.values()) {
        if (!await presenceVisible(accountId, connection.accountId)) continue;
        send(connection, 'presence.delta', { accountId, state: next.state,
          joinable: next.joinable, roomId: next.roomId });
      }
    })().catch((error) => logger.warn('presence.delta.failed', { accountId, message: error.message }));
  }

  function internalMember(room, accountId) {
    return room.members.get(accountId) || null;
  }

  function projectedMember(member, localAccountId) {
    return {
      accountId: member.accountId, displayName: member.displayName, team: member.team,
      ready: member.ready, isOwner: member.isOwner, isLocal: member.accountId === localAccountId,
      connection: member.connection, estimatedRttMs: member.estimatedRttMs,
      loadout: clone(member.loadout), joinedAt: member.joinedAt,
    };
  }

  function core(room, accountId = null, rtt = null) {
    const playerCount = room.members.size;
    let joinBlockedReason = null;
    if (room.status === 'countdown' || room.status === 'in-progress') joinBlockedReason = 'in-progress';
    else if (room.status === 'closing') joinBlockedReason = 'closing';
    else if (playerCount >= room.capacity) joinBlockedReason = 'full';
    else if (room.passwordHash && !room.members.has(accountId)) joinBlockedReason = 'password';
    return {
      roomId: room.roomId, name: room.name, region: room.region, mapId: room.mapId,
      mapVersion: room.mapVersion, mode: room.mode, rulesetVersion: room.rulesetVersion,
      build: room.build, status: room.status, capacity: room.capacity, playerCount,
      joinable: joinBlockedReason === null, joinBlockedReason, hasPassword: Boolean(room.passwordHash),
      ownerAccountId: room.ownerAccountId,
      estimatedRttMs: rtt && Object.hasOwn(rtt, room.region) ? rtt[room.region] : null,
      settings: clone(room.settings),
    };
  }

  function detail(room, accountId, rtt = null) {
    return {
      ...core(room, accountId, rtt),
      roster: [...room.members.values()].map((member) => projectedMember(member, accountId)),
      countdown: room.countdown ? clone(room.countdown) : null,
    };
  }

  function snapshot(room, accountId) {
    const member = internalMember(room, accountId);
    if (!member) throw new ApiError('NOT_IN_ROOM', 'You are not in that room.');
    return {
      protocol: 1, serverTime: iso(now()), heartbeatMs: HEARTBEAT_MS, graceMs: GRACE_MS,
      you: {
        accountId, team: member.team, ready: member.ready, isOwner: member.isOwner,
        seatHeldUntil: member.connection === 'connected' ? null : iso(member.disconnectedAt + GRACE_MS),
      },
      room: core(room, accountId),
      roster: [...room.members.values()].map((item) => projectedMember(item, accountId)),
      countdown: room.countdown ? clone(room.countdown) : null,
      chatHistory: room.chat.slice(-50).filter((message) => !message.removed
        && !member.muted.has(message.accountId)).map(clone),
      mutedAccountIds: [...member.muted], pingCatalog: clone(PING_CATALOG),
      loadoutCatalog: clone(LOADOUT_CATALOG),
    };
  }

  function clearReady(room, reason, correlationId, announce = true) {
    const changed = [];
    for (const member of room.members.values()) {
      if (!member.ready) continue;
      member.ready = false;
      changed.push(member);
      if (announce) broadcast(room, 'ready.changed', { accountId: member.accountId, ready: false, clearedReason: reason }, correlationId);
    }
    return changed;
  }

  function broadcastReadyClears(room, changed, reason, correlationId) {
    for (const member of changed) broadcast(room, 'ready.changed', {
      accountId: member.accountId, ready: false, clearedReason: reason,
    }, correlationId);
  }

  function send(connection, type, data, correlationId = id(), forcedSeq = null) {
    if (!connection || connection.ws.readyState !== 1) return false;
    const seq = forcedSeq === null ? ++connection.seq : forcedSeq;
    connection.ws.send(JSON.stringify({ t: type, seq, ts: iso(now()), correlationId, d: data }));
    return true;
  }

  function broadcast(room, type, data, correlationId = id(), filter = null) {
    for (const connection of room.connections.values()) {
      if (!filter || filter(connection)) send(connection, type, data, correlationId);
    }
  }

  function broadcastRoster(room, { added = [], updated = [], removed = [] }, correlationId = id()) {
    for (const connection of room.connections.values()) {
      send(connection, 'roster.delta', {
        added: added.map((member) => projectedMember(member, connection.accountId)),
        updated: updated.map((member) => projectedMember(member, connection.accountId)),
        removed,
      }, correlationId);
    }
  }

  function errorFrame(connection, error, correlationId) {
    send(connection, 'error', envelope(error, correlationId), correlationId);
  }

  function issueLobbyTicket(room, accountId, kind, ctx) {
    const lobbyTicket = token();
    const created = now();
    const record = {
      lobbyTicket, roomId: room.roomId, accountId, kind, createdAt: created,
      expiresAt: created + RESERVATION_MS, used: false,
    };
    tickets.set(lobbyTicket, record);
    const response = {
      lobbySocketUrl: publicSocketUrl(ctx, config), lobbyTicket,
      expiresAt: iso(record.expiresAt),
    };
    if (kind === 'reconnect') response.graceEndsAt = iso(room.members.get(accountId).disconnectedAt + GRACE_MS);
    else response.reservationId = id();
    return response;
  }

  function assertRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.status === 'destroyed') throw new ApiError('ROOM_NOT_FOUND', 'That room no longer exists.');
    return room;
  }

  function assertJoinable(room, accountId, password) {
    if (room.members.has(accountId)) return;
    if (room.status === 'countdown' || room.status === 'in-progress') throw new ApiError('ROOM_IN_PROGRESS', 'That match is already under way.');
    if (room.status === 'closing') throw new ApiError('ROOM_CLOSED', 'That room is closing.');
    if (room.members.size + room.pending.size >= room.capacity) throw new ApiError('ROOM_FULL', 'That room just filled up.');
    if (room.passwordHash && !password) throw new ApiError('ROOM_PASSWORD_REQUIRED', 'That room needs a password.');
    if (room.passwordHash && !verifyRoomPassword(password, room.passwordHash, config.tokenSecret)) throw new ApiError('ROOM_PASSWORD_INVALID', 'That password is not correct.');
  }

  function releaseExpiredReservations() {
    const at = now();
    for (const [key, record] of tickets) {
      if (!record.used && record.expiresAt <= at) {
        tickets.delete(key);
        rooms.get(record.roomId)?.pending.delete(record.accountId);
      }
    }
  }

  async function reserve(ctx, room, kind = 'join') {
    releaseExpiredReservations();
    const accountId = ctx.actor.accountId;
    touchPresence(accountId);
    if (kind === 'join') {
      assertJoinable(room, accountId, ctx.body.password ?? null);
      room.pending.add(accountId);
    }
    return issueLobbyTicket(room, accountId, kind, ctx);
  }

  function assignTeam(room, preferred = 'auto') {
    const counts = { alpha: 0, bravo: 0 };
    for (const member of room.members.values()) if (member.team !== 'unassigned') counts[member.team]++;
    const limit = Math.ceil(room.capacity / 2);
    if (preferred !== 'auto') {
      if (counts[preferred] >= limit) throw new ApiError('TEAM_FULL', 'That team is full.');
      return preferred;
    }
    return counts.alpha <= counts.bravo ? 'alpha' : 'bravo';
  }

  async function seat(ticketRecord) {
    const room = assertRoom(ticketRecord.roomId);
    let member = room.members.get(ticketRecord.accountId);
    const newlyJoined = !member;
    let cleared = [];
    if (!member) {
      // Reservation already proved the password before a ticket was minted. Capacity and phase
      // are checked again here to close the join race, but the credential never enters a ticket.
      if (room.status !== 'open') throw new ApiError('ROOM_IN_PROGRESS', 'That match is already under way.');
      if (room.members.size >= room.capacity) throw new ApiError('ROOM_FULL', 'That room just filled up.');
      const account = await accountProjection(ticketRecord.accountId);
      member = {
        accountId: account.accountId, displayName: account.displayName,
        team: assignTeam(room), ready: false, isOwner: room.ownerAccountId === account.accountId,
        connection: 'connected', disconnectedAt: null, estimatedRttMs: null,
        loadout: { primaryIdx: 0, secondaryIdx: 0 }, joinedAt: iso(now()), muted: new Set(),
        chatTimes: [], pingTimes: [], lastAckAt: now(),
      };
      room.members.set(member.accountId, member);
      room.pending.delete(member.accountId);
      cleared = clearReady(room, 'roster-change', id(), false);
    } else {
      member.connection = 'connected';
      member.disconnectedAt = null;
      member.lastAckAt = now();
    }
    touchPresence(member.accountId, { state: 'in-lobby', joinable: room.status === 'open', roomId: room.roomId });
    if (newlyJoined) {
      const eventCorrelation = id();
      try {
        await commitEvents(eventCorrelation, playerActor(member.accountId), roomEvent('room.joined', room, {
          accountId: member.accountId, team: member.team,
        }), (tx) => persistRoom(room, tx));
      } catch (error) {
        room.members.delete(member.accountId);
        room.pending.delete(member.accountId);
        for (const item of cleared) item.ready = true;
        throw error;
      }
      broadcastReadyClears(room, cleared, 'roster-change', eventCorrelation);
      broadcastRoster(room, { added: [member] }, eventCorrelation);
    } else await persistRoom(room);
    return { room, member };
  }

  function validateClientFrame(raw) {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { throw failValidation('Lobby frame must be JSON.'); }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)
      || typeof frame.t !== 'string' || !frame.t || !isUlid(frame.correlationId)
      || !frame.d || typeof frame.d !== 'object' || Array.isArray(frame.d)) {
      throw failValidation('Lobby frame envelope is invalid.');
    }
    if (Object.keys(frame).some((key) => !['t', 'correlationId', 'traceparent', 'd'].includes(key))) {
      throw failValidation('Lobby frame envelope has unknown fields.');
    }
    if (frame.traceparent !== undefined && !parseTraceparent(frame.traceparent)) {
      throw failValidation('Lobby frame traceparent is invalid.');
    }
    return { ...frame, known: VALID_CLIENT_TYPES.has(frame.t) };
  }

  function validPingTarget(target) {
    if (target === undefined) return true;
    if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
    const keys = Object.keys(target);
    if (target.kind === 'site') return keys.length === 2 && ['A', 'B'].includes(target.site);
    if (target.kind === 'world') return keys.length === 4
      && ['x', 'y', 'z'].every((key) => Number.isFinite(target[key]) && Math.abs(target[key]) <= 1000);
    return false;
  }

  function within(member, field, limit, windowMs) {
    const at = now();
    if (!Array.isArray(member[field])) member[field] = [];
    member[field] = member[field].filter((time) => at - time < windowMs);
    if (member[field].length >= limit) return false;
    member[field].push(at);
    return true;
  }

  function abortCountdown(room, reason, correlationId, { clear = false, byAccountId } = {}) {
    if (!room.countdown) return;
    room.countdown = null;
    room.status = 'open';
    if (clear) clearReady(room, reason === 'team-imbalance' ? 'team-change' : 'room-change', correlationId);
    const data = { reason };
    if (byAccountId) data.byAccountId = byAccountId;
    broadcast(room, 'countdown.aborted', data, correlationId);
    broadcast(room, 'room.updated', { status: 'open', joinable: room.members.size < room.capacity, joinBlockedReason: room.members.size >= room.capacity ? 'full' : null }, correlationId);
  }

  function buildHandoff(room, accountId, matchId, allocatedServerUrl = config.matchServerUrl) {
    const expiresAt = now() + 60_000;
    const jti = id();
    const member = room.members.get(accountId);
    const sessionTicket = issueMatchTicket(config.matchTicketSecret, {
      jti, sub: accountId, roomId: room.roomId, matchId, exp: expiresAt, mode: room.mode,
      team: member?.team, primaryIdx: member?.loadout.primaryIdx, secondaryIdx: member?.loadout.secondaryIdx,
    });
    const record = { jti, accountId, roomId: room.roomId, matchId,
      expiresAt: iso(expiresAt), createdAt: iso(now()) };
    const serverUrl = allocatedServerUrl || 'ws://127.0.0.1:8080';
    const projection = {
      matchId, serverUrl, sessionTicket, expiresAt: iso(expiresAt), reconnectGraceMs: GRACE_MS,
      mapId: room.mapId, mapVersion: room.mapVersion, mode: room.mode,
      rulesetVersion: room.rulesetVersion, region: room.region, serverBuild: room.build,
      protocolVersion: 3,
      series: room.mode === 'bomb'
        ? { roundsToWin: 7, maxRounds: 12, sideSwitchAfter: 6, overtime: false }
        : { roundsToWin: 1, maxRounds: 1, sideSwitchAfter: 1, overtime: false },
      spectatorPolicyVersion: 1,
      sites: room.mode === 'bomb' ? [
        { id: 'site-A', site: 'A', callout: 'Fountain', center: { x: -25, y: 0, z: 0 }, box: { min: { x: -29, y: 0, z: -4 }, max: { x: -21, y: 3, z: 4 } } },
        { id: 'site-B', site: 'B', callout: 'Market', center: { x: 25, y: 0, z: 0 }, box: { min: { x: 21, y: 0, z: -4 }, max: { x: 29, y: 3, z: 4 } } },
      ] : [],
    };
    return { record, projection, cached: { accountId, roomId: room.roomId, matchId, expiresAt, used: false } };
  }

  async function handoff(room, accountId, matchId, allocatedServerUrl = config.matchServerUrl) {
    const built = buildHandoff(room, accountId, matchId, allocatedServerUrl);
    await store.matchTickets.put(built.record);
    matchTickets.set(built.record.jti, built.cached);
    return built.projection;
  }

  function matchControlUrl(path, serverUrl) {
    const url = new URL(serverUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = path;
    url.search = '';
    return url;
  }

  function ingestRemoteSpans(body, correlationId) {
    if (!Array.isArray(body?.traceSpans)) return;
    for (const span of body.traceSpans.slice(-50)) {
      if (span?.correlationId !== correlationId || span.tier !== 'match-server') continue;
      observability?.recordSpan?.({ ...span, correlationId, tier: 'match-server' });
    }
  }

  async function controlRequest(path, body, correlationId = id(), serverUrl = config.matchServerUrl,
    traceparent = traceparentForCorrelation(correlationId, 'platform')) {
    const startedAt = now();
    let response;
    try {
      response = await fetch(matchControlUrl(path, serverUrl), {
        method: 'POST', signal: AbortSignal.timeout(2_500),
        headers: { authorization: `Bearer ${config.matchControlSecret}`, 'content-type': 'application/json',
          'x-correlation-id': correlationId,
          traceparent },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new ApiError('MATCH_SERVER_UNREACHABLE', 'The match server is unavailable.', { cause });
    }
    if (!response.ok) throw new ApiError('MATCH_ALLOCATION_FAILED', 'The match server has no matching capacity.', {
      details: { status: response.status },
    });
    observability?.recordSpan?.({ correlationId, traceparent, tier: 'platform', name: `match-control${path}`,
      durationMs: now() - startedAt, attributes: { component: 'match-control', status: response.status } });
    try { ingestRemoteSpans(await response.clone().json(), correlationId); } catch { /* 204 release */ }
    return response;
  }

  async function controlStatus(serverUrl, correlationId = id(),
    traceparent = traceparentForCorrelation(correlationId, 'platform')) {
    const startedAt = now();
    let response;
    try {
      response = await fetch(matchControlUrl('/control/status', serverUrl), {
        signal: AbortSignal.timeout(2_500),
        headers: { authorization: `Bearer ${config.matchControlSecret}`,
          'x-correlation-id': correlationId,
          traceparent },
      });
    } catch (cause) {
      throw new ApiError('MATCH_SERVER_UNREACHABLE', 'The match server is unavailable.', { cause });
    }
    if (!response.ok) throw new ApiError('MATCH_SERVER_UNREACHABLE', 'The match server status is unavailable.');
    observability?.recordSpan?.({ correlationId, traceparent, tier: 'platform', name: 'match-control/status',
      durationMs: now() - startedAt, attributes: { component: 'match-control', status: response.status } });
    const body = await response.json();
    ingestRemoteSpans(body, correlationId);
    return body;
  }

  async function allocateServer(room, matchId, correlationId, traceparent) {
    // A recently heartbeating row may still have died between discovery and allocation. Quarantine
    // it and try another registered authority in the same region instead of failing a healthy
    // room because the first row in registry order was stale.
    const heartbeatCutoff = iso(now() - HEARTBEAT_MS * 2);
    const candidateCount = (await store.matchServers?.healthy?.(room.region, heartbeatCutoff))?.length ?? 0;
    for (let attempt = 0; attempt < candidateCount; attempt++) {
      const serverRecord = await store.matchServers?.reserve?.(room.region, heartbeatCutoff);
      if (!serverRecord) break;
      let remotelyAllocated = false;
      try {
        await controlRequest('/control/allocate', {
          matchId, roomId: room.roomId, mode: room.mode, mapId: room.mapId,
          mapVersion: room.mapVersion, rulesetVersion: room.rulesetVersion,
          serverBuild: room.build, region: room.region,
          roster: [...room.members.values()].map((member) => ({
            accountId: member.accountId, displayName: member.displayName, team: member.team,
            primaryIdx: member.loadout.primaryIdx, secondaryIdx: member.loadout.secondaryIdx,
          })),
        }, correlationId, serverRecord.address, traceparent);
        remotelyAllocated = true;
        // Allocation and handoff delivery are a saga boundary. Confirm that the authority which
        // acknowledged allocation is still alive and bound to these exact ids before any durable
        // match/ticket row is committed or any browser receives `match.ready`.
        const status = await controlStatus(serverRecord.address, correlationId, traceparent);
        if (status.matchId !== matchId || status.roomId !== room.roomId || status.status !== 'allocated') {
          throw new ApiError('MATCH_ALLOCATION_FAILED', 'The match server did not retain the allocation.');
        }
        return serverRecord;
      } catch (error) {
        if (remotelyAllocated) {
          try {
            await controlRequest('/control/release', { matchId }, correlationId,
              serverRecord.address, traceparent);
          } catch { /* an authority that died after allocation has nothing reachable to release */ }
        }
        await store.matchServers.release(serverRecord.serverId);
        try {
          await store.matchServers.heartbeat(serverRecord.serverId, { inUse: 0,
            status: 'unhealthy', capacity: serverRecord.capacity, lastHeartbeatAt: iso(now()) });
        } catch { /* a concurrently removed registry row is already unavailable */ }
      }
    }
    throw new ApiError('MATCH_ALLOCATION_FAILED', 'No registered regional match server has capacity.');
  }

  async function releaseServer(matchId, serverUrl, serverId, correlationId = matchId,
    traceparent = traceparentForCorrelation(correlationId, 'platform')) {
    await controlRequest('/control/release', { matchId }, correlationId, serverUrl, traceparent);
    if (serverId) await store.matchServers.release(serverId);
  }

  async function bestEffortReleaseServer(matchId, serverUrl, serverId, correlationId = matchId,
    traceparent = traceparentForCorrelation(correlationId, 'platform')) {
    try { await releaseServer(matchId, serverUrl, serverId, correlationId, traceparent); } catch { /* allocation never became durable */ }
  }

  function zeroPlayer(member, endedAt) {
    return {
      accountId: member.accountId, displayName: member.displayName, team: member.team, role: null,
      kills: 0, deaths: 0, assists: 0, suicides: 0, teamKills: 0, headshots: 0,
      shotsFired: 0, shotsHit: 0, damageDealt: 0, plants: 0, defuses: 0,
      roundsPlayed: 0, timePlayedSec: 0, score: 0, weapons: {}, disconnected: true,
      abandoned: false, joinedAt: member.joinedAt, leftAt: endedAt,
    };
  }

  async function reopenAfterTerminal(match, { authorityGone = false } = {}) {
    const room = match.room;
    room.status = 'closing';
    room.countdown = null;
    await persistRoom(room);
    if (!authorityGone) await releaseServer(match.matchId, match.serverUrl, match.serverId,
      match.correlationId, match.traceparent);
    else if (match.serverId) await store.matchServers.release(match.serverId);
    room.status = 'open';
    const cleared = clearReady(room, 'room-change', id(), false);
    await persistRoom(room);
    match.endedAt = now();
    matches.delete(match.matchId);
    broadcastReadyClears(room, cleared, 'room-change', id());
    broadcast(room, 'room.updated', { status: 'open', joinable: true, joinBlockedReason: null }, id());
    for (const member of room.members.values()) touchPresence(member.accountId,
      { state: 'in-lobby', joinable: true, roomId: room.roomId });
  }

  async function abortActiveMatch(match, reason = 'server-unreachable', authorityGone = false) {
    if (match.endedAt) return;
    if (match.terminalCommitted) {
      await reopenAfterTerminal(match, { authorityGone: match.authorityGone || authorityGone });
      return;
    }
    const room = match.room;
    const endedAt = iso(now());
    const players = [...room.members.values()].filter((member) => match.accountIds.has(member.accountId))
      .map((member) => zeroPlayer(member, endedAt));
    const roster = players.map((player) => ({ accountId: player.accountId, team: player.team,
      joinedAt: player.joinedAt, leftAt: player.leftAt }));
    const resultCore = {
      matchId: match.matchId, region: room.region, mapId: room.mapId, mapVersion: room.mapVersion,
      mode: room.mode, rulesetVersion: room.rulesetVersion, statDefinitionVersion: '1.0.0',
      serverBuild: room.build, status: 'aborted', terminationReason: 'aborted',
      outcomeReason: 'no-contest', winnerTeam: null, invalidationReason: null,
      startedAt: iso(match.startedAt), endedAt,
      rulesSnapshot: {
        killLimit: room.mode === 'tdm' ? (room.settings.killLimit ?? 75) : null,
        roundsToWin: room.settings.roundsToWin ?? null,
        maxRounds: room.settings.maxRounds ?? null,
        sideSwitchAfter: room.mode === 'bomb' ? 6 : null,
        roundLengthSec: room.settings.roundLengthSec ?? null,
        bombTimerSec: room.mode === 'bomb' ? 40 : null,
        defuseSec: room.mode === 'bomb' ? 7 : null,
        plantSec: room.mode === 'bomb' ? 4 : null,
        freezeSec: room.mode === 'bomb' ? 6 : null,
        overtime: room.mode === 'bomb' ? false : null,
      },
      roster, teamScores: { alpha: 0, bravo: 0 }, rounds: [], players,
    };
    const evidence = {
      version: 1,
      matchId: resultCore.matchId, rulesetVersion: resultCore.rulesetVersion,
      serverBuild: resultCore.serverBuild, protocolVersion: 3,
      authority: {
        matchId: resultCore.matchId, rulesetVersion: resultCore.rulesetVersion,
        statDefinitionVersion: resultCore.statDefinitionVersion,
        rulesSnapshot: resultCore.rulesSnapshot, serverBuild: resultCore.serverBuild,
        mapId: resultCore.mapId, mapVersion: resultCore.mapVersion,
        region: resultCore.region, mode: resultCore.mode, startedAt: resultCore.startedAt,
      },
      terminalSummary: {
        status: resultCore.status, endedAt: resultCore.endedAt,
        terminationReason: resultCore.terminationReason, outcomeReason: resultCore.outcomeReason,
        winnerTeam: resultCore.winnerTeam, invalidationReason: resultCore.invalidationReason,
        teamScores: resultCore.teamScores, failureReason: reason,
      },
      participants: players.map(({ accountId, displayName, team, role }) => ({
        accountId, displayName, team, role,
      })),
      roundSummary: [],
      combatSummary: players.map(({ accountId, kills, deaths, assists, suicides, teamKills,
        headshots, shotsFired, shotsHit, damageDealt, plants, defuses, roundsPlayed, score, weapons }) => ({
        accountId, kills, deaths, assists, suicides, teamKills, headshots, shotsFired, shotsHit,
        damageDealt, plants, defuses, roundsPlayed, score, weapons,
      })),
      connectionSummary: players.map(({ accountId, joinedAt, leftAt, timePlayedSec,
        disconnected, abandoned }) => ({ accountId, joinedAt, leftAt, timePlayedSec, disconnected, abandoned })),
      roster, result: resultCore,
      eventTimeline: [], objectives: [], combatSamples: [], connectionFacts: [], antiCheatFlags: [],
      combatSampling: { observed: 0, every: 16, retained: 0, killsAlwaysRetained: true },
      droppedRows: 0, droppedCombatSamples: 0, droppedConnectionFacts: 0, droppedAntiCheatFlags: 0,
    };
    const evidenceRef = `sha256:${evidenceDigest(evidence)}`;
    if (typeof resultApplier !== 'function') {
      throw new ApiError('INTERNAL_ERROR', 'The canonical result applier is unavailable.');
    }
    logger.debug('lobby.match_abort.apply.start', { matchId: match.matchId });
    await resultApplier({
      actor: serviceActor(), result: { ...resultCore, evidenceRef }, evidence,
      idempotencyKey: `match-result:${match.matchId}`, correlationId: match.correlationId,
    });
    logger.debug('lobby.match_abort.apply.complete', { matchId: match.matchId });
    match.terminalCommitted = true;
    match.authorityGone = authorityGone;
    logger.debug('lobby.match_abort.reopen.start', { matchId: match.matchId });
    await reopenAfterTerminal(match, { authorityGone });
    logger.debug('lobby.match_abort.reopen.complete', { matchId: match.matchId });
    broadcast(room, 'match.failed', envelope(new ApiError('MATCH_SERVER_UNREACHABLE', 'The match server ended the allocation.'), id()));
  }

  async function completeActiveMatch(match, terminal) {
    if (match.terminalCommitted) {
      await reopenAfterTerminal(match);
      return;
    }
    if (!terminal || typeof resultApplier !== 'function') {
      throw new ApiError('MATCH_ALLOCATION_FAILED', 'The match server did not provide a canonical terminal result.');
    }
    const { evidence, ...result } = terminal;
    if (!evidence || result.matchId !== match.matchId || result.roomId !== undefined
      || result.mode !== match.room.mode || result.mapId !== match.room.mapId
      || result.mapVersion !== match.room.mapVersion
      || result.rulesetVersion !== match.room.rulesetVersion
      || result.serverBuild !== match.room.build || result.region !== match.room.region) {
      throw new ApiError('VALIDATION_FAILED', 'Terminal result does not match its allocation.');
    }
    await resultApplier({
      actor: serviceActor(), result, evidence,
      idempotencyKey: `match-result:${match.matchId}`, correlationId: match.correlationId,
    });
    match.terminalCommitted = true;
    await reopenAfterTerminal(match);
    logger.info('match.canonical_result_applied', {
      matchId: match.matchId, evidenceRef: result.evidenceRef, evidenceRows: evidence?.objectives?.length ?? 0,
    });
  }

  function startLaunch(room, correlationId,
    traceparent = traceparentForCorrelation(correlationId, 'platform')) {
    const requiredReady = Math.min(room.settings.requiredReady, room.members.size);
    const ready = [...room.members.values()].filter((member) => member.ready).length;
    if (room.members.size < room.settings.minPlayers || ready < requiredReady) {
      throw new ApiError('CONFLICT', 'Everyone has to be ready first.', {
        details: { reason: 'not-all-ready', requiredReady, currentReady: ready },
      });
    }
    room.status = 'countdown';
    room.countdown = { endsAt: iso(now() + 3_000), requiredReady, currentReady: ready };
    broadcast(room, 'countdown.started', clone(room.countdown), correlationId);
    for (const remainingMs of [2_000, 1_000, 0]) {
      setTimeout(() => {
        if (room.status === 'countdown') broadcast(room, 'countdown.tick', { remainingMs }, correlationId);
      }, 3_000 - remainingMs).unref?.();
    }
    let attemptedMatchId = null;
    let attemptedServerRecord = null;
    setTimeout(() => { void (async () => {
      if (room.status !== 'countdown') return;
      broadcast(room, 'match.allocating', {}, correlationId);
      const matchId = id();
      attemptedMatchId = matchId;
      const serverRecord = await allocateServer(room, matchId, correlationId, traceparent);
      attemptedServerRecord = serverRecord;
      room.status = 'in-progress';
      room.countdown = null;
      const readyHandoffs = new Map();
      await commitEvents(correlationId, serviceActor(), {
        type: 'match.allocated', subject: { kind: 'match', id: matchId },
        payload: { roomId: room.roomId, serverId: serverRecord.serverId, serverUrl: serverRecord.address },
      }, async (tx) => {
        await persistRoom(room, tx);
        await store.matches.record({
          matchId, roomId: room.roomId, region: room.region, serverId: serverRecord.serverId, mapId: room.mapId,
          mapVersion: room.mapVersion, mode: room.mode, rulesetVersion: room.rulesetVersion,
          serverBuild: room.build, status: 'allocated', rulesSnapshot: clone(room.settings),
          players: [...room.members.values()].map((member) => ({
            accountId: member.accountId, team: member.team, joinedAt: member.joinedAt,
            disconnected: false, abandoned: false, stats: { loadout: clone(member.loadout) },
          })),
        }, tx);
        for (const member of room.members.values()) {
          const built = buildHandoff(room, member.accountId, matchId, serverRecord.address);
          await store.matchTickets.put(built.record, tx);
          readyHandoffs.set(member.accountId, built);
        }
      });
      matches.set(matchId, {
        matchId, roomId: room.roomId, serverId: serverRecord.serverId, serverUrl: serverRecord.address,
        accountIds: new Set(room.members.keys()), room,
        graceEnds: new Map(), startedAt: now(), endedAt: null, correlationId, traceparent,
      });
      for (const built of readyHandoffs.values()) matchTickets.set(built.record.jti, built.cached);
      for (const connection of room.connections.values()) {
        send(connection, 'match.ready', readyHandoffs.get(connection.accountId).projection, correlationId);
      }
      broadcast(room, 'room.updated', { status: 'in-progress', joinable: false, joinBlockedReason: 'in-progress' }, correlationId);
      for (const member of room.members.values()) touchPresence(member.accountId, { state: 'in-match', joinable: false, roomId: room.roomId });
    })().catch(async (error) => {
      logger.error('lobby.launch.failed', { roomId: room.roomId, correlationId, message: error.message });
      // Allocation is staged in memory as a single-authority lock before the durable commit.
      // If that commit fails, restore an open room and release the slot before telling clients;
      // `abortCountdown` cannot do this after countdown was already nulled.
      if (attemptedMatchId && attemptedServerRecord && !matches.has(attemptedMatchId)) {
        await bestEffortReleaseServer(attemptedMatchId, attemptedServerRecord.address,
          attemptedServerRecord.serverId, correlationId, traceparent);
      }
      if (room.status === 'in-progress' || room.status === 'countdown') {
        room.status = 'open';
        room.countdown = null;
        const cleared = clearReady(room, 'room-change', correlationId, false);
        broadcastReadyClears(room, cleared, 'room-change', correlationId);
        broadcast(room, 'countdown.aborted', { reason: 'allocation-failed' }, correlationId);
        broadcast(room, 'room.updated', { status: 'open', joinable: true, joinBlockedReason: null }, correlationId);
      }
      const failure = error instanceof ApiError && error.code !== 'INTERNAL_ERROR' ? error
        : new ApiError('MATCH_ALLOCATION_FAILED', 'The match server could not be allocated.');
      broadcast(room, 'match.failed', envelope(failure, correlationId), correlationId);
      await persistRoom(room);
    }); }, 3_050).unref?.();
  }

  async function handleMessage(connection, raw) {
    let frame;
    try { frame = validateClientFrame(raw); }
    catch (error) { connection.ws.close(1002, 'invalid lobby frame'); return; }
    if (!frame.known) return;
    const { room, member } = connection;
    const correlationId = frame.correlationId;
    const traceparent = frame.traceparent?.trim().toLowerCase()
      || traceparentForCorrelation(correlationId, 'client');
    observability?.recordSpan?.({ correlationId,
      traceparent, tier: 'client',
      name: 'lobby.intent', attributes: { component: 'lobby-client', eventType: frame.t } });
    let transitionEvent = null;
    let passiveTransition = null;
    let persistAfterFrame = true;
    try {
      switch (frame.t) {
        case 'team.request': {
          if (!within(member, 'teamTimes', 6, 60_000)) throw new ApiError('RATE_LIMITED', 'Team changes are temporarily rate limited.', { retryAfterMs: 60_000 });
          if (!['alpha', 'bravo', 'auto'].includes(frame.d.team)) throw failValidation('Invalid team.', 'team');
          if (room.status !== 'open') throw new ApiError('TEAM_SWITCH_FORBIDDEN', 'Teams are frozen during launch.');
          const team = assignTeam(room, frame.d.team);
          const previousTeam = member.team;
          let cleared = [];
          if (member.team !== team) {
            member.team = team;
            cleared = clearReady(room, 'team-change', correlationId, false);
          }
          transitionEvent = roomEvent('room.team_changed', room, { accountId: member.accountId, team });
          transitionEvent.afterCommit = () => {
            broadcastReadyClears(room, cleared, 'team-change', correlationId);
            broadcast(room, 'team.changed', { accountId: member.accountId, team, byServer: frame.d.team === 'auto' }, correlationId);
          };
          transitionEvent.rollback = () => {
            member.team = previousTeam;
            for (const item of cleared) item.ready = true;
          };
          break;
        }
        case 'ready.set': {
          if (!within(member, 'readyTimes', 20, 60_000)) throw new ApiError('RATE_LIMITED', 'Ready changes are temporarily rate limited.', { retryAfterMs: 60_000 });
          if (typeof frame.d.ready !== 'boolean') throw failValidation('ready must be boolean.', 'ready');
          if (room.status === 'in-progress' || (room.status === 'countdown' && frame.d.ready)) {
            throw new ApiError('ROOM_IN_PROGRESS', 'Readiness is frozen during launch and play.');
          }
          const previousReady = member.ready;
          member.ready = frame.d.ready;
          transitionEvent = roomEvent('room.ready_changed', room, { accountId: member.accountId, ready: member.ready });
          transitionEvent.afterCommit = async () => {
            broadcast(room, 'ready.changed', { accountId: member.accountId, ready: member.ready }, correlationId);
            if (!member.ready && room.countdown) {
              abortCountdown(room, 'player-unready', correlationId, { byAccountId: member.accountId });
              await persistRoom(room);
            }
          };
          transitionEvent.rollback = () => { member.ready = previousReady; };
          break;
        }
        case 'loadout.set': {
          if (!within(member, 'loadoutTimes', 20, 60_000)) throw new ApiError('RATE_LIMITED', 'Loadout changes are temporarily rate limited.', { retryAfterMs: 60_000 });
          if (room.status !== 'open') throw new ApiError('ROOM_IN_PROGRESS', 'Loadouts are frozen during launch and play.');
          if (!LIVE_LOADOUT_CATALOG.primary.some((item) => item.idx === frame.d.primaryIdx && item.eligible)
            || !LIVE_LOADOUT_CATALOG.secondary.some((item) => item.idx === frame.d.secondaryIdx && item.eligible)) {
            throw failValidation('Loadout selection is not eligible in this catalog.', 'loadout');
          }
          const previousLoadout = clone(member.loadout);
          const previousReady = member.ready;
          member.loadout = { primaryIdx: frame.d.primaryIdx, secondaryIdx: frame.d.secondaryIdx };
          member.ready = false;
          const afterCommit = () => {
            if (previousReady) broadcast(room, 'ready.changed', { accountId: member.accountId, ready: false, clearedReason: 'loadout-change' }, correlationId);
            broadcastRoster(room, { updated: [member] }, correlationId);
          };
          const rollback = () => { member.loadout = previousLoadout; member.ready = previousReady; };
          if (previousReady) {
            transitionEvent = roomEvent('room.ready_changed', room, {
              accountId: member.accountId, ready: false, clearedReason: 'loadout-change',
            });
            transitionEvent.afterCommit = afterCommit;
            transitionEvent.rollback = rollback;
          } else passiveTransition = { afterCommit, rollback };
          break;
        }
        case 'launch.request':
          if (!within(member, 'launchTimes', 6, 60_000)) throw new ApiError('RATE_LIMITED', 'Launch requests are temporarily rate limited.', { retryAfterMs: 60_000 });
          if (!member.isOwner) throw new ApiError('AUTH_FORBIDDEN', 'Only the room owner can start the match.');
          if (room.status !== 'open') throw new ApiError('ROOM_IN_PROGRESS', 'That match is already launching.');
          // Validate now, mutate/broadcast only after the launch-request event commits.
          {
            const requiredReady = Math.min(room.settings.requiredReady, room.members.size);
            const ready = [...room.members.values()].filter((item) => item.ready).length;
            if (room.members.size < room.settings.minPlayers || ready < requiredReady) {
              throw new ApiError('CONFLICT', 'Everyone has to be ready first.', {
                details: { reason: 'not-all-ready', requiredReady, currentReady: ready },
              });
            }
          }
          transitionEvent = roomEvent('room.launch_requested', room, { accountId: member.accountId });
          transitionEvent.afterCommit = async () => { startLaunch(room, correlationId, traceparent); await persistRoom(room); };
          break;
        case 'chat.send': {
          persistAfterFrame = false;
          let moderation;
          try { moderation = await chatModerator(frame.d.text); }
          catch (cause) { throw new ApiError('SERVICE_UNAVAILABLE', 'Chat moderation is unavailable.', { cause }); }
          if (!moderation || !['allow', 'redact', 'reject'].includes(moderation.decision)
            || typeof moderation.policyVersion !== 'string'
            || Object.keys(moderation).sort().join(',') !== 'decision,policyVersion,text') {
            throw new ApiError('SERVICE_UNAVAILABLE', 'Chat moderation returned an invalid decision.');
          }
          if (moderation.decision === 'reject') throw failValidation('That message is blocked by chat policy.', 'text');
          const acceptedText = moderation.text;
          if (typeof acceptedText !== 'string' || !acceptedText || acceptedText.length > 200) {
            throw new ApiError('SERVICE_UNAVAILABLE', 'Chat moderation returned invalid safe text.');
          }
          if (!within(member, 'chatTimes', 10, CHAT_WINDOW_MS)) throw new ApiError('CHAT_RATE_LIMITED', 'Chat is temporarily rate limited.', { retryAfterMs: CHAT_WINDOW_MS });
          const message = { id: id(), accountId: member.accountId, displayName: member.displayName,
            text: acceptedText, ts: iso(now()), filtered: moderation.decision === 'redact' || acceptedText !== frame.d.text };
          await store.chatMessages.create({ messageId: message.id, roomId: room.roomId,
            senderAccountId: member.accountId, text: acceptedText, createdAt: message.ts,
            expiresAt: iso(now() + CHAT_RETENTION_MS) });
          room.chat.push(message);
          while (room.chat.length > 50) room.chat.shift();
          broadcast(room, 'chat.message', message, correlationId, (recipient) => !room.members.get(recipient.accountId).muted.has(member.accountId));
          break;
        }
        case 'ping.send':
          persistAfterFrame = false;
          if (!PING_KINDS.has(frame.d.kind)) throw failValidation('Unknown ping kind.', 'kind');
          if (!validPingTarget(frame.d.target)) throw failValidation('Invalid ping target.', 'target');
          if (!within(member, 'pingTimes', 12, 60_000)) throw new ApiError('RATE_LIMITED', 'Pings are temporarily rate limited.', { retryAfterMs: 60_000 });
          broadcast(room, 'ping.placed', Object.hasOwn(frame.d, 'target')
            ? { accountId: member.accountId, kind: frame.d.kind, target: frame.d.target }
            : { accountId: member.accountId, kind: frame.d.kind }, correlationId);
          break;
        case 'mute.set': {
          if (!within(member, 'muteTimes', 20, 60_000)) throw new ApiError('RATE_LIMITED', 'Mute changes are temporarily rate limited.', { retryAfterMs: 60_000 });
          if (!isUlid(frame.d.accountId) || typeof frame.d.muted !== 'boolean'
            || !room.members.has(frame.d.accountId) || frame.d.accountId === member.accountId) {
            throw failValidation('Invalid mute target.', 'accountId');
          }
          const wasMuted = member.muted.has(frame.d.accountId);
          if (frame.d.muted) member.muted.add(frame.d.accountId); else member.muted.delete(frame.d.accountId);
          passiveTransition = {
            afterCommit: () => send(connection, 'mute.changed', { accountId: frame.d.accountId, muted: frame.d.muted }, correlationId),
            rollback: () => { if (wasMuted) member.muted.add(frame.d.accountId); else member.muted.delete(frame.d.accountId); },
          };
          break;
        }
        case 'state.resync':
          if (!within(member, 'resyncTimes', 3, 60_000)) throw new ApiError('RATE_LIMITED', 'State resync is temporarily rate limited.', { retryAfterMs: 60_000 });
          if (!Number.isInteger(frame.d.lastSeq) || frame.d.lastSeq < 0) throw failValidation('lastSeq must be non-negative.', 'lastSeq');
          send(connection, 'state.snapshot', snapshot(room, member.accountId), correlationId);
          break;
        case 'heartbeat.ack': member.lastAckAt = now(); touchPresence(member.accountId); break;
        case 'leave': await removeMember(room, member.accountId, correlationId, true); connection.ws.close(1000, 'left room'); break;
        default: break;
      }
      if (frame.t !== 'heartbeat.ack' && frame.t !== 'state.resync' && frame.t !== 'leave') {
        if (transitionEvent) await commitEvents(correlationId, playerActor(member.accountId), transitionEvent,
          (tx) => persistRoom(room, tx)).then(() => transitionEvent.afterCommit?.(), (error) => {
          transitionEvent.rollback?.(); throw error;
        });
        else if (persistAfterFrame) {
          try { await persistRoom(room); }
          catch (error) { passiveTransition?.rollback?.(); throw error; }
          await passiveTransition?.afterCommit?.();
        }
      }
    } catch (error) {
      if (!transitionEvent) passiveTransition?.rollback?.();
      errorFrame(connection, error instanceof ApiError ? error : new ApiError('INTERNAL_ERROR', 'Lobby request failed.'), correlationId);
    }
  }

  /**
   * Start a seat's reconnect grace, at the instant the server decided the peer was gone.
   *
   * `at` is a parameter rather than a `now()` read inside here for a reason that is easy to
   * miss: the socket `close` event does not fire when the connection dies, it fires when the
   * TCP close HANDSHAKE finishes — one network round trip and at least one event-loop poll
   * later. Stamping `disconnectedAt` in that handler dates the grace window from an instant
   * chosen by the peer's responsiveness and by how busy this process happens to be.
   *
   * That is wrong twice over. In production it hands a slow or half-dead peer extra grace
   * proportional to how slow it is, which is exactly backwards. And it made the 90-second
   * expiry untestable: `presencetest.mjs` drives a fake clock, closes two sockets from
   * `sweep()`, and advances 90 s — but the advance is microtasks away from the close, while
   * the server-side `close` handler is an I/O poll away. On an idle laptop the handler won
   * that race and the seats expired; on loaded CI hardware it lost, the seats were stamped
   * 89 s LATE, and the expiry assertion failed while its "strictly inside the grace"
   * neighbour still passed — the boundary was being straddled rather than controlled.
   *
   * So the heartbeat-timeout path in `sweep()` stamps the seat synchronously with the sweep's
   * own `at`, before the socket has finished closing, and the `close` handler that arrives
   * later is a no-op because the seat is no longer `connected`. The grace window is now a
   * function of the clock the sweep reads and nothing else.
   */
  function markDisconnected(room, member, at) {
    if (!room.members.has(member.accountId) || member.connection !== 'connected') return;
    member.connection = 'reconnecting';
    member.disconnectedAt = at;
    touchPresence(member.accountId, { state: 'in-lobby', joinable: false, roomId: room.roomId });
    broadcastRoster(room, { updated: [member] });
    void persistRoom(room).catch((error) => logger.error('lobby.disconnect.persist_failed', {
      roomId: room.roomId, accountId: member.accountId, message: error.message,
    }));
  }

  async function removeMember(room, accountId, correlationId = id(), voluntary = false) {
    const member = room.members.get(accountId);
    if (!member) return;
    const previousStatus = room.status;
    const previousCountdown = room.countdown ? clone(room.countdown) : null;
    const previousOwnerAccountId = room.ownerAccountId;
    room.members.delete(accountId);
    let countdownAborted = false;
    if (room.countdown) {
      const ready = [...room.members.values()].filter((item) => item.ready).length;
      if (ready < room.countdown.requiredReady) {
        room.countdown = null; room.status = 'open'; countdownAborted = true;
      }
    }
    let nextOwner = null;
    if (member.isOwner && room.members.size) {
      nextOwner = room.members.values().next().value;
      nextOwner.isOwner = true;
      room.ownerAccountId = nextOwner.accountId;
    }
    const empty = room.members.size === 0;
    if (empty) room.status = 'closing';
    try {
      const events = [roomEvent('room.left', room, { accountId, voluntary })];
      if (empty) events.push({ ...roomEvent('room.destroyed', room, { reason: 'empty' }), actor: systemActor() });
      await commitEvents(correlationId, playerActor(accountId), events, async (tx) => {
        await store.roomMembers?.remove?.(room.roomId, accountId, iso(now()), tx);
        if (empty) await store.rooms?.remove?.(room.roomId, tx);
        else await persistRoom(room, tx);
      });
    } catch (error) {
      room.members.set(accountId, member);
      if (nextOwner) nextOwner.isOwner = false;
      room.ownerAccountId = previousOwnerAccountId;
      room.status = previousStatus;
      room.countdown = previousCountdown;
      throw error;
    }
    room.connections.delete(accountId);
    if (empty) rooms.delete(room.roomId);
    touchPresence(accountId, { state: 'online', joinable: true, roomId: null });
    broadcastRoster(room, { removed: [accountId] }, correlationId);
    if (countdownAborted) {
      broadcast(room, 'countdown.aborted', { reason: 'player-left', byAccountId: accountId }, correlationId);
      broadcast(room, 'room.updated', { status: 'open', joinable: true, joinBlockedReason: null }, correlationId);
    }
    if (nextOwner) {
      broadcastRoster(room, { updated: [nextOwner] }, correlationId);
      broadcast(room, 'room.updated', { ownerAccountId: nextOwner.accountId, playerCount: room.members.size }, correlationId);
    }
  }

  async function acceptSocket(ws, request, record, resume) {
    // `open` fires at the browser before async seat persistence completes. A reconnect client
    // immediately sends `state.resync`; without this small pre-seat queue PostgreSQL latency can
    // drop that first frame while memory tests always pass.
    const preSeatFrames = [];
    const queuePreSeat = (data) => { if (preSeatFrames.length < 8) preSeatFrames.push(data); };
    ws.on('message', queuePreSeat);
    let seated;
    try { await ensureHydrated(); seated = await seat(record); }
    catch (error) {
      ws.off('message', queuePreSeat);
      const closeCode = {
        ROOM_NOT_FOUND: 4003, ROOM_FULL: 4004, SANCTIONED: 4005,
        ROOM_REMOVED: 4006, ROOM_CLOSED: 4007,
      }[error.code] || 4001;
      ws.close(closeCode, error.code || 'SESSION_TOKEN_INVALID'); return;
    }
    const { room, member } = seated;
    const prior = room.connections.get(member.accountId);
    if (prior && prior.ws !== ws) prior.ws.close(4008, 'AUTH_SESSION_REPLACED');
    const connection = { ws, room, accountId: member.accountId, member, seq: resume ? -1 : 0 };
    room.connections.set(member.accountId, connection);
    ws.off('message', queuePreSeat);
    ws.on('message', (data) => void handleMessage(connection, data));
    ws.on('close', () => {
      if (room.connections.get(member.accountId)?.ws !== ws) return;
      room.connections.delete(member.accountId);
      markDisconnected(room, member, now());
    });
    ws.on('error', () => {});
    if (!resume) send(connection, 'lobby.welcome', snapshot(room, member.accountId), id(), 0);
    for (const data of preSeatFrames) await handleMessage(connection, data);
  }

  function onUpgrade(request, socket, head) {
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/v1/lobby') return;
    const offered = String(request.headers['sec-websocket-protocol'] || '').split(',')
      .map((value) => value.trim());
    const protocolTicket = offered.find((value) => value.startsWith('overstrike-ticket.'));
    const rawTicket = protocolTicket?.slice('overstrike-ticket.'.length)
      || url.searchParams.get('ticket');
    const record = rawTicket ? tickets.get(rawTicket) : null;
    const at = now();
    if (!record || record.used || record.expiresAt <= at) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    record.used = true;
    tickets.delete(rawTicket);
    const resume = url.searchParams.has('lastSeq');
    wss.handleUpgrade(request, socket, head, (ws) => void acceptSocket(ws, request, record, resume));
  }

  function requireMatchControl(ctx) {
    const presented = Buffer.from(String(ctx.headers?.authorization || ''));
    const expected = Buffer.from(`Bearer ${config.matchControlSecret}`);
    if (!expected.length || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new ApiError('AUTH_REQUIRED', 'Match-server control authentication is required.');
    }
  }

  function exactBody(body, keys) {
    return body && typeof body === 'object' && !Array.isArray(body)
      && Object.keys(body).sort().join(',') === [...keys].sort().join(',');
  }

  function validRegisteredAddress(address) {
    try {
      const url = new URL(address);
      const allowed = (config.matchServerAllowedHosts || new URL(config.matchServerUrl).hostname)
        .split(',').map((value) => value.trim()).filter(Boolean);
      const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
      return (url.protocol === 'wss:' || (config.env !== 'production' && url.protocol === 'ws:' && loopback))
        && !url.username && !url.password && !url.search && !url.hash
        && (url.pathname === '' || url.pathname === '/') && allowed.includes(url.hostname);
    } catch { return false; }
  }

  const handlers = {
    async registerServer(ctx) {
      requireMatchControl(ctx);
      const body = ctx.body;
      if (!exactBody(body, ['serverId', 'region', 'address', 'capacity', 'build'])
        || typeof body.serverId !== 'string' || body.serverId.length < 3 || body.serverId.length > 128
        || !['yyz', 'ord', 'iad'].includes(body.region) || !validRegisteredAddress(body.address)
        || !Number.isInteger(body.capacity) || body.capacity < 1 || body.capacity > 128
        || typeof body.build !== 'string' || !body.build) {
        throw failValidation('Invalid match-server registration.', 'body');
      }
      const row = await store.matchServers.register({ ...body, inUse: 0, status: 'healthy',
        lastHeartbeatAt: iso(now()) });
      return raw(201, { serverId: row.serverId, status: row.status, heartbeatMs: HEARTBEAT_MS,
        serverNow: iso(now()) });
    },
    async heartbeatServer(ctx) {
      requireMatchControl(ctx);
      const body = ctx.body;
      if (!exactBody(body, ['serverId', 'capacity', 'inUse', 'status'])
        || typeof body.serverId !== 'string' || !Number.isInteger(body.capacity)
        || !Number.isInteger(body.inUse) || body.inUse < 0 || body.inUse > body.capacity
        || !['healthy', 'draining', 'unhealthy'].includes(body.status)) {
        throw failValidation('Invalid match-server heartbeat.', 'body');
      }
      const row = await store.matchServers.heartbeat(body.serverId, {
        capacity: body.capacity, inUse: body.inUse, status: body.status, lastHeartbeatAt: iso(now()),
      });
      return { serverId: row.serverId, status: row.status, serverNow: iso(now()) };
    },
    async consumeMatchTicket(ctx) {
      requireMatchControl(ctx);
      const body = ctx.body;
      if (!exactBody(body, ['jti', 'accountId', 'roomId', 'matchId'])
        || !isUlid(body.jti) || !isUlid(body.accountId) || !isUlid(body.roomId) || !isUlid(body.matchId)) {
        throw failValidation('Invalid match-ticket consume request.', 'body');
      }
      const consumed = await store.matchTickets.consume(body.jti, body, iso(now()));
      if (!consumed) throw new ApiError('AUTH_REQUIRED', 'Match ticket is invalid, expired, or already consumed.');
      const cached = matchTickets.get(body.jti); if (cached) cached.used = true;
      return raw(204, null);
    },
    async drainServer(ctx) {
      const presented = Buffer.from(String(ctx.headers?.['x-service-token'] || ''));
      const expected = Buffer.from(String(config.serviceToken || ''));
      if (!expected.length || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        throw new ApiError('AUTH_FORBIDDEN', 'Match-server drain is service-only.');
      }
      if (!exactBody(ctx.body, ['draining']) || typeof ctx.body.draining !== 'boolean') {
        throw failValidation('draining must be boolean.', 'draining');
      }
      const server = await store.matchServers.byId(ctx.params.serverId);
      if (!server) throw new ApiError('NOT_FOUND', 'No such match server.');
      const response = await controlRequest('/control/drain', { draining: ctx.body.draining },
        ctx.correlationId, server.address, ctx.traceparent);
      await store.matchServers.heartbeat(server.serverId, { capacity: server.capacity,
        inUse: server.inUse, status: ctx.body.draining ? 'draining' : 'healthy', lastHeartbeatAt: iso(now()) });
      return { serverId: server.serverId, draining: response.draining, serverNow: iso(now()) };
    },
    async online(ctx) {
      await ensureHydrated();
      touchPresence(ctx.actor.accountId);
      const { limit, cursor } = parseLimit(ctx.query);
      const rows = [];
      for (const [accountId, state] of presence) {
        if (state.lastSeenAt + GRACE_MS <= now() || state.state === 'offline') continue;
        const account = await accountProjection(accountId);
        if (!await presenceVisible(accountId, ctx.actor.accountId)) continue;
        rows.push({ accountId, displayName: account.displayName, state: state.state, joinable: state.joinable, roomId: state.roomId });
      }
      const page = rows.sort((a, b) => a.accountId.localeCompare(b.accountId)).slice(cursor, cursor + limit);
      return { items: page, nextCursor: cursor + limit < rows.length ? String(cursor + limit) : null };
    },
    async recent(ctx) {
      await ensureHydrated();
      const { limit, cursor } = parseLimit(ctx.query);
      const candidates = await store.roomMembers?.recentFor?.(ctx.actor.accountId, limit + 1, cursor) || [];
      const items = [];
      for (const row of candidates.slice(0, limit)) {
        if (!await presenceVisible(row.accountId, ctx.actor.accountId)) continue;
        const account = await accountProjection(row.accountId);
        items.push({ accountId: row.accountId, displayName: account.displayName, encounteredAt: row.encounteredAt });
      }
      return { items, nextCursor: candidates.length > limit ? String(cursor + limit) : null };
    },
    async listRooms(ctx) {
      await ensureHydrated();
      touchPresence(ctx.actor.accountId);
      const { limit, cursor } = parseLimit(ctx.query);
      const rtt = parseRtt(ctx.headers['x-region-rtt']);
      let list = [...rooms.values()].filter((room) => room.status !== 'closing');
      const region = ctx.query.get('region');
      const mode = ctx.query.get('mode');
      const hasSpace = ctx.query.get('hasSpace');
      if (region) list = list.filter((room) => room.region === region);
      if (mode) list = list.filter((room) => room.mode === mode);
      if (hasSpace === 'true') list = list.filter((room) => room.members.size + room.pending.size < room.capacity && room.status === 'open');
      const page = list.slice(cursor, cursor + limit).map((room) => core(room, ctx.actor.accountId, rtt));
      return { items: page, nextCursor: cursor + limit < list.length ? String(cursor + limit) : null };
    },
    async room(ctx) { await ensureHydrated(); return detail(assertRoom(ctx.params.id), ctx.actor.accountId, parseRtt(ctx.headers['x-region-rtt'])); },
    async create(ctx) {
      await ensureHydrated();
      const { name, region, mapId = 'the-square', mode = 'bomb', capacity = 12, password = null } = ctx.body;
      if (typeof name !== 'string' || name.trim().length < 1 || name.length > 60) throw failValidation('Room name is required.', 'name');
      if (!['yyz', 'ord', 'iad'].includes(region)) throw failValidation('Unsupported region.', 'region');
      if (config.env === 'production') {
        const available = await store.matchServers.healthy(region, iso(now() - HEARTBEAT_MS * 2));
        if (!available.length) throw new ApiError('FEATURE_DISABLED', `No healthy match capacity is available in ${region}.`, {
          details: { reason: 'region-unavailable', region },
        });
      }
      if (!['tdm', 'bomb'].includes(mode)) throw failValidation('Unsupported mode.', 'mode');
      if (mapId !== 'the-square') throw failValidation('Unsupported map.', 'mapId');
      const evaluated = flags?.evaluate?.().flags || {};
      if ((mode === 'bomb' && evaluated['mode.bomb.enabled'] !== true)
        || (mapId === 'the-square' && evaluated['map.the_square.enabled'] !== true)) {
        throw new ApiError('FEATURE_DISABLED', 'That map or mode is not currently enabled.', {
          details: { reason: 'feature-disabled', mode, mapId },
        });
      }
      if (!Number.isInteger(capacity) || capacity < 2 || capacity > 12) throw failValidation('capacity must be 2–12.', 'capacity');
      if (password !== null && (typeof password !== 'string' || password.length < 1 || password.length > 64)) throw failValidation('password must be 1–64 characters.', 'password');
      const key = idempotencyKey(ctx);
      const hash = requestHash('POST', '/v1/rooms', ctx.body);
      const creator = await accountProjection(ctx.actor.accountId);
      let createdRoom = null;
      let createdTicket = null;
      try {
        const committed = await outbox.commit({ correlationId: ctx.correlationId,
          actor: playerActor(ctx.actor.accountId), requireEvent: false }, async (tx, emit) => {
          await store.idempotency.acquire?.(key, ctx.actor.accountId, tx);
          const prior = await store.idempotency.get(key, ctx.actor.accountId, tx);
          if (prior) {
            if (prior.requestHash !== hash) throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'That idempotency key was used for a different request.', { details: { key } });
            return { replay: true, body: prior.responseBody };
          }
          const roomId = id();
          const room = {
            roomId, name: name.trim(), region, mapId, mapVersion: '1.0.0', mode,
            rulesetVersion: mode === 'bomb' ? 'bomb-1.0.0' : 'tdm-1.0.0', build: '1.0.0',
            status: 'open', capacity, passwordHash: roomPasswordHash(password, config.tokenSecret), ownerAccountId: ctx.actor.accountId,
            settings: roomSettings(mode, capacity, ctx.body.settings || {}), members: new Map(),
            pending: new Set(), connections: new Map(), countdown: null, chat: [], createdAt: now(),
          };
          const creatorMember = {
            accountId: creator.accountId, displayName: creator.displayName, team: 'alpha', ready: false,
            isOwner: true, connection: 'reconnecting', disconnectedAt: now(), estimatedRttMs: null,
            loadout: { primaryIdx: 0, secondaryIdx: 0 }, joinedAt: iso(now()), muted: new Set(),
            chatTimes: [], pingTimes: [], lastAckAt: now(),
          };
          room.members.set(creatorMember.accountId, creatorMember);
          rooms.set(roomId, room); createdRoom = room;
          const reservation = issueLobbyTicket(room, ctx.actor.accountId, 'join', ctx);
          createdTicket = reservation.lobbyTicket;
          const body = { room: core(room, ctx.actor.accountId), roster: [projectedMember(creatorMember, ctx.actor.accountId)], countdown: null, ...reservation };
          await persistRoom(room, tx);
          await emit(roomEvent('room.created', room, { ownerAccountId: ctx.actor.accountId, mode, mapId, region, capacity }));
          await emit(roomEvent('room.joined', room, { accountId: creatorMember.accountId, team: creatorMember.team }));
          await store.idempotency.put({ key, actorId: ctx.actor.accountId, requestHash: hash,
            responseStatus: 201, responseBody: body, createdAt: iso(now()), expiresAt: iso(now() + IDEMPOTENCY_TTL_MS) }, tx);
          return { replay: false, body };
        });
        const { body } = committed.result;
        if (committed.result.replay && Date.parse(body.expiresAt) > now() && !tickets.has(body.lobbyTicket)) {
          tickets.set(body.lobbyTicket, { lobbyTicket: body.lobbyTicket, roomId: body.room.roomId,
            accountId: ctx.actor.accountId, kind: 'join', createdAt: now(), expiresAt: Date.parse(body.expiresAt), used: false });
        }
        if (createdRoom) touchPresence(ctx.actor.accountId, { state: 'in-lobby', joinable: true, roomId: createdRoom.roomId });
        return raw(201, body);
      } catch (error) {
        if (createdRoom) rooms.delete(createdRoom.roomId);
        if (createdTicket) tickets.delete(createdTicket);
        throw error;
      }
    },
    async join(ctx) {
      await ensureHydrated();
      const key = idempotencyKey(ctx);
      const hash = requestHash('POST', `/v1/rooms/${ctx.params.id}/join`, ctx.body);
      let staged = null;
      let body;
      try {
        body = await store.tx(async (tx) => {
          await store.idempotency.acquire?.(key, ctx.actor.accountId, tx);
          const prior = await store.idempotency.get(key, ctx.actor.accountId, tx);
          if (prior) {
            if (prior.requestHash !== hash) throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'That idempotency key was used for a different request.', { details: { key } });
            return prior.responseBody;
          }
          const room = assertRoom(ctx.params.id);
          const hadPending = room.pending.has(ctx.actor.accountId);
          const response = await reserve(ctx, room);
          staged = { room, hadPending, lobbyTicket: response.lobbyTicket };
          await store.idempotency.put({ key, actorId: ctx.actor.accountId, requestHash: hash,
            responseStatus: 200, responseBody: response, createdAt: iso(now()), expiresAt: iso(now() + IDEMPOTENCY_TTL_MS) }, tx);
          return response;
        });
      } catch (error) {
        if (staged) {
          tickets.delete(staged.lobbyTicket);
          if (!staged.hadPending) staged.room.pending.delete(ctx.actor.accountId);
        }
        throw error;
      }
      if (Date.parse(body.expiresAt) > now() && !tickets.has(body.lobbyTicket)) tickets.set(body.lobbyTicket, {
        lobbyTicket: body.lobbyTicket, roomId: ctx.params.id, accountId: ctx.actor.accountId,
        kind: 'join', createdAt: now(), expiresAt: Date.parse(body.expiresAt), used: false,
      });
      return body;
    },
    async leave(ctx) { await ensureHydrated(); const room = assertRoom(ctx.params.id); await removeMember(room, ctx.actor.accountId, ctx.correlationId, true); return raw(204, null); },
    async reconnect(ctx) {
      await ensureHydrated();
      const room = assertRoom(ctx.params.id);
      const member = room.members.get(ctx.actor.accountId);
      if (!member) throw new ApiError('NOT_IN_ROOM', 'You are not in that room.');
      if (member.connection !== 'connected' && member.disconnectedAt + GRACE_MS <= now()) {
        await removeMember(room, member.accountId, ctx.correlationId);
        throw new ApiError('RECONNECT_GRACE_EXPIRED', 'Your lobby seat was released.', {
          details: { graceEndsAt: iso(member.disconnectedAt + GRACE_MS), roomId: room.roomId, rejoinable: room.status === 'open', reason: 'grace-expired' },
        });
      }
      if (member.connection === 'connected' && room.connections.has(member.accountId)) {
        // A reload cannot close its old socket before asking for a fresh ticket. The new socket
        // atomically replaces it; this is explicit duplicate-session resolution.
        member.disconnectedAt = now();
      }
      return issueLobbyTicket(room, member.accountId, 'reconnect', ctx);
    },
    async team(ctx) {
      await ensureHydrated();
      const room = assertRoom(ctx.params.id); const member = internalMember(room, ctx.actor.accountId);
      if (!member) throw new ApiError('NOT_IN_ROOM', 'You are not in that room.');
      if (room.status !== 'open') throw new ApiError('TEAM_SWITCH_FORBIDDEN', 'Teams are frozen during launch and play.');
      if (!['alpha', 'bravo', 'auto'].includes(ctx.body.team)) throw failValidation('Invalid team.', 'team');
      const team = assignTeam(room, ctx.body.team);
      const previousTeam = member.team;
      const cleared = team !== member.team ? (member.team = team,
        clearReady(room, 'team-change', ctx.correlationId, false)) : [];
      try {
        await commitEvents(ctx.correlationId, playerActor(member.accountId), roomEvent('room.team_changed', room, {
          accountId: member.accountId, team,
        }), (tx) => persistRoom(room, tx));
      } catch (error) {
        member.team = previousTeam; for (const item of cleared) item.ready = true; throw error;
      }
      broadcastReadyClears(room, cleared, 'team-change', ctx.correlationId);
      broadcast(room, 'team.changed', { accountId: member.accountId, team, byServer: ctx.body.team === 'auto' }, ctx.correlationId);
      return detail(room, ctx.actor.accountId);
    },
    async ready(ctx) {
      await ensureHydrated();
      const room = assertRoom(ctx.params.id); const member = internalMember(room, ctx.actor.accountId);
      if (!member) throw new ApiError('NOT_IN_ROOM', 'You are not in that room.');
      if (typeof ctx.body.ready !== 'boolean') throw failValidation('ready must be boolean.', 'ready');
      if (room.status === 'in-progress' || (room.status === 'countdown' && ctx.body.ready)) {
        throw new ApiError('ROOM_IN_PROGRESS', 'Readiness is frozen during launch and play.');
      }
      const previousReady = member.ready; member.ready = ctx.body.ready;
      try {
        await commitEvents(ctx.correlationId, playerActor(member.accountId), roomEvent('room.ready_changed', room, {
          accountId: member.accountId, ready: member.ready,
        }), (tx) => persistRoom(room, tx));
      } catch (error) { member.ready = previousReady; throw error; }
      broadcast(room, 'ready.changed', { accountId: member.accountId, ready: member.ready }, ctx.correlationId);
      if (!member.ready && room.countdown) {
        abortCountdown(room, 'player-unready', ctx.correlationId, { byAccountId: member.accountId });
        await persistRoom(room);
      }
      return detail(room, ctx.actor.accountId);
    },
    async loadout(ctx) {
      await ensureHydrated();
      const room = assertRoom(ctx.params.id); const member = internalMember(room, ctx.actor.accountId);
      if (!member) throw new ApiError('NOT_IN_ROOM', 'You are not in that room.');
      if (room.status !== 'open') throw new ApiError('ROOM_IN_PROGRESS', 'Loadouts are frozen during launch and play.');
      for (const [key, slot] of [['primaryIdx', 'primary'], ['secondaryIdx', 'secondary']]) {
        if (!Number.isInteger(ctx.body[key])
          || !LIVE_LOADOUT_CATALOG[slot].some((item) => item.idx === ctx.body[key] && item.eligible)) {
          throw failValidation(`${key} is not eligible in this catalog.`, key);
        }
      }
      const previousLoadout = clone(member.loadout);
      const previousReady = member.ready;
      member.loadout = { primaryIdx: ctx.body.primaryIdx, secondaryIdx: ctx.body.secondaryIdx };
      member.ready = false;
      try {
        if (previousReady) {
          await commitEvents(ctx.correlationId, playerActor(member.accountId), roomEvent('room.ready_changed', room, {
            accountId: member.accountId, ready: false, clearedReason: 'loadout-change',
          }), (tx) => persistRoom(room, tx));
        } else await persistRoom(room);
      } catch (error) {
        member.loadout = previousLoadout;
        member.ready = previousReady;
        throw error;
      }
      if (previousReady) broadcast(room, 'ready.changed', { accountId: member.accountId, ready: false, clearedReason: 'loadout-change' }, ctx.correlationId);
      broadcastRoster(room, { updated: [member] }, ctx.correlationId);
      return detail(room, ctx.actor.accountId);
    },
    async launch(ctx) {
      await ensureHydrated();
      const room = assertRoom(ctx.params.id); const member = internalMember(room, ctx.actor.accountId);
      if (!member?.isOwner) throw new ApiError('AUTH_FORBIDDEN', 'Only the room owner can start the match.');
      if (room.status !== 'open') throw new ApiError('ROOM_IN_PROGRESS', 'That match is already launching or in progress.');
      const requiredReady = Math.min(room.settings.requiredReady, room.members.size);
      const ready = [...room.members.values()].filter((item) => item.ready).length;
      if (room.members.size < room.settings.minPlayers || ready < requiredReady) {
        throw new ApiError('CONFLICT', 'Everyone has to be ready first.', {
          details: { reason: 'not-all-ready', requiredReady, currentReady: ready },
        });
      }
      await commitEvents(ctx.correlationId, playerActor(member.accountId), roomEvent('room.launch_requested', room, {
        accountId: member.accountId,
      }), (tx) => persistRoom(room, tx));
      startLaunch(room, ctx.correlationId, ctx.traceparent);
      await persistRoom(room);
      return raw(202, {});
    },
    async report(ctx) {
      if (!exactBody(ctx.body, Object.keys(ctx.body).filter((key) =>
        ['subjectAccountId', 'category', 'matchId', 'chatMessageId', 'description'].includes(key)))) {
        throw failValidation('Unknown report field.', 'body');
      }
      const { subjectAccountId, category, matchId = null, chatMessageId = null, description = null } = ctx.body;
      if (!isUlid(subjectAccountId) || !REPORT_CATEGORIES.has(category)
        || (matchId !== null && !isUlid(matchId))
        || (chatMessageId !== null && !isUlid(chatMessageId))
        || (description !== null && (typeof description !== 'string' || description.length > 1000))) {
        throw failValidation('Report fields are invalid.');
      }
      if (subjectAccountId === ctx.actor.accountId) throw failValidation('You cannot report yourself.', 'subjectAccountId');
      let chat = null;
      if (chatMessageId) {
        chat = await store.chatMessages.byId(chatMessageId);
        if (!chat || chat.senderAccountId !== subjectAccountId) {
          throw new ApiError('NOT_FOUND', 'That reportable chat message was not found.');
        }
        if (!await store.roomMembers.wasMemberAt(chat.roomId, ctx.actor.accountId, chat.createdAt)) {
          throw new ApiError('NOT_FOUND', 'That reportable chat message was not found.');
        }
      }
      const key = `${ctx.actor.accountId}\0${subjectAccountId}\0${matchId || ''}\0${chatMessageId || ''}\0${category}`;
      if (reportKeys.has(key)) throw new ApiError('REPORT_DUPLICATE', 'You already reported this incident.');
      const reportId = id();
      const row = { reportId, reporterAccountId: ctx.actor.accountId, subjectAccountId, category,
        matchId, chatMessageId, description, evidenceRef: chat ? `chat:${chat.messageId}` : null, createdAt: iso(now()) };
      await commitEvents(ctx.correlationId, playerActor(ctx.actor.accountId), {
        type: 'report.submitted', subject: { kind: 'account', id: subjectAccountId },
        payload: { reportId, category, matchId, chatMessageId },
      }, (tx) => store.reports?.create?.(row, tx));
      reports.set(reportId, row);
      reportKeys.add(key);
      logger.info('report.created', { reportId, reporterAccountId: ctx.actor.accountId, subjectAccountId, matchId, category, correlationId: ctx.correlationId });
      return raw(201, { reportId });
    },
    async removeChat(ctx) {
      const presented = Buffer.from(String(ctx.headers?.['x-service-token'] || ''));
      const expected = Buffer.from(String(config.serviceToken || ''));
      if (!expected.length || presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        throw new ApiError('AUTH_FORBIDDEN', 'Chat removal is service-only.');
      }
      if (!exactBody(ctx.body, ['reason']) || typeof ctx.body.reason !== 'string'
        || !ctx.body.reason.trim() || ctx.body.reason.length > 128) throw failValidation('Removal reason is required.', 'reason');
      const before = await store.chatMessages.byId(ctx.params.messageId);
      if (!before) throw new ApiError('NOT_FOUND', 'No such chat message.');
      const reason = ctx.body.reason.trim();
      const message = before.removedAt ? before : await commitEvents(ctx.correlationId,
        { kind: 'service', id: 'service:moderation', role: 'moderator' }, {
          type: 'chat.removed', subject: { kind: 'chat-message', id: before.messageId },
          payload: { roomId: before.roomId, reason },
        }, async (tx) => {
          const removed = await store.chatMessages.remove(ctx.params.messageId, 'service:moderation',
            reason, iso(now()), tx);
          await store.audit.insert({
            auditId: id(), actorKind: 'service', actorId: 'service:moderation', actorRole: 'moderator',
            action: 'chat.remove', subjectKind: 'chat-message', subjectId: before.messageId,
            reasonCode: reason, beforeSummary: { removed: false, roomId: before.roomId },
            afterSummary: { removed: true, roomId: before.roomId },
            correlationId: ctx.correlationId, createdAt: iso(now()),
          }, tx);
          return removed;
        });
      const room = rooms.get(message.roomId);
      if (room) {
        const cached = room.chat.find((item) => item.id === message.messageId);
        if (cached) cached.removed = true;
        broadcast(room, 'chat.removed', { messageId: message.messageId, reason: message.removalReason }, ctx.correlationId);
      }
      return { messageId: message.messageId, removedAt: message.removedAt };
    },
    async activeMatch(ctx) {
      for (const match of matches.values()) {
        if (!match.endedAt && match.accountIds.has(ctx.actor.accountId)) {
          let status;
          try { status = await controlStatus(match.serverUrl, ctx.correlationId); } catch { return raw(204, null); }
          if (status.matchId !== match.matchId || status.status === 'ended') return raw(204, null);
          const seat = status.seats?.find((item) => item.accountId === ctx.actor.accountId);
          if (!seat || seat.released) return raw(204, null);
          return {
            matchId: match.matchId, roomId: match.roomId,
            graceEndsAt: seat.graceEndsAt || iso(now() + GRACE_MS), serverNow: iso(now()),
          };
        }
      }
      return raw(204, null);
    },
    async reconnectMatch(ctx) {
      const match = matches.get(ctx.params.matchId);
      if (!match || match.endedAt || !match.accountIds.has(ctx.actor.accountId)) {
        throw new ApiError('NOT_FOUND', 'No active match is held for this account.');
      }
      const status = await controlStatus(match.serverUrl, ctx.correlationId);
      const seat = status.matchId === match.matchId
        ? status.seats?.find((item) => item.accountId === ctx.actor.accountId) : null;
      if (!seat || seat.released || status.status === 'ended') {
        throw new ApiError('RECONNECT_GRACE_EXPIRED', 'Your match entity was released.', {
          details: { matchId: match.matchId, roomId: match.roomId },
        });
      }
      const graceEndsAt = seat.graceEndsAt ? Date.parse(seat.graceEndsAt) : now() + GRACE_MS;
      if (graceEndsAt <= now()) throw new ApiError('RECONNECT_GRACE_EXPIRED', 'Your match entity was released.', {
        details: { matchId: match.matchId, roomId: match.roomId, graceEndsAt: iso(graceEndsAt) },
      });
      return {
        handoff: await handoff(match.room, ctx.actor.accountId, match.matchId, match.serverUrl),
        graceEndsAt: iso(graceEndsAt), serverNow: iso(now()),
      };
    },
  };

  function routes(router) {
    router.post('/v1/control/match-servers/register', handlers.registerServer);
    router.post('/v1/control/match-servers/heartbeat', handlers.heartbeatServer);
    router.post('/v1/control/match-tickets/consume', handlers.consumeMatchTicket);
    router.post('/v1/control/match-servers/:serverId/drain', handlers.drainServer);
    router.get('/v1/presence/online', handlers.online, A);
    router.get('/v1/presence/recent', handlers.recent, A);
    router.get('/v1/rooms', handlers.listRooms, A);
    router.get('/v1/rooms/:id', handlers.room, A);
    router.post('/v1/rooms', handlers.create, ROOM);
    router.post('/v1/rooms/:id/join', handlers.join, ROOM);
    router.post('/v1/rooms/:id/leave', handlers.leave, ROOM);
    router.post('/v1/rooms/:id/team', handlers.team, ROOM);
    router.post('/v1/rooms/:id/ready', handlers.ready, ROOM);
    router.post('/v1/rooms/:id/loadout', handlers.loadout, ROOM);
    router.post('/v1/rooms/:id/launch', handlers.launch, ROOM);
    router.post('/v1/rooms/:id/reconnect-ticket', handlers.reconnect, ROOM);
    router.get('/v1/matches/active', handlers.activeMatch, A);
    router.post('/v1/matches/:matchId/reconnect-ticket', handlers.reconnectMatch, ROOM);
    router.post('/v1/reports', handlers.report, REPORT);
    router.post('/v1/control/chat/:messageId/remove', handlers.removeChat);
  }

  async function sweep() {
    releaseExpiredReservations();
    await store.chatMessages?.purgeExpired?.(iso(now()));
    await store.matchTickets?.purgeExpired?.(iso(now()));
    const at = now();
    for (const room of rooms.values()) {
      for (const member of [...room.members.values()]) {
        if (member.connection === 'connected' && member.lastAckAt + HEARTBEAT_MS * 2 <= at) {
          const connection = room.connections.get(member.accountId);
          if (connection) {
            // Drop the connection here, not in the `close` handler, so nothing tries to send
            // a roster frame down a socket that is already CLOSING.
            room.connections.delete(member.accountId);
            connection.ws.close(1011, 'heartbeat timeout');
          }
          // The seat's grace starts NOW, when the timeout was declared — not whenever the
          // close handshake happens to complete. See `markDisconnected`.
          markDisconnected(room, member, at);
          continue;
        }
        if (member.connection !== 'connected' && member.disconnectedAt + GRACE_MS <= at) await removeMember(room, member.accountId);
      }
    }
    for (const [accountId, state] of presence) if (state.lastSeenAt + GRACE_MS <= at) presence.set(accountId, { ...state, state: 'offline', joinable: false, roomId: null });
    for (const match of [...matches.values()]) {
      if (match.terminalCommitted) {
        try { await reopenAfterTerminal(match, { authorityGone: match.authorityGone }); }
        catch (error) { logger.warn('lobby.terminal_recovery_pending', { matchId: match.matchId, message: error.message }); }
        continue;
      }
      try {
        const status = await controlStatus(match.serverUrl, match.correlationId, match.traceparent);
        if (status.status === 'ended' && status.matchId === match.matchId) await completeActiveMatch(match, status.result);
        else if (status.matchId !== match.matchId) await abortActiveMatch(match, 'allocation-lost', true);
        else match.healthMisses = 0;
      } catch {
        match.healthMisses = (match.healthMisses || 0) + 1;
        if (match.healthMisses >= 3) {
          logger.debug('lobby.match_reap.start', { matchId: match.matchId });
          await abortActiveMatch(match, 'server-unreachable', true);
          logger.debug('lobby.match_reap.complete', { matchId: match.matchId });
        }
      }
    }
  }

  function attach(server) {
    if (attachedServer) throw new Error('lobby: WebSocket server already attached');
    attachedServer = server;
    server.on('upgrade', onUpgrade);
    heartbeatTimer = setInterval(() => {
      void sweep().catch((error) => logger.error('lobby.sweep.failed', { message: error.message }));
      for (const room of rooms.values()) for (const connection of room.connections.values()) send(connection, 'heartbeat', { serverTime: iso(now()) });
    }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  }

  function stop() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (attachedServer) attachedServer.off('upgrade', onUpgrade);
    attachedServer = null;
    for (const room of rooms.values()) for (const connection of room.connections.values()) connection.ws.close(1001, 'server shutdown');
    wss.close();
  }

  function pauseSweeper() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  return { routes, attach, stop, pauseSweeper, handlers, sweep, rooms, tickets, reports, matchTickets, matches, wss };
}
