/**
 * The client's multiplayer session.
 *
 * Ties the transport, the protocol, prediction and the local simulation together into the
 * one object a page needs. Opt-in by construction: nothing here runs unless a server URL
 * is configured, so single player stays exactly what it was — its own simulation in its
 * own tab, with no dependency on any of this being reachable.
 *
 * Remote players are held as plain state rather than as `Player` instances. A remote
 * player is not simulated locally — the server owns them — so giving them a full Player
 * would mean a movement integrator running on data it does not own, fighting the
 * snapshots that are the actual truth. What a client needs from them is where to draw
 * them and where they were, and that is what this keeps.
 */
import { NetClient, INTERP_DELAY_MS } from './client.js';
import { WebSocketTransport } from './transport.js';
import { Prediction } from './prediction.js';
import {
  quantiseCommand, encodeLoadout, F_ALIVE, F_CROUCH, F_SPRINT, F_FIRING, F_ADS, F_RELOAD,
  unpackInteract,
} from './protocol.js';
import { WEAPON_WIRE_IDX } from '../weapons/weaponDefs.js';
import { FIXED_DT } from '../core/mathUtils.js';
import { RemoteAvatars } from './avatars.js';
import * as THREE from 'three';
import { WEAPON_BY_WIRE_IDX } from '../weapons/weaponDefs.js';

/** Scratch for replayed effects. Module scope: nothing survives a synchronous call. */
const _fx = new THREE.Vector3();
const _fdir = new THREE.Vector3(0, 0, -1);
const _fup = new THREE.Vector3(0, 1, 0);

/**
 * Beyond this, a remote effect is not drawn.
 *
 * `fx.muzzleFlash` never rejects on distance — it only chooses view-space vs world-space
 * under 1.2 m — so replaying every shot on the map meant hundreds of flash sprites and
 * lights a second, nearly all of them behind walls or past the far side of the level.
 * Audio already culls itself (`audio.js` drops past MAX_DISTANCE and has a voice budget),
 * so this is about VFX churn. 70 m comfortably covers the longest sightline here.
 */
const EFFECT_RANGE_M = 70;
const EFFECT_RANGE_SQ = EFFECT_RANGE_M * EFFECT_RANGE_M;

export class MultiplayerSession {
  constructor(game, transport) {
    this.game = game;
    this.transport = transport;
    this.net = new NetClient(transport);
    this.prediction = null;
    /** id -> latest interpolated remote state */
    this.remotes = new Map();
    this.connected = false;
    /**
     * Whether we have adopted the server's clock and position yet.
     *
     * A joining client's simulation starts at tick 0 with the player wherever a local
     * `startMatch` put them, while the server is thousands of ticks in with that entity
     * somewhere else entirely. Until the two are reconciled ONCE, deliberately and at
     * join time, every snapshot looks like a catastrophic misprediction and no snapshot
     * can be found to interpolate against — the tick numbers do not even overlap.
     */
    this.synced = false;
    /** Rigs for everyone this client does not simulate. Built lazily, browser only. */
    this.avatars = null;
    this.stats = { commandsSent: 0, joinCorrectionM: 0 };
    /** id -> stand-in object, so kill events can be identity-compared. See `_entityFor`. */
    this._stubs = new Map();

    /**
     * Newest authoritative Bomb state, or null in TDM. Read by the HUD.
     *
     * Held as decoded, never extrapolated. `interaction.progress` in particular is
     * server-driven: a plant bar that keeps filling through a dropped packet tells the player
     * they are safe when the server has already cancelled the plant.
     */
    this.matchState = null;
    /** Newest round or match outcome, or null. */
    this.outcome = null;

    /** Held objective intent supplied by the facade. The server still derives which
     * interaction is legal from authoritative role/phase and validates every tick. */
    this.interactionKind = null;

    transport.onClose?.((info) => {
      const wasConnected = this.connected;
      this.connected = false;
      this.game.bus?.emit?.('netDisconnected', {
        reason: info?.reason || 'socket-closed', code: info?.code ?? null, wasConnected,
      });
    });

    this.net.onSnapshot((snap) => this._onSnapshot(snap));
    this.net.onMatchState((s) => {
      this.matchState = s;
      this.game.bus?.emit?.('matchState', s);
    });
    this.net.onOutcome((o) => {
      this.outcome = o;
      this.game.bus?.emit?.(o.scope === 'match' ? 'matchOutcome' : 'roundOutcome', o);
    });
    this.net.onTacticalPing((ping) => this.game.bus?.emit?.('tacticalPing', ping));
    this.net.onReject((r) => {
      this.connected = false;
      this.game.bus?.emit?.('netRejected', r);
    });
    // Adopting the seed is not bookkeeping: every shot's spread is addressed by it, so
    // until this runs the client predicts a different bullet than the server fires.
    this.net.onWelcome((net) => {
      if (net.matchSeed != null && this.game.matchSeed !== net.matchSeed) {
        this.game.matchSeed = net.matchSeed;
        this.game.rng?.reseed?.(net.matchSeed);
      }
      // The host owns the round rules. Without this field a client configured for 75
      // kills could stay in combat after a first-to-25 server had already ended.
      if (net.killLimit != null) {
        this.game.settings?.set?.('killLimit', net.killLimit);
        if (this.game.match) this.game.match.killLimit = net.killLimit;
      }
    });
  }

  /**
   * Open a session. Resolves once the server has said who we are — until then the client
   * does not know which entity in the snapshots is itself, so sending commands would be
   * predicting on behalf of nobody.
   */
  // 30 s, not 10. Fly's proxy holds a WebSocket upgrade for 12-16 s once the app's
  // connection limits are reached (measured), so a 10 s deadline turned a slow admission
  // into a failed match: `transport.close()` on a socket still CONNECTING is exactly what
  // makes the browser print "WebSocket is closed before the connection is established".
  // The limits themselves are raised in fly.gameserver.toml; this is the second line of
  // defence, so any future proxy stall degrades to a slow join rather than a dead one.
  static connect(game, url, { timeoutMs = 30000, sessionTicket = '' } = {}) {
    return new Promise((resolve, reject) => {
      let transport;
      try { transport = new WebSocketTransport(url); } catch (e) { reject(e); return; }
      const session = new MultiplayerSession(game, transport);
      // The opening frame (§8.2). `WebSocketTransport` queues until the socket is open, so
      // this is genuinely first on the wire rather than first in wall-clock order.
      session.net.sendHello(sessionTicket);

      const started = Date.now();
      const poll = setInterval(() => {
        // A refused handshake is terminal and must fail the connect rather than time out —
        // a ten-second wait for a server that already said "upgrade" tells the player
        // nothing and invites a retry that cannot succeed.
        if (session.net.rejected) {
          clearInterval(poll);
          const r = session.net.rejected;
          const err = new Error(r.message);
          err.code = r.reason;
          err.serverVersion = r.serverVersion;
          err.retryable = false;
          transport.close();
          reject(err);
          return;
        }
        if (session.net.entityId) {
          clearInterval(poll);
          session.connected = true;
          // Set here, not only by the menu: several things ask `game.net` to decide who
          // owns a rule (respawning, above all), and a session opened by a test or a tool
          // must answer that question the same way one opened by the UI does.
          game.net = session;
          session.sendLoadout();
          // The armoury re-equips on every spawn (see `Menu`), so follow it.
          session._offLoadout = game.bus?.on?.('spawn', (p) => {
            if (p?.entity === game.player) session.sendLoadout();
          });
          // The server told us which entity we drive. Bind the local player to that id so
          // snapshots about us are recognised as us.
          //
          // The referee's books are keyed by entity id and `startMatch()` has already filed
          // this player under the LOCAL id (gameRuntime starts the match before promoting the
          // reservation), so the row has to follow the id. Skipping this left
          // `Match.getPlayerStats()` — the only source the pause SITUATION panel has — looking
          // up an id nothing was ever filed under, and "YOUR LINE" rendered empty.
          if (game.player) {
            const previousId = game.player.id;
            game.player.id = session.net.entityId;
            game.match?.rekeyEntity?.(previousId, session.net.entityId);
            game.rosterChanged?.();
          }
          session.prediction = new Prediction(game, game.player, session.net);
          resolve(session);
          return;
        }
        if (transport.closed) { clearInterval(poll); reject(new Error('socket closed before welcome')); return; }
        if (Date.now() - started > timeoutMs) {
          clearInterval(poll);
          transport.close();
          reject(new Error(`no welcome from ${url} within ${timeoutMs} ms`));
        }
      }, 20);
    });
  }

  /**
   * Send one command and predict it locally.
   *
   * Called once per fixed step. The command is quantised inside `sendCommand`, and
   * prediction runs on the SAME object afterwards, so the client predicts from exactly
   * the values the server will decode.
   */
  sendCommand(cmd) {
    if (!this.connected) return null;
    // The absolute-aim checksum has to be the client's real aim; a constant here makes
    // the server think we have desynced and snap our aim on every command.
    const p = this.game.player;
    if (p) { cmd.baseYaw = p.baseYaw; cmd.basePitch = p.basePitch; }
    // The newest SERVER tick we have seen. The server subtracts this from its own tick to
    // get our round trip, which is what decides how far it rewinds for our shots — so
    // this is not bookkeeping, it is what makes lag compensation work at all.
    cmd.tick = this.net.latestTick;
    const sent = this.net.sendCommand(cmd);
    this.stats.commandsSent++;
    this.prediction?.predict(sent);
    return sent;
  }

  /**
   * One simulation step, in multiplayer.
   *
   * Called by `Game._loop` in place of `_fixedUpdate` — prediction runs the step itself,
   * so doing both would simulate every tick twice.
   *
   * The command is built from the local input exactly as single player builds it, which
   * is the point of the Phase 2 command work: the same `_buildLocalCommand` resolves
   * settings-dependent intent (toggle-vs-hold crouch, autoSprint, sensitivity) here as
   * there, so the server receives resolved intent it could not have derived itself.
   */
  step() {
    const p = this.game.player;
    if (!this.connected || !p) { this.game._fixedUpdate(FIXED_DT); return; }

    // Held state has to be refreshed from the live input every step, not once a frame —
    // the same reason `_refreshHeldState` exists on the single-player path.
    p._refreshHeldState?.();
    const cmd = p._buildLocalCommand();
    // Plant/defuse is a held interaction (§6/§7), not a one-frame edge. `_buildLocalCommand`
    // has already read the physical key as a hold (`interactHeld`, `HELD_BITS` bit 8); the
    // facade can hold the same intent for an accessible control, so the two are OR'd.
    //
    // This used to write `cmd.interact`, which is the EDGE bit — the only interact field the
    // wire had — so it overwrote the tap edge with a hold AND still arrived at the server as
    // one `true` followed by `false` on every subsequent command. The server's
    // `_objectiveHeld = !!cmd.interact` then reset the plant every tick and no human could
    // finish one. Both facts now have their own bit and neither overwrites the other.
    cmd.interactHeld = !!cmd.interactHeld || !!this.interactionKind;
    // A fresh object per command: `_cmdScratch` is reused in place, and the unacked
    // queue keeps commands for resending and replay, so handing it the scratch would
    // give every queued command the newest command's contents.
    this.sendCommand({ ...cmd });
  }

  /**
   * Tell the server which guns we picked.
   *
   * Nothing carried this, so the server armed everyone with the default `ar_vector`
   * whatever they chose. Called on join and again whenever the armoury re-equips, and the
   * server remembers it — `Player.respawn` re-gives the default loadout, so without that
   * the choice would survive exactly until the first death.
   */
  sendLoadout() {
    const lo = this.game.weapons?.getLoadout?.(this.game.player);
    const ids = lo?.weapons?.map((w) => w.def?.id).filter(Boolean) ?? [];
    if (ids.length === 0) return;
    const idx = ids.slice(0, 2).map((id) => WEAPON_WIRE_IDX.get(id) ?? 0);
    while (idx.length < 2) idx.push(idx[0] ?? 0);
    this.transport.send(encodeLoadout(idx[0], idx[1]));
  }

  requestInteraction(kind) {
    if (kind !== 'plant' && kind !== 'defuse') return false;
    this.interactionKind = kind;
    return true;
  }

  releaseInteraction() { this.interactionKind = null; }

  requestTacticalPing(kind = 'location') { return this.net.sendTacticalPing(kind); }

  _onSnapshot(snap) {
    if (!this.synced) this._syncToServer(snap);
    else this.prediction?.reconcile(snap);
    this.game.bus?.emit?.('netSnapshot', { tick: snap.tick, keyframe: !!snap.keyframe });
    if (snap.events?.length) this._replayEvents(snap.events);
  }

  /**
   * Turn the server's recorded feedback back into things the player can see and hear.
   *
   * The mirror of `RecordingPresenter`: the server resolved these shots and knew exactly
   * what should have been presented, but it has no screen. This is the screen. Everything
   * goes through `game.present` rather than touching the HUD directly, so multiplayer
   * feedback and single-player feedback are the same code and cannot drift apart.
   *
   * Note what is deliberately NOT here: the local player's own gunshot and muzzle flash.
   * Those are predicted client-side the instant the trigger is pulled, and replaying the
   * server's copy a round trip later would double every shot.
   */
  _replayEvents(events) {
    const g = this.game;
    const present = g.present;
    if (!present) return;
    const mineId = this.net.entityId;

    for (const ev of events) {
      g.bus?.emit?.('netEvent', ev);
      switch (ev.kind) {
        case 'hitmarker':
          present.hitmarker(ev.headshot, null, false, ev.absorbed);
          if (ev.absorbed) present.playUI('hitmarker', { volume: 0.3, rate: 0.7 });
          else present.playUI(ev.headshot ? 'headshot' : 'hitmarker', { volume: 0.6 });
          // ACCURACY in the pause SITUATION panel is `shotsHit / shotsFired` off the local
          // book. `shotsFired` is booked locally (ballistics emits `shot` for our own trigger
          // pull), but `shotsHit` never was online: remote players are avatar stand-ins, not
          // `game.entities`, so local hitscan cannot hit one and the local `hit` event never
          // fires. Every networked player therefore read 0% accuracy for the whole match.
          //
          // This hitmarker is the SERVER's own confirmation that our round landed — it is
          // routed to the shooter alone (`presenter.js` `_push('hitmarker', owner?.id, …)`) —
          // so it is exactly the fact `shotsHit` wants. `Match._onHit` rejects `absorbed`
          // itself and its `_hitThisShot` latch books one hit per shot however many rounds
          // connect, so a client that somehow booked the hit locally too cannot double-count.
          g.bus?.emit?.('hit', { shooter: g.player, absorbed: ev.absorbed, headshot: ev.headshot });
          break;

        case 'fire': {
          if (ev.entityId === mineId) break;            // already presented locally
          // Fire from where the SERVER said the muzzle was, not from the interpolated
          // avatar: the avatar is ~100 ms behind, and a flash offset from the gun that
          // made it is more distracting than no flash at all.
          _fx.set(ev.x, ev.y, ev.z);
          const def = WEAPON_BY_WIRE_IDX[ev.weaponIdx] || null;
          // The heading came quantised in `amount`. Without it every remote flash pointed
          // due north regardless of where the shooter was actually looking.
          const yaw = (ev.amount / 65535) * Math.PI * 2 - Math.PI;
          _fdir.set(Math.sin(yaw), 0, Math.cos(yaw));
          if (this._near(_fx)) present.muzzleFlash(_fx, _fdir, def?.class === 'sniper' || def?.class === 'lmg' ? 1.35 : 0.9);
          // Audio is NOT distance-culled here — it culls itself, and a shot you cannot see
          // is exactly the one you most need to hear.
          present.play(def?.audio?.fire ?? 'rifle', { position: _fx, volume: 0.9 });
          break;
        }

        case 'explosion':
          _fx.set(ev.x, ev.y, ev.z);
          if (this._near(_fx)) present.explosion(_fx, ev.amount / 100);
          break;

        case 'blood':
          _fx.set(ev.x, ev.y, ev.z);
          // The surface normal is not on the wire; straight up reads correctly for a spray
          // and costs nothing.
          if (this._near(_fx)) present.bloodSpray(_fx, _fup, ev.amount / 100);
          break;

        case 'flash': {
          // Routed to us specifically. Without this an enemy flashbang did nothing at all
          // online — not a missing effect, a missing game mechanic.
          const amt = ev.amount / 100;
          const dur = ev.victimId / 100;
          present.flashbang(amt, dur);
          present.play('explosion', { volume: 0.5, rate: 0.35 });
          g.bus?.emit('flashbang', { amount: amt, duration: dur, position: g.player?.position });
          break;
        }

        case 'damaged': {
          // The same two calls `Player.applyDamage` makes locally, from the same raw
          // damage figure — so a graze and a sniper round look and sound as different here
          // as they do in single player. An earlier version sent a 0..1 intensity and
          // divided it by 55 again on arrival, which pinned every hit to the minimum.
          _fx.set(ev.x, ev.y, ev.z);
          g.bus?.emit('playerDamaged', { entity: g.player, amount: ev.amount, dirWorld: _fx });
          present.flashDamage(Math.max(0.12, Math.min(1, ev.amount / 55)));
          present.play('hurt', { volume: Math.max(0.45, Math.min(1, 0.45 + ev.amount / 90)) });
          break;
        }

        case 'kill':
          // Re-emitted onto the local bus rather than pushed at the HUD, because the HUD
          // already subscribes to `kill` and does far more with it than draw a killfeed
          // row: the kill hitmarker, XP pops, the streak chip, the death screen. Feeding
          // the bus gets all of that for free and keeps one code path.
          //
          // The listeners compare entity IDENTITY (`p.attacker === me`), and the wire
          // carries only ids, so both ends are resolved to stable objects first.
          g.bus?.emit('kill', {
            attacker: this._entityFor(ev.killerId),
            victim: this._entityFor(ev.victimId),
            headshot: ev.headshot,
            killer: this._nameFor(ev.killerId),
            victimName: this._nameFor(ev.victimId),
            killerTeam: this._teamFor(ev.killerId),
            victimTeam: this._teamFor(ev.victimId),
            mine: ev.killerId === mineId || ev.victimId === mineId,
          });
          break;

        case 'death':
          if (ev.victimId !== mineId) break;
          present.deathScreen({
            killer: null,
            killerName: this._nameFor(ev.killerId),
            killerHealth: this.remotes.get(ev.killerId)?.health ?? 0,
            respawnIn: (ev.amount || 0) / 100,
          });
          break;

        case 'respawn':
          present.deathScreen(null);
          break;

        case 'roundEnd': {
          const match = g.match;
          if (!match) break;
          match.scores[0] = ev.killerId;
          match.scores[1] = ev.victimId;
          match.killLimit = ev.amount || match.killLimit;
          // A client that saw every kill will already have ended itself from the final
          // kill event immediately before this one. A late joiner will not have the full
          // score history, so the authoritative whistle completes its sequence here.
          if (match.phase !== 'ended') {
            const reason = ev.weaponIdx === 1 ? 'time' : ev.weaponIdx === 2 ? 'draw' : 'killLimit';
            const winnerTeam = reason === 'draw' || ev.killerId === ev.victimId
              ? -1 : (ev.killerId > ev.victimId ? 0 : 1);
            match._end({
              winner: winnerTeam,
              winnerTeam,
              winnerEntity: null,
              reason,
            });
          }
          break;
        }

        // ── Bomb (§8.7) ──────────────────────────────────────────────────────────────
        //
        // Re-emitted onto the local bus rather than pushed at the HUD, for the same reason
        // `kill` is: the HUD already subscribes and does more with each than one call could
        // express, and one code path is how single-player and multiplayer feedback stay the
        // same thing. Nothing here CHANGES any state — the server owns the round, and a
        // client that acted on `plantComplete` locally would be simulating the objective.
        case 'plantStart': case 'plantComplete': case 'plantCancel':
        case 'defuseStart': case 'defuseComplete': case 'defuseCancel':
        case 'bombDropped': case 'bombPickedUp': case 'bombDetonated':
        case 'roundStart':
          g.bus?.emit('objective', {
            kind: ev.kind,
            actor: this._entityFor(ev.entityId),
            actorId: ev.entityId ?? 0,
            actorName: this._nameFor(ev.entityId),
            mine: ev.entityId === mineId,
            reason: ev.reasonName ?? null,
            position: ev.x === undefined ? null : { x: ev.x, y: ev.y, z: ev.z },
          });
          break;

        case 'interactRefused':
          // Routed to this player alone (§8.7). It carries BOTH what they asked for and why
          // it was refused, because a refusal is not a cancellation: nothing had started, so
          // there is no progress to unwind and the message the player needs is different.
          g.bus?.emit('interactionRefused', {
            kind: ev.requestedKindName ?? 'none',
            reason: ev.reasonName ?? 'not-eligible',
          });
          break;

        default: break;                                  // a kind this build does not know
      }
    }
  }

  /** Best available display name for a networked id. Ids are all the wire carries. */
  _nameFor(id) {
    if (!id) return 'UNKNOWN';
    if (id === this.net.entityId) return this.game.player?.name || 'YOU';
    return `PLAYER ${id}`;
  }

  /** Is this world point close enough to be worth drawing an effect for? */
  _near(point) {
    const p = this.game.player?.position;
    if (!p) return true;
    const dx = point.x - p.x;
    const dy = point.y - p.y;
    const dz = point.z - p.z;
    return dx * dx + dy * dy + dz * dz <= EFFECT_RANGE_SQ;
  }

  _teamFor(id) {
    if (!id) return -1;
    if (id === this.net.entityId) return this.game.player?.team ?? -1;
    return this.remotes.get(id)?.team ?? -1;
  }

  /**
   * A stable object for a networked id, so identity comparisons work.
   *
   * The HUD asks `p.attacker === game.player` to decide whether a kill was yours. That is
   * an identity test, and the wire has only numbers — so our own id must resolve to the
   * real local Player, and everyone else to one cached stand-in each. Caching matters: a
   * fresh object per event would compare unequal to itself between two kills.
   */
  _entityFor(id) {
    if (!id) return null;
    if (id === this.net.entityId) return this.game.player;
    let stub = this._stubs.get(id);
    if (!stub) {
      stub = { id, name: `PLAYER ${id}`, isPlayer: false, isRemote: true, team: -1 };
      this._stubs.set(id, stub);
    }
    stub.team = this.remotes.get(id)?.team ?? stub.team;
    return stub;
  }

  /**
   * Adopt the server's clock and our entity's authoritative state, once, on join.
   *
   * The clock matters as much as the position. Every snapshot is stamped with the
   * SERVER's tick, and interpolation looks for snapshots at or before `now - delay`; run
   * that against a local clock that started at zero and nothing ever matches, so remote
   * players never appear at all. The client's simulation has to be numbered in the
   * server's ticks, not its own.
   */
  _syncToServer(snap) {
    const g = this.game;
    const p = g.player;
    const wire = snap.entities.find((e) => e.id === this.net.entityId);
    if (!wire) return;                       // wait for a snapshot that mentions us

    if (p) {
      this.stats.joinCorrectionM = Math.hypot(
        wire.x - p.position.x, wire.y - p.position.y, wire.z - p.position.z,
      );
      p.position.set(wire.x, wire.y, wire.z);
      p.velocity.set(wire.vx, wire.vy, wire.vz);
      p.health = wire.health;
      p.armor = wire.armor;
      // Adopted at join as well as on every later snapshot: the rigs for everyone already
      // on the server are built the moment the first frame is drawn, and colouring them
      // against a team we are about to be told is wrong shows the whole lobby in the
      // wrong kit until the first correction.
      if (typeof wire.team === 'number') p.team = wire.team;
      // Aim included, and ONLY here: this is the one moment the server legitimately
      // decides where we are looking. After this, aim is the client's alone.
      p.setAngles(wire.yaw, wire.pitch);
      p._updateHitboxes?.();
    }
    g.tick = snap.tick;

    // Stand the local bot roster down. In multiplayer the server owns every bot, and they
    // arrive as snapshots like any other remote entity; a local roster would be a second
    // set of AI running independently — ghosts the player could see and shoot at that
    // nobody else has, and that the server would never agree existed.
    if (g.bots?.bots?.length) {
      g.bots.setCount?.(0);
      if (g.bots.bots.length) g.bots.bots.length = 0;
      g.rosterChanged();
    }

    this.synced = true;
    // Discard the join snap so it is not reported as a prediction failure — it is not
    // one, and leaving it in makes the worst-error metric meaningless forever after.
    if (this.prediction) {
      this.prediction.history.clear();
      this.prediction.stats.worstError = 0;
      this.prediction.stats.worstErrorLiving = 0;
    }
  }

  /**
   * Interpolated state of everyone else, for drawing.
   *
   * Deliberately at `INTERP_DELAY_MS` behind the newest snapshot: with a buffer in hand
   * the client interpolates between two states it actually received, instead of
   * extrapolating from one and being wrong every time somebody changes direction.
   */
  updateRemotes() {
    // No local tick: interpolation is anchored to the server's clock (see
    // `NetClient.interpolationAt`). Passing the local one re-introduces exactly the drift
    // that makes remote players vanish after a few minutes.
    const frame = this.net.interpolationAt();
    if (!frame) return this.remotes;
    const { a, b, t } = frame;

    const seen = new Set();
    for (const ea of a.entities) {
      if (ea.id === this.net.entityId) continue;      // ourselves: prediction owns us
      const eb = b.entities.find((x) => x.id === ea.id) || ea;
      seen.add(ea.id);
      let r = this.remotes.get(ea.id);
      if (!r) {
        r = {
          id: ea.id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, health: 0, team: 0,
          alive: false, crouching: false, sprinting: false,
          firing: false, ads: false, reloading: false,
          // Whether this remote is planting or defusing, and how far through — from the
          // server's `interact` byte, never advanced locally.
          interactKind: 'none', interactProgress: 0,
        };
        this.remotes.set(ea.id, r);
      }
      r.x = ea.x + (eb.x - ea.x) * t;
      r.y = ea.y + (eb.y - ea.y) * t;
      r.z = ea.z + (eb.z - ea.z) * t;
      // Angles interpolate the short way round, or a player crossing the +/-pi seam spins
      // the long way through a whole turn in one frame.
      r.yaw = ea.yaw + shortestAngle(eb.yaw - ea.yaw) * t;
      r.pitch = ea.pitch + (eb.pitch - ea.pitch) * t;
      r.health = eb.health;
      r.team = eb.team;
      r.alive = !!(eb.flags & F_ALIVE);
      r.crouching = !!(eb.flags & F_CROUCH);
      r.sprinting = !!(eb.flags & F_SPRINT);
      r.firing = !!(eb.flags & F_FIRING);
      r.ads = !!(eb.flags & F_ADS);
      r.reloading = !!(eb.flags & F_RELOAD);
      // Taken from the newer of the two frames rather than interpolated: a plant either is or
      // is not happening, and blending a kind between two values would invent a third state.
      const it = unpackInteract(eb.interact ?? 0);
      r.interactKind = it.kindName;
      r.interactProgress = it.progressFrac;
    }
    // Anyone who has left the snapshot has left the match.
    for (const id of [...this.remotes.keys()]) if (!seen.has(id)) this.remotes.delete(id);
    return this.remotes;
  }

  /**
   * Draw everyone else. Called once per rendered frame, not per tick — this is
   * presentation, and it interpolates against the wall clock rather than the sim clock.
   */
  render(dt) {
    if (!this.connected) return;
    if (!this.avatars && this.game.present?.visual !== false) {
      this.avatars = new RemoteAvatars(this.game);
    }
    this.avatars?.update(this.updateRemotes(), dt);
  }

  close() {
    this.connected = false;
    this.avatars?.dispose();
    this.avatars = null;
    this.transport.close();
  }
}

function shortestAngle(d) {
  let x = d;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

export { INTERP_DELAY_MS, quantiseCommand };
