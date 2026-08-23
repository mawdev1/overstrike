/**
 * DELETE /v1/rooms/:id — an owner can close a room they created, but only when they are the
 * only one left in it. Kicking OTHER connected members has no notification path anywhere in
 * this codebase yet (removeMember deletes a removed member's own connection before the
 * broadcast that would have reached them), so this endpoint deliberately stays inside what the
 * existing empty-room-destroy branch already covers rather than half-building a kick feature.
 */
import { loadConfig } from '../src/core/config.js';
import { buildApp } from '../src/app.js';
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

await withApp(async ({ call }) => {
  section('deleting a room that does not exist');
  const token = await onboard(call);
  const del = await call('DELETE', '/v1/rooms/01M0000000000000000000000A', undefined, auth(token));
  check(del.status === 404, 'a missing room refuses with NOT_FOUND', JSON.stringify(del.body));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
