/**
 * AUTH — the verification suite required by contracts/auth.md §12.
 *
 * Every claim here is paired with a **failing control**: an assertion that the check would
 * have caught the opposite outcome. A test that only ever sees the good path proves that the
 * good path exists, not that the bad path is closed — which is exactly how this repository
 * previously kept a green suite across six broken-multiplayer faults.
 *
 * The store is faked in this file and only in this file. The real adapter is another agent's
 * work; what auth needs from it is the documented interface in core/store.js, so the fake
 * implements that interface and nothing more. Every method is async, so awaits inside the
 * service are real interleaving points and the concurrency test is not testing a straight line.
 *
 *   node platform/test/authtest.mjs
 */
import { loadConfig } from '../src/core/config.js';
import { ulid } from '../src/core/ids.js';
import { createAuthModule } from '../src/modules/auth/index.js';
import { fold } from '../src/modules/auth/names.js';
import { RECOVERY_FLOOR_MS } from '../src/modules/auth/service.js';
import { sign } from '../src/modules/auth/crypto.js';

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
const decode = (token) => JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8'));

// ------------------------------------------------------------------------- fake store

function createFakeStore() {
  const accounts = new Map();
  const emailIndex = new Map();
  const nameIndex = new Map();
  const sessions = new Map();
  const refreshTokens = new Map();
  const preAuth = new Map();
  const outbox = [];
  const audit = [];
  const clone = (r) => (r ? JSON.parse(JSON.stringify(r)) : null);

  return {
    // No rollback: these tests never exercise a failed transaction, and a fake that pretends
    // to roll back would be asserting something about the real adapter that it cannot know.
    async tx(fn) { return fn({ fake: true }); },

    accounts: {
      async create(row) {
        accounts.set(row.accountId, clone(row));
        emailIndex.set(row.emailHash, row.accountId);
        nameIndex.set(row.displayNameFolded, row.accountId);
        return clone(row);
      },
      async byId(id) { return clone(accounts.get(id)); },
      async byEmailHash(h) { return clone(accounts.get(emailIndex.get(h))); },
      async byNameFolded(f) { return clone(accounts.get(nameIndex.get(f))); },
      async update(id, patch) {
        const row = accounts.get(id);
        if (!row) throw new Error(`fake store: no account ${id}`);
        if (patch.displayNameFolded && patch.displayNameFolded !== row.displayNameFolded) {
          nameIndex.delete(row.displayNameFolded);
          nameIndex.set(patch.displayNameFolded, id);
        }
        Object.assign(row, patch);
        return clone(row);
      },
    },

    sessions: {
      async create(row) { sessions.set(row.sessionId, clone(row)); return clone(row); },
      async byId(id) { return clone(sessions.get(id)); },
      async listForAccount(accountId) {
        return [...sessions.values()].filter((s) => s.accountId === accountId).map(clone);
      },
      async revoke(id, reason, at) {
        const s = sessions.get(id);
        if (s && !s.revokedAt) { s.revokedAt = at; s.revokedReason = reason; }
      },
      async revokeAllForAccount(accountId, reason, at) {
        let n = 0;
        for (const s of sessions.values()) {
          if (s.accountId === accountId && !s.revokedAt) { s.revokedAt = at; s.revokedReason = reason; n++; }
        }
        return n;
      },
      async revokeFamily(familyId, reason, at) {
        let n = 0;
        for (const s of sessions.values()) {
          if (s.refreshFamilyId === familyId && !s.revokedAt) { s.revokedAt = at; s.revokedReason = reason; n++; }
        }
        return n;
      },
      async touch(id, at) { const s = sessions.get(id); if (s) s.lastSeenAt = at; },
    },

    refreshTokens: {
      async create(row) { refreshTokens.set(row.tokenId, clone(row)); return clone(row); },
      async byId(id) { return clone(refreshTokens.get(id)); },
      async markUsed(id, at) { const r = refreshTokens.get(id); if (r) r.usedAt = at; },
    },

    preAuthConsent: {
      async put(row) { preAuth.set(row.clientSessionId, clone(row)); return clone(row); },
      async get(id) { return clone(preAuth.get(id)); },
      async markMigrated(id, at) { const r = preAuth.get(id); if (r) r.migratedAt = at; },
    },

    outbox: {
      async insert(event) { outbox.push(clone(event)); return event; },
      async claimUnpublished() { return []; },
      async markPublished() {},
      async recordFailure() {},
      async deadLetter() {},
    },

    audit: { async insert(row) { audit.push(clone(row)); return row; }, async list() { return audit.map(clone); } },
    profiles: { async upsert() { return {}; }, async byAccountId() { return null; } },
    stats: { async get() { return null; }, async applyDelta() { return {}; }, async listForAccount() { return []; } },
    weaponStats: { async applyDelta() { return {}; }, async listForAccount() { return []; } },
    idempotency: { async get() { return null; }, async put(row) { return row; } },
    flags: { async all() { return []; }, async get() { return null; }, async set(k, v) { return v; } },
    async health() { return { ok: true }; },
    async close() {},

    // Test introspection. `dump` is every byte the store holds, which is what the "the
    // birthdate is never persisted" check searches.
    events: outbox,
    dump: () => JSON.stringify({ accounts: [...accounts.values()], sessions: [...sessions.values()],
      refreshTokens: [...refreshTokens.values()], preAuth: [...preAuth.values()], outbox, audit }),
  };
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLogger; } };

const T0 = Date.parse('2026-08-19T12:00:00.000Z');

function mk({ now = T0, env = {} } = {}) {
  let t = now;
  const clock = { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
  const config = loadConfig({ PLATFORM_TOKEN_SECRET: 'test-secret-not-a-real-one', ...env });
  const store = createFakeStore();
  const auth = createAuthModule({ store, config, logger: silentLogger, clock, sleep: realSleep });
  return { store, clock, config, ...auth };
}

const DOB = '1994-03-02';
const PASSWORD = 'correct-horse-battery-staple';

/** The whole approved chain: eligibility → consent → signup. */
async function newAccount(h, { email, displayName, telemetryPersonal = true, ip = '203.0.113.9' } = {}) {
  // Past the §9 auth window, so a test that creates many accounts is measuring the rule it
  // came to measure rather than re-measuring the rate limiter (which §12 covers on its own).
  h.clock.advance(61_000);
  const eligibility = h.service.eligibilityPreflight({ dateOfBirth: DOB, jurisdiction: 'CA-ON' });
  const clientSessionId = ulid(h.clock.now());
  const consent = await h.service.putConsent({ telemetryPersonal, policyVersion: 1, clientSessionId });
  const issued = await h.service.signup({
    email, password: PASSWORD, displayName,
    eligibilityReceipt: eligibility.receipt, clientSessionId, consentReceipt: consent.receipt,
    ip, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0',
  });
  return { ...issued, clientSessionId, eligibility, consent };
}

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

section('2. REFRESH ROTATES; A REPLAY REVOKES THE FAMILY');
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

  const session = await h.store.sessions.byId(a.session.sessionId);
  ok('the whole family is revoked', session.revokedAt !== null && session.revokedReason === 'refresh-reuse');
  ok('session.reuse_detected was emitted',
    h.store.events.some((e) => e.type === 'session.reuse_detected'));

  const emitted = h.store.events.find((e) => e.type === 'session.reuse_detected');
  ok('the event is audit-retained and personal-class',
    emitted?.retentionClass === 'audit' && emitted?.privacyClass === 'personal');
  ok('the successor token is dead too',
    await codeOf(() => h.sessions.rotate(r2.refreshToken)) === 'AUTH_SESSION_REVOKED');
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
    h.store.events.filter((e) => e.type === 'session.reuse_detected').length === losses.length);

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
    h2.store.events.filter((e) => e.type === 'session.reuse_detected').length === 0);
}

// ------------------------------------------------------- 4. revocation on the next request

section('4. REVOCATION TAKES EFFECT ON THE VERY NEXT REQUEST');
{
  const h = mk();
  const a = await newAccount(h, { email: 'rev@example.com', displayName: 'RevFour' });

  // Control: the identical token, on the identical call, one line earlier.
  ok('control: authenticated before revocation',
    await codeOf(() => h.sessions.authenticate(a.accessToken)) === null);

  await h.sessions.revoke({ accountId: a.profile.accountId, sessionId: a.session.sessionId });

  const after = await codeOf(() => h.sessions.authenticate(a.accessToken));
  ok('rejected immediately after revocation', after === 'AUTH_SESSION_REVOKED', `code=${after}`);
  ok('the token itself is still cryptographically valid — the denylist is doing the work',
    await codeOf(() => h.sessions.verifyAccessToken(a.accessToken)) === null);
  ok('the refresh token dies with the session',
    await codeOf(() => h.sessions.rotate(a.refreshToken)) === 'AUTH_SESSION_REVOKED');

  // signout-all, and the session list that must never carry a raw address.
  const h2 = mk();
  const b = await newAccount(h2, { email: 'multi@example.com', displayName: 'MultiFour', ip: '198.51.100.7' });
  await h2.service.signin({ email: 'multi@example.com', password: PASSWORD, ip: '198.51.100.7' });
  const list = await h2.sessions.list(b.profile.accountId, b.session.sessionId);
  ok('control: two live sessions listed', list.length === 2, `${list.length} sessions`);
  ok('the caller\'s session is flagged current', list.filter((s) => s.isCurrent).length === 1);
  ok('the list carries an IP class, never the address',
    list.every((s) => s.ipClass && !JSON.stringify(s).includes('198.51.100.7')),
    `ipClass=${list[0].ipClass}`);
  await h2.sessions.revokeAll({ accountId: b.profile.accountId });
  ok('signout-all revokes the caller too',
    await codeOf(() => h2.sessions.authenticate(b.accessToken)) === 'AUTH_SESSION_REVOKED');
  ok('the list is empty afterwards',
    (await h2.sessions.list(b.profile.accountId, b.session.sessionId)).length === 0);
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
  // The earlier version of this line did exactly that and passed ~19 runs in 20.
  const flipped = `${body}.${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
  ok('a one-character signature change is rejected',
    await codeOf(() => h.sessions.verifyAccessToken(flipped)) === 'AUTH_TOKEN_INVALID');

  const foreign = sign('some-other-secret', { k: 'access', sub: a.profile.accountId,
    sid: a.session.sessionId, r: ['superadmin'], iat: T0, exp: T0 + 10 ** 9 });
  ok('a token signed with another key is rejected',
    await codeOf(() => h.sessions.verifyAccessToken(foreign)) === 'AUTH_TOKEN_INVALID');

  const unsigned = `${body}.`;
  ok('an unsigned token is rejected',
    await codeOf(() => h.sessions.verifyAccessToken(unsigned)) === 'AUTH_TOKEN_INVALID');

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
  const h = mk({ env: { PLATFORM_ACCESS_TTL: '900' } });
  await newAccount(h, { email: 'known@example.com', displayName: 'KnownSix', ip: '203.0.113.11' });

  const knownBody = await h.service.recoveryStart({ email: 'known@example.com', ip: null });
  const unknownBody = await h.service.recoveryStart({ email: 'nobody@example.com', ip: null });
  // What the endpoint returns to the client is the 202 envelope; the service hands the token
  // back to its caller (the mailer) and never to the response.
  ok('both are accepted', knownBody.accepted === true && unknownBody.accepted === true);
  ok('the client-visible outcome is identical',
    JSON.stringify({ accepted: knownBody.accepted }) === JSON.stringify({ accepted: unknownBody.accepted }));

  const median = (xs) => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)];
  const SAMPLES = 15;
  const TOLERANCE_MS = 10;
  const timeIt = async (fn) => {
    const started = process.hrtime.bigint();
    await fn();
    return Number(process.hrtime.bigint() - started) / 1e6;
  };

  const known = [];
  const unknown = [];
  for (let i = 0; i < SAMPLES; i++) {
    // The auth rate limit (§9) is 5/min per subject and would otherwise cut the run short.
    // Sliding the fake clock past the window isolates the timing property under test; the
    // measurement itself is wall-clock and unaffected by it.
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
  const leakGap = Math.abs(median(leakKnown) - median(leakUnknown));
  ok('control: the detector flags a leaky implementation', leakGap > TOLERANCE_MS,
    `leaky gap=${leakGap.toFixed(1)}ms`);

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
  const dump = h.store.dump();
  ok('the birthdate is nowhere in the store after a full signup', !dump.includes(DOB));
  ok('nor is the birth year', !dump.includes('1994-'));

  // Control: the scanner must be able to find a birthdate that IS present, or "not found"
  // means nothing.
  const decoy = createFakeStore();
  await decoy.preAuthConsent.put({ clientSessionId: 'decoy', telemetryPersonal: true,
    policyVersion: 1, decidedAt: DOB, expiresAt: DOB, migratedAt: null });
  ok('control: the scanner finds a birthdate when one is stored', decoy.dump().includes(DOB));

  // The verdict, its policy version, and the decision time ARE persisted — that is the record.
  const account = await h.store.accounts.byEmailHash(
    (await h.store.accounts.byNameFolded(fold('DobSeven'))).emailHash);
  ok('the derived verdict is persisted', account.eligibilityVerdict === true && account.eligibilityPolicyVer === 1);

  const denied = await codeOf(() => h.service.eligibilityPreflight({ dateOfBirth: '2020-01-01' }));
  ok('an under-age date is denied', denied === 'AUTH_ELIGIBILITY_DENIED');
  try { h.service.eligibilityPreflight({ dateOfBirth: '2020-01-01' }); }
  catch (err) {
    ok('the denial gives a category and nothing else',
      JSON.stringify(err.details) === JSON.stringify({ category: 'under-minimum-age' }),
      JSON.stringify(err.details));
    ok('the denial does not echo the date or the threshold',
      !JSON.stringify(err.details).includes('2020') && !JSON.stringify(err.details).includes('13'));
  }
}

// ------------------------------------------------- 8. signup requires a valid eligibility receipt

section('8. SIGNUP WITHOUT A VALID ELIGIBILITY RECEIPT FAILS');
{
  const h = mk();
  const attempt = async (eligibilityReceipt, email, displayName) => {
    h.clock.advance(61_000);          // see `newAccount` — §12 owns the rate-limit assertions
    const clientSessionId = ulid(h.clock.now());
    const consent = await h.service.putConsent({ telemetryPersonal: false, policyVersion: 1, clientSessionId });
    return h.service.signup({
      email, password: PASSWORD, displayName, eligibilityReceipt,
      clientSessionId, consentReceipt: consent.receipt,
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

  // Control: a fresh, honest receipt gets through. Without this the six refusals above would
  // also pass for a signup endpoint that rejects everything.
  const good = h.service.eligibilityPreflight({ dateOfBirth: DOB });
  ok('control: a valid receipt is accepted',
    await codeOf(() => attempt(good.receipt, 'g@example.com', 'GateG')) === null);

  // The other two required fields of REQ-CC-034.
  const el = h.service.eligibilityPreflight({ dateOfBirth: DOB });
  ok('signup without a clientSessionId is refused',
    await codeOf(() => h.service.signup({ email: 'h@example.com', password: PASSWORD, displayName: 'GateH',
      eligibilityReceipt: el.receipt, consentReceipt: 'x.y' })) === 'VALIDATION_FAILED');
  ok('signup without a consentReceipt is refused',
    await codeOf(() => h.service.signup({ email: 'i@example.com', password: PASSWORD, displayName: 'GateI',
      eligibilityReceipt: el.receipt, clientSessionId: ulid(h.clock.now()) })) === 'VALIDATION_FAILED');

  const otherSession = ulid(h.clock.now());
  const mismatched = await h.service.putConsent({ telemetryPersonal: true, policyVersion: 1, clientSessionId: otherSession });
  ok('a consent receipt for a different client session is refused',
    await codeOf(() => h.service.signup({ email: 'j@example.com', password: PASSWORD, displayName: 'GateJ',
      eligibilityReceipt: el.receipt, clientSessionId: ulid(h.clock.now()),
      consentReceipt: mismatched.receipt })) === 'VALIDATION_FAILED');
}

// -------------------------------------------------------------- 9. consent migrates at signup

section('9. CONSENT MIGRATES FROM CLIENT SESSION TO ACCOUNT AT SIGNUP');
{
  const h = mk();
  const clientSessionId = ulid(h.clock.now());
  const preAuth = await h.service.putConsent({ telemetryPersonal: true, policyVersion: 1, clientSessionId });

  ok('the signed-out decision is keyed to the client session', preAuth.subject === 'client-session');
  ok('control: the pre-auth receipt names the client session',
    decode(preAuth.receipt).s === 'client-session' && decode(preAuth.receipt).sid === clientSessionId);
  ok('control: the row exists before signup',
    (await h.store.preAuthConsent.get(clientSessionId))?.migratedAt === null);

  const eligibility = h.service.eligibilityPreflight({ dateOfBirth: DOB });
  const issued = await h.service.signup({
    email: 'migrate@example.com', password: PASSWORD, displayName: 'MigrateNine',
    eligibilityReceipt: eligibility.receipt, clientSessionId, consentReceipt: preAuth.receipt,
  });

  const account = await h.store.accounts.byId(issued.profile.accountId);
  ok('the decision landed on the account',
    account.consentTelemetry === true && account.consentPolicyVer === 1);
  ok('the decision time carried over', account.consentDecidedAt === preAuth.decidedAt);
  ok('the pre-auth row is marked migrated',
    (await h.store.preAuthConsent.get(clientSessionId)).migratedAt !== null);

  const fresh = decode(issued.consentReceipt);
  ok('signup returns a fresh account-scoped receipt',
    fresh.s === 'account' && fresh.sid === issued.profile.accountId);
  ok('the account receipt is not the session receipt', issued.consentReceipt !== preAuth.receipt);
  ok('the profile exposes consent as an object, never absent',
    issued.profile.consent?.telemetryPersonal === true);

  const back = await h.service.signin({ email: 'migrate@example.com', password: PASSWORD });
  ok('signin returns the account-scoped receipt too',
    decode(back.consentReceipt).s === 'account' && decode(back.consentReceipt).sid === issued.profile.accountId);

  // Control: an account with no decision recorded reports null rather than a fabricated "no".
  const undecided = await h.store.accounts.update(issued.profile.accountId,
    { consentTelemetry: null, consentPolicyVer: null, consentDecidedAt: null });
  const again = await h.service.signin({ email: 'migrate@example.com', password: PASSWORD });
  ok('control: undecided consent yields a null receipt, not a false one',
    again.consentReceipt === null && again.profile.consent === null, `status=${undecided.status}`);

  // A signed-out GET after migration must not keep serving the migrated decision.
  const afterMigration = await h.service.getConsent({ clientSessionId });
  ok('the migrated client session no longer answers as consented',
    afterMigration.telemetryPersonal === null && afterMigration.receipt === null);
}

// ------------------------------------------ 10. verification uses its own codes, not recovery

section('10. VERIFICATION FAILURES USE THE VERIFICATION CODES');
{
  const RECOVERY_CODES = new Set(['AUTH_RECOVERY_TOKEN_INVALID', 'AUTH_RECOVERY_TOKEN_EXPIRED']);
  const h = mk();
  const a = await newAccount(h, { email: 'verify@example.com', displayName: 'VerifyTen' });
  const actor = { accountId: a.profile.accountId, sessionId: a.session.sessionId, roles: ['player'] };

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
  const recoveryBad = await codeOf(() => h.service.recoveryComplete({ token: 'not-a-token', newPassword: PASSWORD }));
  ok('control: recovery still answers with its own code', recoveryBad === 'AUTH_RECOVERY_TOKEN_INVALID', `code=${recoveryBad}`);

  // Control: a good verification token completes, so the two failures above are not the only
  // outcome the endpoint has.
  const fresh = await h.service.verificationResend({ actor });
  ok('control: a valid verification token completes',
    await codeOf(() => h.service.verificationComplete({ actor, token: fresh.verificationToken })) === null);
  ok('the account is marked verified',
    (await h.store.accounts.byId(actor.accountId)).emailVerifiedAt !== null);
  ok('the verification token is single-use',
    await codeOf(() => h.service.verificationComplete({ actor, token: fresh.verificationToken }))
      === 'AUTH_VERIFICATION_TOKEN_INVALID');

  // Terms, the last link in the chain, with its own conflict shape.
  ok('control: the current terms version is accepted',
    await codeOf(() => h.service.termsAccept({ actor, version: h.config.termsVersion })) === null);
  ok('a stale terms version is a CONFLICT',
    await codeOf(() => h.service.termsAccept({ actor, version: h.config.termsVersion - 1 })) === 'CONFLICT');
}

// ------------------------------------------------------- 11. confusable display names collide

section('11. CONFUSABLE DISPLAY NAMES COLLIDE');
{
  const h = mk();
  await newAccount(h, { email: 'ada@example.com', displayName: 'Ada' });

  // Control: an unrelated name is free, so NAME_TAKEN below is about the fold and not about
  // signup refusing every second account.
  ok('control: a distinct name is accepted',
    await codeOf(() => newAccount(h, { email: 'bela@example.com', displayName: 'Bela' })) === null);

  const cyrillic = 'Аdа';               // U+0410, U+0430
  ok('control: the two names are genuinely different strings', cyrillic !== 'Ada');
  ok('a Cyrillic homoglyph collides',
    await codeOf(() => newAccount(h, { email: 'homo@example.com', displayName: cyrillic })) === 'NAME_TAKEN');
  ok('case alone collides',
    await codeOf(() => newAccount(h, { email: 'case@example.com', displayName: 'ada' })) === 'NAME_TAKEN');
  ok('a Greek homoglyph collides',
    await codeOf(() => newAccount(h, { email: 'greek@example.com', displayName: 'Αdα' })) === 'NAME_TAKEN');
  ok('a full-width form collides (NFKC)',
    await codeOf(() => newAccount(h, { email: 'wide@example.com', displayName: 'Ａｄａ' })) === 'NAME_TAKEN');

  ok('the fold agrees with the collisions',
    fold('Ada') === fold(cyrillic) && fold('Ada') === fold('Ａｄａ'), fold(cyrillic));
  ok('control: the fold does not collapse unrelated names', fold('Ada') !== fold('Bela'));

  ok('reserved names are refused',
    await codeOf(() => newAccount(h, { email: 'adm@example.com', displayName: 'admin' })) === 'NAME_POLICY_VIOLATION');
  ok('reserved names are refused through separators and digits',
    await codeOf(() => newAccount(h, { email: 'adm2@example.com', displayName: 'Adm1n' })) === 'NAME_POLICY_VIOLATION');
  ok('too short is refused',
    await codeOf(() => newAccount(h, { email: 'sh@example.com', displayName: 'ab' })) === 'NAME_POLICY_VIOLATION');
  ok('too long is refused',
    await codeOf(() => newAccount(h, { email: 'lo@example.com', displayName: 'a'.repeat(17) })) === 'NAME_POLICY_VIOLATION');
  ok('a double interior space is refused',
    await codeOf(() => newAccount(h, { email: 'sp@example.com', displayName: 'Ada  B' })) === 'NAME_POLICY_VIOLATION');

  // 30-day cooldown.
  const h2 = mk();
  const c = await newAccount(h2, { email: 'rename@example.com', displayName: 'FirstName' });
  const actor = { accountId: c.profile.accountId };
  ok('control: the first change is allowed',
    await codeOf(() => h2.service.changeDisplayName({ actor, displayName: 'SecondName' })) === null);
  ok('a second change inside 30 days is refused',
    await codeOf(() => h2.service.changeDisplayName({ actor, displayName: 'ThirdName' })) === 'NAME_CHANGE_COOLDOWN');
  h2.clock.advance(30 * 24 * 3600 * 1000);
  ok('control: allowed again after 30 days',
    await codeOf(() => h2.service.changeDisplayName({ actor, displayName: 'ThirdName' })) === null);
  ok('account.name_changed is emitted',
    h2.store.events.filter((e) => e.type === 'account.name_changed').length === 2);
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
}

// -------------------------------------------------------------------------------- summary

console.log(`\n=========== SUMMARY ===========`);
console.log(`  ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
