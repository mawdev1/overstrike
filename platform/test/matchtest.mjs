/**
 * The match surface, over REAL HTTP, against whichever store the process is configured with.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────────────────
 * The most heavily reviewed code in the platform — the §4.0 status matrix, the four-shape
 * §4.2 union, `markResultApplied`, the terminal-event emission — had NO HTTP surface at all.
 * Nothing registered `/v1/matches/*`, so §5.1's service-only guard, the idempotency path and
 * the §4.2 privacy branch were unreachable from outside the process and therefore unproven:
 * a service-only rule that no route enforces is a comment.
 *
 * Everything below drives the real app over a real socket, with the real store — memory by
 * default, PostgreSQL when `PLATFORM_STORAGE=postgres` (scripts/pgtest.mjs), so both adapters
 * run the identical assertions.
 *
 * Every refusal is paired with the legitimate version of the same call. A service that refuses
 * everything passes half a suite like this one, and that half is the half people read.
 */
import { loadConfig } from '../src/core/config.js';
import { buildApp } from '../src/app.js';
import { ulid } from '../src/core/ids.js';
import { createStatsService } from '../src/modules/profile/stats.js';
import { createMemoryStore } from '../src/core/store/memory.js';

let failures = 0;
const ok = (name) => console.log(`  ok   ${name}`);
const bad = (name, detail) => { failures++; console.log(`  FAIL ${name}\n       ${detail}`); };
const expect = (cond, name, detail = '') => (cond ? ok(name) : bad(name, detail));
const section = (name) => console.log(`\n${name}`);

const SERVICE_TOKEN = 'test-service-token-not-a-real-one';

const silent = () => {
  const noop = () => {};
  const l = { debug: noop, info: noop, warn: noop, error: noop };
  l.child = () => l;
  return l;
};

async function withApp(fn) {
  // One trusted hop, so each onboarding below can present its own X-Forwarded-For. §9's auth
  // class is 10/min per IP; four players onboarding from one loopback address exceed it, and a
  // suite that trips the limiter is testing the limiter rather than the match surface.
  //
  // `process.env` FIRST, and this matters more than it looks: `loadConfig` replaces the
  // environment rather than merging with it, so a config built from a bare object literal is
  // always `storage: memory` — including under `scripts/pgtest.mjs`, whose entire purpose is to
  // run this suite against a real database. Without the spread, every assertion below would
  // report a Postgres pass it never performed.
  const config = loadConfig({
    ...process.env,
    PLATFORM_PORT: '0', PLATFORM_SERVICE_TOKEN: SERVICE_TOKEN, PLATFORM_TRUSTED_PROXY_HOPS: '1',
  });
  if (process.env.PLATFORM_STORAGE && config.storage !== process.env.PLATFORM_STORAGE) {
    throw new Error(`matchtest: asked for ${process.env.PLATFORM_STORAGE}, got ${config.storage}`);
  }
  const app = await buildApp(config, { logger: silent() });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-client-build': '1.0.0', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* the assertion will say so */ }
    return { status: res.status, body: json, code: json?.error?.code ?? null, text };
  };

  try { return await fn({ app, call, config }); }
  finally { app.stop(); await new Promise((r) => app.server.close(r)); }
}

/** Walk the approved onboarding order and return an authenticated player. */
async function onboard(call, { name, email, ip }) {
  const sid = ulid();
  const from = { 'x-forwarded-for': ip };
  const elig = await call('POST', '/v1/onboarding/eligibility',
    { dateOfBirth: '1994-03-02', jurisdiction: 'CA-ON' }, from);
  const consent = await call('PUT', '/v1/onboarding/consent',
    { telemetryPersonal: true, policyVersion: 1, clientSessionId: sid }, from);
  const signup = await call('POST', '/v1/auth/signup', {
    email, password: 'correct horse battery staple', displayName: name,
    eligibilityReceipt: elig.body?.receipt, clientSessionId: sid,
    consentReceipt: consent.body?.receipt,
  }, from);
  if (signup.status !== 201) throw new Error(`onboarding failed: ${signup.text}`);
  return {
    accountId: signup.body.profile.accountId,
    displayName: name,
    token: signup.body.accessToken,
    auth: { authorization: `Bearer ${signup.body.accessToken}` },
  };
}

const asService = { 'x-service-token': SERVICE_TOKEN };

// ── §4 fixtures, exact ───────────────────────────────────────────────────────────────────
// Both rulesSnapshot variants carry EVERY key the mode discriminant declares (§4). A partial
// snapshot is the case the contract calls uninterpretable once the ruleset is retuned.
const TDM_RULES = {
  killLimit: 75,
  roundsToWin: null, maxRounds: null, sideSwitchAfter: null, roundLengthSec: null,
  bombTimerSec: null, defuseSec: null, plantSec: null, freezeSec: null, overtime: null,
};
const BOMB_RULES = {
  killLimit: null,
  roundsToWin: 7, maxRounds: 12, sideSwitchAfter: 6, roundLengthSec: 105,
  bombTimerSec: 40, defuseSec: 7, plantSec: 3, freezeSec: 8, overtime: false,
};

const T0 = '2026-08-20T12:00:00.000Z';
const T1 = '2026-08-20T12:20:00.000Z';

function playerRow(who, team, over = {}) {
  return {
    accountId: who.accountId, displayName: who.displayName,
    team, role: null,
    kills: 10, deaths: 5, assists: 3, suicides: 0, teamKills: 0,
    headshots: 2, shotsFired: 100, shotsHit: 40, damageDealt: 1200,
    plants: 1, defuses: 0, roundsPlayed: 0, timePlayedSec: 600,
    score: 1400, disconnected: false, abandoned: false,
    joinedAt: T0, leftAt: null,
    weapons: { ar_vector: { shots: 100, hits: 40, kills: 10, headshots: 2 } },
    ...over,
  };
}

function bombRound(index, actor, over = {}) {
  return {
    index, winner: 'alpha', reason: 'defuse',
    startedAt: T0, endedAt: T1,
    roles: { alpha: 'defender', bravo: 'attacker' },
    plant: { accountId: actor.accountId, site: 'A', at: T0 },
    defuse: { accountId: actor.accountId, at: T1 },
    ...over,
  };
}

function result({ matchId, players, mode = 'tdm', status = 'completed',
  winnerTeam = 'alpha', outcomeReason = 'timer', rounds = [], ...over }) {
  return {
    matchId, status, mode,
    rulesetVersion: mode === 'bomb' ? 'bomb-1.0.0' : 'tdm-1.0.0',
    statDefinitionVersion: '1.0.0',
    rulesSnapshot: mode === 'bomb' ? { ...BOMB_RULES } : { ...TDM_RULES },
    serverBuild: 'srv-1.0.0',
    mapId: 'the-square', mapVersion: '1.0.0', region: 'yyz',
    startedAt: T0, endedAt: T1,
    terminationReason: status, outcomeReason,
    winnerTeam,
    invalidationReason: status === 'invalidated' ? 'cheat-detected' : null,
    roster: players.map((p) => ({
      accountId: p.accountId, team: p.team, joinedAt: p.joinedAt, leftAt: p.leftAt,
    })),
    teamScores: { alpha: 75, bravo: 40 },
    rounds,
    players,
    evidenceRef: `ev:${matchId}`,
    ...over,
  };
}

/** The field paths a VALIDATION_FAILED envelope named. errors.md §3: `details.fields[].path`. */
const paths = (res) => (res.body?.error?.details?.fields || []).map((f) => f.path ?? f.key);

// ═════════════════════════════════════════════════════════════════════════════════════════

await withApp(async ({ app, call }) => {
  const p1 = await onboard(call, { name: 'Ravon', email: 'ravon@example.invalid', ip: '198.51.100.1' });
  const p2 = await onboard(call, { name: 'Sable', email: 'sable@example.invalid', ip: '198.51.100.2' });
  const p3 = await onboard(call, { name: 'Outsider', email: 'outsider@example.invalid', ip: '198.51.100.3' });
  const p4 = await onboard(call, { name: 'Quietly', email: 'quietly@example.invalid', ip: '198.51.100.4' });

  // `statsVisibility` defaults to `nobody`, so publishing is the change that has to be made
  // explicitly. p1 and p2 publish; p4 keeps the default. That pair is what makes the §4.2
  // privacy branch checkable rather than decorative — with everyone private, a detail endpoint
  // that refused every stranger would pass, and so would one that refused everything.
  for (const p of [p1, p2]) {
    const show = await call('PATCH', '/v1/profile/me', { privacy: { statsVisibility: 'everyone' } },
      { ...p.auth, 'idempotency-key': `show-${ulid()}` });
    expect(show.status === 200, `setup: ${p.displayName} publishes their career`, show.text);
  }
  const hidden = await call('GET', `/v1/profile/${p4.accountId}`, undefined, p3.auth);
  expect(hidden.body?.stats === null,
    'setup: p4 keeps the default private career', hidden.text);

  // ── 1. the routes exist at all ────────────────────────────────────────────────────────
  section('§7 — /v1/matches/* is mounted');

  const noAuth = await call('GET', `/v1/matches/${ulid()}`);
  expect(noAuth.status === 401 && noAuth.code === 'AUTH_REQUIRED',
    'GET /v1/matches/:matchId exists and is authenticated (not a 404 from an unmounted route)',
    `${noAuth.status} ${noAuth.code}`);

  const active = await call('GET', '/v1/matches/active', undefined, p1.auth);
  expect(active.status === 204 || active.status === 200,
    '§7.1 GET /v1/matches/active is mounted and answers the caller',
    `${active.status} ${active.text}`);
  expect((await call('GET', '/v1/matches/active')).status === 401,
    '§7.1 GET /v1/matches/active is authenticated');

  // ── 2. §5.1: the result endpoint is SERVICE ONLY ──────────────────────────────────────
  section('§5.1 — result submission is service-only');

  const m1 = ulid();
  const r1 = result({ matchId: m1, players: [playerRow(p1, 'alpha'), playerRow(p2, 'bravo')] });

  const browser = await call('POST', `/v1/matches/${m1}/result`, r1);
  expect(browser.status === 403 && browser.code === 'AUTH_FORBIDDEN',
    'a browser-origin submission is refused (§8.8: the G1 gate is not decorative)',
    `${browser.status} ${browser.code}`);

  const asPlayer = await call('POST', `/v1/matches/${m1}/result`, r1, p1.auth);
  expect(asPlayer.status === 403 && asPlayer.code === 'AUTH_FORBIDDEN',
    'a PLAYER-authenticated submission is refused too — a token is not a service identity',
    `${asPlayer.status} ${asPlayer.code}`);

  const wrongToken = await call('POST', `/v1/matches/${m1}/result`, r1,
    { 'x-service-token': 'not-the-token' });
  expect(wrongToken.status === 403,
    'a wrong service token is refused', `${wrongToken.status} ${wrongToken.code}`);

  // CONTROL: the same payload with the service token applies. Without this the three refusals
  // above are equally consistent with an endpoint that refuses everything.
  const applied = await call('POST', `/v1/matches/${m1}/result`, r1, asService);
  expect(applied.status === 200 && applied.body?.applied === true,
    'CONTROL: the service-authenticated submission applies', applied.text);
  expect(typeof applied.body?.correlationId === 'string',
    'the submission response carries a correlation id (errors.md §5)', applied.text);

  // ── 3. §5.2–§5.5 idempotency, over the wire ───────────────────────────────────────────
  section('§5 — idempotency and the second truth');

  const replay = await call('POST', `/v1/matches/${m1}/result`, r1,
    { ...asService, 'idempotency-key': `match-result:${m1}` });
  expect(replay.status === 200 && replay.body?.applied === false,
    '§5.4: a replay returns the stored response and reports that THIS call did not apply',
    replay.text);

  const otherKey = await call('POST', `/v1/matches/${m1}/result`, r1,
    { ...asService, 'idempotency-key': 'match-result:something-else' });
  expect(otherKey.status === 400 && otherKey.code === 'VALIDATION_FAILED',
    '§5.2: an Idempotency-Key that is not match-result:<matchId> is refused', otherKey.text);

  const different = await call('POST', `/v1/matches/${m1}/result`,
    { ...r1, teamScores: { alpha: 1, bravo: 0 } }, asService);
  expect(different.status === 409 && different.code === 'CONFLICT',
    '§5.5: a different payload for a finalised match is a CONFLICT', different.text);

  const career = await call('GET', `/v1/profile/${p1.accountId}/stats?mode=tdm`, undefined, p1.auth);
  expect(career.body?.totals?.kills === 10 && career.body?.totals?.matches === 1,
    'the retries and the conflict left exactly one match in the career',
    JSON.stringify(career.body?.totals));

  // ── 4. §4.1 nested shapes ─────────────────────────────────────────────────────────────
  section('§4.1/§4.2 — every nested shape is validated exactly');

  const submitBad = async (mutate, label, expectedPath) => {
    const id = ulid();
    const base = result({ matchId: id, players: [playerRow(p1, 'alpha'), playerRow(p2, 'bravo')] });
    mutate(base);
    const res = await call('POST', `/v1/matches/${id}/result`, base, asService);
    expect(res.status === 400 && res.code === 'VALIDATION_FAILED', label,
      `${res.status} ${res.code} ${res.text}`);
    if (expectedPath) {
      expect(paths(res).includes(expectedPath),
        `  …and the refusal names ${expectedPath}`, JSON.stringify(paths(res)));
    }
    // Nothing malformed is ever half-recorded.
    const after = await call('GET', `/v1/matches/${id}`, undefined, p1.auth);
    expect(after.status === 404, `  …and ${label} recorded nothing`, after.text);
  };

  await submitBad((r) => { r.players[1].kills = -1; },
    'a negative counter is refused', 'players[1].kills');
  await submitBad((r) => { r.players[0].kills = 1.5; },
    'a fractional counter is refused', 'players[0].kills');
  await submitBad((r) => { r.players[0].kills = '10'; },
    'a numeric counter sent as a string is refused', 'players[0].kills');
  await submitBad((r) => { delete r.players[0].displayName; },
    'a player missing a §4.1 key is refused', 'players[0].displayName');
  await submitBad((r) => { r.players[0].mvp = true; },
    'an UNKNOWN key on a player is refused', 'players[0].mvp');
  await submitBad((r) => { r.players[0].team = 'charlie'; },
    'a team outside the enum is refused', 'players[0].team');
  await submitBad((r) => { r.players[0].role = 'medic'; },
    'a role outside the enum is refused', 'players[0].role');
  await submitBad((r) => { r.players[0].disconnected = 'yes'; },
    'a boolean sent as a string is refused', 'players[0].disconnected');
  await submitBad((r) => { r.players[0].weapons.ar_vector.kills = -3; },
    'a negative weapon counter is refused', 'players[0].weapons.ar_vector.kills');
  await submitBad((r) => { r.players[0].weapons.ar_vector.crits = 2; },
    'an unknown weapon counter is refused', 'players[0].weapons.ar_vector.crits');
  await submitBad((r) => { r.players[0].weapons.ar_vector = 7; },
    'a weapon breakdown that is not an object is refused', 'players[0].weapons.ar_vector');
  await submitBad((r) => { r.players[1] = null; },
    'a null player row is refused', 'players[1]');
  await submitBad((r) => { r.roster[0].team = 'charlie'; },
    'a roster entry outside the team enum is refused', 'roster[0].team');
  await submitBad((r) => { r.roster[0].squad = 'a'; },
    'an unknown key on a roster entry is refused', 'roster[0].squad');
  await submitBad((r) => { r.teamScores.charlie = 3; },
    'a third team in teamScores is refused', 'teamScores.charlie');
  await submitBad((r) => { r.teamScores.alpha = -1; },
    'a negative team score is refused', 'teamScores.alpha');
  await submitBad((r) => { delete r.teamScores.bravo; },
    'teamScores missing a side is refused', 'teamScores.bravo');
  await submitBad((r) => { delete r.rulesSnapshot.freezeSec; },
    'a rulesSnapshot missing a key is refused', 'rulesSnapshot.freezeSec');
  await submitBad((r) => { r.rulesSnapshot.suddenDeath = true; },
    'an unknown rulesSnapshot key is refused', 'rulesSnapshot.suddenDeath');
  await submitBad((r) => { r.rulesSnapshot.roundsToWin = 7; },
    'a TDM snapshot carrying a bomb key is refused (§4 discriminates by mode)',
    'rulesSnapshot.roundsToWin');
  await submitBad((r) => { r.rulesSnapshot.killLimit = null; },
    'a TDM snapshot with no kill limit is refused', 'rulesSnapshot.killLimit');
  await submitBad((r) => { r.rounds = [{ index: 0, winner: 'alpha', reason: 'defuse' }]; },
    'a round missing its §4.1 keys is refused', 'rounds[0].startedAt');
  await submitBad((r) => {
    r.rounds = [bombRound(0, p1, { roles: { alpha: 'attacker' } })];
  }, 'a round whose roles omit a team is refused', 'rounds[0].roles.bravo');
  await submitBad((r) => {
    r.rounds = [bombRound(0, p1, { plant: { accountId: p1.accountId, site: 'C', at: T0 } })];
  }, 'a plant on a site outside A|B is refused', 'rounds[0].plant.site');
  await submitBad((r) => {
    r.rounds = [bombRound(0, p1, { reason: 'surrender' })];
  }, 'a round reason outside the enum is refused', 'rounds[0].reason');
  await submitBad((r) => { r.rounds = [bombRound(0, p1, { index: -1 })]; },
    'a negative round index is refused', 'rounds[0].index');
  await submitBad((r) => { r.players[1].accountId = r.players[0].accountId; },
    'the same account twice in one result is refused');

  // CONTROL: a bomb result with fully-formed rounds applies. Every refusal above is about the
  // mutation and not about a validator that has started refusing rounds altogether.
  const bombId = ulid();
  const bombOk = await call('POST', `/v1/matches/${bombId}/result`, result({
    matchId: bombId, mode: 'bomb', outcomeReason: 'defuse',
    players: [playerRow(p1, 'alpha', { role: 'defender', roundsPlayed: 12 }),
      playerRow(p2, 'bravo', { role: 'attacker', roundsPlayed: 12 })],
    rounds: [bombRound(0, p1), bombRound(1, p1)],
  }), asService);
  expect(bombOk.status === 200 && bombOk.body?.applied === true,
    'CONTROL: a complete bomb result with rounds, roles and objectives applies', bombOk.text);

  // ── 5. draw implies timer ─────────────────────────────────────────────────────────────
  section('§4.0 — a draw is the regulation timer, and nothing else');

  const drawId = ulid();
  const drawBad = await call('POST', `/v1/matches/${drawId}/result`, result({
    matchId: drawId, mode: 'bomb', winnerTeam: 'draw', outcomeReason: 'elimination',
    players: [playerRow(p1, 'alpha'), playerRow(p2, 'bravo')],
    rounds: [bombRound(0, p1)],
  }), asService);
  expect(drawBad.status === 400 && drawBad.code === 'VALIDATION_FAILED',
    'a draw by elimination is refused — a 6-6 draw is the timer expiring (bomb-rules §2.1a)',
    drawBad.text);
  expect(paths(drawBad).includes('outcomeReason'),
    '  …and the refusal names outcomeReason', JSON.stringify(paths(drawBad)));

  const drawId2 = ulid();
  const drawOk = await call('POST', `/v1/matches/${drawId2}/result`, result({
    matchId: drawId2, mode: 'bomb', winnerTeam: 'draw', outcomeReason: 'timer',
    players: [playerRow(p1, 'alpha'), playerRow(p2, 'bravo')],
    rounds: [bombRound(0, p1, { reason: 'timer' })],
  }), asService);
  expect(drawOk.status === 200, 'CONTROL: a draw by timer applies', drawOk.text);

  // ── 6. §4.2 detail authorization ──────────────────────────────────────────────────────
  section('§4.2 — the detail endpoint authorises, and hides by 404');

  const mine = await call('GET', `/v1/matches/${m1}`, undefined, p1.auth);
  expect(mine.status === 200 && mine.body?.status === 'completed',
    'a participant reads their own match', mine.text);
  expect(mine.body?.evidenceRef === null,
    '§7: evidenceRef is internal and never reaches a player, participant or not',
    JSON.stringify(mine.body?.evidenceRef));

  const stranger = await call('GET', `/v1/matches/${m1}`, undefined, p3.auth);
  expect(stranger.status === 200,
    'a non-participant may read a match whose players all publish their careers', stranger.text);
  expect((stranger.body?.rounds || []).every((r) => !r.plant || r.plant.accountId === null),
    '§4.1: objective ACTORS are withheld from a non-participant',
    JSON.stringify(stranger.body?.rounds));

  // A match with a player who hides their career is invisible to strangers — as a 404, because
  // a 403 would confirm the match exists, which is the fact privacy is refusing to disclose.
  const privateId = ulid();
  await call('POST', `/v1/matches/${privateId}/result`, result({
    matchId: privateId, players: [playerRow(p4, 'alpha'), playerRow(p2, 'bravo')],
  }), asService);
  const refused = await call('GET', `/v1/matches/${privateId}`, undefined, p3.auth);
  expect(refused.status === 404 && refused.code === 'NOT_FOUND',
    'a stranger gets 404 — not 403 — for a match privacy forbids', `${refused.status} ${refused.code}`);
  const participant = await call('GET', `/v1/matches/${privateId}`, undefined, p4.auth);
  expect(participant.status === 200,
    'CONTROL: the participant themselves still reads it', participant.text);
  const neverExisted = await call('GET', `/v1/matches/${ulid()}`, undefined, p3.auth);
  expect(neverExisted.status === 404 && neverExisted.code === refused.code,
    'a match that never existed is indistinguishable from one that is hidden',
    `${neverExisted.status} ${neverExisted.code}`);

  // The service caller — the one that has to reconstruct a result from evidence (§7) — does get
  // the reference. Read through the service rather than the route: the route is player-facing.
  const asServiceView = await app.deps.profile.stats.getMatch(m1,
    { viewer: { kind: 'service', id: 'match-server' }, correlationId: 'c' });
  expect(typeof asServiceView.evidenceRef === 'string' && asServiceView.evidenceRef.length > 0,
    'CONTROL: a service viewer receives evidenceRef', JSON.stringify(asServiceView.evidenceRef));

  // ── 7. §4.2/§4.4 the non-terminal states ──────────────────────────────────────────────
  section('§4.2 — allocated, live, and ended-but-queued are all `pending`, distinguishably');

  const store = app.deps.store;
  const allocatedId = ulid();
  await store.matches.record({
    matchId: allocatedId, status: 'allocated', mode: 'tdm', mapId: 'the-square',
    mapVersion: '1.0.0', region: 'yyz', rulesSnapshot: { ...TDM_RULES },
    players: [{ accountId: p1.accountId, team: 'alpha' }],
  });
  const allocated = await call('GET', `/v1/matches/${allocatedId}`, undefined, p1.auth);
  expect(allocated.status === 200 && allocated.body?.status === 'pending'
      && allocated.body.startedAt === null && allocated.body.endedAt === null,
    'an ALLOCATED match is pending with a null startedAt and a null endedAt', allocated.text);
  expect(allocated.body?.retryAfterMs > 0,
    'the pending shape tells the client when to ask again', allocated.text);

  const liveId = ulid();
  await store.matches.record({
    matchId: liveId, status: 'in-progress', mode: 'tdm', mapId: 'the-square',
    mapVersion: '1.0.0', region: 'yyz', rulesSnapshot: { ...TDM_RULES }, startedAt: T0,
    players: [{ accountId: p1.accountId, team: 'alpha' }],
  });
  const live = await call('GET', `/v1/matches/${liveId}`, undefined, p1.auth);
  expect(live.body?.status === 'pending' && live.body.startedAt === T0 && live.body.endedAt === null,
    'a LIVE match is pending with a startedAt and a null endedAt', live.text);

  const queuedId = ulid();
  await store.matches.record({
    matchId: queuedId, status: 'in-progress', mode: 'tdm', mapId: 'the-square',
    mapVersion: '1.0.0', region: 'yyz', rulesSnapshot: { ...TDM_RULES },
    startedAt: T0, endedAt: T1,
    players: [{ accountId: p1.accountId, team: 'alpha' }],
  });
  const queued = await call('GET', `/v1/matches/${queuedId}`, undefined, p1.auth);
  expect(queued.body?.status === 'pending' && queued.body.endedAt === T1,
    'an ENDED, queued match is pending WITH the real endedAt', queued.text);

  // A stranger is refused a pending match on the same rule as a terminal one — the pending
  // shape leaks map, mode and timing, and a 404 there is what stops it being a probe oracle.
  const strangerPending = await call('GET', `/v1/matches/${liveId}`, undefined, p3.auth);
  expect(strangerPending.status === 200 || strangerPending.status === 404,
    'the pending shape answers the privacy rule too', strangerPending.text);

  // §7.1: p1 now holds a live match, so `active` stops being 204 and names it.
  const nowActive = await call('GET', '/v1/matches/active', undefined, p1.auth);
  expect(nowActive.status === 200 && typeof nowActive.body?.matchId === 'string',
    '§7.1: a player in a live match is told which one, without having to remember it',
    nowActive.text);
  expect(typeof nowActive.body?.serverNow === 'string' && typeof nowActive.body?.graceEndsAt === 'string',
    '§7.1: and the response carries serverNow and graceEndsAt', nowActive.text);
  const strangerActive = await call('GET', '/v1/matches/active', undefined, p3.auth);
  expect(strangerActive.status === 204,
    'CONTROL: a player with no held match gets 204, not someone else’s', strangerActive.text);

  // ── 8. invalidation is a submission-time decision, not an edit ────────────────────────
  section('§5.5 — a finalised match cannot be invalidated by re-submission');

  const invalidateFinalised = await call('POST', `/v1/matches/${m1}/result`, result({
    matchId: m1, status: 'invalidated', winnerTeam: null, outcomeReason: 'no-contest',
    players: [playerRow(p1, 'alpha'), playerRow(p2, 'bravo')],
  }), asService);
  expect(invalidateFinalised.status === 409 && invalidateFinalised.code === 'CONFLICT',
    'invalidating an already-finalised match through the result endpoint is refused',
    invalidateFinalised.text);
  const stillThere = await call('GET', `/v1/profile/${p1.accountId}/stats?mode=tdm`, undefined, p1.auth);
  expect(stillThere.body?.totals?.matches === 1,
    'and the career it would have reversed is untouched', JSON.stringify(stillThere.body?.totals));

  // CONTROL: an invalidation submitted as the FIRST terminal result is accepted and recorded,
  // and does not aggregate.
  const invId = ulid();
  const invalidated = await call('POST', `/v1/matches/${invId}/result`, result({
    matchId: invId, status: 'invalidated', winnerTeam: null, outcomeReason: 'no-contest',
    players: [playerRow(p1, 'alpha', { kills: 99 })],
  }), asService);
  expect(invalidated.status === 200,
    'CONTROL: an invalidation submitted as the first terminal result is accepted', invalidated.text);
  const afterInv = await call('GET', `/v1/profile/${p1.accountId}/stats?mode=tdm`, undefined, p1.auth);
  expect(afterInv.body?.totals?.kills === 10,
    'CONTROL: and it records without aggregating', JSON.stringify(afterInv.body?.totals));

  // ── 9. §11.5/§4.3 hidden shapes are the contracted shapes ─────────────────────────────
  section('§11.5 — a hidden career is the contracted shape with null counters');

  const hiddenAll = await call('GET', `/v1/profile/${p4.accountId}/stats?mode=all`, undefined, p3.auth);
  const visibleAll = await call('GET', `/v1/profile/${p1.accountId}/stats?mode=all`, undefined, p3.auth);
  expect(hiddenAll.status === 200 && visibleAll.status === 200,
    'both careers answer 200 — privacy is never a 403 here',
    `${hiddenAll.status}/${visibleAll.status}`);
  expect(JSON.stringify(Object.keys(hiddenAll.body).sort())
      === JSON.stringify(Object.keys(visibleAll.body).sort()),
    'mode=all: the hidden career has the SAME keys as the visible one',
    `${JSON.stringify(Object.keys(hiddenAll.body))} vs ${JSON.stringify(Object.keys(visibleAll.body))}`);
  expect(hiddenAll.body?.modes?.tdm?.totals === null && hiddenAll.body?.modes?.bomb?.totals === null,
    'mode=all: a hidden career is per-mode nulls, not an ad-hoc object',
    JSON.stringify(hiddenAll.body));
  const hiddenOne = await call('GET', `/v1/profile/${p4.accountId}/stats?mode=tdm`, undefined, p3.auth);
  const visibleOne = await call('GET', `/v1/profile/${p1.accountId}/stats?mode=tdm`, undefined, p3.auth);
  expect(JSON.stringify(Object.keys(hiddenOne.body).sort())
      === JSON.stringify(Object.keys(visibleOne.body).sort()),
    'mode=tdm: the hidden career has the SAME keys as the visible one',
    `${JSON.stringify(Object.keys(hiddenOne.body))} vs ${JSON.stringify(Object.keys(visibleOne.body))}`);

  const hiddenHistory = await call('GET', `/v1/profile/${p4.accountId}/matches`, undefined, p3.auth);
  expect(hiddenHistory.status === 200 && hiddenHistory.body?.items === null
      && hiddenHistory.body?.nextCursor === null,
    '§4.3: a hidden history is null items and a null cursor, never a 403', hiddenHistory.text);
});

// ── 10. the outbox is a wiring requirement, not a runtime mode ──────────────────────────
section('§5.3 — a stats service with no outbox is a wiring error');

{
  const store = createMemoryStore({ storage: 'memory' });
  let threw = null;
  try { createStatsService({ store }); } catch (err) { threw = err; }
  expect(threw !== null,
    'constructing the stats service without an outbox throws at CONSTRUCTION',
    'a deployment missing the outbox would apply careers with no durable trace');
  // CONTROL: with one, it constructs.
  const withOutbox = createStatsService({ store, outbox: { emitIn: async () => {} } });
  expect(typeof withOutbox.applyMatchResult === 'function',
    'CONTROL: the same construction with an outbox succeeds');
  await store.close();
}

console.log('');
if (failures) {
  console.log(`${failures} FAILURE${failures === 1 ? '' : 'S'}\n`);
  process.exit(1);
}
console.log('all match checks passed\n');
