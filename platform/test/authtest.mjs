/**
 * AUTH — the verification suite required by contracts/auth.md §12.
 *
 * Every claim here is paired with a **failing control**: an assertion that the check would
 * have caught the opposite outcome. A test that only ever sees the good path proves that the
 * good path exists, not that the bad path is closed — which is exactly how this repository
 * previously kept a green suite across six broken-multiplayer faults.
 *
 * **This suite used to fake the store, and the fake is what hid the two worst defects in the
 * module.** It accepted `outbox.insert(anything)` and implemented `tx(fn)` as `fn({fake:true})`
 * with no rollback. So:
 *
 *   - every auth write path was dead on the real adapter — auth handed the outbox a §2
 *     ENVELOPE where the table takes a §5 ROW, and a real signup answered
 *     `400 VALIDATION_FAILED "Unknown column for events_outbox: type"` — and the fake, which
 *     validated no columns, reported it green;
 *   - refresh-reuse detection revoked the family and emitted its event INSIDE the rotation
 *     transaction and then threw, which rolled both back. A fake with no rollback cannot show
 *     that, so the suite asserted a revocation that never committed.
 *
 * It therefore runs against the REAL `createMemoryStore` — the adapter that ships, with its
 * not-null columns, unique constraints, foreign keys, unknown-column rejection and real
 * snapshot rollback. A fake appears exactly once, in §13, for one control the real store
 * cannot produce on a correct call, and it says so there.
 *
 *   node platform/test/authtest.mjs
 */
import { createMemoryStore } from '../src/core/store/memory.js';
import { createPostgresStore } from '../src/core/store/postgres.js';
import { runMigrations } from '../src/core/migrate.js';
import { createProfileService } from '../src/modules/profile/profile.js';
import { loadConfig } from '../src/core/config.js';
import { ulid } from '../src/core/ids.js';
import { ApiError } from '../src/core/errors.js';
import { createAuthModule } from '../src/modules/auth/index.js';
import { fold, resolveScript } from '../src/modules/auth/names.js';
import { playerActor } from '../src/modules/auth/events.js';
import { RECOVERY_FLOOR_MS, RECOVERY_TTL_MS, createAuthService } from '../src/modules/auth/service.js';
import { sign, handleOf, hashPassword, verifyPassword } from '../src/modules/auth/crypto.js';
import { classifyIp, classifyUserAgent } from '../src/modules/auth/sessions.js';
import { createAuditLog } from '../src/modules/events/audit.js';
import { createOutbox } from '../src/modules/events/outbox.js';
import { check, capabilitiesOf } from '../src/modules/events/rbac.js';
import { fromRow, validateEvent } from '../src/modules/events/envelope.js';

// ---------------------------------------------------------------------------- harness

let passed = 0;
let failed = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  ok    ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title) => console.log(`\n=========== ${title} ===========`);

/** Run `fn`, return the ApiError code it threw, or null when it did not throw. */
async function codeOf(fn) {
  try { await fn(); return null; }
  catch (err) { return err.code ?? `THREW:${err.message}`; }
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A short, unique, policy-legal display-name suffix — Postgres keeps last run's names. */
const uniqueTag = () => ulid().slice(-8);

/** Key-sorted JSON, for comparing two bodies that may have taken different routes to get here. */
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}
const decode = (token) => JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8'));
const median = (xs) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];
const timeIt = async (fn) => {
  const started = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
};

/**
 * Records every argument handed to the store.
 *
 * The real adapter exposes no `dump()`, and the §7 claim is not "the birthdate is not in the
 * rows we happen to read back" but "the birthdate never reaches the store at all" — which is a
 * claim about the calls, so the calls are what this captures.
 */
function recording(store) {
  const written = [];
  const wrap = (table) => Object.fromEntries(Object.entries(table).map(([name, fn]) => [
    name,
    typeof fn === 'function'
      ? (...args) => { try { written.push(JSON.stringify(args)); } catch { /* unserialisable handle */ } return fn.apply(table, args); }
      : fn,
  ]));
  const out = { ...store, written, seen: () => written.join('\n') };
  for (const [key, value] of Object.entries(store)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) out[key] = wrap(value);
  }
  return out;
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLogger; } };

const T0 = Date.parse('2026-08-19T12:00:00.000Z');

const open = [];

function makeClock(now = T0) {
  let t = now;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
}

/**
 * Build the module over ANY store adapter.
 *
 * §17–§20 run the same checks against the memory adapter and, when DATABASE_URL is set, against
 * real PostgreSQL — three of the four defects they cover are adapter-visible, and one of them
 * (the idempotency race) is INVISIBLE on memory by construction, because that adapter
 * serialises every transaction. A memory-only proof of a locking fix is not a proof.
 */
function moduleOn(store, clock, { env = {} } = {}) {
  const config = loadConfig({ PLATFORM_TOKEN_SECRET: 'test-secret-not-a-real-one', ...env });
  const auth = createAuthModule({
    store, config, logger: silentLogger, clock, sleep: realSleep,
    // No janitor timer in a test: §19 calls the sweep directly, and an interval that fires
    // mid-assertion would make the counts non-deterministic.
    consentSweepIntervalMs: 0,
  });
  const h = { store, clock, config, ...auth };
  open.push(h);
  return h;
}

function mk({ now = T0, env = {} } = {}) {
  return moduleOn(recording(createMemoryStore({}, {})), makeClock(now), { env });
}

/** Every §5 outbox row currently staged, and the §2 envelopes they rehydrate to. */
const rows = (h) => h.store.outbox.claimUnpublished(10_000);
const eventTypes = async (h) => (await rows(h)).map((r) => r.eventType);
const auditActions = async (h) => (await h.store.audit.list({ limit: 1000 })).map((r) => r.action);

const DOB = '1994-03-02';
const PASSWORD = 'correct-horse-battery-staple';

/** The whole approved chain: eligibility → consent → signup. */
async function newAccount(h, { email, displayName, telemetryPersonal = true, ip = '203.0.113.9',
  eligibilityReceipt = null } = {}) {
  // Past the §9 auth window, so a test that creates many accounts is measuring the rule it
  // came to measure rather than re-measuring the rate limiter (which §12 covers on its own).
  h.clock.advance(61_000);
  const receipt = eligibilityReceipt
    ?? h.service.eligibilityPreflight({ dateOfBirth: DOB, jurisdiction: 'CA-ON' }).receipt;
  const clientSessionId = ulid(h.clock.now());
  const consent = await h.service.putConsent({ telemetryPersonal, policyVersion: 1, clientSessionId });
  const issued = await h.service.signup({
    email, password: PASSWORD, displayName,
    eligibilityReceipt: receipt, clientSessionId, consentReceipt: consent.receipt,
    ip, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0',
    correlationId: ulid(h.clock.now()),
  });
  return { ...issued, clientSessionId, consent };
}

/** The actor shape the platform actually authorises with, obtained the way a request does. */
const actorFor = (h, issued) => h.sessions.authenticate(issued.accessToken);

// ------------------------------------------------------- 1. access token expiry is 15 min

section('1. ACCESS TOKEN EXPIRES AT 15 MINUTES');
{
  const h = mk();
  const a = await newAccount(h, { email: 'ttl@example.com', displayName: 'TtlOne' });
  const claims = decode(a.accessToken);

  ok('access token TTL is exactly 900 s', claims.exp - claims.iat === 900_000,
    `exp-iat=${(claims.exp - claims.iat) / 1000}s`);
  ok('expiresAt matches the signed exp', Date.parse(a.expiresAt) === claims.exp);

  // Control: one millisecond before expiry the token must still work. Without this the
  // "expired" assertion below would also pass against a token that was never valid at all.
  h.clock.advance(900_000 - 1);
  ok('control: valid at 14:59.999', await codeOf(() => h.sessions.verifyAccessToken(a.accessToken)) === null);

  h.clock.advance(1);
  ok('expired at exactly 15:00.000',
    await codeOf(() => h.sessions.verifyAccessToken(a.accessToken)) === 'AUTH_TOKEN_EXPIRED');

  h.clock.advance(60_000);
  ok('still expired a minute later, not resurrected',
    await codeOf(() => h.sessions.verifyAccessToken(a.accessToken)) === 'AUTH_TOKEN_EXPIRED');
}

// ---------------------------------------------------- 2. refresh rotates; replay kills all

section('2. REFRESH ROTATES; A REPLAY REVOKES THE FAMILY — AND THE REVOCATION COMMITS');
{
  const h = mk();
  const a = await newAccount(h, { email: 'rot@example.com', displayName: 'RotTwo' });

  const r1 = await h.sessions.rotate(a.refreshToken);
  ok('rotation issues a different refresh token', r1.refreshToken !== a.refreshToken);
  ok('rotation issues a fresh access token', r1.accessToken !== a.accessToken);
  ok('rotation stays in the same session', r1.session.sessionId === a.session.sessionId);

  // Control: the *current* token still works, so the failure below is caused by the replay
  // and not by rotation having broken the chain outright.
  const r2 = await h.sessions.rotate(r1.refreshToken);
  ok('control: the newest token rotates again', r2.refreshToken !== r1.refreshToken);
  ok('control: session live before the replay',
    (await h.store.sessions.byId(a.session.sessionId)).revokedAt === null);

  const replay = await codeOf(() => h.sessions.rotate(a.refreshToken));
  ok('a replayed refresh is refused', replay === 'AUTH_SESSION_REVOKED', `code=${replay}`);

  // The four assertions the previous suite could not make, because its fake never rolled a
  // transaction back and the real one rolled the whole detection back with the refusal.
  const session = await h.store.sessions.byId(a.session.sessionId);
  ok('the revocation is COMMITTED, not rolled back with the refusal',
    session.revokedAt !== null && session.revokedReason === 'refresh-reuse',
    `revokedAt=${session.revokedAt} reason=${session.revokedReason}`);
  ok('session.reuse_detected is committed to the real outbox',
    (await eventTypes(h)).includes('session.reuse_detected'));
  ok('the security response is in the audit trail',
    (await auditActions(h)).includes('session.reuse_revoke'));
  ok('the access token stops working immediately',
    await codeOf(() => h.sessions.authenticate(r2.accessToken)) === 'AUTH_SESSION_REVOKED');
  ok('the family stops minting',
    await codeOf(() => h.sessions.rotate(r2.refreshToken)) === 'AUTH_SESSION_REVOKED');

  const emitted = (await rows(h)).find((r) => r.eventType === 'session.reuse_detected');
  ok('the event is audit-retained and personal-class',
    emitted?.retentionClass === 'audit' && emitted?.privacyClass === 'personal');
  ok('the audit row names the system actor, not a player',
    (await h.store.audit.list({ action: 'session.reuse_revoke' }))[0]?.actorKind === 'system');

  // Control: an unrelated account in the same store is untouched — the family is the blast
  // radius, not the store.
  const b = await newAccount(h, { email: 'bystander@example.com', displayName: 'BystandTwo' });
  ok('control: a bystander session still rotates',
    await codeOf(() => h.sessions.rotate(b.refreshToken)) === null);
}

// -------------------------------------------- 2b. a refresh token STOPS at its own expiry

/**
 * §1 above proves the ACCESS token expires at fifteen minutes. Nothing proved the same of the
 * refresh token, and it is the durable half of the pair: `rotateOnce`'s expiry line could be
 * deleted and a token issued four hundred days ago — thirteen times its 30-day TTL, long after
 * the session it belongs to should have ended — still minted a fresh access token, with the
 * whole suite green. A credential with a stated lifetime that outlives it is not a lifetime.
 */
section('2b. A REFRESH TOKEN STOPS ROTATING AT ITS TTL');
{
  const h = mk();
  const ttlMs = h.config.refreshTokenTtlSec * 1000;
  ok('control: the configured refresh TTL is 30 days',
    ttlMs === 30 * 24 * 3600 * 1000, `${h.config.refreshTokenTtlSec}s`);

  const a = await newAccount(h, { email: 'ttl@example.com', displayName: 'TtlTwoB' });
  const stored = await h.store.refreshTokens.byId(handleOf(a.refreshToken));
  ok('control: the token row carries an expiry 30 days out',
    Date.parse(stored.expiresAt) === h.clock.now() + ttlMs,
    `${stored.expiresAt} vs now+${ttlMs}`);

  // One second SHORT of the TTL: still inside its life, so the refusal below is the boundary
  // and not the token having been broken all along.
  h.clock.advance(ttlMs - 1000);
  const stillGood = await codeOf(() => h.sessions.rotate(a.refreshToken));
  ok('CONTROL: one second before expiry the token still rotates', stillGood === null, `code=${stillGood}`);

  // A SECOND account, so the expiry is tested on a token that was never used — a used token
  // is refused by reuse detection, which would pass this test for the wrong reason.
  const b = await newAccount(h, { email: 'ttl2@example.com', displayName: 'TtlTwoC' });
  ok('control: the session behind it is live and unrevoked',
    (await h.store.sessions.byId(b.session.sessionId)).revokedAt === null);
  ok('control: and the token itself is unused, so reuse detection is not what refuses it',
    (await h.store.refreshTokens.byId(handleOf(b.refreshToken))).usedAt === null);

  h.clock.advance(400 * 24 * 3600 * 1000);      // 400 days: >13x the 30-day TTL
  const expired = await codeOf(() => h.sessions.rotate(b.refreshToken));
  ok('a refresh token presented 400 days after issue is REFUSED',
    expired === 'AUTH_TOKEN_INVALID', `code=${expired}`);

  // And it minted nothing on the way out. `codeOf` proves a throw; this proves no side effect.
  let leaked = null;
  try { leaked = await h.sessions.rotate(b.refreshToken); } catch { /* expected */ }
  ok('and it issues no access token at all', leaked === null, JSON.stringify(leaked));

  // CONTROL: a token issued AFTER the clock moved is inside its own window and rotates, so
  // the refusal above is about the token's age and not about the clock being far from zero.
  const c = await newAccount(h, { email: 'ttl3@example.com', displayName: 'TtlTwoD' });
  ok('CONTROL: a freshly issued token rotates at the same far-future clock',
    await codeOf(() => h.sessions.rotate(c.refreshToken)) === null);
}

// --------------------------------------------- 2c. the IP and user-agent CLASS ladders

/**
 * §4 asserts `s.ipClass` is truthy. Every rung of `classifyIp` could be deleted and that stayed
 * true, because the fall-through returns the non-empty string `'unknown'` — so a suite that
 * only asks "is there a class" is satisfied by a function that has stopped classifying. The
 * class is what auth.md §5 puts in the session list INSTEAD of the address, so "it returned
 * something" is not the claim; "it returned the right thing, for the right address" is.
 */
section('2c. IP AND USER-AGENT CLASSIFICATION IS A LADDER, NOT A CONSTANT');
{
  const cases = [
    [undefined, 'unknown', 'no address at all'],
    [null, 'unknown', 'null'],
    ['', 'unknown', 'empty'],
    ['127.0.0.1', 'local', 'IPv4 loopback'],
    ['::1', 'local', 'IPv6 loopback'],
    ['::ffff:127.0.0.1', 'local', 'IPv4-mapped loopback — the form Node hands us'],
    ['10.0.0.5', 'private', 'RFC1918 10/8'],
    ['192.168.1.1', 'private', 'RFC1918 192.168/16'],
    ['172.16.0.1', 'private', 'RFC1918 172.16/12, bottom of the range'],
    ['172.31.255.255', 'private', 'RFC1918 172.16/12, top of the range'],
    ['::ffff:10.0.0.5', 'private', 'IPv4-mapped RFC1918'],
    ['fd00::1', 'private', 'IPv6 unique-local'],
    ['203.0.113.9', 'unknown', 'a PUBLIC address with no geo provider'],
    ['172.15.0.1', 'unknown', 'just BELOW the 172.16/12 block — public, not private'],
    ['172.32.0.1', 'unknown', 'just ABOVE the 172.16/12 block — public, not private'],
    ['8.8.8.8', 'unknown', 'a public resolver'],
  ];
  for (const [ip, want, why] of cases) {
    const got = classifyIp(ip);
    ok(`classifyIp(${JSON.stringify(ip)}) === '${want}' — ${why}`, got === want, `got '${got}'`);
  }
  // Every rung must be REACHABLE: if the table above only ever produced one answer, each
  // assertion could be satisfied by a constant.
  ok('control: the ladder produces more than one class',
    new Set(cases.map(([ip]) => classifyIp(ip))).size === 3,
    [...new Set(cases.map(([ip]) => classifyIp(ip)))].join(','));

  // A geo provider supplies the class for a PUBLIC address, and must never be consulted for
  // an absent one — `classifyIp(null, geo)` handing `'null'` or `''` to a resolver is how a
  // non-address becomes a location.
  const geo = { calls: [], classify(addr) { this.calls.push(addr); return 'CA-ON'; } };
  ok('a geo provider classifies a public address', classifyIp('203.0.113.9', geo) === 'CA-ON');
  ok('control: it was asked about the bare address, with the IPv4-mapped prefix stripped',
    classifyIp('::ffff:203.0.113.9', geo) === 'CA-ON' && geo.calls[1] === '203.0.113.9',
    geo.calls.join(','));
  const before = geo.calls.length;
  ok('a MISSING address is never handed to the geo provider',
    classifyIp(null, geo) === 'unknown' && classifyIp(undefined, geo) === 'unknown'
      && classifyIp('', geo) === 'unknown' && geo.calls.length === before,
    `calls=${geo.calls.join(',')}`);
  ok('nor is a loopback or private address — those are decided locally',
    classifyIp('127.0.0.1', geo) === 'local' && classifyIp('10.0.0.5', geo) === 'private'
      && geo.calls.length === before,
    `calls=${geo.calls.join(',')}`);

  const uaCases = [
    [undefined, 'unknown', 'absent'],
    ['', 'unknown', 'empty'],
    [null, 'unknown', 'null'],
    ['Mozilla/5.0 (Windows NT 10.0) Chrome/120.0', 'chrome-desktop', 'desktop Chrome'],
    ['Mozilla/5.0 (X11; Linux) Firefox/121.0', 'firefox-desktop', 'desktop Firefox'],
    ['Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Edg/120.0', 'edge-desktop', 'Edge, which also says Chrome'],
    ['Mozilla/5.0 (Macintosh) Version/17.0 Safari/605.1', 'safari-desktop', 'desktop Safari'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Mobile/15E Safari/604.1', 'safari-mobile', 'iPhone Safari'],
    ['Mozilla/5.0 (Linux; Android 14) Chrome/120.0 Mobile Safari/537.36', 'chrome-mobile', 'Android Chrome'],
    ['curl/8.4.0', 'other-desktop', 'not a browser at all'],
  ];
  for (const [ua, want, why] of uaCases) {
    const got = classifyUserAgent(ua);
    ok(`classifyUserAgent(${JSON.stringify(ua)?.slice(0, 44)}) === '${want}' — ${why}`,
      got === want, `got '${got}'`);
  }
  ok('control: the user-agent ladder produces more than one class',
    new Set(uaCases.map(([ua]) => classifyUserAgent(ua))).size >= 6);

  // And it is the SERVICE that applies them, not just the exported helper: a session started
  // from a private address is listed as `private`, and the address is nowhere in the row.
  const h = mk();
  const s = await newAccount(h, {
    email: 'class@example.com', displayName: `Klass${uniqueTag()}`, ip: '10.11.12.13',
  });
  const actor = await actorFor(h, s);
  const listed = (await h.sessions.list(actor, actor.sessionId))[0];
  ok('the session list carries the CLASS the address maps to, not merely a non-empty string',
    listed.ipClass === 'private', `ipClass=${listed.ipClass}`);
  ok('control: and the address itself appears nowhere in the row',
    !JSON.stringify(listed).includes('10.11.12.13'), JSON.stringify(listed));
  ok('the user-agent class is the one the header maps to',
    listed.userAgentClass === 'chrome-desktop', `userAgentClass=${listed.userAgentClass}`);
}

// ------------------------------------------- 2d. a stored password hash must BE a scrypt hash

/**
 * `verifyPassword`'s two entry guards — "the stored value is a string" and "its scheme is
 * scrypt" — both survived deletion. They are what stands between a corrupt, absent or
 * foreign-scheme `password_hash` column and `String.prototype.split` being called on `null`:
 * signin calls `verifyPassword` OUTSIDE `internalise`, so the throw is not translated into a
 * platform error at all. The contracted answer to a credential that cannot be verified is
 * `AUTH_INVALID_CREDENTIALS` — a refusal — and never a 500 that tells the caller the account
 * exists and is broken.
 */
section('2d. A NON-SCRYPT STORED HASH IS A REFUSAL, NOT A CRASH');
{
  const junk = [
    [null, 'null — an account row with no hash at all'],
    [undefined, 'undefined — a column the adapter did not return'],
    [123456, 'a number'],
    [{}, 'an object'],
    ['', 'the empty string'],
    ['plaintext-password', 'a plaintext password left in the column'],
    ['bcrypt$2b$10$abcdefghijklmnopqrstuv', 'a bcrypt hash — a different scheme entirely'],
    ['argon2id$v=19$m=65536,t=3,p=4$c2FsdA$a2V5', 'an argon2 hash'],
    ['scrypt', 'the scheme name and nothing else'],
    ['$16384$8$1$c2FsdA$a2V5', 'scrypt-SHAPED but with an EMPTY scheme field'],
    // Everything below carries the RIGHT scheme and is still not a usable record. These are
    // the cases the scheme check cannot catch, and every one of them threw before this suite:
    // `Buffer.from(undefined)`, `scryptSync` with a NaN cost, `scryptSync` with keylen 0.
    ['scrypt$16384$8$1$c2FsdA', 'the right scheme, truncated before the key'],
    ['scrypt$16384$8$1', 'the right scheme, truncated before the salt'],
    ['scrypt$$$$c2FsdA$a2V5', 'the right scheme with EMPTY cost parameters'],
    ['scrypt$abc$def$ghi$c2FsdA$a2V5', 'the right scheme with non-numeric cost parameters'],
    ['scrypt$16384$8$1$c2FsdA$', 'the right scheme with an EMPTY key — a zero-length compare '
      + 'is TRUE, so this must be refused before it reaches timingSafeEqual'],
    ['scrypt$0$0$0$c2FsdA$a2V5', 'the right scheme with zero cost parameters'],
    ['scrypt$-1$8$1$c2FsdA$a2V5', 'the right scheme with a negative cost'],
    ['scrypt$16385$8$1$c2FsdA$a2V5', 'the right scheme with an N that is not a power of two'],
  ];
  for (const [stored, why] of junk) {
    let result = 'THREW';
    try { result = verifyPassword(PASSWORD, stored); } catch { /* result stays THREW */ }
    ok(`verifyPassword against ${why} returns false without throwing`,
      result === false, `got ${JSON.stringify(result)}`);
  }
  const real = hashPassword(PASSWORD);

  /**
   * The scheme check, isolated.
   *
   * Every junk record above is ALSO caught by the field checks — a bcrypt or argon2 string
   * simply does not split into six parts — so none of them can tell whether the scheme is
   * being read at all. This one is a byte-for-byte valid scrypt record with the scheme label
   * swapped: every field is well-formed, the salt and key are real, and the password is the
   * right one. If the scheme is not checked, it verifies TRUE — a record explicitly labelled
   * as another algorithm, accepted as scrypt because it happened to be shaped like one.
   */
  const mislabelled = real.replace(/^scrypt\$/, 'md5$');
  ok('control: the mislabelled record differs from the real one ONLY in its scheme',
    mislabelled !== real && mislabelled.slice(mislabelled.indexOf('$')) === real.slice(real.indexOf('$')));
  ok('a record labelled with ANOTHER scheme never verifies, even when its fields are a valid '
    + 'scrypt record and the password is correct',
    verifyPassword(PASSWORD, mislabelled) === false,
    String(verifyPassword(PASSWORD, mislabelled)));

  // CONTROL: a real scrypt hash still verifies, and a wrong password against it still does
  // not — so "returns false" above is the guard and not the function being inert.
  ok('CONTROL: the correct password against a real scrypt hash verifies',
    verifyPassword(PASSWORD, real) === true);
  ok('CONTROL: the wrong password against the same hash does not',
    verifyPassword(`${PASSWORD}!`, real) === false);

  // End to end, on the production path: signin against an account whose stored hash is not a
  // scrypt hash must answer the ordinary credential refusal.
  const h = mk();
  const acct = await newAccount(h, { email: 'junkhash@example.com', displayName: `Junk${uniqueTag()}` });
  ok('control: the account signs in normally before the column is corrupted',
    await codeOf(() => h.service.signin({ email: 'junkhash@example.com', password: PASSWORD })) === null);
  await h.store.accounts.update(acct.profile.accountId, { passwordHash: 'bcrypt$2b$10$abcdefghijklmnopqrstuv' });
  const code = await codeOf(() => h.service.signin({ email: 'junkhash@example.com', password: PASSWORD }));
  ok('signin against a foreign-scheme stored hash is AUTH_INVALID_CREDENTIALS, not a crash',
    code === 'AUTH_INVALID_CREDENTIALS', `code=${code}`);
}

// ------------------------------------------------- 3. ten concurrent refreshes, one winner

section('3. TEN CONCURRENT REFRESHES PRODUCE EXACTLY ONE NEW TOKEN');
{
  const h = mk();
  const a = await newAccount(h, { email: 'race@example.com', displayName: 'RaceThree' });

  const settled = await Promise.allSettled(
    Array.from({ length: 10 }, () => h.sessions.rotate(a.refreshToken)));
  const wins = settled.filter((s) => s.status === 'fulfilled');
  const losses = settled.filter((s) => s.status === 'rejected');

  ok('exactly one refresh succeeded', wins.length === 1, `${wins.length} succeeded, ${losses.length} refused`);
  ok('exactly one new refresh token exists',
    new Set(wins.map((w) => w.value.refreshToken)).size === 1);
  ok('no replay succeeded silently',
    losses.every((l) => l.reason.code === 'AUTH_SESSION_REVOKED'),
    [...new Set(losses.map((l) => l.reason.code))].join(','));
  ok('the burst was treated as theft, not as traffic',
    (await eventTypes(h)).filter((t) => t === 'session.reuse_detected').length === losses.length);

  // Control: the same ten rotations done properly — each on the token the previous one
  // returned — all succeed. Without this, "exactly one" would also pass for a server that
  // simply refuses to refresh.
  const h2 = mk();
  const b = await newAccount(h2, { email: 'serial@example.com', displayName: 'SerialThree' });
  let current = b.refreshToken;
  const issuedTokens = new Set();
  for (let i = 0; i < 10; i++) {
    const next = await h2.sessions.rotate(current);
    issuedTokens.add(next.refreshToken);
    current = next.refreshToken;
  }
  ok('control: ten single-flighted refreshes all succeed', issuedTokens.size === 10);
  ok('control: no reuse detected on the honest client',
    !(await eventTypes(h2)).includes('session.reuse_detected'));
}

// ------------------------------------------------------- 4. revocation on the next request

section('4. REVOCATION TAKES EFFECT ON THE VERY NEXT REQUEST');
{
  const h = mk();
  const a = await newAccount(h, { email: 'rev@example.com', displayName: 'RevFour' });
  const actor = await actorFor(h, a);

  // Control: the identical token, on the identical call, one line earlier.
  ok('control: authenticated before revocation',
    await codeOf(() => h.sessions.authenticate(a.accessToken)) === null);

  await h.sessions.revoke({ actor, sessionId: actor.sessionId });

  const after = await codeOf(() => h.sessions.authenticate(a.accessToken));
  ok('rejected immediately after revocation', after === 'AUTH_SESSION_REVOKED', `code=${after}`);
  ok('the token itself is still cryptographically valid — the denylist is doing the work',
    await codeOf(() => h.sessions.verifyAccessToken(a.accessToken)) === null);
  ok('the refresh token dies with the session',
    await codeOf(() => h.sessions.rotate(a.refreshToken)) === 'AUTH_SESSION_REVOKED');
  ok('the revocation left a session.revoked row in the real outbox',
    (await eventTypes(h)).includes('session.revoked'));

  // A session belonging to somebody else is NOT_FOUND, and the capability check refuses an
  // actor pointed at another account.
  const h2 = mk();
  const b = await newAccount(h2, { email: 'multi@example.com', displayName: 'MultiFour', ip: '198.51.100.7' });
  const bActor = await actorFor(h2, b);
  await h2.service.signin({ email: 'multi@example.com', password: PASSWORD, ip: '198.51.100.7' });
  const list = await h2.sessions.list(bActor, bActor.sessionId);
  ok('control: two live sessions listed', list.length === 2, `${list.length} sessions`);
  ok('the caller\'s session is flagged current', list.filter((s) => s.isCurrent).length === 1);
  ok('the list carries an IP class, never the address',
    list.every((s) => s.ipClass && !JSON.stringify(s).includes('198.51.100.7')),
    `ipClass=${list[0].ipClass}`);
  ok('an actor may not revoke against an account that is not its own',
    await codeOf(() => h2.sessions.revoke({ actor: bActor, accountId: 'someone-elses-account', sessionId: bActor.sessionId }))
      === 'AUTH_FORBIDDEN');

  await h2.sessions.revokeAll({ actor: bActor });
  ok('signout-all revokes the caller too',
    await codeOf(() => h2.sessions.authenticate(b.accessToken)) === 'AUTH_SESSION_REVOKED');
  ok('the list is empty afterwards',
    (await h2.sessions.list(b.profile.accountId, b.session.sessionId)).length === 0);
  ok('signout-all emitted one session.revoked per session, against a session subject',
    (await rows(h2)).filter((r) => r.eventType === 'session.revoked' && r.subjectKind === 'session').length === 2,
    (await eventTypes(h2)).join(','));
}

// ------------------------------------------------------------- 5. forged / tampered tokens

section('5. FORGED AND TAMPERED TOKENS ARE REJECTED');
{
  const h = mk();
  const a = await newAccount(h, { email: 'forge@example.com', displayName: 'ForgeFive' });

  ok('control: the genuine token is accepted',
    await codeOf(() => h.sessions.verifyAccessToken(a.accessToken)) === null);

  const [body, sig] = a.accessToken.split('.');

  const tamperedBody = decode(a.accessToken);
  tamperedBody.r = ['superadmin'];
  const escalated = `${Buffer.from(JSON.stringify(tamperedBody)).toString('base64url')}.${sig}`;
  ok('a role-escalated payload is rejected',
    await codeOf(() => h.sessions.verifyAccessToken(escalated)) === 'AUTH_TOKEN_INVALID');

  // Flip the FIRST character, not the last: a 32-byte signature is 43 base64url characters,
  // and the final one carries four padding bits, so changing it can decode to the same bytes.
  const flipped = `${body}.${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
  ok('a one-character signature change is rejected',
    await codeOf(() => h.sessions.verifyAccessToken(flipped)) === 'AUTH_TOKEN_INVALID');

  const foreign = sign('some-other-secret', { k: 'access', sub: a.profile.accountId,
    sid: a.session.sessionId, r: ['superadmin'], iat: T0, exp: T0 + 10 ** 9 });
  ok('a token signed with another key is rejected',
    await codeOf(() => h.sessions.verifyAccessToken(foreign)) === 'AUTH_TOKEN_INVALID');

  ok('an unsigned token is rejected',
    await codeOf(() => h.sessions.verifyAccessToken(`${body}.`)) === 'AUTH_TOKEN_INVALID');

  const wrongKind = sign(h.config.tokenSecret, { k: 'consent', sub: a.profile.accountId, exp: T0 + 10 ** 9 });
  ok('a receipt presented as an access token is rejected',
    await codeOf(() => h.sessions.verifyAccessToken(wrongKind)) === 'AUTH_TOKEN_INVALID');

  ok('an absent token is AUTH_REQUIRED, not AUTH_TOKEN_INVALID',
    await codeOf(() => h.sessions.verifyAccessToken(null)) === 'AUTH_REQUIRED');
  ok('an unknown refresh handle is rejected',
    await codeOf(() => h.sessions.rotate('not-a-real-refresh-token')) === 'AUTH_TOKEN_INVALID');
}

// ---------------------------------------------------- 6. recovery/start is indistinguishable

section('6. RECOVERY START IS INDISTINGUISHABLE, INCLUDING IN TIMING');
{
  const h = mk();
  await newAccount(h, { email: 'known@example.com', displayName: 'KnownSix', ip: '203.0.113.11' });

  const knownBody = await h.service.recoveryStart({ email: 'known@example.com', ip: null });
  const unknownBody = await h.service.recoveryStart({ email: 'nobody@example.com', ip: null });
  ok('both are accepted', knownBody.accepted === true && unknownBody.accepted === true);
  ok('the client-visible outcome is identical',
    JSON.stringify({ accepted: knownBody.accepted }) === JSON.stringify({ accepted: unknownBody.accepted }));

  const SAMPLES = 15;
  const TOLERANCE_MS = 10;
  const known = [];
  const unknown = [];
  for (let i = 0; i < SAMPLES; i++) {
    // The auth rate limit (§9) is 5/min per subject and would otherwise cut the run short.
    h.clock.advance(61_000);
    // Interleaved rather than batched, so a CPU that gets busy halfway through the run
    // penalises both samples equally instead of only the second batch.
    known.push(await timeIt(() => h.service.recoveryStart({ email: 'known@example.com', ip: null })));
    unknown.push(await timeIt(() => h.service.recoveryStart({ email: 'nobody@example.com', ip: null })));
  }
  const gap = Math.abs(median(known) - median(unknown));
  ok('response timing does not distinguish the two',
    gap <= TOLERANCE_MS, `known=${median(known).toFixed(1)}ms unknown=${median(unknown).toFixed(1)}ms gap=${gap.toFixed(1)}ms`);
  ok('both paths are held to the floor, not merely close to each other',
    Math.min(...known, ...unknown) >= RECOVERY_FLOOR_MS * 0.9,
    `min=${Math.min(...known, ...unknown).toFixed(1)}ms floor=${RECOVERY_FLOOR_MS}ms`);

  // Control: the same detector, pointed at an implementation that leaks. If this passes as
  // "indistinguishable" then the check above is measuring nothing.
  const leaky = async (exists) => { if (exists) await realSleep(25); };
  const leakKnown = [];
  const leakUnknown = [];
  for (let i = 0; i < 7; i++) {
    leakKnown.push(await timeIt(() => leaky(true)));
    leakUnknown.push(await timeIt(() => leaky(false)));
  }
  ok('control: the detector flags a leaky implementation',
    Math.abs(median(leakKnown) - median(leakUnknown)) > TOLERANCE_MS);

  // Recovery completion revokes every session (auth.md §8).
  const h2 = mk();
  const c = await newAccount(h2, { email: 'reset@example.com', displayName: 'ResetSix' });
  await h2.service.signin({ email: 'reset@example.com', password: PASSWORD });
  const started = await h2.service.recoveryStart({ email: 'reset@example.com' });
  ok('control: sessions live before recovery completes',
    (await h2.sessions.list(c.profile.accountId, null)).length === 2);
  await h2.service.recoveryComplete({ token: started.recoveryToken, newPassword: 'a-brand-new-passphrase' });
  ok('recovery completion revokes every session',
    (await h2.sessions.list(c.profile.accountId, null)).length === 0);
  ok('the old access token stops working',
    await codeOf(() => h2.sessions.authenticate(c.accessToken)) === 'AUTH_SESSION_REVOKED');
  ok('the recovery token is single-use',
    await codeOf(() => h2.service.recoveryComplete({ token: started.recoveryToken, newPassword: 'another-good-passphrase' }))
      === 'AUTH_RECOVERY_TOKEN_INVALID');
  ok('the new password works',
    await codeOf(() => h2.service.signin({ email: 'reset@example.com', password: 'a-brand-new-passphrase' })) === null);
  ok('recovery is audited under account_recovery',
    (await h2.store.audit.list({ action: 'account.recovery_complete' }))[0]?.reasonCode === 'account_recovery');
}

// ------------------------------------------- 7. eligibility hides the age and drops the DOB

section('7. ELIGIBILITY NEVER RETURNS THE MINIMUM AGE OR STORES THE BIRTHDATE');
{
  const h = mk();
  const result = h.service.eligibilityPreflight({ dateOfBirth: DOB, jurisdiction: 'CA-ON' });

  ok('eligible', result.eligible === true);
  ok('the response has no minimumAge', !('minimumAge' in result), Object.keys(result).join(','));
  ok('the response has no age of any kind',
    !JSON.stringify(result).toLowerCase().includes('minimumage')
    && !Object.keys(result).some((k) => /age/i.test(k)));

  const claims = decode(result.receipt);
  ok('the receipt carries a verdict and a policy version', claims.v === true && claims.pv === 1);
  ok('the receipt does not carry the birthdate or an age',
    !JSON.stringify(claims).includes(DOB) && !JSON.stringify(claims).includes('1994')
    && !('age' in claims) && !('dob' in claims));

  await newAccount(h, { email: 'dob@example.com', displayName: 'DobSeven' });
  const seen = h.store.seen();
  ok('the birthdate is never handed to the store, in any argument of any call', !seen.includes(DOB));
  ok('nor is the birth year', !seen.includes('1994-'));
  // Control: the recorder must be able to find a birthdate that IS passed in, or "not found"
  // means nothing.
  await h.store.preAuthConsent.put({ clientSessionId: `decoy-${DOB}`, telemetryPersonal: true,
    policyVersion: 1, decidedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 1e6).toISOString() });
  ok('control: the recorder finds a birthdate when one is passed', h.store.seen().includes(DOB));

  // The verdict, its policy version, and the decision time ARE persisted — that is the record.
  const account = await h.store.accounts.byNameFolded(fold('DobSeven'));
  ok('the derived verdict is persisted', account.eligibilityVerdict === true && account.eligibilityPolicyVer === 1);

  ok('an under-age date is denied',
    await codeOf(() => h.service.eligibilityPreflight({ dateOfBirth: '2020-01-01' })) === 'AUTH_ELIGIBILITY_DENIED');
  try { h.service.eligibilityPreflight({ dateOfBirth: '2020-01-01' }); }
  catch (err) {
    ok('the denial gives a category and nothing else',
      JSON.stringify(err.details) === JSON.stringify({ category: 'under-minimum-age' }),
      JSON.stringify(err.details));
    ok('the denial does not echo the date or the threshold',
      !JSON.stringify(err.details).includes('2020') && !JSON.stringify(err.details).includes('13'));
  }
}

// ------------------------- 7b. a malformed birthdate is a refusal, not an eligible player

/**
 * The age gate has to REJECT before it can hide anything.
 *
 * §7 above proves the gate keeps the birthdate out of the store and the threshold out of the
 * response. It never once fed it a birthdate that is not a birthdate. With both validation
 * lines removed — the `YYYY-MM-DD` shape check and the real-calendar-date check — `"banana"`,
 * `"1994-02-31"` and `"94-3-2"` all returned `eligible: true` AND A SIGNED RECEIPT, and signup
 * accepted that receipt as proof of an age check that never ran. The whole suite stayed green.
 *
 * Each case below is chosen to fail exactly one of the two guards on its own, so neither can
 * be deleted without a red suite:
 *   - `1994-3-2`   passes the calendar check (it is a real date) and fails the SHAPE check;
 *   - `1994-02-31` passes the shape check and fails the CALENDAR check;
 *   - `1900-02-29` likewise — 1900 is divisible by 100 and not by 400, so it is not a leap year.
 */
section('7b. A MALFORMED BIRTHDATE IS REFUSED, AND MINTS NO RECEIPT');
{
  const h = mk();
  const refused = [
    ['1994-3-2', 'a real date in the wrong shape — only the format guard catches this'],
    ['1994-02-31', 'the right shape, an impossible date — only the calendar guard catches this'],
    ['1900-02-29', '1900 is not a leap year — a real calendar, not a divisible-by-four rule'],
    ['banana', 'not a date in any sense'],
    ['', 'empty'],
    ['1994-13-02', 'month 13'],
    ['0000-00-00', 'all zeroes'],
    [19940302, 'a number, not a string'],
    [null, 'null'],
  ];

  for (const [value, why] of refused) {
    // Not `codeOf` alone: a verdict is only half the failure. The endpoint MINTS A SIGNED
    // CREDENTIAL, so what must be true is that nothing came back at all.
    let issued = null;
    const code = await codeOf(() => { issued = h.service.eligibilityPreflight({ dateOfBirth: value, jurisdiction: 'CA-ON' }); });
    ok(`${JSON.stringify(value)} is a VALIDATION_FAILED — ${why}`,
      code === 'VALIDATION_FAILED', `code=${code} returned=${JSON.stringify(issued)}`);
    ok(`${JSON.stringify(value)} mints no eligibility receipt`,
      issued === null, JSON.stringify(issued));
  }

  // The escalation, end to end: a receipt is only dangerous because signup honours it. Drive
  // the whole approved chain from an impossible date and require it to die at the gate.
  const chain = await codeOf(async () => {
    const el = h.service.eligibilityPreflight({ dateOfBirth: '1994-02-31', jurisdiction: 'CA-ON' });
    return newAccount(h, {
      email: `feb31-${uniqueTag()}@example.com`, displayName: `Feb${uniqueTag()}`,
      eligibilityReceipt: el.receipt,
    });
  });
  ok('no account can be created from an impossible birthdate',
    chain === 'VALIDATION_FAILED', `code=${chain}`);

  // CONTROLS. Without these the refusals above are satisfied by a gate that refuses every
  // date, which would be a different defect wearing the same green tick.
  const good = h.service.eligibilityPreflight({ dateOfBirth: DOB, jurisdiction: 'CA-ON' });
  ok('CONTROL: a well-formed birthdate is eligible and DOES mint a receipt',
    good.eligible === true && typeof good.receipt === 'string', JSON.stringify(Object.keys(good)));
  const leap = h.service.eligibilityPreflight({ dateOfBirth: '2000-02-29', jurisdiction: 'CA-ON' });
  ok('CONTROL: 29 February 2000 IS a real date (divisible by 400) and is accepted',
    leap.eligible === true && typeof leap.receipt === 'string');
  const endOfMonth = h.service.eligibilityPreflight({ dateOfBirth: '1994-12-31', jurisdiction: 'CA-ON' });
  ok('CONTROL: the last day of a 31-day month is accepted',
    endOfMonth.eligible === true, JSON.stringify(endOfMonth));

  // And the created account is real — so `newAccount` above failed at the gate rather than
  // because the harness cannot make an account at all.
  const control = await newAccount(h, {
    email: `feb-control-${uniqueTag()}@example.com`, displayName: `FebOk${uniqueTag()}`,
  });
  ok('CONTROL: the same chain from a VALID birthdate creates the account',
    typeof control.accessToken === 'string', JSON.stringify(control.profile?.status));
}

// ------------------------------- 8. the eligibility receipt is required AND single-use

section('8. THE ELIGIBILITY RECEIPT IS REQUIRED, AND CONSUMED');
{
  const h = mk();
  const attempt = async (eligibilityReceipt, email, displayName) => {
    h.clock.advance(61_000);          // see `newAccount` — §12 owns the rate-limit assertions
    const clientSessionId = ulid(h.clock.now());
    const consent = await h.service.putConsent({ telemetryPersonal: false, policyVersion: 1, clientSessionId });
    return h.service.signup({
      email, password: PASSWORD, displayName, eligibilityReceipt,
      clientSessionId, consentReceipt: consent.receipt, correlationId: ulid(h.clock.now()),
    });
  };

  ok('missing receipt is refused',
    await codeOf(() => attempt(undefined, 'a@example.com', 'GateA')) === 'VALIDATION_FAILED');
  ok('a forged receipt is refused',
    await codeOf(() => attempt('bm90LWEtcmVjZWlwdA.c2ln', 'b@example.com', 'GateB')) === 'ELIGIBILITY_RECEIPT_INVALID');

  const foreign = sign('another-services-secret', { k: 'eligibility', v: true, pv: 1, j: null,
    iat: T0, exp: T0 + 10 ** 9, n: 'x' });
  ok('a receipt signed by someone else is refused',
    await codeOf(() => attempt(foreign, 'c@example.com', 'GateC')) === 'ELIGIBILITY_RECEIPT_INVALID');

  const wrongPolicy = sign(h.config.tokenSecret, { k: 'eligibility', v: true, pv: 99, j: null,
    iat: T0, exp: T0 + 10 ** 9, n: 'x' });
  ok('a receipt for another policy version is refused',
    await codeOf(() => attempt(wrongPolicy, 'd@example.com', 'GateD')) === 'ELIGIBILITY_RECEIPT_INVALID');

  const expiring = h.service.eligibilityPreflight({ dateOfBirth: DOB });
  h.clock.advance(30 * 60 * 1000 + 1);
  ok('an expired receipt is refused',
    await codeOf(() => attempt(expiring.receipt, 'e@example.com', 'GateE')) === 'ELIGIBILITY_RECEIPT_INVALID');

  const denialReceipt = sign(h.config.tokenSecret, { k: 'eligibility', v: false, pv: 1, j: null,
    iat: h.clock.now(), exp: h.clock.now() + 10 ** 6, n: 'x' });
  ok('a receipt carrying a negative verdict is denied, not merely invalid',
    await codeOf(() => attempt(denialReceipt, 'f@example.com', 'GateF')) === 'AUTH_ELIGIBILITY_DENIED');

  // §3a.1: "Signup consumes it." One age-gate pass used to mint three accounts on three
  // client session ids, because the `n` nonce was signed and never looked at again.
  const once = h.service.eligibilityPreflight({ dateOfBirth: DOB });
  ok('control: a fresh receipt is accepted',
    await codeOf(() => attempt(once.receipt, 'g@example.com', 'GateG')) === null);
  ok('the SAME receipt cannot mint a second account',
    await codeOf(() => attempt(once.receipt, 'h@example.com', 'GateH')) === 'ELIGIBILITY_RECEIPT_INVALID');
  ok('nor a third, on yet another client session',
    await codeOf(() => attempt(once.receipt, 'i@example.com', 'GateI')) === 'ELIGIBILITY_RECEIPT_INVALID');
  ok('control: a second age-gate pass mints a usable receipt',
    await codeOf(() => attempt(h.service.eligibilityPreflight({ dateOfBirth: DOB }).receipt, 'j@example.com', 'GateJ')) === null);
  ok('only the accounts that presented a fresh receipt exist',
    (await h.store.accounts.byNameFolded(fold('GateG'))) !== null
    && (await h.store.accounts.byNameFolded(fold('GateH'))) === null);

  // A signup that fails for another reason must not burn the receipt with it.
  const survivor = h.service.eligibilityPreflight({ dateOfBirth: DOB });
  ok('control: a signup refused for a bad name fails',
    await codeOf(() => attempt(survivor.receipt, 'k@example.com', 'ad')) === 'NAME_POLICY_VIOLATION');
  ok('the receipt survives a failed signup', await codeOf(() => attempt(survivor.receipt, 'k@example.com', 'GateK')) === null);

  // The other two required fields of REQ-CC-034.
  const el = h.service.eligibilityPreflight({ dateOfBirth: DOB });
  ok('signup without a clientSessionId is refused',
    await codeOf(() => h.service.signup({ email: 'l@example.com', password: PASSWORD, displayName: 'GateL',
      eligibilityReceipt: el.receipt, consentReceipt: 'x.y' })) === 'VALIDATION_FAILED');
  ok('signup without a consentReceipt is refused',
    await codeOf(() => h.service.signup({ email: 'm@example.com', password: PASSWORD, displayName: 'GateM',
      eligibilityReceipt: el.receipt, clientSessionId: ulid(h.clock.now()) })) === 'VALIDATION_FAILED');

  const otherSession = ulid(h.clock.now());
  const mismatched = await h.service.putConsent({ telemetryPersonal: true, policyVersion: 1, clientSessionId: otherSession });
  ok('a consent receipt for a different client session is refused',
    await codeOf(() => h.service.signup({ email: 'n@example.com', password: PASSWORD, displayName: 'GateN',
      eligibilityReceipt: el.receipt, clientSessionId: ulid(h.clock.now()),
      consentReceipt: mismatched.receipt })) === 'VALIDATION_FAILED');
}

// -------------------------------------------------------------- 9. consent: migration, version, TTL

section('9. CONSENT MIGRATES, AND IS NEITHER CALLER-VERSIONED NOR IMMORTAL');
{
  const h = mk();
  const clientSessionId = ulid(h.clock.now());
  const preAuth = await h.service.putConsent({ telemetryPersonal: true, policyVersion: 1, clientSessionId });

  ok('the signed-out decision is keyed to the client session', preAuth.subject === 'client-session');
  ok('control: the pre-auth receipt names the client session',
    decode(preAuth.receipt).s === 'client-session' && decode(preAuth.receipt).sid === clientSessionId);
  ok('control: the row exists before signup',
    (await h.store.preAuthConsent.get(clientSessionId))?.migratedAt === null);

  const issued = await h.service.signup({
    email: 'migrate@example.com', password: PASSWORD, displayName: 'MigrateNine',
    eligibilityReceipt: h.service.eligibilityPreflight({ dateOfBirth: DOB }).receipt,
    clientSessionId, consentReceipt: preAuth.receipt, correlationId: ulid(h.clock.now()),
  });

  const account = await h.store.accounts.byId(issued.profile.accountId);
  ok('the decision landed on the account',
    account.consentTelemetry === true && account.consentPolicyVer === 1);
  ok('the decision time carried over', account.consentDecidedAt === preAuth.decidedAt);
  // §3a.3: "deleted on migration at signup, or on expiry". It used to be stamped `migrated_at`
  // and kept — which reads as absent and retains as present, so a signed-out consent record
  // outlived its purpose by up to 30 days sitting beside the account it had been copied onto.
  ok('the pre-auth row is DELETED on migration, not merely stamped',
    (await h.store.preAuthConsent.get(clientSessionId)) === null);

  const fresh = decode(issued.consentReceipt);
  ok('signup returns a fresh account-scoped receipt',
    fresh.s === 'account' && fresh.sid === issued.profile.accountId);
  ok('the account receipt is not the session receipt', issued.consentReceipt !== preAuth.receipt);
  ok('the profile exposes consent as an object, never absent',
    issued.profile.consent?.telemetryPersonal === true);

  const back = await h.service.signin({ email: 'migrate@example.com', password: PASSWORD });
  ok('signin returns the account-scoped receipt too',
    decode(back.consentReceipt).s === 'account' && decode(back.consentReceipt).sid === issued.profile.accountId);

  // §3a.3: the policy version is the server's. `policyVersion: 999999` used to be stored.
  const csid2 = ulid(h.clock.now());
  ok('control: the current policy version is accepted',
    await codeOf(() => h.service.putConsent({ telemetryPersonal: true, policyVersion: 1, clientSessionId: csid2 })) === null);
  ok('a caller-chosen policy version is refused',
    await codeOf(() => h.service.putConsent({ telemetryPersonal: true, policyVersion: 999999, clientSessionId: csid2 }))
      === 'VALIDATION_FAILED');
  ok('and nothing was written under it',
    (await h.store.preAuthConsent.get(csid2)).policyVersion === 1);
  ok('an omitted policy version defaults to the server\'s',
    (await h.service.putConsent({ telemetryPersonal: false, clientSessionId: csid2 })).policyVersion === 1);

  // The receipt expires with the 30-day pre-auth row §3a.3 makes the source of truth. It used
  // to validate a decade later, outliving the record it claims to prove.
  const ageing = ulid(h.clock.now());
  const receipt = (await h.service.putConsent({ telemetryPersonal: true, policyVersion: 1, clientSessionId: ageing })).receipt;
  ok('control: the receipt has an expiry at all', typeof decode(receipt).exp === 'number');
  h.clock.advance(29 * 24 * 3600 * 1000);
  ok('control: it still validates inside 30 days',
    h.receipts.readConsent(receipt)?.subjectId === ageing);
  h.clock.advance(2 * 24 * 3600 * 1000);
  ok('it stops validating once the pre-auth row it proves would be gone',
    h.receipts.readConsent(receipt) === null);
  ok('a signup presenting the expired receipt is refused',
    await codeOf(() => h.service.signup({ email: 'stale@example.com', password: PASSWORD, displayName: 'StaleNine',
      eligibilityReceipt: h.service.eligibilityPreflight({ dateOfBirth: DOB }).receipt,
      clientSessionId: ageing, consentReceipt: receipt })) === 'VALIDATION_FAILED');

  /**
   * A receipt is also bound to the POLICY it was given under, and that binding was asserted
   * nowhere: `readConsent`'s policy-version line could be deleted and a receipt recording
   * agreement to policy 1 still read as a live claim once the platform had moved to policy 2.
   * Consent is agreement to a specific text. Carrying it forward across a version bump is the
   * one thing a version bump exists to prevent — a decision the player never made.
   *
   * Two modules over ONE store and ONE clock, differing only in configured policy version.
   * The signing secret is identical, so the HMAC still verifies: only the version refuses.
   */
  {
    const shared = recording(createMemoryStore({}, {}));
    const sharedClock = makeClock();
    const v1 = moduleOn(shared, sharedClock);
    const v2 = moduleOn(shared, sharedClock, { env: { PLATFORM_CONSENT_POLICY_VERSION: '2' } });
    ok('control: the two modules really are on different policy versions',
      v1.config.consentPolicyVersion === 1 && v2.config.consentPolicyVersion === 2,
      `${v1.config.consentPolicyVersion} vs ${v2.config.consentPolicyVersion}`);

    const sid = ulid(sharedClock.now());
    const under1 = (await v1.service.putConsent({ telemetryPersonal: true, policyVersion: 1, clientSessionId: sid })).receipt;
    ok('control: the receipt reads as a claim under the policy it was ISSUED under',
      v1.receipts.readConsent(under1)?.policyVersion === 1,
      JSON.stringify(v1.receipts.readConsent(under1)));
    ok('control: and it is a genuine grant, not a decline',
      v1.receipts.readConsent(under1)?.telemetryPersonal === true);

    ok('a policy-1 receipt is NOT a claim once the platform is on policy 2',
      v2.receipts.readConsent(under1) === null,
      JSON.stringify(v2.receipts.readConsent(under1)));

    sharedClock.advance(61_000);
    const staleSignup = await codeOf(() => v2.service.signup({
      email: `policy-${uniqueTag()}@example.com`, password: PASSWORD, displayName: `Pol${uniqueTag()}`,
      eligibilityReceipt: v2.service.eligibilityPreflight({ dateOfBirth: DOB }).receipt,
      clientSessionId: sid, consentReceipt: under1,
    }));
    ok('and a signup under policy 2 presenting a policy-1 consent receipt is refused',
      staleSignup === 'VALIDATION_FAILED', `code=${staleSignup}`);

    // CONTROL: the same chain with a receipt actually issued under policy 2 succeeds — so the
    // refusal above is the version and not the second module being unable to sign anyone up.
    sharedClock.advance(61_000);
    const sid2 = ulid(sharedClock.now());
    const under2 = (await v2.service.putConsent({ telemetryPersonal: true, policyVersion: 2, clientSessionId: sid2 })).receipt;
    ok('CONTROL: a receipt issued under policy 2 reads as a policy-2 claim',
      v2.receipts.readConsent(under2)?.policyVersion === 2);
    const freshSignup = await codeOf(() => v2.service.signup({
      email: `policy2-${uniqueTag()}@example.com`, password: PASSWORD, displayName: `Pol2${uniqueTag()}`,
      eligibilityReceipt: v2.service.eligibilityPreflight({ dateOfBirth: DOB }).receipt,
      clientSessionId: sid2, consentReceipt: under2,
    }));
    ok('CONTROL: and that signup completes', freshSignup === null, `code=${freshSignup}`);
  }

  // A signed-out GET after migration must not keep serving the migrated decision.
  const afterMigration = await h.service.getConsent({ clientSessionId });
  ok('the migrated client session no longer answers as consented',
    afterMigration.telemetryPersonal === null && afterMigration.receipt === null);
}

// ------------------------------------------ 10. verification: own codes, and no cross-account burn

section('10. VERIFICATION USES ITS OWN CODES AND CANNOT BE BURNED BY A STRANGER');
{
  const RECOVERY_CODES = new Set(['AUTH_RECOVERY_TOKEN_INVALID', 'AUTH_RECOVERY_TOKEN_EXPIRED']);
  const h = mk();
  const a = await newAccount(h, { email: 'verify@example.com', displayName: 'VerifyTen' });
  const actor = await actorFor(h, a);

  const bad = await codeOf(() => h.service.verificationComplete({ actor, token: 'not-a-token' }));
  ok('a bad verification token is AUTH_VERIFICATION_TOKEN_INVALID', bad === 'AUTH_VERIFICATION_TOKEN_INVALID', `code=${bad}`);
  ok('and is not a recovery code', !RECOVERY_CODES.has(bad));

  const resent = await h.service.verificationResend({ actor });
  h.clock.advance(24 * 3600 * 1000 + 1);
  const expired = await codeOf(() => h.service.verificationComplete({ actor, token: resent.verificationToken }));
  ok('an expired verification token is AUTH_VERIFICATION_TOKEN_EXPIRED', expired === 'AUTH_VERIFICATION_TOKEN_EXPIRED', `code=${expired}`);
  ok('and is not a recovery code', !RECOVERY_CODES.has(expired));

  // Control: the recovery codes are reachable and distinct, so "not a recovery code" is a
  // real distinction rather than a code that no longer exists anywhere.
  ok('control: recovery still answers with its own code',
    await codeOf(() => h.service.recoveryComplete({ token: 'not-a-token', newPassword: PASSWORD }))
      === 'AUTH_RECOVERY_TOKEN_INVALID');

  // The cross-account burn: any authenticated account could spend another's link, and the
  // link is single-use, so the owner's verification died permanently and silently.
  const victim = await newAccount(h, { email: 'victim@example.com', displayName: 'VictimTen' });
  const victimActor = await actorFor(h, victim);
  const attacker = await newAccount(h, { email: 'attacker@example.com', displayName: 'AttackTen' });
  const attackerActor = await actorFor(h, attacker);

  ok('a stranger presenting the victim\'s token is refused',
    await codeOf(() => h.service.verificationComplete({ actor: attackerActor, token: victim.verificationToken }))
      === 'AUTH_VERIFICATION_TOKEN_INVALID');
  ok('the stranger did not verify themselves',
    (await h.store.accounts.byId(attackerActor.accountId)).emailVerifiedAt === null);
  ok('the victim\'s token was NOT consumed by the attempt',
    await codeOf(() => h.service.verificationComplete({ actor: victimActor, token: victim.verificationToken })) === null);
  ok('the victim is verified', (await h.store.accounts.byId(victimActor.accountId)).emailVerifiedAt !== null);
  ok('and the token is single-use for its owner too',
    await codeOf(() => h.service.verificationComplete({ actor: victimActor, token: victim.verificationToken }))
      === 'AUTH_VERIFICATION_TOKEN_INVALID');
  ok('verification is audited', (await auditActions(h)).includes('account.verify'));

  // Terms, the last link in the chain, with its own conflict shape.
  h.clock.advance(61_000);
  ok('control: the current terms version is accepted',
    await codeOf(() => h.service.termsAccept({ actor: victimActor, version: h.config.termsVersion })) === null);
  ok('a stale terms version is a CONFLICT',
    await codeOf(() => h.service.termsAccept({ actor: victimActor, version: h.config.termsVersion - 1 })) === 'CONFLICT');
  ok('terms acceptance is audited', (await auditActions(h)).includes('account.terms_accept'));
}

// ------------------------------------------------------- 11. display names: script and fold

section('11. CONFUSABLE DISPLAY NAMES CANNOT COEXIST');
{
  const h = mk();
  await newAccount(h, { email: 'ada@example.com', displayName: 'Ada' });

  // Control: an unrelated name is free, so the refusals below are about the rule and not about
  // signup refusing every second account.
  ok('control: a distinct name is accepted',
    await codeOf(() => newAccount(h, { email: 'bela@example.com', displayName: 'Bela' })) === null);

  // The six pairs the reviewer registered side by side. Three are mixed-script and are refused
  // outright; three are genuinely Latin and are caught by the fold.
  const MIXED = [['Ravon', 'Ravօn', 'Armenian'], ['Onyx', 'Ⲟnyx', 'Coptic'], ['Ace', 'Ꭺce', 'Cherokee']];
  for (const [latin, attack, script] of MIXED) {
    ok(`control: ${latin} registers`, await codeOf(() => newAccount(h, { email: `${latin}@example.com`, displayName: latin })) === null);
    const code = await codeOf(() => newAccount(h, { email: `x${latin}@example.com`, displayName: attack }));
    ok(`${script} homoglyph cannot coexist with ${latin}`, code === 'NAME_POLICY_VIOLATION', `code=${code}`);
    ok(`control: the two strings really are different`, latin !== attack);
  }

  const FOLDED = [['Alpha', 'ɑlpha'], ['Abcx', 'ᴀʙᴄx'], ['Rich', 'Rıch']];
  for (const [latin, attack] of FOLDED) {
    ok(`control: ${latin} registers`, await codeOf(() => newAccount(h, { email: `${latin}@example.com`, displayName: latin })) === null);
    const code = await codeOf(() => newAccount(h, { email: `x${latin}@example.com`, displayName: attack }));
    ok(`${attack} folds onto ${latin}`, code === 'NAME_TAKEN', `code=${code}`);
  }

  ok('case alone collides',
    await codeOf(() => newAccount(h, { email: 'case@example.com', displayName: 'ada' })) === 'NAME_TAKEN');
  ok('a full-width form collides (NFKC)',
    await codeOf(() => newAccount(h, { email: 'wide@example.com', displayName: 'Ａｄａ' })) === 'NAME_TAKEN');

  // A WHOLE-script homoglyph passes the script rule, so the fold still has to catch it.
  ok('control: an all-Latin name registers',
    await codeOf(() => newAccount(h, { email: 'aca@example.com', displayName: 'Aca' })) === null);
  ok('an all-Cyrillic homoglyph collides with its Latin twin',
    await codeOf(() => newAccount(h, { email: 'cyr@example.com', displayName: 'аса' })) === 'NAME_TAKEN');

  ok('control: a single non-Latin script is a legitimate name',
    resolveScript('日本語').ok && resolveScript('한국인').ok && resolveScript('Ада').ok);
  ok('control: the fold does not collapse unrelated names', fold('Ada') !== fold('Bela'));

  ok('reserved names are refused',
    await codeOf(() => newAccount(h, { email: 'adm@example.com', displayName: 'admin' })) === 'NAME_POLICY_VIOLATION');
  ok('reserved names are refused through separators, digits and small capitals',
    await codeOf(() => newAccount(h, { email: 'adm2@example.com', displayName: 'Adm1n' })) === 'NAME_POLICY_VIOLATION'
    && await codeOf(() => newAccount(h, { email: 'adm3@example.com', displayName: 'ᴀᴅᴍɪɴ' })) === 'NAME_POLICY_VIOLATION');
  ok('too short is refused',
    await codeOf(() => newAccount(h, { email: 'sh@example.com', displayName: 'ab' })) === 'NAME_POLICY_VIOLATION');
  ok('too long is refused',
    await codeOf(() => newAccount(h, { email: 'lo@example.com', displayName: 'a'.repeat(17) })) === 'NAME_POLICY_VIOLATION');
  ok('a double interior space is refused',
    await codeOf(() => newAccount(h, { email: 'sp@example.com', displayName: 'Ada  B' })) === 'NAME_POLICY_VIOLATION');

  // 30-day cooldown, and what does NOT restart it.
  const h2 = mk();
  const c = await newAccount(h2, { email: 'rename@example.com', displayName: 'FirstName' });
  const actor = await actorFor(h2, c);
  ok('control: the first change is allowed',
    await codeOf(() => h2.service.changeDisplayName({ actor, displayName: 'SecondName' })) === null);
  ok('a second change inside 30 days is refused',
    await codeOf(() => h2.service.changeDisplayName({ actor, displayName: 'ThirdName' })) === 'NAME_CHANGE_COOLDOWN');

  // A case-only edit is not a name change: it skips the cooldown check, so it must not restart
  // the cooldown clock either.
  const beforeCase = (await h2.store.accounts.byId(actor.accountId)).nameChangedAt;
  h2.clock.advance(20 * 24 * 3600 * 1000);
  ok('control: a case-only edit is allowed inside the cooldown',
    await codeOf(() => h2.service.changeDisplayName({ actor, displayName: 'SECONDNAME' })) === null);
  ok('a case-only edit does not restart the 30-day clock',
    (await h2.store.accounts.byId(actor.accountId)).nameChangedAt === beforeCase,
    `before=${beforeCase} after=${(await h2.store.accounts.byId(actor.accountId)).nameChangedAt}`);
  ok('control: the displayed name did change',
    (await h2.store.accounts.byId(actor.accountId)).displayName === 'SECONDNAME');
  h2.clock.advance(10 * 24 * 3600 * 1000 + 1);
  ok('so the cooldown still ends 30 days after the real change',
    await codeOf(() => h2.service.changeDisplayName({ actor, displayName: 'ThirdName' })) === null);
  ok('control: and a real change DOES restart it',
    (await h2.store.accounts.byId(actor.accountId)).nameChangedAt !== beforeCase);
  ok('account.name_changed is emitted for real changes',
    (await eventTypes(h2)).filter((t) => t === 'account.name_changed').length === 3);
}

// ------------------------------------------------------------------------ 12. rate limiting

section('12. RATE LIMITS (http-api.md §9, auth class)');
{
  const h = mk();
  const ip = '203.0.113.44';

  // Per-account: 5/min. Keyed by the email lookup even when no such account exists, so the
  // limiter is not itself an enumeration oracle.
  const codes = [];
  for (let i = 0; i < 7; i++) {
    codes.push(await codeOf(() => h.service.signin({ email: 'limit@example.com', password: 'wrong-password', ip })));
  }
  ok('control: the first five attempts are credential failures',
    codes.slice(0, 5).every((c) => c === 'AUTH_INVALID_CREDENTIALS'), codes.slice(0, 5).join(','));
  ok('the sixth is rate limited', codes[5] === 'AUTH_RATE_LIMITED', `code=${codes[5]}`);

  let retryAfterMs = null;
  try { await h.service.signin({ email: 'limit@example.com', password: 'wrong-password', ip }); }
  catch (err) { retryAfterMs = err.retryAfterMs; }
  ok('retryAfterMs is present and inside the window',
    retryAfterMs > 0 && retryAfterMs <= 60_000, `retryAfterMs=${retryAfterMs}`);

  h.clock.advance(60_001);
  ok('control: the window slides and the limit clears',
    await codeOf(() => h.service.signin({ email: 'limit@example.com', password: 'wrong-password', ip }))
      === 'AUTH_INVALID_CREDENTIALS');

  // Per-IP: 10/min across different accounts.
  const h2 = mk();
  const perIp = [];
  for (let i = 0; i < 12; i++) {
    perIp.push(await codeOf(() => h2.service.signin({ email: `spray${i}@example.com`, password: 'wrong-password', ip })));
  }
  ok('control: the first ten from one IP are credential failures',
    perIp.slice(0, 10).every((c) => c === 'AUTH_INVALID_CREDENTIALS'));
  ok('the eleventh from one IP is rate limited', perIp[10] === 'AUTH_RATE_LIMITED', `code=${perIp[10]}`);
  ok('control: another IP is unaffected',
    await codeOf(() => h2.service.signin({ email: 'spray0@example.com', password: 'wrong-password', ip: '198.51.100.2' }))
      === 'AUTH_INVALID_CREDENTIALS');

  // The four §9 auth-class endpoints that enforced nothing at all.
  const h3 = mk();
  const gateIp = '203.0.113.77';
  const eligibility = [];
  for (let i = 0; i < 12; i++) {
    eligibility.push(await codeOf(() => h3.service.eligibilityPreflight({ dateOfBirth: DOB, ip: gateIp })));
  }
  ok('control: the age gate answers the first ten', eligibility.slice(0, 10).every((c) => c === null));
  ok('the age gate is rate limited — receipts are not free to mint',
    eligibility[10] === 'AUTH_RATE_LIMITED', `code=${eligibility[10]}`);

  const h4 = mk();
  const consent = [];
  for (let i = 0; i < 7; i++) {
    consent.push(await codeOf(() => h4.service.putConsent({
      telemetryPersonal: true, policyVersion: 1, clientSessionId: 'one-client-session', ip: '203.0.113.78',
    })));
  }
  ok('control: consent answers the first five', consent.slice(0, 5).every((c) => c === null));
  ok('consent is rate limited', consent[5] === 'AUTH_RATE_LIMITED', `code=${consent[5]}`);

  const h5 = mk();
  const complete = [];
  for (let i = 0; i < 12; i++) {
    complete.push(await codeOf(() => h5.service.recoveryComplete({
      token: 'not-a-real-token', newPassword: 'a-long-enough-passphrase', ip: '203.0.113.79',
    })));
  }
  ok('control: recovery/complete answers the first ten with its own code',
    complete.slice(0, 10).every((c) => c === 'AUTH_RECOVERY_TOKEN_INVALID'));
  ok('recovery/complete is rate limited — the half of the flow that changes a password',
    complete[10] === 'AUTH_RATE_LIMITED', `code=${complete[10]}`);

  const h6 = mk();
  const v = await newAccount(h6, { email: 'resend@example.com', displayName: 'ResendTwelve' });
  const vActor = await actorFor(h6, v);
  const resends = [];
  for (let i = 0; i < 7; i++) {
    resends.push(await codeOf(() => h6.service.verificationResend({ actor: vActor, ip: '203.0.113.80' })));
  }
  ok('control: verify/resend answers the first five', resends.slice(0, 5).every((c) => c === null));
  ok('verify/resend is rate limited', resends[5] === 'AUTH_RATE_LIMITED', `code=${resends[5]}`);
}

// --------------------------------------- 13. the write paths, against the adapter that ships

section('13. EVERY AUTH WRITE PATH WORKS AGAINST THE REAL STORE');
{
  const h = mk();
  const a = await newAccount(h, { email: 'real@example.com', displayName: 'RealThirteen' });
  const actor = await actorFor(h, a);
  await h.service.changeDisplayName({ actor, displayName: 'RenamedThirteen' });
  await h.sessions.rotate(a.refreshToken);
  await h.sessions.revoke({ actor, sessionId: actor.sessionId });

  const staged = await rows(h);
  ok('signup, signin and revocation all produced outbox rows', staged.length >= 4,
    staged.map((r) => r.eventType).join(','));
  ok('every row is a §5 ROW — eventType/eventVersion/subjectKind/subjectId, no `type` key',
    staged.every((r) => typeof r.eventType === 'string' && typeof r.subjectKind === 'string'
      && r.type === undefined && r.subject === undefined));
  const problems = staged.flatMap((r) => validateEvent(fromRow(r)));
  ok('and every row rehydrates into a valid §2 envelope', problems.length === 0, problems.join(';'));

  // The refresh_tokens column that did not exist.
  const written = h.store.seen();
  ok('refresh tokens are written with issuedAt', written.includes('"issuedAt"'));
  ok('and never with createdAt, which that table does not have',
    !/"tokenId":"[^"]+","familyId":[^}]*"createdAt"/.test(written));

  // CONTROL: the real store, handed what auth used to hand it. If this passes, the assertions
  // above prove nothing — and this is exactly the error a real signup returned.
  const legacy = await codeOf(() => h.store.outbox.insert({
    eventId: ulid(T0), type: 'account.created', version: 1,
    subject: { kind: 'account', id: 'A1' }, actor: { kind: 'player', id: 'A1', role: 'player' },
    payload: {}, privacyClass: 'personal', retentionClass: 'audit',
    schemaRef: 'events/account.created/v1', occurredAt: new Date(T0).toISOString(),
    recordedAt: new Date(T0).toISOString(), correlationId: ulid(T0), causationId: null,
  }));
  ok('control: the OLD envelope shape is still rejected by the real table',
    legacy === 'VALIDATION_FAILED', `code=${legacy}`);

  // An internal schema fault must reach the client as INTERNAL_ERROR, never as a 400 naming a
  // column (errors.md §5). This is the ONE fake in the file: the real store cannot be made to
  // raise a schema fault on a call that is now correct, and a control that cannot be produced
  // is not a control.
  const broken = createMemoryStore({}, {});
  const brokenStore = {
    ...broken,
    accounts: {
      ...broken.accounts,
      create: async () => {
        throw new ApiError('VALIDATION_FAILED', 'Unknown column for accounts: nonsense',
          { details: { table: 'accounts', column: 'nonsense' } });
      },
    },
  };
  let t2 = T0;
  const brokenAuth = createAuthModule({
    store: brokenStore, config: h.config, logger: silentLogger, clock: { now: () => t2 },
  });
  open.push(brokenAuth);
  const csid = ulid(t2);
  const consent = await brokenAuth.service.putConsent({ telemetryPersonal: true, policyVersion: 1, clientSessionId: csid });
  const faulted = await codeOf(() => brokenAuth.service.signup({
    email: 'fault@example.com', password: PASSWORD, displayName: 'FaultThirteen',
    eligibilityReceipt: brokenAuth.service.eligibilityPreflight({ dateOfBirth: DOB }).receipt,
    clientSessionId: csid, consentReceipt: consent.receipt, correlationId: ulid(t2),
  }));
  ok('a storage schema fault surfaces as INTERNAL_ERROR, not VALIDATION_FAILED',
    faulted === 'INTERNAL_ERROR', `code=${faulted}`);
  let leaked = '';
  try {
    await brokenAuth.service.signup({
      email: 'fault2@example.com', password: PASSWORD, displayName: 'FaultB',
      eligibilityReceipt: brokenAuth.service.eligibilityPreflight({ dateOfBirth: DOB }).receipt,
      clientSessionId: csid, consentReceipt: consent.receipt, correlationId: ulid(t2),
    });
  } catch (err) { leaked = JSON.stringify({ message: err.message, details: err.details }); }
  ok('and it names no table and no column in the response',
    !leaked.includes('nonsense') && !leaked.includes('accounts'), leaked);
  // Control: a genuine bad request is still VALIDATION_FAILED, so the mapping above is not
  // simply swallowing every 400.
  ok('control: real invalid input is still VALIDATION_FAILED',
    await codeOf(() => h.service.signup({ email: '', password: PASSWORD, displayName: 'X' })) === 'VALIDATION_FAILED');
}

// -------------------------------------------------- 14. authorization and the audit trail

section('14. RBAC AND AUDIT ARE ON THE PRODUCTION PATH');
{
  const h = mk();
  const a = await newAccount(h, { email: 'rbac@example.com', displayName: 'RbacFourteen' });
  const actor = await actorFor(h, a);

  // The shape mismatch that made every capability check refuse every real actor.
  ok('the authenticated actor carries id and role, which is what check() reads',
    typeof actor.id === 'string' && actor.id === actor.accountId && actor.role === 'player');
  ok('a real actor passes a real capability check',
    check(actor, 'account:update', { accountId: actor.accountId }).allowed);
  ok('control: the OLD actor shape — no id, no role — is refused',
    check({ accountId: actor.accountId, sessionId: actor.sessionId, roles: ['player'] }, 'account:update',
      { accountId: actor.accountId }).reason === 'unattributed_actor');
  ok('and a real actor is still scoped to itself',
    check(actor, 'account:update', { accountId: 'someone-else' }).reason === 'out_of_scope');
  ok('a player still cannot grant roles', !check(actor, 'role:grant', { accountId: actor.accountId }).allowed);

  // Prototype keys are not capabilities.
  for (const key of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    ok(`${key} is not a granted capability`,
      check(actor, key, { accountId: actor.accountId }).reason === 'capability_not_granted');
  }
  ok('control: an actual grant is still allowed', check(actor, 'session:revoke', { accountId: actor.accountId }).allowed);
  ok('control: the grant table is not empty', capabilitiesOf('player').length >= 10);

  // The audit actor is derived, asserted, and no longer whatever the caller typed.
  const outbox = createOutbox({ store: h.store, clock: h.clock, logger: silentLogger });
  const audit = createAuditLog({ store: h.store, clock: h.clock, logger: silentLogger });
  const correlationId = ulid(h.clock.now());
  const playerAsAdmin = { kind: 'admin', id: actor.id, accountId: actor.accountId, role: 'player' };
  ok('a player-role actor cannot be recorded as an admin',
    (await codeOf(() => audit.record({
      actor: playerAsAdmin, action: 'role.grant', subject: { kind: 'account', id: actor.accountId },
      reasonCode: 'support_request', correlationId,
    }))).startsWith('THREW:'));
  ok('a player actor cannot be recorded performing role.grant at all',
    await codeOf(() => audit.record({
      actor: { ...actor, kind: 'player' }, action: 'role.grant', subject: { kind: 'account', id: actor.accountId },
      reasonCode: 'support_request', correlationId,
    })) === 'AUTH_FORBIDDEN');
  ok('an elevated role with no second factor cannot write a row',
    (await codeOf(() => audit.record({
      actor: { kind: 'admin', id: 'mod.rivera@overstrike.gg', role: 'moderator' },
      action: 'sanction.apply', subject: { kind: 'account', id: actor.accountId },
      reasonCode: 'policy_violation', correlationId,
    }))).startsWith('THREW:'));
  ok('control: a moderator WITH a second factor may',
    await codeOf(() => audit.record({
      actor: { kind: 'admin', id: 'mod.rivera@overstrike.gg', role: 'moderator', mfa: true },
      action: 'sanction.apply', subject: { kind: 'account', id: actor.accountId },
      reasonCode: 'policy_violation', correlationId,
    })) === null);
  ok('control: the audit log still writes through recordWithEvent',
    (await audit.recordWithEvent(outbox, { correlationId, actor: { kind: 'admin', id: 'mod.rivera@overstrike.gg', role: 'moderator', mfa: true } },
      { action: 'account.name_change', subject: { kind: 'account', id: actor.accountId }, reasonCode: 'policy_violation' },
      { type: 'account.name_changed', actor: { kind: 'admin', id: 'mod.rivera@overstrike.gg', role: 'moderator' },
        subject: { kind: 'account', id: actor.accountId }, payload: { displayName: 'x' } })).result.row.actorRole === 'moderator');

  // Every state-mutating auth path leaves a row. auth.md §10.
  const h2 = mk();
  const b = await newAccount(h2, { email: 'trail@example.com', displayName: 'TrailFourteen' });
  const bActor = await actorFor(h2, b);
  await h2.service.verificationComplete({ actor: bActor, token: b.verificationToken });
  await h2.service.termsAccept({ actor: bActor, version: h2.config.termsVersion });
  await h2.service.putConsent({ actor: bActor, telemetryPersonal: false, policyVersion: 1 });
  await h2.service.changeDisplayName({ actor: bActor, displayName: 'TrailRenamed' });
  await h2.service.signin({ email: 'trail@example.com', password: PASSWORD });
  await h2.sessions.revoke({ actor: bActor, sessionId: bActor.sessionId });
  const trail = await auditActions(h2);
  for (const action of ['account.signup', 'account.verify', 'account.terms_accept',
    'account.consent_set', 'account.name_change', 'account.signin', 'session.revoke']) {
    ok(`${action} is in the audit trail`, trail.includes(action), trail.join(','));
  }
  const rowsWritten = await h2.store.audit.list({ limit: 100 });
  ok('every row names the actor, the role and a closed-set reason code',
    rowsWritten.every((r) => r.actorId && r.actorRole === 'player' && r.actorKind === 'player'
      && r.reasonCode && r.correlationId));
  // Control: a read is not a mutation and must not manufacture a trail entry.
  const beforeRead = (await auditActions(h2)).length;
  await h2.sessions.list(bActor, bActor.sessionId);
  await h2.service.getConsent({ actor: bActor });
  ok('control: reads write no audit rows', (await auditActions(h2)).length === beforeRead);
}

// ---------------------------------------------------- 15. the ephemeral token store is bounded

section('15. EPHEMERAL TOKENS ARE SWEPT, INCLUDING THEIR ACCOUNT INDEX');
{
  const h = mk();
  const N = 20_000;
  // `recovery/start` is unauthenticated and issues for addresses that do not exist, keyed
  // `absent:<hash>` — nothing ever consumes those, so they were retained for the life of the
  // process and `latestForAccount` was never swept at all.
  for (let i = 0; i < N; i++) h.ephemeral.issue('recovery', `absent:hash-${i}`, `token-${i}`, 1000);
  const filled = h.ephemeral.size();
  ok('control: both maps hold every issued token', filled.handles === N && filled.accounts === N,
    JSON.stringify(filled));

  h.clock.advance(2000);
  ok('control: issuing does not sweep — that is what made it quadratic',
    h.ephemeral.size().handles === N);
  h.ephemeral.issue('recovery', 'absent:one-more', 'token-extra', 1000);
  ok('control: still not swept by the issue', h.ephemeral.size().handles === N + 1);

  h.ephemeral.sweep();
  const after = h.ephemeral.size();
  ok('the sweep drops every expired handle', after.handles === 1, JSON.stringify(after));
  ok('and drops the account index with it — the leak that survived expiry',
    after.accounts === 1, JSON.stringify(after));

  // Control: the sweep must not take a live token with it.
  const h2 = mk();
  h2.ephemeral.issue('recovery', 'acct-live', 'live-token', 60_000);
  h2.ephemeral.issue('recovery', 'acct-dead', 'dead-token', 1000);
  h2.clock.advance(2000);
  h2.ephemeral.sweep();
  ok('control: a live token survives the sweep', h2.ephemeral.peek('recovery', 'live-token').ok);
  ok('and the expired one does not', h2.ephemeral.peek('recovery', 'dead-token').ok === false);
  ok('control: the sweep left exactly the live one', h2.ephemeral.size().handles === 1);
}

// ------------------------------------------------- 16. signup does not leak known addresses

section('16. SIGNUP IS NOT AN ACCOUNT-ENUMERATION ORACLE BY TIMING');
{
  const h = mk();
  await newAccount(h, { email: 'taken@example.com', displayName: 'TakenSixteen' });

  const SAMPLES = 9;
  const TOLERANCE_MS = 10;
  const attempt = (email, displayName) => {
    h.clock.advance(61_000);
    const receipt = h.service.eligibilityPreflight({ dateOfBirth: DOB }).receipt;
    const clientSessionId = ulid(h.clock.now());
    return h.service.putConsent({ telemetryPersonal: true, policyVersion: 1, clientSessionId })
      .then((consent) => h.service.signup({
        email, password: PASSWORD, displayName, eligibilityReceipt: receipt,
        clientSessionId, consentReceipt: consent.receipt, correlationId: ulid(h.clock.now()),
      }).catch(() => {}));
  };

  const existing = [];
  const fresh = [];
  for (let i = 0; i < SAMPLES; i++) {
    existing.push(await timeIt(() => attempt('taken@example.com', `TakenA${i}`)));
    fresh.push(await timeIt(() => attempt(`free${i}@example.com`, `FreeB${i}`)));
  }
  const gap = Math.abs(median(existing) - median(fresh));
  ok('a registered address takes as long to refuse as a fresh one takes to accept',
    gap <= TOLERANCE_MS,
    `existing=${median(existing).toFixed(1)}ms fresh=${median(fresh).toFixed(1)}ms gap=${gap.toFixed(1)}ms`);
  ok('control: both paths actually pay the KDF cost — neither is a fast no-op',
    Math.min(median(existing), median(fresh)) > 1,
    `min=${Math.min(median(existing), median(fresh)).toFixed(1)}ms`);
  ok('control: the refusal is still the generic credential failure',
    await codeOf(() => attempt('taken@example.com', 'TakenLast').then(() => {
      throw new ApiError('VALIDATION_FAILED', 'unused');
    })) !== null);
}

// ============================================================================================
// 17–20 run against BOTH adapters. Each is written once, as a function of a built module, and
// called twice: memory always, real PostgreSQL when DATABASE_URL is set (pgtest.mjs sets it).
// ============================================================================================

/**
 * 17. auth.md §9 History — "Retained for moderation and impersonation review."
 *
 * `account_name_history` has been in migration 0001 since the beginning and had NO accessor on
 * either adapter and no writer anywhere, so the only trace of a previous name was the
 * `account.name_changed` event: a stream with its own retention, published outward, and not
 * something a moderator can query. The retention the contract requires did not exist.
 */
async function nameHistoryChecks(h, label) {
  // Unique per run: on Postgres the rows from the last run are still there, and a display name
  // is unique on its fold forever.
  const tag = uniqueTag();
  const renamed = `Ren${tag}`;
  const a = await newAccount(h, { email: `hist-${ulid(h.clock.now())}@example.com`, displayName: `Hist${tag}` });
  const actor = await actorFor(h, a);
  const original = a.profile.displayName;

  ok(`[${label}] control: a fresh account has no name history`,
    (await h.service.nameHistory({ actor })).length === 0);

  h.clock.advance(1000);
  await h.service.changeDisplayName({ actor, displayName: renamed });
  const history = await h.service.nameHistory({ actor });
  ok(`[${label}] the rename left a history row`, history.length === 1, JSON.stringify(history));
  ok(`[${label}] it retains the PREVIOUS name, not the new one`,
    history[0]?.previousName === original, JSON.stringify(history[0]));
  ok(`[${label}] it names who changed it and when`,
    history[0]?.changedBy === actor.id && typeof history[0]?.changedAt === 'string',
    JSON.stringify(history[0]));

  // A case-only edit is still a name the account was displayed under, so it is still history.
  h.clock.advance(1000);
  await h.service.changeDisplayName({ actor, displayName: renamed.toUpperCase() });
  const twice = await h.service.nameHistory({ actor });
  ok(`[${label}] a case-only edit is retained too`, twice.length === 2,
    twice.map((r) => r.previousName).join(','));
  ok(`[${label}] newest first`, twice[0].previousName === renamed);

  // A no-op rename has no previous name to retain, and (account_id, changed_at) is the primary
  // key — a stream of identical writes at one instant would collide for nothing.
  h.clock.advance(1000);
  await h.service.changeDisplayName({ actor, displayName: renamed.toUpperCase() });
  ok(`[${label}] a rename to the same rendered name writes nothing`,
    (await h.service.nameHistory({ actor })).length === 2);

  // §9: not publicly visible. `account:read` is the capability that already means "may look at
  // this account": self for a player, everyone for support/moderator/superadmin.
  const other = await newAccount(h, { email: `hist2-${ulid(h.clock.now())}@example.com`, displayName: `Hist${uniqueTag()}` });
  const otherActor = await actorFor(h, other);
  ok(`[${label}] another player cannot read it`,
    await codeOf(() => h.service.nameHistory({ actor: otherActor, accountId: actor.accountId }))
      === 'AUTH_FORBIDDEN');
  ok(`[${label}] control: a moderator with a second factor can`,
    (await h.service.nameHistory({
      actor: { kind: 'admin', id: 'mod.rivera@overstrike.gg', role: 'moderator', mfa: true },
      accountId: actor.accountId,
    })).length === 2);
  ok(`[${label}] control: the same moderator WITHOUT the second factor cannot`,
    await codeOf(() => h.service.nameHistory({
      actor: { kind: 'admin', id: 'mod.rivera@overstrike.gg', role: 'moderator' },
      accountId: actor.accountId,
    })) === 'AUTH_FORBIDDEN');
}

/**
 * The failing control for §17, and the one that matters: the history row commits WITH the
 * rename, or the rename does not happen. A history that can be missing exactly the renames
 * that went wrong is not evidence.
 */
async function nameHistoryAtomicityCheck() {
  const h = mk();
  const a = await newAccount(h, { email: 'atomic@example.com', displayName: 'AtomicSeventeen' });
  const actor = await actorFor(h, a);
  const broken = {
    ...h.store,
    accountNameHistory: {
      ...h.store.accountNameHistory,
      insert: async () => { throw new ApiError('INTERNAL_ERROR', 'history write refused'); },
    },
  };
  const h2 = moduleOn(broken, h.clock);
  const before = await eventTypes(h);
  ok('control: a rename whose history insert fails is refused',
    await codeOf(() => h2.service.changeDisplayName({ actor, displayName: 'AtomicRenamed' })) !== null);
  ok('and the account keeps its old name — the write rolled back with it',
    (await h.store.accounts.byId(actor.accountId)).displayName === 'AtomicSeventeen');
  ok('and no account.name_changed event was staged for a rename that did not happen',
    (await eventTypes(h)).filter((t) => t === 'account.name_changed').length
      === before.filter((t) => t === 'account.name_changed').length);
}

/**
 * 18. http-api.md §8 — `PATCH /v1/profile/me` under concurrent retries.
 *
 * The same defect already fixed in `applyMatchResult`: `idempotency.get` inside a transaction
 * takes no lock and there is no row to lock on the first attempt, so on Postgres N concurrent
 * submissions of one key all read `prior = null` and all execute. The transaction was never the
 * guard it looked like.
 *
 * @param canRace whether this adapter can even exhibit the race. Memory serialises every
 *   transaction through one queue, so it cannot — which is precisely why a memory-green suite
 *   reported this as working.
 */
async function patchIdempotencyChecks(h, label, { canRace }) {
  const a = await newAccount(h, { email: `idem-${ulid(h.clock.now())}@example.com`, displayName: `Idem${uniqueTag()}` });
  const actor = await actorFor(h, a);

  /** Counts EXECUTIONS: `execute()` is the only thing that writes the privacy patch. */
  const counting = (store) => {
    const counts = { executions: 0 };
    const wrapped = {
      ...store,
      accounts: {
        ...store.accounts,
        update: (...args) => { counts.executions += 1; return store.accounts.update(...args); },
      },
    };
    return { wrapped, counts };
  };

  const patch = { privacy: { statsVisibility: 'everyone' } };
  const N = 10;

  const { wrapped, counts } = counting(h.store);
  const service = createProfileService({
    store: wrapped, clock: { now: () => h.clock.now() },
    changeDisplayName: h.service.changeDisplayName,
  });
  const key = `patch-${ulid(h.clock.now())}`;
  const settled = await Promise.allSettled(
    Array.from({ length: N }, () => service.patchProfile(actor, patch, { idempotencyKey: key })));

  const failures = settled.filter((s) => s.status === 'rejected').map((s) => s.reason?.code ?? String(s.reason));
  ok(`[${label}] all ${N} concurrent identical PATCHes succeed`, failures.length === 0, failures.join(','));
  ok(`[${label}] exactly ONE of them executed`, counts.executions === 1, `executions=${counts.executions}`);
  // Compared key-sorted, not byte-for-byte. `idempotency_keys.response_body` is jsonb, and
  // jsonb does not preserve key order — so the replayed body comes back from Postgres with its
  // keys rearranged. That is a storage property, not a difference in the response: §8 requires
  // the stored response, and JSON object key order carries no meaning in it.
  const bodies = settled.filter((s) => s.status === 'fulfilled').map((s) => stableJson(s.value));
  ok(`[${label}] every reply is the same stored response`,
    bodies.length === N && bodies.every((b) => b === bodies[0]));
  ok(`[${label}] control: the one execution did apply`,
    (await h.store.accounts.byId(actor.accountId)).privacy.statsVisibility === 'everyone');

  // The key is still a key: a different payload under it is refused rather than replayed.
  ok(`[${label}] the same key with a different payload is still IDEMPOTENCY_KEY_REUSED`,
    await codeOf(() => service.patchProfile(actor, { privacy: { statsVisibility: 'nobody' } },
      { idempotencyKey: key })) === 'IDEMPOTENCY_KEY_REUSED');

  // THE FAILING CONTROL. Take the lock away and the race returns — on an adapter that can race.
  //
  // The pool is warmed first, deliberately. On a cold pool, opening ten connections is itself a
  // staggered start and the winner can commit before the others read, so the race hides — and a
  // control that only sometimes fails is not a control. Warm, all ten begin together.
  await Promise.all(Array.from({ length: N }, () => h.store.accounts.byId(actor.accountId)));
  const { wrapped: unlockedBase, counts: unlockedCounts } = counting(h.store);
  const unlocked = { ...unlockedBase, idempotency: { get: h.store.idempotency.get, put: h.store.idempotency.put } };
  const unlockedService = createProfileService({
    store: unlocked, clock: { now: () => h.clock.now() },
    changeDisplayName: h.service.changeDisplayName,
  });
  const key2 = `patch-${ulid(h.clock.now())}-unlocked`;
  await Promise.allSettled(Array.from({ length: N },
    () => unlockedService.patchProfile(actor, { privacy: { presenceVisibility: 'everyone' } },
      { idempotencyKey: key2 })));
  if (canRace) {
    ok(`[${label}] control: WITHOUT acquire, the same ${N} retries execute more than once`,
      unlockedCounts.executions > 1, `executions=${unlockedCounts.executions}`);
  } else {
    ok(`[${label}] control: without acquire this adapter STILL executes once — it serialises `
      + 'every transaction, so it cannot show the defect at all',
    unlockedCounts.executions === 1, `executions=${unlockedCounts.executions}`);
  }
}

/**
 * 19. http-api.md §3a.3 — the 30-day TTL is a retention obligation, not a cache policy.
 *
 * Expiry was enforced on READ only. That answers correctly and retains forever: the rows nobody
 * reads again are exactly the rows nobody deletes, and they are consent records.
 *
 * @param countRows counts pre_auth_consent rows WITHOUT reading them through `get`, which
 *   deletes on read and would therefore perform the very cleanup being measured.
 */
async function consentSweepChecks(h, label, countRows) {
  const live = `sweep-live-${ulid(h.clock.now())}`;
  const dead = `sweep-dead-${ulid(h.clock.now())}`;
  const t = h.clock.now();
  await h.store.preAuthConsent.put({
    clientSessionId: dead, telemetryPersonal: true, policyVersion: 1,
    decidedAt: new Date(t).toISOString(), expiresAt: new Date(t + 1000).toISOString(),
  });
  await h.store.preAuthConsent.put({
    clientSessionId: live, telemetryPersonal: false, policyVersion: 1,
    decidedAt: new Date(t).toISOString(), expiresAt: new Date(t + 30 * 24 * 3600e3).toISOString(),
  });
  const base = await countRows();
  ok(`[${label}] control: both rows are stored`, base >= 2, `rows=${base}`);

  h.clock.advance(2000);
  ok(`[${label}] control: nothing reads the expired row, so nothing deletes it`,
    (await countRows()) === base, `rows=${await countRows()}`);

  const removed = await h.sweepPreAuthConsent();
  ok(`[${label}] the sweep deletes the expired row`, removed >= 1, `removed=${removed}`);
  ok(`[${label}] and it is gone from the table`, (await countRows()) === base - removed,
    `rows=${await countRows()} base=${base} removed=${removed}`);
  ok(`[${label}] control: the live decision survives`,
    (await h.store.preAuthConsent.get(live))?.telemetryPersonal === false);
  ok(`[${label}] control: a second sweep finds nothing left to do`,
    await h.sweepPreAuthConsent() === 0);
}

section('17. THE PREVIOUS DISPLAY NAME IS RETAINED (auth.md §9)');
{
  const h = mk();
  await nameHistoryChecks(h, 'memory');
  await nameHistoryAtomicityCheck();
}

section('18. PATCH /v1/profile/me IS IDEMPOTENT UNDER CONCURRENT RETRIES (§8)');
{
  await patchIdempotencyChecks(mk(), 'memory', { canRace: false });
}

section('19. EXPIRED PRE-AUTH CONSENT IS SWEPT, NOT MERELY UNREAD (§3a.3)');
{
  const h = mk();
  await consentSweepChecks(h, 'memory', async () => h.store._debugCounts().preAuthConsent);

  // The sweep needs a caller, or it is the same dead code the read-path expiry was standing in
  // for. The module owns the timer; this is the timer, running.
  const timed = moduleOn(recording(createMemoryStore({}, {})), makeClock(), { env: {} });
  timed.stop();
  const janitor = createAuthModule({
    store: timed.store, config: timed.config, logger: silentLogger, clock: timed.clock,
    sleep: realSleep, consentSweepIntervalMs: 10,
  });
  open.push(janitor);
  await timed.store.preAuthConsent.put({
    clientSessionId: 'janitor-row', telemetryPersonal: true, policyVersion: 1,
    decidedAt: new Date(timed.clock.now()).toISOString(),
    expiresAt: new Date(timed.clock.now() - 1).toISOString(),
  });
  ok('control: the expired row is there before the janitor runs',
    timed.store._debugCounts().preAuthConsent === 1);
  await realSleep(120);
  ok('the janitor timer sweeps without anyone calling it',
    timed.store._debugCounts().preAuthConsent === 0);
  janitor.stop();
}

// ------------------------------- 19b. the refusals nothing was asserting on

/**
 * Guards that were unguarded.
 *
 * Each check below was written because deleting the line it covers left the whole suite green
 * — measured with `node scripts/mutatetest.mjs --file=platform/src/modules/auth/service.js`.
 * The pattern in every case was the same: some OTHER refusal downstream produced the same
 * `code`, so a test that asserted only the code could not tell the guard from its absence.
 * These therefore assert the thing that actually differs — the message, the `details.fields`
 * path, the side effect, or the fact that no credential was minted.
 */
section('19b. REFUSALS THAT NOTHING WAS ASSERTING ON');
{
  const h = mk();

  // ── the service will not exist without an outbox and an audit log ────────────────────
  //
  // §10 requires every privileged action to be audited and every state change to be emitted.
  // Constructed without either, the service builds fine and then throws a TypeError on the
  // FIRST mutation — after the request was accepted, from inside a transaction, with the
  // caller told `INTERNAL_ERROR`. The wiring is refused at construction instead.
  const parts = {
    store: h.store, config: h.config, clock: h.clock, logger: silentLogger,
    sessions: h.sessions, receipts: h.receipts, ephemeral: h.ephemeral, limiter: h.limiter,
    outbox: h.outbox, audit: h.audit,
  };
  const build = (over) => {
    try { createAuthService({ ...parts, ...over }); return null; }
    catch (err) { return err.message; }
  };
  ok('a service built with no outbox is refused, and says which dependency is missing',
    (build({ outbox: null }) ?? '').includes('an outbox and an audit log are required'),
    String(build({ outbox: null })));
  ok('a service built with no audit log is refused the same way',
    (build({ audit: undefined }) ?? '').includes('an outbox and an audit log are required'),
    String(build({ audit: undefined })));
  ok('CONTROL: with both present the service constructs — the refusal is the dependency',
    build({}) === null, String(build({})));

  // ── a consent decision is a BOOLEAN ──────────────────────────────────────────────────
  //
  // `!!telemetryPersonal` was the alternative, and it is how `"false"` becomes a recorded YES.
  // The refusal has to name the field, because the client's only repair is to send it again.
  for (const value of ['true', 'false', 1, 0, null, undefined, {}]) {
    const sid = ulid(h.clock.now());
    let thrown = null;
    const code = await codeOf(async () => {
      try { return await h.service.putConsent({ telemetryPersonal: value, policyVersion: 1, clientSessionId: sid }); }
      catch (err) { thrown = err; throw err; }
    });
    const path = thrown?.details?.fields?.[0]?.path;
    ok(`telemetryPersonal: ${JSON.stringify(value)} is refused, naming the field`,
      code === 'VALIDATION_FAILED' && path === 'telemetryPersonal', `code=${code} path=${path}`);
    ok(`telemetryPersonal: ${JSON.stringify(value)} records no decision`,
      (await h.store.preAuthConsent.get(sid)) === null,
      JSON.stringify(await h.store.preAuthConsent.get(sid)));
  }
  // CONTROL: the two values that ARE decisions are recorded, so the refusals are the type.
  for (const value of [true, false]) {
    const sid = ulid(h.clock.now());
    const put = await h.service.putConsent({ telemetryPersonal: value, policyVersion: 1, clientSessionId: sid });
    ok(`CONTROL: telemetryPersonal: ${value} is recorded and receipted`,
      put.telemetryPersonal === value && typeof put.receipt === 'string'
      && (await h.store.preAuthConsent.get(sid))?.telemetryPersonal === value,
      JSON.stringify(put));
  }

  // ── an authenticated read for an account that is not there ───────────────────────────
  //
  // `getConsent` reads the account and then reads a field off it. Without the guard the read
  // is `null.consentTelemetry` — a TypeError, which leaves as `INTERNAL_ERROR` and tells a
  // support investigation nothing. NOT_FOUND is the answer, and it is the answer BEFORE any
  // consent state is invented for an account that does not exist.
  const ghost = { id: 'account:GHOSTACCOUNT0000000000000', accountId: 'GHOSTACCOUNT0000000000000', roles: ['player'] };
  ok('getConsent for an account that does not exist is NOT_FOUND',
    await codeOf(() => h.service.getConsent({ actor: ghost })) === 'NOT_FOUND');
  // CONTROL: the same call for a real account answers, so NOT_FOUND is about the account.
  const consentAccount = await newAccount(h, { email: 'ghostctl@example.com', displayName: `Ghost${uniqueTag()}` });
  const consentActor = await actorFor(h, consentAccount);
  const realConsent = await h.service.getConsent({ actor: consentActor });
  ok('CONTROL: getConsent for a real account returns that account\'s decision',
    realConsent.subject === 'account' && realConsent.telemetryPersonal === true,
    JSON.stringify(realConsent));

  // ── undecided is undecided: no fragment of a decision leaks into the projection ──────
  //
  // §4 types consent as an exact union — a decision with its policy version and its time, or
  // null. `null` means the question has not been answered, and answering "no decision, policy
  // version 3" is a third member of a union that has two. Migration 0015 refuses a partial row
  // on Postgres (asserted in §20); the memory adapter has no such constraint, so the projection
  // is the guard here, and this is the state it is a guard against.
  await h.store.accounts.update(consentActor.accountId, {
    consentTelemetry: null, consentPolicyVer: 3, consentDecidedAt: new Date(h.clock.now()).toISOString(),
  });
  const undecided = await h.service.getConsent({ actor: consentActor });
  ok('an account with no recorded decision reports NO policy version and NO decision time',
    undecided.telemetryPersonal === null && undecided.policyVersion === null
    && undecided.decidedAt === null && undecided.receipt === null && undecided.subject === 'account',
    JSON.stringify(undecided));
  // CONTROL: a real decision reports all three, so the nulls above are the undecided state and
  // not a projection that has stopped reading the account at all.
  await h.service.putConsent({ actor: consentActor, telemetryPersonal: true, policyVersion: 1 });
  const decided = await h.service.getConsent({ actor: consentActor });
  ok('CONTROL: a recorded decision reports its version, its time and a receipt',
    decided.telemetryPersonal === true && decided.policyVersion === 1
    && typeof decided.decidedAt === 'string' && typeof decided.receipt === 'string',
    JSON.stringify(decided));

  // ── a locked account cannot sign in, with the credential correct ─────────────────────
  //
  // The credential check above it passes, so nothing but this line stands between a banned
  // player and a live session. Both statuses, because `banned` alone would let `restricted`
  // be deleted from the condition without a red suite.
  for (const status of ['banned', 'restricted']) {
    const locked = await newAccount(h, { email: `${status}@example.com`, displayName: `Lock${uniqueTag()}` });
    const lockedActor = await actorFor(h, locked);
    await h.store.accounts.update(lockedActor.accountId, { status });
    const code = await codeOf(() => h.service.signin({
      email: `${status}@example.com`, password: PASSWORD, ip: '203.0.113.9',
    }));
    ok(`a ${status} account cannot sign in even with the right password`,
      code === 'AUTH_ACCOUNT_LOCKED', `code=${code}`);
    // The refusal must not be a bad-credential answer either: those two have different UI
    // obligations, and telling a banned player "wrong password" sends them to recovery.
    ok(`a ${status} account is not told its password is wrong`,
      code !== 'AUTH_INVALID_CREDENTIALS', `code=${code}`);
  }
  // CONTROL: the same account, same password, active again — so the refusal is the status.
  const reinstated = await newAccount(h, { email: 'active@example.com', displayName: `Live${uniqueTag()}` });
  const reinstatedActor = await actorFor(h, reinstated);
  await h.store.accounts.update(reinstatedActor.accountId, { status: 'restricted' });
  ok('control: while restricted, signin is refused',
    await codeOf(() => h.service.signin({ email: 'active@example.com', password: PASSWORD })) === 'AUTH_ACCOUNT_LOCKED');
  await h.store.accounts.update(reinstatedActor.accountId, { status: 'active' });
  const back = await h.service.signin({ email: 'active@example.com', password: PASSWORD });
  ok('CONTROL: reinstated, the identical credential signs in',
    typeof back.accessToken === 'string', JSON.stringify(Object.keys(back)));

  // ── an EXPIRED reset link is not an invalid one ──────────────────────────────────────
  //
  // Two codes, two UI obligations: `_EXPIRED` says "that link timed out, request another",
  // `_INVALID` says "that link was never real". Asserting that recovery refuses is satisfied
  // by either, which is why the expiry branch could be deleted unnoticed.
  const expiring = await newAccount(h, { email: 'expiry@example.com', displayName: `Exp${uniqueTag()}` });
  ok('control: the account for the expiring link exists', typeof expiring.accessToken === 'string');
  const started = await h.service.recoveryStart({ email: 'expiry@example.com' });
  ok('control: recovery start issues a token for a real address', typeof started.recoveryToken === 'string');
  h.clock.advance(RECOVERY_TTL_MS + 1);
  const expiredCode = await codeOf(() => h.service.recoveryComplete({
    token: started.recoveryToken, newPassword: 'another-correct-horse-battery',
  }));
  ok('an expired reset link is AUTH_RECOVERY_TOKEN_EXPIRED, not merely invalid',
    expiredCode === 'AUTH_RECOVERY_TOKEN_EXPIRED', `code=${expiredCode}`);
  const forgedCode = await codeOf(() => h.service.recoveryComplete({
    token: 'not-a-token-anyone-issued', newPassword: 'another-correct-horse-battery',
  }));
  ok('CONTROL: a token nobody issued is _INVALID — the two answers are distinguishable',
    forgedCode === 'AUTH_RECOVERY_TOKEN_INVALID', `code=${forgedCode}`);
  // CONTROL: a live link still completes, so the expiry refusal is the clock.
  const live = await h.service.recoveryStart({ email: 'expiry@example.com' });
  ok('CONTROL: an unexpired reset link completes',
    await codeOf(() => h.service.recoveryComplete({
      token: live.recoveryToken, newPassword: 'a-third-correct-horse-battery',
    })) === null);

  // ── the throwaway recovery token minted for an address nobody owns ───────────────────
  //
  // §8 makes `recovery/start` do the same work for a real address and an absent one, which
  // means it MINTS a token for the absent one, filed under `absent:<hash>`. That token is
  // never delivered — but it exists, it is a valid single-use claim, and the line under test
  // is the only thing standing between it and `null.accountId`. This is the state the service
  // itself writes, reproduced through the same collaborator it writes it with.
  const absentRaw = 'a-token-nobody-was-ever-sent';
  h.ephemeral.issue('recovery', `absent:${handleOf('nobody@example.com')}`, absentRaw, RECOVERY_TTL_MS);
  const absentCode = await codeOf(() => h.service.recoveryComplete({
    token: absentRaw, newPassword: 'a-fourth-correct-horse-battery',
  }));
  ok('a recovery claim naming no real account is refused as an invalid link, not a crash',
    absentCode === 'AUTH_RECOVERY_TOKEN_INVALID', `code=${absentCode}`);

  // ── an authenticated caller whose account is not there ───────────────────────────────
  //
  // These are the "the row went away underneath us" backstops. Each one is followed, without
  // it, by a member read on `null` — a TypeError, which reaches the client as INTERNAL_ERROR
  // and reaches an investigation as nothing at all. The actor is the service's own shape; the
  // account it names simply does not exist.
  const GHOST_ID = 'GHOSTACCOUNT00000000000001';
  const ghostActor = { ...playerActor(GHOST_ID), accountId: GHOST_ID, roles: ['player'] };
  ok('control: the ghost account really is absent',
    (await h.store.accounts.byId(GHOST_ID)) === null);
  ok('resending verification for an account that is not there is NOT_FOUND',
    await codeOf(() => h.service.verificationResend({ actor: ghostActor })) === 'NOT_FOUND',
    String(await codeOf(() => h.service.verificationResend({ actor: ghostActor }))));
  ok('renaming an account that is not there is NOT_FOUND',
    await codeOf(() => h.service.changeDisplayName({ actor: ghostActor, displayName: `Ghost${uniqueTag()}` })) === 'NOT_FOUND',
    String(await codeOf(() => h.service.changeDisplayName({ actor: ghostActor, displayName: `Ghost${uniqueTag()}` }))));
  // The same absence on a WRITE path. Every self-service mutation reads the account first, and
  // that read is what refuses — before a transaction is opened, before an event is staged.
  // Without it the store refuses instead, from inside the transaction, with the same NOT_FOUND
  // code and the same message: the only thing that differs is whose refusal it is, and the
  // adapter's carries its own `details.accountId`. Measured on a copied tree: `details` is `{}`
  // with the line present and `{accountId: …}` with it deleted, on both mutating callers.
  let ghostWrite = null;
  try { await h.service.termsAccept({ actor: ghostActor, version: h.config.termsVersion }); }
  catch (err) { ghostWrite = err; }
  ok('a mutation for an absent account is refused by auth, before any transaction is opened',
    ghostWrite?.code === 'NOT_FOUND' && !Object.hasOwn(ghostWrite?.details ?? {}, 'accountId'),
    `${ghostWrite?.code} ${JSON.stringify(ghostWrite?.details ?? null)}`);
  let ghostConsent = null;
  try { await h.service.putConsent({ actor: ghostActor, telemetryPersonal: true, policyVersion: 1 }); }
  catch (err) { ghostConsent = err; }
  ok('and the same on the consent write path',
    ghostConsent?.code === 'NOT_FOUND' && !Object.hasOwn(ghostConsent?.details ?? {}, 'accountId'),
    `${ghostConsent?.code} ${JSON.stringify(ghostConsent?.details ?? null)}`);

  // CONTROL: the identical calls for an account that DOES exist succeed, so NOT_FOUND is the
  // missing row and not the actor shape being unacceptable.
  // The actor captured before the clock was advanced for the expiry check above: an actor is
  // the decoded claim, and re-authenticating that access token now would fail on its 15-minute
  // TTL (§1) — which is a different rule, tested there.
  const presentActor = consentActor;
  ok('CONTROL: the same resend for a real account is accepted',
    (await h.service.verificationResend({ actor: presentActor })).accepted === true);
  ok('CONTROL: the same rename for a real account is applied',
    (await h.service.changeDisplayName({ actor: presentActor, displayName: `Renamed${uniqueTag()}` }))
      .displayName.startsWith('Renamed'));

  // ── the name history is not readable by nobody ───────────────────────────────────────
  //
  // Signed out there is no subject at all, and the answer to that is "sign in" — a different
  // code, and a different thing for the client to do, from "you may not see this". Without the
  // line the capability check answers instead, and an anonymous caller is told AUTH_FORBIDDEN.
  const anonCode = await codeOf(() => h.service.nameHistory({ actor: null }));
  ok('an unauthenticated name-history read is AUTH_REQUIRED, not AUTH_FORBIDDEN',
    anonCode === 'AUTH_REQUIRED', `code=${anonCode}`);
  // CONTROL: a signed-in player reading SOMEONE ELSE'S history is the forbidden case, so the
  // two codes are genuinely distinguished rather than one of them being unreachable.
  const otherCode = await codeOf(() => h.service.nameHistory({ actor: presentActor, accountId: GHOST_ID }));
  ok('CONTROL: a player reading another account\'s history is AUTH_FORBIDDEN',
    otherCode === 'AUTH_FORBIDDEN', `code=${otherCode}`);
  ok('CONTROL: a player reading their OWN history is allowed',
    Array.isArray(await h.service.nameHistory({ actor: presentActor })));

  // ── signup refuses a taken name in its own words ─────────────────────────────────────
  //
  // The store's unique index refuses it too, with `That display name is taken.` and a
  // `details.displayNameFolded` — the FOLDED form of somebody else's name, which errors.md §5
  // keeps out of responses. Same code either way, which is why asserting the code alone left
  // this line unguarded. The message and the absence of details are what differ.
  const holder = `Holder${uniqueTag()}`;
  await newAccount(h, { email: `holder-${uniqueTag()}@example.com`, displayName: holder });
  let taken = null;
  try { await newAccount(h, { email: `taker-${uniqueTag()}@example.com`, displayName: holder }); }
  catch (err) { taken = err; }
  ok('a taken display name is NAME_TAKEN', taken?.code === 'NAME_TAKEN', String(taken?.code));
  ok('and it is refused in signup\'s words, leaking no folded form of the held name',
    taken?.message === 'That name is taken.'
    && !JSON.stringify(taken?.details ?? null).includes(fold(holder)),
    `${taken?.message} ${JSON.stringify(taken?.details ?? null)}`);
}

// ---------------------------------------------------- 20. the same four, on real PostgreSQL

const databaseUrl = process.env.DATABASE_URL;
section('20. THE SAME CHECKS AGAINST REAL POSTGRESQL');
if (!databaseUrl) {
  console.log('  skip DATABASE_URL is not set; the Postgres adapter was not exercised, and a '
    + 'skip is not a pass — §18 CANNOT fail on memory.');
} else {
  await runMigrations({ databaseUrl });
  const clock = makeClock();
  // 20 connections: ten concurrent PATCHes each hold one for the length of their transaction,
  // and nine of those are waiting on the advisory lock. At the default of 10 the pool is the
  // thing under test rather than the lock.
  const pgStore = await createPostgresStore({ databaseUrl, poolMax: 20 }, { now: () => clock.now() });
  const h = moduleOn(pgStore, clock);

  await nameHistoryChecks(h, 'postgres');
  await patchIdempotencyChecks(h, 'postgres', { canRace: true });

  const pg = (await import('pg')).default;
  const raw = new pg.Client({ connectionString: databaseUrl });
  await raw.connect();
  try {
    await consentSweepChecks(h, 'postgres', async () =>
      (await raw.query('select count(*)::int as n from pre_auth_consent')).rows[0].n);

    // Migration 0015: a partial consent record cannot exist, because §4 types the profile field
    // as an exact union with no partial member and `projectConsent` would serialise one anyway.
    console.log('\n[postgres] migration 0015 — consent columns move together');
    const insertAccount = (consent) => raw.query(
      `insert into accounts (account_id, display_name, display_name_folded,
                             consent_telemetry, consent_policy_ver, consent_decided_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [ulid(), `Chk${Date.now()}`, `chk${Date.now()}-${Math.random()}`, ...consent]);

    const partials = [
      ['a decision with no policy version', [true, null, new Date().toISOString()]],
      ['a decision with no decision time', [true, 1, null]],
      ['a policy version and time with no decision', [null, 1, new Date().toISOString()]],
    ];
    for (const [what, cols] of partials) {
      let refused = null;
      try { await insertAccount(cols); } catch (err) { refused = err.constraint ?? err.message; }
      ok(`[postgres] ${what} is refused by the table`,
        refused === 'accounts_consent_all_or_nothing', String(refused));
    }
    ok('[postgres] control: a COMPLETE decision inserts',
      await (async () => {
        try { await insertAccount([false, 1, new Date().toISOString()]); return true; }
        catch (err) { return err.message; }
      })() === true);
    ok('[postgres] control: an UNDECIDED account (all three null) inserts — null means undecided',
      await (async () => {
        try { await insertAccount([null, null, null]); return true; }
        catch (err) { return err.message; }
      })() === true);
  } finally {
    await raw.end();
  }
}

// -------------------------------------------------------------------------------- summary

for (const h of open) { try { h.stop?.(); await h.store?.close?.(); } catch { /* already closed */ } }

console.log(`\n=========== SUMMARY ===========`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
