import {
  LobbyProtocolError,
  validateLobbyFrame,
  validateRoomCore,
  validateRosterProjection,
} from './validate.js';

const copy = (value) => value === undefined ? undefined : structuredClone(value);

export function createLobbyState(roomId = null) {
  return {
    status: 'idle', roomId, protocol: null, lastSeq: null,
    serverTime: null, heartbeatMs: null, graceMs: null,
    you: null, room: null, roster: [], presence: {}, countdown: null,
    chatHistory: [], mutedAccountIds: [], pending: {},
    countdownRemainingMs: null, handoff: null, failure: null,
    reconnect: null, notice: null,
  };
}

function pendingFor(state, correlationId) {
  return correlationId && state.pending[correlationId] ? state.pending[correlationId] : null;
}

function settle(state, correlationId, outcome = null, clearFailure = true) {
  const pending = pendingFor(state, correlationId);
  if (!pending) return null;
  delete state.pending[correlationId];
  if (clearFailure) state.failure = null;
  if (outcome) state.notice = outcome;
  return pending;
}

function settleWhen(state, correlationId, predicate, outcome = null) {
  const pending = pendingFor(state, correlationId);
  if (!pending || !predicate(pending)) return null;
  return settle(state, correlationId, outcome);
}

function replaceSnapshot(state, d, seq) {
  state.protocol = d.protocol;
  state.lastSeq = seq;
  state.serverTime = d.serverTime;
  state.heartbeatMs = d.heartbeatMs;
  state.graceMs = d.graceMs;
  state.you = copy(d.you);
  state.room = copy(d.room);
  state.roomId = d.room.roomId;
  state.roster = copy(d.roster);
  state.countdown = copy(d.countdown);
  state.countdownRemainingMs = null;
  state.chatHistory = copy(d.chatHistory);
  state.pending = {};
  state.failure = null;
  state.notice = null;
  state.status = 'synchronized';
}

function member(state, accountId) {
  return state.roster.find((item) => item.accountId === accountId) || null;
}

/** Pure known-frame reducer. Sequence gap policy is owned by controller.js. */
export function reduceLobbyFrame(state, rawFrame) {
  const { known, frame } = validateLobbyFrame(rawFrame);
  if (!known) {
    state.lastSeq = frame.seq;
    return { state, ignored: true };
  }
  const d = frame.d;
  if (frame.t === 'lobby.welcome' || frame.t === 'state.snapshot') {
    replaceSnapshot(state, d, frame.seq);
    return { state, snapshot: true };
  }
  state.lastSeq = frame.seq;
  switch (frame.t) {
    case 'roster.delta': {
      const existing = new Set(state.roster.map((item) => item.accountId));
      const added = new Set(d.added.map((item) => item.accountId));
      const updated = new Set(d.updated.map((item) => item.accountId));
      const removedIds = new Set(d.removed);
      if (added.size !== d.added.length || updated.size !== d.updated.length || removedIds.size !== d.removed.length
        || [...added].some((id) => existing.has(id) || updated.has(id) || removedIds.has(id))
        || [...updated].some((id) => !existing.has(id) || removedIds.has(id))
        || [...removedIds].some((id) => !existing.has(id))) {
        throw new LobbyProtocolError('roster.delta does not match the authoritative roster.');
      }
      const removed = new Set(d.removed);
      const nextRoster = state.roster.filter((item) => !removed.has(item.accountId)).map(copy);
      for (const item of [...d.added, ...d.updated]) {
        const index = nextRoster.findIndex((memberItem) => memberItem.accountId === item.accountId);
        if (index >= 0) nextRoster[index] = copy(item);
        else nextRoster.push(copy(item));
      }
      const nextRoom = { ...state.room, playerCount: nextRoster.length };
      const nextYou = copy(state.you);
      const nextSelf = nextRoster.find((item) => item.accountId === nextYou?.accountId);
      if (nextSelf) {
        nextYou.team = nextSelf.team;
        nextYou.ready = nextSelf.ready;
        nextYou.isOwner = nextSelf.isOwner;
      }
      validateRosterProjection({ you: nextYou, room: nextRoom, roster: nextRoster }, 'roster.delta.result');
      state.roster = nextRoster;
      state.room = nextRoom;
      state.you = nextYou;
      const confirmed = settleWhen(state, frame.correlationId, (pending) => {
        if (pending.t !== 'loadout.set' || pending.accountId !== state.you?.accountId) return false;
        const local = d.updated.find((item) => item.accountId === pending.accountId);
        return local?.loadout?.primaryIdx === pending.d.primaryIdx
          && local?.loadout?.secondaryIdx === pending.d.secondaryIdx;
      });
      if (confirmed) return { state, confirmed };
      break;
    }
    case 'presence.delta': state.presence[d.accountId] = copy(d); break;
    case 'room.updated': {
      const merged = { ...state.room, ...copy(d) };
      validateRoomCore(merged, 'room.updated.merged');
      state.room = merged;
      break;
    }
    case 'team.changed': {
      const target = member(state, d.accountId);
      if (!target) throw new LobbyProtocolError('team.changed names an unknown roster member.');
      target.team = d.team;
      if (state.you?.accountId === d.accountId) state.you.team = d.team;
      const confirmed = settleWhen(state, frame.correlationId, (pending) => pending.t === 'team.request'
        && pending.accountId === d.accountId
        && (pending.d.team === 'auto' || pending.d.team === d.team),
      d.byServer ? 'The server balanced the team assignment.' : null);
      if (confirmed) return { state, confirmed };
      break;
    }
    case 'ready.changed': {
      const target = member(state, d.accountId);
      if (!target) throw new LobbyProtocolError('ready.changed names an unknown roster member.');
      target.ready = d.ready;
      if (state.you?.accountId === d.accountId) state.you.ready = d.ready;
      const reason = d.clearedReason ? `Ready was cleared: ${d.clearedReason}.` : null;
      const confirmed = settleWhen(state, frame.correlationId, (pending) => pending.t === 'ready.set'
        && pending.accountId === d.accountId && pending.d.ready === d.ready, reason);
      if (!confirmed && reason) state.notice = reason;
      if (confirmed) return { state, confirmed };
      break;
    }
    case 'countdown.started': {
      const readyCount = state.roster.filter((item) => item.ready).length;
      if (d.currentReady !== readyCount || d.requiredReady > state.roster.length
        || d.currentReady < d.requiredReady) {
        throw new LobbyProtocolError('countdown.started contradicts the authoritative ready roster.');
      }
      state.countdown = copy(d); state.countdownRemainingMs = null; state.status = 'countdown';
      const confirmed = settleWhen(state, frame.correlationId, (pending) => pending.t === 'launch.request');
      if (confirmed) return { state, confirmed };
      break;
    }
    case 'countdown.tick': state.countdownRemainingMs = d.remainingMs; break;
    case 'countdown.aborted':
      state.countdown = null; state.countdownRemainingMs = null; state.status = 'synchronized';
      state.notice = `Countdown aborted: ${d.reason}.`; break;
    case 'match.allocating': state.status = 'allocating'; break;
    case 'match.ready': {
      for (const key of ['mapId', 'mapVersion', 'mode', 'rulesetVersion']) {
        if (d[key] !== state.room?.[key]) {
          throw new LobbyProtocolError(`match.ready ${key} contradicts immutable RoomCore.`);
        }
      }
      state.handoff = copy(d); state.status = 'handoff-ready'; break;
    }
    case 'match.failed': {
      const pending = settle(state, frame.correlationId, d.error.message || d.error.code, false);
      state.failure = copy(d.error); state.status = 'match-failed';
      return { state, error: d.error, reverted: pending };
    }
    case 'chat.message':
      if (!state.mutedAccountIds.includes(d.accountId)) {
        state.chatHistory.push(copy(d));
        while (state.chatHistory.length > 50) state.chatHistory.shift();
      }
      const confirmed = settleWhen(state, frame.correlationId, (pending) => pending.t === 'chat.send'
        && pending.accountId === d.accountId);
      if (confirmed) return { state, confirmed };
      break;
    case 'chat.removed': state.chatHistory = state.chatHistory.filter((item) => item.id !== d.id); break;
    case 'ping.placed': {
      const confirmed = settleWhen(state, frame.correlationId, (pending) => pending.t === 'ping.send'
        && pending.accountId === d.accountId && pending.d.kind === d.kind);
      if (confirmed) return { state, confirmed };
      break;
    }
    case 'error': {
      const pending = settle(state, frame.correlationId, d.error.message || d.error.code, false);
      state.failure = copy(d.error);
      return { state, error: d.error, reverted: pending };
    }
    case 'heartbeat': state.serverTime = d.serverTime; break;
    default: break;
  }
  return { state };
}

export function lobbySnapshot(state) {
  const snapshot = copy(state);
  snapshot.optimistic = { team: null, ready: null, loadout: null };
  for (const request of Object.values(snapshot.pending)) {
    if (!snapshot.you || request.accountId !== snapshot.you.accountId) continue;
    if (request.t === 'team.request') {
      snapshot.optimistic.team = request.d.team;
    } else if (request.t === 'ready.set') {
      snapshot.optimistic.ready = request.d.ready;
    } else if (request.t === 'loadout.set') {
      snapshot.optimistic.loadout = copy(request.d);
    }
  }
  return Object.freeze(snapshot);
}
