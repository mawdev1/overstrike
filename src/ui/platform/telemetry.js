import { createUlidFactory, isUlid } from './ids.js';
import {
  CONNECTION_FAILURE_CODES, TELEMETRY_REGISTRY, sanitizeTelemetryPayload,
} from './telemetry-registry.js';
import { PLATFORM_ERROR_CODES } from './errors.js';

const QUEUE_KEY = 'overstrike.telemetry.queue.v1';
const CONSENT_KEY = 'overstrike.telemetry.consent.v1';
const SESSION_ID_KEY = 'overstrike.telemetry.client-session.v1';
const MAX_EVENTS = 500;
const BATCH_EVENTS = 50;
const BATCH_BYTES = 64 * 1024;
const MAX_AGE_MS = 30 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const encoder = new TextEncoder();
const ERROR_CODES = new Set(PLATFORM_ERROR_CODES);
const CONNECTION_CODES = new Set(CONNECTION_FAILURE_CODES);
const UNLOAD_CREDENTIAL_MS = 14 * 60 * 1000;

const ROUTE_STEPS = Object.freeze({
  welcome: ['internal', 'landing'],
  'onboarding.eligibility': ['internal', 'eligibility'],
  'onboarding.consent': ['internal', 'consent'],
  'auth.signIn': ['personal', 'signin'],
  'auth.create': ['personal', 'signup'],
  'onboarding.displayName': ['personal', 'display-name'],
  'onboarding.verify': ['personal', 'verify'],
  'onboarding.terms': ['personal', 'terms'],
  'onboarding.essentialSettings': ['personal', 'settings'],
  'settings.category': ['personal', 'settings'],
  'play.rooms': ['personal', 'browser'],
  'play.roomDetail': ['personal', 'browser'],
  'room.home': ['personal', 'lobby'],
  'room.roster': ['personal', 'lobby'],
  'room.loadout': ['personal', 'lobby'],
  'room.chat': ['personal', 'lobby'],
  'match.loading': ['personal', 'match'],
  'match.reconnect': ['personal', 'match'],
  results: ['personal', 'results'],
});

const OPERATION_STEPS = Object.freeze({
  checkEligibility: ['internal', 'eligibility'],
  setConsent: ['internal', 'consent'],
  signIn: ['personal', 'signin'],
  signUp: ['personal', 'signup'],
  completeVerification: ['personal', 'verify'],
  resendVerification: ['personal', 'verify'],
  acceptTerms: ['personal', 'terms'],
  saveSettings: ['personal', 'settings'],
  listRooms: ['personal', 'browser'],
  joinRoom: ['personal', 'lobby'],
  setReady: ['personal', 'ready'],
  getActiveMatch: ['personal', 'match'],
  reconnectMatch: ['personal', 'match'],
  getResult: ['personal', 'results'],
});

const safeStorage = (provided) => {
  if (provided !== undefined) return provided;
  try { return globalThis.sessionStorage || null; } catch { return null; }
};

const byteLength = (value) => encoder.encode(JSON.stringify(value)).byteLength;

/** Privacy-correct, best-effort browser telemetry queue and sender. */
export class TelemetryClient {
  /**
   * @param {{client: import('./client.js').PlatformClient, storage?: Storage|null,
   * navigator?: Navigator|null, document?: Document|null, window?: Window|null,
   * now?: () => number, ulid?: () => string, cadenceMs?: number,
   * onConsentRequired?: (reason: string) => void}} options
   */
  constructor(options) {
    if (!options?.client) throw new TypeError('A PlatformClient is required.');
    this.client = options.client;
    this.storage = safeStorage(options.storage);
    this.navigator = options.navigator === undefined ? globalThis.navigator : options.navigator;
    this.document = options.document === undefined ? globalThis.document : options.document;
    this.window = options.window === undefined ? globalThis.window : options.window;
    this.now = options.now || Date.now;
    this.ulid = options.ulid || createUlidFactory();
    this.cadenceMs = options.cadenceMs ?? 10_000;
    this.unloadCredentialUntil = 0;
    this.unloadCredentialFlight = null;
    this.onConsentRequired = options.onConsentRequired || (() => {});
    this.enabled = true;
    this.queue = { internal: [], personal: [] };
    this.consent = { telemetryPersonal: null, receipt: null };
    this.clientSessionId = this.#loadSessionId();
    this.flushFlight = null;
    this.timer = null;
    this.startedAt = this.now();
    this.flowMarks = new Set();
    this.onVisibility = () => {
      if (this.document?.visibilityState === 'hidden') this.flushBeacon();
    };
    this.onPageHide = () => this.flushBeacon();
    this.unsubscribeSession = this.client.session?.subscribe?.((event) => {
      if (event.type === 'authenticated') void this.refreshUnloadCredential();
      if (event.type === 'revoked') {
        this.unloadCredentialUntil = 0;
        this.setConsent({ telemetryPersonal: null });
      }
    }) || null;
    this.#restore();
  }

  getClientSessionId() { return this.clientSessionId; }

  setEnabled(enabled) {
    const wasEnabled = this.enabled;
    this.enabled = enabled === true;
    if (!this.enabled) {
      this.stop();
      this.queue = { internal: [], personal: [] };
      this.#persist();
    } else if (!wasEnabled) this.start();
    return this;
  }

  /**
   * A positive decision requires the signed receipt used on personal batches. A decline or
   * undecided state immediately discards personal records rather than retaining them for later.
   */
  setConsent({ telemetryPersonal, receipt = null }) {
    if (!(telemetryPersonal === true || telemetryPersonal === false || telemetryPersonal === null)) {
      throw new TypeError('telemetryPersonal must be true, false, or null.');
    }
    if (telemetryPersonal === true && (typeof receipt !== 'string' || receipt.length === 0)) {
      throw new TypeError('A consent receipt is required for personal telemetry.');
    }
    this.consent = { telemetryPersonal, receipt: telemetryPersonal === null ? null : receipt };
    if (telemetryPersonal !== true) this.queue.personal = [];
    this.#persist();
    this.#persistConsent();
  }

  /** @returns {boolean} true only when a valid, permitted event was queued. */
  record(name, payload, options = {}) {
    if (!this.enabled) return false;
    const version = options.version ?? 1;
    const spec = TELEMETRY_REGISTRY[name];
    const clean = sanitizeTelemetryPayload(name, version, payload);
    if (!spec || !clean) return false;
    if (spec.privacy === 'personal' && this.consent.telemetryPersonal !== true) return false;

    const occurredAt = options.occurredAt || new Date(this.now()).toISOString();
    const occurredMs = Date.parse(occurredAt);
    if (!Number.isFinite(occurredMs) || this.now() - occurredMs > MAX_AGE_MS) return false;
    // Pre-consent ids must never be copied from the eligibility/consent request. Do not even
    // accept an override for this event: callers should have no API with which to relink it.
    let correlationId = spec.unlinked ? this.ulid() : (options.correlationId || this.ulid());
    if (spec.unlinked) {
      const queuedIds = new Set(this.queue.internal
        .filter((item) => TELEMETRY_REGISTRY[item.event.name]?.unlinked)
        .map((item) => item.event.correlationId));
      while (queuedIds.has(correlationId)) correlationId = this.ulid();
    }
    if (!isUlid(correlationId)) return false;
    const event = { name, version, occurredAt, correlationId, payload: clean };
    const queued = { event, attempts: 0, retryAt: 0, queuedAt: this.now() };
    this.queue[spec.privacy].push(queued);
    this.#enforceCap();
    this.#persist();
    return true;
  }

  /** Shell route hook. Only the closed route map above can produce an event. */
  routeViewed(routeId) { return this.#flow(ROUTE_STEPS[routeId], 'viewed', null); }

  /** Shell operation hook. A duplicate route/operation view is emitted only once per session. */
  operationStarted(operation) {
    return this.#flow(OPERATION_STEPS[operation], 'viewed', null);
  }

  operationCompleted(operation) {
    // Choosing a display name and creating the account are one mutation in the current shell.
    if (operation === 'signUp') this.#flow(['personal', 'display-name'], 'completed', null);
    return this.#flow(OPERATION_STEPS[operation], 'completed', null);
  }

  operationFailed(operation, code) {
    const mapping = OPERATION_STEPS[operation];
    if (!mapping) return false;
    if (mapping[0] === 'personal' && !ERROR_CODES.has(code)) return false;
    return this.#flow(mapping, 'failed', mapping[0] === 'personal' ? code : null);
  }

  recordLobbyAbandoned({ lastState, dwellSec }) {
    return this.record('lobby.abandoned', { lastState, dwellSec });
  }

  recordFirstMatch({ completed, mode, timeToFirstMatchSec }) {
    return this.record('session.first_match', { completed, mode, timeToFirstMatchSec });
  }

  recordHandoffFailure({ stage, code }) {
    if (!ERROR_CODES.has(code)) return false;
    return this.record('match.handoff_failure', { stage, code });
  }

  recordReturnOutcome({ outcome, returnedToLobby }) {
    return this.record('match.return_outcome', { outcome, returnedToLobby });
  }

  recordSettingsFriction({ category, duringFirstSession }) {
    return this.record('settings.friction', { category, duringFirstSession });
  }

  recordConnectionFailure({ stage, code }) {
    if (!CONNECTION_CODES.has(code)) return false;
    return this.record('connection.failure', { stage, code });
  }

  recordUnsupported({ reason, browser, browserMajor, os }) {
    return this.record('client.unsupported', { reason, browser, browserMajor, os });
  }

  lobbyAbandoned(payload) { return this.recordLobbyAbandoned(payload); }
  firstMatch(payload) { return this.recordFirstMatch(payload); }
  handoffFailure(payload) { return this.recordHandoffFailure(payload); }
  returnOutcome(payload) { return this.recordReturnOutcome(payload); }
  settingsFriction(payload) { return this.recordSettingsFriction(payload); }
  connectionFailure(payload) { return this.recordConnectionFailure(payload); }
  unsupported(payload) { return this.recordUnsupported(payload); }

  start() {
    if (!this.enabled) return this;
    if (this.timer) return this;
    this.timer = setInterval(() => { void this.flush(); }, this.cadenceMs);
    this.document?.addEventListener?.('visibilitychange', this.onVisibility);
    this.window?.addEventListener?.('pagehide', this.onPageHide);
    if (this.client.session?.accessToken) void this.refreshUnloadCredential();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.document?.removeEventListener?.('visibilitychange', this.onVisibility);
    this.window?.removeEventListener?.('pagehide', this.onPageHide);
  }

  close() {
    this.stop();
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
  }

  /** Normal delivery has full correlation/build headers and never throws to gameplay code. */
  flush() {
    if (this.flushFlight) return this.flushFlight;
    this.flushFlight = this.#flushAll().catch(() => false).finally(() => { this.flushFlight = null; });
    return this.flushFlight;
  }

  /** Acquire the short-lived, httpOnly credential used only by the unload ingress. */
  refreshUnloadCredential() {
    if (!this.client.session?.accessToken) return Promise.resolve(false);
    if (this.unloadCredentialUntil > this.now()) return Promise.resolve(true);
    if (this.unloadCredentialFlight) return this.unloadCredentialFlight;
    this.unloadCredentialFlight = this.client.request('/v1/telemetry/unload/credential', {
      method: 'POST', auth: true, maxAttempts: 1,
    }).then((response) => {
      if (response.status !== 204) return false;
      this.unloadCredentialUntil = this.now() + UNLOAD_CREDENTIAL_MS;
      return true;
    }).catch(() => false).finally(() => { this.unloadCredentialFlight = null; });
    return this.unloadCredentialFlight;
  }

  /** Response-independent, best-effort delivery to the one frozen same-origin beacon ingress. */
  flushBeacon() {
    if (typeof this.navigator?.sendBeacon !== 'function') return false;
    let sentAny = false;
    for (const privacy of ['internal', 'personal']) {
      const selected = this.#select(privacy);
      if (!selected.length) continue;
      // While signed in, personal attribution must come from the scoped cookie. Before signup,
      // the signed receipt + clientSessionId remain the subject exactly as on the normal route.
      if (privacy === 'personal' && this.client.session?.accessToken
        && this.unloadCredentialUntil <= this.now()) continue;
      let correlationId = this.ulid();
      const eventIds = new Set(selected.map((item) => item.event.correlationId));
      while (eventIds.has(correlationId)) correlationId = this.ulid();
      let deliveryId = this.ulid();
      while (eventIds.has(deliveryId) || deliveryId === correlationId) deliveryId = this.ulid();
      const body = { ...this.#body(privacy, selected.map((item) => item.event)),
        correlationId, deliveryId, clientBuild: this.client.clientBuild };
      let accepted = false;
      try {
        accepted = this.navigator.sendBeacon(`${this.client.baseUrl || ''}/v1/telemetry/unload`,
          new Blob([JSON.stringify(body)], { type: 'application/json' }));
      } catch { accepted = false; }
      if (accepted) {
        this.#remove(privacy, selected);
        sentAny = true;
      } else this.#failed(privacy, selected);
    }
    this.#persist();
    return sentAny;
  }

  async #flushAll() {
    let sentAny = false;
    for (const privacy of ['internal', 'personal']) {
      const selected = this.#select(privacy);
      if (!selected.length) continue;
      const body = this.#body(privacy, selected.map((item) => item.event));
      try {
        if (privacy === 'personal' && this.client.session?.accessToken) {
          await this.refreshUnloadCredential();
        }
        const response = await this.client.request('/v1/telemetry/client', {
          method: 'POST', body, auth: privacy === 'personal', maxAttempts: 1,
        });
        const verdict = response.data;
        if (response.status !== 202 || !verdict || typeof verdict.accepted !== 'number'
          || typeof verdict.rejected !== 'number'
          || !Object.hasOwn(verdict, 'consentReceiptError')) throw new Error('Invalid telemetry response');
        this.#remove(privacy, selected);
        sentAny = true;
        if (privacy === 'personal' && verdict.consentReceiptError) {
          const reason = verdict.consentReceiptError.reason || 'invalid';
          this.setConsent({ telemetryPersonal: null });
          this.onConsentRequired(reason);
        }
      } catch {
        this.#failed(privacy, selected);
      }
      this.#persist();
    }
    return sentAny;
  }

  #body(privacy, events) {
    if (privacy === 'internal') return { schemaVersion: 1, events };
    return {
      clientSessionId: this.clientSessionId,
      consentReceipt: this.consent.receipt,
      schemaVersion: 1,
      events,
    };
  }

  #flow(mapping, outcome, errorCode) {
    if (!mapping) return false;
    const [privacy, step] = mapping;
    const mark = `${privacy}:${step}:${outcome}`;
    if (this.flowMarks.has(mark)) return false;
    const recorded = privacy === 'internal'
      ? this.record('funnel.preconsent', { step, outcome })
      : this.record('flow.step', { step, outcome, errorCode });
    if (recorded) this.flowMarks.add(mark);
    return recorded;
  }

  #select(privacy) {
    if (privacy === 'personal'
      && (this.consent.telemetryPersonal !== true || !this.consent.receipt)) return [];
    this.#prune();
    const due = this.queue[privacy].filter((item) => item.retryAt <= this.now());
    const selected = [];
    for (const item of due) {
      if (selected.length >= BATCH_EVENTS) break;
      const trial = [...selected, item];
      if (byteLength(this.#body(privacy, trial.map((entry) => entry.event))) > BATCH_BYTES) {
        if (selected.length === 0) this.#remove(privacy, [item]);
        break;
      }
      selected.push(item);
    }
    return selected;
  }

  #failed(privacy, selected) {
    for (const item of selected) {
      if (item.attempts >= 1) this.#remove(privacy, [item]);
      else { item.attempts = 1; item.retryAt = this.now() + RETRY_MS; }
    }
  }

  #remove(privacy, selected) {
    const removing = new Set(selected);
    this.queue[privacy] = this.queue[privacy].filter((item) => !removing.has(item));
  }

  #prune() {
    const cutoff = this.now() - MAX_AGE_MS;
    for (const privacy of ['internal', 'personal']) {
      this.queue[privacy] = this.queue[privacy]
        .filter((item) => Date.parse(item.event.occurredAt) >= cutoff);
    }
  }

  #enforceCap() {
    const all = [...this.queue.internal.map((item) => ['internal', item]),
      ...this.queue.personal.map((item) => ['personal', item])]
      .sort((a, b) => a[1].queuedAt - b[1].queuedAt);
    while (all.length > MAX_EVENTS) {
      const [privacy, item] = all.shift();
      this.#remove(privacy, [item]);
    }
  }

  #loadSessionId() {
    let existing = null;
    try { existing = this.storage?.getItem(SESSION_ID_KEY); } catch { /* ignored */ }
    if (isUlid(existing)) return existing;
    const created = this.ulid();
    try { this.storage?.setItem(SESSION_ID_KEY, created); } catch { /* memory-only */ }
    return created;
  }

  #restore() {
    try {
      const savedConsent = JSON.parse(this.storage?.getItem(CONSENT_KEY) || 'null');
      if (savedConsent && (savedConsent.telemetryPersonal === true || savedConsent.telemetryPersonal === false)
        && (savedConsent.telemetryPersonal === false || typeof savedConsent.receipt === 'string')) {
        this.consent = savedConsent;
      }
      const saved = JSON.parse(this.storage?.getItem(QUEUE_KEY) || 'null');
      if (!saved || !Array.isArray(saved.internal) || !Array.isArray(saved.personal)) return;
      for (const privacy of ['internal', 'personal']) {
        for (const item of saved[privacy]) {
          const event = item?.event;
          const spec = TELEMETRY_REGISTRY[event?.name];
          const payload = sanitizeTelemetryPayload(event?.name, event?.version, event?.payload);
          if (!spec || spec.privacy !== privacy || !payload || !isUlid(event.correlationId)
            || !Number.isFinite(Date.parse(event.occurredAt))) continue;
          this.queue[privacy].push({
            event: { ...event, payload },
            attempts: item.attempts === 1 ? 1 : 0,
            retryAt: Number.isFinite(item.retryAt) ? item.retryAt : 0,
            queuedAt: Number.isFinite(item.queuedAt) ? item.queuedAt : this.now(),
          });
        }
      }
      if (this.consent.telemetryPersonal !== true) this.queue.personal = [];
      this.#prune();
      this.#enforceCap();
    } catch {
      this.queue = { internal: [], personal: [] };
    }
  }

  #persist() {
    try { this.storage?.setItem(QUEUE_KEY, JSON.stringify(this.queue)); } catch { /* best effort */ }
  }

  #persistConsent() {
    try { this.storage?.setItem(CONSENT_KEY, JSON.stringify(this.consent)); } catch { /* best effort */ }
  }
}

/** Records only the closed error class; the raw Error/message is deliberately ignored. */
export function recordUnhandledError(telemetry, { fatal = false, errorClass = 'other' } = {}) {
  return telemetry.record('client.error', { errorClass, fatal });
}

/** Install window error/rejection observers without ever reading or retaining raw messages. */
export function installUnhandledErrorTelemetry(telemetry, target = globalThis.window) {
  if (!target?.addEventListener) return () => {};
  const onError = () => recordUnhandledError(telemetry, { errorClass: 'other' });
  const onRejection = () => recordUnhandledError(telemetry, { errorClass: 'unhandled-rejection' });
  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

/** Attach WebGL loss/restoration events using only recovery state and bounded uptime. */
export function installWebglLossTelemetry(telemetry, canvas, now = performance.now.bind(performance)) {
  if (!canvas?.addEventListener) return () => {};
  const startedAt = now();
  const record = (recovered) => telemetry.record('client.webgl_context_lost', {
    recovered,
    uptimeSec: Math.min(604800, Math.max(0, (now() - startedAt) / 1000)),
  });
  const lost = () => record(false);
  const restored = () => record(true);
  canvas.addEventListener('webglcontextlost', lost);
  canvas.addEventListener('webglcontextrestored', restored);
  return () => {
    canvas.removeEventListener('webglcontextlost', lost);
    canvas.removeEventListener('webglcontextrestored', restored);
  };
}

export const createTelemetryClient = (options) => new TelemetryClient(options);
