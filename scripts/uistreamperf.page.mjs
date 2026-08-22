/**
 * uistreamperf PAGE MODULE — runs inside the browser, served and transformed by the
 * vite dev server that `scripts/uistreamperf.mjs` boots. It builds the REAL
 * 'square-extraction' visuals (real Builder, real generated materials) into a real
 * WebGLRenderer and measures `renderer.info.render` draw calls per frame:
 *
 *   - merged:   the map built with sector bucketing DISABLED (Builder.setSector no-op),
 *               i.e. the pre-P3-07 merge behaviour — the honest baseline the per-sector
 *               bucket split must be priced against;
 *   - off:      the sectored build with streaming OFF (controller fed no viewer →
 *               fail-open, everything FULL) — what the split alone costs;
 *   - on:       the sectored build with streaming ON, viewer at a gameplay position —
 *               neighbour sectors NEAR, so their meshes stop casting shadows and the
 *               shadow pass sheds their draws (nothing is ever HIDDEN on this map:
 *               the three sectors are mutually adjacent, per sector-interest.md §5.1);
 *   - control:  the ON state with every NEAR mesh's castShadow forced back to true
 *               behind the controller's back — must measure back at `off`, proving the
 *               on/off delta really is shadow-pass stripping and nothing else.
 *
 * `renderer.info.autoReset` is disabled and reset manually per frame so the counters
 * aggregate the shadow passes with the main pass, which is exactly the cost being
 * measured. The node driver asserts on the returned numbers.
 */
import * as THREE from 'three';
import {
  EXTRACTION_SECTORS, EXTRACTION_MANIFEST, buildExtractionLevel, STREAM_TIER,
} from '../src/world/level.js';
import { Builder } from '../src/world/props.js';
import { createRNG } from '../src/core/rng.js';
import { assets } from '../src/core/assets.js';

function stubWorld() {
  return {
    group: new THREE.Group(),
    boxes: [],
    buildStats: {},
    setBounds() {},
    addBoxRaw(x0, y0, z0, x1, y1, z1, surface) {
      const box = {
        min: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) },
        max: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) },
        surface,
      };
      this.boxes.push(box);
      return box;
    },
  };
}
const stubGame = (seed = 0x50e07) => ({ rng: createRNG(seed) });

async function run() {
  await assets.init();

  // Sectored build — the shipped P3-07 map, streaming controller attached by level.js.
  const sectored = stubWorld();
  buildExtractionLevel(stubGame(), sectored, {});
  const controller = sectored.group.userData.sectorStreaming;

  // Merged baseline — the identical map with sector bucketing disabled, so same-material
  // geometry merges across sector boundaries exactly as it did before P3-07.
  const origSetSector = Builder.prototype.setSector;
  Builder.prototype.setSector = function () {};
  const merged = stubWorld();
  try {
    buildExtractionLevel(stubGame(), merged, {});
  } finally {
    Builder.prototype.setSector = origSetSector;
  }

  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setSize(960, 540, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false;

  const scene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.castShadow = true;
  sun.position.set(80, 120, 60);
  sun.shadow.mapSize.set(1024, 1024);
  const b = EXTRACTION_MANIFEST.bounds;
  const half = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2 + 20;
  Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: 500 });
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun, sun.target, new THREE.AmbientLight(0x8899aa, 0.55));

  const camera = new THREE.PerspectiveCamera(75, 960 / 540, 0.1, 700);

  // Gameplay-shaped viewpoints: eye height in the POI, looking into a neighbour sector
  // (the vista where NEAR shadow-stripping has work to do).
  const POSES = [
    { id: 'square-looking-north', eye: [0, 1.7, 6], look: [0, 1.5, -60] },
    { id: 'square-looking-east', eye: [-6, 1.7, 0], look: [60, 1.5, 0] },
  ];

  function measureFrame(group, drive) {
    if (drive !== undefined) controller.update(1 / 60, drive);
    renderer.info.reset();
    renderer.render(scene, camera);
    return {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    };
  }
  function settle(group, drive, frames = 4) {
    let last = null;
    for (let i = 0; i < frames; i++) last = measureFrame(group, drive);
    return last;
  }

  const results = { poses: [], budgets: EXTRACTION_MANIFEST.budgets, sectors: {} };
  results.sectors.groups = [...sectored.group.children]
    .filter((g) => g.name?.startsWith('sector:')).map((g) => g.name);
  results.sectors.meshCount = (() => {
    let n = 0;
    sectored.group.traverse((o) => { if (o.isMesh || o.isInstancedMesh) n++; });
    return n;
  })();

  for (const pose of POSES) {
    camera.position.set(...pose.eye);
    camera.lookAt(...pose.look);
    camera.updateMatrixWorld();
    const viewer = { x: pose.eye[0], y: 0.1, z: pose.eye[2] };

    scene.add(sectored.group);

    // OFF: fail-open (no viewer) renders every sector FULL — streaming disabled.
    const off = settle(sectored.group, null);
    // ON: the shipped behaviour — viewer drives §5.1 tiers.
    const on = settle(sectored.group, viewer);
    const tiers = Object.fromEntries(EXTRACTION_SECTORS.map((s) => [s.id, controller.tierOf(s.id)]));

    // CONTROL: force castShadow back on behind the controller's back. If the on/off
    // delta is really NEAR shadow-stripping, this must measure back at `off` exactly.
    const forced = [];
    for (const g of sectored.group.children) {
      if (!g.name?.startsWith('sector:')) continue;
      if (controller.tierOf(g.userData.sectorId) !== STREAM_TIER.NEAR) continue;
      for (const m of g.children) {
        if ((m.isMesh || m.isInstancedMesh) && m.castShadow === false && m.userData.p307Cast === true) {
          m.castShadow = true;
          forced.push(m);
        }
      }
    }
    const control = settle(sectored.group, undefined);   // no controller update: keep forced state
    for (const m of forced) m.castShadow = false;

    scene.remove(sectored.group);
    scene.add(merged.group);
    const mergedRow = settle(merged.group, undefined);
    scene.remove(merged.group);

    results.poses.push({
      id: pose.id, tiers,
      merged: mergedRow, off, on, control,
      shadowDrawsSaved: off.calls - on.calls,
      bucketSplitCost: off.calls - mergedRow.calls,
      netVsMerged: on.calls - mergedRow.calls,
    });
  }
  return results;
}

run().then(
  (r) => { window.__STREAMPERF__ = r; },
  (e) => { window.__STREAMPERF_ERROR__ = `${e?.message}\n${e?.stack}`; },
);
