/**
 * P1 out-of-match shell and settings acceptance harness.
 *
 * Runs contract-level model probes first, then mounts the real shell modules through Vite
 * in Chromium. The browser entry is supplied by this harness so it cannot accidentally boot
 * the legacy game entry point while proving that the shell is independently mountable.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

import { BRIDGED_KEYS, SETTING_BRIDGE, toGameValue, toShellValue } from '../src/ui/shell/settingsBridge.js';
import { mouseCode } from '../src/core/mouseCodes.js';
import { SETTINGS_BY_KEY } from '../src/ui/shell/settings/inventory.js';
import {
  BINDING_ACTIONS,
  RESERVED_BINDING_CODES,
  SETTINGS_CATEGORIES,
  SETTINGS_INVENTORY,
  LOCAL_SETTINGS_SCHEMA_VERSION,
  ROAMING_SETTINGS_SCHEMA_VERSION,
  SETTINGS_SCHEMA_VERSION,
  SETTINGS_SCOPES,
  SETTINGS_STORAGE_KEYS,
  SESSION_DIAGNOSTIC_KEYS,
  createSettingsController,
  validateSettingValue,
} from '../src/ui/shell/settings/index.js';
import { SHELL_ROUTES, matchShellRoute } from '../src/ui/shell/router.js';
import { SETTLEMENT_RESULT_FIXTURES, SHELL_SCREEN_FIXTURES, SHELL_VARIANT_MATRIX } from '../src/ui/shell/fixtures.js';
import { Input } from '../src/core/input.js';
import { createShellApi } from '../src/ui/platform/shell-api.js';
import { createStubApi, STUB_FLAG } from '../platform/src/modules/stubs/index.js';
import {
  ACCOUNT_ID as STUB_ACCOUNT_ID, OTHER_ACCOUNT_ID as STUB_OTHER_ACCOUNT_ID,
  MATCH_ID as STUB_MATCH_ID, extractionRunResult,
} from '../platform/src/modules/stubs/fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_CATEGORIES = Object.freeze([
  'input', 'bindings', 'graphics', 'audioCaptions', 'crosshairHud', 'accessibility', 'network',
]);
const EXPECTED_SCOPES = Object.freeze(['ROAM', 'DEVICE', 'SESSION', 'PRACTICE']);
const REQUIRED_VARIANTS = Object.freeze(['loading', 'error', 'offline', 'ready']);
const EMPTY_NA = new Set([
  'welcome', 'auth.signIn', 'auth.create', 'auth.recover', 'onboarding.eligibility',
  'onboarding.displayName', 'onboarding.verify', 'onboarding.terms', 'room.loadout',
  'room.chat', 'career.matchDetail', 'inventory.item', 'loadouts', 'match.loading',
  'results', 'system',
]);
const TERMINAL_NA = new Set(['onboarding.essentialSettings']);

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks++;
};
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message);
  checks++;
};

class MemoryStorage {
  constructor(seed = {}) {
    this.values = new Map(Object.entries(seed));
  }
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
  removeItem(key) {
    this.values.delete(key);
  }
}

class ManualClock {
  constructor() {
    this.nextId = 1;
    this.timers = new Map();
  }
  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.timers.set(id, { callback, delay });
    return id;
  }
  clearTimeout(id) {
    this.timers.delete(id);
  }
  runNext() {
    const [id, timer] = this.timers.entries().next().value || [];
    if (!timer) return null;
    this.timers.delete(id);
    timer.callback();
    return timer.delay;
  }
}

function routePath(route) {
  return route.pattern
    .replace(':roomId', 'fixture-room-alpha')
    .replace(':matchId', 'fixture-match-1')
    .replace(':instanceId', 'fixture-instance-helmet')
    .replace(':category', 'accessibility')
    .replace(':condition', 'maintenance');
}

async function modelChecks() {
  equal(SETTINGS_CATEGORIES.map((item) => item.id), EXPECTED_CATEGORIES, 'settings category IDs drifted from vocabulary v1');
  equal(Object.keys(SETTINGS_SCOPES), EXPECTED_SCOPES, 'settings scope vocabulary must be exact');
  equal(LOCAL_SETTINGS_SCHEMA_VERSION, 2, 'local repair schema must remain independently versioned');
  equal(ROAMING_SETTINGS_SCHEMA_VERSION, 1, 'HTTP roaming schema must match RoamingSettingsV1');
  equal(SHELL_ROUTES.length, 30, 'the shell route inventory must contain 30 addressable routes');

  const keys = SETTINGS_INVENTORY.map((item) => item.key);
  equal(new Set(keys).size, keys.length, 'setting keys must be unique');
  check(!keys.some((key) => /^loadout/i.test(key)), 'loadout fields must not remain in settings authority');
  for (const definition of SETTINGS_INVENTORY) {
    check(EXPECTED_CATEGORIES.includes(definition.category), `${definition.key} uses a non-canonical category`);
    check(EXPECTED_SCOPES.includes(definition.scope), `${definition.key} uses a non-canonical scope`);
    check(validateSettingValue(definition, definition.defaultValue), `${definition.key} default is outside its schema`);
  }

  const actionIds = BINDING_ACTIONS.map((item) => item.id);
  equal(new Set(actionIds).size, actionIds.length, 'binding action IDs must be unique');
  equal(BINDING_ACTIONS.find((item) => item.id === 'pause')?.primary, 'Escape', 'pause must remain fixed to Escape');
  check(RESERVED_BINDING_CODES.has('Escape'), 'Escape must be reserved');

  const inputMap = new Map([
    ['KeyE', 'nextWeapon'],
    ['KeyQ', 'previousWeapon'],
    ['WheelDown', 'crouch'],
    ['WheelUp', 'nextWeapon'],
  ]);
  const input = Object.assign(Object.create(Input.prototype), {
    captureBind: null,
    locked: false,
    codes: new Set(),
    actions: new Set(),
    pressed: new Set(),
    wheelDelta: 0,
    settings: { actionFor: (code) => inputMap.get(code) || null },
    game: { bus: { emit() {} } },
  });
  Input.prototype._onKeyDown.call(input, { code: 'KeyE', repeat: false, preventDefault() {} });
  equal(input.consumeWheel(), 1, 'a key rebound to next weapon must cycle forward');
  Input.prototype._onKeyDown.call(input, { code: 'KeyQ', repeat: false, preventDefault() {} });
  equal(input.consumeWheel(), -1, 'a key rebound to previous weapon must cycle backward');
  Input.prototype._onWheel.call(input, { deltaY: 1, preventDefault() {} });
  equal(input.consumeWheel(), 0, 'wheel direction rebound away from weapon cycling must not switch');
  Input.prototype._onWheel.call(input, { deltaY: -1, preventDefault() {} });
  equal(input.consumeWheel(), 1, 'wheel input must obey its rebound weapon-cycle action');

  // Rebinding accepts MOUSE buttons. `captureBind` was consulted in `_onKeyDown` only, so the
  // in-game rebind prompt — which invites "a key or mouse button" — ignored every click. Aim
  // is bound to a mouse button by default, making the action most likely to be rebound the one
  // that could not be.
  {
    input.buttons = [false, false, false, false, false];
    input.buttonsPressed = [false, false, false, false, false];
    let captured = null;
    let defaultPrevented = false;
    input.captureBind = (code) => { captured = code; };
    Input.prototype._onMouseDown.call(input,
      { button: 2, preventDefault() { defaultPrevented = true; } });
    equal(captured, 'Mouse2', 'capturing a binding accepts the physical right mouse button');
    check(defaultPrevented, 'and prevents the default so the click does not fall through');
    check(input.captureBind === null, 'capture is one-shot — the next click is ordinary input');
    check(!input.actions.has('aim'),
      'a click that was consumed as a REBIND must not also fire the action it just bound');

    // CONTROL: with no capture pending the same click is ordinary input again.
    Input.prototype._onMouseDown.call(input, { button: 2, preventDefault() {} });
    check(input.buttons[2] === true, 'CONTROL: an ordinary right click still registers');
  }

  for (const route of SHELL_ROUTES) {
    const fixture = SHELL_SCREEN_FIXTURES[route.id];
    check(Boolean(fixture), `${route.id} is missing a fixture row`);
    equal(SHELL_VARIANT_MATRIX[route.id], Object.keys(fixture), `${route.id} variant metadata is stale`);
    for (const variant of REQUIRED_VARIANTS) check(Boolean(fixture[variant]), `${route.id} is missing ${variant}`);
    equal(Boolean(fixture.empty), !EMPTY_NA.has(route.id), `${route.id} empty applicability drifted`);
    equal(Boolean(fixture.terminal), !TERMINAL_NA.has(route.id), `${route.id} policy applicability drifted`);
    equal(matchShellRoute(routePath(route)).id, route.id, `${route.id} route pattern does not round-trip`);
  }

  const malformed = new MemoryStorage({
    [SETTINGS_STORAGE_KEYS.DEVICE]: JSON.stringify({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      scope: 'DEVICE',
      values: { renderScale: 39, masterVolume: 73, sensitivity: 2, unknown: true },
    }),
    [SETTINGS_STORAGE_KEYS.ROAM]: JSON.stringify({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      scope: 'ROAM',
      version: 4,
      values: { sensitivity: 1.25, fov: 999, reduceMotion: 'yes' },
      bindings: {
        forward: { primary: 'KeyW', secondary: null },
        pause: { primary: 'KeyP', secondary: null },
      },
    }),
  });
  const controller = createSettingsController({
    storage: malformed,
    eventTarget: null,
    online: false,
    prefersReducedMotion: false,
  });
  let state = controller.getSnapshot();
  equal(state.values.renderScale, 100, 'current-schema invalid numeric values must reset, not clamp');
  equal(state.values.masterVolume, 73, 'valid sibling keys must survive per-key repair');
  equal(state.values.sensitivity, 1.25, 'valid roaming value must survive repair');
  equal(state.values.fov, 85, 'invalid roaming values must repair independently');
  equal(state.bindings.pause.primary, 'Escape', 'stored reserved pause override must repair');
  check(state.repairs.length >= 4, 'repairs must be observable');

  equal(controller.set('renderScale', 80).ok, true, 'valid device setting should apply');
  equal(controller.set('renderScale', 81).error, 'invalid-value', 'off-step device setting should be rejected');
  equal(controller.set('sensitivity', 1.5).ok, true, 'valid roaming setting should apply');
  equal(controller.getSnapshot().sync.status, 'offline-unsynced', 'offline roaming changes must be visibly unsynced');
  check(JSON.parse(malformed.getItem(SETTINGS_STORAGE_KEYS.DEVICE)).values.sensitivity === undefined, 'DEVICE storage must not receive ROAM keys');
  check(JSON.parse(malformed.getItem(SETTINGS_STORAGE_KEYS.ROAM)).values.renderScale === undefined, 'ROAM storage must not receive DEVICE keys');

  equal(controller.beginCapture('jump', 'secondary').ok, true, 'binding capture should begin');
  equal(controller.handleCaptureInput('F5').error, 'reserved', 'browser-reserved binding must be rejected');
  equal(controller.handleCaptureInput('KeyW').error, 'conflict', 'occupied binding must open a conflict');
  state = controller.getSnapshot();
  equal(state.bindingConflict.otherActionId, 'forward', 'conflict must name its current owner');
  equal(controller.resolveBindingConflict('CANCEL').changed, false, 'CANCEL must preserve both bindings');
  equal(controller.getSnapshot().bindings.forward.primary, 'KeyW', 'cancelled conflict must not unbind the owner');
  equal(controller.clearBinding('pause', 'primary').error, 'fixed-binding', 'pause cannot be cleared');
  equal(controller.clearBinding('forward', 'primary').error, 'confirmation-required', 'last required binding needs confirmation');
  controller.cancelRequiredUnbind();
  controller.applyReducedMotionPreset();
  state = controller.getSnapshot();
  equal([state.values.cameraShake, state.values.viewBob, state.values.weaponSway], [25, 0, 35], 'reduced-motion preset values drifted');
  controller.set('botCount', 8);
  equal(controller.previewReset({ category: 'input' }).scopes.sort(), ['PRACTICE', 'ROAM'], 'reset preview must expose affected scopes');
  controller.destroy();

  const bindingApplies = [];
  const resetController = createSettingsController({
    storage: new MemoryStorage(),
    eventTarget: null,
    onApply(key, value) { bindingApplies.push({ key, value }); },
  });
  const capture = (actionId, code) => {
    resetController.beginCapture(actionId, 'primary');
    return resetController.handleCaptureInput(code);
  };
  equal(capture('forward', 'KeyJ').ok, true, 'test setup must move the forward binding');
  equal(capture('jump', 'KeyW').ok, true, 'test setup must occupy the forward default');
  bindingApplies.length = 0;
  equal(resetController.resetBinding('forward').error, 'conflict', 'action reset must not bypass an occupied default');
  equal(resetController.getSnapshot().bindings.forward.primary, 'KeyJ', 'conflicted reset must remain atomic before a choice');
  equal(resetController.resolveBindingConflict('CANCEL').changed, false, 'reset CANCEL must leave every binding unchanged');
  equal(resetController.getSnapshot().bindings.jump.primary, 'KeyW', 'reset CANCEL must preserve the conflicting owner');
  equal(bindingApplies.length, 0, 'cancelled reset must not emit a live-apply notification');
  resetController.resetBinding('forward');
  equal(resetController.resolveBindingConflict('SWAP').changed, true, 'reset SWAP must explicitly resolve the occupied default');
  state = resetController.getSnapshot();
  equal(state.bindings.forward.primary, 'KeyW', 'resolved reset must restore the action default');
  equal(state.bindings.jump.primary, 'KeyJ', 'reset SWAP must preserve the displaced binding');
  const assignedCodes = Object.values(state.bindings).flatMap((slots) => Object.values(slots).filter(Boolean));
  equal(new Set(assignedCodes).size, assignedCodes.length, 'binding reset must never create duplicate ownership');
  equal(bindingApplies.at(-1)?.key, 'keybinds', 'binding mutation must notify the live-apply boundary');
  resetController.clearBinding('crouch', 'primary');
  resetController.clearBinding('crouch', 'secondary');
  equal(capture('jump', 'ControlLeft').ok, true, 'test setup must occupy the first two-slot reset default');
  equal(capture('sprint', 'KeyC').ok, true, 'test setup must occupy the second two-slot reset default');
  equal(resetController.resetBinding('crouch').error, 'conflict', 'two-slot reset must stage its first conflict');
  equal(resetController.resolveBindingConflict('SWAP').pending, true, 'multi-conflict reset must request every explicit decision');
  equal(resetController.getSnapshot().bindings.crouch, { primary: null, secondary: null }, 'multi-conflict reset must remain atomic between decisions');
  equal(resetController.resolveBindingConflict('UNBIND_OTHER').changed, true, 'final reset decision must commit the staged reset');
  state = resetController.getSnapshot();
  equal(state.bindings.crouch, { primary: 'ControlLeft', secondary: 'KeyC' }, 'two-slot reset must restore both defaults');
  const postResetCodes = Object.values(state.bindings).flatMap((slots) => Object.values(slots).filter(Boolean));
  equal(new Set(postResetCodes).size, postResetCodes.length, 'multi-conflict reset must retain unique ownership');
  resetController.destroy();

  const measuredDiagnostics = {
    sampledAt: 1200, windowMs: 5000, region: 'yyz', serverBuild: '1.2.3+acceptance',
    protocolVersion: 7, rttMs: 24, jitterMs: 3, lossPct: 0.5,
    correctionRatePerSec: 1.25, correctionMagnitudeM: 0.08, snapshotAgeMs: 40,
    receiveRateHz: 20, baselineState: 'synced', keyframes: 2, discarded: 1,
    accessToken: 'must-not-copy', rawIp: '203.0.113.8', accountId: '01J00000000000000000000001',
  };
  // ── mouse bind codes ──────────────────────────────────────────────────────────────────
  //
  // Five call sites each computed `Mouse${button + 1}`, giving Mouse1=left, Mouse2=MIDDLE,
  // Mouse3=right. Every FPS — and this codebase's own defaults, which pair `fire: Mouse1` with
  // `aim: Mouse2` — mean left/right. So aim-down-sights sat on the middle button and right-click
  // did nothing, while firing worked because left is Mouse1 either way. The five sites agreed
  // with each other, so nothing was inconsistent for a test to catch; they were uniformly wrong.
  check(mouseCode(0) === 'Mouse1' && mouseCode(2) === 'Mouse2' && mouseCode(1) === 'Mouse3',
    'Mouse1/2/3 are left/right/middle — the order players and the default binds assume',
    JSON.stringify([mouseCode(0), mouseCode(1), mouseCode(2)]));
  check(mouseCode(3) === 'Mouse4' && mouseCode(4) === 'Mouse5',
    'side buttons keep their conventional numbers');
  check(mouseCode(5) === null && mouseCode(-1) === null && mouseCode(1.5) === null
    && mouseCode(undefined) === null,
  'anything outside the five real buttons yields no bind code at all');
  {
    // The pairing this exists to protect, read from the real binding defaults.
    const aim = BINDING_ACTIONS.find((action) => action.id === 'aim');
    const fire = BINDING_ACTIONS.find((action) => action.id === 'fire');
    check(fire?.primary === 'Mouse1' && aim?.primary === 'Mouse2',
      'CONTROL: fire and aim still default to the left and right buttons',
      JSON.stringify({ fire: fire?.primary, aim: aim?.primary }));
    check(mouseCode(2) === aim?.primary,
      'pressing the physical right button produces exactly the code aim is bound to',
      `${mouseCode(2)} vs ${aim?.primary}`);
  }

  // ── the shell⇄game settings bridge ────────────────────────────────────────────────────
  //
  // The pause menu writes to `game.settings`, which persists to localStorage and nowhere else,
  // and the shell pushed its snapshot into that same object on every game creation. So every
  // change made in-game was overwritten the next time a match or practice started, and never
  // reached the player's account — "my settings aren't being saved".
  //
  // Fixing it needs the INVERSE of 54 entries, a third of them scaled or enum⇄boolean. A hand
  // written inverse is how the two halves drift, and a wrong transform does not throw — it
  // quietly rescales someone's sensitivity. So every key is round-tripped against its real
  // default from the settings inventory.
  {
    const missing = BRIDGED_KEYS.filter((key) => !SETTINGS_BY_KEY[key]);
    check(missing.length === 0,
      'every bridged key is a real setting in the inventory', missing.join(', '));

    const lossy = [];
    for (const key of BRIDGED_KEYS) {
      const original = SETTINGS_BY_KEY[key]?.defaultValue;
      if (original === undefined) continue;
      const round = toShellValue(key, toGameValue(key, original));
      if (JSON.stringify(round) !== JSON.stringify(original)) {
        lossy.push(`${key}: ${JSON.stringify(original)} -> ${JSON.stringify(round)}`);
      }
    }
    check(lossy.length === 0,
      'every bridged setting survives shell -> game -> shell unchanged', lossy.join('; '));

    // The transforms that actually do something. Identity keys would pass the round-trip above
    // even if the table dropped them, so the scaled and enum pairs are named explicitly.
    check(toGameValue('brightness', 80) === 0.8 && toShellValue('brightness', 0.8) === 80,
      'percent settings scale to a fraction for the game and back');
    check(toGameValue('toggleAds', 'toggle') === true && toShellValue('toggleAds', false) === 'hold',
      'toggleAds maps between the enum the shell stores and the boolean the game wants');
    check(toGameValue('maxFps', 'off') === 0 && toShellValue('maxFps', 0) === 'off',
      'maxFps off maps to 0 and back, rather than to NaN');

    // The gate belongs with the feature flags, not in the table — an impure entry here is the
    // one most likely to be wrong and the hardest to test.
    check(typeof SETTING_BRIDGE.mode?.toGame !== 'function',
      'the bridge table stays pure: no feature-flag logic inside it');
  }

  const diagnosticsController = createSettingsController({ storage: new MemoryStorage(), eventTarget: null });
  diagnosticsController.setSessionDiagnostics(measuredDiagnostics);
  const sanitizedDiagnostics = diagnosticsController.getSnapshot().byScope.SESSION.diagnostics;
  equal(Object.keys(sanitizedDiagnostics), SESSION_DIAGNOSTIC_KEYS, 'diagnostics must retain the exact measured netStats allowlist');
  check(!JSON.stringify(sanitizedDiagnostics).includes('must-not-copy'), 'diagnostics must discard token-like values');
  check(!Object.hasOwn(sanitizedDiagnostics, 'rawIp') && !Object.hasOwn(sanitizedDiagnostics, 'accountId'), 'diagnostics must discard unauthorized personal/network identifiers');
  diagnosticsController.setSessionDiagnostics({ latencyMs: 1, packetLossPercent: 2, tickRate: 60 });
  equal(diagnosticsController.getSnapshot().byScope.SESSION.diagnostics, null, 'invented legacy diagnostic names must not produce measurements');
  diagnosticsController.destroy();

  let savedWirePayload = null;
  const integratedApplies = [];
  const integrated = createSettingsController({
    storage: new MemoryStorage(),
    eventTarget: null,
    online: true,
    onApply(key) { integratedApplies.push(key); },
    syncAdapter: {
      async save(payload) {
        savedWirePayload = payload;
        return { schemaVersion: 1, version: 8, values: payload.values };
      },
    },
  });
  integrated.set('renderScale', 80);
  integratedApplies.length = 0;
  const hydrated = integrated.hydrate({
    schemaVersion: 1,
    version: 7,
    values: {
      sensitivity: 1.75,
      keybinds: { ...integrated.getSnapshot().bindings, jump: { primary: 'Space', secondary: 'KeyJ' } },
    },
  });
  equal(hydrated.conflict, false, 'clean controller should accept server hydration');
  equal(integrated.get('sensitivity'), 1.75, 'hydration must apply valid ROAM values');
  equal(integrated.get('renderScale'), 80, 'hydration must preserve DEVICE values');
  equal(integrated.getSnapshot().bindings.jump.secondary, 'KeyJ', 'hydration must apply roaming keybinds');
  check(integratedApplies.includes('sensitivity'), 'remote hydration must notify changed live settings');
  check(integratedApplies.includes('keybinds'), 'remote hydration must notify changed live bindings');
  check(!integratedApplies.includes('renderScale'), 'remote hydration must not apply or overwrite DEVICE settings');
  integrated.set('sensitivity', 2);
  equal(integrated.hydrate({ sensitivity: 3 }).conflict, true, 'incoming hydration must conflict with unsynced local roaming changes');
  integrated.set('fov', 90);
  equal(integrated.getSnapshot().sync.status, 'conflict', 'editing during conflict must not silently discard conflict state');
  equal(integrated.getSnapshot().sync.conflict.local.values.fov, 90, 'editing during conflict must refresh the staged local resolution document');
  equal((await integrated.sync()).error, 'conflict', 'sync must refuse to overwrite the server while conflict resolution is pending');
  integrated.resolveSyncConflict('keep-local');
  await integrated.sync();
  equal(savedWirePayload.schemaVersion, 1, 'sync must emit RoamingSettingsV1, not local cache v2');
  check(Boolean(savedWirePayload.values.keybinds), 'sync must place keybinds inside the HTTP values object');
  check(savedWirePayload.bindings === undefined, 'sync must not invent a top-level bindings wire field');
  integrated.destroy();

  const conflictController = createSettingsController({
    storage: new MemoryStorage(),
    eventTarget: null,
    online: true,
    syncAdapter: {
      async save() {
        throw {
          status: 409,
          details: {
            currentVersion: 12,
            values: { sensitivity: 3, keybinds: conflictController.getSnapshot().bindings },
          },
        };
      },
    },
  });
  conflictController.set('sensitivity', 2);
  equal((await conflictController.sync()).error, 'conflict', 'frozen PlatformError.details must enter conflict handling');
  equal(conflictController.getSnapshot().sync.conflict.server.version, 12, '409 currentVersion must become the server revision');
  equal(conflictController.getSnapshot().sync.conflict.server.values.sensitivity, 3, '409 server values must remain available for resolution');
  conflictController.destroy();

  let releaseSave;
  let saveCalls = 0;
  const racingController = createSettingsController({
    storage: new MemoryStorage(),
    eventTarget: null,
    online: true,
    syncAdapter: {
      save(payload) {
        saveCalls++;
        if (saveCalls === 1) return new Promise((resolve) => { releaseSave = () => resolve({
          schemaVersion: 1, version: 2, values: payload.values,
        }); });
        return Promise.resolve({ schemaVersion: 1, version: 3, values: payload.values });
      },
    },
  });
  racingController.set('sensitivity', 1.5);
  const firstSync = racingController.sync();
  const joinedSync = racingController.sync();
  check(firstSync === joinedSync, 'concurrent settings sync must return one single-flight promise');
  equal(saveCalls, 1, 'concurrent settings sync must issue one HTTP mutation');
  racingController.set('sensitivity', 2);
  releaseSave();
  equal((await firstSync).pending, true, 'a local edit during sync must remain pending after the older save succeeds');
  equal(racingController.get('sensitivity'), 2, 'an older sync response must not overwrite a newer local edit');
  equal(racingController.getSnapshot().sync.status, 'unsynced', 'newer local edits must remain visibly unsynced');
  await racingController.sync();
  equal(saveCalls, 2, 'the preserved newer edit must be saveable in a later flight');
  equal(racingController.getSnapshot().sync.status, 'synced', 'the later save must settle the preserved edit');
  racingController.destroy();

  const autoClock = new ManualClock();
  let autoSaves = 0;
  const autoController = createSettingsController({
    storage: new MemoryStorage(),
    eventTarget: null,
    online: true,
    clock: autoClock,
    syncDebounceMs: 25,
    syncAdapter: {
      async save(payload) {
        autoSaves++;
        return { schemaVersion: 1, version: autoSaves, values: payload.values };
      },
    },
  });
  autoController.set('sensitivity', 1.1);
  autoController.set('fov', 90);
  equal(autoSaves, 0, 'ordinary ROAM writes must debounce instead of saving per keystroke');
  equal(autoClock.timers.size, 1, 'multiple ROAM writes must coalesce behind one timer');
  equal(autoClock.runNext(), 25, 'write-through must use the injected debounce duration');
  await new Promise((resolve) => setImmediate(resolve));
  equal(autoSaves, 1, 'the debounce must write through one coalesced roaming document');
  equal(autoController.getSnapshot().sync.status, 'synced', 'successful automatic write-through must settle sync state');
  autoController.setOnline(false);
  autoController.set('sensitivity', 1.2);
  equal(autoClock.timers.size, 0, 'offline ROAM writes must not schedule network work');
  equal(autoController.getSnapshot().sync.status, 'offline-unsynced', 'offline ROAM writes must remain explicitly pending');
  autoController.setOnline(true);
  equal(autoClock.timers.size, 1, 'reconnect must schedule deferred roaming write-through');
  autoClock.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  equal(autoSaves, 2, 'reconnect must flush the deferred roaming edit once');
  equal(autoController.get('sensitivity'), 1.2, 'reconnect sync must preserve the offline edit');
  autoController.set('sensitivity', 1.3);
  equal(autoClock.timers.size, 1, 'a later roaming edit must schedule write-through');
  equal(autoController.hydrate({ version: 4, values: { sensitivity: 2.5 } }).conflict, true,
    'incoming server state must expose a conflict while a debounced edit is pending');
  equal(autoClock.timers.size, 0, 'entering conflict must cancel pending automatic writes');
  autoController.set('fov', 95);
  equal(autoClock.timers.size, 0, 'edits during conflict must not bypass explicit resolution');
  equal(autoController.getSnapshot().sync.conflict.local.values.fov, 95,
    'edits during conflict must be included in the local resolution choice');
  autoController.resolveSyncConflict('keep-local');
  equal(autoClock.timers.size, 1, 'keeping local changes must resume debounced write-through');
  autoClock.runNext();
  await new Promise((resolve) => setImmediate(resolve));
  equal(autoSaves, 3, 'resolved local conflict state must write through exactly once');
  autoController.destroy();
}

const HARNESS_DOCUMENT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><div id="shell-root"></div><script type="module">
import { mountAppShell, SHELL_SCREEN_FIXTURES } from '/src/ui/shell/index.js';
import { SETTINGS_CATEGORIES, createSettingsController, createSettingsScreen } from '/src/ui/shell/settings/index.js';

const query = new URLSearchParams(location.search);
const requestedPath = query.get('route') || (location.pathname.startsWith('/__uishell') ? '/welcome' : location.pathname);
const variant = query.get('fixture') || 'ready';
const settingsController = createSettingsController({
  online: query.get('offline') !== '1',
  prefersReducedMotion: query.get('reduced') === '1',
});
let settingsScreen = null;
const settings = {
  get(key) { return settingsController.get(key); },
  renderCategory({ container, category }) {
    const canonical = SETTINGS_CATEGORIES.some((item) => item.id === category) ? category : 'input';
    settingsController.setCategory(canonical);
    settingsScreen?.destroy();
    settingsScreen = createSettingsScreen({ controller: settingsController, headingLevel: 2 });
    container.append(settingsScreen.element);
    return () => {
      if (settingsScreen?.element === container.firstElementChild) settingsScreen.destroy();
      settingsScreen = null;
    };
  },
  renderEssential({ container }) {
    const note = document.createElement('p');
    note.textContent = 'Essential settings fixture';
    container.append(note);
    return () => note.remove();
  },
  renderLoadout({ container }) {
    const note = document.createElement('p');
    note.textContent = 'Loadout belongs to the inventory domain.';
    container.append(note);
    return () => note.remove();
  },
};

window.__HARNESS_AUTH_CALLS__ = 0;
window.__HARNESS_RUNTIME_LOADS__ = 0;
const connection = {
  value: { platform: 'unknown', lobby: 'disconnected', match: 'idle' },
  listener: null,
  getSnapshot() { return this.value; },
  subscribe(listener) { this.listener = listener; return () => { this.listener = null; }; },
  set(value) { this.value = value; this.listener?.(value); },
};
window.__SOLO_SUBMISSIONS__ = [];
window.__LOADOUT_SUBMISSIONS__ = [];
const client = {
  connection,
  // Records what the loadout editor actually SENDS, like createRoom below: a select that
  // renders but never reaches the payload is the same defect one layer in. A reserved name
  // triggers the contract's closed error enumeration so the mapped copy can be asserted.
  async createLoadout(payload) {
    window.__LOADOUT_SUBMISSIONS__.push(['create', payload]);
    if (payload.name === 'Not Owned Probe') {
      throw Object.assign(new Error('Referenced instance is not owned.'), { code: 'LOADOUT_ITEM_NOT_OWNED' });
    }
    return { loadoutId: 'harness-loadout', name: payload.name, slots: payload.slots, isDefault: false };
  },
  async updateLoadout(payload) {
    window.__LOADOUT_SUBMISSIONS__.push(['update', payload]);
    return { loadoutId: payload.loadoutId, name: payload.name, slots: payload.slots, isDefault: false };
  },
  // Records what the create-room form actually SENDS. A checkbox that renders and submits
  // nothing is the same defect one layer in, so the assertion is on the payload, not the DOM.
  async createRoom(payload) {
    window.__SOLO_SUBMISSIONS__.push(payload);
    return { room: { roomId: 'harness-room' } };
  },
  async signIn() {
    window.__HARNESS_AUTH_CALLS__++;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { authenticated: true, profile: { displayName: 'Fixture Player', flags: { setupNextStep: null } } };
  },
};
window.__HARNESS_CONNECTION__ = connection;
const session = {
  value: { authenticated: false },
  getSnapshot() { return this.value; },
  accept(next) { this.value = next; },
};
window.__SHELL__ = mountAppShell({
  root: document.querySelector('#shell-root'),
  client,
  session,
  settings,
  fixtures: SHELL_SCREEN_FIXTURES,
  fixtureVariant: variant,
  initialPath: requestedPath,
  async loadGameRuntime() {
    window.__HARNESS_RUNTIME_LOADS__++;
    return import('/src/core/game.js');
  },
});
window.__SETTINGS__ = settingsController;
window.__HARNESS_READY__ = true;
</script></body></html>`;

/**
 * match-result.md §4.4 — the extraction run-result projection, proven against the bodies the
 * platform stub actually serves (`result-extraction-*`), through the shell's own closed
 * validator (`createShellApi().getResult`). The validated bodies are returned so the browser
 * pass can drive the P3-10 screens with real wire shapes instead of hand-written fixtures.
 */
async function extractionResultChecks() {
  const CLIENT_BUILD = '1.0.0';
  const drive = (scenario) => {
    const stub = createStubApi({
      config: { env: 'test' }, flags: { [STUB_FLAG]: true }, env: {},
      sleep: () => Promise.resolve(),
    });
    let token = null;
    const request = async (path, options = {}) => {
      const res = await stub.handle({
        method: options.method || 'GET', path, query: {}, body: options.body || {},
        headers: {
          'X-Stub-Scenario': scenario,
          'X-Client-Session-Id': `uishell-${scenario}`,
          'X-Client-Build': CLIENT_BUILD,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (res.body && typeof res.body.accessToken === 'string') token = res.body.accessToken;
      if (res.status >= 400) {
        throw Object.assign(new Error(res.body?.error?.code || `HTTP ${res.status}`), {
          code: res.body?.error?.code, status: res.status,
        });
      }
      return { status: res.status, data: res.body, correlationId: res.correlationId };
    };
    return { request, api: createShellApi({ client: { request }, legacyStorage: null }) };
  };
  const signedIn = async (scenario) => {
    const driver = drive(scenario);
    await driver.request('/v1/auth/signin', {
      method: 'POST', body: { email: 'uishell@stub.invalid', password: 'stub-password' },
    });
    return driver;
  };

  const results = {};
  const scenarioResult = async (scenario) => {
    const { api } = await signedIn(scenario);
    const { result } = await api.getResult({ matchId: STUB_MATCH_ID });
    return result;
  };

  results.extracted = await scenarioResult('result-extraction-extracted');
  equal(results.extracted.mode, 'extraction', 'the run result is discriminated by mode');
  equal(results.extracted.status, 'completed', 'the extracted scenario serves a terminal run');
  equal(results.extracted.settlement.participants[0], {
    accountId: STUB_ACCOUNT_ID, settlementStatus: 'settled', outcome: 'extracted',
    exitId: 'exit-rail-gate', deathCause: null, exceptionId: null, trigger: null,
  }, 'the validated §4.4 participant reaches the caller byte-for-byte, not reshaped');
  equal(results.extracted.settlement.participants[1].outcome, 'died',
    'the squadmate death rides the same response — outcomes are per-participant');
  check(results.extracted.winnerTeam === undefined && results.extracted.teamScores === undefined
    && results.extracted.rounds === undefined,
  'the PvP-only keys are absent from a run result, exactly as §4.4 requires');
  check(typeof results.extracted.correlationId === 'string' && results.extracted.correlationId.length > 0,
    'the run result carries its correlation id');

  results.lost = await scenarioResult('result-extraction-lost');
  equal(results.lost.settlement.participants[0].outcome, 'died',
    'the lost scenario settles the local account as died');
  equal(results.lost.settlement.participants[0].deathCause, 'player',
    'deathCause is present exactly when the outcome is a death');

  results.exception = await scenarioResult('result-extraction-exception');
  equal(results.exception.settlement.participants[0].settlementStatus, 'exception-open',
    'the exception scenario is held open, not misread as settled');
  equal(results.exception.settlement.participants[0].outcome, null,
    'an open exception carries no outcome — nothing was applied');
  equal(results.exception.settlement.participants[0].exceptionId, 'exc-stub-01',
    'the open exception names its review reference');

  results.mixed = await scenarioResult('result-extraction-mixed');
  equal(results.mixed.settlement.runLevelException,
    { exceptionId: 'exc-stub-run-01', trigger: 'missing-participant' },
    'the run-level exception (settlement.md §5.3) survives validation alongside per-participant states');
  equal(results.mixed.settlement.participants.map((p) => p.settlementStatus),
    ['settled', 'settled', 'exception-open'],
    'a split squad validates with each participant in its own state');

  // The retry-safe timeline: §4.2 pending with mode extraction, then terminal with the local
  // participant still `ended` (submission received, settlement unresolved), then settled.
  {
    const { api } = await signedIn('result-extraction-pending');
    const first = (await api.getResult({ matchId: STUB_MATCH_ID })).result;
    equal(first.status, 'pending', 'a non-terminal run projects as the §4.2 pending shape');
    equal(first.mode, 'extraction', 'the pending shape admits mode extraction (2.1.0)');
    check(Number.isInteger(first.retryAfterMs), 'pending keeps the §4.2 retry contract');
    results.pending = first;
    await api.getResult({ matchId: STUB_MATCH_ID });
    const third = (await api.getResult({ matchId: STUB_MATCH_ID })).result;
    equal(third.status, 'completed', 'the third poll is terminal');
    equal(third.settlement.participants.map((p) => p.settlementStatus), ['ended', 'settled'],
      'a terminal run with a still-`ended` participant validates — the §5.2 retry-safe window is a legal state');
    equal(third.settlement.participants[0].outcome, null,
      'an `ended` participant has no outcome yet');
    results.retrySafe = third;
    const fourth = (await api.getResult({ matchId: STUB_MATCH_ID })).result;
    equal(fourth.settlement.participants.map((p) => p.outcome), ['extracted', 'extracted'],
      'the settled read closes the timeline');
  }

  // Fail-closed controls: the discipline of the shell is that an unknown, omitted, or
  // wrong-typed 2xx raises CLIENT_PROTOCOL rather than rendering a guess.
  const doctored = async (mutate) => {
    const body = { ...extractionRunResult('uishell-doctored-run', {
      participants: [
        { accountId: STUB_ACCOUNT_ID, settlementStatus: 'settled', outcome: 'extracted', exitId: 'exit-rail-gate' },
        { accountId: STUB_OTHER_ACCOUNT_ID, settlementStatus: 'exception-open', outcome: null,
          exceptionId: 'exc-uishell-01', trigger: 'lock-mismatch' },
      ],
    }), correlationId: 'uishell-doctored' };
    mutate(body);
    const api = createShellApi({
      client: { request: async () => ({ status: 200, data: body, correlationId: body.correlationId }) },
      legacyStorage: null,
    });
    try {
      await api.getResult({ matchId: body.matchId });
      return null;
    } catch (error) {
      return error?.code || 'ERROR';
    }
  };
  equal(await doctored(() => {}), null, 'the undoctored control passes — the probes below fail for their mutation alone');
  equal(await doctored((body) => { body.winnerTeam = null; }), 'CLIENT_PROTOCOL',
    'a null-stuffed PvP key on a run result is refused — §4.4 says absent, not null');
  equal(await doctored((body) => { body.settlement.participants[1].settlementStatus = 'archived'; }),
    'CLIENT_PROTOCOL', 'an unknown settlementStatus fails closed instead of rendering a guess');
  equal(await doctored((body) => { delete body.settlement.participants[1].trigger; }),
    'CLIENT_PROTOCOL', 'an omitted participant key is a defect, never a state');
  equal(await doctored((body) => { body.settlement.participants[0].exitId = null; }),
    'CLIENT_PROTOCOL', 'an extracted participant without its exit is refused — exitId rides extraction');
  equal(await doctored((body) => { body.roster[1].team = 'alpha'; }), 'CLIENT_PROTOCOL',
    'a run roster seat with a PvP team is refused — a run has no alpha/bravo');
  equal(await doctored((body) => {
    body.settlement.participants = [body.settlement.participants[0]];
  }), 'CLIENT_PROTOCOL', 'settlement must cover the full roster — a missing participant is refused');

  return { accountId: STUB_ACCOUNT_ID, ...results };
}

async function browserChecks(stubResults) {
  let server;
  let browser;
  const errors = [];
  const requests = [];
  try {
    server = await createServer({
      root: ROOT,
      configFile: path.join(ROOT, 'vite.config.js'),
      server: { port: 5217, strictPort: false, hmr: false, watch: null },
      logLevel: 'warn',
    });
    await server.listen();
    const base = server.resolvedUrls.local[0].replace(/\/$/, '');
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessRespectPreflightResults'],
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
      window.__HARNESS_GL_CALLS__ = [];
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function instrumentedGetContext(kind, ...args) {
        if (/^webgl2?$/.test(String(kind))) window.__HARNESS_GL_CALLS__.push(String(kind));
        return original.call(this, kind, ...args);
      };
    });
    await context.route(`${base}/**`, async (route) => {
      if (route.request().resourceType() === 'document') {
        await route.fulfill({ status: 200, contentType: 'text/html', body: HARNESS_DOCUMENT });
      } else {
        await route.continue();
      }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
    });
    page.on('requestfailed', (request) => errors.push(`requestfailed: ${request.url()} — ${request.failure()?.errorText || 'unknown'}`));
    page.on('request', (request) => requests.push(request.url()));

    await page.goto(`${base}/__uishell?route=/welcome&fixture=ready&reduced=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__HARNESS_READY__ === true);
    equal(await page.locator('main').count(), 1, 'shell must expose exactly one main landmark');
    equal(await page.locator('h1').count(), 1, 'shell must expose exactly one page h1');
    check(await page.locator('.os-connection').isHidden(), 'unknown platform health is neutral and does not show a false outage banner');
    await page.evaluate(() => window.__HARNESS_CONNECTION__.set({ platform: 'offline', lobby: 'disconnected', match: 'idle' }));
    check(await page.locator('.os-connection').isVisible(), 'explicit unhealthy platform state shows the global connection banner');
    await page.evaluate(() => window.__HARNESS_CONNECTION__.set({ platform: 'healthy', lobby: 'disconnected', match: 'idle' }));
    check(await page.locator('.os-connection').isHidden(), 'healthy platform state clears the connection banner');
    equal(await page.evaluate(() => window.__HARNESS_GL_CALLS__.length), 0, 'shell boot must not create a WebGL context');
    check(!requests.some((url) => /\/src\/(core\/game|game)\.js|\/three(?:\.module)?\.js|node_modules\/\.vite\/deps\/three/i.test(url)), 'shell boot loaded game/three code');

    for (const route of SHELL_ROUTES) {
      const pathValue = routePath(route);
      for (const variant of SHELL_VARIANT_MATRIX[route.id]) {
        await page.evaluate(({ pathValue, routeId, variant }) => {
          window.__SHELL__.navigate(pathValue);
          window.__SHELL__.injectFixture(routeId, variant);
        }, { pathValue, routeId: route.id, variant });
        await page.evaluate(() => new Promise((resolve) => queueMicrotask(resolve)));
        equal(await page.locator('main').count(), 1, `${route.id}/${variant} duplicated main`);
        equal(await page.locator('h1').count(), 1, `${route.id}/${variant} duplicated h1`);
        equal(await page.locator('#shell-root').getAttribute('data-route'), route.id, `${route.id}/${variant} rendered the wrong route`);
        equal(await page.locator('#shell-root').getAttribute('data-variant'), variant, `${route.id}/${variant} rendered the wrong state`);
        if (variant !== 'ready') {
          const body = await page.locator('main').innerText();
          check(!/Fixture Alpha|Fixture Player|Fixture result/.test(body), `${route.id}/${variant} leaked success fixture data`);
        }
      }
    }

    await page.evaluate(() => {
      window.__SHELL__.navigate('/play/rooms');
      window.__SHELL__.injectFixture('play.rooms', 'ready');
    });
    equal(await page.locator('.os-room-card h2').allTextContents(), ['Fixture Alpha', 'Fixture Charlie', 'Fixture Bravo'], 'room browser default order must be joinability, measured latency, then occupancy');
    await page.locator('#shell-room-mode').selectOption('bomb');
    equal(await page.locator('.os-room-card h2').allTextContents(), ['Fixture Bravo'], 'room browser mode filter must retain the exact matching mode');
    check((await page.getByText('1 room shown.', { exact: true }).count()) === 1, 'room browser must expose its filtered result count');
    await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
    check((await page.getByRole('button', { name: 'Load more rooms', exact: true }).count()) === 1, 'room browser pagination must be cursor-gated');

    // ── solo play, and the practice button a signed-in player could not reach ───────────
    //
    // A room defaults to minPlayers 2, so a lone player readies up, presses Launch and is told
    // the match needs two — with no control anywhere to change it. And `Local practice` lived
    // only on `renderWelcome`, which redirects a signed-in player straight to this page, so
    // finishing onboarding made the feature unreachable. Both are asserted here because both
    // are "the player has no way to play", which no unit test would have called a failure.
    await page.locator('summary', { hasText: 'Create a room' }).click();
    const soloBox = page.locator('#shell-room-create-solo');
    check((await soloBox.count()) === 1, 'the create form offers a solo option at all');
    check(!(await soloBox.isChecked()), 'solo is OFF by default — a normal room still wants two players');

    // The setting must reach the REQUEST. A checkbox that renders and sends nothing is this
    // same defect one layer further in, so the assertion is on the submitted payload.
    //
    // Submitted with `requestSubmit()` rather than a click because this harness mounts with no
    // feature-flag source, so `map.the_square.enabled` falls back to false, the map list is
    // empty and the button is disabled for reasons that predate solo play. That gate is
    // asserted on its own below; this drives the handler where the settings mapping lives.
    const submitCreate = async (name, solo) => {
      // A successful create navigates to the room, so the form is gone by the next call. Put
      // the browser back before each submission rather than assuming it survived the last one.
      await page.evaluate(() => {
        window.__SOLO_SUBMISSIONS__ = [];
        window.__SHELL__.navigate('/play/rooms');
        window.__SHELL__.injectFixture('play.rooms', 'ready');
      });
      await page.locator('summary', { hasText: 'Create a room' }).click();
      await page.fill('input[name="room-create-name"]', name);
      await page.locator('#shell-room-create-solo').setChecked(solo);
      await page.evaluate(() => document.querySelector('#shell-room-create-name').form.requestSubmit());
      return page.evaluate(() => window.__SOLO_SUBMISSIONS__?.[0] ?? null);
    };

    const soloPayload = await submitCreate('Solo Probe', true);
    check(soloPayload?.settings?.minPlayers === 1 && soloPayload?.settings?.requiredReady === 1,
      'ticking solo sends minPlayers 1 — the value that was actually doing the blocking',
      JSON.stringify(soloPayload?.settings));

    const duoPayload = await submitCreate('Duo Probe', false);
    check(duoPayload && duoPayload.settings === undefined,
      'CONTROL: leaving solo unticked sends no settings override at all',
      JSON.stringify(duoPayload?.settings));
    check(duoPayload?.region === 'iad',
      'and the region comes from the dropdown, defaulted to one with capacity',
      String(duoPayload?.region));

    await page.evaluate(() => {
      window.__SHELL__.navigate('/play/rooms');
      window.__SHELL__.injectFixture('play.rooms', 'ready');
    });
    await page.locator('summary', { hasText: 'Create a room' }).click();
    check((await page.getByRole('button', { name: 'Create and join', exact: true }).isDisabled()),
      'the submit gate still refuses when no approved map is enabled — solo does not bypass it');

    check((await page.getByRole('button', { name: 'Local practice', exact: true }).count()) === 1,
      'a signed-in player can reach Local practice without signing out');

    await page.evaluate(() => {
      window.__SHELL__.navigate('/play/rooms/password-room');
      window.__SHELL__.injectFixture('play.roomDetail', {
        variant: 'ready',
        data: { roomId: 'password-room', name: 'Private room', mode: 'bomb', mapId: 'the-square',
          mapVersion: '1.0.0', region: 'yyz', status: 'open', capacity: 12, playerCount: 4,
          joinable: true, joinBlockedReason: 'password', hasPassword: true, rulesetVersion: 'bomb-1.0.0' },
      });
    });
    equal(await page.getByLabel('Room password').getAttribute('type'), 'password', 'password-protected room must collect its secret without putting it in the route');

    await page.evaluate(() => {
      window.__SHELL__.navigate('/room/fixture-room-alpha');
      window.__SHELL__.injectFixture('room.home', 'ready');
    });
    equal(await page.locator('.os-team > h2').allTextContents(), ['Alpha — 1', 'Bravo — 1', 'Unassigned — 1'], 'lobby must expose Alpha, Bravo, and unassigned columns');
    check((await page.getByText('✓ READY', { exact: true }).count()) === 1, 'ready state must have a non-color label');
    check((await page.getByText('○ NOT READY', { exact: true }).count()) === 2, 'not-ready state must have a non-color label');
    check((await page.getByText('Readiness was cleared because a team changed.', { exact: true }).count()) === 1, 'ready clear reason must remain visible');
    check((await page.getByText('Host', { exact: true }).count()) === 1, 'lobby must identify the host');

    await page.evaluate(() => window.__SHELL__.injectFixture('room.home', {
      variant: 'ready',
      data: {
        status: 'synchronized', roomId: 'fixture-room-alpha',
        room: { roomId: 'fixture-room-alpha', name: 'Fixture Alpha', status: 'open',
          capacity: 10, playerCount: 1 },
        roster: [{ accountId: 'fixture-local', displayName: 'Authoritative Player', team: 'alpha',
          ready: false, isOwner: true, isLocal: true, connection: 'connected', estimatedRttMs: 24,
          loadout: { primaryIdx: 0, secondaryIdx: 1 } }],
        pending: {
          'fixture-team-intent': { t: 'team.request', d: { team: 'bravo' }, accountId: 'fixture-local' },
          'fixture-ready-intent': { t: 'ready.set', d: { ready: true }, accountId: 'fixture-local' },
        },
        optimistic: { team: 'bravo', ready: true, loadout: null },
      },
    }));
    equal(await page.locator('.os-team > h2').allTextContents(), ['Alpha — 1', 'Bravo — 0', 'Unassigned — 0'], 'pending team intent must not move the authoritative roster');
    check((await page.getByText('Team change pending: Bravo. The roster remains authoritative.', { exact: true }).count()) === 1, 'pending team intent must have a separate visible treatment');
    check((await page.getByText('Ready request pending. The roster label remains authoritative until the server answers.', { exact: true }).count()) === 1, 'pending ready intent must not replace the authoritative ready label');
    check((await page.getByRole('button', { name: '○ GREEN UP', exact: true }).isDisabled()), 'pending ready action must stay single-flight until the server answers');

    await page.evaluate(() => {
      window.__SHELL__.navigate('/room/fixture-room-alpha/loadout');
      window.__SHELL__.injectFixture('room.loadout', 'ready');
    });
    equal(await page.locator('#shell-loadout-primary').count(), 1, 'lobby loadout must render supplied authoritative primary choices');
    equal(await page.locator('#shell-loadout-secondary').count(), 1, 'lobby loadout must render supplied authoritative secondary choices');

    // ── P3-08: persistent inventory and loadout preparation ─────────────────────────────
    //
    // Every state items-inventory.md names, asserted as visible text a player can act on:
    // locked-by-deployment, run vs permanent, stackable quantities, the durability placeholder,
    // the honest capacity statement, and the closed validation error vocabulary.
    await page.evaluate(() => {
      window.__SHELL__.navigate('/inventory');
      window.__SHELL__.injectFixture('inventory', 'ready');
    });
    check((await page.getByText('Locked — reserved for deployment', { exact: true }).count()) === 1,
      'a deployment-locked item must carry a non-color locked label');
    check((await page.getByText('90 of 120', { exact: true }).count()) === 1,
      'a stackable item must show its quantity against its max stack');
    check((await page.getByText('1 (serialized item)', { exact: true }).count()) === 4,
      'serialized items must be explicit about not stacking');
    check((await page.getByText('Not tracked yet — wear and repair arrive in a later phase (max 100)', { exact: true }).count()) === 1,
      'the durability placeholder must be labeled as untracked, never rendered as a zero');
    check((await page.getByText('Not equippable — carried as raid loot only', { exact: true }).count()) === 1,
      'a slot-less definition must say it can never be equipped');
    check((await page.locator('main').innerText()).includes('no capacity limit in this phase'),
      'capacity must be stated honestly: no limit exists yet, so no invented meter');
    check((await page.locator('main').innerText()).includes('Items you are carrying in an active raid are not listed here'),
      'run vs permanent must be explained on the permanent list');
    check((await page.locator('a[href="/inventory/fixture-instance-helmet"]').count()) === 1,
      'every listed item must offer an inspect link');

    await page.evaluate(() => {
      window.__SHELL__.navigate('/inventory/fixture-instance-helmet');
      window.__SHELL__.injectFixture('inventory.item', 'ready');
    });
    check((await page.getByText('This item is reserved by deployment fixture-deployment-1. Until that deployment resolves, it cannot be modified or equipped into another deployment.', { exact: true }).count()) === 1,
      'inspecting a locked item must name the deployment holding the lock (§6.4 made visible)');

    await page.evaluate(() => window.__SHELL__.injectFixture('inventory.item', {
      variant: 'ready',
      data: {
        instanceId: 'fixture-instance-run', itemId: 'rifle_fixture', quantity: 1,
        durability: null, location: 'run', runId: 'fixture-run-1', locked: false,
        lockedByDeploymentId: null, status: 'active',
        definition: { itemId: 'rifle_fixture', name: 'Fixture rifle', class: 'weapon', slot: 'primary', rarityTier: 'rare', stackable: false, maxStack: null, durabilityMax: 100 },
      },
    }));
    check((await page.getByText('This item is inside an active raid. It returns to your permanent inventory if you extract, and is lost if you die or abort. It cannot be equipped into a loadout while the raid is live.', { exact: true }).count()) === 1,
      'a run item must explain both exits and why it cannot be equipped (§4 made visible)');

    await page.evaluate(() => {
      window.__SHELL__.navigate('/loadouts');
      window.__SHELL__.injectFixture('loadouts', 'ready');
    });
    check((await page.getByText('No item is protected. Everything you equip deploys with you, and is lost if you die or abort instead of extracting. Item protection does not exist in this phase.', { exact: true }).count()) === 1,
      'protection is stated honestly: the contracts define exactly two run exits and no protected flag');
    equal(await page.locator('#shell-loadout-slot-primary option').allTextContents(),
      ['Empty', 'Fixture rifle'],
      'a slot select must offer only that slot\'s items — slot mismatch is prevented by construction');
    equal(await page.locator('#shell-loadout-slot-helmet option').allTextContents(),
      ['Empty'],
      'a deployment-locked item must not be offered for equipping (§3.1 rule 1)');
    check((await page.getByText('Fixture helmet (reserved by an active deployment)', { exact: true }).count()) === 1,
      'a saved loadout referencing a locked item must say so on its card');
    check((await page.getByText('Default', { exact: true }).count()) === 1,
      'the default loadout must be labeled');

    // The chosen instances must reach the REQUEST, and empty slots must be omitted, not sent
    // as empty strings the server would reject.
    await page.fill('input[name="loadout-name"]', 'Harness Kit');
    await page.locator('#shell-loadout-slot-primary').selectOption('fixture-instance-rifle');
    await page.locator('#shell-loadout-slot-consumable').selectOption('fixture-instance-medkit');
    await page.evaluate(() => document.querySelector('input[name="loadout-name"]').form.requestSubmit());
    await page.waitForFunction(() => window.__LOADOUT_SUBMISSIONS__.length === 1);
    const createdLoadout = await page.evaluate(() => window.__LOADOUT_SUBMISSIONS__[0]);
    equal(createdLoadout[0], 'create', 'saving a new loadout must create, not patch');
    equal(createdLoadout[1].slots,
      { primary: 'fixture-instance-rifle', consumable: 'fixture-instance-medkit' },
      'the editor must send exactly the chosen instance ids and omit empty slots');

    // The contract's closed error enumeration (§8) maps to copy a player can act on.
    await page.evaluate(() => {
      window.__LOADOUT_SUBMISSIONS__ = [];
      window.__SHELL__.navigate('/loadouts');
      window.__SHELL__.injectFixture('loadouts', 'ready');
    });
    await page.fill('input[name="loadout-name"]', 'Not Owned Probe');
    await page.evaluate(() => document.querySelector('input[name="loadout-name"]').form.requestSubmit());
    await page.waitForFunction(() => document.body.innerText.includes('no longer in your permanent inventory'));
    check((await page.getByText('An item in this loadout is no longer in your permanent inventory — it may have been lost, consumed, or taken into a raid. Replace it and save again.', { exact: true }).count()) === 1,
      'LOADOUT_ITEM_NOT_OWNED must map to actionable copy, not a raw code');

    // Editing a loadout whose saved slot is locked must demand a replacement, prefill the
    // eligible slots, and PATCH the same loadout rather than creating a sibling.
    await page.evaluate(() => {
      window.__SHELL__.navigate('/loadouts');
      window.__SHELL__.injectFixture('loadouts', 'ready');
    });
    await page.getByRole('button', { name: 'Edit Fixture raid kit', exact: true }).click();
    check((await page.getByText('The saved helmet is reserved by an active deployment. Choose a replacement or wait for that deployment to resolve.', { exact: true }).count()) === 1,
      'editing a loadout with a locked item explains the replacement requirement');
    equal(await page.locator('#shell-loadout-slot-primary').inputValue(), 'fixture-instance-rifle',
      'editing must prefill saved slots that are still eligible');
    await page.evaluate(() => {
      window.__LOADOUT_SUBMISSIONS__ = [];
      document.querySelector('input[name="loadout-name"]').form.requestSubmit();
    });
    await page.waitForFunction(() => window.__LOADOUT_SUBMISSIONS__.length === 1);
    const editedLoadout = await page.evaluate(() => window.__LOADOUT_SUBMISSIONS__[0]);
    equal(editedLoadout[0], 'update', 'saving an edit must patch the existing loadout');
    equal(editedLoadout[1].loadoutId, 'fixture-loadout-1', 'the patch must target the edited loadout id');
    check(editedLoadout[1].slots.helmet === undefined,
      'the ineligible locked slot must be dropped from the saved slots, never silently resent');

    // ── P3-10: post-run settlement presentation ─────────────────────────────────────────
    //
    // settlement.md §5.3's per-participant statuses as a player must be able to tell them
    // apart: extracted, lost, held-for-review (exception-open), and the two retry-safe
    // windows (run pending, participant `ended`). Each is asserted as visible text plus a
    // non-color data attribute, and "protected" is asserted as the honest statement that no
    // protection exists — the contracts define two dispositions and no protected flag.
    const showSettlement = (fixture) => page.evaluate((data) => {
      window.__SHELL__.navigate('/results/run-fixture-1');
      window.__SHELL__.injectFixture('results', { variant: 'ready', data });
    }, fixture);

    await showSettlement(SETTLEMENT_RESULT_FIXTURES.extracted);
    check((await page.locator('[data-local-settlement="extracted"]').count()) === 1,
      'an extracted local player gets the extracted headline state');
    check((await page.locator('main').innerText()).includes('returned to the permanent inventory'),
      'extracted copy states where the items went');
    check((await page.getByText('Protected items: none. Item protection does not exist in this phase — extraction keeps everything, any other outcome loses everything.', { exact: true }).count()) === 1,
      'protection is stated honestly: none exists, said in words rather than implied');
    check((await page.locator('.os-settlement-card[data-settlement="lost"]').count()) === 1,
      'a squadmate who died is presented as lost on the same screen — outcomes are per-participant');

    await showSettlement(SETTLEMENT_RESULT_FIXTURES.lost);
    check((await page.locator('[data-local-settlement="lost"]').count()) === 1,
      'a killed local player gets the lost headline state');
    check((await page.locator('main').innerText()).includes('Every item carried was lost'),
      'lost copy states the full-loss disposition without euphemism');

    await showSettlement(SETTLEMENT_RESULT_FIXTURES.pendingReview);
    check((await page.locator('[data-local-settlement="pending-review"]').count()) === 1,
      'an exception-open participant is presented as held for review, not as lost or settled');
    const reviewText = await page.locator('main').innerText();
    check(reviewText.includes('neither returned nor lost until the review resolves'),
      'pending-review copy states that no disposition has been applied yet');
    check(reviewText.includes('exc-fixture-01'),
      'the review reference is shown so support can find the exception');

    await showSettlement(SETTLEMENT_RESULT_FIXTURES.retrySafe);
    check((await page.locator('[data-local-settlement="retry-safe"]').count()) === 1,
      'a received-but-unsettled participant is presented as retry-safe settling');
    check((await page.locator('main').innerText()).includes('a retry can never settle the same items twice'),
      'retry-safe copy states the §5 idempotency guarantee that makes leaving safe');
    check((await page.locator('.os-settlement-card[data-settlement="extracted"]').count()) === 1,
      'a squadmate already settled renders alongside the still-settling one');

    await showSettlement(SETTLEMENT_RESULT_FIXTURES.runPending);
    const pendingText = await page.locator('main').innerText();
    check(pendingText.includes('This run is still finalising'),
      'a pending extraction run says run, not match');
    check(pendingText.includes('It is safe to leave this screen'),
      'the pending window states that waiting is optional — the server queues and retries');

    await showSettlement(SETTLEMENT_RESULT_FIXTURES.mixedSquad);
    const mixedKinds = await page.locator('.os-settlement-card').evaluateAll(
      (nodes) => nodes.map((node) => node.dataset.settlement));
    equal(mixedKinds, ['extracted', 'lost', 'pending-review'],
      'a mixed squad renders every participant in its own state — one exception never blocks a settled squadmate');
    check((await page.locator('main').innerText()).includes('An abort settles exactly like a death'),
      'abort copy states settlement.md §4\'s died/aborted equivalence');
    await page.evaluate(() => window.__SHELL__.clearFixture('results'));

    await page.evaluate(() => {
      window.__SHELL__.navigate('/room/fixture-room-alpha/chat');
      window.__SHELL__.injectFixture('room.chat', 'ready');
    });
    check((await page.getByRole('button', { name: 'Mute Fixture Rival', exact: true }).count()) === 1, 'chat must expose mute controls');
    check((await page.getByText('Report Fixture Rival', { exact: true }).count()) === 1, 'chat must expose report controls');
    check((await page.getByRole('button', { name: 'Send tactical ping', exact: true }).count()) === 1, 'chat must expose controller-supplied ping controls');

    await page.evaluate(() => window.__SHELL__.navigate('/career/overview'));
    await page.waitForFunction(() => document.activeElement?.id === 'os-shell-title');
    equal(await page.evaluate(() => document.activeElement?.id), 'os-shell-title', 'route navigation must focus the page heading');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__HARNESS_READY__ === true);
    equal(await page.locator('#shell-root').getAttribute('data-route'), 'career.overview', 'direct reload must preserve the route');

    await page.evaluate(() => window.__SHELL__.navigate('/auth/sign-in'));
    await page.locator('input[name="identifier"]').fill('fixture');
    await page.locator('input[name="password"]').fill('secret');
    await page.locator('button[type="submit"]').evaluate((button) => {
      const submit = () => button.form.dispatchEvent(new SubmitEvent('submit', {
        bubbles: true,
        cancelable: true,
        submitter: button,
      }));
      submit();
      submit();
    });
    await page.waitForTimeout(120);
    equal(await page.evaluate(() => window.__HARNESS_AUTH_CALLS__), 1, 'repeated auth activation must remain single-flight');

    await page.evaluate(() => window.__SHELL__.navigate('/settings/input'));
    await page.waitForSelector('[data-settings-screen]');
    await page.locator('[data-setting="sensitivity"][type="number"]').fill('1.25');
    await page.locator('[data-setting="sensitivity"][type="number"]').blur();
    await page.locator('[data-reset-key="sensitivity"]').click();
    await page.waitForSelector('[role="alertdialog"]');
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Cancel', 'settings dialog must focus its first action');
    await page.locator('[data-reset-confirm]').focus();
    await page.keyboard.press('Tab');
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Cancel', 'Tab must wrap inside settings dialog');
    await page.keyboard.press('Escape');
    equal(await page.locator('[role="alertdialog"]').count(), 0, 'Escape must close settings dialog');
    equal(await page.evaluate(() => document.activeElement?.dataset?.focusKey), 'reset-sensitivity', 'dialog must restore its opener');

    const unnamed = await page.locator('[data-settings-screen] input[data-setting],[data-settings-screen] select[data-setting]').evaluateAll((nodes) =>
      nodes.filter((node) => !(node.getAttribute('aria-label') || node.getAttribute('aria-labelledby') || node.labels?.length)).map((node) => node.dataset.setting));
    equal(unnamed, [], 'every native settings input must have its own accessible name');
    const brokenOutputs = await page.locator('[data-settings-screen] output[for]').evaluateAll((nodes) =>
      nodes.filter((node) => !document.getElementById(node.htmlFor)).map((node) => node.htmlFor));
    equal(brokenOutputs, [], 'range outputs must reference a real input ID');
    check((await page.getByText('Practice only', { exact: true }).count()) > 0, 'practice settings must expose their scope');
    check((await page.getByText('Saved to account', { exact: true }).count()) > 0, 'roaming settings must expose their scope');

    await page.getByRole('button', { name: 'Bindings', exact: true }).click();
    await page.locator('[data-capture-action="jump"][data-capture-slot="secondary"]').click();
    await page.keyboard.press('w');
    await page.waitForSelector('[role="alertdialog"]');
    const conflictActions = await page.locator('[role="alertdialog"] button').allTextContents();
    equal(conflictActions.map((item) => item.trim()), ['Cancel', 'Unbind other', 'Swap'], 'binding conflict must expose only explicit outcomes');
    await page.keyboard.press('Escape');
    equal(await page.evaluate(() => document.activeElement?.dataset?.focusKey), 'binding-jump-secondary', 'binding conflict must restore capture opener');

    // Right-clicking to bind popped the browser context menu over the settings screen:
    // `captureMouse` prevents the default on mousedown, but `contextmenu` is a SEPARATE event
    // and was never suppressed. Asserted by dispatching the real event and reading
    // defaultPrevented, because that is the exact bit the browser consults.
    const contextDuringCapture = await page.evaluate(() => {
      window.__SETTINGS__.beginCapture('aim', 'primary');
      const during = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      window.dispatchEvent(during);
      const suppressed = during.defaultPrevented;
      window.__SETTINGS__.cancelCapture();
      const after = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      window.dispatchEvent(after);
      return { suppressed, stillSuppressedAfterCapture: after.defaultPrevented };
    });
    check(contextDuringCapture.suppressed,
      'the context menu is suppressed while capturing a binding, so right-click can be bound');
    check(!contextDuringCapture.stillSuppressedAfterCapture,
      'CONTROL: and is restored afterwards — the shell does not take right-click away for good');

    await page.evaluate(() => {
      const bind = (actionId, code) => {
        window.__SETTINGS__.beginCapture(actionId, 'primary');
        window.__SETTINGS__.handleCaptureInput(code);
      };
      bind('forward', 'KeyJ');
      bind('jump', 'KeyW');
    });
    await page.locator('[data-reset-binding="forward"]').click();
    await page.waitForSelector('[role="alertdialog"]');
    equal(await page.evaluate(() => window.__SETTINGS__.getSnapshot().bindings.forward.primary), 'KeyJ', 'reset conflict dialog must precede mutation');
    await page.keyboard.press('Escape');
    equal(await page.evaluate(() => window.__SETTINGS__.getSnapshot().bindings.jump.primary), 'KeyW', 'Escape must cancel an action-reset conflict');
    await page.locator('[data-reset-binding="forward"]').click();
    await page.locator('[data-binding-choice="SWAP"]').click();
    equal(await page.evaluate(() => ({
      forward: window.__SETTINGS__.getSnapshot().bindings.forward.primary,
      jump: window.__SETTINGS__.getSnapshot().bindings.jump.primary,
    })), { forward: 'KeyW', jump: 'KeyJ' }, 'explicit reset SWAP must preserve unique binding ownership');

    await page.getByRole('button', { name: 'Network', exact: true }).click();
    check((await page.locator('[data-diagnostics-unavailable]').innerText()).includes('No estimated values are shown'), 'diagnostics must be explicit and non-fabricated before P2 measurements');
    check((await page.getByText('This session', { exact: true }).count()) > 0, 'diagnostics must expose SESSION scope');
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text) => { window.__COPIED_DIAGNOSTICS__ = text; } },
      });
      window.__SETTINGS__.setSessionDiagnostics({
        sampledAt: 1200, windowMs: 5000, region: 'yyz', serverBuild: '1.2.3+acceptance',
        protocolVersion: 7, rttMs: 24, jitterMs: 3, lossPct: 0.5,
        correctionRatePerSec: 1.25, correctionMagnitudeM: 0.08, snapshotAgeMs: 40,
        receiveRateHz: 20, baselineState: 'synced', keyframes: 2, discarded: 1,
        authorization: 'Bearer secret', rawIp: '203.0.113.8', arbitrary: '<script>bad()</script>',
      });
    });
    check((await page.locator('.os-diagnostics').innerText()).includes('RTT\n24 ms'), 'diagnostics must render the frozen rttMs measurement and units');
    check((await page.locator('.os-diagnostics').innerText()).includes('Snapshot age\n40 ms'), 'diagnostics must freshness-label snapshot health');
    await page.locator('[data-copy-diagnostics]').click();
    const copiedDiagnostics = await page.evaluate(() => JSON.parse(window.__COPIED_DIAGNOSTICS__));
    equal(Object.keys(copiedDiagnostics), SESSION_DIAGNOSTIC_KEYS, 'Copy diagnostics must use the strict measured allowlist');
    check(!JSON.stringify(copiedDiagnostics).includes('secret'), 'Copy diagnostics must redact token-like arbitrary input');
    check(!Object.hasOwn(copiedDiagnostics, 'rawIp') && !Object.hasOwn(copiedDiagnostics, 'arbitrary'), 'Copy diagnostics must omit raw IP and arbitrary fields');

    await page.evaluate(() => window.__SHELL__.navigate('/settings/accessibility'));
    check(await page.locator('#shell-root').evaluate((root) => root.classList.contains('os-reduced-motion')), 'OS reduced-motion preference must reach the shell');
    const animated = await page.locator('#shell-root *:visible').evaluateAll((nodes) => nodes.filter((node) => {
      const style = getComputedStyle(node);
      const seconds = (value) => value.trim().endsWith('ms') ? parseFloat(value) / 1000 : parseFloat(value);
      return style.animationDuration.split(',').some((value) => seconds(value) > 0.01)
        || style.transitionDuration.split(',').some((value) => seconds(value) > 0.01);
    }).map((node) => node.className).slice(0, 5));
    equal(animated, [], 'reduced-motion shell must not retain animations or timed transitions');

    await page.setViewportSize({ width: 640, height: 720 });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
    const overflow = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      width: document.documentElement.scrollWidth,
    }));
    check(overflow.width <= overflow.viewport + 1, `200% zoom introduced horizontal page overflow (${overflow.width} > ${overflow.viewport})`);
    await cdp.detach();

    equal(await page.evaluate(() => window.__HARNESS_GL_CALLS__.length), 0, 'non-match routes must remain WebGL-free');
    check(!requests.some((url) => /\/src\/core\/game\.js|node_modules\/\.vite\/deps\/three/i.test(url)), 'non-match routes must not request game/three');
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => {
      window.__SHELL__.navigate('/match/loading');
      window.__SHELL__.injectFixture('match.loading', 'ready');
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Enter match');
      button.click();
      button.click();
    });
    await page.waitForFunction(() => window.__HARNESS_RUNTIME_LOADS__ === 1);
    await page.waitForFunction(() => performance.getEntriesByType('resource').some((entry) => /\/src\/core\/game\.js/.test(entry.name)));
    equal(await page.evaluate(() => window.__HARNESS_RUNTIME_LOADS__), 1, 'match runtime loader must be single-flight');
    equal(requests.filter((url) => /\/src\/core\/game\.js(?:\?|$)/.test(url)).length, 1, 'game module must be requested exactly once');

    const liveSettingAdapters = await page.evaluate(async () => {
      const { HUD } = await import('/src/ui/hud.js');
      const values = new Map([
        ['showFps', false], ['subtitles', true], ['closedCaptions', true],
        ['captionDirection', true],
      ]);
      const root = document.createElement('div');
      const xh = document.createElement('div');
      const perf = document.createElement('div');
      const captions = document.createElement('div');
      const killfeed = document.createElement('div');
      const calls = [];
      const hud = Object.create(HUD.prototype);
      hud.game = { settings: { get: (key) => values.get(key) },
        player: { yaw: 0, position: { x: 0, z: 0 } } };
      hud.el = { root, xh, perf, captions };
      hud.killfeedUI = { el: killfeed };
      hud.minimap = { setVisible: (value) => calls.push(['visible', value]),
        setOrientation: (value) => calls.push(['orientation', value]) };
      hud._c = { spread: 0, vignette: 0, perf: '' };
      hud._networkOverlay = 'off';
      hud._gapPx = 6;
      hud._applySetting('crosshairOpacity', 0.65);
      hud._applySetting('crosshairSize', 1.4);
      hud._applySetting('crosshairThickness', 4);
      hud._applySetting('crosshairGap', 11);
      hud._applySetting('crosshairOutline', false);
      hud._applySetting('minimapRotation', 'northUp');
      hud._applySetting('showKillfeed', false);
      hud._applySetting('showObjectiveMarkers', 'minimal');
      hud._applySetting('damageVignette', 'low');
      hud._applySetting('flashIntensity', 0.3);
      hud._applySetting('screenEffectIntensity', 0.5);
      hud._applySetting('captionBackground', 0.6);
      hud._applySetting('subtitleSize', 'large');
      hud._applySetting('networkDiagnosticsOverlay', 'compact');
      hud._showAudioCaption({ name: 'explosion', channel: 'sfx', position: { x: -4, z: 0 } });
      return {
        opacity: xh.style.getPropertyValue('--xh-opacity'),
        size: xh.style.getPropertyValue('--xh-size'),
        thickness: xh.style.getPropertyValue('--xh-thickness'),
        gap: xh.style.getPropertyValue('--xh-gap'), outline: xh.dataset.outline,
        calls, killfeedHidden: killfeed.hidden, markers: root.dataset.objectiveMarkers,
        vignette: hud._damageVignetteScale, flash: hud._flashIntensity,
        effects: hud._screenEffectIntensity, captionBg: captions.style.getPropertyValue('--caption-bg'),
        captionSize: captions.dataset.size, caption: captions.textContent,
        network: perf.dataset.network, perfVisible: perf.classList.contains('on'),
      };
    });
    equal(liveSettingAdapters, {
      opacity: '0.65', size: '1.4', thickness: '4', gap: '11px', outline: 'off',
      calls: [['orientation', 'northUp']], killfeedHidden: true, markers: 'minimal',
      vignette: 0.4, flash: 0.3, effects: 0.5, captionBg: '0.6', captionSize: 'large',
      caption: 'Explosion [LEFT]', network: 'compact', perfVisible: true,
    }, 'graphics, HUD, caption, minimap, objective and network settings apply to live runtime adapters');

    const runtimeAuthority = await page.evaluate(async () => {
      Object.defineProperty(navigator, 'userAgent', { configurable: true,
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36' });
      localStorage.setItem('overstrike.progress.v1', JSON.stringify({
        schema: 1, xp: 999999999, lifetime: { kills: 999999999, matches: 999999999 },
      }));
      const [{ createGameRuntime }, { progression }] = await Promise.all([
        import('/src/ui/shell/gameRuntime.js'), import('/src/game/progression.js'),
      ]);
      progression.endAuthoritativeSession();
      progression.load();
      const listeners = new Map();
      const bus = {
        on(name, fn) { let set = listeners.get(name); if (!set) listeners.set(name, (set = new Set())); set.add(fn); return () => set.delete(fn); },
        once(name, fn) { const off = this.on(name, (payload) => { off(); fn(payload); }); return off; },
        emit(name, payload) { for (const fn of [...(listeners.get(name) || [])]) fn(payload); },
      };
      class FakeGame {
        constructor() {
          this.bus = bus;
          this.menu = { close() {} };
          this.hud = { scoreboard: { setVisible() {} }, notice() {} };
          this.settings = { actionFor: (code) => code === 'ArrowLeft' ? 'spectatePrevious'
            : code === 'ArrowRight' ? 'spectateNext' : code === 'Mouse3' ? 'tacticalPing' : null };
        }
        async init() {}
        startMatch() {}
        dispose() {}
      }
      const facadeListeners = new Map();
      let spectatorCycles = 0;
      let tacticalPings = 0;
      const startupOrder = [];
      const facade = {
        netStats: { sampledAt: 1200, windowMs: 5000, region: 'yyz', rttMs: 24,
          jitterMs: 3, lossPct: 0.5, receiveRateHz: 20 },
        bindGame() {}, async reserve() { startupOrder.push('reserve-ticket'); },
        async promoteReservation() { startupOrder.push('promote-session'); }, disconnect() {},
        cycleSpectator(direction) { spectatorCycles += direction; return true; },
        requestTacticalPing(kind) { if (kind === 'location') tacticalPings++; return true; },
        on(name, fn) { facadeListeners.set(name, fn); return () => facadeListeners.delete(name); },
        emit(name, payload) { facadeListeners.get(name)?.(payload); },
      };
      const canvas = document.createElement('canvas');
      canvas.requestPointerLock = async () => {};
      if (typeof globalThis.WebGL2RenderingContext !== 'function') {
        Object.defineProperty(globalThis, 'WebGL2RenderingContext', { configurable: true,
          value: function WebGL2RenderingContext() {} });
      }
      const gameLayer = document.createElement('div');
      const shellRoot = document.createElement('div');
      document.body.append(canvas, gameLayer, shellRoot);
      let finish;
      let runtimeDiagnostics = null;
      const exited = new Promise((resolve) => { finish = resolve; });
      const runtime = createGameRuntime({ canvas, gameLayer, shellRoot, networkFacade: facade,
        loadGame: async () => { startupOrder.push('load-game'); return { Game: FakeGame }; }, onExit: finish,
        onNetworkDiagnostics: (value) => { runtimeDiagnostics = value; } });
      const capability = runtime.inspectCapabilities();
      if (!capability.supported) throw new Error(`runtime harness capability: ${JSON.stringify(capability)}`);
      const matchId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
      await runtime.enter({ handoff: { matchId, mode: 'bomb' }, firstMatch: true,
        serverCareer: { modes: { bomb: { totals: { kills: 4, matches: 2, timePlayedSec: 60 } } } } });
      facade.emit('matchState', { phase: 'live' });
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', cancelable: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowLeft', cancelable: true }));
      // DOM button 1 is the middle button, which is `Mouse3` — Mouse1/2/3 are left/right/middle,
      // the convention every FPS uses and the one `mouseCode` now implements. This dispatched
      // button 2 (the RIGHT button) while binding Mouse3, which only lined up under the old
      // `button + 1` arithmetic that put aim-down-sights on the middle button.
      window.dispatchEvent(new MouseEvent('mousedown', { button: 1, cancelable: true }));
      const diagnosticsDuring = runtimeDiagnostics;
      const during = { authority: progression.getAuthority(), kills: progression.data.lifetime.kills,
        matches: progression.data.lifetime.matches, xp: progression.data.xp };
      facade.emit('matchEnded', { matchId, winner: 'alpha', outcomeReason: 'score',
        terminationReason: 'completed' });
      // A duplicate/later terminal cannot rewrite the first authoritative lifecycle fact.
      facade.emit('matchEnded', { matchId, winner: null, outcomeReason: 'no-contest',
        terminationReason: 'aborted' });
      const outcome = await exited;
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight', cancelable: true }));
      return { during, outcome, diagnosticsDuring, diagnosticsAfter: runtimeDiagnostics,
        capabilityOsMajor: capability.observed.osMajor, startupOrder,
        spectatorCycles, tacticalPings, afterAuthority: progression.getAuthority(),
        stored: JSON.parse(localStorage.getItem('overstrike.progress.v1')) };
    });
    equal(runtimeAuthority.during, { authority: 'server', kills: 4, matches: 2, xp: 0 },
      'network runtime replaces modified localStorage with a mode-scoped server career projection');
    equal(runtimeAuthority.capabilityOsMajor, null,
      'Chromium reduced macOS 10_15_7 UA is treated as unknown instead of falsely rejecting modern Macs');
    equal(runtimeAuthority.startupOrder, ['reserve-ticket', 'load-game', 'promote-session'],
      'cold authoritative entry consumes its launch ticket before loading Game and promotes after initialization');
    equal(runtimeAuthority.outcome, {
      reason: 'to-menu', outcome: 'completed', completed: true, mode: 'bomb', firstMatch: true,
      matchId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', winner: 'alpha', outcomeReason: 'score',
      terminationReason: 'completed',
    }, 'production runtime onExit carries the deduped authoritative terminal lifecycle shape');
    equal(runtimeAuthority.afterAuthority, 'practice-unverified',
      'leaving the network runtime restores the explicitly unverified practice projection');
    equal(runtimeAuthority.spectatorCycles, 0,
      'spectate next/previous bindings reach the facade and are removed on runtime exit');
    equal(runtimeAuthority.tacticalPings, 1,
      'bound Mouse3 emits one coordinate-free tactical intent and is removed on runtime exit');
    equal(runtimeAuthority.diagnosticsDuring.rttMs, 24,
      'network runtime forwards measured facade diagnostics to the settings session adapter');
    equal(runtimeAuthority.diagnosticsAfter, null,
      'network diagnostics are cleared when the authoritative runtime exits');
    equal(runtimeAuthority.stored.lifetime.kills, 999999999,
      'network runtime never rewrites or promotes the modified practice blob');

    // ── §4.4 extraction results, driven by the stub scenarios' real wire bodies ─────────
    //
    // The same bodies the platform stub serves for `result-extraction-*`, already passed
    // through the shell's closed validator node-side, now drive the P3-10 screens. The wire
    // shape carries no isLocal and no displayName — the signed-in account is what makes a
    // participant "you", so the session is promoted to the stub account first.
    await page.evaluate((profile) => window.__SHELL__.resumeAuthenticated({
      authenticated: true, profile,
    }), { accountId: stubResults.accountId, displayName: 'Stub Runner', flags: { setupNextStep: null } });
    const showStubResult = (result) => page.evaluate((data) => {
      window.__SHELL__.navigate(`/results/${encodeURIComponent(data.result.matchId)}`);
      window.__SHELL__.injectFixture('results', { variant: 'ready', data });
    }, { result });

    await showStubResult(stubResults.extracted);
    check((await page.locator('[data-local-settlement="extracted"]').count()) === 1,
      'the stub-served extracted run resolves the local participant by ACCOUNT ID, not a fixture flag');
    equal(await page.locator('.os-settlement-card').count(), 2,
      'every roster participant gets a settlement card from the wire shape');
    check((await page.locator('.os-settlement-card[data-settlement="lost"]').count()) === 1,
      'the squadmate death renders as lost alongside the local extraction');
    const extractedText = await page.locator('main').innerText();
    check(extractedText.includes('exit-rail-gate'),
      'the exit used is shown from the wire exitId');
    equal(await page.locator('.os-settlement-card', { hasText: 'You' }).getAttribute('data-account-id'),
      stubResults.accountId, 'the You badge lands on the signed-in account\'s card');

    await showStubResult(stubResults.lost);
    check((await page.locator('[data-local-settlement="lost"]').count()) === 1,
      'a stub-served death presents the lost headline state');

    await showStubResult(stubResults.exception);
    const stubExceptionText = await page.locator('main').innerText();
    check((await page.locator('[data-local-settlement="pending-review"]').count()) === 1,
      'a stub-served open exception presents as held for review');
    check(stubExceptionText.includes('exc-stub-01'),
      'the wire exceptionId is surfaced as the review reference');
    check(stubExceptionText.includes('lock mismatch'),
      'the wire trigger is surfaced in words');

    await showStubResult(stubResults.mixed);
    equal(await page.locator('.os-settlement-card').evaluateAll(
      (nodes) => nodes.map((node) => node.dataset.settlement)),
    ['extracted', 'lost', 'pending-review'],
    'the mixed stub squad renders each wire participant in its own state');
    check((await page.locator('main').innerText()).includes('exc-stub-run-01'),
      'the run-level exception is announced with its wire reference');

    await showStubResult(stubResults.pending);
    check((await page.locator('main').innerText()).includes('This run is still finalising'),
      'the §4.2 pending shape with mode extraction says run, not match');

    await showStubResult(stubResults.retrySafe);
    check((await page.locator('[data-local-settlement="retry-safe"]').count()) === 1,
      'a terminal run with the local participant still `ended` presents the retry-safe state');
    await page.evaluate(() => window.__SHELL__.clearFixture('results'));

    equal(errors, [], 'browser console/page/request errors occurred');

    // Exercise the deployed entrypoint as well as the isolated shell mount above. This catches
    // startup ordering and adapter defects that a synthetic fixture client cannot reproduce.
    const productionContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await productionContext.addInitScript(() => {
      window.__HARNESS_GL_CALLS__ = [];
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function instrumentedGetContext(kind, ...args) {
        if (/^webgl2?$/.test(String(kind))) window.__HARNESS_GL_CALLS__.push(String(kind));
        return original.call(this, kind, ...args);
      };
    });
    const productionRequests = [];
    const productionErrors = [];
    const accountId = '01J00000000000000000000001';
    const sessionId = '01J00000000000000000000002';
    const roamingValues = Object.fromEntries(SETTINGS_INVENTORY
      .filter((definition) => definition.scope === 'ROAM')
      .map((definition) => [definition.key, definition.defaultValue]));
    roamingValues.keybinds = Object.fromEntries(BINDING_ACTIONS.map((action) => [action.id, {
      primary: action.primary, secondary: action.secondary,
    }]));
    await productionContext.route('**/v1/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const correlationId = request.headers()['x-correlation-id'];
      const authorization = request.headers().authorization || null;
      productionRequests.push({ path: `${url.pathname}${url.search}`, authorization });
      const respond = (status, body, headers = {}) => route.fulfill(status === 204 ? {
        status,
        headers: { 'X-Correlation-Id': correlationId, ...headers },
      } : {
        status,
        contentType: 'application/json',
        headers: { 'X-Correlation-Id': correlationId, ...headers },
        body: JSON.stringify(body.error ? body : { ...body, correlationId }),
      });
      if (url.pathname === '/v1/auth/refresh') {
        return respond(200, {
          accessToken: 'fixture-access-token',
          expiresAt: '2026-08-20T18:00:00.000Z',
          session: { sessionId, deviceLabel: 'Acceptance browser', createdAt: '2026-08-20T16:00:00.000Z' },
          profile: { accountId, displayName: 'Fixture Player', createdAt: '2026-08-20T16:00:00.000Z',
            privacy: { statsVisibility: 'everyone', presenceVisibility: 'everyone' }, consent: null,
            moderation: { status: 'clear', activeSanctions: [] },
            flags: { nameChangeAvailableAt: null, setupNextStep: null } },
          consentReceipt: null,
        });
      }
      if (!authorization) {
        return respond(401, { error: {
          code: 'AUTH_REQUIRED', message: 'Authentication required.', correlationId,
          retryable: false, retryAfterMs: null, details: {},
        } });
      }
      if (url.pathname === '/v1/profile/me') {
        return respond(200, { accountId, displayName: 'Fixture Player', createdAt: '2026-08-20T16:00:00.000Z',
          privacy: { statsVisibility: 'everyone', presenceVisibility: 'everyone' },
          consent: null, moderation: { status: 'clear', activeSanctions: [] },
          flags: { nameChangeAvailableAt: null, setupNextStep: null } });
      }
      if (url.pathname === `/v1/profile/${accountId}`) {
        return respond(200, { accountId, displayName: 'Fixture Player', createdAt: '2026-08-20T16:00:00.000Z',
          stats: null, presence: { state: 'online', joinable: false, roomId: null } });
      }
      if (url.pathname === '/v1/onboarding/consent') {
        return respond(200, { telemetryPersonal: false, policyVersion: 1,
          decidedAt: '2026-08-20T16:01:00.000Z', currentPolicyVersion: 1,
          subject: 'account', receipt: 'fixture-decline-receipt' });
      }
      if (url.pathname === '/v1/profile/me/settings') {
        return respond(200, { schemaVersion: ROAMING_SETTINGS_SCHEMA_VERSION, version: 1,
          values: roamingValues, updatedAt: '2026-08-20T16:02:00.000Z' }, { ETag: '"1"' });
      }
      if (url.pathname === '/v1/config/flags') {
        return respond(200, { version: 41, evaluatedAt: '2026-08-20T16:02:00.000Z',
          expiresAt: '2099-08-20T16:03:00.000Z', flags: {
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
          } });
      }
      if (url.pathname === '/v1/config/flags') {
        return respond(200, { version: 1, evaluatedAt: '2026-08-20T16:00:00.000Z',
          expiresAt: '2026-08-20T16:01:00.000Z', flags: {
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
          } });
      }
      if (url.pathname === '/v1/telemetry/unload/credential') return respond(204, {});
      if (url.pathname === '/v1/matches/active') return respond(204, {});
      if (url.pathname === `/v1/profile/${accountId}/stats`) {
        const totals = { kills: 10, deaths: 5, assists: 2, suicides: 0, teamKills: 0,
          headshots: 3, shotsFired: 50, shotsHit: 20, damageDealt: 1000, plants: 0,
          defuses: 0, matches: 2, wins: 1, losses: 1, draws: 0, roundsPlayed: 0,
          timePlayedSec: 600 };
        return respond(200, { accountId, modes: {
          tdm: { accountId, mode: 'tdm', statDefinitionVersion: '1.0.0', totals, weapons: {} },
          bomb: { accountId, mode: 'bomb', statDefinitionVersion: '1.0.0', totals, weapons: {} },
        } });
      }
      return respond(404, { error: { code: 'NOT_FOUND', message: 'Not found.', correlationId,
        retryable: false, retryAfterMs: null, details: {} } });
    });
    const productionPage = await productionContext.newPage();
    const productionResources = [];
    productionPage.on('request', (request) => productionResources.push(request.url()));
    productionPage.on('response', (response) => {
      if (response.status() >= 400) productionErrors.push(`response.${response.status()}: ${response.url()}`);
    });
    productionPage.on('pageerror', (error) => productionErrors.push(`pageerror: ${error.message}`));
    productionPage.on('console', (message) => {
      if (message.type() === 'error') productionErrors.push(`console.error: ${message.text()}`);
    });
    await productionPage.goto(`${base}/career/overview`, { waitUntil: 'domcontentloaded' });
    await productionPage.waitForFunction(() => window.__OVERSTRIKE_SHELL__?.getState().session?.authenticated === true);
    await productionPage.waitForFunction(() => document.querySelector('#shell-root')?.dataset.variant !== 'loading');
    equal(productionRequests[0]?.path, '/v1/auth/refresh', 'cold protected entry must refresh before issuing protected loaders');
    equal(productionRequests.filter(({ path: requestPath }) => requestPath.startsWith(`/v1/profile/${accountId}/stats`)).length,
      1, `cold restore must issue the preserved route loader exactly once; requests=${JSON.stringify(productionRequests)}`);
    equal(await productionPage.locator('#shell-root').getAttribute('data-route'), 'career.overview', 'authenticated cold refresh must preserve its deep link');
    equal(await productionPage.locator('main').count(), 1, 'production entry must expose one main landmark');
    equal(await productionPage.locator('h1').count(), 1, 'production entry must expose one page h1');
    equal(await productionPage.evaluate(() => window.__HARNESS_GL_CALLS__.length), 0, 'production shell entry must remain WebGL-free');
    check(!productionResources.some((url) => /\/src\/core\/game\.js|\/game-[^/]+\.js|three(?:\.module)?\.js/i.test(url)), 'production shell entry requested game/three code');
    equal(productionErrors, [], 'production entry emitted browser errors');
    await productionContext.close();
  } finally {
    await browser?.close();
    await server?.close();
  }
}

try {
  await modelChecks();
  const stubResults = await extractionResultChecks();
  await browserChecks(stubResults);
  console.log(`✓ UI shell acceptance passed (${checks} assertions).`);
} catch (error) {
  console.error(`✗ UI shell acceptance failed after ${checks} assertions.`);
  console.error(error?.stack || error);
  process.exitCode = 1;
}
