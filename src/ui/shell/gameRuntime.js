const MIN_LOGICAL_CORES = 2;
const MIN_DEVICE_MEMORY_GB = 8;

function knownNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function identifyRuntimeClient(nav = globalThis.navigator) {
  const ua = String(nav?.userAgent || '');
  let browser = 'other';
  let browserMajor = 0;
  const match = ua.match(/Edg\/(\d+)/) || ua.match(/Firefox\/(\d+)/)
    || ua.match(/(?:Chrome|Chromium)\/(\d+)/) || ua.match(/Version\/(\d+).*Safari\//);
  if (/Edg\//.test(ua)) browser = 'edge';
  else if (/Firefox\//.test(ua)) browser = 'firefox';
  else if (/(?:Chrome|Chromium)\//.test(ua)) browser = 'chrome';
  else if (/Version\/\d+.*Safari\//.test(ua)) browser = 'safari';
  if (match) browserMajor = Number(match[1]) || 0;

  let os = 'other';
  let osMajor = null;
  const windows = ua.match(/Windows NT (\d+)/);
  const mac = ua.match(/Mac OS X (\d+)[_.]/);
  if (windows) { os = 'windows'; osMajor = Number(windows[1]); }
  else if (mac) { os = 'macos'; osMajor = Number(mac[1]); }
  else if (/Linux/.test(ua) && !/Android/.test(ua)) os = 'linux';
  return Object.freeze({ browser, browserMajor, os, osMajor });
}

export function inspectRuntimeCapabilities({ canvas = null } = {}) {
  const reasons = [];
  const nav = globalThis.navigator;
  const hasPointerLock = Boolean(canvas?.requestPointerLock);
  const hasWebSocketBinary = typeof globalThis.WebSocket === 'function'
    && typeof globalThis.ArrayBuffer === 'function';
  const hasWebGL2Api = typeof globalThis.WebGL2RenderingContext === 'function';
  const touchOnly = Boolean(nav?.maxTouchPoints > 0)
    && globalThis.matchMedia?.('(pointer: coarse)').matches
    && !globalThis.matchMedia?.('(any-pointer: fine)').matches;
  const client = identifyRuntimeClient(nav);

  if (!hasWebGL2Api) reasons.push('webgl2');
  if (!hasPointerLock) reasons.push('pointer-lock');
  if (!hasWebSocketBinary) reasons.push('websocket-binary');
  if (touchOnly) reasons.push('mobile-or-tablet');
  if (client.browser === 'other' || (client.browser === 'safari' && client.browserMajor < 17)) {
    reasons.push('browser-version');
  }
  if (client.os === 'other' || (client.os === 'windows' && client.osMajor < 10)
    || (client.os === 'macos' && client.osMajor < 13)) reasons.push('os-version');
  if (knownNumber(nav?.hardwareConcurrency) && nav.hardwareConcurrency < MIN_LOGICAL_CORES) {
    reasons.push('cpu-cores');
  }
  if (knownNumber(nav?.deviceMemory) && nav.deviceMemory < MIN_DEVICE_MEMORY_GB) {
    reasons.push('memory');
  }

  return Object.freeze({
    supported: reasons.length === 0,
    reasons: Object.freeze(reasons),
    observed: Object.freeze({
      hardwareConcurrency: knownNumber(nav?.hardwareConcurrency) ? nav.hardwareConcurrency : null,
      deviceMemoryGb: knownNumber(nav?.deviceMemory) ? nav.deviceMemory : null,
      pointerLock: hasPointerLock,
      webSocketBinary: hasWebSocketBinary,
      webgl2Api: hasWebGL2Api,
      touchOnly,
      browser: client.browser,
      browserMajor: client.browserMajor,
      os: client.os,
      osMajor: client.osMajor,
      vramGb: null,
    }),
  });
}

export function createGameRuntime({
  canvas,
  gameLayer,
  shellRoot,
  boot = null,
  bootFill = null,
  bootText = null,
  onExit = null,
  configureGame = null,
  onUnsupported = null,
} = {}) {
  if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('A game canvas is required.');
  if (!(gameLayer instanceof HTMLElement)) throw new TypeError('A game layer is required.');
  if (!(shellRoot instanceof HTMLElement)) throw new TypeError('A shell root is required.');

  let game = null;
  let starting = null;

  function setProgress(value, label = 'Loading match') {
    const amount = Math.max(0, Math.min(1, Number(value) || 0));
    if (bootFill) bootFill.style.width = `${Math.round(amount * 100)}%`;
    if (bootText) bootText.textContent = label;
  }

  function revealGame() {
    gameLayer.hidden = false;
    gameLayer.inert = false;
    gameLayer.setAttribute('aria-hidden', 'false');
    shellRoot.hidden = true;
    shellRoot.inert = true;
    shellRoot.setAttribute('aria-hidden', 'true');
    if (boot) boot.hidden = false;
  }

  function revealShell() {
    gameLayer.hidden = true;
    gameLayer.inert = true;
    gameLayer.setAttribute('aria-hidden', 'true');
    shellRoot.hidden = false;
    shellRoot.inert = false;
    shellRoot.setAttribute('aria-hidden', 'false');
    if (boot) boot.hidden = true;
  }

  async function enter({ matchOptions = {}, onProgress = null } = {}) {
    if (game) return game;
    if (starting) return starting;

    const capability = inspectRuntimeCapabilities({ canvas });
    if (!capability.supported) {
      onUnsupported?.(capability.reasons[0], capability.observed);
      const error = new Error('This client does not meet the match runtime requirements.');
      error.code = 'UNSUPPORTED_CLIENT';
      error.details = capability;
      throw error;
    }

    // Perform the real WebGL probe only after the shell has entered match loading. Keeping this
    // out of initial shell boot is what guarantees that account/career/settings routes create no
    // graphics context and load no three.js code.
    let probeContext = null;
    try {
      probeContext = document.createElement('canvas').getContext('webgl2');
    } catch { /* handled by the null check below */ }
    if (!probeContext) {
      onUnsupported?.('webgl2', capability.observed);
      const error = new Error('WebGL 2 could not be initialized.');
      error.code = 'UNSUPPORTED_CLIENT';
      error.details = { reason: 'webgl2' };
      throw error;
    }
    probeContext.getExtension?.('WEBGL_lose_context')?.loseContext?.();

    revealGame();
    setProgress(0.02, 'Loading match runtime');

    starting = (async () => {
      let candidate = null;
      try {
        // This is the only game-engine edge reachable from the platform shell.
        const { Game } = await import('../../core/game.js');
        candidate = new Game(canvas);
        globalThis.__GAME__ = candidate;
        await candidate.init((value, label) => {
          setProgress(value, label);
          onProgress?.(value, label);
        });
        candidate.menu?.close?.();
        configureGame?.(candidate);
        candidate.bus?.once?.('toMenu', () => queueMicrotask(() => {
          exit();
          onExit?.({ reason: 'to-menu' });
        }));
        if (boot) boot.hidden = true;
        candidate.startMatch(matchOptions);
        game = candidate;
        return candidate;
      } catch (error) {
        candidate?.dispose?.();
        if (globalThis.__GAME__ === candidate) delete globalThis.__GAME__;
        revealShell();
        throw error;
      } finally {
        starting = null;
      }
    })();

    return starting;
  }

  function exit() {
    game?.dispose?.();
    if (globalThis.__GAME__ === game) delete globalThis.__GAME__;
    game = null;
    setProgress(0, 'Loading match runtime');
    revealShell();
  }

  revealShell();

  return Object.freeze({
    enter,
    exit,
    getGame: () => game,
    inspectCapabilities: () => inspectRuntimeCapabilities({ canvas }),
    isLoaded: () => Boolean(game),
  });
}
