/**
 * Combat feedback survives the trip to the server and back.
 *
 * The bug this exists to prevent: a networked shot resolves on the SERVER, and the server
 * has no HUD. `game.present` there was a `NullPresenter`, so the hit registered, the damage
 * applied, the score moved — and `present.hitmarker()` did nothing. Nothing was ever sent
 * to the client that fired. Every shot landed and the player saw no hitmarker, no hit
 * sound, no blood, and reported that none of their shots were hitting.
 *
 * Nothing in the suite caught it, because every existing test asserted on SIMULATION state
 * — health went down, so the test passed — and feedback is not simulation state. This
 * asserts on what reaches the client.
 *
 *   node scripts/feedbacktest.mjs
 */
import * as THREE from 'three';
import { Game } from '../src/core/game.js';
import { RecordingPresenter, NullPresenter } from '../src/core/presenter.js';
import { GameServer, SNAPSHOT_INTERVAL } from '../src/net/server.js';
import { NetClient } from '../src/net/client.js';
import { createLoopbackPair } from '../src/net/transport.js';
import { encodeSnapshot, decodeSnapshot, EV_KINDS } from '../src/net/protocol.js';
import { FIXED_DT } from '../src/core/mathUtils.js';

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };

const emptyCommand = () => ({
  wishForward: 0, wishRight: 0,
  jump: false, crouchPressed: false, reload: false, melee: false, grenade: false,
  interact: false, inspect: false, killstreak: false, lastWeapon: false,
  sprintDown: false, sprintUp: false, firePressed: false, aimButtonPressed: false,
  crouchHeld: false, toggleAdsMode: false, aimButtonHeld: false, fireHeld: false,
  sprintKeyHeld: false, breathHold: false, leanKeyHeld: false, leanRightKeyHeld: false,
  slot: -1, wheel: 0, deltaYaw: 0, deltaPitch: 0, baseYaw: 0, basePitch: 0, tick: 0,
});

console.log('\ncombat feedback reaches the client');

// ── the protocol carries events at all ───────────────────────────────────────────────
{
  const snap = {
    tick: 5, baseTick: 0, lastCommandSeq: 9,
    entities: [{
      id: 1, x: 1, y: 2, z: 3, yaw: 0, pitch: 0, vx: 0, vy: 0, vz: 0,
      health: 100, armor: 0, height: 1.8, lean: 0, flags: 1, team: 0, weaponIdx: 0, ammo: 30,
    }],
    events: [
      { kind: 'hitmarker', headshot: true },
      { kind: 'fire', entityId: 7, x: 1.5, y: 2.5, z: 3.5 },
      { kind: 'kill', killerId: 1, victimId: 7 },
      { kind: 'damaged', amount: 37 },
    ],
  };
  const d = decodeSnapshot(encodeSnapshot(snap, null), null);
  if (d.events.length === 4) ok('every event survives a round trip');
  else bad('every event survives a round trip', `got ${d.events.length} of 4`);

  const hs = d.events[0];
  if (hs.kind === 'hitmarker' && hs.headshot === true) ok('the headshot flag survives');
  else bad('the headshot flag survives', JSON.stringify(hs));

  const f = d.events[1];
  if (f.kind === 'fire' && Math.abs(f.x - 1.5) < 1e-5 && Math.abs(f.z - 3.5) < 1e-5) {
    ok('a gunshot carries the muzzle position');
  } else bad('a gunshot carries the muzzle position', JSON.stringify(f));

  const k = d.events[2];
  if (k.kind === 'kill' && k.killerId === 1 && k.victimId === 7) ok('a kill carries both ids');
  else bad('a kill carries both ids', JSON.stringify(k));

  // The entity block must still decode when the sender emitted no events at all.
  const bare = decodeSnapshot(encodeSnapshot({ ...snap, events: [] }, null), null);
  if (bare.entities.length === 1 && bare.events.length === 0) ok('a snapshot with no events still decodes');
  else bad('a snapshot with no events still decodes', JSON.stringify(bare).slice(0, 120));
}

// ── the recorder attributes feedback to the right entity ─────────────────────────────
{
  const rec = new RecordingPresenter();
  rec.hitmarker(true, { id: 42 });
  rec.flashDamage(30, { id: 99 });
  rec.muzzleFlash(new THREE.Vector3(1, 2, 3), new THREE.Vector3(0, 0, -1), 0.9, { id: 7 });

  const hm = rec.events.find((e) => e.kind === 'hitmarker');
  if (hm?.to === 42) ok('a hitmarker is addressed to the shooter');
  else bad('a hitmarker is addressed to the shooter', JSON.stringify(hm));

  const dmg = rec.events.find((e) => e.kind === 'damaged');
  if (dmg?.to === 99) ok('a damage flash is addressed to the victim');
  else bad('a damage flash is addressed to the victim', JSON.stringify(dmg));

  const fire = rec.events.find((e) => e.kind === 'fire');
  if (fire && fire.to === null) ok('a gunshot is addressed to everyone');
  else bad('a gunshot is addressed to everyone', JSON.stringify(fire));

  // The respawn clear must never broadcast "you died" to the whole server.
  rec.clear();
  rec.deathScreen(null, { id: 5 });
  const rs = rec.events[0];
  if (rs?.kind === 'respawn' && rs.to === 5) ok('a respawn clear goes only to who respawned');
  else bad('a respawn clear goes only to who respawned', JSON.stringify(rs));
}

// ── end to end: a real shot at a real target over a real socket ──────────────────────
{
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new RecordingPresenter() });
  game.startMatch({ mode: 'tdm', botCount: 2, difficulty: 'regular', seed: 99 });
  game.match.phase = 'live';
  game.match.countdown = 0;

  const server = new GameServer(game);
  const [cT, sT] = createLoopbackPair({ latencyMs: 0, loss: 0 });
  const shooter = game.player;
  const session = server.addClient(sT, shooter);
  const client = new NetClient(cT);

  const received = [];
  client.onSnapshot((s) => { for (const e of s.events || []) received.push(e); });

  // Stand a hostile directly in front, at point-blank, with clear line of sight — this is
  // testing the feedback path, so the shot itself must not be in doubt.
  const victim = game.bots.bots.find((b) => b.team !== shooter.team);
  if (!victim) { bad('there is a hostile bot to shoot', 'none found'); }
  else {
    shooter.position.set(0, 1.0, 0);
    shooter.setAngles(0, 0);
    victim.position.set(0, 1.0, -4);
    victim.velocity.set(0, 0, 0);
    victim.health = 100;
    shooter._updateHitboxes?.();
    victim._updateHitboxes?.();

    const hpBefore = victim.health;
    let ms = 0;
    for (let t = 0; t < 240; t++) {
      const cmd = emptyCommand();
      cmd.tick = client.latestTick;
      cmd.fireHeld = true;
      if (t === 0) cmd.firePressed = true;
      // Hold the pair in place: bot AI would otherwise walk the target out of the shot,
      // and this test is about the feedback, not about whether a bot dodges.
      victim.position.set(0, 1.0, -4);
      shooter.position.set(0, 1.0, 0);
      shooter.setAngles(0, 0);
      client.sendCommand(cmd);
      sT.pump(ms);
      server.tick();
      cT.pump(ms);
      ms += FIXED_DT * 1000;
    }

    const dealt = hpBefore - victim.health + (victim.health > hpBefore ? 100 : 0);
    if (victim.health < hpBefore || received.some((e) => e.kind === 'kill')) {
      ok(`the shot registered on the server (${dealt.toFixed(0)} damage)`);
    } else {
      bad('the shot registered on the server', `victim health unchanged at ${victim.health}`);
    }

    const marks = received.filter((e) => e.kind === 'hitmarker');
    if (marks.length > 0) ok(`the shooter's client received ${marks.length} hitmarkers`);
    else {
      bad("the shooter's client received a hitmarker",
        `damage was dealt but NO hitmarker reached the client — this is exactly the bug.\n` +
        `       events seen: ${JSON.stringify(received.map((e) => e.kind))}`);
    }

    const fires = received.filter((e) => e.kind === 'fire');
    if (fires.length > 0) ok(`gunshots are broadcast (${fires.length} seen)`);
    else bad('gunshots are broadcast', 'no fire events reached the client');
  }
}

// ── humans on a server are not all one team ──────────────────────────────────────────
//
// `Match._assignTeams` pinned every `isPlayer` entity to team 0. On a server that is every
// connected human, so no human could damage another — `damageScale` returns 0 for a
// teammate and `fireHitscan` then discards the hit entirely, producing no hitmarker, no
// blood and no sound. Exactly like the bullet missing.
{
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter() });
  game.startMatch({ mode: 'tdm', botCount: 4, difficulty: 'regular', seed: 7 });
  game.match.phase = 'live';
  game.match.countdown = 0;

  const { Player } = await import('../src/player/player.js');
  const joined = [];
  for (let i = 0; i < 3; i++) {
    const p = new Player(game);
    await p.init();
    game.addEntity(p);
    game.weapons.giveLoadout(p, ['ar_vector', 'pistol_sidewinder']);
    joined.push(p);
  }
  game.match._assignTeams();

  const humans = [game.player, ...joined];
  const teams = humans.map((p) => p.team);
  if (new Set(teams).size > 1) ok(`humans are spread across sides (teams ${teams.join(',')})`);
  else {
    bad('humans are spread across sides',
      `all ${humans.length} human entities are on team ${teams[0]} — none of them can damage ` +
      'any other, and half the bots are their teammates too');
  }

  const foe = joined.find((p) => p.team !== game.player.team);
  if (foe) ok('the local player has at least one human opponent');
  else bad('the local player has a human opponent', `local team ${game.player.team}, others ${teams.join(',')}`);

  // The bot roster must still be split, not collapsed by the rebalance.
  const botTeams = new Set(game.bots.bots.map((b) => b.team));
  if (botTeams.size > 1) ok('bots are still split across both sides');
  else bad('bots are still split across both sides', `all bots on team ${[...botTeams][0]}`);
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nfeedback survives the round trip\n');
process.exit(failures ? 1 : 0);
