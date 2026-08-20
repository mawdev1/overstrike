/**
 * The canonical stub data set.  contracts/http-api.md §12 and §11.3–§11.8,
 * contracts/match-result.md §4.1–§4.3.
 *
 * Every builder here produces a **contract-shaped** object: the exact key set, the exact enums,
 * and the present-and-null rule honoured everywhere. That is the whole value of the stub — the
 * frontend lane builds against these and switches to the live services with no UI change, so a
 * field that is "close enough" here is a UI rewrite later.
 *
 * Nothing in this file reads the wall clock or a random source. Time comes from the caller's
 * scenario clock; ids come from `ids.js`.
 */
import { EPOCH_MS, iso } from './clock.js';
import { stubUlid, stubToken } from './ids.js';
// The stub validates roaming settings with the platform's own validator rather than a second
// copy of the rules: two validators is two places for the vocabulary to drift.
import { defaultRoamingValues } from '../profile/settings.js';

const DAY = 24 * 3600 * 1000;

export const ACCOUNT_ID = stubUlid('account:me', EPOCH_MS - 400 * DAY);
export const OTHER_ACCOUNT_ID = stubUlid('account:other', EPOCH_MS - 300 * DAY);
export const DISPLAY_NAME = 'StubRunner';
export const BUILD = '1.0.0-stub';
export const SERVER_BUILD = 'match-1.0.0-stub';
export const STAT_DEFINITION_VERSION = '1.0.0';
export const TERMS_URL = 'https://stub.overstrike.invalid/legal/terms';

/** The two regions §12 requires the room set to span. */
export const REGIONS = [
  { id: 'yyz', label: 'Toronto', probeUrl: 'https://yyz.probe.stub.invalid/ping', available: true },
  { id: 'ord', label: 'Chicago', probeUrl: 'https://ord.probe.stub.invalid/ping', available: true },
];

/**
 * `X-Region-Rtt` (§11.6): `region=integerMs`, comma separated, max 8, each 0–5000.
 *
 * Malformed or absent means `estimatedRttMs: null` on every room — the server never invents a
 * ping from geography, because a fabricated latency is worse than an absent one.
 */
export function parseRegionRtt(headerValue) {
  if (typeof headerValue !== 'string' || headerValue === '') return null;
  const pairs = headerValue.split(',');
  if (pairs.length > 8) return null;
  const out = {};
  for (const pair of pairs) {
    const [region, raw] = pair.split('=');
    if (!region || raw === undefined) return null;
    if (!/^[a-z]{2,8}$/.test(region)) return null;
    if (!/^\d{1,4}$/.test(raw)) return null;
    const ms = Number(raw);
    if (ms < 0 || ms > 5000) return null;
    out[region] = ms;
  }
  return out;
}

// ── settings ────────────────────────────────────────────────────────────────────────────────

/** RoomSettings, §11.3. Mode-specific keys are present-and-null in the other mode. */
export function roomSettings(mode) {
  if (mode === 'bomb') {
    return {
      killLimit: null,
      roundsToWin: 7, maxRounds: 12, roundLengthSec: 105,
      backfill: false,                  // Bomb never backfills mid-round (bomb-rules.md §9)
      requiredReady: 8, minPlayers: 2,
    };
  }
  return {
    killLimit: 75,
    roundsToWin: null, maxRounds: null, roundLengthSec: null,
    backfill: true, requiredReady: 8, minPlayers: 2,
  };
}

/** rulesSnapshot, match-result.md §4. Every key present in both modes. */
export function rulesSnapshot(mode) {
  if (mode === 'bomb') {
    return {
      killLimit: null,
      roundsToWin: 7, maxRounds: 12, sideSwitchAfter: 6,
      roundLengthSec: 105, bombTimerSec: 40, defuseSec: 7, plantSec: 3,
      freezeSec: 8, overtime: false,
    };
  }
  return {
    killLimit: 75,
    roundsToWin: null, maxRounds: null, sideSwitchAfter: null,
    roundLengthSec: null, bombTimerSec: null, defuseSec: null,
    plantSec: null, freezeSec: null, overtime: null,
  };
}

// ── rooms ───────────────────────────────────────────────────────────────────────────────────

/**
 * Three rooms across two regions (§12), one of them carrying the 12-player roster.
 *
 * Room 1 is deliberately the full, counting-down Bomb room: it is the only place a lobby screen
 * can see a non-null `CountdownState` and a complete roster in the same fixture.
 */
const ROOM_SPECS = [
  { key: 'a', name: 'Stub Alpha',  region: 'yyz', mode: 'tdm',  status: 'open',
    capacity: 12, playerCount: 6,  joinable: true,  joinBlockedReason: null, hasPassword: false },
  { key: 'b', name: 'Stub Bravo',  region: 'yyz', mode: 'bomb', status: 'countdown',
    capacity: 12, playerCount: 12, joinable: false, joinBlockedReason: 'full', hasPassword: true },
  { key: 'c', name: 'Stub Charlie', region: 'ord', mode: 'tdm', status: 'in-progress',
    capacity: 12, playerCount: 8,  joinable: false, joinBlockedReason: 'in-progress', hasPassword: false },
];

export const ROOM_IDS = ROOM_SPECS.map((s) => stubUlid(`room:${s.key}`, EPOCH_MS - 3600 * 1000));

export function roomCore(index, { rtt = null, overrides = {}, roomId = null } = {}) {
  const spec = ROOM_SPECS[index];
  const core = {
    roomId: roomId || ROOM_IDS[index],
    name: spec.name,
    region: spec.region,
    mapId: 'the-square',
    mapVersion: '1.0.0',
    mode: spec.mode,
    rulesetVersion: spec.mode === 'bomb' ? 'bomb-1.0.0' : 'tdm-1.0.0',
    build: BUILD,
    status: spec.status,
    capacity: spec.capacity,
    playerCount: spec.playerCount,
    joinable: spec.joinable,
    joinBlockedReason: spec.joinBlockedReason,
    hasPassword: spec.hasPassword,
    ownerAccountId: index === 0 ? ACCOUNT_ID : OTHER_ACCOUNT_ID,
    estimatedRttMs: rtt && rtt[spec.region] !== undefined ? rtt[spec.region] : null,
    settings: roomSettings(spec.mode),
  };
  return { ...core, ...overrides };
}

/** RosterMember[], §11.3. `isLocal` marks the caller, exactly once. */
export function roster(index, { count = null, roomId = null } = {}) {
  const spec = ROOM_SPECS[index];
  const n = count === null ? spec.playerCount : count;
  const id = roomId || ROOM_IDS[index];
  const out = [];
  for (let i = 0; i < n; i++) {
    const local = i === 0;
    out.push({
      accountId: local ? ACCOUNT_ID : stubUlid(`member:${id}:${i}`, EPOCH_MS - 200 * DAY),
      displayName: local ? DISPLAY_NAME : `StubPlayer${String(i).padStart(2, '0')}`,
      team: i % 2 === 0 ? 'alpha' : 'bravo',
      ready: i < 8,
      isOwner: local ? index === 0 : i === 1 && index !== 0,
      isLocal: local,
      connection: i === n - 1 && n > 4 ? 'reconnecting' : 'connected',
      estimatedRttMs: null,
      loadout: { primaryIdx: i % 4, secondaryIdx: (i + 2) % 3 },
      joinedAt: iso(EPOCH_MS - (600 - i * 5) * 1000),
    });
  }
  return out;
}

/**
 * The caller, as a roster member who has just joined a room they were not already in.
 *
 * `unassigned` rather than a guessed side: §11.4 says `preferredTeam` is a preference and the
 * server assigns, so a fixture that silently picks alpha would be the stub inventing the one
 * answer the client is told to wait for.
 */
export function joiningMember(roomId, position) {
  return {
    accountId: ACCOUNT_ID,
    displayName: DISPLAY_NAME,
    team: 'unassigned',
    ready: false,
    isOwner: false,
    isLocal: true,
    connection: 'connected',
    estimatedRttMs: null,
    loadout: { primaryIdx: 0, secondaryIdx: 0 },
    joinedAt: iso(EPOCH_MS - (60 - position) * 1000),
  };
}

export function countdownState(index) {
  if (ROOM_SPECS[index].status !== 'countdown') return null;
  return { endsAt: iso(EPOCH_MS + 20 * 1000), requiredReady: 8, currentReady: 8 };
}

/**
 * Which fixture room a path parameter refers to, or `-1`.
 *
 * It used to answer `0` for anything unknown, so every mistyped, stale, or deleted room id
 * returned room A wearing that id — the shell could never build the `ROOM_NOT_FOUND` path
 * because the stub had no way to express it. `-1` is the caller's cue to raise it.
 */
export function roomIndexFor(roomId) {
  return ROOM_IDS.indexOf(roomId);
}

export function roomDetail(index, { rtt = null, overrides = {}, roomId = null } = {}) {
  return {
    ...roomCore(index, { rtt, overrides, roomId }),
    roster: roster(index, { roomId }),
    countdown: countdownState(index),
  };
}

export function reservation(clock, seed) {
  return {
    reservationId: stubUlid(`reservation:${seed}`, clock.nowMs()),
    expiresAt: clock.plus(30 * 1000),
    lobbySocketUrl: 'wss://lobby.stub.invalid/v1/lobby',
    lobbyTicket: stubToken('lobbyticket', `lobby:${seed}`),
  };
}

// ── profile, stats, history ─────────────────────────────────────────────────────────────────

export function privacyDefaults() {
  return { presenceVisibility: 'everyone', statsVisibility: 'everyone' };
}

/**
 * §4 `GET /v1/profile/me`.
 *
 * `consent` is object-or-null and **never absent** — null is "undecided", which is what an
 * account predating the policy version carries. `correlationId` is added by the response
 * writer, not here, so the same object can be embedded in an auth response.
 */
export function profileMe({
  consent = undefined, moderation = null, displayName = DISPLAY_NAME, setupNextStep = null,
} = {}) {
  return {
    accountId: ACCOUNT_ID,
    displayName,
    createdAt: iso(EPOCH_MS - 400 * DAY),
    privacy: privacyDefaults(),
    consent: consent === undefined
      ? { telemetryPersonal: true, policyVersion: 1, decidedAt: iso(EPOCH_MS - 400 * DAY) }
      : consent,
    moderation: moderation || { status: 'clear', activeSanctions: [] },
    // `setupNextStep` is the resume discriminator design/first-run-flow.md requires: "the
    // sign-in branch ... resumes at the first incomplete account-policy step returned by the
    // platform", and "Session; profile incomplete → First incomplete account step". Nothing in
    // the contract returned it, so a returning half-onboarded player could only discover the
    // step by provoking a 403 from a gameplay route it had no reason to call. It rides in
    // `flags` because signin and signup embed this exact object, which makes the first
    // authenticated response the client already makes the one that answers the question.
    // NOTE: additive against http-api.md §4 — see the CCR in the handover.
    flags: { nameChangeAvailableAt: iso(EPOCH_MS + 30 * DAY), setupNextStep },
  };
}

/**
 * The first incomplete step of the approved order (§3a), or null when setup is complete.
 *
 * The order is the contract's, not a preference: eligibility precedes consent so an ineligible
 * visitor is never asked to consent, and verification precedes terms because that is the order
 * `errors.md` routes the two gate codes in.
 */
export function setupNextStepFor(state) {
  if (!state.signedUp) {
    if (!state.eligible) return 'eligibility';
    if (!state.consent) return 'consent';
    return 'display-name';
  }
  if (!state.consent) return 'consent';
  if (!state.verified) return 'verify';
  if (!state.termsAccepted) return 'terms';
  if (!state.essentialSettingsDone) return 'essential-settings';
  return null;
}

/**
 * The caller's OWN public projection, `GET /v1/profile/:accountId` with your own id.
 *
 * This is the contracted discovery step for "am I still in a lobby?" after a reload:
 * `design/first-run-flow.md` resumes an active lobby membership at a resync screen, and
 * `presence.roomId` here is the only place the room id exists once `match.ready` and the socket
 * are gone. `GET /v1/matches/active` answers the same question for a *match*; this answers it
 * for a room, and between them a reloaded shell never has to reconstruct one from local state.
 */
export function selfProfile({ displayName = DISPLAY_NAME, statsVisible = true, activeRoomId = null } = {}) {
  return {
    accountId: ACCOUNT_ID,
    displayName,
    createdAt: iso(EPOCH_MS - 400 * DAY),
    stats: statsVisible ? { ...statsTotals('tdm'), accountId: ACCOUNT_ID } : null,
    presence: activeRoomId
      ? { state: 'in-lobby', joinable: false, roomId: activeRoomId }
      : { state: 'online', joinable: false, roomId: null },
  };
}

export function publicProfile({ statsVisible = true, presenceVisible = true } = {}) {
  return {
    accountId: OTHER_ACCOUNT_ID,
    displayName: 'StubPlayer01',
    createdAt: iso(EPOCH_MS - 300 * DAY),
    stats: statsVisible ? { ...statsTotals('tdm'), accountId: OTHER_ACCOUNT_ID } : null,
    presence: presenceVisible
      ? { state: 'in-lobby', joinable: true, roomId: ROOM_IDS[0] }
      : null,
  };
}

const TOTAL_KEYS = [
  'kills', 'deaths', 'assists', 'suicides', 'teamKills', 'headshots', 'shotsFired', 'shotsHit',
  'damageDealt', 'plants', 'defuses', 'matches', 'wins', 'losses', 'draws', 'roundsPlayed',
  'timePlayedSec',
];

/**
 * §11.5 stats. **No derived values** — no K/D, no accuracy, no win rate. Shipping both a
 * counter and its ratio guarantees they eventually disagree, and only one of them is right.
 */
export function statsTotals(mode, { scale = 1 } = {}) {
  const base = {
    kills: 412, deaths: 388, assists: 141, suicides: 7, teamKills: 3, headshots: 96,
    shotsFired: 9821, shotsHit: 2733, damageDealt: 41290, plants: 22, defuses: 15,
    matches: 20, wins: 11, losses: 8, draws: 1, roundsPlayed: 164, timePlayedSec: 27400,
  };
  const totals = {};
  for (const k of TOTAL_KEYS) totals[k] = Math.round(base[k] * scale);
  if (mode === 'tdm') { totals.plants = 0; totals.defuses = 0; totals.roundsPlayed = 0; }
  return {
    accountId: ACCOUNT_ID,
    mode,
    statDefinitionVersion: STAT_DEFINITION_VERSION,
    totals,
    weapons: scale === 0 ? {} : {
      'rifle-ar1': { shots: 5210, hits: 1502, kills: 231, headshots: 58 },
      'smg-mp1':   { shots: 2841, hits: 811,  kills: 121, headshots: 26 },
      'pistol-p1': { shots: 1770, hits: 420,  kills: 60,  headshots: 12 },
    },
  };
}

/** A terminal history item, §4.3. */
function terminalHistoryItem(i) {
  const mode = i % 3 === 0 ? 'tdm' : 'bomb';
  const outcome = ['win', 'loss', 'win', 'draw', 'loss'][i % 5];
  // The caller is always on alpha, so the scoreline has to agree with `result` — a history row
  // whose score contradicts its own outcome is a fixture that teaches the UI a lie.
  const scores = mode === 'tdm'
    ? (outcome === 'win' ? { alpha: 75, bravo: 61 }
      : outcome === 'loss' ? { alpha: 58, bravo: 75 } : { alpha: 75, bravo: 75 })
    : (outcome === 'win' ? { alpha: 7, bravo: 4 }
      : outcome === 'loss' ? { alpha: 3, bravo: 7 } : { alpha: 6, bravo: 6 });
  return {
    matchId: stubUlid(`match:history:${i}`, EPOCH_MS - (i + 1) * 3600 * 1000),
    status: 'completed',
    mode,
    mapId: 'the-square',
    mapVersion: '1.0.0',
    endedAt: iso(EPOCH_MS - (i + 1) * 3600 * 1000),
    result: outcome,
    teamScores: scores,
    playerSummary: { kills: 18 + i, deaths: 14 + (i % 5), assists: 4 + (i % 3), score: 2100 + i * 10 },
  };
}

/** A pending history item, §4.3 — every outcome field null, never omitted. */
function pendingHistoryItem(i, { endedAt = null } = {}) {
  return {
    matchId: stubUlid(`match:pending:${i}`, EPOCH_MS - i * 60 * 1000),
    status: 'pending',
    mode: 'bomb',
    mapId: 'the-square',
    mapVersion: '1.0.0',
    endedAt,
    result: null,
    teamScores: null,
    playerSummary: null,
  };
}

/** §12: 20 matches of history. */
export function historyItems({ count = 20 } = {}) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(terminalHistoryItem(i));
  return out;
}

/** `history-mixed`: terminal AND pending items, so the §4.3 union is genuinely exercised. */
export function mixedHistoryItems() {
  return [
    pendingHistoryItem(0),                                              // live
    pendingHistoryItem(1, { endedAt: iso(EPOCH_MS - 120 * 1000) }),     // ended, queued
    ...historyItems({ count: 6 }),
  ];
}

// ── match results ───────────────────────────────────────────────────────────────────────────

function resultRoster() {
  return [
    { accountId: ACCOUNT_ID, team: 'alpha', joinedAt: iso(EPOCH_MS - 2400 * 1000), leftAt: null },
    { accountId: stubUlid('match:p1', EPOCH_MS - 200 * DAY), team: 'alpha', joinedAt: iso(EPOCH_MS - 2400 * 1000), leftAt: null },
    { accountId: stubUlid('match:p2', EPOCH_MS - 200 * DAY), team: 'bravo', joinedAt: iso(EPOCH_MS - 2400 * 1000), leftAt: null },
    { accountId: stubUlid('match:p3', EPOCH_MS - 200 * DAY), team: 'bravo', joinedAt: iso(EPOCH_MS - 2400 * 1000), leftAt: iso(EPOCH_MS - 600 * 1000) },
  ];
}

function resultPlayers(mode) {
  const seed = [
    { name: DISPLAY_NAME,  team: 'alpha', k: 22, d: 14, a: 5 },
    { name: 'StubPlayer01', team: 'alpha', k: 17, d: 16, a: 8 },
    { name: 'StubPlayer02', team: 'bravo', k: 15, d: 19, a: 6 },
    { name: 'StubPlayer03', team: 'bravo', k: 9,  d: 21, a: 3 },
  ];
  const rosterRows = resultRoster();
  return seed.map((p, i) => ({
    accountId: rosterRows[i].accountId,
    displayName: p.name,
    team: p.team,
    role: mode === 'bomb' ? (p.team === 'alpha' ? 'attacker' : 'defender') : null,
    kills: p.k, deaths: p.d, assists: p.a,
    suicides: i === 3 ? 1 : 0,
    teamKills: i === 2 ? 1 : 0,
    headshots: Math.floor(p.k / 4),
    shotsFired: 300 + i * 40,
    shotsHit: 90 + i * 11,
    damageDealt: 2400 + i * 130,
    plants: mode === 'bomb' && i === 0 ? 3 : 0,
    defuses: mode === 'bomb' && i === 2 ? 2 : 0,
    roundsPlayed: mode === 'bomb' ? 12 : 0,
    timePlayedSec: 1800 - i * 60,
    score: 3400 - i * 300,
    disconnected: i === 3,
    abandoned: false,
    joinedAt: rosterRows[i].joinedAt,
    leftAt: rosterRows[i].leftAt,
    weapons: {
      'rifle-ar1': { shots: 200 + i * 10, hits: 60 + i * 4, kills: p.k - 3, headshots: 2 },
      'pistol-p1': { shots: 40, hits: 12, kills: 3, headshots: 1 },
    },
  }));
}

const ROUND_REASONS = ['elimination', 'defuse', 'detonation', 'timer'];

/** Rounds that actually add up to `teamScores`. A scoreboard that disagrees with its rounds is a bug fixture, not a fixture. */
function resultRounds(alphaWins, bravoWins, mode) {
  if (mode === 'tdm') return [];
  const rounds = [];
  let a = alphaWins;
  let b = bravoWins;
  let i = 0;
  while (a > 0 || b > 0) {
    const winner = (i % 2 === 0 && a > 0) || b === 0 ? 'alpha' : 'bravo';
    if (winner === 'alpha') a--; else b--;
    const reason = ROUND_REASONS[i % 4];
    const attackersAlpha = i < 6;
    rounds.push({
      index: i,
      winner,
      reason,
      startedAt: iso(EPOCH_MS - (2400 - i * 150) * 1000),
      endedAt: iso(EPOCH_MS - (2400 - i * 150 - 120) * 1000),
      roles: {
        alpha: attackersAlpha ? 'attacker' : 'defender',
        bravo: attackersAlpha ? 'defender' : 'attacker',
      },
      plant: reason === 'defuse' || reason === 'detonation'
        ? { accountId: ACCOUNT_ID, site: i % 2 === 0 ? 'A' : 'B', at: iso(EPOCH_MS - (2400 - i * 150 - 60) * 1000) }
        : null,
      defuse: reason === 'defuse'
        ? { accountId: stubUlid('match:p2', EPOCH_MS - 200 * DAY), at: iso(EPOCH_MS - (2400 - i * 150 - 90) * 1000) }
        : null,
    });
    i++;
  }
  return rounds;
}

/**
 * A `TerminalResult`, match-result.md §4.2.
 *
 * The status-dependent invariants in that table are enforced by the callers below rather than
 * checked here, and the test re-derives them independently — a fixture that validates itself
 * proves nothing.
 */
export function terminalResult(matchId, {
  status, outcomeReason, winnerTeam, invalidationReason = null, mode = 'bomb',
  teamScores = { alpha: 7, bravo: 5 },
} = {}) {
  return {
    matchId,
    status,
    rulesetVersion: mode === 'bomb' ? 'bomb-1.0.0' : 'tdm-1.0.0',
    statDefinitionVersion: STAT_DEFINITION_VERSION,
    rulesSnapshot: rulesSnapshot(mode),
    serverBuild: SERVER_BUILD,
    mapId: 'the-square',
    mapVersion: '1.0.0',
    region: 'yyz',
    mode,
    startedAt: iso(EPOCH_MS - 2400 * 1000),
    endedAt: iso(EPOCH_MS - 300 * 1000),
    terminationReason: status,
    outcomeReason,
    winnerTeam,
    invalidationReason,
    roster: resultRoster(),
    teamScores,
    rounds: resultRounds(teamScores.alpha, teamScores.bravo, mode),
    players: resultPlayers(mode),
    evidenceRef: `stub://evidence/${matchId}`,
  };
}

/** The non-terminal fourth shape, §4.2. `endedAt` null while live, set once ended and queued. */
export function pendingResult(matchId, { endedAt = null } = {}) {
  return {
    matchId,
    status: 'pending',
    mode: 'bomb',
    mapId: 'the-square',
    mapVersion: '1.0.0',
    startedAt: iso(EPOCH_MS - 900 * 1000),
    endedAt,
    retryAfterMs: 2000,
  };
}

// ── match handoff ───────────────────────────────────────────────────────────────────────────

/** The complete `MatchHandoff`, realtime-lobby.md §6.1. */
export function matchHandoff(matchId, clock) {
  return {
    matchId,
    serverUrl: 'wss://match.stub.invalid/v1/match',
    sessionTicket: stubToken('sessionticket', `session:${matchId}`),
    expiresAt: clock.plus(60 * 1000),
    reconnectGraceMs: 90000,
    mapId: 'the-square',
    mapVersion: '1.0.0',
    mode: 'bomb',
    rulesetVersion: 'bomb-1.0.0',
    region: 'yyz',
    serverBuild: SERVER_BUILD,
    protocolVersion: 2,
    series: { roundsToWin: 7, maxRounds: 12, sideSwitchAfter: 6, overtime: false },
    spectatorPolicyVersion: 1,
    sites: [
      { id: 'site-A', site: 'A', callout: 'Fountain',
        center: { x: -12, y: 0, z: 8 },
        box: { min: { x: -16, y: 0, z: 4 }, max: { x: -8, y: 3, z: 12 } } },
      { id: 'site-B', site: 'B', callout: 'Terrace',
        center: { x: 14, y: 0, z: -6 },
        box: { min: { x: 10, y: 0, z: -10 }, max: { x: 18, y: 3, z: -2 } } },
    ],
  };
}

export const MATCH_ID = stubUlid('match:active', EPOCH_MS - 900 * 1000);
export const ROOM_ID_ACTIVE = ROOM_IDS[1];

// ── misc ────────────────────────────────────────────────────────────────────────────────────

/** feature-flags.md §3.2 — the complete client-visible registry, evaluated, booleans only. */
export function clientFlags() {
  return {
    'shell.diagnostics.panel': true,
    'shell.career.enabled': true,
    'shell.serverbrowser.enabled': true,
    'mode.tdm.enabled': true,
    'mode.bomb.enabled': false,
    'map.the_square.enabled': false,
    'chat.text.enabled': true,
    'chat.pings.enabled': true,
    'reports.enabled': true,
    'telemetry.client.enabled': true,
  };
}

export const CURRENT_SESSION_ID = stubUlid('session:current', EPOCH_MS - 3600 * 1000);
export const OTHER_SESSION_ID = stubUlid('session:other', EPOCH_MS - 10 * DAY);

export function sessionsList() {
  return [
    { sessionId: CURRENT_SESSION_ID, deviceLabel: 'Chrome on macOS',
      userAgentClass: 'desktop-chrome', ipClass: 'CA-ON', createdAt: iso(EPOCH_MS - 3600 * 1000),
      lastSeenAt: iso(EPOCH_MS - 60 * 1000), isCurrent: true },
    { sessionId: OTHER_SESSION_ID, deviceLabel: 'Firefox on Windows',
      userAgentClass: 'desktop-firefox', ipClass: 'CA-QC', createdAt: iso(EPOCH_MS - 10 * DAY),
      lastSeenAt: iso(EPOCH_MS - 2 * DAY), isCurrent: false },
  ];
}

export function presenceItems() {
  return [
    { accountId: OTHER_ACCOUNT_ID, displayName: 'StubPlayer01', state: 'in-lobby', joinable: true, roomId: ROOM_IDS[0] },
    { accountId: stubUlid('presence:2', EPOCH_MS - 200 * DAY), displayName: 'StubPlayer02', state: 'in-match', joinable: false, roomId: ROOM_IDS[1] },
    { accountId: stubUlid('presence:3', EPOCH_MS - 200 * DAY), displayName: 'StubPlayer03', state: 'online', joinable: false, roomId: null },
  ];
}

/**
 * Roaming settings values.
 *
 * `RoamingSettingsV1` is exactly the ROAM rows of `design/settings-inventory.md` (§11.9). The
 * stub returned four hand-picked keys and three dotted binding ids (`move.forward`,
 * `weapon.fire`) that appear in no vocabulary — the inventory's action ids are `forward` and
 * `fire`, and `Mouse0` is not a code the validator accepts at all. A client built against that
 * shape has to be rewritten to talk to the real endpoint, which is the exact failure the stub
 * exists to prevent.
 *
 * So the defaults come from the SAME generated vocabulary the profile module validates against.
 * Nothing here names a key, a range, or an enum member.
 */
export function roamingSettings() {
  return {
    ...defaultRoamingValues(),
    // Three bindings rather than none, so a settings screen has a populated `keybinds` map to
    // render — including the secondary slot, which a single action→code map cannot express.
    keybinds: {
      forward: { primary: 'KeyW', secondary: null },
      crouch: { primary: 'ControlLeft', secondary: 'KeyC' },
      fire: { primary: 'Mouse1', secondary: null },
    },
  };
}

export { iso };
