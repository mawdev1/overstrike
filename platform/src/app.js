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

// The modules a production process MUST have. `stubs` is deliberately absent: in production
// it is not mounted at all, which is a stronger guarantee than mounting it disabled.
const REQUIRED_MODULES = ['events', 'auth', 'profile', 'telemetry'];

export async function buildApp(config, overrides = {}) {
  const logger = overrides.logger || createLogger({ level: config.logLevel });
  const store = overrides.store || await createStore(config, { logger });
  const rateLimiter = overrides.rateLimiter || createRateLimiter();
  // Without a janitor the hit map grows for every unique subject seen and never shrinks.
  const stopJanitor = rateLimiter.startJanitor ? rateLimiter.startJanitor() : () => {};

  const deps = {
    config, logger, store, rateLimiter,
    clock: overrides.clock || (() => Date.now()),
    // §7.1 names this dependency `db`. The shape is contract, not a label we choose.
    healthProbes: { db: () => store.health() },
  };

  const router = new Router();
  const health = createHealth({ deps });

  // §9's read/write/room/report classes had no call site: the limiter was constructed,
  // janitored, and never consulted, so /v1/profile/me was unlimited. Applied as route
  // middleware so a new endpoint inherits it by declaring a class rather than remembering to.
  deps.rateLimit = (className) => async (ctx) => {
    const subject = ctx.actor?.accountId || ctx.ip || 'anonymous';
    const verdict = ctx.deps.rateLimiter.check(className, subject);
    if (!verdict.allowed) {
      throw new ApiError('RATE_LIMITED', 'Too many requests. Try again shortly.',
        { retryAfterMs: verdict.retryAfterMs });
    }
  };

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
    const missing = REQUIRED_MODULES.filter((n) => !mounted.includes(n));
    if (missing.length) throw new Error(`modules failed to mount in production: ${missing.join(', ')}`);
    // contracts/feature-flags.md §12. The previous form — mount it, then assert it is not
    // enabled — could never fire, because `enabled` was already derived from the same env
    // check. Code that cannot be reached is not a guard. Production does not load the module,
    // so there is nothing to enable, and this assertion is the backstop rather than the rule.
    if (mounted.includes('stubs') || deps.stubs) {
      throw new Error('stub layer is present in a production process');
    }
  }

  const preRoute = deps.stubs?.preRoute ? [deps.stubs.preRoute] : [];
  const server = createApp({ router, deps, preRoute });

  /** Release every background timer this process started. Called on shutdown. */
  const stop = () => {
    stopJanitor();
    // Auth sweeps expired ephemeral tokens on an interval. Unref'd, so it never holds the
    // process open — but a test that builds many apps would otherwise accumulate them.
    try { deps.auth?.stop?.(); } catch { /* nothing useful to do while shutting down */ }
    try { deps.events?.relay?.stop?.(); } catch { /* same */ }
  };

  return { server, router, deps, mounted, stopJanitor, stop };
}

/**
 * Present auth's consent receipts through the interface telemetry verifies against.
 *
 * Auth owns issuing (it holds the account and the policy version); telemetry owns the gate.
 * Rather than duplicate a signer — two ways to mint, one way to verify — this translates
 * auth's `readConsent` result into telemetry's `{ ok, reason, subject, subjectId }` verdict.
 */
function adaptAuthConsent(receipts, config) {
  return {
    /**
     * @param expect {{ accountId: string|null, clientSessionId: string|null }}
     *   The caller's AUTHENTICATED state, as the telemetry service knows it. Note the key
     *   names: an earlier version of this adapter read `expect.subject`/`expect.subjectId`,
     *   which the service never sends, so both were `undefined` and the guards
     *   `if (expect.subject && …)` short-circuited to no check at all. A receipt issued for
     *   client session A then authorised personal telemetry submitted as session B — a
     *   receipt is evidence about ONE subject, and possession of anyone's made it a bearer
     *   token for everyone's.
     */
    verify(receipt, expect = {}) {
      const claims = receipts.readConsent(receipt);
      if (!claims) return { ok: false, reason: 'receipt_signature_invalid' };
      if (claims.telemetryPersonal !== true) return { ok: false, reason: 'consent_declined' };
      if (claims.policyVersion !== config.consentPolicyVersion) {
        return { ok: false, reason: 'receipt_policy_stale' };
      }

      // Exactly ONE expected subject, derived from authenticated state — never from the
      // receipt, which is the thing being checked. Authenticated callers must present an
      // account receipt for THEIR account; signed-out callers must present a client-session
      // receipt for the session they are submitting as. There is no third case, and an
      // unresolvable one is refused rather than defaulted.
      const authenticated = typeof expect.accountId === 'string' && expect.accountId !== '';
      const wantSubject = authenticated ? 'account' : 'client-session';
      const wantId = authenticated ? expect.accountId : expect.clientSessionId;

      if (typeof wantId !== 'string' || wantId === '') {
        // A signed-out personal batch with no client session has no subject to bind to, so
        // there is nothing a receipt could prove about it.
        return { ok: false, reason: 'receipt_unbound' };
      }
      if (claims.subject !== wantSubject) return { ok: false, reason: 'receipt_unbound' };
      if (claims.subjectId !== wantId) return { ok: false, reason: 'receipt_subject_mismatch' };

      return {
        ok: true,
        subject: claims.subject,
        subjectId: claims.subjectId,
        policyVersion: claims.policyVersion,
      };
    },
  };
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
    // Without a relay the outbox is a write-only table: rows accumulate, `published_at` stays
    // null forever, and migration 0011's index serves a poll that never runs. At-least-once
    // delivery is only a guarantee if something delivers.
    deps.events.relay = events.createRelay({
      store: deps.store,
      logger,
      // ONE event per call, not a batch — the relay awaits publish per row so it can order
      // within a subject and retry a single failure. Handing it a batch-shaped function made
      // every publish throw, which the retry budget then dressed up as a transient fault.
      publish: async (event) => {
        logger.info('event.published', {
          eventId: event.eventId, type: event.type, subjectKind: event.subject?.kind,
          subjectId: event.subject?.id, correlationId: event.correlationId,
        });
      },
    });
    if (config.env !== 'test') deps.events.relay.start();
    mounted.push('events');
  }

  // ── auth: sessions, tokens, the onboarding chain ─────────────────────────────────────
  const auth = await load('auth', './modules/auth/index.js');
  if (auth) {
    // Pass the events module's outbox and audit log rather than letting auth build its own.
    // Both are stateless over the same store so there is no behavioural divergence today, but
    // one process should have one of each — a second instance is a second place to change a
    // rule and forget the other.
    deps.auth = auth.createAuthModule({
      store: deps.store, config, logger, clock: { now: deps.clock },
      outbox: deps.events?.outbox, audit: deps.events?.audit,
    });
    deps.auth.register(router);
    mounted.push('auth');
  }

  // ── profile: identity projection, roaming settings, career stats ─────────────────────
  const profile = await load('profile', './modules/profile/index.js');
  if (profile) {
    deps.profile = (profile.default || profile.createProfileModule)({
      store: deps.store, clock: Date, logger, config,
      // The result-application transition emits `match.result_applied` through the SAME outbox
      // everything else uses, so a career change is traceable like any other state change.
      outbox: deps.events?.outbox,
    });
    // Profile routes take the auth middleware from the wiring rather than importing it, so
    // the module stays testable without an auth module present.
    deps.profile.routes(router, { auth: deps.auth?.requireAuth || deps.auth?.routes?.requireAuth });
    mounted.push('profile');
  }

  // ── telemetry: the client ingest endpoint ────────────────────────────────────────────
  const telemetry = await load('telemetry', './modules/telemetry/index.js');
  if (telemetry) {
    // ONE consent verifier, and it must understand the receipts AUTH ACTUALLY ISSUES.
    //
    // The previous `deps.auth?.receipts?.consent` was always undefined, so this silently fell
    // through to telemetry's own signer — which shares the secret but not the claim schema
    // (auth writes {k,s,sid,tp,pv,dat,exp}, telemetry expected {subject,telemetryPersonal,…}).
    // The HMAC verified, the claims did not, and EVERY personal-class event from every
    // consenting player was discarded as `consent_declined`. The whole client funnel.
    const consent = deps.auth
      ? adaptAuthConsent(deps.auth.receipts, config)
      : telemetry.createConsentReceipts({
        secret: config.tokenSecret,
        policyVersion: config.consentPolicyVersion,
      });
    // The service REQUIRES a sink and destructures it; building without one made every
    // non-empty batch a 500. The suite passed a sink of its own, so nothing caught it —
    // which is why wiring needs its own boot check, not just module tests.
    const sink = overrides.telemetrySink || createLogSink(logger);
    const service = telemetry.createTelemetryService({ store: deps.store, logger, consent, config, sink });
    // `{ auth: 'optional' }` is not an option core/http.js understands — it only reads
    // `middleware`. So no middleware ran, ctx.actor was always undefined, and an
    // authenticated player's telemetry could never be attributed or bound to an account
    // receipt. Pass the real middleware, as the profile module does.
    telemetry.registerTelemetryRoutes(router, { service, optionalAuth: deps.auth?.routes?.optionalAuth });
    deps.telemetry = { service, consent };
    mounted.push('telemetry');
  }

  // ── stubs: the fixture layer that unblocks the frontend lane ─────────────────────────
  // Not loaded in production at all. Serving fixtures to real players is the failure this
  // prevents, and the surest way to not serve them is to not have the code.
  if (config.env !== 'production') {
    const stubs = await load('stubs', './modules/stubs/index.js');
    if (stubs) {
      const api = stubs.createStubApi({ config });
      deps.stubs = { enabled: true, api };
      // MOUNTED, not merely constructed. The stub layer existed as an object nothing could
      // reach over HTTP, so H1.1 — the executable-stub handshake the other lane builds against
      // — was unmeetable: there was no address to send a request to.
      //
      // Intercept BEFORE the real handlers so a scenario overrides live behaviour, and only
      // when the caller opts in with X-Stub-Scenario. Without that header the platform behaves
      // exactly as production does, so the stub layer cannot silently answer a real request.
      deps.stubs.preRoute = async (early, req) => {
        const scenario = early.headers['x-stub-scenario'];
        if (!scenario) return null;                       // no header, real platform, always
        const body = await readBodyForStub(req);
        const res = api.handle({
          method: early.method, path: early.path,
          query: Object.fromEntries(early.query),
          headers: early.headers, body, scenario,
        });
        // `offline` models a TRANSPORT failure, which has no HTTP representation. Synthesising
        // a 5xx would be indistinguishable from a real server error and would teach the client
        // the wrong retry behaviour, so the socket is dropped — which is what offline looks
        // like from the client's side.
        if (res.transport === 'failed') return { __dropSocket: true };
        return res;
      };
      mounted.push('stubs');
    }
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

/** Read a JSON body for the stub layer, which intercepts before the normal body reader runs. */
async function readBodyForStub(req) {
  if (req.method === 'GET' || req.method === 'DELETE') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) break;
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

const shortReason = (err) => String(err && err.message || err).split('\n')[0].slice(0, 200);

export { requireServiceCaller };
