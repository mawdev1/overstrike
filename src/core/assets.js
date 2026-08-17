import * as THREE from 'three';
import { createRNG } from './rng.js';

/**
 * Procedural texture + shared material library.
 *
 * Everything is generated on a 2D canvas at boot (a few ms total) so the game ships with
 * zero binary assets. Materials are cached and shared by name — never construct a
 * material outside this file, or the draw-call budget in ARCHITECTURE.md §11 goes out
 * the window.
 */

const TEX_SIZE = 256;
const RM_SIZE = 128;      // roughness/metalness never needs albedo resolution

/**
 * The single source of truth for the time of day.
 *
 * The sun vector, the sky ramp and the fog colour have to agree or the image falls
 * apart: shadows point one way while the sky's sun sits somewhere else, or distant
 * geometry fades to a grey that never appears in the sky. `engine.js` imports this for
 * the light rig, the sky dome and the fog; the material shaders below import it for
 * sun-tinted aerial perspective. Change it here and everything follows.
 *
 * `sunDir` points FROM the world TOWARD the sun. Elevation is ~38°, deliberately lower
 * than a noon sun: long raking shadows are most of what makes an outdoor scene read as
 * lit rather than merely bright.
 */
export const ATMOSPHERE = {
  sunDir: new THREE.Vector3(0.63, 0.60, 0.34).normalize(),
  sunColor: new THREE.Color(0xfff0cf),
  skyZenith: new THREE.Color(0x2a63a8),
  skyMid: new THREE.Color(0x7ea8cf),
  skyHorizon: new THREE.Color(0xc6c6bd),
  skyGround: new THREE.Color(0x8e8578),
  cloudLit: new THREE.Color(0xfaf6ec),
  cloudDark: new THREE.Color(0x8592a6),
  /** Aerial perspective. `fog` is the base haze; `fogSun` is what it becomes looking into the sun. */
  fog: new THREE.Color(0xacb7c0),
  fogSun: new THREE.Color(0xe7d5b4),
  fogDensity: 0.0068,
};

function canvas(size = TEX_SIZE) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Value noise with fBm, tileable via wrapped lattice lookups. */
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

/** Sobel a greyscale height canvas into a tangent-space normal map. */
function heightToNormal(src, strength = 2.4) {
  const size = src.width;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  const h = sctx.getImageData(0, 0, size, size).data;
  const out = canvas(size);
  const octx = out.getContext('2d');
  const img = octx.createImageData(size, size);
  const H = (x, y) => h[((((y % size) + size) % size) * size + (((x % size) + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (H(x - 1, y) - H(x + 1, y)) * strength;
      const dy = (H(x, y - 1) - H(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

function toTexture(cv, { repeat = 1, srgb = false, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = aniso;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

// ---------------------------------------------------------------- generators

function grungeOverlay(ctx, size, noise, alpha = 0.16, scale = 8) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = noise(x / size, y / size, 5, scale);
      const f = 1 + (n - 0.5) * alpha * 2;
      const i = (y * size + x) * 4;
      d[i] = Math.min(255, d[i] * f);
      d[i + 1] = Math.min(255, d[i + 1] * f);
      d[i + 2] = Math.min(255, d[i + 2] * f);
    }
  }
  ctx.putImageData(img, 0, 0);
}

function genConcrete(seed, base = '#8d8f8c', dark = 0.5) {
  const size = TEX_SIZE;
  const cv = canvas(size), ctx = cv.getContext('2d', { willReadFrequently: true });
  const noise = makeNoise(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  // Aggregate speckle.
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  const rng = createRNG(seed + 7);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = noise(x / size, y / size, 5, 6) * 0.7 + noise(x / size, y / size, 3, 22) * 0.3;
      const s = rng() < 0.035 ? -32 : 0;
      const v = (n - 0.5) * 74 * dark + s;
      const i = (y * size + x) * 4;
      d[i] = Math.max(0, Math.min(255, d[i] + v));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + v));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + v * 0.92));
    }
  }
  ctx.putImageData(img, 0, 0);
  // Hairline cracks.
  ctx.strokeStyle = 'rgba(30,30,32,0.35)';
  for (let k = 0; k < 6; k++) {
    ctx.lineWidth = rng.range(0.5, 1.4);
    ctx.beginPath();
    let x = rng() * size, y = rng() * size, a = rng() * Math.PI * 2;
    ctx.moveTo(x, y);
    for (let s2 = 0; s2 < 28; s2++) {
      a += rng.range(-0.55, 0.55);
      x += Math.cos(a) * 6; y += Math.sin(a) * 6;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return cv;
}

function genConcreteHeight(seed) {
  const size = TEX_SIZE;
  const cv = canvas(size), ctx = cv.getContext('2d', { willReadFrequently: true });
  const noise = makeNoise(seed);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = noise(x / size, y / size, 5, 14);
      const v = 120 + (n - 0.5) * 150;
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function genMetalPanel(seed, base = '#6d737d', accent = '#4a5058') {
  const size = TEX_SIZE;
  const cv = canvas(size), ctx = cv.getContext('2d', { willReadFrequently: true });
  const noise = makeNoise(seed);
  const rng = createRNG(seed + 3);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  // Brushed streaks.
  for (let i = 0; i < 900; i++) {
    const y = rng() * size;
    ctx.strokeStyle = `rgba(255,255,255,${rng() * 0.05})`;
    ctx.lineWidth = rng.range(0.4, 1.6);
    ctx.beginPath();
    ctx.moveTo(rng() * size, y);
    ctx.lineTo(rng() * size, y + rng.range(-1, 1));
    ctx.stroke();
  }
  // Panel seams + rivets.
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2.5;
  ctx.strokeRect(2, 2, size - 4, size - 4);
  ctx.beginPath();
  ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(210,215,222,0.55)';
  for (let i = 0; i < 8; i++) {
    const rx = 12 + (i % 4) * ((size - 24) / 3);
    const ry = i < 4 ? 12 : size - 12;
    ctx.beginPath(); ctx.arc(rx, ry, 2.6, 0, Math.PI * 2); ctx.fill();
  }
  grungeOverlay(ctx, size, noise, 0.22, 7);
  // Rust streaks.
  for (let i = 0; i < 5; i++) {
    const x = rng() * size;
    const g = ctx.createLinearGradient(x, 0, x, size);
    g.addColorStop(0, 'rgba(120,64,28,0.0)');
    g.addColorStop(0.45, `rgba(120,64,28,${rng.range(0.08, 0.2)})`);
    g.addColorStop(1, 'rgba(80,42,18,0.0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, rng.range(4, 16), size);
  }
  return cv;
}

function genMetalHeight(seed) {
  const size = TEX_SIZE;
  const cv = canvas(size), ctx = cv.getContext('2d');
  ctx.fillStyle = '#8a8a8a';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#303030';
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, size - 4, size - 4);
  ctx.beginPath(); ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2); ctx.stroke();
  ctx.fillStyle = '#d8d8d8';
  for (let i = 0; i < 8; i++) {
    const rx = 12 + (i % 4) * ((size - 24) / 3);
    const ry = i < 4 ? 12 : size - 12;
    ctx.beginPath(); ctx.arc(rx, ry, 3, 0, Math.PI * 2); ctx.fill();
  }
  return cv;
}

function genWood(seed, base = '#8a6238') {
  const size = TEX_SIZE;
  const cv = canvas(size), ctx = cv.getContext('2d', { willReadFrequently: true });
  const noise = makeNoise(seed);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Grain: warped stripes along X.
      const warp = noise(x / size, y / size, 3, 3) * 26;
      const g = Math.sin((y + warp) * 0.55) * 0.5 + 0.5;
      const fine = noise(x / size, y / size, 4, 30);
      const v = (g * 0.62 + fine * 0.38 - 0.5) * 58;
      const i = (y * size + x) * 4;
      d[i] = Math.max(0, Math.min(255, d[i] + v));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + v * 0.78));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + v * 0.55));
    }
  }
  ctx.putImageData(img, 0, 0);
  // Plank seams.
  ctx.fillStyle = 'rgba(40,26,14,0.55)';
  for (let i = 1; i < 4; i++) ctx.fillRect(0, (size / 4) * i - 1, size, 2);
  return cv;
}

function genDirt(seed, base = '#6b5a44') {
  const size = TEX_SIZE;
  const cv = canvas(size), ctx = cv.getContext('2d', { willReadFrequently: true });
  const noise = makeNoise(seed);
  const rng = createRNG(seed + 11);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = noise(x / size, y / size, 6, 8);
      const v = (n - 0.5) * 88;
      const i = (y * size + x) * 4;
      d[i] = Math.max(0, Math.min(255, d[i] + v));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + v * 0.9));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + v * 0.72));
    }
  }
  ctx.putImageData(img, 0, 0);
  // Pebbles.
  for (let i = 0; i < 180; i++) {
    const x = rng() * size, y = rng() * size, r = rng.range(0.8, 2.6);
    const l = rng.range(-24, 30);
    ctx.fillStyle = `rgba(${118 + l},${104 + l},${86 + l},0.75)`;
    ctx.beginPath(); ctx.ellipse(x, y, r, r * rng.range(0.6, 1), rng() * 3, 0, Math.PI * 2); ctx.fill();
  }
  return cv;
}

function genAsphalt(seed) {
  const size = TEX_SIZE;
  const cv = canvas(size), ctx = cv.getContext('2d', { willReadFrequently: true });
  const noise = makeNoise(seed);
  const rng = createRNG(seed + 5);
  ctx.fillStyle = '#3a3d42';
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = noise(x / size, y / size, 5, 24);
      const v = (n - 0.5) * 46 + (rng() < 0.06 ? 22 : 0);
      const i = (y * size + x) * 4;
      d[i] = Math.max(0, Math.min(255, d[i] + v));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + v));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + v));
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

function genTile(seed, base = '#b9b4a8', groutCol = '#57544d', tiles = 4) {
  const size = TEX_SIZE;
  const cv = canvas(size), ctx = cv.getContext('2d', { willReadFrequently: true });
  const noise = makeNoise(seed);
  const rng = createRNG(seed + 13);
  ctx.fillStyle = groutCol;
  ctx.fillRect(0, 0, size, size);
  const step = size / tiles;
  for (let y = 0; y < tiles; y++) {
    for (let x = 0; x < tiles; x++) {
      const l = rng.range(-14, 14);
      ctx.fillStyle = shade(base, l);
      ctx.fillRect(x * step + 1.5, y * step + 1.5, step - 3, step - 3);
    }
  }
  grungeOverlay(ctx, size, noise, 0.2, 9);
  return cv;
}

function genBrick(seed) {
  const size = TEX_SIZE;
  const cv = canvas(size), ctx = cv.getContext('2d', { willReadFrequently: true });
  const noise = makeNoise(seed);
  const rng = createRNG(seed + 17);
  ctx.fillStyle = '#736c62';
  ctx.fillRect(0, 0, size, size);
  const rows = 8, bh = size / rows, bw = size / 4;
  // Bricks from one kiln batch still vary in hue, not just in brightness. Straight
  // brightness jitter on a single red reads as a cartoon wall; drifting each brick
  // between a bleached ochre and a dark burnt red is what makes it read as masonry.
  const BRICK_TONES = ['#96594a', '#8c5340', '#a3654d', '#7e4a3d', '#9c6b52', '#87503f'];
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * bw * 0.5;
    for (let c = -1; c < 5; c++) {
      const x = c * bw + off + 2;
      const y = r * bh + 2;
      ctx.fillStyle = shade(BRICK_TONES[rng.int(BRICK_TONES.length)], rng.range(-16, 14));
      ctx.fillRect(x, y, bw - 4, bh - 4);
      // A worn top edge on some courses — catches the key light and breaks the grid.
      if (rng() < 0.35) {
        ctx.fillStyle = `rgba(196,180,164,${rng.range(0.05, 0.16)})`;
        ctx.fillRect(x, y, bw - 4, 2);
      }
    }
  }
  grungeOverlay(ctx, size, noise, 0.26, 6);
  return cv;
}

function genSandbag(seed) {
  const size = TEX_SIZE;
  const cv = canvas(size), ctx = cv.getContext('2d', { willReadFrequently: true });
  const noise = makeNoise(seed);
  ctx.fillStyle = '#9c8f6d';
  ctx.fillRect(0, 0, size, size);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const weave = (Math.sin(x * 1.6) * Math.sin(y * 1.6)) * 12;
      const n = (noise(x / size, y / size, 4, 12) - 0.5) * 40;
      const i = (y * size + x) * 4;
      d[i] = Math.max(0, Math.min(255, d[i] + weave + n));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + weave + n * 0.9));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + weave + n * 0.7));
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/**
 * Packed roughness/metalness map.
 *
 * `MeshStandardMaterial` reads roughness from the **G** channel and metalness from the
 * **B** channel, so one canvas can drive both for the price of a single sampler — and,
 * more importantly, it lets a surface stop being one flat number. A scalar roughness is
 * the single biggest reason a procedural scene reads as plastic: real concrete is dry
 * and chalky in one patch and damp and glossy two metres away, and paint chips off a
 * container to leave bare, mirror-bright steel.
 *
 * All knobs are optional; the defaults produce a plain matte dielectric.
 */
function genRM(seed, {
  rough = 0.9, roughVar = 0.1, roughFreq = 6,
  metal = 0.0, metalVar = 0.0,
  wet = 0, wetFreq = 1.9, wetRough = 0.3,   // damp/polished blotches
  streak = 0,                                // vertical wear runs (brushed + weathered metal)
  chip = 0, chipRough = 0.3,                 // paint chips exposing bare metal
  grout = 0, groutRough = 0.95, tiles = 4,   // rougher mortar/grout lines
  planks = 0, plankRough = 0.34, plankRows = 4, // varnished vs raw boards
} = {}) {
  const size = RM_SIZE;
  const cv = canvas(size), ctx = cv.getContext('2d', { willReadFrequently: true });
  const nA = makeNoise(seed);
  const nB = makeNoise(seed + 61);
  const rng = createRNG(seed + 23);
  const varnished = new Uint8Array(plankRows);
  for (let i = 0; i < plankRows; i++) varnished[i] = rng() < 0.5 ? 1 : 0;

  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let r = rough + (nA(u, v, 4, roughFreq) - 0.5) * 2 * roughVar;
      let m = metal + (nA(u, v, 3, roughFreq * 1.7) - 0.5) * 2 * metalVar;

      if (wet > 0) {
        // Threshold a low-frequency field so damp areas form connected patches rather
        // than an even wash — a wash just shifts the average and looks like nothing.
        const w = clamp01((nB(u, v, 3, wetFreq) - (1 - wet) * 0.62) / Math.max(0.06, wet * 0.5));
        r += (wetRough - r) * w;
      }
      if (streak > 0) r += (nB(u * 0.1, v, 4, 10) - 0.5) * streak;
      if (planks > 0) {
        const row = Math.min(plankRows - 1, Math.floor(v * plankRows));
        if (varnished[row]) r += (plankRough - r) * planks;
      }
      if (grout > 0) {
        const gx = Math.abs(((u * tiles) % 1) - 0.5);
        const gy = Math.abs(((v * tiles) % 1) - 0.5);
        if (gx > 0.455 || gy > 0.455) r += (groutRough - r) * grout;
      }
      if (chip > 0 && nA(u, v, 4, 24) > 1 - chip * 0.34) { r = chipRough; m = 0.94; }

      const i = (y * size + x) * 4;
      d[i] = 255;
      d[i + 1] = clamp01(r) * 255;
      d[i + 2] = clamp01(m) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/**
 * Seamless low-frequency fBm, greyscale. Two of these sampled at different scales are
 * what drive both the world-space macro variation on every surface and the cloud deck
 * on the sky dome.
 *
 * It is a texture rather than GLSL noise on purpose. Evaluating two octaves of value
 * noise per fragment costs sixteen hashes on every opaque pixel *and* the whole sky;
 * two bilinear taps cost two bilinear taps, look better (the texture can afford five
 * octaves), and keep the frame inside a budget aimed at integrated GPUs.
 */
function genFbmField(seed, { size = 128, octaves = 5, freq = 2, gain = 0.52, contrast = 1 } = {}) {
  const cv = canvas(size), ctx = cv.getContext('2d', { willReadFrequently: true });
  const noise = makeNoise(seed);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = noise(x / size, y / size, octaves, freq, gain);
      n = clamp01((n - 0.5) * contrast + 0.5);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = n * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/**
 * Cloud field for the sky dome. Built here rather than in `Engine` so it shares the
 * project's one noise implementation, and exported as a bare factory because the sky is
 * constructed before `Assets.init()` runs.
 */
export function makeCloudTexture() {
  const t = toTexture(genFbmField(2408, { size: 256, octaves: 6, freq: 3, gain: 0.55, contrast: 1.25 }));
  t.anisotropy = 4;
  return t;
}

function shade(hex, amt) {
  const c = new THREE.Color(hex);
  c.r = Math.max(0, Math.min(1, c.r + amt / 255));
  c.g = Math.max(0, Math.min(1, c.g + amt / 255));
  c.b = Math.max(0, Math.min(1, c.b + amt / 255));
  return `#${c.getHexString()}`;
}

/** Radial soft dot — used for muzzle flash, particles, glows. */
function genGlow(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const cv = canvas(128), ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, inner.replace(/[\d.]+\)$/, '0.55)'));
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return cv;
}

/** Irregular bullet hole with cracked rim, alpha-cut. */
function genBulletHole(seed, colorCore = '#0c0c0e') {
  const size = 128;
  const cv = canvas(size), ctx = cv.getContext('2d');
  const rng = createRNG(seed);
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2;

  // Scuff halo — the dirt a round throws onto the surface around the hole. Kept wide
  // and faint so the decal blends into the wall instead of stamping a dark disc.
  const halo = ctx.createRadialGradient(cx, cy, 5, cx, cy, 60);
  halo.addColorStop(0, 'rgba(38,36,34,0.55)');
  halo.addColorStop(0.28, 'rgba(74,71,67,0.30)');
  halo.addColorStop(0.62, 'rgba(96,93,88,0.12)');
  halo.addColorStop(1, 'rgba(120,118,114,0)');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(cx, cy, 62, 0, Math.PI * 2); ctx.fill();

  // Bright spall rim: material blown back from the entry, which is what actually
  // makes a hole read as a hole rather than a black dot.
  const rim = ctx.createRadialGradient(cx, cy, 7, cx, cy, 17);
  rim.addColorStop(0, 'rgba(206,201,192,0)');
  rim.addColorStop(0.55, 'rgba(206,201,192,0.42)');
  rim.addColorStop(1, 'rgba(206,201,192,0)');
  ctx.fillStyle = rim;
  ctx.beginPath(); ctx.arc(cx, cy, 17, 0, Math.PI * 2); ctx.fill();

  // Core hole — small and irregular. A 5.56 hole is tiny next to its scuff.
  ctx.fillStyle = colorCore;
  ctx.beginPath();
  for (let i = 0; i <= 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    const r = 8.5 + rng.range(-1.8, 1.8);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.fill();

  // Short hairline fractures. Long radiating strokes read as a cartoon spider, so
  // these stay inside ~1.6x the core radius and fade out.
  ctx.strokeStyle = 'rgba(34,32,32,0.34)';
  for (let i = 0; i < 6; i++) {
    const a = rng() * Math.PI * 2;
    ctx.lineWidth = rng.range(0.5, 1.05);
    let x = cx + Math.cos(a) * 8, y = cy + Math.sin(a) * 8, aa = a;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const segs = 2 + rng.int(2);
    for (let s = 0; s < segs; s++) {
      aa += rng.range(-0.35, 0.35);
      x += Math.cos(aa) * rng.range(1.8, 3.2);
      y += Math.sin(aa) * rng.range(1.8, 3.2);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return cv;
}

function genBloodDecal(seed) {
  const size = 128;
  const cv = canvas(size), ctx = cv.getContext('2d');
  const rng = createRNG(seed);
  ctx.clearRect(0, 0, size, size);
  const cx = 64, cy = 64;
  ctx.fillStyle = 'rgba(96,8,10,0.9)';
  ctx.beginPath();
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r = 26 + Math.sin(a * 3 + seed) * 7 + rng.range(-5, 5);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.fill();
  for (let i = 0; i < 22; i++) {
    const a = rng() * Math.PI * 2, d = rng.range(26, 60);
    ctx.fillStyle = `rgba(${100 + rng.int(30)},6,8,${rng.range(0.35, 0.85)})`;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rng.range(1.2, 5), 0, Math.PI * 2);
    ctx.fill();
  }
  return cv;
}

function genScorchDecal() {
  const size = 128;
  const cv = canvas(size), ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(8,8,8,0.95)');
  g.addColorStop(0.5, 'rgba(22,18,16,0.6)');
  g.addColorStop(1, 'rgba(40,34,30,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return cv;
}

function genSmoke(seed) {
  const size = 128;
  const cv = canvas(size), ctx = cv.getContext('2d', { willReadFrequently: true });
  const noise = makeNoise(seed);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - 64) / 64, dy = (y - 64) / 64;
      const r = Math.hypot(dx, dy);
      const n = noise(x / size, y / size, 5, 5);
      const a = Math.max(0, 1 - r) * (0.45 + n * 0.85);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.min(255, a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

// ------------------------------------------------------- world-space macro variation

/**
 * Tiling is the tell.
 *
 * A 256² concrete texture at two metres per repeat means a 20 m wall shows the same
 * ten centimetre crack ten times, and no amount of detail in the tile itself hides it —
 * the eye locks onto the *period*, not the content. The standard fix is a second layer
 * of variation at a frequency far below the tiling period, driven by world position so
 * it can never repeat with the UVs.
 *
 * This injects exactly that into every surface material: two octaves of world-space
 * value noise at ~18 m and ~6 m, modulating albedo (a warm/cool, light/dark drift) and
 * roughness (damp patches that cross tile seams). It costs one varying and ~16 cheap
 * hashes per fragment, shares a single compiled program across every material that uses
 * it, and it is the difference between "a texture" and "a wall".
 *
 * The same hook also owns sun-tinted aerial perspective — `THREE.FogExp2` has one flat
 * colour, but real haze glows warm when you look toward the sun and stays cool when you
 * look away, which is most of what makes distance feel like distance.
 */
const MACRO_TINT_LOW = new THREE.Color(0.775, 0.775, 0.755);
const MACRO_TINT_HIGH = new THREE.Color(1.11, 1.10, 1.06);
/** Filled in by `Assets.init()`; shared by every hooked material. */
const MACRO_FIELD = { texture: null };

const MACRO_COMMON = /* glsl */`
varying vec3 vMacroPos;
uniform sampler2D uMacroTex;
uniform float uMacroAmt;
uniform float uMacroScale;
uniform float uMacroRough;
uniform vec3 uMacroLow;
uniform vec3 uMacroHigh;
uniform vec3 uSunDir;
uniform vec3 uFogSun;

// Two taps at incommensurate scales and on different axis pairs. Using XZ for one and
// ZY for the other means no surface orientation — floor, north wall, east wall — ends
// up sampling a constant, which a single planar lookup would.
float osMacro(vec3 p) {
  return texture2D(uMacroTex, p.xz).r * 0.62
       + texture2D(uMacroTex, p.zy * 1.73 + 0.37).r * 0.38;
}
`;

/**
 * Assigned as `onBeforeCompile` on every library material. It is ONE shared function
 * object, so three's default `customProgramCacheKey()` (which stringifies it) hashes
 * identically for all of them and the whole library still shares compiled programs;
 * the per-material knobs travel as uniforms, not as baked-in constants.
 */
function macroHook(shader) {
  const p = this.userData.macro || {};
  shader.uniforms.uMacroTex = { value: MACRO_FIELD.texture };
  shader.uniforms.uMacroAmt = { value: p.amt ?? 0 };
  shader.uniforms.uMacroScale = { value: p.scale ?? 0.02 };
  shader.uniforms.uMacroRough = { value: p.rough ?? 0 };
  shader.uniforms.uMacroLow = { value: MACRO_TINT_LOW };
  shader.uniforms.uMacroHigh = { value: MACRO_TINT_HIGH };
  shader.uniforms.uSunDir = { value: ATMOSPHERE.sunDir };
  shader.uniforms.uFogSun = { value: ATMOSPHERE.fogSun };

  shader.vertexShader = 'varying vec3 vMacroPos;\n' + shader.vertexShader.replace(
    '#include <project_vertex>',
    /* glsl */`
    #include <project_vertex>
    vec4 osWorld = vec4( transformed, 1.0 );
    #ifdef USE_INSTANCING
      osWorld = instanceMatrix * osWorld;
    #endif
    vMacroPos = ( modelMatrix * osWorld ).xyz;
    `,
  );

  shader.fragmentShader = MACRO_COMMON + shader.fragmentShader
    .replace('#include <map_fragment>', /* glsl */`
      #include <map_fragment>
      float osM = 0.5;
      if ( uMacroAmt > 0.0 ) {
        osM = osMacro( vMacroPos * uMacroScale );
        diffuseColor.rgb *= mix( vec3( 1.0 ), mix( uMacroLow, uMacroHigh, osM ), uMacroAmt );
      }
    `)
    .replace('#include <roughnessmap_fragment>', /* glsl */`
      #include <roughnessmap_fragment>
      roughnessFactor = clamp( roughnessFactor + ( osM - 0.5 ) * uMacroRough, 0.035, 1.0 );
    `)
    .replace('#include <fog_fragment>', /* glsl */`
      #ifdef USE_FOG
        #ifdef FOG_EXP2
          float osFog = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
        #else
          float osFog = smoothstep( fogNear, fogFar, vFogDepth );
        #endif
        vec3 osView = normalize( vMacroPos - cameraPosition );
        float osSun = max( dot( osView, uSunDir ), 0.0 );
        vec3 osHaze = mix( fogColor, uFogSun, pow( osSun, 4.0 ) * 0.85 );
        gl_FragColor.rgb = mix( gl_FragColor.rgb, osHaze, clamp( osFog, 0.0, 1.0 ) );
      #endif
    `);
}

// ---------------------------------------------------------------- library

export class Assets {
  constructor() {
    this.textures = new Map();
    this.materials = new Map();
    this.geometries = new Map();
    this.ready = false;
  }

  init() {
    if (this.ready) return;

    // --- textures
    const concrete = genConcrete(101);
    const concreteN = heightToNormal(genConcreteHeight(101), 1.7);
    const concreteDark = genConcrete(202, '#5d6064', 0.75);
    const metal = genMetalPanel(303);
    const metalN = heightToNormal(genMetalHeight(303), 3.2);
    const metalRed = genMetalPanel(304, '#7d4038', '#4c231f');
    const metalGreen = genMetalPanel(305, '#4d5b45', '#2f3a2b');
    const wood = genWood(404);
    const woodN = heightToNormal(genWood(404, '#808080'), 1.4);
    const dirt = genDirt(505);
    const dirtN = heightToNormal(genDirt(505, '#808080'), 2.2);
    const asphalt = genAsphalt(606);
    const tile = genTile(707);
    const brick = genBrick(808);
    const sandbag = genSandbag(909);
    const plaster = genConcrete(1010, '#b6ac9a', 0.35);

    this._tex('concrete', concrete, { repeat: 1, srgb: true });
    this._tex('concreteN', concreteN, { repeat: 1 });
    this._tex('concreteDark', concreteDark, { repeat: 1, srgb: true });
    this._tex('metal', metal, { repeat: 1, srgb: true });
    this._tex('metalN', metalN, { repeat: 1 });
    this._tex('metalRed', metalRed, { repeat: 1, srgb: true });
    this._tex('metalGreen', metalGreen, { repeat: 1, srgb: true });
    this._tex('wood', wood, { repeat: 1, srgb: true });
    this._tex('woodN', woodN, { repeat: 1 });
    this._tex('dirt', dirt, { repeat: 1, srgb: true });
    this._tex('dirtN', dirtN, { repeat: 1 });
    this._tex('asphalt', asphalt, { repeat: 1, srgb: true });
    this._tex('tile', tile, { repeat: 1, srgb: true });
    this._tex('brick', brick, { repeat: 1, srgb: true });
    this._tex('sandbag', sandbag, { repeat: 1, srgb: true });
    this._tex('plaster', plaster, { repeat: 1, srgb: true });
    this._tex('glow', genGlow(), { repeat: 1, srgb: true });
    this._tex('smoke', genSmoke(1234), { repeat: 1, srgb: true });
    this._tex('bulletHole', genBulletHole(1), { repeat: 1, srgb: true });
    this._tex('bulletHoleMetal', genBulletHole(2, '#1a1c20'), { repeat: 1, srgb: true });
    this._tex('bulletHoleGlass', genBulletHole(3, '#c8dbe6'), { repeat: 1, srgb: true });
    this._tex('blood', genBloodDecal(9), { repeat: 1, srgb: true });
    this._tex('scorch', genScorchDecal(), { repeat: 1, srgb: true });

    // --- roughness/metalness (G = roughness, B = metalness)
    // This is where surfaces stop being interchangeable. Every entry below is a
    // deliberate material story, not a number nudge.
    this._tex('rmConcrete', genRM(1101, {          // dry and chalky, damp in the low spots
      rough: 0.93, roughVar: 0.09, roughFreq: 7, wet: 0.5, wetFreq: 1.7, wetRough: 0.66,
    }));
    this._tex('rmConcreteWet', genRM(1102, {       // shaded/north faces stay damp longer
      rough: 0.9, roughVar: 0.1, roughFreq: 6, wet: 0.62, wetFreq: 1.5, wetRough: 0.55,
    }));
    this._tex('rmPlaster', genRM(1103, {           // chalky lime render — no sheen anywhere
      rough: 0.97, roughVar: 0.035, roughFreq: 10,
    }));
    this._tex('rmMetal', genRM(1104, {             // polished panels, worn dull at the edges
      rough: 0.4, roughVar: 0.26, roughFreq: 4, metal: 0.9, metalVar: 0.1, streak: 0.22,
    }));
    this._tex('rmPaint', genRM(1105, {             // painted steel: dielectric, chipped to bare metal
      rough: 0.58, roughVar: 0.16, roughFreq: 5, metal: 0.1, metalVar: 0.05,
      streak: 0.14, chip: 0.55, chipRough: 0.31,
    }));
    this._tex('rmWood', genRM(1106, {              // some boards varnished, some raw
      rough: 0.82, roughVar: 0.13, roughFreq: 8, planks: 0.85, plankRough: 0.36,
    }));
    this._tex('rmDirt', genRM(1107, { rough: 0.99, roughVar: 0.03, roughFreq: 9 }));
    this._tex('rmAsphalt', genRM(1108, {           // ruts hold water and shine
      rough: 0.88, roughVar: 0.12, roughFreq: 6, wet: 0.4, wetFreq: 2.4, wetRough: 0.52,
    }));
    this._tex('rmTile', genRM(1109, {              // glazed tile with rough grout
      rough: 0.4, roughVar: 0.1, roughFreq: 7, grout: 1, groutRough: 0.94, tiles: 4,
    }));
    this._tex('rmBrick', genRM(1110, {
      rough: 0.92, roughVar: 0.08, roughFreq: 9, grout: 0.7, groutRough: 0.99, tiles: 4,
    }));
    this._tex('rmCloth', genRM(1111, { rough: 1.0, roughVar: 0.02, roughFreq: 12 }));

    // Large-scale discolouration field, sampled in world space by every surface shader
    // so a 20 m wall stops reading as one texture repeated ten times.
    this._tex('macroField', genFbmField(4242, { size: 128, octaves: 5, freq: 2, gain: 0.5, contrast: 1.15 }));
    MACRO_FIELD.texture = this.textures.get('macroField');

    // --- surface materials
    // With a roughness/metalness map the scalars become multipliers, so they sit at 1
    // and the map carries the absolute values.
    this._surface('concrete', { map: 'concrete', normalMap: 'concreteN', rm: 'rmConcrete', normalScale: 0.85, macro: { amt: 0.55, rough: 0.2 } });
    this._surface('concreteDark', { map: 'concreteDark', normalMap: 'concreteN', rm: 'rmConcreteWet', normalScale: 0.75, macro: { amt: 0.55, rough: 0.22 } });
    this._surface('plaster', { map: 'plaster', normalMap: 'concreteN', rm: 'rmPlaster', normalScale: 0.4, macro: { amt: 0.6, rough: 0.08 } });
    this._surface('metal', { map: 'metal', normalMap: 'metalN', rm: 'rmMetal', normalScale: 1.0, macro: { amt: 0.3, rough: 0.16 } });
    this._surface('metalRed', { map: 'metalRed', normalMap: 'metalN', rm: 'rmPaint', normalScale: 1.0, macro: { amt: 0.34, rough: 0.16 } });
    this._surface('metalGreen', { map: 'metalGreen', normalMap: 'metalN', rm: 'rmPaint', normalScale: 1.0, macro: { amt: 0.34, rough: 0.16 } });
    this._surface('wood', { map: 'wood', normalMap: 'woodN', rm: 'rmWood', normalScale: 0.65, macro: { amt: 0.34, rough: 0.14 } });
    this._surface('dirt', { map: 'dirt', normalMap: 'dirtN', rm: 'rmDirt', normalScale: 1.0, macro: { amt: 0.6, rough: 0.06 } });
    this._surface('asphalt', { map: 'asphalt', normalMap: 'concreteN', rm: 'rmAsphalt', normalScale: 0.5, macro: { amt: 0.5, rough: 0.2 } });
    this._surface('tile', { map: 'tile', normalMap: 'concreteN', rm: 'rmTile', normalScale: 0.3, macro: { amt: 0.42, rough: 0.14 } });
    this._surface('brick', { map: 'brick', normalMap: 'concreteN', rm: 'rmBrick', normalScale: 0.95, macro: { amt: 0.6, rough: 0.1 } });
    this._surface('sandbag', { map: 'sandbag', normalMap: 'dirtN', rm: 'rmCloth', normalScale: 0.85, macro: { amt: 0.45, rough: 0.05 } });

    this.materials.set('glass', new THREE.MeshPhysicalMaterial({
      color: 0x9fc4d8, transparent: true, opacity: 0.22, roughness: 0.06,
      metalness: 0.0, transmission: 0.0, side: THREE.DoubleSide,
      depthWrite: false,
    }));
    this.materials.set('glassBroken', new THREE.MeshStandardMaterial({
      color: 0xaad0e2, transparent: true, opacity: 0.12, roughness: 0.35, side: THREE.DoubleSide, depthWrite: false,
    }));
    this.materials.set('rubber', new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 0.95, metalness: 0.0 }));
    this.materials.set('gunmetal', new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.4, metalness: 0.92 }));
    this.materials.set('gunPolymer', new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.72, metalness: 0.05 }));
    this.materials.set('gunTan', new THREE.MeshStandardMaterial({ color: 0x93805f, roughness: 0.68, metalness: 0.06 }));
    this.materials.set('brass', new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.26, metalness: 1.0 }));
    this.materials.set('glassOptic', new THREE.MeshStandardMaterial({
      color: 0x1a3f4d, roughness: 0.08, metalness: 0.4, emissive: 0x0a2530, emissiveIntensity: 0.6,
    }));

    // Every library material gets the macro/aerial-perspective hook. Non-surface
    // materials pass amt 0, so the noise branch is skipped, but they still pick up the
    // sun-tinted fog — a grenade at 40 m has to sit in the same air as the wall behind it.
    for (const m of this.materials.values()) this._hook(m);

    this.ready = true;
  }

  _tex(name, cv, opts) { this.textures.set(name, toTexture(cv, opts)); }

  /** Attach the shared world-space variation + aerial-perspective shader hook. */
  _hook(m, macro) {
    if (macro) m.userData.macro = macro;
    if (!m.userData.macro) m.userData.macro = { amt: 0, scale: 0.02, rough: 0 };
    m.onBeforeCompile = macroHook;
    m.needsUpdate = true;
    return m;
  }

  _surface(name, { map, normalMap, rm, roughness = 1, metalness = 1, normalScale = 1, macro }) {
    const rmTex = rm ? this.textures.get(rm) : null;
    const m = new THREE.MeshStandardMaterial({
      map: this.textures.get(map),
      normalMap: normalMap ? this.textures.get(normalMap) : null,
      roughnessMap: rmTex,
      metalnessMap: rmTex,
      roughness, metalness,
    });
    if (m.normalMap) m.normalScale.set(normalScale, normalScale);
    m.userData.surface = name;
    m.userData.macro = { amt: 0, scale: 0.02, rough: 0, ...(macro || {}) };
    this.materials.set(name, m);
  }

  tex(name) {
    const t = this.textures.get(name);
    if (!t) console.warn(`[assets] missing texture "${name}"`);
    return t;
  }

  mat(name) {
    const m = this.materials.get(name);
    if (!m) {
      console.warn(`[assets] missing material "${name}"`);
      return this.materials.get('concrete');
    }
    return m;
  }

  /**
   * A per-object clone of a surface material with its own UV repeat.
   * Cached by (name, repeatX, repeatY) so N walls of the same tiling share one material.
   */
  tiled(name, rx, ry = rx) {
    const key = `${name}|${rx.toFixed(2)}|${ry.toFixed(2)}`;
    let m = this.materials.get(key);
    if (m) return m;
    const base = this.mat(name);
    m = base.clone();
    m.userData.surface = base.userData.surface || name;

    const retile = (t) => {
      const c = t.clone();
      c.needsUpdate = true;
      c.wrapS = c.wrapT = THREE.RepeatWrapping;
      c.repeat.set(rx, ry);
      return c;
    };
    if (base.map) m.map = retile(base.map);
    if (base.normalMap) m.normalMap = retile(base.normalMap);
    // roughnessMap and metalnessMap are deliberately the SAME packed texture, so retile
    // it once and share — cloning twice would double the VRAM for nothing.
    if (base.roughnessMap) {
      const c = retile(base.roughnessMap);
      m.roughnessMap = c;
      m.metalnessMap = base.metalnessMap === base.roughnessMap ? c
        : (base.metalnessMap ? retile(base.metalnessMap) : null);
    } else if (base.metalnessMap) {
      m.metalnessMap = retile(base.metalnessMap);
    }
    // `Material.copy()` does not carry `onBeforeCompile`, so the clone would silently
    // lose macro variation and sun-tinted fog and stand out against everything else.
    this._hook(m);
    this.materials.set(key, m);
    return m;
  }

  /** Shared unit box, reused everywhere via per-mesh scale. */
  unitBox() {
    let g = this.geometries.get('unitBox');
    if (!g) {
      g = new THREE.BoxGeometry(1, 1, 1);
      this.geometries.set('unitBox', g);
    }
    return g;
  }

  dispose() {
    for (const t of this.textures.values()) t.dispose();
    for (const m of this.materials.values()) m.dispose();
    for (const g of this.geometries.values()) g.dispose();
    this.textures.clear(); this.materials.clear(); this.geometries.clear();
    this.ready = false;
  }
}

export const assets = new Assets();
