/**
 * PLAYTEST — N real browsers, one real match, played to a real finish.
 *
 *   node scripts/playtest.mjs [--players=4] [--mode=bomb|tdm] [--map=the-square|meridian]
 *                             [--seconds=N] [--killlimit=N] [--bots=N] [--logs=DIR] [--headed]
 *
 * This is the playtest a single human cannot run: `--players` separate authenticated
 * accounts, each in its own Chromium browser context, each driving the REAL production
 * shell — sign-in form, room-create form, join button, GREEN UP, Launch, Enter match — into
 * one real dedicated server allocated by the real platform, then playing with real key and
 * mouse events until the match ends on its own.
 *
 * It exists to find bugs, so it never papers over one. Every verification is reported, the
 * logs of every process and every page are saved, and a run that does not finish a match,
 * or does not land career stats, or has its evidence refused, exits non-zero and says so.
 *
 * What is real here, and what is a seam:
 *   REAL — the platform (buildApp) on a real port, the game server as a real subprocess, the
 *          client served by Vite from `vite.config.js`, HTTP onboarding, the lobby WebSocket,
 *          the binary match protocol, the shell's own screens and buttons, and trusted
 *          Chromium key/mouse input into the page.
 *   SEAM — `OVERSTRIKE_SEAT_CLOCK_CONTROL`, the same clock seam `completiontest.mjs` uses, held
 *          only while N Chromium runtimes boot into the match. Nothing else is suspended.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../platform/src/app.js';
import { loadConfig } from '../platform/src/core/config.js';
import { ulid } from '../platform/src/core/ids.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── arguments ────────────────────────────────────────────────────────────────────────────
const argOf = (name, fallback) => {
  const hit = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const flag = (name) => process.argv.slice(2).includes(`--${name}`);
const PLAYERS = Math.max(1, Math.min(8, Number(argOf('players', 4))));
const MODE = String(argOf('mode', 'bomb'));
const MAP = String(argOf('map', 'the-square'));
const BOTS = Number(argOf('bots', MODE === 'bomb' ? 6 : 6));
const KILL_LIMIT = Number(argOf('killlimit', 40));
// A bomb series is first-to-seven, so it needs real time. TDM is bounded by its kill limit.
const SECONDS = Number(argOf('seconds', MODE === 'bomb' ? 900 : 420));
if (!['bomb', 'tdm'].includes(MODE)) throw new Error(`--mode must be bomb or tdm, got ${MODE}`);
if (!['the-square', 'meridian'].includes(MAP)) throw new Error(`--map must be the-square or meridian, got ${MAP}`);

const RUN = `${new Date().toISOString().replace(/[:.]/g, '-')}-${MODE}-${MAP}-${PLAYERS}p`;
// Outside the repository by default. These runs produce screenshots, per-client console
// dumps and two process logs apiece; inside the tree they are untracked files that
// `lanecheck` correctly refuses as unowned paths. `--logs=DIR` puts them wherever you want.
const LOG_DIR = String(argOf('logs', join(tmpdir(), 'overstrike-playtest', RUN)));
mkdirSync(LOG_DIR, { recursive: true });

// ── reporting ────────────────────────────────────────────────────────────────────────────
const checks = [];
const check = (condition, label, detail = '') => {
  checks.push({ ok: Boolean(condition), label, detail: String(detail) });
  if (condition) console.log(`  ok   ${label}`);
  else console.log(`  FAIL ${label}${detail ? `\n       ${String(detail).slice(0, 1200)}` : ''}`);
  return Boolean(condition);
};
const step = (text) => console.log(`\n── ${text}`);
const stats = { rounds: null, kills: 0, plants: 0, defuses: 0, disconnects: 0, deaths: 0,
  shotsFired: 0, shotsHit: 0, inputMode: 'unknown', pointerLocked: 0, matchSeconds: 0 };
/** Fatal problems that are the harness failing to set the playtest up, not the product failing. */
let setupError = null;

// ── ports and logs ───────────────────────────────────────────────────────────────────────
const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port;
    probe.close(() => resolve(port));
  });
});

const matchPort = await freePort();
const platformPort = await freePort();
const matchSecret = 'DEV-ONLY-INSECURE-MATCH-TICKET-SECRET-do-not-ship';
const controlSecret = 'DEV-ONLY-INSECURE-MATCH-CONTROL-SECRET-do-not-ship';
const SERVER_ID = `playtest-${matchPort}`;

const gameLogFile = createWriteStream(join(LOG_DIR, 'game-server.log'));
const platformLogFile = createWriteStream(join(LOG_DIR, 'platform.log'));
const platformIssues = [];
const logger = (() => {
  const write = (level) => (event, fields) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(fields || {}) });
    platformLogFile.write(`${line}\n`);
    if (level === 'warn' || level === 'error') platformIssues.push(line);
  };
  const value = { debug: () => {}, info: write('info'), warn: write('warn'), error: write('error') };
  value.child = () => value;
  return value;
})();

console.log(`\nOVERSTRIKE playtest — ${PLAYERS} browsers, ${MODE} on ${MAP}`);
console.log(`logs: ${LOG_DIR}`);

// ── the dedicated server ─────────────────────────────────────────────────────────────────
step('booting the real game server');
const gameServer = spawn(process.execPath, [join(ROOT, 'server/index.js'), `--port=${matchPort}`,
  `--bots=${BOTS}`, `--mode=${MODE}`, `--map=${MAP}`, `--killlimit=${KILL_LIMIT}`,
  `--maxclients=${Math.max(12, PLAYERS + 2)}`], {
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: 'production', NODE_NO_WARNINGS: '1',
    OVERSTRIKE_MATCH_TICKET_SECRET: matchSecret,
    OVERSTRIKE_MATCH_CONTROL_SECRET: controlSecret,
    OVERSTRIKE_PLATFORM_CONTROL_URL: `http://127.0.0.1:${platformPort}`,
    OVERSTRIKE_PUBLIC_WS_URL: `ws://127.0.0.1:${matchPort}`,
    OVERSTRIKE_SERVER_ID: SERVER_ID,
    OVERSTRIKE_SEAT_CLOCK_CONTROL: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let gameLog = '';
const captureGame = (chunk) => { const text = String(chunk); gameLog += text; gameLogFile.write(text); };
gameServer.stdout.on('data', captureGame);
gameServer.stderr.on('data', captureGame);
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`game server boot timeout\n${gameLog}`)), 60_000);
  const poll = setInterval(() => {
    if (gameLog.includes('"event":"server.listening"')) { clearTimeout(timeout); clearInterval(poll); resolve(); }
    else if (gameServer.exitCode !== null) {
      clearTimeout(timeout); clearInterval(poll);
      reject(new Error(`game server exited ${gameServer.exitCode}\n${gameLog}`));
    }
  }, 25);
});
console.log(`  game server listening on ${matchPort}`);

// ── the platform ─────────────────────────────────────────────────────────────────────────
step('booting the real platform');
const config = loadConfig({ ...process.env, NODE_ENV: 'test', PLATFORM_PORT: String(platformPort),
  PLATFORM_STORAGE: 'memory', PLATFORM_TRUSTED_PROXY_HOPS: '1',
  PLATFORM_MATCH_SERVER_URL: `ws://127.0.0.1:${matchPort}`,
  PLATFORM_MATCH_CONTROL_SECRET: controlSecret,
  PLATFORM_FLAG_OVERRIDES: 'mode.bomb.enabled=true,mode.tdm.enabled=true,map.the_square.enabled=true,map.meridian.enabled=true' });
const app = await buildApp(config, { logger });
await new Promise((resolve) => app.server.listen(platformPort, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
for (let attempt = 0; attempt < 80; attempt++) {
  if (await app.deps.store.matchServers.byId(SERVER_ID)) break;
  await sleep(250);
}
if (!await app.deps.store.matchServers.byId(SERVER_ID)) {
  throw new Error('game server never registered with the platform control plane');
}
console.log(`  platform on ${platformPort}; ${SERVER_ID} registered`);

// ── onboarding (real eligibility → consent → signup chain) ───────────────────────────────
async function call(method, path, body, token = null, extras = {}) {
  const headers = { 'content-type': 'application/json', 'x-client-build': '1.0.0', ...extras };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(base + path, { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
}

async function onboard(index) {
  const clientSessionId = ulid(Date.now() + index);
  const forwarded = { 'x-forwarded-for': `198.51.100.${index + 20}` };
  const eligibility = await call('POST', '/v1/onboarding/eligibility',
    { dateOfBirth: '1994-05-06', jurisdiction: 'CA-ON' }, null, forwarded);
  if (eligibility.status !== 200 && eligibility.status !== 201) {
    throw new Error(`eligibility failed: ${eligibility.status} ${JSON.stringify(eligibility.body)}`);
  }
  const consent = await call('PUT', '/v1/onboarding/consent',
    { telemetryPersonal: false, policyVersion: 1, clientSessionId }, null, forwarded);
  const email = `playtest-${Date.now()}-${index}@example.invalid`;
  const password = 'correct horse battery staple';
  // Display names are 3–16 characters; `Player01` is inside that on any player count here.
  const displayName = `Player${String(index + 1).padStart(2, '0')}`;
  const signup = await call('POST', '/v1/auth/signup', {
    email, password, displayName,
    eligibilityReceipt: eligibility.body.receipt, clientSessionId,
    consentReceipt: consent.body.receipt,
  }, null, forwarded);
  if (signup.status !== 201) throw new Error(`signup failed: ${signup.status} ${JSON.stringify(signup.body)}`);
  return { email, password, displayName, accountId: signup.body.profile.accountId };
}

step(`onboarding ${PLAYERS} accounts through the real chain`);
const users = [];
for (let index = 0; index < PLAYERS; index++) users.push(await onboard(index));
check(users.length === PLAYERS && new Set(users.map((u) => u.accountId)).size === PLAYERS,
  `${PLAYERS} distinct accounts completed eligibility → consent → signup`,
  users.map((u) => u.displayName).join(', '));

// ── the client, served the way the product serves it ─────────────────────────────────────
step('serving the real client build');
const { createServer } = await import('vite');
const viteServer = await createServer({
  root: ROOT, configFile: join(ROOT, 'vite.config.js'), logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null,
    proxy: { '/v1': { target: base, changeOrigin: false, ws: true } } },
});
await viteServer.listen();
const webBase = viteServer.resolvedUrls.local[0].replace(/\/$/, '');
console.log(`  client at ${webBase}`);

const { chromium } = await import('playwright');
const browser = await chromium.launch({
  headless: !flag('headed'),
  // macOS: ANGLE-on-Metal. d3d11 does not exist here and swiftshader is far slower.
  args: [process.platform === 'darwin' ? '--use-angle=metal' : '--use-angle=swiftshader',
    '--use-gl=angle', '--enable-unsafe-swiftshader', '--mute-audio',
    '--disable-features=CalculateNativeWinOcclusion'],
});

const rows = [];
async function openClient(index) {
  const user = users[index];
  /**
   * Each player gets its own address, because in a real playtest each player has one.
   *
   * The auth class is 10 requests per minute PER IP (`auth/ratelimit.js`). Four browsers on
   * one loopback address share one bucket, so the third player's sign-in is refused with
   * `AUTH_RATE_LIMITED` — a limit doing exactly its job against a topology no real playtest
   * has. Vite's proxy does not append `x-forwarded-for`, and the platform is configured for
   * one trusted hop, so the header set here is the address the limiter actually buckets on.
   */
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 },
    extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${index + 40}` } });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const netErrors = [];
  const lines = [];
  page.on('console', (message) => {
    const text = `[${message.type()}] ${message.text()}`;
    lines.push(text);
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => { pageErrors.push(error.message); lines.push(`[pageerror] ${error.message}`); });
  page.on('requestfailed', (request) => {
    const failure = `${request.url()} ${request.failure()?.errorText}`;
    lines.push(`[requestfailed] ${failure}`);
    netErrors.push(failure);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      const text = `${response.status()} ${response.url()}`;
      lines.push(`[http] ${text}`);
      netErrors.push(text);
    }
  });
  const row = { index, user, context, page, consoleErrors, pageErrors, netErrors, lines,
    label: user.displayName, entered: false, disconnects: 0, lastNet: null, cursor: { x: 640, y: 400 } };
  rows.push(row);

  // Sign in through the shell's own form, not a fetch.
  await page.goto(`${webBase}/auth/sign-in`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('#shell-identifier', { timeout: 60_000 });
  await page.fill('#shell-identifier', user.email);
  await page.fill('#shell-password', user.password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(
    () => window.__OVERSTRIKE_SHELL__?.getState?.().session?.authenticated === true,
    null, { timeout: 60_000 });
  // The signed-out restore legitimately 401s before the form is even shown; only errors after
  // an authenticated shell are the product's problem.
  await page.waitForTimeout(300);
  consoleErrors.length = 0; pageErrors.length = 0; netErrors.length = 0;

  /**
   * Finish account setup the way a new player does.
   *
   * A signup through `/v1/auth/signup` is a real account that is not yet allowed to play:
   * the shell parks it on the remaining setup steps (terms, then essential settings) and
   * refuses `/play/rooms` until they are done. Clicking through them here is part of the
   * production path, not a shortcut around it.
   */
  for (let guard = 0; guard < 8; guard++) {
    const path = new URL(page.url()).pathname;
    if (!path.startsWith('/onboarding/')) break;
    const button = page.locator('button', {
      hasText: path.includes('terms') ? 'Accept terms' : 'Continue',
    }).first();
    await button.waitFor({ state: 'visible', timeout: 30_000 });
    await button.click();
    await page.waitForFunction((from) => location.pathname !== from, path, { timeout: 30_000 });
  }
  return row;
}

step(`opening ${PLAYERS} browser contexts and signing in through the real form`);
for (let index = 0; index < PLAYERS; index++) {
  await openClient(index);
  console.log(`  ${users[index].displayName} signed in`);
}
check(rows.length === PLAYERS, `${PLAYERS} isolated browser contexts authenticated through the shell`);

// ── the lobby, driven through the shell's own screens ────────────────────────────────────
async function seatClockControl(body) {
  const response = await fetch(`http://127.0.0.1:${matchPort}/control/seat-clock`, {
    method: 'POST',
    headers: { authorization: `Bearer ${controlSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`seat-clock control refused: ${response.status}`);
  return response.json();
}

/**
 * What the shell is actually showing, when it is not showing what the harness expected.
 *
 * A selector timeout on its own says nothing about whether the product broke or the harness
 * looked in the wrong place, and this harness exists to tell those apart.
 */
async function dumpPage(row, label) {
  const shot = join(LOG_DIR, `${label}-${row.label}.png`);
  await row.page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  const detail = await row.page.evaluate(() => ({
    url: location.href,
    route: window.__OVERSTRIKE_SHELL__?.getRoute?.() ?? null,
    view: (() => {
      const state = window.__OVERSTRIKE_SHELL__?.getState?.();
      const view = state?.view;
      return view ? { variant: view.variant, error: view.error ? { code: view.error.code,
        message: view.error.message } : null, dataKeys: Object.keys(view.data || {}) } : null;
    })(),
    text: (document.querySelector('#shell-root') || document.body)?.innerText?.slice(0, 1500) ?? '',
  })).catch((error) => ({ error: error.message }));
  writeFileSync(join(LOG_DIR, `${label}-${row.label}.json`), JSON.stringify(detail, null, 2));
  return detail;
}

step('player 1 creates the room from the room-browser form');
const owner = rows[0];
await owner.page.goto(`${webBase}/play/rooms`, { waitUntil: 'domcontentloaded' });
// The create form ships collapsed behind its own <summary>; open it the way a player does.
await owner.page.locator('details.os-room-create > summary').click({ timeout: 60_000 });
try {
  await owner.page.waitForSelector('#shell-room-create-name', { timeout: 60_000 });
} catch (error) {
  const detail = await dumpPage(owner, 'rooms-screen');
  throw new Error(`the room-browser screen never offered a create form: ${JSON.stringify(detail)}`,
    { cause: error });
}
await owner.page.fill('#shell-room-create-name', `Playtest ${MODE}`);
await owner.page.selectOption('#shell-room-create-map', MAP);
await owner.page.selectOption('#shell-room-create-mode', MODE);
await owner.page.fill('#shell-room-create-capacity', String(Math.max(2, PLAYERS)));
await owner.page.click('#shell-room-create-name');
await owner.page.click('form.os-form button[type="submit"]');
await owner.page.waitForFunction(() => /\/room\//.test(location.pathname), null, { timeout: 60_000 });
const roomId = decodeURIComponent(new URL(owner.page.url()).pathname.split('/room/')[1] || '');
check(Boolean(roomId), 'the create-room form produced a real room', owner.page.url());
console.log(`  room ${roomId}`);

step('the other players join from the room detail screen');
for (const row of rows.slice(1)) {
  await row.page.goto(`${webBase}/play/rooms/${encodeURIComponent(roomId)}`, { waitUntil: 'domcontentloaded' });
  try {
    await row.page.waitForSelector('button[data-operation="join"]:not([disabled])', { timeout: 45_000 });
  } catch (error) {
    const detail = await dumpPage(row, 'join-screen');
    const room = await app.deps.store.rooms?.byId?.(roomId).catch(() => null);
    throw new Error(`${row.label} was never offered a usable Join button: `
      + `${JSON.stringify({ page: detail, room })}`, { cause: error });
  }
  await row.page.click('button[data-operation="join"]');
  await row.page.waitForFunction((id) => location.pathname === `/room/${id}`, roomId, { timeout: 60_000 });
  console.log(`  ${row.label} joined`);
}

step('everyone greens up');
for (const row of rows) {
  await row.page.waitForSelector('button[data-operation="ready"]:not([disabled])', { timeout: 60_000 });
  await row.page.click('button[data-operation="ready"]');
  await row.page.waitForFunction(() => {
    const button = document.querySelector('button[data-operation="ready"]');
    return button?.getAttribute('aria-pressed') === 'true';
  }, null, { timeout: 30_000 });
  console.log(`  ${row.label} ready`);
}
check(true, `all ${PLAYERS} players are authoritatively ready in the lobby`);

step('the owner launches, and every client enters the match');
const held = await seatClockControl({ hold: true });
if (held.held !== true) throw new Error(`seat clock did not hold: ${JSON.stringify(held)}`);
let entryError = null;
try {
  await owner.page.waitForSelector('button[data-operation="launch"]:not([disabled])', { timeout: 30_000 });
  await owner.page.click('button[data-operation="launch"]');
  /**
   * Every client's own shell navigates itself to `/match/loading` off `match.ready`.
   *
   * A refused ALLOCATION is raced against that wait rather than left to time it out: an
   * allocation that the authority rejects is a product failure that must be named in one
   * second, not a ninety-second selector timeout that reads like a slow browser.
   */
  let launchSettled = false;
  await Promise.race([
    Promise.all(rows.map((row) => row.page.waitForFunction(
      () => location.pathname === '/match/loading', null, { timeout: 120_000 })))
      .finally(() => { launchSettled = true; }),
    (async () => {
      const startedAt = Date.now();
      while (!launchSettled && Date.now() - startedAt < 120_000) {
        const refusal = platformIssues.find((line) => line.includes('lobby.launch.failed')
          || line.includes('MATCH_ALLOCATION_FAILED') || line.includes('MATCH_SERVER_UNREACHABLE'));
        if (refusal) throw new Error(`the platform could not allocate this match: ${refusal}`);
        await sleep(250);
      }
    })(),
  ]);
  launchSettled = true;
  // The handoff the shell is holding, read before it is spent. TDM streams carry no
  // `MSG_MATCHSTATE` at all, so the facade's projection is null for the whole of a TDM
  // match and cannot be the harness's source for the match id.
  for (const row of rows) {
    row.handoff = await row.page.evaluate(() => {
      const data = window.__OVERSTRIKE_SHELL__?.getState?.().view?.data ?? null;
      const value = data?.handoff ?? null;
      return value ? { matchId: value.matchId, mode: value.mode, mapId: value.mapId,
        roomId: value.roomId, serverUrl: value.serverUrl } : null;
    });
  }
  await Promise.all(rows.map(async (row) => {
    const button = row.page.locator('button', { hasText: 'Enter match' });
    await button.waitFor({ state: 'visible', timeout: 60_000 });
    await row.page.waitForFunction(() => {
      const node = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Enter match'));
      return node && !node.disabled;
    }, null, { timeout: 60_000 });
    await button.click();
  }));
  await Promise.all(rows.map((row) => row.page.waitForFunction(
    () => window.__GAME__?.netFacade?.state === 'live', null, { timeout: 180_000 })));
  for (const row of rows) row.entered = true;
} catch (error) {
  entryError = error;
  // "Nobody got in" is a symptom with a dozen causes. Ask each runtime, and the authority,
  // what they actually think happened, before any of it is torn down.
  for (const row of rows) {
    row.entryDiagnostic = await row.page.evaluate(() => ({
      url: location.href,
      runtimeLoaded: Boolean(window.__GAME__),
      facadeState: window.__GAME__?.netFacade?.state ?? null,
      lastFacadeReason: window.__GAME__?.netFacade?._lastReason ?? null,
      shellView: (() => {
        const view = window.__OVERSTRIKE_SHELL__?.getState?.().view ?? null;
        return view ? { variant: view.variant, error: view.error ? { code: view.error.code,
          message: view.error.message, details: view.error.details } : null,
        stage: view.data?.stage ?? null } : null;
      })(),
    })).catch((error_) => ({ unreadable: error_.message }));
    await dumpPage(row, 'entry-failure').catch(() => {});
  }
  const control = await fetch(`http://127.0.0.1:${matchPort}/control/status`, {
    headers: { authorization: `Bearer ${controlSecret}` },
  }).then((response) => response.json()).catch(() => null);
  writeFileSync(join(LOG_DIR, 'entry-failure.json'), JSON.stringify({
    error: String(error.message), control,
    clients: rows.map((row) => ({ player: row.label, handoff: row.handoff,
      diagnostic: row.entryDiagnostic, pageErrors: row.pageErrors, consoleErrors: row.consoleErrors })),
  }, null, 2));
} finally {
  await seatClockControl({ hold: false }).catch(() => {});
}
check(!entryError && rows.every((row) => row.entered),
  `all ${PLAYERS} Chromium runtimes reached the live match through the production shell`,
  entryError ? String(entryError.message).slice(0, 900) : '');
if (entryError) setupError = entryError;

const handoff = rows[0].handoff ?? null;
check(handoff?.mode === MODE && handoff?.mapId === MAP && Boolean(handoff?.matchId),
  `the allocated authority is the requested ${MODE} match on ${MAP}`, JSON.stringify(handoff));
check(rows.every((row) => row.handoff?.matchId === handoff?.matchId),
  `all ${PLAYERS} seats were handed to one authority`,
  JSON.stringify(rows.map((row) => row.handoff?.matchId ?? null)));
const matchId = handoff?.matchId ?? null;

// ── input ────────────────────────────────────────────────────────────────────────────────
/**
 * Play is driven by TRUSTED Chromium key and mouse events, through the product's own
 * `src/core/input.js` listeners. One thing has to be simulated, and only one.
 *
 * **Pointer lock cannot be granted to an automated Chromium.** Every `requestPointerLock`
 * from a Playwright-driven page — headless or headed, with or without a real user gesture,
 * on a real http origin — is refused with "The root document of this element is not valid
 * for pointer lock." That is a browser-automation restriction, not a product defect, and it
 * is fatal to a playtest: `menu.js` opens the pause shell on `pointerUnlock` and
 * `input._onMouseMove` drops every delta while unlocked, so an unlocked client stands still,
 * paused, for the entire match.
 *
 * So the harness asserts the ONE bit the browser will not give it (`input.locked`) and tells
 * the product's own bus that the lock is held. Everything downstream is untouched: WASD,
 * jump, crouch, reload, interact, and firing are real trusted `keydown`/`mousedown` events,
 * and look is real trusted `mousemove` with real `movementX`.
 *
 * Recentring the look sweep uses the product's own defence rather than fighting it: a jump
 * larger than 300 px is discarded by `input._onMouseMove`'s spurious-delta clamp, so the
 * return to the middle of the viewport is invisible to the game instead of being an equal
 * and opposite turn.
 */
const VIEW = { w: 1280, h: 800 };
const MAX_STEP = 250;

async function acquireLock(row) {
  await row.page.mouse.move(VIEW.w / 2, VIEW.h / 2);
  row.cursor = { x: VIEW.w / 2, y: VIEW.h / 2 };
  // Ask the browser properly first; if it ever starts saying yes, this harness uses that.
  // The refusal arrives as an asynchronous `pointerlockerror`, whose product handler sets
  // `locked = false` — so the request has to finish settling BEFORE the bit is asserted, or
  // the assertion is quietly undone a beat later.
  const granted = await row.page.evaluate(async () => {
    const game = window.__GAME__;
    if (!game?.input) return null;
    if (game.input.locked) return true;
    try { await game.input.requestLock?.(); } catch { /* refusal is the expected answer */ }
    return Boolean(game.input.locked);
  });
  if (granted === true) return true;
  await row.page.waitForTimeout(400);
  const real = await row.page.evaluate(() => {
    const game = window.__GAME__;
    if (!game?.input) return { locked: false, simulated: false };
    if (game.input.locked) return { locked: true, simulated: false };
    game.input.locked = true;
    game.input.enabled = true;
    game.setPaused?.(false);
    game.bus?.emit?.('pointerLock', {});
    game.menu?.close?.();
    return { locked: Boolean(game.input.locked), simulated: true };
  });
  if (real.simulated) row.simulatedLock = true;
  return real.locked;
}

async function look(row, dx, dy) {
  let remaining = dx;
  let vertical = dy;
  for (let guard = 0; guard < 6 && (Math.abs(remaining) > 1 || Math.abs(vertical) > 1); guard++) {
    const stepX = Math.max(-MAX_STEP, Math.min(MAX_STEP, remaining));
    const stepY = Math.max(-MAX_STEP, Math.min(MAX_STEP, vertical));
    let nextX = row.cursor.x + stepX;
    let nextY = row.cursor.y + stepY;
    if (nextX < 60 || nextX > VIEW.w - 60 || nextY < 60 || nextY > VIEW.h - 60) {
      // Recentre with a jump the product ignores, then take the step from the middle.
      await row.page.mouse.move(VIEW.w / 2, VIEW.h / 2);
      row.cursor = { x: VIEW.w / 2, y: VIEW.h / 2 };
      nextX = row.cursor.x + stepX;
      nextY = row.cursor.y + stepY;
    }
    await row.page.mouse.move(nextX, nextY);
    row.cursor = { x: nextX, y: nextY };
    remaining -= stepX;
    vertical -= stepY;
  }
}

/**
 * How many radians of yaw one raw mouse pixel buys, measured against the running product.
 *
 * Reports WHY it failed when it fails: "the mouse does not turn the player" has at least
 * four distinct causes (no event, a dropped delta, a paused sim, a dead player) and a bare
 * null tells the reader none of them.
 */
async function calibrate(row) {
  const before = await row.page.evaluate(() => {
    const game = window.__GAME__;
    window.__PT_MOVE__ = 0;
    document.addEventListener('mousemove', (event) => { window.__PT_MOVE__ += event.movementX; });
    return { yaw: game?.player?.yaw ?? null, locked: Boolean(game?.input?.locked),
      enabled: Boolean(game?.input?.enabled), paused: Boolean(game?.paused),
      state: game?.state ?? null, menuOpen: Boolean(game?.menu?.isOpen),
      alive: game?.player?.alive ?? null };
  });
  await look(row, -400, 0);
  await row.page.waitForTimeout(400);
  const after = await row.page.evaluate(() => {
    const game = window.__GAME__;
    return { yaw: game?.player?.yaw ?? null, seenMovement: window.__PT_MOVE__,
      pendingDX: game?.input?.mouseDX ?? null, paused: Boolean(game?.paused),
      state: game?.state ?? null, menuOpen: Boolean(game?.menu?.isOpen),
      alive: game?.player?.alive ?? null };
  });
  row.lookDiagnostic = { before, after };
  if (before.yaw === null || after.yaw === null) return null;
  let delta = after.yaw - before.yaw;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta / -400;
}

const readState = (page) => page.evaluate(() => {
  const game = window.__GAME__;
  if (!game) return { alive: false, present: false };
  const facade = game.netFacade;
  const matchState = facade?.matchState ?? null;
  const player = game.player;
  // Who is actually in front of this player, straight off the authoritative snapshot the
  // client is already interpolating. A playtester who never shoots at anybody proves the
  // shooting path works about as well as one who never joins.
  // The local team, taken from the authoritative snapshot rather than the local Player.
  // A TDM stream carries no `MSG_MATCHSTATE` at all, so `matchState` is null for the whole
  // match and cannot answer this; without it every teammate reads as an enemy and the
  // harness spends the match shooting its own side through friendly fire it cannot land.
  const session = facade?._session ?? null;
  const snapshots = session?.net?.snapshots ?? [];
  const latest = snapshots[snapshots.length - 1] ?? null;
  const myEntityId = session?.net?.entityId ?? null;
  const localTeam = latest?.entities?.find((entity) => entity.id === myEntityId)?.team
    ?? player?.team ?? null;
  let nearestEnemy = null;
  if (player) {
    for (const remote of facade?.remoteEntities?.values?.() ?? []) {
      if (!remote?.alive || (localTeam !== null && remote.team === localTeam)) continue;
      const distance = Math.hypot(remote.x - player.position.x, remote.z - player.position.z);
      if (!nearestEnemy || distance < nearestEnemy.distance) {
        nearestEnemy = { x: remote.x, y: remote.y, z: remote.z, id: remote.id, distance };
      }
    }
  }
  return {
    present: true,
    net: facade?.state ?? null,
    locked: Boolean(game.input?.locked),
    paused: Boolean(game.paused),
    yaw: player?.yaw ?? 0,
    pitch: player?.pitch ?? 0,
    myTeam: localTeam,
    nearestEnemy,
    pos: player ? { x: player.position.x, y: player.position.y, z: player.position.z } : null,
    phase: matchState?.phase ?? null,
    mode: matchState?.mode ?? null,
    alive: matchState?.localPlayer?.alive ?? null,
    team: matchState?.localPlayer?.team ?? null,
    entityId: matchState?.localPlayer?.entityId ?? null,
    bomb: matchState?.bomb ?? null,
    sites: matchState?.sites ?? null,
    sideSwitched: matchState?.series?.sideSwitched ?? false,
    interaction: matchState?.interaction ?? null,
    round: matchState?.round?.index ?? null,
    scores: matchState ? { alpha: matchState.teams.alpha.score, bravo: matchState.teams.bravo.score } : null,
  };
});

const yawTo = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z));
const wrap = (radians) => {
  let value = radians;
  while (value > Math.PI) value -= Math.PI * 2;
  while (value < -Math.PI) value += Math.PI * 2;
  return value;
};

/**
 * One player, played like a person: walk somewhere, look around, shoot, and in bomb mode
 * actually go and get the bomb and plant it.
 */
async function play(row, radPerPixel, endsAt) {
  const page = row.page;
  const keyboard = page.keyboard;
  const heldKeys = new Set();
  const setKeys = async (want) => {
    for (const key of [...heldKeys]) if (!want.has(key)) { await keyboard.up(key).catch(() => {}); heldKeys.delete(key); }
    for (const key of want) if (!heldKeys.has(key)) { await keyboard.down(key).catch(() => {}); heldKeys.add(key); }
  };
  let firing = false;
  const setFiring = async (want) => {
    if (want === firing) return;
    firing = want;
    if (want) await page.mouse.down().catch(() => {});
    else await page.mouse.up().catch(() => {});
  };
  let tick = 0;
  let wander = null;
  let lastLocked = true;
  while (Date.now() < endsAt && !row.done) {
    tick += 1;
    let state;
    try { state = await readState(page); } catch { break; }
    if (!state.present) break;
    if (state.net && state.net !== row.lastNet) {
      if (state.net === 'reconnecting') { row.disconnects += 1; stats.disconnects += 1; }
      row.lastNet = state.net;
    }
    if (!state.locked) {
      // The product drops the look state on blur, on menu open, and on a refused lock. Take
      // it back rather than spending the rest of the match paused, and say that it happened.
      if (lastLocked) row.lines.push(`[playtest] look state lost at tick ${tick}`);
      lastLocked = false;
      await setKeys(new Set());
      await setFiring(false);
      await acquireLock(row);
      continue;
    }
    lastLocked = true;

    // ── decide where to go ────────────────────────────────────────────────────────────
    let target = null;
    let interact = false;
    const bombing = state.mode === 'bomb' && state.sites && state.sites.length === 2;
    if (bombing && state.alive !== false) {
      const teamIndex = state.team === 'alpha' ? 0 : state.team === 'bravo' ? 1 : 0;
      const enemyIndex = (teamIndex === 0 ? 1 : 0) ^ (state.sideSwitched ? 1 : 0);
      const targetSite = state.sites[enemyIndex] ?? state.sites[1];
      const carrying = state.bomb?.state === 'carried' && state.bomb.carrierId === state.entityId;
      if (carrying) {
        target = targetSite.center;
        const distance = state.pos ? Math.hypot(state.pos.x - target.x, state.pos.z - target.z) : 99;
        interact = distance < 2.4;
      } else if (state.bomb?.state === 'dropped' && state.bomb.position) {
        target = state.bomb.position;
      } else if (state.bomb?.state === 'planted') {
        // Defusing is the defender's job; heading for the site is right either way.
        target = (state.sites[teamIndex ^ (state.sideSwitched ? 1 : 0)] ?? targetSite).center;
        const distance = state.pos ? Math.hypot(state.pos.x - target.x, state.pos.z - target.z) : 99;
        interact = distance < 2.4;
      } else {
        target = targetSite.center;
      }
    }
    if (!target) {
      // Wander: pick a point, walk to it, pick another. A human does not stand still.
      if (!wander || (state.pos && Math.hypot(state.pos.x - wander.x, state.pos.z - wander.z) < 3)
        || tick % 60 === 0) {
        wander = { x: (Math.random() - 0.5) * 60, y: 0, z: (Math.random() - 0.5) * 60 };
      }
      target = wander;
    }

    // ── look: at whoever is shootable, otherwise where we are going ───────────────────
    const enemy = !interact && state.nearestEnemy && state.nearestEnemy.distance < 45
      ? state.nearestEnemy : null;
    row.ticks = (row.ticks ?? 0) + 1;
    if (state.nearestEnemy) {
      row.ticksWithTarget = (row.ticksWithTarget ?? 0) + 1;
      row.closestSeen = Math.min(row.closestSeen ?? Infinity, state.nearestEnemy.distance);
    }
    if (enemy) row.ticksEngaging = (row.ticksEngaging ?? 0) + 1;
    row.team = state.myTeam;
    const aimAt = enemy ?? target;
    if (state.pos && radPerPixel) {
      const desired = yawTo(state.pos, aimAt);
      const error = wrap(desired - state.yaw);
      // Jitter, so the sweep is not a robot's ruler-straight pan.
      const jitter = (Math.random() - 0.5) * (enemy ? 0.05 : 0.25);
      const dx = (error + jitter) / radPerPixel;
      let dy = (Math.random() - 0.5) * 40;
      if (enemy && state.pos) {
        // Chest height on the target, resolved through the same radians-per-pixel scale.
        // Pitch is inverted relative to yaw: moving the mouse down looks down.
        const flat = Math.max(0.5, Math.hypot(enemy.x - state.pos.x, enemy.z - state.pos.z));
        const desiredPitch = Math.atan2((enemy.y + 0.9) - (state.pos.y + 1.5), flat);
        dy = Math.max(-300, Math.min(300, -(desiredPitch - state.pitch) / radPerPixel));
      }
      await look(row, Math.max(-600, Math.min(600, dx)), dy);
    }

    // ── move ──────────────────────────────────────────────────────────────────────────
    const want = new Set(['KeyW']);
    if (tick % 7 === 0) want.add(Math.random() < 0.5 ? 'KeyA' : 'KeyD');
    if (tick % 11 === 0 && !enemy) want.add('ShiftLeft');
    if (tick % 23 === 0) want.add('Space');
    if (tick % 31 === 0) { want.delete('KeyW'); want.add('ControlLeft'); }
    if (interact) want.add('KeyE');
    if (tick % 37 === 0) want.add('KeyR');
    await setKeys(want);

    // ── shoot ─────────────────────────────────────────────────────────────────────────
    // Sprinting cannot fire, so a burst is held while an enemy is up and tapped otherwise.
    await setFiring(!interact && (enemy ? tick % 6 !== 0 : tick % 5 === 0));

    await sleep(120);
  }
  await setKeys(new Set()).catch(() => {});
  await setFiring(false).catch(() => {});
}

let radPerPixel = null;
if (!setupError) {
  step('taking pointer lock and calibrating real mouse look');
  for (const row of rows) {
    const locked = await acquireLock(row);
    if (locked) stats.pointerLocked += 1;
    else row.lines.push('[playtest] pointer lock was never granted');
  }
  const simulated = rows.filter((row) => row.simulatedLock).length;
  check(stats.pointerLocked === PLAYERS,
    `every client is in the unpaused look state (${stats.pointerLocked}/${PLAYERS})`,
    simulated ? `${simulated} of ${PLAYERS} had to assert input.locked: Chromium refuses pointer lock to automation` : '');
  radPerPixel = await calibrate(rows[0]);
  const usable = Number.isFinite(radPerPixel) && Math.abs(radPerPixel) > 1e-6;
  stats.simulatedLocks = simulated;
  stats.inputMode = usable
    ? `trusted Chromium key/mouse events${simulated ? ' (pointer-lock bit asserted; see the header comment)' : ''}`
    : 'trusted keys only — look calibration failed';
  check(usable, 'trusted Chromium mouse movement actually turns the player',
    `radians per pixel: ${radPerPixel}; ${JSON.stringify(rows[0].lookDiagnostic)}`);
}

// ── play ─────────────────────────────────────────────────────────────────────────────────
let terminal = null;
const matchStartedAt = Date.now();
if (!setupError) {
  step(`playing for up to ${SECONDS}s`);
  const endsAt = Date.now() + SECONDS * 1000;
  const drivers = rows.map((row) => play(row, radPerPixel, endsAt).catch((error) => {
    row.lines.push(`[playtest] driver stopped: ${error.message}`);
  }));
  const watcher = (async () => {
    let lastReport = 0;
    while (Date.now() < endsAt) {
      const response = await fetch(`http://127.0.0.1:${matchPort}/control/status`, {
        headers: { authorization: `Bearer ${controlSecret}` },
      }).then((r) => r.json()).catch(() => null);
      if (response?.status === 'ended') { terminal = response; break; }
      if (Date.now() - lastReport > 20_000) {
        lastReport = Date.now();
        const snapshot = await readState(rows[0].page).catch(() => null);
        console.log(`  t+${Math.round((Date.now() - matchStartedAt) / 1000)}s  phase=${snapshot?.phase ?? '?'}`
          + ` round=${snapshot?.round ?? '-'} score=${snapshot?.scores?.alpha ?? '?'}:${snapshot?.scores?.bravo ?? '?'}`
          + ` bomb=${snapshot?.bomb?.state ?? '-'}`);
      }
      await sleep(1000);
    }
  })();
  await watcher;
  for (const row of rows) row.done = true;
  await Promise.all(drivers);
  stats.matchSeconds = Math.round((Date.now() - matchStartedAt) / 1000);
  check(Boolean(terminal) && terminal.result?.status === 'completed',
    'the match reached a real natural end (not a timeout cap, not an abort)',
    terminal ? JSON.stringify({ status: terminal.status, result: terminal.result?.status,
      reason: terminal.result?.outcomeReason }) : `no matchEnd within ${SECONDS}s`);
}

// ── durable outcome ──────────────────────────────────────────────────────────────────────
step('verifying the durable outcome in the platform store');
let stored = null;
if (matchId) {
  for (let attempt = 0; attempt < 120; attempt++) {
    await app.deps.lobby.sweep().catch(() => {});
    stored = await app.deps.store.matches.byId(matchId).catch(() => null);
    if (stored?.resultAppliedAt) break;
    await sleep(500);
  }
  check(stored?.status === 'completed',
    'the match row is `completed`', JSON.stringify({ status: stored?.status,
      terminationReason: stored?.terminationReason, outcomeReason: stored?.outcomeReason }));
  check(Boolean(stored?.outcomeReason),
    'the match row carries a real outcomeReason', String(stored?.outcomeReason));
  check(Boolean(stored?.resultAppliedAt) && Boolean(stored?.evidenceRef),
    'evidence was accepted and the result was applied',
    JSON.stringify({ resultAppliedAt: stored?.resultAppliedAt, evidenceRef: stored?.evidenceRef }));
  const retained = await app.deps.store.matchEvidence.byMatchId(matchId).catch(() => null);
  check(retained?.evidenceRef === stored?.evidenceRef,
    'the retained evidence row matches the digest on the match row',
    JSON.stringify({ retained: retained?.evidenceRef, row: stored?.evidenceRef }));
  stats.rounds = Array.isArray(stored?.rounds) ? stored.rounds.length : null;
} else {
  check(false, 'a match id was available to verify', 'no client ever entered a match');
}

const validationFailures = platformIssues.filter((line) => line.includes('VALIDATION_FAILED'));
check(validationFailures.length === 0, 'no VALIDATION_FAILED appeared while settling the result',
  validationFailures.slice(0, 3).join('\n       '));

const perAccount = [];
for (const user of users) {
  const list = await app.deps.store.stats.listForAccount(user.accountId).catch(() => []);
  const mine = list.find((entry) => entry.mode === MODE) ?? null;
  perAccount.push({ name: user.displayName, row: mine });
  if (mine) {
    stats.kills += mine.kills ?? 0;
    stats.deaths += mine.deaths ?? 0;
    stats.plants += mine.plants ?? 0;
    stats.defuses += mine.defuses ?? 0;
    stats.shotsFired += mine.shotsFired ?? 0;
    stats.shotsHit += mine.shotsHit ?? 0;
  }
}
check(perAccount.every((entry) => entry.row && (entry.row.matches ?? 0) > 0),
  `career stats landed for all ${PLAYERS} accounts`,
  JSON.stringify(perAccount.map((entry) => [entry.name, entry.row
    ? { matches: entry.row.matches, kills: entry.row.kills, deaths: entry.row.deaths,
      plants: entry.row.plants, defuses: entry.row.defuses, shots: entry.row.shotsFired } : null])));

let registry = null;
for (let attempt = 0; attempt < 60; attempt++) {
  registry = await app.deps.store.matchServers.byId(SERVER_ID).catch(() => null);
  if (registry && registry.inUse === 0 && registry.reservedAt === null) break;
  await sleep(500);
}
check(registry?.inUse === 0 && registry?.reservedAt === null,
  'the match-server registry released its capacity',
  JSON.stringify({ inUse: registry?.inUse, reservedAt: registry?.reservedAt, status: registry?.status }));

// ── client-side health ───────────────────────────────────────────────────────────────────
step('client console health');
/**
 * Noise, and only noise.
 *
 * Software-GL chatter is the environment talking, and `net::ERR_ABORTED` is a request the
 * PAGE cancelled — the shell navigating away from a screen whose fetch was still in flight,
 * and the `unload` credential beacon, which is aborted by design. Neither is a failure the
 * product committed, and neither must be allowed to mask one that is.
 */
const GL_NOISE = /WebGL|SwiftShader|KHR_parallel|GL Driver|ANGLE|Automatic fallback|net::ERR_ABORTED/i;
const clientProblems = [];
for (const row of rows) {
  const console_ = row.consoleErrors.filter((text) => !GL_NOISE.test(text));
  const page_ = row.pageErrors.filter((text) => !GL_NOISE.test(text));
  const net_ = row.netErrors.filter((text) => !GL_NOISE.test(text));
  if (console_.length || page_.length || net_.length) {
    clientProblems.push({ player: row.label, console: console_, page: page_, network: net_ });
  }
}
check(clientProblems.length === 0, 'no client logged a page error, console error or failed request',
  JSON.stringify(clientProblems, null, 2).slice(0, 2000));

// ── save everything ──────────────────────────────────────────────────────────────────────
for (const row of rows) {
  writeFileSync(join(LOG_DIR, `client-${row.index + 1}-${row.label}.log`), row.lines.join('\n'));
}
writeFileSync(join(LOG_DIR, 'platform-warnings.log'), platformIssues.join('\n'));
writeFileSync(join(LOG_DIR, 'summary.json'), JSON.stringify({
  run: RUN, mode: MODE, map: MAP, players: PLAYERS, matchId,
  checks, stats, terminal: terminal?.result ?? null, storedMatch: stored ?? null,
  careerStats: perAccount, registry, clientProblems,
}, null, 2));

// ── teardown ─────────────────────────────────────────────────────────────────────────────
for (const row of rows) await row.context.close().catch(() => {});
await browser.close().catch(() => {});
await viteServer.close().catch(() => {});
app.stop();
app.server.closeAllConnections?.();
await new Promise((resolve) => app.server.close(resolve));
await app.deps.store.close().catch(() => {});
if (gameServer.exitCode === null && gameServer.signalCode === null) gameServer.kill('SIGTERM');
await new Promise((resolve) => {
  if (gameServer.exitCode !== null || gameServer.signalCode !== null) resolve();
  else gameServer.once('exit', resolve);
});
gameLogFile.end();
platformLogFile.end();

// ── report ───────────────────────────────────────────────────────────────────────────────
const failedChecks = checks.filter((entry) => !entry.ok);
console.log('\n════════════════════════════════════════════════════════════════');
console.log(`PLAYTEST ${failedChecks.length ? 'FAIL' : 'PASS'} — ${MODE} on ${MAP}, ${PLAYERS} real clients`);
console.log('════════════════════════════════════════════════════════════════');
for (const entry of checks) console.log(`  ${entry.ok ? 'PASS' : 'FAIL'}  ${entry.label}`);
console.log('\nplay statistics');
console.log(`  match wall time    ${stats.matchSeconds}s`);
console.log(`  rounds recorded    ${stats.rounds ?? 'n/a'}`);
console.log(`  kills / deaths     ${stats.kills} / ${stats.deaths}   (human players only)`);
console.log(`  shots fired / hit  ${stats.shotsFired} / ${stats.shotsHit}`);
if (MODE === 'bomb') console.log(`  plants / defuses   ${stats.plants} / ${stats.defuses}`);
console.log(`  disconnects        ${stats.disconnects}`);
console.log(`  pointer locks      ${stats.pointerLocked}/${PLAYERS}`);
for (const row of rows) {
  console.log(`  ${row.label.padEnd(9)} team ${row.team ?? '?'}  ${row.ticks ?? 0} decisions, `
    + `${row.ticksWithTarget ?? 0} with an enemy in the snapshot, ${row.ticksEngaging ?? 0} engaging, `
    + `closest ${Number.isFinite(row.closestSeen) ? row.closestSeen.toFixed(1) : '—'} m`);
}
console.log(`  input driven by    ${stats.inputMode}`);
const gameWarnings = gameLog.split(/\r?\n/).filter((line) => /"level":"(warn|error)"/.test(line));
console.log('\nlog scan');
console.log(`  game-server warn/error lines  ${gameWarnings.length}`);
console.log(`  platform warn/error lines     ${platformIssues.length}`);
console.log(`  client problem reports        ${clientProblems.length}`);
for (const line of gameWarnings.slice(0, 8)) console.log(`    ${line.slice(0, 200)}`);
for (const line of platformIssues.slice(0, 8)) console.log(`    ${line.slice(0, 200)}`);
console.log(`\nlogs saved to ${LOG_DIR}`);
if (setupError) console.log(`\nsetup error: ${setupError.stack}`);
process.exit(failedChecks.length ? 1 : 0);
