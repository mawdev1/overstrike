/**
 * Storage interface.  contracts/db-schema.md.
 *
 * One interface, two adapters: `memory` for tests and local work, `postgres` for real. Every
 * module codes against this and never against a driver, so the whole platform is testable
 * without a database and the Postgres adapter can be swapped or profiled independently.
 *
 * Rules every adapter must honour, because they are contract, not implementation detail:
 *
 *  1. `tx(fn)` is a real transaction. The outbox pattern (event-envelope.md §4) depends on a
 *     state change and its event committing together or not at all; an adapter that fakes it
 *     silently breaks the one guarantee the event stream rests on.
 *  2. `audit.insert` is append-only. No update, no delete, at the adapter level.
 *  3. Reads never return internal driver objects — plain data only, so a caller cannot
 *     accidentally depend on a Postgres row shape.
 *  4. Every method takes an optional trailing `tx` handle. Passing it enrols the call in that
 *     transaction. Omitting it runs standalone UNLESS the call is lexically inside a `tx(fn)`
 *     on the same store, in which case it enrols in that one: on the memory adapter a
 *     "standalone" write inside a transaction deadlocks against the lock its own caller holds,
 *     and on Postgres it silently commits outside the transaction it looked like it was in.
 *     Both are worse than joining. `tx(fn)` is likewise reentrant: a nested call runs on the
 *     outer transaction rather than opening a second one.
 *  5. Where the two adapters could plausibly differ — whether a no-op revoke is an error,
 *     whether a null in a patch clears a column, what an out-of-range counter delta does —
 *     the decision is made ONCE, here, and both adapters import it. A divergence that only
 *     the Postgres adapter has is a divergence no memory-backed test can see.
 */
import { ApiError } from './errors.js';

/**
 * @typedef {object} Store
 *
 * @property {(fn: (tx: any) => Promise<any>) => Promise<any>} tx
 *   Run `fn` inside a transaction. Rolls back on throw, commits otherwise.
 *
 * @property {object} accounts
 *   create(row, tx) -> account
 *   byId(accountId, tx) -> account|null
 *   byEmailHash(hash, tx) -> account|null
 *   byNameFolded(folded, tx) -> account|null
 *   update(accountId, patch, tx) -> account
 *
 * @property {object} sessions
 *   create(row, tx) -> session
 *   byId(sessionId, tx) -> session|null
 *   listForAccount(accountId, tx) -> session[]
 *   revoke(sessionId, reason, at, tx) -> void
 *   revokeAllForAccount(accountId, reason, at, tx) -> number
 *   revokeFamily(familyId, reason, at, tx) -> number
 *
 * @property {object} refreshTokens
 *   create(row, tx) -> token           // { tokenId, familyId, accountId, sessionId, expiresAt, usedAt }
 *   byId(tokenId, tx) -> token|null
 *   markUsed(tokenId, at, tx) -> void
 *
 * @property {object} profiles
 *   upsertIfVersion(accountId, expectedVersion, patch, tx) -> profile|null
 *                                      // null when the version moved; the caller raises
 *                                      // CONFLICT. See http-api.md §11.2 — a read-then-write
 *                                      // If-Match is a race both writers win.
 *   upsert(accountId, patch, tx) -> profile
 *   byAccountId(accountId, tx) -> profile|null
 *
 * @property {object} stats
 *   get(accountId, mode, statDefinitionVersion, tx) -> row|null
 *   applyDelta(accountId, mode, statDefinitionVersion, delta, tx) -> row
 *   listForAccount(accountId, tx) -> row[]
 *
 * @property {object} weaponStats
 *   applyDelta(accountId, mode, weaponId, statDefinitionVersion, delta, tx) -> row
 *   listForAccount(accountId, mode, tx) -> row[]
 *
 * @property {object} matches
 *   record(result, tx) -> { matchId }  // the immutable match row + its participants
 *                                      // `result` is a TerminalResult (match-result.md §4/§4.2)
 *   listForAccount(accountId, {limit, cursor}, tx) -> { items, nextCursor }
 *                                      // newest first, cursor-paginated; items are §4.3 rows
 *                                      // carrying `participant: { team, stats }`
 *
 * @property {object} preAuthConsent
 *   put(row, tx) -> row                // { clientSessionId, telemetryPersonal, policyVersion, decidedAt, expiresAt }
 *   get(clientSessionId, tx) -> row|null
 *   markMigrated(clientSessionId, at, tx) -> void
 *
 * @property {object} outbox
 *   insert(event, tx) -> event         // MUST be callable inside tx
 *   claimUnpublished(limit, tx) -> event[]
 *   markPublished(eventIds, at, tx) -> void
 *   recordFailure(eventId, error, tx) -> void
 *   deadLetter(eventId, at, tx) -> void
 *
 * @property {object} audit
 *   insert(row, tx) -> row             // append-only; no update/delete exists on purpose
 *   list(filter, tx) -> row[]
 *
 * @property {object} idempotency
 *   get(key, actorId, tx) -> row|null
 *   put(row, tx) -> row
 *
 * @property {object} flags
 *   all(tx) -> row[]
 *   get(key, tx) -> row|null
 *   set(key, patch, tx) -> row
 *
 * @property {() => Promise<{ok: boolean, detail?: string}>} health
 * @property {() => Promise<void>} close
 */

// ---------------------------------------------------------------------------- shared rules
//
// Everything below is imported by BOTH adapters. It is here rather than duplicated in each
// because the duplicated copies are what drift, and a drifted copy is a rule the memory-backed
// suite enforces and production does not.

/**
 * Reject a value the store cannot durably hold, at the door.
 *
 * On memory the state is published by cloning it, so a value structuredClone refuses — a
 * Symbol, a function, a Proxy — does not fail the write that introduced it: it fails every
 * write AFTER it, forever, with a raw DOMException. On Postgres the same value is coerced by
 * the driver (`Symbol('x')` becomes the string "Symbol(x)") and stored as nonsense. Two
 * different wrong answers to one bad argument; this is the single right one.
 */
export function assertStorable(value, what) {
  if (value === undefined || value === null) return value;
  try {
    structuredClone(value);
  } catch (err) {
    throw new ApiError('VALIDATION_FAILED', `${what} contains a value that cannot be stored.`, {
      details: { field: what, reason: err?.message ?? String(err) },
    });
  }
  return value;
}

/** Career counters (db-schema.md §3). Anything not listed is not a stat, and a typo must not be swallowed. */
export const STAT_COUNTERS = [
  'kills', 'deaths', 'assists', 'suicides', 'teamKills', 'headshots',
  'shotsFired', 'shotsHit', 'damageDealt', 'plants', 'defuses',
  'matches', 'wins', 'losses', 'draws', 'roundsPlayed', 'timePlayedSec',
];

export const WEAPON_COUNTERS = ['shots', 'hits', 'kills', 'headshots'];

/**
 * Per-call magnitude caps on a counter delta.
 *
 * A delta is ONE match's contribution (match-result.md §6), so its plausible range is bounded
 * by what a match can physically contain. Unbounded, a single malformed or hostile result —
 * `{ kills: -1000000 }` — rewrites a career in one call, and because career totals are
 * additive there is nothing in the row afterwards that says it happened.
 *
 * The cap is on MAGNITUDE, not sign: a negative delta is the legitimate way to reverse a
 * result that was applied and then invalidated (§3.1), so forbidding negatives would remove
 * the only correct reversal path and invite an UPDATE instead.
 */
export const STAT_DELTA_LIMITS = {
  kills: 10_000, deaths: 10_000, assists: 10_000, suicides: 10_000,
  teamKills: 10_000, headshots: 10_000, plants: 10_000, defuses: 10_000,
  shotsFired: 100_000, shotsHit: 100_000,
  damageDealt: 1_000_000,
  matches: 1_000, wins: 1_000, losses: 1_000, draws: 1_000,
  roundsPlayed: 1_000,
  timePlayedSec: 86_400,          // one match cannot exceed a day of connected time
};

export const WEAPON_DELTA_LIMITS = { shots: 100_000, hits: 100_000, kills: 10_000, headshots: 10_000 };

/**
 * Reject unknown counters, non-integers, and out-of-range magnitudes. Both adapters call this
 * before touching storage, so `{ kilz: 5 }`, `{ kills: 1.5 }` and `{ kills: -1e6 }` fail
 * identically on memory and on Postgres.
 */
export function assertCounterDelta(delta, counters, limits, table) {
  for (const k of Object.keys(delta ?? {})) {
    if (!counters.includes(k)) {
      throw new ApiError('VALIDATION_FAILED', `Unknown stat counter: ${k}`, { details: { table, counter: k } });
    }
    const v = delta[k];
    if (!Number.isInteger(v)) {
      throw new ApiError('VALIDATION_FAILED', `Stat delta ${k} must be an integer.`, {
        details: { table, counter: k },
      });
    }
    const limit = limits[k];
    if (Math.abs(v) > limit) {
      throw new ApiError('VALIDATION_FAILED', `Stat delta ${k} is out of range.`, {
        details: { table, counter: k, limit, value: v },
      });
    }
  }
}

/**
 * Match statuses.  match-result.md §4.2.
 *
 * `pending` is a RESPONSE status, not a stored one: the table's check constraint stores
 * `allocated` and `in-progress`, and §4.3 collapses both to `pending` because a client cannot
 * act on the difference. The mapping lives here so both adapters collapse it the same way.
 */
export const STORED_MATCH_STATUSES = ['allocated', 'in-progress', 'completed', 'aborted', 'invalidated'];
export const TERMINAL_MATCH_STATUSES = ['completed', 'aborted', 'invalidated'];

export function toStoredMatchStatus(status) {
  if (status === 'pending') return 'allocated';
  if (!STORED_MATCH_STATUSES.includes(status)) {
    throw new ApiError('VALIDATION_FAILED', `Unknown match status: ${status}`, { details: { status } });
  }
  return status;
}

export function toHistoryMatchStatus(stored) {
  return (stored === 'allocated' || stored === 'in-progress') ? 'pending' : stored;
}

/** Exactly the columns of `matches` (migration 0004) that a result record populates. */
export const MATCH_COLUMNS = [
  'matchId', 'roomId', 'region', 'serverId', 'mapId', 'mapVersion', 'mode',
  'rulesetVersion', 'statDefinitionVersion', 'serverBuild', 'status',
  'terminationReason', 'outcomeReason', 'invalidationReason', 'winnerTeam',
  'rulesSnapshot', 'teamScores', 'rounds', 'evidenceRef', 'startedAt', 'endedAt',
];

/**
 * Split a TerminalResult into the row `matches` stores and the rows `match_participants`
 * stores, validating what both tables declare NOT NULL or CHECK.
 *
 * Done once, for both adapters, because "which fields of the result are persisted" is exactly
 * the sort of thing two hand-written adapters answer differently — and the one that drops a
 * field drops it silently.
 */
export function normaliseMatchResult(result) {
  if (!result || typeof result !== 'object') {
    throw new ApiError('VALIDATION_FAILED', 'A match result must be an object.');
  }
  for (const required of ['matchId', 'status', 'mode', 'mapId', 'region']) {
    if (!result[required] || typeof result[required] !== 'string') {
      throw new ApiError('VALIDATION_FAILED', `matches.${required} is required`, {
        details: { table: 'matches', column: required },
      });
    }
  }
  const winnerTeam = result.winnerTeam ?? null;
  // NULL is not a draw (0004): a draw is the literal 'draw', NULL means no outcome at all.
  if (winnerTeam !== null && !['alpha', 'bravo', 'draw'].includes(winnerTeam)) {
    throw new ApiError('VALIDATION_FAILED', `Unknown winnerTeam: ${winnerTeam}`, {
      details: { table: 'matches', column: 'winnerTeam' },
    });
  }

  const match = {
    matchId: result.matchId,
    roomId: result.roomId ?? null,
    region: result.region,
    serverId: result.serverId ?? null,
    mapId: result.mapId,
    mapVersion: result.mapVersion ?? null,
    mode: result.mode,
    rulesetVersion: result.rulesetVersion ?? null,
    statDefinitionVersion: result.statDefinitionVersion ?? null,
    serverBuild: result.serverBuild ?? null,
    status: toStoredMatchStatus(result.status),
    terminationReason: result.terminationReason ?? null,
    outcomeReason: result.outcomeReason ?? null,
    invalidationReason: result.invalidationReason ?? null,
    winnerTeam,
    // NOT NULL with no default in 0004. A result that arrives without one is still a result we
    // must not lose, and '{}' records honestly that no ruleset copy came with it.
    rulesSnapshot: result.rulesSnapshot ?? {},
    teamScores: result.teamScores ?? null,
    rounds: result.rounds ?? null,
    evidenceRef: result.evidenceRef ?? null,
    startedAt: result.startedAt ?? null,
    endedAt: result.endedAt ?? null,
  };

  const seen = new Set();
  const participants = [];
  for (const player of result.players ?? []) {
    if (!player?.accountId || typeof player.accountId !== 'string') {
      throw new ApiError('VALIDATION_FAILED', 'Every match participant needs an accountId.', {
        details: { table: 'match_participants', column: 'accountId' },
      });
    }
    // (match_id, account_id) is the primary key. A duplicate is a malformed result, and
    // letting the last copy win would double-count nothing here but hide the defect upstream.
    if (seen.has(player.accountId)) {
      throw new ApiError('VALIDATION_FAILED', 'The same account appears twice in one match.', {
        details: { table: 'match_participants', accountId: player.accountId },
      });
    }
    seen.add(player.accountId);
    participants.push({
      matchId: match.matchId,
      accountId: player.accountId,
      team: player.team ?? null,
      joinedAt: player.joinedAt ?? match.startedAt ?? null,
      leftAt: player.leftAt ?? null,
      disconnected: !!player.disconnected,
      abandoned: !!player.abandoned,
      // stats is a document on purpose (0004): the stat set evolves per mode and per
      // definition version, and the recompute in match-result.md §6 reads it whole.
      stats: player,
    });
  }
  return { match, participants };
}

/** Adapter registry. `createStore` picks one from config; nothing else imports an adapter. */
export async function createStore(config, deps = {}) {
  if (config.storage === 'memory') {
    const { createMemoryStore } = await import('./store/memory.js');
    return createMemoryStore(config, deps);
  }
  if (config.storage === 'postgres') {
    const { createPostgresStore } = await import('./store/postgres.js');
    return createPostgresStore(config, deps);
  }
  throw new Error(`unknown storage adapter: ${config.storage}`);
}
