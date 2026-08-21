/**
 * Typed configuration.  Build Plan §P1.A1.
 *
 * Fails fast on anything missing or malformed rather than defaulting silently, because a
 * platform that boots with half its configuration absent fails later, in production, in a way
 * that looks like a bug in something else.
 */
import { ApiError } from './errors.js';
import { REGION_IDS } from '../shared/regions.js';

const SPEC = {
  // 0 is legitimate and means "let the OS assign a free port" — the standard way a test binds
  // without racing another. A min of 1 rejected it, which is strictness that forbids a correct
  // value rather than a wrong one.
  port:            { env: 'PLATFORM_PORT', type: 'int', default: 8090, min: 0, max: 65535 },
  logLevel:        { env: 'PLATFORM_LOG_LEVEL', type: 'enum', values: ['debug', 'info', 'warn', 'error'], default: 'info' },
  databaseUrl:     { env: 'DATABASE_URL', type: 'string', default: null },
  storage:         { env: 'PLATFORM_STORAGE', type: 'enum', values: ['memory', 'postgres'], default: 'memory' },
  identityProvider: { env: 'PLATFORM_IDENTITY_PROVIDER', type: 'enum', values: ['local', 'supabase'], default: 'local' },
  supabaseAuthUrl: { env: 'SUPABASE_URL', type: 'string', default: '' },
  supabaseServiceRoleKey: { env: 'SUPABASE_SERVICE_ROLE_KEY', type: 'string', default: '' },
  accessTokenTtlSec:  { env: 'PLATFORM_ACCESS_TTL', type: 'int', default: 15 * 60, min: 1, max: 86400 },
  refreshTokenTtlSec: { env: 'PLATFORM_REFRESH_TTL', type: 'int', default: 30 * 24 * 3600, min: 60, max: 365 * 24 * 3600 },
  tokenSecret:     { env: 'PLATFORM_TOKEN_SECRET', type: 'string', default: null, requiredInProd: true },
  matchTicketSecret: { env: 'PLATFORM_MATCH_TICKET_SECRET', type: 'string', default: null, requiredInProd: true },
  matchControlSecret: { env: 'PLATFORM_MATCH_CONTROL_SECRET', type: 'string', default: null, requiredInProd: true },
  serviceToken:    { env: 'PLATFORM_SERVICE_TOKEN', type: 'string', default: null, requiredInProd: true },
  trustedProxyHops: { env: 'PLATFORM_TRUSTED_PROXY_HOPS', type: 'int', default: 0, min: 0, max: 8 },
  minClientBuild:  { env: 'PLATFORM_MIN_CLIENT_BUILD', type: 'string', default: null },
  minimumAge:      { env: 'PLATFORM_MINIMUM_AGE', type: 'int', default: 13, min: 0, max: 120 },
  consentPolicyVersion: { env: 'PLATFORM_CONSENT_POLICY_VERSION', type: 'int', default: 1, min: 1, max: 1e6 },
  // feature-flags.md §3, rule 5: a kill switch must be reachable in seconds. An env override is
  // the fastest thing an operator has before a targeting service exists. Unknown keys and
  // non-boolean values are REFUSED at boot (modules/flags), because a typo'd kill switch that
  // silently does nothing fails at the exact moment it is most needed.
  flagOverrides: { env: 'PLATFORM_FLAG_OVERRIDES', type: 'string', default: '' },

  // Transactional mail. `none` keeps local development frictionless. Production requires
  // Resend because verification and recovery are credential paths, not optional notifications;
  // `log` is never production-safe because it prints the credential itself.
  mailTransport: { env: 'PLATFORM_MAIL_TRANSPORT', type: 'enum', values: ['none', 'log', 'resend'], default: 'none' },
  mailFrom: { env: 'PLATFORM_MAIL_FROM', type: 'string', default: '' },
  mailApiKey: { env: 'PLATFORM_MAIL_API_KEY', type: 'string', default: '' },
  mailApiUrl: { env: 'PLATFORM_MAIL_API_URL', type: 'string', default: '' },
  appName: { env: 'PLATFORM_APP_NAME', type: 'string', default: 'Overstrike' },
  // The origin a player's mail link points at — the SITE, not this API. They differ: the shell
  // is served from overstrike.fly.dev and proxies /v1 here, so a link built from this process's
  // own host would send players to an API that has no such page.
  publicBaseUrl: { env: 'PLATFORM_PUBLIC_BASE_URL', type: 'string', default: '' },
  lobbyPublicUrl: { env: 'PLATFORM_LOBBY_PUBLIC_URL', type: 'string', default: '' },
  // Secret-bearing paging endpoint (PagerDuty/Slack/incident relay). It is optional for local
  // development; production readiness reports the alert dependency down until it is present.
  alertWebhookUrl: { env: 'PLATFORM_ALERT_WEBHOOK_URL', type: 'string', default: '' },
  matchServerUrl: { env: 'PLATFORM_MATCH_SERVER_URL', type: 'string', default: 'ws://127.0.0.1:8080', requiredInProd: true },
  matchServerAllowedHosts: { env: 'PLATFORM_MATCH_SERVER_ALLOWED_HOSTS', type: 'string', default: '' },
  matchServerRegion: { env: 'PLATFORM_MATCH_SERVER_REGION', type: 'enum', values: [...REGION_IDS], default: 'iad' },
  termsVersion:    { env: 'PLATFORM_TERMS_VERSION', type: 'int', default: 1, min: 1, max: 1e6 },
  env:             { env: 'NODE_ENV', type: 'string', default: 'development' },
};

export function loadConfig(source = process.env) {
  const out = {};
  const problems = [];
  for (const [key, spec] of Object.entries(SPEC)) {
    const raw = source[spec.env];
    if (raw === undefined || raw === '') {
      if (spec.requiredInProd && (source.NODE_ENV === 'production')) {
        problems.push(`${spec.env} is required in production`);
      }
      out[key] = spec.default;
      continue;
    }
    if (spec.type === 'int') {
      // `Number()` accepts hex, exponent notation, and surrounding whitespace, so a file whose
      // stated purpose is failing fast on malformed input was accepting PLATFORM_PORT=0x1F90
      // and -1. Parse the shape we mean, then bound it.
      if (!/^-?\d+$/.test(String(raw).trim())) {
        problems.push(`${spec.env} must be an integer, got ${JSON.stringify(raw)}`); continue;
      }
      const n = Number(String(raw).trim());
      if (!Number.isSafeInteger(n)) { problems.push(`${spec.env} is out of range: ${JSON.stringify(raw)}`); continue; }
      if (spec.min !== undefined && n < spec.min) { problems.push(`${spec.env} must be >= ${spec.min}, got ${n}`); continue; }
      if (spec.max !== undefined && n > spec.max) { problems.push(`${spec.env} must be <= ${spec.max}, got ${n}`); continue; }
      out[key] = n;
    } else if (spec.type === 'enum') {
      if (!spec.values.includes(raw)) { problems.push(`${spec.env} must be one of ${spec.values.join('|')}, got ${JSON.stringify(raw)}`); continue; }
      out[key] = raw;
    } else out[key] = raw;
  }
  if (out.storage === 'postgres' && !out.databaseUrl) problems.push('DATABASE_URL is required when PLATFORM_STORAGE=postgres');
  try {
    const matchUrl = new URL(out.matchServerUrl);
    const loopback = matchUrl.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(matchUrl.hostname);
    if (matchUrl.protocol !== 'wss:' && !(source.NODE_ENV !== 'production' && loopback)) {
      problems.push('PLATFORM_MATCH_SERVER_URL must use wss (ws is allowed only on loopback outside production)');
    }
  } catch { problems.push('PLATFORM_MATCH_SERVER_URL must be an absolute WebSocket URL'); }
  if (out.matchServerAllowedHosts) {
    const hosts = out.matchServerAllowedHosts.split(',').map((value) => value.trim()).filter(Boolean);
    if (!hosts.length || hosts.some((host) => host.includes('/') || host.includes('@') || host.includes(':'))) {
      problems.push('PLATFORM_MATCH_SERVER_ALLOWED_HOSTS must be a comma-separated list of hostnames');
    }
  }
  if (out.env === 'production' && out.identityProvider !== 'supabase') {
    problems.push('PLATFORM_IDENTITY_PROVIDER=supabase is required in production');
  }
  if (out.identityProvider === 'supabase' && (!out.supabaseAuthUrl || !out.supabaseServiceRoleKey)) {
    problems.push('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the Supabase identity provider');
  }
  // RELAXED DELIBERATELY, on the human owner's instruction, 2026-08-21.
  //
  // This required `resend` in production, so the platform refused to boot without a Resend API
  // key. That is a defensible rule — a production account system that cannot email its users
  // cannot verify an address or recover an account — and it is being relaxed with that cost
  // stated rather than forgotten:
  //
  //   with `none`, onboarding step 5 asks for a code nothing will ever send, and account
  //   recovery has no delivery path. Signup still completes: verification does not gate it.
  //
  // What is NOT relaxed is the pairing below. `resend` without a key or a from-address still
  // fails at boot, because a transport that is configured and cannot send is worse than one
  // that is honestly disabled — it reports success to every caller and delivers nothing.
  // `modules/mail` refuses `log` in production for its own reason: it prints tokens, and a
  // verification token IS the credential.
  //
  // Restore this line the moment a key exists. The guard was right; the credential was missing.
  if (out.env === 'production' && !['resend', 'none'].includes(out.mailTransport)) {
    problems.push("PLATFORM_MAIL_TRANSPORT must be 'resend' or 'none' in production");
  }
  if (out.mailTransport === 'resend' && (!out.mailFrom || !out.mailApiKey)) {
    problems.push('PLATFORM_MAIL_FROM and PLATFORM_MAIL_API_KEY are required for the Resend mail transport');
  }
  if (out.alertWebhookUrl) {
    try {
      const url = new URL(out.alertWebhookUrl);
      if (url.protocol !== 'https:' && out.env === 'production') {
        problems.push('PLATFORM_ALERT_WEBHOOK_URL must use https in production');
      }
    } catch { problems.push('PLATFORM_ALERT_WEBHOOK_URL must be an absolute URL'); }
  }

  // Secrets are mandatory in production (requiredInProd above). Outside it, a fixed,
  // obviously-fake value keeps local work frictionless without ever being mistakable for a
  // real one — and it is long enough to satisfy the signers, which reject short keys.
  if (out.env !== 'production') {
    if (!out.tokenSecret) out.tokenSecret = 'DEV-ONLY-INSECURE-TOKEN-SECRET-do-not-ship';
    if (!out.matchTicketSecret) out.matchTicketSecret = 'DEV-ONLY-INSECURE-MATCH-TICKET-SECRET-do-not-ship';
    if (!out.matchControlSecret) out.matchControlSecret = 'DEV-ONLY-INSECURE-MATCH-CONTROL-SECRET-do-not-ship';
    if (!out.serviceToken) out.serviceToken = 'DEV-ONLY-INSECURE-SERVICE-TOKEN-do-not-ship';
  }
  /**
   * DERIVED, not configurable: can this deployment verify an email address at all?
   *
   * The onboarding chain gates step 5 on `emailVerifiedAt`, and the only way to set that column
   * is to enter a code from a message. With `mailTransport = 'none'` no message is ever sent, so
   * that step is not "slow" or "pending" — it is unreachable, and every account created is
   * parked on it forever. Relaxing the transport rule above while leaving the gate in place
   * would not have relaxed anything; it would have moved the refusal from boot to step 5, where
   * it looks like a bug in the mailer instead of a deliberate configuration.
   *
   * Derived rather than given its own environment variable ON PURPOSE. Two independent switches
   * would allow the state this cannot express: verification demanded while no transport can
   * deliver it. That is precisely the trap the config-vs-mail-module duplication set two deploys
   * ago, and one source of truth is the fix for it.
   *
   * Configure a transport and the gate returns by itself — nothing else has to be remembered.
   */
  out.emailVerificationRequired = out.mailTransport !== 'none';
  if (problems.length) {
    const err = new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    err.problems = problems;
    throw err;
  }
  return Object.freeze(out);
}

export { ApiError };
