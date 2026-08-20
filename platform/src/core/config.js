/**
 * Typed configuration.  Build Plan §P1.A1.
 *
 * Fails fast on anything missing or malformed rather than defaulting silently, because a
 * platform that boots with half its configuration absent fails later, in production, in a way
 * that looks like a bug in something else.
 */
import { ApiError } from './errors.js';

const SPEC = {
  port:            { env: 'PLATFORM_PORT', type: 'int', default: 8090 },
  logLevel:        { env: 'PLATFORM_LOG_LEVEL', type: 'string', default: 'info' },
  databaseUrl:     { env: 'DATABASE_URL', type: 'string', default: null },
  storage:         { env: 'PLATFORM_STORAGE', type: 'enum', values: ['memory', 'postgres'], default: 'memory' },
  accessTokenTtlSec:  { env: 'PLATFORM_ACCESS_TTL', type: 'int', default: 15 * 60 },
  refreshTokenTtlSec: { env: 'PLATFORM_REFRESH_TTL', type: 'int', default: 30 * 24 * 3600 },
  tokenSecret:     { env: 'PLATFORM_TOKEN_SECRET', type: 'string', default: null, requiredInProd: true },
  minClientBuild:  { env: 'PLATFORM_MIN_CLIENT_BUILD', type: 'string', default: null },
  minimumAge:      { env: 'PLATFORM_MINIMUM_AGE', type: 'int', default: 13 },
  consentPolicyVersion: { env: 'PLATFORM_CONSENT_POLICY_VERSION', type: 'int', default: 1 },
  termsVersion:    { env: 'PLATFORM_TERMS_VERSION', type: 'int', default: 1 },
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
      const n = Number(raw);
      if (!Number.isInteger(n)) { problems.push(`${spec.env} must be an integer, got ${JSON.stringify(raw)}`); continue; }
      out[key] = n;
    } else if (spec.type === 'enum') {
      if (!spec.values.includes(raw)) { problems.push(`${spec.env} must be one of ${spec.values.join('|')}, got ${JSON.stringify(raw)}`); continue; }
      out[key] = raw;
    } else out[key] = raw;
  }
  if (out.storage === 'postgres' && !out.databaseUrl) problems.push('DATABASE_URL is required when PLATFORM_STORAGE=postgres');
  if (problems.length) {
    const err = new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    err.problems = problems;
    throw err;
  }
  return Object.freeze(out);
}

export { ApiError };
