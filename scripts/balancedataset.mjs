/**
 * Balance dataset export — P4-06.
 *
 * Turns `src/game/extractionContent.js` (the single authored source for item definitions,
 * loot tables, POI tags, run rules, and AI profiles — extraction-match.md/dynamic-events.md's
 * DATA layer, not the mechanism) into a flat, reviewable summary a human playtester or
 * designer can read without opening source. This is TOOLING ONLY: it reads the shipped
 * module and reshapes it. It invents no content, computes no new balance numbers beyond
 * arithmetic already implied by the authored fields (expected value from weight × quantity,
 * loot-table weight sums, per-sector AI budget totals) and writes nothing back.
 *
 * The positional loot-container/exit authority lives on the map entry
 * (`SQUARE_EXTRACTION.LOOT_CONTAINERS` / `.EXTRACTION_EXITS` in `src/world/level.js`, per
 * extractionContent.js's own REQ-CC-075 note) — this script cross-references container →
 * loot-table-tier counts from there too, read-only, so the export answers "how many
 * containers actually roll each table" and not just "what tables exist in the abstract".
 * It does not touch level.js.
 *
 * Usage:
 *   node scripts/balancedataset.mjs                 human-readable table report to stdout
 *   node scripts/balancedataset.mjs --json           machine-readable JSON to stdout
 *   node scripts/balancedataset.mjs --out=<path>      write the JSON export to a file
 *   node scripts/balancedataset.mjs --map=<mapId>     which level.js map entry to cross-
 *                                                       reference container counts against
 *                                                       (default: square-extraction)
 */
import { writeFile } from 'node:fs/promises';
import {
  LOOT_TABLE_VERSION, ITEM_DEFINITIONS, LOOT_TABLES, POI_TAGS, RUN_RULES, AI_PROFILES,
} from '../src/game/extractionContent.js';
import * as levelModule from '../src/world/level.js';

const args = Object.fromEntries(
  process.argv.slice(2)
    .map((a) => a.match(/^--([^=]+)(?:=(.*))?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2] ?? true]),
);
const mapId = typeof args.map === 'string' ? args.map : 'square-extraction';

// ── level.js cross-reference: how many placed containers actually use each loot table ──
//
// level.js exports one registry object per map (e.g. `SQUARE_EXTRACTION`) holding
// `LOOT_CONTAINERS`. Rather than hardcode the export name, find the entry whose own `.id`
// (or `.mapId`) matches, falling back to `SQUARE_EXTRACTION` by name for the shipped default.
function findMapEntry(id) {
  for (const value of Object.values(levelModule)) {
    if (value && typeof value === 'object'
      && (value.id === id || value.mapId === id || value.MAP_ID === id)) return value;
  }
  return levelModule.SQUARE_EXTRACTION ?? null;
}
const mapEntry = findMapEntry(mapId);
const containers = Array.isArray(mapEntry?.LOOT_CONTAINERS) ? mapEntry.LOOT_CONTAINERS : [];
const exits = Array.isArray(mapEntry?.EXTRACTION_EXITS) ? mapEntry.EXTRACTION_EXITS : [];

const containerCountByTable = {};
for (const c of containers) {
  const key = c.lootTableId ?? '(none)';
  containerCountByTable[key] = (containerCountByTable[key] || 0) + 1;
}

// ── item definitions, grouped ──────────────────────────────────────────────────────────
const itemsByClass = {};
for (const d of ITEM_DEFINITIONS) {
  (itemsByClass[d.class] ??= []).push(d.itemId);
}

// ── loot tables: per-entry expected value + weight-sum sanity, plus item cross-refs ─────
const definedItemIds = new Set(ITEM_DEFINITIONS.map((d) => d.itemId));
const lootTableRows = Object.entries(LOOT_TABLES).map(([tableId, table]) => {
  const entries = table.entries.map((e) => ({
    id: e.id,
    itemId: e.itemId,
    weight: e.weight,
    quantity: e.quantity,
    stackable: e.stackable,
    expectedQuantity: Math.round(e.weight * e.quantity * 1000) / 1000,
    itemDefined: definedItemIds.has(e.itemId),
  }));
  const weightSum = Math.round(entries.reduce((s, e) => s + e.weight, 0) * 1000) / 1000;
  return {
    tableId,
    tier: table.tier,
    entryCount: entries.length,
    weightSum,
    placedContainerCount: containerCountByTable[tableId] || 0,
    entries,
  };
});

// ── AI profile budgets, and the totals a director/sector cap has to respect ─────────────
const aiProfileRows = AI_PROFILES.map((p) => ({
  profileId: p.profileId,
  difficulty: p.difficulty,
  personalityWeights: p.personalityWeights,
  maxActivePerSector: p.budget.maxActivePerSector,
  maxActiveTotal: p.budget.maxActiveTotal,
}));
const budgetTotals = {
  sumMaxActivePerSector: aiProfileRows.reduce((s, p) => s + p.maxActivePerSector, 0),
  sumMaxActiveTotal: aiProfileRows.reduce((s, p) => s + p.maxActiveTotal, 0),
};

// ── POI tags, grouped by referenced loot tier ────────────────────────────────────────────
const poiByTier = {};
for (const p of POI_TAGS) (poiByTier[p.lootTier] ??= []).push(p.poiId);

const dataset = {
  generatedAt: new Date().toISOString(),
  source: 'src/game/extractionContent.js',
  mapCrossReference: mapId,
  lootTableVersion: LOOT_TABLE_VERSION,
  runRules: RUN_RULES,
  itemDefinitions: {
    total: ITEM_DEFINITIONS.length,
    byClass: Object.fromEntries(Object.entries(itemsByClass).map(([k, v]) => [k, v.length])),
    itemsByClass,
  },
  lootTables: lootTableRows,
  containersByMap: {
    total: containers.length,
    exits: exits.length,
    byLootTable: containerCountByTable,
  },
  poiTags: {
    total: POI_TAGS.length,
    byLootTier: Object.fromEntries(Object.entries(poiByTier).map(([k, v]) => [k, v.length])),
  },
  aiProfiles: {
    profiles: aiProfileRows,
    budgetTotals,
  },
};

// ── issues worth a human's attention: weight sums outside a sane band, undefined item refs ──
const issues = [];
for (const t of lootTableRows) {
  if (t.weightSum <= 0) issues.push(`${t.tableId}: weight sum is ${t.weightSum} (no entry can ever roll)`);
  for (const e of t.entries) {
    if (!e.itemDefined) issues.push(`${t.tableId}/${e.id}: itemId "${e.itemId}" has no ITEM_DEFINITIONS entry`);
  }
  if (t.placedContainerCount === 0) issues.push(`${t.tableId}: zero placed containers on map "${mapId}" reference it`);
}
dataset.issues = issues;

if (args.json || args.out) {
  const json = JSON.stringify(dataset, null, 2);
  if (typeof args.out === 'string') {
    await writeFile(args.out, json + '\n', 'utf8');
    console.log(`wrote ${args.out} (${json.length} bytes)`);
  } else {
    console.log(json);
  }
  process.exit(issues.length > 0 ? 0 : 0); // report only, never a gate — see header
}

// ── human-readable report ────────────────────────────────────────────────────────────────
console.log(`Balance dataset — extractionContent.js (${LOOT_TABLE_VERSION})`);
console.log(`Map cross-reference: ${mapId}${mapEntry ? '' : '  (NOT FOUND — container counts are 0)'}\n`);

console.log('Run rules:');
for (const [k, v] of Object.entries(RUN_RULES)) console.log(`  ${k}: ${v}`);

console.log('\nItem definitions by class:');
for (const [cls, ids] of Object.entries(itemsByClass)) {
  console.log(`  ${cls} (${ids.length}): ${ids.join(', ')}`);
}

console.log('\nLoot tables:');
for (const t of lootTableRows) {
  console.log(`  ${t.tableId}  tier=${t.tier}  entries=${t.entryCount}  weightSum=${t.weightSum}  placedContainers=${t.placedContainerCount}`);
  for (const e of t.entries) {
    const flag = e.itemDefined ? '' : '  [UNDEFINED ITEM]';
    console.log(`    ${e.id.padEnd(14)} ${e.itemId.padEnd(20)} w=${e.weight}  qty=${e.quantity}  E[qty]=${e.expectedQuantity}${flag}`);
  }
}

console.log('\nContainers on map (by loot table):');
for (const [table, count] of Object.entries(containerCountByTable)) console.log(`  ${table}: ${count}`);
console.log(`  exits: ${exits.length}`);

console.log('\nPOI tags by loot tier:');
for (const [tier, ids] of Object.entries(poiByTier)) console.log(`  tier ${tier} (${ids.length}): ${ids.join(', ')}`);

console.log('\nAI profiles:');
for (const p of aiProfileRows) {
  const weights = Object.entries(p.personalityWeights).map(([k, v]) => `${k}:${v}`).join(' ');
  console.log(`  ${p.profileId}  difficulty=${p.difficulty}  maxActivePerSector=${p.maxActivePerSector}  maxActiveTotal=${p.maxActiveTotal}  [${weights}]`);
}
console.log(`  sum(maxActivePerSector)=${budgetTotals.sumMaxActivePerSector}  sum(maxActiveTotal)=${budgetTotals.sumMaxActiveTotal}`);

if (issues.length) {
  console.log(`\nIssues (${issues.length}) — report only, not a gate:`);
  for (const i of issues) console.log(`  - ${i}`);
} else {
  console.log('\nNo issues found.');
}
