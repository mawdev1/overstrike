import assert from 'node:assert/strict';
import {
  LobbyProtocolError,
  createLobbyController,
  createLobbyShellAdapter,
  createLobbyState,
  reduceLobbyFrame,
  validateLobbyFrame,
} from '../src/ui/lobby/index.js';
import { createLobbyStub, LOBBY_SCENARIO_NAMES } from '../platform/src/modules/stubs/lobby.js';
import { publicLoadoutCatalog } from '../platform/src/shared/liveCatalog.js';

let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const rejects = async (fn, test, message) => { await assert.rejects(fn, test, message); checks++; };

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
let correlation = 0;
const correlationId = () => `01J10BBY${String(++correlation).padStart(18, '0')}`;

const ACCOUNT_LOCAL = '01K00000000000000000000001';
const ACCOUNT_OTHER = '01K00000000000000000000002';
const ACCOUNT_THIRD = '01K00000000000000000000003';
const ACCOUNT_UNKNOWN = '01K00000000000000000000004';
const ROOM_ALPHA = '01K00000000000000000000010';
const MATCH_ALPHA = '01K00000000000000000000020';
const CHAT_LOCAL = '01K00000000000000000000030';
const CHAT_OTHER = '01K00000000000000000000031';
const CHAT_RECONNECT = '01K00000000000000000000032';
const CHAT_ADAPTER = '01K00000000000000000000033';
const REPORT_ONE = '01K00000000000000000000040';
const INVALID_CC_TIMELINES = Object.freeze(new Set([
  'happy-path', 'team-full', 'countdown-continues', 'countdown-abort-imbalance',
  'handoff-version-mismatch',
]));

function room(roomId = ROOM_ALPHA) {
  return {
    roomId, name: 'Alpha room', region: 'yyz', mapId: 'the-square', mapVersion: '1.0.0',
    mode: 'tdm', rulesetVersion: 'tdm-1.0.0', build: '2026.08.20', status: 'open',
    capacity: 12, playerCount: 2, joinable: true, joinBlockedReason: null,
    hasPassword: false, ownerAccountId: ACCOUNT_LOCAL, estimatedRttMs: 24,
    settings: { killLimit: 75, roundsToWin: null, maxRounds: null, roundLengthSec: null,
      backfill: true, requiredReady: 2, minPlayers: 2 },
  };
}

function member(accountId, { local = false, owner = false, team = 'alpha', ready = false } = {}) {
  return {
    accountId, displayName: local ? 'Local Player' : 'Other Player', team, ready,
    isOwner: owner, isLocal: local, connection: 'connected', estimatedRttMs: 24,
    loadout: { primaryIdx: 0, secondaryIdx: 0 }, joinedAt: iso(-60_000),
  };
}

function snapshot(roomId = ROOM_ALPHA, chatHistory = []) {
  const roster = [
    member(ACCOUNT_LOCAL, { local: true, owner: true }),
    member(ACCOUNT_OTHER, { team: 'bravo' }),
  ];
  return {
    protocol: 1, serverTime: iso(), heartbeatMs: 15000, graceMs: 90000,
    you: { accountId: ACCOUNT_LOCAL, team: 'alpha', ready: false, isOwner: true, seatHeldUntil: null },
    room: room(roomId), roster, countdown: null, chatHistory, mutedAccountIds: [],
    pingCatalog: { version: 1, kinds: ['attack-a', 'attack-b', 'defend-a', 'defend-b', 'regroup', 'enemy-spotted'] },
    loadoutCatalog: publicLoadoutCatalog(),
  };
}

function frame(t, seq, d, id = correlationId()) {
  return { t, seq, ts: iso(seq * 1000), correlationId: id, d };
}

function errorPayload(id, code = 'TEAM_FULL', message = 'That team is full.') {
  return { error: { code, message, correlationId: id, retryable: false, retryAfterMs: null, details: {} } };
}

function handoff() {
  const box = { min: { x: -2, y: 0, z: -2 }, max: { x: 2, y: 2, z: 2 } };
  return {
    matchId: MATCH_ALPHA, serverUrl: 'wss://match.example/ws', sessionTicket: 'match-secret',
    expiresAt: iso(60_000), reconnectGraceMs: 90000, mapId: 'the-square', mapVersion: '1.0.0',
    mode: 'tdm', rulesetVersion: 'tdm-1.0.0', region: 'yyz', serverBuild: '2026.08.20',
    protocolVersion: 3, series: { roundsToWin: 7, maxRounds: 12, sideSwitchAfter: 6, overtime: false },
    spectatorPolicyVersion: 1,
    sites: [
      { id: 'site-A', site: 'A', callout: 'Civic Hall', center: { x: 0, y: 0, z: 0 }, box },
      { id: 'site-B', site: 'B', callout: 'Transit Works', center: { x: 10, y: 0, z: 10 }, box },
    ],
  };
}

class ManualClock {
  constructor() { this.time = NOW; this.nextId = 1; this.timers = new Map(); }
  now = () => this.time;
  setTimeout = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, delay, at: this.time + delay });
    return id;
  };
  clearTimeout = (id) => { this.timers.delete(id); };
  runNext() {
    const entry = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!entry) return null;
    const [id, timer] = entry;
    this.timers.delete(id); this.time = timer.at; timer.callback();
    return timer.delay;
  }
}

class FakeSocket {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.listeners = new Map(); this.closes = []; }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || [];
    list.push(listener); this.listeners.set(type, list);
  }
  emit(type, value = {}) { for (const listener of this.listeners.get(type) || []) listener(value); }
  open() { this.readyState = 1; this.emit('open'); }
  receive(value) { this.emit('message', { data: typeof value === 'string' ? value : JSON.stringify(value) }); }
  send(value) { if (this.readyState !== 1) throw new Error('socket not open'); this.sent.push(JSON.parse(value)); }
  close(code = 1000, reason = '') { this.closes.push({ code, reason }); this.readyState = 3; this.emit('close', { code, reason }); }
  drop(code = 1006, reason = '') { this.readyState = 3; this.emit('close', { code, reason }); }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function validatorChecks() {
  equal(validateLobbyFrame(frame('lobby.welcome', 0, snapshot())).known, true, 'welcome must validate');
  assert.throws(() => validateLobbyFrame(frame('lobby.welcome', 1, snapshot())), LobbyProtocolError);
  checks++;
  const extraRoom = room(); extraRoom.invented = true;
  const bad = snapshot(); bad.room = extraRoom;
  assert.throws(() => validateLobbyFrame(frame('lobby.welcome', 0, bad)), /closed-key/);
  checks++;
  const duplicate = snapshot(); duplicate.roster[1].accountId = ACCOUNT_LOCAL;
  assert.throws(() => validateLobbyFrame(frame('lobby.welcome', 0, duplicate)), /unique complete roster/);
  checks++;
  const wrongCount = snapshot(); wrongCount.room.playerCount = 3;
  assert.throws(() => validateLobbyFrame(frame('lobby.welcome', 0, wrongCount)), /unique complete roster/);
  checks++;
  const mutable = frame('room.updated', 1, { status: 'countdown' });
  equal(validateLobbyFrame(mutable).known, true, 'closed mutable room patch must validate');
  assert.throws(() => validateLobbyFrame(frame('room.updated', 1, { mapId: 'other' })), /mutable RoomCore key/);
  checks++;
  equal(validateLobbyFrame(frame('future.additive', 1, { anything: true })).known, false, 'unknown additive messages must be ignored');
  const badMode = handoff(); badMode.mode = 'invented';
  assert.throws(() => validateLobbyFrame(frame('match.ready', 1, badMode)), /tdm or bomb/);
  checks++;
  const badServerUrl = handoff(); badServerUrl.serverUrl = 'https://match.example/session';
  assert.throws(() => validateLobbyFrame(frame('match.ready', 1, badServerUrl)), /wss/);
  checks++;
  const nonUlid = frame('heartbeat', 1, { serverTime: iso() }); nonUlid.correlationId = 'not-a-ulid';
  assert.throws(() => validateLobbyFrame(nonUlid), /lobby envelope/);
  checks++;
  const nonUtc = frame('heartbeat', 1, { serverTime: iso() }); nonUtc.ts = '08/20/2026';
  assert.throws(() => validateLobbyFrame(nonUtc), /lobby envelope/);
  checks++;
  const impossibleUtc = frame('heartbeat', 1, { serverTime: iso() });
  impossibleUtc.ts = '2026-02-31T00:00:00.000Z';
  assert.throws(() => validateLobbyFrame(impossibleUtc), /lobby envelope/);
  checks++;
  const inventedErrorId = correlationId();
  const inventedError = frame('error', 1, errorPayload(inventedErrorId, 'INVENTED_CODE'), inventedErrorId);
  assert.throws(() => validateLobbyFrame(inventedError), /error envelope/);
  checks++;
  const retryMismatchId = correlationId();
  const retryMismatch = frame('error', 1, errorPayload(retryMismatchId, 'TEAM_FULL'), retryMismatchId);
  retryMismatch.d.error.retryable = true;
  assert.throws(() => validateLobbyFrame(retryMismatch), /error envelope/);
  checks++;
  const bombBackfill = snapshot();
  bombBackfill.room.mode = 'bomb';
  bombBackfill.room.settings = { killLimit: null, roundsToWin: 7, maxRounds: 12,
    roundLengthSec: 105, backfill: true, requiredReady: 2, minPlayers: 2 };
  assert.throws(() => validateLobbyFrame(frame('lobby.welcome', 0, bombBackfill)), /false for bomb/);
  checks++;
  const wrongLocal = snapshot(); wrongLocal.roster[1].isLocal = true;
  assert.throws(() => validateLobbyFrame(frame('lobby.welcome', 0, wrongLocal)), /exactly one local/);
  checks++;
  const wrongOwner = snapshot(); wrongOwner.roster[0].isOwner = false;
  assert.throws(() => validateLobbyFrame(frame('lobby.welcome', 0, wrongOwner)), /projection matching roster member|exactly one owner/);
  checks++;
  const state = createLobbyState();
  reduceLobbyFrame(state, frame('future.additive', 1, { anything: true }));
  equal(state.lastSeq, 1, 'ignored additive frames must still advance the received sequence');

  const semanticState = createLobbyState();
  reduceLobbyFrame(semanticState, frame('lobby.welcome', 0, snapshot()));
  assert.throws(() => reduceLobbyFrame(semanticState, frame('roster.delta', 1, {
    added: [], updated: [member(ACCOUNT_UNKNOWN)], removed: [],
  })), /authoritative roster/);
  checks++;
  assert.throws(() => reduceLobbyFrame(semanticState, frame('team.changed', 1, {
    accountId: ACCOUNT_UNKNOWN, team: 'bravo', byServer: false,
  })), /unknown roster member/);
  checks++;
  const localCorruption = member(ACCOUNT_OTHER, { local: true, team: 'bravo' });
  assert.throws(() => reduceLobbyFrame(semanticState, frame('roster.delta', 1, {
    added: [], updated: [localCorruption], removed: [],
  })), /exactly one local/);
  checks++;
  equal(semanticState.roster.filter((item) => item.isLocal).map((item) => item.accountId), [ACCOUNT_LOCAL],
    'rejected semantic delta must not mutate the authoritative roster');
  assert.throws(() => reduceLobbyFrame(semanticState, frame('countdown.started', 1, {
    endsAt: iso(20_000), requiredReady: 2, currentReady: 2,
  })), /authoritative ready roster/);
  checks++;
  const mismatchedHandoff = handoff();
  mismatchedHandoff.mode = 'bomb';
  mismatchedHandoff.rulesetVersion = 'bomb-1.0.0';
  assert.throws(() => reduceLobbyFrame(semanticState, frame('match.ready', 1, mismatchedHandoff)),
    /contradicts immutable RoomCore/);
  checks++;

  const invalidTimelines = [];
  for (const scenario of LOBBY_SCENARIO_NAMES) {
    const timeline = createLobbyStub({ scenario }).steps();
    equal(timeline, createLobbyStub({ scenario }).steps(), `${scenario}: lobby stub timeline must replay deterministically`);
    const timelineState = createLobbyState();
    if (INVALID_CC_TIMELINES.has(scenario)) {
      assert.throws(() => {
        for (const step of timeline) {
          if (step.dir === 'server' && step.kind === 'frame') reduceLobbyFrame(timelineState, step.frame);
        }
      }, /exactly one owner matching RoomCore|contradicts immutable RoomCore/,
      `${scenario}: documented invalid CC projection must remain fail-closed`);
      checks++;
      invalidTimelines.push(scenario);
      continue;
    }
    for (const step of timeline) {
      if (step.dir !== 'server' || step.kind !== 'frame') continue;
      equal(validateLobbyFrame(step.frame).known, true,
        `${scenario}: every scripted server frame must satisfy the frozen lobby contract`);
      reduceLobbyFrame(timelineState, step.frame);
    }
  }
  equal(new Set(invalidTimelines), INVALID_CC_TIMELINES,
    'only the five documented CC timelines may remain contract-invalid');
}

async function controllerChecks() {
  const clock = new ManualClock();
  const sockets = [];
  const reports = [];
  const invalidTicketController = createLobbyController({
    clock, createCorrelationId: correlationId,
    webSocketFactory() { throw new Error('invalid ticket must fail before opening a socket'); },
  });
  await rejects(() => invalidTicketController.connect({
    lobbySocketUrl: 'wss://lobby.example/v1/lobby', lobbyTicket: 'invalid-date',
    expiresAt: '2026-02-31T00:00:00.000Z',
  }), TypeError, 'ticket expiry must be a real UTC calendar instant');
  invalidTicketController.destroy();
  const controller = createLobbyController({
    roomId: ROOM_ALPHA, clock, random: () => 0.5, createCorrelationId: correlationId,
    webSocketFactory(url, protocols) { const socket = new FakeSocket(url); socket.protocols = protocols;
      sockets.push(socket); return socket; },
    reconnectTicket: async ({ attempt }) => ({
      lobbySocketUrl: 'wss://lobby.example/v1/lobby', lobbyTicket: `fresh-${attempt}`,
      expiresAt: iso(30_000), graceEndsAt: iso(90_000),
    }),
    reportAdapter: async (body) => { reports.push(body); return { reportId: REPORT_ONE }; },
  });
  const observed = [];
  controller.subscribe((value) => observed.push(value.status));
  const connected = controller.connect({
    lobbySocketUrl: 'wss://lobby.example/v1/lobby?old=1', lobbyTicket: 'initial-secret', expiresAt: iso(30_000),
  });
  equal(sockets.length, 1, 'connect must construct one socket');
  const initialUrl = new URL(sockets[0].url);
  equal(initialUrl.searchParams.get('ticket'), null, 'ticket must never enter the socket URL');
  equal(sockets[0].protocols, ['overstrike-lobby-v1', 'overstrike-ticket.initial-secret'],
    'ticket uses the WebSocket protocol header rather than URL/history');
  equal(initialUrl.searchParams.get('old'), '1', 'socket URL parameters must be preserved');
  sockets[0].open();
  sockets[0].receive(frame('lobby.welcome', 0, snapshot()));
  await connected;
  equal(controller.getSnapshot().status, 'synchronized', 'welcome must synchronize lobby');
  equal(controller.getSnapshot().roster.length, 2, 'welcome must install complete roster');

  // Unknown additive types do not create a false gap.
  sockets[0].receive(frame('future.additive', 1, { value: 1 }));
  sockets[0].receive(frame('presence.delta', 2, {
    accountId: ACCOUNT_THIRD, state: 'online', joinable: false, roomId: null,
  }));
  equal(controller.getSnapshot().presence[ACCOUNT_THIRD].state, 'online', 'presence delta after unknown type must apply without resync');

  // A real gap requests one resync and refuses deltas until an authoritative snapshot.
  sockets[0].receive(frame('heartbeat', 4, { serverTime: iso(4_000) }));
  equal(controller.getSnapshot().status, 'resyncing', 'sequence gap must enter resync state');
  equal(sockets[0].sent.at(-1).t, 'state.resync', 'sequence gap must request a snapshot');
  equal(sockets[0].sent.at(-1).d.lastSeq, 2, 'resync must name the last incorporated sequence');
  equal(sockets[0].sent.at(-2).t, 'heartbeat.ack', 'gap heartbeat must still be acknowledged before resync');
  const resyncId = sockets[0].sent.at(-1).correlationId;
  sockets[0].receive(frame('heartbeat', 5, { serverTime: iso(5_000) }));
  equal(sockets[0].sent.at(-1).t, 'heartbeat.ack', 'heartbeats during resync must preserve liveness');
  equal(controller.getSnapshot().room.name, 'Alpha room', 'deltas during resync must not be guessed/merged');
  sockets[0].receive(frame('state.snapshot', 5, snapshot(ROOM_ALPHA), resyncId));
  equal(controller.getSnapshot().status, 'synchronized', 'state.snapshot must finish resync');

  const teamId = controller.requestTeam('bravo');
  const deniedTeam = controller.waitForCorrelation(teamId);
  equal(controller.getSnapshot().roster[0].team, 'alpha', 'specific team request must not overwrite authoritative team');
  equal(controller.getSnapshot().optimistic.team, 'bravo', 'specific team request must expose a separate pending treatment');
  sockets[0].receive(frame('error', 6, errorPayload(teamId), teamId));
  await rejects(() => deniedTeam, (error) => error.code === 'TEAM_FULL', 'authoritative error must reject the correlated request promise');
  equal(controller.getSnapshot().roster[0].team, 'alpha', 'refused optimistic team request must revert');
  equal(controller.getSnapshot().optimistic.team, null, 'refused optimistic team request must clear pending treatment');
  equal(controller.getSnapshot().failure.code, 'TEAM_FULL', 'refusal code must remain available to UI');

  const autoId = controller.requestTeam('auto');
  equal(controller.getSnapshot().roster[0].team, 'alpha', 'auto preference must not fabricate a team assignment');
  equal(controller.getSnapshot().optimistic.team, 'auto', 'auto preference must remain visible as intent');
  sockets[0].receive(frame('team.changed', 7, { accountId: ACCOUNT_LOCAL, team: 'bravo', byServer: true }, autoId));
  equal(controller.getSnapshot().roster[0].team, 'bravo', 'authoritative team.changed must settle auto preference');
  check(controller.getSnapshot().notice.includes('balanced'), 'server balancing must be explained');

  const readyId = controller.setReady(true);
  equal(controller.getSnapshot().you.ready, false, 'ready request must preserve authoritative state');
  equal(controller.getSnapshot().optimistic.ready, true, 'ready request must expose separate pending state');
  sockets[0].receive(frame('ready.changed', 8, { accountId: ACCOUNT_LOCAL, ready: true }, readyId));
  equal(Object.keys(controller.getSnapshot().pending).length, 0, 'ready confirmation must clear pending request');
  sockets[0].receive(frame('ready.changed', 9, { accountId: ACCOUNT_LOCAL, ready: false, clearedReason: 'loadout-change' }));
  check(controller.getSnapshot().notice.includes('loadout-change'), 'readiness invalidation reason must remain visible');

  const loadoutId = controller.setLoadout({ primaryIdx: 1, secondaryIdx: 0 });
  equal(controller.getSnapshot().roster[0].loadout.primaryIdx, 0, 'loadout request must preserve authoritative values');
  equal(controller.getSnapshot().optimistic.loadout, { primaryIdx: 1, secondaryIdx: 0 }, 'loadout request must expose separate pending values');
  const updatedLocal = member(ACCOUNT_LOCAL, { local: true, owner: true, team: 'bravo' });
  updatedLocal.loadout = { primaryIdx: 1, secondaryIdx: 0 };
  sockets[0].receive(frame('roster.delta', 10, { added: [], updated: [updatedLocal], removed: [] }, loadoutId));
  equal(Object.keys(controller.getSnapshot().pending).length, 0, 'authoritative roster delta must settle loadout');

  const chatId = controller.sendChat('hello room');
  sockets[0].receive(frame('chat.message', 11, {
    id: CHAT_LOCAL, accountId: ACCOUNT_LOCAL, displayName: 'Local Player', text: 'hello room', ts: iso(), filtered: false,
  }, chatId));
  equal(controller.getSnapshot().chatHistory.at(-1).text, 'hello room', 'chat confirmation must append authoritative message');
  const muteId = controller.setMuted(ACCOUNT_OTHER, true);
  sockets[0].receive(frame('mute.changed', 12, { accountId: ACCOUNT_OTHER, muted: true }, muteId));
  sockets[0].receive(frame('chat.message', 13, {
    id: CHAT_OTHER, accountId: ACCOUNT_OTHER, displayName: 'Other Player', text: 'muted', ts: iso(), filtered: false,
  }));
  check(!controller.getSnapshot().chatHistory.some((item) => item.id === CHAT_OTHER), 'muted account messages must not render');
  sockets[0].receive(frame('chat.removed', 14, { id: CHAT_LOCAL, reason: 'moderated' }));
  equal(controller.getSnapshot().chatHistory.length, 0, 'moderation retraction must remove shipped chat');

  const pingId = controller.sendPing('attack-a');
  sockets[0].receive(frame('ping.placed', 15, { accountId: ACCOUNT_LOCAL, kind: 'attack-a' }, pingId));
  equal(Object.keys(controller.getSnapshot().pending).length, 0, 'authoritative ping must settle pending intent');
  await controller.reportPlayer({ subjectAccountId: ACCOUNT_OTHER, category: 'griefing',
    chatMessageId: CHAT_OTHER, description: 'Blocked team route.' });
  equal(reports[0], { subjectAccountId: ACCOUNT_OTHER, category: 'griefing',
    chatMessageId: CHAT_OTHER, description: 'Blocked team route.' },
  'report adapter must preserve the evidence-linked chat message id');
  await rejects(() => controller.reportPlayer({ subjectAccountId: ACCOUNT_OTHER, category: 'griefing',
    chatMessageId: '' }), TypeError, 'report chat message ids must be non-empty strings');
  await rejects(() => controller.reportPlayer({ subjectAccountId: ACCOUNT_OTHER, category: 'invented' }), TypeError, 'report categories must be closed');

  sockets[0].receive(frame('heartbeat', 15, { serverTime: iso(15_000) }));
  equal(sockets[0].sent.at(-1).t, 'heartbeat.ack', 'heartbeat must be acknowledged');
  sockets[0].receive(frame('ready.changed', 16, { accountId: ACCOUNT_LOCAL, ready: true }));
  sockets[0].receive(frame('ready.changed', 17, { accountId: ACCOUNT_OTHER, ready: true }));
  sockets[0].receive(frame('countdown.started', 18, { endsAt: iso(20_000), requiredReady: 2, currentReady: 2 }));
  equal(controller.getSnapshot().status, 'countdown', 'countdown start must be explicit');
  sockets[0].receive(frame('countdown.tick', 19, { remainingMs: 3000 }));
  equal(controller.getSnapshot().countdownRemainingMs, 3000, 'countdown tick must remain server-derived');
  sockets[0].receive(frame('countdown.aborted', 20, { reason: 'player-unready', byAccountId: ACCOUNT_OTHER }));
  equal(controller.getSnapshot().countdown, null, 'countdown abort must clear countdown');
  sockets[0].receive(frame('match.allocating', 21, {}));
  equal(controller.getSnapshot().status, 'allocating', 'allocation phase must be represented');
  sockets[0].receive(frame('match.ready', 22, handoff()));
  equal(controller.getSnapshot().handoff.matchId, MATCH_ALPHA, 'match.ready must retain complete handoff in memory');

  // Reconnect uses a fresh ticket and sends resync only after the new socket opens.
  sockets[0].drop();
  await flush();
  equal(sockets.length, 1, 'reconnect must honor the initial one-second backoff');
  equal(clock.runNext(), 1000, 'first reconnect attempt must start after one second');
  await flush();
  equal(sockets.length, 2, 'unexpected close must request and open a fresh-ticket socket');
  equal(new URL(sockets[1].url).searchParams.get('ticket'), null, 'reconnect URL contains no credential');
  equal(sockets[1].protocols[1], 'overstrike-ticket.fresh-1', 'reconnect must not replay consumed ticket');
  sockets[1].open();
  equal(sockets[1].sent[0].t, 'state.resync', 'reconnected socket must request authoritative state');
  equal(sockets[1].sent[0].d.lastSeq, 22, 'reconnect resync must name last incorporated sequence');
  const reconnectResyncId = sockets[1].sent[0].correlationId;
  sockets[1].receive(frame('state.snapshot', 23, snapshot(ROOM_ALPHA, [{
    id: CHAT_RECONNECT, accountId: ACCOUNT_LOCAL, displayName: 'Local Player', text: 'new scope', ts: iso(), filtered: false,
  }]), reconnectResyncId));
  equal(controller.getSnapshot().status, 'synchronized', 'reconnect snapshot must restore synchronized state');
  equal(controller.getSnapshot().chatHistory.map((item) => item.id), [CHAT_RECONNECT], 'snapshot must replace, never merge, room-scoped chat');
  equal(controller.getSnapshot().reconnect, null, 'successful resync must clear reconnect UI');
  controller.destroy();
  check(observed.includes('resyncing') && observed.includes('reconnecting'), 'subscribers must see resync and reconnect states');
}

async function retryAndCancelChecks() {
  const clock = new ManualClock();
  const sockets = [];
  let ticketCalls = 0;
  const controller = createLobbyController({
    roomId: ROOM_ALPHA, clock, random: () => 0.5, createCorrelationId: correlationId,
    webSocketFactory(url) { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    reconnectTicket: async () => { ticketCalls++; throw Object.assign(new Error('offline'), { code: 'CLIENT_NETWORK' }); },
  });
  const initial = controller.connect({ lobbySocketUrl: 'wss://lobby.example/ws', lobbyTicket: 'initial', expiresAt: iso(30_000) });
  sockets[0].open(); sockets[0].receive(frame('lobby.welcome', 0, snapshot())); await initial;
  sockets[0].drop(); await flush();
  equal(ticketCalls, 0, 'first reconnect ticket attempt must wait for the published backoff');
  const delays = [];
  while (clock.timers.size) { delays.push(clock.runNext()); await flush(); }
  equal(ticketCalls, 5, 'reconnect attempts must stop at the contracted five');
  equal(delays, [1000, 2000, 4000, 8000, 15000], 'reconnect must use bounded exponential backoff from one second');
  equal(controller.getSnapshot().status, 'closed', 'exhausted reconnect must terminate');
  equal(controller.getSnapshot().reconnect, null, 'exhausted reconnect must clear active retry state');
  controller.destroy();

  const missingGraceClock = new ManualClock();
  const missingGraceSockets = [];
  const missingGrace = createLobbyController({
    roomId: ROOM_ALPHA, clock: missingGraceClock, random: () => 0.5,
    createCorrelationId: correlationId,
    webSocketFactory(url) { const socket = new FakeSocket(url); missingGraceSockets.push(socket); return socket; },
    reconnectTicket: async () => ({
      lobbySocketUrl: 'wss://lobby.example/ws', lobbyTicket: 'missing-grace', expiresAt: iso(30_000),
    }),
  });
  const missingGraceInitial = missingGrace.connect({
    lobbySocketUrl: 'wss://lobby.example/ws', lobbyTicket: 'initial', expiresAt: iso(30_000),
  });
  missingGraceSockets[0].open();
  missingGraceSockets[0].receive(frame('lobby.welcome', 0, snapshot()));
  await missingGraceInitial;
  missingGraceSockets[0].drop();
  missingGraceClock.runNext();
  await flush();
  equal(missingGraceSockets.length, 1,
    'reconnect response missing graceEndsAt must fail before a replacement socket opens');
  equal(missingGrace.getSnapshot().reconnect.attempt, 1,
    'invalid reconnect response remains a failed bounded attempt rather than a connection');
  missingGrace.destroy();

  const cancelClock = new ManualClock();
  const cancelSockets = [];
  let cancelCalls = 0;
  const cancellable = createLobbyController({
    roomId: ROOM_ALPHA, clock: cancelClock, random: () => 0.5, createCorrelationId: correlationId,
    webSocketFactory(url) { const socket = new FakeSocket(url); cancelSockets.push(socket); return socket; },
    reconnectTicket: async () => { cancelCalls++; throw Object.assign(new Error('offline'), { code: 'CLIENT_NETWORK' }); },
  });
  const ready = cancellable.connect({ lobbySocketUrl: 'wss://lobby.example/ws', lobbyTicket: 'initial', expiresAt: iso(30_000) });
  cancelSockets[0].open(); cancelSockets[0].receive(frame('lobby.welcome', 0, snapshot())); await ready;
  cancelSockets[0].drop(); await flush();
  equal(cancelClock.timers.size, 1, 'reconnect must expose its scheduled first attempt');
  equal(cancellable.cancelReconnect(), true, 'visible reconnect must be cancellable');
  equal(cancelClock.timers.size, 0, 'cancelling reconnect must remove pending timer');
  equal(cancellable.getSnapshot().failure.code, 'CLIENT_CANCELLED', 'cancel must have a distinct terminal reason');
  equal(cancelClock.runNext(), null, 'cancelled reconnect must perform no later work');
  equal(cancelCalls, 0, 'cancelling before the first backoff must mint no ticket');
  cancellable.destroy();

  const resyncClock = new ManualClock();
  const resyncSockets = [];
  const cancelDuringResync = createLobbyController({
    roomId: ROOM_ALPHA, clock: resyncClock, random: () => 0.5, createCorrelationId: correlationId,
    webSocketFactory(url) { const socket = new FakeSocket(url); resyncSockets.push(socket); return socket; },
    reconnectTicket: async () => ({ lobbySocketUrl: 'wss://lobby.example/ws',
      lobbyTicket: 'fresh', expiresAt: iso(30_000), graceEndsAt: iso(90_000) }),
  });
  const resyncInitial = cancelDuringResync.connect({ lobbySocketUrl: 'wss://lobby.example/ws', lobbyTicket: 'initial', expiresAt: iso(30_000) });
  resyncSockets[0].open(); resyncSockets[0].receive(frame('lobby.welcome', 0, snapshot())); await resyncInitial;
  resyncSockets[0].drop(); resyncClock.runNext(); await flush();
  resyncSockets[1].open();
  equal(cancelDuringResync.getSnapshot().status, 'resyncing', 'opened reconnect socket must expose cancellable resync');
  equal(cancelDuringResync.cancelReconnect(), true, 'resync in progress must remain cancellable');
  equal(cancelDuringResync.getSnapshot().failure.code, 'CLIENT_CANCELLED', 'resync cancellation must be terminal and explicit');
  cancelDuringResync.destroy();
}

async function confirmationTimeoutChecks() {
  const clock = new ManualClock();
  const sockets = [];
  const controller = createLobbyController({
    roomId: ROOM_ALPHA, clock, createCorrelationId: correlationId,
    webSocketFactory(url) { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
  });
  const connecting = controller.connect({ lobbySocketUrl: 'wss://lobby.example/ws', lobbyTicket: 'initial', expiresAt: iso(30_000) });
  sockets[0].open(); sockets[0].receive(frame('lobby.welcome', 0, snapshot())); await connecting;
  const readyId = controller.setReady(true);
  const confirmation = controller.waitForCorrelation(readyId, 50);
  equal(clock.runNext(), 50, 'request confirmation timeout must use its exact deadline');
  await rejects(() => confirmation, (error) => error.code === 'CLIENT_TIMEOUT', 'unconfirmed request must reject as uncertain');
  equal(Object.keys(controller.getSnapshot().pending).length, 0, 'timed-out intent must not leave controls permanently pending');
  equal(controller.getSnapshot().status, 'resyncing', 'uncertain timeout must request authoritative resynchronization');
  equal(sockets[0].sent.at(-1).t, 'state.resync', 'uncertain timeout must emit one state.resync');
  const resyncId = sockets[0].sent.at(-1).correlationId;
  sockets[0].receive(frame('state.snapshot', 1, snapshot(), resyncId));
  controller.destroy();
}

async function malformedChecks() {
  const sockets = [];
  const clock = new ManualClock();
  const controller = createLobbyController({
    roomId: ROOM_ALPHA, clock, createCorrelationId: correlationId,
    webSocketFactory(url) { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
  });
  const connecting = controller.connect({ lobbySocketUrl: 'wss://lobby.example/ws', lobbyTicket: 'initial', expiresAt: iso(30_000) });
  sockets[0].open(); sockets[0].receive('{not-json');
  await rejects(() => connecting, LobbyProtocolError, 'invalid JSON before welcome must reject connect');
  equal(sockets[0].closes[0].code, 1002, 'malformed server input must close with protocol error');
  equal(controller.getSnapshot().status, 'failed', 'malformed server input must fail closed');
  controller.destroy();

  const unsolicitedSockets = [];
  const unsolicited = createLobbyController({
    roomId: ROOM_ALPHA, clock: new ManualClock(), createCorrelationId: correlationId,
    webSocketFactory(url) { const socket = new FakeSocket(url); unsolicitedSockets.push(socket); return socket; },
  });
  const accepted = unsolicited.connect({ lobbySocketUrl: 'wss://lobby.example/ws', lobbyTicket: 'initial', expiresAt: iso(30_000) });
  unsolicitedSockets[0].open(); unsolicitedSockets[0].receive(frame('lobby.welcome', 0, snapshot())); await accepted;
  unsolicitedSockets[0].receive(frame('state.snapshot', 1, snapshot()));
  equal(unsolicited.getSnapshot().status, 'failed', 'unsolicited snapshots must fail closed');
  equal(unsolicitedSockets[0].closes[0].code, 1002, 'unsolicited snapshots must close as protocol errors');
  unsolicited.destroy();

  const mismatchedSockets = [];
  const mismatched = createLobbyController({
    roomId: ROOM_ALPHA, clock: new ManualClock(), createCorrelationId: correlationId,
    webSocketFactory(url) { const socket = new FakeSocket(url); mismatchedSockets.push(socket); return socket; },
  });
  const mismatchedAccepted = mismatched.connect({ lobbySocketUrl: 'wss://lobby.example/ws', lobbyTicket: 'initial', expiresAt: iso(30_000) });
  mismatchedSockets[0].open(); mismatchedSockets[0].receive(frame('lobby.welcome', 0, snapshot())); await mismatchedAccepted;
  mismatchedSockets[0].receive(frame('room.updated', 2, { name: 'gap' }));
  equal(mismatchedSockets[0].sent.at(-1).t, 'state.resync', 'gap must create a correlated resync request');
  mismatchedSockets[0].receive(frame('state.snapshot', 2, snapshot(), correlationId()));
  equal(mismatched.getSnapshot().status, 'failed', 'snapshot with the wrong resync correlation must fail closed');
  mismatched.destroy();

  const duplicateSockets = [];
  const duplicateController = createLobbyController({
    roomId: ROOM_ALPHA, clock: new ManualClock(), createCorrelationId: correlationId,
    webSocketFactory(url) { const socket = new FakeSocket(url); duplicateSockets.push(socket); return socket; },
  });
  const duplicateAccepted = duplicateController.connect({ lobbySocketUrl: 'wss://lobby.example/ws', lobbyTicket: 'initial', expiresAt: iso(30_000) });
  duplicateSockets[0].open(); duplicateSockets[0].receive(frame('lobby.welcome', 0, snapshot())); await duplicateAccepted;
  const malformedDuplicate = frame('future.additive', 0, {});
  malformedDuplicate.seq = 'invalid';
  duplicateSockets[0].receive(malformedDuplicate);
  equal(duplicateController.getSnapshot().status, 'failed', 'malformed old-sequence frames must be validated, not silently ignored');
  duplicateController.destroy();
}

async function heartbeatChecks() {
  const clock = new ManualClock();
  const sockets = [];
  const controller = createLobbyController({
    roomId: ROOM_ALPHA, clock, createCorrelationId: correlationId,
    webSocketFactory(url) { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
  });
  const connecting = controller.connect({ lobbySocketUrl: 'wss://lobby.example/ws', lobbyTicket: 'initial', expiresAt: iso(30_000) });
  sockets[0].open(); sockets[0].receive(frame('lobby.welcome', 0, snapshot())); await connecting;
  equal(clock.runNext(), 30_000, 'two missed heartbeat intervals must trigger the watchdog');
  equal(sockets[0].closes[0], { code: 4000, reason: 'two lobby heartbeats missed' }, 'watchdog must close the stale socket');
  equal(controller.getSnapshot().status, 'closed', 'missed heartbeats without a ticket adapter must terminate visibly');
  controller.destroy();
}

async function staleSocketChecks() {
  const clock = new ManualClock();
  const sockets = [];
  const controller = createLobbyController({
    roomId: ROOM_ALPHA, clock, createCorrelationId: correlationId,
    webSocketFactory(url) { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
  });
  const first = controller.connect({ lobbySocketUrl: 'wss://lobby.example/ws', lobbyTicket: 'first', expiresAt: iso(30_000) });
  sockets[0].open(); sockets[0].receive(frame('lobby.welcome', 0, snapshot())); await first;
  const oldSocket = sockets[0];
  oldSocket.close = function delayedClose(code = 1000, reason = '') {
    this.closes.push({ code, reason }); this.readyState = 3;
  };
  controller.disconnect();
  await rejects(
    () => controller.connect({ lobbySocketUrl: 'wss://lobby.example/ws', lobbyTicket: 'second', expiresAt: iso(30_000) }),
    /new lobby controller/,
    'a disconnected controller must not be reused across lobby lifetimes',
  );
  oldSocket.emit('close', { code: 1000, reason: 'late close' });
  oldSocket.receive(frame('room.updated', 1, { name: 'stale mutation' }));
  equal(controller.getSnapshot().status, 'closed', 'a delayed intentional close must leave the controller closed');
  equal(controller.getSnapshot().room.name, 'Alpha room', 'a delayed old-socket message must not mutate closed state');
  controller.destroy();
}

async function shellAdapterChecks() {
  const clock = new ManualClock();
  const sockets = [];
  const reports = [];
  const snapshots = [];
  const handoffs = [];
  const leaves = [];
  const joinStages = [];
  let joinCalls = 0;
  let reconnectCalls = 0;
  const http = {
    async joinRoom({ roomId }) {
      joinCalls++;
      if (joinCalls === 1) throw Object.assign(new Error('reservation expired'), { code: 'SLOT_RESERVATION_EXPIRED' });
      return { roomId, reservationId: 'reservation-1', lobbySocketUrl: 'wss://lobby.example/ws',
        lobbyTicket: 'join-ticket', expiresAt: iso(30_000) };
    },
    async reconnectRoom({ roomId }) {
      reconnectCalls++;
      return { roomId, lobbySocketUrl: 'wss://lobby.example/ws', lobbyTicket: 'reconnect-ticket',
        expiresAt: iso(30_000), graceEndsAt: iso(90_000) };
    },
    async reportPlayer(payload) { reports.push(payload); return { reportId: 'report-adapter' }; },
    async leaveRoom(payload) { leaves.push(payload); return { correlationId: 'leave-http-confirmed' }; },
    async getActiveMatch() { throw new Error('HTTP active-match fallback must not replace lobby handoff.'); },
  };
  const adapter = createLobbyShellAdapter({
    client: http,
    createController: (options) => createLobbyController({
      ...options, clock, random: () => 0.5, createCorrelationId: correlationId,
    }),
    webSocketFactory(url) { const socket = new FakeSocket(url); sockets.push(socket); return socket; },
    onSnapshot: (value) => snapshots.push(value),
    onMatchReady: (value) => handoffs.push(value),
  });

  const joining = adapter.joinRoom({ roomId: ROOM_ALPHA, onStage: (stage) => joinStages.push(stage) });
  await flush();
  equal(joinCalls, 2, 'expired slot reservation must be retried exactly once');
  equal(joinStages, ['requesting-slot', 'reservation-expired', 'retrying-slot',
    'joining-room-channel', 'synchronizing-roster'], 'join must expose authoritative pre-welcome stages');
  equal(sockets.length, 1, 'shell join must open exactly one lobby socket from the reservation');
  sockets[0].open();
  sockets[0].receive(frame('lobby.welcome', 0, snapshot()));
  await joining;
  equal(joinStages.at(-1), 'ready', 'validated welcome must be the only transition to ready');
  equal(adapter.getLobbySnapshotNow().status, 'synchronized', 'shell adapter must expose the validated welcome snapshot');
  equal(reconnectCalls, 0, 'fresh join must not mint a reconnect ticket');
  const renderedAfterWelcome = snapshots.length;
  sockets[0].receive(frame('heartbeat', 1, { serverTime: iso(1_000) }));
  equal(snapshots.length, renderedAfterWelcome, 'heartbeat-only state must not replace the focused shell subtree');

  const teamConfirmation = adapter.setTeam({ roomId: ROOM_ALPHA, team: 'bravo' });
  const teamId = sockets[0].sent.at(-1).correlationId;
  const teamIntent = sockets[0].sent.at(-1);
  equal({ t: teamIntent.t, correlationId: teamIntent.correlationId, d: teamIntent.d },
    { t: 'team.request', correlationId: teamId, d: { team: 'bravo' } },
    'shell team payload must map to exact realtime intent');
  check(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(teamIntent.traceparent),
    'shell team intent carries a valid W3C launch trace context');
  equal(adapter.getLobbySnapshotNow().roster[0].team, 'alpha', 'adapter must not replace authoritative roster with pending team');
  equal(adapter.getLobbySnapshotNow().optimistic.team, 'bravo', 'adapter must retain separate pending team treatment');
  sockets[0].receive(frame('team.changed', 2, { accountId: ACCOUNT_LOCAL, team: 'bravo', byServer: false }, teamId));
  equal((await teamConfirmation).correlationId, teamId, 'shell team promise resolves only after authoritative team.changed');

  const readyConfirmation = adapter.setReady({ roomId: ROOM_ALPHA, ready: true });
  const readyId = sockets[0].sent.at(-1).correlationId;
  equal(sockets[0].sent.at(-1).d, { ready: true }, 'shell ready payload must drop roomId on the realtime wire');
  sockets[0].receive(frame('ready.changed', 3, { accountId: ACCOUNT_LOCAL, ready: true }, readyId));
  await readyConfirmation;
  const loadoutConfirmation = adapter.setLoadout({ roomId: ROOM_ALPHA, primaryIdx: 1, secondaryIdx: 0 });
  const loadoutId = sockets[0].sent.at(-1).correlationId;
  equal(sockets[0].sent.at(-1).d, { primaryIdx: 1, secondaryIdx: 0 }, 'shell loadout must map only exact indices');
  sockets[0].receive(frame('ready.changed', 4, {
    accountId: ACCOUNT_LOCAL, ready: false, clearedReason: 'loadout-change',
  }, loadoutId));
  check(Object.hasOwn(adapter.getLobbySnapshotNow().pending, loadoutId), 'correlated readiness clearing must not falsely confirm loadout');
  const changedLocal = member(ACCOUNT_LOCAL, { local: true, owner: true, team: 'bravo', ready: true });
  changedLocal.loadout = { primaryIdx: 1, secondaryIdx: 0 };
  sockets[0].receive(frame('roster.delta', 5, { added: [], updated: [changedLocal], removed: [] }, loadoutId));
  await loadoutConfirmation;

  const launchConfirmation = adapter.launchRoom({ roomId: ROOM_ALPHA });
  const launchId = sockets[0].sent.at(-1).correlationId;
  equal(sockets[0].sent.at(-1).t, 'launch.request', 'shell launch must use the owner realtime request');
  sockets[0].receive(frame('ready.changed', 6, { accountId: ACCOUNT_OTHER, ready: true }));
  sockets[0].receive(frame('countdown.started', 7, { endsAt: iso(20_000), requiredReady: 2, currentReady: 2 }, launchId));
  await launchConfirmation;
  const chatConfirmation = adapter.sendChat({ roomId: ROOM_ALPHA, text: 'adapter chat' });
  const chatId = sockets[0].sent.at(-1).correlationId;
  equal(sockets[0].sent.at(-1).d, { text: 'adapter chat' }, 'shell chat must not leak route metadata onto the wire');
  sockets[0].receive(frame('chat.message', 8, { id: CHAT_ADAPTER, accountId: ACCOUNT_LOCAL,
    displayName: 'Local Player', text: 'adapter chat', ts: iso(), filtered: false }, chatId));
  await chatConfirmation;
  const pingConfirmation = adapter.sendPing({ roomId: ROOM_ALPHA, kind: 'attack-a' });
  const pingId = sockets[0].sent.at(-1).correlationId;
  equal(sockets[0].sent.at(-1).d, { kind: 'attack-a' }, 'shell ping must preserve the exact controller-supplied kind');
  sockets[0].receive(frame('ping.placed', 9, { accountId: ACCOUNT_LOCAL, kind: 'attack-a' }, pingId));
  await pingConfirmation;
  const mutePromise = adapter.mutePlayer({ roomId: ROOM_ALPHA, accountId: ACCOUNT_OTHER, muted: true });
  const muteId = sockets[0].sent.at(-1).correlationId;
  sockets[0].receive(frame('mute.changed', 10, { accountId: ACCOUNT_OTHER, muted: true }, muteId));
  await mutePromise;
  check(adapter.getLobbySnapshotNow().mutedAccountIds.includes(ACCOUNT_OTHER), 'shell mute must update controller display filtering');
  await adapter.reportPlayer({ subjectAccountId: ACCOUNT_OTHER, category: 'griefing' });
  equal(reports, [{ subjectAccountId: ACCOUNT_OTHER, category: 'griefing' }], 'shell report must retain the exact HTTP report body');

  sockets[0].receive(frame('match.ready', 11, handoff()));
  equal(handoffs.length, 1, 'match.ready must trigger the shell handoff seam exactly once');
  const active = await adapter.getActiveMatch();
  equal(active.handoff.matchId, MATCH_ALPHA, 'match loading must consume the validated in-memory handoff');
  equal(await adapter.getLobbySnapshot({ roomId: ROOM_ALPHA }), adapter.getLobbySnapshotNow(), 'active room loaders must reuse one controller snapshot');
  equal(await adapter.getChatHistory({ roomId: ROOM_ALPHA }), adapter.getLobbySnapshotNow(), 'chat loader must share the same room-scoped snapshot');
  check(snapshots.some((value) => value.status === 'handoff-ready'), 'shell subscribers must receive authoritative handoff state');

  const sentBeforeLeave = sockets[0].sent.length;
  const leavePromise = adapter.leaveRoom({ roomId: ROOM_ALPHA });
  const leave = await leavePromise;
  equal(sockets[0].sent.length, sentBeforeLeave, 'shell leave must not race an unconfirmed WebSocket release ahead of HTTP');
  equal(leave.correlationId, 'leave-http-confirmed', 'shell leave must wait for authoritative HTTP confirmation');
  equal(leaves, [{ roomId: ROOM_ALPHA }], 'shell leave must use the exact room-scoped HTTP operation');
  equal(adapter.getLobbySnapshotNow(), null, 'leaving must destroy the room-scoped controller');
  assert.throws(() => adapter.setReady({ roomId: ROOM_ALPHA, ready: false }), /No authoritative lobby/);
  checks++;
  const rediscoveryA = adapter.getLobbySnapshot({ roomId: ROOM_ALPHA });
  const rediscoveryB = adapter.getChatHistory({ roomId: ROOM_ALPHA });
  await flush();
  equal(reconnectCalls, 1, 'concurrent room loaders must mint one reconnect ticket');
  equal(sockets.length, 2, 'concurrent room loaders must create one replacement controller');
  sockets[1].open(); sockets[1].receive(frame('lobby.welcome', 0, snapshot()));
  await Promise.all([rediscoveryA, rediscoveryB]);
  equal(adapter.getLobbySnapshotNow().status, 'synchronized', 'fresh reconnect ticket must restore the direct room route');
  adapter.destroyLobby();

  const unavailableAdapter = createLobbyShellAdapter({
    client: http,
    createController: (options) => createLobbyController({ ...options, clock: new ManualClock() }),
    webSocketFactory() { throw Object.assign(new Error('WebSocket unavailable'), { code: 'CLIENT_UNAVAILABLE' }); },
  });
  await rejects(() => unavailableAdapter.joinRoom({ roomId: ROOM_ALPHA }),
    (error) => error.code === 'CLIENT_UNAVAILABLE', 'missing browser lobby transport must fail closed');
  unavailableAdapter.destroyLobby();

  const cancelSockets = [];
  const cancelStages = [];
  const cancelAdapter = createLobbyShellAdapter({
    client: {
      async joinRoom({ roomId }) {
        return { roomId, reservationId: 'reservation-cancel', lobbySocketUrl: 'wss://lobby.example/ws',
          lobbyTicket: 'join-ticket-cancel', expiresAt: iso(30_000) };
      },
      async reconnectRoom() { throw new Error('cancelled join must not reconnect'); },
    },
    createController: (options) => createLobbyController({
      ...options, clock: new ManualClock(), createCorrelationId: correlationId,
    }),
    webSocketFactory(url) { const socket = new FakeSocket(url); cancelSockets.push(socket); return socket; },
  });
  const abort = new AbortController();
  const cancelledJoin = cancelAdapter.joinRoom({ roomId: ROOM_ALPHA, signal: abort.signal,
    onStage: (stage) => cancelStages.push(stage) });
  await flush();
  equal(cancelStages.at(-1), 'synchronizing-roster', 'join remains cancellable while awaiting authoritative welcome');
  abort.abort();
  await rejects(() => cancelledJoin, (error) => error.code === 'CLIENT_ABORTED',
    'pre-welcome cancellation must reject with a distinct client outcome');
  equal(cancelAdapter.getLobbySnapshotNow(), null, 'cancelled join must destroy its unconfirmed controller');
  check(!cancelStages.includes('ready'), 'cancelled join must never announce ready');
  cancelAdapter.destroyLobby();
}

try {
  validatorChecks();
  await controllerChecks();
  await retryAndCancelChecks();
  await confirmationTimeoutChecks();
  await malformedChecks();
  await heartbeatChecks();
  await staleSocketChecks();
  await shellAdapterChecks();
  console.log(`✓ Lobby acceptance passed (${checks} assertions).`);
} catch (error) {
  console.error(`✗ Lobby acceptance failed after ${checks} assertions.`);
  console.error(error?.stack || error);
  process.exitCode = 1;
}
