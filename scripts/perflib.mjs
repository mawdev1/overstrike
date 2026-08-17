/**
 * OVERSTRIKE — real-GPU performance harness (shared library).
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other probe in `scripts/` boots Chromium with `--use-angle=swiftshader`, which
 * rasterises on the CPU. Their frame-rate numbers are therefore meaningless and the
 * README says so. This harness boots the SAME headless Chromium against the REAL GPU
 * (`--use-gl=angle --use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist`), which also
 * makes `EXT_disjoint_timer_query_webgl2` available — so we can measure how long the GPU
 * actually spent on a frame, and on each individual pass of the composer chain.
 *
 * It never touches `src/`. Everything it needs is monkey-patched onto the live objects
 * from inside the page (see PAGE_SRC below).
 *
 * DETERMINISM
 * -----------
 * Three things are pinned so two runs measure the same work:
 *
 *  1. `dtFrame` is forced to exactly 1/60 s every frame by rewriting `game._last` before
 *     the real loop reads it. The accumulator therefore runs EXACTLY two 1/120 substeps
 *     per frame, forever, no matter how fast the machine renders. Simulation state after
 *     N frames is then a pure function of N — not of wall-clock speed. This is the single
 *     biggest variance reduction in the harness; without it a fast run simulates less
 *     game time than a slow one and the two are not comparable.
 *  2. The camera is pinned: player position/yaw/pitch are rewritten every fixed step and
 *     `engine.camera` position/rotation are rewritten immediately before `engine.update()`
 *     (so the shadow cascade and sky follow the pinned camera) and again before
 *     `engine.render()`. The visible geometry is identical frame to frame and run to run.
 *  3. Scenarios are driven by FRAME COUNT, not by seconds, and matches use fixed seeds.
 *
 * A consequence worth knowing: match time advances at 1/60 s per rendered frame, so a
 * 720-frame sample is always 12 s of game time regardless of how long it took in reality.
 */
import { preview, createServer, build } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The launch flags that make headless Chromium use the discrete GPU.
 *
 * `--use-angle=d3d11` is the load-bearing one: the default headless path picks
 * SwiftShader. `--disable-gpu-vsync` + `--disable-frame-rate-limit` uncap rAF so the
 * render loop is not pinned to the monitor refresh (verified: ~390 fps in the menu
 * instead of 60/165). Without them every GPU number saturates at the refresh interval
 * and an optimisation that halves GPU cost shows up as no change at all.
 */
export const REAL_GPU_ARGS = [
  '--use-gl=angle',
  '--use-angle=d3d11',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--disable-gpu-vsync',
  '--disable-frame-rate-limit',
  '--mute-audio',
  '--autoplay-policy=no-user-gesture-required',
  '--enable-precise-memory-info',
  '--js-flags=--expose-gc',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-ipc-flooding-protection',
];

// ───────────────────────────────────────────────────────────────── statistics ──

/** Sorted-copy percentile/mean/max bundle. Returns null for an empty sample. */
export function stat(arr) {
  const a = Array.from(arr).filter((v) => Number.isFinite(v));
  if (!a.length) return null;
  const s = Float64Array.from(a).sort();
  const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  const varr = a.reduce((x, y) => x + (y - mean) * (y - mean), 0) / a.length;
  return {
    n: a.length,
    mean: r3(mean),
    median: r3(q(50)),
    p95: r3(q(95)),
    p99: r3(q(99)),
    min: r3(s[0]),
    max: r3(s[s.length - 1]),
    std: r3(Math.sqrt(varr)),
  };
}

export const r3 = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
export const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** Mean of the worst `pct`% of samples — the "1% low" a shooter actually feels. */
export function worstMean(arr, pct = 1) {
  const s = Float64Array.from(Array.from(arr).filter(Number.isFinite)).sort();
  if (!s.length) return null;
  const n = Math.max(1, Math.round(s.length * (pct / 100)));
  let sum = 0;
  for (let i = s.length - n; i < s.length; i++) sum += s[i];
  return r3(sum / n);
}

/** Fixed frame-interval bins, in ms. Chosen around the refresh rates that matter. */
export const HIST_EDGES = [0, 2, 3, 4, 5, 6.94, 8.33, 11.11, 13, 16.67, 20, 25, 33.3, 50, Infinity];

export function histogram(arr, edges = HIST_EDGES) {
  const counts = new Array(edges.length - 1).fill(0);
  for (const v of arr) {
    if (!Number.isFinite(v)) continue;
    for (let i = 0; i < counts.length; i++) {
      if (v >= edges[i] && v < edges[i + 1]) { counts[i]++; break; }
    }
  }
  return counts;
}

// ────────────────────────────────────────────────────────────────── the server ──

/**
 * Serve the game. Production (`dist/`) by default — that is what ships, and the dev
 * server's unbundled module graph plus HMR client measurably changes CPU cost.
 */
/**
 * Cross-origin isolation. Without it Chrome clamps `performance.now()` to 100 us, which
 * is catastrophic here: a whole CPU frame is ~2 ms and a 1/120 substep ~0.05 ms, so every
 * CPU split quantises to a handful of discrete values and the numbers become useless for
 * detecting a 5% change. With COOP+COEP the clamp drops to 5 us. The game loads zero
 * cross-origin resources, so require-corp costs us nothing.
 */
export const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export async function startServer({ dev = false, port = 5391, doBuild = true } = {}) {
  if (dev) {
    const server = await createServer({
      root: ROOT,
      configFile: path.join(ROOT, 'vite.config.js'),
      // HMR + the watcher are off: other engineers edit `src/` while this runs, and a
      // mid-run reload silently invalidates a long measurement.
      server: { port, strictPort: false, hmr: false, watch: null, headers: ISOLATION_HEADERS },
      logLevel: 'error',
    });
    await server.listen();
    return { url: server.resolvedUrls.local[0], mode: 'dev', close: () => server.close() };
  }

  if (doBuild) {
    await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.js'), logLevel: 'error' });
  } else if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/ is missing — run without --no-build, or `npm run build` first');
  }

  const server = await preview({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    preview: { port, strictPort: false, host: '127.0.0.1', open: false, headers: ISOLATION_HEADERS },
    logLevel: 'error',
  });
  return { url: server.resolvedUrls.local[0], mode: 'prod', close: () => server.close() };
}

// ──────────────────────────────────────────────────────────────── the browser ──

export async function launchBrowser({ headed = false, extraArgs = [] } = {}) {
  return chromium.launch({
    headless: !headed,
    args: [...REAL_GPU_ARGS, ...extraArgs],
  });
}

/**
 * Installed before ANY page script runs, so it can hook `engine.render` on the very
 * first frame. `main.js` does `window.__GAME__ = game` immediately after the Game
 * constructor (which builds the Engine) and before `game.init()`, so intercepting the
 * property assignment is the only way to be present for shader-compile hitching and
 * time-to-first-frame — both of which happen during boot.
 */
export const EARLY_SRC = `
(() => {
  const B = { t0: performance.now(), firstFrameMs: null, bootFrames: [], firstFrameProgs: null, err: null };
  window.__PERFBOOT__ = B;
  let _g = undefined;
  try {
    Object.defineProperty(window, '__GAME__', {
      configurable: true,
      get() { return _g; },
      set(v) {
        _g = v;
        try {
          const eng = v && v.engine;
          if (!eng || eng.__bootHooked) return;
          eng.__bootHooked = true;
          const orig = eng.render.bind(eng);
          eng.render = function (dt) {
            const a = performance.now();
            orig(dt);
            const b = performance.now();
            if (B.firstFrameMs === null) {
              B.firstFrameMs = b;
              try { B.firstFrameProgs = v.renderer.info.programs ? v.renderer.info.programs.length : null; } catch (e) {}
            }
            if (B.bootFrames.length < 4000) B.bootFrames.push(Math.round((b - a) * 1000) / 1000);
          };
        } catch (e) { B.err = String(e); }
      },
    });
  } catch (e) { B.err = String(e); }
})();
`;

/**
 * Force the video settings the harness measures at. Only `renderScale` is overridden —
 * everything else stays at DEFAULTS so the numbers describe what a player on default
 * settings actually gets. `renderScale` must be 1.0 or the resolution sweep measures
 * nothing (the engine multiplies innerWidth by it to size every render target).
 */
export function settingsInitScript(overrides = {}) {
  return `
(() => {
  try {
    const KEY = 'overstrike.settings.v1';
    const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
    localStorage.setItem(KEY, JSON.stringify(Object.assign({}, cur, { renderScale: 1.0 }, ${JSON.stringify(overrides)})));
  } catch (e) { /* private mode */ }
})();
`;
}

// ───────────────────────────────────────────────────────── the page-side probe ──

/**
 * Everything below runs INSIDE the page. It is a string rather than a function because
 * it is long, must not be minified by anything, and is evaluated once after boot.
 *
 * No template literals and no `${` in here — this whole thing lives inside a JS template
 * literal on the Node side.
 *
 * GPU TIMING, AND WHY IT IS SPLIT
 * ------------------------------
 * `EXT_disjoint_timer_query_webgl2` allows exactly ONE active TIME_ELAPSED_EXT query at
 * a time — you cannot nest a per-pass query inside a whole-frame query. The timer here
 * therefore keeps a STACK of segment names and splits queries at every boundary: when a
 * pass begins, the enclosing frame query is ended and a new one is begun for the pass;
 * when the pass ends, a fresh query resumes the frame. Each name accumulates all of its
 * pieces, so every reported segment is EXCLUSIVE (RenderPass excludes the shadow map;
 * "other" excludes every pass). Summing them gives the whole frame.
 *
 * Splitting costs ~15 queries per frame, which is not free, so the headline GPU frame
 * time is measured in a separate un-split phase with exactly one query around the whole
 * of `engine.render()`. Both numbers are reported; their difference is the price of the
 * instrumentation itself.
 */
export const PAGE_SRC = `
(function () {
  var g = window.__GAME__;
  if (!g) return { ok: false, error: 'window.__GAME__ missing' };
  if (window.__P) return { ok: true, already: true };

  var eng = g.engine;
  var renderer = g.renderer;
  var gl = renderer.getContext();
  var ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  var dbg = gl.getExtension('WEBGL_debug_renderer_info');
  var V3 = g.player.position.constructor;

  var FIXED_MS = 1000 / 60;   // locked frame delta -> exactly 2 substeps of 1/120

  // ══════════════════════════════════════════════════════════════ GPU timer ══

  function GpuTimer(poolSize) {
    this.poolSize = poolSize;
    this.free = [];
    for (var i = 0; i < poolSize; i++) this.free.push(gl.createQuery());
    this.fifo = [];        // ended, awaiting result — FIFO, results arrive in order
    this.stack = [];
    this.active = null;
    this.frames = new Map();
    this.done = [];
    this.fid = 0;
    this.cur = null;
    this.split = false;
    this.disjoint = 0;
    this.starved = 0;
    this.dropped = 0;
    this.overflow = 0;
    this.maxFifo = 0;
  }

  GpuTimer.prototype.available = function () { return !!ext; };

  GpuTimer.prototype.beginFrame = function () {
    if (!ext) return;
    this.fid++;
    this.cur = { fid: this.fid, issued: 0, resolved: 0, closed: false, bad: false, seg: {} };
    this.frames.set(this.fid, this.cur);
  };

  GpuTimer.prototype.endFrame = function () {
    if (!ext || !this.cur) return;
    while (this.stack.length) this.end(this.stack[this.stack.length - 1]);
    var f = this.cur;
    f.closed = true;
    if (f.issued === f.resolved) {
      this.frames.delete(f.fid);
      if (f.bad) this.dropped++; else this.done.push(f);
    }
    this.cur = null;
  };

  GpuTimer.prototype._start = function (name) {
    var f = this.cur;
    if (!f) return;
    var q = this.free.pop();
    if (!q) { this.starved++; f.bad = true; this.active = null; return; }
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    this.active = { q: q, name: name, fid: f.fid };
    f.issued++;
  };

  GpuTimer.prototype._stop = function () {
    if (!this.active) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    this.fifo.push(this.active);
    if (this.fifo.length > this.maxFifo) this.maxFifo = this.fifo.length;
    this.active = null;
  };

  GpuTimer.prototype.begin = function (name) {
    if (!ext || !this.cur) return;
    if (this.active) this._stop();
    this.stack.push(name);
    this._start(name);
  };

  GpuTimer.prototype.end = function () {
    if (!ext || !this.cur) return;
    this._stop();
    this.stack.pop();
    if (this.stack.length) this._start(this.stack[this.stack.length - 1]);
  };

  // Only ever called between frames, so no query is active here.
  GpuTimer.prototype.poll = function () {
    if (!ext) return;
    // Reading GPU_DISJOINT_EXT also clears it. A disjoint means the GPU was reset or
    // reclocked while our queries were in flight and EVERY pending timing is garbage.
    if (gl.getParameter(ext.GPU_DISJOINT_EXT)) { this.disjoint++; this.flush(); return; }
    var guard = 0;
    while (this.fifo.length && guard++ < 4096) {
      var e = this.fifo[0];
      if (!gl.getQueryParameter(e.q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.fifo.shift();
      var ns = gl.getQueryParameter(e.q, gl.QUERY_RESULT);
      this.free.push(e.q);
      var f = this.frames.get(e.fid);
      if (!f) continue;                       // frame was flushed — recycle and move on
      f.seg[e.name] = (f.seg[e.name] || 0) + ns / 1e6;
      f.resolved++;
      if (f.closed && f.resolved === f.issued) {
        this.frames.delete(f.fid);
        if (f.bad) this.dropped++; else this.done.push(f);
      }
    }
    // Safety valve: if the head somehow never resolves, do not grow without bound.
    // The margin matters — in split mode a frame issues ~14 queries and ANGLE/D3D11
    // hands results back tens of frames later, so a tight threshold flushes constantly
    // and every frame is discarded before it can complete.
    if (this.fifo.length > this.poolSize - 64) { this.overflow++; this.flush(); }
  };

  GpuTimer.prototype.flush = function () {
    if (this.active) this._stop();
    for (var i = 0; i < this.fifo.length; i++) {
      gl.deleteQuery(this.fifo[i].q);
      this.free.push(gl.createQuery());
    }
    this.fifo.length = 0;
    this.frames.clear();
    this.stack.length = 0;
    this.cur = null;
  };

  GpuTimer.prototype.idle = function () { return this.fifo.length === 0 && this.frames.size === 0; };

  // Sized for split mode: ~14 queries per frame times the number of frames ANGLE keeps
  // in flight before a TIME_ELAPSED result is readable. 2048 leaves a wide margin.
  var T = new GpuTimer(2048);

  // ══════════════════════════════════════════════════════════ camera pinning ══

  var PIN = {
    on: false,
    pos: new V3(), yaw: 0, pitch: 0, eye: 1.62,
    camPos: new V3(),
  };
  PIN.set = function (v) {
    PIN.on = true;
    PIN.pos.set(v.pos[0], v.pos[1], v.pos[2]);
    PIN.yaw = v.yaw;
    PIN.pitch = v.pitch;
    PIN.camPos.set(v.pos[0], v.pos[1] + PIN.eye, v.pos[2]);
  };
  /** Rewrite the simulated player. Runs every fixed step so nothing can drift. */
  PIN.applyEntity = function () {
    var p = g.player;
    if (!p) return;
    p.position.copy(PIN.pos);
    if (p.velocity) p.velocity.set(0, 0, 0);
    p.yaw = PIN.yaw;
    p.pitch = PIN.pitch;
    p.alive = true;
    p.health = p.maxHealth;
    var c = p.camera;
    if (c) {
      c.baseYaw = PIN.yaw;
      c.basePitch = PIN.pitch;
      c.recoilPitch = 0; c.recoilYaw = 0;
      c.recoilPitchTarget = 0; c.recoilYawTarget = 0;
    }
  };
  /**
   * Rewrite the render camera itself. This is what actually makes two runs draw the same
   * pixels — the player-camera rig adds bob, sway, lean, breathing and shake on top of
   * the simulated pose, and none of that is reproducible frame-for-frame.
   */
  PIN.applyCam = function () {
    var cam = eng.camera;
    cam.position.copy(PIN.camPos);
    cam.rotation.set(PIN.pitch, PIN.yaw, 0);   // rotation.order is already 'YXZ'
    cam.updateMatrixWorld(true);
  };

  // ═════════════════════════════════════════════════════════════════ patches ══

  var FIRE = false;
  var lastInfo = { calls: 0, tris: 0, points: 0, lines: 0, progs: 0, geos: 0, texs: 0 };

  /**
   * Health flags for passes that can silently no-op. DepthAOPass early-returns whenever
   * its read buffer has no depth texture, and a pass that returns costs 0 ms — which
   * reads in the breakdown exactly like a pass that is free. It is not the same thing,
   * so we report it separately. RenderPass never swaps, so the composer's read buffer at
   * the start of a frame is the same object the AO pass will be handed.
   */
  var diag = { aoFrames: 0, aoDepthFrames: 0 };

  var origFixed = g._fixedUpdate.bind(g);
  var origUpdate = g._update.bind(g);
  var origEngUpdate = eng.update.bind(eng);
  var origEngRender = eng.render.bind(eng);
  var origLoop = g._loop;                       // already bound in the Game constructor

  var acc = { fixed: 0, upd: 0, engUpd: 0, engRender: 0, steps: 0, tLoop: 0 };

  g._fixedUpdate = function (dt) {
    if (PIN.on) PIN.applyEntity();
    if (FIRE) {
      var i = g.input;
      i.enabled = true;
      i.buttons[0] = true;
      var w = g.player && g.player.weapon;
      // Top the magazine up rather than let it reload: a reload gap changes how many
      // tracers/decals/particles are alive and makes the scenario drift between runs.
      if (w && w.def) {
        if (w.ammo < w.def.magSize) w.ammo = w.def.magSize;
        w.reserve = 999;
      }
    }
    origFixed(dt);
    if (PIN.on) PIN.applyEntity();
    acc.steps++;
  };

  // Entry to _update marks the END of the fixed-step phase. Taking one timestamp here
  // instead of two per substep matters: performance.now() is clamped to 5 us in Chrome,
  // and a 1/120 substep is only ~0.2 ms, so per-substep timing quantises badly.
  g._update = function (dt) {
    var a = performance.now();
    acc.fixed = a - acc.tLoop;
    origUpdate(dt);
    acc.upd = performance.now() - a;
  };

  eng.update = function (dt) {
    if (PIN.on) PIN.applyCam();
    var a = performance.now();
    origEngUpdate(dt);
    acc.engUpd = performance.now() - a;
  };

  eng.render = function (dt) {
    if (PIN.on) PIN.applyCam();
    if (eng.aoPass && eng.aoPass.enabled && eng.composer) {
      diag.aoFrames++;
      if (eng.composer.readBuffer && eng.composer.readBuffer.depthTexture) diag.aoDepthFrames++;
    }
    var a = performance.now();
    T.begin('frame');
    origEngRender(dt);
    T.end();
    acc.engRender = performance.now() - a;
    var info = renderer.info;
    lastInfo.calls = info.render.calls;
    lastInfo.tris = info.render.triangles;
    lastInfo.points = info.render.points;
    lastInfo.lines = info.render.lines;
    lastInfo.progs = info.programs ? info.programs.length : 0;
    lastInfo.geos = info.memory.geometries;
    lastInfo.texs = info.memory.textures;
  };

  /**
   * Label passes by IDENTITY, not by constructor name — the production bundle minifies
   * class names to two letters, so name-based labelling produces garbage keys.
   */
  function labelFor(p, i) {
    if (p === eng.renderPass) return 'RenderPass';
    if (p === eng.aoPass) return 'DepthAO';
    if (p === eng.viewPass) return 'ViewLayer';
    if (p === eng.bloomPass) return 'Bloom';
    if (p === eng.outputPass) return 'Output';
    if (p === eng.compositePass) return 'Composite';
    return 'Pass' + i;
  }

  function patchPasses() {
    var passes = (eng.composer && eng.composer.passes) || [];
    for (var i = 0; i < passes.length; i++) {
      var p = passes[i];
      if (p.__perfPatched) continue;
      (function (pass, label) {
        pass.__perfPatched = true;
        var o = pass.render.bind(pass);
        pass.render = function () {
          if (!T.split) return o.apply(null, arguments);
          T.begin(label);
          try { return o.apply(null, arguments); } finally { T.end(); }
        };
      })(p, labelFor(p, i));
    }
    var sm = renderer.shadowMap;
    if (sm && !sm.__perfPatched) {
      sm.__perfPatched = true;
      var os = sm.render;
      sm.render = function (lights, scene, camera) {
        // The viewmodel scene has no shadow casters; timing an immediate return would
        // just split the enclosing query for nothing.
        if (!T.split || !lights || !lights.length) return os.call(sm, lights, scene, camera);
        T.begin('ShadowMap');
        try { return os.call(sm, lights, scene, camera); } finally { T.end(); }
      };
    }
  }
  patchPasses();

  // ═══════════════════════════════════════════════════════════════ recording ══

  var REC = null;
  var prevRaf = 0;
  var lockDt = true;
  var pendingResolve = null;
  var DRAIN_FRAMES = 150;
  var P = {};

  function mkRec(mode, want) {
    return {
      mode: mode, want: want, got: 0, done: false, drain: 0,
      raf: new Float64Array(want), dt: new Float64Array(want),
      loop: new Float64Array(want), fixed: new Float64Array(want),
      upd: new Float64Array(want), engUpd: new Float64Array(want),
      engRender: new Float64Array(want), steps: new Float64Array(want),
      draws: new Float64Array(want), tris: new Float64Array(want),
      fid: new Float64Array(want),
      heap: new Float64Array(want),
    };
  }

  g._loop = function (now) {
    T.poll();
    // Force an exact 1/60 s frame delta. See the determinism note at the top of the file.
    if (lockDt) g._last = now - FIXED_MS;

    var recording = REC && !REC.done && REC.got < REC.want;
    if (recording) T.beginFrame();

    acc.tLoop = performance.now();
    acc.fixed = 0; acc.upd = 0; acc.engUpd = 0; acc.engRender = 0; acc.steps = 0;

    origLoop(now);

    var t1 = performance.now();

    if (recording) {
      T.endFrame();
      var i = REC.got++;
      REC.raf[i] = now;
      REC.dt[i] = prevRaf ? now - prevRaf : 0;
      REC.loop[i] = t1 - acc.tLoop;
      REC.fixed[i] = acc.fixed;
      REC.upd[i] = acc.upd;
      REC.engUpd[i] = acc.engUpd;
      REC.engRender[i] = acc.engRender;
      REC.steps[i] = acc.steps;
      REC.draws[i] = lastInfo.calls;
      REC.tris[i] = lastInfo.tris;
      REC.fid[i] = T.fid;
      REC.heap[i] = (performance.memory && (i % 30 === 0)) ? performance.memory.usedJSHeapSize : 0;
      if (REC.got >= REC.want) { T.split = false; REC.drain = 0; }
    } else if (REC && !REC.done) {
      // Drain for a FIXED number of frames, not "until idle". Draining until the query
      // FIFO empties takes a wall-clock-dependent number of frames, and because the
      // simulation advances 1/60 s per frame that would leave the game in a slightly
      // different state at the start of the next phase on every run — which is exactly
      // the variance this harness exists to remove. ~150 frames is comfortably more than
      // the ~25 frames ANGLE needs to hand back a TIME_ELAPSED result.
      REC.drain++;
      if (REC.drain >= DRAIN_FRAMES) {
        REC.done = true;
        var resolve = pendingResolve;
        pendingResolve = null;
        if (resolve) resolve(P.collect());
      }
    }
    prevRaf = now;
  };

  // ═══════════════════════════════════════════════════════════════════ API ══

  P.info = function () {
    return {
      renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      timerQuery: !!ext,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      renderScale: g.settings.get('renderScale'),
      shadows: g.settings.get('shadows'),
      shadowQuality: g.settings.get('shadowQuality'),
      postFx: g.settings.get('postFx'),
      fov: g.settings.get('fov'),
      passes: ((eng.composer && eng.composer.passes) || []).map(function (p, i) {
        return { label: labelFor(p, i), enabled: p.enabled !== false };
      }),
      boot: window.__PERFBOOT__ || null,
      gc: typeof window.gc === 'function',
      memory: !!performance.memory,
      crossOriginIsolated: !!window.crossOriginIsolated,
      timerResolutionMs: (function () {
        // Empirical clamp: the smallest non-zero delta performance.now() will report.
        var best = Infinity;
        for (var i = 0; i < 200000; i++) {
          var a = performance.now(), b = performance.now();
          if (b > a && b - a < best) best = b - a;
        }
        return best === Infinity ? null : Math.round(best * 1e6) / 1e6;
      })(),
    };
  };

  /**
   * Deterministic vantage points, derived from the level itself rather than hand-typed
   * coordinates: sweep every spawn point across 36 headings, measure the clear sightline,
   * and pick by rank. Same level -> same viewpoints, every run, on every machine.
   */
  P.viewpoints = function () {
    var w = g.world;
    var eye = new V3(), dir = new V3();
    var cands = [];
    for (var si = 0; si < w.spawnPoints.length; si++) {
      var sp = w.spawnPoints[si];
      for (var i = 0; i < 36; i++) {
        var yaw = (i / 36) * Math.PI * 2;
        eye.set(sp.position.x, sp.position.y + PIN.eye, sp.position.z);
        dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        var hit = w.raycast(eye, dir, 200);
        cands.push({
          x: Math.round(sp.position.x * 1000) / 1000,
          y: Math.round(sp.position.y * 1000) / 1000,
          z: Math.round(sp.position.z * 1000) / 1000,
          yaw: Math.round(yaw * 100000) / 100000,
          open: Math.round((hit ? hit.distance : 200) * 100) / 100,
          si: si, i: i,
        });
      }
    }
    // Total order, so ties can never reorder between runs.
    cands.sort(function (a, b) {
      return (b.open - a.open) || (a.si - b.si) || (a.i - b.i);
    });
    var pick = function (idx, pitch) {
      var c = cands[Math.min(cands.length - 1, idx)];
      return { pos: [c.x, c.y, c.z], yaw: c.yaw, pitch: pitch, sightline: c.open };
    };
    return {
      long: pick(0, 0.0),                                   // longest sightline on the map
      mid: pick(Math.floor(cands.length * 0.18), -0.04),    // open, but not the extreme
      tight: pick(Math.floor(cands.length * 0.72), -0.04),  // enclosed
    };
  };

  P.heap = function () {
    try { if (window.gc) { window.gc(); window.gc(); } } catch (e) {}
    if (!performance.memory) return null;
    return {
      used: performance.memory.usedJSHeapSize,
      total: performance.memory.totalJSHeapSize,
    };
  };

  P.setup = function (sc) {
    g.settings.set('renderScale', 1.0);
    FIRE = false;
    PIN.on = false;

    if (sc.kind === 'menu') {
      if (g.state !== 'menu') g.returnToMenu();
    } else {
      g.settings.set('botCount', sc.bots);
      g.startMatch({ mode: sc.gameMode || 'tdm', difficulty: sc.difficulty, seed: sc.seed, botCount: sc.bots });
      // A benchmark must never end early. 24 veteran bots reach the TDM score limit of
      // 75 inside the sample window, and a match that ends stops simulating.
      g.match.timeLimit = 1e9;
      if (g.match.mode) g.match.mode.scoreLimit = 1e9;
    }
    if (sc.view) PIN.set(sc.view);
    FIRE = !!sc.fire;
    if (PIN.on) { PIN.applyEntity(); PIN.applyCam(); }
    patchPasses();
    return { state: g.state, bots: g.bots ? g.bots.bots.length : 0 };
  };

  /** Deploy every piece of killstreak hardware the player can own, and keep it up. */
  P.arm = function () {
    var ks = g.match && g.match.killstreaks;
    if (!ks || !g.player) return { ok: false };
    var id = g.player.id;
    var out = { chopper: 0, sentry: 0, uav: false, airstrike: false };
    try {
      var choppers = ks._choppers || [];
      var live = 0;
      for (var i = 0; i < choppers.length; i++) if (choppers[i].active) live++;
      while (live < choppers.length) {
        ks.inventory.set(id, ['chopper']);
        if (!ks.activate(g.player, 'chopper')) break;
        live++;
      }
      out.chopper = live;

      var sentries = ks._sentries || [];
      var sl = 0;
      for (var j = 0; j < sentries.length; j++) if (sentries[j].active) sl++;
      while (sl < sentries.length) {
        ks.inventory.set(id, ['sentry']);
        if (!ks.activate(g.player, 'sentry')) break;
        sl++;
      }
      out.sentry = sl;

      if (!ks.uavActive(g.player.team)) {
        ks.inventory.set(id, ['uav']);
        out.uav = ks.activate(g.player, 'uav');
      } else out.uav = true;

      // Two calls: the first arms the mark, the second confirms it and launches the run.
      ks.inventory.set(id, ['airstrike']);
      if (ks.activate(g.player, 'airstrike')) { ks.activate(g.player); out.airstrike = true; }
      ks.inventory.delete(id);
    } catch (e) { out.error = String(e); }
    return out;
  };

  P.start = function (opts) {
    T.split = opts.mode === 'passes';
    if (T.split) patchPasses();
    T.done.length = 0;
    T.flush();
    T.disjoint = 0; T.starved = 0; T.dropped = 0; T.overflow = 0; T.maxFifo = 0;
    diag.aoFrames = 0; diag.aoDepthFrames = 0;
    REC = mkRec(opts.mode, opts.frames);
    return true;
  };

  P.busy = function () { return !!(REC && !REC.done); };

  /**
   * Spin uncaptured frames until the program list stops growing.
   *
   * Three compiles a GL program lazily, the first time a given material/light
   * combination is actually drawn. In the "typical" scenario the bot models push it
   * from 37 to 109 the first time bots come into view, and each link stalls the frame —
   * one of them for nearly two seconds. That is a genuine shipping problem and the hitch
   * phase measures it deliberately; letting it also land in the middle of the steady-state
   * sample would just make the headline numbers random.
   *
   * Resolves through the rAF loop, so this measures the real render path.
   */
  P.settle = function (opts) {
    var maxFrames = opts.maxFrames || 1800;
    var quiet = opts.quiet || 150;
    // Every scenario spends the SAME number of frames between match start and the
    // sample, so the simulation is in an identical state each run. Without this pad the
    // settle loop finishes after a variable number of frames, bots end up in different
    // places, and two repeats of "heavy" render genuinely different scenes.
    var padTo = opts.padTo || 900;

    // Force the lazy compiles up front. three only builds a program the first time a
    // material is actually drawn, so anything currently hidden (a bot behind a wall, a
    // pooled effect that has not fired yet) links mid-sample and stalls the frame.
    var forced = 0;
    var restore = [];
    try {
      var mark = function (root, cam) {
        root.traverse(function (o) { restore.push([o, o.visible]); o.visible = true; });
        renderer.compile(root, cam);
      };
      mark(g.scene, eng.camera);
      mark(eng.viewScene, eng.viewCamera);
      forced = renderer.info.programs ? renderer.info.programs.length : 0;
    } catch (e) { /* compile() is best-effort; the settle loop is the real guarantee */ }
    for (var i = 0; i < restore.length; i++) restore[i][0].visible = restore[i][1];

    return new Promise(function (resolve) {
      var frames = 0, stable = 0, settledAt = -1;
      var last = renderer.info.programs ? renderer.info.programs.length : 0;
      var tick = function () {
        frames++;
        var n = renderer.info.programs ? renderer.info.programs.length : 0;
        if (n === last) stable++; else { stable = 0; last = n; }
        if (settledAt < 0 && stable >= quiet) settledAt = frames;
        if ((settledAt >= 0 && frames >= padTo) || frames >= maxFrames) {
          resolve({ frames: frames, settledAt: settledAt, programs: n, programsAfterCompile: forced, settled: settledAt >= 0 });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  };

  P.collect = function () {
    if (!REC) return null;
    var byFid = new Map();
    for (var i = 0; i < T.done.length; i++) byFid.set(T.done[i].fid, T.done[i].seg);
    var gpu = [];
    for (var k = 0; k < REC.got; k++) gpu.push(byFid.get(REC.fid[k]) || null);
    var toArr = function (ta) { return Array.prototype.slice.call(ta, 0, REC.got); };
    var out = {
      mode: REC.mode,
      got: REC.got,
      dt: toArr(REC.dt),
      loop: toArr(REC.loop),
      fixed: toArr(REC.fixed),
      upd: toArr(REC.upd),
      engUpd: toArr(REC.engUpd),
      engRender: toArr(REC.engRender),
      steps: toArr(REC.steps),
      draws: toArr(REC.draws),
      tris: toArr(REC.tris),
      heap: toArr(REC.heap),
      gpu: gpu,
      counters: {
        drawCalls: lastInfo.calls,
        triangles: lastInfo.tris,
        points: lastInfo.points,
        lines: lastInfo.lines,
        programs: lastInfo.progs,
        geometries: lastInfo.geos,
        textures: lastInfo.texs,
      },
      timer: {
        disjoint: T.disjoint, starved: T.starved, dropped: T.dropped,
        overflow: T.overflow, maxFifo: T.maxFifo, pending: T.frames.size,
        resolved: T.done.length,
      },
      state: g.state,
      bots: g.bots ? g.bots.bots.length : 0,
      botsAlive: g.bots ? g.bots.bots.filter(function (b) { return b.alive; }).length : 0,
      diag: { aoFrames: diag.aoFrames, aoDepthFrames: diag.aoDepthFrames },
    };
    T.done.length = 0;
    REC = null;
    return out;
  };

  /**
   * Pure CPU simulation cost with the renderer stopped. Timed in blocks because Chrome
   * clamps performance.now() to 5 us and a single 1/120 step is only a few times that.
   */
  P.stepped = function (steps, block) {
    block = block || 8;
    g.stop();
    var i;
    for (i = 0; i < 600; i++) g._fixedUpdate(1 / 120);   // settle
    for (i = 0; i < 600; i++) g._fixedUpdate(1 / 120);   // warm the JIT
    var blocks = Math.floor(steps / block);
    var out = new Array(blocks);
    for (var b = 0; b < blocks; b++) {
      var t0 = performance.now();
      for (i = 0; i < block; i++) g._fixedUpdate(1 / 120);
      out[b] = (performance.now() - t0) / block;
    }
    g.start();
    return out;
  };

  /**
   * Spin the real render loop for a fixed WALL duration before anything is measured.
   *
   * The per-scenario warmup is counted in frames, and at 800 fps in the menu 120 frames
   * is 150 ms — far too short for a discrete GPU to leave its idle power state. Measured
   * consequence: the same menu scenario reported 0.89 ms in one repeat and 1.13 ms in the
   * next, purely from clock ramp. This burn-in runs in the menu, before any match starts,
   * so it warms the clocks without touching simulation determinism.
   */
  P.burnIn = function (ms) {
    return new Promise(function (resolve) {
      var t0 = performance.now();
      var n = 0;
      var tick = function () {
        n++;
        if (performance.now() - t0 >= ms) { resolve({ ms: Math.round(performance.now() - t0), frames: n }); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  };

  P.state = function () {
    return {
      state: g.state, frame: g.frame, time: g.time,
      bots: g.bots ? g.bots.bots.length : 0,
      programs: renderer.info.programs ? renderer.info.programs.length : 0,
      phase: g.match ? g.match.phase : null,
    };
  };

  P.setLockDt = function (v) { lockDt = !!v; };

  function capture(mode, frames) {
    return new Promise(function (resolve) {
      pendingResolve = resolve;
      P.start({ mode: mode, frames: frames });
    });
  }

  /**
   * Run one whole scenario without returning to Node in between.
   *
   * This is not a convenience wrapper — it is a correctness requirement. Every await
   * across the Playwright boundary costs an unpredictable number of rendered frames, and
   * since the simulation advances a fixed 1/60 s per frame, that means the match is in a
   * different state at the start of the sample on every repeat: bots stand somewhere
   * else, different things are on fire, and the "repeat spread" measures the harness
   * rather than the game. Driving the whole scenario from inside the page makes every
   * phase boundary land on an exact frame, so repeat N renders the same scene as repeat 1.
   */
  P.runScenario = function (sc, cfg) {
    var out = { scenario: sc.name };
    return Promise.resolve()
      .then(function () {
        out.heapBefore = P.heap();
        out.programsBefore = renderer.info.programs ? renderer.info.programs.length : 0;
        out.setup = P.setup(sc);
        if (sc.streaks) out.streaks = P.arm();
        // Phase 1 — shader compile / first-seconds hitching, from frame zero, no warmup.
        return capture('frame', cfg.hitchFrames);
      })
      .then(function (hitch) {
        out.hitch = hitch;
        // Phase 2 — let lazy program links finish, then pad to a fixed frame count.
        return P.settle({ maxFrames: cfg.settleMax, quiet: cfg.settleQuiet, padTo: cfg.settleFrames });
      })
      .then(function (settle) {
        out.settle = settle;
        if (sc.streaks) P.arm();
        out.programsAtSample = renderer.info.programs ? renderer.info.programs.length : 0;
        // Phase 3 — headline: GPU frame time, CPU split, frame pacing.
        return capture('frame', cfg.warmup + cfg.frames);
      })
      .then(function (main) {
        out.main = main;
        if (sc.streaks) P.arm();
        // Phase 4 — per-pass GPU breakdown with split timer queries.
        return capture('passes', cfg.warmup + cfg.passFrames);
      })
      .then(function (passes) {
        out.passes = passes;
        // Phase 5 — pure CPU simulation cost with the renderer stopped.
        out.stepped = P.stepped(cfg.simSteps);
        out.heapAfter = P.heap();
        return out;
      });
  };

  window.__P = P;
  return { ok: true, timerQuery: !!ext };
})()
`;

// ───────────────────────────────────────────────────────────── table printing ──

export function pad(s, n, right = false) {
  s = String(s);
  if (s.length >= n) return s;
  const fill = ' '.repeat(n - s.length);
  return right ? fill + s : s + fill;
}

export function printTable(rows, cols) {
  const w = cols.map((c) => Math.max(c.h.length, ...rows.map((r) => String(c.f(r) ?? '').length)));
  console.log(cols.map((c, i) => pad(c.h, w[i], c.r)).join('  '));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(cols.map((c, i) => pad(c.f(r) ?? '', w[i], c.r)).join('  '));
}
