/**
 * Progression storage.  contracts/progression-economy.md §3.
 *
 * A third, independently-pooled store alongside `core/store.js` and `inventory/store.js` —
 * the identical "two-store limitation" `deployment/index.js` and `settlement/index.js` already
 * document for their own pairs, extended to a third. `op_ledger`/`accounts_progression` live in
 * the same physical Postgres database as everything else (migration 0031 adds them, with real
 * FKs to `accounts`/`matches`/`item_instances`) — the split is a JS connection-pool/transaction
 * boundary, not a schema boundary, exactly as that phrase already means for the other two.
 *
 * `applyLedgerEntry` is this module's one write primitive: it is what makes "every OP ledger
 * write commits in the same transaction as the state change it is paying for" (contract §3.2)
 * true FOR THIS STORE's own half — the balance UPDATE, the ledger INSERT, and (when supplied)
 * the XP/level UPDATE, all in one transaction, gated on the unique `idempotency_key` index so a
 * retry replays the stored entry instead of re-applying the delta (§3.2).
 *
 * `emit`/`buildEvent` follow `inventory/index.js`'s own convention (see that module's header):
 * `buildEvent(entry, account)` returns one event or an array of events, called INSIDE this same
 * transaction, after the balance/ledger rows are written but before COMMIT — so an outbox
 * refusal (emit throwing) rolls the write back via `tx()`'s own catch, the identical
 * two-store-but-ordered-atomicity approximation `app.js`'s `emitDomainEvent` comment documents
 * for inventory/deployment. Skipped entirely on the `duplicate` (idempotent-replay) path, so a
 * retried repair/upgrade/award never emits its event twice. The memory driver below cannot
 * actually roll back a `Map` mutation if `emit` throws — same limitation `inventory/store.js`'s
 * memory adapter already has, harmless because the memory driver is test-only.
 */
import { ApiError } from '../../core/errors.js';
import { ulid as defaultUlid } from '../../core/ids.js';

const clone = (v) => (v === null || v === undefined ? null : structuredClone(v));

function defaultAccountRow(accountId) {
  return { accountId, opBalance: 0, xp: 0, level: 1, updatedAt: null };
}

// ---------------------------------------------------------------------------------- memory

export function createMemoryProgressionStore(deps = {}) {
  const ulid = deps.ulid ?? defaultUlid;
  const accounts = new Map();
  const ledgerByKey = new Map(); // idempotencyKey -> entry
  const ledgerByAccount = new Map(); // accountId -> entry[] (newest first)
  let queue = Promise.resolve();

  async function tx(fn) {
    const run = () => fn({});
    const settled = queue.then(run, run);
    queue = settled.then(() => {}, () => {});
    return settled;
  }

  async function getAccount(accountId) {
    const row = accounts.get(accountId);
    return row ? clone(row) : defaultAccountRow(accountId);
  }

  /**
   * Atomic: idempotent-by-key, balance-checked, optionally credits XP/level in the same
   * "transaction" (memory has none; the queue above serialises every call already).
   *
   * @returns { entry, account, duplicate }
   */
  async function applyLedgerEntry({ accountId, delta, reason, runId = null, instanceId = null,
    correlationId, idempotencyKey, xpDelta = 0, level = null, emit = null, buildEvent = null }) {
    return tx(async () => {
      const existing = ledgerByKey.get(idempotencyKey);
      if (existing) {
        return { entry: clone(existing), account: await getAccount(accountId), duplicate: true };
      }
      const current = accounts.get(accountId) ?? defaultAccountRow(accountId);
      const nextBalance = current.opBalance + delta;
      if (nextBalance < 0) {
        throw new ApiError('OP_INSUFFICIENT_BALANCE', 'OP balance is insufficient for this spend.', {
          details: { accountId, delta, opBalance: current.opBalance },
        });
      }
      const now = new Date().toISOString();
      const nextXp = current.xp + xpDelta;
      const nextLevel = level ?? current.level;
      const nextAccount = { accountId, opBalance: nextBalance, xp: nextXp, level: nextLevel, updatedAt: now };
      accounts.set(accountId, nextAccount);

      const entry = {
        entryId: ulid(), accountId, delta, balanceAfter: nextBalance, reason,
        runId, instanceId, correlationId, idempotencyKey, createdAt: now,
      };
      ledgerByKey.set(idempotencyKey, entry);
      const list = ledgerByAccount.get(accountId) ?? [];
      list.unshift(entry);
      ledgerByAccount.set(accountId, list);

      if (buildEvent) {
        const events = [].concat(buildEvent(entry, nextAccount));
        // eslint-disable-next-line no-await-in-loop -- a handful of events per call, sequential
        // so a later one never lands ahead of an earlier one for the same ledger entry.
        for (const event of events) { if (emit) await emit(event); }
      }

      return { entry: clone(entry), account: clone(nextAccount), duplicate: false };
    });
  }

  async function listRecentForAccount(accountId, { limit = 20 } = {}) {
    const list = ledgerByAccount.get(accountId) ?? [];
    return list.slice(0, limit).map(clone);
  }

  return {
    driver: 'memory',
    tx,
    accounts: { get: getAccount },
    ledger: { apply: applyLedgerEntry, listRecentForAccount },
    async close() {},
  };
}

// -------------------------------------------------------------------------------- postgres

function rowToAccount(r, accountId) {
  if (!r) return defaultAccountRow(accountId);
  return {
    accountId: r.account_id, opBalance: r.op_balance, xp: r.xp, level: r.level,
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
  };
}

function rowToEntry(r) {
  if (!r) return null;
  return {
    entryId: r.entry_id, accountId: r.account_id, delta: r.delta, balanceAfter: r.balance_after,
    reason: r.reason, runId: r.run_id, instanceId: r.instance_id, correlationId: r.correlation_id,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

export function createPostgresProgressionStore(config = {}, deps = {}) {
  const { Pool } = deps.pg ?? requirePg();
  const ulid = deps.ulid ?? defaultUlid;
  const pool = new Pool(config.pool ?? config);

  function requirePg() {
    // eslint-disable-next-line global-require
    return require('pg');
  }

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async function getAccount(accountId, t) {
    const q = t ?? pool;
    const { rows } = await q.query('select * from accounts_progression where account_id = $1', [accountId]);
    return rowToAccount(rows[0], accountId);
  }

  async function applyLedgerEntry({ accountId, delta, reason, runId = null, instanceId = null,
    correlationId, idempotencyKey, xpDelta = 0, level = null, emit = null, buildEvent = null }) {
    // A losing racer's unique-index violation on the INSERT below must roll back the balance
    // UPDATE this same transaction already applied — letting `tx()`'s own catch/ROLLBACK do
    // that (rethrow, don't swallow, here) is what keeps invariant 4 (§9) true under a genuine
    // concurrent replay: two simultaneous first-time calls for one idempotency key must leave
    // exactly one balance change committed, never two.
    try {
      return await tx(async (client) => {
        const { rows: existingRows } = await client.query(
          'select * from op_ledger where idempotency_key = $1', [idempotencyKey]);
        if (existingRows.length) {
          return { entry: rowToEntry(existingRows[0]), account: await getAccount(accountId, client), duplicate: true };
        }

        // Ensure a row exists to UPDATE against — an account's first-ever OP event.
        await client.query(
          `insert into accounts_progression (account_id) values ($1)
             on conflict (account_id) do nothing`,
          [accountId],
        );

        const levelClause = level !== null ? ', level = $3' : '';
        const params = level !== null ? [accountId, delta, level, xpDelta] : [accountId, delta, xpDelta];
        // xpDelta is always the last positional param in either branch.
        const xpIdx = level !== null ? 4 : 3;
        const { rows } = await client.query(
          `update accounts_progression
              set op_balance = op_balance + $2, xp = xp + $${xpIdx}, updated_at = now()${levelClause}
            where account_id = $1 and op_balance + $2 >= 0
            returning *`,
          params,
        );
        if (rows.length === 0) {
          throw new ApiError('OP_INSUFFICIENT_BALANCE', 'OP balance is insufficient for this spend.', {
            details: { accountId, delta },
          });
        }
        const account = rowToAccount(rows[0], accountId);

        const entryId = ulid();
        const { rows: entryRows } = await client.query(
          `insert into op_ledger
             (entry_id, account_id, delta, balance_after, reason, run_id, instance_id,
              correlation_id, idempotency_key)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
          [entryId, accountId, delta, account.opBalance, reason, runId, instanceId,
            correlationId, idempotencyKey],
        );
        const entry = rowToEntry(entryRows[0]);

        if (buildEvent) {
          const events = [].concat(buildEvent(entry, account));
          // Inside the still-open transaction: emit throwing here aborts before COMMIT, so
          // `tx()`'s own catch rolls the balance UPDATE and ledger INSERT back with it.
          // eslint-disable-next-line no-await-in-loop -- a handful of events per call, ordered.
          for (const event of events) { if (emit) await emit(event); }
        }

        return { entry, account, duplicate: false };
      });
    } catch (err) {
      if (err.code === '23505') {
        // Lost the idempotency race; the whole transaction above (balance UPDATE included) was
        // rolled back by `tx()`'s catch. Read the winner outside that dead transaction.
        const { rows: winnerRows } = await pool.query(
          'select * from op_ledger where idempotency_key = $1', [idempotencyKey]);
        return { entry: rowToEntry(winnerRows[0]), account: await getAccount(accountId), duplicate: true };
      }
      throw err;
    }
  }

  async function listRecentForAccount(accountId, { limit = 20 } = {}) {
    const { rows } = await pool.query(
      'select * from op_ledger where account_id = $1 order by created_at desc limit $2',
      [accountId, limit],
    );
    return rows.map(rowToEntry);
  }

  return {
    driver: 'postgres',
    tx,
    accounts: { get: getAccount },
    ledger: { apply: applyLedgerEntry, listRecentForAccount },
    async close() { await pool.end(); },
  };
}
