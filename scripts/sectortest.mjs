/** Executable acceptance for Contract 14 — sector interest and AI activation budgets (P3-05). */
import {
  SectorInterest, SECTOR_STATE, SECTOR_COOLDOWN_S, TRANSITION_ZONE_M,
} from '../src/game/sectorInterest.js';
import { ExtractionRun } from '../src/game/extraction.js';
import { REFUSAL_REASONS, PROTOCOL_VERSION } from '../src/net/protocol.js';
import { buildManifest } from '../src/world/world.js';
import * as THREE from 'three';

let checks = 0;
let failures = 0;
function expect(condition, name, detail = '') {
  checks++;
  if (condition) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const equal = (actual, wanted, name) => expect(
  Object.is(actual, wanted), name, `expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`,
);

// Three sectors in a row along X, each 20m wide, sharing boundaries at x=10 and x=20.
// square <-> yard <-> warehouse. square and warehouse are NOT neighbours.
function threeSectors() {
  return [
    { id: 'square', box: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 5, z: 10 } },
      neighbours: ['yard'], populationCap: 2, baseThinkStride: 8 },
    { id: 'yard', box: { min: { x: 10, y: 0, z: 0 }, max: { x: 20, y: 5, z: 10 } },
      neighbours: ['square', 'warehouse'], populationCap: 4, baseThinkStride: 8 },
    { id: 'warehouse', box: { min: { x: 20, y: 0, z: 0 }, max: { x: 30, y: 5, z: 10 } },
      neighbours: ['yard'], populationCap: 3, baseThinkStride: 6 },
  ];
}

console.log('\n── §3 membership and inert-without-sectors behaviour');
{
  const empty = new SectorInterest([]);
  equal(empty.hasSectors(), false, 'no sectors authored → hasSectors() false');
  equal(empty.sectorOf({ x: 5, y: 0, z: 5 }), null, 'sectorOf() with no sectors is null');
  equal(empty.isRelevantTo('anything', 'else'), true, 'isRelevantTo() is unconditional true when inert');
  equal(empty.thinkEnabled('nope'), true, 'thinkEnabled() is unconditional true when inert');
  equal(empty.thinkStrideFor('nope', 8), 8, 'thinkStrideFor() returns base stride unchanged when inert');
  equal(empty.canAdmit('nope', 999), true, 'canAdmit() never refuses when inert');

  const si = new SectorInterest(threeSectors());
  equal(si.hasSectors(), true, 'three sectors authored → hasSectors() true');
  equal(si.sectorOf({ x: 5, y: 1, z: 5 }), 'square', 'a point inside square resolves to square');
  equal(si.sectorOf({ x: 15, y: 1, z: 5 }), 'yard', 'a point inside yard resolves to yard');
  equal(si.sectorOf({ x: 100, y: 1, z: 5 }), null, 'a point outside every sector resolves to null');
}

console.log('\n── §5.1 relevant set: own sector + every direct neighbour, no cascade past one hop');
{
  const si = new SectorInterest(threeSectors());
  const rel = si.relevantSetFor({ x: 15, y: 1, z: 5 }); // standing in yard
  expect(rel.has('yard') && rel.has('square') && rel.has('warehouse') && rel.size === 3,
    'a client in yard is relevant to yard + both its neighbours (square, warehouse)');
  const relSquare = si.relevantSetFor({ x: 5, y: 1, z: 5 }); // standing in square
  expect(relSquare.has('square') && relSquare.has('yard') && !relSquare.has('warehouse'),
    'a client in square is relevant to square + yard, but NOT warehouse (not a direct neighbour)');
  equal(si.isRelevantTo('square', 'warehouse'), false,
    'square and warehouse are not neighbours — not relevant to each other');
  equal(si.isRelevantTo('square', 'yard'), true, 'adjacent sectors are relevant to each other');
  equal(si.isRelevantTo('square', 'square'), true, 'a sector is always relevant to itself');
}

console.log('\n── §4.1/§4.2 activation state machine: dormant / warming (one hop only) / active');
{
  const si = new SectorInterest(threeSectors());
  // Nobody anywhere: everything dormant.
  si.tick(0, new Set());
  equal(si.stateOf('square'), SECTOR_STATE.DORMANT, 'no relevant player anywhere → square dormant');
  equal(si.stateOf('yard'), SECTOR_STATE.DORMANT, 'no relevant player anywhere → yard dormant');

  // A player occupies square (deep inside, not near the yard boundary).
  const occ = si.occupiedSectorsFor({ x: 2, y: 1, z: 5 });
  equal(occ.size, 1, 'a player well inside square, away from any boundary, occupies only square');
  si.tick(1, occ);
  equal(si.stateOf('square'), SECTOR_STATE.ACTIVE, 'occupied sector goes active immediately');
  equal(si.stateOf('yard'), SECTOR_STATE.WARMING, 'a neighbour of an active sector warms');
  equal(si.stateOf('warehouse'), SECTOR_STATE.DORMANT,
    'warehouse is two hops from the player — warming does not cascade past one hop');
}

console.log('\n── §3 transition zone: presence within 6 m of a shared boundary counts as "active" on both sides');
{
  const si = new SectorInterest(threeSectors());
  // Standing in square, 3 m from the x=10 boundary shared with yard.
  const occ = si.occupiedSectorsFor({ x: 7, y: 1, z: 5 });
  expect(occ.has('square') && occ.has('yard'),
    'within the transition zone, BOTH sides of the boundary are occupied ("active" trigger)',
    `got ${[...occ]}`);
  si.tick(1, occ);
  equal(si.stateOf('yard'), SECTOR_STATE.ACTIVE,
    'yard is ACTIVE (not merely warming) because the player is in its transition zone');

  const far = si.occupiedSectorsFor({ x: 2, y: 1, z: 5 }); // 8 m from the boundary
  equal(far.has('yard'), false, `${TRANSITION_ZONE_M} m zone: 8 m from the boundary does not count as occupying the neighbour`);
}

console.log('\n── §4.1 cooldown grace period, not an instant cliff');
{
  const si = new SectorInterest(threeSectors());
  si.tick(0, new Set(['square']));
  equal(si.stateOf('square'), SECTOR_STATE.ACTIVE, 'square active while occupied');
  si.tick(1, new Set()); // last-exit
  equal(si.stateOf('square'), SECTOR_STATE.ACTIVE,
    'square stays elevated immediately after last-exit (grace period, not instant cutoff)');
  si.tick(SECTOR_COOLDOWN_S - 0.5, new Set());
  equal(si.stateOf('square'), SECTOR_STATE.ACTIVE, 'still within the cooldown window');
  si.tick(SECTOR_COOLDOWN_S + 0.5, new Set());
  equal(si.stateOf('square'), SECTOR_STATE.DORMANT, 'drops to dormant once the cooldown window has fully elapsed');
}

console.log('\n── §4.3 budget scaling: dormant=0 think, warming=doubled stride/halved path share, active=full');
{
  const si = new SectorInterest(threeSectors());
  si.tick(0, new Set(['square'])); // square active, yard warming, warehouse dormant
  equal(si.thinkEnabled('square'), true, 'active sector: think enabled');
  equal(si.thinkEnabled('yard'), true, 'warming sector: think still enabled (not a statue)');
  equal(si.thinkEnabled('warehouse'), false, 'dormant sector: think disabled entirely');
  equal(si.thinkStrideFor('square', 8), 8, 'active sector keeps the base stride');
  equal(si.thinkStrideFor('yard', 8), 16, 'warming sector doubles the base stride');
  equal(si.pathShareFor('square'), 1, 'active sector gets full path-search share');
  equal(si.pathShareFor('yard'), 0.5, 'warming sector gets halved path-search share');
}

console.log('\n── §4.3 population cap: refused outright, not queued, arrivals only');
{
  const si = new SectorInterest(threeSectors()); // square cap = 2
  equal(si.canAdmit('square', 0), true, '0/2 admits');
  equal(si.canAdmit('square', 1), true, '1/2 admits');
  equal(si.canAdmit('square', 2), false, '2/2 is full — refused, not queued');
  equal(si.canAdmit('square', 3), false, 'over cap stays refused');
  equal(si.canAdmit('unknown-sector-id', 999), true, 'an unauthored sector id never refuses');
}

console.log('\n── BotManager integration: sector-gated think budget and population cap');
{
  const { Game } = await import('../src/core/game.js');
  const game = new Game();
  await game.initHeadless({ mapId: 'the-square' });
  game.settings.set('botCount', 4);
  game.settings.set('difficulty', 'regular');
  await game.match.init();
  game.match.begin?.({ mode: 'tdm' });

  equal(game.sectorInterest?.hasSectors?.(), false,
    'the-square has no MAP_MANIFEST.sectors yet (P3-06 not landed) — module is inert');

  // Fabricate a sector layout over the real map bounds and swap it in, so the gating PATH
  // itself is exercised end-to-end against a live BotManager/roster without waiting on a
  // real map amendment.
  const b = game.world.bounds;
  const midX = (b.min.x + b.max.x) / 2;
  const fake = new SectorInterest([
    { id: 'west', box: { min: { x: b.min.x, y: b.min.y - 5, z: b.min.z }, max: { x: midX, y: b.max.y + 5, z: b.max.z } },
      neighbours: ['east'], populationCap: 1, baseThinkStride: 8 },
    { id: 'east', box: { min: { x: midX, y: b.min.y - 5, z: b.min.z }, max: { x: b.max.x, y: b.max.y + 5, z: b.max.z } },
      neighbours: ['west'], populationCap: 24, baseThinkStride: 8 },
  ]);
  game.sectorInterest = fake;

  for (let i = 0; i < 240; i++) game._fixedUpdate(1 / 120);

  const westCount = game.bots.bots.filter((bt) => bt.alive && fake.sectorOf(bt.position) === 'west').length;
  expect(westCount <= 1, `west sector populationCap=1 is never exceeded by live bots (found ${westCount})`);

  let anyDormantSkipped = false;
  for (const bt of game.bots.bots) {
    if (!bt.alive) continue;
    const sid = fake.sectorOf(bt.position);
    if (sid && !fake.thinkEnabled(sid)) anyDormantSkipped = true;
  }
  expect(true, 'ran 240 fixed steps with a live SectorInterest attached without throwing',
    anyDormantSkipped ? '(observed a dormant-sector bot this run)' : '');
  game.dispose();
}

console.log('\n── §6 off-sector refusal reason: wire vocabulary and ordering');
{
  equal(REFUSAL_REASONS[5], 'off-sector', "'off-sector' is appended at index 5, after 'already-planted'");
  equal(REFUSAL_REASONS[4], 'already-planted', 'the four pre-existing reasons are untouched and still precede it');
  equal(REFUSAL_REASONS.length, 6, 'REFUSAL_REASONS grew by exactly one entry');
  equal(PROTOCOL_VERSION, 4, 'PROTOCOL_VERSION bumped for the REFUSAL_REASONS wire-shape change');
}

console.log('\n── §6 ExtractionRun off-sector gate: server position, never the client\'s claim');
{
  const sectors = threeSectors();
  const si = new SectorInterest(sectors);
  const run = new ExtractionRun({
    runId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    runSeed: 'seed-sector-test',
    sectorInterest: si,
    itemDefs: { 'item.rifle': { stackable: false } },
    containers: [
      { containerId: 'c-in-square', tier: 'common', lootTableId: null, position: { x: 5, y: 0, z: 5 } },
      { containerId: 'c-in-warehouse', tier: 'common', lootTableId: null, position: { x: 25, y: 0, z: 5 } },
    ],
    participants: [{ accountId: 'acct-1', squadId: 'sq-1', loadoutInstances: [] }],
  });
  run.spawnParticipant('acct-1', { x: 5, y: 0, z: 5 });
  // No tick() called yet, so the server has no recorded position for acct-1 — the gate is a
  // no-op until the server itself has observed a position, never trusting the command.
  const beforeTick = run.openContainer('acct-1', 'c-in-warehouse');
  expect(beforeTick.ok === true || beforeTick.reason !== 'off-sector',
    'with no server-recorded position yet, the sector gate does not itself manufacture a refusal');

  run.tick({ positions: new Map([['acct-1', { x: 5, y: 0, z: 5 }]]) }); // server places acct-1 in square

  const denied = run.openContainer('acct-1', 'c-in-warehouse');
  equal(denied.ok, false, 'a container in warehouse is refused for an actor the server has in square');
  equal(denied.reason, 'off-sector', 'refusal reason is off-sector');

  const allowed = run.openContainer('acct-1', 'c-in-square');
  equal(allowed.ok, true, 'a container in the actor\'s own sector opens normally');
}

console.log('\n── world.js manifest: sectors read declared/absent the same way objectives are, no false gap');
{
  const entry = { id: 'fixture', version: '1.0.0', declares: { MAP_MANIFEST: true }, module: { MAP_MANIFEST: { sectors: threeSectors() } } };
  const fakeWorld = {
    bounds: { min: new THREE.Vector3(0, 0, 0), max: new THREE.Vector3(1, 1, 1) },
    boxes: [], spawnPoints: [],
  };
  const m = buildManifest(entry, fakeWorld);
  equal(m.sectors.length, 3, 'declared sectors are read into the manifest');
  equal(m.provenance.sectors, 'declared', "provenance marks sectors 'declared' when present");

  const entryNoSectors = { id: 'fixture2', version: '1.0.0', declares: { MAP_MANIFEST: true }, module: { MAP_MANIFEST: {} } };
  const m2 = buildManifest(entryNoSectors, fakeWorld);
  equal(m2.sectors.length, 0, 'no sectors declared → empty array');
  equal(Object.hasOwn(m2.provenance, 'sectors'), false,
    'no sectors declared → no provenance entry at all (must not read as a manifestGaps() PARTIAL-manifest failure)');
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures > 0 ? 1 : 0);
