/**
 * Structured logging.  Build Plan §P1.A7.
 *
 * JSON lines, one per event, always carrying the correlation id when the caller has one.
 * Never a formatted string: a log a human reads comfortably is a log a query cannot filter,
 * and the whole point of §2.3 is following one player action across three tiers.
 *
 * This is also the final privacy boundary. Callers are allowed to make mistakes: an exception
 * may echo a provider URL, an audit subject may be an account, and a mail adapter may be handed a
 * credential. The logger therefore accepts only the operational vocabulary below. Identifiers
 * needed to join repeated operational records are one-way pseudonymised; credentials, personal
 * text, addresses, request bodies, and exception text are discarded rather than "best effort"
 * scrubbed. A deny-list alone is not a privacy control because the next caller can invent a key.
 */
import { createHash } from 'node:crypto';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CORRELATION = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

// Fields whose values are useful for operations and have bounded, non-personal semantics.
// Anything absent from this set is dropped. Complex values get an additional per-container
// schema below; arbitrary nested objects never pass through.
const SAFE_FIELDS = new Set([
  'correlationId', 'traceId', 'spanId', 'parentSpanId', 'traceparent',
  'method', 'path', 'status', 'statusClass', 'ms', 'durationMs', 'at', 'occurredAt',
  'code', 'errorCode', 'type', 'name', 'action', 'actorRole', 'subjectKind', 'reasonCode',
  'consumer', 'attempts', 'retryInMs', 'count', 'removed', 'suppliedLength',
  'module', 'transport', 'hasKey', 'delivered', 'schemaVersion', 'signal', 'port', 'env',
  'storage', 'kind', 'tier', 'component', 'severity', 'reason', 'retryable', 'outcome',
  'version', 'privacyClass', 'retentionClass', 'receivedAt', 'unlinked',
  'evidenceRows', 'networkClass', 'clientCount', 'mounted', 'fields', 'byReason',
  'attributes', 'labels', 'payload',
]);

const TELEMETRY_PAYLOAD_FIELDS = new Set([
  'step', 'outcome', 'errorCode', 'completed', 'mode', 'timeToFirstMatchSec', 'lastState',
  'dwellSec', 'code', 'joinBlockedReason', 'stage', 'returnedToLobby', 'category',
  'duringFirstSession', 'reason', 'browser', 'browserMajor', 'os', 'p50', 'p01',
  'windowSec', 'p50Ms', 'p95Ms', 'p99Ms', 'recovered', 'uptimeSec', 'errorClass', 'fatal',
  'ms', 'usedMb', 'sampledAtSec', 'rttMs', 'jitterMs', 'lossPct',
  'correctionRatePerSec', 'snapshotAgeMs',
]);

const SAFE_ATTRIBUTE_FIELDS = new Set([
  'method', 'path', 'status', 'statusClass', 'component', 'eventType', 'outcome',
  'errorCode', 'retryable',
]);

const SAFE_REASONS = new Set([
  'transport', 'unconfigured', 'configured', 'disabled', 'transport_disabled',
  'no_recipient', 'transport_error',
]);

// Metric labels are deliberately much narrower than top-level log fields. A label must be one
// of these bounded operational dimensions; accepting any token-shaped key would let a future
// caller invent an innocuous-looking `customer` or `note` dimension and retain personal text.
const SAFE_LABEL_FIELDS = new Set([
  'method', 'path', 'status', 'component', 'event', 'severity', 'reason',
]);

const SECRET_OR_PERSONAL = /(?:authorization|bearer|cookie|password|secret|token|credential|email|(?:^|_)ip(?:$|_)|ip(?:Address)?$|address|url|link|body|request|response|stack|cause|message|lastError|description|displayName|chat|text|recipient|^to$|^from$)/i;

const digestId = (value) => `sha256:${createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;

function safePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return undefined;
  // Defensive even though HTTP already supplies a pathname: never retain a query or a concrete
  // ULID if a future caller passes req.url instead.
  return value.split('?', 1)[0]
    .replace(/\/[0-9A-HJKMNP-TV-Z]{26}(?=\/|$)/g, '/:id')
    .slice(0, 256);
}

function safeToken(value) {
  return typeof value === 'string' && TOKEN.test(value) ? value : undefined;
}

function safeScalar(key, value) {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  if (key === 'correlationId') return CORRELATION.test(value) ? value : undefined;
  if (key === 'traceId') return TRACE_ID.test(value) ? value : undefined;
  if (key === 'spanId' || key === 'parentSpanId') return SPAN_ID.test(value) ? value : undefined;
  if (key === 'traceparent') return TRACEPARENT.test(value) ? value : undefined;
  if (key === 'path') return safePath(value);
  if (key === 'at' || key === 'occurredAt' || key === 'receivedAt') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : undefined;
  }
  return safeToken(value);
}

function safeMap(value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowedKeys.has(key) || SECRET_OR_PERSONAL.test(key)) continue;
    const safe = safeScalar(key, item);
    if (safe !== undefined) out[key] = safe;
  }
  return Object.keys(out).length ? out : undefined;
}

function safeCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (!TOKEN.test(key) || typeof item !== 'number' || !Number.isFinite(item)) continue;
    out[key] = item;
  }
  return Object.keys(out).length ? out : undefined;
}

function safeLabels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SAFE_LABEL_FIELDS.has(key) || SECRET_OR_PERSONAL.test(key)) continue;
    const safe = key === 'path' ? safePath(item) : safeScalar(key, item);
    if (safe !== undefined) out[key] = safe;
  }
  return Object.keys(out).length ? out : undefined;
}

function isRawIdentifierKey(key) {
  return /Id$/.test(key) && !['correlationId', 'traceId', 'spanId', 'parentSpanId'].includes(key);
}

function sanitizeFields(logEvent, fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    // `event` and `service` are reserved line metadata. Alert callers use them as related
    // operational labels, so retain a validated copy without allowing either to overwrite the
    // logger's own identity.
    if (key === 'event') {
      const relatedEvent = safeToken(value);
      if (relatedEvent !== undefined) out.relatedEvent = relatedEvent;
      continue;
    }
    if (key === 'service') {
      const sourceService = safeToken(value);
      if (sourceService !== undefined) out.sourceService = sourceService;
      continue;
    }
    if (isRawIdentifierKey(key)) {
      if (value !== null && (typeof value === 'string' || typeof value === 'number')) {
        out[key] = digestId(value);
      }
      continue;
    }
    if (SECRET_OR_PERSONAL.test(key) || !SAFE_FIELDS.has(key)) continue;

    let safe;
    if (key === 'mounted' || key === 'fields') {
      if (Array.isArray(value)) safe = value.map(safeToken).filter((item) => item !== undefined).slice(0, 64);
    } else if (key === 'byReason') {
      safe = safeCounts(value);
    } else if (key === 'labels') {
      safe = safeLabels(value);
    } else if (key === 'attributes') {
      safe = safeMap(value, SAFE_ATTRIBUTE_FIELDS);
    } else if (key === 'payload' && logEvent === 'telemetry.record') {
      safe = safeMap(value, TELEMETRY_PAYLOAD_FIELDS);
    } else if (key === 'reason') {
      // Closed reason codes survive; prose, URLs and provider diagnostics do not.
      safe = SAFE_REASONS.has(value) ? value : undefined;
    } else {
      safe = safeScalar(key, value);
    }
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}

export function createLogger({ level = 'info', service = 'platform', sink = console } = {}) {
  const min = LEVELS[level] ?? 20;
  const emit = (lvl, event, fields) => {
    if (LEVELS[lvl] < min) return;
    const safeEvent = safeToken(event) ?? 'log.invalid_event';
    const safeService = safeToken(service) ?? 'platform';
    const line = { ts: new Date().toISOString(), level: lvl, service: safeService,
      event: safeEvent, ...sanitizeFields(safeEvent, fields) };
    // stdout for everything: the platform does not decide where logs go, the runtime does.
    sink.log(JSON.stringify(line));
  };
  return {
    debug: (e, f = {}) => emit('debug', e, f),
    info:  (e, f = {}) => emit('info', e, f),
    warn:  (e, f = {}) => emit('warn', e, f),
    error: (e, f = {}) => emit('error', e, f),
    child: (bound) => {
      const base = createLogger({ level, service, sink });
      return {
        debug: (e, f = {}) => base.debug(e, { ...bound, ...f }),
        info:  (e, f = {}) => base.info(e, { ...bound, ...f }),
        warn:  (e, f = {}) => base.warn(e, { ...bound, ...f }),
        error: (e, f = {}) => base.error(e, { ...bound, ...f }),
      };
    },
  };
}
