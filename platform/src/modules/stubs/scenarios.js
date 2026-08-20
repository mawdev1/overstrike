/**
 * The scenario registry.  contracts/http-api.md §11.10.
 *
 * Every scenario in that table lives here, and the table is the contract: `stubtest.mjs`
 * enumerates the names out of the markdown and fails if one is missing, so this file cannot
 * quietly fall behind the document it implements.
 *
 * A scenario is three optional things:
 *
 *   `init(state)`   seed the per-session state before the first request
 *   `pre(ctx)`      a blanket rule applied to every request (revoked session, dead dependency)
 *   `routes{}`      per-route overrides, keyed `METHOD /pattern`, receiving the base handler
 *
 * Everything a scenario does not override falls through to `routes.js`, so each entry below
 * expresses only its *difference* from correct behaviour. That is what keeps a 32-scenario
 * registry readable, and what stops a fault fixture from accidentally inventing a second,
 * subtly different definition of a valid response.
 *
 * Statefulness lives in `ctx.state`, keyed per `clientSessionId` by `index.js`. It is the
 * reason this exists: `onboarding-verify-invalid` must *fail then succeed*, and a single canned
 * response per endpoint cannot express that at all.
 */
import { ApiError } from '../../core/errors.js';
import { EPOCH_MS, iso } from './clock.js';
import { stubToken } from './ids.js';
import { revokeSession } from './accounts.js';
import * as fx from './fixtures.js';

/** Routes a verification or terms gate applies to: the ones that lead to actually playing. */
const GAMEPLAY_PREFIXES = ['/v1/rooms', '/v1/matches', '/v1/presence'];
const isGameplay = (path) => GAMEPLAY_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));

const throwErr = (code, message, opts) => { throw new ApiError(code, message, opts); };

/** Scenarios that start before an account exists, so consent is genuinely undecided at t0. */
const UNDECIDED_AT_START = (name) => name.startsWith('onboarding-') || name === 'account-pre-policy';

/** The state every session starts from, before a scenario's own `init`. */
export function initialState(scenarioName) {
  const decided = !UNDECIDED_AT_START(scenarioName);
  return {
    requests: 0,
    authCalls: 0,
    tokenGeneration: 1,
    tokenIssuedAt: null,
    // Every access token this session was issued. The auth gate accepts the shape; this is what
    // makes "the token you were given" checkable when a scenario needs it.
    issuedTokens: [],
    eligible: false,
    eligibilityReceipt: null,
    signedUp: decided,
    displayName: fx.DISPLAY_NAME,
    verified: decided,
    verifyResends: 0,
    termsVersion: 1,
    termsAccepted: decided,
    essentialSettingsDone: decided,
    recoveryStarted: false,
    consentMigrated: false,
    consent: decided
      ? {
        telemetryPersonal: true,
        policyVersion: 1,
        // Fixed, not clock-derived: this decision predates the session being replayed.
        decidedAt: iso(EPOCH_MS - 400 * 24 * 3600 * 1000),
        subject: 'account',
        sessionReceipt: stubToken('consent-session', `consent:session:${scenarioName}`),
        accountReceipt: stubToken('consent-account', `consent:account:${scenarioName}`),
      }
      : null,
    moderation: null,
    // §11.2: settings are a versioned document that round-trips, not four fixed values. The
    // seed is the ROAM vocabulary's own defaults, so a client reading them sees the real key set.
    settings: {
      version: 7,
      values: fx.roamingSettings(),
      updatedAt: iso(EPOCH_MS - 3600 * 1000),
    },
    settingsBumped: false,
    // Revocations are NOT here: they belong to the account, so a second tab sees them
    // (accounts.js). Keeping a per-session copy is what made cross-tab revocation unreachable.
    // §3b: the name-check rate window, in virtual milliseconds.
    nameCheckTimes: [],
    rooms: {},
    activeRoomId: null,
    emptyCareer: false,
    privacyFiltered: false,
    polls: 0,
    joinAttempts: 0,
    termsBumped: false,
  };
}

// ── shared override bodies ──────────────────────────────────────────────────────────────────

/** `GET /v1/matches/active` → 200: there is a held match to recover (§7.1). */
const activeMatch = (ctx) => ({
  status: 200,
  body: {
    matchId: fx.MATCH_ID,
    roomId: fx.ROOM_ID_ACTIVE,
    graceEndsAt: ctx.clock.plus(90 * 1000),
    serverNow: ctx.clock.now(),
  },
});

/** A `GET /v1/matches/:matchId` override returning one fixed TerminalResult refinement. */
const terminal = (opts) => (ctx) => ({
  status: 200,
  body: fx.terminalResult(ctx.params.matchId, opts),
});

/**
 * The gates that stand between a signed-up account and a match, in the approved order.
 *
 * Onboarding routes stay open, or the player would be locked out of the very steps that clear
 * the gate. The codes are the ones `errors.md` routes to those screens, so the shell branches on
 * the same value it will branch on in production.
 */
function setupGate(ctx) {
  if (!ctx.state.signedUp || !isGameplay(ctx.path)) return null;
  if (!ctx.state.verified) {
    throwErr('AUTH_VERIFICATION_REQUIRED', 'Verify your email to continue.', { details: { channel: 'email' } });
  }
  if (!ctx.state.termsAccepted) {
    throwErr('AUTH_TERMS_ACCEPTANCE_REQUIRED', 'Accept the updated terms to continue.', {
      details: { version: ctx.state.termsVersion },
    });
  }
  return null;
}

/** Patch the room shape a detail response returns, without restating the whole thing. */
const patchedRoom = (overrides) => (ctx, base) => {
  const res = base(ctx);
  return { ...res, body: { ...res.body, ...overrides } };
};

export const SCENARIOS = {
  // ── the baseline ──────────────────────────────────────────────────────────────────────────
  'default': {
    note: 'Signed-in account, 3 rooms across 2 regions, 20 terminal matches.',
  },

  // ── onboarding ────────────────────────────────────────────────────────────────────────────
  'onboarding-happy': {
    note: 'eligibility → consent → signup (migrates the receipt) → verify → terms → shell.',
    // The gates are the point: until verification and terms are cleared, the routes that lead
    // to a match answer with the code errors.md routes to those screens.
    pre: setupGate,
  },

  'onboarding-eligibility-denied': {
    note: 'Terminal at the age gate. No account is ever created.',
    routes: {
      'POST /v1/onboarding/eligibility': () => throwErr('AUTH_ELIGIBILITY_DENIED',
        'You are not eligible to play.', { details: { category: 'under-minimum-age' } }),
      // Terminal means terminal: signup does not become reachable by skipping the gate.
      'POST /v1/auth/signup': () => throwErr('AUTH_ELIGIBILITY_DENIED',
        'You are not eligible to play.', { details: { category: 'under-minimum-age' } }),
    },
  },

  'onboarding-consent-declined': {
    note: 'Declining is a valid outcome, not an error. Signup still succeeds.',
    routes: {
      'PUT /v1/onboarding/consent': (ctx, base) => base({ ...ctx, body: { ...ctx.body, telemetryPersonal: false } }),
    },
  },

  'onboarding-verify-invalid': {
    note: 'First verify fails; a resend is what makes the next one work.',
    routes: {
      'POST /v1/onboarding/verify/complete': (ctx, base) => (ctx.state.verifyResends === 0
        ? throwErr('AUTH_VERIFICATION_TOKEN_INVALID', 'That verification link is not valid.')
        : base(ctx)),
    },
  },

  'onboarding-verify-expired': {
    note: 'Same transition, different code — the UI obligation is resend either way.',
    routes: {
      'POST /v1/onboarding/verify/complete': (ctx, base) => (ctx.state.verifyResends === 0
        ? throwErr('AUTH_VERIFICATION_TOKEN_EXPIRED', 'That verification link has expired.')
        : base(ctx)),
    },
  },

  'onboarding-terms-conflict': {
    note: 'Accepting v1 conflicts with a v2 published underneath; accepting v2 succeeds.',
    routes: {
      'POST /v1/onboarding/terms/accept': (ctx, base) => {
        if (!ctx.state.termsBumped) {
          ctx.state.termsBumped = true;
          ctx.state.termsVersion = 2;
          throwErr('CONFLICT', 'The terms have been updated since you last read them.', {
            details: {
              currentVersion: 2,
              url: `${fx.TERMS_URL}/v2`,
              publishedAt: ctx.clock.fromEpoch(-30 * 24 * 3600 * 1000),
            },
          });
        }
        return base(ctx);
      },
    },
  },

  'onboarding-receipt-invalid': {
    note: 'The eligibility receipt is expired, forged, or for another policy version.',
    routes: {
      'POST /v1/auth/signup': () => throwErr('ELIGIBILITY_RECEIPT_INVALID',
        'Your age check expired. Please start again.'),
    },
  },

  'account-pre-policy': {
    note: 'An account created before this policy version: consent is null, meaning undecided.',
    init(state) {
      // Signed in, but with no consent decision on record — the one legitimate source of
      // `consent: null` on an account (§3a.3). The prompt is the client's job; the contract
      // surface is the null.
      state.signedUp = true;
      state.verified = true;
      state.termsAccepted = true;
      state.consent = null;
    },
  },

  // ── browser ───────────────────────────────────────────────────────────────────────────────
  'browser-empty': {
    note: 'No rooms at all — the empty state, not an error state.',
    routes: {
      'GET /v1/rooms': () => ({ status: 200, body: { items: [], nextCursor: null } }),
    },
  },

  'browser-unreachable': {
    note: 'Room service down, auth unaffected — a partial outage, which is the realistic one.',
    pre(ctx) {
      if (ctx.path === '/v1/rooms' || ctx.path.startsWith('/v1/rooms/')) {
        throwErr('SERVICE_UNAVAILABLE', 'Rooms are temporarily unavailable.', { retryAfterMs: 5000 });
      }
      return null;
    },
  },

  // ── room join refusals ────────────────────────────────────────────────────────────────────
  'room-full': {
    note: 'No slot. The browser stays put and offers another room.',
    routes: {
      'GET /v1/rooms/:id': patchedRoom({ playerCount: 12, capacity: 12, joinable: false, joinBlockedReason: 'full' }),
      'POST /v1/rooms/:id/join': () => throwErr('ROOM_FULL', 'That room just filled up.'),
    },
  },

  'room-in-progress': {
    note: 'Live and backfill not permitted — the normal Bomb case, explained rather than errored.',
    routes: {
      'GET /v1/rooms/:id': patchedRoom({ status: 'in-progress', joinable: false, joinBlockedReason: 'in-progress' }),
      'POST /v1/rooms/:id/join': () => throwErr('ROOM_IN_PROGRESS', 'That match is already under way.'),
    },
  },

  'room-password': {
    note: 'Prompt, then accept any non-empty password on the second attempt.',
    routes: {
      'GET /v1/rooms/:id': patchedRoom({ hasPassword: true }),
      'POST /v1/rooms/:id/join': (ctx, base) => {
        ctx.state.joinAttempts++;
        if (ctx.state.joinAttempts === 1) {
          throwErr('ROOM_PASSWORD_REQUIRED', 'This room is private.');
        }
        const password = ctx.body.password;
        if (typeof password !== 'string' || password.length === 0) {
          throwErr('ROOM_PASSWORD_INVALID', 'That password is not right.');
        }
        return base(ctx);
      },
    },
  },

  // ── match reconnect ───────────────────────────────────────────────────────────────────────
  'match-active-none': {
    note: 'Reload discovery with nothing to recover: 204, and the shell routes to /play.',
    routes: { 'GET /v1/matches/active': () => ({ status: 204, body: null }) },
  },

  'match-active-reconnect': {
    note: 'A held match, recovered in two requests: discover, then take the handoff.',
    routes: { 'GET /v1/matches/active': activeMatch },
  },

  'match-active-grace-expired': {
    note: 'Discovery succeeds, the seat does not — the match continued without you.',
    routes: {
      'GET /v1/matches/active': activeMatch,
      'POST /v1/matches/:matchId/reconnect-ticket': (ctx) => throwErr('RECONNECT_GRACE_EXPIRED',
        'You were away too long; the match went on without you.', {
          details: {
            graceEndsAt: ctx.clock.fromEpoch(-60 * 1000),
            roomId: fx.ROOM_ID_ACTIVE,
            rejoinable: false,
            reason: 'grace-expired',
          },
        }),
    },
  },

  // ── results ───────────────────────────────────────────────────────────────────────────────
  'result-pending-live': {
    note: 'Live: pending with endedAt null for exactly 3 polls, then completed.',
    routes: {
      'GET /v1/matches/:matchId': (ctx, base) => {
        ctx.state.polls++;
        if (ctx.state.polls <= 3) {
          return { status: 200, body: fx.pendingResult(ctx.params.matchId, { endedAt: null }) };
        }
        return base(ctx);
      },
    },
  },

  'result-pending-queued': {
    note: 'Ended and awaiting persistence: pending WITH endedAt for 2 polls, then completed.',
    routes: {
      'GET /v1/matches/:matchId': (ctx, base) => {
        ctx.state.polls++;
        if (ctx.state.polls <= 2) {
          return {
            status: 200,
            body: fx.pendingResult(ctx.params.matchId, { endedAt: ctx.clock.fromEpoch(-120 * 1000) }),
          };
        }
        return base(ctx);
      },
    },
  },

  // The four terminal refinements. Each obeys the §4.2 invariant table exactly — an aborted
  // forfeit keeps a real winner, a no-contest has none, an invalidation is the only shape with
  // a non-null invalidationReason.
  'result-aborted-forfeit': {
    note: 'aborted / forfeit / winnerTeam alpha.',
    routes: {
      'GET /v1/matches/:matchId': terminal({
        status: 'aborted', outcomeReason: 'forfeit', winnerTeam: 'alpha',
        teamScores: { alpha: 4, bravo: 2 },
      }),
    },
  },

  'result-aborted-nocontest': {
    note: 'aborted / no-contest / no winner at all.',
    routes: {
      'GET /v1/matches/:matchId': terminal({
        status: 'aborted', outcomeReason: 'no-contest', winnerTeam: null,
        teamScores: { alpha: 3, bravo: 3 },
      }),
    },
  },

  'result-invalidated': {
    note: 'invalidated / no-contest / null winner / non-null invalidationReason.',
    routes: {
      'GET /v1/matches/:matchId': terminal({
        status: 'invalidated', outcomeReason: 'no-contest', winnerTeam: null,
        invalidationReason: 'cheat-detected', teamScores: { alpha: 5, bravo: 2 },
      }),
    },
  },

  'result-draw': {
    note: 'completed / timer / draw — regulation ends level and there is no overtime in Alpha.',
    routes: {
      'GET /v1/matches/:matchId': terminal({
        status: 'completed', outcomeReason: 'timer', winnerTeam: 'draw',
        teamScores: { alpha: 6, bravo: 6 },
      }),
    },
  },

  // ── career ────────────────────────────────────────────────────────────────────────────────
  'history-mixed': {
    note: 'Terminal and pending items in one page, so the §4.3 union is actually exercised.',
    routes: {
      'GET /v1/profile/:accountId/matches': () => ({
        status: 200,
        body: { items: fx.mixedHistoryItems(), nextCursor: null },
      }),
    },
  },

  'history-empty': {
    note: 'Zero matches, zero career totals — the empty state for every career screen.',
    init(state) { state.emptyCareer = true; },
  },

  'privacy-filtered': {
    note: 'stats and presence null. Never omitted, never 403 — both would disclose the setting.',
    init(state) { state.privacyFiltered = true; },
  },

  // ── moderation, identity, session ─────────────────────────────────────────────────────────
  'sanctioned': {
    note: 'SANCTIONED on join and chat; the profile stays readable.',
    init(state) {
      state.moderation = {
        status: 'restricted',
        activeSanctions: [{ kind: 'matchmaking-ban', expiresAt: null, appealUrl: 'https://stub.overstrike.invalid/appeal' }],
      };
    },
    routes: {
      'POST /v1/rooms/:id/join': () => throwErr('SANCTIONED', 'Your account is restricted.', {
        details: {
          sanction: {
            kind: 'matchmaking-ban',
            expiresAt: null,
            appealUrl: 'https://stub.overstrike.invalid/appeal',
          },
        },
      }),
    },
  },

  'name-taken': {
    note: 'All three places a display name is judged: check, signup, rename.',
    routes: {
      // §3b: the preflight says so first, and says only so — `policy: null`, no holder.
      'POST /v1/auth/display-name/check': () => ({ status: 200, body: { available: false, policy: null } }),
      'POST /v1/auth/signup': () => throwErr('NAME_TAKEN', 'That name is already taken.'),
      'PATCH /v1/profile/me': () => throwErr('NAME_TAKEN', 'That name is already taken.'),
    },
  },

  'session-revoked': {
    note: 'The third authenticated call fails: signed out on another device, mid-session.',
    pre(ctx) {
      if (ctx.auth !== 'A') return null;
      ctx.state.authCalls++;
      if (ctx.state.authCalls >= 3) {
        throwErr('AUTH_SESSION_REVOKED', 'You were signed out on another device.');
      }
      return null;
    },
  },

  'token-expiry': {
    note: 'Access token lives 30 virtual seconds, so single-flight refresh is exercised for real.',
    // 10 s per request, so expiry arrives on the fourth request rather than the thirtieth. The
    // clock is still fixed and seeded — nothing here reads the wall clock.
    clockStepMs: 10000,
    init(state) { state.tokenIssuedAt = null; },
    pre(ctx) {
      if (ctx.auth !== 'A') return null;
      const issuedAt = ctx.state.tokenIssuedAt ?? EPOCH_MS;
      if (ctx.clock.nowMs() - issuedAt >= 30000) {
        throwErr('AUTH_TOKEN_EXPIRED', 'Your session expired. Sign in again.');
      }
      return null;
    },
  },

  // ── transport-shaped scenarios ────────────────────────────────────────────────────────────
  // These two are not HTTP behaviours at all, which is exactly why they need to be modelled:
  // a shell that only ever sees well-formed responses has no code path for either.
  'slow': {
    note: 'Every response delayed 2 s. The payload is the default one.',
    delayMs: 2000,
  },

  'offline': {
    note: 'Transport-layer failure on every request: no status, no body, no envelope.',
    transport: 'fail',
  },

  // ── REQ-CC-045: the routes §11.11 never mapped ────────────────────────────────────────────
  //
  // `design/shell-ia.md` declares 24 leaf routes; §11.11 owns 13 of them, so `/auth/recover`,
  // `/onboarding/display-name`, `/onboarding/essential-settings`, `/career/weapons`,
  // `/settings/:category`, `/sessions` and `/system/:condition` had no scenario at all — the
  // frontend lane had nothing to build those screens against, and no state fixture for their
  // loading, empty, error, offline and policy variants. These are additive: every §11.10
  // scenario above is untouched, and `coverage.js` records which route state each one serves.

  'signin-invalid-credentials': {
    note: 'Neutral refusal. Never says which of identifier or secret was wrong.',
    routes: {
      'POST /v1/auth/signin': () => throwErr('AUTH_INVALID_CREDENTIALS',
        'That email and password do not match an account.'),
    },
  },

  'signin-incomplete-setup': {
    note: 'Signed in mid-onboarding: the profile names the first incomplete step (verify).',
    init(state) {
      state.signedUp = true;
      state.verified = false;
      state.termsAccepted = false;
      state.essentialSettingsDone = false;
    },
    pre: setupGate,
  },

  'recovery-token-invalid': {
    note: 'Recovery link bad, used, or superseded — restart recovery, never verification.',
    routes: {
      'POST /v1/auth/recovery/complete': () => throwErr('AUTH_RECOVERY_TOKEN_INVALID',
        'That reset link is not valid any more.'),
    },
  },

  'recovery-token-expired': {
    note: 'Past its 30-minute TTL. Same obligation, different code, so the copy can differ.',
    routes: {
      'POST /v1/auth/recovery/complete': () => throwErr('AUTH_RECOVERY_TOKEN_EXPIRED',
        'That reset link has expired.'),
    },
  },

  'name-policy-violation': {
    note: 'The display-name refusal that is NOT "taken": 422 with the rule that failed.',
    routes: {
      // The client never reproduces the ruleset (design/first-run-flow.md §3); it shows the
      // reason the server names.
      // The preflight refuses with the same rule id the mutation would, so the screen shows
      // one reason whichever request discovered it.
      'POST /v1/auth/display-name/check': () => ({
        status: 200, body: { available: false, policy: { rule: 'impersonation' } },
      }),
      'POST /v1/auth/signup': () => throwErr('NAME_POLICY_VIOLATION',
        'That name is not allowed.', { details: { rule: 'impersonation' } }),
      'PATCH /v1/profile/me': () => throwErr('NAME_POLICY_VIOLATION',
        'That name is not allowed.', { details: { rule: 'impersonation' } }),
    },
  },

  'settings-conflict': {
    note: 'Another device wrote first: 409 with currentVersion and values, then the retry wins.',
    routes: {
      'PUT /v1/profile/me/settings': (ctx, base) => {
        // The version moves UNDER a correct If-Match exactly once, which is what two tabs
        // racing looks like. The second attempt, carrying the ETag from the 409, succeeds.
        if (!ctx.state.settingsBumped) {
          ctx.state.settingsBumped = true;
          ctx.state.settings.version++;
        }
        return base(ctx);
      },
    },
  },

  'match-not-found': {
    note: 'A match id that is not yours, or never existed. Indistinguishable, deliberately.',
    routes: {
      'GET /v1/matches/:matchId': () => throwErr('NOT_FOUND', 'That match is not available.'),
    },
  },

  'career-unavailable': {
    note: 'Career reads down, everything else fine — the recoverable error a career screen shows.',
    pre(ctx) {
      if (ctx.path.startsWith('/v1/profile/') && ctx.path !== '/v1/profile/me') {
        throwErr('SERVICE_UNAVAILABLE', 'Career data is temporarily unavailable.', { retryAfterMs: 5000 });
      }
      return null;
    },
  },

  'sessions-current-only': {
    note: 'The empty state for the sessions screen: one device, and it is this one.',
    init(state, account) {
      // Not an empty list — a session list without the caller's own session would mean the
      // caller is not signed in, which is a different screen. Seeded on the ACCOUNT, because
      // that is where the session list now lives.
      revokeSession(account, fx.OTHER_SESSION_ID);
    },
  },

  // ── REQ-CC-046: the display-name check states §3b names ───────────────────────────────────
  //
  // `available`, `taken` and `policy-refused` are base behaviour (`default` for available,
  // `name-taken`, `name-policy-violation`), and `checking` is `slow` driving the same request.
  // These two are the states a client cannot provoke on demand: a rate limiter it would have to
  // hammer to reach, and a dependency it cannot take down.

  'name-check-rate-limited': {
    note: 'The check is refused on the first call, so the debounce backoff path is buildable.',
    routes: {
      'POST /v1/auth/display-name/check': () => throwErr('RATE_LIMITED',
        'Too many name checks. Try again shortly.', { retryAfterMs: 60000 }),
    },
  },

  'name-check-unavailable': {
    note: 'The preflight is down. The field stays usable and submit stays authoritative.',
    routes: {
      'POST /v1/auth/display-name/check': () => throwErr('SERVICE_UNAVAILABLE',
        'Name checking is temporarily unavailable.', { retryAfterMs: 5000 }),
    },
  },

  'system-maintenance': {
    note: 'Planned outage on every route: MAINTENANCE with details.until, and no retry storm.',
    pre(ctx) {
      throwErr('MAINTENANCE', 'OVERSTRIKE is down for scheduled maintenance.', {
        details: { until: ctx.clock.fromEpoch(45 * 60 * 1000) },
      });
    },
  },

  'unsupported-client': {
    note: 'A well-formed build below the floor: 426, upgrade only, never retried.',
    // Distinct from the gate refusal in gates.js, which catches an absent or malformed header.
    // This is the floor itself, which is the branch a shipped client actually hits.
    pre(ctx) {
      if (ctx.path.startsWith('/v1/health')) return null;
      throwErr('UNSUPPORTED_CLIENT', 'Please update the game to continue.',
        { details: { reason: 'build' } });
    },
  },

  'active-lobby-resync': {
    note: 'Reload while in a room: no held match, presence names the room, ticket resyncs it.',
    init(state) {
      // design/first-run-flow.md: "Active lobby membership → Lobby resync screen, then
      // authoritative room". The room id survives only on the server, which is the point.
      state.activeRoomId = fx.ROOM_IDS[0];
    },
  },
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS);

/**
 * Scenarios this layer adds beyond the §11.10 table, each with the route state it exists to
 * serve. `stubtest.mjs` requires every extra to be declared here, so the registry can grow with
 * REQ-CC-045 without becoming a place where undocumented fixtures accumulate.
 */
export const EXTRA_SCENARIOS = {
  'signin-invalid-credentials': '/auth/sign-in recoverable error (REQ-CC-045)',
  'signin-incomplete-setup': '/auth/sign-in resume at the first incomplete step (REQ-CC-045)',
  'recovery-token-invalid': '/auth/recover recoverable error (REQ-CC-045)',
  'recovery-token-expired': '/auth/recover terminal state (REQ-CC-045)',
  'name-policy-violation': '/onboarding/display-name policy refusal (REQ-CC-045)',
  'settings-conflict': '/settings/:category and /onboarding/essential-settings conflict (REQ-CC-045)',
  'match-not-found': '/career/matches/:matchId not found (REQ-CC-045)',
  'career-unavailable': '/career/* recoverable error (REQ-CC-045)',
  'sessions-current-only': '/sessions empty state (REQ-CC-045)',
  'system-maintenance': '/system/:condition maintenance (REQ-CC-045)',
  'unsupported-client': '/system/:condition update required (REQ-CC-045)',
  'active-lobby-resync': 'active-lobby discovery and resync after reload (REQ-CC-045)',
  'name-check-rate-limited': '/onboarding/display-name check rate-limited (REQ-CC-046)',
  'name-check-unavailable': '/onboarding/display-name check unavailable (REQ-CC-046)',
};
