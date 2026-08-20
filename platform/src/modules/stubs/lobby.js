/**
 * The lobby socket stub.  contracts/realtime-lobby.md §10, behind `lobby.stub`.
 *
 * A scripted emitter, not a server: a timeline is a list of steps, each either a frame the
 * server sends or a frame the client is expected to send, and the whole thing is drivable with
 * `next()` from a test with no socket, no port, and no timers. That matters because every
 * branch a lobby screen can reach has to be reproducible on demand — a countdown that aborts
 * for team imbalance is not something you can wait for.
 *
 * `seq` is per connection and monotonic, exactly as §2 requires, because the client's gap
 * detection is a real code path and a stub that never exercises it is a stub that lets a
 * resync bug ship.
 */
import { ApiError } from '../../core/errors.js';
import { createClock } from './clock.js';
import { stubUlid, stubToken } from './ids.js';
import * as fx from './fixtures.js';

const CORRELATION = stubUlid('lobby:correlation', Date.UTC(2026, 2, 1));

const envelopeFor = (code, message, details = {}) =>
  new ApiError(code, message, { details }).toEnvelope(CORRELATION);

/** The §3 welcome payload. `state.snapshot` carries the identical `d` under a different `t`. */
function welcomePayload(roomIndex, clock) {
  return {
    protocol: 1,
    serverTime: clock.now(),
    heartbeatMs: 15000,
    graceMs: 90000,
    you: {
      accountId: fx.ACCOUNT_ID,
      team: 'alpha',
      ready: false,
      isOwner: roomIndex === 0,
      seatHeldUntil: null,
    },
    room: fx.roomCore(roomIndex),
    roster: fx.roster(roomIndex),
    countdown: fx.countdownState(roomIndex),
    chatHistory: [
      { id: stubUlid('chat:1', Date.UTC(2026, 2, 1)), accountId: fx.OTHER_ACCOUNT_ID,
        displayName: 'StubPlayer01', text: 'glhf', ts: clock.fromEpoch(-30 * 1000), filtered: false },
    ],
  };
}

function newMember(seed) {
  return {
    accountId: stubUlid(`lobby:member:${seed}`, Date.UTC(2026, 2, 1)),
    displayName: `StubPlayer${seed}`,
    team: 'bravo',
    ready: false,
    isOwner: false,
    isLocal: false,
    connection: 'connected',
    estimatedRttMs: null,
    loadout: { primaryIdx: 1, secondaryIdx: 0 },
    joinedAt: '2026-03-01T00:00:00.000Z',
  };
}

/**
 * The timelines. Each is a function of a builder `b` so `seq` and `ts` are assigned centrally
 * and monotonically — a timeline that numbered its own frames would eventually number them
 * wrong, and a `seq` gap means "state was missed" to every client that sees it.
 */
export const LOBBY_SCENARIOS = {
  'happy-path': (b) => {
    b.welcome();
    b.client('ready.set', { ready: true });
    b.server('ready.changed', { accountId: fx.ACCOUNT_ID, ready: true });
    b.client('launch.request', {});
    b.server('countdown.started', { endsAt: b.clock.plus(10000), requiredReady: 8, currentReady: 8 });
    b.server('countdown.tick', { remainingMs: 3000 });
    b.server('countdown.tick', { remainingMs: 2000 });
    b.server('countdown.tick', { remainingMs: 1000 });
    b.server('match.allocating', {});
    b.server('match.ready', fx.matchHandoff(fx.MATCH_ID, b.clock));
    b.server('room.updated', { status: 'in-progress' });
  },

  'player-joins-mid': (b) => {
    b.welcome();
    b.server('roster.delta', { added: [newMember('09')], updated: [], removed: [] });
    b.server('room.updated', { playerCount: 13 });
  },

  'team-full': (b) => {
    b.welcome();
    b.client('team.request', { team: 'bravo' });
    // Non-fatal: the socket stays open and the client reverts its optimistic switch.
    b.server('error', envelopeFor('TEAM_FULL', 'That team is full.'));
  },

  'ready-cleared': (b) => {
    b.welcome();
    b.client('ready.set', { ready: true });
    b.server('ready.changed', { accountId: fx.ACCOUNT_ID, ready: true });
    b.server('roster.delta', { added: [newMember('10')], updated: [], removed: [] });
    // §7: an unexplained green light going grey reads as a bug, so the reason travels with it.
    b.server('ready.changed', { accountId: fx.ACCOUNT_ID, ready: false, clearedReason: 'roster-change' });
  },

  'countdown-abort-unready': (b) => {
    b.welcome();
    b.server('countdown.started', { endsAt: b.clock.plus(10000), requiredReady: 8, currentReady: 8 });
    b.server('countdown.tick', { remainingMs: 8000 });
    b.server('ready.changed', { accountId: fx.OTHER_ACCOUNT_ID, ready: false });
    // §6.2: readiness is NOT cleared here — the remaining players stay green so a re-launch is
    // one click.
    b.server('countdown.aborted', { reason: 'player-unready', byAccountId: fx.OTHER_ACCOUNT_ID });
  },

  'countdown-continues': (b) => {
    b.welcome();
    b.server('countdown.started', { endsAt: b.clock.plus(10000), requiredReady: 8, currentReady: 9 });
    b.server('roster.delta', { added: [], updated: [], removed: [fx.OTHER_ACCOUNT_ID] });
    // The roster is already frozen and the threshold still holds, so a departure that breaks
    // nothing does not punish everyone.
    b.server('countdown.tick', { remainingMs: 5000 });
    b.server('match.allocating', {});
    b.server('match.ready', fx.matchHandoff(fx.MATCH_ID, b.clock));
  },

  'countdown-abort-imbalance': (b) => {
    b.welcome();
    b.server('countdown.started', { endsAt: b.clock.plus(10000), requiredReady: 8, currentReady: 8 });
    b.server('team.changed', { accountId: fx.OTHER_ACCOUNT_ID, team: 'alpha', byServer: false });
    b.server('countdown.aborted', { reason: 'team-imbalance' });
    // Readiness IS cleared for imbalance, unlike the unready case above.
    b.server('ready.changed', { accountId: fx.ACCOUNT_ID, ready: false, clearedReason: 'team-change' });
  },

  'allocation-failed': (b) => {
    b.welcome();
    b.server('countdown.started', { endsAt: b.clock.plus(10000), requiredReady: 8, currentReady: 8 });
    b.server('match.allocating', {});
    b.server('match.failed', envelopeFor('MATCH_ALLOCATION_FAILED', 'No capacity in this region right now.'));
    b.server('countdown.aborted', { reason: 'allocation-failed' });
    // §6 rule 4: the room returns to open with readiness cleared. Nobody is left staring at a
    // countdown that already died.
    b.server('room.updated', { status: 'open' });
  },

  'room-closed': (b) => {
    b.welcome();
    b.server('room.updated', { status: 'closing', joinable: false, joinBlockedReason: 'closing' });
    b.close('ROOM_CLOSED', 'This room is closing.');
  },

  'kicked': (b) => {
    b.welcome();
    // No auto-rejoin, ever: the removal is authoritative and retrying is how a kick becomes a
    // loop.
    b.close('ROOM_REMOVED', 'You were removed from this room.', { reason: 'owner-removed', until: null });
  },

  'disconnect-resync': (b) => {
    b.welcome();
    b.drop();
    b.http('POST', '/v1/rooms/:id/reconnect-ticket', {
      lobbySocketUrl: 'wss://lobby.stub.invalid/v1/lobby',
      lobbyTicket: stubToken('lobbyticket', 'lobby:resync'),
      expiresAt: b.clock.plus(30000),
      graceEndsAt: b.clock.plus(90000),
    });
    b.client('state.resync', { lastSeq: 0 });
    // §8: the snapshot is authoritative and local deltas are discarded, not merged.
    b.snapshot();
  },

  'reconnect-grace-exhausted': (b) => {
    b.welcome();
    b.drop();
    // Max 5 attempts, exponential backoff from 1 s with jitter, cap 15 s. The stub scripts the
    // backoff schedule without jitter so the sequence is reproducible.
    for (const delay of [1000, 2000, 4000, 8000, 15000]) b.attempt(delay);
    b.httpError('POST', '/v1/rooms/:id/reconnect-ticket',
      envelopeFor('RECONNECT_GRACE_EXPIRED', 'Your seat was released.', {
        graceEndsAt: b.clock.fromEpoch(-1000), roomId: fx.ROOM_IDS[1], rejoinable: false, reason: 'grace-expired',
      }));
  },

  'handoff-version-mismatch': (b) => {
    b.welcome();
    b.server('match.ready', fx.matchHandoff(fx.MATCH_ID, b.clock));
    // The lobby handoff is fine; the match socket is what refuses. Never retried — an upgrade
    // is the only exit.
    b.matchSocketClose('PROTOCOL_VERSION_MISMATCH', 'Please update the game to continue.');
  },

  'sanctioned': (b) => {
    b.welcome();
    b.client('chat.send', { text: 'hello' });
    b.server('error', envelopeFor('SANCTIONED', 'Chat is unavailable on your account.', {
      sanction: { kind: 'chat-ban', expiresAt: null, appealUrl: 'https://stub.overstrike.invalid/appeal' },
    }));
  },

  'chat-flood': (b) => {
    b.welcome();
    for (let i = 0; i < 3; i++) {
      b.client('chat.send', { text: `spam ${i}` });
      b.server('chat.message', {
        id: stubUlid(`chat:flood:${i}`, Date.UTC(2026, 2, 1)),
        accountId: fx.ACCOUNT_ID,
        displayName: fx.DISPLAY_NAME,
        text: `spam ${i}`,
        ts: b.clock.now(),
        filtered: false,
      });
    }
    b.client('chat.send', { text: 'spam 3' });
    // Exceeding a limit is an `error` frame, NOT a close. Sustained abuse is what closes it.
    b.server('error', envelopeFor('CHAT_RATE_LIMITED', 'You are sending messages too quickly.'));
  },
};

export const LOBBY_SCENARIO_NAMES = Object.keys(LOBBY_SCENARIOS);

/**
 * Build a lobby stub for one scenario.
 *
 * `steps()` is the whole timeline; `next()` walks it. Both are pure functions of the scenario
 * name — replaying gives identical frames, including every `ts`, because the clock is seeded.
 */
export function createLobbyStub({ scenario = 'happy-path', roomIndex = 1 } = {}) {
  const script = LOBBY_SCENARIOS[scenario];
  if (!script) throw new Error(`lobby.stub: unknown scenario ${scenario}`);

  const clock = createClock(1000);
  const steps = [];
  let seq = 0;

  const push = (dir, kind, frame) => { steps.push({ dir, kind, frame }); };

  const builder = {
    clock,
    server(t, d) {
      clock.tick();
      push('server', 'frame', { t, seq: seq++, ts: clock.now(), correlationId: CORRELATION, d });
    },
    welcome() {
      clock.tick();
      push('server', 'frame', {
        t: 'lobby.welcome', seq: seq++, ts: clock.now(), correlationId: CORRELATION,
        d: welcomePayload(roomIndex, clock),
      });
    },
    snapshot() {
      clock.tick();
      push('server', 'frame', {
        t: 'state.snapshot', seq: seq++, ts: clock.now(), correlationId: CORRELATION,
        d: welcomePayload(roomIndex, clock),
      });
    },
    client(t, d) {
      clock.tick();
      push('client', 'frame', { t, ts: clock.now(), correlationId: CORRELATION, d });
    },
    close(code, message, details = {}) {
      clock.tick();
      push('server', 'close', { code, error: envelopeFor(code, message, details), ts: clock.now() });
    },
    matchSocketClose(code, message) {
      clock.tick();
      push('server', 'match-socket-close', { code, error: envelopeFor(code, message), ts: clock.now() });
    },
    drop() {
      clock.tick();
      push('transport', 'drop', { ts: clock.now() });
    },
    attempt(backoffMs) {
      clock.tick();
      push('client', 'reconnect-attempt', { backoffMs, ts: clock.now() });
    },
    http(method, path, body) {
      clock.tick();
      push('client', 'http', { method, path, status: 200, body, ts: clock.now() });
    },
    httpError(method, path, envelope) {
      clock.tick();
      push('client', 'http', { method, path, status: envelope.error.code === 'RECONNECT_GRACE_EXPIRED' ? 409 : 400, body: envelope, ts: clock.now() });
    },
  };

  script(builder);

  let cursor = 0;
  return {
    scenario,
    steps: () => steps.slice(),
    next: () => (cursor < steps.length ? steps[cursor++] : null),
    reset() { cursor = 0; },
    /** Server frames only — what a reducer under test would actually consume. */
    serverFrames: () => steps.filter((s) => s.dir === 'server' && s.kind === 'frame').map((s) => s.frame),
  };
}
