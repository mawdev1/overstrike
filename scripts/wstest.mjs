/**
 * The dedicated server over a REAL WebSocket.
 *
 * Everything else in the netcode suite runs over the loopback transport, which is
 * deliberately in-process and therefore cannot catch anything about actual sockets:
 * Buffer-vs-ArrayBuffer confusion, framing, backpressure, the handshake, or the server
 * entrypoint's own wiring. This boots `server/index.js` as a real child process and plays
 * a client against it.
 *
 *   node scripts/wstest.mjs
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  encodeCommands, quantiseCommand, MSG_WELCOME, MSG_SNAPSHOT, MSG_REJECT,
  MSG_HELLO as MSG_HELLO_T,
  decodeSnapshot, encodeHello, decodeReject, PROTOCOL_VERSION,
} from '../src/net/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Per-process base: concurrent agents must never join each other's child server and inflate
// health/client counts. Keep four contiguous ports for the sub-harnesses.
const PORT = 12000 + ((process.pid * 7) % 30000);
let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const note = (n) => console.log(`  --   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// These legacy socket vectors intentionally exercise the unauthenticated local-dev entrypoint;
// allocation/ticket authority is covered by lobbytest. Never inherit a developer's production
// secrets into this child or fake `st_*` tickets become invalid depending on the shell.
const localServerEnv = { ...process.env, NODE_ENV: 'test', OVERSTRIKE_MATCH_TICKET_SECRET: '',
  OVERSTRIKE_MATCH_CONTROL_SECRET: '' };

console.log('\ndedicated server over a real WebSocket');

// No bots on this server. This block measures the SOCKET — that each command's aim delta
// is integrated exactly once — and a bot killing the client mid-measurement respawns it,
// which resets aim to the spawn angle and silently eats part of the turn. That is what
// made this assertion bimodal (0.22 / 0.86 / 0.96 rad depending on whether and when the
// client happened to die), and it read as load-related flakiness for several runs.
// `npm run headless` is where bots fighting is asserted.
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

const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js'), `--port=${PORT}`, '--bots=0'], {
  cwd: ROOT, env: localServerEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

// Wait for the listener rather than guessing at a sleep.
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  await sleep(200);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`);
    if (r.ok) up = true;
  } catch { /* not yet */ }
}
if (!up) {
  bad('the server starts and serves /health', serverLog.slice(-800));
  child.kill(); process.exit(1);
}
ok('the server starts and serves /health');

const health = await (await fetch(`http://127.0.0.1:${PORT}/health?debug=1`)).json();
if (health.tick > 0) ok(`the match is ticking without any client (tick ${health.tick})`);
else bad('the match ticks with no client', 'tick is still 0 — a lobby that never simulates');

const idleHello = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise((resolve, reject) => { idleHello.once('open', resolve); idleHello.once('error', reject); });
const idleClosed = await Promise.race([
  new Promise((resolve) => idleHello.once('close', () => resolve(true))),
  sleep(7_000).then(() => false),
]);
if (idleClosed) ok('a socket that never sends HELLO is closed by the handshake deadline');
else { bad('pre-HELLO sockets cannot occupy capacity forever', 'still open after 7 s'); idleHello.terminate(); }

// ── play a client ────────────────────────────────────────────────────────────────────
//
// Driven through the REAL `NetClient`, not a hand-rolled decoder.
//
// The first version reimplemented snapshot decoding here, and it drifted from the client
// it was meant to be testing: it lost delta baselines, so omitted (unchanged) fields
// decoded as 0 and the entity's yaw read back as a fraction of what the server actually
// had. That produced 0.22 / 0.81 / 0.96 rad on identical runs and cost several rounds of
// chasing load, packet drops and bot kills. A test of the wire should exercise the code
// that reads the wire.
const { NetClient } = await import('../src/net/client.js');

/**
 * `ws` hands back a Buffer by default; a browser always gives an ArrayBuffer. A Buffer's
 * underlying pool is larger than its view, so slicing by offset+length matters — copying
 * the whole `.buffer` would hand the decoder several unrelated messages' bytes.
 */
const toArrayBuffer = (d) => (d instanceof ArrayBuffer
  ? d
  : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));

/** Adapts a `ws` socket to the transport interface `NetClient` expects. */
function wsTransport(sock) {
  let handler = null;
  sock.on('message', (data) => handler?.(toArrayBuffer(data)));
  return {
    onMessage(fn) { handler = fn; },
    send(buf) { if (sock.readyState === 1) sock.send(Buffer.from(buf), { binary: true }); },
    close() { try { sock.close(); } catch { /* already gone */ } },
    pump() {},
  };
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
const client = new NetClient(wsTransport(ws));

const emptyCommand = () => ({
  wishForward: 0, wishRight: 0, jump: false, crouchPressed: false, reload: false,
  melee: false, grenade: false, interact: false, inspect: false, killstreak: false,
  lastWeapon: false, sprintDown: false, sprintUp: false, firePressed: false,
  aimButtonPressed: false, crouchHeld: false, toggleAdsMode: false, aimButtonHeld: false,
  fireHeld: false, sprintKeyHeld: false, breathHold: false, leanKeyHeld: false,
  leanRightKeyHeld: false, slot: -1, wheel: 0, deltaYaw: 0, deltaPitch: 0,
  baseYaw: 0, basePitch: 0, tick: 0,
});

await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

// ── the v2 handshake, over a real socket ─────────────────────────────────────────────
//
// The loopback in `nettest` cannot catch anything about actual sockets, and the handshake is
// the one exchange where getting it wrong means a client decodes bytes it does not agree
// about. So it is exercised here too, against the real `server/index.js`.
client.sendHello('st_wstest_ticket');
for (let i = 0; i < 100 && !client.welcome; i++) await sleep(20);
if (!client.welcome) {
  bad('the welcome decodes over a real socket', 'no welcome arrived within 2 s');
} else {
  if (client.welcome.protocolVersion === PROTOCOL_VERSION) {
    ok(`the welcome carries the negotiated protocol version (${PROTOCOL_VERSION}) over a real socket`);
  } else {
    bad('the welcome carries a protocol version',
      `got ${client.welcome.protocolVersion}, this build speaks ${PROTOCOL_VERSION}`);
  }
  if (client.welcome.mode === 'tdm') ok('and the mode it is running');
  else bad('the welcome names the mode', `got ${JSON.stringify(client.welcome.mode)}`);
  if (client.welcome.serverTickRateHz === 120) ok('and the server tick rate (120 Hz)');
  else bad('the welcome names the tick rate', `got ${client.welcome.serverTickRateHz}`);
  if (client.rejected === null) ok('a matching version is not rejected over a real socket');
  else bad('a matching version is accepted', JSON.stringify(client.rejected));
}

{
  // An incompatible client, on its own socket. Decoded from the bytes the socket delivered —
  // not from what the client object decided to remember.
  const old = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const frames = [];
  let closed = false;
  old.on('message', (d) => frames.push(toArrayBuffer(d)));
  old.on('close', () => { closed = true; });
  await new Promise((r, j) => { old.on('open', r); old.on('error', j); });
  old.send(Buffer.from(encodeHello(PROTOCOL_VERSION - 1, 'st_stale_build')), { binary: true });
  for (let i = 0; i < 100 && !closed; i++) await sleep(20);

  const rejectFrame = frames.find((b) => new DataView(b).getUint8(0) === MSG_REJECT);
  if (!rejectFrame) {
    bad('an incompatible client is rejected over a real socket',
      `no MSG_REJECT — got message types [${frames.map((b) => new DataView(b).getUint8(0)).join(',')}]`);
  } else {
    const r = decodeReject(rejectFrame);
    if (r.reason === 'PROTOCOL_VERSION_MISMATCH') ok('a stale client is refused with PROTOCOL_VERSION_MISMATCH');
    else bad('the rejection names the reason', `got ${JSON.stringify(r.reason)}`);
    if (r.serverVersion === PROTOCOL_VERSION) ok(`and the reject frame names the server's version (${r.serverVersion})`);
    else bad("the rejection carries the server's version", `got ${r.serverVersion}`);
  }
  if (closed) ok('and the server closed the socket rather than leaving it half-alive');
  else { bad('a rejected socket is closed', 'still open after 2 s'); try { old.close(); } catch { /* gone */ } }

  const h = await (await fetch(`http://127.0.0.1:${PORT}/health?debug=1`)).json();
  if (h.clients === 1) ok('the rejected connection left no session behind');
  else bad('a rejected connection is not counted as a client', `clients=${h.clients}`);
}

// Wait for the welcome AND for a snapshot that mentions us, so the baseline exists before
// anything is measured against it.
for (let i = 0; i < 100 && !client.entityId; i++) await sleep(20);
const entityId = client.entityId;
if (entityId > 0) ok(`the server assigned entity ${entityId} on connect`);
else bad('the server sends a welcome', 'no welcome arrived');
for (let i = 0; i < 100 && !client.latestEntity(entityId); i++) await sleep(20);

const startWire = client.latestEntity(entityId);

// Hold forward for two seconds of wall clock, at roughly the tick rate.
let baseYaw = 0;
for (let i = 0; i < 240; i++) {
  const cmd = emptyCommand();
  cmd.wishForward = 1;
  cmd.deltaYaw = 0.004;
  baseYaw += Math.fround(0.004);
  cmd.baseYaw = baseYaw;
  cmd.tick = client.latestTick;
  client.sendCommand(cmd);
  // Slower than the 8.33 ms tick on purpose. A client that sends FASTER than the server
  // ticks builds a queue the server caps and then drops from, which is correct server
  // behaviour (it is how you stop someone acting ten times by sending ten times) but
  // makes this test measure the cap rather than the socket.
  await sleep(11);
}
await sleep(300);

const getHealth = async () => {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/health?debug=1`)).json(); } catch (e) {
    bad('the server is still alive', `${e.message}\n       last server output:\n${serverLog.slice(-900)}`);
    return null;
  }
};

const endWire = client.latestEntity(entityId);
// Fetched here rather than below, because the aim assertion needs the applied-command
// count to derive its expectation.
const health2 = await getHealth();
if (!health2) { child.kill('SIGKILL'); process.exit(1); }
const sess = health2.sessions?.[0];
// The strongest single check here: every command sent over a real socket was consumed
// exactly once. If commands are being dropped, the movement and aim assertions below
// still "pass" at a lower threshold and say nothing about why.
const sent = client.stats.sent;
const consumed = client.lastAckedSeq;
if (consumed === sent) ok(`the server acked all ${sent} commands sent over the socket`);
else bad('every command sent is acked', `sent ${sent}, server acked ${consumed}`);
const snapshots = client.stats.snapshots;
if (snapshots > 20) ok(`received ${snapshots} snapshots over the socket`);
else bad('snapshots arrive over a real socket', `only ${snapshots}`);

if (startWire && endWire) {
  const moved = Math.hypot(endWire.x - startWire.x, endWire.z - startWire.z);
  if (moved > 1) ok(`commands sent over the socket moved the entity ${moved.toFixed(2)} m`);
  else bad('commands over a real socket move the entity', `moved ${moved.toFixed(3)} m`);

  // Compared against what the server ACTUALLY applied, not against a fixed total.
  //
  // Expecting 240 x 0.004 assumed every command was consumed within the measurement
  // window, which is a statement about the machine's timing rather than about the socket:
  // under load the same code turned 0.218 rad and failed, and idle it turns 0.96 and
  // passes. Deriving the expectation from the applied count tests the thing that matters —
  // that each command's delta was integrated exactly once — and is immune to how many of
  // them the window happened to cover.
  // Aim is measured in its own STATIONARY phase below, not here.
  //
  // Measuring it during the walk conflated two things: a client holding forward
  // eventually walks off something, dies, and respawns — which resets position AND
  // angles. The tell was that the turn and the distance shrank by the same factor on a
  // failing run (0.218 rad with 2.81 m, against 0.96 rad with 11.2 m), which is a
  // respawn, not a lost packet. I chased load, packet drops, bot kills and angle wrapping
  // before reading those two numbers next to each other.
} else {
  bad('the client sees its own entity', `start=${!!startWire} end=${!!endWire}`);
}

// ── aim, measured standing still ─────────────────────────────────────────────────────
{
  const before = client.latestEntity(entityId);
  const beforeCommands = sess?.commands ?? 0;
  let yaw = before?.yaw ?? 0;
  for (let i = 0; i < 120; i++) {
    const cmd = emptyCommand();          // no movement at all: cannot fall, cannot die
    cmd.deltaYaw = 0.004;
    yaw += Math.fround(0.004);
    cmd.baseYaw = yaw;
    cmd.tick = client.latestTick;
    client.sendCommand(cmd);
    await sleep(11);
  }
  await sleep(400);
  const after = client.latestEntity(entityId);
  const h = await getHealth();
  const applied = (h?.sessions?.[0]?.commands ?? 0) - beforeCommands;
  const wrap = (d) => { let x = d; while (x > Math.PI) x -= Math.PI * 2; while (x < -Math.PI) x += Math.PI * 2; return x; };
  const turned = Math.abs(wrap((after?.yaw ?? 0) - (before?.yaw ?? 0)));
  const expected = applied * Math.fround(0.004);
  if (applied > 100 && Math.abs(turned - expected) < 0.02) {
    ok(`aim deltas applied exactly once each (${turned.toFixed(3)} rad over ${applied} commands)`);
  } else {
    bad('aim deltas apply over a real socket',
      `turned ${turned.toFixed(3)} rad, expected ${expected.toFixed(3)} from ${applied} applied commands`);
  }
}

// A TDM server must not put Bomb state on the wire. `MSG_MATCHSTATE` there would be 41 bytes
// of zeroes several times a second describing a mode with no rounds and no bomb.
if (client.stats.matchStates === 0) ok('a TDM server sends no MSG_MATCHSTATE over the socket');
else bad('TDM carries no match state', `${client.stats.matchStates} MSG_MATCHSTATE frames arrived`);

const h2 = health2;
if (h2.clients === 1) ok('health reports the connected client');
else bad('health reports connected clients', `clients=${h2.clients}`);
if (h2.ticksBehind === 0) ok('the server kept up with real time (0 ticks dropped)');
else bad('the server keeps up with real time', `${h2.ticksBehind} ticks dropped`);

// The check `lastCommandSeq` cannot make. A client outrunning the tick rate has its
// OLDEST commands dropped while the newest still ack, so the ack alone looks perfect
// while a quarter of the player's input has vanished.
if (sess && sess.dropped === 0) ok(`no commands were dropped from the queue (${sess.commands} applied)`);
else bad('no commands are dropped from the queue',
  `${sess?.dropped} dropped, ${sess?.commands} applied of ${sent} sent — the client is outrunning the tick rate`);

// Disconnect must be clean — a server that leaks a session per join dies on the tenth
// player, which is exactly when it matters.
ws.close();
await sleep(500);
const h3 = await getHealth();
if (h3 === null) note('server already gone at disconnect check');
else if (h3.clients === 0) ok('the session is released on disconnect');
else bad('sessions are released on disconnect', `clients=${h3.clients} after close`);

// SIGTERM is what Fly sends. It must exit rather than be killed.
const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
child.kill('SIGTERM');
const raced = await Promise.race([exited, sleep(5000).then(() => null)]);
if (raced) ok(`exits cleanly on SIGTERM (code ${raced.code ?? raced.sig})`);
else { bad('exits cleanly on SIGTERM', 'still running after 5 s — Fly would have to kill it'); child.kill('SIGKILL'); }

if (/threw|Error:/.test(serverLog)) bad('the server logged no errors', serverLog.slice(-600));
else ok('the server logged no errors');

// ── two clients, one match ───────────────────────────────────────────────────────────
//
// The claim this whole build exists to support: two people on separate connections are in
// the same match and can see each other. Everything before this proves one client works;
// nothing before this proves the second one is not talking to a private world.
console.log('\ntwo clients in one match');

const child2 = spawn(process.execPath, [path.join(ROOT, 'server/index.js'), `--port=${PORT + 1}`, '--bots=0'], {
  cwd: ROOT, env: localServerEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
let log2 = '';
child2.stdout.on('data', (d) => { log2 += d; });
child2.stderr.on('data', (d) => { log2 += d; });

let up2 = false;
for (let i = 0; i < 100 && !up2; i++) {
  await sleep(200);
  try { up2 = (await fetch(`http://127.0.0.1:${PORT + 1}/health`)).ok; } catch { /* not yet */ }
}
if (!up2) { bad('the second server starts', log2.slice(-600)); child2.kill('SIGKILL'); process.exit(1); }

/** A minimal client: connects, tracks its entity, and remembers what it last saw. */
async function joinClient(port) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}`);
  const state = { entityId: 0, snap: null, snaps: [], seq: 1 };
  sock.on('message', (data) => {
    const ab = toArrayBuffer(data);
    const v = new DataView(ab);
    if (v.getUint8(0) === MSG_WELCOME) { state.entityId = v.getUint32(5, true); return; }
    if (v.getUint8(0) !== MSG_SNAPSHOT) return;
    const base = state.snaps.find((x) => x.tick === v.getUint32(6, true)) || null;
    const snap = decodeSnapshot(ab, base);
    state.snaps.push(snap);
    while (state.snaps.length > 40) state.snaps.shift();
    state.snap = snap;
  });
  await new Promise((r, j) => { sock.on('open', r); sock.on('error', j); });
  // §8.2: the first frame on the socket, and the only thing that makes the server allocate an
  // entity. Without it this client gets no welcome, no snapshots and no entity at all — which
  // is the point of the gate.
  sock.send(Buffer.from(encodeHello(PROTOCOL_VERSION, 'st_wstest_join')), { binary: true });
  state.sock = sock;
  return state;
}

const a = await joinClient(PORT + 1);
const bC = await joinClient(PORT + 1);
await sleep(400);

if (a.entityId && bC.entityId && a.entityId !== bC.entityId) {
  ok(`two clients got distinct entities (${a.entityId} and ${bC.entityId})`);
} else {
  bad('two clients get distinct entities', `${a.entityId} and ${bC.entityId}`);
}

const posOf = (state, id) => state.snap?.entities.find((e) => e.id === id);

/**
 * Entity `id` as seen by BOTH clients, at the newest snapshot tick they both hold.
 *
 * Comparing each client's own NEWEST snapshot compares two different moments: under load
 * one socket can be a snapshot ahead of the other, and A moving at walking speed covers
 * ~0.16 m in the 33 ms between sends. That reads as "they are not sharing a world" when
 * the only difference is which packet had arrived when the test looked. Agreement is only
 * meaningful at a shared tick.
 */
const posOfBoth = (s1, s2, id) => {
  const ticks2 = new Set(s2.snaps.map((x) => x.tick));
  for (let i = s1.snaps.length - 1; i >= 0; i--) {
    const t = s1.snaps[i].tick;
    if (!ticks2.has(t)) continue;
    const e1 = s1.snaps[i].entities.find((e) => e.id === id);
    const e2 = s2.snaps.find((x) => x.tick === t)?.entities.find((e) => e.id === id);
    if (e1 && e2) return { tick: t, e1, e2 };
  }
  return null;
};
const aStartFromB = posOf(bC, a.entityId);

// Only client A moves.
// A sweeps its aim while walking. Both clients spawn near each other on a map with a
// lot of geometry, and walking in one fixed direction just jams into whatever is in
// front — which measures the map, not the netcode.
// A cycles through all four cardinal directions rather than walking one way.
//
// Walking a single direction from a randomised spawn jams against geometry often enough
// to redden this gate about a quarter of the time — measured, not guessed. Cycling means
// A can only fail to move if it is boxed in on every side, which no playable spawn is.
let aYaw = 0;
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
for (let i = 0; i < 320; i++) {
  const cmd = emptyCommand();
  cmd.seq = a.seq++;
  const [wf, wr] = DIRS[Math.floor(i / 40) % DIRS.length];
  cmd.wishForward = wf;
  cmd.wishRight = wr;
  cmd.deltaYaw = 0.02;
  aYaw += Math.fround(0.02);
  cmd.baseYaw = aYaw;
  quantiseCommand(cmd);
  a.sock.send(Buffer.from(encodeCommands([cmd])));

  // B sends idle commands, so it is a live client rather than a silent socket.
  const idle = emptyCommand();
  idle.seq = bC.seq++;
  quantiseCommand(idle);
  bC.sock.send(Buffer.from(encodeCommands([idle])));

  await sleep(11);
}
await sleep(400);

const aEndFromB = posOf(bC, a.entityId);
const bEndFromA = posOf(a, bC.entityId);
const bEndFromB = posOf(bC, bC.entityId);

// Two assertions, deliberately separated.
//
// The first version asserted only "B saw A move more than 1.5 m", which failed about a
// quarter of the time: A walks from a randomised spawn and sometimes jams against map
// geometry, so the threshold measured the MAP rather than the netcode. A CI gate that
// reddens for reasons unrelated to the code under test is worse than no gate.
//
// So the load-bearing check is now AGREEMENT — B's view of A must match A's own view of
// itself, which is the property that says they share one world — and movement is asserted
// at a bar low enough that geometry cannot fail it.
if (aStartFromB && aEndFromB) {
  const seen = Math.hypot(aEndFromB.x - aStartFromB.x, aEndFromB.z - aStartFromB.z);
  if (seen > 0.3) ok(`client B watched client A move ${seen.toFixed(2)} m`);
  else bad('each client sees the other move', `B saw A move only ${seen.toFixed(3)} m — A may be jammed against geometry`);

  const shared = posOfBoth(a, bC, a.entityId);
  if (shared) {
    const { e1: aSelf, e2: aFromB } = shared;
    const agree = Math.hypot(aFromB.x - aSelf.x, aFromB.y - aSelf.y, aFromB.z - aSelf.z);
    if (agree < 0.01) ok(`B's view of A matches A's own to ${(agree * 1000).toFixed(2)} mm (tick ${shared.tick})`);
    else bad("B's view of A matches A's own", `${agree.toFixed(3)} m apart — they are not sharing a world`);
  }
} else {
  bad('client B can see client A at all', `start=${!!aStartFromB} end=${!!aEndFromB}`);
}

if (bEndFromA) ok('client A can see client B in its snapshots');
else bad('client A can see client B', 'B is absent from A\'s snapshots — separate worlds');

// And the one that proves they are in the SAME world rather than two identical ones:
// both clients must agree on where B is.
if (bEndFromA && bEndFromB) {
  const agree = Math.hypot(bEndFromA.x - bEndFromB.x, bEndFromA.y - bEndFromB.y, bEndFromA.z - bEndFromB.z);
  if (agree < 0.01) ok(`both clients agree on where B is, to ${(agree * 1000).toFixed(2)} mm`);
  else bad('both clients agree on entity positions', `${agree.toFixed(3)} m apart — they are not sharing a world`);
}

const h4 = await (await fetch(`http://127.0.0.1:${PORT + 1}/health?debug=1`)).json();
if (h4.clients === 2) ok('the server reports both clients');
else bad('the server reports both clients', `clients=${h4.clients}`);
if (h4.entities >= 2) ok(`the match holds ${h4.entities} entities with no bots`);
else bad('both player entities exist server-side', `entities=${h4.entities}`);

a.sock.close(); bC.sock.close();
await sleep(300);
child2.kill('SIGTERM');
await sleep(500);
child2.kill('SIGKILL');


// ── every v2 message type, over a real socket (§9.6) ─────────────────────────────────
//
// §9.6: "`scripts/nettest.mjs` and `scripts/wstest.mjs` must cover any new message type in
// the same change, including its malformed and hostile cases." This file covered `MSG_HELLO`
// and `MSG_REJECT` and nothing else — no `MSG_MATCHSTATE` content, no `MSG_OUTCOME`, no
// `interact` byte, no Bomb event kinds — so four of the six v2 additions had never crossed a
// socket at all, only the in-process loopback.
//
// A real `WebSocketServer`, a real `GameServer` over a real Bomb match, and the real
// `NetClient`. Bomb rather than TDM because `MSG_MATCHSTATE` and `MSG_OUTCOME` do not exist on
// a TDM stream, and the dedicated entrypoint is exercised in bomb mode below as well.
console.log('\ncurrent protocol message types over a real socket');

{
  const { WebSocketServer } = await import('ws');
  const { Game } = await import('../src/core/game.js');
  const { NullPresenter } = await import('../src/core/presenter.js');
  const { GameServer } = await import('../src/net/server.js');
  const {
    MSG_MATCHSTATE, MSG_OUTCOME, MSG_COMMANDS, MATCHSTATE_BYTES, decodeMatchState,
    unpackInteract, COMMAND_BYTES, MAX_COMMANDS_PER_BATCH,
  } = await import('../src/net/protocol.js');

  const WS_PORT = PORT + 2;
  if (!await waitForFreePort(WS_PORT)) bad(`port ${WS_PORT} is free`, 'still held');

  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter() });
  game.startMatch({ mode: 'bomb', botCount: 7, seed: 20260820 });
  game.match.phase = 'live';
  game.match.countdown = 0;
  const gs = new GameServer(game);
  gs.evidence.identify({ matchId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
  const rules = game.match.bombRules;
  for (let i = 0; i < 4000 && rules.phase !== 'live'; i++) gs.tick();
  if (rules.phase === 'live') ok('a real Bomb match reached its live round');
  else bad('the Bomb ruleset reaches a live round', `phase ${rules.phase}`);

  /** The same Buffer/ArrayBuffer discipline `server/index.js` uses. */
  const serverTransport = (sock) => {
    const t = { closed: false, _h: null };
    sock.on('message', (data) => {
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      // A malformed message must not take the process down — the same contract
      // `WsServerTransport` keeps.
      try { t._h?.(ab); } catch (e) { t.threw = e.message; }
    });
    sock.on('close', () => { t.closed = true; });
    t.onMessage = (fn) => { t._h = fn; };
    t.send = (buf) => { if (!t.closed && sock.readyState === 1) sock.send(Buffer.from(buf), { binary: true }); };
    t.pump = () => {};
    t.close = () => { t.closed = true; try { sock.close(); } catch { /* gone */ } };
    return t;
  };

  // Entities handed out in the order clients arrive: an attacker first, then defenders.
  const teamMembers = (team) => game.entities.filter((e) => e.team === team);
  const pool = [
    teamMembers(rules.attackingTeam).find((e) => e.id !== rules.bomb.carrierId),
    ...teamMembers(rules.defendingTeam),
  ];
  let handed = 0;
  const wss2 = new WebSocketServer({ port: WS_PORT, perMessageDeflate: false, maxPayload: 4096 });
  const sessions = [];
  wss2.on('connection', (sock) => {
    const s = gs.addClient(serverTransport(sock), () => pool[handed++]);
    sessions.push(s);
  });
  await new Promise((r) => wss2.once('listening', r));

  /** A real NetClient on a real socket, tapping every frame it is sent. */
  async function joinReal(ticket) {
    const sock = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    await new Promise((r, j) => { sock.on('open', r); sock.on('error', j); });
    const frames = [];
    const c = new NetClient(wsTransport(sock));
    sock.on('message', (d) => frames.push(toArrayBuffer(d)));
    c.sendHello(ticket);
    for (let i = 0; i < 100 && !c.entityId; i++) { gs.tick(); await sleep(5); }
    return { sock, client: c, frames };
  }

  const A = await joinReal('st_attacker');
  const B = await joinReal('st_defender');
  if (A.client.entityId && B.client.entityId && A.client.entityId !== B.client.entityId) {
    ok(`two real sockets were welcomed with distinct entities (${A.client.entityId}, ${B.client.entityId})`);
  } else {
    bad('the handshake allocates over a real socket', `${A.client.entityId} / ${B.client.entityId}`);
  }

  const step = async (n) => { for (let i = 0; i < n; i++) gs.tick(); await sleep(60); };
  await step(8);

  // ── MSG_MATCHSTATE, decoded from the socket's own bytes ───────────────────────────
  const stateFrames = A.frames.filter((f) => new DataView(f).getUint8(0) === MSG_MATCHSTATE);
  if (stateFrames.length === 0) {
    bad('MSG_MATCHSTATE crosses a real socket', `frame types [${[...new Set(A.frames.map((f) => new DataView(f).getUint8(0)))].join(',')}]`);
  } else {
    const ms = decodeMatchState(stateFrames[stateFrames.length - 1]);
    if (stateFrames[0].byteLength === MATCHSTATE_BYTES) ok(`MSG_MATCHSTATE arrives over a real socket at exactly ${MATCHSTATE_BYTES} bytes`);
    else bad('MSG_MATCHSTATE is 41 bytes on the wire', `${stateFrames[0].byteLength}`);
    if (ms.phase === 'live') ok('and its phase decodes as the round the ruleset is really in');
    else bad('the match state names the real phase', `${ms.phase} vs ruleset ${rules.phase}`);
    if (ms.localRole === 'attacker') ok('and tells this recipient which side it is on');
    else bad('the match state names the local role', `${ms.localRole}`);
    if (ms.bombState === 'carried') ok('and what the bomb is doing');
    else bad('the match state names the bomb state', `${ms.bombState} vs ${rules.bomb.state}`);
  }

  // ── the appended interact byte, over a real socket ────────────────────────────────
  {
    const carrier = game.entityById(rules.bomb.carrierId);
    const site = rules.sites.get('A');
    carrier.position.set((site.plant.min.x + site.plant.max.x) / 2, site.plant.min.y + 0.5,
      (site.plant.min.z + site.plant.max.z) / 2);
    let seen = null;
    for (let i = 0; i < 120 && !seen; i++) {
      rules.requestInteract(carrier, 'plant');
      carrier.grounded = true;
      gs.tick();
      if (i % 8 === 0) await sleep(4);
      for (const sn of A.client.snapshots) {
        const e = sn.entities.find((x) => x.id === carrier.id);
        if (!e) continue;
        const u = unpackInteract(e.interact ?? 0);
        if (u.kindName === 'plant' && u.progress > 0) seen = u;
      }
    }
    if (seen) ok(`the appended interact field crosses a real socket carrying a plant at ${seen.progress}/63`);
    else bad('the interact byte carries a plant over a real socket', 'every entity read as interact 0');
  }

  // ── the Bomb event kinds, over a real socket, with §8.8 applied ───────────────────
  {
    const carrier = game.entityById(rules.bomb.carrierId);
    const sp = game.world.spawnPoints.map((p) => p.position ?? p);
    const DROP = {
      x: Math.fround(sp[0].x + 0.101563), y: Math.fround(sp[0].y + 0.302734), z: Math.fround(sp[0].z + 0.507813),
    };
    const eyeH = carrier.eyeHeight ?? 1.6;
    let blindAt = null;
    for (let i = 1; i < sp.length && !blindAt; i++) {
      if (!game.world.losClear({ x: sp[i].x, y: sp[i].y + eyeH, z: sp[i].z }, DROP)) blindAt = sp[i];
    }
    const defender = game.entityById(B.client.entityId);
    const attacker = game.entityById(A.client.entityId);
    defender.position.set(blindAt.x, blindAt.y, blindAt.z);
    attacker.position.set(DROP.x, DROP.y + 1, DROP.z);      // authorised by role anyway
    carrier.position.set(DROP.x, DROP.y, DROP.z);
    A.frames.length = 0;
    B.frames.length = 0;
    rules.noteDisconnect(carrier);                          // §9's own path into `_dropBomb`
    carrier.position.set(sp[3].x, sp[3].y, sp[3].z);
    await step(8);

    const scan = (frames) => {
      const want = [DROP.x, DROP.y, DROP.z];
      const hits = [];
      for (const f of frames) {
        const dv = new DataView(f);
        for (let o = 0; o + 4 <= f.byteLength; o++) {
          if (want.some((w) => Object.is(dv.getFloat32(o, true), w))) hits.push(`type=${dv.getUint8(0)} off=${o}`);
        }
      }
      return hits;
    };
    const hitsA = scan(A.frames);
    const hitsB = scan(B.frames);
    if (hitsA.length >= 3) ok(`bombDropped crosses a real socket to an authorised recipient (${hitsA.length} float32 hits)`);
    else bad('the drop reaches an authorised recipient over a real socket', `${hitsA.length} hits — the control failed`);
    if (hitsB.length === 0) ok('and the coordinates appear on NO frame a blind defender received, at any offset');
    else bad('an unauthorised recipient never receives the coordinates over a real socket', hitsB.join('; '));
    const evA = A.client.snapshots.flatMap((s) => s.events).find((e) => e.kind === 'bombDropped');
    if (evA) ok(`and the real NetClient decoded it as ${evA.kind} at (${evA.x.toFixed(2)}, ${evA.y.toFixed(2)}, ${evA.z.toFixed(2)})`);
    else bad('an authorised client decodes bombDropped from the socket', 'no event arrived');
  }

  // ── MSG_OUTCOME, over a real socket ───────────────────────────────────────────────
  {
    const attackingTeam = rules.attackingTeam;
    for (const e of teamMembers(rules.defendingTeam)) {
      game.bus.emit('kill', { victim: e, attacker: null, weaponId: 'ar_vector', headshot: false, distance: 12 });
    }
    await step(12);
    const outFrames = A.frames.filter((f) => new DataView(f).getUint8(0) === MSG_OUTCOME);
    const o = A.client.outcome;
    if (outFrames.length === 0 || !o) {
      bad('MSG_OUTCOME crosses a real socket', `${outFrames.length} frames, outcome ${JSON.stringify(o)}`);
    } else {
      if (outFrames[0].byteLength === 32) ok('MSG_OUTCOME arrives over a real socket at exactly 32 bytes');
      else bad('MSG_OUTCOME is 32 bytes on the wire', `${outFrames[0].byteLength}`);
      if (o.scope === 'round') ok('and decodes as a round outcome');
      else bad('the outcome names its scope', `${o.scope}`);
      if (o.winnerTeam === (attackingTeam === 0 ? 'alpha' : 'bravo')) ok(`and names the winner (${o.winnerTeam})`);
      else bad('the outcome names the winner', `${o.winnerTeam}`);
      if (o.reason === 'elimination') ok('and why they won');
      else bad('the outcome names the reason', `${o.reason}`);
      if (o.matchId === '01ARZ3NDEKTSV4RRFFQ69G5FAV') ok('and carries the match id as 16 raw ULID bytes');
      else bad('the outcome carries the match id', `${o.matchId}`);
    }
  }

  // ── hostile and malformed, client → server, over a real socket ────────────────────
  {
    const before = game.entities.length;

    // 1. Commands before any hello.
    const rude = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    const rudeFrames = [];
    let rudeClosed = false;
    rude.on('message', (d) => rudeFrames.push(toArrayBuffer(d)));
    rude.on('close', () => { rudeClosed = true; });
    await new Promise((r, j) => { rude.on('open', r); rude.on('error', j); });
    const cmd = { seq: 1, tick: 0, wishForward: 1, wishRight: 0, deltaYaw: 0, deltaPitch: 0, baseYaw: 0, basePitch: 0, slot: -1, wheel: 0 };
    quantiseCommand(cmd);
    rude.send(Buffer.from(encodeCommands([cmd])), { binary: true });
    for (let i = 0; i < 60 && !rudeClosed; i++) { gs.tick(); await sleep(10); }
    const rej = rudeFrames.find((f) => new DataView(f).getUint8(0) === MSG_REJECT);
    if (rej && decodeReject(rej).reason === 'SESSION_TOKEN_INVALID') ok('commands before the hello are refused over a real socket');
    else bad('a socket that skips the hello is refused', `frames [${rudeFrames.map((f) => new DataView(f).getUint8(0)).join(',')}]`);
    if (rudeClosed) ok('and the socket is closed rather than left half-alive');
    else { bad('an unauthenticated socket is closed', 'still open'); try { rude.close(); } catch { /* gone */ } }
    if (game.entities.length === before) ok('and it caused no entity to be allocated');
    else bad('an unauthenticated socket allocates nothing', `${game.entities.length} entities, was ${before}`);

    // 2. A hello at the wrong length, and a hostile command batch, on their own sockets.
    for (const [name, bytes] of [
      ['a hello claiming a 255-byte ticket it did not send', (() => {
        const b = new ArrayBuffer(6); const v = new DataView(b);
        v.setUint8(0, MSG_HELLO_T); v.setUint16(1, PROTOCOL_VERSION, true); v.setUint8(3, 255); return b;
      })()],
    ]) {
      const sock = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
      const fr = [];
      let closed = false;
      sock.on('message', (d) => fr.push(toArrayBuffer(d)));
      sock.on('close', () => { closed = true; });
      await new Promise((r, j) => { sock.on('open', r); sock.on('error', j); });
      sock.send(Buffer.from(bytes), { binary: true });
      for (let i = 0; i < 60 && !closed; i++) { gs.tick(); await sleep(10); }
      if (closed && fr.some((f) => new DataView(f).getUint8(0) === MSG_REJECT)) ok(`${name} is rejected and closed (§8.11)`);
      else bad(`${name} closes the connection`, `closed=${closed} frames=[${fr.map((f) => new DataView(f).getUint8(0)).join(',')}]`);
    }

    // 3. A command batch declaring far more commands than the cap, from an AUTHENTICATED
    //    socket. `decodeCommands` throws, and the throw must not reach the tick loop.
    const hostile = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    await new Promise((r, j) => { hostile.on('open', r); hostile.on('error', j); });
    hostile.send(Buffer.from(encodeHello(PROTOCOL_VERSION, 'st_hostile')), { binary: true });
    for (let i = 0; i < 40; i++) { gs.tick(); await sleep(5); }
    const huge = new ArrayBuffer(6 + COMMAND_BYTES);
    const hv = new DataView(huge);
    hv.setUint8(0, MSG_COMMANDS);
    hv.setUint32(2, MAX_COMMANDS_PER_BATCH * 1000, true);
    hostile.send(Buffer.from(huge), { binary: true });
    // 4. And a type this build has never heard of, which §8.11 says to IGNORE.
    const unknown = new ArrayBuffer(8);
    new DataView(unknown).setUint8(0, 99);
    hostile.send(Buffer.from(unknown), { binary: true });
    const tickBefore = game.tick;
    let alive = true;
    try { for (let i = 0; i < 60; i++) gs.tick(); } catch (e) { alive = false; bad('a hostile command batch does not kill the tick loop', e.message); }
    await sleep(50);
    if (alive && game.tick > tickBefore) ok('an over-declared command batch and an unknown type leave the server ticking');
    hostile.close();
  }

  for (const c of [A, B]) c.sock.close();
  await sleep(100);
  wss2.close();
}

// ── the same protocol, out of the real entrypoint, in Bomb mode ──────────────────────
{
  // The blocks above run `GameServer` in-process. This one proves `server/index.js` itself
  // can host the Bomb wire, because that is the process a player actually connects to.
  const BOMB_PORT = PORT + 3;
  if (!await waitForFreePort(BOMB_PORT)) bad(`port ${BOMB_PORT} is free`, 'still held');
  const bombChild = spawn(process.execPath,
    [path.join(ROOT, 'server/index.js'), `--port=${BOMB_PORT}`, '--bots=6', '--mode=bomb'],
    { cwd: ROOT, env: localServerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let bombLog = '';
  bombChild.stdout.on('data', (d) => { bombLog += d; });
  bombChild.stderr.on('data', (d) => { bombLog += d; });
  let bombUp = false;
  for (let i = 0; i < 100 && !bombUp; i++) {
    await sleep(200);
    try { bombUp = (await fetch(`http://127.0.0.1:${BOMB_PORT}/health`)).ok; } catch { /* not yet */ }
  }
  if (!bombUp) {
    bad('the dedicated server starts in Bomb mode', bombLog.slice(-800));
  } else {
    ok('the dedicated server starts in Bomb mode');
    const sock = new WebSocket(`ws://127.0.0.1:${BOMB_PORT}`);
    const c = new NetClient(wsTransport(sock));
    const seen = new Set();
    sock.on('message', (d) => seen.add(new DataView(toArrayBuffer(d)).getUint8(0)));
    await new Promise((r, j) => { sock.on('open', r); sock.on('error', j); });
    c.sendHello('st_bomb_real');
    for (let i = 0; i < 200 && c.stats.matchStates === 0; i++) await sleep(25);
    if (c.stats.matchStates > 0) ok(`MSG_MATCHSTATE arrives from the real entrypoint (${c.stats.matchStates} frames)`);
    else bad('the dedicated server sends match state in Bomb mode', `types seen [${[...seen].join(',')}]`);
    const ms = c.matchState;
    if (ms && ['warmup', 'freeze', 'live', 'planted', 'roundEnd', 'matchEnd'].includes(ms.phase)) {
      ok(`and its phase is a real one ("${ms.phase}", round ${ms.roundIndex})`);
    } else {
      bad('the match state from the real server decodes', JSON.stringify(ms));
    }
    if (c.rejected === null) ok('and the client was never rejected');
    else bad('a matching client is accepted by a Bomb server', JSON.stringify(c.rejected));
    sock.close();
  }
  await sleep(200);
  bombChild.kill('SIGTERM');
  await sleep(400);
  bombChild.kill('SIGKILL');
  if (/threw|Error:/.test(bombLog)) bad('the Bomb server logged no errors', bombLog.slice(-600));
  else ok('the Bomb server logged no errors');
}

// ── a hostile SERVER, over a real socket ─────────────────────────────────────────────
{
  // The client half of §8.11, which no test had ever exercised over a socket: a known message
  // type at a length this build cannot read. A 6-byte welcome used to throw a RangeError out
  // of `NetClient._onMessage`, which the transport swallowed — no close, no reject, and the
  // connection carried on being fed bytes neither side agreed about.
  const { WebSocketServer } = await import('ws');
  const { MSG_MATCHSTATE, MSG_OUTCOME } = await import('../src/net/protocol.js');
  const EVIL_PORT = PORT + 4;
  if (!await waitForFreePort(EVIL_PORT)) bad(`port ${EVIL_PORT} is free`, 'still held');

  for (const [name, type, len] of [
    ['a 6-byte welcome', MSG_WELCOME, 6],
    ['a welcome between the two legal lengths', MSG_WELCOME, 18],
    ['a truncated match state', MSG_MATCHSTATE, 40],
    ['an over-long outcome', MSG_OUTCOME, 33],
  ]) {
    const evil = new WebSocketServer({ port: EVIL_PORT, perMessageDeflate: false });
    await new Promise((r) => evil.once('listening', r));
    evil.on('connection', (s) => {
      const b = Buffer.alloc(len);
      b[0] = type;
      s.send(b, { binary: true });
    });
    const sock = new WebSocket(`ws://127.0.0.1:${EVIL_PORT}`);
    let closed = false;
    sock.on('close', () => { closed = true; });
    // The receiver is attached BEFORE the socket opens: this server sends its hostile frame
    // the instant the connection lands, and a handler added after `open` misses it.
    const c = new NetClient(wsTransport(sock));
    await new Promise((r, j) => { sock.on('open', r); sock.on('error', j); });
    c.sendHello('st_evil');
    for (let i = 0; i < 100 && !c.rejected; i++) await sleep(20);
    if (c.rejected && c.stats.malformed === 1) ok(`${name} from a real server closes the client's connection`);
    else bad(`${name} closes the connection (§8.11)`, `rejected=${JSON.stringify(c.rejected)} malformed=${c.stats.malformed}`);
    if (c.lastMalformed?.byteLength === len) ok(`...and the client names the frame that did it (type ${c.lastMalformed.type}, ${len} bytes)`);
    else bad('the client records which frame was malformed', JSON.stringify(c.lastMalformed));
    try { sock.close(); } catch { /* gone */ }
    await new Promise((r) => evil.close(r));
    void closed;
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nthe dedicated server runs clean');
process.exit(failures ? 1 : 0);
