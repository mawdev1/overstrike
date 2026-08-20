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

export function createEphemeralTokens({ clock }) {
  const byHandle = new Map();
  const latestForAccount = new Map();     // `${purpose}:${accountId}` -> handle

  const sweep = () => {
    const now = clock.now();
    for (const [h, row] of byHandle) if (row.expiresAt <= now) byHandle.delete(h);
  };

  return {
    /** Issuing supersedes any outstanding token of the same purpose for the account. */
    issue(purpose, accountId, raw, ttlMs) {
      sweep();
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
      const handle = handleOf(raw ?? '');
      const row = byHandle.get(handle);
      if (!row || row.purpose !== purpose || row.usedAt) return { ok: false, reason: 'invalid' };
      if (clock.now() >= row.expiresAt) { byHandle.delete(handle); return { ok: false, reason: 'expired' }; }
      byHandle.delete(handle);
      latestForAccount.delete(`${purpose}:${row.accountId}`);
      return { ok: true, accountId: row.accountId };
    },

    /** A password change invalidates outstanding recovery tokens (auth.md §8). */
    invalidateAll(purpose, accountId) {
      const key = `${purpose}:${accountId}`;
      const handle = latestForAccount.get(key);
      if (handle) byHandle.delete(handle);
      latestForAccount.delete(key);
    },
  };
}
