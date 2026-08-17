/**
 * OVERSTRIKE — CPU submit attribution.
 *
 *   node scripts/cpuattr.mjs
 *
 * The main perf report shows `engine.render` JS time (CPU submit) running ~1.5x the
 * GPU's own frame time, which makes the game CPU-bound rather than fill-bound. That
 * number is only actionable if we know WHAT it is paying for, so this probe re-measures
 * it with parts of the frame switched off, one at a time, on the real GPU:
 *
 *   full         everything on
 *   noPost       composer bypassed entirely — renderer.render(scene, camera) only
 *   noShadow     shadow map off (removes ~72 of ~195 draws)
 *   noShadowPost both off — this is the floor for "submit the opaque scene"
 *   emptyScene   world hidden, post off — three's per-frame overhead with no draws
 *
 * The deltas attribute the submit cost to draw calls vs post-processing vs three's
 * fixed per-frame work. `renderer.info.calls` is reported alongside so cost per draw
 * call falls out directly.
 *
 * Everything is measured inside one page, back to back, with the camera pinned, so the
 * only variable between conditions is the thing being toggled.
 */
import { startServer, launchBrowser, EARLY_SRC, settingsInitScript, stat, r3 } from './perflib.mjs';

const FRAMES = 400;
const WARMUP = 120;

const server = await startServer({ dev: false, port: 5397, doBuild: true });
const browser = await launchBrowser({});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.setDefaultTimeout(300000);
await page.addInitScript(EARLY_SRC);
await page.addInitScript(settingsInitScript({ renderScale: 1.0, postFx: true, shadows: true }));

const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.goto(server.url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__ && window.__GAME__.state === 'menu', null, { polling: 200 });

const out = await page.evaluate(async ({ FRAMES, WARMUP }) => {
  const g = window.__GAME__;
  const eng = g.engine;
  const renderer = g.renderer;

  g.settings.set('botCount', 8);
  g.startMatch({ mode: 'tdm', difficulty: 'veteran', seed: 4242 });
  for (let i = 0; i < 900; i++) g._fixedUpdate(1 / 120);

  // Pin the camera so every condition renders an identical view.
  const p = g.player;
  const PIN = { x: -25, y: 0, z: 5, yaw: 4.014, pitch: 0 };
  const pin = () => {
    if (!p) return;
    p.position.set(PIN.x, PIN.y, PIN.z);
    p.yaw = PIN.yaw; p.pitch = PIN.pitch;
    eng.camera.position.set(PIN.x, PIN.y + 1.62, PIN.z);
    eng.camera.rotation.set(PIN.pitch, PIN.yaw, 0);
    eng.camera.updateMatrixWorld(true);
  };

  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));

  async function measure(label, setup, teardown) {
    setup();
    // Warm up so any state change settles and the JIT is hot.
    for (let i = 0; i < WARMUP; i++) { pin(); eng.update(1 / 60); eng.render(1 / 60); await raf(); }
    const samples = [];
    let calls = 0, tris = 0;
    for (let i = 0; i < FRAMES; i++) {
      pin();
      eng.update(1 / 60);
      const t = performance.now();
      eng.render(1 / 60);
      samples.push(performance.now() - t);
      calls = renderer.info.render.calls;
      tris = renderer.info.render.triangles;
      await raf();
    }
    teardown();
    return { label, samples, calls, tris };
  }

  const rows = [];
  const origRender = eng.render.bind(eng);

  // full
  rows.push(await measure('full', () => {}, () => {}));

  // noPost — bypass the composer completely
  rows.push(await measure('noPost',
    () => {
      eng.render = function (dt) {
        renderer.info.reset();
        renderer.setRenderTarget(null);
        renderer.render(eng.scene, eng.camera);
      };
    },
    () => { eng.render = origRender; }));

  // noShadow
  rows.push(await measure('noShadow',
    () => { renderer.shadowMap.enabled = false; },
    () => { renderer.shadowMap.enabled = true; }));

  // noShadowPost
  rows.push(await measure('noShadowPost',
    () => {
      renderer.shadowMap.enabled = false;
      eng.render = function (dt) {
        renderer.info.reset();
        renderer.setRenderTarget(null);
        renderer.render(eng.scene, eng.camera);
      };
    },
    () => { renderer.shadowMap.enabled = true; eng.render = origRender; }));

  // emptyScene — hide the world group, no post, no shadows
  rows.push(await measure('emptyScene',
    () => {
      renderer.shadowMap.enabled = false;
      eng.__hidden = [];
      eng.scene.children.forEach((c) => { if (c.visible) { eng.__hidden.push(c); c.visible = false; } });
      eng.render = function (dt) {
        renderer.info.reset();
        renderer.setRenderTarget(null);
        renderer.render(eng.scene, eng.camera);
      };
    },
    () => {
      renderer.shadowMap.enabled = true;
      eng.__hidden.forEach((c) => { c.visible = true; });
      eng.render = origRender;
    }));

  return { rows, programs: renderer.info.programs ? renderer.info.programs.length : 0 };
}, { FRAMES, WARMUP });

const pad = (s, n, right = false) => {
  s = String(s);
  return right ? s.padEnd(n) : s.padStart(n);
};

console.log('\n============ CPU SUBMIT ATTRIBUTION (1920x1080, real GPU) ============');
console.log('engine.render JS time — this is CPU cost of submitting the frame, not GPU work.\n');
console.log(`${pad('condition', 14, true)} ${pad('median', 7)} ${pad('mean', 7)} ${pad('p95', 7)} ${pad('draws', 6)} ${pad('tris', 9)} ${pad('us/draw', 8)}`);
console.log('-'.repeat(64));

const byLabel = {};
for (const r of out.rows) {
  const s = stat(r.samples);
  byLabel[r.label] = s.median;
  const usPerDraw = r.calls > 0 ? (s.median * 1000) / r.calls : 0;
  console.log(
    `${pad(r.label, 14, true)} ${pad(r3(s.median), 7)} ${pad(r3(s.mean), 7)} ${pad(r3(s.p95), 7)} ` +
    `${pad(r.calls, 6)} ${pad(r.tris.toLocaleString(), 9)} ${pad(usPerDraw.toFixed(1), 8)}`,
  );
}

console.log('\n---- attribution ----');
const d = (a, b) => r3(byLabel[a] - byLabel[b]);
console.log(`post-processing chain          ${pad(d('full', 'noPost'), 7)} ms`);
console.log(`shadow pass (submit only)      ${pad(d('full', 'noShadow'), 7)} ms`);
console.log(`opaque scene draws             ${pad(d('noShadowPost', 'emptyScene'), 7)} ms`);
console.log(`three fixed per-frame overhead ${pad(r3(byLabel.emptyScene), 7)} ms`);
console.log(`\nprograms: ${out.programs}`);
if (errors.length) console.log('\npage errors:', [...new Set(errors)].slice(0, 5));

await browser.close();
await server.close();
