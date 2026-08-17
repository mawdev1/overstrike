/**
 * Verification probe for the fx/ai/weapons/props perf work.
 * Runs on the REAL GPU (d3d11 ANGLE). Usage: node verify.mjs <label>
 *
 * Phases:
 *   1. props/draw-calls  — 6 fixed viewpoints, botCount 0, screenshots + info.render.calls
 *   2. lights            — programs.length while the FX point-light pool goes 0 -> 5 -> 0
 *   3. muzzle/decal      — fire at a wall, screenshot flash + decals, count decals
 */
import path from 'node:path';
import fs from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const ROOT = 'C:/Users/Jamie/Desktop/Code Projects/overstrike';
const REAL_GPU_ARGS = ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu',
  '--ignore-gpu-blocklist', '--mute-audio', '--autoplay-policy=no-user-gesture-required'];
const settingsInitScript = (o) => `
(() => { try {
  const KEY = 'overstrike.settings.v1';
  const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
  localStorage.setItem(KEY, JSON.stringify(Object.assign({}, cur, ${JSON.stringify(o)})));
} catch (e) {} })();`;

const LABEL = process.argv[2] || 'run';
const OUT = path.join('C:/Users/Jamie/AppData/Local/Temp/claude/C--Users-Jamie-Desktop-Code-Projects-overstrike/12c28293-c127-474e-bda3-6116727498f5/scratchpad', 'shots', LABEL);
fs.mkdirSync(OUT, { recursive: true });

const R = { label: LABEL };
const vite = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5411, strictPort: false, hmr: false, watch: null }, logLevel: 'error',
});
await vite.listen();
const server = { url: vite.resolvedUrls.local[0], close: () => vite.close() };
const browser = await chromium.launch({ headless: true, args: REAL_GPU_ARGS });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(180000);
await page.addInitScript(settingsInitScript({ renderScale: 1.0 }));
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(server.url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { polling: 250 });

// A frame-accurate readback of the default framebuffer, reduced to 16x9 tile means.
// Comparable run to run without needing a PNG decoder on the node side.
await page.evaluate(() => {
  window.__cap = () => new Promise((res) => {
    const g = window.__GAME__, eng = g.engine, gl = g.renderer.getContext();
    const orig = eng.render.bind(eng);
    eng.render = function (dt) {
      orig(dt);
      eng.render = orig;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const TX = 16, TY = 9, tiles = new Array(TX * TY * 3).fill(0);
      const cnt = new Array(TX * TY).fill(0);
      for (let y = 0; y < h; y++) {
        const ty = Math.min(TY - 1, (y * TY / h) | 0);
        for (let x = 0; x < w; x++) {
          const tx = Math.min(TX - 1, (x * TX / w) | 0);
          const t = ty * TX + tx, i = (y * w + x) * 4;
          tiles[t * 3] += px[i]; tiles[t * 3 + 1] += px[i + 1]; tiles[t * 3 + 2] += px[i + 2];
          cnt[t]++;
        }
      }
      for (let t = 0; t < TX * TY; t++) {
        for (let c = 0; c < 3; c++) tiles[t * 3 + c] = Math.round(tiles[t * 3 + c] / cnt[t] * 100) / 100;
      }
      res(tiles);
    };
  });
});

// ───────────────────────────────────────────────── phase 1: props / draw calls
await page.evaluate(() => window.__GAME__.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 20260817 }));
await page.waitForTimeout(2500);

R.propStats = await page.evaluate(() => {
  const g = window.__GAME__;
  let inst = 0, mesh = 0, instTotal = 0;
  const singles = [];
  g.scene.traverse((o) => {
    if (o.isInstancedMesh) {
      inst++; instTotal += o.count;
      if (o.count <= 3 && o.name.startsWith('inst_')) {
        const gg = o.geometry;
        singles.push(`${o.name} x${o.count} (${(gg.index ? gg.index.count : gg.attributes.position.count) / 3} tris)`);
      }
    } else if (o.isMesh) mesh++;
  });
  return { instancedMeshes: inst, instancedTotal: instTotal, plainMeshes: mesh, smallInstanced: singles.sort() };
});

const SHOTS = await page.evaluate(() => {
  const g = window.__GAME__;
  const V = g.player.position.constructor;
  const eye = new V(), dir = new V();
  const cands = [];
  for (const sp of g.world.spawnPoints) {
    for (let i = 0; i < 24; i++) {
      const yaw = (i / 24) * Math.PI * 2;
      eye.set(sp.position.x, sp.position.y + 1.62, sp.position.z);
      dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      const hit = g.world.raycast(eye, dir, 90);
      cands.push({ x: sp.position.x, y: sp.position.y, z: sp.position.z, yaw, openness: hit ? hit.distance : 90 });
    }
  }
  cands.sort((a, b) => b.openness - a.openness);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= 6) break;
    if (picked.some((p) => Math.hypot(p.x - c.x, p.z - c.z) < 14)) continue;
    picked.push(c);
  }
  return picked.map((c, i) => ({ name: `view-${i + 1}`, pos: [c.x, c.y, c.z], yaw: c.yaw, pitch: -0.04 }));
});

R.views = [];
for (const s of SHOTS) {
  await page.evaluate((shot) => {
    const g = window.__GAME__, p = g.player;
    p.position.set(shot.pos[0], shot.pos[1], shot.pos[2]);
    p.velocity.set(0, 0, 0);
    p.yaw = shot.yaw; p.pitch = shot.pitch;
    if (p.camera) {
      p.camera.baseYaw = shot.yaw; p.camera.basePitch = shot.pitch;
      p.camera.recoilPitch = p.camera.recoilYaw = 0;
      p.camera.recoilPitchTarget = p.camera.recoilYawTarget = 0;
    }
    g.input.actions.clear();
    g.input.buttons[0] = g.input.buttons[2] = false;
  }, s);
  await page.waitForTimeout(900);
  const tiles = await page.evaluate(() => window.__cap());
  const st = await page.evaluate(() => ({
    calls: window.__GAME__.engine.stats.drawCalls,
    tris: window.__GAME__.engine.stats.triangles,
    programs: window.__GAME__.renderer.info.programs.length,
    geometries: window.__GAME__.renderer.info.memory.geometries,
  }));
  await page.screenshot({ path: path.join(OUT, `${s.name}.png`) });
  R.views.push({ name: s.name, ...st, tiles });
}

// ───────────────────────────────────────────────────────── phase 2: light pool
R.lights = await page.evaluate(async () => {
  const g = window.__GAME__, fx = g.fx;
  const out = { max: fx.lights ? fx.lights.length : 0, asc: [], desc: [] };
  const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // clean slate
  for (let i = 0; i < fx.lights.length; i++) { fx._lightLife[i] = 0; fx.lights[i].intensity = 0; }
  await raf(); await raf();
  const eye = new (g.player.position.constructor)();
  g.player.getEyePosition(eye);
  out.asc.push(g.renderer.info.programs.length);
  for (let k = 0; k < out.max; k++) {
    fx._light(eye.x + k * 0.3, eye.y, eye.z - 2, 1, 0.8, 0.5, 4, 1e6, 2);
    await raf(); await raf(); await raf();
    out.asc.push(g.renderer.info.programs.length);
  }
  out.liveAtPeak = fx._liveLights();
  out.visibleAtPeak = fx.lights.filter((l) => l.visible).length;
  for (let k = out.max - 1; k >= 0; k--) {
    fx._lightLife[k] = 0; fx.lights[k].intensity = 0;
    await raf(); await raf(); await raf();
    out.desc.push(g.renderer.info.programs.length);
  }
  out.visibleAtRest = fx.lights.filter((l) => l.visible).length;
  out.intensityAtRest = fx.lights.map((l) => l.intensity);

  // A/B/A/B: only `visible` flips, intensity pinned at 0. If a zero-intensity light
  // illuminates anything, on-vs-off must exceed the off-vs-off noise floor.
  const setVis = (v) => {
    for (let i = 0; i < fx.lights.length; i++) {
      fx._lightLife[i] = 0;
      fx.lights[i].intensity = 0;
      fx.lights[i].position.set(eye.x, eye.y, eye.z - 1.2);
      fx.lights[i].distance = 20;
      fx.lights[i].visible = v;
    }
  };
  out.ab = [];
  for (let k = 0; k < 6; k++) {
    setVis(k % 2 === 1);
    await raf();
    out.ab.push({ on: k % 2 === 1, tiles: await window.__cap() });
  }
  setVis(false);
  return out;
});
// with the pool at rest, re-shoot view-1: proves zero-intensity lights illuminate nothing
await page.evaluate((shot) => {
  const g = window.__GAME__, p = g.player;
  p.position.set(shot.pos[0], shot.pos[1], shot.pos[2]);
  p.velocity.set(0, 0, 0);
  p.yaw = shot.yaw; p.pitch = shot.pitch;
  if (p.camera) { p.camera.baseYaw = shot.yaw; p.camera.basePitch = shot.pitch; }
}, SHOTS[0]);
await page.waitForTimeout(700);
R.viewAfterLights = await page.evaluate(() => window.__cap());
await page.screenshot({ path: path.join(OUT, 'view-1-lights-at-rest.png') });

// ────────────────────────────────────────────── phase 3: muzzle flash + decals
R.fire = await page.evaluate(async () => {
  const g = window.__GAME__, p = g.player;
  const V = p.position.constructor;
  const eye = new V(), dir = new V();
  // Find a spot with a wall roughly 6 m ahead so impacts land in frame.
  let best = null;
  for (const sp of g.world.spawnPoints) {
    for (let i = 0; i < 32; i++) {
      const yaw = (i / 32) * Math.PI * 2;
      eye.set(sp.position.x, sp.position.y + 1.62, sp.position.z);
      dir.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      const hit = g.world.raycast(eye, dir, 20);
      if (hit && hit.distance > 4 && hit.distance < 9) {
        if (!best || Math.abs(hit.distance - 6) < Math.abs(best.d - 6)) {
          best = { x: sp.position.x, y: sp.position.y, z: sp.position.z, yaw, d: hit.distance };
        }
      }
    }
  }
  if (!best) return { ok: false };
  p.position.set(best.x, best.y, best.z);
  p.velocity.set(0, 0, 0);
  p.yaw = best.yaw; p.pitch = -0.02;
  if (p.camera) { p.camera.baseYaw = best.yaw; p.camera.basePitch = -0.02; }
  const before = g.fx.decals.liveCount;
  const w = p.weapon;
  let fired = 0;
  for (let i = 0; i < 40; i++) {
    if (w?.tryFire?.()) fired++;
    for (let s = 0; s < 12; s++) { w?.fixedUpdate?.(1 / 120); }
    p.camera && (p.camera.recoilPitch = p.camera.recoilYaw = 0, p.camera.recoilPitchTarget = p.camera.recoilYawTarget = 0);
  }
  return { ok: true, wallDist: Math.round(best.d * 100) / 100, fired, decalsBefore: before, decalsAfter: g.fx.decals.liveCount };
});
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'fire-decals.png') });

// live muzzle flash: fire and grab a frame straight after
R.flash = await page.evaluate(async () => {
  const g = window.__GAME__;
  const w = g.player.weapon;
  w?.reload?.();
  for (let s = 0; s < 400; s++) w?.fixedUpdate?.(1 / 120);
  const cap = window.__cap();
  w?.tryFire?.();
  const tiles = await cap;
  return { ammo: w?.ammo, tiles };
});
await page.screenshot({ path: path.join(OUT, 'muzzle.png') });

R.errors = [...new Set(errs)].slice(0, 8);
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(R, null, 1));
console.log(JSON.stringify({
  label: LABEL,
  propStats: R.propStats,
  views: R.views.map((v) => ({ name: v.name, calls: v.calls, tris: v.tris, programs: v.programs, geometries: v.geometries })),
  lights: { max: R.lights.max, asc: R.lights.asc, desc: R.lights.desc, visibleAtPeak: R.lights.visibleAtPeak, visibleAtRest: R.lights.visibleAtRest, intensityAtRest: R.lights.intensityAtRest },
  fire: R.fire,
  errors: R.errors,
}, null, 1));

await browser.close();
await server.close();
