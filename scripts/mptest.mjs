/**
 * Two browsers, one match.
 *
 * The plan's final verification, and the first thing in this whole conversion that is
 * actually playable: two real Chromium pages, each running the real client build, joined
 * to one real dedicated server over real WebSockets, seeing each other move.
 *
 * Everything upstream of this is proven in Node, which is faster and more reliable and
 * misses one specific class of thing: that the netcode works from inside a browser, on
 * the page's own module graph, against a server in another process.
 *
 *   node scripts/mptest.mjs [--latency=0]
 */
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GS_PORT = 8177;

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\ntwo browsers, one dedicated server');

// ── the server ───────────────────────────────────────────────────────────────────────
const gs = spawn(process.execPath, [path.join(ROOT, 'server/index.js'), `--port=${GS_PORT}`, '--bots=2'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
});
let gsLog = '';
gs.stdout.on('data', (d) => { gsLog += d; });
gs.stderr.on('data', (d) => { gsLog += d; });

let up = false;
for (let i = 0; i < 120 && !up; i++) {
  await sleep(200);
  try { up = (await fetch(`http://127.0.0.1:${GS_PORT}/health`)).ok; } catch { /* not yet */ }
}
if (!up) { bad('the game server starts', gsLog.slice(-800)); gs.kill('SIGKILL'); process.exit(1); }
ok('the dedicated server is up and simulating');

// ── the client build ─────────────────────────────────────────────────────────────────
const vite = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5223, strictPort: false, hmr: false, watch: null }, logLevel: 'error',
});
await vite.listen();
const url = vite.resolvedUrls.local[0];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});

/**
 * Open a page, boot the game, and join the server from inside the browser.
 *
 * The session is driven manually rather than hooked into the render loop: this is
 * verifying the netcode from a browser, and a render loop under SwiftShader runs at
 * ~10 fps, which would make the test measure the software rasteriser instead.
 */
async function openClient(label) {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__GAME__ && window.__BOOTPROF__?.menu > 0, null, { timeout: 240000 });

  const joined = await page.evaluate(async (gsUrl) => {
    const g = window.__GAME__;
    g.stop();                                  // no render loop; this test drives the sim
    g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 1234 });
    g.match.phase = 'live'; g.match.countdown = 0;

    const { MultiplayerSession } = await import('/src/net/session.js');
    try {
      const session = await MultiplayerSession.connect(g, gsUrl);
      window.__SESSION__ = session;
      return { ok: true, entityId: session.net.entityId, clientId: session.net.clientId };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, `ws://127.0.0.1:${GS_PORT}`);

  return { page, errors, joined, label };
}

const A = await openClient('A');
const B = await openClient('B');

if (A.joined.ok && B.joined.ok) ok(`both pages joined (entities ${A.joined.entityId} and ${B.joined.entityId})`);
else bad('both pages join the server', `A: ${A.joined.error ?? 'ok'} | B: ${B.joined.error ?? 'ok'}`);

if (A.joined.entityId && B.joined.entityId && A.joined.entityId !== B.joined.entityId) {
  ok('the two pages were given different entities');
} else {
  bad('the pages get different entities', `${A.joined.entityId} vs ${B.joined.entityId}`);
}

/** Drive one page's session for `ticks` fixed steps. */
const drive = (client, ticks, moving) => client.page.evaluate(async ({ ticks: n, moving: mv }) => {
  const s = window.__SESSION__;
  const mk = () => ({
    wishForward: 0, wishRight: 0, jump: false, crouchPressed: false, reload: false,
    melee: false, grenade: false, interact: false, inspect: false, killstreak: false,
    lastWeapon: false, sprintDown: false, sprintUp: false, firePressed: false,
    aimButtonPressed: false, crouchHeld: false, toggleAdsMode: false,
    aimButtonHeld: false, fireHeld: false, sprintKeyHeld: false, breathHold: false,
    leanKeyHeld: false, leanRightKeyHeld: false, slot: -1, wheel: 0,
    deltaYaw: 0, deltaPitch: 0, baseYaw: 0, basePitch: 0, tick: 0,
  });
  for (let i = 0; i < n; i++) {
    const cmd = mk();
    if (mv) { cmd.wishForward = 1; cmd.deltaYaw = 0.02; }
    s.sendCommand(cmd);
    s.updateRemotes();
    await new Promise((r) => setTimeout(r, 11));
  }
  const remotes = [...s.remotes.values()].map((r) => ({ id: r.id, x: r.x, y: r.y, z: r.z, alive: r.alive }));
  return {
    entityId: s.net.entityId,
    self: { x: window.__GAME__.player.position.x, y: window.__GAME__.player.position.y, z: window.__GAME__.player.position.z },
    remotes,
    snapshots: s.net.stats.snapshots,
    corrections: s.prediction?.stats.corrections ?? -1,
    worstLiving: s.prediction?.stats.worstErrorLiving ?? -1,
  };
}, { ticks, moving });

// Warm up so both sides have a snapshot buffer before anything is measured.
await Promise.all([drive(A, 40, false), drive(B, 40, false)]);
const before = await Promise.all([drive(A, 5, false), drive(B, 5, false)]);
const aSeenByBStart = before[1].remotes.find((r) => r.id === A.joined.entityId);

// A walks, B stands still.
const [aRes, bRes] = await Promise.all([drive(A, 260, true), drive(B, 260, false)]);

if (aRes.snapshots > 20 && bRes.snapshots > 20) ok(`both pages received snapshots (${aRes.snapshots} / ${bRes.snapshots})`);
else bad('both pages receive snapshots', `${aRes.snapshots} / ${bRes.snapshots}`);

const aSeenByBEnd = bRes.remotes.find((r) => r.id === A.joined.entityId);
if (aSeenByBStart && aSeenByBEnd) {
  const seen = Math.hypot(aSeenByBEnd.x - aSeenByBStart.x, aSeenByBEnd.z - aSeenByBStart.z);
  if (seen > 1.5) ok(`page B watched page A move ${seen.toFixed(2)} m`);
  else bad('each page sees the other move', `B saw A move only ${seen.toFixed(3)} m`);
} else {
  bad('page B can see page A', `start=${!!aSeenByBStart} end=${!!aSeenByBEnd}`);
}

if (aRes.remotes.some((r) => r.id === B.joined.entityId)) ok('page A can see page B');
else bad('page A can see page B', `A's remotes: ${aRes.remotes.map((r) => r.id).join(',') || 'none'}`);

// A's own predicted position must agree with where B is told A is. This is the property
// that says prediction and authority have not quietly parted company IN A BROWSER.
if (aSeenByBEnd) {
  const d = Math.hypot(aRes.self.x - aSeenByBEnd.x, aRes.self.z - aSeenByBEnd.z);
  // B sees A through the interpolation delay, so a gap of roughly one delay's travel is
  // correct rather than a fault. It must be bounded, not zero.
  if (d < 3) ok(`A's predicted position is within ${d.toFixed(2)} m of what B is shown (interpolation delay)`);
  else bad("A's prediction tracks the authority", `${d.toFixed(2)} m from what B sees`);
}

if (aRes.worstLiving >= 0 && aRes.worstLiving < 1) ok(`worst live reconciliation error in-browser: ${aRes.worstLiving.toFixed(3)} m`);
else if (aRes.worstLiving >= 1) bad('in-browser reconciliation stays tight', `worst ${aRes.worstLiving.toFixed(2)} m`);

const health = await (await fetch(`http://127.0.0.1:${GS_PORT}/health`)).json();
if (health.clients === 2) ok('the server sees exactly two clients');
else bad('the server sees both clients', `clients=${health.clients}`);
const drops = (health.sessions ?? []).reduce((a, s) => a + s.dropped, 0);
if (drops === 0) ok('no commands were dropped for either client');
else bad('no commands dropped', `${drops} dropped across sessions`);

const pageErrors = [...A.errors, ...B.errors].filter((e) => !/WebGL|SwiftShader|KHR_parallel|GL Driver/i.test(e));
if (pageErrors.length === 0) ok('neither page logged an error');
else bad('the pages log no errors', pageErrors.slice(0, 4).join('\n       '));

await browser.close();
await vite.close();
gs.kill('SIGTERM');
await sleep(400);
gs.kill('SIGKILL');

console.log(failures ? `\n${failures} FAILED` : '\ntwo browsers played one match');
process.exit(failures ? 1 : 0);
