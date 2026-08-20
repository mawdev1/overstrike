/**
 * Migration runner.  contracts/db-schema.md §8.
 *
 * Forward-only, sequentially numbered, one concern per file, and never edited after merge.
 * This runner enforces all three rather than trusting them:
 *
 *   - Out-of-order application is refused. Two branches that each add `0008_*.sql` merge into
 *     a schema whose final shape depends on which one was deployed first. Refusing to apply a
 *     migration that is older than one already applied turns that into a loud failure at
 *     deploy time instead of a silent divergence between staging and production.
 *   - Checksums are recorded and re-checked. An edited migration means the schema a fresh
 *     apply produces and the schema production actually got are different, and nothing else
 *     tells you which one is running.
 *   - An advisory lock is held for the whole run. Two instances of a rolling deploy start
 *     within milliseconds of each other; without the lock they both see the same pending list
 *     and both try to `create table`, and the loser's error is indistinguishable from a real
 *     migration failure.
 *
 * Each migration runs in its own transaction together with its `schema_migrations` row, so a
 * migration cannot be recorded as applied unless it applied. Postgres has transactional DDL;
 * this is the one place that is worth spending.
 */
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, '..', '..', 'migrations');

/** 64-bit constant, arbitrary but fixed: the lock is only meaningful if every deploy picks it. */
const ADVISORY_LOCK_KEY = '4207731001';

const FILENAME_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Read and validate the migration set. Naming is enforced here, not by convention. */
export async function loadMigrations(dir = MIGRATIONS_DIR) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  const out = [];
  const seen = new Set();
  for (const name of names) {
    const m = name.match(FILENAME_RE);
    if (!m) throw new Error(`migrate: bad migration filename ${name} (want NNNN_lower_snake.sql)`);
    const version = Number(m[1]);
    if (seen.has(version)) throw new Error(`migrate: duplicate migration version ${m[1]}`);
    seen.add(version);
    const sql = await readFile(join(dir, name), 'utf8');
    out.push({
      version,
      name: m[2],
      filename: name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  out.sort((a, b) => a.version - b.version);
  return out;
}

async function ensureTable(client) {
  await client.query(`
    create table if not exists schema_migrations (
      version      int primary key,
      name         text not null,
      checksum     text not null,
      applied_at   timestamptz not null default now(),
      duration_ms  int not null
    )`);
}

/** What the database believes it has, oldest first. */
export async function appliedMigrations(client) {
  await ensureTable(client);
  const { rows } = await client.query(
    'select version, name, checksum, applied_at, duration_ms from schema_migrations order by version');
  return rows.map((r) => ({
    version: r.version,
    name: r.name,
    checksum: r.checksum,
    appliedAt: r.applied_at instanceof Date ? r.applied_at.toISOString() : r.applied_at,
    durationMs: r.duration_ms,
  }));
}

/**
 * Compare history to files. Returns the pending list or throws with the specific reason,
 * because "migrations failed" is not something an operator can act on at 3am.
 */
export function planMigrations(files, applied) {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  for (const a of applied) {
    const f = byVersion.get(a.version);
    if (!f) {
      throw new Error(
        `migrate: the database has migration ${a.version} (${a.name}) which this checkout does not. `
        + 'The deploy is older than the database; roll forward, do not roll back.');
    }
    if (f.checksum !== a.checksum) {
      throw new Error(
        `migrate: ${f.filename} has changed since it was applied (checksum mismatch). `
        + 'Migrations are forward-only; a correction is a new migration, never an edit.');
    }
  }
  const appliedVersions = new Set(applied.map((a) => a.version));
  const pending = files.filter((f) => !appliedVersions.has(f.version));
  if (!pending.length) return pending;

  const highestApplied = applied.length ? Math.max(...applied.map((a) => a.version)) : -1;
  const lowestPending = pending[0].version;
  if (lowestPending < highestApplied) {
    throw new Error(
      `migrate: ${pending[0].filename} is older than applied migration ${highestApplied}. `
      + 'Out-of-order application produces a schema whose shape depends on deploy order. '
      + 'Renumber it above the highest applied version.');
  }
  return pending;
}

/**
 * A pool is not a connection, and this runner needs a connection.
 *
 * `pool.query()` takes a different pooled client per call. Both things this runner depends on
 * are per-session: `pg_advisory_lock` is held by the SESSION that took it, so the lock would be
 * taken on one connection and the unlock attempted on another, leaving the lock held until the
 * pool recycles; and `begin`/`commit` would be issued on unrelated connections, so each
 * migration's DDL and its schema_migrations row would land in two different transactions —
 * exactly the "recorded as applied but not applied" state the per-migration transaction exists
 * to prevent. Both failures are invisible on a single-connection pool and appear later.
 */
function assertDedicatedConnection(db) {
  if (!db || typeof db.query !== 'function') {
    throw new Error('migrate: `client` must be a connected pg Client (it has no .query)');
  }
  const pooled = typeof db.totalCount === 'number' || typeof db.idleCount === 'number'
    || typeof db.waitingCount === 'number' || typeof db.connect === 'function' && typeof db.options?.max === 'number';
  if (pooled) {
    throw new Error(
      'migrate: a Pool was passed where a dedicated connection is required. '
      + 'The advisory lock and the per-migration transaction are session-scoped, and a pool '
      + 'runs each statement on whichever connection is free. Pass `databaseUrl`, or a single '
      + 'client from `await pool.connect()`.');
  }
}

/**
 * Apply everything pending.
 *
 * Pass `databaseUrl` and a dedicated connection is opened and closed here — that is the
 * intended entry point. `client` is for a caller that already holds ONE connection (a
 * `pg.Client`, or a `PoolClient` from `pool.connect()`); a Pool is refused, loudly.
 */
export async function runMigrations({ databaseUrl, client, dir = MIGRATIONS_DIR } = {}, deps = {}) {
  const logger = deps.logger ?? null;
  let own = null;
  let db = client;
  if (!db) {
    if (!databaseUrl) throw new Error('migrate: need a client or a databaseUrl');
    const pg = await import('pg');
    own = new pg.default.Client({ connectionString: databaseUrl });
    await own.connect();
    db = own;
  } else {
    assertDedicatedConnection(db);
  }

  try {
    // Session-level lock, released explicitly below. A transaction-level lock would be
    // released at the first COMMIT, which is exactly the middle of the run.
    await db.query('select pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    try {
      const files = await loadMigrations(dir);
      const applied = await appliedMigrations(db);
      const pending = planMigrations(files, applied);
      const done = [];
      for (const f of pending) {
        const started = Date.now();
        await db.query('begin');
        try {
          await db.query(f.sql);
          await db.query(
            'insert into schema_migrations (version, name, checksum, duration_ms) values ($1,$2,$3,$4)',
            [f.version, f.name, f.checksum, Date.now() - started]);
          await db.query('commit');
        } catch (err) {
          await db.query('rollback');
          throw new Error(`migrate: ${f.filename} failed: ${err.message}`, { cause: err });
        }
        logger?.info('migration.applied', { version: f.version, name: f.name, ms: Date.now() - started });
        done.push(f.filename);
      }
      return { applied: done, alreadyApplied: applied.length };
    } finally {
      await db.query('select pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    }
  } finally {
    if (own) await own.end();
  }
}

/**
 * The deploy entry point.  `node platform/src/core/migrate.js`, or `migrateCli()` from a
 * process that owns the deploy.
 *
 * It is deliberately NOT called from `app.js` boot. A server that migrates on start migrates
 * once per instance in a rolling deploy, from N instances racing for the advisory lock, with
 * the losers blocked on it while their health checks time out — and a failed migration then
 * looks like a failed rollout rather than a failed migration. Migrations are a deploy step
 * that runs to completion before the new instances start.
 *
 * @returns {Promise<{applied: string[], alreadyApplied: number}>}
 */
export async function migrateCli({ databaseUrl = process.env.DATABASE_URL, dir = MIGRATIONS_DIR } = {},
  out = console) {
  if (!databaseUrl) {
    out.error('DATABASE_URL is not set');
    return { applied: [], alreadyApplied: 0, ok: false };
  }
  const r = await runMigrations({ databaseUrl, dir });
  out.log(r.applied.length
    ? `applied ${r.applied.length}: ${r.applied.join(', ')}`
    : `nothing to do (${r.alreadyApplied} already applied)`);
  return { ...r, ok: true };
}

// CLI: `node platform/src/core/migrate.js`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const r = await migrateCli();
    if (!r.ok) process.exit(2);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
