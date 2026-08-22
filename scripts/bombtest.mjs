/**
 * Bomb ruleset verification — `docs/contracts/bomb-rules.md` §12.
 *
 * Every case here names the contract rule it holds down, and every case that could pass
 * for the wrong reason carries its failing CONTROL: the same setup shifted by one tick, or
 * one precondition removed, asserted to produce the OTHER outcome. A test that cannot tell
 * which rule fired leaves every neighbouring rule untested, and the §4 precedence list is
 * exactly a set of neighbouring rules that resolve the same inputs differently.
 *
 * ── How the simulation is driven ─────────────────────────────────────────────────────────
 * `match.fixedUpdate(FIXED_DT)` directly, not `game._fixedUpdate`. Both are the real code
 * under test; the difference is that the referee's step alone leaves bots standing where
 * the harness put them, so a boundary case is a boundary case and not a race with an AI
 * that wandered out of the volume. The determinism case at the end runs the FULL game loop
 * with live bots, twice, precisely because the scripted driver would not prove that.
 *
 * ── Where the bomb sites come from ───────────────────────────────────────────────────────
 * The map manifest (`map-data.md` §3.3), never constants in the ruleset. This harness reads
 * the live map's own compiled manifest — The Square declares `site-A` and `site-B` — so
 * every volume test below is played on real authored geometry. The only synthetic manifests
 * here are the malformed ones, which exist to prove each rejection by name, and the
 * objective-less one, which proves a map that publishes no sites cannot host Bomb.
 */
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';
import { MODE_LIST, MODES, DEFAULT_MODE, getMode, BOMB, TDM, bombAvailable } from '../src/game/modes.js';
import {
  BOMB_PARAMS, BOMB_TICKS as T, REFUSE, compileObjectives, resolveMapManifest,
} from '../src/game/bomb.js';
import { SCORE } from '../src/game/match.js';
import { FIXED_DT } from '../src/core/mathUtils.js';

let failures = 0;
let checks = 0;
let section = '';
const ok = (name) => { checks++; console.log(`  ok   ${name}`); };
const bad = (name, detail) => {
  failures++; checks++;
  console.log(`  FAIL ${name}\n       ${detail}`);
};
const expect = (cond, name, detail = '') => (cond ? ok(name) : bad(name, `[${section}] ${detail}`));
/** Value equality against a SPECIFIC expected value — never a truthiness or a length. */
const eq = (actual, expected, name) => expect(
  Object.is(actual, expected), name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
);
const eqJson = (actual, expected, name) => expect(
  JSON.stringify(actual) === JSON.stringify(expected), name,
  `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
);
const head = (title) => { section = title; console.log(`\n── ${title}`); };

// ─────────────────────────────────────────────────────────────────────────────── fixtures

async function newGame({ seed = 20260819, botCount = 7, mode = 'bomb' } = {}) {
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter() });
  game.startMatch({ mode, botCount, seed });
  // Skip the presentation countdown; the ruleset's own freeze is the phase under test.
  game.match.phase = 'live';
  game.match.countdown = 0;
  return game;
}

const step = (game, n = 1) => { for (let i = 0; i < n; i++) game.match.fixedUpdate(FIXED_DT); };

/** Advance to the live round, asserting the freeze lasted exactly the configured time. */
function toLive(game, label) {
  const bomb = game.match.bombRules;
  let n = 0;
  while (bomb.phase !== 'live' && n < T.freeze * 4) { step(game); n++; }
  eq(n, T.freeze + 1, `${label}: freeze lasts ${BOMB_PARAMS.freezeSeconds}s then the round goes live`);
  return bomb;
}

const roster = (game) => game.entities.filter((e) => e.team === 0 || e.team === 1);
const teamOf = (game, team) => roster(game).filter((e) => e.team === team).sort((a, b) => a.id - b.id);
const attackers = (game) => teamOf(game, game.match.bombRules.attackingTeam);
const defenders = (game) => teamOf(game, game.match.bombRules.defendingTeam);

function kill(game, victim, attacker = null) {
  game.bus.emit('kill', { victim, attacker, weaponId: 'ar_vector', headshot: false, distance: 12 });
}

/**
 * ONE FULL ENGINE STEP with the kills produced where the engine really produces them.
 *
 * This exists because the §4 simultaneity cases were previously "proved" by calling `kill()`
 * AFTER `step()` and asserting the result — an order the engine cannot produce. `game.systems`
 * is consumed by the RENDER path only; the simulation step is hand-ordered in `game.js`
 * `_fixedUpdate` — nav → player → extra entities → bots → weapons → projectiles → **match** —
 * so every real kill reaches `bombRules.onKill` BEFORE the referee resolves that tick.
 * Measured over 40 000 ticks of a live bot match, every kill was emitted from a phase ahead
 * of the rules (`{ bots: 44, match: 3 }`).
 *
 * So the harness injects from the weapons phase and MEASURES the ordering rather than
 * assuming it: the return value is how many of the victims the referee already knew were
 * eliminated at the moment it ran. Reorder `game.js` and these cases fail here first.
 *
 * The ACTORS are held still for that step — the same reason `step()` exists (see the header):
 * a boundary case must be a boundary case and not a race with an AI that wandered out of the
 * volume, and a body teleported into a volume by `place()` is airborne on its first real
 * physics step, which refuses the plant for `notGrounded` before the rule under test is ever
 * reached. Nothing about the ORDER changes: the phases still run in `game.js`'s order, and
 * the kill still originates ahead of the rules, which is the property being held down.
 *
 * @returns {number} victims already eliminated when `match.fixedUpdate` began
 */
function engineStepKilling(game, victims, attacker = null) {
  const frozen = [game.player, game.bots].filter((s) => s !== null && s !== undefined);
  const weapons = game.weapons;
  const match = game.match;
  const realWeapons = weapons.fixedUpdate;
  const realMatch = match.fixedUpdate;
  const realActors = frozen.map((s) => s.fixedUpdate);
  let knownToReferee = -1;
  for (const s of frozen) s.fixedUpdate = () => {};
  weapons.fixedUpdate = (dt) => {
    realWeapons.call(weapons, dt);
    for (const v of victims) kill(game, v, attacker);
  };
  match.fixedUpdate = (dt) => {
    const elim = game.match.bombRules.eliminated;
    let n = 0;
    for (const v of victims) if (elim.has(v.id)) n++;
    knownToReferee = n;
    realMatch.call(match, dt);
  };
  try {
    game._fixedUpdate(FIXED_DT);
  } finally {
    weapons.fixedUpdate = realWeapons;
    match.fixedUpdate = realMatch;
    frozen.forEach((s, i) => { s.fixedUpdate = realActors[i]; });
  }
  return knownToReferee;
}

/** Eliminate a whole team except the listed survivors. */
function wipe(game, team, keep = []) {
  const keepIds = new Set(keep.map((e) => e.id));
  for (const e of teamOf(game, team)) {
    if (keepIds.has(e.id)) continue;
    if (game.match.bombRules.isAlive(e)) kill(game, e, null);
  }
}

function centre(box) {
  return {
    x: (box.min.x + box.max.x) / 2,
    y: box.min.y + 0.5,
    z: (box.min.z + box.max.z) / 2,
  };
}

function place(entity, p) {
  entity.position.set(p.x, p.y, p.z);
  entity.grounded = true;
}

/** Put the round's bomb carrier inside a site's plant volume, ready to plant. */
function carrierIntoSite(game, siteId = 'A') {
  const bomb = game.match.bombRules;
  const carrier = game.entityById(bomb.bomb.carrierId);
  place(carrier, centre(bomb.sites.get(siteId).plant));
  return carrier;
}

/** Plant the bomb outright, and assert it took exactly the configured plant time. */
function plant(game, siteId = 'A', label = 'plant') {
  const bomb = game.match.bombRules;
  const carrier = carrierIntoSite(game, siteId);
  bomb.requestInteract(carrier, 'plant');
  step(game, T.plant - 1);
  eq(bomb.phase, 'live', `${label}: still live one tick before the plant completes`);
  step(game, 1);
  eq(bomb.phase, 'planted', `${label}: the bomb is planted after exactly ${BOMB_PARAMS.plantSeconds}s`);
  return carrier;
}

/** The most recent event of a kind, or a stand-in that fails every field comparison. */
function lastEvent(bomb, kind) {
  for (let i = bomb.events.length - 1; i >= 0; i--) if (bomb.events[i].kind === kind) return bomb.events[i];
  return { kind: `<no ${kind} event>` };
}

/** Put a defender in the defuse volume and hold the key. */
function beginDefuse(game, defender) {
  const bomb = game.match.bombRules;
  place(defender, centre(bomb.sites.get(bomb.bomb.siteId).defuse));
  return bomb.requestInteract(defender, 'defuse');
}

// ════════════════════════════════════════════════════════ §1 the mode table is the freeze

console.log('\nBomb ruleset — docs/contracts/bomb-rules.md §12');
head('§1 mode table');

eqJson(MODE_LIST.map((m) => m.id), ['tdm', 'bomb', 'extraction'], 'the mode table has exactly three entries: tdm, bomb, extraction (bomb-rules §1 as amended 1.8.0)');
eqJson(Object.keys(MODES), ['tdm', 'bomb', 'extraction'], 'MODES is keyed by exactly those three ids');
eq(DEFAULT_MODE, 'tdm', 'TDM remains the default ruleset');
eq(getMode('bomb'), BOMB, 'getMode resolves the bomb id to the Bomb ruleset');
eq(getMode('capture-the-flag'), TDM, 'an unknown mode id resolves to TDM');
eq(getMode('constructor'), TDM, 'a prototype key is not a mode');
// §2 is the HUMAN OWNER's table, so every value is pinned to its literal here. Reading a
// duration back out of BOMB_PARAMS and asserting the ruleset agrees with itself detects
// nothing: with the durations below asserted only against themselves, the round-end delay
// (5→3 s), the freeze (8→6 s), the round length (105→90 s) and the reconnect grace
// (90→30 s) could all be changed without a single check going red.
eq(BOMB_PARAMS.roundsToWin, 7, '§2 rounds to win is 7');
eq(BOMB_PARAMS.maxRounds, 12, '§2.1a regulation is MR12');
eq(BOMB_PARAMS.sideSwitchAfterRound, 6, '§2 sides switch after round 6');
eq(BOMB_PARAMS.roundSeconds, 105, '§2 the round is 1:45 pre-plant');
eq(BOMB_PARAMS.freezeSeconds, 8, '§2 the freeze is 8 s');
eq(BOMB_PARAMS.plantSeconds, 3, '§2 the plant is 3.0 s');
eq(BOMB_PARAMS.defuseSeconds, 7, '§2 the defuse is 7.0 s');
eq(BOMB_PARAMS.bombTimerSeconds, 40, '§2.1 the bomb timer is 40 s after the plant');
eq(BOMB_PARAMS.roundEndSeconds, 5, '§2 the round-end delay is 5 s');
eq(BOMB_PARAMS.reconnectGraceSeconds, 90, '§2 the reconnect grace is 90 s');
eq(BOMB_PARAMS.abandonRounds, 2, '§2 an abandon is 2 consecutive rounds absent');
eq(BOMB_PARAMS.overtime, false, '§2.2 there is no overtime in Alpha');
eq(BOMB_PARAMS.defuseKit, false, '§2 there is no defuse kit in Alpha');
eq(T.round, 12600, '§2 the round is 105 s of fixed steps');
eq(T.freeze, 960, '§2 the freeze is 8 s of fixed steps');
eq(T.bomb, 4800, '§2.1 the bomb timer is 40 s of fixed steps');
eq(T.plant, 360, '§2 the plant takes 3.0 s of fixed steps');
eq(T.defuse, 840, '§2 the defuse takes 7.0 s of fixed steps');
eq(T.roundEnd, 600, '§2 the round-end delay is 5 s of fixed steps');

// ═══════════════════════════════════════════════ map-data §3.3 — sites come from the map

head('map-data.md §3.3 objective volumes');
{
  const boxA = { min: { x: 0, y: 0, z: 0 }, max: { x: 4, y: 3, z: 4 } };
  const good = compileObjectives({
    objectives: [
      { id: 'p', kind: 'plant', site: 'A', box: boxA },
      { id: 'z', kind: 'zone', box: boxA },
    ],
  });
  eq(good.get('A').defuseId, 'p', 'an omitted defuse volume defaults to the plant volume');
  eq(good.get('A').requiresGround, true, 'requiresGround defaults to true');

  // The site table is ordered by site id, not by the order the manifest happened to author
  // its volumes. Nothing else can see this: within one process a Map iterates in insertion
  // order every time, so two runs of the same build agree with each other whether the sort
  // is there or not, and a determinism replay is blind to it.
  const authoredBackwards = compileObjectives({
    objectives: [
      { id: 'pB', kind: 'plant', site: 'B', box: boxA },
      { id: 'pA', kind: 'plant', site: 'A', box: boxA },
    ],
  });
  eqJson([...authoredBackwards.keys()], ['A', 'B'],
    'sites iterate in id order even when the manifest authored B before A');

  const rejects = [
    [{ objectives: 'nope' }, 'publishes no objectives array'],
    [{ objectives: [] }, 'declares no bomb site'],
    [{ objectives: [{ kind: 'plant', site: 'A', box: boxA }] }, 'has no id'],
    [{ objectives: [{ id: 'p', kind: 'plant', site: 'A', box: boxA }, { id: 'p', kind: 'plant', site: 'B', box: boxA }] }, 'duplicate objective id'],
    [{ objectives: [{ id: 'p', kind: 'landmine', site: 'A', box: boxA }] }, 'unknown kind'],
    [{ objectives: [{ id: 'p', kind: 'plant', box: boxA }] }, 'names no site'],
    [{ objectives: [{ id: 'p', kind: 'plant', site: 'A' }] }, 'has no box'],
    [{ objectives: [{ id: 'p', kind: 'plant', site: 'A', box: { min: { x: 4, y: 0, z: 0 }, max: { x: 0, y: 3, z: 4 } } }] }, 'min > max'],
    [{ objectives: [{ id: 'p', kind: 'plant', site: 'A', box: { ...boxA, inverted: true } }] }, 'min > max'],
    [{ objectives: [{ id: 'p', kind: 'plant', site: 'A', box: { min: { x: 0, y: 0, z: 0 }, max: { x: NaN, y: 3, z: 4 } } }] }, 'not a finite point'],
    [{ objectives: [{ id: 'd', kind: 'defuse', site: 'A', box: boxA }] }, 'no plant volume'],
    [{ objectives: [{ id: 'p', kind: 'plant', site: 'A', box: boxA }, { id: 'p2', kind: 'plant', site: 'A', box: boxA }] }, 'two plant volumes'],
    [{ objectives: [{ id: 'p', kind: 'plant', site: 'A', box: boxA }, { id: 'd', kind: 'defuse', site: 'A', box: boxA }, { id: 'd2', kind: 'defuse', site: 'A', box: boxA }] }, 'two defuse volumes'],
  ];
  for (const [manifest, fragment] of rejects) {
    let message = '<no throw>';
    try { compileObjectives(manifest); } catch (err) { message = err.message; }
    expect(message.includes(fragment), `a manifest whose objective ${fragment} is rejected by name`, `message was "${message}"`);
  }
}

{
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter() });
  eq(resolveMapManifest(game), game.world.manifest, 'with no override the ruleset reads the map\'s own compiled manifest');
  eq(bombAvailable(game), true, 'Bomb is available on the live map, which declares its sites');
  eqJson(game.world.manifest.objectives.map((o) => o.id), ['site-A', 'site-B'],
    'and those sites are the map\'s, not the ruleset\'s');
  // A map with no objective volumes cannot host Bomb, and says so at match start rather
  // than quietly playing on coordinates baked into the ruleset.
  game.mapManifest = { ...game.world.manifest, objectives: [] };
  eq(bombAvailable(game), false, 'Bomb reports unavailable on a map with no objective volumes');
  let message = '<no throw>';
  try { game.startMatch({ mode: 'bomb', botCount: 1, seed: 1 }); } catch (err) { message = err.message; }
  expect(message.includes('declares no bomb site'), 'starting Bomb on such a map fails loudly, naming the missing data', message);
  game.dispose();
}

{
  const game = await newGame();
  const bomb = game.match.bombRules;
  eqJson([...bomb.sites.keys()], ['A', 'B'], 'the ruleset reads its site ids from the manifest');
  eq(bomb.sites.get('A').plantId, 'site-A', 'site A plants inside the map\'s own site-A volume');
  eq(bomb.sites.get('B').defuseId, 'site-B', 'site B, declaring no defuse volume, defuses inside its plant volume');
  const a = bomb.sites.get('A');
  eq(bomb.siteAt(centre(a.plant)), a, 'a point inside a plant volume resolves to its site');
  eq(bomb.siteAt({ x: a.plant.max.x + 0.01, y: centre(a.plant).y, z: centre(a.plant).z }), null,
    'a point one centimetre outside the plant volume resolves to no site');
  game.dispose();
}

// ═══════════════════════════════════════════════════════════════ §3 the round state machine

head('§3 round state machine');
{
  const game = await newGame();
  const bomb = game.match.bombRules;
  eq(bomb.phase, 'warmup', 'a Bomb match starts in warmup');
  eq(bomb.allowRespawn(), true, '§3 respawns are on during warmup');
  step(game, 1);
  eq(bomb.phase, 'freeze', 'the first step of the match opens round 1 with a freeze');
  eq(bomb.roundNumber, 1, 'the first round is round 1');
  eq(bomb.attackingTeam, 0, 'team 0 attacks first');
  eq(bomb.allowRespawn(), false, '§8 respawns are off from freeze onward');
  eq(game.match.canFire(attackers(game)[0]), false, '§3 weapons are locked during the freeze');
  eq(bomb.bomb.state, 'carried', '§5 the bomb is carried from the freeze');
  const carrier = game.entityById(bomb.bomb.carrierId);
  eq(carrier.team, bomb.attackingTeam, '§5 the carrier is an attacker');
  step(game, T.freeze - 1);
  eq(bomb.phase, 'freeze', 'one tick before the freeze ends the round is not live');
  step(game, 1);
  eq(bomb.phase, 'live', 'the round goes live on the exact tick the freeze ends');
  eq(game.match.canFire(attackers(game)[0]), true, 'weapons unlock when the round goes live');
  eq(bomb.roundTicks, 0, 'the round timer starts at zero, not part-way through the freeze');
  game.dispose();
}

// ═════════════════════════════════════════════════ §4 win conditions, each in isolation

head('§4.pre-plant win conditions');
{
  const game = await newGame();
  const bomb = toLive(game, 'pre-plant elimination');
  wipe(game, bomb.attackingTeam);
  step(game, 1);
  eq(bomb.rounds.length, 1, 'wiping the attackers pre-plant ends the round');
  eq(bomb.rounds[0].winnerTeam, bomb.defendingTeam, '§4.2 all attackers eliminated → DEFENDERS win');
  eq(bomb.rounds[0].reason, 'elimination', 'the round is recorded as an elimination');
  eq(bomb.rounds[0].planted, false, 'the round record says the bomb was never planted');
  eq(bomb.phase, 'roundEnd', 'the round enters its end delay');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'pre-plant defender wipe');
  wipe(game, bomb.defendingTeam);
  step(game, 1);
  eq(bomb.rounds[0].winnerTeam, bomb.attackingTeam, '§4.3 all defenders eliminated → ATTACKERS win');
  eq(bomb.rounds[0].reason, 'elimination', 'that round is an elimination too');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'round timer');
  step(game, T.round - 1);
  eq(bomb.rounds.length, 0, 'one tick before the round timer expires nothing has been decided');
  eq(bomb.roundTimeRemaining, FIXED_DT, 'the round clock reports one step remaining');
  step(game, 1);
  eq(bomb.rounds[0].winnerTeam, bomb.defendingTeam, '§4.4 the round timer expiring → DEFENDERS win');
  eq(bomb.rounds[0].reason, 'timer', 'the round is recorded as a timer expiry');
  game.dispose();
}
{
  // Mutual wipe on one tick: §4 lists "all attackers eliminated" BEFORE "all defenders
  // eliminated", so the defenders take it. Evaluation order must not decide this.
  const game = await newGame();
  const bomb = toLive(game, 'mutual wipe');
  wipe(game, 0);
  wipe(game, 1);
  step(game, 1);
  eq(bomb.rounds[0].winnerTeam, bomb.defendingTeam, '§4 a mutual wipe pre-plant resolves to the DEFENDERS, by precedence');
  eqJson(bomb.aliveCounts(), [0, 0], 'both teams really were empty when it resolved');
  game.dispose();
}

head('§4.post-plant win conditions');
{
  const game = await newGame();
  const bomb = toLive(game, 'detonation');
  plant(game, 'A', 'detonation');
  eq(bomb.bomb.siteId, 'A', 'the round records which site the bomb went down on');
  eq(bomb.bombTimeRemaining, BOMB_PARAMS.bombTimerSeconds, '§3 the bomb timer replaces the round timer at plant');
  eq(bomb.displayTime, BOMB_PARAMS.bombTimerSeconds, 'the HUD clock switches to the bomb timer');
  step(game, T.bomb - 1);
  eq(bomb.rounds.length, 0, 'one tick before the bomb timer expires the round is undecided');
  step(game, 1);
  eq(bomb.rounds[0].winnerTeam, bomb.attackingTeam, '§4 post-plant 2: the bomb timer expiring → ATTACKERS win');
  eq(bomb.rounds[0].reason, 'detonation', 'the round is recorded as a detonation');
  eq(bomb.bomb.state, 'detonated', 'the bomb object ends detonated');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'defuse');
  const planter = plant(game, 'A', 'defuse');
  const defender = defenders(game)[0];
  eq(beginDefuse(game, defender), true, 'a defender inside the defuse volume may start a defuse');
  step(game, T.defuse - 1);
  eq(bomb.rounds.length, 0, 'one tick before the defuse completes the round is undecided');
  eq(bomb.progressOf(defender.id), 62, 'the wire progress byte is short of full one tick out');
  step(game, 1);
  eq(bomb.rounds[0].winnerTeam, bomb.defendingTeam, '§4 post-plant 1: the bomb defused → DEFENDERS win');
  eq(bomb.rounds[0].reason, 'defuse', 'the round is recorded as a defuse');
  eq(bomb.bomb.state, 'defused', 'the bomb object ends defused, not detonated');
  eq(bomb.objectiveStats.get(defender.id).defuses, 1, '§10 the defuser is credited exactly one defuse');
  eq(bomb.objectiveStats.get(planter.id).plants, 1, '§10 the planter keeps their plant');
  eq(game.match.statsFor(defender).defuses, 1, 'the stat book records the defuse');
  eq(game.match.statsFor(planter).plants, 1, 'the stat book records the plant');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'post-plant defender wipe');
  plant(game, 'A', 'post-plant defender wipe');
  wipe(game, bomb.defendingTeam);
  step(game, 1);
  eq(bomb.rounds[0].winnerTeam, bomb.attackingTeam, '§4 post-plant 3: all defenders eliminated → ATTACKERS win');
  eq(bomb.rounds[0].reason, 'elimination', 'that round is an elimination, not a detonation');
  eq(bomb.bomb.state, 'detonated', '§4 the bomb still detonates for presentation once the round is decided');
  game.dispose();
}

// ══════════════════════ §4 post-plant rule 4 — THE load-bearing rule, and its control

head('§4 post-plant 4: eliminating the attackers after the plant wins NOTHING');
{
  const game = await newGame();
  const bomb = toLive(game, 'attackers wiped post-plant');
  plant(game, 'A', 'attackers wiped post-plant');
  const winsBefore = [...bomb.roundWins];
  wipe(game, bomb.attackingTeam);
  step(game, 120);
  eqJson(bomb.aliveCounts()[bomb.attackingTeam], 0, 'every attacker really is eliminated');
  eq(bomb.phase, 'planted', 'the round is still running with no attacker alive');
  eq(bomb.rounds.length, 0, 'no round has been awarded');
  eqJson(bomb.roundWins, winsBefore, 'the defenders were awarded nothing for the wipe');
  step(game, T.bomb - 120 - 1);
  eq(bomb.rounds.length, 0, 'still nothing one tick before the bomb timer expires');
  step(game, 1);
  eq(bomb.rounds[0].winnerTeam, bomb.attackingTeam, 'the bomb detonates and the ATTACKERS win with nobody alive');
  eq(bomb.rounds[0].reason, 'detonation', 'the reason is detonation');
  eq(bomb.rounds[0].aliveAttackers, 0, 'the round record shows the winning team had nobody left');
  game.dispose();
}
{
  // The control: the same wipe BEFORE the plant is a defender win. If the two cases
  // produced the same result, the rule above would be untested.
  const game = await newGame();
  const bomb = toLive(game, 'attackers wiped pre-plant control');
  wipe(game, bomb.attackingTeam);
  step(game, 1);
  eq(bomb.rounds[0].winnerTeam, bomb.defendingTeam, 'control: the identical wipe BEFORE the plant wins for the defenders');
  game.dispose();
}

// ═══════════════════════════════════════════ §4 simultaneity, and no double award

head('§4 simultaneity: plant vs elimination on one tick');
{
  // §4 pre-plant precedence, rule 1 before rule 2. Injecting the attacker-wipe check above
  // the completed-plant check in `_resolve` — the exact refactor §4 exists to prevent —
  // turns this case into a defender elimination win, and this is the case that says so.
  const game = await newGame();
  const bomb = toLive(game, 'plant vs attacker wipe');
  const carrier = carrierIntoSite(game, 'A');
  wipe(game, bomb.attackingTeam, [carrier]);
  bomb.requestInteract(carrier, 'plant');
  step(game, T.plant - 1);
  eq(bomb.aliveCounts()[bomb.attackingTeam], 1, 'the planter is the last attacker alive');
  const scoreBefore = defenders(game).map((e) => game.match.statsFor(e).score);
  const killer = defenders(game)[0];
  // The completing tick, driven through the WHOLE engine with the kill produced in the
  // weapons phase — which runs before the rules, so the referee resolves this tick already
  // knowing the planter is dead. That is the collision §4 legislates for.
  eq(engineStepKilling(game, [carrier], killer), 1,
    'the weapon kill reached the referee BEFORE it resolved the round');
  eq(bomb.aliveCounts()[bomb.attackingTeam], 0, 'and the planter really is dead');
  eq(bomb.phase, 'planted', '§4 pre-plant 1: the plant is a PHASE CHANGE and it comes first');
  eq(bomb.rounds.length, 0, 'no round outcome was awarded for the simultaneous elimination');
  eq(bomb.bomb.state, 'planted', 'the bomb is down, not dropped on the planter\'s corpse');
  eq(bomb.bomb.siteId, 'A', 'on the site they were standing in');
  // The killer is paid for the KILL and nothing more; nobody is paid a round win.
  eqJson(
    defenders(game).map((e, i) => game.match.statsFor(e).score - scoreBefore[i]),
    defenders(game).map((e) => (e === killer ? SCORE.kill : 0)),
    'the killer is paid for the kill and nobody is paid a round win — there is no double award',
  );
  eqJson(defenders(game).map((e) => game.match.statsFor(e).roundWins), defenders(game).map(() => 0),
    'and no defender is credited a round win');
  eq(game.match.statsFor(carrier).plants, 1, 'the planter is credited exactly one plant');
  game.dispose();
}
{
  // Control: the same death ONE TICK EARLIER — the tick that would have carried the plant
  // to its last tick — is an ordinary pre-plant elimination.
  const game = await newGame();
  const bomb = toLive(game, 'plant vs attacker wipe control');
  const carrier = carrierIntoSite(game, 'A');
  wipe(game, bomb.attackingTeam, [carrier]);
  bomb.requestInteract(carrier, 'plant');
  step(game, T.plant - 2);
  eq(engineStepKilling(game, [carrier], defenders(game)[0]), 1, 'control: the kill reached the referee first here too');
  eq(bomb.rounds.length, 1, 'control: the round resolved on that tick');
  eq(bomb.rounds[0].winnerTeam, bomb.defendingTeam, 'control: the planter dying one tick earlier wins for the defenders');
  eq(bomb.rounds[0].reason, 'elimination', 'control: by elimination');
  eq(bomb.rounds[0].planted, false, 'control: and the bomb was never planted');
  eq(game.match.statsFor(carrier).plants, 0, 'control: an interrupted plant credits nothing');
  game.dispose();
}
{
  // Plant completing on the tick the last DEFENDER dies: the plant lands first (phase
  // change), then post-plant rule 3 awards the attackers an elimination.
  const game = await newGame();
  const bomb = toLive(game, 'plant vs defender wipe');
  const carrier = carrierIntoSite(game, 'A');
  bomb.requestInteract(carrier, 'plant');
  step(game, T.plant - 1);
  const doomed = defenders(game).filter((e) => bomb.isAlive(e));
  eq(doomed.length, 4, 'all four defenders are alive going into the completing tick');
  eq(engineStepKilling(game, doomed, carrier), 4, 'and all four kills reached the referee before it resolved');
  eq(bomb.rounds[0].reason, 'elimination', 'a plant and the last defender on one tick resolves as an elimination');
  eq(bomb.rounds[0].winnerTeam, bomb.attackingTeam, 'and the attackers win it');
  eq(bomb.rounds[0].planted, true, 'the round record shows the bomb DID go down');
  eq(bomb.rounds[0].site, 'A', 'on site A');
  eq(game.match.statsFor(carrier).plants, 1, 'the plant still counts — it completed');
  eq(bomb.roundWins[bomb.rounds[0].winnerTeam], 1, 'exactly one round was awarded, not two');
  game.dispose();
}
{
  // §4 pre-plant precedence, rule 3 before rule 4: the last defender dying on the very tick
  // the round timer expires is an ATTACKER elimination win, not a defender timer win.
  const game = await newGame();
  const bomb = toLive(game, 'defender wipe on the timer tick');
  step(game, T.round - 1);
  eq(bomb.rounds.length, 0, 'nothing is decided one tick before the timer expires');
  const doomed = defenders(game).filter((e) => bomb.isAlive(e));
  eq(doomed.length, 4, 'the whole defending side is alive going into the expiry tick');
  eq(engineStepKilling(game, doomed, attackers(game)[0]), 4, 'their deaths reached the referee before it resolved');
  eq(bomb.roundTicks, T.round, 'the round timer expired on that very tick');
  eq(bomb.rounds[0].reason, 'elimination', '§4 pre-plant 3 beats pre-plant 4: it is an elimination');
  eq(bomb.rounds[0].winnerTeam, bomb.attackingTeam, 'and the attackers win it, not the defenders on the clock');
  game.dispose();
}

head('§4 simultaneity: defuse vs the bomb timer');
{
  const game = await newGame();
  const bomb = toLive(game, 'defuse on the detonation tick');
  plant(game, 'A', 'defuse on the detonation tick');
  const defender = defenders(game)[0];
  // Start the defuse so that its LAST tick is the tick the bomb timer expires.
  step(game, T.bomb - T.defuse);
  eq(bomb.bombTicks, T.bomb - T.defuse, 'the bomb timer is exactly one defuse from expiry');
  beginDefuse(game, defender);
  step(game, T.defuse - 1);
  eq(bomb.rounds.length, 0, 'nothing has resolved one tick out');
  step(game, 1);
  eq(bomb.bombTicks, T.bomb, 'the bomb timer expired on that very tick');
  eq(bomb.rounds[0].reason, 'defuse', '§4 simultaneity: the DEFUSE wins the tie');
  eq(bomb.rounds[0].winnerTeam, bomb.defendingTeam, 'so the defenders win');
  eq(bomb.bomb.state, 'defused', 'and the bomb is defused, not detonated');
  game.dispose();
}
{
  // Control: one tick later and the bomb wins. Same setup, one tick of difference.
  const game = await newGame();
  const bomb = toLive(game, 'defuse one tick too late');
  plant(game, 'A', 'defuse one tick too late');
  const defender = defenders(game)[0];
  step(game, T.bomb - T.defuse + 1);
  beginDefuse(game, defender);
  step(game, T.defuse - 1);
  eq(bomb.rounds[0].reason, 'detonation', 'control: a defuse starting one tick later loses to the timer');
  eq(bomb.rounds[0].winnerTeam, bomb.attackingTeam, 'control: the attackers win it');
  eq(bomb.bomb.state, 'detonated', 'control: the bomb detonated');
  game.dispose();
}

head('§4 simultaneity: defuse vs the last defender dying');
{
  const game = await newGame();
  const bomb = toLive(game, 'defuse as the last defender dies');
  plant(game, 'A', 'defuse as the last defender dies');
  const defender = defenders(game)[0];
  beginDefuse(game, defender);
  wipe(game, bomb.defendingTeam, [defender]);
  step(game, T.defuse - 1);
  eq(bomb.aliveCounts()[bomb.defendingTeam], 1, 'the defuser is the last defender alive');
  eq(bomb.rounds.length, 0, 'the round has not resolved yet');
  // The completing tick, with the kill produced in the weapons phase — before the rules run,
  // which is the only ordering the engine has.
  eq(engineStepKilling(game, [defender], attackers(game)[0]), 1,
    'the weapon kill reached the referee BEFORE it resolved the round');
  eq(bomb.rounds.length, 1, 'exactly one round outcome exists');
  eq(bomb.rounds[0].reason, 'defuse', '§4: the defuse completed, so the defuse wins');
  eq(bomb.rounds[0].winnerTeam, bomb.defendingTeam, 'the defenders win it despite having nobody left');
  eq(bomb.aliveCounts()[bomb.defendingTeam], 0, 'and they really do have nobody left');
  eq(bomb.bomb.state, 'defused', 'the bomb is defused, not detonated');
  eq(bomb.objectiveStats.get(defender.id)?.defuses, 1, '§10 the dead defuser is still credited the completion');
  game.dispose();
}
{
  // Control: the same death one tick EARLIER interrupts the defuse and hands the round to
  // the attackers by elimination.
  const game = await newGame();
  const bomb = toLive(game, 'last defender dies one tick early');
  plant(game, 'A', 'last defender dies one tick early');
  const defender = defenders(game)[0];
  beginDefuse(game, defender);
  wipe(game, bomb.defendingTeam, [defender]);
  step(game, T.defuse - 2);
  eq(engineStepKilling(game, [defender], attackers(game)[0]), 1, 'control: the kill reached the referee first here too');
  eq(bomb.rounds.length, 1, 'control: the round resolved on that tick');
  eq(bomb.rounds[0].reason, 'elimination', 'control: dying one tick before completion loses the defuse');
  eq(bomb.rounds[0].winnerTeam, bomb.attackingTeam, 'control: the attackers win by elimination');
  eq(bomb.bomb.state, 'detonated', 'control: the bomb was never defused');
  eq(bomb.objectiveStats.has(defender.id), false, 'control: and the defuser is credited nothing');
  game.dispose();
}

// ══════════════════════════════════════════════ §6 plant — preconditions and interruption

head('§6 plant preconditions, all server-side');
{
  const game = await newGame();
  const bomb = toLive(game, 'plant preconditions');
  const carrier = game.entityById(bomb.bomb.carrierId);
  const otherAttacker = attackers(game).find((e) => e.id !== carrier.id);
  const defender = defenders(game)[0];
  const site = bomb.sites.get('A');

  place(carrier, { x: site.plant.max.x + 5, y: centre(site.plant).y, z: centre(site.plant).z });
  eq(bomb.requestInteract(carrier, 'plant'), false, 'the carrier outside the volume is refused');
  eq(bomb.events[bomb.events.length - 1].reason, REFUSE.outsideVolume, 'the refusal names the volume');
  eq(bomb.events[bomb.events.length - 1].kind, 'interactRefused', '§11 refusals are their own event kind');
  eq(bomb.events[bomb.events.length - 1].requested, 'plant', 'and carry the requested interaction');

  place(carrier, centre(site.plant));
  carrier.grounded = false;
  eq(bomb.requestInteract(carrier, 'plant'), false, 'a carrier off the ground is refused where requiresGround');
  eq(bomb.events[bomb.events.length - 1].reason, REFUSE.notGrounded, 'the refusal names the ground rule');
  carrier.grounded = true;

  place(otherAttacker, centre(site.plant));
  eq(bomb.requestInteract(otherAttacker, 'plant'), false, 'an attacker who is not carrying the bomb is refused');
  eq(bomb.events[bomb.events.length - 1].reason, REFUSE.notCarrying, 'the refusal says they are not carrying it');

  place(defender, centre(site.plant));
  eq(bomb.requestInteract(defender, 'plant'), false, 'a defender standing on the site cannot plant');
  eq(bomb.events[bomb.events.length - 1].reason, REFUSE.wrongTeam, 'the refusal names the team rule');

  eq(bomb.requestInteract(carrier, 'plant'), true, 'the carrier, alive, grounded, inside the volume, may plant');
  step(game, 5);
  eq(bomb._progress.get(carrier.id).ticks, 5, 'progress accumulates on the SERVER, one tick at a time');
  // A kill arrives in the weapons phase; the referee applies its consequences when it steps.
  kill(game, carrier, defender);
  step(game, 1);
  eq(bomb._progress.has(carrier.id), false, 'death resets the progress to zero');
  eq(bomb.progressOf(carrier.id), 0, 'and the wire progress reads zero');
  eq(lastEvent(bomb, 'plantCancel').reason, REFUSE.dead, 'and the cancel names the death');
  eq(bomb._requests.has(carrier.id), false, 'the held request dies with them, so it cannot resume');
  game.dispose();
}

head('§6/§7 interruption at every boundary — no partial credit, no resume');
for (const at of ['first tick', 'one tick before completion', 'the last tick']) {
  const game = await newGame();
  const bomb = toLive(game, `plant interrupted at ${at}`);
  const carrier = carrierIntoSite(game, 'A');
  const before = at === 'first tick' ? 1 : T.plant - 1;
  bomb.requestInteract(carrier, 'plant');
  step(game, before);
  eq(bomb._progress.get(carrier.id).ticks, before, `${at}: the server holds exactly ${before} tick(s) of progress`);
  bomb.releaseInteract(carrier);
  eq(bomb._progress.has(carrier.id), false, `${at}: releasing the key resets progress to zero`);
  eq(lastEvent(bomb, 'plantCancel').reason, REFUSE.released, `${at}: the cancel is reported, with the reason`);
  if (at === 'the last tick') {
    // Releasing on the tick that would have completed it: the plant does not land at all.
    step(game, 1);
    eq(bomb.phase, 'live', `${at}: the plant does not complete after the key went up`);
    eq(game.match.statsFor(carrier).plants, 0, `${at}: and nothing is credited`);
  }
  // No resume: the interrupted progress buys nothing.
  bomb.requestInteract(carrier, 'plant');
  step(game, T.plant - 1);
  eq(bomb.phase, 'live', `${at}: after re-starting, ${T.plant - 1} ticks is still not a plant`);
  step(game, 1);
  eq(bomb.phase, 'planted', `${at}: it takes the FULL plant time again`);
  game.dispose();
}
{
  // Death is the other interruption (§6), and it lands in the weapons phase. A death on the
  // tick BEFORE the plant would complete stops it dead. A death ON the completing tick does
  // NOT — that is §4 simultaneity, asserted above — and the two cases are one tick apart.
  const game = await newGame();
  const bomb = toLive(game, 'plant interrupted by a death one tick out');
  const carrier = carrierIntoSite(game, 'A');
  bomb.requestInteract(carrier, 'plant');
  step(game, T.plant - 2);
  eq(bomb._progress.get(carrier.id).ticks, T.plant - 2, 'the server holds two ticks less than a plant');
  eq(engineStepKilling(game, [carrier], defenders(game)[0]), 1, 'the kill reached the referee before it resolved');
  eq(bomb.phase, 'live', 'the plant did not complete');
  eq(bomb.progressOf(carrier.id), 0, 'and no progress survived the death');
  eq(game.match.statsFor(carrier).plants, 0, 'no partial credit for a plant that was one tick short');
  eq(bomb.bomb.state, 'dropped', '§5 the bomb drops at the dead carrier rather than staying with them');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'plant interrupted by leaving the volume');
  const carrier = carrierIntoSite(game, 'A');
  const site = bomb.sites.get('A');
  bomb.requestInteract(carrier, 'plant');
  step(game, T.plant - 1);
  place(carrier, { x: site.plant.max.x + 5, y: centre(site.plant).y, z: centre(site.plant).z });
  step(game, 1);
  eq(bomb.phase, 'live', 'stepping out of the volume on the last tick cancels the plant');
  eq(lastEvent(bomb, 'plantCancel').reason, REFUSE.outsideVolume, 'the cancel names the volume');
  eq(bomb.progressOf(carrier.id), 0, 'progress is zero, not held');
  place(carrier, centre(site.plant));
  bomb.requestInteract(carrier, 'plant');
  step(game, T.plant - 1);
  eq(bomb.phase, 'live', 'and the plant restarts from zero rather than resuming');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'defuse interrupted');
  plant(game, 'A', 'defuse interrupted');
  const defender = defenders(game)[0];
  const site = bomb.sites.get('A');
  beginDefuse(game, defender);
  step(game, T.defuse - 1);
  place(defender, { x: site.defuse.max.x + 5, y: centre(site.defuse).y, z: centre(site.defuse).z });
  step(game, 1);
  eq(bomb.phase, 'planted', 'leaving the defuse volume one tick from the end cancels the defuse');
  eq(lastEvent(bomb, 'defuseCancel').reason, REFUSE.outsideVolume, 'the cancel is reported as a defuse cancel, naming the volume');
  eq(bomb.progressOf(defender.id), 0, 'defuse progress resets to zero');
  beginDefuse(game, defender);
  step(game, T.defuse - 1);
  eq(bomb.phase, 'planted', 'the restarted defuse gets no credit for the interrupted one');
  step(game, 1);
  eq(bomb.rounds[0].reason, 'defuse', 'it completes only after the full defuse time again');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'plant phase preconditions');
  const carrier = carrierIntoSite(game, 'A');
  bomb.requestInteract(carrier, 'plant');
  step(game, T.plant);
  eq(bomb.phase, 'planted', 'the bomb is planted');
  eq(bomb.requestInteract(carrier, 'plant'), false, '§6.3 a second plant is refused once the bomb is down');
  eq(bomb.events[bomb.events.length - 1].reason, REFUSE.alreadyPlanted, 'the refusal says it is already planted');
  const attacker = attackers(game)[0];
  place(attacker, centre(bomb.sites.get('A').defuse));
  eq(bomb.requestInteract(attacker, 'defuse'), false, '§7 an attacker cannot defuse');
  eq(bomb.events[bomb.events.length - 1].reason, REFUSE.wrongTeam, 'the refusal names the team rule');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'defuse before the plant');
  const defender = defenders(game)[0];
  place(defender, centre(bomb.sites.get('A').plant));
  eq(bomb.requestInteract(defender, 'defuse'), false, '§7 there is nothing to defuse before the plant');
  eq(bomb.events[bomb.events.length - 1].reason, REFUSE.notPlanted, 'the refusal says the bomb is not planted');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'defuse at the wrong site');
  plant(game, 'B', 'defuse at the wrong site');
  const defender = defenders(game)[0];
  place(defender, centre(bomb.sites.get('A').defuse));
  eq(bomb.requestInteract(defender, 'defuse'), false, 'a defender at the OTHER site cannot defuse');
  eq(bomb.events[bomb.events.length - 1].reason, REFUSE.outsideVolume, 'the refusal names the volume');
  place(defender, centre(bomb.sites.get('B').plant));
  eq(bomb.requestInteract(defender, 'defuse'), true, 'site B defuses inside its plant volume, per §3.3');
  game.dispose();
}

head('§7 two defenders do not defuse faster than one');
{
  const one = await newGame({ seed: 5150 });
  const bombOne = toLive(one, 'one defuser');
  plant(one, 'A', 'one defuser');
  const d1 = defenders(one)[0];
  beginDefuse(one, d1);
  let ticksOne = 0;
  while (bombOne.rounds.length === 0 && ticksOne < T.defuse * 2) { step(one); ticksOne++; }

  const two = await newGame({ seed: 5150 });
  const bombTwo = toLive(two, 'two defusers');
  plant(two, 'A', 'two defusers');
  const [e1, e2] = defenders(two);
  expect(e1.id < e2.id, 'the two defusers have distinct ids, lower first', `${e1.id} vs ${e2.id}`);
  // The HIGHER id asks first, so the request map's INSERTION order is the reverse of the id
  // order. `_accumulate` sorts by id, and this is the only thing that can tell: with both
  // defusers completing on the same tick, whichever the loop reaches first takes the credit.
  // A determinism replay cannot see it — insertion order is stable within a process, so both
  // runs of a comparison agree with each other while disagreeing with the rule.
  beginDefuse(two, e2);
  beginDefuse(two, e1);
  step(two, 1);
  let ticksTwo = 1;
  eq(bombTwo.progressActor, e1.id, '§11 the progress actor is the LOWEST id defusing, not the first to ask');
  eq(bombTwo.interaction.actorId, e1.id, 'and that is the actor the wire publishes');
  eq(bombTwo.interaction.kind, 'defuse', 'as a defuse');
  while (bombTwo.rounds.length === 0 && ticksTwo < T.defuse * 2) { step(two); ticksTwo++; }

  eq(ticksOne, T.defuse, 'one defender takes exactly the configured defuse time');
  eq(ticksTwo, T.defuse, 'two defenders take exactly the same time — progress does not stack');
  eq(bombTwo.rounds[0].reason, 'defuse', 'the two-defender round still ends in a defuse');
  eq(bombTwo.objectiveStats.get(e1.id)?.defuses, 1, 'the LOWER entity id is credited with the completion, whoever asked first');
  eq(bombTwo.objectiveStats.has(e2.id), false, 'the second defender is credited nothing — completions only');
  one.dispose(); two.dispose();
}

// ════════════════════════════════════════════════════════════════════ §5 the bomb object

head('§5 the carrier is ONE RANDOM eligible attacker');
{
  // The decoupling from `game.rng` is proved further down; this proves the other half of the
  // rule, which nothing else does: that a draw happens at all. `const carrier = eligible[0]`
  // — or any other fixed index — satisfies "one eligible attacker" and fails here.
  const game = await newGame({ seed: 20260819 });
  const bomb = game.match.bombRules;
  const picks = [];
  for (let round = 1; round <= 6; round++) {
    let guard = 0;
    while (bomb.phase !== 'freeze' && guard < T.freeze + T.roundEnd + 4) { step(game); guard++; }
    eq(bomb.roundNumber, round, `round ${round}: the freeze belongs to the round being counted`);
    const eligible = teamOf(game, bomb.attackingTeam);
    eq(eligible.length, 4, `round ${round}: four attackers are eligible to carry`);
    picks.push(eligible.findIndex((e) => e.id === bomb.bomb.carrierId));
    guard = 0;
    while (bomb.phase !== 'live' && guard < T.freeze + 4) { step(game); guard++; }
    wipe(game, bomb.defendingTeam);       // the attackers take the round; on to the next
    step(game, 1 + T.roundEnd);
  }
  eq(picks.filter((i) => i < 0).length, 0, 'every round\'s carrier was one of that round\'s eligible attackers');
  eqJson(picks, [2, 2, 3, 2, 0, 3], '§5 six rounds draw this exact sequence of carriers from one seed');
  const distinct = [...new Set(picks)].sort((a, b) => a - b);
  eq(distinct.length, 3, '§5 and the draw really is a draw — it lands on three different attackers, not a fixed index');
  game.dispose();
}

head('§5 the bomb object');
{
  const game = await newGame();
  const bomb = toLive(game, 'carrier death and pickup');
  const carrier = game.entityById(bomb.bomb.carrierId);
  const site = bomb.sites.get('A');
  const spot = centre(site.plant);
  place(carrier, spot);
  step(game, 1);
  eqJson([bomb.bomb.position.x, bomb.bomb.position.z], [spot.x, spot.z], 'the bomb tracks its carrier');

  // Keep everyone else well clear so a pickup is deliberate, not incidental.
  for (const e of roster(game)) if (e !== carrier) place(e, { x: site.plant.min.x - 40, y: spot.y, z: spot.z });
  kill(game, carrier, defenders(game)[0]);
  step(game, 1);
  eq(bomb.bomb.state, 'dropped', '§5 the carrier dying drops the bomb');
  eq(bomb.bomb.carrierId, -1, 'and it has no carrier');
  eqJson([bomb.bomb.position.x, bomb.bomb.position.z], [spot.x, spot.z], 'it drops at the death position');
  eq(bomb.events[bomb.events.length - 1].kind, 'bombDropped', 'the drop is reported');
  eq(bomb.events[bomb.events.length - 1].reason, 'carrierDeath', 'with the reason');

  const defender = defenders(game)[0];
  place(defender, { x: spot.x + 0.2, y: spot.y, z: spot.z });
  step(game, 1);
  eq(bomb.bomb.state, 'dropped', '§5 a defender standing on it cannot pick it up');
  eq(bomb.bomb.carrierId, -1, 'and does not become the carrier');
  place(defender, { x: site.plant.min.x - 40, y: spot.y, z: spot.z });

  const nextAttacker = attackers(game).find((e) => bomb.isAlive(e));
  // §5 pickup is CONTACT range. Nothing else pins the distance down: every other pickup in
  // this file happens with the attacker standing almost on top of the bomb, so a range of
  // 25 m would pass all of them.
  place(nextAttacker, { x: spot.x + 3, y: spot.y, z: spot.z });
  step(game, 1);
  eq(bomb.bomb.state, 'dropped', '§5 an attacker three metres away is not in contact with it');
  eq(bomb.bomb.carrierId, -1, 'and does not become the carrier at range');
  place(nextAttacker, { x: spot.x + 1.5, y: spot.y, z: spot.z });
  step(game, 1);
  eq(bomb.bomb.state, 'carried', '§5 any attacker in contact range picks it up, with no cast time');
  eq(bomb.bomb.carrierId, nextAttacker.id, 'and becomes the carrier');
  eq(bomb.events[bomb.events.length - 1].reason, 'pickup', 'the pickup is reported as a pickup');

  // Out of bounds: it can never be lost.
  kill(game, nextAttacker, defender);
  step(game, 1);
  eq(bomb.bomb.state, 'dropped', 'the bomb drops again');
  const valid = { ...bomb.bomb.lastValid };
  const out = game.world.bounds.max.x + 500;
  bomb.bomb.position.x = out;
  for (const e of roster(game)) place(e, { x: site.plant.min.x - 40, y: spot.y, z: spot.z });
  step(game, 1);
  eqJson([bomb.bomb.position.x, bomb.bomb.position.y, bomb.bomb.position.z], [valid.x, valid.y, valid.z],
    '§5 a bomb out of bounds returns to its last valid position');
  eq(bomb.events[bomb.events.length - 1].kind, 'bombRecovered', 'the recovery is reported');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'carrier disconnect');
  const carrier = game.entityById(bomb.bomb.carrierId);
  const spot = centre(bomb.sites.get('A').plant);
  place(carrier, spot);
  step(game, 1);
  bomb.noteDisconnect(carrier);
  eq(bomb.bomb.state, 'dropped', '§9 a carrier disconnecting drops the bomb');
  eqJson([bomb.bomb.position.x, bomb.bomb.position.z], [spot.x, spot.z], 'at their last position');
  eq(bomb.isAlive(carrier), false, 'a disconnected player does not count as alive');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'disconnect mid-plant');
  const carrier = carrierIntoSite(game, 'A');
  bomb.requestInteract(carrier, 'plant');
  step(game, T.plant - 1);
  bomb.noteDisconnect(carrier);
  eq(bomb.progressOf(carrier.id), 0, '§9 disconnecting mid-plant resets the progress to zero');
  step(game, 1);
  eq(bomb.phase, 'live', 'and the plant does not complete on the tick it would have');
  game.dispose();
}

// ═════════════════════════════════════════════════════════ §8 no-respawn and spectating

head('§8 no respawns, and spectator information limits');
{
  const game = await newGame();
  const bomb = toLive(game, 'no respawns');
  const victim = attackers(game)[1];
  kill(game, victim, defenders(game)[0]);
  eq(bomb.eliminated.has(victim.id), true, '§8 a death in a live round is an elimination');
  eq(game.match._respawns.length, 0, 'no respawn is queued');
  step(game, 1200);
  eq(victim.alive, false, 'ten seconds later they are still out');
  eq(game.match.canFire(victim), false, 'and they cannot fire');

  const mate = attackers(game).find((e) => e.id !== victim.id && bomb.isAlive(e));
  const enemy = defenders(game).find((e) => bomb.isAlive(e));
  eq(bomb.canSpectate(victim, mate), true, '§8 a dead player may spectate their own living team-mates');
  eq(bomb.canSpectate(victim, enemy), false, '§8 a dead player may NOT spectate an enemy during a live round');
  eq(bomb.canSpectate(mate, enemy), false, 'a LIVING player spectates nobody');
  eq(bomb.canFreeCam(victim), false, '§8 there is no free camera during a live round');
  eq(bomb.canPing(victim), false, '§8 the eliminated cannot ping');
  eq(bomb.canPing(mate), true, 'and a living player can');

  const chat = [];
  game.bus.on('chat', (p) => chat.push(p));
  const held = bomb.submitChat(victim, 'they rotated B');
  eq(held.delivered, false, '§8 dead-player chat is not delivered live');
  eq(held.deferredUntil, 'freeze', 'it is held until the next freeze');
  eq(chat.length, 0, 'nothing reached the bus');
  const livingSaid = bomb.submitChat(mate, 'pushing A');
  eq(livingSaid.delivered, true, 'a living player is heard immediately');
  eq(chat.length, 1, 'exactly one message reached the bus');

  wipe(game, bomb.defendingTeam);
  step(game, 1);
  eq(bomb.phase, 'roundEnd', 'the round is decided');
  eq(bomb.canFreeCam(victim), true, '§8 free camera opens at roundEnd, when there is nothing to leak');
  eq(bomb.canSpectate(victim, enemy), true, 'and any camera is permitted then');
  // The ping rule is about the LIVE round, not about being dead: once the round is decided
  // there is no call-out left to relay, so the eliminated get their pings back.
  eq(bomb.canPing(victim), true, '§8 the eliminated may ping again once the round is decided');
  step(game, T.roundEnd);
  eq(bomb.phase, 'freeze', 'the next round opens with a freeze');
  eq(chat.length, 2, 'the held message is delivered at the freeze');
  eq(chat[1].text, 'they rotated B', 'and it is the message that was held');
  eq(bomb.eliminated.size, 0, '§8 elimination lasts only until the next freeze');
  eq(victim.alive, true, 'the eliminated are back in the world for the new round');
  game.dispose();
}

// ═════════════════════════════════════════════════════ §9 backfill, disconnect, reconnect

head('§9 backfill and disconnects');
{
  const game = await newGame();
  const bomb = game.match.bombRules;
  eqJson(bomb.canJoin(), { allowed: true, reason: null }, 'joining during warmup is allowed');
  toLive(game, 'backfill');
  eqJson(bomb.canJoin(), { allowed: false, reason: 'ROOM_IN_PROGRESS' },
    '§9 a join request mid-match is refused with ROOM_IN_PROGRESS');
  wipe(game, bomb.defendingTeam);
  step(game, 1);
  eqJson(bomb.canJoin(), { allowed: false, reason: 'ROOM_IN_PROGRESS' }, 'and still refused between rounds');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'reconnect');
  const alive = attackers(game)[1];
  const dead = attackers(game)[2];
  kill(game, dead, defenders(game)[0]);
  bomb.noteDisconnect(alive);
  bomb.noteDisconnect(dead);
  step(game, 60);
  eqJson(bomb.canReconnect(alive.id), { allowed: true, asSpectator: false, reason: null },
    '§9 reconnect inside grace rebinds to the existing entity');
  eqJson(bomb.canReconnect(dead.id), { allowed: true, asSpectator: true, reason: null },
    '§9 a player who was eliminated returns as a spectator');
  const graceTicks = Math.round(BOMB_PARAMS.reconnectGraceSeconds / FIXED_DT);
  step(game, graceTicks - 60);
  eq(bomb.canReconnect(alive.id).allowed, true, 'still allowed on the last tick of grace');
  step(game, 1);
  eqJson(bomb.canReconnect(alive.id), { allowed: false, asSpectator: false, reason: 'GRACE_EXPIRED' },
    '§9 reconnect after grace is refused');
  eqJson(bomb.noteReconnect(dead.id === alive.id ? alive : dead), { allowed: false, asSpectator: false, reason: 'GRACE_EXPIRED' },
    'and the refusal is what noteReconnect returns');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'forfeit');
  for (const e of teamOf(game, 1)) bomb.noteDisconnect(e);
  eq(bomb.phase, 'matchEnd', '§9 a team dropping to zero connected ends the match');
  eq(bomb.series.winnerTeam, 0, 'the remaining team wins');
  eq(bomb.series.outcomeReason, 'forfeit', 'the outcome reason is forfeit, not abandon');
  eq(bomb.series.terminationReason, 'aborted', 'and the termination reason is aborted');
  eq(bomb.series.aggregate, true, '§9 forfeit stats are recorded AND aggregated');
  step(game, 1);
  eq(game.match.phase, 'ended', 'the referee ends the match');
  eq(game.match.result.outcomeReason, 'forfeit', 'and the result record carries the reason');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'no-contest');
  for (const e of roster(game)) bomb.noteDisconnect(e);
  eq(bomb.phase, 'matchEnd', '§9 both teams dropping to zero ends the match');
  eq(bomb.series.winnerTeam, -1, 'with no winner');
  eq(bomb.series.reason, 'no-contest', 'a forfeit is upgraded to a no-contest when the other team goes too');
  eq(bomb.series.outcomeReason, 'no-contest', 'the outcome reason is no-contest, not invalidated');
  eq(bomb.series.aggregate, false, 'no-contest stats are recorded but NOT aggregated');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'abandon');
  const gone = attackers(game)[1];
  bomb.noteDisconnect(gone);
  gone.position.set(1.5, 0.25, 2.5);
  const parked = [gone.position.x, gone.position.y, gone.position.z];
  eq(bomb.abandoned(gone.id), false, 'one round absent is not an abandon');
  wipe(game, bomb.defendingTeam);
  step(game, 1 + T.roundEnd);
  eq(bomb.abandoned(gone.id), false, 'still not, after one full round');
  eq(bomb.phase, 'freeze', 'the next round has begun');
  eqJson([gone.position.x, gone.position.y, gone.position.z], parked,
    'a disconnected player is not respawned at the freeze — they are not in the round');
  eq(bomb.isAlive(gone), false, 'and they do not count as alive');
  wipe(game, bomb.defendingTeam);
  step(game, 1 + T.freeze + T.roundEnd);
  eq(bomb.abandoned(gone.id), true, `§2 ${BOMB_PARAMS.abandonRounds} consecutive rounds absent is an abandon`);
  game.dispose();
}

// ═══════════════════════════════════════════════ §2.1a series: transitions and side switch

head('§2.1a round transitions, side switch and the series');
{
  const game = await newGame({ seed: 777 });
  const bomb = toLive(game, 'series');
  const firstAttackers = bomb.attackingTeam;
  eq(firstAttackers, 0, 'team 0 attacks the first half');
  const seen = [];
  // Team 0 wins every round by wiping team 1 — which is an elimination win whichever
  // side team 0 happens to be on, so the same script survives the side switch.
  for (let round = 1; round <= 7; round++) {
    if (bomb.phase !== 'live') {
      let guard = 0;
      while (bomb.phase !== 'live' && guard < T.freeze + T.roundEnd + 4) { step(game); guard++; }
    }
    seen.push({ round: bomb.roundNumber, attacking: bomb.attackingTeam, switched: bomb.sideSwitched });
    wipe(game, 1);
    step(game, 1);
    if (round === 7) {
      eq(bomb.phase, 'roundEnd', 'the seventh round plays out its end delay like any other');
      eq(bomb.series, null, 'and the series is not resolved before that delay is served');
    }
    step(game, T.roundEnd);
  }
  eqJson(seen.map((s) => s.round), [1, 2, 3, 4, 5, 6, 7], 'the rounds run 1 through 7 in order');
  eqJson(seen.map((s) => s.attacking), [0, 0, 0, 0, 0, 0, 1],
    '§2 sides switch after round 6 and not before');
  // The published flag is the same rule read a second way, and it is read by the HUD. It
  // must flip ON round 7, the first round of the second half — not one round later.
  eqJson(seen.map((s) => s.switched), [false, false, false, false, false, false, true],
    '§2 `sideSwitched` is false for all six rounds of the first half and true from round 7');
  eqJson(bomb.roundWins, [7, 0], 'team 0 has 7 round wins');
  eq(bomb.phase, 'matchEnd', '§2.1a reaching 7 ends the match immediately');
  eq(bomb.rounds.length, 7, 'the remaining rounds are not played');
  eq(bomb.series.reason, 'roundsToWin', 'the series record says why');
  eq(bomb.series.winnerTeam, 0, 'and who won');
  step(game, 1);
  eq(game.match.phase, 'ended', 'the referee ends the match on the next step');
  eq(game.match.result.reason, 'roundsToWin', 'the match result carries the series reason');
  eq(game.match.result.winnerTeam, 0, 'and the winning team');
  eqJson(game.match.result.roundWins, [7, 0], 'and the round score');
  eq(game.match.result.rounds.length, 7, 'and a record per round');
  eq(game.match.result.maxRounds, 12, 'and the MR12 format it was played under');
  game.dispose();
}
{
  const game = await newGame({ seed: 778 });
  const bomb = toLive(game, 'draw');
  for (let round = 1; round <= 12; round++) {
    let guard = 0;
    while (bomb.phase !== 'live' && guard < T.freeze + T.roundEnd + 4) { step(game); guard++; }
    wipe(game, round % 2 === 0 ? 0 : 1);   // alternate, so neither side reaches 7
    step(game, 1);
    step(game, T.roundEnd);
  }
  eqJson(bomb.roundWins, [6, 6], 'twelve alternating rounds end 6-6');
  eq(bomb.phase, 'matchEnd', 'the match ends after the twelfth round');
  eq(bomb.rounds.length, 12, 'exactly twelve rounds were played');
  eq(bomb.series.winnerTeam, -1, '§2.1a 6-6 after 12 has no winner');
  eq(bomb.series.winnerLabel, 'draw', 'the series record says "draw"');
  eq(bomb.series.reason, 'draw', 'and the reason is a draw, not a timer');
  step(game, 1);
  eq(game.match.result.outcome, 'draw', 'the match result is a draw');
  game.dispose();
}

// ═════════════════════════════════════════════════════════════════════════ §10 scoring

head('§10 objective scoring');
{
  const game = await newGame();
  const bomb = toLive(game, 'scoring');
  const carrier = carrierIntoSite(game, 'A');
  const before = game.match.statsFor(carrier).score;
  bomb.requestInteract(carrier, 'plant');
  step(game, T.plant);
  eq(game.match.statsFor(carrier).score - before, SCORE.plant, '§10 a completed plant pays the plant award');
  const defender = defenders(game)[0];
  const dBefore = game.match.statsFor(defender).score;
  beginDefuse(game, defender);
  step(game, T.defuse);
  eq(game.match.statsFor(defender).score - dBefore, SCORE.defuse + SCORE.roundWin,
    '§10 a completed defuse pays the defuse award and the round win');
  eq(game.match.statsFor(defender).roundWins, 1, 'the round win is booked once');
  eq(game.match.statsFor(carrier).roundWins, 0, 'and not to the losing side');
  let threw = '<no throw>';
  try { game.match.awardObjective(carrier, 'nonsense'); } catch (err) { threw = err.message; }
  expect(threw.includes('unknown objective award'), 'an unknown award id throws rather than paying nothing quietly', threw);
  game.dispose();
}
{
  const game = await newGame({ seed: 4242 });
  const bomb = toLive(game, 'clutch');
  const hero = defenders(game)[0];
  wipe(game, bomb.defendingTeam, [hero]);
  step(game, 1);
  eq(bomb.aliveCounts()[bomb.defendingTeam], 1, 'one defender is left against the whole attacking side');
  const before = game.match.statsFor(hero).score;
  wipe(game, bomb.attackingTeam);
  step(game, 1);
  eq(bomb.rounds[0].clutchBy, hero.id, '§10 the last player standing is recorded as the clutch');
  eq(game.match.statsFor(hero).score - before, SCORE.roundWin + SCORE.clutch, 'and is paid the clutch on top of the round win');
  eq(game.match.statsFor(hero).clutches, 1, 'the clutch is booked once');
  game.dispose();
}
{
  // The control for the rule above: a 1v1 is not a clutch. Nothing else pinned the
  // "two or more enemies" half of §10 down, so a clutch awarded against a single opponent
  // — every last-man-standing round in the match — went unnoticed.
  const game = await newGame({ seed: 4242 });
  const bomb = toLive(game, 'clutch control');
  const hero = defenders(game)[0];
  const lastEnemy = attackers(game)[0];
  wipe(game, bomb.defendingTeam, [hero]);
  wipe(game, bomb.attackingTeam, [lastEnemy]);
  step(game, 1);
  eqJson([bomb.aliveCounts()[bomb.defendingTeam], bomb.aliveCounts()[bomb.attackingTeam]], [1, 1],
    'the round is down to one against one');
  const before = game.match.statsFor(hero).score;
  kill(game, lastEnemy, null);            // no killer, so no kill award muddies the total
  step(game, 1);
  eq(bomb.rounds[0].winnerTeam, bomb.defendingTeam, 'the last defender wins the round');
  eq(bomb.rounds[0].clutchBy, -1, '§10 but beating ONE opponent is not a clutch');
  eq(game.match.statsFor(hero).score - before, SCORE.roundWin, 'so they are paid the round win and nothing else');
  eq(game.match.statsFor(hero).clutches, 0, 'and no clutch is booked');
  game.dispose();
}

// ═════════════════════════════════════════════════════════════════ TDM is unaffected

head('TDM still plays by its own rules');
{
  const game = await newGame({ mode: 'tdm', botCount: 7 });
  eq(game.match.modeId, 'tdm', 'a TDM match resolves to the TDM ruleset');
  eq(game.match.bombRules, null, 'and carries no bomb state');
  const attacker = game.player;
  const victim = game.bots.bots.find((b) => b.team !== attacker.team);
  kill(game, victim, attacker);
  eq(game.match._respawns.length, 1, 'a TDM death still queues a respawn');
  eq(game.match.canFire(attacker), true, 'and TDM has no round freeze');
  game.dispose();
}

// ═══════════════════════════════════════ §11 the state this ruleset puts on the wire

head('§11 replication view');
{
  const game = await newGame({ seed: 4711 });
  const bomb = game.match.bombRules;
  const match = game.match;
  eq(match.roundPhase, 'warmup', 'the round phase is published separately from the match phase');
  eq(match.phase, 'live', 'and the match phase is the match\'s own lifecycle, untouched');
  eqJson(match.aliveCounts, { alpha: 4, bravo: 4 }, 'alive counts are published per side');
  eqJson(match.interaction, { kind: 'none', actorId: 0, progress: 0 }, 'with no interaction in progress');
  toLive(game, 'replication');
  eq(match.roundPhase, 'live', 'the round phase follows the ruleset');
  eq(match.phaseRemainingMs, BOMB_PARAMS.roundSeconds * 1000, 'the phase clock is published in milliseconds');
  eq(match.roundIndex, 0, 'the round index is 0-based');
  eq(match.attackingTeam, 0, 'the attacking side is published');
  eq(match.sideSwitched, false, 'and whether the sides have switched');
  eq(match.bomb.state, 'carried', 'match.bomb is the bomb OBJECT — plain data, not the rules');
  eq(match.bomb.carrierId, bomb.bomb.carrierId, 'carrying the carrier id');
  eq(match.bomb.siteId, null, 'and no site until it is planted');

  const carrier = carrierIntoSite(game, 'A');
  bomb.requestInteract(carrier, 'plant');
  step(game, T.plant / 2);
  eqJson(match.interaction, { kind: 'plant', actorId: carrier.id, progress: 0.5 },
    'a half-finished plant publishes kind, actor and a 0..1 progress');
  eq(bomb.progressOf(carrier.id), 31, 'and the same progress quantised to the 0..63 wire byte');
  step(game, T.plant / 2);
  eq(match.roundPhase, 'planted', 'the phase changes on the plant');
  eq(match.bomb.state, 'planted', 'so does the bomb state');
  eq(match.bomb.siteId, 'A', 'and the site is published');
  eqJson(match.interaction, { kind: 'none', actorId: 0, progress: 0 }, 'the plant bar clears');
  eq(match.phaseRemainingMs, BOMB_PARAMS.bombTimerSeconds * 1000, 'the published clock is now the bomb timer');

  wipe(game, bomb.defendingTeam);
  step(game, 1);
  eqJson([match.scores[0], match.scores[1]], [1, 0],
    'the referee\'s team score IS the round score, so the scoreline replicates');
  eqJson(match.aliveCounts, { alpha: 4, bravo: 0 }, 'and the alive counts reflect the wipe');

  // The server's reader (src/net/server.js, [CC] net lane) consumes exactly this shape.
  // If that file and this one drift apart, this check is where it shows up.
  let frame = null;
  let importError = '';
  try {
    const { readBombMatchState } = await import('../src/net/server.js');
    frame = readBombMatchState(game);
  } catch (err) { importError = err.message; }
  expect(frame !== null, 'the server\'s MSG_MATCHSTATE reader accepts this match', importError || 'reader returned null');
  if (frame) {
    // This pair was a deliberate tripwire while the two lanes disagreed: the server reader
    // took `match.phase` (the MATCH lifecycle) rather than `match.roundPhase`, so the wire
    // said "live" for every phase of every round and could never send freeze, planted or
    // roundEnd. The §3 state machine collapsed to one value on the wire while every field
    // around it stayed correct — which is exactly the kind of gap a green suite hides.
    //
    // Fixed in src/net/server.js. The assertion is now the CORRECT one: the wire must carry
    // the round phase the ruleset is actually in, and a regression to `match.phase` fails
    // here rather than being reported as a known gap.
    eq(match.roundPhase, 'roundEnd', 'the ruleset publishes the round phase as roundEnd');
    eq(frame.phase, 'roundEnd',
      'and the WIRE carries the round phase, not the match lifecycle');
    eq(frame.bomb.state, 'detonated', 'and the bomb state');
    eq(frame.bomb.siteId, 'A', 'and the site');
    eq(frame.scoreAlpha, 1, 'and the round score');
    eq(frame.aliveAlpha, 4, 'and the alive counts');
    eq(frame.attackingTeam, 0, 'and which side is attacking');
    eqJson(frame.interaction, { kind: 'none', actorId: 0, progress: 0 }, 'and the objective progress');
  }
  game.dispose();
}
{
  const game = await newGame({ mode: 'tdm' });
  eq(game.match.bomb, null, 'a TDM match publishes no bomb object');
  eq(game.match.bombRules, null, 'and holds no ruleset');
  eq(game.match.roundPhase, 'live', 'its round phase is its match phase');
  eqJson(game.match.aliveCounts, { alpha: 0, bravo: 0 }, 'and the Bomb-only fields are empty rather than absent');
  eqJson(game.match.interaction, { kind: 'none', actorId: 0, progress: 0 }, 'with no interaction');
  eq(game.match.phaseRemainingMs, 0, 'and no phase clock');
  game.dispose();
}

// ══════════════════════════════════════════════════ guards that no scenario above reaches
//
// Every check below exists because deleting one specific line left the suite green. They
// are grouped rather than scattered so the reason they exist stays visible.

head('individually load-bearing guards');
{
  const game = await newGame();
  const bomb = game.match.bombRules;
  step(game, 1);
  eq(bomb.displayTime, BOMB_PARAMS.freezeSeconds, 'during the freeze the HUD clock counts the freeze down');
  step(game, T.freeze);
  eq(bomb.displayTime, BOMB_PARAMS.roundSeconds, 'once live it counts the ROUND down');
  step(game, 120);
  eq(bomb.displayTime, BOMB_PARAMS.roundSeconds - 1, 'and keeps counting');

  // A non-combatant (streak hardware carries no team) must not enter the roster.
  const sentry = { id: 99001, team: -1, alive: true, position: { x: 0, y: 0, z: 0 } };
  const before = bomb._roster().length;
  game.addEntity(sentry);
  step(game, 1);
  eq(game.entities.length, before + 1, 'the sentry really is in the world');
  eq(bomb._roster().length, before, 'a teamless entity is not a combatant and never joins the roster');
  eqJson(bomb.aliveCounts(), [4, 4], 'and does not appear in either team\'s alive count');
  game.removeEntity(sentry);

  // BotManager keeps its own fallback respawn timer and can put a bot back in the world.
  // Elimination is the RULESET's state and must survive that.
  const victim = attackers(game)[1];
  kill(game, victim, defenders(game)[0]);
  victim.alive = true;
  eq(bomb.isAlive(victim), false, 'an entity revived from outside the ruleset is still eliminated');
  eq(game.match.canFire(victim), false, 'and still cannot fire');
  eq(bomb.requestInteract(victim, 'plant'), false, 'and still cannot interact');
  eq(lastEvent(bomb, 'interactRefused').reason, REFUSE.dead, 'their request is refused as dead');

  eq(bomb.requestInteract(null, 'plant'), false, 'a request from no entity is refused, not a crash');
  const eventsBefore = bomb.events.length;
  eq(bomb.requestInteract(attackers(game)[0], 'dance'), false, 'an unknown interaction kind is refused');
  eq(bomb.events.length, eventsBefore, 'an interaction the protocol does not define is dropped, not answered with a refusal');
  eq(bomb.releaseInteract(null), undefined, 'releasing for no entity is a no-op');
  eq(bomb.noteDisconnect(null), undefined, 'a disconnect for no entity is a no-op');
  eq(bomb.onKill(null, null), undefined, 'a death report with no victim is a no-op');
  eq(bomb.isAlive(null), false, 'nobody is not alive');
  eq(bomb._roster() === bomb._roster(), true, 'the roster is built once per step, not per question');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = game.match.bombRules;
  step(game, 1);
  const carrier = carrierIntoSite(game, 'A');
  eq(bomb.phase, 'freeze', 'the round is frozen');
  eq(bomb.requestInteract(carrier, 'plant'), false, '§6.3 a plant during the freeze is refused');
  eq(lastEvent(bomb, 'interactRefused').reason, REFUSE.wrongPhase, 'the refusal names the phase');
  eq(bomb.canSpectate(defenders(game)[0], attackers(game)[0]), false, 'nobody spectates during a freeze');
  eq(bomb.canSpectate(null, null), false, 'a spectate request with no viewer or target is refused');
  while (bomb.phase !== 'live') step(game);
  // Drop position with no intervening step: the bomb lands where the carrier IS.
  const spot = centre(bomb.sites.get('B').plant);
  place(carrier, spot);
  bomb.noteDisconnect(carrier);
  eqJson([bomb.bomb.position.x, bomb.bomb.position.z], [spot.x, spot.z],
    'a disconnecting carrier drops the bomb at their position, not at the last one replicated');
  eq(bomb.requestInteract(carrier, 'plant'), false, 'a disconnected player cannot interact');
  eq(lastEvent(bomb, 'interactRefused').reason, REFUSE.disconnected, 'and the refusal says so, rather than calling them dead');
  game.dispose();
}
{
  // §8 says death in `live` OR `planted` is an elimination until the next freeze. Every
  // elimination case elsewhere in this file happens PRE-plant, so the `planted` half was
  // carried by nothing — and BotManager's own fallback respawn timer, which can put a bot
  // back in the world mid-round, is the live consequence of getting it wrong.
  const game = await newGame();
  const bomb = toLive(game, 'elimination during the planted phase');
  const carrier = plant(game, 'A', 'post-plant elimination');
  const victim = defenders(game)[0];
  const aliveBefore = bomb.aliveCounts()[bomb.defendingTeam];
  eq(aliveBefore, 4, 'the defending side is whole before the kill');
  kill(game, victim, carrier);
  step(game, 1);
  eq(bomb.phase, 'planted', 'the round is still in the planted phase');
  eq(bomb.eliminated.has(victim.id), true, '§8 a death in the PLANTED phase is an elimination too');
  eq(bomb.aliveCounts()[bomb.defendingTeam], 3, 'and the defending side is one lighter for it');
  victim.alive = true;                    // BotManager's fallback respawn, mid-round
  eq(bomb.isAlive(victim), false, 'a post-plant elimination survives a revival from outside the ruleset');
  eq(bomb.aliveCounts()[bomb.defendingTeam], 3, 'so the alive count on the wire does not jump back up');
  eq(game.match.canFire(victim), false, 'and they still cannot fire');
  place(victim, centre(bomb.sites.get('A').defuse));
  eq(bomb.requestInteract(victim, 'defuse'), false, 'nor defuse the bomb they were eliminated in front of');
  eq(lastEvent(bomb, 'interactRefused').reason, REFUSE.dead, 'their request is refused as dead');
  step(game, 1);
  eq(bomb.progressOf(victim.id), 0, 'and no defuse progress accrues for a corpse standing in the volume');
  game.dispose();
}
{
  // §3: in `planted` the round timer is REPLACED by the bomb timer, not run alongside it.
  // Nothing could see this, because the bomb timer (40 s) always expires long before the
  // round timer (1:45) could, so a round clock left running is invisible in play — until a
  // shorter round or a longer bomb timer makes it decide a round.
  const game = await newGame();
  const bomb = toLive(game, 'the bomb timer replaces the round timer');
  plant(game, 'A', 'timer replacement');
  const atPlant = bomb.roundTicks;
  eq(atPlant, T.plant, 'the round timer ran up to the plant and no further');
  step(game, 600);
  eq(bomb.roundTicks, atPlant, '§3 the round timer stops dead at the plant');
  eq(bomb.bombTicks, 600, 'and the bomb timer is the clock that advances');
  eq(bomb.roundTimeRemaining, (T.round - atPlant) * FIXED_DT, 'the round clock is frozen where it stopped');
  eq(bomb.displayTime, bomb.bombTimeRemaining, 'and the HUD shows the bomb timer, not the round timer');
  game.dispose();
}
{
  // `_roster()` sorts by entity id. Within one process the world's entity array is already
  // in a stable order, so two runs of a determinism replay agree with each other whether the
  // sort is there or not — the invariant has to be asserted directly, with a combatant whose
  // id is out of insertion order.
  const game = await newGame();
  const bomb = toLive(game, 'roster ordering');
  const before = bomb._roster().map((e) => e.id);
  const straggler = {
    id: Math.min(...before) - 1, team: 0, alive: true, grounded: true,
    position: { x: 0, y: 0, z: 0 },
  };
  game.addEntity(straggler);
  step(game, 1);
  const all = game.entities;
  eq(all[all.length - 1].id, straggler.id, 'the world appends the newcomer LAST, as join order demands');
  eq(bomb._roster()[0].id, straggler.id, 'but the roster the rules iterate puts the lowest id FIRST');
  const ids = bomb._roster().map((e) => e.id);
  eqJson(ids, [...ids].sort((a, b) => a - b), 'and the whole roster is in id order, not world order');
  eq(ids.length, before.length + 1, 'with the newcomer counted exactly once');
  game.removeEntity(straggler);
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'spectator guards');
  const [a1, a2] = attackers(game);
  const d1 = defenders(game)[0];
  eq(bomb.canSpectate(a1, a2), false, 'a LIVING player may not spectate, even a team-mate');
  kill(game, a1, d1);
  kill(game, a2, d1);
  eq(bomb.canSpectate(a1, a2), false, 'a dead player may not spectate another DEAD team-mate');
  eq(bomb.canSpectate(a1, attackers(game).find((e) => bomb.isAlive(e))), true,
    'but may spectate a living one');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'reconnect guards');
  const gone = attackers(game)[1];
  bomb.noteDisconnect(gone);
  step(game, Math.round(BOMB_PARAMS.reconnectGraceSeconds / FIXED_DT) + 1);
  eq(bomb.noteReconnect(gone).allowed, false, 'a reconnect after grace is refused');
  eq(bomb.isConnected(gone.id), false, 'and the refused player is NOT rebound to the match');
  // A player who never left is never refused, however long the match has been running —
  // the grace clock applies to the DISCONNECTED, not to everyone.
  eqJson(bomb.canReconnect(attackers(game)[0].id), { allowed: true, asSpectator: false, reason: null },
    'a still-connected player is not caught by the expired grace window');
  // Once the match is over there is nothing left to protect.
  for (const e of teamOf(game, bomb.defendingTeam)) bomb.noteDisconnect(e);
  eq(bomb.phase, 'matchEnd', 'the match ends');
  eqJson(bomb.canReconnect(gone.id), { allowed: true, asSpectator: false, reason: null },
    '§9 after matchEnd a lapsed player may return');
  game.dispose();
}
{
  const game = await newGame();
  const bomb = toLive(game, 'forfeit mirror');
  for (const e of teamOf(game, 0)) bomb.noteDisconnect(e);
  eq(bomb.series.winnerTeam, 1, '§9 team 0 emptying forfeits to team 1');
  eq(bomb.series.outcomeReason, 'forfeit', 'as a forfeit');
  eq(game.match.awardObjective(null, 'plant'), null, 'awarding an objective to nobody is a no-op, not a crash');
  game.dispose();
}
{
  // Team 1 reaching 7 must end the match too — the same rule, the other index.
  const game = await newGame({ seed: 909 });
  const bomb = toLive(game, 'team 1 series');
  for (let round = 1; round <= 7; round++) {
    let guard = 0;
    while (bomb.phase !== 'live' && guard < T.freeze + T.roundEnd + 4) { step(game); guard++; }
    wipe(game, 0);
    step(game, 1 + T.roundEnd);
  }
  eqJson(bomb.roundWins, [0, 7], 'team 1 has 7 round wins');
  eq(bomb.phase, 'matchEnd', 'and the match ends on team 1 reaching 7');
  eq(bomb.series.winnerTeam, 1, 'with team 1 as the winner');
  game.dispose();
}
{
  // An attacking side with nobody on it (possible after the side switch on a lopsided
  // roster) must not leave the bomb attached to an entity that does not exist.
  const game = await newGame({ seed: 61, botCount: 0 });
  const bomb = toLive(game, 'empty attacking side');
  eq(bomb.aliveCounts()[1], 0, 'team 1 has no players in this match');
  for (let round = 1; round <= 6; round++) {
    let guard = 0;
    while (bomb.phase !== 'live' && guard < T.freeze + T.roundEnd + 4) { step(game); guard++; }
    wipe(game, 0);
    step(game, 1 + T.roundEnd);
  }
  eq(bomb.attackingTeam, 1, 'the sides have switched, so the empty team now attacks');
  eq(bomb.bomb.carrierId, -1, '§5 with no eligible attacker the bomb has no carrier');
  eq(bomb.bomb.state, 'dropped', 'and it lies on the ground rather than following a ghost');
  game.dispose();
}

// ═══════════════════════════════════════════════════════════════════ §12.12 determinism

head('§12.12 determinism');

{
  // §5's carrier draw comes from a stream derived from (matchSeed, roundIndex), NOT from
  // `game.rng` — which respawn jitter and bot behaviour also draw on. Taking it from the
  // shared stream would make the carrier depend on how many unrelated draws happened
  // first, which is a replay divergence waiting for the first bot to die at a new time.
  const clean = await newGame({ seed: 12321 });
  step(clean, 1);
  const cleanCarrier = clean.match.bombRules.bomb.carrierId;
  clean.dispose();

  const disturbed = await newGame({ seed: 12321 });
  for (let i = 0; i < 7; i++) disturbed.rng();
  step(disturbed, 1);
  eq(disturbed.match.bombRules.bomb.carrierId, cleanCarrier,
    '§5 the carrier draw is unaffected by unrelated draws on the shared RNG stream');
  disturbed.dispose();
}

/** A scripted round, identical every time it is run, exercising every subsystem. */
async function scriptedRun(seed) {
  const game = await newGame({ seed, botCount: 7 });
  const bomb = game.match.bombRules;
  while (bomb.phase !== 'live') step(game);
  const carrier = carrierIntoSite(game, 'A');
  bomb.requestInteract(carrier, 'plant');
  step(game, 40);
  bomb.releaseInteract(carrier);          // an interrupted plant
  kill(game, attackers(game).find((e) => e.id !== carrier.id), defenders(game)[0]);
  step(game, 30);
  bomb.requestInteract(carrier, 'plant');
  step(game, T.plant);
  const defender = defenders(game)[0];
  beginDefuse(game, defender);
  step(game, 200);
  kill(game, defender, carrier);           // interrupted defuse
  step(game, 60);
  const second = defenders(game).find((e) => bomb.isAlive(e));
  beginDefuse(game, second);
  step(game, T.defuse);                    // defused, round over
  step(game, T.roundEnd + T.freeze + 10);  // into the next round
  const snapshot = {
    bomb: bomb.state(),
    scores: [...game.match.scores],
    rows: game.match.getScoreboardRows().map((r) => ({ ...r, entity: undefined })),
  };
  game.dispose();
  return snapshot;
}

{
  const a = await scriptedRun(31337);
  const b = await scriptedRun(31337);
  // The runs must be non-trivial, or "identical" would mean "both empty".
  eq(a.bomb.rounds.length, 1, 'the scripted run completes exactly one round');
  eq(a.bomb.rounds[0].reason, 'defuse', 'which ends in a defuse');
  eq(a.bomb.roundNumber, 2, 'and leaves the match in round 2');
  eq(a.bomb.events.filter((e) => e.kind === 'plantCancel').length, 1, 'with one cancelled plant');
  eq(a.bomb.events.filter((e) => e.kind === 'defuseCancel').length, 1, 'and one cancelled defuse');
  eq(JSON.stringify(a) === JSON.stringify(b), true, 'two identical scripted runs produce byte-identical state');
  const c = await scriptedRun(31338);
  expect(JSON.stringify(c.bomb.bomb) !== JSON.stringify(a.bomb.bomb) || c.bomb.events.length !== a.bomb.events.length
    || JSON.stringify(c.rows) !== JSON.stringify(a.rows),
  'a different seed produces a different match — the comparison is not vacuous',
  'seed 31338 produced identical state to 31337');
}

/** The full engine loop, bots included: nothing in the round machine reads a clock. */
async function liveRun(seed, ticks) {
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter() });

  game.startMatch({ mode: 'bomb', botCount: 7, seed });
  for (let i = 0; i < ticks; i++) game._fixedUpdate(FIXED_DT);
  const out = {
    bomb: game.match.bombRules ? game.match.bombRules.state() : null,
    rows: game.match.getScoreboardRows().map((r) => ({ ...r, entity: undefined })),
  };
  game.dispose();
  return out;
}

{
  const ticks = 2400;
  const a = await liveRun(9091, ticks);
  const b = await liveRun(9091, ticks);
  eq(a.bomb.phase, 'live', 'the live run reaches a live round');
  eq(JSON.stringify(a) === JSON.stringify(b), true,
    'two identical FULL-ENGINE runs from one seed produce byte-identical bomb state and stats');
}

console.log(failures
  ? `\n${failures} of ${checks} Bomb check(s) failed`
  : `\nBomb ruleset is clean — ${checks} checks`);
process.exit(failures ? 1 : 0);
