/**
 * stubtest — the coverage guarantee for the stub layer.
 *
 * contracts/http-api.md §11.10 and §11.11 and design/shell-ia.md are the source of truth, so
 * this test **parses them** rather than restating them: the scenario list, the coverage map, the
 * lobby timelines and the shell route hierarchy are read out of the markdown, and anything the
 * documents name that the registry does not serve is a failure here. That is the only version of
 * "complete" that stays true after the documents change.
 *
 * What it proves:
 *   1. the flag gate refuses production, and refuses to serve with the flag off
 *   2. the §1 build check and the §2 auth class are enforced, with failing controls
 *   3. every §11.10 scenario exists and is reachable, and every extra is declared
 *   4. every §11.11 coverage row, and every shell-ia route × variant, runs
 *   5. multi-step scenarios genuinely transition, rather than returning one canned response
 *   6. prerequisites, room identity, and settings round-trip are real, not asserted
 *   7. `slow` actually delays
 *   8. responses validate against the contract shapes — keys, enums, nullability
 *   9. replaying a scenario from a fresh session is byte-identical
 *  10. the §10 lobby timelines are seeded from compatible rooms and hold their invariants
 *  11. the mounted path works over a real socket, not only the in-process API
 *
 * Run: `node platform/test/stubtest.mjs`
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createStubApi, assertStubAllowed, STUB_FLAG } from '../src/modules/stubs/index.js';
import { SCENARIOS, EXTRA_SCENARIOS } from '../src/modules/stubs/scenarios.js';
import {
  COVERAGE_MAP, COVERAGE_MAP_ROUTES, ROUTE_COVERAGE, SCENARIO_PROBES, VARIANTS,
  ROAM_WRITE, DEVICE_WRITE,
} from '../src/modules/stubs/coverage.js';
import { createLobbyStub, LOBBY_SCENARIO_NAMES } from '../src/modules/stubs/lobby.js';
import * as fx from '../src/modules/stubs/fixtures.js';
import { VOCABULARY } from '../src/modules/profile/vocabulary.generated.js';
import { defaultRoamingValues } from '../src/modules/profile/settings.js';
import { CODES } from '../src/core/errors.js';
import { loadConfig } from '../src/core/config.js';
import { buildApp } from '../src/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const check = (cond, n, d) => (cond ? ok(n) : bad(n, d));

// ── contract parsing ────────────────────────────────────────────────────────────────────────

const md = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const section = (text, startMarker, endMarker) => {
  const from = text.indexOf(startMarker);
  if (from === -1) throw new Error(`cannot locate ${startMarker}`);
  // A section that runs to the end of the document has no trailing marker. Treating that as
  // "not found" made the LAST section in any contract unparseable, which is exactly where a
  // newly appended section lands.
  let to = text.indexOf(endMarker, from + startMarker.length);
  if (to === -1) to = text.length;
  return text.slice(from, to);
};

const tableRows = (text) => text.split('\n')
  .filter((l) => l.trim().startsWith('|') && !/^\|[\s:|-]+\|$/.test(l.trim()))
  .map((l) => l.trim().slice(1, -1).split('|').map((c) => c.trim()));

const ticked = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

const httpApi = md('docs/contracts/http-api.md');
const lobbyMd = md('docs/contracts/realtime-lobby.md');
const shellIa = md('docs/design/shell-ia.md');

/** §11.10 — every scenario name, including the three sharing one row. */
const contractScenarios = [];
for (const cells of tableRows(section(httpApi, '### 11.10', '### 11.11'))) {
  for (const name of ticked(cells[0])) contractScenarios.push(name);
}

/** §11.11 — route label → owning scenario names. */
const contractCoverage = {};
for (const cells of tableRows(section(httpApi, '### 11.11', '## 12. Stub mode'))) {
  const label = cells[0].replace(/`/g, '').trim();
  const owners = ticked(cells[1]);
  if (owners.length) contractCoverage[label] = owners;
}

/** realtime-lobby.md §10 — the lobby timelines. */
const contractLobby = [];
for (const cells of tableRows(section(lobbyMd, '## 10. Stub', '\n---\n').concat('\n---\n'))) {
  for (const name of ticked(cells[0])) contractLobby.push(name);
}

/**
 * design/shell-ia.md — the route hierarchy, as full paths.
 *
 * The tree is indented four columns per level, so a node's path is its own token appended to its
 * parent's. Pure container nodes (`/auth`, `/onboarding`, `/play`, `/career`) are excluded: they
 * are groupings with no screen of their own, and §11.11 does not name them either. Everything
 * else — leaf or not — is a screen that owes five state fixtures.
 */
function shellRoutes() {
  const block = section(shellIa, '## Route hierarchy', '\n## Navigation model');
  const nodes = [];
  const stack = [];
  const childCount = new Map();
  for (const line of block.split('\n')) {
    const trimmedRight = line.replace(/\s+$/, '');
    const match = trimmedRight.match(/^([^/]*)(\/\S*)$/);
    if (!match) continue;
    const [, prefix, token] = match;
    if (token === '/' && prefix.trim() === '') continue;         // the root node
    const depth = Math.floor(prefix.replace(/[├└─│]/g, ' ').length / 4);
    stack[depth] = token;
    stack.length = depth + 1;
    const path = stack.join('');
    if (depth > 0) {
      const parent = stack.slice(0, depth).join('');
      childCount.set(parent, (childCount.get(parent) || 0) + 1);
    }
    nodes.push(path);
  }
  // A one-segment node with children is a container, not a screen.
  return nodes.filter((p) => !(childCount.get(p) && p.split('/').length === 2));
}
const contractRoutes = shellRoutes();

console.log('\n--- contract parse ---');
check(contractScenarios.length >= 30, 'http-api.md §11.10 parsed',
  `found ${contractScenarios.length} scenario names`);
check(Object.keys(contractCoverage).length >= 12, 'http-api.md §11.11 parsed',
  `found ${Object.keys(contractCoverage).length} coverage rows`);
check(contractLobby.length >= 14, 'realtime-lobby.md §10 parsed',
  `found ${contractLobby.length} lobby scenarios`);
check(contractRoutes.length >= 24 && contractRoutes.includes('/auth/recover')
  && contractRoutes.includes('/system/:condition') && contractRoutes.includes('/room/:roomId/chat'),
'design/shell-ia.md route hierarchy parsed',
`found ${contractRoutes.length}: ${contractRoutes.join(' ')}`);

// ── 1. the flag gate ────────────────────────────────────────────────────────────────────────

console.log('\n--- flag gate (feature-flags.md §2, §4) ---');
{
  const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

  const prodByConfig = threw(() => assertStubAllowed({
    config: { env: 'production' }, flags: { [STUB_FLAG]: true }, env: {},
  }));
  check(prodByConfig && /production/.test(prodByConfig),
    'refuses in production even with the flag ON', prodByConfig || 'it constructed');

  const prodByEnv = threw(() => assertStubAllowed({
    config: {}, flags: { [STUB_FLAG]: true }, env: { NODE_ENV: 'production' },
  }));
  check(prodByEnv && /production/.test(prodByEnv),
    'refuses when NODE_ENV=production', prodByEnv || 'it constructed');

  const prodApi = threw(() => createStubApi({
    config: { env: 'production' }, flags: { [STUB_FLAG]: true }, env: {},
  }));
  check(prodApi && /production/.test(prodApi),
    'createStubApi refuses to construct in production', prodApi || 'it constructed');

  const flagOff = threw(() => createStubApi({ config: { env: 'development' }, flags: {}, env: {} }));
  check(flagOff && new RegExp(STUB_FLAG).test(flagOff),
    `refuses to serve with ${STUB_FLAG} off`, flagOff || 'it constructed');

  const devOn = threw(() => createStubApi({
    config: { env: 'development' }, flags: { [STUB_FLAG]: true }, env: {},
  }));
  check(devOn === null, 'constructs in development with the flag on', devOn);
}

// ── the driver ──────────────────────────────────────────────────────────────────────────────

/**
 * Every scenario is driven through one place, and that place behaves like a client: it sends
 * `X-Client-Build`, and it presents the access token the layer last issued to it. It never
 * fabricates a credential — if a sequence reaches an authenticated route without signing in
 * first, that is a 401 and the sequence is wrong.
 */
const CLIENT_BUILD = '1.0.0';

/** Sleep calls the layer requested, so the delay is checkable without paying for it. */
let sleepRequests = [];
const api = () => createStubApi({
  config: { env: 'test' },
  flags: { [STUB_FLAG]: true },
  env: {},
  sleep: (ms) => { sleepRequests.push(ms); return Promise.resolve(); },
});

async function run(stub, scenario, sessionId, requests) {
  const out = [];
  let token = null;
  for (const entry of requests) {
    const req = typeof entry === 'function' ? entry(out) : entry;
    const headers = {
      'X-Stub-Scenario': scenario,
      'X-Client-Session-Id': sessionId,
      'X-Client-Build': CLIENT_BUILD,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(req.headers || {}),
    };
    // `await` matters: a delayed scenario resolves through the response's own thenable, which is
    // exactly how the mounted path in app.js applies it.
    const res = await stub.handle({
      method: req.method, path: req.path, query: req.query || {}, body: req.body || {}, headers,
    });
    if (res.body && typeof res.body.accessToken === 'string') token = res.body.accessToken;
    out.push(res);
  }
  return out;
}

/** One request, with explicit headers and no token plumbing. For gate checks. */
const raw = (stub, scenario, sessionId, req, headers = {}) => stub.handle({
  method: req.method || 'GET', path: req.path, query: req.query || {}, body: req.body || {},
  headers: { 'X-Stub-Scenario': scenario, 'X-Client-Session-Id': sessionId, ...headers },
});

// ── 2. §1 build and §2 auth are enforced ────────────────────────────────────────────────────

console.log('\n--- §1 build and §2 auth enforcement ---');
{
  const stub = api();
  const rooms = { method: 'GET', path: '/v1/rooms' };
  const signinReq = { method: 'POST', path: '/v1/auth/signin', body: { email: 'a@b.invalid', password: 'p' } };

  const noBuild = raw(stub, 'default', 'gate-1', rooms, { Authorization: 'Bearer stub.access.x' });
  check(noBuild.status === 426 && noBuild.body.error.code === 'UNSUPPORTED_CLIENT'
    && noBuild.body.error.details.reason === 'build',
  'a request with no X-Client-Build is UNSUPPORTED_CLIENT, as production refuses it',
  `${noBuild.status}/${noBuild.body?.error?.code}`);

  const junkBuild = raw(stub, 'default', 'gate-2', rooms,
    { 'X-Client-Build': '2garbage', Authorization: 'Bearer stub.access.x' });
  check(junkBuild.status === 426,
    'a malformed build is refused, not read as a numeric prefix', `${junkBuild.status}`);

  // The failing control: the same request WITH the header must succeed, or the check above
  // would pass for a layer that refuses everything.
  const withBuild = raw(stub, 'default', 'gate-3', rooms,
    { 'X-Client-Build': CLIENT_BUILD, Authorization: 'Bearer stub.access.x' });
  check(withBuild.status === 200, 'control: the same request with a valid build succeeds',
    `${withBuild.status}/${withBuild.body?.error?.code}`);

  const floored = createStubApi({
    config: { env: 'test', minClientBuild: '2.0.0' }, flags: { [STUB_FLAG]: true }, env: {},
  });
  const below = raw(floored, 'default', 'gate-4', rooms,
    { 'X-Client-Build': '1.9.9', Authorization: 'Bearer stub.access.x' });
  const above = raw(floored, 'default', 'gate-5', rooms,
    { 'X-Client-Build': '2.10.0', Authorization: 'Bearer stub.access.x' });
  check(below.status === 426 && above.status === 200,
    'the configured floor is applied numerically (2.10.0 is above 2.0.0, 1.9.9 is below)',
    `${below.status} / ${above.status}`);

  const health = raw(stub, 'default', 'gate-6', { path: '/v1/health' });
  check(health.status === 200,
    'GET /v1/health is build-exempt, exactly as core/http.js exempts it', `${health.status}`);

  const noAuth = raw(stub, 'default', 'gate-7', rooms, { 'X-Client-Build': CLIENT_BUILD });
  check(noAuth.status === 401 && noAuth.body.error.code === 'AUTH_REQUIRED',
    'an A endpoint with no credential is AUTH_REQUIRED, not a fixture',
    `${noAuth.status}/${noAuth.body?.error?.code}`);

  const junkToken = raw(stub, 'default', 'gate-8', rooms,
    { 'X-Client-Build': CLIENT_BUILD, Authorization: 'Bearer not-a-token-we-issued' });
  check(junkToken.status === 401 && junkToken.body.error.code === 'AUTH_TOKEN_INVALID',
    'a credential this layer never issued is AUTH_TOKEN_INVALID',
    `${junkToken.status}/${junkToken.body?.error?.code}`);

  const publicRoute = raw(stub, 'default', 'gate-9', signinReq, { 'X-Client-Build': CLIENT_BUILD });
  check(publicRoute.status === 200, 'control: a P endpoint still answers with no credential',
    `${publicRoute.status}/${publicRoute.body?.error?.code}`);

  const serviceRoute = raw(stub, 'default', 'gate-10', { path: '/v1/health/ready' },
    { 'X-Client-Build': CLIENT_BUILD });
  check(serviceRoute.status === 403 && serviceRoute.body.error.code === 'AUTH_FORBIDDEN',
    'an S endpoint refuses a browser, as app.js requireServiceCaller does',
    `${serviceRoute.status}/${serviceRoute.body?.error?.code}`);

  const withService = createStubApi({
    config: { env: 'test', serviceToken: 'shared-secret' }, flags: { [STUB_FLAG]: true }, env: {},
  });
  const asService = raw(withService, 'default', 'gate-11', { path: '/v1/health/ready' },
    { 'x-service-token': 'shared-secret' });
  check(asService.status === 200, 'control: the S endpoint answers a caller holding the service token',
    `${asService.status}/${asService.body?.error?.code}`);
}

// ── the shape checker ───────────────────────────────────────────────────────────────────────

/**
 * A deliberately strict structural validator.
 *
 * `http-api.md` §11 says anything not stated is *forbidden* rather than optional, and that a
 * client may reject an unexpected field — so an extra key is an error here, not a curiosity.
 * Nullability is explicit everywhere for the same reason: `null` means present-and-empty, and
 * an omitted key is a contract violation.
 */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const S = {
  str: { kind: 'string' },
  iso: { kind: 'iso' },
  ulid: { kind: 'ulid' },
  bool: { kind: 'boolean' },
  int: { kind: 'integer' },
  any: { kind: 'any' },
  enum: (...values) => ({ kind: 'enum', values }),
  nullable: (spec) => ({ kind: 'nullable', spec }),
  obj: (keys) => ({ kind: 'object', keys }),
  arr: (spec) => ({ kind: 'array', spec }),
  record: (spec) => ({ kind: 'record', spec }),
  oneOf: (...specs) => ({ kind: 'oneOf', specs }),
};

function validate(value, spec, path, problems) {
  switch (spec.kind) {
    case 'any': return;
    case 'string':
      if (typeof value !== 'string') problems.push(`${path}: expected string, got ${JSON.stringify(value)}`);
      return;
    case 'iso':
      if (typeof value !== 'string' || !ISO.test(value)) problems.push(`${path}: expected ISO-8601 UTC with ms, got ${JSON.stringify(value)}`);
      return;
    case 'ulid':
      if (typeof value !== 'string' || !ULID.test(value)) problems.push(`${path}: expected ULID, got ${JSON.stringify(value)}`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${path}: expected boolean, got ${JSON.stringify(value)}`);
      return;
    case 'integer':
      if (!Number.isInteger(value)) problems.push(`${path}: expected integer, got ${JSON.stringify(value)}`);
      return;
    case 'enum':
      if (!spec.values.includes(value)) problems.push(`${path}: ${JSON.stringify(value)} not in ${spec.values.join('|')}`);
      return;
    case 'nullable':
      if (value === null) return;
      if (value === undefined) { problems.push(`${path}: nullable key is absent — null means present-and-empty`); return; }
      validate(value, spec.spec, path, problems);
      return;
    case 'array':
      if (!Array.isArray(value)) { problems.push(`${path}: expected array`); return; }
      value.forEach((v, i) => validate(v, spec.spec, `${path}[${i}]`, problems));
      return;
    case 'record':
      if (!value || typeof value !== 'object' || Array.isArray(value)) { problems.push(`${path}: expected object map`); return; }
      for (const [k, v] of Object.entries(value)) validate(v, spec.spec, `${path}.${k}`, problems);
      return;
    case 'oneOf': {
      const attempts = spec.specs.map((s) => { const p = []; validate(value, s, path, p); return p; });
      if (attempts.some((p) => p.length === 0)) return;
      problems.push(`${path}: matched no variant (${attempts.map((p) => p[0]).join(' / ')})`);
      return;
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { problems.push(`${path}: expected object`); return; }
      for (const [k, sub] of Object.entries(spec.keys)) {
        if (!(k in value)) { problems.push(`${path}.${k}: required key missing`); continue; }
        validate(value[k], sub, `${path}.${k}`, problems);
      }
      for (const k of Object.keys(value)) {
        if (!(k in spec.keys)) problems.push(`${path}.${k}: unexpected key`);
      }
      return;
    }
    default:
      problems.push(`${path}: unknown spec kind ${spec.kind}`);
  }
}

// ── contract shapes ─────────────────────────────────────────────────────────────────────────

const CORRELATION = { correlationId: S.ulid };

const ROOM_SETTINGS = S.obj({
  killLimit: S.nullable(S.int),
  roundsToWin: S.nullable(S.int),
  maxRounds: S.nullable(S.int),
  roundLengthSec: S.nullable(S.int),
  backfill: S.bool,
  requiredReady: S.int,
  minPlayers: S.int,
});

const ROOM_CORE_KEYS = {
  roomId: S.ulid,
  name: S.str,
  region: S.str,
  mapId: S.str,
  mapVersion: S.str,
  mode: S.enum('tdm', 'bomb'),
  rulesetVersion: S.str,
  build: S.str,
  status: S.enum('open', 'countdown', 'in-progress', 'closing'),
  capacity: S.int,
  playerCount: S.int,
  joinable: S.bool,
  joinBlockedReason: S.nullable(S.enum('full', 'in-progress', 'closing', 'password', 'sanctioned',
    'region-restricted', 'build-mismatch', 'banned-from-room')),
  hasPassword: S.bool,
  ownerAccountId: S.ulid,
  estimatedRttMs: S.nullable(S.int),
  settings: ROOM_SETTINGS,
};

const ROSTER_MEMBER = S.obj({
  accountId: S.ulid,
  displayName: S.str,
  team: S.enum('alpha', 'bravo', 'unassigned'),
  ready: S.bool,
  isOwner: S.bool,
  isLocal: S.bool,
  connection: S.enum('connected', 'reconnecting', 'disconnected'),
  estimatedRttMs: S.nullable(S.int),
  loadout: S.obj({ primaryIdx: S.int, secondaryIdx: S.int }),
  joinedAt: S.iso,
});

const COUNTDOWN = S.obj({ endsAt: S.iso, requiredReady: S.int, currentReady: S.int });

const CONSENT = S.obj({ telemetryPersonal: S.bool, policyVersion: S.int, decidedAt: S.iso });

const SETUP_STEPS = ['eligibility', 'consent', 'display-name', 'verify', 'terms', 'essential-settings'];

const PROFILE_ME_KEYS = {
  accountId: S.ulid,
  displayName: S.str,
  createdAt: S.iso,
  privacy: S.obj({
    presenceVisibility: S.enum('everyone', 'friends', 'nobody'),
    statsVisibility: S.enum('everyone', 'nobody'),
  }),
  consent: S.nullable(CONSENT),
  moderation: S.obj({ status: S.enum('clear', 'restricted', 'banned'), activeSanctions: S.arr(S.any) }),
  flags: S.obj({
    nameChangeAvailableAt: S.nullable(S.iso),
    setupNextStep: S.nullable(S.enum(...SETUP_STEPS)),
  }),
};

const STATS_BODY_KEYS = {
  accountId: S.ulid,
  mode: S.enum('tdm', 'bomb'),
  statDefinitionVersion: S.str,
  totals: S.obj(Object.fromEntries([
    'kills', 'deaths', 'assists', 'suicides', 'teamKills', 'headshots', 'shotsFired', 'shotsHit',
    'damageDealt', 'plants', 'defuses', 'matches', 'wins', 'losses', 'draws', 'roundsPlayed',
    'timePlayedSec',
  ].map((k) => [k, S.int]))),
  weapons: S.record(S.obj({ shots: S.int, hits: S.int, kills: S.int, headshots: S.int })),
};

const SESSION = S.obj({ sessionId: S.ulid, deviceLabel: S.str, createdAt: S.iso });

const AUTH_BODY = S.obj({
  accessToken: S.str,
  expiresAt: S.iso,
  session: SESSION,
  profile: S.obj(PROFILE_ME_KEYS),
  consentReceipt: S.nullable(S.str),
  ...CORRELATION,
});

const HISTORY_ITEM = S.oneOf(
  S.obj({
    matchId: S.ulid,
    status: S.enum('completed', 'aborted', 'invalidated'),
    mode: S.enum('tdm', 'bomb'),
    mapId: S.str,
    mapVersion: S.str,
    endedAt: S.iso,
    result: S.nullable(S.enum('win', 'loss', 'draw')),
    teamScores: S.obj({ alpha: S.int, bravo: S.int }),
    playerSummary: S.obj({ kills: S.int, deaths: S.int, assists: S.int, score: S.int }),
  }),
  S.obj({
    matchId: S.ulid,
    status: S.enum('pending'),
    mode: S.enum('tdm', 'bomb'),
    mapId: S.str,
    mapVersion: S.str,
    endedAt: S.nullable(S.iso),
    result: S.nullable(S.any),
    teamScores: S.nullable(S.any),
    playerSummary: S.nullable(S.any),
  }),
);

const RULES_SNAPSHOT = S.obj(Object.fromEntries([
  'killLimit', 'roundsToWin', 'maxRounds', 'sideSwitchAfter', 'roundLengthSec', 'bombTimerSec',
  'defuseSec', 'plantSec', 'freezeSec',
].map((k) => [k, S.nullable(S.int)]).concat([['overtime', S.nullable(S.bool)]])));

const RESULT_PLAYER = S.obj({
  accountId: S.ulid, displayName: S.str, team: S.enum('alpha', 'bravo'),
  role: S.nullable(S.enum('attacker', 'defender')),
  kills: S.int, deaths: S.int, assists: S.int, suicides: S.int, teamKills: S.int,
  headshots: S.int, shotsFired: S.int, shotsHit: S.int, damageDealt: S.int,
  plants: S.int, defuses: S.int, roundsPlayed: S.int, timePlayedSec: S.int, score: S.int,
  disconnected: S.bool, abandoned: S.bool,
  joinedAt: S.iso, leftAt: S.nullable(S.iso),
  weapons: S.record(S.obj({ shots: S.int, hits: S.int, kills: S.int, headshots: S.int })),
});

const RESULT_ROUND = S.obj({
  index: S.int,
  winner: S.enum('alpha', 'bravo'),
  reason: S.enum('elimination', 'defuse', 'detonation', 'timer'),
  startedAt: S.iso, endedAt: S.iso,
  roles: S.obj({ alpha: S.enum('attacker', 'defender'), bravo: S.enum('attacker', 'defender') }),
  plant: S.nullable(S.obj({ accountId: S.ulid, site: S.enum('A', 'B'), at: S.iso })),
  defuse: S.nullable(S.obj({ accountId: S.ulid, at: S.iso })),
});

const TERMINAL_RESULT = S.obj({
  matchId: S.ulid,
  status: S.enum('completed', 'aborted', 'invalidated'),
  rulesetVersion: S.str, statDefinitionVersion: S.str, rulesSnapshot: RULES_SNAPSHOT,
  serverBuild: S.str, mapId: S.str, mapVersion: S.str, region: S.str,
  mode: S.enum('tdm', 'bomb'),
  startedAt: S.iso, endedAt: S.iso,
  terminationReason: S.enum('completed', 'aborted', 'invalidated'),
  outcomeReason: S.enum('elimination', 'defuse', 'detonation', 'timer', 'forfeit', 'abandon', 'no-contest'),
  winnerTeam: S.nullable(S.enum('alpha', 'bravo', 'draw')),
  invalidationReason: S.nullable(S.enum('cheat-detected', 'server-fault', 'roster-fault', 'admin-review')),
  roster: S.arr(S.obj({ accountId: S.ulid, team: S.enum('alpha', 'bravo'), joinedAt: S.iso, leftAt: S.nullable(S.iso) })),
  teamScores: S.obj({ alpha: S.int, bravo: S.int }),
  rounds: S.arr(RESULT_ROUND),
  players: S.arr(RESULT_PLAYER),
  evidenceRef: S.str,
  ...CORRELATION,
});

const PENDING_RESULT = S.obj({
  matchId: S.ulid, status: S.enum('pending'),
  mode: S.enum('tdm', 'bomb'), mapId: S.str, mapVersion: S.str,
  startedAt: S.iso, endedAt: S.nullable(S.iso), retryAfterMs: S.int,
  ...CORRELATION,
});

const HANDOFF = S.obj({
  matchId: S.ulid, serverUrl: S.str, sessionTicket: S.str, expiresAt: S.iso,
  reconnectGraceMs: S.int, mapId: S.str, mapVersion: S.str,
  mode: S.enum('tdm', 'bomb'), rulesetVersion: S.str, region: S.str, serverBuild: S.str,
  protocolVersion: S.int,
  series: S.obj({ roundsToWin: S.int, maxRounds: S.int, sideSwitchAfter: S.int, overtime: S.bool }),
  spectatorPolicyVersion: S.int,
  sites: S.arr(S.obj({
    id: S.str, site: S.enum('A', 'B'), callout: S.str,
    center: S.obj({ x: S.any, y: S.any, z: S.any }),
    box: S.obj({ min: S.obj({ x: S.any, y: S.any, z: S.any }), max: S.obj({ x: S.any, y: S.any, z: S.any }) }),
  })),
});

const RESERVATION = S.obj({
  reservationId: S.ulid, expiresAt: S.iso, lobbySocketUrl: S.str, lobbyTicket: S.str, ...CORRELATION,
});

const PRESENCE = S.nullable(S.obj({
  state: S.enum('online', 'in-lobby', 'in-match'), joinable: S.bool, roomId: S.nullable(S.ulid),
}));

/** Which shape a (pattern, status, body) triple must satisfy. */
function specFor(pattern, body) {
  switch (pattern) {
    case 'POST /v1/auth/signup':
    case 'POST /v1/auth/signin':
      return AUTH_BODY;
    case 'POST /v1/auth/refresh':
      return S.obj({ accessToken: S.str, expiresAt: S.iso, session: SESSION, ...CORRELATION });
    case 'GET /v1/auth/sessions':
      return S.obj({
        sessions: S.arr(S.obj({
          sessionId: S.ulid, deviceLabel: S.str, userAgentClass: S.str, ipClass: S.str,
          createdAt: S.iso, lastSeenAt: S.iso, isCurrent: S.bool,
        })),
        ...CORRELATION,
      });
    case 'POST /v1/onboarding/eligibility':
      return S.obj({ eligible: S.bool, receipt: S.str, expiresAt: S.iso, policyVersion: S.int, ...CORRELATION });
    case 'GET /v1/onboarding/consent':
    case 'PUT /v1/onboarding/consent':
      return S.obj({
        telemetryPersonal: S.bool, policyVersion: S.int, decidedAt: S.iso,
        subject: S.enum('account', 'client-session'), receipt: S.str, ...CORRELATION,
      });
    case 'GET /v1/onboarding/terms':
      return S.obj({ version: S.int, url: S.str, publishedAt: S.iso, ...CORRELATION });
    case 'GET /v1/profile/me':
    case 'PATCH /v1/profile/me':
      return S.obj({ ...PROFILE_ME_KEYS, ...CORRELATION });
    case 'GET /v1/profile/me/settings':
    case 'PUT /v1/profile/me/settings':
      return S.obj({ schemaVersion: S.int, version: S.int, values: S.any, updatedAt: S.iso, ...CORRELATION });
    case 'GET /v1/profile/:accountId':
      return S.obj({
        accountId: S.ulid, displayName: S.str, createdAt: S.iso,
        stats: S.nullable(S.obj(STATS_BODY_KEYS)),
        presence: PRESENCE,
        ...CORRELATION,
      });
    case 'GET /v1/profile/:accountId/stats':
      return body.modes
        ? S.obj({ modes: S.obj({ tdm: S.obj(STATS_BODY_KEYS), bomb: S.obj(STATS_BODY_KEYS) }), ...CORRELATION })
        : S.obj({ ...STATS_BODY_KEYS, ...CORRELATION });
    case 'GET /v1/profile/:accountId/matches':
      return S.obj({ items: S.arr(HISTORY_ITEM), nextCursor: S.nullable(S.str), ...CORRELATION });
    case 'GET /v1/presence/online':
    case 'GET /v1/presence/recent':
      return S.obj({
        items: S.arr(S.obj({
          accountId: S.ulid, displayName: S.str,
          state: S.enum('online', 'in-lobby', 'in-match'), joinable: S.bool, roomId: S.nullable(S.ulid),
        })),
        nextCursor: S.nullable(S.str), ...CORRELATION,
      });
    case 'GET /v1/rooms':
      return S.obj({ items: S.arr(S.obj(ROOM_CORE_KEYS)), nextCursor: S.nullable(S.str), ...CORRELATION });
    case 'POST /v1/rooms':
      return S.obj({
        room: S.obj(ROOM_CORE_KEYS), roster: S.arr(ROSTER_MEMBER), countdown: S.nullable(COUNTDOWN),
        reservationId: S.ulid, expiresAt: S.iso, lobbySocketUrl: S.str, lobbyTicket: S.str, ...CORRELATION,
      });
    case 'GET /v1/rooms/:id':
    case 'POST /v1/rooms/:id/team':
    case 'POST /v1/rooms/:id/ready':
    case 'POST /v1/rooms/:id/loadout':
      return S.obj({
        ...ROOM_CORE_KEYS, roster: S.arr(ROSTER_MEMBER), countdown: S.nullable(COUNTDOWN), ...CORRELATION,
      });
    case 'POST /v1/rooms/:id/join':
      return RESERVATION;
    case 'POST /v1/rooms/:id/reconnect-ticket':
      return S.obj({ lobbySocketUrl: S.str, lobbyTicket: S.str, expiresAt: S.iso, graceEndsAt: S.iso, ...CORRELATION });
    case 'GET /v1/matches/active':
      return S.obj({ matchId: S.ulid, roomId: S.ulid, graceEndsAt: S.iso, serverNow: S.iso, ...CORRELATION });
    case 'GET /v1/matches/:matchId':
      return body.status === 'pending' ? PENDING_RESULT : TERMINAL_RESULT;
    case 'POST /v1/matches/:matchId/reconnect-ticket':
      return S.obj({ handoff: HANDOFF, graceEndsAt: S.iso, serverNow: S.iso, ...CORRELATION });
    case 'POST /v1/reports':
      return S.obj({ reportId: S.ulid, ...CORRELATION });
    case 'GET /v1/config/flags':
      return S.obj({ version: S.int, evaluatedAt: S.iso, expiresAt: S.iso, flags: S.record(S.bool), ...CORRELATION });
    case 'GET /v1/config/regions':
      return S.obj({
        regions: S.arr(S.obj({ id: S.str, label: S.str, probeUrl: S.str, available: S.bool })), ...CORRELATION,
      });
    case 'GET /v1/health':
      return S.obj({ ok: S.bool, ...CORRELATION });
    case 'GET /v1/health/ready':
      return S.obj({ ok: S.bool, dependencies: S.record(S.enum('up', 'down')), ...CORRELATION });
    default:
      return null;
  }
}

const ERROR_ENVELOPE = S.obj({
  error: S.obj({
    code: S.str, message: S.str, correlationId: S.ulid,
    retryable: S.bool, retryAfterMs: S.nullable(S.int), details: S.any,
  }),
});

/** Which route pattern a request hit, for spec selection. Mirrors the stub's own matcher. */
const PATTERNS = api().routePatterns;
function patternFor(method, path) {
  const parts = path.split('/').filter(Boolean);
  for (const pattern of PATTERNS) {
    const [m, p] = pattern.split(' ');
    if (m !== method) continue;
    const segs = p.split('/').filter(Boolean);
    if (segs.length !== parts.length) continue;
    if (segs.every((s, i) => s.startsWith(':') || s === parts[i])) return pattern;
  }
  return null;
}

/** Validate one response against the contract. Returns a list of problems. */
function validateResponse(req, res) {
  const problems = [];
  if (res.transport === 'failed') return problems;              // no envelope exists to check
  const pattern = patternFor((req.method || 'GET').toUpperCase(), req.path);
  if (!pattern) { problems.push(`${req.method} ${req.path}: no route matched`); return problems; }

  if (res.status === 204) {
    if (res.body !== null) problems.push(`${pattern}: 204 carried a body`);
    if (!res.headers['X-Correlation-Id']) problems.push(`${pattern}: 204 without X-Correlation-Id`);
    return problems;
  }
  if (res.status >= 400) {
    validate(res.body, ERROR_ENVELOPE, `${pattern}!error`, problems);
    const code = res.body?.error?.code;
    const spec = CODES[code];
    if (!spec) problems.push(`${pattern}: ${code} is not in the errors.md enumeration`);
    else {
      if (spec.status !== res.status) problems.push(`${pattern}: ${code} must be HTTP ${spec.status}, got ${res.status}`);
      if (spec.retryable !== res.body.error.retryable) problems.push(`${pattern}: ${code} retryable must be ${spec.retryable}`);
    }
    return problems;
  }
  if (res.status === 202) {
    validate(res.body, S.obj({ ...CORRELATION }), `${pattern}!202`, problems);
    return problems;
  }
  const spec = specFor(pattern, res.body || {});
  if (!spec) { problems.push(`${pattern}: no shape declared in the test`); return problems; }
  validate(res.body, spec, pattern, problems);

  // §11.9: a settings body may only carry ROAM keys from vocabulary version 1.
  if (pattern.endsWith('/v1/profile/me/settings')) {
    for (const key of Object.keys(res.body.values)) {
      if (key === 'keybinds') {
        for (const action of Object.keys(res.body.values.keybinds)) {
          if (!Object.hasOwn(VOCABULARY.keybinds, action)) problems.push(`${pattern}: keybind ${action} is outside vocabulary v1`);
        }
        continue;
      }
      if (!Object.hasOwn(VOCABULARY.roam, key)) problems.push(`${pattern}: ${key} is not a ROAM setting`);
    }
  }

  // match-result.md §4.2: the status-dependent invariants are what make the union checkable.
  if (pattern === 'GET /v1/matches/:matchId' && res.body.status !== 'pending') {
    const b = res.body;
    if (b.terminationReason !== b.status) problems.push(`${pattern}: terminationReason must equal status`);
    if (b.status === 'completed') {
      if (!['elimination', 'defuse', 'detonation', 'timer'].includes(b.outcomeReason)) problems.push(`${pattern}: completed outcomeReason ${b.outcomeReason}`);
      if (!['alpha', 'bravo', 'draw'].includes(b.winnerTeam)) problems.push(`${pattern}: completed needs a winner or a draw`);
      if (b.invalidationReason !== null) problems.push(`${pattern}: completed must carry invalidationReason null`);
    }
    if (b.status === 'aborted') {
      if (!['forfeit', 'abandon', 'no-contest'].includes(b.outcomeReason)) problems.push(`${pattern}: aborted outcomeReason ${b.outcomeReason}`);
      const wantsWinner = b.outcomeReason !== 'no-contest';
      if (wantsWinner && !['alpha', 'bravo'].includes(b.winnerTeam)) problems.push(`${pattern}: aborted by ${b.outcomeReason} carries a real winner`);
      if (!wantsWinner && b.winnerTeam !== null) problems.push(`${pattern}: aborted no-contest has no winner`);
      if (b.invalidationReason !== null) problems.push(`${pattern}: aborted must carry invalidationReason null`);
    }
    if (b.status === 'invalidated') {
      if (b.outcomeReason !== 'no-contest') problems.push(`${pattern}: invalidated outcomeReason must be no-contest`);
      if (b.winnerTeam !== null) problems.push(`${pattern}: invalidated has no winner`);
      if (b.invalidationReason === null) problems.push(`${pattern}: invalidated needs a non-null invalidationReason`);
    }
    const alpha = b.rounds.filter((r) => r.winner === 'alpha').length;
    const bravo = b.rounds.filter((r) => r.winner === 'bravo').length;
    if (b.mode === 'bomb' && (alpha !== b.teamScores.alpha || bravo !== b.teamScores.bravo)) {
      problems.push(`${pattern}: rounds (${alpha}-${bravo}) disagree with teamScores (${b.teamScores.alpha}-${b.teamScores.bravo})`);
    }
  }
  return problems;
}

/** Resolve a probe list to the concrete requests a run made, for validation. */
function concrete(requests, responses) {
  const out = [];
  for (let i = 0; i < requests.length; i++) {
    const entry = requests[i];
    out.push(typeof entry === 'function' ? entry(responses.slice(0, i)) : entry);
  }
  return out;
}

// ── 3. every §11.10 scenario exists and is reachable ────────────────────────────────────────

console.log('\n--- §11.10 scenario coverage ---');
{
  const stub = api();
  const missing = contractScenarios.filter((n) => !stub.hasScenario(n));
  check(missing.length === 0, 'every scenario in §11.10 exists in the registry',
    `missing: ${missing.join(', ')}`);

  const extra = Object.keys(SCENARIOS).filter((n) => !contractScenarios.includes(n));
  const undeclared = extra.filter((n) => !Object.hasOwn(EXTRA_SCENARIOS, n));
  check(undeclared.length === 0,
    'every scenario beyond §11.10 is declared in EXTRA_SCENARIOS with the route state it serves',
    `undeclared: ${undeclared.join(', ')}`);
  const staleDeclaration = Object.keys(EXTRA_SCENARIOS).filter((n) => !Object.hasOwn(SCENARIOS, n));
  check(staleDeclaration.length === 0, 'EXTRA_SCENARIOS names no scenario that does not exist',
    `stale: ${staleDeclaration.join(', ')}`);

  const noProbe = [...contractScenarios, ...extra].filter((n) => !SCENARIO_PROBES[n]);
  check(noProbe.length === 0, 'every scenario has a request sequence that drives it',
    `no probe: ${noProbe.join(', ')}`);

  const unreachable = [];
  const shapeProblems = [];
  for (const name of [...contractScenarios, ...extra]) {
    const probe = SCENARIO_PROBES[name] || [];
    const responses = await run(stub, name, `reach-${name}`, probe);
    const requests = concrete(probe, responses);
    if (!responses.length) { unreachable.push(`${name}: no requests`); continue; }
    for (let i = 0; i < responses.length; i++) {
      const res = responses[i];
      if (res.transport === 'failed') continue;
      if (typeof res.status !== 'number') { unreachable.push(`${name}[${i}]: no status`); continue; }
      if (res.status === 404 && res.body?.error?.code === 'NOT_FOUND' && !patternFor(requests[i].method, requests[i].path)) {
        unreachable.push(`${name}[${i}]: ${requests[i].method} ${requests[i].path} matched no route`);
      }
      shapeProblems.push(...validateResponse(requests[i], res).map((p) => `${name}: ${p}`));
    }
  }
  check(unreachable.length === 0, 'every scenario is reachable and answers every request',
    unreachable.slice(0, 5).join('\n       '));
  check(shapeProblems.length === 0, 'every response validates against the contract shape',
    `${shapeProblems.length} problems, first 6:\n       ${shapeProblems.slice(0, 6).join('\n       ')}`);
}

// ── 4. the §11.11 coverage map, and the shell-ia route × variant matrix ─────────────────────

console.log('\n--- §11.11 coverage map ---');
{
  const stub = api();
  const contractRows = Object.keys(contractCoverage);
  const mappedRows = Object.keys(COVERAGE_MAP);
  const missingRows = contractRows.filter((r) => !mappedRows.includes(r));
  const extraRows = mappedRows.filter((r) => !contractRows.includes(r));
  check(missingRows.length === 0, 'every route in the coverage map is claimed by the stub layer',
    `unclaimed: ${missingRows.join(' | ')}`);
  check(extraRows.length === 0, 'the stub layer claims no route the contract does not list',
    `extra: ${extraRows.join(' | ')}`);

  const ownerMismatch = [];
  for (const row of contractRows) {
    const want = contractCoverage[row];
    const got = COVERAGE_MAP[row] || [];
    if (JSON.stringify(want) !== JSON.stringify(got)) ownerMismatch.push(`${row}: contract ${want.join(',')} vs stub ${got.join(',')}`);
  }
  check(ownerMismatch.length === 0, 'owning scenarios match the contract row for row',
    ownerMismatch.join('\n       '));

  const dead = [];
  for (const [row, owners] of Object.entries(contractCoverage)) {
    for (const owner of owners) {
      const probe = SCENARIO_PROBES[owner];
      if (!probe) { dead.push(`${row} -> ${owner}: no probe`); continue; }
      const responses = await run(stub, owner, `cov-${row}-${owner}`, probe);
      const answered = responses.every((r) => r.transport === 'failed' || typeof r.status === 'number');
      if (!answered) dead.push(`${row} -> ${owner}: a request went unanswered`);
    }
  }
  check(dead.length === 0, 'every owning scenario actually runs', dead.join('\n       '));

  // Every §11.11 label maps onto a real shell-ia route, so the two vocabularies cannot drift.
  const unmapped = contractRows.filter((r) => !COVERAGE_MAP_ROUTES[r]);
  const badTarget = Object.values(COVERAGE_MAP_ROUTES).flat().filter((r) => !contractRoutes.includes(r));
  check(unmapped.length === 0 && badTarget.length === 0,
    'every §11.11 label resolves to a route in the shell-ia hierarchy',
    `unmapped: ${unmapped.join(' | ')} · unknown: ${badTarget.join(' | ')}`);
}

console.log('\n--- shell-ia route × variant coverage (REQ-CC-045) ---');
{
  const stub = api();
  const missingRoutes = contractRoutes.filter((r) => !ROUTE_COVERAGE[r]);
  const inventedRoutes = Object.keys(ROUTE_COVERAGE).filter((r) => !contractRoutes.includes(r));
  check(missingRoutes.length === 0, 'every route in the shell-ia hierarchy has a coverage entry',
    `uncovered: ${missingRoutes.join(' | ')}`);
  check(inventedRoutes.length === 0, 'the coverage map invents no route the IA does not declare',
    `invented: ${inventedRoutes.join(' | ')}`);

  const problems = [];
  for (const route of contractRoutes) {
    const entry = ROUTE_COVERAGE[route] || {};
    for (const variant of VARIANTS) {
      const cell = entry[variant];
      if (!cell) { problems.push(`${route}.${variant}: no entry`); continue; }
      if (cell.scenario === null) {
        if (!cell.why) problems.push(`${route}.${variant}: not-applicable without a reason`);
        continue;
      }
      if (cell.scenario.startsWith('lobby:')) {
        const timeline = cell.scenario.slice('lobby:'.length);
        if (!LOBBY_SCENARIO_NAMES.includes(timeline)) problems.push(`${route}.${variant}: no lobby timeline ${timeline}`);
        else if (!createLobbyStub({ scenario: timeline }).serverFrames().length) {
          problems.push(`${route}.${variant}: timeline ${timeline} emits nothing`);
        }
        continue;
      }
      if (!Object.hasOwn(SCENARIOS, cell.scenario)) { problems.push(`${route}.${variant}: no scenario ${cell.scenario}`); continue; }
      if (!cell.requests.length) { problems.push(`${route}.${variant}: no requests to reach it`); continue; }
      const responses = await run(stub, cell.scenario, `route-${route}-${variant}`, cell.requests);
      const requests = concrete(cell.requests, responses);
      const last = responses[responses.length - 1];
      if (last.transport !== 'failed' && typeof last.status !== 'number') {
        problems.push(`${route}.${variant}: unanswered`);
        continue;
      }
      // The variant has to be what the map claims it is. `expect` is declared per cell because
      // several policy states are contract-required successes rather than refusals.
      const expected = cell.expect
        || (variant === 'offline' ? 'drop' : (variant === 'error' || variant === 'policy') ? 'refusal' : 'ok');
      const actual = last.transport === 'failed' ? 'drop' : (last.status >= 400 ? 'refusal' : 'ok');
      if (actual !== expected) {
        problems.push(`${route}.${variant}: expected ${expected}, got ${actual} (${last.status}/${last.body?.error?.code})`);
      }
      for (let i = 0; i < responses.length; i++) {
        problems.push(...validateResponse(requests[i], responses[i]).map((p) => `${route}.${variant}: ${p}`));
      }
    }
  }
  check(problems.length === 0, 'every route × variant is served by a scenario that runs and validates',
    `${problems.length} problems, first 8:\n       ${problems.slice(0, 8).join('\n       ')}`);
}

// ── 5. the transitions that a canned fixture cannot express ─────────────────────────────────

console.log('\n--- stateful transitions ---');
{
  const stub = api();
  const eligibility = { method: 'POST', path: '/v1/onboarding/eligibility', body: { dateOfBirth: '1994-03-02', jurisdiction: 'CA-ON' } };
  const consentAccept = (sid) => ({ method: 'PUT', path: '/v1/onboarding/consent', body: { telemetryPersonal: true, policyVersion: 1, clientSessionId: sid } });
  const signupFrom = (sid) => (prev) => {
    const elig = [...prev].reverse().find((r) => r.body && r.body.eligible === true);
    const consent = [...prev].reverse().find((r) => r.body && typeof r.body.subject === 'string');
    return {
      method: 'POST', path: '/v1/auth/signup',
      body: {
        email: 'a@b.invalid', password: 'p', displayName: 'n',
        eligibilityReceipt: elig?.body?.receipt, clientSessionId: sid, consentReceipt: consent?.body?.receipt,
      },
    };
  };
  const signin = { method: 'POST', path: '/v1/auth/signin', body: { email: 'a@b.invalid', password: 'p' } };
  const onboard = (sid) => [eligibility, consentAccept(sid), signupFrom(sid)];

  // verify-invalid: fail, resend, succeed. And crucially: it does NOT succeed without a resend.
  for (const [scenario, code] of [
    ['onboarding-verify-invalid', 'AUTH_VERIFICATION_TOKEN_INVALID'],
    ['onboarding-verify-expired', 'AUTH_VERIFICATION_TOKEN_EXPIRED'],
  ]) {
    const verify = { method: 'POST', path: '/v1/onboarding/verify/complete', body: { token: 't' } };
    const resend = { method: 'POST', path: '/v1/onboarding/verify/resend', body: {} };
    const noResend = await run(stub, scenario, `${scenario}-noresend`, [...onboard(`${scenario}-noresend`), verify, verify]);
    const [first, second] = noResend.slice(-2);
    check(first.status === 400 && first.body.error.code === code
      && second.status === 400 && second.body.error.code === code,
    `${scenario}: verify keeps failing until a resend`,
    `got ${first.status}/${first.body?.error?.code} then ${second.status}/${second.body?.error?.code}`);

    const sequence = await run(stub, scenario, `${scenario}-resend`, [...onboard(`${scenario}-resend`), verify, resend, verify]);
    const [a, b, c] = sequence.slice(-3);
    check(a.status === 400 && a.body.error.code === code && b.status === 202 && c.status === 204,
      `${scenario}: fails, resends, then succeeds`,
      `got ${a.status}/${a.body?.error?.code}, ${b.status}, ${c.status}`);
  }

  // result-pending-live: pending for EXACTLY 3 polls, then completed.
  {
    const poll = { method: 'GET', path: `/v1/matches/${fx.MATCH_ID}` };
    const res = (await run(stub, 'result-pending-live', 'pending-live', [signin, poll, poll, poll, poll, poll])).slice(1);
    const statuses = res.map((r) => r.body.status);
    check(JSON.stringify(statuses) === JSON.stringify(['pending', 'pending', 'pending', 'completed', 'completed']),
      'result-pending-live: pending exactly 3 times, then completed', statuses.join(','));
    check(res.slice(0, 3).every((r) => r.body.endedAt === null),
      'result-pending-live: endedAt is null while live', 'a live pending carried an endedAt');
  }

  // result-pending-queued: 2 polls, and endedAt is SET because the match really did end.
  {
    const poll = { method: 'GET', path: `/v1/matches/${fx.MATCH_ID}` };
    const res = (await run(stub, 'result-pending-queued', 'pending-queued', [signin, poll, poll, poll, poll])).slice(1);
    const statuses = res.map((r) => r.body.status);
    check(JSON.stringify(statuses) === JSON.stringify(['pending', 'pending', 'completed', 'completed']),
      'result-pending-queued: pending exactly 2 times, then completed', statuses.join(','));
    check(res.slice(0, 2).every((r) => typeof r.body.endedAt === 'string'),
      'result-pending-queued: endedAt is set while queued', 'a queued pending had endedAt null');
  }

  // onboarding-happy: the consent decision migrates onto the account at signup.
  {
    const sid = 'happy-migration';
    const [elig, consent, signupRes] = await run(stub, 'onboarding-happy', sid, onboard(sid));
    check(elig.status === 200 && elig.body.eligible === true && elig.body.minimumAge === undefined,
      'onboarding-happy: eligibility passes and never publishes minimumAge',
      JSON.stringify(elig.body));
    check(consent.body.subject === 'client-session' && typeof consent.body.receipt === 'string',
      'onboarding-happy: signed-out consent is keyed to the client session',
      JSON.stringify(consent.body));
    check(signupRes.status === 201
      && signupRes.body.consentReceipt !== null
      && signupRes.body.consentReceipt !== consent.body.receipt
      && signupRes.body.profile.consent.telemetryPersonal === true,
    'onboarding-happy: signup migrates the receipt and issues an account-scoped one',
    `session receipt ${consent.body.receipt} vs account receipt ${signupRes.body.consentReceipt}`);

    // The gates then clear in order: verification first, terms second, shell third.
    const join = { method: 'POST', path: `/v1/rooms/${fx.ROOM_IDS[0]}/join`, body: {} };
    const gatedRun = await run(stub, 'onboarding-happy', `${sid}-gate`, [...onboard(`${sid}-gate`), join]);
    const gated = gatedRun[gatedRun.length - 1];
    check(gated.status === 403 && gated.body.error.code === 'AUTH_VERIFICATION_REQUIRED',
      'onboarding-happy: gameplay is gated on verification', `${gated.status}/${gated.body?.error?.code}`);
    const afterVerifyRun = await run(stub, 'onboarding-happy', `${sid}-verify`, [
      ...onboard(`${sid}-verify`), { method: 'POST', path: '/v1/onboarding/verify/complete', body: { token: 't' } }, join,
    ]);
    const afterVerify = afterVerifyRun[afterVerifyRun.length - 1];
    check(afterVerify.status === 403 && afterVerify.body.error.code === 'AUTH_TERMS_ACCEPTANCE_REQUIRED',
      'onboarding-happy: then gated on terms', `${afterVerify.status}/${afterVerify.body?.error?.code}`);
    const afterTermsRun = await run(stub, 'onboarding-happy', `${sid}-terms`, [
      ...onboard(`${sid}-terms`),
      { method: 'POST', path: '/v1/onboarding/verify/complete', body: { token: 't' } },
      { method: 'POST', path: '/v1/onboarding/terms/accept', body: { version: 1 } }, join,
    ]);
    const afterTerms = afterTermsRun[afterTermsRun.length - 1];
    check(afterTerms.status === 200, 'onboarding-happy: reaches the shell once both gates clear',
      `${afterTerms.status}/${afterTerms.body?.error?.code}`);
  }

  // consent-declined: still a successful signup, with the decline recorded on the account.
  {
    const sid = 'declined';
    const [, consent, signupRes] = await run(stub, 'onboarding-consent-declined', sid, [
      eligibility,
      { method: 'PUT', path: '/v1/onboarding/consent', body: { telemetryPersonal: true, policyVersion: 1, clientSessionId: sid } },
      signupFrom(sid),
    ]);
    check(consent.body.telemetryPersonal === false && signupRes.status === 201
      && signupRes.body.profile.consent.telemetryPersonal === false,
    'onboarding-consent-declined: declining is recorded and signup still succeeds',
    JSON.stringify({ consent: consent.body.telemetryPersonal, profile: signupRes.body.profile.consent }));
  }

  // terms-conflict: v1 conflicts against a v2 published underneath, then v2 is accepted.
  {
    const sid = 'terms';
    const res = await run(stub, 'onboarding-terms-conflict', sid, [
      ...onboard(sid),
      { method: 'GET', path: '/v1/onboarding/terms' },
      { method: 'POST', path: '/v1/onboarding/terms/accept', body: { version: 1 } },
      { method: 'GET', path: '/v1/onboarding/terms' },
      { method: 'POST', path: '/v1/onboarding/terms/accept', body: { version: 2 } },
    ]);
    const [t1, a1, t2, a2] = res.slice(-4);
    check(t1.body.version === 1 && a1.status === 409 && a1.body.error.code === 'CONFLICT'
      && a1.body.error.details.currentVersion === 2 && t2.body.version === 2 && a2.status === 204,
    'onboarding-terms-conflict: v1 conflicts against v2, then v2 is accepted',
    `${t1.body.version}, ${a1.status}/${a1.body?.error?.details?.currentVersion}, ${t2.body.version}, ${a2.status}`);
  }

  // room-password: prompt first, then any non-empty password works.
  {
    const room = fx.ROOM_IDS[0];
    const [, first, second] = await run(stub, 'room-password', 'pw', [
      signin,
      { method: 'POST', path: `/v1/rooms/${room}/join`, body: {} },
      { method: 'POST', path: `/v1/rooms/${room}/join`, body: { password: 'anything' } },
    ]);
    check(first.status === 401 && first.body.error.code === 'ROOM_PASSWORD_REQUIRED' && second.status === 200,
      'room-password: prompt, then succeed on the second attempt',
      `${first.status}/${first.body?.error?.code} then ${second.status}`);
  }

  // session-revoked: the third authenticated call, and every one after it.
  {
    const me = { method: 'GET', path: '/v1/profile/me' };
    const res = (await run(stub, 'session-revoked', 'revoked', [signin, me, me, me, me])).slice(1);
    check(res[0].status === 200 && res[1].status === 200
      && res[2].status === 401 && res[2].body.error.code === 'AUTH_SESSION_REVOKED'
      && res[3].status === 401,
    'session-revoked: the third authenticated call fails, and stays failing',
    res.map((r) => r.status).join(','));
  }

  // token-expiry: expires on virtual time, and a refresh actually restores service.
  {
    const me = { method: 'GET', path: '/v1/profile/me' };
    const res = await run(stub, 'token-expiry', 'expiry', [
      signin, me, me, me, { method: 'POST', path: '/v1/auth/refresh', body: {} }, me,
    ]);
    check(res[1].status === 200 && res[3].status === 401 && res[3].body.error.code === 'AUTH_TOKEN_EXPIRED'
      && res[4].status === 200 && res[5].status === 200,
    'token-expiry: expires after 30 virtual seconds, and a refresh restores service',
    res.map((r) => `${r.status}${r.body?.error ? `/${r.body.error.code}` : ''}`).join(','));
  }

  // browser-unreachable: rooms only. Auth must keep working, or the scenario is just `offline`.
  {
    const [, rooms, auth] = await run(stub, 'browser-unreachable', 'unreachable', [
      signin, { method: 'GET', path: '/v1/rooms' }, signin,
    ]);
    check(rooms.status === 503 && rooms.body.error.code === 'SERVICE_UNAVAILABLE' && auth.status === 200,
      'browser-unreachable: room endpoints only; auth unaffected',
      `${rooms.status} / ${auth.status}`);
  }

  // account-pre-policy: consent is null, and answering it fills it in.
  {
    const sid = 'prepolicy';
    const [, me, put, me2] = await run(stub, 'account-pre-policy', sid, [
      signin,
      { method: 'GET', path: '/v1/profile/me' },
      { method: 'PUT', path: '/v1/onboarding/consent', body: { telemetryPersonal: true, policyVersion: 1, clientSessionId: sid } },
      { method: 'GET', path: '/v1/profile/me' },
    ]);
    check(me.body.consent === null && put.status === 200 && me2.body.consent !== null,
      'account-pre-policy: consent starts null (undecided) and becomes an object once decided',
      JSON.stringify({ before: me.body.consent, after: me2.body.consent }));
    check(me.body.flags.setupNextStep === 'consent',
      'account-pre-policy: the profile names consent as the first incomplete step',
      JSON.stringify(me.body.flags));
  }

  // history-mixed: both variants of the §4.3 union in one page.
  {
    const [, res] = await run(stub, 'history-mixed', 'mixed', [signin, { method: 'GET', path: `/v1/profile/${fx.ACCOUNT_ID}/matches` }]);
    const kinds = new Set(res.body.items.map((i) => (i.status === 'pending' ? 'pending' : 'terminal')));
    check(kinds.has('pending') && kinds.has('terminal'),
      'history-mixed: terminal and pending items in one page', [...kinds].join(','));
    const pend = res.body.items.filter((i) => i.status === 'pending');
    check(pend.every((i) => i.result === null && i.teamScores === null && i.playerSummary === null),
      'history-mixed: pending items carry null outcomes, never absent keys',
      JSON.stringify(pend[0]));
  }

  // history-empty / privacy-filtered: the states a career screen must render without inventing data.
  {
    const [, stats, hist] = await run(stub, 'history-empty', 'empty', [
      signin,
      { method: 'GET', path: `/v1/profile/${fx.ACCOUNT_ID}/stats`, query: { mode: 'all' } },
      { method: 'GET', path: `/v1/profile/${fx.ACCOUNT_ID}/matches` },
    ]);
    check(hist.body.items.length === 0 && stats.body.modes.tdm.totals.matches === 0,
      'history-empty: zero matches and zero career totals',
      `${hist.body.items.length} items, ${stats.body.modes.tdm.totals.matches} matches`);

    const [, pub] = await run(stub, 'privacy-filtered', 'privacy', [signin, { method: 'GET', path: `/v1/profile/${fx.OTHER_ACCOUNT_ID}` }]);
    check(pub.status === 200 && pub.body.stats === null && pub.body.presence === null,
      'privacy-filtered: hidden fields are null, not omitted and not a 403',
      JSON.stringify(pub.body));
  }

  // offline is a transport behaviour, and must be visible as such.
  {
    const [off] = await run(stub, 'offline', 'off', [{ method: 'GET', path: '/v1/health' }]);
    check(off.transport === 'failed' && off.status === null && off.body === null,
      'offline: a transport failure, with no status and no envelope to mistake for one',
      JSON.stringify(off));
  }

  // match reconnect, all three branches.
  {
    const [, none] = await run(stub, 'match-active-none', 'man', [signin, { method: 'GET', path: '/v1/matches/active' }]);
    check(none.status === 204 && none.headers['X-Correlation-Id'],
      'match-active-none: 204 with a correlation id in the header', `${none.status}`);

    const [, active, ticket] = await run(stub, 'match-active-reconnect', 'mar', [
      signin,
      { method: 'GET', path: '/v1/matches/active' },
      { method: 'POST', path: `/v1/matches/${fx.MATCH_ID}/reconnect-ticket`, body: {} },
    ]);
    check(active.status === 200 && ticket.status === 200 && ticket.body.handoff.sites.length > 0
      && typeof ticket.body.graceEndsAt === 'string' && typeof ticket.body.serverNow === 'string',
    'match-active-reconnect: discovery then a complete handoff with graceEndsAt and serverNow',
    `${active.status}/${ticket.status}`);

    const [, , expired] = await run(stub, 'match-active-grace-expired', 'mage', [
      signin,
      { method: 'GET', path: '/v1/matches/active' },
      { method: 'POST', path: `/v1/matches/${fx.MATCH_ID}/reconnect-ticket`, body: {} },
    ]);
    check(expired.status === 409 && expired.body.error.code === 'RECONNECT_GRACE_EXPIRED'
      && expired.body.error.details.rejoinable === false && expired.body.error.details.reason === 'grace-expired',
    'match-active-grace-expired: the required details travel with the code',
    JSON.stringify(expired.body?.error?.details));
  }

  // active-lobby-resync: a reload finds the room without the client having remembered it.
  {
    const [, active, self, detail, ticket] = await run(stub, 'active-lobby-resync', 'resync',
      SCENARIO_PROBES['active-lobby-resync']);
    check(active.status === 204 && self.body.presence.state === 'in-lobby'
      && self.body.presence.roomId === fx.ROOM_IDS[0]
      && detail.status === 200 && ticket.status === 200 && typeof ticket.body.lobbyTicket === 'string',
    'active-lobby-resync: no held match, presence names the room, and a fresh lobby ticket is issued',
    `${active.status} / ${self.body?.presence?.state} / ${ticket.status}`);

    const [, noRoom] = await run(stub, 'default', 'resync-control', [signin, { method: 'GET', path: `/v1/profile/${fx.ACCOUNT_ID}` }]);
    check(noRoom.body.presence.state === 'online' && noRoom.body.presence.roomId === null,
      'control: an account in no room reports no room, rather than the last one it saw',
      JSON.stringify(noRoom.body?.presence));
  }

  // sanctioned: refused where it matters, readable where it does not.
  {
    const [, me, join] = await run(stub, 'sanctioned', 'sanc', [
      signin,
      { method: 'GET', path: '/v1/profile/me' },
      { method: 'POST', path: `/v1/rooms/${fx.ROOM_IDS[0]}/join`, body: {} },
    ]);
    check(me.status === 200 && me.body.moderation.status === 'restricted'
      && join.status === 403 && join.body.error.code === 'SANCTIONED' && join.body.error.details.sanction,
    'sanctioned: join refused with a sanction detail; profile still readable',
    `${me.status}/${join.status}`);
  }

  // name-taken, in both the places a name is chosen.
  {
    const [signupRes, , renamed] = await run(stub, 'name-taken', 'nt', SCENARIO_PROBES['name-taken']);
    check(signupRes.status === 409 && signupRes.body.error.code === 'NAME_TAKEN'
      && renamed.status === 409 && renamed.body.error.code === 'NAME_TAKEN',
    'name-taken: signup and rename both refuse', `${signupRes.status}/${renamed.status}`);
  }

  // browser-empty: the empty envelope, not a bare array and not an error.
  {
    const [, res] = await run(stub, 'browser-empty', 'be', [signin, { method: 'GET', path: '/v1/rooms' }]);
    check(res.status === 200 && Array.isArray(res.body.items) && res.body.items.length === 0
      && res.body.nextCursor === null && typeof res.body.correlationId === 'string',
    'browser-empty: { items: [], nextCursor: null, correlationId }', JSON.stringify(res.body));
  }

  // eligibility-denied is terminal, and never leaks the age it tested against.
  {
    const [res] = await run(stub, 'onboarding-eligibility-denied', 'ed', [
      { method: 'POST', path: '/v1/onboarding/eligibility', body: { dateOfBirth: '2020-01-01', jurisdiction: 'CA-ON' } },
    ]);
    const detail = JSON.stringify(res.body.error.details);
    check(res.status === 403 && res.body.error.code === 'AUTH_ELIGIBILITY_DENIED'
      && res.body.error.details.category === 'under-minimum-age'
      && !detail.includes('2020') && !/minimumAge|age":\s*\d/.test(detail),
    'onboarding-eligibility-denied: category only, never the birthdate or the computed age', detail);
  }

  // receipt-invalid: signup refuses the receipt rather than half-creating an account.
  {
    const sid = 'ri';
    const res = await run(stub, 'onboarding-receipt-invalid', sid, onboard(sid));
    const last = res[res.length - 1];
    check(last.status === 400 && last.body.error.code === 'ELIGIBILITY_RECEIPT_INVALID',
      'onboarding-receipt-invalid: signup refuses a stale receipt', `${last.status}/${last.body?.error?.code}`);
  }

  // room-full / room-in-progress: distinct codes, and the room shape explains itself.
  {
    const room = fx.ROOM_IDS[0];
    const [, detail, joined] = await run(stub, 'room-full', 'rf', [
      signin, { method: 'GET', path: `/v1/rooms/${room}` }, { method: 'POST', path: `/v1/rooms/${room}/join`, body: {} },
    ]);
    check(detail.body.joinBlockedReason === 'full' && joined.status === 409 && joined.body.error.code === 'ROOM_FULL',
      'room-full: the room says why, and the join refuses with ROOM_FULL',
      `${detail.body.joinBlockedReason}/${joined.body?.error?.code}`);

    const [, d2, j2] = await run(stub, 'room-in-progress', 'rip', [
      signin, { method: 'GET', path: `/v1/rooms/${room}` }, { method: 'POST', path: `/v1/rooms/${room}/join`, body: {} },
    ]);
    check(d2.body.status === 'in-progress' && j2.status === 409 && j2.body.error.code === 'ROOM_IN_PROGRESS',
      'room-in-progress: status and code agree', `${d2.body.status}/${j2.body?.error?.code}`);
  }

  // The default scenario has to actually be the §12 data set.
  {
    const [, rooms, hist] = await run(stub, 'default', 'def', [
      signin,
      { method: 'GET', path: '/v1/rooms' },
      { method: 'GET', path: `/v1/profile/${fx.ACCOUNT_ID}/matches`, query: { limit: '100' } },
    ]);
    const regions = new Set(rooms.body.items.map((r) => r.region));
    check(rooms.body.items.length === 3 && regions.size === 2,
      'default: 3 rooms across 2 regions (§12)', `${rooms.body.items.length} rooms, ${regions.size} regions`);
    check(hist.body.items.length === 20 && hist.body.items.every((i) => i.status !== 'pending'),
      'default: 20 terminal matches of history (§12)', `${hist.body.items.length} items`);
    const [, detail] = await run(stub, 'default', 'def2', [signin, { method: 'GET', path: `/v1/rooms/${rooms.body.items[1].roomId}` }]);
    check(detail.body.roster.length === 12 && detail.body.countdown !== null,
      'default: a 12-player roster with a live countdown (§12)',
      `${detail.body.roster.length} members, countdown ${detail.body.countdown === null ? 'null' : 'present'}`);
  }

  // §11.6: RTT is client-measured or it is absent. It is never invented.
  {
    const auth = { 'X-Client-Build': CLIENT_BUILD, Authorization: 'Bearer stub.access.probe' };
    const stub2 = api();
    const withHeader = raw(stub2, 'default', 'rtt', { path: '/v1/rooms' }, { ...auth, 'X-Region-Rtt': 'yyz=24,ord=41' });
    const malformed = raw(stub2, 'default', 'rtt2', { path: '/v1/rooms' }, { ...auth, 'X-Region-Rtt': 'yyz=abc' });
    const absent = raw(stub2, 'default', 'rtt3', { path: '/v1/rooms' }, auth);
    check(withHeader.body.items.every((r) => Number.isInteger(r.estimatedRttMs))
      && malformed.body.items.every((r) => r.estimatedRttMs === null)
      && absent.body.items.every((r) => r.estimatedRttMs === null),
    'X-Region-Rtt: measured values are echoed; malformed or absent means null everywhere',
    JSON.stringify([withHeader.body.items[0].estimatedRttMs, malformed.body.items[0].estimatedRttMs]));
  }
}

// ── 6. prerequisites, room identity, settings round-trip, and the delay ─────────────────────

console.log('\n--- prerequisite state (§3a approved order) ---');
{
  const stub = api();
  const sid = 'prereq';
  const eligibility = { method: 'POST', path: '/v1/onboarding/eligibility', body: { dateOfBirth: '1994-03-02', jurisdiction: 'CA-ON' } };
  const consent = { method: 'PUT', path: '/v1/onboarding/consent', body: { telemetryPersonal: true, policyVersion: 1, clientSessionId: sid } };
  const invented = {
    method: 'POST', path: '/v1/auth/signup',
    body: { email: 'a@b.invalid', password: 'p', displayName: 'n',
      eligibilityReceipt: 'invented', clientSessionId: sid, consentReceipt: 'invented' },
  };

  // Driven under a scenario that starts SIGNED OUT, because that is who the approved order is
  // for: a signed-in caller is a stronger subject and §3a.3 stops applying to them.
  const [skipped] = await run(stub, 'onboarding-happy', 'prereq-1', [invented]);
  check(skipped.status === 403 && skipped.body.error.code === 'AUTH_ELIGIBILITY_REQUIRED',
    'signup with no eligibility on record is refused, not accepted with an invented receipt',
    `${skipped.status}/${skipped.body?.error?.code}`);

  const [, afterElig] = await run(stub, 'onboarding-happy', 'prereq-2', [eligibility, invented]);
  check(afterElig.status === 400 && afterElig.body.error.code === 'ELIGIBILITY_RECEIPT_INVALID',
    'a receipt this session was never issued is ELIGIBILITY_RECEIPT_INVALID',
    `${afterElig.status}/${afterElig.body?.error?.code}`);

  const [, realElig] = await run(stub, 'onboarding-happy', 'prereq-3', [eligibility,
    (prev) => ({ method: 'POST', path: '/v1/auth/signup',
      body: { email: 'a@b.invalid', password: 'p', displayName: 'n',
        eligibilityReceipt: prev[0].body.receipt, clientSessionId: sid, consentReceipt: 'invented' } })]);
  check(realElig.status === 400 && realElig.body.error.details.fields[0].path === 'consentReceipt',
    'a real eligibility receipt with no consent decision still refuses, naming consentReceipt',
    JSON.stringify(realElig.body?.error?.details));

  // The failing control: the whole chain, in order, with the receipts it actually issued.
  const chain = await run(stub, 'onboarding-happy', 'prereq-4', [eligibility, consent,
    (prev) => ({ method: 'POST', path: '/v1/auth/signup',
      body: { email: 'a@b.invalid', password: 'p', displayName: 'n',
        eligibilityReceipt: prev[0].body.receipt, clientSessionId: sid, consentReceipt: prev[1].body.receipt } })]);
  check(chain[2].status === 201, 'control: the approved order in order succeeds',
    `${chain[2].status}/${chain[2].body?.error?.code}`);

  const [outOfOrder] = await run(stub, 'onboarding-happy', 'prereq-5', [consent]);
  check(outOfOrder.status === 403 && outOfOrder.body.error.code === 'AUTH_ELIGIBILITY_REQUIRED',
    'consent before eligibility is refused: we never ask someone who cannot answer',
    `${outOfOrder.status}/${outOfOrder.body?.error?.code}`);

  // The resume discriminator: first incomplete step, on an exact authenticated response.
  const [signedIn] = await run(stub, 'signin-incomplete-setup', 'resume',
    [{ method: 'POST', path: '/v1/auth/signin', body: { email: 'a@b.invalid', password: 'p' } }]);
  check(signedIn.body.profile.flags.setupNextStep === 'verify',
    'signin identifies the first incomplete setup step on the profile it already returns',
    JSON.stringify(signedIn.body?.profile?.flags));
  const [complete] = await run(stub, 'default', 'resume-2',
    [{ method: 'POST', path: '/v1/auth/signin', body: { email: 'a@b.invalid', password: 'p' } }]);
  check(complete.body.profile.flags.setupNextStep === null,
    'control: a fully set-up account reports no next step', JSON.stringify(complete.body?.profile?.flags));
}

console.log('\n--- room identity (ROOM_NOT_FOUND) ---');
{
  const stub = api();
  const signin = { method: 'POST', path: '/v1/auth/signin', body: { email: 'a@b.invalid', password: 'p' } };
  const [, unknown] = await run(stub, 'default', 'rooms-1', [signin,
    { method: 'GET', path: '/v1/rooms/01JSTUBGONEROOM00000000000' }]);
  check(unknown.status === 404 && unknown.body.error.code === 'ROOM_NOT_FOUND',
    'an unknown room id is ROOM_NOT_FOUND, not room A wearing that id',
    `${unknown.status}/${unknown.body?.error?.code}`);

  const [, known] = await run(stub, 'default', 'rooms-2', [signin, { method: 'GET', path: `/v1/rooms/${fx.ROOM_IDS[0]}` }]);
  check(known.status === 200 && known.body.roomId === fx.ROOM_IDS[0],
    'control: a fixture room id still resolves', `${known.status}`);

  const [, createdRes, fetched] = await run(stub, 'default', 'rooms-3', [signin,
    { method: 'POST', path: '/v1/rooms', body: { name: 'Made Here', region: 'yyz', mapId: 'the-square', mode: 'tdm', capacity: 12 } },
    (prev) => ({ method: 'GET', path: `/v1/rooms/${prev[1].body.room.roomId}` })]);
  check(createdRes.status === 201 && fetched.status === 200
    && fetched.body.roomId === createdRes.body.room.roomId && fetched.body.name === 'Made Here',
  'a room this session created resolves by its own id, with its own name',
  `${fetched.status}/${fetched.body?.name}`);

  // Mutations round-trip, and the readiness rules are the ones §7 states.
  const room = fx.ROOM_IDS[0];
  const seq = await run(stub, 'default', 'rooms-4', [signin,
    { method: 'POST', path: `/v1/rooms/${room}/ready`, body: { ready: true } },
    { method: 'POST', path: `/v1/rooms/${room}/team`, body: { team: 'bravo' } },
    { method: 'GET', path: `/v1/rooms/${room}` },
  ]);
  const [, readied, teamed, after] = seq;
  const meIn = (res) => res.body.roster.find((m) => m.isLocal);
  check(readied.status === 200 && meIn(readied).ready === true,
    'POST /ready round-trips: the roster the response carries shows it', JSON.stringify(meIn(readied)));
  check(teamed.status === 200 && meIn(teamed).team === 'bravo' && meIn(teamed).ready === false,
    'a team change moves the caller AND clears readiness, as §7 requires',
    JSON.stringify(meIn(teamed)));
  check(meIn(after).team === 'bravo' && meIn(after).ready === false,
    'the next GET agrees with the mutation, rather than resetting to the fixture',
    JSON.stringify(meIn(after)));

  // Launch is owner-only and needs the ready threshold — the two rules a 202 used to skip.
  const notOwner = await run(stub, 'default', 'rooms-5', [signin,
    { method: 'POST', path: `/v1/rooms/${fx.ROOM_IDS[1]}/launch`, body: {} }]);
  check(notOwner[1].status === 403 && notOwner[1].body.error.code === 'AUTH_FORBIDDEN',
    'launching a room you do not own is AUTH_FORBIDDEN', `${notOwner[1].status}/${notOwner[1].body?.error?.code}`);

  const unready = await run(stub, 'default', 'rooms-6', [signin,
    { method: 'POST', path: `/v1/rooms/${room}/ready`, body: { ready: false } },
    { method: 'POST', path: `/v1/rooms/${room}/launch`, body: {} }]);
  check(unready[2].status === 409 && unready[2].body.error.details.reason === 'not-all-ready',
    'launching below the ready threshold is CONFLICT with the counts',
    JSON.stringify(unready[2].body?.error?.details));

  const launched = await run(stub, 'default', 'rooms-7', [signin,
    { method: 'POST', path: `/v1/rooms/${room}/launch`, body: {} },
    { method: 'GET', path: `/v1/rooms/${room}` },
    { method: 'POST', path: `/v1/rooms/${room}/team`, body: { team: 'alpha' } }]);
  check(launched[1].status === 202 && launched[2].body.status === 'countdown'
    && launched[3].status === 403,
  'control: the owner with everyone ready launches, the room enters countdown, and the roster freezes',
  `${launched[1].status} / ${launched[2].body?.status} / ${launched[3].status}`);
}

console.log('\n--- settings round-trip (§11.2, §11.9) ---');
{
  const stub = api();
  const signin = { method: 'POST', path: '/v1/auth/signin', body: { email: 'a@b.invalid', password: 'p' } };
  const get = { method: 'GET', path: '/v1/profile/me/settings' };

  const [, first] = await run(stub, 'default', 'set-1', [signin, get]);
  check(first.headers.ETag === `"${first.body.version}"`,
    'GET carries the ETag the next If-Match has to quote', JSON.stringify(first.headers));
  const roamKeys = Object.keys(first.body.values).filter((k) => k !== 'keybinds');
  // Every ROAM row that HAS a default. `reduceMotion` documents its default as the OS
  // preference, which is a client-side reading the server cannot invent — so it is absent
  // rather than guessed, and the generated defaults agree.
  const seeded = Object.keys(defaultRoamingValues()).filter((k) => k !== 'keybinds');
  check(roamKeys.length === seeded.length && roamKeys.every((k) => Object.hasOwn(VOCABULARY.roam, k)),
    'the seeded values are the ROAM set from vocabulary v1, not a hand-picked four',
    `${roamKeys.length} keys against ${seeded.length} defaults of ${Object.keys(VOCABULARY.roam).length} ROAM rows`);
  check(Object.keys(first.body.values.keybinds).every((a) => Object.hasOwn(VOCABULARY.keybinds, a)),
    'binding ids are the inventory canonical action ids, not invented dotted names',
    Object.keys(first.body.values.keybinds).join(','));

  const written = await run(stub, 'default', 'set-2', [signin, get,
    (prev) => ({ method: 'PUT', path: '/v1/profile/me/settings',
      headers: { 'If-Match': `"${prev[1].body.version}"` }, body: { schemaVersion: 1, values: ROAM_WRITE } }),
    get]);
  const [, before, put, after] = written;
  check(put.status === 200 && put.body.version === before.body.version + 1
    && after.body.values.sensitivity === ROAM_WRITE.sensitivity
    && after.body.values.fov === ROAM_WRITE.fov
    && after.body.values.keybinds.lean.primary === 'KeyQ',
  'a PUT round-trips: the next GET returns what was written, one version later',
  `${put.status} v${put.body?.version} sensitivity ${after.body?.values?.sensitivity}`);
  check(after.body.values.invertY === true && after.body.values.subtitles === VOCABULARY.roam.subtitles.default,
    'full replace: an absent ROAM key reverts to its documented default',
    `${after.body?.values?.subtitles}`);

  const [, noMatch] = await run(stub, 'default', 'set-3', [signin,
    { method: 'PUT', path: '/v1/profile/me/settings', body: { schemaVersion: 1, values: ROAM_WRITE } }]);
  check(noMatch.status === 409 && noMatch.body.error.details.reason === 'if-match-required',
    'a missing If-Match is CONFLICT with a reason, never 428 (§3a.4)',
    `${noMatch.status}/${JSON.stringify(noMatch.body?.error?.details)}`);

  const [, stale] = await run(stub, 'default', 'set-4', [signin,
    { method: 'PUT', path: '/v1/profile/me/settings', headers: { 'If-Match': '"3"' }, body: { schemaVersion: 1, values: ROAM_WRITE } }]);
  check(stale.status === 409 && stale.body.error.details.currentVersion === 7
    && stale.body.error.details.values !== undefined,
  'a stale If-Match returns the current version AND values, so the UI can merge',
  JSON.stringify(stale.body?.error?.details?.currentVersion));

  const [, rejected] = await run(stub, 'default', 'set-5', [signin,
    { method: 'PUT', path: '/v1/profile/me/settings', headers: { 'If-Match': '"7"' }, body: { schemaVersion: 1, values: DEVICE_WRITE } }]);
  check(rejected.status === 400 && rejected.body.error.code === 'VALIDATION_FAILED'
    && rejected.body.error.details.fields.some((f) => f.path === 'masterVolume' && f.reason === 'scope-not-roaming'),
  'a DEVICE key is rejected by scope, not stored and not clamped (§11.9)',
  JSON.stringify(rejected.body?.error?.details?.fields));

  const [, outOfRange] = await run(stub, 'default', 'set-6', [signin,
    { method: 'PUT', path: '/v1/profile/me/settings', headers: { 'If-Match': '"7"' },
      body: { schemaVersion: 1, values: { fov: 400 } } }]);
  check(outOfRange.status === 400 && outOfRange.body.error.details.fields[0].reason === 'range',
    'an out-of-range value is rejected rather than clamped',
    JSON.stringify(outOfRange.body?.error?.details?.fields));

  const conflict = await run(stub, 'settings-conflict', 'set-7', SCENARIO_PROBES['settings-conflict']);
  check(conflict[2].status === 409 && conflict[2].body.error.details.currentVersion === 8
    && conflict[3].status === 200 && conflict[3].body.version === 9,
  'settings-conflict: the write loses to another device, then the retry with the new ETag wins',
  `${conflict[2].status} then ${conflict[3].status}/v${conflict[3].body?.version}`);
}

console.log('\n--- slow actually delays ---');
{
  sleepRequests = [];
  const stub = api();
  const [res] = await run(stub, 'slow', 'delay-1', [{ method: 'GET', path: '/v1/health' }]);
  check(JSON.stringify(sleepRequests) === '[2000]',
    'slow: the layer requests the 2 s delay itself rather than labelling the response',
    JSON.stringify(sleepRequests));
  check(res.status === 200 && res.body.ok === true && res.then === undefined,
    'slow: the awaited response is the ordinary payload, with no thenable left on it',
    JSON.stringify(Object.keys(res)));

  // The failing control: a scenario without a delay must not ask for one.
  sleepRequests = [];
  await run(stub, 'default', 'delay-2', [{ method: 'GET', path: '/v1/health' }]);
  check(sleepRequests.length === 0, 'control: an undelayed scenario requests no sleep',
    JSON.stringify(sleepRequests));

  // And once, for real, against the wall clock: the injected sleep proves the request, not the
  // wait. This is the only place the in-process suite spends two seconds.
  const realStub = createStubApi({ config: { env: 'test' }, flags: { [STUB_FLAG]: true }, env: {} });
  const startedAt = Date.now();
  await realStub.handle({
    method: 'GET', path: '/v1/health', query: {}, body: {},
    headers: { 'X-Stub-Scenario': 'slow', 'X-Client-Session-Id': 'delay-3' },
  });
  const elapsed = Date.now() - startedAt;
  check(elapsed >= 1900, 'slow: awaiting a real response really does take about two seconds',
    `${elapsed}ms`);
}

// ── 7. determinism ──────────────────────────────────────────────────────────────────────────

console.log('\n--- determinism ---');
{
  const mismatched = [];
  for (const name of Object.keys(SCENARIOS)) {
    const probe = SCENARIO_PROBES[name] || [];
    // Two fresh sessions in one instance, and a third in a brand new instance: a scenario that
    // leaked module state or a wall-clock reading fails at least one of these.
    const a = await run(api(), name, 'det-a', probe);
    const b = await run(api(), name, 'det-b', probe);
    const shared = api();
    await run(shared, name, 'warmup', probe);
    const c = await run(shared, name, 'det-c', probe);
    if (JSON.stringify(a) !== JSON.stringify(b)) mismatched.push(`${name}: two fresh sessions differ`);
    if (JSON.stringify(a) !== JSON.stringify(c)) mismatched.push(`${name}: a fresh session after another run differs`);
  }
  check(mismatched.length === 0, 'every scenario replays byte-identically from a fresh session',
    mismatched.slice(0, 5).join('\n       '));

  // And the negative control: a genuinely time-derived field would fail the check above, so
  // prove the check can see a difference at all.
  const control = JSON.stringify(await run(api(), 'default', 'x', SCENARIO_PROBES.default))
    !== JSON.stringify(await run(api(), 'default-changed', 'x', []));
  check(control, 'the determinism comparison can distinguish different outputs', 'it cannot');
}

// ── 8. the lobby timelines ──────────────────────────────────────────────────────────────────

console.log('\n--- realtime-lobby.md §10 lobby stub ---');
{
  const missing = contractLobby.filter((n) => !LOBBY_SCENARIO_NAMES.includes(n));
  check(missing.length === 0, 'every §10 lobby timeline exists', `missing: ${missing.join(', ')}`);

  const extra = LOBBY_SCENARIO_NAMES.filter((n) => !contractLobby.includes(n));
  check(extra.length === 0, 'the lobby stub invents no timeline the contract does not name',
    `undocumented: ${extra.join(', ')}`);

  const problems = [];
  for (const name of contractLobby) {
    if (!LOBBY_SCENARIO_NAMES.includes(name)) continue;
    const stubA = createLobbyStub({ scenario: name });
    const stubB = createLobbyStub({ scenario: name });
    if (JSON.stringify(stubA.steps()) !== JSON.stringify(stubB.steps())) problems.push(`${name}: replay differs`);
    const frames = stubA.serverFrames();
    if (!frames.length) { problems.push(`${name}: no server frames`); continue; }
    if (frames[0].t !== 'lobby.welcome') problems.push(`${name}: does not open with lobby.welcome`);
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].seq !== i) problems.push(`${name}: seq ${frames[i].seq} at position ${i} — a gap means state was missed`);
      if (!ISO.test(frames[i].ts)) problems.push(`${name}: frame ${i} has a non-ISO ts`);
      if (!('d' in frames[i])) problems.push(`${name}: frame ${i} has no payload`);
    }
    // The seed is a real room: capacity is never exceeded, at any point in the timeline.
    const welcome = frames[0].d;
    if (welcome.roster.length > welcome.room.capacity) {
      problems.push(`${name}: seeded ${welcome.roster.length} into a ${welcome.room.capacity} room`);
    }
    let count = welcome.roster.length;
    for (const f of frames) {
      if (f.t === 'roster.delta') count += f.d.added.length - f.d.removed.length;
      if (count > welcome.room.capacity) problems.push(`${name}: roster reached ${count} in a ${welcome.room.capacity} room`);
      if (f.t === 'room.updated' && f.d.playerCount !== undefined && f.d.playerCount !== count) {
        problems.push(`${name}: room.updated says ${f.d.playerCount} while the roster holds ${count}`);
      }
    }
    let stepCount = 0;
    stubA.reset();
    while (stubA.next()) stepCount++;
    if (stepCount !== stubA.steps().length) problems.push(`${name}: next() does not walk the whole timeline`);
  }
  check(problems.length === 0, 'every timeline is well-formed, monotonic, capacity-safe and replayable',
    problems.slice(0, 6).join('\n       '));

  // The welcome must carry complete state: there is no "fetch the rest over REST" step.
  const welcome = createLobbyStub({ scenario: 'happy-path' }).serverFrames()[0].d;
  const wp = [];
  validate(welcome, S.obj({
    protocol: S.int, serverTime: S.iso, heartbeatMs: S.int, graceMs: S.int,
    you: S.obj({ accountId: S.ulid, team: S.enum('alpha', 'bravo', 'unassigned'), ready: S.bool, isOwner: S.bool, seatHeldUntil: S.nullable(S.iso) }),
    room: S.obj(ROOM_CORE_KEYS),
    roster: S.arr(ROSTER_MEMBER),
    countdown: S.nullable(COUNTDOWN),
    chatHistory: S.arr(S.obj({ id: S.ulid, accountId: S.ulid, displayName: S.str, text: S.str, ts: S.iso, filtered: S.bool })),
  }), 'lobby.welcome.d', wp);
  check(wp.length === 0, 'lobby.welcome carries complete, contract-shaped state', wp.slice(0, 4).join('\n       '));

  // happy-path is a path a server would actually permit, end to end.
  {
    const frames = createLobbyStub({ scenario: 'happy-path' }).serverFrames();
    const types = frames.map((f) => f.t);
    const w = frames[0].d;
    check(w.room.status === 'open' && w.roster.length < w.room.capacity && w.you.isOwner === true,
      'happy-path starts in an open, joinable room the caller owns',
      `${w.room.status} ${w.roster.length}/${w.room.capacity} owner=${w.you.isOwner}`);
    check(types.includes('team.changed') && types.includes('ready.changed'),
      'happy-path covers the team and readiness steps it used to skip', types.join(','));
    const started = frames.findIndex((f) => f.t === 'countdown.started');
    const ready = started >= 0 ? frames[started].d : {};
    check(started > 0 && ready.currentReady >= ready.requiredReady,
      'the countdown starts only once the ready threshold is met',
      `${ready.currentReady}/${ready.requiredReady}`);
    const joinsAfterFreeze = frames.slice(started).filter((f) => f.t === 'roster.delta' && f.d.added.length);
    check(joinsAfterFreeze.length === 0,
      'the roster is frozen at countdown.started: nothing joins after it',
      `${joinsAfterFreeze.length} joins after the freeze`);
    const refusal = frames.slice(started).find((f) => f.t === 'error');
    check(refusal && refusal.d.error.code === 'ROOM_IN_PROGRESS',
      'a join attempted during the countdown is refused, and the refusal is on the wire',
      JSON.stringify(refusal?.d?.error?.code));
    const handoff = frames.find((f) => f.t === 'match.ready');
    check(handoff && typeof handoff.d.sessionTicket === 'string' && handoff.d.reconnectGraceMs === 90000,
      'the timeline ends in a real handoff with a per-account ticket',
      JSON.stringify(handoff?.d?.matchId));
  }

  // The two abort branches differ in exactly the way §6.2 says they do.
  const cleared = (name) => createLobbyStub({ scenario: name }).serverFrames()
    .filter((f) => f.t === 'ready.changed' && f.d.clearedReason).length;
  const reasons = (name) => createLobbyStub({ scenario: name }).serverFrames()
    .filter((f) => f.t === 'countdown.aborted').map((f) => f.d.reason);
  check(JSON.stringify(reasons('countdown-abort-unready')) === '["player-unready"]'
    && JSON.stringify(reasons('countdown-abort-imbalance')) === '["team-imbalance"]'
    && reasons('countdown-continues').length === 0,
  'countdown aborts carry their reason, and the continuing one never aborts',
  `${reasons('countdown-abort-unready')} / ${reasons('countdown-abort-imbalance')} / ${reasons('countdown-continues').length}`);
  check(cleared('countdown-abort-unready') === 0 && cleared('countdown-abort-imbalance') > 0,
    'readiness survives a player-unready abort and is cleared for a team-imbalance one',
    `${cleared('countdown-abort-unready')} vs ${cleared('countdown-abort-imbalance')}`);
  check(cleared('ready-cleared') > 0,
    'ready-cleared explains the clear with a reason rather than leaving it implied',
    `${cleared('ready-cleared')} cleared frames`);

  // Resync: the snapshot is the same payload under a different type, so a reducer can tell them
  // apart without inferring from `seq`.
  {
    const frames = createLobbyStub({ scenario: 'disconnect-resync' }).serverFrames();
    const snap = frames.find((f) => f.t === 'state.snapshot');
    check(snap && Object.keys(snap.d).join(',') === Object.keys(frames[0].d).join(','),
      'state.snapshot carries the identical payload shape as lobby.welcome',
      snap ? Object.keys(snap.d).join(',') : 'no snapshot');
  }
}

// ── 9. the mounted path, over a real socket ─────────────────────────────────────────────────

console.log('\n--- mounted over a real socket (app.js preRoute) ---');
{
  const silent = () => { const noop = () => {}; const l = { debug: noop, info: noop, warn: noop, error: noop }; l.child = () => l; return l; };
  // Port 0: the OS picks a free one, so this can never collide with apptest (it did).
  const PORT = 0;
  const config = loadConfig({ PLATFORM_PORT: String(PORT), NODE_ENV: 'test' });
  const app = await buildApp(config, { logger: silent() });
  await new Promise((r) => app.server.listen(PORT, '127.0.0.1', r));
  const boundPort = app.server.address().port;
  const base = `http://127.0.0.1:${boundPort}`;

  const call = async (method, path, { scenario, body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-client-build': CLIENT_BUILD,
        'x-stub-scenario': scenario,
        'x-client-session-id': 'socket-session',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* the check will say so */ }
    return { status: res.status, body: json, headers: res.headers };
  };

  try {
    check(app.mounted.includes('stubs'), 'the stub module is mounted', app.mounted.join(','));

    // 1. `default`, through signin and an authenticated read.
    const signin = await call('POST', '/v1/auth/signin',
      { scenario: 'default', body: { email: 'a@b.invalid', password: 'p' } });
    const token = signin.body?.accessToken;
    const rooms = await call('GET', '/v1/rooms',
      { scenario: 'default', headers: { authorization: `Bearer ${token}` } });
    check(signin.status === 200 && rooms.status === 200 && rooms.body.items.length === 3,
      'default: signin and an authenticated room list work over the socket',
      `${signin.status} / ${rooms.status} / ${rooms.body?.items?.length}`);

    const unauth = await call('GET', '/v1/rooms', { scenario: 'default' });
    check(unauth.status === 401 && unauth.body.error.code === 'AUTH_REQUIRED',
      'the auth gate applies on the mounted path, not just in-process',
      `${unauth.status}/${unauth.body?.error?.code}`);

    const noBuild = await call('GET', '/v1/rooms',
      { scenario: 'default', headers: { 'x-client-build': '' } });
    check(noBuild.status === 426, 'the build gate applies on the mounted path', `${noBuild.status}`);

    // 2. `slow`, timed against the wall clock.
    const startedAt = Date.now();
    const slow = await call('GET', '/v1/health', { scenario: 'slow' });
    const elapsed = Date.now() - startedAt;
    check(slow.status === 200 && elapsed >= 1900,
      'slow: the mounted response really is delayed by about two seconds', `${elapsed}ms`);

    // 3. `offline`, which has no HTTP representation at all.
    let dropped = false;
    try { await call('GET', '/v1/health', { scenario: 'offline' }); }
    catch { dropped = true; }
    check(dropped, 'offline: the socket is dropped rather than answered with a synthetic 5xx',
      'the request completed');

    // 4. and the platform still behaves as production without the header.
    const noScenario = await fetch(`${base}/v1/health`, { headers: { 'x-client-build': CLIENT_BUILD } });
    check(noScenario.status === 200, 'without X-Stub-Scenario the real platform answers',
      `${noScenario.status}`);
  } finally {
    app.stop();
    await new Promise((r) => app.server.close(r));
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nstub layer runs clean');
process.exit(failures ? 1 : 0);
