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
  auth:   { perMin: 10, subject: 'ip+account' },
  read:   { perMin: 120, subject: 'account' },
  write:  { perMin: 30, subject: 'account' },
  room:   { perMin: 20, subject: 'account' },
  report: { perMin: 10, windowMs: 3600_000, subject: 'account' },
};

export function createRateLimiter({ clock = Date.now } = {}) {
  /** key -> array of timestamps. Trimmed on read, so an idle key costs nothing to hold. */
  const hits = new Map();

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

  return { check, sweep, get size() { return hits.size; } };
}

export { CLASSES };
