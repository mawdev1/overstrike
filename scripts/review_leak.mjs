/** THROWAWAY REVIEW PROBE — GPU resource lifetime + visual sanity. Safe to delete. */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = path.join(ROOT, 'shots');
const out = {};
let server, browser;

try {
  server = await createServer({
    root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
    server: { port: 5186, strictPort: false }, logLevel: 'error',
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];

  browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
      '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--window-size=1600,900'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.setDefaultTimeout(120000);
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 120000 });
  await page.evaluate(() => window.__GAME__.startMatch({ mode: 'tdm', botCount: 7, difficulty: 'regular' }));
  await page.waitForFunction(() => window.__GAME__.state === 'playing');
  await page.waitForTimeout(3000);

  // --- clean perf sample (no instrumentation attached)
  out.perf = await page.evaluate(async () => {
    const e = window.__GAME__.engine;
    const s = [];
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      s.push(e.stats.frameMs);
    }
    s.sort((a, b) => a - b);
    return {
      medianFrameMs: +s[90].toFixed(2), p95FrameMs: +s[171].toFixed(2),
      fps: e.stats.fps, drawCalls: e.stats.drawCalls, triangles: e.stats.triangles,
      programs: e.renderer.info.programs.length,
    };
  });

  await page.screenshot({ path: path.join(SHOT, 'review-head.png') });

  // --- banding survey on the sky (claim 2: R11F dark gradients)
  out.banding = await page.evaluate(async () => {
    const g = window.__GAME__;
    // look up at the sky
    g.player.pitch = 0.9;
    await new Promise((r) => setTimeout(r, 400));
    const cv = g.engine.renderer.domElement;
    const c2 = document.createElement('canvas');
    c2.width = cv.width; c2.height = cv.height;
    const ctx = c2.getContext('2d');
    ctx.drawImage(cv, 0, 0);
    const col = Math.floor(c2.width * 0.5);
    const d = ctx.getImageData(col, 0, 1, c2.height).data;
    const lum = [];
    for (let y = 0; y < c2.height; y++) {
      const i = y * 4;
      lum.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    }
    // step statistics down the vertical strip
    let maxStep = 0, steps = 0, flatRuns = 0, run = 0;
    for (let y = 1; y < lum.length; y++) {
      const dl = Math.abs(lum[y] - lum[y - 1]);
      if (dl > maxStep) maxStep = dl;
      if (dl >= 1) { steps++; if (run > 6) flatRuns++; run = 0; } else run++;
    }
    return {
      height: c2.height, minLum: Math.min(...lum), maxLum: Math.max(...lum),
      maxAdjacentStep: +maxStep.toFixed(2),
      stepCount: steps, plateausLongerThan6px: flatRuns,
      distinctLumValues: new Set(lum.map((v) => Math.round(v))).size,
    };
  });

  // --- GPU resource lifetime across a context-loss rebuild
  out.leak = await page.evaluate(async () => {
    const e = window.__GAME__.engine;
    const gl = e.renderer.getContext();
    const ext = gl.getExtension('WEBGL_lose_context');
    const idOf = () => ({
      bloomPassObj: e.bloomPass,
      bloomTexUuid: e.bloomPass.renderTargetsHorizontal[0].texture.uuid,
      brightUuid: e.bloomPass.renderTargetBright.texture.uuid,
      compositeMatUuid: e.compositePass.material.uuid,
      rt1TexUuid: e.composer.renderTarget1.texture.uuid,
      aoTargetUuid: e.aoPass.aoTarget.texture.uuid,
      skyGeoUuid: e.sky.geometry.uuid,
    });
    const before = idOf();
    const beforeBloom = before.bloomPassObj;
    // does UnrealBloomPass even expose dispose()?
    const bloomHasDispose = typeof beforeBloom.dispose === 'function';
    // count the render targets the OLD bloom pass owns
    const oldTargets = 1 + beforeBloom.renderTargetsHorizontal.length + beforeBloom.renderTargetsVertical.length;
    // is composer.dispose() going to touch passes at all?
    const composerDisposeSrc = e.composer.constructor.prototype.dispose.toString();

    ext.loseContext();
    await new Promise((r) => setTimeout(r, 300));
    ext.restoreContext();
    await new Promise((r) => setTimeout(r, 3000));

    const after = idOf();
    // Was the OLD bloom pass disposed? three sets nothing observable, so probe the
    // renderer properties map for the old textures instead: if they were disposed the
    // 'dispose' event fired and properties were removed. We instead check identity +
    // whether the old object is still reachable and un-disposed.
    return {
      bloomHasDispose,
      oldBloomTargetCount: oldTargets,
      bloomPassReplaced: after.bloomPassObj !== beforeBloom,
      bloomTexReplaced: after.bloomTexUuid !== before.bloomTexUuid,
      compositeMatReplaced: after.compositeMatUuid !== before.compositeMatUuid,
      rt1TexReplaced: after.rt1TexUuid !== before.rt1TexUuid,
      aoTargetReplaced: after.aoTargetUuid !== before.aoTargetUuid,
      skyGeoReplaced: after.skyGeoUuid !== before.skyGeoUuid,
      // old bloom pass still holds live three objects nobody disposed
      oldBloomStillHasTargets: !!beforeBloom.renderTargetsHorizontal?.[0],
      composerDisposeTouchesPasses: /passes/.test(composerDisposeSrc),
      composerDisposeSrc: composerDisposeSrc.replace(/\s+/g, ' ').slice(0, 260),
      drawCallsAfter: e.stats.drawCalls,
      sceneStillHasSky: e.scene.children.includes(e.sky),
      settingsListenerCount: window.__GAME__.settings.listeners?.size,
    };
  });

  // --- repeated rebuilds: does anything grow without bound?
  out.repeat = await page.evaluate(async () => {
    const e = window.__GAME__.engine;
    const grab = () => ({
      textures: e.renderer.info.memory.textures,
      geometries: e.renderer.info.memory.geometries,
      programs: e.renderer.info.programs.length,
      settingsListeners: window.__GAME__.settings.listeners?.size,
    });
    const samples = [grab()];
    for (let i = 0; i < 3; i++) {
      e._rebuildGpuResources();
      await new Promise((r) => setTimeout(r, 700));
      samples.push(grab());
    }
    return samples;
  });

  await page.screenshot({ path: path.join(SHOT, 'review-after-rebuilds.png') });
  out.finalStats = await page.evaluate(() => ({ ...window.__GAME__.engine.stats }));
} catch (err) {
  out.fatal = String(err?.stack || err);
} finally {
  await browser?.close();
  await server?.close();
}
console.log(JSON.stringify(out, null, 2));
