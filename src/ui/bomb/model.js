/**
 * Pure Bomb presentation projection.
 *
 * This module consumes only the frozen `net-facade.md` views and typed events. It never
 * reaches into simulation state, advances server-owned progress, reconstructs a hidden bomb
 * position, or retains a previous projection. Calling it again with a filtered snapshot
 * therefore removes information immediately instead of accidentally creating a spectator
 * wallhack.
 */

export const BOMB_PRESENTATION_VERSION = 1;

export const TEAM_TOKENS = Object.freeze({
  alpha: Object.freeze({ id: 'alpha', label: 'ALPHA', glyph: '⌃', shape: 'up-chevron' }),
  bravo: Object.freeze({ id: 'bravo', label: 'BRAVO', glyph: '═', shape: 'split-bar' }),
});

export const SITE_TOKENS = Object.freeze({
  A: Object.freeze({ id: 'A', label: 'SITE A', glyph: '▲', shape: 'solid-triangle' }),
  B: Object.freeze({ id: 'B', label: 'SITE B', glyph: '▣', shape: 'double-bar-square' }),
});

const PHASE_LABELS = Object.freeze({
  warmup: 'WARMUP',
  freeze: 'ROUND FREEZE',
  live: 'ROUND LIVE',
  planted: 'BOMB PLANTED',
  roundEnd: 'ROUND COMPLETE',
  matchEnd: 'MATCH COMPLETE',
});

const BOMB_LABELS = Object.freeze({
  none: 'BOMB NOT ASSIGNED',
  carried: 'BOMB CARRIED',
  // §13.2/§13.3: `dropped` is the NEUTRAL state — one bomb, contestable by both teams.
  dropped: 'BOMB UP FOR GRABS',
  planted: 'BOMB PLANTED',
  defused: 'BOMB DEFUSED',
  detonated: 'BOMB DETONATED',
});

const BOMB_ICONS = Object.freeze({
  none: 'case-empty',
  carried: 'case-carried',
  dropped: 'case-dropped',
  planted: 'case-planted',
  defused: 'case-defused',
  detonated: 'case-detonated',
});

const OUTCOME_LABELS = Object.freeze({
  elimination: 'TEAM ELIMINATED',
  defuse: 'BOMB DEFUSED',
  detonation: 'TARGET DESTROYED',
  timer: 'TIME EXPIRED',
  forfeit: 'FORFEIT',
  abandon: 'MATCH ABANDONED',
  'no-contest': 'NO CONTEST',
  nocontest: 'NO CONTEST',
});

const REFUSAL_LABELS = Object.freeze({
  0: 'ACTION NOT AVAILABLE',
  1: 'ROUND ALREADY RESOLVED',
  2: 'ENTER A PLANT ZONE',
  3: 'BOMB REQUIRED',
  4: 'BOMB ALREADY PLANTED',
  'not-eligible': 'ACTION NOT AVAILABLE',
  'wrong-phase': 'ROUND ALREADY RESOLVED',
  'outside-volume': 'ENTER A PLANT ZONE',
  'not-carrier': 'BOMB REQUIRED',
  'already-planted': 'BOMB ALREADY PLANTED',
});

const CANCEL_LABELS = Object.freeze({
  0: 'ACTION RELEASED',
  1: 'LEFT OBJECTIVE AREA',
  2: 'ACTOR ELIMINATED',
  3: 'ROUND ENDED',
  released: 'ACTION RELEASED',
  'left-volume': 'LEFT OBJECTIVE AREA',
  died: 'ACTOR ELIMINATED',
  'round-ended': 'ROUND ENDED',
});

const CUE_CAPTIONS = Object.freeze({
  bombAssigned: '[BOMB ASSIGNED]',
  bombDropped: '[BOMB DROPPED]',
  bombPickedUp: '[BOMB PICKED UP]',
  plantStart: '[PLANTING]',
  plantComplete: '[BOMB PLANTED]',
  plantCancel: '[PLANT INTERRUPTED]',
  defuseStart: '[DEFUSING]',
  defuseComplete: '[BOMB DEFUSED]',
  defuseCancel: '[DEFUSE INTERRUPTED]',
  bombDetonated: '[BOMB DETONATED]',
  sideSwitch: '[SIDES SWITCHED]',
  roundWon: '[ROUND WON]',
  roundLost: '[ROUND LOST]',
  roundDraw: '[ROUND DRAW]',
});

const VALID_PHASES = new Set(Object.keys(PHASE_LABELS));
const VALID_BOMB_STATES = new Set(Object.keys(BOMB_LABELS));
const VALID_NET_STATES = new Set([
  'idle', 'connecting', 'live', 'reconnecting', 'closed', 'version-mismatch', 'rejected',
]);

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const integer = (value) => Number.isInteger(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function text(value, fallback = '') {
  return typeof value === 'string' && value.length ? value : fallback;
}

function formatClock(ms) {
  if (!finite(ms)) return '--:--';
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatGrace(ms) {
  if (!finite(ms)) return null;
  return `${Math.max(0, Math.ceil(ms / 1000))} S`;
}

function vector(value) {
  if (!value || !finite(value.x) || !finite(value.y) || !finite(value.z)) return null;
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}

/**
 * bomb-rules §13.1 — this round's home-site assignment, derived from facts already in the
 * frozen facade view: the sorted site letters and `series.sideSwitched`. Before the switch
 * alpha defends the first site; the §2 side switch swaps home sites, not roles.
 *
 * @returns {{ alpha: string|null, bravo: string|null }}
 */
export function homeSitesFor(sites, sideSwitched) {
  const letters = [];
  for (const source of Array.isArray(sites) ? sites : []) {
    const site = source?.site === 'A' || source?.site === 'B' ? source.site : null;
    if (site && !letters.includes(site)) letters.push(site);
  }
  letters.sort();
  if (letters.length !== 2) return Object.freeze({ alpha: null, bravo: null });
  return Object.freeze(sideSwitched
    ? { alpha: letters[1], bravo: letters[0] }
    : { alpha: letters[0], bravo: letters[1] });
}

function teamProjection(id, source = {}, homeSiteId = null) {
  const token = TEAM_TOKENS[id];
  return Object.freeze({
    ...token,
    score: integer(source?.score) && source.score >= 0 ? source.score : null,
    alive: integer(source?.alive) && source.alive >= 0 ? source.alive : null,
    // §13.8: there are no attackers or defenders; the wire serves the role null. The
    // team's identity in symmetric demolition is the site it defends.
    role: null,
    homeSiteId,
    roleLabel: homeSiteId ? `DEFENDS ${homeSiteId}` : 'SITE PENDING',
  });
}

function projectSites(state, markerProjection, localHomeSite = null, localTargetSite = null) {
  if (!Array.isArray(state?.sites)) return Object.freeze([]);
  const markers = new Map();
  if (Array.isArray(markerProjection)) {
    for (const marker of markerProjection) {
      if ((marker?.siteId === 'A' || marker?.siteId === 'B') && !markers.has(marker.siteId)) {
        markers.set(marker.siteId, marker);
      }
    }
  }
  const out = [];
  const seen = new Set();
  for (const source of state.sites) {
    const site = source?.site === 'A' || source?.site === 'B' ? source.site : null;
    const id = text(source?.id);
    const center = vector(source?.center);
    if (!site || !id || !center || seen.has(id)) continue;
    seen.add(id);
    const token = SITE_TOKENS[site];
    const marker = markers.get(site);
    const distanceM = finite(marker?.distanceM) && marker.distanceM >= 0 && marker.distanceM <= 1_000
      ? marker.distanceM : null;
    const direction = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw', 'center'].includes(marker?.direction)
      ? marker.direction : null;
    const screenX = finite(marker?.screenX) && marker.screenX >= 0 && marker.screenX <= 100
      ? marker.screenX : null;
    const screenY = finite(marker?.screenY) && marker.screenY >= 0 && marker.screenY <= 100
      ? marker.screenY : null;
    out.push(Object.freeze({
      ...token,
      id,
      site,
      // §13.10 ownership vocabulary: your HOME site is the one you defend (and defuse
      // at); your TARGET site is the enemy's home, the only one you may plant at.
      ownership: site === localHomeSite ? 'home' : site === localTargetSite ? 'target' : null,
      ownershipLabel: site === localHomeSite ? 'DEFEND' : site === localTargetSite ? 'HIT' : null,
      callout: text(source.callout, token.label),
      center,
      active: state?.bomb?.siteId === site,
      distanceM,
      occluded: marker?.occluded === true,
      offscreen: marker?.offscreen === true,
      direction,
      screenX,
      screenY,
    }));
  }
  return Object.freeze(out);
}

function projectFreshness(stats, freshnessThresholdMs, nowMs, localAuthority) {
  if (localAuthority) {
    return Object.freeze({ status: 'authoritative', snapshotAgeMs: null, staleByMs: null });
  }
  if (!stats || !finite(stats.snapshotAgeMs)) {
    return Object.freeze({ status: 'unknown', snapshotAgeMs: null, staleByMs: null });
  }
  const elapsedSinceMeasurement = finite(stats.sampledAt) ? Math.max(0, nowMs - stats.sampledAt) : 0;
  const effectiveAgeMs = stats.snapshotAgeMs + elapsedSinceMeasurement;
  const staleByMs = Math.max(0, effectiveAgeMs - freshnessThresholdMs);
  return Object.freeze({
    status: staleByMs > 0 ? 'syncing' : effectiveAgeMs > 0 ? 'estimating' : 'authoritative',
    snapshotAgeMs: effectiveAgeMs,
    staleByMs,
  });
}

function projectClock(state, nowMs, freshness) {
  const sampledAt = state?.sampledAt;
  const serverNow = state?.serverNow;
  const phaseEndsAt = state?.phaseEndsAt;
  if (!finite(sampledAt) || !finite(serverNow) || !finite(phaseEndsAt)) {
    return Object.freeze({ visible: false, status: 'unavailable', text: '--:--', remainingMs: null, ageMs: null });
  }

  const ageMs = Math.max(0, nowMs - sampledAt);
  const stale = freshness.status === 'syncing' || freshness.status === 'unknown';
  // `matchState.sampledAt` may be old while ordinary snapshots remain healthy because
  // MSG_MATCHSTATE is sent on change. Freshness therefore comes from measured
  // `netStats.snapshotAgeMs`, not from the age of this state object. Once snapshots are
  // stale, remove the time beyond the contracted cutoff and freeze there.
  // With no measured snapshot age there is no trustworthy basis for advancing the
  // server clock at all. Keep the last authoritative sample frozen until the facade
  // supplies freshness data. A measured stale stream may advance only as far as the
  // contracted freshness cutoff.
  const trustedAgeMs = freshness.status === 'unknown'
    ? 0
    : Math.max(0, ageMs - (freshness.staleByMs || 0));
  const remainingMs = Math.max(0, (phaseEndsAt - serverNow) - trustedAgeMs);
  return Object.freeze({
    visible: true,
    status: stale ? 'syncing' : ageMs > 0 || freshness.status === 'estimating' ? 'estimating' : 'authoritative',
    text: formatClock(remainingMs),
    remainingMs,
    ageMs,
  });
}

function projectBomb(state, localEntityId, localTeam, carrierTeam) {
  const source = state?.bomb;
  const bombState = VALID_BOMB_STATES.has(source?.state) ? source.state : 'none';
  const carrierId = bombState === 'carried' && integer(source?.carrierId) && source.carrierId > 0
    ? source.carrierId
    : null;
  const siteId = source?.siteId === 'A' || source?.siteId === 'B' ? source.siteId : null;
  // Carried position is forbidden even if a malformed or hostile source supplies one.
  const markerPosition = bombState === 'dropped' || bombState === 'planted'
    ? vector(source?.position)
    : null;
  return Object.freeze({
    state: bombState,
    label: BOMB_LABELS[bombState],
    icon: BOMB_ICONS[bombState],
    carrierId,
    carrierVisible: carrierId !== null,
    isLocalCarrier: carrierId !== null && carrierId === localEntityId,
    // §13.10: either team may carry, so the relationship comes from the CARRIER'S team
    // (adapter-supplied `carrierTeam`), not from a role that no longer exists.
    carrierRelationship: carrierId === null ? null
      : carrierId === localEntityId ? 'self'
      : carrierTeam === 'alpha' || carrierTeam === 'bravo'
        ? (carrierTeam === localTeam ? 'teammate' : 'enemy')
        : 'visible',
    siteId,
    markerPosition,
    markerVisible: markerPosition !== null,
  });
}

function bindingLabel(bindings, action) {
  const value = bindings && text(bindings[action]);
  return value || 'UNBOUND';
}

/**
 * The idle "you could act here" prompt: an adapter (`deriveEligibleInteraction`) asserts
 * the local player currently satisfies the referee's §6/§7 preconditions. The projection
 * re-checks every precondition visible in its own inputs so a buggy or hostile adapter
 * value fails closed, and hides the prompt while syncing — a stale snapshot cannot prove
 * present-tense eligibility.
 */
function projectPrompt(eligibleAction, phase, localHomeSite, bomb, bindings, freshnessStatus) {
  const kind = eligibleAction === 'plant' || eligibleAction === 'defuse' ? eligibleAction : null;
  if (!kind) return null;
  if (freshnessStatus === 'syncing' || freshnessStatus === 'unknown') return null;
  // §13.10 context-based gating, not role-based: plant = local player carries the bomb
  // (the adapter asserts they stand in their TARGET site — never their own, §13.4);
  // defuse = the enemy's plant sits at the LOCAL TEAM'S HOME site.
  if (kind === 'plant') {
    if (phase !== 'live') return null;
    if (bomb.state !== 'carried' || !bomb.isLocalCarrier) return null;
  } else {
    if (phase !== 'planted' || bomb.state !== 'planted') return null;
    if (!localHomeSite || bomb.siteId !== localHomeSite) return null;
  }
  return Object.freeze({
    kind,
    actionLabel: kind === 'plant' ? 'PLANT' : 'DEFUSE',
    binding: bindingLabel(bindings, 'interact'),
  });
}

function projectInteraction(state, localEntityId, bindings, typedEvent, freshnessStatus, prompt) {
  const source = state?.interaction;
  const kind = source?.kind === 'plant' || source?.kind === 'defuse' ? source.kind : 'none';
  const actorId = integer(source?.actorId) && source.actorId > 0 ? source.actorId : null;
  const progress = finite(source?.progress) ? clamp(source.progress, 0, 1) : 0;
  const isLocalActor = kind !== 'none' && actorId === localEntityId;

  let status = null;
  if (typedEvent?.type === 'interactionRefused') {
    status = REFUSAL_LABELS[typedEvent.reason] || 'ACTION REFUSED';
  } else if (typedEvent?.type === 'plantCancel' || typedEvent?.type === 'defuseCancel') {
    const prefix = typedEvent.type === 'plantCancel' ? 'PLANT INTERRUPTED' : 'DEFUSE INTERRUPTED';
    const detail = CANCEL_LABELS[typedEvent.reason];
    status = detail ? `${prefix} — ${detail}` : prefix;
  } else if ((freshnessStatus === 'syncing' || freshnessStatus === 'unknown') && isLocalActor) {
    status = 'SYNCING — ACTION PAUSED';
  }

  if (!isLocalActor) {
    return Object.freeze({
      kind, actorId, isLocalActor: false, visible: false, progress: null, percent: null,
      actionLabel: null, stateWord: null, binding: null, status, prompt,
    });
  }

  const actionLabel = kind === 'plant'
    ? `PLANT${state?.bomb?.siteId ? ` — SITE ${state.bomb.siteId}` : ''}`
    : 'DEFUSE';
  const baseStateWord = kind === 'plant' ? 'PLANTING' : 'DEFUSING';
  const stateWord = freshnessStatus === 'syncing' || freshnessStatus === 'unknown'
    ? 'PAUSED — SYNCING'
    : freshnessStatus === 'estimating' ? `${baseStateWord} — ESTIMATING` : baseStateWord;
  return Object.freeze({
    kind,
    actorId,
    isLocalActor: true,
    visible: true,
    progress,
    percent: Math.round(progress * 100),
    actionLabel,
    stateWord,
    binding: bindingLabel(bindings, 'interact'),
    status,
    // While channeling, the progress presentation owns the space; the idle prompt yields.
    prompt: null,
  });
}

function projectSpectator(state, bindings) {
  const local = state?.localPlayer || {};
  const active = local.alive === false || local.isSpectating === true;
  if (!active) return Object.freeze({ active: false });
  const policy = local.spectatorPolicy || {};
  const targetId = integer(local.spectatingId) && local.spectatingId > 0 ? local.spectatingId : null;
  return Object.freeze({
    active: true,
    targetId,
    targetLabel: targetId === null ? 'NO ELIGIBLE TARGET' : 'TEAM TARGET SELECTED',
    canCycle: targetId !== null,
    previousBinding: bindingLabel(bindings, 'spectatePrevious'),
    nextBinding: bindingLabel(bindings, 'spectateNext'),
    canSpectateEnemies: policy.canSpectateEnemies === true,
    canFreeCam: policy.canFreeCam === true,
    canUseTeamChat: policy.canUseTeamChat === true,
    chatLabel: policy.canUseTeamChat === true ? 'TEAM CHAT AVAILABLE' : 'TEAM CHAT HELD UNTIL FREEZE',
  });
}

function projectNetStats(stats) {
  if (!stats || !finite(stats.sampledAt) || !finite(stats.windowMs) || stats.windowMs <= 0) return null;
  const number = (key, min, max) => finite(stats[key]) && stats[key] >= min && stats[key] <= max
    ? stats[key]
    : null;
  const baselineState = ['synced', 'keyframe-pending', 'lost'].includes(stats.baselineState)
    ? stats.baselineState
    : null;
  return Object.freeze({
    sampledAt: stats.sampledAt,
    windowMs: stats.windowMs,
    rttMs: number('rttMs', 0, 10000),
    jitterMs: number('jitterMs', 0, 10000),
    lossPct: number('lossPct', 0, 100),
    snapshotAgeMs: number('snapshotAgeMs', 0, 60000),
    receiveRateHz: number('receiveRateHz', 0, 1000),
    baselineState,
  });
}

function projectConnection(netState, reconnect, nowMs, syncing, stats, localAuthority) {
  if (localAuthority) {
    return Object.freeze({ state: 'local', label: 'LOCAL PRACTICE', overlay: null, stats: null });
  }
  const state = VALID_NET_STATES.has(netState) ? netState : 'idle';
  let label = state === 'live' ? (syncing ? 'SYNCING' : 'CONNECTED') : state.toUpperCase().replace('-', ' ');
  let overlay = null;
  if (state === 'reconnecting') {
    const graceMs = finite(reconnect?.graceEndsAt) ? Math.max(0, reconnect.graceEndsAt - nowMs) : null;
    const expired = graceMs === 0;
    label = expired ? 'RECONNECT GRACE EXPIRED' : 'RECONNECTING';
    overlay = Object.freeze({
      kind: expired ? 'grace-expired' : 'reconnecting',
      title: expired ? 'RECONNECT GRACE EXPIRED' : 'RECONNECTING',
      graceMs,
      graceLabel: formatGrace(graceMs),
      attempt: integer(reconnect?.attempt) && reconnect.attempt >= 0 ? reconnect.attempt : null,
      maxAttempts: integer(reconnect?.maxAttempts) && reconnect.maxAttempts >= 0 ? reconnect.maxAttempts : null,
      canCancel: reconnect?.canCancel === true,
    });
  } else if (state === 'version-mismatch') {
    overlay = Object.freeze({ kind: 'version-mismatch', title: 'UPDATE REQUIRED', canCancel: false });
  } else if (state === 'rejected') {
    overlay = Object.freeze({ kind: 'rejected', title: 'MATCH CONNECTION REFUSED', canCancel: false });
  } else if (state === 'closed') {
    overlay = Object.freeze({ kind: 'closed', title: 'MATCH CONNECTION CLOSED', canCancel: false });
  } else if (state === 'connecting') {
    overlay = Object.freeze({ kind: 'connecting', title: 'CONNECTING TO MATCH', canCancel: true });
  }
  return Object.freeze({ state, label, overlay, stats });
}

function projectOutcome(event, localTeam) {
  if (!event || (event.type !== 'roundEnded' && event.type !== 'matchEnded')) return null;
  const winner = ['alpha', 'bravo', 'draw'].includes(event.winner) ? event.winner : null;
  let result = 'ROUND COMPLETE';
  if (winner === 'draw') result = event.type === 'matchEnded' ? 'MATCH DRAW' : 'ROUND DRAW';
  else if (winner && localTeam === winner) result = event.type === 'matchEnded' ? 'MATCH WON' : 'ROUND WON';
  else if (winner) result = event.type === 'matchEnded' ? 'MATCH LOST' : 'ROUND LOST';
  else if (event.type === 'matchEnded') result = 'MATCH ABORTED';
  const reason = event.type === 'matchEnded' ? event.outcomeReason : event.reason;
  return Object.freeze({
    scope: event.type === 'matchEnded' ? 'match' : 'round',
    result,
    reason: OUTCOME_LABELS[reason] || 'SERVER OUTCOME',
    winner,
  });
}

function projectCaption(cue) {
  if (!cue || typeof cue.type !== 'string') return null;
  const caption = CUE_CAPTIONS[cue.type];
  return caption ? Object.freeze({ type: cue.type, text: caption }) : null;
}

function projectPreferences(preferences) {
  const hudScale = finite(preferences?.hudScale) ? clamp(preferences.hudScale, 70, 160) : 100;
  const colorVisionPreset = ['default', 'deuteranopia', 'protanopia', 'tritanopia'].includes(preferences?.colorVisionPreset)
    ? preferences.colorVisionPreset
    : 'default';
  return Object.freeze({
    hudScale,
    hudScaleFactor: hudScale / 100,
    reduceMotion: preferences?.reduceMotion === true,
    colorVisionPreset,
  });
}

/**
 * Project one live net-facade sample into a complete, immutable HUD model.
 *
 * `freshnessThresholdMs` is deliberately required. The frozen facade exposes measured age
 * but does not currently choose the product threshold at which presentation must freeze;
 * silently inventing one here would turn presentation policy into an undocumented contract.
 */
export function projectBombPresentation({
  matchState,
  netState = 'idle',
  netStats = null,
  reconnect = null,
  nowMs,
  freshnessThresholdMs,
  bindings = {},
  typedEvent = null,
  outcomeEvent = null,
  cue = null,
  preferences = null,
  siteMarkers = null,
  localAuthority = false,
  eligibleAction = null,
  carrierTeam = null,
} = {}) {
  if (!finite(nowMs)) throw new TypeError('nowMs must be a finite client-monotonic timestamp.');
  if (!localAuthority && (!finite(freshnessThresholdMs) || freshnessThresholdMs <= 0)) {
    throw new TypeError('freshnessThresholdMs must be a positive contracted value.');
  }
  const state = matchState && typeof matchState === 'object' ? matchState : {};
  const phaseValid = VALID_PHASES.has(state.phase);
  const phase = phaseValid ? state.phase : 'warmup';
  const local = state.localPlayer && typeof state.localPlayer === 'object' ? state.localPlayer : {};
  const localEntityId = integer(local.entityId) && local.entityId > 0 ? local.entityId : null;
  const localTeam = local.team === 'alpha' || local.team === 'bravo' ? local.team : 'unassigned';
  const stats = projectNetStats(netStats);
  const freshness = projectFreshness(stats, freshnessThresholdMs, nowMs, localAuthority);
  const clock = projectClock(state, nowMs, freshness);
  const syncing = freshness.status === 'syncing' || freshness.status === 'unknown';
  const series = state.series && typeof state.series === 'object' ? Object.freeze({
    roundsToWin: integer(state.series.roundsToWin) ? state.series.roundsToWin : null,
    maxRounds: integer(state.series.maxRounds) ? state.series.maxRounds : null,
    sideSwitchAfter: integer(state.series.sideSwitchAfter) ? state.series.sideSwitchAfter : null,
    sideSwitched: state.series.sideSwitched === true,
    // Alpha has no approved overtime. Surface a contract violation instead of inventing UI.
    overtime: state.series.overtime === true,
  }) : null;
  const teamsValid = ['alpha', 'bravo'].every((id) => integer(state.teams?.[id]?.score)
    && state.teams[id].score >= 0);
  const ruleViolation = state.mode !== 'bomb'
    ? 'BOMB HUD RECEIVED A NON-BOMB MATCH'
    : !phaseValid ? 'UNRECOGNIZED BOMB PHASE'
    : series?.overtime === true ? 'UNAPPROVED OVERTIME STATE'
    : !teamsValid ? 'INVALID OR MISSING BOMB SCORE' : null;

  // §13.1: home-site ownership, derived from the sorted site letters + the side switch —
  // the same facts every other consumer derives it from. No role field is consulted.
  const homeSites = homeSitesFor(state.sites, series?.sideSwitched === true);
  const teams = Object.freeze([
    teamProjection('alpha', state.teams?.alpha, homeSites.alpha),
    teamProjection('bravo', state.teams?.bravo, homeSites.bravo),
  ]);
  const localHomeSite = localTeam === 'alpha' || localTeam === 'bravo' ? homeSites[localTeam] : null;
  const localTargetSite = localTeam === 'alpha' ? homeSites.bravo
    : localTeam === 'bravo' ? homeSites.alpha : null;
  const bomb = projectBomb(state, localEntityId, localTeam, carrierTeam);
  const prompt = projectPrompt(eligibleAction, phase, localHomeSite, bomb, bindings, freshness.status);
  const interaction = projectInteraction(state, localEntityId, bindings, typedEvent, freshness.status, prompt);
  const spectator = projectSpectator(state, bindings);
  const connection = projectConnection(netState, reconnect, nowMs, syncing, stats, localAuthority);
  const outcome = projectOutcome(outcomeEvent, localTeam);
  const caption = projectCaption(cue);
  const roundIndex = integer(state.round?.index) && state.round.index >= 0 ? state.round.index : null;

  return Object.freeze({
    version: BOMB_PRESENTATION_VERSION,
    matchId: text(state.matchId, null),
    mode: state.mode === 'bomb' ? 'bomb' : null,
    mapId: text(state.mapId, null),
    mapVersion: text(state.mapVersion, null),
    rulesetVersion: text(state.rulesetVersion, null),
    phase,
    phaseLabel: PHASE_LABELS[phase],
    ruleViolation,
    roundIndex,
    roundLabel: roundIndex === null ? 'ROUND —' : `ROUND ${roundIndex + 1}`,
    series,
    teams,
    localTeam,
    // §13.8: the wire serves role null; the HUD speaks home/target sites instead.
    localRole: null,
    homeSites,
    localHomeSite,
    localTargetSite,
    // e.g. "DEFEND B / HIT A" (§13.10) — the replacement for the old role label.
    siteLabel: localHomeSite && localTargetSite
      ? `DEFEND ${localHomeSite} / HIT ${localTargetSite}` : 'SITES PENDING',
    clock,
    freshness,
    // Marker geometry is supplied by an authorized world/camera adapter. The presentation
    // never derives LOS or reconstructs hidden positions from entities or prior samples.
    sites: projectSites(state, siteMarkers, localHomeSite, localTargetSite),
    bomb,
    interaction,
    spectator,
    connection,
    outcome,
    caption,
    preferences: projectPreferences(preferences),
  });
}
