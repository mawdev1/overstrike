import { PLATFORM_ERROR_CODES } from './errors.js';

const field = Object.freeze({
  bool: () => ({ type: 'boolean' }),
  number: (min, max, integer = false) => ({ type: 'number', min, max, integer }),
  enum: (values, nullable = false) => ({ type: 'enum', values, nullable }),
});

export const CLIENT_ERROR_CLASSES = Object.freeze([
  'webgl-init', 'asset-decode', 'net-decode', 'unhandled-rejection', 'render-loop', 'other',
]);

export const UNSUPPORTED_REASONS = Object.freeze([
  'build', 'browser-version', 'os-version', 'webgl2', 'pointer-lock', 'websocket-binary',
  'memory', 'vram', 'cpu-cores', 'mobile-or-tablet',
]);

export const SETTINGS_CATEGORY_IDS = Object.freeze([
  'input', 'bindings', 'graphics', 'audioCaptions', 'crosshairHud', 'accessibility', 'network',
]);

/** Exact client registry from telemetry.md §3.3.1. */
export const TELEMETRY_REGISTRY = Object.freeze({
  'flow.step': {
    version: 1, privacy: 'personal', fields: {
      step: field.enum(['signup', 'signin', 'verify', 'terms', 'display-name', 'settings',
        'browser', 'lobby', 'ready', 'match', 'results']),
      outcome: field.enum(['viewed', 'completed', 'failed']),
      errorCode: field.enum(PLATFORM_ERROR_CODES, true),
    },
    invariant: (p) => p.outcome === 'failed' ? !!p.errorCode : p.errorCode === null,
  },
  'funnel.preconsent': {
    version: 1, privacy: 'internal', unlinked: true, fields: {
      step: field.enum(['landing', 'eligibility', 'consent']),
      outcome: field.enum(['viewed', 'completed', 'failed']),
    },
  },
  'session.first_match': {
    version: 1, privacy: 'personal', fields: {
      completed: field.bool(), mode: field.enum(['tdm', 'bomb']),
      timeToFirstMatchSec: field.number(0, 86400),
    },
  },
  'lobby.abandoned': {
    version: 1, privacy: 'personal', fields: {
      lastState: field.enum(['browsing', 'joining', 'in-lobby', 'countdown']),
      dwellSec: field.number(0, 86400),
    },
  },
  'room.join_failure': {
    version: 1, privacy: 'personal', fields: {
      code: field.enum(PLATFORM_ERROR_CODES),
      joinBlockedReason: field.enum(['room-password', 'room-full', 'team-full', 'sanctioned',
        'removed', 'in-progress', 'reservation-expired'], true),
    },
  },
  'match.handoff_failure': {
    version: 1, privacy: 'personal', fields: {
      stage: field.enum(['allocating', 'ticket', 'connect', 'welcome']),
      code: field.enum(PLATFORM_ERROR_CODES),
    },
  },
  'match.return_outcome': {
    version: 1, privacy: 'personal', fields: {
      outcome: field.enum(['completed', 'disconnected', 'kicked', 'aborted', 'grace-expired']),
      returnedToLobby: field.bool(),
    },
  },
  'connection.failure': {
    version: 1, privacy: 'personal', fields: {
      stage: field.enum(['platform', 'lobby', 'match']), code: field.enum(PLATFORM_ERROR_CODES),
    },
  },
  'settings.friction': {
    version: 1, privacy: 'personal', fields: {
      category: field.enum(SETTINGS_CATEGORY_IDS), duringFirstSession: field.bool(),
    },
  },
  'client.unsupported': {
    version: 1, privacy: 'internal', fields: {
      reason: field.enum(UNSUPPORTED_REASONS),
      browser: field.enum(['chrome', 'edge', 'firefox', 'safari', 'other']),
      browserMajor: field.number(0, 1000, true),
      os: field.enum(['windows', 'macos', 'linux', 'other']),
    },
  },
  'client.fps': {
    version: 1, privacy: 'internal', fields: {
      p50: field.number(0, 1000), p01: field.number(0, 1000), windowSec: field.number(1, 600),
    },
  },
  'client.frame_time': {
    version: 1, privacy: 'internal', fields: {
      p50Ms: field.number(0, 10000), p95Ms: field.number(0, 10000),
      p99Ms: field.number(0, 10000),
    },
  },
  'client.webgl_context_lost': {
    version: 1, privacy: 'internal', fields: {
      recovered: field.bool(), uptimeSec: field.number(0, 604800),
    },
  },
  'client.error': {
    version: 1, privacy: 'internal', fields: {
      errorClass: field.enum(CLIENT_ERROR_CLASSES), fatal: field.bool(),
    },
  },
  'client.asset_build': {
    version: 1, privacy: 'internal', fields: { ms: field.number(0, 600000) },
  },
  'client.heap': {
    version: 1, privacy: 'internal', fields: {
      usedMb: field.number(0, 65536), sampledAtSec: field.number(0, 604800),
    },
  },
  'client.net_health': {
    version: 1, privacy: 'internal', fields: {
      rttMs: field.number(0, 10000), jitterMs: field.number(0, 10000),
      lossPct: field.number(0, 100), correctionRatePerSec: field.number(0, 1000),
      snapshotAgeMs: field.number(0, 60000),
    },
  },
});

/**
 * Copies only allowlisted fields. Unknown fields (including raw messages and player-authored
 * strings) never enter sessionStorage.
 */
export function sanitizeTelemetryPayload(name, version, raw) {
  const spec = TELEMETRY_REGISTRY[name];
  if (!spec || version !== spec.version || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const payload = {};
  for (const [key, rule] of Object.entries(spec.fields)) {
    const value = raw[key];
    if (value === null) {
      if (!rule.nullable) return null;
      payload[key] = null;
    } else if (rule.type === 'boolean') {
      if (typeof value !== 'boolean') return null;
      payload[key] = value;
    } else if (rule.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < rule.min || value > rule.max
        || (rule.integer && !Number.isInteger(value))) return null;
      payload[key] = value;
    } else if (rule.type === 'enum') {
      if (typeof value !== 'string' || !rule.values.includes(value)) return null;
      payload[key] = value;
    } else return null;
  }
  if (spec.invariant && !spec.invariant(payload)) return null;
  return payload;
}
