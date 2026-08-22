/**
 * Deterministic acceptance for the isolated P3-09 raid presentation package.
 *
 * Direct Node execution, mirroring `uibomb.mjs`'s posture: this proves projection, privacy,
 * server-authority, honest-copy, and markup invariants without booting WebGL or depending on
 * the not-yet-implemented client raid runtime. The projection consumes exactly the facts
 * `src/game/extraction.js` (extraction-match.md, FROZEN) maintains — participant phases,
 * run-inventory rows, exits/channel, and that module's literal refusal reasons.
 */
import assert from 'node:assert/strict';

import {
  CUE_CAPTIONS,
  LOSS_WARNINGS,
  PARTICIPANT_PHASE_LABELS,
  RAID_FIXTURES,
  RAID_FIXTURE_CONSTANTS,
  RAID_FIXTURE_NAMES,
  REFUSAL_LABELS,
  RUN_PHASE_LABELS,
  baseRaidState,
  createRaidHud,
  formatClock,
  getRaidFixture,
  projectRaidPresentation,
  renderRaidHudFromSample,
  renderRaidHudHtml,
  updateRaidHudMount,
} from '../src/ui/raid/index.js';
import { ExtractionRun } from '../src/game/extraction.js';

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const throws = (fn, pattern, message) => { assert.throws(fn, pattern, message); assertions++; };

const { SERVER_NOW } = RAID_FIXTURE_CONSTANTS;

function expectedFixtureChecks(item, projected) {
  for (const [key, expected] of Object.entries(item.expect)) {
    let actual;
    switch (key) {
      case 'phase': actual = projected.phase; break;
      case 'participant': actual = projected.participant.phase; break;
      case 'lossState': actual = projected.lossWarning.state; break;
      case 'channelActive': actual = projected.channel.active; break;
      case 'percent': actual = projected.channel.percent; break;
      case 'inventoryCount': actual = projected.inventory.count; break;
      case 'sources': actual = projected.inventory.items.map((row) => row.source); break;
      case 'exitStates': actual = Object.fromEntries(projected.exits.map((exit) => [exit.id, exit.state])); break;
      case 'nearbyItemCount': actual = projected.nearby.items.length; break;
      case 'containerSealed': actual = projected.nearby.container?.sealed; break;
      case 'compare': actual = projected.nearby.items[0]?.compareLabel; break;
      case 'status': actual = projected.status; break;
      case 'caption': actual = projected.caption?.text; break;
      case 'clockStatus': actual = projected.clock.status; break;
      case 'clockText': actual = projected.clock.text; break;
      default: throw new Error(`Unhandled fixture expectation ${key}`);
    }
    equal(actual, expected, `${item.name}: ${key}`);
  }
}

// ── catalogue completeness ─────────────────────────────────────────────────────────────

equal(RAID_FIXTURES.length, 22, 'fixture count is deliberate and reviewable');
equal(new Set(RAID_FIXTURE_NAMES).size, RAID_FIXTURES.length, 'fixture names are unique');
check(getRaidFixture('raid-idle') !== null && getRaidFixture('missing') === null, 'fixture lookup answers hits and misses');
for (const item of RAID_FIXTURES) {
  const projected = projectRaidPresentation(item.input);
  equal(projected.version, 1, `${item.name}: model version`);
  expectedFixtureChecks(item, projected);
  const markup = renderRaidHudHtml(projected);
  check(markup.startsWith('<section class="raid-hud"'), `${item.name}: renders a raid-hud section`);
}

// ── the frozen vocabularies stay closed ────────────────────────────────────────────────

equal(Object.keys(RUN_PHASE_LABELS), ['active', 'collapsing', 'ended'], 'run phases are §1.1\'s participant-visible set');
equal(Object.keys(PARTICIPANT_PHASE_LABELS), ['deploy', 'raid', 'extracting', 'extracted', 'dead', 'aborted'], 'participant phases are exactly §1\'s table');
equal(Object.keys(REFUSAL_LABELS).sort(), ['alreadyOpened', 'noSuchContainer', 'off-sector', 'unavailable', 'wrongPhase'], 'refusal labels cover exactly extraction.js\'s literal reasons');

// The refusal vocabulary is verified against the real raid server, not against memory: every
// labeled reason must be a string extraction.js can actually refuse with.
{
  const run = new ExtractionRun({
    runId: 'r1', runSeed: 'seed-1',
    participants: [{ accountId: 'a1', squadId: 's1', loadoutInstances: [] }],
    containers: [{ containerId: 'c1', tier: 1, lootTableId: null, position: { x: 0, y: 0, z: 0 } }],
  });
  equal(run.openContainer('a1', 'c1').reason, 'wrongPhase', 'pre-spawn open refuses wrongPhase');
  run.spawnParticipant('a1');
  equal(run.openContainer('a1', 'missing').reason, 'noSuchContainer', 'unknown container reason matches label table');
  equal(run.openContainer('a1', 'c1').ok, true, 'first open succeeds');
  equal(run.openContainer('a1', 'c1').reason, 'alreadyOpened', 'second open reason matches label table');
  equal(run.pickup('a1', 'missing').reason, 'unavailable', 'missing instance pickup reason matches label table');
  for (const reason of ['wrongPhase', 'noSuchContainer', 'alreadyOpened', 'unavailable', 'off-sector']) {
    check(typeof REFUSAL_LABELS[reason] === 'string' && REFUSAL_LABELS[reason].length > 0,
      `refusal reason "${reason}" has player-facing copy`);
  }
}

// ── server authority: progress is rendered, never advanced ─────────────────────────────

{
  const state = baseRaidState({
    localParticipant: { phase: 'extracting', extracting: { exitId: 'exit-market-van', progress: 0.5 } },
  });
  const early = projectRaidPresentation({ runState: state, nowMs: SERVER_NOW });
  const late = projectRaidPresentation({ runState: state, nowMs: SERVER_NOW + 30_000 });
  equal(early.channel.percent, late.channel.percent, 'wall-clock time never advances channel progress — the server sample does');
  const over = projectRaidPresentation({
    runState: baseRaidState({
      localParticipant: { phase: 'extracting', extracting: { exitId: 'exit-market-van', progress: 7 } },
    }),
  });
  equal(over.channel.progress, 1, 'malformed progress clamps instead of inventing >100%');
  check(over.channel.resetNote.includes('resets progress to zero'), 'the §4.1 no-partial-credit rule is stated while channeling');
}

// ── privacy: sealed caches never reveal contents (§3.1) ────────────────────────────────

{
  const model = projectRaidPresentation(getRaidFixture('cache-sealed-never-reveals').input);
  equal(model.nearby.items.length, 0, 'sealed cache contents are dropped even when a malformed sample leaks them');
  const markup = renderRaidHudHtml(model);
  check(!markup.includes('Prism optic'), 'sealed-cache markup never names the leaked item');
  check(markup.includes('SEALED CACHE'), 'CONTROL: the sealed cache itself is shown and openable');
}

// ── honest copy: loss matrix and capacity ─────────────────────────────────────────────

{
  check(LOSS_WARNINGS.atRisk.includes('No item is protected'), 'at-risk warning states the no-protection fact');
  check(LOSS_WARNINGS.aborted.includes('exactly like a death'), 'abort copy states settlement.md §4\'s died/aborted equivalence');
  const idle = projectRaidPresentation(getRaidFixture('raid-idle').input);
  check(idle.inventory.capacityLabel.includes('no carry limit in this slice'),
    'capacity is stated honestly — no invented meter for a limit no contract defines');
  const dead = projectRaidPresentation(getRaidFixture('dead').input);
  equal(dead.lossWarning.state, 'dead', 'death switches the loss warning to the terminal loss state');
  const extracted = projectRaidPresentation(getRaidFixture('extracted').input);
  check(extracted.lossWarning.text.includes('frozen for settlement'), 'extraction copy states §4.1\'s freeze, not premature ownership');
  equal(extracted.nearby.items.length, 0, 'a terminal participant is never offered loot interactions');
}

// ── exit availability is presentational triage, driven by held items and the window ───

{
  const gated = projectRaidPresentation(getRaidFixture('exit-needs-keycard').input);
  const transit = gated.exits.find((exit) => exit.id === 'exit-transit-gate');
  check(transit.requirements.some((line) => line.includes('NEEDS TRANSIT KEYCARD')), 'an item-gated exit names the missing item');
  const held = projectRaidPresentation(getRaidFixture('exit-keycard-held').input);
  equal(held.exits.find((exit) => exit.id === 'exit-transit-gate').state, 'available', 'holding the item flips the exit to available');
  const pending = projectRaidPresentation(getRaidFixture('exit-window-pending').input);
  check(pending.exits[0].requirements[0].startsWith('OPENS IN 1:30'), 'a pending window counts down to open');
  const open = projectRaidPresentation(getRaidFixture('raid-idle').input);
  check(open.exits.find((exit) => exit.id === 'exit-market-van').requirements[0].startsWith('CLOSES IN 5:00'),
    'an open window counts down to close');
}

// ── clock formatting and collapse state ───────────────────────────────────────────────

equal(formatClock(45_000), '0:45', 'clock formats mm:ss');
equal(formatClock(Number.NaN), '--:--', 'clock refuses to invent a time');
{
  const collapsing = projectRaidPresentation(getRaidFixture('collapsing').input);
  equal(collapsing.clock.status, 'critical', 'collapse marks the clock critical');
  check(collapsing.phaseLabel.includes('GET TO AN EXIT'), 'collapse copy tells the player what to do');
}

// ── markup safety and structure ───────────────────────────────────────────────────────

{
  throws(() => renderRaidHudHtml(null), TypeError, 'renderer refuses a missing model');
  throws(() => projectRaidPresentation({}), TypeError, 'projection refuses a missing sample');
  const hostile = projectRaidPresentation({
    runState: baseRaidState({
      runInventory: [{ instanceId: 'x', itemId: 'x', name: '<img src=x onerror=alert(1)>', quantity: 1 }],
    }),
  });
  const markup = renderRaidHudHtml(hostile);
  check(!markup.includes('<img'), 'item names are HTML-escaped');
  check(markup.includes('&lt;img'), 'CONTROL: the escaped name is still rendered');
  const unknown = projectRaidPresentation({
    runState: baseRaidState({ phase: 'spinning-up', localParticipant: { phase: 'warping' } }),
  });
  check(unknown.ruleViolation?.includes('spinning-up') && unknown.ruleViolation?.includes('warping'),
    'out-of-vocabulary phases surface as a contract violation instead of rendering as fact');
  const sample = renderRaidHudFromSample(getRaidFixture('raid-idle').input);
  check(sample.includes('aria-label="Extraction raid status"'), 'sample renderer produces the labeled landmark');
}

// ── mount adapter stays inert outside an extraction match ─────────────────────────────

{
  const nodes = [];
  const fakeDocument = {
    createElement(tag) {
      const node = {
        tag, className: '', hidden: false, innerHTML: '', listeners: {},
        appendChild(child) { nodes.push(child); },
        addEventListener() {}, removeEventListener() {}, remove() { node.removed = true; },
      };
      return node;
    },
  };
  const root = {
    className: '', children: [],
    appendChild(child) { this.children.push(child); },
    classList: {
      state: new Set(),
      toggle(name, on) { if (on) this.state.add(name); else this.state.delete(name); },
      contains(name) { return this.state.has(name); },
    },
  };
  const raidView = () => baseRaidState();
  const game = {
    state: 'playing',
    match: { modeId: 'tdm' },
    bus: { on: () => () => {} },
    settings: { get: () => undefined },
  };
  const hud = createRaidHud({ game, root, document: fakeDocument });
  equal(hud.update(1), null, 'a tdm match never activates the raid mount');
  check(hud.element.hidden === true, 'the mount stays hidden outside extraction');
  game.match = { modeId: 'extraction', raidView };
  const model = hud.update(1);
  equal(model?.version, 1, 'an extraction match with a raid view renders a model');
  check(root.classList.contains('raid-mode'), 'activation flags the HUD root');
  check(hud.element.innerHTML.includes('raid-hud'), 'the mount received markup');
  game.match = { modeId: 'extraction' }; // no raidView -> inert again, never a throw
  equal(hud.update(1), null, 'extraction without a raid view stays inert');
  hud.reset();
  equal(hud.element.innerHTML, '', 'reset clears the mount');
  hud.destroy();
  check(hud.element.removed === true, 'destroy removes the mount');
}

console.log(`✓ raid HUD acceptance passed (${assertions} assertions).`);
