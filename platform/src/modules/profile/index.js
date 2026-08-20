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

export function createProfileModule({ store, clock = Date, logger = console }) {
  const profiles = createProfileService({ store, clock });
  const settings = createSettingsService({ store, clock });
  const stats = createStatsService({ store, clock });
  const migration = createMigrationService({ store, clock });

  const handlers = {
    async getOwnProfile(ctx) {
      return profiles.getOwnProfile(actorId(ctx));
    },

    async patchOwnProfile(ctx) {
      return profiles.patchProfile(actorId(ctx), ctx.body);
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
      const view = await profiles.getPublicProfile(subjectId, viewerId);
      if (!view.statsVisible) {
        return { accountId: subjectId, mode, statDefinitionVersion: STAT_DEFINITION_VERSION,
                 totals: null, weapons: null };
      }
      return stats.getCareer(subjectId, mode);
    },

    async getMatches(ctx) {
      const viewerId = actorId(ctx);
      const subjectId = ctx.params.accountId;
      const view = await profiles.getPublicProfile(subjectId, viewerId);
      if (!view.statsVisible) return { items: [], nextCursor: null };
      const limit = Math.min(50, Math.max(1, Number(ctx.query.get('limit')) || 25));
      return stats.history(subjectId, { limit, cursor: ctx.query.get('cursor') });
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
