/**
 * DELETE /v1/rooms/:id — an owner can close a room they created, but only when they are the
 * only one left in it. Kicking OTHER connected members has no notification path anywhere in
 * this codebase yet (removeMember deletes a removed member's own connection before the
 * broadcast that would have reached them), so this endpoint deliberately stays inside what the
 * existing empty-room-destroy branch already covers rather than half-building a kick feature.
 *
 * The sections from "a live match no longer strands its owner" onwards cover the reported
 * production trap: launch a room of bots, leave the match, come back to the lobby, and be
 * unable to rejoin (the room is `in-progress`, so `join` refuses) OR delete (`deleteRoom`
 * refused `in-progress` outright). Two separate defects made it a trap rather than a wait:
 *
 *   1. `deleteRoom` had no way to end the match, so "wait for it to end" was the only advice
 *      and there was nobody left playing to end it.
 *   2. The sweep evicted every member whose lobby socket had been shut for GRACE_MS — which
 *      is EVERY member of a live match, because entering the match closes the lobby socket —
 *      and the final eviction destroyed the room in the middle of its own match. After that
 *      `persistRoom`'s `rooms.has()` guard silently swallowed `reopenAfterTerminal`, so the
 *      durable row stayed `destroyed` and there was nothing to return to.
 *
 * These run against a stub authority rather than the real game server: the questions here are
 * "was `/control/release` actually called" and "did the registry go back to inUse=0", and a
 * stub can answer both exactly. Capacity leaks have bitten this project repeatedly
 * (overstrike-gs-iad-1), so the release is asserted, never assumed.
 */
import http from 'node:http';
import { loadConfig } from '../src/core/config.js';
import { buildApp } from '../src/app.js';
import { createStore } from '../src/core/store.js';
import { WebSocket } from 'ws';

// POST /join only reserves a pending slot (a lobby ticket) — membership is not real until the
// ticket opens a lobby socket, the same way the real client seats a player. A member-count
// check that only calls POST /join without this would never see the "not empty" refusal fire.
function lobbySocket(ticket) {
  const url = new URL(ticket.lobbySocketUrl);
  url.searchParams.set('ticket', ticket.lobbyTicket);
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
  return { ws, wait, opened };
}

let passed = 0;
let failed = 0;
const check = (cond, label, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); if (detail) console.log(`       ${detail}`); }
};
const section = (name) => console.log(`\n--- ${name} ---`);

const silent = () => {
  const noop = () => {};
  const l = { debug: noop, info: noop, warn: noop, error: noop };
  l.child = () => l;
  return l;
};

async function withApp(fn) {
  const config = loadConfig({ NODE_ENV: 'test', PLATFORM_PORT: '0' });
  const app = await buildApp(config, { logger: silent() });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json', 'x-client-build': '1.0.0', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* the assertion will say so */ }
    return { status: res.status, body: json };
  };
  try { return await fn({ app, call }); }
  finally {
    app.stop();
    app.server.closeAllConnections?.();
    await new Promise((r) => app.server.close(r));
  }
}

let identity = 0;
async function onboard(call) {
  const n = ++identity;
  const email = `roomdel${n}@example.invalid`, name = `Del${n}`;
  const elig = await call('POST', '/v1/onboarding/eligibility', { dateOfBirth: '1994-03-02', jurisdiction: 'CA-ON' });
  const consent = await call('PUT', '/v1/onboarding/consent', { telemetryPersonal: true, policyVersion: 1, clientSessionId: `sid-${n}` });
  const signup = await call('POST', '/v1/auth/signup', {
    email, password: 'correct horse battery staple', displayName: name,
    eligibilityReceipt: elig.body?.receipt, clientSessionId: `sid-${n}`, consentReceipt: consent.body?.receipt,
  });
  return signup.body.accessToken;
}

const auth = (token) => ({ authorization: `Bearer ${token}` });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A match authority that only answers the control plane.
 *
 * It records every `/control/release` it is sent, which is the fact the capacity assertions
 * below turn on: `reopenAfterTerminal` releases BOTH the remote authority and the store
 * reservation, and a fix that dropped either one would still make the room disappear and
 * still leak the server.
 */
async function stubAuthority() {
  const releases = [];
  let allocation = null;
  let seats = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.url === '/control/allocate' && req.method === 'POST') {
        allocation = JSON.parse(raw);
        // Every allocated player keeps an unreleased seat with a live grace, which is what
        // `GET /v1/matches/active` and `POST /v1/matches/:id/reconnect-ticket` both read to
        // decide whether there is still a match to go back into.
        seats = (allocation.roster || []).map((player) => ({
          accountId: player.accountId, released: false,
          graceEndsAt: new Date(Date.now() + 120_000).toISOString(),
        }));
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, matchId: allocation.matchId, capacity: 12, region: 'iad' }));
      } else if (req.url === '/control/status' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        // `allocated`, forever. A live match that never ends is exactly the state the reporter
        // was stuck in, and it keeps the sweep out of every terminal branch so the only thing
        // that can move this room is the delete under test.
        res.end(JSON.stringify({ ok: true, region: 'iad', capacity: 12, connected: 1, available: 11,
          draining: false, matchId: allocation?.matchId ?? null, roomId: allocation?.roomId ?? null,
          status: allocation ? 'allocated' : 'idle', result: null, releasedResults: [], seats }));
      } else if (req.url === '/control/release' && req.method === 'POST') {
        releases.push(JSON.parse(raw).matchId);
        allocation = null; seats = [];
        res.writeHead(204); res.end();
      } else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, releases, port: server.address().port, get allocation() { return allocation; } };
}

/**
 * Onboard, create a solo-launchable room, seat the owner on a real lobby socket, ready up.
 *
 * `minPlayers: 1` is the room a lone player fills with bots — the exact room the reporter
 * could neither rejoin nor delete. The creator is already a member and the create response
 * already carries their lobby ticket, so there is no `join` here; the socket is still opened
 * because membership is only real once a ticket seats it.
 */
async function soloRoom(call, keyPrefix) {
  const token = await onboard(call);
  const created = await call('POST', '/v1/rooms', {
    name: 'Bots Only', region: 'iad', mapId: 'the-square', mode: 'tdm', capacity: 12,
    settings: { minPlayers: 1, requiredReady: 1 },
  }, { ...auth(token), 'idempotency-key': `${keyPrefix}-create` });
  if (created.status !== 201) throw new Error(`room create failed: ${JSON.stringify(created.body)}`);
  const roomId = created.body.room.roomId;
  const socket = lobbySocket(created.body);
  await socket.opened;
  await socket.wait((frame) => frame.t === 'lobby.welcome');
  const ready = await call('POST', `/v1/rooms/${roomId}/ready`, { ready: true }, auth(token));
  if (ready.status !== 200) throw new Error(`ready failed: ${JSON.stringify(ready.body)}`);
  return { token, roomId, socket };
}

/** Register the stub, launch, and wait out the 3 s countdown until the match is allocated. */
async function launchInto(call, app, stub, roomId, token) {
  const serverId = `roomdel-stub-${stub.port}`;
  const registered = await call('POST', '/v1/control/match-servers/register', {
    serverId, region: 'iad', address: `ws://127.0.0.1:${stub.port}`, capacity: 12, build: '1.0.0',
  }, { authorization: `Bearer ${app.deps.config.matchControlSecret}` });
  if (registered.status !== 201) throw new Error(`stub register failed: ${JSON.stringify(registered.body)}`);
  const launched = await call('POST', `/v1/rooms/${roomId}/launch`, {}, auth(token));
  if (launched.status !== 202) throw new Error(`launch failed: ${JSON.stringify(launched.body)}`);
  for (let i = 0; i < 120; i++) {
    const match = [...app.deps.lobby.matches.values()].find((item) => item.roomId === roomId);
    if (match) return { match, serverId };
    await sleep(100);
  }
  throw new Error('the match was never allocated');
}

await withApp(async ({ call }) => {
  section('owner deletes an empty room');
  const token = await onboard(call);
  const created = await call('POST', '/v1/rooms', { name: 'Solo Room', region: 'iad', mapId: 'the-square', mode: 'tdm', capacity: 12 },
    { ...auth(token), 'idempotency-key': 'del-solo-create' });
  check(created.status === 201, 'room created', JSON.stringify(created.body));
  const roomId = created.body.room.roomId;

  const del = await call('DELETE', `/v1/rooms/${roomId}`, undefined, auth(token));
  check(del.status === 204, 'owner deletes their own solo room', JSON.stringify(del.body));

  const after = await call('GET', `/v1/rooms/${roomId}`, undefined, auth(token));
  check(after.status === 404, 'the room is actually gone', JSON.stringify(after.body));
});

await withApp(async ({ call }) => {
  section('a non-owner cannot delete');
  const ownerToken = await onboard(call);
  const otherToken = await onboard(call);
  const created = await call('POST', '/v1/rooms', { name: 'Not Yours', region: 'iad', mapId: 'the-square', mode: 'tdm', capacity: 12 },
    { ...auth(ownerToken), 'idempotency-key': 'del-nonowner-create' });
  const roomId = created.body.room.roomId;
  await call('POST', `/v1/rooms/${roomId}/join`, {}, { ...auth(otherToken), 'idempotency-key': 'del-nonowner-join' });

  const del = await call('DELETE', `/v1/rooms/${roomId}`, undefined, auth(otherToken));
  check(del.status === 403 && del.body?.error?.code === 'AUTH_FORBIDDEN', 'a non-owner is refused', JSON.stringify(del.body));

  const still = await call('GET', `/v1/rooms/${roomId}`, undefined, auth(ownerToken));
  check(still.status === 200, 'the room still exists after the refused attempt', JSON.stringify(still.body));
});

await withApp(async ({ call }) => {
  section('the owner cannot delete a room other players are still in');
  const ownerToken = await onboard(call);
  const otherToken = await onboard(call);
  const created = await call('POST', '/v1/rooms', { name: 'Company', region: 'iad', mapId: 'the-square', mode: 'tdm', capacity: 12 },
    { ...auth(ownerToken), 'idempotency-key': 'del-notempty-create' });
  const roomId = created.body.room.roomId;
  const joinReserve = await call('POST', `/v1/rooms/${roomId}/join`, {}, { ...auth(otherToken), 'idempotency-key': 'del-notempty-join' });
  const peer = lobbySocket(joinReserve.body);
  await peer.opened;
  await peer.wait((frame) => frame.t === 'lobby.welcome');

  const del = await call('DELETE', `/v1/rooms/${roomId}`, undefined, auth(ownerToken));
  check(del.status === 409 && del.body?.error?.code === 'ROOM_NOT_EMPTY', 'refused while another player is present', JSON.stringify(del.body));

  peer.ws.close();
  await call('POST', `/v1/rooms/${roomId}/leave`, {}, auth(otherToken));
  const retry = await call('DELETE', `/v1/rooms/${roomId}`, undefined, auth(ownerToken));
  check(retry.status === 204, 'succeeds once the room is empty again', JSON.stringify(retry.body));
});

await withApp(async ({ app, call }) => {
  section('a live match no longer strands its owner');
  const stub = await stubAuthority();
  try {
    const { token, roomId, socket } = await soloRoom(call, 'del-live');
    const { match, serverId } = await launchInto(call, app, stub, roomId, token);
    check(app.deps.lobby.rooms.get(roomId)?.status === 'in-progress',
      'the solo room of bots launched and is in-progress',
      String(app.deps.lobby.rooms.get(roomId)?.status));
    const reserved = await app.deps.store.matchServers.byId(serverId);
    check(reserved.inUse > 0, 'the authority is reserved while the match is live', JSON.stringify(reserved));

    // Entering the match is what closes the lobby socket. This is the state the reporter was
    // in: back at the shell, still the owner of a room with a match nobody is playing.
    socket.ws.close();
    await sleep(200);

    const del = await call('DELETE', `/v1/rooms/${roomId}`, undefined, auth(token));
    check(del.status === 204, 'the owner can delete their own room even with a match live',
      `${del.status} ${JSON.stringify(del.body)}`);

    const after = await call('GET', `/v1/rooms/${roomId}`, undefined, auth(token));
    check(after.status === 404, 'the room is actually gone', JSON.stringify(after.body));

    // Capacity is the part that bites silently. BOTH releases have to have happened.
    check(stub.releases.includes(match.matchId),
      'the match server was released remotely via /control/release', JSON.stringify(stub.releases));
    const registry = await app.deps.store.matchServers.byId(serverId);
    check(registry.inUse === 0 && registry.reservedAt === null,
      'the registry reservation was released too — no capacity leak', JSON.stringify(registry));
    check(!app.deps.lobby.matches.has(match.matchId),
      'the match is no longer tracked as live');
    const stored = await app.deps.store.matches.byId(match.matchId);
    check(stored?.status === 'aborted',
      'the match settled through the real terminal saga, not a silent drop', String(stored?.status));

    // The durable member row has to be closed with the room, or it outlives it forever.
    const openMembers = await app.deps.store.roomMembers.listForRoom(roomId);
    check(openMembers.length === 0,
      'no room_members row is left open against the deleted room', JSON.stringify(openMembers));
  } finally { stub.server.close(); }
});

await withApp(async ({ app, call }) => {
  section('a player inside a match keeps their lobby seat, and can go back in');
  const stub = await stubAuthority();
  try {
    const { token, roomId, socket } = await soloRoom(call, 'del-rejoin');
    const { match } = await launchInto(call, app, stub, roomId, token);
    socket.ws.close();
    await sleep(200);

    /**
     * Age the seat past GRACE_MS and sweep.
     *
     * This is the whole bug: a member of a LIVE match has no lobby socket by design, so the
     * flat grace test made every one of them expire 90 s in, and the last removal destroyed
     * the room mid-match. Before the fix this sweep left `rooms.get(roomId)` undefined and
     * `GET /v1/rooms/:id` 404 — with the match still running on a still-reserved server.
     */
    const room = app.deps.lobby.rooms.get(roomId);
    for (const member of room.members.values()) member.disconnectedAt = Date.now() - 10 * 60_000;
    await app.deps.lobby.sweep();

    check(app.deps.lobby.rooms.has(roomId),
      'the room survives a sweep while its own match is still live');
    check(app.deps.lobby.rooms.get(roomId)?.members.size === 1,
      'the player is still a member of it',
      String(app.deps.lobby.rooms.get(roomId)?.members.size));
    const detail = await call('GET', `/v1/rooms/${roomId}`, undefined, auth(token));
    check(detail.status === 200, 'and the room is still readable over HTTP', JSON.stringify(detail.body));

    // Rejoining uses the EXISTING reconnect path, both halves of it.
    const active = await call('GET', '/v1/matches/active', undefined, auth(token));
    check(active.status === 200 && active.body?.matchId === match.matchId,
      'GET /v1/matches/active still offers the match they are a member of',
      `${active.status} ${JSON.stringify(active.body)}`);
    const matchTicket = await call('POST', `/v1/matches/${match.matchId}/reconnect-ticket`, {}, auth(token));
    check(matchTicket.status === 200 && Boolean(matchTicket.body?.handoff?.sessionTicket),
      'POST /v1/matches/:matchId/reconnect-ticket hands back a real handoff',
      `${matchTicket.status} ${JSON.stringify(matchTicket.body?.handoff ? 'handoff' : matchTicket.body)}`);
    const roomTicket = await call('POST', `/v1/rooms/${roomId}/reconnect-ticket`, {}, auth(token));
    check(roomTicket.status === 200 && Boolean(roomTicket.body?.lobbyTicket),
      'and the lobby seat is still reconnectable rather than RECONNECT_GRACE_EXPIRED',
      `${roomTicket.status} ${JSON.stringify(roomTicket.body)}`);
  } finally { stub.server.close(); }
});

await withApp(async ({ app, call }) => {
  section('a swept lobby seat still lapses normally once no match holds the room');
  const { token, roomId, socket } = await soloRoom(call, 'del-lapse');
  socket.ws.close();
  await sleep(200);
  const room = app.deps.lobby.rooms.get(roomId);
  for (const member of room.members.values()) member.disconnectedAt = Date.now() - 10 * 60_000;
  await app.deps.lobby.sweep();
  check(!app.deps.lobby.rooms.has(roomId),
    'an abandoned room with no live match is still reaped — the guard is scoped, not a blanket');
  const gone = await call('GET', `/v1/rooms/${roomId}`, undefined, auth(token));
  check(gone.status === 404, 'and it is gone over HTTP', JSON.stringify(gone.body));
});

await withApp(async ({ call }) => {
  section('deleting a room that does not exist');
  const token = await onboard(call);
  const del = await call('DELETE', '/v1/rooms/01M0000000000000000000000A', undefined, auth(token));
  check(del.status === 404, 'a missing room refuses with NOT_FOUND', JSON.stringify(del.body));
});

{
  /**
   * The orphaned-membership leak.
   *
   * Hydration discards a room row that says `in-progress` with no match row behind it. It did
   * that with a bare `store.rooms.remove`, which in PostgreSQL is a SOFT delete — and
   * `rooms.list()` skips destroyed rows, so the member rows it left `left_at IS NULL` were
   * never looked at again by any later boot. They stay open forever, and `wasMemberAt` and
   * `recentFor` keep answering that those accounts are seated in a room that does not exist.
   */
  section('hydration closes the member rows of any room it discards');
  const config = loadConfig({ NODE_ENV: 'test', PLATFORM_PORT: '0' });
  const store = await createStore(config, { logger: silent() });
  const roomId = '01M00000000000000000ORPHAN';
  const accountId = '01M0000000000000000ACCOUNT';
  await store.rooms.upsert({
    roomId, ownerAccountId: accountId, name: 'Zombie', region: 'iad', mapId: 'the-square',
    mapVersion: '1.0.0', mode: 'tdm', rulesetVersion: 'tdm-1.0.0', build: '1.0.0', capacity: 12,
    status: 'in-progress', settings: {}, passwordHash: null, destroyedAt: null, destroyedReason: null,
    createdAt: new Date().toISOString(),
  });
  await store.roomMembers.upsert({
    roomId, accountId, displayName: 'Ghost', team: 'alpha', ready: false, isOwner: true,
    connection: 'reconnecting', disconnectedAt: null, estimatedRttMs: null, mutedAccountIds: [],
    loadout: { primaryIdx: 0, secondaryIdx: 0 }, joinedAt: new Date().toISOString(), leftAt: null,
  });
  check((await store.roomMembers.listForRoom(roomId)).length === 1,
    'the seeded zombie room has an open member row');

  const app = await buildApp(config, { logger: silent(), store });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-client-build': '1.0.0', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* the assertion will say so */ }
    return { status: res.status, body: json };
  };
  try {
    const token = await onboard(call);
    const listed = await call('GET', '/v1/rooms', undefined, auth(token));
    check(listed.status === 200, 'a lobby read hydrates the module', JSON.stringify(listed.body));
    check(!(listed.body?.rooms || []).some((room) => room.roomId === roomId),
      'the zombie room is not listed');
    const open = await store.roomMembers.listForRoom(roomId);
    check(open.length === 0,
      'the discarded room leaves NO room_members row open behind it', JSON.stringify(open));
  } finally {
    app.stop();
    app.server.closeAllConnections?.();
    await new Promise((r) => app.server.close(r));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
