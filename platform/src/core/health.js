/**
 * Health.  contracts/http-api.md §7.1, Build Plan §P1.A1.
 *
 * Two endpoints that answer genuinely different questions, which is why they are not one:
 *
 *   /v1/health        Is this process alive?        Public. No dependency detail, ever.
 *   /v1/health/ready  Should it receive traffic?    Service-only. Per-dependency.
 *
 * Conflating them is how a deploy either drains nothing (liveness that checks the database
 * restarts a healthy process when the database blips) or drains everything (readiness that
 * only checks the process keeps sending players to an instance that cannot serve them).
 *
 * The public one deliberately leaks nothing. "db: down" on an unauthenticated endpoint tells
 * an attacker which dependency to keep pushing on.
 */

export function createHealth({ deps }) {
  const startedAt = Date.now();

  /** Liveness: the event loop is turning and we can allocate. Nothing else. */
  async function live() {
    return { ok: true, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) };
  }

  /**
   * Readiness: every dependency this process needs to serve a request.
   *
   * Each probe is individually timed and bounded — a readiness check that hangs because a
   * dependency hangs is a readiness check that never fails, which is worse than one that
   * reports the failure.
   */
  async function ready() {
    const entries = Object.entries(deps.healthProbes || {});
    // Probes run in PARALLEL. Sequentially, N sick dependencies cost N x 2 s and readiness
    // itself exceeds a typical 5 s orchestrator timeout — the check becomes the outage.
    const results = await Promise.all(entries.map(async ([name, probe]) => {
      try {
        const result = await withTimeout(probe(), 2000);
        return [name, result && result.ok ? 'up' : 'down'];
      } catch { return [name, 'down']; }
    }));

    const dependencies = {};
    let ok = true;
    for (const [name, status] of results) {
      dependencies[name] = status;          // §7.1 fixes this as the string 'up'|'down'
      if (status !== 'up') ok = false;
    }
    // §11: anything not stated is forbidden, so no uptime field here. It lives on liveness,
    // where the contract does not constrain the shape.
    return { ok, dependencies };
  }

  return { live, ready };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
