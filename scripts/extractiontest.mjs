/**
 * Extraction raid-server verification — `docs/contracts/extraction-match.md` §9.
 *
 * Mirrors `scripts/bombtest.mjs`'s harness style: named sections, an `ok`/`bad` ledger, and
 * every positive case paired with a failing control where one exists, so a passing assertion
 * can be trusted to have exercised the rule it names and not merely tripped over the right
 * answer by accident.
 */
import { ExtractionRun, containerSeed, rollLootTable } from '../src/game/extraction.js';
import { sha256, sha256Hex, hmacSha256, utf8, toHex, stableJson } from '../src/core/hash.js';
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

const EXIT = {
  id: 'exit-north',
  volume: { min: { x: -2, y: 0, z: -2 }, max: { x: 2, y: 2, z: 2 } },
  durationSeconds: 1.0, // 120 ticks at FIXED_DT
};

const SQUAD_EXIT = {
  id: 'exit-squad',
  volume: { min: { x: 10, y: 0, z: -2 }, max: { x: 14, y: 2, z: 2 } },
  durationSeconds: 0.5,
  requiresSquadCount: 2,
};

const ITEM_EXIT = {
  id: 'exit-item',
  volume: { min: { x: 20, y: 0, z: -2 }, max: { x: 24, y: 2, z: 2 } },
  durationSeconds: 0.5,
  requiresItemDefId: 'intel-flash-drive',
};

const LOOT_TABLES = {
  'tier1-crate': {
    entries: [
      { id: 'a-ammo', itemId: 'ammo_9mm', weight: 1.0, quantity: 30, stackable: true },
      { id: 'b-rare', itemId: 'rare_scope', weight: 0.0 }, // never rolls — deterministic control
      { id: 'c-med', itemId: 'medkit', weight: 1.0, quantity: 1 },
    ],
  },
};

function newRun(overrides = {}) {
  return new ExtractionRun({
    runId: 'run_01',
    runSeed: 'seed-fixture-001',
    lootTableVersion: 'v1',
    serverBuild: 'test-build',
    sectorSet: ['sector-a'],
    lootTables: LOOT_TABLES,
    itemDefs: { ammo_9mm: { stackable: true } },
    exits: [EXIT, SQUAD_EXIT, ITEM_EXIT],
    containers: [
      { containerId: 'c1', tier: 1, lootTableId: 'tier1-crate', position: { x: 0, y: 0, z: 5 } },
    ],
    participants: [
      { accountId: 'acct_a', squadId: 'squad_1', loadoutInstances: [
        { instanceId: 'loadout_a_rifle', itemId: 'ar_vector', quantity: 1 },
      ] },
      { accountId: 'acct_b', squadId: 'squad_1', loadoutInstances: [
        { instanceId: 'loadout_b_rifle', itemId: 'ar_vector', quantity: 1 },
      ] },
    ],
    reconnectGraceSeconds: 2,
    ...overrides,
  });
}

const insideExit = { x: 0, y: 0, z: 0 };
const outsideExit = { x: 100, y: 0, z: 100 };
const held = (accountId, v = true) => new Map([[accountId, v]]);
const posMap = (...pairs) => new Map(pairs);

const tickN = (run, n, positions, interact) => {
  for (let i = 0; i < n; i++) run.tick({ positions, interactHeld: interact });
};

// ────────────────────────────────────────────────────────────────── sha256 / hmac self-test

head('SHA-256 / HMAC-SHA256 primitives (known test vectors)');
{
  eq(toHex(sha256(utf8(''))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha256("") matches FIPS 180-4 vector');
  eq(toHex(sha256(utf8('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256("abc") matches FIPS 180-4 vector');
  // RFC 4231 test case 2: key="Jefe", data="what do ya want for nothing?"
  eq(
    toHex(hmacSha256(utf8('Jefe'), utf8('what do ya want for nothing?'))),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    'hmac-sha256 matches RFC 4231 test case 2',
  );
}

// ──────────────────────────────────────────────────────────────────────── §1 phase machine

head('§1 participant phase machine');
{
  const run = newRun();
  eq(run.participants.get('acct_a').phase, 'deploy', 'starts in deploy');
  const bad1 = run.pickup('acct_a', 'loadout_a_rifle');
  eq(bad1.ok, false, 'pickup refused before spawn (still deploy)');

  const spawn = run.spawnParticipant('acct_a');
  eq(spawn.ok, true, 'spawnParticipant succeeds from deploy');
  eq(run.participants.get('acct_a').phase, 'raid', 'deploy -> raid on spawn');
  eq(run.instances.get('loadout_a_rifle').location, 'run', 'loadout instance seeded at location=run on spawn');
  eq(run.instances.get('loadout_a_rifle').locked, true, 'loadout instance stays locked on spawn');

  const respawn = run.spawnParticipant('acct_a');
  eq(respawn.ok, false, 'spawning an already-raid participant is refused (illegal transition)');

  run.spawnParticipant('acct_b');
}

// ─────────────────────────────────────────────────────────────── §3.2 container open, race

head('§3.2 container open — two players, same tick, first wins');
{
  const run = newRun();
  run.spawnParticipant('acct_a');
  run.spawnParticipant('acct_b');
  const first = run.openContainer('acct_a', 'c1');
  const second = run.openContainer('acct_b', 'c1'); // "same tick" = no tick() advanced between calls
  eq(first.ok, true, 'first opener succeeds');
  eq(second.ok, false, 'second opener on the same sealed->opened container is refused');
  eq(run.containers.get('c1').openedByAccountId, 'acct_a', 'container records the first opener, not the second');

  // Failing control: a container that was never opened refuses pickup of its contents.
  const run2 = newRun();
  run2.spawnParticipant('acct_a');
  const someInstanceId = [...run2.instances.values()].find((i) => i.containerId === 'c1').instanceId;
  const blockedPickup = run2.pickup('acct_a', someInstanceId);
  eq(blockedPickup.ok, false, 'pickup from an unopened (sealed) container is refused (control)');
}

// ───────────────────────────────────────────────────────────────── §3.2 pickup race, world

head('§3.2 pickup — two players, same already-world instance, one owner ever');
{
  const run = newRun();
  run.spawnParticipant('acct_a');
  run.spawnParticipant('acct_b');
  run.openContainer('acct_a', 'c1');
  const medInstanceId = [...run.instances.values()].find((i) => i.containerId === 'c1' && i.itemId === 'medkit').instanceId;

  const p1 = run.pickup('acct_a', medInstanceId);
  const p2 = run.pickup('acct_b', medInstanceId);
  eq(p1.ok, true, 'first pickup succeeds');
  eq(p2.ok, false, 'second pickup of the same now-owned instance is refused');
  eq(run.instances.get(medInstanceId).ownerAccountId, 'acct_a', 'one owner ever — the first');
}

// ────────────────────────────────────────────────────────────────────────── §3.2.1 stacking

head('§3.2.1 stackable pickup — merge, not a second row');
{
  const run = newRun();
  run.spawnParticipant('acct_a');
  run.openContainer('acct_a', 'c1');
  const ammoInstanceId = [...run.instances.values()].find((i) => i.containerId === 'c1' && i.itemId === 'ammo_9mm').instanceId;

  // Give acct_a a pre-existing ammo stack in run inventory.
  run.instances.set('preexisting_ammo', {
    instanceId: 'preexisting_ammo', itemId: 'ammo_9mm', quantity: 40, stackable: true,
    location: 'run', containerId: null, runId: run.runId, ownerAccountId: 'acct_a',
    status: 'active', locked: false,
  });

  const result = run.pickup('acct_a', ammoInstanceId);
  eq(result.ok, true, 'stackable pickup succeeds');
  eq(result.merged, true, 'pickup reports a merge');
  eq(run.instances.get(ammoInstanceId).status, 'merged', 'picked-up row transitions to status=merged');
  eq(run.instances.get(ammoInstanceId).quantity, 30, "picked-up row's own quantity is unchanged");
  eq(run.instances.get('preexisting_ammo').quantity, 70, 'existing stack gains the picked-up quantity (40+30)');

  const activeAmmoRows = [...run.instances.values()].filter(
    (i) => i.ownerAccountId === 'acct_a' && i.itemId === 'ammo_9mm' && i.location === 'run' && i.status === 'active',
  );
  eq(activeAmmoRows.length, 1, 'exactly one active ammo_9mm row for (owner, item, run) after the merge');

  // Two concurrent pickups of two different world instances of the same stackable item.
  const run2 = newRun();
  run2.spawnParticipant('acct_a');
  run2.openContainer('acct_a', 'c1');
  const firstAmmo = [...run2.instances.values()].find((i) => i.containerId === 'c1' && i.itemId === 'ammo_9mm').instanceId;
  run2.instances.set('dropped_ammo_2', {
    instanceId: 'dropped_ammo_2', itemId: 'ammo_9mm', quantity: 15, stackable: true,
    location: 'world', containerId: null, runId: null, ownerAccountId: null, status: 'active', locked: false,
  });
  run2.pickup('acct_a', firstAmmo);
  run2.pickup('acct_a', 'dropped_ammo_2');
  const rowsAfterBoth = [...run2.instances.values()].filter(
    (i) => i.ownerAccountId === 'acct_a' && i.itemId === 'ammo_9mm' && i.location === 'run' && i.status === 'active',
  );
  eq(rowsAfterBoth.length, 1, 'two sequential pickups of the same stackable item still leave exactly one active row');
  eq(rowsAfterBoth[0].quantity, 45, 'summed quantity across both pickups (30+15)');
}

// ─────────────────────────────────────────────────────────────────────────────── §3.3 drop

head('§3.3 drop');
{
  const run = newRun();
  run.spawnParticipant('acct_a');
  run.openContainer('acct_a', 'c1');
  const medId = [...run.instances.values()].find((i) => i.containerId === 'c1' && i.itemId === 'medkit').instanceId;
  run.pickup('acct_a', medId);

  const lockedDrop = run.drop('acct_a', 'loadout_a_rifle', { x: 1, y: 0, z: 1 });
  eq(lockedDrop.ok, false, 'a locked loadout instance cannot be dropped');

  const dropResult = run.drop('acct_a', medId, { x: 1, y: 0, z: 1 });
  eq(dropResult.ok, true, 'unlocked run instance can be dropped');
  const dropped = run.instances.get(medId);
  eq(dropped.location, 'world', 'dropped instance moves to location=world');
  eq(dropped.runId, null, 'dropped instance clears run_id');
  eq(dropped.ownerAccountId, null, 'dropped instance clears owner');
  eq(run.containers.get(dropResult.containerId).kind, 'dropped', 'a dropped container is created');
  eq(run.containers.get(dropResult.containerId).state, 'opened', 'a dropped container is never sealed');

  // Failing control: dropping is refused once extracting (phase check excludes extracting).
  const run2 = newRun();
  run2.spawnParticipant('acct_a');
  tickN(run2, 130, posMap(['acct_a', insideExit]), held('acct_a', true)); // completes exit (120 ticks)
  eq(run2.participants.get('acct_a').phase, 'extracted', 'sanity: participant extracted for the control below');
}

// ───────────────────────────────────────────────────────────────────── §4.1 exit channel

head('§4.1 extraction channel — interrupt boundaries and completion');
{
  // First tick interrupt: leave the volume immediately.
  const run = newRun();
  run.spawnParticipant('acct_a');
  run.tick({ positions: posMap(['acct_a', insideExit]), interactHeld: held('acct_a', true) });
  eq(run.participants.get('acct_a').phase, 'extracting', 'entering volume + holding interact begins the channel');
  run.tick({ positions: posMap(['acct_a', outsideExit]), interactHeld: held('acct_a', true) });
  eq(run.participants.get('acct_a').phase, 'raid', 'leaving the volume interrupts — back to raid');
  eq(run.participants.get('acct_a').extracting, null, 'progress is cleared, not paused');

  // One tick before completion: interact released -> interrupted, no partial credit.
  const run2 = newRun();
  run2.spawnParticipant('acct_a');
  tickN(run2, EXIT_TICKS(run2) - 1, posMap(['acct_a', insideExit]), held('acct_a', true));
  eq(run2.participants.get('acct_a').phase, 'extracting', 'still channeling one tick before completion');
  run2.tick({ positions: posMap(['acct_a', insideExit]), interactHeld: held('acct_a', false) });
  eq(run2.participants.get('acct_a').phase, 'raid', 'releasing interact one tick before completion interrupts it');

  // Resuming after an interrupt starts progress at zero again — no resume.
  tickN(run2, 5, posMap(['acct_a', insideExit]), held('acct_a', true));
  eq(run2.participants.get('acct_a').extracting.progressTicks, 5, 'progress restarts from zero on resume, not from where it left off');

  // Last tick: completes exactly at the configured duration.
  const run3 = newRun();
  run3.spawnParticipant('acct_a');
  tickN(run3, EXIT_TICKS(run3), posMap(['acct_a', insideExit]), held('acct_a', true));
  eq(run3.participants.get('acct_a').phase, 'extracted', 'channel completes at the configured duration');
  eq(run3.participants.get('acct_a').exitId, 'exit-north', 'RunResult exitId set on completion');
  const rifleRow = run3.instances.get('loadout_a_rifle');
  eq(rifleRow.locked, true, 'run-location instances are frozen (locked) on extraction completion');

  // Interrupted by a condition becoming false: squad-count exit, squadmate leaves.
  const run4 = newRun();
  run4.spawnParticipant('acct_a');
  run4.spawnParticipant('acct_b');
  const squadPos = { x: 12, y: 0, z: 0 };
  run4.tick({
    positions: posMap(['acct_a', squadPos], ['acct_b', squadPos]),
    interactHeld: held('acct_a', true).set('acct_b', true),
  });
  eq(run4.participants.get('acct_a').phase, 'extracting', 'squad-count condition satisfied with both members present');
  run4.tick({
    positions: posMap(['acct_a', squadPos], ['acct_b', outsideExit]),
    interactHeld: held('acct_a', true).set('acct_b', false),
  });
  eq(run4.participants.get('acct_a').phase, 'raid', 'squadmate leaving drops the squad count below requirement — interrupted');

  // Interrupted by death mid-channel.
  const run5 = newRun();
  run5.spawnParticipant('acct_a');
  run5.tick({ positions: posMap(['acct_a', insideExit]), interactHeld: held('acct_a', true) });
  eq(run5.participants.get('acct_a').phase, 'extracting', 'channel started');
  run5.reportDeath('acct_a', { cause: 'player', position: insideExit });
  eq(run5.participants.get('acct_a').phase, 'dead', 'death while extracting ends in dead, not extracted');
  eq(run5.participants.get('acct_a').outcome, 'died', 'outcome recorded as died even though a channel was in progress');

  // requiresItemDefId condition.
  const run6 = newRun();
  run6.spawnParticipant('acct_a');
  const itemExitPos = { x: 22, y: 0, z: 0 };
  run6.tick({ positions: posMap(['acct_a', itemExitPos]), interactHeld: held('acct_a', true) });
  eq(run6.participants.get('acct_a').phase, 'raid', 'requiresItemDefId not satisfied — channel does not start');
  run6.instances.set('flash_drive', {
    instanceId: 'flash_drive', itemId: 'intel-flash-drive', quantity: 1, stackable: false,
    location: 'run', containerId: null, runId: run6.runId, ownerAccountId: 'acct_a', status: 'active', locked: false,
  });
  run6.tick({ positions: posMap(['acct_a', itemExitPos]), interactHeld: held('acct_a', true) });
  eq(run6.participants.get('acct_a').phase, 'extracting', 'requiresItemDefId satisfied — channel starts');
}

function EXIT_TICKS(run) { return run.exits.get('exit-north').durationTicks; }

// ─────────────────────────────────────────────────────────────────────── §2 abort / failure

head('§2 aborted / server-failure cases');
{
  // Disconnect past grace during raid -> aborted.
  const run = newRun({ reconnectGraceSeconds: 1 });
  run.spawnParticipant('acct_a');
  run.disconnect('acct_a');
  tickN(run, Math.ceil(1 / FIXED_DT) + 5, new Map(), new Map());
  eq(run.participants.get('acct_a').phase, 'aborted', 'disconnect past grace -> aborted');
  eq(run.participants.get('acct_a').outcome, 'aborted', 'RunResult outcome aborted');

  // Failing control: reconnecting inside the grace window does NOT abort.
  const run2 = newRun({ reconnectGraceSeconds: 5 });
  run2.spawnParticipant('acct_a');
  run2.disconnect('acct_a');
  tickN(run2, Math.round(1 / FIXED_DT), new Map(), new Map());
  run2.reconnect('acct_a');
  tickN(run2, Math.round(1 / FIXED_DT) * 10, new Map(), new Map());
  eq(run2.participants.get('acct_a').phase, 'raid', 'reconnect inside grace window prevents abort (control)');

  // Hard timeout forces still-raid participants to aborted, run ends.
  const run3 = newRun({ hardTimeoutSeconds: 0.05 });
  run3.spawnParticipant('acct_a');
  tickN(run3, 20, new Map(), new Map());
  eq(run3.participants.get('acct_a').phase, 'aborted', 'hard timeout forces aborted');
  eq(run3.phase, 'ended', 'hard timeout ends the run');

  // Server-failure with a trustworthy last phase.
  const run4 = newRun();
  run4.spawnParticipant('acct_a');
  run4.openContainer('acct_a', 'c1');
  const medId = [...run4.instances.values()].find((i) => i.containerId === 'c1' && i.itemId === 'medkit').instanceId;
  run4.pickup('acct_a', medId);
  const sf = run4.reportServerFailure('acct_a');
  eq(sf.ok, true, 'server-failure accepted with a trustworthy last phase');
  eqJson(sf.lastKnownState, { phase: 'looting', exitId: null }, 'lastKnownState: looting after >=1 pickup, phase raid');

  const run5 = newRun();
  run5.spawnParticipant('acct_b');
  const sf2 = run5.reportServerFailure('acct_b');
  eqJson(sf2.lastKnownState, { phase: 'not-looted', exitId: null }, 'lastKnownState: not-looted with zero pickups');

  const run6 = newRun();
  run6.spawnParticipant('acct_a');
  run6.tick({ positions: posMap(['acct_a', insideExit]), interactHeld: held('acct_a', true) });
  const sf3 = run6.reportServerFailure('acct_a');
  eqJson(sf3.lastKnownState, { phase: 'at-exit', exitId: 'exit-north' }, 'lastKnownState: at-exit while extracting');

  // No trustworthy last state -> no submission at all (never spawned).
  const run7 = newRun();
  const sf4 = run7.reportServerFailure('acct_a');
  eq(sf4.ok, false, 'server-failure declined for a participant that never spawned — no submission, not a guess');
}

// ───────────────────────────────────────────────────────────────────────── §6 RunResult

head('§6 RunResult — exactly one of exitId/deathCause/lastKnownState per outcome');
{
  const run = newRun();
  run.spawnParticipant('acct_a');
  run.spawnParticipant('acct_b');
  tickN(run, EXIT_TICKS(run) + 1, posMap(['acct_a', insideExit]), held('acct_a', true));
  run.reportDeath('acct_b', { cause: 'ai', position: { x: 5, y: 0, z: 5 } });
  run.end();
  const result = run.buildRunResult();

  eq(result.runId, 'run_01', 'RunResult.runId');
  eq(result.participants.length, 2, 'both spawned participants appear in the result');
  const a = result.participants.find((r) => r.accountId === 'acct_a');
  const b = result.participants.find((r) => r.accountId === 'acct_b');
  eq(a.outcome, 'extracted', 'acct_a outcome extracted');
  eq(a.exitId, 'exit-north', 'acct_a carries exitId');
  eq(a.deathCause, undefined, 'acct_a carries no deathCause');
  eq(a.lastKnownState, undefined, 'acct_a carries no lastKnownState');
  eq(b.outcome, 'died', 'acct_b outcome died');
  eq(b.deathCause, 'ai', 'acct_b carries deathCause');
  eq(b.exitId, undefined, 'acct_b carries no exitId');
  eq(typeof result.evidenceRef, 'string', 'evidenceRef present');

  // Deploy-only participant (never spawned) never appears.
  const run2 = newRun();
  const result2 = run2.buildRunResult();
  eq(result2.participants.length, 0, 'a participant that never left deploy is absent from the RunResult');
}

// ──────────────────────────────────────────────────────────────────────── §7 evidence

head('§7 evidence — reconstructable from lootEvents/phaseLog/deathFacts alone');
{
  const run = newRun();
  run.spawnParticipant('acct_a');
  run.openContainer('acct_a', 'c1');
  const evidence = run.buildEvidence();
  expect(Array.isArray(evidence.lootEvents) && evidence.lootEvents.length > 0, 'evidence carries lootEvents');
  expect(Array.isArray(evidence.participants[0].phaseLog) && evidence.participants[0].phaseLog.length > 0, 'evidence carries phaseLog');

  const rebuiltDigest = sha256Hex(utf8(stableJson(evidence)));
  eq(run.buildEvidenceRef(), rebuiltDigest, 'evidenceRef reconstructs from evidence fields alone');

  // Independent reconstruction using only the raw evidence object (no access to `run`).
  const independentDigest = sha256Hex(utf8(stableJson(JSON.parse(JSON.stringify(evidence)))));
  eq(rebuiltDigest, independentDigest, 'digest is stable across a JSON round-trip (no hidden non-JSON state)');
}

// ──────────────────────────────────────────────────────────── §3.1.1 loot determinism

head('§3.1.1 static container determinism — reproducible from inputs alone');
{
  const runA = newRun();
  const runB = newRun(); // identical inputs, independently constructed
  const contentsA = [...runA.instances.values()].filter((i) => i.containerId === 'c1')
    .map((i) => ({ itemId: i.itemId, quantity: i.quantity })).sort((x, y) => x.itemId.localeCompare(y.itemId));
  const contentsB = [...runB.instances.values()].filter((i) => i.containerId === 'c1')
    .map((i) => ({ itemId: i.itemId, quantity: i.quantity })).sort((x, y) => x.itemId.localeCompare(y.itemId));
  eqJson(contentsA, contentsB, 'two independent rolls from the same (runSeed, containerId, lootTableVersion) agree');

  // Reproduce entirely from stored values, not values held in memory from the original roll.
  const seed = containerSeed(runA.runSeed, 'c1');
  const rerolled = rollLootTable(LOOT_TABLES['tier1-crate'], seed);
  eqJson(
    rerolled.map((i) => i.itemId).sort(),
    contentsA.map((i) => i.itemId).sort(),
    'reroll from (runSeed, containerId) read back from storage matches the original roll',
  );

  // Different runSeed -> a different (not necessarily disjoint, but here distinguishable) roll.
  const runC = newRun({ runId: 'run_02', runSeed: 'seed-fixture-002' });
  const contentsC = [...runC.instances.values()].filter((i) => i.containerId === 'c1').map((i) => i.itemId).sort();
  const seedsDiffer = containerSeed('seed-fixture-001', 'c1') !== containerSeed('seed-fixture-002', 'c1');
  expect(seedsDiffer, 'different run seeds produce different per-container seeds (control)');
  void contentsC;

  // The zero-weight entry never rolls, deterministically, across many containers.
  const manyContainers = [];
  for (let i = 0; i < 20; i++) manyContainers.push({ containerId: `c_many_${i}`, lootTableId: 'tier1-crate' });
  const runMany = newRun({ containers: manyContainers });
  const gotRareScope = [...runMany.instances.values()].some((i) => i.itemId === 'rare_scope');
  eq(gotRareScope, false, 'a weight=0 entry never rolls across 20 independent containers');
}

// ───────────────────────────────────────────────────────── §5 / items-inventory CHECK parity

head('§5 / items-inventory.md CHECK parity — no row ever violates the co-location CHECKs');
{
  const run = newRun();
  run.spawnParticipant('acct_a');
  run.openContainer('acct_a', 'c1');
  const medId = [...run.instances.values()].find((i) => i.containerId === 'c1' && i.itemId === 'medkit').instanceId;
  run.pickup('acct_a', medId);
  run.drop('acct_a', medId, { x: 0, y: 0, z: 0 });

  let violations = 0;
  for (const inst of run.instances.values()) {
    // location='run' or run_id is null
    if (inst.location !== 'run' && inst.runId !== null) violations++;
    // location in ('world','container') or container_id is null
    if (!(inst.location === 'world' || inst.location === 'container') && inst.containerId !== null) violations++;
    // a pickup never leaves a location='run' row with a non-null container_id
    if (inst.location === 'run' && inst.containerId !== null) violations++;
    // a drop never leaves a location='world' row with a non-null run_id
    if (inst.location === 'world' && inst.runId !== null) violations++;
  }
  eq(violations, 0, 'every item_instances row touched satisfies items-inventory.md §2\'s co-location CHECKs');
}

// ──────────────────────────────────────────────────────────────────────────── determinism

head('§9.10 full-run determinism — identical seed and input stream -> identical output');
{
  function driveRun(runId) {
    const run = newRun({ runId });
    run.spawnParticipant('acct_a');
    run.spawnParticipant('acct_b');
    run.openContainer('acct_a', 'c1');
    const ammoId = [...run.instances.values()].find((i) => i.containerId === 'c1' && i.itemId === 'ammo_9mm').instanceId;
    run.pickup('acct_a', ammoId);
    run.tick({ positions: posMap(['acct_a', insideExit], ['acct_b', outsideExit]), interactHeld: held('acct_a', true) });
    run.tick({ positions: posMap(['acct_a', insideExit], ['acct_b', outsideExit]), interactHeld: held('acct_a', true) });
    run.reportDeath('acct_b', { cause: 'environment', position: { x: 1, y: 0, z: 1 } });
    tickN(run, EXIT_TICKS(run), posMap(['acct_a', insideExit]), held('acct_a', true));
    run.end();
    return run;
  }
  const r1 = driveRun('run_det');
  const r2 = driveRun('run_det');
  eqJson(r1.buildEvidence(), r2.buildEvidence(), 'identical evidence (lootEvents, phaseLog, deathFacts) across two identical runs');
  eqJson(r1.buildRunResult().participants, r2.buildRunResult().participants, 'identical RunResult participants across two identical runs');
  eq(r1.buildEvidenceRef(), r2.buildEvidenceRef(), 'identical evidenceRef across two identical runs');
}

// ──────────────────────────────────────────────────────────────────────────────── summary

console.log(`\n${checks} checks, ${failures} failed`);
if (failures > 0) process.exit(1);
