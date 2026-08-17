/**
 * AUDIT PROBE 1 — long-match growth curve.
 *
 * Plays ~5 simulated minutes of a real TDM match by driving game._fixedUpdate +
 * game._update directly (advancing game.time correctly so respawn timers fire),
 * sampling every 15 simulated seconds:
 *
 *   - performance.memory.usedJSHeapSize          (JS heap)
 *   - renderer.info.memory.geometries / textures (GPU resources)
 *   - renderer.info.programs.length              (shader programs)
 *   - scene / viewScene object counts            (scene-graph growth)
 *   - bus listener count per event name          (listener leaks)
 *   - a deep scan of every array/Map/Set reachable from the game object,
 *     so an unbounded container shows up by name rather than by guesswork.
 *
 * Chromium is launched with --enable-precise-memory-info and --js-flags=--expose-gc
 * so heap numbers are real and can be taken after a forced GC.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MINUTES = Number(process.argv[2] || 5);

const server = await createServer({
  root: ROOT, configFile: path.join(ROOT, 'vite.config.js'),
  server: { port: 5211, strictPort: false }, logLevel: 'error',
});
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio',
    '--enable-precise-memory-info', '--js-flags=--expose-gc',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__GAME__?.state === 'menu', null, { timeout: 180000, polling: 200 });

const out = await page.evaluate(async (minutes) => {
  const g = window.__GAME__;
  const R = { samples: [], notes: [] };

  // ---- deep container scan -------------------------------------------------
  // Walk the object graph from `game`, recording the size of every Array/Map/Set
  // found, keyed by its path. Cheap enough at 15 s intervals.
  const scan = () => {
    const sizes = {};
    const seen = new WeakSet();
    const walk = (obj, pathStr, depth) => {
      if (!obj || depth > 5) return;
      if (typeof obj !== 'object') return;
      if (seen.has(obj)) return;
      seen.add(obj);
      if (obj.isVector3 || obj.isColor || obj.isQuaternion || obj.isMatrix4 || obj.isEuler) return;
      if (obj.isBufferGeometry || obj.isMaterial || obj.isTexture || obj.isWebGLRenderer) return;
      if (Array.isArray(obj)) {
        sizes[pathStr] = obj.length;
        if (obj.length && obj.length < 64) {
          for (let i = 0; i < Math.min(obj.length, 4); i++) walk(obj[i], `${pathStr}[]`, depth + 1);
        }
        return;
      }
      if (obj instanceof Map || obj instanceof Set) { sizes[pathStr] = obj.size; return; }
      for (const k of Object.keys(obj)) {
        if (k === 'game' || k === 'parent' || k === 'scene' || k === 'renderer') continue;
        let v;
        try { v = obj[k]; } catch { continue; }
        if (v && typeof v === 'object') walk(v, pathStr ? `${pathStr}.${k}` : k, depth + 1);
      }
    };
    for (const k of ['world', 'nav', 'match', 'player', 'bots', 'weapons', 'projectiles', 'fx', 'audio', 'hud', 'menu', 'engine', 'input']) {
      if (g[k]) walk(g[k], k, 0);
    }
    return sizes;
  };

  const countScene = (s) => { let n = 0; s.traverse(() => n++); return n; };
  const busCounts = () => {
    const o = {};
    let total = 0;
    for (const [k, set] of g.bus.map) { o[k] = set.size; total += set.size; }
    return { total, per: o };
  };
  const domCount = () => document.querySelectorAll('*').length;

  const sample = (label) => {
    if (window.gc) { try { window.gc(); } catch { /* ignore */ } }
    const mem = performance.memory || {};
    const info = g.renderer.info;
    return {
      label,
      simSec: +g.time.toFixed(1),
      heapMB: mem.usedJSHeapSize ? +(mem.usedJSHeapSize / 1048576).toFixed(2) : null,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      sceneObjs: countScene(g.scene),
      viewObjs: countScene(g.engine.viewScene),
      dom: domCount(),
      bus: busCounts(),
      containers: scan(),
    };
  };

  // ---- run -----------------------------------------------------------------
  g.startMatch({ mode: 'tdm', botCount: 8, difficulty: 'regular', seed: 1234 });
  // Make the clock long enough that a 5-minute run cannot end the match.
  g.match.timeLimit = 100000;

  const step = () => {
    g.time += 1 / 120;
    g.frame++;
    g._fixedUpdate(1 / 120);
    g._update(1 / 120);
  };

  // Warm up 5 s so pools reach steady state before the baseline sample.
  for (let i = 0; i < 120 * 5; i++) step();
  R.samples.push(sample('t=5s baseline'));

  const totalSec = minutes * 60;
  for (let s = 5; s < totalSec; s += 15) {
    for (let i = 0; i < 120 * 15; i++) step();
    R.samples.push(sample(`t=${s + 15}s`));
  }

  R.finalPhase = g.match.phase;
  R.scores = [g.match.scores[0], g.match.scores[1]];
  R.bookSize = g.match._book.size;
  R.botCount = g.bots.bots.length;
  R.playerKills = g.player.stats.kills;
  R.playerDeaths = g.player.stats.deaths;
  return R;
}, MINUTES);

// ---- report ---------------------------------------------------------------
const first = out.samples[0];
const last = out.samples[out.samples.length - 1];

const line = (s) => `${String(s.label).padEnd(12)} heap=${String(s.heapMB).padStart(8)}MB geo=${String(s.geometries).padStart(5)} tex=${String(s.textures).padStart(4)} prog=${String(s.programs).padStart(3)} scene=${String(s.sceneObjs).padStart(5)} view=${String(s.viewObjs).padStart(4)} dom=${String(s.dom).padStart(5)} bus=${String(s.bus.total).padStart(4)}`;
console.log('\n=========== LONG MATCH GROWTH (' + MINUTES + ' sim minutes) ===========');
for (const s of out.samples) console.log('  ' + line(s));

console.log('\n--- deltas over the run ---');
const dHeap = last.heapMB - first.heapMB;
console.log(`  heap        ${first.heapMB} -> ${last.heapMB} MB   (${dHeap >= 0 ? '+' : ''}${dHeap.toFixed(2)} MB, ${(dHeap / (MINUTES - 5 / 60)).toFixed(2)} MB/min)`);
console.log(`  geometries  ${first.geometries} -> ${last.geometries}   (${last.geometries - first.geometries >= 0 ? '+' : ''}${last.geometries - first.geometries})`);
console.log(`  textures    ${first.textures} -> ${last.textures}`);
console.log(`  programs    ${first.programs} -> ${last.programs}`);
console.log(`  sceneObjs   ${first.sceneObjs} -> ${last.sceneObjs}`);
console.log(`  viewObjs    ${first.viewObjs} -> ${last.viewObjs}`);
console.log(`  domNodes    ${first.dom} -> ${last.dom}`);
console.log(`  busListen   ${first.bus.total} -> ${last.bus.total}`);

const busGrew = Object.keys(last.bus.per).filter((k) => (last.bus.per[k] || 0) !== (first.bus.per[k] || 0));
if (busGrew.length) {
  console.log('\n--- bus listener counts that changed ---');
  for (const k of busGrew) console.log(`  ${k}: ${first.bus.per[k] || 0} -> ${last.bus.per[k]}`);
}

console.log('\n--- containers that grew (top 40 by absolute growth) ---');
const grew = [];
for (const k of Object.keys(last.containers)) {
  const a = first.containers[k];
  const b = last.containers[k];
  if (a === undefined || b === undefined) continue;
  if (b > a) grew.push({ k, a, b, d: b - a });
}
grew.sort((x, y) => y.d - x.d);
for (const r of grew.slice(0, 40)) {
  // Is it monotonic? Check every sample.
  const series = out.samples.map((s) => s.containers[r.k]);
  const mono = series.every((v, i) => i === 0 || v >= series[i - 1]);
  console.log(`  ${r.k.padEnd(52)} ${String(r.a).padStart(6)} -> ${String(r.b).padStart(6)}  (+${r.d})${mono ? '  MONOTONIC' : ''}`);
  console.log(`      series: ${series.join(' ')}`);
}
if (!grew.length) console.log('  (none)');

console.log(`\nmatch: phase=${out.finalPhase} scores=${out.scores} book=${out.bookSize} bots=${out.botCount} playerK/D=${out.playerKills}/${out.playerDeaths}`);
if (logs.length) { console.log('\nconsole errors:'); for (const l of [...new Set(logs)].slice(0, 20)) console.log('  ' + l); }
console.log('=========================================================\n');

fs.mkdirSync(path.join(ROOT, 'shots'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'shots', 'auditleak.json'), JSON.stringify(out, null, 1));

await browser.close();
await server.close();
