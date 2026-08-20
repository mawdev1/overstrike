/**
 * Profile module wiring.  http-api.md §4, §11.2, §11.5, §11.9.
 *
 * Services hold the rules; handlers do nothing but translate a request into a service call and
 * a service result into the documented body. Anything a handler decides for itself is a rule
 * that exists in one endpoint and nowhere else.
 */
import { raw } from '../../core/http.js';
import { ApiError } from '../../core/errors.js';
import { createProfileService } from './profile.js';
import { createSettingsService, etagFor, SCHEMA_VERSION } from './settings.js';
import { createStatsService, STAT_DEFINITION_VERSION } from './stats.js';
import { createMigrationService } from './migration.js';

/** Handlers must never read an account id from the body — that is an impersonation surface. */
function actorId(ctx) {
  const id = ctx.actor?.accountId;
  if (!id) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
  return id;
}

/** The whole authenticated actor, for calls that authorise rather than merely identify. */
function actor(ctx) {
  actorId(ctx);
  return ctx.actor;
}

/**
 * §8: `Idempotency-Key` is REQUIRED on `PATCH /profile/me`.
 *
 * Enforced at the HTTP edge rather than in the service, because "required" is a statement
 * about the request. A service call that arrives without one is an internal caller, not a
 * client that skipped a header, and refusing those would only teach them to invent keys.
 */
function idempotencyKeyOf(ctx) {
  const raw = ctx.headers?.['idempotency-key'];
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key || key.length > 200) {
    throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key is required on this request.', {
      details: { fields: [{ key: 'Idempotency-Key', reason: key ? 'too-long' : 'required' }] },
    });
  }
  return key;
}

/**
 * `raw` bodies bypass the envelope wrapper in http.js, so the correlation id is attached here.
 * `headers` is carried on the result for the server wiring to apply — the ETag in §11.2 is a
 * header, and the body shape is closed, so it cannot travel as a field.
 */
function withHeaders(status, body, headers, correlationId) {
  const out = raw(status, { ...body, correlationId });
  out.headers = headers;
  return out;
}

export function createProfileModule({
  store, clock = Date, logger = console,
  // Presence has no column and sanctions have no store accessor yet (profile.js). They are
  // injected when a service for them exists rather than read from fields no schema declares.
  readPresence = null, readActiveSanctions = null,
  // The result-application transition emits `match.result_applied` through the shared outbox,
  // so a career change is traceable like every other state change.
  outbox = null,
  /**
   * The auth service (`auth.service`), for the one thing this module must not implement
   * twice: a rename. It carries the name policy, the confusable fold, the cooldown, the
   * `account.name_changed` event and the §10 audit row. Injected rather than imported so the
   * profile module stays constructible without an auth module, exactly as its routes do with
   * the auth middleware.
   */
  identity = null,
}) {
  const profiles = createProfileService({
    store, clock, readPresence, readActiveSanctions,
    changeDisplayName: identity?.changeDisplayName
      ? (args) => identity.changeDisplayName(args)
      : null,
  });
  const settings = createSettingsService({ store, clock });
  const stats = createStatsService({ store, clock, outbox });
  const migration = createMigrationService({ store, clock });

  const handlers = {
    async getOwnProfile(ctx) {
      return profiles.getOwnProfile(actorId(ctx));
    },

    async patchOwnProfile(ctx) {
      return profiles.patchProfile(actor(ctx), ctx.body, {
        idempotencyKey: idempotencyKeyOf(ctx),
        correlationId: ctx.correlationId,
      });
    },

    async getPublicProfile(ctx) {
      return profiles.getPublicProfile(ctx.params.accountId, actorId(ctx));
    },

    async getSettings(ctx) {
      const state = await settings.read(actorId(ctx));
      return withHeaders(200, state, { ETag: etagFor(state.version) }, ctx.correlationId);
    },

    async putSettings(ctx) {
      const state = await settings.replace(actorId(ctx), {
        schemaVersion: ctx.body?.schemaVersion,
        values: ctx.body?.values,
      }, ctx.headers['if-match']);
      return withHeaders(200, state, { ETag: etagFor(state.version) }, ctx.correlationId);
    },

    async getStats(ctx) {
      const viewerId = actorId(ctx);
      const subjectId = ctx.params.accountId;
      const mode = ctx.query.get('mode') || 'all';
      if (!['tdm', 'bomb', 'all'].includes(mode)) {
        throw new ApiError('VALIDATION_FAILED', 'Unknown mode.', {
          details: { fields: [{ key: 'mode', reason: 'enum', allowed: ['tdm', 'bomb', 'all'] }] },
        });
      }
      // Privacy is the subject's, and a hidden career is null counters — not a 403, which would
      // confirm what it is refusing to show.
      const visible = await profiles.visibilityFor(subjectId, viewerId);
      if (!visible.stats) {
        return { accountId: subjectId, mode, statDefinitionVersion: STAT_DEFINITION_VERSION,
                 totals: null, weapons: null };
      }
      return stats.getCareer(subjectId, mode);
    },

    async getMatches(ctx) {
      const viewerId = actorId(ctx);
      const subjectId = ctx.params.accountId;
      const visible = await profiles.visibilityFor(subjectId, viewerId);
      // `items: null`, not `[]`. An empty list is a real answer — a player who has never
      // finished a match — and returning it for a hidden history made the two states
      // indistinguishable, so a client could neither say "no matches yet" nor "this player
      // keeps their history private", and every "why is my history empty" report was
      // unanswerable. Null is the §11.8 convention for a hidden field: present, never omitted,
      // never a 403.
      if (!visible.stats) return { items: null, nextCursor: null };
      // §10 requires an invalid limit to be REJECTED, not corrected. Clamping here silently
      // undid the validation the service and both adapters now perform: a client sending
      // ?limit=5000 got 100 rows and a 200, learned its request was fine, and would keep
      // sending it. The raw value is passed down so the one validator decides.
      // Query strings are strings; the validator wants an integer. Parse only a well-formed
      // one — anything else is passed through verbatim so the single validator rejects it,
      // rather than being coerced here into something that looks valid.
      const rawLimit = ctx.query.get('limit');
      const limit = rawLimit === null ? undefined
        : (/^\d+$/.test(rawLimit) ? Number(rawLimit) : rawLimit);
      // `?cursor=` with no value is a UI that always appends the parameter, not a malformed
      // cursor. Treat empty as absent rather than failing page one with VALIDATION_FAILED.
      const rawCursor = ctx.query.get('cursor');
      return stats.history(subjectId, { limit, cursor: rawCursor || undefined });
    },

    async importProgression(ctx) {
      return migration.importLegacyProgression(actorId(ctx), ctx.body?.progress);
    },
  };

  /** Mount on a Router from core/http.js. Auth middleware is supplied by the server wiring. */
  function routes(router, { auth } = {}) {
    const mw = auth ? { middleware: [auth] } : {};
    router.get('/v1/profile/me', handlers.getOwnProfile, mw);
    router.patch('/v1/profile/me', handlers.patchOwnProfile, mw);
    router.get('/v1/profile/me/settings', handlers.getSettings, mw);
    router.put('/v1/profile/me/settings', handlers.putSettings, mw);
    router.post('/v1/profile/me/progression-import', handlers.importProgression, mw);
    router.get('/v1/profile/:accountId', handlers.getPublicProfile, mw);
    router.get('/v1/profile/:accountId/stats', handlers.getStats, mw);
    router.get('/v1/profile/:accountId/matches', handlers.getMatches, mw);
    return router;
  }

  logger.debug?.('profile.module.ready', { schemaVersion: SCHEMA_VERSION });

  return { profiles, settings, stats, migration, handlers, routes };
}

export default createProfileModule;
