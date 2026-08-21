import assert from 'node:assert/strict';
import {
  PlatformClientError,
  SessionState,
  createFeatureFlagState,
  createPlatformClient,
  createShellApi,
  createTelemetryClient,
  sanitizeTelemetryPayload,
} from './index.js';

const ids = Array.from({ length: 2000 }, (_, i) =>
  `${String(i).padStart(10, '0')}${'0'.repeat(16)}`);
let idIndex = 0;
const ulid = () => ids[idIndex++];

const errorResponse = (code, options = {}) => new Response(JSON.stringify({
  error: {
    code,
    message: 'safe',
    correlationId: options.correlationId || '00000000000000000000000000',
    retryable: options.retryable ?? false,
    retryAfterMs: options.retryAfterMs ?? null,
    details: {},
  },
}), { status: options.status || 401, headers: {
  'Content-Type': 'application/json',
  'X-Correlation-Id': options.correlationId || '00000000000000000000000000',
} });

const success = (data, status = 200, correlationId = data?.correlationId) =>
  new Response(data === null ? null : JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': correlationId },
});

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

async function testHeadersAndMemoryToken() {
  const seen = [];
  const storage = new MemoryStorage();
  const client = createPlatformClient({
    clientBuild: '1.2.3', ulid,
    fetch: async (url, init) => {
      seen.push({ url, init });
      const correlationId = init.headers.get('X-Correlation-Id');
      return success({ correlationId }, 200, correlationId);
    },
  });
  client.setSession('secret-access-token', { sessionId: 'session-a' });
  await client.request('/v1/profile/me');
  assert.equal(seen[0].init.headers.get('Authorization'), 'Bearer secret-access-token');
  assert.equal(seen[0].init.headers.get('X-Client-Build'), '1.2.3');
  assert.match(seen[0].init.headers.get('X-Correlation-Id'), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(seen[0].init.credentials, 'include');
  assert.equal([...storage.values.values()].some((value) => value.includes('secret-access-token')), false);
  client.close();
}

async function testSingleFlightRefresh() {
  let refreshes = 0;
  let oldRequests = 0;
  let newRequests = 0;
  const client = createPlatformClient({
    clientBuild: '1', ulid,
    fetch: async (url, init) => {
      if (url.endsWith('/v1/auth/refresh')) {
        refreshes += 1;
        assert.equal(init.body, undefined);
        assert.equal(init.headers.has('Authorization'), false);
        await Promise.resolve();
        const correlationId = init.headers.get('X-Correlation-Id');
        return success({
          accessToken: 'new-token', expiresAt: new Date().toISOString(),
          session: { sessionId: 'session-a', deviceLabel: 'test', createdAt: new Date().toISOString() },
          correlationId,
        }, 200, correlationId);
      }
      if (init.headers.get('Authorization') === 'Bearer old-token') {
        oldRequests += 1;
        const correlationId = init.headers.get('X-Correlation-Id');
        return errorResponse('AUTH_TOKEN_EXPIRED', { correlationId });
      }
      assert.equal(init.headers.get('Authorization'), 'Bearer new-token');
      newRequests += 1;
      const correlationId = init.headers.get('X-Correlation-Id');
      return success({ ok: true, correlationId }, 200, correlationId);
    },
  });
  client.setSession('old-token', { sessionId: 'session-a' });
  const responses = await Promise.all(Array.from({ length: 10 }, () => client.request('/v1/profile/me')));
  assert.equal(refreshes, 1);
  assert.equal(oldRequests, 10);
  assert.equal(newRequests, 10);
  assert.equal(responses.every((response) => response.data.ok), true);
  client.close();
}

async function testRefreshRacesDoNotClearNewerSessions() {
  let releaseProtected;
  let protectedStarted;
  const protectedReady = new Promise((resolve) => { protectedStarted = resolve; });
  const protectedResponse = new Promise((resolve) => { releaseProtected = resolve; });
  const client = createPlatformClient({
    clientBuild: '1', ulid,
    fetch: async (url, init) => {
      const correlationId = init.headers.get('X-Correlation-Id');
      if (url.endsWith('/v1/auth/refresh')) {
        return success({
          accessToken: 'restored-token',
          session: { sessionId: 'restored-session' },
          correlationId,
        }, 200, correlationId);
      }
      protectedStarted();
      await protectedResponse;
      return errorResponse('AUTH_REQUIRED', { correlationId });
    },
  });
  const staleRequest = client.request('/v1/profile/me');
  await protectedReady;
  await client.refresh();
  releaseProtected();
  await assert.rejects(() => staleRequest, (error) => error.code === 'AUTH_REQUIRED');
  assert.equal(client.sessionState.authenticated, true,
    'a stale tokenless 401 must not clear a session restored concurrently');
  assert.equal(client.sessionState.sessionId, 'restored-session');
  client.close();

  const networkClient = createPlatformClient({
    clientBuild: '1', ulid,
    fetch: async () => { throw new TypeError('offline'); },
  });
  networkClient.setSession('still-valid', { sessionId: 'healthy-session' });
  await assert.rejects(() => networkClient.refresh(), (error) => error.code === 'CLIENT_NETWORK');
  assert.equal(networkClient.sessionState.authenticated, true,
    'refresh transport failure must preserve the last known session');
  networkClient.close();

  const signOutClient = createPlatformClient({
    clientBuild: '1', ulid,
    fetch: async () => { throw new TypeError('offline'); },
  });
  signOutClient.setSession('still-valid', { sessionId: 'signout-session' });
  await assert.rejects(() => signOutClient.signOut(), (error) => error.code === 'CLIENT_NETWORK');
  assert.equal(signOutClient.sessionState.authenticated, true,
    'failed server sign-out must remain retryable instead of clearing only the browser');
  signOutClient.close();
}

async function testCrossTabRefreshSerialization() {
  let tail = Promise.resolve();
  const locks = {
    request(_name, _options, callback) {
      const result = tail.then(callback);
      tail = result.catch(() => {});
      return result;
    },
  };
  let active = 0;
  let peak = 0;
  let calls = 0;
  const fetch = async (_url, init) => {
    active += 1;
    peak = Math.max(peak, active);
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    active -= 1;
    const correlationId = init.headers.get('X-Correlation-Id');
    return success({ accessToken: `tab-token-${calls}`, session: { sessionId: `tab-${calls}` },
      correlationId }, 200, correlationId);
  };
  const first = createPlatformClient({ clientBuild: '1', ulid, fetch, locks });
  const second = createPlatformClient({ clientBuild: '1', ulid, fetch, locks });
  await Promise.all([first.refresh(), second.refresh()]);
  assert.equal(calls, 2, 'each tab receives its own memory-only access token');
  assert.equal(peak, 1, 'shared cookie rotation is serialized across tabs');
  first.close();
  second.close();
}

async function testRetryPolicy() {
  const sleeps = [];
  let calls = 0;
  const client = createPlatformClient({
    clientBuild: '1', ulid, sleep: async (ms) => sleeps.push(ms),
    fetch: async (_url, init) => {
      calls += 1;
      const correlationId = init.headers.get('X-Correlation-Id');
      if (calls % 3 !== 0) {
        return errorResponse('SERVICE_UNAVAILABLE', {
          status: 503, retryable: true, retryAfterMs: 321, correlationId,
        });
      }
      return success({ correlationId }, 200, correlationId);
    },
  });
  await client.request('/v1/config');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [321, 321]);

  calls = 0;
  await assert.rejects(() => client.request('/v1/rooms', { method: 'POST', body: {} }));
  assert.equal(calls, 1, 'non-idempotent requests are not retried without a key');

  calls = 0;
  await client.request('/v1/rooms', { method: 'POST', body: {}, idempotencyKey: 'room-key' });
  assert.equal(calls, 3, 'idempotency-keyed requests may retry up to the cap');

  calls = 0;
  await client.request('/v1/rooms/room-a/leave', { method: 'POST', body: {}, idempotent: true });
  assert.equal(calls, 3, 'contractually idempotent POSTs may retry up to the cap');
  client.close();
}

async function testTimeout() {
  const client = createPlatformClient({
    clientBuild: '1', ulid, timeoutMs: 1,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }),
  });
  await assert.rejects(() => client.request('/v1/config', { maxAttempts: 1 }),
    (error) => error instanceof PlatformClientError && error.code === 'CLIENT_TIMEOUT');
  client.close();
}

async function testClosedProtocolAndCrossTabRevocation() {
  const badCorrelationClient = createPlatformClient({
    clientBuild: '1', ulid,
    fetch: async () => success({ correlationId: '00000000000000000000000000' }),
  });
  await assert.rejects(() => badCorrelationClient.request('/v1/config'),
    (error) => error.code === 'CLIENT_PROTOCOL');
  badCorrelationClient.close();

  const extraEnvelopeClient = createPlatformClient({
    clientBuild: '1', ulid,
    fetch: async (_url, init) => {
      const correlationId = init.headers.get('X-Correlation-Id');
      return new Response(JSON.stringify({
        error: { code: 'NOT_FOUND', message: 'safe', correlationId, retryable: false,
          retryAfterMs: null, details: {}, extra: true },
      }), { status: 404, headers: {
        'Content-Type': 'application/json', 'X-Correlation-Id': correlationId,
      } });
    },
  });
  await assert.rejects(() => extraEnvelopeClient.request('/v1/missing'),
    (error) => error.code === 'CLIENT_PROTOCOL');
  extraEnvelopeClient.close();

  const valid204 = createPlatformClient({
    clientBuild: '1', ulid,
    fetch: async (_url, init) => new Response(null, { status: 204,
      headers: { 'X-Correlation-Id': init.headers.get('X-Correlation-Id') } }),
  });
  assert.equal((await valid204.request('/v1/auth/signout', { method: 'POST', body: {} })).status, 204);
  valid204.close();
  const invalid204 = createPlatformClient({
    clientBuild: '1', ulid, fetch: async () => new Response(null, { status: 204 }),
  });
  await assert.rejects(() => invalid204.request('/v1/auth/signout', { method: 'POST', body: {} }),
    (error) => error.code === 'CLIENT_PROTOCOL');
  invalid204.close();

  class Channel {
    static instances = [];
    constructor() { this.listeners = new Set(); Channel.instances.push(this); }
    addEventListener(_type, listener) { this.listeners.add(listener); }
    removeEventListener(_type, listener) { this.listeners.delete(listener); }
    postMessage(message) {
      for (const channel of Channel.instances) {
        if (channel === this) continue;
        for (const listener of channel.listeners) listener({ data: message });
      }
    }
    close() { Channel.instances = Channel.instances.filter((item) => item !== this); }
  }
  const first = new SessionState({ window: null, BroadcastChannel: Channel });
  const second = new SessionState({ window: null, BroadcastChannel: Channel });
  first.set('token-a', { sessionId: 'session-a' });
  second.set('token-b', { sessionId: 'session-b' });
  first.clear('signed-out-all', true, true);
  assert.equal(second.snapshot().authenticated, false, 'signout-all revokes different sessions cross-tab');
  assert.equal(JSON.stringify(Channel.instances).includes('token-a'), false);
  first.close();
  second.close();
}

async function testTelemetryPrivacyAndBatches() {
  const storage = new MemoryStorage();
  const calls = [];
  const client = {
    baseUrl: 'https://platform.invalid', clientBuild: '1',
    request: async (path, options) => {
      calls.push({ path, options });
      return {
        status: 202,
        data: { accepted: options.body.events.length, rejected: 0, consentReceiptError: null,
          correlationId: '00000000000000000000000000' },
      };
    },
  };
  let now = Date.now();
  const telemetry = createTelemetryClient({ client, storage, ulid, now: () => now,
    navigator: null, document: null, window: null });

  assert.equal(telemetry.record('flow.step', {
    step: 'signup', outcome: 'completed', errorCode: null,
  }), false, 'personal records are dropped before consent');
  assert.equal(telemetry.record('client.error', {
    errorClass: 'other', fatal: false, message: 'raw player-authored text', displayName: 'PII',
  }), true);
  telemetry.setConsent({ telemetryPersonal: true, receipt: 'signed-consent' });
  assert.equal(telemetry.record('flow.step', {
    step: 'signup', outcome: 'completed', errorCode: null, rawMessage: 'must be dropped',
  }), true);
  const supplied = '00000000990000000000000000';
  assert.equal(telemetry.record('funnel.preconsent', { step: 'landing', outcome: 'viewed' },
    { correlationId: supplied }), true);

  const stored = [...storage.values.values()].join('\n');
  assert.equal(stored.includes('raw player-authored text'), false);
  assert.equal(stored.includes('PII'), false);
  assert.equal(stored.includes('rawMessage'), false);
  assert.equal(stored.includes('secret-access-token'), false);
  assert.equal(stored.includes(supplied), false, 'pre-consent ignores caller correlation overrides');

  await telemetry.flush();
  assert.equal(calls.length, 2, 'internal and personal records use separate requests');
  const internal = calls.find((call) => call.options.auth === false).options.body;
  const personal = calls.find((call) => call.options.auth === true).options.body;
  assert.equal(Object.hasOwn(internal, 'clientSessionId'), false);
  assert.equal(Object.hasOwn(internal, 'consentReceipt'), false);
  assert.equal(internal.events.some((event) => Object.hasOwn(event.payload, 'message')), false);
  assert.equal(personal.clientSessionId, telemetry.getClientSessionId());
  assert.equal(personal.consentReceipt, 'signed-consent');
  assert.equal(personal.events.length, 1);
  telemetry.stop();

  // A failure is retried only after 30 seconds and dropped after that one retry.
  let attempts = 0;
  const failingClient = {
    ...client,
    request: async () => { attempts += 1; throw new Error('offline'); },
  };
  const retryTelemetry = createTelemetryClient({ client: failingClient, storage: new MemoryStorage(),
    ulid, now: () => now, navigator: null, document: null, window: null });
  retryTelemetry.record('client.fps', { p50: 60, p01: 30, windowSec: 10 });
  await retryTelemetry.flush();
  await retryTelemetry.flush();
  assert.equal(attempts, 1, 'retry waits for the contracted delay');
  now += 30_000;
  await retryTelemetry.flush();
  await retryTelemetry.flush();
  assert.equal(attempts, 2, 'only one retry is attempted');
  retryTelemetry.stop();
}

async function testFrozenUnloadIngress() {
  const storage = new MemoryStorage();
  const beaconCalls = [];
  let normalCalls = 0;
  const client = {
    baseUrl: '', clientBuild: '1',
    request: async (_path, options) => {
      normalCalls += 1;
      return { status: 202, data: { accepted: options.body.events.length, rejected: 0,
        consentReceiptError: null, correlationId: '00000000000000000000000000' } };
    },
  };
  const navigator = { sendBeacon: (url, body) => { beaconCalls.push({ url, body }); return true; } };
  const telemetry = createTelemetryClient({ client, storage, navigator, document: null, window: null,
    ulid });
  telemetry.record('client.fps', { p50: 60, p01: 20, windowSec: 10 });
  assert.equal(telemetry.flushBeacon(), true);
  assert.equal(beaconCalls[0].url, '/v1/telemetry/unload');
  const body = JSON.parse(await beaconCalls[0].body.text());
  assert.equal(body.clientBuild, '1');
  assert.match(body.correlationId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(body.deliveryId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.notEqual(body.correlationId, body.deliveryId);
  assert.equal(body.events.length, 1);
  assert.equal(normalCalls, 0, 'beacon delivery does not masquerade as a normal request');

  const personalCalls = [];
  const signedInClient = {
    baseUrl: '', clientBuild: '1', session: { accessToken: 'memory-only-token' },
    request: async (path, options) => {
      personalCalls.push({ path, options });
      return { status: 204, data: null };
    },
  };
  const signedIn = createTelemetryClient({ client: signedInClient,
    storage: new MemoryStorage(), navigator, document: null, window: null, ulid });
  signedIn.setConsent({ telemetryPersonal: true, receipt: 'signed-receipt' });
  signedIn.record('flow.step', { step: 'signin', outcome: 'viewed', errorCode: null });
  assert.equal(signedIn.flushBeacon(), false,
    'signed-in personal delivery waits for the subject-bound httpOnly credential');
  assert.equal(await signedIn.refreshUnloadCredential(), true);
  assert.equal(personalCalls[0].path, '/v1/telemetry/unload/credential');
  assert.equal(personalCalls[0].options.auth, true);
  assert.equal(signedIn.flushBeacon(), true);
  const personalBody = JSON.parse(await beaconCalls.at(-1).body.text());
  assert.equal(personalBody.clientSessionId, signedIn.getClientSessionId());
  assert.equal(personalBody.consentReceipt, 'signed-receipt');

  const signedOut = createTelemetryClient({ client, storage: new MemoryStorage(), navigator,
    document: null, window: null, ulid });
  signedOut.setConsent({ telemetryPersonal: true, receipt: 'session-bound-receipt' });
  signedOut.record('flow.step', { step: 'signup', outcome: 'viewed', errorCode: null });
  assert.equal(signedOut.flushBeacon(), true,
    'signed-out personal delivery remains receipt and client-session bound');
}

function testHighLevelTelemetryHooks() {
  const storage = new MemoryStorage();
  const client = { baseUrl: '', clientBuild: '1', request: async () => { throw new Error('unused'); } };
  const telemetry = createTelemetryClient({ client, storage, navigator: null, document: null,
    window: null, ulid });
  assert.equal(telemetry.routeViewed('welcome'), true);
  assert.equal(telemetry.routeViewed('welcome'), false, 'route views deduplicate per step/outcome');
  assert.equal(telemetry.routeViewed('not-a-route'), false);
  assert.equal(telemetry.operationFailed('signIn', 'raw error message'), false,
    'failure helpers accept only closed error codes');
  telemetry.setConsent({ telemetryPersonal: true, receipt: 'receipt' });
  assert.equal(telemetry.operationStarted('signIn'), true);
  assert.equal(telemetry.operationCompleted('signIn'), true);
  assert.equal(telemetry.operationFailed('signIn', 'AUTH_INVALID_CREDENTIALS'), true);
  assert.equal(telemetry.recordLobbyAbandoned({ lastState: 'countdown', dwellSec: 12 }), true);
  assert.equal(telemetry.recordLobbyAbandoned({ lastState: 'invented', dwellSec: 12 }), false);
  assert.equal(telemetry.recordFirstMatch({ completed: true, mode: 'tdm',
    timeToFirstMatchSec: 30 }), true);
  assert.equal(telemetry.recordHandoffFailure({ stage: 'ticket', code: 'SESSION_TOKEN_INVALID' }), true);
  assert.equal(telemetry.recordHandoffFailure({ stage: 'ticket', code: 'raw text' }), false);
  assert.equal(telemetry.recordReturnOutcome({ outcome: 'completed', returnedToLobby: true }), true);
  assert.equal(telemetry.recordSettingsFriction({ category: 'accessibility',
    duringFirstSession: true }), true);
  assert.equal(telemetry.recordConnectionFailure({ stage: 'platform', code: 'CLIENT_NETWORK' }), true);
  assert.equal(telemetry.recordConnectionFailure({ stage: 'match', code: 'CLIENT_TIMEOUT' }), true);
  assert.equal(telemetry.recordConnectionFailure({ stage: 'match', code: 'CLIENT_PROTOCOL' }), false);
  const persisted = [...storage.values.values()].join('\n');
  assert.equal(persisted.includes('raw error message'), false);
  assert.equal(persisted.includes('raw text'), false);
}

async function testShellContractMappings() {
  const calls = [];
  const telemetryCalls = [];
  const settingsCalls = [];
  const correlationId = '00000000000000000000000000';
  const timestamp = new Date().toISOString();
  const profile = (consent = null, embedded = false) => ({ accountId: 'account-a', displayName: 'Player',
    createdAt: timestamp, privacy: { presenceVisibility: 'everyone', statsVisibility: 'everyone' },
    consent, moderation: { status: 'clear', activeSanctions: [] },
    flags: { nameChangeAvailableAt: null, setupNextStep: null },
    ...(embedded ? {} : { correlationId }) });
  const room = (roomId = 'room-a') => ({ roomId, name: 'Fixture room', region: 'yyz',
    mapId: 'the-square', mapVersion: '1.0.0', mode: 'bomb', rulesetVersion: 'bomb-1.0.0',
    build: '1.0.0', status: 'open', capacity: 8, playerCount: 2, joinable: true,
    joinBlockedReason: null, hasPassword: false, ownerAccountId: 'account-a', estimatedRttMs: null,
    settings: { killLimit: null, roundsToWin: 7, maxRounds: 12, roundLengthSec: 105,
      backfill: false, requiredReady: 2, minPlayers: 2 } });
  const telemetry = {
    getClientSessionId: () => '00000000000000000000000123',
    setConsent: (value) => telemetryCalls.push(['consent', value]),
    record: (name, value) => { telemetryCalls.push([name, value]); return true; },
  };
  const client = {
    sessionState: { authenticated: false },
    session: { announceRevocation: (id) => telemetryCalls.push(['revoked', id]) },
    request: async (path, options = {}) => {
      calls.push({ path, options });
      let responseData = { correlationId };
      if (path === '/v1/onboarding/eligibility') responseData = {
        eligible: true, receipt: 'eligibility-receipt', expiresAt: timestamp,
        policyVersion: 1, correlationId,
      };
      if (path.startsWith('/v1/onboarding/consent')) responseData = {
        telemetryPersonal: options.body?.telemetryPersonal ?? false,
        policyVersion: 1, decidedAt: timestamp,
        ...(options.method === 'PUT' ? {} : { currentPolicyVersion: 1 }),
        subject: 'client-session',
        receipt: 'receipt', correlationId,
      };
      if (path === '/v1/rooms') responseData = { items: [room()], nextCursor: null, correlationId };
      if (path === '/v1/config/regions') responseData = { regions: [
        { id: 'yyz', label: 'Toronto', probeUrl: null, available: false },
        { id: 'ord', label: 'Chicago', probeUrl: 'https://ord.example.invalid/health', available: true },
        { id: 'iad', label: 'Ashburn, Virginia', probeUrl: null, available: false },
      ], correlationId };
      if (path.startsWith('/v1/presence/online')) responseData = { items: [{
        accountId: 'account-online', displayName: 'Online Player', state: 'online',
        joinable: false, roomId: null,
      }], nextCursor: null, correlationId };
      if (path === '/v1/rooms' && options.method === 'POST') responseData = {
        room: room('room-created'), roster: [], countdown: null,
        reservationId: 'reservation-created', expiresAt: timestamp,
        lobbySocketUrl: 'wss://lobby.example/ws', lobbyTicket: 'ticket-created',
        correlationId,
      };
      if (path === '/v1/rooms/room-a/team') responseData = {
        ...room(), roster: [], countdown: null, correlationId,
      };
      if (path === '/v1/auth/sessions') responseData = { sessions: [{ sessionId: 'session-a',
        deviceLabel: 'Browser', userAgentClass: 'browser', ipClass: 'public',
        createdAt: timestamp, lastSeenAt: timestamp, isCurrent: false }], correlationId };
      if (path === '/v1/profile/me/settings') responseData = { schemaVersion: 1, version: 2,
        values: { sensitivity: 1, keybinds: { jump: { primary: 'Space', secondary: null } } },
        updatedAt: timestamp, correlationId };
      const empty = path.includes('/sessions/') || path.endsWith('/leave')
        || path.endsWith('/recovery/complete') || path.endsWith('/verify/complete')
        || path.endsWith('/terms/accept');
      return { data: empty ? null : responseData, status: empty ? 204 : 200,
        correlationId, headers: new Headers({ ETag: '"1"' }) };
    },
    signIn: async (body) => {
      calls.push({ path: '/v1/auth/signin', options: { body } });
      return { data: { accessToken: 'token', expiresAt: timestamp,
        session: { sessionId: 'session-a', deviceLabel: 'Browser', createdAt: timestamp },
        profile: profile(null, true), consentReceipt: null, correlationId } };
    },
    signUp: async (body) => {
      calls.push({ path: '/v1/auth/signup', options: { body } });
      const consent = { telemetryPersonal: true, policyVersion: 1, decidedAt: timestamp };
      return { data: { accessToken: 'token', expiresAt: timestamp,
        session: { sessionId: 'session-a', deviceLabel: 'Browser', createdAt: timestamp },
        profile: profile(consent, true), consentReceipt: 'account-receipt', correlationId } };
    },
    signOut: async ({ all }) => { calls.push({ path: all ? 'signOutAll' : 'signOut' });
      return { data: null, status: 204 }; },
  };
  const settings = { hydrate: (projection) => settingsCalls.push(projection) };
  const api = createShellApi({ client, telemetry, settings, ulid });
  await api.checkEligibility({ birthdate: '1990-01-01', jurisdiction: 'CA-ON' });
  assert.deepEqual(calls.at(-1).options.body,
    { dateOfBirth: '1990-01-01', jurisdiction: 'CA-ON' });
  await api.getConsent();
  assert.equal(calls.at(-1).path,
    '/v1/onboarding/consent?clientSessionId=00000000000000000000000123');
  assert.deepEqual(telemetryCalls.at(-1), ['consent', {
    telemetryPersonal: false,
    receipt: 'receipt',
  }], 'consent reads restore the signed telemetry decision');
  await api.setConsent({ allowed: true, policyVersion: 1 });
  assert.deepEqual(calls.at(-1).options.body, {
    telemetryPersonal: true, policyVersion: 1,
    clientSessionId: '00000000000000000000000123',
  });
  await api.signIn({ identifier: 'person@example.test', password: 'secret' });
  assert.deepEqual(calls.at(-1).options.body, { email: 'person@example.test', password: 'secret' });
  await api.signUp({ email: 'person@example.test', password: 'secret', displayName: 'Player',
    eligibilityReceipt: 'eligible', consentReceipt: 'receipt' });
  assert.equal(calls.at(-1).options.body.clientSessionId, '00000000000000000000000123');
  const rooms = await api.listRooms({ routeId: 'play.rooms' });
  assert.equal(rooms.items[0].id, 'room-a');
  assert.equal(rooms.items[0].occupancy, '2 / 8');
  assert.equal(rooms.online[0].displayName, 'Online Player');
  await api.createRoom({ name: 'New room', region: 'yyz', mapId: 'the-square', mode: 'bomb', capacity: 12 });
  assert.deepEqual(calls.at(-1).options.body, {
    name: 'New room', region: 'yyz', mapId: 'the-square', mode: 'bomb', capacity: 12,
  });
  assert.equal(typeof calls.at(-1).options.idempotencyKey, 'string');
  await api.setTeam({ roomId: 'room-a', team: 'A' });
  assert.deepEqual(calls.at(-1).options.body, { team: 'alpha' });
  await api.leaveRoom({ roomId: 'room-a' });
  assert.equal(calls.at(-1).options.idempotent, true);
  const sessions = await api.listSessions();
  assert.deepEqual(sessions.sessions[0], {
    sessionId: 'session-a', deviceLabel: 'Browser', userAgentClass: 'browser', ipClass: 'public',
    createdAt: timestamp, lastSeenAt: timestamp, isCurrent: false,
    id: 'session-a', device: 'Browser', current: false,
  });
  await api.revokeSession({ sessionId: 'session-a' });
  assert.equal(telemetryCalls.some(([name, id]) => name === 'revoked' && id === 'session-a'), true);
  const remote = await api.getSettings();
  assert.deepEqual(remote.bindings, { jump: { primary: 'Space', secondary: null } });
  assert.equal(remote.etag, '"1"');
  assert.equal(settingsCalls[0].schemaVersion, 1, 'full remote projection reaches settings');
  assert.equal(settingsCalls[0].version, 2, 'remote version reaches settings hydration');
  await api.saveSettings({ schemaVersion: 1, version: 2, values: { sensitivity: 2,
    keybinds: { jump: { primary: 'KeyJ', secondary: null } } } });
  assert.deepEqual(calls.at(-1).options.body, { schemaVersion: 1,
    values: { sensitivity: 2, keybinds: { jump: { primary: 'KeyJ', secondary: null } } } });
  assert.equal(Object.hasOwn(calls.at(-1).options.body, 'bindings'), false);
  await api.signOut();
  assert.equal(calls.at(-1).path, 'signOut');
  await api.signOutAll();
  assert.equal(calls.at(-1).path, 'signOutAll');
  assert.equal(api.sendChat, undefined, 'WebSocket chat is not invented as an HTTP endpoint');
}

async function testLegacyProgressionImportStaysUnverified() {
  const lifetimeKeys = ['kills', 'deaths', 'assists', 'headshots', 'longshots', 'shotsFired',
    'shotsHit', 'wins', 'losses', 'draws', 'matches', 'playtime', 'longestShot', 'bestStreak',
    'score', 'captures', 'confirms', 'denies', 'streaksEarned'];
  const weaponKeys = ['xp', 'kills', 'headshots', 'shotsFired', 'shotsHit'];
  const authData = () => ({ accessToken: 'token', expiresAt: '2026-08-21T01:00:00.000Z',
    session: { sessionId: '01J00000000000000000000004', deviceLabel: 'Browser',
      createdAt: '2026-08-21T00:00:00.000Z' },
    profile: { accountId: '01J00000000000000000000001', displayName: 'Player',
      createdAt: '2026-08-21T00:00:00.000Z',
      privacy: { presenceVisibility: 'everyone', statsVisibility: 'everyone' }, consent: null,
      moderation: { status: 'clear', activeSanctions: [] },
      flags: { nameChangeAvailableAt: null, setupNextStep: null } },
    consentReceipt: null, correlationId: '01J00000000000000000000002' });
  const values = new Map([['overstrike.progress.v1', JSON.stringify({
    schema: 1, xp: 999999999, lifetime: { kills: 999999999 },
    weapons: { rifle: { kills: 999999999 } },
  })]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const calls = [];
  const client = {
    sessionState: { authenticated: true },
    async signIn() {
      return { data: authData() };
    },
    async request(path, options = {}) {
      calls.push({ path, options });
      assert.equal(path, '/v1/profile/me/progression-import');
      return { status: 200, correlationId: '01J00000000000000000000002', headers: new Headers(),
        data: { source: 'localStorage:overstrike.progress.v1', verified: false,
          importedAt: '2026-08-21T00:00:00.000Z', data: { schema: 1, xp: 999999999,
            lifetime: Object.fromEntries(lifetimeKeys.map((key) => [key,
              key === 'kills' ? 999999999 : 0])),
            weapons: { rifle: Object.fromEntries(weaponKeys.map((key) => [key,
              key === 'kills' ? 999999999 : 0])) },
            challenges: [] },
          alreadyImported: false, correlationId: '01J00000000000000000000002' } };
    },
  };
  const api = createShellApi({ client, legacyStorage: storage });
  const result = await api.signIn({ email: 'person@example.test', password: 'secret' });
  assert.equal(result.profile.accountId, '01J00000000000000000000001');
  assert.equal(calls.length, 1, 'authenticated migration imports the legacy blob exactly once');
  assert.equal(calls[0].options.body.progress.lifetime.kills, 999999999,
    'client forwards hostile legacy data without treating it as authoritative locally');
  assert.equal(values.has('overstrike.progress.v1'), true,
    'one-shot import preserves the local practice blob');
  assert.equal(values.get('overstrike.progress.imported.v1'), 'done');
  await api.signIn({ email: 'person@example.test', password: 'secret' });
  assert.equal(calls.length, 1, 'the separate completion marker prevents repeated imports');

  const rejecting = createShellApi({ client: { ...client,
    request: async () => ({ status: 200, headers: new Headers(),
      correlationId: '01J00000000000000000000003', data: {
        source: 'localStorage:overstrike.progress.v1', verified: true,
        data: {}, alreadyImported: false,
      } }) }, legacyStorage: {
    getItem: (key) => key === 'overstrike.progress.v1' ? '{"xp":1}' : null,
    setItem() {},
  } });
  await assert.rejects(() => rejecting.signIn({ email: 'person@example.test', password: 'secret' }),
    (error) => error.code === 'CLIENT_PROTOCOL',
    'the client refuses a server projection that promotes modified legacy data to verified');
}

async function testClosedShellSuccessSchemas() {
  const response = (data, status = 200) => ({ data, status, headers: new Headers(),
    correlationId: '01J00000000000000000000009' });
  const rejected = async (body, invoke, clientExtras = {}) => {
    const api = createShellApi({ client: {
      sessionState: { authenticated: true },
      request: async () => response(body),
      ...clientExtras,
    }, legacyStorage: null, telemetry: { getClientSessionId: () => '01J00000000000000000000008',
      setConsent() {} } });
    await assert.rejects(() => invoke(api), (error) => error.code === 'CLIENT_PROTOCOL');
  };

  await rejected({ version: 1, evaluatedAt: '2026-08-21T00:00:00.000Z',
    expiresAt: '2026-08-21T01:00:00.000Z', flags: {}, correlationId: 'c', rolloutRules: [] },
  (api) => api.getFlags());
  await rejected({ telemetryPersonal: false, policyVersion: 1,
    decidedAt: '2026-08-21T00:00:00.000Z', subject: 'account', correlationId: 'c' },
  (api) => api.getConsent());
  await rejected({ items: 'not-an-array', nextCursor: null, correlationId: 'c' },
    (api) => api.listRooms());
  await rejected({ matchId: 'm', roomId: 'r', graceEndsAt: 12,
    serverNow: '2026-08-21T00:00:00.000Z', correlationId: 'c' },
  (api) => api.getActiveMatch());
  await rejected({ matchId: 'm', status: 'pending', mode: 'bomb', mapId: 'the-square',
    mapVersion: '1.0.0', startedAt: null, endedAt: null, retryAfterMs: 2000,
    correlationId: 'c', clientWinner: 'alpha' }, (api) => api.getMatch({ matchId: 'm' }));
  await rejected({ schemaVersion: 1, version: 2, values: {},
    updatedAt: '2026-08-21T00:00:00.000Z', correlationId: 'c', accountId: 'leak' },
  (api) => api.getSettings());
  await rejected(null, (api) => api.signIn({ email: 'person@example.test', password: 'secret' }), {
    signIn: async () => response({ accessToken: 'token' }),
  });

  await rejected({ eligible: true, receipt: 'r', expiresAt: '2026-02-30T00:00:00.000Z',
    policyVersion: 1, correlationId: 'c' }, (api) => api.checkEligibility({
    dateOfBirth: '1990-01-01', jurisdiction: 'CA-ON',
  }));
  await rejected({ available: false, policy: { rule: 'reserved', detail: 'leak' },
    correlationId: 'c' }, (api) => api.checkDisplayName({ displayName: 'Staff' }));
  await rejected({ correlationId: 'c', accepted: true },
    (api) => api.startRecovery({ email: 'person@example.test' }));
  await rejected({ version: 1, url: '/legal/terms/v1',
    publishedAt: '2026-08-21T00:00:00+00:00', correlationId: 'c' },
  (api) => api.getTerms());
  await rejected({ items: [{ accountId: 'a', displayName: 'Player', state: 'online',
    joinable: false, roomId: null, email: 'leak@example.test' }], nextCursor: null,
    correlationId: 'c' }, (api) => api.getOnlinePresence());
  await rejected({ sessions: [{ sessionId: 's', deviceLabel: 'Browser',
    userAgentClass: 'browser', ipClass: 'public', createdAt: '2026-08-21T00:00:00.000Z',
    lastSeenAt: '2026-08-21T00:00:00.000Z', isCurrent: false, ip: '203.0.113.1' }],
    correlationId: 'c' }, (api) => api.listSessions());

  const invalidEmptyApi = createShellApi({ client: {
    sessionState: { authenticated: true }, session: { announceRevocation() {} },
    request: async () => response({ correlationId: 'c' }, 200),
  }, legacyStorage: null });
  await assert.rejects(() => invalidEmptyApi.leaveRoom({ roomId: 'r' }),
    (error) => error.code === 'CLIENT_PROTOCOL');
}

async function testColdProfileRestoreRequestsOwnProfileOnce() {
  const correlationId = '01J00000000000000000000009';
  const at = '2026-08-21T00:00:00.000Z';
  const own = { accountId: 'account-a', displayName: 'Player', createdAt: at,
    privacy: { presenceVisibility: 'everyone', statsVisibility: 'everyone' }, consent: null,
    moderation: { status: 'clear', activeSanctions: [] },
    flags: { nameChangeAvailableAt: null, setupNextStep: null }, correlationId };
  const paths = [];
  const api = createShellApi({ client: { sessionState: { authenticated: true },
    request: async (path) => { paths.push(path); return { status: 200, correlationId,
      headers: new Headers(), data: path === '/v1/profile/me' ? own : {
        accountId: 'account-a', displayName: 'Player', createdAt: at, stats: null,
        presence: { state: 'online', joinable: false, roomId: null }, correlationId,
      } }; } }, legacyStorage: null });
  await api.getProfile();
  assert.equal(paths.filter((path) => path === '/v1/profile/me').length, 1,
    'cold/deep-link profile restore makes exactly one own-profile request');
}

async function testMalformedAuthCannotMutateSession() {
  const session = new SessionState({ window: null, BroadcastChannel: null });
  const client = createPlatformClient({ clientBuild: '1', session, ulid,
    fetch: async (_url, init) => {
      const correlationId = init.headers.get('X-Correlation-Id');
      return new Response(JSON.stringify({ accessToken: 'attacker-token',
        expiresAt: '2026-08-21T01:00:00.000Z', session: { sessionId: 's' },
        profile: {}, consentReceipt: null, correlationId }), { status: 200, headers: {
        'Content-Type': 'application/json', 'X-Correlation-Id': correlationId,
      } });
    } });
  const api = createShellApi({ client, legacyStorage: null });
  await assert.rejects(() => api.signIn({ email: 'person@example.test', password: 'secret' }),
    (error) => error.code === 'CLIENT_PROTOCOL');
  assert.equal(session.snapshot().authenticated, false,
    'malformed auth success is refused before the access token mutates session state');
  client.close();
}

function testRegistryIsClosed() {
  assert.deepEqual(sanitizeTelemetryPayload('client.error', {
    errorClass: 'other', fatal: false,
  }), null);
  assert.deepEqual(sanitizeTelemetryPayload('client.error', 1, {
    errorClass: 'other', fatal: false, message: 'not retained',
  }), { errorClass: 'other', fatal: false });
  assert.equal(sanitizeTelemetryPayload('client.error', 1, {
    errorClass: 'invented', fatal: false,
  }), null);
  assert.equal(sanitizeTelemetryPayload('unknown.event', 1, {}), null);
}

function testFeatureFlagsAndTelemetryKillSwitch() {
  let now = Date.parse('2026-08-20T12:00:00.000Z');
  const flags = createFeatureFlagState({ now: () => now });
  assert.equal(flags.isEnabled('shell.career.enabled'), true);
  assert.equal(flags.isEnabled('mode.bomb.enabled'), false);
  flags.update({
    version: 4,
    evaluatedAt: '2026-08-20T12:00:00.000Z',
    expiresAt: '2026-08-20T12:01:00.000Z',
    flags: { 'shell.career.enabled': false, 'telemetry.client.enabled': false,
      'unknown.client.key': true },
  });
  assert.equal(flags.isEnabled('shell.career.enabled'), false);
  assert.equal(flags.isEnabled('shell.serverbrowser.enabled'), true,
    'omitted known flags retain their compiled defaults');
  assert.equal(flags.isEnabled('unknown.client.key'), undefined,
    'unknown flags cannot enable an uncompiled behavior');
  assert.equal(flags.snapshot().stale, false);
  now += 61_000;
  assert.equal(flags.snapshot().stale, true);
  assert.throws(() => flags.update({ version: 5, flags: [] }));
}

await testHeadersAndMemoryToken();
await testSingleFlightRefresh();
await testRefreshRacesDoNotClearNewerSessions();
await testCrossTabRefreshSerialization();
await testRetryPolicy();
await testTimeout();
await testClosedProtocolAndCrossTabRevocation();
await testTelemetryPrivacyAndBatches();
await testFrozenUnloadIngress();
testHighLevelTelemetryHooks();
await testShellContractMappings();
await testLegacyProgressionImportStaysUnverified();

/**
 * http-api.md §11.6 sideload. The room-create form shipped a free-text Region box against a
 * closed set of datacenter codes, so "Canada" and "US" were both rejected with nothing naming
 * yyz/ord/iad. These pin the two properties the dropdown depends on: the list arrives with the
 * rooms, and a failure to fetch it degrades the FORM rather than the page.
 */
async function testRoomListSideloadsRegions() {
  const correlationId = '01J00000000000000000000010';
  const regions = [
    { id: 'yyz', label: 'Toronto', probeUrl: null, available: false },
    { id: 'ord', label: 'Chicago', probeUrl: 'https://ord.example.invalid/health', available: true },
  ];
  const make = (regionResponder) => createShellApi({
    client: { sessionState: { authenticated: true },
      request: async (path) => {
        if (path.startsWith('/v1/config/regions')) return regionResponder(correlationId);
        if (path.startsWith('/v1/presence/online')) {
          return { status: 200, correlationId, headers: new Headers(),
            data: { items: [], nextCursor: null, correlationId } };
        }
        return { status: 200, correlationId, headers: new Headers(),
          data: { items: [], nextCursor: null, correlationId } };
      } },
    legacyStorage: null });

  const ok = await make(() => ({ status: 200, correlationId, headers: new Headers(),
    data: { regions, correlationId } })).listRooms();
  assert.deepEqual(ok.regions.map((r) => r.id), ['yyz', 'ord'],
    'the region list arrives alongside the rooms, in server order');
  assert.equal(ok.regionsUnavailable, false, 'and is not flagged unavailable when it loaded');

  // A malformed list must NOT take down the room browser. Presence rethrows CLIENT_PROTOCOL
  // because it is page content; regions are options for an optional sub-form.
  const malformed = await make(() => ({ status: 200, correlationId, headers: new Headers(),
    data: { regions: [{ id: 'yyz' }], correlationId } })).listRooms();
  assert.equal(malformed.regionsUnavailable, true, 'a malformed region list is flagged');
  assert.deepEqual(malformed.regions, [], 'and yields no options rather than partial ones');
  assert.ok(Array.isArray(malformed.items),
    'the room listing still succeeds — a broken region list is not an outage of the browser');

  const failed = await make(() => { throw new Error('network'); }).listRooms();
  assert.equal(failed.regionsUnavailable, true, 'a transport failure is flagged the same way');
  assert.ok(Array.isArray(failed.items), 'and still does not break the listing');
}

await testClosedShellSuccessSchemas();
await testRoomListSideloadsRegions();
await testColdProfileRestoreRequestsOwnProfileOnce();
await testMalformedAuthCannotMutateSession();
testRegistryIsClosed();
testFeatureFlagsAndTelemetryKillSwitch();
console.log('platform CX client: all checks passed');
