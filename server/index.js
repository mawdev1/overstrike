/**
 * OVERSTRIKE dedicated server.
 *
 * A headless `Game`, a `GameServer`, and a WebSocket listener. One match per process for
 * now; the match restarts itself when it ends, so a machine that nobody is on stays warm
 * and empty rather than dying.
 *
 * Run:  node server/index.js [--port=8080] [--bots=8] [--killlimit=75] [--mode=tdm|bomb]
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Game } from '../src/core/game.js';
import { RecordingPresenter } from '../src/core/presenter.js';
import { GameServer } from '../src/net/server.js';
import { Player } from '../src/player/player.js';
import { FIXED_DT } from '../src/core/mathUtils.js';
import { normalizeKillLimit } from '../src/game/modes.js';
import { createMatchTicketVerifier, expireUnjoinedSeats } from './tickets.js';
import { buildCanonicalTerminalResult } from './result.js';
import { liveWeaponId } from '../platform/src/shared/liveCatalog.js';
import { createLogger } from '../platform/src/core/logger.js';
import { createObservability, parseTraceparent,
  traceparentForCorrelation } from '../platform/src/core/observability.js';

process.env.OVERSTRIKE_STRUCTURED_LOGS = 'true';

const arg = (k, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  if (hit) return Number(hit.split('=')[1]);
  const env = process.env[`OVERSTRIKE_${k.toUpperCase()}`];
  return env !== undefined ? Number(env) : d;
};

/** Same, for a string-valued flag. `arg` coerces to Number, which turns `bomb` into NaN. */
const argStr = (k, d) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  if (hit) return hit.slice(k.length + 3);
  return process.env[`OVERSTRIKE_${k.toUpperCase()}`] ?? d;
};

const PORT = arg('port', Number(process.env.PORT) || 8080);
/**
 * Which ruleset this process runs. Bomb puts `MSG_MATCHSTATE` and `MSG_OUTCOME` on the wire
 * and TDM does not, so a dedicated server that can only ever be TDM leaves half the v2
 * protocol with no end-to-end coverage over a real socket at all (`wire-protocol.md` §9.6).
 */
const MODE = argStr('mode', 'tdm');
let activeMode = MODE;
const BOTS = arg('bots', 8);
const MAX_CLIENTS = arg('maxclients', 12);
const GAME_REGION = process.env.OVERSTRIKE_REGION || 'iad';
let draining = process.env.OVERSTRIKE_DRAINING === 'true';
/** First team to this many kills wins the round. */
const KILL_LIMIT = normalizeKillLimit(arg('killlimit', 75));
/** Round length in seconds. 0 keeps the mode's own limit. Short rounds are for testing. */
const TIME_LIMIT = arg('timelimit', 0);
const DEBUG_CONTROL_SECRET = process.env.OVERSTRIKE_DEBUG_CONTROL_SECRET || null;
const opsLogger = createLogger({ service: 'match-server', level: process.env.OVERSTRIKE_LOG_LEVEL || 'info' });
const SERVER_LOG_FIELDS = new Set(['correlationId', 'matchId', 'mode', 'colliders', 'spawns',
  'botCount', 'clientCount', 'capacity', 'tickHz', 'tick', 'ticksDropped', 'outcome',
  'restartInMs', 'errorCode', 'networkClass', 'port', 'signal']);
const serverLog = (level, event, fields = {}) => opsLogger[level](event,
  Object.fromEntries(Object.entries(fields).filter(([key]) => SERVER_LOG_FIELDS.has(key))));
const safeErrorCode = (error) => {
  const candidate = String(error?.code || error?.name || 'INTERNAL_ERROR').toUpperCase();
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate) ? candidate : 'INTERNAL_ERROR';
};
const networkClass = (address) => {
  const value = String(address || '').replace(/^::ffff:/, '');
  if (value === '::1' || value.startsWith('127.')) return 'loopback';
  if (value.startsWith('10.') || value.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(value) || /^f[cd][0-9a-f]{2}:/i.test(value)) {
    return 'private';
  }
  return value ? 'public' : 'unknown';
};
const observability = createObservability({ service: 'match-server', logger: opsLogger });
const CORRELATION_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const correlationOf = (req, fallback) => CORRELATION_RE.test(String(req.headers['x-correlation-id'] || ''))
  ? String(req.headers['x-correlation-id']) : fallback;
const traceOf = (req, correlationId) => parseTraceparent(req.headers.traceparent)
  ? String(req.headers.traceparent).trim().toLowerCase() : traceparentForCorrelation(correlationId, 'platform');
const PLATFORM_CONTROL_URL = process.env.OVERSTRIKE_PLATFORM_CONTROL_URL || null;
const PUBLIC_WS_URL = process.env.OVERSTRIKE_PUBLIC_WS_URL || `ws://127.0.0.1:${PORT}`;
const SERVER_ID = process.env.OVERSTRIKE_SERVER_ID || `dev-server-${PORT}`;
if (process.env.NODE_ENV === 'production' && (!PLATFORM_CONTROL_URL || !process.env.OVERSTRIKE_PUBLIC_WS_URL
  || !process.env.OVERSTRIKE_SERVER_ID)) {
  throw new Error('OVERSTRIKE_PLATFORM_CONTROL_URL, OVERSTRIKE_PUBLIC_WS_URL and OVERSTRIKE_SERVER_ID are required in production');
}

function debugAuthorized(req) {
  if (process.env.NODE_ENV !== 'production') return true;
  const presented = Buffer.from(String(req.headers.authorization || ''));
  const expected = Buffer.from(DEBUG_CONTROL_SECRET ? `Bearer ${DEBUG_CONTROL_SECRET}` : '');
  return expected.length > 0 && presented.length === expected.length && timingSafeEqual(presented, expected);
}

function controlAuthorized(req) {
  const presented = Buffer.from(String(req.headers.authorization || ''));
  const expected = Buffer.from(`Bearer ${MATCH_CONTROL_SECRET}`);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

const game = new Game({ headless: true });
// Not a NullPresenter: the server has no screen, but its clients do, and the feedback
// it generates is theirs. See `RecordingPresenter`.
await game.initHeadless({ presenter: new RecordingPresenter() });
game.startMatch({ mode: MODE, killLimit: KILL_LIMIT, botCount: BOTS, difficulty: 'regular' });
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

const MATCH_TICKET_SECRET = process.env.OVERSTRIKE_MATCH_TICKET_SECRET
  || (process.env.NODE_ENV === 'production' ? null : 'DEV-ONLY-INSECURE-TOKEN-SECRET-do-not-ship');
if (!MATCH_TICKET_SECRET) throw new Error('OVERSTRIKE_MATCH_TICKET_SECRET is required in production');
const MATCH_CONTROL_SECRET = process.env.OVERSTRIKE_MATCH_CONTROL_SECRET
  || (process.env.NODE_ENV === 'production' ? null : 'DEV-ONLY-INSECURE-MATCH-CONTROL-SECRET-do-not-ship');
if (!MATCH_CONTROL_SECRET) throw new Error('OVERSTRIKE_MATCH_CONTROL_SECRET is required in production');
const REQUIRE_MATCH_TICKETS = process.env.NODE_ENV === 'production'
  || Boolean(process.env.OVERSTRIKE_MATCH_TICKET_SECRET);
let boundMatch = null;
let lastReleasedMatchId = null;
const matchTicketVerifier = REQUIRE_MATCH_TICKETS ? createMatchTicketVerifier({
  secret: MATCH_TICKET_SECRET,
  matchId: process.env.OVERSTRIKE_MATCH_ID || null,
  roomId: process.env.OVERSTRIKE_ROOM_ID || null,
  consume: PLATFORM_CONTROL_URL ? async (claims) => {
    const response = await fetch(`${PLATFORM_CONTROL_URL.replace(/\/$/, '')}/v1/control/match-tickets/consume`, {
      method: 'POST', headers: { authorization: `Bearer ${MATCH_CONTROL_SECRET}`,
        'content-type': 'application/json', 'x-client-build': '1.0.0' },
      body: JSON.stringify({ jti: claims.jti, accountId: claims.sub,
        roomId: claims.roomId, matchId: claims.matchId }),
    });
    return response.status === 204;
  } : null,
}) : null;
function activateAllocation(allocation, trace = {}) {
  boundMatch = {
    matchId: allocation.matchId, roomId: allocation.roomId, mode: allocation.mode,
    mapId: allocation.mapId, mapVersion: allocation.mapVersion,
    rulesetVersion: allocation.rulesetVersion, serverBuild: allocation.serverBuild,
    region: allocation.region, status: 'allocated', startedAt: Date.now(),
    correlationId: trace.correlationId || allocation.matchId,
    traceparent: trace.traceparent || traceparentForCorrelation(trace.correlationId || allocation.matchId),
    roster: new Map(allocation.roster.map((seat) => [seat.accountId, {
      displayName: seat.displayName, team: seat.team, primaryIdx: seat.primaryIdx, secondaryIdx: seat.secondaryIdx,
      joined: false, connected: false, released: false, graceEndsAt: null,
      connectBy: seatClock.now() + 60_000, joinedAt: null, connectedAt: null,
      connectedMs: 0, disconnectedAt: null,
    }])),
  };
  activeMode = allocation.mode;
  game.startMatch({ mode: activeMode, killLimit: KILL_LIMIT, botCount: BOTS, difficulty: 'regular' });
  game.match.phase = 'live';
  game.match.countdown = 0;
  if (TIME_LIMIT > 0) game.match.timeLimit = TIME_LIMIT;
  server?.evidence?.identify?.({ matchId: allocation.matchId,
    rulesetVersion: allocation.rulesetVersion, serverBuild: allocation.serverBuild });
}
const server = new GameServer(game, {
  ticketVerifier: matchTicketVerifier,
  matchBinder: REQUIRE_MATCH_TICKETS ? (identity) => {
    if (!boundMatch || boundMatch.status === 'ended') return false;
    const seat = boundMatch.roster.get(identity.sub);
    return Boolean(seat && boundMatch.matchId === identity.matchId
      && boundMatch.roomId === identity.roomId && boundMatch.mode === identity.mode
      && seat.team === identity.team && seat.primaryIdx === identity.primaryIdx
      && seat.secondaryIdx === identity.secondaryIdx);
  } : null,
});
serverLog('info', 'server.map_ready', { colliders: game.world.boxes.length,
  spawns: game.world.spawnPoints.length, botCount: BOTS, mode: MODE });

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
const RECONNECT_GRACE_MS = 90_000;

/**
 * The SEAT-LIFECYCLE clock.  Deliberately not the simulation clock.
 *
 * Two deadlines decide whether a player still owns a body on this authority: the 60 s
 * `connectBy` window an allocated seat has to convert its handoff, and the 90 s
 * `RECONNECT_GRACE_MS` a dropped player has to come back. Both were read straight off
 * `Date.now()`, which means the only way to observe either one is to wait that long in real
 * time — and the only way to observe them NOT firing is to finish everything else faster
 * than the deadline, on whatever hardware you happen to be on.
 *
 * That is not a hypothetical. The `browserlivetest` acceptance harness starts two real
 * Chromium contexts, and on shared CI hardware loading the engine through the Vite dev
 * server took longer than the 60 s `connectBy` window. Both seats were reaped WHILE the
 * browsers were still entering, so `/v1/matches/:id/reconnect-ticket` answered 409
 * RECONNECT_GRACE_EXPIRED and the harness failed against a wall-clock deadline it did not
 * control. Widening the window would only move the number that CI is slower than.
 *
 * So the deadlines get a clock that a test can hold still and advance explicitly:
 *
 *   hold()        freeze it — deadlines stop approaching, nothing else changes
 *   resume()      continue from the frozen instant (no jump forward on release)
 *   advance(ms)   step it deliberately, to expire a window without waiting for it
 *
 * `toWallClock()` projects a seat-clock instant back into real time, because the platform
 * compares `graceEndsAt` against ITS own real clock. Reporting a held instant unprojected
 * would tell the platform a seat had expired while this process was still holding the body.
 *
 * The control surface for this is opt-in via OVERSTRIKE_SEAT_CLOCK_CONTROL (see
 * `/control/seat-clock`), so a production authority does not merely refuse to freeze —
 * it does not expose the ability at all.
 */
const seatClock = (() => {
  let frozenAt = null;
  let offsetMs = 0;
  const now = () => (frozenAt === null ? Date.now() + offsetMs : frozenAt);
  return {
    now,
    /**
     * Real-time instant at which a seat-clock instant will actually be reached.
     * Computed from the offset directly rather than `now() - Date.now()`, which reads the
     * real clock twice and can straddle a millisecond boundary.
     */
    toWallClock: (seatMs) => seatMs - (frozenAt === null ? offsetMs : frozenAt - Date.now()),
    hold() { if (frozenAt === null) frozenAt = Date.now() + offsetMs; },
    resume() { if (frozenAt !== null) { offsetMs = frozenAt - Date.now(); frozenAt = null; } },
    advance(ms) { if (frozenAt === null) offsetMs += ms; else frozenAt += ms; },
    state: () => ({ held: frozenAt !== null,
      offsetMs: frozenAt === null ? offsetMs : frozenAt - Date.now(), seatNow: now() }),
  };
})();
// Opt-in by env var, not by NODE_ENV: the acceptance harnesses deliberately run this process
// with NODE_ENV=production so that ticket enforcement is the real one. The seam therefore has
// to be a switch the SPAWNER sets, and a deployed authority never sets it — so the route does
// not exist there at all, which is a stronger guarantee than a route that exists and refuses.
const SEAT_CLOCK_CONTROL = process.env.OVERSTRIKE_SEAT_CLOCK_CONTROL === '1';

const heldEntities = new Map();
let restartAt = 0;
let matchesPlayed = 1;

game.bus?.on('matchEnd', (result) => {
  if (restartAt) return;
  if (boundMatch) {
    observability.recordSpan({ correlationId: boundMatch.correlationId,
      traceparent: boundMatch.traceparent, tier: 'match-server', name: 'match.terminal',
      attributes: { component: 'match-authority', outcome: result?.reason || 'unknown' } });
    boundMatch.status = 'ended';
    const byAccount = new Map([...server.clients.values()]
      .filter((client) => client.identity?.sub && client.entity)
      .map((client) => [client.identity.sub, client.entity]));
    for (const [accountId, held] of heldEntities) if (!byAccount.has(accountId)) byAccount.set(accountId, held.entity);
    try {
      boundMatch.result = buildCanonicalTerminalResult({ allocation: boundMatch,
        matchResult: result, match: game.match, entitiesByAccount: byAccount,
        evidence: server.evidence, endedAt: Date.now() });
    } catch (error) {
      // An incomplete evidence record cannot certify completed stats. Publishing `ended` with
      // no result makes the control plane take its existing aborted/no-contest path instead.
      boundMatch.result = null;
      serverLog('error', 'match.terminal_refused', { correlationId: boundMatch.correlationId,
        matchId: boundMatch.matchId, errorCode: safeErrorCode(error) });
    }
    serverLog('info', 'match.awaiting_release', { correlationId: boundMatch.correlationId,
      matchId: boundMatch.matchId, outcome: boundMatch.result?.winnerTeam || 'uncertified' });
    return;
  }
  restartAt = Date.now() + INTERMISSION_MS;
  serverLog('info', 'match.ended', { outcome: result?.reason || 'unknown',
    restartInMs: INTERMISSION_MS });
});

function restartMatch() {
  restartAt = 0;
  // The clock must NOT go backwards. `startMatch` resets `game.tick` to 0, which is right
  // for a tab starting a fresh match and wrong for a live server: every connected client
  // stamps its commands and its interpolation against the server tick, so rewinding it
  // strands them in a future the server no longer has snapshots for.
  const keepTick = game.tick;
  game.startMatch({ mode: activeMode, killLimit: KILL_LIMIT, botCount: BOTS, difficulty: 'regular' });
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
  serverLog('info', 'match.started', { clientCount: server.clients.size, botCount: BOTS,
    mode: activeMode });
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
  const wallNow = Date.now();
  // Seat deadlines run on the seat clock, never on `wallNow`: a test must be able to hold
  // this window open or step past it deliberately rather than race it. See `seatClock`.
  const seatNow = seatClock.now();
  expireUnjoinedSeats(boundMatch?.roster, seatNow);
  for (const [accountId, held] of heldEntities) {
    if (held.expiresAt > seatNow) continue;
    heldEntities.delete(accountId);
    game.removeEntity(held.entity);
    const seat = boundMatch?.roster.get(accountId);
    if (seat) { seat.released = true; seat.connected = false; seat.graceEndsAt = held.expiresAt; }
  }
  // Allocation publishes handoffs before browsers have loaded the engine. The referee clock
  // must not spend that loading interval deciding a match with nobody in it. Begin only once
  // every roster seat has either authenticated or expired; WELCOME is sent directly during
  // HELLO, so clients can finish connecting while fixed simulation remains held here.
  if (boundMatch?.status === 'allocated') {
    const seats = [...boundMatch.roster.values()];
    const commandedAccounts = new Set([...server.clients.values()]
      .filter((client) => client.authenticated && client.identity?.sub && client.stats.loadouts > 0)
      .map((client) => client.identity.sub));
    if (!commandedAccounts.size
      || ![...boundMatch.roster].every(([accountId, seat]) => seat.released
        || commandedAccounts.has(accountId))) return;
    boundMatch.status = 'in-progress';
    boundMatch.startedAt = wallNow;
    serverLog('info', 'match.started', { clientCount: server.clients.size,
      botCount: BOTS, mode: activeMode, correlationId: boundMatch.correlationId });
  }
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
        serverLog('warn', 'transport.message_error', { errorCode: safeErrorCode(e) });
      }
    });
    sock.on('close', () => { this.closed = true; });
    sock.on('error', (e) => { this.closed = true;
      serverLog('warn', 'transport.socket_error', { errorCode: safeErrorCode(e) }); });
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
  const controlStartedAt = Date.now();
  if (req.url === '/control/allocate' && req.method === 'POST') {
    if (!controlAuthorized(req)) { res.writeHead(401); res.end(); return; }
    if (draining) { res.writeHead(503); res.end(); return; }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 16_384) req.destroy();
    });
    req.on('end', () => {
      let allocation;
      try { allocation = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
      const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
      const accountIds = Array.isArray(allocation.roster) ? allocation.roster.map((seat) => seat.accountId) : [];
      const validRoster = Array.isArray(allocation.roster) && allocation.roster.length >= 1
        && allocation.roster.length <= MAX_CLIENTS && allocation.roster.every((seat) =>
          exactKeys(seat, ['accountId', 'displayName', 'team', 'primaryIdx', 'secondaryIdx'])
          && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(seat.accountId) && ['alpha', 'bravo'].includes(seat.team)
          && typeof seat.displayName === 'string' && seat.displayName.length >= 1 && seat.displayName.length <= 32
          && liveWeaponId('primary', seat.primaryIdx) && liveWeaponId('secondary', seat.secondaryIdx))
        && new Set(accountIds).size === accountIds.length;
      if (!exactKeys(allocation, ['matchId', 'roomId', 'mode', 'mapId', 'mapVersion',
        'rulesetVersion', 'serverBuild', 'region', 'roster'])
        || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(allocation.matchId)
        || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(allocation.roomId)
        || !['tdm', 'bomb'].includes(allocation.mode)
        || allocation.mapId !== 'the-square' || allocation.mapVersion !== '1.0.0'
        || allocation.rulesetVersion !== `${allocation.mode}-1.0.0`
        || allocation.serverBuild !== '1.0.0'
        || allocation.region !== GAME_REGION || !validRoster) {
        res.writeHead(422); res.end(); return;
      }
      if (allocation.matchId === lastReleasedMatchId) { res.writeHead(409); res.end(); return; }
      if (boundMatch && boundMatch.status !== 'ended') {
        const same = boundMatch.matchId === allocation.matchId && boundMatch.roomId === allocation.roomId;
        res.writeHead(same ? 200 : 409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: same, matchId: boundMatch.matchId })); return;
      }
      if ([...server.clients.values()].some((client) => client.authenticated)) {
        res.writeHead(409); res.end(); return;
      }
      if (matchTicketVerifier && !matchTicketVerifier.bindAllocation(allocation)) {
        res.writeHead(409); res.end(); return;
      }
      const correlationId = correlationOf(req, allocation.matchId);
      const traceparent = traceOf(req, correlationId);
      activateAllocation(allocation, { correlationId, traceparent });
      observability.recordSpan({ correlationId, traceparent, tier: 'match-server',
        name: 'control.allocate', durationMs: Date.now() - controlStartedAt,
        attributes: { component: 'match-control', status: 201 } });
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, matchId: boundMatch.matchId, capacity: MAX_CLIENTS,
        region: GAME_REGION, traceSpans: observability.timelineSpans(correlationId) }));
    });
    return;
  }
  if (req.url === '/control/status' && req.method === 'GET') {
    if (!controlAuthorized(req)) { res.writeHead(401); res.end(); return; }
    const correlationId = boundMatch?.correlationId || correlationOf(req, null);
    if (correlationId) observability.recordSpan({ correlationId,
      traceparent: boundMatch?.traceparent || traceOf(req, correlationId), tier: 'match-server',
      name: 'control.status', durationMs: Date.now() - controlStartedAt,
      attributes: { component: 'match-control', status: 200 } });
    res.writeHead(200, { 'content-type': 'application/json' });
    const authenticated = [...server.clients.values()].filter((client) => client.authenticated).length;
    res.end(JSON.stringify({ ok: true, region: GAME_REGION, capacity: MAX_CLIENTS,
      connected: authenticated, available: Math.max(0, MAX_CLIENTS - authenticated),
      draining, matchId: boundMatch?.matchId ?? null, roomId: boundMatch?.roomId ?? null,
      status: boundMatch?.status ?? 'idle', phase: game.match?.phase ?? null,
      result: boundMatch?.result ?? null,
      traceSpans: correlationId ? observability.timelineSpans(correlationId) : [],
      seats: boundMatch ? [...boundMatch.roster].map(([accountId, seat]) => ({
        accountId, connected: seat.connected, released: seat.released,
        // Projected back into real time: the platform compares this against ITS clock.
        graceEndsAt: seat.graceEndsAt ? new Date(seatClock.toWallClock(seat.graceEndsAt)).toISOString() : null,
      })) : [] }));
    return;
  }
  if (req.url === '/control/release' && req.method === 'POST') {
    if (!controlAuthorized(req)) { res.writeHead(401); res.end(); return; }
    let raw = '';
    req.setEncoding('utf8'); req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let input;
      try { input = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
      if (!input || Object.keys(input).length !== 1
        || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(input.matchId)) { res.writeHead(422); res.end(); return; }
      // Authenticated release is idempotent across process restart. An idle authority has no
      // allocation to corrupt; returning 204 lets a platform terminal saga recover after the
      // first release succeeded but its durable room reopen did not.
      if (!boundMatch) { lastReleasedMatchId = input.matchId; res.writeHead(204); res.end(); return; }
      if (input.matchId !== boundMatch.matchId) { res.writeHead(404); res.end(); return; }
      if (boundMatch.status !== 'ended' && [...server.clients.values()].some((client) => client.authenticated)) { res.writeHead(409); res.end(); return; }
      const correlationId = boundMatch.correlationId || correlationOf(req, input.matchId);
      observability.recordSpan({ correlationId, traceparent: boundMatch.traceparent,
        tier: 'match-server', name: 'control.release', durationMs: Date.now() - controlStartedAt,
        attributes: { component: 'match-control', status: 204 } });
      for (const client of [...server.clients.values()]) server.removeClient(client);
      for (const held of heldEntities.values()) game.removeEntity(held.entity);
      heldEntities.clear();
      lastReleasedMatchId = boundMatch.matchId;
      matchTicketVerifier?.releaseAllocation?.(boundMatch.matchId);
      boundMatch = null;
      res.writeHead(204); res.end();
    });
    return;
  }
  /**
   * The seat clock's control surface — the deterministic seam that replaces "wait 60 seconds".
   *
   * `{ "hold": true }`  freeze seat deadlines (they stop approaching)
   * `{ "hold": false }` resume from the frozen instant, without jumping forward
   * `{ "advanceMs": N }` step the seat clock, to expire a window on purpose
   *
   * Only mounted when OVERSTRIKE_SEAT_CLOCK_CONTROL=1, and still behind the control secret.
   * An authority that was not started with the switch answers 404: the seam is absent, not
   * merely disabled.
   */
  if (req.url === '/control/seat-clock' && req.method === 'POST') {
    if (!SEAT_CLOCK_CONTROL) { res.writeHead(404); res.end(); return; }
    if (!controlAuthorized(req)) { res.writeHead(401); res.end(); return; }
    let raw = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let input;
      try { input = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
      const keys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : null;
      if (!keys || keys.length !== 1
        || !((keys[0] === 'hold' && typeof input.hold === 'boolean')
          || (keys[0] === 'advanceMs' && Number.isFinite(input.advanceMs) && input.advanceMs >= 0))) {
        res.writeHead(422); res.end(); return;
      }
      if (keys[0] === 'hold') (input.hold ? seatClock.hold() : seatClock.resume());
      else seatClock.advance(input.advanceMs);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...seatClock.state() }));
    });
    return;
  }
  if (req.url === '/control/metrics' && req.method === 'GET') {
    if (!controlAuthorized(req)) { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(observability.snapshot()));
    return;
  }
  if (req.url === '/control/drain' && req.method === 'POST') {
    if (!controlAuthorized(req)) { res.writeHead(401); res.end(); return; }
    let raw = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let input;
      try { input = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
      if (!input || Object.keys(input).length !== 1 || typeof input.draining !== 'boolean') {
        res.writeHead(422); res.end(); return;
      }
      draining = input.draining;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, draining }));
    });
    return;
  }
  // Fly health checks and anything else curious. Cheap, and it makes "is the match
  // actually ticking" answerable without a game client.
  if (req.url === '/health' || req.url === '/' || req.url.startsWith('/health?')) {
    // Debug-only detail, opt-in via `?debug=1`. See the accounting block above.
    // Never expose combat coordinates, identities or damage accounting in production: it is
    // deliberately a local acceptance surface and would otherwise be a public wallhack.
    const debug = debugAuthorized(req) && req.url.includes('debug=1') ? {
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
        accountId: c.identity?.sub ?? null, claimedTeam: c.identity?.team ?? null,
        team: c.entity?.team ?? null, primaryIdx: c.identity?.primaryIdx ?? null,
        secondaryIdx: c.identity?.secondaryIdx ?? null,
      })),
      matchPhase: game.match?.phase ?? null,
    } : undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    // Public liveness is intentionally one bit. Match phase, score, capacity, entity counts
    // and command/session activity are all relayable live-match intelligence. The same local
    // acceptance surface remains available only through the authenticated debug request.
    if (!debug) { res.end(JSON.stringify({ ok: true })); return; }
    res.end(JSON.stringify({ ok: true, debug,
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
      killLimit: game.match?.killLimit ?? KILL_LIMIT,
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
  // Pre-HELLO sockets have a short deadline in GameServer and do not consume a player slot.
  // Counting them here let twelve idle TCP peers permanently deny every legitimate player.
  const authenticatedClients = [...server.clients.values()].filter((client) => client.authenticated).length;
  if (authenticatedClients >= MAX_CLIENTS) {
    sock.close(1013, 'server full');
    return;
  }
  const transport = new WsServerTransport(sock);
  const peerClass = networkClass(req.socket.remoteAddress);

  /**
   * Every connection gets its OWN entity — but **not until it has said hello** (§8.2 step 4:
   * "No entity exists before step 4. An unauthenticated socket can never cause allocation.").
   *
   * This ran unconditionally on `connection` before, so anyone who could open a socket could
   * make this process build a `Player`, register it in `game.entities`, arm it and spawn it
   * into the match without sending a single byte. A factory hands the decision to
   * `GameServer._onHello`, which runs it only after the version check passes.
   */
  const makeEntity = () => {
    const accountId = session.identity?.sub;
    const allocationSeat = boundMatch?.roster.get(accountId);
    const held = heldEntities.get(accountId);
    if (held && held.expiresAt > seatClock.now()) {
      heldEntities.delete(accountId);
      session.isReconnect = true;
      if (allocationSeat) {
        allocationSeat.connected = true; allocationSeat.connectedAt = Date.now();
        allocationSeat.disconnectedAt = null; allocationSeat.graceEndsAt = null;
      }
      server.evidence.recordConnection({ kind: 'reconnected', accountId,
        entityId: held.entity.id, at: new Date().toISOString() });
      serverLog('info', 'client.reconnected', { networkClass: peerClass,
        clientCount: server.clients.size, correlationId: boundMatch?.correlationId });
      return held.entity;
    }
    if (held) {
      heldEntities.delete(session.identity.sub);
      game.removeEntity(held.entity);
    }
    // A roster seat may allocate once. After its held body expires it is released, never
    // silently turned into a fresh Bomb life by a late reconnect ticket.
    if (REQUIRE_MATCH_TICKETS && (!allocationSeat || allocationSeat.released || allocationSeat.joined)) return null;
    const entity = new Player(game);
    entity.init();
    game.addEntity(entity);
    const primary = liveWeaponId('primary', session.identity?.primaryIdx ?? 0);
    const secondary = liveWeaponId('secondary', session.identity?.secondaryIdx ?? 0);
    if (!primary || !secondary) throw new Error('verified ticket carried an unavailable loadout');
    // Pick a side BEFORE spawning. `Player.respawn` prefers spawn points matching the
    // entity's team, so a joiner that spawns first and is balanced afterwards materialises
    // in the enemy's half. And a joiner left on the default team 0 could not damage — or
    // be damaged by — anyone else who joined, since `damageScale` returns 0 for a
    // teammate and the hit is then discarded entirely.
    entity.team = session.identity ? (session.identity.team === 'bravo' ? 1 : 0) : smallerTeam();
    entity.respawn?.();
    // Respawn equips defaults, so the signed allocation must be applied afterwards and stored
    // for every subsequent spawn. Browser MSG_LOADOUT cannot override this authoritative pair.
    session.loadout = [primary, secondary];
    game.weapons.giveLoadout(entity, session.loadout);
    if (allocationSeat) {
      allocationSeat.joined = true;
      allocationSeat.connected = true;
      allocationSeat.joinedAt = Date.now();
      allocationSeat.connectedAt = allocationSeat.joinedAt;
      allocationSeat.disconnectedAt = null;
      allocationSeat.graceEndsAt = null;
      server.evidence.recordConnection({ kind: 'connected', accountId,
        entityId: entity.id, at: new Date(allocationSeat.joinedAt).toISOString() });
    }
    serverLog('info', 'client.joined', { networkClass: peerClass,
      clientCount: server.clients.size, correlationId: boundMatch?.correlationId });
    return entity;
  };

  const session = server.addClient(transport, makeEntity);

  sock.on('close', () => {
    server.removeClient(session);
    // Only what the handshake actually allocated. A socket that never said hello has no
    // entity, and `removeEntity(undefined)` is a way to find that out at runtime.
    if (session.entity && session.identity?.sub) {
      const seat = boundMatch?.roster.get(session.identity.sub);
      const expiresAt = seatClock.now() + RECONNECT_GRACE_MS;
      heldEntities.set(session.identity.sub, {
        entity: session.entity, expiresAt,
      });
      if (seat) {
        const at = Date.now();
        if (seat.connectedAt) seat.connectedMs += Math.max(0, at - seat.connectedAt);
        seat.connected = false; seat.connectedAt = null; seat.disconnectedAt = at;
        seat.graceEndsAt = expiresAt;
        server.evidence.recordConnection({ kind: 'disconnected', accountId: session.identity.sub,
          entityId: session.entity.id, at: new Date(at).toISOString(), reason: 'socket-close' });
      }
    } else if (session.entity) game.removeEntity(session.entity);
    serverLog('info', 'client.left', { networkClass: peerClass,
      clientCount: server.clients.size, correlationId: boundMatch?.correlationId });
  });
});

let registered = false;
async function announceMatchServer() {
  if (!PLATFORM_CONTROL_URL) return;
  const path = registered ? '/v1/control/match-servers/heartbeat' : '/v1/control/match-servers/register';
  const body = registered
    ? { serverId: SERVER_ID, capacity: MAX_CLIENTS, inUse: boundMatch ? MAX_CLIENTS : 0,
      status: draining ? 'draining' : 'healthy' }
    : { serverId: SERVER_ID, region: GAME_REGION, address: PUBLIC_WS_URL,
      capacity: MAX_CLIENTS, build: '1.0.0' };
  try {
    const response = await fetch(new URL(path, PLATFORM_CONTROL_URL), {
      method: 'POST', headers: { authorization: `Bearer ${MATCH_CONTROL_SECRET}`,
        'content-type': 'application/json', 'x-client-build': '1.0.0' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(2_500),
    });
    if (response.ok) registered = true;
    else if (response.status === 404) registered = false;
  } catch { /* startup/redeploy overlap: the next heartbeat retries */ }
}

http_.listen(PORT, '0.0.0.0', () => {
  serverLog('info', 'server.listening', { port: PORT,
    tickHz: Number((1 / FIXED_DT).toFixed(0)), capacity: MAX_CLIENTS });
  void announceMatchServer();
});
const registrationTimer = setInterval(() => void announceMatchServer(), 5_000);
registrationTimer.unref();

// A status line often enough to be useful in `fly logs`, rarely enough to be readable.
setInterval(() => {
  serverLog('info', 'server.status', { tick: game.tick, clientCount: server.clients.size,
    ticksDropped: behind });
}, 30000).unref();

const shutdown = (sig) => {
  serverLog('info', 'server.shutdown', { signal: sig });
  clearInterval(timer);
  clearInterval(registrationTimer);
  for (const s of [...server.clients.values()]) server.removeClient(s);
  wss.close();
  http_.close(() => process.exit(0));
  // Do not wait forever for a socket that will not close.
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
