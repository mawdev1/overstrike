const SERVER_NOW = 2_000_000;
const SAMPLED_AT = 10_000;
const FRESHNESS_MS = 750;

const site = (id, callout, x) => ({
  id: `site-${id}`,
  site: id,
  callout,
  center: { x, y: 0, z: id === 'A' ? -15 : 17 },
  box: { min: { x: x - 3, y: 0, z: -3 }, max: { x: x + 3, y: 3, z: 3 } },
});

export function baseBombMatchState(overrides = {}) {
  const state = {
    version: 1,
    matchId: '01J8X2K9P3QW7V000000000001',
    serverNow: SERVER_NOW,
    sampledAt: SAMPLED_AT,
    mode: 'bomb',
    mapId: 'the-square',
    mapVersion: '1.0.0',
    rulesetVersion: 'bomb-1.0.0',
    region: 'yyz',
    serverBuild: 'fixture-build',
    protocolVersion: 3,
    phase: 'live',
    phaseEndsAt: SERVER_NOW + 105_000,
    // bomb-rules §13.8: role fields arrive null from a symmetric-demolition server;
    // ownership is derived from site order + sideSwitched (§13.1). Alpha defends A,
    // bravo defends B, until the side switch swaps home sites.
    teams: {
      alpha: { score: 2, alive: 5, role: null },
      bravo: { score: 1, alive: 5, role: null },
    },
    killLimit: null,
    series: { roundsToWin: 7, maxRounds: 12, sideSwitchAfter: 6, sideSwitched: false, overtime: false },
    round: { index: 3, endsAt: SERVER_NOW + 105_000 },
    bomb: { state: 'carried', carrierId: 101, siteId: null, position: null },
    interaction: { kind: 'none', actorId: null, progress: 0 },
    sites: [site('A', 'Civic Archive', -21), site('B', 'Transit Control', 23)],
    localPlayer: {
      entityId: 101,
      team: 'alpha',
      role: null,
      alive: true,
      isSpectating: false,
      spectatingId: null,
      spectatorPolicy: { canSpectateEnemies: false, canFreeCam: false, canUseTeamChat: true },
    },
  };
  return merge(state, overrides);
}

function merge(base, override) {
  const out = { ...base, ...override };
  for (const key of ['teams', 'series', 'round', 'bomb', 'interaction', 'localPlayer']) {
    if (base[key] && override[key]) out[key] = { ...base[key], ...override[key] };
  }
  if (base.teams && override.teams) {
    out.teams = {
      alpha: { ...base.teams.alpha, ...override.teams.alpha },
      bravo: { ...base.teams.bravo, ...override.teams.bravo },
    };
  }
  if (base.localPlayer && override.localPlayer?.spectatorPolicy) {
    out.localPlayer.spectatorPolicy = {
      ...base.localPlayer.spectatorPolicy,
      ...override.localPlayer.spectatorPolicy,
    };
  }
  return out;
}

const input = (matchState, extra = {}) => ({
  matchState,
  netState: 'live',
  netStats: {
    sampledAt: SAMPLED_AT,
    windowMs: 5_000,
    rttMs: 32,
    jitterMs: 3,
    lossPct: 0,
    snapshotAgeMs: 0,
    receiveRateHz: 30,
    baselineState: 'synced',
  },
  nowMs: SAMPLED_AT,
  freshnessThresholdMs: FRESHNESS_MS,
  bindings: { interact: 'E', spectatePrevious: 'LEFT', spectateNext: 'RIGHT' },
  ...extra,
});

const fixture = (name, matchState, extra = {}, expect = {}) => Object.freeze({
  name,
  input: input(matchState, extra),
  expect: Object.freeze(expect),
});

const interaction = (kind, progress) => ({ kind, actorId: 101, progress });
// §13.4: a plant can only sit at the planter's TARGET site. Alpha plants at B (bravo's
// home, so BRAVO defuses there); bravo plants at A.
const planted = { phase: 'planted', phaseEndsAt: SERVER_NOW + 40_000, bomb: { state: 'planted', siteId: 'A', position: { x: -21, y: 0, z: -15 } } };
const plantedAtB = { phase: 'planted', phaseEndsAt: SERVER_NOW + 40_000, bomb: { state: 'planted', siteId: 'B', position: { x: 23, y: 0, z: 17 } } };

export const BOMB_FIXTURES = Object.freeze([
  fixture('freeze-home-alpha', baseBombMatchState({ phase: 'freeze', phaseEndsAt: SERVER_NOW + 8_000 }), {}, { phase: 'freeze', siteLabel: 'DEFEND A / HIT B' }),
  fixture('freeze-home-bravo', baseBombMatchState({
    phase: 'freeze', phaseEndsAt: SERVER_NOW + 8_000,
    localPlayer: { team: 'bravo', role: null, entityId: 202 },
  }), {}, { siteLabel: 'DEFEND B / HIT A' }),
  fixture('carrier-self', baseBombMatchState(), { carrierTeam: 'alpha' }, { localCarrier: true }),
  fixture('carrier-teammate', baseBombMatchState({ bomb: { carrierId: 102 } }), { carrierTeam: 'alpha' }, { localCarrier: false, carrierRelationship: 'teammate' }),
  fixture('carrier-enemy-visible', baseBombMatchState({
    localPlayer: { entityId: 202, team: 'bravo', role: null },
  }), { carrierTeam: 'alpha' }, { carrierRelationship: 'enemy' }),
  fixture('neutral-bomb-contestable', baseBombMatchState({
    bomb: { state: 'dropped', carrierId: null, position: { x: 1, y: 0, z: 1 } },
  }), {}, { bombLabel: 'BOMB UP FOR GRABS', markerVisible: true }),
  fixture('carrier-hidden-malformed-position', baseBombMatchState({ bomb: { carrierId: null, position: { x: 999, y: 999, z: 999 } } }), {}, { markerVisible: false }),
  fixture('bomb-dropped-visible', baseBombMatchState({ bomb: { state: 'dropped', carrierId: null, position: { x: 4, y: 0, z: 8 } } }), {}, { markerVisible: true }),
  fixture('bomb-dropped-hidden', baseBombMatchState({ bomb: { state: 'dropped', carrierId: null, position: null } }), {}, { markerVisible: false }),
  fixture('plant-0', baseBombMatchState({ bomb: { siteId: 'A' }, interaction: interaction('plant', 0) }), {}, { progress: 0 }),
  fixture('plant-50', baseBombMatchState({ bomb: { siteId: 'A' }, interaction: interaction('plant', 0.5) }), {}, { progress: 0.5 }),
  fixture('plant-99', baseBombMatchState({ bomb: { siteId: 'A' }, interaction: interaction('plant', 0.99) }), {}, { progress: 0.99 }),
  fixture('plant-interrupted', baseBombMatchState({ bomb: { siteId: 'A' } }), { typedEvent: { type: 'plantCancel', reason: 1 } }, { status: 'PLANT INTERRUPTED' }),
  fixture('plant-complete-authoritative', baseBombMatchState(planted), { cue: { type: 'plantComplete' } }, { bombState: 'planted' }),
  fixture('planted-idle', baseBombMatchState(planted), {}, { phase: 'planted' }),
  fixture('defuse-0', baseBombMatchState({ ...plantedAtB, localPlayer: { entityId: 202, team: 'bravo', role: null }, interaction: { kind: 'defuse', actorId: 202, progress: 0 } }), {}, { progress: 0 }),
  fixture('defuse-50', baseBombMatchState({ ...plantedAtB, localPlayer: { entityId: 202, team: 'bravo', role: null }, interaction: { kind: 'defuse', actorId: 202, progress: 0.5 } }), {}, { progress: 0.5 }),
  fixture('defuse-99', baseBombMatchState({ ...plantedAtB, localPlayer: { entityId: 202, team: 'bravo', role: null }, interaction: { kind: 'defuse', actorId: 202, progress: 0.99 } }), {}, { progress: 0.99 }),
  fixture('defuse-interrupted', baseBombMatchState(planted), { typedEvent: { type: 'defuseCancel', reason: 0 } }, { status: 'DEFUSE INTERRUPTED' }),
  fixture('defuse-complete-authoritative', baseBombMatchState({ ...planted, phase: 'roundEnd', bomb: { state: 'defused' } }), {
    outcomeEvent: { type: 'roundEnded', winner: 'bravo', reason: 'defuse' }, cue: { type: 'defuseComplete' },
  }, { bombState: 'defused' }),
  fixture('one-versus-one', baseBombMatchState({ teams: { alpha: { alive: 1 }, bravo: { alive: 1 } } }), {}, { alive: [1, 1] }),
  fixture('spectator-eligible', baseBombMatchState({ localPlayer: { alive: false, isSpectating: true, spectatingId: 102, spectatorPolicy: { canUseTeamChat: false } } }), {}, { spectator: true }),
  fixture('spectator-no-target-hidden-bomb', baseBombMatchState({
    bomb: { state: 'dropped', carrierId: null, position: null },
    localPlayer: { alive: false, isSpectating: true, spectatingId: null, spectatorPolicy: { canUseTeamChat: false } },
  }), {}, { markerVisible: false }),
  fixture('round-won-elimination', baseBombMatchState({ phase: 'roundEnd' }), { outcomeEvent: { type: 'roundEnded', winner: 'alpha', reason: 'elimination' } }, { outcome: 'ROUND WON' }),
  fixture('round-lost-defuse', baseBombMatchState({ phase: 'roundEnd' }), { outcomeEvent: { type: 'roundEnded', winner: 'bravo', reason: 'defuse' } }, { outcome: 'ROUND LOST' }),
  fixture('round-won-detonation', baseBombMatchState({ phase: 'roundEnd' }), { outcomeEvent: { type: 'roundEnded', winner: 'alpha', reason: 'detonation' } }, { outcome: 'ROUND WON' }),
  fixture('round-draw-timer', baseBombMatchState({ phase: 'roundEnd' }), { outcomeEvent: { type: 'roundEnded', winner: 'draw', reason: 'timer' } }, { outcome: 'ROUND DRAW' }),
  // §13.1: the side switch swaps HOME SITES, not roles — alpha now defends B.
  fixture('side-switch', baseBombMatchState({ series: { sideSwitched: true } }), { cue: { type: 'sideSwitch' } }, { homeSites: ['B', 'A'], siteLabel: 'DEFEND B / HIT A' }),
  fixture('regulation-round-12', baseBombMatchState({ round: { index: 11 } }), {}, { roundLabel: 'ROUND 12' }),
  fixture('degraded-estimating', baseBombMatchState(), { nowMs: SAMPLED_AT + 500, netStats: { sampledAt: SAMPLED_AT + 500, windowMs: 5_000, snapshotAgeMs: 500 } }, { clockStatus: 'estimating' }),
  fixture('stale-syncing', baseBombMatchState({ interaction: interaction('plant', 0.5) }), { nowMs: SAMPLED_AT + 5_000, netStats: { sampledAt: SAMPLED_AT + 5_000, windowMs: 5_000, snapshotAgeMs: 5_000 } }, { clockStatus: 'syncing' }),
  fixture('reconnecting-indeterminate', baseBombMatchState(), { netState: 'reconnecting', reconnect: null }, { overlay: 'reconnecting' }),
  fixture('reconnecting-measured', baseBombMatchState(), { netState: 'reconnecting', reconnect: { graceEndsAt: SAMPLED_AT + 15_000, attempt: 2, maxAttempts: 5, canCancel: true } }, { overlay: 'reconnecting' }),
  fixture('grace-expired', baseBombMatchState(), { netState: 'reconnecting', reconnect: { graceEndsAt: SAMPLED_AT, attempt: 5, maxAttempts: 5, canCancel: false } }, { overlay: 'grace-expired' }),
  fixture('match-aborted', baseBombMatchState({ phase: 'matchEnd' }), { outcomeEvent: { type: 'matchEnded', winner: null, outcomeReason: 'no-contest' } }, { outcome: 'MATCH ABORTED' }),
  fixture('protocol-mismatch', baseBombMatchState(), { netState: 'version-mismatch' }, { overlay: 'version-mismatch' }),
  fixture('interaction-refused', baseBombMatchState(), { typedEvent: { type: 'interactionRefused', kind: 'plant', reason: 3 } }, { status: 'BOMB REQUIRED' }),
]);

export const BOMB_FIXTURE_NAMES = Object.freeze(BOMB_FIXTURES.map((item) => item.name));

export const BOMB_VISUAL_MATRIX = Object.freeze({
  viewports: Object.freeze([
    Object.freeze({ width: 1280, height: 720, label: 'minimum' }),
    Object.freeze({ width: 1920, height: 1080, label: 'reference' }),
    Object.freeze({ width: 2560, height: 1080, label: 'ultrawide-21-9' }),
  ]),
  hudScales: Object.freeze([70, 100, 160]),
  browserZoomPct: Object.freeze([100, 200]),
  colorVisionPresets: Object.freeze(['default', 'deuteranopia', 'protanopia', 'tritanopia', 'grayscale']),
  reducedMotion: Object.freeze([false, true]),
});

export function getBombFixture(name) {
  return BOMB_FIXTURES.find((item) => item.name === name) || null;
}

export const BOMB_FIXTURE_CONSTANTS = Object.freeze({ SERVER_NOW, SAMPLED_AT, FRESHNESS_MS });
