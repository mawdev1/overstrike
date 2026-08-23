/** Executable acceptance for Contract 6 and the authoritative Bomb input seam. */
import { EventBus } from '../src/core/events.js';
import { advancesLocalReferee } from '../src/core/refereeAuthority.js';
import { NetFacade, spectatorPolicyFor } from '../src/net/facade.js';
import { GameServer } from '../src/net/server.js';
import { F_ALIVE, MSG_LOADOUT, PROTOCOL_VERSION, packInteract,
  encodeHello, decodeHello, encodeTacticalPingIntent, decodeTacticalPingEvent } from '../src/net/protocol.js';
import { issueMatchTicket } from '../platform/src/modules/lobby/index.js';
import { createMatchTicketVerifier } from '../server/tickets.js';

let checks = 0;
let failures = 0;
function expect(condition, name, detail = '') {
  checks++;
  if (condition) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const equal = (actual, wanted, name) => expect(
  Object.is(actual, wanted), name, `expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`,
);

const MATCH_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ROOM_ID = '01BX5ZZKBKACTAV9WEVGEMMVS0';
function handoff(ticket = 'ticket-first') {
  return {
    matchId: MATCH_ID,
    serverUrl: 'ws://127.0.0.1:9999/match',
    sessionTicket: ticket,
    expiresAt: '2026-08-20T20:01:00.000Z',
    reconnectGraceMs: 30_000,
    mapId: 'the-square', mapVersion: '1.0.0', mode: 'bomb', rulesetVersion: 'bomb-1.0.0',
    region: 'yyz', serverBuild: 'test-build', protocolVersion: PROTOCOL_VERSION,
    spectatorPolicyVersion: 1,
    series: { roundsToWin: 7, maxRounds: 12, sideSwitchAfter: 6, overtime: false },
    sites: [
      { id: 'site-A', site: 'A', callout: 'Fountain', center: { x: 1, y: 0, z: 2 }, box: { min: {}, max: {} } },
      { id: 'site-B', site: 'B', callout: 'Market', center: { x: 8, y: 0, z: 9 }, box: { min: {}, max: {} } },
    ],
  };
}

console.log('\n── real platform ticket crosses the frozen hello boundary');
const ticketSecret = 'facade-acceptance-secret-32-bytes';
const platformTicket = issueMatchTicket(ticketSecret, {
  jti: '01HZXJ4B8QXQ9P7HZJKM6V5F4E', sub: '01HZXJ4B8QXQ9P7HZJKM6V5F4F',
  roomId: ROOM_ID, matchId: MATCH_ID, exp: Date.now() + 60_000,
  mode: 'bomb', team: 'alpha', primaryIdx: 0, secondaryIdx: 0,
});
const hello = decodeHello(encodeHello(PROTOCOL_VERSION, platformTicket));
const verifiedTicket = createMatchTicketVerifier({ secret: ticketSecret,
  matchId: MATCH_ID, roomId: ROOM_ID })(hello?.ticket);
expect(Buffer.byteLength(platformTicket) <= 255 && hello?.ticket === platformTicket,
  'platform-minted ticket fits and round-trips through the exact HELLO wire frame',
  `${Buffer.byteLength(platformTicket)} bytes`);
expect(verifiedTicket?.matchId === MATCH_ID && verifiedTicket?.roomId === ROOM_ID
  && verifiedTicket?.team === 'alpha' && verifiedTicket?.mode === 'bomb',
  'the dedicated-server verifier accepts the exact ticket decoded from HELLO');

function makeSession({ reconnect = false } = {}) {
  const sent = [];
  const session = {
    connected: true,
    matchState: null,
    net: {
      entityId: 11,
      killLimit: 0,
      welcome: {
        clientId: 3, entityId: 11, matchSeed: 42, killLimit: 0, mode: 'bomb',
        isReconnect: reconnect, isSpectator: false, protocolVersion: PROTOCOL_VERSION,
        serverTickRateHz: 120,
      },
      snapshots: [{ entities: [
        { id: 11, team: 0, flags: F_ALIVE, interact: packInteract('plant', 31) },
        { id: 21, team: 1, flags: F_ALIVE, interact: 0 },
      ] }],
      diagnostics: (at) => ({
        sampledAt: at, windowMs: 5000, rttMs: 34, jitterMs: 3, lossPct: 2,
        snapshotAgeMs: 8, receiveRateHz: 30, baselineState: 'synced', keyframes: 2, discarded: 1,
      }),
    },
    prediction: { correctionSamples: [{ at: 995, error: 0.1 }, { at: 998, error: 0.4 }] },
    remotes: new Map([
      [21, { id: 21, interpolated: true, team: 1, alive: true }],
      [12, { id: 12, interpolated: true, team: 0, alive: true }],
      [13, { id: 13, interpolated: true, team: 0, alive: true }],
    ]),
    updateRemotes() { return this.remotes; },
    transport: { send: (bytes) => sent.push(bytes) },
    requestInteraction(kind) { this.interactionKind = kind; },
    requestTacticalPing(kind) { this.tacticalPingKind = kind; return true; },
    releaseInteraction() { this.interactionKind = null; },
    close() { this.connected = false; },
    sent,
  };
  return session;
}

console.log('\n── live facade projection');
let clock = 1000;
const bus = new EventBus();
const game = { bus, player: { id: 11, predicted: true } };
const sessions = [makeSession(), makeSession({ reconnect: true })];
const connectCalls = [];
let reconnectRequests = 0;
const facade = new NetFacade({
  game,
  clock: () => clock,
  connectSession: async (_game, url, options) => {
    connectCalls.push({ url, options });
    return sessions.shift();
  },
  ticketProvider: async (matchId) => {
    reconnectRequests++;
    return {
      graceEndsAt: '2026-08-20T20:00:30.000Z', serverNow: '2026-08-20T20:00:00.000Z',
      handoff: handoff('fresh-reconnect-ticket'), matchId,
    };
  },
});
const welcomes = [];
const projected = [];
const bombChanges = [];
facade.on('welcome', (payload) => welcomes.push(payload));
facade.on('matchState', (payload) => projected.push(payload));
facade.on('bombStateChanged', (payload) => bombChanges.push(payload));
await facade.connect(handoff());
equal(facade.state, 'live', 'welcome moves facade to live');
equal(connectCalls[0].options.sessionTicket, 'ticket-first', 'session ticket is passed to ticket-first hello path');
equal(welcomes[0].protocolVersion, PROTOCOL_VERSION, 'typed welcome exposes negotiated protocol');
expect(!('sessionTicket' in facade.descriptor), 'immutable descriptor never exposes the ticket');
expect(Object.isFrozen(facade.descriptor) && Object.isFrozen(facade.descriptor.series), 'descriptor is recursively immutable');
equal(facade.localEntity, game.player, 'localEntity is the explicitly predicted player view');
equal(facade.remoteEntities.get(21).interpolated, true, 'remoteEntities comes from interpolation view');

const raw = {
  phase: 'live', roundIndex: 2, localRole: 'attacker', scoreAlpha: 2, scoreBravo: 1,
  phaseRemainingMs: 79_500, aliveAlpha: 4, aliveBravo: 3,
  bombState: 'carried', bombCarrierId: 11, bombSite: null,
  bombPositionVisible: true, bombPosition: { x: 99, y: 99, z: 99 },
  interactActorId: 11, interactProgressFrac: 31 / 63,
  sideSwitched: false, serverTimeMs: 0xfffffff0,
};
bus.emit('matchState', raw);
const state = facade.matchState;
equal(state.matchId, MATCH_ID, 'matchState is joined to immutable match identity');
equal(state.phaseEndsAt, 0xfffffff0 + 79_500, 'phase expiry remains in the server clock domain');
equal(state.bomb.position, null, 'carried bomb never exposes a duplicate world position');
equal(state.interaction.kind, 'plant', 'interaction kind is decoded from authoritative entity wire state');
equal(state.interaction.progress, 31 / 63, 'interaction progress is the unsmoothed server fraction');
equal(state.localPlayer.role, 'attacker', 'local authoritative role is projected');
equal(state.localPlayer.spectatorPolicy.canFreeCam, false, 'live spectator policy is phase-derived');
expect(Object.isFrozen(state) && Object.isFrozen(state.bomb), 'matchState projection is recursively immutable');
equal(bombChanges.length, 1, 'a typed bomb transition fires on authoritative state change');

clock = 1020;
bus.emit('matchState', { ...raw, serverTimeMs: 20, bombState: 'dropped', bombCarrierId: null,
  bombPositionVisible: false, bombPosition: null, interactActorId: null, interactProgressFrac: 0 });
equal(facade.matchState.serverNow, 0xfffffff0 + 36, 'server clock reconstruction crosses u32 wrap exactly');
equal(facade.matchState.bomb.carrierId, null, 'hidden carrier is purged rather than retained');
equal(facade.matchState.bomb.position, null, 'hidden dropped-bomb coordinates are not inferred');

const stats = facade.netStats;
equal(stats.rttMs, 34, 'netStats RTT is measured by NetClient');
equal(stats.correctionMagnitudeM, 0.4, 'netStats correction magnitude is measured p95');
equal(stats.correctionRatePerSec, 0.4, 'netStats correction rate uses the declared five-second window');

facade._session.net.snapshots.at(-1).entities[0].flags = 0;
let spectatorEvent = null;
facade.on('spectatorChanged', (event) => { spectatorEvent = event; });
expect(facade.cycleSpectator(1), 'dead Bomb player can cycle an authoritative teammate target');
equal(facade.matchState.localPlayer.spectatingId, 12, 'spectator target is the first sorted living teammate');
expect(facade.cycleSpectator(-1), 'previous spectator binding cycles backward');
equal(facade.matchState.localPlayer.spectatingId, 13, 'spectator cycling wraps without revealing enemies');
expect(spectatorEvent?.policy?.canSpectateEnemies === false
  && facade.matchState.localPlayer.spectatingId !== 21,
  'facade applies the closed spectator policy before changing target');
facade._session.net.snapshots.at(-1).entities[0].flags = F_ALIVE;
bus.emit('matchState', { ...raw, serverTimeMs: 21 });
equal(facade.matchState.localPlayer.spectatingId, null, 'respawn clears the spectator target');

facade.sendLoadout({ primaryIdx: 7, secondaryIdx: 9 });
const loadout = connectCalls.length && facade._session.sent[0];
equal(new DataView(loadout).getUint8(0), MSG_LOADOUT, 'sendLoadout uses the closed wire message');
equal(new DataView(loadout).getUint8(1), 7, 'sendLoadout preserves primary wire index');
facade.requestInteraction('plant');
equal(facade._session.interactionKind, 'plant', 'requestInteraction records held intent only');
equal(facade.matchState.bomb.state, 'carried', 'interaction request does not mutate objective truth');
facade.releaseInteraction();
equal(facade._session.interactionKind, null, 'releaseInteraction clears held intent');
expect(facade.requestTacticalPing('danger'), 'facade accepts a closed tactical ping kind');
equal(facade._session.tacticalPingKind, 'danger', 'facade forwards only intent, never client coordinates');
expect(!facade.requestTacticalPing('arbitrary'), 'facade rejects an open tactical ping vocabulary');

let safeHandlerRuns = 0;
const realError = console.error;
console.error = () => {};
facade.on('event', () => { throw new Error('widget fault'); });
facade.on('event', () => { safeHandlerRuns++; });
bus.emit('netEvent', { kind: 'fire' });
bus.emit('netEvent', { kind: 'fire' });
console.error = realError;
equal(safeHandlerRuns, 2, 'a throwing subscriber is isolated and removed');

const outcomes = [];
facade.on('matchEnded', (payload) => outcomes.push(payload));
bus.emit('matchOutcome', { matchId: '01ARZ3NDEKTSV4RRFFQ69G5FAW', winnerTeam: 'bravo' });
equal(outcomes.length, 0, 'foreign-match terminal outcomes are ignored');

console.log('\n── reconnect and terminal negotiation');
bus.emit('netDisconnected', { reason: 'socket-closed', code: 1006 });
for (let i = 0; i < 20 && facade.state !== 'live'; i++) await new Promise((resolve) => setTimeout(resolve, 0));
equal(reconnectRequests, 1, 'socket loss obtains one fresh reconnect ticket per attempt');
equal(connectCalls[1].options.sessionTicket, 'fresh-reconnect-ticket', 'reconnect never replays the consumed ticket');
equal(facade.state, 'live', 'valid reconnect returns to live');
equal(welcomes[1].isReconnect, true, 'reconnect emits the typed welcome too');
bus.emit('matchOutcome', { matchId: MATCH_ID, winnerTeam: 'alpha', reason: 'score',
  terminationReason: 'completed', scoreAlpha: 7, scoreBravo: 4, roundsPlayed: 11 });
equal(outcomes[0].outcomeReason, 'score', 'terminal outcome keeps the contract field name');
bus.emit('netDisconnected', { reason: 'authority-released', code: 1001 });
equal(reconnectRequests, 1, 'terminal socket closure never requests a stale reconnect ticket');

const incompatible = new NetFacade({ game, connectSession: async () => makeSession() });
let mismatch = 0;
incompatible.on('versionMismatch', () => mismatch++);
await incompatible.connect({ ...handoff(), protocolVersion: PROTOCOL_VERSION + 1 }).catch(() => {});
equal(incompatible.state, 'version-mismatch', 'protocol mismatch is terminal before socket creation');
equal(mismatch, 1, 'protocol mismatch emits one typed event');
equal(spectatorPolicyFor('roundEnd', false).canUseTeamChat, true, 'round-end policy releases dead-player relay restriction');

console.log('\n── authoritative held Bomb command seam');
const ruleCalls = [];
const rules = {
  // bomb-rules §13.4/§13.10: the referee owns the meaning of the held key — the server
  // asks `interactKindFor(entity)` instead of deriving plant/defuse from a role. This
  // fake mimics "the enemy's plant sits at team 1's home": team 1 defuses, team 0 plants.
  interactKindFor: (entity) => (entity.team === 1 ? 'defuse' : 'plant'),
  requestInteract: (entity, kind) => ruleCalls.push(`request:${entity.id}:${kind}`),
  releaseInteract: (entity) => ruleCalls.push(`release:${entity.id}`),
};
const entity = {
  id: 44, team: 0, alive: true, baseYaw: 0, basePitch: 0,
  _held: {}, _edge: { jump: false, slot: -1, wheel: 0 },
  applyCommand() {}, _writeAngles() {},
};
const server = Object.create(GameServer.prototype);
server.game = { match: { bombRules: rules } };
server.lag = { viewTickFor: () => 0, forget: (id) => ruleCalls.push(`forget:${id}`) };
server.clients = new Map([[1, {}]]);
const serverSession = { id: 1, entity, rttMs: 0, stats: { resyncs: 0 }, transport: { close: () => ruleCalls.push('closed') } };
const command = {
  wishForward: 0, wishRight: 0, crouchHeld: false, toggleAdsMode: false,
  aimButtonHeld: false, fireHeld: false, sprintKeyHeld: false, breathHold: false,
  leanKeyHeld: false, leanRightKeyHeld: false, firePressed: false,
  // `interactHeld` (HELD_BITS bit 8), NOT `interact`. The edge is a tap — it is `true` on one
  // command and `false` on every command after it, so reading it here is what stopped a human
  // from ever completing a plant. The edge is deliberately left set to prove it is ignored.
  interactHeld: true, interact: true,
  baseYaw: 0, basePitch: 0, deltaYaw: 0, deltaPitch: 0,
};
server._applyCommand(serverSession, command);
equal(ruleCalls.at(-1), 'request:44:plant', 'server asks the referee for the held key\'s meaning — a plant here (§13.4)');
entity.team = 1;
server._applyCommand(serverSession, command);
equal(ruleCalls.at(-1), 'request:44:defuse', 'and a defuse for the site owner, from the same seam (§13.4)');
server._applyCommand(serverSession, { ...command, interactHeld: false });
equal(ruleCalls.at(-1), 'release:44', 'released command cancels server progress');
// And the edge on its own — still `true` in `command` — is not a hold and never was.
server._applyCommand(serverSession, { ...command, interactHeld: false, interact: true });
equal(ruleCalls.at(-1), 'release:44', 'the interact EDGE alone does not hold an objective open');
entity._objectiveHeld = true;
server._applyHeldOnly(serverSession);
equal(ruleCalls.at(-1), 'request:44:defuse', 'command-loss tick preserves the last held intent');
server.removeClient(serverSession);
expect(ruleCalls.includes('release:44') && entity._objectiveHeld === false,
  'disconnect releases objective progress and held state');

expect(!advancesLocalReferee({ connected: true }),
  'network prediction advances movement systems but never the shadow referee clock');
expect(advancesLocalReferee(null), 'practice/server fixed step still advances the authoritative referee');

console.log('\n── authoritative tactical ping privacy and rate filter');
expect((() => { try { encodeTacticalPingIntent('admin-marker'); return false; } catch { return true; } })(),
  'direct protocol client cannot coerce an invalid tactical kind to location');
let pingNow = 5000;
const teammateFrames = [];
const enemyFrames = [];
const pingServer = Object.create(GameServer.prototype);
pingServer._clock = () => pingNow;
const pingSender = { entity: { id: 7, team: 0, alive: true,
  position: { x: 4.5, y: 1.2, z: -9.25 } }, authenticated: true, rejected: false,
stats: { tacticalPings: 0, tacticalPingsRateLimited: 0 }, lastTacticalPingAt: -Infinity,
transport: { send() {} } };
const teammate = { entity: { id: 8, team: 0 }, authenticated: true, rejected: false,
  transport: { send: (frame) => teammateFrames.push(frame) } };
const enemy = { entity: { id: 9, team: 1 }, authenticated: true, rejected: false,
  transport: { send: (frame) => enemyFrames.push(frame) } };
pingServer.clients = new Map([[7, pingSender], [8, teammate], [9, enemy]]);
expect(pingServer._applyTacticalPing(pingSender, encodeTacticalPingIntent('objective')),
  'server accepts the first living-player tactical ping');
const authoritativePing = decodeTacticalPingEvent(teammateFrames[0]);
equal(authoritativePing.kind, 'objective', 'server preserves the closed tactical intent kind');
equal(authoritativePing.position.x, 4.5, 'server supplies position from its entity, not the client');
equal(enemyFrames.length, 0, 'enemy team receives no tactical ping frame');
expect(!pingServer._applyTacticalPing(pingSender, encodeTacticalPingIntent('danger')),
  'server rejects a tactical ping inside the rate window');
equal(pingSender.stats.tacticalPingsRateLimited, 1, 'rate rejection is measurable');
pingNow += 1500;
expect(pingServer._applyTacticalPing(pingSender, encodeTacticalPingIntent('danger')),
  'server accepts a tactical ping after the exact rate window');
equal(teammateFrames.length, 2, 'teammate receives each accepted authoritative cue exactly once');

if (failures) {
  console.error(`\nFacade acceptance: FAIL — ${failures}/${checks} checks failed`);
  process.exit(1);
}
console.log(`\nFacade acceptance: PASS — ${checks} checks`);
facade.disconnect('acceptance-complete');
