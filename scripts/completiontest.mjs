/** Real normal-finish lifecycle: platform handoff -> server matchEnd -> result -> rematch. */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { buildApp } from '../platform/src/app.js';
import { loadConfig } from '../platform/src/core/config.js';
import { ulid } from '../platform/src/core/ids.js';
import { encodeHello, encodeLoadout, decodeWelcome, decodeReject, PROTOCOL_VERSION } from '../src/net/protocol.js';
import { reconstructEvidenceResult, evidenceDigest } from '../platform/src/shared/evidenceDigest.js';

let passed = 0;
let failed = 0;
const check = (condition, label, detail = '') => {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const browserLive = process.env.OVERSTRIKE_BROWSER_LIVE === '1';
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port; probe.close(() => resolve(port));
  });
});
const logger = (() => {
  const noop = () => {};
  const value = { debug: noop, info: noop, warn: noop, error: noop };
  value.child = () => value;
  return value;
})();

const matchPort = await freePort();
const platformPort = await freePort();
const matchSecret = 'DEV-ONLY-INSECURE-MATCH-TICKET-SECRET-do-not-ship';
const controlSecret = 'DEV-ONLY-INSECURE-MATCH-CONTROL-SECRET-do-not-ship';
const gameServer = spawn(process.execPath, [join(root, 'server/index.js'), `--port=${matchPort}`,
  '--bots=4', '--mode=tdm', `--timelimit=${browserLive ? 30 : 5}`, '--killlimit=75'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production', NODE_NO_WARNINGS: '1', OVERSTRIKE_MATCH_TICKET_SECRET: matchSecret,
    OVERSTRIKE_MATCH_CONTROL_SECRET: controlSecret,
    OVERSTRIKE_PLATFORM_CONTROL_URL: `http://127.0.0.1:${platformPort}`,
    OVERSTRIKE_PUBLIC_WS_URL: `ws://127.0.0.1:${matchPort}`,
    OVERSTRIKE_SERVER_ID: `completion-${matchPort}`,
    // The seat-lifecycle clock seam (server/index.js `seatClock`). Without it this harness
    // races the authority's 60 s `connectBy` window with however long Chromium takes to load
    // the engine through Vite — which is a wall-clock deadline the harness does not control.
    OVERSTRIKE_SEAT_CLOCK_CONTROL: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let gameLog = '';
gameServer.stdout.on('data', (chunk) => { gameLog += String(chunk); });
gameServer.stderr.on('data', (chunk) => { gameLog += String(chunk); });
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`game server boot timeout\n${gameLog}`)), 20_000);
  const poll = setInterval(() => {
    if (gameLog.includes('"event":"server.listening"')) {
      clearTimeout(timeout); clearInterval(poll); resolve();
    } else if (gameServer.exitCode !== null) {
      clearTimeout(timeout); clearInterval(poll);
      reject(new Error(`game server exited ${gameServer.exitCode}\n${gameLog}`));
    }
  }, 25);
});

const config = loadConfig({ ...process.env, NODE_ENV: 'test', PLATFORM_PORT: String(platformPort),
  PLATFORM_STORAGE: 'memory', PLATFORM_TRUSTED_PROXY_HOPS: '1',
  PLATFORM_MATCH_SERVER_URL: `ws://127.0.0.1:${matchPort}`,
  PLATFORM_MATCH_CONTROL_SECRET: controlSecret,
  PLATFORM_FLAG_OVERRIDES: 'mode.bomb.enabled=true,map.the_square.enabled=true' });
const app = await buildApp(config, { logger });
await new Promise((resolve) => app.server.listen(platformPort, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
for (let attempt = 0; attempt < 40; attempt++) {
  if (await app.deps.store.matchServers.byId(`completion-${matchPort}`)) break;
  await sleep(250);
}
if (!await app.deps.store.matchServers.byId(`completion-${matchPort}`)) {
  throw new Error('game server did not register with platform control plane');
}

async function call(method, path, body, token = null, extras = {}) {
  const headers = { 'content-type': 'application/json', 'x-client-build': '1.0.0', ...extras };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(base + path, { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function onboard(index) {
  const clientSessionId = ulid(Date.now() + index);
  const forwarded = { 'x-forwarded-for': `198.51.100.${index + 10}` };
  const eligibility = await call('POST', '/v1/onboarding/eligibility',
    { dateOfBirth: '1990-01-01', jurisdiction: 'CA-ON' }, null, forwarded);
  const consent = await call('PUT', '/v1/onboarding/consent',
    { telemetryPersonal: false, policyVersion: 1, clientSessionId }, null, forwarded);
  const email = `completion-${Date.now()}-${index}@example.invalid`;
  const password = 'correct horse battery staple';
  const signup = await call('POST', '/v1/auth/signup', {
    email, password, displayName: `Finish${index}X`,
    eligibilityReceipt: eligibility.body.receipt, clientSessionId,
    consentReceipt: consent.body.receipt,
  }, null, forwarded);
  if (signup.status !== 201) throw new Error(`onboard failed: ${JSON.stringify(signup.body)}`);
  return { token: signup.body.accessToken, accountId: signup.body.profile.accountId, email, password };
}

/**
 * A lobby client that answers heartbeats, because a real one does.
 *
 * These sockets used to ignore the server's `heartbeat` frames entirely. The lobby closes a
 * socket that misses two of them (30 s) and releases its seat 90 s after that, so every one
 * of these fake players was on a 120-second fuse from the moment it connected — and the
 * harness passed only for as long as it finished first. Under load it does not: four
 * concurrent runs put the room past the fuse, the room emptied and was destroyed, and the
 * rematch leg failed with `lobby reconnect 404`.
 *
 * That is the same defect as the seat-clock one, wearing a different hat: a test racing a
 * real deadline instead of controlling it. Here the control is free and needs no seam —
 * speak the protocol. A client that acks is not "given longer", it is simply not dead.
 */
function lobbySocket(ticket) {
  const url = new URL(ticket.lobbySocketUrl); url.searchParams.set('ticket', ticket.lobbyTicket);
  const ws = new WebSocket(url); const frames = []; const waiters = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw)); frames.push(frame);
    if (frame.t === 'heartbeat') ws.send(JSON.stringify({ t: 'heartbeat.ack', correlationId: ulid(), d: {} }));
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(frame)) continue;
      clearTimeout(waiter.timer); waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame);
    }
  });
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const wait = (predicate, timeoutMs = 12_000) => new Promise((resolve, reject) => {
    const existing = frames.find(predicate); if (existing) { resolve(existing); return; }
    const waiter = { predicate, resolve, timer: setTimeout(() => {
      waiters.splice(waiters.indexOf(waiter), 1);
      reject(new Error(`lobby frame timeout: ${frames.map((frame) => frame.t).join(',')}`));
    }, timeoutMs) };
    waiters.push(waiter);
  });
  return { ws, opened, wait, send(t, d, correlationId = ulid()) {
    ws.send(JSON.stringify({ t, d, correlationId })); return correlationId;
  } };
}

function matchHandshake(ticket) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${matchPort}`); ws.binaryType = 'arraybuffer';
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('match handshake timeout')); }, 8_000);
    ws.once('open', () => ws.send(Buffer.from(encodeHello(PROTOCOL_VERSION, ticket))));
    ws.once('message', (raw) => {
      clearTimeout(timer);
      const bytes = raw instanceof ArrayBuffer ? raw
        : raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
      const welcome = decodeWelcome(bytes);
      if (welcome) ws.send(Buffer.from(encodeLoadout(0, 0)));
      resolve({ ws, welcome, rejection: decodeReject(bytes) });
    });
    ws.once('error', reject);
  });
}

/**
 * Hold the authority's SEAT deadlines still for the duration of `body`.
 *
 * Entering a match is the one step of this harness whose cost is set by the machine: two
 * Chromium contexts, a software GL stack, and an unbundled Vite module graph. On CI hardware
 * that outran the 60 s `connectBy` window, both seats were reaped mid-startup, and
 * `/v1/matches/:id/reconnect-ticket` correctly answered 409 RECONNECT_GRACE_EXPIRED — the
 * harness lost a race against a clock it had no say in.
 *
 * The answer is not a longer window (that just picks a number CI has to beat) but control:
 * freeze the seat clock while the clients start, release it afterwards. Nothing else is
 * suspended — ticket verification, the simulation, and the match timer all run for real —
 * and the reaper this suspends is asserted directly, on its own, by `bombbottest.mjs`.
 */
async function seatClockControl(body) {
  const response = await fetch(`http://127.0.0.1:${matchPort}/control/seat-clock`, {
    method: 'POST',
    headers: { authorization: `Bearer ${controlSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`seat-clock control refused: ${response.status}`);
  return response.json();
}
async function withSeatDeadlinesHeld(body) {
  const held = await seatClockControl({ hold: true });
  // A hold that silently did nothing would put this harness straight back on the wall clock
  // while looking green, so the authority has to say it took effect.
  if (held.held !== true) throw new Error(`seat clock did not hold: ${JSON.stringify(held)}`);
  try { return await body(); } finally { await seatClockControl({ hold: false }); }
}

async function startBrowserClients(users) {
  if (!browserLive) return null;
  const [{ createServer }, { chromium }] = await Promise.all([import('vite'), import('playwright')]);
  viteServer = await createServer({ root, configFile: false, logLevel: 'warn',
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null, proxy: {
      '/v1': { target: base, changeOrigin: false, ws: true },
      '/match': { target: `ws://127.0.0.1:${matchPort}`, changeOrigin: false, ws: true },
    } } });
  await viteServer.listen();
  const webBase = viteServer.resolvedUrls.local[0].replace(/\/$/, '');
  // Match authorities are separate origins in production. Exercise the platform-issued
  // address directly; routing binary match traffic through Vite would test a development
  // proxy that does not exist in the deployed topology.
  const matchUrl = `ws://127.0.0.1:${matchPort}`;
  browser = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });
  const rows = [];
  for (let index = 0; index < users.length; index++) {
    const context = await browser.newContext(); browserContexts.push(context);
    const page = await context.newPage();
    const errors = [];
    const requestUrls = [];
    page.on('request', (request) => requestUrls.push(request.url()));
    page.on('pageerror', (error) => errors.push(`page:${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`console:${message.text()}`); });
    page.on('requestfailed', (request) => errors.push(`request:${request.url()}:${request.failure()?.errorText}`));
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(`response:${response.status()}:${response.url()}`);
    });
    await page.goto(`${webBase}/welcome`, { waitUntil: 'domcontentloaded' });
    const signed = await page.evaluate(async ({ email, password, index }) => {
      const response = await fetch('/v1/auth/signin', { method: 'POST', headers: {
        'content-type': 'application/json', 'x-client-build': '1.0.0',
      }, body: JSON.stringify({ email, password }) });
      return { status: response.status, body: await response.json() };
    }, { email: users[index].email, password: users[index].password, index });
    if (signed.status !== 200) throw new Error(`browser sign-in failed: ${JSON.stringify(signed)}`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__OVERSTRIKE_SHELL__?.getState?.().session?.authenticated === true);
    // Initial signed-out restoration legitimately receives 401 and the authentication reload
    // aborts its unload-credential request. The shipping-session error gate begins only after
    // the authenticated shell has settled.
    await page.waitForTimeout(250);
    errors.length = 0;
    rows.push({ context, page, errors, requestUrls, token: signed.body.accessToken, webBase, matchUrl });
  }
  return rows;
}

async function browserEnter(row, handoff) {
  const safeHandoff = { ...handoff, serverUrl: row.matchUrl };
  await row.page.evaluate((ticket) => {
    window.__BROWSER_MATCH_SENDS__ = [];
    const original = WebSocket.prototype.send;
    WebSocket.prototype.send = function instrumentedMatchSend(data) {
      if (data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(data);
        const view = new DataView(data);
        const type = bytes[0] ?? null;
        const length = type === 5 && bytes.length >= 4 ? view.getUint8(3) : null;
        const encoded = length === null ? null : new TextDecoder().decode(bytes.slice(4, 4 + length));
        window.__BROWSER_MATCH_SENDS__.push({ type, bytes: bytes.length,
          ticketMatches: encoded === null ? null : encoded === ticket });
      }
      return original.call(this, data);
    };
  }, safeHandoff.sessionTicket);
  const entered = await row.page.evaluate((value) => window.__OVERSTRIKE_SHELL__.enterGame(value), safeHandoff);
  try {
    await row.page.waitForFunction(() => window.__GAME__?.netFacade?.state === 'live', null,
      { timeout: 30_000 });
  } catch (error) {
    const control = await fetch(`http://127.0.0.1:${matchPort}/control/status`, {
      headers: { authorization: `Bearer ${controlSecret}` },
    }).then((response) => response.json()).catch(() => null);
    const diagnostic = await row.page.evaluate(async () => ({
      entered: Boolean(window.__GAME__),
      facadeState: window.__GAME__?.netFacade?.state ?? null,
      shell: (() => {
        const state = window.__OVERSTRIKE_SHELL__?.getState?.() ?? null;
        return state ? { ...state, view: { ...state.view, error: state.view?.error ? {
          name: state.view.error.name, code: state.view.error.code,
          message: state.view.error.message, details: state.view.error.details,
        } : null } } : null;
      })(),
      gameLayerHidden: document.querySelector('#game-layer')?.hidden ?? null,
      runtimeCapability: (await import('/src/ui/shell/gameRuntime.js')).inspectRuntimeCapabilities({
        canvas: document.querySelector('#game-canvas'),
      }),
      sends: window.__BROWSER_MATCH_SENDS__ ?? [],
    }));
    throw new Error(`browser runtime failed to enter: ${JSON.stringify({
      entered: Boolean(entered), diagnostic, errors: row.errors,
      control: control ? { status: control.status, phase: control.phase,
        seats: control.seats?.map((seat) => ({ connected: seat.connected,
          released: seat.released, graceEndsAt: seat.graceEndsAt })) } : null,
    })}`, { cause: error });
  }
}

async function browserLobby(row, roomId) {
  return row.page.evaluate(async ({ roomId, token, webBase }) => {
    const response = await fetch(`/v1/rooms/${roomId}/reconnect-ticket`, { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-client-build': '1.0.0',
    }, body: '{}' });
    const ticket = await response.json();
    if (!response.ok) throw new Error(`lobby reconnect ${response.status}`);
    const socketUrl = new URL(ticket.lobbySocketUrl);
    socketUrl.protocol = webBase.startsWith('https:') ? 'wss:' : 'ws:';
    socketUrl.host = new URL(webBase).host;
    const frames = []; const waiters = [];
    const ws = new WebSocket(socketUrl, ['overstrike-lobby-v1', `overstrike-ticket.${ticket.lobbyTicket}`]);
    ws.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data); frames.push(frame);
      // Same reason as `lobbySocket`: a client that never acks is reaped in 30 s.
      if (frame.t === 'heartbeat') {
        ws.send(JSON.stringify({ t: 'heartbeat.ack', correlationId: frame.correlationId, d: {} }));
      }
      for (const waiter of [...waiters]) if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame);
      }
    });
    const wait = (predicate) => new Promise((resolve, reject) => {
      const found = frames.find(predicate); if (found) return resolve(found);
      const waiter = { predicate, resolve }; waiters.push(waiter);
      setTimeout(() => { const at = waiters.indexOf(waiter); if (at >= 0) waiters.splice(at, 1);
        reject(new Error(`lobby timeout ${frames.map((f) => f.t)}`)); }, 12000);
    });
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true }); });
    await wait((frame) => frame.t === 'lobby.welcome');
    window.__BROWSER_LIVE_LOBBY__ = { ws, frames, wait,
      send(t, d, correlationId) { ws.send(JSON.stringify({ t, d, correlationId })); } };
    return { url: socketUrl.toString(), protocols: ws.protocol };
  }, { roomId, token: row.token, webBase: row.webBase });
}

async function browserIntent(row, t, d, correlationId) {
  return row.page.evaluate(({ t, d, correlationId }) => {
    const lobby = window.__BROWSER_LIVE_LOBBY__;
    lobby.send(t, d, correlationId);
    return lobby.wait((frame) => frame.correlationId === correlationId
      && (frame.t === 'ready.changed' || frame.t === 'countdown.started' || frame.t === 'match.ready'));
  }, { t, d, correlationId });
}

const clients = [];
const matchSockets = [];
let viteServer = null;
let browser = null;
const browserContexts = [];
try {
  console.log('\n--- real server normal completion and rematch ---');
  const users = await Promise.all([onboard(1), onboard(2)]);
  // Real players have already loaded and authenticated the shell before an owner launches.
  // Preparing Chromium after allocation would spend the authoritative match clock installing
  // a test browser rather than exercising player behavior.
  const browserRows = await startBrowserClients(users);
  const created = await call('POST', '/v1/rooms', {
    name: 'Finish and Rematch', region: 'iad', mapId: 'the-square', mode: 'tdm', capacity: 2,
    settings: { requiredReady: 2, minPlayers: 2, killLimit: 75 },
  }, users[0].token, { 'idempotency-key': `completion-room:${ulid()}` });
  const owner = lobbySocket(created.body); clients.push(owner); await owner.opened;
  await owner.wait((frame) => frame.t === 'lobby.welcome');
  const joined = await call('POST', `/v1/rooms/${created.body.room.roomId}/join`, {}, users[1].token,
    { 'idempotency-key': `completion-join:${ulid()}` });
  const peer = lobbySocket(joined.body); clients.push(peer); await peer.opened;
  await peer.wait((frame) => frame.t === 'lobby.welcome');

  async function launch() {
    for (const client of clients) {
      const correlationId = client.send('ready.set', { ready: true });
      await client.wait((frame) => frame.t === 'ready.changed'
        && frame.correlationId === correlationId && frame.d.ready);
    }
    const correlationId = owner.send('launch.request', {});
    await owner.wait((frame) => frame.t === 'countdown.started' && frame.correlationId === correlationId);
    return Promise.all(clients.map((client) => client.wait((frame) => frame.t === 'match.ready'
      && frame.correlationId === correlationId, 12_000)));
  }

  // Allocation through entry is one span: `connectBy` starts ticking the moment the authority
  // is allocated, and everything up to the last client entering has to fit inside it.
  const firstHandoffs = await withSeatDeadlinesHeld(async () => {
    const handoffs = await launch();
    if (!browserLive) {
      for (const handoff of handoffs) {
        const admitted = await matchHandshake(handoff.d.sessionTicket); matchSockets.push(admitted.ws);
        check(admitted.welcome?.mode === 'tdm' && !admitted.rejection,
          'platform-minted ticket admits its signed roster seat');
      }
    }
    if (browserRows) {
      await Promise.all(browserRows.map((row, index) => browserEnter(row, handoffs[index].d)));
    }
    return handoffs;
  });
  const firstMatchId = firstHandoffs[0].d.matchId;
  check(firstHandoffs.every((frame) => frame.d.matchId === firstMatchId && frame.d.mode === 'tdm'),
    'actual platform allocation hands both seats to one TDM authority');

  if (browserRows) {
    check(browserRows.every((row) => row.page.url().startsWith(row.webBase)
      && row.errors.length === 0),
    'two platform-minted tickets admit isolated production browser runtimes without client errors');
    check(browserRows.every((row) => row.page.url().startsWith(row.webBase)),
      'both Chromium clients enter the live game while remaining on the production Vite origin');
    const reconnected = await browserRows[0].page.evaluate(() => new Promise((resolve) => {
      const facade = window.__GAME__.netFacade;
      let dropped = false;
      const timer = setTimeout(() => { off(); resolve(false); }, 15_000);
      const off = facade.on('stateChange', ({ to }) => {
        if (to === 'reconnecting') dropped = true;
        if (dropped && to === 'live') { clearTimeout(timer); off(); resolve(true); }
        if (dropped && ['closed', 'rejected', 'version-mismatch'].includes(to)) {
          clearTimeout(timer); off(); resolve(false);
        }
      });
      facade._session.transport.ws.close();
    }));
    check(reconnected, 'browser facade reconnects with a fresh authenticated platform ticket');
  }

  let status = null;
  for (let tries = 0; tries < (browserLive ? 450 : 150); tries++) {
    const response = await fetch(`http://127.0.0.1:${matchPort}/control/status`, {
      headers: { authorization: `Bearer ${controlSecret}` },
    });
    status = await response.json();
    if (status.status === 'ended') break;
    await sleep(100);
  }
  check(status?.status === 'ended' && status?.result?.status === 'completed',
    'the spawned authoritative Game reaches a real matchEnd', JSON.stringify(status));
  const logRecords = gameLog.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  });
  const terminalLog = logRecords.find((entry) => entry?.event === 'match.awaiting_release');
  check(logRecords.length > 0 && logRecords.every(Boolean)
    && ['alpha', 'bravo', 'draw'].includes(terminalLog?.outcome)
    && !('result' in (terminalLog || {})) && !('evidence' in (terminalLog || {}))
    && !gameLog.includes(matchSecret) && !gameLog.includes(controlSecret)
    && !users.some((user) => gameLog.includes(user.accountId))
    && !firstHandoffs.some((frame) => gameLog.includes(frame.d.sessionTicket))
    && !gameLog.includes('@example.invalid') && !gameLog.includes('127.0.0.1')
    && !gameLog.includes('::1'),
  'game-server terminal logs are structured and omit result bodies, evidence, identities, tickets, secrets, and raw network addresses',
  gameLog.slice(-1500));
  const terminal = status?.result;
  const { evidence, evidenceRef, ...terminalCore } = terminal || {};
  check(evidence && evidenceDigest(evidence) === evidenceRef?.slice('sha256:'.length)
    && evidenceDigest(reconstructEvidenceResult({ ...evidence, result: undefined }))
      === evidenceDigest(terminalCore),
  'matchEnd publishes stable evidence that independently reconstructs the exact result');

  await app.deps.lobby.sweep();
  const stored = await app.deps.store.matches.byId(firstMatchId);
  const retained = await app.deps.store.matchEvidence.byMatchId(firstMatchId);
  check(stored?.status === 'completed' && stored?.resultAppliedAt
    && retained?.evidenceRef === stored.evidenceRef && !app.deps.lobby.matches.has(firstMatchId)
    && app.deps.lobby.rooms.get(created.body.room.roomId)?.status === 'open',
  'platform atomically applies result/evidence, releases authority, and reopens the room');

  if (browserRows) {
    await Promise.all(browserRows.map((row) => row.page.waitForFunction(() =>
      !window.__GAME__ && window.__OVERSTRIKE_SHELL__?.getState?.().runtimeLoaded === false,
    null, { timeout: 8_000 })));
    check(await Promise.all(browserRows.map((row) => row.page.evaluate(() =>
      !window.__GAME__ && document.querySelector('#shell-root')?.hidden === false)))
      .then((values) => values.every(Boolean)),
    'authoritative matchEnded returns both production runtimes to the shell exactly once');
  }

  let secondHandoffs;
  if (browserRows) {
    for (const client of clients) client.ws.close();
    await sleep(150);
    const lobbyConnections = await Promise.all(browserRows.map((row) =>
      browserLobby(row, created.body.room.roomId)));
    check(lobbyConnections.every((entry) => !new URL(entry.url).searchParams.has('ticket')
      && entry.protocols === 'overstrike-lobby-v1'),
    'browser lobby transport authenticates without placing its ticket in the URL',
    JSON.stringify(lobbyConnections));
    for (let index = 0; index < browserRows.length; index++) {
      const correlationId = ulid();
      await browserIntent(browserRows[index], 'ready.set', { ready: true }, correlationId);
    }
  }
  // The rematch is the same race a second time: a fresh allocation, and two runtimes that
  // have to be back in it before the new `connectBy` window closes.
  secondHandoffs = await withSeatDeadlinesHeld(async () => {
    if (!browserRows) return launch();
    const launchCorrelation = ulid();
    await browserIntent(browserRows[0], 'launch.request', {}, launchCorrelation);
    const handoffs = await Promise.all(browserRows.map((row) => row.page.evaluate((correlationId) =>
      window.__BROWSER_LIVE_LOBBY__.wait((frame) => frame.t === 'match.ready'
        && frame.correlationId === correlationId), launchCorrelation)));
    await Promise.all(browserRows.map((row, index) => browserEnter(row, handoffs[index].d)));
    return handoffs;
  });
  const secondMatchId = secondHandoffs[0].d.matchId;
  check(secondMatchId !== firstMatchId && secondHandoffs.every((frame) => frame.d.matchId === secondMatchId),
    'the reopened room allocates a distinct rematch on the released server');
  if (browserRows) {
    check(await Promise.all(browserRows.map((row) => row.page.evaluate(() =>
      window.__GAME__?.netFacade?.state === 'live'))).then((values) => values.every(Boolean)),
    'both Chromium contexts enter the distinct rematch through the production facade');
    for (const row of browserRows) {
      const secretInUrl = [row.token, ...firstHandoffs.map((frame) => frame.d.sessionTicket)]
        .some((secret) => row.page.url().includes(secret));
      const storage = await row.page.evaluate(() => JSON.stringify({
        local: { ...localStorage }, session: { ...sessionStorage }, url: location.href,
      }));
      check(!secretInUrl && !storage.includes(row.token)
        && !firstHandoffs.some((frame) => storage.includes(frame.d.sessionTicket))
        && !secondHandoffs.some((frame) => storage.includes(frame.d.sessionTicket))
        && row.errors.length === 0,
      'browser URLs/storage/console/request failures contain no bearer or match ticket',
      JSON.stringify({ storage, errors: row.errors }));
    }
  } else {
    for (const handoff of secondHandoffs) {
      const admitted = await matchHandshake(handoff.d.sessionTicket); matchSockets.push(admitted.ws);
      check(admitted.welcome?.mode === 'tdm' && !admitted.rejection,
        'both preserved lobby seats enter the real rematch',
        JSON.stringify({ welcome: admitted.welcome, rejection: admitted.rejection, log: gameLog.slice(-1200) }));
    }
  }
} finally {
  for (const ws of matchSockets) { try { ws.close(); } catch {} }
  for (const client of clients) { try { client.ws.close(); } catch {} }
  for (const context of browserContexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await viteServer?.close().catch(() => {});
  app.stop(); app.server.closeAllConnections?.();
  await new Promise((resolve) => app.server.close(resolve));
  await app.deps.store.close();
  if (gameServer.exitCode === null && gameServer.signalCode === null) gameServer.kill('SIGTERM');
  await new Promise((resolve) => {
    if (gameServer.exitCode !== null || gameServer.signalCode !== null) resolve();
    else gameServer.once('exit', resolve);
  });
}

console.log(`\ncompletion acceptance: ${failed ? 'FAIL' : 'PASS'} — ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
