/**
 * The stub clock.  contracts/http-api.md §11.10 ("Same scenario, same sequence, same
 * responses, every run").
 *
 * Wall-clock time is the single easiest way to destroy that guarantee: one `Date.now()` in a
 * payload and two runs of the same scenario differ in every timestamp, so Codex cannot snapshot
 * a response and no test can assert byte equality. So the stub layer has no access to the real
 * clock at all — this is the only source of time, it starts at a fixed epoch, and it advances
 * only when a request is served.
 *
 * The step is per scenario because `token-expiry` needs virtual seconds to actually pass
 * (30 s of them) inside a handful of requests, without any scenario sleeping.
 */

/** 2026-03-01T00:00:00.000Z. Arbitrary, fixed, and in the past so `createdAt` reads sanely. */
export const EPOCH_MS = Date.UTC(2026, 2, 1, 0, 0, 0);

export const DEFAULT_STEP_MS = 1000;

export const iso = (ms) => new Date(ms).toISOString();

/**
 * A clock for one scenario session.
 *
 * `now()` is stable within a request: `tick()` is called once, at the start of request
 * handling, so every timestamp minted while serving one request agrees with every other.
 */
export function createClock(stepMs = DEFAULT_STEP_MS) {
  let ms = EPOCH_MS;
  return {
    stepMs,
    tick() { ms += stepMs; return ms; },
    nowMs() { return ms; },
    now() { return iso(ms); },
    plus(deltaMs) { return iso(ms + deltaMs); },
    /** Fixed points, independent of how many requests have been served. */
    fromEpoch(deltaMs) { return iso(EPOCH_MS + deltaMs); },
  };
}
