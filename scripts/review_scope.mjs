/** THROWAWAY scope/HUD probe (port 5191). */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.log(...a);
let server, browser;
try {
  server = await createServer({
    root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
    server: { port: 5191, strictPort: true, hmr: false, watch: null }, logLevel: 'error',
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
      '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(60000);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('overstrike.settings.v1', JSON.stringify({ renderScale: 0.5, postFx: true, shadows: false }));
      localStorage.setItem('overstrike.progress.v1', JSON.stringify({
        schema: 1, xp: 250000, level: 1, weapons: {}, lifetime: {}, challenges: {},
        createdAt: Date.now(), updatedAt: Date.now(),
      }));
    } catch { /* */ }
  });
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 180000, polling: 200 });
  await page.evaluate(() => window.__GAME__.startMatch({ mode: 'ffa', botCount: 2, seed: 5 }));
  const waitFrames = (n = 3) => page.evaluate(async (want) => {
    const g = window.__GAME__; const t = g.frame + want; const t0 = Date.now();
    while (g.frame < t && Date.now() - t0 < 60000) await new Promise((r) => requestAnimationFrame(r));
  }, n);
  await waitFrames(10);

  // Equip the REAVER and hold the real aim button.
  await page.evaluate(() => {
    const g = window.__GAME__;
    g.weapons.giveLoadout(g.player, ['sr_reaver', 'pi_talon']);
    g.weapons.switchTo(g.player, 0, true);
    g.input.enabled = true;
    g.input.buttons[2] = true;
  });
  await waitFrames(90);

  const r = await page.evaluate(async () => {
    const g = window.__GAME__; const c = g.player.camera; const s = g.engine.scope;
    const V = g.camera.position.constructor;
    const res = {};
    res.ads = g.player.adsAmount;
    res.def = g.player.weapon?.def?.id;
    res.scopeAim = c.scopeAim;
    res.sway = [c.scopeSwayYaw, c.scopeSwayPitch];
    res.swayDeg = Math.hypot(c.scopeSwayYaw, c.scopeSwayPitch) * 180 / Math.PI;
    res.engineScope = { active: s.active, amount: s.amount, r: s.apertureR };
    const el = g.hud.el.scope;
    res.scopeEl = {
      op: el.style.opacity, vis: el.style.visibility, w: el.style.width, h: el.style.height,
      tf: el.style.transform, rects: el.querySelectorAll('rect').length,
      box: (() => { const b = el.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height), Math.round(b.left), Math.round(b.top)]; })(),
    };
    res.xhAds = g.hud.el.xh.classList.contains('ads');
    // camera forward vs bullet direction
    const cd = new V(); g.camera.getWorldDirection(cd);
    const aim = g.player.getAimDirection(new V());
    res.aimAngleDeg = Math.acos(Math.min(1, cd.dot(aim))) * 180 / Math.PI;
    // fire origin vs eye
    const o = new V(); g.weapons.getFireOrigin(g.player, o);
    const eye = g.player.getEyePosition(new V());
    res.originVsEye = o.distanceTo(eye);
    // pitch clamp holds with sway added
    c.basePitch = 1.5533; c.recoilPitch = 0; c._writeAngles();
    res.pitchWithSway = g.player.pitch;
    c.basePitch = 0; c._writeAngles();
    return res;
  });
  log('[scoped] ' + JSON.stringify(r));
  await page.screenshot({ path: path.join(ROOT, 'shots', 'review-scoped.png'), timeout: 120000 });

  // breath hold while stationary
  const b = await page.evaluate(async () => {
    const g = window.__GAME__; const c = g.player.camera;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const inp = g.input; const real = inp.isDown.bind(inp);
    inp.isDown = (a) => (a === 'sprint' ? true : real(a));
    const t0 = performance.now(); const b0 = c.breath;
    const swayLog = [];
    for (let i = 0; i < 150; i++) { await frame(); swayLog.push(Math.hypot(c.scopeSwayYaw, c.scopeSwayPitch) * 180 / Math.PI); }
    const res = {
      secs: (performance.now() - t0) / 1000, b0, b1: c.breath, holding: c.breathHolding,
      gasp: c.breathGasp,
      hudW: g.hud.el.scopeBreathFill.getAttribute('width'),
      hudCls: g.hud.el.scopeBreath.getAttribute('class'),
      swayMax: Math.max(...swayLog).toFixed(4), swayEnd: swayLog[swayLog.length - 1].toFixed(4),
      sprinting: g.player.sprinting, ads: g.player.adsAmount,
    };
    inp.isDown = real;
    return res;
  });
  log('[breath] ' + JSON.stringify(b));

  // pause while scoped -> camera jolt + HUD scope element state
  const p2 = await page.evaluate(async () => {
    const g = window.__GAME__; const V = g.camera.position.constructor;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const d0 = new V(); g.camera.getWorldDirection(d0);
    const a0 = g.player.camera.scopeAim;
    g.setPaused(true); await frame(); await frame(); await frame();
    const d1 = new V(); g.camera.getWorldDirection(d1);
    const el = g.hud.el.scope;
    const res = {
      scopeAim: [a0, g.player.camera.scopeAim],
      joltDeg: Math.acos(Math.min(1, d0.dot(d1))) * 180 / Math.PI,
      hudScopeVisibleWhilePaused: { op: el.style.opacity, vis: el.style.visibility },
      engineScopeActive: g.engine.scope.active,
    };
    g.setPaused(false); await frame();
    return res;
  });
  log('[pause] ' + JSON.stringify(p2));

  // holding sprint while walking forward: does it cancel the scope?
  const w = await page.evaluate(async () => {
    const g = window.__GAME__;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const inp = g.input; const real = inp.isDown.bind(inp);
    inp.isDown = (a) => (a === 'sprint' || a === 'forward' ? true : real(a));
    const realWP = inp.wasPressed?.bind(inp);
    let fired = false;
    if (realWP) inp.wasPressed = (a) => (a === 'sprint' && !fired ? (fired = true) : realWP(a));
    for (let i = 0; i < 60; i++) await frame();
    const res = { ads: g.player.adsAmount, sprinting: g.player.sprinting, scopeAim: g.player.camera.scopeAim, breath: g.player.camera.breath };
    inp.isDown = real; if (realWP) inp.wasPressed = realWP;
    return res;
  });
  log('[sprint-while-scoped] ' + JSON.stringify(w));

  log('[errors] ' + JSON.stringify(errs.slice(0, 8)));
} catch (e) {
  log('FATAL ' + (e?.stack || e));
} finally { await browser?.close(); await server?.close(); }
