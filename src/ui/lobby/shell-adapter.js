import { createLobbyController } from './controller.js';

function unavailable(message) {
  const error = new Error(message);
  error.code = 'CLIENT_UNAVAILABLE';
  return error;
}

function cancelled(message = 'Lobby join cancelled.') {
  const error = new Error(message);
  error.code = 'CLIENT_ABORTED';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelled();
}

function waitWithAbort(task, signal, onAbort) {
  if (!signal) return Promise.resolve(task);
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      try { onAbort?.(); } catch { /* Cancellation still rejects even if cleanup fails. */ }
      reject(cancelled());
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(task).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

function assertClient(client) {
  if (!client || typeof client !== 'object') throw new TypeError('A shell HTTP client is required.');
  for (const method of ['joinRoom', 'reconnectRoom']) {
    if (typeof client[method] !== 'function') throw new TypeError(`The shell HTTP client requires ${method}().`);
  }
}

function assertRoom(active, payload = {}) {
  if (!active?.controller) throw unavailable('No authoritative lobby connection is active.');
  if (payload.roomId && payload.roomId !== active.roomId) {
    throw unavailable('The requested room is not the active authoritative lobby.');
  }
  return active.controller;
}

/**
 * Adapts the shell's object-payload operations to the realtime lobby controller's exact
 * intent methods. HTTP remains responsible only for reservations, reconnect tickets and
 * reports. Every room projection returned here originates from a validated welcome/snapshot.
 */
export function createLobbyShellAdapter({
  client,
  createController = createLobbyController,
  webSocketFactory,
  reportAdapter = null,
  onSnapshot = null,
  onMatchReady = null,
} = {}) {
  assertClient(client);
  if (typeof createController !== 'function') throw new TypeError('createController must be a function.');

  const listeners = new Set();
  const connectionListeners = new Set();
  let active = null;
  let activation = null;
  let discovery = null;
  let generation = 0;
  let lastHandoffId = null;
  let lastVisualSignature = null;
  let connectionState = Object.freeze({ platform: 'unknown', lobby: 'disconnected', match: 'idle' });

  const setConnection = (patch) => {
    const next = Object.freeze({ ...connectionState, ...patch });
    if (JSON.stringify(next) === JSON.stringify(connectionState)) return;
    connectionState = next;
    for (const listener of connectionListeners) listener(next);
  };

  const visualSignature = (snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') return String(snapshot);
    const { serverTime: _serverTime, lastSeq: _lastSeq, heartbeatMs: _heartbeatMs, ...visual } = snapshot;
    return JSON.stringify(visual);
  };

  const socketFactory = webSocketFactory || ((url) => {
    if (typeof globalThis.WebSocket !== 'function') {
      throw unavailable('This browser does not provide WebSocket lobby transport.');
    }
    return new globalThis.WebSocket(url);
  });

  const publish = (snapshot, expectedGeneration) => {
    if (!active || active.generation !== expectedGeneration) return;
    setConnection({ platform: 'online', lobby: snapshot?.status || 'unknown',
      match: snapshot?.handoff ? 'ready' : 'idle' });
    // Presentation failures must never be reclassified by the controller as wire-protocol
    // failures. Each consumer is isolated from the validated transport/reducer boundary.
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* Consumer owns its rendering failure. */ }
    }
    const signature = visualSignature(snapshot);
    // A local intent already has a stable pending treatment owned by Shell.submit(). Replacing
    // the subtree for the synchronous controller emission would detach the submitting controls
    // and their status targets. Defer visual replacement until an exact terminal event clears
    // pending; unrelated authoritative frames remain in controller state and are rendered then.
    const hasPendingIntent = Object.keys(snapshot?.pending || {}).length > 0;
    if (!hasPendingIntent && signature !== lastVisualSignature) {
      lastVisualSignature = signature;
      try { onSnapshot?.(snapshot); } catch { /* Keep UI failure outside protocol handling. */ }
    }
    const handoffId = snapshot?.handoff?.matchId || null;
    if (handoffId && handoffId !== lastHandoffId) {
      lastHandoffId = handoffId;
      try { onMatchReady?.(snapshot.handoff, snapshot); } catch { /* Same boundary as above. */ }
    }
  };

  const deactivate = (reason = 'lobby replaced') => {
    generation += 1;
    activation = null;
    discovery = null;
    lastHandoffId = null;
    lastVisualSignature = null;
    const previous = active;
    active = null;
    previous?.unsubscribe?.();
    previous?.controller?.destroy?.(reason);
    setConnection({ lobby: 'disconnected', match: 'idle' });
  };

  const activate = async (roomId, ticket) => {
    if (typeof roomId !== 'string' || !roomId) throw new TypeError('roomId is required.');
    if (active?.roomId === roomId) {
      if (activation) return activation;
      const snapshot = active.controller.getSnapshot();
      if (!['closed', 'failed'].includes(snapshot.status)) return snapshot;
    }
    deactivate('switching lobby');
    const expectedGeneration = ++generation;
    const controller = createController({
      roomId,
      webSocketFactory: socketFactory,
      reconnectTicket: () => client.reconnectRoom({ roomId }),
      reportAdapter: (payload) => {
        const sendReport = reportAdapter || (typeof client.reportPlayer === 'function'
          ? (body) => client.reportPlayer(body) : null);
        if (typeof sendReport !== 'function') {
          throw unavailable('The platform report endpoint is not connected.');
        }
        return sendReport(payload);
      },
    });
    if (!controller || typeof controller.connect !== 'function'
      || typeof controller.subscribe !== 'function' || typeof controller.getSnapshot !== 'function') {
      throw new TypeError('createController returned an invalid lobby controller.');
    }
    const unsubscribe = controller.subscribe((snapshot) => publish(snapshot, expectedGeneration));
    active = { roomId, controller, unsubscribe, generation: expectedGeneration };
    activation = Promise.resolve(controller.connect(ticket))
      .then(() => {
        if (!active || active.generation !== expectedGeneration) {
          throw unavailable('Lobby connection was replaced before synchronization.');
        }
        return controller.getSnapshot();
      })
      .finally(() => {
        if (active?.generation === expectedGeneration) activation = null;
      });
    return activation;
  };

  const getLobbySnapshot = async (payload = {}) => {
    const roomId = payload.roomId;
    if (active?.roomId === roomId) {
      if (activation) return activation;
      const snapshot = active.controller.getSnapshot();
      if (!['closed', 'failed'].includes(snapshot.status)) return snapshot;
    }
    if (discovery?.roomId === roomId) return discovery.promise;
    if (discovery) deactivate('switching pending lobby');
    const expectedGeneration = generation;
    const promise = (async () => {
      const ticket = await client.reconnectRoom({ roomId });
      if (generation !== expectedGeneration) {
        throw unavailable('Lobby discovery was replaced before a ticket arrived.');
      }
      return activate(roomId, ticket);
    })().finally(() => {
      if (discovery?.promise === promise) discovery = null;
    });
    discovery = { roomId, promise };
    return promise;
  };

  const adapter = {
    ...client,
    connection: Object.freeze({
      getSnapshot: () => connectionState,
      subscribe(listener) { connectionListeners.add(listener); return () => connectionListeners.delete(listener); },
    }),
    async joinRoom(payload = {}) {
      const stage = (value) => {
        try { payload.onStage?.(value); } catch { /* Progress rendering cannot alter authority. */ }
      };
      let reservation;
      let attempt = 0;
      while (attempt < 2) {
        throwIfAborted(payload.signal);
        stage(attempt === 0 ? 'requesting-slot' : 'retrying-slot');
        try {
          reservation = await client.joinRoom(payload);
          break;
        } catch (error) {
          if (error?.code !== 'SLOT_RESERVATION_EXPIRED' || attempt !== 0 || payload.signal?.aborted) throw error;
          stage('reservation-expired');
          attempt += 1;
        }
      }
      throwIfAborted(payload.signal);
      stage('joining-room-channel');
      const synchronized = activate(payload.roomId, reservation);
      stage('synchronizing-roster');
      await waitWithAbort(synchronized, payload.signal, () => deactivate('join cancelled'));
      throwIfAborted(payload.signal);
      stage('ready');
      return reservation;
    },
    async createRoom(payload = {}) {
      if (typeof client.createRoom !== 'function') throw unavailable('The authoritative room create endpoint is unavailable.');
      const reservation = await client.createRoom(payload);
      const roomId = reservation?.room?.roomId;
      if (typeof roomId !== 'string' || !roomId) throw unavailable('The room create response did not identify its room.');
      await activate(roomId, reservation);
      return reservation;
    },
    getLobbySnapshot,
    getChatHistory: getLobbySnapshot,
    async getActiveMatch(payload = {}) {
      const snapshot = active?.controller.getSnapshot();
      if (snapshot?.handoff) {
        return {
          stage: 'Match handoff ready', handoff: snapshot.handoff,
          roomId: active.roomId, retryAllowed: false,
        };
      }
      if (typeof client.getActiveMatch === 'function') return client.getActiveMatch(payload);
      throw unavailable('No authoritative active-match handoff is available.');
    },
    setTeam(payload = {}) {
      const controller = assertRoom(active, payload);
      const correlationId = controller.requestTeam(payload.team);
      return controller.waitForCorrelation(correlationId);
    },
    setReady(payload = {}) {
      const controller = assertRoom(active, payload);
      const correlationId = controller.setReady(payload.ready);
      return controller.waitForCorrelation(correlationId);
    },
    setLoadout(payload = {}) {
      const controller = assertRoom(active, payload);
      const correlationId = controller.setLoadout({
        primaryIdx: payload.primaryIdx, secondaryIdx: payload.secondaryIdx,
      });
      return controller.waitForCorrelation(correlationId);
    },
    launchRoom(payload = {}) {
      const controller = assertRoom(active, payload);
      const correlationId = controller.requestLaunch();
      return controller.waitForCorrelation(correlationId);
    },
    sendChat(payload = {}) {
      const controller = assertRoom(active, payload);
      const correlationId = controller.sendChat(payload.text);
      return controller.waitForCorrelation(correlationId);
    },
    sendPing(payload = {}) {
      const controller = assertRoom(active, payload);
      const correlationId = controller.sendPing(payload.kind, payload.target);
      return controller.waitForCorrelation(correlationId);
    },
    mutePlayer(payload = {}) { return assertRoom(active, payload).setMuted(payload.accountId, payload.muted); },
    reportPlayer(payload = {}) { return assertRoom(active).reportPlayer(payload); },
    cancelLobbyReconnect(payload = {}) { return assertRoom(active, payload).cancelReconnect(); },
    async leaveRoom(payload = {}) {
      assertRoom(active, payload);
      if (typeof client.leaveRoom !== 'function') throw unavailable('The authoritative room leave endpoint is unavailable.');
      const result = await client.leaveRoom(payload);
      deactivate('left lobby');
      return result;
    },
    getLobbySnapshotNow: () => active?.controller.getSnapshot() || null,
    subscribeLobby(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    disconnectLobby(reason) { deactivate(reason || 'shell disconnected'); },
    destroyLobby() {
      deactivate('adapter destroyed');
      listeners.clear();
      connectionListeners.clear();
    },
  };
  return Object.freeze(adapter);
}
