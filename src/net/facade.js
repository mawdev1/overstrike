/**
 * Contract 6 — the only network surface client presentation may consume.
 *
 * This object projects MultiplayerSession's protocol-coupled internals into immutable,
 * server-derived views. The one predicted exception is `localEntity`, named explicitly.
 */
import { MultiplayerSession } from './session.js';
import { NetClient } from './client.js';
import { WebSocketTransport } from './transport.js';
import { PROTOCOL_VERSION, F_ALIVE, unpackInteract, encodeLoadout } from './protocol.js';

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const STATES = new Set(['idle', 'connecting', 'live', 'reconnecting', 'closed', 'version-mismatch', 'rejected']);
const MAX_ATTEMPTS = 5;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function frozen(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) frozen(child);
  return Object.freeze(value);
}

function clone(value) {
  if (value === undefined) return undefined;
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function requireHandoff(value) {
  if (!value || typeof value !== 'object') throw new TypeError('MatchHandoff is required');
  const text = ['matchId', 'serverUrl', 'sessionTicket', 'expiresAt', 'mapId', 'mapVersion',
    'mode', 'rulesetVersion', 'region', 'serverBuild'];
  for (const key of text) if (typeof value[key] !== 'string' || value[key] === '') {
    throw new TypeError(`MatchHandoff.${key} is required`);
  }
  if (!ULID.test(value.matchId)) throw new TypeError('MatchHandoff.matchId must be a ULID');
  const url = new URL(value.serverUrl);
  const localWs = url.protocol === 'ws:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !localWs) throw new TypeError('MatchHandoff.serverUrl must use wss:');
  if (!Number.isFinite(Date.parse(value.expiresAt))) throw new TypeError('MatchHandoff.expiresAt must be ISO-8601');
  if (!Number.isFinite(value.reconnectGraceMs) || value.reconnectGraceMs <= 0) {
    throw new TypeError('MatchHandoff.reconnectGraceMs must be positive');
  }
  if (value.mode !== 'tdm' && value.mode !== 'bomb') throw new TypeError('MatchHandoff.mode is closed');
  if (!Number.isInteger(value.protocolVersion) || value.protocolVersion <= 0) {
    throw new TypeError('MatchHandoff.protocolVersion is required');
  }
  if (!Number.isInteger(value.spectatorPolicyVersion) || value.spectatorPolicyVersion !== 1) {
    throw new TypeError('MatchHandoff.spectatorPolicyVersion is unsupported');
  }
  if (value.protocolVersion !== PROTOCOL_VERSION) {
    const error = new Error('PROTOCOL_VERSION_MISMATCH');
    error.code = 'PROTOCOL_VERSION_MISMATCH';
    error.serverVersion = value.protocolVersion;
    throw error;
  }
  if (value.mode === 'bomb') {
    if (!value.series || !Array.isArray(value.sites) || value.sites.length !== 2) {
      throw new TypeError('Bomb MatchHandoff requires series and two sites');
    }
  }
  return value;
}

export function spectatorPolicyFor(phase, alive) {
  const decided = phase === 'roundEnd' || phase === 'matchEnd';
  const chatOpen = decided || phase === 'warmup' || phase === 'freeze';
  return frozen({
    canSpectateEnemies: false,
    canFreeCam: decided,
    canUseTeamChat: chatOpen || !!alive,
  });
}

async function defaultTicketProvider() {
  // The platform client owns bearer/build/correlation headers and refresh serialization.
  // A direct cookie-backed fetch here would silently bypass that authority on reconnect.
  const error = new Error('An authenticated reconnect-ticket provider is required.');
  error.code = 'RECONNECT_PROVIDER_UNAVAILABLE';
  error.retryable = false;
  throw error;
}

export class NetFacade {
  constructor({ game = null, connectSession = MultiplayerSession.connect,
    ticketProvider = defaultTicketProvider, clock = now } = {}) {
    this._game = null;
    this._connectSession = connectSession;
    this._ticketProvider = ticketProvider;
    this._clock = clock;
    this._listeners = new Map();
    this._off = [];
    this._session = null;
    this._reservation = null;
    this._handoff = null;
    this._rawMatchState = null;
    this._sampledAt = 0;
    this._serverNow = 0;
    this._serverRaw = null;
    this._lastBomb = null;
    this._spectatingId = null;
    this._deliberateClose = false;
    this._terminal = false;
    this._ignoreClose = false;
    this._generation = 0;
    this.state = 'idle';
    this.reconnect = null;
    if (game) this.bindGame(game);
  }

  bindGame(game) {
    if (!game?.bus) throw new TypeError('NetFacade.bindGame requires a game event bus');
    for (const off of this._off) off();
    this._off.length = 0;
    this._game = game;
    const on = (type, fn) => this._off.push(game.bus.on(type, fn));
    on('matchState', (state) => this._acceptMatchState(state));
    on('roundOutcome', (outcome) => this._roundOutcome(outcome));
    on('matchOutcome', (outcome) => this._matchOutcome(outcome));
    on('interactionRefused', (payload) => this._emit('interactionRefused', frozen(clone(payload))));
    on('netSnapshot', (payload) => this._emit('snapshot', frozen(clone(payload))));
    on('netEvent', (payload) => this._emit('event', frozen(clone(payload))));
    on('tacticalPing', (payload) => this._emit('tacticalPing', frozen(clone(payload))));
    on('netDisconnected', (payload) => this._socketClosed(payload));
    return this;
  }

  /** Inject the authenticated platform seam used to mint a fresh reconnect ticket. */
  setTicketProvider(provider) {
    if (typeof provider !== 'function') throw new TypeError('NetFacade ticket provider must be a function');
    this._ticketProvider = provider;
    return this;
  }

  get descriptor() {
    if (!this._handoff) return null;
    const { sessionTicket: _secret, ...safe } = this._handoff;
    return frozen(clone(safe));
  }

  get localEntity() { return this._session?.connected ? this._game?.player ?? null : null; }
  get remoteEntities() {
    if (!this._session?.connected) return new Map();
    return this._session.updateRemotes();
  }
  get matchState() { return this._rawMatchState ? this._projectMatchState() : null; }

  get netStats() {
    const session = this._session;
    if (!session) return null;
    const at = this._clock();
    const transport = session.net?.diagnostics?.(at);
    if (!transport) return null;
    const samples = (session.prediction?.correctionSamples || []).filter((row) => row.at >= at - 5000);
    const magnitudes = samples.map((row) => row.error).sort((a, b) => a - b);
    const p95 = magnitudes.length ? magnitudes[Math.min(magnitudes.length - 1, Math.ceil(magnitudes.length * 0.95) - 1)] : 0;
    return frozen({
      ...transport,
      region: this._handoff?.region ?? '',
      serverBuild: this._handoff?.serverBuild ?? '',
      protocolVersion: this._handoff?.protocolVersion ?? PROTOCOL_VERSION,
      correctionRatePerSec: samples.length / 5,
      correctionMagnitudeM: p95,
    });
  }

  on(type, fn) {
    if (typeof fn !== 'function') throw new TypeError('NetFacade.on requires a function');
    let set = this._listeners.get(type);
    if (!set) this._listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  async connect(handoff) {
    if (!this._game) throw new Error('NetFacade has no bound game');
    let given;
    try { given = requireHandoff(handoff); } catch (error) {
      if (error.code === 'PROTOCOL_VERSION_MISMATCH') {
        this._transition('version-mismatch', error.code);
        this._emit('versionMismatch', frozen({ clientVersion: PROTOCOL_VERSION, serverVersion: error.serverVersion }));
      } else this._transition('rejected', error.code || 'INVALID_HANDOFF');
      throw error;
    }
    this._generation++;
    this._deliberateClose = false;
    this._terminal = false;
    this.reconnect = null;
    this._handoff = frozen(clone(given));
    this._rawMatchState = null;
    this._serverRaw = null;
    this._serverNow = 0;
    this._transition('connecting', null);
    this._ignoreClose = true;
    try {
      const session = await this._connectSession(this._game, given.serverUrl, {
        sessionTicket: given.sessionTicket,
      });
      const welcome = this._adoptSession(session, given);
      this._ignoreClose = false;
      this._transition('live', welcome.isReconnect ? 'reconnected' : null);
      return this;
    } catch (error) {
      this._ignoreClose = false;
      if (error.code === 'PROTOCOL_VERSION_MISMATCH') {
        this._transition('version-mismatch', error.code);
        this._emit('versionMismatch', frozen({ clientVersion: PROTOCOL_VERSION, serverVersion: error.serverVersion ?? null }));
      } else {
        this._transition('rejected', error.code || 'CLIENT_NETWORK');
      }
      throw error;
    }
  }

  /** Consume the short-lived launch ticket immediately, before renderer/world initialization. */
  async reserve(handoff) {
    const given = requireHandoff(handoff);
    if (this._reservation) throw new Error('NetFacade already holds a launch reservation');
    this._handoff = frozen(clone(given));
    this._transition('connecting', 'reserving-seat');
    const transport = new WebSocketTransport(given.serverUrl);
    const client = new NetClient(transport);
    this._reservation = { transport, client, handoff: this._handoff };
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Launch ticket admission timed out.')), 10_000);
        client.onWelcome(() => { clearTimeout(timer); resolve(); });
        client.onReject((value) => {
          clearTimeout(timer);
          const error = new Error(value.message); error.code = value.reason;
          error.serverVersion = value.serverVersion; error.retryable = false; reject(error);
        });
        transport.onClose((value) => {
          clearTimeout(timer);
          const error = new Error(value?.reason || 'Launch reservation socket closed.');
          error.code = 'CLIENT_NETWORK'; reject(error);
        });
        client.sendHello(given.sessionTicket);
      });
      return this;
    } catch (error) {
      transport.close('reservation-failed');
      this._reservation = null;
      this._transition('rejected', error.code || 'CLIENT_NETWORK');
      throw error;
    }
  }

  /** Replace the lightweight admitted socket with the fully initialized gameplay session. */
  async promoteReservation() {
    const reservation = this._reservation;
    if (!reservation || !this._game) throw new Error('No launch reservation is ready to promote');
    const ticket = await this._ticketProvider(reservation.handoff.matchId);
    if (!ticket?.handoff) throw new Error('INVALID_RECONNECT_TICKET');
    try {
      await this.connect(ticket.handoff);
      return this;
    } finally {
      reservation.transport.close('reservation-promoted');
      if (this._reservation === reservation) this._reservation = null;
    }
  }

  disconnect(reason = 'client-cancelled') {
    this._generation++;
    this._deliberateClose = true;
    this._terminal = true;
    this.reconnect = null;
    this._session?.releaseInteraction?.();
    this._session?.close?.();
    this._session = null;
    this._reservation?.transport?.close?.(reason);
    this._reservation = null;
    this._transition('closed', reason);
  }

  sendLoadout({ primaryIdx, secondaryIdx } = {}) {
    if (!this._session?.connected) return;
    if (!Number.isInteger(primaryIdx) || primaryIdx < 0 || primaryIdx > 255
      || !Number.isInteger(secondaryIdx) || secondaryIdx < 0 || secondaryIdx > 255) return;
    this._session.transport.send(encodeLoadout(primaryIdx, secondaryIdx));
  }

  requestInteraction(kind) {
    if (kind !== 'plant' && kind !== 'defuse') return;
    this._session?.requestInteraction?.(kind);
  }

  /** Additive release companion for held input/accessibility controls. */
  releaseInteraction() { this._session?.releaseInteraction?.(); }

  requestTacticalPing(kind = 'location') {
    if (!['location', 'danger', 'objective'].includes(kind)) return false;
    return this._session?.requestTacticalPing?.(kind) === true;
  }

  /** Cycle only through server-snapshot teammates allowed by the closed spectator policy. */
  cycleSpectator(direction = 1) {
    if (this._handoff?.mode !== 'bomb' || !this._rawMatchState) return false;
    const local = this._latestLocalWire();
    if (!local || (local.flags & F_ALIVE)) return false;
    const policy = spectatorPolicyFor(this._rawMatchState.phase, false);
    const team = local.team;
    const candidates = [...this.remoteEntities.values()]
      .filter((entity) => entity.alive && (policy.canSpectateEnemies || entity.team === team))
      .map((entity) => entity.id)
      .sort((a, b) => a - b);
    if (!candidates.length) {
      this._spectatingId = null;
      return false;
    }
    const current = candidates.indexOf(this._spectatingId);
    const delta = direction < 0 ? -1 : 1;
    this._spectatingId = candidates[(current + delta + candidates.length) % candidates.length];
    this._emit('matchState', this._projectMatchState());
    this._emit('spectatorChanged', frozen({ entityId: this._spectatingId, policy }));
    return true;
  }

  _transition(to, reason) {
    if (!STATES.has(to)) throw new Error(`unknown facade state ${to}`);
    if (this.state === to && reason == null) return;
    const from = this.state;
    this.state = to;
    this._emit('stateChange', frozen({ from, to, reason: reason ?? null }));
  }

  _emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (error) {
        set.delete(fn);
        console.error(`[net-facade] ${type} handler removed`, error);
      }
    }
  }

  _acceptMatchState(raw) {
    if (!raw || !this._handoff) return;
    const sampledAt = this._clock();
    const current = raw.serverTimeMs >>> 0;
    if (this._serverRaw === null) this._serverNow = current;
    else this._serverNow += (current - this._serverRaw) >>> 0;
    this._serverRaw = current;
    this._sampledAt = sampledAt;
    this._rawMatchState = clone(raw);
    const next = this._projectMatchState();
    this._emit('matchState', next);
    const bomb = next.bomb;
    if (bomb && (!this._lastBomb || this._lastBomb.state !== bomb.state
      || this._lastBomb.carrierId !== bomb.carrierId || this._lastBomb.siteId !== bomb.siteId)) {
      this._emit('bombStateChanged', frozen({
        from: this._lastBomb?.state ?? 'none', to: bomb.state,
        actorId: bomb.carrierId, siteId: bomb.siteId,
      }));
    }
    this._lastBomb = bomb ? { state: bomb.state, carrierId: bomb.carrierId, siteId: bomb.siteId } : null;
    if ((raw.phase === 'planted' && this._session?.interactionKind === 'plant')
      || ((raw.phase === 'roundEnd' || raw.phase === 'matchEnd') && this._session?.interactionKind)) {
      this.releaseInteraction();
    }
  }

  _latestLocalWire() {
    const session = this._session;
    const snap = session?.net?.snapshots?.[session.net.snapshots.length - 1];
    return snap?.entities?.find((entity) => entity.id === session.net.entityId) ?? null;
  }

  _interaction(raw) {
    if (raw.interactActorId == null) return { kind: 'none', actorId: null, progress: 0 };
    const snap = this._session?.net?.snapshots?.[this._session.net.snapshots.length - 1];
    const actor = snap?.entities?.find((entity) => entity.id === raw.interactActorId);
    const unpacked = unpackInteract(actor?.interact ?? 0);
    return {
      kind: unpacked.kindName === 'plant' || unpacked.kindName === 'defuse' ? unpacked.kindName : 'none',
      actorId: raw.interactActorId,
      progress: raw.interactProgressFrac,
    };
  }

  _projectMatchState() {
    const raw = this._rawMatchState;
    const handoff = this._handoff;
    const wire = this._latestLocalWire();
    const teamIndex = wire?.team === 0 || wire?.team === 1 ? wire.team : null;
    const alive = wire ? !!(wire.flags & F_ALIVE) : false;
    const team = teamIndex === 0 ? 'alpha' : teamIndex === 1 ? 'bravo' : 'unassigned';
    const alphaRole = handoff.mode === 'bomb' ? (raw.sideSwitched ? 'defender' : 'attacker') : null;
    const bravoRole = handoff.mode === 'bomb' ? (raw.sideSwitched ? 'attacker' : 'defender') : null;
    const phaseEndsAt = raw.phaseRemainingMs > 0 ? this._serverNow + raw.phaseRemainingMs : null;
    const localRole = raw.localRole === 'attacker' || raw.localRole === 'defender'
      ? raw.localRole : null;
    if (alive) this._spectatingId = null;
    if (this._spectatingId != null) {
      const target = this.remoteEntities.get(this._spectatingId);
      const policy = spectatorPolicyFor(raw.phase, alive);
      if (!target?.alive || (!policy.canSpectateEnemies && target.team !== teamIndex)) {
        this._spectatingId = null;
      }
    }
    return frozen({
      version: 1,
      matchId: handoff.matchId,
      serverNow: this._serverNow,
      sampledAt: this._sampledAt,
      mode: handoff.mode,
      mapId: handoff.mapId,
      mapVersion: handoff.mapVersion,
      rulesetVersion: handoff.rulesetVersion,
      region: handoff.region,
      serverBuild: handoff.serverBuild,
      protocolVersion: handoff.protocolVersion,
      phase: raw.phase,
      phaseEndsAt,
      teams: {
        alpha: { score: raw.scoreAlpha, alive: handoff.mode === 'bomb' ? raw.aliveAlpha : null, role: alphaRole },
        bravo: { score: raw.scoreBravo, alive: handoff.mode === 'bomb' ? raw.aliveBravo : null, role: bravoRole },
      },
      killLimit: handoff.mode === 'tdm' ? this._session?.net?.killLimit ?? null : null,
      series: handoff.series ? { ...clone(handoff.series), sideSwitched: !!raw.sideSwitched } : null,
      round: handoff.mode === 'bomb' ? { index: raw.roundIndex, endsAt: phaseEndsAt } : null,
      bomb: handoff.mode === 'bomb' ? {
        state: raw.bombState,
        carrierId: raw.bombCarrierId,
        siteId: raw.bombSite,
        // A carried bomb's position is the carrier, never a separately revealed marker.
        // Force the contract's privacy invariant even if a malformed producer sets both.
        position: raw.bombState !== 'carried' && raw.bombPositionVisible
          ? clone(raw.bombPosition) : null,
      } : null,
      interaction: handoff.mode === 'bomb' ? this._interaction(raw) : null,
      sites: handoff.sites ? clone(handoff.sites) : null,
      localPlayer: {
        entityId: this._session?.net?.entityId ?? 0,
        team,
        role: localRole,
        alive,
        isSpectating: !alive,
        spectatingId: this._spectatingId,
        spectatorPolicy: spectatorPolicyFor(raw.phase, alive),
      },
    });
  }

  _roundOutcome(outcome) {
    if (!outcome) return;
    this._emit('roundEnded', frozen({
      roundIndex: outcome.roundIndex,
      winner: outcome.winnerTeam,
      reason: outcome.reason,
      scoreAlpha: outcome.scoreAlpha,
      scoreBravo: outcome.scoreBravo,
      actorId: outcome.actorId,
    }));
  }

  _matchOutcome(outcome) {
    if (!outcome) return;
    if (this._handoff && outcome.matchId !== this._handoff.matchId) return;
    this._terminal = true;
    this._emit('matchEnded', frozen({
      matchId: outcome.matchId,
      winner: outcome.winnerTeam,
      outcomeReason: outcome.reason,
      terminationReason: outcome.terminationReason,
      scoreAlpha: outcome.scoreAlpha,
      scoreBravo: outcome.scoreBravo,
      roundsPlayed: outcome.roundsPlayed,
    }));
  }

  _socketClosed(payload) {
    if (this._ignoreClose || this._deliberateClose || this.state === 'closed'
      || this.state === 'version-mismatch' || this.state === 'rejected') return;
    const reason = payload?.reason || 'socket-closed';
    this._emit('disconnected', frozen({
      reason, code: payload?.code ?? null, retryable: true, graceEndsAt: null,
    }));
    if (this._terminal || !this._handoff?.matchId) return this._transition('closed', reason);
    this._transition('reconnecting', reason);
    void this._reconnectLoop(++this._generation);
  }

  async _reconnectLoop(generation) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && generation === this._generation; attempt++) {
      try {
        const ticket = await this._ticketProvider(this._handoff.matchId);
        const graceWall = Date.parse(ticket.graceEndsAt);
        const serverWall = Date.parse(ticket.serverNow);
        if (!ticket.handoff || !Number.isFinite(graceWall) || !Number.isFinite(serverWall)) {
          throw new Error('INVALID_RECONNECT_TICKET');
        }
        const nextHandoff = requireHandoff(ticket.handoff);
        if (nextHandoff.matchId !== this._handoff.matchId) {
          const error = new Error('RECONNECT_MATCH_MISMATCH');
          error.code = 'RECONNECT_MATCH_MISMATCH';
          error.retryable = false;
          throw error;
        }
        this.reconnect = frozen({
          graceEndsAt: this._clock() + (graceWall - serverWall),
          attempt, maxAttempts: MAX_ATTEMPTS, canCancel: true,
        });
        this._emit('reconnectUpdate', this.reconnect);
        const session = await this._connectSession(this._game, nextHandoff.serverUrl, {
          sessionTicket: nextHandoff.sessionTicket,
        });
        if (generation !== this._generation) { session.close(); return; }
        const previous = this._handoff;
        this._handoff = frozen(clone(nextHandoff));
        try { this._adoptSession(session, nextHandoff); } catch (error) {
          this._handoff = previous;
          throw error;
        }
        this.reconnect = null;
        this._transition('live', 'reconnected');
        return;
      } catch (error) {
        if (error.code === 'PROTOCOL_VERSION_MISMATCH') {
          this.reconnect = null;
          this._transition('version-mismatch', error.code);
          this._emit('versionMismatch', frozen({
            clientVersion: PROTOCOL_VERSION, serverVersion: error.serverVersion ?? null,
          }));
          return;
        }
        if (error.code === 'RECONNECT_GRACE_EXPIRED' || error.retryable === false) {
          this.reconnect = null;
          this._transition('closed', error.code || 'RECONNECT_GRACE_EXPIRED');
          return;
        }
        if (attempt < MAX_ATTEMPTS) {
          const delay = Math.min(15000, 1000 * (2 ** (attempt - 1)));
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    if (generation === this._generation) {
      this.reconnect = null;
      this._transition('closed', 'RECONNECT_ATTEMPTS_EXHAUSTED');
    }
  }

  _adoptSession(session, handoff) {
    const welcome = session?.net?.welcome;
    if (!welcome || welcome.mode !== handoff.mode
      || welcome.protocolVersion !== handoff.protocolVersion) {
      const error = new Error('PROTOCOL_VERSION_MISMATCH');
      error.code = 'PROTOCOL_VERSION_MISMATCH';
      error.serverVersion = welcome?.protocolVersion ?? null;
      this._ignoreClose = true;
      session?.close?.();
      this._ignoreClose = false;
      throw error;
    }
    this._session = session;
    this._emit('welcome', frozen({
      clientId: welcome.clientId,
      entityId: welcome.entityId,
      matchSeed: welcome.matchSeed,
      killLimit: welcome.killLimit,
      mode: welcome.mode,
      isReconnect: !!welcome.isReconnect,
      isSpectator: !!welcome.isSpectator,
      protocolVersion: welcome.protocolVersion,
      serverTickRateHz: welcome.serverTickRateHz,
    }));
    // A match-state frame may race the asynchronous welcome poll. Adopt its newest
    // authoritative value now that entity/team identity is available to projection.
    if (session.matchState) this._acceptMatchState(session.matchState);
    return welcome;
  }
}

export const net = new NetFacade();

export default net;
