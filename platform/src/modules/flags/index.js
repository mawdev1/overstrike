/**
 * Client-visible feature flags.  contracts/feature-flags.md §3.1, §3.2.
 *
 * ── Why this module exists ───────────────────────────────────────────────────────────────
 * `GET /v1/config/flags` is specified in two contracts and called by the shell on boot. It was
 * implemented only in the STUB layer, so the deployed shell 404'd on it three times in a row
 * during onboarding — once per retry — while every check in the suite passed. A stub is not an
 * implementation; it is a description of one, and the two had drifted to the point where the
 * described endpoint existed and the real one did not.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────────────────
 * Rollout percentages, bucketing rules and account lists. §3.1: the client receives the ANSWER,
 * never the rule. Shipping the rule would let a modified client evaluate itself into any bucket
 * it likes, which for `mode.bomb.enabled` is not cosmetic.
 *
 * Server-side flags are not exposed even read-only, because the existence of a key is
 * information about unshipped work.
 *
 * ── Evaluation ───────────────────────────────────────────────────────────────────────────
 * P1 serves the compiled defaults from §3.2 with no per-account variation, and says so rather
 * than pretending to a targeting engine it does not have. Overrides arrive by environment for
 * now — a kill switch an operator can reach in seconds (§3, rule 5) matters more at this stage
 * than per-account rollout, and the shape of the response does not change when targeting lands.
 */
import { ApiError } from '../../core/errors.js';

/**
 * §3.2 exactly: the client-visible registry and its compiled-in defaults.
 *
 * This list is the allowlist as well as the defaults. A key absent here is never returned, so
 * adding a server-side flag cannot leak it to a browser by forgetting a filter — the filter is
 * the table itself.
 */
export const CLIENT_FLAG_DEFAULTS = Object.freeze({
  'shell.diagnostics.panel': true,
  'shell.career.enabled': true,
  'shell.serverbrowser.enabled': true,
  'mode.tdm.enabled': true,
  'mode.bomb.enabled': false,
  'map.the_square.enabled': false,
  'chat.text.enabled': true,
  'chat.pings.enabled': true,
  'reports.enabled': true,
  'telemetry.client.enabled': true,
});

/** §3.1: `Cache-Control: max-age=60`, and `expiresAt` must agree with it. */
const TTL_MS = 60_000;

/**
 * Parse `PLATFORM_FLAG_OVERRIDES`, e.g. `mode.bomb.enabled=true,chat.text.enabled=false`.
 *
 * Unknown keys are REFUSED at boot rather than ignored. An operator reaching for a kill switch
 * in an incident must not have a typo silently do nothing — that is the one moment when quiet
 * failure is most expensive, and `mode.bomb.enbaled=false` looks exactly like success.
 */
export function parseFlagOverrides(raw) {
  const out = {};
  if (!raw) return out;
  for (const pair of String(raw).split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) throw new Error(`PLATFORM_FLAG_OVERRIDES: "${trimmed}" is not key=value`);
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!Object.hasOwn(CLIENT_FLAG_DEFAULTS, key)) {
      throw new Error(`PLATFORM_FLAG_OVERRIDES: "${key}" is not a client-visible flag (feature-flags.md §3.2)`);
    }
    if (value !== 'true' && value !== 'false') {
      throw new Error(`PLATFORM_FLAG_OVERRIDES: "${key}" must be true or false, got "${value}"`);
    }
    out[key] = value === 'true';
  }
  return out;
}

export function createFlagsModule({ config = {}, clock = () => Date.now(), logger = null } = {}) {
  const overrides = parseFlagOverrides(config.flagOverrides);
  if (Object.keys(overrides).length) logger?.info?.('flags.overrides', { keys: Object.keys(overrides) });

  /**
   * §3.1's `version` — a value that changes when the ANSWERS change, so a client can tell a
   * genuine flip from a routine refresh. Derived from the evaluated set rather than stored:
   * with no targeting engine there is nothing else that could move it, and a counter that only
   * ever increments on deploy would claim changes that did not happen.
   */
  function versionOf(flags) {
    let h = 5381;
    for (const key of Object.keys(flags).sort()) {
      const bit = `${key}=${flags[key] ? 1 : 0};`;
      for (let i = 0; i < bit.length; i++) h = ((h * 33) ^ bit.charCodeAt(i)) >>> 0;
    }
    return h;
  }

  function evaluate() {
    const now = clock();
    const flags = { ...CLIENT_FLAG_DEFAULTS, ...overrides };
    return {
      version: versionOf(flags),
      evaluatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + TTL_MS).toISOString(),
      flags,
    };
  }

  const handlers = {
    getFlags(ctx) {
      // Marked `A` in §3.1. The middleware has already refused an unauthenticated caller; this
      // is a backstop for a route mounted without it, and it fails closed.
      if (!ctx.actor) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
      return evaluate();
    },
  };

  function routes(router, { auth } = {}) {
    const mw = auth ? { middleware: [auth] } : {};
    router.get('/v1/config/flags', handlers.getFlags, mw);
    return router;
  }

  return { evaluate, handlers, routes, defaults: CLIENT_FLAG_DEFAULTS, ttlMs: TTL_MS };
}
