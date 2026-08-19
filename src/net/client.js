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
  MSG_SNAPSHOT, MSG_WELCOME, encodeCommands, decodeSnapshot, quantiseCommand,
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

    this.stats = { sent: 0, snapshots: 0, acked: 0, discarded: 0 };
    this._onSnapshot = null;

    transport.onMessage((data) => this._onMessage(data));
  }

  /** Called with each decoded snapshot, for prediction to reconcile against. */
  onSnapshot(fn) { this._onSnapshot = fn; }

  _onMessage(data) {
    const v = new DataView(data);
    const type = v.getUint8(0);

    if (type === MSG_WELCOME) {
      this.clientId = v.getUint32(1, true);
      this.entityId = v.getUint32(5, true);
      return;
    }
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

    this.snapshots.push(snap);
    // Keep a couple of seconds; interpolation only ever reaches back INTERP_DELAY_MS, and
    // an unbounded buffer in a long match is a leak.
    while (this.snapshots.length > 64) this.snapshots.shift();

    if (snap.lastCommandSeq > this.lastAckedSeq) {
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

    const batch = this.unacked.slice(-(REDUNDANT_COMMANDS + 1));
    this.transport.send(encodeCommands(batch));
    this.stats.sent++;
    return cmd;
  }

  /**
   * The two snapshots to interpolate between at `nowTick`, and how far between them.
   *
   * Returns null when the buffer cannot cover the requested time — early in a match, or
   * after a stall — and the caller should hold the newest state rather than invent one.
   */
  interpolationAt(nowTick, tickRateHz = 120) {
    const delayTicks = (INTERP_DELAY_MS / 1000) * tickRateHz;
    const target = nowTick - delayTicks;

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
