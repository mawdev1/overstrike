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

/** Run `n` ticks, letting the caller shape each client's command. */
function run(session, n, shape = () => {}) {
  const { server, conns } = session;
  let ms = 0;
  for (let t = 0; t < n; t++) {
    for (const c of conns) {
      const cmd = emptyCommand();
      cmd.tick = server.game.tick;
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

console.log(failures ? `\n${failures} FAILED` : '\nnetcode runs clean');
process.exit(failures ? 1 : 0);
