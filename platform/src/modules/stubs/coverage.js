/**
 * The coverage map, executable.  contracts/http-api.md §11.11.
 *
 * §11.11 states which scenario owns which route's states so that coverage is *auditable rather
 * than inferred from names*. A table in a document cannot be audited by itself, so it is
 * mirrored here as data plus the request sequence that actually drives each scenario —
 * `stubtest.mjs` parses the contract, diffs it against `COVERAGE_MAP`, then runs every
 * sequence. A row nobody can run is a gap the test reports, not a claim the table makes.
 *
 * `SCENARIO_PROBES` is the canonical way to *exercise* a scenario: it is the request sequence
 * the owning screen would make, in order, including the repeats a stateful scenario needs.
 */
import * as fx from './fixtures.js';

const ROOM = fx.ROOM_IDS[0];
const MATCH = fx.MATCH_ID;
const ACCOUNT = fx.ACCOUNT_ID;

const signupBody = {
  email: 'stub@example.invalid',
  password: 'correct horse battery staple',
  displayName: 'StubRunner',
  eligibilityReceipt: 'stub.eligibility.seed',
  clientSessionId: '01JSTUBSESSION0000000000000',
  consentReceipt: 'stub.consent-session.seed',
};

const eligibility = { method: 'POST', path: '/v1/onboarding/eligibility', body: { dateOfBirth: '1994-03-02', jurisdiction: 'CA-ON' } };
const consentAccept = { method: 'PUT', path: '/v1/onboarding/consent', body: { telemetryPersonal: true, policyVersion: 1, clientSessionId: signupBody.clientSessionId } };
const consentDecline = { method: 'PUT', path: '/v1/onboarding/consent', body: { telemetryPersonal: false, policyVersion: 1, clientSessionId: signupBody.clientSessionId } };
const signup = { method: 'POST', path: '/v1/auth/signup', body: signupBody };
const signin = { method: 'POST', path: '/v1/auth/signin', body: { email: signupBody.email, password: signupBody.password } };
const verifyComplete = { method: 'POST', path: '/v1/onboarding/verify/complete', body: { token: 'stub-verify-token' } };
const verifyResend = { method: 'POST', path: '/v1/onboarding/verify/resend', body: {} };
const getTerms = { method: 'GET', path: '/v1/onboarding/terms' };
const acceptTerms = (version) => ({ method: 'POST', path: '/v1/onboarding/terms/accept', body: { version } });
const listRooms = { method: 'GET', path: '/v1/rooms' };
const roomDetail = { method: 'GET', path: `/v1/rooms/${ROOM}` };
const join = (password = null) => ({ method: 'POST', path: `/v1/rooms/${ROOM}/join`, body: { password, preferredTeam: 'auto' } });
const activeMatch = { method: 'GET', path: '/v1/matches/active' };
const matchTicket = { method: 'POST', path: `/v1/matches/${MATCH}/reconnect-ticket`, body: {} };
const matchDetail = { method: 'GET', path: `/v1/matches/${MATCH}` };
const history = { method: 'GET', path: `/v1/profile/${ACCOUNT}/matches` };
const statsAll = { method: 'GET', path: `/v1/profile/${ACCOUNT}/stats`, query: { mode: 'all' } };
const publicProfile = { method: 'GET', path: `/v1/profile/${fx.OTHER_ACCOUNT_ID}` };
const profileMe = { method: 'GET', path: '/v1/profile/me' };
const health = { method: 'GET', path: '/v1/health' };
const regions = { method: 'GET', path: '/v1/config/regions' };
const refresh = { method: 'POST', path: '/v1/auth/refresh', body: {} };

/** The request sequence that drives each scenario to the state it exists to demonstrate. */
export const SCENARIO_PROBES = {
  'default': [health, regions, signin, listRooms, roomDetail, statsAll, history],
  'onboarding-happy': [eligibility, consentAccept, signup, join(), verifyComplete, getTerms, acceptTerms(1), join()],
  'onboarding-eligibility-denied': [eligibility],
  'onboarding-consent-declined': [eligibility, consentDecline, signup],
  'onboarding-verify-invalid': [verifyComplete, verifyResend, verifyComplete],
  'onboarding-verify-expired': [verifyComplete, verifyResend, verifyComplete],
  'onboarding-terms-conflict': [getTerms, acceptTerms(1), getTerms, acceptTerms(2)],
  'onboarding-receipt-invalid': [eligibility, consentAccept, signup],
  'account-pre-policy': [signin, profileMe],
  'browser-empty': [listRooms],
  'browser-unreachable': [listRooms, signin],
  'room-full': [roomDetail, join()],
  'room-in-progress': [roomDetail, join()],
  'room-password': [join(), join('any-password')],
  'match-active-none': [activeMatch],
  'match-active-reconnect': [activeMatch, matchTicket],
  'match-active-grace-expired': [activeMatch, matchTicket],
  'result-pending-live': [matchDetail, matchDetail, matchDetail, matchDetail],
  'result-pending-queued': [matchDetail, matchDetail, matchDetail],
  'result-aborted-forfeit': [matchDetail],
  'result-aborted-nocontest': [matchDetail],
  'result-invalidated': [matchDetail],
  'result-draw': [matchDetail],
  'history-mixed': [history],
  'history-empty': [statsAll, history],
  'privacy-filtered': [publicProfile],
  'sanctioned': [profileMe, join()],
  'name-taken': [signup, { method: 'PATCH', path: '/v1/profile/me', body: { displayName: 'Taken' } }],
  'session-revoked': [profileMe, profileMe, profileMe],
  // Four authenticated calls at 10 virtual seconds each: the fourth is past the 30 s TTL, and
  // the refresh after it is what a single-flight refresh queue would issue.
  'token-expiry': [signin, profileMe, profileMe, profileMe, refresh, profileMe],
  'slow': [health, listRooms],
  'offline': [health],
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
