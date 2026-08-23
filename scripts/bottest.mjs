/**

 * ── A cross-process determinism worry, investigated and closed ───────────────────────────
 * While this harness was being written, two runs of byte-identical files reported different
 * round/plant/defuse counts (40/33/15 against 38/30/13), and the author could not reproduce it
 * on demand across nine further runs, including under CPU load. It was left recorded rather
 * than dismissed, because every stochastic threshold in this file depends on the answer.
 *
 * It is not a scheduler or a CPU-count effect. Measured afterwards on a settled tree: three
 * consecutive runs and three CONCURRENT runs all produce 41 rounds, 27 plants, 8 defuses with
 * an identical per-series split.
 *
 * The cause was the tree moving underneath the runs. Bot paths come from the nav graph, the nav
 * graph is baked from `src/world/level.js`, and another session was editing that file
 * continuously — the same edits that kept the nav-bake staleness guard firing. Different
 * geometry, different routes, different plants. The simulation was deterministic the whole
 * time; the INPUT was not.
 *
 * The lesson generalises past this file: a measurement taken while another lane is editing a
 * shared input is a measurement of two things at once. Quote the geometry fingerprint beside
 * any number from this harness — `scripts/navtest.mjs`'s ROUTE_BASELINE pins exactly that, for
 * exactly this reason.
 * P3 exit criterion 3 — "Bots navigate The Square and play both modes."
 *
 * `bombbottest.mjs` (H3.3) already proves that ONE autonomous Bomb series on The Square
 * reaches matchEnd with legal plants and defuses. That is a liveness proof for a single
 * seed. It says nothing about the two questions this criterion actually asks:
 *
 *   1. Is every bot NAVIGATING, or is the match being carried by the ones that happen to
 *      spawn near the action? A roster where two bots are wedged behind a crate for four
 *      minutes still finishes a series, still plants, still ends at matchEnd, and still
 *      prints PASS. So the measurements here are per-bot minima and per-bot worst cases,
 *      never roster averages — an average of eleven hides two.
 *   2. Does any of it hold on the OTHER map, and in the OTHER mode? Every regression this
 *      project has found in the last week showed on exactly one pairing.
 *
 * The nav bake is not the thing under test and is not an excuse available to it: The Square
 * reports 11,590 walkable / 8,311 reachable nodes and 0 phantoms, so a bot that cannot move
 * has a bot-side cause. This harness is written to find that cause and name the coordinate.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED: nothing here checks that a plant or a defuse is legal
 * — `bombtest.mjs` owns every win condition, precedence rule and interruption boundary, and
 * duplicating it here would produce two half-authorities. This harness only asks whether
 * autonomous bots ever GET there.
 */
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';
import { FIXED_DT } from '../src/core/mathUtils.js';
import { bombAvailable } from '../src/game/modes.js';

// ─────────────────────────────────────────────────────────────────────── reporting

let checks = 0;
const failures = [];
const notes = [];
const check = (condition, message, detail = '') => {
  checks++;
  if (condition) return true;
  failures.push(`${message}${detail === '' ? '' : ` — ${detail}`}`);
  return false;
};
const note = (line) => { notes.push(line); console.log(`  ${line}`); };
const heading = (line) => console.log(`\n${line}`);

/**
 * `[].every()` is `true` and `[].some()` is `false`, so both are silent passes on an empty
 * array — three assertions in this repository have already been found asserting nothing
 * that way. Every quantifier below goes through one of these two, which refuse an empty
 * input rather than answering about it.
 */
const allOf = (rows, predicate) => Array.isArray(rows) && rows.length > 0 && rows.every(predicate);
const anyOf = (rows, predicate) => Array.isArray(rows) && rows.length > 0 && rows.some(predicate);

const BOTS = 11;
const DIFFICULTY = 'regular';

// ─────────────────────────────────────────────────────────────────── measurement

// MERIDIAN's Bomb sites used to be injected here as test fixture data because the map
// published no objective volumes at all. The map-data.md §9 (1.4.0) un-retirement moved
// those exact two boxes into the producer: `MERIDIAN_FIXTURE.MAP_MANIFEST.objectives` in
// src/world/level.js now declares them, so the Bomb series below runs on the map's own
// data — which is also what a lobby room on 'meridian' plays. The general-vs-fitted
// question the injection existed to answer is still answered: the coordinates remain ones
// the bot objective layer never saw during The Square's tuning.

/**
 * A bot counts as trying-and-failing only while it HAS somewhere to be. A bot holding an
 * angle has `hasDestination === false` and is playing correctly by standing still, so
 * counting its stillness as "stuck" would make the metric fire on good behaviour and force
 * the threshold up until it fired on nothing.
 */
const IMMOBILE_STEP = 0.004;      // m/tick ≈ 0.48 m/s — below any real walk cycle
const CELL = 2;                    // m, coverage grid
/** Mirrors `Bot.OFFGRAPH_DROP`. Deliberately a copy: the harness must keep asking the same
 *  question even if the recovery's own tolerance is retuned. */
const OFFGRAPH_DROP_M = 1.5;

/**
 * Run one match and measure it. Returns per-bot navigation rows plus, for Bomb, the
 * objective ledger `BombRules` produced.
 *
 * @param {object} opts
 * @param {string} opts.mapId
 * @param {'tdm'|'bomb'} opts.mode
 * @param {number} opts.seed
 * @param {number} opts.maxTicks
 */
async function runMatch({ mapId, mode, seed, maxTicks }) {
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter(), mapId });

  // A high kill limit for TDM: the point of a TDM run here is a LONG navigation sample, and
  // a round that ends on the kill limit at t=40 s measures nothing about a four-minute match.
  game.startMatch({ mode, botCount: BOTS, difficulty: DIFFICULTY, seed, killLimit: 500 });
  game.match.phase = 'live';
  game.match.countdown = 0;

  const bomb = game.match.bombRules ?? null;
  // The headless Game still owns a Player. Disconnect it from Bomb so every plant, defuse
  // and elimination in the record belongs to an autonomous bot and nothing else.
  if (bomb) bomb.noteDisconnect(game.player);

  const bounds = game.world.bounds;
  const rows = new Map();
  for (const bot of game.bots.bots) {
    rows.set(bot.id, {
      id: bot.id, team: bot.team, distance: 0, aliveTicks: 0, oobTicks: 0,
      cells: new Set(), maxStep: 0, maxStepY: 0, teleports: 0, immobileRun: 0, worstImmobileRun: 0,
      deadMoveTicks: 0, deadShots: 0, offGraphRun: 0, worstOffGraphRun: 0,
    });
  }

  const previous = new Map();
  let liveRespawns = 0;
  const stopSpawnWatch = game.bus.on('spawn', () => { if (bomb?.liveRound) liveRespawns++; });
  const stopShotWatch = game.bus.on('shot', (p) => {
    // §8: a bot eliminated in a live Bomb round is out of the round. It must not shoot.
    const row = p?.shooter ? rows.get(p.shooter.id) : null;
    if (row && bomb?.liveRound && p.shooter.alive === false) row.deadShots++;
  });

  let ticks = 0;
  let priorRoundKey = null;
  while (ticks < maxTicks) {
    // A Bomb round boundary legitimately places actors at fixed spawns, so a step measured
    // across one is not a teleport. The key is sampled on BOTH sides of the step: sampling
    // only before it lets the one step that actually crosses the boundary — the only step
    // that ever contains a placement — through as if it were ordinary movement.
    const keyBefore = bomb ? `${bomb.roundNumber}:${bomb.phase}` : 'tdm';
    game._fixedUpdate(FIXED_DT);
    ticks++;
    const keyAfter = bomb ? `${bomb.roundNumber}:${bomb.phase}` : 'tdm';

    const sameSegment = keyBefore === priorRoundKey && keyAfter === keyBefore;
    priorRoundKey = keyAfter;

    for (const bot of game.bots.bots) {
      const row = rows.get(bot.id);
      const p = bot.position;
      if (!bot.alive) {
        // A dead actor must be inert. Measured rather than assumed: `Bot.fixedUpdate`
        // returns early when `alive` is false today, and this is what notices if it stops.
        const last = previous.get(bot.id);
        if (last && last.dead && Math.hypot(p.x - last.x, p.z - last.z) > 1e-6) row.deadMoveTicks++;
        previous.set(bot.id, { x: p.x, y: p.y, z: p.z, dead: true });
        row.immobileRun = 0;
        continue;
      }
      row.aliveTicks++;
      if (p.x < bounds.min.x || p.x > bounds.max.x || p.z < bounds.min.z || p.z > bounds.max.z
        || p.y < bounds.min.y || p.y > bounds.max.y) row.oobTicks++;
      row.cells.add(`${Math.round(p.x / CELL)},${Math.round(p.z / CELL)}`);

      const last = previous.get(bot.id);
      if (last && !last.dead && sameSegment) {
        const step = Math.hypot(p.x - last.x, p.z - last.z);
        // Vertical is measured SEPARATELY and asserted, not folded into a horizontal
        // hypotenuse and not ignored. Folding it in would be worse than useless — a
        // relocation straight down scores zero on a horizontal metric, which is exactly
        // how `Bot._recoverOffGraph` dropped bots 4–8 m through solid roofs while this
        // harness printed "0 steps over 0.75 m" beside "recoveries 1". See MAX_STEP_Y.
        const stepY = Math.abs(p.y - last.y);
        // Negated `<=` rather than `>`, so a NaN counts as a discontinuity instead of
        // passing. This is not hypothetical: the first cut of this metric read `last.y`
        // from a sample that only carried x and z, every comparison was NaN, and the
        // harness reported "0 m vertical" and PASS against the very relocation it was
        // written to catch. A measurement that cannot be wrong out loud is not one.
        if (!(step <= MAX_STEP_XZ) || !(stepY <= MAX_STEP_Y)) row.teleports++;
        else {
          row.distance += step;
          if (step > row.maxStep) row.maxStep = step;
          if (stepY > row.maxStepY) row.maxStepY = stepY;
        }
        if (bot.hasDestination && step < IMMOBILE_STEP) {
          row.immobileRun++;
          if (row.immobileRun > row.worstImmobileRun) row.worstImmobileRun = row.immobileRun;
        } else row.immobileRun = 0;
      }

      // Standing off the nav graph — see `Bot._recoverOffGraph`. This is measured as a
      // DURATION rather than as a count of recoveries, and the difference matters: the
      // wedge backstop clears `hasDestination` every six seconds, which silently resets the
      // immobile counter above, so a permanently stranded bot can be caught by neither that
      // metric nor a recovery count that stays at zero precisely because recovery is gone.
      // How long a bot stands somewhere the graph does not describe survives both.
      const node = game.nav?.ready ? game.nav.nodeAt(p.x, p.y, p.z) : -1;
      if (node >= 0 && p.y - game.nav.floorY[node] > OFFGRAPH_DROP_M) {
        row.offGraphRun++;
        if (row.offGraphRun > row.worstOffGraphRun) row.worstOffGraphRun = row.offGraphRun;
      } else row.offGraphRun = 0;
      previous.set(bot.id, { x: p.x, y: p.y, z: p.z, dead: false });
    }

    if (bomb?.series) break;
    if (!bomb && game.match.phase !== 'live') break;
  }

  stopSpawnWatch();
  stopShotWatch();

  const objective = bomb
    ? {
      finished: bomb.series !== null,
      phase: bomb.phase,
      rounds: bomb.rounds.map((r) => ({ ...r })),
      plants: bomb.events.filter((e) => e.kind === 'plantComplete').map((e) => ({ ...e })),
      defuses: bomb.events.filter((e) => e.kind === 'defuseComplete').map((e) => ({ ...e })),
      drops: bomb.events.filter((e) => e.kind === 'bombDropped').length,
      pickups: bomb.events.filter((e) => e.kind === 'bombPickedUp' && e.reason === 'pickup').length,
      liveRespawns,
    }
    : { scores: [...game.match.scores] };

  const digestGaps = new Set();
  const result = {
    mapId, mode, seed, ticks,
    seconds: ticks * FIXED_DT,
    rows: [...rows.values()],
    offGraph: game.bots.offGraphLog.map((r) => ({ ...r })),
    botIds: new Set(game.bots.bots.map((b) => b.id)),
    objective,
    digest: matchDigest(game, bomb, digestGaps),
    digestGaps: [...digestGaps],
  };
  game.dispose();
  return result;
}

/**
 * The round-record fields the digest fingerprints, in order.
 *
 * `winnerTeam`, NOT `winner`: `BombRules._endRound` writes `winnerTeam`, and the digest
 * asked for `winner` — a key no Bomb round record has ever had — so every round in every
 * digest this harness has produced contributed the literal string "undefined". The
 * component was not weak, it asserted nothing. `planted` and `site` were absent entirely,
 * which is how a series that planted at A and one that planted at B could digest alike.
 */
// 2.0.0 symmetric demolition (bomb-rules §13.7): `attackingTeam` no longer exists on the
// round record — `plantedByTeam` replaces it as the "who was converting" fact, and the
// digestField guard below is exactly what catches this rename happening again.
const ROUND_DIGEST_FIELDS = ['round', 'winnerTeam', 'reason', 'plantedByTeam', 'planted', 'site'];

/**
 * One digest field of one record — or a loud marker, recorded in `gaps`, if the record has
 * no such key. `record[key] ?? ''` would be the natural-looking thing to write here and is
 * the whole reason the bug survived: it turns "this field was renamed out from under me"
 * into a value that fingerprints perfectly consistently across every run.
 */
function digestField(record, key, gaps) {
  if (!Object.hasOwn(record, key)) { gaps.add(key); return `<no-${key}>`; }
  const v = record[key];
  return v === null ? 'null' : String(v);
}

/**
 * A one-line fingerprint of everything the simulation decided.
 *
 * Positions alone are a weak digest: two runs can converge on the same resting places after
 * different fights. Scores, round records and objective events are folded in so a divergence
 * anywhere in the mode logic shows up, not only one that moves someone.
 *
 * @param {Set<string>} gaps  receives the name of any digested field the record lacked
 */
function matchDigest(game, bomb, gaps) {
  const parts = [];
  for (const bot of game.bots.bots) {
    parts.push(`${bot.id}:${bot.team}:${bot.alive ? 1 : 0}:${bot.position.x.toFixed(4)},`
      + `${bot.position.y.toFixed(4)},${bot.position.z.toFixed(4)}:${bot.health.toFixed(2)}`);
  }
  parts.push(`scores=${game.match.scores.join('-')}`);
  if (bomb) {
    for (const r of bomb.rounds) {
      parts.push(`r${ROUND_DIGEST_FIELDS.map((k) => digestField(r, k, gaps)).join(':')}`);
    }
    for (const e of bomb.events) parts.push(`e${e.tick}:${e.kind}:${e.entityId ?? ''}:${e.site ?? ''}`);
  }
  return parts.join('|');
}

const perMinute = (value, ticks) => (ticks === 0 ? 0 : value / ((ticks * FIXED_DT) / 60));
const fixed = (n, d = 1) => Number(n.toFixed(d));

// ────────────────────────────────────────────────────── navigation thresholds
//
// Every number here is the observed worst case across the calibration sweep, cut back to a
// round figure with headroom, and every one has been shown to FAIL: see the degrade log in
// this harness's report to the lane. A threshold that has never been seen red is decoration.

/** m per alive-minute, per bot. Calibration min across 11 seeds x 2 maps: 130.4 (before the
 *  off-graph fix) / 155.6 (after). 90 leaves room for a genuinely unlucky spawn camper. */
const MIN_METRES_PER_ALIVE_MIN = 90;
/** distinct 2 m cells, per bot. Calibration min: 58 (square) / 100 (meridian). */
const MIN_CELLS_PER_BOT = 30;
/** distinct 2 m cells, whole roster. Calibration min: 424 (square) / 633 (meridian). */
const MIN_CELLS_ROSTER = 250;
/** seconds a bot may spend trying to reach a destination without moving. */
const MAX_IMMOBILE_SECONDS = 12;
/**
 * Seconds a bot may stand on geometry the nav bake does not describe.
 *
 * NOT a count of `Bot._recoverOffGraph` relocations: a recovery count is zero both when
 * nothing goes wrong and when the recovery itself has been deleted, so it cannot fail in the
 * direction that matters. Measured over the calibration sweep, the recovery brings a stranded
 * bot back within its own six-second wedge cycle; without it, the same bots stood off-graph
 * for the remaining 68 s of a 100 s match. 12 s separates those two worlds with room to spare.
 */
const MAX_OFFGRAPH_SECONDS = 12;

/**
 * How far an actor may move in ONE 1/120 s tick, laterally and vertically.
 *
 * Both numbers are what the movement code can physically produce, not round figures:
 *
 *   lateral  — sprint tops out well under 90 m/s; 0.75 m/tick is the long-standing budget
 *              and the one `bombbottest` also promises inside a live round.
 *   vertical — `world.move` can shift a bot's feet in one tick by a step-up or ground-snap
 *              (`MAX_STEP_HEIGHT` / `GROUND_SNAP`, 0.55 m, taken instantly) plus a fall at
 *              terminal velocity (`TERMINAL_FALL` = -60 m/s → 0.50 m/tick); a jump adds
 *              7.6 m/s → 0.063 m. 1.05 m is that ceiling, so the bound is the physics
 *              rather than an observation of it — the worst this suite actually measures is
 *              0.67 m, printed beside the budget on every run so drift is visible.
 *
 * So a bot falling off a ledge, jumping a rail or mantling a crate passes, and the 4.0–8.0 m
 * relocations `_recoverOffGraph` used to perform — 4 to 16 times a tick of terminal velocity
 * — cannot. Proven red, not assumed: against the previous `_recoverOffGraph` this check
 * fails on meridian/tdm and on both MERIDIAN Bomb series that recover a bot.
 */
const MAX_STEP_XZ = 0.75;
const MAX_STEP_Y = 1.05;

/**
 * Assert the navigation contract over one measured match.
 *
 * @param {object} run  a `runMatch` result
 * @param {string} label
 */
function assertNavigation(run, label) {
  const rows = run.rows;
  if (!check(rows.length === BOTS, `${label}: the full roster of ${BOTS} bots was measured`, `${rows.length}`)) return;

  const mpm = rows.map((r) => perMinute(r.distance, r.aliveTicks));
  const worstMpm = Math.min(...mpm);
  const worstCells = Math.min(...rows.map((r) => r.cells.size));
  const roster = new Set(rows.flatMap((r) => [...r.cells]));
  const worstImmobile = Math.max(...rows.map((r) => r.worstImmobileRun)) * FIXED_DT;
  const oob = rows.reduce((a, r) => a + r.oobTicks, 0);
  const teleports = rows.reduce((a, r) => a + r.teleports, 0);
  const maxStep = Math.max(...rows.map((r) => r.maxStep));
  const maxStepY = Math.max(...rows.map((r) => r.maxStepY));
  const aliveTicks = rows.reduce((a, r) => a + r.aliveTicks, 0);
  const worstOffGraph = Math.max(...rows.map((r) => r.worstOffGraphRun)) * FIXED_DT;
  const deadMove = rows.reduce((a, r) => a + r.deadMoveTicks, 0);

  note(`${label}: ${fixed(run.seconds)} s | per-bot m/alive-min min ${fixed(worstMpm)} `
    + `med ${fixed(mpm.slice().sort((a, b) => a - b)[Math.floor(BOTS / 2)])} max ${fixed(Math.max(...mpm))}`);
  note(`${label}: cells/bot min ${worstCells}, roster ${roster.size} | worst immobile-while-seeking `
    + `${fixed(worstImmobile, 2)} s | worst off-graph ${fixed(worstOffGraph, 2)} s `
    + `| recoveries ${run.offGraph.length}`);
  note(`${label}: largest single-tick step ${fixed(maxStep, 3)} m lateral / ${fixed(maxStepY, 3)} m vertical `
    + `(budgets ${MAX_STEP_XZ} / ${MAX_STEP_Y})`);
  if (run.offGraph.length > 0) {
    note(`${label}: stranded at ${run.offGraph.map((r) => `bot${r.botId}@${fixed(r.x)},${fixed(r.y)},${fixed(r.z)}`).join('  ')}`);
  }

  check(allOf(rows, (r) => perMinute(r.distance, r.aliveTicks) >= MIN_METRES_PER_ALIVE_MIN),
    `${label}: every bot covers at least ${MIN_METRES_PER_ALIVE_MIN} m per alive-minute`,
    `worst ${fixed(worstMpm)} (bot ${rows[mpm.indexOf(worstMpm)].id})`);
  check(allOf(rows, (r) => r.cells.size >= MIN_CELLS_PER_BOT),
    `${label}: every bot reaches at least ${MIN_CELLS_PER_BOT} distinct ${CELL} m cells`, `worst ${worstCells}`);
  check(roster.size >= MIN_CELLS_ROSTER,
    `${label}: the roster between them cover at least ${MIN_CELLS_ROSTER} cells of the district`, `${roster.size}`);
  check(allOf(rows, (r) => r.worstImmobileRun * FIXED_DT <= MAX_IMMOBILE_SECONDS),
    `${label}: no bot spends more than ${MAX_IMMOBILE_SECONDS} s trying to reach somewhere without moving`,
    `worst ${fixed(worstImmobile, 2)} s`);
  check(oob === 0, `${label}: no bot leaves the world bounds`, `${oob} out-of-bounds ticks`);
  check(teleports === 0 && maxStep < MAX_STEP_XZ && maxStepY < MAX_STEP_Y,
    `${label}: no bot moves discontinuously inside a round segment, in any direction`,
    `${teleports} steps over ${MAX_STEP_XZ} m lateral / ${MAX_STEP_Y} m vertical, `
    + `largest legal step ${fixed(maxStep, 3)} m lateral, ${fixed(maxStepY, 3)} m vertical`);
  // Horizontal only, on purpose: `Bot.fixedUpdate` deliberately keeps integrating a dead
  // actor so the body falls to the floor, and that is presentation, not play. What must stop
  // is locomotion — a bot eliminated in a Bomb round with no respawns is out of the round.
  check(deadMove === 0, `${label}: a dead bot never walks again`, `${deadMove} ticks of posthumous locomotion`);
  check(allOf(rows, (r) => r.worstOffGraphRun * FIXED_DT <= MAX_OFFGRAPH_SECONDS),
    `${label}: no bot stands off the nav graph for more than ${MAX_OFFGRAPH_SECONDS} s`,
    `worst ${fixed(worstOffGraph, 2)} s`);
}

// ─────────────────────────────────────────────────────────── the runs themselves

console.log('\nP3 exit 3 — bot navigation and mode play');

// ── 1. The Square, Team Deathmatch ────────────────────────────────────────────────────
heading('1. The Square — Team Deathmatch, 100 s of eleven-bot navigation');
const squareTdm = await runMatch({ mapId: 'the-square', mode: 'tdm', seed: 20260820, maxTicks: 12000 });
check(squareTdm.ticks === 12000, 'the TDM navigation sample ran its full length', `${squareTdm.ticks} ticks`);
assertNavigation(squareTdm, 'square/tdm');

// A control for the whole navigation section: if bots did not move at all, or moved without
// going anywhere, the metrics above would still be computable. This is the case that fails if
// pathing were deleted — bots would still separate, strafe and drift a few metres.
check(anyOf(squareTdm.rows, (r) => r.cells.size >= 60),
  'at least one bot toured a substantial part of The Square rather than milling near spawn',
  `best ${Math.max(...squareTdm.rows.map((r) => r.cells.size))} cells`);

// ── 2. MERIDIAN, Team Deathmatch — the retained fixture (map-data.md §9) ───────────────
heading('2. MERIDIAN fixture — Team Deathmatch, same measurements');
const meridianTdm = await runMatch({ mapId: 'meridian', mode: 'tdm', seed: 20260820, maxTicks: 12000 });
check(meridianTdm.ticks === 12000, 'the MERIDIAN TDM sample ran its full length', `${meridianTdm.ticks} ticks`);
assertNavigation(meridianTdm, 'meridian/tdm');
check(squareTdm.digest !== meridianTdm.digest,
  'the two maps produce different matches, so the fixture is genuinely a second target');

// ── 3. The Square, Bomb — plants and defuses across many rounds ───────────────────────
//
// The failure this section exists to catch is the quiet one: a Bomb match in which nobody
// ever plants still ends every round on the timer, still reaches matchEnd, and still looks
// healthy from the outside. Rates per ROUND, not totals, so a longer series cannot pass a
// weaker bot layer.
heading('3. The Square — Bomb, four autonomous series');
const SQUARE_BOMB_SEEDS = [20260101, 20260202, 20260303, 20260404];
const BOMB_MAX_TICKS = 120 * 60 * 35;
/** plants per round. Calibration min over six seeds: 0.50 (5 plants / 9 rounds …). */
const MIN_PLANTS_PER_ROUND = 0.35;
/** defuses per round. Calibration min over six seeds: 0.17 (2 / 12). */
const MIN_DEFUSES_PER_ROUND = 0.10;

const squareBomb = [];
for (const seed of SQUARE_BOMB_SEEDS) {
  squareBomb.push(await runMatch({ mapId: 'the-square', mode: 'bomb', seed, maxTicks: BOMB_MAX_TICKS }));
}

{
  const objs = squareBomb.map((r) => r.objective);
  const rounds = objs.reduce((a, o) => a + o.rounds.length, 0);
  const plants = objs.reduce((a, o) => a + o.plants.length, 0);
  const defuses = objs.reduce((a, o) => a + o.defuses.length, 0);
  const sites = new Set(objs.flatMap((o) => o.plants.map((p) => p.site)));
  const allPlants = objs.flatMap((o) => o.plants);
  const allDefuses = objs.flatMap((o) => o.defuses);
  const ids = new Set(squareBomb.flatMap((r) => [...r.botIds]));

  note(`square/bomb: ${SQUARE_BOMB_SEEDS.length} series, ${rounds} rounds, ${plants} plants `
    + `(${fixed(plants / rounds, 2)}/round), ${defuses} defuses (${fixed(defuses / rounds, 2)}/round), `
    + `sites ${[...sites].sort().join('+')}`);
  note(`square/bomb: per series plants ${objs.map((o) => o.plants.length).join(',')} | `
    + `defuses ${objs.map((o) => o.defuses.length).join(',')} | rounds ${objs.map((o) => o.rounds.length).join(',')}`);

  check(allOf(objs, (o) => o.finished && o.phase === 'matchEnd'),
    'every autonomous Bomb series on The Square reaches matchEnd',
    objs.map((o) => o.phase).join(','));
  check(rounds > 0 && plants / rounds >= MIN_PLANTS_PER_ROUND,
    `attacking bots complete at least ${MIN_PLANTS_PER_ROUND} plants per round on The Square`,
    `${plants}/${rounds} = ${fixed(plants / Math.max(rounds, 1), 3)}`);
  check(rounds > 0 && defuses / rounds >= MIN_DEFUSES_PER_ROUND,
    `defending bots complete at least ${MIN_DEFUSES_PER_ROUND} defuses per round on The Square`,
    `${defuses}/${rounds} = ${fixed(defuses / Math.max(rounds, 1), 3)}`);
  // Not "some series planted" — EVERY series must, or one lucky seed carries the criterion.
  check(allOf(objs, (o) => o.plants.length > 0), 'no Bomb series passes without a single plant',
    objs.map((o) => o.plants.length).join(','));
  // Plants are required of EVERY series above; defuses are required of most of them. The
  // difference is real and not a softened threshold: a defuse needs the defenders to lose
  // the site, retake it, and hold seven uninterrupted seconds, so a series can legitimately
  // contain none. Three in four still fails outright if defusing stopped working, which is
  // the regression this is here for, and it fails on two independent bad seeds as well.
  const seriesWithDefuse = objs.filter((o) => o.defuses.length > 0).length;
  check(seriesWithDefuse >= objs.length - 1,
    `at least ${SQUARE_BOMB_SEEDS.length - 1} of ${SQUARE_BOMB_SEEDS.length} Bomb series contain a defuse`,
    objs.map((o) => o.defuses.length).join(','));
  check(sites.size === 2, 'bots plant at both authored sites, not just the nearer one', [...sites].join(','));
  // The digest is only a regression net if it reads fields that exist. It read `r.winner`
  // for months; Bomb round records carry `winnerTeam`, so the round component of every
  // digest was the constant string "undefined".
  const gaps = new Set(squareBomb.flatMap((r) => r.digestGaps));
  check(gaps.size === 0,
    'every round field the determinism digest fingerprints exists on the record it reads',
    `missing: ${[...gaps].join(',')}`);
  check(allOf(allPlants, (p) => ids.has(p.entityId)), 'every planter is an autonomous bot');
  check(allOf(allDefuses, (d) => ids.has(d.entityId)), 'every defuser is an autonomous bot');
  check(allOf(objs, (o) => o.liveRespawns === 0),
    'no bot respawns inside a live Bomb round — elimination is final',
    objs.map((o) => o.liveRespawns).join(','));
  check(squareBomb.reduce((a, r) => a + r.rows.reduce((b, x) => b + x.deadShots, 0), 0) === 0,
    'an eliminated bot never fires again inside its round');
  // Carrier death and recovery are behaviours TDM has no equivalent of at all.
  //
  // This is a LIVENESS check and is labelled as one, because the stronger claim it would be
  // natural to make here cannot be made honestly. A recovery-rate threshold was written,
  // calibrated (70–90% of drops are recovered) and then deliberately broken twice — first by
  // stripping the recover role's destination, then by deleting the whole dropped-bomb branch
  // from the objective planner — and the rate did not move either time. Attackers path to the
  // site the carrier died approaching, so they walk over the bomb whether or not anything
  // told them to. A rate threshold there would pass for a reason unrelated to what it claims
  // to measure, which is worse than not asserting it, so the rate is reported and not asserted.
  const drops = objs.reduce((a, o) => a + o.drops, 0);
  const pickups = objs.reduce((a, o) => a + o.pickups, 0);
  note(`square/bomb: ${drops} carrier deaths dropped the bomb, ${pickups} recovered `
    + `(${fixed(pickups / Math.max(drops, 1), 2)} — reported, not asserted; see comment)`);
  check(drops > 0 && pickups > 0,
    'carriers die, the bomb drops, and it is picked up again rather than lying there all round',
    `${pickups} pickups from ${drops} drops`);
}

// Bomb is also a navigation test, and a harsher one: no respawns means a bot that strands
// itself is gone for the round, and the fixed spawns start it somewhere TDM never does.
for (const run of squareBomb.slice(0, 2)) assertNavigation(run, `square/bomb#${run.seed}`);

// ── 4. MERIDIAN and Bomb ───────────────────────────────────────────────────────────────
//
// Until the map-data.md §9 (1.4.0) un-retirement, this section asserted the OPPOSITE: the
// fixture published no objective volumes, `bombAvailable` said so, and starting Bomb on it
// failed loudly by name. The owner's decision to offer MERIDIAN in lobby rooms moved the
// two proven site boxes into `MERIDIAN_FIXTURE.MAP_MANIFEST.objectives`, so the map now
// hosts Bomb on its own declared data — and this section asserts that, plus the shape of
// the declaration the room/allocation chain depends on.
heading('4. MERIDIAN — Bomb');
{
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter(), mapId: 'meridian' });
  check(game.world.manifest?.provenance?.objectives === 'declared',
    'MERIDIAN declares its objective volumes (map-data.md §9 un-retirement)',
    String(game.world.manifest?.provenance?.objectives));
  check(game.world.manifest?.objectives?.length === 2
    && new Set(game.world.manifest.objectives.map((o) => o.site)).size === 2,
    'two plant sites, A and B',
    JSON.stringify(game.world.manifest?.objectives?.map((o) => `${o.id}:${o.site}`)));
  // Spawns stay DERIVED on purpose: derived spawns are stamped `modes: ['tdm']` as a
  // default, and the spawner only honours the mode filter on a DECLARED spawn set — a
  // partial manifest that declared spawns without authoring bomb-mode tags would leave
  // Bomb with zero candidates. This assertion is what notices that trap being stepped on.
  check(game.world.manifest?.provenance?.spawns === 'derived',
    'spawns remain derived, so the mode filter fallback keeps Bomb spawnable',
    String(game.world.manifest?.provenance?.spawns));
  check(bombAvailable(game) === true, 'Bomb reports available on it');
  game.dispose();
}

/**
 * Six seeds, not two — and the reason is a hole in this harness, not a convenience.
 *
 * The defuse-rate assertion below aggregates over these series, so the sample size IS the
 * threshold's calibration. `MIN_DEFUSES_PER_ROUND` is 0.10, calibrated on a SIX-seed sweep
 * (0.17), but was being applied to a two-seed sample whose spread is far wider: measured on
 * the unmodified simulation, the six seeds give 4, 0, 2, 2, 2 and 3 defuses, so the pair
 * (20260202, 20260303) scores 0.087 and (20260202, 20260404) 0.083 — both RED. The check
 * was passing on the pair it happened to be given, which is luck rather than evidence.
 *
 * A MERIDIAN Bomb series costs ~2.3 s, so the honest sample is nearly free. Aggregated the
 * six seeds give 0.206 on the unmodified simulation and 0.156 with today's off-graph
 * recovery change — the same behaviour, sampled widely enough to say so.
 */
const MERIDIAN_BOMB_SEEDS = [20260101, 20260202, 20260303, 20260404, 20260505, 20260606];
const meridianBomb = [];
for (const seed of MERIDIAN_BOMB_SEEDS) {
  meridianBomb.push(await runMatch({
    mapId: 'meridian', mode: 'bomb', seed, maxTicks: BOMB_MAX_TICKS,
  }));
}
{
  const objs = meridianBomb.map((r) => r.objective);
  const rounds = objs.reduce((a, o) => a + o.rounds.length, 0);
  const plants = objs.reduce((a, o) => a + o.plants.length, 0);
  const defuses = objs.reduce((a, o) => a + o.defuses.length, 0);
  const sites = new Set(objs.flatMap((o) => o.plants.map((p) => p.site)));
  note(`meridian/bomb (declared sites): ${rounds} rounds, ${plants} plants (${fixed(plants / rounds, 2)}/round), `
    + `${defuses} defuses (${fixed(defuses / rounds, 2)}/round), sites ${[...sites].sort().join('+')}`);

  check(allOf(objs, (o) => o.finished && o.phase === 'matchEnd'),
    'a Bomb series on the fixture reaches matchEnd', objs.map((o) => o.phase).join(','));
  check(rounds > 0 && plants / rounds >= MIN_PLANTS_PER_ROUND,
    'the bot objective layer plants at fixture site coordinates it has never seen',
    `${plants}/${rounds}`);
  // Aggregated over the fixture's series rather than required of each, unlike The Square:
  // a single series can legitimately contain no defuse at all, and demanding one from each
  // would fail on behaviour that is correct. See MERIDIAN_BOMB_SEEDS for why aggregating
  // over two of them was not a sample at all.
  check(rounds > 0 && defuses / rounds >= MIN_DEFUSES_PER_ROUND,
    'and defuses there too, so neither behaviour is fitted to The Square',
    `${defuses}/${rounds} = ${fixed(defuses / Math.max(rounds, 1), 3)}`);
  check(sites.size === 2, 'both declared sites are used', [...sites].join(','));
  const gaps = new Set(meridianBomb.flatMap((r) => r.digestGaps));
  check(gaps.size === 0,
    'every round field the digest fingerprints exists on the fixture\'s records too',
    `missing: ${[...gaps].join(',')}`);
  for (const run of meridianBomb) assertNavigation(run, `meridian/bomb#${run.seed}`);
}

// ── 5. Determinism ─────────────────────────────────────────────────────────────────────
//
// The whole point of the fixed 1/120 s step. Asserted in both directions: identical seeds
// must agree, and a different seed must disagree — without the second half, a digest that
// had quietly collapsed to a constant would satisfy the first.
heading('5. Determinism of an autonomous match');
{
  const a = await runMatch({ mapId: 'the-square', mode: 'bomb', seed: 20260707, maxTicks: BOMB_MAX_TICKS });
  const b = await runMatch({ mapId: 'the-square', mode: 'bomb', seed: 20260707, maxTicks: BOMB_MAX_TICKS });
  const c = await runMatch({ mapId: 'the-square', mode: 'bomb', seed: 20260708, maxTicks: BOMB_MAX_TICKS });

  note(`determinism: digest length ${a.digest.length}, ${a.objective.rounds.length} rounds, `
    + `${a.objective.plants.length} plants; different seed gave ${c.objective.rounds.length} rounds, `
    + `${c.objective.plants.length} plants`);

  check(a.digest.length > 400, 'the digest describes a whole match rather than a stub', `${a.digest.length} chars`);
  check(a.digest === b.digest, 'the same seed replays a bit-identical Bomb match', firstDifference(a.digest, b.digest));
  check(a.ticks === b.ticks, 'and takes exactly as many fixed steps to do it', `${a.ticks} vs ${b.ticks}`);
  check(a.digest !== c.digest, 'a different seed produces a different match, so the comparison is not vacuous');

  const t = await runMatch({ mapId: 'the-square', mode: 'tdm', seed: 20260707, maxTicks: 6000 });
  const u = await runMatch({ mapId: 'the-square', mode: 'tdm', seed: 20260707, maxTicks: 6000 });
  const v = await runMatch({ mapId: 'the-square', mode: 'tdm', seed: 20260709, maxTicks: 6000 });
  check(t.digest === u.digest, 'TDM is deterministic under the same seed', firstDifference(t.digest, u.digest));
  check(t.digest !== v.digest, 'and separates two different seeds');
}

function firstDifference(x, y) {
  if (x === y) return '';
  const a = x.split('|'), b = y.split('|');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `first divergence at field ${i}: "${a[i]}" vs "${b[i]}"`;
  }
  return `lengths ${a.length} vs ${b.length}`;
}

// ─────────────────────────────────────────────────────────────────────────── verdict

if (failures.length) {
  console.error(`\nBot navigation and mode play: FAIL — ${failures.length}/${checks}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`\nBot navigation and mode play: PASS — ${checks} checks across `
  + '4 map/mode pairings, 0 out-of-bounds ticks, 0 posthumous actions');
process.exit(0);
