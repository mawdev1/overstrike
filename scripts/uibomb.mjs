/**
 * Deterministic acceptance for the isolated P3 Bomb presentation package.
 *
 * Direct Node execution is intentional: this suite proves projection, privacy, timing,
 * semantic markup, and styling invariants without booting WebGL or depending on the not-yet-
 * implemented browser net facade. Visual screenshots remain an integration-stage obligation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { Minimap } from '../src/ui/minimap.js';

import {
  BOMB_FIXTURES,
  BOMB_FIXTURE_CONSTANTS,
  BOMB_FIXTURE_NAMES,
  BOMB_VISUAL_MATRIX,
  SITE_TOKENS,
  TEAM_TOKENS,
  baseBombMatchState,
  buildLocalBombSample,
  projectLocalSiteMarker,
  projectBombPresentation,
  renderBombHudFromFacadeSample,
  renderBombHudHtml,
  resolveManifestCallout,
  sitesFromManifest,
  updateBombHudMount,
} from '../src/ui/bomb/index.js';

let assertions = 0;
const check = (condition, message) => { assert.ok(condition, message); assertions++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const throws = (fn, pattern, message) => { assert.throws(fn, pattern, message); assertions++; };

const { SERVER_NOW, SAMPLED_AT, FRESHNESS_MS } = BOMB_FIXTURE_CONSTANTS;
const baseInput = (overrides = {}) => ({
  matchState: baseBombMatchState(),
  netState: 'live',
  nowMs: SAMPLED_AT,
  freshnessThresholdMs: FRESHNESS_MS,
  netStats: {
    sampledAt: SAMPLED_AT, windowMs: 5_000, rttMs: 32, jitterMs: 3, lossPct: 0,
    snapshotAgeMs: 0, receiveRateHz: 30, baselineState: 'synced',
  },
  bindings: { interact: 'E', spectatePrevious: 'LEFT', spectateNext: 'RIGHT' },
  ...overrides,
});

function model(overrides = {}) { return projectBombPresentation(baseInput(overrides)); }

function expectedFixtureChecks(item, projected) {
  for (const [key, expected] of Object.entries(item.expect)) {
    let actual;
    switch (key) {
      case 'phase': actual = projected.phase; break;
      case 'localRole': actual = projected.localRole; break;
      case 'localCarrier': actual = projected.bomb.isLocalCarrier; break;
      case 'carrierRelationship': actual = projected.bomb.carrierRelationship; break;
      case 'markerVisible': actual = projected.bomb.markerVisible; break;
      case 'progress': actual = projected.interaction.progress; break;
      case 'status': actual = projected.interaction.status; break;
      case 'bombState': actual = projected.bomb.state; break;
      case 'alive': actual = projected.teams.map((team) => team.alive); break;
      case 'spectator': actual = projected.spectator.active; break;
      case 'outcome': actual = projected.outcome?.result; break;
      case 'roles': actual = projected.teams.map((team) => team.role); break;
      case 'roundLabel': actual = projected.roundLabel; break;
      case 'clockStatus': actual = projected.clock.status; break;
      case 'overlay': actual = projected.connection.overlay?.kind; break;
      default: throw new Error(`Unhandled fixture expectation ${key}`);
    }
    if (key === 'status') check(String(actual).startsWith(expected), `${item.name}: ${key}`);
    else equal(actual, expected, `${item.name}: ${key}`);
  }
}

// ── catalogue completeness ───────────────────────────────────────────────────────────

equal(BOMB_FIXTURES.length, 36, 'fixture count is deliberate and reviewable');
equal(new Set(BOMB_FIXTURE_NAMES).size, BOMB_FIXTURE_NAMES.length, 'fixture names are unique');
for (const required of [
  'freeze-attacker', 'freeze-defender', 'carrier-self', 'carrier-teammate', 'carrier-enemy-visible',
  'bomb-dropped-visible', 'bomb-dropped-hidden',
  'plant-0', 'plant-50', 'plant-99', 'plant-interrupted', 'plant-complete-authoritative',
  'planted-idle', 'defuse-0', 'defuse-50', 'defuse-99', 'defuse-interrupted',
  'defuse-complete-authoritative', 'one-versus-one', 'spectator-eligible',
  'spectator-no-target-hidden-bomb', 'round-won-elimination', 'round-lost-defuse',
  'round-won-detonation', 'round-draw-timer', 'side-switch', 'regulation-round-12',
  'degraded-estimating', 'stale-syncing', 'reconnecting-indeterminate',
  'reconnecting-measured', 'grace-expired', 'match-aborted', 'protocol-mismatch',
]) check(BOMB_FIXTURE_NAMES.includes(required), `fixture matrix includes ${required}`);

for (const item of BOMB_FIXTURES) {
  const before = JSON.stringify(item.input.matchState);
  const projected = projectBombPresentation(item.input);
  check(Object.isFrozen(projected), `${item.name}: top-level projection is immutable`);
  check(Object.isFrozen(projected.bomb), `${item.name}: bomb projection is immutable`);
  check(Object.isFrozen(projected.teams), `${item.name}: team projection is immutable`);
  equal(JSON.stringify(item.input.matchState), before, `${item.name}: source snapshot is not mutated`);
  equal(projected.mode, 'bomb', `${item.name}: mode remains Bomb`);
  equal(projected.mapId, 'the-square', `${item.name}: map remains The Square`);
  equal(projected.mapVersion, '1.0.0', `${item.name}: map version remains visible`);
  equal(projected.rulesetVersion, 'bomb-1.0.0', `${item.name}: ruleset version remains visible`);
  equal(projected.series.overtime, false, `${item.name}: Alpha does not invent overtime`);
  equal(projected.sites.map((site) => site.id), ['site-A', 'site-B'], `${item.name}: stable site IDs survive`);
  expectedFixtureChecks(item, projected);

  const html = renderBombHudHtml(projected);
  check(html.startsWith('<section class="bomb-hud"'), `${item.name}: semantic HUD root renders`);
  check(html.includes('aria-label="Bomb match status"'), `${item.name}: HUD has accessible name`);
  check(html.includes('ALPHA') && html.includes('BRAVO'), `${item.name}: team text never relies on colour`);
  check(html.includes('SITE A') && html.includes('SITE B'), `${item.name}: site text never relies on colour`);
  check(!/fake.?ping/i.test(html), `${item.name}: no synthetic ping is presented`);
  check(!/\son[a-z]+=/i.test(html), `${item.name}: generated markup contains no inline event handlers`);
}

// ── clock authority and staleness ─────────────────────────────────────────────────────

const atSample = model();
equal(atSample.clock.remainingMs, 105_000, 'clock starts from phaseEndsAt - serverNow');
equal(atSample.clock.text, '1:45', 'clock formatting rounds up display seconds');
equal(atSample.clock.status, 'authoritative', 'fresh receipt is authoritative');

const aged = model({ nowMs: SAMPLED_AT + 500, netStats: { sampledAt: SAMPLED_AT + 500, windowMs: 5_000, snapshotAgeMs: 500 } });
equal(aged.clock.remainingMs, 104_500, 'fresh clock ages only by client-monotonic sample age');
equal(aged.clock.status, 'estimating', 'aged-but-fresh clock is labelled estimating');
check(renderBombHudHtml(aged).includes('bomb-clock__status">ESTIMATING'), 'estimating clock state is visible, not color-only');

const staleA = model({ nowMs: SAMPLED_AT + 5_000, netStats: { sampledAt: SAMPLED_AT + 5_000, windowMs: 5_000, snapshotAgeMs: 5_000 } });
const staleB = model({ nowMs: SAMPLED_AT + 50_000, netStats: { sampledAt: SAMPLED_AT + 50_000, windowMs: 5_000, snapshotAgeMs: 50_000 } });
equal(staleA.clock.status, 'syncing', 'freshness threshold enters syncing');
equal(staleA.clock.remainingMs, 104_250, 'stale clock freezes at the contracted threshold');
equal(staleB.clock.remainingMs, staleA.clock.remainingMs, 'stale clock never client-completes as local time advances');

const reusedStatsA = model({ nowMs: SAMPLED_AT, netStats: { sampledAt: SAMPLED_AT, windowMs: 5_000, snapshotAgeMs: 0 } });
const reusedStatsB = model({ nowMs: SAMPLED_AT + 5_000, netStats: { sampledAt: SAMPLED_AT, windowMs: 5_000, snapshotAgeMs: 0 } });
equal(reusedStatsB.clock.status, 'syncing', 'a reused net-stats sample becomes stale as client time advances');
equal(reusedStatsB.clock.remainingMs, reusedStatsA.clock.remainingMs - FRESHNESS_MS,
  'a reused freshness sample advances only to the cutoff and then freezes');

const unknownFreshnessA = model({ nowMs: SAMPLED_AT + 10_000, netStats: null });
const unknownFreshnessB = model({ nowMs: SAMPLED_AT + 50_000, netStats: null });
equal(unknownFreshnessA.clock.status, 'syncing', 'unknown freshness is visibly syncing');
equal(unknownFreshnessA.clock.remainingMs, 105_000, 'unknown freshness freezes at the authoritative sample');
equal(unknownFreshnessB.clock.remainingMs, unknownFreshnessA.clock.remainingMs, 'unknown freshness never advances locally');

const oldStateHealthySnapshots = model({ nowMs: SAMPLED_AT + 30_000, netStats: { sampledAt: SAMPLED_AT + 29_990, windowMs: 5_000, snapshotAgeMs: 10 } });
equal(oldStateHealthySnapshots.clock.remainingMs, 75_000, 'old change-only matchState continues aging while measured snapshots are healthy');
equal(oldStateHealthySnapshots.clock.status, 'estimating', 'healthy snapshot flow does not become stale from matchState age');

const crossDomain = model({ matchState: baseBombMatchState({ serverNow: 4_000_000_000, phaseEndsAt: 4_000_040_000, sampledAt: 12 }) , nowMs: 512 });
equal(crossDomain.clock.remainingMs, 39_500, 'server and client clock domains are subtracted only within domain');
const noDeadline = model({ matchState: baseBombMatchState({ phaseEndsAt: null }) });
equal(noDeadline.clock.status, 'unavailable', 'null authoritative deadline never becomes a guessed timer');
equal(noDeadline.clock.text, '--:--', 'unknown time has explicit unavailable copy');
throws(() => projectBombPresentation({ matchState: baseBombMatchState(), nowMs: SAMPLED_AT }), /freshnessThresholdMs/, 'freshness policy cannot be omitted');
throws(() => model({ nowMs: Number.NaN }), /nowMs/, 'non-finite client clock is rejected');

// ── progress authority, refusals, and outcomes ────────────────────────────────────────

for (const progress of [-3, 0, 0.5, 0.99, 1, 8]) {
  const projected = model({ matchState: baseBombMatchState({ interaction: { kind: 'plant', actorId: 101, progress } }) });
  equal(projected.interaction.progress, Math.min(1, Math.max(0, progress)), `progress ${progress} is safely bounded`);
  const html = renderBombHudHtml(projected);
  check(html.includes('PLANTING'), `progress ${progress} remains an in-progress server state`);
  check(!html.includes('[BOMB PLANTED]'), `progress ${progress} cannot fabricate completion caption`);
}

for (const [reason, label] of [
  [0, 'ACTION NOT AVAILABLE'], [1, 'ROUND ALREADY RESOLVED'], [2, 'ENTER A PLANT ZONE'],
  [3, 'BOMB REQUIRED'], [4, 'BOMB ALREADY PLANTED'],
]) {
  const projected = model({ typedEvent: { type: 'interactionRefused', kind: 'plant', reason } });
  equal(projected.interaction.status, label, `refusal ${reason} maps from closed wire vocabulary`);
}
for (const [reason, detail] of [[0, 'ACTION RELEASED'], [1, 'LEFT OBJECTIVE AREA'], [2, 'ACTOR ELIMINATED'], [3, 'ROUND ENDED']]) {
  const projected = model({ typedEvent: { type: 'defuseCancel', reason } });
  check(projected.interaction.status.includes(detail), `cancel ${reason} maps without backend prose`);
}

for (const [reason, label] of [
  ['elimination', 'TEAM ELIMINATED'], ['defuse', 'BOMB DEFUSED'], ['detonation', 'TARGET DESTROYED'],
  ['timer', 'TIME EXPIRED'], ['forfeit', 'FORFEIT'], ['abandon', 'MATCH ABANDONED'], ['no-contest', 'NO CONTEST'],
]) {
  const round = model({ outcomeEvent: { type: 'roundEnded', winner: 'alpha', reason } });
  equal(round.outcome.reason, label, `${reason} round outcome uses canonical mapping`);
}
equal(model({ outcomeEvent: { type: 'matchEnded', winner: 'alpha', outcomeReason: 'forfeit' } }).outcome.result, 'MATCH WON', 'aborted forfeit may carry a real winner');
equal(model({ outcomeEvent: { type: 'matchEnded', winner: 'draw', outcomeReason: 'timer' } }).outcome.result, 'MATCH DRAW', 'draw is distinct from no winner');
equal(model({ outcomeEvent: { type: 'matchEnded', winner: null, outcomeReason: 'no-contest' } }).outcome.result, 'MATCH ABORTED', 'null winner is not presented as draw');

// ── privacy and anti-ghosting ─────────────────────────────────────────────────────────

const malformedCarried = model({ matchState: baseBombMatchState({ bomb: { state: 'carried', carrierId: 102, position: { x: 91, y: 2, z: -74 } } }) });
equal(malformedCarried.bomb.markerPosition, null, 'carried bomb position is discarded even if supplied');
check(!renderBombHudHtml(malformedCarried).includes('91'), 'malformed carried coordinates never reach markup');

const visibleDrop = model({ matchState: baseBombMatchState({ bomb: { state: 'dropped', carrierId: null, position: { x: 17.25, y: 0, z: -6.5 } } }) });
check(renderBombHudHtml(visibleDrop).includes('17.25'), 'authorized dropped position reaches marker adapter');
const filteredDrop = model({ matchState: baseBombMatchState({ bomb: { state: 'dropped', carrierId: null, position: null } }) });
equal(filteredDrop.bomb.markerPosition, null, 'filtered snapshot removes bomb marker without retained history');
check(!renderBombHudHtml(filteredDrop).includes('17.25'), 'fresh pure render cannot leak a prior marker');

const projectedSites = model({ siteMarkers: [
  { siteId: 'A', distanceM: 18.4, occluded: true, offscreen: true, direction: 'nw' },
  { siteId: 'B', distanceM: 31.6, occluded: false, offscreen: false, direction: 'center' },
] });
equal(projectedSites.sites[0].distanceM, 18.4, 'authorized world adapter distance reaches the Site A projection');
equal(projectedSites.sites[0].occluded, true, 'occlusion is an explicit adapter result');
equal(projectedSites.sites[0].offscreen, true, 'offscreen status is an explicit adapter result');
check(renderBombHudHtml(projectedSites).includes('18 M · NW'), 'offscreen site marker carries truthful distance and direction text');
check(renderBombHudHtml(projectedSites).includes('bomb-site--occluded'), 'occluded marker has a shape treatment, not color alone');
const hostileSites = model({ siteMarkers: [{ siteId: 'A', distanceM: -5, occluded: 'yes', offscreen: true, direction: 'secret-enemy' }] });
equal(hostileSites.sites[0].distanceM, null, 'invalid marker distance fails closed');
equal(hostileSites.sites[0].direction, null, 'unknown marker direction fails closed');

const hiddenCarrier = model({ matchState: baseBombMatchState({ bomb: { state: 'carried', carrierId: null, position: null } }) });
equal(hiddenCarrier.bomb.carrierVisible, false, 'null carrier is treated as filtered, not reconstructed');
check(!renderBombHudHtml(hiddenCarrier).includes('TEAM CARRIER'), 'hidden carrier has no fallback identity');

const defenderVisibleCarrier = model({ matchState: baseBombMatchState({
  localPlayer: { entityId: 202, team: 'bravo', role: 'defender' },
}) });
equal(defenderVisibleCarrier.bomb.carrierRelationship, 'enemy', 'authorized defender LOS identifies the carrier relationship without identity');
check(renderBombHudHtml(defenderVisibleCarrier).includes('ENEMY BOMB CARRIER VISIBLE'), 'defender is never told an enemy carrier is a teammate');
check(!renderBombHudHtml(defenderVisibleCarrier).includes('TEAMMATE HAS'), 'enemy carrier copy cannot imply teammate ownership');

const teammatePlant = model({ matchState: baseBombMatchState({ interaction: { kind: 'plant', actorId: 102, progress: 0.87 } }) });
equal(teammatePlant.interaction.progress, null, 'non-local interaction progress is removed from the presentation model');
check(!renderBombHudHtml(teammatePlant).includes('87%'), 'non-local interaction progress cannot reach markup');

const delayedPlant = model({
  matchState: baseBombMatchState({ interaction: { kind: 'plant', actorId: 101, progress: 0.5 } }),
  nowMs: SAMPLED_AT + 500,
  netStats: { sampledAt: SAMPLED_AT + 500, windowMs: 5_000, snapshotAgeMs: 500 },
});
equal(delayedPlant.interaction.stateWord, 'PLANTING — ESTIMATING', 'delayed progress is visibly marked estimating without being extrapolated');

const spectatorNoTarget = model({ matchState: baseBombMatchState({
  bomb: { state: 'dropped', carrierId: null, position: null },
  localPlayer: { alive: false, isSpectating: true, spectatingId: null, spectatorPolicy: { canSpectateEnemies: false, canFreeCam: false, canUseTeamChat: false } },
}) });
equal(spectatorNoTarget.spectator.targetLabel, 'NO ELIGIBLE TARGET', 'no-target spectator state is explicit');
equal(spectatorNoTarget.spectator.canCycle, false, 'cycling is unavailable without an authorized target');
check(renderBombHudHtml(spectatorNoTarget).includes('TEAM CHAT HELD UNTIL FREEZE'), 'live dead-player chat restriction is visible');

for (const cue of ['bombAssigned', 'bombDropped', 'bombPickedUp', 'plantStart', 'plantComplete', 'plantCancel', 'defuseStart', 'defuseComplete', 'defuseCancel', 'bombDetonated', 'sideSwitch', 'roundWon', 'roundLost', 'roundDraw']) {
  const projected = model({ cue: { type: cue, raw: '<img src=x onerror=alert(1)>' } });
  check(projected.caption?.text.startsWith('['), `${cue} has an allowlisted caption`);
  check(!renderBombHudHtml(projected).includes('onerror'), `${cue} ignores non-contract cue prose`);
}
equal(model({ cue: { type: 'enemySecret', text: 'ENEMY AT B' } }).caption, null, 'unknown cues cannot disclose arbitrary information');

// ── connection, measured data, and overlays ──────────────────────────────────────────

const measured = model({ netStats: {
  sampledAt: SAMPLED_AT, windowMs: 5000, rttMs: 42, jitterMs: 4, lossPct: 1.25,
  snapshotAgeMs: 33, receiveRateHz: 30, baselineState: 'synced',
} });
equal(measured.connection.stats.rttMs, 42, 'measured RTT passes through');
check(renderBombHudHtml(measured).includes('42 MS RTT'), 'measured RTT is labelled');
equal(model({ netStats: { rttMs: 42 } }).connection.stats, null, 'unwindowed plausible metrics are not displayed');
equal(model({ netStats: { sampledAt: SAMPLED_AT, windowMs: 5000, rttMs: 50000 } }).connection.stats.rttMs, null, 'out-of-contract metrics are dropped rather than made plausible by clamping');
check(!renderBombHudHtml(model({ netStats: null })).includes('MS RTT'), 'missing measured data never becomes fake ping');

const reconnecting = model({ netState: 'reconnecting', reconnect: { graceEndsAt: SAMPLED_AT + 11_000, attempt: 2, maxAttempts: 5, canCancel: true } });
equal(reconnecting.connection.overlay.graceMs, 11_000, 'reconnect uses authoritative converted client-monotonic deadline');
const reconnectHtml = renderBombHudHtml(reconnecting);
check(reconnectHtml.includes('role="alertdialog"'), 'reconnect veil is a labelled blocking dialog');
check(reconnectHtml.includes('data-bomb-action="cancel-connection"'), 'contract-permitted reconnect cancel is native button');
check(reconnectHtml.includes('ATTEMPT 2/5'), 'actual reconnect attempt count is shown');
check(reconnectHtml.includes('11 S REMAINING'), 'actual reconnect grace is shown');

const indeterminate = model({ netState: 'reconnecting', reconnect: null });
equal(indeterminate.connection.overlay.graceMs, null, 'missing reconnect update remains indeterminate');
check(!renderBombHudHtml(indeterminate).includes('REMAINING'), 'indeterminate reconnect does not guess a countdown');
for (const [state, title] of [['version-mismatch', 'UPDATE REQUIRED'], ['rejected', 'MATCH CONNECTION REFUSED'], ['closed', 'MATCH CONNECTION CLOSED']]) {
  const projected = model({ netState: state });
  equal(projected.connection.overlay.title, title, `${state} has terminal canonical presentation`);
}

// ── Alpha rules and malformed input fail closed ───────────────────────────────────────

const overtime = model({ matchState: baseBombMatchState({ series: { overtime: true } }) });
equal(overtime.ruleViolation, 'UNAPPROVED OVERTIME STATE', 'Alpha cannot silently render an invented overtime format');
check(renderBombHudHtml(overtime).includes('role="alert"'), 'invalid ruleset is exposed as terminal contract error');
const wrongMode = model({ matchState: baseBombMatchState({ mode: 'tdm' }) });
equal(wrongMode.ruleViolation, 'BOMB HUD RECEIVED A NON-BOMB MATCH', 'Bomb component refuses a TDM state');
const invalidState = model({ matchState: { mode: 'bomb' } });
equal(invalidState.ruleViolation, 'UNRECOGNIZED BOMB PHASE', 'unknown phase fails closed with a contract error');
equal(invalidState.clock.status, 'unavailable', 'malformed state has no invented clock');
equal(invalidState.bomb.markerVisible, false, 'malformed state has no invented bomb location');
equal(invalidState.sites.length, 0, 'malformed state has no invented sites');
const missingScores = model({ matchState: baseBombMatchState({ teams: null }) });
equal(missingScores.ruleViolation, 'INVALID OR MISSING BOMB SCORE', 'missing authoritative team scores fail closed');
equal(missingScores.teams.map((team) => team.score), [null, null], 'missing scores never become a synthetic zero-zero series');
const missingScoreHtml = renderBombHudHtml(missingScores);
check(missingScoreHtml.includes('score unavailable') && !missingScoreHtml.includes('ALPHA 0'),
  'visual and screen-reader score projections remain explicitly unavailable');

const spectatorRadar = Object.create(Minimap.prototype);
spectatorRadar.contacts = new Map([[42, { x: 7, z: -2, t: 0, life: 3 }]]);
spectatorRadar.game = {
  match: { modeId: 'bomb' },
  player: { id: 1, team: 0, alive: false },
};
spectatorRadar._onShot({ shooter: { id: 2, team: 1, position: { x: 21, z: -7 } } });
equal(spectatorRadar.contacts.size, 0, 'Bomb elimination purges retained hostile radar contacts and rejects later shots');
spectatorRadar.game.player.alive = true;
spectatorRadar.game.match.bombRules = { isAlive: () => false };
spectatorRadar.contacts.set(42, { x: 7, z: -2, t: 0, life: 3 });
spectatorRadar._onShot({ shooter: { id: 2, team: 1, position: { x: 21, z: -7 } } });
equal(spectatorRadar.contacts.size, 0,
  'Bomb referee elimination remains private even if another subsystem revives the entity flag');
spectatorRadar.game.match.modeId = 'tdm';
spectatorRadar.game.player.alive = true;
spectatorRadar._onShot({ shooter: { id: 2, team: 1, position: { x: 21, z: -7 } } });
equal(spectatorRadar.contacts.get(2)?.x, 21, 'TDM radar behavior remains intact after the Bomb privacy gate');

// ── local-practice referee and The Square projection ─────────────────────────────────

const localManifest = Object.freeze({
  mapId: 'the-square',
  mapVersion: '1.0.0',
  objectives: Object.freeze([
    Object.freeze({ id: 'site-A', kind: 'plant', site: 'A', box: Object.freeze({ min: Object.freeze({ x: 7, y: 0, z: -13 }), max: Object.freeze({ x: 9, y: 2, z: -11 }) }) }),
    Object.freeze({ id: 'site-B', kind: 'plant', site: 'B', box: Object.freeze({ min: Object.freeze({ x: -13, y: 0, z: 9 }), max: Object.freeze({ x: -11, y: 2, z: 11 }) }) }),
  ]),
  callouts: Object.freeze([
    Object.freeze({ id: 'district', name: 'District', priority: -100, box: Object.freeze({ min: Object.freeze({ x: -50, y: -5, z: -50 }), max: Object.freeze({ x: 50, y: 10, z: 50 }) }) }),
    Object.freeze({ id: 'archive', name: 'Archive Court', priority: 20, box: Object.freeze({ min: Object.freeze({ x: 5, y: -1, z: -15 }), max: Object.freeze({ x: 12, y: 5, z: -5 }) }) }),
    Object.freeze({ id: 'tunnel', name: 'Service Tunnel', priority: 20, box: Object.freeze({ min: Object.freeze({ x: -15, y: -1, z: 5 }), max: Object.freeze({ x: -5, y: 5, z: 15 }) }) }),
  ]),
});

const localEntities = new Map();
const localPlayer = {
  id: 101, team: 0, alive: true, yaw: 0, position: { x: 0, y: 0, z: 0 },
  getEyePosition(out) { return out.set(0, 1.62, 0); },
};
const localCarrier = { id: 102, team: 0, alive: true, position: { x: 3, y: 0, z: -2 } };
localEntities.set(localPlayer.id, localPlayer);
localEntities.set(localCarrier.id, localCarrier);
const localGame = {
  state: 'playing',
  player: localPlayer,
  world: { manifest: localManifest, mapId: 'the-square', mapVersion: '1.0.0', losClear: () => true },
  match: {
    modeId: 'bomb', mode: { roundsToWin: 7, maxRounds: 12 }, mapManifest: localManifest,
    scores: [2, 1], roundPhase: 'live', phaseRemainingMs: 105_000, roundIndex: 3,
    aliveCounts: { alpha: 5, bravo: 5 }, attackingTeam: 0, sideSwitched: false,
    bomb: { state: 'carried', carrierId: 101, siteId: null, position: { x: 0, y: 0, z: 0 } },
    interaction: { kind: 'none', actorId: 0, progress: 0 },
    bombRules: { isAlive: (entity) => entity?.alive === true, canFreeCam: () => false },
  },
  settings: { get: (key) => key === 'hudScale' ? 1 : key === 'binds' ? { KeyE: 'interact', ArrowLeft: 'spectatePrevious', ArrowRight: 'spectateNext' } : null },
  entityById: (id) => localEntities.get(id) || null,
};

equal(resolveManifestCallout(localManifest, { x: 8, y: 1, z: -12 }), 'Archive Court', 'manifest callout priority supplies exact local label');
equal(resolveManifestCallout(localManifest, { x: 0, y: 0, z: 0 }), 'District', 'manifest catch-all is used without a fabricated label');
const localSites = sitesFromManifest(localManifest);
equal(localSites.map((site) => [site.id, site.site, site.callout]), [
  ['site-A', 'A', 'Archive Court'], ['site-B', 'B', 'Service Tunnel'],
], 'local objectives preserve manifest identity and callout text');
const siteAProjection = projectLocalSiteMarker(localGame, localSites[0]);
check(siteAProjection.distanceM > 14 && siteAProjection.distanceM < 15, 'local site distance comes from current player and manifest center');
equal(siteAProjection.direction, 'ne', 'local site direction is player-relative');
equal(siteAProjection.occluded, false, 'local site marker records the actual LOS result');

const localSample = buildLocalBombSample(localGame, 50_000);
equal(localSample.localAuthority, true, 'local sample identifies the in-process authoritative referee');
equal(localSample.matchState.bomb.position, null, 'carried bomb coordinates never escape the local privacy adapter');
equal(localSample.matchState.sites.map((site) => site.id), ['site-A', 'site-B'], 'local sample uses manifest site IDs');
equal(localSample.siteMarkers.length, 2, 'local sample projects both public sites');
const localProjected = projectBombPresentation(localSample);
equal(localProjected.connection.state, 'local', 'local practice is distinguished from a synthetic network connection');
equal(localProjected.connection.label, 'LOCAL PRACTICE', 'local practice never fabricates RTT or server status');
equal(localProjected.clock.status, 'authoritative', 'local referee clock requires no network freshness guess');
check(renderBombHudHtml(localProjected).includes('--bomb-marker-x:'), 'local world-space objectives render at projected screen positions');
check(renderBombHudHtml(localProjected).includes('aria-hidden="true"'), 'duplicate world marker visuals stay outside the accessibility tree');

localPlayer.team = 1;
localGame.match.bomb = { state: 'carried', carrierId: 102, siteId: null, position: { x: 3, y: 0, z: -2 } };
localGame.world.losClear = () => false;
const hiddenLocalCarrier = buildLocalBombSample(localGame, 50_100);
equal(hiddenLocalCarrier.matchState.bomb.carrierId, null, 'defender local view filters a carried bomb without current LOS');
equal(hiddenLocalCarrier.matchState.bomb.position, null, 'defender local view never discloses carried coordinates');
localGame.match.bomb = { state: 'dropped', carrierId: null, siteId: null, position: { x: 3, y: 0, z: -2 } };
equal(buildLocalBombSample(localGame, 50_200).matchState.bomb.position, null, 'defender local view filters an occluded dropped bomb');
localGame.match.bomb = { state: 'planted', carrierId: null, siteId: 'A', position: { x: 8, y: 0, z: -12 } };
check(buildLocalBombSample(localGame, 50_300).matchState.bomb.position !== null, 'planted location remains public to defenders');
localPlayer.team = 0;
localGame.world.losClear = () => true;
localGame.match.bomb = { state: 'carried', carrierId: 101, siteId: null, position: { x: 0, y: 0, z: 0 } };

// ── escaping and semantic accessibility ──────────────────────────────────────────────

const hostile = model({ matchState: baseBombMatchState({
  sites: [{ id: 'site-A', site: 'A', callout: '<script>alert(1)</script>', center: { x: 0, y: 0, z: 0 }, box: { min: {}, max: {} } }],
}) });
const hostileHtml = renderBombHudHtml(hostile);
check(!hostileHtml.includes('<script>'), 'contract strings are HTML-escaped');
check(hostileHtml.includes('&lt;script&gt;'), 'escaped copy remains inspectable');
check(!/aria-hidden="true"[^>]*class="bomb-hud"/.test(hostileHtml), 'essential HUD root is not hidden from assistive technology');

const plantingHtml = renderBombHudHtml(model({ matchState: baseBombMatchState({ interaction: { kind: 'plant', actorId: 101, progress: 0.5 } }) }));
check(plantingHtml.includes('<progress max="1" value="0.5"'), 'objective progress uses a native semantic element');
check(plantingHtml.includes('aria-valuetext="50 percent, PLANTING"'), 'progress includes state word and numeric value');
check(plantingHtml.includes('<kbd>E</kbd>'), 'interaction prompt resolves current binding');
check(!plantingHtml.includes('aria-live="assertive"') || plantingHtml.includes('bomb-outcome'), 'high-frequency progress is never assertively announced');

const spectatingHtml = renderBombHudHtml(model({ matchState: baseBombMatchState({ localPlayer: { alive: false, isSpectating: true, spectatingId: 102 } }) }));
check(spectatingHtml.includes('<kbd>LEFT</kbd>') && spectatingHtml.includes('<kbd>RIGHT</kbd>'), 'spectator prompts resolve both current bindings');
check(spectatingHtml.includes('SPECTATING'), 'spectator state includes text, not color alone');
check(renderBombHudHtml(model()).includes('▲') && renderBombHudHtml(model()).includes('═'), 'team identities include stable shapes');
check(renderBombHudHtml(model()).includes('▣'), 'Site B includes double-bar square token');

for (const hudScale of [10, 70, 100, 160, 300]) {
  const projected = model({ preferences: { hudScale, reduceMotion: true, colorVisionPreset: 'deuteranopia' } });
  equal(projected.preferences.hudScale, Math.min(160, Math.max(70, hudScale)), `HUD scale ${hudScale} clamps to supported range`);
  const html = renderBombHudHtml(projected);
  check(html.includes('data-reduce-motion="true"'), `HUD scale ${hudScale}: reduced motion is explicit`);
  check(html.includes('data-color-vision="deuteranopia"'), `HUD scale ${hudScale}: color-vision preset is explicit`);
}

equal(BOMB_VISUAL_MATRIX.viewports.map((v) => `${v.width}x${v.height}`), ['1280x720', '1920x1080', '2560x1080'], 'visual viewport matrix is exact');
equal(BOMB_VISUAL_MATRIX.hudScales, [70, 100, 160], 'all required HUD scales are enumerated');
check(BOMB_VISUAL_MATRIX.browserZoomPct.includes(200), '200% browser zoom is an explicit visual target');
check(BOMB_VISUAL_MATRIX.colorVisionPresets.includes('grayscale'), 'grayscale simulation is an explicit visual target');
equal(BOMB_VISUAL_MATRIX.reducedMotion, [false, true], 'motion matrix covers both states');

// ── CSS evidence and contrast ─────────────────────────────────────────────────────────

const css = readFileSync(new URL('../src/ui/bomb/bomb.css', import.meta.url), 'utf8');
check(css.includes('font: 700 calc(16px * var(--bomb-hud-scale, 1))'), 'essential HUD base is 16 CSS px at 100%');
check(css.includes('@media (prefers-reduced-motion: reduce)'), 'OS reduced-motion preference is honored');
check(css.includes('[data-reduce-motion="true"]'), 'saved reduced-motion preference is honored');
check(css.includes('@media (forced-colors: active)'), 'forced-colors mode has a dedicated treatment');
check(css.includes(':focus-visible') && css.includes('outline: 3px'), 'keyboard focus has a strong visible ring');
check(!css.includes('outline: none'), 'CSS never globally removes focus indication');
check(!/animation[^;]*infinite/i.test(css), 'HUD has no looping animation');
check(css.includes('@media (max-width: 720px)'), 'narrow/zoomed layout collapses secondary decoration');

function rgb(hex) {
  const raw = Number.parseInt(hex.slice(1), 16);
  return [(raw >> 16) & 255, (raw >> 8) & 255, raw & 255];
}
function luminance(hex) {
  const values = rgb(hex).map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}
for (const [name, foreground, minimum] of [
  ['text', '#f7fbf8', 4.5], ['muted text', '#c3d0cc', 4.5],
  ['Alpha token', '#86ddd3', 3], ['Bravo token', '#ffd07d', 3], ['focus', '#fff29b', 3],
]) check(contrast(foreground, '#122427') >= minimum, `${name} static panel contrast meets ${minimum}:1`);

// ── public boundary and integration helpers ───────────────────────────────────────────

equal(TEAM_TOKENS.alpha.shape, 'up-chevron', 'Alpha shape token is stable');
equal(TEAM_TOKENS.bravo.shape, 'split-bar', 'Bravo shape token is stable');
equal(SITE_TOKENS.A.shape, 'solid-triangle', 'Site A shape token is stable');
equal(SITE_TOKENS.B.shape, 'double-bar-square', 'Site B shape token is stable');
equal(renderBombHudFromFacadeSample(baseInput()), renderBombHudHtml(model()), 'facade-sample convenience path is exact');

const mount = { innerHTML: '', querySelector: (selector) => selector === '[role="alertdialog"]' ? 'dialog' : null };
equal(updateBombHudMount(mount, reconnecting), 'dialog', 'mount helper returns newly rendered reconnect dialog for focus handoff');
check(mount.innerHTML.includes('RECONNECTING'), 'mount helper replaces its isolated mount');
throws(() => updateBombHudMount(null, model()), /mount element/, 'mount helper rejects an absent root');
throws(() => renderBombHudHtml({ version: 999 }), /presentation v1/, 'view rejects incompatible projection version');

// The package is intentionally isolated: no imports from simulation, net internals, global
// HUD, or dirty P2 presentation files.
for (const file of ['model.js', 'view.js', 'fixtures.js', 'local.js', 'index.js']) {
  const source = readFileSync(new URL(`../src/ui/bomb/${file}`, import.meta.url), 'utf8');
  check(!/from ['"]\.\.\/(?:\.\.\/)*(?:net|game|core|world|hud|menu|scoreboard)/.test(source), `${file} has no forbidden integration reach-through`);
}
const hudSource = readFileSync(new URL('../src/ui/hud.js', import.meta.url), 'utf8');
const scoreboardSource = readFileSync(new URL('../src/ui/scoreboard.js', import.meta.url), 'utf8');
check(!/root\.setAttribute\(['"]aria-hidden['"],\s*['"]true['"]\)/.test(hudSource),
  'the shared HUD root is never globally removed from the accessibility tree');
check(scoreboardSource.includes("setAttribute('role', 'table')")
  && scoreboardSource.includes("setAttribute('role', 'columnheader')")
  && scoreboardSource.includes("setAttribute('role', 'cell')"),
  'the real scoreboard exposes table-equivalent roles rather than visual divs only');

// ── real-browser visual matrix ──────────────────────────────────────────────────────

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  for (const viewport of BOMB_VISUAL_MATRIX.viewports) {
    for (const hudScale of BOMB_VISUAL_MATRIX.hudScales) {
      for (const zoomPct of BOMB_VISUAL_MATRIX.browserZoomPct) {
        await page.setViewportSize({
          width: Math.floor(viewport.width * 100 / zoomPct),
          height: Math.floor(viewport.height * 100 / zoomPct),
        });
        for (const colorVisionPreset of BOMB_VISUAL_MATRIX.colorVisionPresets) {
          for (const reduceMotion of BOMB_VISUAL_MATRIX.reducedMotion) {
            await page.emulateMedia({ reducedMotion: reduceMotion ? 'reduce' : 'no-preference' });
            const projected = model({ preferences: { hudScale, colorVisionPreset, reduceMotion } });
            await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style><main>${renderBombHudHtml(projected)}</main>`);
            const layout = await page.evaluate(() => ({
              horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              mainCount: document.querySelectorAll('main').length,
              hudCount: document.querySelectorAll('.bomb-hud[aria-label="Bomb match status"]').length,
              teamText: document.body.innerText.includes('ALPHA') && document.body.innerText.includes('BRAVO'),
            }));
            const label = `${viewport.width}x${viewport.height}/${hudScale}%/${zoomPct}%/${colorVisionPreset}/${reduceMotion ? 'reduced' : 'motion'}`;
            check(layout.horizontalOverflow <= 1, `${label}: no horizontal action/status loss`);
            equal(layout.mainCount, 1, `${label}: one main landmark`);
            equal(layout.hudCount, 1, `${label}: one named Bomb HUD`);
            check(layout.teamText, `${label}: color-independent team text remains visible`);
            const pixels = await page.screenshot({ type: 'png' });
            check(pixels.byteLength > 1_000, `${label}: browser rendered a non-empty visual snapshot`);
          }
        }
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style><main><div id="hud"><div class="legacy" aria-hidden="true">LEGACY CLOCK</div>${renderBombHudHtml(localProjected)}</div></main>`);
  const localLayout = await page.evaluate(() => ({
    legacyHidden: document.querySelector('.legacy')?.getAttribute('aria-hidden'),
    semanticHudHidden: document.querySelector('.bomb-hud')?.getAttribute('aria-hidden'),
    markers: [...document.querySelectorAll('.bomb-world-marker')].map((marker) => {
      const rect = marker.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    }),
    markersDecorative: document.querySelector('.bomb-world-markers')?.getAttribute('aria-hidden'),
  }));
  equal(localLayout.legacyHidden, 'true', 'browser integration hides legacy decorative HUD semantics');
  equal(localLayout.semanticHudHidden, null, 'browser integration keeps the Bomb semantic subtree exposed');
  equal(localLayout.markersDecorative, 'true', 'world markers do not duplicate semantic objective announcements');
  equal(localLayout.markers.length, 2, 'browser integration renders both Square objective markers');
  for (const [index, rect] of localLayout.markers.entries()) {
    check(rect.left >= 0 && rect.top >= 0 && rect.right <= 1280 && rect.bottom <= 720,
      `browser integration keeps site marker ${index + 1} inside the safe viewport`);
  }
  equal(browserErrors, [], 'visual matrix has no browser page errors');
} finally {
  await browser.close();
}

console.log(`Bomb presentation acceptance passed (${assertions} assertions, ${BOMB_FIXTURES.length} deterministic fixtures).`);
