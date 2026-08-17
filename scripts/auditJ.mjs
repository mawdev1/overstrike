/**
 * AUDIT J — confirming the two determinism breakers auditI's RNG trace pointed at.
 *
 *  J1. Roster construction consumes the simulation RNG (`new Bot` / `new BotModel`),
 *      and that only happens on the first match of a page. Every later match with the
 *      same seed therefore starts at a different point in the stream.
 *
 *  J2. `BotManager._spawnBot()` early-returns for a bot that is still `alive`
 *      (botManager.js: "if (bot.alive) return"), while `Match.begin()` spawns every
 *      entity unconditionally. So a bot that ENDED the previous match alive is spawned
 *      once, and a bot that ended it dead is spawned twice — different RNG consumption
 *      and different placement, decided by the previous match.
 *
 *  If both are real, then making the precondition identical (same roster, all bots in
 *  the same liveness state) should make two same-seed matches identical.
 */
import { boot } from './auditlib.mjs';

const h = await boot({ port: 5351, viewport: { width: 400, height: 300 } });
const { page } = h;

const out = await page.evaluate(async () => {
  const g = window.__GAME__;
  const R = { checks: [], data: {} };
  const ok = (name, cond, detail) => R.checks.push({ name, pass: !!cond, detail: String(detail) });
  const sim = (n) => { for (let i = 0; i < n; i++) g._fixedUpdate(1 / 120); };
  const digest = () => g.entities.map((e) => [
    e.name, e.alive ? 1 : 0,
    +e.position.x.toFixed(4), +e.position.z.toFixed(4), +e.yaw.toFixed(4),
    e.state ?? '-', +(e.stateTimer ?? 0).toFixed(3),
  ].join(':')).join(' | ');

  // Count how many times each bot is placed during a startMatch.
  let spawnCalls = 0;
  const sp = g.match.spawner;
  const realSpawn = sp.spawnEntity.bind(sp);
  sp.spawnEntity = (e) => { spawnCalls++; return realSpawn(e); };

  const start = (seed) => {
    spawnCalls = 0;
    g.startMatch({ mode: 'tdm', difficulty: 'veteran', seed });
    return spawnCalls;
  };

  // ── warm-up: build the roster so construction draws are out of the way
  start(1);
  sim(600);
  g.returnToMenu();
  const roster = g.bots.bots.length;

  // ── J2a. all bots DEAD before the start
  const runAllDead = (seed) => {
    for (const b of g.bots.bots) { b.alive = false; }
    g.player.alive = false;
    const calls = start(seed);
    const d0 = digest();
    sim(600);
    const d600 = digest();
    g.returnToMenu();
    return { calls, d0, d600 };
  };
  // ── J2b. all bots ALIVE before the start
  const runAllAlive = (seed) => {
    for (const b of g.bots.bots) { b.alive = true; b.health = b.maxHealth; }
    g.player.alive = true; g.player.health = g.player.maxHealth;
    const calls = start(seed);
    const d0 = digest();
    sim(600);
    const d600 = digest();
    g.returnToMenu();
    return { calls, d0, d600 };
  };

  const dead1 = runAllDead(5150);
  const dead2 = runAllDead(5150);
  const alive1 = runAllAlive(5150);
  const alive2 = runAllAlive(5150);

  R.data.spawnEntityCalls = {
    roster,
    entities: roster + 1,
    whenAllBotsWereDead: dead1.calls,
    whenAllBotsWereAlive: alive1.calls,
  };
  R.data.reproducibility = {
    deadStart_twoRunsIdentical_atStep0: dead1.d0 === dead2.d0,
    deadStart_twoRunsIdentical_at600: dead1.d600 === dead2.d600,
    aliveStart_twoRunsIdentical_atStep0: alive1.d0 === alive2.d0,
    aliveStart_twoRunsIdentical_at600: alive1.d600 === alive2.d600,
    deadVsAlive_identical_atStep0: dead1.d0 === alive1.d0,
  };

  ok('spawn:eachEntityPlacedOnce', dead1.calls === roster + 1,
    `startMatch called spawner.spawnEntity ${dead1.calls}x for ${roster + 1} entities when the previous match left the bots dead, ` +
    `and ${alive1.calls}x when it left them alive (BotManager.reset spawns, then Match.begin spawns again)`);

  ok('determinism:reproducibleFromEqualPreconditions',
    R.data.reproducibility.deadStart_twoRunsIdentical_at600 && R.data.reproducibility.aliveStart_twoRunsIdentical_at600,
    `same seed + identical precondition reproduces the match: dead-start=${R.data.reproducibility.deadStart_twoRunsIdentical_at600}, alive-start=${R.data.reproducibility.aliveStart_twoRunsIdentical_at600}`);

  ok('determinism:independentOfPreviousMatch', R.data.reproducibility.deadVsAlive_identical_atStep0,
    `same seed, but the previous match left the bots dead vs alive: identical start = ${R.data.reproducibility.deadVsAlive_identical_atStep0}`);

  if (!R.data.reproducibility.deadVsAlive_identical_atStep0) {
    R.data.deadVsAliveSample = { dead: dead1.d0.slice(0, 220), alive: alive1.d0.slice(0, 220) };
  }

  sp.spawnEntity = realSpawn;
  return R;
});

console.log('\n=========== AUDIT J — DETERMINISM MECHANISM ===========');
let fails = 0;
for (const c of out.checks) { if (!c.pass) fails++; console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`); }
console.log(`\n  ${out.checks.length - fails}/${out.checks.length} passed`);
console.log('\ndata:', JSON.stringify(out.data, null, 1));
if (h.errors.length) console.log('\npage errors:', [...new Set(h.errors)].slice(0, 12));

await h.close();
