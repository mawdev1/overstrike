/**
 * Does a second match behave like the first?
 *
 * Starts a match, measures bot engagement, then returns to menu, starts another, and
 * measures again — repeatedly. Any divergence is a reset bug.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5208, strictPort: false }, logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.setDefaultTimeout(180000);
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 180000, polling: 250 });

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  const V = g.player.position.constructor;
  const sim = (n) => { for (let i = 0; i < n; i++) g._fixedUpdate(1 / 120); };
  const runs = [];

  const measure = (label) => {
    const p = g.player;
    p.alive = true; p.health = p.maxHealth;

    // Most exposed spawn point.
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

    let shots = 0;
    const off = g.bus.on('shot', (e) => { if (e.shooter !== p) shots++; });
    const enemies = g.bots.bots.filter((x) => x.team !== p.team);
    const states = {};
    let thinks = 0;
    const t0 = g.time;
    for (let i = 0; i < 120 * 15; i++) {
      g._fixedUpdate(1 / 120);
      if (i % 60 === 0) {
        if (p.alive) { p.velocity.set(0, 0, 0); p.health = p.maxHealth; }
        for (const e of enemies) {
          states[e.state ?? 'null'] = (states[e.state ?? 'null'] || 0) + 1;
          if (e._lastThinkTime !== undefined && e._lastThinkTime <= g.time) thinks++;
        }
      }
    }
    off();
    runs.push({
      label, shots, enemies: enemies.length, states,
      gameTimeStart: +t0.toFixed(1), gameTimeEnd: +g.time.toFixed(1),
      botCount: g.bots.bots.length,
      aliveBots: g.bots.bots.filter((x) => x.alive).length,
      sampleBot: (() => {
        const e = enemies[0];
        if (!e) return null;
        return {
          state: e.state, alive: e.alive, hasWeapon: !!e.weapon,
          ammo: e.weapon?.ammo, lastThink: e._lastThinkTime,
          hasTarget: !!(e.target || e.enemy),
        };
      })(),
      matchPhase: g.match?.phase,
      canFireSample: g.match?.canFire?.(enemies[0]),
    });
  };

  g.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'veteran' });
  sim(480);
  measure('match-1-fresh');

  g.returnToMenu();
  g.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'veteran' });
  sim(480);
  measure('match-2-after-returnToMenu');

  g.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'veteran' });
  sim(480);
  measure('match-3-direct-restart');

  return runs;
});

console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('\npage errors:', [...new Set(errs)].slice(0, 8));
await browser.close();
await server.close();
