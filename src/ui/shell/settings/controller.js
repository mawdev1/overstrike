import { mouseCode } from '../../../core/mouseCodes.js';
import {
  BINDING_ACTIONS,
  BINDINGS_BY_ID,
  RESERVED_BINDING_CODES,
  SETTINGS_BY_KEY,
  SETTINGS_CATEGORIES,
  SETTINGS_INVENTORY,
  LOCAL_SETTINGS_SCHEMA_VERSION,
  ROAMING_SETTINGS_SCHEMA_VERSION,
  bindingCodeLabel,
  defaultBindings,
  defaultsForScope,
  isRecognizedBindingCode,
  validateSettingValue,
} from './inventory.js';

export const SETTINGS_STORAGE_KEYS = Object.freeze({
  ROAM: 'overstrike.shell.settings.roam.v2',
  DEVICE: 'overstrike.shell.settings.device.v2',
  PRACTICE: 'overstrike.shell.settings.practice.v2',
  LEGACY: 'overstrike.settings.v1',
});

const PERSISTED_SCOPES = Object.freeze(['ROAM', 'DEVICE', 'PRACTICE']);
const ALL_SCOPES = Object.freeze(['ROAM', 'DEVICE', 'SESSION', 'PRACTICE']);
const CAPTURE_TIMEOUT_MS = 10_000;
const SYNC_DEBOUNCE_MS = 400;

export const SESSION_DIAGNOSTIC_KEYS = Object.freeze([
  'sampledAt', 'windowMs', 'region', 'serverBuild', 'protocolVersion',
  'rttMs', 'jitterMs', 'lossPct', 'correctionRatePerSec', 'correctionMagnitudeM',
  'snapshotAgeMs', 'receiveRateHz', 'baselineState', 'keyframes', 'discarded',
]);

const NON_NEGATIVE_DIAGNOSTICS = new Set([
  'sampledAt', 'rttMs', 'jitterMs', 'correctionRatePerSec', 'correctionMagnitudeM',
  'snapshotAgeMs', 'receiveRateHz',
]);
const INTEGER_DIAGNOSTICS = new Set(['protocolVersion', 'keyframes', 'discarded']);

/** Retain only the measured, privacy-safe `net.netStats` projection from net-facade.md §5.2. */
export function sanitizeSessionDiagnostics(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const clean = {};
  for (const key of SESSION_DIAGNOSTIC_KEYS) {
    if (!Object.hasOwn(input, key)) continue;
    let value;
    try { value = input[key]; } catch { continue; }
    if (value === undefined || value === null) continue;
    if (NON_NEGATIVE_DIAGNOSTICS.has(key)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) clean[key] = value;
    } else if (INTEGER_DIAGNOSTICS.has(key)) {
      if (Number.isSafeInteger(value) && value >= 0) clean[key] = value;
    } else if (key === 'windowMs') {
      if (value === 5000) clean[key] = value;
    } else if (key === 'lossPct') {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100) clean[key] = value;
    } else if (key === 'baselineState') {
      if (['synced', 'keyframe-pending', 'lost'].includes(value)) clean[key] = value;
    } else if (key === 'region') {
      if (typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(value)) clean[key] = value;
    } else if (key === 'serverBuild') {
      if (typeof value === 'string' && value.length > 0 && value.length <= 64
        && /^[A-Za-z0-9._+-]+$/.test(value)) clean[key] = value;
    }
  }
  return Object.keys(clean).length ? clean : null;
}

function copy(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function safeStorage(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function scopeDefaults() {
  return Object.fromEntries(ALL_SCOPES.map((scope) => [scope, defaultsForScope(scope)]));
}

function migratedValue(definition, value) {
  if (validateSettingValue(definition, value)) return value;
  if (definition.type === 'number' && typeof value === 'number') {
    if (
      value >= 0
      && value <= 2
      && (definition.unit === '%' || ['renderScale', 'hudScale'].includes(definition.key))
    ) {
      const scaled = Math.round((value * 100) / definition.step) * definition.step;
      if (validateSettingValue(definition, scaled)) return scaled;
    }
    const clamped = Math.min(definition.max, Math.max(definition.min, value));
    const stepped = definition.min + Math.round((clamped - definition.min) / definition.step) * definition.step;
    if (validateSettingValue(definition, stepped)) return stepped;
  }
  if (definition.key === 'toggleAds' && typeof value === 'boolean') return value ? 'toggle' : 'hold';
  if (definition.key === 'toggleCrouch' && typeof value === 'boolean') return value ? 'toggle' : 'hold';
  if (definition.key === 'filmGrain' && typeof value === 'boolean') return value ? 100 : 0;
  return undefined;
}

function bindingOwner(bindings, code, exceptAction, exceptSlot) {
  if (!code) return null;
  for (const action of BINDING_ACTIONS) {
    for (const slot of ['primary', 'secondary']) {
      if (action.id === exceptAction && slot === exceptSlot) continue;
      if (bindings[action.id]?.[slot] === code) return { actionId: action.id, slot };
    }
  }
  return null;
}

function bindingOwnerOutsideAction(bindings, code, actionId) {
  if (!code) return null;
  for (const action of BINDING_ACTIONS) {
    if (action.id === actionId) continue;
    for (const slot of ['primary', 'secondary']) {
      if (bindings[action.id]?.[slot] === code) return { actionId: action.id, slot };
    }
  }
  return null;
}

function repairBindings(raw, repairs) {
  const bindings = defaultBindings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (raw !== undefined) repairs.push({ scope: 'ROAM', key: 'bindings', reason: 'invalid container' });
    return bindings;
  }

  for (const action of BINDING_ACTIONS) {
    const candidate = raw[action.id];
    if (candidate === undefined) continue;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      repairs.push({ scope: 'ROAM', key: `bindings.${action.id}`, reason: 'invalid action binding' });
      continue;
    }
    if (action.fixed) {
      if (candidate.primary !== action.primary || candidate.secondary != null) {
        repairs.push({ scope: 'ROAM', key: `bindings.${action.id}`, reason: 'fixed binding restored' });
      }
      continue;
    }
    const repaired = {};
    for (const slot of ['primary', 'secondary']) {
      const code = candidate[slot];
      if (code === null || code === undefined || code === '') {
        repaired[slot] = null;
      } else if (isRecognizedBindingCode(code) && !RESERVED_BINDING_CODES.has(code)) {
        repaired[slot] = code;
      } else {
        repaired[slot] = bindings[action.id][slot];
        repairs.push({ scope: 'ROAM', key: `bindings.${action.id}.${slot}`, reason: 'invalid or reserved code' });
      }
    }
    bindings[action.id] = repaired;
  }

  const occupied = new Map();
  for (const action of BINDING_ACTIONS) {
    for (const slot of ['primary', 'secondary']) {
      const code = bindings[action.id][slot];
      if (!code) continue;
      const owner = occupied.get(code);
      if (owner) {
        const fallback = defaultBindings()[action.id][slot];
        if (fallback && !occupied.has(fallback) && !RESERVED_BINDING_CODES.has(fallback)) {
          bindings[action.id][slot] = fallback;
          occupied.set(fallback, { actionId: action.id, slot });
        } else {
          bindings[action.id][slot] = null;
        }
        repairs.push({ scope: 'ROAM', key: `bindings.${action.id}.${slot}`, reason: 'duplicate binding' });
      } else {
        occupied.set(code, { actionId: action.id, slot });
      }
    }
  }
  const required = BINDING_ACTIONS.filter((item) => item.required);
  for (let pass = 0; pass < required.length; pass++) {
    for (const action of required) {
      if (bindings[action.id].primary || bindings[action.id].secondary) continue;
      const fallback = action.primary;
      const owner = bindingOwner(bindings, fallback, action.id, 'primary');
      if (owner) bindings[owner.actionId][owner.slot] = null;
      bindings[action.id].primary = fallback;
      repairs.push({ scope: 'ROAM', key: `bindings.${action.id}`, reason: 'required action restored' });
    }
  }
  bindings.pause = { primary: 'Escape', secondary: null };
  return bindings;
}

function normalizeDocument(rawText, scope, repairs) {
  let parsed;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    repairs.push({ scope, key: '*', reason: 'malformed JSON' });
    parsed = null;
  }
  const values = defaultsForScope(scope);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const source = parsed.values && typeof parsed.values === 'object' ? parsed.values : parsed;
    for (const definition of SETTINGS_INVENTORY.filter((item) => item.scope === scope)) {
      if (!(definition.key in source)) continue;
      const value = parsed.schemaVersion === LOCAL_SETTINGS_SCHEMA_VERSION
        ? (validateSettingValue(definition, source[definition.key]) ? source[definition.key] : undefined)
        : migratedValue(definition, source[definition.key]);
      if (value === undefined) {
        repairs.push({ scope, key: definition.key, reason: 'invalid value' });
      } else {
        values[definition.key] = value;
      }
    }
    for (const key of Object.keys(source)) {
      if (!SETTINGS_BY_KEY[key] || SETTINGS_BY_KEY[key].scope !== scope) {
        repairs.push({ scope, key, reason: 'unknown or wrong-scope key' });
      }
    }
    if (parsed.schemaVersion !== LOCAL_SETTINGS_SCHEMA_VERSION) {
      repairs.push({ scope, key: 'schemaVersion', reason: 'schema upgraded' });
    }
  }
  return {
    values,
    bindings: scope === 'ROAM' ? repairBindings(parsed?.bindings, repairs) : undefined,
    version: scope === 'ROAM' && Number.isInteger(parsed?.version) && parsed.version >= 0 ? parsed.version : null,
  };
}

function migrateLegacy(storage, documents, repairs) {
  if (!storage || PERSISTED_SCOPES.some((scope) => documents[scope].exists)) return;
  let legacy;
  try {
    const text = storage.getItem(SETTINGS_STORAGE_KEYS.LEGACY);
    if (!text) return;
    legacy = JSON.parse(text);
  } catch {
    repairs.push({ scope: 'DEVICE', key: 'legacy', reason: 'legacy document unreadable' });
    return;
  }
  if (!legacy || typeof legacy !== 'object') return;
  for (const definition of SETTINGS_INVENTORY) {
    if (definition.scope === 'SESSION' || !(definition.key in legacy)) continue;
    const value = migratedValue(definition, legacy[definition.key]);
    if (value !== undefined) documents[definition.scope].values[definition.key] = value;
  }
  if (legacy.binds && typeof legacy.binds === 'object') {
    const next = defaultBindings();
    const slots = Object.fromEntries(BINDING_ACTIONS.map((action) => [action.id, []]));
    for (const [code, actionId] of Object.entries(legacy.binds)) {
      if (BINDINGS_BY_ID[actionId] && isRecognizedBindingCode(code) && !RESERVED_BINDING_CODES.has(code)) {
        slots[actionId].push(code);
      }
    }
    for (const action of BINDING_ACTIONS) {
      if (action.fixed || !slots[action.id].length) continue;
      next[action.id] = { primary: slots[action.id][0] || null, secondary: slots[action.id][1] || null };
    }
    documents.ROAM.bindings = repairBindings(next, repairs);
  }
  repairs.push({ scope: 'DEVICE', key: 'legacy', reason: 'legacy settings migrated' });
}

function captureCode(input) {
  if (typeof input === 'string') return input;
  if (!input) return null;
  if (input.type === 'wheel') return input.deltaY < 0 ? 'WheelUp' : 'WheelDown';
  if (input.type === 'mousedown' || input.type === 'pointerdown') {
    return mouseCode(input.button);
  }
  return input.code || null;
}

function normalizeRemoteRoaming(input, repairs = []) {
  const envelope = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const source = envelope.values && typeof envelope.values === 'object' && !Array.isArray(envelope.values)
    ? envelope.values
    : envelope;
  const values = defaultsForScope('ROAM');
  for (const definition of SETTINGS_INVENTORY.filter((item) => item.scope === 'ROAM')) {
    if (!(definition.key in source)) continue;
    if (validateSettingValue(definition, source[definition.key])) {
      values[definition.key] = source[definition.key];
    } else {
      repairs.push({ scope: 'ROAM', key: definition.key, reason: 'invalid remote value' });
    }
  }
  const rawBindings = envelope.bindings ?? source.keybinds;
  const bindings = repairBindings(rawBindings, repairs);
  const candidateVersion = envelope.version ?? envelope.currentVersion;
  return {
    values,
    bindings,
    version: Number.isInteger(candidateVersion) && candidateVersion >= 0 ? candidateVersion : null,
  };
}

export function createSettingsController(options = {}) {
  const storage = safeStorage(options.storage);
  const eventTarget = options.eventTarget || (typeof window !== 'undefined' ? window : null);
  const clock = options.clock || globalThis;
  const syncDebounceMs = options.syncDebounceMs ?? SYNC_DEBOUNCE_MS;
  if (!Number.isFinite(syncDebounceMs) || syncDebounceMs < 0) {
    throw new TypeError('syncDebounceMs must be a non-negative number.');
  }
  const repairs = [];
  const base = scopeDefaults();
  const documents = {};
  let storageAvailable = Boolean(storage);

  for (const scope of PERSISTED_SCOPES) {
    let text = null;
    try {
      text = storage?.getItem(SETTINGS_STORAGE_KEYS[scope]) || null;
    } catch {
      storageAvailable = false;
    }
    documents[scope] = { ...normalizeDocument(text, scope, repairs), exists: Boolean(text) };
  }
  migrateLegacy(storage, documents, repairs);

  const values = {
    ...base,
    ROAM: documents.ROAM.values,
    DEVICE: documents.DEVICE.values,
    PRACTICE: documents.PRACTICE.values,
    SESSION: { ...base.SESSION, ...(options.initialSession || {}) },
  };
  let bindings = documents.ROAM.bindings;
  const firstRoamRun = !documents.ROAM.exists && !repairs.some((entry) => entry.reason === 'legacy settings migrated');
  if (firstRoamRun && options.prefersReducedMotion === true) {
    values.ROAM.reduceMotion = true;
    values.ROAM.cameraShake = 25;
    values.ROAM.viewBob = 0;
    values.ROAM.weaponSway = 35;
  }

  let state = {
    category: SETTINGS_CATEGORIES[0].id,
    search: '',
    online: options.online ?? (typeof navigator === 'undefined' ? true : navigator.onLine),
    storageAvailable,
    sync: {
      status: 'synced',
      version: documents.ROAM.version,
      conflict: null,
      lastError: null,
    },
    capture: null,
    bindingConflict: null,
    requiredUnbind: null,
    notice: repairs.length ? 'Invalid saved values were repaired.' : null,
    repairs,
  };
  const listeners = new Set();
  let captureTimer = null;
  let syncTimer = null;
  let roamingRevision = 0;
  let syncFlight = null;
  let destroyed = false;

  function writeScope(scope) {
    if (!storage || !PERSISTED_SCOPES.includes(scope)) return false;
    const document = {
      schemaVersion: LOCAL_SETTINGS_SCHEMA_VERSION,
      scope,
      values: values[scope],
      updatedAt: new Date().toISOString(),
    };
    if (scope === 'ROAM') {
      document.bindings = bindings;
      document.version = state.sync.version;
      document.syncStatus = state.sync.status;
    }
    try {
      storage.setItem(SETTINGS_STORAGE_KEYS[scope], JSON.stringify(document));
      state.storageAvailable = true;
      return true;
    } catch {
      state.storageAvailable = false;
      state.notice = 'Settings could not be saved on this device.';
      return false;
    }
  }

  if (repairs.length || firstRoamRun) {
    for (const scope of PERSISTED_SCOPES) writeScope(scope);
  }

  function snapshot() {
    const flattened = Object.assign({}, ...ALL_SCOPES.map((scope) => values[scope]));
    const query = state.search.trim().toLowerCase();
    const settings = SETTINGS_INVENTORY.filter((definition) => {
      if (!query) return definition.category === state.category;
      const text = [definition.key, definition.label, ...(definition.synonyms || [])].join(' ').toLowerCase();
      return text.includes(query);
    });
    const bindingRows = BINDING_ACTIONS.filter((action) => {
      if (!query) return state.category === 'bindings';
      const codes = Object.values(bindings[action.id] || {}).filter(Boolean);
      const codeLabels = codes.map(bindingCodeLabel);
      const text = [action.id, action.label, ...(action.synonyms || []), ...codes, ...codeLabels].join(' ').toLowerCase();
      return text.includes(query);
    });
    return copy({
      ...state,
      values: flattened,
      byScope: values,
      bindings,
      visibleSettings: settings,
      visibleBindings: bindingRows,
    });
  }

  function emit() {
    if (destroyed) return;
    const current = snapshot();
    for (const listener of listeners) listener(current);
  }

  function dirtyRoaming() {
    roamingRevision += 1;
    if (state.sync.status === 'conflict' && state.sync.conflict) {
      state.sync.conflict.local = {
        values: copy(values.ROAM), bindings: copy(bindings), version: state.sync.version,
      };
      state.sync.lastError = null;
      return;
    }
    state.sync.status = state.online ? 'unsynced' : 'offline-unsynced';
    state.sync.lastError = null;
    scheduleSync();
  }

  function clearSyncTimer() {
    if (syncTimer != null) clock.clearTimeout?.(syncTimer);
    syncTimer = null;
  }

  function scheduleSync() {
    if (destroyed || !state.online || !options.syncAdapter?.save
      || state.sync.status !== 'unsynced' || state.sync.lastError) return;
    clearSyncTimer();
    syncTimer = clock.setTimeout?.(() => {
      syncTimer = null;
      void controller.sync();
    }, syncDebounceMs);
  }

  function applyValue(key, value, definition = SETTINGS_BY_KEY[key]) {
    try {
      options.onApply?.(key, copy(value), definition);
    } catch {
      state.notice = `${definition?.label || 'Settings'} were saved but could not be applied immediately.`;
    }
  }

  function applyBindings() {
    applyValue('keybinds', bindings, {
      key: 'keybinds', category: 'bindings', scope: 'ROAM', type: 'bindings', label: 'Bindings',
    });
  }

  function applyRoamingChanges(previousValues, previousBindings) {
    for (const definition of SETTINGS_INVENTORY.filter((item) => item.scope === 'ROAM')) {
      if (!Object.is(previousValues[definition.key], values.ROAM[definition.key])) {
        applyValue(definition.key, values.ROAM[definition.key], definition);
      }
    }
    if (JSON.stringify(previousBindings) !== JSON.stringify(bindings)) applyBindings();
  }

  function mutateSetting(key, value, { silent = false } = {}) {
    const definition = SETTINGS_BY_KEY[key];
    if (!definition) return { ok: false, error: 'unknown-setting' };
    if (definition.readOnly) return { ok: false, error: 'read-only' };
    if (!validateSettingValue(definition, value)) return { ok: false, error: 'invalid-value' };
    if (Object.is(values[definition.scope][key], value)) return { ok: true, changed: false };
    values[definition.scope][key] = value;
    if (definition.scope === 'ROAM') dirtyRoaming();
    if (definition.scope !== 'SESSION') writeScope(definition.scope);
    applyValue(key, value, definition);
    if (!silent) emit();
    return { ok: true, changed: true };
  }

  function persistBindings({ apply = true } = {}) {
    dirtyRoaming();
    writeScope('ROAM');
    if (apply) applyBindings();
  }

  function resetConflictState(plan, index) {
    const item = plan.conflicts[index];
    return {
      code: item.code,
      actionId: plan.actionId,
      slot: item.slot,
      previousCode: item.previousCode,
      otherActionId: item.otherActionId,
      otherSlot: item.otherSlot,
      resetPlan: { ...plan, index },
    };
  }

  function stopTimer() {
    if (captureTimer != null) clock.clearTimeout?.(captureTimer);
    captureTimer = null;
  }

  function cancelCapture(reason = 'cancelled') {
    if (!state.capture && !state.bindingConflict) return false;
    stopTimer();
    state.capture = null;
    state.bindingConflict = null;
    state.notice = reason === 'timeout' ? 'Binding capture timed out.' : null;
    emit();
    return true;
  }

  const controller = {
    getSnapshot: snapshot,
    get(key) {
      const direct = SETTINGS_BY_KEY[key];
      if (direct) return values[direct.scope][direct.key];
      const suffix = String(key || '').split('.').at(-1);
      const definition = SETTINGS_BY_KEY[suffix];
      return definition ? values[definition.scope][definition.key] : undefined;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Settings subscriber must be a function.');
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    setCategory(category) {
      if (!SETTINGS_CATEGORIES.some((item) => item.id === category)) return false;
      state.category = category;
      state.search = '';
      emit();
      return true;
    },
    setSearch(query) {
      state.search = String(query || '');
      emit();
    },
    set(key, value) {
      return mutateSetting(key, value);
    },
    applyReducedMotionPreset() {
      mutateSetting('reduceMotion', true, { silent: true });
      mutateSetting('cameraShake', 25, { silent: true });
      mutateSetting('viewBob', 0, { silent: true });
      mutateSetting('weaponSway', 35, { silent: true });
      state.notice = 'Reduced-motion preset applied.';
      emit();
    },
    previewReset(request = {}) {
      const definitions = SETTINGS_INVENTORY.filter((definition) => {
        if (definition.readOnly) return false;
        if (request.key) return definition.key === request.key;
        if (request.category) return definition.category === request.category;
        if (request.scope) return definition.scope === request.scope;
        return true;
      });
      const changes = definitions
        .filter((definition) => !Object.is(values[definition.scope][definition.key], definition.defaultValue))
        .map((definition) => ({
          key: definition.key,
          label: definition.label,
          scope: definition.scope,
          from: values[definition.scope][definition.key],
          to: definition.defaultValue,
        }));
      if ((!request.category || request.category === 'bindings') && !request.key && !request.scope) {
        for (const action of BINDING_ACTIONS) {
          const defaults = { primary: action.primary, secondary: action.secondary };
          if (JSON.stringify(bindings[action.id]) !== JSON.stringify(defaults)) {
            changes.push({ key: `binding:${action.id}`, label: action.label, scope: 'ROAM', from: bindings[action.id], to: defaults });
          }
        }
      }
      return { changes, scopes: [...new Set(changes.map((item) => item.scope))] };
    },
    reset(request = {}) {
      const preview = controller.previewReset(request);
      let bindingsChanged = false;
      for (const change of preview.changes) {
        if (change.key.startsWith('binding:')) {
          const actionId = change.key.slice(8);
          bindings[actionId] = { ...change.to };
          bindingsChanged = true;
        } else {
          const definition = SETTINGS_BY_KEY[change.key];
          values[definition.scope][definition.key] = definition.defaultValue;
          try { options.onApply?.(definition.key, definition.defaultValue, definition); } catch {}
        }
      }
      if (preview.scopes.includes('ROAM')) dirtyRoaming();
      for (const scope of preview.scopes.filter((item) => item !== 'SESSION')) writeScope(scope);
      if (bindingsChanged) applyBindings();
      state.notice = preview.changes.length ? `Reset ${preview.changes.length} setting${preview.changes.length === 1 ? '' : 's'}.` : 'Nothing needed resetting.';
      emit();
      return preview;
    },
    beginCapture(actionId, slot = 'primary', timeoutMs = CAPTURE_TIMEOUT_MS) {
      const action = BINDINGS_BY_ID[actionId];
      if (!action || !['primary', 'secondary'].includes(slot)) return { ok: false, error: 'unknown-binding' };
      if (action.fixed) {
        state.notice = 'Pause is fixed to Escape and cannot be changed.';
        emit();
        return { ok: false, error: 'fixed-binding' };
      }
      stopTimer();
      state.requiredUnbind = null;
      state.bindingConflict = null;
      state.capture = {
        actionId,
        slot,
        deadline: Date.now() + timeoutMs,
        error: null,
      };
      captureTimer = clock.setTimeout?.(() => cancelCapture('timeout'), timeoutMs);
      emit();
      return { ok: true };
    },
    cancelCapture,
    handleCaptureInput(input) {
      if (!state.capture) return { ok: false, error: 'not-capturing' };
      const code = captureCode(input);
      if (code === 'Escape') {
        cancelCapture('cancelled');
        return { ok: false, error: 'cancelled' };
      }
      if (
        !code
        || !isRecognizedBindingCode(code)
        || RESERVED_BINDING_CODES.has(code)
        || (typeof input === 'object' && (input.metaKey || input.altKey || input.ctrlKey) && !/^(Control|Alt|Meta)(Left|Right)$/.test(code))
      ) {
        state.capture.error = 'That key or browser shortcut is reserved.';
        emit();
        return { ok: false, error: 'reserved' };
      }
      const { actionId, slot } = state.capture;
      const owner = bindingOwner(bindings, code, actionId, slot);
      stopTimer();
      if (owner) {
        state.bindingConflict = {
          code,
          actionId,
          slot,
          previousCode: bindings[actionId][slot],
          otherActionId: owner.actionId,
          otherSlot: owner.slot,
        };
        state.capture = null;
        emit();
        return { ok: false, error: 'conflict', conflict: copy(state.bindingConflict) };
      }
      bindings[actionId][slot] = code;
      state.capture = null;
      state.notice = null;
      persistBindings();
      emit();
      return { ok: true };
    },
    resolveBindingConflict(choice) {
      const conflict = state.bindingConflict;
      if (!conflict) return { ok: false, error: 'no-conflict' };
      if (choice === 'CANCEL') {
        state.bindingConflict = null;
        emit();
        return { ok: true, changed: false };
      }
      if (!['SWAP', 'UNBIND_OTHER'].includes(choice)) return { ok: false, error: 'invalid-choice' };
      if (conflict.resetPlan) {
        const plan = copy(conflict.resetPlan);
        plan.decisions = [...(plan.decisions || []), choice];
        const nextIndex = plan.index + 1;
        if (nextIndex < plan.conflicts.length) {
          state.bindingConflict = resetConflictState(plan, nextIndex);
          emit();
          return { ok: true, changed: false, pending: true };
        }
        bindings[plan.actionId] = { ...plan.desired };
        plan.conflicts.forEach((item, index) => {
          bindings[item.otherActionId][item.otherSlot] = plan.decisions[index] === 'SWAP'
            ? (item.previousCode || null)
            : null;
        });
        state.bindingConflict = null;
        persistBindings();
        emit();
        return { ok: true, changed: true };
      }
      bindings[conflict.actionId][conflict.slot] = conflict.code;
      bindings[conflict.otherActionId][conflict.otherSlot] = choice === 'SWAP' ? (conflict.previousCode || null) : null;
      state.bindingConflict = null;
      persistBindings();
      emit();
      return { ok: true, changed: true };
    },
    clearBinding(actionId, slot, { confirmRequired = false } = {}) {
      const action = BINDINGS_BY_ID[actionId];
      if (!action || !['primary', 'secondary'].includes(slot)) return { ok: false, error: 'unknown-binding' };
      if (action.fixed) return { ok: false, error: 'fixed-binding' };
      if (!bindings[actionId][slot]) return { ok: true, changed: false };
      const otherSlot = slot === 'primary' ? 'secondary' : 'primary';
      if (action.required && !bindings[actionId][otherSlot] && !confirmRequired) {
        state.requiredUnbind = { actionId, slot };
        emit();
        return { ok: false, error: 'confirmation-required' };
      }
      bindings[actionId][slot] = null;
      state.requiredUnbind = null;
      persistBindings();
      emit();
      return { ok: true, changed: true };
    },
    cancelRequiredUnbind() {
      state.requiredUnbind = null;
      emit();
    },
    resetBinding(actionId) {
      const action = BINDINGS_BY_ID[actionId];
      if (!action) return false;
      const desired = { primary: action.primary, secondary: action.secondary };
      if (JSON.stringify(bindings[actionId]) === JSON.stringify(desired)) return true;
      const conflicts = [];
      for (const slot of ['primary', 'secondary']) {
        const code = desired[slot];
        const owner = bindingOwnerOutsideAction(bindings, code, actionId);
        if (owner) conflicts.push({
          code,
          slot,
          previousCode: bindings[actionId][slot],
          otherActionId: owner.actionId,
          otherSlot: owner.slot,
        });
      }
      if (conflicts.length) {
        const plan = { actionId, desired, conflicts, decisions: [], index: 0 };
        state.bindingConflict = resetConflictState(plan, 0);
        emit();
        return { ok: false, error: 'conflict', conflict: copy(state.bindingConflict) };
      }
      bindings[actionId] = desired;
      persistBindings();
      emit();
      return true;
    },
    setOnline(online) {
      state.online = Boolean(online);
      if (!state.online) {
        clearSyncTimer();
        if (state.sync.status === 'unsynced') state.sync.status = 'offline-unsynced';
      }
      if (state.online && state.sync.status === 'offline-unsynced') {
        state.sync.status = 'unsynced';
        scheduleSync();
      }
      emit();
    },
    hydrate(remote) {
      const remoteRepairs = [];
      const incoming = normalizeRemoteRoaming(remote, remoteRepairs);
      if (['unsynced', 'offline-unsynced', 'syncing'].includes(state.sync.status)) {
        clearSyncTimer();
        state.sync.status = 'conflict';
        state.sync.conflict = {
          local: { values: copy(values.ROAM), bindings: copy(bindings), version: state.sync.version },
          server: incoming,
        };
      } else {
        const previousValues = values.ROAM;
        const previousBindings = bindings;
        values.ROAM = incoming.values;
        bindings = incoming.bindings;
        if (incoming.version !== null) state.sync.version = incoming.version;
        state.sync.status = 'synced';
        state.sync.conflict = null;
        writeScope('ROAM');
        applyRoamingChanges(previousValues, previousBindings);
      }
      if (remoteRepairs.length) {
        state.notice = 'Invalid account settings were repaired before use.';
        state.repairs.push(...remoteRepairs);
      }
      emit();
      return { ok: true, conflict: state.sync.status === 'conflict', repairs: copy(remoteRepairs) };
    },
    hydrateRoaming(remote) {
      return controller.hydrate(remote);
    },
    markSynced(remote = {}) {
      const incoming = normalizeRemoteRoaming(remote, repairs);
      const previousValues = values.ROAM;
      const previousBindings = bindings;
      values.ROAM = incoming.values;
      bindings = incoming.bindings;
      if (incoming.version !== null) state.sync.version = incoming.version;
      state.sync.status = 'synced';
      state.sync.conflict = null;
      state.sync.lastError = null;
      writeScope('ROAM');
      applyRoamingChanges(previousValues, previousBindings);
      emit();
    },
    receiveSyncConflict(remote) {
      clearSyncTimer();
      const remoteRepairs = [];
      const normalized = normalizeRemoteRoaming(remote, remoteRepairs);
      state.sync.status = 'conflict';
      state.sync.conflict = {
        local: { values: copy(values.ROAM), bindings: copy(bindings), version: state.sync.version },
        server: { values: normalized.values, bindings: normalized.bindings, version: normalized.version },
      };
      emit();
    },
    resolveSyncConflict(choice) {
      const conflict = state.sync.conflict;
      if (!conflict) return { ok: false, error: 'no-conflict' };
      if (choice === 'use-server') {
        const previousValues = values.ROAM;
        const previousBindings = bindings;
        values.ROAM = copy(conflict.server.values);
        bindings = copy(conflict.server.bindings);
        state.sync.version = conflict.server.version;
        state.sync.status = 'synced';
        applyRoamingChanges(previousValues, previousBindings);
      } else if (choice === 'keep-local') {
        state.sync.version = conflict.server.version;
        state.sync.conflict = null;
        dirtyRoaming();
      } else {
        return { ok: false, error: 'invalid-choice' };
      }
      state.sync.conflict = null;
      writeScope('ROAM');
      emit();
      return { ok: true };
    },
    sync() {
      if (state.sync.status === 'conflict') {
        return Promise.resolve({ ok: false, error: 'conflict' });
      }
      if (syncFlight) return syncFlight;
      clearSyncTimer();
      syncFlight = (async () => {
      if (!state.online) {
        state.sync.status = 'offline-unsynced';
        emit();
        return { ok: false, error: 'offline' };
      }
      if (!options.syncAdapter?.save) {
        state.sync.status = 'unsynced';
        state.sync.lastError = 'Account sync is unavailable.';
        emit();
        return { ok: false, error: 'unavailable' };
      }
      state.sync.status = 'syncing';
      emit();
      const revisionAtStart = roamingRevision;
      try {
        const result = await options.syncAdapter.save({
          schemaVersion: ROAMING_SETTINGS_SCHEMA_VERSION,
          version: state.sync.version,
          values: { ...copy(values.ROAM), keybinds: copy(bindings) },
        });
        if (result?.conflict) {
          controller.receiveSyncConflict(result.current);
          return { ok: false, error: 'conflict' };
        }
        if (state.sync.status === 'conflict' && state.sync.conflict) {
          return { ok: false, error: 'conflict' };
        }
        if (roamingRevision !== revisionAtStart) {
          const accepted = normalizeRemoteRoaming(result || {}, repairs);
          if (accepted.version !== null) state.sync.version = accepted.version;
          state.sync.status = state.online ? 'unsynced' : 'offline-unsynced';
          state.sync.lastError = null;
          writeScope('ROAM');
          emit();
          return { ok: true, pending: true };
        }
        controller.markSynced(result || {});
        return { ok: true };
      } catch (error) {
        if (error?.status === 409) {
          const current = error.current || (
            error.details?.values && typeof error.details.values === 'object'
              ? { version: error.details.currentVersion, values: error.details.values }
              : null
          );
          if (current) {
            controller.receiveSyncConflict(current);
            return { ok: false, error: 'conflict' };
          }
        }
        state.sync.status = 'unsynced';
        state.sync.lastError = 'Settings could not be synced. Your local changes are safe.';
        emit();
        return { ok: false, error: 'sync-failed' };
      }
      })().finally(() => {
        syncFlight = null;
        scheduleSync();
      });
      return syncFlight;
    },
    setSessionDiagnostics(diagnostics) {
      values.SESSION = {
        ...values.SESSION,
        diagnostics: sanitizeSessionDiagnostics(diagnostics),
      };
      emit();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopTimer();
      clearSyncTimer();
      listeners.clear();
      eventTarget?.removeEventListener?.('storage', onStorage);
      eventTarget?.removeEventListener?.('online', onOnline);
      eventTarget?.removeEventListener?.('offline', onOffline);
    },
  };

  function onStorage(event) {
    const scope = PERSISTED_SCOPES.find((item) => SETTINGS_STORAGE_KEYS[item] === event.key);
    if (!scope || event.storageArea && event.storageArea !== storage) return;
    const externalRepairs = [];
    let incomingSyncStatus = null;
    if (scope === 'ROAM') {
      try { incomingSyncStatus = JSON.parse(event.newValue)?.syncStatus || null; } catch { /* repaired below */ }
    }
    const incoming = normalizeDocument(event.newValue, scope, externalRepairs);
    const priorValues = values[scope];
    const priorBindings = scope === 'ROAM' ? bindings : null;
    if (scope === 'ROAM' && ['unsynced', 'offline-unsynced', 'syncing'].includes(state.sync.status)) {
      clearSyncTimer();
      state.sync.status = 'conflict';
      state.sync.conflict = {
        local: { values: copy(values.ROAM), bindings: copy(bindings), version: state.sync.version },
        server: incoming,
      };
    } else {
      values[scope] = incoming.values;
      if (scope === 'ROAM') {
        bindings = incoming.bindings;
        state.sync.version = incoming.version;
        state.sync.status = incomingSyncStatus === 'synced'
          ? 'synced'
          : state.online ? 'unsynced' : 'offline-unsynced';
      }
      for (const definition of SETTINGS_INVENTORY.filter((item) => item.scope === scope)) {
        if (!Object.is(priorValues[definition.key], values[scope][definition.key])) {
          applyValue(definition.key, values[scope][definition.key], definition);
        }
      }
      if (scope === 'ROAM' && JSON.stringify(priorBindings) !== JSON.stringify(bindings)) applyBindings();
    }
    const query = state.search.trim().toLowerCase();
    const visibleValueChanged = SETTINGS_INVENTORY.some((definition) => {
      if (definition.scope !== scope || Object.is(priorValues[definition.key], incoming.values[definition.key])) return false;
      const searchable = [definition.key, definition.label, ...(definition.synonyms || [])].join(' ').toLowerCase();
      return query ? searchable.includes(query) : definition.category === state.category;
    });
    const visibleBindingChanged = scope === 'ROAM'
      && (state.category === 'bindings' || Boolean(query))
      && JSON.stringify(priorBindings) !== JSON.stringify(incoming.bindings);
    if (externalRepairs.length) state.notice = 'Invalid settings from another tab were repaired.';
    else if (visibleValueChanged || visibleBindingChanged) state.notice = 'Visible settings were updated in another tab.';
    emit();
  }
  const onOnline = () => controller.setOnline(true);
  const onOffline = () => controller.setOnline(false);
  eventTarget?.addEventListener?.('storage', onStorage);
  eventTarget?.addEventListener?.('online', onOnline);
  eventTarget?.addEventListener?.('offline', onOffline);

  return controller;
}
