/**
 * End-to-end netcode, in plain Node.
 *
 * A real headless `Game` behind a real `GameServer`, a real `NetClient`, and a loopback
 * with a latency/loss knob. No browser, no rendering — this is the authoritative loop and
 * nothing else, which is what makes it fast enough to run at every commit.
 *
 * The question it answers is narrow and important: does a command sent by a client
 * actually move that client's entity on the server, and does the result come back?
 * Everything else in the netcode is built on that sentence being true.
 *
 *   node scripts/nettest.mjs [--ticks=1200]
 */
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';
import { GameServer, SNAPSHOT_INTERVAL, EVENT_RANGE_M, readBombMatchState } from '../src/net/server.js';
import { NetClient } from '../src/net/client.js';
import { createLoopbackPair } from '../src/net/transport.js';
import { Prediction, POSITION_TOLERANCE } from '../src/net/prediction.js';
import { FIXED_DT } from '../src/core/mathUtils.js';
import {
  PROTOCOL_VERSION, ENTITY_FIELDS, EV_KINDS, MSG_SNAPSHOT, MSG_WELCOME, MSG_REJECT,
  MSG_MATCHSTATE, MATCHSTATE_BYTES, WELCOME_BYTES_V1, WELCOME_BYTES_V2,
  encodeSnapshot, decodeSnapshot, encodeHello, decodeHello, encodeReject, decodeReject,
  encodeWelcome, decodeWelcome, encodeMatchState, decodeMatchState,
  encodeOutcome, decodeOutcome, encodeCommands, packInteract, unpackInteract, evCode,
  matchIdBytes, ulidFromBytes, INTERACT_PROGRESS_MAX, EV_SPATIAL, upgradeMessage,
  MSG_OUTCOME, REFUSAL_REASONS, CANCEL_REASONS, REJECT_PROTOCOL_VERSION_MISMATCH,
} from '../src/net/protocol.js';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? Number(hit.split('=')[1]) : d;
};
const TICKS = arg('ticks', 1200);

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };

/** A command with everything off. The shape `Player.applyCommand` expects. */
const emptyCommand = () => ({
  wishForward: 0, wishRight: 0,
  jump: false, crouchPressed: false, reload: false, melee: false, grenade: false,
  interact: false, inspect: false, killstreak: false, lastWeapon: false,
  sprintDown: false, sprintUp: false, firePressed: false, aimButtonPressed: false,
  crouchHeld: false, toggleAdsMode: false, aimButtonHeld: false, fireHeld: false,
  sprintKeyHeld: false, breathHold: false, leanKeyHeld: false, leanRightKeyHeld: false,
  slot: -1, wheel: 0, deltaYaw: 0, deltaPitch: 0, baseYaw: 0, basePitch: 0, tick: 0,
});

/** Boot a server with `clients` connected, each with its own entity. */
async function makeSession({ clients = 1, bots = 0, latencyMs = 0, loss = 0, seed = 4242 } = {}) {
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter() });
  game.startMatch({ mode: 'tdm', botCount: bots, difficulty: 'regular', seed });
  game.match.phase = 'live';
  game.match.countdown = 0;

  const server = new GameServer(game);
  const conns = [];
  const { Player } = await import('../src/player/player.js');

  for (let i = 0; i < clients; i++) {
    const [cT, sT] = createLoopbackPair({ latencyMs, loss });
    // First client takes game.player; the rest get their own registered entity.
    let entity = game.player;
    if (i > 0) {
      entity = new Player(game);
      await entity.init();
      game.addEntity(entity);
      game.weapons.giveLoadout(entity, ['ar_vector', 'pistol_sidewinder']);
      entity.respawn?.();
    }
    const session = server.addClient(sT, entity);
    const client = new NetClient(cT);
    // §8.2: the hello is the first frame on the socket, and NOTHING exists until it lands —
    // no entity binding, no welcome, and no command accepted. The harness has to perform the
    // handshake for the same reason a real client does.
    //
    // Fed to `_onMessage` as REAL BYTES rather than pushed through the pipe, because the pipe
    // is the thing under test in the loss and latency blocks: at `loss: 0.2` the handshake
    // frame itself was dropped one run in five, the session never authenticated, and a test
    // about redundancy failed at "moved 0.0%" for a reason that had nothing to do with
    // redundancy. The handshake has its own dedicated coverage over both transports.
    server._onMessage(session, encodeHello(PROTOCOL_VERSION, `st_nettest_${i}`));
    conns.push({ client, session, cT, sT, entity });
  }
  return { game, server, conns };
}

/**
 * Drive a plain session (no prediction) with the client reporting the newest server tick
 * it has seen — which is what the server derives the round trip from.
 */
function runPredictedLike(session, n) {
  const { server, conns } = session;
  let ms = 0;
  for (let t = 0; t < n; t++) {
    for (const c of conns) {
      const cmd = emptyCommand();
      cmd.tick = c.client.latestTick;
      cmd.wishForward = 1;
      c.client.sendCommand(cmd);
      c.sT.pump(ms);
    }
    server.tick();
    for (const c of conns) c.cT.pump(ms);
    ms += FIXED_DT * 1000;
  }
}

/** Run `n` ticks, letting the caller shape each client's command. */
function run(session, n, shape = () => {}) {
  const { server, conns } = session;
  let ms = 0;
  for (let t = 0; t < n; t++) {
    for (const c of conns) {
      const cmd = emptyCommand();
      // The client's OWN newest received tick, not the server's current one. A real client
      // sends `net.latestTick` (see `MultiplayerSession.sendCommand`), and the server reads
      // this field for two things: the round-trip estimate, and — since baselines became
      // ack-driven — which snapshot to delta-code against. Claiming a tick the client has
      // not actually received tells the server to code against a baseline the client does
      // not hold, and `decodeSnapshot` then fills every omitted field with ZERO. That is
      // the same corruption the ack was introduced to prevent, manufactured by the harness.
      cmd.tick = c.client.latestTick;
      shape(cmd, t, c);
      c.client.sendCommand(cmd);
      c.sT.pump(ms);            // deliver client -> server
    }
    server.tick();
    for (const c of conns) c.cT.pump(ms);   // deliver server -> client
    ms += FIXED_DT * 1000;
  }
}

console.log('\nauthoritative loop over the loopback');

{
  const s = await makeSession();
  const start = s.conns[0].entity.position.clone();
  run(s, 240, (cmd) => { cmd.wishForward = 1; cmd.fireHeld = true; });
  const moved = s.conns[0].entity.position.distanceTo(start);

  if (moved > 1) ok(`a client's commands move its entity on the server (${moved.toFixed(2)} m)`);
  else bad("a client's commands move its entity", `moved ${moved.toFixed(3)} m — commands are not reaching the simulation`);

  const st = s.conns[0].session.stats;
  if (st.commands >= 230) ok(`the server consumed ${st.commands} of 240 commands`);
  else bad('the server consumed the commands', `only ${st.commands} of 240`);

  if (st.resyncs === 0) ok('no aim resync was needed on a clean link');
  else bad('no aim resync on a clean link', `${st.resyncs} resyncs — the delta and checksum integrations disagree`);

  const cs = s.conns[0].client.stats;
  if (cs.snapshots >= 240 / SNAPSHOT_INTERVAL - 2) ok(`the client received ${cs.snapshots} snapshots at 1/${SNAPSHOT_INTERVAL} ticks`);
  else bad('the client received snapshots', `${cs.snapshots} in 240 ticks`);

  if (s.conns[0].client.unacked.length <= 4) ok(`acknowledgement keeps the unacked queue short (${s.conns[0].client.unacked.length})`);
  else bad('acknowledgement drains the unacked queue', `${s.conns[0].client.unacked.length} commands still unacked`);
}

{
  const s = await makeSession();
  run(s, 120, (cmd) => { cmd.wishForward = 1; });
  const e = s.conns[0].entity;
  const wire = s.conns[0].client.latestEntity(e.id);
  if (!wire) {
    bad('the client sees its own entity in snapshots', 'no entity with that id arrived');
  } else {
    // float32 on the wire, so agreement is to about a millimetre rather than exact.
    const d = Math.hypot(wire.x - e.position.x, wire.y - e.position.y, wire.z - e.position.z);
    if (d < 0.01) ok(`snapshot position matches the server's within ${(d * 1000).toFixed(2)} mm`);
    else bad('snapshot position matches the server', `${d.toFixed(4)} m apart`);
  }
}

console.log('\nduplicates, loss and reordering');

{
  // Redundant resends are the loss strategy, so duplicates are the NORMAL case and must
  // never be applied twice — a command applied twice is a player who moved twice.
  const s = await makeSession();
  run(s, 120, (cmd) => { cmd.wishForward = 1; });
  const st = s.conns[0].session.stats;
  // More duplicates than unique commands means the redundancy is genuinely resending.
  // The exact ratio is not fixed and should not be asserted: a packet carries the last
  // few UNACKED commands, and the unacked queue drains every time a snapshot acks. On a
  // clean 0 ms link acks come back within a few ticks so the queue is 1-4 deep and the
  // average packet carries ~2.5 commands; on a lossy or high-latency link the queue grows
  // and redundancy deepens by itself. That is the behaviour you want — protection scales
  // with how bad the link is — but it makes any fixed expected count wrong.
  if (st.duplicates > st.commands) ok(`redundancy resent ${st.duplicates} commands against ${st.commands} unique (adaptive to ack depth)`);
  else bad('redundancy resends commands', `${st.duplicates} duplicates for ${st.commands} commands — packets are not carrying history`);
  if (st.commands <= 121) ok(`each command applied exactly once (${st.commands} for 120 ticks)`);
  else bad('each command applied once', `${st.commands} applications for 120 commands — some ran twice`);
}

{
  // 20% loss with 3-deep redundancy should cost almost nothing: a command is lost only
  // when four consecutive packets are.
  const clean = await makeSession();
  const startC = clean.conns[0].entity.position.clone();
  run(clean, 300, (cmd) => { cmd.wishForward = 1; });
  const cleanDist = clean.conns[0].entity.position.distanceTo(startC);

  const lossy = await makeSession({ loss: 0.2 });
  const startL = lossy.conns[0].entity.position.clone();
  run(lossy, 300, (cmd) => { cmd.wishForward = 1; });
  const lossyDist = lossy.conns[0].entity.position.distanceTo(startL);

  const ratio = cleanDist > 0 ? lossyDist / cleanDist : 0;
  if (ratio > 0.9) ok(`20% packet loss costs almost nothing (${(ratio * 100).toFixed(1)}% of clean distance)`);
  else bad('redundancy absorbs packet loss', `moved only ${(ratio * 100).toFixed(1)}% as far as on a clean link — redundancy is not covering the loss`);
}

{
  // Latency must delay, not corrupt. The same commands over a 100 ms link should produce
  // the same movement, just later.
  const s = await makeSession({ latencyMs: 100 });
  const start = s.conns[0].entity.position.clone();
  run(s, 400, (cmd) => { cmd.wishForward = 1; });
  const moved = s.conns[0].entity.position.distanceTo(start);
  if (moved > 1) ok(`a 100 ms link still moves the entity (${moved.toFixed(2)} m)`);
  else bad('a 100 ms link still moves the entity', `moved ${moved.toFixed(3)} m`);
  if (s.conns[0].session.stats.resyncs === 0) ok('no aim resync at 100 ms');
  else bad('no aim resync at 100 ms', `${s.conns[0].session.stats.resyncs} resyncs`);
}

console.log('\ntwo clients');

{
  const s = await makeSession({ clients: 2 });
  const [a, b] = s.conns;
  if (a.entity !== b.entity) ok('each client drives its own entity');
  else bad('each client drives its own entity', 'both sessions were given the same entity');

  const startA = a.entity.position.clone();
  const startB = b.entity.position.clone();
  // Only client A moves. If commands were being applied to the wrong entity, B would move
  // too — which is the failure this is really looking for.
  run(s, 240, (cmd, t, c) => { if (c === a) cmd.wishForward = 1; });

  const movedA = a.entity.position.distanceTo(startA);
  const movedB = b.entity.position.distanceTo(startB);
  if (movedA > 1) ok(`the moving client moved (${movedA.toFixed(2)} m)`);
  else bad('the moving client moved', `${movedA.toFixed(3)} m`);
  if (movedB < 0.5) ok(`the idle client stayed put (${movedB.toFixed(3)} m)`);
  else bad('the idle client stayed put', `moved ${movedB.toFixed(2)} m — commands are reaching the wrong entity`);

  // ...and now make B move, which is the half this was missing.
  //
  // "The idle client stayed put" passed for years on a client that COULD NOT MOVE:
  // `Game._fixedUpdate` stepped `player` and `bots` and never `_extraEntities`, so every
  // client after the first was snapshotted, lag-compensated and shootable, and completely
  // inert. Asserting only that a thing does not happen cannot tell a working brake from a
  // missing engine.
  const startB2 = b.entity.position.clone();
  run(s, 240, (cmd, t, c) => { if (c === b) cmd.wishForward = 1; });
  const movedB2 = b.entity.position.distanceTo(startB2);
  if (movedB2 > 1) ok(`the second client can move too (${movedB2.toFixed(2)} m)`);
  else {
    bad('the second client can move',
      `${movedB2.toFixed(3)} m after 240 forward commands — it is registered and shootable ` +
      'but never simulated, so every player after the first is a statue');
  }

  // Each client must see BOTH entities, or there is no multiplayer.
  const seen = a.client.snapshots.at(-1)?.entities.length ?? 0;
  if (seen >= 2) ok(`a client's snapshot carries all ${seen} entities`);
  else bad("a client's snapshot carries every entity", `only ${seen}`);
}

console.log('\nwith bots');

{
  const s = await makeSession({ bots: 6, seed: 909 });
  run(s, TICKS, (cmd, t) => { cmd.wishForward = 1; cmd.fireHeld = t % 40 < 12; });
  const last = s.conns[0].client.snapshots.at(-1);
  const ents = last?.entities.length ?? 0;
  if (ents === 7) ok(`snapshots carry the player and all 6 bots (${ents} entities)`);
  else bad('snapshots carry every entity', `${ents} entities, expected 7`);

  const bytes = s.conns[0].cT.stats.bytesSent;
  const perSec = bytes / (TICKS * FIXED_DT);
  if (perSec < 60000) ok(`server -> client is ${(perSec / 1024).toFixed(1)} KiB/s with 7 entities`);
  else bad('snapshot bandwidth is reasonable', `${(perSec / 1024).toFixed(1)} KiB/s`);

  const up = s.conns[0].sT.stats.bytesSent / (TICKS * FIXED_DT);
  ok(`client -> server is ${(up / 1024).toFixed(1)} KiB/s (${TICKS} commands, 3-deep redundancy)`);
}

console.log('\nprediction and reconciliation');

/**
 * A client with its OWN simulation, predicting locally against the server's.
 *
 * Both Games are built from the same seed, so they start identical and any divergence is
 * the netcode's doing rather than the world's.
 */
async function makePredictedSession({ latencyMs = 0, loss = 0, bots = 0, seed = 4242 } = {}) {
  const server = await makeSession({ clients: 1, bots, latencyMs, loss, seed });

  // The client runs NO bots, whatever the server has.
  //
  // This is the architecture, not a test shortcut: a client does not simulate anyone it
  // does not control. Remote entities — bots included — arrive as snapshots and are
  // interpolated. Running local twins would mean two independent AI simulations drifting
  // apart from the first tick, and the client's player colliding with bots that are not
  // where the server says they are, which reconciliation would then spend the whole match
  // correcting.
  const clientGame = new Game({ headless: true });
  await clientGame.initHeadless({ presenter: new NullPresenter() });
  clientGame.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed });
  clientGame.match.phase = 'live';
  clientGame.match.countdown = 0;

  // Start the local player exactly where the server has them, or the first snapshot is a
  // correction for a reason that has nothing to do with prediction.
  const serverEnt = server.conns[0].entity;
  clientGame.player.position.copy(serverEnt.position);
  clientGame.player.velocity.copy(serverEnt.velocity);
  clientGame.player.setAngles(serverEnt.yaw, serverEnt.pitch);
  clientGame.player.id = serverEnt.id;

  const pred = new Prediction(clientGame, clientGame.player, server.conns[0].client);
  server.conns[0].client.onSnapshot((snap) => pred.reconcile(snap));
  return { ...server, clientGame, pred };
}

function runPredicted(s, n, shape = () => {}) {
  const c = s.conns[0];
  let ms = 0;
  for (let t = 0; t < n; t++) {
    const cmd = emptyCommand();
    cmd.tick = s.server.game.tick;
    shape(cmd, t);
    // The absolute-aim checksum has to be the client's ACTUAL aim. Sending a constant
    // here makes the server think the client has desynced and snap its aim on every
    // command — which then sends the two simulations off in different directions and
    // looks exactly like a prediction bug.
    cmd.baseYaw = s.clientGame.player.baseYaw;
    cmd.basePitch = s.clientGame.player.basePitch;
    c.client.sendCommand(cmd);       // quantises in place
    s.pred.predict(cmd);             // predict from exactly what was sent
    c.sT.pump(ms);
    s.server.tick();
    c.cT.pump(ms);
    ms += FIXED_DT * 1000;
  }
}

{
  // The plan's main regression test: at zero latency the prediction and the authority are
  // running the same commands over the same world, so they must agree EXACTLY. A
  // forgotten snapshot field shows up here as a constant 120 Hz divergence rather than as
  // an occasional glitch under load — the best failure mode available.
  const s = await makePredictedSession();
  runPredicted(s, 600, (cmd, t) => {
    cmd.wishForward = t % 200 < 120 ? 1 : 0;
    cmd.wishRight = t % 200 >= 120 ? 1 : 0;
    cmd.deltaYaw = Math.sin(t / 30) * 0.01;
    cmd.fireHeld = t % 90 < 25;
    if (t === 150 || t === 400) cmd.jump = true;
    if (t === 300) cmd.crouchPressed = true;
  });

  const se = s.conns[0].entity;
  const ce = s.clientGame.player;
  const drift = se.position.distanceTo(ce.position);

  if (drift < POSITION_TOLERANCE) ok(`predicted and authoritative agree at 0 ms (${(drift * 1000).toFixed(3)} mm apart after 600 ticks)`);
  else bad('predicted and authoritative agree at 0 ms',
    `${drift.toFixed(4)} m apart — the client simulation is not reproducing the server's`);

  if (s.pred.stats.corrections === 0) ok('no corrections were needed at 0 ms');
  else bad('no corrections at 0 ms',
    `${s.pred.stats.corrections} corrections, worst error ${s.pred.stats.worstError.toFixed(4)} m — prediction diverges from authority on an ideal link`);
}

{
  // 100 ms and 5% loss. Corrections are expected here; what matters is that they stay
  // small and that the client does not drift away.
  const s = await makePredictedSession({ latencyMs: 100, loss: 0.05 });
  runPredicted(s, 900, (cmd, t) => {
    cmd.wishForward = t % 160 < 100 ? 1 : -1;
    cmd.deltaYaw = Math.sin(t / 25) * 0.012;
    cmd.fireHeld = t % 70 < 20;
    if (t % 240 === 0) cmd.jump = true;
  });

  const drift = s.conns[0].entity.position.distanceTo(s.clientGame.player.position);
  // The client is deliberately AHEAD by about the one-way latency, so a gap is correct —
  // that gap is what prediction is for. It must stay bounded, not vanish.
  if (drift < 2) ok(`at 100 ms / 5% loss the client stays within ${drift.toFixed(2)} m of authority`);
  else bad('the client stays close under latency', `${drift.toFixed(2)} m adrift`);

  // Measured only across ticks where both sides agree the player is alive. A death and
  // respawn moves the player across the map and no prediction can foresee it — the server
  // decides who dies — so folding those in makes a healthy client look catastrophic. The
  // first version of this test did exactly that and reported 33 m, which turned out to be
  // one fall-damage death.
  const st = s.pred.stats;
  if (st.worstErrorLiving < 1) ok(`worst error while alive ${st.worstErrorLiving.toFixed(3)} m over 900 ticks (${st.respawnCorrections} respawn corrections excluded)`);
  else bad('reconciliation error stays bounded while alive',
    `worst ${st.worstErrorLiving.toFixed(2)} m at ${JSON.stringify(st.worstAt)}`);

  ok(`${s.pred.stats.corrections} corrections, ${s.pred.stats.replayedCommands} commands replayed`);
}

{
  // Aim must never be reconciled. This is the difference between a shooter that feels
  // responsive and one that fights the mouse: a snapshot is up to a snapshot-interval old,
  // and pulling the local aim toward it would drag the crosshair backwards continuously.
  const s = await makePredictedSession({ latencyMs: 150 });
  runPredicted(s, 400, (cmd) => { cmd.deltaYaw = 0.01; cmd.wishForward = 1; });

  const ce = s.clientGame.player;
  // 400 commands x 0.01 rad, integrated locally with nothing pulling it back.
  const expected = 400 * Math.fround(0.01);
  const err = Math.abs(ce.baseYaw - expected);
  if (err < 1e-3) ok(`local aim integrates purely from input (${err.toExponential(1)} rad from ideal after 400 commands)`);
  else bad('local aim is never corrected by the server',
    `baseYaw is ${err.toFixed(4)} rad from the pure integration — something is pulling the crosshair`);
}

{
  // A rejected shot must give its recoil back, and give back exactly what it took.
  const s = await makePredictedSession();
  const e = s.clientGame.player;
  const yaw0 = e.baseYaw, pitch0 = e.basePitch;

  const shot = { permanentYaw: 0.004, permanentPitch: 0.012, targetYaw: 0.02, targetPitch: 0.05 };
  e.baseYaw += shot.permanentYaw;
  e.basePitch += shot.permanentPitch;
  e.recoilYawTarget += shot.targetYaw;
  e.recoilPitchTarget += shot.targetPitch;
  s.pred.recordShot(42, shot);

  const rejected = s.pred.rejectShot(42);
  if (rejected) ok('a rejected shot is unwound');
  else bad('a rejected shot is unwound', 'rejectShot found nothing to undo');

  // Exact for the permanent fraction — that is the half that never decays, so there is no
  // excuse for approximating it.
  if (Math.abs(e.baseYaw - yaw0) < 1e-12 && Math.abs(e.basePitch - pitch0) < 1e-12) {
    ok('the permanent half of the recoil is returned exactly');
  } else {
    bad('the permanent recoil is returned exactly',
      `yaw off by ${(e.baseYaw - yaw0).toExponential(2)}, pitch by ${(e.basePitch - pitch0).toExponential(2)}`);
  }
  if (!s.pred.rejectShot(42)) ok('rejecting the same shot twice is a no-op');
  else bad('rejecting twice is a no-op', 'the recoil was subtracted a second time');
}

{
  // A correction must not re-fire the world. Replay re-runs ticks that already made their
  // noise once, so the presenter is swapped out — this is what Phase 1 built the port for.
  const s = await makePredictedSession({ latencyMs: 120 });
  let plays = 0;
  const realPresent = s.clientGame.present;
  s.clientGame.present = new Proxy(realPresent, {
    get(t, k) {
      if (k === 'play' || k === 'muzzleFlash') return () => { plays++; };
      return Reflect.get(t, k);
    },
  });
  runPredicted(s, 300, (cmd, t) => { cmd.wishForward = 1; cmd.fireHeld = t % 50 < 15; });

  if (s.pred.stats.replayedCommands > 0) {
    ok(`${s.pred.stats.replayedCommands} commands were replayed (so the silencing is exercised)`);
  } else {
    bad('replay happened at all', 'no commands were replayed, so this test proves nothing about silencing');
  }
  ok(`presentation fired ${plays} times across ${s.pred.stats.corrections} corrections`);
}

// ── a dropped snapshot must not poison the client's world ───────────────────────────
//
// Baselines used to be set optimistically the moment a snapshot was SENT, with no ack path
// and no keyframe ever re-sent. `decodeSnapshot` fills every field a delta omits from the
// baseline, so a client that never received that baseline filled them with ZERO: measured,
// one dropped snapshot produced a 36.9 m entity error and read the local player as
// `health 0, alive false`, and it never recovered. They are ack-driven now — the client
// already reports its newest received tick for the RTT estimate, so the ack is free.
{
  const s = await makeSession({ clients: 1, bots: 2 });
  const c = s.conns[0];

  run(s, 120, (cmd) => { cmd.wishForward = 1; });

  // Black out the DOWNSTREAM link for long enough to lose several snapshots, while the
  // client keeps sending. Upstream stays clean so the server still hears the (now stale)
  // acks.
  c.cT.setConditions({ loss: 1 });
  run(s, 60, (cmd) => { cmd.wishForward = 1; });
  c.cT.setConditions({ loss: 0 });
  run(s, 120, (cmd) => { cmd.wishForward = 1; });

  const wire = c.client.latestEntity(c.entity.id);
  if (!wire) {
    bad('the client still has a view of itself after a blackout', 'no entity in the newest snapshot');
  } else {
    const err = Math.hypot(wire.x - c.entity.position.x, wire.y - c.entity.position.y, wire.z - c.entity.position.z);
    if (err < 1) ok(`the client's world survives a snapshot blackout (${err.toFixed(3)} m off)`);
    else {
      bad("the client's world survives a snapshot blackout",
        `${err.toFixed(2)} m off — the delta was coded against a baseline the client never ` +
        'received, so every omitted field decoded as zero');
    }
    if (wire.health > 0 && (wire.flags & 1)) ok('and it does not read itself as dead at zero health');
    else bad('the client does not read itself as dead', `health ${wire.health}, flags ${wire.flags} — the classic all-fields-zero signature`);
  }

  const others = c.client.snapshots.at(-1)?.entities.filter((e) => e.id !== c.entity.id) ?? [];
  const sane = others.every((e) => e.health > 0 || !(e.flags & 1));
  if (sane) ok(`the other ${others.length} entities decode sanely too`);
  else bad('other entities decode sanely', JSON.stringify(others.map((e) => ({ id: e.id, h: e.health, f: e.flags }))));
}

console.log('\nlatency soak (80 ms RTT, 3% loss)');

{
  // The plan asks for this specifically, and the reason is worth stating: reconciliation
  // only runs when prediction is WRONG, so at 0 ms it never executes. Without a soak, the
  // single most intricate part of the netcode would be exercised by nothing until the
  // first real match — and single player, the mode played most, would be the mode that
  // tests it least.
  const s = await makePredictedSession({ latencyMs: 40, loss: 0.03, bots: 4, seed: 5150 });
  runPredicted(s, 2400, (cmd, t) => {
    cmd.wishForward = t % 180 < 110 ? 1 : -1;
    cmd.wishRight = t % 300 < 90 ? 1 : 0;
    cmd.deltaYaw = Math.sin(t / 40) * 0.015;
    cmd.fireHeld = t % 100 < 30;
    if (t % 260 === 0) cmd.jump = true;
    if (t % 400 === 0) cmd.crouchPressed = true;
  });

  const st = s.pred.stats;
  const drift = s.conns[0].entity.position.distanceTo(s.clientGame.player.position);

  // Grounded is the number that reflects controlled play. Airborne is reported, not
  // asserted tightly: a lost command near a ledge means the two simulations leave the
  // ground a tick apart, and from then on gravity — not input — decides how far apart
  // they get. Holding both to one bound would mean a meaningless threshold.
  if (st.worstErrorGrounded < 0.75) ok(`20 s soak: worst grounded error ${st.worstErrorGrounded.toFixed(3)} m`);
  else bad('the soak keeps grounded prediction tight',
    `worst grounded error ${st.worstErrorGrounded.toFixed(2)} m at ${JSON.stringify(st.worstLivingAt)}`);
  if (st.worstErrorAir < 6) ok(`worst airborne error ${st.worstErrorAir.toFixed(2)} m (gravity, not input)`);
  else bad('airborne divergence stays bounded', `${st.worstErrorAir.toFixed(2)} m`);

  if (st.corrections > 0) ok(`reconciliation actually ran (${st.corrections} corrections, ${st.replayedCommands} commands replayed)`);
  else bad('reconciliation is exercised by the soak',
    'zero corrections in 20 s at 40 ms one-way with 3% loss — the soak is not stressing anything');

  if (drift < 3) ok(`client and server finish ${drift.toFixed(2)} m apart after 2400 ticks`);
  else bad('client and server stay together over a soak', `${drift.toFixed(2)} m apart`);

  const upBytes = s.conns[0].sT.stats.bytesSent;
  const downBytes = s.conns[0].cT.stats.bytesSent;
  const secs = 2400 * FIXED_DT;
  ok(`bandwidth over the soak: up ${(upBytes / secs / 1024).toFixed(1)} KiB/s, down ${(downBytes / secs / 1024).toFixed(1)} KiB/s`);
}

console.log('\nround-trip estimation');

{
  // Lag compensation is only as good as the RTT it rewinds by, and `session.rttMs` was
  // never assigned in the first version — every shooter was rewound by the interpolation
  // delay alone and under-compensated by RTT/2. These check the estimate is both alive
  // and honest.
  const clean = await makeSession({ latencyMs: 0 });
  runPredictedLike(clean, 200);
  const rttClean = clean.conns[0].session.rttMs;
  if (rttClean < 25) ok(`a 0 ms link estimates a near-zero RTT (${rttClean.toFixed(1)} ms)`);
  else bad('a clean link estimates a low RTT', `${rttClean.toFixed(1)} ms`);

  const slow = await makeSession({ latencyMs: 60 });     // 120 ms round trip
  runPredictedLike(slow, 400);
  const rttSlow = slow.conns[0].session.rttMs;
  if (rttSlow > rttClean + 30) ok(`a 120 ms round trip is detected (${rttSlow.toFixed(1)} ms vs ${rttClean.toFixed(1)} ms)`);
  else bad('latency raises the RTT estimate', `${rttSlow.toFixed(1)} ms on a 120 ms link vs ${rttClean.toFixed(1)} ms clean`);

  // And it must decide how far the rewind goes, or the estimate is decoration.
  const backClean = slow.server.lag.viewTickFor(1000, rttClean, 100);
  const backSlow = slow.server.lag.viewTickFor(1000, rttSlow, 100);
  if (backSlow < backClean) ok(`a slower client is rewound further (${1000 - backSlow} vs ${1000 - backClean} ticks)`);
  else bad('RTT drives the rewind depth', 'both clients rewind the same distance');
}

{
  // `cmd.tick` is attacker-controlled, so the derived RTT is too. Uncapped, a client
  // claiming a two-second round trip could shoot people where they stood two seconds ago.
  const s = await makeSession();
  const sess = s.conns[0].session;
  for (let i = 0; i < 50; i++) {
    const cmd = emptyCommand();
    cmd.tick = 0;                       // "I last saw tick 0", however far in we are
    s.conns[0].client.sendCommand(cmd);
    s.conns[0].sT.pump(i * 8);
    s.server.tick();
  }
  if (sess.rttMs <= 250) ok(`a client claiming an ancient tick is capped at ${sess.rttMs.toFixed(0)} ms`);
  else bad('the claimed RTT is capped', `${sess.rttMs.toFixed(0)} ms — a client can buy an arbitrarily deep rewind`);
}

console.log('\nlag compensation');

{
  // The whole point, measured directly: a shooter fires at where a moving target APPEARS
  // to be on their screen — which is where it was RTT/2 + interpolation delay ago. Tested
  // against the present, that shot misses through no fault of the shooter's.
  //
  // Set up deliberately: a target strafing across the shooter's view, the shooter aiming
  // at the target's PAST position (what they can see), and the same shot judged with and
  // without the rewind.
  const { Game: G } = await import('../src/core/game.js');
  const { LagCompensation } = await import('../src/net/lagcomp.js');
  const { raycastEntities } = await import('../src/weapons/ballistics.js');
  const { Player } = await import('../src/player/player.js');

  const g = new G({ headless: true });
  await g.initHeadless({ presenter: new NullPresenter() });
  g.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 31337 });
  g.match.phase = 'live'; g.match.countdown = 0;

  const shooter = g.player;
  const target = new Player(g);
  await target.init();
  g.addEntity(target);
  target.team = shooter.team === 0 ? 1 : 0;
  target.alive = true;

  const lag = new LagCompensation(g);
  g.lagcomp = lag;

  // Put the shooter at the origin looking down -Z; walk the target across their view.
  shooter.position.set(0, 0, 0);
  shooter.setAngles(0, 0);
  shooter.alive = true;

  const TRACK = 40;                 // ticks of history to build
  const positions = [];
  for (let t = 0; t < TRACK; t++) {
    target.position.set(-2 + t * 0.1, 0, -10);   // 12 m/s across, left to right
    target._updateHitboxes();
    positions.push(target.position.clone());
    g.tick = t;
    lag.record();
  }

  // The shooter saw the target 20 ticks ago (~167 ms: 100 ms interpolation + 67 ms of
  // round trip) and aimed exactly there.
  const sawAtTick = TRACK - 1 - 20;
  const sawAt = positions[sawAtTick];
  const eye = shooter.position.clone(); eye.y += 1.6;
  const dir = sawAt.clone(); dir.y += 1.1; dir.sub(eye).normalize();

  // Present: the target has moved on, so the shot misses.
  const nowHit = raycastEntities(g, eye, dir, 100, shooter);
  // Rewound to what the shooter saw: it lands.
  let rewoundHit = null;
  lag.rewind(sawAtTick, shooter, () => { rewoundHit = raycastEntities(g, eye, dir, 100, shooter); });

  if (!nowHit) ok('without rewinding, a shot at where the target APPEARED to be misses');
  else bad('the scenario actually needs lag compensation',
    `the shot hit ${nowHit.part} even against the present — the target is not moving enough for this test to mean anything`);

  if (rewoundHit) ok(`rewinding to the shooter's view lands the shot (${rewoundHit.part})`);
  else bad('rewinding lands the shot', 'the shot missed even against the rewound world — the rewind is not restoring the right state');

  // And the world must be exactly as it was afterwards.
  const after = target.position.clone();
  if (after.distanceTo(positions[TRACK - 1]) < 1e-9) ok('the target is restored to the present after the rewind');
  else bad('the world is restored after a rewind', `target left at ${after.toArray().map((v) => v.toFixed(3))}`);
}

{
  // A rewind must restore even when the code inside it throws — otherwise one error
  // leaves every entity 100 ms in the past for the rest of the match, which is far worse
  // than the original fault.
  const { Game: G } = await import('../src/core/game.js');
  const { LagCompensation } = await import('../src/net/lagcomp.js');
  const g = new G({ headless: true });
  await g.initHeadless({ presenter: new NullPresenter() });
  g.startMatch({ mode: 'tdm', botCount: 2, difficulty: 'regular', seed: 5 });
  g.match.phase = 'live'; g.match.countdown = 0;
  const lag = new LagCompensation(g);
  for (let t = 0; t < 20; t++) { g._fixedUpdate(FIXED_DT); lag.record(); }

  const before = g.bots.bots.map((b) => b.position.clone());
  let threw = false;
  try {
    lag.rewind(g.tick - 10, g.player, () => { throw new Error('boom'); });
  } catch { threw = true; }
  const restored = g.bots.bots.every((b, i) => b.position.distanceTo(before[i]) < 1e-9);

  if (threw) ok('a throw inside a rewind propagates');
  else bad('a throw inside a rewind propagates', 'the error was swallowed');
  if (restored) ok('the world is still restored when the rewind body throws');
  else bad('the world is restored when the body throws', 'entities were left in the past');
}

{
  // Hitboxes are stored, not recomputed. `_updateHitboxes` runs only at the end of a LIVE
  // tick, so a rewind that restored a transform and recomputed would test the CURRENT
  // tick's box sizes against a rewound position — the trap flagged during Phase 3.
  const { Game: G } = await import('../src/core/game.js');
  const { LagCompensation } = await import('../src/net/lagcomp.js');
  const g = new G({ headless: true });
  await g.initHeadless({ presenter: new NullPresenter() });
  g.startMatch({ mode: 'tdm', botCount: 1, difficulty: 'regular', seed: 7 });
  g.match.phase = 'live'; g.match.countdown = 0;
  const lag = new LagCompensation(g);

  const bot = g.bots.bots[0];
  const sync = () => (bot._syncHitboxes ? bot._syncHitboxes() : bot._updateHitboxes());
  bot.height = 1.8; sync();
  g.tick = 100; lag.record();
  const tallTorso = bot.hitboxes[1].size.y;

  bot.height = 1.1; sync();      // crouched
  g.tick = 110; lag.record();
  const shortTorso = bot.hitboxes[1].size.y;

  if (Math.abs(tallTorso - shortTorso) > 1e-6) ok('standing and crouched hitboxes genuinely differ');
  else bad('the hitbox sizes differ with height', 'this test cannot detect anything');

  let rewoundSize = 0;
  lag.rewind(100, g.player, () => { rewoundSize = bot.hitboxes[1].size.y; });
  if (Math.abs(rewoundSize - tallTorso) < 1e-6) ok('a rewind restores the hitbox SIZES from that tick, not just the position');
  else bad('a rewind restores historical hitbox sizes', `got ${rewoundSize}, expected the standing ${tallTorso}`);
  if (Math.abs(bot.hitboxes[1].size.y - shortTorso) < 1e-6) ok('and puts the current sizes back afterwards');
  else bad('hitbox sizes are restored after a rewind', `left at ${bot.hitboxes[1].size.y}`);

  // EVERY box, not just the ones a Player happens to have. Bots carry a fourth (arms),
  // the widest part of the silhouette, and storing only three would leave it un-rewound:
  // shots at a moving bot's edge would behave differently from shots at its middle.
  // Checked by comparing each rewound box against the geometry the historical height
  // actually produces.
  bot.height = 1.8; sync();
  const wantBoxes = bot.hitboxes.map((x) => ({ oy: x.offset.y, sy: x.size.y }));
  bot.height = 1.1; sync();
  let mismatched = [];
  lag.rewind(100, g.player, () => {
    for (let i = 0; i < bot.hitboxes.length; i++) {
      const got = bot.hitboxes[i];
      if (Math.abs(got.offset.y - wantBoxes[i].oy) > 1e-5
        || Math.abs(got.size.y - wantBoxes[i].sy) > 1e-5) mismatched.push(i);
    }
  });
  if (mismatched.length === 0) ok(`all ${bot.hitboxes.length} hitboxes are rewound, not just the first three`);
  else bad('every hitbox is rewound', `boxes [${mismatched.join(',')}] kept their present geometry`);

  if (bot.hitboxes.length >= 4) ok(`the entity really has ${bot.hitboxes.length} hitboxes (so covering only 3 would be a live gap)`);
  else bad('the entity has more than 3 hitboxes', `only ${bot.hitboxes.length} — this check proves nothing`);
}

{
  // Rewinding further back than the ring holds must clamp, not read a wrapped slot: the
  // ring is only HISTORY_TICKS deep and a modulo on an older tick silently returns a
  // FUTURE sample, which would be worse than not rewinding at all.
  const { Game: G } = await import('../src/core/game.js');
  const { LagCompensation, HISTORY_TICKS } = await import('../src/net/lagcomp.js');
  const g = new G({ headless: true });
  await g.initHeadless({ presenter: new NullPresenter() });
  g.startMatch({ mode: 'tdm', botCount: 1, difficulty: 'regular', seed: 11 });
  g.match.phase = 'live'; g.match.countdown = 0;
  const lag = new LagCompensation(g);
  for (let t = 0; t < HISTORY_TICKS * 3; t++) { g._fixedUpdate(FIXED_DT); lag.record(); }

  const oldest = g.tick - (HISTORY_TICKS - 1);
  const clamped = lag._clampTick(g.tick - HISTORY_TICKS * 2);
  if (clamped === oldest) ok(`a rewind beyond the ring clamps to the oldest sample (tick ${clamped})`);
  else bad('a too-old rewind clamps', `got ${clamped}, expected ${oldest}`);
  if (lag._clampTick(g.tick + 50) === g.tick) ok('a rewind into the future clamps to now');
  else bad('a future rewind clamps to now', 'got a tick ahead of the simulation');
}

{
  // The view tick must account for BOTH halves of the delay. Leaving out the client's
  // interpolation delay under-rewinds by ~100 ms, which is most of the error.
  const { LagCompensation } = await import('../src/net/lagcomp.js');
  const lag = new LagCompensation({ tick: 1000, entities: [], match: null });
  const withInterp = lag.viewTickFor(1000, 60, 100);      // 30 ms + 100 ms = 130 ms = 15.6 ticks
  const withoutInterp = lag.viewTickFor(1000, 60, 0);
  if (withInterp === 1000 - 16) ok(`view tick accounts for RTT/2 and interpolation delay (${1000 - withInterp} ticks back)`);
  else bad('view tick accounts for both delays', `got ${1000 - withInterp} ticks back, expected 16`);
  if (withoutInterp - withInterp === 12) ok('the interpolation delay is the larger half at 60 ms RTT');
  else bad('the interpolation delay is accounted for', `only ${withoutInterp - withInterp} ticks of difference`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// Protocol v3 — the Bomb wire plus tactical ping (wire-protocol.md §8, bomb-rules.md §11)
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// Everything below asserts a SPECIFIC decoded value out of REAL bytes. "It encoded without
// throwing" is not a test of a wire format: a field written at the wrong offset, a bit packed
// into the wrong position and a reason index off by one all encode perfectly.

/** Assert two numbers are exactly equal, and say both when they are not. */
const eq = (name, got, want) => {
  if (got === want) ok(`${name} = ${JSON.stringify(got)}`);
  else bad(name, `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
};

/** A minimal wire entity: every field present, so a keyframe writes all of them. */
function wireEntity(id, over = {}) {
  const e = { id };
  for (const [name] of ENTITY_FIELDS) e[name] = 0;
  return Object.assign(e, over);
}

console.log('\nprotocol v4 — version and the append-only rule');

{
  // v4 (sector-interest.md §6): REFUSAL_REASONS gains 'off-sector' at index 5, covered by
  // scripts/sectortest.mjs rather than duplicated here.
  eq('PROTOCOL_VERSION', PROTOCOL_VERSION, 4);

  // §7 G3 / §9.2: the interact field is APPENDED. Its index IS its bit in the field mask, so
  // an insert anywhere before it silently reassigns the meaning of every later field on every
  // older client — which is the one wire mistake that cannot be noticed at runtime.
  const idx = ENTITY_FIELDS.findIndex(([n]) => n === 'interact');
  eq('interact is ENTITY_FIELDS index 16 (appended, not inserted)', idx, 16);
  eq('ENTITY_FIELDS length', ENTITY_FIELDS.length, 17);
  const before = ENTITY_FIELDS.slice(0, 16).map(([n]) => n).join(',');
  eq('the sixteen v1 entity fields kept their order and indices', before,
    'x,y,z,yaw,pitch,vx,vy,vz,health,armor,height,lean,flags,team,weaponIdx,ammo');

  // The event codes are the contract's numbers, checked by NAME against INDEX. Asserting
  // `EV_KINDS.length` alone would pass with the eleven kinds in any order.
  const wantCodes = {
    plantStart: 10, plantComplete: 11, plantCancel: 12,
    defuseStart: 13, defuseComplete: 14, defuseCancel: 15,
    bombDropped: 16, bombPickedUp: 17, bombDetonated: 18,
    roundStart: 19, interactRefused: 20,
  };
  const wrong = Object.entries(wantCodes).filter(([k, v]) => evCode(k) !== v);
  if (wrong.length === 0) ok('all eleven appended event kinds sit at their §8.7 codes (10-20)');
  else bad('appended event kinds are at their contract codes',
    wrong.map(([k, v]) => `${k} is ${evCode(k)}, contract says ${v}`).join('; '));
  eq('the first ten v1 event kinds are untouched', EV_KINDS.slice(0, 10).join(','),
    'hitmarker,kill,fire,damaged,death,respawn,explosion,blood,flash,roundEnd');
  eq('interactRefused is the last valid kind', EV_KINDS.length - 1, 20);
}

{
  // An OLD-FORMAT snapshot must still decode for the fields it had. This is the whole reason
  // §7 G3 says "appended, never inserted": a v1 server's bytes carry sixteen fields and a
  // 16-bit mask, and a v2 decoder has to read every one of them at the offset v1 wrote it.
  const V1_FIELDS = ENTITY_FIELDS.slice(0, 16);
  const SIZE = { f32: 4, u16: 2, u8: 1 };
  const src = {
    x: 1.5, y: 2.25, z: -3.75, yaw: 0.5, pitch: -0.25,
    vx: 4, vy: -5, vz: 6, health: 87, armor: 33,
    height: 1.8, lean: -0.5, flags: 0x21, team: 1, weaponIdx: 3, ammo: 29,
  };
  const buf = new ArrayBuffer(128);
  const v = new DataView(buf);
  v.setUint8(0, MSG_SNAPSHOT);
  v.setUint8(1, 1);                       // keyframe
  v.setUint32(2, 900, true);
  v.setUint32(6, 0, true);
  v.setUint32(10, 42, true);
  v.setUint32(14, 1, true);
  let o = 18;
  v.setUint32(o, 7, true); o += 4;
  v.setUint32(o, 0xffff, true); o += 4;   // sixteen bits set — a v1 encoder's full mask
  for (const [name, type] of V1_FIELDS) {
    if (type === 'f32') { v.setFloat32(o, src[name], true); o += 4; }
    else if (type === 'u16') { v.setUint16(o, src[name], true); o += 2; }
    else { v.setUint8(o, src[name]); o += 1; }
    void SIZE;
  }
  const snap = decodeSnapshot(buf.slice(0, o), null);
  const e = snap.entities[0];
  // f32 on the wire, so the expectation is the f32 of the value v1 wrote, not the float64.
  const mismatched = Object.keys(src).filter((k) => e[k] !== Math.fround(src[k]));
  if (mismatched.length === 0) {
    ok('a v1-format snapshot still decodes all sixteen of its fields exactly');
  } else {
    bad('an old-format snapshot decodes the fields it had',
      mismatched.map((k) => `${k}: got ${e[k]}, v1 wrote ${src[k]}`).join('; '));
  }
  eq('and the appended field defaults to 0 rather than reading past the frame', e.interact, 0);
  eq('the v1 entity id survives', e.id, 7);
  eq('the v1 tick survives', snap.tick, 900);

  // The v1 welcome is a strict PREFIX of the v2 one, which is the property that makes the
  // append safe. Its four fields must still come out at their v1 offsets.
  const w1 = new ArrayBuffer(WELCOME_BYTES_V1);
  const wv = new DataView(w1);
  wv.setUint8(0, MSG_WELCOME);
  wv.setUint32(1, 11, true);
  wv.setUint32(5, 22, true);
  wv.setUint32(9, 33333, true);
  wv.setUint16(13, 75, true);
  const oldW = decodeWelcome(w1);
  eq('v1 welcome: clientId', oldW.clientId, 11);
  eq('v1 welcome: entityId', oldW.entityId, 22);
  eq('v1 welcome: matchSeed', oldW.matchSeed, 33333);
  eq('v1 welcome: killLimit', oldW.killLimit, 75);
  eq('v1 welcome carries no version, and says so rather than guessing', oldW.protocolVersion, null);
}

console.log('\nprotocol v3 — the packed interact byte (§8.5)');

{
  // Bit boundaries, both ends of both fields. The packing is kind in bits 0-1 and progress in
  // bits 2-7, and every one of these round trips through a REAL delta-coded snapshot rather
  // than through packInteract's own inverse — decoding a value with the function that
  // produced it proves only that the pair is self-consistent.
  const cases = [
    ['none, 0', 0, 0], ['none, 63', 0, 63],
    ['plant, 0', 1, 0], ['plant, 1', 1, 1], ['plant, 62', 1, 62], ['plant, 63', 1, 63],
    ['defuse, 0', 2, 0], ['defuse, 63', 2, 63], ['defuse, 32', 2, 32],
  ];
  let allGood = true;
  for (const [label, kind, progress] of cases) {
    const byte = packInteract(kind, progress);
    const snap = { tick: 1, baseTick: 0, lastCommandSeq: 0, entities: [wireEntity(5, { interact: byte })], events: [] };
    const got = decodeSnapshot(encodeSnapshot(snap, null), null).entities[0].interact;
    const un = unpackInteract(got);
    if (got !== byte || un.kind !== kind || un.progress !== progress) {
      allGood = false;
      bad(`interact round trip (${label})`,
        `wire byte ${got} (sent ${byte}) decoded as kind ${un.kind} progress ${un.progress}`);
    }
  }
  if (allGood) ok(`all ${cases.length} interact kind/progress boundary vectors survive a snapshot round trip`);

  // The two ends of the six-bit field must be DIFFERENT bytes — a packing that dropped the
  // progress bits would pass a "0 stays 0" test on its own.
  if (packInteract(1, 0) !== packInteract(1, 63)) ok('progress 0 and 63 are genuinely different bytes');
  else bad('progress occupies bits 2-7', 'progress 0 and 63 packed identically — the bits are being discarded');
  eq('progress 63 packs into the top six bits', packInteract(0, 63), 0xfc);
  eq('defuse packs into bits 0-1', packInteract(2, 0), 0x02);
  eq('progress is clamped, not wrapped, at 64', unpackInteract(packInteract(1, 64)).progress, 63);

  // §8.11: kind 3 is reserved and is treated as 0. Never rendered.
  const reserved = unpackInteract(3 | (17 << 2));
  eq('a reserved interact kind decodes as none', reserved.kind, 0);
  eq('and is flagged as reserved rather than silently normal', reserved.reserved, true);
  eq('its progress is still readable', reserved.progress, 17);

  // §8.5: no new flag bit. Bit 7 of `flags` stays spare.
  const F = { ALIVE: 1, CROUCH: 2, SPRINT: 4, SLIDE: 8, FIRING: 16, ADS: 32, RELOAD: 64 };
  const used = Object.values(F).reduce((a, b) => a | b, 0);
  eq('flags bit 7 is still spare (no new flag bit was taken)', used & 0x80, 0);
}

console.log('\nprotocol v3 — appended event kinds (§8.7)');

{
  const events = [
    { kind: 'roundStart', entityId: 0, amount: 3 },
    { kind: 'plantStart', entityId: 41 },
    { kind: 'plantCancel', entityId: 41, reason: 'left-volume' },
    { kind: 'plantComplete', entityId: 41 },
    { kind: 'defuseStart', entityId: 77 },
    { kind: 'defuseCancel', entityId: 77, reason: 'died' },
    { kind: 'defuseComplete', entityId: 77 },
    { kind: 'bombPickedUp', entityId: 41 },
    { kind: 'bombDropped', entityId: 41, x: 12.5, y: 0.25, z: -8.75 },
    { kind: 'bombDetonated', entityId: 0, x: 3.5, y: 1.5, z: 2.5 },
    { kind: 'interactRefused', entityId: 41, requestedKind: 2, reason: 'already-planted' },
  ];
  const snap = { tick: 5, baseTick: 0, lastCommandSeq: 0, entities: [wireEntity(1)], events };
  const out = decodeSnapshot(encodeSnapshot(snap, null), null).events;

  eq('all eleven Bomb events survive the wire', out.length, 11);
  eq('kinds decode in order', out.map((e) => e.kind).join(','),
    'roundStart,plantStart,plantCancel,plantComplete,defuseStart,defuseCancel,defuseComplete,'
    + 'bombPickedUp,bombDropped,bombDetonated,interactRefused');

  eq('plantStart carries the actor as entityId', out[1].entityId, 41);
  eq('plantCancel reason index', out[2].reason, 1);
  eq('plantCancel reason name', out[2].reasonName, 'left-volume');
  eq('defuseCancel reason name', out[5].reasonName, 'died');

  // The two spatial Bomb kinds. `bombDropped` has to be state-complete on the wire: a client
  // that resyncs after it fired learns the position from MSG_MATCHSTATE, but the event still
  // has to say where the drop happened for the effect to land in the right place.
  const drop = out[8];
  if (drop.x === 12.5 && drop.y === 0.25 && drop.z === -8.75) ok('bombDropped carries its vec3 exactly');
  else bad('bombDropped carries a position', `(${drop.x}, ${drop.y}, ${drop.z})`);
  const det = out[9];
  if (det.x === 3.5 && det.y === 1.5 && det.z === 2.5) ok('bombDetonated carries its vec3 exactly');
  else bad('bombDetonated carries a position', `(${det.x}, ${det.y}, ${det.z})`);
  if (EV_SPATIAL.has('bombDropped') && EV_SPATIAL.has('bombDetonated')) {
    ok('both are cullable by distance (in EV_SPATIAL)');
  } else {
    bad('bombDropped and bombDetonated are distance-cullable', 'they are not in EV_SPATIAL');
  }
  if (!EV_SPATIAL.has('plantComplete')) ok('a plant is a fact about a round, not a place — not culled');
  else bad('non-spatial Bomb kinds are not culled', 'plantComplete is in EV_SPATIAL');

  // §8.7: a refusal is not a cancellation. It carries BOTH the requested kind and the reason,
  // because the facade needs `{ kind, reason }` and `amount` alone cannot produce both.
  const ref = out[10];
  eq('interactRefused requested kind (from flags bits 1-5)', ref.requestedKind, 2);
  eq('interactRefused requested kind name', ref.requestedKindName, 'defuse');
  eq('interactRefused reason index', ref.reason, 4);
  eq('interactRefused reason name', ref.reasonName, 'already-planted');
  eq('and its actor', ref.entityId, 41);
}

{
  // §8.11, both boundary vectors, spelled out because the comparison is `>=` and not `>`:
  // wire codes are zero-based indices into EV_KINDS, so the FIRST invalid code is
  // EV_KINDS.length. `>` let exactly that value through into EV_KINDS[code] — `undefined` —
  // at the decoder's untrusted-input boundary.
  const mk = (code) => {
    const buf = new ArrayBuffer(18 + 8 + 2 + 12);
    const v = new DataView(buf);
    v.setUint8(0, MSG_SNAPSHOT); v.setUint8(1, 1);
    v.setUint32(2, 1, true); v.setUint32(6, 0, true); v.setUint32(10, 0, true);
    v.setUint32(14, 0, true);                 // no entities
    let o = 18;
    v.setUint16(o, 1, true); o += 2;          // one event
    v.setUint8(o, code); o += 1;
    v.setUint8(o, 0); o += 1;
    v.setUint32(o, 99, true); o += 4;
    v.setUint32(o, 0, true); o += 4;
    v.setUint16(o, 0, true); o += 2;
    return buf.slice(0, o);
  };
  const last = decodeSnapshot(mk(20), null);
  eq('the LAST valid event code (20, interactRefused) decodes', last.events[0]?.kind, 'interactRefused');
  const first = decodeSnapshot(mk(EV_KINDS.length), null);
  eq(`the FIRST invalid event code (${EV_KINDS.length}) yields no event`, first.events.length, 0);
  eq('and the event block is abandoned rather than resynchronised onto garbage', first.truncatedEvents, true);
  const undef = first.events.some((e) => e.kind === undefined || e.kind === 'unknown');
  if (!undef) ok('no event with an undefined kind reaches a consumer');
  else bad('an out-of-range code never becomes an event', JSON.stringify(first.events));
}

console.log('\nprotocol v3 — MSG_MATCHSTATE (§8.6)');

{
  const full = {
    phase: 'planted', roundIndex: 9, localRole: 'defender',
    scoreAlpha: 6, scoreBravo: 5, phaseRemainingMs: 39900,
    aliveAlpha: 2, aliveBravo: 4,
    bombState: 'planted', bombCarrierId: 0, bombSite: 'B',
    interactActorId: 8181, interactProgress: 63, sideSwitched: true,
    serverTimeMs: 4000000000, bombPosition: { x: -12.5, y: 0.75, z: 44.25 },
  };
  const buf = encodeMatchState(full);
  eq('MSG_MATCHSTATE is exactly 41 bytes', buf.byteLength, MATCHSTATE_BYTES);
  eq('and it is tagged as one', new DataView(buf).getUint8(0), MSG_MATCHSTATE);
  const d = decodeMatchState(buf);
  eq('phase', d.phase, 'planted');
  eq('roundIndex', d.roundIndex, 9);
  eq('localRole', d.localRole, 'defender');
  eq('scoreAlpha', d.scoreAlpha, 6);
  eq('scoreBravo', d.scoreBravo, 5);
  eq('phaseRemainingMs (deciseconds on the wire)', d.phaseRemainingMs, 39900);
  eq('aliveAlpha', d.aliveAlpha, 2);
  eq('aliveBravo', d.aliveBravo, 4);
  eq('bombState', d.bombState, 'planted');
  eq('bombSite', d.bombSite, 'B');
  eq('interactActorId', d.interactActorId, 8181);
  eq('interactProgress', d.interactProgress, 63);
  eq('interactProgressFrac', d.interactProgressFrac, 1);
  eq('sideSwitched', d.sideSwitched, true);
  eq('serverTimeMs survives the top of the u32 range', d.serverTimeMs, 4000000000);
  eq('bombPositionVisible', d.bombPositionVisible, true);
  eq('bombX', d.bombPosition.x, -12.5);
  eq('bombY', d.bombPosition.y, 0.75);
  eq('bombZ', d.bombPosition.z, 44.25);

  // Null sentinels. `0` is never a valid entity id and `0` on an enum is always "none", so a
  // decoder never has to distinguish absent from zero.
  eq('carrier 0 decodes as null, not as entity 0', d.bombCarrierId, null);
  const noSite = decodeMatchState(encodeMatchState({ ...full, bombSite: null }));
  eq('site 0 decodes as null, not as site A', noSite.bombSite, null);

  // REQ-CC-036, the bug the contract calls out by name: a CARRIED bomb has no position of its
  // own, so the flag must be false even for an attacker who is always authorised for one that
  // exists. Feeding a position here is exactly what the old rule did, and it published a real
  // -looking position at the world origin.
  const carried = decodeMatchState(encodeMatchState({
    ...full, bombState: 'carried', bombCarrierId: 4242, bombPosition: { x: 1, y: 2, z: 3 },
  }));
  eq('a carried bomb reports no position however authorised the recipient is',
    carried.bombPositionVisible, false);
  eq('and the decoder exposes it as null, not as (0,0,0)', carried.bombPosition, null);
  eq('while the carrier id still comes through', carried.bombCarrierId, 4242);

  // The origin problem, stated directly (REQ-CC-030): (0,0,0) is a legal world position and
  // `map-data.md`'s canonical site is centred on it, so zeroes cannot mean "hidden".
  const atOrigin = decodeMatchState(encodeMatchState({
    ...full, bombState: 'dropped', bombPosition: { x: 0, y: 0, z: 0 },
  }));
  eq('a bomb genuinely at the origin is visible', atOrigin.bombPositionVisible, true);
  if (atOrigin.bombPosition && atOrigin.bombPosition.x === 0 && atOrigin.bombPosition.z === 0) {
    ok('and decodes as the origin rather than as absent');
  } else {
    bad('the origin is a real position', JSON.stringify(atOrigin.bombPosition));
  }
  const hidden = decodeMatchState(encodeMatchState({ ...full, bombState: 'dropped', bombPosition: null }));
  eq('a hidden bomb is not visible', hidden.bombPositionVisible, false);
  eq('and is null, which is a DIFFERENT decode from the origin above', hidden.bombPosition, null);

  // §8.11: enums out of range clamp to 0, and a wrong length is not state.
  const bent = encodeMatchState(full);
  new DataView(bent).setUint8(1, 200);
  eq('an out-of-range phase clamps to warmup', decodeMatchState(bent).phase, 'warmup');
  eq('a truncated match state is refused outright', decodeMatchState(bent.slice(0, 40)), null);
}

console.log('\nprotocol v3 — MSG_OUTCOME (§8.9)');

{
  const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
  eq('a ULID survives 16 raw bytes and back', ulidFromBytes(matchIdBytes(ULID)), ULID);
  eq('matchId is 16 bytes, not 26 characters', matchIdBytes(ULID).byteLength, 16);

  const o = decodeOutcome(encodeOutcome({
    scope: 'round', roundIndex: 4, winner: 'bravo', reason: 'defuse',
    terminationReason: 'completed', scoreAlpha: 2, scoreBravo: 3, roundsPlayed: 5,
    actorId: 909, matchId: ULID,
  }));
  eq('scope', o.scope, 'round');
  eq('roundIndex', o.roundIndex, 4);
  eq('winner', o.winner, 'bravo');
  eq('winnerTeam', o.winnerTeam, 'bravo');
  eq('reason', o.reason, 'defuse');
  eq('terminationReason', o.terminationReason, 'completed');
  eq('scoreAlpha', o.scoreAlpha, 2);
  eq('scoreBravo', o.scoreBravo, 3);
  eq('roundsPlayed', o.roundsPlayed, 5);
  eq('actorId (the defuser)', o.actorId, 909);
  eq('matchId round-trips through the wire', o.matchId, ULID);

  // REQ-CC-019. `winner: 0` is "no winner"; `winner: 3` is a draw. Collapsing them would make
  // every invalidated match look like a 6-6 tie in the results screen and in career stats.
  const draw = decodeOutcome(encodeOutcome({
    scope: 'match', winner: 'draw', reason: 'timer', terminationReason: 'completed',
    scoreAlpha: 6, scoreBravo: 6, roundsPlayed: 12, matchId: ULID,
  }));
  eq('a 6-6 finish is a draw', draw.winner, 'draw');
  eq('and its winnerTeam is "draw", not null', draw.winnerTeam, 'draw');
  const none = decodeOutcome(encodeOutcome({
    scope: 'match', winner: 'none', reason: 'no-contest', terminationReason: 'invalidated',
    scoreAlpha: 3, scoreBravo: 1, roundsPlayed: 4, matchId: ULID,
  }));
  eq('an invalidated match has no winner', none.winner, 'none');
  eq('and its winnerTeam is null, which is NOT "draw"', none.winnerTeam, null);
  eq('roundIndex 255 means "not applicable", not round 255', none.roundIndex, null);

  // §8.9's two bold rows: an ABORTED match can have a winner. A forfeit is the most common
  // abnormal ending and the remaining team earns the win.
  const forfeit = decodeOutcome(encodeOutcome({
    scope: 'match', winner: 'alpha', reason: 'forfeit', terminationReason: 'aborted',
    scoreAlpha: 4, scoreBravo: 2, roundsPlayed: 6, matchId: ULID,
  }));
  eq('an aborted match can still name a winner (forfeit)', forfeit.winnerTeam, 'alpha');
  eq('and stays aborted', forfeit.terminationReason, 'aborted');
}

console.log('\nprotocol v3 — the handshake (§8.2, §8.3, §8.4)');

{
  const h = decodeHello(encodeHello(2, 'st_abc123'));
  eq('hello: protocolVersion', h.protocolVersion, 2);
  eq('hello: ticket', h.ticket, 'st_abc123');
  eq('an empty ticket is an empty string, not null', decodeHello(encodeHello(2, '')).ticket, '');
  // The declared ticket length is attacker-controlled; a short frame claiming 255 bytes must
  // not read whatever follows it in memory.
  const lying = encodeHello(2, 'abcd');
  new DataView(lying).setUint8(3, 255);
  eq('a hello whose declared length does not match the frame is refused', decodeHello(lying), null);
  eq('a 3-byte hello is refused rather than read', decodeHello(new ArrayBuffer(3)), null);

  const r = decodeReject(encodeReject('PROTOCOL_VERSION_MISMATCH', 2));
  eq('reject: reason', r.reason, 'PROTOCOL_VERSION_MISMATCH');
  eq('reject: the server\'s own version rides along', r.serverVersion, 2);

  const w = decodeWelcome(encodeWelcome({
    clientId: 3, entityId: 44, matchSeed: 987654, killLimit: 0,
    protocolVersion: 2, mode: 'bomb', flags: 1, serverTickRateHz: 120,
  }));
  eq('v2 welcome is 21 bytes', encodeWelcome({}).byteLength, WELCOME_BYTES_V2);
  eq('welcome: clientId', w.clientId, 3);
  eq('welcome: entityId', w.entityId, 44);
  eq('welcome: matchSeed', w.matchSeed, 987654);
  eq('welcome: protocolVersion', w.protocolVersion, 2);
  eq('welcome: mode', w.mode, 'bomb');
  eq('welcome: isReconnect (flags bit 0)', w.isReconnect, true);
  eq('welcome: isSpectator (flags bit 1)', w.isSpectator, false);
  eq('welcome: serverTickRateHz', w.serverTickRateHz, 120);
  // REQ-CC-021: `RoomSettings` says `null` and a u16 cannot. `normalizeKillLimit` clamps to 1,
  // so 0 is unambiguous — but only a decoder that knows the rule can apply it.
  eq('killLimit 0 in Bomb decodes as null, not as a limit of zero', w.killLimit, null);
  const tdm = decodeWelcome(encodeWelcome({ mode: 'tdm', killLimit: 75, protocolVersion: 2 }));
  eq('and a TDM kill limit is left alone', tdm.killLimit, 75);
}

{
  // The rejection, over a real transport, decoded from the bytes the client actually received.
  const s = await makeSession();
  const c = s.conns[0];
  const sess = c.session;
  const raw = [];
  // Tap the wire ahead of the client so the assertions are about BYTES, not about what
  // NetClient chose to remember.
  c.cT.onMessage((d) => { raw.push(d.slice(0)); c.client._onMessage(d); });

  c.cT.send(encodeHello(PROTOCOL_VERSION - 1, 'st_old_client'));
  c.sT.pump(0);            // deliver client -> server
  c.cT.pump(0);            // deliver server -> client

  const rejectFrame = raw.find((b) => new DataView(b).getUint8(0) === MSG_REJECT);
  if (!rejectFrame) {
    bad('an incompatible client is rejected at handshake',
      `no MSG_REJECT on the wire — frames were [${raw.map((b) => new DataView(b).getUint8(0)).join(',')}]`);
  } else {
    const dec = decodeReject(rejectFrame);
    eq('the rejection reason on the wire', dec.reason, 'PROTOCOL_VERSION_MISMATCH');
    eq('and it names the server\'s version so the client can say which build to get',
      dec.serverVersion, PROTOCOL_VERSION);
  }
  eq('the session is gone — no entity is left driving', s.server.clients.size, 0);
  eq('the client knows it was rejected', c.client.rejected?.reason, 'PROTOCOL_VERSION_MISMATCH');
  eq('and it forgets its entity rather than carrying on', c.client.entityId, 0);

  // The upgrade message itself. §8.3's whole reason for putting the server's version in the
  // reject frame is that the client can then say WHICH way the mismatch runs — "reload" and
  // "try another server" are opposite instructions and giving the wrong one wastes the
  // player's time. Both directions, since a bare "versions differ" would pass either way.
  const newer = upgradeMessage(5, 2);
  const older = upgradeMessage(1, 2);
  if (/v5/.test(newer) && /update|reload/i.test(newer)) ok(`a newer server says to update: "${newer}"`);
  else bad('a newer server produces an update message', newer);
  if (/v1/.test(older) && /another server/i.test(older)) ok(`an older server says to go elsewhere: "${older}"`);
  else bad('an older server produces a different message', older);
  if (newer !== older) ok('the two directions are genuinely different messages');
  else bad('the upgrade message distinguishes the two directions', 'both read the same');

  // A frame already in flight from a rejected peer must be dropped UNREAD. That peer is by
  // definition the one whose bytes we do not agree about.
  const late = emptyCommand();
  late.seq = 99;
  s.server._onMessage(sess, encodeCommands([late]));
  eq('a late frame from a rejected client is counted and dropped', sess.stats.rejectedMessages, 1);
  eq('and never reaches the command queue', sess.queue.length, 0);
}

{
  // The green half. A matching version is accepted and the welcome carries v2.
  const s = await makeSession();
  const c = s.conns[0];
  const raw = [];
  c.cT.onMessage((d) => { raw.push(d.slice(0)); c.client._onMessage(d); });

  c.cT.send(encodeHello(PROTOCOL_VERSION, 'st_good_client'));
  c.sT.pump(0);
  c.cT.pump(0);

  const rejected = raw.some((b) => new DataView(b).getUint8(0) === MSG_REJECT);
  if (!rejected) ok('a matching version is not rejected');
  else bad('a matching version is accepted', 'the server rejected a client speaking its own version');
  eq('the connection survives', s.server.clients.size, 1);
  eq('the server retains the decoded ticket after the admission gate', c.session.ticket, 'st_good_client');
  eq('the welcome names the negotiated version', c.client.welcome?.protocolVersion, PROTOCOL_VERSION);
  eq('and the server tick rate', c.client.welcome?.serverTickRateHz, 120);
  eq('the client was not rejected', c.client.rejected, null);
  eq('and it knows which entity it drives', c.client.entityId, c.entity.id);
}

{
  // The other direction: a v1 SERVER. It sends 15 bytes and no version at all, which is not
  // "unknown, carry on" — it is a server that cannot describe the fields this build reads.
  const [cT, sT] = createLoopbackPair();
  const client = new NetClient(cT);
  const w1 = new ArrayBuffer(WELCOME_BYTES_V1);
  const v = new DataView(w1);
  v.setUint8(0, MSG_WELCOME);
  v.setUint32(1, 1, true);
  v.setUint32(5, 5, true);
  v.setUint32(9, 7, true);
  v.setUint16(13, 75, true);
  sT.send(w1);
  cT.pump(0);
  eq('a v1 server is refused by the client', client.rejected?.reason, 'PROTOCOL_VERSION_MISMATCH');
  eq('the client records which version the server speaks', client.rejected?.serverVersion, 1);
  eq('and never adopts an entity from it', client.entityId, 0);
}

console.log('\nprotocol v3 — the per-recipient bomb-position filter (§8.6, §8.8, bomb-rules §13.3)');

{
  // bomb-rules §13.3 rewrote this filter's POLICY: a dropped bomb is the NEUTRAL shared
  // objective, and its position is served to every recipient on a team — line of sight no
  // longer gates it. Proved the same way the old policy was: by decoding the bytes each
  // recipient actually receives. The blind/seeing distinction is kept in the fixture so
  // this test still proves LOS is NOT the filter (both get the coordinates).
  const s = await makeSession({ clients: 3 });
  const [A, B, C] = s.conns;
  const g = s.game;

  // Find a bomb position, a viewpoint that CANNOT see it, and one that CAN. Probed against
  // the real world rather than hard-coded, so a map change makes this test say so instead of
  // quietly measuring nothing.
  const sp = g.world.spawnPoints.map((p) => p.position ?? p);
  const BOMB = { x: sp[0].x, y: sp[0].y + 0.3, z: sp[0].z };
  const eyeH = A.entity.eyeHeight ?? 1.6;
  let blind = null, seeing = null;
  for (let i = 1; i < sp.length; i++) {
    const clear = g.world.losClear({ x: sp[i].x, y: sp[i].y + eyeH, z: sp[i].z }, BOMB);
    if (clear && !seeing) seeing = sp[i];
    if (!clear && !blind) blind = sp[i];
  }
  if (!blind || !seeing) {
    bad('the map offers both a blocked and a clear sightline to the bomb',
      `blocked=${!!blind} clear=${!!seeing} — this test cannot distinguish anything`);
  }

  const place = (conn, p, team) => {
    conn.entity.position.set(p.x, p.y, p.z);
    conn.entity.team = team;
    conn.entity.alive = true;
  };
  place(A, sp[2], 0);                 // attacker: authorised by role, wherever they stand
  place(B, blind ?? sp[1], 1);        // defender who cannot see the drop
  place(C, seeing ?? sp[1], 1);       // defender who can

  const m = g.match;
  m.modeId = 'bomb';
  m.roundIndex = 4;
  m.scores = [3, 2];
  m.aliveCounts = { alpha: 3, bravo: 2 };
  m.phaseRemainingMs = 71500;
  m.sideSwitched = false;
  m.attackingTeam = 0;
  m.phase = 'live';
  m.bomb = { state: 'dropped', carrierId: 0, siteId: null, position: BOMB };
  m.interaction = { kind: 'none', actorId: 0, progress: 0 };

  // Tap all three wires, then let the server produce one broadcast.
  const taps = [A, B, C].map((conn) => {
    const frames = [];
    conn.cT.onMessage((d) => { frames.push(d.slice(0)); conn.client._onMessage(d); });
    return frames;
  });
  s.server._broadcastMatchState();
  for (const conn of [A, B, C]) conn.cT.pump(0);

  const stateOf = (frames) => frames.find((b) => new DataView(b).getUint8(0) === MSG_MATCHSTATE);
  const [fa, fb, fc] = taps.map(stateOf);

  if (!fa || !fb || !fc) {
    bad('every client received a match state', `attacker=${!!fa} blindDefender=${!!fb} seeingDefender=${!!fc}`);
  } else {
    const da = decodeMatchState(fa);
    const db = decodeMatchState(fb);
    const dc = decodeMatchState(fc);

    // Every recipient agrees about the PUBLIC facts.
    eq('both teams agree on the phase', db.phase, da.phase);
    eq('...on the round index', db.roundIndex, 4);
    eq('...on the scores', `${db.scoreAlpha}-${db.scoreBravo}`, '3-2');
    eq('...on the alive counts', `${db.aliveAlpha}/${db.aliveBravo}`, '3/2');
    eq('...and on the bomb STATE', db.bombState, 'dropped');
    // This is a STAGED pre-2.0.0 frame (a TDM match wearing `modeId: 'bomb'`), so the
    // legacy role vocabulary still round-trips; a real 2.0.0 ruleset serves 'none'.
    eq('a staged pre-2.0.0 frame still round-trips the team-0 role', da.localRole, 'attacker');
    eq('...and the team-1 role', db.localRole, 'defender');

    // §13.3 — the policy itself: the dropped bomb is the shared neutral objective, and
    // its coordinates reach EVERY team recipient, sightline or not.
    const sees = (d, who) => {
      if (d.bombPositionVisible === true && d.bombPosition
        && Math.abs(d.bombPosition.x - BOMB.x) < 1e-3
        && Math.abs(d.bombPosition.y - BOMB.y) < 1e-3
        && Math.abs(d.bombPosition.z - BOMB.z) < 1e-3) {
        ok(`${who} is served the real dropped-bomb coordinates (§13.3)`);
      } else {
        bad(`${who} is served the dropped bomb`, JSON.stringify(d.bombPosition));
      }
    };
    sees(da, 'a team-0 player');
    sees(db, 'a team-1 player with NO sightline — LOS no longer gates the neutral objective');
    sees(dc, 'a team-1 player with a sightline');

    // And the two teams' frames differ ONLY where they should: the localRole byte (a
    // staged-frame artefact), never the coordinates.
    const ba = new Uint8Array(fa);
    const bb = new Uint8Array(fb);
    let differsOutsideRole = -1;
    for (let i = 0; i < MATCHSTATE_BYTES; i++) {
      if (ba[i] !== bb[i] && i !== 3) { differsOutsideRole = i; break; }
    }
    if (differsOutsideRole < 0) ok('the two teams receive byte-identical bomb facts — a symmetric objective is symmetric on the wire');
    else bad('the two teams receive the same bomb facts', `frames differ at byte ${differsOutsideRole}`);
  }
}

{
  // §8.8, the carrier — the same filter on a different field, plus REQ-CC-036: a CARRIED bomb
  // has no position, so even the attackers who are always authorised must be told nothing.
  const s = await makeSession({ clients: 3 });
  const [A, B, C] = s.conns;
  const g = s.game;
  const sp = g.world.spawnPoints.map((p) => p.position ?? p);
  const eyeH = A.entity.eyeHeight ?? 1.6;
  const CARRIER_AT = sp[0];
  const chest = { x: CARRIER_AT.x, y: CARRIER_AT.y + eyeH, z: CARRIER_AT.z };
  let blind = null, seeing = null;
  for (let i = 1; i < sp.length; i++) {
    const clear = g.world.losClear({ x: sp[i].x, y: sp[i].y + eyeH, z: sp[i].z }, chest);
    if (clear && !seeing) seeing = sp[i];
    if (!clear && !blind) blind = sp[i];
  }

  const place = (conn, p, team) => {
    conn.entity.position.set(p.x, p.y, p.z);
    conn.entity.team = team;
    conn.entity.alive = true;
  };
  place(A, CARRIER_AT, 0);            // the carrier, an attacker
  place(B, blind ?? sp[1], 1);        // an enemy who cannot see them
  place(C, seeing ?? sp[1], 1);       // an enemy who can

  const m = g.match;
  m.modeId = 'bomb';
  m.roundIndex = 1;
  m.scores = [0, 0];
  m.aliveCounts = { alpha: 1, bravo: 2 };
  m.phaseRemainingMs = 100000;
  m.attackingTeam = 0;
  m.phase = 'live';
  // A carried bomb's position is the carrier's — `bomb.position` stays null in this state.
  m.bomb = { state: 'carried', carrierId: A.entity.id, siteId: null, position: null };
  m.interaction = { kind: 'plant', actorId: A.entity.id, progress: 0.5 };

  const taps = [A, B, C].map((conn) => {
    const frames = [];
    conn.cT.onMessage((d) => { frames.push(d.slice(0)); conn.client._onMessage(d); });
    return frames;
  });
  s.server._broadcastMatchState();
  for (const conn of [A, B, C]) conn.cT.pump(0);
  const pick = (f) => decodeMatchState(f.find((b) => new DataView(b).getUint8(0) === MSG_MATCHSTATE));
  const [da, db, dc] = taps.map(pick);

  eq('a teammate always sees the carrier', da.bombCarrierId, A.entity.id);
  eq('an enemy with no sightline gets null, not the carrier', db.bombCarrierId, null);
  eq('an enemy who can see them gets the id', dc.bombCarrierId, A.entity.id);
  eq('everyone still learns the bomb is carried', db.bombState, 'carried');
  // Step 1 of §8.6's encoder invariant, which is the step that was missing.
  eq('a carried bomb has no position, even for the carrier themselves', da.bombPositionVisible, false);
  eq('and the decoder says null rather than the world origin', da.bombPosition, null);
  // Objective progress is public, and it is the six-bit wire quantity all the way through.
  eq('objective progress is on the wire for both sides', db.interactProgress, Math.round(0.5 * INTERACT_PROGRESS_MAX));
  eq('and names its actor', db.interactActorId, A.entity.id);
}

{
  // The change test covers the TAIL of the frame, not just the public head.
  //
  // bomb-rules §13.3 made the dropped bomb team-public, so walking into sight no longer
  // changes anything — the coordinates were never withheld. What still exercises the tail
  // bytes is the bomb MOVING: same phase, same scores, same bomb state, only the three
  // coordinate floats change. A change test that ignored the tail of the frame would
  // suppress that send and the marker would freeze on a stale spot.
  const s = await makeSession({ clients: 1 });
  const c = s.conns[0];
  const g = s.game;
  const sp = g.world.spawnPoints.map((p) => p.position ?? p);
  const BOMB = { x: sp[0].x, y: sp[0].y + 0.3, z: sp[0].z };
  const eyeH = c.entity.eyeHeight ?? 1.6;
  let blind = null, seeing = null;
  for (let i = 1; i < sp.length; i++) {
    const clear = g.world.losClear({ x: sp[i].x, y: sp[i].y + eyeH, z: sp[i].z }, BOMB);
    if (clear && !seeing) seeing = sp[i];
    if (!clear && !blind) blind = sp[i];
  }
  const m = g.match;
  m.modeId = 'bomb';
  m.phase = 'live';
  m.roundIndex = 0;
  m.scores = [0, 0];
  m.aliveCounts = { alpha: 1, bravo: 1 };
  m.phaseRemainingMs = 100000;
  m.attackingTeam = 0;
  m.bomb = { state: 'dropped', carrierId: 0, siteId: null, position: BOMB };
  m.interaction = { kind: 'none', actorId: 0, progress: 0 };
  c.entity.team = 1;                    // §13.3: either team is served the neutral drop
  c.entity.alive = true;

  c.entity.position.set(blind.x, blind.y, blind.z);
  for (let i = 0; i < 5; i++) { s.server._broadcastMatchState(); c.cT.pump(0); }
  eq('a team viewer with NO sightline is served the neutral drop (§13.3)', c.client.matchState?.bombPositionVisible, true);
  const sentWhileBlind = c.session.stats.matchStates;
  eq('and is told it once, not every tick', sentWhileBlind, 1);

  // Walking into sight now changes NOTHING — the coordinates were never withheld.
  c.entity.position.set(seeing.x, seeing.y, seeing.z);
  s.server._broadcastMatchState();
  c.cT.pump(0);
  eq('walking into sight resends nothing — sight no longer gates the neutral objective', c.session.stats.matchStates, sentWhileBlind);

  // The bomb MOVING is the change confined to the tail bytes.
  m.bomb = { state: 'dropped', carrierId: 0, siteId: null, position: { x: BOMB.x + 2, y: BOMB.y, z: BOMB.z } };
  s.server._broadcastMatchState();
  c.cT.pump(0);
  eq('the bomb moving sends a new frame at once', c.session.stats.matchStates, sentWhileBlind + 1);
  if (c.client.matchState?.bombPosition
    && Math.abs(c.client.matchState.bombPosition.x - (BOMB.x + 2)) < 1e-3) {
    ok('with the real coordinates — the change was in the tail of the frame, and was still noticed');
  } else {
    bad('a change confined to the position bytes is detected',
      `bombPosition ${JSON.stringify(c.client.matchState?.bombPosition)}`);
  }
}

{
  // "On change only" (§8.6), with the one honest exception: `serverTimeMs` changes every tick
  // by construction, so a naive change test would send this 120 times a second and defeat its
  // own purpose. The clock is excluded from the test and carried by a heartbeat instead.
  const s = await makeSession({ clients: 1 });
  const c = s.conns[0];
  const g = s.game;
  c.entity.team = 0;
  c.entity.alive = true;
  const m = g.match;
  m.modeId = 'bomb';
  m.phase = 'live';
  m.roundIndex = 0;
  m.scores = [0, 0];
  m.aliveCounts = { alpha: 1, bravo: 1 };
  m.phaseRemainingMs = 100000;
  m.attackingTeam = 0;
  m.bomb = { state: 'carried', carrierId: c.entity.id, siteId: null, position: null };
  m.interaction = { kind: 'none', actorId: 0, progress: 0 };

  for (let i = 0; i < 60; i++) { s.server._broadcastMatchState(); c.cT.pump(0); }
  const afterSteady = c.session.stats.matchStates;
  eq('an unchanged match state is sent once, not once per tick', afterSteady, 1);

  m.bomb = { state: 'planted', carrierId: 0, siteId: 'A', position: { x: 5, y: 1, z: 5 } };
  m.phase = 'planted';
  s.server._broadcastMatchState();
  c.cT.pump(0);
  eq('a change is sent immediately', c.session.stats.matchStates, 2);
  eq('and the client decoded the new state', c.client.matchState?.bombState, 'planted');
  eq('with its site', c.client.matchState?.bombSite, 'A');

  for (let i = 0; i < 121; i++) { s.server._broadcastMatchState(); c.cT.pump(0); }
  if (c.session.stats.matchStates > 2) {
    ok(`the clock heartbeat still goes out while nothing changes (${c.session.stats.matchStates} frames over 182 ticks)`);
  } else {
    bad('the server clock keeps arriving during a quiet phase',
      'no heartbeat — a client joining mid-round would age one clock sample for the whole round');
  }
  if (c.session.stats.matchStates < 20) ok('and it is a heartbeat, not a per-tick resend');
  else bad('the heartbeat is rare', `${c.session.stats.matchStates} frames in 182 ticks`);
}

{
  // TDM must be untouched. `MSG_MATCHSTATE` on a TDM stream would be 41 bytes of zeroes,
  // several times a second, describing a mode that has no rounds and no bomb.
  const s = await makeSession({ clients: 1 });
  run(s, 60, (cmd) => { cmd.wishForward = 1; });
  eq('a TDM match sends no MSG_MATCHSTATE at all', s.conns[0].session.stats.matchStates, 0);
  eq('and the client has no bomb state to render', s.conns[0].client.matchState, null);
  eq('the TDM welcome still carries its kill limit', s.conns[0].client.killLimit > 0, true);
}

console.log('\nprotocol v3 — objective evidence (match-result.md §7)');

{
  const s = await makeSession({ clients: 1 });
  const c = s.conns[0];
  const g = s.game;
  c.entity.team = 0;
  c.entity.alive = true;
  g.match.modeId = 'bomb';
  g.match.roundIndex = 3;
  g.match.phase = 'live';
  g.tick = 1200;
  s.server.evidence.identify({ matchId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', rulesetVersion: 'bomb-1.0.0', serverBuild: 'test' });

  const planter = c.entity.id;
  s.server.objectiveEvent({ kind: 'roundStart', roundIndex: 3 });
  s.server.objectiveEvent({
    kind: 'plantStart', actorId: planter, actorTeam: 0, site: 'A',
    position: { x: 10.123456, y: 0.5, z: -4.25 }, progress: 0,
  });
  g.tick = 1560;
  s.server.objectiveEvent({
    kind: 'plantComplete', actorId: planter, actorTeam: 0, site: 'A',
    position: { x: 10.123456, y: 0.5, z: -4.25 }, progress: 1,
  });
  s.server.objectiveEvent({
    kind: 'interactRefused', actorId: planter, actorTeam: 0,
    requestedKind: 1, reason: 'already-planted',
  });
  s.server.objectiveEvent({ kind: 'nonsense', actorId: planter });

  const ev = s.server.evidence;
  eq('every objective fact is recorded, and nothing else is', ev.rows.length, 4);
  eq('an unknown kind is refused rather than stored as "unknown"', ev.of('nonsense').length, 0);

  const plant = ev.of('plantComplete')[0];
  eq('the completion names its actor', plant.actorId, planter);
  eq('and their side, by name', plant.actorTeam, 'alpha');
  eq('and the site', plant.site, 'A');
  eq('and the round it belongs to', plant.roundIndex, 3);
  eq('and the tick it happened on', plant.tick, 1560);
  eq('and the server clock, in the domain §8.10 calls server-monotonic',
    plant.serverTimeMs, Math.round(1560 * FIXED_DT * 1000));
  eq('the position is unfiltered — evidence is not a per-recipient view', plant.position.x, 10.123);
  eq('progress is the same six-bit quantity the wire carries', plant.progress, INTERACT_PROGRESS_MAX);

  // §10 of bomb-rules: `plants` counts COMPLETIONS only. The evidence has to make that
  // countable without re-deriving it, or two services will count it two ways.
  eq('a start is not a completion', ev.of('plantStart').length, 1);
  eq('and the authoritative plant count is the completions', ev.of('plantComplete').length, 1);

  const refusal = ev.of('interactRefused')[0];
  eq('a refusal records what was asked for', refusal.requestedKind, 1);
  eq('and why it was refused', refusal.reason, 'already-planted');

  eq('the record is ordered', ev.rows.map((r) => r.seq).join(','), '0,1,2,3');
  eq('and identifies the match it reconstructs', ev.toJSON().matchId, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
  eq('and the ruleset that produced it', ev.toJSON().rulesetVersion, 'bomb-1.0.0');
  eq('and the wire version it was recorded under', ev.toJSON().protocolVersion, PROTOCOL_VERSION);
  eq('one round\'s rows are retrievable as a unit', ev.forRound(3).length, 4);
  eq('and a round that never happened yields none, not everything', ev.forRound(9).length, 0);

  // The same call put the events on the wire. One ingestion point, so the timeline a review
  // reads and the timeline a player saw can never describe different rounds.
  run(s, 8, () => {});
  const kinds = c.client.snapshots.flatMap((sn) => sn.events).map((e) => e.kind);
  if (kinds.includes('plantComplete')) ok('the same objective facts reached the client as wire events');
  else bad('objective events reach the wire', `client saw [${[...new Set(kinds)].join(',')}]`);
  const gotRefusal = c.client.snapshots.flatMap((sn) => sn.events).find((e) => e.kind === 'interactRefused');
  if (gotRefusal) {
    eq('the refusal reached its target with the reason intact', gotRefusal.reasonName, 'already-planted');
    eq('and the kind they asked for', gotRefusal.requestedKindName, 'plant');
  } else {
    bad('a refusal is delivered to the refused player', 'no interactRefused event arrived');
  }
}

{
  // A refusal is private (§8.7): "sent only to the refused player". Broadcasting it announces
  // who is standing on a site trying to plant.
  const s = await makeSession({ clients: 2 });
  const [me, other] = s.conns;
  s.server.objectiveEvent({
    kind: 'interactRefused', actorId: me.entity.id, requestedKind: 1, reason: 'wrong-phase',
  });
  run(s, 8, () => {});
  const mine = me.client.snapshots.flatMap((sn) => sn.events).filter((e) => e.kind === 'interactRefused');
  const theirs = other.client.snapshots.flatMap((sn) => sn.events).filter((e) => e.kind === 'interactRefused');
  eq('the refused player is told', mine.length, 1);
  eq('and nobody else is', theirs.length, 0);
}


// ══════════════════════════════════════════════════════════════════════════════════════
// protocol v3 — driven by the REAL ruleset, and scanned on EVERY frame
//
// Everything below answers the same two lessons from the P3.A4 review:
//
//   1. **Scan every frame the recipient receives, not one message type.** The bomb-position
//      filter above was proved by decoding `MSG_MATCHSTATE` and nothing else, and the
//      coordinates were leaving in the snapshot's event block the whole time.
//   2. **Never assert against a shape the test invented.** The objective tests hand-fed
//      `{ actorId, position, requestedKind }`; `src/game/bomb.js` emits
//      `{ entityId, x, y, z, requested }`. Both sides stayed green while agreeing about
//      nothing, and four fields reached the wire erased.
// ══════════════════════════════════════════════════════════════════════════════════════

/**
 * Every float32 in a frame, at EVERY byte offset — not at the offsets a layout says.
 *
 * A leak does not have to be in the field it belongs to. This is the only form of the
 * question that cannot be satisfied by a decoder which hides a value it was nonetheless
 * sent, or by an encoder that writes the truth somewhere the reader was not looking.
 */
function scanFloats(frame, wanted) {
  const dv = new DataView(frame);
  const hits = [];
  for (let o = 0; o + 4 <= frame.byteLength; o++) {
    const f = dv.getFloat32(o, true);
    if (wanted.some((w) => Object.is(f, w))) hits.push(`type=${dv.getUint8(0)} offset=${o} f32=${f}`);
  }
  return hits;
}

/** The same scan across every frame a recipient received, in order. */
const scanAll = (frames, wanted) => frames.flatMap((f) => scanFloats(f, wanted));

/** A real Bomb match, its real ruleset, and a real `GameServer` over it. */
async function makeBombSession({ bots = 7, seed = 20260819 } = {}) {
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter() });
  game.startMatch({ mode: 'bomb', botCount: bots, seed });
  game.match.phase = 'live';
  game.match.countdown = 0;
  const server = new GameServer(game);
  // Through the ruleset's own freeze, by ticking the real server.
  let guard = 0;
  while (game.match.bombRules.phase !== 'live' && guard++ < 4000) server.tick();
  return { game, server, rules: game.match.bombRules, conns: [] };
}

/** Attach a client to an existing entity, handshake included, and tap every frame it gets. */
function attach(s, entity, label = 'x') {
  const [cT, sT] = createLoopbackPair({});
  const session = s.server.addClient(sT, entity);
  const client = new NetClient(cT);
  s.server._onMessage(session, encodeHello(PROTOCOL_VERSION, `st_${label}`));
  const frames = [];
  cT.onMessage((d) => { frames.push(d.slice(0)); client._onMessage(d); });
  cT.pump(0);
  const conn = { client, session, cT, sT, entity, frames, label };
  s.conns.push(conn);
  return conn;
}

/**
 * bomb-rules §13.2: the bomb now spawns NEUTRAL (`dropped`, carrier -1) at the map's
 * neutral point — no round starts with a carrier. Tests that need one stage it, the same
 * fixture-not-behaviour discipline `makeHeldPlantRig` has always used; pickup behaviour
 * itself is `bombtest.mjs` coverage.
 */
function stageCarrier(rules, entity) {
  rules.bomb.state = 'carried';
  rules.bomb.carrierId = entity.id;
  return entity;
}

/** `match-result.md` team names by index, for asserting what the evidence recorded. */
const TEAM_NAMES_TEST = ['alpha', 'bravo'];

const teamOf = (game, team) => game.entities.filter((e) => e.team === team);
const killVia = (game, victim) => game.bus.emit('kill', { victim, attacker: null, weaponId: 'ar_vector', headshot: false, distance: 12 });

console.log('\nprotocol v3 — the bomb position on EVERY frame, not just MSG_MATCHSTATE (§8.6, §8.8)');

{
  // C1, rewritten by bomb-rules §13.3: `bombDropped` still rides `EV_VEC3`/`EV_SPATIAL`
  // with the true coordinates in the snapshot's event block — but a dropped bomb is now
  // the NEUTRAL shared objective, so the per-recipient authorisation must serve it to
  // BOTH teams, sightline or not. The drop is produced by the REAL ruleset and every
  // frame each recipient receives is scanned at every offset — the same instrument that
  // used to prove filtering now proves the deliberate publication.
  const s = await makeBombSession();
  const g = s.game;
  const rules = s.rules;

  eq('the round opens with a NEUTRAL bomb — no carrier (§13.2)', rules.bomb.carrierId, -1);
  eq('...lying dropped at the neutral point', rules.bomb.state, 'dropped');
  const carrier = stageCarrier(rules, teamOf(g, 0)[0]);
  // Deliberately unique coordinates, so a hit in the scan cannot be somebody's own position
  // coinciding with the bomb's. Every value is a float32 nothing else in the world holds.
  const sp = g.world.spawnPoints.map((p) => p.position ?? p);
  const DROP = {
    x: Math.fround(sp[0].x + 0.101563), y: Math.fround(sp[0].y + 0.302734), z: Math.fround(sp[0].z + 0.507813),
  };
  carrier.position.set(DROP.x, DROP.y, DROP.z);

  const eyeH = carrier.eyeHeight ?? 1.6;
  let blindAt = null, seeingAt = null;
  for (let i = 1; i < sp.length; i++) {
    const clear = g.world.losClear({ x: sp[i].x, y: sp[i].y + eyeH, z: sp[i].z }, DROP);
    if (clear && !seeingAt) seeingAt = sp[i];
    if (!clear && !blindAt) blindAt = sp[i];
  }
  if (!blindAt || !seeingAt) {
    bad('the map offers a blocked and a clear sightline to the drop',
      `blocked=${!!blindAt} clear=${!!seeingAt} — this test cannot distinguish anything`);
  }

  const teammates = teamOf(g, 0).filter((e) => e !== carrier);
  const enemies = teamOf(g, 1);
  if (teammates.length === 0 || enemies.length < 2) {
    bad('the match has a teammate and two enemies to watch', `${teammates.length} / ${enemies.length}`);
  }

  const A = attach(s, teammates[0], 'teammate');
  const B = attach(s, enemies[0], 'blind');
  const C = attach(s, enemies[1], 'seeing');

  // The drop, from the ruleset itself. `noteDisconnect` is §9's own path into `_dropBomb`,
  // and it runs synchronously — so the bomb lands on exactly the coordinates set above,
  // rather than wherever a tick of simulation had moved the carrier to first.
  rules.noteDisconnect(carrier);
  // And the carrier is moved off the spot afterwards, so its OWN position in the entity
  // block cannot be mistaken for the leak this is looking for.
  carrier.position.set(sp[3].x, sp[3].y, sp[3].z);

  const evRow = rules.events.filter((e) => e.kind === 'bombDropped').pop();
  if (evRow && Math.abs(evRow.x - DROP.x) < 1e-6) {
    ok(`the ruleset really dropped the bomb at (${DROP.x.toFixed(3)}, ${DROP.y.toFixed(3)}, ${DROP.z.toFixed(3)}) — reason "${evRow.reason}"`);
  } else {
    bad('the real ruleset produced the drop', `event row ${JSON.stringify(evRow)}`);
  }

  A.entity.position.set(sp[2].x, sp[2].y, sp[2].z);
  B.entity.position.set(blindAt.x, blindAt.y, blindAt.z);
  C.entity.position.set(seeingAt.x, seeingAt.y, seeingAt.z);
  for (const c of [A, B, C]) { c.entity.alive = true; c.frames.length = 0; }
  s.server._broadcastMatchState();
  s.server._broadcastSnapshot();
  for (const c of [A, B, C]) c.cT.pump(0);

  const WANT = [DROP.x, DROP.y, DROP.z];
  const hitsA = scanAll(A.frames, WANT);
  const hitsB = scanAll(B.frames, WANT);
  const hitsC = scanAll(C.frames, WANT);

  // The positive control FIRST: the scan can find the coordinates at all.
  if (hitsA.length >= 3) ok(`the scan finds the coordinates when they ARE sent (${hitsA.length} float32 hits in the teammate's frames)`);
  else bad('the scan can find the coordinates at all', `teammate frames contain ${hitsA.length} hits — the control failed, so the claims below mean nothing`);

  // §13.3: the dropped bomb is contestable by both teams, so BOTH enemies get it too —
  // including the one with no sightline. LOS is no longer the filter.
  const dist = Math.hypot(B.entity.position.x - DROP.x, B.entity.position.y - DROP.y, B.entity.position.z - DROP.z);
  if (hitsB.length >= 3) {
    ok(`the enemy with NO sightline, ${dist.toFixed(1)} m away, receives the drop too — the neutral objective is public to both teams (§13.3)`);
  } else {
    bad('a blind enemy receives the neutral drop (§13.3)', `${hitsB.length} hits in their frames`);
  }
  if (hitsC.length >= 3) ok('and so does the enemy who can see it');
  else bad('a seeing enemy receives the drop', `${hitsC.length} hits in the seeing enemy's frames`);

  // What the decoders actually made of it.
  const evB = B.client.snapshots.flatMap((sn) => sn.events).find((e) => e.kind === 'bombDropped');
  if (evB && Math.abs(evB.x - DROP.x) < 1e-6) ok('the blind enemy decodes the real bombDropped event');
  else bad('the blind enemy decodes the drop event', JSON.stringify(evB));
  eq('and the state agrees the bomb is on the ground', B.client.matchState?.bombState, 'dropped');
  if (B.client.matchState?.bombPosition && Math.abs(B.client.matchState.bombPosition.x - DROP.x) < 1e-3) {
    ok('with the coordinates in MSG_MATCHSTATE as well');
  } else {
    bad('the blind enemy state message carries the drop position', JSON.stringify(B.client.matchState?.bombPosition));
  }
}

console.log('\nprotocol v3 — the ruleset\'s own payload reaches the wire intact (§8.7)');

{
  // C4 + C2 + C5, all against what `src/game/bomb.js` really emits. Nothing here builds an
  // objective payload by hand.
  const s = await makeBombSession();
  const g = s.game;
  const rules = s.rules;
  const carrier = stageCarrier(rules, teamOf(g, 0)[0]);
  const refusedOne = teamOf(g, 1)[0];
  const other = teamOf(g, 1)[1];

  const D = attach(s, refusedOne, 'refused');
  const O = attach(s, other, 'bystander');
  const A = attach(s, carrier, 'carrier');

  // §13.4: a player who is not the carrier asking to plant. The ruleset refuses it with
  // its own vocabulary — `notCarrying` now, because BOTH teams may plant and the first
  // precondition that fails is possession, not side.
  rules.requestInteract(refusedOne, 'plant');
  const refusal = rules.events.filter((e) => e.kind === 'interactRefused').pop();
  eq('the ruleset refused the non-carrier', refusal?.reason, 'notCarrying');
  eq('and named them with `entityId`, which is the field it has always used', refusal?.entityId, refusedOne.id);

  const row = s.server.evidence.of('interactRefused').pop();
  eq('the evidence row names the actor — it read `entityId`', row?.actorId, refusedOne.id);
  eq('and their side, looked up server-side', row?.actorTeam, TEAM_NAMES_TEST[1]);
  eq('and what they asked for', row?.requestedKind, 1);
  eq('and the round, converted from the 1-based `round` the producer sends', row?.roundIndex, rules.roundIndex);

  for (let i = 0; i < 8; i++) { s.server.tick(); for (const c of s.conns) c.cT.pump(0); }
  const mine = D.client.snapshots.flatMap((x) => x.events).filter((e) => e.kind === 'interactRefused');
  const theirs = O.client.snapshots.flatMap((x) => x.events).filter((e) => e.kind === 'interactRefused');
  eq('the refused player is told', mine.length >= 1, true);
  eq('and nobody else is — §8.7, "sent only to the refused player"', theirs.length, 0);
  eq('the kind they asked for survives the wire', mine[0]?.requestedKindName, 'plant');
}

{
  // C5. The two vocabularies do not overlap, so every reason but one used to arrive as
  // index 0. Driven through the real `_wireReason` with the real `REFUSE` names.
  const s = await makeBombSession();
  const cases = [
    ['wrongPhase', 'wrong-phase'],
    ['alreadyPlanted', 'already-planted'],
    ['notCarrying', 'not-carrier'],
    ['outsideVolume', 'outside-volume'],
  ];
  for (const [rulesetName, wireName] of cases) {
    const got = s.server._wireReason('interactRefused', rulesetName);
    if (got === wireName && REFUSAL_REASONS.indexOf(wireName) !== 0) {
      ok(`"${rulesetName}" maps to "${wireName}" (index ${REFUSAL_REASONS.indexOf(wireName)}, not 0)`);
    } else {
      bad(`the ruleset reason "${rulesetName}" maps to a distinct §8.7 enum`, `got ${JSON.stringify(got)}`);
    }
  }
  const cancels = [['dead', 'died'], ['outsideVolume', 'left-volume'], ['roundOver', 'round-ended']];
  for (const [rulesetName, wireName] of cancels) {
    const got = s.server._wireReason('plantCancel', rulesetName);
    if (got === wireName && CANCEL_REASONS.indexOf(wireName) !== 0) {
      ok(`a cancel for "${rulesetName}" maps to "${wireName}" (index ${CANCEL_REASONS.indexOf(wireName)})`);
    } else {
      bad(`the cancel reason "${rulesetName}" maps to a distinct §8.7 enum`, `got ${JSON.stringify(got)}`);
    }
  }
  // And the whole point of the mapping: it survives the encoder and the decoder.
  s.server._record({ kind: 'plantCancel', to: null, entityId: 7, reason: s.server._wireReason('plantCancel', 'dead') });
  const decoded = decodeSnapshot(encodeSnapshot({ tick: 1, baseTick: 0, lastCommandSeq: 0, entities: [], events: s.server._pendingEvents }, null), null);
  eq('and a cancel reason arrives decoded by name', decoded.events[0]?.reasonName, 'died');

  // LOUD, not silently zero.
  const before = s.server.stats.unmappedReasons;
  const fallback = s.server._wireReason('interactRefused', 'somethingTheRulesetInvented');
  eq('an unmappable reason is counted', s.server.stats.unmappedReasons, before + 1);
  eq('and named, so the fix is mechanical', s.server.unmappedReasons.has('interactRefused:somethingTheRulesetInvented'), true);
  eq('and still encodes as something the decoder can read', fallback, REFUSAL_REASONS[0]);
}

console.log('\nprotocol v3 — MSG_OUTCOME actually leaves the server (§8.9)');

{
  // C6. A full match used to produce message types {2, 3, 7} and not one MSG_OUTCOME, because
  // the server subscribed to a bus event nothing emits. Both scopes here, both from the real
  // ruleset: a round ended by elimination, and a match ended by forfeit.
  const s = await makeBombSession();
  const g = s.game;
  const rules = s.rules;
  s.server.evidence.identify({ matchId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
  const watcher = attach(s, teamOf(g, 0)[0], 'watcher');
  const types = {};
  watcher.cT.onMessage((d) => {
    const t = new DataView(d).getUint8(0);
    types[t] = (types[t] ?? 0) + 1;
    watcher.frames.push(d.slice(0));
    watcher.client._onMessage(d);
  });

  // §13.5 pre-plant: a team fully eliminated → the other team wins. Wipe team 1.
  for (const e of teamOf(g, 1)) killVia(g, e);
  for (let i = 0; i < 8; i++) { s.server.tick(); watcher.cT.pump(0); }

  const o = watcher.client.outcome;
  if (!o) {
    bad('a round end puts MSG_OUTCOME on the wire',
      `client saw message types ${JSON.stringify(types)} — MSG_OUTCOME is ${MSG_OUTCOME}`);
  } else {
    eq('the round outcome arrives, decoded', o.scope, 'round');
    eq('and names the winner', o.winnerTeam, 'alpha');
    eq('and why', o.reason, 'elimination');
    eq('and the round it belongs to', o.roundIndex, rules.rounds.length - 1);
    eq('and carries the match id', o.matchId, '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    eq('a round outcome is a completed one', o.terminationReason, 'completed');
    eq(`and the server counted it (types ${JSON.stringify(types)})`, types[MSG_OUTCOME] >= 1, true);
  }

  // Match scope, via §9 presence: every member of one team disconnects and forfeits.
  const loser = 0;
  for (const e of teamOf(g, loser)) rules.noteDisconnect(e);
  for (let i = 0; i < 8; i++) { s.server.tick(); watcher.cT.pump(0); }
  const m = watcher.client.outcome;
  if (!m || m.scope !== 'match') {
    bad('a match end puts a match-scope MSG_OUTCOME on the wire', JSON.stringify(m));
  } else {
    eq('the match outcome arrives', m.scope, 'match');
    // §8.9's two bold rows: an aborted match CAN have a winner.
    eq('an aborted match still has a winner', m.winnerTeam, loser === 0 ? 'bravo' : 'alpha');
    eq('and says it was aborted', m.terminationReason, 'aborted');
    eq('for a forfeit', m.reason, 'forfeit');
    eq('and a match-scope outcome is about no single round', m.roundIndex, null);
  }
}

{
  // The winner/draw distinction §8.9 calls out: `0` is "no winner", `3` is "draw".
  const s = await makeBombSession({ bots: 1 });
  const sent = [];
  s.server.sendOutcome = (o) => { sent.push(o); return null; };
  s.server.objectiveEvent({ kind: 'matchEnd', winnerTeam: -1, reason: 'draw', roundWins: [6, 6], roundsPlayed: 12 });
  s.server.objectiveEvent({ kind: 'matchEnd', winnerTeam: -1, reason: 'no-contest', terminationReason: 'aborted', roundWins: [3, 3], roundsPlayed: 6 });
  eq('a 6-6 regulation finish is a DRAW', sent[0]?.winner, 'draw');
  eq('and a draw is always the timer, per match-result.md §4.0', sent[0]?.reason, 'timer');
  eq('a no-contest has NO winner, which is a different fact', sent[1]?.winner, 'none');
  eq('and is not a draw', sent[1]?.reason, 'no-contest');
}

console.log('\nprotocol v3 — the appended interact field carries something (§8.5)');

{
  // C7. The one entity field that justified PROTOCOL_VERSION -> 2 was `packInteract(0, 0)` on
  // every entity of every real snapshot, because nothing in `src/` assigns `entity.objective`.
  const s = await makeBombSession();
  const g = s.game;
  const rules = s.rules;
  // §13.4: site A is somebody's HOME — only the OTHER team may plant there. Stage the
  // carrier from the team whose TARGET site is A.
  const planterTeam = rules.siteOwner('A') === 0 ? 1 : 0;
  const carrier = stageCarrier(rules, teamOf(g, planterTeam)[0]);
  const site = rules.sites.get('A');
  carrier.position.set((site.plant.min.x + site.plant.max.x) / 2, site.plant.min.y + 0.5,
    (site.plant.min.z + site.plant.max.z) / 2);
  carrier.grounded = true;
  const watcher = attach(s, teamOf(g, rules.siteOwner('A'))[0], 'watcher');

  eq('nothing has assigned entity.objective', carrier.objective, undefined);

  const seen = new Set();
  let progressed = null;
  for (let i = 0; i < 200; i++) {
    rules.requestInteract(carrier, 'plant');
    carrier.grounded = true;
    s.server.tick();
    watcher.cT.pump(0);
    for (const sn of watcher.client.snapshots) {
      const e = sn.entities.find((x) => x.id === carrier.id);
      if (!e) continue;
      seen.add(e.interact);
      const u = unpackInteract(e.interact);
      if (u.kindName === 'plant' && u.progress > 0) progressed = u;
    }
  }
  if (progressed) {
    ok(`the wire carries a real plant in progress: kind "${progressed.kindName}", ${progressed.progress}/63`);
  } else {
    bad('the interact byte carries the plant', `distinct bytes on the wire: [${[...seen].join(',')}]`);
  }
  if (seen.size > 1) ok(`and it MOVES — ${seen.size} distinct values across the plant`);
  else bad('the interact byte changes as progress accumulates', `only ${[...seen].join(',')} ever appeared`);
  // Snapshot latency: the last DECODED value can trail the live ruleset by a few ticks
  // (and the ruleset may have completed/cancelled since), so agreement is within the
  // snapshot cadence rather than exact.
  {
    const live = rules.progressOf(carrier.id) || 0;
    if (live === 0 || Math.abs(live - (progressed?.progress ?? 0)) <= 8) {
      ok(`and it agrees with the ruleset it came from (wire ${progressed?.progress}, ruleset ${live})`);
    } else {
      bad('the wire quantity tracks the ruleset', `wire ${progressed?.progress} vs ruleset ${live}`);
    }
  }
}

console.log('\nprotocol v3 — the handshake gates allocation (§8.2, §9.5)');

{
  // C3. The gate gated nothing: `addClient` allocated the entity and sent the welcome before
  // any hello, and `_onMessage` accepted commands from a socket that had never sent one.
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter() });
  game.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 7 });
  game.match.phase = 'live';
  game.match.countdown = 0;
  const server = new GameServer(game);
  const { Player } = await import('../src/player/player.js');

  let built = 0;
  const factory = () => {
    built++;
    const e = new Player(game);
    e.init();
    game.addEntity(e);
    game.weapons.giveLoadout(e, ['ar_vector', 'pistol_sidewinder']);
    e.respawn?.();
    return e;
  };

  const [cT, sT] = createLoopbackPair({});
  const frames = [];
  cT.onMessage((d) => frames.push(d.slice(0)));
  const before = game.entities.length;
  const session = server.addClient(sT, factory);
  cT.pump(0);

  eq('connecting builds no entity', built, 0);
  eq('and adds none to the world', game.entities.length, before);
  eq('and sends no welcome', frames.filter((b) => new DataView(b).getUint8(0) === MSG_WELCOME).length, 0);
  eq('and the session drives nothing', session.entity === null, true);

  // Commands from a socket that never said hello.
  const cmd = { ...emptyCommand(), seq: 1, wishForward: 1 };
  cT.send(encodeCommands([cmd]));
  sT.pump(0);
  cT.pump(0);
  server.tick();
  eq('a command before the hello is refused, not queued', session.stats.commands, 0);
  eq('and counted', session.stats.preHelloMessages, 1);
  eq('and the connection is closed, per §8.2', session.rejected, 'SESSION_TOKEN_INVALID');
  const rej = frames.find((b) => new DataView(b).getUint8(0) === MSG_REJECT);
  if (rej) eq('with a MSG_REJECT naming the reason', decodeReject(rej).reason, 'SESSION_TOKEN_INVALID');
  else bad('a socket that skips the hello is rejected', `frame types [${frames.map((b) => new DataView(b).getUint8(0)).join(',')}]`);
  eq('and it left no entity behind', built, 0);
  eq('and no session', server.clients.has(session.id), false);
}

{
  // The other half: a proper hello DOES allocate, exactly once, and only then.
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter() });
  game.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 7 });
  game.match.phase = 'live';
  game.match.countdown = 0;
  const server = new GameServer(game);
  const { Player } = await import('../src/player/player.js');
  let built = 0;
  const factory = () => {
    built++;
    const e = new Player(game);
    e.init();
    game.addEntity(e);
    game.weapons.giveLoadout(e, ['ar_vector', 'pistol_sidewinder']);
    e.respawn?.();
    return e;
  };
  const [cT, sT] = createLoopbackPair({});
  const client = new NetClient(cT);
  const session = server.addClient(sT, factory);
  client.sendHello('st_gate');
  sT.pump(0);
  cT.pump(0);
  eq('a hello allocates the entity', built, 1);
  eq('and the welcome names it', client.entityId, session.entity.id);
  eq('and the session is authenticated', session.authenticated, true);

  // A second hello must not hand one socket two bodies.
  client.sendHello('st_gate');
  sT.pump(0);
  cT.pump(0);
  eq('a repeated hello re-welcomes and allocates nothing more', built, 1);

  // A version mismatch, on a socket that has not yet been allocated anything.
  const [cT2, sT2] = createLoopbackPair({});
  const frames2 = [];
  cT2.onMessage((d) => frames2.push(d.slice(0)));
  const s2 = server.addClient(sT2, factory);
  cT2.send(encodeHello(PROTOCOL_VERSION - 1, 'st_stale'));
  sT2.pump(0);
  cT2.pump(0);
  eq('a stale client allocates nothing at all', built, 1);
  eq('and is rejected', s2.rejected, REJECT_PROTOCOL_VERSION_MISMATCH);
  eq('and receives no welcome', frames2.filter((b) => new DataView(b).getUint8(0) === MSG_WELCOME).length, 0);
}

console.log('\nprotocol v3 — malformed frames close the connection (§8.11)');

{
  // C10. `decodeWelcome` was the one decoder with no minimum-length check, because it accepts
  // two lengths. A 6-byte welcome threw a RangeError out of the receive path, the transport
  // swallowed it, and the connection carried on.
  const cases = [
    ['a 6-byte welcome', MSG_WELCOME, 6],
    ['a welcome between the two legal lengths', MSG_WELCOME, 18],
    ['a truncated match state', MSG_MATCHSTATE, MATCHSTATE_BYTES - 1],
    ['an over-long outcome', MSG_OUTCOME, 33],
  ];
  for (const [name, type, len] of cases) {
    const [cT, sT] = createLoopbackPair({});
    const client = new NetClient(cT);
    const buf = new ArrayBuffer(len);
    new DataView(buf).setUint8(0, type);
    sT.send(buf);
    let threw = null;
    try { cT.pump(0); } catch (e) { threw = e; }
    if (threw) bad(`${name} does not throw out of the receive path`, `${threw.constructor.name}: ${threw.message}`);
    else if (client.rejected && cT.closed) ok(`${name} closes the connection rather than being swallowed`);
    else bad(`${name} closes the connection (§8.11)`, `rejected=${JSON.stringify(client.rejected)} closed=${cT.closed}`);
    eq(`...and ${name} is counted`, client.stats.malformed, 1);
  }
  // Both legal lengths still decode. The check must not have closed the door on v1.
  eq('a 21-byte welcome still decodes', decodeWelcome(encodeWelcome({ clientId: 3, entityId: 9 }))?.entityId, 9);
  eq('and a 15-byte v1 welcome still does', decodeWelcome(encodeWelcome({ clientId: 3, entityId: 9 }).slice(0, WELCOME_BYTES_V1))?.entityId, 9);
  eq('with no version, which is what marks it as v1', decodeWelcome(encodeWelcome({}).slice(0, WELCOME_BYTES_V1))?.protocolVersion, null);
}

console.log('\nprotocol v3 — the two guards nothing was testing (§4, §8.8)');

{
  // C8, first half: `_canSee` requires a LIVING viewer — "elimination is not a licence to
  // learn where the bomb is". Dropping `!viewer.alive` from that line left every test green.
  const s = await makeSession({ clients: 1 });
  const g = s.game;
  const c = s.conns[0];
  const sp = g.world.spawnPoints.map((p) => p.position ?? p);
  const BOMB = { x: sp[0].x, y: sp[0].y + 0.3, z: sp[0].z };
  const eyeH = c.entity.eyeHeight ?? 1.6;
  let seeing = null;
  for (let i = 1; i < sp.length && !seeing; i++) {
    if (g.world.losClear({ x: sp[i].x, y: sp[i].y + eyeH, z: sp[i].z }, BOMB)) seeing = sp[i];
  }
  c.entity.position.set(seeing.x, seeing.y, seeing.z);
  c.entity.team = 1;
  const m = g.match;
  m.modeId = 'bomb'; m.roundPhase = 'live'; m.roundIndex = 0; m.scores = [0, 0];
  m.aliveCounts = { alpha: 1, bravo: 1 }; m.phaseRemainingMs = 60000; m.attackingTeam = 0;
  m.bomb = { state: 'dropped', carrierId: 0, siteId: null, position: BOMB };
  m.interaction = { kind: 'none', actorId: 0, progress: 0 };

  c.entity.alive = true;
  eq('a living viewer in line of sight passes _canSee', s.server._canSee(c.entity, BOMB), true);
  c.entity.alive = false;
  eq('a DEAD one, standing in the same place, does not — the guard still protects the CARRIER filter (§8.8)',
    s.server._canSee(c.entity, BOMB), false);
  const state = readBombMatchState(g);
  // bomb-rules §13.3: the DROPPED bomb is no longer sight-gated — its position is served
  // to every team recipient, dead or alive; only a team-less viewer gets nothing.
  eq('yet the state message still serves the dropped bomb to them — §13.3, team-public, not sight-gated',
    s.server._matchStateFor(c.session, state, 0).bombPosition?.x, BOMB.x);
  c.entity.alive = true;
  eq('and to the living alike', s.server._matchStateFor(c.session, state, 0).bombPosition?.x, BOMB.x);
}

{
  // C8, second half: §4 — "every wire scalar is bounds- or finiteness-checked at decode".
  // The finiteness guard on the bomb coordinates had no test; dropping it stayed green.
  const base = {
    phase: 'live', roundIndex: 1, localRole: 'attacker', scoreAlpha: 0, scoreBravo: 0,
    phaseRemainingMs: 1000, aliveAlpha: 1, aliveBravo: 1, bombState: 'dropped',
    bombCarrierId: 0, bombSite: null, interactActorId: 0, interactProgress: 0,
    sideSwitched: false, serverTimeMs: 0,
  };
  const good = decodeMatchState(encodeMatchState({ ...base, bombPosition: { x: 1.5, y: 2.5, z: 3.5 } }));
  eq('a finite position encodes and decodes', good.bombPosition?.x, 1.5);
  for (const [name, p] of [
    ['NaN', { x: NaN, y: 0, z: 0 }],
    ['Infinity', { x: 0, y: Infinity, z: 0 }],
    ['-Infinity', { x: 0, y: 0, z: -Infinity }],
    ['a string', { x: '4', y: '0', z: '0' }],
  ]) {
    const d = decodeMatchState(encodeMatchState({ ...base, bombPosition: p }));
    if (d.bombPositionVisible === false && d.bombPosition === null) {
      ok(`a bomb position containing ${name} is refused at encode, and decodes as absent`);
    } else {
      bad(`a non-finite bomb coordinate never reaches a client (${name})`, JSON.stringify(d.bombPosition));
    }
  }
}

console.log('\nprotocol v3 — a viewer with no side is authorised for nothing (§8.6)');

{
  // C11. `role === 'none'` fell through the `bomb.state === 'planted'` short-circuit and was
  // handed a planted bomb's coordinates; §8.6 grants that to DEFENDERS, who have to find it.
  const s = await makeSession({ clients: 1 });
  const g = s.game;
  const c = s.conns[0];
  const m = g.match;
  m.modeId = 'bomb'; m.roundPhase = 'planted'; m.roundIndex = 0; m.scores = [0, 0];
  m.aliveCounts = { alpha: 1, bravo: 1 }; m.phaseRemainingMs = 40000; m.attackingTeam = 0;
  m.bomb = { state: 'planted', carrierId: 0, siteId: 'A', position: { x: 7, y: 1, z: -3 } };
  m.interaction = { kind: 'none', actorId: 0, progress: 0 };
  const state = readBombMatchState(g);

  c.entity.team = 1;
  c.entity.alive = true;
  eq('a defender is told where a planted bomb is', s.server._matchStateFor(c.session, state, 0).bombPosition?.x, 7);
  c.entity.team = undefined;
  const none = s.server._matchStateFor(c.session, state, 0);
  eq('a viewer with no team has no role', none.localRole, 'none');
  eq('and is authorised for nothing', none.bombPosition, null);
  s.server._matchStateFor({ entity: null }, state, 0);
  eq('and a session with no entity at all is too',
    s.server._matchStateFor({ entity: null }, state, 0).bombPosition, null);

  // The same rule on the carrier field: two undefined teams are not "the same team".
  m.bomb = { state: 'carried', carrierId: c.entity.id, siteId: null, position: null };
  const carried = readBombMatchState(g);
  const spectator = { entity: { id: 9999, team: undefined, alive: true, position: { x: 999, y: 999, z: 999 }, eyeHeight: 1.6 } };
  eq('an unassigned viewer is not a teammate of an unassigned carrier',
    s.server._matchStateFor(spectator, carried, 0).bombCarrierId, 0);
}

{
  // The incidental robustness note: a session attached to an entity with no `_edge` map took
  // `GameServer.tick()` down for EVERY client, not just for itself.
  const s = await makeSession({ clients: 1 });
  s.conns[0].session.entity = { id: 4242, _held: {}, alive: true, position: { x: 0, y: 0, z: 0 } };
  let threw = null;
  try { s.server.tick(); } catch (e) { threw = e; }
  if (threw) bad('a session on an entity with no _edge does not kill the tick loop', `${threw.constructor.name}: ${threw.message}`);
  else ok('a session on an entity with no _edge map does not kill the tick loop for everyone else');
}

console.log('\nprotocol v3 — a HUMAN can plant, with the key HELD over the real wire (bomb-rules §6.4)');

/**
 * The rig this section needed, and the reason the old coverage proved nothing.
 *
 * `bombtest.mjs` and `wstest.mjs` both plant by calling `rules.requestInteract(...)` in a loop.
 * That is the bot's path — `botManager.js` calls it in-process — and it is precisely the half
 * of the system that was never broken. The broken half is everything before it: a key held
 * down, through `Player._refreshHeldState`, `_buildLocalCommand`, `MultiplayerSession.step`,
 * `encodeCommands`, the transport, `decodeCommands`, and `GameServer._applyCommand`. Nothing
 * in this rig constructs a command field by hand and nothing calls `requestInteract`.
 *
 * TWO games, deliberately. The client game holds the `Player` whose input is read and whose
 * command is encoded; the server game holds the authoritative entity and the real `BombRules`.
 * The only thing joining them is the bytes, so a held state that reached the ruleset can only
 * have arrived through the wire.
 */
async function makeHeldPlantRig({ bots = 7 } = {}) {
  const { Player } = await import('../src/player/player.js');
  const { MultiplayerSession } = await import('../src/net/session.js');

  const s = await makeBombSession({ bots });
  const g = s.game;
  const rules = s.rules;
  const humans = [];
  let ms = 0;

  /** A server-side `Player`, a socket, and a real `MultiplayerSession` driving it. */
  async function addHuman({ team, position, label }) {
    const entity = new Player(g);
    await entity.init();
    g.addEntity(entity);
    entity.team = team;
    g.weapons.giveLoadout(entity, ['ar_vector', 'pistol_sidewinder']);
    entity.respawn();
    // Bots shoot. A test about a 3- or 7-second interaction must not fail because somebody
    // won a gunfight during it — and if the human dies anyway, that is asserted as a
    // control rather than silently changing what the test measures.
    entity.maxHealth = 1e6;
    entity.health = 1e6;
    entity.position.set(position.x, position.y, position.z);
    entity.velocity.set(0, 0, 0);

    const [cT, sT] = createLoopbackPair({});
    const session = s.server.addClient(sT, entity);
    s.server._onMessage(session, encodeHello(PROTOCOL_VERSION, `st_${label}`));

    // ── the client, which is a real one ──────────────────────────────────────────────
    const clientGame = new Game({ headless: true });
    await clientGame.initHeadless({ presenter: new NullPresenter() });
    clientGame.startMatch({ mode: 'bomb', botCount: 0, seed: 7 });
    clientGame.state = 'playing';
    clientGame.paused = false;

    // The browser's input device, stood in for. `isDown('interact')` is a real method on a
    // real key binding (`settings.js` binds KeyE); headless has no device at all, and
    // `_refreshHeldState` returns early without one.
    const down = new Set();
    clientGame.input = {
      fire: false, aim: false, firePressed: false, aimPressed: false,
      isDown: (k) => down.has(k),
      wasPressed: () => false,
      wasReleased: () => false,
      consumeWheel: () => 0,
      consumeLook: (out) => { out.x = 0; out.y = 0; return out; },
    };

    const mp = new MultiplayerSession(clientGame, cT);
    mp.connected = true;

    const row = {
      entity, session, cT, sT, mp, clientGame, down, label,
      seen: { held: 0, released: 0, edge: 0 },
    };
    humans.push(row);
    return row;
  }

  /** One fixed step of the whole loop: build, encode, send, decode, apply, simulate. */
  const stepOnce = () => {
    for (const h of humans) {
      h.mp.step();
      h.sT.pump(ms);
      // What the SERVER decoded, sampled before `tick()` consumes it — the field's arrival
      // is the claim, so it is measured rather than assumed.
      for (const q of h.session.queue) {
        if (q.interactHeld) h.seen.held++; else h.seen.released++;
        if (q.interact) h.seen.edge++;
      }
    }
    s.server.tick();
    for (const h of humans) h.cT.pump(ms);
    ms += FIXED_DT * 1000;
  };

  /** The centre of a site volume, one step above its floor. */
  const centreOf = (box) => ({
    x: (box.min.x + box.max.x) / 2,
    y: box.min.y + 0.5,
    z: (box.min.z + box.max.z) / 2,
  });

  // The human carrier stands on plant site A — which §13.4 makes legal only for the
  // team whose TARGET site is A (the team that does NOT own it). Fixture, not
  // behaviour: this section is about the KEY; preconditions have their own coverage.
  const site = rules.sites.get('A');
  const attacker = await addHuman({
    team: rules.siteOwner('A') === 0 ? 1 : 0, position: centreOf(site.plant), label: 'held_plant',
  });
  rules.bomb.state = 'carried';
  rules.bomb.carrierId = attacker.entity.id;

  return {
    s, g, rules, site, centreOf, addHuman, stepOnce,
    human: attacker.entity,
    session: attacker.session,
    mp: attacker.mp,
    clientGame: attacker.clientGame,
    down: attacker.down,
    seen: attacker.seen,
  };
}

/** Plant duration in ticks, from the ruleset's own parameters. */
const PLANT_TICKS = Math.ceil(3.0 / FIXED_DT);

{
  // THE test. The key goes down and stays down; nothing else happens.
  const r = await makeHeldPlantRig();
  r.down.add('interact');

  const progress = [];
  let completedAt = -1;
  for (let t = 0; t < PLANT_TICKS + 40; t++) {
    r.stepOnce();
    progress.push(r.rules.progressFraction(r.human.id));
    if (completedAt < 0 && r.rules.phase === 'planted') completedAt = t;
  }

  // The control first: if the human died, everything below is measuring the wrong thing.
  if (r.human.alive) ok('the planter survived the plant, so the result below is about the key');
  else bad('the planter survived the plant', 'a bot killed them mid-plant — rerun; this result means nothing');

  if (r.seen.held > PLANT_TICKS) {
    ok(`the server decoded interactHeld=true on ${r.seen.held} commands (a HELD key, not an edge)`);
  } else {
    bad('a held key reaches the server on every command',
      `only ${r.seen.held} of ${r.seen.held + r.seen.released} decoded commands carried interactHeld — `
      + 'this is the shape of an EDGE, which is exactly the bug');
  }

  // Progress that actually climbed, rather than resetting to zero every tick. Sampled at
  // three points because "it was non-zero once" is what the broken build also produced.
  const early = progress[Math.floor(PLANT_TICKS * 0.25)];
  const mid = progress[Math.floor(PLANT_TICKS * 0.5)];
  const late = progress[Math.floor(PLANT_TICKS * 0.9)];
  if (early > 0 && mid > early && late > mid) {
    ok(`server-side progress accumulated continuously: ${early.toFixed(2)} → ${mid.toFixed(2)} → ${late.toFixed(2)}`);
  } else {
    bad('progress accumulates across ticks instead of resetting',
      `samples ${early}, ${mid}, ${late} — a reset every tick is the bug this closes`);
  }

  if (completedAt >= 0) {
    ok(`the plant COMPLETED at tick ${completedAt} of ${PLANT_TICKS} — a human planted the bomb`);
  } else {
    bad('a human holding the plant key completes a plant',
      `after ${PLANT_TICKS + 40} ticks the phase is still "${r.rules.phase}", progress `
      + `${r.rules.progressFraction(r.human.id)}`);
  }
  eq('and the ruleset says the bomb is planted', r.rules.bomb.state, 'planted');
  const done = r.rules.events.filter((e) => e.kind === 'plantComplete');
  eq('with exactly one plantComplete', done.length, 1);
  eq('credited to the human', done[0]?.entityId, r.human.id);
}

{
  // §6: "Interrupted by: releasing the key... Progress resets to zero — there is no partial
  // credit and no resume." Released mid-plant, over the same real wire.
  const r = await makeHeldPlantRig();
  r.down.add('interact');

  const HALF = Math.floor(PLANT_TICKS / 2);
  for (let t = 0; t < HALF; t++) r.stepOnce();
  const atRelease = r.rules.progressFraction(r.human.id);
  if (atRelease > 0.3 && atRelease < 0.7) ok(`the plant was genuinely half-done when the key came up (${atRelease.toFixed(2)})`);
  else bad('the plant was mid-flight at the release', `progress ${atRelease} — the cancel below proves nothing`);

  r.down.delete('interact');                       // the player lets go
  r.stepOnce();
  eq('progress is zero on the very next tick', r.rules.progressFraction(r.human.id), 0);
  // Exactly one, not "at least one": `releaseInteract` is called on every tick the key is up,
  // and a cancel per tick would be a stream of spurious events for one release.
  const cancels = r.rules.events.filter((e) => e.kind === 'plantCancel');
  eq('and the ruleset emitted exactly one plantCancel', cancels.length, 1);
  eq('naming the release as the reason', cancels[0].reason, 'released');
  eq('and naming the player it cancelled', cancels[0].entityId, r.human.id);

  // No partial credit and no resume: a full plant's worth of ticks with the key UP.
  for (let t = 0; t < PLANT_TICKS + 40; t++) r.stepOnce();
  eq('the round is still live — nothing completed after the release', r.rules.phase, 'live');
  eq('and no plant ever completed', r.rules.events.filter((e) => e.kind === 'plantComplete').length, 0);
  eq('the server is no longer holding the objective for them', r.human._objectiveHeld, false);
  if (r.seen.held > 0 && r.seen.released > PLANT_TICKS) {
    ok(`the release reached the server as bytes too: ${r.seen.held} held, ${r.seen.released} released commands`);
  } else {
    bad('the release is visible on the wire', `held ${r.seen.held}, released ${r.seen.released}`);
  }
}

{
  // §6 again, by the other route a key stops being held: the player opens the menu. The KEY
  // is still physically down the whole time — `_buildLocalCommand` returns `EMPTY_COMMAND`
  // while paused and never copies `_held` into the command, so a held field left out of that
  // object keeps the last playing frame's value and the server would keep planting for
  // somebody who is looking at a menu.
  const r = await makeHeldPlantRig();
  r.down.add('interact');
  for (let t = 0; t < Math.floor(PLANT_TICKS / 2); t++) r.stepOnce();
  eq('the plant is under way', r.rules.progressFraction(r.human.id) > 0.3, true);

  r.clientGame.paused = true;                    // menu opens; the key is never released
  for (let t = 0; t < 8; t++) r.stepOnce();
  eq('the key is still physically down', r.clientGame.input.isDown('interact'), true);
  eq('but the command stopped claiming it is held', r.human._objectiveHeld, false);
  eq('and progress reset to zero', r.rules.progressFraction(r.human.id), 0);

  for (let t = 0; t < PLANT_TICKS + 40; t++) r.stepOnce();
  eq('a paused client plants nothing', r.rules.phase, 'live');
}

{
  // The regression control, and the only direct proof that the EDGE could never have done
  // this: the same rig, the same 3 seconds, with `interact` pressed on every single command
  // and `interactHeld` never set. This is what the shipped build sent, made maximally
  // favourable — a real client sends the edge ONCE.
  const r = await makeHeldPlantRig();
  const realStep = r.mp.step.bind(r.mp);
  r.mp.step = () => {
    r.clientGame.input.wasPressed = (k) => k === 'interact';
    realStep();
    r.clientGame.input.wasPressed = () => false;
  };
  for (let t = 0; t < PLANT_TICKS + 40; t++) r.stepOnce();
  eq('the interact EDGE, on every command, plants nothing', r.rules.phase, 'live');
  eq('and never starts a plant at all', r.rules.events.filter((e) => e.kind === 'plantStart').length, 0);
  eq('because no command carried interactHeld', r.seen.held, 0);
}

{
  // The facade's accessible hold (`net-facade.md` §5.1, `session.requestInteraction`) is the
  // other producer of the same bit, and it must reach the server without the physical key.
  const r = await makeHeldPlantRig();
  eq('the physical key is up', r.clientGame.input.isDown('interact'), false);
  r.mp.requestInteraction('plant');
  let completed = false;
  for (let t = 0; t < PLANT_TICKS + 40 && !completed; t++) {
    r.stepOnce();
    completed = r.rules.phase === 'planted';
  }
  eq('a facade-held plant completes too', completed, true);
  eq('and it went through the same held bit', r.seen.held > PLANT_TICKS, true);
  eq('without ever setting the interact EDGE on any command', r.seen.edge, 0);
}

{
  // §7, the other half of the same path: the server derives plant-versus-defuse from the
  // actor's own team, so a DEFENDER holding the identical bit must defuse. Driven from a
  // real plant completed by a real client above it — nothing here writes `phase` or
  // `bomb.state` by hand.
  const r = await makeHeldPlantRig();
  r.down.add('interact');
  for (let t = 0; t < PLANT_TICKS + 40 && r.rules.phase !== 'planted'; t++) r.stepOnce();
  eq('a human plant put the round into the planted phase', r.rules.phase, 'planted');
  r.down.delete('interact');

  // §13.4: the defuser is the SITE OWNER — the team whose home site A is.
  const defender = await r.addHuman({
    team: r.rules.siteOwner('A'), position: r.centreOf(r.site.defuse), label: 'held_defuse',
  });
  defender.down.add('interact');

  const DEFUSE_TICKS = Math.ceil(7.0 / FIXED_DT);
  let defused = false;
  for (let t = 0; t < DEFUSE_TICKS + 60 && !defused; t++) {
    r.stepOnce();
    defused = r.rules.bomb.state === 'defused';
  }
  if (defender.entity.alive) ok('the defuser survived, so the result below is about the key');
  else bad('the defuser survived the defuse', 'a bot killed them mid-defuse — this result means nothing');
  eq('a human holding the key for 7 s DEFUSES the bomb', defused, true);
  const done = r.rules.events.filter((e) => e.kind === 'defuseComplete');
  eq('with a defuseComplete credited to them', done[done.length - 1]?.entityId, defender.entity.id);
  if (defender.seen.held >= DEFUSE_TICKS * 0.9 && defender.seen.edge === 0) {
    ok(`and the same held bit carried it: ${defender.seen.held} held commands, 0 interact edges`);
  } else {
    bad('the defuse rode the held bit and nothing else',
      `${defender.seen.held} held / ${defender.seen.edge} edge commands over ${DEFUSE_TICKS} ticks`);
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nnetcode runs clean');
process.exit(failures ? 1 : 0);
