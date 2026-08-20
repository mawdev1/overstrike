export const SHELL_ROUTES = Object.freeze([
  { id: 'welcome', pattern: '/welcome', title: 'Welcome' },
  { id: 'auth.signIn', pattern: '/auth/sign-in', title: 'Sign in' },
  { id: 'auth.create', pattern: '/auth/create-account', title: 'Create account' },
  { id: 'auth.recover', pattern: '/auth/recover', title: 'Recover account' },
  { id: 'onboarding.eligibility', pattern: '/onboarding/eligibility', title: 'Eligibility' },
  { id: 'onboarding.consent', pattern: '/onboarding/consent', title: 'Privacy choices' },
  { id: 'onboarding.displayName', pattern: '/onboarding/display-name', title: 'Choose a display name' },
  { id: 'onboarding.verify', pattern: '/onboarding/verify', title: 'Verify your account' },
  { id: 'onboarding.terms', pattern: '/onboarding/terms', title: 'Terms' },
  { id: 'onboarding.essentialSettings', pattern: '/onboarding/essential-settings', title: 'Essential settings' },
  { id: 'play.rooms', pattern: '/play/rooms', title: 'Server browser' },
  { id: 'play.roomDetail', pattern: '/play/rooms/:roomId', title: 'Room details' },
  { id: 'room.home', pattern: '/room/:roomId', title: 'Lobby' },
  { id: 'room.roster', pattern: '/room/:roomId/roster', title: 'Lobby roster' },
  { id: 'room.loadout', pattern: '/room/:roomId/loadout', title: 'Room loadout' },
  { id: 'room.chat', pattern: '/room/:roomId/chat', title: 'Room chat' },
  { id: 'career.overview', pattern: '/career/overview', title: 'Career overview' },
  { id: 'career.modes', pattern: '/career/modes', title: 'Mode statistics' },
  { id: 'career.weapons', pattern: '/career/weapons', title: 'Weapon statistics' },
  { id: 'career.matches', pattern: '/career/matches', title: 'Match history' },
  { id: 'career.matchDetail', pattern: '/career/matches/:matchId', title: 'Match details' },
  { id: 'settings.category', pattern: '/settings/:category', title: 'Settings' },
  { id: 'sessions', pattern: '/sessions', title: 'Sessions and devices' },
  { id: 'match.loading', pattern: '/match/loading', title: 'Loading match' },
  { id: 'match.reconnect', pattern: '/match/reconnect', title: 'Reconnect to match' },
  { id: 'results', pattern: '/results/:matchId', title: 'Match results' },
  { id: 'system', pattern: '/system/:condition', title: 'System notice' },
]);

function compileRoute(route) {
  const names = [];
  const source = route.pattern
    .split('/')
    .map((part) => {
      if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(part.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { ...route, names, expression: new RegExp(`^${source}/?$`) };
}

const COMPILED_ROUTES = SHELL_ROUTES.map(compileRoute);

function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeShellPath(input, base = 'http://shell.local') {
  let url;
  try {
    url = new URL(String(input || '/welcome'), base);
  } catch {
    return '/system/not-found';
  }
  const pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
  return pathname === '/' ? '/welcome' : pathname;
}

export function matchShellRoute(input) {
  const pathname = normalizeShellPath(input);
  for (const route of COMPILED_ROUTES) {
    const match = route.expression.exec(pathname);
    if (!match) continue;
    const params = Object.create(null);
    route.names.forEach((name, index) => {
      params[name] = decodeParam(match[index + 1]);
    });
    return Object.freeze({
      id: route.id,
      pattern: route.pattern,
      title: route.title,
      pathname,
      params: Object.freeze(params),
    });
  }
  return Object.freeze({
    id: 'system',
    pattern: '/system/:condition',
    title: 'Page not found',
    pathname,
    params: Object.freeze({ condition: 'not-found' }),
  });
}

export function createHistoryRouter({ root, win = globalThis.window, initialPath, onRoute } = {}) {
  let memoryPath = normalizeShellPath(initialPath || win?.location?.pathname || '/welcome');
  let current = matchShellRoute(memoryPath);
  let disposed = false;

  const emit = (reason) => {
    current = matchShellRoute(memoryPath);
    onRoute?.(current, reason);
    return current;
  };

  const navigate = (path, { replace = false } = {}) => {
    if (disposed) return current;
    const nextPath = normalizeShellPath(path, win?.location?.href || 'http://shell.local');
    if (win?.history && win?.location) {
      const method = replace ? 'replaceState' : 'pushState';
      win.history[method]({ shellRoute: true }, '', nextPath);
    }
    memoryPath = nextPath;
    return emit(replace ? 'replace' : 'navigate');
  };

  const onPopState = () => {
    memoryPath = normalizeShellPath(win?.location?.pathname || memoryPath);
    emit('popstate');
  };

  const onClick = (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target?.closest?.('a[data-shell-link]');
    if (!anchor || !root?.contains(anchor) || anchor.target || anchor.hasAttribute('download')) return;
    const href = anchor.getAttribute('href');
    if (!href) return;
    let url;
    try {
      url = new URL(href, win?.location?.href || 'http://shell.local');
    } catch {
      return;
    }
    if (win?.location && url.origin !== win.location.origin) return;
    event.preventDefault();
    navigate(url.pathname);
  };

  win?.addEventListener?.('popstate', onPopState);
  root?.addEventListener?.('click', onClick);

  return Object.freeze({
    navigate,
    replace: (path) => navigate(path, { replace: true }),
    start: () => emit('start'),
    getRoute: () => current,
    destroy() {
      disposed = true;
      win?.removeEventListener?.('popstate', onPopState);
      root?.removeEventListener?.('click', onClick);
    },
  });
}
