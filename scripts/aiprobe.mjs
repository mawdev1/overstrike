/**
 * AI aggression / difficulty probe.
 *
 * Measures, per difficulty, with the player standing in the open at a verified
 * mutual-LOS distance and never firing back:
 *   • shots fired by the enemy team, and how many DISTINCT bots fired
 *   • hits and damage landed on the player
 *   • average time-to-first-shot after a bot gains line of sight
 *   • the enemy state histogram (how much time is spent stalled in cover)
 *   • time-to-kill the player (lethality), measured separately
 *   • AI cost in ms per fixed step
 *
 * Deterministic: every run uses the same seed, so before/after numbers compare.
 *
 * Usage: node scripts/aiprobe.mjs [--seconds=25] [--bots=9] [--seed=1337]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2)
  .map((a) => a.replace(/^--/, '').split('='))
  .map(([k, v]) => [k, v === undefined ? true : v]));
const SECONDS = Number(args.seconds ?? 25);
const BOTS = Number(args.bots ?? 9);
const SEED = Number(args.seed ?? 1337);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 120000, polling: 200 });

const out = await page.evaluate(async ({ SECONDS, BOTS, SEED }) => {
  const g = window.__GAME__;
  const V = g.player.position.constructor;
  const p = g.player;
  const a = new V(), b = new V();
  const results = {};

  /** Two spawn points with full-body mutual LOS in [minD,maxD]. */
  const stagePair = (e1, e2, minD, maxD) => {
    const pts = g.world.spawnPoints;
    for (let i = 0; i < pts.length; i++) {
      for (let j = 0; j < pts.length; j++) {
        if (i === j) continue;
        const A = pts[i].position, B = pts[j].position;
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        if (d < minD || d > maxD) continue;
        let clear = true;
        for (const h of [1.62, 1.25, 1.0]) {
          a.set(A.x, A.y + h, A.z); b.set(B.x, B.y + h, B.z);
          if (!g.world.losClear(a, b)) { clear = false; break; }
        }
        if (!clear) continue;
        e1.position.set(A.x, A.y, A.z); e1.velocity.set(0, 0, 0);
        e2.position.set(B.x, B.y, B.z); e2.velocity.set(0, 0, 0);
        return { d: +d.toFixed(1), A, B };
      }
    }
    return null;
  };

  const revive = (staged) => {
    p.alive = true;
    p.health = p.maxHealth;
    if (staged) p.position.set(staged.A.x, staged.A.y, staged.A.z);
    p.velocity.set(0, 0, 0);
    g.match?.clearProtection?.(p);
  };

  for (const difficulty of ['recruit', 'regular', 'hardened', 'veteran']) {
    g.startMatch({ mode: 'tdm', botCount: BOTS, difficulty, seed: SEED });
    for (let i = 0; i < 600; i++) g._fixedUpdate(1 / 120);

    const foe = g.bots.bots.find((x) => x.alive && x.team !== p.team);
    const staged = stagePair(p, foe, 10, 20);
    revive(staged);
    // Point the staged bot at the player so at least one has an honest start.
    foe.yaw = Math.atan2(-(p.position.x - foe.position.x), -(p.position.z - foe.position.z));

    let shots = 0, hits = 0, damage = 0, deaths = 0;
    const shooters = new Set();
    const states = {};
    const ttfs = [];
    const track = new Map();   // bot.id -> { losStart, fired }

    const offShot = g.bus.on('shot', (e) => {
      const s = e.shooter;
      if (!s || s === p || s.team === p.team) return;
      shots++;
      shooters.add(s.id);
      const st = track.get(s.id);
      if (st && st.losStart !== null && !st.fired) {
        ttfs.push(g.time - st.losStart);
        st.fired = true;
      }
    });
    const offDmg = g.bus.on('damage', (e) => {
      if (e.target === p && e.attacker !== p) { hits++; damage += e.amount; }
    });

    const steps = Math.round(120 * SECONDS);
    for (let i = 0; i < steps; i++) {
      g._fixedUpdate(1 / 120);
      // Per-bot LOS episode tracking (every 4th step is plenty at 120 Hz).
      if (i % 4 === 0) {
        for (const bt of g.bots.bots) {
          if (bt.team === p.team) continue;
          let st = track.get(bt.id);
          if (!st) { st = { losStart: null, fired: false }; track.set(bt.id, st); }
          const vis = !!(bt.alive && bt.targetVisible && bt.target === p);
          if (vis) { if (st.losStart === null) st.losStart = g.time; }
          else { st.losStart = null; st.fired = false; }
        }
      }
      if (i % 30 === 0) {
        for (const bt of g.bots.bots) {
          if (bt.team === p.team || !bt.alive) continue;
          states[bt.state] = (states[bt.state] || 0) + 1;
        }
        if (!p.alive) { deaths++; revive(staged); }
        else p.velocity.set(0, 0, 0);
      }
    }
    offShot(); offDmg();

    // ---- lethality: same staging, but let the player actually die.
    g.startMatch({ mode: 'tdm', botCount: BOTS, difficulty, seed: SEED });
    for (let i = 0; i < 600; i++) g._fixedUpdate(1 / 120);
    const foe2 = g.bots.bots.find((x) => x.alive && x.team !== p.team);
    const staged2 = stagePair(p, foe2, 10, 20);
    revive(staged2);
    foe2.yaw = Math.atan2(-(p.position.x - foe2.position.x), -(p.position.z - foe2.position.z));
    let ttk = -1;
    const t0 = g.time;
    for (let i = 0; i < 120 * 40; i++) {
      g._fixedUpdate(1 / 120);
      if (!p.alive) { ttk = +(g.time - t0).toFixed(2); break; }
      if (i % 30 === 0) p.velocity.set(0, 0, 0);
    }

    const totalStates = Object.values(states).reduce((x, y) => x + y, 0) || 1;
    const pct = {};
    for (const k of Object.keys(states)) pct[k] = +(states[k] / totalStates * 100).toFixed(0);

    results[difficulty] = {
      distance: staged ? staged.d : 0,
      shots,
      distinctShooters: shooters.size,
      liveEnemies: g.bots.bots.filter((x) => x.team !== p.team).length,
      hitsOnPlayer: hits,
      damageOnPlayer: +damage.toFixed(0),
      dpsOnPlayer: +(damage / SECONDS).toFixed(1),
      playerDeaths: deaths,
      avgTimeToFirstShot: ttfs.length ? +(ttfs.reduce((x, y) => x + y, 0) / ttfs.length).toFixed(2) : null,
      medianTimeToFirstShot: ttfs.length
        ? +ttfs.slice().sort((x, y) => x - y)[Math.floor(ttfs.length / 2)].toFixed(2) : null,
      losEpisodes: ttfs.length,
      timeToKillPlayer: ttk,
      statePct: pct,
    };
  }

  // ---- cost: 12 bots, veteran, measured over 600 fixed steps
  g.startMatch({ mode: 'tdm', botCount: 12, difficulty: 'veteran', seed: SEED });
  for (let i = 0; i < 300; i++) g._fixedUpdate(1 / 120);
  const wasDebug = g.debug;
  g.debug = true;
  let t = performance.now();
  for (let i = 0; i < 600; i++) g.bots.fixedUpdate(1 / 120);
  const aiMs = (performance.now() - t) / 600;
  t = performance.now();
  for (let i = 0; i < 600; i++) g._fixedUpdate(1 / 120);
  const simMs = (performance.now() - t) / 600;
  g.debug = wasDebug;
  results._cost = {
    bots: 12,
    aiMsPerFixedStep: +aiMs.toFixed(4),
    fullSimMsPerFixedStep: +simMs.toFixed(4),
    navBakeMs: +(g.nav?.stats?.bakeMs ?? 0).toFixed(1),
  };
  return results;
}, { SECONDS, BOTS, SEED });

console.log('\n================= AI AGGRESSION PROBE =================');
console.log(`seed=${SEED} bots=${BOTS} window=${SECONDS}s`);
const cols = ['shots', 'distinctShooters', 'hitsOnPlayer', 'damageOnPlayer', 'dpsOnPlayer',
  'avgTimeToFirstShot', 'timeToKillPlayer', 'playerDeaths'];
for (const d of ['recruit', 'regular', 'hardened', 'veteran']) {
  const r = out[d];
  console.log(`\n  ${d.toUpperCase()}  (staged at ${r.distance} m)`);
  for (const c of cols) console.log(`    ${c.padEnd(22)} ${r[c]}`);
  console.log(`    state %                ${JSON.stringify(r.statePct)}`);
}
console.log('\n  COST', JSON.stringify(out._cost));
console.log('\njson:', JSON.stringify(out));
if (logs.length) { console.log('\nconsole errors:'); for (const l of [...new Set(logs)].slice(0, 15)) console.log('  ' + l); }
console.log('=======================================================\n');

await browser.close();
await server.close();
