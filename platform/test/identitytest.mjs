import {
  createIdentityProvider, createLocalIdentityProvider, createSupabaseIdentityProvider,
} from '../src/modules/auth/identity.js';

let passed = 0; let failed = 0;
const check = (condition, label, detail = '') => {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}\n       ${detail}`); }
};

const local = createLocalIdentityProvider();
const localCredential = await local.create({ password: 'correct horse battery staple' });
check(local.kind === 'local-test' && await local.verify({
  password: 'correct horse battery staple', reference: localCredential.passwordHash,
}), 'the local provider verifies its KDF record outside production');
check(!(await local.verify({ password: 'wrong', reference: localCredential.passwordHash })),
  'the local provider refuses a wrong password');
let verifiedReference = null;
const structural = createLocalIdentityProvider({
  hashImpl: () => 'scrypt$dummy-record',
  verifyImpl: (_password, reference) => { verifiedReference = reference; return false; },
});
await structural.verify({ password: 'guess', reference: null });
check(verifiedReference === 'scrypt$dummy-record',
  'a nonexistent local identity still executes verification against a KDF-shaped dummy record');

let prodError = null;
try { createIdentityProvider({ config: { env: 'production', identityProvider: 'local' } }); }
catch (err) { prodError = err; }
check(/forbidden in production/.test(prodError?.message || ''),
  'production refuses to boot on the local identity fallback', prodError?.message);

const calls = [];
const replies = [
  { ok: true, status: 200, body: { id: 'provider-user-1' } },
  { ok: true, status: 200, body: { user: { id: 'provider-user-1' } } },
  { ok: true, status: 200, body: { id: 'provider-user-1' } },
  { ok: true, status: 204, body: null },
];
const fetchImpl = async (url, init) => {
  calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
  const next = replies.shift();
  return { ok: next.ok, status: next.status, async json() { return next.body; } };
};
const supabase = createSupabaseIdentityProvider({
  config: { supabaseAuthUrl: 'https://project.supabase.co', supabaseServiceRoleKey: 'service-key' },
  fetchImpl,
});
const providerCredential = await supabase.create({
  email: 'player@example.invalid', password: 'secret-password', accountId: 'account-1',
});
check(providerCredential.passwordHash === null
    && providerCredential.identityProvider === 'supabase'
    && providerCredential.identitySubject === 'provider-user-1',
  'Supabase returns an opaque provider subject in its dedicated columns, never its session token',
  JSON.stringify(providerCredential));
check(calls[0].body.email_confirm === true
    && calls[0].body.app_metadata.overstrike_account_id === 'account-1',
  'provider email is confirmed because Overstrike owns the incomplete-verification gate',
  JSON.stringify(calls[0].body));
check(await supabase.verify({
  email: 'player@example.invalid', password: 'secret-password',
  subject: providerCredential.identitySubject,
}), 'password verification binds the Supabase user id to the stored provider reference');
check(!calls.some((c) => JSON.stringify(c.body || {}).includes('accountId')),
  'the provider receives no platform bearer or session authority');
const replaced = await supabase.replace({ password: 'new-secret-password',
  subject: providerCredential.identitySubject });
check(replaced.identitySubject === providerCredential.identitySubject && replaced.passwordHash === null,
  'password replacement preserves the provider reference');
await supabase.remove({ subject: providerCredential.identitySubject });
check(calls[3].init.method === 'DELETE', 'failed account creation can compensate the provider user');

const deleteFailure = createSupabaseIdentityProvider({
  config: { supabaseAuthUrl: 'https://project.supabase.co', supabaseServiceRoleKey: 'secret-key' },
  fetchImpl: async () => ({ ok: false, status: 500, async json() { return { message: 'unsafe' }; } }),
});
let deleteError = null;
try { await deleteFailure.remove({ subject: 'orphan-provider-user' }); }
catch (error) { deleteError = error; }
check(deleteError?.code === 'SERVICE_UNAVAILABLE',
  'provider DELETE 500 makes failed compensation observable instead of claiming cleanup');

const auditProvider = createSupabaseIdentityProvider({
  config: { supabaseAuthUrl: 'https://project.supabase.co', supabaseServiceRoleKey: 'secret-key' },
  fetchImpl: async () => ({ ok: true, status: 200, async json() { return { users: [{
    id: 'orphan-provider-user', app_metadata: { overstrike_account_id: 'missing-account' },
  }] }; } }),
});
const providerAudit = await auditProvider.health({ accountById: async () => null });
check(providerAudit.ok === false && providerAudit.orphanCount === 1,
  'production readiness explicitly reports provider users whose platform account never committed');

let auditPageCalls = 0;
const pagedAuditProvider = createSupabaseIdentityProvider({
  config: { supabaseAuthUrl: 'https://project.supabase.co', supabaseServiceRoleKey: 'secret-key' },
  fetchImpl: async (url) => {
    auditPageCalls++;
    const page = new URL(url).searchParams.get('page');
    return { ok: true, status: 200, async json() { return { users: page === '1'
      ? Array.from({ length: 1000 }, (_, index) => ({ id: `unmanaged-${index}` }))
      : [{ id: 'late-orphan', app_metadata: { overstrike_account_id: 'missing-late' } }] }; } };
  },
});
const pagedAudit = await pagedAuditProvider.health({ accountById: async () => null });
check(auditPageCalls === 2 && pagedAudit.ok === false && pagedAudit.orphanCount === 1,
  'identity readiness audits every Supabase admin page instead of declaring late-page orphans healthy');

const unavailable = createSupabaseIdentityProvider({
  config: { supabaseAuthUrl: 'https://project.supabase.co', supabaseServiceRoleKey: 'do-not-log-me' },
  fetchImpl: async () => ({ ok: false, status: 503, async json() {
    return { message: 'upstream included do-not-log-me in an unsafe body' };
  } }),
});
let unavailableError = null;
try {
  await unavailable.verify({ email: 'player@example.invalid', password: 'secret',
    subject: 'provider-user-1' });
} catch (error) { unavailableError = error; }
check(unavailableError?.code === 'SERVICE_UNAVAILABLE'
    && !String(unavailableError?.message).includes('do-not-log-me'),
  'Supabase token-endpoint outages map generically without leaking service-role material');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
