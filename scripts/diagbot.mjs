/** Why don't bots shoot? Inspect AI state, senses and the weapon path. */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5204, strictPort: false }, logLevel: 'error',
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

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  const R = {};
  const V = g.player.position.constructor;
  const sim = (n) => { for (let i = 0; i < n; i++) g._fixedUpdate(1 / 120); };

  g.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'veteran' });
  sim(600);

  const p = g.player;
  const foe = g.bots.bots.find((b) => b.alive && b.team !== p.team);

  // Stand the player right in front of the bot, in the open, well within vision range.
  const eEye = new V(), pEye = new V();
  let staged = false;
  for (let a = 0; a < 32 && !staged; a++) {
    const ang = (a / 32) * Math.PI * 2;
    const px = foe.position.x + Math.sin(ang) * 9;
    const pz = foe.position.z + Math.cos(ang) * 9;
    const gy = g.world.sampleGroundHeight(px, pz, foe.position.y + 6);
    if (gy == null) continue;
    pEye.set(px, gy + 1.62, pz);
    eEye.set(foe.position.x, foe.position.y + foe.eyeHeight, foe.position.z);
    if (!g.world.losClear(pEye, eEye)) continue;
    p.position.set(px, gy, pz); p.velocity.set(0, 0, 0);
    staged = true;
  }
  R.staged = staged;
  R.distance = +p.position.distanceTo(foe.position).toFixed(2);

  // Point the bot straight at the player so vision cone cannot be the excuse.
  foe.yaw = Math.atan2(-(p.position.x - foe.position.x), -(p.position.z - foe.position.z));

  R.before = {
    state: foe.state ?? foe._state ?? null,
    hasTarget: !!(foe.target ?? foe.enemy),
    weaponState: foe.weapon?.state,
    ammo: foe.weapon?.ammo,
    reserve: foe.weapon?.reserve,
    equipped: foe.weapon?.equipped,
    canFireMatch: g.match?.canFire?.(foe),
    losToPlayer: g.world.losClear(eEye, pEye),
  };

  let botShots = 0;
  const off = g.bus.on('shot', (e) => { if (e.shooter !== p) botShots++; });
  const trace = [];
  for (let i = 0; i < 120 * 8; i++) {
    g._fixedUpdate(1 / 120);
    if (i % 120 === 0) {
      trace.push({
        t: i / 120,
        state: foe.state ?? foe._state ?? null,
        target: (foe.target ?? foe.enemy)?.name ?? (foe.target ?? foe.enemy) ? 'yes' : null,
        canSee: foe.canSeeTarget ?? foe._canSee ?? null,
        wStat: foe.weapon?.state,
        ammo: foe.weapon?.ammo,
        alive: foe.alive,
        dist: +foe.position.distanceTo(p.position).toFixed(1),
      });
    }
  }
  off();
  R.botShots = botShots;
  R.trace = trace;

  // Try firing the bot's weapon directly — does the instance work at all for a bot?
  const w = foe.weapon;
  R.directBotFire = { canFire: w?.canFire?.(), state: w?.state, ammo: w?.ammo };
  let f = 0;
  for (let i = 0; i < 60; i++) { if (w?.tryFire?.()) f++; w?.fixedUpdate?.(1 / 120); }
  R.directBotFireCount = f;
  R.directBotAmmoAfter = w?.ammo;

  // Introspect the bot's public surface so we can see what the state machine calls things.
  R.botKeys = Object.keys(foe).filter((k) => !k.startsWith('_')).slice(0, 60);
  R.botProto = Object.getOwnPropertyNames(Object.getPrototypeOf(foe)).filter((k) => k !== 'constructor');
  R.allBotStates = g.bots.bots.map((b) => ({ n: b.name, team: b.team, s: b.state ?? b._state, alive: b.alive }));
  return R;
});

console.log(JSON.stringify(out, null, 1));
if (logs.length) { console.log('\nconsole errors:'); for (const l of [...new Set(logs)].slice(0, 15)) console.log('  ' + l); }
await browser.close();
await server.close();
