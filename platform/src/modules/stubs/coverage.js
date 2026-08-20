/**
 * The coverage map, executable.  contracts/http-api.md §11.11, design/shell-ia.md route
 * hierarchy and screen-variant table.
 *
 * §11.11 states which scenario owns which route's states so that coverage is *auditable rather
 * than inferred from names*. A table in a document cannot be audited by itself, so it is
 * mirrored here as data plus the request sequence that actually drives each scenario —
 * `stubtest.mjs` parses the contract, diffs it against `COVERAGE_MAP`, then runs every
 * sequence. A row nobody can run is a gap the test reports, not a claim the table makes.
 *
 * §11.11 owns 13 rows. `shell-ia.md` declares 27 addressable routes, so `/auth/recover`,
 * `/onboarding/display-name`, `/onboarding/essential-settings`, `/career/weapons`,
 * `/settings/:category`, `/sessions` and `/system/:condition` had no owning scenario at all —
 * and none of the 13 named which of the five required variants (loading, empty, recoverable
 * error, offline/stale, terminal/policy) each owner served. `ROUTE_COVERAGE` below closes both:
 * every route in the hierarchy, every variant, each one either a runnable scenario plus the
 * requests that reach it, or an explicit not-applicable with the reason (REQ-CC-045).
 *
 * `SCENARIO_PROBES` remains the canonical way to *exercise* a scenario: the request sequence the
 * owning screen would make, in order, including the repeats a stateful scenario needs.
 */
import * as fx from './fixtures.js';

const ROOM = fx.ROOM_IDS[0];
const MATCH = fx.MATCH_ID;
const ACCOUNT = fx.ACCOUNT_ID;
const CLIENT_SESSION = '01JSTUBSESSION0000000000000';

// ── request builders ────────────────────────────────────────────────────────────────────────
//
// A probe entry is a request, or a function of the responses so far. The second form exists
// because the approved order is a CHAIN: signup presents the receipts eligibility and consent
// issued, and a probe that posted an invented receipt would be exercising the fault path while
// claiming to exercise the happy one.

const eligibility = { method: 'POST', path: '/v1/onboarding/eligibility', body: { dateOfBirth: '1994-03-02', jurisdiction: 'CA-ON' } };
const consentAccept = { method: 'PUT', path: '/v1/onboarding/consent', body: { telemetryPersonal: true, policyVersion: 1, clientSessionId: CLIENT_SESSION } };
const consentDecline = { method: 'PUT', path: '/v1/onboarding/consent', body: { telemetryPersonal: false, policyVersion: 1, clientSessionId: CLIENT_SESSION } };

/** Signup, carrying the receipts this session was actually issued. */
const signup = (prev) => {
  const elig = [...prev].reverse().find((r) => r.body && r.body.eligible === true);
  const consent = [...prev].reverse().find((r) => r.body && typeof r.body.subject === 'string');
  return {
    method: 'POST',
    path: '/v1/auth/signup',
    body: {
      email: 'stub@example.invalid',
      password: 'correct horse battery staple',
      displayName: 'StubRunner',
      eligibilityReceipt: elig ? elig.body.receipt : 'stub.eligibility.absent',
      clientSessionId: CLIENT_SESSION,
      consentReceipt: consent ? consent.body.receipt : 'stub.consent-session.absent',
    },
  };
};

/** A signup with invented receipts — the shape a client that skipped the gates would send. */
const signupUnbacked = {
  method: 'POST',
  path: '/v1/auth/signup',
  body: {
    email: 'stub@example.invalid',
    password: 'correct horse battery staple',
    displayName: 'StubRunner',
    eligibilityReceipt: 'stub.eligibility.invented',
    clientSessionId: CLIENT_SESSION,
    consentReceipt: 'stub.consent-session.invented',
  },
};

const signin = { method: 'POST', path: '/v1/auth/signin', body: { email: 'stub@example.invalid', password: 'correct horse battery staple' } };
const refresh = { method: 'POST', path: '/v1/auth/refresh', body: {} };
const verifyComplete = { method: 'POST', path: '/v1/onboarding/verify/complete', body: { token: 'stub-verify-token' } };
const verifyResend = { method: 'POST', path: '/v1/onboarding/verify/resend', body: {} };
const getTerms = { method: 'GET', path: '/v1/onboarding/terms' };
const acceptTerms = (version) => ({ method: 'POST', path: '/v1/onboarding/terms/accept', body: { version } });
const recoveryStart = { method: 'POST', path: '/v1/auth/recovery/start', body: { email: 'stub@example.invalid' } };
const recoveryComplete = { method: 'POST', path: '/v1/auth/recovery/complete', body: { token: 'stub-recovery-token', newPassword: 'a whole new horse' } };

const listRooms = { method: 'GET', path: '/v1/rooms' };
const roomDetail = { method: 'GET', path: `/v1/rooms/${ROOM}` };
const unknownRoom = { method: 'GET', path: '/v1/rooms/01JSTUBGONEROOM00000000000' };
const join = (password = null) => ({ method: 'POST', path: `/v1/rooms/${ROOM}/join`, body: { password, preferredTeam: 'auto' } });
const setTeam = (team) => ({ method: 'POST', path: `/v1/rooms/${ROOM}/team`, body: { team } });
const setReady = (ready) => ({ method: 'POST', path: `/v1/rooms/${ROOM}/ready`, body: { ready } });
const setLoadout = { method: 'POST', path: `/v1/rooms/${ROOM}/loadout`, body: { primaryIdx: 2, secondaryIdx: 1 } };
const lobbyTicket = { method: 'POST', path: `/v1/rooms/${ROOM}/reconnect-ticket`, body: {} };

/**
 * The four seeded refusal rooms (`fixtures.js`, REFUSAL_ROOM_IDS), addressed directly — which
 * is how a room link is followed, and the only way to reach a room outside `GET /v1/rooms`.
 */
const refusal = (kind, suffix, body = {}) => ({
  method: suffix ? 'POST' : 'GET',
  path: `/v1/rooms/${fx.REFUSAL_ROOM_IDS[kind]}${suffix ? `/${suffix}` : ''}`,
  body,
});

const activeMatch = { method: 'GET', path: '/v1/matches/active' };
const matchTicket = { method: 'POST', path: `/v1/matches/${MATCH}/reconnect-ticket`, body: {} };
const matchDetail = { method: 'GET', path: `/v1/matches/${MATCH}` };
const history = { method: 'GET', path: `/v1/profile/${ACCOUNT}/matches` };
const statsAll = { method: 'GET', path: `/v1/profile/${ACCOUNT}/stats`, query: { mode: 'all' } };
const statsBomb = { method: 'GET', path: `/v1/profile/${ACCOUNT}/stats`, query: { mode: 'bomb' } };
const publicProfile = { method: 'GET', path: `/v1/profile/${fx.OTHER_ACCOUNT_ID}` };
const selfProfile = { method: 'GET', path: `/v1/profile/${ACCOUNT}` };
const profileMe = { method: 'GET', path: '/v1/profile/me' };
const rename = { method: 'PATCH', path: '/v1/profile/me', body: { displayName: 'Taken' } };
const sessions = { method: 'GET', path: '/v1/auth/sessions' };
const revokeUnknownSession = { method: 'DELETE', path: '/v1/auth/sessions/01JSTUBNOSUCHSESSION000000' };
const health = { method: 'GET', path: '/v1/health' };
const regions = { method: 'GET', path: '/v1/config/regions' };

const getSettings = { method: 'GET', path: '/v1/profile/me/settings' };
const signoutAll = { method: 'POST', path: '/v1/auth/signout-all', body: {} };

/** §3b: the preflight the display-name field fires while the player types. */
const nameCheck = (displayName) => ({
  method: 'POST', path: '/v1/auth/display-name/check', body: { displayName },
});

/** A settings write carrying the ETag the last settings response handed back. */
const putSettings = (values) => (prev) => {
  const last = [...prev].reverse().find((r) => r.body
    && (typeof r.body.version === 'number' || r.body?.error?.details?.currentVersion !== undefined));
  const version = last
    ? (typeof last.body.version === 'number' ? last.body.version : last.body.error.details.currentVersion)
    : 7;
  return {
    method: 'PUT',
    path: '/v1/profile/me/settings',
    headers: { 'If-Match': `"${version}"` },
    body: { schemaVersion: 1, values },
  };
};

/** A ROAM write a settings screen would actually make. */
const ROAM_WRITE = {
  sensitivity: 1.25,
  fov: 103,
  invertY: true,
  keybinds: { crouch: { primary: 'KeyC', secondary: null }, lean: { primary: 'KeyQ', secondary: null } },
};

/** §11.9: volume is DEVICE, so the server rejects it rather than roaming it to another machine. */
const DEVICE_WRITE = { sensitivity: 1.25, masterVolume: 50 };

const putSettingsNoIfMatch = { method: 'PUT', path: '/v1/profile/me/settings', body: { schemaVersion: 1, values: ROAM_WRITE } };

/** The request sequence that drives each scenario to the state it exists to demonstrate. */
export const SCENARIO_PROBES = {
  // Signed-in scenarios start by signing in, because every `A` row now requires the credential
  // the contract says it requires — a probe that skipped it was only ever passing because the
  // stub was not checking.
  'default': [health, regions, signin, nameCheck('Nova Prime'), listRooms, roomDetail, statsAll, history],
  'onboarding-happy': [eligibility, consentAccept, signup, join(), verifyComplete, getTerms, acceptTerms(1), join()],
  'onboarding-eligibility-denied': [eligibility, signupUnbacked],
  'onboarding-consent-declined': [eligibility, consentDecline, signup],
  'onboarding-verify-invalid': [eligibility, consentAccept, signup, verifyComplete, verifyResend, verifyComplete],
  'onboarding-verify-expired': [eligibility, consentAccept, signup, verifyComplete, verifyResend, verifyComplete],
  'onboarding-terms-conflict': [eligibility, consentAccept, signup, getTerms, acceptTerms(1), getTerms, acceptTerms(2)],
  'onboarding-receipt-invalid': [eligibility, consentAccept, signup],
  'account-pre-policy': [signin, profileMe],
  'browser-empty': [signin, listRooms],
  'browser-unreachable': [signin, listRooms, signin],
  'room-full': [signin, roomDetail, join()],
  'room-in-progress': [signin, roomDetail, join()],
  'room-password': [signin, join(), join('any-password')],
  'room-refusals': [signin,
    refusal('closing'), refusal('closing', 'join'),
    refusal('full'), refusal('full', 'join'),
    refusal('teamFull'), refusal('teamFull', 'team', { team: 'bravo' }),
    refusal('liveOwned'), refusal('liveOwned', 'launch')],
  'match-active-none': [signin, activeMatch],
  'match-active-reconnect': [signin, activeMatch, matchTicket],
  'match-active-grace-expired': [signin, activeMatch, matchTicket],
  'result-pending-live': [signin, matchDetail, matchDetail, matchDetail, matchDetail],
  'result-pending-queued': [signin, matchDetail, matchDetail, matchDetail],
  'result-aborted-forfeit': [signin, matchDetail],
  'result-aborted-nocontest': [signin, matchDetail],
  'result-invalidated': [signin, matchDetail],
  'result-draw': [signin, matchDetail],
  'result-tdm-completed': [signin, matchDetail],
  'history-mixed': [signin, history],
  'history-empty': [signin, statsAll, history],
  'privacy-filtered': [signin, publicProfile],
  'sanctioned': [signin, profileMe, join()],
  'name-taken': [nameCheck('StubRunner'), signupUnbacked, signin, rename],
  'session-revoked': [signin, profileMe, profileMe, profileMe],
  // Four authenticated calls at 10 virtual seconds each: the fourth is past the 30 s TTL, and
  // the refresh after it is what a single-flight refresh queue would issue.
  'token-expiry': [signin, profileMe, profileMe, profileMe, refresh, profileMe],
  'slow': [health, signin, listRooms],
  'offline': [health],

  // REQ-CC-045 additions.
  'signin-invalid-credentials': [signin],
  'signin-incomplete-setup': [signin, profileMe, join()],
  'recovery-token-invalid': [recoveryStart, recoveryComplete],
  'recovery-token-expired': [recoveryStart, recoveryComplete],
  'name-policy-violation': [nameCheck('Overstrike Staff'), signupUnbacked, signin, rename],
  'settings-conflict': [signin, getSettings, putSettings(ROAM_WRITE), putSettings(ROAM_WRITE)],
  'match-not-found': [signin, matchDetail],
  'career-unavailable': [signin, statsAll, history],
  'sessions-current-only': [signin, sessions],
  'system-maintenance': [health, signin],
  'unsupported-client': [health, signin],
  'active-lobby-resync': [signin, activeMatch, selfProfile, roomDetail, lobbyTicket],

  // REQ-CC-046 additions.
  'name-check-rate-limited': [nameCheck('Nova Prime')],
  'name-check-unavailable': [nameCheck('Nova Prime')],
};

/**
 * §11.11 verbatim: route label → owning scenarios. Labels are normalised (backticks stripped)
 * so the test can diff them against the markdown without a second transformation living here.
 */
export const COVERAGE_MAP = {
  '/welcome': ['default', 'offline', 'slow'],
  '/auth/sign-in': ['default', 'session-revoked', 'token-expiry', 'account-pre-policy'],
  '/auth/create-account': ['onboarding-happy', 'name-taken', 'onboarding-receipt-invalid'],
  '/onboarding/eligibility': ['onboarding-happy', 'onboarding-eligibility-denied'],
  '/onboarding/consent': ['onboarding-happy', 'onboarding-consent-declined'],
  '/onboarding/verify': ['onboarding-verify-invalid', 'onboarding-verify-expired'],
  '/onboarding/terms': ['onboarding-happy', 'onboarding-terms-conflict'],
  '/play/rooms': ['default', 'browser-empty', 'browser-unreachable', 'slow'],
  '/room/:roomId': ['room-full', 'room-in-progress', 'room-password', 'sanctioned'],
  'Match reconnect': ['match-active-none', 'match-active-reconnect', 'match-active-grace-expired'],
  '/career/overview': ['default', 'history-empty', 'privacy-filtered'],
  '/career/modes, history': ['history-mixed', 'result-pending-live', 'result-pending-queued'],
  'Results screen': ['result-aborted-forfeit', 'result-aborted-nocontest', 'result-invalidated', 'result-draw'],
};

/** Which §11.11 label covers which shell-ia route, so the two vocabularies can be diffed. */
export const COVERAGE_MAP_ROUTES = {
  '/welcome': ['/welcome'],
  '/auth/sign-in': ['/auth/sign-in'],
  '/auth/create-account': ['/auth/create-account'],
  '/onboarding/eligibility': ['/onboarding/eligibility'],
  '/onboarding/consent': ['/onboarding/consent'],
  '/onboarding/verify': ['/onboarding/verify'],
  '/onboarding/terms': ['/onboarding/terms'],
  '/play/rooms': ['/play/rooms'],
  '/room/:roomId': ['/room/:roomId'],
  'Match reconnect': ['/match/reconnect'],
  '/career/overview': ['/career/overview'],
  '/career/modes, history': ['/career/modes', '/career/matches'],
  'Results screen': ['/results/:matchId'],
};

// ── the route × variant map ─────────────────────────────────────────────────────────────────

/**
 * A variant served by a scenario, driven by these requests.
 *
 * `expect` is what the last response must be, and it is declared rather than inferred: most
 * error and policy states are refusals, but several are not, and the ones that are not are the
 * interesting ones. A declined consent is a 201 (`shell-ia.md`: "Declined is valid, not
 * terminal"), a privacy-filtered profile is a 200 carrying nulls rather than a 403 (§11.8: a 403
 * would disclose that the setting exists), and "room gone" is genuinely a 404. Writing the
 * expectation down is what stops the test from either rubber-stamping anything or demanding a
 * refusal the contract forbids.
 */
const served = (scenario, requests, expect = null) => ({ scenario, requests, expect });
/** A variant a lobby timeline serves rather than an HTTP scenario. */
const socket = (timeline) => ({ scenario: `lobby:${timeline}`, requests: [] });
/**
 * A variant that cannot truthfully occur for this screen (`shell-ia.md`: "`Not applicable`
 * means the state cannot truthfully occur"). The reason is required, so "no fixture yet" cannot
 * hide inside "not applicable".
 */
const na = (why) => ({ scenario: null, why });

const VARIANTS = ['loading', 'empty', 'error', 'offline', 'policy'];

const NO_FORM_STATE = 'A form with no request outstanding is the initial state, not a server response';

export const ROUTE_COVERAGE = {
  '/welcome': {
    loading: served('slow', [health]),
    empty: na('The landing screen is static content; there is no collection to be empty'),
    error: served('system-maintenance', [health]),
    offline: served('offline', [health]),
    policy: served('unsupported-client', [health, signin]),
  },
  '/auth/sign-in': {
    loading: served('slow', [signin]),
    empty: na(NO_FORM_STATE),
    error: served('signin-invalid-credentials', [signin]),
    offline: served('offline', [signin]),
    policy: served('signin-incomplete-setup', [signin, profileMe, join()]),
  },
  '/auth/create-account': {
    loading: served('slow', [signin]),
    empty: na(NO_FORM_STATE),
    error: served('onboarding-receipt-invalid', [eligibility, consentAccept, signup]),
    offline: served('offline', [health]),
    policy: served('onboarding-eligibility-denied', [eligibility, signupUnbacked]),
  },
  '/auth/recover': {
    loading: served('slow', [recoveryStart]),
    empty: na(NO_FORM_STATE),
    error: served('recovery-token-invalid', [recoveryStart, recoveryComplete]),
    offline: served('offline', [recoveryStart]),
    policy: served('recovery-token-expired', [recoveryStart, recoveryComplete]),
  },
  '/onboarding/eligibility': {
    loading: served('slow', [eligibility]),
    empty: na(NO_FORM_STATE),
    error: served('default', [{ method: 'POST', path: '/v1/onboarding/eligibility', body: {} }]),
    offline: served('offline', [eligibility]),
    policy: served('onboarding-eligibility-denied', [eligibility]),
  },
  '/onboarding/consent': {
    loading: served('slow', [eligibility, consentAccept]),
    // 204: a decision that has not been made is undecided, and inventing a decline would be
    // recording an answer nobody gave.
    empty: served('onboarding-happy', [{ method: 'GET', path: '/v1/onboarding/consent', query: { clientSessionId: CLIENT_SESSION } }]),
    error: served('onboarding-happy', [{ method: 'PUT', path: '/v1/onboarding/consent', body: { clientSessionId: CLIENT_SESSION } }]),
    offline: served('offline', [consentAccept]),
    policy: served('onboarding-consent-declined', [eligibility, consentDecline, signup], 'ok'),
  },
  '/onboarding/display-name': {
    // `checking` is not a sixth variant: it is this screen's loading state, and it is the
    // §3b preflight in flight rather than the page (design/first-run-flow.md §3).
    loading: served('slow', [nameCheck('Nova Prime')]),
    empty: na(NO_FORM_STATE),
    error: served('name-check-unavailable', [nameCheck('Nova Prime')]),
    offline: served('offline', [nameCheck('Nova Prime')]),
    // A policy refusal is a 200 carrying the rule, not an HTTP error: the check reports, the
    // mutation refuses. `name-policy-violation` serves both in one scenario.
    policy: served('name-policy-violation', [nameCheck('Overstrike Staff')], 'ok'),
  },
  '/onboarding/verify': {
    loading: served('slow', [signin]),
    empty: na('Awaiting a token is the initial state, not a server response'),
    error: served('onboarding-verify-invalid', [eligibility, consentAccept, signup, verifyComplete]),
    offline: served('offline', [verifyResend]),
    policy: served('onboarding-verify-expired', [eligibility, consentAccept, signup, verifyComplete]),
  },
  '/onboarding/terms': {
    loading: served('slow', [getTerms]),
    empty: na('There is always a current terms version; an absent one is an outage, not empty'),
    error: served('onboarding-terms-conflict', [eligibility, consentAccept, signup, getTerms, acceptTerms(1)]),
    offline: served('offline', [getTerms]),
    policy: served('signin-incomplete-setup', [signin, profileMe, join()]),
  },
  '/onboarding/essential-settings': {
    loading: served('slow', [signin, getSettings]),
    empty: served('default', [signin, getSettings]),
    error: served('default', [signin, putSettings(DEVICE_WRITE)]),
    offline: served('offline', [getSettings]),
    policy: na('Essential setup has no terminal state: every control has a later home in settings'),
  },
  '/play/rooms': {
    loading: served('slow', [signin, listRooms]),
    empty: served('browser-empty', [signin, listRooms]),
    error: served('browser-unreachable', [signin, listRooms]),
    offline: served('offline', [listRooms]),
    policy: served('system-maintenance', [signin]),
  },
  '/play/rooms/:roomId': {
    loading: served('slow', [signin, roomDetail]),
    empty: served('default', [signin, unknownRoom], 'refusal'),
    error: served('browser-unreachable', [signin, roomDetail]),
    offline: served('offline', [roomDetail]),
    policy: served('room-full', [signin, roomDetail, join()]),
  },
  '/room/:roomId': {
    loading: socket('disconnect-resync'),
    empty: served('default', [signin, join(), setTeam('bravo'), setReady(true), roomDetail]),
    error: served('room-password', [signin, join()]),
    offline: served('offline', [roomDetail]),
    policy: served('sanctioned', [signin, join()]),
  },
  '/room/:roomId/roster': {
    loading: socket('player-joins-mid'),
    empty: served('default', [signin, roomDetail]),
    error: socket('team-full'),
    offline: served('offline', [setTeam('bravo')]),
    policy: socket('kicked'),
  },
  '/room/:roomId/loadout': {
    loading: served('slow', [signin, roomDetail]),
    empty: na('A loadout always has a current selection; there is no empty loadout'),
    error: served('default', [signin, { method: 'POST', path: `/v1/rooms/${ROOM}/loadout`, body: { primaryIdx: 99, secondaryIdx: 0 } }]),
    offline: served('offline', [setLoadout]),
    policy: served('room-in-progress', [signin, roomDetail, join()]),
  },
  '/room/:roomId/chat': {
    loading: socket('disconnect-resync'),
    empty: na('An empty chat history is a normal welcome payload, not a distinct screen state'),
    error: socket('chat-flood'),
    offline: served('offline', [roomDetail]),
    policy: socket('sanctioned'),
  },
  '/career/overview': {
    loading: served('slow', [signin, statsAll]),
    empty: served('history-empty', [signin, statsAll, history]),
    error: served('career-unavailable', [signin, statsAll]),
    offline: served('offline', [statsAll]),
    policy: served('privacy-filtered', [signin, publicProfile], 'ok'),
  },
  '/career/modes': {
    loading: served('slow', [signin, statsBomb]),
    empty: served('history-empty', [signin, statsBomb]),
    error: served('career-unavailable', [signin, statsBomb]),
    offline: served('offline', [statsBomb]),
    policy: served('privacy-filtered', [signin, publicProfile], 'ok'),
  },
  '/career/weapons': {
    loading: served('slow', [signin, statsBomb]),
    // `weapons: {}` with real totals is the honest empty state: no weapon has been fired, which
    // is different from the stats being unavailable.
    empty: served('history-empty', [signin, statsBomb]),
    error: served('career-unavailable', [signin, statsBomb]),
    offline: served('offline', [statsBomb]),
    policy: served('privacy-filtered', [signin, publicProfile], 'ok'),
  },
  '/career/matches': {
    loading: served('slow', [signin, history]),
    empty: served('history-empty', [signin, history]),
    error: served('career-unavailable', [signin, history]),
    offline: served('offline', [history]),
    policy: served('history-mixed', [signin, history], 'ok'),
  },
  '/career/matches/:matchId': {
    loading: served('result-pending-live', [signin, matchDetail]),
    empty: na('A match detail is one record: it is found or it is not'),
    error: served('match-not-found', [signin, matchDetail]),
    offline: served('offline', [matchDetail]),
    policy: served('result-invalidated', [signin, matchDetail], 'ok'),
  },
  '/settings/:category': {
    loading: served('slow', [signin, getSettings]),
    empty: served('default', [signin, getSettings]),
    error: served('default', [signin, putSettingsNoIfMatch]),
    offline: served('offline', [getSettings]),
    policy: served('settings-conflict', [signin, getSettings, putSettings(ROAM_WRITE), putSettings(ROAM_WRITE)], 'ok'),
  },
  '/sessions': {
    loading: served('slow', [signin, sessions]),
    empty: served('sessions-current-only', [signin, sessions]),
    error: served('default', [signin, revokeUnknownSession]),
    offline: served('offline', [sessions]),
    // `signout-all` revokes the caller's own session too (§3), so the very next authenticated
    // read is AUTH_SESSION_REVOKED. That is the terminal state of this screen.
    policy: served('default', [signin, signoutAll, sessions]),
  },
  '/match/loading': {
    loading: socket('happy-path'),
    empty: na('A handoff is a sequence of named stages; there is nothing to be empty'),
    error: socket('allocation-failed'),
    offline: served('offline', [matchTicket]),
    policy: socket('handoff-version-mismatch'),
  },
  '/match/reconnect': {
    loading: served('match-active-reconnect', [signin, activeMatch]),
    empty: served('match-active-none', [signin, activeMatch]),
    error: socket('reconnect-grace-exhausted'),
    offline: served('offline', [activeMatch]),
    policy: served('match-active-grace-expired', [signin, activeMatch, matchTicket]),
  },
  '/results/:matchId': {
    loading: served('result-pending-queued', [signin, matchDetail]),
    empty: na('A result screen is reached with a match id; there is no empty result'),
    error: served('career-unavailable', [signin, history]),
    offline: served('offline', [matchDetail]),
    policy: served('result-aborted-nocontest', [signin, matchDetail], 'ok'),
  },
  '/system/:condition': {
    loading: served('slow', [health]),
    empty: na('A system condition screen is only ever reached with a condition'),
    error: served('system-maintenance', [signin]),
    offline: served('offline', [health]),
    policy: served('unsupported-client', [signin]),
  },
};

export { VARIANTS, ROAM_WRITE, DEVICE_WRITE, CLIENT_SESSION };
