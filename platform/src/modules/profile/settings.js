/**
 * Roaming settings.  http-api.md §11.2 and §11.9, design/settings-inventory.md.
 *
 * Two rules carry all the weight here:
 *
 *  1. The allowlist is GENERATED from the inventory (`vocabulary.generated.js`). Nothing in
 *     this file names a setting key, a range, or an enum member.
 *  2. Out-of-range is REJECTED, never clamped. A clamped setting is a setting the player did
 *     not choose and cannot see they did not get — they rebind, it silently becomes something
 *     else, and the bug report is "my sensitivity keeps changing".
 *
 * Concurrency is optimistic and `If-Match` is REQUIRED: settings roam, so two tabs racing is
 * the normal case. A missing header is `CONFLICT` with `reason: "if-match-required"` and a
 * stale one is `CONFLICT` carrying the current state — never 428 (§3a.4: VALIDATION_FAILED is
 * always 400 and one code means one status).
 */
import { ApiError } from '../../core/errors.js';
import { VOCABULARY } from './vocabulary.generated.js';

export const SCHEMA_VERSION = 1;   // RoamingSettingsV1 against vocabulary version 1

/**
 * Binding wire values are KeyboardEvent `code`s plus a closed set of pointer codes. The
 * inventory documents defaults as human labels ("Left Shift"), which are display copy, so the
 * accepted value set is defined by shape here rather than copied from the doc.
 */
const CODE_RE = /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|F[1-9]|F1[0-2]|Arrow(Up|Down|Left|Right)|Mouse[1-5]|Wheel(Up|Down)|Space|Tab|Enter|Backspace|Escape|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Meta(Left|Right)|CapsLock|Backquote|Minus|Equal|Bracket(Left|Right)|Backslash|Semicolon|Quote|Comma|Period|Slash|Insert|Delete|Home|End|PageUp|PageDown)$/;

/** Browser/OS shortcuts the inventory says are rejected outright. */
const RESERVED_CODES = new Set(['Escape', 'F5', 'F11', 'F12', 'MetaLeft', 'MetaRight']);

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

/** Float-safe step check: 0.1+0.2 style error must not reject a value the UI can produce. */
function onStep(value, min, step) {
  if (!(step > 0)) return true;
  const steps = (value - min) / step;
  return Math.abs(steps - Math.round(steps)) < 1e-6;
}

function checkValue(key, spec, value, errors) {
  if (spec.kind === 'boolean') {
    if (typeof value !== 'boolean') errors.push({ key, reason: 'type', expected: 'boolean' });
    return;
  }
  if (spec.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push({ key, reason: 'type', expected: 'number' });
      return;
    }
    if (value < spec.min || value > spec.max) {
      errors.push({ key, reason: 'range', min: spec.min, max: spec.max, got: value });
      return;
    }
    if (!onStep(value, spec.min, spec.step)) {
      errors.push({ key, reason: 'step', step: spec.step, got: value });
    }
    return;
  }
  if (spec.kind === 'enum') {
    if (!spec.values.includes(value)) {
      errors.push({ key, reason: 'enum', allowed: spec.values, got: value });
    }
    return;
  }
  if (spec.kind === 'color') {
    if (typeof value !== 'string' || !HEX_RE.test(value)) {
      errors.push({ key, reason: 'color', got: value });
    }
    return;
  }
  errors.push({ key, reason: 'unsupported-kind' });
}

function checkKeybinds(binds, vocab, errors) {
  if (binds === null || typeof binds !== 'object' || Array.isArray(binds)) {
    errors.push({ key: 'keybinds', reason: 'type', expected: 'object' });
    return;
  }
  const seen = new Map();   // code -> action, so a conflict cannot be stored
  for (const [action, entry] of Object.entries(binds)) {
    const def = vocab.keybinds[action];
    if (!def) { errors.push({ key: `keybinds.${action}`, reason: 'unknown-binding-action' }); continue; }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push({ key: `keybinds.${action}`, reason: 'type', expected: '{primary, secondary?}' });
      continue;
    }
    for (const k of Object.keys(entry)) {
      if (k !== 'primary' && k !== 'secondary') {
        errors.push({ key: `keybinds.${action}.${k}`, reason: 'unknown-field' });
      }
    }
    if (!('primary' in entry)) {
      errors.push({ key: `keybinds.${action}.primary`, reason: 'required' });
      continue;
    }
    // `pause` is reserved to Escape by the inventory and cannot be rebound; accepting a write
    // that the client must then ignore is a stored value that disagrees with the game.
    if (def.reserved) {
      if (entry.primary !== 'Escape' || (entry.secondary ?? null) !== null) {
        errors.push({ key: `keybinds.${action}`, reason: 'reserved-action' });
      }
      continue;
    }
    for (const slot of ['primary', 'secondary']) {
      const code = slot in entry ? entry[slot] : null;
      if (code === null) continue;          // unbound is legal — several actions ship unbound
      if (typeof code !== 'string' || !CODE_RE.test(code)) {
        errors.push({ key: `keybinds.${action}.${slot}`, reason: 'invalid-code', got: code });
        continue;
      }
      if (RESERVED_CODES.has(code)) {
        errors.push({ key: `keybinds.${action}.${slot}`, reason: 'reserved-code', got: code });
        continue;
      }
      if (seen.has(code)) {
        // The client resolves conflicts explicitly (SWAP / UNBIND OTHER / CANCEL). A duplicate
        // arriving here means that step was skipped, and storing it loses a binding silently.
        errors.push({ key: `keybinds.${action}.${slot}`, reason: 'conflict', with: seen.get(code), code });
        continue;
      }
      seen.set(code, action);
    }
  }
}

/**
 * Validate a submitted `values` object against RoamingSettingsV1.
 * @returns {{errors: Array<object>}} — caller decides whether to throw.
 */
export function validateRoamingSettings(values, vocab = VOCABULARY) {
  const errors = [];
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    return { errors: [{ key: 'values', reason: 'type', expected: 'object' }] };
  }
  for (const [key, value] of Object.entries(values)) {
    if (key === 'keybinds') { checkKeybinds(value, vocab, errors); continue; }
    const spec = vocab.roam[key];
    if (!spec) {
      // A DEVICE/SESSION/PRACTICE key is a *known* key in the wrong scope. Saying so is the
      // difference between a client bug that is fixable and one that looks like a typo.
      const scope = vocab.scopes[key];
      errors.push(scope && scope !== 'ROAM'
        ? { key, reason: 'scope-not-roaming', scope }
        : { key, reason: 'unknown-key' });
      continue;
    }
    checkValue(key, spec, value, errors);
  }
  return { errors };
}

/** The full ROAM set at its documented defaults. `keybinds` starts empty: the client owns the
 * default bindings (the inventory records them as display labels, not wire codes). */
export function defaultRoamingValues(vocab = VOCABULARY) {
  const out = {};
  for (const [key, spec] of Object.entries(vocab.roam)) {
    if (spec.default !== null) out[key] = spec.default;
  }
  out.keybinds = {};
  return out;
}

export const etagFor = (version) => `"${version}"`;

/** `If-Match: "7"` — quotes optional in practice, `*` means "whatever is there now". */
function parseIfMatch(header) {
  if (header === undefined || header === null) return null;
  const raw = String(header).trim();
  if (!raw) return null;
  if (raw === '*') return '*';
  const m = raw.match(/^(?:W\/)?"?(\d+)"?$/);
  return m ? Number(m[1]) : NaN;
}

export function createSettingsService({ store, clock = Date, vocab = VOCABULARY }) {
  async function read(accountId) {
    const profile = await store.profiles.byAccountId(accountId);
    const version = profile?.settingsVersion ?? 1;
    const values = profile?.roamingSettings ?? defaultRoamingValues(vocab);
    return {
      schemaVersion: SCHEMA_VERSION,
      version,
      values,
      updatedAt: profile?.updatedAt ?? null,
    };
  }

  /**
   * Full replace. Absent ROAM keys revert to their documented default — that is what "full
   * replace" means, and a partial merge would make a reset-to-default unexpressible.
   */
  async function replace(accountId, { schemaVersion, values }, ifMatchHeader) {
    const current = await read(accountId);

    const expected = parseIfMatch(ifMatchHeader);
    if (expected === null) {
      throw new ApiError('CONFLICT', 'If-Match is required on settings writes.', {
        details: { reason: 'if-match-required' },
      });
    }
    if (Number.isNaN(expected)) {
      throw new ApiError('CONFLICT', 'If-Match is not a settings version.', {
        details: { reason: 'if-match-required' },
      });
    }
    if (expected !== '*' && expected !== current.version) {
      // Return the current state so the UI can merge instead of re-fetching and racing again.
      throw new ApiError('CONFLICT', 'Settings changed on another device.', {
        details: { currentVersion: current.version, values: current.values },
      });
    }

    if (schemaVersion !== SCHEMA_VERSION) {
      throw new ApiError('VALIDATION_FAILED', 'Unsupported settings schema version.', {
        details: { fields: [{ key: 'schemaVersion', reason: 'unsupported', expected: SCHEMA_VERSION }] },
      });
    }

    const { errors } = validateRoamingSettings(values, vocab);
    if (errors.length) {
      throw new ApiError('VALIDATION_FAILED', 'One or more settings were rejected.', {
        details: { fields: errors },
      });
    }

    const merged = { ...defaultRoamingValues(vocab), ...values };
    merged.keybinds = values.keybinds ?? {};
    const updatedAt = new Date(clock.now()).toISOString();
    const saved = await store.profiles.upsert(accountId, {
      roamingSettings: merged,
      settingsVersion: current.version + 1,
      updatedAt,
    });

    return {
      schemaVersion: SCHEMA_VERSION,
      version: saved.settingsVersion,
      values: saved.roamingSettings,
      updatedAt: saved.updatedAt,
    };
  }

  return { read, replace, vocab };
}
