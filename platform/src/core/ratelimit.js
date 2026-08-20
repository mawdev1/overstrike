/**
 * Rate limiting.  contracts/http-api.md §9.
 *
 * A sliding window per (class, subject). Two properties matter more than the algorithm:
 *
 *  1. Limits are enforced HERE as well as at the edge. The edge can be bypassed — a request
 *     that reaches this process has already gone around whatever the CDN thought.
 *  2. Auth limits key on IP *and* account. Keying only on account lets an attacker enumerate
 *     accounts freely; keying only on IP lets a botnet past. Neither alone is a limit.
 */
const CLASSES = {
  // §9 specifies TWO limits for auth, and they must be separate buckets. A single composite
  // `ip+account` key means rotating source IPs multiplies the per-account budget without
  // limit — 200 IPs bought 2000 attempts against one account against a stated cap of 5.
  authIp:      { perMin: 10, subject: 'ip' },
  authAccount: { perMin: 5,  subject: 'account' },
  read:   { perMin: 120, subject: 'account' },
  write:  { perMin: 30, subject: 'account' },
  room:   { perMin: 20, subject: 'account' },
  report: { perMin: 10, windowMs: 3600_000, subject: 'account' },
};

export function createRateLimiter({ clock = Date.now } = {}) {
  /** key -> array of timestamps. Trimmed on read, so an idle key costs nothing to hold. */
  const hits = new Map();

  /**
   * Auth is two checks, not one. Both must pass; either exhausted denies.
   *
   * The IP bucket stops a single host brute-forcing; the account bucket stops a distributed
   * attempt on one victim. Neither alone is a limit, which is what the composite key was.
   */
  function checkAuth({ ip, account }) {
    const byIp = check('authIp', ip || 'unknown');
    if (!byIp.allowed) return byIp;
    if (!account) return byIp;
    const byAccount = check('authAccount', account);
    if (!byAccount.allowed) return byAccount;
    return { allowed: true, retryAfterMs: null };
  }

  function check(className, subject) {
    const spec = CLASSES[className];
    if (!spec) throw new Error(`unknown rate limit class: ${className}`);
    const windowMs = spec.windowMs || 60_000;
    const now = clock();
    const key = `${className}:${subject}`;

    let list = hits.get(key);
    if (!list) { list = []; hits.set(key, list); }
    // Trim in place rather than filtering into a new array: this runs on every request.
    let keep = 0;
    for (let i = 0; i < list.length; i++) if (now - list[i] < windowMs) list[keep++] = list[i];
    list.length = keep;

    if (list.length >= spec.perMin) {
      return { allowed: false, retryAfterMs: windowMs - (now - list[0]) };
    }
    list.push(now);
    return { allowed: true, retryAfterMs: null };
  }

  /** Bounded memory: drop keys with no live hits. Called by the janitor, not per request. */
  function sweep() {
    const now = clock();
    for (const [key, list] of hits) {
      const windowMs = (CLASSES[key.split(':')[0]] || {}).windowMs || 60_000;
      if (!list.length || now - list[list.length - 1] > windowMs) hits.delete(key);
    }
  }

  /**
   * Start the janitor.
   *
   * `sweep` previously had no caller. `check` inserts a key per unique subject and never
   * removed one, so 50k distinct IPv6 sources retained ~21 MB — an inexpensive remote OOM on
   * a 256 MB instance. Unref'd so it never holds the process open.
   */
  function startJanitor(intervalMs = 60_000) {
    const timer = setInterval(sweep, intervalMs);
    if (timer.unref) timer.unref();
    return () => clearInterval(timer);
  }

  return { check, checkAuth, sweep, startJanitor, get size() { return hits.size; } };
}

export { CLASSES };
