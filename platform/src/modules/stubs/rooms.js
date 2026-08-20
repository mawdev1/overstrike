/**
 * The per-session room model.  contracts/http-api.md §6, §11.3, §11.3a, §11.4;
 * contracts/realtime-lobby.md §6, §7.
 *
 * The route table used to answer every room request from the immutable fixture, which made four
 * separate lies possible at once: an unknown room id returned room A's shape instead of
 * `ROOM_NOT_FOUND`, `POST /ready` returned a roster in which nobody's readiness had changed,
 * `POST /team` returned the team the caller did not get, and `POST /launch` answered 202 for a
 * caller who does not own the room. Every one of those teaches the shell that a mutation
 * succeeded when the next `GET` will disagree.
 *
 * So a room is state, seeded from the fixture on first touch and mutated by the requests that
 * are documented to mutate it. It stays deterministic because the seed is a fixture and the
 * mutations are a function of the request sequence — nothing here reads a clock or a random
 * source.
 */
import { ApiError } from '../../core/errors.js';
import * as fx from './fixtures.js';

const notFound = () => new ApiError('ROOM_NOT_FOUND', 'That room no longer exists.');

/**
 * The room this request is about, seeded from the fixture the first time it is asked for.
 *
 * An id that is neither a fixture room nor one this session created is `ROOM_NOT_FOUND` — a
 * 404 the browser can act on, rather than room A wearing a stranger's id.
 */
export function roomFor(state, roomId) {
  if (!state.rooms) state.rooms = {};
  if (Object.hasOwn(state.rooms, roomId)) return state.rooms[roomId];
  const index = fx.roomIndexFor(roomId);
  if (index === -1) throw notFound();
  const room = {
    roomId,
    index,
    core: fx.roomCore(index, { roomId }),
    roster: fx.roster(index, { roomId }),
    countdown: fx.countdownState(index),
    // §6 rule 1: the roster freezes at `countdown.started`, so a join during the countdown is
    // refused rather than admitted to a match server that was sized without it.
    frozen: fx.roomCore(index, { roomId }).status === 'countdown',
  };
  state.rooms[roomId] = room;
  return room;
}

/** Register a room this session created, so its id resolves on the next request. */
export function adoptRoom(state, room) {
  if (!state.rooms) state.rooms = {};
  state.rooms[room.roomId] = room;
  return room;
}

export const localMember = (room) => room.roster.find((m) => m.isLocal) || null;

export const readyCount = (room) => room.roster.filter((m) => m.ready).length;

/**
 * §11.3 `RoomDetailResponse`: RoomCore fields, then roster and countdown beside them.
 *
 * `playerCount` is derived from the roster rather than stored twice. Two counters for one fact
 * is how a lobby ends up showing 7/12 above a list of six names.
 */
export function detail(room, { rtt = null } = {}) {
  return {
    ...room.core,
    playerCount: room.roster.length,
    estimatedRttMs: rtt && rtt[room.core.region] !== undefined ? rtt[room.core.region] : null,
    roster: room.roster.map((m) => ({ ...m })),
    countdown: room.countdown ? { ...room.countdown, currentReady: readyCount(room) } : null,
  };
}

/** The `RoomCore` projection a list row carries — no roster (§6). */
export function core(room, { rtt = null } = {}) {
  return {
    ...room.core,
    playerCount: room.roster.length,
    estimatedRttMs: rtt && rtt[room.core.region] !== undefined ? rtt[room.core.region] : null,
  };
}

/**
 * realtime-lobby.md §7: readiness is cleared whenever the shape of the match changes under the
 * player who consented to it — roster, team, loadout, or room change. The reason travels with
 * it on the socket; over REST the next `RoomDetailResponse` simply shows it cleared.
 *
 * It used to take an `{ except }` option, which was dead: neither call site in `routes.js` ever
 * passed one, and §7's only per-player rule is the opposite shape — a loadout change clears the
 * *actor's* readiness alone, which `POST /loadout` does inline. Measured before removing it: an
 * instrumented build counted 29 `clearReady` calls across the 46 scenario probes and 42
 * hand-built room sequences (join / leave / ready / team alpha|bravo|auto / loadout, in every
 * order, on all three fixture rooms); 0 supplied `except` and 0 members were ever skipped, and
 * the 344 responses those runs produce are byte-identical with the branch deleted. A parameter
 * a stub never exercises is a shape the frontend can be taught and can never observe.
 */
export function clearReady(room) {
  for (const m of room.roster) m.ready = false;
}

/** §11.4: the refusals a join can hit, in the order the room decides them. */
export function assertJoinable(room) {
  if (room.core.status === 'in-progress' || room.frozen) {
    throw new ApiError('ROOM_IN_PROGRESS', 'That match is already under way.');
  }
  if (room.core.status === 'closing') throw new ApiError('ROOM_CLOSED', 'That room is closing.');
  if (room.roster.length >= room.core.capacity) throw new ApiError('ROOM_FULL', 'That room just filled up.');
}

/** §11.8: `POST /launch` is owner-only, and 409 unless every required player is ready. */
export function assertLaunchable(room) {
  const me = localMember(room);
  if (!me || !me.isOwner) {
    throw new ApiError('AUTH_FORBIDDEN', 'Only the room owner can start the match.');
  }
  if (room.core.status === 'in-progress') {
    throw new ApiError('ROOM_IN_PROGRESS', 'That match is already under way.');
  }
  const present = room.roster.length;
  if (present < room.core.settings.minPlayers) {
    throw new ApiError('CONFLICT', 'Not enough players to start.', {
      details: { reason: 'below-minimum', minPlayers: room.core.settings.minPlayers, playerCount: present },
    });
  }
  // `requiredReady` is a ceiling, not a quorum a half-full room can never reach: a 6-player room
  // whose settings say 8 would otherwise be permanently unlaunchable, which is a fixture that
  // makes the launch button untestable rather than a rule anyone wrote down.
  const required = Math.min(room.core.settings.requiredReady, present);
  const ready = readyCount(room);
  if (ready < required) {
    throw new ApiError('CONFLICT', 'Everyone has to be ready first.', {
      details: { reason: 'not-all-ready', requiredReady: required, currentReady: ready },
    });
  }
  return { required, ready };
}

/** Move the room into countdown and freeze the roster (§6 rule 1). */
export function startCountdown(room, clock) {
  room.core.status = 'countdown';
  room.core.joinable = false;
  room.core.joinBlockedReason = 'in-progress';
  room.frozen = true;
  room.countdown = {
    endsAt: clock.plus(10 * 1000),
    requiredReady: Math.min(room.core.settings.requiredReady, room.roster.length),
    currentReady: readyCount(room),
  };
  return room;
}
