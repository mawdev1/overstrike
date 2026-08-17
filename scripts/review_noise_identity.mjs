/**
 * THROWAWAY REVIEW PROBE — assets.js noise refactor equivalence.
 *
 * The diff replaces the per-pixel `makeNoise()` closure with a hoisted `fbmPlane()` and
 * claims bit-identical output. This re-implements BOTH (the old one verbatim from
 * commit 2e69c49, the new one verbatim from HEAD) and compares every pixel of every
 * (seed, size, octaves, freq, gain, uScale, vScale) tuple that assets.js actually uses.
 * A single differing bit is a texture change = visual regression.
 */

// ------------------------------------------------ rng (unchanged by the diff)
import { createRNG } from '../src/core/rng.js';

// ------------------------------------------------ OLD (baseline 2e69c49)
function makeNoise(seed) {
  const rng = createRNG(seed);
  const N = 64;
  const grid = new Float32Array(N * N);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const at = (x, y) => grid[(((y % N) + N) % N) * N + (((x % N) + N) % N)];
  const smooth = (t) => t * t * (3 - 2 * t);
  const sample = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = smooth(x - xi), yf = smooth(y - yi);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a * (1 - xf) * (1 - yf) + b * xf * (1 - yf) + c * (1 - xf) * yf + d * xf * yf;
  };
  return (x, y, octaves = 4, freq = 4, gain = 0.5) => {
    let sum = 0, amp = 1, norm = 0, f = freq;
    for (let o = 0; o < octaves; o++) {
      sum += sample(x * f, y * f) * amp;
      norm += amp;
      amp *= gain;
      f *= 2;
    }
    return sum / norm;
  };
}

// ------------------------------------------------ NEW (HEAD)
const NOISE_N = 64;
const _noiseGrids = new Map();
const _noisePlanes = new Map();
function noiseGrid(seed) {
  let g = _noiseGrids.get(seed);
  if (!g) {
    const rng = createRNG(seed);
    g = new Float32Array(NOISE_N * NOISE_N);
    for (let i = 0; i < g.length; i++) g[i] = rng();
    _noiseGrids.set(seed, g);
  }
  return g;
}
const smoothT = (t) => t * t * (3 - 2 * t);
function fbmPlane(seed, size, octaves = 4, freq = 4, gain = 0.5, uScale = 1, vScale = 1) {
  const key = `${seed}|${size}|${octaves}|${freq}|${gain}|${uScale}|${vScale}`;
  const cached = _noisePlanes.get(key);
  if (cached) return cached;
  const grid = noiseGrid(seed);
  const out = new Float64Array(size * size);
  const xi0 = new Int32Array(size), xi1 = new Int32Array(size);
  const wx0 = new Float64Array(size), wx1 = new Float64Array(size);
  let amp = 1, norm = 0, f = freq;
  for (let o = 0; o < octaves; o++) {
    for (let px = 0; px < size; px++) {
      const X = ((px / size) * uScale) * f;
      const x0 = Math.floor(X);
      const xf = smoothT(X - x0);
      xi0[px] = (((x0 % NOISE_N) + NOISE_N) % NOISE_N);
      xi1[px] = ((((x0 + 1) % NOISE_N) + NOISE_N) % NOISE_N);
      wx0[px] = 1 - xf;
      wx1[px] = xf;
    }
    for (let py = 0; py < size; py++) {
      const Y = ((py / size) * vScale) * f;
      const y0 = Math.floor(Y);
      const yf = smoothT(Y - y0);
      const wy0 = 1 - yf, wy1 = yf;
      const rowA = (((y0 % NOISE_N) + NOISE_N) % NOISE_N) * NOISE_N;
      const rowB = ((((y0 + 1) % NOISE_N) + NOISE_N) % NOISE_N) * NOISE_N;
      const base = py * size;
      for (let px = 0; px < size; px++) {
        const a = xi0[px], b = xi1[px], w0 = wx0[px], w1 = wx1[px];
        out[base + px] += (grid[rowA + a] * w0 * wy0 + grid[rowA + b] * w1 * wy0
                         + grid[rowB + a] * w0 * wy1 + grid[rowB + b] * w1 * wy1) * amp;
      }
    }
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  _noisePlanes.set(key, out);
  return out;
}

// ------------------------------------------------ every real call site
const TEX = 256, RM = 128;
const CASES = [
  // [label, seed, size, octaves, freq, gain, uScale, vScale]
  ['genConcrete(101) A', 101, TEX, 5, 6, 0.5, 1, 1],
  ['genConcrete(101) B', 101, TEX, 3, 22, 0.5, 1, 1],
  ['genConcreteHeight(101)', 101, TEX, 5, 14, 0.5, 1, 1],
  ['genConcrete(202) A', 202, TEX, 5, 6, 0.5, 1, 1],
  ['genConcrete(202) B', 202, TEX, 3, 22, 0.5, 1, 1],
  ['genConcrete(1010) A', 1010, TEX, 5, 6, 0.5, 1, 1],
  ['genConcrete(1010) B', 1010, TEX, 3, 22, 0.5, 1, 1],
  ['grunge metal 303', 303, TEX, 5, 7, 0.5, 1, 1],
  ['grunge metal 304', 304, TEX, 5, 7, 0.5, 1, 1],
  ['grunge metal 305', 305, TEX, 5, 7, 0.5, 1, 1],
  ['genWood(404) W', 404, TEX, 3, 3, 0.5, 1, 1],
  ['genWood(404) F', 404, TEX, 4, 30, 0.5, 1, 1],
  ['genDirt(505)', 505, TEX, 6, 8, 0.5, 1, 1],
  ['genAsphalt(606)', 606, TEX, 5, 24, 0.5, 1, 1],
  ['grunge tile 707', 707, TEX, 5, 9, 0.5, 1, 1],
  ['grunge brick 808', 808, TEX, 5, 6, 0.5, 1, 1],
  ['genSandbag(909)', 909, TEX, 4, 12, 0.5, 1, 1],
  ['genSmoke(1234)', 1234, 128, 5, 5, 0.5, 1, 1],
  ['macroField 4242', 4242, 128, 5, 2, 0.5, 1, 1],
  ['cloud 2408', 2408, 256, 6, 3, 0.55, 1, 1],
  // genRM: rough / metal / wet / streak / chip fields for each of the 11 entries
  ['rm1101 rough', 1101, RM, 4, 7, 0.5, 1, 1],
  ['rm1101 wet', 1162, RM, 3, 1.7, 0.5, 1, 1],
  ['rm1104 rough', 1104, RM, 4, 4, 0.5, 1, 1],
  ['rm1104 metal', 1104, RM, 3, 4 * 1.7, 0.5, 1, 1],
  ['rm1104 streak', 1165, RM, 4, 10, 0.5, 0.1, 1],
  ['rm1105 chip', 1105, RM, 4, 24, 0.5, 1, 1],
  ['rm1105 streak', 1166, RM, 4, 10, 0.5, 0.1, 1],
  ['rm1106 rough', 1106, RM, 4, 8, 0.5, 1, 1],
  ['rm1109 rough', 1109, RM, 4, 7, 0.5, 1, 1],
];

let bad = 0, total = 0;
for (const [label, seed, size, oct, freq, gain, uS, vS] of CASES) {
  const oldN = makeNoise(seed);
  const P = fbmPlane(seed, size, oct, freq, gain, uS, vS);
  let maxDiff = 0, firstBad = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = oldN((x / size) * uS, (y / size) * vS, oct, freq, gain);
      const n = P[y * size + x];
      total++;
      if (o !== n) {
        const dd = Math.abs(o - n);
        if (dd > maxDiff) maxDiff = dd;
        if (firstBad < 0) firstBad = y * size + x;
      }
    }
  }
  if (firstBad >= 0) {
    bad++;
    console.log(`DIFF  ${label}: first differing pixel ${firstBad}, max abs diff ${maxDiff.toExponential(3)} ` +
                `(=> ${(maxDiff * 255).toFixed(4)} of a byte)`);
  } else {
    console.log(`OK    ${label}: bit-identical over ${size * size} pixels`);
  }
}
console.log(`\n${CASES.length - bad}/${CASES.length} fields bit-identical, ${total} pixels compared`);
if (bad) process.exitCode = 1;
