/**
 * Transport.
 *
 * One interface, two implementations. Single player runs the *same* client and server
 * code over a zero-latency loopback rather than down a second, simpler path — because two
 * paths drift, and the one played most would be the one least exercised by the netcode.
 *
 *   send(data)        queue an ArrayBuffer for the far side
 *   onMessage(fn)     receive
 *   pump(nowMs)       deliver whatever is due (loopback only; a socket delivers itself)
 *   close()
 *
 * `LoopbackTransport` carries an artificial latency/jitter/loss knob, default zero. That
 * is not a toy: reconciliation is only exercised when prediction is actually wrong, so at
 * 0 ms it never runs, and a bug in it would sit undiscovered until the first real match.
 * The plan's latency soak turns this on in CI for exactly that reason.
 */

/** A pair of endpoints wired to each other. `a` is the client end, `b` the server end. */
export function createLoopbackPair(opts = {}) {
  const shared = {
    latencyMs: opts.latencyMs ?? 0,
    jitterMs: opts.jitterMs ?? 0,
    loss: opts.loss ?? 0,
    // Deterministic by default: a loss pattern that changes between runs makes a failing
    // soak test unreproducible, which is the one thing a soak test must not be.
    rng: opts.rng || mulberry(0x5EED1E),
    now: 0,
  };
  const a = new LoopbackTransport(shared, 'client');
  const b = new LoopbackTransport(shared, 'server');
  a._peer = b;
  b._peer = a;
  return [a, b];
}

function mulberry(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) | 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class LoopbackTransport {
  constructor(shared, label) {
    this._shared = shared;
    this.label = label;
    this._peer = null;
    this._inbox = [];          // { at, data } — sorted by arrival
    this._handler = null;
    this.closed = false;
    this.stats = { sent: 0, received: 0, dropped: 0, bytesSent: 0 };
  }

  onMessage(fn) { this._handler = fn; }

  send(data) {
    if (this.closed || !this._peer) return;
    const s = this._shared;
    this.stats.sent++;
    this.stats.bytesSent += data.byteLength;
    if (s.loss > 0 && s.rng() < s.loss) { this.stats.dropped++; return; }

    // Jitter is symmetric around the latency, and clamped so a packet cannot arrive
    // before it was sent. Deliberately NOT reordering-safe by construction: real networks
    // reorder, so the receiver has to cope, and `_inbox` is kept sorted by arrival time
    // rather than by send order so it actually can.
    const jitter = s.jitterMs > 0 ? (s.rng() * 2 - 1) * s.jitterMs : 0;
    const at = s.now + Math.max(0, s.latencyMs + jitter);
    const box = this._peer._inbox;
    let i = box.length;
    while (i > 0 && box[i - 1].at > at) i--;
    box.splice(i, 0, { at, data });
  }

  /** Deliver everything due at `nowMs`. Advances the shared clock. */
  pump(nowMs) {
    const s = this._shared;
    s.now = Math.max(s.now, nowMs);
    while (this._inbox.length && this._inbox[0].at <= s.now) {
      const { data } = this._inbox.shift();
      this.stats.received++;
      try { this._handler?.(data); } catch (e) {
        // One malformed message must not take the connection down with it: on a server
        // that is a client-triggered crash, which is the whole game for everyone else.
        console.error(`[net:${this.label}] message handler threw`, e);
      }
    }
  }

  /** Latency knob, changeable mid-run so a soak can ramp. */
  setConditions({ latencyMs, jitterMs, loss }) {
    const s = this._shared;
    if (latencyMs !== undefined) s.latencyMs = latencyMs;
    if (jitterMs !== undefined) s.jitterMs = jitterMs;
    if (loss !== undefined) s.loss = loss;
  }

  close() { this.closed = true; this._inbox.length = 0; }
}

/**
 * Browser-side WebSocket transport.
 *
 * WebSocket rather than WebTransport or WebRTC datagrams, which would suit a shooter
 * better: WS is what Fly terminates cleanly today and what every browser has without
 * signalling infrastructure. The honest cost is TCP head-of-line blocking — one lost
 * packet delays everything queued behind it, which is precisely the wrong failure mode
 * for a stream of positional updates. Revisit if it shows up in play.
 */
export class WebSocketTransport {
  constructor(url) {
    this.url = url;
    this.closed = false;
    this._handler = null;
    this._queue = [];
    this.stats = { sent: 0, received: 0, dropped: 0, bytesSent: 0 };

    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      for (const d of this._queue) this._raw(d);
      this._queue.length = 0;
    };
    this.ws.onmessage = (ev) => {
      this.stats.received++;
      try { this._handler?.(ev.data); } catch (e) {
        console.error('[net:ws] message handler threw', e);
      }
    };
    this.ws.onclose = () => { this.closed = true; };
  }

  onMessage(fn) { this._handler = fn; }

  send(data) {
    if (this.closed) return;
    // Queue until open rather than dropping: the first commands a client sends are the
    // ones that get it into the match.
    if (this.ws.readyState !== 1) { this._queue.push(data); return; }
    this._raw(data);
  }

  _raw(data) {
    this.stats.sent++;
    this.stats.bytesSent += data.byteLength;
    this.ws.send(data);
  }

  pump() { /* the socket delivers itself */ }

  close() { this.closed = true; try { this.ws.close(); } catch { /* already gone */ } }
}
