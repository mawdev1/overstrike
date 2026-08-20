/**
 * One-time import of the local progression blob.  src/game/progression.js.
 *
 * The existing game keeps rank, XP, lifetime totals and per-weapon rows in one localStorage
 * key (`overstrike.progress.v1`). That blob is CLIENT DATA: it was writable by anyone with a
 * devtools console for the whole of the offline alpha, so importing it into `player_stats`
 * would be handing the leaderboard to whoever edited it first.
 *
 * So the import is deliberately inert:
 *
 *  - It writes to a separate `legacyImport` record on the profile, never to `player_stats` or
 *    `player_weapon_stats`. Career totals stay recomputable from match history (match-result.md
 *    §6), which a merged local blob would permanently break.
 *  - Every imported row is flagged `verified: false`. It can be shown as "carried over from
 *    offline play", and it can never be the number a dispute is settled with.
 *  - It runs once. A second import returns the first one rather than adding to it, because a
 *    replayed migration is the cheapest possible stat duplication attack.
 */
import { ApiError } from '../../core/errors.js';

/** Same coercion posture as progression.js: hostile input, coerced, never thrown at. */
function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Mirrors progression.js LIFETIME_KEYS; anything else in the blob is dropped. */
const LIFETIME_KEYS = [
  'kills', 'deaths', 'assists', 'headshots', 'longshots', 'shotsFired', 'shotsHit',
  'wins', 'losses', 'draws', 'matches', 'playtime', 'longestShot', 'bestStreak',
  'score', 'captures', 'confirms', 'denies', 'streaksEarned',
];
const WEAPON_KEYS = ['xp', 'kills', 'headshots', 'shotsFired', 'shotsHit'];

export function normalizeLegacyBlob(raw) {
  const blob = raw && typeof raw === 'object' ? raw : {};
  const lifetime = {};
  for (const k of LIFETIME_KEYS) lifetime[k] = num(blob.lifetime?.[k]);

  const weapons = {};
  if (blob.weapons && typeof blob.weapons === 'object') {
    for (const [id, row] of Object.entries(blob.weapons)) {
      if (typeof id !== 'string' || !row || typeof row !== 'object') continue;
      const out = {};
      for (const k of WEAPON_KEYS) out[k] = num(row[k]);
      weapons[id] = out;
    }
  }

  const challenges = [];
  if (blob.challenges && typeof blob.challenges === 'object') {
    for (const [id, row] of Object.entries(blob.challenges)) {
      if (row && typeof row === 'object' && row.done) challenges.push(id);
    }
  }

  return { schema: num(blob.schema) || 1, xp: num(blob.xp), lifetime, weapons, challenges };
}

export function createMigrationService({ store, clock = Date }) {
  /**
   * @param {string} accountId
   * @param {object} blob the parsed `overstrike.progress.v1` value, straight from the client
   */
  async function importLegacyProgression(accountId, blob) {
    const account = await store.accounts.byId(accountId);
    if (!account || account.deletedAt) throw new ApiError('NOT_FOUND', 'No such account.');

    const existing = (await store.profiles.byAccountId(accountId))?.legacyImport;
    if (existing) {
      // Idempotent rather than an error: the client retrying a flaky first-run request must not
      // see a failure, and it must not double-count either.
      return { ...existing, alreadyImported: true };
    }

    const record = {
      source: 'localStorage:overstrike.progress.v1',
      verified: false,          // client-authored; never promoted to an authoritative total
      importedAt: new Date(clock.now()).toISOString(),
      data: normalizeLegacyBlob(blob),
    };
    await store.profiles.upsert(accountId, { legacyImport: record });
    return { ...record, alreadyImported: false };
  }

  async function getLegacyImport(accountId) {
    return (await store.profiles.byAccountId(accountId))?.legacyImport ?? null;
  }

  return { importLegacyProgression, getLegacyImport };
}
