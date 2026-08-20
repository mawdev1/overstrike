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
import { SHELL_SCREEN_FIXTURES, SHELL_VARIANT_MATRIX } from '../src/ui/shell/fixtures.js';
import { Input } from '../src/core/input.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_CATEGORIES = Object.freeze([
  'input', 'bindings', 'graphics', 'audioCaptions', 'crosshairHud', 'accessibility', 'network',
]);
const EXPECTED_SCOPES = Object.freeze(['ROAM', 'DEVICE', 'SESSION', 'PRACTICE']);
const REQUIRED_VARIANTS = Object.freeze(['loading', 'error', 'offline', 'ready']);
const EMPTY_NA = new Set([
  'welcome', 'auth.signIn', 'auth.create', 'auth.recover', 'onboarding.eligibility',
  'onboarding.displayName', 'onboarding.verify', 'onboarding.terms', 'room.loadout',
  'room.chat', 'career.matchDetail', 'match.loading', 'results', 'system',
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
    .replace(':category', 'accessibility')
    .replace(':condition', 'maintenance');
}

async function modelChecks() {
  equal(SETTINGS_CATEGORIES.map((item) => item.id), EXPECTED_CATEGORIES, 'settings category IDs drifted from vocabulary v1');
  equal(Object.keys(SETTINGS_SCOPES), EXPECTED_SCOPES, 'settings scope vocabulary must be exact');
  equal(LOCAL_SETTINGS_SCHEMA_VERSION, 2, 'local repair schema must remain independently versioned');
  equal(ROAMING_SETTINGS_SCHEMA_VERSION, 1, 'HTTP roaming schema must match RoamingSettingsV1');
  equal(SHELL_ROUTES.length, 27, 'the shell route inventory must contain 27 addressable routes');

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
const client = {
  async signIn() {
    window.__HARNESS_AUTH_CALLS__++;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { authenticated: true, profile: { displayName: 'Fixture Player', flags: { setupNextStep: null } } };
  },
};
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

async function browserChecks() {
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
          profile: { accountId, displayName: 'Fixture Player', flags: { setupNextStep: null },
            presence: { roomId: null }, consent: null },
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
          privacy: { statsVisibility: 'public', presenceVisibility: 'public' }, presence: { roomId: null },
          consent: null, flags: { setupNextStep: null } });
      }
      if (url.pathname === '/v1/onboarding/consent') {
        return respond(200, { telemetryPersonal: false, policyVersion: 1,
          decidedAt: '2026-08-20T16:01:00.000Z', subject: 'account', receipt: 'fixture-decline-receipt' });
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
      if (url.pathname === '/v1/matches/active') return respond(204, {});
      if (url.pathname === `/v1/profile/${accountId}/stats`) {
        const totals = { kills: 10, deaths: 5, assists: 2, suicides: 0, teamKills: 0,
          headshots: 3, shotsFired: 50, shotsHit: 20, damageDealt: 1000, plants: 0,
          defuses: 0, matches: 2, wins: 1, losses: 1, draws: 0, roundsPlayed: 0,
          timePlayedSec: 600 };
        return respond(200, { modes: { tdm: { accountId, mode: 'tdm',
          statDefinitionVersion: '1.0.0', totals, weapons: {} } } });
      }
      return respond(404, { error: { code: 'NOT_FOUND', message: 'Not found.', correlationId,
        retryable: false, retryAfterMs: null, details: {} } });
    });
    const productionPage = await productionContext.newPage();
    const productionResources = [];
    productionPage.on('request', (request) => productionResources.push(request.url()));
    productionPage.on('pageerror', (error) => productionErrors.push(`pageerror: ${error.message}`));
    productionPage.on('console', (message) => {
      if (message.type() === 'error') productionErrors.push(`console.error: ${message.text()}`);
    });
    await productionPage.goto(`${base}/career/overview`, { waitUntil: 'domcontentloaded' });
    await productionPage.waitForFunction(() => window.__OVERSTRIKE_SHELL__?.getState().session?.authenticated === true);
    await productionPage.waitForFunction(() => document.querySelector('#shell-root')?.dataset.variant !== 'loading');
    equal(productionRequests[0]?.path, '/v1/auth/refresh', 'cold protected entry must refresh before issuing protected loaders');
    equal(productionRequests.filter(({ path: requestPath }) => requestPath.startsWith(`/v1/profile/${accountId}/stats`)).length,
      1, 'cold restore must issue the preserved route loader exactly once');
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
  await browserChecks();
  console.log(`✓ UI shell acceptance passed (${checks} assertions).`);
} catch (error) {
  console.error(`✗ UI shell acceptance failed after ${checks} assertions.`);
  console.error(error?.stack || error);
  process.exitCode = 1;
}
