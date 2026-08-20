/**
 * The stub route table — the base behaviour every scenario starts from.
 * contracts/http-api.md §3–§7 and §11.1–§11.9.
 *
 * These handlers are already stateful: `PUT /v1/onboarding/consent` records a decision that
 * `POST /v1/auth/signup` then migrates onto the account, terms acceptance compares versions,
 * and verification flips a flag that gates the gameplay routes. A scenario in `scenarios.js`
 * layers *faults and variants* on top of this; it does not reimplement the happy path, so there
 * is exactly one definition of what a correct response looks like.
 *
 * Auth class per row is `P`/`A`/`S` from §2. It is not enforced as authentication — the stub
 * has no tokens worth checking — but scenarios like `session-revoked` and `token-expiry` need
 * to know which requests an expired credential would have broken.
 */
import { ApiError } from '../../core/errors.js';
import * as fx from './fixtures.js';
import { stubToken, stubUlid } from './ids.js';

const okBody = (body) => ({ status: 200, body });
const created = (body) => ({ status: 201, body });
const accepted = (body = {}) => ({ status: 202, body });
const noContent = () => ({ status: 204, body: null });

const CONSENT_POLICY_VERSION = 1;

function validationFailed(fields) {
  return new ApiError('VALIDATION_FAILED', 'Some fields need attention.', {
    details: { fields },
  });
}

/** §11.8 signup body. `clientSessionId` and `consentReceipt` are REQUIRED, not optional. */
function requireFields(body, names) {
  const missing = names.filter((n) => body[n] === undefined || body[n] === null || body[n] === '');
  if (missing.length) {
    throw validationFailed(missing.map((path) => ({ path, rule: 'required', message: 'This field is required.' })));
  }
}

/** §10 pagination. Cursor-based only — offset pagination double-counts under concurrent insert. */
function paginate(items, query) {
  const limitRaw = query.limit;
  let limit = 25;
  if (limitRaw !== undefined) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw validationFailed([{ path: 'limit', rule: 'range', message: 'limit is 1–100.' }]);
    }
  }
  const start = query.cursor ? Number(query.cursor) : 0;
  if (!Number.isInteger(start) || start < 0) {
    throw validationFailed([{ path: 'cursor', rule: 'format', message: 'cursor is opaque; pass one the server issued.' }]);
  }
  const page = items.slice(start, start + limit);
  const next = start + limit < items.length ? String(start + limit) : null;
  return { items: page, nextCursor: next };
}

/** The account-scoped consent projection for a profile, or null when undecided. */
function consentProjection(state) {
  if (!state.consent) return null;
  return {
    telemetryPersonal: state.consent.telemetryPersonal,
    policyVersion: state.consent.policyVersion,
    decidedAt: state.consent.decidedAt,
  };
}

function authPayload(ctx, { status }) {
  const { clock, state } = ctx;
  const body = {
    accessToken: stubToken('access', `access:${state.tokenGeneration}`),
    expiresAt: clock.plus(ctx.accessTokenTtlMs),
    session: {
      sessionId: stubUlid('session:current', clock.nowMs()),
      deviceLabel: 'Chrome on macOS',
      createdAt: clock.now(),
    },
    profile: fx.profileMe({ consent: consentProjection(state), moderation: state.moderation }),
    // §3a.3: signup AND signin return the account-scoped receipt; null means undecided.
    consentReceipt: state.consent ? state.consent.accountReceipt : null,
  };
  return { status, body };
}

export const ROUTES = [
  // ── §3 auth ───────────────────────────────────────────────────────────────────────────────
  { method: 'POST', path: '/v1/auth/signup', auth: 'P', handler(ctx) {
    requireFields(ctx.body, ['email', 'password', 'displayName', 'eligibilityReceipt',
      'clientSessionId', 'consentReceipt']);
    const { state } = ctx;
    // Migration (§3a.3): the signed-out decision becomes account-scoped and gets a new receipt.
    if (state.consent) {
      state.consent.subject = 'account';
      state.consent.accountReceipt = stubToken('consent-account', `consent:account:${ctx.scenario}`);
      state.consentMigrated = true;
    }
    state.signedUp = true;
    state.tokenIssuedAt = ctx.clock.nowMs();
    return authPayload(ctx, { status: 201 });
  } },

  { method: 'POST', path: '/v1/auth/signin', auth: 'P', handler(ctx) {
    requireFields(ctx.body, ['email', 'password']);
    ctx.state.signedUp = true;
    ctx.state.tokenIssuedAt = ctx.clock.nowMs();
    return authPayload(ctx, { status: 200 });
  } },

  // §11.1: empty body. The refresh credential travels only as an httpOnly cookie, so there is
  // nothing here for XSS to read and nothing for the client to forward.
  { method: 'POST', path: '/v1/auth/refresh', auth: 'P', handler(ctx) {
    ctx.state.tokenGeneration++;
    ctx.state.tokenIssuedAt = ctx.clock.nowMs();
    return okBody({
      accessToken: stubToken('access', `access:${ctx.state.tokenGeneration}`),
      expiresAt: ctx.clock.plus(ctx.accessTokenTtlMs),
      session: {
        sessionId: stubUlid('session:current', ctx.clock.nowMs()),
        deviceLabel: 'Chrome on macOS',
        createdAt: ctx.clock.now(),
      },
    });
  } },

  { method: 'POST', path: '/v1/auth/signout', auth: 'A', handler: () => noContent() },
  { method: 'POST', path: '/v1/auth/signout-all', auth: 'A', handler: () => noContent() },
  { method: 'GET', path: '/v1/auth/sessions', auth: 'A', handler: () => okBody({ sessions: fx.sessionsList() }) },
  { method: 'DELETE', path: '/v1/auth/sessions/:id', auth: 'A', handler: () => noContent() },

  // Always 202, whether or not the account exists — the response is the same either way, or it
  // becomes an account-existence oracle.
  { method: 'POST', path: '/v1/auth/recovery/start', auth: 'P', handler(ctx) {
    requireFields(ctx.body, ['email']);
    return accepted();
  } },
  { method: 'POST', path: '/v1/auth/recovery/complete', auth: 'P', handler(ctx) {
    requireFields(ctx.body, ['token', 'newPassword']);
    return noContent();
  } },

  // ── §3a onboarding ────────────────────────────────────────────────────────────────────────
  { method: 'POST', path: '/v1/onboarding/eligibility', auth: 'P', handler(ctx) {
    requireFields(ctx.body, ['dateOfBirth', 'jurisdiction']);
    ctx.state.eligible = true;
    return okBody({
      eligible: true,
      receipt: stubToken('eligibility', `eligibility:${ctx.scenario}`),
      expiresAt: ctx.clock.plus(30 * 60 * 1000),
      // §3a.1: `minimumAge` is deliberately absent. Publishing the number the gate tests
      // against is how the next attempt clears it.
      policyVersion: CONSENT_POLICY_VERSION,
    });
  } },

  { method: 'GET', path: '/v1/onboarding/consent', auth: 'P', handler(ctx) {
    // 204 when undecided: there is no decision to report, and inventing `telemetryPersonal:
    // false` would be recording a decline nobody made.
    if (!ctx.state.consent) return noContent();
    const c = ctx.state.consent;
    return okBody({
      telemetryPersonal: c.telemetryPersonal,
      policyVersion: c.policyVersion,
      decidedAt: c.decidedAt,
      subject: c.subject,
      receipt: c.subject === 'account' ? c.accountReceipt : c.sessionReceipt,
    });
  } },

  { method: 'PUT', path: '/v1/onboarding/consent', auth: 'P', handler(ctx) {
    const { body, state } = ctx;
    if (typeof body.telemetryPersonal !== 'boolean') {
      throw validationFailed([{ path: 'telemetryPersonal', rule: 'boolean', message: 'Answer is required.' }]);
    }
    // §3a.3: required when signed out, ignored when authenticated — the account is the
    // stronger subject.
    const authenticated = Boolean(ctx.headers.authorization);
    if (!authenticated && !body.clientSessionId) {
      throw validationFailed([{ path: 'clientSessionId', rule: 'required', message: 'Required while signed out.' }]);
    }
    const subject = authenticated || state.signedUp ? 'account' : 'client-session';
    state.consent = {
      telemetryPersonal: body.telemetryPersonal,
      policyVersion: body.policyVersion ?? CONSENT_POLICY_VERSION,
      decidedAt: ctx.clock.now(),
      subject,
      sessionReceipt: stubToken('consent-session', `consent:session:${ctx.scenario}`),
      accountReceipt: stubToken('consent-account', `consent:account:${ctx.scenario}`),
    };
    return okBody({
      telemetryPersonal: state.consent.telemetryPersonal,
      policyVersion: state.consent.policyVersion,
      decidedAt: state.consent.decidedAt,
      subject,
      receipt: subject === 'account' ? state.consent.accountReceipt : state.consent.sessionReceipt,
    });
  } },

  { method: 'POST', path: '/v1/onboarding/verify/resend', auth: 'A', handler(ctx) {
    ctx.state.verifyResends++;
    return accepted();
  } },

  { method: 'POST', path: '/v1/onboarding/verify/complete', auth: 'A', handler(ctx) {
    requireFields(ctx.body, ['token']);
    ctx.state.verified = true;
    return noContent();
  } },

  { method: 'GET', path: '/v1/onboarding/terms', auth: 'P', handler(ctx) {
    return okBody({
      version: ctx.state.termsVersion,
      url: `${fx.TERMS_URL}/v${ctx.state.termsVersion}`,
      publishedAt: ctx.clock.fromEpoch(-30 * 24 * 3600 * 1000),
    });
  } },

  { method: 'POST', path: '/v1/onboarding/terms/accept', auth: 'A', handler(ctx) {
    requireFields(ctx.body, ['version']);
    const current = ctx.state.termsVersion;
    if (ctx.body.version !== current) {
      throw new ApiError('CONFLICT', 'The terms have been updated since you last read them.', {
        details: {
          currentVersion: current,
          url: `${fx.TERMS_URL}/v${current}`,
          publishedAt: ctx.clock.fromEpoch(-30 * 24 * 3600 * 1000),
        },
      });
    }
    ctx.state.termsAccepted = true;
    return noContent();
  } },

  // ── §4 profile ────────────────────────────────────────────────────────────────────────────
  { method: 'GET', path: '/v1/profile/me', auth: 'A', handler(ctx) {
    return okBody(fx.profileMe({ consent: consentProjection(ctx.state), moderation: ctx.state.moderation }));
  } },

  { method: 'PATCH', path: '/v1/profile/me', auth: 'A', handler(ctx) {
    if (ctx.body.displayName !== undefined && typeof ctx.body.displayName !== 'string') {
      throw validationFailed([{ path: 'displayName', rule: 'string', message: 'Display name must be text.' }]);
    }
    return okBody(fx.profileMe({
      consent: consentProjection(ctx.state),
      moderation: ctx.state.moderation,
      displayName: ctx.body.displayName || undefined,
    }));
  } },

  { method: 'GET', path: '/v1/profile/me/settings', auth: 'A', handler(ctx) {
    return {
      status: 200,
      headers: { ETag: `"${ctx.state.settingsVersion}"` },
      body: {
        schemaVersion: 1,
        version: ctx.state.settingsVersion,
        values: fx.roamingSettings(),
        updatedAt: ctx.clock.fromEpoch(-3600 * 1000),
      },
    };
  } },

  { method: 'PUT', path: '/v1/profile/me/settings', auth: 'A', handler(ctx) {
    const ifMatch = ctx.headers['if-match'];
    // §3a.4: a missing `If-Match` is CONFLICT with a reason, never 428. One code, one status,
    // or the client cannot branch on status at all.
    if (!ifMatch) {
      throw new ApiError('CONFLICT', 'Settings require an If-Match header.', { details: { reason: 'if-match-required' } });
    }
    const want = Number(String(ifMatch).replace(/"/g, ''));
    if (want !== ctx.state.settingsVersion) {
      throw new ApiError('CONFLICT', 'These settings changed on another device.', {
        details: { currentVersion: ctx.state.settingsVersion, values: fx.roamingSettings() },
      });
    }
    ctx.state.settingsVersion++;
    return okBody({
      schemaVersion: 1,
      version: ctx.state.settingsVersion,
      values: fx.roamingSettings(),
      updatedAt: ctx.clock.now(),
    });
  } },

  { method: 'GET', path: '/v1/profile/:accountId/stats', auth: 'A', handler(ctx) {
    const mode = ctx.query.mode ?? 'all';
    if (!['tdm', 'bomb', 'all'].includes(mode)) {
      throw validationFailed([{ path: 'mode', rule: 'enum', message: 'mode is tdm, bomb, or all.' }]);
    }
    const scale = ctx.state.emptyCareer ? 0 : 1;
    // §11.8: `all` does NOT sum across modes — a combined K/D over two rulesets with different
    // death semantics is a number that means nothing.
    if (mode === 'all') {
      return okBody({ modes: { tdm: fx.statsTotals('tdm', { scale }), bomb: fx.statsTotals('bomb', { scale }) } });
    }
    return okBody(fx.statsTotals(mode, { scale }));
  } },

  { method: 'GET', path: '/v1/profile/:accountId/matches', auth: 'A', handler(ctx) {
    const items = ctx.state.emptyCareer ? [] : fx.historyItems();
    return okBody(paginate(items, ctx.query));
  } },

  { method: 'GET', path: '/v1/profile/:accountId', auth: 'A', handler(ctx) {
    return okBody(fx.publicProfile({
      statsVisible: !ctx.state.privacyFiltered,
      presenceVisible: !ctx.state.privacyFiltered,
    }));
  } },

  // ── §5 presence ───────────────────────────────────────────────────────────────────────────
  { method: 'GET', path: '/v1/presence/online', auth: 'A', handler(ctx) {
    return okBody(paginate(fx.presenceItems(), ctx.query));
  } },
  { method: 'GET', path: '/v1/presence/recent', auth: 'A', handler(ctx) {
    return okBody(paginate(fx.presenceItems().slice(0, 2), ctx.query));
  } },

  // ── §6 rooms ──────────────────────────────────────────────────────────────────────────────
  { method: 'GET', path: '/v1/rooms', auth: 'A', handler(ctx) {
    const allowed = new Set(['region', 'mode', 'hasSpace', 'limit', 'cursor']);
    // §6: unknown parameters are rejected rather than ignored, so a typo in a filter is a
    // visible failure and not a silently wider result set.
    for (const key of Object.keys(ctx.query)) {
      if (!allowed.has(key)) {
        throw validationFailed([{ path: key, rule: 'unknown', message: 'Unknown query parameter.' }]);
      }
    }
    const rtt = fx.parseRegionRtt(ctx.headers['x-region-rtt']);
    let rooms = [0, 1, 2].map((i) => fx.roomCore(i, { rtt }));
    if (ctx.query.region) rooms = rooms.filter((r) => r.region === ctx.query.region);
    if (ctx.query.mode) rooms = rooms.filter((r) => r.mode === ctx.query.mode);
    if (ctx.query.hasSpace === 'true') rooms = rooms.filter((r) => r.playerCount < r.capacity);
    return okBody(paginate(rooms, ctx.query));
  } },

  { method: 'POST', path: '/v1/rooms', auth: 'A', handler(ctx) {
    requireFields(ctx.body, ['name', 'region', 'mapId', 'mode', 'capacity']);
    if (!['tdm', 'bomb'].includes(ctx.body.mode)) {
      throw validationFailed([{ path: 'mode', rule: 'enum', message: 'mode is tdm or bomb.' }]);
    }
    const roomId = stubUlid(`room:created:${ctx.scenario}`, ctx.clock.nowMs());
    const index = ctx.body.mode === 'bomb' ? 1 : 0;
    const res = fx.reservation(ctx.clock, `create:${ctx.scenario}`);
    return created({
      room: fx.roomCore(index, {
        roomId,
        overrides: {
          name: ctx.body.name, region: ctx.body.region, capacity: ctx.body.capacity,
          playerCount: 1, status: 'open', joinable: true, joinBlockedReason: null,
          hasPassword: Boolean(ctx.body.password), ownerAccountId: fx.ACCOUNT_ID,
        },
      }),
      roster: fx.roster(index, { count: 1, roomId }),
      countdown: null,
      ...res,
    });
  } },

  { method: 'GET', path: '/v1/rooms/:id', auth: 'A', handler(ctx) {
    const rtt = fx.parseRegionRtt(ctx.headers['x-region-rtt']);
    const index = fx.roomIndexFor(ctx.params.id);
    return okBody(fx.roomDetail(index, { rtt, roomId: ctx.params.id }));
  } },

  { method: 'POST', path: '/v1/rooms/:id/join', auth: 'A', handler(ctx) {
    return okBody(fx.reservation(ctx.clock, `join:${ctx.scenario}`));
  } },

  { method: 'POST', path: '/v1/rooms/:id/leave', auth: 'A', handler: () => noContent() },

  { method: 'POST', path: '/v1/rooms/:id/team', auth: 'A', handler(ctx) {
    if (!['alpha', 'bravo', 'auto'].includes(ctx.body.team)) {
      throw validationFailed([{ path: 'team', rule: 'enum', message: 'team is alpha, bravo, or auto.' }]);
    }
    const index = fx.roomIndexFor(ctx.params.id);
    return okBody(fx.roomDetail(index, { roomId: ctx.params.id }));
  } },

  { method: 'POST', path: '/v1/rooms/:id/ready', auth: 'A', handler(ctx) {
    if (typeof ctx.body.ready !== 'boolean') {
      throw validationFailed([{ path: 'ready', rule: 'boolean', message: 'ready must be true or false.' }]);
    }
    const index = fx.roomIndexFor(ctx.params.id);
    return okBody(fx.roomDetail(index, { roomId: ctx.params.id }));
  } },

  { method: 'POST', path: '/v1/rooms/:id/loadout', auth: 'A', handler(ctx) {
    const { primaryIdx, secondaryIdx } = ctx.body;
    if (!Number.isInteger(primaryIdx) || !Number.isInteger(secondaryIdx)
        || primaryIdx < 0 || primaryIdx > 5 || secondaryIdx < 0 || secondaryIdx > 3) {
      throw validationFailed([{ path: 'primaryIdx', rule: 'range', message: 'Index out of range for this ruleset.' }]);
    }
    const index = fx.roomIndexFor(ctx.params.id);
    return okBody(fx.roomDetail(index, { roomId: ctx.params.id }));
  } },

  { method: 'POST', path: '/v1/rooms/:id/launch', auth: 'A', handler: () => accepted() },

  { method: 'POST', path: '/v1/rooms/:id/reconnect-ticket', auth: 'A', handler(ctx) {
    const res = fx.reservation(ctx.clock, `reconnect:${ctx.scenario}`);
    return okBody({
      lobbySocketUrl: res.lobbySocketUrl,
      lobbyTicket: res.lobbyTicket,
      expiresAt: res.expiresAt,
      graceEndsAt: ctx.clock.plus(90 * 1000),
    });
  } },

  // ── §7 matches, reports, config ───────────────────────────────────────────────────────────
  // §7.1: reload discovery. 204 means no held match — the default for a signed-in account that
  // is not in one.
  { method: 'GET', path: '/v1/matches/active', auth: 'A', handler: () => noContent() },

  { method: 'GET', path: '/v1/matches/:matchId', auth: 'A', handler(ctx) {
    return okBody(fx.terminalResult(ctx.params.matchId, {
      status: 'completed', outcomeReason: 'defuse', winnerTeam: 'alpha',
    }));
  } },

  { method: 'POST', path: '/v1/matches/:matchId/reconnect-ticket', auth: 'A', handler(ctx) {
    return okBody({
      handoff: fx.matchHandoff(ctx.params.matchId, ctx.clock),
      graceEndsAt: ctx.clock.plus(90 * 1000),
      // The client converts against `serverNow`, never its own clock: a client counting down
      // from its own drop timestamp disagrees with the server about when its seat expires.
      serverNow: ctx.clock.now(),
    });
  } },

  { method: 'POST', path: '/v1/reports', auth: 'A', handler(ctx) {
    requireFields(ctx.body, ['subjectAccountId', 'category']);
    const categories = ['cheating', 'harassment', 'offensive-name', 'griefing', 'other'];
    if (!categories.includes(ctx.body.category)) {
      throw validationFailed([{ path: 'category', rule: 'enum', message: 'Unknown report category.' }]);
    }
    return created({ reportId: stubUlid(`report:${ctx.scenario}`, ctx.clock.nowMs()) });
  } },

  { method: 'GET', path: '/v1/config/flags', auth: 'A', handler(ctx) {
    return {
      status: 200,
      headers: { 'Cache-Control': 'max-age=60' },
      body: {
        version: 41,
        evaluatedAt: ctx.clock.now(),
        expiresAt: ctx.clock.plus(60 * 1000),
        flags: fx.clientFlags(),
      },
    };
  } },

  { method: 'GET', path: '/v1/config/regions', auth: 'P', handler: () => okBody({ regions: fx.REGIONS }) },

  { method: 'GET', path: '/v1/health', auth: 'P', handler: () => okBody({ ok: true }) },
  { method: 'GET', path: '/v1/health/ready', auth: 'S', handler: () => okBody({ ok: true, dependencies: { db: 'up', flags: 'up' } }) },

  // `POST /v1/matches/:matchId/result` is deliberately ABSENT. It is service-only and never
  // browser-reachable (§7); stubbing it would put a route in the shell's reach whose entire
  // security property is that the shell cannot reach it.
];

export { okBody, created, accepted, noContent, validationFailed, consentProjection };
