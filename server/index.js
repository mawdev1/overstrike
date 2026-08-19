/**
 * OVERSTRIKE dedicated server.
 *
 * A headless `Game`, a `GameServer`, and a WebSocket listener. One match per process for
 * now; the match restarts itself when it ends, so a machine that nobody is on stays warm
 * and empty rather than dying.
 *
 * Run:  node server/index.js [--port=8080] [--bots=8] [--tickrate=120]
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Game } from '../src/core/game.js';
import { NullPresenter } from '../src/core/presenter.js';
import { GameServer } from '../src/net/server.js';
import { Player } from '../src/player/player.js';
import { FIXED_DT } from '../src/core/mathUtils.js';

const arg = (k, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  if (hit) return Number(hit.split('=')[1]);
  const env = process.env[`OVERSTRIKE_${k.toUpperCase()}`];
  return env !== undefined ? Number(env) : d;
};

const PORT = arg('port', Number(process.env.PORT) || 8080);
const BOTS = arg('bots', 8);
const MAX_CLIENTS = arg('maxclients', 12);

const game = new Game({ headless: true });
await game.initHeadless({ presenter: new NullPresenter() });
game.startMatch({ mode: 'tdm', botCount: BOTS, difficulty: 'regular' });
game.match.phase = 'live';
game.match.countdown = 0;

const server = new GameServer(game);
console.log(`[server] map built: ${game.world.boxes.length} colliders, ${game.world.spawnPoints.length} spawns, ${BOTS} bots`);

// ── the tick pump ─────────────────────────────────────────────────────────────────────
//
// Deliberately NOT setInterval(fn, 8.33): timers drift and coalesce, and a fixed-timestep
// simulation driven by a drifting timer runs slow, then catches up in a burst. Instead
// keep an accumulator against the real clock and step however many whole ticks are owed,
// which is exactly what the browser loop does.
//
// The catch-up is capped. If the process is descheduled for a second — a GC pause, a
// noisy neighbour, a laptop lid — the honest response is to drop that time rather than
// run 120 ticks back to back, which would freeze everyone for the length of the burst and
// then teleport them.
const MAX_CATCHUP_TICKS = 8;
let accumulator = 0;
let last = process.hrtime.bigint();
let behind = 0;

function pump() {
  const now = process.hrtime.bigint();
  const dt = Number(now - last) / 1e9;
  last = now;
  accumulator += Math.min(dt, 0.25);

  let steps = 0;
  while (accumulator >= FIXED_DT && steps < MAX_CATCHUP_TICKS) {
    server.tick();
    accumulator -= FIXED_DT;
    steps++;
  }
  if (accumulator >= FIXED_DT) {
    // Could not keep up. Say so and discard, rather than accumulating a debt that can
    // never be repaid and turns into a permanent slow-motion match.
    behind += Math.floor(accumulator / FIXED_DT);
    accumulator = 0;
  }
}

// setInterval at half the tick period, with the accumulator deciding how many ticks
// actually run. Timer granularity then stops mattering.
const timer = setInterval(pump, (FIXED_DT * 1000) / 2);

// ── transport ─────────────────────────────────────────────────────────────────────────

/** Adapts a `ws` socket to the transport interface the netcode expects. */
class WsServerTransport {
  constructor(sock) {
    this.sock = sock;
    this.closed = false;
    this._handler = null;
    this.stats = { sent: 0, received: 0, dropped: 0, bytesSent: 0 };
    sock.on('message', (data) => {
      this.stats.received++;
      // `ws` hands over a Buffer; the protocol decoders want an ArrayBuffer of exactly
      // the message, and a Buffer's underlying pool is larger than its view.
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      try { this._handler?.(ab); } catch (e) {
        // A malformed message must not take the process down: on a server that is one
        // client ending the match for everyone.
        console.error('[server] message handler threw', e.message);
      }
    });
    sock.on('close', () => { this.closed = true; });
    sock.on('error', (e) => { this.closed = true; console.error('[server] socket error', e.message); });
  }

  onMessage(fn) { this._handler = fn; }

  send(data) {
    if (this.closed || this.sock.readyState !== 1) return;
    this.stats.sent++;
    this.stats.bytesSent += data.byteLength;
    this.sock.send(Buffer.from(data), { binary: true });
  }

  pump() { /* the socket delivers itself */ }
  close() { this.closed = true; try { this.sock.close(); } catch { /* already gone */ } }
}

const http_ = http.createServer((req, res) => {
  // Fly health checks and anything else curious. Cheap, and it makes "is the match
  // actually ticking" answerable without a game client.
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      tick: game.tick,
      uptimeSec: Math.round(process.uptime()),
      clients: server.clients.size,
      // Per-client command accounting. `lastCommandSeq` alone cannot reveal a dropped
      // command — it only tracks the HIGHEST consumed — so a client sending faster than
      // the tick rate silently loses its oldest commands while still appearing acked.
      sessions: [...server.clients.values()].map((c) => ({
        id: c.id, acked: c.lastCommandSeq, ...c.stats,
      })),
      bots: game.bots?.bots.length ?? 0,
      entities: game.entities.length,
      scores: game.match?.scores ?? [],
      ticksBehind: behind,
    }));
    return;
  }
  res.writeHead(404); res.end();
});

// `ws` defaults maxPayload to 100 MiB, which is three orders of magnitude more than any
// legitimate message here: a full command batch is ~500 bytes. Two independent limits —
// this and MAX_COMMANDS_PER_BATCH — because the decoder is also reachable from the
// loopback transport, which has no socket to configure.
const MAX_MESSAGE_BYTES = 4096;

const wss = new WebSocketServer({
  server: http_,
  perMessageDeflate: false,
  maxPayload: MAX_MESSAGE_BYTES,
});

wss.on('connection', (sock, req) => {
  if (server.clients.size >= MAX_CLIENTS) {
    sock.close(1013, 'server full');
    return;
  }
  const transport = new WsServerTransport(sock);

  // The first connection takes `game.player`, which a Game always builds; later ones get
  // their own registered entity. See GameServer.addClient — the asymmetry is a wart, not
  // a design.
  let entity = game.player;
  const taken = new Set([...server.clients.values()].map((c) => c.entity));
  if (taken.has(entity)) {
    entity = new Player(game);
    entity.init();
    game.addEntity(entity);
    game.weapons.giveLoadout(entity, ['ar_vector', 'pistol_sidewinder']);
    entity.respawn?.();
  }

  const session = server.addClient(transport, entity);
  const who = req.socket.remoteAddress;
  console.log(`[server] client ${session.id} joined from ${who} as entity ${entity.id} (${server.clients.size} online)`);

  sock.on('close', () => {
    server.removeClient(session);
    if (entity !== game.player) game.removeEntity(entity);
    console.log(`[server] client ${session.id} left (${server.clients.size} online)`);
  });
});

http_.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on :${PORT} (tick ${(1 / FIXED_DT).toFixed(0)} Hz, max ${MAX_CLIENTS} clients)`);
});

// A status line often enough to be useful in `fly logs`, rarely enough to be readable.
setInterval(() => {
  console.log(`[server] tick ${game.tick} | ${server.clients.size} clients | scores ${(game.match?.scores ?? []).join(':')}${behind ? ` | ${behind} ticks dropped` : ''}`);
}, 30000).unref();

const shutdown = (sig) => {
  console.log(`[server] ${sig} — shutting down`);
  clearInterval(timer);
  for (const s of [...server.clients.values()]) server.removeClient(s);
  wss.close();
  http_.close(() => process.exit(0));
  // Do not wait forever for a socket that will not close.
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
