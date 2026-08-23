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
  encodeMatchState, encodeOutcome, MATCHSTATE_BYTES, INTERACT_PROGRESS_MAX, packInteract,
  REJECT_PROTOCOL_VERSION_MISMATCH, REJECT_SESSION_TOKEN_INVALID, BOMB_STATES, PHASES,
  INTERACT_KINDS, CANCEL_REASONS, REFUSAL_REASONS, OUTCOME_REASONS,
  REJECT_AUTH_SESSION_REPLACED, REJECT_MALFORMED_HELLO,
  W_RECONNECT,
  MSG_TACTICAL_PING, decodeTacticalPingIntent, encodeTacticalPingEvent,
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
export const EVENT_RANGE_M = 90;
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

/** A socket that never authenticates must not occupy connection state indefinitely. */
export const HELLO_TIMEOUT_MS = 5_000;

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
  constructor(id, transport, entity = null) {
    this.id = id;
    this.transport = transport;
    /**
     * The entity this connection drives — **null until `MSG_HELLO` has been accepted**.
     *
     * §8.2 step 4: "No entity exists before step 4. An unauthenticated socket can never cause
     * allocation." It could: `addClient` allocated and welcomed before any hello, and
     * `_onMessage` then accepted commands from a socket that had never said one, so the whole
     * gate was optional. Everything the server SENDS is gated on `authenticated` for the same
     * reason — a socket that has not identified itself must not be fed the world.
     */
    this.entity = entity;
    /**
     * What `_allocateEntity` will bind on a successful hello: an entity, or a factory that
     * makes one. Held rather than used, so it costs nothing until the handshake earns it.
     */
    this.pendingEntity = null;
    /** True once a well-formed, version-matched hello has been answered with a welcome. */
    this.authenticated = false;
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
    this.lastTacticalPingAt = -Infinity;
    /**
     * Set once this connection has been refused (§8.3). A rejected socket is closed
     * immediately, but a frame already in flight can still arrive — and a client that
     * disagrees about the layout is exactly the one whose bytes must not be decoded. Every
     * later message from it is dropped without being read.
     */
    this.rejected = null;
    /** The version this client said it speaks, or null if it never sent a hello. */
    this.helloVersion = null;
    /** The signed session ticket decoded from `MSG_HELLO`; `_onHello` verifies and consumes it
     * before this session can receive an entity. Retained for connection diagnostics only. */
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
      /** Frames that arrived before a hello. Each one closes the connection (§8.2). */
      preHelloMessages: 0,
      loadouts: 0,
      tacticalPings: 0, tacticalPingsRateLimited: 0,
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
    this.combatSamples = [];
    this.droppedCombatSamples = 0;
    this.combatObserved = 0;
    this.connectionFacts = [];
    this.droppedConnectionFacts = 0;
    this.antiCheatFlags = [];
    this.droppedAntiCheatFlags = 0;
    this._nextEventSeq = 0;
    this.rulesetVersion = null;
    this.serverBuild = null;
    this.matchId = null;
  }

  /** Identify the match this record belongs to. Called once, when the match is known. */
  identify({ matchId = null, rulesetVersion = null, serverBuild = null } = {}) {
    if (matchId != null && matchId !== this.matchId) {
      this.rows.length = 0;
      this.dropped = 0;
      this.combatSamples.length = 0;
      this.droppedCombatSamples = 0;
      this.combatObserved = 0;
      this.connectionFacts.length = 0;
      this.droppedConnectionFacts = 0;
      this.antiCheatFlags.length = 0;
      this.droppedAntiCheatFlags = 0;
      this._nextEventSeq = 0;
    }
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
      eventSeq: this._nextEventSeq++,
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

  /** Bounded authoritative combat/position sample; final counters live in combatSummary. */
  recordCombat(row = {}) {
    // §7 asks for compact combat samples, not an unbounded duplicate of every ballistic
    // event. Kills are always retained; shots and damage are sampled deterministically.
    this.combatObserved++;
    if (row.kind !== 'kill' && this.combatObserved % 16 !== 0) return null;
    if (this.combatSamples.length >= this.limit) { this.droppedCombatSamples++; return null; }
    const position = row.position;
    const targetPosition = row.targetPosition;
    const out = {
      seq: this.combatSamples.length, eventSeq: this._nextEventSeq++,
      kind: String(row.kind ?? 'unknown'),
      tick: row.tick | 0, serverTimeMs: row.serverTimeMs | 0,
      actorId: row.actorId ? row.actorId >>> 0 : null,
      targetId: row.targetId ? row.targetId >>> 0 : null,
      weaponId: row.weaponId ?? null, amount: Math.max(0, Math.round(Number(row.amount) || 0)),
      headshot: !!row.headshot,
      position: position ? { x: round3(position.x), y: round3(position.y), z: round3(position.z) } : null,
      targetPosition: targetPosition
        ? { x: round3(targetPosition.x), y: round3(targetPosition.y), z: round3(targetPosition.z) } : null,
    };
    this.combatSamples.push(out);
    return out;
  }

  recordConnection(row = {}) {
    if (this.connectionFacts.length >= this.limit) { this.droppedConnectionFacts++; return null; }
    const out = { seq: this.connectionFacts.length, eventSeq: this._nextEventSeq++,
      kind: String(row.kind ?? 'unknown'), tick: row.tick == null ? null : row.tick | 0,
      serverTimeMs: row.serverTimeMs == null ? null : row.serverTimeMs | 0,
      accountId: row.accountId ?? null, entityId: row.entityId ? row.entityId >>> 0 : null,
      at: row.at ?? null, reason: row.reason ?? null };
    this.connectionFacts.push(out);
    return out;
  }

  recordAntiCheat(row = {}) {
    if (this.antiCheatFlags.length >= this.limit) { this.droppedAntiCheatFlags++; return null; }
    const out = { seq: this.antiCheatFlags.length, eventSeq: this._nextEventSeq++,
      kind: String(row.kind ?? 'unknown'), tick: row.tick == null ? null : row.tick | 0,
      serverTimeMs: row.serverTimeMs == null ? null : row.serverTimeMs | 0,
      accountId: row.accountId ?? null, severity: row.severity ?? null,
      details: row.details ?? null };
    this.antiCheatFlags.push(out);
    return out;
  }

  /**
   * The serialisable record. What `evidenceRef` ultimately points at.
   *
   * Every section is a COPY, never the live array. This returned `objectives: this.rows` (and
   * the three siblings) while `eventTimeline` was materialised here — so the terminal record a
   * match certified at `matchEnd` kept mutating afterwards. The reliable trigger is the most
   * ordinary one there is: the winning player's client closes its socket seconds after the
   * outcome, the close handler records a `disconnected` connection fact, and the ALREADY
   * CERTIFIED result now contains a section row its own `eventTimeline` and `evidenceRef`
   * digest have never seen. The platform then refuses the evidence as tampered
   * (`eventTimeline section-mismatch` / digest mismatch) on every poll, and every full-length
   * live match "ended" as an abort (overstrike-gs-iad-1, 2026-08-21..23). The rows themselves
   * are written once at record time and never mutated, so a shallow copy per section is a
   * true snapshot.
   */
  toJSON() {
    const eventTimeline = [
      ...this.rows.map((row) => ({ channel: 'objective', ...row })),
      ...this.combatSamples.map((row) => ({ channel: 'combat', ...row })),
      ...this.connectionFacts.map((row) => ({ channel: 'connection', ...row })),
      ...this.antiCheatFlags.map((row) => ({ channel: 'antiCheat', ...row })),
    ].sort((a, b) => a.eventSeq - b.eventSeq);
    return {
      version: 1,
      matchId: this.matchId,
      rulesetVersion: this.rulesetVersion,
      serverBuild: this.serverBuild,
      protocolVersion: PROTOCOL_VERSION,
      objectives: [...this.rows],
      eventTimeline,
      combatSamples: [...this.combatSamples],
      combatSampling: { observed: this.combatObserved, every: 16,
        retained: this.combatSamples.length, killsAlwaysRetained: true },
      droppedCombatSamples: this.droppedCombatSamples,
      connectionFacts: [...this.connectionFacts],
      droppedConnectionFacts: this.droppedConnectionFacts,
      antiCheatFlags: [...this.antiCheatFlags],
      droppedAntiCheatFlags: this.droppedAntiCheatFlags,
      droppedRows: this.dropped,
    };
  }
}

const round3 = (x) => Math.round((Number(x) || 0) * 1000) / 1000;

export class GameServer {
  /**
   * @param {Game} game a Game that has already had `initHeadless()` run on it
   */
  constructor(game, { ticketVerifier = null, matchBinder = null,
    clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) } = {}) {
    this.game = game;
    this.ticketVerifier = ticketVerifier;
    this.matchBinder = matchBinder;
    this._clock = clock;
    this.clients = new Map();
    /** Feedback recorded by `RecordingPresenter`, drained into each snapshot. */
    this._pendingEvents = [];
    this._pendingRoundEnd = null;
    this._nextClientId = 1;
    this._snapCounter = 0;
    this.lag = new LagCompensation(game);
    /** The authoritative objective record. See `ObjectiveEvidence`. */
    this.evidence = new ObjectiveEvidence();
    /**
     * Server-side counters for the things that must never be silent.
     *
     * `unmappedReasons` and `refusalsWithoutTarget` are both "the producer said something this
     * layer cannot faithfully put on the wire". Encoding index 0 and moving on is what let a
     * `wrongTeam` refusal arrive as `not-eligible` in a fully green suite.
     */
    this.stats = { outcomes: 0, unmappedReasons: 0, refusalsWithoutTarget: 0 };
    /** The distinct `kind:reason` pairs that had no §8.7 enum. Named, so a fix is mechanical. */
    this.unmappedReasons = new Set();
    /** The planter or defuser who decided the current round — `MSG_OUTCOME.actorId` (§8.9). */
    this._lastObjectiveActor = 0;
    this._sentMatchOutcome = false;

    // The Bomb ruleset (`src/game/match.js`) announces every objective fact on the bus, and
    // this is the ONE place it becomes both a wire event and an evidence row — see
    // `objectiveEvent`. One ingestion point, so the two can never describe different rounds.
    game.bus?.on('objective', (p) => this.objectiveEvent(p));
    // Kept as a direct entry point for anything that already knows the §8.9 shape. It is NOT
    // where outcomes come from today — nothing in `src/` emits `outcome`, which is why relying
    // on it alone meant a whole match produced zero `MSG_OUTCOME`. See `_outcomeFromObjective`.
    game.bus?.on('outcome', (p) => this.sendOutcome(p));
    // TDM has no objective state machine: its canonical terminal fact is Game.matchEnd.
    // Bomb reaches this event too, after its objective `matchEnd`, so the shared sent flag
    // makes this a fallback rather than a duplicate terminal frame.
    game.bus?.on('matchStart', () => { this._sentMatchOutcome = false; });
    game.bus?.on('matchEnd', (p) => {
      if (!this._sentMatchOutcome) this._outcomeFromObjective({ kind: 'matchEnd' }, {
        ...p, scope: 'match', roundsPlayed: p?.rounds?.length ?? 0,
      });
    });

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
      this.evidence.recordCombat({ kind: 'kill', tick: game.tick,
        serverTimeMs: this.serverTimeMs(), actorId: p?.attacker?.id, targetId: p?.victim?.id,
        weaponId: p?.weaponId, headshot: p?.headshot, position: p?.attacker?.position,
        targetPosition: p?.victim?.position });
      this._record({
        kind: 'kill', to: null,
        killerId: p?.attacker?.id ?? 0,
        victimId: p?.victim?.id ?? 0,
        headshot: !!p?.headshot,
      });
    });
    game.bus?.on('shot', (p) => this.evidence.recordCombat({ kind: 'shot', tick: game.tick,
      serverTimeMs: this.serverTimeMs(), actorId: p?.shooter?.id, weaponId: p?.weaponId,
      position: p?.shooter?.position }));
    game.bus?.on('damage', (p) => this.evidence.recordCombat({ kind: 'damage', tick: game.tick,
      serverTimeMs: this.serverTimeMs(), actorId: p?.attacker?.id, targetId: p?.target?.id,
      weaponId: p?.weaponId, amount: p?.amount, position: p?.attacker?.position,
      targetPosition: p?.target?.position }));
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
   * Attach a socket. **This does not create an entity and does not send a welcome.**
   *
   * §8.2 is an ordered list and step 4 — "create or rebind the entity, send `MSG_WELCOME`" —
   * comes after the version check. It did not: `addClient` allocated the entity, welcomed it,
   * and `_onMessage` accepted `MSG_COMMANDS` from a socket that had never said hello. Measured
   * against the code as it stood: entity allocated, welcome sent, 120 commands consumed, the
   * entity walked 4.11 m, and `session.rejected` was still null. The version check was correct
   * whenever a hello arrived; sending one was optional, which is the same as having no gate.
   *
   * @param {object} transport the socket
   * @param {object|Function} entity the Player this connection will drive, or a factory
   *   called with the session when the handshake succeeds. A factory is what an internet-facing
   *   listener should pass: then not one object exists for a socket that never identifies
   *   itself, which is what §8.2's "an unauthenticated socket can never cause allocation" asks
   *   for. An already-built entity is accepted for in-process harnesses, and is still not
   *   BOUND — nothing is sent to it and no command from it is applied — until the hello lands.
   */
  addClient(transport, entity = null) {
    const id = this._nextClientId++;
    const session = new ClientSession(id, transport, null);
    session.pendingEntity = entity;
    this.clients.set(id, session);
    transport.onMessage((data) => this._onMessage(session, data));
    session.helloTimer = setTimeout(() => {
      if (!session.authenticated && !session.rejected) {
        this.rejectClient(session, REJECT_SESSION_TOKEN_INVALID);
      }
    }, HELLO_TIMEOUT_MS);
    session.helloTimer.unref?.();
    return session;
  }

  /**
   * §8.2 step 4, and the only place an entity is bound to a connection.
   *
   * Returns null if there is nothing to bind, which is a refusal rather than a silent
   * session with no body: a session whose entity is null would receive snapshots of a world
   * it is not in.
   */
  _allocateEntity(session) {
    const pending = session.pendingEntity;
    session.pendingEntity = null;
    if (!pending) return null;
    return typeof pending === 'function' ? (pending(session) ?? null) : pending;
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
      flags: session.isReconnect ? W_RECONNECT : 0,
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
   * Step 2 validates and atomically consumes the signed ticket through `ticketVerifier`, then
   * `matchBinder` checks its exact allocation roster/team/loadout authority. Step 3 replaces an
   * existing account session newest-wins without duplicating its body. Step 4 — creating or
   * re-binding the entity and welcoming — happens HERE, after those gates; it used to happen in
   * `addClient` before a single byte had been read.
   */
  async _onHello(session, data) {
    if (session.authenticating) return;
    session.authenticating = true;
    const hello = decodeHello(data);
    // A known type at the wrong length means a desynced/corrupt frame (§8.11), not a version
    // disagreement — `decodeHello` returns null for a truncated buffer, a wrong type byte, or a
    // ticket-length byte that does not match the remaining bytes, none of which say anything
    // about which protocol version the client speaks. Reusing PROTOCOL_VERSION_MISMATCH here
    // told a client with a pure framing bug to upgrade its build, which is the wrong diagnosis.
    if (!hello) { this.rejectClient(session, REJECT_MALFORMED_HELLO); return; }
    session.helloVersion = hello.protocolVersion;
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      this.rejectClient(session, REJECT_PROTOCOL_VERSION_MISMATCH);
      return;
    }
    session.ticket = hello.ticket;
    if (this.ticketVerifier) {
      const identity = await this.ticketVerifier(hello.ticket);
      if (!identity) { this.rejectClient(session, REJECT_SESSION_TOKEN_INVALID); return; }
      if (this.matchBinder && this.matchBinder(identity) !== true) {
        this.rejectClient(session, REJECT_SESSION_TOKEN_INVALID); return;
      }
      const duplicate = [...this.clients.values()].find((other) => other !== session
        && other.authenticated && other.identity?.sub === identity.sub);
      session.identity = identity;
      // Frozen policy: the newest authenticated connection wins. Transfer the existing body
      // synchronously before closing the old transport so reconnect cannot briefly create a
      // duplicate entity (the ws `close` callback runs later).
      if (duplicate) {
        const rebound = duplicate.entity;
        this.rejectClient(duplicate, REJECT_AUTH_SESSION_REPLACED);
        duplicate.entity = null;
        if (rebound) {
          session.pendingEntity = rebound;
          session.isReconnect = true;
        }
      }
    }
    // A second hello on an established session re-welcomes and nothing more. Allocating again
    // would give one socket two entities, which is a way to be in two places at once.
    if (!session.authenticated) {
      const entity = this._allocateEntity(session);
      if (!entity) { this.rejectClient(session, REJECT_SESSION_TOKEN_INVALID); return; }
      session.entity = entity;
      session.authenticated = true;
      clearTimeout(session.helloTimer);
      session.helloTimer = null;
    }
    this._sendWelcome(session);
    session.authenticating = false;
  }

  /**
   * Re-welcome everyone, so they adopt the new match's seed.
   *
   * Authenticated sessions only: an unauthenticated one has no entity to name, and telling a
   * socket that has not identified itself which entity it drives would be answering a question
   * it has not asked.
   */
  broadcastWelcome() {
    for (const session of this.clients.values()) {
      if (session.rejected || !session.authenticated) continue;
      this._sendWelcome(session);
    }
  }

  removeClient(session) {
    clearTimeout(session.helloTimer);
    session.helloTimer = null;
    this.clients.delete(session.id);
    if (session.entity) {
      this.game.match?.bombRules?.releaseInteract?.(session.entity);
      session.entity._objectiveHeld = false;
      this.lag.forget(session.entity.id);
    }
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
    if (type === MSG_HELLO) {
      void this._onHello(session, data).catch(() => this.rejectClient(session, REJECT_SESSION_TOKEN_INVALID));
      return;
    }
    // §8.2: `MSG_HELLO` is **the first frame on the socket. Anything else before it closes the
    // connection.** Not "is ignored" — an unauthenticated peer that is allowed to keep talking
    // is an unauthenticated peer, and §8.11's "unknown type is ignored" is about a KNOWN
    // handshake carrying a type this build does not have, which is a different situation.
    if (!session.authenticated) {
      session.stats.preHelloMessages++;
      this.rejectClient(session, REJECT_SESSION_TOKEN_INVALID);
      return;
    }
    if (type === MSG_LOADOUT) { this._applyLoadout(session, data); return; }
    if (type === MSG_TACTICAL_PING) { this._applyTacticalPing(session, data); return; }
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

  _applyTacticalPing(session, data) {
    const intent = decodeTacticalPingIntent(data);
    const entity = session.entity;
    if (!intent || !entity?.alive || !entity.position
      || (entity.team !== 0 && entity.team !== 1)) return false;
    const at = this._clock();
    if (at - session.lastTacticalPingAt < 1500) {
      session.stats.tacticalPingsRateLimited++;
      return false;
    }
    session.lastTacticalPingAt = at;
    const event = encodeTacticalPingEvent({ senderId: entity.id, kind: intent.kind,
      position: entity.position });
    for (const peer of this.clients.values()) {
      if (peer.rejected || !peer.authenticated || peer.entity?.team !== entity.team) continue;
      peer.transport.send(event);
    }
    session.stats.tacticalPings++;
    return true;
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
    session.stats.loadouts++;
    // Internet sessions are armed from the signed lobby allocation. A client frame may ask
    // to reapply that choice after local recovery, but may never replace it.
    if (session.identity) {
      this.reapplyLoadout(session);
      return;
    }
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
   *
   * **`normaliseObjective` exists because the producer does not speak that shape.** `bomb.js`
   * `_emit` puts `{ kind, tick, round, entityId, reason, site, x, y, z, requested }` on the bus
   * and this method read `{ actorId, actorTeam, position, roundIndex, requestedKind, to }` —
   * six fields, none of which the producer sets. There was no adapter, `game.bus.on('objective')`
   * subscribed this straight through, and the two shapes had never met: measured on the real
   * emission, the evidence row's `actorId` came back `null` and a `bombDropped` at (-4, 0, 35)
   * reached the authorised attacker as `x:0 y:0 z:0` — the REQ-CC-030 "(0,0,0) is a valid world
   * position" failure, re-introduced on the event path. The tests hand-fed the shape the TEST
   * invented, so both sides stayed green while agreeing about nothing.
   */
  objectiveEvent(raw) {
    const p = normaliseObjective(raw, this);
    const kind = p?.kind;
    // Round and match ends arrive on this same bus and are not §8.7 event kinds — they are
    // `MSG_OUTCOME` (§8.9). See `_outcomeFromObjective`.
    if (kind === 'roundEnd' || kind === 'matchEnd') return this._outcomeFromObjective(p, raw);
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
      // Unfiltered, and in the producer's own words: `reason` is recorded before the wire
      // mapping below, because evidence is the truth and the wire is a projection of it.
      position: p.position ?? null,
      reason: p.reason ?? null,
      requestedKind: p.requestedKind ?? null,
      progress: progress63,
    });

    // Latched for `MSG_OUTCOME.actorId` (§8.9: "planter, defuser, or 0"). The ruleset's round
    // record names a clutch player, not the actor who decided the round, so the completion
    // event is the only place that fact exists.
    if (kind === 'plantComplete' || kind === 'defuseComplete') {
      this._lastObjectiveActor = (p.actorId ?? 0) >>> 0;
    }

    // A refusal is a private fact about one player's input — §8.7: sent only to the refused
    // player. Broadcasting it would tell the whole server who is standing on a site trying to
    // plant, which is the information the objective volumes exist to make people fight over.
    //
    // `p.actorId` is `undefined` on the producer's shape unless `normaliseObjective` has read
    // `entityId`, which is exactly why this used to broadcast: `p.to ?? p.actorId ?? null`
    // collapsed to null and null means everyone. A refusal with no known recipient is DROPPED
    // rather than broadcast — there is no such thing as a public refusal.
    let to = null;
    if (kind === 'interactRefused') {
      to = p.to ?? p.actorId ?? null;
      if (!to) {
        this.stats.refusalsWithoutTarget++;
        warnOnce(`objective: interactRefused with no actor — dropped rather than broadcast`);
        return row;
      }
    }
    const pos = p.position;
    this._record({
      kind,
      to,
      entityId: (p.actorId ?? 0) >>> 0,
      victimId: (p.victimId ?? 0) >>> 0,
      amount: p.amount ?? 0,
      reason: this._wireReason(kind, p.reason),
      requestedKind: p.requestedKind ?? null,
      x: pos?.x ?? 0, y: pos?.y ?? 0, z: pos?.z ?? 0,
    });
    return row;
  }

  /**
   * A ruleset reason, translated into the enum the wire actually carries (§8.7).
   *
   * The two vocabularies do not overlap. `bomb.js` `REFUSE` declares eleven camelCase names
   * "on the wire"; `CANCEL_REASONS` and `REFUSAL_REASONS` are the §8.7 kebab-case tables, and
   * only `released` appears in both. `reasonIndex` falls back to 0 for anything it does not
   * recognise, so — measured — a `wrongTeam` refusal arrived at the client as `not-eligible`,
   * a `carrierDeath` drop as `released`, and every distinction the enum exists to draw was
   * flattened into whichever name happens to sit at index 0.
   *
   * An unmappable reason is LOUD: counted and warned. Silently encoding 0 is what produced a
   * green suite over a wire that said the wrong thing about every refusal in the game.
   */
  _wireReason(kind, reason) {
    if (reason == null) return null;
    const table = kind === 'interactRefused' ? REFUSAL_REASONS
      : (kind === 'plantCancel' || kind === 'defuseCancel') ? CANCEL_REASONS
        : null;
    if (!table) return reason;
    if (typeof reason === 'number') return reason;
    // Already a §8.7 name: pass it through untouched.
    if (table.indexOf(reason) >= 0) return reason;
    const mapped = kind === 'interactRefused'
      ? RULESET_REFUSAL_REASON[reason]
      : RULESET_CANCEL_REASON[reason];
    if (mapped !== undefined) return mapped;
    this.stats.unmappedReasons++;
    this.unmappedReasons.add(`${kind}:${reason}`);
    warnOnce(`objective: ruleset reason "${reason}" on ${kind} maps to no §8.7 enum — sent as `
      + `"${table[0]}". Add it to RULESET_${kind === 'interactRefused' ? 'REFUSAL' : 'CANCEL'}_REASON.`);
    return table[0];
  }

  /**
   * `MSG_OUTCOME` (§8.9), built from the round and match ends the ruleset already announces.
   *
   * `GameServer` subscribed `game.bus.on('outcome')` and **nothing in `src/` has ever emitted
   * `outcome`** — verified by grep, and measured: a full Bomb match produced 7200 snapshots,
   * 2247 match states and not one `MSG_OUTCOME`, so `net-facade.md`'s `roundEnded`/`matchEnded`
   * could not be delivered at all. That is the exact gap REQ-CC-012 added the message to close,
   * and the codec was correct the whole time — the message simply never left the server.
   *
   * Sourced from the `objective` bus rather than from a new emitter in another lane's file, and
   * rather than from polling the ruleset's phase: `bomb.js` `_endRound` and `_endMatch` already
   * publish a complete record (`{ winnerTeam, reason, roundWins, roundsPlayed, ... }`) as the
   * LAST step of their own ordered sequence, which is precisely the moment §8.9 says to send —
   * "immediately before the corresponding `MSG_MATCHSTATE` phase change". A phase poll would
   * fire on the next tick's broadcast instead, i.e. after it. Nothing new is asked of `match.js`
   * or `bomb.js`; this reads what they already say.
   */
  _outcomeFromObjective(p, raw) {
    const match = raw?.scope === 'match' || p.kind === 'matchEnd';
    const rules = this.game.match?.bombRules ?? null;
    const winnerTeam = raw?.winnerTeam;
    const reasonSrc = raw?.outcomeReason ?? raw?.reason ?? null;
    const scores = raw?.roundWins ?? rules?.roundWins ?? [0, 0];
    const outcome = {
      scope: match ? 'match' : 'round',
      // Match scope is not about one round, and §8.9 spells that as 255, not as round 0.
      roundIndex: match ? null : ((raw?.round ?? rules?.roundNumber ?? 1) - 1),
      winner: outcomeWinner(winnerTeam, reasonSrc),
      reason: outcomeReason(reasonSrc),
      terminationReason: raw?.terminationReason ?? 'completed',
      scoreAlpha: scores[0] ?? 0,
      scoreBravo: scores[1] ?? 0,
      roundsPlayed: raw?.roundsPlayed ?? rules?.rounds?.length ?? 0,
      // The planter or defuser, per §8.9. Latched from the completion event that decided the
      // round, because the ruleset's round record names a clutch player and not an actor.
      actorId: match ? 0 : (this._lastObjectiveActor ?? 0),
      matchId: this.evidence.matchId,
    };
    this.sendOutcome(outcome);
    if (!match) this._lastObjectiveActor = 0;
    return outcome;
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
    if (o.scope === 'match') {
      if (this._sentMatchOutcome) return null;
      this._sentMatchOutcome = true;
    }
    const buf = encodeOutcome(o);
    for (const session of this.clients.values()) {
      if (session.rejected || !session.authenticated) continue;
      session.transport.send(buf);
      session.stats.outcomes++;
    }
    this.stats.outcomes++;
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
      if (session.rejected || !session.authenticated) continue;
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
    //
    // `carrier.team === viewer.team` is TRUE when both are `undefined`, so a viewer with no
    // team — a spectator, or an entity that has not been assigned one — read as a teammate of
    // an unassigned carrier and was handed the id. Both sides must name a real side.
    let carrierId = 0;
    if (bomb.carrierId) {
      const carrier = this._entityById(bomb.carrierId);
      const sameTeam = !!carrier && !!viewer
        && carrier.team != null && viewer.team != null && carrier.team === viewer.team;
      if (sameTeam || (carrier && this._canSee(viewer, carrier.position))) carrierId = bomb.carrierId;
    }

    // §8.6 — the position, in the contract's order.
    //   1. is the position a thing that exists?   no -> hidden (a carried bomb has none)
    //   2. is this recipient authorised for it?   no -> hidden
    //   3. otherwise                                  -> the real coordinates
    const position = this._bombPositionAuthorised(viewer, bomb, role) ? bomb.position : null;

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

  /**
   * §8.6 step 2 / §8.8 — may this viewer learn where the bomb is?
   *
   * ONE predicate, used by both `MSG_MATCHSTATE` and the `bombDropped` event, because two
   * copies of an authorisation rule is how one of them ends up wrong. It was: the state
   * message filtered correctly and the event path had no filter at all.
   *
   * A viewer whose role is `none` — no entity, no team, a spectator — is authorised for
   * nothing. The old test short-circuited on `bomb.state === 'planted'` BEFORE looking at the
   * role, so `role: 'none'` was handed a planted bomb's coordinates; the contract grants that
   * to defenders, who have to find it to defuse it, not to everybody who is not an attacker.
   */
  _bombPositionAuthorised(viewer, bomb, role) {
    if (!bomb?.position) return false;
    if (bomb.state !== 'dropped' && bomb.state !== 'planted') return false;
    if (role === 'attacker') return true;
    if (role !== 'defender') return false;
    // A planted bomb's position is public to the side that must defuse it. A dropped one is
    // intel, so a defender earns it by seeing it.
    return bomb.state === 'planted' || this._canSee(viewer, bomb.position);
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

  /**
   * What this entity is planting or defusing, and how far through — the appended `interact`
   * entity field (§8.5), which is the one field that justified `PROTOCOL_VERSION` → 2.
   *
   * **Nothing in `src/` has ever assigned `entity.objective`.** `entityToWire` read it, a
   * comment described it, and the codec was proved against hand-built entities that set it —
   * so on every real snapshot ever sent the byte was `packInteract(0, 0)`. Measured over 400
   * ticks of a live Bomb match: exactly one distinct value on the wire, `0`.
   *
   * Read from the ruleset here because that is where the truth is (progress accumulates on the
   * server at the fixed step, §8.5), and `e.objective` is still preferred when it exists so the
   * producer can take this over — at which point `entityToWire` packs it and this returns null.
   *
   * **What `src/game/bomb.js` must assign for this to come from the producer:** on every entity
   * with progress, `entity.objective = { kind: 'plant' | 'defuse', progress }` with `progress`
   * a 0..1 fraction, cleared to `null` the moment the progress is cancelled or completed —
   * exactly the wording already in `wire-protocol.md` §8.5 and in `entityToWire`'s comment.
   * Until it does, this reads `bombRules.progressFraction(id)` and derives the kind, which is
   * public ruleset API but cannot tell a plant from a defuse for a second simultaneous actor;
   * `interaction` only ever names one.
   */
  _objectiveFor(e) {
    if (e?.objective) return e.objective;
    const rules = this.game.match?.bombRules;
    if (!rules?.progressFraction || !e) return null;
    const progress = rules.progressFraction(e.id);
    if (!(progress > 0)) return null;
    const inter = rules.interaction;
    // The named actor's kind is authoritative. For anyone else — two defenders on one bomb —
    // the side decides it: only attackers plant and only defenders defuse (§6, §7).
    const kind = inter && inter.actorId === e.id && inter.kind !== 'none'
      ? inter.kind
      : (e.team === rules.attackingTeam ? 'plant' : 'defuse');
    return { kind, progress };
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
      // An unauthenticated socket drives nothing. It has no entity to drive.
      if (!session.authenticated) continue;
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
    h.interactHeld = cmd.interactHeld;

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

    // Bomb interaction is held intent. The command carries only whether the key is held;
    // the server derives plant versus defuse from its own role/phase, then BombRules checks
    // team, life, carrier, volume and grounded state again. A modified client cannot choose
    // the privileged branch. Releasing clears all progress; a command-less tick reuses the
    // last held state just like movement/fire, and disconnect explicitly releases it.
    //
    // **`interactHeld`, not `interact`.** `interact` is an EDGE bit: a client holding the key
    // sends it `true` on the press command and `false` on all ~360 commands after it, so this
    // read one `true`, then reset the plant on the very next tick, every tick — §6.4 requires
    // the key held continuously and the wire had no field that could say so until v3. Bots
    // planted because `botManager` calls `requestInteract` directly and never encodes a
    // command; humans could not plant or defuse at all.
    const rules = this.game.match?.bombRules;
    if (rules) {
      e._objectiveHeld = !!cmd.interactHeld;
      if (cmd.interactHeld) {
        const kind = e.team === rules.attackingTeam ? 'plant' : 'defuse';
        rules.requestInteract(e, kind);
      } else {
        rules.releaseInteract(e);
      }
    }

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
    //
    // Guarded: `Object.keys(undefined)` throws, and this runs inside `tick()` for EVERY
    // client, so one session attached to an entity without an `_edge` map — a bot, a stand-in,
    // anything that is not a `Player` — took the tick loop down for the whole server, not just
    // for itself.
    const rules = this.game.match?.bombRules;
    if (rules) {
      if (e._objectiveHeld && e.alive) {
        const kind = e.team === rules.attackingTeam ? 'plant' : 'defuse';
        rules.requestInteract(e, kind);
      } else {
        if (!e.alive) e._objectiveHeld = false;
        rules.releaseInteract(e);
      }
    }
    if (!e._edge) return;
    for (const k of Object.keys(e._edge)) e._edge[k] = false;
    e._edge.slot = -1;
    e._edge.wheel = 0;
  }

  _broadcastSnapshot() {
    const g = this.game;
    const ents = g.entities;
    // sector-interest.md §5.2 — the coarse filter applied BEFORE the existing per-recipient
    // distance/authorisation checks below. Inert (`sectors === null`) on every map today,
    // since P3-06 has not landed `MAP_MANIFEST.sectors` yet — see `SectorInterest`'s header.
    const sectors = g.sectorInterest?.hasSectors() ? g.sectorInterest : null;
    const wire = [];
    const wireSectorId = sectors ? [] : null;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      const lo = g.weapons?.getLoadout?.(e);
      const w = entityToWire(e, lo ? Math.max(0, lo.index) : 0);
      // §8.5's `interact` byte, packed HERE rather than inside `entityToWire`.
      //
      // `entityToWire` reads `e.objective`, which nothing in `src/` has ever assigned — so the
      // one entity field that justified `PROTOCOL_VERSION` → 2 was `packInteract(0, 0)` on
      // every entity of every real snapshot ever sent. Overwritten rather than fixed at the
      // source because the fix belongs in `protocol.js`, and editing that file forces a
      // version bump for a format that has not changed by one byte. `_objectiveFor` returns
      // null unless there is real progress, so `entityToWire`'s value stands untouched
      // whenever the producer does start setting `e.objective`.
      const obj = this._objectiveFor(e);
      if (obj) {
        w.interact = packInteract(obj.kind, Math.round((obj.progress ?? 0) * INTERACT_PROGRESS_MAX));
      }
      wire.push(w);
      if (sectors) wireSectorId.push(sectors.sectorOf(e.position));
    }

    // The unfiltered bomb, read once per snapshot rather than once per recipient.
    const bomb = readBombMatchState(g);

    for (const session of this.clients.values()) {
      if (session.rejected || !session.authenticated) continue;
      // Route: an event with no `to` is everyone's (a gunshot, a kill); an event with one
      // belongs to exactly one client. Showing somebody else's hitmarker is worse than
      // showing none, so this filter is the whole point of recording `to` at all.
      const mine = session.entity?.id;
      const at = session.entity?.position;
      const role = bomb ? roleOf(session.entity, bomb.attackingTeam) : 'none';
      // sector-interest.md §5.1 — a dead/spectating client's relevant set is the sector of
      // whoever it is spectating, never map-wide. This server has no spectate assignment
      // defined yet (§4.1's own caveat: neither `extraction-match.md` nor `net-facade.md`
      // pins post-death connection state down), so the safe default per that caveat is a
      // client with no entity gets no sector-relevant entities/events at all, same as a
      // fully wiped squad — never map-wide vision by omission.
      const relevantSectors = sectors ? (at ? sectors.relevantSetFor(at) : new Set()) : null;
      const entities = relevantSectors
        ? wire.filter((w, idx) => {
          const sid = wireSectorId[idx];
          return sid == null || relevantSectors.has(sid);
        })
        : wire;
      const events = this._pendingEvents.filter((ev) => {
        if (ev.to != null) return ev.to === mine;        // private: routing decides it
        // §5.2 — sector relevance is checked before the distance cull below, specifically
        // for the case a flat distance cull cannot catch: two sectors close in raw distance
        // but not neighbours (across a wall/floor/chasm). Non-spatial events carry no
        // origin position and are not gated here.
        if (relevantSectors && EV_SPATIAL.has(ev.kind)) {
          const evSector = sectors.sectorOf({ x: ev.x, y: ev.y, z: ev.z });
          if (evSector != null && !relevantSectors.has(evSector)) return false;
        }
        // §8.8, on the EVENT path. `bombDropped` is in `EV_VEC3` and `EV_SPATIAL`, so it
        // carries the true coordinates in the snapshot's event block — and the only filter
        // there was the 90 m distance cull, on a map 88 m across. Measured: a blind defender
        // 23.1 m away was correctly told `visible:false, null` in `MSG_MATCHSTATE` and then
        // handed the exact coordinates twelve bytes at a time in the very next frame, which
        // its own `NetClient` decoded into `bombDropped x=-8 y=0.3 z=34`. §8.8: "Sending the
        // true carrier to everyone and hiding it in the UI would be a wallhack shipped in the
        // protocol." The same authorisation the state message applies, applied here.
        //
        // The event is DROPPED for an unauthorised recipient rather than zeroed: (0,0,0) is a
        // valid world position (REQ-CC-030), and §8.6 says the position is state — a client
        // that never sees this event still learns `bombState: 'dropped'` from `MSG_MATCHSTATE`
        // and the coordinates the moment it is authorised for them.
        //
        // Authorised against the EVENT's own point and the state it describes, not against
        // where the bomb is now: by the time this snapshot goes out, up to four ticks later,
        // it may already have been picked back up, and the fact being disclosed is still the
        // place it was lying in.
        if (EV_BOMB_POSITION_KINDS.has(ev.kind)) {
          const at3 = { x: ev.x, y: ev.y, z: ev.z };
          if (!this._bombPositionAuthorised(session.entity, { state: 'dropped', position: at3 }, role)) return false;
        }
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
        entities,
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

/**
 * The producer's payload, in the shape this layer reads.
 *
 * One place, so the two vocabularies meet exactly once. Every field accepts BOTH spellings:
 * the `bomb.js` one (`entityId`, `requested`, loose `x/y/z`, `round`) and the §8.7 one
 * (`actorId`, `requestedKind`, `position`, `roundIndex`). A ruleset that changes shape breaks
 * here, loudly and in one function, instead of silently zeroing four fields at the far end.
 */
function normaliseObjective(p, server) {
  if (!p || typeof p !== 'object') return null;
  const actorId = p.actorId ?? p.entityId ?? null;
  const position = p.position
    ?? (Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
      ? { x: p.x, y: p.y, z: p.z } : null);
  // `round` is 1-based (`bomb.js` `roundNumber`); `roundIndex` is 0-based. Mixing them puts
  // every objective fact in the round after the one it happened in.
  const roundIndex = p.roundIndex ?? (typeof p.round === 'number' ? p.round - 1 : null);
  const requested = p.requestedKind ?? p.requested ?? null;
  const requestedKind = requested == null ? null
    : (typeof requested === 'number' ? requested : Math.max(0, INTERACT_KINDS.indexOf(requested)));
  // The side is a server-side fact about the actor, so it is looked up rather than trusted:
  // the producer does not send it, and `null` in the evidence is a row a review cannot use.
  const actorTeam = p.actorTeam ?? (actorId ? (server?._entityById(actorId)?.team ?? null) : null);
  return {
    ...p,
    kind: p.kind,
    actorId: actorId == null || actorId < 0 ? null : actorId,
    actorTeam,
    position,
    roundIndex,
    requestedKind,
    to: p.to ?? null,
  };
}

/**
 * `bomb.js` `REFUSE` names → `REFUSAL_REASONS` (§8.7). Only `released` overlaps by accident,
 * and it is a CANCEL reason, not a refusal — so without this table every refusal but one
 * arrived as index 0.
 */
const RULESET_REFUSAL_REASON = Object.freeze({
  wrongPhase: 'wrong-phase',
  roundOver: 'wrong-phase',
  // A defuse asked for while nothing is planted is a phase fact, not an eligibility one.
  notPlanted: 'wrong-phase',
  alreadyPlanted: 'already-planted',
  notCarrying: 'not-carrier',
  outsideVolume: 'outside-volume',
  // Inside the volume but airborne: the player is not eligible, they are not outside it.
  notGrounded: 'not-eligible',
  wrongTeam: 'not-eligible',
  dead: 'not-eligible',
  disconnected: 'not-eligible',
  released: 'not-eligible',
});

/** `bomb.js` `REFUSE` names → `CANCEL_REASONS` (§8.7), for `plantCancel` / `defuseCancel`. */
const RULESET_CANCEL_REASON = Object.freeze({
  released: 'released',
  outsideVolume: 'left-volume',
  notGrounded: 'left-volume',
  dead: 'died',
  disconnected: 'died',
  roundOver: 'round-ended',
  wrongPhase: 'round-ended',
  alreadyPlanted: 'round-ended',
  notPlanted: 'round-ended',
  notCarrying: 'round-ended',
  wrongTeam: 'round-ended',
});

/** `bomb.js` round/match reasons → `OUTCOME_REASONS` (§8.9). */
const RULESET_OUTCOME_REASON = Object.freeze({
  elimination: 'elimination',
  defuse: 'defuse',
  detonation: 'detonation',
  timer: 'timer',
  time: 'timer',
  // §2.1a: a 6-6 regulation finish. `match-result.md` §4.0 — a draw REQUIRES `timer`, and
  // only `timer`, so this mapping is not a convenience.
  draw: 'timer',
  // Reaching `roundsToWin` ends the series early: the loser can no longer reach it. A
  // completed match with a winner must be one of elimination/defuse/detonation/timer.
  roundsToWin: 'elimination',
  forfeit: 'forfeit',
  abandon: 'abandon',
  'no-contest': 'no-contest',
});

const outcomeReason = (r) => RULESET_OUTCOME_REASON[r] ?? (OUTCOME_REASONS.includes(r) ? r : 'no-contest');

/**
 * §8.9: **`winner: 0` is "no winner", not "draw"** — a no-contest has neither, and a 6-6
 * finish is a genuine draw. `bomb.js` spells both as `winnerTeam: -1`, so the reason is what
 * separates them.
 */
function outcomeWinner(winnerTeam, reason) {
  if (winnerTeam === 0) return 'alpha';
  if (winnerTeam === 1) return 'bravo';
  if (reason === 'draw') return 'draw';
  return 'none';
}

/** Said once per distinct message. A per-tick warning would be its own denial of service. */
const _warned = new Set();
function warnOnce(message) {
  if (_warned.has(message)) return;
  _warned.add(message);
  console.warn(`[net] ${message}`);
}

/**
 * Event kinds whose vec3 IS the bomb's position, and which are therefore subject to the §8.8
 * authorisation filter rather than to the distance cull alone.
 *
 * Keyed on the KIND rather than on a flag set at record time: a flag can be forgotten by a
 * future caller of `_record`, and forgetting it is a wallhack. `bombDetonated` is deliberately
 * absent — a bomb that has just gone off is not intel, and its site is public the moment it is
 * planted (§8.6).
 */
const EV_BOMB_POSITION_KINDS = new Set(['bombDropped']);

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
    // `roundPhase`, NOT `phase`.
    //
    // `Match.phase` is the MATCH lifecycle (warmup/live/ended); `Match.roundPhase` is the Bomb
    // round state machine (freeze/live/planted/roundEnd). Reading the former published `live`
    // for every round phase, so the client could never be told a round had frozen, that the
    // bomb was planted, or that the round had ended — the entire §3 state machine collapsed to
    // one value on the wire, while every field around it was correct.
    //
    // The names differ by one word and both are valid identifiers on the same object, so the
    // wrong one costs nothing at read time and everything at the far end.
    phase: PHASES.includes(m.roundPhase) ? m.roundPhase : 'warmup',
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
