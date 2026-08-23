/**
 * The error envelope.  contracts/errors.md.
 *
 * One shape for every non-2xx response in the platform, because the alternative is that the
 * UI eventually matches on `message` and a copy edit in here breaks a screen over there.
 *
 * The code is the contract. `message` is for humans and may change freely; `code` may not.
 */

/** Every code in contracts/errors.md §3, with its canonical status and retryability. */
export const CODES = {
  // auth + session
  AUTH_REQUIRED:                     { status: 401, retryable: false },
  AUTH_INVALID_CREDENTIALS:          { status: 401, retryable: false },
  AUTH_TOKEN_EXPIRED:                { status: 401, retryable: false },
  AUTH_TOKEN_INVALID:                { status: 401, retryable: false },
  AUTH_SESSION_REVOKED:              { status: 401, retryable: false },
  AUTH_SESSION_REPLACED:             { status: 401, retryable: false },
  AUTH_RATE_LIMITED:                 { status: 429, retryable: true },
  AUTH_ACCOUNT_LOCKED:               { status: 423, retryable: false },
  AUTH_FORBIDDEN:                    { status: 403, retryable: false },
  AUTH_VERIFICATION_REQUIRED:        { status: 403, retryable: false },
  AUTH_ELIGIBILITY_REQUIRED:         { status: 403, retryable: false },
  AUTH_ELIGIBILITY_DENIED:           { status: 403, retryable: false },
  AUTH_TERMS_ACCEPTANCE_REQUIRED:    { status: 403, retryable: false },
  AUTH_RECOVERY_TOKEN_INVALID:       { status: 400, retryable: false },
  AUTH_RECOVERY_TOKEN_EXPIRED:       { status: 400, retryable: false },
  AUTH_VERIFICATION_TOKEN_INVALID:   { status: 400, retryable: false },
  AUTH_VERIFICATION_TOKEN_EXPIRED:   { status: 400, retryable: false },
  ELIGIBILITY_RECEIPT_INVALID:       { status: 400, retryable: false },
  // Never the status of a telemetry batch — §3.3 keeps that a 202 — but a code the batch
  // response names, so the client has one thing to branch on instead of guessing (REQ-CC-042).
  CONSENT_RECEIPT_INVALID:           { status: 400, retryable: false },

  // validation + request
  VALIDATION_FAILED:                 { status: 400, retryable: false },
  NOT_FOUND:                         { status: 404, retryable: false },
  CONFLICT:                          { status: 409, retryable: false },
  IDEMPOTENCY_KEY_REUSED:            { status: 409, retryable: false },
  PAYLOAD_TOO_LARGE:                 { status: 413, retryable: false },
  RATE_LIMITED:                      { status: 429, retryable: true },
  UNSUPPORTED_CLIENT:                { status: 426, retryable: false },

  // profile
  NAME_TAKEN:                        { status: 409, retryable: false },
  NAME_POLICY_VIOLATION:             { status: 422, retryable: false },
  NAME_CHANGE_COOLDOWN:              { status: 429, retryable: false },

  // lobby + match
  ROOM_NOT_FOUND:                    { status: 404, retryable: false },
  ROOM_FULL:                         { status: 409, retryable: false },
  ROOM_CLOSED:                       { status: 409, retryable: false },
  ROOM_IN_PROGRESS:                  { status: 409, retryable: false },
  ROOM_PASSWORD_REQUIRED:            { status: 401, retryable: false },
  ROOM_PASSWORD_INVALID:             { status: 403, retryable: false },
  ROOM_REMOVED:                      { status: 403, retryable: false },
  ROOM_NOT_EMPTY:                    { status: 409, retryable: false },
  TEAM_FULL:                         { status: 409, retryable: false },
  TEAM_SWITCH_FORBIDDEN:             { status: 403, retryable: false },
  SLOT_RESERVATION_EXPIRED:          { status: 409, retryable: false },
  NOT_IN_ROOM:                       { status: 409, retryable: false },
  MATCH_ALLOCATION_FAILED:           { status: 503, retryable: true },
  MATCH_SERVER_UNREACHABLE:          { status: 503, retryable: true },
  MATCH_ABORTED:                     { status: 409, retryable: false },
  SESSION_TOKEN_INVALID:             { status: 401, retryable: false },
  PROTOCOL_VERSION_MISMATCH:         { status: 426, retryable: false },
  RECONNECT_GRACE_EXPIRED:           { status: 409, retryable: false },

  // inventory (items-inventory.md §8)
  LOADOUT_INVALID_SLOT:              { status: 400, retryable: false },
  LOADOUT_ITEM_NOT_OWNED:            { status: 400, retryable: false },
  LOADOUT_DUPLICATE_INSTANCE:        { status: 400, retryable: false },
  ITEM_LOCKED:                       { status: 409, retryable: false },
  ITEM_NOT_STACKABLE:                { status: 400, retryable: false },
  ITEM_ALREADY_DEPLOYED:             { status: 409, retryable: false },

  // deployment reservation + signed snapshot (deployment.md §8)
  DEPLOYMENT_REQUEST_INVALID:        { status: 400, retryable: false },
  DEPLOYMENT_RESERVATION_CONFLICT:   { status: 409, retryable: true },
  DEPLOYMENT_RESERVATION_EXPIRED:    { status: 409, retryable: false },
  DEPLOYMENT_SNAPSHOT_INVALID:       { status: 401, retryable: false },
  DEPLOYMENT_ALREADY_CONSUMED:       { status: 409, retryable: false },

  // progression / OP ledger / repair / upgrade (progression-economy.md §8)
  OP_INSUFFICIENT_BALANCE:           { status: 402, retryable: false },
  ITEM_NOT_REPAIRABLE:               { status: 400, retryable: false },
  ITEM_BROKEN:                       { status: 400, retryable: false },
  ITEM_MAX_TIER:                     { status: 400, retryable: false },

  // moderation
  SANCTIONED:                        { status: 403, retryable: false },
  CHAT_RATE_LIMITED:                 { status: 429, retryable: true },
  CHAT_BLOCKED:                      { status: 403, retryable: false },
  REPORT_DUPLICATE:                  { status: 409, retryable: false },

  // platform
  INTERNAL_ERROR:                    { status: 500, retryable: false },
  SERVICE_UNAVAILABLE:               { status: 503, retryable: true },
  MAINTENANCE:                       { status: 503, retryable: false },
  FEATURE_DISABLED:                  { status: 403, retryable: false },
};

/**
 * A failure that carries a contract code.
 *
 * `details` is structured and per-code. It is NEVER free text the UI has to parse, and it
 * never carries a cause, a stack, or a hostname — those stay in the log where the
 * correlation id can find them.
 */
export class ApiError extends Error {
  constructor(code, message, { details = {}, retryAfterMs = null, cause = null } = {}) {
    const spec = CODES[code];
    if (!spec) throw new Error(`ApiError: unknown code ${code}`);
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = spec.status;
    this.retryable = spec.retryable;
    this.retryAfterMs = retryAfterMs;
    this.details = details;
    // Kept for the logger, deliberately not serialised into the response.
    this.cause = cause;
  }

  toEnvelope(correlationId) {
    return {
      error: {
        code: this.code,
        message: this.message,
        correlationId,
        retryable: this.retryable,
        retryAfterMs: this.retryAfterMs,
        details: this.details,
      },
    };
  }
}

/** Shorthand so call sites read as the rule they enforce. */
export const fail = (code, message, opts) => { throw new ApiError(code, message, opts); };

/**
 * Wrap anything that is not already an ApiError.
 *
 * An unexpected throw becomes INTERNAL_ERROR with a generic message — in every environment,
 * because environments get misconfigured and a stack trace in a response is a stack trace an
 * attacker reads. The original is preserved on `cause` for the log.
 */
export function toApiError(err) {
  if (err instanceof ApiError) return err;
  return new ApiError('INTERNAL_ERROR', 'Something went wrong on our end.', { cause: err });
}
