/**
 * Boot the simulation in plain Node — no DOM, no WebGL, no renderer — and run a match.
 *
 * This is the Phase 4 acceptance test for the authoritative server: everything the server
 * will do, minus the network. If this passes, the simulation genuinely does not depend on
 * a browser; if it throws, it names the exact line that still does.
 *
 * It is deliberately NOT a determinism test (scripts/determinism.mjs covers that, in a
 * browser). What this proves is narrower and different: that the sim path can be
 * CONSTRUCTED and STEPPED with no presentation layer at all.
 *
 *   node scripts/headless.mjs [--ticks=2400] [--bots=8] [--seed=12345]
 */
import * as THREE from 'three';
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? Number(hit.split('=')[1]) : d;
};
const TICKS = arg('ticks', 2400);
const BOTS = arg('bots', 8);
const SEED = arg('seed', 12345);

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };

console.log(`\nheadless boot (${TICKS} ticks, ${BOTS} bots, seed ${SEED})`);

// The world builder asks `assets` for materials. Nothing on the simulation path reads a
// material — only the merged meshes do, and a headless build makes none — so a plain
// object satisfies every call site without pulling in a texture loader or a GL context.
const { assets } = await import('../src/core/assets.js');
const stubMat = () => new THREE.MeshBasicMaterial();
assets.mat = stubMat;
assets.tiled = stubMat;

let game;
const t0 = performance.now();
try {
  game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter() });
  ok(`initHeadless completed in ${Math.round(performance.now() - t0)} ms`);
} catch (e) {
  bad('initHeadless completed', `${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`);
  process.exit(1);
}

if (game.present instanceof NullPresenter) ok('a NullPresenter is installed');
else bad('a NullPresenter is installed', `got ${game.present?.constructor?.name}`);

if (!game.engine && !game.renderer && !game.hud && !game.audio && !game.fx) {
  ok('no renderer, HUD, audio or fx were constructed');
} else {
  bad('no renderer, HUD, audio or fx were constructed',
    `engine=${!!game.engine} renderer=${!!game.renderer} hud=${!!game.hud} audio=${!!game.audio} fx=${!!game.fx}`);
}

const boxes = game.world?.boxes?.length ?? 0;
if (boxes > 100) ok(`world built with ${boxes} colliders and ${game.world.spawnPoints.length} spawns`);
else bad('world built', `only ${boxes} colliders`);

// Bots must exist and must NOT have rigs: the rig is a rendering resource, so a no-op
// presenter cannot make it free — it has to not be built.
try {
  game.startMatch({ mode: 'tdm', botCount: BOTS, difficulty: 'regular', seed: SEED });
  game.match.phase = 'live';
  game.match.countdown = 0;
  const rigged = game.bots.bots.filter((b) => b.model).length;
  if (game.bots.bots.length === BOTS) ok(`${BOTS} bots spawned`);
  else bad(`${BOTS} bots spawned`, `got ${game.bots.bots.length}`);
  if (rigged === 0) ok('no bot rigs were constructed (present.visual === false)');
  else bad('no bot rigs were constructed', `${rigged} bots built a BotModel headlessly`);
} catch (e) {
  bad('startMatch', `${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`);
  process.exit(1);
}

// `Game._safe` catches a throwing system and isolates it for the rest of the session
// rather than crashing. That is right for a shipped game and disastrous for this test:
// without watching for it, a run in which the player system died on tick 1 reports a
// clean pass, because every remaining assertion is about bots and the clock.
const faults = [];
game.bus.on('systemFault', (f) => faults.push(`${f.system}.${f.phase}: ${f.error?.message}`));

const DT = 1 / 120;
const t1 = performance.now();
try {
  for (let i = 0; i < TICKS; i++) game._fixedUpdate(DT);
} catch (e) {
  bad('ran the fixed step', `threw at tick ${game.tick}: ${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`);
  process.exit(1);
}
const ms = performance.now() - t1;
ok(`${TICKS} ticks in ${Math.round(ms)} ms (${(TICKS / (ms / 1000)).toFixed(0)} ticks/s, ${(ms / TICKS).toFixed(3)} ms/tick)`);

// Real-time budget: the server must simulate faster than the clock it is simulating.
const realtime = (TICKS * DT) * 1000;
if (ms < realtime) ok(`${(realtime / ms).toFixed(0)}x faster than real time`);
else bad('faster than real time', `${Math.round(ms)} ms of CPU for ${Math.round(realtime)} ms of simulation`);

// The sim must actually have done something, or the timings above are of an empty loop.
if (faults.length === 0) ok('no system was isolated by the fault handler');
else bad('no system was isolated by the fault handler', faults.join('\n       '));

const moved = game.bots.bots.filter((b) => b.position.lengthSq() > 0).length;
const scored = game.match.scores.reduce((a, b) => a + b, 0);
if (moved > 0) ok(`bots are live (${moved} placed, scores ${game.match.scores.join(':')}, ${scored} total)`);
else bad('bots are live', 'no bot has a position — the loop ran but nothing simulated');

if (game.tick === TICKS) ok(`the clock advanced to tick ${game.tick} (time ${game.time.toFixed(3)}s)`);
else bad('the clock advanced', `tick ${game.tick}, expected ${TICKS}`);

console.log(failures ? `\n${failures} FAILED` : '\nheadless simulation runs clean');
process.exit(failures ? 1 : 0);
