/** Wedge check + AI-only per-step cost. */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';

const ROOT = 'C:/Users/Jamie/Desktop/Code Projects/overstrike';
const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5241, strictPort: false }, logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
page.setDefaultTimeout(300000);
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.addInitScript(() => {
  try {
    const KEY = 'overstrike.settings.v1';
    const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
    localStorage.setItem(KEY, JSON.stringify({ ...cur, renderScale: 0.35 }));
  } catch { /* ignore */ }
});
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 300000, polling: 250 });

const wedge = await page.evaluate(async () => {
  const g = window.__GAME__;
  const V = g.player.position.constructor;
  g.returnToMenu();
  g.startMatch({ mode: 'tdm', botCount: 12, difficulty: 'veteran', seed: 4242 });
  for (let i = 0; i < 240; i++) g._fixedUpdate(1 / 120);

  const bots = g.bots.bots;
  const last = bots.map((b) => new V().copy(b.position));
  const stall = bots.map(() => 0);
  const worst = bots.map(() => 0);
  const outOfBounds = [];
  const bmin = g.world.bounds.min, bmax = g.world.bounds.max;
  const stateSeen = {};
  const personaSeen = {};
  let samples = 0;

  // 90 s of live play, sampling every 0.5 s.
  for (let i = 0; i < 120 * 90; i++) {
    g._fixedUpdate(1 / 120);
    if (i % 60 !== 0) continue;
    samples++;
    for (let k = 0; k < bots.length; k++) {
      const b = bots[k];
      if (!b.alive) { stall[k] = 0; last[k].copy(b.position); continue; }
      stateSeen[b.state] = (stateSeen[b.state] || 0) + 1;
      personaSeen[b.personaName] = (personaSeen[b.personaName] || 0) + 1;
      if (!Number.isFinite(b.position.x) || !Number.isFinite(b.position.y) || !Number.isFinite(b.position.z)
        || b.position.y < bmin.y - 5 || b.position.y > bmax.y + 5
        || b.position.x < bmin.x - 5 || b.position.x > bmax.x + 5
        || b.position.z < bmin.z - 5 || b.position.z > bmax.z + 5) {
        outOfBounds.push(`${b.name}@${b.position.x.toFixed(1)},${b.position.y.toFixed(1)},${b.position.z.toFixed(1)}`);
      }
      const moved = b.position.distanceTo(last[k]);
      last[k].copy(b.position);
      // "Wedged" = has somewhere to be, but is not getting there.
      if (b.hasDestination && moved < 0.25) stall[k] += 0.5;
      else stall[k] = 0;
      if (stall[k] > worst[k]) worst[k] = stall[k];
    }
  }
  return {
    bots: bots.length,
    worstStallSeconds: Math.max(...worst),
    stallsOver8s: worst.filter((w) => w > 8).length,
    perBotWorst: worst.map((w) => +w.toFixed(1)).join(','),
    outOfBounds: [...new Set(outOfBounds)].slice(0, 5),
    samples,
    stateSeen,
    personaSeen,
    weapons: bots.map((b) => `${b.personaName}:${b.weapon?.def?.id}`).join(' '),
  };
});
console.error('WEDGE ' + JSON.stringify(wedge, null, 1));

for (const [count, diff] of [[7, 'regular'], [12, 'veteran'], [24, 'veteran']]) {
  const perf = await page.evaluate(async ({ count, diff }) => {
    const g = window.__GAME__;
    g.returnToMenu();
    g.startMatch({ mode: 'tdm', botCount: count, difficulty: diff, seed: 909 });
    for (let i = 0; i < 600; i++) g._fixedUpdate(1 / 120);
    // AI only: BotManager.fixedUpdate in isolation, then the whole sim step.
    let t = performance.now();
    for (let i = 0; i < 1200; i++) g.bots.fixedUpdate(1 / 120);
    const aiMs = (performance.now() - t) / 1200;
    t = performance.now();
    for (let i = 0; i < 1200; i++) g._fixedUpdate(1 / 120);
    const simMs = (performance.now() - t) / 1200;
    return { count, diff, aiMsPerStep: +aiMs.toFixed(4), simMsPerStep: +simMs.toFixed(4) };
  }, { count, diff });
  console.error('PERF ' + JSON.stringify(perf));
}

await browser.close();
await server.close();
