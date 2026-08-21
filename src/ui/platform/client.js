import { createUlidFactory, isUlid } from './ids.js';
import {
  PlatformClientError, PlatformError, isAuthTerminalError, parsePlatformError,
} from './errors.js';
import { SessionState } from './session.js';

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const NEVER_RETRY = new Set(['PROTOCOL_VERSION_MISMATCH', 'UNSUPPORTED_CLIENT', 'MAINTENANCE']);
const decoder = new TextDecoder();

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

function randomHex(bytes) {
  const data = new Uint8Array(bytes);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(data);
  else for (let i = 0; i < bytes; i++) data[i] = Math.floor(Math.random() * 256);
  return [...data].map((value) => value.toString(16).padStart(2, '0')).join('');
}

const createTraceparent = () => `00-${randomHex(16)}-${randomHex(8)}-01`;

/** @param {Headers} headers @param {unknown} body */
function attachBody(headers, body, correlationId) {
  if (body === undefined) return undefined;
  headers.set('Content-Type', 'application/json');
  try { return JSON.stringify(body); } catch (cause) {
    throw new PlatformClientError('CLIENT_PROTOCOL', 'The request body is not serializable.', {
      cause, correlationId,
    });
  }
}

/** @param {Response} response */
async function readResponse(response) {
  if (response.status === 204) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) return null;
  try { return JSON.parse(decoder.decode(bytes)); } catch { return undefined; }
}

/** @param {AbortSignal|undefined} external @param {number} timeoutMs */
function requestSignal(external, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(external?.reason);
  if (external?.aborted) abort();
  else external?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', abort);
    },
  };
}

  /**
   * @typedef {object} RequestOptions
 * @property {string} [method]
 * @property {unknown} [body]
 * @property {HeadersInit} [headers]
 * @property {boolean} [auth]
 * @property {string} [idempotencyKey]
 * @property {boolean} [idempotent] Explicit semantic idempotency for contracted POSTs.
 * @property {AbortSignal} [signal]
 * @property {number} [timeoutMs]
 * @property {number} [maxAttempts]
 * @property {string} [correlationId]
 * @property {string} [traceparent] W3C trace context; one value is retained across retries.
 */

/** @template T @typedef {{data: T, status: number, headers: Headers, correlationId: string}} PlatformResponse */

/** Contract-aware browser client for `/v1`. */
export class PlatformClient {
  /**
   * @param {{baseUrl?: string, clientBuild: string, fetch?: typeof fetch, timeoutMs?: number,
   * maxAttempts?: number, session?: SessionState, ulid?: () => string,
   * traceparent?: () => string,
   * locks?: {request: (name: string, options: object, callback: () => Promise<unknown>) => Promise<unknown>}|null,
   * sleep?: (ms: number) => Promise<void>, random?: () => number}} options
   */
  constructor(options) {
    if (!options || typeof options.clientBuild !== 'string'
      || !/^\d+(\.\d+)*$/.test(options.clientBuild)) {
      throw new TypeError('clientBuild must be dot-separated integers.');
    }
    this.baseUrl = (options.baseUrl || '').replace(/\/$/, '');
    this.clientBuild = options.clientBuild;
    this.fetch = options.fetch || globalThis.fetch;
    if (typeof this.fetch !== 'function') throw new TypeError('fetch is unavailable.');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new TypeError('timeoutMs must be positive.');
    }
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new TypeError('maxAttempts must be a positive integer.');
    }
    this.session = options.session || new SessionState();
    this.ulid = options.ulid || createUlidFactory();
    this.traceparent = options.traceparent || createTraceparent;
    this.sleep = options.sleep || sleepDefault;
    this.random = options.random || Math.random;
    this.locks = options.locks === undefined ? globalThis.navigator?.locks : options.locks;
    this.refreshFlight = null;
  }

  setSession(accessToken, session, profile) { this.session.set(accessToken, session, profile); }
  clearSession(reason = 'signed-out', broadcast = true) { this.session.clear(reason, broadcast); }
  get sessionState() { return this.session.snapshot(); }

  /** @template T @param {string} path @param {RequestOptions} [options] @returns {Promise<PlatformResponse<T>>} */
  async request(path, options = {}) {
    if (typeof path !== 'string' || !path.startsWith('/v1/') || path.startsWith('//')) {
      throw new TypeError('Platform paths must be relative and begin with /v1/.');
    }
    const method = (options.method || 'GET').toUpperCase();
    const correlationId = options.correlationId || this.ulid();
    if (!isUlid(correlationId)) throw new TypeError('correlationId must be a ULID.');
    const traceparent = options.traceparent || this.traceparent();
    if (!TRACEPARENT.test(traceparent) || /^00-0{32}-|^00-[0-9a-f]{32}-0{16}-/.test(traceparent)) {
      throw new TypeError('traceparent must be valid W3C trace context.');
    }
    if (options.idempotencyKey !== undefined
      && (typeof options.idempotencyKey !== 'string' || options.idempotencyKey.length === 0)) {
      throw new TypeError('idempotencyKey must be a non-empty string.');
    }
    const requestedAttempts = options.maxAttempts ?? this.maxAttempts;
    if (!Number.isInteger(requestedAttempts) || requestedAttempts < 1) {
      throw new TypeError('maxAttempts must be a positive integer.');
    }
    const requestTimeout = options.timeoutMs ?? this.timeoutMs;
    if (!Number.isFinite(requestTimeout) || requestTimeout <= 0) {
      throw new TypeError('timeoutMs must be positive.');
    }
    const maxAttempts = Math.min(3, requestedAttempts);
    const retryAllowed = IDEMPOTENT_METHODS.has(method) || options.idempotent === true
      || !!options.idempotencyKey;
    const tokenAtStart = options.auth === false ? null : this.session.accessToken;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.#once(path, {
          ...options, method, correlationId, traceparent, timeoutMs: requestTimeout,
        }, tokenAtStart);
      } catch (error) {
        if (error instanceof PlatformError && error.code === 'AUTH_TOKEN_EXPIRED'
          && options.auth !== false && !options._afterRefresh) {
          // If another request already rotated the token, this response used the old token and
          // can retry directly. Otherwise every waiter joins the one refresh promise.
          if (this.session.accessToken === tokenAtStart) await this.#refreshSingleFlight();
          return this.request(path, { ...options, method, correlationId, traceparent,
            maxAttempts: 1, _afterRefresh: true });
        }
        // A response may arrive after another request has refreshed or replaced the token.
        // Never let a stale (including initially tokenless) request clear the newer session.
        if (isAuthTerminalError(error) && options.auth !== false
          && this.session.accessToken === tokenAtStart) {
          this.session.clear(error.code, Boolean(this.session.sessionId));
        }
        const retryable = retryAllowed && attempt < maxAttempts && this.#canRetry(error);
        if (!retryable) throw error;
        await this.#wait(this.#retryDelay(error, attempt), options.signal, correlationId);
      }
    }
  }

  async signIn(credentials, options = {}) {
    const result = await this.request('/v1/auth/signin', {
      ...options, method: 'POST', body: credentials, auth: false, maxAttempts: 1,
    });
    if (options.validateSuccess && !options.validateSuccess(result.data, result)) {
      throw new PlatformClientError('CLIENT_PROTOCOL',
        'The platform returned an invalid success projection.', {
          correlationId: result.correlationId,
        });
    }
    this.#adoptAuth(result.data);
    return result;
  }

  async signUp(fields, options = {}) {
    const result = await this.request('/v1/auth/signup', {
      ...options, method: 'POST', body: fields, auth: false, maxAttempts: 1,
    });
    if (options.validateSuccess && !options.validateSuccess(result.data, result)) {
      throw new PlatformClientError('CLIENT_PROTOCOL',
        'The platform returned an invalid success projection.', {
          correlationId: result.correlationId,
        });
    }
    this.#adoptAuth(result.data);
    return result;
  }

  async refresh() { return this.#refreshSingleFlight(); }

  async signOut({ all = false, signal, validateSuccess = null } = {}) {
    try {
      const result = await this.request(all ? '/v1/auth/signout-all' : '/v1/auth/signout', {
        method: 'POST', body: {}, signal, maxAttempts: 1,
      });
      if (validateSuccess && !validateSuccess(result.data, result)) {
        throw new PlatformClientError('CLIENT_PROTOCOL',
          'The platform returned an invalid success projection.', {
            correlationId: result.correlationId,
          });
      }
      this.session.clear(all ? 'signed-out-all' : 'signed-out', true, all);
      return result;
    } catch (error) {
      // request() already clears a matching terminal credential. A transport/service failure
      // does not prove revocation: keep the session retryable and do not broadcast sign-out.
      throw error;
    }
  }

  close() { this.session.close(); }

  async #once(path, options, tokenOverride) {
    const headers = new Headers(options.headers || {});
    headers.set('X-Correlation-Id', options.correlationId);
    headers.set('Traceparent', options.traceparent);
    headers.set('X-Client-Build', this.clientBuild);
    if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
    headers.delete('Authorization');
    if (options.auth !== false && tokenOverride) headers.set('Authorization', `Bearer ${tokenOverride}`);
    const body = attachBody(headers, options.body, options.correlationId);
    const timeout = requestSignal(options.signal, options.timeoutMs ?? this.timeoutMs);
    let response;
    let data;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: options.method,
        headers,
        body,
        signal: timeout.signal,
        credentials: 'include',
      });
      data = await readResponse(response);
    } catch (cause) {
      const code = options.signal?.aborted ? 'CLIENT_ABORTED'
        : timeout.timedOut() ? 'CLIENT_TIMEOUT' : 'CLIENT_NETWORK';
      const message = code === 'CLIENT_TIMEOUT' ? 'The request timed out.'
        : code === 'CLIENT_ABORTED' ? 'The request was cancelled.' : 'The platform is unreachable.';
      throw new PlatformClientError(code, message, { cause, correlationId: options.correlationId });
    } finally {
      timeout.dispose();
    }

    const responseCorrelation = response.headers.get('X-Correlation-Id');
    const contentType = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    if (response.status !== 204 && contentType !== 'application/json') {
      throw new PlatformClientError('CLIENT_PROTOCOL', 'The platform response was not application/json.', {
        correlationId: options.correlationId,
      });
    }
    if (!response.ok) {
      const platformError = parsePlatformError(data, response.status);
      if (platformError && responseCorrelation === options.correlationId
        && platformError.correlationId === options.correlationId) throw platformError;
      throw new PlatformClientError('CLIENT_PROTOCOL', 'The platform returned an invalid error envelope.', {
        correlationId: options.correlationId,
      });
    }
    if (response.status !== 204 && data === undefined) {
      throw new PlatformClientError('CLIENT_PROTOCOL', 'The platform returned invalid JSON.', {
        correlationId: options.correlationId,
      });
    }
    const bodyCorrelation = data && typeof data === 'object' && !Array.isArray(data)
      ? data.correlationId : undefined;
    if (responseCorrelation !== options.correlationId
      || (response.status !== 204 && bodyCorrelation !== options.correlationId)) {
      throw new PlatformClientError('CLIENT_PROTOCOL', 'The platform returned a mismatched correlation id.', {
        correlationId: options.correlationId,
      });
    }
    return Object.freeze({
      data,
      status: response.status,
      headers: response.headers,
      correlationId: options.correlationId,
    });
  }

  #refreshSingleFlight() {
    if (this.refreshFlight) return this.refreshFlight;
    this.refreshFlight = this.#performRefresh().finally(() => { this.refreshFlight = null; });
    return this.refreshFlight;
  }

  async #performRefresh() {
    if (this.locks?.request) {
      return this.locks.request('overstrike-auth-refresh', { mode: 'exclusive' },
        () => this.#performRefreshUnlocked());
    }
    return this.#performRefreshUnlocked();
  }

  async #performRefreshUnlocked() {
    try {
      const result = await this.request('/v1/auth/refresh', {
        method: 'POST', auth: false, maxAttempts: 1, _afterRefresh: true,
      });
      this.#adoptAuth(result.data);
      return result;
    } catch (error) {
      // Transport, maintenance, and protocol failures do not prove revocation. In particular,
      // broadcasting them would sign healthy sibling tabs out merely because this tab is offline.
      if (isAuthTerminalError(error)) {
        this.session.clear(error.code, Boolean(this.session.sessionId));
      }
      throw error;
    }
  }

  #adoptAuth(data) {
    if (!data || typeof data.accessToken !== 'string' || !data.session) {
      throw new PlatformClientError('CLIENT_PROTOCOL', 'The auth response omitted session credentials.');
    }
    this.session.set(data.accessToken, data.session, data.profile);
  }

  #canRetry(error) {
    if (error instanceof PlatformClientError) return error.retryable && error.code !== 'CLIENT_ABORTED';
    if (!(error instanceof PlatformError) || !error.retryable) return false;
    if (error.code.startsWith('AUTH_') || NEVER_RETRY.has(error.code)) return false;
    return true;
  }

  #retryDelay(error, attempt) {
    if (error instanceof PlatformError && error.retryAfterMs !== null) return error.retryAfterMs;
    const base = Math.min(30_000, 500 * (2 ** (attempt - 1)));
    return Math.floor(base * (0.75 + this.random() * 0.5));
  }

  async #wait(ms, signal, correlationId) {
    if (!signal) return this.sleep(ms);
    if (signal.aborted) {
      throw new PlatformClientError('CLIENT_ABORTED', 'The request was cancelled.', { correlationId });
    }
    let abort;
    const aborted = new Promise((_, reject) => {
      abort = () => reject(new PlatformClientError('CLIENT_ABORTED', 'The request was cancelled.', {
        correlationId,
      }));
      signal.addEventListener('abort', abort, { once: true });
    });
    try { await Promise.race([this.sleep(ms), aborted]); }
    finally { signal.removeEventListener('abort', abort); }
  }
}

export const createPlatformClient = (options) => new PlatformClient(options);
