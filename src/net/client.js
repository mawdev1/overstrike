/**
 * The client half of the session.
 *
 * Sends commands up, receives snapshots down, and keeps the two reconciled. This file owns
 * the plumbing and the remote-entity view; prediction and reconciliation of the LOCAL
 * player are Phase 6 and live in `prediction.js`.
 *
 * Remote entities are drawn at a deliberate delay behind the newest snapshot — see
 * `INTERP_DELAY_MS`. That is not latency being tolerated, it is latency being SPENT: with
 * a buffer of snapshots on hand the client can interpolate between two states it actually
 * received, rather than extrapolating forward from one and being wrong whenever someone
 * changes direction.
 */
import {
  MSG_SNAPSHOT, MSG_WELCOME, MSG_REJECT, MSG_MATCHSTATE, MSG_OUTCOME,
  MSG_TACTICAL_PING_EVENT, encodeTacticalPingIntent, decodeTacticalPingEvent,
  encodeCommands, decodeSnapshot, quantiseCommand, encodeHello, decodeWelcome, decodeReject,
  decodeMatchState, decodeOutcome, PROTOCOL_VERSION, upgradeMessage,
  REJECT_PROTOCOL_VERSION_MISMATCH, WELCOME_BYTES_V1, WELCOME_BYTES_V2,
} from './protocol.js';

/**
 * How far behind the newest snapshot remote entities are drawn.
 *
 * At a 30 Hz snapshot rate, consecutive snapshots are 33 ms apart, so ~100 ms holds two to
 * three in the buffer: enough to keep interpolating through one lost packet, and enough
 * to absorb ordinary jitter. Lower looks more responsive and stutters; higher is smooth
 * and makes everyone else visibly late.
 */
export const INTERP_DELAY_MS = 100;

/** How many already-sent commands to repeat in each packet. */
const REDUNDANT_COMMANDS = 3;

/** Monotonic-ish wall clock, in a form both Node and a browser have. */
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class NetClient {
  constructor(transport) {
    this.transport = transport;
    this.clientId = 0;
    this.entityId = 0;

    /** Commands the server has not yet confirmed consuming. */
    this.unacked = [];
    this.nextSeq = 1;
    this.lastAckedSeq = 0;

    /** Snapshots newest-last, trimmed to what interpolation can still need. */
    this.snapshots = [];
    this.latestTick = 0;
    /** Wall clock when `latestTick` arrived, so render time can advance between snapshots. */
    this.latestAtMs = 0;

    this.stats = {
      sent: 0, snapshots: 0, acked: 0, discarded: 0, matchStates: 0, outcomes: 0,
      /** Known-type frames refused for their length (§8.11). Each one closes the socket. */
      malformed: 0,
    };
    /** `{ type, byteLength }` of the frame that closed this connection, or null. */
    this.lastMalformed = null;
    this._onSnapshot = null;
    this._onWelcome = null;
    this._onMatchState = null;
    this._onOutcome = null;
    this._onTacticalPing = null;
    this._onReject = null;
    /** The server's match seed. Shot spread is addressed by it — see GameServer._sendWelcome. */
    this.matchSeed = null;
    /** Authoritative TDM round limit, appended to the welcome packet. `null` in Bomb. */
    this.killLimit = null;
    /** The whole v2 welcome, so a caller can read `mode`, `isReconnect`, the tick rate. */
    this.welcome = null;
    /** The version the server said it speaks, once it has said it. */
    this.serverVersion = null;
    /**
     * Set when this connection has been refused, and never cleared.
     *
     * `{ reason, serverVersion, message }`. A rejection is TERMINAL — `errors.md` §5 says
     * never retry `PROTOCOL_VERSION_MISMATCH` — so once it is set the client stops decoding
     * anything else and the transport is closed. A client that kept reading after a version
     * mismatch would be doing the exact thing negotiation exists to prevent.
     */
    this.rejected = null;
    /** Newest decoded `MSG_MATCHSTATE`, or null before the first one. Bomb only. */
    this.matchState = null;
    /** Newest decoded `MSG_OUTCOME`, or null. */
    this.outcome = null;

    // Five-second measured diagnostics used by the public facade. These samples are
    // client observations, never server claims or UI smoothing.
    this._sentAt = new Map();
    this._rttSamples = [];
    this._snapshotSamples = [];
    this._keyframes = 0;
    this._baselineState = 'keyframe-pending';

    transport.onMessage((data) => this._onMessage(data));
  }

  /** Called with each decoded snapshot, for prediction to reconcile against. */
  onSnapshot(fn) { this._onSnapshot = fn; }
  onWelcome(fn) { this._onWelcome = fn; }
  /** Called with each decoded `MSG_MATCHSTATE`. Bomb HUD, round timer, plant bar. */
  onMatchState(fn) { this._onMatchState = fn; }
  /** Called with each decoded `MSG_OUTCOME` — round and match results. */
  onOutcome(fn) { this._onOutcome = fn; }
  onTacticalPing(fn) { this._onTacticalPing = fn; }
  /** Called once if the connection is refused. Terminal: the socket is already closing. */
  onReject(fn) { this._onReject = fn; }

  /**
   * Say hello (§8.2). **The first frame this client puts on the socket.**
   *
   * Carries the version this build speaks so the server can refuse it before either side
   * decodes anything the other might mean differently — which is the whole of G1. The ticket
   * rides alongside it and the server verifies/consumes it before allocating an entity.
   */
  sendHello(ticket = '') {
    this.transport.send(encodeHello(PROTOCOL_VERSION, ticket));
  }

  sendTacticalPing(kind = 'location') {
    if (this.rejected || !this.entityId) return false;
    if (!['location', 'danger', 'objective'].includes(kind)) return false;
    this.transport.send(encodeTacticalPingIntent(kind));
    return true;
  }

  /**
   * Refuse this connection locally and stop.
   *
   * Reached from two directions: an explicit `MSG_REJECT`, and a welcome whose version does
   * not match ours — including a welcome with NO version, which means a server that predates
   * negotiation. Both are the same fact and must have the same effect, or a v1 server would
   * still be able to feed a v2 client bytes it will misread.
   */
  _reject(reason, serverVersion) {
    if (this.rejected) return this.rejected;
    this.serverVersion = serverVersion;
    this.rejected = {
      reason,
      serverVersion,
      message: upgradeMessage(serverVersion, PROTOCOL_VERSION),
    };
    // Nothing decoded after this point, including anything already in the receive buffer.
    this.entityId = 0;
    try { this.transport.close(); } catch { /* already gone */ }
    this._onReject?.(this.rejected);
    return this.rejected;
  }

  /**
   * A known message type arrived at a length this build cannot read (§8.11).
   *
   * Terminal, and deliberately the same terminal path a `MSG_REJECT` takes: a peer that has
   * put a frame of the wrong size on the wire is a peer we no longer agree with about what a
   * byte means, and there is no recovery from that mid-stream. Counted as well as closed, so
   * a harness can prove which frame did it rather than inferring it from a dead socket.
   */
  _malformed(type, byteLength) {
    this.stats.malformed++;
    this.lastMalformed = { type, byteLength };
    return this._reject(REJECT_PROTOCOL_VERSION_MISMATCH, this.serverVersion);
  }

  _onMessage(data) {
    if (this.rejected) return;
    if (data.byteLength < 1) return;
    const v = new DataView(data);
    const type = v.getUint8(0);

    if (type === MSG_REJECT) {
      const r = decodeReject(data);
      this._reject(r?.reason || REJECT_PROTOCOL_VERSION_MISMATCH, r?.serverVersion ?? null);
      return;
    }

    if (type === MSG_WELCOME) {
      // **The length is checked HERE, before the decoder is handed the buffer.**
      //
      // `decodeWelcome` is the one decoder in `protocol.js` with no length check, because it
      // legitimately accepts two lengths (15 for v1, 21 for v2) and a single `!==` would have
      // been wrong — so nothing went in at all. It reads `getUint32(5)` unconditionally, so a
      // 6-byte welcome threw a `RangeError` straight out of this method; `WebSocketTransport`
      // catches and logs whatever the handler throws, so the frame produced no close, no
      // reject, and a connection that carried on being fed bytes neither side agreed about.
      // §8.11 is explicit: known type, wrong length → connection closed.
      //
      // The check lives in the caller rather than in the decoder because moving it into
      // `protocol.js` would edit the file `lanecheck` watches and force `PROTOCOL_VERSION` to
      // 3 — and not one byte of the format has changed, so a bump would refuse every peer
      // this build agrees with perfectly. `NetClient` is the only caller that is ever handed
      // an attacker-controlled buffer.
      if (data.byteLength !== WELCOME_BYTES_V1 && data.byteLength !== WELCOME_BYTES_V2) {
        this._malformed(MSG_WELCOME, data.byteLength);
        return;
      }
      const w = decodeWelcome(data);
      if (!w) { this._malformed(MSG_WELCOME, data.byteLength); return; }
      // The version gate, on the client's side of the handshake. A server that predates §8.4
      // sends 15 bytes and no version at all — which is not "unknown, carry on", it is a v1
      // server, and v1 cannot describe the fields this build now reads.
      if (w.protocolVersion !== PROTOCOL_VERSION) {
        this._reject(REJECT_PROTOCOL_VERSION_MISMATCH, w.protocolVersion ?? 1);
        return;
      }
      this.serverVersion = w.protocolVersion;
      this.welcome = w;
      this.clientId = w.clientId;
      this.entityId = w.entityId;
      // Sent again on every match restart, so this is an assignment and not a one-time
      // handshake.
      this.matchSeed = w.matchSeed;
      this.killLimit = w.killLimit;
      if (this._onWelcome) this._onWelcome(this);
      return;
    }

    if (type === MSG_MATCHSTATE) {
      const s = decodeMatchState(data);
      // Wrong length: a desynced frame, not state. §8.11 closes the connection.
      if (!s) { this._malformed(MSG_MATCHSTATE, data.byteLength); return; }
      this.matchState = s;
      this.stats.matchStates++;
      this._onMatchState?.(s);
      return;
    }

    if (type === MSG_OUTCOME) {
      const o = decodeOutcome(data);
      if (!o) { this._malformed(MSG_OUTCOME, data.byteLength); return; }
      this.outcome = o;
      this.stats.outcomes++;
      this._onOutcome?.(o);
      return;
    }

    if (type === MSG_TACTICAL_PING_EVENT) {
      const ping = decodeTacticalPingEvent(data);
      if (!ping) { this._malformed(MSG_TACTICAL_PING_EVENT, data.byteLength); return; }
      this._onTacticalPing?.(ping);
      return;
    }

    // §8.11: an unknown type is ignored. Additive types must not break an older peer.
    if (type !== MSG_SNAPSHOT) return;

    // Coded against the last snapshot at the tick the server names. Finding it rather
    // than assuming the newest is what makes a delta survive a reordered packet.
    const base = this.snapshots.find((s) => s.tick === v.getUint32(6, true)) || null;
    const snap = decodeSnapshot(data, base);
    this.stats.snapshots++;

    // A snapshot older than one already held is a reorder, not news. Applying it would
    // rewind every remote entity for a frame.
    if (snap.tick < this.latestTick) { this.stats.discarded++; return; }
    this.latestTick = snap.tick;
    this.latestAtMs = now();
    this._snapshotSamples.push({ at: this.latestAtMs, tick: snap.tick });
    while (this._snapshotSamples.length && this._snapshotSamples[0].at < this.latestAtMs - 5000) {
      this._snapshotSamples.shift();
    }
    if (snap.keyframe) this._keyframes++;
    this._baselineState = snap.keyframe || base ? 'synced' : 'keyframe-pending';

    this.snapshots.push(snap);
    // Keep a couple of seconds; interpolation only ever reaches back INTERP_DELAY_MS, and
    // an unbounded buffer in a long match is a leak.
    while (this.snapshots.length > 64) this.snapshots.shift();

    if (snap.lastCommandSeq > this.lastAckedSeq) {
      const sentAt = this._sentAt.get(snap.lastCommandSeq);
      if (sentAt !== undefined) {
        this._rttSamples.push({ at: this.latestAtMs, value: Math.max(0, this.latestAtMs - sentAt) });
      }
      while (this._rttSamples.length && this._rttSamples[0].at < this.latestAtMs - 5000) {
        this._rttSamples.shift();
      }
      for (const seq of this._sentAt.keys()) if (seq <= snap.lastCommandSeq) this._sentAt.delete(seq);
      this.lastAckedSeq = snap.lastCommandSeq;
      const before = this.unacked.length;
      // Everything the server has consumed can stop being resent — and, for Phase 6,
      // stops needing to be replayed.
      while (this.unacked.length && this.unacked[0].seq <= this.lastAckedSeq) this.unacked.shift();
      this.stats.acked += before - this.unacked.length;
    }

    this._onSnapshot?.(snap);
  }

  /**
   * Queue a command and send it with the last few already-sent ones.
   *
   * The redundancy is the whole loss-recovery strategy: one lost packet costs nothing
   * because the next three carry the same commands again. It costs ~90 bytes a packet,
   * which is far cheaper than the retransmit round trip it avoids — and on a stream of
   * 30-byte messages, cheaper than most headers.
   */
  sendCommand(cmd) {
    cmd.seq = this.nextSeq++;
    // Through the wire's value space BEFORE anything predicts with it, so the client
    // predicts from exactly what the server will decode.
    quantiseCommand(cmd);
    this.unacked.push(cmd);
    this._sentAt.set(cmd.seq, now());
    if (this._sentAt.size > 512) this._sentAt.delete(this._sentAt.keys().next().value);

    const batch = this.unacked.slice(-(REDUNDANT_COMMANDS + 1));
    this.transport.send(encodeCommands(batch));
    this.stats.sent++;
    return cmd;
  }

  /** Measured transport/snapshot window for net-facade §5.2. */
  diagnostics(at = now()) {
    while (this._rttSamples.length && this._rttSamples[0].at < at - 5000) this._rttSamples.shift();
    while (this._snapshotSamples.length && this._snapshotSamples[0].at < at - 5000) this._snapshotSamples.shift();
    const rtt = this._rttSamples.map((row) => row.value);
    const rttMs = rtt.length ? rtt.reduce((sum, n) => sum + n, 0) / rtt.length : 0;
    const jitterMs = rtt.length > 1
      ? rtt.slice(1).reduce((sum, n, i) => sum + Math.abs(n - rtt[i]), 0) / (rtt.length - 1)
      : 0;
    const snaps = this._snapshotSamples;
    const span = snaps.length > 1 ? Math.max(1, snaps[snaps.length - 1].at - snaps[0].at) : 5000;
    const receiveRateHz = snaps.length > 1 ? ((snaps.length - 1) * 1000) / span : 0;
    let expected = 0;
    let missing = 0;
    const gaps = [];
    for (let i = 1; i < snaps.length; i++) {
      const gap = snaps[i].tick - snaps[i - 1].tick;
      if (gap > 0) gaps.push(gap);
    }
    const nominal = gaps.length ? Math.min(...gaps) : 0;
    if (nominal > 0) {
      for (const gap of gaps) {
        const slots = Math.max(1, Math.round(gap / nominal));
        expected += slots;
        missing += slots - 1;
      }
    }
    const snapshotAgeMs = this.latestAtMs ? Math.max(0, at - this.latestAtMs) : Infinity;
    return {
      sampledAt: at,
      windowMs: 5000,
      rttMs,
      jitterMs,
      lossPct: expected ? (missing / expected) * 100 : 0,
      snapshotAgeMs,
      receiveRateHz,
      baselineState: snapshotAgeMs > 5000 ? 'lost' : this._baselineState,
      keyframes: this._keyframes,
      discarded: this.stats.discarded,
    };
  }

  /**
   * The two snapshots to interpolate between at `nowTick`, and how far between them.
   *
   * Returns null when the buffer cannot cover the requested time — early in a match, or
   * after a stall — and the caller should hold the newest state rather than invent one.
   */
  interpolationAt(nowTick, tickRateHz = 120) {
    const delayTicks = (INTERP_DELAY_MS / 1000) * tickRateHz;
    // Render time is derived from the SERVER's clock, not the local simulation's.
    //
    // The local tick drifts: a client steps its own simulation on its own frame timing,
    // so over a match it runs slightly ahead or behind the server's tick numbering. Using
    // it here silently breaks interpolation once the drift exceeds the buffer — the
    // target falls outside every snapshot held and remote players simply stop appearing,
    // with no error anywhere. Anchoring to the newest snapshot removes the drift, and
    // adding the wall-clock time since it arrived keeps motion smooth BETWEEN snapshots
    // instead of stepping at the 30 Hz snapshot rate.
    const sinceMs = this.latestAtMs ? Math.max(0, now() - this.latestAtMs) : 0;
    const serverNow = this.latestTick + (sinceMs / 1000) * tickRateHz;
    const target = (nowTick === undefined ? serverNow : Math.min(nowTick, serverNow)) - delayTicks;

    let a = null, b = null;
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].tick <= target) {
        a = this.snapshots[i];
        b = this.snapshots[i + 1] || null;
        break;
      }
    }
    if (!a) return null;
    if (!b) return { a, b: a, t: 0 };
    const span = b.tick - a.tick;
    return { a, b, t: span > 0 ? Math.max(0, Math.min(1, (target - a.tick) / span)) : 0 };
  }

  /** Newest known state for an entity, ignoring the interpolation delay. */
  latestEntity(id) {
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      const e = this.snapshots[i].entities.find((x) => x.id === id);
      if (e) return e;
    }
    return null;
  }
}
