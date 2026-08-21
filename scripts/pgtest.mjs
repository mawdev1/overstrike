/**
 * Run the platform suite against a REAL PostgreSQL.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────
 * `storetest.mjs` skips its Postgres half whenever `DATABASE_URL` is absent, and CI never set
 * one. So "store runs clean" meant the memory adapter only, and across a dozen review passes
 * at least five defects lived exactly in that gap:
 *
 *   - `audit_log` was not append-only as deployed, because the grant targeted a role the
 *     migrations never created. Memory could not see it; the database proved it in one query.
 *   - SQL injection through object KEYS, which has no memory-adapter analogue at all.
 *   - `pg` renders a JS array as a Postgres array literal, so a `rounds` column would have
 *     been written as garbage. Memory round-tripped it perfectly.
 *   - `upsertIfVersion` returned a false CAS success on a fresh insert on Postgres only.
 *   - Divergences where memory threw NOT_FOUND and Postgres was silent.
 *
 * Every one of those is a defect a memory-green suite reports as passing. A skip that prints
 * `skip` is honest; a skip nobody ever un-skips is a hole with a label on it.
 *
 * Usage:
 *   node scripts/pgtest.mjs              # start a throwaway container, migrate, test, remove
 *   DATABASE_URL=... node scripts/pgtest.mjs --no-docker   # use a database you already have
 */
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * Container name and port are PER RUN.
 *
 * They were fixed, and the script's first act is `docker rm -f <name>` — so two runs on one
 * machine destroy each other's database mid-suite. The victim sees `ECONNREFUSED` from whichever
 * suite happened to be executing, which reads as an adapter defect and is not one; the failing
 * suite even moves between runs. Two agents working this repository at once is the normal case,
 * so the fixed name was a reproducible way to manufacture flaky evidence.
 */
const CONTAINER = `overstrike-pgtest-${process.pid}`;
const IMAGE = 'postgres:16-alpine';
const PASSWORD = 'overstrike-test';
const PORT = 55000 + (process.pid % 4000);
const URL = `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres`;

const flag = (k) => process.argv.slice(2).includes(`--${k}`);
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

function dockerAvailable() {
  const v = sh('docker', ['info']);
  return v.status === 0;
}

function removeContainer() {
  sh('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
}

/**
 * Wait for the server to accept connections.
 *
 * `docker run` returns as soon as the container starts, not when Postgres is ready, and a
 * connection refused two hundred milliseconds too early looks exactly like a broken adapter.
 */
function waitForReady(timeoutMs = 60_000) {
  const started = Date.now();
  for (;;) {
    if (sh('docker', ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-q']).status === 0
        && acceptsConnections()) return true;
    if (Date.now() - started > timeoutMs) return false;
    // Busy-wait in 250 ms slices without pulling in a sleep dependency.
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{},250)']);
  }
}

/**
 * `pg_isready` is not the readiness this script needs.
 *
 * It answers on the container's UNIX socket, and the image's entrypoint runs initdb against a
 * temporary server on that socket before restarting for real — so it reports ready while the
 * published TCP port either refuses the connection or resets it mid-handshake. That is exactly
 * what happened: `pgtest` started a container, declared it ready, and failed the migration step
 * with `read ECONNRESET` before running a single assertion, which reads as a broken adapter
 * rather than a harness that asked the wrong question.
 *
 * The honest probe is the connection the suite itself will make, over TCP, with a query on it.
 */
function acceptsConnections() {
  const probe = "import pg from 'pg';"
    + 'const c = new pg.Client(process.argv[1]);'
    + "await c.connect(); await c.query('select 1'); await c.end();";
  return sh(process.execPath, ['--input-type=module', '-e', probe, URL], { stdio: 'ignore' }).status === 0;
}

let startedByUs = false;
let databaseUrl = process.env.DATABASE_URL || null;

if (!flag('no-docker')) {
  if (!dockerAvailable()) {
    // Locally, a missing Docker is an environment fact and skipping is honest. In CI it is a
    // silently memory-only run wearing a green tick — which is the exact failure this harness
    // exists to end. CI must set CI=1 (or --require-db) so absence of a database FAILS.
    const mustHaveDb = flag('require-db') || process.env.CI === '1' || process.env.CI === 'true';
    console.log('pgtest: docker is not available.');
    if (mustHaveDb) {
      console.error('pgtest: CI requires a real database. A memory-only run is not a pass.');
      console.error('pgtest: provide DATABASE_URL and pass --no-docker, or make docker available.');
      process.exit(1);
    }
    console.log('pgtest: this is a SKIP, and a skip is not a pass — the Postgres adapter was not exercised.');
    process.exit(0);
  }
  removeContainer();
  console.log(`pgtest: starting ${IMAGE} as ${CONTAINER} on ${PORT}`);
  const run = sh('docker', ['run', '-d', '--name', CONTAINER,
    '-e', `POSTGRES_PASSWORD=${PASSWORD}`, '-p', `${PORT}:5432`, IMAGE]);
  if (run.status !== 0) {
    console.error('pgtest: failed to start the container');
    console.error(run.stderr);
    process.exit(1);
  }
  startedByUs = true;
  if (!waitForReady()) {
    console.error('pgtest: the database never became ready');
    removeContainer();
    process.exit(1);
  }
  databaseUrl = URL;
}

if (!databaseUrl) {
  console.error('pgtest: no DATABASE_URL and --no-docker was passed');
  process.exit(1);
}

let failed = 0;
try {
  const env = { ...process.env, DATABASE_URL: databaseUrl, PLATFORM_STORAGE: 'postgres' };

  console.log('pgtest: applying migrations');
  const migrate = sh(process.execPath, ['platform/src/core/migrate.js'], { env, stdio: 'inherit' });
  if (migrate.status !== 0) { console.error('pgtest: migrations failed'); failed++; }

  if (!failed && !flag('lobby-only')) {
    console.log('pgtest: running the platform suite against Postgres');
    const suite = sh(process.execPath, ['scripts/platformtest.mjs'], { env, stdio: 'inherit' });
    if (suite.status !== 0) failed++;
  }

  if (!failed) {
    console.log('pgtest: running six-client live lobby/handoff against Postgres');
    const lobby = sh(process.execPath, ['scripts/lobbytest.mjs'], { env, stdio: 'inherit' });
    if (lobby.status !== 0) failed++;
  }

  if (!failed) {
    console.log('pgtest: injecting countdown, partial-handoff and live authority death against Postgres');
    const faults = sh(process.execPath, ['scripts/lifecyclefaulttest.mjs'], { env, stdio: 'inherit' });
    if (faults.status !== 0) failed++;
  }

  if (!failed) {
    // Re-running migrations must be a clean no-op. An operator WILL do this.
    console.log('pgtest: re-applying migrations (must be a no-op)');
    const again = sh(process.execPath, ['platform/src/core/migrate.js'], { env, stdio: 'inherit' });
    if (again.status !== 0) { console.error('pgtest: re-running migrations failed'); failed++; }
  }
} finally {
  if (startedByUs) {
    console.log('pgtest: removing the container');
    removeContainer();
  }
}

console.log(failed ? '\npgtest FAILED' : '\npgtest clean against real PostgreSQL');
process.exit(failed ? 1 : 0);
