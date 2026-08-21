/**
 * H3.3 — autonomous full Bomb match on The Square.
 *
 * Unlike bombtest's boundary fixtures, this harness never writes an actor position or
 * objective state. Eleven real Bot instances choose routes, traverse the baked nav graph,
 * fight, recover dropped bombs, plant, defend, retake and defuse through the same intent
 * API used by a client. BombRules remains the only writer of objective truth.
 */
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';
import { FIXED_DT } from '../src/core/mathUtils.js';
import { BOMB_PARAMS } from '../src/game/bomb.js';

let checks = 0;
const failures = [];
const check = (condition, message, detail = '') => {
  checks++;
  if (!condition) failures.push(`${message}${detail ? ` — ${detail}` : ''}`);
};

const SEED = 20260817;
const MAX_TICKS = 120 * 60 * 35;
const REQUIRED_ROLES = Object.freeze([
  'plant', 'planting', 'escort', 'lurk', 'recover', 'hold', 'defend', 'retake', 'defusing',
]);

const game = new Game({ headless: true });
await game.initHeadless({ presenter: new NullPresenter() });
game.startMatch({ mode: 'bomb', botCount: 11, difficulty: 'regular', seed: SEED });

// Skip only the legacy three-second presentation countdown. The Bomb freeze, round clocks,
// round-end delays and whole MR12/first-to-seven series run at their frozen durations.
game.match.phase = 'live';
game.match.countdown = 0;
const bomb = game.match.bombRules;

// A headless Game still owns one Player entity. Disconnect it before the first Bomb tick so
// every carrier, kill and interaction in this acceptance match belongs to autonomous bots.
bomb.noteDisconnect(game.player);

const botIds = new Set(game.bots.bots.map((bot) => bot.id));
const previous = new Map();
const routeDistance = new Map();
let priorRound = 0;
let priorLive = false;
let maxLiveStep = 0;
let ticks = 0;
let liveRespawns = 0;
const stopSpawnWatch = game.bus.on('spawn', () => {
  if (bomb.liveRound) liveRespawns++;
});

while (!bomb.series && ticks < MAX_TICKS) {
  const liveBefore = bomb.liveRound;
  const roundBefore = bomb.roundNumber;
  game._fixedUpdate(FIXED_DT);
  ticks++;

  // Measure movement rather than assuming it. Reset at a round boundary because fixed Bomb
  // spawns legitimately place actors for the next round; inside a live round, no step may
  // resemble a test teleport.
  const sameLiveRound = priorLive && liveBefore && priorRound === roundBefore
    && bomb.roundNumber === roundBefore;
  for (const bot of game.bots.bots) {
    const old = previous.get(bot.id);
    if (sameLiveRound && old && bot.alive) {
      const dx = bot.position.x - old.x;
      const dz = bot.position.z - old.z;
      const d = Math.hypot(dx, dz);
      maxLiveStep = Math.max(maxLiveStep, d);
      routeDistance.set(bot.id, (routeDistance.get(bot.id) ?? 0) + d);
    }
    previous.set(bot.id, { x: bot.position.x, z: bot.position.z });
  }
  priorLive = bomb.liveRound;
  priorRound = bomb.roundNumber;
}

const events = bomb.events;
const event = (kind) => events.filter((row) => row.kind === kind);
const plants = event('plantComplete');
const defuses = event('defuseComplete');
const drops = event('bombDropped');
const recoveries = event('bombPickedUp').filter((row) => row.reason === 'pickup');
const roles = new Set(game.bots.objectiveLog.map((row) => row.role));

check(bomb.series !== null, 'a complete legal Bomb series finishes inside the guard');
check(bomb.phase === 'matchEnd', 'the autonomous match reaches matchEnd', bomb.phase);
check(ticks < MAX_TICKS, 'the match cannot hang at a site or on a dropped bomb', `${ticks} ticks`);
check(game.match.modeId === 'bomb', 'the real Bomb mode remained active for the full match');
check(game.world.manifest?.mapId === 'the-square', 'the match ran on The Square');
check(game.bots._pathCount > 0, 'bots consumed real baked-nav paths', `${game.bots._pathCount}`);
check(maxLiveStep < 0.75, 'no actor teleported inside a live round', `${maxLiveStep.toFixed(4)}m max step`);
check(liveRespawns === 0, 'eliminated bots never respawn during a live Bomb round', `${liveRespawns}`);
check([...routeDistance.values()].some((distance) => distance > 40),
  'objective actors traversed substantial world distance', JSON.stringify([...routeDistance.values()].map((n) => +n.toFixed(1))));

check(plants.length >= 2, 'bots complete multiple authoritative plants', `${plants.length}`);
check(defuses.length >= 1, 'bots complete an authoritative retake and defuse', `${defuses.length}`);
check(drops.length >= 1, 'a carrier death drops the authoritative bomb', `${drops.length}`);
check(recoveries.length >= 1, 'a teammate autonomously recovers a dropped bomb', `${recoveries.length}`);
check(new Set(plants.map((row) => row.site)).size === 2, 'bots choose and plant both authored sites');
check(plants.every((row) => botIds.has(row.entityId)), 'every planter is an autonomous bot');
check(defuses.every((row) => botIds.has(row.entityId)), 'every defuser is an autonomous bot');
check(recoveries.every((row) => botIds.has(row.entityId)), 'every recovery is by an autonomous bot');
for (const role of REQUIRED_ROLES) check(roles.has(role), `objective planner exercises ${role}`);

const rounds = bomb.rounds;
check(rounds.length >= BOMB_PARAMS.roundsToWin && rounds.length <= BOMB_PARAMS.maxRounds,
  'series length stays inside the frozen first-to-seven/MR12 bounds', `${rounds.length}`);
check(rounds.every((row, index) => row.round === index + 1), 'round records are contiguous');
check(rounds.every((row) => ['elimination', 'defuse', 'detonation', 'timer'].includes(row.reason)),
  'every autonomous round has a legal closed reason');
check(rounds.every((row) => row.attackingTeam === (row.round <= BOMB_PARAMS.sideSwitchAfterRound ? 0 : 1)),
  'roles switch exactly after round six');
const [alpha, bravo] = bomb.series?.roundWins ?? [-1, -1];
check(Math.max(alpha, bravo) === BOMB_PARAMS.roundsToWin
  || (rounds.length === BOMB_PARAMS.maxRounds && alpha === 6 && bravo === 6),
  'series ends only at seven wins or the legal 6-6 draw', `${alpha}-${bravo}`);

stopSpawnWatch();
game.dispose();

if (failures.length) {
  console.error(`\nBomb bot acceptance: FAIL — ${failures.length}/${checks}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`\nBomb bot acceptance: PASS — ${checks} checks, ${rounds.length} rounds, `
  + `${plants.length} plants, ${defuses.length} defuses, ${recoveries.length} recoveries, `
  + `${(ticks * FIXED_DT).toFixed(1)} simulated seconds`);
process.exit(0);
