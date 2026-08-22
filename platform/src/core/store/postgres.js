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
import { pgConnectionConfig } from '../pgurl.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError } from '../errors.js';
import { ulid as defaultUlid } from '../ids.js';
import {
  STAT_COUNTERS, WEAPON_COUNTERS, STAT_DELTA_LIMITS, WEAPON_DELTA_LIMITS, assertCounterDelta,
  MATCH_COLUMNS, normaliseMatchResult, toHistoryMatchStatus, assertStorable,
  assertMatchTransition, assertPageArgs, TERMINAL_MATCH_STATUSES,
  INITIAL_SETTINGS_VERSION, casMayCreateProfile, assertExpectedVersion, assertSweepInstant,
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
export const TABLE_COLUMNS = {
  accounts: [
    'accountId', 'status', 'emailHash', 'email', 'displayName', 'displayNameFolded',
    'passwordHash', 'identityProvider', 'identitySubject', 'roles', 'nameChangedAt',
    'eligibilityVerdict', 'eligibilityPolicyVer', 'eligibilityDecidedAt',
    'emailVerifiedAt', 'termsVersionAccepted', 'termsAcceptedAt',
    'consentTelemetry', 'consentPolicyVer', 'consentDecidedAt',
    'privacy', 'createdAt', 'updatedAt', 'deletedAt',
  ],
  // auth.md §9 History. The table is in 0001; until now nothing could write it.
  account_name_history: [
    'accountId', 'previousName', 'changedAt', 'changedBy', 'reason', 'createdAt', 'updatedAt',
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
  match_evidence: ['matchId', 'evidenceRef', 'evidence', 'createdAt'],
  match_servers: ['serverId', 'region', 'address', 'capacity', 'inUse', 'status', 'build',
    'lastHeartbeatAt', 'createdAt', 'updatedAt'],
  rooms: ['roomId', 'ownerAccountId', 'name', 'region', 'mapId', 'mapVersion', 'mode',
    'rulesetVersion', 'build', 'capacity', 'status', 'settings', 'passwordHash', 'createdAt',
    'updatedAt', 'destroyedAt', 'destroyedReason'],
  room_members: ['roomId', 'accountId', 'displayName', 'team', 'ready', 'isOwner', 'connection',
    'disconnectedAt', 'estimatedRttMs', 'mutedAccountIds', 'loadout', 'joinedAt', 'leftAt', 'createdAt', 'updatedAt'],
  reports: ['reportId', 'reporterAccountId', 'subjectAccountId', 'matchId', 'chatMessageId', 'category',
    'description', 'evidenceRef', 'status', 'resolution', 'resolvedBy', 'resolvedAt', 'createdAt', 'updatedAt'],
  chat_messages: ['messageId', 'roomId', 'senderAccountId', 'text', 'createdAt', 'expiresAt',
    'removedAt', 'removedBy', 'removalReason'],
  match_tickets: ['jti', 'accountId', 'roomId', 'matchId', 'expiresAt', 'consumedAt', 'createdAt'],
  // settlement.md §7.3. `status`/`resolution`/`opened_at`/`reviewed_at`/`created_at`/`updated_at`
  // are either defaulted by the schema or written only by the dedicated claim/resolve methods
  // above, never by a generic patch — so they are deliberately absent from this allow-list.
  settlement_exceptions: ['exceptionId', 'runId', 'accountId', 'trigger', 'openedBy', 'evidenceSnapshot'],
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
  match_evidence: new Set(['evidence']),
  rooms: new Set(['settings']),
  room_members: new Set(['loadout', 'mutedAccountIds']),
  settlement_exceptions: new Set(['evidenceSnapshot']),
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
  // UNREACHABLE while the allow-list above is clean, and therefore unkillable by any test
  // (mutatetest, 2026-08-20). Every caller-supplied key has already been matched against
  // `ALLOWED`, so `camelKey` is one of the 110 names in `TABLE_COLUMNS` — and all 110 snake-case
  // into `^[a-z][a-z0-9_]*$` (measured; `storetest.mjs` re-measures it on every run, which is
  // what keeps this line's premise true as columns are added). The line is the second half of
  // "belt and braces": it catches an ALLOW-LIST ENTRY that was itself mistyped, which is the one
  // way a key can reach `set ${col} = $1` without a caller having chosen it. The check that
  // stops the injection this file's header is about is the allow-list, and that one IS killed.
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
    // Explicit fields rather than `connectionString`: pg-connection-string leaves the brackets
    // on an IPv6 literal, so an IPv6 DATABASE_URL resolves to nothing. See core/pgurl.js.
    ...pgConnectionConfig(databaseUrl),
    max: config.poolMax ?? 10,
  });
  pool.on?.('error', (err) => logger?.error('store.pool.error', { message: err.message }));

  /**
   * `statement_timeout`, applied per connection rather than as a startup parameter.
   *
   * A statement still running after 30s inside a request is not going to save that request; it
   * is going to hold a connection while the client has already given up. That reasoning has not
   * changed — how it is applied has.
   *
   * `new Pool({ statement_timeout })` sends it as a libpq STARTUP parameter, and pgbouncer
   * refuses startup parameters it does not know:
   *
   *     08P01  unsupported startup parameter: statement_timeout
   *
   * so the platform could not open a single connection through a transaction-mode pooler. That
   * is not an exotic configuration — it is the default shape of managed Postgres (Fly, Supabase's
   * pooler, RDS Proxy), and it is what `fly mpg attach` writes into DATABASE_URL. The deployed
   * platform booted, answered /v1/health, and reported `db: down` on every request, with the
   * cause masked to "Database error." by the driver-error translator.
   *
   * `SET` after connect works through a pooler and needs no server configuration. The value is
   * coerced to a non-negative integer and interpolated, because `SET` does not take a bind
   * parameter — hence the `Number.isInteger` check rather than trusting the config.
   *
   * Under TRANSACTION pooling this runs once per server connection, not once per checkout, so a
   * server connection reused by another client keeps the timeout. That is the desired direction:
   * every client of this database wants it, and pgbouncer resets it at `server_reset_query`.
   */
  const statementTimeoutMs = config.statementTimeoutMs ?? 30_000;
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 0) {
    throw new Error(`postgres store: statementTimeoutMs must be a non-negative integer, got ${statementTimeoutMs}`);
  }
  pool.on?.('connect', (client) => {
    // Fire-and-forget with a caught rejection: a failure here must not take down the pool, and
    // the next query will surface anything genuinely wrong with the connection.
    client.query(`set statement_timeout = ${statementTimeoutMs}`)
      .catch((err) => logger?.error('store.statement_timeout.failed', { message: err.message }));
  });

  /** Identity of THIS store, so a handle from another instance is rejected rather than used. */
  const storeTag = Symbol('overstrike.pgstore');

  function entryOf(txh) {
    if (txh === undefined || txh === null) return null;
    // EQUIVALENT MUTANT (mutatetest with a real database, 2026-08-20), same as the memory
    // adapter's: an object without the tag has no `handleState` entry either, so the check two
    // lines down raises the identical INTERNAL_ERROR, and `WeakMap.get` returns `undefined` for
    // a primitive rather than throwing. Kept because the two ask different questions — "is this
    // shaped like a handle" and "is it one of MINE".
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
      // EQUIVALENT MUTANT here and NOT on the memory adapter (mutatetest, 2026-08-20), which is
      // exactly why it is written down in both. `email_hash = NULL` is never true in SQL, so
      // deleting this line still yields zero rows; the memory adapter's `===` comparison WOULD
      // match every account whose hash is null and hand back an arbitrary one. Same guard, and
      // it is load-bearing on one adapter only — `storetest.mjs` asserts the rule on both.
      if (hash === null || hash === undefined) return null;
      const { rows } = await q(txh, 'select * from accounts where email_hash = $1', [hash]);
      return mapRow(rows[0]);
    },

    async byNameFolded(folded, txh) {
      const { rows } = await q(txh, 'select * from accounts where display_name_folded = $1', [folded]);
      return mapRow(rows[0]);
    },

    async identityReadiness(txh) {
      const { rows } = await q(txh, `select count(*)::int as unready_accounts
        from accounts
        where deleted_at is null and status <> 'deleted' and (
          identity_provider is distinct from 'supabase'
          or identity_subject is null
          or identity_subject = ''
          or password_hash is not null
        )`);
      const unreadyAccounts = Number(rows[0]?.unready_accounts ?? 0);
      return { ok: unreadyAccounts === 0, unreadyAccounts };
    },

    async update(accountId, patch, txh) {
      // account_id and created_at are immutable; updated_at belongs to the 0001 trigger, and
      // accepting one from the patch is a clock the caller writes. Same rule on both adapters.
      //
      // A patch that tries to RENAME the account is refused rather than dropped. Dropping it
      // silently was a divergence the memory adapter did not have: memory raised
      // VALIDATION_FAILED, while here the key was destructured away and — when it was the only
      // key — the empty update then surfaced as NOT_FOUND. Two adapters, two answers, neither
      // of them the one the caller's mistake deserves.
      if (Object.hasOwn(patch, 'accountId') && patch.accountId !== accountId) {
        throw new ApiError('VALIDATION_FAILED', 'accountId is immutable.', {
          details: { table: 'accounts', column: 'accountId' },
        });
      }
      const { accountId: _ignored, createdAt: _ignored2, updatedAt: _ignored3, ...rest } = patch;
      const row = await updateRow(txh, 'accounts', rest, 'account_id = $1', [accountId]);
      // EQUIVALENT MUTANT (mutatetest with a real database, 2026-08-20), and the reason is the
      // re-read below: the UPDATE has already committed by the time it runs, so it returns the
      // same row this line would have. What it costs is a second round trip on every account
      // write, which is why the line stays.
      if (row) return mapRow(row);
      // No row came back for one of two reasons, and they are not the same answer. A patch with
      // nothing left to set is a NO-OP that returns the account — which is what the memory
      // adapter does — and reporting NOT_FOUND for it told a caller its account had vanished
      // because it sent an empty PATCH body.
      const current = await accounts.byId(accountId, txh);
      if (!current) throw new ApiError('NOT_FOUND', 'No such account.', { details: { accountId } });
      return current;
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
      assertExpectedVersion(expectedVersion);
      const hasRoaming = Object.hasOwn(p, 'roamingSettings');
      const hasLegacy = Object.hasOwn(p, 'legacyImport');
      const hasVersion = Object.hasOwn(p, 'settingsVersion');
      if (hasVersion && !Number.isInteger(p.settingsVersion)) {
        throw new ApiError('VALIDATION_FAILED', 'profiles.settingsVersion must be an integer.', {
          details: { table: 'profiles', column: 'settingsVersion' },
        });
      }
      // `on conflict (account_id) do update ... where` gates the DO UPDATE branch and NOTHING
      // else, so the plain INSERT path ignored expectedVersion entirely: a CAS against version
      // 42 on an account with no profile row CREATED one and reported success, while memory
      // refused. The insert has to be gated too, and the only way to gate it in the same
      // statement — so the gate cannot be raced apart from the write — is INSERT … SELECT …
      // WHERE. `$9` is `casMayCreateProfile(expectedVersion)` (store.js); the EXISTS covers the
      // ordinary case where the row is already there and DO UPDATE will do the comparing.
      const { rows } = await q(txh,
        `insert into profiles (account_id, roaming_settings, settings_version, legacy_import)
         select $1, $2::jsonb, coalesce($3::int, $10::int), $4::jsonb
          where $9::boolean or exists (select 1 from profiles where account_id = $1)
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
          hasRoaming, hasLegacy, hasVersion, expectedVersion,
          casMayCreateProfile(expectedVersion), INITIAL_SETTINGS_VERSION]);
      if (rows[0]) return mapRow(rows[0]);
      // Zero rows is "the version moved" — but only for an account that EXISTS. Before the gate
      // above, an unknown account always reached the insert and the foreign key answered
      // NOT_FOUND, as memory does; now the gate can swallow it and return null, which tells the
      // caller its If-Match was stale when the truth is that the account is not there. One
      // extra query, on the refusal path only, keeps the two adapters saying the same thing.
      const { rows: account } = await q(txh, 'select 1 from accounts where account_id = $1', [accountId]);
      if (!account[0]) {
        throw new ApiError('NOT_FOUND', 'profiles: no such account', { details: { accountId } });
      }
      return null;
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
    async activeForRoom(roomId, txh) {
      const { rows } = await q(txh, `select * from matches where room_id=$1
        and status in ('allocated','in-progress') order by allocated_at desc limit 1`, [roomId]);
      if (!rows.length) return null;
      const match = mapRow(rows[0]);
      const { rows: participants } = await q(txh,
        'select * from match_participants where match_id=$1 order by joined_at,account_id', [match.matchId]);
      return { ...match, participants: participants.map((row) => mapRow(row)) };
    },
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

    async latestTerminalForRoom(roomId, txh) {
      const { rows } = await q(txh, `select * from matches where room_id=$1
        and status in ('completed','aborted','invalidated') and result_applied_at is not null
        order by ended_at desc nulls last,match_id desc limit 1`, [roomId]);
      if (!rows.length) return null;
      const match = mapRow(rows[0]);
      const { rows: participants } = await q(txh,
        'select * from match_participants where match_id=$1 order by joined_at,account_id', [match.matchId]);
      return { ...match, participants: participants.map((row) => mapRow(row)) };
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

    // ---------------------------------------------------------------- P3-04 settlement.md

    /**
     * A minimal run allocation — see the memory adapter's identical note: `deployment.md`'s
     * admission-time write is the eventual real producer of a `mode='extraction'` row; until
     * that lands, this is the one way a caller creates one.
     */
    async allocateRun({ matchId, region, mapId, mapVersion = null, serverId = null, roomId = null,
      serverBuild = null, participants = [] }, txh) {
      const run = async (t) => {
        await insertRow(t, 'matches', {
          matchId, roomId, region, serverId, mapId, mapVersion, mode: 'extraction',
          rulesetVersion: null, statDefinitionVersion: null, serverBuild,
          status: 'in-progress', terminationReason: null, outcomeReason: null,
          invalidationReason: null, winnerTeam: null, rulesSnapshot: {},
          teamScores: null, rounds: null, evidenceRef: null, startedAt: new Date().toISOString(),
          endedAt: null,
        }, { returning: '' });
        for (const accountId of participants) {
          await insertRow(t, 'match_participants',
            { matchId, accountId, team: null, stats: {} }, { returning: '' });
        }
        const { rows } = await q(t, 'select * from matches where match_id = $1', [matchId]);
        return mapRow(rows[0]);
      };
      return inTransaction(txh) ? run(txh) : tx((t) => run(t));
    },

    /**
     * settlement.md §5.2 — the run-terminal write. No-op (returns the row unchanged) once the
     * run has already reached a terminal status, so a retried submission never re-derives
     * `started_at`/`ended_at` from a second payload.
     */
    async transitionRunEnded(runId, { status, startedAt, endedAt, evidenceRef = null }, txh) {
      // `evidence_ref` is written here because migration 0029's terminal-completeness CHECK
      // requires it non-null on a terminal extraction row, and THIS update is the only write
      // that makes a run terminal — without it the transition itself violates the CHECK.
      const { rows } = await q(txh,
        `update matches set status = $2, started_at = coalesce($3::timestamptz, started_at),
            ended_at = coalesce($4::timestamptz, ended_at),
            evidence_ref = coalesce($5, evidence_ref), updated_at = now()
          where match_id = $1 and mode = 'extraction' and status = 'in-progress'
          returning *`,
        [runId, status, startedAt ?? null, endedAt ?? null, evidenceRef ?? null]);
      if (rows.length) return mapRow(rows[0]);
      const { rows: current } = await q(txh, 'select * from matches where match_id = $1', [runId]);
      if (!current.length) throw new ApiError('NOT_FOUND', 'No such run.', { details: { runId } });
      if (current[0].mode !== 'extraction') {
        throw new ApiError('VALIDATION_FAILED', 'transitionRunEnded is for mode=extraction rows only.', {
          details: { runId, mode: current[0].mode },
        });
      }
      return mapRow(current[0]);   // already terminal: no-op on replay
    },

    /** §5.2's `settlementStatus: 'ended'` stamp — only where absent, for the named accounts. */
    async markParticipantsEnded(matchId, accountIds, txh) {
      const { rowCount } = await q(txh,
        `update match_participants set stats = stats || '{"settlementStatus":"ended"}'::jsonb,
            updated_at = now()
          where match_id = $1 and account_id = any($2)
            and (stats ->> 'settlementStatus') is null`,
        [matchId, accountIds]);
      return rowCount;
    },

    /** §6/§6.1's unconditional `stats = stats || jsonb_build_object(…)` merge. */
    async mergeParticipantStats(matchId, accountId, patch, txh) {
      const { rows } = await q(txh,
        `update match_participants set stats = stats || $3::jsonb, updated_at = now()
          where match_id = $1 and account_id = $2
          returning *`,
        [matchId, accountId, JSON.stringify(patch)]);
      if (!rows.length) {
        throw new ApiError('NOT_FOUND', 'No such match participant.', { details: { matchId, accountId } });
      }
      return mapRow(rows[0]);
    },

    /** One participant's current stats, for the natural per-participant idempotency check. */
    async getParticipant(matchId, accountId, txh) {
      const { rows } = await q(txh,
        'select * from match_participants where match_id = $1 and account_id = $2', [matchId, accountId]);
      return mapRow(rows[0]);
    },

    /** §7.2's stall-detector precondition set: terminal run, participant with no disposition yet. */
    async listUnsettledRunParticipants(txh) {
      const { rows } = await q(txh,
        `select p.match_id, p.account_id, m.ended_at
           from match_participants p
           join matches m on m.match_id = p.match_id
          where m.mode = 'extraction' and m.status in ('completed', 'aborted')
            and (p.stats ->> 'settlementStatus') is null`);
      return rows.map((r) => ({
        matchId: r.match_id, accountId: r.account_id,
        endedAt: r.ended_at instanceof Date ? r.ended_at.toISOString() : r.ended_at,
      }));
    },
  };

  const settlementExceptions = {
    /** §7.1's ambiguity triggers land here, whether opened by the endpoint or the stall detector. */
    async open(row, txh) {
      return mapRow(await insertRow(txh, 'settlement_exceptions', {
        exceptionId: row.exceptionId ?? newId(),
        runId: row.runId, accountId: row.accountId ?? null, trigger: row.trigger,
        openedBy: row.openedBy, evidenceSnapshot: row.evidenceSnapshot ?? {},
      }));
    },

    async byId(exceptionId, txh) {
      const { rows } = await q(txh, 'select * from settlement_exceptions where exception_id = $1', [exceptionId]);
      return mapRow(rows[0]);
    },

    async listByRun(runId, txh) {
      const { rows } = await q(txh,
        'select * from settlement_exceptions where run_id = $1 order by opened_at', [runId]);
      return rows.map((r) => mapRow(r));
    },

    async listOpenForParticipant(runId, accountId, txh) {
      const { rows } = await q(txh,
        `select * from settlement_exceptions
          where run_id = $1 and account_id = $2 and status <> 'resolved'`,
        [runId, accountId]);
      return rows.map((r) => mapRow(r));
    },

    /** settlement.md §7.4 step 2 — the queryable queue. Every filter optional, oldest first. */
    async list({ status = null, runId = null, accountId = null, trigger = null } = {}, txh) {
      const { rows } = await q(txh,
        `select * from settlement_exceptions
          where ($1::text is null or status = $1)
            and ($2::text is null or run_id = $2)
            and ($3::text is null or account_id = $3)
            and ($4::text is null or trigger = $4)
          order by opened_at, exception_id`,
        [status, runId, accountId, trigger]);
      return rows.map((r) => mapRow(r));
    },

    /** §7.4 step 3 — optimistic-locked claim. Zero rows (returns null) means claimed/resolved since read. */
    async claim({ exceptionId, operatorId, expectedUpdatedAt }, txh) {
      const { rows } = await q(txh,
        `update settlement_exceptions set assigned_to = $1, status = 'in-review', updated_at = now()
          where exception_id = $2 and updated_at = $3::timestamptz and status = 'open'
          returning *`,
        [operatorId, exceptionId, expectedUpdatedAt]);
      return mapRow(rows[0]);
    },

    /**
     * §7.4 step 4/6 — the terminal write.
     *
     * The `WHERE ... status = 'in-review'` is a guarded UPDATE, the same optimistic-lock shape
     * `refreshTokens.markUsed` uses: zero rows back means the exception was already resolved (or
     * never claimed), and the caller must not treat that as success — a second resolve on an
     * already-resolved row would re-emit `run.settled` and clobber the first operator's audit
     * trail. This is the DB-level backstop behind `resolveException`'s own read-then-check in
     * the settlement module, the one that still holds under a genuine concurrent race.
     */
    async resolve({ exceptionId, resolution, resolutionNotes, resolutionEvidenceRef = null, reviewedBy }, txh) {
      const { rows } = await q(txh,
        `update settlement_exceptions
            set status = 'resolved', resolution = $2, resolution_notes = $3,
                resolution_evidence_ref = $4, reviewed_by = $5, reviewed_at = now(), updated_at = now()
          where exception_id = $1 and status = 'in-review'
          returning *`,
        [exceptionId, resolution, resolutionNotes, resolutionEvidenceRef, reviewedBy]);
      if (!rows.length) {
        const { rows: existing } = await q(txh,
          'select status from settlement_exceptions where exception_id = $1', [exceptionId]);
        if (!existing.length) {
          throw new ApiError('NOT_FOUND', 'No such settlement exception.', { details: { exceptionId } });
        }
        throw new ApiError('CONFLICT', 'That exception is not in review (already resolved, or not yet claimed).', {
          details: { exceptionId, status: existing[0].status },
        });
      }
      return mapRow(rows[0]);
    },
  };

  /**
   * The TTL clock is the store's INJECTED clock, not `now()` in the statement.
   *
   * Both adapters have to answer the same question at the same instant or a fake-clock test
   * proves nothing about the adapter that ships. `deps.now` is that instant; falling back to
   * the process clock when nothing is injected keeps production behaviour unchanged.
   */
  const storeNowIso = (at = null) => {
    const t = at ?? (deps.now ? deps.now() : Date.now());
    // EQUIVALENT MUTANT (mutatetest with a real database, 2026-08-20). Deleting this line
    // changes no behaviour: a Date falls through to `new Date(Number(t)).toISOString()`, and
    // `Number(date)` is `date.valueOf()` which IS `date.getTime()` — measured over 200 000
    // random instants plus the epoch, the maximum representable date and an invalid date, and
    // identical every time. Same shortcut, same reasoning, as the memory adapter's `storeNowMs`.
    if (t instanceof Date) return t.toISOString();
    return typeof t === 'string' ? t : new Date(Number(t)).toISOString();
  };
  const consentNowIso = () => storeNowIso();

  /**
   * The instant a retention sweep runs at.
   *
   * NOT `storeNowIso`: that hands a caller-supplied string straight to `$1::timestamptz`, and
   * `timestamptz` is generous — it read `'yesterday'` as a real instant and swept on it, while
   * the memory adapter refused the same argument. `'banana'` diverged too, as 22007 →
   * INTERNAL_ERROR against memory's VALIDATION_FAILED. The rule is decided once, in store.js.
   */
  const sweepIso = (at) => (at === null || at === undefined
    ? storeNowIso()
    : new Date(assertSweepInstant(at)).toISOString());

  const preAuthConsent = {
    /**
     * A write RESETS migrated_at. Nothing stamps it any more — signup DELETES the row rather
     * than marking it (`deleteFor`, §3a.3) — but a row arriving from a backfill or a
     * hand-written statement with a stamp on it would otherwise make a live decision read as
     * already-carried and be silently ignored. A consent record that is not true is worse than
     * none.
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

    /**
     * The migration half of the §3a.3 lifecycle: "deleted on migration at signup, or on expiry".
     *
     * This used to be `markMigrated`, which stamped `migrated_at` and kept the row. Reads then
     * treated a stamped row as absent, so the decision was correctly ignored — and retained,
     * for the whole remainder of its 30-day TTL, as a standalone consent record keyed by a
     * client session, sitting beside the account it had already been copied onto. The contract
     * says three times over (here, db-schema.md §2, migration 0001) that signup DELETES it, and
     * a record we have decided to stop reading is not a record we have deleted.
     *
     * @returns {Promise<boolean>} whether a row was removed.
     */
    async deleteFor(clientSessionId, txh) {
      const { rowCount } = await q(txh,
        'delete from pre_auth_consent where client_session_id = $1', [clientSessionId]);
      return rowCount > 0;
    },

    /**
     * Delete every expired row, whether or not anybody ever reads it again.  §3a.3.
     *
     * Expiry on read stops a stale decision being HONOURED; it does not satisfy the 30-day
     * retention limit, because the rows nobody reads again are exactly the rows nobody
     * deletes. `pre_auth_consent_expiry_idx` (0001) serves this predicate.
     *
     * @returns {Promise<number>} rows deleted, so a janitor can log or gauge it.
     */
    async sweepExpired(at = null, txh) {
      const { rowCount } = await q(txh,
        'delete from pre_auth_consent where expires_at <= $1::timestamptz', [sweepIso(at)]);
      return rowCount;
    },
  };

  /**
   * `account_name_history`.  auth.md §9, db-schema.md §2.
   *
   * Insert and list only, matching the memory adapter: a name history the application can
   * rewrite proves nothing in the impersonation review it exists for.
   */
  const accountNameHistory = {
    async insert(row, txh) {
      // `changed_at` has a `default now()`, and now() inside a transaction is the transaction's
      // start — not the instant the caller decided. The caller's value wins when it has one,
      // and the store's injected clock supplies it otherwise, so both adapters stamp the row
      // from one source.
      const rec = {
        accountId: row.accountId,
        previousName: row.previousName,
        changedAt: storeNowIso(row.changedAt ?? null),
        changedBy: row.changedBy ?? null,
        reason: row.reason ?? null,
      };
      return mapRow(await insertRow(txh, 'account_name_history', rec));
    },

    /** Newest first: a review starts from the name the subject is impersonating today. */
    async listForAccount(accountId, { limit = 100 } = {}, txh) {
      const { rows } = await q(txh,
        'select * from account_name_history where account_id = $1 order by changed_at desc limit $2',
        [accountId, limit]);
      return rows.map((r) => mapRow(r));
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

    async list(filter = {}, txh) {
      const where = [];
      const params = [];
      for (const [field, col] of [['correlationId', 'correlation_id'], ['subjectId', 'subject_id']]) {
        if (filter[field] !== undefined) {
          params.push(filter[field]); where.push(`${col} = $${params.length}`);
        }
      }
      params.push(Math.min(500, Math.max(1, Number(filter.limit) || 100)));
      const { rows } = await q(txh,
        `select * from events_outbox ${where.length ? `where ${where.join(' and ')}` : ''}
          order by recorded_at, event_id limit $${params.length}`, params);
      return rows.map((row) => mapRow(row));
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
      // EQUIVALENT MUTANT on THIS adapter and not on the other (mutatetest, 2026-08-20). Deleting
      // it here is harmless: `pg` binds `undefined` as null, `event_id = any(null::text[])`
      // matches nothing, and an empty array matches nothing either. The memory adapter iterated
      // the argument and threw `eventIds is not iterable` — so an idle relay was a no-op in
      // production and a crash in every test. Both now say no-op; `storetest.mjs` asserts it.
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
        ['actorId', 'actor_id'], ['action', 'action'], ['correlationId', 'correlation_id']]) {
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
          // Null is the §8 "permanent" retention class, not a missing value: the sweep skips it.
          row.expiresAt ?? null]);
      // EQUIVALENT MUTANT (mutatetest with a real database, 2026-08-20), and deliberately kept.
      // Deleting it costs a round trip and changes no answer: `on conflict do nothing returning
      // *` gives the row back only when THIS call inserted it, and the re-read below then finds
      // that same row with the same `requestHash`, so the comparison passes and `cur` is
      // returned — the identical value. It stays because the extra SELECT is on the hot path
      // (every first write of every idempotent request) and because "we inserted it" and "it was
      // already there" are different facts that this line is the only place to tell apart.
      if (rows[0]) return mapRow(rows[0]);
      const cur = await idempotency.get(row.key, row.actorId, txh);
      if (cur && cur.requestHash !== row.requestHash) {
        throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'That idempotency key was used for a different request.', {
          details: { key: row.key },
        });
      }
      return cur;
    },

    /**
     * §8 retention: "24 h for gameplay, permanent for value-bearing operations."
     *
     * Every writer stamped `expires_at` and NOTHING ever read it or deleted on it, so the
     * declared retention was a column, not a policy. That table accumulates a row per profile
     * PATCH, per match result, and per burnt eligibility-receipt nonce — and the nonce rows
     * are onboarding evidence, which is the class we least want to keep forever by accident.
     *
     * A NULL `expires_at` is the "permanent" class and is never swept; 0017 makes the column
     * nullable so that class is expressible at all. `idempotency_keys_expiry_idx` serves this
     * predicate.
     *
     * Deliberately NOT paired with an expiry check in `get`. An idempotency row honoured a
     * little past its retention window costs nothing; refusing it would re-execute a write the
     * client believes already happened, which is the exact failure the table exists to prevent.
     * Retention here is about not KEEPING the row, not about distrusting it while it is there.
     *
     * @returns {Promise<number>} rows deleted, so a janitor can log or gauge it.
     */
    async sweepExpired(at = null, txh) {
      const { rowCount } = await q(txh,
        'delete from idempotency_keys where expires_at is not null and expires_at <= $1::timestamptz',
        [sweepIso(at)]);
      return rowCount;
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

  const rooms = {
    async upsert(row, txh) {
      const { rows } = await q(txh, `insert into rooms
        (room_id, owner_account_id, name, region, map_id, map_version, mode, ruleset_version,
         build, capacity, status, settings, password_hash, destroyed_at, destroyed_reason)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)
        on conflict (room_id) do update set
          owner_account_id=excluded.owner_account_id, name=excluded.name, region=excluded.region,
          map_id=excluded.map_id, map_version=excluded.map_version, mode=excluded.mode,
          ruleset_version=excluded.ruleset_version, build=excluded.build, capacity=excluded.capacity,
          status=excluded.status, settings=excluded.settings, password_hash=excluded.password_hash,
          destroyed_at=excluded.destroyed_at, destroyed_reason=excluded.destroyed_reason
        returning *`, [row.roomId, row.ownerAccountId, row.name, row.region, row.mapId,
        row.mapVersion, row.mode, row.rulesetVersion, row.build, row.capacity, row.status,
        JSON.stringify(row.settings ?? {}), row.passwordHash ?? null, row.destroyedAt ?? null,
        row.destroyedReason ?? null]);
      return mapRow(rows[0]);
    },
    async byId(roomId, txh) {
      const { rows } = await q(txh, 'select * from rooms where room_id=$1 and destroyed_at is null', [roomId]);
      return mapRow(rows[0]);
    },
    async list(txh) {
      const { rows } = await q(txh, 'select * from rooms where destroyed_at is null order by created_at, room_id');
      return rows.map((row) => mapRow(row));
    },
    async remove(roomId, txh) {
      const { rowCount } = await q(txh, `update rooms set status='destroyed', destroyed_at=now(),
        destroyed_reason=coalesce(destroyed_reason,'empty') where room_id=$1 and destroyed_at is null`, [roomId]);
      return rowCount > 0;
    },
  };

  const roomMembers = {
    async upsert(row, txh) {
      const { rows } = await q(txh, `insert into room_members
        (room_id,account_id,display_name,team,ready,is_owner,connection,disconnected_at,
         estimated_rtt_ms,muted_account_ids,loadout,joined_at,left_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13)
        on conflict (room_id,account_id) do update set display_name=excluded.display_name,
          team=excluded.team, ready=excluded.ready, is_owner=excluded.is_owner,
          connection=excluded.connection, disconnected_at=excluded.disconnected_at,
          estimated_rtt_ms=excluded.estimated_rtt_ms, muted_account_ids=excluded.muted_account_ids,
          loadout=excluded.loadout,
          left_at=excluded.left_at returning *`, [row.roomId,row.accountId,row.displayName,row.team,
        row.ready,row.isOwner,row.connection,row.disconnectedAt ?? null,row.estimatedRttMs ?? null,
        JSON.stringify(row.mutedAccountIds ?? []),JSON.stringify(row.loadout ?? {}),row.joinedAt,row.leftAt ?? null]);
      return mapRow(rows[0]);
    },
    async listForRoom(roomId, txh) {
      const { rows } = await q(txh, 'select * from room_members where room_id=$1 and left_at is null order by joined_at, account_id', [roomId]);
      // Array.map passes (row, index); handing mapRow directly made the numeric-column list an
      // integer and crashed on `numeric.includes` as soon as PostgreSQL returned a member.
      return rows.map((row) => mapRow(row));
    },
    async wasMemberAt(roomId, accountId, at, txh) {
      const { rows } = await q(txh, `select 1 from room_members where room_id=$1 and account_id=$2
        and joined_at <= $3 and (left_at is null or left_at >= $3) limit 1`, [roomId,accountId,at]);
      return rows.length > 0;
    },
    async recentFor(accountId, limit = 25, cursor = 0, txh) {
      const { rows } = await q(txh, `select account_id, encountered_at from (
          select distinct on (peer.account_id) peer.account_id,
            greatest(peer.joined_at, coalesce(peer.left_at, peer.joined_at)) as encountered_at
          from room_members self
          join room_members peer on peer.room_id=self.room_id and peer.account_id<>self.account_id
          where self.account_id=$1
          order by peer.account_id, encountered_at desc
        ) recent order by encountered_at desc, account_id limit $2 offset $3`, [accountId, limit, cursor]);
      return rows.map((row) => mapRow(row));
    },
    async remove(roomId, accountId, leftAt = new Date().toISOString(), txh) {
      const { rowCount } = await q(txh, 'update room_members set left_at=$3 where room_id=$1 and account_id=$2 and left_at is null', [roomId, accountId, leftAt]);
      return rowCount > 0;
    },
  };

  const reports = {
    async create(row, txh) {
      try {
        const { rows } = await q(txh, `insert into reports
          (report_id,reporter_account_id,subject_account_id,match_id,chat_message_id,category,description,evidence_ref,status)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`, [row.reportId,row.reporterAccountId,
          row.subjectAccountId,row.matchId ?? null,row.chatMessageId ?? null,row.category,row.description ?? null,
          row.evidenceRef ?? null,row.status ?? 'open']);
        return mapRow(rows[0]);
      } catch (error) {
        if (error.code === 'CONFLICT') throw new ApiError('REPORT_DUPLICATE', 'You already reported this incident.');
        throw error;
      }
    },
  };

  const chatMessages = {
    async create(row, txh) { return insertRow(txh, 'chat_messages', row); },
    async byId(messageId, txh) {
      const { rows } = await q(txh, 'select * from chat_messages where message_id=$1', [messageId]);
      return mapRow(rows[0]);
    },
    async listForRoom(roomId, limit = 50, at = new Date().toISOString(), txh) {
      const { rows } = await q(txh, `select * from (
        select * from chat_messages where room_id=$1 and removed_at is null and expires_at > $3
        order by created_at desc limit $2) recent order by created_at`, [roomId,limit,at]);
      return rows.map((row) => mapRow(row));
    },
    async remove(messageId, actorId, reason, at, txh) {
      const { rows } = await q(txh, `update chat_messages set removed_at=coalesce(removed_at,$4),
        removed_by=coalesce(removed_by,$2),removal_reason=coalesce(removal_reason,$3)
        where message_id=$1 returning *`, [messageId,actorId,reason,at]);
      if (!rows.length) throw new ApiError('NOT_FOUND', 'No such chat message.');
      return mapRow(rows[0]);
    },
    async purgeExpired(at, txh) {
      const { rowCount } = await q(txh, `delete from chat_messages where expires_at <= $1
        and not exists (select 1 from reports where reports.chat_message_id=chat_messages.message_id
          and (reports.resolved_at is null or reports.resolved_at + interval '30 days' > $1))`, [at]);
      return rowCount;
    },
  };

  const matchEvidence = {
    async put(row, txh) {
      return insertRow(txh, 'match_evidence', row);
    },
    async byMatchId(matchId, txh) {
      const { rows } = await q(txh, 'select * from match_evidence where match_id=$1', [matchId]);
      return mapRow(rows[0]);
    },
    async byEvidenceRef(evidenceRef, txh) {
      const { rows } = await q(txh, 'select * from match_evidence where evidence_ref=$1', [evidenceRef]);
      return mapRow(rows[0]);
    },
  };

  const matchTickets = {
    async put(row, txh) { return insertRow(txh, 'match_tickets', row); },
    async consume(jti, claims, at = new Date().toISOString(), txh) {
      const { rows } = await q(txh, `update match_tickets set consumed_at=$5
        where jti=$1 and account_id=$2 and room_id=$3 and match_id=$4
          and consumed_at is null and expires_at > $5 returning *`,
      [jti,claims.accountId,claims.roomId,claims.matchId,at]);
      return mapRow(rows[0]);
    },
    async byJti(jti, txh) {
      const { rows } = await q(txh, 'select * from match_tickets where jti=$1', [jti]);
      return mapRow(rows[0]);
    },
    async purgeExpired(at, txh) {
      const { rowCount } = await q(txh, `delete from match_tickets
        where expires_at <= $1::timestamptz - interval '24 hours'`, [at]);
      return rowCount;
    },
  };

  const matchServers = {
    async register(row, txh) {
      const { rows } = await q(txh, `insert into match_servers
        (server_id,region,address,capacity,in_use,status,build,last_heartbeat_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8)
        on conflict (server_id) do update set region=excluded.region,address=excluded.address,
          capacity=excluded.capacity,build=excluded.build,last_heartbeat_at=excluded.last_heartbeat_at
        returning *`, [row.serverId,row.region,row.address,row.capacity,row.inUse ?? 0,
        row.status ?? 'healthy',row.build,row.lastHeartbeatAt ?? new Date().toISOString()]);
      return mapRow(rows[0], ['capacity', 'inUse']);
    },
    async heartbeat(serverId, patch, txh) {
      const { rows } = await q(txh, `update match_servers set in_use=greatest(in_use,$2),status=$3,
        capacity=$4,last_heartbeat_at=$5 where server_id=$1 returning *`,
      [serverId,patch.inUse,patch.status,patch.capacity,patch.lastHeartbeatAt ?? new Date().toISOString()]);
      if (!rows.length) throw new ApiError('NOT_FOUND', 'Match server is not registered.');
      return mapRow(rows[0], ['capacity', 'inUse']);
    },
    async healthy(region, since, txh) {
      const { rows } = await q(txh, `select * from match_servers where region=$1
        and status='healthy' and last_heartbeat_at >= $2 and in_use < capacity
        order by in_use,server_id`, [region,since]);
      return rows.map((row) => mapRow(row, ['capacity', 'inUse']));
    },
    async reserve(region, since, txh) {
      const { rows } = await q(txh, `with candidate as (
          select server_id from match_servers where region=$1 and status='healthy'
            and last_heartbeat_at >= $2 and in_use < capacity
          order by in_use,server_id for update skip locked limit 1
        ) update match_servers m set in_use=m.capacity from candidate c
          where m.server_id=c.server_id returning m.*`, [region,since]);
      return mapRow(rows[0], ['capacity', 'inUse']);
    },
    async release(serverId, txh) {
      const { rowCount } = await q(txh, 'update match_servers set in_use=0 where server_id=$1', [serverId]);
      return rowCount > 0;
    },
    async byId(serverId, txh) {
      const { rows } = await q(txh, 'select * from match_servers where server_id=$1', [serverId]);
      return mapRow(rows[0], ['capacity', 'inUse']);
    },
  };

  return {
    kind: 'postgres',
    tx,
    accounts, accountNameHistory, sessions, refreshTokens, profiles, stats, weaponStats, matches,
    preAuthConsent, outbox, audit, idempotency, flags, rooms, roomMembers, reports, matchTickets, chatMessages,
    matchEvidence, matchServers, settlementExceptions,
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
