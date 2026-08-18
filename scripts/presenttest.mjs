/**
 * Presentation port regression test.
 *
 * Phase 1 of the authoritative-server work routed every audio/fx/hud/camera-feel call
 * in simulation code through `game.present` (src/core/presenter.js), so a headless
 * server can install a NullPresenter with no audio/fx/DOM at all, and so reconciliation
 * replay can silence side effects without branching at each call site.
 *
 * Two things must both hold, and neither implies the other:
 *   1. LivePresenter still delivers to the real subsystems (nothing silently dropped).
 *   2. NullPresenter never throws, however it's called (a headless server crashing on
 *      the first gunshot is worse than the bug this port was meant to prevent).
 *
 * Usage: node scripts/presenttest.mjs
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5194, strictPort: false }, logLevel: 'error',
});
await server.listen();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
page.on('pageerror', (e) => bad('page error', e.message));
await page.goto(server.resolvedUrls.local[0], { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(() => window.__GAME__ && window.__BOOTPROF__?.menu > 0, null, { timeout: 180000 });

console.log('\nLivePresenter delivers to the real subsystems');
const live = await page.evaluate(() => {
  const g = window.__GAME__;
  g.stop();
  g.startMatch({ mode: 'tdm', botCount: 6, difficulty: 'regular', seed: 42 });
  g.match.phase = 'live'; g.match.countdown = 0;

  const hit = { play: 0, muzzleFlash: 0, impact: 0, tracer: 0, setAmmo: 0, cameraAddRecoil: 0 };
  const wrap = (obj, name, key) => {
    if (!obj || typeof obj[name] !== 'function') return;
    const orig = obj[name].bind(obj);
    obj[name] = (...a) => { hit[key]++; return orig(...a); };
  };
  wrap(g.audio, 'play', 'play');
  wrap(g.fx, 'muzzleFlash', 'muzzleFlash');
  wrap(g.fx, 'impact', 'impact');
  wrap(g.fx, 'tracer', 'tracer');
  wrap(g.hud, 'setAmmo', 'setAmmo');
  if (g.player.camera) wrap(g.player.camera, 'addRecoil', 'cameraAddRecoil');

  const inp = g.input;
  inp.enabled = true;
  inp.actions.add('forward');
  inp.buttons[0] = true;
  const DT = 1 / 120;
  for (let i = 0; i < 600; i++) g._fixedUpdate(DT);   // 5s — long enough to reload once

  // hitmarker only fires on an actual hit, which a moving-bot scene doesn't guarantee;
  // its call site is structurally identical to impact/tracer above, so a direct call
  // is the honest check — it proves the port method itself reaches hud.
  let hitmarkerOk = false;
  const origHitmarker = g.hud?.hitmarker?.bind(g.hud);
  if (origHitmarker) {
    let called = false;
    g.hud.hitmarker = (...a) => { called = true; return origHitmarker(...a); };
    g.present.hitmarker(true);
    hitmarkerOk = called;
  }

  return { ...hit, hitmarker: hitmarkerOk ? 1 : 0 };
});

for (const [name, count] of Object.entries(live)) {
  if (count > 0) ok(`${name} delivered (${count} call${count === 1 ? '' : 's'})`);
  else bad(`${name} delivered`, 'never called during 5s of driven fire — check the call site still reaches game.present');
}

console.log('\nNullPresenter never throws');
const nullSafe = await page.evaluate(async () => {
  const g = window.__GAME__;
  const { NullPresenter } = await import('/src/core/presenter.js');
  const np = new NullPresenter();
  const calls = [
    () => np.play('x', {}), () => np.playUI('x', {}), () => np.setListener({}, {}, {}),
    () => np.muzzleFlash({}, {}, 1), () => np.tracer({}, {}, 1, 1, 1), () => np.impact({}, {}, 'concrete'),
    () => np.bloodSpray({}, {}, 1), () => np.explosion({}, 1), () => np.smokeTrail({}, {}),
    () => np.shellEject({}, {}, 'rifle'), () => np.flashbang(1, 1), () => np.screenShake(1, 1),
    () => np.flashDamage(1), () => np.hitmarker(true), () => np.setAmmo(1, 1), () => np.setWeapon({}),
    () => np.setEquipment(1, 1), () => np.setCrosshairSpread(1), () => np.killfeed({}), () => np.deathScreen({}),
    () => np.cameraDamageKick(g.player, {}, 1), () => np.cameraStartDeathCam(g.player, null),
    () => np.cameraEndDeathCam(g.player), () => np.cameraStartSlide(g.player),
    () => np.cameraStartMantle(g.player, 1, 1), () => np.cameraMeleeKick(g.player),
    () => np.cameraAddRecoil(g.player, 1, 1, 1, 1),
    // Called with no entity at all — a bot-fired shot has no camera; the port must not
    // assume one exists.
    () => np.cameraAddRecoil({}, 1, 1, 1, 1), () => np.cameraDamageKick(null, {}, 1),
  ];
  const errors = [];
  for (const call of calls) { try { call(); } catch (e) { errors.push(String(e)); } }
  return errors;
});

if (nullSafe.length === 0) ok('every NullPresenter method is call-safe, including with no entity/camera');
else bad('NullPresenter call-safe', nullSafe.join('\n       '));

await browser.close();
await server.close();

console.log(failures ? `\n${failures} FAILED` : '\nall presenter checks passed');
process.exit(failures ? 1 : 0);
