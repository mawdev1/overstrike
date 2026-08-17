/** Where do bot bullets actually go? Measure aim error, LOS and what they hit. */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5205, strictPort: false }, logLevel: 'error',
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
  g.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'veteran' });
  for (let i = 0; i < 600; i++) g._fixedUpdate(1 / 120);

  const p = g.player;
  const pts = g.world.spawnPoints;
  const a = new V(), b = new V();
  const foe = g.bots.bots.find((x) => x.alive && x.team !== p.team);

  // Put the player and one enemy on a pair with full-body mutual LOS.
  let d = 0;
  outer:
  for (let i = 0; i < pts.length; i++) for (let j = 0; j < pts.length; j++) {
    if (i === j) continue;
    const A = pts[i].position, B = pts[j].position;
    const dd = Math.hypot(A.x - B.x, A.z - B.z);
    if (dd < 9 || dd > 20) continue;
    let clear = true;
    for (const h of [1.62, 1.25, 1.0]) {
      a.set(A.x, A.y + h, A.z); b.set(B.x, B.y + h, B.z);
      if (!g.world.losClear(a, b)) { clear = false; break; }
    }
    if (!clear) continue;
    p.position.set(A.x, A.y, A.z); p.velocity.set(0, 0, 0);
    foe.position.set(B.x, B.y, B.z); foe.velocity.set(0, 0, 0);
    d = dd; break outer;
  }
  R.distance = +d.toFixed(1);

  const shots = [];
  const trueDir = new V(), eye = new V(), pe = new V();
  let hitsOnPlayer = 0, anyHits = 0;
  const offHit = g.bus.on('hit', (e) => {
    anyHits++;
    if (e.target === p) hitsOnPlayer++;
  });
  const offShot = g.bus.on('shot', (e) => {
    if (e.shooter === p || shots.length >= 40) return;
    const s = e.shooter;
    s.getEyePosition(eye);
    p.getEyePosition(pe);
    // true direction from shooter eye to player centre-of-mass
    trueDir.set(p.position.x - eye.x, (p.position.y + 1.0) - eye.y, p.position.z - eye.z).normalize();
    const dir = e.dir ? new V(e.dir.x, e.dir.y, e.dir.z) : new V(0, 0, 0);
    const dot = Math.max(-1, Math.min(1, dir.dot(trueDir)));
    const angErr = Math.acos(dot) * 180 / Math.PI;
    const dist = eye.distanceTo(pe);
    // Does the shot line reach the player at all?
    const wr = g.world.raycast(eye, dir, 100);
    shots.push({
      shooter: s.name,
      dist: +dist.toFixed(1),
      aimErrDeg: +angErr.toFixed(2),
      missByM: +(Math.tan(angErr * Math.PI / 180) * dist).toFixed(2),
      wallAt: wr ? +wr.distance.toFixed(1) : null,
      losClearToPlayer: g.world.losClear(eye, pe),
      state: s.state ?? null,
      pitchDeg: +((s.pitch || 0) * 180 / Math.PI).toFixed(1),
    });
  });

  const hp0 = p.health;
  for (let i = 0; i < 120 * 20; i++) {
    g._fixedUpdate(1 / 120);
    if (i % 60 === 0) { p.velocity.set(0, 0, 0); if (!p.alive) { p.alive = true; p.health = 100; } }
  }
  offShot(); offHit();

  R.shotSample = shots.slice(0, 18);
  R.totalSampled = shots.length;
  R.hitsOnPlayer = hitsOnPlayer;
  R.anyHitEvents = anyHits;
  R.playerHp = p.health;
  R.playerHpDrop = hp0 - p.health;
  if (shots.length) {
    const errs = shots.map((s) => s.aimErrDeg).sort((x, y) => x - y);
    R.aimErrMedianDeg = errs[Math.floor(errs.length / 2)];
    R.aimErrMinDeg = errs[0];
    R.aimErrMaxDeg = errs[errs.length - 1];
    R.fracWithLos = +(shots.filter((s) => s.losClearToPlayer).length / shots.length).toFixed(2);
    const misses = shots.map((s) => s.missByM).sort((x, y) => x - y);
    R.missByMedianM = misses[Math.floor(misses.length / 2)];
  }
  return R;
});

console.log(JSON.stringify(out, null, 1));
if (logs.length) { console.log('\nconsole errors:'); for (const l of [...new Set(logs)].slice(0, 15)) console.log('  ' + l); }
await browser.close();
await server.close();
