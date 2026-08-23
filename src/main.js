import {
  SessionState,
  createFeatureFlagState,
  createPlatformClient,
  createShellApi,
  createTelemetryClient,
  createUlid,
  installUnhandledErrorTelemetry,
  installWebglLossTelemetry,
} from './ui/platform/index.js';
import { mountAppShell } from './ui/shell/index.js';
import { createGameRuntime, identifyRuntimeClient } from './ui/shell/gameRuntime.js';
import { createSettingsController } from './ui/shell/settings/index.js';
import { createLobbyShellAdapter } from './ui/lobby/index.js';
import { BRIDGED_KEYS, toGameValue, toShellValue } from './ui/shell/settingsBridge.js';

const PROF = (globalThis.__BOOTPROF__ = {
  moduleEval: +performance.now().toFixed(1),
  bootPainted: 0,
  shellMounted: 0,
  gameConstructed: 0,
  menu: 0,
  firstFrame: 0,
  phases: null,
});

requestAnimationFrame(() => { PROF.bootPainted = +performance.now().toFixed(1); });

const shellRoot = document.getElementById('shell-root');
const gameLayer = document.getElementById('game-layer');
const canvas = document.getElementById('game-canvas');
const boot = document.getElementById('boot');
const bootText = boot?.querySelector('.boot-msg');
const bootFill = boot?.querySelector('.boot-bar i');

function requireElement(value, name) {
  if (!(value instanceof HTMLElement)) throw new Error(`Missing application element: ${name}`);
  return value;
}

requireElement(shellRoot, 'shell-root');
requireElement(gameLayer, 'game-layer');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Missing application element: game-canvas');

const clientBuild = import.meta.env.VITE_CLIENT_BUILD || '1.0.0';
const platformBaseUrl = import.meta.env.VITE_PLATFORM_BASE_URL || '';
function readDevStubConfig() {
  if (!import.meta.env.DEV) return { scenario: null, runId: null, accountId: null };
  const scenarioKey = 'overstrike.dev.stub-scenario';
  const runKey = 'overstrike.dev.stub-run-id';
  const accountKey = 'overstrike.dev.stub-account-id';
  const requested = new URL(globalThis.location.href).searchParams.get('stubScenario');
  try {
    if (requested === 'off') {
      sessionStorage.removeItem(scenarioKey);
      sessionStorage.removeItem(runKey);
      return { scenario: null, runId: null, accountId: null };
    }
    if (requested && /^[a-z0-9-]{1,64}$/.test(requested)) sessionStorage.setItem(scenarioKey, requested);
    const scenario = sessionStorage.getItem(scenarioKey);
    if (!scenario || !/^[a-z0-9-]{1,64}$/.test(scenario)) {
      return { scenario: null, runId: null, accountId: null };
    }
    let runId = sessionStorage.getItem(runKey);
    if (!runId) {
      runId = createUlid();
      sessionStorage.setItem(runKey, runId);
    }
    // This non-secret fixture id deliberately lives in localStorage so separate development
    // tabs exercise the contract's account-scoped session/revocation state.
    let accountId = localStorage.getItem(accountKey);
    if (!accountId) {
      accountId = createUlid();
      localStorage.setItem(accountKey, accountId);
    }
    return { scenario, runId, accountId };
  } catch {
    return requested && /^[a-z0-9-]{1,64}$/.test(requested)
      ? { scenario: requested, runId: createUlid(), accountId: createUlid() }
      : { scenario: null, runId: null, accountId: null };
  }
}

const { scenario: devStubScenario, runId: devStubRunId,
  accountId: devStubAccountId } = readDevStubConfig();

const browserFetch = globalThis.fetch.bind(globalThis);
const transport = devStubScenario
  ? (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set('X-Stub-Scenario', devStubScenario);
    headers.set('X-Client-Session-Id', devStubRunId);
    headers.set('X-Stub-Account-Id', devStubAccountId);
    return browserFetch(input, { ...init, headers });
  }
  : browserFetch;

const session = new SessionState();
const platformClient = createPlatformClient({
  baseUrl: platformBaseUrl,
  clientBuild,
  fetch: transport,
  session,
});
let shell = null;
const featureFlags = createFeatureFlagState();
const telemetry = createTelemetryClient({
  client: platformClient,
  onConsentRequired: () => shell?.navigate('/onboarding/consent'),
}).start();

let shellApi = null;
let runtime = null;

function applyDocumentPreference(key, value) {
  const root = document.documentElement;
  if (key === 'reduceMotion') {
    root.classList.toggle('os-prefer-reduced-motion', value === true);
  } else if (key === 'colorVisionPreset') {
    root.dataset.colorVision = value;
  } else if (key === 'subtitleSize') {
    root.dataset.subtitleSize = value;
  } else if (key === 'hudTextSize') {
    root.dataset.hudTextSize = value;
  } else if (key === 'brightness') {
    root.style.setProperty('--os-game-brightness', `${Number(value) / 100}`);
  } else if (['cameraShake', 'viewBob', 'weaponSway', 'flashIntensity',
    'screenEffectIntensity', 'captionBackground'].includes(key)) {
    root.style.setProperty(`--os-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      `${Number(value) / 100}`);
  } else if (['subtitles', 'closedCaptions', 'captionDirection'].includes(key)) {
    root.dataset[key] = value === true ? 'on' : 'off';
  }
}

/**
 * Set while the shell is pushing its snapshot into the game, so the write-back below ignores
 * the echo. Without it, one shell change becomes shell → game → shell → game forever.
 */
let applyingShellSettings = false;
const bridgedGames = new WeakSet();

function configureGameFromSettings(game) {
  if (!game?.settings) return;
  const snapshot = settings.getSnapshot();
  const values = snapshot.values;
  game.clientFeatureFlags = featureFlags.snapshot().flags;
  applyingShellSettings = true;
  try {
    for (const key of BRIDGED_KEYS) {
      game.settings.set(key, toGameValue(key, values[key]));
    }
    // The one gated read: an unshipped mode must not load even if the stored value names it.
    // The WRITE below is deliberately ungated — the player chose it and the UI accepted it.
    if (!(featureFlags.isEnabled('mode.bomb.enabled') && featureFlags.isEnabled('map.the_square.enabled'))) {
      game.settings.set('mode', 'tdm');
    }
    if (game.canvas?.style) {
      game.canvas.style.filter = `brightness(${toGameValue('brightness', values.brightness)})`;
    }

    const binds = {};
    for (const [action, slots] of Object.entries(snapshot.bindings)) {
      if (slots.primary) binds[slots.primary] = action;
      if (slots.secondary) binds[slots.secondary] = action;
    }
    game.settings.set('binds', binds);
  } finally {
    applyingShellSettings = false;
  }

  // Write-back, subscribed once per game instance. This is what makes a change in the pause
  // menu outlive the match it was made in.
  if (!bridgedGames.has(game)) {
    bridgedGames.add(game);
    game.settings.onChange?.((key, value) => {
      if (applyingShellSettings || key === '*' || !BRIDGED_KEYS.includes(key)) return;
      try { settings.set(key, toShellValue(key, value)); } catch { /* rejected by the shell's own validation */ }
    });
  }
}

const settings = createSettingsController({
  prefersReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  syncAdapter: { save: (payload) => shellApi.saveSettings(payload) },
  onApply(key, value) {
    applyDocumentPreference(key, value);
    const game = runtime?.getGame();
    if (game) configureGameFromSettings(game);
  },
});

for (const key of ['reduceMotion', 'colorVisionPreset', 'subtitleSize', 'hudTextSize', 'brightness', 'cameraShake', 'viewBob',
  'weaponSway', 'flashIntensity', 'screenEffectIntensity', 'captionBackground', 'subtitles',
  'closedCaptions', 'captionDirection']) {
  applyDocumentPreference(key, settings.get(key));
}

const baseShellApi = createShellApi({ client: platformClient, telemetry, settings });
const accountShellApi = Object.freeze({
  ...baseShellApi,
  async signIn(payload) {
    const result = await baseShellApi.signIn(payload);
    await hydrateRemoteSettings().catch(() => null);
    return result;
  },
  async signUp(payload) {
    const result = await baseShellApi.signUp(payload);
    await hydrateRemoteSettings().catch(() => null);
    return result;
  },
});
shellApi = createLobbyShellAdapter({
  client: accountShellApi,
  reportAdapter: async (payload) => (await platformClient.request('/v1/reports', {
    method: 'POST', body: payload, maxAttempts: 1,
  })).data,
  onSnapshot(snapshot) {
    const current = shell?.getRoute?.();
    if (current?.id?.startsWith('room.') && current.params.roomId === snapshot.roomId) {
      shell.setView({ variant: 'ready', data: snapshot });
    }
  },
  onMatchReady(_handoff, snapshot) {
    const current = shell?.getRoute?.();
    if (current?.id?.startsWith('room.') && current.params.roomId === snapshot.roomId) {
      // `/match/loading` already owns the capability check and exact handoff-to-runtime action.
      // The adapter's getActiveMatch returns this same in-memory validated handoff to its loader.
      shell.navigate('/match/loading');
    }
  },
});

let networkFacadePromise = null;
function loadNetworkFacade() {
  if (networkFacadePromise) return networkFacadePromise;
  networkFacadePromise = import('./net/facade.js').then(({ net }) => {
    // Reconnect tickets must travel through the authenticated platform client. The facade
    // deliberately has no cookie-only fetch fallback, and the game bundle remains outside
    // the shell's initial module graph until an authoritative handoff is entered.
    net.setTicketProvider((matchId) => shellApi.reconnectMatch({ matchId }));
    return net;
  }).catch((error) => {
    networkFacadePromise = null;
    throw error;
  });
  return networkFacadePromise;
}

function applyHydratedDocumentPreferences() {
  for (const key of ['reduceMotion', 'colorVisionPreset', 'subtitleSize', 'hudTextSize', 'brightness', 'cameraShake', 'viewBob',
    'weaponSway', 'flashIntensity', 'screenEffectIntensity', 'captionBackground', 'subtitles',
    'closedCaptions', 'captionDirection']) {
    applyDocumentPreference(key, settings.get(key));
  }
}

let settingsHydration = null;
function hydrateRemoteSettings() {
  if (settingsHydration) return settingsHydration;
  settingsHydration = shellApi.getSettings()
    .then((result) => {
      applyHydratedDocumentPreferences();
      return result;
    })
    .finally(() => { settingsHydration = null; });
  return settingsHydration;
}

let flagRefresh = null;
let flagRefreshTimer = null;
function refreshFeatureFlags() {
  if (!session.snapshot().authenticated) return Promise.resolve(featureFlags.snapshot());
  if (flagRefresh) return flagRefresh;
  flagRefresh = shellApi.getFlags()
    .then((projection) => {
      const snapshot = featureFlags.update(projection);
      telemetry.setEnabled(featureFlags.isEnabled('telemetry.client.enabled'));
      clearTimeout(flagRefreshTimer);
      const delay = Math.max(1_000, Math.min(60_000,
        Date.parse(snapshot.expiresAt) - Date.now()));
      flagRefreshTimer = setTimeout(() => { void refreshFeatureFlags().catch(() => {}); }, delay);
      return snapshot;
    })
    .catch((error) => {
      // Keep the last evaluated/default values, but do not let a transient outage permanently
      // stop kill-switch refreshes. Screens never wait on this retry.
      clearTimeout(flagRefreshTimer);
      flagRefreshTimer = setTimeout(() => { void refreshFeatureFlags().catch(() => {}); }, 5_000);
      throw error;
    })
    .finally(() => { flagRefresh = null; });
  return flagRefresh;
}

let contextRestore = null;
function restoreAuthenticatedContext({ resumeShell = true } = {}) {
  if (contextRestore) return contextRestore;
  contextRestore = (async () => {
    await platformClient.refresh();
    const profile = await shellApi.getProfile();
    await shellApi.getConsent();
    await hydrateRemoteSettings();
    if (resumeShell && shell) await shell.resumeAuthenticated({ profile });
    return profile;
  })().finally(() => { contextRestore = null; });
  return contextRestore;
}

const shellSession = Object.freeze({
  snapshot: () => ({ ...session.snapshot(), clientSessionId: telemetry.getClientSessionId() }),
  subscribe(listener) {
    return session.subscribe((state) => listener({
      ...state,
      clientSessionId: telemetry.getClientSessionId(),
    }));
  },
  clear: (reason, broadcast) => session.clear(reason, broadcast),
  getClientSessionId: () => telemetry.getClientSessionId(),
  refreshIfNeeded: () => restoreAuthenticatedContext({ resumeShell: true }).catch((error) => {
    if (['AUTH_REQUIRED', 'AUTH_TOKEN_INVALID', 'AUTH_SESSION_REVOKED', 'AUTH_SESSION_REPLACED']
      .includes(error?.code)) return null;
    shell?.setView({
      variant: ['CLIENT_NETWORK', 'CLIENT_TIMEOUT'].includes(error?.code) ? 'offline' : 'error',
      error,
    });
    return null;
  }),
});

session.subscribe((state) => {
  if (state.authenticated) {
    void hydrateRemoteSettings().catch(() => {});
    void refreshFeatureFlags().catch(() => {});
  } else {
    shellApi?.disconnectLobby?.('session ended');
  }
});

let runtimeReturnPath = '/play/rooms';
let removeWebglLossTelemetry = () => {};
runtime = createGameRuntime({
  canvas,
  onCanvasReplaced: (fresh) => {
    removeWebglLossTelemetry();
    removeWebglLossTelemetry = installWebglLossTelemetry(telemetry, fresh);
  },
  gameLayer,
  shellRoot,
  boot,
  bootFill,
  bootText,
  configureGame: configureGameFromSettings,
  loadNetworkFacade,
  onNetworkDiagnostics: (diagnostics) => settings.setSessionDiagnostics(diagnostics),
  onUnsupported(reason, observed) {
    const identity = identifyRuntimeClient(navigator);
    telemetry.recordUnsupported({
      reason,
      browser: observed?.browser || identity.browser,
      browserMajor: observed?.browserMajor ?? identity.browserMajor,
      os: observed?.os || identity.os,
    });
  },
  onExit: (outcome) => {
    shell?.restoreShell(runtimeReturnPath, outcome);
    void refreshFeatureFlags().catch(() => {});
  },
});

// Start cookie-backed restoration before mounting the router. The shell receives this same
// promise as a boot barrier, so a protected deep link can never race a tokenless request ahead
// of refresh. The outcome is handled after mount, when navigation/render methods exist.
const sessionRestore = restoreAuthenticatedContext({ resumeShell: false }).then((profile) => {
  return { authenticated: true, profile, error: null };
}).catch((error) => ({ authenticated: false, profile: null, error }));

shell = mountAppShell({
  root: shellRoot,
  client: shellApi,
  session: shellSession,
  telemetry,
  featureFlags,
  clientIdentity: identifyRuntimeClient(navigator),
  settings,
  bootReady: sessionRestore,
  deferInitialLoad: true,
  loadGameRuntime: async ({ handoff, firstMatch }) => {
    runtimeReturnPath = handoff.localPractice === true
      ? '/welcome'
      : handoff.fixture === true
      ? '/play/rooms'
      : handoff.roomId
        ? `/room/${encodeURIComponent(handoff.roomId)}`
        : handoff.matchId
          ? `/results/${encodeURIComponent(handoff.matchId)}`
          : '/play/rooms';
    const snapshot = settings.getSnapshot();
    const networked = handoff && handoff.fixture !== true && handoff.localPractice !== true;
    // Career hydration is best-effort and mode-scoped. Failure cannot block joining a live
    // match; the runtime still switches to a neutral server-authoritative projection so the
    // practice localStorage blob never becomes the fallback authority.
    const serverCareer = networked
      ? await shellApi.getCareerOverview().catch(() => null)
      : null;
    const game = await runtime.enter({
      handoff,
      firstMatch,
      serverCareer,
      matchOptions: {
        mode: featureFlags.isEnabled('mode.bomb.enabled') && featureFlags.isEnabled('map.the_square.enabled')
          ? snapshot.values.mode : 'tdm',
        difficulty: snapshot.values.difficulty,
        botCount: snapshot.values.botCount,
        killLimit: snapshot.values.killLimit,
        seed: Number.isSafeInteger(handoff?.seed) ? handoff.seed : undefined,
      },
      onProgress: (_value, label) => { if (bootText) bootText.textContent = label; },
    });
    PROF.gameConstructed = +performance.now().toFixed(1);
    PROF.menu = PROF.gameConstructed;
    PROF.phases = game.bootProfile?.phases || null;
    requestAnimationFrame(() => { PROF.firstFrame = +performance.now().toFixed(1); });
    return game;
  },
});
PROF.shellMounted = +performance.now().toFixed(1);

Object.defineProperty(globalThis, '__OVERSTRIKE_SHELL__', {
  configurable: true,
  value: shell,
});

installUnhandledErrorTelemetry(telemetry);
// The runtime retires a canvas with the match that owned it (its GL context is force-lost on
// teardown, which the element can never come back from), so the loss listeners have to follow
// the live element or GPU-fault telemetry would silently stop after the first match.
removeWebglLossTelemetry = installWebglLossTelemetry(telemetry, canvas);

// Finish the deferred first route only after the cookie-backed restore outcome is known.
void sessionRestore.then(async ({ authenticated, profile, error }) => {
  if (authenticated) {
    await shell.resumeAuthenticated({ profile });
    return;
  }
  if (['AUTH_REQUIRED', 'AUTH_TOKEN_INVALID', 'AUTH_SESSION_REVOKED', 'AUTH_SESSION_REPLACED']
    .includes(error?.code)) {
    shell.finishSessionRestore({ authenticated: false });
    return;
  }
  if (error?.code === 'MAINTENANCE') {
    shell.navigate('/system/maintenance');
    shell.setView({ variant: 'terminal', error });
    return;
  }
  if (error?.code === 'UNSUPPORTED_CLIENT') {
    shell.navigate('/system/update-required');
    shell.setView({ variant: 'terminal', error });
    return;
  }
  shell.setView({
    variant: ['CLIENT_NETWORK', 'CLIENT_TIMEOUT'].includes(error?.code) ? 'offline' : 'error',
    error,
  });
});
