/** Browser-rendered P3.B5 budget gate for The Square, with a real failing control. */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BINDING_ACTIONS,
  SETTINGS_INVENTORY,
  ROAMING_SETTINGS_SCHEMA_VERSION,
} from '../src/ui/shell/settings/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP_LIMITS = Object.freeze({ drawCalls: 140, triangles: 300000, materials: 48, lights: 6 });
const INTEGRATED_LIMITS = Object.freeze({ drawCalls: 220, triangles: 450000 });
let server;
let browser;
let checks = 0;
let failures = 0;
function check(condition, name, detail = '') {
  checks++;
  if (condition) console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const p95 = (rows, key) => {
  const values = rows.map((row) => row[key]).sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)];
};

try {
  server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    server: { port: 0, strictPort: false, hmr: false, watch: null },
    logLevel: 'error',
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
  });
  page.setDefaultTimeout(180000);
  await page.addInitScript(() => {
    const native = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      if (query === '(any-pointer: fine)') return { matches: true, media: query,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
      if (query === '(pointer: coarse)') return { matches: false, media: query,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
      return native(query);
    };
  });
  const pageErrors = [];
  const consoleErrors = [];
  const requestFailures = [];
  const httpErrors = [];
  const unexpectedRequests = [];
  let sampling = false;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (sampling && message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    if (sampling) requestFailures.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`);
  });
  // Self-contained authenticated platform boundary. A deliberate 401 would be a valid signed-out
  // product state but Chromium still reports it as a failed resource, making a clean renderer
  // gate impossible. These closed fixtures exercise successful restoration without depending on
  // a developer's platform process and make every unexpected request fail visibly.
  const accountId = '01J00000000000000000000001';
  const sessionId = '01J00000000000000000000002';
  const roamingValues = Object.fromEntries(SETTINGS_INVENTORY
    .filter((definition) => definition.scope === 'ROAM')
    .map((definition) => [definition.key, definition.defaultValue]));
  roamingValues.keybinds = Object.fromEntries(BINDING_ACTIONS.map((action) => [action.id, {
    primary: action.primary, secondary: action.secondary,
  }]));
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const correlationId = request.headers()['x-correlation-id'] || '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const pathname = new URL(request.url()).pathname;
    const respond = (status, body = {}, headers = {}) => route.fulfill(status === 204 ? {
      status, headers: { 'X-Correlation-Id': correlationId, ...headers },
    } : {
      status, contentType: 'application/json',
      headers: { 'X-Correlation-Id': correlationId, ...headers },
      body: JSON.stringify({ ...body, correlationId }),
    });
    if (pathname === '/v1/auth/refresh') return respond(200, {
      accessToken: 'mapperf-access-token', expiresAt: '2099-08-20T18:00:00.000Z',
      session: { sessionId, deviceLabel: 'Renderer acceptance', createdAt: '2026-08-20T16:00:00.000Z' },
      profile: { accountId, displayName: 'Renderer Player', createdAt: '2026-08-20T16:00:00.000Z',
        privacy: { statsVisibility: 'nobody', presenceVisibility: 'nobody' }, consent: null,
        moderation: { status: 'clear', activeSanctions: [] },
        flags: { nameChangeAvailableAt: null, setupNextStep: null } },
      consentReceipt: null,
    });
    if (pathname === '/v1/profile/me') return respond(200, {
      accountId, displayName: 'Renderer Player', createdAt: '2026-08-20T16:00:00.000Z',
      privacy: { statsVisibility: 'nobody', presenceVisibility: 'nobody' }, consent: null,
      moderation: { status: 'clear', activeSanctions: [] },
      flags: { nameChangeAvailableAt: null, setupNextStep: null },
    });
    if (pathname === `/v1/profile/${accountId}`) return respond(200, {
      accountId, displayName: 'Renderer Player', createdAt: '2026-08-20T16:00:00.000Z',
      stats: null, presence: { state: 'online', joinable: false, roomId: null },
    });
    // `currentPolicyVersion` is REQUIRED by http-api.md §3a.3 (1.11.0) and the shell's
    // projection validator refuses the response without it. This fixture hand-writes a
    // platform reply, so it does not follow the contract when the contract moves — it went
    // stale the moment that field landed, and the failure surfaced as "the platform returned
    // an invalid success projection" from a RENDERER benchmark, which is a long way from the
    // cause. A fixture that fakes a service inherits the duty to track its contract.
    if (pathname === '/v1/onboarding/consent') return respond(200, {
      telemetryPersonal: false, policyVersion: 1, decidedAt: '2026-08-20T16:01:00.000Z',
      currentPolicyVersion: 1, subject: 'account', receipt: 'mapperf-decline-receipt',
    });
    if (pathname === '/v1/profile/me/settings') return respond(200, {
      schemaVersion: ROAMING_SETTINGS_SCHEMA_VERSION, version: 1, values: roamingValues,
      updatedAt: '2026-08-20T16:02:00.000Z',
    }, { ETag: '"1"' });
    if (pathname === '/v1/config/flags') return respond(200, {
      version: 1, evaluatedAt: '2026-08-20T16:02:00.000Z', expiresAt: '2099-08-20T16:03:00.000Z',
      flags: {
        'shell.diagnostics.panel': true, 'shell.career.enabled': true,
        'shell.serverbrowser.enabled': true, 'mode.tdm.enabled': true,
        'mode.bomb.enabled': true, 'map.the_square.enabled': true,
        'chat.text.enabled': true, 'chat.pings.enabled': true,
        'reports.enabled': true, 'telemetry.client.enabled': false,
      },
    });
    if (pathname === '/v1/matches/active'
      || pathname === '/v1/telemetry/unload/credential') return respond(204);
    if (pathname === '/v1/rooms') return respond(200, { items: [], nextCursor: null });
    if (pathname === '/v1/presence/online') return respond(200, { items: [], nextCursor: null });
    // http-api.md §11.6, sideloaded by `listRooms` for the create form's region dropdown.
    // The fixture is CLOSED on purpose — an unlisted path is recorded and 404'd — and it is
    // what caught this call the moment the sideload was added. Answered with a real region so
    // the renderer measures the shell a player gets, not a degraded fallback.
    if (pathname === '/v1/config/regions') return respond(200, { regions: [
      { id: 'iad', label: 'Ashburn, Virginia', probeUrl: null, available: true },
    ] });
    unexpectedRequests.push(`${request.method()} ${pathname}`);
    return respond(404, { error: { code: 'NOT_FOUND', message: 'Unexpected renderer request.',
      retryable: false, retryAfterMs: null, details: {} } });
  });
  await page.goto(new URL('/welcome', url).href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__OVERSTRIKE_SHELL__?.enterGame);
  await page.waitForFunction(() => window.__OVERSTRIKE_SHELL__.getState().session?.authenticated === true);
  const shellGate = await page.evaluate(() => window.__OVERSTRIKE_SHELL__.getState().capabilities);
  check(shellGate.supported === true, 'browser satisfies the production runtime capability gate', JSON.stringify(shellGate));
  const entered = await page.evaluate(async () => {
    const result = await window.__OVERSTRIKE_SHELL__.enterGame({
      localPractice: true, matchId: 'mapperf-local', mode: 'tdm', seed: 20260820,
    });
    return Boolean(result);
  });
  const entryState = await page.evaluate(() => ({
    entered: Boolean(window.__GAME__), shell: window.__OVERSTRIKE_SHELL__.getState(),
    runtime: document.getElementById('shell-root')?.dataset.runtime,
    shellError: (() => { const error = window.__OVERSTRIKE_SHELL__.getState().view?.error;
      return error ? Object.fromEntries(Object.getOwnPropertyNames(error).map((key) => [key, error[key]])) : null; })(),
  }));
  check(entered && entryState.entered && entryState.shell.runtimeLoaded === true
    && entryState.runtime === 'active' && entryState.shell.view.variant !== 'error',
  'production shell enters the lazily loaded game runtime in an expected state', JSON.stringify(entryState));
  if (!entered) throw new Error(`runtime entry failed: ${JSON.stringify(entryState.shell.view)}`);
  await page.waitForFunction(() => window.__GAME__?.state === 'playing');
  await page.waitForLoadState('networkidle');
  sampling = true;
  await page.evaluate(() => {
    const game = window.__GAME__;
    game.input?.exitLock?.();
    game.settings.set('renderScale', 1);
  });

  async function measure(frames = 120) {
    return page.evaluate(async (count) => {
      const game = window.__GAME__;
      const rows = [];
      const sceneCounts = () => {
        const materials = new Set();
        let lights = 0;
        game.scene.traverse((object) => {
          let visible = true;
          for (let node = object; node; node = node.parent) {
            if (node.visible === false) { visible = false; break; }
          }
          if (object.isLight && visible && (object.intensity ?? 1) > 0) lights++;
          if (!(object.isMesh || object.isInstancedMesh) || !visible) return;
          const list = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of list) if (material?.visible !== false) materials.add(material.uuid);
        });
        return { materials: materials.size, lights };
      };
      for (let i = 0; i < count; i++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const counts = sceneCounts();
        rows.push({
          drawCalls: game.engine.stats.drawCalls,
          triangles: game.engine.stats.triangles,
          materials: counts.materials,
          lights: counts.lights,
        });
      }
      return rows;
    }, frames);
  }

  await page.evaluate(() => {
    const game = window.__GAME__;
    window.__MAPPERF_VIS__ = [];
    for (const child of game.scene.children) {
      const keep = child === game.world.group || child === game.camera || child === game.engine.sky
        || child.isLight || child === game.engine.sun?.target;
      if (!keep && child.visible !== false) {
        window.__MAPPERF_VIS__.push(child);
        child.visible = false;
      }
    }
  });
  const mapRows = await measure(60);
  const mapOnly = Object.fromEntries(Object.keys(MAP_LIMITS).map((key) => [key, p95(mapRows, key)]));
  for (const [key, limit] of Object.entries(MAP_LIMITS)) {
    check(mapOnly[key] <= limit, `map-only measured p95 ${key} stays inside budget`, `${mapOnly[key]} ≤ ${limit}`);
  }
  await page.evaluate(() => {
    for (const child of window.__MAPPERF_VIS__ || []) child.visible = true;
    delete window.__MAPPERF_VIS__;
  });
  const integratedRows = await measure(120);
  const integrated = Object.fromEntries(Object.keys(MAP_LIMITS)
    .map((key) => [key, p95(integratedRows, key)]));
  for (const [key, limit] of Object.entries(INTEGRATED_LIMITS)) {
    check(integrated[key] <= limit, `integrated measured p95 ${key} stays inside reference budget`, `${integrated[key]} ≤ ${limit}`);
  }

  // Deliberately corrupt the real render graph: many independent visible draws/materials and
  // lights. The same sampler and thresholds must reject this control or the gate is decorative.
  await page.evaluate(() => {
    const game = window.__GAME__;
    let source = null;
    game.world.group.traverse((object) => {
      if (!source && object.isMesh && object.geometry && object.material) source = object;
    });
    if (!source) throw new Error('no real Square mesh available for the failing control');
    const group = source.parent.clone(false);
    group.name = 'mapperf-failing-control';
    game.scene.add(group);
    for (let i = 0; i < 150; i++) {
      const mesh = source.clone(false);
      mesh.geometry = source.geometry;
      mesh.material = source.material.clone();
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = true;
      mesh.position.copy(game.camera.position);
      mesh.position.z -= 2 + i * 0.001;
      mesh.scale.setScalar(0.001);
      group.add(mesh);
    }
    const Light = game.engine.sun.constructor;
    for (let i = 0; i < 7; i++) {
      const light = new Light(0xffffff, 0.01);
      light.position.copy(game.camera.position);
      group.add(light);
    }
  });
  const corruptRows = await measure(30);
  const corrupt = Object.fromEntries(Object.keys(MAP_LIMITS).map((key) => [key, p95(corruptRows, key)]));
  const rejected = Object.keys(MAP_LIMITS).filter((key) => corrupt[key] > MAP_LIMITS[key]);
  check(rejected.includes('drawCalls') && rejected.includes('materials') && rejected.includes('lights'),
    'real failing mutation breaches draw/material/light measurements', JSON.stringify(corrupt));
  await page.waitForLoadState('networkidle');
  check(pageErrors.length === 0, 'browser measurement produced no page errors', pageErrors.join(' | '));
  check(consoleErrors.length === 0, 'browser measurement produced no console errors', consoleErrors.join(' | '));
  check(requestFailures.length === 0, 'browser measurement produced no failed requests', requestFailures.join(' | '));
  check(httpErrors.length === 0, 'browser measurement produced no HTTP errors', httpErrors.join(' | '));
  check(unexpectedRequests.length === 0, 'browser measurement stayed inside its closed platform fixture', unexpectedRequests.join(' | '));

  console.log(`\nSquare renderer measurement: ${failures ? 'FAIL' : 'PASS'} — ${checks} checks, map-only p95 ${JSON.stringify(mapOnly)}, integrated p95 ${JSON.stringify(integrated)}`);
} finally {
  await browser?.close();
  await server?.close();
}
process.exit(failures ? 1 : 0);
