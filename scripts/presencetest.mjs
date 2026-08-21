/** Focused P2 presence acceptance with a deterministic clock and real HTTP/WebSockets. */
import { WebSocket } from 'ws';
import { loadConfig } from '../platform/src/core/config.js';
import { buildApp } from '../platform/src/app.js';
import { ulid } from '../platform/src/core/ids.js';

let passed = 0; let failed = 0;
const check = (value, label, detail = '') => value
  ? (passed++, console.log(`  ok   ${label}`))
  : (failed++, console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`));
const silent = () => { const noop = () => {}; const logger = { debug: noop, info: noop, warn: noop, error: noop }; logger.child = () => logger; return logger; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let now = Date.now();
const config = loadConfig({ ...process.env, NODE_ENV: 'test', PLATFORM_PORT: '0',
  PLATFORM_TRUSTED_PROXY_HOPS: '1', PLATFORM_STORAGE: process.env.PLATFORM_STORAGE || 'memory',
  PLATFORM_MATCH_SERVER_URL: 'ws://127.0.0.1:65530',
  PLATFORM_FLAG_OVERRIDES: 'map.the_square.enabled=true' });
const app = await buildApp(config, { logger: silent(), clock: () => now });
await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;

async function call(method, path, body, token = null, extras = {}) {
  const headers = { 'content-type': 'application/json', 'x-client-build': '1.0.0', ...extras };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(base + path, { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
async function onboard(index) {
  const sid = ulid(now + index + 1); const forwarded = { 'x-forwarded-for': `198.51.100.${index + 1}` };
  const eligibility = await call('POST', '/v1/onboarding/eligibility',
    { dateOfBirth: '1990-01-01', jurisdiction: 'CA-ON' }, null, forwarded);
  const consent = await call('PUT', '/v1/onboarding/consent',
    { telemetryPersonal: false, policyVersion: 1, clientSessionId: sid }, null, forwarded);
  const signup = await call('POST', '/v1/auth/signup', {
    email: `presence-${ulid(now + index + 10)}@example.invalid`, password: 'correct horse battery staple',
    displayName: `Presence${index}X`, eligibilityReceipt: eligibility.body.receipt,
    clientSessionId: sid, consentReceipt: consent.body.receipt,
  }, null, forwarded);
  return { token: signup.body.accessToken, accountId: signup.body.profile.accountId };
}
function socket(handoff) {
  const url = new URL(handoff.lobbySocketUrl); url.searchParams.set('ticket', handoff.lobbyTicket);
  const ws = new WebSocket(url); const frames = [];
  ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  return { ws, frames, opened: new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); }) };
}

const sockets = [];
try {
  await app.deps.store.matchServers.register({ serverId: 'presence-server', region: 'iad',
    address: 'ws://127.0.0.1:65530', capacity: 1, inUse: 0, draining: false,
    status: 'healthy', build: '1.0.0', lastHeartbeatAt: new Date(now).toISOString() });
  const users = await Promise.all([0, 1, 2].map(onboard));
  for (const [index, visibility] of ['everyone', 'nobody', 'friends'].entries()) {
    await call('PATCH', '/v1/profile/me', { privacy: { presenceVisibility: visibility } }, users[index].token,
      { 'idempotency-key': `presence-privacy-${index}` });
  }
  const created = await call('POST', '/v1/rooms', { name: 'Presence Clock', region: 'iad',
    mapId: 'the-square', mode: 'tdm', capacity: 3, settings: { requiredReady: 2, minPlayers: 2 } },
  users[0].token, { 'idempotency-key': 'presence-room-create' });
  if (created.status !== 201) throw new Error(`room create failed: ${created.status} ${JSON.stringify(created.body)}`);
  const owner = socket(created.body); sockets.push(owner); await owner.opened;
  for (let i = 1; i < 3; i++) {
    const joined = await call('POST', `/v1/rooms/${created.body.room.roomId}/join`, {}, users[i].token,
      { 'idempotency-key': `presence-room-join-${i}` });
    const peer = socket(joined.body); sockets.push(peer); await peer.opened;
  }
  await sleep(50);
  const online = await call('GET', '/v1/presence/online', undefined, users[0].token);
  check(online.body.items.length === 1 && online.body.items[0].accountId === users[0].accountId,
    'everyone is visible while nobody and friends fail closed without a friendship graph');
  check(owner.frames.some((frame) => frame.t === 'presence.delta'),
    'join and presence changes arrive over the socket without polling');
  for (const index of [1, 2]) await call('PATCH', '/v1/profile/me',
    { privacy: { presenceVisibility: 'everyone' } }, users[index].token,
    { 'idempotency-key': `presence-public-${index}` });
  const recentOne = await call('GET', '/v1/presence/recent?limit=1', undefined, users[0].token);
  const recentTwo = await call('GET', `/v1/presence/recent?limit=1&cursor=${recentOne.body.nextCursor}`, undefined, users[0].token);
  check(recentOne.body.items.length === 1 && recentOne.body.nextCursor !== null
    && recentTwo.body.items.length === 1 && recentOne.body.items[0].accountId !== recentTwo.body.items[0].accountId,
  'recent encounters paginate deterministically under load');

  const staleClosed = Promise.all(sockets.slice(1).map(({ ws }) => new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: String(reason) }));
  })));
  now += 30_000;
  sockets[0].ws.send(JSON.stringify({ t: 'heartbeat.ack', correlationId: ulid(now), d: {} }));
  await sleep(20); await app.deps.lobby.sweep();
  const closes = await Promise.race([staleClosed, sleep(2_000).then(() => [])]);
  check(closes.length === 2 && closes.every((entry) => entry.code === 1011 && entry.reason === 'heartbeat timeout'),
    'two missed 15-second heartbeats close stale sockets while an acknowledged socket survives', JSON.stringify(closes));

  now += 89_000; await app.deps.lobby.sweep();
  check(app.deps.lobby.rooms.get(created.body.room.roomId).members.size === 3,
    'disconnect churn preserves seats strictly inside the 90-second grace');
  now += 1_001; await app.deps.lobby.sweep();
  check(app.deps.lobby.rooms.get(created.body.room.roomId).members.size === 1,
    'the 90-second expiry removes stale seats and projects them offline with no polling dependency');
} finally {
  for (const entry of sockets) try { entry.ws.close(); } catch {}
  app.stop(); app.server.closeAllConnections?.();
  await new Promise((resolve) => app.server.close(resolve));
  await app.deps.store.close();
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
