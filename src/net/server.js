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
import { FIXED_DT, PITCH_LIMIT } from '../core/mathUtils.js';
import {
  MSG_COMMANDS, MSG_WELCOME, decodeCommands, encodeSnapshot, entityToWire,
} from './protocol.js';
import { LagCompensation } from './lagcomp.js';
import { INTERP_DELAY_MS } from './client.js';

/** Snapshots at 30 Hz against a 120 Hz simulation. */
export const SNAPSHOT_INTERVAL = 4;

/** Feedback events buffered between snapshots. A grenade in a crowd is the worst case. */
const MAX_PENDING_EVENTS = 256;

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

/**
 * Ceiling on the round trip a client may claim, in ms.
 *
 * `cmd.tick` comes from the client, so the derived RTT is attacker-controlled and decides
 * how far lag compensation rewinds. Uncapped, a client claiming a two-second round trip
 * could shoot people where they stood two seconds ago. 250 ms matches the history ring,
 * past which the rewind clamps regardless.
 */
const MAX_RTT_MS = 250;

class ClientSession {
  constructor(id, transport, entity) {
    this.id = id;
    this.transport = transport;
    this.entity = entity;
    this.queue = [];
    /**
     * Smoothed round trip, in ms. Drives how far lag compensation rewinds.
     *
     * Measured from the command's `tick` field, which the client sets to the newest
     * SERVER tick it has received. The gap between that and the server's tick now is a
     * genuine round trip: server sent tick T -> client received it -> client sent this
     * command -> server has it. No extra wire field and no ping exchange.
     *
     * This was 0 and never assigned in the first version, which meant every shooter was
     * rewound by the interpolation delay alone and under-compensated by RTT/2 — shots
     * that visibly landed on a moving target missed, which is the exact failure lag
     * compensation exists to prevent.
     */
    this.rttMs = 0;
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
    /** Feedback recorded by `RecordingPresenter`, drained into each snapshot. */
    this._pendingEvents = [];
    this._nextClientId = 1;
    this._snapCounter = 0;
    this.lag = new LagCompensation(game);
    // Ballistics reaches for this by name — see `raycastEntities`. Set here rather than
    // in Game, because only a server ever rewinds.
    game.lagcomp = this.lag;
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
    if (session.entity) this.lag.forget(session.entity.id);
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
      this._updateRtt(session, cmd);
      this._applyCommand(session, cmd);
      // Mark the shooter for lag compensation. The shot does NOT resolve here — the
      // weapon fires inside `_fixedUpdate` when its timer allows — so the rewind cannot
      // wrap this call. It has to happen around the entity test itself, which is why
      // ballistics reads `_lagViewTick` and rewinds there. Wrapping the wrong call was
      // the first version of this, and it rewound nothing at all.
      const e = session.entity;
      if (e) {
        e._lagViewTick = (cmd.fireHeld || cmd.firePressed)
          ? this.lag.viewTickFor(this.game.tick, session.rttMs, INTERP_DELAY_MS)
          : null;
      }
    }

    this.game._fixedUpdate(FIXED_DT);

    // Collect the feedback this tick generated. Snapshots go out every SNAPSHOT_INTERVAL
    // ticks, so events have to accumulate across the ticks in between or three quarters of
    // every burst's hitmarkers would be dropped on the floor.
    const rec = this.game.present;
    if (rec?.events?.length) {
      for (const ev of rec.events) {
        if (this._pendingEvents.length < MAX_PENDING_EVENTS) this._pendingEvents.push(ev);
      }
      rec.clear();
    }

    // The mark lives for exactly the tick that consumed the command. Leaving it set would
    // rewind every later shot to a stale view.
    for (const session of this.clients.values()) {
      if (session.entity) session.entity._lagViewTick = null;
    }

    // After the step, so the sample is the state a client will be told about.
    this.lag.record();

    if (++this._snapCounter >= SNAPSHOT_INTERVAL) {
      this._snapCounter = 0;
      this._broadcastSnapshot();
    }
  }

  /**
   * Fold this command's implied round trip into the session's smoothed estimate.
   *
   * Clamped hard at both ends, because `cmd.tick` is attacker-controlled: a client that
   * claims to have seen a very old tick would otherwise get an arbitrarily deep rewind
   * and could shoot people where they stood a second ago. The ceiling is the lag-comp
   * ring itself — beyond it the rewind clamps anyway, so allowing more buys nothing.
   *
   * Smoothed rather than taken raw: a single late packet should not swing where the next
   * shot is judged, and an exponential average with a slow rise is stable without needing
   * to keep a window of samples.
   */
  _updateRtt(session, cmd) {
    const observed = (this.game.tick - (cmd.tick >>> 0)) * FIXED_DT * 1000;
    if (!Number.isFinite(observed)) return;
    const clamped = Math.max(0, Math.min(MAX_RTT_MS, observed));
    session.rttMs = session.rttMs === 0 ? clamped : session.rttMs * 0.9 + clamped * 0.1;
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

    // The aim checksum has to be compared against the aim the CLIENT was describing, which
    // is its aim BEFORE this command's delta — `MultiplayerSession.sendCommand` stamps
    // `cmd.baseYaw` from the player and only then predicts the delta onto it. Comparing it
    // against the post-delta aim instead made the difference exactly `cmd.deltaYaw`, so any
    // single command turning faster than AIM_RESYNC_RAD (about 4 degrees in 8 ms — a flick,
    // not a desync) tripped the "we have parted company" branch, which then wrote the STALE
    // pre-delta angle back and left the server aiming one command behind the client for the
    // whole turn. Measured 2 resyncs on a clean link with 0 dropped commands, and it shows
    // up in play as flick shots landing behind a moving target.
    const preYaw = e.baseYaw;
    const prePitch = e.basePitch;

    e.applyCommand(cmd);
    e._firePressedThisFrame = !!cmd.firePressed;

    // Deltas alone are lossy: lose one command and the server's aim sits permanently offset
    // from the client's, with nothing to notice. Compare against what the client says its
    // absolute aim is and snap if they have genuinely parted company.
    const dy = Math.abs(wrapAngle(preYaw - cmd.baseYaw));
    const dp = Math.abs(prePitch - cmd.basePitch);
    if (dy > AIM_RESYNC_RAD || dp > AIM_RESYNC_RAD) {
      // Snap to the client's stated aim and then RE-APPLY this command's delta. The
      // checksum describes where the client was before it turned; adopting it raw would
      // throw away the turn the same command was carrying, which is how a resync used to
      // leave the server a command behind instead of catching it up.
      e.baseYaw = cmd.baseYaw + (cmd.deltaYaw || 0);
      // Clamped exactly as `applyCommand` clamps the normal path. Taking the client's
      // value raw here let a client deliberately trip the threshold to push its pitch
      // past the game's own limit — aim is client-authoritative by design, but the limit
      // is not the client's to opt out of.
      e.basePitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, cmd.basePitch + (cmd.deltaPitch || 0)));
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
      // Route: an event with no `to` is everyone's (a gunshot, a kill); an event with one
      // belongs to exactly one client. Showing somebody else's hitmarker is worse than
      // showing none, so this filter is the whole point of recording `to` at all.
      const mine = session.entity?.id;
      const events = this._pendingEvents.filter((ev) => ev.to == null || ev.to === mine);

      const snap = {
        tick: g.tick,
        baseTick: session.baseTick,
        lastCommandSeq: session.lastCommandSeq,
        entities: wire,
        events,
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

    this._pendingEvents.length = 0;
  }
}

/** Shortest signed difference between two angles. */
function wrapAngle(a) {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}
