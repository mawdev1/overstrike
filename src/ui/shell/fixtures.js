const FIXTURE_TIME = '2026-08-20T12:00:00.000Z';

const baseVariants = () => ({
  loading: { variant: 'loading' },
  empty: { variant: 'empty' },
  error: { variant: 'error', error: { code: 'FIXTURE_RETRY', message: 'Fixture request failed. Retry is available.' } },
  offline: { variant: 'offline', staleAt: FIXTURE_TIME },
  terminal: { variant: 'terminal', error: { code: 'FIXTURE_POLICY', message: 'Fixture policy prevents this action.' } },
});

function screen(readyData = {}, { empty = true, terminal = true } = {}) {
  const variants = {
    ...baseVariants(),
    ready: Object.freeze({ variant: 'ready', data: Object.freeze({ fixture: true, ...readyData }) }),
  };
  if (!empty) delete variants.empty;
  if (!terminal) delete variants.terminal;
  return Object.freeze(variants);
}

export const SHELL_SCREEN_FIXTURES = Object.freeze({
  welcome: screen({}, { empty: false }),
  'auth.signIn': screen({}, { empty: false }),
  'auth.create': screen({}, { empty: false }),
  'auth.recover': screen({}, { empty: false }),
  'onboarding.eligibility': screen({}, { empty: false }),
  'onboarding.consent': screen({ policyVersion: 1, personalTelemetryAllowed: false }),
  'onboarding.displayName': screen({}, { empty: false }),
  'onboarding.verify': screen({ destinationHint: 'fixture inbox' }, { empty: false }),
  'onboarding.terms': screen({ version: 'fixture-terms-v1', summary: 'Fixture terms summary.' }, { empty: false }),
  'onboarding.essentialSettings': screen({}, { terminal: false }),
  'play.rooms': screen({
    lastUpdatedAt: FIXTURE_TIME,
    nextCursor: 'fixture-next-page',
    // http-api.md §11.6, sideloaded by `listRooms`. One available and one not, so the fixture
    // exercises both branches of the create form's region dropdown rather than only the happy
    // one — an all-available list would never show that a full region is rendered disabled.
    regions: [
      { id: 'yyz', label: 'Toronto', probeUrl: null, available: false },
      { id: 'iad', label: 'Ashburn, Virginia', probeUrl: 'https://iad.fixture.invalid/health', available: true },
    ],
    regionsUnavailable: false,
    rooms: [
      { roomId: 'fixture-room-alpha', name: 'Fixture Alpha', region: 'NA-East', mapId: 'fixture-map-a', mode: 'tdm', rulesetVersion: 1, build: 'fixture-build', status: 'open', capacity: 10, playerCount: 6, joinable: true, joinBlockedReason: null, hasPassword: false, ownerAccountId: 'fixture-account-local', estimatedRttMs: 24, settings: {} },
      { roomId: 'fixture-room-bravo', name: 'Fixture Bravo', region: 'NA-West', mapId: 'fixture-map-b', mode: 'bomb', rulesetVersion: 1, build: 'fixture-build', status: 'open', capacity: 10, playerCount: 10, joinable: false, joinBlockedReason: 'full', hasPassword: false, ownerAccountId: 'fixture-account-host', estimatedRttMs: 62, settings: {} },
      { roomId: 'fixture-room-charlie', name: 'Fixture Charlie', region: 'NA-East', mapId: 'fixture-map-c', mode: 'tdm', rulesetVersion: 1, build: 'fixture-build', status: 'open', capacity: 8, playerCount: 2, joinable: true, joinBlockedReason: null, hasPassword: true, ownerAccountId: 'fixture-account-charlie', estimatedRttMs: 41, settings: {} },
    ],
  }),
  'play.roomDetail': screen({ room: { roomId: 'fixture-room-alpha', name: 'Fixture Alpha', region: 'NA-East', mapId: 'fixture-map-a', mapVersion: '1.0.0', mode: 'tdm', rulesetVersion: 'tdm-1.0.0', build: 'fixture-build', status: 'open', capacity: 10, playerCount: 6, joinable: true, joinBlockedReason: null, hasPassword: false, ownerAccountId: 'fixture-account-local', estimatedRttMs: 24, settings: {} } }),
  'room.home': screen({
    status: 'synchronized',
    room: { roomId: 'fixture-room-alpha', name: 'Fixture Alpha', region: 'NA-East', mapId: 'fixture-map-a', mode: 'tdm', rulesetVersion: 'tdm-1.0.0', status: 'open', capacity: 10, playerCount: 3, estimatedRttMs: 24 },
    readyClearedReason: 'team-change',
    roster: [
      { accountId: 'fixture-account-local', displayName: 'Fixture Player', team: 'alpha', ready: false, isOwner: true, isLocal: true, connection: 'connected', estimatedRttMs: 24, loadout: { primaryIdx: 0, secondaryIdx: 1 }, joinedAt: FIXTURE_TIME },
      { accountId: 'fixture-account-bravo', displayName: 'Fixture Rival', team: 'bravo', ready: true, isOwner: false, isLocal: false, connection: 'connected', estimatedRttMs: 48, loadout: { primaryIdx: 1, secondaryIdx: 0 }, joinedAt: FIXTURE_TIME },
      { accountId: 'fixture-account-open', displayName: 'Fixture Reserve', team: 'unassigned', ready: false, isOwner: false, isLocal: false, connection: 'reconnecting', estimatedRttMs: null, loadout: { primaryIdx: 0, secondaryIdx: 1 }, joinedAt: FIXTURE_TIME },
    ],
  }),
  'room.roster': screen({
    status: 'synchronized',
    room: { roomId: 'fixture-room-alpha', name: 'Fixture Alpha', region: 'NA-East', mapId: 'fixture-map-a', mode: 'tdm', status: 'open', capacity: 10, playerCount: 3 },
    readyClearedReason: 'team-change',
    roster: [
      { accountId: 'fixture-account-local', displayName: 'Fixture Player', team: 'alpha', ready: false, isOwner: true, isLocal: true, connection: 'connected', estimatedRttMs: 24 },
      { accountId: 'fixture-account-bravo', displayName: 'Fixture Rival', team: 'bravo', ready: true, isOwner: false, isLocal: false, connection: 'connected', estimatedRttMs: 48 },
      { accountId: 'fixture-account-open', displayName: 'Fixture Reserve', team: 'unassigned', ready: false, isOwner: false, isLocal: false, connection: 'reconnecting', estimatedRttMs: null },
    ],
  }),
  'room.loadout': screen({
    status: 'synchronized',
    roomId: 'fixture-room-alpha',
    roster: [{ accountId: 'fixture-account-local', displayName: 'Fixture Player', team: 'alpha', ready: false, isOwner: true, isLocal: true, loadout: { primaryIdx: 0, secondaryIdx: 1 } }],
    loadoutOptions: { primary: [{ index: 0, label: 'Fixture rifle' }, { index: 1, label: 'Fixture precision' }], secondary: [{ index: 0, label: 'Fixture sidearm' }, { index: 1, label: 'Fixture compact' }] },
  }, { empty: false }),
  'room.chat': screen({
    status: 'synchronized',
    roomId: 'fixture-room-alpha',
    historyRoomId: 'fixture-room-alpha',
    chatHistory: [{ id: 'fixture-message-1', accountId: 'fixture-account-bravo', displayName: 'Fixture Rival', text: 'Fixture message', ts: FIXTURE_TIME, filtered: false }],
    pingOptions: [{ kind: 'fixture-attention', label: 'Fixture attention' }],
  }, { empty: false }),
  'career.overview': screen({ matchesPlayed: 3, wins: 1, lastUpdatedAt: FIXTURE_TIME }),
  'career.modes': screen({ modes: [{ id: 'fixture-mode', name: 'Fixture mode', matches: 3, wins: 1 }] }),
  'career.weapons': screen({ weapons: [{ id: 'fixture-weapon', name: 'Fixture weapon', eliminations: 7 }] }),
  'career.matches': screen({ matches: [{ id: 'fixture-match-1', mode: 'Fixture mode', outcome: 'Fixture result', endedAt: FIXTURE_TIME }] }),
  'career.matchDetail': screen({ match: { id: 'fixture-match-1', mode: 'Fixture mode', status: 'final', endedAt: FIXTURE_TIME } }, { empty: false }),
  'settings.category': screen(),
  sessions: screen({ sessions: [{ id: 'fixture-session-current', device: 'Fixture browser', current: true, lastSeenAt: FIXTURE_TIME }] }),
  'match.loading': screen({ stage: 'Awaiting fixture handoff', handoff: { fixture: true, matchId: 'fixture-match-1' }, retryAllowed: true }, { empty: false }),
  'match.reconnect': screen({ state: 'grace', graceEndsAt: '2026-08-20T12:01:00.000Z', retryAllowed: true }),
  results: screen({ result: { matchId: 'fixture-match-1', status: 'final', outcome: 'Fixture result', roomId: 'fixture-room-alpha' } }, { empty: false }),
  system: screen({ condition: 'maintenance', message: 'Fixture system notice.' }, { empty: false }),
});

export const SHELL_VARIANT_MATRIX = Object.freeze(Object.fromEntries(
  Object.entries(SHELL_SCREEN_FIXTURES).map(([routeId, variants]) => [routeId, Object.freeze(Object.keys(variants))]),
));

export function getShellFixture(routeId, variant = 'ready') {
  return SHELL_SCREEN_FIXTURES[routeId]?.[variant] || null;
}

export function resolveShellFixture(fixtures, route, variant = 'ready') {
  if (!fixtures) return null;
  if (typeof fixtures === 'function') return fixtures(route, variant) || null;
  const candidate = fixtures[route.pathname] ?? fixtures[route.id];
  if (!candidate) return null;
  if (candidate.variant) return candidate;
  if (candidate[variant]?.variant) return candidate[variant];
  if (candidate[variant]) return { variant, data: candidate[variant] };
  return { variant: 'ready', data: candidate };
}
