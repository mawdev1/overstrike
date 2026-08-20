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
 * Apply everything pending. `client` is any pg client or pool with `.query`; pass one when
 * the caller already has a connection, otherwise supply `databaseUrl` and one is opened here.
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

// CLI: `node platform/src/core/migrate.js`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set');
    process.exit(2);
  }
  try {
    const r = await runMigrations({ databaseUrl });
    console.log(r.applied.length
      ? `applied ${r.applied.length}: ${r.applied.join(', ')}`
      : `nothing to do (${r.alreadyApplied} already applied)`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
