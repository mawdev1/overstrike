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
 *   touch(sessionId, at, tx) -> void      // advance lastSeenAt (auth.md §5)
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
 *                                      // A row that does not exist yet IS `INITIAL_SETTINGS_VERSION`
 *                                      // (that is the version §11.2 reports for it), so a CAS
 *                                      // holding that version creates it and a CAS holding any
 *                                      // other version returns null rather than inventing one.
 *                                      // An unknown account is NOT_FOUND, never null.
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
 *   record(result, tx) -> { matchId, status, transitioned }
 *                                      // Creates the row, or advances an existing non-terminal
 *                                      // one along MATCH_STATUS_TRANSITIONS. matchId is assigned
 *                                      // at ALLOCATION (§4), so allocate → play → finalise is the
 *                                      // normal lifecycle and NOT a conflict. A second TERMINAL
 *                                      // write is CONFLICT (§5.5).
 *   byId(matchId, tx) -> row|null      // the match row plus `participants[]`, for the §4.2
 *                                      // `GET /v1/matches/:matchId` projection
 *   markResultApplied(matchId, at, tx) -> row
 *                                      // stamps matches.result_applied_at (db-schema.md §4), the
 *                                      // only thing that tells "ended, queued" from "applied"
 *   listForAccount(accountId, {limit, cursor}, tx) -> { items, nextCursor }
 *                                      // newest first, cursor-paginated; items are §4.3 rows
 *                                      // carrying `participant: { team, stats }`. limit and
 *                                      // cursor are VALIDATED, never clamped (http-api.md §10)
 *
 * @property {object} preAuthConsent
 *   put(row, tx) -> row                // { clientSessionId, telemetryPersonal, policyVersion, decidedAt, expiresAt }
 *   get(clientSessionId, tx) -> row|null   // expiry is enforced here, and it DELETES
 *   deleteFor(clientSessionId, tx) -> bool // http-api.md §3a.3: deleted on migration at signup
 *   sweepExpired(at, tx) -> number         // …or on expiry, for the rows nobody reads again
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
 *   acquire(key, actorId, tx) -> void   // serialise this key for the transaction
 *   get(key, actorId, tx) -> row|null
 *   put(row, tx) -> row                 // expiresAt null = permanent (http-api.md §8)
 *   sweepExpired(at, tx) -> number      // §8 retention; null expiresAt is never swept
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

/**
 * The settings version a profile has BEFORE its row exists.  http-api.md §11.2.
 *
 * `GET /v1/profile/me/settings` answers `version: 1` with the documented defaults for an
 * account that has never written settings — there is no "no version yet" state on the wire —
 * so absence of the row and version 1 are the same fact, and `profiles.settings_version`
 * defaults to it in migration 0003.
 */
export const INITIAL_SETTINGS_VERSION = 1;

/**
 * May a compare-and-set CREATE the profile row?
 *
 * Only when the caller expected the version that absence already reports. Anything else is a
 * caller acting on a row it believes exists, and inventing one for it is a false CAS success:
 * the client is told its `If-Match: "42"` held when there was nothing to match.
 *
 * Refusing ALL fresh inserts would be the other obvious answer and it is wrong, because it
 * breaks the first settings write of every account that ever registers — the normal path, not
 * an edge case.
 *
 * Both adapters import this. Postgres expressed the comparison as `on conflict (account_id) do
 * update ... where settings_version = $n`, which gates the DO UPDATE branch and NOTHING ELSE,
 * so its plain INSERT path answered "yes" to every expectedVersion in existence.
 */
export function casMayCreateProfile(expectedVersion) {
  return expectedVersion === INITIAL_SETTINGS_VERSION;
}

/**
 * The arguments a CAS shares with any other profile write, checked in the same ORDER on both
 * adapters.
 *
 * Order is the contract here, not a detail: memory compared versions first and so answered
 * `null` — "your version moved, retry" — to a caller whose actual mistake was a typo'd column
 * or a string version, which is a CONFLICT the client retries forever. Postgres validated
 * first. One of the two had to be wrong, and it is the one that reports the wrong error.
 */
export function assertExpectedVersion(expectedVersion) {
  if (!Number.isInteger(expectedVersion)) {
    throw new ApiError('VALIDATION_FAILED', 'expectedVersion must be an integer.', {
      details: { table: 'profiles', column: 'settingsVersion',
        fields: [{ key: 'expectedVersion', reason: 'integer', path: 'expectedVersion', rule: 'integer',
          got: typeof expectedVersion === 'number' ? expectedVersion : typeof expectedVersion }] },
    });
  }
  return expectedVersion;
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

/**
 * Exactly the columns of `matches` (migration 0004) that a result record populates.
 *
 * `resultAppliedAt` is here because db-schema.md §4 declares the column and NOTHING wrote it:
 * without it a row that ended and a row whose career application committed are the same row,
 * and §4.2/§5 need to tell them apart to answer "is this result queued or applied".
 */
export const MATCH_COLUMNS = [
  'matchId', 'roomId', 'region', 'serverId', 'mapId', 'mapVersion', 'mode',
  'rulesetVersion', 'statDefinitionVersion', 'serverBuild', 'status',
  'terminationReason', 'outcomeReason', 'invalidationReason', 'winnerTeam',
  'rulesSnapshot', 'teamScores', 'rounds', 'evidenceRef', 'startedAt', 'endedAt',
  'resultAppliedAt',
];

/**
 * The match lifecycle, as a transition table.  match-result.md §4, db-schema.md §4.
 *
 * The row is created at ALLOCATION and finalised later, so "the row already exists" is the
 * NORMAL path, not a conflict — treating every existing row as CONFLICT made it impossible for
 * any allocated match to ever record a result, which is every match that follows the documented
 * lifecycle.
 *
 * What must stay impossible is a SECOND terminal truth: §5.5 makes a second, different result
 * for a finalised match a bug or an attack. So terminal states have no outgoing edges at all.
 *
 * INVALIDATION IS THEREFORE A SUBMISSION-TIME DECISION AND NOTHING ELSE, in this phase.
 * `invalidated` is reachable only from `allocated` or `in-progress` — the match server submits
 * it as the match's first and only terminal result. There is deliberately no admin path that
 * invalidates a `completed` match, because the honest version of that is an append-only
 * command plus a COMPENSATING career delta (the reversal `STAT_DELTA_LIMITS` keeps signed for),
 * and neither exists yet. An edge added here without both would let a review decision move a
 * career with nothing recording that it did, and reverse nothing that was already applied —
 * which is worse than refusing. When the admin command lands, it adds a compensation
 * transition here and a delta there, together or not at all.
 */
export const MATCH_STATUS_TRANSITIONS = Object.assign(Object.create(null), {
  allocated: ['in-progress', 'completed', 'aborted', 'invalidated'],
  'in-progress': ['completed', 'aborted', 'invalidated'],
  completed: [],
  aborted: [],
  invalidated: [],
});

/** Throw the contract error for a transition the lifecycle does not have. */
export function assertMatchTransition(from, to, matchId) {
  const allowed = MATCH_STATUS_TRANSITIONS[from] ?? [];
  if (allowed.includes(to)) return;
  // A finalised match being written again is the §5.5 case and reads as CONFLICT. So does an
  // allocation of an id that already exists — both are "this row is not yours to write".
  throw new ApiError('CONFLICT', `A match cannot go from ${from} to ${to}.`, {
    details: { matchId, from, to, allowed, reason: TERMINAL_MATCH_STATUSES.includes(from)
      ? 'result-already-finalised' : 'illegal-status-transition' },
  });
}

/**
 * The §4.0 outcome matrix, executable, and the single copy of it.
 *
 * It lives here rather than in the stats service because BOTH the write path (this file's
 * `normaliseMatchResult`, called by both adapters) and the aggregation path (profile/stats.js)
 * have to apply the identical rule. Two copies is how a result the store accepts becomes a
 * result the career refuses, with no test able to see the difference.
 */
export const OUTCOME_REASONS = Object.assign(Object.create(null), {
  completed: ['elimination', 'defuse', 'detonation', 'timer'],
  aborted: ['forfeit', 'abandon', 'no-contest'],
  invalidated: ['no-contest'],
});

export const INVALIDATION_REASONS = ['cheat-detected', 'server-fault', 'roster-fault', 'admin-review'];

export const MATCH_MODES = ['tdm', 'bomb'];

/**
 * The §4.2 status-dependent invariants, over the fields that are PRESENT.
 *
 * Separate from the required-field check because the two have different callers: the career
 * recompute reads history rows carrying `status` and `winnerTeam` and nothing else, and must
 * still be able to check the matrix on them without demanding a whole result record.
 *
 * @returns {Array<object>} field-level problems, empty when the result satisfies the matrix
 */
export function matchOutcomeProblems(result) {
  const { status, winnerTeam = null, outcomeReason, invalidationReason, terminationReason } = result || {};
  const problems = [];
  if (!TERMINAL_MATCH_STATUSES.includes(status)) {
    return withContractPaths([{ key: 'status', reason: 'enum', allowed: TERMINAL_MATCH_STATUSES, got: status ?? null }]);
  }
  // §4.2: terminationReason repeats the status. They are two names for one fact, and a row where
  // they disagree is a row with two truths in it.
  if (terminationReason !== undefined && terminationReason !== null && terminationReason !== status) {
    problems.push({ key: 'terminationReason', reason: 'must-equal-status', expected: status, got: terminationReason });
  }
  if (outcomeReason !== undefined && !OUTCOME_REASONS[status].includes(outcomeReason)) {
    problems.push({ key: 'outcomeReason', reason: 'enum', allowed: OUTCOME_REASONS[status], got: outcomeReason ?? null });
  }

  // winnerTeam, per row. `draw` exists only for a completed match; an abort is never a draw.
  if (status === 'completed') {
    if (!['alpha', 'bravo', 'draw'].includes(winnerTeam)) {
      problems.push({ key: 'winnerTeam', reason: 'enum', allowed: ['alpha', 'bravo', 'draw'], got: winnerTeam });
    }
  } else if (status === 'aborted') {
    if (outcomeReason === 'no-contest') {
      if (winnerTeam !== null) problems.push({ key: 'winnerTeam', reason: 'must-be-null', got: winnerTeam });
    } else if (outcomeReason === 'forfeit' || outcomeReason === 'abandon') {
      // §4.2 and wire-protocol §8.9: a forfeit is an aborted match WITH a winner.
      if (!['alpha', 'bravo'].includes(winnerTeam)) {
        problems.push({ key: 'winnerTeam', reason: 'enum', allowed: ['alpha', 'bravo'], got: winnerTeam });
      }
    } else if (![null, 'alpha', 'bravo'].includes(winnerTeam)) {
      problems.push({ key: 'winnerTeam', reason: 'enum', allowed: ['alpha', 'bravo', null], got: winnerTeam });
    }
  } else if (winnerTeam !== null) {
    problems.push({ key: 'winnerTeam', reason: 'must-be-null', got: winnerTeam });
  }

  // invalidationReason is non-null from the enum for `invalidated`, and null for everything
  // else. A completed match carrying "cheat-detected" is two truths in one row.
  if (status === 'invalidated') {
    if (invalidationReason !== undefined && !INVALIDATION_REASONS.includes(invalidationReason)) {
      problems.push({ key: 'invalidationReason', reason: 'enum', allowed: INVALIDATION_REASONS, got: invalidationReason ?? null });
    }
  } else if (invalidationReason !== undefined && invalidationReason !== null) {
    problems.push({ key: 'invalidationReason', reason: 'must-be-null', got: invalidationReason });
  }

  // A DRAW is the regulation timer expiring, and nothing else (§4.1, bomb-rules.md §2.1a: "no
  // overtime in Alpha", so 6-6 at the end of regulation is the only way a match has no winner
  // and is still `completed`). The matrix's row for `completed` permitted `draw` beside
  // `elimination`, `defuse` and `detonation` — three reasons that each name a team that won, so
  // the row said a match could be simultaneously decided and drawn. The wire forbids it; this is
  // where that becomes checkable.
  if (winnerTeam === 'draw' && outcomeReason !== undefined && outcomeReason !== 'timer') {
    problems.push({ key: 'outcomeReason', reason: 'draw-implies-timer', expected: 'timer', got: outcomeReason ?? null });
  }
  return withContractPaths(problems);
}

/**
 * errors.md §3 fixes the validation field shape as `{ path, rule, message }`; this file's
 * existing callers — and the suites that assert on them — read `{ key, reason }`. Both are
 * emitted from one place rather than renaming a field every consumer already branches on.
 */
function withContractPaths(problems) {
  return problems.map((p) => (p.path !== undefined ? p : { ...p, path: p.key, rule: p.reason }));
}

/** A problem authored path-first, for the nested shapes below. */
const at = (path, rule, extra = {}) => ({ path, key: path, rule, reason: rule, ...extra });

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;
/** A timestamp the database can hold and `Date.parse` agrees with. */
const isTimestamp = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const isCount = (v) => Number.isInteger(v) && v >= 0;

/** §4.1 per-player counters. `score` is separate: it alone may be negative (§2's penalties). */
const PLAYER_COUNTERS = [
  'kills', 'deaths', 'assists', 'suicides', 'teamKills',
  'headshots', 'shotsFired', 'shotsHit', 'damageDealt',
  'plants', 'defuses', 'roundsPlayed', 'timePlayedSec',
];
const PLAYER_KEYS = [
  'accountId', 'displayName', 'team', 'role', ...PLAYER_COUNTERS,
  'score', 'disconnected', 'abandoned', 'joinedAt', 'leftAt', 'weapons',
];
const ROSTER_KEYS = ['accountId', 'team', 'joinedAt', 'leftAt'];
const ROUND_KEYS = ['index', 'winner', 'reason', 'startedAt', 'endedAt', 'roles', 'plant', 'defuse'];
export const TEAMS = ['alpha', 'bravo'];
const ROLES = ['attacker', 'defender'];
const ROUND_REASONS = ['elimination', 'defuse', 'detonation', 'timer'];
const BOMB_SITES = ['A', 'B'];
/** A weapon id becomes a storage key (`player_weapon_stats`), so it is constrained like one. */
const WEAPON_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * `rulesSnapshot` is discriminated by mode and every key is present in BOTH variants (§4).
 *
 * A snapshot is the immutable copy that makes a historical result interpretable after the
 * ruleset is retuned (db-schema.md §4). A partial one — `{ killLimit: 75 }` — is not a smaller
 * snapshot, it is a result nobody can read in a year, and it passed every check the platform
 * had because `rulesSnapshot` was only tested for being an object.
 */
const RULES_KEYS = [
  'killLimit', 'roundsToWin', 'maxRounds', 'sideSwitchAfter', 'roundLengthSec',
  'bombTimerSec', 'defuseSec', 'plantSec', 'freezeSec', 'overtime',
];
const RULES_BY_MODE = Object.assign(Object.create(null), {
  // Positive integers where the mode uses the key; null where the mode has no such concept.
  bomb: { null: ['killLimit'],
    int: ['roundsToWin', 'maxRounds', 'sideSwitchAfter', 'roundLengthSec', 'bombTimerSec', 'defuseSec', 'plantSec', 'freezeSec'],
    bool: ['overtime'] },
  tdm: { null: ['roundsToWin', 'maxRounds', 'sideSwitchAfter', 'roundLengthSec', 'bombTimerSec', 'defuseSec', 'plantSec', 'freezeSec', 'overtime'],
    int: ['killLimit'], bool: [] },
});

/** Reject keys the shape does not declare. An unexpected field is a producer that has drifted. */
function closedKeys(value, allowed, path, problems) {
  for (const k of Object.keys(value)) {
    if (!allowed.includes(k)) problems.push(at(`${path}.${k}`, 'unknown-key'));
  }
}

function weaponsProblems(weapons, path, problems) {
  if (!isPlainObject(weapons)) {
    problems.push(at(path, 'type', { expected: 'object' }));
    return;
  }
  for (const [weaponId, row] of Object.entries(weapons)) {
    const wp = `${path}.${weaponId}`;
    if (!WEAPON_ID_RE.test(weaponId)) problems.push(at(wp, 'malformed-weapon-id'));
    if (!isPlainObject(row)) { problems.push(at(wp, 'type', { expected: 'object' })); continue; }
    closedKeys(row, WEAPON_COUNTERS, wp, problems);
    for (const k of WEAPON_COUNTERS) {
      if (!isCount(row[k])) problems.push(at(`${wp}.${k}`, 'count', { got: row[k] ?? null }));
    }
  }
}

function playerProblems(player, path, problems) {
  if (!isPlainObject(player)) {
    problems.push(at(path, 'type', { expected: 'object' }));
    return;
  }
  closedKeys(player, PLAYER_KEYS, path, problems);
  for (const k of ['accountId', 'displayName']) {
    if (!isNonEmptyString(player[k])) problems.push(at(`${path}.${k}`, 'required', { expected: 'non-empty string' }));
  }
  if (!TEAMS.includes(player.team)) {
    problems.push(at(`${path}.team`, 'enum', { allowed: TEAMS, got: player.team ?? null }));
  }
  // `role` is the STARTING role and is null in a mode that has no sides (§4.1). Absent is not
  // null: an omitted key is a producer that forgot, and defaulting it invents a side.
  if (!Object.hasOwn(player, 'role')) {
    problems.push(at(`${path}.role`, 'required', { expected: 'value or explicit null' }));
  } else if (player.role !== null && !ROLES.includes(player.role)) {
    problems.push(at(`${path}.role`, 'enum', { allowed: [...ROLES, null], got: player.role }));
  }
  for (const k of PLAYER_COUNTERS) {
    if (!isCount(player[k])) problems.push(at(`${path}.${k}`, 'count', { got: player[k] ?? null }));
  }
  // §2's table has teamKillPenalty and suicidePenalty, so a per-match score is legitimately
  // negative. It is the one number here that is not a count.
  if (!Number.isInteger(player.score)) problems.push(at(`${path}.score`, 'integer', { got: player.score ?? null }));
  for (const k of ['disconnected', 'abandoned']) {
    if (typeof player[k] !== 'boolean') problems.push(at(`${path}.${k}`, 'boolean', { got: player[k] ?? null }));
  }
  if (!isTimestamp(player.joinedAt)) problems.push(at(`${path}.joinedAt`, 'timestamp', { got: player.joinedAt ?? null }));
  if (!Object.hasOwn(player, 'leftAt')) {
    problems.push(at(`${path}.leftAt`, 'required', { expected: 'timestamp or explicit null' }));
  } else if (player.leftAt !== null && !isTimestamp(player.leftAt)) {
    problems.push(at(`${path}.leftAt`, 'timestamp', { got: player.leftAt }));
  }
  weaponsProblems(player.weapons, `${path}.weapons`, problems);
}

function rosterProblems(entry, path, problems) {
  if (!isPlainObject(entry)) {
    problems.push(at(path, 'type', { expected: 'object' }));
    return;
  }
  closedKeys(entry, ROSTER_KEYS, path, problems);
  if (!isNonEmptyString(entry.accountId)) {
    problems.push(at(`${path}.accountId`, 'required', { expected: 'non-empty string' }));
  }
  if (!TEAMS.includes(entry.team)) {
    problems.push(at(`${path}.team`, 'enum', { allowed: TEAMS, got: entry.team ?? null }));
  }
  if (!isTimestamp(entry.joinedAt)) problems.push(at(`${path}.joinedAt`, 'timestamp', { got: entry.joinedAt ?? null }));
  if (!Object.hasOwn(entry, 'leftAt')) {
    problems.push(at(`${path}.leftAt`, 'required', { expected: 'timestamp or explicit null' }));
  } else if (entry.leftAt !== null && !isTimestamp(entry.leftAt)) {
    problems.push(at(`${path}.leftAt`, 'timestamp', { got: entry.leftAt }));
  }
}

/** `plant` / `defuse`: the objective ACTOR record. Present in the stored row, or explicitly null. */
function objectiveProblems(value, path, keys, problems) {
  if (value === null) return;
  if (!isPlainObject(value)) {
    problems.push(at(path, 'type', { expected: 'object or null' }));
    return;
  }
  closedKeys(value, keys, path, problems);
  if (!isNonEmptyString(value.accountId)) {
    problems.push(at(`${path}.accountId`, 'required', { expected: 'non-empty string' }));
  }
  if (!isTimestamp(value.at)) problems.push(at(`${path}.at`, 'timestamp', { got: value.at ?? null }));
  if (keys.includes('site') && !BOMB_SITES.includes(value.site)) {
    problems.push(at(`${path}.site`, 'enum', { allowed: BOMB_SITES, got: value.site ?? null }));
  }
}

function roundProblems(round, path, problems) {
  if (!isPlainObject(round)) {
    problems.push(at(path, 'type', { expected: 'object' }));
    return;
  }
  closedKeys(round, ROUND_KEYS, path, problems);
  if (!isCount(round.index)) problems.push(at(`${path}.index`, 'count', { got: round.index ?? null }));
  if (!TEAMS.includes(round.winner)) {
    problems.push(at(`${path}.winner`, 'enum', { allowed: TEAMS, got: round.winner ?? null }));
  }
  if (!ROUND_REASONS.includes(round.reason)) {
    problems.push(at(`${path}.reason`, 'enum', { allowed: ROUND_REASONS, got: round.reason ?? null }));
  }
  for (const k of ['startedAt', 'endedAt']) {
    if (!isTimestamp(round[k])) problems.push(at(`${path}.${k}`, 'timestamp', { got: round[k] ?? null }));
  }
  // §4.1: roles are PER ROUND because the side switch means deriving them from a starting role
  // plus a switch point silently reinterprets every historical match when the rule changes.
  if (!isPlainObject(round.roles)) {
    problems.push(at(`${path}.roles`, 'type', { expected: 'object' }));
  } else {
    closedKeys(round.roles, TEAMS, `${path}.roles`, problems);
    for (const team of TEAMS) {
      if (!ROLES.includes(round.roles[team])) {
        problems.push(at(`${path}.roles.${team}`, 'enum', { allowed: ROLES, got: round.roles[team] ?? null }));
      }
    }
  }
  for (const [k, keys] of [['plant', ['accountId', 'site', 'at']], ['defuse', ['accountId', 'at']]]) {
    if (!Object.hasOwn(round, k)) {
      problems.push(at(`${path}.${k}`, 'required', { expected: 'object or explicit null' }));
      continue;
    }
    objectiveProblems(round[k], `${path}.${k}`, keys, problems);
  }
}

function teamScoresProblems(teamScores, problems) {
  if (!isPlainObject(teamScores)) return;              // the required-field check already said so
  closedKeys(teamScores, TEAMS, 'teamScores', problems);
  for (const team of TEAMS) {
    if (!isCount(teamScores[team])) {
      problems.push(at(`teamScores.${team}`, 'count', { got: teamScores[team] ?? null }));
    }
  }
}

function rulesSnapshotProblems(snapshot, mode, problems) {
  if (!isPlainObject(snapshot)) return;                // ditto
  const spec = RULES_BY_MODE[mode];
  if (!spec) return;                                   // an unknown mode is already a problem
  closedKeys(snapshot, RULES_KEYS, 'rulesSnapshot', problems);
  for (const k of RULES_KEYS) {
    if (!Object.hasOwn(snapshot, k)) {
      problems.push(at(`rulesSnapshot.${k}`, 'required', { expected: 'value or explicit null' }));
    }
  }
  for (const k of spec.null) {
    if (Object.hasOwn(snapshot, k) && snapshot[k] !== null) {
      problems.push(at(`rulesSnapshot.${k}`, 'must-be-null', { mode, got: snapshot[k] }));
    }
  }
  for (const k of spec.int) {
    if (Object.hasOwn(snapshot, k) && !(Number.isInteger(snapshot[k]) && snapshot[k] > 0)) {
      problems.push(at(`rulesSnapshot.${k}`, 'positive-integer', { mode, got: snapshot[k] }));
    }
  }
  for (const k of spec.bool) {
    if (Object.hasOwn(snapshot, k) && typeof snapshot[k] !== 'boolean') {
      problems.push(at(`rulesSnapshot.${k}`, 'boolean', { mode, got: snapshot[k] }));
    }
  }
}

/**
 * The §4.1/§4.2 NESTED shapes, exactly: required keys present, no unknown keys, correct types,
 * closed enums, counts non-negative.
 *
 * Separate from `terminalResultProblems` on purpose. That function is what both adapters run
 * before a write, and it answers "can this row be stored and later rendered" — the columns the
 * table declares. This one answers "is this the record the wire contract describes", which is
 * strictly more, and is what the SUBMISSION endpoint must hold a match server to. Applying the
 * stricter set at the storage door would also apply it to rows written by an allocation, a
 * backfill or a repair, none of which carry a §4.1 player row at all.
 */
export function nestedResultProblems(result) {
  const problems = [];
  if (!isPlainObject(result)) return [at('result', 'type', { expected: 'object' })];

  // §5.1 `ResultSubmission`: the terminal record and nothing else.
  //
  // The endpoint used to take "the full match-result.md §4 record", which is a reference to a
  // section containing the pending variant and the response-only correlation envelope as well.
  // A match server sending `correlationId` in the body was silently accepted and the field
  // silently dropped, so the producer's belief that it had bound the submission to a trace and
  // the platform's record of that trace disagreed with nothing able to see the difference.
  // Unknown keys are refused for the same reason nested unknown keys are: a key we ignore is a
  // key the sender thinks we honoured.
  for (const key of Object.keys(result)) {
    if (!SUBMISSION_KEYS.has(key)) {
      problems.push(at(key, RESPONSE_ONLY_KEYS.has(key) ? 'response-only' : 'unknown-key',
        { got: typeof result[key] }));
    }
  }

  if (Array.isArray(result.players)) {
    const seen = new Set();
    result.players.forEach((player, i) => {
      playerProblems(player, `players[${i}]`, problems);
      const id = player?.accountId;
      // (match_id, account_id) is the primary key. A duplicate is a malformed result, and the
      // last-writer-wins alternative hides the defect upstream rather than reporting it.
      if (isNonEmptyString(id)) {
        if (seen.has(id)) problems.push(at(`players[${i}].accountId`, 'duplicate', { got: id }));
        seen.add(id);
      }
    });
  }
  if (Array.isArray(result.roster)) {
    const seen = new Set();
    result.roster.forEach((entry, i) => {
      rosterProblems(entry, `roster[${i}]`, problems);
      const id = entry?.accountId;
      if (isNonEmptyString(id)) {
        if (seen.has(id)) problems.push(at(`roster[${i}].accountId`, 'duplicate', { got: id }));
        seen.add(id);
      }
    });
  }
  if (Array.isArray(result.rounds)) {
    result.rounds.forEach((round, i) => roundProblems(round, `rounds[${i}]`, problems));
  }
  teamScoresProblems(result.teamScores, problems);
  rulesSnapshotProblems(result.rulesSnapshot, result.mode, problems);
  return problems;
}

/**
 * The complete submission check: the §4.2 required fields, the §4.0 matrix, and every nested
 * §4.1 shape. One function so the endpoint cannot accidentally run two thirds of it.
 */
export function submittableResultProblems(result) {
  return terminalResultProblems(result).concat(nestedResultProblems(result));
}

/**
 * §4.2 required fields — "no ellipses, no comment standing in for a variant".
 *
 * Every key of the TerminalResult union, by the type the union gives it. A result missing one is
 * unstorable, not a variant: the row it produces cannot be rendered by the detail endpoint, and
 * `rulesSnapshot` in particular makes the whole record uninterpretable once the ruleset is
 * retuned (db-schema.md §4).
 */
const TERMINAL_REQUIRED_STRINGS = [
  'matchId', 'rulesetVersion', 'statDefinitionVersion', 'serverBuild',
  'mapId', 'mapVersion', 'region', 'mode', 'startedAt', 'endedAt',
  'terminationReason', 'outcomeReason', 'evidenceRef',
];

/** Non-terminal rows exist from allocation, before anything about the outcome is known. */
const PENDING_REQUIRED_STRINGS = ['matchId', 'mapId', 'region', 'mode'];

/**
 * Every key `ResultSubmission` may carry (match-result.md §5.1).
 *
 * The TerminalResult field set, plus the two allocation identifiers the row keeps (`roomId`,
 * `serverId`) — which are facts about the match, not about the response.
 */
const SUBMISSION_KEYS = new Set([
  'matchId', 'status', 'rulesetVersion', 'statDefinitionVersion', 'rulesSnapshot',
  'serverBuild', 'mapId', 'mapVersion', 'region', 'mode', 'startedAt', 'endedAt',
  'terminationReason', 'outcomeReason', 'winnerTeam', 'invalidationReason',
  'roster', 'teamScores', 'rounds', 'players', 'evidenceRef',
  'roomId', 'serverId',
]);

/**
 * Named separately so the refusal says WHICH mistake was made. "Unknown key" for `retryAfterMs`
 * reads as a typo; `response-only` says the sender copied a response shape into a request.
 */
const RESPONSE_ONLY_KEYS = new Set(['correlationId', 'retryAfterMs', 'resultAppliedAt', 'applied']);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The complete §4.2 check: required fields, then the outcome matrix.
 *
 * @returns {Array<object>} field-level problems, empty when the result is a valid TerminalResult
 */
export function terminalResultProblems(result) {
  const problems = [];
  if (!isPlainObject(result)) return [{ key: 'result', reason: 'type', expected: 'object' }];
  for (const field of TERMINAL_REQUIRED_STRINGS) {
    if (typeof result[field] !== 'string' || result[field].length === 0) {
      problems.push({ key: field, reason: 'required', expected: 'non-empty string', got: result[field] ?? null });
    }
  }
  if (typeof result.mode === 'string' && !MATCH_MODES.includes(result.mode)) {
    problems.push({ key: 'mode', reason: 'enum', allowed: MATCH_MODES, got: result.mode });
  }
  if (!isPlainObject(result.rulesSnapshot)) {
    problems.push({ key: 'rulesSnapshot', reason: 'required', expected: 'object' });
  }
  if (!isPlainObject(result.teamScores)) {
    problems.push({ key: 'teamScores', reason: 'required', expected: 'object' });
  }
  for (const field of ['roster', 'rounds', 'players']) {
    if (!Array.isArray(result[field])) {
      problems.push({ key: field, reason: 'required', expected: 'array', got: result[field] ?? null });
    }
  }
  // `winnerTeam` and `invalidationReason` are nullable, so "present" means the KEY is there —
  // an absent key is a field the producer forgot, and defaulting it to null invents an outcome.
  for (const field of ['winnerTeam', 'invalidationReason']) {
    if (!Object.hasOwn(result, field)) {
      problems.push({ key: field, reason: 'required', expected: 'value or explicit null' });
    }
  }
  return withContractPaths(problems).concat(matchOutcomeProblems(result));
}

/** Throwing form. §4.2 violations are malformed submissions, not variants of the union. */
export function assertTerminalResult(result) {
  const problems = terminalResultProblems(result);
  if (problems.length) {
    throw new ApiError('VALIDATION_FAILED', 'The match result is not a valid §4.2 TerminalResult.', {
      details: { table: 'matches', fields: problems },
    });
  }
}

/**
 * Cursor pagination arguments.  http-api.md §10.
 *
 * VALIDATED, not clamped. Silently turning `limit=0` into 25 and `limit=1e9` into 100 answers a
 * question the caller did not ask and hides a paging bug behind plausible-looking pages; §10
 * gives a default and a maximum, and anything outside them is a request that failed schema
 * (errors.md `VALIDATION_FAILED`).
 */
export const PAGE_LIMIT_DEFAULT = 25;
export const PAGE_LIMIT_MAX = 100;

/** A cursor is an opaque id echoed back from a previous page, never a caller-authored value. */
const CURSOR_RE = /^[0-9A-Za-z][0-9A-Za-z_.:-]{0,63}$/;

export function assertPageArgs({ limit, cursor } = {}) {
  const fields = [];
  if (limit !== undefined && limit !== null) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) {
      fields.push({ key: 'limit', reason: 'range', min: 1, max: PAGE_LIMIT_MAX, got: limit });
    }
  }
  if (cursor !== undefined && cursor !== null) {
    if (typeof cursor !== 'string' || !CURSOR_RE.test(cursor)) {
      fields.push({ key: 'cursor', reason: 'malformed', got: typeof cursor === 'string' ? cursor.slice(0, 32) : typeof cursor });
    }
  }
  if (fields.length) {
    throw new ApiError('VALIDATION_FAILED', 'Invalid pagination arguments.',
      { details: { fields: withContractPaths(fields) } });
  }
  return {
    limit: limit === undefined || limit === null ? PAGE_LIMIT_DEFAULT : limit,
    cursor: cursor === undefined ? null : cursor,
  };
}

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
  if (typeof result.status !== 'string') {
    throw new ApiError('VALIDATION_FAILED', 'matches.status is required', {
      details: { table: 'matches', column: 'status', fields: [{ key: 'status', reason: 'required' }] },
    });
  }
  const status = toStoredMatchStatus(result.status);
  const terminal = TERMINAL_MATCH_STATUSES.includes(status);

  if (terminal) {
    // §4.2 in full. The previous check read five string fields and stopped, so a result with no
    // rulesSnapshot, no endedAt, no outcomeReason and no players was stored as a completed match
    // — a row the detail endpoint cannot render and the career recompute cannot interpret.
    assertTerminalResult({ ...result, status });
  } else {
    // Allocation knows the identifiers and nothing else: the outcome fields do not exist yet.
    for (const required of PENDING_REQUIRED_STRINGS) {
      if (typeof result[required] !== 'string' || !result[required]) {
        throw new ApiError('VALIDATION_FAILED', `matches.${required} is required`, {
          details: { table: 'matches', column: required, fields: [{ key: required, reason: 'required' }] },
        });
      }
    }
    if (!MATCH_MODES.includes(result.mode)) {
      throw new ApiError('VALIDATION_FAILED', `Unknown mode: ${result.mode}`, {
        details: { table: 'matches', column: 'mode', fields: [{ key: 'mode', reason: 'enum', allowed: MATCH_MODES }] },
      });
    }
    // A non-terminal row has no outcome, so carrying one is a producer that has confused the
    // two shapes — and the column would then contradict the status it sits beside.
    for (const key of ['winnerTeam', 'outcomeReason', 'invalidationReason']) {
      if (result[key] !== undefined && result[key] !== null) {
        throw new ApiError('VALIDATION_FAILED', `A ${status} match cannot carry ${key}.`, {
          details: { table: 'matches', column: key, fields: [{ key, reason: 'must-be-null', got: result[key] }] },
        });
      }
    }
    if (result.terminationReason !== undefined && result.terminationReason !== null) {
      throw new ApiError('VALIDATION_FAILED', `A ${status} match cannot carry terminationReason.`, {
        details: { table: 'matches', column: 'terminationReason',
          fields: [{ key: 'terminationReason', reason: 'must-be-null', got: result.terminationReason }] },
      });
    }
  }

  const winnerTeam = result.winnerTeam ?? null;

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
    status,
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
    // `joined_at` is NOT NULL with a `default now()` (0004). Passing an explicit null
    // DEFEATS the default and violates the constraint, so an ALLOCATED match — which has no
    // startedAt yet, by definition — could not record its roster on Postgres while succeeding
    // on memory. The lifecycle the transition table was added to support was broken on the
    // only adapter that ships, and every test for it passed because they run on memory.
    const joinedAt = player.joinedAt ?? match.startedAt ?? null;
    participants.push({
      matchId: match.matchId,
      accountId: player.accountId,
      team: player.team ?? null,
      // Omitted entirely when unknown, so the column default applies on Postgres and the
      // memory adapter stamps the same value.
      ...(joinedAt === null ? {} : { joinedAt }),
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
