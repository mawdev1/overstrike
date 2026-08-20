export const CLIENT_FLAG_DEFAULTS = Object.freeze({
  'shell.diagnostics.panel': true,
  'shell.career.enabled': true,
  'shell.serverbrowser.enabled': true,
  'mode.tdm.enabled': true,
  'mode.bomb.enabled': false,
  'map.the_square.enabled': false,
  'chat.text.enabled': true,
  'chat.pings.enabled': true,
  'reports.enabled': true,
  'telemetry.client.enabled': true,
});

/** Memory-only client-presentational flags with safe compiled defaults. */
export class FeatureFlagState {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.values = { ...CLIENT_FLAG_DEFAULTS };
    this.version = null;
    this.evaluatedAt = null;
    this.expiresAt = null;
    this.listeners = new Set();
  }

  isEnabled(key) {
    return Object.hasOwn(CLIENT_FLAG_DEFAULTS, key)
      ? this.values[key]
      : CLIENT_FLAG_DEFAULTS[key];
  }

  isStale() { return !this.expiresAt || Date.parse(this.expiresAt) <= this.now(); }

  update(projection) {
    if (!projection || typeof projection !== 'object' || !Number.isInteger(projection.version)
      || !Number.isFinite(Date.parse(projection.evaluatedAt))
      || !Number.isFinite(Date.parse(projection.expiresAt))
      || !projection.flags || typeof projection.flags !== 'object'
      || Array.isArray(projection.flags)) {
      throw new TypeError('Invalid client feature-flag projection.');
    }
    const next = { ...CLIENT_FLAG_DEFAULTS };
    for (const [key, value] of Object.entries(projection.flags)) {
      if (Object.hasOwn(CLIENT_FLAG_DEFAULTS, key) && typeof value === 'boolean') next[key] = value;
    }
    this.values = next;
    this.version = projection.version;
    this.evaluatedAt = projection.evaluatedAt;
    this.expiresAt = projection.expiresAt;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  snapshot() {
    return Object.freeze({
      version: this.version,
      evaluatedAt: this.evaluatedAt,
      expiresAt: this.expiresAt,
      stale: this.isStale(),
      flags: Object.freeze({ ...this.values }),
    });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const createFeatureFlagState = (options) => new FeatureFlagState(options);
