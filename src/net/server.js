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
  MSG_COMMANDS, MSG_LOADOUT, MSG_HELLO, decodeCommands, decodeLoadout, encodeSnapshot,
  entityToWire, EV_SPATIAL, PROTOCOL_VERSION, decodeHello, encodeReject, encodeWelcome,
  encodeMatchState, encodeOutcome, MATCHSTATE_BYTES, INTERACT_PROGRESS_MAX,
  REJECT_PROTOCOL_VERSION_MISMATCH, BOMB_STATES, PHASES,
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

/**
 * How often `MSG_MATCHSTATE` goes out when nothing has changed.
 *
 * §8.6 says "on change only", and every field except one obeys that. `serverTimeMs` is the
 * exception: it changes every tick by construction, so a naive change test would send this
 * message 120 times a second and defeat its own purpose. So the change test IGNORES the clock
 * and this heartbeat carries it instead — once a second, which is far more often than the
 * facade's clock reconstruction needs and 41 bytes a second on a ~10 KiB/s stream.
 *
 * Without a heartbeat a client that joins mid-`live` and sees no state change for a minute
 * would age its only clock sample for that whole minute.
 */
const MATCHSTATE_HEARTBEAT_TICKS = 120;

/** Team indices, as `match-result.md` names them. Index is the team number. */
const TEAM_NAMES = ['alpha', 'bravo'];

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
    /**
     * Set once this connection has been refused (§8.3). A rejected socket is closed
     * immediately, but a frame already in flight can still arrive — and a client that
     * disagrees about the layout is exactly the one whose bytes must not be decoded. Every
     * later message from it is dropped without being read.
     */
    this.rejected = null;
    /** The version this client said it speaks, or null if it never sent a hello. */
    this.helloVersion = null;
    /**
     * The session ticket from `MSG_HELLO`, held but NOT yet validated.
     *
     * Version negotiation (G1) and authentication (G2) share the frame, and only G1 lands
     * here. Storing the ticket without checking it is deliberate and inert: nothing reads it,
     * so nothing can be fooled by it. When G2 lands it validates against the platform between
     * the version check and entity creation, per §8.2's ordering.
     */
    this.ticket = null;
    /**
     * Last `MSG_MATCHSTATE` sent to THIS client, as bytes.
     *
     * Per-session rather than shared because the message is per-recipient filtered — two
     * clients receive genuinely different bytes for the same server state, so one shared
     * "last sent" would suppress a change for the client that had not seen it.
     */
    this.lastMatchState = null;
    this.matchStateAge = 0;
    this.stats = {
      commands: 0, duplicates: 0, dropped: 0, snapshots: 0, resyncs: 0, backlogTrimmed: 0,
      matchStates: 0, outcomes: 0, rejectedMessages: 0,
    };
  }
}

/**
 * The authoritative objective record — `match-result.md` §7's `evidenceRef`, objective half.
 *
 * The bar §7 sets: **the result must be reconstructable from evidence alone, with no client
 * input.** That is what makes a cheat report reviewable and a stat dispute settleable, and it
 * is why every row here is written from server-side facts at the moment the server decided
 * them. Nothing that arrives in a client message is ever recorded — a record a player can
 * write is not evidence about that player.
 *
 * Deliberately NOT the wire events. The wire is filtered per recipient (a defender does not
 * learn where a dropped bomb is) and culled by distance; evidence is the unfiltered truth. If
 * the two shared a representation, the record would inherit the filtering and a review would
 * be missing exactly the facts it was opened to check.
 */
export class ObjectiveEvidence {
  /**
   * @param {number} limit hard cap on retained rows. A match is a few hundred objective
   *   facts; the cap is memory safety against a pathological loop, not a retention policy
   *   (that is `telemetry.md` §6). Overflow drops the NEWEST and counts it, because losing
   *   the start of a round silently is worse than knowing the tail is incomplete.
   */
  constructor({ limit = 4096 } = {}) {
    this.limit = limit;
    this.rows = [];
    this.dropped = 0;
    this.rulesetVersion = null;
    this.serverBuild = null;
    this.matchId = null;
  }

  /** Identify the match this record belongs to. Called once, when the match is known. */
  identify({ matchId = null, rulesetVersion = null, serverBuild = null } = {}) {
    if (matchId != null) this.matchId = matchId;
    if (rulesetVersion != null) this.rulesetVersion = rulesetVersion;
    if (serverBuild != null) this.serverBuild = serverBuild;
    return this;
  }

  /**
   * Append one objective fact.
   *
   * Every field is normalised here rather than at the call site so two callers cannot record
   * the same fact in two shapes — which is how a timeline stops being reconstructable.
   */
  record(row = {}) {
    if (this.rows.length >= this.limit) { this.dropped++; return null; }
    const p = row.position;
    const out = {
      seq: this.rows.length,
      kind: String(row.kind ?? 'unknown'),
      tick: row.tick | 0,
      serverTimeMs: row.serverTimeMs | 0,
      roundIndex: row.roundIndex == null ? null : (row.roundIndex | 0),
      phase: row.phase ?? null,
      actorId: row.actorId ? (row.actorId >>> 0) : null,
      actorTeam: row.actorTeam == null ? null : (TEAM_NAMES[row.actorTeam] ?? null),
      site: row.site ?? null,
      // Unfiltered on purpose — see the class note. Rounded to millimetres: finer than that
      // is float noise, and the record is meant to be compact.
      position: p ? { x: round3(p.x), y: round3(p.y), z: round3(p.z) } : null,
      reason: row.reason ?? null,
      requestedKind: row.requestedKind ?? null,
      // 0..63, the same six-bit quantity the wire carries, so a review compares like with
      // like rather than against a float the client never saw.
      progress: row.progress == null
        ? null
        : Math.max(0, Math.min(INTERACT_PROGRESS_MAX, Math.round(row.progress))),
    };
    this.rows.push(out);
    return out;
  }

  /** Every row from one round, in order. The unit a round dispute is argued over. */
  forRound(index) { return this.rows.filter((r) => r.roundIndex === index); }

  /** Rows of one kind. `evidence.of('plantComplete').length` is the authoritative plant count. */
  of(kind) { return this.rows.filter((r) => r.kind === kind); }

  /** The serialisable record. What `evidenceRef` ultimately points at. */
  toJSON() {
    return {
      version: 1,
      matchId: this.matchId,
      rulesetVersion: this.rulesetVersion,
      serverBuild: this.serverBuild,
      protocolVersion: PROTOCOL_VERSION,
      objectives: this.rows,
      droppedRows: this.dropped,
    };
  }
}

const round3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;

export class GameServer {
  /**
   * @param {Game} game a Game that has already had `initHeadless()` run on it
   */
  constructor(game) {
    this.game = game;
    this.clients = new Map();
    /** Feedback recorded by `RecordingPresenter`, drained into each snapshot. */
    this._pendingEvents = [];
    this._pendingRoundEnd = null;
    this._nextClientId = 1;
    this._snapCounter = 0;
    this.lag = new LagCompensation(game);
    /** The authoritative objective record. See `ObjectiveEvidence`. */
    this.evidence = new ObjectiveEvidence();

    // The Bomb ruleset (`src/game/match.js`) announces every objective fact on the bus, and
    // this is the ONE place it becomes both a wire event and an evidence row — see
    // `objectiveEvent`. One ingestion point, so the two can never describe different rounds.
    game.bus?.on('objective', (p) => this.objectiveEvent(p));
    game.bus?.on('outcome', (p) => this.sendOutcome(p));

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
    game.bus?.on('roundEnd', (result) => {
      const reasonCode = result?.reason === 'time' ? 1 : result?.reason === 'draw' ? 2 : 0;
      // Defer until the end of this server tick. Match hears `kill` before GameServer and
      // emits roundEnd from inside that listener; recording immediately would put the
      // whistle before the final kill in the reliable event stream.
      this._pendingRoundEnd = {
        kind: 'roundEnd',
        to: null,
        killerId: result?.scores?.[0] ?? 0,
        victimId: result?.scores?.[1] ?? 0,
        amount: result?.killLimit ?? game.match?.killLimit ?? 75,
        weaponIdx: reasonCode,
      };
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
    const match = this.game.match;
    const mode = bombModeId(match) === 'bomb' ? 'bomb' : 'tdm';
    session.transport.send(encodeWelcome({
      clientId: session.id,
      entityId: session.entity.id,
      matchSeed: this.game.matchSeed,
      // §8.4: 0 in Bomb, and 0 means "not applicable". `normalizeKillLimit` clamps to 1, so
      // the sentinel cannot collide with a real limit.
      killLimit: mode === 'bomb' ? 0 : (match?.killLimit ?? 75),
      protocolVersion: PROTOCOL_VERSION,
      mode,
      flags: 0,
      serverTickRateHz: Math.round(1 / FIXED_DT),
    }));
  }

  /**
   * Refuse this connection and close it (§8.3).
   *
   * The reject frame carries the SERVER's version so the client can name which build to move
   * to instead of failing bare. The socket closes immediately afterwards, and `session.rejected`
   * makes every frame still in flight from that client inert — a peer that disagrees about the
   * layout is precisely the one whose bytes must never reach a decoder.
   */
  rejectClient(session, reason) {
    if (session.rejected) return session.rejected;
    session.rejected = reason;
    session.transport.send(encodeReject(reason, PROTOCOL_VERSION));
    this.removeClient(session);
    return reason;
  }

  /**
   * `MSG_HELLO` (§8.2). **The version check precedes the ticket check**, because a client that
   * disagrees about the layout cannot be trusted to have encoded the ticket where we read it.
   *
   * Step 2 of §8.2 — validating the ticket — is G2 and is not implemented here; the ticket is
   * stored unread. Steps 3 and 4 (session replacement, entity creation) are G2/G4 and still
   * happen in `addClient` today. What lands with v2 is step 1, which is the step that has to
   * exist before any of the others can be trusted.
   */
  _onHello(session, data) {
    const hello = decodeHello(data);
    // A known type at the wrong length means a desynced stream (§8.11): close it.
    if (!hello) { this.rejectClient(session, REJECT_PROTOCOL_VERSION_MISMATCH); return; }
    session.helloVersion = hello.protocolVersion;
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      this.rejectClient(session, REJECT_PROTOCOL_VERSION_MISMATCH);
      return;
    }
    session.ticket = hello.ticket;
    // Re-welcome, so a client that connected before saying hello still learns the negotiated
    // version from a frame it can trust rather than from one it decoded on faith.
    this._sendWelcome(session);
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
    // A refused connection is finished. Frames already in flight are counted and dropped
    // unread — never decoded, because the whole reason it was refused is that we do not agree
    // with it about what its bytes mean.
    if (session.rejected) { session.stats.rejectedMessages++; return; }
    if (data.byteLength < 1) return;
    const v = new DataView(data);
    const type = v.getUint8(0);
    if (type === MSG_HELLO) { this._onHello(session, data); return; }
    if (type === MSG_LOADOUT) { this._applyLoadout(session, data); return; }
    // §8.11: an unknown type is ignored, not fatal. Additive message types must not break an
    // older peer mid-match — that is what version negotiation is for, at the handshake.
    if (type !== MSG_COMMANDS) return;

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

  // ── Bomb: match state, objectives, outcomes ─────────────────────────────────────────

  /**
   * The one door an objective fact comes through.
   *
   * The Bomb ruleset emits `objective` on the bus and this turns each one into TWO things: a
   * wire event for the clients who may see it, and an evidence row that is never filtered.
   * Both from the same call, so the timeline a review reads and the timeline a player saw can
   * never describe different rounds.
   *
   * Expected payload (`src/game/match.js` owns the producer):
   *
   *   { kind, actorId, actorTeam, victimId?, site?, position?, reason?, requestedKind?,
   *     progress?, roundIndex?, phase? }
   *
   * `kind` is one of the eleven §8.7 names. `progress` is 0..1. `reason` may be an index or one
   * of the `CANCEL_REASONS` / `REFUSAL_REASONS` names.
   */
  objectiveEvent(p) {
    const kind = p?.kind;
    if (!kind || !EV_BOMB_KINDS.has(kind)) return null;
    const g = this.game;
    const m = g.match;
    const serverTimeMs = this.serverTimeMs();
    const progress63 = p.progress == null
      ? null : Math.round(Math.max(0, Math.min(1, p.progress)) * INTERACT_PROGRESS_MAX);

    const row = this.evidence.record({
      kind,
      tick: g.tick,
      serverTimeMs,
      roundIndex: p.roundIndex ?? m?.roundIndex ?? null,
      phase: p.phase ?? m?.phase ?? null,
      actorId: p.actorId,
      actorTeam: p.actorTeam,
      site: p.site ?? null,
      position: p.position ?? null,
      reason: p.reason ?? null,
      requestedKind: p.requestedKind ?? null,
      progress: progress63,
    });

    // A refusal is a private fact about one player's input — §8.7: sent only to the refused
    // player. Broadcasting it would tell the whole server who is standing on a site trying to
    // plant, which is the information the objective volumes exist to make people fight over.
    const to = kind === 'interactRefused' ? (p.to ?? p.actorId ?? null) : null;
    const pos = p.position;
    this._record({
      kind,
      to,
      entityId: (p.actorId ?? 0) >>> 0,
      victimId: (p.victimId ?? 0) >>> 0,
      amount: p.amount ?? 0,
      reason: p.reason ?? null,
      requestedKind: p.requestedKind ?? null,
      x: pos?.x ?? 0, y: pos?.y ?? 0, z: pos?.z ?? 0,
    });
    return row;
  }

  /**
   * Broadcast `MSG_OUTCOME` (§8.9) and record it.
   *
   * Sent immediately BEFORE the corresponding `MSG_MATCHSTATE` phase change, so a client that
   * renders on outcome always has the state to go with it. That ordering is why this does not
   * wait for the next tick's state broadcast.
   */
  sendOutcome(o) {
    if (!o) return null;
    const buf = encodeOutcome(o);
    for (const session of this.clients.values()) {
      if (session.rejected) continue;
      session.transport.send(buf);
      session.stats.outcomes++;
    }
    this.evidence.record({
      kind: o.scope === 'match' ? 'matchOutcome' : 'roundOutcome',
      tick: this.game.tick,
      serverTimeMs: this.serverTimeMs(),
      roundIndex: o.roundIndex ?? null,
      phase: this.game.match?.phase ?? null,
      actorId: o.actorId,
      reason: o.reason ?? o.outcomeReason ?? null,
    });
    return buf;
  }

  /**
   * The server's monotonic clock, in ms, in the domain `wire-protocol.md` §8.10 calls
   * "server monotonic". Derived from the tick rather than from the wall clock so it cannot
   * drift away from the simulation it timestamps, and so a replay of the same ticks produces
   * the same evidence.
   */
  serverTimeMs() { return Math.round(this.game.tick * FIXED_DT * 1000) >>> 0; }

  /**
   * Send each client its own view of the match state, when its own view has changed.
   *
   * "Its own" is the entire point: `bombCarrierId` and the bomb coordinates are filtered per
   * recipient (§8.6, §8.8), so two clients receive different bytes for one server state. The
   * change test is therefore per session, against the bytes THAT client last received.
   */
  _broadcastMatchState() {
    const state = readBombMatchState(this.game);
    if (!state) return;                       // not a Bomb match: nothing to say
    const serverTimeMs = this.serverTimeMs();

    for (const session of this.clients.values()) {
      if (session.rejected) continue;
      const buf = encodeMatchState(this._matchStateFor(session, state, serverTimeMs));
      session.matchStateAge++;
      if (session.lastMatchState
        && sameMatchStateIgnoringClock(buf, session.lastMatchState)
        && session.matchStateAge < MATCHSTATE_HEARTBEAT_TICKS) continue;
      session.transport.send(buf);
      session.lastMatchState = buf;
      session.matchStateAge = 0;
      session.stats.matchStates++;
    }
  }

  /**
   * One recipient's filtered view.
   *
   * The two filters are the anti-cheat model in miniature: if it is not on the wire, the
   * client cannot cheat with it. Sending true coordinates to everyone and hiding them in the
   * UI would be a wallhack shipped in the protocol.
   */
  _matchStateFor(session, state, serverTimeMs) {
    const viewer = session.entity;
    const bomb = state.bomb;
    const role = roleOf(viewer, state.attackingTeam);

    // §8.8 — the carrier. Teammates always; enemies only under line of sight.
    let carrierId = 0;
    if (bomb.carrierId) {
      const carrier = this._entityById(bomb.carrierId);
      const sameTeam = carrier && viewer && carrier.team === viewer.team;
      if (sameTeam || (carrier && this._canSee(viewer, carrier.position))) carrierId = bomb.carrierId;
    }

    // §8.6 — the position, in the contract's order.
    //   1. is the position a thing that exists?   no -> hidden (a carried bomb has none)
    //   2. is this recipient authorised for it?   no -> hidden
    //   3. otherwise                                  -> the real coordinates
    let position = null;
    if (bomb.position && (bomb.state === 'dropped' || bomb.state === 'planted')) {
      const authorised = role === 'attacker'
        // A planted bomb's position is public: the defenders have to find it to defuse it.
        || bomb.state === 'planted'
        // A dropped one is intel, so a defender earns it by seeing it.
        || this._canSee(viewer, bomb.position);
      if (authorised) position = bomb.position;
    }

    return {
      phase: state.phase,
      roundIndex: state.roundIndex,
      localRole: role,
      scoreAlpha: state.scoreAlpha,
      scoreBravo: state.scoreBravo,
      phaseRemainingMs: state.phaseRemainingMs,
      aliveAlpha: state.aliveAlpha,
      aliveBravo: state.aliveBravo,
      bombState: bomb.state,
      bombCarrierId: carrierId,
      bombSite: bomb.siteId,
      interactActorId: state.interaction.actorId ?? 0,
      interactProgress: Math.round(Math.max(0, Math.min(1, state.interaction.progress)) * INTERACT_PROGRESS_MAX),
      sideSwitched: state.sideSwitched,
      serverTimeMs,
      bombPosition: position,
    };
  }

  _entityById(id) {
    for (const e of this.game.entities) if (e.id === id) return e;
    return null;
  }

  /**
   * Can this viewer actually see that point?
   *
   * Geometry only — the same `losClear` the AI's senses use — so "visible" means the same
   * thing to the filter as it does to the player looking at their screen. A dead or missing
   * viewer sees nothing: elimination is not a licence to learn where the bomb is.
   */
  _canSee(viewer, point) {
    if (!viewer || !point || !viewer.alive) return false;
    const world = this.game.world;
    if (!world?.losClear) return false;
    _eye.set(viewer.position.x, viewer.position.y + (viewer.eyeHeight ?? 1.6), viewer.position.z);
    return world.losClear(_eye, point);
  }

  /** Buffer one feedback event for the next snapshot, respecting the cap. */
  _record(ev) {
    if (this._pendingEvents.length < MAX_PENDING_EVENTS) {
      this._pendingEvents.push(ev);
    } else if (ev?.kind === 'roundEnd') {
      // The final whistle is state, not optional presentation. In the pathological case
      // where one tick filled the feedback budget, replace the last cosmetic event rather
      // than leave every client in a round the server has already ended.
      this._pendingEvents[MAX_PENDING_EVENTS - 1] = ev;
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
    if (this._pendingRoundEnd) {
      this._record(this._pendingRoundEnd);
      this._pendingRoundEnd = null;
    }

    // The mark lives for exactly the tick that consumed the command. Leaving it set would
    // rewind every later shot to a stale view.
    for (const session of this.clients.values()) {
      if (session.entity) session.entity._lagViewTick = null;
    }

    // After the step, so the sample is the state a client will be told about.
    this.lag.record();

    // Every tick, but sent only when a recipient's own view has actually changed — see
    // `_broadcastMatchState`. Checked at the tick rate rather than the snapshot rate because
    // a plant completing between two snapshots is exactly the moment that must not be late.
    this._broadcastMatchState();

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

/** Scratch eye position. `losClear` reads x/y/z, so a plain object is enough and allocates none. */
const _eye = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };

/** The eleven §8.7 kinds this server will accept from the ruleset. Anything else is dropped. */
const EV_BOMB_KINDS = new Set([
  'plantStart', 'plantComplete', 'plantCancel',
  'defuseStart', 'defuseComplete', 'defuseCancel',
  'bombDropped', 'bombPickedUp', 'bombDetonated',
  'roundStart', 'interactRefused',
]);

/** The mode's string id, from whichever of the two fields carries it. */
function bombModeId(match) {
  if (typeof match?.modeId === 'string') return match.modeId;
  if (typeof match?.mode === 'string') return match.mode;
  return match?.mode?.id ?? null;
}

/** Which side this viewer is on THIS round. Sides switch, so it is derived, never stored. */
function roleOf(viewer, attackingTeam) {
  if (!viewer || viewer.team == null || attackingTeam == null) return 'none';
  return viewer.team === attackingTeam ? 'attacker' : 'defender';
}

/**
 * Two `MSG_MATCHSTATE` frames, compared on everything except the clock.
 *
 * `serverTimeMs` (bytes 24–27) changes every single tick, so including it would make "send on
 * change" mean "send always". Everything else is compared byte for byte — which is stronger
 * than comparing the objects that produced them, because it is the bytes the client decodes.
 */
function sameMatchStateIgnoringClock(a, b) {
  if (a.byteLength !== MATCHSTATE_BYTES || b.byteLength !== MATCHSTATE_BYTES) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < 24; i++) if (x[i] !== y[i]) return false;
  for (let i = 28; i < MATCHSTATE_BYTES; i++) if (x[i] !== y[i]) return false;
  return true;
}

/**
 * The unfiltered Bomb state, normalised out of whatever `Match` exposes.
 *
 * Returns `null` for any match that is not running the Bomb ruleset, which is what keeps
 * `MSG_MATCHSTATE` off a TDM stream entirely rather than sending a message full of zeroes.
 *
 * The shape this reads is the contract with `src/game/match.js`:
 *
 *   match.mode            'bomb'
 *   match.phase           one of PHASES
 *   match.roundIndex      0-based
 *   match.scores          [alpha, bravo]
 *   match.aliveCounts     { alpha, bravo }
 *   match.phaseRemainingMs
 *   match.sideSwitched    boolean
 *   match.attackingTeam   0 | 1 — which team index is attacking THIS round
 *   match.bomb            { state, carrierId, siteId, position }   (position null unless
 *                          dropped/planted; a carried bomb's location is the carrier's)
 *   match.interaction     { kind, actorId, progress }              (progress 0..1)
 *
 * Everything is defaulted rather than assumed, so a half-built ruleset produces an honest
 * `none`/`warmup` frame instead of throwing inside the tick loop.
 */
export function readBombMatchState(game) {
  // `Match.mode` is the mode OBJECT and `Match.modeId` is its string id — reading the wrong
  // one compares an object to a string, which is false forever and silently turns this whole
  // message off. Both are accepted so a change of shape on that side cannot do it quietly.
  const m = game?.match;
  if (!m || bombModeId(m) !== 'bomb') return null;
  const bomb = m.bomb ?? {};
  const inter = m.interaction ?? {};
  const alive = m.aliveCounts ?? {};
  const state = BOMB_STATES.includes(bomb.state) ? bomb.state : 'none';
  return {
    phase: PHASES.includes(m.phase) ? m.phase : 'warmup',
    roundIndex: m.roundIndex ?? 0,
    scoreAlpha: m.scores?.[0] ?? 0,
    scoreBravo: m.scores?.[1] ?? 0,
    phaseRemainingMs: m.phaseRemainingMs ?? 0,
    aliveAlpha: alive.alpha ?? 0,
    aliveBravo: alive.bravo ?? 0,
    sideSwitched: !!m.sideSwitched,
    attackingTeam: m.attackingTeam ?? 0,
    bomb: {
      state,
      carrierId: bomb.carrierId ?? 0,
      siteId: bomb.siteId ?? null,
      // Held only for `dropped` and `planted`. A carried bomb has no position of its own —
      // it is wherever the carrier is, and `carrierId` names them.
      position: (state === 'dropped' || state === 'planted') ? (bomb.position ?? null) : null,
    },
    interaction: {
      kind: inter.kind ?? 'none',
      actorId: inter.actorId ?? 0,
      progress: inter.progress ?? 0,
    },
  };
}

/** Shortest signed difference between two angles. */
function wrapAngle(a) {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}
