/**
 * Turn a `DATABASE_URL` into a `pg` connection config.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────
 * `pg` accepts `{ connectionString }` and parses it with `pg-connection-string`, which does
 * NOT strip the brackets from an IPv6 literal:
 *
 *   parse('postgres://u:p@[fdaa:0:1::2]:5432/db').host  ===  '[fdaa:0:1::2]'
 *
 * That string is then handed to `getaddrinfo`, which has no such host, so every connection
 * fails with `ENOTFOUND [fdaa:0:1::2]` — the brackets visible in the error being the only
 * clue. RFC 3986 requires the brackets in a URL, so the URL is correct and the parse is not.
 *
 * This is not a hypothetical. Fly.io Managed Postgres publishes its direct endpoint as an
 * IPv6 address with no DNS name, so the first deployment of this platform failed its release
 * command on exactly this, before a single migration ran.
 *
 * It matters more than a deployment papercut: the alternative endpoint is a pgbouncer in
 * transaction-pooling mode, and `core/migrate.js` holds a SESSION-scoped `pg_advisory_lock`
 * across its whole run. Under transaction pooling that lock is taken on one backend and
 * released from another, so the "only one migrator at a time" guarantee quietly stops
 * holding. Being unable to use a direct IPv6 endpoint therefore pushes an operator toward a
 * connection that breaks the migration lock — which is a correctness problem wearing a
 * connectivity problem's clothes.
 *
 * So: parse it ourselves, strip the brackets, and hand `pg` explicit fields.
 */
import { parse } from 'pg-connection-string';

/**
 * `pg` config for a URL, with IPv6 hosts unbracketed.
 *
 * Everything `pg-connection-string` understood is passed through unchanged — `sslmode`,
 * `application_name`, socket paths, the lot. Only `host` is touched, and only when it is a
 * bracketed literal, so a hostname or an IPv4 address takes the identical path it always did.
 */
export function pgConnectionConfig(databaseUrl) {
  if (typeof databaseUrl !== 'string' || databaseUrl === '') {
    throw new Error('pgConnectionConfig: databaseUrl must be a non-empty string');
  }
  const cfg = parse(databaseUrl);
  if (typeof cfg.host === 'string' && cfg.host.startsWith('[') && cfg.host.endsWith(']')) {
    cfg.host = cfg.host.slice(1, -1);
  }
  return cfg;
}

/** True when the URL names an IPv6 literal — used by tests and by operator-facing messages. */
export function isIpv6Url(databaseUrl) {
  if (typeof databaseUrl !== 'string') return false;
  const host = parse(databaseUrl).host;
  return typeof host === 'string' && host.startsWith('[') && host.endsWith(']');
}
