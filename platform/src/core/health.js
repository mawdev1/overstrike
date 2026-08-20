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
    const checks = {};
    let ok = true;

    for (const [name, probe] of Object.entries(deps.healthProbes || {})) {
      const t0 = Date.now();
      try {
        const result = await withTimeout(probe(), 2000);
        checks[name] = { status: result.ok ? 'up' : 'down', ms: Date.now() - t0 };
        if (!result.ok) ok = false;
      } catch (err) {
        checks[name] = {
          status: 'down',
          ms: Date.now() - t0,
          // Internal surface, service-authenticated: naming the failure is the point here,
          // unlike the public endpoint.
          detail: err && err.message === 'timeout' ? 'timeout' : 'error',
        };
        ok = false;
      }
    }
    return { ok, dependencies: checks, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) };
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
