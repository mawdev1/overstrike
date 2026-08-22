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
  assertMatchTransition, assertPageArgs, TERMINAL_MATCH_STATUSES,
  INITIAL_SETTINGS_VERSION, casMayCreateProfile, assertExpectedVersion, assertSweepInstant,
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
    accountNameHistory: new Map(),
    preAuthConsent: new Map(),
    sessions: new Map(),
    refreshTokens: new Map(),
    profiles: new Map(),
    stats: new Map(),
    weaponStats: new Map(),
    matches: new Map(),
    matchParticipants: new Map(),
    matchEvidence: new Map(),
    matchServers: new Map(),
    rooms: new Map(),
    roomMembers: new Map(),
    reports: new Map(),
    matchTickets: new Map(),
    chatMessages: new Map(),
    outbox: new Map(),
    audit: new Map(),
    idempotency: new Map(),
    flags: new Map(),
    settlementExceptions: new Map(),
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
  // PERSONAL class (migration 0019). Lookup and uniqueness go through `emailHash`; this is only
  // ever read to address transactional mail, and is projected into no API response.
  email: null,
  displayName: undefined,
  displayNameFolded: undefined,
  // Migration 0008. Null when identity is delegated to the provider (D1); roles default to
  // the one every account has, because an account with no roles can do nothing and is a bug
  // rather than a state we ever mean.
  passwordHash: null,
  identityProvider: null,
  identitySubject: null,
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

/**
 * `account_name_history` (migration 0001).  auth.md §9: the previous name is retained for
 * moderation and impersonation review.
 *
 * The table has existed since 0001 and had no accessor on either adapter, so nothing could
 * write it and nothing could read it — the retention auth.md §9 requires was a table and a
 * promise. `changed_at` is part of the primary key, so two rows for one account at the same
 * instant collide here exactly as they collide on Postgres.
 */
const NAME_HISTORY_COLUMNS = columns({
  accountId: undefined,
  previousName: undefined,
  changedAt: null,
  changedBy: null,
  reason: null,
  createdAt: null,
  updatedAt: null,
});

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
  settingsVersion: INITIAL_SETTINGS_VERSION,
});

/**
 * `settings_version` is NOT NULL integer (0003), so "present and null" and "present and a
 * string" are not operations it has. Shared by `upsert` and `upsertIfVersion` because the CAS
 * did not have it: it wrote `settingsVersion: "9"` and every later comparison then failed
 * against a version no caller could name.
 */
function assertProfileVersionPatch(patch) {
  if (patch && Object.hasOwn(patch, 'settingsVersion') && !Number.isInteger(patch.settingsVersion)) {
    throw new ApiError('VALIDATION_FAILED', 'profiles.settingsVersion must be an integer.', {
      details: { table: 'profiles', column: 'settingsVersion' },
    });
  }
}

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
    // EQUIVALENT MUTANT (mutatetest, 2026-08-20). Deleting this line changes no observable
    // behaviour: an object without the tag has no entry in `handleState` either, so the check
    // below raises the same INTERNAL_ERROR with the same message. `WeakMap.get` returns
    // `undefined` for a primitive rather than throwing, so a string or a number takes the same
    // path. It stays because the two checks answer different questions — "is this shaped like a
    // handle" and "is it one of MINE" — and collapsing them loses the first.
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

    identityReadiness(txh) {
      return read(txh, (st) => {
        let unreadyAccounts = 0;
        for (const account of st.accounts.values()) {
          if (account.deletedAt || account.status === 'deleted') continue;
          const ready = account.identityProvider === 'supabase'
            && typeof account.identitySubject === 'string' && account.identitySubject !== ''
            && account.passwordHash === null;
          if (!ready) unreadyAccounts++;
        }
        return { ok: unreadyAccounts === 0, unreadyAccounts };
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
        // `privacy` is NOT NULL DEFAULT '{}' (0001), so "present and null" is not an operation
        // it has. Postgres answered a null with a 23502 → VALIDATION_FAILED and this adapter
        // stored the null, which is the shape of divergence this file exists to prevent:
        // `normalizePrivacy` then read a null nobody could have written on the adapter that
        // ships. Clearing privacy is `{}`, and it has to be said.
        if (Object.hasOwn(patch, 'privacy') && patch.privacy === null) {
          throw new ApiError('VALIDATION_FAILED', 'accounts.privacy cannot be null.', {
            details: { table: 'accounts', column: 'privacy' },
          });
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
    /**
     * Advance `lastSeenAt`.  auth.md §5.
     *
     * The session list shows a player where their account has been used, which is how a
     * compromise is spotted. Without this the column held the creation time forever, so every
     * session looked equally fresh and the list answered a question it appeared to answer.
     */
    touch(sessionId, at, txh) {
      return write(txh, (st) => {
        const row = st.sessions.get(sessionId);
        if (!row) throw new ApiError('NOT_FOUND', 'No such session.');
        row.lastSeenAt = toIso(at) ?? nowIso();
      });
    },

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
        assertProfileVersionPatch(patch);
        for (const k of Object.keys(patch ?? {})) next[k] = patch[k];
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
     *
     * The ARGUMENT checks run before the comparison, and that ordering is contract (store.js
     * `assertExpectedVersion`). They used to run after it, so a typo'd column or a string
     * version came back as `null` — "your version moved, retry" — and the client retried a
     * request that could never succeed, forever.
     */
    upsertIfVersion(accountId, expectedVersion, patch, txh) {
      assertCloneable(patch, 'profiles patch');
      assertExpectedVersion(expectedVersion);
      assertKnown(patch ?? {}, PROFILE_COLUMNS, 'profiles');
      assertProfileVersionPatch(patch);
      return write(txh, (st) => {
        requireAccount(st, accountId, 'profiles');
        const cur = st.profiles.get(accountId);
        // Absence IS the initial version (store.js), so the first-ever write lands and a CAS
        // holding any other version finds nothing to match rather than inventing a row.
        //
        // EQUIVALENT MUTANT (mutatetest, 2026-08-20): deleting this line changes nothing here.
        // `casMayCreateProfile(v)` is `v === INITIAL_SETTINGS_VERSION`, and when `cur` is absent
        // `actual` IS `INITIAL_SETTINGS_VERSION` — so the two conditions are the same test and
        // the comparison two lines down returns null on exactly the same inputs. It is not
        // redundant on the POSTGRES adapter, where the same decision has to be made inside the
        // statement (`$9::boolean or exists (...)`) and cannot be left to a later comparison;
        // stating it here keeps the two adapters visibly answering one rule.
        if (!cur && !casMayCreateProfile(expectedVersion)) return null;
        const actual = cur?.settingsVersion ?? INITIAL_SETTINGS_VERSION;
        if (actual !== expectedVersion) return null;
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

  /** The participants of one match, in insertion order, as plain rows. */
  const participantsOf = (st, matchId) => [...st.matchParticipants.values()]
    .filter((p) => p.matchId === matchId);

  const matches = {
    activeForRoom(roomId, txh) {
      return read(txh, (st) => {
        const row = [...st.matches.values()].find((item) => item.roomId === roomId
          && ['allocated', 'in-progress'].includes(item.status));
        return row ? clone({ ...row, participants: participantsOf(st, row.matchId) }) : null;
      });
    },
    /**
     * Create the row, or advance an existing non-terminal one to its terminal result.
     *
     * The row is created at ALLOCATION (§4, db-schema.md §4), so by the time a result arrives
     * the row normally already exists. Treating that as CONFLICT meant no allocated match could
     * ever finalise — allocate, play, finalise is the documented lifecycle and it was the one
     * path this method refused. The transitions are MATCH_STATUS_TRANSITIONS in store.js so both
     * adapters permit exactly the same ones.
     *
     * What stays refused is a SECOND terminal write (§5.5): terminal states have no outgoing
     * edges, so a finalised match cannot be re-recorded with any result, identical or not.
     */
    record(result, txh) {
      assertCloneable(result, 'match result');
      const { match, participants } = normaliseMatchResult(result);
      return write(txh, (st) => {
        const prior = st.matches.get(match.matchId) ?? null;
        if (prior) assertMatchTransition(prior.status, match.status, match.matchId);

        const rec = {};
        for (const c of MATCH_COLUMNS) rec[c] = match[c] ?? null;
        for (const c of ['startedAt', 'endedAt']) rec[c] = toIso(rec[c]);
        if (prior) {
          // Allocation-time facts survive the finalise: `allocated_at` is when the id was
          // issued, and a result that omits `startedAt` must not erase the one the row has.
          rec.allocatedAt = prior.allocatedAt;
          rec.recordedAt = prior.recordedAt;
          rec.startedAt = rec.startedAt ?? prior.startedAt;
          rec.roomId = rec.roomId ?? prior.roomId;
          rec.serverId = rec.serverId ?? prior.serverId;
          // Never carried over from a caller: only markResultApplied writes it.
          rec.resultAppliedAt = prior.resultAppliedAt ?? null;
        } else {
          rec.allocatedAt = nowIso();
          rec.recordedAt = nowIso();
          rec.resultAppliedAt = null;
        }
        st.matches.set(rec.matchId, rec);
        for (const p of participants) {
          requireAccount(st, p.accountId, 'match_participants');
          const k = key(p.matchId, p.accountId);
          const before = st.matchParticipants.get(k);
          // Mirror the Postgres column default: `joined_at` is NOT NULL default now(), so an
          // omitted value is stamped rather than stored null. Memory storing null here is the
          // divergence that let the allocation path look healthy while Postgres rejected it.
          const prec = { ...p, joinedAt: toIso(p.joinedAt) ?? nowIso(), leftAt: toIso(p.leftAt) };
          // (match_id, account_id) is the primary key: a finalise updates the allocation row
          // rather than inserting a second one, and joinedAt stays the moment they actually
          // joined rather than being restamped by the result.
          if (before) prec.joinedAt = before.joinedAt ?? prec.joinedAt;
          st.matchParticipants.set(k, prec);
        }
        return {
          matchId: rec.matchId,
          status: rec.status,
          transitioned: prior ? prior.status : null,
          participants: participants.length,
        };
      });
    },

    /**
     * One match with its participants — what the §4.2 `GET /v1/matches/:matchId` projection
     * needs. `roster` is not a column: it is derived from `match_participants`, which is where
     * db-schema.md §4 puts it, so it cannot disagree with the participants it would duplicate.
     */
    byId(matchId, txh) {
      return read(txh, (st) => {
        const m = st.matches.get(matchId);
        if (!m) return null;
        return clone({ ...m, participants: participantsOf(st, matchId) });
      });
    },

    latestTerminalForRoom(roomId, txh) {
      return read(txh, (st) => {
        const rows = [...st.matches.values()].filter((m) => m.roomId === roomId
          && TERMINAL_MATCH_STATUSES.includes(m.status) && m.resultAppliedAt);
        rows.sort((a, b) => String(b.endedAt ?? b.matchId).localeCompare(String(a.endedAt ?? a.matchId)));
        const m = rows[0];
        return m ? clone({ ...m, participants: participantsOf(st, m.matchId) }) : null;
      });
    },

    /**
     * Stamp `matches.result_applied_at` (db-schema.md §4).
     *
     * The column existed and nothing ever wrote it, so "ended, queued" and "ended, career
     * applied" were the same row and §4.2 could not tell them apart. Written in the caller's
     * transaction — the same one that applies the career — because a stamp that can commit
     * without the application it records is a lie the recompute cannot detect.
     */
    markResultApplied(matchId, at, txh) {
      return write(txh, (st) => {
        const m = st.matches.get(matchId);
        if (!m) {
          throw new ApiError('NOT_FOUND', 'No such match.', { details: { matchId } });
        }
        if (!TERMINAL_MATCH_STATUSES.includes(m.status)) {
          throw new ApiError('CONFLICT', 'A match that has not finalised cannot have a result applied.', {
            details: { matchId, status: m.status, reason: 'not-terminal' },
          });
        }
        if (m.resultAppliedAt) {
          // Applying twice is what the §5 idempotency row exists to prevent; reaching here means
          // it did not, and the second application would double a career.
          throw new ApiError('CONFLICT', 'That result has already been applied.', {
            details: { matchId, resultAppliedAt: m.resultAppliedAt, reason: 'result-already-applied' },
          });
        }
        m.resultAppliedAt = toIso(at) ?? nowIso();
        return clone(m);
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
     *
     * `limit` and `cursor` are VALIDATED (http-api.md §10), not clamped: `limit=0` silently
     * becoming 25 and a malformed cursor silently becoming "from the top" answered a question
     * nobody asked and hid the paging bug that produced them.
     */
    listForAccount(accountId, page = {}, txh) {
      const { limit: size, cursor } = assertPageArgs(page);
      return read(txh, (st) => {
        const rows = [];
        for (const p of st.matchParticipants.values()) {
          if (p.accountId !== accountId) continue;
          if (cursor !== null && !(p.matchId < cursor)) continue;
          const m = st.matches.get(p.matchId);
          // UNREACHABLE, and therefore unkillable by any test (mutatetest, 2026-08-20). A
          // participant row is written only by `record`, in the same `write` that sets its
          // match row, and nothing on this adapter deletes from `st.matches` — so a participant
          // whose match is missing cannot be produced through the interface. It stays because
          // the alternative when the invariant does break is a TypeError inside a `sort`
          // comparator, which names neither the match nor the account.
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

    // ---------------------------------------------------------------- P3-04 settlement.md

    /**
     * A minimal run allocation. `deployment.md`'s admission-time write is the eventual real
     * producer of a `mode='extraction'` matches row (settlement.md §0's carried-forward
     * dependency); until that lands, this is the one way a caller — today, only this module's
     * own tests — can create one at all. Rejects a duplicate matchId rather than silently
     * reusing it, the same posture `record()` takes toward a second terminal write.
     */
    allocateRun({ matchId, region, mapId, mapVersion = null, serverId = null, roomId = null,
      serverBuild = null, participants = [] }, txh) {
      return write(txh, (st) => {
        if (st.matches.has(matchId)) {
          throw new ApiError('CONFLICT', `Run ${matchId} already exists.`, { details: { matchId } });
        }
        const now = nowIso();
        const values = {
          matchId, roomId, region, serverId, mapId, mapVersion, mode: 'extraction',
          rulesetVersion: null, statDefinitionVersion: null, serverBuild,
          status: 'in-progress', terminationReason: null, outcomeReason: null,
          invalidationReason: null, winnerTeam: null, rulesSnapshot: {},
          teamScores: null, rounds: null, evidenceRef: null, startedAt: now, endedAt: null,
        };
        const rec = {};
        for (const c of MATCH_COLUMNS) rec[c] = values[c] ?? null;
        rec.allocatedAt = now; rec.recordedAt = now; rec.resultAppliedAt = null; rec.updatedAt = now;
        st.matches.set(matchId, rec);
        for (const accountId of participants) {
          requireAccount(st, accountId, 'match_participants');
          st.matchParticipants.set(key(matchId, accountId), {
            matchId, accountId, team: null, joinedAt: now, leftAt: null,
            disconnected: false, abandoned: false, stats: {}, createdAt: now, updatedAt: now,
          });
        }
        return clone(rec);
      });
    },

    /**
     * settlement.md §5.2 — the run-terminal write. A run already at a terminal status is left
     * untouched (the pseudocode's own "no-op on replay; §5 rule 3 covers idempotency"), so a
     * retried submission never re-derives `started_at`/`ended_at` from a second payload.
     */
    transitionRunEnded(runId, { status, startedAt, endedAt }, txh) {
      return write(txh, (st) => {
        const m = st.matches.get(runId);
        if (!m) throw new ApiError('NOT_FOUND', 'No such run.', { details: { runId } });
        if (m.mode !== 'extraction') {
          throw new ApiError('VALIDATION_FAILED', 'transitionRunEnded is for mode=extraction rows only.', {
            details: { runId, mode: m.mode },
          });
        }
        if (TERMINAL_MATCH_STATUSES.includes(m.status)) return clone(m);
        m.status = status;
        m.startedAt = toIso(startedAt) ?? m.startedAt;
        m.endedAt = toIso(endedAt) ?? m.endedAt;
        m.updatedAt = nowIso();
        return clone(m);
      });
    },

    /**
     * §5.2's `settlementStatus: 'ended'` stamp — only where absent, for exactly the accounts
     * named in this submission. Returns the count actually stamped, so a caller can tell a
     * fresh submission from a pure replay without a second read.
     */
    markParticipantsEnded(matchId, accountIds, txh) {
      return write(txh, (st) => {
        let count = 0;
        for (const accountId of accountIds) {
          const p = st.matchParticipants.get(key(matchId, accountId));
          if (!p || p.stats?.settlementStatus) continue;   // missing row, or already past `ended`
          p.stats = { ...p.stats, settlementStatus: 'ended' };
          p.updatedAt = nowIso();
          count++;
        }
        return count;
      });
    },

    /** §6/§6.1's unconditional `stats = stats || jsonb_build_object(…)` merge. */
    mergeParticipantStats(matchId, accountId, patch, txh) {
      return write(txh, (st) => {
        const p = st.matchParticipants.get(key(matchId, accountId));
        if (!p) throw new ApiError('NOT_FOUND', 'No such match participant.', { details: { matchId, accountId } });
        p.stats = { ...p.stats, ...patch };
        p.updatedAt = nowIso();
        return clone(p);
      });
    },

    /** One participant's current stats, for the natural per-participant idempotency check. */
    getParticipant(matchId, accountId, txh) {
      return read(txh, (st) => clone(st.matchParticipants.get(key(matchId, accountId)) ?? null));
    },

    /** §7.2's stall-detector precondition set: terminal run, participant with no disposition yet. */
    listUnsettledRunParticipants(txh) {
      return read(txh, (st) => {
        const out = [];
        for (const p of st.matchParticipants.values()) {
          const m = st.matches.get(p.matchId);
          if (!m || m.mode !== 'extraction') continue;
          if (!['completed', 'aborted'].includes(m.status)) continue;
          if (p.stats?.settlementStatus) continue;
          out.push({ matchId: p.matchId, accountId: p.accountId, endedAt: m.endedAt });
        }
        return out;
      });
    },
  };

  const settlementExceptions = {
    /** §7.1's ambiguity triggers land here, whether opened by the endpoint or the stall detector. */
    open(row, txh) {
      return write(txh, (st) => {
        const exceptionId = row.exceptionId ?? newId();
        const now = nowIso();
        const rec = {
          exceptionId, runId: row.runId, accountId: row.accountId ?? null,
          trigger: row.trigger, status: 'open',
          openedAt: now, openedBy: row.openedBy,
          evidenceSnapshot: clone(row.evidenceSnapshot ?? {}),
          assignedTo: null, reviewedAt: null, reviewedBy: null,
          resolution: null, resolutionNotes: null, resolutionEvidenceRef: null,
          createdAt: now, updatedAt: now,
        };
        st.settlementExceptions.set(exceptionId, rec);
        return clone(rec);
      });
    },

    byId(exceptionId, txh) {
      return read(txh, (st) => clone(st.settlementExceptions.get(exceptionId) ?? null));
    },

    listByRun(runId, txh) {
      return read(txh, (st) => [...st.settlementExceptions.values()]
        .filter((e) => e.runId === runId).map(clone));
    },

    listOpenForParticipant(runId, accountId, txh) {
      return read(txh, (st) => [...st.settlementExceptions.values()]
        .filter((e) => e.runId === runId && e.accountId === accountId && e.status !== 'resolved')
        .map(clone));
    },

    /** settlement.md §7.4 step 2 — the queryable queue. Every filter optional, oldest first. */
    list({ status = null, runId = null, accountId = null, trigger = null } = {}, txh) {
      return read(txh, (st) => [...st.settlementExceptions.values()]
        .filter((e) => (status === null || e.status === status)
          && (runId === null || e.runId === runId)
          && (accountId === null || e.accountId === accountId)
          && (trigger === null || e.trigger === trigger))
        .sort((a, b) => a.openedAt.localeCompare(b.openedAt) || a.exceptionId.localeCompare(b.exceptionId))
        .map(clone));
    },

    /** §7.4 step 3 — optimistic-locked claim. Zero-row (returns null) means claimed/resolved since read. */
    claim({ exceptionId, operatorId, expectedUpdatedAt }, txh) {
      return write(txh, (st) => {
        const e = st.settlementExceptions.get(exceptionId);
        if (!e || e.status !== 'open' || e.updatedAt !== expectedUpdatedAt) return null;
        e.assignedTo = operatorId;
        e.status = 'in-review';
        e.updatedAt = nowIso();
        return clone(e);
      });
    },

    /**
     * §7.4 step 4/6 — the terminal write. `resolution`/`resolutionNotes` are the audit trail.
     *
     * Guarded by `status === 'in-review'`, the same optimistic-lock shape as `refreshTokens`'
     * `markUsed`: a second call for an already-resolved (or never-claimed) exception must not
     * silently re-run and clobber the first operator's audit trail with its own. This is the
     * DB-level backstop behind `resolveException`'s own read-then-check in the settlement
     * module — the one that actually holds under a genuine race the module's read can't see.
     */
    resolve({ exceptionId, resolution, resolutionNotes, resolutionEvidenceRef = null, reviewedBy }, txh) {
      return write(txh, (st) => {
        const e = st.settlementExceptions.get(exceptionId);
        if (!e) throw new ApiError('NOT_FOUND', 'No such settlement exception.', { details: { exceptionId } });
        if (e.status !== 'in-review') {
          throw new ApiError('CONFLICT', 'That exception is not in review (already resolved, or not yet claimed).', {
            details: { exceptionId, status: e.status },
          });
        }
        e.status = 'resolved';
        e.resolution = resolution;
        e.resolutionNotes = resolutionNotes;
        e.resolutionEvidenceRef = resolutionEvidenceRef;
        e.reviewedBy = reviewedBy;
        e.reviewedAt = nowIso();
        e.updatedAt = nowIso();
        return clone(e);
      });
    },
  };

  /**
   * The TTL clock is the store's INJECTED clock, not `Date.now()`.
   *
   * A read filter that calls `Date.now()` directly is not the path a test with a fake clock
   * exercises: the test advances its own clock past the 30 days, the adapter consults the wall
   * clock, and the "expiry proof" proves nothing about expiry. `deps.now` is the same clock
   * `nowIso` stamps rows with, so the row's `expires_at` and the instant it is compared
   * against come from one source.
   *
   * Used by every TTL in this adapter — pre-auth consent and idempotency keys — not consent
   * alone, which is what it was named for when consent was the only one.
   */
  const storeNowMs = () => {
    const t = deps.now ? deps.now() : Date.now();
    // EQUIVALENT MUTANT (mutatetest, 2026-08-20). Deleting this line changes no behaviour: a
    // Date falls through to `Number(t)`, and `Number(date)` is `date.valueOf()` which IS
    // `date.getTime()`. Measured over 200 000 random instants plus the epoch, the maximum
    // representable date and an invalid date: identical every time, `NaN` included. The line
    // stays because it names the shape rather than relying on a coercion, and `storetest.mjs`
    // exercises all three clock shapes against a real TTL instead.
    if (t instanceof Date) return t.getTime();
    return typeof t === 'string' ? Date.parse(t) : Number(t);
  };

  const preAuthConsent = {
    /**
     * `migratedAt` is not a column a caller may write, and nothing writes it any more: signup
     * DELETES the row rather than stamping it (`deleteFor`, §3a.3). Both adapters still force
     * it to null on write, so a row that arrives from a backfill or a hand-written statement
     * carrying a stamp cannot make a live decision read as already-carried and be ignored.
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

    /**
     * A 30-day TTL that only a sweep enforces is not a TTL: it is a row that stops being valid
     * at a time nothing checks. Expiry is decided on READ — and it DELETES.
     *
     * Filtering on read alone would answer correctly while leaving the record on disk past the
     * life http-api.md §3a.3 gives it. For a consent decision that is a retention breach, not
     * a stale read: the row is the evidence of a legally significant answer, and "we still
     * hold it, we just decline to look at it" is not deletion.
     */
    async get(clientSessionId, txh) {
      const row = await read(txh, (st) => st.preAuthConsent.get(clientSessionId) ?? null);
      if (!row) return null;
      if (!row.expiresAt || Date.parse(row.expiresAt) > storeNowMs()) return clone(row);

      // Re-check INSIDE the write, against the row as it is now.
      //
      // Deleting by key alone destroyed a decision recorded between the read and the write: a
      // GET interleaving with a PUT erased the player's just-recorded, legally significant
      // answer. Postgres was safe only because its `delete … and expires_at <= $2`
      // re-evaluates the predicate — this is the same guarantee, expressed the same way.
      await write(txh, (st) => {
        const cur = st.preAuthConsent.get(clientSessionId);
        if (!cur) return;
        if (!cur.expiresAt || Date.parse(cur.expiresAt) > storeNowMs()) return;   // refreshed
        st.preAuthConsent.delete(clientSessionId);
      });
      return null;
    },

    /**
     * The migration half of the §3a.3 lifecycle: "deleted on migration at signup, or on expiry".
     *
     * This used to be `markMigrated`, which stamped `migratedAt` and KEPT the row. Reads then
     * treated a stamped row as absent, so the decision was correctly ignored — and retained,
     * for the whole remainder of its 30-day TTL, as a standalone consent record keyed by a
     * client session, sitting beside the account it had already been copied onto. A record we
     * have decided to stop reading is not a record we have deleted, and §3a.3, db-schema.md §2
     * and migration 0001 all say signup deletes it.
     *
     * @returns {Promise<boolean>} whether a row was removed.
     */
    deleteFor(clientSessionId, txh) {
      return write(txh, (st) => st.preAuthConsent.delete(clientSessionId));
    },

    /**
     * Delete every expired row, whether or not anybody ever reads it again.  §3a.3.
     *
     * Expiry on read is enough to stop a stale decision being HONOURED, and it is not enough
     * to satisfy the 30-day retention limit: the rows that are never read again are exactly
     * the ones nobody deletes, and they are consent records — evidence of a legally
     * significant answer — sitting past the life the contract grants them. So there is also a
     * sweep, and something has to call it (auth/index.js runs it on an interval).
     *
     * @param at ISO string, Date or epoch ms; defaults to the store's injected clock.
     * @returns {Promise<number>} rows deleted, so a janitor can log or gauge it.
     */
    sweepExpired(at = null, txh) {
      // One rule for both adapters (store.js): Postgres read "yesterday" as a real instant.
      const cutoff = at === null || at === undefined ? storeNowMs() : assertSweepInstant(at);
      return write(txh, (st) => {
        let removed = 0;
        for (const [k, row] of st.preAuthConsent) {
          if (!row.expiresAt || Date.parse(row.expiresAt) > cutoff) continue;
          st.preAuthConsent.delete(k);
          removed += 1;
        }
        return removed;
      });
    },
  };

  /**
   * `account_name_history`.  auth.md §9, db-schema.md §2.
   *
   * Insert and list only. There is no update and no delete, for the same reason the audit log
   * has none: a name history the application can rewrite proves nothing in the impersonation
   * review it exists for. Correcting a wrong row is a new row, not an edit.
   */
  const accountNameHistory = {
    insert(row, txh) {
      assertCloneable(row, 'account_name_history row');
      return write(txh, (st) => {
        const rec = materialise(row, NAME_HISTORY_COLUMNS, 'account_name_history');
        // 0001 declares the foreign key; enforcing it here too is what keeps memory-green
        // meaningful about Postgres.
        requireAccount(st, rec.accountId, 'account_name_history');
        const ts = nowIso();
        rec.changedAt = toIso(rec.changedAt) ?? ts;
        rec.createdAt = toIso(rec.createdAt) ?? ts;
        rec.updatedAt = toIso(rec.updatedAt) ?? ts;
        const k = key(rec.accountId, rec.changedAt);
        if (st.accountNameHistory.has(k)) {
          throw new ApiError('CONFLICT', 'A name-history row already exists for that instant.', {
            details: { table: 'account_name_history', accountId: rec.accountId, changedAt: rec.changedAt },
          });
        }
        st.accountNameHistory.set(k, rec);
        return clone(rec);
      });
    },

    /** Newest first: a review starts from the name the subject is impersonating today. */
    listForAccount(accountId, { limit = 100 } = {}, txh) {
      return read(txh, (st) => [...st.accountNameHistory.values()]
        .filter((r) => r.accountId === accountId)
        .sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1))
        .slice(0, limit)
        .map(clone));
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

    list(filter = {}, txh) {
      const limit = Math.min(500, Math.max(1, Number(filter.limit) || 100));
      return read(txh, (st) => [...st.outbox.values()]
        .filter((row) => filter.correlationId === undefined
          || row.correlationId === filter.correlationId)
        .filter((row) => filter.subjectId === undefined || row.subjectId === filter.subjectId)
        .sort((a, b) => a.recordedAt === b.recordedAt
          ? (a.eventId < b.eventId ? -1 : 1) : (a.recordedAt < b.recordedAt ? -1 : 1))
        .slice(0, limit).map(clone));
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
      // A relay poll that claimed nothing publishes nothing, and that is the quiet normal case,
      // not an error. The Postgres adapter has said so since it was written; this one threw
      // `eventIds is not iterable` — so the two adapters answered an idle relay differently and
      // only one of them was running in production.
      if (!eventIds?.length) return Promise.resolve();
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
        const { subjectKind, subjectId, actorId, action, correlationId, limit = 100 } = filter;
        return [...st.audit.values()]
          .filter((r) => (subjectKind === undefined || r.subjectKind === subjectKind)
            && (subjectId === undefined || r.subjectId === subjectId)
            && (actorId === undefined || r.actorId === actorId)
            && (action === undefined || r.action === action)
            && (correlationId === undefined || r.correlationId === correlationId))
          .sort((a, b) => (a.auditId < b.auditId ? -1 : 1))
          .slice(0, limit)
          .map(clone);
      });
    },
  };

  const idempotency = {
    /**
     * No-op, deliberately.
     *
     * This adapter serialises every transaction through one lock, so work sharing an
     * idempotency key is already ordered. The method exists so the Postgres adapter — where
     * an advisory lock is genuinely required — is called through the same interface, rather
     * than the caller branching on which adapter it happens to hold.
     */
    async acquire() { /* transactions are globally serialised here */ },

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

    /**
     * §8 retention: "24 h for gameplay, permanent for value-bearing operations."
     *
     * Every writer stamped `expiresAt` and nothing ever deleted on it, so the retention the
     * contract declares was a field rather than a policy. A NULL `expiresAt` is the permanent
     * class and is never swept.
     *
     * Deliberately not paired with an expiry check in `get`, for the same reason the Postgres
     * adapter gives: honouring a row slightly past its window costs nothing, while refusing it
     * re-executes a write the client already believes happened.
     *
     * @param at ISO string, Date or epoch ms; defaults to the store's injected clock.
     * @returns {Promise<number>} rows deleted, so a janitor can log or gauge it.
     */
    sweepExpired(at = null, txh) {
      // One rule for both adapters (store.js): Postgres read "yesterday" as a real instant.
      const cutoff = at === null || at === undefined ? storeNowMs() : assertSweepInstant(at);
      return write(txh, (st) => {
        let removed = 0;
        for (const [k, row] of st.idempotency) {
          if (!row.expiresAt || Date.parse(row.expiresAt) > cutoff) continue;
          st.idempotency.delete(k);
          removed += 1;
        }
        return removed;
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

  const rooms = {
    upsert(row, txh) {
      assertCloneable(row, 'rooms row');
      return write(txh, (st) => {
        const prior = st.rooms.get(row.roomId);
        const rec = { ...prior, ...clone(row), createdAt: prior?.createdAt ?? row.createdAt ?? nowIso(), updatedAt: nowIso() };
        st.rooms.set(row.roomId, rec);
        return clone(rec);
      });
    },
    byId(roomId, txh) { return read(txh, (st) => clone(st.rooms.get(roomId) ?? null)); },
    list(txh) { return read(txh, (st) => [...st.rooms.values()].map(clone)); },
    remove(roomId, txh) { return write(txh, (st) => st.rooms.delete(roomId)); },
  };

  const roomMembers = {
    upsert(row, txh) {
      assertCloneable(row, 'room_members row');
      return write(txh, (st) => {
        if (!st.rooms.has(row.roomId)) throw new ApiError('ROOM_NOT_FOUND', 'That room no longer exists.');
        const k = key(row.roomId, row.accountId);
        const prior = st.roomMembers.get(k);
        const rec = { ...prior, ...clone(row), joinedAt: prior?.joinedAt ?? row.joinedAt ?? nowIso(), leftAt: row.leftAt ?? null, updatedAt: nowIso() };
        st.roomMembers.set(k, rec);
        return clone(rec);
      });
    },
    listForRoom(roomId, txh) { return read(txh, (st) => [...st.roomMembers.values()].filter((row) => row.roomId === roomId && !row.leftAt).map(clone)); },
    wasMemberAt(roomId, accountId, at, txh) {
      return read(txh, (st) => {
        const row = st.roomMembers.get(key(roomId, accountId));
        const time = Date.parse(at);
        return Boolean(row && Date.parse(row.joinedAt) <= time
          && (!row.leftAt || Date.parse(row.leftAt) >= time));
      });
    },
    recentFor(accountId, limit = 25, cursor = 0, txh) {
      return read(txh, (st) => {
        const roomIds = new Set([...st.roomMembers.values()]
          .filter((row) => row.accountId === accountId).map((row) => row.roomId));
        const latest = new Map();
        for (const row of st.roomMembers.values()) {
          if (!roomIds.has(row.roomId) || row.accountId === accountId) continue;
          const encounteredAt = row.leftAt || row.joinedAt;
          const prior = latest.get(row.accountId);
          if (!prior || Date.parse(encounteredAt) > Date.parse(prior.encounteredAt)) {
            latest.set(row.accountId, { accountId: row.accountId, encounteredAt });
          }
        }
        return [...latest.values()].sort((a, b) => Date.parse(b.encounteredAt) - Date.parse(a.encounteredAt)
          || a.accountId.localeCompare(b.accountId)).slice(cursor, cursor + limit).map(clone);
      });
    },
    remove(roomId, accountId, leftAt = nowIso(), txh) {
      return write(txh, (st) => {
        const k = key(roomId, accountId); const row = st.roomMembers.get(k);
        if (!row) return false; st.roomMembers.set(k, { ...row, leftAt: toIso(leftAt), updatedAt: nowIso() }); return true;
      });
    },
  };

  const reports = {
    create(row, txh) {
      assertCloneable(row, 'reports row');
      return write(txh, (st) => {
        for (const prior of st.reports.values()) {
          if (prior.reporterAccountId === row.reporterAccountId && prior.subjectAccountId === row.subjectAccountId
            && prior.matchId === (row.matchId ?? null)
            && prior.chatMessageId === (row.chatMessageId ?? null) && prior.category === row.category) {
            throw new ApiError('REPORT_DUPLICATE', 'You already reported this incident.');
          }
        }
        const rec = { ...clone(row), matchId: row.matchId ?? null, chatMessageId: row.chatMessageId ?? null,
          description: row.description ?? null, evidenceRef: row.evidenceRef ?? null,
          status: row.status ?? 'open', createdAt: row.createdAt ?? nowIso(), updatedAt: nowIso() };
        st.reports.set(rec.reportId, rec); return clone(rec);
      });
    },
  };

  const matchTickets = {
    put(row, txh) {
      assertCloneable(row, 'match ticket row');
      return write(txh, (st) => {
        if (st.matchTickets.has(row.jti)) throw new ApiError('CONFLICT', 'That match ticket exists.');
        const rec = { ...clone(row), consumedAt: null, createdAt: row.createdAt ?? nowIso() };
        st.matchTickets.set(rec.jti, rec); return clone(rec);
      });
    },
    consume(jti, claims, at = nowIso(), txh) {
      return write(txh, (st) => {
        const row = st.matchTickets.get(jti);
        if (!row || row.consumedAt || Date.parse(row.expiresAt) <= Date.parse(at)
          || row.accountId !== claims.accountId || row.roomId !== claims.roomId
          || row.matchId !== claims.matchId) return null;
        const next = { ...row, consumedAt: toIso(at) }; st.matchTickets.set(jti, next); return clone(next);
      });
    },
    byJti(jti, txh) { return read(txh, (st) => clone(st.matchTickets.get(jti))); },
    purgeExpired(at, txh) {
      const cutoff = Date.parse(at) - 24 * 60 * 60 * 1_000;
      return write(txh, (st) => { let count = 0; for (const [jti, row] of st.matchTickets) {
        if (Date.parse(row.expiresAt) > cutoff) continue; st.matchTickets.delete(jti); count++;
      } return count; });
    },
  };

  const chatMessages = {
    create(row, txh) {
      assertCloneable(row, 'chat message row');
      return write(txh, (st) => {
        if (st.chatMessages.has(row.messageId)) throw new ApiError('CONFLICT', 'That chat message exists.');
        const rec = { ...clone(row), createdAt: row.createdAt ?? nowIso(), removedAt: null,
          removedBy: null, removalReason: null };
        st.chatMessages.set(rec.messageId, rec); return clone(rec);
      });
    },
    byId(messageId, txh) { return read(txh, (st) => clone(st.chatMessages.get(messageId))); },
    listForRoom(roomId, limit = 50, at = nowIso(), txh) {
      return read(txh, (st) => [...st.chatMessages.values()].filter((row) => row.roomId === roomId
        && !row.removedAt && Date.parse(row.expiresAt) > Date.parse(at))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, limit).reverse().map(clone));
    },
    remove(messageId, actorId, reason, at, txh) {
      return write(txh, (st) => {
        const row = st.chatMessages.get(messageId);
        if (!row) throw new ApiError('NOT_FOUND', 'No such chat message.');
        if (!row.removedAt) Object.assign(row, { removedAt: toIso(at), removedBy: actorId, removalReason: reason });
        return clone(row);
      });
    },
    purgeExpired(at, txh) {
      return write(txh, (st) => {
        let count = 0;
        for (const [messageId, row] of st.chatMessages) {
          const atMs = Number(at instanceof Date ? at : new Date(at));
          const retainedByReport = [...st.reports.values()].some((report) => report.chatMessageId === messageId
            && (!report.resolvedAt || Date.parse(report.resolvedAt) + 30 * 86400e3 > atMs));
          if (!retainedByReport && Date.parse(row.expiresAt) <= atMs) {
            st.chatMessages.delete(messageId); count++;
          }
        }
        return count;
      });
    },
  };

  const matchEvidence = {
    put(row, txh) {
      assertCloneable(row, 'match evidence row');
      return write(txh, (st) => {
        if (st.matchEvidence.has(row.matchId)) {
          throw new ApiError('CONFLICT', 'Evidence for that match already exists.');
        }
        for (const prior of st.matchEvidence.values()) {
          if (prior.evidenceRef === row.evidenceRef) {
            throw new ApiError('CONFLICT', 'That evidence reference already exists.');
          }
        }
        const rec = { ...clone(row), createdAt: row.createdAt ?? nowIso() };
        st.matchEvidence.set(rec.matchId, rec);
        return clone(rec);
      });
    },
    byMatchId(matchId, txh) {
      return read(txh, (st) => clone(st.matchEvidence.get(matchId)));
    },
    byEvidenceRef(evidenceRef, txh) {
      return read(txh, (st) => {
        for (const row of st.matchEvidence.values()) {
          if (row.evidenceRef === evidenceRef) return clone(row);
        }
        return null;
      });
    },
  };

  const matchServers = {
    register(row, txh) {
      assertCloneable(row, 'match server row');
      return write(txh, (st) => {
        for (const other of st.matchServers.values()) {
          if (other.serverId !== row.serverId && other.address === row.address) {
            throw new ApiError('CONFLICT', 'That match-server address is already registered.');
          }
        }
        const prior = st.matchServers.get(row.serverId) || {};
        const exists = Object.hasOwn(prior, 'serverId');
        const rec = { ...prior, ...clone(row), inUse: exists ? prior.inUse : (row.inUse ?? 0),
          status: exists ? prior.status : (row.status ?? 'healthy'), lastHeartbeatAt: row.lastHeartbeatAt ?? nowIso(),
          createdAt: prior.createdAt ?? nowIso(), updatedAt: nowIso() };
        st.matchServers.set(rec.serverId, rec); return clone(rec);
      });
    },
    heartbeat(serverId, patch, txh) {
      return write(txh, (st) => {
        const prior = st.matchServers.get(serverId);
        if (!prior) throw new ApiError('NOT_FOUND', 'Match server is not registered.');
        Object.assign(prior, clone(patch), { inUse: Math.max(prior.inUse, patch.inUse),
          lastHeartbeatAt: patch.lastHeartbeatAt ?? nowIso(), updatedAt: nowIso() });
        return clone(prior);
      });
    },
    healthy(region, since, txh) {
      return read(txh, (st) => [...st.matchServers.values()]
        .filter((row) => row.region === region && row.status === 'healthy'
          && Date.parse(row.lastHeartbeatAt) >= Date.parse(since) && row.inUse < row.capacity)
        .sort((a, b) => a.inUse - b.inUse || a.serverId.localeCompare(b.serverId)).map(clone));
    },
    reserve(region, since, txh) {
      return write(txh, (st) => {
        const rows = [...st.matchServers.values()].filter((row) => row.region === region
          && row.status === 'healthy' && Date.parse(row.lastHeartbeatAt) >= Date.parse(since)
          && row.inUse < row.capacity)
          .sort((a, b) => a.inUse - b.inUse || a.serverId.localeCompare(b.serverId));
        const row = rows[0];
        if (!row) return null;
        row.inUse = row.capacity; row.updatedAt = nowIso(); return clone(row);
      });
    },
    release(serverId, txh) {
      return write(txh, (st) => {
        const row = st.matchServers.get(serverId);
        if (!row) return false;
        row.inUse = 0; row.updatedAt = nowIso(); return true;
      });
    },
    byId(serverId, txh) { return read(txh, (st) => clone(st.matchServers.get(serverId))); },
  };

  return {
    kind: 'memory',
    tx,
    accounts, accountNameHistory, sessions, refreshTokens, profiles, stats, weaponStats, matches,
    preAuthConsent, outbox, audit, idempotency, flags, rooms, roomMembers, reports, matchTickets, chatMessages,
    matchEvidence, matchServers, settlementExceptions,
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
