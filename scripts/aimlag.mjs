/**
 * Does the reticle tell the truth while the gun is moving?
 *
 * Screen centre is where the reticle is drawn; the bullet leaves along the current tick's
 * aim. This fires live rounds and, every rendered frame, projects the point the CURRENT
 * aim ray actually hits back through the live camera, reporting the gap in pixels.
 *
 * The reason this exists as its own probe rather than as part of scopeshot.mjs: the
 * gap is only observable on the frames where the aim is genuinely moving, and answering
 * "should the camera interpolate recoil?" needs the same measurement taken twice, once
 * per branch. So samples are split by whether the recoil/sway actually changed this tick
 * (measured directly as `movePx`, not guessed from the trigger cadence), and the whole
 * run is ~1 min rather than scopeshot's ~20.
 *
 * That question has been answered for scoped weapons — see the long comment at the
 * `alpha` assignment in src/player/playerCamera.js, which quotes this probe's numbers.
 * Re-run it before changing that branch.
 *
 * Usage: node scripts/aimlag.mjs [--weapon=sr_reaver] [--frames=260] [--label=name]
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const WEAPON = arg('weapon', 'sr_reaver');
const FRAMES = Number(arg('frames', 260));
const LABEL = arg('label', 'run');

const server = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5213, strictPort: false, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
    '--mute-audio', '--disable-gpu-vsync', '--disable-frame-rate-limit',
  ],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.setDefaultTimeout(180000);
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 180000, polling: 250 });
await page.evaluate(() => window.__GAME__.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'regular' }));
await page.waitForTimeout(2200);

// Same siting logic as scopeshot: the most open sightline on the map, so the aim ray
// reliably hits geometry far enough away that a fraction of a degree is many pixels.
await page.evaluate((weaponId) => {
  const g = window.__GAME__;
  const p = g.player;
  const V = p.position.constructor;
  const eye = new V(), dir = new V();
  let best = null;
  for (const sp of g.world.spawnPoints) {
    for (let i = 0; i < 48; i++) {
      const yaw = (i / 48) * Math.PI * 2;
      eye.set(sp.position.x, sp.position.y + 1.62, sp.position.z);
      dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      const hit = g.world.raycast(eye, dir, 200);
      const open = hit ? hit.distance : 200;
      if (!best || open > best.open) best = { x: sp.position.x, y: sp.position.y, z: sp.position.z, yaw, open };
    }
  }
  p.position.set(best.x, best.y, best.z);
  p.velocity.set(0, 0, 0);
  p.setAngles(best.yaw, -0.02);
  p.camera.reset();
  g.weapons.giveLoadout(p, [weaponId, 'pistol_sidewinder']);
  g.weapons.switchTo(p, 0, true);
  g.input.enabled = true;
  g.input.actions.clear();
  g.input.buttons[0] = g.input.buttons[2] = false;
}, WEAPON);

await page.evaluate(() => { window.__GAME__.input.buttons[2] = true; });   // ADS
await page.waitForTimeout(1400);

const track = await page.evaluate((frames) => new Promise((resolve) => {
  const g = window.__GAME__;
  const V = g.player.position.constructor;
  const eye = new V(), dir = new V(), pt = new V();
  const w = window.innerWidth, h = window.innerHeight;
  let n = 0;
  const all = [], hot = [], cold = [];
  let misses = 0, shots = 0;
  let worst = 0, worstAt = null;
  g.player.weapon.stopFire();
  const tick = () => {
    g.input.enabled = true;
    g.input.buttons[0] = (n > 20 && (n % 40 === 0 || n % 40 === 1));
    if (g.player.weapon) {
      if (g.player.weapon.ammo <= 0) g.player.weapon.ammo = g.player.weapon.def.magSize;
      if (n > 20 && n % 40 === 2) shots++;
    }
    if (!g.player.alive && g.match?.respawn) g.match.respawn(g.player);
    g.player.health = g.player.maxHealth;
    g.player.getEyePosition(eye);
    g.player.getAimDirection(dir);
    const hit = g.world.raycast(eye, dir, 400);
    if (!hit) { misses++; } else {
      pt.copy(hit.point);
      g.camera.updateMatrixWorld();
      pt.project(g.camera);
      const dx = pt.x * w * 0.5, dy = -pt.y * h * 0.5;
      const d = Math.hypot(dx, dy);
      all.push(d);
      // "hot" = the aim is actually MOVING this tick, measured directly rather than
      // guessed from the trigger cadence: interpolation lag is by construction
      // proportional to |cur - prev|, and is exactly zero on a quiet frame where the
      // two endpoints agree. Expressed in the same pixel units as `d` so the two are
      // directly comparable.
      const p = g.player;
      const dYaw = (p.recoilYaw + p.scopeSwayYaw) - (p.prevRecoilYaw + p.prevScopeSwayYaw);
      const dPitch = (p.recoilPitch + p.scopeSwayPitch) - (p.prevRecoilPitch + p.prevScopeSwayPitch);
      const movePx = Math.hypot(dYaw, dPitch) * (180 / Math.PI)
        * ((h * 0.5) / Math.tan(g.camera.fov * 0.5 * Math.PI / 180) * Math.tan(Math.PI / 180));
      (movePx > 0.05 ? hot : cold).push(d);
      if (d > worst) {
        worst = d;
        worstAt = { px: +dx.toFixed(3), py: +dy.toFixed(3), frame: n, phase: n % 40, movePx: +movePx.toFixed(3) };
      }
    }
    if (++n < frames) requestAnimationFrame(tick);
    else {
      const stat = (a) => a.length ? {
        n: a.length,
        mean: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(4),
        max: +Math.max(...a).toFixed(4),
      } : { n: 0 };
      resolve({
        misses, shots, worstAt,
        all: stat(all), hot: stat(hot), cold: stat(cold),
        pxPerDeg: +((h * 0.5) / Math.tan(g.camera.fov * 0.5 * Math.PI / 180) * Math.tan(Math.PI / 180)).toFixed(2),
      });
    }
  };
  requestAnimationFrame(tick);
}), FRAMES);

console.log(`[aimlag:${LABEL}] weapon=${WEAPON} ${JSON.stringify(track)}`);
if (errs.length) console.log(`[aimlag:${LABEL}] page errors: ${errs.join(' | ')}`);

await browser.close();
await server.close();
process.exit(0);
