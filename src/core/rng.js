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

  /**
   * Capture / restore the stream's exact position.
   *
   * Reconciliation replays a tick: restore the world to the state before it, feed the
   * command again, and the result must be identical. Any draw taken during that tick
   * has to come from the same place in the stream both times, so the stream position is
   * simulation state like any other and belongs in the snapshot.
   *
   * `spare` matters as much as `a`. `gauss` draws a variable number of times (rejection
   * sampling) and caches its second sample, so a stream that has one banked is a full
   * draw ahead of an identical-looking one that does not. Capturing `a` alone restores
   * to a position that is off by however much the next gauss consumes.
   *
   * `getState` takes an optional out-object because this runs per entity per tick and
   * allocating a fresh one each time is the kind of garbage a fixed-timestep loop
   * notices.
   */
  rng.getState = (out) => {
    const o = out || {};
    o.a = a >>> 0;
    o.spare = spare;
    return o;
  };
  rng.setState = (s) => {
    a = s.a >>> 0;
    // Anything nullish means "no banked sample" — tolerated so a state that has been
    // through JSON (where `null` survives but `undefined` silently vanishes) restores
    // the same as one that has not.
    spare = (s.spare === undefined || s.spare === null) ? null : s.spare;
  };
  return rng;
}

/**
/**
 * A draw addressed by INDEX rather than by stream position.
 *
 * Prediction cannot use a shared stream. The client re-simulates its own shots
 * immediately, but it has no idea how many draws the server's other entities made in
 * between — bots thinking, other players firing — so a streamed `rng()` puts the two
 * machines at different positions and the same shot spreads differently on each. That is
 * not a bug that shows up as a warning; it shows up as bullets landing somewhere else.
 *
 * Addressing a draw as `hash(matchSeed, shooterId, shotSeq, pelletIndex)` removes the
 * ordering dependence entirely: the Nth pellet of a shooter's Mth shot is the same number
 * on every machine, whenever it is computed, in whatever order.
 *
 * Returns [0, 1). Same avalanche as `mixSeed`, one more round.
 */
export function hashRandom(seed, a, b = 0, c = 0) {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ ((a | 0) + 0x85ebca6b), 0xcc9e2d51) >>> 0;
  h = Math.imul(h ^ ((b | 0) + 0x165667b1), 0x1b873593) >>> 0;
  h = Math.imul(h ^ ((c | 0) + 0xd3a2646c), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * An index-addressable RNG shaped like `createRNG`'s callable, for APIs that take one.
 *
 * Each call advances a local counter, so N calls inside one shot are N distinct draws —
 * but the sequence is a pure function of the address, not of anything that happened
 * earlier on this machine.
 */
export function addressedRNG(seed, a, b = 0) {
  let n = 0;
  const fn = () => hashRandom(seed, a, b, n++);
  fn.range = (min, max) => min + fn() * (max - min);
  fn.int = (k) => Math.floor(fn() * k);
  fn.sign = () => (fn() < 0.5 ? -1 : 1);
  fn.chance = (p) => fn() < p;
  return fn;
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
