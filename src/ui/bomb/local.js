import * as THREE from 'three';

import { projectBombPresentation } from './model.js';
import { renderBombHudHtml } from './view.js';

const TEAM_IDS = Object.freeze(['alpha', 'bravo']);
const LOCAL_RENDER_INTERVAL = 1 / 20;
const LIVE_FRESHNESS_MS = 750;

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
  const frozenBox = (min, max) => Object.freeze({
    min: Object.freeze({ x: min.x, y: min.y, z: min.z }),
    max: Object.freeze({ x: max.x, y: max.y, z: max.z }),
  });
  // §3.3: a site may carry a separate defuse volume; when omitted it defaults to the
  // plant volume (mirrors compileObjectives in the referee — no looser, no tighter).
  const defuseBoxes = new Map();
  for (const objective of manifest?.objectives || []) {
    if (objective?.kind !== 'defuse' || !['A', 'B'].includes(objective.site)) continue;
    const min = objective.box?.min;
    const max = objective.box?.max;
    if (![min?.x, min?.y, min?.z, max?.x, max?.y, max?.z].every(finite)) continue;
    if (!defuseBoxes.has(objective.site)) defuseBoxes.set(objective.site, frozenBox(min, max));
  }
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
    const box = frozenBox(min, max);
    sites.push(Object.freeze({
      id: objective.id,
      site: objective.site,
      callout: resolveManifestCallout(manifest, center) || `Site ${objective.site}`,
      center,
      box,
      defuseBox: defuseBoxes.get(objective.site) || box,
      // Same default the referee compiles: absent means the plant demands ground contact.
      requiresGround: objective.requiresGround !== false,
    }));
    seen.add(objective.site);
  }
  return Object.freeze(sites.sort((left, right) => left.site.localeCompare(right.site)));
}

/**
 * bomb-rules §13.1: this round's home site for a team index, derived from the sorted site
 * letters + the side switch — the same facts every consumer derives ownership from. A
 * manifest `homeSites` override travels through `match.homeSites`; callers should prefer
 * that when a referee is in-process and fall back to this derivation on the pure client.
 */
export function homeSiteOfTeam(teamIndex, sideSwitched, siteLetters = ['A', 'B']) {
  const letters = [...siteLetters].sort();
  if (letters.length !== 2 || (teamIndex !== 0 && teamIndex !== 1)) return null;
  const first = teamIndex === 0;
  return (sideSwitched ? !first : first) ? letters[0] : letters[1];
}

/**
 * Mirror of the referee's §6/§7/§13.4 interaction preconditions (`_validate` in
 * `src/game/bomb.js`), computed only from facts the client already learns: its own
 * predicted body, the public site volumes, and the privacy-filtered bomb view. It is
 * deliberately NOT looser — every server check observable client-side is repeated —
 * so the prompt never advertises an interaction the referee would refuse for a
 * client-knowable reason (§13.10: carrying the bomb at your OWN site must not show a
 * plant prompt — that is the `wrongSite` refusal). Server-only facts (disconnection,
 * same-tick death ordering) stay with the server's refusal events.
 *
 * @returns {'plant'|'defuse'|null}
 */
export function deriveEligibleInteraction({
  phase, homeSite, targetSite, alive, localEntityId, bomb, sites, position, grounded,
} = {}) {
  if (alive !== true || !position || !finite(position.x)) return null;
  if (phase === 'live') {
    // §6/§13.4: live phase, carrier only, and ONLY inside the TARGET site (enemy home).
    if (bomb?.state !== 'carried' || !localEntityId || bomb.carrierId !== localEntityId) return null;
    if (targetSite !== 'A' && targetSite !== 'B') return null;
    const site = (sites || []).find((row) => row?.site === targetSite);
    const box = site?.box;
    if (!box || !pointInBox(position, box)) return null;
    // §6 notGrounded: only an explicit `grounded === false` refuses, as in the referee.
    if (site.requiresGround !== false && grounded === false) return null;
    return 'plant';
  }
  if (phase === 'planted') {
    // §7/§13.4: defuse belongs to the SITE OWNER — only when the plant sits at the local
    // team's HOME site, inside its defuse volume.
    if (bomb?.siteId !== 'A' && bomb?.siteId !== 'B') return null;
    if (bomb.siteId !== homeSite) return null;
    const site = (sites || []).find((row) => row?.site === bomb.siteId);
    const box = site?.defuseBox || site?.box;
    return box && pointInBox(position, box) ? 'defuse' : null;
  }
  return null;
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

function visibleBomb(game, match, localTeam) {
  const source = match?.bomb || {};
  const state = ['none', 'carried', 'dropped', 'planted', 'defused', 'detonated'].includes(source.state)
    ? source.state : 'none';
  // §5 carrier visibility is unchanged by §13: teammates always, enemies by line of sight.
  const carrier = source.carrierId > 0 ? game?.entityById?.(source.carrierId) : null;
  const carrierVisible = (carrier && carrier.team === localTeam)
    || (carrier?.position && hasLineOfSight(game, carrier.position));
  const carrierId = state === 'carried' && carrierVisible ? source.carrierId : null;
  // §13.3: a dropped/neutral bomb's position is public to BOTH teams at all times — it is
  // the shared objective. A planted bomb's position is likewise public (§8.6).
  const positionVisible = (state === 'dropped' || state === 'planted') && source.position;
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
  const alive = match.aliveCounts || {};
  const phase = ['warmup', 'freeze', 'live', 'planted', 'roundEnd', 'matchEnd'].includes(match.roundPhase)
    ? match.roundPhase : 'warmup';
  const remainingMs = finite(match.phaseRemainingMs) ? Math.max(0, match.phaseRemainingMs) : 0;
  const isAlive = rules?.isAlive ? rules.isAlive(player) : player?.alive !== false;
  const liveRound = phase === 'live' || phase === 'planted';
  const localTeam = TEAM_IDS[localTeamNumber];
  // §13.1 ownership: prefer the referee's own assignment (it honours a manifest
  // `homeSites` override); derive from site order + side switch otherwise.
  const sideSwitched = match.sideSwitched === true;
  const refereeHome = match.homeSites || null;
  const homeOf = (teamIndex) => refereeHome?.[teamIndex]
    ?? homeSiteOfTeam(teamIndex, sideSwitched, sites.map((s) => s.site));
  const localHomeSite = homeOf(localTeamNumber);
  const localTargetSite = homeOf(localTeamNumber === 0 ? 1 : 0);
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
      // §13.8: no attackers or defenders — the frozen `role` fields are served null.
      alpha: Object.freeze({ score: match.scores?.[0] ?? 0, alive: alive.alpha ?? null, role: null }),
      bravo: Object.freeze({ score: match.scores?.[1] ?? 0, alive: alive.bravo ?? null, role: null }),
    }),
    series: Object.freeze({
      roundsToWin: Number.isInteger(match.mode?.roundsToWin) ? match.mode.roundsToWin : null,
      maxRounds: Number.isInteger(match.mode?.maxRounds) ? match.mode.maxRounds : null,
      sideSwitchAfter: null,
      sideSwitched: match.sideSwitched === true,
      overtime: false,
    }),
    round: Object.freeze({ index: Number.isInteger(match.roundIndex) ? match.roundIndex : 0, endsAt: nowMs + remainingMs }),
    bomb: visibleBomb(game, match, localTeamNumber),
    interaction: match.interaction || Object.freeze({ kind: 'none', actorId: null, progress: 0 }),
    sites,
    localPlayer: Object.freeze({
      entityId: Number.isInteger(player?.id) ? player.id : null,
      team: localTeam,
      role: null,
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
  // Derived from the already privacy-filtered view (`matchState.bomb`), never the raw
  // referee, so a hidden carrier can never light the prompt for the wrong player.
  const eligibleAction = deriveEligibleInteraction({
    phase,
    homeSite: localHomeSite,
    targetSite: localTargetSite,
    alive: isAlive === true,
    localEntityId: matchState.localPlayer.entityId,
    bomb: matchState.bomb,
    sites,
    position: player?.position,
    grounded: player?.grounded,
  });
  // §13.10: either team may carry — the HUD tints the carrier by the carrier's TEAM.
  const visibleCarrier = matchState.bomb.carrierId > 0
    ? game?.entityById?.(matchState.bomb.carrierId) : null;
  const carrierTeam = visibleCarrier?.team === 0 ? 'alpha' : visibleCarrier?.team === 1 ? 'bravo' : null;
  return Object.freeze({
    matchState,
    netState: 'idle',
    netStats: null,
    nowMs,
    localAuthority: true,
    eligibleAction,
    carrierTeam,
    bindings: bindingMap(game),
    preferences: localPreferences(game),
    siteMarkers,
    typedEvent: transient.typedEvent || null,
    outcomeEvent: transient.outcomeEvent || null,
    cue: transient.cue || null,
  });
}

/** Build the same presentation input from Contract 6's server-derived live views. */
export function buildFacadeBombSample(game, facade, nowMs = performance.now(), transient = {}) {
  const state = facade?.matchState;
  if (!state || state.mode !== 'bomb') return null;
  const sites = Array.isArray(state.sites) ? state.sites : [];
  // §13.1 ownership on the pure client: derived from the handoff's site letters + the
  // side switch — the role field arrives null on a 2.0.0 server and decides nothing.
  const teamIndex = state.localPlayer?.team === 'alpha' ? 0
    : state.localPlayer?.team === 'bravo' ? 1 : null;
  const letters = sites.map((s) => s?.site).filter((s) => s === 'A' || s === 'B');
  const sideSwitched = state.series?.sideSwitched === true;
  const homeSite = teamIndex === null ? null : homeSiteOfTeam(teamIndex, sideSwitched, letters);
  const targetSite = teamIndex === null ? null : homeSiteOfTeam(teamIndex === 0 ? 1 : 0, sideSwitched, letters);
  // Same §6/§7/§13.4 mirror as local practice, from the client's own predicted body and
  // the facade's public views. The wire's handoff sites carry one public box per site.
  const eligibleAction = deriveEligibleInteraction({
    phase: state.phase,
    homeSite,
    targetSite,
    alive: state.localPlayer?.alive === true,
    localEntityId: state.localPlayer?.entityId,
    bomb: state.bomb,
    sites,
    position: game?.player?.position,
    grounded: game?.player?.grounded,
  });
  // Carrier tint by the carrier's team (§13.10): self is decided by id in the model;
  // otherwise the facade's replicated remotes carry the team of any visible carrier.
  const carrierId = state.bomb?.carrierId;
  const remoteCarrier = carrierId > 0 ? facade?.remoteEntities?.get?.(carrierId) : null;
  const carrierTeam = carrierId > 0 && carrierId === state.localPlayer?.entityId
    ? state.localPlayer?.team ?? null
    : remoteCarrier?.team === 0 ? 'alpha' : remoteCarrier?.team === 1 ? 'bravo' : null;
  return Object.freeze({
    carrierTeam,
    matchState: state,
    netState: facade.state,
    netStats: facade.netStats,
    reconnect: facade.reconnect,
    nowMs,
    freshnessThresholdMs: LIVE_FRESHNESS_MS,
    localAuthority: false,
    eligibleAction,
    bindings: bindingMap(game),
    preferences: localPreferences(game),
    siteMarkers: sites.map((site) => projectLocalSiteMarker(game, site)).filter(Boolean),
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
export function createLocalBombHud({ game, root, facade = game?.netFacade ?? null,
  document: documentRef = globalThis.document } = {}) {
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
  const facadeOn = facade?.on?.bind(facade);
  if (facadeOn) {
    const cue = (type) => (payload) => {
      transient = type === 'interactionRefused'
        ? { typedEvent: { type, ...payload } }
        : type === 'roundEnded' || type === 'matchEnded'
          ? { outcomeEvent: { type, ...payload } }
          : { cue: { type: payload?.kind || type } };
      transientUntil = performance.now() + (type.endsWith('Ended') ? 4_000 : 1_800);
      accumulator = LOCAL_RENDER_INTERVAL;
    };
    unsubs.push(facadeOn('interactionRefused', cue('interactionRefused')));
    unsubs.push(facadeOn('roundEnded', cue('roundEnded')));
    unsubs.push(facadeOn('matchEnded', cue('matchEnded')));
    unsubs.push(facadeOn('event', cue('event')));
    unsubs.push(facadeOn('stateChange', () => { accumulator = LOCAL_RENDER_INTERVAL; }));
  }
  const onClick = (event) => {
    if (event.target?.closest?.('[data-bomb-action="cancel-connection"]')) {
      facade?.disconnect?.('player-cancelled');
    }
  };
  mount.addEventListener('click', onClick);

  // §6.4 held-intent driver for local practice. On the wire, `net/server.js` turns the
  // command's `interactHeld` bit into `requestInteract` every tick and `releaseInteract`
  // the moment it drops — but without a server nothing performed that step for the local
  // human, so the prompt advertised a key the referee never heard ("PLANT — E" did
  // nothing). This mirrors the server's loop 1:1 through the same public referee API the
  // in-process bots use: request every frame while the bound key is held (the referee
  // re-validates every step and dedupes refusals itself), release otherwise. Pausing
  // counts as release — opening the menu mid-plant is an interruption (player.js clears
  // `interactHeld` for the same reason).
  const driveLocalInteract = () => {
    const rules = game?.match?.bombRules;
    const player = game?.player;
    if (!rules || !player) return;
    const held = game.state === 'playing'
      && player.alive !== false
      && player._held?.interactHeld === true;
    if (held) {
      // §13.4/§13.10: the held key's meaning is context, not role — the referee's own
      // `interactKindFor` says whether this player would be defusing or planting.
      rules.requestInteract(player, rules.interactKindFor?.(player) ?? 'plant');
    } else {
      rules.releaseInteract(player);
    }
  };

  const update = (dt = LOCAL_RENDER_INTERVAL) => {
    const networkBomb = facade?.descriptor?.mode === 'bomb';
    const active = (networkBomb || game?.match?.modeId === 'bomb')
      && ['playing', 'paused'].includes(game?.state);
    mount.hidden = !active;
    root.classList.toggle('bomb-mode', active);
    root.removeAttribute('aria-hidden');
    for (const child of root.children) {
      if (child === mount || child.classList?.contains('sb')) continue;
      if (active) child.setAttribute('aria-hidden', 'true');
      else child.removeAttribute('aria-hidden');
    }
    if (!active) return null;
    // Every frame, ahead of the 20 Hz render throttle — held intent is a per-tick fact,
    // not a presentation detail. Networked matches keep the real wire path untouched.
    if (!networkBomb) driveLocalInteract();
    accumulator += Math.max(0, Number(dt) || 0);
    if (accumulator < LOCAL_RENDER_INTERVAL) return null;
    accumulator %= LOCAL_RENDER_INTERVAL;
    const nowMs = performance.now();
    if (transientUntil && nowMs >= transientUntil) { transient = {}; transientUntil = 0; }
    const sample = networkBomb
      ? buildFacadeBombSample(game, facade, nowMs, transient)
      : buildLocalBombSample(game, nowMs, transient);
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
    destroy() { for (const off of unsubs) off?.(); mount.removeEventListener('click', onClick); mount.remove(); },
  });
}
