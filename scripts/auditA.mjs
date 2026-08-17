/**
 * AUDIT A — memory leaks / unbounded growth.
 *
 * Drives ~5 simulated minutes of a live TDM match (plus a second match) and samples,
 * at fixed intervals:
 *   • performance.memory (with --enable-precise-memory-info)
 *   • renderer.info.memory (geometries / textures) and info.programs
 *   • bus listener counts per event name
 *   • scene / viewScene child counts
 *   • the size of EVERY array / Map / Set reachable from `game` within 5 levels
 *
 * Anything whose count rises monotonically across samples is a growth suspect; the
 * probe prints the deltas so the growth curve is visible rather than asserted.
 */
import { boot, report } from './auditlib.mjs';

const h = await boot({ port: 5301, viewport: { width: 640, height: 480 } });
const { page } = h;

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  const R = { samples: [], notes: [] };

  // ---------------------------------------------------------------- sampling
  const SKIP_KEYS = new Set(['game', 'parent', 'children', '_listeners', 'domElement']);

  /** Walk the game graph and record the size of every array/Map/Set we can reach. */
  const collectSizes = () => {
    const sizes = {};
    const seen = new Set();
    const walk = (obj, pathStr, depth) => {
      if (!obj || depth > 5 || typeof obj !== 'object') return;
      if (seen.has(obj)) return;
      seen.add(obj);
      // Do not descend into THREE objects — huge, and their counts are covered by
      // renderer.info. We still record their child counts at the top level.
      if (obj.isObject3D || obj.isBufferGeometry || obj.isMaterial || obj.isTexture) return;
      let keys;
      try { keys = Object.keys(obj); } catch { return; }
      for (const k of keys) {
        if (SKIP_KEYS.has(k)) continue;
        let v;
        try { v = obj[k]; } catch { continue; }
        if (v == null) continue;
        const p = pathStr ? `${pathStr}.${k}` : k;
        if (Array.isArray(v)) {
          sizes[p] = v.length;
          if (v.length && v.length < 400 && typeof v[0] === 'object') walk(v[0], `${p}[0]`, depth + 1);
        } else if (v instanceof Map || v instanceof Set) {
          sizes[p] = v.size;
        } else if (typeof v === 'object') {
          walk(v, p, depth + 1);
        }
      }
    };
    walk(g, '', 0);
    return sizes;
  };

  const busCounts = () => {
    const o = {};
    let total = 0;
    for (const [name, set] of g.bus.map) { o[name] = set.size; total += set.size; }
    o.__total = total;
    return o;
  };

  const sample = (label) => {
    if (window.gc) { try { window.gc(); } catch { /* ignore */ } }
    const info = g.renderer.info;
    const mem = performance.memory
      ? Math.round(performance.memory.usedJSHeapSize / 1024)
      : null;
    R.samples.push({
      label,
      simTime: +g.time.toFixed(1),
      matchElapsed: +(g.match?.elapsed ?? 0).toFixed(1),
      heapKB: mem,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      sceneChildren: g.scene.children.length,
      viewSceneChildren: g.engine.viewScene.children.length,
      domNodes: document.querySelectorAll('*').length,
      bus: busCounts(),
      sizes: collectSizes(),
    });
  };

  const sim = (n) => { for (let i = 0; i < n; i++) g._fixedUpdate(1 / 120); };
  // Keep the render path alive too — decals/particles/tracers retire in update(dtFrame),
  // so a sim-only loop would over-report their occupancy.
  const simAndRender = (steps, dtFrame = 1 / 60) => {
    for (let i = 0; i < steps; i++) {
      g._fixedUpdate(1 / 120);
      if (i % 2 === 1) { g._update(dtFrame); g.engine.update(dtFrame); }
    }
  };

  // ------------------------------------------------------------------ run
  g.settings.set('botCount', 9);
  g.startMatch({ mode: 'tdm', botCount: 9, difficulty: 'veteran', seed: 12345 });
  sim(600);                       // burn the countdown
  sample('t=5s');

  // 5 simulated minutes in 30 s chunks. The player is kept alive and shooting so the
  // decal / tracer / particle / killfeed paths all stay hot.
  const p = g.player;
  for (let chunk = 0; chunk < 10; chunk++) {
    for (let i = 0; i < 120 * 30; i++) {
      g._fixedUpdate(1 / 120);
      if (i % 2 === 1) { g._update(1 / 60); g.engine.update(1 / 60); }
      // Player fires continuously at whatever is in front of them.
      if (p.alive) {
        p.weapon?.tryFire?.();
        if (i % 240 === 0) p.yaw += 0.7;
      }
    }
    sample(`t=${(chunk + 1) * 30 + 5}s`);
    if (g.state !== 'playing') { R.notes.push(`match ended early at chunk ${chunk} (state=${g.state})`); break; }
  }

  // Second match — does anything survive the reset?
  g.returnToMenu();
  sample('menu-after-match-1');
  g.startMatch({ mode: 'tdm', botCount: 9, difficulty: 'veteran', seed: 12345 });
  simAndRender(120 * 30);
  sample('match-2-t=30s');
  g.returnToMenu();
  g.startMatch({ mode: 'tdm', botCount: 9, difficulty: 'veteran', seed: 12345 });
  simAndRender(120 * 30);
  sample('match-3-t=30s');
  g.returnToMenu();
  sample('menu-after-match-3');

  return R;
});

// ------------------------------------------------------------------ analysis
const S = out.samples;
const first = S[0];
const last = S[S.length - 1];

console.log('\n=========== AUDIT A — GROWTH ===========');
console.log('sample                heapKB  geo  tex  prog  scene  dom   busTotal');
for (const s of S) {
  console.log(
    `${s.label.padEnd(20)} ${String(s.heapKB).padStart(7)} ${String(s.geometries).padStart(4)} ` +
    `${String(s.textures).padStart(4)} ${String(s.programs).padStart(5)} ${String(s.sceneChildren).padStart(6)} ` +
    `${String(s.domNodes).padStart(5)} ${String(s.bus.__total).padStart(9)}`,
  );
}

// Bus listeners per event across the run.
console.log('\nbus listeners per event (first -> last):');
const evNames = new Set([...Object.keys(first.bus), ...Object.keys(last.bus)]);
for (const n of [...evNames].sort()) {
  if (n === '__total') continue;
  const a = first.bus[n] ?? 0;
  const b = last.bus[n] ?? 0;
  if (a !== b) console.log(`  !! ${n}: ${a} -> ${b}`);
}
if ([...evNames].every((n) => (first.bus[n] ?? 0) === (last.bus[n] ?? 0))) {
  console.log('  (no change — no listener accumulation)');
}

// Monotonic growth detector over the in-match samples only.
const inMatch = S.filter((s) => s.label.startsWith('t='));
const keys = new Set();
for (const s of inMatch) for (const k of Object.keys(s.sizes)) keys.add(k);
const growers = [];
for (const k of keys) {
  const series = inMatch.map((s) => s.sizes[k]).filter((v) => v !== undefined);
  if (series.length < 4) continue;
  const delta = series[series.length - 1] - series[0];
  if (delta <= 0) continue;
  let nonDecreasing = true;
  for (let i = 1; i < series.length; i++) if (series[i] < series[i - 1]) nonDecreasing = false;
  if (nonDecreasing && delta >= 2) growers.push({ key: k, series, delta });
}
growers.sort((a, b) => b.delta - a.delta);
console.log('\nmonotonically growing collections during the match:');
if (!growers.length) console.log('  (none)');
for (const gr of growers.slice(0, 30)) {
  console.log(`  +${gr.delta}  ${gr.key}  [${gr.series.join(', ')}]`);
}

// Cross-match residue: what is non-zero back in the menu?
const menu1 = S.find((s) => s.label === 'menu-after-match-1');
const menu3 = S.find((s) => s.label === 'menu-after-match-3');
if (menu1 && menu3) {
  console.log('\ncollections larger in menu-after-match-3 than menu-after-match-1:');
  const rows = [];
  for (const k of Object.keys(menu3.sizes)) {
    const a = menu1.sizes[k];
    const b = menu3.sizes[k];
    if (a === undefined || b <= a) continue;
    rows.push(`  ${k}: ${a} -> ${b}`);
  }
  console.log(rows.length ? rows.join('\n') : '  (none)');
}

if (out.notes.length) console.log('\nnotes:', out.notes);
if (h.errors.length) console.log('\npage errors:', [...new Set(h.errors)].slice(0, 10));
if (h.consoleErrors.length) console.log('\nconsole errors:', [...new Set(h.consoleErrors)].slice(0, 10));

report('raw first/last', { first: { heapKB: first.heapKB, geometries: first.geometries, textures: first.textures }, last: { heapKB: last.heapKB, geometries: last.geometries, textures: last.textures } });

await h.close();
