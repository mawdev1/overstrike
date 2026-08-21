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
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Per-process port, for the same reason `wstest.mjs` derives one.
 *
 * This was a fixed 8191. Two of these running at once — two agents, or a `ci` chain beside an
 * interactive run — bind the same port, and the loser fails with EADDRINUSE while the winner
 * quietly serves BOTH sets of assertions from one process, inflating its client and health
 * counts. It presented as an intermittent `npm run ci` exit 1 in which every step passed when
 * run on its own, which is the worst shape a failure can take: it teaches people to re-run
 * rather than to look.
 *
 * Same arithmetic as wstest, offset so the two harnesses cannot land on each other.
 */
const PORT = 42000 + ((process.pid * 13) % 20000);
const ROUND = 30;                 // seconds — long enough for real combat, short enough to test

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const health = async () => (await fetch(`http://127.0.0.1:${PORT}/health?debug=1`)).json();
const debug = async () => (await fetch(`http://127.0.0.1:${PORT}/health?debug=1`)).json();
const CONTROL_SECRET = 'DEV-ONLY-INSECURE-MATCH-CONTROL-SECRET-do-not-ship';
const control = (path, body, secret = CONTROL_SECRET) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
/** Total rounds that have LANDED, across every attacker/target pair. */
const totalHits = (d) => (d.debug?.damage ?? []).reduce((a, r) => a + (r.hits || 0), 0);

console.log('\nthe dedicated server survives a round boundary');

/**
 * Wait until nothing is listening on `port`, then hand it over.
 *
 * These harnesses each own a fixed port, and a run that is interrupted — a CI timeout, a
 * killed shell — leaves its child holding it. The next run then dies on EADDRINUSE, which
 * reads as a netcode failure and is not one: measured at roughly one CI run in five.
 * Waiting is cheap and turns a confusing red into a two-second pause.
 */
async function waitForFreePort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const busy = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(true));
      s.once('listening', () => s.close(() => resolve(false)));
      s.listen(port, '127.0.0.1');
    });
    if (!busy) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

if (!await waitForFreePort(PORT)) {
  console.log(`  FAIL port ${PORT} is still held by another process`);
  process.exit(1);
}

const gs = spawn(
  process.execPath,
  [path.join(ROOT, 'server/index.js'), `--port=${PORT}`, '--bots=8', `--timelimit=${ROUND}`],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
);
let log = '';
let exited = null;
gs.stdout.on('data', (d) => { log += d; });
gs.stderr.on('data', (d) => { log += d; });
// A server that dies mid-test must say so. Without this the only symptom is `fetch
// failed`, which reads like a flaky harness and hides a real crash.
gs.on('exit', (code, signal) => { exited = { code, signal }; });

try {
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    await sleep(200);
    try { up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { /* not yet */ }
  }
  if (!up) { bad('the server starts', log.slice(-800)); throw new Error('no server'); }
  ok('the server starts and simulates');

  const unauthDrain = await control('/control/drain', { draining: true }, 'wrong');
  const malformedDrain = await control('/control/drain', { draining: true, extra: true });
  const drain = await control('/control/drain', { draining: true });
  const drainedStatus = await fetch(`http://127.0.0.1:${PORT}/control/status`, {
    headers: { authorization: `Bearer ${CONTROL_SECRET}` },
  }).then((response) => response.json());
  const refusedAllocation = await control('/control/allocate', {});
  if (unauthDrain.status === 401 && malformedDrain.status === 422 && drain.status === 200
    && drainedStatus.draining === true && refusedAllocation.status === 503) {
    ok('authenticated drain fails closed and excludes every new allocation');
  } else bad('authenticated drain excludes allocation', JSON.stringify({ unauth: unauthDrain.status,
    malformed: malformedDrain.status, drain: drain.status, drainedStatus, allocation: refusedAllocation.status }));
  const undrain = await control('/control/drain', { draining: false });
  const activeStatus = await fetch(`http://127.0.0.1:${PORT}/control/status`, {
    headers: { authorization: `Bearer ${CONTROL_SECRET}` },
  }).then((response) => response.json());
  if (undrain.status === 200 && activeStatus.draining === false) ok('explicit undrain restores allocation eligibility');
  else bad('explicit undrain restores allocation eligibility', JSON.stringify(activeStatus));
  const idleMatchId = '01M0H000000000000000000000';
  const idleRelease = await control('/control/release', { matchId: idleMatchId });
  const idleReplay = await control('/control/release', { matchId: idleMatchId });
  if (idleRelease.status === 204 && idleReplay.status === 204) ok('idle release is idempotent for terminal recovery after authority restart');
  else bad('idle release is idempotent after authority restart', `${idleRelease.status}/${idleReplay.status}`);

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
    // Measured on HITS LANDED, not kills. A kill on an 8-bot server arrives roughly every
    // 8-10 seconds, so a kill-counting window has to be long to be reliable and was flaky
    // at 20 s — it failed twice on a server that was demonstrably fighting. Rounds landing
    // is the same signal an order of magnitude more often, and it is the thing that
    // actually goes to zero on a dead server: `Match.canFire` false makes ballistics zero
    // ALL damage, so not one hit is recorded.
    // POLLED, not a fixed window. Two things make a fixed window lie here: the round can
    // end again mid-sample, and damage is correctly zero during the intermission; and on a
    // loaded machine the whole cycle drifts. So watch until hits increase while the match
    // is actually live, and only conclude "dead" if they never do.
    const base = totalHits(await debug());
    let landed = 0;
    let liveSamples = 0;
    const until = Date.now() + 45000;
    while (Date.now() < until && landed <= 0) {
      await sleep(2000);
      const d = await debug();
      if ((d.debug?.matchPhase ?? d.phase) === 'live') liveSamples++;
      landed = totalHits(d) - base;
    }
    if (landed > 0) ok(`combat is live after the restart (${landed} rounds landed)`);
    else {
      bad('combat is live after the restart',
        `ZERO rounds landed across every attacker/target pair over 45 s ` +
        `(${liveSamples} samples with the match live).\n` +
        '       That is the dead-server signature: damage is being zeroed, not merely scarce.');
    }
  }
} catch (e) {
  if (exited) {
    bad('the server stays up for a whole test',
      `the server process exited (code ${exited.code}, signal ${exited.signal}) mid-run.\n` +
      `       ${e.message}\n       server log tail: ${log.slice(-900)}`);
  } else if (!failures) {
    bad('the test ran', `${e.message}\n       server log tail: ${log.slice(-900)}`);
  }
} finally {
  gs.kill('SIGKILL');
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nthe server plays match after match\n');
process.exit(failures ? 1 : 0);
