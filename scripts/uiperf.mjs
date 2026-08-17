/**
 * OVERSTRIKE — UI performance probe.
 *
 * Measures the three main-thread costs the UI layer owns, on the REAL GPU
 * (ANGLE/D3D11), driving the real game through `window.__GAME__`:
 *
 *   1. forced document layouts per second during gameplay
 *      — both the browser's own `LayoutCount` (CDP Performance domain) and an
 *        instrumented count of layout-FORCING reads (getBoundingClientRect,
 *        offsetWidth/Height, clientWidth/Height, getComputedStyle) with call-site
 *        attribution, so a regression names the file that caused it.
 *   2. milliseconds spent inside `Minimap.draw()` per frame (mean / p95 / max).
 *   3. the cost of the pause frame — `Menu.open()` JS time plus the style+layout
 *      flush it forces — sampled over several Escape presses.
 *
 * It also shoots deterministic screenshots of every UI surface (HUD, minimap,
 * killfeed, scoreboard, every menu panel and settings tab) with the WebGL canvas
 * blanked, so a before/after pair is a pixel comparison of the UI layer alone.
 *
 * Usage:
 *   node scripts/uiperf.mjs --tag=before
 *   node scripts/uiperf.mjs --tag=after
 *   node scripts/uiperf.mjs --tag=after --no-shots
 *
 * Output: perf/uiperf-<tag>.json  +  shots/uiperf-<tag>/*.png
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const TAG = arg('tag', 'run');
const HEADED = argv.includes('--headed');
const SHOTS = !argv.includes('--no-shots');
const SAMPLE_MS = Number(arg('ms', 6000));
const PAUSE_SAMPLES = Number(arg('pauses', 14));
const SHOT_DIR = path.resolve(ROOT, 'shots', `uiperf-${TAG}`);
const PERF_DIR = path.resolve(ROOT, 'perf');

/** Fixed everything: same level, same roster, same radar picture in both runs. */
const SEED = 0x5eed1234;
const MODE = 'tdm';
const BOTS = 7;

/* ------------------------------------------------------------------ helpers */
const stats = (a) => {
  if (!a.length) return { n: 0 };
  const s = a.slice().sort((x, y) => x - y);
  const sum = s.reduce((p, c) => p + c, 0);
  return {
    n: s.length,
    mean: +(sum / s.length).toFixed(4),
    p50: +s[Math.floor(s.length * 0.5)].toFixed(4),
    p95: +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(4),
    max: +s[s.length - 1].toFixed(4),
    total: +sum.toFixed(2),
  };
};

/**
 * Counts every layout-forcing DOM read and attributes it to the first call-site
 * outside this shim. Installed before any app script so it sees everything.
 */
const INSTRUMENT = () => {
  const LR = {
    on: false,
    rect: 0, offset: 0, client: 0, computed: 0, scroll: 0,
    sites: Object.create(null),
  };
  window.__LR__ = LR;

  const site = () => {
    const lines = String(new Error().stack || '').split('\n');
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      // Skip the shim's own frames; the first frame that names a source file wins.
      if (/hookRead|bump|site|getBoundingClientRect|<anonymous>:\d/.test(l)) continue;
      const m = l.match(/((?:\/src\/|\/scripts\/|\/node_modules\/)[^\s):]+:\d+:\d+)/);
      return (m ? m[1] : l).trim().replace(/^\s*at\s+/, '');
    }
    return '?';
  };
  const bump = (kind) => {
    if (!LR.on) return;
    LR[kind]++;
    const s = site();
    LR.sites[s] = (LR.sites[s] || 0) + 1;
  };

  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () { bump('rect'); return rect.call(this); };
  const rects = Element.prototype.getClientRects;
  Element.prototype.getClientRects = function () { bump('rect'); return rects.call(this); };

  const hook = (proto, prop, kind) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.get) return;
    Object.defineProperty(proto, prop, {
      ...d,
      get: function hookRead() { bump(kind); return d.get.call(this); },
    });
  };
  for (const p of ['offsetWidth', 'offsetHeight', 'offsetTop', 'offsetLeft']) hook(HTMLElement.prototype, p, 'offset');
  for (const p of ['clientWidth', 'clientHeight', 'clientTop', 'clientLeft']) hook(Element.prototype, p, 'client');
  for (const p of ['scrollWidth', 'scrollHeight', 'scrollTop', 'scrollLeft']) hook(Element.prototype, p, 'scroll');

  const gcs = window.getComputedStyle;
  window.getComputedStyle = function (...a) { bump('computed'); return gcs.apply(window, a); };

  window.__LRreset = () => {
    LR.rect = LR.offset = LR.client = LR.computed = LR.scroll = 0;
    LR.sites = Object.create(null);
  };
  window.__LRtotal = () => LR.rect + LR.offset + LR.client + LR.scroll + LR.computed;
};

/* --------------------------------------------------------------------- run */
let server, browser;
const out = { tag: TAG, when: new Date().toISOString(), seed: SEED, mode: MODE, bots: BOTS };

try {
  await mkdir(PERF_DIR, { recursive: true });
  if (SHOTS) await mkdir(SHOT_DIR, { recursive: true });

  server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    // Watcher and HMR off: other engineers are editing src/ while this runs and a
    // mid-run reload silently invalidates the measurement.
    server: { port: 5203, strictPort: false, hmr: false, watch: null },
    logLevel: 'error',
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  console.log(`[uiperf] dev server ${url}`);

  browser = await chromium.launch({
    headless: !HEADED,
    // The REAL GPU. Verified working on this machine.
    args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(60000);

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });

  await page.addInitScript(INSTRUMENT);
  await page.addInitScript(() => {
    try {
      const S = 'overstrike.settings.v1';
      const cur = JSON.parse(localStorage.getItem(S) || '{}');
      localStorage.setItem(S, JSON.stringify({
        ...cur, renderScale: 1, postFx: true, shadows: true, showFps: true,
        hudScale: 1, crosshairStyle: 'dynamic', crosshairColor: '#8ef7c4',
        showMinimap: true, showDamageNumbers: true, mode: 'tdm',
        loadoutPrimary: 'ar_vector', botCount: 7, difficulty: 'regular',
      }));
      // Unlock the whole arsenal so the loadout panel is fully populated.
      localStorage.setItem('overstrike.progress.v1', JSON.stringify({
        schema: 1, xp: 250000, level: 1, weapons: {}, lifetime: {}, challenges: {},
        createdAt: 1700000000000, updatedAt: 1700000000000,
      }));
    } catch { /* private mode */ }
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => {
    const m = await cdp.send('Performance.getMetrics');
    const o = {};
    for (const { name, value } of m.metrics) o[name] = value;
    return o;
  };

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 180000, polling: 200 });
  console.log('[uiperf] booted to menu');

  const gpu = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const d = gl?.getExtension('WEBGL_debug_renderer_info');
    return d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });
  out.gpu = gpu;
  console.log(`[uiperf] renderer: ${gpu}`);

  /* --------------------------------------------------------- start a match */
  // Is the 768² level bake done at load, or deferred to the first gameplay frame?
  out.bake = await page.evaluate(([mode, bots, seed]) => {
    const g = window.__GAME__;
    const mm = g.hud.minimap;
    const bakedAtBoot = !!mm.baked;
    g.startMatch({ mode, botCount: bots, difficulty: 'regular', seed });
    // startMatch is synchronous and has already run every system's reset().
    const bakedAfterReset = !!mm.baked;
    // Cost of the bake itself, measured on the real collider set.
    const t0 = performance.now();
    mm.baked = null; mm.bakeInfo = null;
    mm._bake();
    const ms = performance.now() - t0;
    return {
      bakedAtBoot,
      bakedAfterReset,
      hitchesOnFirstGameplayFrame: !bakedAfterReset,
      bakeMs: +ms.toFixed(2),
      colliders: g.world.boxes.length,
    };
  }, [MODE, BOTS, SEED]);
  console.log(`[uiperf] bake: ${out.bake.bakeMs} ms over ${out.bake.colliders} colliders; `
    + `at boot=${out.bake.bakedAtBoot}, after reset=${out.bake.bakedAfterReset} `
    + `(first-frame hitch: ${out.bake.hitchesOnFirstGameplayFrame})`);
  await page.waitForFunction(() => window.__GAME__.match.phase === 'live', null, { timeout: 120000, polling: 200 });

  // Instrument the minimap draw on the live instance (same shim in both runs).
  await page.evaluate(() => {
    const mm = window.__GAME__.hud.minimap;
    window.__MM__ = [];
    if (!mm.__perfWrapped) {
      const orig = Object.getPrototypeOf(mm).draw;
      mm.draw = function (dt) {
        const t0 = performance.now();
        orig.call(this, dt);
        window.__MM__.push(performance.now() - t0);
      };
      mm.__perfWrapped = true;
    }
  });

  // Let the frame rate settle before measuring.
  await page.waitForTimeout(1500);

  /* ------------------------------------------------ 1+2. gameplay sampling */
  console.log(`[uiperf] sampling gameplay for ${SAMPLE_MS} ms ...`);
  const m0 = await metrics();
  const t0 = await page.evaluate(() => {
    window.__MM__.length = 0;
    window.__LRreset();
    window.__LR__.on = true;
    window.__F0__ = window.__GAME__.frame;
    return performance.now();
  });
  await page.waitForTimeout(SAMPLE_MS);
  const sample = await page.evaluate(() => {
    window.__LR__.on = false;
    const LR = window.__LR__;
    const sites = Object.entries(LR.sites).sort((a, b) => b[1] - a[1]).slice(0, 12);
    return {
      now: performance.now(),
      frames: window.__GAME__.frame - window.__F0__,
      mm: window.__MM__.slice(),
      reads: { rect: LR.rect, offset: LR.offset, client: LR.client, scroll: LR.scroll, computed: LR.computed },
      sites,
    };
  });
  const m1 = await metrics();
  const secs = (sample.now - t0) / 1000;

  const readTotal = Object.values(sample.reads).reduce((a, b) => a + b, 0);
  out.gameplay = {
    seconds: +secs.toFixed(2),
    frames: sample.frames,
    fps: +(sample.frames / secs).toFixed(1),
    // Frame-rate-independent form: the defect scales with frames, not wall clock,
    // so a slow headless frame rate must not flatter the per-second numbers.
    layoutCountPer1000Frames: +(((m1.LayoutCount ?? 0) - (m0.LayoutCount ?? 0)) / sample.frames * 1000).toFixed(1),
    layoutForcingReadsPer1000Frames: +(readTotal / sample.frames * 1000).toFixed(1),
    layoutCountPerSec: +(((m1.LayoutCount ?? 0) - (m0.LayoutCount ?? 0)) / secs).toFixed(2),
    recalcStyleCountPerSec: +(((m1.RecalcStyleCount ?? 0) - (m0.RecalcStyleCount ?? 0)) / secs).toFixed(2),
    layoutMsPerSec: +((((m1.LayoutDuration ?? 0) - (m0.LayoutDuration ?? 0)) * 1000) / secs).toFixed(3),
    recalcStyleMsPerSec: +((((m1.RecalcStyleDuration ?? 0) - (m0.RecalcStyleDuration ?? 0)) * 1000) / secs).toFixed(3),
    layoutForcingReadsPerSec: +(readTotal / secs).toFixed(2),
    reads: sample.reads,
    topReadSites: sample.sites,
    minimapDrawMs: stats(sample.mm),
    minimapMsPerSec: +((stats(sample.mm).total || 0) / secs).toFixed(3),
  };
  console.log(`[uiperf]  fps ${out.gameplay.fps}  layouts/s ${out.gameplay.layoutCountPerSec}`
    + `  forcing-reads/s ${out.gameplay.layoutForcingReadsPerSec}`
    + `  minimap ${out.gameplay.minimapDrawMs.mean} ms/frame (p95 ${out.gameplay.minimapDrawMs.p95})`);

  /* ------------------------------- 2b. minimap microbenchmark (precise ms) */
  // performance.now() is clamped to 100 µs in a non-isolated page, so a single
  // 0.1 ms draw is unmeasurable one call at a time. Time a tight run of N draws
  // instead — same work, same canvas, but the quantisation washes out.
  const bench = await page.evaluate(() => {
    const g = window.__GAME__;
    const mm = g.hud.minimap;
    const raw = Object.getPrototypeOf(mm).draw.bind(mm);
    const wasUav = mm._uav;
    const wasPx = mm.canvas.width;

    const setup = (px, uav) => {
      if (mm.canvas.width !== px) { mm.canvas.width = px; mm.canvas.height = px; }
      mm._uav = uav;
      mm.el.classList.toggle('uav', uav);
    };
    // Canvas2D commands are queued on the GPU; a 1×1 readback at the end of the
    // run forces the whole batch to complete, so the number includes the raster.
    const run = (n) => {
      const t = performance.now();
      for (let i = 0; i < n; i++) raw(0);
      mm.ctx.getImageData(0, 0, 1, 1);
      return performance.now() - t;
    };

    // The backing store a 1080p display at devicePixelRatio 2 actually gets is
    // ~322². Nothing in draw() reads the DOM for its size, so forcing it is honest.
    const cfg = [
      ['msPerDraw', wasPx, false], ['msPerDrawUav', wasPx, true],
      ['msPerDrawAt322', 322, false], ['msPerDrawAt322Uav', 322, true],
    ];
    const acc = {};
    for (const [name] of cfg) acc[name] = [];
    for (let round = 0; round < 7; round++) {
      for (const [name, px, uav] of cfg) {
        setup(px, uav);
        if (round === 0) run(100);                 // JIT + shader warm
        acc[name].push(run(300) / 300);
      }
    }
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(4); };

    setup(wasPx, wasUav);
    const outB = { canvasPx: wasPx, cssPx: mm._cssSize, contacts: mm.contacts.size, entities: g.entities?.length ?? 0 };
    for (const [name] of cfg) outB[name] = med(acc[name]);
    return outB;
  });
  out.minimapBench = bench;
  console.log(`[uiperf]  minimap microbench: ${bench.msPerDraw} ms/draw (UAV ${bench.msPerDrawUav} ms) `
    + `at ${bench.canvasPx}² backing store; ${bench.msPerDrawAt322} ms (UAV ${bench.msPerDrawAt322Uav} ms) at 322²`);

  /* --------------------------------------------------- 3. the pause frame */
  console.log(`[uiperf] sampling ${PAUSE_SAMPLES} pause frames ...`);
  const pauses = [];
  for (let i = 0; i < PAUSE_SAMPLES; i++) {
    const pm0 = await metrics();
    const r = await page.evaluate(() => {
      const g = window.__GAME__;
      window.__LRreset();
      window.__LR__.on = true;
      // Exactly what the pointerUnlock subscriber does, timed.
      const a = performance.now();
      g.setPaused(true);
      g.menu.open('pause');
      const b = performance.now();
      // Force the style recalc + layout the freshly built DOM has queued. The
      // browser would do this before the next paint anyway; doing it here makes
      // it measurable instead of invisible.
      document.body.getBoundingClientRect();
      const c = performance.now();
      window.__LR__.on = false;
      return { js: b - a, flush: c - b, total: c - a };
    });
    const pm1 = await metrics();
    pauses.push({
      ...r,
      layouts: (pm1.LayoutCount ?? 0) - (pm0.LayoutCount ?? 0),
      recalcs: (pm1.RecalcStyleCount ?? 0) - (pm0.RecalcStyleCount ?? 0),
      nodes: (pm1.Nodes ?? 0) - (pm0.Nodes ?? 0),
      listeners: (pm1.JSEventListeners ?? 0) - (pm0.JSEventListeners ?? 0),
    });
    await page.evaluate(() => window.__GAME__.menu.resume());
    await page.waitForTimeout(320);
  }
  out.pauseFrame = {
    samples: pauses.length,
    jsMs: stats(pauses.map((p) => p.js)),
    flushMs: stats(pauses.map((p) => p.flush)),
    totalMs: stats(pauses.map((p) => p.total)),
    layoutsPerOpen: stats(pauses.map((p) => p.layouts)),
    recalcsPerOpen: stats(pauses.map((p) => p.recalcs)),
    // A non-zero mean here after the first open means open() is leaking nodes
    // or listeners on every pause.
    nodeDeltaPerOpen: stats(pauses.slice(1).map((p) => p.nodes)),
    listenerDeltaPerOpen: stats(pauses.slice(1).map((p) => p.listeners)),
  };
  console.log(`[uiperf]  pause frame ${out.pauseFrame.totalMs.mean} ms mean `
    + `(js ${out.pauseFrame.jsMs.mean}, flush ${out.pauseFrame.flushMs.mean}, `
    + `p95 ${out.pauseFrame.totalMs.p95}, max ${out.pauseFrame.totalMs.max})`);
  console.log(`[uiperf]  node delta per re-open ${out.pauseFrame.nodeDeltaPerOpen.mean}, `
    + `listener delta ${out.pauseFrame.listenerDeltaPerOpen.mean}`);

  /* --------------------------------------------------------- screenshots */
  if (SHOTS) {
    console.log('[uiperf] shooting UI surfaces ...');
    // Clip-based rather than locator-based: several HUD surfaces are legitimately
    // `pointer-events:none` / `opacity:0` and Playwright's actionability wait for a
    // locator screenshot then spins for a minute before failing.
    const shot = async (name, sel) => {
      const file = path.join(SHOT_DIR, `${name}.png`);
      const opts = { path: file, animations: 'disabled', caret: 'hide', timeout: 60000 };
      if (!sel) { await page.screenshot(opts); return; }
      const box = await page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }, sel);
      if (!box || box.width < 2 || box.height < 2) { console.log(`[uiperf]  ! ${name}: "${sel}" has no box`); return; }
      const clip = {
        x: Math.max(0, Math.floor(box.x)),
        y: Math.max(0, Math.floor(box.y)),
        width: Math.min(1280, Math.ceil(box.width)),
        height: Math.min(720, Math.ceil(box.height)),
      };
      await page.screenshot({ ...opts, clip });
    };

    // Deterministic UI state: freeze the loop, blank the 3D canvas, place the
    // operator and the roster by hand, and paint the HUD from known values.
    await page.evaluate(() => {
      const g = window.__GAME__;
      g.menu.close();
      g.setPaused(false);
      g.stop();
      document.getElementById('game-canvas').style.visibility = 'hidden';
      document.body.style.background = '#05080c';

      const p = g.player;
      p.position.set(0, 1, 0);
      p.yaw = 0.6;
      p.alive = true;
      p.health = 74;
      if ('armor' in p) p.armor = 0;

      // A fixed constellation of allies and hostiles around the operator.
      const place = [[6, 4], [-9, 3], [12, -7], [-4, -11], [3, 14], [-16, -2], [20, 9]];
      const list = g.entities || [];
      let k = 0;
      for (const e of list) {
        if (e === p || !e.position) continue;
        const q = place[k % place.length];
        e.position.set(q[0], 1, q[1]);
        e.yaw = (k * 0.7) % 6.28;
        e.alive = true;
        k++;
      }

      const mm = g.hud.minimap;
      mm.contacts.clear();
      mm._pulse = 1.1;
      // Long lives so a stray tick cannot fade them between setup and shutter.
      mm._addContact(101, 11, 6, 1e6);
      mm._addContact(102, -7, -13, 1e6);
      mm._addContact(103, 26, 20, 1e6);
      mm.setVisible(true);

      // HUD readouts from fixed values so the overlay is byte-stable.
      g.hud.setAmmo(19, 120);
      g.hud.setHealth(74, 100);
      g.hud.setScore(31, 24);
      g.hud.setTimer(413);
      g.hud.setCrosshairSpread(9);

      g.hud.killfeedUI.clear();
      for (const e of [
        { killer: 'VIPER', victimName: 'HOLLOW', killerTeam: 0, victimTeam: 1, weaponClass: 'ar', weaponId: 'ar_vector', headshot: true },
        { killer: 'OPERATOR', victimName: 'ASHEN', killerTeam: 0, victimTeam: 1, weaponClass: 'sniper', weaponId: 'sr_reaver', headshot: false, mine: true },
        { killer: 'RONIN', victimName: 'CINDER', killerTeam: 1, victimTeam: 0, weaponClass: 'smg', weaponId: 'smg_wasp', headshot: false },
      ]) g.hud.killfeedUI.add(e);
    });
    await page.waitForTimeout(150);
    // The killfeed enter transition needs a frame; the loop is stopped, so tick it.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.evaluate(() => {
      const g = window.__GAME__;
      g.hud.minimap.draw(0.016);
      g.hud.killfeedUI.update(0.016);
    });

    await shot('10-hud', '#hud');
    await shot('11-minimap', '.minimap');
    await shot('12-killfeed', '.killfeed');

    await page.evaluate(() => {
      const g = window.__GAME__;
      g.hud.minimap._uav = true;
      g.hud.minimap.el.classList.add('uav');
      g.hud.minimap._pulse = 1.1;
      g.hud.minimap.draw(0.016);
    });
    await shot('13-minimap-uav', '.minimap');
    await page.evaluate(() => {
      const g = window.__GAME__;
      g.hud.minimap._uav = false;
      g.hud.minimap.el.classList.remove('uav');
      g.hud.minimap.draw(0.016);
    });

    await page.evaluate(() => {
      const g = window.__GAME__;
      g.hud.scoreboard.setVisible(true);
      g.hud.scoreboard.refresh();
    });
    await page.waitForTimeout(120);
    await shot('14-scoreboard', '.sb');
    await page.evaluate(() => window.__GAME__.hud.scoreboard.setVisible(false));

    /* ---- menu: pause shell ---- */
    // The loop is stopped, so HUD.update() will never drop `.live` by itself and
    // the frozen overlay would bleed through every menu shot.
    await page.evaluate(() => { document.getElementById('hud').classList.remove('live'); });
    await page.evaluate(() => { const g = window.__GAME__; g.setPaused(true); g.menu.open('pause'); });
    await page.waitForTimeout(200);
    await shot('20-pause-status', '.menu');
    for (const [name, panel] of [['21-pause-loadout', 'loadout'], ['22-pause-controls', 'controls']]) {
      await page.evaluate((pn) => window.__GAME__.menu.show(pn, true), panel);
      await page.waitForTimeout(150);
      await shot(name, '.menu');
    }
    await page.evaluate(() => window.__GAME__.menu.show('settings', true));
    for (const tab of ['video', 'audio', 'gameplay', 'hud']) {
      await page.evaluate((t) => window.__GAME__.menu._setTab(t), tab);
      await page.waitForTimeout(150);
      await shot(`23-pause-settings-${tab}`, '.menu');
    }

    /* ---- menu: end shell ---- */
    await page.evaluate(() => {
      const g = window.__GAME__;
      g.menu.close();
      g.setPaused(false);
      for (const b of g.bots.bots) { const st = g.match.statsFor(b); if (st) { st.kills = 2; st.deaths = 3; } }
      const me = g.match.statsFor(g.player);
      me.kills = g.match.mode.scoreLimit; me.score = 4200; me.headshots = 6;
      me.shotsFired = 90; me.shotsHit = 44; me.bestStreak = 5;
      // Team modes end on `match.scores`, not on one operator's kill count.
      g.match.scores[0] = g.match.mode.scoreLimit;
      g.match._checkEnd();
      if (g.state !== 'gameover') g.match._end({ reason: 'score', winner: 0 });
    });
    await page.waitForTimeout(500);
    await shot('30-end-results', '.menu');

    /* ---- menu: main shell ---- */
    await page.evaluate(() => window.__GAME__.returnToMenu());
    await page.waitForTimeout(400);
    for (const [name, panel] of [
      ['40-main-home', 'home'], ['41-main-play', 'play'], ['42-main-loadout', 'loadout'],
      ['43-main-settings', 'settings'], ['44-main-controls', 'controls'], ['45-main-credits', 'credits'],
    ]) {
      await page.evaluate((pn) => window.__GAME__.menu.show(pn, true), panel);
      await page.waitForTimeout(180);
      await shot(name, '.menu');
    }
    console.log(`[uiperf] screenshots -> ${SHOT_DIR}`);
  }

  out.pageErrors = pageErrors.slice(0, 10);
} catch (err) {
  out.harnessError = String(err?.stack || err);
  console.error('[uiperf] FAILED', err);
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
}

const file = path.join(PERF_DIR, `uiperf-${TAG}.json`);
await writeFile(file, JSON.stringify(out, null, 2));
console.log(`\n[uiperf] wrote ${path.relative(ROOT, file)}`);
console.log(JSON.stringify({
  gameplay: out.gameplay && {
    fps: out.gameplay.fps,
    layoutCountPerSec: out.gameplay.layoutCountPerSec,
    layoutForcingReadsPerSec: out.gameplay.layoutForcingReadsPerSec,
    layoutMsPerSec: out.gameplay.layoutMsPerSec,
    minimapDrawMs: out.gameplay.minimapDrawMs,
  },
  pauseFrame: out.pauseFrame && {
    totalMs: out.pauseFrame.totalMs,
    jsMs: out.pauseFrame.jsMs,
    flushMs: out.pauseFrame.flushMs,
    nodeDeltaPerOpen: out.pauseFrame.nodeDeltaPerOpen,
  },
  pageErrors: out.pageErrors,
}, null, 1));
process.exit(out.harnessError ? 1 : 0);
