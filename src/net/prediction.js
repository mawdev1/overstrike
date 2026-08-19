/**
 * Client-side prediction and reconciliation for the local player.
 *
 * The client runs the same simulation as the server, immediately, on its own input — so
 * moving feels instant instead of costing a round trip. The server later says what really
 * happened. Where the two agree, nothing is done. Where they disagree, the client rewinds
 * to the server's answer and replays every command the server has not yet seen, so the
 * correction lands in the past rather than as a visible jolt in the present.
 *
 * Three decisions shape this file, and all three are about what NOT to correct.
 *
 * **Aim is never corrected.** Commands carry look deltas, and the client integrates them
 * into `baseYaw`/`basePitch` itself. The server integrates the same deltas and arrives at
 * the same place; it validates with a checksum and snaps only on a genuine desync (see
 * GameServer). Snapshot yaw/pitch are for OTHER players. Pulling the local player's aim
 * toward a 33 ms-old snapshot would fight the mouse continuously, and a shooter that
 * fights the mouse is unplayable regardless of how correct it is.
 *
 * **Recoil is predicted unconditionally and never reconciled.** Recoil is a mutation of
 * aim produced by an event the server owns, applied to a quantity the client integrates.
 * If it were corrected, the crosshair would teleport mid-spray while the player is
 * actively counter-steering — worse than any positional rubber-band, because the player is
 * fighting it in real time. Instead the client predicts every shot's recoil, and a shot
 * the server REJECTS has its contribution subtracted (see `rejectShot`): exact for the
 * permanent fraction, close enough for the decaying part.
 *
 * **A correction below the wire's own precision is not a correction.** Snapshots carry
 * float32, so a client that insisted on exact agreement would rewind and replay every
 * tick forever, chasing rounding. The threshold is set well above that floor.
 */
import { FIXED_DT } from '../core/mathUtils.js';
import { PLAYER_SNAPSHOT } from '../player/player.js';
import { saveLoadout, restoreLoadout } from '../weapons/weaponSystem.js';
import { NullPresenter } from '../core/presenter.js';
import { F_ALIVE } from './protocol.js';

/**
 * Snapshots to ignore after a death or respawn before trusting the living-error metrics.
 * Half a second at 120 Hz — long enough for the correction and the replay behind it.
 */
const LIFE_SETTLE_TICKS = 60;

/**
 * How far the prediction may be from the server before it is corrected, in metres.
 *
 * Above float32's ~1e-4 m over the map's coordinate range (measured in simtest) by a
 * wide margin, and below what a player can see. Too tight and the client replays
 * constantly against rounding; too loose and genuine divergence is left on screen.
 */
export const POSITION_TOLERANCE = 0.02;

/** Velocity divergence that forces a correction even when position still agrees. */
export const VELOCITY_TOLERANCE = 0.5;

export class Prediction {
  /**
   * @param {Game} game    the client's own simulation
   * @param {Player} entity the locally controlled player
   * @param {NetClient} net
   */
  constructor(game, entity, net) {
    this.game = game;
    this.entity = entity;
    this.net = net;

    /** seq -> state after that command was applied. Trimmed as the server acks. */
    this.history = new Map();
    /** Shots predicted but not yet confirmed, so a rejected one can be unwound. */
    this.pendingShots = new Map();
    /** Tick of the last death or respawn. See LIFE_SETTLE_TICKS. */
    this._lifeChangeTick = 0;

    this.stats = {
      corrections: 0, replayedCommands: 0, worstError: 0,
      /**
       * Worst error across ticks where both sides agree the player is ALIVE.
       *
       * The number that actually measures prediction quality. A death and respawn moves
       * the player across the map, and no amount of correct prediction can foresee it —
       * the server decides who dies. Folding those into one figure makes a healthy
       * client look catastrophically wrong, so they are counted separately.
       */
      worstErrorLiving: 0,
      /**
       * Worst error while alive AND on the ground — the number that reflects controlled
       * play, and the one to hold to a tight bound.
       *
       * Airborne divergence is a different animal and is tracked separately. A fall is
       * dominated by gravity, not by input: if a lost command means the client leaves a
       * ledge one tick before the server does, the two are already moving apart at
       * several metres a second and nothing either simulation does will bring them back
       * until they land. Holding that to the same bound as walking would mean either a
       * meaningless threshold or a permanently failing test.
       */
      worstErrorGrounded: 0,
      worstErrorAir: 0,
      lastError: 0, shotsRejected: 0, worstAt: null, worstLivingAt: null,
      respawnCorrections: 0,
    };
  }

  /**
   * Apply a command locally, then record the resulting state.
   *
   * The command must already have been through `quantiseCommand` — the client has to
   * predict from exactly the bytes the server will decode, or it is wrong by a small
   * amount on every single command and reconciliation never settles.
   */
  predict(cmd) {
    const e = this.entity;

    const h = e._held;
    h.wishForward = cmd.wishForward;
    h.wishRight = cmd.wishRight;
    h.crouchHeld = cmd.crouchHeld;
    h.toggleAdsMode = cmd.toggleAdsMode;
    h.aimButtonHeld = cmd.aimButtonHeld;
    h.fireHeld = cmd.fireHeld;
    h.sprintKeyHeld = cmd.sprintKeyHeld;
    h.breathHold = cmd.breathHold;
    h.leanKeyHeld = cmd.leanKeyHeld;
    h.leanRightKeyHeld = cmd.leanRightKeyHeld;

    e.applyCommand(cmd);
    e._firePressedThisFrame = !!cmd.firePressed;

    this.game._fixedUpdate(FIXED_DT);
    this._record(cmd.seq);
  }

  _record(seq) {
    const lo = this.game.weapons?.getLoadout?.(this.entity);
    this.history.set(seq, {
      player: PLAYER_SNAPSHOT.save(this.entity),
      loadout: lo ? saveLoadout(lo) : null,
      tick: this.game.tick,
    });
    // The server acks continuously, so this stays short; the cap is a backstop against a
    // connection that stops acking rather than an expected size.
    if (this.history.size > 256) {
      const oldest = this.history.keys().next().value;
      this.history.delete(oldest);
    }
  }

  /**
   * Reconcile against an authoritative snapshot.
   *
   * `snap.lastCommandSeq` is the last command the server consumed, so its state is the
   * truth as of exactly that command — which is what makes the comparison meaningful.
   * Anything after it is still in flight and must be replayed rather than compared.
   */
  reconcile(snap) {
    const wire = snap.entities.find((x) => x.id === this.entity.id);
    if (!wire) return false;

    const mine = this.history.get(snap.lastCommandSeq);
    // Nothing to compare against: either the ack is for a command from before this
    // session, or history has been trimmed past it. Accepting the server's state blindly
    // here would be a visible snap for no demonstrated reason, so leave it alone.
    if (!mine) { this._trim(snap.lastCommandSeq); return false; }

    const dx = wire.x - mine.player.position.x;
    const dy = wire.y - mine.player.position.y;
    const dz = wire.z - mine.player.position.z;
    const posErr = Math.hypot(dx, dy, dz);
    const velErr = Math.hypot(
      wire.vx - mine.player.velocity.x,
      wire.vy - mine.player.velocity.y,
      wire.vz - mine.player.velocity.z,
    );
    this.stats.lastError = posErr;
    if (posErr > this.stats.worstError) {
      this.stats.worstError = posErr;
      // Keep enough to tell a rubber-band from a teleport. A large error that coincides
      // with a health or alive change is a respawn, not a misprediction, and chasing it
      // as if it were one wastes a lot of time.
      this.stats.worstAt = {
        seq: snap.lastCommandSeq, tick: snap.tick,
        health: [mine.player.health, wire.health],
        alive: [mine.player.alive, !!(wire.flags & 1)],
      };
    }

    // A death or a respawn moves the player by the width of the map, and no amount of
    // prediction can or should track that — the client cannot know where the server will
    // put it. Those frames are excluded from the LIVING error metrics, which exist to
    // measure ordinary movement misprediction. This needs a settling window and not just
    // `bothAlive`: on the frame after a respawn the client's own history says it was alive
    // and the wire says it is alive, while the position it predicted belongs to where it
    // died. Before the client synced `alive` at all it never died locally, so this case
    // could not arise and the window was not needed.
    const settling = this._lifeChangeTick > 0 && (snap.tick - this._lifeChangeTick) < LIFE_SETTLE_TICKS;
    const bothAlive = mine.player.alive && !!(wire.flags & 1) && !settling;
    if (bothAlive) {
      const grounded = mine.player.grounded && mine.player.moveState !== 'air';
      if (grounded) {
        if (posErr > this.stats.worstErrorGrounded) this.stats.worstErrorGrounded = posErr;
      } else if (posErr > this.stats.worstErrorAir) {
        this.stats.worstErrorAir = posErr;
      }
      if (posErr > this.stats.worstErrorLiving) {
        this.stats.worstErrorLiving = posErr;
        // Its OWN context. Sharing `worstAt` with the all-inclusive figure meant the
        // reported detail described a different sample than the reported number — which
        // sent me looking at a respawn while the actual worst live error was elsewhere.
        this.stats.worstLivingAt = {
          seq: snap.lastCommandSeq, tick: snap.tick,
          health: [mine.player.health, wire.health],
          posErr: +posErr.toFixed(3), velErr: +velErr.toFixed(3),
          grounded: mine.player.grounded,
          moveState: mine.player.moveState,
        };
      }
    } else {
      this.stats.respawnCorrections++;
    }

    // Life state is authoritative on EVERY snapshot, and deliberately outside the
    // tolerance check below. Health used to be applied only inside `_correct`, which runs
    // only when the POSITION also mispredicted — so a player standing still and being shot
    // watched their HUD sit at 100 while the server killed them.
    this._syncLife(wire);

    if (posErr <= POSITION_TOLERANCE && velErr <= VELOCITY_TOLERANCE) {
      this._trim(snap.lastCommandSeq);
      return false;
    }

    this._correct(wire, mine, snap.lastCommandSeq);
    return true;
  }

  /**
   * Adopt the server's verdict on whether we are alive, and on how hurt we are.
   *
   * `_correct` set health, armour, height and lean and never touched `alive`. Nothing else
   * in `src/net/` assigns it on the local player either, so a client that the server had
   * killed went on believing it was alive — indefinitely. That is not a cosmetic desync:
   * the server discards a dead player's commands, so from the player's side every shot
   * after their first death silently did nothing, forever. It is the most complete version
   * of "none of my shots are hitting" the codebase can produce.
   *
   * The transitions are driven through the entity's own `die`/`respawn` rather than by
   * assigning the flag, because both do real work — stopping the trigger, dropping ADS,
   * starting the death cam — that a bare assignment would skip.
   */
  _syncLife(wire) {
    const e = this.entity;
    const serverAlive = (wire.flags & F_ALIVE) !== 0;

    if (e.alive && !serverAlive) {
      this._lifeChangeTick = this.game.tick;
      // Not `notifyMatch`: the server's match owns respawn timing and scoring, and this
      // client's own match must not start queueing respawns for an entity it does not run.
      e.die(null, { notifyMatch: false });
      e.health = 0;
      return;
    }

    if (!e.alive && serverAlive) {
      this._lifeChangeTick = this.game.tick;
      e.respawn?.();
      // `respawn` picks a spawn point locally, which is not the one the server used. Take
      // the server's, immediately, so the frame after coming back is not a teleport.
      e.position.set(wire.x, wire.y, wire.z);
      e.velocity.set(wire.vx, wire.vy, wire.vz);
    }

    e.health = wire.health;
    e.armor = wire.armor;
    // The side we are on is the server's to decide, and nothing else ever told us. The
    // client's own `startMatch` pins the local player to team 0, so every client the
    // server dealt onto team 1 kept believing it was on team 0 — and since remote rigs are
    // coloured by ABSOLUTE team, half of all players saw their teammates in enemy kit and
    // their enemies in friendly kit.
    if (typeof wire.team === 'number') e.team = wire.team;
  }

  _correct(wire, mine, ackedSeq) {
    const e = this.entity;
    const g = this.game;
    this.stats.corrections++;

    // Rewind to our own recorded state at the acked command — which carries all ~70
    // fields, not just the dozen the wire has room for — and then overwrite exactly the
    // fields the server actually spoke about. Restoring from the wire alone would zero
    // everything it does not carry.
    PLAYER_SNAPSHOT.restore(e, mine.player);
    const lo = g.weapons?.getLoadout?.(e);
    if (lo && mine.loadout) restoreLoadout(lo, mine.loadout);

    e.position.set(wire.x, wire.y, wire.z);
    e.velocity.set(wire.vx, wire.vy, wire.vz);
    e.health = wire.health;
    e.armor = wire.armor;
    e.height = wire.height;
    e.lean = wire.lean;
    // Deliberately NOT yaw/pitch/baseYaw/basePitch/recoil — see the module header. The
    // server does not correct aim, and a client that pulled its own aim toward a stale
    // snapshot would fight the mouse forever.

    // Replay everything the server has not seen. The presenter is swapped out first:
    // these ticks already happened once and already made their noise, so re-running them
    // must not fire a second gunshot or a second muzzle flash. This is the use Phase 1
    // built the port for.
    const savedPresent = g.present;
    const savedTick = g.tick;
    g.present = new NullPresenter();
    g.tick = mine.tick;

    try {
      for (const cmd of this.net.unacked) {
        if (cmd.seq <= ackedSeq) continue;
        this.predict(cmd);
        this.stats.replayedCommands++;
      }
    } finally {
      g.present = savedPresent;
      // The replay advanced the clock exactly as far as it should have; if it somehow did
      // not, the local clock is authoritative for the client's own rendering.
      if (g.tick < savedTick) g.tick = savedTick;
    }

    this._trim(ackedSeq);
  }

  _trim(uptoSeq) {
    for (const seq of this.history.keys()) {
      if (seq <= uptoSeq) this.history.delete(seq);
    }
  }

  /**
   * Record a shot the client predicted, so it can be unwound if the server disagrees.
   *
   * Stores the recoil this shot contributed, split the way `_addRecoilRad` applies it: a
   * permanent fraction written straight into `baseYaw`/`basePitch`, and a decaying
   * remainder in the recoil targets. Subtracting the permanent part later is exact;
   * subtracting the decaying part is approximate, because it has been decaying since —
   * and approximate is the right trade, since the alternative is a crosshair that
   * teleports.
   */
  recordShot(seq, { permanentYaw, permanentPitch, targetYaw, targetPitch }) {
    this.pendingShots.set(seq, { permanentYaw, permanentPitch, targetYaw, targetPitch });
    if (this.pendingShots.size > 64) {
      const oldest = this.pendingShots.keys().next().value;
      this.pendingShots.delete(oldest);
    }
  }

  /** The server refused a shot the client predicted. Take its recoil back. */
  rejectShot(seq) {
    const shot = this.pendingShots.get(seq);
    if (!shot) return false;
    this.pendingShots.delete(seq);
    const e = this.entity;
    e.baseYaw -= shot.permanentYaw;
    e.basePitch -= shot.permanentPitch;
    e.recoilYawTarget -= shot.targetYaw;
    e.recoilPitchTarget -= shot.targetPitch;
    e._writeAngles();
    this.stats.shotsRejected++;
    return true;
  }

  confirmShot(seq) { return this.pendingShots.delete(seq); }
}
