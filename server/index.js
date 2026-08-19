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
import { RecordingPresenter } from '../src/core/presenter.js';
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
/** Round length in seconds. 0 keeps the mode's own limit. Short rounds are for testing. */
const TIME_LIMIT = arg('timelimit', 0);

const game = new Game({ headless: true });
// Not a NullPresenter: the server has no screen, but its clients do, and the feedback
// it generates is theirs. See `RecordingPresenter`.
await game.initHeadless({ presenter: new RecordingPresenter() });
game.startMatch({ mode: 'tdm', botCount: BOTS, difficulty: 'regular' });
game.match.phase = 'live';
game.match.countdown = 0;
if (TIME_LIMIT > 0) game.match.timeLimit = TIME_LIMIT;

// There is no local player on a dedicated server, so stop carrying one.
//
// `Game` always builds a `Player`, and the server used to hand it to the FIRST client that
// connected. When that client left it was never removed — `sock.on('close')` only removes
// entities it created — so an idle, invulnerable, permanently team-0 body stood on a spawn
// point for the life of the process: rendered by every client, counted when balancing
// teams, and a free kill for whoever wandered past. Nulling it removes it from
// `game.entities` outright (see the getter), which also lets `Match._assignTeams` deal
// every human properly instead of pinning one of them to team 0 forever.
game.player = null;

const server = new GameServer(game);
console.log(`[server] map built: ${game.world.boxes.length} colliders, ${game.world.spawnPoints.length} spawns, ${BOTS} bots`);

// ── debug accounting ──────────────────────────────────────────────────────────────────
//
// Test-only. `/health?debug=1` exposes per-entity health and a tally of shots and damage
// events, so a harness can ask the SERVER whether a shot happened and whether it landed
// rather than inferring it from the client. Nothing in the simulation reads any of this,
// and the counters only ever grow — turning it off would only save two Map writes a shot.
const debugShots = new Map();     // shooter entity id -> rounds fired
const debugDamage = new Map();    // `${attackerId}>${targetId}` -> {hits, total, parts}
game.bus?.on('shot', (e) => {
  const id = e.shooter?.id ?? 0;
  debugShots.set(id, (debugShots.get(id) ?? 0) + 1);
});
game.bus?.on('damage', (e) => {
  const k = `${e.attacker?.id ?? 0}>${e.target?.id ?? 0}`;
  const r = debugDamage.get(k) ?? { hits: 0, total: 0, parts: {} };
  r.hits++;
  r.total += e.amount || 0;
  r.parts[e.hitPart || '?'] = (r.parts[e.hitPart || '?'] ?? 0) + 1;
  debugDamage.set(k, r);
});

// ── the match has to actually restart ─────────────────────────────────────────────────
//
// This file's header claimed the match restarts itself when it ends. It did not: nothing
// listened for `matchEnd`, so the first match ran its 600 seconds and the process then sat
// in `phase === 'ended'` forever. That is not a frozen scoreboard, it is a dead server, and
// it is silent:
//
//   `Match.update` returns immediately once ended, so nobody ever respawns;
//   `Match.canFire` then returns false, and `ballistics.js` zeroes ALL damage;
//   bots never die, so they never re-equip, and 38% of them end up with empty guns.
//
// A player joining after that sees exactly what was reported — enemies standing around
// doing nothing, and not one shot registering, because on that server no shot COULD
// register. A machine kept warm for hours makes this the normal case, not the edge case.
const INTERMISSION_MS = 10000;
let restartAt = 0;
let matchesPlayed = 1;

game.bus?.on('matchEnd', (result) => {
  if (restartAt) return;
  restartAt = Date.now() + INTERMISSION_MS;
  console.log(`[server] match ended (${result?.reason ?? 'unknown'}) — restarting in ${INTERMISSION_MS / 1000}s`);
});

function restartMatch() {
  restartAt = 0;
  // The clock must NOT go backwards. `startMatch` resets `game.tick` to 0, which is right
  // for a tab starting a fresh match and wrong for a live server: every connected client
  // stamps its commands and its interpolation against the server tick, so rewinding it
  // strands them in a future the server no longer has snapshots for.
  const keepTick = game.tick;
  game.startMatch({ mode: 'tdm', botCount: BOTS, difficulty: 'regular' });
  game.tick = keepTick;
  game.match.phase = 'live';
  game.match.countdown = 0;
  if (TIME_LIMIT > 0) game.match.timeLimit = TIME_LIMIT;

  for (const session of server.clients.values()) {
    const e = session.entity;
    if (!e) continue;
    e.health = e.maxHealth ?? 100;
    e.alive = true;
    e.respawn?.();
    // Clear the death screen of anyone who was dead when the round ended. `restartMatch`
    // revives them directly, bypassing `Match._updateRespawns` — the only place that ever
    // emits the clear — so without this a player comes back alive, moving and shootable
    // while still staring at a full-screen death overlay until they die again.
    game.present.deathScreen?.(null, e);
    // The bot roster is rebuilt with fresh ids, so every client's delta baseline now
    // describes entities that no longer exist. Force a keyframe rather than coding the
    // next snapshot against a roster that has been replaced.
    session.baseline = null;
    session.baseTick = 0;
    session.pendingBaselines?.clear?.();
  }
  // The seed changed, and shot spread is addressed by it — see `GameServer._sendWelcome`.
  server.broadcastWelcome();
  matchesPlayed++;
  console.log(`[server] match ${matchesPlayed} started — ${server.clients.size} clients, ${BOTS} bots`);
}

/** The side with fewer live entities, so a joiner evens the match out rather than stacking it. */
function smallerTeam() {
  let a = 0;
  let b = 0;
  for (const e of game.entities) (e.team === 1 ? b++ : a++);
  return a <= b ? 0 : 1;
}

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
  if (restartAt && Date.now() >= restartAt) restartMatch();
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
  if (req.url === '/health' || req.url === '/' || req.url.startsWith('/health?')) {
    // Debug-only detail, opt-in via `?debug=1`. See the accounting block above.
    const debug = req.url.includes('debug=1') ? {
      entities: game.entities.map((e) => ({
        id: e.id,
        kind: e.isPlayer ? 'player' : 'bot',
        health: Math.round(e.health),
        alive: !!e.alive,
        team: e.team ?? 0,
        x: +e.position.x.toFixed(3), y: +e.position.y.toFixed(3), z: +e.position.z.toFixed(3),
        height: +(e.height ?? 0).toFixed(3),
        yaw: +e.yaw.toFixed(4), pitch: +e.pitch.toFixed(4),
        protectedNow: !!game.match?.isProtected?.(e),
        ammo: e.weapon?.ammo ?? null,
        shotsFired: e.weapon?.shotsFired ?? 0,
      })),
      shots: [...debugShots].map(([id, n]) => ({ id, n })),
      damage: [...debugDamage].map(([k, v]) => ({ pair: k, ...v })),
      lagcomp: server.lag.stats,
      sessionRtt: [...server.clients.values()].map((c) => ({
        id: c.id, entity: c.entity?.id, rttMs: +c.rttMs.toFixed(1),
        queued: c.queue.length, lastCommandSeq: c.lastCommandSeq,
      })),
      matchPhase: game.match?.phase ?? null,
    } : undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      debug,
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
      phase: game.match?.phase ?? 'unknown',
      timeRemaining: Math.round(game.match?.timeRemaining ?? 0),
      matches: matchesPlayed,
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

  // Every connection gets its OWN entity. There is no "first client takes game.player"
  // asymmetry any more — see the note where `game.player` is nulled.
  const entity = new Player(game);
  {
    entity.init();
    game.addEntity(entity);
    game.weapons.giveLoadout(entity, ['ar_vector', 'pistol_sidewinder']);
    // Pick a side BEFORE spawning. `Player.respawn` prefers spawn points matching the
    // entity's team, so a joiner that spawns first and is balanced afterwards materialises
    // in the enemy's half. And a joiner left on the default team 0 could not damage — or
    // be damaged by — anyone else who joined, since `damageScale` returns 0 for a
    // teammate and the hit is then discarded entirely.
    entity.team = smallerTeam();
    entity.respawn?.();
  }

  const session = server.addClient(transport, entity);
  const who = req.socket.remoteAddress;
  console.log(`[server] client ${session.id} joined from ${who} as entity ${entity.id} (${server.clients.size} online)`);

  sock.on('close', () => {
    server.removeClient(session);
    game.removeEntity(entity);
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
