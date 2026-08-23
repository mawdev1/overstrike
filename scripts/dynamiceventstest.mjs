/**
 * Dynamic events, locked zones, and the AI population director — `docs/contracts/dynamic-events.md`
 * (contract 20) §11 verification.
 *
 * Mirrors `scripts/extractiontest.mjs`/`scripts/sectortest.mjs`'s harness style: named
 * sections, an `ok`/`bad` ledger, every positive case paired with a failing control where one
 * exists.
 */
import { ExtractionRun, containerSeed, rollLootTable } from '../src/game/extraction.js';
import {
  EVENT_STATE, DYNAMIC_EVENTS_CONFIG, scheduleDynamicEvents, rollEventRarity,
  PopulationDirector,
} from '../src/game/dynamicEvents.js';
import { SectorInterest } from '../src/game/sectorInterest.js';
import { REFUSAL_REASONS, PROTOCOL_VERSION } from '../src/net/protocol.js';
import { FIXED_DT } from '../src/core/mathUtils.js';

let failures = 0;
let checks = 0;
let section = '';
const ok = (name) => { checks++; console.log(`  ok   ${name}`); };
const bad = (name, detail) => { failures++; checks++; console.log(`  FAIL ${name}\n       ${detail}`); };
const expect = (cond, name, detail = '') => (cond ? ok(name) : bad(name, `[${section}] ${detail}`));
const eq = (actual, expected, name) => expect(
  Object.is(actual, expected), name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
);
const eqJson = (actual, expected, name) => expect(
  JSON.stringify(actual) === JSON.stringify(expected), name,
  `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
);
const head = (title) => { section = title; console.log(`\n── ${title}`); };

// ─────────────────────────────────────────────────────────────────────────────── fixtures

// Small windows/lead so a unit test can tick a run to a scheduled event's own computed
// window without guessing — the window itself stays seed-derived (§6.1), only its RANGE is
// narrowed here for a fast, deterministic test loop.
const TEST_CONFIG = Object.freeze({
  ...DYNAMIC_EVENTS_CONFIG,
  EVENT_ANNOUNCE_LEAD_S: 1,
  CACHE_DROP_WINDOW_S: Object.freeze([2, 2]),
  LOCKED_ZONE_WINDOW_S: Object.freeze([2, 2]),
  MAX_CONCURRENT_EVENTS_PER_RUN: 4,
  MAX_CONCURRENT_EVENTS_PER_SECTOR: 2,
  REWARD_VALUE_BUDGET_PER_RUN: 1000,
});

const BASE_TABLE = { entries: [{ id: 'a-ammo', itemId: 'ammo_9mm', weight: 1.0, quantity: 10, stackable: true }] };
const KEY_TABLE = { entries: [{ id: 'a-key', itemId: 'key_x', weight: 0.0 }] }; // never rolls, deterministic control
const RICH_TABLE = { entries: [{ id: 'a-rare', itemId: 'rare_scope', weight: 1.0, quantity: 1, stackable: false }] };

const ITEM_DEFS = { ammo_9mm: { stackable: true }, rare_scope: { stackable: false }, key_x: { stackable: false } };

const CANDIDATES = [
  { eventSlotId: 'evt-a-cache', type: 'cache_drop', sectorId: 's1', anchorContainerId: 'c1', lootTableId: 'rich' },
  { eventSlotId: 'evt-b-locked', type: 'locked_zone', sectorId: 's1', anchorContainerId: 'c2', requiresItemDefId: 'key_x' },
];

function newRun(overrides = {}) {
  return new ExtractionRun({
    runId: 'run_de1',
    runSeed: 'seed-dynevents-001',
    lootTables: { base: BASE_TABLE, base2: KEY_TABLE, rich: RICH_TABLE },
    itemDefs: ITEM_DEFS,
    containers: [
      { containerId: 'c1', tier: 1, lootTableId: 'base', position: { x: 0, y: 0, z: 0 } },
      { containerId: 'c2', tier: 1, lootTableId: 'base2', position: { x: 5, y: 0, z: 0 } },
    ],
    participants: [
      { accountId: 'acct-a', squadId: 'sq-a', loadoutInstances: [] },
    ],
    dynamicEventCandidates: CANDIDATES,
    dynamicEventsConfig: TEST_CONFIG,
    hardTimeoutSeconds: 60,
    ...overrides,
  });
}

/**
 * Tick a run forward so its `_tickDynamicEvents` pass has processed `now === targetTick`
 * (`tick()` reads `elapsedTicks` before incrementing it, so the call that observes
 * `now === targetTick` is the one made while `elapsedTicks === targetTick`, i.e. one further
 * than `elapsedTicks < targetTick` alone would reach).
 */
function tickTo(run, targetTick) {
  while (run.elapsedTicks <= targetTick) run.tick({});
}

// ──────────────────────────────────────────────────────────────────────────── §6.1/§8.2 rolls

head('§6.1/§8.2 — deterministic seeded rolls');
{
  const seedA = containerSeed('seed-1', 'evt-x');
  const seedB = containerSeed('seed-1', 'evt-x');
  eq(seedA, seedB, 'containerSeed is pure — identical (runSeed, eventSlotId) reproduces identically');
  const t1 = rollEventRarity('cache_drop', seedA, DYNAMIC_EVENTS_CONFIG);
  const t2 = rollEventRarity('cache_drop', seedB, DYNAMIC_EVENTS_CONFIG);
  eq(t1, t2, 'rollEventRarity is a pure function of (type, seed)');
  expect(['common', 'uncommon', 'rare', 'epic', 'legendary'].includes(t1), 'rolled tier is one of the closed enum');

  // control: an all-zero-weight curve for a type produces no roll at all (defensive, not a
  // real authored curve — proves the function does not fabricate a tier out of nothing).
  const emptyCfg = { ...DYNAMIC_EVENTS_CONFIG, RARITY_CURVE: { cache_drop: [] } };
  eq(rollEventRarity('cache_drop', seedA, emptyCfg), null, 'an empty rarity curve rolls nothing (control)');
}

head('§6.1/§11 item 6 — scheduling determinism, independent of authoring array order');
{
  const rowsA = scheduleDynamicEvents({ runSeed: 'seed-x', candidates: CANDIDATES, runDurationTicks: 7200, config: TEST_CONFIG });
  const rowsB = scheduleDynamicEvents({ runSeed: 'seed-x', candidates: [...CANDIDATES].reverse(), runDurationTicks: 7200, config: TEST_CONFIG });
  eqJson(rowsA, rowsB, 'two schedules from one seed and the same candidate SET (different array order) produce byte-identical rosters');

  const rowsDifferentSeed = scheduleDynamicEvents({ runSeed: 'seed-y', candidates: CANDIDATES, runDurationTicks: 7200, config: TEST_CONFIG });
  expect(JSON.stringify(rowsDifferentSeed) !== JSON.stringify(rowsA), 'a different runSeed produces a different roster (control — not a constant roll)');
}

head('§4.2/§8.3 — MAX_CONCURRENT_EVENTS_PER_SECTOR / PER_RUN bound the accepted roster');
{
  const manyCandidates = Array.from({ length: 10 }, (_, i) => ({
    eventSlotId: `evt-${String(i).padStart(2, '0')}`, type: 'cache_drop', sectorId: 's1',
    anchorContainerId: 'c1', lootTableId: 'rich',
  }));
  const cfg = { ...TEST_CONFIG, MAX_CONCURRENT_EVENTS_PER_SECTOR: 2, MAX_CONCURRENT_EVENTS_PER_RUN: 4 };
  const rows = scheduleDynamicEvents({ runSeed: 'seed-budget', candidates: manyCandidates, runDurationTicks: 200, config: cfg });
  expect(rows.length <= cfg.MAX_CONCURRENT_EVENTS_PER_RUN, `accepted roster (${rows.length}) never exceeds MAX_CONCURRENT_EVENTS_PER_RUN (${cfg.MAX_CONCURRENT_EVENTS_PER_RUN})`);
  const perSector = new Map();
  for (const r of rows) perSector.set(r.sectorId, (perSector.get(r.sectorId) ?? 0) + 1);
  expect([...perSector.values()].every((n) => n <= cfg.MAX_CONCURRENT_EVENTS_PER_SECTOR), 'no sector exceeds MAX_CONCURRENT_EVENTS_PER_SECTOR');
}

head('§8.3/§11 item 11 — REWARD_VALUE_BUDGET_PER_RUN bounds the scheduler, swept across seeds');
{
  const highValueCandidates = Array.from({ length: 20 }, (_, i) => ({
    eventSlotId: `hv-${String(i).padStart(2, '0')}`, type: 'locked_zone', sectorId: `sector-${i % 5}`,
    anchorContainerId: 'c1', requiresItemDefId: 'key_x',
  }));
  const cfg = { ...DYNAMIC_EVENTS_CONFIG, MAX_CONCURRENT_EVENTS_PER_RUN: 20, MAX_CONCURRENT_EVENTS_PER_SECTOR: 20, REWARD_VALUE_BUDGET_PER_RUN: 220 };
  let overBudgetSeeds = 0;
  for (let s = 0; s < 25; s++) {
    const rows = scheduleDynamicEvents({ runSeed: `sweep-${s}`, candidates: highValueCandidates, runDurationTicks: 100000, config: cfg });
    const total = rows.reduce((sum, r) => sum + r.expectedValue, 0);
    if (total > cfg.REWARD_VALUE_BUDGET_PER_RUN) overBudgetSeeds++;
  }
  eq(overBudgetSeeds, 0, 'across 25 swept seeds, no schedule ever produces a roster whose summed expectedValue exceeds REWARD_VALUE_BUDGET_PER_RUN');
}

// ──────────────────────────────────────────────────────────────────────── §4.1 lifecycle / §5

head('§4.1 — event state machine: scheduled -> announced -> active, on schedule');
{
  const run = newRun();
  const evt = run.dynamicEvents.get('evt-a-cache');
  expect(!!evt, 'the cache_drop candidate was accepted into the roster');
  eq(evt.state, EVENT_STATE.SCHEDULED, 'freshly constructed run: event starts scheduled');
  const [start] = evt.activeWindow;
  const leadTicks = Math.round(TEST_CONFIG.EVENT_ANNOUNCE_LEAD_S / FIXED_DT);

  if (start - leadTicks > 0) {
    tickTo(run, start - leadTicks - 1);
    eq(run.dynamicEvents.get('evt-a-cache').state, EVENT_STATE.SCHEDULED, 'still scheduled one tick before the announce lead');
  }
  tickTo(run, start - leadTicks);
  eq(run.dynamicEvents.get('evt-a-cache').state, EVENT_STATE.ANNOUNCED, 'announced exactly at start - EVENT_ANNOUNCE_LEAD_S');
  tickTo(run, start);
  eq(run.dynamicEvents.get('evt-a-cache').state, EVENT_STATE.ACTIVE, 'active exactly at activeWindow start');
  const c1 = run.containers.get('c1');
  eq(c1.lootTableId, 'rich', 'cache_drop container swaps to the richer lootTableId while active');
  eq(c1.state, 'sealed', 'cache_drop container state stays sealed (unmodified §3.2 open path — no new gate)');
}

head('§3.1/§11 item 2 — cache_drop: opens through the unmodified pickup path, resolves the event');
{
  const run = newRun();
  run.spawnParticipant('acct-a');
  const evt = run.dynamicEvents.get('evt-a-cache');
  tickTo(run, evt.activeWindow[0]);
  eq(run.dynamicEvents.get('evt-a-cache').state, EVENT_STATE.ACTIVE, 'event active before opening');

  const res = run.openContainer('acct-a', 'c1');
  eq(res.ok, true, 'opening the active cache_drop container succeeds through the ordinary sealed-container path');
  const rolled = [...run.instances.values()].filter((i) => i.containerId === 'c1' && i.location === 'world');
  expect(rolled.some((i) => i.itemId === 'rare_scope'), 'the opened container yields the RICH table contents, not the original base table');
  eq(run.dynamicEvents.get('evt-a-cache').state, EVENT_STATE.DESPAWNED, 'resolving immediately despawns the event (§4.1)');

  const resolvedEvt = run.events.find((e) => e.type === 'dynamicEvent.resolved' && e.eventSlotId === 'evt-a-cache');
  expect(!!resolvedEvt, 'a dynamicEvent.resolved event was emitted');
  eq(resolvedEvt.accountId, 'acct-a', 'resolved event records the resolving account');
  expect(Number.isFinite(resolvedEvt.rewardValue) && resolvedEvt.rewardValue > 0, 'resolved event carries a positive rewardValue');
}

head('§3.1/§11 item 2 — cache_drop: reverts to the anchor\'s original tier/table if never opened');
{
  const run = newRun();
  const evt = run.dynamicEvents.get('evt-a-cache');
  const [, end] = evt.activeWindow;
  tickTo(run, end + 1);
  eq(run.dynamicEvents.get('evt-a-cache').state, EVENT_STATE.DESPAWNED, 'unopened event expires then immediately despawns');
  const c1 = run.containers.get('c1');
  eq(c1.state, 'sealed', 'container reverts to sealed');
  eq(c1.lootTableId, 'base', 'container reverts to its original lootTableId');
  const contents = [...run.instances.values()].filter((i) => i.containerId === 'c1' && i.location === 'container');
  expect(contents.every((i) => i.itemId === 'ammo_9mm'), 'reverted container contents come from the ORIGINAL table, not the event\'s rich table');

  const expiredEvt = run.events.find((e) => e.type === 'dynamicEvent.expired' && e.eventSlotId === 'evt-a-cache');
  expect(!!expiredEvt, 'a dynamicEvent.expired event was emitted');
}

head('§5/§11 item 3 — locked_zone: refused without a qualifying key, no partial consumption');
{
  const run = newRun();
  run.spawnParticipant('acct-a');
  const evt = run.dynamicEvents.get('evt-b-locked');
  tickTo(run, evt.activeWindow[0]);
  const c2 = run.containers.get('c2');
  eq(c2.state, 'locked', 'locked_zone container is locked while the event is active');

  const noKey = run.openContainer('acct-a', 'c2');
  eq(noKey.ok, false, 'open attempt with no key at all is refused');
  eq(noKey.reason, 'key-required', 'refusal reason is key-required');

  // A non-matching item instance must never be consumed by a failed attempt.
  run.instances.set('inst-wrong', {
    instanceId: 'inst-wrong', itemId: 'ammo_9mm', quantity: 1, stackable: true,
    location: 'run', containerId: null, runId: run.runId, ownerAccountId: 'acct-a',
    status: 'active', locked: false,
  });
  const wrongKey = run.openContainer('acct-a', 'c2', { keyInstanceId: 'inst-wrong' });
  eq(wrongKey.ok, false, 'a non-matching item instance does not qualify as a key');
  eq(wrongKey.reason, 'key-required', 'refusal reason is key-required for a non-matching instance too');
  eq(run.instances.get('inst-wrong').status, 'active', 'the non-matching instance is NOT consumed by the failed attempt');
  eq(run.containers.get('c2').state, 'locked', 'the container remains locked after a failed attempt');
}

head('§5/§11 item 4 — locked_zone: a qualifying key unlocks atomically (key consumed, container opened, event resolved)');
{
  const run = newRun();
  run.spawnParticipant('acct-a');
  const evt = run.dynamicEvents.get('evt-b-locked');
  tickTo(run, evt.activeWindow[0]);
  run.instances.set('inst-key', {
    instanceId: 'inst-key', itemId: 'key_x', quantity: 1, stackable: false,
    location: 'run', containerId: null, runId: run.runId, ownerAccountId: 'acct-a',
    status: 'active', locked: false,
  });

  const res = run.openContainer('acct-a', 'c2', { keyInstanceId: 'inst-key' });
  eq(res.ok, true, 'presenting a qualifying key unlocks the zone');
  eq(run.instances.get('inst-key').status, 'consumed', 'the key instance is consumed (distinct from an exit keycard, which is presence-only)');
  eq(run.containers.get('c2').state, 'opened', 'the container transitions locked -> opened in the same call');
  eq(run.dynamicEvents.get('evt-b-locked').state, EVENT_STATE.DESPAWNED, 'the event resolves and immediately despawns');
}

head('§5/§11 item 5 — two players presenting keys at once: first-applied wins, second refused');
{
  const run = new ExtractionRun({
    runId: 'run_de2', runSeed: 'seed-dynevents-002',
    lootTables: { base: BASE_TABLE, base2: KEY_TABLE, rich: RICH_TABLE }, itemDefs: ITEM_DEFS,
    containers: [{ containerId: 'c2', tier: 1, lootTableId: 'base2', position: { x: 5, y: 0, z: 0 } }],
    participants: [
      { accountId: 'acct-a', squadId: 'sq-a', loadoutInstances: [] },
      { accountId: 'acct-b', squadId: 'sq-b', loadoutInstances: [] },
    ],
    dynamicEventCandidates: [CANDIDATES[1]],
    dynamicEventsConfig: TEST_CONFIG,
    hardTimeoutSeconds: 60,
  });
  run.spawnParticipant('acct-a');
  run.spawnParticipant('acct-b');
  const evt = run.dynamicEvents.get('evt-b-locked');
  tickTo(run, evt.activeWindow[0]);
  run.instances.set('key-a', { instanceId: 'key-a', itemId: 'key_x', quantity: 1, stackable: false, location: 'run', containerId: null, runId: run.runId, ownerAccountId: 'acct-a', status: 'active', locked: false });
  run.instances.set('key-b', { instanceId: 'key-b', itemId: 'key_x', quantity: 1, stackable: false, location: 'run', containerId: null, runId: run.runId, ownerAccountId: 'acct-b', status: 'active', locked: false });

  const first = run.openContainer('acct-a', 'c2', { keyInstanceId: 'key-a' });
  const second = run.openContainer('acct-b', 'c2', { keyInstanceId: 'key-b' });
  eq(first.ok, true, 'the first presenter unlocks the zone');
  eq(second.ok, false, 'the second, same-tick presenter is refused');
  eq(second.reason, 'alreadyOpened', 'the second is refused as an ordinary already-opened container, not key-required');
  eq(run.instances.get('key-a').status, 'consumed', "the winner's key is consumed");
  eq(run.instances.get('key-b').status, 'active', "the loser's key is NOT consumed");
}

head('§4.1 — run end forces despawn of any still-live event');
{
  const run = newRun();
  eq(run.dynamicEvents.get('evt-a-cache').state, EVENT_STATE.SCHEDULED, 'event still scheduled before run end');
  run.end();
  eq(run.dynamicEvents.get('evt-a-cache').state, EVENT_STATE.DESPAWNED, 'run end force-despawns a non-terminal event');
  eq(run.dynamicEvents.get('evt-b-locked').state, EVENT_STATE.DESPAWNED, 'and every other non-terminal event too');
}

head('§8.4 — events.dynamic.enabled kill switch: off means no event ever advances past nonexistent');
{
  const runOff = newRun({ eventsEnabled: false });
  eq(runOff.dynamicEvents.size, 0, 'with the flag off, no event is ever scheduled at all — nothing to advance past scheduled');
  {
    const c1 = runOff.containers.get('c1');
    eq(c1.state, 'sealed', 'the anchor container behaves as an ordinary static container');
    eq(c1.lootTableId, 'base', 'the anchor container keeps its own authored lootTableId, never the event\'s');
  }
  const runOn = newRun({ eventsEnabled: true });
  expect(runOn.dynamicEvents.size > 0, 'toggled back on (a fresh run), events schedule normally — no lingering off-state');
}

// ─────────────────────────────────────────────────────────────────────────────────── §6 / §5.3

head('§6/§5.3 off-sector — a locked_zone target outside the actor\'s relevant set is refused before key-required');
{
  const sectors = [
    { id: 'near', box: { min: { x: -5, y: -1, z: -5 }, max: { x: 5, y: 5, z: 5 } }, neighbours: [] },
    { id: 'far', box: { min: { x: 95, y: -1, z: -5 }, max: { x: 105, y: 5, z: 5 } }, neighbours: [] },
  ];
  const si = new SectorInterest(sectors);
  const run = new ExtractionRun({
    runId: 'run_de3', runSeed: 'seed-dynevents-003', sectorInterest: si,
    lootTables: { base2: KEY_TABLE }, itemDefs: ITEM_DEFS,
    containers: [{ containerId: 'c2', tier: 1, lootTableId: 'base2', position: { x: 100, y: 0, z: 0 } }],
    participants: [{ accountId: 'acct-a', squadId: 'sq-a', loadoutInstances: [] }],
    dynamicEventCandidates: [{ ...CANDIDATES[1], anchorContainerId: 'c2' }],
    dynamicEventsConfig: TEST_CONFIG,
    hardTimeoutSeconds: 60,
  });
  run.spawnParticipant('acct-a');
  const evt = run.dynamicEvents.get('evt-b-locked');
  tickTo(run, evt.activeWindow[0]);
  run.tick({ positions: new Map([['acct-a', { x: 0, y: 0, z: 0 }]]) }); // server places acct-a in 'near'

  const denied = run.openContainer('acct-a', 'c2', { keyInstanceId: 'anything' });
  eq(denied.ok, false, 'a locked_zone container in a sector the actor has no relevance to is refused');
  eq(denied.reason, 'off-sector', 'off-sector is checked before key-required — sector gating is a precondition, not a substitute');
}

// ─────────────────────────────────────────────────────────────────────────────────── §7 director

head('§7.2/§11 item 7 — PopulationDirector never exceeds populationCap, swept across pressure');
{
  const si = new SectorInterest([{ id: 's1', box: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 5, z: 10 } }, neighbours: [], populationCap: 10, baseThinkStride: 8 }]);
  si.tick(0, new Set(['s1'])); // active
  const director = new PopulationDirector(DYNAMIC_EVENTS_CONFIG);
  const profiles = [{ profileId: 'sentinel-elite', budget: { maxActivePerSector: 3 } }];
  let overCap = 0;
  for (let pressure = 0; pressure <= 50; pressure++) {
    const events = Array.from({ length: pressure }, (_, i) => ({ sectorId: 's1', rarityTier: 'legendary' }));
    const [adj] = director.pass({ sectorInterest: si, activeEvents: events, existingCounts: new Map([['s1', 0]]), aiProfiles: profiles });
    if (adj.target > 10) overCap++;
  }
  eq(overCap, 0, 'target never exceeds populationCap across a swept pressure range 0..50, including the boundary that would round past cap absent the clamp');
}

head('§7.3/§11 item 8 — refused, not queued: no retry accumulation, no eviction');
{
  const si = new SectorInterest([{ id: 's1', box: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 5, z: 10 } }, neighbours: [], populationCap: 5, baseThinkStride: 8 }]);
  si.tick(0, new Set(['s1']));
  const director = new PopulationDirector({ ...DYNAMIC_EVENTS_CONFIG, DENSITY_PER_PRESSURE: 1 });
  const events = [{ sectorId: 's1', rarityTier: 'legendary' }, { sectorId: 's1', rarityTier: 'legendary' }];
  const existing = new Map([['s1', 5]]); // already at the cap
  const [pass1] = director.pass({ sectorInterest: si, activeEvents: events, existingCounts: existing });
  const [pass2] = director.pass({ sectorInterest: si, activeEvents: events, existingCounts: existing });
  eq(pass1.refusedCount, pass2.refusedCount, 'refusedCount is recomputed fresh each pass, not accumulated across passes');
  expect(pass1.admittedDelta === 0, 'a sector already at its populationCap admits nothing — no eviction of the existing occupants');
}

head('§7.2/§11 item 9 — MAX_ELITE_SHARE and the profile\'s own budget both bound eliteCount');
{
  const si = new SectorInterest([{ id: 's1', box: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 5, z: 10 } }, neighbours: [], populationCap: 100, baseThinkStride: 8 }]);
  si.tick(0, new Set(['s1']));
  const events = Array.from({ length: 40 }, () => ({ sectorId: 's1', rarityTier: 'legendary' })); // enormous pressure
  const director = new PopulationDirector({ ...DYNAMIC_EVENTS_CONFIG, MAX_ELITE_SHARE: 0.5, DENSITY_PER_PRESSURE: 1 });
  const profiles = [{ profileId: 'sentinel-elite', budget: { maxActivePerSector: 4 } }];
  const [adj] = director.pass({ sectorInterest: si, activeEvents: events, existingCounts: new Map(), aiProfiles: profiles });
  expect(adj.eliteShare <= 0.5, 'eliteShare never exceeds MAX_ELITE_SHARE even under enormous pressure');
  expect(adj.eliteCount <= 4, "eliteCount never exceeds AI_PROFILES['sentinel-elite'].budget.maxActivePerSector even when share math alone would allow more");
}

head('§7.3/§11 item 10 — a warming sector never receives a nonzero eliteShare');
{
  const si = new SectorInterest([
    { id: 's1', box: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 5, z: 10 } }, neighbours: ['s2'], populationCap: 20, baseThinkStride: 8 },
    { id: 's2', box: { min: { x: 10, y: 0, z: 0 }, max: { x: 20, y: 5, z: 10 } }, neighbours: ['s1'], populationCap: 20, baseThinkStride: 8 },
  ]);
  si.tick(0, new Set(['s1'])); // s1 active, s2 warming
  eq(si.stateOf('s2'), 'warming', 'fixture check: s2 is warming');
  const events = [{ sectorId: 's2', rarityTier: 'legendary' }, { sectorId: 's2', rarityTier: 'legendary' }];
  const director = new PopulationDirector(DYNAMIC_EVENTS_CONFIG);
  const adjustments = director.pass({ sectorInterest: si, activeEvents: events, existingCounts: new Map() });
  const s2 = adjustments.find((a) => a.sectorId === 's2');
  eq(s2.eliteShare, 0, 'a warming sector\'s eliteShare is always 0, regardless of pressure');
  expect(s2.target >= 0, 'a warming sector still gets a (non-elite) density target from pressure — only the elite bias is excluded');

  const dormantAdjustment = adjustments.find((a) => a.sectorId === 'nonexistent');
  eq(dormantAdjustment, undefined, 'control: no adjustment row exists for a sector id that is not in sectorInterest at all');
}

head('§7.1/§10 — the director never touches populationCap or AI_PROFILES.budget, only reads them');
{
  const sectorDef = { id: 's1', box: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 5, z: 10 } }, neighbours: [], populationCap: 12, baseThinkStride: 8 };
  const si = new SectorInterest([sectorDef]);
  si.tick(0, new Set(['s1']));
  const profiles = [{ profileId: 'sentinel-elite', budget: { maxActivePerSector: 2 } }];
  const director = new PopulationDirector(DYNAMIC_EVENTS_CONFIG);
  director.pass({ sectorInterest: si, activeEvents: [{ sectorId: 's1', rarityTier: 'legendary' }], existingCounts: new Map(), aiProfiles: profiles });
  eq(sectorDef.populationCap, 12, 'populationCap is unmodified after a director pass');
  eq(profiles[0].budget.maxActivePerSector, 2, 'AI_PROFILES budget is unmodified after a director pass');
}

// ───────────────────────────────────────────────────────────────────────── wire vocabulary

head('§5/wire-protocol.md §8.2 — key-required refusal reason: wire vocabulary and ordering');
{
  eq(REFUSAL_REASONS[5], 'off-sector', 'index 5 is still off-sector, untouched');
  eq(REFUSAL_REASONS[6], 'key-required', "'key-required' is appended at index 6, after off-sector");
  eq(REFUSAL_REASONS.length, 7, 'REFUSAL_REASONS grew by exactly one entry');
  expect(PROTOCOL_VERSION >= 5, 'PROTOCOL_VERSION bumped for the key-required wire-shape change');
}

// ──────────────────────────────────────────────────────────────────────────────── summary

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
