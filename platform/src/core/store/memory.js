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
import { ApiError } from '../errors.js';
import { ulid as defaultUlid } from '../ids.js';

/** Handles are tagged so a handle from another store (or a stray object) fails loudly. */
const TX = Symbol('overstrike.memtx');

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
    outbox: new Map(),
    audit: new Map(),
    idempotency: new Map(),
    flags: new Map(),
  };
}

/**
 * Columns, with their defaults. Also the allow-list: a key not named here is rejected rather
 * than stored, because Postgres would reject it too and a memory adapter that shrugs at
 * `displayname` or `birthdate` hides the bug until the first real deployment.
 *
 * `accounts` has no birthdate by design (db-schema.md §2) — the eligibility preflight
 * evaluates a date of birth and discards it. Trying to store one is an error here, on purpose.
 */
const ACCOUNT_COLUMNS = {
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
};

const ACCOUNT_TIMESTAMPS = [
  'nameChangedAt',
  'eligibilityDecidedAt', 'emailVerifiedAt', 'termsAcceptedAt', 'consentDecidedAt',
  'createdAt', 'updatedAt', 'deletedAt',
];

const SESSION_COLUMNS = {
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
};

const REFRESH_COLUMNS = {
  tokenId: undefined,
  familyId: undefined,
  accountId: undefined,
  sessionId: undefined,
  issuedAt: null,
  expiresAt: undefined,
  usedAt: null,
};

const OUTBOX_COLUMNS = {
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
};

const AUDIT_COLUMNS = {
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
};

const IDEMPOTENCY_COLUMNS = {
  key: undefined,
  actorId: undefined,
  requestHash: undefined,
  responseStatus: null,
  responseBody: null,
  createdAt: null,
  expiresAt: null,
};

/** Career counters. Anything not listed is not a stat, and a typo must not be swallowed. */
const STAT_COUNTERS = [
  'kills', 'deaths', 'assists', 'suicides', 'teamKills', 'headshots',
  'shotsFired', 'shotsHit', 'damageDealt', 'plants', 'defuses',
  'matches', 'wins', 'losses', 'draws', 'roundsPlayed', 'timePlayedSec',
];
const WEAPON_COUNTERS = ['shots', 'hits', 'kills', 'headshots'];

function assertKnown(row, columns, table) {
  for (const k of Object.keys(row)) {
    if (!(k in columns)) {
      throw new ApiError('VALIDATION_FAILED', `Unknown column for ${table}: ${k}`, {
        details: { table, column: k },
      });
    }
  }
}

/** Apply defaults, enforce not-null, reject unknown columns. One place, every table. */
function materialise(row, columns, table) {
  assertKnown(row, columns, table);
  const out = {};
  for (const [col, dflt] of Object.entries(columns)) {
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
    if (tx.done) throw new ApiError('INTERNAL_ERROR', 'Transaction handle used after the transaction ended.');
    return tx.state;
  }

  /** Reads need no lock: nothing awaits between lookup and return, so nothing can interleave. */
  function read(tx, fn) {
    assertOpen();
    const st = stateFor(tx);
    return Promise.resolve(fn(st ?? live));
  }

  /**
   * A standalone write is a one-statement transaction: it gets the same clone-and-publish
   * treatment so a method that throws halfway cannot leave a half-written row behind.
   */
  function write(tx, fn) {
    assertOpen();
    const st = stateFor(tx);
    if (st) return Promise.resolve(fn(st));   // already inside a transaction; it holds the lock
    return withLock(() => {
      const working = structuredClone(live);
      const out = fn(working);
      live = working;
      return out;
    });
  }

  async function tx(fn) {
    assertOpen();
    return withLock(async () => {
      const working = structuredClone(live);
      const handle = { [TX]: true, state: working, done: false };
      try {
        const out = await fn(handle);
        // Commit is one assignment. A reader can see the state before or after, never during.
        live = working;
        return out;
      } finally {
        // Rollback needs no undo log: the clone is simply never published.
        handle.done = true;
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
      return write(txh, (st) => {
        const cur = st.accounts.get(accountId);
        if (!cur) throw new ApiError('NOT_FOUND', 'No such account.', { details: { accountId } });
        assertKnown(patch, ACCOUNT_COLUMNS, 'accounts');
        if ('accountId' in patch && patch.accountId !== accountId) {
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

    revoke(sessionId, reason, at, txh) {
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
    upsert(accountId, patch, txh) {
      return write(txh, (st) => {
        requireAccount(st, accountId, 'profiles');
        const cur = st.profiles.get(accountId);
        const next = {
          accountId,
          roamingSettings: cur?.roamingSettings ?? null,
          settingsVersion: cur?.settingsVersion ?? 1,
          createdAt: cur?.createdAt ?? nowIso(),
          updatedAt: nowIso(),
        };
        for (const k of Object.keys(patch ?? {})) {
          if (!(k in next)) throw new ApiError('VALIDATION_FAILED', `Unknown column for profiles: ${k}`);
          if (k === 'accountId' || k === 'createdAt') continue;
          next[k] = patch[k];
        }
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
      return write(txh, (st) => {
        requireAccount(st, accountId, 'player_stats');
        for (const k of Object.keys(delta ?? {})) {
          if (!STAT_COUNTERS.includes(k)) {
            throw new ApiError('VALIDATION_FAILED', `Unknown stat counter: ${k}`, { details: { counter: k } });
          }
          if (!Number.isInteger(delta[k])) {
            throw new ApiError('VALIDATION_FAILED', `Stat delta ${k} must be an integer.`);
          }
        }
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
      return write(txh, (st) => {
        requireAccount(st, accountId, 'player_weapon_stats');
        for (const k of Object.keys(delta ?? {})) {
          if (!WEAPON_COUNTERS.includes(k)) {
            throw new ApiError('VALIDATION_FAILED', `Unknown weapon counter: ${k}`, { details: { counter: k } });
          }
        }
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

  const preAuthConsent = {
    put(row, txh) {
      return write(txh, (st) => {
        const allowed = {
          clientSessionId: undefined, telemetryPersonal: undefined, policyVersion: undefined,
          decidedAt: null, expiresAt: undefined, migratedAt: null,
        };
        const rec = materialise(row, allowed, 'pre_auth_consent');
        rec.decidedAt = toIso(rec.decidedAt) ?? nowIso();
        rec.expiresAt = toIso(rec.expiresAt);
        rec.migratedAt = toIso(rec.migratedAt);
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

    set(k, patch, txh) {
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
        for (const f of Object.keys(patch ?? {})) {
          if (!(f in next)) throw new ApiError('VALIDATION_FAILED', `Unknown column for feature_flags: ${f}`);
          if (f === 'flagKey' || f === 'createdAt') continue;
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
    accounts, sessions, refreshTokens, profiles, stats, weaponStats,
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
