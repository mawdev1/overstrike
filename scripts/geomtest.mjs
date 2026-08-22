/**
 * geomtest — wall geometry audit for any registered map (default: the active rotation
 * map, The Square; `--map=<id>` selects any registered map, in or out of rotation,
 * exactly like maptest — e.g. `--map=square-extraction` audits the raid map).
 *
 * Everything here is measured on the REAL collider set (world.boxes), because authored
 * intent in level.js and what the Builder emits are not the same thing: `wall()` splits
 * runs around openings, `slab()` splits around stair holes, `prop()` stamps rotated
 * template colliders. Authoring bugs show up in the emitted AABBs, not in the source.
 *
 * Checks
 *   1 SEAMS      pairs of surfaces that nearly touch — a slit narrower than a doorway
 *                that nothing else fills. Includes vertical slits (wall short of the
 *                floor / short of the ceiling).
 *   2 OVERLAP    interpenetration deeper than an ordinary corner join, and entombment.
 *   3 FLOATING   colliders with no contact at all, or hanging above their support.
 *   4 ALIGN      near-coplanar wall segments (the copy-paste-and-nudge error) and
 *                near-level wall tops.
 *   5 OPENINGS   every authored door/window: clear width/height, obstruction, sill and
 *                lintel heights, and whether the hole goes all the way through.
 *   6 THICKNESS  thin structural boxes.
 *   7 SYMMETRY   near-miss matches under the map's mirror transforms.
 *
 * Usage:
 *   node scripts/geomtest.mjs                 # boot the active map and audit it
 *   node scripts/geomtest.mjs --map=square-extraction
 *   node scripts/geomtest.mjs /tmp/geom.json  # cache the collider dump there and reuse
 *   node scripts/geomtest.mjs --only=seam     # one section (seam|overlap|float|align|open|thin|sym)
 */
import fs from 'node:fs';
import { selectMap, getMapEntry, listMaps, activeMapId } from '../src/world/world.js';

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
const cache = process.argv.slice(2).find((a) => !a.startsWith('--')) || null;

const MAP_ARG = process.argv.slice(2).find((a) => a.startsWith('--map='));
if (MAP_ARG) {
  const id = MAP_ARG.slice('--map='.length);
  if (getMapEntry(id) === null) {
    console.error(`geomtest: no registered map '${id}'. Registered: ${listMaps().map((m) => m.id).join(', ')}`);
    process.exit(2);
  }
  selectMap(id);
}
const MAP_ID = activeMapId();
const MAP_MANIFEST = getMapEntry(MAP_ID)?.module?.MAP_MANIFEST ?? null;

/** DUMP FORMAT v2: colliders carry a `kind` recorded at emit time (see dump()). Old
 *  cache files predate that and would misclassify everything; refuse to reuse them. */
const DUMP_VERSION = 2;

/**
 * Boot the world headlessly and record, for every collider, the Builder method and the
 * level.js line that emitted it — so every defect below comes with a fix location — plus
 * every authored wall opening in world coordinates.
 */
async function dump() {
  const { Game } = await import('../src/core/game.js');
  const { NullPresenter } = await import('../src/core/presenter.js');
  const { World } = await import('../src/world/world.js');
  const { Builder } = await import('../src/world/props.js');

  const prov = new Map();
  const site = () => {
    const frames = [];
    for (const l of (new Error().stack || '').split('\n').slice(2)) {
      const m = l.match(/(src\/world\/[a-zA-Z]+\.js):(\d+):\d+/);
      if (m) frames.push(`${m[1]}:${m[2]}`);
      if (frames.length >= 6) break;
    }
    return frames;
  };
  // Which Builder method emitted each collider — recorded AT EMIT TIME by wrapping the
  // public emitters and reading the outermost wrapped frame when a box lands. This used
  // to be a table of props.js LINE-NUMBER ranges, which forced props.js to freeze the
  // line numbering of its whole emitter section (a fragility its maintainer note had to
  // carry and this file never mentioned); method-name tracking cannot go stale when
  // props.js gains or loses a line.
  const KINDS = ['box', 'deco', 'slab', 'floorFinish', 'groundPlane', 'wall', 'beam',
    'cable', 'cylinder', 'stairs', 'ramp', 'parapet', 'railing', 'railingSloped',
    'doorFrame', 'prop', ['_glassPane', 'glass']];
  const kindStack = [];
  for (const entry of KINDS) {
    const [method, label] = Array.isArray(entry) ? entry : [entry, entry];
    const orig = Builder.prototype[method];
    if (typeof orig !== 'function') {
      throw new Error(`geomtest: Builder.prototype.${method} no longer exists — update the KINDS list`);
    }
    Builder.prototype[method] = function (...a) {
      kindStack.push(label);
      try { return orig.apply(this, a); } finally { kindStack.pop(); }
    };
  }
  for (const name of ['addBox', 'addBoxRaw']) {
    const orig = World.prototype[name];
    World.prototype[name] = function (...a) {
      const b = orig.apply(this, a);
      prov.set(b, { src: site(), kind: kindStack.length ? kindStack[0] : '?' });
      return b;
    };
  }
  const walls = [];
  const origWall = Builder.prototype.wall;
  Builder.prototype.wall = function (x0, z0, x1, z1, y0, y1, mat, surf = 'concrete', opts = {}) {
    walls.push({
      x0, z0, x1, z1, y0, y1, mat, surf,
      alongX: Math.abs(x1 - x0) >= Math.abs(z1 - z0),
      src: site().find((f) => f.startsWith('src/world/level')) || null,
      openings: (opts.openings || []).map((o) => ({
        a0: o.a0, a1: o.a1, y0: o.y0 ?? y0, y1: o.y1 ?? y1,
        glass: !!o.glass, frame: o.frame || null,
      })),
    });
    return origWall.apply(this, arguments);
  };

  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter() });
  return {
    v: DUMP_VERSION,
    mapId: MAP_ID,
    bounds: { min: game.world.bounds.min.toArray(), max: game.world.bounds.max.toArray() },
    boxes: game.world.boxes.map((b, i) => {
      const p = prov.get(b) || { src: [], kind: '?' };
      return {
        i,
        min: [b.min.x, b.min.y, b.min.z],
        max: [b.max.x, b.max.y, b.max.z],
        surface: b.surface,
        src: p.src,
        kind: p.kind,
      };
    }),
    walls,
  };
}

let D = cache && fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, 'utf8')) : await dump();
if (cache && (D.v !== DUMP_VERSION || D.mapId !== MAP_ID)) {
  console.log(`(cache ${cache} is v${D.v ?? 1}/'${D.mapId ?? '?'}', need v${DUMP_VERSION}/'${MAP_ID}' — re-dumping)`);
  D = await dump();
  fs.writeFileSync(cache, JSON.stringify(D));
}
if (cache && !fs.existsSync(cache)) fs.writeFileSync(cache, JSON.stringify(D));

// ── model ────────────────────────────────────────────────────────────────────────────
const AX = ['x', 'y', 'z'];
/** Architecture proper — the things that are supposed to line up and close. */
const ARCH = new Set(['box', 'slab', 'wall', 'parapet', 'groundPlane', 'glass', 'floorFinish']);
const boxes = D.boxes.map((b) => {
  const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const lvl = b.src.find((f) => f.startsWith('src/world/level.js')) || '?';
  return {
    ...b, size, lvl,
    isProp: b.kind === 'prop',
    thin: Math.min(...size),
    vol: size[0] * size[1] * size[2],
  };
});
const N = boxes.length;
const fmt = (v, n = 2) => Number(v).toFixed(n);
const pos = (b) => `(${fmt(b.min[0])},${fmt(b.min[1])},${fmt(b.min[2])})-(${fmt(b.max[0])},${fmt(b.max[1])},${fmt(b.max[2])})`;
const ctr = (b) => `(${fmt((b.min[0] + b.max[0]) / 2)},${fmt((b.min[1] + b.max[1]) / 2)},${fmt((b.min[2] + b.max[2]) / 2)})`;
const ov = (a, b, k) => Math.min(a.max[k], b.max[k]) - Math.max(a.min[k], b.min[k]);
const tag = (b) => `#${b.i} ${b.kind}/${b.surface} ${b.lvl}`;

// uniform grid broadphase
const CELL = 4;
const grid = new Map();
const key = (i, j, k) => `${i},${j},${k}`;
for (const b of boxes) {
  for (let i = Math.floor(b.min[0] / CELL); i <= Math.floor(b.max[0] / CELL); i++)
    for (let j = Math.floor(b.min[1] / CELL); j <= Math.floor(b.max[1] / CELL); j++)
      for (let k = Math.floor(b.min[2] / CELL); k <= Math.floor(b.max[2] / CELL); k++) {
        const kk = key(i, j, k);
        let l = grid.get(kk); if (!l) grid.set(kk, l = []);
        l.push(b);
      }
}
function near(b, pad = 0.6) {
  const out = new Set();
  for (let i = Math.floor((b.min[0] - pad) / CELL); i <= Math.floor((b.max[0] + pad) / CELL); i++)
    for (let j = Math.floor((b.min[1] - pad) / CELL); j <= Math.floor((b.max[1] + pad) / CELL); j++)
      for (let k = Math.floor((b.min[2] - pad) / CELL); k <= Math.floor((b.max[2] + pad) / CELL); k++)
        for (const o of grid.get(key(i, j, k)) || []) if (o !== b) out.add(o);
  return out;
}
/** Is point p inside any collider (optionally excluding a set)? */
function occupied(p, skip) {
  const i = Math.floor(p[0] / CELL), j = Math.floor(p[1] / CELL), k = Math.floor(p[2] / CELL);
  for (const o of grid.get(key(i, j, k)) || []) {
    if (skip && skip.has(o)) continue;
    if (p[0] > o.min[0] && p[0] < o.max[0] && p[1] > o.min[1] && p[1] < o.max[1]
      && p[2] > o.min[2] && p[2] < o.max[2]) return o;
  }
  return null;
}

const R = { seam: [], overlap: [], floating: [], align: [], openings: [], thin: [], sym: [], clean: [] };

// ── 1 SEAMS ──────────────────────────────────────────────────────────────────────────
// Pairs whose faces are separated by a small gap while their cross-sections overlap:
// the classic accidental slit. Then the slit volume is sampled to see whether anything
// else fills it, so joints that a third box closes are not reported.
// Structural = authored architecture, not a prop or a piece of furniture: something with
// a clear thin axis that is big enough to be a wall, slab, parapet or step.
const struct = new Set(boxes.filter((b) => !b.isProp && b.thin <= 1.0
  && Math.max(...b.size) >= 1.5));
if (!only || only === 'seam') {
  const GAP_MAX = 0.35;        // wider than this is a doorway, not a seam
  const MIN_AREA = 0.05;       // m² of shared cross-section
  const seen = new Set();
  for (const a of struct) {
    for (const b of near(a, GAP_MAX + 0.05)) {
      if (b.i <= a.i || !struct.has(b)) continue;
      const o = [ov(a, b, 0), ov(a, b, 1), ov(a, b, 2)];
      const negs = o.filter((v) => v < 0);
      if (negs.length !== 1) continue;
      const g = -negs[0];
      if (g <= 1e-4 || g > GAP_MAX) continue;
      const k = o.indexOf(negs[0]);
      // Two parallel plates a few centimetres apart (a railing in front of a wall, the
      // treads of a stair) are not a seam: they were never meant to join. A seam is a
      // gap along an axis that at least one of the two boxes RUNS along.
      if (a.size.indexOf(a.thin) === k && b.size.indexOf(b.thin) === k) continue;
      const p = [0, 1, 2].filter((x) => x !== k);
      const area = o[p[0]] * o[p[1]];
      if (area < MIN_AREA) continue;
      // the slit volume
      const lo = [], hi = [];
      for (const ax of [0, 1, 2]) {
        if (ax === k) { lo[ax] = Math.min(a.max[ax], b.max[ax]); hi[ax] = Math.max(a.min[ax], b.min[ax]); }
        else { lo[ax] = Math.max(a.min[ax], b.min[ax]); hi[ax] = Math.min(a.max[ax], b.max[ax]); }
      }
      // sample the slit's mid-plane
      const S = 0.05;
      const n0 = Math.max(2, Math.ceil((hi[p[0]] - lo[p[0]]) / S));
      const n1 = Math.max(2, Math.ceil((hi[p[1]] - lo[p[1]]) / S));
      let open = 0, tot = 0;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      const skip = new Set([a, b]);
      const fillers = new Set();
      for (let u = 0; u < n0; u++) for (let v = 0; v < n1; v++) {
        const pt = [];
        pt[k] = (lo[k] + hi[k]) / 2;
        pt[p[0]] = lo[p[0]] + (u + 0.5) * (hi[p[0]] - lo[p[0]]) / n0;
        pt[p[1]] = lo[p[1]] + (v + 0.5) * (hi[p[1]] - lo[p[1]]) / n1;
        tot++;
        const f = occupied(pt, skip);
        if (f) { fillers.add(f); continue; }
        open++;
        x0 = Math.min(x0, pt[p[0]]); x1 = Math.max(x1, pt[p[0]]);
        y0 = Math.min(y0, pt[p[1]]); y1 = Math.max(y1, pt[p[1]]);
      }
      if (!open) continue;
      const openArea = area * open / tot;
      if (openArea < MIN_AREA) continue;
      const id = `${a.i}-${b.i}`;
      if (seen.has(id)) continue; seen.add(id);
      R.seam.push({
        g, k, openArea, a, b,
        span: [x1 - x0, y1 - y0], axes: p,
        at: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
        fillers: [...fillers].slice(0, 3),
      });
    }
  }
  R.seam.sort((u, v) => v.openArea / Math.max(u.g, 0.01) - u.openArea / Math.max(v.g, 0.01));
}

// ── 2 OVERLAP ────────────────────────────────────────────────────────────────────────
if (!only || only === 'overlap') {
  for (const a of boxes) {
    for (const b of near(a, 0)) {
      if (b.i <= a.i) continue;
      const o = [ov(a, b, 0), ov(a, b, 1), ov(a, b, 2)];
      if (o.some((v) => v <= 1e-6)) continue;
      const vol = o[0] * o[1] * o[2];
      const pen = Math.min(...o);
      const small = a.vol <= b.vol ? a : b, big = a.vol <= b.vol ? b : a;
      const frac = vol / small.vol;
      R.overlap.push({ a, b, o, vol, pen, frac, small, big });
    }
  }
  R.overlap.sort((u, v) => v.vol - u.vol);
}

// ── 3 FLOATING ───────────────────────────────────────────────────────────────────────
if (!only || only === 'float') {
  for (const b of boxes) {
    let contacts = 0, supportArea = 0, best = null, drop = Infinity;
    const footprint = b.size[0] * b.size[2];
    for (const o of near(b, 0.05)) {
      const g = [ov(b, o, 0), ov(b, o, 1), ov(b, o, 2)];
      const negs = g.filter((v) => v < 0);
      if (negs.length === 0) { contacts++; continue; }               // interpenetrating
      if (negs.length === 1 && -negs[0] <= 0.02) contacts++;
      // support directly beneath
      if (g[0] > 1e-4 && g[2] > 1e-4 && o.max[1] <= b.min[1] + 1e-4) {
        const d = b.min[1] - o.max[1];
        if (d < drop) { drop = d; best = o; }
        if (d <= 0.02) supportArea += g[0] * g[2];
      }
    }
    R.floating.push({ b, contacts, supportArea, footprint, drop, best });
  }
}

// ── 4 ALIGNMENT ──────────────────────────────────────────────────────────────────────
// Wall-like: something with a clear thin axis, big enough to be architecture.
const wallish = boxes.filter((b) => !b.isProp && b.thin <= 1.2
  && b.size.filter((s) => s >= 1.0).length >= 2 && b.surface !== 'glass');
if (!only || only === 'align') {
  const seen = new Set();
  for (const a of wallish) {
    const ta = a.size.indexOf(a.thin);
    for (const b of near(a, 0.5)) {
      if (b.i <= a.i || !wallish.includes(b)) continue;
      const tb = b.size.indexOf(b.thin);
      if (ta !== tb) continue;
      const d0 = Math.abs(a.min[ta] - b.min[ta]), d1 = Math.abs(a.max[ta] - b.max[ta]);
      const d = Math.max(d0, d1);
      if (d <= 0.004 || d > 0.15) continue;
      // must be in the same wall line: adjacent or overlapping along the run, sharing height
      const other = [0, 1, 2].filter((k) => k !== ta);
      const runK = other.find((k) => k !== 1);
      if (ov(a, b, 1) < 0.5) continue;
      const runGap = -ov(a, b, runK);
      if (runGap > 0.05) continue;
      const id = `${a.i}-${b.i}`; if (seen.has(id)) continue; seen.add(id);
      R.align.push({ a, b, d, axis: AX[ta], kind: 'coplanar' });
    }
  }
  // wall tops that should be level
  for (const a of wallish) {
    for (const b of near(a, 0.3)) {
      if (b.i <= a.i || !wallish.includes(b)) continue;
      const ta = a.size.indexOf(a.thin), tb = b.size.indexOf(b.thin);
      if (ta !== tb || ta === 1) continue;
      if (Math.abs(a.min[ta] - b.min[ta]) > 0.05 || Math.abs(a.max[ta] - b.max[ta]) > 0.05) continue;
      const runK = [0, 2].find((k) => k !== ta);
      if (-ov(a, b, runK) > 0.05) continue;
      const dTop = Math.abs(a.max[1] - b.max[1]);
      if (dTop > 0.004 && dTop < 0.30) R.align.push({ a, b, d: dTop, axis: 'y', kind: 'top' });
    }
  }
  R.align.sort((u, v) => v.d - u.d);
}

// ── 5 OPENINGS ───────────────────────────────────────────────────────────────────────
if (!only || only === 'open') {
  // `shell()` builds one elevation as two stacked wall runs (base course + cladding) and
  // hands the SAME openings to both, so an opening that misses one band is not a hole —
  // it is served by the other. Merge the bands before judging, or every warehouse window
  // reads as "dead" and every roller door as "clipped".
  const merged = new Map();
  for (const w of D.walls) {
    for (const op of w.openings) {
      const k = [w.x0, w.z0, w.x1, w.z1, op.a0, op.a1, op.y0, op.y1].map((v) => v.toFixed(3)).join('|')
        .replace(/^[^|]*\|[^|]*\|[^|]*\|[^|]*\|/, (m) => m);   // keep footprint in key
      let g = merged.get(k);
      if (!g) merged.set(k, g = { w, op, bands: [] });
      g.bands.push([w.y0, w.y1]);
    }
  }
  D.walls = [...merged.values()].map(({ w, op, bands }) => ({
    ...w,
    y0: Math.min(...bands.map((b) => b[0])),
    y1: Math.max(...bands.map((b) => b[1])),
    openings: [op],
  }));
  for (const w of D.walls) {
    const alongX = w.alongX;
    const a0 = alongX ? Math.min(w.x0, w.x1) : Math.min(w.z0, w.z1);
    const a1 = alongX ? Math.max(w.x0, w.x1) : Math.max(w.z0, w.z1);
    const b0 = alongX ? Math.min(w.z0, w.z1) : Math.min(w.x0, w.x1);
    const b1 = alongX ? Math.max(w.z0, w.z1) : Math.max(w.x0, w.x1);
    for (const op of w.openings) {
      const oa0 = Math.max(a0, op.a0), oa1 = Math.min(a1, op.a1);
      const oy0 = Math.max(w.y0, op.y0), oy1 = Math.min(w.y1, op.y1);
      const rec = {
        wall: w, op, clipped: (oa0 !== op.a0 || oa1 !== op.a1 || oy0 !== op.y0 || oy1 !== op.y1),
        oa0, oa1, oy0, oy1, dead: oa1 <= oa0 || oy1 <= oy0,
      };
      if (rec.dead) { R.openings.push(rec); continue; }
      // Sample the opening cross-section; march the wall thickness at each sample.
      const S = 0.04;
      const na = Math.max(2, Math.ceil((oa1 - oa0) / S));
      const ny = Math.max(2, Math.ceil((oy1 - oy0) / S));
      const blockedBy = new Map();
      const grid2 = [];
      let blocked = 0, glassOnly = 0;
      for (let u = 0; u < na; u++) {
        grid2.push([]);
        for (let v = 0; v < ny; v++) {
          const a = oa0 + (u + 0.5) * (oa1 - oa0) / na;
          const y = oy0 + (v + 0.5) * (oy1 - oy0) / ny;
          let hit = null, onlyGlass = true;
          for (let t = 0; t <= 6; t++) {
            const bb = b0 - 0.25 + (b1 - b0 + 0.5) * t / 6;
            const p = alongX ? [a, y, bb] : [bb, y, a];
            const f = occupied(p);
            if (f) { hit = hit || f; if (f.surface !== 'glass') { onlyGlass = false; hit = f; } }
          }
          if (hit) {
            blocked++;
            if (onlyGlass) glassOnly++;
            else blockedBy.set(hit.i, (blockedBy.get(hit.i) || 0) + 1);
            grid2[u].push(onlyGlass ? 1 : 0);
          } else grid2[u].push(1);
        }
      }
      // largest all-clear axis-aligned rectangle (histogram method) in units of cells
      let bestW = 0, bestH = 0, bestArea = 0;
      const h = new Array(ny).fill(0);
      for (let u = 0; u < na; u++) {
        for (let v = 0; v < ny; v++) h[v] = grid2[u][v] ? h[v] + 1 : 0;
        const st = [];
        for (let v = 0; v <= ny; v++) {
          const cur = v === ny ? 0 : h[v];
          let start = v;
          while (st.length && st[st.length - 1][1] >= cur) {
            const [s, ht] = st.pop();
            const area = ht * (v - s);
            if (area > bestArea) {
              bestArea = area; bestW = ht * (oa1 - oa0) / na; bestH = (v - s) * (oy1 - oy0) / ny;
            }
            start = s;
          }
          st.push([start, cur]);
        }
      }
      // Floor level each side of the opening, so sill and headroom are relative to the
      // surface a player actually stands on.
      // Only real decks count as floor — not a desk that happens to be under a window.
      const floorAt = (aa, bb) => {
        let top = -Infinity;
        for (const d of [-0.4, -0.2, 0, 0.2, 0.4]) for (const e of [0, 0.35, 0.9]) {
          const bb2 = bb + Math.sign(bb - (b0 + b1) / 2) * e;
          const p = alongX ? [aa + d, 0, bb2] : [bb2, 0, aa + d];
          for (const o of boxes) {
            if (o.max[1] > oy0 + 0.05 || o.max[1] < -2) continue;
            if ((o.max[0] - o.min[0]) * (o.max[2] - o.min[2]) < 6) continue;
            if (p[0] <= o.min[0] || p[0] >= o.max[0] || p[2] <= o.min[2] || p[2] >= o.max[2]) continue;
            top = Math.max(top, o.max[1]);
          }
        }
        return top;
      };
      const mid = (oa0 + oa1) / 2;
      rec.floorIn = floorAt(mid, b0 - 0.6);
      rec.floorOut = floorAt(mid, b1 + 0.6);
      rec.freeW = bestW; rec.freeH = bestH;
      rec.blockFrac = blocked / (na * ny);
      rec.glassFrac = glassOnly / (na * ny);
      rec.blockers = [...blockedBy.entries()].sort((x, y2) => y2[1] - x[1]).slice(0, 3)
        .map(([i, c]) => ({ b: boxes[i], frac: c / (na * ny) }));
      R.openings.push(rec);
    }
  }
}

// ── 6 THICKNESS ──────────────────────────────────────────────────────────────────────
// The number that matters is the penetration budget in scripts/maptest.mjs: an unbroken
// run of solid material thinner than PEN is shot through by every rifle on the map.
const PEN = 0.35;
if (!only || only === 'thin') {
  for (const b of boxes) {
    if (b.isProp || b.surface === 'glass' || !ARCH.has(b.kind)) continue;
    if (b.thin >= PEN) continue;
    if (b.size.filter((s) => s >= 1.0).length < 2) continue;   // only real wall/floor panels
    R.thin.push(b);
  }
  R.thin.sort((u, v) => u.thin - v.thin);
}

// ── 8 DUPLICATES / DEGENERATE / BURIED ───────────────────────────────────────────────
R.dup = []; R.degen = []; R.buried = [];
{
  const byKey = new Map();
  for (const b of boxes) {
    const k = [...b.min, ...b.max].map((v) => v.toFixed(3)).join(',');
    let l = byKey.get(k); if (!l) byKey.set(k, l = []); l.push(b);
  }
  for (const l of byKey.values()) if (l.length > 1) R.dup.push(l);
  for (const b of boxes) if (b.thin < 0.02) R.degen.push(b);
  // fully below the ground plane / floor beneath it
  for (const b of boxes) {
    if (b.kind === 'groundPlane' || b.max[1] > 0.0) continue;
    R.buried.push(b);
  }
}

// ── 7 SYMMETRY ───────────────────────────────────────────────────────────────────────
// Mirror-transform near-misses only mean something on the mirrored competitive layouts.
// 'square-extraction' is deliberately asymmetric (three unequal sectors around one POI),
// so on that map every "near-miss" would be noise; the section skips itself and says so.
const SYM_MAPS = new Set(['the-square', 'meridian']);
if ((!only || only === 'sym') && !SYM_MAPS.has(MAP_ID)) {
  console.log(`(7 SYMMETRY skipped: '${MAP_ID}' declares no mirror symmetry — advisory-only section.)`);
}
if ((!only || only === 'sym') && SYM_MAPS.has(MAP_ID)) {
  const mirrors = [
    ['x=0 (mirror in X)', (b) => ({ min: [-b.max[0], b.min[1], b.min[2]], max: [-b.min[0], b.max[1], b.max[2]] })],
    ['z=0 (mirror in Z)', (b) => ({ min: [b.min[0], b.min[1], -b.max[2]], max: [b.max[0], b.max[1], -b.min[2]] })],
    ['180° about origin', (b) => ({ min: [-b.max[0], b.min[1], -b.max[2]], max: [-b.min[0], b.max[1], -b.min[2]] })],
  ];
  const cand = boxes.filter((b) => !b.isProp && b.vol > 0.05);
  for (const [name, T] of mirrors) {
    const seen = new Set();
    for (const a of cand) {
      const m = T(a);
      let best = null, bd = Infinity;
      for (const b of cand) {
        if (b === a) continue;
        if (b.surface !== a.surface) continue;
        let d = 0;
        for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(b.min[k] - m.min[k]), Math.abs(b.max[k] - m.max[k]));
        if (d < bd) { bd = d; best = b; }
      }
      if (!best || bd <= 0.004 || bd > 0.5) continue;
      const id = [a.i, best.i].sort((x, y) => x - y).join('-') + name;
      if (seen.has(id)) continue; seen.add(id);
      R.sym.push({ name, a, b: best, d: bd });
    }
  }
  R.sym.sort((u, v) => v.d - u.d);
}

// ── report ───────────────────────────────────────────────────────────────────────────
console.log(`\nGEOMETRY AUDIT — map '${MAP_ID}', ${N} colliders, ${D.walls.length} authored wall runs\n`);

if (R.seam.length) {
  // Collapse repeats: twenty stair treads standing 0.20 m off the same wall is one
  // defect, not twenty.
  const groups = new Map();
  for (const s of R.seam) {
    const k = `${s.a.lvl}|${s.b.lvl}|${AX[s.k]}|${s.g.toFixed(3)}`;
    let g = groups.get(k);
    if (!g) groups.set(k, g = { k: s.k, g: s.g, n: 0, area: 0, best: s });
    g.n++; g.area += s.openArea;
    if (s.openArea > g.best.openArea) g.best = s;
  }
  const list = [...groups.values()];
  const archOnly = (g) => ARCH.has(g.best.a.kind) && ARCH.has(g.best.b.kind);
  const A = list.filter(archOnly).sort((u, v) => v.area - u.area);
  const B2 = list.filter((g) => !archOnly(g)).sort((u, v) => v.area - u.area);
  const show = (title, arr) => {
    console.log(`  ${title} — ${arr.length} groups, ${arr.reduce((a, g) => a + g.n, 0)} pairs`);
    for (const g of arr) {
      const s = g.best;
      console.log(`   ${fmt(g.g, 3)}m along ${AX[g.k]} | open ${fmt(g.area)}m² total${g.n > 1 ? ` over ${g.n} pairs` : ''} | biggest ${fmt(s.openArea)}m² (${fmt(s.span[0])}×${fmt(s.span[1])}) at (${s.at.map((v) => fmt(v)).join(',')})`);
      console.log(`        A ${tag(s.a)} ${pos(s.a)}`);
      console.log(`        B ${tag(s.b)} ${pos(s.b)}`);
    }
  };
  console.log(`── 1 SEAMS: ${R.seam.length} unfilled gaps between near-touching structural surfaces`);
  show('ARCHITECTURE ↔ ARCHITECTURE', A);
  console.log('');
  show('involving stairs / ramps / railings / props', B2);
  console.log('');
}

if (R.overlap.length) {
  const deep = R.overlap.filter((o) => o.pen > 0.45 && o.vol > 0.5);
  const buried = R.overlap.filter((o) => o.frac > 0.9 && o.small.vol > 0.02);
  const sliver = R.overlap.filter((o) => o.pen > 0.0005 && o.pen < 0.02
    && o.o.filter((v) => v > 0.5).length === 2 && !o.a.isProp && !o.b.isProp);
  console.log(`── 2 OVERLAP: ${R.overlap.length} intersecting pairs; ${deep.length} deep, ${buried.length} entombed, ${sliver.length} sliver`);
  for (const o of deep.slice(0, 40)) {
    console.log(`  DEEP pen ${fmt(o.pen)}m vol ${fmt(o.vol)}m³  ${tag(o.a)} ${pos(o.a)}  ×  ${tag(o.b)} ${pos(o.b)}`);
  }
  for (const o of buried.slice(0, 40)) {
    console.log(`  ENTOMBED ${fmt(o.frac * 100, 1)}% of ${tag(o.small)} ${pos(o.small)} inside ${tag(o.big)}`);
  }
  for (const o of sliver.slice(0, 40)) {
    console.log(`  SLIVER ${fmt(o.pen, 4)}m ${tag(o.a)} × ${tag(o.b)} at ${ctr(o.a)}`);
  }
  console.log('');
}

if (R.floating.length) {
  const iso = R.floating.filter((f) => f.contacts === 0);
  const hang = R.floating.filter((f) => f.contacts > 0 && f.supportArea < 0.02 * f.footprint
    && f.drop > 0.02 && f.drop < 40 && f.b.min[1] > 0.02);
  console.log(`── 3 FLOATING: ${iso.length} colliders with no contact at all`);
  for (const f of iso) console.log(`  ISOLATED ${tag(f.b)} ${pos(f.b)} — nearest support ${f.drop === Infinity ? 'none' : fmt(f.drop) + 'm below'}`);
  console.log(`  (${hang.length} more are unsupported from below but joined at a side — lintels, slabs, parapets)`);
  console.log('');
}

if (R.align.length) {
  console.log(`── 4 ALIGNMENT: ${R.align.length} near-miss pairs`);
  for (const a of R.align) {
    console.log(`  ${a.kind} offset ${fmt(a.d, 3)}m in ${a.axis}: ${tag(a.a)} ${pos(a.a)} vs ${tag(a.b)} ${pos(a.b)}`);
  }
  console.log('');
}

if (R.openings.length) {
  const lines = [];
  const clear = R.openings.filter((o) => !o.dead && (o.blockFrac - o.glassFrac) <= 0.001);
  for (const o of R.openings) {
    const w = o.wall;
    const label = `${o.op.frame || 'hole'} ${w.alongX ? 'X' : 'Z'} ${fmt(o.op.a0)}..${fmt(o.op.a1)} y ${fmt(o.op.y0)}..${fmt(o.op.y1)} @ ${w.src}`;
    if (o.dead) { lines.push(`  DEAD  ${label} — opening does not intersect its wall band`); continue; }
    const flags = [];
    if (o.clipped) flags.push(`clipped to ${fmt(o.oa0)}..${fmt(o.oa1)}/${fmt(o.oy0)}..${fmt(o.oy1)}`);
    if ((o.blockFrac - o.glassFrac) > 0.02) flags.push(`obstructed ${fmt((o.blockFrac - o.glassFrac) * 100, 1)}%`);
    if (o.freeW < 0.75) flags.push(`clear width ${fmt(o.freeW)}m`);
    if (o.op.frame === 'door' && o.freeH < 1.9) flags.push(`clear height ${fmt(o.freeH)}m`);
    const fl = Math.max(o.floorIn, o.floorOut);
    if (isFinite(fl)) {
      const sill = o.oy0 - fl, head = o.oy1 - fl;
      if (o.op.frame !== 'window' && head < 2.0) flags.push(`headroom ${fmt(head)}m over floor ${fmt(fl)}`);
      if (o.op.frame !== 'window' && Math.abs(sill) > 0.55) flags.push(`sill ${fmt(sill)}m above/below floor ${fmt(fl)}`);
      if (o.op.frame === 'window' && (sill < 0.35 || sill > 1.6)) flags.push(`window sill ${fmt(sill)}m over floor ${fmt(fl)}`);
    } else flags.push('no floor found under opening');
    if (!flags.length) continue;
    lines.push(`  ${label}\n        clear ${fmt(o.freeW)}×${fmt(o.freeH)}m of ${fmt(o.oa1 - o.oa0)}×${fmt(o.oy1 - o.oy0)}m; ${flags.join('; ')}`);
    for (const b of o.blockers) lines.push(`        blocker ${tag(b.b)} ${pos(b.b)} ${fmt(b.frac * 100, 1)}%`);
  }
  console.log(`── 5 OPENINGS: ${R.openings.length} authored; ${clear.length} completely clear; ${lines.filter((l) => l.startsWith('  ') && !l.startsWith('        ')).length} flagged`);
  for (const l of lines) console.log(l);
  console.log('');
}

{
  console.log(`── 6 THICKNESS: ${R.thin.length} architectural panels under the ${PEN} m penetration budget`);
  const hist = new Map();
  for (const b of boxes) {
    if (b.isProp || !ARCH.has(b.kind) || b.surface === 'glass') continue;
    if (b.size.filter((s) => s >= 1.0).length < 2) continue;
    const t = b.thin.toFixed(2);
    let h = hist.get(t); if (!h) hist.set(t, h = { n: 0, kinds: new Set(), ex: b });
    h.n++; h.kinds.add(b.kind);
  }
  console.log(`  thickness histogram of vertical/horizontal panels:`);
  for (const [t, h] of [...hist.entries()].sort((a, b) => +a[0] - +b[0])) {
    console.log(`   ${t}m × ${h.n}  (${[...h.kinds].join(',')})${+t < PEN ? '   <-- under penetration budget' : ''}`);
  }
  for (const b of R.thin.slice(0, 24)) console.log(`  ${fmt(b.thin, 3)}m ${tag(b)} ${pos(b)}`);
  console.log('');
}

{
  console.log(`── 8 DUPLICATES ${R.dup.length}, DEGENERATE ${R.degen.length}, BURIED ${R.buried.length}`);
  for (const l of R.dup) console.log(`  DUPLICATE ×${l.length} ${pos(l[0])} — ${l.map(tag).join(' | ')}`);
  for (const b of R.degen) console.log(`  DEGENERATE ${fmt(b.thin, 4)}m ${tag(b)} ${pos(b)}`);
  for (const b of R.buried) console.log(`  BURIED ${tag(b)} ${pos(b)}`);
  console.log('');
}

if (R.sym.length) {
  console.log(`── 7 SYMMETRY: ${R.sym.length} near-miss mirror pairs`);
  for (const s of R.sym) {
    console.log(`  ${s.name} off by ${fmt(s.d, 3)}m: ${tag(s.a)} ${pos(s.a)} <-> ${tag(s.b)} ${pos(s.b)}`);
  }
  console.log('');
}

// ── verdict ──────────────────────────────────────────────────────────────────────────
// Until now this file exited on `typeof failures === 'number'` for a `failures` that was
// never declared anywhere in it, so it exited 0 unconditionally and was reported as a
// passing guard on that basis. It is a guard now. The split below is deliberate:
//
// DEFECT — only what map-data.md §3.1 and §3.6 make binding, so no threshold in this file
// is inventing a rule:
//   §3.1 "No box may be authored with min > max on any axis; the guard rejects it rather
//        than letting the spatial hash silently drop it."      -> DEGENERATE
//   §3.1 "Every box carries a `surface` tag."                  -> UNTAGGED
//   §3.1 "Renderer-only meshes never participate in collision. Decorative geometry that
//        is not added as a box does not block, and geometry added as a box always blocks.
//        No third state."                                      -> DUPLICATE / ENTOMBED /
//        A collider that is an exact copy of another, sits wholly inside another, or lies
//        wholly beneath the ground plane blocks nothing that is not already blocked: it is
//        in the hash and decides nothing, which is precisely the third state §3.1 forbids.
//                                                                 BURIED
//   §3.6 `colliders: 1200` — "bounded by query performance", every move/raycast/losClear
//        scales with box count, so inert colliders are spend against a binding budget for
//        no return.                                            -> COLLIDER BUDGET
//   §3.1 an authored opening that does not intersect its own wall band is a hole the
//        builder never cut — the box blocks where the author declared a gap.
//                                                                 DEAD OPENING
//
// ADVISORY — real measurements, but no rule in §3.1/§3.6 sets a tolerance for them, and
// on The Square each has a legitimate authored reading: the seams are the 0.35 m reveal
// under every glass pane, the 20 "isolated" colliders are those same panes sitting in
// their frames, the deep overlaps are ordinary pilaster/wall joins, the 0.20 m panels are
// roof and canopy slabs (thickness is maptest's penetration constant, not a §3.6 budget),
// and site/mirror symmetry belongs to mapbalance §7. Calling any of them fatal here would
// be this file inventing a contract. They stay printed above, in full, and unenforced.
const fatal = [];
if (only) {
  console.log(`(--only=${only}: sections were skipped, so no verdict is issued.)\n`);
  process.exit(0);
}
const untagged = boxes.filter((b) => typeof b.surface !== 'string' || !b.surface.trim());
const contained = (s, big) => [0, 1, 2].every((k) => s.min[k] >= big.min[k] - 1e-6
  && s.max[k] <= big.max[k] + 1e-6);
// Mutually contained means identical, which DUPLICATE already owns; don't bill it twice.
const entombed = R.overlap.filter((o) => o.small !== o.big
  && contained(o.small, o.big) && !contained(o.big, o.small));
const deadOpenings = R.openings.filter((o) => o.dead);
const colliderBudget = MAP_MANIFEST?.budgets?.colliders;

for (const b of R.degen) fatal.push(`DEGENERATE ${fmt(b.thin, 4)}m ${tag(b)} ${pos(b)} — §3.1 malformed box`);
for (const b of untagged) fatal.push(`UNTAGGED ${tag(b)} ${pos(b)} — §3.1 every box carries a surface tag`);
for (const l of R.dup) fatal.push(`DUPLICATE ×${l.length} ${pos(l[0])} — ${l.map(tag).join(' | ')} — §3.1 inert collider`);
for (const o of entombed) fatal.push(`ENTOMBED ${tag(o.small)} ${pos(o.small)} lies wholly inside ${tag(o.big)} ${pos(o.big)} — §3.1 inert collider, §3.6 collider budget`);
for (const b of R.buried) fatal.push(`BURIED ${tag(b)} ${pos(b)} — wholly below the ground plane; §3.1 inert collider`);
for (const o of deadOpenings) fatal.push(`DEAD OPENING ${o.op.frame || 'hole'} ${fmt(o.op.a0)}..${fmt(o.op.a1)} y ${fmt(o.op.y0)}..${fmt(o.op.y1)} @ ${o.wall.src} — does not intersect its wall band`);
if (!Number.isFinite(colliderBudget)) {
  fatal.push('COLLIDER BUDGET — MAP_MANIFEST.budgets.colliders is absent or not finite; §3.6 requires it');
} else if (N > colliderBudget) {
  fatal.push(`COLLIDER BUDGET ${N} colliders exceeds the §3.6 allocation of ${colliderBudget}`);
}

console.log('── VERDICT');
console.log(`  advisory: ${R.seam.length} seam pairs, ${R.overlap.length} overlapping pairs, `
  + `${R.floating.filter((f) => f.contacts === 0).length} isolated colliders, ${R.align.length} alignment near-misses, `
  + `${R.thin.length} sub-${PEN}m panels, ${R.sym.length} mirror near-misses`);
console.log(`  §3.6 colliders ${N} / ${Number.isFinite(colliderBudget) ? colliderBudget : '??'}`);
// Honest about the half of §3.6 this harness does not measure. §3.6 also names geomtest as
// the harness for drawCalls/triangles/materials/lights and for the ARCHITECTURE.md §11
// whole-scene ceiling under a running match. None of that is measurable from a headless
// collider dump — it needs the ref-integrated-1080p render profile — and nothing in this
// file measures it. That guard line is UNPROVEN; it is not silently reported as met.
console.log('  §3.6 drawCalls/triangles/materials/lights and the ARCHITECTURE.md §11 whole-scene');
console.log('       ceiling: NOT MEASURED here — no render profile in a headless dump. UNPROVEN.');
if (fatal.length) {
  console.error(`\n✗ GEOMETRY AUDIT FAILED — ${fatal.length} defect(s) against map-data.md §3.1/§3.6:`);
  for (const f of fatal) console.error(`  - ${f}`);
} else {
  console.log(`\n✓ GEOMETRY AUDIT PASSED — 0 defects against map-data.md §3.1/§3.6 over ${N} colliders.`);
}
// A headless `Game` keeps a live handle, so this never exited on its own — two runs were
// found still alive after 75 minutes with their output complete. Every other harness here
// ends with an explicit exit; this one now does too, and reports a status while it is at it.
process.exit(fatal.length > 0 ? 1 : 0);
