/** Real P2 acceptance: real HTTP server, real auth, real WebSockets, six clients. */
import { WebSocket } from 'ws';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig } from '../platform/src/core/config.js';
import { buildApp } from '../platform/src/app.js';
import { ulid } from '../platform/src/core/ids.js';
import { encodeHello, decodeWelcome, decodeReject, PROTOCOL_VERSION } from '../src/net/protocol.js';
import { issueMatchTicket, createLobbyModule,
  localChatModerator } from '../platform/src/modules/lobby/index.js';
import { createMatchTicketVerifier } from '../server/tickets.js';

let passed = 0;
let failed = 0;
const check = (condition, label, detail = '') => {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const silent = () => { const noop = () => {}; const logger = { debug: noop, info: noop, warn: noop,
  error: process.env.LOBBY_DEBUG ? (...args) => console.error(...args) : noop };
logger.child = () => logger; return logger; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parsedGameLogs = () => gameLog.split(/\r?\n/).filter(Boolean).map((line) => {
  try { return JSON.parse(line); } catch { return null; }
});

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const matchPort = await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
});
const platformPort = await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
});
const matchSecret = 'DEV-ONLY-INSECURE-MATCH-TICKET-SECRET-do-not-ship';
const debugControlSecret = 'DEV-ONLY-DEBUG-CONTROL-SECRET-do-not-ship';
const matchControlSecret = 'DEV-ONLY-INSECURE-MATCH-CONTROL-SECRET-do-not-ship';
const gameServer = spawn(process.execPath, [join(root, 'server/index.js'), `--port=${matchPort}`, '--bots=0', '--mode=bomb'], {
  cwd: root, env: { ...process.env, NODE_ENV: 'production', NODE_NO_WARNINGS: '1', OVERSTRIKE_MATCH_TICKET_SECRET: matchSecret,
    OVERSTRIKE_DEBUG_CONTROL_SECRET: debugControlSecret,
    OVERSTRIKE_MATCH_CONTROL_SECRET: matchControlSecret,
    OVERSTRIKE_PLATFORM_CONTROL_URL: `http://127.0.0.1:${platformPort}`,
    OVERSTRIKE_PUBLIC_WS_URL: `ws://127.0.0.1:${matchPort}`,
    OVERSTRIKE_SERVER_ID: `lobbytest-${matchPort}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let gameLog = '';
gameServer.stdout.on('data', (chunk) => { gameLog += String(chunk); });
gameServer.stderr.on('data', (chunk) => { gameLog += String(chunk); });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`game server boot timeout\n${gameLog}`)), 20_000);
  const poll = setInterval(() => {
    if (gameLog.includes('"event":"server.listening"')) { clearTimeout(timer); clearInterval(poll); resolve(); }
    else if (gameServer.exitCode !== null) { clearTimeout(timer); clearInterval(poll); reject(new Error(`game server exited ${gameServer.exitCode}\n${gameLog}`)); }
  }, 25);
});

const config = loadConfig({ ...process.env, NODE_ENV: 'test', PLATFORM_PORT: String(platformPort),
  PLATFORM_STORAGE: process.env.PLATFORM_STORAGE || 'memory',
  PLATFORM_TRUSTED_PROXY_HOPS: '1', PLATFORM_MATCH_SERVER_URL: `ws://127.0.0.1:${matchPort}`,
  PLATFORM_MATCH_CONTROL_SECRET: matchControlSecret,
  PLATFORM_FLAG_OVERRIDES: 'mode.bomb.enabled=true,map.the_square.enabled=true' });
let moderationOutage = false;
const app = await buildApp(config, { logger: silent(), chatModerator: async (text) => {
  if (moderationOutage) throw new Error('simulated moderation outage');
  return localChatModerator(text);
} });
await new Promise((resolve) => app.server.listen(platformPort, '127.0.0.1', resolve));
const port = app.server.address().port;
const base = `http://127.0.0.1:${port}`;
for (let attempt = 0; attempt < 40; attempt++) {
  if (await app.deps.store.matchServers.byId(`lobbytest-${matchPort}`)) break;
  await sleep(250);
}
if (!await app.deps.store.matchServers.byId(`lobbytest-${matchPort}`)) {
  throw new Error('game server did not register with the platform control plane');
}

async function call(method, path, body, token = null, extras = {}) {
  const headers = { 'content-type': 'application/json', 'x-client-build': '1.0.0', ...extras };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
}

async function onboard(index) {
  const sid = ulid(Date.now() + index);
  const headers = { 'x-forwarded-for': `192.0.2.${index + 1}` };
  const eligibility = await call('POST', '/v1/onboarding/eligibility', { dateOfBirth: '1990-01-01', jurisdiction: 'CA-ON' }, null, headers);
  const consent = await call('PUT', '/v1/onboarding/consent', { telemetryPersonal: false, policyVersion: 1, clientSessionId: sid }, null, headers);
  const signup = await call('POST', '/v1/auth/signup', {
    email: `lobby-${Date.now()}-${index}@example.invalid`, password: 'correct horse battery staple',
    displayName: `Lobby${index}X`, eligibilityReceipt: eligibility.body.receipt,
    clientSessionId: sid, consentReceipt: consent.body.receipt,
  }, null, headers);
  if (signup.status !== 201) throw new Error(`onboard ${index}: ${signup.status} ${JSON.stringify(signup.body)}`);
  return { token: signup.body.accessToken, accountId: signup.body.profile.accountId };
}

const serverId = `lobbytest-${matchPort}`;
const unauthDrain = await call('POST', `/v1/control/match-servers/${serverId}/drain`, { draining: true });
const malformedDrain = await call('POST', `/v1/control/match-servers/${serverId}/drain`,
  { draining: true, extra: true }, null, { 'x-service-token': config.serviceToken });
const drained = await call('POST', `/v1/control/match-servers/${serverId}/drain`,
  { draining: true }, null, { 'x-service-token': config.serviceToken });
const drainedRow = await app.deps.store.matchServers.byId(serverId);
const undrained = await call('POST', `/v1/control/match-servers/${serverId}/drain`,
  { draining: false }, null, { 'x-service-token': config.serviceToken });
const undrainedRow = await app.deps.store.matchServers.byId(serverId);
check(unauthDrain.status === 403 && malformedDrain.status === 400 && drained.status === 200
  && drainedRow.status === 'draining'
  && undrained.status === 200 && undrainedRow.status === 'healthy',
'platform orchestration authenticates drain, closes its body, de-advertises capacity, and explicitly undrains',
JSON.stringify({ unauth: unauthDrain.status, malformed: malformedDrain.status, drained, drainedRow, undrained, undrainedRow }));

const staleServerId = `aaa-stale-${ulid()}`;
await app.deps.store.matchServers.register({ serverId: staleServerId, region: 'iad',
  address: 'ws://127.0.0.1:1', capacity: 12, inUse: 0, status: 'healthy', build: '1.0.0',
  lastHeartbeatAt: new Date().toISOString() });

function lobbySocket(ticket, { lastSeq = null } = {}) {
  const url = new URL(ticket.lobbySocketUrl);
  url.searchParams.set('ticket', ticket.lobbyTicket);
  if (lastSeq !== null) url.searchParams.set('lastSeq', String(lastSeq));
  const ws = new WebSocket(url);
  const frames = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw)); frames.push(frame);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(frame)) continue;
      clearTimeout(waiter.timer); waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame);
    }
  });
  const wait = (predicate, timeoutMs = 8_000) => new Promise((resolve, reject) => {
    const existing = frames.find(predicate); if (existing) { resolve(existing); return; }
    const waiter = { predicate, resolve, timer: setTimeout(() => {
      waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`frame timeout; got ${frames.map((f) => f.t).join(',')}`));
    }, timeoutMs) };
    waiters.push(waiter);
  });
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return { ws, frames, wait, opened, send(t, d, correlationId = ulid(), traceparent = null) {
    ws.send(JSON.stringify({ t, correlationId, ...(traceparent ? { traceparent } : {}), d }));
    return correlationId;
  } };
}

const clients = [];
try {
  console.log('\n--- allocation ticket transaction rollback ---');
  const faultUsers = await Promise.all([onboard(40), onboard(41)]);
  const faultCreated = await call('POST', '/v1/rooms', { name: 'Ticket Fault Room', region: 'iad',
    mapId: 'the-square', mode: 'tdm', capacity: 2, settings: { requiredReady: 2, minPlayers: 2 } },
  faultUsers[0].token, { 'idempotency-key': `ticket-fault:${ulid()}` });
  const faultOwner = lobbySocket(faultCreated.body); await faultOwner.opened;
  await faultOwner.wait((frame) => frame.t === 'lobby.welcome');
  const faultJoined = await call('POST', `/v1/rooms/${faultCreated.body.room.roomId}/join`, {},
    faultUsers[1].token, { 'idempotency-key': `ticket-fault-join:${ulid()}` });
  const faultPeer = lobbySocket(faultJoined.body); await faultPeer.opened;
  await faultPeer.wait((frame) => frame.t === 'lobby.welcome');
  for (const peer of [faultOwner, faultPeer]) {
    const correlation = peer.send('ready.set', { ready: true });
    await peer.wait((frame) => frame.t === 'ready.changed' && frame.correlationId === correlation);
  }
  const originalTicketPut = app.deps.store.matchTickets.put;
  let ticketPuts = 0;
  app.deps.store.matchTickets.put = async (...args) => {
    ticketPuts += 1; if (ticketPuts === 2) throw new Error('injected middle ticket write failure');
    return originalTicketPut(...args);
  };
  const faultLaunch = faultOwner.send('launch.request', {});
  const faultFailure = await faultOwner.wait((frame) => frame.t === 'match.failed'
    && frame.correlationId === faultLaunch, 10_000);
  app.deps.store.matchTickets.put = originalTicketPut;
  const faultRoom = app.deps.lobby.rooms.get(faultCreated.body.room.roomId);
  const faultRegistry = await app.deps.store.matchServers.byId(serverId);
  const staleRegistry = await app.deps.store.matchServers.byId(staleServerId);
  check(faultFailure.d.error.code === 'MATCH_ALLOCATION_FAILED' && faultRoom.status === 'open'
    && faultRegistry.inUse === 0 && ![faultOwner, faultPeer].some((peer) =>
      peer.frames.some((frame) => frame.t === 'match.ready'))
    && ![...app.deps.lobby.matches.values()].some((match) => match.roomId === faultRoom.roomId),
  'middle ticket-write failure rolls back every ticket/match row, emits no partial handoff, releases the lease, and reopens once',
  JSON.stringify({ code: faultFailure.d.error.code, status: faultRoom.status, inUse: faultRegistry.inUse,
    readyFrames: [faultOwner, faultPeer].map((peer) => peer.frames.filter((frame) => frame.t === 'match.ready').length),
    active: [...app.deps.lobby.matches.values()].filter((match) => match.roomId === faultRoom.roomId).length }));
  check(staleRegistry.status === 'unhealthy' && faultRegistry.status === 'healthy',
    'allocator quarantines an unreachable fresh registry row and retries the healthy regional authority');
  faultOwner.ws.close(); faultPeer.ws.close();

  console.log('\n--- an allocation nobody ever claimed is reclaimed ---');
  {
    /**
     * Found in production: one test launch whose clients never connected held the region's only
     * game server at 12/12 forever, and every later room creation was refused with "No healthy
     * match capacity is available in iad". The server answers `allocated` with the right matchId
     * on every poll, so `healthMisses` resets and the existing reaper — which only handles
     * ENDED, MOVED ON and UNREACHABLE — never fires.
     *
     * The deadline is shortened for THIS SECTION ONLY and restored in `finally`. It cannot be a
     * constructor argument: the sweep is a single loop over every match in the process, so a
     * globally shortened value reaps the matches the other sections depend on — which is exactly
     * what happened when it was first written that way.
     */
    const restore = app.deps.lobby.tunables.unclaimedMatchMs;
    app.deps.lobby.tunables.unclaimedMatchMs = 1_000;
    try {
      const users = await Promise.all([onboard(70), onboard(71)]);
      const created = await call('POST', '/v1/rooms', { name: 'Unclaimed', region: 'iad',
        mapId: 'the-square', mode: 'tdm', capacity: 2, settings: { requiredReady: 2, minPlayers: 2 } },
      users[0].token, { 'idempotency-key': `unclaimed:${ulid()}` });
      const ownerPeer = lobbySocket(created.body); await ownerPeer.opened;
      await ownerPeer.wait((frame) => frame.t === 'lobby.welcome');
      const joined = await call('POST', `/v1/rooms/${created.body.room.roomId}/join`, {}, users[1].token,
        { 'idempotency-key': `unclaimed-join:${ulid()}` });
      const otherPeer = lobbySocket(joined.body); await otherPeer.opened;
      await otherPeer.wait((frame) => frame.t === 'lobby.welcome');
      for (const peer of [ownerPeer, otherPeer]) {
        const c = peer.send('ready.set', { ready: true });
        await peer.wait((frame) => frame.t === 'ready.changed' && frame.correlationId === c);
      }
      const launch = ownerPeer.send('launch.request', {});
      await ownerPeer.wait((frame) => frame.t === 'match.ready' && frame.correlationId === launch, 12_000);

      const roomId = created.body.room.roomId;
      const heldRow = await app.deps.store.matchServers.byId(serverId);
      check(heldRow.inUse > 0 && [...app.deps.lobby.matches.values()].some((m) => m.roomId === roomId),
        'control: the allocation holds the server seat once match.ready is delivered',
        JSON.stringify({ inUse: heldRow.inUse }));

      // NOBODY connects a game client. Drive the sweep past the shortened deadline.
      await sleep(1_200);
      await app.deps.lobby.sweep();

      const freedRow = await app.deps.store.matchServers.byId(serverId);
      check(freedRow.inUse === 0,
        'the seat is released rather than held for a match that can no longer start',
        JSON.stringify({ inUse: freedRow.inUse }));
      check(![...app.deps.lobby.matches.values()].some((m) => m.roomId === roomId),
        'and the match is dropped from the active set');
      const reopened = await call('GET', `/v1/rooms/${roomId}`, undefined, users[0].token);
      // `detail()` spreads the room at the top level; only the CREATE response nests it.
      check(reopened.body.status === 'open',
        'the room reopens so the players can try again rather than being stranded in-progress',
        JSON.stringify(reopened.body?.status));

      // The capacity refusal that the leak caused must no longer happen.
      const after = await call('POST', '/v1/rooms', { name: 'After Reap', region: 'iad',
        mapId: 'the-square', mode: 'tdm', capacity: 2 },
      users[1].token, { 'idempotency-key': `after-reap:${ulid()}` });
      check(after.status === 201,
        'a new room can be created again — the region is not permanently out of capacity',
        `${after.status} ${JSON.stringify(after.body?.error?.details)}`);

      ownerPeer.ws.close(); otherPeer.ws.close();
    } finally {
      app.deps.lobby.tunables.unclaimedMatchMs = restore;
    }
  }

  console.log('\n--- launch refusals name the condition that actually failed ---');
  {
    /**
     * Found live: a player alone in a room they had readied up in pressed Launch and was told
     * "Everyone has to be ready first" — while the details on that same error read
     * `requiredReady: 1, currentReady: 1`. The message contradicted its own evidence, and the
     * real blocker (minPlayers) was not something pressing ready could ever satisfy.
     *
     * Both refusals are asserted, because collapsing them was the defect: a test that only
     * checked "launch below the threshold is CONFLICT" passes either way.
     */
    const solo = await onboard(60);
    const soloRoom = await call('POST', '/v1/rooms', { name: 'Solo Refusal', region: 'iad',
      mapId: 'the-square', mode: 'tdm', capacity: 4, settings: { requiredReady: 1, minPlayers: 2 } },
    solo.token, { 'idempotency-key': `solo:${ulid()}` });
    const soloPeer = lobbySocket(soloRoom.body); await soloPeer.opened;
    await soloPeer.wait((frame) => frame.t === 'lobby.welcome');
    const soloReady = soloPeer.send('ready.set', { ready: true });
    await soloPeer.wait((frame) => frame.t === 'ready.changed' && frame.correlationId === soloReady);

    const soloLaunch = soloPeer.send('launch.request', {});
    const soloError = await soloPeer.wait((frame) => frame.t === 'error'
      && frame.correlationId === soloLaunch, 8_000);
    const d = soloError.d.error.details;
    check(d.reason === 'not-enough-players' && d.minPlayers === 2 && d.currentPlayers === 1,
      'a ready player alone in the room is refused for the ROSTER, not for readiness',
      JSON.stringify(d));
    check(!/ready/i.test(soloError.d.error.message) && /2 players/.test(soloError.d.error.message),
      'and the message names the roster requirement rather than contradicting its own counts',
      JSON.stringify(soloError.d.error.message));

    // CONTROL: the readiness refusal still exists and is still reachable — otherwise the check
    // above would pass just as well if readiness had stopped being enforced entirely.
    // The mate must CONNECT, not merely reserve: `/join` mints a reservation and the member
    // enters `room.members` when their socket opens, which is what the roster gate counts.
    const mate = await onboard(61);
    const mateJoin = await call('POST', `/v1/rooms/${soloRoom.body.room.roomId}/join`, {}, mate.token,
      { 'idempotency-key': `solo-join:${ulid()}` });
    const matePeer = lobbySocket(mateJoin.body); await matePeer.opened;
    await matePeer.wait((frame) => frame.t === 'lobby.welcome');
    const unready = soloPeer.send('ready.set', { ready: false });
    await soloPeer.wait((frame) => frame.t === 'ready.changed' && frame.correlationId === unready);
    const secondLaunch = soloPeer.send('launch.request', {});
    const readyError = await soloPeer.wait((frame) => frame.t === 'error'
      && frame.correlationId === secondLaunch, 8_000);
    check(readyError.d.error.details.reason === 'not-all-ready'
      && /ready/i.test(readyError.d.error.message),
    'CONTROL: with the roster satisfied, an unready player still gets the readiness refusal',
    JSON.stringify(readyError.d.error.details));
    soloPeer.ws.close(); matePeer.ws.close();
  }

  console.log('\n--- six authenticated clients browse, join and synchronize ---');
  const users = await Promise.all(Array.from({ length: 6 }, (_, index) => onboard(index)));
  await Promise.all(users.map((user, index) => call('PATCH', '/v1/profile/me', {
    privacy: { presenceVisibility: index === 1 ? 'nobody' : index === 2 ? 'friends' : 'everyone' },
  }, user.token, { 'idempotency-key': `privacy:${index}:${ulid()}` })));
  const unauth = await call('GET', '/v1/rooms');
  check(unauth.status === 401 && unauth.body.error.code === 'AUTH_REQUIRED', 'live room browser fails closed without auth');

  const createBody = {
    name: 'Six Client Square', region: 'iad', mapId: 'the-square', mode: 'bomb', capacity: 6,
    settings: { requiredReady: 6, minPlayers: 2 },
  };
  const createKey = `room:${ulid()}`;
  const created = await call('POST', '/v1/rooms', createBody, users[0].token, { 'idempotency-key': createKey });
  check(created.status === 201, 'owner creates a persisted room and reservation', JSON.stringify(created.body));
  const replayedCreate = await call('POST', '/v1/rooms', createBody, users[0].token, { 'idempotency-key': createKey });
  const mismatchedCreate = await call('POST', '/v1/rooms', { ...createBody, name: 'Different' }, users[0].token, { 'idempotency-key': createKey });
  check(replayedCreate.body.room.roomId === created.body.room.roomId
    && replayedCreate.body.lobbyTicket === created.body.lobbyTicket
    && mismatchedCreate.status === 409 && mismatchedCreate.body.error.code === 'IDEMPOTENCY_KEY_REUSED',
  'room creation replays the exact stored reservation and rejects key/body mismatch');
  const roomId = created.body.room.roomId;

  const owner = lobbySocket(created.body); clients.push(owner); await owner.opened;
  const ownerWelcome = await owner.wait((frame) => frame.t === 'lobby.welcome');
  check(ownerWelcome.seq === 0 && ownerWelcome.d.you.isOwner, 'creator converts reservation into the owner seat');

  for (let index = 1; index < users.length; index++) {
    const joinBody = { password: null, preferredTeam: 'auto' };
    const joinKey = `join:${ulid()}`;
    const joined = await call('POST', `/v1/rooms/${roomId}/join`, joinBody, users[index].token, { 'idempotency-key': joinKey });
    check(joined.status === 200, `client ${index + 1} reserves without oversubscription`, JSON.stringify(joined.body));
    if (index === 1) {
      const replayedJoin = await call('POST', `/v1/rooms/${roomId}/join`, joinBody, users[index].token, { 'idempotency-key': joinKey });
      check(replayedJoin.body.lobbyTicket === joined.body.lobbyTicket,
        'room join replays the exact stored reservation instead of consuming another seat');
    }
    const client = lobbySocket(joined.body); clients.push(client); await client.opened;
    const welcome = await client.wait((frame) => frame.t === 'lobby.welcome');
    check(welcome.d.roster.length === index + 1 && welcome.d.roster.filter((m) => m.isLocal).length === 1,
      `client ${index + 1} receives a complete caller-relative welcome`);
  }

  const browser = await call('GET', '/v1/rooms?region=yyz&mode=bomb&hasSpace=true', undefined, users[0].token, { 'x-region-rtt': 'yyz=24' });
  check(browser.status === 200 && browser.body.items.length === 0, 'full room is excluded from hasSpace browser results');
  const room = await call('GET', `/v1/rooms/${roomId}`, undefined, users[0].token);
  check(room.body.roster.length === 6 && room.body.playerCount === 6, 'REST and realtime share one six-player authority');
  const presence = await call('GET', '/v1/presence/online', undefined, users[0].token);
  check(presence.body.items.filter((item) => item.roomId === roomId).length === 4,
    'presence privacy exposes everyone and fails closed for nobody/friends');
  await Promise.all(users.slice(1, 3).map((user, index) => call('PATCH', '/v1/profile/me', {
    privacy: { presenceVisibility: 'everyone' },
  }, user.token, { 'idempotency-key': `privacy-public:${index}:${ulid()}` })));
  const publicPresence = await call('GET', '/v1/presence/online', undefined, users[0].token);
  check(publicPresence.body.items.filter((item) => item.roomId === roomId).length === 6,
    'six clients see room-scoped presence after explicit everyone projection');
  const recent = await call('GET', '/v1/presence/recent?limit=10', undefined, users[0].token);
  check(recent.status === 200 && recent.body.items.length === 5, 'recent encounters are persisted and privacy-filtered');

  console.log('\n--- authoritative intent, rate limits, report and launch handoff ---');
  const muteCorrelation = clients[4].send('mute.set', { accountId: users[1].accountId, muted: true });
  const muted = await clients[4].wait((frame) => frame.t === 'mute.changed' && frame.correlationId === muteCorrelation);
  check(muted.d.muted === true, 'mute is server-acknowledged instead of a local-only display toggle');
  const badPingCorrelation = clients[4].send('ping.send', { kind: 'invented' });
  const badPing = await clients[4].wait((frame) => frame.t === 'error' && frame.correlationId === badPingCorrelation);
  check(badPing.d.error.code === 'VALIDATION_FAILED', 'server refuses ping kinds outside the advertised catalog');
  clients[4].send('future.additive.intent', { ignored: true });
  const knownAfterUnknown = clients[4].send('ping.send', { kind: 'regroup' });
  const pingAfterUnknown = await clients[4].wait((frame) => frame.t === 'ping.placed'
    && frame.correlationId === knownAfterUnknown);
  check(pingAfterUnknown.d.kind === 'regroup', 'unknown additive frame types are ignored without closing or mutating sequence state');
  for (let index = 0; index < clients.length; index++) {
    const correlationId = clients[index].send('ready.set', { ready: true });
    const ready = await clients[index].wait((frame) => frame.t === 'ready.changed' && frame.correlationId === correlationId);
    check(ready.d.accountId === users[index].accountId && ready.d.ready, `client ${index + 1} readiness is server-confirmed`);
  }
  const nonOwnerLaunch = clients[1].send('launch.request', {});
  const refused = await clients[1].wait((frame) => frame.t === 'error' && frame.correlationId === nonOwnerLaunch);
  check(refused.d.error.code === 'AUTH_FORBIDDEN', 'modified non-owner cannot force launch');

  const chatCorrelation = clients[1].send('chat.send', { text: '  hold   the square  ' });
  const chatFrame = await clients[0].wait((frame) => frame.t === 'chat.message'
    && frame.correlationId === chatCorrelation);
  const chatReport = await call('POST', '/v1/reports', { subjectAccountId: users[1].accountId,
    category: 'harassment', chatMessageId: chatFrame.d.id, description: 'moderation linkage' }, users[0].token);
  const removeChat = await call('POST', `/v1/control/chat/${chatFrame.d.id}/remove`,
    { reason: 'moderator-test' }, null, { 'x-service-token': config.serviceToken });
  if (removeChat.status !== 200) throw new Error(`chat removal failed: ${removeChat.status} ${JSON.stringify(removeChat.body)}`);
  const removedChat = await clients[0].wait((frame) => frame.t === 'chat.removed'
    && frame.d.messageId === chatFrame.d.id);
  const retainedChat = await app.deps.store.chatMessages.byId(chatFrame.d.id);
  check(chatFrame.d.text === 'hold the square' && chatFrame.d.filtered === true
    && chatReport.status === 201 && removeChat.status === 200
    && removedChat.d.reason === 'moderator-test' && retainedChat.removedAt,
  'policy-filtered chat is retained, report-linked, service-removable, and broadcast after removal');

  const obfuscatedCorrelation = clients[1].send('chat.send', { text: 'n​i​g​g3r' });
  const obfuscatedRefusal = await clients[1].wait((frame) => frame.t === 'error'
    && frame.correlationId === obfuscatedCorrelation);
  const redactedCorrelation = clients[1].send('chat.send', { text: 'this is shit' });
  const redactedFrame = await clients[0].wait((frame) => frame.t === 'chat.message'
    && frame.correlationId === redactedCorrelation);
  moderationOutage = true;
  const outageRaw = 'provider outage private raw text';
  const outageCorrelation = clients[1].send('chat.send', { text: outageRaw });
  const outageRefusal = await clients[1].wait((frame) => frame.t === 'error'
    && frame.correlationId === outageCorrelation);
  moderationOutage = false;
  check(obfuscatedRefusal.d.error.code === 'VALIDATION_FAILED'
    && redactedFrame.d.text === 'this is [redacted]' && redactedFrame.d.filtered === true
    && outageRefusal.d.error.code === 'SERVICE_UNAVAILABLE'
    && !JSON.stringify([...app.deps.lobby.rooms.values()].flatMap((entry) => entry.chat)).includes(outageRaw),
  'Unicode-obfuscated abuse is rejected, profanity is redacted, and provider outage fails closed without retaining raw text');

  const chatAudits = await app.deps.store.audit.list({ action: 'chat.remove' });
  const chatEvents = (await app.deps.store.outbox.list?.({}) || []).filter((entry) => entry.type === 'chat.removed');
  check(chatAudits.length === 1 && chatAudits[0].actorRole === 'moderator'
    && chatAudits[0].reasonCode === 'moderator-test'
    && chatAudits[0].beforeSummary.removed === false && chatAudits[0].afterSummary.removed === true
    && (chatEvents.length === 0 || chatEvents.length === 1),
  'privileged chat removal records immutable actor, role, reason, correlation, before/after audit state exactly once');

  const report = await call('POST', '/v1/reports', { subjectAccountId: users[1].accountId, category: 'griefing', description: 'acceptance vector' }, users[0].token);
  check(report.status === 201 && typeof report.body.reportId === 'string', 'live report endpoint persists and returns a reference');
  const duplicate = await call('POST', '/v1/reports', { subjectAccountId: users[1].accountId, category: 'griefing', description: 'duplicate' }, users[0].token);
  check(duplicate.status === 409 && duplicate.body.error.code === 'REPORT_DUPLICATE', 'duplicate incident report is refused');

  const suppliedTraceId = '1234567890abcdef1234567890abcdef';
  const suppliedTraceparent = `00-${suppliedTraceId}-1234567890abcdef-01`;
  const launchCorrelation = owner.send('launch.request', {}, ulid(), suppliedTraceparent);
  await Promise.all(clients.map((client) => client.wait((frame) => frame.t === 'countdown.started' && frame.correlationId === launchCorrelation)));
  const handoffs = await Promise.all(clients.map((client) => client.wait((frame) => frame.t === 'match.ready' && frame.correlationId === launchCorrelation, 10_000)));
  check(new Set(handoffs.map((frame) => frame.d.matchId)).size === 1, 'all six seats receive the same match id');
  check(new Set(handoffs.map((frame) => frame.d.sessionTicket)).size === 6, 'handoff ticket is unique and account-bound per seat');
  check(handoffs.every((frame) => Buffer.byteLength(frame.d.sessionTicket) <= 255),
    'platform-minted match tickets fit the frozen HELLO wire bound');
  check(handoffs.every((frame) => frame.d.mapId === 'the-square' && frame.d.mode === 'bomb'
    && frame.d.protocolVersion === PROTOCOL_VERSION),
    'handoff preserves immutable Square/Bomb/protocol metadata');
  const traceResponse = await fetch(`${base}/v1/ops/incidents/${launchCorrelation}`, { headers: {
    'x-service-token': config.serviceToken,
  } });
  const traced = await traceResponse.json();
  const tracedTiers = new Set(traced.timeline?.map((entry) => entry.tier));
  check(traceResponse.status === 200 && tracedTiers.has('client') && tracedTiers.has('platform')
    && tracedTiers.has('match-server')
    && traced.traceId === suppliedTraceId
    && traced.timeline.filter((entry) => entry.kind === 'span')
      .every((entry) => entry.traceId === suppliedTraceId)
    && traced.timeline.some((entry) => entry.kind === 'event' && entry.name === 'match.allocated')
    && traced.timeline.every((entry) => entry.subject?.id === undefined)
    && traced.timeline.every((entry) => !JSON.stringify(entry).includes('@example.invalid')),
  'one CX launch is reconstructable across client, platform, game server and durable event by correlation id');

  const matchHandshake = (sessionTicket) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${matchPort}`); ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('match handshake timeout')); }, 8_000);
    ws.once('open', () => ws.send(Buffer.from(encodeHello(PROTOCOL_VERSION, sessionTicket))));
    ws.once('message', (raw) => {
      clearTimeout(timer);
      const bytes = raw instanceof ArrayBuffer ? raw
        : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      const welcome = decodeWelcome(bytes); const rejection = decodeReject(bytes);
      resolve({ ws, welcome, rejection });
    });
    ws.once('error', reject);
  });
  const admitted = [];
  for (const index of [5, 4, 3, 2, 1, 0]) {
    admitted[index] = await matchHandshake(handoffs[index].d.sessionTicket);
  }
  check(admitted.every((entry) => entry.welcome?.protocolVersion === PROTOCOL_VERSION
    && entry.welcome?.mode === 'bomb' && !entry.rejection),
  'dedicated server binds its authoritative Game mode for all six platform tickets',
  JSON.stringify(admitted.map((entry) => ({ welcome: entry.welcome, rejection: entry.rejection }))) + `\n${gameLog.slice(-1200)}`);
  // Exercise the actual entrypoint's exception logger with a truncated command frame. The
  // decoder message contains byte details, but operational logs retain only its closed class.
  admitted[1].ws.send(Buffer.from([1]), { binary: true });
  for (let attempt = 0; attempt < 40
    && !gameLog.includes('"event":"transport.message_error"'); attempt++) await sleep(25);
  const structuredLogs = parsedGameLogs();
  const joinLog = structuredLogs.find((entry) => entry?.event === 'client.joined');
  const errorLog = structuredLogs.find((entry) => entry?.event === 'transport.message_error');
  const forbiddenLogMaterial = [matchSecret, matchControlSecret, debugControlSecret,
    ...users.map((user) => user.accountId), ...handoffs.map((frame) => frame.d.sessionTicket),
    '@example.invalid', '127.0.0.1', '::1'];
  check(structuredLogs.length > 0 && structuredLogs.every(Boolean)
    && joinLog?.networkClass === 'loopback'
    && Object.keys(joinLog || {}).every((key) => ['ts', 'level', 'service', 'event',
      'networkClass', 'clientCount', 'correlationId'].includes(key))
    && errorLog?.errorCode === 'RANGEERROR'
    && !('message' in (errorLog || {})) && !('body' in (errorLog || {}))
    && forbiddenLogMaterial.every((value) => !gameLog.includes(value)),
  'game-server join/error logs are structured, allowlisted, network-classified, and contain no identity, ticket, IP, secret, or error body',
  JSON.stringify({ parsed: structuredLogs.length > 0 && structuredLogs.every(Boolean),
    joinNetwork: joinLog?.networkClass, joinKeys: Object.keys(joinLog || {}),
    errorCode: errorLog?.errorCode, errorKeys: Object.keys(errorLog || {}),
    forbiddenHits: forbiddenLogMaterial.filter((value) => gameLog.includes(value)),
    nonJsonLines: gameLog.split(/\r?\n/).filter(Boolean).filter((line) => { try { JSON.parse(line); return false; } catch { return true; } }) })
    + `\n${gameLog.slice(-1500)}`);
  const publicHealth = await fetch(`http://127.0.0.1:${matchPort}/health?debug=1`).then((response) => response.json());
  check(JSON.stringify(publicHealth) === '{"ok":true}',
    'production public health is exact minimal liveness with no match or identity detail');
  const matchHealth = await fetch(`http://127.0.0.1:${matchPort}/health?debug=1`, {
    headers: { authorization: `Bearer ${debugControlSecret}` },
  }).then((response) => response.json());
  check(matchHealth.debug.sessionRtt.length === 6 && matchHealth.debug.sessionRtt.every((session) =>
    session.team === (session.claimedTeam === 'bravo' ? 1 : 0)
      && session.primaryIdx === 0 && session.secondaryIdx === 0),
  'reverse socket arrival preserves the signed lobby identity, team, and loadout for all six seats');
  if (!admitted[0].welcome) throw new Error(`match admission failed\n${gameLog.slice(-2000)}`);
  const firstEntityId = admitted[0].welcome.entityId;
  const replacementTicket = await call('POST', `/v1/matches/${handoffs[0].d.matchId}/reconnect-ticket`, {}, users[0].token);
  const oldRejected = new Promise((resolve) => {
    const inspect = (raw) => {
      const bytes = raw instanceof ArrayBuffer ? raw : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      const rejection = decodeReject(bytes);
      if (rejection) { admitted[0].ws.off('message', inspect); resolve(rejection); }
    };
    admitted[0].ws.on('message', inspect);
  });
  const replacement = await matchHandshake(replacementTicket.body.handoff.sessionTicket);
  const replacementReason = await Promise.race([oldRejected, sleep(2_000).then(() => null)]);
  check(replacement.welcome?.entityId === firstEntityId
    && replacementReason?.reason === 'AUTH_SESSION_REPLACED',
  'duplicate match login is newest-wins: the old socket is rejected and its authoritative entity transfers');
  admitted[0] = replacement;
  for (const entry of admitted) entry.ws.close();
  await sleep(50);

  const active = await call('GET', '/v1/matches/active', undefined, users[0].token);
  check(active.status === 200 && active.body.matchId === handoffs[0].d.matchId,
    'active-match discovery survives the lobby-to-match handoff');
  const matchReconnect = await call('POST', `/v1/matches/${handoffs[0].d.matchId}/reconnect-ticket`, {}, users[0].token);
  // Use a fresh non-participant for the authorization negative.
  const outsider = await onboard(20);
  const deniedReconnect = await call('POST', `/v1/matches/${handoffs[0].d.matchId}/reconnect-ticket`, {}, outsider.token);
  check(matchReconnect.status === 200 && deniedReconnect.status === 404,
    'match reconnect is account-bound and does not disclose membership to outsiders');
  const rejoined = await matchHandshake(matchReconnect.body.handoff.sessionTicket);
  check(rejoined.welcome?.isReconnect === true && rejoined.welcome.entityId === firstEntityId,
    'match reconnect reclaims the held authoritative entity with a fresh single-use ticket');
  rejoined.ws.close();

  const replayedMatch = await matchHandshake(handoffs[0].d.sessionTicket);
  check(replayedMatch.rejection?.reason === 'SESSION_TOKEN_INVALID', 'dedicated server rejects a replayed match ticket before entity allocation');
  replayedMatch.ws.close();

  const otherMatchId = ulid(); const otherRoomId = ulid();
  const isolatedTicket = issueMatchTicket(matchSecret, {
    jti: ulid(), sub: outsider.accountId, roomId: otherRoomId, matchId: otherMatchId,
    exp: Date.now() + 60_000, mode: 'tdm',
  });
  const isolated = await matchHandshake(isolatedTicket);
  check(isolated.rejection?.reason === 'SESSION_TOKEN_INVALID',
    'one authoritative Game rejects a second room/match instead of mixing simulations');
  isolated.ws.close();

  const partner = await onboard(21);
  const secondCreated = await call('POST', '/v1/rooms', {
    name: 'Isolation Room', region: 'iad', mapId: 'the-square', mode: 'tdm', capacity: 2,
    settings: { requiredReady: 2, minPlayers: 2 },
  }, outsider.token, { 'idempotency-key': `room-2:${ulid()}` });
  const secondOwner = lobbySocket(secondCreated.body); clients.push(secondOwner); await secondOwner.opened;
  await secondOwner.wait((frame) => frame.t === 'lobby.welcome');
  const secondJoin = await call('POST', `/v1/rooms/${secondCreated.body.room.roomId}/join`, {}, partner.token,
    { 'idempotency-key': `room-2-join:${ulid()}` });
  const secondPeer = lobbySocket(secondJoin.body); clients.push(secondPeer); await secondPeer.opened;
  await secondPeer.wait((frame) => frame.t === 'lobby.welcome');
  secondOwner.send('ready.set', { ready: true }); secondPeer.send('ready.set', { ready: true });
  await Promise.all([secondOwner, secondPeer].map((client) => client.wait((frame) => frame.t === 'ready.changed' && frame.d.ready)));
  const secondLaunch = secondOwner.send('launch.request', {});
  const secondFailure = await secondOwner.wait((frame) => frame.t === 'match.failed'
    && frame.correlationId === secondLaunch, 10_000);
  const secondAbort = await secondOwner.wait((frame) => frame.t === 'countdown.aborted'
    && frame.correlationId === secondLaunch);
  check(secondFailure.d.error.code === 'MATCH_ALLOCATION_FAILED' && secondAbort.d.reason === 'allocation-failed',
    'second room returns open with an explicit failure instead of sharing the occupied Game',
    JSON.stringify({ failure: secondFailure.d, abort: secondAbort.d,
      server: await app.deps.store.matchServers.byId(serverId) }));

  const wrongKey = createMatchTicketVerifier({ secret: `${matchSecret}-wrong` });
  const wrongRoom = createMatchTicketVerifier({ secret: matchSecret, roomId: otherRoomId });
  const expired = issueMatchTicket(matchSecret, { jti: ulid(), sub: users[0].accountId,
    roomId, matchId: handoffs[0].d.matchId, exp: Date.now() - 1, mode: 'bomb' });
  check(wrongKey(handoffs[1].d.sessionTicket) === null && wrongRoom(handoffs[1].d.sessionTicket) === null
    && createMatchTicketVerifier({ secret: matchSecret })(expired) === null,
  'match ticket refuses wrong key, room binding, and expiry before allocation');

  console.log('\n--- reconnect uses a fresh ticket and authoritative resync ---');
  const reconnectIndex = 4;
  const prior = clients[reconnectIndex];
  const lastSeq = Math.max(...prior.frames.map((frame) => frame.seq));
  prior.ws.terminate();
  await sleep(50);
  const fresh = await call('POST', `/v1/rooms/${roomId}/reconnect-ticket`, {}, users[reconnectIndex].token);
  check(fresh.status === 200 && fresh.body.graceEndsAt > fresh.body.expiresAt, 'fresh reconnect ticket carries bounded seat grace');
  const resumed = lobbySocket(fresh.body, { lastSeq }); clients[reconnectIndex] = resumed; await resumed.opened;
  const resyncCorrelation = resumed.send('state.resync', { lastSeq });
  const snapshot = await resumed.wait((frame) => frame.t === 'state.snapshot' && frame.correlationId === resyncCorrelation);
  check(snapshot.d.roster.length === 6 && snapshot.d.you.accountId === users[reconnectIndex].accountId,
    'reconnect replaces local state with the complete authoritative snapshot');
  check(snapshot.d.mutedAccountIds.includes(users[1].accountId),
    'authoritative mute projection persists through reconnect and resync');

  const replay = new WebSocket(`${fresh.body.lobbySocketUrl}?ticket=${encodeURIComponent(fresh.body.lobbyTicket)}`);
  const replayRejected = await new Promise((resolve) => { replay.once('unexpected-response', (_req, res) => resolve(res.statusCode === 401)); replay.once('error', () => resolve(true)); setTimeout(() => resolve(false), 2000); });
  check(replayRejected, 'consumed lobby ticket cannot be replayed');

  console.log('\n--- disconnect grace remains durably projected ---');
  for (const client of clients) client.ws.close(1000, 'restart');
  await sleep(50);
  await app.deps.lobby.sweep();
  check(app.deps.lobby.rooms.get(roomId)?.members.size === 6, 'disconnect holds all six persisted seats during grace');
  const priorLobby = app.deps.lobby;
  priorLobby.stop();
  const restartedLobby = createLobbyModule({
    store: app.deps.store, config, logger: silent(), clock: app.deps.clock,
    auth: app.deps.auth.requireAuth || app.deps.auth.routes?.requireAuth, flags: app.deps.flags,
    visibilityFor: app.deps.profile.profiles.visibilityFor, outbox: app.deps.events.outbox,
    resultApplier: app.deps.profile.stats.applyMatchResult,
    chatModerator: localChatModerator,
  });
  app.deps.lobby = restartedLobby;
  await restartedLobby.handlers.listRooms({ actor: { accountId: users[0].accountId },
    query: new URLSearchParams(), headers: {}, body: {}, params: {}, correlationId: ulid() });
  check(restartedLobby.rooms.get(roomId)?.members.size === 6
    && restartedLobby.matches.has(handoffs[0].d.matchId)
    && restartedLobby.rooms.get(roomId).chat.some((message) => message.text === 'this is [redacted]')
    && !restartedLobby.rooms.get(roomId).chat.some((message) => message.id === chatFrame.d.id),
  'lobby authority rebuild hydrates the frozen roster and unremoved moderated chat, without resurfacing removed text');
  gameServer.kill('SIGKILL');
  await new Promise((resolve) => { if (gameServer.exitCode !== null) resolve(); else gameServer.once('exit', resolve); });
  await restartedLobby.sweep(); await restartedLobby.sweep(); await restartedLobby.sweep();
  const reaped = await app.deps.store.matches.byId(handoffs[0].d.matchId);
  const retainedEvidence = await app.deps.store.matchEvidence.byMatchId(handoffs[0].d.matchId);
  const unaffectedCareer = await app.deps.store.stats.listForAccount(users[0].accountId);
  check(!restartedLobby.matches.has(handoffs[0].d.matchId)
    && restartedLobby.rooms.get(roomId)?.status === 'open' && reaped?.status === 'aborted'
    && reaped.resultAppliedAt && retainedEvidence?.evidenceRef === reaped.evidenceRef
    && retainedEvidence.evidence.terminalSummary.failureReason === 'server-unreachable'
    && unaffectedCareer.length === 0,
  'three missed heartbeats atomically retain no-contest evidence, leave career unchanged, release the slot, and reopen the room');
} finally {
  for (const client of clients) { try { client.ws.close(); } catch {} }
  app.stop();
  app.server.closeAllConnections?.();
  await new Promise((resolve) => app.server.close(resolve));
  await app.deps.store.close();
  if (gameServer.exitCode === null && gameServer.signalCode === null) gameServer.kill('SIGTERM');
  await new Promise((resolve) => {
    if (gameServer.exitCode !== null || gameServer.signalCode !== null) resolve();
    else gameServer.once('exit', resolve);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
