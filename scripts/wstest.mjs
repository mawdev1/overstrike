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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { encodeCommands, quantiseCommand, MSG_WELCOME, MSG_SNAPSHOT, decodeSnapshot } from '../src/net/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8123;
let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\ndedicated server over a real WebSocket');

const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js'), `--port=${PORT}`, '--bots=2'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
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

const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
if (health.tick > 0) ok(`the match is ticking without any client (tick ${health.tick})`);
else bad('the match ticks with no client', 'tick is still 0 — a lobby that never simulates');

// ── play a client ────────────────────────────────────────────────────────────────────
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
ws.binaryType = 'arraybuffer';
let entityId = 0, welcomed = false, snapshots = 0, lastSnap = null;
const held = [];

/**
 * `ws` hands back a Buffer by default and an ArrayBuffer when `binaryType` is set; a
 * browser always gives an ArrayBuffer. A Buffer's underlying pool is also larger than its
 * view, so slicing by offset+length matters — copying the whole `.buffer` would hand the
 * decoder several unrelated messages' bytes.
 */
const toArrayBuffer = (d) => (d instanceof ArrayBuffer
  ? d
  : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));

ws.on('message', (data) => {
  const ab = toArrayBuffer(data);
  const v = new DataView(ab);
  const type = v.getUint8(0);
  if (type === MSG_WELCOME) {
    welcomed = true;
    entityId = v.getUint32(5, true);
    return;
  }
  if (type !== MSG_SNAPSHOT) return;
  snapshots++;
  const base = held.find((s) => s.tick === v.getUint32(6, true)) || null;
  const snap = decodeSnapshot(ab, base);
  held.push(snap);
  while (held.length > 40) held.shift();
  lastSnap = snap;
});

await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
await sleep(300);

if (welcomed && entityId > 0) ok(`the server assigned entity ${entityId} on connect`);
else bad('the server sends a welcome', `welcomed=${welcomed} entityId=${entityId}`);

const emptyCommand = () => ({
  wishForward: 0, wishRight: 0, jump: false, crouchPressed: false, reload: false,
  melee: false, grenade: false, interact: false, inspect: false, killstreak: false,
  lastWeapon: false, sprintDown: false, sprintUp: false, firePressed: false,
  aimButtonPressed: false, crouchHeld: false, toggleAdsMode: false, aimButtonHeld: false,
  fireHeld: false, sprintKeyHeld: false, breathHold: false, leanKeyHeld: false,
  leanRightKeyHeld: false, slot: -1, wheel: 0, deltaYaw: 0, deltaPitch: 0,
  baseYaw: 0, basePitch: 0, tick: 0,
});

const startWire = lastSnap?.entities.find((e) => e.id === entityId);

// Hold forward for two seconds of wall clock, at roughly the tick rate.
let seq = 1;
let baseYaw = 0;
for (let i = 0; i < 240; i++) {
  const cmd = emptyCommand();
  cmd.seq = seq++;
  cmd.wishForward = 1;
  cmd.deltaYaw = 0.004;
  baseYaw += Math.fround(0.004);
  cmd.baseYaw = baseYaw;
  quantiseCommand(cmd);
  ws.send(Buffer.from(encodeCommands([cmd])));
  // Slower than the 8.33 ms tick on purpose. A client that sends FASTER than the server
  // ticks builds a queue the server caps and then drops from, which is correct server
  // behaviour (it is how you stop someone acting ten times by sending ten times) but
  // makes this test measure the cap rather than the socket.
  await sleep(11);
}
await sleep(300);

const endWire = lastSnap?.entities.find((e) => e.id === entityId);
// The strongest single check here: every command sent over a real socket was consumed
// exactly once. If commands are being dropped, the movement and aim assertions below
// still "pass" at a lower threshold and say nothing about why.
const sent = seq - 1;
const consumed = lastSnap?.lastCommandSeq ?? 0;
if (consumed === sent) ok(`the server acked all ${sent} commands sent over the socket`);
else bad('every command sent is acked', `sent ${sent}, server acked ${consumed}`);
if (snapshots > 20) ok(`received ${snapshots} snapshots over the socket`);
else bad('snapshots arrive over a real socket', `only ${snapshots}`);

if (startWire && endWire) {
  const moved = Math.hypot(endWire.x - startWire.x, endWire.z - startWire.z);
  if (moved > 1) ok(`commands sent over the socket moved the entity ${moved.toFixed(2)} m`);
  else bad('commands over a real socket move the entity', `moved ${moved.toFixed(3)} m`);

  const turned = Math.abs(endWire.yaw - startWire.yaw);
  if (turned > 0.5) ok(`aim deltas applied over the socket (${turned.toFixed(2)} rad)`);
  else bad('aim deltas apply over a real socket', `turned ${turned.toFixed(3)} rad`);
} else {
  bad('the client sees its own entity', `start=${!!startWire} end=${!!endWire}`);
}

const getHealth = async () => {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/health`)).json(); } catch (e) {
    bad('the server is still alive', `${e.message}\n       last server output:\n${serverLog.slice(-900)}`);
    return null;
  }
};

const h2 = await getHealth();
if (!h2) { child.kill('SIGKILL'); process.exit(1); }
if (h2.clients === 1) ok('health reports the connected client');
else bad('health reports connected clients', `clients=${h2.clients}`);
if (h2.ticksBehind === 0) ok('the server kept up with real time (0 ticks dropped)');
else bad('the server keeps up with real time', `${h2.ticksBehind} ticks dropped`);

// The check `lastCommandSeq` cannot make. A client outrunning the tick rate has its
// OLDEST commands dropped while the newest still ack, so the ack alone looks perfect
// while a quarter of the player's input has vanished.
const sess = h2.sessions?.[0];
if (sess && sess.dropped === 0) ok(`no commands were dropped from the queue (${sess.commands} applied)`);
else bad('no commands are dropped from the queue',
  `${sess?.dropped} dropped, ${sess?.commands} applied of ${sent} sent — the client is outrunning the tick rate`);

// Disconnect must be clean — a server that leaks a session per join dies on the tenth
// player, which is exactly when it matters.
ws.close();
await sleep(500);
const h3 = await getHealth();
if (h3 && h3.clients === 0) ok('the session is released on disconnect');
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
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
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
const aStartFromB = posOf(bC, a.entityId);

// Only client A moves.
// A sweeps its aim while walking. Both clients spawn near each other on a map with a
// lot of geometry, and walking in one fixed direction just jams into whatever is in
// front — which measures the map, not the netcode.
let aYaw = 0;
for (let i = 0; i < 260; i++) {
  const cmd = emptyCommand();
  cmd.seq = a.seq++;
  cmd.wishForward = 1;
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

if (aStartFromB && aEndFromB) {
  const seen = Math.hypot(aEndFromB.x - aStartFromB.x, aEndFromB.z - aStartFromB.z);
  if (seen > 1.5) ok(`client B watched client A move ${seen.toFixed(2)} m`);
  else bad('each client sees the other move', `B saw A move only ${seen.toFixed(3)} m`);
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

const h4 = await (await fetch(`http://127.0.0.1:${PORT + 1}/health`)).json();
if (h4.clients === 2) ok('the server reports both clients');
else bad('the server reports both clients', `clients=${h4.clients}`);
if (h4.entities >= 2) ok(`the match holds ${h4.entities} entities with no bots`);
else bad('both player entities exist server-side', `entities=${h4.entities}`);

a.sock.close(); bC.sock.close();
await sleep(300);
child2.kill('SIGTERM');
await sleep(500);
child2.kill('SIGKILL');

console.log(failures ? `\n${failures} FAILED` : '\nthe dedicated server runs clean');
process.exit(failures ? 1 : 0);
