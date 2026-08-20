/**
 * Rate limiting, auth class.  contracts/http-api.md §9.
 *
 * 10/min per IP and 5/min per account, on signup, signin, refresh, and recovery. Both limits
 * apply: the per-IP one stops one host spraying many accounts, the per-account one stops many
 * hosts spraying one account. Either alone leaves the other attack open.
 *
 * In-process and therefore per-instance. §9 requires enforcement at the edge *and* in the
 * service; this is the service half, and it is deliberately not the only half.
 */
import { ApiError } from '../../core/errors.js';

export const AUTH_LIMITS = {
  perIp:      { limit: 10, windowMs: 60_000 },
  perAccount: { limit: 5,  windowMs: 60_000 },
};

/**
 * Sliding window over stored hit timestamps rather than a fixed bucket.
 *
 * A fixed bucket lets an attacker send `limit` at 0:59 and `limit` again at 1:00 — double the
 * intended rate across the boundary, which for a credential-stuffing limiter is the whole
 * budget.
 */
export function createRateLimiter({ clock, maxKeys = 50_000 } = {}) {
  const hits = new Map();

  const prune = (key, windowStart) => {
    const arr = hits.get(key);
    if (!arr) return [];
    let i = 0;
    while (i < arr.length && arr[i] <= windowStart) i++;
    const kept = i ? arr.slice(i) : arr;
    if (kept.length) hits.set(key, kept); else hits.delete(key);
    return kept;
  };

  return {
    /** Returns `{ allowed, retryAfterMs }` and records the hit when allowed. */
    take(key, { limit, windowMs }) {
      const now = clock.now();
      const kept = prune(key, now - windowMs);
      if (kept.length >= limit) {
        return { allowed: false, retryAfterMs: Math.max(1, kept[0] + windowMs - now) };
      }
      kept.push(now);
      hits.set(key, kept);
      // Unbounded key growth is a memory DoS in its own right; a full table sheds the oldest.
      if (hits.size > maxKeys) hits.delete(hits.keys().next().value);
      return { allowed: true, retryAfterMs: null };
    },

    /**
     * Enforce the auth class. `subject` is the account id when known and the email lookup key
     * when it is not, so a signin attempt against a nonexistent account is still counted —
     * otherwise the limiter is an enumeration oracle of its own.
     */
    enforceAuth({ ip, subject }) {
      for (const [scope, spec, value] of [
        ['ip', AUTH_LIMITS.perIp, ip],
        ['account', AUTH_LIMITS.perAccount, subject],
      ]) {
        if (!value) continue;
        const r = this.take(`auth:${scope}:${value}`, spec);
        if (!r.allowed) {
          throw new ApiError('AUTH_RATE_LIMITED', 'Too many attempts. Try again shortly.',
            { retryAfterMs: r.retryAfterMs });
        }
      }
    },

    reset() { hits.clear(); },
  };
}
