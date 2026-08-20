/** The frozen platform error vocabulary and wire semantics from contracts/errors.md. */
export const PLATFORM_ERROR_SPECS = Object.freeze({
  AUTH_REQUIRED: [401, false], AUTH_INVALID_CREDENTIALS: [401, false],
  AUTH_TOKEN_EXPIRED: [401, false], AUTH_TOKEN_INVALID: [401, false],
  AUTH_SESSION_REVOKED: [401, false], AUTH_SESSION_REPLACED: [401, false],
  AUTH_RATE_LIMITED: [429, true], AUTH_ACCOUNT_LOCKED: [423, false],
  AUTH_FORBIDDEN: [403, false], AUTH_VERIFICATION_REQUIRED: [403, false],
  AUTH_ELIGIBILITY_REQUIRED: [403, false], AUTH_ELIGIBILITY_DENIED: [403, false],
  AUTH_TERMS_ACCEPTANCE_REQUIRED: [403, false], AUTH_RECOVERY_TOKEN_INVALID: [400, false],
  AUTH_RECOVERY_TOKEN_EXPIRED: [400, false], AUTH_VERIFICATION_TOKEN_INVALID: [400, false],
  AUTH_VERIFICATION_TOKEN_EXPIRED: [400, false], ELIGIBILITY_RECEIPT_INVALID: [400, false],
  CONSENT_RECEIPT_INVALID: [400, false], VALIDATION_FAILED: [400, false],
  NOT_FOUND: [404, false], CONFLICT: [409, false], IDEMPOTENCY_KEY_REUSED: [409, false],
  PAYLOAD_TOO_LARGE: [413, false], RATE_LIMITED: [429, true], UNSUPPORTED_CLIENT: [426, false],
  NAME_TAKEN: [409, false], NAME_POLICY_VIOLATION: [422, false],
  NAME_CHANGE_COOLDOWN: [429, false], ROOM_NOT_FOUND: [404, false], ROOM_FULL: [409, false],
  ROOM_CLOSED: [409, false], ROOM_IN_PROGRESS: [409, false],
  ROOM_PASSWORD_REQUIRED: [401, false], ROOM_PASSWORD_INVALID: [403, false],
  ROOM_REMOVED: [403, false], TEAM_FULL: [409, false], TEAM_SWITCH_FORBIDDEN: [403, false],
  SLOT_RESERVATION_EXPIRED: [409, false], NOT_IN_ROOM: [409, false],
  MATCH_ALLOCATION_FAILED: [503, true], MATCH_SERVER_UNREACHABLE: [503, true],
  MATCH_ABORTED: [409, false], SESSION_TOKEN_INVALID: [401, false],
  PROTOCOL_VERSION_MISMATCH: [426, false], RECONNECT_GRACE_EXPIRED: [409, false],
  SANCTIONED: [403, false], CHAT_RATE_LIMITED: [429, true], CHAT_BLOCKED: [403, false],
  REPORT_DUPLICATE: [409, false], INTERNAL_ERROR: [500, false],
  SERVICE_UNAVAILABLE: [503, true], MAINTENANCE: [503, false], FEATURE_DISABLED: [403, false],
});

export const PLATFORM_ERROR_CODES = Object.freeze(Object.keys(PLATFORM_ERROR_SPECS));

const CODE_SET = new Set(PLATFORM_ERROR_CODES);

/** A validated non-2xx platform response. UI code branches on `code`, never `message`. */
export class PlatformError extends Error {
  /** @param {object} envelope @param {number} status */
  constructor(envelope, status) {
    super(envelope.message);
    this.name = 'PlatformError';
    this.code = envelope.code;
    this.status = status;
    this.correlationId = envelope.correlationId;
    this.retryable = envelope.retryable;
    this.retryAfterMs = envelope.retryAfterMs;
    this.details = envelope.details;
  }
}

export const CLIENT_ERROR_CODES = Object.freeze([
  'CLIENT_ABORTED', 'CLIENT_TIMEOUT', 'CLIENT_NETWORK', 'CLIENT_PROTOCOL',
]);

/** A closed client-side transport failure, separate from platform API error codes. */
export class PlatformClientError extends Error {
  /** @param {typeof CLIENT_ERROR_CODES[number]} code @param {string} message @param {object} [options] */
  constructor(code, message, options = {}) {
    if (!CLIENT_ERROR_CODES.includes(code)) throw new TypeError(`Unknown client error code: ${code}`);
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'PlatformClientError';
    this.code = code;
    this.correlationId = options.correlationId || null;
    this.retryable = code === 'CLIENT_NETWORK' || code === 'CLIENT_TIMEOUT';
    this.offline = code === 'CLIENT_NETWORK';
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} raw @param {number} status */
export function parsePlatformError(raw, status) {
  if (!isObject(raw) || !isObject(raw.error)) return null;
  const error = raw.error;
  if (Object.keys(raw).length !== 1 || Object.keys(raw)[0] !== 'error') return null;
  const canonical = ['code', 'message', 'correlationId', 'retryable', 'retryAfterMs', 'details'];
  const keys = Object.keys(error);
  if (keys.length !== canonical.length || canonical.some((key) => !Object.hasOwn(error, key))) return null;
  const spec = PLATFORM_ERROR_SPECS[error.code];
  if (!CODE_SET.has(error.code) || status !== spec[0] || error.retryable !== spec[1]
    || typeof error.message !== 'string'
    || typeof error.correlationId !== 'string' || typeof error.retryable !== 'boolean'
    || !(error.retryAfterMs === null || (Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0))
    || (!error.retryable && error.retryAfterMs !== null) || !isObject(error.details)) return null;
  return new PlatformError(error, status);
}

export const isAuthTerminalError = (error) => error instanceof PlatformError
  && ['AUTH_REQUIRED', 'AUTH_TOKEN_INVALID', 'AUTH_SESSION_REVOKED', 'AUTH_SESSION_REPLACED']
    .includes(error.code);
