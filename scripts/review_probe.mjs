/**
 * THROWAWAY adversarial review probe (port 5191). Not part of the build.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = [];
const log = (...a) => { console.log(...a); out.push(a.join(' ')); };

let server, browser;
try {
  server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    server: { port: 5191, strictPort: true, hmr: false, watch: null },
    logLevel: 'error',
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  log('[probe] ' + url);

  browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
      '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(60000);
  await page.addInitScript(() => {
    try {
      localStorage.setItem('overstrike.settings.v1', JSON.stringify({ renderScale: 0.5, postFx: false, shadows: false }));
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
  log('[probe] booted');

  const waitFrames = (n = 3) => page.evaluate(async (want) => {
    const g = window.__GAME__; const target = g.frame + want; const t0 = Date.now();
    while (g.frame < target && Date.now() - t0 < 60000) await new Promise((r) => requestAnimationFrame(r));
  }, n);

  /* ---------------- §10 API presence ---------------- */
  const api = await page.evaluate(() => {
    const h = window.__GAME__.hud;
    const need = ['setAmmo', 'setHealth', 'setWeapon', 'hitmarker', 'killfeed', 'damageIndicator',
      'notice', 'setCrosshairSpread', 'setScore', 'setTimer', 'lowHealthVignette'];
    const r = {};
    for (const k of need) r[k] = typeof h[k];
    r.minimap = h.minimap ? h.minimap.constructor.name : null;
    r.minimapDraw = typeof h.minimap?.draw;
    r.hudRootId = h.root?.id;
    r.minimapIsCanvas = h.minimap?.canvas?.tagName;
    return r;
  });
  log('[api] ' + JSON.stringify(api));

  /* ---------------- start a match ---------------- */
  await page.evaluate(() => window.__GAME__.startMatch({ mode: 'ffa', botCount: 4, seed: 1234 }));
  await waitFrames(8);
  log('[state] ' + await page.evaluate(() => window.__GAME__.state));

  /* ---------------- HUD required methods actually mutate DOM ---------------- */
  const fn = await page.evaluate(async () => {
    const g = window.__GAME__; const h = g.hud; const q = (s) => document.querySelector(s);
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const res = {};

    // setScore / setTimer / setAmmo / setHealth via the public API
    h.setScore(7, 3); res.score = [q('.score-team.a .val')?.textContent, q('.score-team.b .val')?.textContent];
    h.setTimer(95); res.timer = q('.score-mid .clock')?.textContent || h.el.clock?.textContent;
    h.setAmmo(13, 77); res.ammo = [h.el.ammoMag.textContent, h.el.ammoRes.textContent];
    h.setHealth(42, 100, 0); res.hp = h.el.hpValue.textContent;
    h.setWeapon({ name: 'PROBE GUN', fireMode: 'semi', magSize: 10 }); res.weapon = h.el.ammoName.textContent;
    h.setCrosshairSpread(40); res.spread = h.el.xh.style.getPropertyValue('--sp');
    h.lowHealthVignette(0.8); res.vig = h.el.vignette.style.opacity;
    h.hitmarker(true); await frame(); await frame();
    res.hm = getComputedStyle(h.el.hitmark).opacity;
    h.killfeed({ victim: { name: 'BOT1' }, attacker: g.player, weaponId: 'ar_vector', headshot: true });
    await frame();
    res.kf = document.querySelectorAll('.kf-row').length;
    h.damageIndicator({ x: 1, y: 0, z: 0 }); res.arc = h._arcs.filter((a) => a.active).length;
    h.notice('PROBE', 'SUB', 2); res.notice = h.el.notice.className + '|' + h.el.noticeMain.textContent;
    return res;
  });
  log('[fn] ' + JSON.stringify(fn));

  /* ---------------- CACHE INVALIDATION: reload to same ammo count ---------------- */
  const cache = await page.evaluate(async () => {
    const g = window.__GAME__; const h = g.hud;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const res = {};
    // Force a mismatch: write the DOM directly behind the cache's back, then push the
    // same logical value again and see whether the HUD repairs itself.
    h.setAmmo(30, 90); await frame();
    h.el.ammoMag.textContent = 'XX';
    h.setAmmo(30, 90); await frame();
    res.ammoAfterSameValue = h.el.ammoMag.textContent;    // 'XX' == stuck

    h.setScore(5, 5); await frame(); h.el.scoreA.textContent = 'XX';
    h.setScore(5, 5); await frame(); res.scoreStuck = h.el.scoreA.textContent;

    h.setTimer(60); await frame(); h.el.clock.textContent = 'XX';
    h.setTimer(60); await frame(); res.timerStuck = h.el.clock.textContent;

    // ...and after a reset() (matchStart), do the caches let real values through?
    h.reset(); await frame();
    h.setAmmo(30, 90); h.setScore(5, 5); h.setTimer(60); h.setHealth(77, 100, 0);
    h.setCrosshairSpread(33); await frame();
    res.afterReset = {
      mag: h.el.ammoMag.textContent, scoreA: h.el.scoreA.textContent,
      clock: h.el.clock.textContent, hp: h.el.hpValue.textContent,
      sp: h.el.xh.style.getPropertyValue('--sp'),
    };
    return res;
  });
  log('[cache] ' + JSON.stringify(cache));

  /* ---------------- MINIMAP: per-frame draw + alloc + ctx stack ---------------- */
  await page.evaluate(() => window.__GAME__.startMatch({ mode: 'ffa', botCount: 4, seed: 99 }));
  await waitFrames(10);

  const mm = await page.evaluate(async () => {
    const g = window.__GAME__; const m = g.hud.minimap;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const res = {};
    res.baked = !!m.baked;
    res.cssSize = m._cssSize;
    res.canvas = [m.canvas.width, m.canvas.height];
    res.hasCaches = !!m._coneGrad && !!m._sweepGrad && !!m._font;

    // Count draw() calls that actually reach the raster, per rendered frame.
    let drew = 0; const real = m.draw.bind(m);
    let reached = 0;
    const origClear = m.ctx.clearRect.bind(m.ctx);
    m.ctx.clearRect = (...a) => { reached++; return origClear(...a); };
    m.draw = (dt) => { drew++; return real(dt); };

    // alive + playing
    for (let i = 0; i < 12; i++) await frame();
    res.alivePlaying = { drew, reached };

    // paused
    drew = 0; reached = 0;
    g.setPaused(true);
    for (let i = 0; i < 12; i++) await frame();
    res.paused = { drew, reached };
    g.setPaused(false);
    await frame();

    // dead
    drew = 0; reached = 0;
    const wasAlive = g.player.alive; g.player.alive = false;
    for (let i = 0; i < 16; i++) await frame();
    res.dead = { drew, reached };
    g.player.alive = wasAlive;

    // ctx save/restore balance: hammer draw and see if the state stack grows.
    // (An unbalanced save() would keep changing what a restore pops.)
    drew = 0; reached = 0;
    m.ctx.globalAlpha = 0.25;      // marker value in the OUTER state
    m.ctx.save();
    m.ctx.globalAlpha = 0.9;
    for (let i = 0; i < 8; i++) m.draw(1 / 60);
    m.ctx.restore();               // balanced draws => marker 0.25 comes back
    res.stackMarker = m.ctx.globalAlpha;   // 0.25 = balanced, anything else = leak
    m.ctx.globalAlpha = 1;

    // per-frame allocation: 400 draws, measure JS heap growth
    if (performance.memory) {
      const h0 = performance.memory.usedJSHeapSize;
      for (let i = 0; i < 400; i++) m.draw(1 / 120);
      res.heapPerDraw = Math.round((performance.memory.usedJSHeapSize - h0) / 400);
    }

    m.draw = real; m.ctx.clearRect = origClear;
    return res;
  });
  log('[minimap] ' + JSON.stringify(mm));

  /* ---------------- minimap: does it actually change pixels each frame ---------------- */
  const px = await page.evaluate(async () => {
    const g = window.__GAME__; const m = g.hud.minimap;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const hash = () => {
      const d = m.ctx.getImageData(0, 0, m.canvas.width, m.canvas.height).data;
      let h = 0; for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) | 0;
      return h;
    };
    // spin the player so consecutive frames must differ
    const hs = [];
    for (let i = 0; i < 6; i++) { g.player.camera.setAngles(i * 0.5, 0); await frame(); hs.push(hash()); }
    const distinct = new Set(hs).size;
    return { distinct, n: hs.length };
  });
  log('[minimap-pixels] ' + JSON.stringify(px));

  /* ---------------- minimap resize / DPR ---------------- */
  const rz = await page.evaluate(async () => {
    const g = window.__GAME__; const m = g.hud.minimap;
    const before = { css: m._cssSize, w: m.canvas.width };
    g.settings.set('hudScale', 1.6);
    await new Promise((r) => setTimeout(r, 400));
    const after = { css: m._cssSize, w: m.canvas.width };
    g.settings.set('hudScale', 1.0);
    await new Promise((r) => setTimeout(r, 400));
    const back = { css: m._cssSize, w: m.canvas.width };
    return { before, after, back, hasRO: !!m._ro };
  });
  log('[minimap-resize] ' + JSON.stringify(rz));

  /* ---------------- scoreboard TAB ---------------- */
  await page.evaluate(() => window.__GAME__.startMatch({ mode: 'ffa', botCount: 4, seed: 7 }));
  await waitFrames(6);
  const sb = await page.evaluate(async () => {
    const g = window.__GAME__;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const res = {};
    g.input._down?.add?.('Tab');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Tab' }));
    for (let i = 0; i < 4; i++) await frame();
    res.on = !!document.querySelector('.sb.on');
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Tab' }));
    for (let i = 0; i < 4; i++) await frame();
    res.off = !document.querySelector('.sb.on');
    return res;
  });
  log('[scoreboard] ' + JSON.stringify(sb));

  /* ---------------- playerCamera contract ---------------- */
  const cam = await page.evaluate(async () => {
    const g = window.__GAME__; const c = g.player.camera;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const res = {};
    res.near = g.camera.near; res.far = g.camera.far;
    res.fovSetting = g.settings.get('fov'); res.worldFov = c.worldFov;
    res.viewFov = c.viewFov;
    // pitch clamp via the public setter and via the raw base angle
    c.setAngles(0, 99); await frame(); res.pitchUp = g.player.pitch;
    c.setAngles(0, -99); await frame(); res.pitchDown = g.player.pitch;
    c.basePitch = 99; c._writeAngles(); res.pitchRawUp = g.player.pitch;
    c.setAngles(0, 0); await frame();
    res.eyeStand = g.player.eyeHeight;
    res.standHeight = g.player.height;
    // camera y vs feet+eye
    res.camY = g.camera.position.y; res.feetY = g.player.position.y;
    // per-frame allocation smoke: run 200 camera updates, watch heap deltas
    return res;
  });
  log('[camera] ' + JSON.stringify(cam));

  /* ---------------- scoped weapon: sway, breath, HUD reticle, ballistics agreement -------- */
  const scope = await page.evaluate(async () => {
    const g = window.__GAME__;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const res = {};
    try {
      g.weapons.giveLoadout?.(g.player, ['sr_reaver', 'pi_talon']);
      g.weapons.switchTo?.(g.player, 0, true);
    } catch (e) { res.err = String(e); }
    await frame();
    const w = g.weapons.current(g.player);
    res.weapon = w?.def?.id;
    res.scoped = !!w?.def?.scoped;
    if (!res.scoped) return res;

    // force ADS
    for (let i = 0; i < 90; i++) { g.player.adsAmount = 1; w.adsAmount = 1; await frame(); }
    res.scopeAim = g.player.camera.scopeAim;
    res.swayYaw = g.player.camera.scopeSwayYaw;
    res.breath = g.player.camera.breath;
    const el = g.hud.el.scope;
    res.scopeStyle = { op: el.style.opacity, vis: el.style.visibility, w: el.style.width };
    res.engineScope = { active: g.engine.scope?.active, amount: g.engine.scope?.amount, r: g.engine.scope?.apertureR };
    res.xhAds = g.hud.el.xh.classList.contains('ads');
    res.reticleRects = el.querySelectorAll('rect').length;

    // does the camera forward agree with the player's aim direction?
    const V = g.camera.position.constructor;
    const camDir = new V(); g.camera.getWorldDirection(camDir);
    const aim = g.player.getAimDirection(new V());
    res.aimAngleDeg = Math.acos(Math.min(1, camDir.dot(aim))) * 180 / Math.PI;

    // pause while scoped: does scopeAim snap and jolt the view?
    const y0 = g.player.camera.scopeAim;
    const d0 = new V(); g.camera.getWorldDirection(d0);
    g.setPaused(true); await frame(); await frame();
    const d1 = new V(); g.camera.getWorldDirection(d1);
    res.pauseScopeAim = [y0, g.player.camera.scopeAim];
    res.pauseJoltDeg = Math.acos(Math.min(1, d0.dot(d1))) * 180 / Math.PI;
    g.setPaused(false); await frame();

    // breath hold via the sprint bind while stationary
    g.player.adsAmount = 1;
    const inp = g.input;
    const before = g.player.camera.breath;
    const realIsDown = inp.isDown.bind(inp);
    inp.isDown = (a) => (a === 'sprint' ? true : realIsDown(a));
    for (let i = 0; i < 40; i++) { g.player.adsAmount = 1; await frame(); }
    res.breathAfterHold = g.player.camera.breath;
    res.holding = g.player.camera.breathHolding;
    res.hudBreathAttr = g.hud.el.scopeBreathFill?.getAttribute('width');
    res.hudBreathClass = g.hud.el.scopeBreath?.getAttribute('class');
    inp.isDown = realIsDown;
    res.breathBefore = before;
    return res;
  });
  log('[scope] ' + JSON.stringify(scope));

  /* ---------------- listener leak on menu open/close ---------------- */
  const leak = await page.evaluate(async () => {
    const g = window.__GAME__;
    const busCount = () => {
      let n = 0; const m = g.bus._map || g.bus.map || g.bus.listeners || g.bus._listeners;
      if (!m) return -1;
      for (const [, arr] of m) n += (arr?.length ?? arr?.size ?? 0);
      return n;
    };
    const a = busCount();
    for (let i = 0; i < 5; i++) { g.setPaused(true); await new Promise((r) => setTimeout(r, 60)); g.setPaused(false); await new Promise((r) => setTimeout(r, 60)); }
    const b = busCount();
    return { before: a, after: b };
  });
  log('[leak] ' + JSON.stringify(leak));

  log('[errors] ' + JSON.stringify(errs.slice(0, 10)));
  await page.evaluate(() => { const g = window.__GAME__; g.player.adsAmount = 1; });
  await waitFrames(4);
  await page.screenshot({ path: path.join(ROOT, 'shots', 'review-hud-scoped.png'), timeout: 120000 });
  await page.evaluate(() => window.__GAME__.startMatch({ mode: 'ffa', botCount: 4, seed: 3 }));
  await waitFrames(10);
  await page.screenshot({ path: path.join(ROOT, 'shots', 'review-hud.png'), timeout: 120000 });
} catch (e) {
  log('FATAL ' + (e?.stack || e));
} finally {
  await browser?.close();
  await server?.close();
}
