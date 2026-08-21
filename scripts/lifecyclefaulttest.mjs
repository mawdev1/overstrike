/** P2.A7 real authority death at countdown, partial handoff, and live match. */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { WebSocket } from 'ws';
import { join } from 'node:path';
import { loadConfig } from '../platform/src/core/config.js';
import { buildApp } from '../platform/src/app.js';
import { ulid } from '../platform/src/core/ids.js';
import { encodeHello, decodeWelcome, decodeReject, PROTOCOL_VERSION } from '../src/net/protocol.js';

let passed = 0; let failed = 0;
const check = (v, n, d = '') => v ? (passed++, console.log(`  ok   ${n}`))
  : (failed++, console.log(`  FAIL ${n}${d ? `\n       ${d}` : ''}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logger = (() => { const f = () => {}; const l = { debug: (event, data) => {
  if (String(event).startsWith('lobby.match')) console.log('  ...', event, data);
}, info: f, warn: f, error: f }; l.child = () => l; return l; })();
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const platformPort = await freePort(); const gamePort = await freePort();
const matchSecret = 'fault-match-ticket-secret-not-production';
const controlSecret = 'fault-match-control-secret-not-production';
const serverId = `fault-${gamePort}`;
let game = null; let gameLog = '';
async function startGame() {
  gameLog = '';
  game = spawn(process.execPath, [join(process.cwd(), 'server/index.js'), `--port=${gamePort}`, '--bots=0', '--mode=tdm'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      NODE_ENV: 'production', NODE_NO_WARNINGS: '1', OVERSTRIKE_MATCH_TICKET_SECRET: matchSecret,
      OVERSTRIKE_MATCH_CONTROL_SECRET: controlSecret,
      OVERSTRIKE_PLATFORM_CONTROL_URL: `http://127.0.0.1:${platformPort}`,
      OVERSTRIKE_PUBLIC_WS_URL: `ws://127.0.0.1:${gamePort}`, OVERSTRIKE_SERVER_ID: serverId },
  });
  game.stdout.on('data', (c) => { gameLog += String(c); }); game.stderr.on('data', (c) => { gameLog += String(c); });
  for (let i = 0; i < 200; i++) {
    if (gameLog.includes('"event":"server.listening"')) return;
    if (game.exitCode !== null) throw new Error(`game exited ${game.exitCode}\n${gameLog}`);
    await sleep(25);
  }
  throw new Error(`game boot timeout\n${gameLog}`);
}
async function killGame() {
  if (!game || game.exitCode !== null || game.signalCode !== null) return;
  const exited = new Promise((resolve) => game.once('exit', resolve));
  if (!game.kill('SIGKILL') && game.exitCode === null && game.signalCode === null) throw new Error('failed to kill game server');
  if (game.exitCode === null && game.signalCode === null) await exited;
}

const config = loadConfig({ ...process.env, NODE_ENV: 'test', PLATFORM_PORT: String(platformPort),
  PLATFORM_STORAGE: process.env.PLATFORM_STORAGE || 'memory', PLATFORM_TRUSTED_PROXY_HOPS: '1',
  PLATFORM_MATCH_SERVER_URL: `ws://127.0.0.1:${gamePort}`, PLATFORM_MATCH_CONTROL_SECRET: controlSecret,
  PLATFORM_MATCH_TICKET_SECRET: matchSecret,
  PLATFORM_FLAG_OVERRIDES: 'map.the_square.enabled=true' });
const app = await buildApp(config, { logger });
await new Promise((resolve) => app.server.listen(platformPort, '127.0.0.1', resolve));
app.deps.lobby.pauseSweeper();
const base = `http://127.0.0.1:${platformPort}`;
await startGame();
async function waitRegistered() { for (let i = 0; i < 80; i++) { const row = await app.deps.store.matchServers.byId(serverId);
  if (row?.status === 'healthy' && row.inUse === 0) return; await sleep(100); } throw new Error('server registration timeout'); }
await waitRegistered();
async function call(method, path, body, token, extra = {}) {
  const headers = { 'content-type': 'application/json', 'x-client-build': '1.0.0', ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); return { status: response.status, body: text ? JSON.parse(text) : null };
}
let userIndex = 0;
async function onboard() {
  const i = ++userIndex; const sid = ulid(Date.now() + i); const ip = { 'x-forwarded-for': `203.0.113.${i}` };
  const e = await call('POST', '/v1/onboarding/eligibility', { dateOfBirth: '1990-01-01', jurisdiction: 'CA-ON' }, null, ip);
  const c = await call('PUT', '/v1/onboarding/consent', { telemetryPersonal: false, policyVersion: 1, clientSessionId: sid }, null, ip);
  const s = await call('POST', '/v1/auth/signup', { email: `fault-${ulid()}@example.invalid`,
    password: 'correct horse battery staple', displayName: `Fault${i}X`, eligibilityReceipt: e.body.receipt,
    clientSessionId: sid, consentReceipt: c.body.receipt }, null, ip);
  return { token: s.body.accessToken, accountId: s.body.profile.accountId };
}
function lobby(h) {
  const url = new URL(h.lobbySocketUrl); url.searchParams.set('ticket', h.lobbyTicket);
  const ws = new WebSocket(url); const frames = []; const waits = [];
  ws.on('message', (raw) => { const f = JSON.parse(String(raw)); frames.push(f); for (const w of [...waits]) if (w.p(f)) {
    clearTimeout(w.t); waits.splice(waits.indexOf(w), 1); w.r(f); } });
  return { ws, frames, opened: new Promise((r, j) => { ws.once('open', r); ws.once('error', j); }),
    send(t, d) { const correlationId = ulid(); ws.send(JSON.stringify({ t, correlationId, d })); return correlationId; },
    wait(p, ms = 10_000) { const f = frames.find(p); if (f) return Promise.resolve(f); return new Promise((r, j) => {
      const w = { p, r, t: setTimeout(() => { waits.splice(waits.indexOf(w), 1); j(new Error('frame timeout')); }, ms) }; waits.push(w); }); } };
}
async function roomPair(label) {
  const users = await Promise.all([onboard(), onboard()]);
  const created = await call('POST', '/v1/rooms', { name: label, region: 'iad', mapId: 'the-square',
    mode: 'tdm', capacity: 2, settings: { requiredReady: 2, minPlayers: 2 } }, users[0].token,
  { 'idempotency-key': `${label}-create` });
  const a = lobby(created.body); await a.opened; await a.wait((f) => f.t === 'lobby.welcome');
  const joined = await call('POST', `/v1/rooms/${created.body.room.roomId}/join`, {}, users[1].token,
    { 'idempotency-key': `${label}-join` });
  const b = lobby(joined.body); await b.opened; await b.wait((f) => f.t === 'lobby.welcome');
  return { users, roomId: created.body.room.roomId, peers: [a, b] };
}
async function readyLaunch(pair) {
  for (const p of pair.peers) { const c = p.send('ready.set', { ready: true }); await p.wait((f) => f.t === 'ready.changed' && f.correlationId === c); }
  const c = pair.peers[0].send('launch.request', {}); await pair.peers[0].wait((f) => f.t === 'countdown.started' && f.correlationId === c); return c;
}
async function reap() {
  // The first two failed probes are represented explicitly so this focused harness does not
  // race the module's real 15-second background sweeper with three concurrent terminal sagas.
  for (const match of app.deps.lobby.matches.values()) match.healthMisses = 2;
  await Promise.race([app.deps.lobby.sweep(), sleep(12_000).then(() => { throw new Error('terminal sweep timeout'); })]);
}
async function gameHello(ticket) { const ws = new WebSocket(`ws://127.0.0.1:${gamePort}`); return new Promise((resolve, reject) => {
  ws.once('open', () => ws.send(Buffer.from(encodeHello(PROTOCOL_VERSION, ticket)))); ws.once('error', reject);
  ws.once('message', (raw) => { const bytes = raw instanceof ArrayBuffer ? raw
    : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  resolve({ ws, welcome: decodeWelcome(bytes), rejection: decodeReject(bytes) }); }); }); }

const allPeers = [];
const nativeFetch = globalThis.fetch;
try {
  const countdown = await roomPair('fault-countdown'); allPeers.push(...countdown.peers);
  const countdownCorrelation = await readyLaunch(countdown); await killGame();
  const countdownFailure = await countdown.peers[0].wait((f) => f.t === 'match.failed' && f.correlationId === countdownCorrelation);
  check(['MATCH_ALLOCATION_FAILED', 'MATCH_SERVER_UNREACHABLE'].includes(countdownFailure.d.error.code)
    && app.deps.lobby.rooms.get(countdown.roomId).status === 'open'
    && (await app.deps.store.matchServers.byId(serverId)).inUse === 0,
  'authority death during countdown aborts readiness/allocation with no leaked lease or active match',
  JSON.stringify({ code: countdownFailure.d.error.code, status: app.deps.lobby.rooms.get(countdown.roomId).status,
    server: await app.deps.store.matchServers.byId(serverId) }));
  for (const peer of countdown.peers) peer.ws.close();
  await sleep(500);

  await startGame(); await waitRegistered();
  const delivery = await roomPair('fault-before-handoff'); allPeers.push(...delivery.peers);
  let killAfterAllocate = true;
  globalThis.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    const url = String(args[0]?.url ?? args[0]);
    if (killAfterAllocate && url.endsWith('/control/allocate') && response.ok) {
      killAfterAllocate = false;
      await killGame();
    }
    return response;
  };
  const deliveryCorrelation = await readyLaunch(delivery);
  const deliveryFailure = await delivery.peers[0].wait((f) => f.t === 'match.failed'
    && f.correlationId === deliveryCorrelation);
  globalThis.fetch = nativeFetch;
  check(!delivery.peers.some((peer) => peer.frames.some((frame) => frame.t === 'match.ready'
    && frame.correlationId === deliveryCorrelation))
    && deliveryFailure.d.error.code === 'MATCH_ALLOCATION_FAILED'
    && app.deps.lobby.rooms.get(delivery.roomId).status === 'open'
    && ![...app.deps.lobby.matches.values()].some((match) => match.roomId === delivery.roomId)
    && (await app.deps.store.matchServers.byId(serverId)).inUse === 0,
  'authority death after allocation but before handoff delivery emits no ticket and leaves no match or lease',
  JSON.stringify({ code: deliveryFailure.d.error.code,
    readyFrames: delivery.peers.map((peer) => peer.frames.filter((frame) => frame.t === 'match.ready').length),
    room: app.deps.lobby.rooms.get(delivery.roomId)?.status,
    server: await app.deps.store.matchServers.byId(serverId) }));
  for (const peer of delivery.peers) peer.ws.close();
  await sleep(500);

  await startGame(); await waitRegistered();
  const handoff = await roomPair('fault-handoff'); allPeers.push(...handoff.peers);
  const handoffCorrelation = await readyLaunch(handoff);
  const handoffs = await Promise.all(handoff.peers.map((p) => p.wait((f) => f.t === 'match.ready' && f.correlationId === handoffCorrelation)));
  const first = await gameHello(handoffs[0].d.sessionTicket); await killGame();
  console.log('  ... partial handoff authority killed; reaping'); await sleep(250); await reap();
  const halfMatch = await app.deps.store.matches.byId(handoffs[0].d.matchId);
  check(first.welcome && halfMatch.status === 'aborted' && app.deps.lobby.rooms.get(handoff.roomId).status === 'open'
    && !app.deps.lobby.matches.has(handoffs[0].d.matchId)
    && (await app.deps.store.matchServers.byId(serverId)).inUse === 0,
  'authority death after one of two handoffs admits no duplicate identity and atomically reaps the partial match',
  JSON.stringify({ welcome: Boolean(first.welcome), rejection: first.rejection, match: halfMatch?.status,
    room: app.deps.lobby.rooms.get(handoff.roomId)?.status,
    active: app.deps.lobby.matches.has(handoffs[0].d.matchId), server: await app.deps.store.matchServers.byId(serverId) }));
  first.ws.close();
  for (const peer of handoff.peers) peer.ws.close();
  await sleep(500);

  await startGame(); await waitRegistered();
  const live = await roomPair('fault-live'); allPeers.push(...live.peers);
  const liveCorrelation = await readyLaunch(live);
  const liveHandoffs = await Promise.all(live.peers.map((p) => p.wait((f) => f.t === 'match.ready' && f.correlationId === liveCorrelation)));
  const admitted = await Promise.all(liveHandoffs.map((f) => gameHello(f.d.sessionTicket)));
  await killGame(); console.log('  ... live authority killed; reaping'); await sleep(250); await reap();
  const deadMatch = await app.deps.store.matches.byId(liveHandoffs[0].d.matchId);
  check(admitted.every((x) => x.welcome) && deadMatch.status === 'aborted'
    && app.deps.lobby.rooms.get(live.roomId).status === 'open'
    && (await app.deps.store.matchServers.byId(serverId)).inUse === 0,
  'mid-match authority death leaves no zombie, stuck user, duplicate identity, or reserved capacity',
  JSON.stringify({ admitted: admitted.map((x) => Boolean(x.welcome)), rejections: admitted.map((x) => x.rejection), match: deadMatch?.status,
    room: app.deps.lobby.rooms.get(live.roomId)?.status, server: await app.deps.store.matchServers.byId(serverId) }));
  for (const x of admitted) x.ws.close();

  await startGame(); await waitRegistered();
  const retryCorrelation = await readyLaunch(live);
  const retry = await live.peers[0].wait((f) => f.t === 'match.ready' && f.correlationId === retryCorrelation);
  check(retry.d.matchId !== liveHandoffs[0].d.matchId,
    'the preserved lobby safely retries into a distinct rematch after authority death');
} finally {
  globalThis.fetch = nativeFetch;
  for (const p of allPeers) try { p.ws.close(); } catch {}
  await killGame(); app.stop(); app.server.closeAllConnections?.();
  await new Promise((resolve) => app.server.close(resolve)); await app.deps.store.close();
}
console.log(`\n${passed} passed, ${failed} failed`); if (failed) process.exit(1);
