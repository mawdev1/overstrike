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
import { createPostgresStore, TABLE_COLUMNS } from '../src/core/store/postgres.js';
import {
  loadMigrations, planMigrations, runMigrations, MIGRATIONS_DIR,
} from '../src/core/migrate.js';
import { ulid } from '../src/core/ids.js';
import {
  INITIAL_SETTINGS_VERSION, createStore,
  assertStorable, toStoredMatchStatus, STORED_MATCH_STATUSES,
  matchOutcomeProblems, terminalResultProblems, nestedResultProblems, submittableResultProblems,
} from '../src/core/store.js';

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
 * Assert that a SPECIFIC problem is reported — the path and the rule, never `length > 0`.
 *
 * `problems.length > 0` is satisfied by whichever single check happens to fire first, so one
 * surviving guard makes every other guard in the same function untestable: delete any of the
 * other twenty and the assertion still passes. Naming the path and the rule is what makes the
 * check able to notice the guard it is about going away.
 */
/** errors.md §3 says `{path, rule}`; the older callers read `{key, reason}`. Both are emitted. */
const reports = (problems, path, rule) =>
  problems.some((p) => (p.path ?? p.key) === path && (p.rule ?? p.reason) === rule);

function problemAt(name, problems, path, rule) {
  check(name, reports(problems, path, rule),
    `no {path: ${path}, rule: ${rule}} in ${JSON.stringify(problems)}`);
}

/** The other half: this path/rule must NOT be reported. */
function noProblemAt(name, problems, path, rule) {
  check(name, !reports(problems, path, rule),
    `{path: ${path}, rule: ${rule}} was reported: ${JSON.stringify(problems)}`);
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
  const byCorrelation = await store.outbox.list({ correlationId: event.correlationId });
  const absentCorrelation = await store.outbox.list({ correlationId: ulid() });
  check('incident lookup reads only events with the exact correlation id',
    byCorrelation.length === 1 && byCorrelation[0].eventId === event.eventId
      && absentCorrelation.length === 0,
    JSON.stringify({ found: byCorrelation.map((row) => row.eventId), absent: absentCorrelation.length }));

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
  const exactCorrelation = row.correlationId;

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
  check('incident lookup reads only audit rows with the exact correlation id',
    (await store.audit.list({ correlationId: exactCorrelation })).some((item) => item.auditId === row.auditId)
      && (await store.audit.list({ correlationId: ulid() })).length === 0);

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
  // §3a.3: "deleted on migration at signup, or on expiry". Deleted, not stamped — the stamp
  // reads as absent and retains as present, which is the whole distinction that matters for a
  // consent record.
  check('migration deletes the row', (await store.preAuthConsent.deleteFor(consentId)) === true,
    'deleteFor reported no row');
  check('and it is gone, not hidden', (await store.preAuthConsent.get(consentId)) === null,
    'the row survived deleteFor');
  check('deleting again reports there was nothing to delete',
    (await store.preAuthConsent.deleteFor(consentId)) === false, 'deleteFor claimed a second row');

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

  // The lobby's boot-time orphan sweep asks one question of this table: "is any non-terminal
  // match still holding this server?" — so the lifecycle below also proves the answer flips
  // from row to null exactly when the match goes terminal. serverId is a real FK.
  const lifecycleServerId = `storetest-lifecycle-${ulid()}`;
  await store.matchServers.register({ serverId: lifecycleServerId, region: 'yyz',
    address: `wss://${lifecycleServerId}.example.invalid`, capacity: 12, inUse: 0,
    status: 'healthy', build: '1.0.0', lastHeartbeatAt: iso(-3_600_000) });

  await expectOk('a match row is created at allocation, before any result exists',
    () => store.matches.record(newAllocation(id, roster, { serverId: lifecycleServerId })));
  check('an allocated match answers activeForServer — the sweep must not release its seat',
    (await store.matches.activeForServer(lifecycleServerId))?.matchId === id);
  check('control: a server nothing allocated has no active match',
    await store.matches.activeForServer(`storetest-nothing-${ulid()}`) === null);
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
  check('a terminal match no longer answers activeForServer — its seat is provably orphanable',
    await store.matches.activeForServer(lifecycleServerId) === null,
    'the boot sweep would keep a finished match’s reservation forever');

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
// 8a. profiles.upsertIfVersion — the CAS itself, on BOTH adapters.
//
// This method's entire value is what it REFUSES, so an adapter that quietly succeeds has no
// visible symptom at all until two devices rebind a key and one rebind is gone. That makes it
// exactly the kind of rule store.js's preamble rule 5 is about, and it belonged in the
// conformance block from the start: it was tested nowhere, on either adapter — `grep -rn
// upsertIfVersion platform/test` returned nothing — and the Postgres adapter was wrong.
//
// It is called here directly, not through the settings service. The service does its own
// read-then-write version check first, so a service-level test passes with the adapter CAS
// deleted outright; only the adapter method can prove the adapter method.
// ---------------------------------------------------------------------------------------
async function testProfileCas(store) {
  // --- absence is the initial version, and nothing else ---------------------------------
  //
  // An account with no profile row reads as version 1 (profile/settings.js `read`), so a CAS
  // holding version 1 legitimately CREATES the row and a CAS holding any other version is a
  // caller who believes in a row that does not exist. Postgres put the version comparison in
  // the `on conflict do update ... where`, which gates only the UPDATE branch: the plain
  // INSERT path ignored expectedVersion entirely and manufactured a row at version 1 for a
  // caller who had asked for 42.
  const virgin = newAccount();
  await store.accounts.create(virgin);
  const ghost = await store.profiles.upsertIfVersion(virgin.accountId, 42,
    { roamingSettings: { fov: 120 }, settingsVersion: 43 });
  check('a CAS against a version no row has is refused, not inserted',
    ghost === null, `it returned ${JSON.stringify(ghost)}`);
  check('and the refused CAS left the account with no profile row at all',
    (await store.profiles.byAccountId(virgin.accountId)) === null,
    'a profile row exists for an account that never had one');

  // CONTROL: the first-ever settings write, which is every account's normal path.
  const born = await store.profiles.upsertIfVersion(virgin.accountId, INITIAL_SETTINGS_VERSION,
    { roamingSettings: { fov: 100 }, settingsVersion: INITIAL_SETTINGS_VERSION + 1 });
  check('control: a CAS holding the initial version creates the row',
    born?.settingsVersion === 2 && born?.roamingSettings?.fov === 100, JSON.stringify(born));

  // --- once the row exists, only the current version may write --------------------------
  const stale = await store.profiles.upsertIfVersion(virgin.accountId, INITIAL_SETTINGS_VERSION,
    { roamingSettings: { fov: 70 }, settingsVersion: 2 });
  check('a CAS on a version that has moved is refused', stale === null, JSON.stringify(stale));
  check('and the refused CAS changed no column',
    (await store.profiles.byAccountId(virgin.accountId))?.roamingSettings?.fov === 100,
    'the stale write landed anyway');
  const current = await store.profiles.upsertIfVersion(virgin.accountId, 2,
    { roamingSettings: { fov: 95 }, settingsVersion: 3 });
  check('control: a CAS on the current version is accepted',
    current?.settingsVersion === 3 && current?.roamingSettings?.fov === 95, JSON.stringify(current));

  // --- eight concurrent writers, one winner ---------------------------------------------
  //
  // The claim the method exists to make, and the one a sequential test cannot make: delete the
  // comparison from either adapter and all eight of these succeed. Refusals are counted as
  // strict `=== null` and successes as a row carrying the version that was written, so an
  // adapter that threw eight times would fail this rather than pass it as "seven refused".
  const racer = newAccount();
  await store.accounts.create(racer);
  await store.profiles.upsert(racer.accountId, { roamingSettings: { fov: 0 }, settingsVersion: 7 });
  const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    store.profiles.upsertIfVersion(racer.accountId, 7,
      { roamingSettings: { fov: 100 + i }, settingsVersion: 8 })
      .then((row) => ({ row }), (err) => ({ err }))));
  const winners = outcomes.filter((o) => o.row !== undefined && o.row !== null);
  const refused = outcomes.filter((o) => o.row === null);
  const threw = outcomes.filter((o) => o.err !== undefined);
  check('exactly one of eight concurrent CAS writers on the same version wins',
    winners.length === 1 && refused.length === 7 && threw.length === 0,
    `won ${winners.length}, refused ${refused.length}, threw ${threw.length}`
      + (threw.length ? `: ${threw[0].err?.code ?? threw[0].err?.message}` : ''));
  const settled = await store.profiles.byAccountId(racer.accountId);
  check('the stored row is the winner\'s and the seven losers wrote nothing',
    settled?.settingsVersion === 8
      && settled?.roamingSettings?.fov === winners[0]?.row?.roamingSettings?.fov,
    `${JSON.stringify(settled)} vs winner ${JSON.stringify(winners[0]?.row)}`);
  check('control: exactly one version was consumed by the eight',
    settled?.settingsVersion === 8, `settingsVersion=${settled?.settingsVersion}`);

  // --- the refusals a CAS shares with an upsert -----------------------------------------
  //
  // These were where the two adapters disagreed for a second reason: Postgres validated the
  // patch and expectedVersion before touching storage, memory compared versions first and so
  // answered `null` — "your version moved" — to a caller whose real mistake was a typo'd
  // column or a string version. A CONFLICT the client retries forever is a worse answer than
  // the VALIDATION_FAILED it deserves.
  // String(), not JSON.stringify(): NaN and null both serialise to `null` and the two checks
  // would then share one name, which is how a duplicated case hides behind its twin.
  for (const bad of ['7', 7.5, null, undefined, Number.NaN, 8n]) {
    await throwsCode(
      `a CAS with expectedVersion ${typeof bad === 'string' ? `"${bad}"` : String(bad)} is refused`,
      'VALIDATION_FAILED',
      () => store.profiles.upsertIfVersion(racer.accountId, bad, { settingsVersion: 9 }));
  }
  await throwsCode('a CAS patch is held to the same columns as an upsert, even on a stale version',
    'VALIDATION_FAILED',
    () => store.profiles.upsertIfVersion(racer.accountId, 999, { legacyimport: {} }));
  await throwsCode('a CAS patch cannot set updatedAt either', 'VALIDATION_FAILED',
    () => store.profiles.upsertIfVersion(racer.accountId, 8, { updatedAt: '1999-01-01T00:00:00.000Z' }));
  await throwsCode('a CAS with a non-integer settingsVersion is refused', 'VALIDATION_FAILED',
    () => store.profiles.upsertIfVersion(racer.accountId, 8, { settingsVersion: '9' }));

  // An account that does not exist is NOT_FOUND, not a version conflict — on both paths,
  // because the insert path is the only one Postgres's foreign key ever sees.
  await throwsCode('a CAS for an account that does not exist is NOT_FOUND (initial version)',
    'NOT_FOUND', () => store.profiles.upsertIfVersion(ulid(), INITIAL_SETTINGS_VERSION,
      { settingsVersion: 2 }));
  await throwsCode('a CAS for an account that does not exist is NOT_FOUND (any other version)',
    'NOT_FOUND', () => store.profiles.upsertIfVersion(ulid(), 42, { settingsVersion: 43 }));

  // CONTROL: after all of those refusals the method still writes, so the block above is about
  // the arguments and not about a CAS that has stopped working.
  const afterRefusals = await store.profiles.upsertIfVersion(racer.accountId, 8,
    { roamingSettings: { fov: 111 }, settingsVersion: 9 });
  check('control: a valid CAS still succeeds after every refusal above',
    afterRefusals?.settingsVersion === 9 && afterRefusals?.roamingSettings?.fov === 111,
    JSON.stringify(afterRefusals));

  // --- a CAS enrols in the caller's transaction and rolls back with it -------------------
  // Rule 4 of the interface. A CAS that committed outside the transaction it was written
  // inside would consume a version the rolled-back request never spent.
  await store.tx(async (tx) => {
    const inTx = await store.profiles.upsertIfVersion(racer.accountId, 9,
      { roamingSettings: { fov: 5 }, settingsVersion: 10 }, tx);
    check('control: a CAS inside a transaction succeeds', inTx?.settingsVersion === 10,
      JSON.stringify(inTx));
    throw new Error('storetest: roll back the CAS');
  }).catch(() => {});
  const rolledBack = await store.profiles.byAccountId(racer.accountId);
  check('a rolled-back CAS consumed no version',
    rolledBack?.settingsVersion === 9 && rolledBack?.roamingSettings?.fov === 111,
    JSON.stringify(rolledBack));
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
  //
  // "There is no such row" is the single most divergence-prone answer in this interface, and
  // it is the class the pgtest header records as already having bitten: memory threw NOT_FOUND
  // where Postgres was silent. Exactly ONE method was pinned here — sessions.revoke — so the
  // other twenty answers agreed by luck and by nobody having changed them. The whole table is
  // asserted now, on both adapters, because a divergence in any row of it is a deployment bug
  // no memory-backed test can see.
  const gone = ulid();

  // The WRITES: a write to a row that is not there is NOT_FOUND, never a silent no-op. A
  // silent no-op is the one answer that lets a caller believe it changed something.
  for (const [name, call] of [
    ['sessions.revoke', () => store.sessions.revoke(gone, 'conformance')],
    ['sessions.touch', () => store.sessions.touch(gone, iso())],
    ['refreshTokens.markUsed', () => store.refreshTokens.markUsed(gone, iso())],
    ['outbox.recordFailure', () => store.outbox.recordFailure(gone, 'conformance')],
    ['outbox.deadLetter', () => store.outbox.deadLetter(gone, iso())],
    ['accounts.update', () => store.accounts.update(gone, { status: 'active' })],
    ['profiles.upsert', () => store.profiles.upsert(gone, { settingsVersion: 2 })],
    ['stats.applyDelta', () => store.stats.applyDelta(gone, 'tdm', 'v1', { kills: 1 })],
    ['weaponStats.applyDelta', () => store.weaponStats.applyDelta(gone, 'tdm', 'ar_default', 'v1', { shots: 1 })],
    ['matches.markResultApplied', () => store.matches.markResultApplied(gone, iso())],
  ]) {
    await throwsCode(`${name} on a row that does not exist is NOT_FOUND`, 'NOT_FOUND', call);
  }

  // The READS: null, and `=== null` rather than falsiness — `undefined` satisfies every falsy
  // check there is, and an adapter that returned it would pass a `!row` assertion while
  // breaking every `row === null` branch in the modules.
  for (const [name, call] of [
    ['accounts.byId', () => store.accounts.byId(gone)],
    ['accounts.byEmailHash', () => store.accounts.byEmailHash(`h_${gone}`)],
    ['accounts.byNameFolded', () => store.accounts.byNameFolded(`nobody_${gone.toLowerCase()}`)],
    ['sessions.byId', () => store.sessions.byId(gone)],
    ['refreshTokens.byId', () => store.refreshTokens.byId(gone)],
    ['profiles.byAccountId', () => store.profiles.byAccountId(gone)],
    ['stats.get', () => store.stats.get(gone, 'tdm', 'v1')],
    ['matches.byId', () => store.matches.byId(gone)],
    ['flags.get', () => store.flags.get('conformance.no.such.flag')],
    ['idempotency.get', () => store.idempotency.get(`no-${gone}`, gone)],
    ['preAuthConsent.get', () => store.preAuthConsent.get(gone)],
  ]) {
    const got = await call();
    check(`${name} answers null for a row that does not exist`, got === null,
      `it answered ${got === undefined ? 'undefined' : JSON.stringify(got)}`);
  }

  // The COUNTS and the LISTS: a number or an empty page, and no exception. These are the
  // methods whose caller is a loop or a sweep, and NOT_FOUND from any of them turns "nothing
  // matched" into an incident.
  const revokedNone = await store.sessions.revokeAllForAccount(gone, 'conformance', iso());
  check('revokeAllForAccount on an unknown account is 0, not NOT_FOUND', revokedNone === 0,
    `it returned ${JSON.stringify(revokedNone)}`);
  const familyNone = await store.sessions.revokeFamily(gone, 'conformance', iso());
  check('revokeFamily on an unknown family is 0, not NOT_FOUND', familyNone === 0,
    `it returned ${JSON.stringify(familyNone)}`);
  const deletedNone = await store.preAuthConsent.deleteFor(gone);
  check('deleteFor on a consent row that is not there is false, not NOT_FOUND',
    deletedNone === false, `it returned ${JSON.stringify(deletedNone)}`);
  // §4 of the outbox contract: the relay marks a batch, and an id already swept or never
  // written must not abort the batch around it.
  await expectOk('markPublished tolerates an event id that is not there',
    () => store.outbox.markPublished([gone], iso()));
  for (const [name, call] of [
    ['sessions.listForAccount', () => store.sessions.listForAccount(gone)],
    ['stats.listForAccount', () => store.stats.listForAccount(gone)],
    ['weaponStats.listForAccount', () => store.weaponStats.listForAccount(gone, 'tdm')],
    ['audit.list', () => store.audit.list({ subjectId: gone })],
  ]) {
    const rows = await call();
    check(`${name} answers an empty array for an account with nothing`,
      Array.isArray(rows) && rows.length === 0, `it answered ${JSON.stringify(rows)?.slice(0, 80)}`);
  }
  const emptyPage = await store.matches.listForAccount(gone, { limit: 5 });
  check('matches.listForAccount answers an empty page with a null cursor, not NOT_FOUND',
    Array.isArray(emptyPage?.items) && emptyPage.items.length === 0 && emptyPage.nextCursor === null,
    JSON.stringify(emptyPage));

  // CONTROLS for the whole table: the same reads and counts against rows that DO exist. An
  // adapter that answered null to everything, or 0 to everything, would satisfy every check
  // above; these are what make the twenty-odd "nothing there" answers mean anything.
  const liveSession = await store.sessions.create({
    sessionId: ulid(), accountId: acct.accountId, refreshFamilyId: ulid(), ipClass: 'ca-on',
  });
  check('control: byId finds a session that does exist',
    (await store.sessions.byId(liveSession.sessionId))?.sessionId === liveSession.sessionId,
    'the reader cannot see a row it just wrote');
  check('control: byId finds an account that does exist',
    (await store.accounts.byId(acct.accountId))?.accountId === acct.accountId,
    'the reader cannot see an account it just wrote');
  check('control: byEmailHash finds the account it was created with',
    (await store.accounts.byEmailHash(acct.emailHash))?.accountId === acct.accountId,
    'the folded/hashed lookups answer null for everything');
  check('control: listForAccount lists a session that does exist',
    (await store.sessions.listForAccount(acct.accountId)).length >= 1, 'the list is empty for a live account');
  const revokedSome = await store.sessions.revokeAllForAccount(acct.accountId, 'conformance', iso());
  check('control: revokeAllForAccount counts the sessions it revoked', revokedSome >= 1,
    `it returned ${revokedSome}, so the 0 above proves nothing`);

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

  await testProfileCas(store);

  // A new consent decision replaces the old one and is never stamped as already-migrated.
  const consentId = ulid();
  const consentRow = {
    clientSessionId: consentId, telemetryPersonal: false,
    policyVersion: 1, decidedAt: iso(), expiresAt: iso(30 * 86400e3),
  };
  await store.preAuthConsent.put(consentRow);
  check('control: the first decision is stored',
    (await store.preAuthConsent.get(consentId)).telemetryPersonal === false, 'first put did not land');
  await store.preAuthConsent.put({ ...consentRow, telemetryPersonal: true, decidedAt: iso() });
  const redecided = await store.preAuthConsent.get(consentId);
  check('a new consent decision replaces the old one with migratedAt null',
    redecided.migratedAt === null && redecided.telemetryPersonal === true,
    JSON.stringify(redecided));
  // §3a.3 migration is a DELETE on both adapters, and the row does not come back.
  check('deleteFor removes it', (await store.preAuthConsent.deleteFor(consentId)) === true,
    'deleteFor reported no row');
  check('control: and the row is gone', (await store.preAuthConsent.get(consentId)) === null,
    'the row survived deleteFor');

  // --- §8 idempotency retention ---------------------------------------------------------
  //
  // Every writer stamped `expiresAt` and nothing ever deleted on it. A retention window that
  // nothing enforces is a column, not a policy.
  const liveKey = `idem-live-${ulid()}`;
  const deadKey = `idem-dead-${ulid()}`;
  const foreverKey = `idem-forever-${ulid()}`;
  for (const [k, expiresAt] of [[liveKey, iso(86400e3)], [deadKey, iso(-60_000)], [foreverKey, null]]) {
    await store.idempotency.put({
      key: k, actorId: acct.accountId, requestHash: 'h', responseStatus: 200,
      responseBody: { k }, createdAt: iso(), expiresAt,
    });
  }
  const swept = await store.idempotency.sweepExpired(iso());
  check('the sweep deletes at least the one expired key', swept >= 1, `swept ${swept}`);
  check('an expired idempotency key is deleted',
    (await store.idempotency.get(deadKey, acct.accountId)) === null, 'the expired row survived');
  check('control: an unexpired key is untouched',
    (await store.idempotency.get(liveKey, acct.accountId))?.requestHash === 'h',
    'the sweep took a live row');
  // §8: "permanent for value-bearing operations". Null expiry is that class, and 0017 makes
  // the column nullable so it can be written at all.
  check('control: a null expiry is the permanent class and is never swept',
    (await store.idempotency.get(foreverKey, acct.accountId))?.expiresAt == null,
    'a permanent row was swept or could not be written');

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

// ---------------------------------------------------------------------------------------
// 9. The §4.1/§4.2 result shape, function by function.
//
// `core/store.js` decides these once for both adapters, and the endpoint that holds a match
// server to them (`profile/stats.js` `assertSubmittableResult`) calls straight through. Every
// check below therefore calls the exported rule itself and asserts the SPECIFIC problem — the
// path and the rule — because `problems.length > 0` is satisfied by whichever guard happens to
// fire first, which makes every other guard in the same function untestable.
//
// A mutation sweep put a number on that: 22 of the 31 guards that survived deletion in this
// file were `problems.push(...)` lines inside these functions, and the suite was green with
// each of them removed.
// ---------------------------------------------------------------------------------------

/** A §4.1 player row with every key the shape declares, all of them well-formed. */
function submissionPlayer(accountId, team, over = {}) {
  return {
    accountId,
    displayName: `p_${accountId.slice(-4)}`,
    team,
    role: team === 'alpha' ? 'attacker' : 'defender',
    kills: 10, deaths: 4, assists: 2, suicides: 0, teamKills: 0, headshots: 3,
    shotsFired: 90, shotsHit: 30, damageDealt: 1400,
    plants: 1, defuses: 0, roundsPlayed: 12, timePlayedSec: 600,
    score: 1200,
    disconnected: false, abandoned: false,
    joinedAt: iso(-600e3), leftAt: null,
    weapons: { ar_default: { shots: 90, hits: 30, kills: 8, headshots: 3 } },
    ...over,
  };
}

/**
 * A complete `ResultSubmission` (match-result.md §5.1): every required top-level field, the
 * §4.0 matrix satisfied, and every nested §4.1 shape well-formed.
 *
 * `newResult` above is deliberately NOT this: it satisfies the top-level §4.2 check the storage
 * door runs and nothing more, so it cannot serve as the control for the nested rules — a
 * fixture that already has problems makes "this input has a problem" meaningless.
 */
function newSubmission(alpha, bravo, over = {}) {
  return {
    matchId: ulid(),
    status: 'completed',
    mode: 'bomb',
    mapId: 'the-square', mapVersion: '1.0.0', region: 'yyz',
    rulesetVersion: 'bomb-1.0.0', statDefinitionVersion: '1.0.0', serverBuild: 'storetest',
    terminationReason: 'completed', outcomeReason: 'defuse',
    invalidationReason: null, winnerTeam: 'alpha',
    rulesSnapshot: {
      killLimit: null,
      roundsToWin: 7, maxRounds: 12, sideSwitchAfter: 6, roundLengthSec: 115,
      bombTimerSec: 40, defuseSec: 5, plantSec: 3, freezeSec: 10,
      overtime: false,
    },
    teamScores: { alpha: 7, bravo: 5 },
    rounds: [{
      index: 0, winner: 'alpha', reason: 'defuse',
      startedAt: iso(-600e3), endedAt: iso(-500e3),
      // bomb-rules 2.0.0 §13.7 / match-result §4.1: per-round home-site ownership.
      homeSites: { alpha: 'B', bravo: 'A' },
      plant: { accountId: bravo, site: 'A', at: iso(-550e3) },
      defuse: { accountId: alpha, at: iso(-520e3) },
    }],
    roster: [
      { accountId: alpha, team: 'alpha', joinedAt: iso(-600e3), leftAt: null },
      { accountId: bravo, team: 'bravo', joinedAt: iso(-600e3), leftAt: null },
    ],
    players: [submissionPlayer(alpha, 'alpha'), submissionPlayer(bravo, 'bravo')],
    evidenceRef: 'ev-1',
    startedAt: iso(-600e3), endedAt: iso(),
    ...over,
  };
}

async function testResultShapeRules() {
  console.log('\n=========== STORE — the §4.1/§4.2 result shape ===========');

  const A = ulid();
  const B = ulid();

  // CONTROL FIRST, and it is the control the whole section rests on: a complete submission has
  // NO problems at all. Without it every "this is reported" check below is satisfied by a
  // function that reports something about everything.
  const clean = submittableResultProblems(newSubmission(A, B));
  check('control: a complete §5.1 submission has no problems at all',
    clean.length === 0, JSON.stringify(clean));

  // --- the argument itself ---------------------------------------------------------------
  for (const [name, value] of [['null', null], ['a string', 'result'], ['an array', []]]) {
    problemAt(`terminalResultProblems reports ${name} as the wrong type`,
      terminalResultProblems(value), 'result', 'type');
    problemAt(`nestedResultProblems reports ${name} as the wrong type`,
      nestedResultProblems(value), 'result', 'type');
  }

  // --- players[] -------------------------------------------------------------------------
  const withPlayer = (over) => {
    const r = newSubmission(A, B);
    r.players[0] = submissionPlayer(A, 'alpha', over);
    return nestedResultProblems(r);
  };
  problemAt('a non-integer score is reported at players[0].score',
    withPlayer({ score: '1200' }), 'players[0].score', 'integer');
  // §2's penalties make a per-match score legitimately negative — it is the one number here
  // that is not a count, so the control has to prove the rule is `integer` and not `count`.
  noProblemAt('control: a negative score is legal and is not reported',
    withPlayer({ score: -50 }), 'players[0].score', 'integer');
  problemAt('a joinedAt that Date.parse cannot read is reported at players[0].joinedAt',
    withPlayer({ joinedAt: 'yesterday' }), 'players[0].joinedAt', 'timestamp');
  problemAt('an absent joinedAt is reported at players[0].joinedAt',
    withPlayer({ joinedAt: undefined }), 'players[0].joinedAt', 'timestamp');
  problemAt('a player that is not an object is reported at its own index',
    nestedResultProblems({ ...newSubmission(A, B), players: ['nope'] }), 'players[0]', 'type');
  // Absent is not null here either: a player row with no `leftAt` KEY is a producer that
  // forgot, and defaulting it to null records that they played to the end.
  const noLeftAt = newSubmission(A, B);
  delete noLeftAt.players[0].leftAt;
  problemAt('a player with no leftAt KEY is reported as required',
    nestedResultProblems(noLeftAt), 'players[0].leftAt', 'required');
  noProblemAt('control: an explicit null leftAt on a player is legal',
    withPlayer({ leftAt: null }), 'players[0].leftAt', 'required');
  problemAt('control: a leftAt that is present but unreadable is reported as a timestamp',
    withPlayer({ leftAt: 'when they left' }), 'players[0].leftAt', 'timestamp');

  // --- players[].weapons{} ---------------------------------------------------------------
  problemAt('a weapons map that is not an object is reported at players[0].weapons',
    withPlayer({ weapons: 'ar_default' }), 'players[0].weapons', 'type');
  // The weapon id becomes a storage key in `player_weapon_stats`, so it is constrained like one.
  problemAt('a weapon id with a space in it is reported as malformed',
    withPlayer({ weapons: { 'ar default': { shots: 1, hits: 1, kills: 0, headshots: 0 } } }),
    'players[0].weapons.ar default', 'malformed-weapon-id');
  problemAt('a weapon id carrying a quote is reported as malformed',
    withPlayer({ weapons: { "ar'; drop": { shots: 1, hits: 1, kills: 0, headshots: 0 } } }),
    "players[0].weapons.ar'; drop", 'malformed-weapon-id');
  noProblemAt('control: a dotted, dashed, colonned id is a legal weapon id',
    withPlayer({ weapons: { 'ar.vector-2:mk3': { shots: 1, hits: 1, kills: 0, headshots: 0 } } }),
    'players[0].weapons.ar.vector-2:mk3', 'malformed-weapon-id');

  // --- roster[] --------------------------------------------------------------------------
  const withRoster = (entry) => {
    const r = newSubmission(A, B);
    r.roster[0] = entry;
    return nestedResultProblems(r);
  };
  problemAt('a roster entry that is not an object is reported at its own index',
    withRoster('nope'), 'roster[0]', 'type');
  problemAt('a roster entry with no accountId is reported as required',
    withRoster({ team: 'alpha', joinedAt: iso(-600e3), leftAt: null }),
    'roster[0].accountId', 'required');
  problemAt('a roster accountId that is the empty string is reported as required',
    withRoster({ accountId: '', team: 'alpha', joinedAt: iso(-600e3), leftAt: null }),
    'roster[0].accountId', 'required');
  noProblemAt('control: a roster entry with a real accountId is not reported',
    withRoster({ accountId: A, team: 'alpha', joinedAt: iso(-600e3), leftAt: null }),
    'roster[0].accountId', 'required');
  problemAt('a roster joinedAt that is not a timestamp is reported',
    withRoster({ accountId: A, team: 'alpha', joinedAt: 0, leftAt: null }),
    'roster[0].joinedAt', 'timestamp');
  // Absent is not null: an omitted key is a producer that forgot, and defaulting it invents a
  // fact about when the player left.
  problemAt('a roster entry with no leftAt KEY is reported as required',
    withRoster({ accountId: A, team: 'alpha', joinedAt: iso(-600e3) }),
    'roster[0].leftAt', 'required');
  noProblemAt('control: an explicit null leftAt is legal',
    withRoster({ accountId: A, team: 'alpha', joinedAt: iso(-600e3), leftAt: null }),
    'roster[0].leftAt', 'required');

  // --- duplicate account ids -------------------------------------------------------------
  // (match_id, account_id) is the primary key of match_participants, so a duplicate is a
  // malformed result rather than a last-writer-wins merge.
  const dupPlayers = newSubmission(A, B);
  dupPlayers.players[1] = submissionPlayer(A, 'bravo');
  problemAt('the same account twice in players[] is reported as a duplicate',
    nestedResultProblems(dupPlayers), 'players[1].accountId', 'duplicate');
  const dupRoster = newSubmission(A, B);
  dupRoster.roster[1] = { accountId: A, team: 'bravo', joinedAt: iso(-600e3), leftAt: null };
  problemAt('the same account twice in roster[] is reported as a duplicate',
    nestedResultProblems(dupRoster), 'roster[1].accountId', 'duplicate');
  // …and the duplicate check must not fire on the ABSENCE of an id. Two players who both
  // forgot `accountId` are two `required` problems, not a duplicate: reporting them as one
  // account submitted twice sends the producer looking for a roster bug it does not have.
  const noIds = newSubmission(A, B);
  noIds.players = [submissionPlayer(A, 'alpha', { accountId: undefined }),
    submissionPlayer(B, 'bravo', { accountId: undefined })];
  const noIdProblems = nestedResultProblems(noIds);
  noProblemAt('two players with no accountId are not reported as duplicates of each other',
    noIdProblems, 'players[1].accountId', 'duplicate');
  problemAt('control: they are reported as missing an accountId',
    noIdProblems, 'players[1].accountId', 'required');

  // --- rounds[] --------------------------------------------------------------------------
  // `drop` REMOVES the key rather than setting it to undefined: `{...round, defuse: undefined}`
  // still has an own `defuse`, so `Object.hasOwn` is true and the "the producer forgot this
  // key entirely" case — which is the one the required-check exists for — is never reached.
  const withRound = (over, drop = []) => {
    const r = newSubmission(A, B);
    r.rounds[0] = { ...r.rounds[0], ...over };
    for (const k of drop) delete r.rounds[0][k];
    return nestedResultProblems(r);
  };
  problemAt('a round that is not an object is reported at its own index',
    nestedResultProblems({ ...newSubmission(A, B), rounds: ['nope'] }), 'rounds[0]', 'type');
  problemAt('a round winner outside the enum is reported',
    withRound({ winner: 'charlie' }), 'rounds[0].winner', 'enum');
  noProblemAt('control: a round won by bravo is legal',
    withRound({ winner: 'bravo' }), 'rounds[0].winner', 'enum');
  // bomb-rules 2.0.0 §13.5.3: a drawn round is a legal per-round outcome.
  noProblemAt('a DRAWN round (winner: draw) is legal under the 2.0.0 symmetric ruleset',
    withRound({ winner: 'draw', reason: 'timer' }), 'rounds[0].winner', 'enum');
  problemAt('a round homeSites outside the site enum is reported',
    withRound({ homeSites: { alpha: 'C', bravo: 'A' } }), 'rounds[0].homeSites.alpha', 'enum');
  problemAt('both teams claiming one home site is reported',
    withRound({ homeSites: { alpha: 'A', bravo: 'A' } }), 'rounds[0].homeSites', 'distinct');

  // --- rounds[].plant / .defuse: the objective ACTOR record ------------------------------
  problemAt('a round with no defuse KEY at all is reported as required',
    withRound({}, ['defuse']), 'rounds[0].defuse', 'required');
  problemAt('a round with no plant KEY at all is reported as required',
    withRound({}, ['plant']), 'rounds[0].plant', 'required');
  problemAt('a plant that is not an object is reported',
    withRound({ plant: 'site A' }), 'rounds[0].plant', 'type');
  problemAt('a plant with no planter is reported at plant.accountId',
    withRound({ plant: { site: 'A', at: iso(-550e3) } }), 'rounds[0].plant.accountId', 'required');
  problemAt('a plant with no readable instant is reported at plant.at',
    withRound({ plant: { accountId: B, site: 'A', at: 'during the round' } }),
    'rounds[0].plant.at', 'timestamp');
  problemAt('a plant at a site outside the enum is reported',
    withRound({ plant: { accountId: B, site: 'C', at: iso(-550e3) } }),
    'rounds[0].plant.site', 'enum');
  // An explicit null is the "nobody planted" record and must produce nothing at all — the
  // guard that says so is one line, and without this check deleting it is invisible.
  const noObjective = withRound({ plant: null, defuse: null });
  noProblemAt('an explicitly null plant is not reported as the wrong type',
    noObjective, 'rounds[0].plant', 'type');
  noProblemAt('an explicitly null defuse is not reported as the wrong type',
    noObjective, 'rounds[0].defuse', 'type');
  check('control: a round with no objective at all is otherwise clean',
    noObjective.length === 0, JSON.stringify(noObjective));

  // --- rulesSnapshot ---------------------------------------------------------------------
  const withRules = (over) => nestedResultProblems({
    ...newSubmission(A, B),
    rulesSnapshot: { ...newSubmission(A, B).rulesSnapshot, ...over },
  });
  problemAt('a non-boolean overtime is reported at rulesSnapshot.overtime',
    withRules({ overtime: 'yes' }), 'rulesSnapshot.overtime', 'boolean');
  noProblemAt('control: overtime true is accepted',
    withRules({ overtime: true }), 'rulesSnapshot.overtime', 'boolean');

  // --- the §4.0 matrix, per row -----------------------------------------------------------
  //
  // A forfeit or an abandon is an ABORTED match WITH a winner (§4.2, wire-protocol §8.9): the
  // player who quit still lost. `winnerTeam: null` there is the case that has to be reported
  // on its own, because the obvious probe — `winnerTeam: 'draw'` — is also caught by the
  // draw-implies-timer rule and so proves nothing about this one.
  for (const reason of ['forfeit', 'abandon']) {
    problemAt(`an aborted ${reason} with no winner is reported at winnerTeam`,
      matchOutcomeProblems({ status: 'aborted', outcomeReason: reason, winnerTeam: null }),
      'winnerTeam', 'enum');
    const legal = matchOutcomeProblems({
      status: 'aborted', terminationReason: 'aborted', outcomeReason: reason, winnerTeam: 'bravo',
      invalidationReason: null,
    });
    check(`control: an aborted ${reason} WITH a winner satisfies the matrix`,
      legal.length === 0, JSON.stringify(legal));
  }

  // --- stored match statuses --------------------------------------------------------------
  //
  // `pending` is a RESPONSE status that collapses to `allocated`; anything outside the stored
  // set is a caller inventing a lifecycle state, and letting it through writes a status the
  // table's check constraint does not have.
  check('control: pending is stored as allocated', toStoredMatchStatus('pending') === 'allocated',
    toStoredMatchStatus('pending'));
  for (const stored of STORED_MATCH_STATUSES) {
    check(`control: ${stored} is stored as itself`, toStoredMatchStatus(stored) === stored,
      toStoredMatchStatus(stored));
  }
  for (const junk of ['finished', 'PENDING', '', 'completed ', 'in_progress']) {
    let code = null;
    try { toStoredMatchStatus(junk); } catch (err) { code = err?.code; }
    check(`the status ${JSON.stringify(junk)} is refused`, code === 'VALIDATION_FAILED',
      `it answered ${code === null ? toStoredMatchStatus(junk) : code}`);
  }

  // --- assertStorable's fast path ---------------------------------------------------------
  //
  // MEASURED, not assumed: `structuredClone(null)` and `structuredClone(undefined)` both
  // succeed, so the early return in `assertStorable` is a shortcut and not a rule. Deleting it
  // is an EQUIVALENT MUTANT and no test can kill it — see the comment at store.js:144. What is
  // checkable is the contract the shortcut states: a null is storable and comes back as null.
  check('a null is storable and is handed straight back',
    assertStorable(null, 'probe') === null, 'assertStorable changed a null');
  check('an undefined is storable and is handed straight back',
    assertStorable(undefined, 'probe') === undefined, 'assertStorable changed an undefined');
  let symCode = null;
  try { assertStorable(Symbol('x'), 'probe'); } catch (err) { symCode = err?.code; }
  check('control: a Symbol is not storable', symCode === 'VALIDATION_FAILED', `got ${symCode}`);
}

// ---------------------------------------------------------------------------------------
// 10. The adapter registry. `createStore` is the only thing that may import an adapter, so it
// is the only place a config typo can silently become the wrong storage engine.
// ---------------------------------------------------------------------------------------
async function testAdapterRegistry() {
  console.log('\n=========== STORE — the adapter registry ===========');

  const memStore = await createStore({ storage: 'memory' }, {});
  check('createStore({storage: memory}) builds the memory adapter', memStore.kind === 'memory',
    `it built ${memStore.kind}`);
  await memStore.close();

  // No database: a pool that answers nothing is enough to prove which adapter was CHOSEN, which
  // is the only thing this function decides. `pg` is stubbed out so a missed `deps.pool` fails
  // loudly rather than dialling a real server.
  const pool = {
    async query() { return { rows: [], rowCount: 0 }; },
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; },
    on() {}, async end() {},
  };
  const pgChosen = await createStore(
    { storage: 'postgres', databaseUrl: 'postgres://storetest/registry' },
    { pool, pg: { Pool: function FakePool() { throw new Error('storetest: the fake pool was bypassed'); } } });
  check('createStore({storage: postgres}) builds the Postgres adapter', pgChosen.kind === 'postgres',
    `it built ${pgChosen.kind}`);
  await pgChosen.close();

  for (const storage of ['sqlite', 'Postgres', '', undefined]) {
    let message = null;
    try { await createStore({ storage }, {}); } catch (err) { message = err.message; }
    check(`storage=${JSON.stringify(storage)} is refused by name`,
      /unknown storage adapter/.test(message ?? ''), `it answered ${message}`);
  }

  // The Postgres adapter refuses to exist without a connection string rather than building a
  // pool that dials `localhost` — which is what an unset DATABASE_URL in production looks like.
  let noUrl = null;
  const savedUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await createStore({ storage: 'postgres' }, { pool });
  } catch (err) { noUrl = err.message; } finally {
    if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
  }
  check('the Postgres adapter refuses to build with no DATABASE_URL',
    /DATABASE_URL is required/.test(noUrl ?? ''), `it answered ${noUrl}`);
}

// ---------------------------------------------------------------------------------------
// 11. The memory adapter's own internals: timestamp normalisation and the closed-store gate.
// Neither is reachable through the shared conformance suite — the first because Postgres
// normalises in the driver, the second because closing the shared store would end the run.
// ---------------------------------------------------------------------------------------
async function testMemoryInternals() {
  console.log('\n[memory] timestamps cross the interface as ISO strings');

  const acct = newAccount();
  await mem.accounts.create(acct);
  const sessionId = ulid();
  await mem.sessions.create({ sessionId, accountId: acct.accountId, refreshFamilyId: ulid() });

  // `pg` accepts a Date and epoch ms; this adapter has to accept the same three shapes or code
  // written against one breaks against the other.
  const epochMs = Date.parse('2026-02-03T04:05:06.000Z');
  await mem.sessions.touch(sessionId, epochMs);
  check('epoch milliseconds are normalised to an ISO string',
    (await mem.sessions.byId(sessionId)).lastSeenAt === '2026-02-03T04:05:06.000Z',
    JSON.stringify((await mem.sessions.byId(sessionId)).lastSeenAt));
  await mem.sessions.touch(sessionId, new Date('2026-02-04T00:00:00.000Z'));
  check('a Date is normalised to an ISO string',
    (await mem.sessions.byId(sessionId)).lastSeenAt === '2026-02-04T00:00:00.000Z',
    JSON.stringify((await mem.sessions.byId(sessionId)).lastSeenAt));
  await mem.sessions.touch(sessionId, '2026-02-05T00:00:00.000Z');
  check('control: an ISO string is kept as it is',
    (await mem.sessions.byId(sessionId)).lastSeenAt === '2026-02-05T00:00:00.000Z',
    JSON.stringify((await mem.sessions.byId(sessionId)).lastSeenAt));
  await throwsCode('a timestamp that is none of the three shapes is refused', 'VALIDATION_FAILED',
    () => mem.sessions.touch(sessionId, { at: 'now' }));

  // The store's injected clock, in every shape it may hand back. `storeNowMs` is what every TTL
  // in this adapter compares against, so a clock shape it mishandles silently disables expiry.
  const at = Date.parse('2026-06-01T00:00:00.000Z');
  for (const [shape, now] of [
    ['a Date', () => new Date(at)],
    ['epoch ms', () => at],
    ['an ISO string', () => new Date(at).toISOString()],
  ]) {
    const clocked = createMemoryStore({ storage: 'memory' }, { now });
    const sid = ulid();
    await clocked.preAuthConsent.put({
      clientSessionId: sid, telemetryPersonal: true, policyVersion: 1,
      expiresAt: new Date(at - 1000).toISOString(),
    });
    check(`a decision already expired against ${shape} reads as absent`,
      (await clocked.preAuthConsent.get(sid)) === null, 'the expired decision was returned');
    const liveSid = ulid();
    await clocked.preAuthConsent.put({
      clientSessionId: liveSid, telemetryPersonal: true, policyVersion: 1,
      expiresAt: new Date(at + 86_400_000).toISOString(),
    });
    check(`control: an unexpired decision against ${shape} is returned`,
      (await clocked.preAuthConsent.get(liveSid))?.telemetryPersonal === true,
      'the live decision was swept too');
    await clocked.close();
  }

  // A handle from ANOTHER store instance carries the same module-level tag symbol but belongs
  // to a different state, so the tag alone is not identity.
  const peer = createMemoryStore({ storage: 'memory' }, {});
  let peerHandle = null;
  await peer.tx(async (t) => { peerHandle = t; });
  await throwsCode('a handle from another store instance is refused', 'INTERNAL_ERROR',
    () => mem.accounts.byId(acct.accountId, peerHandle));
  await peer.close();
}

/**
 * `close()` is a state, not a courtesy: a store that keeps answering after it is closed hands
 * back rows from a state nothing will ever publish again.
 */
async function testClosedStore() {
  console.log('\n[memory] a closed store answers SERVICE_UNAVAILABLE');
  const store = createMemoryStore({ storage: 'memory' }, {});
  const acct = newAccount();
  await store.accounts.create(acct);
  // CONTROL: it works before the close, so the refusals below are about the close.
  check('control: an open store reads the row it wrote',
    (await store.accounts.byId(acct.accountId))?.accountId === acct.accountId, 'the open store is broken');
  check('control: an open store reports healthy', (await store.health()).ok === true, 'health is false while open');

  await store.close();
  for (const [name, call] of [
    ['a read', () => store.accounts.byId(acct.accountId)],
    ['a write', () => store.accounts.create(newAccount())],
    ['a transaction', () => store.tx(async () => 1)],
  ]) {
    await throwsCode(`${name} on a closed store is SERVICE_UNAVAILABLE`, 'SERVICE_UNAVAILABLE', call);
  }
  check('a closed store reports unhealthy', (await store.health()).ok === false,
    'a closed store still reports healthy');
}

// ---------------------------------------------------------------------------------------
// 12. Transaction handles, on both adapters.
//
// The handle is the only thing standing between a caller and somebody else's transaction — on
// Postgres it names a pooled connection on which `commit` and `rollback` are one call away.
// ---------------------------------------------------------------------------------------
async function testHandles(store, tag) {
  console.log(`\n[${tag}] transaction handles`);

  let real = null;
  await store.tx(async (t) => { real = t; });

  for (const [name, value] of [['a plain object', {}], ['an array', []], ['a string', 'tx']]) {
    await throwsCode(`${name} is not a transaction handle`, 'INTERNAL_ERROR',
      () => store.accounts.byId(ulid(), value));
  }

  // The tag alone is not identity. The symbol is reachable from a real handle, so a caller who
  // wants one can have one — what they cannot have is the state it refers to, which lives in a
  // WeakMap keyed by the handle rather than on it.
  const [tagSymbol] = Object.getOwnPropertySymbols(real);
  check('control: the handle carries exactly one own symbol and no own keys',
    tagSymbol !== undefined && Object.keys(real).length === 0,
    `symbols=${Object.getOwnPropertySymbols(real).length} keys=${Object.keys(real).length}`);
  await throwsCode('a forged handle carrying the tag symbol is refused', 'INTERNAL_ERROR',
    () => store.accounts.byId(ulid(), Object.freeze({ [tagSymbol]: true })));
  await throwsCode('a handle whose transaction has ended is refused', 'INTERNAL_ERROR',
    () => store.accounts.byId(ulid(), real));

  // --- the EXPLICIT handle wins over the ambient context --------------------------------
  //
  // Rule 4 of the interface: passing the handle enrols the call in that transaction. The only
  // way to prove the explicit handle is what decided — rather than the ambient transaction the
  // call happens to be written inside — is to use it from OUTSIDE that transaction's async
  // context, where the ambient answer is "no transaction" and the two differ.
  const staged = newAccount();
  let handle = null;
  let ready = null;
  let release = null;
  const readyP = new Promise((r) => { ready = r; });
  const gate = new Promise((r) => { release = r; });
  const running = store.tx(async (t) => {
    await store.accounts.create(staged, t);
    handle = t;
    ready();
    await gate;
  });
  await readyP;
  const byHandle = await withTimeout(store.accounts.byId(staged.accountId, handle), 4000,
    'a read on an explicit handle from outside the transaction');
  const byNothing = await store.accounts.byId(staged.accountId);
  release();
  await running;

  check('a read given the handle sees that transaction\'s uncommitted write',
    byHandle?.accountId === staged.accountId,
    'the explicit handle was ignored and the read fell through to the committed state');
  check('control: the same read WITHOUT the handle does not see it',
    byNothing === null,
    'the write was visible outside its transaction, so the check above proves nothing');
  check('control: it is visible to everyone once the transaction commits',
    (await store.accounts.byId(staged.accountId))?.accountId === staged.accountId,
    'the transaction did not commit');
}

// ---------------------------------------------------------------------------------------
// 13. A primary key is not up for grabs — on both adapters.
//
// Every one of these is a unique constraint or a foreign key the schema declares. The memory
// adapter has to enforce them itself, and an adapter that shrugs at a duplicate is one that
// silently overwrites a row Postgres would have refused.
// ---------------------------------------------------------------------------------------
async function testKeyCollisions(store, tag) {
  console.log(`\n[${tag}] declared keys and foreign keys`);

  const readinessBefore = await store.accounts.identityReadiness();
  const providerReady = { ...newAccount(), passwordHash: null, identityProvider: 'supabase',
    identitySubject: `provider_${ulid()}` };
  await store.accounts.create(providerReady);
  const readinessAfterProvider = await store.accounts.identityReadiness();
  check('a Supabase-bound account with no local hash is identity-ready',
    readinessAfterProvider.unreadyAccounts === readinessBefore.unreadyAccounts,
    JSON.stringify({ readinessBefore, readinessAfterProvider }));

  const acct = newAccount();
  await store.accounts.create(acct);
  const readinessAfterLegacy = await store.accounts.identityReadiness();
  check('control: a live account without a provider subject blocks identity readiness',
    readinessAfterLegacy.ok === false
      && readinessAfterLegacy.unreadyAccounts === readinessBefore.unreadyAccounts + 1,
    JSON.stringify({ readinessBefore, readinessAfterLegacy }));

  await throwsCode('an account id that already exists is CONFLICT', 'CONFLICT',
    () => store.accounts.create({ ...newAccount(), accountId: acct.accountId }));
  await throwsCode('an email hash that already exists is CONFLICT', 'CONFLICT',
    () => store.accounts.create({ ...newAccount(), emailHash: acct.emailHash }));
  // CONTROL: a fresh account still lands, so the two refusals are about the collision.
  const fresh = newAccount();
  await expectOk('control: an account with fresh identifiers is created',
    () => store.accounts.create(fresh));

  // A null email hash is "identity is delegated to the provider" (migration 0008), not a value:
  // many accounts may have one, and a lookup for null must not hand back an arbitrary one.
  const noEmail = { accountId: ulid(), displayName: `p_${ulid().slice(-8)}` };
  noEmail.displayNameFolded = fold(noEmail.displayName);
  await store.accounts.create(noEmail);
  check('byEmailHash(null) is not a wildcard for every account without one',
    (await store.accounts.byEmailHash(null)) === null,
    'a null hash matched an account whose email hash is null');
  check('byEmailHash(undefined) is not a wildcard either',
    (await store.accounts.byEmailHash(undefined)) === null, 'an undefined hash matched a row');
  check('control: byEmailHash still finds an account that does have one',
    (await store.accounts.byEmailHash(acct.emailHash))?.accountId === acct.accountId,
    'the lookup answers null for everything');

  // --- accounts.update: the immutable column and the unique one ------------------------
  await throwsCode('a patch that renames accountId is refused', 'VALIDATION_FAILED',
    () => store.accounts.update(acct.accountId, { accountId: ulid() }));
  await expectOk('control: a patch naming the SAME accountId is a no-op, not an error',
    () => store.accounts.update(acct.accountId, { accountId: acct.accountId, status: 'active' }));
  // An empty patch is a NO-OP that returns the account, not a report that it does not exist.
  // Postgres built `update accounts set  where …`, got nothing back, and read the empty result
  // as "no such account" — so an empty PATCH body answered 404 on the adapter that ships and
  // 200 on the one every test runs against.
  const noop = await store.accounts.update(acct.accountId, {});
  check('a patch with nothing in it returns the account unchanged',
    noop?.accountId === acct.accountId && noop.status === (await store.accounts.byId(acct.accountId)).status,
    JSON.stringify(noop));
  await throwsCode('control: an empty patch for an account that does not exist is still NOT_FOUND',
    'NOT_FOUND', () => store.accounts.update(ulid(), {}));

  // `privacy` is NOT NULL DEFAULT '{}' (0001). Clearing it is `{}`; a null is a caller who
  // means something the column cannot hold.
  await throwsCode('a null privacy is refused', 'VALIDATION_FAILED',
    () => store.accounts.update(acct.accountId, { privacy: null }));
  const clearedPrivacy = await store.accounts.update(acct.accountId, { privacy: {} });
  check('control: an empty object clears privacy',
    clearedPrivacy.privacy !== null && Object.keys(clearedPrivacy.privacy).length === 0,
    JSON.stringify(clearedPrivacy.privacy));

  await throwsCode('updating to an email hash another account holds is CONFLICT', 'CONFLICT',
    () => store.accounts.update(acct.accountId, { emailHash: fresh.emailHash }));
  const rehashed = await store.accounts.update(acct.accountId, { emailHash: `h_${ulid()}` });
  check('control: updating to an unused email hash is accepted',
    rehashed.emailHash.startsWith('h_'), JSON.stringify(rehashed.emailHash));

  // --- sessions and refresh tokens ------------------------------------------------------
  const sessionId = ulid();
  const familyId = ulid();
  await store.sessions.create({ sessionId, accountId: acct.accountId, refreshFamilyId: familyId });
  await throwsCode('a session id that already exists is CONFLICT', 'CONFLICT',
    () => store.sessions.create({ sessionId, accountId: acct.accountId, refreshFamilyId: ulid() }));

  const tokenId = ulid();
  const token = { tokenId, familyId, accountId: acct.accountId, sessionId, expiresAt: iso(86400e3) };
  await store.refreshTokens.create(token);
  await throwsCode('a refresh token id that already exists is CONFLICT', 'CONFLICT',
    () => store.refreshTokens.create({ ...token, familyId: ulid() }));
  await throwsCode('a refresh token for a session that does not exist is NOT_FOUND', 'NOT_FOUND',
    () => store.refreshTokens.create({ ...token, tokenId: ulid(), sessionId: ulid() }));
  await expectOk('control: a second token on the same session is fine',
    () => store.refreshTokens.create({ ...token, tokenId: ulid() }));

  // Revocation is never re-stamped: the FIRST revocation is the one that explains what happened,
  // and a retry that overwrote its reason would erase the only record of why.
  await store.sessions.revoke(sessionId, 'password-changed', iso(-60_000));
  await store.sessions.revoke(sessionId, 'user-logout', iso());
  const revoked = await store.sessions.byId(sessionId);
  check('a second revoke keeps the first reason and instant',
    revoked.revokedReason === 'password-changed' && Date.parse(revoked.revokedAt) < Date.now() - 30_000,
    JSON.stringify({ reason: revoked.revokedReason, at: revoked.revokedAt }));

  // --- the append-only tables -----------------------------------------------------------
  const event = newEvent(acct.accountId);
  await store.outbox.insert(event);
  await throwsCode('the same outbox event id twice is CONFLICT', 'CONFLICT',
    () => store.outbox.insert(event));
  const auditRow = await store.audit.insert({
    actorKind: 'system', action: 'storetest.keys', subjectKind: 'account',
    subjectId: acct.accountId, reasonCode: 'TEST',
  });
  await throwsCode('the same audit id twice is CONFLICT', 'CONFLICT',
    () => store.audit.insert({
      auditId: auditRow.auditId, actorKind: 'system', action: 'storetest.keys',
      subjectKind: 'account', subjectId: acct.accountId, reasonCode: 'TEST',
    }));

  // account_name_history's primary key is (account_id, changed_at): two renames recorded at one
  // instant collide, rather than one silently replacing the other in a moderation record.
  const changedAt = iso();
  await store.accountNameHistory.insert({
    accountId: acct.accountId, previousName: 'OldName', changedAt, reason: 'rename',
  });
  await throwsCode('two name-history rows for one account at one instant collide', 'CONFLICT',
    () => store.accountNameHistory.insert({
      accountId: acct.accountId, previousName: 'OlderName', changedAt, reason: 'rename',
    }));
  await expectOk('control: the same rename an instant later is recorded',
    () => store.accountNameHistory.insert({
      accountId: acct.accountId, previousName: 'OlderName', changedAt: iso(1000), reason: 'rename',
    }));
}

// ---------------------------------------------------------------------------------------
// 14. Rules decided once in store.js and enforced by both adapters (interface rule 5).
// ---------------------------------------------------------------------------------------
async function testSharedRules(store, tag) {
  console.log(`\n[${tag}] rules both adapters answer the same way`);

  const acct = newAccount();
  await store.accounts.create(acct);

  // --- the match status is a closed set -------------------------------------------------
  await throwsCode('a match status outside the stored set is refused', 'VALIDATION_FAILED',
    () => store.matches.record(newAllocation(ulid(), [newPlayer(acct.accountId, 'alpha')],
      { status: 'finished' })));
  // "No status" and "a status I do not recognise" are both VALIDATION_FAILED, so the code alone
  // cannot tell them apart — and the two are different producer mistakes. A missing status names
  // the COLUMN it is missing from; an unknown one echoes the value. Asserting only the code
  // leaves the missing-status check deletable, because the enum below refuses a non-string too.
  for (const missing of [undefined, 3, null, {}]) {
    let details = null;
    try {
      await store.matches.record(newAllocation(ulid(), [newPlayer(acct.accountId, 'alpha')],
        { status: missing }));
    } catch (err) { details = err?.details ?? null; }
    check(`a match whose status is ${JSON.stringify(missing) ?? 'undefined'} is refused as a missing column`,
      details?.column === 'status' && details?.table === 'matches'
        && (details.fields ?? []).some((f) => f.key === 'status' && f.reason === 'required'),
      `details were ${JSON.stringify(details)}`);
  }
  for (const junk of [null, 'a result', 42, []]) {
    await throwsCode(`a result that is ${JSON.stringify(junk)} is refused`, 'VALIDATION_FAILED',
      () => store.matches.record(junk));
  }

  // --- the ALLOCATION shape --------------------------------------------------------------
  // A non-terminal row knows the identifiers and nothing else. Each required one on its own,
  // so a refusal is about the field that was removed.
  for (const field of ['matchId', 'mapId', 'region', 'mode']) {
    const allocation = newAllocation(ulid(), [newPlayer(acct.accountId, 'alpha')]);
    delete allocation[field];
    // eslint-disable-next-line no-loop-func
    await throwsCode(`an allocation with no ${field} is refused`, 'VALIDATION_FAILED',
      () => store.matches.record(allocation));
  }
  await throwsCode('an allocation whose mode is outside the enum is refused', 'VALIDATION_FAILED',
    () => store.matches.record(newAllocation(ulid(), [newPlayer(acct.accountId, 'alpha')],
      { mode: 'ffa' })));
  await throwsCode('an allocation carrying a terminationReason is refused', 'VALIDATION_FAILED',
    () => store.matches.record(newAllocation(ulid(), [newPlayer(acct.accountId, 'alpha')],
      { terminationReason: 'completed' })));
  await expectOk('control: the same allocation without any of those is accepted',
    () => store.matches.record(newAllocation(ulid(), [newPlayer(acct.accountId, 'alpha')])));

  // --- participants ----------------------------------------------------------------------
  await throwsCode('a participant with no accountId is refused', 'VALIDATION_FAILED',
    () => store.matches.record(newAllocation(ulid(), [{ team: 'alpha', kills: 0 }])));
  await throwsCode('a participant whose accountId is not a string is refused', 'VALIDATION_FAILED',
    () => store.matches.record(newAllocation(ulid(), [{ accountId: 42, team: 'alpha' }])));
  await throwsCode('the same account twice in one match is refused', 'VALIDATION_FAILED',
    () => store.matches.record(newAllocation(ulid(), [
      newPlayer(acct.accountId, 'alpha'), newPlayer(acct.accountId, 'bravo')])));

  // --- feature flags: enabled and is_kill_switch are NOT NULL booleans -------------------
  const flagKey = `test.${ulid().slice(-8).toLowerCase()}`;
  for (const [column, value] of [['enabled', 'yes'], ['enabled', null], ['enabled', 1],
    ['isKillSwitch', 'no'], ['isKillSwitch', null]]) {
    await throwsCode(`feature_flags.${column} = ${JSON.stringify(value)} is refused`, 'VALIDATION_FAILED',
      () => store.flags.set(flagKey, { [column]: value }));
  }
  const flagged = await store.flags.set(flagKey, { enabled: true, isKillSwitch: false, rollout: { pct: 5 } });
  check('control: a boolean flag patch is accepted',
    flagged.enabled === true && flagged.isKillSwitch === false && flagged.rollout?.pct === 5,
    JSON.stringify(flagged));
  const partial = await store.flags.set(flagKey, { rollout: null });
  check('control: a key absent from a flag patch leaves its column alone',
    partial.enabled === true && partial.rollout === null, JSON.stringify(partial));

  // --- profiles.settingsVersion is NOT NULL and an integer -------------------------------
  // `upsert` has to hold the same line the CAS does. It is the path the settings service takes
  // when there is no If-Match, so a string version reaching it writes a version nothing can
  // compare against afterwards.
  for (const bad of ['9', 9.5, null, true, {}]) {
    await throwsCode(`an upsert with settingsVersion ${JSON.stringify(bad)} is refused`,
      'VALIDATION_FAILED',
      () => store.profiles.upsert(acct.accountId, { settingsVersion: bad }));
  }
  const versioned = await store.profiles.upsert(acct.accountId, { settingsVersion: 3 });
  check('control: an integer settingsVersion is accepted', versioned.settingsVersion === 3,
    JSON.stringify(versioned));

  // --- markResultApplied says WHICH refusal it is ----------------------------------------
  //
  // "Already applied" and "never finalised" are both CONFLICT, so a test that only checks the
  // code cannot tell them apart — and the caller's next move differs completely: one is a
  // duplicate delivery to drop, the other is a result that has not arrived yet. `reason` is
  // what carries that, so `reason` is what has to be asserted.
  const appliedId = ulid();
  await store.matches.record(newResult(appliedId, [newPlayer(acct.accountId, 'alpha')]));
  await store.matches.markResultApplied(appliedId, iso());
  const liveId = ulid();
  await store.matches.record(newAllocation(liveId, [newPlayer(acct.accountId, 'alpha')]));
  for (const [name, matchId, reason] of [
    ['a result already applied', appliedId, 'result-already-applied'],
    ['a match that never finalised', liveId, 'not-terminal'],
  ]) {
    let details = null;
    try {
      await store.matches.markResultApplied(matchId, iso());
    } catch (err) { details = err?.details ?? null; }
    check(`re-applying ${name} is refused with reason=${reason}`,
      details?.reason === reason, `details were ${JSON.stringify(details)}`);
  }

  // --- the relay's empty batch -----------------------------------------------------------
  //
  // A poll that claimed nothing hands `markPublished` an empty list — or, on the path where the
  // claim itself failed, no list at all. Both are the normal quiet case and neither is an error:
  // an adapter that built `event_id = any($1)` out of them turns an idle relay into a crash loop
  // whose only symptom is that events stop being published.
  for (const [name, batch] of [['an empty', []], ['an absent', undefined], ['a null', null]]) {
    await expectOk(`markPublished tolerates ${name} batch`,
      () => store.outbox.markPublished(batch, iso()));
  }
  // CONTROL: it still publishes a batch that has something in it.
  const publishable = newEvent(acct.accountId);
  await store.outbox.insert(publishable);
  await store.outbox.markPublished([publishable.eventId], iso());
  check('control: a batch with one id in it does publish that event',
    !(await store.outbox.claimUnpublished(500)).some((e) => e.eventId === publishable.eventId),
    'the event is still unpublished, so the three tolerated batches prove nothing');

  // --- the sweeps take an INSTANT, and refuse anything else ------------------------------
  // A sweep that quietly reads `banana` as "now" (or as the epoch) either deletes everything or
  // deletes nothing, and both look exactly like a sweep that ran.
  for (const [name, sweep] of [
    ['idempotency', (at) => store.idempotency.sweepExpired(at)],
    ['preAuthConsent', (at) => store.preAuthConsent.sweepExpired(at)],
  ]) {
    for (const junk of ['banana', '', 'yesterday']) {
      // eslint-disable-next-line no-loop-func
      await throwsCode(`${name}.sweepExpired refuses ${JSON.stringify(junk)}`, 'VALIDATION_FAILED',
        () => sweep(junk));
    }
    await expectOk(`control: ${name}.sweepExpired accepts an ISO instant`, () => sweep(iso()));
    await expectOk(`control: ${name}.sweepExpired defaults to the store's clock`, () => sweep());
  }

  // --- a consent decision recorded between the expiry read and the expiry delete ---------
  //
  // `preAuthConsent.get` deletes what it finds expired, and it re-checks the row INSIDE the
  // write rather than deleting by key: a decision recorded in that window is a live, legally
  // significant answer, and deleting it by key erases it. Both calls are enrolled in one
  // transaction so the interleaving is deterministic rather than a race the suite hopes for.
  const raced = ulid();
  await store.preAuthConsent.put({
    clientSessionId: raced, telemetryPersonal: false, policyVersion: 1,
    decidedAt: iso(-60_000), expiresAt: iso(-1000),
  });
  await store.tx(async (tx) => {
    const reading = store.preAuthConsent.get(raced, tx);   // sees the expired row
    await store.preAuthConsent.deleteFor(raced, tx);       // …which is gone before the delete half runs
    check('an expiring read whose row vanished under it answers null rather than throwing',
      (await reading) === null, 'the read did not survive the row disappearing');
  });
  // CONTROL: the expiry delete really does happen, and it really is conditional on expiry.
  const stale = ulid();
  await store.preAuthConsent.put({
    clientSessionId: stale, telemetryPersonal: true, policyVersion: 1,
    decidedAt: iso(-60_000), expiresAt: iso(-1000),
  });
  check('control: an expired decision reads as absent', (await store.preAuthConsent.get(stale)) === null,
    'the expired decision was honoured');
  check('control: and reading it DELETED it rather than filtering it',
    (await store.preAuthConsent.deleteFor(stale)) === false,
    'the row is still there — expiry filtered on read instead of deleting');
  const kept = ulid();
  await store.preAuthConsent.put({
    clientSessionId: kept, telemetryPersonal: true, policyVersion: 1,
    decidedAt: iso(), expiresAt: iso(30 * 86400e3),
  });
  check('control: an unexpired decision survives being read',
    (await store.preAuthConsent.get(kept))?.telemetryPersonal === true, 'a live decision was deleted');
  await store.preAuthConsent.deleteFor(kept);
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
  await testHandles(store, tag);
  await testKeyCollisions(store, tag);
  await testSharedRules(store, tag);
  await testConformance(store, tag);
  await testP2Persistence(store, tag);
  await testDurableMatchTickets(store, tag);
  await testMatchServerRegistry(store, tag);
}

async function testDurableMatchTickets(store, tag) {
  console.log(`\n[${tag}] durable match-ticket single use`);
  const account = newAccount(); await store.accounts.create(account);
  const roomId = ulid(); const matchId = ulid(); const jti = ulid();
  await store.rooms.upsert({ roomId, ownerAccountId: account.accountId, name: 'Ticket Room', region: 'iad',
    mapId: 'the-square', mapVersion: '1.0.0', mode: 'tdm', rulesetVersion: 'tdm-1.0.0',
    build: '1.0.0', capacity: 2, status: 'in-progress', settings: {}, passwordHash: null,
    destroyedAt: null, destroyedReason: null });
  await store.matches.record({ matchId, roomId, region: 'iad', mapId: 'the-square', mapVersion: '1.0.0',
    mode: 'tdm', status: 'allocated', rulesSnapshot: {}, players: [{ accountId: account.accountId,
      team: 'alpha', joinedAt: iso() }] });
  await store.matchTickets.put({ jti, accountId: account.accountId, roomId, matchId,
    expiresAt: iso(60_000), createdAt: iso() });
  const claims = { accountId: account.accountId, roomId, matchId };
  const concurrent = await Promise.all([store.matchTickets.consume(jti, claims, iso()),
    store.matchTickets.consume(jti, claims, iso())]);
  check('concurrent ticket consume has exactly one winner', concurrent.filter(Boolean).length === 1,
    JSON.stringify(concurrent));
  check('a fresh verifier/process cannot replay the durably consumed jti',
    await store.matchTickets.consume(jti, claims, iso()) === null);
  const wrongJti = ulid(); await store.matchTickets.put({ jti: wrongJti, accountId: account.accountId,
    roomId, matchId, expiresAt: iso(60_000), createdAt: iso() });
  check('claim mismatch fails without consuming the ticket',
    await store.matchTickets.consume(wrongJti, { ...claims, roomId: ulid() }, iso()) === null
      && Boolean(await store.matchTickets.consume(wrongJti, claims, iso())));
  const recentlyExpiredJti = ulid();
  await store.matchTickets.put({ jti: recentlyExpiredJti, accountId: account.accountId, roomId, matchId,
    expiresAt: iso(-23 * 60 * 60 * 1_000), createdAt: iso(-24 * 60 * 60 * 1_000) });
  const oldUnconsumedJti = ulid();
  await store.matchTickets.put({ jti: oldUnconsumedJti, accountId: account.accountId, roomId, matchId,
    expiresAt: iso(-25 * 60 * 60 * 1_000), createdAt: iso(-26 * 60 * 60 * 1_000) });
  const consumedJti = ulid();
  await store.matchTickets.put({ jti: consumedJti, accountId: account.accountId, roomId, matchId,
    expiresAt: iso(60 * 60 * 1_000), createdAt: iso() });
  await store.matchTickets.consume(consumedJti, claims, iso());
  const firstPurge = await store.matchTickets.purgeExpired(iso());
  check('unconsumed ticket receipt is retained until expiry plus 24 hours',
    Boolean(await store.matchTickets.byJti(recentlyExpiredJti)));
  check('unconsumed ticket receipt is purged after expiry plus 24 hours',
    firstPurge >= 1 && await store.matchTickets.byJti(oldUnconsumedJti) == null);
  await store.matchTickets.purgeExpired(iso(24 * 60 * 60 * 1_000));
  check('consumed ticket receipt is retained before expiry plus 24 hours',
    Boolean(await store.matchTickets.byJti(consumedJti)));
  await store.matchTickets.purgeExpired(iso(26 * 60 * 60 * 1_000));
  check('consumed ticket receipt is purged after expiry plus 24 hours',
    await store.matchTickets.byJti(consumedJti) == null);
}

async function testMatchServerRegistry(store, tag) {
  console.log(`\n[${tag}] P2 match-server registry allocation parity`);
  const stamp = iso();
  const rows = [
    ['iad-a', 'iad', 'wss://iad-a.example.invalid'],
    ['iad-b', 'iad', 'wss://iad-b.example.invalid'],
    ['ord-a', 'ord', 'wss://ord-a.example.invalid'],
    ['yyz-a', 'yyz', 'wss://yyz-a.example.invalid'],
  ].map(([suffix, region, address]) => ({ serverId: `${tag}-${suffix}-${ulid()}`, region,
    address, capacity: 12, inUse: 0, status: 'healthy', build: '1.0.0', lastHeartbeatAt: stamp }));
  for (const row of rows) await store.matchServers.register(row);
  const [iad1, iad2] = await Promise.all([
    store.matchServers.reserve('iad', iso(-1000)), store.matchServers.reserve('iad', iso(-1000)),
  ]);
  check('two same-region concurrent reservations select distinct capacity',
    iad1 && iad2 && iad1.serverId !== iad2.serverId, JSON.stringify([iad1, iad2]));
  check('a third reservation cannot oversubscribe two single-match authorities',
    await store.matchServers.reserve('iad', iso(-1000)) === null, 'capacity was oversubscribed');
  const first = rows.find((row) => row.serverId === iad1.serverId);
  await store.matchServers.register({ ...first, inUse: 0, status: 'healthy', lastHeartbeatAt: iso() });
  await store.matchServers.heartbeat(first.serverId,
    { capacity: 12, inUse: 0, status: 'healthy', lastHeartbeatAt: iso() });
  check('restart registration and a stale low heartbeat cannot erase an active reservation',
    (await store.matchServers.byId(first.serverId)).inUse === 12, 'in_use fell below its platform lease');
  await store.matchServers.release(first.serverId);
  check('explicit release makes the restarted authority eligible again',
    (await store.matchServers.reserve('iad', iso(-1000)))?.serverId === first.serverId);
  const ord = rows[2];
  await store.matchServers.heartbeat(ord.serverId,
    { capacity: 12, inUse: 0, status: 'draining', lastHeartbeatAt: iso() });
  check('draining regional capacity is excluded',
    await store.matchServers.reserve('ord', iso(-1000)) === null);
  await store.matchServers.heartbeat(ord.serverId,
    { capacity: 12, inUse: 0, status: 'healthy', lastHeartbeatAt: iso() });
  check('an undrained heartbeat restores its own region only',
    (await store.matchServers.reserve('ord', iso(-1000)))?.serverId === ord.serverId
      && (await store.matchServers.reserve('yyz', iso(-1000)))?.serverId === rows[3].serverId);
  for (const row of rows) await store.matchServers.release(row.serverId);

  // ── Reservation-protection window ────────────────────────────────────────────────────────
  // The greatest() ratchet defends a fresh reservation from the stale pre-allocation heartbeat
  // race, but it must EXPIRE: the release saga's match map is process memory, so a platform
  // restart mid-match orphans the reservation, and a ratchet with no window left the row full
  // forever while the idle gameserver reported inUse=0 every 5s (overstrike-gs-iad-1,
  // 2026-08-21). Timestamps are driven through lastHeartbeatAt so no check has to sleep, and
  // the region is unique per run so a persistent database cannot leak rows between runs.
  const winRegion = `win-${ulid()}`;
  const winId = `${tag}-win-${ulid()}`;
  await store.matchServers.register({ serverId: winId, region: winRegion,
    address: `wss://${winId}.example.invalid`, capacity: 12, inUse: 0, status: 'healthy',
    build: '1.0.0', lastHeartbeatAt: iso() });
  check('control: the fresh row is reservable at all',
    (await store.matchServers.reserve(winRegion, iso(-1000)))?.serverId === winId);
  await store.matchServers.heartbeat(winId,
    { capacity: 12, inUse: 0, status: 'healthy', lastHeartbeatAt: iso() });
  check('inside the window a stale idle heartbeat cannot release a fresh reservation',
    (await store.matchServers.byId(winId)).inUse === 12, 'the pre-allocation race came back');
  check('inside the window the region still reports no capacity',
    await store.matchServers.reserve(winRegion, iso(-1000)) === null);
  await store.matchServers.heartbeat(winId,
    { capacity: 12, inUse: 12, status: 'healthy', lastHeartbeatAt: iso(80_000) });
  check('past the window a bound authority reporting full keeps its seat held',
    (await store.matchServers.byId(winId)).inUse === 12);
  await store.matchServers.heartbeat(winId,
    { capacity: 12, inUse: 0, status: 'healthy', lastHeartbeatAt: iso(80_000) });
  check('past the window an idle authority heals its own orphaned reservation',
    (await store.matchServers.byId(winId)).inUse === 0, 'the orphan is still holding the region');
  check('the healed row is allocatable again without any manual reset',
    (await store.matchServers.reserve(winRegion, iso(-1000)))?.serverId === winId);
  await store.matchServers.release(winId);
  check('normal reserve then release still frees the seat',
    (await store.matchServers.byId(winId)).inUse === 0
      && (await store.matchServers.reserve(winRegion, iso(-1000)))?.serverId === winId);
  check('a reserved row appears in the orphan sweep listing',
    (await store.matchServers.listReserved()).some((row) => row.serverId === winId));
  await store.matchServers.release(winId);
  check('a released row leaves the orphan sweep listing',
    !(await store.matchServers.listReserved()).some((row) => row.serverId === winId));
  // Stale the row out so a rerun against a persistent database never sees it as fresh capacity.
  await store.matchServers.heartbeat(winId,
    { capacity: 12, inUse: 0, status: 'draining', lastHeartbeatAt: iso(-3_600_000) });
}

async function testP2Persistence(store, tag) {
  console.log(`\n[${tag}] P2 room/report persistence parity`);
  const owner = newAccount(); const subject = newAccount();
  await store.accounts.create(owner); await store.accounts.create(subject);
  const roomId = ulid();
  await store.rooms.upsert({
    roomId, ownerAccountId: owner.accountId, name: 'Persisted Square', region: 'yyz',
    mapId: 'the-square', mapVersion: '1.0.0', mode: 'bomb', rulesetVersion: 'bomb-1.0.0',
    build: '1.0.0', capacity: 6, status: 'open', settings: { requiredReady: 2 },
    passwordHash: null, destroyedAt: null, destroyedReason: null,
  });
  await store.roomMembers.upsert({ roomId, accountId: owner.accountId, displayName: owner.displayName,
    team: 'alpha', ready: false, isOwner: true, connection: 'connected', disconnectedAt: null,
    estimatedRttMs: null, loadout: { primaryIdx: 0, secondaryIdx: 0 }, joinedAt: iso(), leftAt: null });
  check('control: a persisted room/member round-trips',
    (await store.rooms.byId(roomId))?.name === 'Persisted Square'
      && (await store.roomMembers.listForRoom(roomId)).length === 1,
    'room or member was not persisted');
  await store.roomMembers.remove(roomId, owner.accountId, iso());
  check('a durable leave cannot resurrect on hydration',
    (await store.roomMembers.listForRoom(roomId)).length === 0, 'left_at remained null');

  const report = { reportId: ulid(), reporterAccountId: owner.accountId,
    subjectAccountId: subject.accountId, matchId: null, category: 'griefing', description: null };
  await expectOk('control: the first no-match report is stored', () => store.reports.create(report));
  await throwsCode('a duplicate no-match report is REPORT_DUPLICATE', 'REPORT_DUPLICATE',
    () => store.reports.create({ ...report, reportId: ulid() }));
  await store.rooms.remove(roomId);
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

// The memory adapter's own timestamp normalisation and its own lifecycle, neither of which
// the shared conformance suite can reach through the interface.
await testMemoryInternals();

await mem.close();

// `assertOpen` needs a store that is really closed, so it gets its own instance rather than
// being bolted onto the end of the shared suite.
await testClosedStore();

await testResultShapeRules();
await testAdapterRegistry();

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

  // The allow-list is what stops the injection, and `columnName`'s second check — that the
  // resolved name is identifier-shaped — is belt to its braces: it can only fire for an
  // ALLOW-LIST ENTRY that was itself mistyped, so it is unreachable while the list is clean and
  // no test can kill it (see the comment at postgres.js's `columnName`). What IS checkable, and
  // what that line's whole premise rests on, is that the list stays clean. Re-measured here on
  // every run rather than recorded once in a comment, because the list grows with the schema.
  {
    const toSnakeHere = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const entries = Object.entries(TABLE_COLUMNS);
    const all = entries.flatMap(([t, cols]) => cols.map((c) => [t, c]));
    const bad = all.filter(([, c]) => !/^[a-z][a-z0-9_]*$/.test(toSnakeHere(c)));
    check(`every one of the ${all.length} allow-listed columns snake-cases into an identifier`,
      all.length > 100 && bad.length === 0, bad.map(([t, c]) => `${t}.${c}`).join(', '));
    // CONTROL: the measurement can fail. A column named the way the injection was would not
    // survive it — which is what makes "0 failing" above a statement rather than a tautology.
    check('control: the same measurement rejects a key shaped like the injection',
      !/^[a-z][a-z0-9_]*$/.test(toSnakeHere(injection)), toSnakeHere(injection));
    check('control: every table in the allow-list is non-empty',
      entries.length >= 8 && entries.every(([, cols]) => Array.isArray(cols) && cols.length > 0),
      entries.map(([t, c]) => `${t}=${c?.length}`).join(', '));
  }

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
      // --- SQL NULL is not jsonb 'null' -------------------------------------------------
      //
      // jsonb columns are stringified before they reach the driver, and a null that went
      // through `JSON.stringify` arrives as the four characters `null` — a jsonb value that is
      // present and reads back through `pg` as JS `null`, indistinguishable from an absent one
      // through the adapter. `is null` is the only question that tells them apart, so it has to
      // be asked here rather than through a read that cannot see the difference.
      const nullProbe = ulid();
      const probeAccount = newAccount();
      await pgStore.accounts.create(probeAccount);
      await pgStore.matches.record(newAllocation(nullProbe, [newPlayer(probeAccount.accountId, 'alpha')]));
      const { rows: [jsonbRow] } = await raw.query(
        `select rounds is null as rounds_null, team_scores is null as scores_null,
                rules_snapshot is null as rules_null
           from matches where match_id = $1`, [nullProbe]);
      check('an allocation stores SQL NULL in its jsonb columns, not the string "null"',
        jsonbRow?.rounds_null === true && jsonbRow.scores_null === true,
        JSON.stringify(jsonbRow));
      // CONTROL: the probe can tell the two apart, and a jsonb column that IS written is not
      // null — otherwise "it is null" would be satisfied by a row that stored nothing at all.
      check('control: a NOT NULL jsonb column on the same row is not null',
        jsonbRow?.rules_null === false, JSON.stringify(jsonbRow));
      const { rows: [litmus] } = await raw.query(
        "select 'null'::jsonb is null as literal_null, null::jsonb is null as sql_null");
      check('control: jsonb \'null\' is NOT SQL NULL, which is what makes the check above real',
        litmus.literal_null === false && litmus.sql_null === true, JSON.stringify(litmus));

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
        // Every field 0013 requires on a TERMINAL row. The fixture used to carry only the
        // four outcome columns 0012 constrained, so once completeness was enforced the
        // control — "a matrix-satisfying row inserts directly" — was refused for a reason
        // that had nothing to do with the matrix it was testing.
        const cols = {
          match_id: ulid(), region: 'yyz', map_id: 'the-square', map_version: '1.0.0',
          mode: 'bomb', rules_snapshot: '{}',
          ruleset_version: 'bomb-1.0.0', stat_definition_version: '1.0.0', server_build: 'test',
          team_scores: '{}', rounds: '[]', evidence_ref: 'ev-1',
          status: 'completed', termination_reason: 'completed',
          outcome_reason: 'timer', winner_team: 'alpha', invalidation_reason: null,
          started_at: new Date().toISOString(),
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
