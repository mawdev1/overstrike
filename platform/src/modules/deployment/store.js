/**
 * Deployment reservation + snapshot storage.  contracts/deployment.md §2, §4.4.
 *
 * Scoped to this module's two tables (deployment_reservations, deployment_snapshots) the same
 * way `inventory/store.js` is scoped to its three — this is P3-02's own self-contained slice,
 * migration 0028, talked to only through `../deployment/index.js`. Same two-adapter split as
 * every other module's store: `memory` for tests, `postgres` for real, one interface for both.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ApiError } from '../../core/errors.js';
import { ulid as defaultUlid } from '../../core/ids.js';

const clone = (v) => (v === null || v === undefined ? null : structuredClone(v));

// ---------------------------------------------------------------------------------- memory

const txContext = new AsyncLocalStorage();
const handleState = new WeakMap();

function emptyState() {
  return { reservations: new Map(), snapshots: new Map() };
}

export function createMemoryDeploymentStore(deps = {}) {
  const ulid = deps.ulid ?? defaultUlid;
  let live = emptyState();
  let queue = Promise.resolve();

  function currentState() {
    const enrolled = txContext.getStore();
    if (enrolled) return handleState.get(enrolled);
    return live;
  }

  async function tx(fn) {
    const enrolled = txContext.getStore();
    if (enrolled) return fn(enrolled); // reentrant: join the outer transaction

    const run = async () => {
      const draft = structuredClone(live);
      const handle = {};
      handleState.set(handle, draft);
      try {
        const result = await txContext.run(handle, () => fn(handle));
        live = draft;
        return result;
      } finally {
        handleState.delete(handle);
      }
    };

    // Same "never let the queue itself become a rejected promise" rule as inventory/store.js —
    // one failed transaction must not wedge every transaction queued after it.
    const settled = queue.then(run, run);
    queue = settled.then(() => {}, () => {});
    return settled;
  }

  const reservations = {
    async create(row) {
      const state = currentState();
      const reservationId = row.reservationId ?? ulid();
      if (state.reservations.has(reservationId)) {
        throw new ApiError('CONFLICT', `Reservation ${reservationId} already exists.`);
      }
      const now = new Date().toISOString();
      const stored = {
        reservationId, accountId: row.accountId, loadoutId: row.loadoutId ?? null,
        roomId: row.roomId ?? null, matchId: row.matchId ?? null,
        instanceIds: [...row.instanceIds], status: 'reserved',
        reservedAt: now, expiresAt: row.expiresAt,
        consumedAt: null, releasedAt: null, releasedReason: null,
        createdAt: now, updatedAt: now,
      };
      state.reservations.set(reservationId, stored);
      return clone(stored);
    },
    async byId(reservationId) {
      const row = currentState().reservations.get(reservationId);
      return row ? clone(row) : null;
    },
    async listForAccount(accountId) {
      const out = [];
      for (const row of currentState().reservations.values()) {
        if (row.accountId === accountId) out.push(clone(row));
      }
      return out;
    },

    /** §5.1/§5.2/§5.3a — the one release UPDATE, any reason. WHERE status='reserved' only. */
    async release(reservationId, reason, now) {
      const state = currentState();
      const row = state.reservations.get(reservationId);
      if (!row || row.status !== 'reserved') return null;
      row.status = 'released';
      row.releasedAt = now;
      row.releasedReason = reason;
      row.updatedAt = now;
      return clone(row);
    },

    /** §5.3 backstop. Every row still 'reserved' past its TTL, in one sweep. */
    async sweepExpired(now) {
      const state = currentState();
      const swept = [];
      for (const row of state.reservations.values()) {
        if (row.status === 'reserved' && row.expiresAt < now) {
          row.status = 'expired';
          row.releasedAt = now;
          row.releasedReason = 'expiry';
          row.updatedAt = now;
          swept.push(clone(row));
        }
      }
      return swept;
    },

    /** §4.5 step 4. Rowcount-0 (not 'reserved' anymore) is the caller's signal to reject. */
    async consume(reservationId, now) {
      const state = currentState();
      const row = state.reservations.get(reservationId);
      if (!row || row.status !== 'reserved') return null;
      row.status = 'consumed';
      row.consumedAt = now;
      row.updatedAt = now;
      return clone(row);
    },

    /** §4.3 — bind matchId at snapshot issuance, once allocation is known. */
    async bindMatch(reservationId, matchId, now) {
      const state = currentState();
      const row = state.reservations.get(reservationId);
      if (!row) throw new ApiError('NOT_FOUND', `Reservation ${reservationId} not found.`);
      row.matchId = matchId;
      row.updatedAt = now;
      return clone(row);
    },
  };

  const snapshots = {
    async create(row) {
      const state = currentState();
      const snapshotId = row.snapshotId ?? ulid();
      const stored = {
        snapshotId, reservationId: row.reservationId, matchId: row.matchId,
        issuedAt: row.issuedAt, expiresAt: row.expiresAt, consumedAt: null,
        createdAt: new Date().toISOString(),
      };
      state.snapshots.set(snapshotId, stored);
      return clone(stored);
    },
    async byId(snapshotId) {
      const row = currentState().snapshots.get(snapshotId);
      return row ? clone(row) : null;
    },

    /** §4.4's atomic consume: unknown id, already-consumed, or expired all return null. */
    async consume(snapshotId, now) {
      const state = currentState();
      const row = state.snapshots.get(snapshotId);
      if (!row || row.consumedAt !== null || row.expiresAt <= now) return null;
      row.consumedAt = now;
      return clone(row);
    },

    /**
     * §4.5 step 3d: the wire payload (§4.1) carries `reservationId`, not `snapshotId` — the
     * verifier has no snapshot id to look up by. Resolves to the most recently issued live
     * (unconsumed, unexpired) snapshot for that reservation and atomically consumes it. In the
     * normal flow exactly one live snapshot exists per reservation at a time.
     */
    async consumeForReservation(reservationId, now) {
      const state = currentState();
      let best = null;
      for (const row of state.snapshots.values()) {
        if (row.reservationId !== reservationId || row.consumedAt !== null || row.expiresAt <= now) continue;
        if (!best || row.issuedAt > best.issuedAt) best = row;
      }
      if (!best) return null;
      best.consumedAt = now;
      return clone(best);
    },

    /** Compensating rollback for the narrow window between a consumed snapshot and a
     * reservation that turned out not to be 'reserved' anymore (§4.5 step 4's own note: "the
     * snapshot's atomic consume from step 3d rolls back too — the snapshot is NOT spent"). */
    async unconsume(snapshotId) {
      const state = currentState();
      const row = state.snapshots.get(snapshotId);
      if (row) row.consumedAt = null;
    },
  };

  return {
    driver: 'memory',
    tx,
    reservations, snapshots,
    async close() {},
  };
}

// -------------------------------------------------------------------------------- postgres

const toIso = (v) => (v instanceof Date ? v.toISOString() : v);

function rowToReservation(r) {
  if (!r) return null;
  return {
    reservationId: r.reservation_id, accountId: r.account_id, loadoutId: r.loadout_id,
    roomId: r.room_id, matchId: r.match_id, instanceIds: r.instance_ids, status: r.status,
    reservedAt: toIso(r.reserved_at), expiresAt: toIso(r.expires_at),
    consumedAt: toIso(r.consumed_at), releasedAt: toIso(r.released_at),
    releasedReason: r.released_reason, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at),
  };
}

function rowToSnapshot(r) {
  if (!r) return null;
  return {
    snapshotId: r.snapshot_id, reservationId: r.reservation_id, matchId: r.match_id,
    issuedAt: toIso(r.issued_at), expiresAt: toIso(r.expires_at), consumedAt: toIso(r.consumed_at),
    createdAt: toIso(r.created_at),
  };
}

export function createPostgresDeploymentStore(config = {}, deps = {}) {
  // Lazily required so `pg` (an optionalDependency) is never imported by a caller that only
  // ever runs the memory adapter — same pattern as inventory/store.js and core/store/postgres.js.
  const { Pool } = deps.pg ?? requirePg();
  const ulid = deps.ulid ?? defaultUlid;
  const pool = new Pool(config.pool ?? config);
  const pgTxContext = new AsyncLocalStorage();

  function requirePg() {
    // eslint-disable-next-line global-require
    return require('pg');
  }

  async function tx(fn) {
    const enrolled = pgTxContext.getStore();
    if (enrolled) return fn(enrolled);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await pgTxContext.run(client, () => fn(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  function runner(passed) {
    return passed ?? pgTxContext.getStore() ?? pool;
  }

  const reservations = {
    async create(row, t) {
      const q = runner(t);
      const reservationId = row.reservationId ?? ulid();
      try {
        const { rows } = await q.query(
          `insert into deployment_reservations
             (reservation_id, account_id, loadout_id, room_id, match_id, instance_ids, expires_at)
           values ($1,$2,$3,$4,$5,$6,$7) returning *`,
          [reservationId, row.accountId, row.loadoutId ?? null, row.roomId ?? null,
            row.matchId ?? null, row.instanceIds, row.expiresAt],
        );
        return rowToReservation(rows[0]);
      } catch (err) {
        if (err.code === '23505') throw new ApiError('CONFLICT', `Reservation ${reservationId} already exists.`);
        throw err;
      }
    },
    async byId(reservationId, t) {
      const { rows } = await runner(t).query(
        'select * from deployment_reservations where reservation_id = $1', [reservationId]);
      return rowToReservation(rows[0]);
    },
    async listForAccount(accountId, t) {
      const { rows } = await runner(t).query(
        'select * from deployment_reservations where account_id = $1 order by created_at', [accountId]);
      return rows.map(rowToReservation);
    },
    async release(reservationId, reason, now, t) {
      const { rows } = await runner(t).query(
        `update deployment_reservations
            set status = 'released', released_at = $2, released_reason = $3
          where reservation_id = $1 and status = 'reserved'
          returning *`,
        [reservationId, now, reason],
      );
      return rowToReservation(rows[0]) ?? null;
    },
    async sweepExpired(now, t) {
      const { rows } = await runner(t).query(
        `update deployment_reservations
            set status = 'expired', released_at = $1, released_reason = 'expiry'
          where status = 'reserved' and expires_at < $1
          returning *`,
        [now],
      );
      return rows.map(rowToReservation);
    },
    async consume(reservationId, now, t) {
      const { rows } = await runner(t).query(
        `update deployment_reservations
            set status = 'consumed', consumed_at = $2
          where reservation_id = $1 and status = 'reserved'
          returning *`,
        [reservationId, now],
      );
      return rowToReservation(rows[0]) ?? null;
    },
    async bindMatch(reservationId, matchId, now, t) {
      const { rows } = await runner(t).query(
        `update deployment_reservations set match_id = $2, updated_at = $3
          where reservation_id = $1 returning *`,
        [reservationId, matchId, now],
      );
      if (!rows[0]) throw new ApiError('NOT_FOUND', `Reservation ${reservationId} not found.`);
      return rowToReservation(rows[0]);
    },
  };

  const snapshots = {
    async create(row, t) {
      const q = runner(t);
      const snapshotId = row.snapshotId ?? ulid();
      const { rows } = await q.query(
        `insert into deployment_snapshots
           (snapshot_id, reservation_id, match_id, issued_at, expires_at)
         values ($1,$2,$3,$4,$5) returning *`,
        [snapshotId, row.reservationId, row.matchId, row.issuedAt, row.expiresAt],
      );
      return rowToSnapshot(rows[0]);
    },
    async byId(snapshotId, t) {
      const { rows } = await runner(t).query(
        'select * from deployment_snapshots where snapshot_id = $1', [snapshotId]);
      return rowToSnapshot(rows[0]);
    },
    async consume(snapshotId, now, t) {
      const { rows } = await runner(t).query(
        `update deployment_snapshots set consumed_at = $2
          where snapshot_id = $1 and consumed_at is null and expires_at > $2
          returning *`,
        [snapshotId, now],
      );
      return rowToSnapshot(rows[0]) ?? null;
    },
    async consumeForReservation(reservationId, now, t) {
      // The `FOR UPDATE` inner select + `consumed_at is null` re-check on the outer UPDATE is
      // what makes two concurrent verify-snapshot calls for the same reservation resolve to
      // exactly one winner: the loser's row lock blocks until the winner commits, then its own
      // outer WHERE no longer matches (see store.js's module comment for the reasoning).
      const { rows } = await runner(t).query(
        `update deployment_snapshots set consumed_at = $2
          where snapshot_id = (
            select snapshot_id from deployment_snapshots
             where reservation_id = $1 and consumed_at is null and expires_at > $2
             order by issued_at desc limit 1
             for update
          )
          and consumed_at is null
          returning *`,
        [reservationId, now],
      );
      return rowToSnapshot(rows[0]) ?? null;
    },
    async unconsume(snapshotId, t) {
      await runner(t).query(
        'update deployment_snapshots set consumed_at = null where snapshot_id = $1', [snapshotId]);
    },
  };

  return {
    driver: 'postgres',
    tx,
    reservations, snapshots,
    async close() { await pool.end(); },
  };
}
