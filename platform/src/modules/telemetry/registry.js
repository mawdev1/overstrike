/**
 * The client telemetry event registry.  contracts/telemetry.md §3.3.1.
 *
 * "The allowlist was referenced but never published, which left 'allowlisted' meaning
 * nothing." This is it, and it is executable rather than prose.
 *
 * Two rules the shape of this file enforces:
 *
 *  - **Privacy class is derived from `(name, version)` here.** The client does not send it.
 *    A client that declared its own class would declare everything `internal` the moment
 *    someone modified the bundle.
 *  - **Every payload is closed.** Unlisted keys are dropped before storage, not stored and
 *    filtered later — a filter is a promise about a query nobody has written yet.
 *
 * Numeric bounds are stated, and a value outside them is REJECTED, not clamped. A 900 000 ms
 * frame time is a bug in the sender; clamping it to the ceiling hides that bug in a dashboard.
 */
import { CODES } from '../../core/errors.js';

/** errors.md §3.1 — one enum, two consumers. Restated nowhere else. */
export const UNSUPPORTED_REASONS = [
  'build', 'browser-version', 'os-version', 'webgl2', 'pointer-lock',
  'websocket-binary', 'memory', 'vram', 'cpu-cores', 'mobile-or-tablet',
];

/** design/settings-inventory.md vocabulary version 1 — the 7 category IDs (§3.6). */
export const SETTINGS_CATEGORY_IDS = [
  'input', 'bindings', 'graphics', 'audioCaptions', 'crosshairHud', 'accessibility', 'network',
];
export const SETTINGS_VOCABULARY_VERSION = 1;

/** The closed error-class set maintained alongside the client error handler (§3.3.1). */
export const CLIENT_ERROR_CLASSES = [
  'webgl-init', 'asset-decode', 'net-decode', 'unhandled-rejection', 'render-loop', 'other',
];

/** Error codes are the contract's own set; restating them here is how the two would drift. */
const ERROR_CODES = Object.keys(CODES);

const enumF = (values, { nullable = false } = {}) => ({ kind: 'enum', values, nullable });
const boolF = () => ({ kind: 'bool', nullable: false });
const numF = (min, max, { integer = false } = {}) => ({ kind: 'number', min, max, integer, nullable: false });
const strEnumF = (values, { nullable = false } = {}) => ({ kind: 'enum', values, nullable });

/**
 * Retention comes from §5's stream table, not from the privacy class:
 *   funnel/KPI      -> standard (13 mo)   the P5 gate is answered from 13 months of funnel
 *   client health   -> short    (30 d)    a month of fps histograms is all a regression needs
 * `client.unsupported` is internal-class but funnel-stream, so it keeps `standard`. Giving it
 * 30 days would delete the top of the funnel before the gate that needs it, which is why class
 * and retention are two fields and not one.
 *
 * `funnel.preconsent` is the exception, and it is not a judgement call: §5 gives it its own row
 * — **internal, short (30 d)** — because it is the one stream collected from a visitor who has
 * not been asked yet. It used to sit on `standard` here and inherit 13 months from the personal
 * funnel row it no longer shares (REQ-CC-042). The amendment landed in the document and not in
 * the code, so an unlinked pre-consent count was being kept thirteen times as long as the
 * contract said, which is a retention breach that reads as a one-word typo.
 */
export const REGISTRY = new Map(Object.entries({
  'flow.step': {
    version: 1, privacyClass: 'personal', retentionClass: 'standard',
    fields: {
      // Begins at `signup`: every earlier step precedes the decision that authorises personal
      // telemetry (REQ-CC-039). `landing`/`eligibility`/`consent` belong to funnel.preconsent.
      step: enumF(['signup', 'signin', 'verify', 'terms', 'display-name', 'settings', 'browser',
        'lobby', 'ready', 'match', 'results']),
      outcome: enumF(['viewed', 'completed', 'failed']),
      errorCode: strEnumF(ERROR_CODES, { nullable: true }),
    },
    // errorCode is required when the step failed and must be null otherwise: a code on a
    // successful step is a sender bug, and a failure without one is an unactionable count.
    invariant: (p) => (p.outcome === 'failed'
      ? (p.errorCode ? null : 'errorCode is required when outcome is failed')
      : (p.errorCode === null ? null : 'errorCode must be null unless outcome is failed')),
  },
  'funnel.preconsent': {
    // §5: internal, SHORT (30 d). See the note above the registry.
    version: 1, privacyClass: 'internal', retentionClass: 'short',
    unlinked: true,   // §3.5.1 — see validate.js; this flag is what turns the rule on
    fields: {
      step: enumF(['landing', 'eligibility', 'consent']),
      outcome: enumF(['viewed', 'completed', 'failed']),
    },
    // "Never carries the decision value." The consent screen is counted; the answer never is,
    // which is why decline rate is explicitly unmeasurable (http-api.md §3a.5).
  },
  'session.first_match': {
    version: 1, privacyClass: 'personal', retentionClass: 'standard',
    fields: {
      completed: boolF(),
      // The Alpha mode freeze is TDM and Bomb (bomb-rules.md 1, modes.js). ffa/ctf/search
      // are from a mode set this project deliberately does not ship, so the registry was
      // rejecting the only two modes that exist and accepting three that do not.
      mode: enumF(['tdm', 'bomb']),
      timeToFirstMatchSec: numF(0, 86400),
    },
  },
  'lobby.abandoned': {
    version: 1, privacyClass: 'personal', retentionClass: 'standard',
    fields: {
      lastState: enumF(['browsing', 'joining', 'in-lobby', 'countdown']),
      dwellSec: numF(0, 86400),
    },
  },
  'room.join_failure': {
    version: 1, privacyClass: 'personal', retentionClass: 'standard',
    fields: {
      code: strEnumF(ERROR_CODES),
      joinBlockedReason: enumF(['room-password', 'room-full', 'team-full', 'sanctioned',
        'removed', 'in-progress', 'reservation-expired'], { nullable: true }),
    },
  },
  'match.handoff_failure': {
    version: 1, privacyClass: 'personal', retentionClass: 'standard',
    fields: {
      stage: enumF(['allocating', 'ticket', 'connect', 'welcome']),
      code: strEnumF(ERROR_CODES),
    },
  },
  'match.return_outcome': {
    version: 1, privacyClass: 'personal', retentionClass: 'standard',
    fields: {
      outcome: enumF(['completed', 'disconnected', 'kicked', 'aborted', 'grace-expired']),
      returnedToLobby: boolF(),
    },
  },
  'connection.failure': {
    version: 1, privacyClass: 'personal', retentionClass: 'standard',
    fields: {
      stage: enumF(['platform', 'lobby', 'match']),
      code: strEnumF(ERROR_CODES),
    },
  },
  'settings.friction': {
    version: 1, privacyClass: 'personal', retentionClass: 'standard',
    fields: {
      // A canonical category ID from vocabulary v1. Not a settings key, not a display label —
      // a label is localised copy and would arrive translated.
      category: enumF(SETTINGS_CATEGORY_IDS),
      duringFirstSession: boolF(),
    },
  },
  'client.unsupported': {
    version: 1, privacyClass: 'internal', retentionClass: 'standard',
    fields: {
      reason: enumF(UNSUPPORTED_REASONS),
      browser: enumF(['chrome', 'edge', 'firefox', 'safari', 'other']),
      browserMajor: numF(0, 1000, { integer: true }),
      os: enumF(['windows', 'macos', 'linux', 'other']),
    },
  },
  'client.fps': {
    version: 1, privacyClass: 'internal', retentionClass: 'short',
    fields: { p50: numF(0, 1000), p01: numF(0, 1000), windowSec: numF(1, 600) },
  },
  'client.frame_time': {
    version: 1, privacyClass: 'internal', retentionClass: 'short',
    fields: { p50Ms: numF(0, 10000), p95Ms: numF(0, 10000), p99Ms: numF(0, 10000) },
  },
  'client.webgl_context_lost': {
    version: 1, privacyClass: 'internal', retentionClass: 'short',
    fields: { recovered: boolF(), uptimeSec: numF(0, 604800) },
  },
  'client.error': {
    version: 1, privacyClass: 'internal', retentionClass: 'short',
    // Class only, never the raw message: raw strings routinely contain player-authored text
    // such as display names and chat (§3.5).
    fields: { errorClass: enumF(CLIENT_ERROR_CLASSES), fatal: boolF() },
  },
  'client.asset_build': {
    version: 1, privacyClass: 'internal', retentionClass: 'short',
    fields: { ms: numF(0, 600000) },
  },
  'client.heap': {
    version: 1, privacyClass: 'internal', retentionClass: 'short',
    fields: { usedMb: numF(0, 65536), sampledAtSec: numF(0, 604800) },
  },
  'client.net_health': {
    version: 1, privacyClass: 'internal', retentionClass: 'short',
    fields: {
      rttMs: numF(0, 10000), jitterMs: numF(0, 10000), lossPct: numF(0, 100),
      correctionRatePerSec: numF(0, 1000), snapshotAgeMs: numF(0, 60000),
    },
  },
}));

/** §3.3.1: the lookup is by (name, version). A version the server does not know is rejected. */
export function lookupEvent(name, version) {
  const spec = REGISTRY.get(name);
  if (!spec) return null;
  if (version !== spec.version) return null;
  return spec;
}

export const isPersonal = (name, version) => {
  const spec = lookupEvent(name, version);
  return !!spec && spec.privacyClass === 'personal';
};
