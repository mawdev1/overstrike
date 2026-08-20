/**
 * Typed configuration.  Build Plan §P1.A1.
 *
 * Fails fast on anything missing or malformed rather than defaulting silently, because a
 * platform that boots with half its configuration absent fails later, in production, in a way
 * that looks like a bug in something else.
 */
import { ApiError } from './errors.js';

const SPEC = {
  port:            { env: 'PLATFORM_PORT', type: 'int', default: 8090, min: 1, max: 65535 },
  logLevel:        { env: 'PLATFORM_LOG_LEVEL', type: 'enum', values: ['debug', 'info', 'warn', 'error'], default: 'info' },
  databaseUrl:     { env: 'DATABASE_URL', type: 'string', default: null },
  storage:         { env: 'PLATFORM_STORAGE', type: 'enum', values: ['memory', 'postgres'], default: 'memory' },
  accessTokenTtlSec:  { env: 'PLATFORM_ACCESS_TTL', type: 'int', default: 15 * 60, min: 1, max: 86400 },
  refreshTokenTtlSec: { env: 'PLATFORM_REFRESH_TTL', type: 'int', default: 30 * 24 * 3600, min: 60, max: 365 * 24 * 3600 },
  tokenSecret:     { env: 'PLATFORM_TOKEN_SECRET', type: 'string', default: null, requiredInProd: true },
  serviceToken:    { env: 'PLATFORM_SERVICE_TOKEN', type: 'string', default: null, requiredInProd: true },
  trustedProxyHops: { env: 'PLATFORM_TRUSTED_PROXY_HOPS', type: 'int', default: 0, min: 0, max: 8 },
  minClientBuild:  { env: 'PLATFORM_MIN_CLIENT_BUILD', type: 'string', default: null },
  minimumAge:      { env: 'PLATFORM_MINIMUM_AGE', type: 'int', default: 13, min: 0, max: 120 },
  consentPolicyVersion: { env: 'PLATFORM_CONSENT_POLICY_VERSION', type: 'int', default: 1, min: 1, max: 1e6 },
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

  // Secrets are mandatory in production (requiredInProd above). Outside it, a fixed,
  // obviously-fake value keeps local work frictionless without ever being mistakable for a
  // real one — and it is long enough to satisfy the signers, which reject short keys.
  if (out.env !== 'production') {
    if (!out.tokenSecret) out.tokenSecret = 'DEV-ONLY-INSECURE-TOKEN-SECRET-do-not-ship';
    if (!out.serviceToken) out.serviceToken = 'DEV-ONLY-INSECURE-SERVICE-TOKEN-do-not-ship';
  }
  if (problems.length) {
    const err = new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    err.problems = problems;
    throw err;
  }
  return Object.freeze(out);
}

export { ApiError };
