import './shell.css';

import { createShellAudio, SHELL_TRACKS } from './audio.js';
import { checkShellCapabilities } from './capabilities.js';
import { actionButton, element, shellLink } from './dom.js';
import { MENU_BACKDROP } from './keyart.js';
import { getShellFixture, resolveShellFixture, SHELL_SCREEN_FIXTURES, SHELL_VARIANT_MATRIX } from './fixtures.js';
import { createModalController } from './modal.js';
import { createHistoryRouter, matchShellRoute, SHELL_ROUTES } from './router.js';
import { renderShellScreen, homePath } from './screens.js';

export const SHELL_FEATURE_DEFAULTS = Object.freeze({
  'shell.diagnostics.panel': true,
  'shell.career.enabled': true,
  'shell.serverbrowser.enabled': true,
  'mode.tdm.enabled': true,
  // feature-flags.md §3.2 compiled defaults, 1.2.0: Bomb and The Square shipped at P3, so the
  // unreachable-flags fallback must offer them — a stale `false` here silently removed the
  // only map from the create form whenever the flag fetch failed.
  'mode.bomb.enabled': true,
  'map.the_square.enabled': true,
  // feature-flags.md 1.3.0: MERIDIAN un-retired into the room offering (map-data.md §9).
  'map.meridian.enabled': true,
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
  'room.loadout': 'getLobbySnapshot',
  'room.chat': 'getChatHistory',
  'career.overview': 'getCareerOverview',
  'career.modes': 'getCareerModes',
  'career.weapons': 'getCareerWeapons',
  'career.matches': 'listMatches',
  'career.matchDetail': 'getMatch',
  inventory: 'listInventory',
  'inventory.item': 'getInventoryItem',
  loadouts: 'listLoadouts',
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
    || route.id.startsWith('career.') || route.id.startsWith('inventory')
    || route.id === 'loadouts' || route.id === 'settings.category'
    || route.id === 'sessions' || route.id.startsWith('match.') || route.id === 'results';
}

function canPreserveDeepLink(route) {
  return route.id.startsWith('play.') || route.id.startsWith('career.')
    || route.id.startsWith('room.') || route.id.startsWith('inventory')
    || route.id === 'loadouts' || route.id === 'settings.category'
    || route.id === 'sessions' || route.id === 'results';
}

function canPreserveWhileInRoom(route) {
  return route.id.startsWith('career.') || route.id.startsWith('inventory')
    || route.id === 'loadouts' || route.id === 'settings.category'
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

/**
 * The next onboarding step, or where to go when there are none left.
 *
 * `step === null` means setup is COMPLETE, and this returned a hardcoded '/play/rooms' for that
 * case. Callers are written `nextSetupPath(result) || homePath(...)`, so the fallback they were
 * given could never run: a truthy '/play/rooms' short-circuits the `||`. With
 * `shell.serverbrowser.enabled` off, every finished player was still routed to the browser's
 * "Unavailable" card by the one branch that claimed to handle completion.
 *
 * It takes `isFeatureEnabled` so the completion destination is decided in ONE place rather than
 * at four call sites that each have to remember.
 */
function nextSetupPath(result, isFeatureEnabled) {
  const data = unwrapResult(result);
  const step = data?.profile?.flags?.setupNextStep ?? data?.flags?.setupNextStep;
  return step === null ? homePath(isFeatureEnabled) : SETUP_PATHS[step] || null;
}

function errorVariant(error) {
  const offline = error?.offline === true || ['OFFLINE', 'CLIENT_NETWORK'].includes(error?.code)
    || error?.name === 'NetworkError';
  const terminalCodes = new Set([
    'AUTH_ELIGIBILITY_DENIED', 'AUTH_ACCOUNT_RESTRICTED', 'AUTH_SESSION_REVOKED',
    'CLIENT_UPDATE_REQUIRED', 'UPDATE_REQUIRED', 'MAINTENANCE', 'UNSUPPORTED_CLIENT', 'RECONNECT_GRACE_EXPIRED',
    'ROOM_REMOVED', 'ROOM_CLOSED', 'MATCH_INVALIDATED', 'MATCH_ALLOCATION_FAILED',
    'MATCH_SERVER_UNREACHABLE', 'PROTOCOL_VERSION_MISMATCH', 'MATCH_ABORTED',
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

/**
 * Did the LOCAL player win? Returns 'victory', 'defeat', or null when the answer is not
 * knowable — a draw, a still-`pending` settlement, a result whose roster does not contain
 * this account. Null means no results theme plays, which is deliberate: guessing here would
 * play a defeat sting at someone who drew, and being silent is the honest degradation.
 *
 * Two vocabularies exist and both are authoritative in their own mode. Raids settle
 * per-participant (settlement.md §3: extracted / died / aborted / server-failure); TDM and
 * Bomb settle per-team against `winnerTeam`.
 */
export function resultOutcomeFor(result, accountId = null) {
  if (!result || result.status === 'pending') return null;
  const participants = result.settlement?.participants;
  if (Array.isArray(participants) && participants.length) {
    const mine = participants.find((entry) => entry.isLocal === true)
      || (accountId ? participants.find((entry) => entry.accountId === accountId) : null);
    if (!mine || !mine.outcome) return null;
    return mine.outcome === 'extracted' ? 'victory' : 'defeat';
  }
  const winner = result.winnerTeam;
  if (!winner || winner === 'draw') return null;
  const players = Array.isArray(result.players) ? result.players : [];
  const mine = accountId ? players.find((entry) => entry.accountId === accountId) : null;
  if (!mine?.team) return null;
  return mine.team === winner ? 'victory' : 'defeat';
}

/**
 * The music bed a screen asks for. One function so a new route cannot silently inherit the
 * menu theme onto a screen where it is wrong, and so "stop when entering a match" is a single
 * `null` rather than a stop call scattered across every entry path.
 */
function musicForScreen({ route, view, runtimeLoaded, accountId }) {
  if (runtimeLoaded) return null;
  if (route.id === 'results') {
    const outcome = resultOutcomeFor(view.data?.result || view.data, accountId);
    return outcome === 'victory' ? 'victory' : outcome === 'defeat' ? 'defeat' : 'menu';
  }
  // A lobby with a running countdown, and the loading/reconnect screens, are the tense end of
  // the shell — that is what menu_tension is for.
  if (route.id.startsWith('match.')) return 'tension';
  if (route.id.startsWith('room.')) return view.data?.countdown ? 'tension' : 'menu';
  return 'menu';
}

/** Mutations that change what the player takes into a match — these get the equip cue. */
const EQUIP_OPERATIONS = new Set([
  'createLoadout', 'updateLoadout', 'setLoadout', 'equipItem', 'setRoomLoadout', 'deleteLoadout',
]);

/**
 * What makes one control a *different* control from the hover cue's point of view.
 *
 * `render()` replaces every node it draws, so two renders of the same screen produce two
 * distinct objects for the same button. Object identity therefore reports "the player is
 * pointing at something new" once per frame. Where it goes, what it does and what it reads
 * are stable across that rebuild, which is what a player would call the same control.
 */
function hoverIdentity(node) {
  if (!node) return null;
  const href = node.getAttribute?.('href') || '';
  const operation = node.dataset?.operation || '';
  const label = (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  return `${node.tagName} ${href} ${operation} ${label}`;
}

/** Whether a control reads as "go back" so it can get the back cue rather than the click one. */
function isBackControl(node) {
  const label = (node?.textContent || '').trim();
  return /^(back|return|exit|cancel|leave)\b/i.test(label);
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
      ['Inventory', '/inventory', () => route.id.startsWith('inventory')],
      ['Loadout', '/loadouts', () => route.id === 'loadouts' || route.id === 'room.loadout'
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
  const platformUnhealthy = platform !== 'unknown' && !['online', 'healthy'].includes(platform);
  const unhealthy = platformUnhealthy || !['synchronized', 'disconnected', 'closed'].includes(lobby)
    || !['idle', 'live', 'ended'].includes(match);
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
  audio = null,
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
  /** Last audio state actually acted on, so cues fire on transitions and not on every render. */
  let lastVariantFailed = false;
  let lastHandoffReady = false;
  let lastCountdownSecond = null;
  let oneShotMusicLatch = null;
  let routeLoadRevision = 0;
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
  /**
   * The menu backdrop. Decorative, `aria-hidden`, and behind everything: `shell.css` puts a
   * scrim over it so the text contrast the shell already had does not depend on the image.
   * An `<img>` rather than a CSS background so a failed load simply removes itself and leaves
   * the original gradient, which is what "graceful degradation" has to mean for art.
   */
  const backdrop = element('div', { className: 'os-shell__backdrop', 'aria-hidden': 'true' });
  const backdropImage = element('img', {
    className: 'os-keyart__image', alt: '', decoding: 'async', fetchPriority: 'low',
  });
  backdropImage.addEventListener('error', () => backdropImage.remove());
  backdrop.append(backdropImage);
  /**
   * The `src` is attached on idle, not at mount. A megabyte of decoration on the critical path
   * would compete with the module graph and with the screen's OWN art (the hero, the map card),
   * which are the images the player is actually looking at. Deferring it costs nothing — the
   * shell is fully usable, and correct, with the backdrop still absent — and `loading="lazy"`
   * would not have helped, because the element is in the viewport from the first frame.
   */
  const attachBackdrop = () => { if (!destroyed) backdropImage.src = MENU_BACKDROP; };
  if (typeof windowRef?.requestIdleCallback === 'function') {
    windowRef.requestIdleCallback(attachBackdrop, { timeout: 3000 });
  } else {
    windowRef?.setTimeout?.(attachBackdrop, 400) ?? attachBackdrop();
  }
  main.append(heading, screenHost);
  surface.append(skipLink, header, bannerHost, main, footer, live);
  root.append(backdrop, surface, modalLayer);
  const modal = createModalController({ layer: modalLayer, inertTarget: surface, documentRef: root.ownerDocument });

  /**
   * Shell audio. The controller is created eagerly but does NOTHING — no AudioContext, no
   * fetch — until a trusted gesture arms it (see audio.js). That is what keeps a programmatic
   * `navigate()`, which is how the acceptance harness drives every screen, silent.
   */
  const shellAudio = audio || createShellAudio({
    settings,
    window: windowRef,
    // Arming happens on a gesture the shell never sees (audio.js listens on the document), and
    // the music a screen wants was decided before there was permission to play it. Without
    // this re-evaluation the menu theme would wait for the next unrelated re-render.
    onArmed: () => reactAudioToScreen(),
  });
  const ownsAudio = !audio;
  const cue = (name) => { try { shellAudio?.play?.(name); } catch { /* audio is never fatal */ } };
  const setMusic = (track) => {
    try {
      return (track === null ? shellAudio?.stopMusic?.() : shellAudio?.music?.(track)) === true;
    } catch { /* audio is never fatal */ }
    return false;
  };

  /**
   * Interaction cues, delegated from the root so no screen has to remember to attach them and
   * a re-render cannot leak listeners. `isTrusted` is the whole gate: a synthetic
   * `element.click()` from test or product code is not a player pressing a button, and must
   * not make a noise.
   */
  let lastHovered = null;
  let lastHoverKey = null;
  let pointerPoint = null;
  const pointOf = (event) => (Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)
    ? { x: event.clientX, y: event.clientY } : null);
  const onPointerMove = (event) => {
    if (event.isTrusted !== true) return;
    pointerPoint = pointOf(event) || pointerPoint;
  };
  const onPointerOver = (event) => {
    if (event.isTrusted !== true) return;
    // `pointerover` is trusted but it is NOT proof the player moved: the browser dispatches a
    // real one whenever the node under a stationary cursor is replaced, which `render()` does
    // on every roster push and every countdown tick. Left unguarded that is a hover tick once
    // a second for anyone whose cursor happens to rest on a control, and the cue's throttle
    // cannot help — the re-render cadence is ~1Hz, far wider than any sane throttle.
    //
    // Two independent facts distinguish a crossing from a swap, and a phantom must fail both:
    //  - the pointer is somewhere new. A swap re-dispatches at the cursor's current position,
    //    which is exactly where the last move/over left it; crossing a control boundary
    //    cannot happen without the position changing.
    //  - the control is a different control. Identity is the node's *meaning* (where it goes,
    //    what it does, what it reads), not its object identity: `render()` builds a fresh node
    //    for the same button every time, so comparing references sees a new control on every
    //    frame.
    const point = pointOf(event);
    const moved = pointerPoint === null || point === null
      || point.x !== pointerPoint.x || point.y !== pointerPoint.y;
    if (point) pointerPoint = point;
    const control = event.target?.closest?.('a[href], button:not([disabled]), summary');
    if (!control || !root.contains(control)) return;
    const key = hoverIdentity(control);
    const sameControl = control === lastHovered || key === lastHoverKey;
    lastHovered = control;
    lastHoverKey = key;
    if (sameControl || !moved) return;
    cue('hover');
  };
  const onPointerOut = (event) => {
    if (event.relatedTarget && lastHovered?.contains?.(event.relatedTarget)) return;
    lastHovered = null;
    // A node swap under a stationary cursor dispatches out-then-over, so an unconditional
    // clear here would throw away the identity the `over` is about to be compared against.
    // Leaving a control is a movement; if the pointer is still exactly where it was, nothing
    // was left and the identity still describes what the player is pointing at.
    const point = pointOf(event);
    if (!pointerPoint || !point || point.x !== pointerPoint.x || point.y !== pointerPoint.y) {
      lastHoverKey = null;
    }
  };
  const onInteractionClick = (event) => {
    if (event.isTrusted !== true) return;
    const control = event.target?.closest?.('a[href], button, summary, [role="button"]');
    if (!control || !root.contains(control)) return;
    // A `disabled` button never dispatches click at all, so there is nothing to sound here;
    // refusals are voiced where they are actually decided, in `submit`'s error path.
    cue(isBackControl(control) ? 'back' : 'click');
    shellAudio?.preload?.(['hover', 'click', 'back']);
  };
  /**
   * A volume control changing is the one input whose effect the player expects to hear WHILE
   * they are still holding it. It cannot ride `onInteractionClick`: a range input is none of
   * `a[href]`/`button`/`summary`/`[role=button]`, a drag dispatches no click at all, and the
   * arrow keys dispatch only `input`. So the audio settings poke the player directly here —
   * the timer inside the module would get there within 250ms anyway, this just removes the
   * lag from under the thumb. Restricted to the three volume settings so that typing in a
   * search field does not re-read the settings store on every keystroke.
   */
  const onSettingInput = (event) => {
    const name = event.target?.id || event.target?.name || '';
    if (!/Volume$/.test(String(name))) return;
    shellAudio?.syncVolumes?.();
  };
  root.addEventListener('pointerover', onPointerOver, { capture: true });
  root.addEventListener('pointermove', onPointerMove, { capture: true, passive: true });
  root.addEventListener('pointerout', onPointerOut, { capture: true });
  root.addEventListener('click', onInteractionClick, { capture: true });
  root.addEventListener('input', onSettingInput, { capture: true, passive: true });
  root.addEventListener('change', onSettingInput, { capture: true, passive: true });

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

  /**
   * State-driven audio, evaluated once per render.
   *
   * It is written as a diff against what was last heard rather than as a set of calls at the
   * places state changes, because the shell re-renders the same screen constantly (roster
   * pushes, countdown ticks, focus restoration). Firing on transitions is the only way a
   * "match found" stinger plays once instead of on every socket frame.
   */
  function reactAudioToScreen() {
    // Compared against what the player is ACTUALLY hearing rather than against a local
    // remembered value: a request made before the audio was armed is refused, and a remembered
    // value would record it as satisfied and never retry it.
    const track = musicForScreen({ route, view, runtimeLoaded, accountId: snapshot?.accountId || null });
    // A looping bed is driven by what is audibly playing, which is what makes an unarmed or
    // muted request retry itself on the next render instead of being remembered as satisfied.
    //
    // A one-shot theme cannot be driven that way. The outcome themes end on their own, which
    // releases the music voice, but the results screen still *wants* victory/defeat for as
    // long as the player sits on it — so the very next re-render (a connection banner, the
    // pending-result refresh) would read "wanted: victory, playing: nothing" and start the
    // whole twelve seconds again. Intent for a one-shot is therefore latched: it is delivered
    // once per screen-and-outcome, and only the screen or the outcome changing asks for it
    // again. The latch is set only when the request was actually accepted, so a theme refused
    // for want of a gesture or a volume is still retried when that changes.
    const oneShot = track !== null && SHELL_TRACKS[track]?.loop !== true;
    if (!oneShot) {
      oneShotMusicLatch = null;
      if (track !== shellAudio.getMusicTrack()) setMusic(track);
    } else {
      const latch = `${route.id}:${track}`;
      if (latch !== oneShotMusicLatch && setMusic(track)) oneShotMusicLatch = latch;
    }

    // A refusal is a distinct sound from a navigation, and it must not repeat while the
    // player sits on the error.
    const failing = ['error', 'terminal'].includes(view.variant);
    if (failing && !lastVariantFailed) cue('error');
    lastVariantFailed = failing;

    // A handoff arriving is the moment the player has been waiting for.
    const handoffReady = route.id === 'match.loading' && Boolean(view.data?.handoff);
    if (handoffReady && !lastHandoffReady) { cue('matchFound'); cue('voMatchFound'); }
    lastHandoffReady = handoffReady;

    // Lobby countdown. Whole seconds only, and only the last five, so the tick is a cue and
    // not a metronome; zero hands over to the go cue.
    const remainingMs = route.id.startsWith('room.') && view.data?.countdown
      ? (Number.isFinite(view.data.countdown.remainingMs) ? view.data.countdown.remainingMs
        : Number.isFinite(view.data.countdownRemainingMs) ? view.data.countdownRemainingMs : null)
      : null;
    const second = remainingMs === null ? null : Math.max(0, Math.ceil(remainingMs / 1000));
    if (second !== lastCountdownSecond) {
      if (second !== null && lastCountdownSecond !== null) {
        if (second === 0) cue('countdownGo');
        else if (second <= 5 && second < lastCountdownSecond) cue('countdownTick');
      }
      lastCountdownSecond = second;
    }
  }

  function render({ focus = false } = {}) {
    if (destroyed) return;
    const draftValues = new Map();
    for (const field of screenHost.querySelectorAll('input[name], textarea[name], select[name]')) {
      draftValues.set(`${field.tagName}:${field.name}`, {
        value: field.value, checked: field.checked,
      });
    }
    const activeField = root.ownerDocument.activeElement;
    const focusedFieldKey = screenHost.contains(activeField) && activeField?.name
      ? `${activeField.tagName}:${activeField.name}` : null;
    const focusedAction = screenHost.contains(activeField) && activeField?.matches?.('button, a[href]')
      ? {
        operation: activeField.dataset?.operation || null,
        href: activeField.getAttribute?.('href') || null,
        text: activeField.textContent,
      } : null;
    const selection = focusedFieldKey && typeof activeField.selectionStart === 'number'
      ? [activeField.selectionStart, activeField.selectionEnd] : null;
    clearRenderCleanups();
    root.dataset.route = route.id;
    root.dataset.variant = view.variant;
    root.dataset.runtime = runtimeLoaded ? 'active' : 'shell';
    reactAudioToScreen();
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
    for (const field of screenHost.querySelectorAll('input[name], textarea[name], select[name]')) {
      const saved = draftValues.get(`${field.tagName}:${field.name}`);
      if (!saved) continue;
      if ('checked' in field && ['checkbox', 'radio'].includes(field.type)) field.checked = saved.checked;
      else field.value = saved.value;
    }
    if ((focusedFieldKey || focusedAction) && !focus && lastFocusedPath === route.pathname) {
      const restored = focusedFieldKey
        ? [...screenHost.querySelectorAll('input[name], textarea[name], select[name]')]
          .find((field) => `${field.tagName}:${field.name}` === focusedFieldKey)
        : [...screenHost.querySelectorAll('button, a[href]')].find((candidate) => (
          focusedAction.operation
            ? candidate.dataset?.operation === focusedAction.operation
            : focusedAction.href
              ? candidate.getAttribute('href') === focusedAction.href
              : candidate.textContent === focusedAction.text
        ));
      if (restored) queueMicrotask(() => {
        if (destroyed || modal.isOpen()) return;
        restored.focus({ preventScroll: true });
        if (selection && typeof restored.setSelectionRange === 'function') {
          restored.setSelectionRange(...selection);
        }
      });
    }
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
    const loadRevision = ++routeLoadRevision;
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
      if (destroyed || route.pathname !== requestedPath || routeLoadRevision !== loadRevision) return null;
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
      if (route.pathname !== requestedPath || destroyed || routeLoadRevision !== loadRevision) return null;
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
      if (route.pathname !== requestedPath || destroyed || routeLoadRevision !== loadRevision) return null;
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

  // NOT async: an async wrapper would return a NEW promise that adopts `task`'s rejection,
  // and the `task.catch(() => {})` below only marks the inner promise handled — so every
  // onError path fired an unhandled rejection at callers that fire-and-forget the submission.
  // Returning `task` itself returns the promise the catch was actually attached to.
  function submit(operation, payload, { onSuccess, onError, secretInputs = [] } = {}) {
    if (pending.has(operation)) return pending.get(operation);
    const buttons = [...screenHost.querySelectorAll('button[type="submit"], button[data-operation]')]
      .map((button) => ({ button, wasDisabled: button.disabled }));
    buttons.forEach(({ button }) => { button.disabled = true; });
    const pendingStatus = element('p', { className: 'os-pending-status', role: 'status' }, 'Request in progress…');
    screenHost.prepend(pendingStatus);
    root.setAttribute('aria-busy', 'true');
    const task = (async () => {
      try {
        const result = await request(operation, payload);
        if (operation === 'signUp') signupCompletedAt = Date.now();
        if (EQUIP_OPERATIONS.has(operation)) cue('equip');
        await onSuccess?.(result);
        return result;
      } catch (error) {
        // A refused mutation always makes the refusal sound, even when the screen handles the
        // error inline (`onError`) and never flips the view variant — which is the common case
        // for the lobby's ready/team controls, where a silent failure is the worst outcome.
        cue('error');
        if (typeof onError === 'function') await onError(error);
        else setView(errorVariant(error));
        throw error;
      } finally {
        for (const input of secretInputs) {
          if (!input) continue;
          input.value = '';
          if (input.name) {
            for (const current of screenHost.querySelectorAll('input[name], textarea[name]')) {
              if (current.name === input.name) current.value = '';
            }
          }
        }
        pending.delete(operation);
        pendingStatus.remove();
        root.removeAttribute('aria-busy');
        buttons.forEach(({ button, wasDisabled }) => { if (button.isConnected) button.disabled = wasDisabled; });
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
    const requestedLoadRevision = routeLoadRevision;
    const task = (async () => {
      try {
        const result = await request(loader, { ...routePayload(route), cursor: requestedCursor });
        if (destroyed || route.pathname !== requestedPath || routeLoadRevision !== requestedLoadRevision
          || view.data?.nextCursor !== requestedCursor) return null;
        const page = result?.data ?? result ?? {};
        const currentItems = view.data?.[collectionKey] || view.data?.items || [];
        const nextItems = page?.[collectionKey] || page?.items || [];
        const identity = (item) => item?.id || item?.roomId || item?.matchId || item?.sessionId || null;
        const seen = new Set(currentItems.map(identity).filter(Boolean));
        const merged = [...currentItems, ...nextItems.filter((item) => !identity(item) || !seen.has(identity(item)))];
        setView({ variant: 'ready', data: { ...view.data, ...page, paginationError: null, [collectionKey]: merged } });
        return page;
      } catch (error) {
        const message = error?.message || 'The next page could not be loaded.';
        announce(message);
        if (!destroyed && route.pathname === requestedPath && routeLoadRevision === requestedLoadRevision
          && view.data?.nextCursor === requestedCursor) {
          setView({ variant: 'ready', data: { ...view.data, paginationError: { code: error?.code, message } } });
        }
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
    // Where a signed-in player lands when nothing more specific applies. This was hardcoded to
    // /play/rooms, so SIGNING IN with `shell.serverbrowser.enabled` off landed on the browser's
    // own "Unavailable" card — the same dead end as the end of onboarding, reached by the other
    // of the two doors into the shell. Fixing one and not the other is what made it look fixed.
    const home = homePath(isFeatureEnabled);
    const setupPath = nextSetupPath(result, isFeatureEnabled);
    if (setupPath && setupPath !== home) {
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
    router.navigate(home);
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
    // Deploy stinger first, then the shell's music gets out of the way: the match runtime owns
    // the mix from here, and menu_theme continuing under a firefight is the bug this prevents.
    cue('deploy');
    setMusic(null);
    const task = (async () => {
      try {
        const runtime = await loadGameRuntime({ handoff, shell: controller,
          firstMatch: signupCompletedAt !== null });
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
    nextSetupPath: (result) => nextSetupPath(result, isFeatureEnabled),
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
      // Browser back/forward has no button to have made a click sound, so it makes its own.
      if (reason === 'popstate') cue('back');
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
    // `route.signedOut` (router.js), not a prefix test on the route id.
    //
    // This read `id !== 'welcome' && !id.startsWith('auth.')`, which redirected every
    // `onboarding.*` route: a signed-out visitor deep-linking to /onboarding/eligibility landed
    // on sign-in reading "This session ended", having never had one. The whole signup funnel was
    // unreachable except by clicking through from the welcome page fast enough to beat the boot
    // refresh resolving. The footer's Terms, Status, Support and Privacy links were the same.
    if (snapshot?.status === 'revoked'
      || (snapshot?.authenticated === false && !route.signedOut)) {
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
    enterGame,
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
    /**
     * The shell's audio, exposed so progression events that do not originate in a screen
     * (`ui_levelup`, `ui_unlock` from a career/inventory push) and the in-match HUD can use the
     * same player, the same volumes and the same gesture gate rather than opening a second
     * AudioContext.
     */
    audio: shellAudio,
    playCue: (name) => cue(name),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearRenderCleanups();
      root.removeEventListener('pointerover', onPointerOver, { capture: true });
      root.removeEventListener('pointermove', onPointerMove, { capture: true });
      root.removeEventListener('pointerout', onPointerOut, { capture: true });
      root.removeEventListener('click', onInteractionClick, { capture: true });
      root.removeEventListener('input', onSettingInput, { capture: true });
      root.removeEventListener('change', onSettingInput, { capture: true });
      // Only tear down an engine this mount created. An injected one outlives the shell.
      if (ownsAudio) shellAudio.destroy();
      else shellAudio?.stopMusic?.();
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
