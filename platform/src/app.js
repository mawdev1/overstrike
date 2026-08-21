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
import { isUlid } from './core/ids.js';
import { createObservability } from './core/observability.js';
import { timingSafeEqual, createHash } from 'node:crypto';

// The modules a production process MUST have. `stubs` is deliberately absent: in production
// it is not mounted at all, which is a stronger guarantee than mounting it disabled.
const REQUIRED_MODULES = ['events', 'auth', 'profile', 'telemetry', 'flags', 'mail', 'lobby'];

export async function buildApp(config, overrides = {}) {
  const logger = overrides.logger || createLogger({ level: config.logLevel });
  const store = overrides.store || await createStore(config, { logger });
  if (config.env === 'production' && config.identityProvider === 'supabase') {
    const readiness = await store.accounts.identityReadiness();
    if (!readiness.ok) {
      // Migration 0021 only adds columns; it cannot create remote provider identities. Refuse
      // the cutover until the explicit admin migration has attached every live account, or a
      // deploy would turn valid legacy credentials into unrecoverable accounts.
      try { await store.close(); } catch { /* preserve the actionable boot error */ }
      throw new Error(`auth: ${readiness.unreadyAccounts} account(s) require the Supabase identity cutover`);
    }
  }
  const rateLimiter = overrides.rateLimiter || createRateLimiter();
  // Without a janitor the hit map grows for every unique subject seen and never shrinks.
  const stopJanitor = rateLimiter.startJanitor ? rateLimiter.startJanitor() : () => {};

  const clock = overrides.clock || (() => Date.now());
  const observability = overrides.observability || createObservability({
    service: 'platform', clock: { now: clock }, logger,
    alertWebhookUrl: config.alertWebhookUrl,
    fetchImpl: overrides.alertFetch || globalThis.fetch,
  });
  const deps = {
    config, logger, store, rateLimiter,
    clock, observability,
    // §7.1 names this dependency `db`. The shape is contract, not a label we choose.
    healthProbes: { db: () => store.health() },
  };

  const router = new Router();
  const health = createHealth({ deps });
  if (config.env === 'production') deps.healthProbes.alerts = () => observability.health();

  // §9's read/write/room/report classes are enforced in `core/http.js`, derived from the
  // method, for every client route.
  //
  // This is where `deps.rateLimit(className)` used to be: a factory returning middleware, with
  // a comment saying it was "applied as route middleware so a new endpoint inherits it". It had
  // ZERO call sites. The limiter was constructed here, its janitor started here, and no route
  // ever consulted it, so every read and write in the platform was uncapped against a contract
  // that states a number for each — while the comment described the wiring as finished.
  //
  // It is gone rather than wired up, because the shape was the problem. An opt-in that each
  // new endpoint must remember is one a new endpoint will forget, and an unlimited route is
  // indistinguishable from a working one until it is abused.

  router.get('/v1/health', async () => health.live(), { requireBuild: false });
  router.get('/v1/health/ready', async (ctx) => {
    requireServiceCaller(ctx);
    const body = await health.ready();
    // A load balancer branches on STATUS. Returning 200 with `ok:false` keeps traffic
    // arriving at a process whose store is down — a fail-open in the one endpoint whose
    // entire job is to fail loudly.
    return body.ok ? body : raw(503, body);
  }, { requireBuild: false });

  // Service-only operations surface. Metrics contain route templates and counts only; the
  // incident timeline projects durable event/audit metadata and recent redacted spans, never
  // event payloads, actor ids, email, tokens, chat, or the alert webhook URL.
  router.get('/v1/ops/metrics', async (ctx) => {
    requireServiceCaller(ctx);
    return { ...observability.snapshot(), outbox: deps.events?.relay?.stats ?? {
      published: 0, failed: 0, deadLettered: 0,
    } };
  }, { requireBuild: false });
  router.get('/v1/ops/incidents/:correlationId', async (ctx) => {
    requireServiceCaller(ctx);
    const correlationId = ctx.params.correlationId;
    if (!isUlid(correlationId)) {
      throw new ApiError('VALIDATION_FAILED', 'correlationId must be a ULID.');
    }
    const [events, audits] = await Promise.all([
      store.outbox.list?.({ correlationId, limit: 500 }) ?? [],
      store.audit.list({ correlationId, limit: 500 }),
    ]);
    const timeline = [
      ...events.map((row) => ({ at: row.recordedAt, tier: 'platform', kind: 'event',
        name: row.eventType, status: row.deadLetteredAt ? 'dead-lettered'
          : row.publishedAt ? 'published' : 'pending', eventId: row.eventId,
        subject: { kind: row.subjectKind } })),
      ...audits.map((row) => ({ at: row.createdAt, tier: 'platform', kind: 'audit',
        name: row.action, status: 'recorded', auditId: row.auditId,
        subject: { kind: row.subjectKind }, reasonCode: row.reasonCode })),
      ...observability.timelineSpans(correlationId).map((span) => ({
        at: span.at, tier: span.tier, kind: 'span', name: span.name, status: span.status,
        traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId,
        durationMs: span.durationMs, attributes: span.attributes,
      })),
    ].sort((a, b) => a.at === b.at ? a.kind.localeCompare(b.kind) : a.at.localeCompare(b.at));
    return { traceId: observability.timelineSpans(correlationId)[0]?.traceId ?? null,
      timeline, count: timeline.length };
  }, { requireBuild: false });

  const mounted = await mountModules({ deps, router, config, logger, overrides });
  logger.info('modules.mounted', { mounted });

  // Assert the expected set rather than trusting the wiring. Without this, the stub check
  // below is unreachable precisely when the stub module fails to load — `deps.stubs` is
  // undefined, so `deps.stubs?.enabled` is falsy and the guard silently passes.
  //
  // EQUIVALENT MUTANTS, measured — this whole block, and each of its two assertions on its own.
  // Both are backstops for a rule enforced ABOVE them, and neither can fire while that rule
  // holds:
  //
  //   - `missing.length` cannot be non-empty. In production `mountModules` sets
  //     `optional = false`, so a module that will not import RETHROWS (`if (!optional) throw
  //     err`) and this line is never reached; a module that does import always pushes its name.
  //     It fires only if that rethrow is removed — which is exactly what it is here for.
  //   - `mounted.includes('stubs') || deps.stubs` cannot be true. Both are written in exactly
  //     one place, inside `if (config.env !== 'production')`.
  //
  // Measured by deleting the block, and then each assertion separately, and re-running eight
  // boots of the real assembly out of a copied tree — production/development/test intact,
  // production and development with the telemetry module deleted from disk, production with
  // auth deleted, and production and development with the stub module deleted — plus the
  // stop() and stub-body probes: identical `booted`, `mounted` and error message in all 16
  // observations, three times over. Kept because "assert the expected set rather than trust the
  // wiring" is a claim this file must keep making even after someone edits the wiring.
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
  deps.lobby?.attach?.(server);

  /**
   * The idempotency-key janitor.  http-api.md §8.
   *
   * §8 states a retention — "24 h for gameplay, permanent for value-bearing operations" — and
   * every writer duly stamped `expires_at`. Nothing ever deleted on it, so the retention was a
   * column rather than a policy, and `idempotency_keys` grew a permanent row for every profile
   * PATCH, every match result, and every burnt eligibility-receipt nonce. The nonce rows are
   * onboarding evidence; keeping those forever by omission is the kind of retention answer
   * nobody wants to give.
   *
   * It lives here rather than in a module because the table belongs to no module: auth burns
   * receipt nonces into it, profile stores PATCH replays, stats stores match results. A janitor
   * owned by one of them would be a janitor that stops when that module is not mounted.
   *
   * Unref'd, failures logged and swallowed — same rules as auth's consent sweep: a retention
   * timer must never hold a process open or take it down, and the next tick retries anyway.
   */
  const idempotencySweepMs = overrides.idempotencySweepIntervalMs ?? 3600_000;
  const idempotencyTimer = idempotencySweepMs > 0 && store.idempotency?.sweepExpired
    ? setInterval(() => {
      Promise.resolve(store.idempotency.sweepExpired())
        .then((removed) => { if (removed) logger.info('idempotency.sweep', { removed }); })
        .catch((err) => logger.warn('idempotency.sweep.failed', { message: err?.message ?? String(err) }));
    }, idempotencySweepMs)
    : null;
  idempotencyTimer?.unref?.();

  /** Release every background timer this process started. Called on shutdown. */
  const stop = () => {
    stopJanitor();
    // EQUIVALENT MUTANT, measured: `clearInterval(null)` is a documented no-op, so deleting the
    // guard leaves `stop()` doing exactly what it did. Measured by building the app with the
    // sweep interval on (50 ms) and off (0, so the timer is null), calling `stop()` twice in
    // each and waiting past a tick: no throw and no further sweep, identical on both versions.
    if (idempotencyTimer) clearInterval(idempotencyTimer);
    // Auth sweeps expired ephemeral tokens on an interval. Unref'd, so it never holds the
    // process open — but a test that builds many apps would otherwise accumulate them.
    try { deps.auth?.stop?.(); } catch { /* nothing useful to do while shutting down */ }
    try { deps.events?.relay?.stop?.(); } catch { /* same */ }
    try { deps.lobby?.stop?.(); } catch { /* same */ }
  };

  return {
    server, router, deps, mounted, stopJanitor, stop,
    /** For an ops task, a worker, or a test that would rather not wait an hour. */
    sweepIdempotencyKeys: (at = null) => store.idempotency.sweepExpired(at),
  };
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
      // EQUIVALENT MUTANT, measured. This cannot fire: `receipts.readConsent`
      // (modules/auth/receipts.js) already compares `claims.pv` against the SAME
      // `config.consentPolicyVersion` and returns null on a mismatch, so a stale receipt is
      // null by the line above and leaves as `receipt_signature_invalid`. Measured by driving a
      // receipt minted by a policy-1 app at a policy-2 app — signed out, authenticated, and a
      // policy-2 receipt as the control — with this line present and deleted: identical status,
      // identical accepted/rejected counts and the same `receipt_signature_invalid` reason in
      // all four comparisons, and `receipt_policy_stale` produced by neither. Kept as the
      // backstop for an adapter that one day verifies without going through `readConsent`; the
      // RULE it states is asserted end to end in apptest.mjs.
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
      onDeadLetter: ({ event, attempts }) => { void deps.observability.alert({
        key: `outbox:${event.eventId}`, severity: 'critical', event: 'outbox.dead_letter',
        correlationId: event.correlationId, component: 'outbox', count: attempts,
      }); },
    });
    if (config.env !== 'test') deps.events.relay.start();
    mounted.push('events');
  }

  // ── mail: the transactional sender auth has always taken and never had ───────────────
  //
  // `auth/index.js` accepted a `mailer` and every call site is `await mailer?.send…?.(…)`, so a
  // null mailer made every send a silent no-op. Signup minted a verification token and wrote it
  // nowhere a player could reach; onboarding step 5 asked for a code nothing had sent.
  //
  // Built BEFORE auth so it can be injected rather than patched in afterwards. `none` is the
  // default outside production, so a local process with no mail configured still boots and
  // reports its transport. Production config refuses that state before assembly.
  const mail = await load('mail', './modules/mail/index.js');
  if (mail) {
    deps.mail = mail.createMailer({ config, logger });
    if (config.env === 'production') deps.healthProbes.mail = () => deps.mail.health();
    logger.info('mail.transport', deps.mail.describe());
    mounted.push('mail');
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
      mailer: deps.mail,
    });
    if (config.env === 'production') deps.healthProbes.identity = () => deps.auth.identity.health({
      accountById: (accountId) => deps.store.accounts.byId(accountId),
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
      // `PATCH /v1/profile/me` renames through the auth service, which owns the name policy,
      // the `account.name_changed` event and the §10 audit row. Auth is mounted above, so the
      // service exists by here; without it the profile module refuses a rename rather than
      // performing one nothing records.
      identity: deps.auth?.service,
    });
    // Profile routes take the auth middleware from the wiring rather than importing it, so
    // the module stays testable without an auth module present.
    deps.profile.routes(router, { auth: deps.auth?.requireAuth || deps.auth?.routes?.requireAuth });
    mounted.push('profile');
  }

  // ── flags: the client-visible feature flag surface ───────────────────────────────────
  //
  // Contracted in feature-flags.md §3.1 and http-api.md, called by the shell on boot — and
  // implemented only in the STUB layer, so the deployed shell 404'd on it three times per page
  // while the suite stayed green. Mounted after auth because §3.1 marks the route `A`.
  const flags = await load('flags', './modules/flags/index.js');
  if (flags) {
    deps.flags = flags.createFlagsModule({ config, clock: deps.clock, logger });
    deps.flags.routes(router, { auth: deps.auth?.requireAuth || deps.auth?.routes?.requireAuth });
    mounted.push('flags');
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
    const unload = telemetry.createUnloadIngress({
      config, clock: { now: deps.clock }, service, store: deps.store,
    });
    telemetry.registerUnloadRoutes(router, {
      ingress: unload,
      requireAuth: deps.auth?.requireAuth || deps.auth?.routes?.requireAuth,
    });
    deps.telemetry = { service, consent, unload };
    mounted.push('telemetry');
  }

  // ── P2: presence, rooms, reports and realtime lobby ─────────────────────────────────
  const lobby = await load('lobby', './modules/lobby/index.js');
  if (lobby) {
    deps.lobby = lobby.createLobbyModule({
      store: deps.store, config, logger, clock: deps.clock,
      auth: deps.auth?.requireAuth || deps.auth?.routes?.requireAuth,
      flags: deps.flags,
      visibilityFor: deps.profile?.profiles?.visibilityFor,
      outbox: deps.events?.outbox,
      resultApplier: deps.profile?.stats?.applyMatchResult,
      chatModerator: overrides.chatModerator || lobby.localChatModerator,
      observability: deps.observability,
    });
    deps.lobby.routes(router);
    mounted.push('lobby');
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
          // The stub honours this and derives its own otherwise, which produced TWO ids in one
          // response: the envelope's `error.correlationId` from the stub and a stray top-level
          // one added below. One request has one id, or a support ticket has two answers.
          correlationId: early.correlationId,
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
  // EQUIVALENT MUTANT, measured: with no chunks, `Buffer.concat([]).toString('utf8')` is the
  // empty string, `JSON.parse('')` throws, and the catch below returns the same `{}`. Measured
  // over a stub `POST /v1/auth/signin` with no body, a zero-length body, a whitespace body and
  // a non-JSON body, with this line present and deleted: byte-identical 400 envelopes on all
  // four. Kept because reaching the answer through a thrown exception is not the same as
  // stating it.
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

const shortReason = (err) => String(err && err.message || err).split('\n')[0].slice(0, 200);

export { requireServiceCaller };
