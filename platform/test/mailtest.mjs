import { createMailer } from '../src/modules/mail/index.js';
import { loadConfig } from '../src/core/config.js';

let passed = 0; let failed = 0;
const check = (condition, label, detail = '') => {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}\n       ${detail}`); }
};

const PROD = {
  NODE_ENV: 'production', PLATFORM_TOKEN_SECRET: 'a-sufficiently-long-production-secret-value',
  PLATFORM_MATCH_TICKET_SECRET: 'a-separate-production-match-ticket-secret',
  PLATFORM_MATCH_CONTROL_SECRET: 'a-separate-production-match-control-secret',
  PLATFORM_SERVICE_TOKEN: 'a-sufficiently-long-production-service-token',
  PLATFORM_MATCH_SERVER_URL: 'wss://match.example.invalid',
  PLATFORM_IDENTITY_PROVIDER: 'supabase', SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
};
/**
 * This asserted that production REFUSED to boot without Resend. That rule was relaxed on the
 * human owner's instruction (config.js records what it costs: no verification mail, no
 * recovery delivery). The assertion is updated rather than deleted, because the interesting
 * property is not "mail is mandatory" — it is that the ADJACENT guards did not move with it.
 *
 * A relaxation is where neighbouring rules quietly go missing, so each is asserted here.
 */
const bootProblems = (env) => {
  try { loadConfig({ ...PROD, ...env }); return null; } catch (error) { return error.problems || []; }
};

check(bootProblems({ PLATFORM_MAIL_TRANSPORT: 'none' }) === null,
  "production boots with mail 'none' — deliberately allowed, and it means no code is ever sent");

check((bootProblems({ PLATFORM_MAIL_TRANSPORT: 'log' }) || [])
  .some((p) => p.includes("must be 'resend' or 'none'")),
  "production still refuses 'log' — it prints tokens, and a verification token IS the credential");

check((bootProblems({ PLATFORM_MAIL_TRANSPORT: 'resend' }) || [])
  .some((p) => p.includes('PLATFORM_MAIL_FROM and PLATFORM_MAIL_API_KEY')),
  'production still refuses a Resend transport with no key — configured and unable to send is '
  + 'worse than honestly disabled, because it reports success and delivers nothing');

check((bootProblems({ PLATFORM_MAIL_TRANSPORT: 'none', SUPABASE_SERVICE_ROLE_KEY: '' }) || [])
  .some((p) => p.includes('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')),
  'and the identity guard beside it is untouched by the mail relaxation');

let halfMailError = null;
try { loadConfig({ ...PROD, PLATFORM_MAIL_TRANSPORT: 'resend' }); }
catch (error) { halfMailError = error; }
check(halfMailError?.problems?.includes(
  'PLATFORM_MAIL_FROM and PLATFORM_MAIL_API_KEY are required for the Resend mail transport'),
  'Resend without its From identity and API credential is not ready');

const calls = []; const logs = [];
const mailer = createMailer({
  config: { env: 'production', mailTransport: 'resend', mailFrom: 'Overstrike <accounts@example.invalid>',
    mailApiKey: 'never-log-this-key', mailApiUrl: 'https://api.resend.com/emails',
    publicBaseUrl: 'https://overstrike.example', appName: 'Overstrike' },
  logger: { info: (...args) => logs.push(args), error: (...args) => logs.push(args) },
  fetchImpl: async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, async json() { return { id: 'mail-1' }; } };
  },
});
const sent = await mailer.sendRecovery({ email: 'player@example.invalid', token: 'secret-reset-token',
  correlationId: '01K3Q5HBZQ103Q3T3G7W5E4A11' });
check(sent.delivered === true && calls[0].body.to[0] === 'player@example.invalid'
    && calls[0].body.text.includes('30 minutes'),
  'recovery mail is sent to the stored address with the exact 30-minute lifetime');
check(!JSON.stringify(logs).includes('secret-reset-token')
    && !JSON.stringify(logs).includes('never-log-this-key'),
  'successful delivery logs neither the recovery credential nor the provider API key');
check((await mailer.health()).ok === true,
  'production readiness exposes configured Resend as an up dependency without sending a probe mail');

const unsafeLogs = [];
const failedMailer = createMailer({
  config: { env: 'production', mailTransport: 'resend', mailFrom: 'accounts@example.invalid',
    mailApiKey: 'echoed-secret', mailApiUrl: 'https://api.resend.com/emails' },
  logger: { info() {}, error: (...args) => unsafeLogs.push(args) },
  fetchImpl: async () => ({ ok: false, status: 401,
    async text() { return 'authorization Bearer echoed-secret'; } }),
});
const refused = await failedMailer.sendVerification({ email: 'player@example.invalid', token: 'verify-secret' });
check(refused.delivered === false && refused.reason === 'transport_error'
    && !JSON.stringify(unsafeLogs).includes('echoed-secret')
    && !JSON.stringify(unsafeLogs).includes('verify-secret'),
  'provider failures stay generic even when an upstream body echoes credentials');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
