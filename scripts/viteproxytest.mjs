/** H1.1: the documented Vite origin reaches the stateful platform and preserves cookies. */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
const waitFor = async (url, timeoutMs = 15_000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if ((await fetch(url)).ok) return; } catch { /* process is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
};
const waitPort = async (port, timeoutMs = 15_000) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const ready = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for port ${port}`);
};
const stop = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
};

const platformPort = await freePort();
const vitePort = await freePort();
const tlsDir = mkdtempSync(path.join(os.tmpdir(), 'overstrike-vite-tls-'));
const tlsKey = path.join(tlsDir, 'key.pem');
const tlsCert = path.join(tlsDir, 'cert.pem');
const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', tlsKey, '-out', tlsCert, '-days', '1', '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
if (openssl.status !== 0) throw new Error('openssl is required for the HTTPS Vite cookie proof');
const platform = spawn(process.execPath, ['platform/src/index.js'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', PLATFORM_PORT: String(platformPort),
    PLATFORM_STORAGE: 'memory', PLATFORM_IDENTITY_PROVIDER: 'local' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1',
  '--port', String(vitePort), '--strictPort'], {
  cwd: root,
  env: { ...process.env, VITE_PLATFORM_PROXY_TARGET: `http://127.0.0.1:${platformPort}`,
    VITE_HTTPS_KEY_FILE: tlsKey, VITE_HTTPS_CERT_FILE: tlsCert },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  await Promise.all([
    waitFor(`http://127.0.0.1:${platformPort}/v1/health`),
    waitPort(vitePort),
  ]);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  // Chromium treats localhost as a trustworthy development origin, including Secure cookies;
  // a raw 127.0.0.1 origin does not exercise the browser rule the documented dev URL relies on.
  const origin = `https://localhost:${vitePort}`;
  const harnessUrl = `${origin}/__vite_proxy_harness`;
  await page.route(harnessUrl, (route) => route.fulfill({ status: 200,
    contentType: 'text/html', body: '<!doctype html><title>Vite proxy proof</title>' }));
  await page.goto(harnessUrl, { waitUntil: 'domcontentloaded' });

  const stub = await page.evaluate(async () => {
    const sid = '01M0D000000000000000000001';
    const request = async (path, method, body) => {
      const correlationId = crypto.randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase()
        .replace(/[ILOU]/g, '0');
      // Use an exact ULID-shaped value; the stub echoes it through the Vite proxy.
      const cid = `01M0D${correlationId.slice(5).padEnd(21, '0')}`;
      const response = await fetch(path, { method, credentials: 'include', headers: {
        'Content-Type': 'application/json', 'X-Client-Build': '1',
        'X-Correlation-Id': cid, 'X-Client-Session-Id': sid,
        'X-Stub-Scenario': 'onboarding-happy',
      }, body: JSON.stringify(body) });
      const data = await response.json();
      return { status: response.status, data,
        headerCorrelation: response.headers.get('X-Correlation-Id') };
    };
    const eligibility = await request('/v1/onboarding/eligibility', 'POST',
      { dateOfBirth: '1994-03-02', jurisdiction: 'CA-ON' });
    const consent = await request('/v1/onboarding/consent', 'PUT',
      { telemetryPersonal: true, policyVersion: 1, clientSessionId: sid });
    sessionStorage.setItem('vite-proxy-stub', JSON.stringify({ sid,
      eligibilityReceipt: eligibility.data.receipt, consentReceipt: consent.data.receipt }));
    return { eligibility, consent };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const signup = await page.evaluate(async () => {
    const saved = JSON.parse(sessionStorage.getItem('vite-proxy-stub'));
    const cid = '01M0D000000000000000000099';
    const response = await fetch('/v1/auth/signup', { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Client-Build': '1',
        'X-Correlation-Id': cid, 'X-Client-Session-Id': saved.sid,
        'X-Stub-Scenario': 'onboarding-happy' },
      body: JSON.stringify({ email: 'stub@example.invalid', password: 'stub-password',
        displayName: 'Stub Player', clientSessionId: saved.sid,
        eligibilityReceipt: saved.eligibilityReceipt, consentReceipt: saved.consentReceipt }) });
    const data = await response.json();
    return { status: response.status, data,
      headerCorrelation: response.headers.get('X-Correlation-Id') };
  });
  if (stub.eligibility.status !== 200 || stub.consent.status !== 200 || signup.status !== 201
      || signup.data.profile.flags.setupNextStep !== 'verify'
      || signup.headerCorrelation !== signup.data.correlationId) {
    throw new Error(`stateful proxy scenario failed: ${JSON.stringify({ stub, signup })}`);
  }

  const liveSignupResponse = page.waitForResponse((response) =>
    response.url().endsWith('/v1/auth/signup'));
  const live = await page.evaluate(async () => {
    const sid = '01M0D000000000000000000002';
    let n = 10;
    const request = async (path, method, body) => {
      const cid = `01M0D0000000000000000000${n++}`;
      const response = await fetch(path, { method, credentials: 'include', headers: {
        'Content-Type': 'application/json', 'X-Client-Build': '1', 'X-Correlation-Id': cid,
      }, body: JSON.stringify(body) });
      return { status: response.status, data: response.status === 204 ? null : await response.json(),
        cid, header: response.headers.get('X-Correlation-Id') };
    };
    const eligibility = await request('/v1/onboarding/eligibility', 'POST',
      { dateOfBirth: '1994-03-02', jurisdiction: 'CA-ON' });
    const consent = await request('/v1/onboarding/consent', 'PUT',
      { telemetryPersonal: true, policyVersion: 1, clientSessionId: sid });
    const signup = await request('/v1/auth/signup', 'POST', {
      email: `proxy-${Date.now()}@example.invalid`, password: 'correct-horse-battery-staple',
      displayName: `Proxy${String(Date.now()).slice(-8)}`, clientSessionId: sid,
      eligibilityReceipt: eligibility.data.receipt, consentReceipt: consent.data.receipt,
    });
    return { eligibility, consent, signup, readableCookie: document.cookie };
  });
  const liveSignupHeaders = await (await liveSignupResponse).allHeaders();
  const cookieHeader = liveSignupHeaders['set-cookie'] || '';
  const cookieValue = /^os_rt=([^;]+)/.exec(cookieHeader)?.[1];
  if (!cookieValue || !/; Path=\/v1\/auth; Secure; HttpOnly; SameSite=Lax$/i.test(cookieHeader)) {
    throw new Error(`Vite did not forward the exact refresh cookie: ${cookieHeader}`);
  }
  // A self-signed local certificate is deliberately not installed into the host trust store.
  // Put the exact forwarded Set-Cookie value into this isolated browser jar, then prove the
  // scoped httpOnly credential survives navigation and is automatically sent through Vite.
  await context.addCookies([{ name: 'os_rt', value: cookieValue, domain: 'localhost',
    path: '/v1/auth', secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const cookies = await context.cookies(`${origin}/v1/auth`);
  const refresh = cookies.find((cookie) => cookie.name === 'os_rt');
  if (live.signup.status !== 201 || live.signup.header !== live.signup.data.correlationId
      || !refresh?.httpOnly || refresh.path !== '/v1/auth'
      || live.readableCookie.includes('os_rt')) {
    throw new Error(`same-origin cookie contract failed: ${JSON.stringify({ live, cookies,
      liveSignupHeaders })}`);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  const refreshed = await page.evaluate(async () => {
    const cid = '01M0D000000000000000000020';
    const response = await fetch('/v1/auth/refresh', { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Client-Build': '1',
        'X-Correlation-Id': cid }, body: '{}' });
    return { status: response.status, data: await response.json(),
      header: response.headers.get('X-Correlation-Id') };
  });
  if (refreshed.status !== 200 || !refreshed.data.accessToken
      || refreshed.header !== refreshed.data.correlationId) {
    throw new Error(`reload refresh through proxy failed: ${JSON.stringify(refreshed)}`);
  }
  console.log('  ok   Vite /v1 proxy preserves state, correlation, httpOnly cookie, and reload refresh');
} finally {
  await browser?.close();
  await Promise.all([stop(vite), stop(platform)]);
  rmSync(tlsDir, { recursive: true, force: true });
}
