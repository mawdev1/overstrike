/**
 * Postgres Store adapter.  contracts/db-schema.md, core/store.js.
 *
 * The same interface as the memory adapter, over `pg` and nothing else. No ORM: the schema is
 * a contract document, and an ORM would put a second, generated description of it in the tree
 * for the two to disagree about.
 *
 * Three things are done here that a naive port of the memory adapter would get wrong:
 *
 *   1. `tx(fn)` takes ONE pooled client and runs every enrolled statement on it. A transaction
 *      spread across pooled connections is not a transaction; it is several, and the outbox
 *      guarantee dies quietly.
 *   2. Counter updates are `insert … on conflict do update set c = table.c + excluded.c`, done
 *      in the database. Read-modify-write in the application loses one of two match results
 *      that land in the same moment, and that is precisely when two results land.
 *   3. Driver errors are translated into contract codes at the boundary. A `23505` reaching a
 *      handler means the HTTP layer either leaks a Postgres string or returns 500 for what is
 *      a 409.
 *
 * Timestamps cross the interface as ISO strings, matching the memory adapter. `pg` returns
 * `Date`; code written against one adapter must not break on the other.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError } from '../errors.js';
import { ulid as defaultUlid } from '../ids.js';
import {
  STAT_COUNTERS, WEAPON_COUNTERS, STAT_DELTA_LIMITS, WEAPON_DELTA_LIMITS, assertCounterDelta,
  MATCH_COLUMNS, normaliseMatchResult, toHistoryMatchStatus, assertStorable,
  assertMatchTransition, assertPageArgs, TERMINAL_MATCH_STATUSES,
} from '../store.js';

const TX = Symbol('overstrike.pgtx');

/**
 * Handle state lives outside the handle, and reentrancy is tracked async-locally — same
 * reasoning as the memory adapter: a handle that carries its pg client hands every caller a
 * connection with which they can `commit`, `rollback`, or run any statement they like, and a
 * nested `tx` that grabs a second pooled connection is not nested at all, it is a second
 * transaction that can deadlock against the first.
 */
const handleState = new WeakMap();
const txContext = new AsyncLocalStorage();

const toSnake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/**
 * Per-table column allow-lists. Nothing reaches a statement that is not in one of these.
 *
 * `insertRow`/`updateRow` build column names from the KEYS of a caller-supplied object. Those
 * keys were pasted into SQL after `toSnake`, and `toSnake` is not an escape — it lower-cases
 * capitals and leaves everything else, quotes and all. So
 *
 *   accounts.update(id, { "status = 'banned', roles = '{admin}', display_name": 'x' })
 *
 * executed every clause in that key. Any surface that forwards a JSON body into a patch is
 * then a privilege-escalation endpoint. An allow-list is the fix rather than escaping, because
 * a column that is not in the schema has no business in a statement whether it is quotable
 * or not.
 */
const TABLE_COLUMNS = {
  accounts: [
    'accountId', 'status', 'emailHash', 'displayName', 'displayNameFolded',
    'passwordHash', 'roles', 'nameChangedAt',
    'eligibilityVerdict', 'eligibilityPolicyVer', 'eligibilityDecidedAt',
    'emailVerifiedAt', 'termsVersionAccepted', 'termsAcceptedAt',
    'consentTelemetry', 'consentPolicyVer', 'consentDecidedAt',
    'privacy', 'createdAt', 'updatedAt', 'deletedAt',
  ],
  sessions: [
    'sessionId', 'accountId', 'deviceLabel', 'userAgentClass', 'ipClass',
    'createdAt', 'lastSeenAt', 'revokedAt', 'revokedReason', 'refreshFamilyId', 'updatedAt',
  ],
  refresh_tokens: [
    'tokenId', 'familyId', 'accountId', 'sessionId', 'issuedAt', 'expiresAt', 'usedAt',
    'createdAt', 'updatedAt',
  ],
  events_outbox: [
    'eventId', 'eventType', 'eventVersion', 'subjectKind', 'subjectId',
    'correlationId', 'causationId', 'actor', 'payload', 'privacyClass', 'retentionClass',
    'schemaRef', 'occurredAt', 'recordedAt', 'publishedAt', 'attempts', 'lastError',
    'deadLetteredAt', 'createdAt', 'updatedAt',
  ],
  audit_log: [
    'auditId', 'actorKind', 'actorId', 'actorRole', 'action', 'subjectKind', 'subjectId',
    'reasonCode', 'beforeSummary', 'afterSummary', 'correlationId', 'createdAt',
  ],
  matches: MATCH_COLUMNS,
  match_participants: [
    'matchId', 'accountId', 'team', 'joinedAt', 'leftAt', 'disconnected', 'abandoned', 'stats',
  ],
};

/**
 * jsonb columns, by table. Their values are stringified before they reach the driver.
 *
 * `pg` renders a plain object as JSON but a JS ARRAY as a Postgres ARRAY LITERAL, so an array
 * bound for a jsonb column — `rounds`, a rollout list, a response body that happens to be a
 * list — arrives as '{"[object Object]"}'. Text bound to an untyped parameter is parsed by the
 * target column, so stringifying is correct for objects and arrays alike.
 */
const JSONB_COLUMNS = Object.assign(Object.create(null), {
  accounts: new Set(['privacy']),
  events_outbox: new Set(['actor', 'payload']),
  audit_log: new Set(['beforeSummary', 'afterSummary']),
  matches: new Set(['rulesSnapshot', 'teamScores', 'rounds']),
  match_participants: new Set(['stats']),
});

function encode(table, camelKey, value) {
  if (value === null || value === undefined) return value;
  if (!JSONB_COLUMNS[table]?.has(camelKey)) return value;
  // Checked BEFORE stringifying: JSON.stringify silently drops a function and throws on a
  // BigInt, so encoding first would turn "this value cannot be stored" into a quietly
  // truncated row — the same silent-discard failure the memory adapter refuses.
  assertStorable(value, `${table}.${camelKey}`);
  return JSON.stringify(value);
}

/** Null-prototype sets, so `constructor` and `__proto__` are not columns of every table. */
const ALLOWED = Object.assign(Object.create(null), Object.fromEntries(
  Object.entries(TABLE_COLUMNS).map(([t, cols]) => [t, new Set(cols)])));

/**
 * Resolve one caller-supplied key to a column name, or refuse.
 *
 * Belt and braces: the allow-list decides, and the shape check catches an allow-list entry
 * that was itself mistyped rather than trusting the table above to stay clean forever.
 */
function columnName(table, camelKey) {
  const allowed = ALLOWED[table];
  if (!allowed || !allowed.has(camelKey)) {
    throw new ApiError('VALIDATION_FAILED', `Unknown column for ${table}: ${camelKey}`, {
      details: { table, column: String(camelKey).slice(0, 64) },
    });
  }
  const col = toSnake(camelKey);
  if (!/^[a-z][a-z0-9_]*$/.test(col)) {
    throw new ApiError('VALIDATION_FAILED', `Unusable column name for ${table}`, { details: { table } });
  }
  return col;
}

function mapRow(row, numeric = []) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const camel = toCamel(k);
    out[camel] = v instanceof Date ? v.toISOString() : v;
    if (numeric.includes(camel) && out[camel] !== null) out[camel] = Number(out[camel]);
  }
  return out;
}

/**
 * Driver errors become contract errors here and nowhere else.
 * The constraint name is the only reliable way to tell "name taken" from "email taken" —
 * both are 23505, and guessing from the message text is a guess that breaks on a Postgres
 * upgrade.
 */
function translate(err) {
  if (err instanceof ApiError) return err;
  switch (err.code) {
    case '23505':
      if (String(err.constraint || '').includes('display_name_folded')) {
        return new ApiError('NAME_TAKEN', 'That display name is taken.');
      }
      return new ApiError('CONFLICT', 'That row already exists.', { cause: err });
    case '23503':
      return new ApiError('NOT_FOUND', 'A referenced row does not exist.', { cause: err });
    case '23502':   // not_null_violation
    case '23514':   // check_violation
    case '22P02':   // invalid_text_representation
    case '42703':   // undefined_column — an unknown field reached the adapter
      return new ApiError('VALIDATION_FAILED', 'The row does not satisfy the schema.', { cause: err });
    case '23001':   // restrict_violation — the audit_log append-only trigger
      return new ApiError('AUTH_FORBIDDEN', 'That table is append-only.', { cause: err });
    case '57014':
      return new ApiError('SERVICE_UNAVAILABLE', 'The database cancelled the statement.', { cause: err });
    default:
      return new ApiError('INTERNAL_ERROR', 'Database error.', { cause: err });
  }
}

export async function createPostgresStore(config = {}, deps = {}) {
  const databaseUrl = config.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('postgres store: DATABASE_URL is required');
  const newId = deps.ulid ?? defaultUlid;
  const logger = deps.logger ?? null;

  const pg = deps.pg ?? (await import('pg')).default;
  const pool = deps.pool ?? new pg.Pool({
    connectionString: databaseUrl,
    max: config.poolMax ?? 10,
    // A statement that has run for 30s inside a request is not going to save the request; it
    // is going to hold a connection while the client has already given up.
    statement_timeout: config.statementTimeoutMs ?? 30_000,
  });
  pool.on?.('error', (err) => logger?.error('store.pool.error', { message: err.message }));

  /** Identity of THIS store, so a handle from another instance is rejected rather than used. */
  const storeTag = Symbol('overstrike.pgstore');

  function entryOf(txh) {
    if (txh === undefined || txh === null) return null;
    if (!txh[TX]) throw new ApiError('INTERNAL_ERROR', 'Not a transaction handle from this store.');
    const entry = handleState.get(txh);
    if (!entry || entry.store !== storeTag) {
      throw new ApiError('INTERNAL_ERROR', 'Not a transaction handle from this store.');
    }
    if (entry.done) throw new ApiError('INTERNAL_ERROR', 'Transaction handle used after the transaction ended.');
    return entry;
  }

  /**
   * The connection a call should use: the explicit handle's, else the transaction ambient on
   * the async call stack, else the pool. store.js rule 4 — a call that omits the handle inside
   * `tx(fn)` means the transaction it is written inside, not a separate autocommit statement
   * that survives the rollback.
   */
  function entryFor(txh) {
    const explicit = entryOf(txh);
    if (explicit) return explicit;
    const ambient = txContext.getStore();
    if (ambient && ambient.store === storeTag && !ambient.done) return ambient;
    return null;
  }

  const inTransaction = (txh) => entryFor(txh) !== null;

  async function q(txh, sql, params = []) {
    // One chokepoint for every value that reaches the driver. `pg` does not refuse a Symbol or
    // a function — it stringifies them — so without this the same bad argument that the memory
    // adapter rejects would be stored here as the text "Symbol(x)".
    for (const p of params) assertStorable(p, 'query parameter');
    const entry = entryFor(txh);
    const target = entry ? entry.client : pool;
    try {
      return await target.query(sql, params);
    } catch (err) {
      throw translate(err);
    }
  }

  async function tx(fn) {
    const outer = txContext.getStore();
    // Reentrant: run on the outer transaction. Opening a second one would take a second
    // connection, and the two would then wait on each other's locks with the pool exhausted.
    // There are no savepoints, so an inner failure the outer swallows still commits.
    if (outer && outer.store === storeTag && !outer.done) return fn(outer.handle);

    const client = await pool.connect();
    const handle = Object.freeze({ [TX]: true });
    const entry = { store: storeTag, client, done: false, handle };
    handleState.set(handle, entry);
    try {
      await client.query('begin');
      const out = await txContext.run(entry, () => fn(handle));
      await client.query('commit');
      return out;
    } catch (err) {
      // Rollback is itself allowed to fail (a dead connection); the original error is what the
      // caller needs to see, so the rollback failure is logged and swallowed.
      try { await client.query('rollback'); } catch (rbErr) {
        logger?.error('store.rollback.failed', { message: rbErr.message });
      }
      throw translate(err);
    } finally {
      entry.done = true;
      client.release();
    }
  }

  /**
   * INSERT built from a camelCase object. Every column name is resolved through the table's
   * allow-list first, so a caller-supplied KEY cannot become SQL.
   */
  async function insertRow(txh, table, obj, { returning = '*', onConflict = '' } = {}) {
    const cols = Object.keys(obj).filter((k) => obj[k] !== undefined);
    const names = cols.map((c) => columnName(table, c));
    const sql = `insert into ${table} (${names.join(', ')}) `
      + `values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ${onConflict} `
      + (returning ? `returning ${returning}` : '');
    const { rows } = await q(txh, sql, cols.map((c) => encode(table, c, obj[c])));
    return rows[0] ?? null;
  }

  async function updateRow(txh, table, patch, where, whereValues, returning = '*') {
    const cols = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (!cols.length) return null;
    const sets = cols.map((c, i) => `${columnName(table, c)} = $${i + 1}`);
    const params = cols.map((c) => encode(table, c, patch[c])).concat(whereValues);
    const wh = where.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + cols.length}`);
    const { rows } = await q(txh, `update ${table} set ${sets.join(', ')} where ${wh} returning ${returning}`, params);
    return rows[0] ?? null;
  }

  const accounts = {
    async create(row, txh) {
      const rec = { accountId: row.accountId ?? newId(), ...row };
      // privacy is NOT NULL DEFAULT '{}'; passing an explicit null would violate it, and
      // "the caller did not mention privacy" must not mean "the caller cleared privacy".
      if (rec.privacy === undefined || rec.privacy === null) delete rec.privacy;
      return mapRow(await insertRow(txh, 'accounts', rec));
    },

    async byId(accountId, txh) {
      const { rows } = await q(txh, 'select * from accounts where account_id = $1', [accountId]);
      return mapRow(rows[0]);
    },

    async byEmailHash(hash, txh) {
      if (hash === null || hash === undefined) return null;
      const { rows } = await q(txh, 'select * from accounts where email_hash = $1', [hash]);
      return mapRow(rows[0]);
    },

    async byNameFolded(folded, txh) {
      const { rows } = await q(txh, 'select * from accounts where display_name_folded = $1', [folded]);
      return mapRow(rows[0]);
    },

    async update(accountId, patch, txh) {
      // account_id and created_at are immutable; updated_at belongs to the 0001 trigger, and
      // accepting one from the patch is a clock the caller writes. Same rule on both adapters.
      const { accountId: _ignored, createdAt: _ignored2, updatedAt: _ignored3, ...rest } = patch;
      const row = await updateRow(txh, 'accounts', rest, 'account_id = $1', [accountId]);
      if (!row) throw new ApiError('NOT_FOUND', 'No such account.', { details: { accountId } });
      return mapRow(row);
    },
  };

  const sessions = {
    async create(row, txh) {
      return mapRow(await insertRow(txh, 'sessions', { sessionId: row.sessionId ?? newId(), ...row }));
    },

    async byId(sessionId, txh) {
      const { rows } = await q(txh, 'select * from sessions where session_id = $1', [sessionId]);
      return mapRow(rows[0]);
    },

    async listForAccount(accountId, txh) {
      const { rows } = await q(txh,
        'select * from sessions where account_id = $1 order by session_id', [accountId]);
      return rows.map((r) => mapRow(r));
    },

    /**
     * `where revoked_at is null` keeps the first revocation's timestamp and reason, which is
     * the one that explains what happened; a re-stamp would overwrite it with the retry.
     *
     * Zero rows is therefore ambiguous — already revoked, or no such session — so it is
     * resolved rather than shrugged at. This adapter used to return silently either way, which
     * meant a mistyped session id looked exactly like a successful revocation on a security
     * path, while the memory adapter raised NOT_FOUND. NOT_FOUND is the behaviour both keep.
     */
    /** Advance `lastSeenAt`. auth.md §5 — see the memory adapter for why this must exist. */
    async touch(sessionId, at, txh) {
      const { rowCount } = await q(txh,
        'update sessions set last_seen_at = $2 where session_id = $1',
        [sessionId, at ?? new Date().toISOString()]);
      if (!rowCount) throw new ApiError('NOT_FOUND', 'No such session.');
    },

    async revoke(sessionId, reason, at, txh) {
      const { rowCount } = await q(txh,
        'update sessions set revoked_at = coalesce($2::timestamptz, now()), revoked_reason = $3 '
        + 'where session_id = $1 and revoked_at is null',
        [sessionId, at ?? null, reason ?? null]);
      if (rowCount === 0) {
        const { rows } = await q(txh, 'select 1 from sessions where session_id = $1', [sessionId]);
        if (!rows.length) throw new ApiError('NOT_FOUND', 'No such session.', { details: { sessionId } });
      }
    },

    async revokeAllForAccount(accountId, reason, at, txh) {
      const { rowCount } = await q(txh,
        'update sessions set revoked_at = coalesce($2::timestamptz, now()), revoked_reason = $3 '
        + 'where account_id = $1 and revoked_at is null',
        [accountId, at ?? null, reason ?? null]);
      return rowCount;
    },

    async revokeFamily(familyId, reason, at, txh) {
      const { rowCount } = await q(txh,
        'update sessions set revoked_at = coalesce($2::timestamptz, now()), revoked_reason = $3 '
        + 'where refresh_family_id = $1 and revoked_at is null',
        [familyId, at ?? null, reason ?? null]);
      // Burn the family's unused tokens in the same statement pair: a revoked session whose
      // refresh tokens still work is not a revoked session.
      await q(txh,
        'update refresh_tokens set used_at = coalesce($2::timestamptz, now()) where family_id = $1 and used_at is null',
        [familyId, at ?? null]);
      return rowCount;
    },
  };

  const refreshTokens = {
    async create(row, txh) {
      return mapRow(await insertRow(txh, 'refresh_tokens', { tokenId: row.tokenId ?? newId(), ...row }));
    },

    async byId(tokenId, txh) {
      const { rows } = await q(txh, 'select * from refresh_tokens where token_id = $1', [tokenId]);
      return mapRow(rows[0]);
    },

    async markUsed(tokenId, at, txh) {
      // The guarded update is the reuse detector: zero rows means it was already used, which
      // is the signal that revokes the family. Doing this as read-then-write races itself.
      const { rowCount } = await q(txh,
        'update refresh_tokens set used_at = coalesce($2::timestamptz, now()) where token_id = $1 and used_at is null',
        [tokenId, at ?? null]);
      if (rowCount === 0) {
        const { rows } = await q(txh, 'select token_id from refresh_tokens where token_id = $1', [tokenId]);
        if (!rows.length) throw new ApiError('NOT_FOUND', 'No such refresh token.', { details: { tokenId } });
        throw new ApiError('CONFLICT', 'Refresh token already used.', { details: { tokenId } });
      }
    },
  };

  const profiles = {
    /**
     * A key PRESENT in the patch sets the column, including to null; an absent key leaves it.
     *
     * This used to be `coalesce(excluded.x, profiles.x)`, under which null meant "leave it" —
     * so roaming settings could never be cleared, the clear-my-settings path silently did
     * nothing, and the memory adapter (which did clear) disagreed. The presence flags below
     * are what let one statement express both operations.
     */
    /**
     * Compare-and-set on `settings_version`.  http-api.md §11.2.
     *
     * The `where profiles.settings_version = $8` on the conflict branch is the whole point:
     * the comparison happens IN the statement that writes, so two concurrent If-Match writers
     * cannot both win. A read-then-write in application code — even inside a transaction —
     * lets both read the same version under READ COMMITTED and both proceed.
     *
     * Zero rows back means the version moved; the caller raises CONFLICT with current state.
     */
    async upsertIfVersion(accountId, expectedVersion, patch, txh) {
      const p = patch ?? {};
      for (const k of Object.keys(p)) {
        if (!['roamingSettings', 'legacyImport', 'settingsVersion'].includes(k)) {
          throw new ApiError('VALIDATION_FAILED', `Unknown column for profiles: ${k}`, {
            details: { table: 'profiles', column: k },
          });
        }
      }
      if (!Number.isInteger(expectedVersion)) {
        throw new ApiError('VALIDATION_FAILED', 'expectedVersion must be an integer.');
      }
      const hasRoaming = Object.hasOwn(p, 'roamingSettings');
      const hasLegacy = Object.hasOwn(p, 'legacyImport');
      const hasVersion = Object.hasOwn(p, 'settingsVersion');
      if (hasVersion && !Number.isInteger(p.settingsVersion)) {
        throw new ApiError('VALIDATION_FAILED', 'profiles.settingsVersion must be an integer.', {
          details: { table: 'profiles', column: 'settingsVersion' },
        });
      }
      const { rows } = await q(txh,
        `insert into profiles (account_id, roaming_settings, settings_version, legacy_import)
         values ($1, $2::jsonb, coalesce($3::int, 1), $4::jsonb)
         on conflict (account_id) do update set
           roaming_settings = case when $5::boolean then $2::jsonb else profiles.roaming_settings end,
           legacy_import    = case when $6::boolean then $4::jsonb else profiles.legacy_import end,
           settings_version = case when $7::boolean then $3::int   else profiles.settings_version end,
           updated_at = now()
         where profiles.settings_version = $8::int
         returning *`,
        [accountId,
          hasRoaming && p.roamingSettings != null ? JSON.stringify(p.roamingSettings) : null,
          hasVersion ? p.settingsVersion : null,
          hasLegacy && p.legacyImport != null ? JSON.stringify(p.legacyImport) : null,
          hasRoaming, hasLegacy, hasVersion, expectedVersion]);
      // A brand-new row inserts (no conflict) and is correct only when the caller expected the
      // initial version; otherwise it would create a row the caller did not think existed.
      if (!rows[0]) return null;
      return mapRow(rows[0]);
    },

    async upsert(accountId, patch, txh) {
      const p = patch ?? {};
      const hasRoaming = Object.hasOwn(p, 'roamingSettings');
      const hasLegacy = Object.hasOwn(p, 'legacyImport');
      const hasVersion = Object.hasOwn(p, 'settingsVersion');
      for (const k of Object.keys(p)) {
        if (!['roamingSettings', 'legacyImport', 'settingsVersion'].includes(k)) {
          throw new ApiError('VALIDATION_FAILED', `Unknown column for profiles: ${k}`, {
            details: { table: 'profiles', column: k },
          });
        }
      }
      // settings_version is NOT NULL, so "present and null" is not an operation it has.
      if (hasVersion && !Number.isInteger(p.settingsVersion)) {
        throw new ApiError('VALIDATION_FAILED', 'profiles.settingsVersion must be an integer.', {
          details: { table: 'profiles', column: 'settingsVersion' },
        });
      }
      const { rows } = await q(txh,
        `insert into profiles (account_id, roaming_settings, settings_version, legacy_import)
         values ($1, $2::jsonb, coalesce($3::int, 1), $4::jsonb)
         on conflict (account_id) do update set
           roaming_settings = case when $5::boolean then $2::jsonb else profiles.roaming_settings end,
           legacy_import    = case when $6::boolean then $4::jsonb else profiles.legacy_import end,
           settings_version = case when $7::boolean then $3::int   else profiles.settings_version end,
           updated_at = now()
         returning *`,
        [accountId,
          hasRoaming && p.roamingSettings != null ? JSON.stringify(p.roamingSettings) : null,
          hasVersion ? p.settingsVersion : null,
          hasLegacy && p.legacyImport != null ? JSON.stringify(p.legacyImport) : null,
          hasRoaming, hasLegacy, hasVersion]);
      return mapRow(rows[0]);
    },

    async byAccountId(accountId, txh) {
      const { rows } = await q(txh, 'select * from profiles where account_id = $1', [accountId]);
      return mapRow(rows[0]);
    },
  };

  const stats = {
    async get(accountId, mode, statDefinitionVersion, txh) {
      const { rows } = await q(txh,
        'select * from player_stats where account_id = $1 and mode = $2 and stat_definition_version = $3',
        [accountId, mode, statDefinitionVersion]);
      return mapRow(rows[0], STAT_COUNTERS);
    },

    /**
     * Additive, in one statement. The addition happens in the database so two match results
     * applied concurrently both land — an application-side read, add, write drops one of them,
     * and the losing match is a player's kills that silently never existed.
     */
    async applyDelta(accountId, mode, statDefinitionVersion, delta, txh) {
      assertCounterDelta(delta, STAT_COUNTERS, STAT_DELTA_LIMITS, 'player_stats');
      const cols = STAT_COUNTERS.map(toSnake);
      const values = STAT_COUNTERS.map((c) => delta?.[c] ?? 0);
      const { rows } = await q(txh,
        `insert into player_stats (account_id, mode, stat_definition_version, ${cols.join(', ')})
         values ($1, $2, $3, ${cols.map((_, i) => `$${i + 4}`).join(', ')})
         on conflict (account_id, mode, stat_definition_version) do update set
           ${cols.map((c) => `${c} = player_stats.${c} + excluded.${c}`).join(',\n           ')},
           updated_at = now()
         returning *`,
        [accountId, mode, statDefinitionVersion, ...values]);
      return mapRow(rows[0], STAT_COUNTERS);
    },

    async listForAccount(accountId, txh) {
      const { rows } = await q(txh,
        'select * from player_stats where account_id = $1 order by mode, stat_definition_version',
        [accountId]);
      return rows.map((r) => mapRow(r, STAT_COUNTERS));
    },
  };

  const weaponStats = {
    async applyDelta(accountId, mode, weaponId, statDefinitionVersion, delta, txh) {
      assertCounterDelta(delta, WEAPON_COUNTERS, WEAPON_DELTA_LIMITS, 'player_weapon_stats');
      const cols = WEAPON_COUNTERS.map(toSnake);
      const values = WEAPON_COUNTERS.map((c) => delta?.[c] ?? 0);
      const { rows } = await q(txh,
        `insert into player_weapon_stats
           (account_id, mode, weapon_id, stat_definition_version, ${cols.join(', ')})
         values ($1, $2, $3, $4, ${cols.map((_, i) => `$${i + 5}`).join(', ')})
         on conflict (account_id, mode, weapon_id, stat_definition_version) do update set
           ${cols.map((c) => `${c} = player_weapon_stats.${c} + excluded.${c}`).join(',\n           ')},
           updated_at = now()
         returning *`,
        [accountId, mode, weaponId, statDefinitionVersion, ...values]);
      return mapRow(rows[0], WEAPON_COUNTERS);
    },

    async listForAccount(accountId, mode, txh) {
      const { rows } = mode === undefined
        ? await q(txh, 'select * from player_weapon_stats where account_id = $1 order by mode, weapon_id', [accountId])
        : await q(txh, 'select * from player_weapon_stats where account_id = $1 and mode = $2 order by weapon_id',
          [accountId, mode]);
      return rows.map((r) => mapRow(r, WEAPON_COUNTERS));
    },
  };

  /** The columns listForAccount reads, named explicitly: `m.*, p.*` collides on match_id. */
  const MATCH_SELECT = MATCH_COLUMNS.map((c) => `m.${toSnake(c)}`).join(', ');

  const matches = {
    /**
     * The match row and its participants, in ONE transaction — creating the row, or advancing an
     * existing non-terminal one to its terminal result.
     *
     * Rows are created at ALLOCATION (db-schema.md §4), so "the row exists" is the normal state
     * when a result arrives; refusing it as CONFLICT made finalising an allocated match
     * impossible. The permitted edges are MATCH_STATUS_TRANSITIONS in store.js, shared with the
     * memory adapter so a lifecycle legal on one is legal on the other.
     *
     * A second TERMINAL write is still CONFLICT (§5.5): terminal statuses have no outgoing edges.
     */
    async record(result, txh) {
      const { match, participants } = normaliseMatchResult(result);
      const run = async (t) => {
        // `for update` and not a bare select: two concurrent submissions for one match would
        // otherwise both read "allocated", both pass the transition check, and both finalise.
        const { rows } = await q(t,
          'select status from matches where match_id = $1 for update', [match.matchId]);
        const prior = rows[0] ?? null;
        if (prior) {
          assertMatchTransition(prior.status, match.status, match.matchId);
          // result_applied_at is not in `match` — only markResultApplied writes it — and the
          // allocation-time columns (allocated_at, room_id, server_id) are left alone unless the
          // result actually carries a replacement.
          const patch = { ...match };
          delete patch.matchId;
          for (const k of ['roomId', 'serverId', 'startedAt']) {
            if (patch[k] === null || patch[k] === undefined) delete patch[k];
          }
          await updateRow(t, 'matches', patch, 'match_id = $1', [match.matchId], 'match_id');
        } else {
          // insertRow encodes the jsonb columns (JSONB_COLUMNS): `rounds` is an array, and an
          // array reaches Postgres as an array literal unless it is stringified first.
          await insertRow(t, 'matches', match, { returning: '' });
        }
        for (const p of participants) {
          // The allocation may already hold this participant; the result updates it rather than
          // colliding with the (match_id, account_id) primary key. joined_at is excluded from
          // the update so the moment they joined is not restamped by the result.
          await insertRow(t, 'match_participants', p, {
            returning: '',
            onConflict: 'on conflict (match_id, account_id) do update set '
              + 'team = excluded.team, left_at = excluded.left_at, '
              + 'disconnected = excluded.disconnected, abandoned = excluded.abandoned, '
              + 'stats = excluded.stats',
          });
        }
        return {
          matchId: match.matchId,
          status: match.status,
          transitioned: prior ? prior.status : null,
          participants: participants.length,
        };
      };
      // Already enrolled (the result submission path holds a transaction, §5.3); otherwise open
      // one, because the row and its participants must not land separately.
      return inTransaction(txh) ? run(txh) : tx((t) => run(t));
    },

    /**
     * One match with its participants — the §4.2 `GET /v1/matches/:matchId` projection.
     * `roster` is derived from `match_participants` rather than stored twice; db-schema.md §4
     * has no roster column, and two copies of a roster is two rosters that can disagree.
     */
    async byId(matchId, txh) {
      const { rows } = await q(txh, 'select * from matches where match_id = $1', [matchId]);
      if (!rows.length) return null;
      const m = mapRow(rows[0]);
      const { rows: parts } = await q(txh,
        `select account_id, team, joined_at, left_at, disconnected, abandoned, stats
           from match_participants where match_id = $1 order by joined_at, account_id`,
        [matchId]);
      m.participants = parts.map((p) => ({ ...mapRow(p), matchId }));
      return m;
    },

    /**
     * Stamp `matches.result_applied_at` (db-schema.md §4) in the caller's transaction.
     *
     * The column was declared and never written, so nothing could distinguish a match that ended
     * from one whose career application committed — which is exactly the question §4.2 and §5
     * ask. The update is conditional on the row still being unapplied, so a second application
     * loses the race rather than doubling a career.
     */
    async markResultApplied(matchId, at, txh) {
      const stamp = at ?? new Date().toISOString();
      const { rows } = await q(txh,
        `update matches set result_applied_at = $2::timestamptz
          where match_id = $1 and result_applied_at is null
            and status in ('completed','aborted','invalidated')
        returning *`, [matchId, stamp]);
      if (rows.length) return mapRow(rows[0]);

      const { rows: current } = await q(txh, 'select status, result_applied_at from matches where match_id = $1', [matchId]);
      if (!current.length) {
        throw new ApiError('NOT_FOUND', 'No such match.', { details: { matchId } });
      }
      if (current[0].result_applied_at) {
        throw new ApiError('CONFLICT', 'That result has already been applied.', {
          details: { matchId, reason: 'result-already-applied' },
        });
      }
      throw new ApiError('CONFLICT', 'A match that has not finalised cannot have a result applied.', {
        details: { matchId, status: current[0].status, reason: 'not-terminal' },
      });
    },

    /**
     * History, newest first, cursor-paginated.
     *
     * Ordered by match id descending rather than ended_at: ids are ULIDs assigned at allocation
     * (0004) so they are already chronological, they are unique, and they are not null on a
     * match that never ended — ordering on ended_at would collapse every live match into one
     * null bucket and make the cursor ambiguous there. `match_participants_account_idx` serves
     * the account predicate; the sort is over one account's matches, not the table.
     *
     * `limit` and `cursor` are VALIDATED (http-api.md §10), not clamped — the same shared check
     * the memory adapter runs, so a page argument refused on one adapter is refused on both.
     */
    async listForAccount(accountId, pageArgs = {}, txh) {
      const { limit: size, cursor } = assertPageArgs(pageArgs);
      const { rows } = await q(txh,
        `select ${MATCH_SELECT},
                p.team as p_team, p.joined_at as p_joined_at, p.left_at as p_left_at,
                p.disconnected as p_disconnected, p.abandoned as p_abandoned, p.stats as p_stats
           from match_participants p
           join matches m on m.match_id = p.match_id
          where p.account_id = $1
            and ($2::text is null or p.match_id < $2::text)
          order by p.match_id desc
          limit $3`,
        [accountId, cursor, size + 1]);              // +1 answers "is there another page"

      const page = rows.slice(0, size);
      const items = page.map((r) => {
        const m = mapRow(Object.fromEntries(
          Object.entries(r).filter(([k]) => !k.startsWith('p_'))));
        m.status = toHistoryMatchStatus(m.status);
        m.participant = {
          team: r.p_team,
          joinedAt: r.p_joined_at instanceof Date ? r.p_joined_at.toISOString() : r.p_joined_at,
          leftAt: r.p_left_at instanceof Date ? r.p_left_at.toISOString() : r.p_left_at,
          disconnected: r.p_disconnected,
          abandoned: r.p_abandoned,
          stats: r.p_stats,
        };
        return m;
      });
      return {
        items,
        // Null unless a further row actually exists: a cursor on the last page sends the caller
        // round again for nothing, and recomputeCareer loops on it.
        nextCursor: rows.length > size ? page[page.length - 1].match_id : null,
      };
    },
  };

  /**
   * The TTL clock is the store's INJECTED clock, not `now()` in the statement.
   *
   * Both adapters have to answer the same question at the same instant or a fake-clock test
   * proves nothing about the adapter that ships. `deps.now` is that instant; falling back to
   * the process clock when nothing is injected keeps production behaviour unchanged.
   */
  const consentNowIso = () => {
    const t = deps.now ? deps.now() : Date.now();
    if (t instanceof Date) return t.toISOString();
    return typeof t === 'string' ? t : new Date(Number(t)).toISOString();
  };

  const preAuthConsent = {
    /**
     * A new decision RESETS migrated_at. Leaving it set — which this adapter used to do — is a
     * receipt claiming the NEW decision has already been carried onto an account, when what was
     * migrated was the old one. A consent record that is not true is worse than none.
     */
    async put(row, txh) {
      const { rows } = await q(txh,
        `insert into pre_auth_consent
           (client_session_id, telemetry_personal, policy_version, decided_at, expires_at)
         values ($1, $2, $3, coalesce($4::timestamptz, now()), $5)
         on conflict (client_session_id) do update set
           telemetry_personal = excluded.telemetry_personal,
           policy_version = excluded.policy_version,
           decided_at = excluded.decided_at,
           expires_at = excluded.expires_at,
           migrated_at = null,
           updated_at = now()
         returning *`,
        [row.clientSessionId, row.telemetryPersonal, row.policyVersion, row.decidedAt ?? null, row.expiresAt]);
      return mapRow(rows[0]);
    },

    /**
     * Expiry is enforced on READ, and it DELETES. This adapter had no expiry check at all, so
     * a decision older than the 30 days http-api.md §3a.3 grants it was still returned — and
     * still stored. Both halves matter: the stale row was honoured as a live consent, and it
     * outlived the retention the contract promises.
     *
     * Two statements rather than a data-modifying CTE: the main query of a `with … delete`
     * runs against the same snapshot, so it would return the row the CTE just removed.
     */
    async get(clientSessionId, txh) {
      await q(txh,
        'delete from pre_auth_consent where client_session_id = $1 and expires_at <= $2::timestamptz',
        [clientSessionId, consentNowIso()]);
      const { rows } = await q(txh,
        'select * from pre_auth_consent where client_session_id = $1', [clientSessionId]);
      return mapRow(rows[0]);
    },

    async markMigrated(clientSessionId, at, txh) {
      const { rowCount } = await q(txh,
        'update pre_auth_consent set migrated_at = coalesce($2::timestamptz, now()) where client_session_id = $1',
        [clientSessionId, at ?? null]);
      if (rowCount === 0) throw new ApiError('NOT_FOUND', 'No pre-auth consent for that client session.');
    },
  };

  const outbox = {
    async insert(event, txh) {
      const rec = { eventId: event.eventId ?? newId(), ...event };
      for (const k of ['payload', 'privacyClass', 'retentionClass', 'eventVersion']) {
        if (rec[k] === undefined || rec[k] === null) delete rec[k];   // let the column defaults apply
      }
      return mapRow(await insertRow(txh, 'events_outbox', rec));
    },

    /**
     * FOR UPDATE SKIP LOCKED is what lets several relay workers run at once: each claims a
     * disjoint set instead of every worker fighting over the same head of the queue and
     * publishing the same event N times. It requires a transaction, so outside one this
     * degrades to a plain read and the caller gets no exclusivity — which is correct for a
     * single-relay deployment and must not be relied on for more.
     */
    async claimUnpublished(limit = 100, txh) {
      const lock = inTransaction(txh) ? 'for update skip locked' : '';
      const { rows } = await q(txh,
        `select * from events_outbox
          where published_at is null and dead_lettered_at is null
          order by occurred_at, event_id
          limit $1 ${lock}`,
        [limit]);
      return rows.map((r) => mapRow(r));
    },

    async markPublished(eventIds, at, txh) {
      if (!eventIds?.length) return;
      await q(txh,
        'update events_outbox set published_at = coalesce($2::timestamptz, now()) '
        + 'where event_id = any($1::text[]) and published_at is null',
        [eventIds, at ?? null]);
    },

    async recordFailure(eventId, error, txh) {
      const { rowCount } = await q(txh,
        'update events_outbox set attempts = attempts + 1, last_error = $2 where event_id = $1',
        [eventId, error === null || error === undefined ? null : String(error).slice(0, 2000)]);
      if (rowCount === 0) throw new ApiError('NOT_FOUND', 'No such outbox event.', { details: { eventId } });
    },

    async deadLetter(eventId, at, txh) {
      const { rowCount } = await q(txh,
        'update events_outbox set dead_lettered_at = coalesce($2::timestamptz, now()) where event_id = $1',
        [eventId, at ?? null]);
      if (rowCount === 0) throw new ApiError('NOT_FOUND', 'No such outbox event.', { details: { eventId } });
    },
  };

  /** Insert and select only. Migration 0007 makes that true at the database level as well. */
  const audit = {
    async insert(row, txh) {
      return mapRow(await insertRow(txh, 'audit_log', { auditId: row.auditId ?? newId(), ...row }));
    },

    async list(filter = {}, txh) {
      const where = [];
      const params = [];
      for (const [field, col] of [['subjectKind', 'subject_kind'], ['subjectId', 'subject_id'],
        ['actorId', 'actor_id'], ['action', 'action']]) {
        if (filter[field] !== undefined) { params.push(filter[field]); where.push(`${col} = $${params.length}`); }
      }
      params.push(filter.limit ?? 100);
      const { rows } = await q(txh,
        `select * from audit_log ${where.length ? `where ${where.join(' and ')}` : ''} `
        + `order by audit_id limit $${params.length}`, params);
      return rows.map((r) => mapRow(r));
    },
  };

  const idempotency = {
    /**
     * Serialise everything that shares one idempotency key, for the life of the transaction.
     *
     * `select … for update` cannot do this: the row does not exist yet on the first attempt,
     * and a lock on no row is no lock. Ten concurrent identical submissions therefore all read
     * `prior = null`, all proceeded, and nine collided on the matches primary key — so a
     * correct retry got CONFLICT, whose contracted meaning (§5.5) is "already finalised with a
     * DIFFERENT result". A retrying match server was told its own correct retry was a
     * disagreement.
     *
     * An advisory lock is transaction-scoped and needs no row to exist. It is released at
     * commit or rollback, so a crash cannot strand it.
     */
    async acquire(key, actorId, txh) {
      if (!inTransaction(txh)) return;      // nothing to serialise against outside a tx
      await q(txh, 'select pg_advisory_xact_lock(hashtextextended($1, 0))', [`${actorId}:${key}`]);
    },

    async get(key, actorId, txh) {
      const { rows } = await q(txh,
        'select * from idempotency_keys where key = $1 and actor_id = $2', [key, actorId]);
      return mapRow(rows[0]);
    },

    /**
     * First writer wins, and a second put under the same key with a DIFFERENT request hash is
     * refused. Overwriting would let a retry of request A return the response to request B,
     * which is worse than no idempotency at all because the client believes it.
     */
    async put(row, txh) {
      const { rows } = await q(txh,
        `insert into idempotency_keys
           (key, actor_id, request_hash, response_status, response_body, expires_at)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (key, actor_id) do nothing
         returning *`,
        [row.key, row.actorId, row.requestHash, row.responseStatus ?? null,
          row.responseBody === null || row.responseBody === undefined
            ? null : JSON.stringify(row.responseBody),
          row.expiresAt]);
      if (rows[0]) return mapRow(rows[0]);
      const cur = await idempotency.get(row.key, row.actorId, txh);
      if (cur && cur.requestHash !== row.requestHash) {
        throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'That idempotency key was used for a different request.', {
          details: { key: row.key },
        });
      }
      return cur;
    },
  };

  const flags = {
    async all(txh) {
      const { rows } = await q(txh, 'select * from feature_flags order by flag_key');
      return rows.map((r) => mapRow(r));
    },

    async get(key, txh) {
      const { rows } = await q(txh, 'select * from feature_flags where flag_key = $1', [key]);
      return mapRow(rows[0]);
    },

    /** Same patch semantics as profiles: a present key sets, including to null; absent leaves. */
    async set(key, patch, txh) {
      const p = patch ?? {};
      for (const k of Object.keys(p)) {
        if (!['enabled', 'rollout', 'isKillSwitch', 'updatedBy'].includes(k)) {
          throw new ApiError('VALIDATION_FAILED', `Unknown column for feature_flags: ${k}`, {
            details: { table: 'feature_flags', column: k },
          });
        }
      }
      // enabled and is_kill_switch are NOT NULL: 'present and null' is not an operation.
      for (const k of ['enabled', 'isKillSwitch']) {
        if (Object.hasOwn(p, k) && typeof p[k] !== 'boolean') {
          throw new ApiError('VALIDATION_FAILED', `feature_flags.${k} must be a boolean.`, {
            details: { table: 'feature_flags', column: k },
          });
        }
      }
      const { rows } = await q(txh,
        `insert into feature_flags (flag_key, enabled, rollout, is_kill_switch, updated_by)
         values ($1, coalesce($2::boolean, false), $3::jsonb, coalesce($4::boolean, false), $5)
         on conflict (flag_key) do update set
           enabled        = case when $6::boolean then $2::boolean else feature_flags.enabled end,
           rollout        = case when $7::boolean then $3::jsonb   else feature_flags.rollout end,
           is_kill_switch = case when $8::boolean then $4::boolean else feature_flags.is_kill_switch end,
           updated_by     = case when $9::boolean then $5          else feature_flags.updated_by end,
           updated_at = now()
         returning *`,
        [key, p.enabled ?? null, p.rollout == null ? null : JSON.stringify(p.rollout),
          p.isKillSwitch ?? null, p.updatedBy ?? null,
          Object.hasOwn(p, 'enabled'), Object.hasOwn(p, 'rollout'),
          Object.hasOwn(p, 'isKillSwitch'), Object.hasOwn(p, 'updatedBy')]);
      return mapRow(rows[0]);
    },
  };

  return {
    kind: 'postgres',
    tx,
    accounts, sessions, refreshTokens, profiles, stats, weaponStats, matches,
    preAuthConsent, outbox, audit, idempotency, flags,
    async health() {
      try {
        await pool.query('select 1');
        return { ok: true, detail: 'postgres' };
      } catch (err) {
        return { ok: false, detail: err.message };
      }
    },
    async close() { await pool.end(); },
  };
}
