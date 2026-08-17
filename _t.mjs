/** Multi-seed aggression: the same measurement as scripts/aggression.mjs, but
 *  repeated over N seeds per difficulty so the gradient can be read through the
 *  seed noise. */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';

const REPS = Number(process.argv.find((a) => a.startsWith('--reps='))?.split('=')[1] ?? 4);
const ROOT = 'C:/Users/Jamie/Desktop/Code Projects/overstrike';
const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5233, strictPort: false }, logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.setDefaultTimeout(300000);
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.addInitScript(() => {
  try {
    const KEY = 'overstrike.settings.v1';
    const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
    localStorage.setItem(KEY, JSON.stringify({ ...cur, renderScale: 0.4 }));
  } catch { /* ignore */ }
});
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 300000, polling: 250 });

const table = [];
for (const difficulty of ['recruit', 'regular', 'hardened', 'veteran']) {
  const runs = [];
  for (let rep = 0; rep < REPS; rep++) {
    const seed = 1000 + rep * 7919;
    let r;
    try {
      // Another agent editing a file triggers a vite HMR reload mid-run; wait
      // for the game to come back rather than reporting a bogus zero.
      await page.waitForFunction(() => !!window.__GAME__ && window.__GAME__.player,
        null, { timeout: 300000, polling: 250 });
      r = await page.evaluate(async ({ difficulty, seed }) => {
        const g = window.__GAME__;
        const V = g.player.position.constructor;
        const sim = (n) => { for (let i = 0; i < n; i++) g._fixedUpdate(1 / 120); };
        g.returnToMenu();
        g.startMatch({ mode: 'tdm', botCount: 7, difficulty, seed });
        sim(480);
        const p = g.player;
        p.alive = true; p.health = p.maxHealth;
        const a = new V(), b = new V();
        let best = null, bestScore = -1;
        for (const sp of g.world.spawnPoints) {
          let open = 0;
          for (let i = 0; i < 12; i++) {
            const yaw = (i / 12) * Math.PI * 2;
            a.set(sp.position.x, sp.position.y + 1.4, sp.position.z);
            b.set(-Math.sin(yaw), 0, -Math.cos(yaw));
            const hit = g.world.raycast(a, b, 60);
            open += hit ? hit.distance : 60;
          }
          if (open > bestScore) { bestScore = open; best = sp; }
        }
        p.position.set(best.position.x, best.position.y, best.position.z);
        p.velocity.set(0, 0, 0);

        const enemies = g.bots.bots.filter((x) => x.team !== p.team);
        let dmg = 0, hits = 0, eShots = 0, firstShot = null;
        const t0 = g.time;
        const offShot = g.bus.on('shot', (e) => {
          if (!enemies.includes(e.shooter)) return;
          eShots++;
          if (firstShot === null) firstShot = g.time - t0;
        });
        const offDmg = g.bus.on('damage', (e) => {
          if (e.target === p && e.attacker !== p) { hits++; dmg += e.amount || 0; }
        });
        let sLos = 0, sN = 0, distSum = 0, sAlive = 0;
        const eye = new V(), pe = new V();
        for (let i = 0; i < 120 * 20; i++) {
          g._fixedUpdate(1 / 120);
          if (i % 12 === 0) {
            if (p.alive) { p.velocity.set(0, 0, 0); p.health = p.maxHealth; }
            else { p.alive = true; p.health = p.maxHealth; p.position.set(best.position.x, best.position.y, best.position.z); }
            p.getEyePosition(pe);
            for (const e of enemies) {
              sN++;
              if (!e.alive) continue;
              sAlive++;
              e.getEyePosition(eye);
              if (g.world.losClear(eye, pe)) sLos++;
              distSum += e.position.distanceTo(p.position);
            }
          }
        }
        offShot(); offDmg();
        return {
          dmg: Math.round(dmg), hits, eShots,
          firstShot: firstShot === null ? null : +firstShot.toFixed(1),
          pctLos: +(100 * sLos / sN).toFixed(1),
          avgDist: +(distSum / Math.max(1, sAlive)).toFixed(1),
          weapons: enemies.map((e) => e.weapon?.def?.id?.slice(0, 9)).join(' '),
        };
      }, { difficulty, seed });
    } catch (e) { r = { err: String(e).slice(0, 200) }; }
    runs.push(r);
    console.error(`${difficulty} seed${seed}: ${JSON.stringify(r)}`);
  }
  const ok = runs.filter((r) => !r.err);
  const mean = (k) => +(ok.reduce((s, r) => s + (r[k] ?? 0), 0) / Math.max(1, ok.length)).toFixed(1);
  table.push({
    difficulty, n: ok.length, dps: +(mean('dmg') / 20).toFixed(1), dmg: mean('dmg'),
    hits: mean('hits'), eShots: mean('eShots'), pctLos: mean('pctLos'), avgDist: mean('avgDist'),
    dmgRuns: ok.map((r) => r.dmg).join('/'),
  });
}
console.error('\n== MEAN OVER SEEDS ==');
for (const t of table) console.error(JSON.stringify(t));
await browser.close();
await server.close();
