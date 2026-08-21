/**
 * Contract-versus-implementation conformance.  REQ-CC-042, REQ-CC-043, REQ-CC-044.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────────────────
 * Every other suite here asserts that the implementation does what the implementation was
 * written to do. That is the wrong question for a two-lane repository: the other lane builds
 * from the CONTRACT, so a defect is any place where the contract and the running service give
 * different answers — whichever of the two is wrong.
 *
 * So each check below has two halves, and BOTH are real:
 *
 *   1. it reads the normative sentence out of `docs/contracts/*.md` (parsed, never restated —
 *      a restated rule passes forever after the contract changes underneath it), and
 *   2. it drives the real platform over a real socket, with the real store, and asserts the
 *      behaviour the parsed sentence promises.
 *
 * A check that only parsed the document would be satisfied by prose nobody implemented. A
 * check that only drove the service would be satisfied by an implementation nobody documented.
 * The pairs are what make the two agree.
 *
 * Memory store by default; PostgreSQL under `scripts/pgtest.mjs`, so the store-level
 * invariants below run against real CHECK constraints too.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from '../src/core/config.js';
import { buildApp } from '../src/app.js';
import { ulid } from '../src/core/ids.js';
import { OUTCOME_REASONS, MATCH_STATUS_TRANSITIONS } from '../src/core/store.js';
import { REGISTRY } from '../src/modules/telemetry/registry.js';
import { evidenceDigest } from '../src/shared/evidenceDigest.js';

let failures = 0;
const ok = (name) => console.log(`  ok   ${name}`);
const bad = (name, detail) => { failures++; console.log(`  FAIL ${name}\n       ${detail}`); };
const expect = (cond, name, detail = '') => (cond ? ok(name) : bad(name, detail));
const section = (name) => console.log(`\n${name}`);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const doc = (name) => readFileSync(path.join(ROOT, 'docs/contracts', name), 'utf8');

const MATCH_RESULT = doc('match-result.md');
const HTTP_API = doc('http-api.md');
const TELEMETRY = doc('telemetry.md');
const ERRORS = doc('errors.md');
const DB_SCHEMA = doc('db-schema.md');
const BOMB_RULES = doc('bomb-rules.md');
const NET_FACADE = doc('net-facade.md');
const WIRE = doc('wire-protocol.md');

/**
 * The text of one `##`/`###` section, up to the next heading of the same or higher level.
 *
 * Parsed rather than cited by line number: a line number is a citation that silently becomes a
 * citation of something else the next time anyone inserts a paragraph above it.
 */
function sectionOf(text, heading) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('#') && l.includes(heading));
  if (start < 0) return '';
  const level = lines[start].match(/^#+/)[0].length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) return lines.slice(start, i).join('\n');
  }
  return lines.slice(start).join('\n');
}

const SERVICE_TOKEN = 'contracttest-service-token-not-a-real-one';

const silent = () => {
  const noop = () => {};
  const l = { debug: noop, info: noop, warn: noop, error: noop };
  l.child = () => l;
  return l;
};

async function withApp(fn) {
  const config = loadConfig({
    ...process.env,
    PLATFORM_PORT: '0', PLATFORM_SERVICE_TOKEN: SERVICE_TOKEN, PLATFORM_TRUSTED_PROXY_HOPS: '1',
  });
  if (process.env.PLATFORM_STORAGE && config.storage !== process.env.PLATFORM_STORAGE) {
    throw new Error(`contracttest: asked for ${process.env.PLATFORM_STORAGE}, got ${config.storage}`);
  }
  const app = await buildApp(config, { logger: silent() });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', 'x-client-build': '1.0.0', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* the assertion will say so */ }
    return { status: res.status, body: json, code: json?.error?.code ?? null, text };
  };

  try { return await fn({ app, call, config, store: app.deps.store }); }
  finally { app.stop(); await new Promise((r) => app.server.close(r)); }
}

// §9's auth class is 10/min per IP, and every onboarding below is four auth-class calls. One
// address per player, so the suite tests the match surface rather than the rate limiter.
let ipSeq = 0;
const nextIp = () => `10.9.${Math.floor(ipSeq / 250) + 1}.${(ipSeq++ % 250) + 1}`;

/** Walk the approved onboarding order and return an authenticated player. */
async function onboard(call, { telemetryPersonal = true } = {}) {
  const sid = ulid();
  const from = { 'x-forwarded-for': nextIp() };
  const displayName = `Cc${ulid().slice(-10)}`;
  const elig = await call('POST', '/v1/onboarding/eligibility',
    { dateOfBirth: '1994-03-02', jurisdiction: 'CA-ON' }, from);
  const consent = await call('PUT', '/v1/onboarding/consent',
    { telemetryPersonal, policyVersion: 1, clientSessionId: sid }, from);
  const signup = await call('POST', '/v1/auth/signup', {
    email: `${displayName.toLowerCase()}@example.test`,
    password: 'correct horse battery staple',
    displayName,
    eligibilityReceipt: elig.body?.receipt,
    clientSessionId: sid,
    consentReceipt: consent.body?.receipt,
  }, from);
  if (signup.status !== 201) throw new Error(`onboarding failed: ${signup.text}`);
  return {
    accountId: signup.body.profile.accountId,
    displayName,
    clientSessionId: sid,
    consentReceipt: signup.body.consentReceipt ?? null,
    auth: { authorization: `Bearer ${signup.body.accessToken}` },
    from,
  };
}

const asService = { 'x-service-token': SERVICE_TOKEN };

const TDM_RULES = {
  killLimit: 75,
  roundsToWin: null, maxRounds: null, sideSwitchAfter: null, roundLengthSec: null,
  bombTimerSec: null, defuseSec: null, plantSec: null, freezeSec: null, overtime: null,
};
const BOMB_SNAPSHOT = {
  killLimit: null,
  roundsToWin: 7, maxRounds: 12, sideSwitchAfter: 6, roundLengthSec: 105,
  bombTimerSec: 40, defuseSec: 7, plantSec: 3, freezeSec: 8, overtime: false,
};

const T0 = '2026-08-20T12:00:00.000Z';
const T1 = '2026-08-20T12:20:00.000Z';

function playerRow(who, team, over = {}) {
  return {
    accountId: who.accountId, displayName: who.displayName, team, role: null,
    kills: 3, deaths: 2, assists: 1, suicides: 0, teamKills: 0,
    headshots: 1, shotsFired: 40, shotsHit: 12, damageDealt: 400,
    plants: 0, defuses: 0, roundsPlayed: 5, timePlayedSec: 600, score: 350,
    disconnected: false, abandoned: false,
    joinedAt: T0, leftAt: null,
    weapons: { ar_vector: { shots: 40, hits: 12, kills: 3, headshots: 1 } },
    ...over,
  };
}

/**
 * A complete §4.2 TerminalResult for two real accounts. Bomb, so the rounds carry objective
 * actors — the redaction rule has nothing to redact in TDM.
 */
function bombResult(matchId, alpha, bravo, over = {}) {
  return {
    matchId,
    status: 'completed',
    rulesetVersion: 'bomb-1.0.0',
    statDefinitionVersion: '1.0.0',
    rulesSnapshot: BOMB_SNAPSHOT,
    serverBuild: '1.0.0', mapId: 'the-square', mapVersion: '1.0.0', region: 'yyz',
    mode: 'bomb',
    startedAt: T0, endedAt: T1,
    terminationReason: 'completed',
    outcomeReason: 'elimination',
    winnerTeam: 'alpha',
    invalidationReason: null,
    roster: [
      { accountId: alpha.accountId, team: 'alpha', joinedAt: T0, leftAt: null },
      { accountId: bravo.accountId, team: 'bravo', joinedAt: T0, leftAt: null },
    ],
    teamScores: { alpha: 7, bravo: 5 },
    rounds: [{
      index: 0, winner: 'alpha', reason: 'defuse',
      startedAt: T0, endedAt: T1,
      roles: { alpha: 'attacker', bravo: 'defender' },
      plant: { accountId: alpha.accountId, site: 'A', at: T0 },
      defuse: { accountId: bravo.accountId, at: T1 },
    }],
    players: [playerRow(alpha, 'alpha'), playerRow(bravo, 'bravo')],
    evidenceRef: `evidence/${matchId}`,
    ...over,
  };
}

function authoritativeEnvelope(input) {
  const result = structuredClone(input);
  delete result.evidenceRef;
  const players = Array.isArray(result.players) ? result.players : [];
  const evidence = {
    version: 1, matchId: result.matchId, rulesetVersion: result.rulesetVersion,
    serverBuild: result.serverBuild, protocolVersion: 2,
    authority: { matchId: result.matchId, rulesetVersion: result.rulesetVersion,
      statDefinitionVersion: result.statDefinitionVersion, rulesSnapshot: result.rulesSnapshot,
      serverBuild: result.serverBuild, mapId: result.mapId, mapVersion: result.mapVersion,
      region: result.region, mode: result.mode, startedAt: result.startedAt },
    terminalSummary: { status: result.status, endedAt: result.endedAt,
      terminationReason: result.terminationReason, outcomeReason: result.outcomeReason,
      winnerTeam: result.winnerTeam, invalidationReason: result.invalidationReason,
      teamScores: result.teamScores, failureReason: null },
    participants: players.map(({ accountId, displayName, team, role }) => ({ accountId, displayName, team, role })),
    roundSummary: result.rounds || [],
    combatSummary: players.map(({ accountId, kills, deaths, assists, suicides, teamKills,
      headshots, shotsFired, shotsHit, damageDealt, plants, defuses, roundsPlayed, score, weapons }) => ({
      accountId, kills, deaths, assists, suicides, teamKills, headshots, shotsFired, shotsHit,
      damageDealt, plants, defuses, roundsPlayed, score, weapons })),
    connectionSummary: players.map(({ accountId, joinedAt, leftAt, timePlayedSec,
      disconnected, abandoned }) => ({ accountId, joinedAt, leftAt, timePlayedSec, disconnected, abandoned })),
    objectives: [], eventTimeline: [], combatSamples: [],
    combatSampling: { observed: 0, every: 16, retained: 0, killsAlwaysRetained: true },
    droppedCombatSamples: 0, connectionFacts: [], droppedConnectionFacts: 0,
    antiCheatFlags: [], droppedAntiCheatFlags: 0, droppedRows: 0,
    roster: result.roster || [], result: structuredClone(result),
  };
  result.evidenceRef = `sha256:${evidenceDigest(evidence)}`;
  return { result, evidence };
}

const allocation = (matchId, mode = 'bomb') => ({
  matchId, region: 'yyz', mapId: 'the-square', mapVersion: '1.0.0', mode,
  status: 'allocated', rulesSnapshot: mode === 'bomb' ? BOMB_SNAPSHOT : TDM_RULES,
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// REQ-CC-042 — consent and telemetry contradictions
// ═══════════════════════════════════════════════════════════════════════════════════════

section('REQ-CC-042 — pre-auth consent has ONE migration lifecycle');

{
  // The contradiction was: §3a.3 said the signed-out row is DELETED at signup, while the schema
  // declared a `migrated_at` column for it and the store stamped that column and kept the row.
  // Two lifecycles, both written down. The surviving one is the DELETE; the column stays only
  // because dropping one is a CCR, and the schema has to say so or it reads as the other answer.
  const consentSection = sectionOf(HTTP_API, '3a.3 Consent');
  expect(/deleted on migration/i.test(consentSection),
    'http-api.md §3a.3 states one lifecycle: deleted on migration at signup, or on expiry', '');
  expect(/migrated_at/.test(DB_SCHEMA) && /always null/i.test(DB_SCHEMA),
    'db-schema.md says `pre_auth_consent.migrated_at` is always null and no writer sets it',
    'a column named for the OTHER lifecycle, left unexplained beside the one that survived');
}

await withApp(async ({ call, store }) => {
  // Drive the approved order by hand: the row has to be observed BEFORE signup, or "it is gone
  // afterwards" is equally consistent with a read that never worked.
  const sid = ulid();
  const from = { 'x-forwarded-for': nextIp() };
  const displayName = `Cc${ulid().slice(-10)}`;
  const elig = await call('POST', '/v1/onboarding/eligibility',
    { dateOfBirth: '1994-03-02', jurisdiction: 'CA-ON' }, from);
  const consent = await call('PUT', '/v1/onboarding/consent',
    { telemetryPersonal: true, policyVersion: 1, clientSessionId: sid }, from);

  const before = await store.preAuthConsent.get(sid);
  expect(!!before && before.telemetryPersonal === true,
    'the signed-out decision is stored against the client session (the control)',
    JSON.stringify(before));
  expect(!!before && (before.migratedAt === null || before.migratedAt === undefined),
    'no writer stamps `migratedAt` on the live row',
    `migratedAt=${JSON.stringify(before?.migratedAt)}`);

  const signup = await call('POST', '/v1/auth/signup', {
    email: `${displayName.toLowerCase()}@example.test`,
    password: 'correct horse battery staple',
    displayName,
    eligibilityReceipt: elig.body?.receipt,
    clientSessionId: sid,
    consentReceipt: consent.body?.receipt,
  }, from);
  expect(signup.status === 201, 'signup migrates the decision onto the account', signup.text);
  expect(signup.body?.profile?.consent?.telemetryPersonal === true,
    'the account carries the decision that was made signed out',
    JSON.stringify(signup.body?.profile?.consent));

  const after = await store.preAuthConsent.get(sid);
  expect(after === null,
    'the pre-auth consent row is GONE after signup, exactly as §3a.3 says',
    `store returned ${JSON.stringify(after)}`);
});

section('REQ-CC-042 — the retention class the contract gives preconsent is the one it is stored with');

{
  const s5 = sectionOf(TELEMETRY, '5. Privacy and retention classes');
  const row = s5.split('\n').find((l) => l.startsWith('|') && l.includes('funnel.preconsent'));
  const cells = String(row ?? '').split('|').map((c) => c.replace(/\*/g, '').trim());
  const privacy = cells[2];
  const retention = (cells[3] ?? '').split(' ')[0];
  const spec = REGISTRY.get('funnel.preconsent');
  expect(privacy === 'internal', '§5 classifies `funnel.preconsent` as internal', `row: ${row}`);
  expect(!!spec && spec.privacyClass === privacy,
    'the executable registry agrees on the privacy class',
    `contract ${privacy}, registry ${spec?.privacyClass}`);
  expect(!!spec && spec.retentionClass === retention,
    `the executable registry agrees on the retention class (${retention})`,
    `contract says ${retention}, registry says ${spec?.retentionClass} — the amendment that gave `
    + 'preconsent its own internal/short row landed in the document and not in the code, so an '
    + 'unlinked count was still being kept for 13 months');
}

section('REQ-CC-042 — the batch correlation id is the request header, not a body field');

await withApp(async ({ call }) => {
  const transport = sectionOf(TELEMETRY, '3.3 Transport');
  const privacy = sectionOf(TELEMETRY, '3.5 Privacy');
  const unlinked = sectionOf(TELEMETRY, '3.5.1');
  expect(/X-Correlation-Id/.test(transport) || /X-Correlation-Id/.test(privacy),
    'telemetry.md binds "the batch\'s correlation id" to the `X-Correlation-Id` request header',
    '§3.5 said "every batch carries the correlation ID", the §3.3 body has no such field, and '
    + '§3.5.1 forbids reusing "the batch\'s" — a rule about a value nothing defined');
  expect(/never the batch/i.test(unlinked),
    'telemetry.md §3.5.1 still forbids a preconsent event reusing the batch correlation id', '');

  const correlationId = ulid();
  const preconsent = (eventCorrelation) => ({
    schemaVersion: 1,
    events: [{
      name: 'funnel.preconsent', version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: eventCorrelation,
      payload: { step: 'landing', outcome: 'viewed' },
    }],
  });

  const reused = await call('POST', '/v1/telemetry/client', preconsent(correlationId),
    { 'x-correlation-id': correlationId });
  expect(reused.status === 400 && reused.code === 'VALIDATION_FAILED',
    'a preconsent event reusing the request correlation id is refused',
    `${reused.status} ${reused.code} ${reused.text}`);

  const fresh = await call('POST', '/v1/telemetry/client', preconsent(ulid()),
    { 'x-correlation-id': ulid() });
  expect(fresh.status === 202 && fresh.body?.accepted === 1,
    'the same batch with a FRESH event correlation id is accepted (the control)',
    `${fresh.status} ${fresh.text}`);
});

section('REQ-CC-042 — an invalid consent receipt has a closed code and a typed destination');

expect(/CONSENT_RECEIPT_INVALID/.test(ERRORS),
  'errors.md §3 defines `CONSENT_RECEIPT_INVALID`',
  'an expired or forged consent receipt silently dropped every personal event, and the client '
  + 'was never told — so it could not route the player back to consent');
{
  const row = ERRORS.split('\n').find((l) => l.startsWith('|') && l.includes('CONSENT_RECEIPT_INVALID'));
  expect(!!row && /consent/i.test(String(row).split('|').slice(-2).join(' ')),
    'its UI obligation routes the player to consent',
    `row: ${row ?? '(absent)'}`);
}
expect(/consentReceiptError/.test(TELEMETRY),
  'telemetry.md §3.3 publishes the typed receipt verdict on the 202 body',
  'the reason lived only in a server log line');

await withApp(async ({ call }) => {
  const who = await onboard(call);
  const personal = (receipt) => ({
    clientSessionId: who.clientSessionId,
    consentReceipt: receipt,
    schemaVersion: 1,
    events: [{
      name: 'flow.step', version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: ulid(),
      payload: { step: 'signup', outcome: 'completed', errorCode: null },
    }],
  });

  const forged = await call('POST', '/v1/telemetry/client', personal('not.a.receipt'),
    { ...who.auth, 'x-correlation-id': ulid() });
  expect(forged.status === 202,
    'a batch with a bad receipt is still 202 — the batch does not fail as a whole (§3.3)',
    `${forged.status} ${forged.text}`);
  expect(forged.body?.consentReceiptError?.code === 'CONSENT_RECEIPT_INVALID',
    'the 202 names CONSENT_RECEIPT_INVALID so the client can route to consent',
    JSON.stringify(forged.body));
  expect(typeof forged.body?.consentReceiptError?.reason === 'string'
    && forged.body.consentReceiptError.reason.length > 0,
    'the verdict carries a reason', JSON.stringify(forged.body?.consentReceiptError));
  expect(forged.body?.accepted === 0 && forged.body?.rejected === 1,
    'the personal event itself is still rejected', JSON.stringify(forged.body));

  const good = await call('POST', '/v1/telemetry/client', personal(who.consentReceipt),
    { ...who.auth, 'x-correlation-id': ulid() });
  expect(good.status === 202 && good.body?.accepted === 1 && good.body?.consentReceiptError === null,
    'a valid receipt accepts the event and reports no receipt error (the control)',
    `${good.status} ${JSON.stringify(good.body)}`);
});

section('REQ-CC-042 — the hard-coded step count matches the registry');

{
  const registryRow = TELEMETRY.split('\n')
    .find((l) => l.startsWith('| `flow.step`') && l.includes('step `signup`'));
  const stepEnum = String(registryRow).match(/step (.*?); outcome/);
  const stepCount = stepEnum ? (stepEnum[1].match(/`[a-z-]+`/g) || []).length : 0;
  const prose = TELEMETRY.match(/(\w+) steps × three outcomes/);
  const WORDS = { three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const claimed = prose ? (WORDS[prose[1]] ?? Number(prose[1])) : null;
  expect(stepCount > 0, 'the §3.3.1 flow.step registry row parses', `row: ${registryRow}`);
  expect(claimed === stepCount,
    `telemetry.md's "N steps × three outcomes" matches the ${stepCount} steps the §3.3.1 registry lists`,
    `prose claims ${claimed}, the registry lists ${stepCount} — the count was written when the `
    + 'enum was shorter and nothing recounts it');
  const spec = REGISTRY.get('flow.step');
  expect(!!spec && spec.fields.step.values.length === stepCount,
    'the executable registry carries exactly those steps',
    `registry enum: ${JSON.stringify(spec?.fields?.step?.values ?? null)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// REQ-CC-043 — exact result, history, submission, wire and facade shapes
// ═══════════════════════════════════════════════════════════════════════════════════════

section('REQ-CC-043 — §4.2 TerminalResult is exact to the leaf');

{
  const s42 = sectionOf(MATCH_RESULT, '4.2 `TerminalResult`');
  const block = s42.match(/```jsonc\n([\s\S]*?)```/)[1];
  // Only composite placeholders count: `"mapId": "…"` is an example VALUE, while `{ … }` and
  // `[ … ]` are a whole nested type the reader is expected to guess at.
  const placeholders = block.split('\n').filter((l) => /(\{|\[)\s*…\s*(\}|\])/.test(l));
  expect(placeholders.length === 0,
    '§4.2 names the nested result types instead of leaving `{ … }` placeholders',
    `still placeholders: ${placeholders.map((l) => l.trim()).join(' / ')}`);
}
{
  const s4 = sectionOf(MATCH_RESULT, '4. Result record');
  const line = s4.split('\n').find((l) => l.trim().startsWith('"invalidationReason"'));
  expect(!!line && /cheat-detected/.test(String(line)),
    '§4 base record types `invalidationReason` as the closed enum-or-null, not the literal null',
    `line: ${String(line).trim()}`);
}
{
  const s89 = sectionOf(WIRE, '8.9 `MSG_OUTCOME`');
  const stale = /every aborted match has none/.test(s89) && !/It is deleted/.test(s89);
  expect(!stale, 'wire-protocol.md §8.9 no longer asserts that every aborted match has no winner', '');
}

section('REQ-CC-043 — `draw` implies `timer`, in the contract as well as the code');

{
  const s42 = sectionOf(MATCH_RESULT, '4.2 `TerminalResult`');
  expect(/`draw`[^\n]*`timer`|`timer`[^\n]*`draw`/.test(s42) && /only|requires|implies/i.test(s42),
    '§4.2 states that `winnerTeam: draw` requires `outcomeReason: timer`',
    'the invariant table permitted draw beside elimination/defuse/detonation, which '
    + 'wire-protocol.md §8.9 forbids and the store refuses');
}

await withApp(async ({ call }) => {
  const alpha = await onboard(call);
  const bravo = await onboard(call);

  const id = ulid();
  const refused = await call('POST', `/v1/matches/${id}/result`,
    authoritativeEnvelope(bombResult(id, alpha, bravo, { winnerTeam: 'draw', outcomeReason: 'elimination' })),
    { ...asService, 'idempotency-key': `match-result:${id}` });
  expect(refused.status === 400 && refused.code === 'VALIDATION_FAILED',
    'a drawn match ended by elimination is refused',
    `${refused.status} ${refused.code} ${refused.text}`);

  const id2 = ulid();
  const accepted = await call('POST', `/v1/matches/${id2}/result`,
    authoritativeEnvelope(bombResult(id2, alpha, bravo, { winnerTeam: 'draw', outcomeReason: 'timer' })),
    { ...asService, 'idempotency-key': `match-result:${id2}` });
  expect(accepted.status === 200 && accepted.body?.applied === true,
    'a drawn match ended by the timer is accepted (the control)',
    `${accepted.status} ${accepted.text}`);
});

section('REQ-CC-043 — §11.5 history defers to the §4.3 discriminated union');

{
  const s115 = sectionOf(HTTP_API, '11.5 Stats and history');
  const historyBlock = s115.match(/GET \/v1\/profile\/:id\/matches[\s\S]*?```/)?.[0] ?? '';
  const pre17 = /"endedAt": "…",/.test(historyBlock)
    && /"result": "win\|loss\|draw\|null"/.test(historyBlock);
  expect(!pre17,
    '§11.5 no longer restates the pre-1.7 history item shape',
    'it fixed endedAt to a timestamp and always supplied result/teamScores/playerSummary, so it '
    + 'could not serialise the pending item its own detail endpoint defines');
  expect(/§4\.3/.test(s115),
    '§11.5 names `match-result.md` §4.3 as the normative history shape', '');
}

await withApp(async ({ call, store }) => {
  const alpha = await onboard(call);
  const bravo = await onboard(call);
  const live = ulid();
  await store.matches.record({
    ...allocation(live), status: 'in-progress', startedAt: T0,
    // `players` is what normaliseMatchResult reads to build `match_participants`; an
    // allocation carries identity and team only, which is all the roster is at that point.
    players: [
      { accountId: alpha.accountId, team: 'alpha', joinedAt: T0 },
      { accountId: bravo.accountId, team: 'bravo', joinedAt: T0 },
    ],
  });
  const page = await call('GET', `/v1/profile/${alpha.accountId}/matches`, undefined, alpha.auth);
  const item = (page.body?.items ?? []).find((i) => i.matchId === live);
  expect(!!item && item.status === 'pending',
    'a live match appears in history as `pending`', JSON.stringify(page.body));
  expect(!!item && Object.hasOwn(item, 'result') && item.result === null
    && Object.hasOwn(item, 'teamScores') && item.teamScores === null
    && Object.hasOwn(item, 'playerSummary') && item.playerSummary === null
    && Object.hasOwn(item, 'endedAt') && item.endedAt === null,
    'the pending item carries an explicit null for every outcome field, none omitted',
    JSON.stringify(item));
});

section('REQ-CC-043 — `ResultSubmission` is terminal-only and carries no response-only field');

{
  const s118 = sectionOf(HTTP_API, '11.8 Remaining endpoint schemas');
  expect(/ResultSubmission/.test(s118) && /ResultSubmission/.test(MATCH_RESULT),
    'the result POST body is the named `ResultSubmission`, defined once in match-result.md §5',
    '§11.8 said "the full match-result.md §4 record", which includes the pending variant and '
    + 'the response-only correlation envelope');
}

await withApp(async ({ call }) => {
  const alpha = await onboard(call);
  const bravo = await onboard(call);

  const id = ulid();
  const pending = await call('POST', `/v1/matches/${id}/result`,
    { result: { matchId: id, status: 'pending', mode: 'bomb', mapId: 'the-square', mapVersion: '1.0.0',
      startedAt: T0, endedAt: null, retryAfterMs: 2000 }, evidence: {} },
    { ...asService, 'idempotency-key': `match-result:${id}` });
  expect(pending.status === 400 && pending.code === 'VALIDATION_FAILED',
    'a `pending` body is refused by the submission endpoint',
    `${pending.status} ${pending.code} ${pending.text}`);

  const id2 = ulid();
  const withResponseOnly = bombResult(id2, alpha, bravo);
  withResponseOnly.correlationId = ulid();
  withResponseOnly.retryAfterMs = 2000;
  const refused = await call('POST', `/v1/matches/${id2}/result`, authoritativeEnvelope(withResponseOnly),
    { ...asService, 'idempotency-key': `match-result:${id2}` });
  expect(refused.status === 400 && refused.code === 'VALIDATION_FAILED',
    'a submission carrying the response-only `correlationId`/`retryAfterMs` is refused',
    `${refused.status} ${refused.code} ${refused.text}`);
  const paths = (refused.body?.error?.details?.fields ?? []).map((f) => f.path ?? f.key);
  expect(paths.includes('correlationId') && paths.includes('retryAfterMs'),
    'the refusal names both offending keys', JSON.stringify(paths));

  const id3 = ulid();
  const accepted = await call('POST', `/v1/matches/${id3}/result`, authoritativeEnvelope(bombResult(id3, alpha, bravo)),
    { ...asService, 'idempotency-key': `match-result:${id3}` });
  expect(accepted.status === 200 && accepted.body?.applied === true,
    'the identical submission without those keys is accepted (the control)',
    `${accepted.status} ${accepted.text}`);
});

section('REQ-CC-043 — objective-actor redaction is defined, not deferred');

{
  const s42 = sectionOf(MATCH_RESULT, '4.2 `TerminalResult`');
  expect(/objective actor/i.test(s42) && /participant/i.test(s42),
    '§4.2 defines the authorized round projection that §4.1 defers to it',
    '§4.1 said "whether they are RETURNED depends on §4.2" and §4.2 said nothing about them');
}

await withApp(async ({ call }) => {
  const alpha = await onboard(call);
  const bravo = await onboard(call);
  const stranger = await onboard(call);
  // §4.2: an outsider reads a match only when EVERY participant publishes their career. The
  // default is `nobody`, so without this the outsider gets the same 404 as a match that never
  // existed — a pass for the wrong reason, and the redaction would never run.
  for (const who of [alpha, bravo]) {
    const p = await call('PATCH', '/v1/profile/me', { privacy: { statsVisibility: 'everyone' } },
      { ...who.auth, 'idempotency-key': ulid() });
    if (p.status !== 200) throw new Error(`could not publish career: ${p.text}`);
  }
  const id = ulid();
  const res = await call('POST', `/v1/matches/${id}/result`, authoritativeEnvelope(bombResult(id, alpha, bravo)),
    { ...asService, 'idempotency-key': `match-result:${id}` });
  if (res.status !== 200) throw new Error(`submission failed: ${res.text}`);

  const participant = await call('GET', `/v1/matches/${id}`, undefined, alpha.auth);
  expect(participant.status === 200
    && participant.body?.rounds?.[0]?.plant?.accountId === alpha.accountId,
    'a participant sees who planted',
    `${participant.status} ${JSON.stringify(participant.body?.rounds?.[0]?.plant)}`);

  const outsider = await call('GET', `/v1/matches/${id}`, undefined, stranger.auth);
  expect(outsider.status === 200
    && outsider.body?.rounds?.[0]?.plant?.accountId === null
    && outsider.body?.rounds?.[0]?.plant?.site === 'A',
    'a non-participant sees the round and the site, and a null actor',
    `${outsider.status} ${JSON.stringify(outsider.body?.rounds?.[0]?.plant)}`);
});

section('REQ-CC-043 — the socket result is provisional or carries the invalidation reason');

{
  const s53 = sectionOf(NET_FACADE, '5.3 Typed event payloads');
  const carriesReason = /matchEnded[\s\S]*?invalidationReason/.test(s53);
  const declaresProvisional = /provisional/i.test(s53);
  expect(carriesReason || declaresProvisional,
    'net-facade.md §5.3 either carries `invalidationReason` on `matchEnded` or declares it provisional',
    'the facade claimed the outcome carried everything the results screen needs, while an '
    + 'invalidated match has a reason no wire field can deliver');
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// REQ-CC-044 — one reachable terminal lifecycle and one aggregation policy
// ═══════════════════════════════════════════════════════════════════════════════════════

section('REQ-CC-044 — every pending sub-state is reachable and projectable');

{
  const s42 = sectionOf(MATCH_RESULT, '4.2 `TerminalResult`');
  const pendingBlock = s42.match(/status: "pending"[\s\S]*?```/)?.[0] ?? '';
  const startedLine = pendingBlock.split('\n').find((l) => l.includes('"startedAt"'));
  expect(!!startedLine && /\|\s*null/.test(String(startedLine)),
    '§4.2\'s pending variant types `startedAt` as nullable',
    `an allocated row has no startedAt and the contract required one: ${String(startedLine).trim()}`);
  expect(/allocated/.test(s42) && /in-progress/.test(s42),
    '§4.2 names the three stored states behind `pending` and what produces each',
    'the contract offered one pending shape for three rows that differ in exactly the two '
    + 'fields it fixed');
}

await withApp(async ({ call, store }) => {
  const alpha = await onboard(call);
  const bravo = await onboard(call);
  const players = [
    { accountId: alpha.accountId, team: 'alpha', joinedAt: T0 },
    { accountId: bravo.accountId, team: 'bravo', joinedAt: T0 },
  ];

  const allocatedId = ulid();
  await store.matches.record({ ...allocation(allocatedId), players });
  const a = await call('GET', `/v1/matches/${allocatedId}`, undefined, alpha.auth);
  expect(a.status === 200 && a.body?.status === 'pending'
    && Object.hasOwn(a.body, 'startedAt') && a.body.startedAt === null
    && Object.hasOwn(a.body, 'endedAt') && a.body.endedAt === null,
    'allocated → pending, startedAt null and endedAt null, both keys present',
    `${a.status} ${JSON.stringify(a.body)}`);

  const liveId = ulid();
  await store.matches.record({ ...allocation(liveId), status: 'in-progress', startedAt: T0, players });
  const l = await call('GET', `/v1/matches/${liveId}`, undefined, alpha.auth);
  expect(l.status === 200 && l.body?.status === 'pending'
    && l.body.startedAt === T0 && l.body.endedAt === null,
    'in-progress with no endedAt → pending, LIVE', JSON.stringify(l.body));

  const queuedId = ulid();
  await store.matches.record({
    ...allocation(queuedId), status: 'in-progress', startedAt: T0, endedAt: T1, players,
  });
  const q = await call('GET', `/v1/matches/${queuedId}`, undefined, alpha.auth);
  expect(q.status === 200 && q.body?.status === 'pending'
    && q.body.startedAt === T0 && q.body.endedAt === T1 && typeof q.body.retryAfterMs === 'number',
    'in-progress with endedAt → pending, ended and result-queued', JSON.stringify(q.body));
});

section('REQ-CC-044 — invalidation is a submission-time decision, and the contract says so');

{
  const s5 = sectionOf(MATCH_RESULT, '5. Submission and idempotency');
  expect(/invalidat/i.test(s5) && /(submission-time|first and only terminal|append-only)/i.test(s5),
    'match-result.md §5 states where invalidation may come from, and what an admin path would need',
    'the contract had immutable results and an admin-authored `match.invalidated` with no '
    + 'command that could produce one');
  expect(MATCH_STATUS_TRANSITIONS.completed.length === 0,
    'the executable lifecycle gives a completed match no outgoing edge', '');
}

await withApp(async ({ call }) => {
  const alpha = await onboard(call);
  const bravo = await onboard(call);

  const first = ulid();
  const submitted = await call('POST', `/v1/matches/${first}/result`,
    authoritativeEnvelope(bombResult(first, alpha, bravo, {
      status: 'invalidated', terminationReason: 'invalidated',
      outcomeReason: 'no-contest', winnerTeam: null, invalidationReason: 'cheat-detected',
    })), { ...asService, 'idempotency-key': `match-result:${first}` });
  expect(submitted.status === 200 && submitted.body?.status === 'invalidated',
    'a match may be submitted as invalidated at its first and only terminal write',
    `${submitted.status} ${submitted.text}`);

  const second = ulid();
  const done = await call('POST', `/v1/matches/${second}/result`, authoritativeEnvelope(bombResult(second, alpha, bravo)),
    { ...asService, 'idempotency-key': `match-result:${second}` });
  if (done.status !== 200) throw new Error(`setup failed: ${done.text}`);
  const after = await call('POST', `/v1/matches/${second}/result`,
    authoritativeEnvelope(bombResult(second, alpha, bravo, {
      status: 'invalidated', terminationReason: 'invalidated',
      outcomeReason: 'no-contest', winnerTeam: null, invalidationReason: 'admin-review',
    })), { ...asService, 'idempotency-key': `match-result:${second}` });
  expect(after.status === 409 && after.code === 'CONFLICT',
    'a COMPLETED match cannot be invalidated afterwards — there is no append-only command yet',
    `${after.status} ${after.code} ${after.text}`);
});

section('REQ-CC-044 — one aggregation matrix, and the career obeys it');

{
  const s6 = sectionOf(MATCH_RESULT, '6. Career aggregation');
  for (const term of ['forfeit', 'abandon', 'no-contest', 'invalidated']) {
    expect(new RegExp(term).test(s6),
      `§6's aggregation matrix has a row for ${term}`,
      '§6 said only "invalidated matches do not aggregate", leaving forfeit, abandon and '
      + 'no-contest to inference — and bomb-rules.md §9 inferred differently');
  }
  expect(/result_applied_at/.test(s6) && /match\.result_applied/.test(s6),
    '§6 defines `result_applied_at` and when `match.result_applied` is emitted, including for '
    + 'an intentional skip', '');
}

await withApp(async ({ call }) => {
  const alpha = await onboard(call);
  const bravo = await onboard(call);
  const totals = async (who) => {
    const r = await call('GET', `/v1/profile/${who.accountId}/stats?mode=bomb`, undefined, who.auth);
    return r.body?.totals ?? null;
  };

  const before = await totals(alpha);
  expect(!!before, 'the career endpoint answers before any match', JSON.stringify(before));

  const forfeitId = ulid();
  const f = await call('POST', `/v1/matches/${forfeitId}/result`,
    authoritativeEnvelope(bombResult(forfeitId, alpha, bravo, {
      status: 'aborted', terminationReason: 'aborted', outcomeReason: 'forfeit', winnerTeam: 'alpha',
    })), { ...asService, 'idempotency-key': `match-result:${forfeitId}` });
  if (f.status !== 200) throw new Error(`forfeit submission failed: ${f.text}`);
  const afterForfeit = await totals(alpha);
  expect(afterForfeit.matches === before.matches + 1 && afterForfeit.wins === before.wins + 1,
    'an aborted forfeit aggregates, and the surviving team takes the win',
    `${JSON.stringify(before)} → ${JSON.stringify(afterForfeit)}`);

  const ncId = ulid();
  await call('POST', `/v1/matches/${ncId}/result`,
    authoritativeEnvelope(bombResult(ncId, alpha, bravo, {
      status: 'aborted', terminationReason: 'aborted', outcomeReason: 'no-contest', winnerTeam: null,
    })), { ...asService, 'idempotency-key': `match-result:${ncId}` });
  const afterNc = await totals(alpha);
  expect(afterNc.matches === afterForfeit.matches && afterNc.kills === afterForfeit.kills,
    'a no-contest is recorded and does NOT aggregate',
    `${JSON.stringify(afterForfeit)} → ${JSON.stringify(afterNc)}`);

  const invId = ulid();
  const inv = await call('POST', `/v1/matches/${invId}/result`,
    authoritativeEnvelope(bombResult(invId, alpha, bravo, {
      status: 'invalidated', terminationReason: 'invalidated', outcomeReason: 'no-contest',
      winnerTeam: null, invalidationReason: 'cheat-detected',
    })), { ...asService, 'idempotency-key': `match-result:${invId}` });
  const afterInv = await totals(alpha);
  expect(afterInv.matches === afterNc.matches && afterInv.kills === afterNc.kills,
    'an invalidated match is recorded and does NOT aggregate',
    `${JSON.stringify(afterNc)} → ${JSON.stringify(afterInv)}`);
  expect(typeof inv.body?.resultAppliedAt === 'string' && inv.body?.appliedToCount === 0,
    '`result_applied_at` is stamped even when the application was an intentional skip',
    JSON.stringify(inv.body));
});

section('REQ-CC-044 — the single-team disconnect names an exact outcomeReason');

{
  const s9 = sectionOf(BOMB_RULES, '9. Backfill and disconnects');
  const row = s9.split('\n').find((l) => /drops? to zero connected/i.test(l));
  const named = String(row ?? '').match(/`?outcomeReason`?: `?(forfeit|abandon)`?/);
  expect(!!named,
    'bomb-rules.md §9 names `forfeit` or `abandon` for a team dropping to zero connected',
    `the row said only that the remaining team wins: ${String(row ?? '(row not found)').trim()}`);
  if (named) {
    expect(OUTCOME_REASONS.aborted.includes(named[1]),
      `\`${named[1]}\` is a legal aborted outcomeReason in the executable matrix`, '');
  }
}

section('REQ-CC-044 — the schema encodes the union, in the contract and in the database');

{
  const s4 = sectionOf(DB_SCHEMA, '4. Rooms and matches');
  expect(/check/i.test(s4),
    'db-schema.md §4 documents the CHECK constraints that encode the §4.2 union',
    'the sketch permitted a completed match carrying an invalidation reason, a drawn '
    + 'elimination, and an aborted no-contest with a winner — all forbidden by the union');
}

await withApp(async ({ store }) => {
  const forbidden = [
    ['a completed match carrying an invalidation reason', {
      status: 'completed', terminationReason: 'completed', outcomeReason: 'timer',
      winnerTeam: 'draw', invalidationReason: 'cheat-detected',
    }],
    ['a drawn elimination', {
      status: 'completed', terminationReason: 'completed', outcomeReason: 'elimination',
      winnerTeam: 'draw', invalidationReason: null,
    }],
    ['an aborted no-contest with a winner', {
      status: 'aborted', terminationReason: 'aborted', outcomeReason: 'no-contest',
      winnerTeam: 'alpha', invalidationReason: null,
    }],
    ['an invalidated match with a winner', {
      status: 'invalidated', terminationReason: 'invalidated', outcomeReason: 'no-contest',
      winnerTeam: 'alpha', invalidationReason: 'server-fault',
    }],
  ];
  for (const [label, over] of forbidden) {
    const id = ulid();
    let threw = null;
    try {
      await store.matches.record({
        matchId: id, region: 'yyz', mapId: 'the-square', mapVersion: '1.0.0', mode: 'bomb',
        rulesetVersion: 'bomb-1.0.0', statDefinitionVersion: '1.0.0', serverBuild: '1.0.0',
        rulesSnapshot: BOMB_SNAPSHOT, teamScores: { alpha: 7, bravo: 5 }, rounds: [],
        roster: [], players: [], evidenceRef: `evidence/${id}`,
        startedAt: T0, endedAt: T1, ...over,
      });
    } catch (err) { threw = err; }
    expect(threw instanceof Error, `the store refuses ${label}`, 'it was stored');
  }
});

console.log(`\n${failures === 0 ? 'contracttest OK' : `contracttest FAILED (${failures})`}`);
process.exit(failures ? 1 : 0);
