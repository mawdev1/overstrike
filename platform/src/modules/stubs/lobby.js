/**
 * The lobby socket stub.  contracts/realtime-lobby.md §10, behind `lobby.stub`.
 *
 * A scripted emitter, not a server: a timeline is a list of steps, each either a frame the
 * server sends or a frame the client is expected to send, and the whole thing is drivable with
 * `next()` from a test with no socket, no port, and no timers. That matters because every
 * branch a lobby screen can reach has to be reproducible on demand — a countdown that aborts
 * for team imbalance is not something you can wait for.
 *
 * ── Timelines are seeded from a COMPATIBLE room ──────────────────────────────────────────────
 * Every timeline used to start from fixture room B: full at 12/12, already counting down, and
 * owned by somebody else. So the happy path began in a room nobody could join, skipped the team
 * step, and sent `launch.request` — which §5 marks owner-only — from a non-owner; the
 * mid-join timeline added a thirteenth member to a 12-capacity room; and readiness, the roster
 * freeze and ticket issuance were never exercised at all. A shell built against that learns
 * transitions the server will refuse.
 *
 * Each timeline now declares its seed, the builder maintains the room as frames are emitted, and
 * the invariants are ASSERTED while the script runs: capacity is never exceeded, only the owner
 * launches, the roster freezes at `countdown.started`, and readiness clears with its reason.
 * A timeline that violates one throws at construction — a broken fixture should fail the build,
 * not teach a lie quietly.
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

/** A fixture violation is a bug in this file, not something a client should ever receive. */
const invariant = (cond, message) => { if (!cond) throw new Error(`lobby.stub: ${message}`); };

/**
 * The room a timeline starts in.
 *
 * `index` picks the fixture room; `overrides` adjust the room fields a timeline needs to be
 * *about* something else (a full room that is open, so `TEAM_FULL` is about the team rather
 * than the phase); `ready` decides which members start green.
 */
function seedRoom({ index, overrides = {}, readyCount = 0, countdown = null }) {
  const core = { ...fx.roomCore(index), ...overrides };
  const roster = fx.roster(index, {}).slice(0, overrides.playerCount ?? core.playerCount);
  roster.forEach((m, i) => { m.ready = i < readyCount; });
  core.playerCount = roster.length;
  invariant(roster.length <= core.capacity, `seed exceeds capacity (${roster.length}/${core.capacity})`);
  invariant(roster.filter((m) => m.isLocal).length === 1, 'exactly one roster member is the caller');
  return { core, roster, countdown, frozen: false };
}

/** The §3 welcome payload. `state.snapshot` carries the identical `d` under a different `t`. */
function welcomePayload(room, clock) {
  const me = room.roster.find((m) => m.isLocal);
  return {
    protocol: 1,
    serverTime: clock.now(),
    heartbeatMs: 15000,
    graceMs: 90000,
    you: {
      accountId: me.accountId,
      team: me.team,
      ready: me.ready,
      isOwner: me.isOwner,
      seatHeldUntil: null,
    },
    room: { ...room.core, playerCount: room.roster.length },
    roster: room.roster.map((m) => ({ ...m })),
    countdown: room.countdown ? { ...room.countdown } : null,
    chatHistory: [
      { id: stubUlid('chat:1', Date.UTC(2026, 2, 1)), accountId: fx.OTHER_ACCOUNT_ID,
        displayName: 'StubPlayer01', text: 'glhf', ts: clock.fromEpoch(-30 * 1000), filtered: false },
    ],
  };
}

function newMember(seed, team = 'bravo') {
  return {
    accountId: stubUlid(`lobby:member:${seed}`, Date.UTC(2026, 2, 1)),
    displayName: `StubPlayer${seed}`,
    team,
    ready: false,
    isOwner: false,
    isLocal: false,
    connection: 'connected',
    estimatedRttMs: null,
    loadout: { primaryIdx: 1, secondaryIdx: 0 },
    joinedAt: '2026-03-01T00:00:00.000Z',
  };
}

/** Room A: open TDM, 6 of 12, owned by the caller. The only fixture a launch can start from. */
const OWNED_OPEN_ROOM = { index: 0 };

/** Room B with the countdown removed: full and 6-a-side, so a team refusal is about the team. */
const FULL_OPEN_ROOM = {
  index: 1,
  overrides: { status: 'open', joinable: false, joinBlockedReason: 'full' },
};

/**
 * The timelines. Each declares its seed and a script over the builder `b`, so `seq` and `ts` are
 * assigned centrally and monotonically — a timeline that numbered its own frames would
 * eventually number them wrong, and a `seq` gap means "state was missed" to every client.
 */
export const LOBBY_SCENARIOS = {
  'happy-path': {
    seed: OWNED_OPEN_ROOM,
    script(b) {
      b.welcome();
      // Team first, while nobody is ready: §7 clears readiness on any team change, so a
      // timeline that greens up and then switches would be greening up twice.
      b.client('team.request', { team: 'bravo' });
      b.teamChanged(b.me().accountId, 'bravo');
      b.client('ready.set', { ready: true });
      b.readyChanged(b.me().accountId, true);
      // Below the threshold, launching is refused — and the refusal is an `error` frame, not a
      // close: the room is still perfectly usable.
      b.client('launch.request', {});
      b.error('CONFLICT', 'Everyone has to be ready first.',
        { reason: 'not-all-ready', requiredReady: b.requiredReady(), currentReady: b.readyCount() });
      for (const m of b.others()) b.readyChanged(m.accountId, true);
      b.client('launch.request', {});
      b.countdownStarted();                 // asserts ownership and the ready threshold
      b.joinRefused('ROOM_IN_PROGRESS');    // §6 rule 1: the roster is frozen from here
      b.server('countdown.tick', { remainingMs: 3000 });
      b.server('countdown.tick', { remainingMs: 2000 });
      b.server('countdown.tick', { remainingMs: 1000 });
      b.server('match.allocating', {});
      b.matchReady();                       // per-account single-use ticket (§6 rule 3)
      b.roomUpdated({ status: 'in-progress' });
    },
  },

  'player-joins-mid': {
    seed: OWNED_OPEN_ROOM,
    script(b) {
      b.welcome();
      b.addMember(newMember('09'));         // 7 of 12 — the capacity check is in addMember
    },
  },

  'team-full': {
    seed: FULL_OPEN_ROOM,
    script(b) {
      b.welcome();
      b.client('team.request', { team: 'bravo' });
      // Non-fatal: the socket stays open and the client reverts its optimistic switch.
      b.error('TEAM_FULL', 'That team is full.');
    },
  },

  'ready-cleared': {
    seed: OWNED_OPEN_ROOM,
    script(b) {
      b.welcome();
      b.client('ready.set', { ready: true });
      b.readyChanged(b.me().accountId, true);
      // §7: the join is what clears it, and an unexplained green light going grey reads as a
      // bug — so `addMember` emits the clear with its reason rather than leaving it implied.
      b.addMember(newMember('10'));
    },
  },

  'countdown-abort-unready': {
    seed: { ...OWNED_OPEN_ROOM, readyCount: 6 },
    script(b) {
      b.welcome();
      b.countdownStarted();
      b.server('countdown.tick', { remainingMs: 8000 });
      const other = b.others()[0];
      b.readyChanged(other.accountId, false);
      // §6.2: readiness is NOT cleared here — the remaining players stay green so a re-launch is
      // one click. The builder asserts that nobody else was cleared.
      b.countdownAborted('player-unready', { byAccountId: other.accountId, clearReadiness: false });
    },
  },

  'countdown-continues': {
    // 12 present, 8 ready, threshold 8: a leaver who was never ready cannot break it.
    seed: { index: 1, overrides: { status: 'open' }, readyCount: 8 },
    script(b) {
      b.welcome();
      b.countdownStarted();
      const leaver = b.others().find((m) => !m.ready);
      b.removeMember(leaver.accountId);
      // The roster is already frozen and the threshold still holds, so a departure that breaks
      // nothing does not punish everyone.
      b.assertThresholdHolds();
      b.server('countdown.tick', { remainingMs: 5000 });
      b.server('match.allocating', {});
      b.matchReady();
    },
  },

  'countdown-abort-imbalance': {
    seed: { index: 1, overrides: { status: 'open' }, readyCount: 8 },
    script(b) {
      b.welcome();
      b.countdownStarted();
      const switcher = b.others().find((m) => m.team === 'bravo');
      b.teamChanged(switcher.accountId, 'alpha', { byServer: false });
      // Readiness IS cleared for imbalance, unlike the unready case above.
      b.countdownAborted('team-imbalance', { clearReadiness: true, clearedReason: 'team-change' });
    },
  },

  'allocation-failed': {
    seed: { ...OWNED_OPEN_ROOM, readyCount: 6 },
    script(b) {
      b.welcome();
      b.countdownStarted();
      b.server('match.allocating', {});
      b.server('match.failed', envelopeFor('MATCH_ALLOCATION_FAILED', 'No capacity in this region right now.'));
      // §6 rule 4: the room returns to open with readiness cleared. Nobody is left staring at a
      // countdown that already died.
      b.countdownAborted('allocation-failed', { clearReadiness: true, clearedReason: 'room-change' });
      b.roomUpdated({ status: 'open', joinable: true, joinBlockedReason: null });
    },
  },

  'room-closed': {
    seed: OWNED_OPEN_ROOM,
    script(b) {
      b.welcome();
      b.roomUpdated({ status: 'closing', joinable: false, joinBlockedReason: 'closing' });
      b.close('ROOM_CLOSED', 'This room is closing.');
    },
  },

  'kicked': {
    seed: OWNED_OPEN_ROOM,
    script(b) {
      b.welcome();
      // No auto-rejoin, ever: the removal is authoritative and retrying is how a kick becomes a
      // loop.
      b.close('ROOM_REMOVED', 'You were removed from this room.', { reason: 'owner-removed', until: null });
    },
  },

  'disconnect-resync': {
    seed: OWNED_OPEN_ROOM,
    script(b) {
      b.welcome();
      b.drop();
      b.http('POST', '/v1/rooms/:id/reconnect-ticket', {
        lobbySocketUrl: 'wss://lobby.stub.invalid/v1/lobby',
        lobbyTicket: stubToken('lobbyticket', 'lobby:resync'),
        expiresAt: b.clock.plus(30000),
        graceEndsAt: b.clock.plus(90000),
      });
      b.client('state.resync', { lastSeq: 0 });
      // §8: the snapshot is authoritative and local deltas are discarded, not merged. It is
      // taken from the room as it stands now, so a client that missed a delta gets the truth.
      b.snapshot();
    },
  },

  'reconnect-grace-exhausted': {
    seed: OWNED_OPEN_ROOM,
    script(b) {
      b.welcome();
      b.drop();
      // Max 5 attempts, exponential backoff from 1 s with jitter, cap 15 s. The stub scripts the
      // backoff schedule without jitter so the sequence is reproducible.
      for (const delay of [1000, 2000, 4000, 8000, 15000]) b.attempt(delay);
      b.httpError('POST', '/v1/rooms/:id/reconnect-ticket',
        envelopeFor('RECONNECT_GRACE_EXPIRED', 'Your seat was released.', {
          graceEndsAt: b.clock.fromEpoch(-1000), roomId: b.room.core.roomId, rejoinable: false, reason: 'grace-expired',
        }));
    },
  },

  'handoff-version-mismatch': {
    seed: { ...OWNED_OPEN_ROOM, readyCount: 6 },
    script(b) {
      b.welcome();
      b.countdownStarted();
      b.matchReady();
      // The lobby handoff is fine; the match socket is what refuses. Never retried — an upgrade
      // is the only exit.
      b.matchSocketClose('PROTOCOL_VERSION_MISMATCH', 'Please update the game to continue.');
    },
  },

  'sanctioned': {
    seed: OWNED_OPEN_ROOM,
    script(b) {
      b.welcome();
      b.client('chat.send', { text: 'hello' });
      b.error('SANCTIONED', 'Chat is unavailable on your account.', {
        sanction: { kind: 'chat-ban', expiresAt: null, appealUrl: 'https://stub.overstrike.invalid/appeal' },
      });
    },
  },

  'chat-flood': {
    seed: OWNED_OPEN_ROOM,
    script(b) {
      b.welcome();
      for (let i = 0; i < 3; i++) {
        b.client('chat.send', { text: `spam ${i}` });
        b.server('chat.message', {
          id: stubUlid(`chat:flood:${i}`, Date.UTC(2026, 2, 1)),
          accountId: b.me().accountId,
          displayName: fx.DISPLAY_NAME,
          text: `spam ${i}`,
          ts: b.clock.now(),
          filtered: false,
        });
      }
      b.client('chat.send', { text: 'spam 3' });
      // Exceeding a limit is an `error` frame, NOT a close. Sustained abuse is what closes it.
      b.error('CHAT_RATE_LIMITED', 'You are sending messages too quickly.');
    },
  },
};

export const LOBBY_SCENARIO_NAMES = Object.keys(LOBBY_SCENARIOS);

/**
 * Build a lobby stub for one scenario.
 *
 * `steps()` is the whole timeline; `next()` walks it. Both are pure functions of the scenario
 * name — replaying gives identical frames, including every `ts`, because the clock is seeded.
 */
export function createLobbyStub({ scenario = 'happy-path', roomIndex = null } = {}) {
  const entry = LOBBY_SCENARIOS[scenario];
  if (!entry) throw new Error(`lobby.stub: unknown scenario ${scenario}`);

  const clock = createClock(1000);
  const steps = [];
  let seq = 0;

  const seed = roomIndex === null ? entry.seed : { ...entry.seed, index: roomIndex };
  const room = seedRoom(seed);

  const push = (dir, kind, frame) => { steps.push({ dir, kind, frame }); };
  const member = (accountId) => room.roster.find((m) => m.accountId === accountId);
  const readyCount = () => room.roster.filter((m) => m.ready).length;
  // The threshold a half-full room can actually reach: `requiredReady` is a ceiling, not a
  // quorum that makes a 6-player room permanently unlaunchable.
  const requiredReady = () => Math.min(room.core.settings.requiredReady, room.roster.length);

  const builder = {
    clock,
    room,
    me: () => room.roster.find((m) => m.isLocal),
    others: () => room.roster.filter((m) => !m.isLocal),
    readyCount,
    requiredReady,

    server(t, d) {
      clock.tick();
      push('server', 'frame', { t, seq: seq++, ts: clock.now(), correlationId: CORRELATION, d });
    },
    client(t, d) {
      clock.tick();
      push('client', 'frame', { t, ts: clock.now(), correlationId: CORRELATION, d });
    },
    welcome() {
      clock.tick();
      push('server', 'frame', {
        t: 'lobby.welcome', seq: seq++, ts: clock.now(), correlationId: CORRELATION,
        d: welcomePayload(room, clock),
      });
    },
    snapshot() {
      clock.tick();
      push('server', 'frame', {
        t: 'state.snapshot', seq: seq++, ts: clock.now(), correlationId: CORRELATION,
        d: welcomePayload(room, clock),
      });
    },
    error(code, message, details = {}) {
      builder.server('error', envelopeFor(code, message, details));
    },

    // ── mutations: the room changes, and the frame reports the change ──────────────────────
    addMember(m) {
      invariant(!room.frozen, 'a join during the countdown must be refused, not admitted');
      invariant(room.roster.length < room.core.capacity,
        `roster ${room.roster.length} would exceed capacity ${room.core.capacity}`);
      room.roster.push(m);
      builder.server('roster.delta', { added: [m], updated: [], removed: [] });
      builder.roomUpdated({ playerCount: room.roster.length });
      // §7: a join changes the shape of the match the ready players consented to.
      if (readyCount()) builder.clearReady('roster-change');
    },
    removeMember(accountId) {
      invariant(member(accountId), `cannot remove ${accountId}: not on the roster`);
      room.roster = room.roster.filter((m) => m.accountId !== accountId);
      builder.server('roster.delta', { added: [], updated: [], removed: [accountId] });
      builder.roomUpdated({ playerCount: room.roster.length });
    },
    readyChanged(accountId, ready, clearedReason = undefined) {
      const m = member(accountId);
      invariant(m, `cannot ready ${accountId}: not on the roster`);
      m.ready = ready;
      builder.server('ready.changed',
        clearedReason === undefined
          ? { accountId, ready }
          : { accountId, ready, clearedReason });
    },
    clearReady(reason) {
      for (const m of room.roster.filter((x) => x.ready)) {
        builder.readyChanged(m.accountId, false, reason);
      }
    },
    teamChanged(accountId, team, { byServer = false } = {}) {
      const m = member(accountId);
      invariant(m, `cannot move ${accountId}: not on the roster`);
      m.team = team;
      builder.server('team.changed', { accountId, team, byServer });
      // §7: any team change clears readiness. The clear is emitted, never implied.
      if (readyCount() && !room.frozen) builder.clearReady('team-change');
    },
    roomUpdated(patch) {
      // §11.3: `room.updated` is Partial<RoomCore> over the mutable keys only.
      const mutable = ['name', 'status', 'capacity', 'playerCount', 'joinable', 'joinBlockedReason',
        'settings', 'ownerAccountId'];
      for (const k of Object.keys(patch)) invariant(mutable.includes(k), `room.updated cannot carry ${k}`);
      Object.assign(room.core, patch);
      builder.server('room.updated', patch);
    },
    countdownStarted() {
      // §5: `launch.request` is owner-only, so a timeline that SENT one must have sent it as the
      // owner. A countdown the timeline simply arrives in was started by whoever owns the room,
      // which is a legitimate thing for a guest's client to receive — but somebody has to own it.
      const lastClient = [...steps].reverse().find((s) => s.dir === 'client' && s.kind === 'frame');
      if (lastClient && lastClient.frame.t === 'launch.request') {
        invariant(builder.me().isOwner, 'launch.request is owner-only (§5)');
      }
      invariant(room.roster.some((m) => m.isOwner), 'a countdown needs a room with an owner');
      invariant(readyCount() >= requiredReady(),
        `countdown needs ${requiredReady()} ready, roster has ${readyCount()}`);
      room.frozen = true;              // §6 rule 1: the roster freezes HERE, not at match.ready
      room.countdown = { endsAt: clock.plus(10000), requiredReady: requiredReady(), currentReady: readyCount() };
      builder.server('countdown.started', { ...room.countdown });
    },
    countdownAborted(reason, { byAccountId = undefined, clearReadiness, clearedReason = 'room-change' } = {}) {
      invariant(room.countdown, 'cannot abort a countdown that never started');
      const before = readyCount();
      room.countdown = null;
      room.frozen = false;
      builder.server('countdown.aborted', byAccountId === undefined ? { reason } : { reason, byAccountId });
      if (clearReadiness) builder.clearReady(clearedReason);
      else invariant(readyCount() === before, 'this abort must preserve readiness');
    },
    joinRefused(code) {
      invariant(room.frozen || room.roster.length >= room.core.capacity,
        'a join refusal needs a frozen or full room to be about');
      builder.error(code, 'That room is not accepting joins right now.');
    },
    assertThresholdHolds() {
      invariant(room.countdown && readyCount() >= room.countdown.requiredReady,
        `threshold broken: ${readyCount()} ready against ${room.countdown?.requiredReady}`);
    },
    matchReady() {
      invariant(room.frozen, 'match.ready without a frozen roster: the server sized it without them');
      builder.server('match.ready', fx.matchHandoff(fx.MATCH_ID, clock));
    },

    // ── transport-shaped steps ─────────────────────────────────────────────────────────────
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
      push('client', 'http', {
        method, path,
        status: envelope.error.code === 'RECONNECT_GRACE_EXPIRED' ? 409 : 400,
        body: envelope, ts: clock.now(),
      });
    },
  };

  entry.script(builder);

  let cursor = 0;
  return {
    scenario,
    steps: () => steps.slice(),
    next: () => (cursor < steps.length ? steps[cursor++] : null),
    reset() { cursor = 0; },
    /** Server frames only — what a reducer under test would actually consume. */
    serverFrames: () => steps.filter((s) => s.dir === 'server' && s.kind === 'frame').map((s) => s.frame),
    /** The room as the timeline left it, for assertions about where it ended up. */
    finalRoom: () => ({ ...room, roster: room.roster.map((m) => ({ ...m })) }),
  };
}
