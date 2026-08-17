/**
 * THROWAWAY REVIEW PROBE — decal update-range correctness.
 *
 * Drives the REAL DecalSystem from src/fx/decals.js against a faithful re-implementation
 * of three 0.185's WebGLAttributes.updateBuffer() (sort + in-place merge + bufferSubData
 * + clearUpdateRanges) plus WebGLObjects.update()'s once-per-frame gating.
 *
 * After every simulated render the GPU shadow copy of every dynamic attribute must equal
 * the CPU array for EVERY element the mesh could draw. Any missed write shows up as a
 * mismatch at a specific element index.
 */
import * as THREE from 'three';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------- DOM stubs
class FakeCtx {
  constructor(w, h) { this.w = w; this.h = h; }
  clearRect() {}
  drawImage() {}
  getImageData(x, y, w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
  createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
  putImageData() {}
  fillRect() {}
  beginPath() {} arc() {} fill() {} stroke() {} moveTo() {} lineTo() {}
}
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error('unexpected ' + tag);
    const cv = { width: 1, height: 1, _ctx: null };
    cv.getContext = () => (cv._ctx ||= new FakeCtx(cv.width, cv.height));
    return cv;
  },
};
globalThis.HTMLCanvasElement = class {};

const { DecalSystem, DECAL_CAP } = await import('../src/fx/decals.js');

// ---------------------------------------------------------------- fake game
const fakeTex = { image: { width: 128, height: 128 } };
const game = {
  assets: { tex: () => fakeTex },
  engine: null,
  world: {
    raycast(origin, dir, maxDist) {
      return { point: new THREE.Vector3(origin.x, 0, origin.z), normal: new THREE.Vector3(0, 1, 0), distance: 1, surface: 'concrete' };
    },
  },
};
const scene = new THREE.Scene();

const d = new DecalSystem(game);
d.init(scene);
const mesh = d.mesh;

if (DECAL_CAP !== 256) { console.error(`FAIL: DECAL_CAP is ${DECAL_CAP}, contract §8 says 256`); process.exitCode = 1; }
else console.log(`OK   DECAL_CAP === 256`);
console.log(`OK   mesh.frustumCulled === ${mesh.frustumCulled} (false => zero-scale parking cannot cause culling)`);

// ------------------------------------------------- three's updateBuffer, faithfully
const gpu = new Map();       // attribute -> { shadow: Float32Array, version: number }
let uploadedElems = 0;
let uploadCalls = 0;

function attrUpdate(attr) {
  let rec = gpu.get(attr);
  if (rec === undefined) {
    // createBuffer: full bufferData upload. NOTE: three does NOT clearUpdateRanges here,
    // so a range registered before the very first upload survives it. Harmless (the app
    // merges into it and the next real updateBuffer clears it) but modelled faithfully.
    rec = { shadow: attr.array.slice(), version: attr.version, first: true };
    gpu.set(attr, rec);
    return;
  }
  if (rec.version >= attr.version) return;    // three: data.version < attribute.version
  const ranges = attr.updateRanges;
  if (ranges.length === 0) {
    rec.shadow.set(attr.array);
    uploadedElems += attr.array.length;
    uploadCalls++;
  } else {
    ranges.sort((a, b) => a.start - b.start);
    let mergeIndex = 0;
    for (let i = 1; i < ranges.length; i++) {
      const prev = ranges[mergeIndex], r = ranges[i];
      if (r.start <= prev.start + prev.count + 1) {
        prev.count = Math.max(prev.count, r.start + r.count - prev.start);
      } else { ++mergeIndex; ranges[mergeIndex] = r; }
    }
    ranges.length = mergeIndex + 1;
    for (const r of ranges) {
      rec.shadow.set(attr.array.subarray(r.start, r.start + r.count), r.start);
      uploadedElems += r.count;
      uploadCalls++;
    }
    attr.clearUpdateRanges();
  }
  rec.version = attr.version;
}

const DYN = () => [
  ['instanceMatrix', mesh.instanceMatrix, 16],
  ['aUvRect', d.uvRectAttr, 4],
  ['aOpacity', d.opacityAttr, 1],
  ['aTint', d.tintAttr, 3],
];

let failures = 0;
function render(frameLabel) {
  for (const [, attr] of DYN()) attrUpdate(attr);
  // verify: every element of every attribute must match, not just the drawn range —
  // a stale element becomes visible the moment mesh.count grows again.
  for (const [name, attr, item] of DYN()) {
    const rec = gpu.get(attr);
    for (let i = 0; i < attr.array.length; i++) {
      if (rec.shadow[i] !== attr.array[i]) {
        console.error(`FAIL ${frameLabel}: ${name} element ${i} (instance ${Math.floor(i / item)}) GPU=${rec.shadow[i]} CPU=${attr.array[i]}`);
        failures++;
        if (failures > 8) throw new Error('too many mismatches');
        break;
      }
    }
  }
  // also: no range may ever leak past a render (after the first, bufferData-shaped upload)
  for (const [name, attr] of DYN()) {
    const rec = gpu.get(attr);
    if (rec.first) { rec.first = false; continue; }
    if (attr.updateRanges.length !== 0) {
      console.error(`FAIL ${frameLabel}: ${name} left ${attr.updateRanges.length} updateRanges after upload (leak)`);
      failures++;
    }
  }
}

const N = new THREE.Vector3(0, 1, 0);
const P = new THREE.Vector3();
let rngState = 12345;
const rr = () => (rngState = (rngState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// ---- scenario 1: many decals placed in ONE frame (the "only one range registered" attack)
for (let k = 0; k < 12; k++) {
  P.set(rr() * 40, rr() * 5, rr() * 40);
  d.add(P, N, 'concrete', 0.16);
}
console.log(`scenario1: ${mesh.instanceMatrix.updateRanges.length} matrix range(s) registered for 12 placements in one frame`);
render('f1-multi-place');
if (!failures) console.log('OK   scenario1: 12 same-frame placements all reached the GPU');

// ---- scenario 2: full ring wrap + expiry + parking, 4000 frames of 1/60 with impacts
const DT = 1 / 60;
let placed = 12;
for (let f = 0; f < 4200; f++) {
  const impacts = (f % 3 === 0) ? 1 + Math.floor(rr() * 4) : 0;
  for (let k = 0; k < impacts; k++) {
    P.set(rr() * 60 - 30, rr() * 8, rr() * 60 - 30);
    if (rr() < 0.25) { d.bloodOnGround(P, 0.34, 3); placed += 4; }
    else { d.add(P, N, ['concrete', 'metal', 'glass', 'wood'][Math.floor(rr() * 4)], 0.16); placed++; }
  }
  d.update(DT);
  // draw-range invariant: mesh.count must cover every LIVE slot, and every slot below
  // mesh.count that is dead must be parked (degenerate) or it would render stale.
  let highestLive = -1;
  for (let i = 0; i < DECAL_CAP; i++) if (d.alive[i]) highestLive = i;
  if (mesh.count < highestLive + 1) {
    console.error(`FAIL f${f}: mesh.count=${mesh.count} excludes live slot ${highestLive}`);
    failures++;
  }
  for (let i = 0; i < mesh.count; i++) {
    if (d.alive[i]) continue;
    const b = mesh.instanceMatrix.array;
    const o = i * 16;
    const scaleSq = b[o] * b[o] + b[o + 1] * b[o + 1] + b[o + 2] * b[o + 2];
    if (scaleSq > 1e-12 && d.opacity[i] !== 0) {
      console.error(`FAIL f${f}: dead slot ${i} inside draw range is neither parked nor zero-opacity`);
      failures++;
    }
  }
  render(`f${f}`);
  if (failures) break;
}
if (!failures) console.log(`OK   scenario2: ${placed} decals placed over 4200 frames, GPU==CPU every frame`);

// ---- scenario 3: clear() mid-frame after placements
d.add(P.set(1, 1, 1), N, 'concrete', 0.2);
d.clear();
render('f-clear');
if (!failures) console.log('OK   scenario3: clear() leaves no stale GPU state');

// ---- scenario 4: exact range arithmetic for a single instance
d.clear(); render('reset');
const before = mesh.instanceMatrix.array.slice();
const idx = d.add(P.set(3, 3, 3), N, 'metal', 0.1);
const rng0 = mesh.instanceMatrix.updateRanges.map((r) => `${r.start}+${r.count}`).join(',');
console.log(`scenario4: slot ${idx} -> instanceMatrix range ${rng0} (expected ${idx * 16}+16)`);
let diffMin = Infinity, diffMax = -Infinity;
for (let i = 0; i < before.length; i++) if (before[i] !== mesh.instanceMatrix.array[i]) { diffMin = Math.min(diffMin, i); diffMax = Math.max(diffMax, i); }
console.log(`scenario4: actual changed element span [${diffMin}, ${diffMax}] -> must be inside the range`);
const r0 = mesh.instanceMatrix.updateRanges[0];
if (!(r0 && r0.start <= diffMin && r0.start + r0.count > diffMax)) { console.error('FAIL scenario4: range does not cover the write'); failures++; }
else console.log('OK   scenario4: range exactly covers the 16-float matrix write');
render('f-single');

// ---- scenario 5: park-vs-claim ordering. Force a slot to expire on the SAME frame a new
// decal lands, with the placement first (fixedUpdate) then update() — the real loop order.
d.clear(); render('reset2');
const slot = d.add(P.set(9, 9, 9), N, 'concrete', 0.2, 1, 0.001);   // life 1ms
d.update(0.5);            // expires + parks slot 0
render('f-park');
const parkedScale = mesh.instanceMatrix.array[0];
console.log(`scenario5: after expiry, slot ${slot} matrix[0] = ${parkedScale} (0 => parked)`);
// now reclaim it in the next frame's fixedUpdate, then update()
const slot2 = d.add(P.set(4, 4, 4), N, 'concrete', 0.2);
d.update(DT);
render('f-reclaim');
const m0 = mesh.instanceMatrix.array[slot2 * 16];
const m5 = mesh.instanceMatrix.array[slot2 * 16 + 5];
console.log(`scenario5: reclaimed slot ${slot2} basis = (${m0.toFixed(4)}, ${m5.toFixed(4)}) — nonzero => visible`);
if (Math.abs(m0) < 1e-9 && Math.abs(m5) < 1e-9) { console.error('FAIL scenario5: reclaimed slot is still parked (invisible decal)'); failures++; }
else console.log('OK   scenario5: no park-vs-claim race');
console.log(`     mesh.count=${mesh.count}, alive[${slot2}]=${d.alive[slot2]}`);

console.log(`\nupload calls: ${uploadCalls}, elements uploaded: ${uploadedElems}`);
console.log(failures === 0 ? '\nALL DECAL RANGE CHECKS PASSED' : `\n${failures} FAILURES`);
if (failures) process.exitCode = 1;
