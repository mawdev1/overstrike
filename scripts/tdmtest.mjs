/**
 * Team Deathmatch is the only ruleset, its kill limit is configurable, and the winning
 * kill runs the roundEnd -> matchEnd -> After Action contract exactly once.
 */
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';
import { MODE_LIST, MODES, DEFAULT_MODE } from '../src/game/modes.js';
import { FIXED_DT } from '../src/core/mathUtils.js';

let failures = 0;
const ok = (name) => console.log(`  ok   ${name}`);
const bad = (name, detail) => {
  failures++;
  console.log(`  FAIL ${name}\n       ${detail}`);
};
const expect = (condition, name, detail = '') => condition ? ok(name) : bad(name, detail);

console.log('\nTeam Deathmatch round contract');

expect(
  MODE_LIST.length === 1 && MODE_LIST[0].id === 'tdm'
    && Object.keys(MODES).length === 1 && DEFAULT_MODE === 'tdm',
  'TDM is the only registered game mode',
  `modes=${Object.keys(MODES).join(',')}`,
);

const game = new Game({ headless: true });
await game.initHeadless({ presenter: new NullPresenter() });

const sequence = [];
let roundEndPayload = null;
let matchEndPayload = null;
game.bus.on('roundEnd', (payload) => {
  sequence.push('roundEnd');
  roundEndPayload = payload;
});
game.bus.on('matchEnd', (payload) => {
  sequence.push('matchEnd');
  matchEndPayload = payload;
});

game.startMatch({ mode: 'not-a-real-mode', killLimit: 3, botCount: 7, seed: 2026 });
game.match.phase = 'live';
game.match.countdown = 0;

expect(game.match.modeId === 'tdm', 'stale mode ids resolve to TDM', game.match.modeId);
expect(game.match.killLimit === 3, 'startMatch accepts a per-round kill limit', String(game.match.killLimit));

const attacker = game.player;
const victims = game.bots.bots.filter((bot) => bot.team !== attacker.team).slice(0, 3);
expect(victims.length === 3, 'the test round has three enemy targets', String(victims.length));

for (let i = 0; i < victims.length; i++) {
  game.bus.emit('kill', {
    attacker,
    victim: victims[i],
    weaponId: 'ar_vector',
    headshot: false,
    distance: 10,
  });
  if (i < 2) {
    expect(game.match.phase === 'live', `kill ${i + 1} does not end a first-to-3 round`, game.match.phase);
  }
}

expect(game.match.scores[attacker.team] === 3, 'the winning kill reaches the configured limit', game.match.scores.join('-'));
expect(game.match.phase === 'ended', 'the winning kill freezes the round', game.match.phase);
expect(game.state === 'gameover', 'the round transitions to the game-over/results state', game.state);
expect(sequence.join('>') === 'roundEnd>matchEnd', 'the end-of-round sequence is ordered and fires once', sequence.join('>'));
expect(roundEndPayload === matchEndPayload, 'roundEnd and matchEnd share one immutable result snapshot');
expect(
  matchEndPayload?.reason === 'killLimit' && matchEndPayload?.killLimit === 3,
  'the result records the kill-limit finish',
  JSON.stringify(matchEndPayload),
);
expect(matchEndPayload?.rows?.length === 8, 'After Action receives the final scoreboard rows', String(matchEndPayload?.rows?.length));
expect(game.match.canFire(attacker) === false, 'combat is locked after the final kill');

const scoreAtEnd = game.match.scores[attacker.team];
const elapsedAtEnd = game.match.elapsed;
game.bus.emit('kill', { attacker, victim: victims[0], weaponId: 'ar_vector' });
for (let i = 0; i < 120; i++) game._fixedUpdate(FIXED_DT);
expect(game.match.scores[attacker.team] === scoreAtEnd, 'kills after the whistle cannot change the result');
expect(game.match.elapsed === elapsedAtEnd, 'the round clock stays frozen during After Action');
expect(sequence.length === 2, 'the result sequence cannot fire twice', sequence.join('>'));

game.startMatch({ killLimit: 7, botCount: 0, seed: 2027 });
expect(game.match.killLimit === 7, 'the next round can choose a different kill limit', String(game.match.killLimit));
expect(game.match.scores[0] === 0 && game.match.scores[1] === 0, 'a new round resets both team scores');
expect(game.match.result === null && game.state === 'playing', 'a new round clears the prior result');

game.startMatch({ killLimit: 999, botCount: 0, seed: 2028 });
expect(game.match.killLimit === 500, 'programmatic kill limits are clamped to the safety maximum', String(game.match.killLimit));
expect(game.settings.get('killLimit') === 500, 'the normalized programmatic limit is persisted for the next round');

game.dispose();
console.log(failures ? `\n${failures} TDM check(s) failed` : '\nTDM round contract is clean');
process.exit(failures ? 1 : 0);
