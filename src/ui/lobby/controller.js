import { createUlid } from '../platform/ids.js';
import { createLobbyState, lobbySnapshot, reduceLobbyFrame } from './reducer.js';
import { LobbyProtocolError, validateLobbyFrame } from './validate.js';

const copy = (value) => value === undefined ? undefined : structuredClone(value);
const DEFAULT_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
});
const CLIENT_TYPES = new Set(['team.request', 'ready.set', 'loadout.set', 'launch.request',
  'chat.send', 'ping.send', 'mute.set', 'state.resync', 'heartbeat.ack', 'leave']);
const PING_KINDS = new Set(['attack-a', 'attack-b', 'defend-a', 'defend-b', 'regroup', 'enemy-spotted']);
const CLOSE_ERRORS = Object.freeze({
  4001: 'SESSION_TOKEN_INVALID', 4002: 'SLOT_RESERVATION_EXPIRED', 4003: 'ROOM_NOT_FOUND',
  4004: 'ROOM_FULL', 4005: 'SANCTIONED', 4006: 'ROOM_REMOVED', 4007: 'ROOM_CLOSED',
  4008: 'AUTH_SESSION_REPLACED', 4009: 'RECONNECT_GRACE_EXPIRED', 4010: 'PROTOCOL_VERSION_MISMATCH',
});
const UTC_MILLIS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isUtcMillis = (value) => {
  if (typeof value !== 'string' || !UTC_MILLIS_RE.test(value)) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value;
};

function socketUrl(base, lastSeq = null) {
  const url = new URL(base, globalThis.location?.href || 'http://localhost/');
  if (Number.isInteger(lastSeq) && lastSeq >= 0) url.searchParams.set('lastSeq', String(lastSeq));
  return url.toString();
}

function socketProtocols(ticket) {
  return ['overstrike-lobby-v1', `overstrike-ticket.${ticket}`];
}

function secureSocketProtocol(value) {
  const url = new URL(value, globalThis.location?.href || 'http://localhost/');
  if (url.protocol === 'wss:') return true;
  return url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}

function validateTicket(ticket, { requireGraceEndsAt = false } = {}) {
  if (!ticket || typeof ticket !== 'object'
    || typeof ticket.lobbySocketUrl !== 'string' || !ticket.lobbySocketUrl
    || typeof ticket.lobbyTicket !== 'string' || !ticket.lobbyTicket
    || !isUtcMillis(ticket.expiresAt)
    || (requireGraceEndsAt && ticket.graceEndsAt === undefined)
    || (ticket.graceEndsAt !== undefined
      && !isUtcMillis(ticket.graceEndsAt))) {
    throw new TypeError('A valid lobby socket URL, ticket, and expiry are required.');
  }
  if (!secureSocketProtocol(ticket.lobbySocketUrl)) throw new TypeError('Lobby socket URL must use wss (except loopback development).');
  return ticket;
}

function validateIntent(t, d) {
  if (!CLIENT_TYPES.has(t) || !d || typeof d !== 'object' || Array.isArray(d)) throw new TypeError('Invalid lobby intent.');
  const keys = Object.keys(d);
  if (t === 'team.request' && (keys.length !== 1 || !['alpha', 'bravo', 'auto'].includes(d.team))) throw new TypeError('team.request requires alpha, bravo, or auto.');
  if (t === 'ready.set' && (keys.length !== 1 || typeof d.ready !== 'boolean')) throw new TypeError('ready.set requires a boolean.');
  if (t === 'loadout.set' && (keys.length !== 2 || !Number.isInteger(d.primaryIdx) || d.primaryIdx < 0 || !Number.isInteger(d.secondaryIdx) || d.secondaryIdx < 0)) throw new TypeError('loadout.set requires non-negative indices.');
  if (t === 'chat.send' && (keys.length !== 1 || typeof d.text !== 'string' || d.text.length < 1 || d.text.length > 200)) throw new TypeError('chat.send requires 1–200 characters.');
  if (t === 'ping.send' && (!keys.includes('kind') || !PING_KINDS.has(d.kind) || keys.some((key) => !['kind', 'target'].includes(key)))) throw new TypeError('ping.send requires a catalog kind and optional target.');
  if (t === 'ping.send' && Object.hasOwn(d, 'target')) {
    const target = d.target;
    const validSite = target && typeof target === 'object' && !Array.isArray(target)
      && Object.keys(target).length === 2 && target.kind === 'site' && ['A', 'B'].includes(target.site);
    const validWorld = target && typeof target === 'object' && !Array.isArray(target)
      && Object.keys(target).length === 4 && target.kind === 'world'
      && ['x', 'y', 'z'].every((key) => Number.isFinite(target[key]) && Math.abs(target[key]) <= 1000);
    if (!validSite && !validWorld) throw new TypeError('ping.send target must be a site or bounded world coordinate.');
  }
  if (t === 'mute.set' && (keys.length !== 2 || typeof d.accountId !== 'string'
    || !d.accountId || typeof d.muted !== 'boolean')) throw new TypeError('mute.set requires an accountId and boolean.');
  if (t === 'state.resync' && (keys.length !== 1 || !Number.isInteger(d.lastSeq) || d.lastSeq < 0)) throw new TypeError('state.resync requires a non-negative lastSeq.');
  if (['launch.request', 'heartbeat.ack', 'leave'].includes(t) && keys.length !== 0) throw new TypeError(`${t} requires an empty payload.`);
}

export function createLobbyController({
  roomId = null,
  webSocketFactory = (url) => new WebSocket(url),
  reconnectTicket = null,
  reportAdapter = null,
  createCorrelationId = createUlid,
  clock = DEFAULT_CLOCK,
  random = Math.random,
  maxReconnectAttempts = 5,
  reconnectBaseMs = 1000,
  reconnectCapMs = 15000,
  syncTimeoutMs = 10000,
} = {}) {
  let state = createLobbyState(roomId);
  let socket = null;
  let reconnectTimer = null;
  let socketTimer = null;
  let heartbeatTimer = null;
  let reconnectGeneration = 0;
  let destroyed = false;
  let welcomeWaiter = null;
  let runReconnectAttempt = null;
  let resyncCorrelationId = null;
  const listeners = new Set();
  const deliberateSockets = new WeakSet();
  const confirmationWaiters = new Map();

  const emit = () => {
    if (destroyed) return;
    const snapshot = lobbySnapshot(state);
    for (const listener of listeners) listener(snapshot);
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) clock.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const clearSocketTimer = () => {
    if (socketTimer !== null) clock.clearTimeout(socketTimer);
    socketTimer = null;
  };

  const clearHeartbeatTimer = () => {
    if (heartbeatTimer !== null) clock.clearTimeout(heartbeatTimer);
    heartbeatTimer = null;
  };

  const armHeartbeatWatchdog = () => {
    clearHeartbeatTimer();
    if (!Number.isInteger(state.heartbeatMs) || state.heartbeatMs <= 0 || !socket) return;
    const watchedSocket = socket;
    heartbeatTimer = clock.setTimeout(() => {
      heartbeatTimer = null;
      if (socket === watchedSocket && watchedSocket.readyState === 1) {
        watchedSocket.close?.(4000, 'two lobby heartbeats missed');
      }
    }, state.heartbeatMs * 2);
  };

  const finishWelcome = (error = null) => {
    if (!welcomeWaiter) return;
    const waiter = welcomeWaiter;
    welcomeWaiter = null;
    if (error) waiter.reject(error);
    else waiter.resolve(lobbySnapshot(state));
  };

  const finishConfirmation = (correlationId, error = null, value = null) => {
    const waiter = confirmationWaiters.get(correlationId);
    if (error && state.pending[correlationId]) delete state.pending[correlationId];
    if (!waiter) return false;
    confirmationWaiters.delete(correlationId);
    clock.clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve(value || { correlationId, snapshot: lobbySnapshot(state) });
    return true;
  };

  const failConfirmations = (error) => {
    for (const correlationId of [...confirmationWaiters.keys()]) {
      finishConfirmation(correlationId, error);
    }
  };

  function send(t, d, { correlationId = createCorrelationId(), pending = false,
    traceparent = null } = {}) {
    validateIntent(t, d);
    if (typeof correlationId !== 'string' || !correlationId) throw new TypeError('Lobby correlationId is required.');
    if (!socket || socket.readyState !== 1) throw new Error('Lobby socket is not open.');
    const trace = traceparent || (() => {
      const bytes = new Uint8Array(24);
      globalThis.crypto?.getRandomValues?.(bytes);
      // Environments without Web Crypto are test-only; the non-zero fallback is still a valid
      // W3C envelope and correlation remains the durable join key.
      if (!bytes.some(Boolean)) bytes.fill(1);
      const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
      return `00-${hex.slice(0, 32)}-${hex.slice(32)}-01`;
    })();
    const frame = { t, correlationId, traceparent: trace, d: copy(d) };
    socket.send(JSON.stringify(frame));
    if (pending) {
      state.pending[correlationId] = { t, d: copy(d), accountId: state.you?.accountId || null };
      emit();
    }
    return correlationId;
  }

  function receive(event, sourceSocket) {
    if (socket !== sourceSocket) return;
    let frame;
    try {
      frame = typeof event.data === 'string' ? JSON.parse(event.data) : JSON.parse(String(event.data));
      if (!frame || typeof frame !== 'object') throw new Error('not an object');
    } catch (error) {
      const protocolError = new LobbyProtocolError('Lobby sent invalid JSON.', { cause: error?.message });
      state.status = 'failed'; state.failure = { code: protocolError.code, message: protocolError.message };
      failConfirmations(Object.assign(new Error('Lobby protocol failed before confirmation.'), { code: 'CLIENT_PROTOCOL' }));
      emit(); finishWelcome(protocolError); deliberateSockets.add(sourceSocket); sourceSocket.close?.(1002, 'invalid frame'); return;
    }

    // Unknown additive types are ignored, but envelope sequencing still cannot be trusted until
    // its common fields validate in reduceLobbyFrame.
    try {
      validateLobbyFrame(frame);
      const snapshotType = frame.t === 'lobby.welcome' || frame.t === 'state.snapshot';
      if (state.lastSeq === null && frame.t !== 'lobby.welcome') {
        throw new LobbyProtocolError('lobby.welcome must be the first server frame.');
      }
      if (frame.t === 'lobby.welcome' && state.lastSeq !== null) {
        throw new LobbyProtocolError('lobby.welcome may only be sent once.');
      }
      if (frame.t === 'state.snapshot' && state.status !== 'resyncing') {
        throw new LobbyProtocolError('An unsolicited state.snapshot is not permitted.');
      }
      if (frame.t === 'state.snapshot' && frame.correlationId !== resyncCorrelationId) {
        throw new LobbyProtocolError('state.snapshot did not echo the outstanding resync correlation.');
      }
      // A heartbeat is transport liveness, even when its sequence exposes a state gap.
      // Acknowledge it and refresh the watchdog before any gap/resync early return, but
      // never merge its sequence while a snapshot replacement is required.
      if (frame.t === 'heartbeat') {
        send('heartbeat.ack', {}, { correlationId: createCorrelationId() });
        armHeartbeatWatchdog();
      }
      if (!snapshotType && state.lastSeq !== null) {
        if (frame.seq <= state.lastSeq) return; // duplicate/reorder already incorporated
        if (frame.seq !== state.lastSeq + 1) {
          if (state.status !== 'resyncing') {
            state.status = 'resyncing';
            resyncCorrelationId = send('state.resync', { lastSeq: state.lastSeq });
            emit();
          }
          return;
        }
        if (state.status === 'resyncing') return;
      }
      const outstandingBeforeSnapshot = frame.t === 'state.snapshot'
        ? [...confirmationWaiters.keys()] : [];
      const result = reduceLobbyFrame(state, frame);
      if (frame.t === 'state.snapshot') resyncCorrelationId = null;
      if (frame.t === 'state.snapshot') {
        const error = Object.assign(new Error('The authoritative lobby snapshot replaced an unconfirmed request.'), {
          code: 'CLIENT_NETWORK', correlationId: frame.correlationId,
        });
        for (const correlationId of outstandingBeforeSnapshot) finishConfirmation(correlationId, error);
      }
      if (result.error) {
        const error = Object.assign(new Error(result.error.message || result.error.code), result.error);
        finishConfirmation(frame.correlationId, error);
      } else if (result.confirmed) {
        finishConfirmation(frame.correlationId, null, { correlationId: frame.correlationId, snapshot: lobbySnapshot(state) });
      }
      if (result.snapshot) {
        clearSocketTimer();
        state.reconnect = null;
        runReconnectAttempt = null;
        finishWelcome();
      }
      if (result.snapshot) armHeartbeatWatchdog();
      emit();
    } catch (error) {
      state.status = 'failed';
      state.failure = { code: error?.code || 'CLIENT_PROTOCOL', message: error?.message || 'Invalid lobby frame.' };
      failConfirmations(Object.assign(new Error('Lobby protocol failed before confirmation.'), { code: 'CLIENT_PROTOCOL' }));
      emit(); finishWelcome(error); deliberateSockets.add(sourceSocket); sourceSocket.close?.(1002, 'protocol error');
    }
  }

  function reconnectFailed(error, generation) {
    if (generation !== reconnectGeneration || destroyed || !state.reconnect) return;
    const attempted = state.reconnect.attempt;
    const terminal = error?.code === 'RECONNECT_GRACE_EXPIRED' || attempted >= maxReconnectAttempts;
    if (terminal) {
      state.status = 'closed';
      state.failure = { code: error?.code || 'CLIENT_NETWORK', message: error?.message || 'Lobby reconnect failed.' };
      state.reconnect = null;
      runReconnectAttempt = null;
      emit();
      return;
    }
    const delay = reconnectDelay(attempted + 1);
    state.reconnect.nextAttemptAt = new Date(clock.now() + delay).toISOString();
    emit();
    reconnectTimer = clock.setTimeout(() => {
      reconnectTimer = null;
      void runReconnectAttempt?.();
    }, delay);
  }

  function attach(ticket, { reconnect = false, generation = reconnectGeneration } = {}) {
    validateTicket(ticket, { requireGraceEndsAt: reconnect });
    if (Date.parse(ticket.expiresAt) <= clock.now()) throw new Error('Lobby ticket expired before use.');
    state.status = reconnect ? 'reconnecting' : 'connecting';
    emit();
    socket = webSocketFactory(socketUrl(ticket.lobbySocketUrl,
      reconnect ? state.lastSeq : null), socketProtocols(ticket.lobbyTicket));
    const attachedSocket = socket;
    socketTimer = clock.setTimeout(() => {
      socketTimer = null;
      if (socket === attachedSocket && !['synchronized', 'countdown', 'allocating', 'handoff-ready'].includes(state.status)) {
        attachedSocket.close?.(4000, reconnect ? 'state resync timeout' : 'lobby welcome timeout');
      }
    }, syncTimeoutMs);
    socket.addEventListener('open', () => {
      if (reconnect && state.lastSeq !== null) {
        state.status = 'resyncing';
        resyncCorrelationId = send('state.resync', { lastSeq: state.lastSeq });
        emit();
      }
    });
    socket.addEventListener('message', (event) => receive(event, attachedSocket));
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', (event) => {
      clearSocketTimer();
      clearHeartbeatTimer();
      const wasDeliberate = deliberateSockets.has(attachedSocket);
      if (socket === attachedSocket) socket = null;
      if (destroyed || wasDeliberate) return;
      if (socket !== null) return;
      failConfirmations(Object.assign(new Error('Lobby connection closed before confirmation.'), { code: 'CLIENT_NETWORK' }));
      finishWelcome(new Error('Lobby socket closed before synchronization.'));
      if (reconnect && state.reconnect) {
        reconnectFailed(Object.assign(new Error(event?.reason || 'Lobby reconnect socket closed.'), {
          code: CLOSE_ERRORS[event?.code] || 'CLIENT_NETWORK',
        }), generation);
      } else beginReconnect(event);
    });
  }

  function reconnectDelay(attempt) {
    const base = Math.min(reconnectCapMs, reconnectBaseMs * (2 ** Math.max(0, attempt - 1)));
    return Math.max(0, Math.round(base * (0.8 + random() * 0.4)));
  }

  function beginReconnect(closeEvent = null) {
    if (typeof reconnectTicket !== 'function' || !state.roomId) {
      state.status = 'closed';
      state.failure = { code: 'CLIENT_NETWORK', message: closeEvent?.reason || 'Lobby connection closed.' };
      emit();
      return;
    }
    const generation = ++reconnectGeneration;
    state.status = 'reconnecting';
    state.reconnect = { attempt: 0, maxAttempts: maxReconnectAttempts, canCancel: true, graceEndsAt: null, nextAttemptAt: null };
    emit();

    runReconnectAttempt = async () => {
      if (destroyed || generation !== reconnectGeneration) return;
      const next = state.reconnect.attempt + 1;
      state.reconnect.attempt = next;
      state.reconnect.nextAttemptAt = null;
      emit();
      try {
        const ticket = validateTicket(await reconnectTicket({ roomId: state.roomId, attempt: next }), {
          requireGraceEndsAt: true,
        });
        if (ticket.graceEndsAt && Number.isFinite(Date.parse(ticket.graceEndsAt))) state.reconnect.graceEndsAt = ticket.graceEndsAt;
        if (state.reconnect.graceEndsAt && Date.parse(state.reconnect.graceEndsAt) <= clock.now()) throw Object.assign(new Error('Reconnect grace expired.'), { code: 'RECONNECT_GRACE_EXPIRED' });
        attach(ticket, { reconnect: true, generation });
        return;
      } catch (error) {
        reconnectFailed(error, generation);
      }
    };
    const initialDelay = reconnectDelay(1);
    state.reconnect.nextAttemptAt = new Date(clock.now() + initialDelay).toISOString();
    emit();
    reconnectTimer = clock.setTimeout(() => {
      reconnectTimer = null;
      void runReconnectAttempt?.();
    }, initialDelay);
  }

  const controller = {
    getSnapshot: () => lobbySnapshot(state),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    waitForCorrelation(correlationId, timeoutMs = syncTimeoutMs) {
      if (typeof correlationId !== 'string' || !correlationId) return Promise.reject(new TypeError('correlationId is required.'));
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new TypeError('timeoutMs must be positive.'));
      if (confirmationWaiters.has(correlationId)) return confirmationWaiters.get(correlationId).promise;
      let resolvePromise;
      let rejectPromise;
      const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
      const timer = clock.setTimeout(() => {
        const error = Object.assign(new Error('The lobby did not confirm the request in time.'), { code: 'CLIENT_TIMEOUT', correlationId });
        finishConfirmation(correlationId, error);
        state.failure = { code: error.code, message: `${error.message} The outcome is unknown; synchronizing authoritative state.` };
        if (socket?.readyState === 1 && state.lastSeq !== null && state.status !== 'resyncing') {
          state.status = 'resyncing';
          resyncCorrelationId = send('state.resync', { lastSeq: state.lastSeq });
        }
        emit();
      }, timeoutMs);
      confirmationWaiters.set(correlationId, { promise, resolve: resolvePromise, reject: rejectPromise, timer });
      return promise;
    },
    connect(ticket) {
      if (destroyed) return Promise.reject(new Error('Lobby controller is destroyed.'));
      if (welcomeWaiter) return welcomeWaiter.promise;
      if (socket && socket.readyState < 2) return Promise.reject(new Error('Lobby controller is already connected.'));
      if (state.lastSeq !== null) return Promise.reject(new Error('Create a new lobby controller for a new initial connection.'));
      const promise = new Promise((resolve, reject) => { welcomeWaiter = { resolve, reject, promise: null }; });
      welcomeWaiter.promise = promise;
      try { attach(ticket); } catch (error) {
        state.status = 'failed';
        state.failure = { code: error?.code || 'CLIENT_CONFIGURATION', message: error?.message || 'Lobby connection failed.' };
        emit();
        finishWelcome(error);
      }
      return promise;
    },
    requestTeam(team) { return send('team.request', { team }, { pending: true }); },
    setReady(ready) { return send('ready.set', { ready }, { pending: true }); },
    setLoadout(loadout) { return send('loadout.set', loadout, { pending: true }); },
    requestLaunch() { return send('launch.request', {}, { pending: true }); },
    sendChat(text) { return send('chat.send', { text }, { pending: true }); },
    sendPing(kind, target) { return send('ping.send', target === undefined ? { kind } : { kind, target }, { pending: true }); },
    leave() { return send('leave', {}); },
    setMuted(accountId, muted = true) {
      if (typeof accountId !== 'string' || !accountId) throw new TypeError('accountId is required.');
      return send('mute.set', { accountId, muted }, { pending: true });
    },
    reportPlayer(payload = {}) {
      if (typeof reportAdapter !== 'function') return Promise.reject(new Error('Player reporting is unavailable.'));
      if (typeof payload.subjectAccountId !== 'string' || !payload.subjectAccountId
        || !['cheating', 'harassment', 'offensive-name', 'griefing', 'other'].includes(payload.category)
        || (payload.matchId !== undefined && (typeof payload.matchId !== 'string' || !payload.matchId))
        || (payload.chatMessageId !== undefined
          && (typeof payload.chatMessageId !== 'string' || !payload.chatMessageId))
        || (payload.description !== undefined && typeof payload.description !== 'string')) {
        return Promise.reject(new TypeError('Invalid player report.'));
      }
      const body = {
        subjectAccountId: payload.subjectAccountId,
        category: payload.category,
      };
      if (payload.matchId !== undefined) body.matchId = payload.matchId;
      if (payload.chatMessageId !== undefined) body.chatMessageId = payload.chatMessageId;
      if (payload.description !== undefined) body.description = payload.description;
      return Promise.resolve(reportAdapter(body));
    },
    cancelReconnect() {
      if (!['reconnecting', 'resyncing'].includes(state.status) || !state.reconnect) return false;
      reconnectGeneration += 1;
      clearReconnectTimer();
      clearSocketTimer();
      clearHeartbeatTimer();
      runReconnectAttempt = null;
      if (socket) deliberateSockets.add(socket);
      socket?.close?.(1000, 'reconnect cancelled');
      socket = null;
      state.status = 'closed'; state.reconnect = null;
      state.failure = { code: 'CLIENT_CANCELLED', message: 'Lobby reconnect cancelled.' };
      failConfirmations(Object.assign(new Error('Lobby reconnect was cancelled before confirmation.'), { code: 'CLIENT_CANCELLED' }));
      emit(); return true;
    },
    disconnect(reason = 'client disconnect') {
      reconnectGeneration += 1; clearReconnectTimer();
      clearSocketTimer();
      clearHeartbeatTimer();
      runReconnectAttempt = null;
      if (socket) deliberateSockets.add(socket);
      socket?.close?.(1000, reason); socket = null;
      state.status = 'closed'; state.reconnect = null; emit();
      failConfirmations(Object.assign(new Error('Lobby connection closed before confirmation.'), { code: 'CLIENT_NETWORK' }));
    },
    destroy() {
      if (destroyed) return;
      controller.disconnect('destroyed');
      destroyed = true; listeners.clear(); finishWelcome(new Error('Lobby controller destroyed.'));
    },
  };
  return Object.freeze(controller);
}
