/**
 * OVERSTRIKE — P3-11 authored content for the extraction vertical slice.
 *
 * DATA ONLY. This module contains no behaviour: every export is a frozen literal the
 * server-owned mechanisms consume — `src/game/extraction.js` (extraction-match.md, FROZEN)
 * for loot tables / containers / exits, and `platform/src/modules/inventory` (items-inventory.md,
 * FROZEN) for the item definition catalog. Nothing here can bypass a server check, because
 * nothing here IS a check: a wrong value fails the shipped validators, it does not override
 * them. `scripts/extractiontest.mjs`'s "P3-11 content data" section runs this file through
 * exactly those validators.
 *
 * Scope, per the Build Plan's P3 slice: graybox The Square, TWO loot tiers, TWO AI profiles,
 * TWO conditional extraction exits. Positions and POI references use `level.js`'s shipped
 * Square callout regions (map-data.md §3.4 vocabulary) so the data and the map agree on names.
 */

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** Version pin for `matches.loot_table_version` (extraction-match.md §3.1.1). */
export const LOOT_TABLE_VERSION = 'extraction-slice-v1';

// ─────────────────────────────────────────────────────────── item definition catalog (P3-01 §2)

/**
 * `item_definitions` rows in the exact shape `createInventoryService().defineItem` validates:
 * `class` ∈ weapon|gear|consumable|material|cosmetic, `slot` null or one of the eight
 * equippable keys, `rarity_tier` ∈ common..legendary, `stackable`/`maxStack` per §2.
 * `slot: null` items are loot-only (items-inventory.md §3.1 rule 5 — never in a loadout);
 * `slot: 'consumable'` (medkit) is the single equippable quick-item, distinct from
 * `class: 'consumable'` per §2's own warning about that word meaning two things.
 * `tradable` is false across the board — P3/P4 data never gates P7-03 open.
 */
export const ITEM_DEFINITIONS = deepFreeze([
  // Tier-1 loot pool + starter loadout gear.
  { itemId: 'ammo_9mm', class: 'consumable', slot: null, rarityTier: 'common',
    stackable: true, maxStack: 120, baseStats: { caliber: '9mm', weightKg: 0.01 }, tradable: false, contentVersion: 1 },
  { itemId: 'bandage_wrap', class: 'consumable', slot: null, rarityTier: 'common',
    stackable: true, maxStack: 5, baseStats: { healAmount: 25, useSeconds: 3 }, tradable: false, contentVersion: 1 },
  { itemId: 'scrap_electronics', class: 'material', slot: null, rarityTier: 'common',
    stackable: true, maxStack: 10, baseStats: { salvageValue: 12, weightKg: 0.4 }, tradable: false, contentVersion: 1 },
  { itemId: 'pistol_p9', class: 'weapon', slot: 'secondary', rarityTier: 'common',
    stackable: false, maxStack: null, baseStats: { damage: 24, magazine: 15, caliber: '9mm', weightKg: 0.9 }, tradable: false, contentVersion: 1 },
  { itemId: 'knife_field', class: 'weapon', slot: 'melee', rarityTier: 'common',
    stackable: false, maxStack: null, baseStats: { damage: 38, weightKg: 0.3 }, tradable: false, contentVersion: 1 },
  { itemId: 'helmet_halfshell', class: 'gear', slot: 'helmet', rarityTier: 'common',
    stackable: false, maxStack: null, baseStats: { armor: 15, weightKg: 0.8 }, tradable: false, contentVersion: 1 },
  { itemId: 'vest_light', class: 'gear', slot: 'vest', rarityTier: 'common',
    stackable: false, maxStack: null, baseStats: { armor: 20, weightKg: 2.1 }, tradable: false, contentVersion: 1 },
  { itemId: 'backpack_scout', class: 'gear', slot: 'backpack', rarityTier: 'uncommon',
    stackable: false, maxStack: null, baseStats: { capacitySlots: 12, weightKg: 1.2 }, tradable: false, contentVersion: 1 },
  { itemId: 'medkit_field', class: 'consumable', slot: 'consumable', rarityTier: 'uncommon',
    stackable: false, maxStack: null, baseStats: { healAmount: 70, useSeconds: 6 }, tradable: false, contentVersion: 1 },

  // Tier-2 loot pool.
  { itemId: 'ammo_762', class: 'consumable', slot: null, rarityTier: 'uncommon',
    stackable: true, maxStack: 90, baseStats: { caliber: '7.62mm', weightKg: 0.016 }, tradable: false, contentVersion: 1 },
  { itemId: 'rifle_ak74', class: 'weapon', slot: 'primary', rarityTier: 'rare',
    stackable: false, maxStack: null, baseStats: { damage: 41, magazine: 30, caliber: '7.62mm', weightKg: 3.3 }, tradable: false, contentVersion: 1 },
  { itemId: 'vest_plated', class: 'gear', slot: 'vest', rarityTier: 'rare',
    stackable: false, maxStack: null, baseStats: { armor: 45, weightKg: 4.6 }, tradable: false, contentVersion: 1 },
  { itemId: 'optic_prism', class: 'material', slot: null, rarityTier: 'rare',
    stackable: false, maxStack: null, baseStats: { salvageValue: 60, weightKg: 0.5 }, tradable: false, contentVersion: 1 },
  { itemId: 'keycard_transit', class: 'material', slot: null, rarityTier: 'epic',
    stackable: false, maxStack: null, baseStats: { salvageValue: 0, weightKg: 0.05 }, tradable: false, contentVersion: 1 },
]);

/**
 * The `{ [itemId]: { stackable } }` projection `ExtractionRun`'s `itemDefs` option consumes
 * (§3.2.1's "the raid server checks that flag"). Derived from the catalog above so the two
 * shapes cannot drift apart — reshaping, not logic.
 */
export const EXTRACTION_ITEM_DEFS = deepFreeze(Object.fromEntries(
  ITEM_DEFINITIONS.map((d) => [d.itemId, { stackable: d.stackable }]),
));

// ───────────────────────────────────────────────────────────── loot tables (P3-03 §3.1/§3.1.1)

/**
 * Two tiers, per the Build Plan slice. Shape is what `rollLootTable` walks: entries with a
 * STABLE unique `id` (the fixed ascending-id walk order is what makes rolls bit-reproducible —
 * ids here are authored pre-sorted for the reader, but the roll re-sorts regardless), `weight`
 * as an authored per-entry inclusion probability in [0,1], `quantity` ≥ 1 (and exactly 1 for
 * non-stackables, matching grantItem's ITEM_NOT_STACKABLE guard), and `stackable` mirroring
 * the catalog so a container roll can never contradict the definition it instantiates.
 */
export const LOOT_TABLES = deepFreeze({
  'lt.tier1.cache': {
    tier: 1,
    entries: [
      { id: 't1-ammo9', itemId: 'ammo_9mm', weight: 0.9, quantity: 30, stackable: true },
      { id: 't1-bandage', itemId: 'bandage_wrap', weight: 0.75, quantity: 2, stackable: true },
      { id: 't1-helmet', itemId: 'helmet_halfshell', weight: 0.35, quantity: 1, stackable: false },
      { id: 't1-pistol', itemId: 'pistol_p9', weight: 0.5, quantity: 1, stackable: false },
      { id: 't1-scrap', itemId: 'scrap_electronics', weight: 0.6, quantity: 3, stackable: true },
      { id: 't1-vest', itemId: 'vest_light', weight: 0.3, quantity: 1, stackable: false },
    ],
  },
  'lt.tier2.cache': {
    tier: 2,
    entries: [
      { id: 't2-ammo762', itemId: 'ammo_762', weight: 0.85, quantity: 20, stackable: true },
      { id: 't2-keycard', itemId: 'keycard_transit', weight: 0.15, quantity: 1, stackable: false },
      { id: 't2-medkit', itemId: 'medkit_field', weight: 0.55, quantity: 1, stackable: false },
      { id: 't2-optic', itemId: 'optic_prism', weight: 0.35, quantity: 1, stackable: false },
      { id: 't2-rifle', itemId: 'rifle_ak74', weight: 0.45, quantity: 1, stackable: false },
      { id: 't2-vest', itemId: 'vest_plated', weight: 0.3, quantity: 1, stackable: false },
    ],
  },
});

// ─────────────────────────────────────────────────────────────────────── POI tags (P3-11)

/**
 * POI tagging for loot placement and (later, P3-05/P4-02) AI population direction.
 * `calloutId` values are `level.js`'s shipped Square callout region ids (map-data.md §3.4) —
 * the single naming vocabulary rule — so a POI is always a place a player can already name.
 * `lootTier` says which cache tier that POI hosts in this slice.
 */
export const POI_TAGS = deepFreeze([
  { poiId: 'poi-fountain', calloutId: 'plaza-fountain', tags: ['landmark', 'open', 'contested'], lootTier: 1 },
  { poiId: 'poi-arcade', calloutId: 'market-arcade', tags: ['interior', 'lanes'], lootTier: 1 },
  { poiId: 'poi-alley', calloutId: 'market-alley', tags: ['route', 'exit-adjacent'], lootTier: 1 },
  { poiId: 'poi-tunnel', calloutId: 'service-tunnel', tags: ['route', 'exit-adjacent'], lootTier: 1 },
  { poiId: 'poi-archive', calloutId: 'civic-archive', tags: ['interior', 'loot-dense'], lootTier: 2 },
  { poiId: 'poi-transit', calloutId: 'transit-control', tags: ['interior', 'vertical', 'loot-dense'], lootTier: 2 },
]);

/**
 * Static container placements (`world_loot_containers` kind='static', §3.1) — the exact
 * `containers` array `ExtractionRun`'s constructor rolls at spinning-up. Positions sit inside
 * the named POI's callout box in `level.js`. Tier-N containers reference the tier-N table only.
 */
export const STATIC_CONTAINERS = deepFreeze([
  { containerId: 'crate-fountain-1', tier: 1, lootTableId: 'lt.tier1.cache', position: { x: 0, y: 0, z: 8 }, poiId: 'poi-fountain' },
  { containerId: 'crate-arcade-1', tier: 1, lootTableId: 'lt.tier1.cache', position: { x: -32, y: 0, z: 18 }, poiId: 'poi-arcade' },
  { containerId: 'crate-alley-1', tier: 1, lootTableId: 'lt.tier1.cache', position: { x: -28, y: 0, z: 35 }, poiId: 'poi-alley' },
  { containerId: 'crate-tunnel-1', tier: 1, lootTableId: 'lt.tier1.cache', position: { x: 30, y: 0, z: 30 }, poiId: 'poi-tunnel' },
  { containerId: 'cache-archive-1', tier: 2, lootTableId: 'lt.tier2.cache', position: { x: -31, y: 0, z: -17 }, poiId: 'poi-archive' },
  { containerId: 'cache-transit-1', tier: 2, lootTableId: 'lt.tier2.cache', position: { x: 31, y: 0, z: 17 }, poiId: 'poi-transit' },
]);

// ────────────────────────────────────────────────────────────────── extraction exits (§4)

/**
 * TWO conditional exits, per the Build Plan slice, in `ExtractionExit`'s exact authored shape
 * (§4: map-data.md §3.3 box idiom, conditions declared not implemented — the channel mechanism
 * that enforces them every tick is `extraction.js`'s, never this file's):
 *
 *  - `exit-transit-gate` — item-gated: requires a `keycard_transit` among the participant's
 *    `location='run'` instances. The keycard only rolls from tier-2 caches (risk buys the exit).
 *  - `exit-market-van` — window-gated: opens 2 minutes in and closes at 14 minutes
 *    (run-relative ticks at FIXED_DT = 1/120), always item-free so a solo player with no
 *    keycard luck is never stranded.
 */
export const EXTRACTION_EXITS = deepFreeze([
  { id: 'exit-transit-gate',
    volume: { min: { x: 38, y: 0, z: 34 }, max: { x: 42, y: 3, z: 42 } },
    requiresItemDefId: 'keycard_transit',
    durationSeconds: 8 },
  { id: 'exit-market-van',
    volume: { min: { x: -42, y: 0, z: 36 }, max: { x: -36, y: 3, z: 42 } },
    activeWindow: [14400, 100800], // 120 s .. 840 s at 120 Hz
    durationSeconds: 12 },
]);

// ──────────────────────────────────────────────────────── run lifecycle parameters (§1.1)

/**
 * §1.1: "spinning-up/collapsing/ended durations and the join window are data (P3-11)".
 * `reconnectGraceSeconds` restates the auth.md §7 / bomb-rules.md §9 window the mechanism
 * already defaults to; `hardTimeoutSeconds` closes before `exit-market-van`'s window does.
 */
export const RUN_RULES = deepFreeze({
  joinWindowSeconds: 120,
  collapseWarningSeconds: 60,
  hardTimeoutSeconds: 900,
  reconnectGraceSeconds: 90,
});

// ─────────────────────────────────────────────────────────────────── AI profiles (P3-11)

/**
 * TWO profiles, per the Build Plan slice. Pure tuning references into the shipped AI's own
 * closed vocabularies — `difficulty` must name a `DIFFICULTY` preset and every
 * `personalityWeights` key a `PERSONALITIES` temperament (src/ai/bot.js); the weights are
 * relative selection odds in the same shape as bot.js's own CLASS_WEIGHTS tables. `budget`
 * feeds P3-05's server-side activation budgets (sector-interest.md): a profile can never
 * author MORE simulation than the server budgets, only how the budgeted population behaves.
 */
export const AI_PROFILES = deepFreeze([
  { profileId: 'scav-patrol',
    difficulty: 'regular',
    personalityWeights: { roamer: 5, holder: 3, pusher: 2 },
    budget: { maxActivePerSector: 6, maxActiveTotal: 12 } },
  { profileId: 'sentinel-elite',
    difficulty: 'veteran',
    personalityWeights: { holder: 5, flanker: 3 },
    budget: { maxActivePerSector: 2, maxActiveTotal: 4 } },
]);

/** One handle over everything above, for validators that sweep the whole slice at once. */
export const EXTRACTION_CONTENT = deepFreeze({
  lootTableVersion: LOOT_TABLE_VERSION,
  itemDefinitions: ITEM_DEFINITIONS,
  lootTables: LOOT_TABLES,
  poiTags: POI_TAGS,
  staticContainers: STATIC_CONTAINERS,
  exits: EXTRACTION_EXITS,
  runRules: RUN_RULES,
  aiProfiles: AI_PROFILES,
});
