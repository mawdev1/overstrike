/**
 * Store conformance, in plain Node.  contracts/db-schema.md §9.
 *
 * The same suite runs against every adapter, because an adapter that passes on memory and
 * fails on Postgres is the failure mode this interface exists to prevent. Postgres is included
 * only when DATABASE_URL is set; without it the suite says so and skips, rather than passing
 * quietly and letting a broken Postgres adapter ship.
 *
 * Every claim here is paired with a CONTROL: a case that must produce the opposite result.
 * A test that asserts "the row is not there" passes just as happily when nothing was ever
 * written, when the store is broken, or when the assertion is looking in the wrong place.
 * The control is what proves the check can see a row at all — the difference between a test
 * and a green light.
 *
 *   node platform/test/storetest.mjs
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMemoryStore } from '../src/core/store/memory.js';
import { createPostgresStore } from '../src/core/store/postgres.js';
import {
  loadMigrations, planMigrations, runMigrations, MIGRATIONS_DIR,
} from '../src/core/migrate.js';
import { ulid } from '../src/core/ids.js';

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const check = (n, cond, d = '') => (cond ? ok(n) : bad(n, d));

/** Assert a call throws with a specific contract code. Anything else — including success. */
async function throwsCode(name, code, fn) {
  try {
    await fn();
    bad(name, `expected ${code}, but the call succeeded`);
  } catch (err) {
    if (err?.code === code) ok(name);
    else bad(name, `expected ${code}, got ${err?.code ?? err?.message ?? err}`);
  }
}

/** The other half of a refusal test: the same call shape must succeed when it should. */
async function expectOk(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, `threw ${err?.code ?? ''} ${err?.message ?? err}`);
  }
}

/**
 * NFKC + case + confusable folding (auth.md §9). The real one lives in the auth lane with a
 * maintained table; this is enough to prove the store enforces uniqueness on the FOLDED
 * column, which is the property under test.
 */
const CONFUSABLES = new Map(Object.entries({
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
  'ѕ': 's', 'і': 'i', 'ј': 'j', 'ԁ': 'd', 'ɡ': 'g', 'ⅼ': 'l', 'ᴏ': 'o',
}));
const fold = (s) => [...s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()]
  .map((c) => CONFUSABLES.get(c) ?? c).join('');

const iso = (msFromNow = 0) => new Date(Date.now() + msFromNow).toISOString();

/** A minimal valid account. Unique per call, so a suite run leaves no collisions behind. */
function newAccount(name = `player_${ulid().slice(-8)}`) {
  return {
    accountId: ulid(),
    displayName: name,
    displayNameFolded: fold(name),
    emailHash: `h_${ulid()}`,
  };
}

function newEvent(subjectId, overrides = {}) {
  return {
    eventId: ulid(),
    eventType: 'account.created',
    eventVersion: 1,
    subjectKind: 'account',
    subjectId,
    correlationId: ulid(),
    actor: { kind: 'system', id: 'storetest' },
    payload: { hello: 'world' },
    privacyClass: 'internal',
    retentionClass: 'standard',
    schemaRef: 'events/account.created/v1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------
// 1. tx rollback genuinely discards writes
// ---------------------------------------------------------------------------------------
async function testRollback(store, tag) {
  console.log(`\n[${tag}] transactions`);

  // CONTROL: the same write, committed, must be visible. Without this the rollback assertion
  // below is satisfied by a store that never writes anything.
  const committed = newAccount();
  await store.tx(async (tx) => { await store.accounts.create(committed, tx); });
  check('control: a committed tx write is visible afterwards',
    (await store.accounts.byId(committed.accountId)) !== null,
    'the committed account was not found — the write path itself is broken');

  const rolled = newAccount();
  const sentinel = new Error('storetest: deliberate rollback');
  let sawInsideTx = false;
  try {
    await store.tx(async (tx) => {
      await store.accounts.create(rolled, tx);
      // Visible to the transaction that wrote it, which is what makes the rollback meaningful:
      // the write really happened and was really discarded.
      sawInsideTx = (await store.accounts.byId(rolled.accountId, tx)) !== null;
      throw sentinel;
    });
    bad('a throwing tx propagates its error', 'tx() resolved instead of throwing');
  } catch (err) {
    check('a throwing tx propagates its error', err === sentinel || err.cause === sentinel,
      `got ${err?.message}`);
  }
  check('the write was visible inside the tx before it rolled back', sawInsideTx,
    'the account was not readable through its own tx handle');
  check('rollback discards the write',
    (await store.accounts.byId(rolled.accountId)) === null,
    'the account survived a rolled-back transaction');

  // Rollback of an UPDATE, not just an INSERT: an undo-log implementation can get one right
  // and the other wrong.
  const before = await store.accounts.byId(committed.accountId);
  await store.tx(async (tx) => {
    await store.accounts.update(committed.accountId, { status: 'banned' }, tx);
    throw new Error('storetest: rollback the update');
  }).catch(() => {});
  const after = await store.accounts.byId(committed.accountId);
  check('rollback discards an update as well as an insert',
    after.status === before.status && after.status === 'active',
    `status is ${after.status}`);

  // A handle must not outlive its transaction: using one afterwards would write to a state
  // that is no longer anybody's.
  let escaped = null;
  await store.tx(async (tx) => { escaped = tx; });
  await throwsCode('a tx handle used after commit is refused', 'INTERNAL_ERROR',
    () => store.accounts.byId(committed.accountId, escaped));

  // Concurrency: overlapping transactions must not lose each other's writes. Snapshot-and-swap
  // without serialisation passes every single-threaded test and fails exactly here.
  const racer = newAccount();
  await store.accounts.create(racer);
  await Promise.all([1, 2, 3, 4, 5].map(() =>
    store.tx((tx) => store.stats.applyDelta(racer.accountId, 'tdm', 'v1', { kills: 1 }, tx))));
  const raced = await store.stats.get(racer.accountId, 'tdm', 'v1');
  check('five concurrent transactions all land (no lost update)', raced.kills === 5,
    `kills = ${raced.kills}, expected 5`);
}

// ---------------------------------------------------------------------------------------
// 2. outbox insert commits atomically with the state change
// ---------------------------------------------------------------------------------------
async function testOutboxAtomicity(store, tag) {
  console.log(`\n[${tag}] outbox atomicity`);

  const acct = newAccount();
  const event = newEvent(acct.accountId);
  await store.tx(async (tx) => {
    await store.accounts.create(acct, tx);
    await store.outbox.insert(event, tx);
  });
  const unpublished = await store.outbox.claimUnpublished(500);
  check('control: state change and its event both commit',
    (await store.accounts.byId(acct.accountId)) !== null
      && unpublished.some((e) => e.eventId === event.eventId),
    'the committed pair is not both present');

  // The case the pattern exists for: the state change fails after the event was queued. If the
  // outbox were written outside the transaction, consumers would be told about an account that
  // does not exist — and at-least-once delivery means they would be told repeatedly.
  const ghost = newAccount();
  const ghostEvent = newEvent(ghost.accountId);
  await store.tx(async (tx) => {
    await store.accounts.create(ghost, tx);
    await store.outbox.insert(ghostEvent, tx);
    throw new Error('storetest: the state change fails after the event is queued');
  }).catch(() => {});

  check('a rolled-back tx leaves no account', (await store.accounts.byId(ghost.accountId)) === null,
    'the account survived');
  const after = await store.outbox.claimUnpublished(500);
  check('a rolled-back tx leaves no event either',
    !after.some((e) => e.eventId === ghostEvent.eventId),
    'the event outlived the state change it describes');

  // schema_ref is required on the wire, so it must be required in the table (REQ-CC-019).
  await throwsCode('an event without schema_ref is refused', 'VALIDATION_FAILED', () => {
    const e = newEvent(acct.accountId);
    delete e.schemaRef;
    return store.outbox.insert(e);
  });

  // Relay bookkeeping.
  await store.outbox.markPublished([event.eventId], iso());
  const stillPending = await store.outbox.claimUnpublished(500);
  check('a published event leaves the unpublished set',
    !stillPending.some((e) => e.eventId === event.eventId), 'it is still being claimed');

  const failing = newEvent(acct.accountId);
  await store.outbox.insert(failing);
  await store.outbox.recordFailure(failing.eventId, 'relay refused');
  await store.outbox.recordFailure(failing.eventId, 'relay refused again');
  const [pending] = (await store.outbox.claimUnpublished(500)).filter((e) => e.eventId === failing.eventId);
  check('failures accumulate on the event', pending.attempts === 2 && pending.lastError === 'relay refused again',
    `attempts=${pending?.attempts} lastError=${pending?.lastError}`);
  await store.outbox.deadLetter(failing.eventId, iso());
  check('a dead-lettered event stops being claimed',
    !(await store.outbox.claimUnpublished(500)).some((e) => e.eventId === failing.eventId),
    'it is still in the claim set');
}

// ---------------------------------------------------------------------------------------
// 3. audit rows cannot be updated or deleted through the interface
// ---------------------------------------------------------------------------------------
async function testAuditAppendOnly(store, tag) {
  console.log(`\n[${tag}] audit is append-only`);

  const acct = newAccount();
  await store.accounts.create(acct);
  const row = await store.audit.insert({
    actorKind: 'admin', actorId: 'admin_1', actorRole: 'moderator',
    action: 'account.restrict', subjectKind: 'account', subjectId: acct.accountId,
    reasonCode: 'MOD_REVIEW',
    beforeSummary: { status: 'active' }, afterSummary: { status: 'restricted' },
    correlationId: ulid(),
  });

  for (const method of ['update', 'delete', 'remove', 'patch', 'purge']) {
    check(`audit exposes no ${method}()`, typeof store.audit[method] === 'undefined',
      `store.audit.${method} exists — the interface can rewrite the record`);
  }

  // CONTROL: the same shape of tampering DOES take effect on a mutable table. Without this,
  // "the audit row did not change" is equally true of a store that ignores every write.
  await store.accounts.update(acct.accountId, { status: 'restricted' });
  check('control: a mutable table does change when written',
    (await store.accounts.byId(acct.accountId)).status === 'restricted',
    'accounts.update did nothing, so the audit comparison below proves nothing');

  // Reads hand back copies. Mutating what the interface returned must not reach the store,
  // or "append-only" only holds until someone keeps a reference.
  row.reasonCode = 'TAMPERED';
  row.afterSummary.status = 'active';
  const listed = await store.audit.list({ subjectId: acct.accountId });
  listed[0].action = 'TAMPERED';
  const reread = await store.audit.list({ subjectId: acct.accountId });
  check('a returned audit row is a copy, not the stored row',
    reread.length === 1
      && reread[0].reasonCode === 'MOD_REVIEW'
      && reread[0].action === 'account.restrict'
      && reread[0].afterSummary.status === 'restricted',
    JSON.stringify(reread[0]));

  // reason_code is NOT NULL: an unexplained privileged action is a defect, not a row.
  await throwsCode('an audit row without a reason code is refused', 'VALIDATION_FAILED',
    () => store.audit.insert({
      actorKind: 'admin', action: 'account.ban',
      subjectKind: 'account', subjectId: acct.accountId,
    }));
}

// ---------------------------------------------------------------------------------------
// 4. idempotency replay returns the stored response without re-executing
// ---------------------------------------------------------------------------------------
async function testIdempotency(store, tag) {
  console.log(`\n[${tag}] idempotency`);

  let executions = 0;
  /** What a handler does: check the key, run the work once, record the response. */
  const handle = async (key, actorId, requestHash, work) => {
    const seen = await store.idempotency.get(key, actorId);
    if (seen) {
      if (seen.requestHash !== requestHash) {
        return store.idempotency.put({ key, actorId, requestHash, expiresAt: iso(86400e3) });
      }
      return { responseStatus: seen.responseStatus, responseBody: seen.responseBody, replayed: true };
    }
    executions++;
    const result = await work();
    await store.idempotency.put({
      key, actorId, requestHash,
      responseStatus: 201, responseBody: result,
      expiresAt: iso(86400e3),
    });
    return { responseStatus: 201, responseBody: result, replayed: false };
  };

  const actor = ulid();
  const key = ulid();
  const first = await handle(key, actor, 'hash-a', async () => ({ orderId: 'order_1' }));
  const second = await handle(key, actor, 'hash-a', async () => ({ orderId: 'order_2' }));

  check('the first call executes', executions === 1 && first.responseBody.orderId === 'order_1',
    `executions=${executions}`);
  check('the replay does not re-execute', executions === 1, `executions=${executions} after the replay`);
  check('the replay returns the stored response',
    second.replayed === true && second.responseStatus === 201 && second.responseBody.orderId === 'order_1',
    JSON.stringify(second));

  // CONTROL: the counter is capable of moving. A test whose work function is never called for
  // any reason would otherwise report perfect idempotency.
  await handle(ulid(), actor, 'hash-a', async () => ({ orderId: 'order_3' }));
  check('control: a different key does execute', executions === 2, `executions=${executions}`);

  // The dangerous reuse: same key, different request. Returning the first response here would
  // silently drop the second request while telling the client it succeeded.
  await throwsCode('the same key with a different request hash is refused', 'IDEMPOTENCY_KEY_REUSED',
    () => store.idempotency.put({ key, actorId: actor, requestHash: 'hash-b', expiresAt: iso(86400e3) }));

  // The key is scoped per actor: one client must not be able to read another's response by
  // guessing a key.
  const otherActor = ulid();
  check('keys are scoped per actor', (await store.idempotency.get(key, otherActor)) === null,
    'another actor can read the stored response');
}

// ---------------------------------------------------------------------------------------
// 5. confusable display names collide on display_name_folded
// ---------------------------------------------------------------------------------------
async function testConfusables(store, tag) {
  console.log(`\n[${tag}] display name folding`);

  const suffix = ulid().slice(-6).toLowerCase();
  const latin = `Ada${suffix}`;
  const cyrillic = `Аdа${suffix}`;          // U+0410, U+0430 — looks identical, is not
  const upper = `ADA${suffix}`;

  check('the two names are genuinely different strings', latin !== cyrillic,
    'the test fixture is not testing what it claims');
  check('they fold to the same value', fold(latin) === fold(cyrillic),
    `${fold(latin)} vs ${fold(cyrillic)}`);

  await store.accounts.create({
    accountId: ulid(), displayName: latin, displayNameFolded: fold(latin), emailHash: `h_${ulid()}`,
  });

  await throwsCode('a homoglyph of an existing name is rejected', 'NAME_TAKEN',
    () => store.accounts.create({
      accountId: ulid(), displayName: cyrillic, displayNameFolded: fold(cyrillic), emailHash: `h_${ulid()}`,
    }));
  await throwsCode('a case variant of an existing name is rejected', 'NAME_TAKEN',
    () => store.accounts.create({
      accountId: ulid(), displayName: upper, displayNameFolded: fold(upper), emailHash: `h_${ulid()}`,
    }));

  // CONTROL: a name that merely looks similar to a human but folds differently must still be
  // allowed. A store that rejected every create would pass both assertions above.
  const distinct = `Adam${suffix}`;
  const created = await store.accounts.create({
    accountId: ulid(), displayName: distinct, displayNameFolded: fold(distinct), emailHash: `h_${ulid()}`,
  });
  check('control: a genuinely different name is accepted', created.displayName === distinct,
    'a distinct name was rejected, so the rejections above prove nothing');

  // The collision must be on the folded column specifically: the raw names differ, so a
  // uniqueness constraint on display_name would have let the impersonation through.
  const owner = await store.accounts.byNameFolded(fold(cyrillic));
  check('lookup by folded name finds the original holder',
    owner !== null && owner.displayName === latin,
    `byNameFolded returned ${owner?.displayName}`);

  // A rename into someone else's folded name is the same attack by another route.
  await throwsCode('renaming onto a taken folded name is rejected', 'NAME_TAKEN',
    () => store.accounts.update(created.accountId,
      { displayName: cyrillic, displayNameFolded: fold(cyrillic) }));
}

// ---------------------------------------------------------------------------------------
// 6. stats applyDelta is additive and correct
// ---------------------------------------------------------------------------------------
async function testStats(store, tag) {
  console.log(`\n[${tag}] stats`);

  const acct = newAccount();
  await store.accounts.create(acct);

  check('an account with no matches has no stats row',
    (await store.stats.get(acct.accountId, 'bomb', 'v1')) === null, 'a row existed already');

  const first = await store.stats.applyDelta(acct.accountId, 'bomb', 'v1',
    { kills: 7, deaths: 3, assists: 2, headshots: 4, shotsFired: 100, shotsHit: 31,
      matches: 1, wins: 1, roundsPlayed: 11, timePlayedSec: 640 });
  check('the first delta creates the row with exactly the delta',
    first.kills === 7 && first.deaths === 3 && first.matches === 1 && first.draws === 0
      && first.losses === 0 && first.shotsHit === 31,
    JSON.stringify(first));

  const second = await store.stats.applyDelta(acct.accountId, 'bomb', 'v1',
    { kills: 5, deaths: 6, matches: 1, draws: 1, roundsPlayed: 12, timePlayedSec: 700 });
  check('deltas add rather than replace',
    second.kills === 12 && second.deaths === 9 && second.matches === 2
      && second.wins === 1 && second.draws === 1 && second.roundsPlayed === 23
      && second.timePlayedSec === 1340 && second.assists === 2,
    JSON.stringify(second));

  // draws is a real column, not a computed leftover: Bomb draws at 6-6 (bomb-rules.md §2.1a)
  // and a career surface that returns a field with no column returns zero forever.
  check('draws is stored and readable', second.draws === 1, `draws=${second.draws}`);

  // CONTROL: the counters are not global. If applyDelta ignored its key, this row would
  // already hold the twelve kills above.
  const otherMode = await store.stats.applyDelta(acct.accountId, 'tdm', 'v1', { kills: 1 });
  check('control: a different mode is a different row', otherMode.kills === 1, `kills=${otherMode.kills}`);
  const otherVersion = await store.stats.applyDelta(acct.accountId, 'bomb', 'v2', { kills: 1 });
  check('control: a different stat definition version is a different row',
    otherVersion.kills === 1,
    'a definition change silently rewrote history');
  check('the original row is untouched by the others',
    (await store.stats.get(acct.accountId, 'bomb', 'v1')).kills === 12,
    'the other rows leaked into it');
  check('listForAccount returns every mode and version',
    (await store.stats.listForAccount(acct.accountId)).length === 3,
    'wrong number of career rows');

  // Negative deltas are legitimate: a match invalidated after its result was applied is
  // reversed by applying the negation, not by editing the row.
  const reversed = await store.stats.applyDelta(acct.accountId, 'tdm', 'v1', { kills: -1 });
  check('a negative delta reverses an applied result', reversed.kills === 0, `kills=${reversed.kills}`);

  await throwsCode('an unknown counter is refused rather than silently dropped', 'VALIDATION_FAILED',
    () => store.stats.applyDelta(acct.accountId, 'tdm', 'v1', { kilz: 5 }));

  const weapon = await store.weaponStats.applyDelta(acct.accountId, 'bomb', 'ar_default', 'v1',
    { shots: 30, hits: 11, kills: 2, headshots: 1 });
  check('weapon stats accumulate on their own key',
    weapon.shots === 30 && weapon.hits === 11 && weapon.statDefinitionVersion === 'v1',
    JSON.stringify(weapon));
  const weapon2 = await store.weaponStats.applyDelta(acct.accountId, 'bomb', 'ar_default', 'v2', { shots: 5 });
  check('control: weapon stats are keyed by stat definition version too', weapon2.shots === 5,
    'v2 inherited v1 totals');
}

// ---------------------------------------------------------------------------------------
// Interface conformance: the pieces the platform will lean on that are not in the six proofs.
// ---------------------------------------------------------------------------------------
async function testInterface(store, tag) {
  console.log(`\n[${tag}] interface`);

  const acct = newAccount();
  await store.accounts.create(acct);

  check('health reports ok', (await store.health()).ok === true, 'health is not ok');

  // Foreign keys are declared in the schema, so the memory adapter must enforce them too —
  // otherwise a test suite that is green on memory tells you nothing about Postgres.
  await throwsCode('a session for a missing account is refused', 'NOT_FOUND',
    () => store.sessions.create({
      sessionId: ulid(), accountId: ulid(), refreshFamilyId: ulid(), ipClass: 'ca-on',
    }));

  const familyId = ulid();
  const session = await store.sessions.create({
    sessionId: ulid(), accountId: acct.accountId, refreshFamilyId: familyId,
    deviceLabel: 'desktop', userAgentClass: 'chromium', ipClass: 'ca-on',
  });
  check('a session stores an ip CLASS, never an address', session.ipClass === 'ca-on',
    JSON.stringify(session));

  const token = await store.refreshTokens.create({
    tokenId: ulid(), familyId, accountId: acct.accountId,
    sessionId: session.sessionId, expiresAt: iso(30 * 86400e3),
  });
  await store.refreshTokens.markUsed(token.tokenId, iso());
  await throwsCode('replaying a used refresh token is refused', 'CONFLICT',
    () => store.refreshTokens.markUsed(token.tokenId, iso()));

  // Reuse revokes the whole family, not just the replayed token: the attacker holds a copy of
  // everything in the chain, so revoking one link leaves them the rest.
  const revoked = await store.sessions.revokeFamily(familyId, 'refresh_reuse', iso());
  check('reuse revokes the entire refresh family', revoked === 1, `revoked ${revoked} sessions`);
  check('the revoked session records why',
    (await store.sessions.byId(session.sessionId)).revokedReason === 'refresh_reuse',
    'no reason recorded');

  const profile = await store.profiles.upsert(acct.accountId,
    { roamingSettings: { sens: 2.5 }, settingsVersion: 3 });
  check('a profile round-trips', profile.roamingSettings.sens === 2.5 && profile.settingsVersion === 3,
    JSON.stringify(profile));

  const consentId = ulid();
  await store.preAuthConsent.put({
    clientSessionId: consentId, telemetryPersonal: false,
    policyVersion: 1, decidedAt: iso(), expiresAt: iso(30 * 86400e3),
  });
  const consent = await store.preAuthConsent.get(consentId);
  // Recorded 'no' and undecided are different states, and the row exists to keep them apart.
  check('signed-out consent records a decision distinct from undecided',
    consent.telemetryPersonal === false && consent.migratedAt === null,
    JSON.stringify(consent));
  await store.preAuthConsent.markMigrated(consentId, iso());
  check('migrating the receipt is recorded',
    (await store.preAuthConsent.get(consentId)).migratedAt !== null, 'migratedAt is still null');

  const flagKey = `test.${ulid().slice(-6).toLowerCase()}`;
  await store.flags.set(flagKey, { enabled: true, isKillSwitch: true, updatedBy: 'storetest' });
  const flag = await store.flags.get(flagKey);
  check('a flag round-trips', flag.enabled === true && flag.isKillSwitch === true,
    JSON.stringify(flag));
  await store.flags.set(flagKey, { enabled: false });
  const flag2 = await store.flags.get(flagKey);
  check('a partial flag update leaves the other fields alone',
    flag2.enabled === false && flag2.isKillSwitch === true && flag2.updatedBy === 'storetest',
    JSON.stringify(flag2));
}

/** Resolve, or report the hang. A deadlocked call otherwise looks like a test suite that stopped. */
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not settle in ${ms}ms`)), ms); }),
  ]);
}

/** A minimal §4.2 TerminalResult for two accounts, with everything both tables require. */
function newResult(matchId, players, overrides = {}) {
  return {
    matchId,
    status: 'completed',
    mode: 'bomb',
    mapId: 'the-square',
    mapVersion: '1.0.0',
    region: 'yyz',
    rulesetVersion: 'bomb-1.0.0',
    statDefinitionVersion: '1.0.0',
    serverBuild: 'storetest',
    terminationReason: 'completed',
    outcomeReason: 'elimination',
    invalidationReason: null,
    winnerTeam: 'alpha',
    rulesSnapshot: { roundsToWin: 7, maxRounds: 12 },
    teamScores: { alpha: 7, bravo: 5 },
    rounds: [{ index: 0, winner: 'alpha', reason: 'elimination' }],
    // `roster` is a §4.2 required key and this fixture never had one, which is how a result
    // missing required fields looked like a valid one to every check in this file.
    roster: players.map((p) => ({ accountId: p.accountId, team: p.team, joinedAt: p.joinedAt, leftAt: p.leftAt })),
    evidenceRef: `ev_${matchId}`,
    startedAt: iso(-600e3),
    endedAt: iso(),
    players,
    ...overrides,
  };
}

/**
 * The allocation-time row: match-result.md §4 assigns `matchId` at ALLOCATION, so this is what
 * exists for the whole life of the match before any result is submitted.
 */
function newAllocation(matchId, players, overrides = {}) {
  return {
    matchId,
    status: 'allocated',
    mode: 'bomb',
    mapId: 'the-square',
    mapVersion: '1.0.0',
    region: 'yyz',
    rulesetVersion: 'bomb-1.0.0',
    statDefinitionVersion: '1.0.0',
    serverBuild: 'storetest',
    rulesSnapshot: { roundsToWin: 7, maxRounds: 12 },
    startedAt: null,
    endedAt: null,
    players,
    ...overrides,
  };
}

function newPlayer(accountId, team, overrides = {}) {
  return {
    accountId, team, displayName: `p_${accountId.slice(-4)}`,
    kills: 10, deaths: 4, assists: 2, suicides: 0, teamKills: 0,
    headshots: 3, shotsFired: 90, shotsHit: 30, damageDealt: 1400,
    plants: 1, defuses: 0, roundsPlayed: 12, timePlayedSec: 600, score: 1200,
    disconnected: false, abandoned: false,
    joinedAt: iso(-600e3), leftAt: null,
    weapons: { ar_default: { shots: 90, hits: 30, kills: 8, headshots: 3 } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------
// 7. store.matches — the surface three routed endpoints already call
// ---------------------------------------------------------------------------------------
async function testMatches(store, tag) {
  console.log(`\n[${tag}] matches`);

  check('the adapter exposes store.matches', !!store.matches
    && typeof store.matches.record === 'function'
    && typeof store.matches.listForAccount === 'function',
    'profile/stats.js calls matches.record and matches.listForAccount; without them every '
    + 'result submission and every history request is a 500');

  const a = newAccount();
  const b = newAccount();
  const outsider = newAccount();
  for (const acct of [a, b, outsider]) await store.accounts.create(acct);

  const base = ulid();
  const ids = [1, 2, 3].map((i) => `${base}-${i}`);       // ordered by construction
  for (const [i, matchId] of ids.entries()) {
    await store.matches.record(newResult(matchId, [
      newPlayer(a.accountId, 'alpha', { kills: 10 + i }),
      newPlayer(b.accountId, 'bravo', { kills: 1 }),
    ]));
  }

  const first = await store.matches.listForAccount(a.accountId, { limit: 2 });
  check('history is newest first',
    first.items.length === 2 && first.items[0].matchId === ids[2] && first.items[1].matchId === ids[1],
    first.items.map((m) => m.matchId).join(', '));
  check('a full page hands back a cursor', first.nextCursor === ids[1], `cursor=${first.nextCursor}`);

  const second = await store.matches.listForAccount(a.accountId, { limit: 2, cursor: first.nextCursor });
  check('the cursor continues where the page ended, without repeating',
    second.items.length === 1 && second.items[0].matchId === ids[0],
    second.items.map((m) => m.matchId).join(', '));
  // A cursor on the last page sends recomputeCareer round the loop forever.
  check('the last page has no cursor', second.nextCursor === null, `cursor=${second.nextCursor}`);

  const item = first.items[0];
  check('a history item carries the §4.3 fields the history endpoint reads',
    item.status === 'completed' && item.mode === 'bomb' && item.mapId === 'the-square'
      && item.mapVersion === '1.0.0' && item.winnerTeam === 'alpha'
      && item.teamScores.alpha === 7 && item.endedAt !== null
      && item.statDefinitionVersion === '1.0.0',
    JSON.stringify(item).slice(0, 300));
  check('a history item carries the participant the career recompute reads',
    item.participant?.team === 'alpha' && item.participant.stats.kills === 12
      && item.participant.stats.weapons.ar_default.kills === 8,
    JSON.stringify(item.participant).slice(0, 300));

  // CONTROL: the rows are per account. If listForAccount ignored its argument, the outsider
  // would see all three matches and every assertion above would still pass.
  const none = await store.matches.listForAccount(outsider.accountId, { limit: 10 });
  check('control: an account that played nothing has no history',
    none.items.length === 0 && none.nextCursor === null, `${none.items.length} items`);
  const opponent = await store.matches.listForAccount(b.accountId, { limit: 10 });
  check('control: the opponent sees the same matches from their own side',
    opponent.items.length === 3 && opponent.items[0].participant.team === 'bravo',
    JSON.stringify(opponent.items[0]?.participant?.team));

  // §4: written once, immutable thereafter. §5.5: a second, different truth is a bug or an attack.
  await throwsCode('re-recording a match is refused', 'CONFLICT',
    () => store.matches.record(newResult(ids[0], [newPlayer(a.accountId, 'alpha')])));

  // §4.3 pending: an allocated match is history too, and its outcome fields are null.
  const pendingId = `${base}-0`;
  await store.matches.record(newResult(pendingId, [newPlayer(a.accountId, 'alpha')], {
    status: 'pending', winnerTeam: null, endedAt: null, outcomeReason: null, terminationReason: null,
  }));
  const withPending = await store.matches.listForAccount(a.accountId, { limit: 10 });
  const pendingItem = withPending.items.find((m) => m.matchId === pendingId);
  check('a non-terminal match reads back as pending (§4.3)',
    pendingItem?.status === 'pending' && pendingItem.winnerTeam === null,
    JSON.stringify(pendingItem?.status));

  await throwsCode('a result with no region is refused', 'VALIDATION_FAILED',
    () => store.matches.record({ ...newResult(ulid(), []), region: undefined }));
  await throwsCode('a result with an unknown winner team is refused', 'VALIDATION_FAILED',
    () => store.matches.record(newResult(ulid(), [], { winnerTeam: 'charlie' })));
  await throwsCode('a participant that is not an account is refused', 'NOT_FOUND',
    () => store.matches.record(newResult(ulid(), [newPlayer(ulid(), 'alpha')])));

  // The match row and its participants land together or not at all: a match row with no
  // participants is a match nobody played, and the §6 recompute reads a hole where a career was.
  const atomicId = ulid();
  await store.matches.record(newResult(atomicId, [
    newPlayer(a.accountId, 'alpha'), newPlayer(ulid(), 'bravo'),
  ])).catch(() => {});
  const after = await store.matches.listForAccount(a.accountId, { limit: 50 });
  check('a result whose participant fails leaves no match row behind',
    !after.items.some((m) => m.matchId === atomicId),
    'the match row committed without its participants');

  await testMatchLifecycle(store, a, b);
  await testMatchResultValidation(store, a);
  await testMatchPagination(store, a);
}

// ---------------------------------------------------------------------------------------
// 7a. The match LIFECYCLE: allocate → in-progress → terminal, exactly once.
//
// match-result.md §4 assigns `matchId` at allocation, so by the time a result arrives the row
// already exists. `record` treated any existing row as CONFLICT, which made the documented
// lifecycle — allocate, play, finalise — the one path it refused: no allocated match could ever
// record a result. Every check below has its control, because "the write was refused" passes
// just as happily on a method that refuses everything.
// ---------------------------------------------------------------------------------------
async function testMatchLifecycle(store, a, b) {
  console.log('\n[lifecycle] allocated → in-progress → terminal');

  const id = ulid();
  const roster = [newPlayer(a.accountId, 'alpha', { kills: 0, deaths: 0, score: 0 })];

  await expectOk('a match row is created at allocation, before any result exists',
    () => store.matches.record(newAllocation(id, roster)));
  const allocated = await store.matches.byId(id);
  check('the allocated row reads back as allocated with no outcome',
    allocated?.status === 'allocated' && allocated.winnerTeam === null
      && allocated.outcomeReason === null && allocated.endedAt === null,
    JSON.stringify(allocated && { s: allocated.status, w: allocated.winnerTeam, e: allocated.endedAt }));
  check('an allocated match has no result_applied_at yet (db-schema.md §4)',
    allocated?.resultAppliedAt === null, JSON.stringify(allocated?.resultAppliedAt));

  await expectOk('the match starts: allocated → in-progress',
    () => store.matches.record(newAllocation(id, roster, { status: 'in-progress', startedAt: iso(-300e3) })));

  // THE FIX: the finalise that used to be impossible.
  await expectOk('the match finalises: in-progress → completed',
    () => store.matches.record(newResult(id, [newPlayer(a.accountId, 'alpha', { kills: 21 })])));
  const finalised = await store.matches.byId(id);
  check('the finalised row carries the terminal result, not the allocation',
    finalised?.status === 'completed' && finalised.winnerTeam === 'alpha'
      && finalised.outcomeReason === 'elimination' && finalised.endedAt !== null,
    JSON.stringify(finalised && { s: finalised.status, w: finalised.winnerTeam }));
  check('the participant row was updated in place, not duplicated',
    finalised?.participants?.length === 1 && finalised.participants[0].stats.kills === 21,
    JSON.stringify(finalised?.participants?.map((p) => p.stats.kills)));
  check('the allocation timestamp survives the finalise',
    finalised?.allocatedAt === allocated?.allocatedAt,
    `${allocated?.allocatedAt} vs ${finalised?.allocatedAt}`);

  // CONTROL: exactly once. §5.5 — a second, different truth for a finalised match is a bug or
  // an attack, and it stays CONFLICT even though the allocated → terminal edge now exists.
  await throwsCode('a second terminal write for the same match is CONFLICT', 'CONFLICT',
    () => store.matches.record(newResult(id, [newPlayer(a.accountId, 'alpha', { kills: 99 })])));
  await throwsCode('a finalised match cannot be re-invalidated by re-recording', 'CONFLICT',
    () => store.matches.record(newResult(id, [newPlayer(a.accountId, 'alpha')], {
      status: 'invalidated', terminationReason: 'invalidated', outcomeReason: 'no-contest',
      winnerTeam: null, invalidationReason: 'cheat-detected',
    })));
  const stillFinal = await store.matches.byId(id);
  check('control: the refused writes did not move the row',
    stillFinal?.status === 'completed' && stillFinal.participants[0].stats.kills === 21,
    JSON.stringify({ s: stillFinal?.status, k: stillFinal?.participants?.[0]?.stats?.kills }));

  // CONTROL: a terminal match cannot go BACKWARDS either, or a live match could be resurrected
  // over a recorded result.
  await throwsCode('completed → in-progress is refused', 'CONFLICT',
    () => store.matches.record(newAllocation(id, roster, { status: 'in-progress' })));
  // CONTROL: allocating an id that already exists is CONFLICT — the row is not up for grabs.
  await throwsCode('re-allocating an existing match id is refused', 'CONFLICT',
    () => store.matches.record(newAllocation(id, roster)));

  // --- result_applied_at ---------------------------------------------------------------
  // db-schema.md §4 declares the column; nothing wrote it, so "ended and queued" and "ended and
  // applied" were the same row and §4.2/§5 could not tell them apart.
  check('the finalised row still has no result_applied_at until a career application says so',
    finalised?.resultAppliedAt === null, JSON.stringify(finalised?.resultAppliedAt));
  const stamp = iso();
  await expectOk('markResultApplied stamps the column',
    () => store.matches.markResultApplied(id, stamp));
  const applied = await store.matches.byId(id);
  check('result_applied_at is persisted on the match row',
    applied?.resultAppliedAt === stamp, JSON.stringify(applied?.resultAppliedAt));

  // CONTROLS for the stamp: it cannot be applied twice, cannot be applied to a match that never
  // finalised, and cannot be applied to a match that does not exist.
  await throwsCode('applying a result twice is refused', 'CONFLICT',
    () => store.matches.markResultApplied(id, iso()));
  const liveId = ulid();
  await store.matches.record(newAllocation(liveId, [newPlayer(b.accountId, 'bravo')]));
  await throwsCode('a non-terminal match cannot have a result applied', 'CONFLICT',
    () => store.matches.markResultApplied(liveId, iso()));
  await throwsCode('applying a result to a match that does not exist is NOT_FOUND', 'NOT_FOUND',
    () => store.matches.markResultApplied(ulid(), iso()));
  const untouched = await store.matches.byId(liveId);
  check('control: the refused stamps left result_applied_at alone',
    untouched?.resultAppliedAt === null && (await store.matches.byId(id)).resultAppliedAt === stamp,
    JSON.stringify({ live: untouched?.resultAppliedAt }));

  // §4.2's pending variant: an ended-but-unfinalised match keeps its endedAt while still
  // reading as pending, which is the "ended, result queued" case the projection has to render.
  const queuedId = ulid();
  await store.matches.record(newAllocation(queuedId, [newPlayer(b.accountId, 'bravo')], {
    status: 'in-progress', startedAt: iso(-300e3), endedAt: iso(-1e3),
  }));
  const queued = await store.matches.byId(queuedId);
  check('an ended, unfinalised match keeps its endedAt and stays non-terminal',
    queued?.status === 'in-progress' && queued.endedAt !== null,
    JSON.stringify({ s: queued?.status, e: queued?.endedAt }));

  check('byId returns null for a match that never existed',
    (await store.matches.byId(ulid())) === null, 'byId invented a match');
}

// ---------------------------------------------------------------------------------------
// 7b. §4.2 required fields. A result missing one is unstorable, not a variant: the row it makes
// cannot be rendered by the detail endpoint and cannot be interpreted by the career recompute.
// ---------------------------------------------------------------------------------------
async function testMatchResultValidation(store, a) {
  console.log('\n[matches] §4.2 required fields and status invariants');

  const complete = () => newResult(ulid(), [newPlayer(a.accountId, 'alpha')]);

  // CONTROL FIRST: the complete result goes through, so every refusal below is about the field
  // that was removed and not about a method that has stopped accepting results.
  await expectOk('control: a complete §4.2 TerminalResult is accepted', () => store.matches.record(complete()));

  const requiredFields = [
    'rulesetVersion', 'statDefinitionVersion', 'serverBuild', 'mapVersion',
    'startedAt', 'endedAt', 'terminationReason', 'outcomeReason', 'evidenceRef',
    'rulesSnapshot', 'teamScores', 'rounds', 'roster', 'players',
    'winnerTeam', 'invalidationReason',
  ];
  for (const field of requiredFields) {
    const result = complete();
    delete result[field];
    // eslint-disable-next-line no-loop-func
    await throwsCode(`a result with no ${field} is refused`, 'VALIDATION_FAILED',
      () => store.matches.record(result));
    let named = false;
    try { await store.matches.record(result); } catch (err) {
      named = (err?.details?.fields || []).some((f) => f.key === field);
    }
    check(`the refusal names ${field}`, named, 'the error did not say which field was missing');
  }

  // The §4.0 matrix, through the store rather than through the career path — the two used to
  // hold two copies of it, and only the career one was ever checked here.
  const bad = [
    ['a completed match with no winner', { winnerTeam: null }],
    ['a completed match ended by forfeit', { outcomeReason: 'forfeit' }],
    ['a completed match carrying an invalidation reason', { invalidationReason: 'cheat-detected' }],
    ['a terminationReason that disagrees with the status', { terminationReason: 'aborted' }],
    ['an aborted match recorded as a draw', {
      status: 'aborted', terminationReason: 'aborted', outcomeReason: 'forfeit', winnerTeam: 'draw' }],
    ['a no-contest abort carrying a winner', {
      status: 'aborted', terminationReason: 'aborted', outcomeReason: 'no-contest', winnerTeam: 'alpha' }],
    ['an invalidated match with no invalidation reason', {
      status: 'invalidated', terminationReason: 'invalidated', outcomeReason: 'no-contest',
      winnerTeam: null, invalidationReason: null }],
    ['an invalidated match carrying a winner', {
      status: 'invalidated', terminationReason: 'invalidated', outcomeReason: 'no-contest',
      winnerTeam: 'alpha', invalidationReason: 'admin-review' }],
    ['a mode outside the closed enum', { mode: 'ffa' }],
  ];
  for (const [name, over] of bad) {
    await throwsCode(`${name} is refused`, 'VALIDATION_FAILED',
      () => store.matches.record(newResult(ulid(), [newPlayer(a.accountId, 'alpha')], over)));
  }

  // CONTROLS: every legal row of the matrix is still accepted.
  await expectOk('control: an aborted forfeit WITH a winner is accepted (§4.2)',
    () => store.matches.record(newResult(ulid(), [newPlayer(a.accountId, 'alpha')], {
      status: 'aborted', terminationReason: 'aborted', outcomeReason: 'forfeit', winnerTeam: 'bravo' })));
  await expectOk('control: an aborted no-contest with no winner is accepted',
    () => store.matches.record(newResult(ulid(), [newPlayer(a.accountId, 'alpha')], {
      status: 'aborted', terminationReason: 'aborted', outcomeReason: 'no-contest', winnerTeam: null })));
  await expectOk('control: an invalidated match with a reason from the enum is accepted',
    () => store.matches.record(newResult(ulid(), [newPlayer(a.accountId, 'alpha')], {
      status: 'invalidated', terminationReason: 'invalidated', outcomeReason: 'no-contest',
      winnerTeam: null, invalidationReason: 'cheat-detected' })));
  await expectOk('control: a 6-6 draw is accepted',
    () => store.matches.record(newResult(ulid(), [newPlayer(a.accountId, 'alpha')], {
      outcomeReason: 'timer', winnerTeam: 'draw' })));

  // A non-terminal row is held to the ALLOCATION shape, not the terminal one: it has no outcome
  // yet, and a row carrying one would contradict the status beside it.
  await throwsCode('an allocated match carrying a winner is refused', 'VALIDATION_FAILED',
    () => store.matches.record(newAllocation(ulid(), [newPlayer(a.accountId, 'alpha')], { winnerTeam: 'alpha' })));
  await throwsCode('an allocated match carrying an outcome reason is refused', 'VALIDATION_FAILED',
    () => store.matches.record(newAllocation(ulid(), [newPlayer(a.accountId, 'alpha')], { outcomeReason: 'timer' })));
  await expectOk('control: the same allocation without an outcome is accepted',
    () => store.matches.record(newAllocation(ulid(), [newPlayer(a.accountId, 'alpha')])));
}

// ---------------------------------------------------------------------------------------
// 7c. http-api.md §10 pagination: validated, never clamped. `limit=0` silently becoming 25 and
// a malformed cursor silently becoming "from the top" return a plausible page for a request
// that was wrong, which is how a paging bug ships.
// ---------------------------------------------------------------------------------------
async function testMatchPagination(store, a) {
  console.log('\n[matches] §10 pagination is validated, not clamped');

  for (const limit of [0, -1, 101, 2.5, '25', Number.NaN, Number.POSITIVE_INFINITY]) {
    // String(), not JSON.stringify(): NaN and Infinity both serialise to `null` and the two
    // checks would then share one name, which is how a duplicated case hides behind its twin.
    await throwsCode(`limit ${typeof limit === 'string' ? `"${limit}"` : String(limit)} is refused`, 'VALIDATION_FAILED',
      () => store.matches.listForAccount(a.accountId, { limit }));
  }
  for (const cursor of ['', '   ', 'not a cursor', { toString: () => '01J' }, 12, ['01J']]) {
    await throwsCode(`cursor ${JSON.stringify(cursor)} is refused`, 'VALIDATION_FAILED',
      () => store.matches.listForAccount(a.accountId, { cursor }));
  }

  // CONTROLS: the boundaries and the absent case all work, so the refusals above are about the
  // arguments and not about a method that has stopped listing.
  for (const limit of [1, 25, 100]) {
    await expectOk(`control: limit ${limit} is accepted`,
      () => store.matches.listForAccount(a.accountId, { limit }));
  }
  await expectOk('control: no page argument at all uses the §10 default',
    () => store.matches.listForAccount(a.accountId));
  await expectOk('control: an explicit null cursor is the first page',
    () => store.matches.listForAccount(a.accountId, { limit: 5, cursor: null }));
  const first = await store.matches.listForAccount(a.accountId, { limit: 1 });
  check('control: the default page is the documented 25',
    (await store.matches.listForAccount(a.accountId)).items.length <= 25);
  if (first.nextCursor) {
    await expectOk('control: the cursor a page hands back is itself accepted',
      () => store.matches.listForAccount(a.accountId, { limit: 1, cursor: first.nextCursor }));
  }
}

// ---------------------------------------------------------------------------------------
// 8. Conformance: the rules both adapters must answer identically.
// ---------------------------------------------------------------------------------------
async function testConformance(store, tag) {
  console.log(`\n[${tag}] conformance`);

  const acct = newAccount();
  await store.accounts.create(acct);

  // --- unknown-column rejection must not walk the prototype chain -----------------------
  // `k in columns` accepted every Object.prototype member as a legal column name.
  for (const evil of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    await throwsCode(`accounts rejects the inherited key ${evil}`, 'VALIDATION_FAILED',
      () => store.accounts.update(acct.accountId, { [evil]: 'owned' }));
    await throwsCode(`profiles rejects the inherited key ${evil}`, 'VALIDATION_FAILED',
      () => store.profiles.upsert(acct.accountId, { [evil]: 'owned' }));
  }
  await throwsCode('feature_flags rejects the inherited key __proto__', 'VALIDATION_FAILED',
    () => store.flags.set(`test.${ulid().slice(-6).toLowerCase()}`, JSON.parse('{"__proto__": {"x": 1}}')));
  // CONTROL: a real column on each of the three still works, so the four refusals above are
  // about the key and not about the method refusing everything.
  const statusPatched = await store.accounts.update(acct.accountId, { status: 'restricted' });
  check('control: a real account column is still accepted', statusPatched.status === 'restricted',
    JSON.stringify(statusPatched.status));

  // --- nested tx must not deadlock ------------------------------------------------------
  // A nested tx used to queue behind a lock its own caller held: it never ran, the outer call
  // never returned, and close() waited on the queue forever.
  const nested = newAccount();
  const nestedOut = await withTimeout(store.tx(async (tx) => {
    await store.accounts.create(nested, tx);
    return store.tx(async (inner) => (await store.accounts.byId(nested.accountId, inner)) !== null);
  }), 4000, 'a nested store.tx').catch((err) => err);
  check('a nested tx runs instead of deadlocking', nestedOut === true,
    nestedOut instanceof Error ? nestedOut.message : `returned ${nestedOut}`);
  check('control: the nested tx committed through the outer one',
    (await store.accounts.byId(nested.accountId)) !== null, 'the outer commit lost the write');

  // The same hang by the other route: a write inside tx() that forgets the handle.
  const ambient = newAccount();
  await withTimeout(store.tx(async () => { await store.accounts.create(ambient); }),
    4000, 'an unenrolled write inside tx').catch((err) => bad('an unenrolled write inside tx does not hang', err.message));
  check('a write inside tx() without the handle joins that transaction',
    (await store.accounts.byId(ambient.accountId)) !== null, 'the write vanished');
  const ambientRolled = newAccount();
  await store.tx(async () => {
    await store.accounts.create(ambientRolled);
    throw new Error('storetest: roll back the ambient write');
  }).catch(() => {});
  check('control: an unenrolled write inside tx rolls back with it',
    (await store.accounts.byId(ambientRolled.accountId)) === null,
    'it committed outside the transaction it was written inside');

  // --- the tx handle must not be the state ---------------------------------------------
  let escaped = null;
  await store.tx(async (tx) => { escaped = tx; });
  check('the tx handle exposes no state and no client',
    escaped.state === undefined && escaped.client === undefined
      && Object.keys(escaped).length === 0,
    `handle own keys: ${Object.keys(escaped).join(', ')}`);
  // CONTROL: the handle is genuinely a working handle, so "it exposes nothing" is not because
  // the store hands back an inert object.
  let live = null;
  await store.tx(async (tx) => { live = (await store.accounts.byId(acct.accountId, tx)) !== null; });
  check('control: a handle still works for a real call', live === true, 'the handle read nothing');

  // Forging through the handle is what the property allowed: tx.state.audit.delete(id).
  const auditRow = await store.audit.insert({
    actorKind: 'system', actorId: 'storetest', action: 'conformance.probe',
    subjectKind: 'account', subjectId: acct.accountId, reasonCode: 'TEST',
  });
  let forged = false;
  try {
    await store.tx(async (tx) => {
      for (const s of Object.getOwnPropertySymbols(tx)) {
        const v = tx[s];
        if (v && typeof v.audit?.delete === 'function') { v.audit.delete(auditRow.auditId); forged = true; }
      }
      for (const k of Object.keys(tx)) {
        const v = tx[k];
        if (v && typeof v.audit?.delete === 'function') { v.audit.delete(auditRow.auditId); forged = true; }
      }
    });
  } catch { /* a frozen handle may refuse outright, which is also a pass */ }
  check('no audit row is reachable through a tx handle', !forged
    && (await store.audit.list({ subjectId: acct.accountId })).some((r) => r.auditId === auditRow.auditId),
    'an audit row was deleted through the transaction handle');

  // --- an unstorable value must not brick the store ------------------------------------
  const familyId = ulid();
  const session = await store.sessions.create({
    sessionId: ulid(), accountId: acct.accountId, refreshFamilyId: familyId, ipClass: 'ca-on',
  });
  await throwsCode('a revoke reason that cannot be stored is refused', 'VALIDATION_FAILED',
    () => store.sessions.revoke(session.sessionId, Symbol('why')));
  await throwsCode('an audit summary that cannot be stored is refused', 'VALIDATION_FAILED',
    () => store.audit.insert({
      actorKind: 'system', action: 'conformance.probe', subjectKind: 'account',
      subjectId: acct.accountId, reasonCode: 'TEST', afterSummary: { fn: () => 1 },
    }));
  // CONTROL, and the whole point: every later write used to fail forever after one of those.
  const afterBad = newAccount();
  await expectOk('the store still writes after rejecting an unstorable value',
    () => store.accounts.create(afterBad));
  await expectOk('control: a normal revoke still works afterwards',
    () => store.sessions.revoke(session.sessionId, 'conformance'));
  check('the revoke that was refused left no trace',
    (await store.sessions.byId(session.sessionId)).revokedReason === 'conformance',
    'the rejected reason was stored anyway');

  // --- one behaviour per method, both adapters ------------------------------------------
  await throwsCode('revoking a session that does not exist is NOT_FOUND', 'NOT_FOUND',
    () => store.sessions.revoke(ulid(), 'conformance'));

  const patched = await store.accounts.update(acct.accountId,
    { status: 'active', updatedAt: '1999-01-01T00:00:00.000Z' });
  check('a patch cannot set updatedAt on accounts',
    patched.updatedAt !== '1999-01-01T00:00:00.000Z', `updatedAt=${patched.updatedAt}`);
  await throwsCode('a patch cannot set updatedAt on profiles', 'VALIDATION_FAILED',
    () => store.profiles.upsert(acct.accountId, { updatedAt: '1999-01-01T00:00:00.000Z' }));

  await store.profiles.upsert(acct.accountId, { roamingSettings: { sens: 2.5 }, settingsVersion: 4 });
  const untouched = await store.profiles.upsert(acct.accountId, { settingsVersion: 5 });
  check('control: a key absent from the patch leaves its column alone',
    untouched.roamingSettings?.sens === 2.5 && untouched.settingsVersion === 5,
    JSON.stringify(untouched));
  const cleared = await store.profiles.upsert(acct.accountId, { roamingSettings: null });
  check('a null in the patch clears the column',
    cleared.roamingSettings === null && cleared.settingsVersion === 5,
    JSON.stringify(cleared));

  // legacy_import: profile/migration.js writes it. Memory used to reject it as an unknown
  // column and Postgres discarded it silently, so the import re-ran on every request.
  const record = {
    source: 'localStorage:overstrike.progress.v1', verified: false,
    importedAt: iso(), data: { schema: 1, xp: 4200, lifetime: { kills: 9 }, weapons: {}, challenges: [] },
  };
  const imported = await store.profiles.upsert(acct.accountId, { legacyImport: record });
  check('legacyImport round-trips through the profile',
    imported.legacyImport?.data?.xp === 4200 && imported.legacyImport.verified === false,
    JSON.stringify(imported.legacyImport));
  check('control: reading the profile back still has it',
    (await store.profiles.byAccountId(acct.accountId)).legacyImport?.data?.lifetime?.kills === 9,
    'the import did not survive the round trip');
  await throwsCode('control: a profile column that does not exist is still refused', 'VALIDATION_FAILED',
    () => store.profiles.upsert(acct.accountId, { legacyimport: record }));

  // A new consent decision resets the migration receipt.
  const consentId = ulid();
  const consentRow = {
    clientSessionId: consentId, telemetryPersonal: false,
    policyVersion: 1, decidedAt: iso(), expiresAt: iso(30 * 86400e3),
  };
  await store.preAuthConsent.put(consentRow);
  await store.preAuthConsent.markMigrated(consentId, iso());
  check('control: markMigrated sets the receipt',
    (await store.preAuthConsent.get(consentId)).migratedAt !== null, 'migratedAt is still null');
  await store.preAuthConsent.put({ ...consentRow, telemetryPersonal: true, decidedAt: iso() });
  const redecided = await store.preAuthConsent.get(consentId);
  check('a new consent decision resets migratedAt',
    redecided.migratedAt === null && redecided.telemetryPersonal === true,
    JSON.stringify(redecided));

  // --- counter deltas are bounded -------------------------------------------------------
  await throwsCode('an absurd negative stat delta is refused', 'VALIDATION_FAILED',
    () => store.stats.applyDelta(acct.accountId, 'tdm', 'v1', { kills: -1_000_000 }));
  await throwsCode('an absurd positive stat delta is refused', 'VALIDATION_FAILED',
    () => store.stats.applyDelta(acct.accountId, 'tdm', 'v1', { damageDealt: 1e12 }));
  await throwsCode('a fractional stat delta is refused', 'VALIDATION_FAILED',
    () => store.stats.applyDelta(acct.accountId, 'tdm', 'v1', { kills: 1.5 }));
  await throwsCode('an absurd weapon delta is refused', 'VALIDATION_FAILED',
    () => store.weaponStats.applyDelta(acct.accountId, 'tdm', 'ar_default', 'v1', { shots: -5_000_000 }));
  // CONTROL: a plausible match, and the negative delta that reverses an invalidated one, are
  // both still accepted — a bound that rejects everything would pass all four checks above.
  const plausible = await store.stats.applyDelta(acct.accountId, 'tdm', 'v1',
    { kills: 30, deaths: 25, damageDealt: 4200, matches: 1, timePlayedSec: 1800 });
  check('control: a plausible match delta is accepted', plausible.kills === 30, JSON.stringify(plausible));
  const reversed = await store.stats.applyDelta(acct.accountId, 'tdm', 'v1',
    { kills: -30, deaths: -25, damageDealt: -4200, matches: -1, timePlayedSec: -1800 });
  check('control: the reversing negative delta is accepted',
    reversed.kills === 0 && reversed.matches === 0, JSON.stringify(reversed));
  check('the refused deltas changed nothing', reversed.damageDealt === 0,
    `damageDealt=${reversed.damageDealt}`);
}

async function runSuite(store, tag) {
  await testRollback(store, tag);
  await testOutboxAtomicity(store, tag);
  await testAuditAppendOnly(store, tag);
  await testIdempotency(store, tag);
  await testConfusables(store, tag);
  await testStats(store, tag);
  await testInterface(store, tag);
  await testMatches(store, tag);
  await testConformance(store, tag);
}

// ---------------------------------------------------------------------------------------

console.log('=========== STORE — memory ===========');
const mem = createMemoryStore({ storage: 'memory' }, {});
await runSuite(mem, 'memory');

// The memory adapter also has to reject what Postgres would reject, or every test in the
// platform is written against a schema the real database does not have.
console.log('\n[memory] schema fidelity');
await throwsCode('an unknown account column is refused', 'VALIDATION_FAILED',
  () => mem.accounts.create({ ...newAccount(), nickname: 'nope' }));
// There is deliberately no birthdate column (db-schema.md §2): the eligibility preflight
// evaluates a date of birth and discards it. Storing one would be the defect.
await throwsCode('a birthdate cannot be stored on an account', 'VALIDATION_FAILED',
  () => mem.accounts.create({ ...newAccount(), birthdate: '1990-01-01' }));
await throwsCode('an account without a folded name is refused', 'VALIDATION_FAILED',
  () => mem.accounts.create({ accountId: ulid(), displayName: 'Nameless' }));
await mem.close();

// ---------------------------------------------------------------------------------------
// The migration runner's refusals. These need no database: the rules are decided by comparing
// the files on disk to the recorded history, and that comparison is where they must hold.
// ---------------------------------------------------------------------------------------
console.log('\n=========== MIGRATIONS ===========');
{
  const files = await loadMigrations();
  check('migrations load in numeric order',
    files.length > 0 && files.every((f, i) => i === 0 || files[i - 1].version < f.version),
    files.map((f) => f.filename).join(', '));
  check('control: an empty database has every migration pending',
    planMigrations(files, []).length === files.length, 'the plan is not the full set');

  const asApplied = (fs) => fs.map((f) => ({ version: f.version, name: f.name, checksum: f.checksum }));
  check('a fully applied history has nothing pending',
    planMigrations(files, asApplied(files)).length === 0, 'it wants to reapply something');

  const throwsWith = (name, pattern, fn) => {
    try {
      fn();
      bad(name, 'the plan was accepted');
    } catch (err) {
      check(name, pattern.test(err.message), err.message);
    }
  };

  // An edited migration means the schema a fresh apply produces and the schema production got
  // are different, and nothing else in the system will tell you which one is running.
  const tampered = asApplied(files);
  tampered[0].checksum = 'deadbeef';
  throwsWith('an edited migration is refused', /checksum mismatch/, () => planMigrations(files, tampered));

  // Out of order: two branches each adding the next number merge into a schema whose shape
  // depends on which deployed first.
  const skipped = asApplied(files).filter((a) => a.version !== files[0].version);
  throwsWith('an out-of-order migration is refused', /older than applied migration/,
    () => planMigrations(files, skipped));

  throwsWith('a database ahead of the checkout is refused', /which this checkout does not/,
    () => planMigrations(files, [...asApplied(files), { version: 9999, name: 'future', checksum: 'x' }]));
}

// ---------------------------------------------------------------------------------------
// The Postgres adapter's statement building, proved without a database.
//
// A fake pool records the SQL instead of running it, so the injection below is checked on
// every run rather than only on the machines that have a database. That matters: the bug was
// reachable from any endpoint that forwards a JSON body into a patch.
// ---------------------------------------------------------------------------------------
console.log('\n=========== POSTGRES — statement building ===========');
{
  const spyPool = () => {
    const queries = [];
    const client = {
      queries,
      async query(sql, params) {
        queries.push({ sql, params });
        return { rows: [{ account_id: 'VIC2', status: 'active' }], rowCount: 1 };
      },
      release() {},
      on() {},
      async connect() { return client; },
      async end() {},
    };
    return client;
  };

  const pool = spyPool();
  const pgStore = await createPostgresStore(
    { databaseUrl: 'postgres://storetest/fake' },
    { pool, pg: { Pool: function FakePool() { throw new Error('storetest: the fake pool was bypassed'); } } });

  // The proof case, verbatim: the KEY is the payload. `toSnake` lower-cases capitals and
  // leaves quotes and commas alone, so pasting it into `set ${col} = $1` executed all of it.
  const injection = "status = 'banned', roles = '{admin}', password_hash = 'x', display_name";
  await throwsCode('an account patch KEY cannot carry SQL', 'VALIDATION_FAILED',
    () => pgStore.accounts.update('VIC2', { [injection]: 'OWNED' }));
  check('no statement containing the injected clauses was issued',
    !pool.queries.some((q) => /banned|\{admin\}/.test(q.sql)),
    pool.queries.map((q) => q.sql).join(' | '));

  await throwsCode('an insert KEY cannot carry SQL either', 'VALIDATION_FAILED',
    () => pgStore.audit.insert({
      actorKind: 'system', action: 'probe', subjectKind: 'account', subjectId: 'VIC2',
      reasonCode: 'TEST', ["reason_code = 'CLEAN', actor_id"]: 'OWNED',
    }));
  await throwsCode('an inherited key is not a column of any table', 'VALIDATION_FAILED',
    () => pgStore.accounts.update('VIC2', { constructor: 'OWNED' }));

  // CONTROL: a legitimate patch still builds a parameterised statement. Without this, an
  // adapter that refused every update would pass all three refusals above.
  pool.queries.length = 0;
  await pgStore.accounts.update('VIC2', { status: 'banned', displayName: 'Legit' });
  const [issued] = pool.queries;
  check('control: a real patch becomes a parameterised UPDATE',
    /^update accounts set status = \$1, display_name = \$2 where account_id = \$3/.test(issued.sql)
      && issued.params[0] === 'banned' && issued.params[2] === 'VIC2',
    issued.sql);

  // The relay's claim must still take the row lock when it is inside a transaction — that is
  // what the reentrancy rework touched, and losing it means N workers publish the same event N
  // times (event-envelope.md §4).
  pool.queries.length = 0;
  await pgStore.tx((tx) => pgStore.outbox.claimUnpublished(10, tx));
  check('claimUnpublished still locks inside a transaction',
    pool.queries.some((q) => /for update skip locked/.test(q.sql)),
    pool.queries.map((q) => q.sql).join(' | '));
  pool.queries.length = 0;
  await pgStore.outbox.claimUnpublished(10);
  check('control: outside a transaction it does not',
    !pool.queries.some((q) => /for update skip locked/.test(q.sql)),
    pool.queries.map((q) => q.sql).join(' | '));

  // Reentrancy: a nested tx must not take a second connection and must not issue a second
  // BEGIN — two connections cannot be one transaction, and they can deadlock on each other.
  pool.queries.length = 0;
  await withTimeout(pgStore.tx(async () => {
    await pgStore.tx(async (inner) => pgStore.accounts.byId('VIC2', inner));
  }), 4000, 'a nested postgres tx').catch((err) => bad('a nested postgres tx does not hang', err.message));
  check('a nested postgres tx issues one begin and one commit',
    pool.queries.filter((q) => q.sql === 'begin').length === 1
      && pool.queries.filter((q) => q.sql === 'commit').length === 1,
    pool.queries.map((q) => q.sql).join(' | '));

  await pgStore.close();
}

// ---------------------------------------------------------------------------------------
// Migration content that a database-less run can still hold to account.
// ---------------------------------------------------------------------------------------
console.log('\n=========== MIGRATIONS — content ===========');
{
  const read = (f) => readFile(join(MIGRATIONS_DIR, f), 'utf8');
  const files = (await loadMigrations()).map((f) => f.filename);

  // 0007's grant block was gated on `if exists (... 'overstrike_app')` and that role exists
  // nowhere, so the whole block was a no-op: the connecting role kept UPDATE, DELETE and
  // TRUNCATE, and an owner can `alter table audit_log disable trigger all` and then delete.
  const roleFile = files.find((f) => /audit_append_only_role/.test(f));
  check('a migration exists that creates the audit role', !!roleFile,
    'audit_log is append-only only by convention while the app role does not exist');
  const roleSql = roleFile ? await read(roleFile) : '';
  check('it creates overstrike_app rather than skipping when absent',
    /create role overstrike_app/i.test(roleSql), 'the role is still only checked for');
  check('it revokes the mutating privileges from PUBLIC as well as the role',
    /revoke all on audit_log from public/i.test(roleSql), 'a PUBLIC grant would survive');
  check('it fails loudly if the role still holds UPDATE or DELETE afterwards',
    /raise exception/i.test(roleSql) && /has_table_privilege/i.test(roleSql),
    'the migration asserts nothing, so it can silently do nothing again');
  check('it states that DATABASE_URL must be a non-owner role',
    /NOT the owner/i.test(roleSql), 'the deployment requirement is not written down anywhere');
  // CONTROL: the grep is capable of failing. 0007 is the file that did NOT do this.
  const old = await read('0007_audit_append_only.sql');
  check('control: the superseded 0007 does not create the role',
    !/create role overstrike_app/i.test(old),
    '0007 already created it, so the checks above prove nothing');

  // The relay polls `where published_at is null and dead_lettered_at is null order by
  // occurred_at, event_id limit N`. An index on (published_at) where published_at is null
  // carries no ordering and excludes no dead letters: EXPLAIN shows a top-N heapsort over
  // every unpublished row, on every poll.
  const idxFile = files.find((f) => /outbox_relay_index/.test(f));
  check('a migration exists that indexes the relay query', !!idxFile, 'the poll still heapsorts');
  const idxSql = idxFile ? await read(idxFile) : '';
  check('the new index is on the ORDER BY key under the full predicate',
    /\(occurred_at, event_id\)/.test(idxSql)
      && /where published_at is null and dead_lettered_at is null/.test(idxSql),
    idxSql);
  check('the index that cannot serve the query is dropped',
    /drop index if exists events_outbox_unpublished_idx/.test(idxSql),
    'both indexes remain, and every outbox write pays for the dead one');

  const legacyFile = files.find((f) => /legacy_import/.test(f));
  check('a migration adds profiles.legacy_import', !!legacyFile,
    'profile/migration.js writes a column that does not exist');
  check('it is jsonb', /legacy_import jsonb/.test(legacyFile ? await read(legacyFile) : ''), '');
}

// ---------------------------------------------------------------------------------------
// The migration runner refuses what its own doc used to invite.
// ---------------------------------------------------------------------------------------
console.log('\n=========== MIGRATIONS — runner arguments ===========');
{
  // A Pool runs each statement on whichever connection is free, so pg_advisory_lock would be
  // taken on one session and unlocked on another, and begin/commit would land on different
  // connections than the DDL between them. Invisible on a one-connection pool; catastrophic
  // on a real one.
  const fakePool = {
    totalCount: 3, idleCount: 3, waitingCount: 0,
    async query() { return { rows: [] }; },
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; },
  };
  let refused = null;
  try {
    await runMigrations({ client: fakePool });
    bad('a Pool is refused as a migration client', 'it was accepted');
  } catch (err) {
    refused = err.message;
    check('a Pool is refused as a migration client', /Pool was passed/.test(err.message), err.message);
  }
  check('the refusal says what to pass instead', /pool\.connect\(\)/.test(refused ?? ''), refused ?? '');

  // CONTROL: a dedicated connection is accepted — the check is about the pool, not about
  // refusing every client. This one answers enough to complete a run with nothing pending.
  // It reports every migration as already applied, so the run has nothing to execute and the
  // assertion is about the argument check rather than about fake DDL.
  const files = await loadMigrations();
  const fakeClient = {
    async query(sql) {
      if (/from schema_migrations/i.test(sql)) {
        return { rows: files.map((f) => ({ version: f.version, name: f.name, checksum: f.checksum, applied_at: null, duration_ms: 0 })) };
      }
      return { rows: [{}] };
    },
  };
  await expectOk('control: a dedicated client is accepted',
    () => runMigrations({ client: fakeClient }));

  check('runMigrations has a named entry point for a deploy step',
    typeof (await import('../src/core/migrate.js')).migrateCli === 'function',
    'nothing exports a callable migration entry point');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log('\n=========== STORE — postgres ===========');
  console.log('  skip DATABASE_URL is not set; the Postgres adapter was not exercised');
} else {
  console.log('\n=========== STORE — postgres ===========');
  let pgStore = null;
  try {
    const migrated = await runMigrations({ databaseUrl });
    console.log(`  ok   migrations applied (${migrated.applied.length} new, ${migrated.alreadyApplied} existing)`);
    // Running twice must be a no-op. A runner that reapplies is a runner that will one day
    // reapply a destructive migration.
    const again = await runMigrations({ databaseUrl });
    check('re-running migrations applies nothing', again.applied.length === 0,
      `it applied ${again.applied.join(', ')}`);

    pgStore = await createPostgresStore({ databaseUrl }, {});
    await runSuite(pgStore, 'postgres');

    // Database-level append-only, which is the control that matters: the interface having no
    // update() is only a convention until the table refuses one.
    console.log('\n[postgres] audit_log at the database level');
    const pg = (await import('pg')).default;
    const raw = new pg.Client({ connectionString: databaseUrl });
    await raw.connect();
    try {
      const probe = ulid();
      await raw.query(
        `insert into audit_log (audit_id, actor_kind, action, subject_kind, subject_id, reason_code)
         values ($1, 'system', 'storetest.probe', 'account', $2, 'TEST')`, [probe, probe]);
      check('control: a direct INSERT into audit_log succeeds',
        (await raw.query('select 1 from audit_log where audit_id = $1', [probe])).rowCount === 1,
        'the probe row was not inserted, so the refusals below prove nothing');
      for (const [name, sql] of [
        ['UPDATE', 'update audit_log set reason_code = $2 where audit_id = $1'],
        ['DELETE', 'delete from audit_log where audit_id = $1'],
      ]) {
        try {
          await raw.query(sql, name === 'UPDATE' ? [probe, 'TAMPERED'] : [probe]);
          bad(`a direct ${name} on audit_log is refused`, 'it succeeded');
        } catch (err) {
          check(`a direct ${name} on audit_log is refused`, /append-only/.test(err.message), err.message);
        }
      }

      // The trigger is bypassable by the table owner (`alter table … disable trigger all`), so
      // the grant is the control that actually holds. 0007's grant block was a no-op because
      // the role it named did not exist.
      const { rows: roleRows } = await raw.query(
        "select 1 from pg_roles where rolname = 'overstrike_app'");
      check('the application role exists after migrating', roleRows.length === 1,
        'overstrike_app is still absent, so the grant block is still a no-op');
      const { rows: [priv] } = await raw.query(
        `select has_table_privilege('overstrike_app', 'audit_log', 'INSERT') as ins,
                has_table_privilege('overstrike_app', 'audit_log', 'SELECT') as sel,
                has_table_privilege('overstrike_app', 'audit_log', 'UPDATE') as upd,
                has_table_privilege('overstrike_app', 'audit_log', 'DELETE') as del,
                has_table_privilege('overstrike_app', 'audit_log', 'TRUNCATE') as trunc`);
      check('the application role cannot UPDATE, DELETE or TRUNCATE audit_log',
        priv.upd === false && priv.del === false && priv.trunc === false,
        JSON.stringify(priv));
      // CONTROL: it holds the privileges it is supposed to. A role with nothing at all would
      // satisfy the assertion above and break the application.
      check('control: the application role can still INSERT and SELECT',
        priv.ins === true && priv.sel === true, JSON.stringify(priv));

      const { rows: idx } = await raw.query(
        "select indexname, indexdef from pg_indexes where tablename = 'events_outbox'");
      const relay = idx.find((r) => r.indexname === 'events_outbox_relay_idx');
      check('the relay index exists', !!relay, idx.map((r) => r.indexname).join(', '));
      check('the relay index orders by occurred_at, event_id under the full predicate',
        /occurred_at, event_id/.test(relay?.indexdef ?? '')
          && /published_at IS NULL.*and.*dead_lettered_at IS NULL/is.test(relay?.indexdef ?? ''),
        relay?.indexdef ?? '');
      check('control: the index that could not serve the query is gone',
        !idx.some((r) => r.indexname === 'events_outbox_unpublished_idx'),
        'both indexes are present; every outbox write pays for the dead one');

      // Printed, not asserted: on a nearly empty table the planner correctly prefers a seq
      // scan whatever indexes exist, so an assertion here would fail for the right reason and
      // teach the next reader to delete it. The index definition above is the checkable claim.
      const { rows: plan } = await raw.query(
        `explain select * from events_outbox
           where published_at is null and dead_lettered_at is null
           order by occurred_at, event_id limit 100`);
      console.log(`  note relay poll plan: ${plan.map((r) => r['QUERY PLAN']).join(' / ')}`);

      // --- the §4.0 matrix at the DATABASE level (migration 0012) ----------------------
      // The adapters validate it too, but application validation only protects rows the
      // application writes. A backfill, an admin console or a second service writes rows it
      // never sees, so the table has to refuse them itself.
      console.log('\n[postgres] the §4.0 outcome matrix is enforced by the table');
      const matchRow = (over) => {
        const cols = {
          match_id: ulid(), region: 'yyz', map_id: 'the-square', mode: 'bomb',
          rules_snapshot: '{}', status: 'completed', termination_reason: 'completed',
          outcome_reason: 'timer', winner_team: 'alpha', invalidation_reason: null,
          ended_at: new Date().toISOString(), result_applied_at: null, ...over,
        };
        const keys = Object.keys(cols);
        return raw.query(
          `insert into matches (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`,
          keys.map((k) => cols[k]));
      };
      const refusedByTable = async (name, over) => {
        try {
          await matchRow(over);
          bad(name, 'the table accepted a row the §4.0 matrix forbids');
        } catch (err) {
          // 23514 is check_violation. Any other code means the row was refused for an unrelated
          // reason and the constraint is still unproven.
          if (err.code === '23514') ok(name);
          else bad(name, `expected 23514 check_violation, got ${err.code}: ${err.message}`);
        }
      };

      // CONTROL FIRST: a row that satisfies the matrix inserts, so every refusal below is about
      // the column that was changed and not about a table that refuses everything.
      await expectOk('control: a matrix-satisfying row inserts directly', () => matchRow({}));
      await refusedByTable('the table refuses a completed match with no winner', { winner_team: null });
      await refusedByTable('the table refuses a completed match ended by forfeit', { outcome_reason: 'forfeit' });
      await refusedByTable('the table refuses a completed match with an invalidation reason',
        { invalidation_reason: 'cheat-detected' });
      await refusedByTable('the table refuses a termination_reason that disagrees with status',
        { termination_reason: 'aborted' });
      await refusedByTable('the table refuses an aborted draw',
        { status: 'aborted', termination_reason: 'aborted', outcome_reason: 'forfeit', winner_team: 'draw' });
      await refusedByTable('the table refuses a no-contest abort with a winner',
        { status: 'aborted', termination_reason: 'aborted', outcome_reason: 'no-contest', winner_team: 'alpha' });
      await refusedByTable('the table refuses an invalidated match with no reason',
        { status: 'invalidated', termination_reason: 'invalidated', outcome_reason: 'no-contest',
          winner_team: null, invalidation_reason: null });
      await refusedByTable('the table refuses a terminal row with no ended_at', { ended_at: null });
      await refusedByTable('the table refuses an allocated row carrying an outcome',
        { status: 'allocated', termination_reason: null, outcome_reason: 'timer',
          winner_team: null, ended_at: null });
      await refusedByTable('the table refuses result_applied_at on a match that never finalised',
        { status: 'in-progress', termination_reason: null, outcome_reason: null, winner_team: null,
          ended_at: null, result_applied_at: new Date().toISOString() });
      // CONTROLS: the other legal rows of the matrix still insert.
      await expectOk('control: an aborted forfeit with a winner inserts', () => matchRow({
        status: 'aborted', termination_reason: 'aborted', outcome_reason: 'forfeit', winner_team: 'bravo' }));
      await expectOk('control: an invalidated match with a reason inserts', () => matchRow({
        status: 'invalidated', termination_reason: 'invalidated', outcome_reason: 'no-contest',
        winner_team: null, invalidation_reason: 'server-fault' }));
      await expectOk('control: an allocated row with no outcome inserts', () => matchRow({
        status: 'allocated', termination_reason: null, outcome_reason: null, winner_team: null,
        ended_at: null }));
    } finally {
      await raw.end();
    }
  } catch (err) {
    bad('postgres suite', err.stack ?? err.message);
  } finally {
    if (pgStore) await pgStore.close();
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nstore runs clean');
process.exit(failures ? 1 : 0);
