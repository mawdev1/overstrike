import {
  createLegacyCutoverDb, createSupabaseLegacyAdmin, cutoverLegacyIdentities,
} from '../src/modules/auth/legacy-cutover.js';
import { createMemoryStore } from '../src/core/store/memory.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/core/config.js';
import { ulid } from '../src/core/ids.js';

let passed = 0; let failed = 0;
const check = (condition, label, detail = '') => {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}\n       ${detail}`); }
};

const legacy = { accountId: 'account-1', email: 'player@example.invalid',
  passwordHash: 'scrypt$legacy', identityProvider: null, identitySubject: null };
const dryDb = { async listUnready() { return [legacy]; } };
const dry = await cutoverLegacyIdentities({ db: dryDb });
check(dry.mode === 'dry-run' && dry.candidateCount === 1 && dry.migratedCount === 0,
  'cutover is a non-mutating dry-run unless --apply is explicit');

const calls = [];
const responses = [
  { ok: true, status: 200, body: { users: [], last_page: 1 } },
  { ok: true, status: 200, body: { id: 'provider-1', email: legacy.email,
    app_metadata: { overstrike_account_id: legacy.accountId } } },
];
const provider = createSupabaseLegacyAdmin({
  baseUrl: 'https://project.supabase.co', serviceRoleKey: 'never-log-this',
  passwordFactory: () => 'unknown-random-password',
  fetchImpl: async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const next = responses.shift();
    return { ok: next.ok, status: next.status, async json() { return next.body; } };
  },
});
let state = { ...legacy };
const db = {
  async listUnready() { return [state]; },
  async attach({ expectedPasswordHash, subject }) {
    if (state.passwordHash !== expectedPasswordHash) return false;
    state = { ...state, passwordHash: null, identityProvider: 'supabase', identitySubject: subject };
    return true;
  },
  async state() { return state; },
};
const applied = await cutoverLegacyIdentities({ db, provider, apply: true });
check(applied.migratedCount === 1 && state.passwordHash === null
    && state.identitySubject === 'provider-1',
  'apply provisions a provider subject and atomically retires the legacy KDF reference');
const createBody = calls.find((call) => call.init?.method === 'POST')?.body;
check(createBody?.password === 'unknown-random-password'
    && createBody?.app_metadata?.password_reset_required === true
    && createBody?.email_confirm === true,
  'the provider credential is unknown and marked recovery-required while platform verification stays authoritative');

const adoptedCalls = [];
const adoptedProvider = createSupabaseLegacyAdmin({
  baseUrl: 'https://project.supabase.co', serviceRoleKey: 'secret',
  fetchImpl: async (url, init) => {
    adoptedCalls.push({ url, init });
    return { ok: true, status: 200, async json() { return { users: [{ id: 'provider-2',
      email: legacy.email, app_metadata: { overstrike_account_id: legacy.accountId } }], last_page: 1 }; } };
  },
});
const adopted = await adoptedProvider.provision(legacy);
check(adopted.subject === 'provider-2' && adopted.created === false
    && adoptedCalls.every((call) => call.init?.method !== 'POST'),
  'an interrupted run resumes by adopting only its account-bound provider identity');

let foreignError = null;
try {
  await createSupabaseLegacyAdmin({
    baseUrl: 'https://project.supabase.co', serviceRoleKey: 'secret',
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { users: [{
      id: 'foreign', email: legacy.email,
      app_metadata: { overstrike_account_id: 'some-other-account' },
    }], last_page: 1 }; } }),
  }).provision(legacy);
} catch (error) { foreignError = error; }
check(/not bound/.test(foreignError?.message || ''),
  'a same-email provider user owned by another account is never adopted');

let removed = 0;
let failedState = { ...legacy };
const compensatingProvider = {
  async provision() { return { subject: 'orphan', created: true }; },
  async remove(subject) { if (subject === 'orphan') removed++; },
};
let attachError = null;
try {
  await cutoverLegacyIdentities({
    apply: true, provider: compensatingProvider,
    db: {
      async listUnready() { return [failedState]; },
      async attach() { throw new Error('database failed'); },
      async state() { return failedState; },
    },
  });
} catch (error) { attachError = error; }
check(attachError?.message === 'database failed' && removed === 1,
  'a provider user created before a database failure is compensated without masking the cause');

const blocked = await cutoverLegacyIdentities({ db: { async listUnready() { return [{
  ...legacy, email: null,
}]; } } });
check(blocked.blockingCount === 1 && blocked.blockers[0].reason === 'missing-email',
  'an account without a recoverable stored email blocks the cutover');

const unreadyStore = createMemoryStore();
await unreadyStore.accounts.create({ ...legacy, displayName: 'Legacy',
  displayNameFolded: 'legacy', status: 'active' });
const readiness = await unreadyStore.accounts.identityReadiness();
check(readiness.ok === false && readiness.unreadyAccounts === 1,
  'the store exposes legacy accounts as a production identity-readiness failure');
let bootError = null;
try {
  await buildApp(loadConfig({
    NODE_ENV: 'production', PLATFORM_PORT: '0',
    PLATFORM_TOKEN_SECRET: 'a-sufficiently-long-production-secret-value',
    PLATFORM_MATCH_TICKET_SECRET: 'a-separate-production-match-ticket-secret',
    PLATFORM_MATCH_CONTROL_SECRET: 'a-separate-production-match-control-secret',
    PLATFORM_SERVICE_TOKEN: 'a-sufficiently-long-production-service-token',
    PLATFORM_DEPLOYMENT_SNAPSHOT_SECRET: 'a-separate-production-deployment-snapshot-secret',
    PLATFORM_MATCH_SERVER_URL: 'wss://match.example.invalid',
    PLATFORM_IDENTITY_PROVIDER: 'supabase', SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    PLATFORM_MAIL_TRANSPORT: 'resend', PLATFORM_MAIL_FROM: 'accounts@example.invalid',
    PLATFORM_MAIL_API_KEY: 'test-resend-api-key',
  }), { store: unreadyStore, logger: { debug() {}, info() {}, warn() {}, error() {} } });
} catch (error) { bootError = error; }
check(/1 account\(s\) require the Supabase identity cutover/.test(bootError?.message || ''),
  'production refuses to boot rather than stranding a legacy account');

if (process.env.DATABASE_URL) {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const accountId = ulid(); const sessionId = ulid(); const familyId = ulid();
    const passwordHash = 'scrypt$legacy-integration-record';
    await pool.query(`insert into accounts
      (account_id,status,email_hash,email,display_name,display_name_folded,password_hash)
      values ($1,'active',$2,$3,$4,$5,$6)`, [accountId, `hash-${accountId}`,
      `cutover-${accountId}@example.invalid`, `Cut${accountId.slice(-8)}`,
      `cut${accountId.slice(-8).toLowerCase()}`, passwordHash]);
    await pool.query(`insert into sessions (session_id,account_id,refresh_family_id)
      values ($1,$2,$3)`, [sessionId, accountId, familyId]);
    const pgDb = createLegacyCutoverDb(pool);
    const listed = (await pgDb.listUnready()).find((row) => row.accountId === accountId);
    check(listed?.passwordHash === passwordHash && listed?.email?.includes('@example.invalid'),
      'PostgreSQL dry-run selects the exact live legacy credential and recovery address');
    const attached = await pgDb.attach({ accountId, expectedPasswordHash: passwordHash,
      subject: `provider-${accountId}` });
    const [state, session] = await Promise.all([
      pgDb.state(accountId),
      pool.query('select revoked_at,revoked_reason from sessions where session_id=$1', [sessionId]),
    ]);
    check(attached && state.passwordHash === null && state.identityProvider === 'supabase'
      && state.identitySubject === `provider-${accountId}`,
    'PostgreSQL apply CAS-attaches the provider subject and clears the legacy KDF');
    check(session.rows[0]?.revoked_at && session.rows[0]?.revoked_reason === 'identity-provider-cutover'
      && !(await pgDb.attach({ accountId, expectedPasswordHash: passwordHash,
        subject: `provider-${accountId}` })),
    'the same transaction revokes sessions and cannot apply the legacy credential twice');
  } finally {
    await pool.end();
  }
} else {
  console.log('  skip PostgreSQL cutover SQL (DATABASE_URL is not set)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
