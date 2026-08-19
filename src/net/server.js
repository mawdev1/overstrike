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
  MSG_COMMANDS, MSG_WELCOME, MSG_LOADOUT, decodeCommands, decodeLoadout, encodeSnapshot,
  entityToWire, EV_SPATIAL,
} from './protocol.js';
import { LagCompensation } from './lagcomp.js';
import { INTERP_DELAY_MS } from './client.js';
import { WEAPON_BY_WIRE_IDX, WEAPONS } from '../weapons/weaponDefs.js';

/** Snapshots at 30 Hz against a 120 Hz simulation. */
export const SNAPSHOT_INTERVAL = 4;

/** Feedback events buffered between snapshots. A grenade in a crowd is the worst case. */
const MAX_PENDING_EVENTS = 256;

/**
 * Beyond this, a spatial event is not sent to a client at all.
 *
 * Gunshots are broadcast, one per shot per shooter, at 24 bytes. Uncapped that is a real
 * cost: measured, twenty shooters firing full-auto adds 5.86 KiB/s per client against a
 * ~10 KiB/s baseline — a 59% increase — and 70 KiB/s aggregate upstream, for effects that
 * are mostly on the far side of the map. The server knows both positions, so the cheapest
 * possible fix is also the right one.
 *
 * Set above the client's own VFX range so audio, which culls itself and matters most for
 * shots you CANNOT see, still arrives.
 */
const EVENT_RANGE_M = 90;
const EVENT_RANGE_SQ = EVENT_RANGE_M * EVENT_RANGE_M;

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
 * How much command backlog a client is allowed to keep.
 *
 * The server consumes exactly one command per tick and never catches up, so a backlog is
 * permanent input latency: measured, a single 250 ms hitch on a 60 ms link left 28 commands
 * queued and they were still queued 25 seconds later — +233 ms of lag on every input, for
 * the rest of the session, from one transient stall.
 *
 * Worse, `_updateRtt` derives the round trip from how old the consumed command is, so a
 * backlogged client's estimate pinned at MAX_RTT_MS. Lag compensation then rewound the full
 * 225 ms for someone whose real latency was 60 ms — they were killing people who had been
 * behind cover for a fifth of a second.
 *
 * So a backlog past this is trimmed from the OLDEST end. That discards a few ticks of input
 * the player has already moved on from, once, instead of carrying the delay forever.
 * Deliberately not a catch-up (running two commands in one tick would let a stalled client
 * move at double speed, which is the exploit this queue exists to prevent).
 *
 * 8 commands is 66 ms — comfortably above the 2-4 a 60 fps client banks between packets, so
 * ordinary burstiness never trips it.
 */
const COMMAND_BACKLOG_TARGET = 8;

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
    /** Weapon ids this client chose, so a respawn does not silently rearm them. */
    this.loadout = null;
    this.stats = {
      commands: 0, duplicates: 0, dropped: 0, snapshots: 0, resyncs: 0, backlogTrimmed: 0,
    };
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

    // `Player.respawn` re-gives the DEFAULT loadout, so a client's chosen guns would
    // survive exactly until its first death. Re-arm it every time it comes back.
    game.bus?.on('spawn', (p) => {
      const e = p?.entity;
      if (!e) return;
      for (const session of this.clients.values()) {
        if (session.entity === e) { this.reapplyLoadout(session); return; }
      }
    });

    // Kills and damage come off the BUS, not off the presenter.
    //
    // `Match._killfeed` only calls `present.killfeed` for a HUD that opts out of
    // self-feeding, and a headless server has no HUD at all — so routing kills through the
    // presenter produced exactly nothing on a real server, measured over 60 s: 9 kills,
    // 0 kill events. The bus is where the data actually is, and it is also what every
    // client-side consumer (killfeed, XP pops, streak chips, damage arrows) already
    // listens to, so the client can simply re-emit and light all of them up at once.
    game.bus?.on('kill', (p) => {
      this._record({
        kind: 'kill', to: null,
        killerId: p?.attacker?.id ?? 0,
        victimId: p?.victim?.id ?? 0,
        headshot: !!p?.headshot,
      });
    });
    game.bus?.on('playerDamaged', (p) => {
      const id = p?.entity?.id;
      if (!id) return;
      const d = p.dirWorld;
      this._record({
        kind: 'damaged', to: id,
        amount: Math.max(0, Math.min(65535, Math.round(p.amount ?? 0))),
        x: d?.x ?? 0, y: d?.y ?? 0, z: d?.z ?? 0,
      });
    });
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

    this._sendWelcome(session);
    return session;
  }

  /**
   * Tell a client who it is, and — critically — what seed this match is running on.
   *
   * Shot spread and recoil jitter are drawn by ADDRESS, not from a stream:
   * `addressedRNG(game.matchSeed, shooterId * 65537 + shotsFired, ...)`. The whole point,
   * per the comment at that call site, is that the same shot produces the same number on
   * every machine. It could not: the seed was never sent. `Menu._deploy` calls
   * `startMatch` with no seed, so the client rolls `Math.random()`, connects, and predicts
   * every shot from a stream unrelated to the server's.
   *
   * Measured over 200 shots of `ar_vector`: the client's predicted bullet direction differs
   * from the server's authoritative one by a mean of 2.08 degrees hip-fire, worst 4.60 —
   * 54 cm at 15 m, against a torso about 50 cm wide. ADS is fine (0.17 deg) because the
   * cone is tiny, which is why this hid: it reads as "hip-fire is random" rather than as a
   * desync. The player's own tracers and impact decals point somewhere the bullet did not
   * go.
   *
   * Re-sent on match restart, because `startMatch` rolls a new seed.
   */
  _sendWelcome(session) {
    const hello = new ArrayBuffer(13);
    const v = new DataView(hello);
    v.setUint8(0, MSG_WELCOME);
    v.setUint32(1, session.id, true);
    v.setUint32(5, session.entity.id >>> 0, true);
    v.setUint32(9, this.game.matchSeed >>> 0, true);
    session.transport.send(hello);
  }

  /** Re-welcome everyone, so they adopt the new match's seed. */
  broadcastWelcome() {
    for (const session of this.clients.values()) this._sendWelcome(session);
  }

  removeClient(session) {
    this.clients.delete(session.id);
    if (session.entity) this.lag.forget(session.entity.id);
    session.transport.close();
  }

  _onMessage(session, data) {
    const v = new DataView(data);
    if (v.getUint8(0) === MSG_LOADOUT) { this._applyLoadout(session, data); return; }
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
    // Recover from a stall rather than living with it. See COMMAND_BACKLOG_TARGET.
    while (session.queue.length > COMMAND_BACKLOG_TARGET) {
      session.queue.shift();
      session.stats.backlogTrimmed = (session.stats.backlogTrimmed ?? 0) + 1;
    }
  }

  /**
   * Adopt the newest snapshot this client has confirmed receiving.
   *
   * `cmd.tick` is the newest SERVER tick the client has seen, which it already sends for
   * the round-trip estimate — so the ack costs no extra wire field. A client that missed a
   * snapshot keeps reporting the older tick, the next delta is coded against THAT, and it
   * recovers by itself. A tick we no longer hold (or never sent) simply does not match, and
   * the baseline stays where it was; since `cmd.tick` is attacker-controlled, that failure
   * has to be inert, and a Map lookup that misses is.
   *
   * Deliberately never rewinds: a reordered command carrying an older tick must not undo an
   * ack we have already taken, or a jittery client codes against an ever-older baseline.
   */
  _ackBaseline(session, cmd) {
    const t = cmd.tick >>> 0;
    if (t <= session.baseTick) return;
    const acked = session.pendingBaselines.get(t);
    if (!acked) return;
    session.baseline = acked;
    session.baseTick = t;
    // Everything older is confirmed delivered and can never be coded against again.
    for (const k of session.pendingBaselines.keys()) {
      if (k < t) session.pendingBaselines.delete(k);
    }
  }

  /**
   * Arm this client with the guns it actually picked.
   *
   * Applied immediately AND remembered, because `Player.respawn` re-gives the default
   * loadout: without storing it the choice would survive exactly until the first death.
   */
  _applyLoadout(session, data) {
    const pair = decodeLoadout(data);
    const e = session.entity;
    if (!pair || !e) return;
    const ids = pair
      .map((i) => WEAPON_BY_WIRE_IDX[i]?.id)
      .filter((id) => id && WEAPONS[id]?.class !== 'grenade');
    if (ids.length === 0) return;
    session.loadout = ids;
    this.game.weapons?.giveLoadout?.(e, ids);
  }

  /** Re-arm a client with its chosen guns. Called after anything that re-equips them. */
  reapplyLoadout(session) {
    if (session.loadout) this.game.weapons?.giveLoadout?.(session.entity, session.loadout);
  }

  /** Buffer one feedback event for the next snapshot, respecting the cap. */
  _record(ev) {
    if (this._pendingEvents.length < MAX_PENDING_EVENTS) this._pendingEvents.push(ev);
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
      this._ackBaseline(session, cmd);
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
      for (const ev of rec.events) this._record(ev);
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
    // Still mark the shooter. `_held.fireHeld` persists across a command-less tick — that
    // is the whole point of applying held state — so an automatic weapon DOES fire on this
    // tick, and leaving `_lagViewTick` null judged that round against the present with no
    // rewind at all. Measured at 0.6% of rounds at 40 ms of jitter, rising with jitter.
    e._lagViewTick = e._held?.fireHeld
      ? this.lag.viewTickFor(this.game.tick, session.rttMs, INTERP_DELAY_MS)
      : null;
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
      const at = session.entity?.position;
      const events = this._pendingEvents.filter((ev) => {
        if (ev.to != null) return ev.to === mine;        // private: routing decides it
        if (!at || !EV_SPATIAL.has(ev.kind)) return true;
        const dx = ev.x - at.x;
        const dy = ev.y - at.y;
        const dz = ev.z - at.z;
        return dx * dx + dy * dy + dz * dz <= EVENT_RANGE_SQ;
      });

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

      // Held until the client ACKNOWLEDGES it — see `_ackBaseline`. The comment here used
      // to concede that this was optimistic and that a real transport "would set this from
      // the client's ack instead"; it now does.
      //
      // The optimistic version was not a theoretical risk. `decodeSnapshot` fills every
      // field the delta omits from the baseline, and a client that lacks the baseline gets
      // ZERO for all of them — so one dropped snapshot produced a 36.9 m entity error and
      // read the local player as `health 0, alive false`, permanently, with no recovery
      // path because no keyframe is ever re-sent. Loss is not even the only trigger:
      // snapshots go out every 4 ticks (33.3 ms), so jitter above half that interval
      // reorders two packets and lands in exactly the same state. Measured on a clean
      // link at 120 ms RTT, 0% loss: 14 ms jitter cost 0.1 corrections/s and 23 mm of
      // error; 18 ms jitter cost 14.7 corrections/s and 32.5 m.
      //
      // TCP hides this today. It would not survive the move to datagrams that
      // `transport.js` already wants, and it means the loss cases in `nettest` were
      // measuring a corrupted stream rather than the netcode.
      session.pendingBaselines.set(g.tick, snap);
      if (session.pendingBaselines.size > 64) {
        const oldest = session.pendingBaselines.keys().next().value;
        session.pendingBaselines.delete(oldest);
      }
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
