/**
 * Seeded RNG (mulberry32). Deterministic — used so bot behaviour, spread and
 * level dressing can be reproduced when debugging.
 */
export function createRNG(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  const rng = function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (min, max) => min + rng() * (max - min);
  rng.int = (n) => Math.floor(rng() * n);
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.sign = () => (rng() < 0.5 ? -1 : 1);
  rng.chance = (p) => rng() < p;
  /** Box-Muller, cached second sample. */
  let spare = null;
  rng.gauss = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0, s = 0;
    do { u = rng() * 2 - 1; v = rng() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * m;
    return u * m;
  };
  rng.reseed = (s) => { a = s >>> 0; spare = null; };
  return rng;
}

/**
 * Derive an independent stream seed from a base seed and an index.
 *
 * Used to give each actor its own RNG rather than sharing one. A shared stream makes
 * every consumer's draws depend on how many draws *everyone else* made first, so
 * behaviour becomes a function of scheduling — which a networked simulation cannot
 * reproduce and a replay cannot rewind. Independent streams are also individually
 * snapshottable, where one interleaved stream is not.
 */
export function mixSeed(seed, index) {
  let h = ((seed >>> 0) ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ ((index + 0x85ebca6b) | 0), 0xcc9e2d51) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x1b873593) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
