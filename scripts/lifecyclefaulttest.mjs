/** P2.A7 real authority death at countdown, partial handoff, and live match. */
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';
import { join } from 'node:path';
import { loadConfig } from '../platform/src/core/config.js';
import { buildApp } from '../platform/src/app.js';
import { ulid } from '../platform/src/core/ids.js';
import { encodeHello, encodeLoadout, decodeWelcome, decodeReject, PROTOCOL_VERSION } from '../src/net/protocol.js';

let passed = 0; let failed = 0;
const check = (v, n, d = '') => v ? (passed++, console.log(`  ok   ${n}`))
  : (failed++, console.log(`  FAIL ${n}${d ? `\n       ${d}` : ''}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const logger = (() => { const f = () => {}; const l = { debug: (event, data) => {
  if (String(event).startsWith('lobby.match')) console.log('  ...', event, data);
}, info: f, warn: f, error: (event, data) => {
  if (String(event).startsWith('lobby.match')) console.log('  ...', event, data);
} }; l.child = () => l; return l; })();
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const platformPort = await freePort(); const gamePort = await freePort();
const matchSecret = 'fault-match-ticket-secret-not-production';
const controlSecret = 'fault-match-control-secret-not-production';
const serverId = `fault-${gamePort}`;
let game = null; let gameLog = '';
async function startGame(extraArgs = []) {
  gameLog = '';
  game = spawn(process.execPath, [join(process.cwd(), 'server/index.js'), `--port=${gamePort}`, '--bots=0', '--mode=tdm', ...extraArgs], {
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
async function gameHello(ticket, { commanded = false } = {}) { const ws = new WebSocket(`ws://127.0.0.1:${gamePort}`); return new Promise((resolve, reject) => {
  ws.once('open', () => ws.send(Buffer.from(encodeHello(PROTOCOL_VERSION, ticket)))); ws.once('error', reject);
  ws.once('message', (raw) => { const bytes = raw instanceof ArrayBuffer ? raw
    : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const welcome = decodeWelcome(bytes);
  // The authority's referee clock only starts once every seat has authenticated AND
  // committed a loadout (server/index.js pump). A seat that says hello and nothing else
  // holds every timer-driven section below open forever.
  if (commanded && welcome) ws.send(Buffer.from(encodeLoadout(0, 0)));
  resolve({ ws, welcome, rejection: decodeReject(bytes) }); }); }); }

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
  for (const peer of live.peers) peer.ws.close();
  await killGame(); await sleep(250); await reap();

  // ── terminal on a REACHABLE authority whose result the platform cannot apply ─────────────
  //
  // The production failure shape (overstrike-gs-iad-1, 2026-08-21..23): the authority ends the
  // match, answers /control/status perfectly, and publishes a terminal result the platform's
  // applier refuses. That refusal used to be counted as a HEALTH MISS, so after three sweeps
  // the match was aborted as authority-gone — releasing only the store reservation and leaving
  // the live server bound (and heartbeating itself full) forever. The abort is acceptable; the
  // missing remote release is not.
  const stubPort = await freePort();
  const stubServerId = `stub-${stubPort}`;
  const stubReleases = [];
  let stubAllocation = null;
  let stubStatusCalls = 0;
  const stub = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/control/allocate' && req.method === 'POST') {
        stubAllocation = JSON.parse(raw); stubStatusCalls = 0;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, matchId: stubAllocation.matchId, capacity: 12, region: 'iad' }));
      } else if (req.url === '/control/status' && req.method === 'GET') {
        const first = stubStatusCalls++ === 0;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, region: 'iad', capacity: 12, connected: 0, available: 12,
          draining: false, matchId: stubAllocation?.matchId ?? null, roomId: stubAllocation?.roomId ?? null,
          status: stubAllocation ? (first ? 'allocated' : 'ended') : 'idle',
          // Deliberately unappliable: a "completed" terminal with no evidence body.
          result: stubAllocation && !first ? { matchId: stubAllocation.matchId, status: 'completed' } : null,
          seats: [] }));
      } else if (req.url === '/control/release' && req.method === 'POST') {
        stubReleases.push(JSON.parse(raw).matchId);
        res.writeHead(204); res.end();
      } else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise((r) => stub.listen(stubPort, '127.0.0.1', r));
  const registered = await call('POST', '/v1/control/match-servers/register', {
    serverId: stubServerId, region: 'iad', address: `ws://127.0.0.1:${stubPort}`, capacity: 12, build: '1.0.0',
  }, null, { authorization: `Bearer ${controlSecret}` });
  check(registered.status === 201, 'the unappliable-result stub authority registers');
  const reject = await roomPair('fault-reject'); allPeers.push(...reject.peers);
  const rejectCorrelation = await readyLaunch(reject);
  await Promise.all(reject.peers.map((p) => p.wait((f) => f.t === 'match.ready' && f.correlationId === rejectCorrelation)));
  const rejectMatch = [...app.deps.lobby.matches.values()].find((m) => m.roomId === reject.roomId);
  check(Boolean(rejectMatch) && rejectMatch.serverId === stubServerId,
    'the platform allocated the reachable stub authority', JSON.stringify({ serverId: rejectMatch?.serverId }));
  // Two refusals already counted, exactly as reap() represents prior probes; one sweep decides.
  rejectMatch.completionFailures = 2;
  for (const r of app.deps.lobby.rooms.values()) for (const m of r.members.values()) m.lastAckAt = Date.now();
  await Promise.race([app.deps.lobby.sweep(), sleep(12_000).then(() => { throw new Error('reject sweep timeout'); })]);
  const rejectStored = await app.deps.store.matches.byId(rejectMatch.matchId);
  check(rejectStored?.status === 'aborted' && rejectStored?.outcomeReason === 'no-contest'
    && stubReleases.includes(rejectMatch.matchId)
    && !app.deps.lobby.matches.has(rejectMatch.matchId)
    && app.deps.lobby.rooms.get(reject.roomId)?.status === 'open'
    && (await app.deps.store.matchServers.byId(stubServerId)).inUse === 0,
  'a refused terminal on a reachable authority aborts no-contest AND still releases the authority remotely',
  JSON.stringify({ stored: rejectStored?.status, outcomeReason: rejectStored?.outcomeReason,
    remoteReleases: stubReleases, stillActive: app.deps.lobby.matches.has(rejectMatch.matchId),
    room: app.deps.lobby.rooms.get(reject.roomId)?.status,
    server: await app.deps.store.matchServers.byId(stubServerId) }));
  for (const peer of reject.peers) peer.ws.close();
  stub.close();
  // Retire the stub from the registry's healthy set so later sections never allocate it.
  await app.deps.store.matchServers.heartbeat(stubServerId, { capacity: 12, inUse: 0,
    status: 'unhealthy', lastHeartbeatAt: new Date(0).toISOString() });
  await sleep(500);

  // ── the production defect verbatim: terminal on a reachable authority must complete ──────
  //
  // A real match runs to its own terminal with players connected; their clients close a
  // moment AFTER the outcome (exactly what a browser returning to the shell does). Those
  // closes record post-terminal connection facts, which used to mutate the live arrays
  // aliased inside the already-certified evidence record — so the platform read a terminal
  // record that disagreed with its own eventTimeline and evidenceRef, refused it three
  // times, and voided a finished match as an authority-gone abort (every live prod match,
  // 2026-08-21..23). With the evidence snapshot fix, this sweep must produce 'completed'.
  await startGame(['--timelimit=2']); await waitRegistered();
  const finish = await roomPair('fault-finish'); allPeers.push(...finish.peers);
  const finishCorrelation = await readyLaunch(finish);
  const finishHandoffs = await Promise.all(finish.peers.map((p) => p.wait((f) => f.t === 'match.ready' && f.correlationId === finishCorrelation)));
  const finishMatchId = finishHandoffs[0].d.matchId;
  const finishAdmitted = await Promise.all(finishHandoffs.map((f) => gameHello(f.d.sessionTicket, { commanded: true })));
  check(finishAdmitted.every((x) => x.welcome), 'both seats enter the finishing authority');
  const finishStatus = async () => (await fetch(`http://127.0.0.1:${gamePort}/control/status`, {
    headers: { authorization: `Bearer ${controlSecret}` } })).json();
  let finished = null;
  for (let i = 0; i < 200; i++) { finished = await finishStatus(); if (finished.status === 'ended') break; await sleep(100); }
  check(finished?.status === 'ended' && finished?.result?.status === 'completed',
    'the finishing authority certifies its terminal result', JSON.stringify({ status: finished?.status }));
  // The prod trigger: clients leave AFTER the terminal record was certified.
  for (const x of finishAdmitted) x.ws.close();
  await sleep(400);
  for (const r of app.deps.lobby.rooms.values()) for (const m of r.members.values()) m.lastAckAt = Date.now();
  await Promise.race([app.deps.lobby.sweep(), sleep(12_000).then(() => { throw new Error('finish sweep timeout'); })]);
  const finishStored = await app.deps.store.matches.byId(finishMatchId);
  check(finishStored?.status === 'completed' && Boolean(finishStored?.resultAppliedAt)
    && !app.deps.lobby.matches.has(finishMatchId)
    && app.deps.lobby.rooms.get(finish.roomId)?.status === 'open'
    && (await app.deps.store.matchServers.byId(serverId)).inUse === 0,
  'a finished match whose players left after the terminal still ends completed with the authority released',
  JSON.stringify({ stored: finishStored?.status, applied: finishStored?.resultAppliedAt,
    room: app.deps.lobby.rooms.get(finish.roomId)?.status,
    server: await app.deps.store.matchServers.byId(serverId) }));
  for (const peer of finish.peers) peer.ws.close();
  await killGame(); await sleep(250);

  // ── ended-and-abandoned authority self-releases without losing its terminal record ───────
  //
  // The defensive half: if the platform's release saga never lands at all, an ended match with
  // nobody connected must not hold a region's capacity hostage. After the grace the authority
  // frees itself, keeps the terminal record served through /control/status.releasedResults,
  // and a late platform sweep completes the match from that archive instead of voiding it.
  await startGame(['--timelimit=2', '--selfreleasems=1500']); await waitRegistered();
  const solo = await roomPair('fault-selfrelease'); allPeers.push(...solo.peers);
  const soloCorrelation = await readyLaunch(solo);
  const soloHandoffs = await Promise.all(solo.peers.map((p) => p.wait((f) => f.t === 'match.ready' && f.correlationId === soloCorrelation)));
  const soloMatchId = soloHandoffs[0].d.matchId;
  const soloAdmitted = await Promise.all(soloHandoffs.map((f) => gameHello(f.d.sessionTicket, { commanded: true })));
  check(soloAdmitted.every((x) => x.welcome), 'both seats enter the short-timer authority');
  const gameStatus = async () => (await fetch(`http://127.0.0.1:${gamePort}/control/status`, {
    headers: { authorization: `Bearer ${controlSecret}` } })).json();
  let ended = null;
  for (let i = 0; i < 200; i++) { ended = await gameStatus(); if (ended.status === 'ended') break; await sleep(100); }
  check(ended?.status === 'ended' && ended?.result?.status === 'completed',
    'the authority certifies its terminal result', JSON.stringify({ status: ended?.status, result: Boolean(ended?.result) }));
  for (const x of soloAdmitted) x.ws.close();
  let freed = null;
  for (let i = 0; i < 120; i++) {
    freed = await gameStatus();
    if (freed.matchId === null && freed.releasedResults?.some((row) => row.matchId === soloMatchId)) break;
    await sleep(250);
  }
  check(freed?.matchId === null && freed?.releasedResults?.some((row) => row.matchId === soloMatchId)
    && gameLog.includes('"event":"match.self_released"'),
  'the abandoned ended authority self-releases loudly and keeps serving the terminal record',
  JSON.stringify({ matchId: freed?.matchId, released: freed?.releasedResults?.map((row) => row.matchId) }));
  // The registry row stays reserved until the platform's own saga releases it — the
  // reservation-protection window is deliberate — so occupancy is asserted after the sweep.
  for (const r of app.deps.lobby.rooms.values()) for (const m of r.members.values()) m.lastAckAt = Date.now();
  await Promise.race([app.deps.lobby.sweep(), sleep(12_000).then(() => { throw new Error('archive sweep timeout'); })]);
  const soloStored = await app.deps.store.matches.byId(soloMatchId);
  const soloEvidence = await app.deps.store.matchEvidence.byMatchId(soloMatchId);
  check(soloStored?.status === 'completed' && Boolean(soloStored?.resultAppliedAt)
    && soloEvidence?.evidenceRef === soloStored?.evidenceRef
    && !app.deps.lobby.matches.has(soloMatchId)
    && app.deps.lobby.rooms.get(solo.roomId)?.status === 'open'
    && (await app.deps.store.matchServers.byId(serverId)).inUse === 0,
  'a late platform sweep completes the match from the self-released archive instead of voiding it',
  JSON.stringify({ stored: soloStored?.status, applied: soloStored?.resultAppliedAt,
    evidence: Boolean(soloEvidence), room: app.deps.lobby.rooms.get(solo.roomId)?.status,
    server: await app.deps.store.matchServers.byId(serverId) }));
  for (const peer of solo.peers) peer.ws.close();
} finally {
  globalThis.fetch = nativeFetch;
  for (const p of allPeers) try { p.ws.close(); } catch {}
  await killGame(); app.stop(); app.server.closeAllConnections?.();
  await new Promise((resolve) => app.server.close(resolve)); await app.deps.store.close();
}
console.log(`\n${passed} passed, ${failed} failed`); if (failed) process.exit(1);
