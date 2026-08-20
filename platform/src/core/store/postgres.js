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
import { ApiError } from '../errors.js';
import { ulid as defaultUlid } from '../ids.js';

const TX = Symbol('overstrike.pgtx');

const toSnake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** bigint columns arrive as strings from `pg` (they can exceed 2^53). Career counters cannot. */
const STAT_COUNTERS = [
  'kills', 'deaths', 'assists', 'suicides', 'teamKills', 'headshots',
  'shotsFired', 'shotsHit', 'damageDealt', 'plants', 'defuses',
  'matches', 'wins', 'losses', 'draws', 'roundsPlayed', 'timePlayedSec',
];
const WEAPON_COUNTERS = ['shots', 'hits', 'kills', 'headshots'];

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

  function handleOf(txh) {
    if (txh === undefined || txh === null) return null;
    if (!txh[TX]) throw new ApiError('INTERNAL_ERROR', 'Not a transaction handle from this store.');
    if (txh.done) throw new ApiError('INTERNAL_ERROR', 'Transaction handle used after the transaction ended.');
    return txh;
  }

  async function q(txh, sql, params = []) {
    const h = handleOf(txh);
    const target = h ? h.client : pool;
    try {
      return await target.query(sql, params);
    } catch (err) {
      throw translate(err);
    }
  }

  async function tx(fn) {
    const client = await pool.connect();
    const handle = { [TX]: true, client, done: false };
    try {
      await client.query('begin');
      const out = await fn(handle);
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
      handle.done = true;
      client.release();
    }
  }

  /** INSERT built from a camelCase object. Column names come from the object, never a caller string. */
  async function insertRow(txh, table, obj, { returning = '*', onConflict = '' } = {}) {
    const cols = Object.keys(obj).filter((k) => obj[k] !== undefined);
    const sql = `insert into ${table} (${cols.map(toSnake).join(', ')}) `
      + `values (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ${onConflict} `
      + (returning ? `returning ${returning}` : '');
    const { rows } = await q(txh, sql, cols.map((c) => obj[c]));
    return rows[0] ?? null;
  }

  async function updateRow(txh, table, patch, where, whereValues, returning = '*') {
    const cols = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (!cols.length) return null;
    const sets = cols.map((c, i) => `${toSnake(c)} = $${i + 1}`);
    const params = cols.map((c) => patch[c]).concat(whereValues);
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
      const { accountId: _ignored, createdAt: _ignored2, ...rest } = patch;
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

    async revoke(sessionId, reason, at, txh) {
      // `where revoked_at is null` keeps the first revocation's timestamp and reason, which is
      // the one that explains what happened; a re-stamp would overwrite it with the retry.
      await q(txh,
        'update sessions set revoked_at = coalesce($2::timestamptz, now()), revoked_reason = $3 '
        + 'where session_id = $1 and revoked_at is null',
        [sessionId, at ?? null, reason ?? null]);
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
    async upsert(accountId, patch, txh) {
      const { rows } = await q(txh,
        `insert into profiles (account_id, roaming_settings, settings_version)
         values ($1, $2::jsonb, coalesce($3::int, 1))
         on conflict (account_id) do update set
           roaming_settings = coalesce(excluded.roaming_settings, profiles.roaming_settings),
           settings_version = coalesce($3::int, profiles.settings_version),
           updated_at = now()
         returning *`,
        [accountId, patch?.roamingSettings ?? null, patch?.settingsVersion ?? null]);
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
      for (const k of Object.keys(delta ?? {})) {
        if (!STAT_COUNTERS.includes(k)) {
          throw new ApiError('VALIDATION_FAILED', `Unknown stat counter: ${k}`, { details: { counter: k } });
        }
      }
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
      for (const k of Object.keys(delta ?? {})) {
        if (!WEAPON_COUNTERS.includes(k)) {
          throw new ApiError('VALIDATION_FAILED', `Unknown weapon counter: ${k}`, { details: { counter: k } });
        }
      }
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

  const preAuthConsent = {
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
           updated_at = now()
         returning *`,
        [row.clientSessionId, row.telemetryPersonal, row.policyVersion, row.decidedAt ?? null, row.expiresAt]);
      return mapRow(rows[0]);
    },

    async get(clientSessionId, txh) {
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
      const lock = handleOf(txh) ? 'for update skip locked' : '';
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
          row.responseBody ?? null, row.expiresAt]);
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

    async set(key, patch, txh) {
      const { rows } = await q(txh,
        `insert into feature_flags (flag_key, enabled, rollout, is_kill_switch, updated_by)
         values ($1, coalesce($2::boolean, false), $3::jsonb, coalesce($4::boolean, false), $5)
         on conflict (flag_key) do update set
           enabled = coalesce($2::boolean, feature_flags.enabled),
           rollout = coalesce($3::jsonb, feature_flags.rollout),
           is_kill_switch = coalesce($4::boolean, feature_flags.is_kill_switch),
           updated_by = coalesce($5, feature_flags.updated_by),
           updated_at = now()
         returning *`,
        [key, patch?.enabled ?? null, patch?.rollout ?? null,
          patch?.isKillSwitch ?? null, patch?.updatedBy ?? null]);
      return mapRow(rows[0]);
    },
  };

  return {
    kind: 'postgres',
    tx,
    accounts, sessions, refreshTokens, profiles, stats, weaponStats,
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
