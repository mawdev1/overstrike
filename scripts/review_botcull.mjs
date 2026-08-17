/**
 * THROWAWAY REVIEW PROBE (review_*). Quantifies how often the per-team bot-rig
 * bounding sphere actually culls, for both the camera and the sun's shadow camera.
 * The sphere is a UNION over the whole team, so culling is all-or-nothing per team.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server, browser;
let out = {};
try {
  server = await createServer({
    root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
    server: { port: 5197, strictPort: true }, logLevel: 'warn',
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist',
      '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,720'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(180000);
  await page.addInitScript(() => {
    try {
      const KEY = 'overstrike.settings.v1';
      const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
      localStorage.setItem(KEY, JSON.stringify({ ...cur, renderScale: 0.5 }));
    } catch { /* ignore */ }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__GAME__ && window.__GAME__.state === 'menu', null,
    { timeout: 180000, polling: 250 });

  await page.evaluate(() => {
    const g = window.__GAME__;
    const scene = g.scene || g.engine.scene;
    const S = (window.__CULL__ = { n: 0, camCull: [0, 0], sunCull: [0, 0], r: [], span: null });

    // 6 frustum planes from a projScreenMatrix, plain arrays — no THREE import needed.
    function planes(m) {
      const e = m.elements, p = [];
      const row = (i) => [e[3 + 0] + i * 0, 0, 0, 0];       // placeholder, replaced below
      const P = (a, b, c, d) => { const l = Math.hypot(a, b, c); p.push([a / l, b / l, c / l, d / l]); };
      P(e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]);   // right
      P(e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]);   // left
      P(e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]);   // bottom
      P(e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]);   // top
      P(e[3] - e[2], e[7] - e[6], e[11] - e[10], e[15] - e[14]);  // far
      P(e[3] + e[2], e[7] + e[6], e[11] + e[10], e[15] + e[14]);  // near
      return p;
    }
    const outside = (pl, s) => pl.some((q) =>
      q[0] * s.center.x + q[1] * s.center.y + q[2] * s.center.z + q[3] < -s.radius);

    const M4 = scene.matrixWorld.constructor;
    const tmp = new M4();
    const orig = g.bots.update.bind(g.bots);
    g.bots.update = (dt) => {
      orig(dt);
      const cam = g.camera || g.engine.camera;
      cam.updateMatrixWorld();
      tmp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      const camP = planes(tmp);
      const sun = g.engine.sun?.shadow?.camera;
      let sunP = null;
      if (sun) { sun.updateMatrixWorld(); tmp.multiplyMatrices(sun.projectionMatrix, sun.matrixWorldInverse); sunP = planes(tmp); }
      S.n++;
      for (const t of [0, 1]) {
        const m = scene.children.find((o) => o.name === `bot${t}_head`);
        if (!m || !m.boundingSphere || m.count === 0) continue;
        if (outside(camP, m.boundingSphere)) S.camCull[t]++;
        if (sunP && outside(sunP, m.boundingSphere)) S.sunCull[t]++;
        S.r.push(+m.boundingSphere.radius.toFixed(1));
      }
      const b = g.world?.bounds;
      if (b && !S.span) S.span = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z].map((v) => +v.toFixed(1));
    };
  });

  await page.evaluate(() => window.__GAME__.startMatch({ mode: 'tdm', botCount: 12, difficulty: 'regular' }));
  await page.waitForTimeout(15000);
  out = await page.evaluate(() => {
    const S = window.__CULL__;
    const r = S.r.slice().sort((a, b) => a - b);
    return {
      frames: S.n, worldSpan: S.span,
      cameraCulledFrames: S.camCull, shadowCulledFrames: S.sunCull,
      sphereRadius: { min: r[0], median: r[r.length >> 1], max: r[r.length - 1] },
    };
  });
} catch (e) {
  out.error = e.message;
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
}
console.log(JSON.stringify(out, null, 1));
process.exit(0);
