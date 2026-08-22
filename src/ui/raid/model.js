/**
 * Pure Extraction-raid presentation projection (P3-09).
 *
 * Consumes a raid-state sample shaped by what `src/game/extraction.js` (extraction-match.md,
 * FROZEN 1.0.0) actually maintains and emits — the §1 participant phase machine, §3's run
 * inventory rows and containers, §4's exits and channel, and that module's own refusal
 * reasons (`wrongPhase`/`unavailable`/`off-sector`/`alreadyOpened`/`noSuchContainer`). It is
 * stateless and server-authoritative:
 *
 *  - It renders server-driven channel progress and never advances its own (§1: "the client
 *    renders server-driven progress and never simulates its own").
 *  - It refuses to reveal sealed-container contents even when a malformed sample carries them
 *    (§3.1: "Contents are never revealed to any client before the container transitions to
 *    `opened`") — dropping them here means a projection bug cannot become an early reveal.
 *  - Exit availability is presentational triage only: the copy always leaves the server as
 *    the authority ("the server validates every tick", §4.1), never "you WILL extract".
 *  - Loss messaging is settlement.md §4's honest matrix: extract-convert or lose-everything,
 *    no protection, no third disposition.
 */

export const RAID_PRESENTATION_VERSION = 1;

export const RUN_PHASE_LABELS = Object.freeze({
  active: 'RAID ACTIVE',
  collapsing: 'RAID COLLAPSING',
  ended: 'RAID ENDED',
});

export const PARTICIPANT_PHASE_LABELS = Object.freeze({
  deploy: 'DEPLOYING',
  raid: 'IN RAID',
  extracting: 'EXTRACTING',
  extracted: 'EXTRACTED',
  dead: 'KILLED IN ACTION',
  aborted: 'RUN ABORTED',
});

/** `extraction.js`'s literal refusal reasons, translated for a player. */
export const REFUSAL_LABELS = Object.freeze({
  wrongPhase: 'NOT AVAILABLE NOW',
  unavailable: 'ALREADY TAKEN',
  'off-sector': 'TOO FAR AWAY',
  alreadyOpened: 'CACHE ALREADY OPEN',
  noSuchContainer: 'NOTHING TO OPEN',
});

export const CUE_CAPTIONS = Object.freeze({
  pickedUp: '[ITEM TAKEN]',
  merged: '[STACK MERGED]',
  dropped: '[ITEM DROPPED]',
  containerOpened: '[CACHE OPENED]',
  exitCompleted: '[EXTRACTION COMPLETE]',
  channelInterrupted: '[EXTRACTION INTERRUPTED — PROGRESS RESET]',
});

/**
 * settlement.md §4, restated as HUD copy. There is deliberately no "protected" variant:
 * the contracts define exactly two run exits (extract-convert, lose-everything) and no
 * protected-item flag, so the warning says so instead of hinting at a mechanic that does
 * not exist — same honesty rule the loadouts screen already follows.
 */
export const LOSS_WARNINGS = Object.freeze({
  atRisk: 'Everything you carry is lost if you die, disconnect, or the raid times out. No item is protected.',
  extracted: 'Extraction complete. Your carried items are frozen for settlement — nothing more can be picked up or dropped.',
  dead: 'You were killed. Every item you carried is lost — nothing is protected in this phase.',
  aborted: 'Your run was aborted. Every item you carried is lost — an abort settles exactly like a death.',
});

const EXIT_STATE_LABELS = Object.freeze({
  available: 'EXIT AVAILABLE',
  'requires-item': 'ITEM REQUIRED',
  'awaiting-squad': 'SQUAD NOT ASSEMBLED',
  'window-pending': 'EXIT NOT OPEN YET',
  'window-closed': 'EXIT CLOSED',
});

const RUN_PHASES = new Set(Object.keys(RUN_PHASE_LABELS));
const PARTICIPANT_PHASES = new Set(Object.keys(PARTICIPANT_PHASE_LABELS));

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp01 = (value) => Math.min(1, Math.max(0, value));

function text(value, fallback = '') {
  return typeof value === 'string' && value.length ? value : fallback;
}

export function formatClock(ms) {
  if (!finite(ms)) return '--:--';
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function itemName(item) {
  return text(item?.name, text(item?.itemId, 'Unknown item').replaceAll('_', ' '));
}

function quantityLabel(item) {
  const quantity = finite(item?.quantity) ? item.quantity : 1;
  return item?.stackable === true ? `×${quantity}` : '';
}

function projectInventory(runState) {
  const rows = Array.isArray(runState.runInventory) ? runState.runInventory : [];
  const items = rows.map((row) => Object.freeze({
    instanceId: text(row?.instanceId, null) ?? null,
    name: itemName(row),
    quantityLabel: quantityLabel(row),
    rarityTier: text(row?.rarityTier, 'common'),
    // extraction.js seeds loadout rows `locked: true` at spawn (§ deployment hand-off) and
    // pickups `locked: false` — the one honest split a player cares about mid-raid.
    source: row?.locked === true ? 'loadout' : 'looted',
  }));
  return Object.freeze({
    count: items.length,
    items: Object.freeze(items),
    // Honest capacity: no carry limit exists in this slice (no contract defines one), so the
    // count is stated and no invented meter or slot cap is rendered.
    capacityLabel: `${items.length} item${items.length === 1 ? '' : 's'} carried — no carry limit in this slice`,
  });
}

function windowState(window, serverNow) {
  if (!window) return null;
  const opensAt = finite(window.opensAt) ? window.opensAt : null;
  const closesAt = finite(window.closesAt) ? window.closesAt : null;
  if (opensAt !== null && serverNow < opensAt) {
    return { state: 'window-pending', detail: `OPENS IN ${formatClock(opensAt - serverNow)}` };
  }
  if (closesAt !== null && serverNow > closesAt) {
    return { state: 'window-closed', detail: 'THIS EXIT HAS CLOSED' };
  }
  if (closesAt !== null) {
    return { state: 'open', detail: `CLOSES IN ${formatClock(closesAt - serverNow)}` };
  }
  return { state: 'open', detail: null };
}

function projectExit(exit, heldItemIds, serverNow) {
  const conditions = exit?.conditions || {};
  const requirements = [];
  let state = 'available';

  const window = windowState(conditions.window, serverNow);
  if (window && window.state !== 'open') {
    state = window.state;
    requirements.push(window.detail);
  } else if (window?.detail) {
    requirements.push(window.detail);
  }

  const requiresItem = conditions.requiresItem || null;
  const itemHeld = requiresItem ? heldItemIds.has(requiresItem.itemId) : true;
  if (requiresItem && !itemHeld) {
    if (state === 'available') state = 'requires-item';
    requirements.push(`NEEDS ${itemName(requiresItem).toUpperCase()}`);
  } else if (requiresItem) {
    requirements.push(`${itemName(requiresItem).toUpperCase()} HELD`);
  }

  const squad = conditions.squad || null;
  if (squad && finite(squad.required) && squad.required > (finite(squad.present) ? squad.present : 0)) {
    if (state === 'available') state = 'awaiting-squad';
    requirements.push(`SQUAD ${squad.present ?? 0}/${squad.required} IN ZONE`);
  } else if (squad && finite(squad.required)) {
    requirements.push(`SQUAD ${squad.present}/${squad.required} IN ZONE`);
  }

  return Object.freeze({
    id: text(exit?.id, 'unknown-exit'),
    label: text(exit?.label, text(exit?.id, 'EXIT').replaceAll('-', ' ').toUpperCase()),
    state,
    stateLabel: EXIT_STATE_LABELS[state],
    requirements: Object.freeze(requirements.filter(Boolean)),
    distanceM: finite(exit?.distanceM) ? exit.distanceM : null,
    durationSeconds: finite(exit?.durationSeconds) ? exit.durationSeconds : null,
  });
}

function projectChannel(participant, exits, binding) {
  const extracting = participant.phase === 'extracting' ? participant.extracting : null;
  if (!extracting) {
    return Object.freeze({
      active: false, exitId: null, exitLabel: null, progress: 0, percent: 0,
      holdLabel: null,
      // §4.1's rule stated up front, so an interrupt is never a surprise.
      resetNote: 'Progress resets to zero if the channel is interrupted — no partial credit.',
    });
  }
  const progress = clamp01(finite(extracting.progress) ? extracting.progress : 0);
  const exit = exits.find((row) => row.id === extracting.exitId) || null;
  return Object.freeze({
    active: true,
    exitId: text(extracting.exitId, null) ?? null,
    exitLabel: exit ? exit.label : text(extracting.exitId, 'EXIT'),
    progress,
    percent: Math.round(progress * 100),
    holdLabel: `HOLD ${binding} TO EXTRACT`,
    resetNote: 'Keep holding and stay in the zone — any interrupt resets progress to zero.',
  });
}

function projectNearby(runState, binding) {
  const nearby = runState.nearby || {};
  const container = nearby.container || null;
  const sealed = container?.state === 'sealed';
  // §3.1 privacy: a sealed container NEVER shows contents, even if a malformed sample carries
  // them. Dropping the rows here means the projection cannot become an early reveal.
  const rows = sealed ? [] : Array.isArray(nearby.items) ? nearby.items : [];
  const items = rows.map((row) => {
    const compare = row?.compare || null;
    return Object.freeze({
      instanceId: text(row?.instanceId, null) ?? null,
      name: itemName(row),
      quantityLabel: quantityLabel(row),
      rarityTier: text(row?.rarityTier, 'common'),
      compareLabel: compare && text(compare.statLabel)
        && finite(compare.heldValue) && finite(compare.candidateValue)
        ? `${compare.statLabel} ${compare.candidateValue} vs ${text(compare.heldName, 'equipped')} ${compare.heldValue}`
          + ` (${compare.candidateValue >= compare.heldValue ? '+' : ''}${compare.candidateValue - compare.heldValue})`
        : null,
    });
  });
  return Object.freeze({
    container: container ? Object.freeze({
      containerId: text(container.containerId, null) ?? null,
      kind: container.kind === 'dropped' ? 'dropped' : 'static',
      tier: finite(container.tier) ? container.tier : null,
      sealed,
      actionLabel: sealed ? `OPEN CACHE — ${binding}` : null,
    }) : null,
    items: Object.freeze(items),
    pickupLabel: items.length ? `TAKE — ${binding}` : null,
  });
}

function eventProjection(typedEvent) {
  if (!typedEvent || typeof typedEvent !== 'object') return { caption: null, status: null };
  if (typedEvent.type === 'lootRefused') {
    return { caption: null, status: REFUSAL_LABELS[typedEvent.reason] || 'ACTION REFUSED' };
  }
  if (typedEvent.type === 'pickedUp') {
    const caption = typedEvent.merged === true ? CUE_CAPTIONS.merged : CUE_CAPTIONS.pickedUp;
    return { caption: { text: caption }, status: null };
  }
  const cue = CUE_CAPTIONS[typedEvent.type];
  return { caption: cue ? { text: cue } : null, status: null };
}

function preferencesProjection(preferences) {
  const scale = finite(preferences?.hudScaleFactor) ? preferences.hudScaleFactor : 1;
  return Object.freeze({
    reduceMotion: preferences?.reduceMotion === true,
    colorVisionPreset: text(preferences?.colorVisionPreset, 'default'),
    hudScaleFactor: Math.min(1.6, Math.max(0.7, scale)),
  });
}

/**
 * Project one raid presentation model from a sample. Throws on a structurally absent sample;
 * reports (never renders around) enum values outside the frozen vocabularies via
 * `ruleViolation`, mirroring the Bomb projection's contract-violation posture.
 */
export function projectRaidPresentation(input) {
  const runState = input?.runState;
  if (!runState || typeof runState !== 'object' || runState.version !== 1) {
    throw new TypeError('A raid state sample v1 is required.');
  }
  const participant = runState.localParticipant || {};
  const violations = [];
  if (!RUN_PHASES.has(runState.phase)) violations.push(`unknown run phase "${runState.phase}"`);
  if (!PARTICIPANT_PHASES.has(participant.phase)) violations.push(`unknown participant phase "${participant.phase}"`);
  const runPhase = RUN_PHASES.has(runState.phase) ? runState.phase : 'ended';
  const participantPhase = PARTICIPANT_PHASES.has(participant.phase) ? participant.phase : 'aborted';

  const serverNow = finite(runState.serverNow) ? runState.serverNow : null;
  const hardTimeoutAt = finite(runState.hardTimeoutAt) ? runState.hardTimeoutAt : null;
  const remainingMs = serverNow !== null && hardTimeoutAt !== null ? hardTimeoutAt - serverNow : null;
  const binding = text(input?.bindings?.interact, 'E');

  const inventory = projectInventory(runState);
  const heldItemIds = new Set((Array.isArray(runState.runInventory) ? runState.runInventory : [])
    .map((row) => row?.itemId).filter(Boolean));
  const exits = (Array.isArray(runState.exits) ? runState.exits : [])
    .map((exit) => projectExit(exit, heldItemIds, serverNow ?? 0));
  const channel = projectChannel({ ...participant, phase: participantPhase }, exits, binding);
  const alive = participantPhase === 'raid' || participantPhase === 'extracting';
  const lossState = participantPhase === 'extracted' ? 'extracted'
    : participantPhase === 'dead' ? 'dead'
      : participantPhase === 'aborted' ? 'aborted' : 'atRisk';
  const { caption, status } = eventProjection(input?.typedEvent);

  return Object.freeze({
    version: RAID_PRESENTATION_VERSION,
    runId: text(runState.runId, null) ?? null,
    phase: runPhase,
    phaseLabel: runPhase === 'collapsing'
      ? 'RAID COLLAPSING — GET TO AN EXIT'
      : RUN_PHASE_LABELS[runPhase],
    clock: Object.freeze({
      text: formatClock(remainingMs),
      status: remainingMs === null ? 'unavailable' : runPhase === 'collapsing' ? 'critical' : 'running',
    }),
    participant: Object.freeze({
      phase: participantPhase,
      label: PARTICIPANT_PHASE_LABELS[participantPhase],
      alive,
    }),
    inventory,
    exits: Object.freeze(exits),
    channel,
    nearby: alive ? projectNearby(runState, binding) : Object.freeze({ container: null, items: Object.freeze([]), pickupLabel: null }),
    lossWarning: Object.freeze({ state: lossState, text: LOSS_WARNINGS[lossState] }),
    caption,
    status,
    ruleViolation: violations.length ? `Contract violation: ${violations.join('; ')}.` : null,
    preferences: preferencesProjection(input?.preferences),
  });
}
