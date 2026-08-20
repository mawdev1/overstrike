/**
 * The net-facade stub.  contracts/net-facade.md §8, behind flag `net.facade.stub`.
 *
 * §8 promises `net.__stub(scenario)` drives "the whole surface from a scripted timeline with no
 * server", so the Bomb HUD can be built and every §3.2 connection state exercised before a match
 * server exists. Nothing implemented it, which is why the HUD work had no fixture to render.
 *
 * This is that timeline, in-process and drivable: `next()` applies one step, `runAll()` applies
 * them all, and every step is a pure function of the scenario, so two runs are byte-identical.
 * There is no socket, no timer and no clock read — a scenario about high jitter must not take
 * longer to run than one about a clean link.
 *
 * ── What this stub refuses to do ────────────────────────────────────────────────────────────
 * §2 is the rule the whole facade encodes: *the UI renders, it never decides*. So
 * `requestInteraction('plant')` here does exactly what it does against a real server — it
 * records the intent and changes nothing. The plant becomes true only when a scripted server
 * step says it did. A stub that completed the interaction locally would teach the HUD the one
 * habit §2 exists to prevent, and it would look correct right up to the first packet loss.
 *
 * ── Coverage beyond §8's eight names ────────────────────────────────────────────────────────
 * §8 names eight timelines and they are all here. The Bomb visibility rows (§5.1/§5.1.1), the
 * `match-result.md` §4.2 outcome matrix and the §5.1.0a spectator-policy phase table each need
 * a timeline of their own and §8 names none — see `NET_FACADE_EXTRA`, which declares each extra
 * with the contract row it serves so undocumented fixtures cannot accumulate here. Naming them
 * in §8 is an additive amendment to a contract this lane's H1.1 brief did not open.
 */
import { EPOCH_MS, iso } from './clock.js';
import { stubUlid, stubToken } from './ids.js';
import * as fx from './fixtures.js';

/** Server clock, ms. Fixed: a facade time that moved with the wall clock is not replayable. */
const T0 = EPOCH_MS;
const TICK_MS = 50;

export const PROTOCOL_VERSION = 2;

/**
 * §5.1.0a: policy version 1, derived per phase and never frozen at handoff.
 *
 * `canSpectateEnemies` is false in every phase for all of Alpha. `canUseTeamChat` is the relay
 * rule — false while dead during live play, because a dead player relaying enemy positions over
 * team chat is the cheat the rule exists to stop.
 */
export function spectatorPolicyFor(phase, alive) {
  const relaxed = phase === 'roundEnd' || phase === 'matchEnd' || phase === 'warmup' || phase === 'freeze';
  return {
    canSpectateEnemies: false,
    canFreeCam: relaxed,
    canUseTeamChat: relaxed ? true : alive,
  };
}

/** The `MatchHandoff` a timeline connects with (§3.1). Passed through unmodified, as §3.1 says. */
export function stubHandoff({ mode = 'bomb', matchId = fx.MATCH_ID } = {}) {
  return {
    matchId,
    serverUrl: 'wss://match.stub.invalid/v1/match',
    sessionTicket: stubToken('sessionticket', `facade:${matchId}:${mode}`),
    expiresAt: iso(T0 + 60 * 1000),
    reconnectGraceMs: 90000,
    mapId: 'the-square',
    mapVersion: '1.0.0',
    mode,
    rulesetVersion: mode === 'bomb' ? 'bomb-1.0.0' : 'tdm-1.0.0',
    region: 'yyz',
    serverBuild: fx.SERVER_BUILD,
    protocolVersion: PROTOCOL_VERSION,
    series: mode === 'bomb'
      ? { roundsToWin: 7, maxRounds: 12, sideSwitchAfter: 6, overtime: false }
      : null,
    sites: mode === 'bomb' ? fx.matchHandoff(matchId, { plus: () => iso(T0), now: () => iso(T0) }).sites : null,
    spectatorPolicyVersion: 1,
  };
}

const LOCAL_ENTITY_ID = 7;
const ENEMY_ENTITY_ID = 11;

/** The §5.1 object at rest, before any timeline step. */
function baseMatchState(handoff) {
  return {
    version: 1,
    matchId: handoff.matchId,
    serverNow: T0,
    sampledAt: T0,
    mode: handoff.mode,
    mapId: handoff.mapId,
    mapVersion: handoff.mapVersion,
    rulesetVersion: handoff.rulesetVersion,
    region: handoff.region,
    serverBuild: handoff.serverBuild,
    protocolVersion: handoff.protocolVersion,
    phase: 'warmup',
    phaseEndsAt: null,
    teams: {
      alpha: { score: 0, alive: null, role: handoff.mode === 'bomb' ? 'attacker' : null },
      bravo: { score: 0, alive: null, role: handoff.mode === 'bomb' ? 'defender' : null },
    },
    killLimit: handoff.mode === 'tdm' ? 75 : null,
    series: handoff.series ? { ...handoff.series, sideSwitched: false } : null,
    round: handoff.mode === 'bomb' ? { index: 0, endsAt: null } : null,
    bomb: handoff.mode === 'bomb'
      ? { state: 'none', carrierId: null, siteId: null, position: null }
      : null,
    interaction: handoff.mode === 'bomb' ? { kind: 'none', actorId: null, progress: 0 } : null,
    sites: handoff.sites,
    localPlayer: {
      entityId: LOCAL_ENTITY_ID,
      team: 'alpha',
      role: handoff.mode === 'bomb' ? 'attacker' : null,
      alive: true,
      isSpectating: false,
      spectatingId: null,
      spectatorPolicy: spectatorPolicyFor('warmup', true),
    },
  };
}

/** §5.2. Measured values with their window attached, reported as measured — never smoothed. */
function baseNetStats(handoff) {
  return {
    sampledAt: T0,
    windowMs: 5000,
    region: handoff.region,
    serverBuild: handoff.serverBuild,
    protocolVersion: handoff.protocolVersion,
    rttMs: 24,
    jitterMs: 3,
    lossPct: 0,
    correctionRatePerSec: 0.2,
    correctionMagnitudeM: 0.04,
    snapshotAgeMs: 55,
    receiveRateHz: 20,
    baselineState: 'synced',
    keyframes: 1,
    discarded: 0,
  };
}

// ── step builders ───────────────────────────────────────────────────────────────────────────
//
// A step is `{ label, state?, patch?, stats?, reconnect?, events: [] }`. `patch` is a deep-ish
// merge into `matchState`; anything a step does not name keeps its value, which is what makes a
// timeline readable as a list of differences rather than a list of full snapshots.

const step = (label, spec = {}) => ({ label, events: [], ...spec });

/** A phase transition, with the spectator policy re-derived rather than carried forward. */
const phase = (name, { endsIn = null, alive = true, extra = {} } = {}) => step(`phase:${name}`, {
  patch: {
    phase: name,
    phaseEndsAt: endsIn === null ? null : T0 + endsIn,
    localPlayer: { alive, spectatorPolicy: spectatorPolicyFor(name, alive) },
    ...extra,
  },
  events: [{ type: 'matchState' }],
});

/**
 * A bomb transition. §5.1: `position` is null while `carried` — a carried bomb's location is
 * the carrier's — and null whenever the server did not send one, which is the hidden case.
 */
const bomb = (state, { carrierId = null, siteId = null, position = null, actorId = null } = {}) =>
  step(`bomb:${state}${position ? ':visible' : ''}`, {
    patch: { bomb: { state, carrierId, siteId, position: state === 'carried' ? null : position } },
    events: [{ type: 'bombStateChanged', payload: { to: state, actorId, siteId } }],
  });

const connState = (to, reason = null) => step(`state:${to}`, {
  state: to,
  events: [{ type: 'stateChange', payload: { to, reason } }],
});

const SITE_A_POS = { x: -12, y: 0, z: 8 };

/**
 * The match-result.md §4.2 outcome matrix, as `matchEnded` payloads.
 *
 * `winner: null` and `'draw'` are different facts (§5.3): a draw is a result, no winner is the
 * absence of one, and an aborted forfeit keeps a real winner.
 */
const OUTCOMES = {
  'completed-elimination': { status: 'completed', outcomeReason: 'elimination', winner: 'alpha' },
  'completed-defuse': { status: 'completed', outcomeReason: 'defuse', winner: 'alpha' },
  'completed-detonation': { status: 'completed', outcomeReason: 'detonation', winner: 'bravo' },
  'completed-timer-draw': { status: 'completed', outcomeReason: 'timer', winner: 'draw' },
  'aborted-forfeit': { status: 'aborted', outcomeReason: 'forfeit', winner: 'alpha' },
  'aborted-abandon': { status: 'aborted', outcomeReason: 'abandon', winner: 'bravo' },
  'aborted-nocontest': { status: 'aborted', outcomeReason: 'no-contest', winner: null },
  'invalidated': { status: 'invalidated', outcomeReason: 'no-contest', winner: null },
};

const matchEnd = (key, { scoreAlpha = 7, scoreBravo = 5, roundsPlayed = 12 } = {}) => {
  const o = OUTCOMES[key];
  return step(`outcome:${key}`, {
    patch: { phase: 'matchEnd', phaseEndsAt: null,
      localPlayer: { spectatorPolicy: spectatorPolicyFor('matchEnd', true) } },
    events: [{
      type: 'matchEnded',
      payload: {
        matchId: fx.MATCH_ID,
        winner: o.winner,
        outcomeReason: o.outcomeReason,
        terminationReason: o.status,
        scoreAlpha, scoreBravo, roundsPlayed,
      },
    }],
  });
};

const welcome = (handoff) => step('welcome', {
  state: 'live',
  events: [{
    type: 'welcome',
    payload: {
      clientId: 3,
      entityId: LOCAL_ENTITY_ID,
      matchSeed: 0x5EED,
      killLimit: handoff.mode === 'tdm' ? 75 : null,
      mode: handoff.mode,
      isReconnect: false,
      isSpectator: false,
      protocolVersion: handoff.protocolVersion,
      serverTickRateHz: 20,
    },
  }, { type: 'stateChange', payload: { to: 'live', reason: null } }],
});

// ── the timelines ───────────────────────────────────────────────────────────────────────────

function bombRound(handoff) {
  return [
    connState('connecting'),
    welcome(handoff),
    phase('freeze', { endsIn: 8000 }),
    phase('live', { endsIn: 105000 }),
    // The full visibility matrix, in the order a round produces it (§5.1, §5.1.1).
    bomb('carried', { carrierId: LOCAL_ENTITY_ID }),
    bomb('dropped', { position: SITE_A_POS }),
    bomb('dropped'),                                   // hidden: no position, no carrier
    bomb('carried', { carrierId: null }),              // carried by someone you cannot see
    step('interaction:plant', {
      patch: { interaction: { kind: 'plant', actorId: LOCAL_ENTITY_ID, progress: 0.5 } },
      events: [{ type: 'matchState' }],
    }),
    bomb('planted', { siteId: 'A', position: SITE_A_POS, actorId: LOCAL_ENTITY_ID }),
    phase('planted', { endsIn: 40000, extra: { interaction: { kind: 'none', actorId: null, progress: 0 } } }),
    step('interaction:refused', {
      events: [{ type: 'interactionRefused', payload: { kind: 'defuse', reason: 'not-carrier' } }],
    }),
    bomb('defused', { siteId: 'A', actorId: ENEMY_ENTITY_ID }),
    step('round:end', {
      patch: { phase: 'roundEnd', phaseEndsAt: null, teams: { bravo: { score: 1 } },
        localPlayer: { spectatorPolicy: spectatorPolicyFor('roundEnd', true) } },
      events: [{ type: 'roundEnded',
        payload: { roundIndex: 0, winner: 'bravo', reason: 'defuse', scoreAlpha: 0, scoreBravo: 1, actorId: ENEMY_ENTITY_ID } }],
    }),
    matchEnd('completed-defuse', { scoreAlpha: 5, scoreBravo: 7 }),
    connState('closed', 'match-ended'),
  ];
}

function tdmBasic(handoff) {
  return [
    connState('connecting'),
    welcome(handoff),
    phase('live', { endsIn: 600000 }),
    step('score', { patch: { teams: { alpha: { score: 41 }, bravo: { score: 38 } } }, events: [{ type: 'matchState' }] }),
    matchEnd('completed-elimination', { scoreAlpha: 75, scoreBravo: 61, roundsPlayed: 0 }),
    connState('closed', 'match-ended'),
  ];
}

/** Degraded links. The numbers move; nothing else does — that is the point of the scenario. */
function degraded(handoff, stats) {
  return [
    connState('connecting'),
    welcome(handoff),
    phase('live', { endsIn: 105000 }),
    step('degrade', { stats, events: [{ type: 'matchState' }] }),
  ];
}

/**
 * §5.4: `net.reconnect` stays null until the first `reconnectUpdate`, because the deadline comes
 * from the reconnect-ticket response and a dropped socket carries nothing. A UI that counted
 * down before then would be counting a number it invented.
 */
function reconnectFlow(handoff, { succeeds }) {
  const drop = [
    connState('connecting'),
    welcome(handoff),
    phase('live', { endsIn: 105000 }),
    step('drop', {
      state: 'reconnecting',
      events: [
        { type: 'disconnected', payload: { reason: 'socket-closed', code: 1006, retryable: true, graceEndsAt: null } },
        { type: 'stateChange', payload: { to: 'reconnecting', reason: 'socket-closed' } },
      ],
    }),
    step('ticket', {
      reconnect: { graceEndsAt: T0 + 90000, attempt: 1, maxAttempts: 5, canCancel: true },
      events: [{ type: 'reconnectUpdate', payload: { graceEndsAt: T0 + 90000, attempt: 1, maxAttempts: 5, canCancel: true } }],
    }),
  ];
  if (succeeds) {
    return [...drop,
      step('resumed', {
        state: 'live',
        reconnect: null,
        events: [{ type: 'stateChange', payload: { to: 'live', reason: 'reconnected' } }],
      }),
    ];
  }
  // Five attempts, then the grace window closes and the seat is gone (§5.4 retry policy).
  const attempts = [2, 3, 4, 5].map((attempt) => step(`attempt:${attempt}`, {
    reconnect: { graceEndsAt: T0 + 90000, attempt, maxAttempts: 5, canCancel: true },
    events: [{ type: 'reconnectUpdate', payload: { graceEndsAt: T0 + 90000, attempt, maxAttempts: 5, canCancel: true } }],
  }));
  return [...drop, ...attempts,
    step('exhausted', {
      state: 'closed',
      reconnect: null,
      events: [
        { type: 'disconnected', payload: { reason: 'RECONNECT_GRACE_EXPIRED', code: 4009, retryable: false, graceEndsAt: null } },
        { type: 'stateChange', payload: { to: 'closed', reason: 'RECONNECT_GRACE_EXPIRED' } },
      ],
    }),
  ];
}

/** §3.2: version-mismatch is terminal. Retrying cannot succeed, so nothing here retries. */
function versionMismatch() {
  return [
    connState('connecting'),
    step('mismatch', {
      state: 'version-mismatch',
      events: [
        { type: 'versionMismatch', payload: { clientVersion: PROTOCOL_VERSION, serverVersion: PROTOCOL_VERSION + 1 } },
        { type: 'stateChange', payload: { to: 'version-mismatch', reason: 'PROTOCOL_VERSION_MISMATCH' } },
      ],
    }),
  ];
}

function rejected() {
  return [
    connState('connecting'),
    step('rejected', {
      state: 'rejected',
      events: [
        { type: 'disconnected', payload: { reason: 'SESSION_TOKEN_INVALID', code: 4001, retryable: false, graceEndsAt: null } },
        { type: 'stateChange', payload: { to: 'rejected', reason: 'SESSION_TOKEN_INVALID' } },
      ],
    }),
  ];
}

/** One timeline per §5.1.0a row, so the HUD can prove it hides a control the server refuses. */
function spectatorPolicyPhases(handoff) {
  return [
    connState('connecting'),
    welcome(handoff),
    phase('warmup', { endsIn: 30000 }),
    phase('freeze', { endsIn: 8000 }),
    phase('live', { endsIn: 105000 }),
    phase('live', { endsIn: 90000, alive: false }),      // dead in live: no free cam, no team chat
    phase('planted', { endsIn: 40000, alive: false }),
    phase('roundEnd', { alive: false }),                 // dead at round end: both allowed again
    phase('matchEnd', { alive: false }),
  ];
}

const bombOnly = (handoff, steps) => [connState('connecting'), welcome(handoff),
  phase('live', { endsIn: 105000 }), ...steps];

export const NET_FACADE_SCENARIOS = {
  // ── the eight §8 names ────────────────────────────────────────────────────────────────────
  'tdm-basic': { mode: 'tdm', build: tdmBasic },
  'bomb-round': { mode: 'bomb', build: bombRound },
  'high-latency': { mode: 'bomb', build: (h) => degraded(h, { rttMs: 240, jitterMs: 38, snapshotAgeMs: 310, receiveRateHz: 19 }) },
  'packet-loss': { mode: 'bomb', build: (h) => degraded(h, { lossPct: 12.5, discarded: 34, baselineState: 'keyframe-pending', correctionRatePerSec: 4.1, correctionMagnitudeM: 0.62 }) },
  'reconnect-success': { mode: 'bomb', build: (h) => reconnectFlow(h, { succeeds: true }) },
  'reconnect-timeout': { mode: 'bomb', build: (h) => reconnectFlow(h, { succeeds: false }) },
  'version-mismatch': { mode: 'bomb', build: versionMismatch },
  'rejected': { mode: 'bomb', build: rejected },

  // ── the rows §8 does not name ─────────────────────────────────────────────────────────────
  'bomb-carried': { mode: 'bomb', build: (h) => bombOnly(h, [bomb('carried', { carrierId: LOCAL_ENTITY_ID })]) },
  'bomb-dropped-visible': { mode: 'bomb', build: (h) => bombOnly(h, [bomb('dropped', { position: SITE_A_POS })]) },
  'bomb-dropped-hidden': { mode: 'bomb', build: (h) => bombOnly(h, [bomb('dropped')]) },
  'bomb-planted': { mode: 'bomb', build: (h) => bombOnly(h, [bomb('planted', { siteId: 'A', position: SITE_A_POS, actorId: LOCAL_ENTITY_ID })]) },
  'spectator-policy-phases': { mode: 'bomb', build: spectatorPolicyPhases },
  ...Object.fromEntries(Object.keys(OUTCOMES).map((key) => [`outcome-${key}`, {
    mode: key.startsWith('completed-elimination') ? 'tdm' : 'bomb',
    build: (h) => [connState('connecting'), welcome(h), phase('live', { endsIn: 105000 }), matchEnd(key),
      connState('closed', 'match-ended')],
  }])),
};

/**
 * Timelines this stub serves that `net-facade.md` §8 does not name.
 *
 * Empty, and that is the point. It used to hold thirteen entries — every Bomb-position and
 * outcome-matrix timeline — because the implementation was allowed to run ahead of the contract
 * so long as each extra declared the row it served. That exemption is how §8 came to be cited,
 * in two request responses, for rows it did not contain. §8 now names all 21 timelines.
 *
 * Add an entry only for a genuinely new timeline shipped ahead of its amendment, and delete it
 * in the commit that amends §8: `stubtest.mjs` fails on an undeclared extra AND on a stale
 * declaration, so this cannot quietly become a permanent exemption list again.
 */
export const NET_FACADE_EXTRA = {};

export const NET_FACADE_SCENARIO_NAMES = Object.keys(NET_FACADE_SCENARIOS);

/** Deep merge for `patch`: objects recurse, everything else replaces. */
function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      merge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/**
 * Build the facade stub.
 *
 * The returned object is the §5 read surface plus the drive controls. It is deliberately NOT the
 * real facade: it implements the same shape so a HUD written against it compiles against the
 * real one, and it holds no socket so a test can walk a whole match in microseconds.
 */
export function createNetFacadeStub({ scenario = 'bomb-round' } = {}) {
  const spec = NET_FACADE_SCENARIOS[scenario];
  if (!spec) throw new Error(`net.facade.stub: unknown scenario ${scenario}`);
  const handoff = stubHandoff({ mode: spec.mode });
  const steps = spec.build(handoff);

  let index = -1;
  const listeners = new Map();
  const emitted = [];
  /** Intents the UI expressed. Recorded, never acted on — §2. */
  const intents = [];

  const api = {
    scenario,
    handoff,
    state: 'idle',
    matchState: baseMatchState(handoff),
    netStats: baseNetStats(handoff),
    reconnect: null,
    // The predicted local entity is the ONLY predicted value on this surface (§5).
    localEntity: { id: LOCAL_ENTITY_ID, x: 0, y: 0, z: 0, yaw: 0, predicted: true },
    remoteEntities: new Map([[ENEMY_ENTITY_ID, { id: ENEMY_ENTITY_ID, x: 4, y: 0, z: -3, yaw: 3.14, interpolated: true }]]),

    /** §3: the handoff is stored whole and unmodified. */
    async connect(given = handoff) {
      api.handoff = given;
      api.matchState = { ...baseMatchState(given), matchId: given.matchId };
      api.state = 'connecting';
      return api;
    },
    disconnect(reason = 'user') {
      api.state = 'closed';
      emit('stateChange', { to: 'closed', reason });
    },
    sendLoadout(loadout) { intents.push({ kind: 'loadout', loadout }); },
    /**
     * §4: this asks. It returns nothing and changes nothing — the interaction becomes true when
     * a scripted step says the server said so.
     */
    requestInteraction(kind) { intents.push({ kind: 'interaction', interaction: kind }); },

    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type).delete(fn);
    },

    // ── drive controls ────────────────────────────────────────────────────────────────────
    steps: () => steps.map((s) => s.label),
    intents: () => intents.map((i) => ({ ...i })),
    events: () => emitted.map((e) => ({ ...e })),
    /** Apply the next step. Returns its label, or null at the end of the timeline. */
    next() {
      if (index + 1 >= steps.length) return null;
      index++;
      const s = steps[index];
      if (s.state) api.state = s.state;
      if (s.patch) merge(api.matchState, s.patch);
      if (s.stats) Object.assign(api.netStats, s.stats);
      if (Object.hasOwn(s, 'reconnect')) api.reconnect = s.reconnect;
      // The sample advances with the timeline so `serverNow`/`sampledAt` are a real pair rather
      // than two copies of one constant — the §5.1.0 subtraction is then exercisable.
      api.matchState.serverNow = T0 + (index + 1) * TICK_MS;
      api.matchState.sampledAt = T0 + (index + 1) * TICK_MS;
      for (const ev of s.events) emit(ev.type, ev.payload ?? snapshot());
      return s.label;
    },
    runAll() { while (api.next() !== null) { /* walk it */ } return api; },
    reset() {
      index = -1;
      api.state = 'idle';
      api.matchState = baseMatchState(handoff);
      api.netStats = baseNetStats(handoff);
      api.reconnect = null;
      emitted.length = 0;
      intents.length = 0;
      return api;
    },
  };

  function snapshot() { return JSON.parse(JSON.stringify(api.matchState)); }

  function emit(type, payload) {
    emitted.push({ type, payload });
    for (const fn of listeners.get(type) || []) {
      // §6: a throwing handler is caught and unsubscribed. The netcode does not stop because a
      // HUD widget has a bug.
      try { fn(payload); } catch { listeners.get(type).delete(fn); }
    }
  }

  return api;
}

export { OUTCOMES as NET_FACADE_OUTCOMES, LOCAL_ENTITY_ID, T0 as NET_FACADE_EPOCH_MS };
