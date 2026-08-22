import { mouseCode } from '../../core/mouseCodes.js';
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
  else if (mac) {
    os = 'macos';
    osMajor = Number(mac[1]);
    // Chromium's reduced desktop UA deliberately freezes every modern macOS release at
    // 10_15_7. Treat that value as unknown instead of rejecting supported Mac players as
    // Catalina; Safari still exposes a usable OS major and remains enforceable here.
    if (/(?:Chrome|Chromium|Edg)\//.test(ua) && /Mac OS X 10_15_7/.test(ua)) osMajor = null;
  }
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
    || (client.os === 'macos' && client.osMajor !== null && client.osMajor < 13)) {
    reasons.push('os-version');
  }
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
  networkFacade = null,
  loadNetworkFacade = null,
  loadGame = () => import('../../core/game.js'),
  onUnsupported = null,
  onNetworkDiagnostics = null,
} = {}) {
  if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('A game canvas is required.');
  if (!(gameLayer instanceof HTMLElement)) throw new TypeError('A game layer is required.');
  if (!(shellRoot instanceof HTMLElement)) throw new TypeError('A shell root is required.');

  let game = null;
  let starting = null;
  let activeNetworkFacade = null;
  let activeProgression = null;
  let stopTerminalListener = null;
  let stopDiagnosticsListener = null;
  let stopDisconnectedListener = null;
  let stopStateChangeListener = null;
  let stopReconnectUpdateListener = null;
  let stopVersionMismatchListener = null;
  let spectatorKeyHandler = null;
  let tacticalMouseHandler = null;
  let terminalExitTimer = null;
  let reconnectOverlay = null;
  let reconnectCountdownTimer = null;

  function buildReconnectOverlay() {
    const el = document.createElement('div');
    el.className = 'runtime-reconnect-overlay';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-live', 'assertive');
    el.hidden = true;
    el.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;'
      + 'justify-content:center;flex-direction:column;gap:12px;background:rgba(6,8,12,0.82);'
      + 'color:#f4f6fb;font:600 16px/1.4 system-ui,sans-serif;text-align:center;z-index:50;';
    const title = document.createElement('div');
    title.className = 'runtime-reconnect-overlay__title';
    title.style.cssText = 'font-size:20px;letter-spacing:0.02em;';
    const sub = document.createElement('div');
    sub.className = 'runtime-reconnect-overlay__sub';
    sub.style.cssText = 'font-weight:400;opacity:0.85;font-size:14px;';
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'runtime-reconnect-overlay__action';
    action.style.cssText = 'margin-top:8px;padding:8px 18px;border-radius:6px;'
      + 'border:1px solid rgba(255,255,255,0.35);background:transparent;color:inherit;'
      + 'font:inherit;cursor:pointer;';
    el.append(title, sub, action);
    gameLayer.appendChild(el);
    return { el, title, sub, action };
  }

  function clearReconnectOverlay() {
    clearInterval(reconnectCountdownTimer);
    reconnectCountdownTimer = null;
    reconnectOverlay?.el?.remove();
    reconnectOverlay = null;
  }

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

  async function enter({ matchOptions = {}, handoff = null, onProgress = null,
    serverCareer = null, firstMatch = false } = {}) {
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
      let facade = null;
      try {
        // This is the only game-engine edge reachable from the platform shell.
        const networked = handoff && handoff.fixture !== true && handoff.localPractice !== true;
        if (networked) {
          const { progression } = await import('../../game/progression.js');
          progression.beginAuthoritativeSession(serverCareer, handoff.mode);
          activeProgression = progression;
          facade = networkFacade ?? await loadNetworkFacade?.();
          if (!facade?.reserve || !facade?.promoteReservation) {
            const error = new Error('The authoritative match network adapter is unavailable.');
            error.code = 'FEATURE_DISABLED';
            throw error;
          }
          // Consume the 60-second single-use ticket before importing/initializing the renderer.
          // The lightweight reservation sends no gameplay commands, so the server holds its
          // referee clock until the initialized client is promoted and begins input.
          await facade.reserve(handoff);
        }
        const { Game } = await loadGame();
        candidate = new Game(canvas);
        candidate.progressionAuthority = networked ? 'server' : 'practice-unverified';
        if (networked) candidate.netFacade = facade;
        globalThis.__GAME__ = candidate;
        await candidate.init((value, label) => {
          setProgress(value, label);
          onProgress?.(value, label);
        });
        candidate.menu?.close?.();
        configureGame?.(candidate);
        let authoritativeTerminal = null;
        if (networked && typeof facade?.on === 'function') {
          stopTerminalListener = facade.on('matchEnded', (terminal) => {
            if (authoritativeTerminal || terminal?.matchId !== handoff.matchId) return;
            if (!['completed', 'aborted', 'invalidated'].includes(terminal.terminationReason)) return;
            authoritativeTerminal = Object.freeze({
              matchId: terminal.matchId,
              winner: terminal.winner ?? null,
              outcomeReason: terminal.outcomeReason ?? null,
              terminationReason: terminal.terminationReason,
            });
            candidate.hud?.scoreboard?.setVisible?.(true);
            candidate.hud?.notice?.('MATCH COMPLETE', 'Returning to results', 1.2);
            clearTimeout(terminalExitTimer);
            terminalExitTimer = setTimeout(() => {
              terminalExitTimer = null;
              candidate.bus?.emit?.('toMenu', { authoritative: true });
            }, 1200);
          });
          const publishDiagnostics = () => onNetworkDiagnostics?.(facade.netStats);
          stopDiagnosticsListener = facade.on('matchState', publishDiagnostics);

          // Mid-match connection loss: the facade runs a real, silent reconnect loop on socket
          // drop (net-facade.md §3.2). Without this, a dropped player sees a frozen match with
          // no countdown, no cancel, and — on grace expiry or version mismatch — no way back to
          // the shell, because no `matchEnded` is ever emitted for those outcomes.
          const finishWithConnectionFailure = (reason) => {
            clearReconnectOverlay();
            if (authoritativeTerminal) return;
            authoritativeTerminal = Object.freeze({
              matchId: handoff.matchId,
              winner: null,
              outcomeReason: reason ?? null,
              terminationReason: 'aborted',
            });
            candidate.hud?.notice?.('CONNECTION LOST', 'Returning to menu', 1.2);
            clearTimeout(terminalExitTimer);
            terminalExitTimer = setTimeout(() => {
              terminalExitTimer = null;
              candidate.bus?.emit?.('toMenu', { authoritative: true });
            }, 1200);
          };
          const showReconnectOverlay = (title, sub, { action = null } = {}) => {
            if (!reconnectOverlay) reconnectOverlay = buildReconnectOverlay();
            reconnectOverlay.title.textContent = title;
            reconnectOverlay.sub.textContent = sub;
            reconnectOverlay.el.hidden = false;
            reconnectOverlay.action.onclick = null;
            if (action) {
              reconnectOverlay.action.hidden = false;
              reconnectOverlay.action.textContent = action.label;
              reconnectOverlay.action.onclick = action.onClick;
            } else {
              reconnectOverlay.action.hidden = true;
            }
          };
          const tickReconnectCountdown = () => {
            const info = facade.reconnect;
            if (!info || !reconnectOverlay) return;
            const remainingMs = Math.max(0, info.graceEndsAt - performance.now());
            showReconnectOverlay('Connection lost', `Reconnecting… attempt ${info.attempt}/`
              + `${info.maxAttempts} · ${Math.ceil(remainingMs / 1000)}s left`, {
              action: {
                label: 'Cancel',
                onClick: () => { facade.disconnect?.('client-cancelled'); },
              },
            });
          };
          stopDisconnectedListener = facade.on('disconnected', () => {
            if (authoritativeTerminal) return;
            showReconnectOverlay('Connection lost', 'Reconnecting…', {
              action: { label: 'Cancel', onClick: () => { facade.disconnect?.('client-cancelled'); } },
            });
          });
          stopReconnectUpdateListener = facade.on('reconnectUpdate', () => {
            if (authoritativeTerminal) return;
            clearInterval(reconnectCountdownTimer);
            tickReconnectCountdown();
            reconnectCountdownTimer = setInterval(tickReconnectCountdown, 250);
          });
          stopVersionMismatchListener = facade.on('versionMismatch', () => {
            if (authoritativeTerminal) return;
            clearInterval(reconnectCountdownTimer);
            reconnectCountdownTimer = null;
            showReconnectOverlay('Update required', 'Your client no longer matches the server '
              + 'version. Reload to update — this match cannot be resumed.', {
              action: { label: 'Leave match', onClick: () => finishWithConnectionFailure('version-mismatch') },
            });
          });
          stopStateChangeListener = facade.on('stateChange', ({ to, reason } = {}) => {
            if (to === 'live') {
              clearReconnectOverlay();
            } else if (to === 'closed') {
              finishWithConnectionFailure(reason);
            }
          });
          spectatorKeyHandler = (event) => {
            if (event.repeat) return;
            const action = candidate?.settings?.actionFor?.(event.code);
            if (action === 'tacticalPing') {
              if (facade.requestTacticalPing?.('location')) event.preventDefault();
              return;
            }
            if (action !== 'spectatePrevious' && action !== 'spectateNext') return;
            if (facade.cycleSpectator?.(action === 'spectatePrevious' ? -1 : 1)) {
              event.preventDefault();
            }
          };
          window.addEventListener('keydown', spectatorKeyHandler);
          tacticalMouseHandler = (event) => {
            const code = mouseCode(event.button);
            if (candidate?.settings?.actionFor?.(code) === 'tacticalPing'
              && facade.requestTacticalPing?.('location')) event.preventDefault();
          };
          window.addEventListener('mousedown', tacticalMouseHandler);
        }
        candidate.bus?.once?.('toMenu', (localOutcome) => queueMicrotask(() => {
          // Never turn a local simulation payload into a completed network result. Only the
          // facade's server-derived terminal event can do that.
          const terminal = networked ? authoritativeTerminal : null;
          const terminationReason = terminal?.terminationReason ?? null;
          const outcome = networked
            ? terminationReason === 'completed' ? 'completed'
              : ['aborted', 'invalidated'].includes(terminationReason) ? 'aborted' : null
            : (typeof localOutcome?.outcome === 'string' ? localOutcome.outcome : null);
          const exitOutcome = Object.freeze({
            reason: 'to-menu',
            ...(outcome ? { outcome } : {}),
            completed: networked ? terminationReason === 'completed'
              : localOutcome?.completed === true,
            mode: networked ? handoff.mode : (localOutcome?.mode ?? matchOptions.mode ?? null),
            firstMatch: firstMatch === true,
            ...(terminal || {}),
          });
          exit();
          onExit?.(exitOutcome);
        }));
        if (boot) boot.hidden = true;
        candidate.startMatch({
          ...matchOptions,
          mode: networked ? handoff.mode : matchOptions.mode,
          botCount: networked ? 0 : matchOptions.botCount,
        });
        if (networked) {
          if (!facade?.bindGame) {
            const error = new Error('The authoritative match network adapter is unavailable.');
            error.code = 'FEATURE_DISABLED';
            throw error;
          }
          facade.bindGame(candidate);
          await facade.promoteReservation();
          activeNetworkFacade = facade;
        }
        game = candidate;
        return candidate;
      } catch (error) {
        stopTerminalListener?.();
        stopTerminalListener = null;
        stopDiagnosticsListener?.();
        stopDiagnosticsListener = null;
        stopDisconnectedListener?.();
        stopDisconnectedListener = null;
        stopStateChangeListener?.();
        stopStateChangeListener = null;
        stopReconnectUpdateListener?.();
        stopReconnectUpdateListener = null;
        stopVersionMismatchListener?.();
        stopVersionMismatchListener = null;
        clearReconnectOverlay();
        if (spectatorKeyHandler) window.removeEventListener('keydown', spectatorKeyHandler);
        spectatorKeyHandler = null;
        if (tacticalMouseHandler) window.removeEventListener('mousedown', tacticalMouseHandler);
        tacticalMouseHandler = null;
        clearTimeout(terminalExitTimer);
        terminalExitTimer = null;
        activeProgression?.endAuthoritativeSession?.();
        activeProgression = null;
        facade?.disconnect?.('runtime-start-failed');
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
    stopTerminalListener?.();
    stopTerminalListener = null;
    stopDiagnosticsListener?.();
    stopDiagnosticsListener = null;
    stopDisconnectedListener?.();
    stopDisconnectedListener = null;
    stopStateChangeListener?.();
    stopStateChangeListener = null;
    stopReconnectUpdateListener?.();
    stopReconnectUpdateListener = null;
    stopVersionMismatchListener?.();
    stopVersionMismatchListener = null;
    clearReconnectOverlay();
    onNetworkDiagnostics?.(null);
    if (spectatorKeyHandler) window.removeEventListener('keydown', spectatorKeyHandler);
    spectatorKeyHandler = null;
    if (tacticalMouseHandler) window.removeEventListener('mousedown', tacticalMouseHandler);
    tacticalMouseHandler = null;
    clearTimeout(terminalExitTimer);
    terminalExitTimer = null;
    activeNetworkFacade?.disconnect?.('runtime-exit');
    activeNetworkFacade = null;
    game?.dispose?.();
    if (globalThis.__GAME__ === game) delete globalThis.__GAME__;
    game = null;
    activeProgression?.endAuthoritativeSession?.();
    activeProgression = null;
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
