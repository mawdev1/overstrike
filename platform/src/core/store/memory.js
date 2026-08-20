/**
 * In-memory Store adapter.  contracts/db-schema.md, core/store.js.
 *
 * This is not a stub. It is the adapter every test and every local run uses, so if it is
 * looser than Postgres the whole platform is tested against rules the real database does not
 * have — and the difference shows up in production, once, at the worst moment. Therefore this
 * adapter deliberately enforces what the schema declares: not-null columns, unique constraints,
 * foreign keys, the unknown-column rejection, and real transactions.
 *
 * The transaction model is snapshot-and-swap under a queue lock:
 *
 *   - `tx(fn)` deep-clones the live state, hands `fn` a handle onto the clone, and publishes
 *     the clone with a single assignment on success. A throw simply never publishes, so
 *     rollback is not a compensating undo that can itself be wrong.
 *   - Every transaction and every standalone write runs through one promise chain. Without
 *     the lock, two overlapping transactions each clone the same base state and the second
 *     commit silently discards the first one's writes across the ENTIRE state, not just the
 *     rows it touched. That is a lost update no test would notice until the outbox drops an
 *     event.
 *   - The clone is `structuredClone`, not a shallow row copy. Rows carry jsonb sub-objects;
 *     with a shallow copy a rolled-back transaction leaves its mutations to `payload`,
 *     `privacy` or `rollout` behind in the live state.
 *
 * Cost: a full state clone per write. Correct and O(state) is the right trade for an adapter
 * whose job is tests and local work; Postgres is what runs under load.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError } from '../errors.js';
import { ulid as defaultUlid } from '../ids.js';
import {
  STAT_COUNTERS, WEAPON_COUNTERS, STAT_DELTA_LIMITS, WEAPON_DELTA_LIMITS, assertCounterDelta,
  MATCH_COLUMNS, normaliseMatchResult, toHistoryMatchStatus, assertStorable,
} from '../store.js';

/** Handles are tagged so a handle from another store (or a stray object) fails loudly. */
const TX = Symbol('overstrike.memtx');

/**
 * The state a handle refers to, held OUTSIDE the handle.
 *
 * When the handle carried `state` as an own property, holding a handle was holding the live
 * Maps: `tx.state.audit.delete(id)` erased an audit row, and `tx.state.accounts.set(...)`
 * forged one, both bypassing every check in this file. A WeakMap keyed by the handle is
 * unreachable from the handle — unlike a symbol-keyed property, which
 * `Object.getOwnPropertySymbols` hands straight back.
 */
const handleState = new WeakMap();

/**
 * Reentrancy tracking for `tx`. Async-local rather than a plain variable: a plain "am I in a
 * transaction" flag cannot tell a NESTED call from a CONCURRENT unrelated one, and enrolling a
 * concurrent caller into somebody else's transaction is worse than the deadlock it fixes.
 */
const txContext = new AsyncLocalStorage();

/**
 * Shared with the Postgres adapter (store.js): one answer to an unstorable argument.
 * Here it matters twice over, because the state is published by cloning it — a value the clone
 * algorithm refuses does not fail the write that introduced it, it fails every write AFTER it,
 * forever. One bad `revokedReason` used to brick the store permanently.
 */
const assertCloneable = assertStorable;

/**
 * Timestamps cross the interface as ISO strings in both adapters.
 * `pg` hands back `Date`, this adapter would naturally hand back whatever it was given, and
 * code written against one shape then breaks against the other. Normalise at the boundary.
 */
function toIso(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  if (typeof v === 'string') return v;
  throw new ApiError('VALIDATION_FAILED', 'Timestamp must be a Date, epoch ms, or ISO string.');
}

const clone = (v) => (v === null || v === undefined ? null : structuredClone(v));

/** Composite keys are joined with a unit separator, which cannot occur in a ULID or a mode. */
const key = (...parts) => parts.join('\u001f');

function emptyState() {
  return {
    accounts: new Map(),
    preAuthConsent: new Map(),
    sessions: new Map(),
    refreshTokens: new Map(),
    profiles: new Map(),
    stats: new Map(),
    weaponStats: new Map(),
    matches: new Map(),
    matchParticipants: new Map(),
    outbox: new Map(),
    audit: new Map(),
    idempotency: new Map(),
    flags: new Map(),
  };
}

/**
 * Column maps have a NULL prototype, and membership is tested with `Object.hasOwn`.
 *
 * With a normal object literal and `k in columns`, the prototype chain is part of the
 * allow-list: `constructor`, `toString`, `valueOf`, `hasOwnProperty` and `__proto__` all pass
 * as legal columns on accounts, profiles and feature_flags. That is not a cosmetic hole — the
 * accepted key is then written into the row and, on Postgres, into a statement.
 */
const columns = (spec) => Object.assign(Object.create(null), spec);

/**
 * Columns, with their defaults. Also the allow-list: a key not named here is rejected rather
 * than stored, because Postgres would reject it too and a memory adapter that shrugs at
 * `displayname` or `birthdate` hides the bug until the first real deployment.
 *
 * `accounts` has no birthdate by design (db-schema.md §2) — the eligibility preflight
 * evaluates a date of birth and discards it. Trying to store one is an error here, on purpose.
 */
const ACCOUNT_COLUMNS = columns({
  accountId: undefined,
  status: 'active',
  emailHash: null,
  displayName: undefined,
  displayNameFolded: undefined,
  // Migration 0008. Null when identity is delegated to the provider (D1); roles default to
  // the one every account has, because an account with no roles can do nothing and is a bug
  // rather than a state we ever mean.
  passwordHash: null,
  roles: ['player'],
  nameChangedAt: null,
  eligibilityVerdict: null,
  eligibilityPolicyVer: null,
  eligibilityDecidedAt: null,
  emailVerifiedAt: null,
  termsVersionAccepted: null,
  termsAcceptedAt: null,
  consentTelemetry: null,
  consentPolicyVer: null,
  consentDecidedAt: null,
  privacy: null,
  createdAt: null,
  updatedAt: null,
  deletedAt: null,
});

const ACCOUNT_TIMESTAMPS = [
  'nameChangedAt',
  'eligibilityDecidedAt', 'emailVerifiedAt', 'termsAcceptedAt', 'consentDecidedAt',
  'createdAt', 'updatedAt', 'deletedAt',
];

const SESSION_COLUMNS = columns({
  sessionId: undefined,
  accountId: undefined,
  deviceLabel: null,
  userAgentClass: null,
  ipClass: null,
  createdAt: null,
  lastSeenAt: null,
  revokedAt: null,
  revokedReason: null,
  refreshFamilyId: undefined,
});

const REFRESH_COLUMNS = columns({
  tokenId: undefined,
  familyId: undefined,
  accountId: undefined,
  sessionId: undefined,
  issuedAt: null,
  expiresAt: undefined,
  usedAt: null,
});

const OUTBOX_COLUMNS = columns({
  eventId: undefined,
  eventType: undefined,
  eventVersion: 1,
  subjectKind: undefined,
  subjectId: undefined,
  correlationId: null,
  causationId: null,
  actor: null,
  payload: null,
  privacyClass: 'internal',
  retentionClass: 'standard',
  schemaRef: undefined,
  occurredAt: null,
  recordedAt: null,
  publishedAt: null,
  attempts: 0,
  lastError: null,
  deadLetteredAt: null,
});

const AUDIT_COLUMNS = columns({
  auditId: undefined,
  actorKind: undefined,
  actorId: null,
  actorRole: null,
  action: undefined,
  subjectKind: undefined,
  subjectId: undefined,
  reasonCode: undefined,
  beforeSummary: null,
  afterSummary: null,
  correlationId: null,
  createdAt: null,
});

const IDEMPOTENCY_COLUMNS = columns({
  key: undefined,
  actorId: undefined,
  requestHash: undefined,
  responseStatus: null,
  responseBody: null,
  createdAt: null,
  expiresAt: null,
});

/**
 * Profiles and flags are PATCH surfaces, so their allow-list is the set of columns a patch may
 * carry — not the set of columns the table has. account_id is identity, and created_at and
 * updated_at belong to the 0001 trigger; a patch that could set updated_at is a clock the
 * caller writes, and that is exactly where the two adapters used to disagree.
 */
const PROFILE_COLUMNS = columns({
  roamingSettings: null,
  // Migration 0010. The one-time import of the offline progression blob (profile/migration.js).
  // It has a column because the module writes it; without one, memory rejected the write and
  // Postgres discarded it silently, which is the worse of the two failures.
  legacyImport: null,
  settingsVersion: 1,
});

const FLAG_COLUMNS = columns({
  enabled: false,
  rollout: null,
  isKillSwitch: false,
  updatedBy: null,
});

function assertKnown(row, cols, table) {
  for (const k of Object.keys(row)) {
    if (!Object.hasOwn(cols, k)) {
      throw new ApiError('VALIDATION_FAILED', `Unknown column for ${table}: ${k}`, {
        details: { table, column: k },
      });
    }
  }
}

/** Apply defaults, enforce not-null, reject unknown columns. One place, every table. */
function materialise(row, cols, table) {
  assertKnown(row, cols, table);
  const out = {};
  for (const [col, dflt] of Object.entries(cols)) {
    const given = row[col];
    if (given === undefined) {
      if (dflt === undefined) {
        throw new ApiError('VALIDATION_FAILED', `${table}.${col} is required`, {
          details: { table, column: col },
        });
      }
      out[col] = dflt;
    } else {
      out[col] = given === undefined ? null : given;
    }
  }
  return out;
}

export function createMemoryStore(config = {}, deps = {}) {
  const nowIso = () => toIso(deps.now ? deps.now() : new Date());
  const newId = deps.ulid ?? defaultUlid;

  /** Identity of THIS store, so a handle from another instance is rejected rather than used. */
  const storeTag = Symbol('overstrike.memstore');

  let live = emptyState();
  let closed = false;

  /**
   * Serialisation queue. Every write and every transaction takes a turn on it, so the
   * clone/commit window of one never overlaps the clone/commit window of another.
   */
  let chain = Promise.resolve();
  function withLock(fn) {
    const result = chain.then(fn);
    // The queue must outlive a failed member, otherwise one rolled-back transaction
    // permanently poisons every later call.
    chain = result.then(() => {}, () => {});
    return result;
  }

  function assertOpen() {
    if (closed) throw new ApiError('SERVICE_UNAVAILABLE', 'Store is closed.');
  }

  function stateFor(tx) {
    if (tx === undefined || tx === null) return null;
    if (!tx[TX]) throw new ApiError('INTERNAL_ERROR', 'Not a transaction handle from this store.');
    const entry = handleState.get(tx);
    // A handle from another store instance carries the tag but not an entry in THIS store's
    // map, which is the case a shared symbol tag alone would let through.
    if (!entry || entry.store !== storeTag) {
      throw new ApiError('INTERNAL_ERROR', 'Not a transaction handle from this store.');
    }
    if (entry.done) throw new ApiError('INTERNAL_ERROR', 'Transaction handle used after the transaction ended.');
    return entry.state;
  }

  /**
   * The state a call should act on: the explicit handle, else the transaction ambient on the
   * async call stack, else the live state.
   *
   * The ambient case exists because omitting the handle inside `tx(fn)` used to take a lock
   * the caller was already holding — the same permanent hang as a nested `tx`. Enrolling is
   * both the non-hanging answer and the one that matches what the caller obviously meant.
   */
  function target(txh) {
    const explicit = stateFor(txh);
    if (explicit) return explicit;
    const ambient = txContext.getStore();
    if (ambient && ambient.store === storeTag && !ambient.done) return ambient.state;
    return null;
  }

  /** Reads need no lock: nothing awaits between lookup and return, so nothing can interleave. */
  function read(tx, fn) {
    assertOpen();
    return Promise.resolve(fn(target(tx) ?? live));
  }

  /**
   * A standalone write is a one-statement transaction: it gets the same clone-and-publish
   * treatment so a method that throws halfway cannot leave a half-written row behind.
   */
  function write(tx, fn) {
    assertOpen();
    const st = target(tx);
    if (st) return Promise.resolve(fn(st));   // already inside a transaction; it holds the lock
    return withLock(() => {
      const working = structuredClone(live);
      const out = fn(working);
      live = working;
      return out;
    });
  }

  /**
   * `tx(fn)` — one transaction, and reentrant calls join it rather than deadlocking.
   *
   * A nested `store.tx` used to queue behind a lock its own caller was holding, so it never
   * ran, the outer call never returned, and `close()` — which drains the queue — waited on it
   * forever. The process hung with no error anywhere.
   *
   * A nested call now runs against the OUTER handle. There are no savepoints, so an inner
   * failure the outer swallows leaves the inner's writes in the outer transaction: catching
   * inside a transaction and committing anyway means committing what the inner wrote.
   */
  async function tx(fn) {
    assertOpen();
    const outer = txContext.getStore();
    if (outer && outer.store === storeTag) return fn(outer.handle);

    return withLock(async () => {
      const working = structuredClone(live);
      const handle = Object.freeze({ [TX]: true });
      const entry = { store: storeTag, state: working, done: false, handle };
      handleState.set(handle, entry);
      try {
        const out = await txContext.run(entry, () => fn(handle));
        // Commit is one assignment. A reader can see the state before or after, never during.
        live = working;
        return out;
      } finally {
        // Rollback needs no undo log: the clone is simply never published.
        entry.done = true;
      }
    });
  }

  /** Declared foreign keys are enforced here too, or memory-green means nothing on Postgres. */
  function requireAccount(st, accountId, table) {
    if (!st.accounts.has(accountId)) {
      throw new ApiError('NOT_FOUND', `${table}: no such account`, { details: { accountId } });
    }
  }

  const accounts = {
    create(row, txh) {
      assertCloneable(row, 'accounts row');
      return write(txh, (st) => {
        const rec = materialise(
          { accountId: row.accountId ?? newId(), ...row },
          ACCOUNT_COLUMNS,
          'accounts',
        );
        const ts = nowIso();
        rec.createdAt = toIso(rec.createdAt) ?? ts;
        rec.updatedAt = toIso(rec.updatedAt) ?? ts;
        for (const c of ACCOUNT_TIMESTAMPS) rec[c] = toIso(rec[c]);
        rec.privacy = rec.privacy ?? {};
        if (st.accounts.has(rec.accountId)) {
          throw new ApiError('CONFLICT', 'Account already exists.', { details: { accountId: rec.accountId } });
        }
        // Uniqueness lives on the folded name, never the raw one: enforcing on `display_name`
        // lets `Ada` and `Аdа` coexist, which is the cheapest impersonation attack there is.
        for (const a of st.accounts.values()) {
          if (a.displayNameFolded === rec.displayNameFolded) {
            throw new ApiError('NAME_TAKEN', 'That display name is taken.', {
              details: { displayNameFolded: rec.displayNameFolded },
            });
          }
          if (rec.emailHash !== null && a.emailHash === rec.emailHash) {
            throw new ApiError('CONFLICT', 'That email is already registered.');
          }
        }
        st.accounts.set(rec.accountId, rec);
        return clone(rec);
      });
    },

    byId(accountId, txh) {
      return read(txh, (st) => clone(st.accounts.get(accountId) ?? null));
    },

    byEmailHash(hash, txh) {
      return read(txh, (st) => {
        if (hash === null || hash === undefined) return null;
        for (const a of st.accounts.values()) if (a.emailHash === hash) return clone(a);
        return null;
      });
    },

    byNameFolded(folded, txh) {
      return read(txh, (st) => {
        for (const a of st.accounts.values()) if (a.displayNameFolded === folded) return clone(a);
        return null;
      });
    },

    update(accountId, patch, txh) {
      assertCloneable(patch, 'accounts patch');
      return write(txh, (st) => {
        const cur = st.accounts.get(accountId);
        if (!cur) throw new ApiError('NOT_FOUND', 'No such account.', { details: { accountId } });
        assertKnown(patch, ACCOUNT_COLUMNS, 'accounts');
        if (Object.hasOwn(patch, 'accountId') && patch.accountId !== accountId) {
          throw new ApiError('VALIDATION_FAILED', 'accountId is immutable.');
        }
        const next = { ...cur, ...patch, accountId, createdAt: cur.createdAt };
        for (const c of ACCOUNT_TIMESTAMPS) next[c] = toIso(next[c]);
        next.updatedAt = nowIso();
        if (next.displayNameFolded !== cur.displayNameFolded) {
          for (const a of st.accounts.values()) {
            if (a.accountId !== accountId && a.displayNameFolded === next.displayNameFolded) {
              throw new ApiError('NAME_TAKEN', 'That display name is taken.');
            }
          }
        }
        if (next.emailHash !== null && next.emailHash !== cur.emailHash) {
          for (const a of st.accounts.values()) {
            if (a.accountId !== accountId && a.emailHash === next.emailHash) {
              throw new ApiError('CONFLICT', 'That email is already registered.');
            }
          }
        }
        st.accounts.set(accountId, next);
        return clone(next);
      });
    },
  };

  const sessions = {
    create(row, txh) {
      assertCloneable(row, 'sessions row');
      return write(txh, (st) => {
        const rec = materialise(
          { sessionId: row.sessionId ?? newId(), ...row },
          SESSION_COLUMNS,
          'sessions',
        );
        requireAccount(st, rec.accountId, 'sessions');
        const ts = nowIso();
        rec.createdAt = toIso(rec.createdAt) ?? ts;
        rec.lastSeenAt = toIso(rec.lastSeenAt) ?? ts;
        rec.revokedAt = toIso(rec.revokedAt);
        if (st.sessions.has(rec.sessionId)) throw new ApiError('CONFLICT', 'Session already exists.');
        st.sessions.set(rec.sessionId, rec);
        return clone(rec);
      });
    },

    byId(sessionId, txh) {
      return read(txh, (st) => clone(st.sessions.get(sessionId) ?? null));
    },

    listForAccount(accountId, txh) {
      return read(txh, (st) => [...st.sessions.values()]
        .filter((s) => s.accountId === accountId)
        .sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1))
        .map(clone));
    },

    /**
     * Revoking a session that does not exist is NOT_FOUND on both adapters. Postgres used to
     * be silent, which meant a typo'd session id and a successful revocation were the same
     * outcome — and the caller was a security path.
     */
    revoke(sessionId, reason, at, txh) {
      assertCloneable(reason, 'sessions.revokedReason');
      return write(txh, (st) => {
        const s = st.sessions.get(sessionId);
        if (!s) throw new ApiError('NOT_FOUND', 'No such session.', { details: { sessionId } });
        // Revocation is idempotent and never re-stamped: the first revocation is the true one.
        if (s.revokedAt) return;
        s.revokedAt = toIso(at) ?? nowIso();
        s.revokedReason = reason ?? null;
      });
    },

    revokeAllForAccount(accountId, reason, at, txh) {
      assertCloneable(reason, 'sessions.revokedReason');
      return write(txh, (st) => {
        const ts = toIso(at) ?? nowIso();
        let n = 0;
        for (const s of st.sessions.values()) {
          if (s.accountId !== accountId || s.revokedAt) continue;
          s.revokedAt = ts;
          s.revokedReason = reason ?? null;
          n++;
        }
        return n;
      });
    },

    /** Refresh-token reuse revokes the whole family, not just the replayed token (auth.md §5). */
    revokeFamily(familyId, reason, at, txh) {
      assertCloneable(reason, 'sessions.revokedReason');
      return write(txh, (st) => {
        const ts = toIso(at) ?? nowIso();
        let n = 0;
        for (const s of st.sessions.values()) {
          if (s.refreshFamilyId !== familyId || s.revokedAt) continue;
          s.revokedAt = ts;
          s.revokedReason = reason ?? null;
          n++;
        }
        for (const t of st.refreshTokens.values()) {
          if (t.familyId === familyId && !t.usedAt) t.usedAt = ts;
        }
        return n;
      });
    },
  };

  const refreshTokens = {
    create(row, txh) {
      assertCloneable(row, 'refresh_tokens row');
      return write(txh, (st) => {
        const rec = materialise(
          { tokenId: row.tokenId ?? newId(), ...row },
          REFRESH_COLUMNS,
          'refresh_tokens',
        );
        requireAccount(st, rec.accountId, 'refresh_tokens');
        if (!st.sessions.has(rec.sessionId)) {
          throw new ApiError('NOT_FOUND', 'refresh_tokens: no such session', { details: { sessionId: rec.sessionId } });
        }
        rec.issuedAt = toIso(rec.issuedAt) ?? nowIso();
        rec.expiresAt = toIso(rec.expiresAt);
        rec.usedAt = toIso(rec.usedAt);
        if (st.refreshTokens.has(rec.tokenId)) throw new ApiError('CONFLICT', 'Token already exists.');
        st.refreshTokens.set(rec.tokenId, rec);
        return clone(rec);
      });
    },

    byId(tokenId, txh) {
      return read(txh, (st) => clone(st.refreshTokens.get(tokenId) ?? null));
    },

    markUsed(tokenId, at, txh) {
      return write(txh, (st) => {
        const t = st.refreshTokens.get(tokenId);
        if (!t) throw new ApiError('NOT_FOUND', 'No such refresh token.', { details: { tokenId } });
        // Deliberately not idempotent-silent: the caller needs to see that a used token was
        // presented again, because that is the reuse signal that revokes the family.
        if (t.usedAt) throw new ApiError('CONFLICT', 'Refresh token already used.', { details: { tokenId } });
        t.usedAt = toIso(at) ?? nowIso();
      });
    },
  };

  const profiles = {
    /**
     * Patch semantics, decided once for both adapters: a key PRESENT in the patch sets the
     * column, including to null; a key that is absent leaves it alone.
     *
     * Postgres used to `coalesce` every field, so a null meant "leave it" and a roaming
     * settings blob could never be cleared — the delete-my-settings path silently did nothing,
     * while memory cleared it. One of the two adapters had to be wrong, and it was the one
     * that could not express the operation.
     */
    upsert(accountId, patch, txh) {
      assertCloneable(patch, 'profiles patch');
      return write(txh, (st) => {
        requireAccount(st, accountId, 'profiles');
        const cur = st.profiles.get(accountId);
        const next = {
          accountId,
          roamingSettings: cur?.roamingSettings ?? null,
          legacyImport: cur?.legacyImport ?? null,
          settingsVersion: cur?.settingsVersion ?? 1,
          createdAt: cur?.createdAt ?? nowIso(),
          updatedAt: nowIso(),
        };
        assertKnown(patch ?? {}, PROFILE_COLUMNS, 'profiles');
        for (const k of Object.keys(patch ?? {})) {
          if (k === 'settingsVersion' && !Number.isInteger(patch[k])) {
            throw new ApiError('VALIDATION_FAILED', 'profiles.settingsVersion must be an integer.', {
              details: { table: 'profiles', column: 'settingsVersion' },
            });
          }
          next[k] = patch[k];
        }
        st.profiles.set(accountId, next);
        return clone(next);
      });
    },

    /**
     * Compare-and-set on `settingsVersion`.  http-api.md §11.2.
     *
     * `upsert` cannot express If-Match: the caller reads a version, decides, then writes, and
     * between those two steps another writer can land. Both writers then believe they won and
     * one rebind is silently gone — the exact loss §11.2 exists to prevent. The comparison has
     * to happen at the write, in the same step that performs it.
     *
     * Returns null when the expected version no longer holds, so the caller raises CONFLICT
     * with the current state rather than guessing why.
     */
    upsertIfVersion(accountId, expectedVersion, patch, txh) {
      assertCloneable(patch, 'profiles patch');
      return write(txh, (st) => {
        requireAccount(st, accountId, 'profiles');
        const cur = st.profiles.get(accountId);
        const actual = cur?.settingsVersion ?? 1;
        if (actual !== expectedVersion) return null;
        assertKnown(patch ?? {}, PROFILE_COLUMNS, 'profiles');
        const next = {
          accountId,
          roamingSettings: cur?.roamingSettings ?? null,
          legacyImport: cur?.legacyImport ?? null,
          settingsVersion: actual,
          createdAt: cur?.createdAt ?? nowIso(),
          updatedAt: nowIso(),
        };
        for (const k of Object.keys(patch ?? {})) next[k] = patch[k];
        st.profiles.set(accountId, next);
        return clone(next);
      });
    },

    byAccountId(accountId, txh) {
      return read(txh, (st) => clone(st.profiles.get(accountId) ?? null));
    },
  };

  function zeroStats(accountId, mode, sdv) {
    const row = { accountId, mode, statDefinitionVersion: sdv };
    for (const c of STAT_COUNTERS) row[c] = 0;
    row.updatedAt = null;
    return row;
  }

  const stats = {
    get(accountId, mode, statDefinitionVersion, txh) {
      return read(txh, (st) => clone(st.stats.get(key(accountId, mode, statDefinitionVersion)) ?? null));
    },

    /**
     * Additive only. No stored ratios (db-schema.md §3) and no assignment: a delta that
     * overwrote would make replaying a match result destroy every earlier match.
     */
    applyDelta(accountId, mode, statDefinitionVersion, delta, txh) {
      assertCounterDelta(delta, STAT_COUNTERS, STAT_DELTA_LIMITS, 'player_stats');
      return write(txh, (st) => {
        requireAccount(st, accountId, 'player_stats');
        const k = key(accountId, mode, statDefinitionVersion);
        const row = st.stats.get(k) ?? zeroStats(accountId, mode, statDefinitionVersion);
        for (const c of STAT_COUNTERS) row[c] += delta?.[c] ?? 0;
        row.updatedAt = nowIso();
        st.stats.set(k, row);
        return clone(row);
      });
    },

    listForAccount(accountId, txh) {
      return read(txh, (st) => [...st.stats.values()]
        .filter((r) => r.accountId === accountId)
        .map(clone));
    },
  };

  const weaponStats = {
    applyDelta(accountId, mode, weaponId, statDefinitionVersion, delta, txh) {
      assertCounterDelta(delta, WEAPON_COUNTERS, WEAPON_DELTA_LIMITS, 'player_weapon_stats');
      return write(txh, (st) => {
        requireAccount(st, accountId, 'player_weapon_stats');
        // stat_definition_version is part of the key here for the same reason it is in
        // player_stats: a definition change must not rewrite historical per-weapon accuracy.
        const k = key(accountId, mode, weaponId, statDefinitionVersion);
        const row = st.weaponStats.get(k) ?? {
          accountId, mode, weaponId, statDefinitionVersion,
          ...Object.fromEntries(WEAPON_COUNTERS.map((c) => [c, 0])),
          updatedAt: null,
        };
        for (const c of WEAPON_COUNTERS) row[c] += delta?.[c] ?? 0;
        row.updatedAt = nowIso();
        st.weaponStats.set(k, row);
        return clone(row);
      });
    },

    listForAccount(accountId, mode, txh) {
      return read(txh, (st) => [...st.weaponStats.values()]
        .filter((r) => r.accountId === accountId && (mode === undefined || r.mode === mode))
        .map(clone));
    },
  };

  /**
   * Matches and their participants.  match-result.md §4, §4.3; migration 0004.
   *
   * Two tables behind one method because a match row without its participants is a match
   * nobody played, and the two must land together or the career recompute in §6 reads a hole.
   */
  const CONSENT_COLUMNS = columns({
    clientSessionId: undefined, telemetryPersonal: undefined, policyVersion: undefined,
    decidedAt: null, expiresAt: undefined,
  });

  const matches = {
    /**
     * Written once per match, immutable thereafter (§4). A second record for the same match id
     * is CONFLICT rather than an overwrite: §5.5 makes a second, different truth for a
     * finalised match a bug or an attack, and overwriting would erase the first one either way.
     */
    record(result, txh) {
      assertCloneable(result, 'match result');
      const { match, participants } = normaliseMatchResult(result);
      return write(txh, (st) => {
        if (st.matches.has(match.matchId)) {
          throw new ApiError('CONFLICT', 'That match already has a result.', {
            details: { matchId: match.matchId },
          });
        }
        const rec = {};
        for (const c of MATCH_COLUMNS) rec[c] = match[c] ?? null;
        for (const c of ['startedAt', 'endedAt']) rec[c] = toIso(rec[c]);
        rec.recordedAt = nowIso();
        st.matches.set(rec.matchId, rec);
        for (const p of participants) {
          requireAccount(st, p.accountId, 'match_participants');
          const prec = { ...p, joinedAt: toIso(p.joinedAt), leftAt: toIso(p.leftAt) };
          st.matchParticipants.set(key(p.matchId, p.accountId), prec);
        }
        return { matchId: rec.matchId, participants: participants.length };
      });
    },

    /**
     * History, newest first, cursor-paginated.
     *
     * Ordered by match id descending rather than ended_at: match ids are ULIDs assigned at
     * allocation (0004), so they are already chronological, they are unique, and they are not
     * null on a match that never ended. Ordering on ended_at would put every live match in one
     * undifferentiated null bucket and make the cursor ambiguous exactly there.
     *
     * The cursor is the last id of the previous page — an offset would skip or repeat rows as
     * matches are inserted between requests.
     */
    listForAccount(accountId, { limit = 25, cursor = null } = {}, txh) {
      return read(txh, (st) => {
        const size = Math.max(1, Math.min(Number(limit) || 25, 200));
        const rows = [];
        for (const p of st.matchParticipants.values()) {
          if (p.accountId !== accountId) continue;
          if (cursor !== null && cursor !== undefined && !(p.matchId < cursor)) continue;
          const m = st.matches.get(p.matchId);
          if (!m) continue;
          rows.push({ m, p });
        }
        rows.sort((a, b) => (a.m.matchId < b.m.matchId ? 1 : -1));
        const page = rows.slice(0, size);
        const items = page.map(({ m, p }) => clone({
          ...m,
          status: toHistoryMatchStatus(m.status),
          participant: {
            team: p.team, joinedAt: p.joinedAt, leftAt: p.leftAt,
            disconnected: p.disconnected, abandoned: p.abandoned,
            stats: p.stats,
          },
        }));
        return {
          items,
          // Null only when the page was not full: a next cursor on a short page sends the
          // caller round again for nothing, and `recomputeCareer` loops on it.
          nextCursor: rows.length > size ? page[page.length - 1].m.matchId : null,
        };
      });
    },
  };

  const preAuthConsent = {
    /**
     * A new decision RESETS migrated_at on both adapters. Postgres used to leave it set, so a
     * client that changed its mind after signup kept a receipt claiming the new decision had
     * already been carried onto an account — which is a consent record that is not true.
     * `migratedAt` is therefore not a column a caller may write; only markMigrated sets it.
     */
    put(row, txh) {
      assertCloneable(row, 'pre_auth_consent row');
      return write(txh, (st) => {
        const rec = materialise(row, CONSENT_COLUMNS, 'pre_auth_consent');
        rec.decidedAt = toIso(rec.decidedAt) ?? nowIso();
        rec.expiresAt = toIso(rec.expiresAt);
        rec.migratedAt = null;
        // Last decision wins: the same signed-out client changing its mind is the normal path.
        st.preAuthConsent.set(rec.clientSessionId, rec);
        return clone(rec);
      });
    },

    get(clientSessionId, txh) {
      return read(txh, (st) => clone(st.preAuthConsent.get(clientSessionId) ?? null));
    },

    markMigrated(clientSessionId, at, txh) {
      return write(txh, (st) => {
        const r = st.preAuthConsent.get(clientSessionId);
        if (!r) throw new ApiError('NOT_FOUND', 'No pre-auth consent for that client session.');
        r.migratedAt = toIso(at) ?? nowIso();
      });
    },
  };

  const outbox = {
    /**
     * The whole point of the outbox is that this runs inside the caller's transaction. Called
     * without one it is still correct, just no longer atomic with anything.
     */
    insert(event, txh) {
      assertCloneable(event, 'events_outbox row');
      return write(txh, (st) => {
        const rec = materialise(
          { eventId: event.eventId ?? newId(), ...event },
          OUTBOX_COLUMNS,
          'events_outbox',
        );
        const ts = nowIso();
        rec.occurredAt = toIso(rec.occurredAt) ?? ts;
        rec.recordedAt = toIso(rec.recordedAt) ?? ts;
        rec.publishedAt = toIso(rec.publishedAt);
        rec.deadLetteredAt = toIso(rec.deadLetteredAt);
        if (st.outbox.has(rec.eventId)) {
          throw new ApiError('CONFLICT', 'Event already in the outbox.', { details: { eventId: rec.eventId } });
        }
        st.outbox.set(rec.eventId, rec);
        return clone(rec);
      });
    },

    claimUnpublished(limit = 100, txh) {
      return read(txh, (st) => [...st.outbox.values()]
        .filter((e) => e.publishedAt === null && e.deadLetteredAt === null)
        // Ordering is per subject (event-envelope.md §3); occurredAt then eventId gives that,
        // and ULIDs break the tie in creation order rather than arbitrarily.
        .sort((a, b) => (a.occurredAt === b.occurredAt
          ? (a.eventId < b.eventId ? -1 : 1)
          : (a.occurredAt < b.occurredAt ? -1 : 1)))
        .slice(0, limit)
        .map(clone));
    },

    markPublished(eventIds, at, txh) {
      return write(txh, (st) => {
        const ts = toIso(at) ?? nowIso();
        for (const id of eventIds) {
          const e = st.outbox.get(id);
          if (e && e.publishedAt === null) e.publishedAt = ts;
        }
      });
    },

    recordFailure(eventId, error, txh) {
      // `error` is stringified below, so it needs no clone check; the id list does not.
      return write(txh, (st) => {
        const e = st.outbox.get(eventId);
        if (!e) throw new ApiError('NOT_FOUND', 'No such outbox event.', { details: { eventId } });
        e.attempts += 1;
        e.lastError = error === null || error === undefined ? null : String(error).slice(0, 2000);
      });
    },

    deadLetter(eventId, at, txh) {
      return write(txh, (st) => {
        const e = st.outbox.get(eventId);
        if (!e) throw new ApiError('NOT_FOUND', 'No such outbox event.', { details: { eventId } });
        e.deadLetteredAt = toIso(at) ?? nowIso();
      });
    },
  };

  /**
   * Append-only, structurally. There is no update and no delete on this object, and there is
   * no way to reach the stored row from outside: reads hand back clones. An audit table the
   * application can rewrite proves nothing about the application.
   */
  const audit = {
    insert(row, txh) {
      assertCloneable(row, 'audit_log row');
      return write(txh, (st) => {
        const rec = materialise({ auditId: row.auditId ?? newId(), ...row }, AUDIT_COLUMNS, 'audit_log');
        rec.createdAt = toIso(rec.createdAt) ?? nowIso();
        if (st.audit.has(rec.auditId)) throw new ApiError('CONFLICT', 'Audit row already exists.');
        st.audit.set(rec.auditId, rec);
        return clone(rec);
      });
    },

    list(filter = {}, txh) {
      return read(txh, (st) => {
        const { subjectKind, subjectId, actorId, action, limit = 100 } = filter;
        return [...st.audit.values()]
          .filter((r) => (subjectKind === undefined || r.subjectKind === subjectKind)
            && (subjectId === undefined || r.subjectId === subjectId)
            && (actorId === undefined || r.actorId === actorId)
            && (action === undefined || r.action === action))
          .sort((a, b) => (a.auditId < b.auditId ? -1 : 1))
          .slice(0, limit)
          .map(clone);
      });
    },
  };

  const idempotency = {
    get(k, actorId, txh) {
      return read(txh, (st) => clone(st.idempotency.get(key(k, actorId)) ?? null));
    },

    /**
     * First writer wins. A second `put` with the same key and a DIFFERENT request hash is the
     * dangerous case — the same key reused for a different request — and must be refused, not
     * silently overwritten, or a retry of request A can return the response to request B.
     */
    put(row, txh) {
      assertCloneable(row, 'idempotency_keys row');
      return write(txh, (st) => {
        const rec = materialise(row, IDEMPOTENCY_COLUMNS, 'idempotency_keys');
        rec.createdAt = toIso(rec.createdAt) ?? nowIso();
        rec.expiresAt = toIso(rec.expiresAt);
        const k = key(rec.key, rec.actorId);
        const cur = st.idempotency.get(k);
        if (cur) {
          if (cur.requestHash !== rec.requestHash) {
            throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'That idempotency key was used for a different request.', {
              details: { key: rec.key },
            });
          }
          return clone(cur);
        }
        st.idempotency.set(k, rec);
        return clone(rec);
      });
    },
  };

  const flags = {
    all(txh) {
      return read(txh, (st) => [...st.flags.values()].map(clone));
    },

    get(k, txh) {
      return read(txh, (st) => clone(st.flags.get(k) ?? null));
    },

    /** Same patch semantics as profiles: a present key sets, including to null; absent leaves. */
    set(k, patch, txh) {
      assertCloneable(patch, 'feature_flags patch');
      return write(txh, (st) => {
        const cur = st.flags.get(k);
        const next = {
          flagKey: k,
          enabled: cur?.enabled ?? false,
          rollout: cur?.rollout ?? null,
          isKillSwitch: cur?.isKillSwitch ?? false,
          updatedBy: cur?.updatedBy ?? null,
          createdAt: cur?.createdAt ?? nowIso(),
          updatedAt: nowIso(),
        };
        assertKnown(patch ?? {}, FLAG_COLUMNS, 'feature_flags');
        for (const f of Object.keys(patch ?? {})) {
          // enabled and is_kill_switch are NOT NULL. A null would mean "off" on Postgres by
          // way of a coalesce, and null here — two adapters, two answers to one patch.
          if ((f === 'enabled' || f === 'isKillSwitch') && typeof patch[f] !== 'boolean') {
            throw new ApiError('VALIDATION_FAILED', `feature_flags.${f} must be a boolean.`, {
              details: { table: 'feature_flags', column: f },
            });
          }
          next[f] = patch[f];
        }
        st.flags.set(k, next);
        return clone(next);
      });
    },
  };

  return {
    kind: 'memory',
    tx,
    accounts, sessions, refreshTokens, profiles, stats, weaponStats, matches,
    preAuthConsent, outbox, audit, idempotency, flags,
    async health() {
      return closed ? { ok: false, detail: 'closed' } : { ok: true, detail: 'memory' };
    },
    async close() {
      // Drain first: closing mid-transaction would strand a caller holding a handle.
      await chain;
      closed = true;
    },
    /** Test seam. Not part of the Store interface; nothing in src/ may use it. */
    _debugCounts() {
      return Object.fromEntries(Object.entries(live).map(([t, m]) => [t, m.size]));
    },
  };
}
