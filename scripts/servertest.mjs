/**
 * The dedicated server survives the end of a match.
 *
 * It did not. Nothing listened for `matchEnd`, so the first round ran out and the process
 * sat in `phase === 'ended'` indefinitely — and "ended" is not a frozen scoreboard, it is
 * a server on which combat is impossible:
 *
 *   `Match.update` returns early once ended, so nothing ever respawns;
 *   `Match.canFire` returns false, and `ballistics.js` zeroes ALL damage;
 *   bots never die, never re-equip, and run their magazines dry standing still.
 *
 * Since a Fly machine is kept warm with `auto_stop_machines = "off"`, every player who
 * joined more than ten minutes after boot got that server. They reported enemies standing
 * around doing nothing and shots that never registered. Both were literally true.
 *
 * This drives a REAL server process through a round boundary and asserts it comes back.
 *
 *   node scripts/servertest.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8191;
const ROUND = 30;                 // seconds — long enough for real combat, short enough to test

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const health = async () => (await fetch(`http://127.0.0.1:${PORT}/health`)).json();

console.log('\nthe dedicated server survives a round boundary');

const gs = spawn(
  process.execPath,
  [path.join(ROOT, 'server/index.js'), `--port=${PORT}`, '--bots=8', `--timelimit=${ROUND}`],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
);
let log = '';
gs.stdout.on('data', (d) => { log += d; });
gs.stderr.on('data', (d) => { log += d; });

try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    await sleep(200);
    try { up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { /* not yet */ }
  }
  if (!up) { bad('the server starts', log.slice(-800)); throw new Error('no server'); }
  ok('the server starts and simulates');

  const first = await health();
  if (first.phase === 'live') ok(`the first match is live (${first.bots} bots)`);
  else bad('the first match is live', `phase=${first.phase}`);

  // Let the round expire, then give the intermission time to elapse.
  const deadline = Date.now() + (ROUND + 25) * 1000;
  let after = null;
  while (Date.now() < deadline) {
    await sleep(1000);
    const h = await health();
    if (h.matches > 1) { after = h; break; }
  }

  if (after) ok(`the match restarted (now on match ${after.matches})`);
  else {
    const h = await health();
    bad('the match restarts when it ends',
      `still on match ${h.matches}, phase=${h.phase}, timeRemaining=${h.timeRemaining}.\n` +
      `       This is the bug: the server is now permanently unplayable.\n` +
      `       server log tail: ${log.slice(-400)}`);
  }

  if (after) {
    if (after.phase === 'live') ok('the new match is live, not ended');
    else bad('the new match is live', `phase=${after.phase}`);

    // The clock must not have gone backwards — connected clients stamp everything to it.
    if (after.tick >= first.tick) ok(`the server clock stayed monotonic (${first.tick} -> ${after.tick})`);
    else bad('the server clock stays monotonic', `tick went BACKWARDS: ${first.tick} -> ${after.tick}`);

    // And the thing that actually matters: combat works again after the restart.
    // 8 bots in a 22 m arena kill each other every few seconds; a window this size is
    // several times the observed gap, so a zero here means combat is genuinely dead rather
    // than merely slow. (An earlier version of this check used 4 bots and 8 seconds, which
    // is BELOW the normal kill interval — it failed on a working server.)
    const s0 = await health();
    await sleep(20000);
    const s1 = await health();
    const before = (s0.scores ?? []).reduce((a, b) => a + b, 0);
    const now = (s1.scores ?? []).reduce((a, b) => a + b, 0);
    if (now > before) ok(`bots are fighting after the restart (+${now - before} kills in 20 s)`);
    else {
      bad('bots fight after the restart',
        `no kills in 20 s (scores ${JSON.stringify(s0.scores)} -> ${JSON.stringify(s1.scores)}).\n` +
        '       A restarted match that scores nothing is the dead-server symptom again.');
    }
  }
} catch (e) {
  if (!failures) bad('the test ran', e.message);
} finally {
  gs.kill('SIGKILL');
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nthe server plays match after match\n');
process.exit(failures ? 1 : 0);
