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

// Deliberately NOT stubbing `assets`. An earlier version replaced `mat`/`tiled` here,
// which made the boot quiet and hid the thing this harness exists to notice: how much
// rendering the simulation path still asks for. `Game.initHeadless` puts assets into
// headless mode instead, where a miss increments a counter — asserted below.
const { assets } = await import('../src/core/assets.js');

/**
 * Digest of everything the SIMULATION takes from a built level.
 *
 * Colliders and spawns are the entire simulation-visible output of world building; the
 * meshes are not consulted by anything that decides an outcome. Full precision, no
 * rounding — this is checking for bit-identity, and a tolerance would hide exactly the
 * drift it exists to catch.
 */
const levelDigest = (w) => {
  const parts = [];
  for (const b of w.boxes) {
    parts.push(`${b.min.x},${b.min.y},${b.min.z},${b.max.x},${b.max.y},${b.max.z},${b.surface}`);
  }
  parts.push('|');
  for (const sp of w.spawnPoints) parts.push(`${sp.position.x},${sp.position.y},${sp.position.z},${sp.yaw},${sp.team ?? '-'}`);
  return parts.join(';');
};

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

// The registry must be usable the moment the roster exists, not merely after the first
// startMatch. `entityById` caches its index against a version counter, and nothing bumped
// that when the player and bots were constructed — so a single lookup during boot froze an
// empty map and `Match._isLiveEntity(player)` then answered false, silently refusing to
// book the player's own stats. Phase 5 resolves wire ids through this, and a lobby-phase
// lookup is the natural first caller.
if (game.entityById(game.player.id) === game.player) ok('entityById resolves the player straight after boot, before any match');
else bad('entityById resolves the player straight after boot', 'the index was stale before the first startMatch');

const boxes = game.world?.boxes?.length ?? 0;
if (boxes > 100) ok(`world built with ${boxes} colliders and ${game.world.spawnPoints.length} spawns`);
else bad('world built', `only ${boxes} colliders`);

// ── the collider hash ────────────────────────────────────────────────────────────────
//
// The load-bearing check of colliders-only mode, and the only defence against its one
// real hazard. The level builder draws from the shared `game.rng` inside code that
// produces nothing but decoration (stains, shutters, debris). Those draws must still
// happen headlessly, or the server's stream ends up a different number of draws along
// than every client's and the entire map is built from different randomness — silently,
// with no error anywhere.
//
// So: build the same seed twice in this process, once with geometry and once without,
// and demand the simulation-visible output be identical.
const headlessDigest = levelDigest(game.world);
const headlessRng = JSON.stringify(game.rng.getState());

// Publish for the cross-process check in determinism.mjs, which digests the real browser
// build. In-process comparison cannot see what differs BETWEEN processes — module state,
// the THREE instance, the JIT — and that is exactly where a server/client map split would
// come from.
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const file = pathMod.join(os.tmpdir(), 'overstrike-collider-digest.json');
  let peer = null;
  try { peer = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first to run */ }
  fs.writeFileSync(file, JSON.stringify({
    from: 'headless', digest: headlessDigest,
    boxes: game.world.boxes.length, spawns: game.world.spawnPoints.length,
  }));
  if (peer && peer.from === 'browser') {
    if (peer.digest === headlessDigest) ok(`matches the browser build recorded by determinism.mjs (${boxes} boxes)`);
    else bad('matches the browser build', 'the browser and this server disagree on the map — see determinism.mjs for the first differing entry');
  }
}
{
  const full = new Game({ headless: true });
  await full.initHeadless({ presenter: new NullPresenter(), colliders: false });
  const fullDigest = levelDigest(full.world);

  // Stronger than comparing output: compare the STREAM POSITION. Two builds can produce
  // the same colliders while having drawn a different number of times — decoration draws
  // that happen to land on the same geometry — and the difference would then only surface
  // later, on the next thing to draw. Identical positions means identical draw counts.
  const fullRng = JSON.stringify(full.rng.getState());
  if (fullRng === headlessRng) ok(`both builds leave the rng at the same position (${headlessRng})`);
  else bad('both builds leave the rng at the same position',
    `colliders-only ${headlessRng} vs full ${fullRng} — an unequal number of draws, even though the colliders may match`);
  if (fullDigest === headlessDigest) {
    ok(`colliders-only build is bit-identical to a full build (${boxes} boxes, ${game.world.spawnPoints.length} spawns)`);
  } else {
    // Report where, not just that: the first differing entry localises an RNG desync to
    // the prop that caused it.
    const a = headlessDigest.split(';'), c = fullDigest.split(';');
    let at = 'length only';
    for (let i = 0; i < Math.max(a.length, c.length); i++) {
      if (a[i] !== c[i]) { at = `entry ${i}:\n         colliders-only: ${a[i]}\n         full:           ${c[i]}`; break; }
    }
    bad('colliders-only build is bit-identical to a full build',
      `${a.length} vs ${c.length} entries — the RNG streams diverged during world build.\n       ${at}`);
  }
}

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

// How much rendering the simulation path still asks for. Not zero: WeaponSystem builds a
// Viewmodel, Killstreaks builds sentry and chopper meshes, ProjectileSystem builds its
// pool — all rendering resources a server has no use for, and all still constructed. This
// is waste rather than a fault, so the check is a ceiling that makes it visible and stops
// it growing quietly.
if (assets.headlessMatRequests < 200) ok(`the sim path asked for ${assets.headlessMatRequests} materials (still-built rendering resources)`);
else bad('the sim path asks for few materials',
  `${assets.headlessMatRequests} material lookups — something large is building rendering resources headlessly`);

// `Game._safe` catches a throwing system and isolates it for the rest of the session
// rather than crashing. That is right for a shipped game and disastrous for this test:
// without watching for it, a run in which the player system died on tick 1 reports a
// clean pass, because every remaining assertion is about bots and the clock.
const faults = [];
game.bus.on('systemFault', (f) => faults.push(`${f.system}.${f.phase}: ${f.error?.message}`));

// ── entity ids and the registry ──────────────────────────────────────────────────────
//
// Ids used to come from three module-level counters kept apart by hard-coded gaps
// (player from 1, bots from 1000, streak hardware from 100000). killstreaks.js still
// carries the scar of that going wrong: sentry #1 and the player both being id 1, so
// anything keyed on shooter.id confused them. Networking makes an id the name one machine
// uses to tell another which entity it means, so they now come from one allocator.
{
  const ents = game.entities;
  const ids = ents.map((e) => e.id);
  const unique = new Set(ids);
  if (unique.size === ids.length) ok(`all ${ids.length} entity ids are distinct`);
  else bad('entity ids are distinct', `${ids.length} entities, ${unique.size} distinct ids: ${ids.join(',')}`);

  // Hardware draws from the same allocator, so it cannot collide with an entity either.
  const hw = [game.allocEntityId(), game.allocEntityId()];
  if (!hw.some((id) => unique.has(id))) ok('freshly allocated ids do not collide with live entities');
  else bad('freshly allocated ids do not collide', `${hw.join(',')} overlaps the roster`);

  const byId = ents.every((e) => game.entityById(e.id) === e);
  if (byId) ok('entityById resolves every live entity to the same object');
  else bad('entityById resolves every live entity', 'a lookup returned a different object or null');

  if (game.entityById(-1) === null) ok('entityById returns null for an unknown id');
  else bad('entityById returns null for an unknown id', 'got a value');
}

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

// Kills prove the whole chain end to end — bots seeing, pathing, shooting, ballistics
// resolving, and Match booking the result. That last step runs through `_isLiveEntity`,
// which now resolves via `entityById` rather than scanning; if the registry were wrong,
// scoring would silently stop and everything above would still pass. Long runs only:
// a few seconds of simulation is not enough for anyone to die.
const LONG_ENOUGH = 3600;
if (TICKS >= LONG_ENOUGH) {
  if (scored > 0) ok(`combat resolves end to end (${scored} kills booked in ${(TICKS / 120).toFixed(0)}s)`);
  else bad('combat resolves end to end',
    `no kills in ${(TICKS / 120).toFixed(0)}s of simulation — bots may be inert, or Match may not be booking (check _isLiveEntity / the entity registry)`);
}

if (game.tick === TICKS) ok(`the clock advanced to tick ${game.tick} (time ${game.time.toFixed(3)}s)`);
else bad('the clock advanced', `tick ${game.tick}, expected ${TICKS}`);

// Teardown has to work on a server: it runs between matches, for the life of the process.
// `stop()` called `cancelAnimationFrame` unconditionally, so `dispose()` threw BEFORE
// disposing a single system — every match leaked its systems and their bus subscriptions.
try {
  const throwaway = new Game({ headless: true });
  await throwaway.initHeadless({ presenter: new NullPresenter() });
  throwaway.startMatch({ mode: 'tdm', botCount: 2, difficulty: 'regular', seed: 5 });
  for (let i = 0; i < 120; i++) throwaway._fixedUpdate(1 / 120);
  throwaway.dispose();
  ok('a match instance disposes cleanly (no rAF, systems actually torn down)');
} catch (e) {
  bad('a match instance disposes cleanly', `${e.message} — a server leaks every system it ever built`);
}

console.log(failures ? `\n${failures} FAILED` : '\nheadless simulation runs clean');
process.exit(failures ? 1 : 0);
