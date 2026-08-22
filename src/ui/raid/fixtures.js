/**
 * Deterministic raid-HUD fixtures. Values mirror the shipped P3-11 content
 * (`src/game/extractionContent.js`): the item-gated transit exit wants a `keycard_transit`,
 * the market van is window-gated, and inventory names come from that catalog's item ids.
 */
const SERVER_NOW = 3_000_000;

const inventoryRow = (itemId, name, overrides = {}) => ({
  instanceId: `run-${itemId}`,
  itemId,
  name,
  quantity: 1,
  stackable: false,
  rarityTier: 'common',
  slot: null,
  locked: false,
  ...overrides,
});

const BASE_INVENTORY = Object.freeze([
  inventoryRow('rifle_ak74', 'AK-74', { rarityTier: 'rare', slot: 'primary', locked: true }),
  inventoryRow('vest_light', 'Light vest', { slot: 'vest', locked: true }),
  inventoryRow('ammo_9mm', '9mm rounds', { quantity: 45, stackable: true }),
  inventoryRow('bandage_wrap', 'Bandage wrap', { quantity: 2, stackable: true }),
]);

const BASE_EXITS = Object.freeze([
  {
    id: 'exit-transit-gate',
    label: 'TRANSIT GATE',
    distanceM: 62,
    durationSeconds: 8,
    conditions: { requiresItem: { itemId: 'keycard_transit', name: 'Transit keycard' } },
  },
  {
    id: 'exit-market-van',
    label: 'MARKET VAN',
    distanceM: 34,
    durationSeconds: 12,
    conditions: { window: { opensAt: SERVER_NOW - 60_000, closesAt: SERVER_NOW + 300_000 } },
  },
]);

export function baseRaidState(overrides = {}) {
  const state = {
    version: 1,
    runId: '01J8X2K9P3QW7V000000000EX1',
    phase: 'active',
    serverNow: SERVER_NOW,
    sampledAt: SERVER_NOW,
    hardTimeoutAt: SERVER_NOW + 540_000,
    localParticipant: { accountId: 'acct-local', phase: 'raid', outcome: null, extracting: null },
    runInventory: [...BASE_INVENTORY],
    exits: BASE_EXITS.map((exit) => ({ ...exit, conditions: { ...exit.conditions } })),
    nearby: { container: null, items: [] },
  };
  const merged = { ...state, ...overrides };
  if (overrides.localParticipant) {
    merged.localParticipant = { ...state.localParticipant, ...overrides.localParticipant };
  }
  if (overrides.nearby) merged.nearby = { ...state.nearby, ...overrides.nearby };
  return merged;
}

const input = (runState, extra = {}) => ({
  runState,
  nowMs: SERVER_NOW,
  bindings: { interact: 'E' },
  preferences: { reduceMotion: false, colorVisionPreset: 'default', hudScaleFactor: 1 },
  ...extra,
});

const fixture = (name, runState, extra = {}, expect = {}) => Object.freeze({
  name,
  input: input(runState, extra),
  expect: Object.freeze(expect),
});

const keycardInventory = () => [...BASE_INVENTORY,
  inventoryRow('keycard_transit', 'Transit keycard', { rarityTier: 'epic' })];

export const RAID_FIXTURES = Object.freeze([
  fixture('raid-idle', baseRaidState(), {}, {
    phase: 'active', participant: 'raid', lossState: 'atRisk', channelActive: false,
  }),
  fixture('inventory-empty', baseRaidState({ runInventory: [] }), {}, { inventoryCount: 0 }),
  fixture('inventory-loot-mix', baseRaidState(), {}, {
    inventoryCount: 4, sources: ['loadout', 'loadout', 'looted', 'looted'],
  }),
  fixture('exit-needs-keycard', baseRaidState(), {}, {
    exitStates: { 'exit-transit-gate': 'requires-item', 'exit-market-van': 'available' },
  }),
  fixture('exit-keycard-held', baseRaidState({ runInventory: keycardInventory() }), {}, {
    exitStates: { 'exit-transit-gate': 'available', 'exit-market-van': 'available' },
  }),
  fixture('exit-window-pending', baseRaidState({
    exits: [{ id: 'exit-market-van', label: 'MARKET VAN', durationSeconds: 12,
      conditions: { window: { opensAt: SERVER_NOW + 90_000, closesAt: SERVER_NOW + 300_000 } } }],
  }), {}, { exitStates: { 'exit-market-van': 'window-pending' } }),
  fixture('exit-window-closed', baseRaidState({
    exits: [{ id: 'exit-market-van', label: 'MARKET VAN', durationSeconds: 12,
      conditions: { window: { opensAt: SERVER_NOW - 900_000, closesAt: SERVER_NOW - 1_000 } } }],
  }), {}, { exitStates: { 'exit-market-van': 'window-closed' } }),
  fixture('exit-awaiting-squad', baseRaidState({
    exits: [{ id: 'exit-squad', label: 'SQUAD EXIT', durationSeconds: 8,
      conditions: { squad: { required: 2, present: 1 } } }],
  }), {}, { exitStates: { 'exit-squad': 'awaiting-squad' } }),
  fixture('channel-0', baseRaidState({
    localParticipant: { phase: 'extracting', extracting: { exitId: 'exit-market-van', progress: 0 } },
  }), {}, { channelActive: true, percent: 0 }),
  fixture('channel-50', baseRaidState({
    localParticipant: { phase: 'extracting', extracting: { exitId: 'exit-market-van', progress: 0.5 } },
  }), {}, { channelActive: true, percent: 50 }),
  fixture('channel-99', baseRaidState({
    localParticipant: { phase: 'extracting', extracting: { exitId: 'exit-market-van', progress: 0.99 } },
  }), {}, { channelActive: true, percent: 99 }),
  fixture('channel-interrupted', baseRaidState(), {
    typedEvent: { type: 'channelInterrupted' },
  }, { caption: '[EXTRACTION INTERRUPTED — PROGRESS RESET]', channelActive: false }),
  fixture('cache-sealed-never-reveals', baseRaidState({
    nearby: {
      container: { containerId: 'cache-archive-1', kind: 'static', tier: 2, state: 'sealed' },
      // A malformed sample that leaks contents early — the projection must drop them (§3.1).
      items: [{ instanceId: 'leak-1', itemId: 'optic_prism', name: 'Prism optic', rarityTier: 'rare' }],
    },
  }), {}, { nearbyItemCount: 0, containerSealed: true }),
  fixture('cache-open-compare', baseRaidState({
    nearby: {
      container: { containerId: 'cache-archive-1', kind: 'static', tier: 2, state: 'opened' },
      items: [{
        instanceId: 'world-vest', itemId: 'vest_plated', name: 'Plated vest', rarityTier: 'rare',
        compare: { heldName: 'Light vest', statLabel: 'ARMOR', heldValue: 20, candidateValue: 45 },
      }],
    },
  }), {}, { nearbyItemCount: 1, compare: 'ARMOR 45 vs Light vest 20 (+25)' }),
  fixture('pickup-refused-taken', baseRaidState(), {
    typedEvent: { type: 'lootRefused', action: 'pickup', reason: 'unavailable' },
  }, { status: 'ALREADY TAKEN' }),
  fixture('pickup-refused-off-sector', baseRaidState(), {
    typedEvent: { type: 'lootRefused', action: 'pickup', reason: 'off-sector' },
  }, { status: 'TOO FAR AWAY' }),
  fixture('open-refused-already-open', baseRaidState(), {
    typedEvent: { type: 'lootRefused', action: 'openContainer', reason: 'alreadyOpened' },
  }, { status: 'CACHE ALREADY OPEN' }),
  fixture('pickup-merged-cue', baseRaidState(), {
    typedEvent: { type: 'pickedUp', merged: true },
  }, { caption: '[STACK MERGED]' }),
  fixture('collapsing', baseRaidState({ phase: 'collapsing', hardTimeoutAt: SERVER_NOW + 45_000 }), {}, {
    phase: 'collapsing', clockStatus: 'critical', clockText: '0:45',
  }),
  fixture('extracted', baseRaidState({
    localParticipant: { phase: 'extracted', outcome: 'extracted' },
  }), {}, { participant: 'extracted', lossState: 'extracted' }),
  fixture('dead', baseRaidState({
    localParticipant: { phase: 'dead', outcome: 'died' },
  }), {}, { participant: 'dead', lossState: 'dead' }),
  fixture('aborted', baseRaidState({
    localParticipant: { phase: 'aborted', outcome: 'aborted' },
  }), {}, { participant: 'aborted', lossState: 'aborted' }),
]);

export const RAID_FIXTURE_NAMES = Object.freeze(RAID_FIXTURES.map((item) => item.name));

export function getRaidFixture(name) {
  return RAID_FIXTURES.find((item) => item.name === name) || null;
}

export const RAID_FIXTURE_CONSTANTS = Object.freeze({ SERVER_NOW });
