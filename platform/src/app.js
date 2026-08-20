/**
 * Application assembly.  Build Plan §P1.A1, §2.1.
 *
 * One place where every module is constructed and mounted, so the dependency graph is a thing
 * you can read rather than infer from imports. Modules receive `deps` explicitly and import no
 * singletons — the same rule `ARCHITECTURE.md` §2 sets for the game's systems, for the same
 * reason: a test must be able to substitute any piece without a module registry.
 *
 * Modules are optional at load time on purpose. P1 is being built in parallel lanes, and an
 * assembly that refuses to boot until every module exists makes the first one impossible to
 * run. A missing module is logged, not fatal; a missing module in production IS fatal.
 */
import { Router, createApp } from './core/http.js';
import { createLogger } from './core/logger.js';
import { createStore } from './core/store.js';
import { createHealth } from './core/health.js';
import { createRateLimiter } from './core/ratelimit.js';
import { ApiError } from './core/errors.js';

const MODULES = [
  { name: 'auth',      path: './modules/auth/index.js' },
  { name: 'profile',   path: './modules/profile/index.js' },
  { name: 'events',    path: './modules/events/index.js' },
  { name: 'telemetry', path: './modules/telemetry/index.js' },
  { name: 'stubs',     path: './modules/stubs/index.js' },
];

export async function buildApp(config, overrides = {}) {
  const logger = overrides.logger || createLogger({ level: config.logLevel });
  const store = overrides.store || await createStore(config, { logger });
  const rateLimiter = overrides.rateLimiter || createRateLimiter();

  const deps = {
    config, logger, store, rateLimiter,
    clock: overrides.clock || (() => Date.now()),
    healthProbes: { store: () => store.health() },
  };

  const router = new Router();
  const health = createHealth({ deps });

  router.get('/v1/health', async () => health.live(), { requireBuild: false });
  router.get('/v1/health/ready', async (ctx) => {
    requireServiceCaller(ctx);
    return health.ready();
  }, { requireBuild: false });

  const mounted = [];
  for (const mod of MODULES) {
    let factory;
    try {
      ({ default: factory } = await import(mod.path));
    } catch (err) {
      if (config.env === 'production') throw err;
      logger.warn('module.absent', { module: mod.name, reason: shortReason(err) });
      continue;
    }
    if (typeof factory !== 'function') {
      logger.warn('module.invalid', { module: mod.name, reason: 'default export is not a factory' });
      continue;
    }
    const instance = await factory({ deps, router });
    deps[mod.name] = instance;
    mounted.push(mod.name);
  }
  logger.info('modules.mounted', { mounted });

  // §12: the stub layer must be impossible to enable in production. Asserted at boot rather
  // than at request time, so a misconfigured deploy fails immediately and loudly instead of
  // quietly serving fixtures to real players.
  if (config.env === 'production' && deps.stubs?.enabled) {
    throw new Error('stub layer is enabled in production configuration');
  }

  const server = createApp({ router, deps });
  return { server, router, deps, mounted };
}

/**
 * Service-only endpoints.  contracts/http-api.md §2.
 *
 * A placeholder that fails CLOSED: until mTLS or a service token is wired, every S-marked
 * endpoint refuses everything. The alternative — allowing them through until security lands —
 * is how `POST /matches/:id/result` ends up browser-reachable, which makes the G1 gate
 * decorative.
 */
function requireServiceCaller(ctx) {
  const token = ctx.headers['x-service-token'];
  const expected = ctx.deps.config.serviceToken;
  if (!expected || !token || token !== expected) {
    throw new ApiError('AUTH_FORBIDDEN', 'This endpoint is not available to clients.');
  }
}

const shortReason = (err) => String(err && err.message || err).split('\n')[0].slice(0, 200);

export { requireServiceCaller };
