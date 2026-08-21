import * as THREE from 'three';

import { projectBombPresentation } from './model.js';
import { renderBombHudHtml } from './view.js';

const TEAM_IDS = Object.freeze(['alpha', 'bravo']);
const LOCAL_RENDER_INTERVAL = 1 / 20;

const _eye = new THREE.Vector3();
const _target = new THREE.Vector3();
const _cameraForward = new THREE.Vector3();
const _projected = new THREE.Vector3();
const _toTarget = new THREE.Vector3();

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function pointInBox(point, box) {
  return point && box?.min && box?.max
    && point.x >= box.min.x && point.x <= box.max.x
    && point.y >= box.min.y && point.y <= box.max.y
    && point.z >= box.min.z && point.z <= box.max.z;
}

/** Resolve the exact, priority-ordered map-manifest callout for a world point. */
export function resolveManifestCallout(manifest, point) {
  let winner = null;
  for (const callout of manifest?.callouts || []) {
    if (!callout || typeof callout.name !== 'string' || !pointInBox(point, callout.box)) continue;
    const priority = finite(callout.priority) ? callout.priority : 0;
    if (!winner || priority > winner.priority
      || (priority === winner.priority && String(callout.id).localeCompare(String(winner.id)) < 0)) {
      winner = { id: callout.id, name: callout.name, priority };
    }
  }
  return winner ? winner.name : null;
}

/**
 * Convert the manifest's authoritative objective volumes to the static facade site shape.
 * No site coordinates or callout names are duplicated in UI code.
 */
export function sitesFromManifest(manifest) {
  const sites = [];
  const seen = new Set();
  for (const objective of manifest?.objectives || []) {
    if (objective?.kind !== 'plant' || !['A', 'B'].includes(objective.site)
      || typeof objective.id !== 'string' || seen.has(objective.site)) continue;
    const min = objective.box?.min;
    const max = objective.box?.max;
    if (![min?.x, min?.y, min?.z, max?.x, max?.y, max?.z].every(finite)) continue;
    const center = Object.freeze({
      x: (min.x + max.x) / 2,
      y: (min.y + max.y) / 2,
      z: (min.z + max.z) / 2,
    });
    sites.push(Object.freeze({
      id: objective.id,
      site: objective.site,
      callout: resolveManifestCallout(manifest, center) || `Site ${objective.site}`,
      center,
      box: Object.freeze({
        min: Object.freeze({ x: min.x, y: min.y, z: min.z }),
        max: Object.freeze({ x: max.x, y: max.y, z: max.z }),
      }),
    }));
    seen.add(objective.site);
  }
  return Object.freeze(sites.sort((left, right) => left.site.localeCompare(right.site)));
}

function eyePosition(game) {
  const player = game?.player;
  if (!player?.position) return null;
  if (typeof player.getEyePosition === 'function') {
    try { return player.getEyePosition(_eye) || _eye; } catch { /* use the stable fallback */ }
  }
  return _eye.set(player.position.x, player.position.y + (player.eyeHeight ?? 1.62), player.position.z);
}

function hasLineOfSight(game, point) {
  const eye = eyePosition(game);
  if (!eye || !point || typeof game?.world?.losClear !== 'function') return false;
  _target.set(point.x, point.y, point.z);
  try { return game.world.losClear(eye, _target) === true; } catch { return false; }
}

function directionToken(dx, dz, yaw = 0) {
  const forward = (-Math.sin(yaw) * dx) + (-Math.cos(yaw) * dz);
  const right = (Math.cos(yaw) * dx) + (-Math.sin(yaw) * dz);
  const angle = Math.atan2(right, forward) * 180 / Math.PI;
  if (angle >= -22.5 && angle < 22.5) return 'center';
  if (angle >= 22.5 && angle < 67.5) return 'ne';
  if (angle >= 67.5 && angle < 112.5) return 'e';
  if (angle >= 112.5 && angle < 157.5) return 'se';
  if (angle >= 157.5 || angle < -157.5) return 's';
  if (angle >= -157.5 && angle < -112.5) return 'sw';
  if (angle >= -112.5 && angle < -67.5) return 'w';
  return 'nw';
}

/** Project one always-public site through the current local camera onto a safe HUD edge. */
export function projectLocalSiteMarker(game, site) {
  const player = game?.player;
  if (!player?.position || !site?.center) return null;
  const dx = site.center.x - player.position.x;
  const dy = site.center.y - player.position.y;
  const dz = site.center.z - player.position.z;
  const distanceM = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const direction = directionToken(dx, dz, finite(player.yaw) ? player.yaw : 0);
  let screenX = 50;
  let screenY = 50;
  let offscreen = direction !== 'center';
  const camera = game?.camera;
  if (camera?.isCamera && camera.position && camera.matrixWorldInverse && camera.projectionMatrix) {
    _target.set(site.center.x, site.center.y, site.center.z);
    camera.getWorldDirection(_cameraForward);
    const inFront = _cameraForward.dot(_toTarget.copy(_target).sub(camera.position)) > 0;
    _projected.copy(_target).project(camera);
    if (inFront && finite(_projected.x) && finite(_projected.y)) {
      offscreen = Math.abs(_projected.x) > 0.84 || Math.abs(_projected.y) > 0.72;
      screenX = 50 + Math.max(-0.84, Math.min(0.84, _projected.x)) * 50;
      screenY = 50 - Math.max(-0.72, Math.min(0.72, _projected.y)) * 50;
    } else {
      screenX = direction.includes('e') ? 92 : direction.includes('w') ? 8 : 50;
      screenY = direction === 's' || direction.includes('s') ? 82 : 12;
      offscreen = true;
    }
  } else {
    screenX = direction.includes('e') ? 92 : direction.includes('w') ? 8 : 50;
    screenY = direction === 's' || direction.includes('s') ? 82 : direction === 'center' ? 42 : 12;
  }
  return Object.freeze({
    siteId: site.site,
    distanceM,
    occluded: !hasLineOfSight(game, site.center),
    offscreen,
    direction,
    screenX,
    screenY,
  });
}

function visibleBomb(game, match, localTeam, attackingTeam) {
  const source = match?.bomb || {};
  const state = ['none', 'carried', 'dropped', 'planted', 'defused', 'detonated'].includes(source.state)
    ? source.state : 'none';
  const attacker = localTeam === attackingTeam;
  const carrier = source.carrierId > 0 ? game?.entityById?.(source.carrierId) : null;
  const carrierVisible = attacker || (carrier?.position && hasLineOfSight(game, carrier.position));
  const carrierId = state === 'carried' && carrierVisible ? source.carrierId : null;
  const positionMeaningful = state === 'dropped' || state === 'planted';
  const positionVisible = positionMeaningful && source.position
    && (attacker || state === 'planted' || hasLineOfSight(game, source.position));
  return Object.freeze({
    state,
    carrierId,
    siteId: source.siteId === 'A' || source.siteId === 'B' ? source.siteId : null,
    position: positionVisible
      ? Object.freeze({ x: source.position.x, y: source.position.y, z: source.position.z })
      : null,
  });
}

function bindingMap(game) {
  const out = {};
  const labels = {
    ArrowLeft: 'LEFT', ArrowRight: 'RIGHT', ArrowUp: 'UP', ArrowDown: 'DOWN',
    Space: 'SPACE', Enter: 'ENTER', Tab: 'TAB', Escape: 'ESC',
  };
  for (const [code, action] of Object.entries(game?.settings?.get?.('binds') || {})) {
    if (!out[action]) out[action] = labels[code] || code.replace(/^Key/, '').replace(/^Digit/, '');
  }
  return out;
}

function localPreferences(game) {
  const hudScale = Number(game?.settings?.get?.('hudScale'));
  const root = globalThis.document?.documentElement;
  return Object.freeze({
    hudScale: finite(hudScale) ? hudScale * 100 : 100,
    reduceMotion: root?.classList?.contains('os-prefer-reduced-motion') === true,
    colorVisionPreset: root?.dataset?.colorVision || 'default',
  });
}

function winnerName(team, reason = null) {
  if (team === 0) return 'alpha';
  if (team === 1) return 'bravo';
  return reason === 'no-contest' ? null : 'draw';
}

/** Build one facade-shaped, privacy-filtered sample from the local authoritative referee. */
export function buildLocalBombSample(game, nowMs = performance.now(), transient = {}) {
  const match = game?.match;
  if (!match || match.modeId !== 'bomb') return null;
  const rules = match.bombRules;
  const manifest = match.mapManifest || game?.world?.manifest;
  const sites = sitesFromManifest(manifest);
  const player = game?.player;
  const localTeamNumber = player?.team === 1 ? 1 : 0;
  const attackingTeam = match.attackingTeam === 1 ? 1 : 0;
  const alive = match.aliveCounts || {};
  const phase = ['warmup', 'freeze', 'live', 'planted', 'roundEnd', 'matchEnd'].includes(match.roundPhase)
    ? match.roundPhase : 'warmup';
  const remainingMs = finite(match.phaseRemainingMs) ? Math.max(0, match.phaseRemainingMs) : 0;
  const isAlive = rules?.isAlive ? rules.isAlive(player) : player?.alive !== false;
  const liveRound = phase === 'live' || phase === 'planted';
  const localTeam = TEAM_IDS[localTeamNumber];
  const localRole = localTeamNumber === attackingTeam ? 'attacker' : 'defender';
  const matchState = Object.freeze({
    version: 1,
    matchId: null,
    serverNow: nowMs,
    sampledAt: nowMs,
    mode: 'bomb',
    mapId: manifest?.mapId || game?.world?.mapId || null,
    mapVersion: manifest?.mapVersion || game?.world?.mapVersion || null,
    rulesetVersion: null,
    phase,
    phaseEndsAt: nowMs + remainingMs,
    teams: Object.freeze({
      alpha: Object.freeze({ score: match.scores?.[0] ?? 0, alive: alive.alpha ?? null,
        role: attackingTeam === 0 ? 'attacker' : 'defender' }),
      bravo: Object.freeze({ score: match.scores?.[1] ?? 0, alive: alive.bravo ?? null,
        role: attackingTeam === 1 ? 'attacker' : 'defender' }),
    }),
    series: Object.freeze({
      roundsToWin: Number.isInteger(match.mode?.roundsToWin) ? match.mode.roundsToWin : null,
      maxRounds: Number.isInteger(match.mode?.maxRounds) ? match.mode.maxRounds : null,
      sideSwitchAfter: null,
      sideSwitched: match.sideSwitched === true,
      overtime: false,
    }),
    round: Object.freeze({ index: Number.isInteger(match.roundIndex) ? match.roundIndex : 0, endsAt: nowMs + remainingMs }),
    bomb: visibleBomb(game, match, localTeamNumber, attackingTeam),
    interaction: match.interaction || Object.freeze({ kind: 'none', actorId: null, progress: 0 }),
    sites,
    localPlayer: Object.freeze({
      entityId: Number.isInteger(player?.id) ? player.id : null,
      team: localTeam,
      role: localRole,
      alive: isAlive,
      isSpectating: !isAlive,
      spectatingId: null,
      spectatorPolicy: Object.freeze({
        canSpectateEnemies: false,
        canFreeCam: rules?.canFreeCam?.() === true,
        canUseTeamChat: isAlive || !liveRound,
      }),
    }),
  });
  const siteMarkers = sites.map((site) => projectLocalSiteMarker(game, site)).filter(Boolean);
  return Object.freeze({
    matchState,
    netState: 'idle',
    netStats: null,
    nowMs,
    localAuthority: true,
    bindings: bindingMap(game),
    preferences: localPreferences(game),
    siteMarkers,
    typedEvent: transient.typedEvent || null,
    outcomeEvent: transient.outcomeEvent || null,
    cue: transient.cue || null,
  });
}

function eventProjection(row) {
  if (!row?.kind) return {};
  const cueKinds = new Set([
    'bombDropped', 'bombPickedUp', 'plantStart', 'plantComplete', 'plantCancel',
    'defuseStart', 'defuseComplete', 'defuseCancel', 'bombDetonated', 'sideSwitch',
  ]);
  const typedEvent = row.kind === 'interactRefused'
    ? { type: 'interactionRefused', kind: row.requested, reason: row.reason }
    : row.kind === 'plantCancel' || row.kind === 'defuseCancel'
      ? { type: row.kind, reason: row.reason }
      : null;
  const outcomeEvent = row.kind === 'roundEnd'
    ? { type: 'roundEnded', winner: winnerName(row.winnerTeam, row.reason), reason: row.reason }
    : row.kind === 'matchEnd'
      ? { type: 'matchEnded', winner: winnerName(row.winnerTeam, row.outcomeReason || row.reason), outcomeReason: row.outcomeReason || row.reason }
      : null;
  return {
    typedEvent,
    outcomeEvent,
    cue: cueKinds.has(row.kind) ? { type: row.kind } : null,
  };
}

/** Mount the local-practice adapter without importing or imitating the CC-owned net facade. */
export function createLocalBombHud({ game, root, document: documentRef = globalThis.document } = {}) {
  if (!root || !documentRef) throw new TypeError('Local Bomb HUD requires a root and document.');
  const mount = documentRef.createElement('div');
  mount.className = 'bomb-hud-mount';
  mount.hidden = true;
  root.appendChild(mount);
  let accumulator = LOCAL_RENDER_INTERVAL;
  let lastMarkup = '';
  let transient = {};
  let transientUntil = 0;
  const unsubs = [];
  const on = game?.bus?.on?.bind(game.bus);
  if (on) {
    unsubs.push(on('objective', (row) => {
      transient = eventProjection(row);
      transientUntil = performance.now() + (row?.kind === 'roundEnd' || row?.kind === 'matchEnd' ? 4_000 : 1_800);
      accumulator = LOCAL_RENDER_INTERVAL;
    }));
    unsubs.push(on('matchStart', () => { transient = {}; lastMarkup = ''; accumulator = LOCAL_RENDER_INTERVAL; }));
    unsubs.push(on('toMenu', () => { transient = {}; lastMarkup = ''; mount.hidden = true; }));
  }

  const update = (dt = LOCAL_RENDER_INTERVAL) => {
    const active = game?.match?.modeId === 'bomb' && ['playing', 'paused'].includes(game?.state);
    mount.hidden = !active;
    root.classList.toggle('bomb-mode', active);
    root.removeAttribute('aria-hidden');
    for (const child of root.children) {
      if (child === mount || child.classList?.contains('sb')) continue;
      if (active) child.setAttribute('aria-hidden', 'true');
      else child.removeAttribute('aria-hidden');
    }
    if (!active) return null;
    accumulator += Math.max(0, Number(dt) || 0);
    if (accumulator < LOCAL_RENDER_INTERVAL) return null;
    accumulator %= LOCAL_RENDER_INTERVAL;
    const nowMs = performance.now();
    if (transientUntil && nowMs >= transientUntil) { transient = {}; transientUntil = 0; }
    const sample = buildLocalBombSample(game, nowMs, transient);
    if (!sample) return null;
    const model = projectBombPresentation(sample);
    const markup = renderBombHudHtml(model);
    if (markup !== lastMarkup) {
      lastMarkup = markup;
      mount.innerHTML = markup;
    }
    return model;
  };

  return Object.freeze({
    element: mount,
    update,
    reset() { transient = {}; transientUntil = 0; lastMarkup = ''; accumulator = LOCAL_RENDER_INTERVAL; mount.innerHTML = ''; },
    destroy() { for (const off of unsubs) off?.(); mount.remove(); },
  });
}
