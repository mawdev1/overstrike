const CHANNEL_NAME = 'overstrike.platform.session.v1';
const STORAGE_KEY = 'overstrike.platform.session-event.v1';

/**
 * Memory-only bearer state with cross-tab revocation. Cross-tab messages contain only a
 * session id and reason; access tokens are never written to Web Storage or BroadcastChannel.
 */
export class SessionState {
  /** @param {{window?: Window, BroadcastChannel?: typeof BroadcastChannel}} [options] */
  constructor(options = {}) {
    this.accessToken = null;
    this.sessionId = null;
    this.profile = null;
    this.listeners = new Set();
    this.window = options.window === undefined ? (globalThis.window || null) : options.window;
    const Channel = options.BroadcastChannel === undefined
      ? globalThis.BroadcastChannel : options.BroadcastChannel;
    this.channel = Channel ? new Channel(CHANNEL_NAME) : null;
    this.onMessage = (event) => this.#receive(event?.data);
    this.onStorage = (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try { this.#receive(JSON.parse(event.newValue)); } catch { /* ignore foreign storage */ }
    };
    this.channel?.addEventListener('message', this.onMessage);
    this.window?.addEventListener?.('storage', this.onStorage);
  }

  /** @param {string} accessToken @param {{sessionId?: string}|null} [session] @param {object|null} [profile] */
  set(accessToken, session = null, profile = undefined) {
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new TypeError('accessToken must be a non-empty string.');
    }
    this.accessToken = accessToken;
    this.sessionId = session?.sessionId || this.sessionId || null;
    if (profile !== undefined) this.profile = profile;
    this.#emit({ type: 'authenticated', sessionId: this.sessionId });
  }

  /** Clear this tab. Pass broadcast=true for signout/revocation affecting sibling tabs. */
  clear(reason = 'signed-out', broadcast = false, allSessions = false) {
    const sessionId = this.sessionId;
    this.accessToken = null;
    this.sessionId = null;
    this.profile = null;
    this.#emit({ type: 'revoked', reason, sessionId });
    if (broadcast) this.#broadcast({
      type: 'revoked', reason, sessionId: allSessions ? null : sessionId, nonce: `${Date.now()}`,
    });
  }

  /** Announce revocation of a session removed through the device/session management UI. */
  announceRevocation(sessionId, reason = 'revoked') {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (this.sessionId === sessionId) this.clear(reason, false);
    this.#broadcast({ type: 'revoked', reason, sessionId, nonce: `${Date.now()}` });
  }

  snapshot() {
    return Object.freeze({
      authenticated: !!this.accessToken,
      sessionId: this.sessionId,
      accountId: this.profile?.accountId || null,
      displayName: this.profile?.displayName || null,
      profile: this.profile,
    });
  }

  /** @param {(state: object) => void} listener */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.channel?.removeEventListener('message', this.onMessage);
    this.channel?.close?.();
    this.window?.removeEventListener?.('storage', this.onStorage);
    this.listeners.clear();
  }

  #receive(message) {
    if (!message || message.type !== 'revoked') return;
    if (message.sessionId && this.sessionId && message.sessionId !== this.sessionId) return;
    this.clear(message.reason || 'revoked-in-another-tab', false);
  }

  #emit(event) {
    const state = this.snapshot();
    for (const listener of this.listeners) listener({ ...event, ...state });
  }

  #broadcast(message) {
    if (this.channel) {
      this.channel.postMessage(message);
      return;
    }
    const storage = this.window?.localStorage;
    if (!storage) return;
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(message));
      storage.removeItem(STORAGE_KEY);
    } catch { /* private mode or disabled storage: this tab is still cleared */ }
  }
}
