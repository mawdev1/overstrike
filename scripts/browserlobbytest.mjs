/**
 * REQ-CC-066: a real Chromium exercises the shipped shell -> lobby adapter -> controller.
 *
 * This intentionally does not build a parallel WebSocket client in the page. Room discovery,
 * joining, cold restoration, chat rendering, and the successful report all travel through
 * src/main.js and the same shell surfaces shipped to players.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { WebSocket } from 'ws';
import { buildApp } from '../platform/src/app.js';
import { loadConfig } from '../platform/src/core/config.js';
import { ulid } from '../platform/src/core/ids.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}
let passed = 0;
let failed = 0;
function check(condition, label, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.error(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
}
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const logger = (() => {
  const noop = () => {};
  const value = { debug: noop, info: noop, warn: noop, error: noop };
  value.child = () => value;
  return value;
})();

const platformPort = await freePort();
const config = loadConfig({ ...process.env, NODE_ENV: 'test', PLATFORM_PORT: String(platformPort),
  PLATFORM_STORAGE: 'memory', PLATFORM_TRUSTED_PROXY_HOPS: '1',
  PLATFORM_FLAG_OVERRIDES: 'shell.serverbrowser.enabled=true,mode.tdm.enabled=true,map.the_square.enabled=true,reports.enabled=true' });
const app = await buildApp(config, { logger });
await new Promise((resolve) => app.server.listen(platformPort, '127.0.0.1', resolve));
const platformBase = `http://127.0.0.1:${platformPort}`;

async function call(method, path, body, token = null, extras = {}) {
  const headers = { 'content-type': 'application/json', 'x-client-build': '1.0.0', ...extras };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(platformBase + path, { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

let accountOrdinal = 0;
async function onboard(label) {
  const index = ++accountOrdinal;
  const forwarded = { 'x-forwarded-for': `198.51.100.${20 + index}` };
  const clientSessionId = ulid(Date.now() + index);
  const eligibility = await call('POST', '/v1/onboarding/eligibility',
    { dateOfBirth: '1990-01-01', jurisdiction: 'CA-ON' }, null, forwarded);
  const consent = await call('PUT', '/v1/onboarding/consent',
    { telemetryPersonal: false, policyVersion: 1, clientSessionId }, null, forwarded);
  const email = `browser-lobby-${label}-${Date.now()}-${index}@example.invalid`;
  const password = 'correct horse battery staple';
  const signup = await call('POST', '/v1/auth/signup', {
    email, password, displayName: `${label}${index}X`, clientSessionId,
    eligibilityReceipt: eligibility.body.receipt, consentReceipt: consent.body.receipt,
  }, null, forwarded);
  if (signup.status !== 201) throw new Error(`onboard ${label}: ${JSON.stringify(signup.body)}`);
  // Mail delivery is deliberately disabled in this hermetic run. Advance the fixture account
  // through the two server-owned gates that normally require an external mailbox, then save
  // the real default settings projection through its versioned HTTP endpoint.
  const completedAt = new Date().toISOString();
  await app.deps.store.accounts.update(signup.body.profile.accountId, {
    emailVerifiedAt: completedAt, termsVersionAccepted: config.termsVersion,
    termsAcceptedAt: completedAt,
  });
  const currentSettings = await fetch(`${platformBase}/v1/profile/me/settings`, { headers: {
    authorization: `Bearer ${signup.body.accessToken}`, 'x-client-build': '1.0.0',
  } });
  const settingsBody = await currentSettings.json();
  const savedSettings = await fetch(`${platformBase}/v1/profile/me/settings`, { method: 'PUT', headers: {
    authorization: `Bearer ${signup.body.accessToken}`, 'content-type': 'application/json',
    'x-client-build': '1.0.0', 'if-match': currentSettings.headers.get('etag'),
  }, body: JSON.stringify({ schemaVersion: settingsBody.schemaVersion, values: settingsBody.values }) });
  if (savedSettings.status !== 200) throw new Error(`complete settings ${label}: ${await savedSettings.text()}`);
  return { email, password, accessToken: signup.body.accessToken,
    accountId: signup.body.profile.accountId };
}

function lobbyConnection(reservation) {
  const frames = [];
  const waiters = [];
  const socket = new WebSocket(reservation.lobbySocketUrl,
    ['overstrike-lobby-v1', `overstrike-ticket.${reservation.lobbyTicket}`]);
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw));
    frames.push(frame);
    if (frame.t === 'heartbeat') {
      socket.send(JSON.stringify({ t: 'heartbeat.ack', d: {}, correlationId: ulid() }));
    }
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(frame)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  });
  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const wait = (predicate, timeoutMs = 12_000) => new Promise((resolve, reject) => {
    const found = frames.find(predicate);
    if (found) { resolve(found); return; }
    const waiter = { predicate, resolve, timer: setTimeout(() => {
      waiters.splice(waiters.indexOf(waiter), 1);
      reject(new Error(`lobby timeout: ${frames.map((frame) => frame.t).join(',')}`));
    }, timeoutMs) };
    waiters.push(waiter);
  });
  return { socket, opened, wait, send(t, d) {
    const correlationId = ulid();
    socket.send(JSON.stringify({ t, d, correlationId }));
    return correlationId;
  } };
}

function observePage(page) {
  const observation = {
    console: [], pageErrors: [], requestFailures: [], requests: [], responses: [],
    sockets: [], lobbyTickets: [], reportBodies: [], publicProfiles: [],
  };
  page.on('console', (message) => observation.console.push({ type: message.type(), text: message.text() }));
  page.on('pageerror', (error) => observation.pageErrors.push(error.message));
  page.on('requestfailed', (request) => observation.requestFailures.push({
    method: request.method(), url: request.url(), error: request.failure()?.errorText || 'unknown',
  }));
  page.on('request', (request) => {
    observation.requests.push({ method: request.method(), url: request.url() });
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/v1/reports') {
      try { observation.reportBodies.push(JSON.parse(request.postData() || '{}')); } catch { /* asserted below */ }
    }
  });
  page.on('response', (response) => {
    observation.responses.push({ status: response.status(), url: response.url() });
    const path = new URL(response.url()).pathname;
    if (response.request().method() === 'GET' && /^\/v1\/profile\/[^/]+$/.test(path)) {
      void response.json().then((body) => observation.publicProfiles.push({ path, body })).catch(() => {});
    }
    if (response.request().method() === 'POST'
      && (/\/v1\/rooms\/[^/]+\/(join|reconnect-ticket)$/.test(path))) {
      void response.json().then((body) => {
        if (typeof body?.lobbyTicket === 'string') observation.lobbyTickets.push(body.lobbyTicket);
      }).catch(() => {});
    }
  });
  page.on('websocket', (socket) => {
    const row = { url: socket.url(), received: [], sent: [] };
    observation.sockets.push(row);
    socket.on('framereceived', ({ payload }) => {
      try { row.received.push(JSON.parse(String(payload))); } catch { row.received.push({ binary: true }); }
    });
    socket.on('framesent', ({ payload }) => {
      try { row.sent.push(JSON.parse(String(payload))); } catch { row.sent.push({ binary: true }); }
    });
  });
  return observation;
}

async function signInShell(page, webBase, user) {
  await page.goto(`${webBase}/welcome`, { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async ({ email, password }) => {
    const response = await fetch('/v1/auth/signin', { method: 'POST', headers: {
      'content-type': 'application/json', 'x-client-build': '1.0.0',
    }, body: JSON.stringify({ email, password }) });
    return { status: response.status, body: await response.json() };
  }, user);
  if (result.status !== 200) throw new Error(`browser sign-in: ${JSON.stringify(result)}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__OVERSTRIKE_SHELL__?.getState?.().session?.authenticated === true);
  // SessionState flips authenticated as soon as refresh succeeds; profile/self-presence,
  // active-match discovery, and unload-credential priming finish afterwards. Wait for those
  // shipping boot requests instead of navigating a live document out from under them.
  await page.waitForLoadState('networkidle');
  return result.body.accessToken;
}

const browserConnections = [];
let viteServer = null;
let browser = null;
const contexts = [];
try {
  console.log('\n--- real Chromium lobby shell acceptance ---');
  const [subjectA, reporter, subjectB, outsider] = await Promise.all([
    onboard('SubjectA'), onboard('Reporter'), onboard('SubjectB'), onboard('Outsider'),
  ]);

  const createRoom = async (owner, name) => {
    const response = await call('POST', '/v1/rooms', {
      name, region: 'iad', mapId: 'the-square', mode: 'tdm', capacity: 4,
      settings: { requiredReady: 2, minPlayers: 2, killLimit: 75 },
    }, owner.accessToken, { 'idempotency-key': `browser-lobby-room:${ulid()}` });
    if (response.status !== 201) throw new Error(`create room: ${JSON.stringify(response.body)}`);
    const connection = lobbyConnection(response.body);
    browserConnections.push(connection);
    await connection.opened;
    await connection.wait((frame) => frame.t === 'lobby.welcome');
    return { response: response.body, connection };
  };
  const roomA = await createRoom(subjectA, 'Chromium Alpha');
  const roomB = await createRoom(subjectB, 'Chromium Bravo');

  const [{ createServer }, { chromium }] = await Promise.all([import('vite'), import('playwright')]);
  viteServer = await createServer({ root, configFile: false, logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null,
      proxy: { '/v1': { target: platformBase, changeOrigin: false, ws: true } } } });
  await viteServer.listen();
  const webBase = viteServer.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'] });

  const reporterContext = await browser.newContext(); contexts.push(reporterContext);
  const reporterPage = await reporterContext.newPage();
  const reporterObs = observePage(reporterPage);
  const reporterToken = await signInShell(reporterPage, webBase, reporter);
  await reporterPage.waitForTimeout(200);
  // Ignore the expected signed-out refresh 401 and navigation-aborted unload request. From
  // here forward the authenticated production shell must be clean.
  reporterObs.console.length = 0;
  reporterObs.pageErrors.length = 0;
  reporterObs.requestFailures.length = 0;
  reporterObs.requests.length = 0;
  reporterObs.responses.length = 0;
  reporterObs.sockets.length = 0;
  reporterObs.lobbyTickets.length = 0;
  reporterObs.publicProfiles.length = 0;

  await reporterPage.goto(`${webBase}/play/rooms/${roomA.response.room.roomId}`,
    { waitUntil: 'domcontentloaded' });
  try {
    await reporterPage.waitForFunction(() => {
      const button = document.querySelector('button[data-operation="join"]');
      return document.querySelector('#shell-root')?.dataset.route === 'play.roomDetail'
        && button && !button.disabled;
    }, null, { timeout: 8_000 });
  } catch (error) {
    const diagnostic = await reporterPage.evaluate(async ({ roomId, accountId, token }) => {
      const raw = await fetch(`/v1/rooms/${roomId}`, { headers: {
        authorization: `Bearer ${token}`, 'x-client-build': '1.0.0',
      } });
      const own = await fetch('/v1/profile/me', { headers: {
        authorization: `Bearer ${token}`, 'x-client-build': '1.0.0',
      } });
      const publicSelf = await fetch(`/v1/profile/${accountId}`, { headers: {
        authorization: `Bearer ${token}`, 'x-client-build': '1.0.0',
      } });
      const consent = await fetch('/v1/onboarding/consent', { headers: {
        authorization: `Bearer ${token}`, 'x-client-build': '1.0.0',
      } });
      const settings = await fetch('/v1/profile/me/settings', { headers: {
        authorization: `Bearer ${token}`, 'x-client-build': '1.0.0',
      } });
      return {
        root: { ...document.querySelector('#shell-root')?.dataset },
        state: window.__OVERSTRIKE_SHELL__?.getState?.(),
        text: document.querySelector('#shell-root')?.innerText?.slice(0, 1200),
        raw: { status: raw.status, body: await raw.json() },
        own: { status: own.status, body: await own.json() },
        publicSelf: { status: publicSelf.status, body: await publicSelf.json() },
        consent: { status: consent.status, body: await consent.json() },
        settings: { status: settings.status, body: await settings.json() },
      };
    }, { roomId: roomA.response.room.roomId, accountId: reporter.accountId, token: reporterToken });
    throw new Error(`room detail did not become joinable: ${JSON.stringify(diagnostic)}`, { cause: error });
  }
  await reporterPage.locator('button[data-operation="join"]').click();
  await reporterPage.waitForFunction((roomId) => {
    const shell = window.__OVERSTRIKE_SHELL__;
    const state = shell?.getState?.();
    return state?.route?.id === 'room.home' && state.route.params.roomId === roomId
      && state.view?.data?.status === 'synchronized'
      && state.view.data.you?.accountId;
  }, roomA.response.room.roomId);
  await reporterPage.waitForTimeout(100);
  const initialSocket = reporterObs.sockets.at(-1);
  check(reporterObs.requests.some((row) => row.method === 'POST'
    && new URL(row.url).pathname === `/v1/rooms/${roomA.response.room.roomId}/join`)
    && initialSocket?.received?.[0]?.t === 'lobby.welcome',
  'shipping room-detail action joins and synchronizes from lobby.welcome',
  JSON.stringify({ requests: reporterObs.requests, frames: initialSocket?.received }));
  check(initialSocket && !new URL(initialSocket.url).searchParams.has('ticket'),
    'shipping lobby controller keeps the one-use ticket out of its WebSocket URL', initialSocket?.url);

  const messageAId = roomA.connection.send('chat.send', { text: 'evidence from alpha' });
  const messageA = await roomA.connection.wait((frame) => frame.t === 'chat.message'
    && frame.correlationId === messageAId);
  const messageBId = roomB.connection.send('chat.send', { text: 'evidence from bravo' });
  const messageB = await roomB.connection.wait((frame) => frame.t === 'chat.message'
    && frame.correlationId === messageBId);
  await reporterPage.waitForFunction((messageId) => window.__OVERSTRIKE_SHELL__?.getState?.()
    .view?.data?.chatHistory?.some((message) => message.id === messageId), messageA.d.id);

  await reporterPage.waitForLoadState('networkidle');
  await eventually(() => {
    const paths = new Set(reporterObs.responses.map((row) => new URL(row.url).pathname));
    return paths.has('/v1/telemetry/unload/credential') && paths.has('/v1/matches/active');
  }, 'pre-reload shell bootstrap responses');
  reporterObs.requestFailures.length = 0;
  reporterObs.sockets.length = 0;
  const reconnectRequestStart = reporterObs.requests.length;
  const publicProfileStart = reporterObs.publicProfiles.length;
  const coldResponseStart = reporterObs.responses.length;
  await reporterPage.reload({ waitUntil: 'domcontentloaded' });
  await reporterPage.waitForFunction((roomId) => {
    const state = window.__OVERSTRIKE_SHELL__?.getState?.();
    return state?.session?.authenticated === true && state?.route?.params?.roomId === roomId
      && state.view?.data?.status === 'synchronized';
  }, roomA.response.room.roomId);
  await reporterPage.waitForLoadState('networkidle');
  await eventually(() => {
    const cold = reporterObs.responses.slice(coldResponseStart);
    const paths = new Set(cold.map((row) => new URL(row.url).pathname));
    return paths.has('/v1/telemetry/unload/credential') && paths.has('/v1/matches/active');
  }, 'cold shell bootstrap responses');
  await reporterPage.waitForTimeout(100);
  const coldRequests = reporterObs.requests.slice(reconnectRequestStart);
  const coldSocket = reporterObs.sockets.at(-1);
  const coldPublicSelf = reporterObs.publicProfiles.slice(publicProfileStart)
    .find((row) => row.path === `/v1/profile/${reporter.accountId}`);
  check(coldRequests.some((row) => row.method === 'GET'
    && new URL(row.url).pathname === `/v1/profile/${reporter.accountId}`)
    && coldPublicSelf?.body?.presence?.state === 'in-lobby'
    && coldPublicSelf.body.presence.roomId === roomA.response.room.roomId,
  'cold shell discovers its active room from the privacy-filtered public-self presence projection',
  JSON.stringify({ requests: coldRequests, projection: coldPublicSelf }));
  check(coldRequests.some((row) => row.method === 'POST'
    && new URL(row.url).pathname === `/v1/rooms/${roomA.response.room.roomId}/reconnect-ticket`)
    && ['lobby.welcome', 'state.snapshot'].includes(coldSocket?.received?.[0]?.t),
  'page reload performs cold room discovery with a reconnect ticket and authoritative snapshot',
  JSON.stringify({ requests: coldRequests, frames: coldSocket?.received }));

  await reporterPage.evaluate((roomId) => window.__OVERSTRIKE_SHELL__.navigate(`/room/${roomId}/chat`),
    roomA.response.room.roomId);
  await reporterPage.waitForFunction((messageId) => document.querySelector(`li[data-message-id="${messageId}"]`),
    messageA.d.id);
  const messageRow = reporterPage.locator(`li[data-message-id="${messageA.d.id}"]`);
  await messageRow.locator('summary').click();
  await messageRow.locator('button[data-operation="report"]').click();
  const dialog = reporterPage.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Submit report', exact: true }).click();
  await reporterPage.waitForFunction((messageId) => {
    const row = document.querySelector(`li[data-message-id="${messageId}"]`);
    return row?.textContent?.includes('Report submitted:');
  }, messageA.d.id);
  await reporterPage.waitForTimeout(100);
  const uiReportBody = reporterObs.reportBodies.at(-1);
  check(uiReportBody?.subjectAccountId === subjectA.accountId
    && uiReportBody?.chatMessageId === messageA.d.id
    && uiReportBody?.category === 'cheating',
  'shipping chat report succeeds with the authoritative message evidence id',
  JSON.stringify(uiReportBody));

  check(reporterObs.pageErrors.length === 0
    && reporterObs.console.filter((row) => row.type === 'error').length === 0
    && reporterObs.requestFailures.length === 0,
  'join and cold reload settle every shell bootstrap request without console, page, or transport errors',
  JSON.stringify({ console: reporterObs.console, pageErrors: reporterObs.pageErrors,
    requestFailures: reporterObs.requestFailures }));
  reporterObs.console.length = 0;
  reporterObs.pageErrors.length = 0;
  reporterObs.requestFailures.length = 0;

  const crossRoom = await reporterPage.evaluate(async ({ token, subjectAccountId, chatMessageId }) => {
    const response = await fetch('/v1/reports', { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-client-build': '1.0.0',
    }, body: JSON.stringify({ subjectAccountId, category: 'harassment', chatMessageId }) });
    return { status: response.status, body: await response.json() };
  }, { token: reporterToken, subjectAccountId: subjectB.accountId, chatMessageId: messageB.d.id });
  check(crossRoom.status === 404 && crossRoom.body?.error?.code === 'NOT_FOUND',
    'a member cannot report/enumerate chat evidence from another room', JSON.stringify(crossRoom));
  await reporterPage.waitForTimeout(50);
  const crossRoomResponses = reporterObs.responses.filter((row) => row.status >= 400);
  const crossConsoleErrors = reporterObs.console.filter((row) => row.type === 'error');
  check(crossRoomResponses.length === 1 && crossRoomResponses[0].status === 404
    && new URL(crossRoomResponses[0].url).pathname === '/v1/reports'
    && crossConsoleErrors.length === 1 && crossConsoleErrors[0].text.includes('status of 404')
    && reporterObs.pageErrors.length === 0 && reporterObs.requestFailures.length === 0,
  'the cross-room refusal produces only its expected reports 404, with no transport/page failure',
  JSON.stringify({ responses: crossRoomResponses, console: reporterObs.console }));
  reporterObs.console.length = 0;
  reporterObs.responses.length = 0;

  const outsiderContext = await browser.newContext(); contexts.push(outsiderContext);
  const outsiderPage = await outsiderContext.newPage();
  const outsiderObs = observePage(outsiderPage);
  const outsiderToken = await signInShell(outsiderPage, webBase, outsider);
  await outsiderPage.waitForTimeout(200);
  outsiderObs.console.length = 0;
  outsiderObs.pageErrors.length = 0;
  outsiderObs.requestFailures.length = 0;
  outsiderObs.requests.length = 0;
  outsiderObs.responses.length = 0;
  const nonmember = await outsiderPage.evaluate(async ({ token, subjectAccountId, chatMessageId }) => {
    const response = await fetch('/v1/reports', { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-client-build': '1.0.0',
    }, body: JSON.stringify({ subjectAccountId, category: 'other', chatMessageId }) });
    return { status: response.status, body: await response.json() };
  }, { token: outsiderToken, subjectAccountId: subjectA.accountId, chatMessageId: messageA.d.id });
  check(nonmember.status === 404 && nonmember.body?.error?.code === 'NOT_FOUND',
    'a nonmember cannot report/enumerate a room chat evidence id', JSON.stringify(nonmember));
  await outsiderPage.waitForTimeout(50);
  const nonmemberResponses = outsiderObs.responses.filter((row) => row.status >= 400);
  const nonmemberConsoleErrors = outsiderObs.console.filter((row) => row.type === 'error');
  check(nonmemberResponses.length === 1 && nonmemberResponses[0].status === 404
    && new URL(nonmemberResponses[0].url).pathname === '/v1/reports'
    && nonmemberConsoleErrors.length === 1 && nonmemberConsoleErrors[0].text.includes('status of 404')
    && outsiderObs.pageErrors.length === 0 && outsiderObs.requestFailures.length === 0,
  'the nonmember refusal produces only its expected reports 404, with no transport/page failure',
  JSON.stringify({ responses: nonmemberResponses, console: outsiderObs.console }));
  outsiderObs.console.length = 0;
  outsiderObs.responses.length = 0;

  await sleep(100);
  const storage = await Promise.all([reporterPage, outsiderPage].map((page) => page.evaluate(() => ({
    url: location.href,
    localStorage: Object.fromEntries(Object.entries(localStorage)),
    sessionStorage: Object.fromEntries(Object.entries(sessionStorage)),
  }))));
  const secrets = [reporterToken, outsiderToken, ...reporterObs.lobbyTickets].filter(Boolean);
  const publicLogs = JSON.stringify({
    reporter: { console: reporterObs.console, pageErrors: reporterObs.pageErrors,
      requestFailures: reporterObs.requestFailures, requests: reporterObs.requests,
      responses: reporterObs.responses },
    outsider: { console: outsiderObs.console, pageErrors: outsiderObs.pageErrors,
      requestFailures: outsiderObs.requestFailures, requests: outsiderObs.requests,
      responses: outsiderObs.responses },
  });
  const persisted = JSON.stringify(storage);
  check(reporterObs.lobbyTickets.length >= 2
    && secrets.every((secret) => !persisted.includes(secret) && !publicLogs.includes(secret))
    && secrets.every((secret) => !reporterPage.url().includes(secret) && !outsiderPage.url().includes(secret))
    && reporterObs.sockets.every((row) => !new URL(row.url).searchParams.has('ticket')),
  'access and lobby tickets never enter URL, localStorage, sessionStorage, console, or request logs',
  JSON.stringify({ lobbyTicketCount: reporterObs.lobbyTickets.length, storage, publicLogs }));
  const consoleErrors = [...reporterObs.console, ...outsiderObs.console]
    .filter((row) => row.type === 'error');
  check(consoleErrors.length === 0 && reporterObs.pageErrors.length === 0
    && outsiderObs.pageErrors.length === 0 && reporterObs.requestFailures.length === 0
    && outsiderObs.requestFailures.length === 0,
  'authenticated shell run has no console, page, or request-failure errors',
  JSON.stringify({ consoleErrors, reporter: reporterObs.requestFailures,
    outsider: outsiderObs.requestFailures, pageErrors: [...reporterObs.pageErrors, ...outsiderObs.pageErrors] }));
} finally {
  for (const connection of browserConnections) {
    try { connection.socket.close(); } catch { /* best-effort cleanup */ }
  }
  for (const context of contexts) await context.close().catch(() => {});
  await browser?.close().catch(() => {});
  await viteServer?.close().catch(() => {});
  app.stop();
  app.server.closeAllConnections?.();
  await new Promise((resolve) => app.server.close(resolve));
  await app.deps.store.close();
}

console.log(`\nbrowser lobby acceptance: ${failed ? 'FAIL' : 'PASS'} — ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
