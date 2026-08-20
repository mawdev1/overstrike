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
    rooms: [
      { id: 'fixture-room-alpha', name: 'Fixture Alpha', mode: 'Team deathmatch', occupancy: '6 / 10', joinable: true },
      { id: 'fixture-room-bravo', name: 'Fixture Bravo', mode: 'Team deathmatch', occupancy: '10 / 10', joinable: false },
    ],
  }),
  'play.roomDetail': screen({ room: { id: 'fixture-room-alpha', name: 'Fixture Alpha', mode: 'Team deathmatch', map: 'Fixture map', occupancy: '6 / 10', joinable: true } }),
  'room.home': screen({ room: { id: 'fixture-room-alpha', name: 'Fixture Alpha', state: 'forming' }, members: [{ id: 'fixture-member-1', displayName: 'Fixture Player', team: 'A', ready: false }] }),
  'room.roster': screen({ room: { id: 'fixture-room-alpha', name: 'Fixture Alpha' }, members: [{ id: 'fixture-member-1', displayName: 'Fixture Player', team: 'A', ready: false }] }),
  'room.loadout': screen({}, { empty: false }),
  'room.chat': screen({ messages: [{ id: 'fixture-message-1', author: 'Fixture Player', text: 'Fixture message', sentAt: FIXTURE_TIME }] }, { empty: false }),
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
