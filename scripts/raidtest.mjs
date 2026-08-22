/**
 * Client raid runtime verification (REQ-CC-073) — a FULL headless extraction raid.
 *
 * Proves the game can RUN an extraction match locally, end to end, through the same
 * lifecycle every other mode uses: `startMatch({ mode: 'extraction' })` on the
 * 'square-extraction' map binds `ExtractionRun` via `ExtractionRules` exactly as Bomb binds
 * `BombRules`, ticks it from `Game._fixedUpdate`, routes interact/pickup/drop/extract intents
 * through the existing input->sim path (hand-built `Player.applyCommand` commands and the
 * `_held.interactHeld` field — the same shapes the wire carries), and reports loot/channel
 * outcomes on the `raid` bus topic in the raid projection's typed-event vocabulary.
 *
 * Two scripted scenarios, each executed TWICE with the same seed and compared byte-for-byte:
 *   A. deploy -> loot (open cache, take everything, drop + re-take) -> extract (rail gate)
 *   B. deploy -> death (killed by a bot mid-raid)
 */
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';
import { FIXED_DT } from '../src/core/mathUtils.js';
import { stableJson } from '../src/core/hash.js';
import { LOOT_CONTAINERS, EXTRACTION_EXITS } from '../src/world/level.js';
// Read-only import of the CX-owned projection: the sample this runtime produces must
// project cleanly, and the typed-event vocabulary must be the projection's own.
import { projectRaidPresentation, REFUSAL_LABELS, CUE_CAPTIONS } from '../src/ui/raid/model.js';

let failures = 0;
let checks = 0;
let section = '';
const ok = (name) => { checks++; console.log(`  ok   ${name}`); };
const bad = (name, detail) => { failures++; checks++; console.log(`  FAIL ${name}\n       ${detail}`); };
const expect = (cond, name, detail = '') => (cond ? ok(name) : bad(name, `[${section}] ${detail}`));
const eq = (actual, expected, name) => expect(
  Object.is(actual, expected), name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
);
const head = (title) => { section = title; console.log(`\n── ${title}`); };

/** A command with everything off — the shape `Player.applyCommand` expects. */
const emptyCommand = () => ({
  wishForward: 0, wishRight: 0,
  jump: false, crouchPressed: false, reload: false, melee: false, grenade: false,
  interact: false, inspect: false, killstreak: false, lastWeapon: false,
  sprintDown: false, sprintUp: false, firePressed: false, aimButtonPressed: false,
  crouchHeld: false, toggleAdsMode: false, aimButtonHeld: false, fireHeld: false,
  sprintKeyHeld: false, breathHold: false, leanKeyHeld: false, leanRightKeyHeld: false,
  slot: -1, wheel: 0, deltaYaw: 0, deltaPitch: 0, baseYaw: 0, basePitch: 0, tick: 0,
});

const TYPED_EVENTS = new Set(['lootRefused', 'pickedUp', 'dropped', 'containerOpened', 'exitCompleted', 'channelInterrupted']);

async function bootRaid({ seed, botCount }) {
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter(), mapId: 'square-extraction' });
  game.startMatch({ mode: 'extraction', botCount, difficulty: 'regular', seed });
  game.match.phase = 'live';
  game.match.countdown = 0;

  const transcript = [];
  game.bus.on('raid', (row) => transcript.push({ tick: game.tick, ...row }));

  const step = (n = 1) => { for (let i = 0; i < n; i++) game._fixedUpdate(FIXED_DT); };
  const teleport = (x, y, z) => {
    game.player.position.set(x, y, z);
    game.player.velocity?.set?.(0, 0, 0);
  };
  /** The interact EDGE through the real input->sim path: one applied command, one step. */
  const pressInteract = () => {
    game.player.applyCommand({ ...emptyCommand(), interact: true, baseYaw: game.player.baseYaw, basePitch: game.player.basePitch });
    step(1);
  };
  return { game, transcript, step, teleport, pressInteract };
}

/** Determinism digest: every wall-clock-free fact the run produced, in order. */
function digestOf(game, transcript) {
  const rules = game.match.extractionRules;
  const runResult = rules.run.buildRunResult();
  return stableJson({
    evidence: rules.run.buildEvidence(),
    evidenceRef: rules.run.buildEvidenceRef(),
    participants: runResult.participants,
    transcript,
    endedAtTick: game.tick,
    matchReason: game.match.result?.reason ?? null,
  });
}

// ───────────────────────────────────────────── scenario A: deploy -> loot -> extract ──

const CACHE = LOOT_CONTAINERS.find((c) => c.containerId === 'c-warehouse-floor');
const GATE = EXTRACTION_EXITS.find((e) => e.id === 'exit-rail-gate');
const GATE_AT = {
  x: (GATE.volume.min.x + GATE.volume.max.x) / 2,
  z: (GATE.volume.min.z + GATE.volume.max.z) / 2,
};

async function scenarioA(assert) {
  const { game, transcript, step, teleport, pressInteract } = await bootRaid({ seed: 777, botCount: 0 });
  const match = game.match;
  const rules = match.extractionRules;
  const view = () => match.raidView();

  if (assert) {
    head('A1. the extraction mode binds like tdm/bomb do');
    eq(match.modeId, 'extraction', 'startMatch({mode:"extraction"}) resolves to the extraction ruleset');
    expect(rules != null, 'match.extractionRules exists while the mode is bound');
    eq(rules.run.phase, 'active', 'the ExtractionRun is live');
    eq(rules.run.participants.get('acct:local')?.phase, 'raid', 'the local participant deployed (deploy -> raid)');
    eq(rules.run.containers.size, LOOT_CONTAINERS.length, 'the run consumed the map entry\'s authoritative container set');
    eq(rules.run.exits.size, EXTRACTION_EXITS.length, 'the run consumed the map entry\'s authoritative exit set');
  }

  step(10);

  if (assert) {
    head('A2. raidView() is the documented v1 sample and projects cleanly');
    const sample = view();
    eq(sample.version, 1, 'sample carries version 1');
    const model = projectRaidPresentation({ runState: sample, bindings: { interact: 'E' } });
    eq(model.ruleViolation, null, 'the raid projection accepts the live sample with no contract violation');
    eq(model.participant.phase, 'raid', 'projected participant phase is raid');
    expect(sample.exits.length === 2 && sample.exits.some((e) => e.id === 'exit-rail-gate'),
      'the sample lists the map\'s declared exits with their conditions');
    const ferry = sample.exits.find((e) => e.id === 'exit-ferry-landing');
    eq(ferry?.conditions?.requiresItem?.itemId, 'keycard_transit', 'the ferry exit declares its item condition in the sample');
  }

  // Walk to the warehouse-floor cache and stand on it.
  teleport(CACHE.position.x, CACHE.position.y, CACHE.position.z);
  step(2);

  if (assert) {
    head('A3. a sealed cache reveals nothing — then the interact edge opens it');
    const before = view();
    eq(before.nearby.container?.containerId, CACHE.containerId, 'the nearby cache is sampled');
    eq(before.nearby.container?.state, 'sealed', 'the cache is sealed before any interaction');
    eq(before.nearby.items.length, 0, 'a sealed cache carries ZERO item rows in the sample (§3.1)');
    const rolled = [...rules.run.instances.values()].filter((i) => i.containerId === CACHE.containerId);
    expect(rolled.length > 0, 'control: the run DID roll contents for that cache — the sample withheld them, not the roll');
  }

  pressInteract();

  const opened = transcript.filter((r) => r.type === 'containerOpened');
  if (assert) {
    eq(opened.length, 1, 'the interact edge opened the cache — one containerOpened on the raid topic');
    eq(rules.run.containers.get(CACHE.containerId).state, 'opened', 'the run recorded the open');
  }

  // Take everything the cache rolled.
  let guard = 0;
  while (view().nearby.items.length > 0 && guard++ < 16) pressInteract();
  const taken = transcript.filter((r) => r.type === 'pickedUp').length;

  // The loot intents run in BOTH passes — only the assertions are gated, or the two
  // "identical" runs would not have identical inputs and determinism would test nothing.
  const invBefore = view().runInventory;
  const dropRes = invBefore.length ? rules.drop(game.player, invBefore[0].instanceId) : { ok: false };
  pressInteract(); // nearest container is now the fresh drop at our feet
  const invAfter = view().runInventory;
  const refused = rules.drop(game.player, 'no-such-instance');

  if (assert) {
    head('A4. loot: pickup, drop, re-take — all through intents, all on the raid topic');
    expect(taken > 0, `interact edges picked up the cache contents (${taken} items)`);
    eq(invBefore.length > 0, true, 'run inventory rows appear in the sample');
    expect(invBefore.every((r) => r.locked === false), 'run-acquired loot is unlocked (projection will label it "looted")');
    eq(dropRes.ok, true, 'the drop intent succeeds on run-acquired loot');
    eq(transcript.filter((r) => r.type === 'dropped').length, 1, 'one dropped event on the raid topic');
    eq(invAfter.length, invBefore.length, 'the dropped item was re-taken through the interact edge');
    eq(refused.ok, false, 'a bogus drop is refused by the run, not by the adapter');
    const refusal = transcript.find((r) => r.type === 'lootRefused' && r.action === 'drop');
    eq(refusal?.reason, 'unavailable', 'the refusal carries extraction.js\'s literal reason');
    expect(Object.hasOwn(REFUSAL_LABELS, refusal?.reason ?? ''),
      'that reason is in the raid projection\'s refusal vocabulary — the HUD can label it');
  }

  // To the rail gate. Hold interact: channel, interrupt once, then run it to completion.
  teleport(GATE_AT.x, 0.5, GATE_AT.z);
  step(2);
  game.player._held.interactHeld = true;
  step(60);

  if (assert) {
    head('A5. the extraction channel: server-driven progress, interrupt resets, completion ends the match');
    const mid = view();
    eq(mid.localParticipant.phase, 'extracting', 'holding interact in the exit volume starts the channel');
    expect(mid.localParticipant.extracting.progress > 0 && mid.localParticipant.extracting.progress < 1,
      `channel progress is the run's own ratio (${mid.localParticipant.extracting?.progress?.toFixed(3)})`);
    const projected = projectRaidPresentation({ runState: mid, bindings: { interact: 'E' } });
    expect(projected.channel.active && projected.channel.percent > 0, 'the projection renders the live channel');
  }

  game.player._held.interactHeld = false; // one released tick — §4.1 interrupt
  step(1);

  if (assert) {
    eq(transcript.filter((r) => r.type === 'channelInterrupted').length, 1, 'releasing the key emits channelInterrupted');
    eq(view().localParticipant.extracting, null, 'progress reset to zero — no partial credit');
  }

  game.player._held.interactHeld = true;
  const gateTicks = rules.run.exits.get('exit-rail-gate').durationTicks;
  step(gateTicks + 5);

  if (assert) {
    eq(transcript.filter((r) => r.type === 'exitCompleted').length, 1, 'completion emits exitCompleted on the raid topic');
    eq(game.match.phase, 'ended', 'extraction ends the match');
    eq(game.match.result?.reason, 'extracted', 'the match result records the extraction');
    const rr = game.match.result?.raid?.runResult;
    eq(rr?.participants?.length, 1, 'the §6 RunResult rides the match result');
    eq(rr?.participants?.[0]?.outcome, 'extracted', 'RunResult outcome: extracted');
    eq(rr?.participants?.[0]?.exitId, 'exit-rail-gate', 'RunResult names the exit used');
    const frozen = [...rules.run.instances.values()]
      .filter((i) => i.ownerAccountId === 'acct:local' && i.location === 'run' && i.status === 'active');
    expect(frozen.length > 0 && frozen.every((i) => i.locked === true), 'carried items are frozen (locked) on completion (§4.1)');
    const post = view();
    eq(post.localParticipant.phase, 'extracted', 'raidView() survives the whistle — the terminal phase is readable');
    expect(transcript.every((r) => TYPED_EVENTS.has(r.type)),
      'every raid-topic event used the projection\'s typed vocabulary');
    expect(transcript.every((r) => r.type !== 'lootRefused' || Object.hasOwn(REFUSAL_LABELS, r.reason)),
      'every refusal reason maps to a projection label');
    void CUE_CAPTIONS;
  }

  const digest = digestOf(game, transcript);
  game.dispose();
  return digest;
}

// ─────────────────────────────────────────────────── scenario B: deploy -> death ──

async function scenarioB(assert) {
  const { game, transcript, step } = await bootRaid({ seed: 424242, botCount: 2 });
  const match = game.match;
  const rules = match.extractionRules;

  step(120); // one second of live raid among hostile bots

  if (assert) {
    head('B. deploy -> death: a raid death is terminal and settles as died/ai');
    eq(rules.run.participants.get('acct:local')?.phase, 'raid', 'participant is mid-raid before the death');
  }

  // A bot gets the kill, through the player's own death path (die -> match -> mode -> run).
  const bot = game.bots.bots[0];
  game.player.die({ attacker: bot, weaponId: 'rifle', hitPart: 'torso', point: game.player.position, normal: null });
  step(2);

  if (assert) {
    eq(match.phase, 'ended', 'the participant death ends the local raid');
    eq(match.result?.reason, 'died', 'the match result records the death');
    const rr = match.result?.raid?.runResult;
    eq(rr?.participants?.[0]?.outcome, 'died', 'RunResult outcome: died');
    eq(rr?.participants?.[0]?.deathCause, 'ai', 'deathCause is the §6 closed enum value for a bot kill');
    eq(rr?.participants?.[0]?.exitId, undefined, 'a died row carries no exitId (§6 exactly-one rule)');
    const view = match.raidView();
    eq(view.localParticipant.phase, 'dead', 'raidView() reports the terminal dead phase');
    const projected = projectRaidPresentation({ runState: view, bindings: { interact: 'E' } });
    eq(projected.lossWarning.state, 'dead', 'the projection renders the honest loss state');
  }

  const digest = digestOf(game, transcript);
  game.dispose();
  return digest;
}

// ──────────────────────────────────────────────────────────────────── determinism ──

console.log('raidtest: a full headless extraction raid, twice over\n');

const a1 = await scenarioA(true);
const a2 = await scenarioA(false);
head('determinism — identical seed, identical scripted inputs, identical raid');
eq(a1 === a2, true, 'scenario A (deploy -> loot -> extract) is byte-identical across two seeded runs');

const b1 = await scenarioB(true);
const b2 = await scenarioB(false);
eq(b1 === b2, true, 'scenario B (deploy -> death) is byte-identical across two seeded runs');

console.log(`\n${checks} checks, ${failures} failed`);
// Explicit exit either way: a disposed headless Game can leave a live handle (the same
// posture the other Game-based harnesses take), and CI must not hang on a green run.
process.exit(failures > 0 ? 1 : 0);
