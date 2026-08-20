/**
 * Auth module composition root.  contracts/auth.md.
 *
 * One factory, one object graph, no singletons: every collaborator is constructed here from
 * the `deps` handed in, so a test substitutes a clock or a store without a module registry and
 * two instances in one process cannot share state by accident.
 */
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
  const ephemeral = createEphemeralTokens({ clock });
  const sessions = createSessionService({ store, config, clock, logger, geo });
  const service = createAuthService({ store, config, clock, logger, sessions, receipts, ephemeral, limiter, mailer, sleep });
  const routes = createAuthRoutes({ service, sessions, limiter });

  return { service, sessions, receipts, ephemeral, limiter, routes, register: routes.register };
}

export { createRateLimiter, createReceipts, createEphemeralTokens, createSessionService, createAuthService, createAuthRoutes };
export { fold, normaliseDisplayName, assertCooldown } from './names.js';
export { applyCookies } from './routes.js';
