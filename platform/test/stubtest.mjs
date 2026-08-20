/**
 * stubtest — the coverage guarantee for the stub layer.
 *
 * contracts/http-api.md §11.10 and §11.11 are the source of truth, so this test **parses them**
 * rather than restating them: the scenario list and the coverage map are read out of the
 * markdown, and a scenario that exists in the document and not in the registry is a failure
 * here. That is the only version of "complete" that stays true after the contract changes.
 *
 * What it proves:
 *   1. the flag gate refuses production, and refuses to serve with the flag off
 *   2. every §11.10 scenario exists and is reachable
 *   3. every §11.11 coverage row has owning scenarios that actually run
 *   4. multi-step scenarios genuinely transition, rather than returning one canned response
 *   5. responses validate against the contract shapes — keys, enums, nullability
 *   6. replaying a scenario from a fresh session is byte-identical
 *   7. the §10 lobby timelines exist and are well-formed
 *
 * Run: `node platform/test/stubtest.mjs`
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createStubApi, assertStubAllowed, STUB_FLAG } from '../src/modules/stubs/index.js';
import { SCENARIOS } from '../src/modules/stubs/scenarios.js';
import { COVERAGE_MAP, SCENARIO_PROBES } from '../src/modules/stubs/coverage.js';
import { createLobbyStub, LOBBY_SCENARIO_NAMES } from '../src/modules/stubs/lobby.js';
import { CODES } from '../src/core/errors.js';

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

console.log('\n--- contract parse ---');
check(contractScenarios.length >= 30, 'http-api.md §11.10 parsed',
  `found ${contractScenarios.length} scenario names`);
check(Object.keys(contractCoverage).length >= 12, 'http-api.md §11.11 parsed',
  `found ${Object.keys(contractCoverage).length} coverage rows`);
check(contractLobby.length >= 14, 'realtime-lobby.md §10 parsed',
  `found ${contractLobby.length} lobby scenarios`);

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

const api = () => createStubApi({ config: { env: 'test' }, flags: { [STUB_FLAG]: true }, env: {} });

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
  flags: S.obj({ nameChangeAvailableAt: S.nullable(S.iso) }),
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
        presence: S.nullable(S.obj({ state: S.enum('online', 'in-lobby', 'in-match'), joinable: S.bool, roomId: S.nullable(S.ulid) })),
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

/** Run a scenario's probe sequence against a fresh session. */
function run(stub, scenario, sessionId, requests) {
  return requests.map((req) => stub.handle({
    method: req.method,
    path: req.path,
    query: req.query || {},
    body: req.body || {},
    headers: {
      'X-Stub-Scenario': scenario,
      'X-Client-Session-Id': sessionId,
      'X-Client-Build': '1.0.0-stub',
      ...(req.headers || {}),
    },
  }));
}

// ── 2. every §11.10 scenario exists and is reachable ────────────────────────────────────────

console.log('\n--- §11.10 scenario coverage ---');
{
  const stub = api();
  const missing = contractScenarios.filter((n) => !stub.hasScenario(n));
  check(missing.length === 0, 'every scenario in §11.10 exists in the registry',
    `missing: ${missing.join(', ')}`);

  const extra = Object.keys(SCENARIOS).filter((n) => !contractScenarios.includes(n));
  check(extra.length === 0, 'the registry invents no scenario the contract does not name',
    `undocumented: ${extra.join(', ')}`);

  const noProbe = contractScenarios.filter((n) => !SCENARIO_PROBES[n]);
  check(noProbe.length === 0, 'every scenario has a request sequence that drives it',
    `no probe: ${noProbe.join(', ')}`);

  let unreachable = [];
  let shapeProblems = [];
  for (const name of contractScenarios) {
    const probe = SCENARIO_PROBES[name] || [];
    const responses = run(stub, name, `reach-${name}`, probe);
    if (!responses.length) { unreachable.push(`${name}: no requests`); continue; }
    for (let i = 0; i < responses.length; i++) {
      const res = responses[i];
      if (res.transport === 'failed') continue;
      if (typeof res.status !== 'number') { unreachable.push(`${name}[${i}]: no status`); continue; }
      if (res.status === 404 && res.body?.error?.code === 'NOT_FOUND' && !patternFor(probe[i].method, probe[i].path)) {
        unreachable.push(`${name}[${i}]: ${probe[i].method} ${probe[i].path} matched no route`);
      }
      shapeProblems.push(...validateResponse(probe[i], res).map((p) => `${name}: ${p}`));
    }
  }
  check(unreachable.length === 0, 'every scenario is reachable and answers every request',
    unreachable.slice(0, 5).join('\n       '));
  check(shapeProblems.length === 0, 'every response validates against the contract shape',
    `${shapeProblems.length} problems, first 6:\n       ${shapeProblems.slice(0, 6).join('\n       ')}`);
}

// ── 3. the §11.11 coverage map ──────────────────────────────────────────────────────────────

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
      if (!probe) { dead.push(`${row} → ${owner}: no probe`); continue; }
      const responses = run(stub, owner, `cov-${row}-${owner}`, probe);
      const answered = responses.every((r) => r.transport === 'failed' || typeof r.status === 'number');
      if (!answered) dead.push(`${row} → ${owner}: a request went unanswered`);
    }
  }
  check(dead.length === 0, 'every owning scenario actually runs', dead.join('\n       '));
}

// ── 4. the transitions that a canned fixture cannot express ─────────────────────────────────

console.log('\n--- stateful transitions ---');
{
  const stub = api();

  // verify-invalid: fail, resend, succeed. And crucially: it does NOT succeed without a resend.
  for (const [scenario, code] of [
    ['onboarding-verify-invalid', 'AUTH_VERIFICATION_TOKEN_INVALID'],
    ['onboarding-verify-expired', 'AUTH_VERIFICATION_TOKEN_EXPIRED'],
  ]) {
    const verify = { method: 'POST', path: '/v1/onboarding/verify/complete', body: { token: 't' } };
    const resend = { method: 'POST', path: '/v1/onboarding/verify/resend', body: {} };
    const [first, second] = run(stub, scenario, `${scenario}-noresend`, [verify, verify]);
    check(first.status === 400 && first.body.error.code === code
      && second.status === 400 && second.body.error.code === code,
    `${scenario}: verify keeps failing until a resend`,
    `got ${first.status}/${first.body?.error?.code} then ${second.status}/${second.body?.error?.code}`);

    const [a, b, c] = run(stub, scenario, `${scenario}-resend`, [verify, resend, verify]);
    check(a.status === 400 && a.body.error.code === code && b.status === 202 && c.status === 204,
      `${scenario}: fails, resends, then succeeds`,
      `got ${a.status}/${a.body?.error?.code}, ${b.status}, ${c.status}`);
  }

  // result-pending-live: pending for EXACTLY 3 polls, then completed.
  {
    const poll = { method: 'GET', path: '/v1/matches/01JSTABMATCH00000000000000' };
    const res = run(stub, 'result-pending-live', 'pending-live', [poll, poll, poll, poll, poll]);
    const statuses = res.map((r) => r.body.status);
    check(JSON.stringify(statuses) === JSON.stringify(['pending', 'pending', 'pending', 'completed', 'completed']),
      'result-pending-live: pending exactly 3 times, then completed', statuses.join(','));
    check(res.slice(0, 3).every((r) => r.body.endedAt === null),
      'result-pending-live: endedAt is null while live', 'a live pending carried an endedAt');
  }

  // result-pending-queued: 2 polls, and endedAt is SET because the match really did end.
  {
    const poll = { method: 'GET', path: '/v1/matches/01JSTABMATCH00000000000000' };
    const res = run(stub, 'result-pending-queued', 'pending-queued', [poll, poll, poll, poll]);
    const statuses = res.map((r) => r.body.status);
    check(JSON.stringify(statuses) === JSON.stringify(['pending', 'pending', 'completed', 'completed']),
      'result-pending-queued: pending exactly 2 times, then completed', statuses.join(','));
    check(res.slice(0, 2).every((r) => typeof r.body.endedAt === 'string'),
      'result-pending-queued: endedAt is set while queued', 'a queued pending had endedAt null');
  }

  // onboarding-happy: the consent decision migrates onto the account at signup.
  {
    const sid = 'happy-migration';
    // Two calls, not one: the signup body needs the receipt the FIRST call returns, and a
    // single array literal cannot reference a binding it is itself destructuring into.
    const [elig, consent] = run(stub, 'onboarding-happy', sid, [
      { method: 'POST', path: '/v1/onboarding/eligibility', body: { dateOfBirth: '1994-03-02', jurisdiction: 'CA-ON' } },
      { method: 'PUT', path: '/v1/onboarding/consent', body: { telemetryPersonal: true, policyVersion: 1, clientSessionId: sid } },
    ]);
    const [signupRes] = run(stub, 'onboarding-happy', sid, [
      { method: 'POST', path: '/v1/auth/signup', body: { email: 'a@b.invalid', password: 'p', displayName: 'n', eligibilityReceipt: elig?.body?.receipt ?? 'r', clientSessionId: sid, consentReceipt: consent?.body?.receipt ?? 'c' } },
    ]);
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
    const join = { method: 'POST', path: `/v1/rooms/${'01JSTABRMAAA00000000000000'}/join`, body: {} };
    const [gated] = run(stub, 'onboarding-happy', sid, [join]);
    check(gated.status === 403 && gated.body.error.code === 'AUTH_VERIFICATION_REQUIRED',
      'onboarding-happy: gameplay is gated on verification', `${gated.status}/${gated.body?.error?.code}`);
    const [, afterVerify] = run(stub, 'onboarding-happy', sid, [
      { method: 'POST', path: '/v1/onboarding/verify/complete', body: { token: 't' } }, join,
    ]);
    check(afterVerify.status === 403 && afterVerify.body.error.code === 'AUTH_TERMS_ACCEPTANCE_REQUIRED',
      'onboarding-happy: then gated on terms', `${afterVerify.status}/${afterVerify.body?.error?.code}`);
    const [, afterTerms] = run(stub, 'onboarding-happy', sid, [
      { method: 'POST', path: '/v1/onboarding/terms/accept', body: { version: 1 } }, join,
    ]);
    check(afterTerms.status === 200, 'onboarding-happy: reaches the shell once both gates clear',
      `${afterTerms.status}/${afterTerms.body?.error?.code}`);
  }

  // consent-declined: still a successful signup, with the decline recorded on the account.
  {
    const sid = 'declined';
    const [, consent, signupRes] = run(stub, 'onboarding-consent-declined', sid, [
      { method: 'POST', path: '/v1/onboarding/eligibility', body: { dateOfBirth: '1994-03-02', jurisdiction: 'CA-ON' } },
      { method: 'PUT', path: '/v1/onboarding/consent', body: { telemetryPersonal: true, policyVersion: 1, clientSessionId: sid } },
      { method: 'POST', path: '/v1/auth/signup', body: { email: 'a@b.invalid', password: 'p', displayName: 'n', eligibilityReceipt: 'r', clientSessionId: sid, consentReceipt: 'c' } },
    ]);
    check(consent.body.telemetryPersonal === false && signupRes.status === 201
      && signupRes.body.profile.consent.telemetryPersonal === false,
    'onboarding-consent-declined: declining is recorded and signup still succeeds',
    JSON.stringify({ consent: consent.body.telemetryPersonal, profile: signupRes.body.profile.consent }));
  }

  // terms-conflict: v1 conflicts against a v2 published underneath, then v2 is accepted.
  {
    const sid = 'terms';
    const [t1, a1, t2, a2] = run(stub, 'onboarding-terms-conflict', sid, [
      { method: 'GET', path: '/v1/onboarding/terms' },
      { method: 'POST', path: '/v1/onboarding/terms/accept', body: { version: 1 } },
      { method: 'GET', path: '/v1/onboarding/terms' },
      { method: 'POST', path: '/v1/onboarding/terms/accept', body: { version: 2 } },
    ]);
    check(t1.body.version === 1 && a1.status === 409 && a1.body.error.code === 'CONFLICT'
      && a1.body.error.details.currentVersion === 2 && t2.body.version === 2 && a2.status === 204,
    'onboarding-terms-conflict: v1 → CONFLICT(v2) → accept v2 → 204',
    `${t1.body.version}, ${a1.status}/${a1.body?.error?.details?.currentVersion}, ${t2.body.version}, ${a2.status}`);
  }

  // room-password: prompt first, then any non-empty password works.
  {
    const room = '01JSTABRMAAA00000000000000';
    const [first, second] = run(stub, 'room-password', 'pw', [
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
    const res = run(stub, 'session-revoked', 'revoked', [me, me, me, me]);
    check(res[0].status === 200 && res[1].status === 200
      && res[2].status === 401 && res[2].body.error.code === 'AUTH_SESSION_REVOKED'
      && res[3].status === 401,
    'session-revoked: the third authenticated call fails, and stays failing',
    res.map((r) => r.status).join(','));
  }

  // token-expiry: expires on virtual time, and a refresh actually restores service.
  {
    const me = { method: 'GET', path: '/v1/profile/me' };
    const res = run(stub, 'token-expiry', 'expiry', [
      { method: 'POST', path: '/v1/auth/signin', body: { email: 'a@b.invalid', password: 'p' } },
      me, me, me,
      { method: 'POST', path: '/v1/auth/refresh', body: {} },
      me,
    ]);
    check(res[1].status === 200 && res[3].status === 401 && res[3].body.error.code === 'AUTH_TOKEN_EXPIRED'
      && res[4].status === 200 && res[5].status === 200,
    'token-expiry: expires after 30 virtual seconds, and a refresh restores service',
    res.map((r) => `${r.status}${r.body?.error ? `/${r.body.error.code}` : ''}`).join(','));
  }

  // browser-unreachable: rooms only. Auth must keep working, or the scenario is just `offline`.
  {
    const [rooms, auth] = run(stub, 'browser-unreachable', 'unreachable', [
      { method: 'GET', path: '/v1/rooms' },
      { method: 'POST', path: '/v1/auth/signin', body: { email: 'a@b.invalid', password: 'p' } },
    ]);
    check(rooms.status === 503 && rooms.body.error.code === 'SERVICE_UNAVAILABLE' && auth.status === 200,
      'browser-unreachable: room endpoints only; auth unaffected',
      `${rooms.status} / ${auth.status}`);
  }

  // account-pre-policy: consent is null, and answering it fills it in.
  {
    const sid = 'prepolicy';
    const [me, put, me2] = run(stub, 'account-pre-policy', sid, [
      { method: 'GET', path: '/v1/profile/me' },
      { method: 'PUT', path: '/v1/onboarding/consent', body: { telemetryPersonal: true, policyVersion: 1, clientSessionId: sid } },
      { method: 'GET', path: '/v1/profile/me' },
    ]);
    check(me.body.consent === null && put.status === 200 && me2.body.consent !== null,
      'account-pre-policy: consent starts null (undecided) and becomes an object once decided',
      JSON.stringify({ before: me.body.consent, after: me2.body.consent }));
  }

  // history-mixed: both variants of the §4.3 union in one page.
  {
    const [res] = run(stub, 'history-mixed', 'mixed', [{ method: 'GET', path: '/v1/profile/01JSTABACCTAA0000000000000/matches' }]);
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
    const [stats, hist] = run(stub, 'history-empty', 'empty', [
      { method: 'GET', path: '/v1/profile/01JSTABACCTAA0000000000000/stats', query: { mode: 'all' } },
      { method: 'GET', path: '/v1/profile/01JSTABACCTAA0000000000000/matches' },
    ]);
    check(hist.body.items.length === 0 && stats.body.modes.tdm.totals.matches === 0,
      'history-empty: zero matches and zero career totals',
      `${hist.body.items.length} items, ${stats.body.modes.tdm.totals.matches} matches`);

    const [pub] = run(stub, 'privacy-filtered', 'privacy', [{ method: 'GET', path: '/v1/profile/01JSTABACCTAB0000000000000' }]);
    check(pub.status === 200 && pub.body.stats === null && pub.body.presence === null,
      'privacy-filtered: hidden fields are null, not omitted and not a 403',
      JSON.stringify(pub.body));
  }

  // offline and slow are transport behaviours, and must be visible as such.
  {
    const [off] = run(stub, 'offline', 'off', [{ method: 'GET', path: '/v1/health' }]);
    check(off.transport === 'failed' && off.status === null && off.body === null,
      'offline: a transport failure, with no status and no envelope to mistake for one',
      JSON.stringify(off));
    const [slow] = run(stub, 'slow', 'slow', [{ method: 'GET', path: '/v1/health' }]);
    check(slow.status === 200 && slow.delayMs === 2000,
      'slow: a normal response carrying a 2 s delay for the transport to apply', JSON.stringify(slow.delayMs));
  }

  // match reconnect, all three branches.
  {
    const [none] = run(stub, 'match-active-none', 'man', [{ method: 'GET', path: '/v1/matches/active' }]);
    check(none.status === 204 && none.headers['X-Correlation-Id'],
      'match-active-none: 204 with a correlation id in the header', `${none.status}`);

    const [active, ticket] = run(stub, 'match-active-reconnect', 'mar', [
      { method: 'GET', path: '/v1/matches/active' },
      { method: 'POST', path: '/v1/matches/01JSTABMATCH00000000000000/reconnect-ticket', body: {} },
    ]);
    check(active.status === 200 && ticket.status === 200 && ticket.body.handoff.sites.length > 0
      && typeof ticket.body.graceEndsAt === 'string' && typeof ticket.body.serverNow === 'string',
    'match-active-reconnect: discovery then a complete handoff with graceEndsAt and serverNow',
    `${active.status}/${ticket.status}`);

    const [, expired] = run(stub, 'match-active-grace-expired', 'mage', [
      { method: 'GET', path: '/v1/matches/active' },
      { method: 'POST', path: '/v1/matches/01JSTABMATCH00000000000000/reconnect-ticket', body: {} },
    ]);
    check(expired.status === 409 && expired.body.error.code === 'RECONNECT_GRACE_EXPIRED'
      && expired.body.error.details.rejoinable === false && expired.body.error.details.reason === 'grace-expired',
    'match-active-grace-expired: the required details travel with the code',
    JSON.stringify(expired.body?.error?.details));
  }

  // sanctioned: refused where it matters, readable where it does not.
  {
    const [me, join] = run(stub, 'sanctioned', 'sanc', [
      { method: 'GET', path: '/v1/profile/me' },
      { method: 'POST', path: '/v1/rooms/01JSTABRMAAA00000000000000/join', body: {} },
    ]);
    check(me.status === 200 && me.body.moderation.status === 'restricted'
      && join.status === 403 && join.body.error.code === 'SANCTIONED' && join.body.error.details.sanction,
    'sanctioned: join refused with a sanction detail; profile still readable',
    `${me.status}/${join.status}`);
  }

  // name-taken, in both the places a name is chosen.
  {
    const [signupRes, rename] = run(stub, 'name-taken', 'nt', [
      { method: 'POST', path: '/v1/auth/signup', body: { email: 'a@b.invalid', password: 'p', displayName: 'n', eligibilityReceipt: 'r', clientSessionId: 'nt', consentReceipt: 'c' } },
      { method: 'PATCH', path: '/v1/profile/me', body: { displayName: 'n' } },
    ]);
    check(signupRes.status === 409 && signupRes.body.error.code === 'NAME_TAKEN'
      && rename.status === 409 && rename.body.error.code === 'NAME_TAKEN',
    'name-taken: signup and rename both refuse', `${signupRes.status}/${rename.status}`);
  }

  // browser-empty: the empty envelope, not a bare array and not an error.
  {
    const [res] = run(stub, 'browser-empty', 'be', [{ method: 'GET', path: '/v1/rooms' }]);
    check(res.status === 200 && Array.isArray(res.body.items) && res.body.items.length === 0
      && res.body.nextCursor === null && typeof res.body.correlationId === 'string',
    'browser-empty: { items: [], nextCursor: null, correlationId }', JSON.stringify(res.body));
  }

  // eligibility-denied is terminal, and never leaks the age it tested against.
  {
    const [res] = run(stub, 'onboarding-eligibility-denied', 'ed', [
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
    const [res] = run(stub, 'onboarding-receipt-invalid', 'ri', [
      { method: 'POST', path: '/v1/auth/signup', body: { email: 'a@b.invalid', password: 'p', displayName: 'n', eligibilityReceipt: 'stale', clientSessionId: 'ri', consentReceipt: 'c' } },
    ]);
    check(res.status === 400 && res.body.error.code === 'ELIGIBILITY_RECEIPT_INVALID',
      'onboarding-receipt-invalid: signup refuses a stale receipt', `${res.status}/${res.body?.error?.code}`);
  }

  // room-full / room-in-progress: distinct codes, and the room shape explains itself.
  {
    const room = '01JSTABRMAAA00000000000000';
    const [detail, join] = run(stub, 'room-full', 'rf', [
      { method: 'GET', path: `/v1/rooms/${room}` },
      { method: 'POST', path: `/v1/rooms/${room}/join`, body: {} },
    ]);
    check(detail.body.joinBlockedReason === 'full' && join.status === 409 && join.body.error.code === 'ROOM_FULL',
      'room-full: the room says why, and the join refuses with ROOM_FULL',
      `${detail.body.joinBlockedReason}/${join.body?.error?.code}`);

    const [d2, j2] = run(stub, 'room-in-progress', 'rip', [
      { method: 'GET', path: `/v1/rooms/${room}` },
      { method: 'POST', path: `/v1/rooms/${room}/join`, body: {} },
    ]);
    check(d2.body.status === 'in-progress' && j2.status === 409 && j2.body.error.code === 'ROOM_IN_PROGRESS',
      'room-in-progress: status and code agree', `${d2.body.status}/${j2.body?.error?.code}`);
  }

  // The default scenario has to actually be the §12 data set.
  {
    const [rooms, hist] = run(stub, 'default', 'def', [
      { method: 'GET', path: '/v1/rooms' },
      { method: 'GET', path: '/v1/profile/01JSTABACCTAA0000000000000/matches', query: { limit: '100' } },
    ]);
    const regions = new Set(rooms.body.items.map((r) => r.region));
    check(rooms.body.items.length === 3 && regions.size === 2,
      'default: 3 rooms across 2 regions (§12)', `${rooms.body.items.length} rooms, ${regions.size} regions`);
    check(hist.body.items.length === 20 && hist.body.items.every((i) => i.status !== 'pending'),
      'default: 20 terminal matches of history (§12)', `${hist.body.items.length} items`);
    const [detail] = run(stub, 'default', 'def2', [{ method: 'GET', path: `/v1/rooms/${rooms.body.items[1].roomId}` }]);
    check(detail.body.roster.length === 12 && detail.body.countdown !== null,
      'default: a 12-player roster with a live countdown (§12)',
      `${detail.body.roster.length} members, countdown ${detail.body.countdown === null ? 'null' : 'present'}`);
  }

  // §11.6: RTT is client-measured or it is absent. It is never invented.
  {
    const stub2 = api();
    const withHeader = stub2.handle({
      method: 'GET', path: '/v1/rooms', query: {},
      headers: { 'X-Stub-Scenario': 'default', 'X-Client-Session-Id': 'rtt', 'X-Region-Rtt': 'yyz=24,ord=41' },
    });
    const malformed = stub2.handle({
      method: 'GET', path: '/v1/rooms', query: {},
      headers: { 'X-Stub-Scenario': 'default', 'X-Client-Session-Id': 'rtt2', 'X-Region-Rtt': 'yyz=abc' },
    });
    const absent = stub2.handle({
      method: 'GET', path: '/v1/rooms', query: {},
      headers: { 'X-Stub-Scenario': 'default', 'X-Client-Session-Id': 'rtt3' },
    });
    check(withHeader.body.items.every((r) => Number.isInteger(r.estimatedRttMs))
      && malformed.body.items.every((r) => r.estimatedRttMs === null)
      && absent.body.items.every((r) => r.estimatedRttMs === null),
    'X-Region-Rtt: measured values are echoed; malformed or absent means null everywhere',
    JSON.stringify([withHeader.body.items[0].estimatedRttMs, malformed.body.items[0].estimatedRttMs]));
  }
}

// ── 5. determinism ──────────────────────────────────────────────────────────────────────────

console.log('\n--- determinism ---');
{
  const mismatched = [];
  for (const name of contractScenarios) {
    const probe = SCENARIO_PROBES[name] || [];
    // Two fresh sessions in one instance, and a third in a brand new instance: a scenario that
    // leaked module state or a wall-clock reading fails at least one of these.
    const a = run(api(), name, 'det-a', probe);
    const b = run(api(), name, 'det-b', probe);
    const c = (() => { const s = api(); run(s, name, 'warmup', probe); return run(s, name, 'det-c', probe); })();
    if (JSON.stringify(a) !== JSON.stringify(b)) mismatched.push(`${name}: two fresh sessions differ`);
    if (JSON.stringify(a) !== JSON.stringify(c)) mismatched.push(`${name}: a fresh session after another run differs`);
  }
  check(mismatched.length === 0, 'every scenario replays byte-identically from a fresh session',
    mismatched.slice(0, 5).join('\n       '));

  // And the negative control: a genuinely time-derived field would fail the check above, so
  // prove the check can see a difference at all.
  const control = JSON.stringify(run(api(), 'default', 'x', SCENARIO_PROBES.default))
    !== JSON.stringify(run(api(), 'default-changed', 'x', []));
  check(control, 'the determinism comparison can distinguish different outputs', 'it cannot');
}

// ── 6. the lobby timelines ──────────────────────────────────────────────────────────────────

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
    let stepCount = 0;
    stubA.reset();
    while (stubA.next()) stepCount++;
    if (stepCount !== stubA.steps().length) problems.push(`${name}: next() does not walk the whole timeline`);
  }
  check(problems.length === 0, 'every timeline is well-formed, monotonic, and replayable',
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

  // The two abort branches differ in exactly the way §6.2 says they do.
  const reasons = (name) => createLobbyStub({ scenario: name }).serverFrames()
    .filter((f) => f.t === 'countdown.aborted').map((f) => f.d.reason);
  check(JSON.stringify(reasons('countdown-abort-unready')) === '["player-unready"]'
    && JSON.stringify(reasons('countdown-abort-imbalance')) === '["team-imbalance"]'
    && reasons('countdown-continues').length === 0,
  'countdown aborts carry their reason, and the continuing one never aborts',
  `${reasons('countdown-abort-unready')} / ${reasons('countdown-abort-imbalance')} / ${reasons('countdown-continues').length}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nstub layer runs clean');
process.exit(failures ? 1 : 0);
