/**
 * Application assembly.  Build Plan §P1.A1, §2.1.
 *
 * One place where every module is constructed and mounted, so the dependency graph is a thing
 * you can read rather than infer from imports. Modules receive their dependencies explicitly
 * and import no singletons — the same rule `ARCHITECTURE.md` §2 sets for the game's systems,
 * for the same reason: a test must be able to substitute any piece without a module registry.
 *
 * Wiring is explicit per module rather than a generic loop. Each module has its own
 * construction signature, and a loop that guessed at them would be assembly logic pretending
 * not to be. This is the one file whose job is knowing how the parts fit, so it says so.
 *
 * Modules are optional in development and mandatory in production. An assembly that refuses
 * to boot until every module exists makes the first one impossible to run; an assembly that
 * boots in production with `/v1/auth/*` silently 404ing is worse than one that refuses.
 */
import { Router, createApp, raw } from './core/http.js';
import { createLogger } from './core/logger.js';
import { createStore } from './core/store.js';
import { createHealth } from './core/health.js';
import { createRateLimiter } from './core/ratelimit.js';
import { ApiError } from './core/errors.js';
import { timingSafeEqual, createHash } from 'node:crypto';

const MODULE_NAMES = ['events', 'auth', 'profile', 'telemetry', 'stubs'];

export async function buildApp(config, overrides = {}) {
  const logger = overrides.logger || createLogger({ level: config.logLevel });
  const store = overrides.store || await createStore(config, { logger });
  const rateLimiter = overrides.rateLimiter || createRateLimiter();
  // Without a janitor the hit map grows for every unique subject seen and never shrinks.
  const stopJanitor = rateLimiter.startJanitor ? rateLimiter.startJanitor() : () => {};

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
    const body = await health.ready();
    // A load balancer branches on STATUS. Returning 200 with `ok:false` keeps traffic
    // arriving at a process whose store is down — a fail-open in the one endpoint whose
    // entire job is to fail loudly.
    return body.ok ? body : raw(503, body);
  }, { requireBuild: false });

  const mounted = await mountModules({ deps, router, config, logger, overrides });
  logger.info('modules.mounted', { mounted });

  // Assert the expected set rather than trusting the wiring. Without this, the stub check
  // below is unreachable precisely when the stub module fails to load — `deps.stubs` is
  // undefined, so `deps.stubs?.enabled` is falsy and the guard silently passes.
  if (config.env === 'production') {
    const missing = MODULE_NAMES.filter((n) => !mounted.includes(n));
    if (missing.length) throw new Error(`modules failed to mount in production: ${missing.join(', ')}`);
    // contracts/feature-flags.md §12: the stub layer must be impossible to enable in
    // production. Asserted at boot so a misconfigured deploy fails immediately and loudly
    // rather than quietly serving fixtures to real players.
    if (deps.stubs?.enabled) throw new Error('stub layer is enabled in production configuration');
  }

  const server = createApp({ router, deps });
  return { server, router, deps, mounted, stopJanitor };
}

/** Order matters: events first, because auth and profile emit through its outbox. */
/**
 * The default telemetry sink.
 *
 * P1 has no warehouse, so accepted records go to the structured log where the data pipeline
 * can pick them up later. Deliberately a real object rather than a no-op: a silently
 * discarding sink is indistinguishable from a working one right up to the first question
 * nobody can answer.
 */
function createLogSink(logger) {
  return { write: async (records) => { for (const r of records) logger.info('telemetry.record', r); } };
}

async function mountModules({ deps, router, config, logger, overrides = {} }) {
  const mounted = [];
  const optional = config.env !== 'production';

  const load = async (name, path) => {
    try { return await import(path); }
    catch (err) {
      if (!optional) throw err;
      logger.warn('module.absent', { module: name, reason: shortReason(err) });
      return null;
    }
  };

  // ── events: the outbox and audit log everything else writes through ──────────────────
  const events = await load('events', './modules/events/index.js');
  if (events) {
    deps.events = {
      outbox: events.createOutbox({ store: deps.store, logger }),
      audit: events.createAuditLog({ store: deps.store, logger }),
      buildEvent: events.buildEvent,
      rbac: { check: events.check, can: events.can, requireCapability: events.requireCapability },
    };
    mounted.push('events');
  }

  // ── auth: sessions, tokens, the onboarding chain ─────────────────────────────────────
  const auth = await load('auth', './modules/auth/index.js');
  if (auth) {
    deps.auth = auth.createAuthModule({ store: deps.store, config, logger, clock: { now: deps.clock } });
    deps.auth.register(router);
    mounted.push('auth');
  }

  // ── profile: identity projection, roaming settings, career stats ─────────────────────
  const profile = await load('profile', './modules/profile/index.js');
  if (profile) {
    deps.profile = (profile.default || profile.createProfileModule)({
      store: deps.store, clock: Date, logger, config,
    });
    // Profile routes take the auth middleware from the wiring rather than importing it, so
    // the module stays testable without an auth module present.
    deps.profile.routes(router, { auth: deps.auth?.requireAuth || deps.auth?.routes?.requireAuth });
    mounted.push('profile');
  }

  // ── telemetry: the client ingest endpoint ────────────────────────────────────────────
  const telemetry = await load('telemetry', './modules/telemetry/index.js');
  if (telemetry) {
    // ONE signer for consent receipts, shared with auth. Two implementations of the same
    // signature is two ways to mint a receipt and only one way to verify it — the telemetry
    // module ships its own so it can be tested alone, and here the auth one wins.
    const consent = deps.auth?.receipts?.consent
      || telemetry.createConsentReceipts({ secret: config.tokenSecret });
    // The service REQUIRES a sink and destructures it; building without one made every
    // non-empty batch a 500. The suite passed a sink of its own, so nothing caught it —
    // which is why wiring needs its own boot check, not just module tests.
    const sink = overrides.telemetrySink || createLogSink(logger);
    const service = telemetry.createTelemetryService({ store: deps.store, logger, consent, config, sink });
    telemetry.registerTelemetryRoutes(router, { service });
    deps.telemetry = { service, consent };
    mounted.push('telemetry');
  }

  // ── stubs: the fixture layer that unblocks the frontend lane ─────────────────────────
  const stubs = await load('stubs', './modules/stubs/index.js');
  if (stubs) {
    const enabled = config.env !== 'production';
    deps.stubs = { enabled, api: enabled ? stubs.createStubApi({ config }) : null };
    mounted.push('stubs');
  }

  return mounted;
}

/**
 * Service-only endpoints.  contracts/http-api.md §2.
 *
 * Fails CLOSED: until mTLS lands, an S-marked endpoint refuses everything without the shared
 * token. The alternative — allowing them through until security arrives — is how
 * `POST /matches/:id/result` ends up browser-reachable, which makes the G1 gate decorative.
 */
function requireServiceCaller(ctx) {
  const token = ctx.headers['x-service-token'];
  const expected = ctx.deps.config.serviceToken;
  if (!expected || typeof token !== 'string' || !constantTimeEquals(token, expected)) {
    throw new ApiError('AUTH_FORBIDDEN', 'This endpoint is not available to clients.');
  }
}

/**
 * Compare without leaking length or content through timing.
 *
 * `!==` on strings short-circuits at the first differing byte, which is measurable and lets a
 * token be recovered one byte at a time. Hashing first makes the buffers equal-length, so
 * `timingSafeEqual` never throws and the length does not leak either.
 */
function constantTimeEquals(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

const shortReason = (err) => String(err && err.message || err).split('\n')[0].slice(0, 200);

export { requireServiceCaller };
