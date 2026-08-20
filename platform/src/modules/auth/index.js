/**
 * Auth module composition root.  contracts/auth.md.
 *
 * One factory, one object graph, no singletons: every collaborator is constructed here from
 * the `deps` handed in, so a test substitutes a clock or a store without a module registry and
 * two instances in one process cannot share state by accident.
 */
import { createOutbox } from '../events/outbox.js';
import { createAuditLog } from '../events/audit.js';
import { createRateLimiter } from './ratelimit.js';
import { createReceipts } from './receipts.js';
import { createEphemeralTokens } from './ephemeral.js';
import { createSessionService } from './sessions.js';
import { createAuthService } from './service.js';
import { createAuthRoutes } from './routes.js';

export function createAuthModule(deps) {
  const { store, config, logger, clock = { now: Date.now }, geo = null, mailer = null, sleep } = deps;
  if (!config?.tokenSecret) throw new Error('auth: config.tokenSecret is required');

  const limiter = createRateLimiter({ clock });
  const receipts = createReceipts({ config, clock });
  const ephemeral = createEphemeralTokens({ clock, sweepIntervalMs: deps.sweepIntervalMs });
  // The outbox and the audit log are the events module's, not auth's: auth writing envelopes
  // or audit rows by hand is what produced §5 rows with §2 column names. They are accepted from
  // `deps` when the composition root already built them, so one process has one of each.
  const outbox = deps.outbox ?? createOutbox({ store, clock, logger });
  const audit = deps.audit ?? createAuditLog({ store, clock, logger });
  const sessions = createSessionService({ store, config, clock, logger, geo, outbox, audit });
  const service = createAuthService({
    store, config, clock, logger, sessions, receipts, ephemeral, limiter, outbox, audit, mailer, sleep,
  });
  const routes = createAuthRoutes({ service, sessions, limiter });

  /**
   * The pre-auth consent janitor.  http-api.md §3a.3.
   *
   * §3a.3 gives a signed-out consent decision a 30-day life. The adapters delete an expired row
   * when someone reads it, and nobody reads most of them — so without a timer the rows that
   * never come back are retained forever, which for a consent record is a retention breach
   * rather than a stale cache entry. Hourly is far more often than a 30-day TTL needs and far
   * less often than anything that would show up on the database.
   *
   * Unref'd, like the ephemeral sweep: a retention timer must never be the reason a process
   * refuses to exit. Failures are logged and swallowed — a janitor that throws into a bare
   * interval takes the process down with it, and the next tick would have retried anyway.
   */
  const consentSweepIntervalMs = deps.consentSweepIntervalMs ?? 3600_000;
  const consentTimer = consentSweepIntervalMs > 0
    ? setInterval(() => {
      service.sweepPreAuthConsent().catch((err) => logger?.warn?.('consent.sweep.failed',
        { message: err?.message ?? String(err) }));
    }, consentSweepIntervalMs)
    : null;
  consentTimer?.unref?.();

  return {
    service, sessions, receipts, ephemeral, limiter, outbox, audit, routes,
    register: routes.register,
    /** For a worker, an ops task, or a test that would rather not wait an hour. */
    sweepPreAuthConsent: service.sweepPreAuthConsent,
    /** Releases the module's background timers. Called by the composition root on shutdown. */
    stop() {
      ephemeral.stop();
      if (consentTimer) clearInterval(consentTimer);
    },
  };
}

export { createRateLimiter, createReceipts, createEphemeralTokens, createSessionService, createAuthService, createAuthRoutes };
export { fold, normaliseDisplayName, assertCooldown } from './names.js';
export { applyCookies } from './routes.js';
