/**
 * THROWAWAY REVIEW PROBE (review_*). Audits the bot-rig InstancedMesh pool in a REAL
 * running match, every frame, immediately after BotManager.update() (i.e. after all
 * blits, before the render).
 *
 * Per frame, per team, it checks:
 *   A  mesh.count === number of live models on that team          (count too big -> garbage
 *                                                                  instances; too small -> a
 *                                                                  live bot never drawn)
 *   B  every visible model's slot holds ITS OWN head-bone world matrix
 *      (a mismatch = a bot rendered at another bot's position)
 *   C  the shared bounding sphere contains every visible bot      (undersized -> vanish)
 *   D  no drawn instance sits at the world origin with non-zero scale (rig at 0,0,0)
 *   E  no drawn instance has a zero-scale matrix while its owner is alive+visible
 *
 * It then stresses the pool: kills bots, restarts the match, and flips the player's team
 * (which makes _configureRoster dispose+recreate every model, i.e. maximum compaction).
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server, browser;
const out = { errors: [], stages: {} };

try {
  server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.js'),
    server: { port: 5197, strictPort: true },
    logLevel: 'warn',
  });
  await server.listen();
  const url = server.resolvedUrls.local[0];
  console.log(`[rig] dev server ${url}`);

  browser = await chromium.launch({
    headless: true,
    args: [
      '--use-gl=angle', '--use-angle=d3d11', '--enable-gpu',
      '--ignore-gpu-blocklist', '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,720',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(180000);
  await page.addInitScript(() => {
    try {
      const KEY = 'overstrike.settings.v1';
      const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
      localStorage.setItem(KEY, JSON.stringify({ ...cur, renderScale: 0.5 }));
    } catch { /* private mode */ }
  });
  page.on('pageerror', (e) => out.errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') out.errors.push(`console.error: ${m.text()}`); });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__GAME__ && window.__GAME__.state === 'menu',
    null, { timeout: 180000, polling: 250 });
  console.log('[rig] booted');

  // ------------------------------------------------------------- install auditor
  await page.evaluate(() => {
    const g = window.__GAME__;
    const scene = g.scene || g.engine.scene;
    const R = (window.__RIG_AUDIT__ = {
      frames: 0, violations: [], maxCountDelta: 0,
      countSamples: [], drawCalls: [], tris: [],
      sphereR: [], slotSwaps: 0, prevSlots: new Map(),
    });
    const note = (msg) => { if (R.violations.length < 40) R.violations.push(`f${g.frame}: ${msg}`); };
    const meshesFor = (t) => scene.children.filter((o) => o.name && o.name.startsWith('bot' + t + '_'));
    const M = new (g.engine.scene.constructor.prototype.constructor ? Object : Object)();
    const THREE_M4 = scene.matrixWorld.constructor;           // THREE.Matrix4
    const tmp = new THREE_M4();

    function audit() {
      R.frames++;
      const bots = g.bots?.bots || [];
      for (const t of [0, 1]) {
        const meshes = meshesFor(t);
        if (!meshes.length) continue;
        const count = meshes[0].count;
        for (const m of meshes) if (m.count !== count) note(`t${t} ${m.name}.count=${m.count} != ${count}`);

        const live = bots.filter((b) => b.model && !b.model.disposed && b.model.team === t && b.model.slot >= 0);
        // A
        if (count !== live.length) {
          R.maxCountDelta = Math.max(R.maxCountDelta, Math.abs(count - live.length));
          note(`t${t} count=${count} but ${live.length} live models`);
        }
        // slot uniqueness
        const bySlot = new Map();
        for (const b of live) {
          if (bySlot.has(b.model.slot)) note(`t${t} slot ${b.model.slot} shared by ${b.name} and ${bySlot.get(b.model.slot).name}`);
          bySlot.set(b.model.slot, b);
          const prev = R.prevSlots.get(b.model);
          if (prev !== undefined && prev !== b.model.slot) R.slotSwaps++;
          R.prevSlots.set(b.model, b.model.slot);
        }

        const headMeshIx = meshes.findIndex((m) => m.name.endsWith('_head'));
        const headMesh = meshes[headMeshIx];
        const sphere = meshes[0].boundingSphere;
        if (!sphere) note(`t${t} no boundingSphere`);
        for (const m of meshes) if (m.boundingSphere !== sphere) note(`t${t} ${m.name} sphere differs`);

        for (const b of live) {
          const mdl = b.model;
          if (!mdl.visible) continue;
          headMesh.getMatrixAt(mdl.slot, tmp);
          const e = tmp.elements;
          const w = mdl.bones.head.matrixWorld.elements;
          // B
          let bad = 0;
          for (let k = 12; k < 15; k++) if (Math.abs(e[k] - w[k]) > 1e-4) bad++;
          if (bad) {
            note(`t${t} ${b.name} slot ${mdl.slot} head drawn at (${e[12].toFixed(2)},${e[13].toFixed(2)},${e[14].toFixed(2)}) `
              + `but bone is at (${w[12].toFixed(2)},${w[13].toFixed(2)},${w[14].toFixed(2)})`);
          }
          // E
          if (e[0] === 0 && e[5] === 0 && e[10] === 0) note(`t${t} ${b.name} slot ${mdl.slot} zero-scale while visible`);
          // C
          if (sphere) {
            const d = Math.hypot(w[12] - sphere.center.x, w[13] - sphere.center.y, w[14] - sphere.center.z);
            if (d > sphere.radius) note(`t${t} ${b.name} head ${d.toFixed(2)} m outside sphere r=${sphere.radius.toFixed(2)} -> culled while visible`);
          }
        }
        // D — any DRAWN instance parked at the origin with a real scale
        for (let s = 0; s < count; s++) {
          headMesh.getMatrixAt(s, tmp);
          const e = tmp.elements;
          const nonZero = !(e[0] === 0 && e[5] === 0 && e[10] === 0);
          if (nonZero && Math.abs(e[12]) < 1e-6 && Math.abs(e[13]) < 1e-6 && Math.abs(e[14]) < 1e-6) {
            note(`t${t} drawn instance ${s} sits at the world origin`);
          }
        }
        R.countSamples.push([t, count, live.length]);
        if (sphere) R.sphereR.push(+sphere.radius.toFixed(2));
      }
      const info = g.renderer.info.render;
      R.drawCalls.push(info.calls); R.tris.push(info.triangles);
      if (R.countSamples.length > 4000) R.countSamples.splice(0, 2000);
      if (R.sphereR.length > 4000) R.sphereR.splice(0, 2000);
      if (R.drawCalls.length > 4000) { R.drawCalls.splice(0, 2000); R.tris.splice(0, 2000); }
    }

    const orig = g.bots.update.bind(g.bots);
    g.bots.update = (dt) => { orig(dt); try { audit(); } catch (e) { R.violations.push('audit threw: ' + e.message); } };
  });

  console.log('[rig] auditor installed:', await page.evaluate(() => !!window.__RIG_AUDIT__));
  page.on('framenavigated', () => console.log('[rig] !! page navigated'));

  // ------------------------------------------------------------- run a match
  await page.evaluate(() => window.__GAME__.startMatch({ mode: 'tdm', botCount: 12, difficulty: 'regular' }));
  await page.waitForTimeout(500);
  console.log('[rig] after startMatch, auditor present:', await page.evaluate(() => !!window.__RIG_AUDIT__),
    'frames:', await page.evaluate(() => window.__RIG_AUDIT__ ? window.__RIG_AUDIT__.frames : -1));
  await page.waitForTimeout(6000);
  out.stages.match1 = await page.evaluate(() => {
    const R = window.__RIG_AUDIT__, g = window.__GAME__;
    return {
      frames: R.frames, violations: R.violations.slice(0, 10), slotSwaps: R.slotSwaps,
      counts: [...new Set(R.countSamples.map((c) => c.join('/')))].slice(0, 12),
      sphereRadius: { min: Math.min(...R.sphereR), max: Math.max(...R.sphereR) },
      drawCalls: Math.max(...R.drawCalls), tris: Math.max(...R.tris),
      aliveT0: g.bots.aliveCount(0), aliveT1: g.bots.aliveCount(1),
    };
  });

  // ------------------------------------------------- kill several bots at once
  await page.evaluate(() => {
    const g = window.__GAME__;
    const bots = g.bots.bots.filter((b) => b.alive);
    for (let i = 0; i < Math.min(5, bots.length); i++) bots[i].die({ attacker: g.player, weaponId: 'ar_vector' });
  });
  await page.waitForTimeout(1200);
  out.stages.massKill = await page.evaluate(() => {
    const R = window.__RIG_AUDIT__;
    return { violations: R.violations.slice(0, 10), n: R.violations.length };
  });

  // -------------------------------------- flip the player's team -> full model churn
  await page.evaluate(() => {
    const g = window.__GAME__;
    g.player.team = g.player.team === 0 ? 1 : 0;
    g.bots._configureRoster();          // disposes and recreates EVERY model
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__GAME__.startMatch({ mode: 'tdm', botCount: 12, difficulty: 'regular' }));
  await page.waitForTimeout(5000);

  // -------------------------------------- shrink + grow the roster mid-session
  await page.evaluate(() => { window.__GAME__.bots.setCount(3); });
  await page.waitForTimeout(1200);
  await page.evaluate(() => { window.__GAME__.bots.setCount(16); });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.__GAME__.startMatch({ mode: 'tdm', botCount: 16, difficulty: 'hard' }));
  await page.waitForTimeout(5000);

  out.stages.final = await page.evaluate(() => {
    const R = window.__RIG_AUDIT__, g = window.__GAME__;
    return {
      frames: R.frames, totalViolations: R.violations.length,
      violations: R.violations.slice(0, 20),
      slotSwaps: R.slotSwaps, maxCountDelta: R.maxCountDelta,
      distinctCounts: [...new Set(R.countSamples.map((c) => c.join('/')))].slice(0, 20),
      sphereRadius: { min: Math.min(...R.sphereR), max: Math.max(...R.sphereR) },
      drawCalls: Math.max(...R.drawCalls), tris: Math.max(...R.tris),
      alive: [g.bots.aliveCount(0), g.bots.aliveCount(1)],
      rosterSlots: g.bots.bots.map((b) => `${b.team}:${b.model ? b.model.slot : 'x'}`),
    };
  });

  await page.screenshot({ path: path.join(ROOT, 'shots', 'review-rig.png') });
} catch (e) {
  out.errors.push('harness: ' + (e.stack || e.message));
} finally {
  await browser?.close().catch(() => {});
  await server?.close().catch(() => {});
}
console.log(JSON.stringify(out, null, 1));
process.exit(0);
