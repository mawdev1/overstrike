/**
 * THROWAWAY REVIEW PROBE — props.js static-bucket / vertex-colour folding audit.
 *
 * Boots the real game and reports:
 *   - draw calls + triangles under play (contract §11: <220 / <450k)
 *   - every world-group mesh: name, verts, tris, whether it carries a baked `color`
 *     attribute, and whether its material is a props.js clone rather than assets.mat()
 *   - extra VRAM spent on white `color` attributes forced onto merged buckets
 *   - collider count + hash (must be IDENTICAL to baseline — perf work may not change play)
 *   - decal cap + fx caps
 */
import { boot, report } from './auditlib.mjs';

const { page, errors, consoleErrors, close } = await boot({
  port: 5195,
  args: ['--use-angle=swiftshader'],
});

await page.evaluate(() => window.__GAME__.startMatch({ mode: 'tdm', botCount: 6, seed: 7 }));
await page.waitForFunction(() => window.__GAME__.state === 'playing', null, { polling: 100 });
await new Promise((r) => setTimeout(r, 3000));

const out = await page.evaluate(() => {
  const g = window.__GAME__;
  const meshes = [];
  let colorBytes = 0, coloredBuckets = 0, clonedMats = 0;
  const matNames = new Set();
  g.world.group.traverse((o) => {
    if (!(o.isMesh || o.isInstancedMesh)) return;
    const geo = o.geometry;
    const verts = geo.attributes.position ? geo.attributes.position.count : 0;
    const tris = (geo.index ? geo.index.count : verts) / 3;
    const hasColor = !!geo.attributes.color;
    if (hasColor) { coloredBuckets++; colorBytes += verts * 3 * 4; }
    // is this material one of assets' library materials?
    let inLib = false;
    for (const [k, m] of g.assets.materials) if (m === o.material) { inLib = true; matNames.add(k); break; }
    if (!inLib) clonedMats++;
    meshes.push({
      name: o.name, kind: o.isInstancedMesh ? `inst x${o.count}` : 'mesh',
      verts, tris, hasColor, vertexColors: !!o.material?.vertexColors, inLib,
    });
  });

  // collider fingerprint — must not change
  let h = 2166136261;
  const mix = (v) => { h ^= Math.round(v * 4096) | 0; h = Math.imul(h, 16777619); };
  for (const b of g.world.boxes) {
    mix(b.min.x); mix(b.min.y); mix(b.min.z);
    mix(b.max.x); mix(b.max.y); mix(b.max.z);
    for (let i = 0; i < String(b.surface).length; i++) mix(String(b.surface).charCodeAt(i));
  }

  const info = g.renderer.info;
  return {
    render: { calls: info.render.calls, triangles: info.render.triangles, programs: info.programs?.length ?? null },
    memory: { geometries: info.memory.geometries, textures: info.memory.textures },
    colliders: { count: g.world.boxes.length, hash: (h >>> 0).toString(16) },
    buckets: { total: meshes.length, coloredBuckets, clonedMats, extraColorKB: Math.round(colorBytes / 1024) },
    fx: g.fx.debugInfo ? g.fx.debugInfo({}) : null,
    colored: meshes.filter((m) => m.hasColor).map((m) => `${m.name} verts=${m.verts} tris=${m.tris} vc=${m.vertexColors} inLib=${m.inLib}`),
    totalVerts: meshes.reduce((s, m) => s + m.verts, 0),
    top3: meshes.slice().sort((a, b) => b.tris - a.tris).slice(0, 3).map((m) => `${m.name} v=${m.verts}`),
    instCount: meshes.filter((m) => m.kind.startsWith('inst')).length,
  };
});

report('props / GPU audit', out);
console.log('pageerrors:', errors);
console.log('console errors:', consoleErrors.slice(0, 10));
await close();
