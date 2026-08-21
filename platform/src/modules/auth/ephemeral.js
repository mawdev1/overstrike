/**
 * Short-lived single-use tokens: recovery and verification.
 *
 * `db-schema.md` §2 has no table for either, and inventing columns in another module's
 * contract is not this module's call — so P1 holds them in the service instance, keyed by
 * SHA-256 of the token, and this comment is the flag: **they do not survive a restart, and a
 * multi-instance deployment needs them moved into the store before P2.** A player whose reset
 * link dies because a pod recycled is a support ticket, not a security hole, which is why it
 * is an acceptable P1 position and not an acceptable P2 one.
 *
 * The invariants are real regardless of where the row lives:
 *   - single use;
 *   - a second issue for the same account supersedes the first (auth.md §8);
 *   - expiry is checked separately from validity, because the two have different UI
 *     obligations and therefore different codes.
 */
import { handleOf } from './crypto.js';

export function createEphemeralTokens({ clock, sweepIntervalMs = 60_000 }) {
  const byHandle = new Map();
  const latestForAccount = new Map();     // `${purpose}:${accountId}` -> handle

  /**
   * Swept on a timer, not on every `issue()`.
   *
   * Sweeping per issue is O(live tokens) per call and therefore O(n²) over a run, and
   * `recovery/start` is unauthenticated: 40 000 requests for addresses that do not exist used
   * to cost 2.9 s of sweeping and leave 8.3 MB resident *after* every token had expired,
   * because `latestForAccount` was never touched by the sweep and the `absent:<hash>` keys it
   * accumulated are unbounded and never consumed.
   */
  const sweep = () => {
    const now = clock.now();
    for (const [h, row] of byHandle) {
      if (row.expiresAt > now) continue;
      byHandle.delete(h);
      const key = `${row.purpose}:${row.accountId}`;
      // Only when it still points at THIS handle: a newer token for the same account has
      // already claimed the key, and dropping it would orphan the live token.
      if (latestForAccount.get(key) === h) latestForAccount.delete(key);
    }
  };

  const timer = sweepIntervalMs > 0 ? setInterval(sweep, sweepIntervalMs) : null;
  // A sweep timer must never be the reason the process refuses to exit.
  timer?.unref?.();

  return {
    /** Issuing supersedes any outstanding token of the same purpose for the account. */
    issue(purpose, accountId, raw, ttlMs) {
      const key = `${purpose}:${accountId}`;
      const previous = latestForAccount.get(key);
      if (previous) byHandle.delete(previous);
      const handle = handleOf(raw);
      byHandle.set(handle, { purpose, accountId, expiresAt: clock.now() + ttlMs, usedAt: null });
      latestForAccount.set(key, handle);
      return raw;
    },

    /**
     * Returns `{ ok: true, accountId }`, or `{ ok: false, reason: 'invalid'|'expired' }`.
     *
     * A used or unknown token is `invalid`, never `expired`: "expired" tells the holder the
     * token was once real, which is one bit more than a bad guess deserves.
     */
    consume(purpose, raw) {
      const lease = this.reserve(purpose, raw);
      if (!lease.ok) return lease;
      lease.complete();
      return { ok: true, accountId: lease.accountId };
    },

    /**
     * Exclusively reserve a token for a multi-step operation, consuming only on completion.
     * A transient provider/store failure releases it so the same recovery link can resume the
     * saga instead of leaving the provider password changed and the platform operation dead.
     */
    reserve(purpose, raw) {
      const handle = handleOf(raw ?? '');
      const row = byHandle.get(handle);
      if (!row || row.purpose !== purpose || row.usedAt) return { ok: false, reason: 'invalid' };
      if (clock.now() >= row.expiresAt) {
        byHandle.delete(handle);
        latestForAccount.delete(`${purpose}:${row.accountId}`);
        return { ok: false, reason: 'expired' };
      }
      row.usedAt = 'reserved';
      let closed = false;
      return {
        ok: true,
        accountId: row.accountId,
        complete() {
          if (closed) return;
          closed = true;
          byHandle.delete(handle);
          if (latestForAccount.get(`${purpose}:${row.accountId}`) === handle) {
            latestForAccount.delete(`${purpose}:${row.accountId}`);
          }
        },
        release() {
          if (closed) return;
          closed = true;
          if (byHandle.get(handle) === row) row.usedAt = null;
        },
      };
    },

    /**
     * The same verdict as `consume`, without consuming.
     *
     * Verification has to compare the token's owner with the caller BEFORE burning it: burning
     * first let any authenticated account destroy another account's verification link by
     * pasting it, permanently, since the link is single-use and the owner never sees an error.
     */
    peek(purpose, raw) {
      const row = byHandle.get(handleOf(raw ?? ''));
      if (!row || row.purpose !== purpose || row.usedAt) return { ok: false, reason: 'invalid' };
      if (clock.now() >= row.expiresAt) return { ok: false, reason: 'expired' };
      return { ok: true, accountId: row.accountId };
    },

    /** A password change invalidates outstanding recovery tokens (auth.md §8). */
    invalidateAll(purpose, accountId) {
      const key = `${purpose}:${accountId}`;
      const handle = latestForAccount.get(key);
      if (handle) byHandle.delete(handle);
      latestForAccount.delete(key);
    },

    /** Exposed for the sweep test and for an ops gauge; neither map is otherwise observable. */
    size() { return { handles: byHandle.size, accounts: latestForAccount.size }; },

    sweep,

    /** The module owns the timer, so whoever owns the module can stop it. */
    stop() { if (timer) clearInterval(timer); },
  };
}
