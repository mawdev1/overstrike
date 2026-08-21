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

/**
 * MAP: pinned to the MERIDIAN fixture, deliberately.
 *
 * This harness asserts that damage, hitmarkers and kill events survive the round trip from
 * server to client. None of that is about geometry — but it places two players and fires
 * between them, so it needs a map where they can see each other. Left on the rotation it
 * silently followed the rotation onto The Square and reported three failures
 * ("victim health unchanged at 100") that were entirely about that map's in-flight geometry
 * and nothing about feedback routing.
 *
 * map-data.md §9 keeps MERIDIAN registered as the fixture for exactly this: a harness whose
 * subject is not the map should not change its answer when the map does.
 */
const FIXTURE_MAP = 'meridian';

import { encodeSnapshot, decodeSnapshot, EV_KINDS, HELD_BITS, EDGE_BITS } from '../src/net/protocol.js';
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

  // The weapon index rides in the spare bits of the flag byte, so a remote sniper does not
  // sound like a rifle. It must survive alongside the headshot bit, not instead of it.
  const wd = decodeSnapshot(encodeSnapshot({
    ...snap,
    events: [{ kind: 'fire', entityId: 3, weaponIdx: 9, headshot: true, amount: 40000, x: 0, y: 0, z: 0 }],
  }, null), null).events[0];
  if (wd.weaponIdx === 9 && wd.headshot === true) ok('the weapon index shares the flag byte with the headshot bit');
  else bad('the weapon index survives', JSON.stringify(wd));

  // `absorbed` rides another spare bit. Without it a networked shooter saw a NORMAL
  // hitmarker for a round that did nothing to a spawn-protected enemy — a lie, and worse
  // than showing nothing at all.
  const ab = decodeSnapshot(encodeSnapshot({
    ...snap, events: [{ kind: 'hitmarker', absorbed: true, headshot: false }],
  }, null), null).events[0];
  if (ab.absorbed === true && ab.headshot === false) ok('an absorbed hit is marked as such on the wire');
  else bad('absorbed survives the wire', JSON.stringify(ab));

  // The entity block must still decode when the sender emitted no events at all.
  const bare = decodeSnapshot(encodeSnapshot({ ...snap, events: [] }, null), null);
  if (bare.entities.length === 1 && bare.events.length === 0) ok('a snapshot with no events still decodes');
  else bad('a snapshot with no events still decodes', JSON.stringify(bare).slice(0, 120));

  const roundEnd = decodeSnapshot(encodeSnapshot({
    ...snap,
    events: [{ kind: 'roundEnd', killerId: 25, victimId: 19, amount: 25, weaponIdx: 0 }],
  }, null), null).events[0];
  if (roundEnd.kind === 'roundEnd' && roundEnd.killerId === 25
    && roundEnd.victimId === 19 && roundEnd.amount === 25) {
    ok('the authoritative TDM result survives the wire');
  } else bad('the TDM result survives the wire', JSON.stringify(roundEnd));
}

// ── the recorder attributes feedback to the right entity ─────────────────────────────
{
  const rec = new RecordingPresenter();
  rec.hitmarker(true, { id: 42 });
  rec.muzzleFlash(new THREE.Vector3(1, 2, 3), new THREE.Vector3(0, 0, -1), 0.9, { id: 7 });

  const hm = rec.events.find((e) => e.kind === 'hitmarker');
  if (hm?.to === 42) ok('a hitmarker is addressed to the shooter');
  else bad('a hitmarker is addressed to the shooter', JSON.stringify(hm));

  const fire = rec.events.find((e) => e.kind === 'fire');
  if (fire && fire.to === null) ok('a gunshot is addressed to everyone');
  else bad('a gunshot is addressed to everyone', JSON.stringify(fire));

  // The effects a headless server used to drop on the floor entirely.
  rec.clear();
  rec.explosion(new THREE.Vector3(4, 1, 5), 6.5);
  rec.bloodSpray(new THREE.Vector3(1, 1, 1), new THREE.Vector3(0, 1, 0), 1.4);
  rec.flashbang(0.8, 2.5, { id: 77 });

  const ex = rec.events.find((e) => e.kind === 'explosion');
  if (ex && ex.to === null && Math.abs(ex.amount / 100 - 6.5) < 0.02) ok('explosions are broadcast with their radius');
  else bad('explosions are broadcast with their radius', JSON.stringify(ex));

  const bl = rec.events.find((e) => e.kind === 'blood');
  if (bl && bl.to === null) ok('blood is broadcast at the point of the hit');
  else bad('blood is broadcast', JSON.stringify(bl));

  const fb = rec.events.find((e) => e.kind === 'flash');
  if (fb?.to === 77 && Math.abs(fb.amount / 100 - 0.8) < 0.02) ok('a flashbang is routed to who it blinded');
  else bad('a flashbang is routed to who it blinded', JSON.stringify(fb));

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
  await game.initHeadless({ presenter: new RecordingPresenter(), mapId: FIXTURE_MAP });
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

    // The kill event is the one a review caught missing entirely: it used to be routed
    // through `present.killfeed`, which `Match._killfeed` never calls on a headless
    // server. Measured over 60 s of a real match: 9 kills, 0 kill events on the wire.
    const kills = received.filter((e) => e.kind === 'kill');
    if (kills.length > 0) {
      ok(`kills reach the client (${kills.length}, killer ${kills[0].killerId} -> victim ${kills[0].victimId})`);
    } else {
      bad('kills reach the client',
        `the target died on the server but NO kill event was sent — no killfeed, no kill ` +
        `marker, no XP.\n       events seen: ${JSON.stringify([...new Set(received.map((e) => e.kind))])}`);
    }

    // And damage taken must be routed to the victim, with the real damage figure so the
    // flash and the hurt sound scale the way they do in single player.
    const dmgs = received.filter((e) => e.kind === 'damaged');
    if (dmgs.length === 0) ok('the shooter took no damage in this scenario (nothing to route)');
    else if (dmgs.every((d) => d.amount > 1)) ok(`damage events carry real damage (${dmgs.map((d) => d.amount).join(', ')})`);
    else bad('damage events carry real damage', `amounts ${JSON.stringify(dmgs.map((d) => d.amount))} — a 0..1 intensity was sent instead of the damage`);
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
  await game.initHeadless({ presenter: new NullPresenter(), mapId: FIXTURE_MAP });
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

// ── the command a REAL client builds actually contains the trigger ───────────────────
//
// This is the one that mattered. `_buildLocalCommand` filled every edge and the look
// deltas and never wrote a single HELD field — `cmd.fireHeld` was read in three places and
// written in none. So online the server never pulled the trigger for a human player, ever:
// measured on a real browser client, trigger held five seconds, client fired 30 rounds and
// emptied the magazine while the server fired 0 and its ammo stayed at 30. Everything the
// player saw was client-side prediction with nothing authoritative behind it. Melee and
// grenades worked because they ride EDGE bits — exactly the reported shape.
//
// It was invisible to the whole suite because every harness in this repo (this file
// included) hand-builds commands with `fireHeld: true`, constructing the very field the
// real client never sent. So this asserts on `_buildLocalCommand`'s OUTPUT and enumerates
// the wire's own field list rather than a list written out by hand — a ninth held bit
// added tomorrow is covered automatically.
{
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter(), mapId: FIXTURE_MAP });
  game.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 21 });
  game.match.phase = 'live';
  game.match.countdown = 0;
  game.state = 'playing';
  game.paused = false;

  // A stand-in for the browser's input device, with everything pressed at once. Headless
  // has none, and `_refreshHeldState` returns early without one.
  const down = new Set(['forward', 'crouch', 'sprint', 'lean', 'right']);
  game.input = {
    fire: true, aim: true, firePressed: true, aimPressed: true,
    isDown: (k) => down.has(k),
    wasPressed: () => false,
    wasReleased: () => false,
    consumeWheel: () => 0,
    consumeLook: (out) => { out.x = 0; out.y = 0; return out; },
  };

  const p = game.player;
  p._refreshHeldState();
  const cmd = p._buildLocalCommand();

  const missing = HELD_BITS.filter((k) => cmd[k] === undefined);
  if (missing.length === 0) ok(`the built command carries all ${HELD_BITS.length} held fields`);
  else {
    bad('the built command carries every held field',
      `missing: ${missing.join(', ')} — the server can never act on these, and a missing ` +
      '`fireHeld` means it never fires the player\'s gun at all');
  }

  if (cmd.fireHeld === true) ok('holding the trigger produces fireHeld=true');
  else bad('holding the trigger produces fireHeld', `fireHeld=${cmd.fireHeld} while input.fire=true`);

  if (cmd.aimButtonHeld === true) ok('holding aim produces aimButtonHeld=true (ADS reaches the server)');
  else bad('holding aim reaches the server', `aimButtonHeld=${cmd.aimButtonHeld} — every shot would use hip spread`);

  const missingEdge = EDGE_BITS.filter((k) => cmd[k] === undefined);
  if (missingEdge.length === 0) ok(`and all ${EDGE_BITS.length} edge fields`);
  else bad('the built command carries every edge field', `missing: ${missingEdge.join(', ')}`);

  game.input = null;
}

// ── the client shoots with the server's dice ─────────────────────────────────────────
//
// Shot spread and recoil jitter are drawn BY ADDRESS —
// `addressedRNG(game.matchSeed, shooterId * 65537 + shotsFired, ...)` — precisely so the
// same shot produces the same number on every machine. The seed was never sent. `Menu`
// starts a match with no seed, so the client rolls `Math.random()` and only then connects,
// and every predicted bullet came out of a different stream than the one the server fired.
// Measured over 200 rounds of `ar_vector`: mean 2.08 degrees of divergence hip-fire, worst
// 4.60 — 54 cm at 15 m, against a torso about 50 cm wide. The player's own tracers and
// impact decals pointed somewhere the bullet did not go.
{
  const { MultiplayerSession } = await import('../src/net/session.js');
  const sg = new Game({ headless: true });
  await sg.initHeadless({ presenter: new RecordingPresenter(), mapId: FIXTURE_MAP });
  sg.startMatch({ mode: 'tdm', killLimit: 9, botCount: 2, difficulty: 'regular', seed: 0xABCDEF });
  sg.match.phase = 'live'; sg.match.countdown = 0;

  const cg = new Game({ headless: true });
  await cg.initHeadless({ presenter: new NullPresenter(), mapId: FIXTURE_MAP });
  cg.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular' });   // no seed, exactly as the menu does
  cg.match.phase = 'live'; cg.match.countdown = 0;
  const rolledItsOwn = cg.matchSeed;

  const server = new GameServer(sg);
  const [cT, sT] = createLoopbackPair({ latencyMs: 0, loss: 0 });
  server.addClient(sT, sg.player);
  const session = new MultiplayerSession(cg, cT);
  let ms = 0;
  for (let i = 0; i < 30; i++) { sT.pump(ms); server.tick(); cT.pump(ms); ms += FIXED_DT * 1000; }

  if (rolledItsOwn === sg.matchSeed) {
    bad('the seed test is meaningful', 'the client happened to roll the server seed — rerun');
  } else if (cg.matchSeed === sg.matchSeed) {
    ok(`the client adopts the server's match seed (${rolledItsOwn} -> ${cg.matchSeed})`);
  } else {
    bad("the client adopts the server's match seed",
      `client ${cg.matchSeed} vs server ${sg.matchSeed} — every predicted shot's spread is ` +
      'drawn from a different stream than the one the server fires');
  }

  if (cg.match.killLimit === 9 && cg.settings.get('killLimit') === 9) {
    ok('the client adopts the server TDM kill limit');
  } else {
    bad('the client adopts the server TDM kill limit',
      `match=${cg.match.killLimit}, setting=${cg.settings.get('killLimit')}`);
  }

  // A late joiner may not possess every earlier kill event. The authoritative roundEnd
  // event must still put it into the same results state as the host.
  sg.match.killLimit = 1;
  server.broadcastWelcome();
  for (let i = 0; i < 5; i++) { sT.pump(ms); server.tick(); cT.pump(ms); ms += FIXED_DT * 1000; }
  let clientEnds = 0;
  cg.bus.on('matchEnd', () => clientEnds++);
  const finalVictim = sg.bots.bots.find((b) => b.team !== sg.player.team);
  finalVictim?.die({ attacker: sg.player, weaponId: 'ar_vector' });
  for (let i = 0; i < 8; i++) { server.tick(); cT.pump(ms); ms += FIXED_DT * 1000; }
  if (cg.state === 'gameover' && cg.match.result?.reason === 'killLimit' && clientEnds === 1) {
    ok('the authoritative final kill runs the client end-of-round sequence once');
  } else {
    bad('the authoritative final kill ends the client round',
      `state=${cg.state}, reason=${cg.match.result?.reason}, events=${clientEnds}`);
  }
  session.dispose?.();
}

// ── the server shoots the gun the player actually picked ─────────────────────────────
//
// Nothing carried the loadout, so the server armed every client with the default
// `ar_vector` whatever they chose in the armoury. While the trigger never reached the
// server at all this was invisible; the moment it did, it became the visible bug — pick the
// DMR and the client shows one aimed shot while the server empties 34 full-auto rounds,
// with the wrong damage, fire rate, falloff and magazine, and a crosshair up to 4.2 degrees
// off the authoritative gun (110 cm at 15 m).
{
  const { MultiplayerSession } = await import('../src/net/session.js');
  const sg = new Game({ headless: true });
  await sg.initHeadless({ presenter: new RecordingPresenter(), mapId: FIXTURE_MAP });
  sg.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 5 });
  sg.match.phase = 'live'; sg.match.countdown = 0;

  const cg = new Game({ headless: true });
  await cg.initHeadless({ presenter: new NullPresenter(), mapId: FIXTURE_MAP });
  cg.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 5 });
  cg.match.phase = 'live'; cg.match.countdown = 0;
  cg.weapons.giveLoadout(cg.player, ['dmr_meridian', 'pistol_viper']);

  const server = new GameServer(sg);
  const [cT, sT] = createLoopbackPair({ latencyMs: 0, loss: 0 });
  server.addClient(sT, sg.player);
  const s2 = new MultiplayerSession(cg, cT);
  s2.connected = true; cg.net = s2;
  s2.sendLoadout();
  let ms2 = 0;
  for (let i = 0; i < 20; i++) { sT.pump(ms2); server.tick(); cT.pump(ms2); ms2 += FIXED_DT * 1000; }

  const ids = (g2, p2) => g2.weapons.getLoadout(p2)?.weapons.map((w) => w.def.id).join(',');
  const want = ids(cg, cg.player);
  if (ids(sg, sg.player) === want) ok(`the server arms the client's own loadout (${want})`);
  else bad("the server arms the client's loadout", `server has ${ids(sg, sg.player)}, client picked ${want}`);

  // And it must survive a death: `respawn` re-gives the default.
  sg.player.respawn?.();
  for (let i = 0; i < 10; i++) { sT.pump(ms2); server.tick(); cT.pump(ms2); ms2 += FIXED_DT * 1000; }
  if (ids(sg, sg.player) === want) ok('and it survives a respawn');
  else bad('the loadout survives a respawn', `server rearmed to ${ids(sg, sg.player)} — the default`);
}

// ── a spawn-protected enemy is not a miss ────────────────────────────────────────────
//
// `damageScale` returns 0 for a protected target and `fireHitscan` used to null the entity
// hit entirely, so the round carried on and painted a concrete impact on the wall behind.
// From behind the screen a perfectly aimed shot was indistinguishable from a miss — and
// measured, 7-24% of a player's on-target shots land on a protected bot, because fights
// cluster on spawns and a freshly spawned enemy is the obvious target.
{
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter(), mapId: FIXTURE_MAP });
  game.startMatch({ mode: 'tdm', botCount: 2, difficulty: 'regular', seed: 11 });
  game.match.phase = 'live';
  game.match.countdown = 0;

  const shooter = game.player;
  const victim = game.bots.bots.find((b) => b.team !== shooter.team);
  const { fireHitscan } = await import('../src/weapons/ballistics.js');

  const stage = () => {
    shooter.position.set(0, 1.0, 0);
    shooter.setAngles(0, 0);
    victim.position.set(0, 1.0, -4);
    victim.health = 100;
    victim.alive = true;
    shooter._updateHitboxes?.();
    victim._updateHitboxes?.();
  };
  const shoot = () => {
    const origin = new THREE.Vector3();
    shooter.getEyePosition(origin);
    const dir = new THREE.Vector3(victim.position.x - origin.x, (victim.position.y + 1.0) - origin.y, victim.position.z - origin.z).normalize();
    return fireHitscan(game, {
      shooter, origin, dir, damage: 30, range: 100,
      falloffStart: 100, falloffEnd: 100, falloffMin: 1, penetration: 1, headshotMul: 2,
      weaponId: 'ar_vector', emitShot: false, tracer: false,
    });
  };

  stage();
  game.match.clearProtection?.(victim);
  const normal = shoot();
  if (normal?.hitEntity === victim && normal.damageDealt > 0) ok(`an unprotected enemy takes the shot (${normal.damageDealt.toFixed(0)} damage)`);
  else bad('an unprotected enemy takes the shot', JSON.stringify({ hit: !!normal?.hitEntity, dmg: normal?.damageDealt }));

  stage();
  game.match._protect.set(victim.id, game.match.elapsed + 5);
  const prot = shoot();
  if (prot?.hitEntity === victim) ok('a spawn-protected enemy still registers as a hit ON THEM');
  else {
    bad('a spawn-protected enemy registers as a hit',
      `the round passed through and reported surface "${prot?.surface}" — from behind the ` +
      'screen that is a miss, and the shooter never learns their aim was good');
  }
  if (prot?.absorbed === true && prot.damageDealt === 0) ok('and it is reported as absorbed, dealing no damage');
  else bad('the protected hit is absorbed', JSON.stringify({ absorbed: prot?.absorbed, dmg: prot?.damageDealt }));
  if (victim.health === 100) ok('the protected target really took no damage');
  else bad('the protected target takes no damage', `health ${victim.health}`);

  // The `absorbed` flag lives on POOLED objects. Left set, it labelled the next clean
  // miss — and a real explosion, and a real knife — as having done nothing.
  stage();
  game.match._protect.set(victim.id, game.match.elapsed + 5);
  shoot();
  stage();
  game.match._protect.delete(victim.id);
  shooter.setAngles(Math.PI / 2, 0);      // aim at nothing
  const miss = (() => {
    const origin = new THREE.Vector3();
    shooter.getEyePosition(origin);
    const dir = new THREE.Vector3(1, 0, 0);
    return fireHitscan(game, {
      shooter, origin, dir, damage: 30, range: 100,
      falloffStart: 100, falloffEnd: 100, falloffMin: 1, penetration: 1, headshotMul: 2,
      weaponId: 'ar_vector', emitShot: false, tracer: false,
    });
  })();
  if (miss?.absorbed === false) ok('the absorbed flag is cleared for the next shot');
  else bad('the absorbed flag is per-shot', `a shot that hit ${miss?.hitEntity ? 'an entity' : 'nothing'} reported absorbed=${miss?.absorbed}`);

  // An absorbed round must not be credited as a hit, or accuracy reads 100% for 0 damage.
  stage();
  game.match._protect.set(victim.id, game.match.elapsed + 5);
  const stBefore = game.match.statsFor?.(shooter)?.shotsHit ?? 0;
  shoot();
  const stAfter = game.match.statsFor?.(shooter)?.shotsHit ?? 0;
  if (stAfter === stBefore) ok('an absorbed round is not credited as a hit');
  else bad('an absorbed round is not credited', `shotsHit ${stBefore} -> ${stAfter} for zero damage`);
  game.match._protect.delete(victim.id);

  // A TEAMMATE must still not register — a hitmarker for a friendly is a lie.
  stage();
  game.match.clearProtection?.(victim);
  const savedTeam = victim.team;
  victim.team = shooter.team;
  const friendly = shoot();
  victim.team = savedTeam;
  if (!friendly?.hitEntity) ok('a teammate still does not register as a hit at all');
  else bad('a teammate does not register', `hitEntity set, absorbed=${friendly.absorbed} — friendly fire should pass through`);

  // ...and, the part that was actually broken: the round must CONTINUE past them.
  //
  // The old code ran the raycast normally and nulled the result afterwards, with a comment
  // claiming "the round passes through instead". It did not — after `ent = null` the
  // segment loop had only the wall branch left, so nothing beyond the discarded body was
  // ever tested. A friendly anywhere in the line swallowed the whole burst in silence.
  // Measured: 60 rounds at a clearly visible enemy 8 m away, perfect aim, ZERO damage.
  // It falls hardest on a human, who pushes with friendly bots around them while bots
  // engage spread out — which is exactly "my shots do not land but the bots are fine".
  const mate = game.bots.bots.find((b) => b.team === shooter.team && b !== victim);
  if (!mate) { bad('there is a teammate bot to stand in the way', 'none found'); }
  else {
    stage();
    game.match.clearProtection?.(victim);
    game.match._protect.delete(victim.id);
    game.match._protect.delete(mate.id);
    mate.position.set(0, 1.0, -2);          // directly between shooter (z=0) and victim (z=-4)
    mate.alive = true; mate.health = 100;
    mate._updateHitboxes?.();
    const through = shoot();
    if (through?.hitEntity === victim && through.damageDealt > 0) {
      ok(`a round passes THROUGH a teammate and hits the enemy behind (${through.damageDealt.toFixed(0)} damage)`);
    } else {
      bad('a round passes through a teammate',
        `hitEntity ${through?.hitEntity?.id ?? 'null'}, damage ${through?.damageDealt ?? 0}, ` +
        `enemy health ${victim.health} — a friendly in the line is eating the whole burst`);
    }
  }
}

// ── the client believes the server about being alive ─────────────────────────────────
//
// `Prediction._correct` set health, armour, height and lean and never touched `alive`, and
// it only ran when the POSITION had also mispredicted. Two consequences, both severe:
// a player standing still while being shot watched their HUD hold at 100, and a player the
// server had killed went on believing they were alive indefinitely. The server discards a
// dead player's commands, so from that moment every shot they fired silently did nothing.
{
  const { MultiplayerSession } = await import('../src/net/session.js');
  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter(), mapId: FIXTURE_MAP });
  game.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 3 });
  game.match.phase = 'live';
  game.match.countdown = 0;

  const cgame = new Game({ headless: true });
  await cgame.initHeadless({ presenter: new NullPresenter() });
  cgame.startMatch({ mode: 'tdm', botCount: 0, difficulty: 'regular', seed: 3 });
  cgame.match.phase = 'live';
  cgame.match.countdown = 0;

  const server = new GameServer(game);
  const [cT, sT] = createLoopbackPair({ latencyMs: 0, loss: 0 });
  server.addClient(sT, game.player);
  const session = new MultiplayerSession(cgame, cT);

  let ms = 0;
  const step = (n) => {
    for (let i = 0; i < n; i++) {
      const cmd = emptyCommand();
      cmd.tick = session.net.latestTick;
      if (session.connected) session.sendCommand(cmd);
      sT.pump(ms);
      server.tick();
      cT.pump(ms);
      ms += FIXED_DT * 1000;
    }
  };
  // Let the welcome land, then bind exactly as `MultiplayerSession.connect` does.
  step(20);
  if (session.net.entityId) {
    cgame.player.id = session.net.entityId;
    const { Prediction } = await import('../src/net/prediction.js');
    session.prediction = new Prediction(cgame, cgame.player, session.net);
    session.connected = true;
  }
  step(40);

  // Hurt the server's copy while the client stands perfectly still, so position never
  // mispredicts and the old code path would never have run at all.
  game.player.health = 42;
  step(30);
  // Compared against the server's health NOW, not against 42: health regenerates, so the
  // authoritative value has moved on by the time the snapshot lands. What matters is that
  // the client tracks it rather than sitting at full.
  const sh = game.player.health;
  const ch = cgame.player.health;
  if (Math.abs(ch - sh) < 2 && ch < 95) ok(`health syncs on a perfect position prediction (${ch.toFixed(0)} vs ${sh.toFixed(0)})`);
  else bad('health syncs while standing still', `client ${ch.toFixed(1)}, server ${sh.toFixed(1)}`);

  // The side we are on is the server's to decide. Forcing the server's copy onto team 1
  // must reach the client, or its rigs are coloured against the wrong allegiance.
  game.player.team = 1;
  step(30);
  if (cgame.player.team === 1) ok('the client adopts the team the server put it on');
  else {
    bad('the client adopts its team',
      `server team 1, client team ${cgame.player.team} — every teammate would be drawn in ` +
      'enemy colours and every enemy in friendly colours');
  }

  // Now kill it outright.
  game.player.die?.(null);
  step(40);
  if (!cgame.player.alive) ok('the client learns it is dead');
  else {
    bad('the client learns it is dead',
      'server says dead, client still alive — every shot this player fires from now on is ' +
      'discarded by the server and they will never see a hit again');
  }
}

console.log(failures ? `\n${failures} check(s) failed\n` : '\nfeedback survives the round trip\n');
process.exit(failures ? 1 : 0);
