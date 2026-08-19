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
import { GameServer, SNAPSHOT_INTERVAL } from '../src/net/server.js';
import { NetClient } from '../src/net/client.js';
import { createLoopbackPair } from '../src/net/transport.js';
import { Prediction, POSITION_TOLERANCE } from '../src/net/prediction.js';
import { FIXED_DT } from '../src/core/mathUtils.js';

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

console.log(failures ? `\n${failures} FAILED` : '\nnetcode runs clean');
process.exit(failures ? 1 : 0);
