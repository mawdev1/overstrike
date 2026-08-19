/**
 * The authoritative game server.
 *
 * Owns a headless `Game`, runs its fixed step, and is the only machine whose opinion about
 * what happened counts. Clients send commands and receive snapshots; nothing a client says
 * about its own position is believed.
 *
 * The shape of a tick:
 *
 *   1. drain each client's command queue into its entity, at most one command per tick
 *   2. `game._fixedUpdate(FIXED_DT)`
 *   3. every SNAPSHOT_INTERVAL ticks, send each client a delta against the last snapshot
 *      IT acknowledged
 *
 * Step 1 is where most of the design is. A client's commands arrive in bursts, out of
 * order, duplicated (the client resends the last few for redundancy) and sometimes not at
 * all; the server has to turn that into exactly one command per tick per player, without
 * ever running ahead of what it has been told or letting a client run the simulation
 * faster than everyone else by sending more.
 */
import { FIXED_DT } from '../core/mathUtils.js';
import {
  MSG_COMMANDS, MSG_WELCOME, decodeCommands, encodeSnapshot, entityToWire,
} from './protocol.js';

/** Snapshots at 30 Hz against a 120 Hz simulation. */
export const SNAPSHOT_INTERVAL = 4;

/**
 * How far a client's own aim may drift from the server's before it is snapped.
 *
 * Commands carry look DELTAS, so the two integrations should agree exactly; they drift
 * only when a command is lost, and then permanently. The threshold is generous because a
 * snap is violent — it moves the player's aim without them asking — so it must fire on a
 * genuine desync and never on ordinary float noise.
 */
const AIM_RESYNC_RAD = 0.05;

/**
 * How many commands a client may bank.
 *
 * Bounded because it is the obvious way to cheat: send 10x the commands and act 10x. It
 * also bounds memory against a client that floods. Commands past the cap are dropped
 * oldest-first — dropping the NEWEST would make a legitimately bursty client permanently
 * laggy, since its most recent intent is the one that matters.
 */
const MAX_QUEUED_COMMANDS = 32;

class ClientSession {
  constructor(id, transport, entity) {
    this.id = id;
    this.transport = transport;
    this.entity = entity;
    this.queue = [];
    /** Highest command seq consumed. Sent back so the client knows what to stop resending. */
    this.lastCommandSeq = 0;
    /** The snapshot this client has acknowledged, and which deltas are coded against. */
    this.baseline = null;
    this.baseTick = 0;
    this.pendingBaselines = new Map();
    this.stats = { commands: 0, duplicates: 0, dropped: 0, snapshots: 0, resyncs: 0 };
  }
}

export class GameServer {
  /**
   * @param {Game} game a Game that has already had `initHeadless()` run on it
   */
  constructor(game) {
    this.game = game;
    this.clients = new Map();
    this._nextClientId = 1;
    this._snapCounter = 0;
  }

  /**
   * Attach a client.
   *
   * `entity` is the Player this connection drives. The first client takes `game.player`
   * because a Game always builds one and several systems expect it to exist; later
   * clients get their own, registered through `game.addEntity`. That asymmetry is a wart
   * — on a server nobody should be "the" player — and it is contained entirely here.
   */
  addClient(transport, entity) {
    const id = this._nextClientId++;
    const session = new ClientSession(id, transport, entity);
    this.clients.set(id, session);

    transport.onMessage((data) => this._onMessage(session, data));

    const hello = new ArrayBuffer(9);
    const v = new DataView(hello);
    v.setUint8(0, MSG_WELCOME);
    v.setUint32(1, id, true);
    v.setUint32(5, entity.id >>> 0, true);
    transport.send(hello);
    return session;
  }

  removeClient(session) {
    this.clients.delete(session.id);
    session.transport.close();
  }

  _onMessage(session, data) {
    const v = new DataView(data);
    if (v.getUint8(0) !== MSG_COMMANDS) return;

    for (const cmd of decodeCommands(data)) {
      // Already consumed, or already queued. The client resends its last few commands on
      // purpose — that redundancy is what survives a dropped packet — so duplicates are
      // the normal case and must be cheap and silent.
      if (cmd.seq <= session.lastCommandSeq) { session.stats.duplicates++; continue; }
      if (session.queue.some((q) => q.seq === cmd.seq)) { session.stats.duplicates++; continue; }
      session.queue.push(cmd);
    }
    // Sorted so a reordered packet does not apply a stale command after a newer one.
    session.queue.sort((a, b) => a.seq - b.seq);
    while (session.queue.length > MAX_QUEUED_COMMANDS) {
      session.queue.shift();
      session.stats.dropped++;
    }
  }

  /** Advance the simulation one fixed step, consuming at most one command per client. */
  tick() {
    for (const session of this.clients.values()) {
      const cmd = session.queue.shift();
      if (!cmd) {
        // Nothing arrived for this tick. Apply the last command's HELD state again rather
        // than nothing: a player mid-sprint whose packet is late should keep running, not
        // stop dead and then teleport when it turns up. Edges are deliberately not
        // repeated — repeating a jump edge would make one press into several jumps.
        this._applyHeldOnly(session);
        continue;
      }
      session.stats.commands++;
      session.lastCommandSeq = cmd.seq;
      this._applyCommand(session, cmd);
    }

    this.game._fixedUpdate(FIXED_DT);

    if (++this._snapCounter >= SNAPSHOT_INTERVAL) {
      this._snapCounter = 0;
      this._broadcastSnapshot();
    }
  }

  _applyCommand(session, cmd) {
    const e = session.entity;
    if (!e) return;

    // Held state is the command's, verbatim: it was resolved on the client where the
    // settings live (toggle vs hold crouch, autoSprint), and re-deriving it here is
    // impossible — the server does not have that client's settings and must not guess.
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

    // The aim checksum. Deltas alone are lossy: lose one command and the server's aim sits
    // permanently offset from the client's, with nothing to notice. Compare against what
    // the client says its absolute aim is and snap if they have genuinely parted company.
    const dy = Math.abs(wrapAngle(e.baseYaw - cmd.baseYaw));
    const dp = Math.abs(e.basePitch - cmd.basePitch);
    if (dy > AIM_RESYNC_RAD || dp > AIM_RESYNC_RAD) {
      e.baseYaw = cmd.baseYaw;
      e.basePitch = cmd.basePitch;
      e._writeAngles();
      session.stats.resyncs++;
    }
  }

  _applyHeldOnly(session) {
    const e = session.entity;
    if (!e) return;
    e._firePressedThisFrame = false;
    // `_held` is left exactly as the last command set it, which is the point.
    for (const k of Object.keys(e._edge)) e._edge[k] = false;
    e._edge.slot = -1;
    e._edge.wheel = 0;
  }

  _broadcastSnapshot() {
    const g = this.game;
    const ents = g.entities;
    const wire = [];
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      const lo = g.weapons?.getLoadout?.(e);
      wire.push(entityToWire(e, lo ? Math.max(0, lo.index) : 0));
    }

    for (const session of this.clients.values()) {
      const snap = {
        tick: g.tick,
        baseTick: session.baseTick,
        lastCommandSeq: session.lastCommandSeq,
        entities: wire,
      };
      const buf = encodeSnapshot(snap, session.baseline);
      session.transport.send(buf);
      session.stats.snapshots++;

      // Optimistic baselining: assume it arrives, and keep the previous one until the
      // client acknowledges. A client that misses a snapshot will ack an older tick and
      // the next delta is coded against THAT — which is why the acknowledged baseline,
      // not the last one sent, is the only safe thing to code against.
      session.pendingBaselines.set(g.tick, snap);
      if (session.pendingBaselines.size > 64) {
        const oldest = session.pendingBaselines.keys().next().value;
        session.pendingBaselines.delete(oldest);
      }
      // Loopback and any reliable transport acknowledge implicitly — nothing is lost, so
      // the snapshot just sent IS the baseline. An unreliable transport would set this
      // from the client's ack instead.
      session.baseline = snap;
      session.baseTick = g.tick;
    }
  }
}

/** Shortest signed difference between two angles. */
function wrapAngle(a) {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}
