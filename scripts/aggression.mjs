/**
 * Measures how aggressive the bots actually are, per difficulty.
 *
 * The player is parked in the open on a spawn point with verified full-body sightlines,
 * then left alone for a fixed window while the enemy team is free to manoeuvre. We count
 * incoming shots, distinct shooters, hits and damage, and sample the enemy state machine.
 *
 * This is the instrument to tune AI aggression against — "bots feel passive" is not
 * actionable, "only 1 of 4 enemies ever engaged in 20 s" is.
 *
 * Usage: node scripts/aggression.mjs [--seconds=20] [--bots=7]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? Number(hit.split('=')[1]) : d;
};
const SECONDS = arg('seconds', 20);
const BOTS = arg('bots', 7);

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5207, strictPort: false }, logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.setDefaultTimeout(180000);
await page.addInitScript(() => {
  try {
    const KEY = 'overstrike.settings.v1';
    const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
    localStorage.setItem(KEY, JSON.stringify({ ...cur, renderScale: 0.4 }));
  } catch { /* ignore */ }
});
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 180000, polling: 250 });

const rows = [];
for (const difficulty of ['recruit', 'regular', 'hardened', 'veteran']) {
  const r = await page.evaluate(async ({ difficulty, SECONDS, BOTS }) => {
    const g = window.__GAME__;
    const V = g.player.position.constructor;
    const sim = (n) => { for (let i = 0; i < n; i++) g._fixedUpdate(1 / 120); };

    g.returnToMenu();
    g.startMatch({ mode: 'tdm', botCount: BOTS, difficulty });
    sim(480); // clear the pre-round countdown and let bots disperse

    const p = g.player;
    p.alive = true; p.health = p.maxHealth;

    // Park the player on the spawn point with the most open, longest sightlines —
    // the most exposed position on the map, so passivity cannot be blamed on cover.
    const pts = g.world.spawnPoints;
    const a = new V(), b = new V();
    let best = null, bestScore = -1;
    for (const sp of pts) {
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

    let shots = 0, hits = 0, dmg = 0;
    const shooters = new Set();
    let firstShotAt = null;
    const t0 = g.time;
    const offShot = g.bus.on('shot', (e) => {
      if (e.shooter === p) return;
      shots++; shooters.add(e.shooter?.id);
      if (firstShotAt === null) firstShotAt = g.time - t0;
    });
    const offDmg = g.bus.on('damage', (e) => {
      if (e.target === p && e.attacker !== p) { hits++; dmg += e.amount || 0; }
    });

    const states = {};
    let sawPlayer = 0;
    const enemies = g.bots.bots.filter((x) => x.team !== p.team);
    const steps = 120 * SECONDS;
    for (let i = 0; i < steps; i++) {
      g._fixedUpdate(1 / 120);
      if (i % 60 === 0) {
        if (p.alive) { p.velocity.set(0, 0, 0); p.health = p.maxHealth; }
        else { p.alive = true; p.health = p.maxHealth; p.position.set(best.position.x, best.position.y, best.position.z); }
        for (const e of enemies) {
          const s = e.state ?? 'null';
          states[s] = (states[s] || 0) + 1;
          if (e.target === p || e.enemy === p) sawPlayer++;
        }
      }
    }
    offShot(); offDmg();

    return {
      difficulty,
      enemies: enemies.length,
      shots,
      distinctShooters: shooters.size,
      hits,
      damage: Math.round(dmg),
      firstShotAfter: firstShotAt === null ? null : +firstShotAt.toFixed(1),
      dps: +(dmg / SECONDS).toFixed(1),
      states,
      acquiredSamples: sawPlayer,
    };
  }, { difficulty, SECONDS, BOTS });
  rows.push(r);
  console.log(`[aggression] ${difficulty}: ${r.shots} shots / ${r.distinctShooters} of ${r.enemies} enemies, ` +
    `${r.hits} hits, ${r.damage} dmg (${r.dps}/s), first shot @${r.firstShotAfter}s`);
}

console.log('\n=============== AGGRESSION BY DIFFICULTY ===============');
console.log('diff       shots  shooters  hits   dmg   dmg/s  1st-shot');
for (const r of rows) {
  console.log(
    `${r.difficulty.padEnd(10)} ${String(r.shots).padStart(5)}  ${String(r.distinctShooters + '/' + r.enemies).padStart(8)}` +
    `  ${String(r.hits).padStart(4)}  ${String(r.damage).padStart(4)}  ${String(r.dps).padStart(5)}  ${String(r.firstShotAfter ?? '—').padStart(7)}`);
}
console.log('\nenemy state occupancy (samples):');
for (const r of rows) console.log(`  ${r.difficulty.padEnd(10)} ${JSON.stringify(r.states)}`);
if (errs.length) console.log('\npage errors:', [...new Set(errs)].slice(0, 5));
console.log('========================================================\n');

await browser.close();
await server.close();
