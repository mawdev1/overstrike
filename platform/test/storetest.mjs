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
import { createMemoryStore } from '../src/core/store/memory.js';
import { loadMigrations, planMigrations, runMigrations } from '../src/core/migrate.js';
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

async function runSuite(store, tag) {
  await testRollback(store, tag);
  await testOutboxAtomicity(store, tag);
  await testAuditAppendOnly(store, tag);
  await testIdempotency(store, tag);
  await testConfusables(store, tag);
  await testStats(store, tag);
  await testInterface(store, tag);
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

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.log('\n=========== STORE — postgres ===========');
  console.log('  skip DATABASE_URL is not set; the Postgres adapter was not exercised');
} else {
  console.log('\n=========== STORE — postgres ===========');
  const { createPostgresStore } = await import('../src/core/store/postgres.js');
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
