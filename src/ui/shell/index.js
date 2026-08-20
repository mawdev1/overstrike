import './shell.css';

import { checkShellCapabilities } from './capabilities.js';
import { actionButton, element, shellLink } from './dom.js';
import { getShellFixture, resolveShellFixture, SHELL_SCREEN_FIXTURES, SHELL_VARIANT_MATRIX } from './fixtures.js';
import { createModalController } from './modal.js';
import { createHistoryRouter, matchShellRoute, SHELL_ROUTES } from './router.js';
import { renderShellScreen } from './screens.js';

export const SHELL_FEATURE_DEFAULTS = Object.freeze({
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
});

const ROUTE_LOADERS = Object.freeze({
  'onboarding.consent': 'getConsent',
  'onboarding.terms': 'getTerms',
  'onboarding.essentialSettings': 'getSettings',
  'play.rooms': 'listRooms',
  'play.roomDetail': 'getRoom',
  'room.home': 'getLobbySnapshot',
  'room.roster': 'getLobbySnapshot',
  'room.chat': 'getChatHistory',
  'career.overview': 'getCareerOverview',
  'career.modes': 'getCareerModes',
  'career.weapons': 'getCareerWeapons',
  'career.matches': 'listMatches',
  'career.matchDetail': 'getMatch',
  'settings.category': 'getSettings',
  sessions: 'listSessions',
  'match.loading': 'getActiveMatch',
  'match.reconnect': 'getActiveMatch',
  results: 'getResult',
});

function loaderForRoute(route) {
  if (route.id === 'settings.category') {
    if (['profile', 'privacy'].includes(route.params.category)) return 'getProfile';
    if (route.params.category === 'loadout') return null;
  }
  return ROUTE_LOADERS[route.id] || null;
}

function isAuthenticatedRoute(route) {
  return route.id.startsWith('play.') || route.id.startsWith('room.')
    || route.id.startsWith('career.') || route.id === 'settings.category'
    || route.id === 'sessions' || route.id.startsWith('match.') || route.id === 'results';
}

function canPreserveDeepLink(route) {
  return route.id.startsWith('play.') || route.id.startsWith('career.')
    || route.id === 'settings.category' || route.id === 'sessions' || route.id === 'results';
}

function canPreserveWhileInRoom(route) {
  return route.id.startsWith('career.') || route.id === 'settings.category'
    || route.id === 'sessions' || route.id === 'results';
}

const SETUP_PATHS = Object.freeze({
  eligibility: '/onboarding/eligibility',
  consent: '/onboarding/consent',
  'display-name': '/onboarding/display-name',
  verify: '/onboarding/verify',
  terms: '/onboarding/terms',
  'essential-settings': '/onboarding/essential-settings',
});

const FORM_ROUTES = new Set([
  'welcome', 'auth.signIn', 'auth.create', 'auth.recover',
  'onboarding.eligibility', 'onboarding.consent', 'onboarding.displayName',
  'onboarding.verify', 'onboarding.terms', 'onboarding.essentialSettings', 'system',
]);

function normalizeVariant(value) {
  const variants = {
    success: 'ready',
    ready: 'ready',
    loading: 'loading',
    empty: 'empty',
    error: 'error',
    'recoverable-error': 'error',
    offline: 'offline',
    stale: 'offline',
    terminal: 'terminal',
    policy: 'terminal',
    unavailable: 'unavailable',
  };
  return variants[value] || 'ready';
}

function normalizeView(input, fallback = 'ready') {
  if (!input) return Object.freeze({ variant: fallback, data: Object.freeze({}) });
  const variant = normalizeVariant(input.variant || fallback);
  return Object.freeze({ ...input, variant, data: input.data || Object.freeze({}) });
}

function unwrapResult(result) {
  if (result && typeof result === 'object' && 'body' in result) return result.body;
  return result;
}

function sessionSnapshot(session) {
  if (!session) return Object.freeze({ authenticated: false });
  if (typeof session.getSnapshot === 'function') return session.getSnapshot() || Object.freeze({ authenticated: false });
  if (typeof session.snapshot === 'function') return session.snapshot() || Object.freeze({ authenticated: false });
  return session;
}

function connectionSnapshot(client) {
  const connection = client?.connection;
  if (typeof connection?.getSnapshot === 'function') return connection.getSnapshot();
  if (typeof client?.getConnectionSnapshot === 'function') return client.getConnectionSnapshot();
  return null;
}

function nextSetupPath(result) {
  const data = unwrapResult(result);
  const step = data?.profile?.flags?.setupNextStep ?? data?.flags?.setupNextStep;
  return step === null ? '/play/rooms' : SETUP_PATHS[step] || null;
}

function errorVariant(error) {
  const offline = error?.offline === true || ['OFFLINE', 'CLIENT_NETWORK'].includes(error?.code)
    || error?.name === 'NetworkError';
  const terminalCodes = new Set([
    'AUTH_ELIGIBILITY_DENIED', 'AUTH_ACCOUNT_RESTRICTED', 'AUTH_SESSION_REVOKED',
    'CLIENT_UPDATE_REQUIRED', 'UPDATE_REQUIRED', 'MAINTENANCE', 'UNSUPPORTED_CLIENT', 'RECONNECT_GRACE_EXPIRED',
    'ROOM_KICKED', 'ROOM_CLOSED', 'MATCH_INVALIDATED',
  ]);
  let normalizedError = error;
  if (error?.code === 'AUTH_INVALID_CREDENTIALS') {
    normalizedError = { ...error, message: 'The email or password was not accepted.' };
  }
  return {
    variant: offline ? 'offline' : terminalCodes.has(error?.code) ? 'terminal' : 'error',
    error: normalizedError,
    message: normalizedError?.message,
  };
}

function defaultView(route) {
  return normalizeView(null, FORM_ROUTES.has(route.id) ? 'ready' : 'empty');
}

function routePayload(route) {
  return { ...route.params, routeId: route.id };
}

function selectDisplayName(snapshot) {
  return snapshot?.profile?.displayName || snapshot?.displayName || null;
}

function routeTitle(route) {
  if (route.id !== 'settings.category') return route.title;
  const titles = {
    profile: 'Account',
    privacy: 'Privacy choices',
    loadout: 'Loadout',
    input: 'Input settings',
    bindings: 'Bindings',
    graphics: 'Graphics settings',
    audioCaptions: 'Audio and captions',
    crosshairHud: 'Crosshair and HUD',
    accessibility: 'Accessibility settings',
    network: 'Network settings',
  };
  return titles[route.params.category] || route.title;
}

function createNavigation(snapshot, route, isFeatureEnabled) {
  const authenticated = snapshot?.authenticated === true || snapshot?.status === 'authenticated' || Boolean(snapshot?.accountId);
  const nav = element('nav', { className: 'os-primary-nav', 'aria-label': 'Primary' });
  nav.append(shellLink('Overstrike', '/welcome', { className: 'os-brand' }));
  if (authenticated) {
    const links = [
      ['Play', '/play/rooms', () => route.id.startsWith('play.') || (route.id.startsWith('room.') && route.id !== 'room.loadout'), 'shell.serverbrowser.enabled'],
      ['Career', '/career/overview', () => route.id.startsWith('career.'), 'shell.career.enabled'],
      ['Loadout', '/settings/loadout', () => route.id === 'room.loadout'
        || (route.id === 'settings.category' && route.params.category === 'loadout')],
      ['Settings', '/settings/accessibility', () => route.id === 'settings.category'
        && !['profile', 'privacy', 'loadout'].includes(route.params.category)],
    ];
    for (const [label, href, isCurrent, flagKey] of links) {
      if (flagKey && !isFeatureEnabled(flagKey)) continue;
      nav.append(shellLink(label, href, { 'aria-current': isCurrent() ? 'page' : null }));
    }
    nav.append(shellLink(selectDisplayName(snapshot) || 'Account', '/settings/profile', {
      className: 'os-account-link',
      'aria-current': route.id === 'settings.category' && ['profile', 'privacy'].includes(route.params.category) ? 'page' : null,
    }));
  } else {
    nav.append(shellLink('Sign in', '/auth/sign-in', { 'aria-current': route.id === 'auth.signIn' ? 'page' : null }));
    nav.append(shellLink('Create account', '/onboarding/eligibility'));
  }
  return nav;
}

function connectionBanner(connection) {
  const banner = element('aside', { className: 'os-connection', 'aria-label': 'Connection status' });
  if (!connection) {
    banner.hidden = true;
    return banner;
  }
  const platform = connection.platform || connection.http || 'unknown';
  const lobby = connection.lobby || 'disconnected';
  const match = connection.match || 'idle';
  const unhealthy = !['online', 'healthy'].includes(platform) || !['synchronized', 'disconnected', 'closed'].includes(lobby) || !['idle', 'live', 'ended'].includes(match);
  banner.hidden = !unhealthy;
  banner.append(element('strong', {}, 'Connection status'));
  banner.append(element('span', {}, `Platform: ${platform}; lobby: ${lobby}; match: ${match}.`));
  return banner;
}

const SETUP_STEPS = Object.freeze([
  ['Eligibility', 'onboarding.eligibility'],
  ['Privacy choices', 'onboarding.consent'],
  ['Account details', 'auth.create'],
  ['Display name', 'onboarding.displayName'],
  ['Verification', 'onboarding.verify'],
  ['Terms', 'onboarding.terms'],
  ['Essential settings', 'onboarding.essentialSettings'],
]);

function setupProgress(route) {
  const activeIndex = SETUP_STEPS.findIndex(([, id]) => id === route.id);
  if (activeIndex < 0) return null;
  const list = element('ol', { className: 'os-step-list' });
  SETUP_STEPS.forEach(([label], index) => {
    list.append(element('li', { 'aria-current': index === activeIndex ? 'step' : null }, [
      element('span', { className: 'os-step-number' }, String(index + 1)),
      element('span', {}, label),
    ]));
  });
  return element('nav', { className: 'os-setup-progress', 'aria-label': 'Account setup progress' }, list);
}

function invokeTelemetry(telemetry, method, ...args) {
  try {
    if (typeof telemetry?.[method] === 'function') telemetry[method](...args);
  } catch {
    // Telemetry must never prevent the shell from operating.
  }
}

/**
 * Mount the out-of-match shell. The client is an adapter exposing named methods
 * (for example `listRooms`) or `perform(operation, payload)`. It owns transport,
 * auth refresh, correlation IDs, and response validation.
 */
export function mountAppShell({
  root,
  client = null,
  session = null,
  telemetry = null,
  clientIdentity = null,
  loadGameRuntime = null,
  settings = null,
  fixtures = null,
  fixtureVariant = 'ready',
  initialPath,
  featureFlags = null,
  window: windowRef = globalThis.window,
  capabilityCheck = checkShellCapabilities,
  deferInitialLoad = false,
  bootReady = null,
} = {}) {
  if (!(root instanceof HTMLElement)) throw new TypeError('mountAppShell requires an HTMLElement root.');

  let destroyed = false;
  let route = matchShellRoute(initialPath || windowRef?.location?.pathname || '/welcome');
  let view = defaultView(route);
  let snapshot = sessionSnapshot(session);
  let connection = connectionSnapshot(client);
  let capabilities;
  try {
    capabilities = capabilityCheck(globalThis);
  } catch (error) {
    capabilities = Object.freeze({ supported: false, failures: Object.freeze(['capability-check']), observed: Object.freeze({}), error });
  }
  if (!capabilities.supported && clientIdentity && typeof clientIdentity === 'object') {
    const identity = {
      browser: clientIdentity.browser,
      browserMajor: clientIdentity.browserMajor,
      os: clientIdentity.os,
    };
    const reasons = new Set((capabilities.failures || []).map((reason) => (
      reason === 'desktop' ? 'mobile-or-tablet' : reason
    )));
    for (const reason of reasons) {
      invokeTelemetry(telemetry, 'recordUnsupported', { reason, ...identity });
    }
  }
  let runtimeLoaded = false;
  let initialLoadDeferred = Boolean(deferInitialLoad);
  let roomEnteredAt = null;
  let signupCompletedAt = null;
  const settingsFrictionMarks = new Set();
  let activeHandoff = null;
  let bootGate = bootReady
    ? Promise.resolve(bootReady).catch(() => null)
    : null;
  let lastFocusedPath = null;
  let renderCleanups = [];
  const pending = new Map();
  const injectedViews = new Map();
  const draft = Object.create(null);

  const isFeatureEnabled = (key) => {
    const fallback = SHELL_FEATURE_DEFAULTS[key] ?? false;
    try {
      if (typeof featureFlags?.isEnabled === 'function') {
        const evaluated = featureFlags.isEnabled(key);
        return typeof evaluated === 'boolean' ? evaluated : fallback;
      }
      const flagSnapshot = featureFlags?.getSnapshot?.() || featureFlags?.snapshot?.() || featureFlags;
      const value = flagSnapshot?.flags?.[key] ?? flagSnapshot?.[key];
      return typeof value === 'boolean' ? value : fallback;
    } catch {
      return fallback;
    }
  };

  const disabledRouteView = (targetRoute) => {
    if (targetRoute.id.startsWith('career.') && !isFeatureEnabled('shell.career.enabled')) {
      return normalizeView({
        variant: 'unavailable',
        data: { message: 'Career and match history are unavailable right now.' },
      });
    }
    if (targetRoute.id === 'play.rooms' && !isFeatureEnabled('shell.serverbrowser.enabled')) {
      return normalizeView({
        variant: 'unavailable',
        data: { message: 'The server browser is unavailable right now. Direct room links still work.' },
      });
    }
    return null;
  };

  const savedReducedMotion = typeof settings?.get === 'function'
    ? settings.get('reduceMotion')
    : settings?.getSnapshot?.()?.values?.reduceMotion;
  const prefersReducedMotion = savedReducedMotion === true
    || (savedReducedMotion !== false && windowRef?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true);
  root.classList.toggle('os-reduced-motion', prefersReducedMotion);
  root.classList.toggle('os-flag-no-diagnostics', !isFeatureEnabled('shell.diagnostics.panel'));
  root.classList.add('os-shell');
  root.replaceChildren();

  const surface = element('div', { className: 'os-shell__surface' });
  const skipLink = element('a', { className: 'os-skip-link', href: '#os-shell-title' }, 'Skip to main content');
  const header = element('header', { className: 'os-shell__header' });
  const bannerHost = element('div', { className: 'os-shell__banner' });
  const main = element('main', { className: 'os-shell__main', id: 'os-shell-main' });
  const heading = element('h1', { id: 'os-shell-title', tabIndex: -1 });
  const screenHost = element('div', { className: 'os-shell__screen' });
  const footer = element('footer', { className: 'os-shell__footer' }, [
    shellLink('Accessibility settings', '/settings/accessibility'),
    element('span', {}, ' · '),
    shellLink('Privacy', '/settings/privacy'),
    element('span', {}, ' · '),
    shellLink('Terms', '/onboarding/terms'),
    element('span', {}, ' · '),
    shellLink('Status', '/system/status'),
    element('span', {}, ' · '),
    shellLink('Support', '/system/support'),
  ]);
  const live = element('div', { className: 'os-live-region', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const modalLayer = element('div', { className: 'os-shell__modals' });
  main.append(heading, screenHost);
  surface.append(skipLink, header, bannerHost, main, footer, live);
  root.append(surface, modalLayer);
  const modal = createModalController({ layer: modalLayer, inertTarget: surface, documentRef: root.ownerDocument });

  const announce = (message) => {
    live.textContent = '';
    queueMicrotask(() => {
      if (!destroyed) live.textContent = message || '';
    });
  };

  async function callClient(operation, payload = {}) {
    if (typeof client?.[operation] === 'function') return unwrapResult(await client[operation](payload));
    if (typeof client?.perform === 'function') return unwrapResult(await client.perform(operation, payload));
    throw Object.assign(new Error('The platform client is not connected.'), { code: 'CLIENT_UNAVAILABLE' });
  }

  function clearRenderCleanups() {
    for (const cleanup of renderCleanups.splice(0)) {
      try { cleanup?.(); } catch { /* Best-effort component cleanup. */ }
    }
  }

  function applyFixture(nextRoute, variant = fixtureVariant) {
    const injected = injectedViews.get(nextRoute.pathname) || injectedViews.get(nextRoute.id);
    if (injected) return normalizeView(injected);
    const configured = resolveShellFixture(fixtures, nextRoute, variant);
    return configured ? normalizeView(configured) : null;
  }

  function render({ focus = false } = {}) {
    if (destroyed) return;
    clearRenderCleanups();
    root.dataset.route = route.id;
    root.dataset.variant = view.variant;
    root.dataset.runtime = runtimeLoaded ? 'active' : 'shell';
    header.replaceChildren(createNavigation(snapshot, route, isFeatureEnabled));
    bannerHost.replaceChildren(connectionBanner(connection));
    const title = routeTitle(route);
    heading.textContent = title;
    const screen = renderShellScreen({
      route,
      view,
      actions,
      session: snapshot,
      capabilities,
      settings,
      isFeatureEnabled,
    });
    const progress = setupProgress(route);
    screenHost.replaceChildren(...(progress ? [progress, screen] : [screen]));
    const errorSummary = screenHost.querySelector('[data-error-summary]');
    if (errorSummary) queueMicrotask(() => errorSummary.focus());
    const changedPath = lastFocusedPath !== route.pathname;
    if (focus || changedPath) {
      lastFocusedPath = route.pathname;
      announce(title);
      queueMicrotask(() => {
        if (!destroyed && !modal.isOpen()) heading.focus({ preventScroll: true });
      });
    }
  }

  function setView(nextView) {
    view = normalizeView(nextView);
    render();
  }

  async function loadRoute({ preferFixture = true } = {}) {
    const unavailable = disabledRouteView(route);
    if (unavailable) {
      view = unavailable;
      render();
      return view;
    }
    const fixture = preferFixture ? applyFixture(route) : applyFixture(route, 'ready');
    if (fixture) {
      view = fixture;
      render();
      return view;
    }
    const loader = loaderForRoute(route);
    // A deferred initial route is released only by resumeAuthenticated or
    // finishSessionRestore. Returning before the boot barrier prevents the
    // router's startup call and the restore completion from both issuing the
    // same protected request when bootReady settles.
    if (initialLoadDeferred && loader) {
      view = normalizeView({ variant: 'loading', message: 'Restoring session…' });
      render();
      return view;
    }
    if (bootGate) {
      const requestedPath = route.pathname;
      view = normalizeView({ variant: 'loading', message: 'Restoring session…' });
      render();
      await bootGate;
      bootGate = null;
      if (destroyed || route.pathname !== requestedPath) return null;
    }
    const canLoad = typeof client?.loadRoute === 'function' || (loader && typeof client?.[loader] === 'function');
    if (!canLoad) {
      view = defaultView(route);
      render();
      return view;
    }
    const requestedPath = route.pathname;
    view = normalizeView({ variant: 'loading' });
    render();
    try {
      const result = typeof client.loadRoute === 'function'
        ? unwrapResult(await client.loadRoute(route))
        : await callClient(loader, routePayload(route));
      if (route.pathname !== requestedPath || destroyed) return null;
      const nowUnavailable = disabledRouteView(route);
      if (nowUnavailable) {
        view = nowUnavailable;
        render();
        return view;
      }
      view = normalizeView({ variant: result?.variant || 'ready', data: result?.data ?? result });
      render();
      return view;
    } catch (error) {
      if (route.pathname !== requestedPath || destroyed) return null;
      view = normalizeView(errorVariant(error));
      render();
      return view;
    }
  }

  async function request(operation, payload) {
    invokeTelemetry(telemetry, 'operationStarted', operation);
    try {
      const result = await callClient(operation, payload);
      invokeTelemetry(telemetry, 'operationCompleted', operation);
      return result;
    } catch (error) {
      invokeTelemetry(telemetry, 'operationFailed', operation, error?.code || 'UNKNOWN');
      const connectionCodes = new Set([
        'SERVICE_UNAVAILABLE', 'MATCH_SERVER_UNREACHABLE', 'PROTOCOL_VERSION_MISMATCH',
      ]);
      if (connectionCodes.has(error?.code)) {
        const stage = route.id.startsWith('match.') ? 'match'
          : route.id.startsWith('room.') ? 'lobby' : 'platform';
        invokeTelemetry(telemetry, 'connectionFailure', { stage, code: error.code });
      }
      if (operation === 'joinRoom') {
        const reasons = {
          ROOM_PASSWORD_REQUIRED: 'room-password', ROOM_PASSWORD_INVALID: 'room-password',
          ROOM_FULL: 'room-full', TEAM_FULL: 'team-full', SANCTIONED: 'sanctioned',
          ROOM_REMOVED: 'removed', ROOM_IN_PROGRESS: 'in-progress',
          SLOT_RESERVATION_EXPIRED: 'reservation-expired',
        };
        const failure = { code: error?.code, joinBlockedReason: reasons[error?.code] ?? null };
        invokeTelemetry(telemetry, 'record', 'room.join_failure', failure);
      }
      throw error;
    }
  }

  async function submit(operation, payload, { onSuccess, secretInputs = [] } = {}) {
    if (pending.has(operation)) return pending.get(operation);
    const buttons = [...screenHost.querySelectorAll('button[type="submit"], button[data-operation]')];
    buttons.forEach((button) => { button.disabled = true; });
    const pendingStatus = element('p', { className: 'os-pending-status', role: 'status' }, 'Request in progress…');
    screenHost.prepend(pendingStatus);
    root.setAttribute('aria-busy', 'true');
    const task = (async () => {
      try {
        const result = await request(operation, payload);
        if (operation === 'signUp') signupCompletedAt = Date.now();
        await onSuccess?.(result);
        return result;
      } catch (error) {
        setView(errorVariant(error));
        throw error;
      } finally {
        for (const input of secretInputs) if (input) input.value = '';
        pending.delete(operation);
        pendingStatus.remove();
        root.removeAttribute('aria-busy');
        buttons.forEach((button) => { if (button.isConnected) button.disabled = false; });
      }
    })();
    pending.set(operation, task);
    task.catch(() => {});
    return task;
  }

  async function loadMore(collectionKey, cursor) {
    const loader = loaderForRoute(route);
    if (!loader || !cursor) return null;
    const requestKey = `page:${route.id}:${cursor}`;
    if (pending.has(requestKey)) return pending.get(requestKey);
    const requestedPath = route.pathname;
    const requestedCursor = cursor;
    const task = (async () => {
      try {
        const result = await request(loader, { ...routePayload(route), cursor: requestedCursor });
        if (destroyed || route.pathname !== requestedPath || view.data?.nextCursor !== requestedCursor) return null;
        const page = result?.data ?? result ?? {};
        const currentItems = view.data?.[collectionKey] || view.data?.items || [];
        const nextItems = page?.[collectionKey] || page?.items || [];
        const seen = new Set(currentItems.map((item) => item?.id).filter(Boolean));
        const merged = [...currentItems, ...nextItems.filter((item) => !item?.id || !seen.has(item.id))];
        setView({ variant: 'ready', data: { ...view.data, ...page, [collectionKey]: merged } });
        return page;
      } catch (error) {
        announce(error?.message || 'The next page could not be loaded.');
        return null;
      } finally {
        pending.delete(requestKey);
      }
    })();
    pending.set(requestKey, task);
    return task;
  }

  function acceptSession(result) {
    const data = unwrapResult(result);
    injectedViews.delete('/auth/sign-in');
    if (typeof session?.accept === 'function') session.accept(data);
    else if (typeof session?.setSnapshot === 'function') session.setSnapshot(data);
    if (typeof session?.accept === 'function' || typeof session?.setSnapshot === 'function') snapshot = sessionSnapshot(session);
    else snapshot = Object.freeze({ ...data, authenticated: true, profile: data?.profile || data });
  }

  function acceptProfile(result) {
    const profile = unwrapResult(result)?.profile || unwrapResult(result);
    if (!profile || typeof profile !== 'object') return;
    snapshot = Object.freeze({
      ...snapshot,
      displayName: profile.displayName ?? snapshot?.displayName,
      profile: Object.freeze({ ...(snapshot?.profile || {}), ...profile }),
    });
    setView({ variant: 'ready', data: profile });
  }

  async function resumeAfterAuth(result) {
    const setupPath = nextSetupPath(result);
    if (setupPath && setupPath !== '/play/rooms') {
      router.navigate(setupPath);
      return;
    }
    if (typeof client?.getActiveMatch === 'function' || typeof client?.perform === 'function') {
      try {
        const active = await request('getActiveMatch', {});
        if (active?.matchId) {
          injectedViews.set('/match/reconnect', normalizeView({ variant: 'ready', data: active }));
          router.navigate('/match/reconnect');
          return;
        }
      } catch (error) {
        if (error?.code && error.code !== 'NOT_FOUND') {
          setView(errorVariant(error));
          return;
        }
      }
    }
    const data = unwrapResult(result);
    const activeRoomId = data?.profile?.presence?.roomId ?? data?.presence?.roomId;
    if (activeRoomId && !canPreserveWhileInRoom(route)) {
      router.navigate(`/room/${encodeURIComponent(activeRoomId)}`);
      return;
    }
    if (canPreserveDeepLink(route)) {
      await loadRoute();
      return;
    }
    router.navigate('/play/rooms');
  }

  function clearSession() {
    session?.clear?.();
    snapshot = Object.freeze({ authenticated: false });
  }

  async function enterGame(handoff) {
    if (pending.has('enterGame')) return pending.get('enterGame');
    if (!handoff) {
      setView({ variant: 'error', error: { code: 'HANDOFF_REQUIRED', message: 'The platform has not supplied a match handoff.' } });
      return null;
    }
    if (!capabilities?.supported) {
      setView({ variant: 'terminal', error: { code: 'UNSUPPORTED_CLIENT', message: 'This device does not meet the contracted match requirements.' } });
      return null;
    }
    if (typeof loadGameRuntime !== 'function') {
      setView({ variant: 'error', error: { code: 'RUNTIME_UNAVAILABLE', message: 'The game runtime loader is not connected.' } });
      return null;
    }
    const task = (async () => {
      try {
        const runtime = await loadGameRuntime({ handoff, shell: controller });
        activeHandoff = handoff;
        runtimeLoaded = true;
        surface.hidden = true;
        surface.inert = true;
        surface.setAttribute('aria-hidden', 'true');
        root.dataset.runtime = 'active';
        return runtime;
      } catch (error) {
        const stages = {
          MATCH_ALLOCATION_FAILED: 'allocating',
          SESSION_TOKEN_INVALID: 'ticket',
          MATCH_SERVER_UNREACHABLE: 'connect',
          FEATURE_DISABLED: 'connect',
          PROTOCOL_VERSION_MISMATCH: 'welcome',
        };
        const stage = error?.details?.stage || stages[error?.code];
        if (['allocating', 'ticket', 'connect', 'welcome'].includes(stage)) {
          invokeTelemetry(telemetry, 'handoffFailure', { stage, code: error?.code });
        }
        setView(errorVariant(error));
        return null;
      } finally {
        pending.delete('enterGame');
      }
    })();
    pending.set('enterGame', task);
    return task;
  }

  const actions = Object.freeze({
    navigate: (path, options) => router.navigate(path, options),
    refresh: () => loadRoute({ preferFixture: false }),
    request,
    submit,
    setView,
    announce,
    openModal: modal.open,
    acceptSession,
    acceptProfile,
    resumeAfterAuth,
    clearSession,
    nextSetupPath,
    updateDraft: (values) => Object.assign(draft, values),
    getDraft: () => ({ ...draft, password: undefined }),
    clearDraft: () => { for (const key of Object.keys(draft)) delete draft[key]; },
    createSignupPayload(displayName) {
      const clientSessionId = telemetry?.getClientSessionId?.()
        || session?.getClientSessionId?.() || snapshot?.clientSessionId || client?.clientSessionId;
      if (!draft.email || !draft.password || !draft.eligibilityReceipt || !draft.consentReceipt || !clientSessionId) return null;
      return {
        email: draft.email,
        password: draft.password,
        displayName,
        eligibilityReceipt: draft.eligibilityReceipt,
        clientSessionId,
        consentReceipt: draft.consentReceipt,
      };
    },
    getClientSessionId: () => telemetry?.getClientSessionId?.()
      || session?.getClientSessionId?.() || snapshot?.clientSessionId || client?.clientSessionId,
    registerCleanup(cleanup) {
      if (typeof cleanup === 'function') renderCleanups.push(cleanup);
    },
    enterGame,
    loadMore,
    recordLobbyAbandoned(lastState = 'in-lobby') {
      const dwellSec = roomEnteredAt === null
        ? 0
        : Math.min(86400, Math.max(0, (Date.now() - roomEnteredAt) / 1000));
      invokeTelemetry(telemetry, 'lobbyAbandoned', { lastState, dwellSec });
      roomEnteredAt = null;
    },
    recordSettingsFriction(category, duringFirstSession = false) {
      const mark = `${category}:${duringFirstSession}`;
      if (settingsFrictionMarks.has(mark)) return;
      settingsFrictionMarks.add(mark);
      invokeTelemetry(telemetry, 'settingsFriction', { category, duringFirstSession });
    },
    isFeatureEnabled,
    useResponse: (result) => setView({ variant: result?.variant || 'ready', data: result?.data ?? result }),
  });

  const router = createHistoryRouter({
    root,
    win: windowRef,
    initialPath,
    onRoute(nextRoute, reason) {
      modal.close({ restoreFocus: false });
      const priorRoute = route;
      route = nextRoute;
      if (route.id.startsWith('room.') && roomEnteredAt === null) roomEnteredAt = Date.now();
      const retainedCredentialTransition = priorRoute.id === 'auth.create'
        && route.id === 'onboarding.displayName';
      if (draft.password && !retainedCredentialTransition
        && ['auth.create', 'onboarding.displayName'].includes(priorRoute.id)) {
        delete draft.password;
      }
      view = applyFixture(route) || defaultView(route);
      view = disabledRouteView(route) || view;
      invokeTelemetry(telemetry, 'routeViewed', route.id, reason);
      if (route.id === 'settings.category' && route.params.category) {
        actions.recordSettingsFriction(route.params.category, signupCompletedAt !== null);
      } else if (route.id === 'onboarding.essentialSettings') {
        actions.recordSettingsFriction('input', true);
      }
      render({ focus: true });
      if (!applyFixture(route) && loaderForRoute(route)) loadRoute();
    },
  });

  const sessionUnsubscribe = session?.subscribe?.((nextSnapshot) => {
    snapshot = nextSnapshot || sessionSnapshot(session);
    if (snapshot?.status === 'revoked'
      || (snapshot?.authenticated === false && route.id !== 'welcome' && !route.id.startsWith('auth.'))) {
      if (pending.has('signOut') || pending.has('signOutAll')) {
        render();
        return;
      }
      const reason = snapshot?.reason || snapshot?.status;
      const notice = reason === 'AUTH_SESSION_REPLACED'
        ? 'This account was signed in elsewhere. Sign in again to continue on this device.'
        : ['signed-out-all', 'revoked-in-another-tab'].includes(reason)
          ? 'You were signed out in another tab. Sign in again to continue.'
          : reason === 'AUTH_SESSION_REVOKED'
            ? 'This session was revoked. Sign in again to continue.'
            : 'This session ended. Sign in again to continue.';
      injectedViews.set('/auth/sign-in', { variant: 'ready', data: { notice } });
      router.replace('/auth/sign-in');
      return;
    }
    render();
  });
  const connectionUnsubscribe = client?.connection?.subscribe?.((nextConnection) => {
    connection = nextConnection;
    render();
  });
  const featureFlagsUnsubscribe = featureFlags?.subscribe?.(() => {
    if (destroyed) return;
    root.classList.toggle('os-flag-no-diagnostics', !isFeatureEnabled('shell.diagnostics.panel'));
    const unavailable = disabledRouteView(route);
    if (unavailable) {
      view = unavailable;
      render();
      return;
    }
    if (view.variant === 'unavailable' && loaderForRoute(route)) {
      void loadRoute({ preferFixture: false });
      return;
    }
    render();
  });
  const onStorage = (event) => session?.handleStorageEvent?.(event);
  const onVisibility = () => {
    if (root.ownerDocument.visibilityState === 'visible' && snapshot?.authenticated) {
      session?.refreshIfNeeded?.();
    }
  };
  windowRef?.addEventListener?.('storage', onStorage);
  root.ownerDocument.addEventListener('visibilitychange', onVisibility);

  const controller = Object.freeze({
    navigate: (path, options) => router.navigate(path, options),
    replace: router.replace,
    refresh: () => loadRoute({ preferFixture: false }),
    async resumeAuthenticated(result) {
      initialLoadDeferred = false;
      acceptSession(result);
      return resumeAfterAuth(result);
    },
    finishSessionRestore({ authenticated = false } = {}) {
      initialLoadDeferred = false;
      if (!authenticated && isAuthenticatedRoute(route)) {
        router.replace('/auth/sign-in');
        return;
      }
      if (loaderForRoute(route)) loadRoute();
      else render();
    },
    render: () => render(),
    getRoute: () => route,
    getState: () => Object.freeze({
      route,
      view,
      session: snapshot,
      connection,
      capabilities,
      runtimeLoaded,
      featureFlags: featureFlags?.snapshot?.() || featureFlags?.getSnapshot?.() || null,
    }),
    isFeatureEnabled,
    setView,
    injectFixture(target, fixtureOrVariant = 'ready', data) {
      let fixture;
      if (typeof fixtureOrVariant === 'string') {
        fixture = data === undefined
          ? getShellFixture(route.id, fixtureOrVariant) || { variant: fixtureOrVariant }
          : { variant: fixtureOrVariant, data };
      } else {
        fixture = fixtureOrVariant;
      }
      const key = target || route.pathname;
      injectedViews.set(key, normalizeView(fixture));
      if (key === route.pathname || key === route.id) {
        view = normalizeView(fixture);
        render();
      }
      return controller;
    },
    clearFixture(target = route.pathname) {
      injectedViews.delete(target);
      view = applyFixture(route) || defaultView(route);
      render();
    },
    openModal: modal.open,
    closeModal: modal.close,
    restoreShell(path, outcome = null) {
      runtimeLoaded = false;
      surface.hidden = false;
      surface.inert = false;
      surface.removeAttribute('aria-hidden');
      root.dataset.runtime = 'shell';
      if (outcome?.outcome) {
        invokeTelemetry(telemetry, 'returnOutcome', {
          outcome: outcome.outcome,
          returnedToLobby: Boolean(path?.startsWith('/room/')),
        });
      }
      if (outcome?.firstMatch === true && signupCompletedAt !== null && outcome.mode) {
        invokeTelemetry(telemetry, 'firstMatch', {
          completed: outcome.completed === true,
          mode: outcome.mode,
          timeToFirstMatchSec: Math.min(86400, Math.max(0, (Date.now() - signupCompletedAt) / 1000)),
        });
        signupCompletedAt = null;
      }
      activeHandoff = null;
      if (path) router.navigate(path);
      else render({ focus: true });
    },
    isGameRuntimeLoaded: () => runtimeLoaded,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearRenderCleanups();
      modal.destroy();
      router.destroy();
      sessionUnsubscribe?.();
      connectionUnsubscribe?.();
      featureFlagsUnsubscribe?.();
      windowRef?.removeEventListener?.('storage', onStorage);
      root.ownerDocument.removeEventListener('visibilitychange', onVisibility);
      root.replaceChildren();
      root.classList.remove('os-shell', 'os-reduced-motion', 'os-flag-no-diagnostics');
      delete root.dataset.route;
      delete root.dataset.variant;
      delete root.dataset.runtime;
    },
  });

  router.start();
  return controller;
}

export { checkShellCapabilities } from './capabilities.js';
export { getShellFixture, resolveShellFixture, SHELL_SCREEN_FIXTURES, SHELL_VARIANT_MATRIX } from './fixtures.js';
export { matchShellRoute, normalizeShellPath, SHELL_ROUTES } from './router.js';

export const SHELL_HARNESS_METADATA = Object.freeze({
  routes: SHELL_ROUTES,
  variants: Object.freeze(['loading', 'empty', 'error', 'offline', 'terminal', 'ready']),
  variantMatrix: SHELL_VARIANT_MATRIX,
  fixtures: SHELL_SCREEN_FIXTURES,
});
