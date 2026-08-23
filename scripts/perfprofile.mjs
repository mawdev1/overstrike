/**
 * PERFPROFILE — an honest, reusable frame-time / memory / boot profile of the real client.
 *
 *   node scripts/perfprofile.mjs [--maps=the-square,meridian,square-extraction]
 *                                [--seconds=60] [--bots=9] [--profile-seconds=20]
 *                                [--out=DIR] [--headed] [--no-cpuprofile] [--boot-profile]
 *                                [--dpr=1|2] [--dist] [--cycles=N] [--boot-deadline=60]
 *
 * WHAT IS REAL HERE
 *   The client is served by Vite from the repository's own `vite.config.js`, booted in a real
 *   Chromium with a real GPU backend (`--use-angle=metal` on macOS), entered through the
 *   production shell's auth-free "Local practice" path, and then LEFT ALONE to run a match with
 *   bots fighting. Nothing is stubbed, no phase is skipped, and no measurement is taken from a
 *   synthetic scene.
 *
 * WHAT IT MEASURES
 *   boot      — every `Game.init` phase (from `game.bootProfile`), the page-level boot marks
 *               (`window.__BOOTPROF__`), time-to-playable, and the bytes/requests spent to get
 *               there (counted off the network, encoded size, cache-independent).
 *   shaders   — WebGL2 instrumentation installed BEFORE any page script runs: every
 *               `compileShader`, `linkProgram` and the blocking `getProgramParameter(LINK_STATUS)`
 *               / `getShaderParameter(COMPILE_STATUS)` query is counted and timed, so "compiling
 *               shaders 2.5s" stops being one number and becomes program count, wall time, and
 *               whether the driver was ever allowed to link in parallel
 *               (`KHR_parallel_shader_compile` presence AND use).
 *   frames    — a passive rAF probe records every frame delta for a sustained run in two
 *               conditions (idle, heavy combat): mean/p50/p95/p99/max, and long-frame counts.
 *   memory    — `performance.memory` sampled on a timer across the whole run (the browser is
 *               launched with `--enable-precise-memory-info`), reported as a slope so a leak is
 *               visible rather than inferred.
 *   gpu-ish   — `renderer.info` sampled alongside: draw calls, triangles, programs, textures,
 *               geometries — the last two are the ones that grow when something leaks.
 *   where     — a real CDP sampling profile (`Profiler.start` via Playwright's CDP session)
 *               taken DURING heavy combat, aggregated to top self-time functions.
 *
 * This script measures and reports. It changes nothing and asserts nothing: there is no budget
 * gate here on purpose, because a gate answers "did it regress" and this answers "where does the
 * time actually go". `scripts/mapperf.mjs` is the gate.
 */
import { build, createServer, preview } from 'vite';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import net_ from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../platform/src/app.js';
import { loadConfig } from '../platform/src/core/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (key, fallback) => {
  const hit = argv.find((value) => value.startsWith(`--${key}=`));
  return hit === undefined ? fallback : hit.slice(key.length + 3);
};
const flag = (key) => argv.includes(`--${key}`);

const MAPS = String(arg('maps', 'the-square,meridian,square-extraction')).split(',').filter(Boolean);
const SECONDS = Number(arg('seconds', 60));
const BOTS = Number(arg('bots', 9));
const PROFILE_SECONDS = Number(arg('profile-seconds', 20));
const OUT = path.resolve(arg('out', path.join(ROOT, 'perf', 'perfprofile')));
const HEADED = flag('headed');
const CPUPROFILE = !flag('no-cpuprofile');
// `--dist` measures the PRODUCTION bundle (vite build + preview) instead of Vite's dev module
// graph. The load path — bytes, requests, time to playable — is only meaningful there; the dev
// server ships every module unbundled and unminified. The map cannot be pinned in a production
// bundle (`selectMap` is not reachable from the page), so a `--dist` run measures the rotation
// head and says so rather than pretending otherwise.
const DIST = flag('dist');
// A Retina laptop renders every pixel FOUR times over: `--dpr=2` is not a stress test, it is
// the machine most players (and the owner who reported the lag) actually have.
const DPR = Number(arg('dpr', 1));
// `--cycles=N` swaps the frame profile for a session-shaped one: enter and leave a match N
// times, reporting what each round trip leaves behind.
const CYCLES = Number(arg('cycles', 0));
// How long a boot may take before the run calls it a stall. Entering a match is a ~1.5s
// operation; anything past this is a defect worth reporting, not a slow machine.
const BOOT_DEADLINE = Number(arg('boot-deadline', 60));
/**
 * Sampling the BOOT is opt-in (`--boot-profile`), and this is not caution — it is measured.
 * With a CDP sampling profiler attached across `Game.init`, roughly half of the entries in
 * this Chromium wedge: the renderer pegs a core at 100% and answers no further CDP call, so
 * even `Profiler.stop` never returns. Twelve entries measured with the profiler OFF (six on
 * the-square, six on meridian, fresh browser each) were playable in 779–1013ms with no wedge
 * at all. The profile it produces is genuinely useful — it is what attributed the shader
 * phase to `getProgramInfoLog` — so it stays available, with the cost stated. The combat-time
 * profile has never wedged and remains on by default.
 */
const BOOT_CPUPROFILE = flag('boot-profile');

await mkdir(OUT, { recursive: true });

// ── statistics ───────────────────────────────────────────────────────────────────────────
const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1);
  return sorted[Math.max(0, index)];
};
const round = (value, digits = 2) => +Number(value).toFixed(digits);
function frameStats(deltas) {
  const sorted = [...deltas].sort((a, b) => a - b);
  const sum = deltas.reduce((total, value) => total + value, 0);
  return {
    frames: deltas.length,
    seconds: round(sum / 1000),
    fpsMean: deltas.length ? round(1000 / (sum / deltas.length)) : 0,
    mean: round(sum / (deltas.length || 1)),
    p50: round(quantile(sorted, 0.5)),
    p95: round(quantile(sorted, 0.95)),
    p99: round(quantile(sorted, 0.99)),
    max: round(sorted[sorted.length - 1] ?? 0),
    over16: deltas.filter((value) => value > 16.7).length,
    over33: deltas.filter((value) => value > 33.3).length,
    over50: deltas.filter((value) => value > 50).length,
    over100: deltas.filter((value) => value > 100).length,
    over250: deltas.filter((value) => value > 250).length,
  };
}
/** Least-squares slope of y over x, in y-units per second. */
function slopePerSecond(samples, key) {
  const points = samples.filter((sample) => Number.isFinite(sample[key]));
  if (points.length < 3) return null;
  const t0 = points[0].t;
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  for (const point of points) {
    const x = (point.t - t0) / 1000;
    const y = point[key];
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const n = points.length;
  const denominator = n * sxx - sx * sx;
  if (!denominator) return null;
  return (n * sxy - sx * sy) / denominator;
}

// ── the WebGL / boot instrumentation that must exist before any page script ──────────────
function instrumentation() {
  const SHADER = (globalThis.__SHADERPROF__ = {
    compileShader: 0, compileShaderMs: 0,
    linkProgram: 0, linkProgramMs: 0,
    shaderStatusQueries: 0, shaderStatusMs: 0,
    programStatusQueries: 0, programStatusMs: 0,
    parallelExtensionQueried: false, parallelExtensionAvailable: null, completionStatusQueries: 0,
    firstCompileAt: null, lastLinkStatusAt: null,
    contexts: 0,
    // Wall-clock windows in which the main thread was inside a GL compile/link/status call.
    timeline: [],
  });
  const now = () => performance.now();
  const wrap = (proto, name, onCall) => {
    if (!proto || typeof proto[name] !== 'function') return;
    const original = proto[name];
    proto[name] = function instrumented(...args) {
      const t = now();
      const result = original.apply(this, args);
      onCall(now() - t, args, result, t);
      return result;
    };
  };
  const record = (start, duration, kind) => {
    if (duration >= 0.5) SHADER.timeline.push([round2(start), round2(duration), kind]);
  };
  const round2 = (value) => +value.toFixed(2);
  const install = (proto) => {
    if (!proto || proto.__perfprofileWrapped) return;
    proto.__perfprofileWrapped = true;
    wrap(proto, 'compileShader', (ms, _args, _result, t) => {
      SHADER.compileShader++; SHADER.compileShaderMs += ms;
      if (SHADER.firstCompileAt === null) SHADER.firstCompileAt = round2(t);
      record(t, ms, 'compileShader');
    });
    wrap(proto, 'linkProgram', (ms, _args, _result, t) => {
      SHADER.linkProgram++; SHADER.linkProgramMs += ms;
      record(t, ms, 'linkProgram');
    });
    wrap(proto, 'getShaderParameter', (ms, args, _result, t) => {
      if (args[1] === 0x8b81) { // COMPILE_STATUS
        SHADER.shaderStatusQueries++; SHADER.shaderStatusMs += ms; record(t, ms, 'COMPILE_STATUS');
      }
    });
    wrap(proto, 'getProgramParameter', (ms, args, _result, t) => {
      // 0x8b82 LINK_STATUS, 0x91b1 COMPLETION_STATUS_KHR
      if (args[1] === 0x8b82) {
        SHADER.programStatusQueries++; SHADER.programStatusMs += ms;
        SHADER.lastLinkStatusAt = round2(t + ms);
        record(t, ms, 'LINK_STATUS');
      } else if (args[1] === 0x91b1) {
        SHADER.completionStatusQueries++;
      }
    });
    wrap(proto, 'getExtension', (_ms, args, result) => {
      if (String(args[0]).includes('parallel_shader_compile')) {
        SHADER.parallelExtensionQueried = true;
        SHADER.parallelExtensionAvailable = Boolean(result);
      }
    });
  };
  install(globalThis.WebGL2RenderingContext?.prototype);
  install(globalThis.WebGLRenderingContext?.prototype);

  /**
   * LIVE resources, not call counts.
   *
   * `SHADER.contexts` counts `getContext` CALLS, and a second call on the same canvas
   * returns the SAME context object — so that counter cannot tell "a context leaked" from
   * "the same context was handed out twice". This registry stamps every distinct context
   * object with an id, holds it only through a `WeakRef`, and reports how many are still
   * reachable after a forced GC, whether each one is context-lost, and how many GL objects
   * each has created versus deleted. That is the difference between a leak and a footprint.
   */
  const LIVE = (globalThis.__GLLIVE__ = { created: 0, refs: [] });
  /**
   * A disposed Game that is still reachable after a forced GC is a leak of everything it
   * owns — scene graph, geometries, nav grid, bot rigs — no matter how correct its
   * `dispose()` was. Held only through `WeakRef`, so the probe cannot be the retainer.
   */
  const GAMES = (globalThis.__GAMEREFS__ = []);
  globalThis.__TRACKGAME__ = () => {
    const game = globalThis.__GAME__;
    if (game) GAMES.push(new WeakRef(game));
    return GAMES.length;
  };
  globalThis.__GAMESALIVE__ = () => GAMES.reduce((count, ref) => count + (ref.deref() ? 1 : 0), 0);
  const stamp = (context) => {
    if (context.__glLiveId) return;
    context.__glLiveId = ++LIVE.created;
    context.__glCounts = { program: 0, texture: 0, buffer: 0, framebuffer: 0, renderbuffer: 0 };
    LIVE.refs.push(new WeakRef(context));
  };
  globalThis.__GLLIVESTATE__ = () => {
    const live = [];
    for (const ref of LIVE.refs) {
      const context = ref.deref();
      if (!context) continue;
      let lost = null;
      try { lost = context.isContextLost(); } catch { /* already gone */ }
      live.push({ id: context.__glLiveId, lost, counts: { ...context.__glCounts } });
    }
    return {
      created: LIVE.created,
      alive: live.length,
      lost: live.filter((entry) => entry.lost === true).length,
      contexts: live,
    };
  };
  // Every GL object a context allocates, netted against what it deletes. A renderer that is
  // disposed without releasing its programs/textures shows up here as a positive balance on
  // a context that is still alive.
  for (const [name, key] of [['Program', 'program'], ['Texture', 'texture'], ['Buffer', 'buffer'],
    ['Framebuffer', 'framebuffer'], ['Renderbuffer', 'renderbuffer']]) {
    for (const proto of [globalThis.WebGL2RenderingContext?.prototype, globalThis.WebGLRenderingContext?.prototype]) {
      if (!proto) continue;
      for (const [method, delta] of [[`create${name}`, 1], [`delete${name}`, -1]]) {
        const original = proto[method];
        if (typeof original !== 'function') continue;
        proto[method] = function countedGlObject(...args) {
          if (this.__glCounts) this.__glCounts[key] += delta;
          return original.apply(this, args);
        };
      }
    }
  }

  // Audio contexts leak exactly the same way and are just as invisible, and a browser caps how
  // many a document may have OPEN at once — so the count that matters is the un-closed ones.
  const AUDIO = (globalThis.__AUDIOCTXREFS__ = []);
  globalThis.__AUDIOSTATE__ = () => {
    const states = {};
    for (const ref of AUDIO) {
      const ctx = ref.deref();
      if (!ctx) continue;
      states[ctx.state] = (states[ctx.state] || 0) + 1;
    }
    return states;
  };
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Original = globalThis[name];
    if (typeof Original !== 'function') continue;
    globalThis[name] = class InstrumentedAudioContext extends Original {
      constructor(...args) {
        super(...args);
        globalThis.__AUDIOCTXCOUNT__ = (globalThis.__AUDIOCTXCOUNT__ || 0) + 1;
        AUDIO.push(new WeakRef(this));
      }
    };
  }

  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContextInstrumented(type, ...rest) {
    const context = originalGetContext.call(this, type, ...rest);
    if (context && /webgl/i.test(String(type))) {
      SHADER.contexts++;
      stamp(context);
      // Ask the driver ourselves so the report can distinguish "extension missing" from
      // "extension present and never used" — the latter is a fixable serial-compile stall.
      try {
        SHADER.parallelSupportedByDriver = Boolean(context.getExtension('KHR_parallel_shader_compile'));
      } catch { /* some contexts refuse extension probes; leave it unknown */ }
    }
    return context;
  };

  // Long tasks, from the platform's own scheduler view.
  const LONG = (globalThis.__LONGTASKS__ = []);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        LONG.push({ start: round2(entry.startTime), ms: round2(entry.duration),
          name: entry.name, attribution: (entry.attribution || []).map((a) => a.name).join(',') });
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* longtask is not observable everywhere */ }

  // A passive frame probe. It never renders; it only timestamps the frames the game already
  // asked for, so it cannot invent or hide a hitch.
  const FRAMES = (globalThis.__FRAMEPROBE__ = { on: false, last: 0, deltas: [],
    work: [], sim: [], render: [], update: [] });
  const tick = (t) => {
    if (FRAMES.on) {
      if (FRAMES.last) FRAMES.deltas.push(+(t - FRAMES.last).toFixed(3));
      FRAMES.last = t;
    } else {
      FRAMES.last = 0;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  /**
   * Split the frame into the three costs a lane owner can act on: fixed-step simulation,
   * per-frame system update, and the renderer. Frame DELTA is useless on a vsynced display
   * (everything is 16.7ms until it isn't); the WORK inside the frame is what has headroom.
   */
  globalThis.__INSTRUMENTLOOP__ = () => {
    const game = globalThis.__GAME__;
    if (!game || game.__perfLoopWrapped) return false;
    game.__perfLoopWrapped = true;
    const originalLoop = game._loop;
    const originalFixed = game._fixedUpdate.bind(game);
    const originalUpdate = game._update.bind(game);
    const originalRender = game.engine.render.bind(game.engine);
    let sim = 0; let update = 0; let render = 0;
    game._fixedUpdate = (dt) => { const t = performance.now(); originalFixed(dt); sim += performance.now() - t; };
    game._update = (dt) => { const t = performance.now(); originalUpdate(dt); update += performance.now() - t; };
    game.engine.render = (dt) => { const t = performance.now(); originalRender(dt); render += performance.now() - t; };
    game._loop = (now) => {
      sim = 0; update = 0; render = 0;
      const t = performance.now();
      originalLoop(now);
      if (FRAMES.on) {
        FRAMES.work.push(+(performance.now() - t).toFixed(3));
        FRAMES.sim.push(+sim.toFixed(3));
        FRAMES.update.push(+update.toFixed(3));
        FRAMES.render.push(+render.toFixed(3));
      }
    };
    return true;
  };
}

// ── run one map ──────────────────────────────────────────────────────────────────────────
async function profileMap(browser, url, mapId) {
  // Progress is printed as it happens. A profile run is minutes long; a harness that prints
  // only at the end is indistinguishable from a hung one, which is exactly the failure mode
  // this script had on its first long run.
  const stage = (text) => console.log(`  [${new Date().toISOString().slice(11, 19)}] ${text}`);
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 }, deviceScaleFactor: DPR,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(300000);
  await page.addInitScript(instrumentation);
  await page.addInitScript(() => {
    try {
      const KEY = 'overstrike.settings.v1';
      const current = JSON.parse(localStorage.getItem(KEY) || '{}');
      localStorage.setItem(KEY, JSON.stringify({ ...current, renderScale: 1.0 }));
    } catch { /* first run has no settings yet */ }
  });

  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 300)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300));
  });

  // Network accounting up to "playable". Encoded body size off the wire, per resource type.
  const net = { requests: 0, bytes: 0, byType: {}, top: [] };
  let counting = true;
  page.on('response', async (response) => {
    if (!counting) return;
    net.requests++;
    let size = 0;
    try { size = Number((await response.allHeaders())['content-length'] || 0); } catch { /* stream gone */ }
    if (!size) {
      try { size = (await response.body()).length; } catch { /* body already consumed/aborted */ }
    }
    net.bytes += size;
    const ext = (new URL(response.url()).pathname.split('.').pop() || 'other').toLowerCase();
    net.byType[ext] = (net.byType[ext] || 0) + size;
    net.top.push({ url: new URL(response.url()).pathname.slice(-64), size });
  });

  const tNavigate = Date.now();
  stage('navigating');
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // A sampling profile of the BOOT itself, started on the live document so the navigation
  // cannot reset it. "compiling shaders 2.5s" is a phase label, not a cause; this is what
  // decomposes the phase into the functions inside it.
  let bootCdp = null;
  if (BOOT_CPUPROFILE) {
    bootCdp = await context.newCDPSession(page);
    await bootCdp.send('Profiler.enable');
    await bootCdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    await bootCdp.send('Profiler.start');
  }

  // Pin the map BEFORE the runtime builds a world. `Game.init` only honours an explicit
  // mapId on a NETWORKED handoff, so local practice always builds the rotation head; in dev
  // Vite serves the module graph by URL, so this is the very same module instance the game
  // runtime will import a moment later, and `selectMap` is the documented lever.
  if (!DIST) {
    const selected = await page.evaluate(async (id) => {
      const module = await import('/src/world/world.js');
      if (id !== module.activeMapId()) module.selectMap(id);
      return { active: module.activeMapId(), registered: module.listMaps().map((entry) => entry.id) };
    }, mapId);
    if (selected.active !== mapId) throw new Error(`could not select ${mapId}: ${JSON.stringify(selected)}`);
  }

  stage('entering local practice');
  await page.getByRole('button', { name: /local practice/i }).first().click({ timeout: 120000 });
  try {
    await page.waitForFunction(() => globalThis.__GAME__?.state === 'menu'
      || globalThis.__GAME__?.state === 'playing', null, { timeout: BOOT_DEADLINE * 1000, polling: 100 });
  } catch (error) {
    // A boot that never finishes is a finding, not a hang to stare at: say how far it got.
    // The probe itself is raced against a timer, because the failure mode this catches is a
    // main thread spinning in JS — and a renderer in that state answers no CDP call at all,
    // so an unguarded `evaluate` here hangs the harness instead of reporting the stall.
    const diagnosis = await Promise.race([
      page.evaluate(() => ({
      hasGame: Boolean(globalThis.__GAME__), state: globalThis.__GAME__?.state ?? null,
      phases: globalThis.__GAME__?.bootProfile?.phases ?? null,
      bootText: document.querySelector('#boot .boot-msg')?.textContent ?? null,
      shellView: globalThis.__OVERSTRIKE_SHELL__?.getState?.()?.view?.variant ?? null,
      runtimeLoaded: globalThis.__OVERSTRIKE_SHELL__?.getState?.()?.runtimeLoaded ?? null,
      })).catch((probeError) => ({ probeFailed: String(probeError.message) })),
      new Promise((resolve) => setTimeout(() => resolve({
        unresponsive: true,
        note: 'the renderer answered no CDP evaluate within 8s — the main thread is spinning, not waiting',
      }), 8000)),
    ]);
    throw new Error(`boot never became playable in ${BOOT_DEADLINE}s: ${JSON.stringify(diagnosis)}`
      + ` · errors ${JSON.stringify(pageErrors.slice(0, 3))}`);
  }
  const tReady = Date.now();
  counting = false;
  stage(`playable in ${tReady - tNavigate}ms`);

  let bootCpu = null;
  if (bootCdp) {
    const { profile } = await bootCdp.send('Profiler.stop');
    await bootCdp.send('Profiler.disable').catch(() => {});
    bootCpu = summariseProfile(profile);
    await writeFile(path.join(OUT, `${mapId}-boot.cpuprofile`), JSON.stringify(profile));
  }

  const boot = await page.evaluate(() => ({
    bootprof: { ...globalThis.__BOOTPROF__ },
    phases: globalThis.__GAME__.bootProfile?.phases ?? null,
    totalMs: globalThis.__GAME__.bootProfile?.totalMs ?? null,
    mapId: globalThis.__GAME__.world?.mapId ?? null,
    nav: { start: performance.timing?.navigationStart ?? null },
    marks: performance.getEntriesByType('navigation').map((entry) => ({
      domContentLoaded: +entry.domContentLoadedEventEnd.toFixed(1),
      loadEvent: +entry.loadEventEnd.toFixed(1),
      transferSize: entry.transferSize,
    })),
    shader: { ...globalThis.__SHADERPROF__, timeline: globalThis.__SHADERPROF__.timeline.slice() },
    longTasksDuringBoot: globalThis.__LONGTASKS__.slice(),
    programs: globalThis.__GAME__.renderer?.info?.programs?.length ?? null,
    capabilities: (() => {
      const gl = globalThis.__GAME__.renderer?.getContext?.();
      if (!gl) return null;
      // RENDERER alone reports the browser's masked string ("WebKit WebGL"), which cannot
      // tell a Metal-backed GPU from a software rasteriser — the one thing a perf number
      // must not be ambiguous about.
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        parallelCompile: Boolean(gl.getExtension('KHR_parallel_shader_compile')),
      };
    })(),
  }));
  if (boot.mapId !== mapId) throw new Error(`world built '${boot.mapId}', wanted '${mapId}'`);

  // Start a match with bots so there is something to fight, then hand the thread back.
  await page.evaluate((bots) => {
    const game = globalThis.__GAME__;
    game.menu?.close?.();
    if (game.state !== 'playing' || !game.player) {
      game.startMatch({ mode: 'tdm', botCount: bots, difficulty: 'regular', seed: 90210 });
    }
  }, BOTS);
  await page.waitForFunction(() => globalThis.__GAME__?.state === 'playing' && !!globalThis.__GAME__.player,
    null, { timeout: 120000, polling: 200 });
  await page.waitForTimeout(3000);

  const roster = await page.evaluate(() => {
    globalThis.__INSTRUMENTLOOP__();
    const game = globalThis.__GAME__;
    const list = game.bots?.list ?? game.bots?.bots ?? [];
    return {
      bots: list.length,
      alive: list.filter((bot) => bot.alive).length,
      settings: { maxFps: game.settings.get('maxFps'), renderScale: game.settings.get('renderScale'),
        shadows: game.settings.get('shadows'), fov: game.settings.get('fov') },
      drawingBuffer: { width: game.renderer.domElement.width, height: game.renderer.domElement.height,
        pixelRatio: game.renderer.getPixelRatio() },
    };
  });

  /** Sample frames + renderer.info + heap for `seconds`, under one named condition. */
  async function sample(condition, seconds) {
    await page.evaluate(() => {
      const probe = globalThis.__FRAMEPROBE__;
      for (const key of ['deltas', 'work', 'sim', 'update', 'render']) probe[key].length = 0;
      probe.last = 0;
      probe.on = true;
      globalThis.__LONGTASKS__.length = 0;
      globalThis.__SAMPLES__ = [];
      globalThis.__SAMPLER__ = setInterval(() => {
        const game = globalThis.__GAME__;
        const info = game?.renderer?.info;
        const memory = performance.memory;
        globalThis.__SAMPLES__.push({
          t: +performance.now().toFixed(0),
          calls: info?.render?.calls ?? null,
          triangles: info?.render?.triangles ?? null,
          programs: info?.programs?.length ?? null,
          textures: info?.memory?.textures ?? null,
          geometries: info?.memory?.geometries ?? null,
          heap: memory ? memory.usedJSHeapSize : null,
          heapLimit: memory ? memory.jsHeapSizeLimit : null,
          entities: (game?.bots?.list ?? game?.bots?.bots ?? []).length,
          projectiles: game?.projectiles?.active?.length ?? game?.projectiles?.list?.length ?? null,
          fxParticles: game?.fx?.particles?.liveCount ?? null,
          fxDecals: game?.fx?.decals?.liveCount ?? null,
          listeners: game?.bus?.size?.() ?? null,
        });
      }, 500);
    });
    await page.waitForTimeout(seconds * 1000);
    const result = await page.evaluate(() => {
      clearInterval(globalThis.__SAMPLER__);
      const probe = globalThis.__FRAMEPROBE__;
      probe.on = false;
      return {
        deltas: probe.deltas.slice(),
        work: probe.work.slice(), sim: probe.sim.slice(),
        update: probe.update.slice(), render: probe.render.slice(),
        samples: globalThis.__SAMPLES__.slice(),
        longTasks: globalThis.__LONGTASKS__.slice(),
      };
    });
    const numeric = (key) => result.samples.map((s) => s[key]).filter((v) => Number.isFinite(v));
    const last = result.samples[result.samples.length - 1] || {};
    const first = result.samples[0] || {};
    const longSorted = [...result.longTasks].sort((a, b) => b.ms - a.ms);
    return {
      condition,
      frames: frameStats(result.deltas),
      // CPU work inside the frame: the number that has headroom when the delta is pinned
      // to the display's refresh.
      cpuFrame: {
        loop: frameStats(result.work), simulation: frameStats(result.sim),
        systemUpdate: frameStats(result.update), render: frameStats(result.render),
      },
      renderer: {
        callsP95: round(quantile(numeric('calls').sort((a, b) => a - b), 0.95), 0),
        trianglesP95: round(quantile(numeric('triangles').sort((a, b) => a - b), 0.95), 0),
        programs: last.programs ?? null,
        texturesStart: first.textures ?? null, texturesEnd: last.textures ?? null,
        geometriesStart: first.geometries ?? null, geometriesEnd: last.geometries ?? null,
      },
      memory: {
        startMB: first.heap ? round(first.heap / 1048576) : null,
        endMB: last.heap ? round(last.heap / 1048576) : null,
        peakMB: numeric('heap').length ? round(Math.max(...numeric('heap')) / 1048576) : null,
        limitMB: last.heapLimit ? round(last.heapLimit / 1048576) : null,
        slopeMBPerMin: (() => {
          const slope = slopePerSecond(result.samples, 'heap');
          return slope === null ? null : round((slope * 60) / 1048576);
        })(),
        // Sawtooth depth: how much a single GC gave back, i.e. how hard the run churns.
        gcDropsMB: (() => {
          const heaps = result.samples.map((s) => s.heap).filter(Number.isFinite);
          const drops = [];
          for (let i = 1; i < heaps.length; i++) {
            if (heaps[i] < heaps[i - 1]) drops.push((heaps[i - 1] - heaps[i]) / 1048576);
          }
          return { count: drops.length, totalMB: round(drops.reduce((a, b) => a + b, 0)),
            maxMB: round(Math.max(0, ...drops)) };
        })(),
      },
      longTasks: { count: result.longTasks.length,
        totalMs: round(result.longTasks.reduce((total, task) => total + task.ms, 0)),
        worst: longSorted.slice(0, 5) },
      rawSamples: result.samples,
      rawDeltas: result.deltas,
    };
  }

  // ── IDLE: the match runs, the local player does nothing ────────────────────────────────
  stage(`sampling idle for ${SECONDS}s`);
  const idle = await sample('idle', SECONDS);

  // ── HEAVY COMBAT: the player fires continuously and respawns, bots fight back ──────────
  const combatSnapshot = () => page.evaluate(() => {
    const game = globalThis.__GAME__;
    const stats = game.match?.statsFor?.(game.player) ?? {};
    return {
      shotsFired: stats.shotsFired ?? null, shotsHit: stats.shotsHit ?? null,
      kills: stats.kills ?? null, deaths: game.player?.stats?.deaths ?? null,
      fx: game.fx?.debugInfo?.({}) ?? null,
    };
  });
  const combatBefore = await combatSnapshot();
  await page.evaluate(() => {
    const game = globalThis.__GAME__;
    game.input.enabled = true;
    // Hold FIRE through the real action set (the same set a mouse button feeds) and sweep the
    // view, so the renderer sees the whole map plus muzzle flashes, tracers, impacts and
    // decals — the effect load of a firefight, produced by the game's own code paths.
    globalThis.__COMBAT__ = setInterval(() => {
      const g = globalThis.__GAME__;
      if (!g?.player) return;
      if (!g.player.alive) { g.match?.respawn?.(g.player); return; }
      g.input.actions.add('fire');
      const t = performance.now() / 1000;
      g.player.setAngles?.((t * 0.5) % (Math.PI * 2), Math.sin(t * 0.9) * 0.12);
    }, 50);
  });
  await page.waitForTimeout(4000);
  stage(`sampling heavy combat for ${SECONDS}s`);
  const combat = await sample('heavy-combat', SECONDS);
  stage('combat sampled');
  const combatAfter = await combatSnapshot();

  // Headroom. rAF is pinned to the display's refresh, so a 16.7ms frame delta says nothing
  // about how close the frame is to missing. This drives the renderer as fast as it will go
  // and blocks on `gl.finish()` each iteration, so the number includes GPU time instead of
  // measuring how quickly the main thread can hand work to a queue and walk away.
  stage('measuring render throughput');
  const throughput = await page.evaluate(async () => {
    const game = globalThis.__GAME__;
    const gl = game.renderer.getContext();
    const engine = game.engine;
    const wall = [];
    const cpu = [];
    // Warm: the first frame after an idle gap pays for uploads that are not per-frame costs.
    for (let i = 0; i < 10; i++) { engine.update(1 / 120); engine.render(1 / 120); }
    gl.finish();
    for (let i = 0; i < 240; i++) {
      const t0 = performance.now();
      engine.update(1 / 120);
      engine.render(1 / 120);
      const t1 = performance.now();
      gl.finish();
      cpu.push(+(t1 - t0).toFixed(3));
      wall.push(+(performance.now() - t0).toFixed(3));
    }
    return { wall, cpu };
  });

  // ── CDP sampling profile, taken inside the same combat condition ───────────────────────
  let cpu = null;
  if (CPUPROFILE) {
    // Back to the shipped frame policy so the profile describes the condition a player is in.
    await page.evaluate((maxFps) => { globalThis.__GAME__.settings.set('maxFps', maxFps); }, roster.settings.maxFps);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    stage(`cpu profile for ${PROFILE_SECONDS}s`);
    await cdp.send('Profiler.start');
    await page.waitForTimeout(PROFILE_SECONDS * 1000);
    const { profile } = await cdp.send('Profiler.stop');
    await cdp.send('Profiler.disable').catch(() => {});
    cpu = summariseProfile(profile);
    await writeFile(path.join(OUT, `${mapId}-combat.cpuprofile`), JSON.stringify(profile));
  }

  await page.evaluate(() => {
    clearInterval(globalThis.__COMBAT__);
    globalThis.__GAME__.input.buttons[0] = false;
  });

  const finalState = await page.evaluate(() => ({
    state: globalThis.__GAME__?.state ?? null,
    alive: Boolean(globalThis.__GAME__?.player?.alive),
    contextLost: Boolean(globalThis.__GAME__?.renderer?.getContext?.()?.isContextLost?.()),
  }));

  net.top.sort((a, b) => b.size - a.size);
  const result = {
    mapId,
    boot: {
      ...boot,
      timeToPlayableMs: tReady - tNavigate,
      cpu: bootCpu,
      network: { requests: net.requests, megabytes: round(net.bytes / 1048576),
        byType: Object.fromEntries(Object.entries(net.byType)
          .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => [k, round(v / 1048576)])),
        largest: net.top.slice(0, 10).map((row) => ({ ...row, kb: round(row.size / 1024) })) },
    },
    roster,
    combatEvidence: { before: combatBefore, after: combatAfter },
    throughput: { gpuBound: frameStats(throughput.wall), cpuOnly: frameStats(throughput.cpu) },
    conditions: [idle, combat],
    cpu,
    finalState,
    pageErrors: [...new Set(pageErrors)].slice(0, 10),
    consoleErrors: [...new Set(consoleErrors)].slice(0, 10),
  };
  await context.close();
  return result;
}

/**
 * Enter and leave a match `cycles` times, measuring what does NOT come back.
 *
 * A player's session is not one match. Every entry builds a Game (renderer, scene, audio
 * graph, nav grid, bot rigs) and every exit is supposed to dispose it; anything the exit
 * misses accumulates across a session and ends as the browser killing the tab. This is the
 * measurement that tells a leak apart from a big-but-stable footprint, and it is deliberately
 * separate from the frame profile because it answers a different question.
 */
async function profileCycles(browser, url, mapId, cycles) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: DPR });
  const page = await context.newPage();
  page.setDefaultTimeout(300000);
  await page.addInitScript(instrumentation);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error.message).slice(0, 300)));
  const crashes = [];
  page.on('crash', () => crashes.push('page crashed'));

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (!DIST) {
    await page.evaluate(async (id) => {
      const module = await import('/src/world/world.js');
      if (id !== module.activeMapId()) module.selectMap(id);
    }, mapId);
  }
  const cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');

  const rows = [];
  for (let cycle = 1; cycle <= cycles; cycle++) {
    await page.getByRole('button', { name: /local practice/i }).first().click({ timeout: 120000 });
    await page.waitForFunction(() => Boolean(globalThis.__GAME__?.player), null, { timeout: 300000, polling: 100 });
    await page.evaluate(() => globalThis.__TRACKGAME__());
    await page.waitForTimeout(6000);
    // Leave exactly the way the product does: the game's own `toMenu` drives the shell's
    // runtime `exit()`, which is what calls `Game.dispose`.
    await page.evaluate(() => globalThis.__GAME__.bus.emit('toMenu', {}));
    await page.waitForFunction(() => !globalThis.__GAME__, null, { timeout: 60000, polling: 100 });
    await page.waitForTimeout(1500);
    await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForTimeout(500);
    const row = await page.evaluate((n) => ({
      cycle: n,
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(2) : null,
      glContexts: globalThis.__SHADERPROF__.contexts,
      programsLinked: globalThis.__SHADERPROF__.linkProgram,
      canvases: document.querySelectorAll('canvas').length,
      audioContexts: globalThis.__AUDIOCTXCOUNT__ ?? null,
      audioContextStates: globalThis.__AUDIOSTATE__(),
      // After a forced GC: how many distinct GL contexts are still reachable, how many of
      // those the browser has already taken away, and the net GL objects they hold.
      live: globalThis.__GLLIVESTATE__(),
      gamesRetained: globalThis.__GAMESALIVE__(),
      listeners: null,
    }), cycle);
    const live = row.live;
    /**
     * Count GL objects only on contexts that are STILL ALIVE AND NOT LOST.
     *
     * `__glCounts` is a create-minus-delete balance, and a context that has been lost never
     * receives another `deleteTexture` — nothing is left to call it — so its balance freezes
     * at whatever it was and stays in any total that includes it. Summing across every
     * reachable context therefore reports a retired context's objects forever, which is the
     * opposite of the truth: losing the context is precisely what hands that memory back to
     * the driver. `resident` is the number that answers "what does this session still cost
     * the GPU"; the raw per-context rows are kept in the JSON either way.
     */
    const resident = live.contexts.filter((c) => c.lost !== true);
    row.resident = {
      contexts: resident.length,
      program: resident.reduce((sum, c) => sum + c.counts.program, 0),
      texture: resident.reduce((sum, c) => sum + c.counts.texture, 0),
    };
    rows.push(row);
    console.log(`    cycle ${cycle}: heap ${row.heapMB}MB · GL contexts created ${live.created}`
      + ` alive ${live.alive} lost ${live.lost} · programs linked ${row.programsLinked}`
      + ` · resident GL contexts ${row.resident.contexts}`
      + ` programs ${row.resident.program}`
      + ` textures ${row.resident.texture}`
      + ` · canvases ${row.canvases} · audio ctx ${row.audioContexts} ${JSON.stringify(row.audioContextStates)}`
      + ` · games retained ${row.gamesRetained}`);
  }
  await context.close();
  return { mapId, cycles: rows, pageErrors: [...new Set(pageErrors)].slice(0, 10), crashes };
}

/** Aggregate a CDP `Profiler.stop` profile into self-time per function. */
function summariseProfile(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  const total = profile.samples.length;
  // `timeDeltas[i]` is the microseconds between sample i-1 and i.
  for (let i = 0; i < profile.samples.length; i++) {
    const node = nodes.get(profile.samples[i]);
    if (!node) continue;
    const micros = Math.max(0, profile.timeDeltas[i] ?? 0);
    const frame = node.callFrame;
    const file = (frame.url || '').replace(/^https?:\/\/[^/]+/, '') || '(native)';
    const key = `${frame.functionName || '(anonymous)'} @ ${file}:${frame.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + micros);
  }
  const wallMs = profile.timeDeltas.reduce((sum, value) => sum + Math.max(0, value), 0) / 1000;
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([name, micros]) => ({ name, ms: round(micros / 1000, 1), pct: round((micros / 1000 / wallMs) * 100, 1) }));
  // A per-file rollup answers "which subsystem", which is the question a lane owner asks.
  const byFile = new Map();
  for (const [name, micros] of self) {
    const file = name.split(' @ ')[1]?.split(':').slice(0, -1).join(':') || '(unknown)';
    byFile.set(file, (byFile.get(file) || 0) + micros);
  }
  return {
    samples: total,
    wallMs: round(wallMs),
    idlePct: round(((self.get('(idle) @ (native):0') || self.get('(program) @ (native):0') || 0) / 1000 / wallMs) * 100, 1),
    topSelf: rows,
    topFiles: [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)
      .map(([file, micros]) => ({ file, ms: round(micros / 1000, 1), pct: round((micros / 1000 / wallMs) * 100, 1) })),
  };
}

// ── main ─────────────────────────────────────────────────────────────────────────────────
let server;
let browser;
let platform = null;
const results = [];
const freePort = () => new Promise((resolve, reject) => {
  const probe = net_.createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
try {
  // The shell will not paint its entry screen until the platform answers `/v1/auth/refresh`,
  // so the harness brings its own real platform (memory storage) rather than requiring a
  // developer to have one on 8090. Vite's proxy target is read from the environment.
  const platformPort = await freePort();
  process.env.VITE_PLATFORM_PROXY_TARGET = `http://127.0.0.1:${platformPort}`;
  const built = await buildApp(loadConfig({
    ...process.env, NODE_ENV: 'development', PLATFORM_PORT: String(platformPort),
    PLATFORM_STORAGE: 'memory', PLATFORM_LOG_LEVEL: 'error',
    PLATFORM_TOKEN_SECRET: 'DEV-ONLY-INSECURE-perfprofile-token-secret',
    PLATFORM_MATCH_TICKET_SECRET: 'DEV-ONLY-INSECURE-perfprofile-ticket-secret',
    PLATFORM_MATCH_CONTROL_SECRET: 'DEV-ONLY-INSECURE-perfprofile-control-secret',
    PLATFORM_SERVICE_TOKEN: 'DEV-ONLY-INSECURE-perfprofile-service-token',
  }));
  await new Promise((resolve) => built.server.listen(platformPort, '127.0.0.1', resolve));
  platform = built;

  let url;
  if (DIST) {
    console.log('building the production bundle …');
    const tBuild = Date.now();
    await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error' });
    console.log(`  built in ${Date.now() - tBuild}ms`);
    server = await preview({
      root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
      preview: { port: 0, strictPort: false }, logLevel: 'error',
    });
    url = server.resolvedUrls.local[0];
  } else {
    server = await createServer({
      root: ROOT,
      configFile: path.join(ROOT, 'vite.config.js'),
      server: { port: 0, strictPort: false, hmr: false, watch: null },
      logLevel: 'error',
    });
    await server.listen();
    url = server.resolvedUrls.local[0];
  }
  console.log(`\nOVERSTRIKE perfprofile — maps ${MAPS.join(', ')} · ${SECONDS}s per condition · ${BOTS} bots`
    + ` · ${DIST ? 'PRODUCTION bundle' : 'dev module graph'} · dpr ${DPR}`);
  console.log(`client: ${url}`);

  const launchArgs = [
    // A real GPU backend. SwiftShader would measure a software rasteriser, not the product.
    ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []),
    '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio',
    // Without this `performance.memory` is bucketed to ~5MB and a slope is unreadable.
    '--enable-precise-memory-info',
    '--js-flags=--expose-gc',
    // Every launch must pay full price for its shaders. Chromium's program cache would
    // otherwise make the second map's boot look free and the first map look uniquely bad.
    '--disable-gpu-program-cache', '--disable-gpu-shader-disk-cache',
  ];

  for (const mapId of MAPS) {
    console.log(`\n── ${mapId}`);
    // One browser PER MAP: shader compilation is measured at boot, and a warm driver cache
    // from the previous map would hide exactly the phase this profile exists to explain.
    browser = await chromium.launch({ headless: !HEADED, args: launchArgs });
    try {
      if (CYCLES > 0) {
        const result = await profileCycles(browser, url, mapId, CYCLES);
        results.push(result);
        const first = result.cycles[0];
        const last = result.cycles[result.cycles.length - 1];
        console.log(`  ${CYCLES} match round trips: heap ${first.heapMB}MB → ${last.heapMB}MB`
          + ` · GL contexts ${first.glContexts} → ${last.glContexts}`
          + ` · resident GL programs ${first.resident.program} → ${last.resident.program}`
          + ` · resident GL textures ${first.resident.texture} → ${last.resident.texture}`
          + ` · programs linked ${first.programsLinked} → ${last.programsLinked}`
          + ` · canvases ${first.canvases} → ${last.canvases}`
          + `${result.crashes.length ? ` · CRASHES ${result.crashes.length}` : ''}`);
        if (result.pageErrors.length) console.log(`  page errors: ${result.pageErrors.join(' | ')}`);
        continue;
      }
      const result = await profileMap(browser, url, mapId);
      results.push(result);
      report(result);
    } catch (error) {
      console.log(`  FAILED ${mapId}: ${error.message}`);
      results.push({ mapId, error: error.message });
    } finally {
      // A browser whose renderer is spinning can refuse a graceful close; never let teardown
      // of one map cost the measurements of the next.
      await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 15000))]);
      browser = null;
    }
  }

  const outFile = path.join(OUT, 'perfprofile.json');
  await writeFile(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    args: { maps: MAPS, seconds: SECONDS, bots: BOTS, profileSeconds: PROFILE_SECONDS, dist: DIST, dpr: DPR },
    results,
  }, null, 2));
  console.log(`\nraw measurements -> ${outFile}`);
} finally {
  await browser?.close();
  try { await (server?.close?.() ?? server?.httpServer?.close?.()); } catch { /* already down */ }
  try { platform?.stop?.(); platform?.server?.close?.(); await platform?.deps?.store?.close?.(); } catch { /* shutting down */ }
}

function report(result) {
  const { boot } = result;
  const shader = boot.shader;
  const phase = Object.fromEntries(boot.phases || []);
  console.log(`  gpu: ${boot.capabilities?.renderer ?? 'unknown'}`);
  console.log(`  time to playable: ${boot.timeToPlayableMs}ms · Game.init total ${boot.totalMs}ms`
    + ` · bootPainted ${boot.bootprof.bootPainted}ms`);
  console.log(`  phases: ${(boot.phases || []).map(([name, ms]) => `${name} ${ms}`).join(' · ')}`);
  console.log(`  network before playable: ${boot.network.requests} requests · ${boot.network.megabytes}MB`
    + ` (${Object.entries(boot.network.byType).map(([k, v]) => `${k} ${v}MB`).join(', ')})`);
  console.log(`  shaders: ${shader.linkProgram} programs · compileShader ${round(shader.compileShaderMs)}ms`
    + ` · linkProgram ${round(shader.linkProgramMs)}ms · LINK_STATUS stalls ${shader.programStatusQueries}`
    + ` costing ${round(shader.programStatusMs)}ms · parallel ext supported=${shader.parallelSupportedByDriver}`
    + ` used=${shader.completionStatusQueries > 0} · shaders phase ${phase['compiling shaders'] ?? '?'}ms`);
  if (boot.cpu) {
    console.log(`  boot cpu profile (${boot.cpu.wallMs}ms wall) top self time:`);
    for (const row of boot.cpu.topSelf.slice(0, 10)) console.log(`    ${String(row.pct).padStart(5)}%  ${row.ms}ms  ${row.name}`);
  }
  console.log(`  settings: ${JSON.stringify(result.roster.settings)} · buffer `
    + `${result.roster.drawingBuffer.width}x${result.roster.drawingBuffer.height} @dpr ${result.roster.drawingBuffer.pixelRatio}`
    + ` · bots ${result.roster.bots}`);
  console.log(`  combat evidence: shots ${result.combatEvidence.before.shotsFired}→${result.combatEvidence.after.shotsFired}`
    + ` · hits ${result.combatEvidence.after.shotsHit} · kills ${result.combatEvidence.after.kills}`
    + ` · deaths ${result.combatEvidence.after.deaths} · fx ${JSON.stringify(result.combatEvidence.after.fx)}`);
  for (const condition of result.conditions) {
    const f = condition.frames;
    const c = condition.cpuFrame;
    console.log(`  ${condition.condition.padEnd(21)} fps ${f.fpsMean} · frame mean ${f.mean} p50 ${f.p50}`
      + ` p95 ${f.p95} p99 ${f.p99} max ${f.max} · >50ms ${f.over50} · >100ms ${f.over100}`);
    console.log(`               cpu/frame loop mean ${c.loop.mean} p95 ${c.loop.p95} max ${c.loop.max}`
      + ` (sim ${c.simulation.mean}/${c.simulation.p95} · update ${c.systemUpdate.mean}/${c.systemUpdate.p95}`
      + ` · render ${c.render.mean}/${c.render.p95})`);
    console.log(`               heap ${condition.memory.startMB}→${condition.memory.endMB}MB`
      + ` (peak ${condition.memory.peakMB}, ${condition.memory.slopeMBPerMin}MB/min, limit ${condition.memory.limitMB})`
      + ` · textures ${condition.renderer.texturesStart}→${condition.renderer.texturesEnd}`
      + ` · geometries ${condition.renderer.geometriesStart}→${condition.renderer.geometriesEnd}`
      + ` · calls p95 ${condition.renderer.callsP95} · tris p95 ${condition.renderer.trianglesP95}`);
    console.log(`               longTasks ${condition.longTasks.count} totalling ${condition.longTasks.totalMs}ms`);
  }
  const through = result.throughput;
  console.log(`  render throughput (update+render+gl.finish): ${through.gpuBound.mean}ms mean`
    + ` p95 ${through.gpuBound.p95} max ${through.gpuBound.max} → ceiling ${round(1000 / through.gpuBound.mean)} fps`
    + ` · cpu-only portion ${through.cpuOnly.mean}ms`);
  if (result.cpu) {
    console.log(`  cpu profile (${result.cpu.wallMs}ms wall, ${result.cpu.samples} samples) top self time:`);
    for (const row of result.cpu.topSelf.slice(0, 12)) console.log(`    ${String(row.pct).padStart(5)}%  ${row.ms}ms  ${row.name}`);
  }
  if (result.pageErrors.length) console.log(`  page errors: ${result.pageErrors.join(' | ')}`);
}
