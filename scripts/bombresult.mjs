/**
 * Bomb MATCH-RESULT verification — `docs/contracts/match-result.md` §4.0/§4.2/§6.1 and
 * `docs/contracts/bomb-rules.md` §9/§10.
 *
 * `bombtest.mjs` proves the RULESET: what `bomb.series` records. This file proves the
 * RESULT: the `(status/terminationReason, outcomeReason, winnerTeam)` tuple the referee
 * publishes, and whether the career was moved.
 *
 * The distinction is the whole point of this file. `bombtest.mjs:870` asserts
 * `bomb.series.aggregate === false` — a field no consumer read, so the assertion passed
 * while `Match._end()` paid 250 XP and banked a DRAW for a no-contest. Every case here
 * therefore asserts OBSERVABLE behaviour: the exact tuple on `match.result`, and the
 * lifetime profile counters before and after. Nothing here asserts an internal flag.
 *
 * The same gap, one level further out, is why the last section decodes the WIRE. Everything
 * above reads `match.result`, an in-process object — so a match could publish a perfect §4.0
 * tuple while the bytes a client actually received said the match had reverted to warmup,
 * and every assertion here still passed. It did: `MSG_MATCHSTATE` never carried phase
 * `5 = matchEnd` once in a whole series. That case drives a real `GameServer` over a real
 * loopback and asserts on the frames a real client received, in order.
 */
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';
import { BOMB_TICKS as T } from '../src/game/bomb.js';
import { progression } from '../src/game/progression.js';
import { FIXED_DT } from '../src/core/mathUtils.js';
// Read-only use of the netcode lane: this file drives it and decodes it, never edits it.
import { GameServer } from '../src/net/server.js';
import { createLoopbackPair } from '../src/net/transport.js';
import {
  PROTOCOL_VERSION, MSG_MATCHSTATE, MSG_OUTCOME, encodeHello, decodeMatchState, decodeOutcome,
} from '../src/net/protocol.js';

let failures = 0;
let checks = 0;
let section = '';
const ok = (name) => { checks++; console.log(`  ok   ${name}`); };
const bad = (name, detail) => {
  failures++; checks++;
  console.log(`  FAIL ${name}\n       ${detail}`);
};
const expect = (cond, name, detail = '') => (cond ? ok(name) : bad(name, `[${section}] ${detail}`));
/** Value equality against a SPECIFIC expected value — never truthiness, never a length. */
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
  game.match.phase = 'live';
  game.match.countdown = 0;
  return game;
}
const step = (game, n = 1) => { for (let i = 0; i < n; i++) game.match.fixedUpdate(FIXED_DT); };
function toLive(game) {
  const bomb = game.match.bombRules;
  let n = 0;
  while (bomb.phase !== 'live' && n < T.freeze * 4) { step(game); n++; }
  return bomb;
}
const roster = (game) => game.entities.filter((e) => e.team === 0 || e.team === 1);
const teamOf = (game, team) => roster(game).filter((e) => e.team === team).sort((a, b) => a.id - b.id);
const kill = (game, victim, attacker = null) =>
  game.bus.emit('kill', { victim, attacker, weaponId: 'ar_vector', headshot: false, distance: 12 });
function wipe(game, team) {
  for (const e of teamOf(game, team)) if (game.match.bombRules.isAlive(e)) kill(game, e, null);
}

/**
 * The career, as anything outside the profile can see it. A no-contest must move NONE of
 * these — §6.1's row says counters are not applied, `matches` is +0 and there is no W/L/D.
 */
function career() {
  const s = progression.getStats();
  return { matches: s.matches, wins: s.wins, losses: s.losses, draws: s.draws, xp: s.xp, kills: s.kills };
}
const delta = (before, after) => Object.fromEntries(
  Object.keys(before).map((k) => [k, after[k] - before[k]]),
);

// ───────────────────────────────────────────────────────────────────── the wire fixture
//
// The same match, with a real `GameServer` in front of it and a real client on the other end
// of a real loopback, so the last case can assert on the BYTES a client received instead of
// on the referee's own objects. `src/net/**` is imported and driven here; nothing writes to
// it.

async function newWiredGame({ seed = 778, botCount = 7 } = {}) {
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter() });
  game.startMatch({ mode: 'bomb', botCount, seed });
  game.match.phase = 'live';
  game.match.countdown = 0;
  const server = new GameServer(game);
  const [clientT, serverT] = createLoopbackPair({});
  const session = server.addClient(serverT, game.entities.find((e) => e.team === 0) ?? null);
  server._onMessage(session, encodeHello(PROTOCOL_VERSION, 'st_bombresult'));
  const frames = [];
  clientT.onMessage((d) => frames.push(d.slice(0)));
  // Captured NOW, while the match still owns it. This object is the independent oracle the
  // wire is compared against at the end, and holding a direct reference means the comparison
  // still works — and still fails loudly — if a regression detaches it from the Match.
  const rules = game.match.bombRules;
  let nowMs = 0;
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      server.tick();
      // The loopback queues and delivers on `pump`; a socket delivers itself.
      nowMs += FIXED_DT * 1000;
      clientT.pump(nowMs);
    }
  };
  let guard = 0;
  while (rules.phase !== 'live' && guard++ < T.freeze * 4) tick();
  return { game, server, rules, frames, tick };
}

/** Every frame the client received, decoded in order. Not a sample — all of them. */
function decodeWire(frames) {
  const out = [];
  for (const f of frames) {
    const type = new Uint8Array(f)[0];
    if (type === MSG_MATCHSTATE) {
      const s = decodeMatchState(f);
      out.push({
        kind: 'STATE',
        phase: s.phase,
        roundIndex: s.roundIndex,
        scoreAlpha: s.scoreAlpha,
        scoreBravo: s.scoreBravo,
        aliveAlpha: s.aliveAlpha,
        aliveBravo: s.aliveBravo,
      });
    } else if (type === MSG_OUTCOME) {
      const o = decodeOutcome(f);
      out.push({ kind: 'OUTCOME', scope: o.scope, winner: o.winner, reason: o.reason });
    }
  }
  return out;
}

/** Every tuple this run actually published, replayed against §4.0 at the end. */
const OBSERVED = [];

/** The tuple §4.0 governs, and nothing else, so a diff reads as a matrix row. */
const tuple = (r) => record({
  terminationReason: r.terminationReason,
  outcomeReason: r.outcomeReason,
  winnerTeam: r.winnerLabel,
  aggregate: r.aggregate,
});
const record = (t) => { OBSERVED.push(t); return t; };

// ═══════════════════════════════════════════ F3 — the no-contest pays nothing and is not a draw

head('§9 both teams gone: aborted / no-contest / null — recorded, NOT aggregated');
{
  const game = await newGame();
  const bomb = toLive(game);
  const before = career();
  for (const e of roster(game)) bomb.noteDisconnect(e);
  eq(bomb.phase, 'matchEnd', 'both teams dropping to zero ends the match');
  step(game, 1);
  const r = game.match.result;
  eq(game.match.phase, 'ended', 'the referee ends the match');
  eqJson(tuple(r), {
    terminationReason: 'aborted', outcomeReason: 'no-contest', winnerTeam: null, aggregate: false,
  }, '§4.0 row 5: the exact aborted/no-contest/null tuple reaches the result record');
  eq(r.outcome, null, '§4.3 `result` is null when winnerTeam is null — a no-contest is NOT a draw');
  eq(r.winnerTeam, -1, 'the in-engine team id stays -1 (no team won); the contract value is winnerLabel');
  eq(r.progression, null, '§6.1 no career application ran at all');
  eqJson(delta(before, career()), {
    matches: 0, wins: 0, losses: 0, draws: 0, xp: 0, kills: 0,
  }, '§6.1 aborted/no-contest: counters not applied, matches +0, no W/L/D, no XP');
  game.dispose();
}

// ═════════════════════════════════════════════ the control: a forfeit IS paid (§9, §6.1 row 2)

head('§9 one team gone: aborted / forfeit / the team that stayed — recorded AND aggregated');
{
  const game = await newGame();
  const bomb = toLive(game);
  const before = career();
  for (const e of teamOf(game, 1)) bomb.noteDisconnect(e);
  step(game, 1);
  const r = game.match.result;
  eqJson(tuple(r), {
    terminationReason: 'aborted', outcomeReason: 'forfeit', winnerTeam: 'alpha', aggregate: true,
  }, '§4.0 row 3: an aborted match CAN carry a winner');
  eq(r.outcome, 'win', 'the team that stayed won');
  const d = delta(before, career());
  eq(d.matches, 1, '§6.1 forfeit: matches +1');
  eq(d.wins, 1, '§6.1 forfeit: the team that stayed wins');
  expect(d.xp > 0, 'a forfeit pays XP — the no-contest case above is a skip, not a broken payer',
    `xp delta ${d.xp}`);
  game.dispose();
}

// ═══════════════════════════════════════════════════ F4 — outcomeReason stays inside the enum

head('§2.1a 6-6 after 12: completed / timer / draw');
{
  const game = await newGame({ seed: 778 });
  const bomb = toLive(game);
  const before = career();
  for (let round = 1; round <= 12; round++) {
    let guard = 0;
    while (bomb.phase !== 'live' && guard < T.freeze + T.roundEnd + 4) { step(game); guard++; }
    wipe(game, round % 2 === 0 ? 0 : 1);
    step(game, 1 + T.roundEnd);
  }
  eqJson(bomb.roundWins, [6, 6], 'twelve alternating rounds end 6-6');
  step(game, 1);
  const r = game.match.result;
  eqJson(tuple(r), {
    terminationReason: 'completed', outcomeReason: 'timer', winnerTeam: 'draw', aggregate: true,
  }, '§4.2 `winnerTeam: draw` requires `outcomeReason: timer`, and only timer');
  eq(r.reason, 'draw', 'the raw series reason is untouched — the enum mapping is a projection');
  eq(r.outcome, 'draw', 'and the match is a draw for the player');
  eq(delta(before, career()).draws, 1, '§6.1 a completed draw aggregates as a draw');
  game.dispose();
}

head('§2.1a first to 7: completed, and the reason is the DECIDING round’s reason');
{
  const game = await newGame({ seed: 777 });
  const bomb = toLive(game);
  const before = career();
  for (let round = 1; round <= 7; round++) {
    let guard = 0;
    while (bomb.phase !== 'live' && guard < T.freeze + T.roundEnd + 4) { step(game); guard++; }
    wipe(game, 1);
    step(game, 1 + T.roundEnd);
  }
  eqJson(bomb.roundWins, [7, 0], 'team 0 reached 7 round wins');
  step(game, 1);
  const r = game.match.result;
  eq(bomb.rounds[bomb.rounds.length - 1].reason, 'elimination', 'the seventh round was won by elimination');
  eqJson(tuple(r), {
    terminationReason: 'completed', outcomeReason: 'elimination', winnerTeam: 'alpha', aggregate: true,
  }, '§4.0 row 1: `roundsToWin` is not in the enum; the deciding round’s reason is');
  eq(r.reason, 'roundsToWin', 'the raw series reason is still `roundsToWin` for the HUD and the log');
  eq(delta(before, career()).wins, 1, '§6.1 a completed win aggregates as a win');
  game.dispose();
}

head('the control: the same series decided by a round TIMER reports `timer`, not `elimination`');
{
  const game = await newGame({ seed: 777 });
  const bomb = toLive(game);
  // Six eliminations, then the side switch puts team 0 on defence; letting the seventh
  // round's clock run out is a DEFENDER win by `timer` — same series result, other reason.
  for (let round = 1; round <= 6; round++) {
    let guard = 0;
    while (bomb.phase !== 'live' && guard < T.freeze + T.roundEnd + 4) { step(game); guard++; }
    wipe(game, 1);
    step(game, 1 + T.roundEnd);
  }
  let guard = 0;
  while (bomb.phase !== 'live' && guard < T.freeze + T.roundEnd + 4) { step(game); guard++; }
  eq(bomb.defendingTeam, 0, 'after the side switch team 0 defends the seventh round');
  step(game, T.round + 1);
  eqJson(bomb.roundWins, [7, 0], 'the defenders take the seventh round on the clock');
  eq(bomb.rounds[bomb.rounds.length - 1].reason, 'timer', 'and the round record says `timer`');
  step(game, 1 + T.roundEnd);
  step(game, 1);
  const r = game.match.result;
  eqJson(tuple(r), {
    terminationReason: 'completed', outcomeReason: 'timer', winnerTeam: 'alpha', aggregate: true,
  }, '§4.0 row 2: `completed`/`timer` with a real winner — the mapping is not a constant');
  game.dispose();
}

// ═══════════════════════ D2 — what the CLIENT was told the match did (wire-protocol §8.6/§8.9)

head('§8.6 the terminal MSG_MATCHSTATE a real client receives carries phase 5 = matchEnd');
{
  // A full 12-round draw, played through a real server, with every frame the client received
  // kept and decoded. Asserting `match.result` here would prove nothing: the result was
  // already correct while the wire said the match had gone back to warmup.
  const w = await newWiredGame({ seed: 778 });
  const { game, rules, tick } = w;
  const before = career();
  for (let round = 1; round <= 12; round++) {
    let guard = 0;
    while (rules.phase !== 'live' && guard < T.freeze + T.roundEnd + 8) { tick(); guard++; }
    for (const e of teamOf(game, round % 2 === 0 ? 0 : 1)) {
      if (rules.isAlive(e)) kill(game, e, null);
    }
    tick(1 + T.roundEnd);
  }
  // Two more ticks past the whistle: enough for a frame published AFTER the terminal one to
  // show up, which is exactly how the defect presented.
  tick(2);

  eq(rules.phase, 'matchEnd', 'the ruleset reached matchEnd — the oracle for everything below');
  eqJson([rules.roundWins[0], rules.roundWins[1]], [6, 6], 'twelve alternating rounds end 6-6');

  const wire = decodeWire(w.frames);
  const outcomeAt = wire.findIndex((f) => f.kind === 'OUTCOME' && f.scope === 'match');
  expect(outcomeAt >= 0, '§8.9 the client received a match-scope MSG_OUTCOME',
    `no match outcome in ${wire.length} decoded frames`);

  // §8.9: "immediately before the corresponding MSG_MATCHSTATE phase change". The very next
  // frame after the match outcome is the phase change it refers to — and it used to be a
  // `warmup` frame, i.e. the client was told the match reverted rather than ended.
  const next = wire[outcomeAt + 1];
  expect(next !== undefined && next.kind === 'STATE' && next.phase === 'matchEnd',
    '§8.9 the frame straight after the match outcome IS the matchEnd phase change',
    `got ${JSON.stringify(next ?? null)}`);

  const states = wire.filter((f) => f.kind === 'STATE');
  const last = states[states.length - 1];
  expect(last !== undefined, 'the client received at least one MSG_MATCHSTATE',
    `decoded ${wire.length} frames, none of them a state`);
  const terminal = last ?? {};
  const alive = rules.aliveCounts();
  eq(terminal.phase, 'matchEnd', '§8.6 phase 5 — the last state a client holds says the match ended');
  // Every remaining field is compared against the RULESET's own final numbers, not against
  // constants written here, so a frame assembled from the empty defaults (round 0, 0-0, 0
  // alive) cannot pass by coincidence.
  eq(terminal.roundIndex, rules.roundIndex, 'the terminal frame carries the real round index');
  eq(terminal.scoreAlpha, rules.roundWins[0], 'and the real alpha score');
  eq(terminal.scoreBravo, rules.roundWins[1], 'and the real bravo score');
  eq(terminal.aliveAlpha, alive[0], 'and the real alpha alive count');
  eq(terminal.aliveBravo, alive[1], 'and the real bravo alive count');
  // The oracle above is only worth something if the numbers are distinguishable from the
  // zeroed fallback. Round 12 was won by wiping alpha, so bravo ends it with survivors.
  expect(alive[1] > 0, 'the winning side really does have survivors — 0/0 would be fabricated',
    `ruleset alive counts ${JSON.stringify(alive)}`);
  expect(rules.roundIndex > 0, 'and a real series has a non-zero round index',
    `roundIndex ${rules.roundIndex}`);

  // Nothing after the whistle may walk it back. Counted, not `.some()`d: an empty tail would
  // make a `.some()` check pass by vacuum.
  const afterWhistle = wire.slice(outcomeAt + 1).filter((f) => f.kind === 'STATE');
  const notEnded = afterWhistle.filter((f) => f.phase !== 'matchEnd');
  eq(notEnded.length, 0, 'no state frame after the match outcome reports any other phase');
  eqJson(notEnded.map((f) => f.phase), [], 'and the phases it did not report are these');

  const r = game.match.result;
  eqJson(tuple(r), {
    terminationReason: 'completed', outcomeReason: 'timer', winnerTeam: 'draw', aggregate: true,
  }, 'the §4.0 tuple and the wire agree: one drawn, completed match');
  eq(delta(before, career()).draws, 1, 'and the completed draw still aggregates');
  game.dispose();
}

// ══════════════════════════════════════════════ every published tuple satisfies §4.0, always

head('§4.0 the closed enum — nothing else is a match');
{
  const REASONS = ['elimination', 'defuse', 'detonation', 'timer', 'forfeit', 'abandon', 'no-contest'];
  const COMPLETED = ['elimination', 'defuse', 'detonation', 'timer'];
  const ABORTED = ['forfeit', 'abandon', 'no-contest'];
  // Replayed over the tuples the cases above ACTUALLY published — not a restatement of the
  // expected values, which would pass on its own arithmetic.
  const problems = [];
  for (const t of OBSERVED) {
    const legal = t.terminationReason === 'completed' ? COMPLETED
      : t.terminationReason === 'aborted' ? ABORTED : [];
    if (!REASONS.includes(t.outcomeReason)) problems.push(`${t.outcomeReason} is not in the enum`);
    else if (!legal.includes(t.outcomeReason)) problems.push(`${t.terminationReason}/${t.outcomeReason}`);
    if (!['alpha', 'bravo', 'draw', null].includes(t.winnerTeam)) problems.push(`winnerTeam ${t.winnerTeam}`);
    if (t.winnerTeam === 'draw' && t.outcomeReason !== 'timer') problems.push('draw without timer');
    if (t.outcomeReason === 'no-contest' && t.winnerTeam !== null) problems.push('no-contest with a winner');
    if ((t.outcomeReason === 'forfeit' || t.outcomeReason === 'abandon')
      && !['alpha', 'bravo'].includes(t.winnerTeam)) problems.push('forfeit without a winner');
    if (t.aggregate !== (t.outcomeReason !== 'no-contest')) problems.push('§6.1 aggregation row');
  }
  eq(OBSERVED.length, 6, 'six terminal results were published by the cases above');
  eqJson(problems, [], 'and every one of them satisfies a §4.0 row');
}

console.log(`\n${failures ? 'FAIL' : 'PASS'} — ${checks - failures}/${checks} checks (bomb match-result)`);
process.exit(failures ? 1 : 0);
