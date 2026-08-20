/**
 * The auth service.  contracts/auth.md, contracts/http-api.md §3, §3a, §11.8.
 *
 * Pure functions over `deps` — store, config, clock, logger — with no route, request, or
 * response object anywhere in the file. The handlers in `routes.js` translate HTTP into these
 * calls and back; everything that has to be true about identity is decided here, where it can
 * be tested without a socket.
 *
 * The onboarding chain is implemented in the approved order and enforces it:
 *   landing → eligibility → consent → signup → verify → terms.
 * Eligibility precedes consent so consent is never solicited from a visitor who cannot validly
 * give it, and signup refuses to run without the receipts from both.
 */
import { ApiError } from '../../core/errors.js';
import { ulid } from '../../core/ids.js';
import { requireCapability } from '../events/rbac.js';
import { emailHash, hashPassword, verifyPassword, opaqueToken } from './crypto.js';
import { normaliseDisplayName, assertCooldown } from './names.js';
import { playerActor, correlationFor } from './events.js';
import { internalise } from './faults.js';

export const RECOVERY_TTL_MS = 30 * 60 * 1000;
export const VERIFICATION_TTL_MS = 24 * 3600 * 1000;
export const PRE_AUTH_CONSENT_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * The floor `recovery/start` pads every response to.
 *
 * §8 requires the endpoint to be indistinguishable for existing and non-existent accounts,
 * and REQ item 7 says *including in response timing*. Doing the same amount of work on both
 * paths is not enough on its own — the branches diverge in allocation, logging, and whatever
 * the mailer does next — so the response is also held to a fixed budget. 40 ms is far above
 * the real work and far below anything a player notices on a form they just submitted.
 */
export const RECOVERY_FLOOR_MS = 40;

/** A real hash to verify against when the account does not exist — see `signin`. */
const DUMMY_PASSWORD_HASH = hashPassword(opaqueToken());

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseDateOfBirth(value) {
  const invalid = () => new ApiError('VALIDATION_FAILED', 'Enter a valid date of birth.', {
    details: { fields: [{ path: 'dateOfBirth', rule: 'date', message: 'Use YYYY-MM-DD.' }] },
  });
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid();
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw invalid();
  return { y, m, d };
}

/** Whole years, UTC, birthday-inclusive. */
function ageAt({ y, m, d }, nowMs) {
  const now = new Date(nowMs);
  let age = now.getUTCFullYear() - y;
  const monthDiff = (now.getUTCMonth() + 1) - m;
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < d)) age -= 1;
  return age;
}

function requireString(value, path, { min = 1, max = 320 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new ApiError('VALIDATION_FAILED', 'That request is missing something.', {
      details: { fields: [{ path, rule: 'required', message: 'Required.' }] },
    });
  }
  return value;
}

export function createAuthService(deps) {
  const {
    store, config, clock, logger, sessions, receipts, ephemeral, limiter, outbox, audit,
    sleep = defaultSleep, mailer = null,
  } = deps;
  if (!outbox || !audit) throw new Error('auth/service: an outbox and an audit log are required');
  const iso = (ms) => new Date(ms).toISOString();

  /**
   * The projection signup and signin return.
   *
   * The full `GET /v1/profile/me` body is the profile module's contract; this is the identity
   * half of it, which is all auth is entitled to assert. Consent is object-or-null and never
   * absent — `null` means undecided, which is not the same as a recorded "no".
   */
  function projectProfile(account) {
    return {
      accountId: account.accountId,
      displayName: account.displayName,
      status: account.status,
      roles: account.roles ?? ['player'],
      createdAt: account.createdAt,
      emailVerifiedAt: account.emailVerifiedAt ?? null,
      termsVersionAccepted: account.termsVersionAccepted ?? null,
      eligibility: account.eligibilityVerdict == null ? null : {
        verdict: account.eligibilityVerdict,
        policyVersion: account.eligibilityPolicyVer,
        decidedAt: account.eligibilityDecidedAt,
      },
      consent: account.consentTelemetry == null ? null : {
        telemetryPersonal: account.consentTelemetry,
        policyVersion: account.consentPolicyVer,
        decidedAt: account.consentDecidedAt,
      },
      privacy: account.privacy ?? {},
    };
  }

  /**
   * The shape every self-service account mutation takes: capability already asserted by the
   * caller, then the row, its `profile.updated` event and its audit row in ONE transaction.
   *
   * §10 requires every privileged action to be audited, and auth's mutating paths wrote no
   * audit row at all — six state changes a support investigation could not see. The event type
   * is `profile.updated` because that is what the catalogue registers for a change to the
   * account projection; auth may not invent a type (event-envelope.md §6).
   */
  async function updateAccountWithEvent(actor, patch, { action, capability = 'account:update', reasonCode, correlationId, summaryKeys, spec }) {
    const before = await store.accounts.byId(actor.accountId);
    if (!before) throw new ApiError('NOT_FOUND', 'No such account.');
    const { result } = await internalise(() => audit.recordWithEvent(
      outbox,
      { correlationId: correlationFor(correlationId, clock.now()), actor },
      (updated) => ({
        action,
        capability,
        subject: { kind: 'account', id: actor.accountId },
        target: { accountId: actor.accountId },
        reasonCode,
        before, after: updated, summaryKeys,
      }),
      spec,
      (tx) => store.accounts.update(actor.accountId, patch, tx),
    ));
    return result;
  }

  /** The common case: a field on the account changed, which is `profile.updated` (§6). */
  const updateAccount = (actor, action, patch, opts) => updateAccountWithEvent(actor, patch, {
    ...opts,
    action,
    spec: {
      type: 'profile.updated',
      actor: playerActor(actor.accountId, actor.roles),
      subject: { kind: 'account', id: actor.accountId },
      payload: { fields: Object.keys(patch) },
      occurredAt: iso(clock.now()),
    },
  });

  const accountConsentReceipt = (account) =>
    (account.consentTelemetry == null ? null : receipts.issueConsent({
      subject: 'account',
      subjectId: account.accountId,
      telemetryPersonal: account.consentTelemetry,
      policyVersion: account.consentPolicyVer,
      decidedAt: account.consentDecidedAt,
    }));

  // ---------------------------------------------------------------- onboarding: eligibility

  /**
   * Step 2 of the chain. Evaluates a birthdate and throws it away.
   *
   * Two things this must not do, both of which the earlier draft did:
   *   - return `minimumAge`. A gate that publishes the number it tests against is cleared on
   *     the next attempt by anyone who reads a JSON response, which is everyone.
   *   - persist the date. `db-schema.md` §2 has no column for it on purpose; the verdict, its
   *     policy version, and the decision time are the entire record, and they are written at
   *     signup, not here.
   */
  function eligibilityPreflight({ dateOfBirth, jurisdiction = null, ip = null }) {
    // §9 auth class. The endpoint mints a signed credential that signup accepts, so leaving it
    // unlimited meant receipts were free to farm — and it is also a birthdate oracle, since an
    // unlimited caller can binary-search the minimum age the response refuses to state.
    limiter.enforceAuth({ ip, subject: null });
    const dob = parseDateOfBirth(dateOfBirth);
    const age = ageAt(dob, clock.now());
    if (age < config.minimumAge) {
      // `details.category` only — never the date, never the computed age, never the threshold.
      throw new ApiError('AUTH_ELIGIBILITY_DENIED', 'You are not eligible for an account.',
        { details: { category: 'under-minimum-age' } });
    }
    const { receipt, expiresAt, policyVersion } = receipts.issueEligibility({ verdict: true, jurisdiction });
    // `dob` and `age` go out of scope here and are never handed to the store.
    return { eligible: true, receipt, expiresAt, policyVersion };
  }

  // ------------------------------------------------------------------- onboarding: consent

  /** Auth-optional. Signed in, the account is the subject; signed out, the client session is. */
  async function getConsent({ actor = null, clientSessionId = null }) {
    if (actor) {
      const account = await store.accounts.byId(actor.accountId);
      if (!account) throw new ApiError('NOT_FOUND', 'No such account.');
      if (account.consentTelemetry == null) {
        return { telemetryPersonal: null, policyVersion: null, decidedAt: null, subject: 'account', receipt: null };
      }
      return {
        telemetryPersonal: account.consentTelemetry,
        policyVersion: account.consentPolicyVer,
        decidedAt: account.consentDecidedAt,
        subject: 'account',
        receipt: accountConsentReceipt(account),
      };
    }
    requireString(clientSessionId, 'clientSessionId');
    const row = await store.preAuthConsent.get(clientSessionId);
    if (!row || row.migratedAt) {
      return { telemetryPersonal: null, policyVersion: null, decidedAt: null, subject: 'client-session', receipt: null };
    }
    return {
      telemetryPersonal: row.telemetryPersonal,
      policyVersion: row.policyVersion,
      decidedAt: row.decidedAt,
      subject: 'client-session',
      receipt: receipts.issueConsent({
        subject: 'client-session', subjectId: clientSessionId,
        telemetryPersonal: row.telemetryPersonal, policyVersion: row.policyVersion, decidedAt: row.decidedAt,
      }),
    };
  }

  async function putConsent({ actor = null, telemetryPersonal, policyVersion, clientSessionId = null, ip = null, correlationId = null }) {
    limiter.enforceAuth({ ip, subject: actor?.accountId ?? clientSessionId ?? null });
    if (typeof telemetryPersonal !== 'boolean') {
      throw new ApiError('VALIDATION_FAILED', 'A consent decision is required.', {
        details: { fields: [{ path: 'telemetryPersonal', rule: 'boolean', message: 'true or false.' }] },
      });
    }
    // The policy version is the server's, never the caller's. It was accepted from the request
    // and stored verbatim, so `policyVersion: 999999` recorded agreement to a policy that does
    // not exist — and the next real policy version would then look already-agreed.
    const version = policyVersion === undefined || policyVersion === null
      ? config.consentPolicyVersion : policyVersion;
    if (version !== config.consentPolicyVersion) {
      throw new ApiError('VALIDATION_FAILED', 'That consent policy version is not the current one.', {
        details: {
          fields: [{ path: 'policyVersion', rule: 'enum', message: 'Not the current policy version.' }],
          currentVersion: config.consentPolicyVersion,
        },
      });
    }
    const decidedAt = iso(clock.now());

    if (actor) {
      // `clientSessionId` is ignored when authenticated: the account is the stronger subject
      // and letting a request name a different one would be an assignment primitive.
      requireCapability(actor, 'account:update', { accountId: actor.accountId });
      const account = await updateAccount(actor, 'account.consent_set', {
        consentTelemetry: telemetryPersonal, consentPolicyVer: version, consentDecidedAt: decidedAt,
      }, {
        summaryKeys: ['consentTelemetry', 'consentPolicyVer'],
        reasonCode: 'account_self_service',
        correlationId,
      });
      return {
        telemetryPersonal, policyVersion: version, decidedAt, subject: 'account',
        receipt: accountConsentReceipt({ ...account, consentTelemetry: telemetryPersonal, consentPolicyVer: version, consentDecidedAt: decidedAt }),
      };
    }

    requireString(clientSessionId, 'clientSessionId');
    await store.preAuthConsent.put({
      clientSessionId,
      telemetryPersonal,
      policyVersion: version,
      decidedAt,
      expiresAt: iso(clock.now() + PRE_AUTH_CONSENT_TTL_MS),
      // `migratedAt` is not a column a caller may write — the adapters reset it on every new
      // decision and only `markMigrated` sets it, so a client that changes its mind after
      // signup cannot keep a row claiming the new answer was already carried onto an account.
    });
    return {
      telemetryPersonal, policyVersion: version, decidedAt, subject: 'client-session',
      receipt: receipts.issueConsent({
        subject: 'client-session', subjectId: clientSessionId,
        telemetryPersonal, policyVersion: version, decidedAt,
      }),
    };
  }

  // ------------------------------------------------------------------------------- signup

  /**
   * Burn the eligibility receipt's nonce, once, for all time.
   *
   * There is no `eligibility_receipts` table and inventing one in another module's contract is
   * not this module's call (the same reason `ephemeral.js` gives), so this uses
   * `idempotency_keys`, which is precisely a "this exact token has already been spent" table —
   * first writer wins, and a second write under the same key with a different request hash is
   * refused by both adapters. The request hash is the account id, so a replay is always a
   * different hash and is always refused rather than silently returning the first row.
   */
  async function consumeEligibilityNonce(eligibility, accountId, tx) {
    const key = `eligibility-receipt:${eligibility.nonce}`;
    try {
      await store.idempotency.put({
        key,
        // A constant actor, because the composite key is (key, actorId): keying by account
        // would put every replay in its own namespace and consume nothing.
        actorId: 'onboarding',
        requestHash: accountId,
        responseStatus: null,
        responseBody: null,
        createdAt: iso(clock.now()),
        expiresAt: eligibility.expiresAt,
      }, tx);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'IDEMPOTENCY_KEY_REUSED') {
        // Same code as every other receipt failure (receipts.js): "restart the age gate".
        throw new ApiError('ELIGIBILITY_RECEIPT_INVALID',
          'That age check is no longer valid. Please start again.');
      }
      throw err;
    }
  }

  /** A racing signup on the same address must not answer differently from a losing one. */
  async function createAccountRow(row, tx) {
    try {
      return await store.accounts.create(row, tx);
    } catch (err) {
      // The store's unique constraints are the authority; the pre-checks above are only the
      // fast path. A CONFLICT here means "that email is registered", which is the one thing
      // signup may not say (§8).
      if (err instanceof ApiError && err.code === 'CONFLICT') {
        throw new ApiError('AUTH_INVALID_CREDENTIALS', 'We could not complete that sign-up.');
      }
      throw err;
    }
  }

  /**
   * Step 4. Takes no `dateOfBirth` — it never leaves the preflight.
   *
   * `eligibilityReceipt`, `clientSessionId`, and `consentReceipt` are all required (REQ-CC-034):
   * the approved order always reaches a consent decision before signup, so a signup without
   * them is a client that skipped a step, not a client with a different flow.
   */
  async function signup({ email, password, displayName, eligibilityReceipt, clientSessionId,
                          consentReceipt, ip = null, userAgent = null, correlationId = null }) {
    limiter.enforceAuth({ ip, subject: email ? emailHash(config.tokenSecret, email) : null });

    requireString(email, 'email');
    requireString(password, 'password', { min: 10, max: 200 });
    requireString(clientSessionId, 'clientSessionId');
    requireString(consentReceipt, 'consentReceipt');
    requireString(eligibilityReceipt, 'eligibilityReceipt');

    const eligibility = receipts.consumeEligibility(eligibilityReceipt);

    const consent = receipts.readConsent(consentReceipt);
    if (!consent || consent.subject !== 'client-session' || consent.subjectId !== clientSessionId) {
      throw new ApiError('VALIDATION_FAILED', 'That consent decision does not match this session.', {
        details: { fields: [{ path: 'consentReceipt', rule: 'subject', message: 'Mismatched client session.' }] },
      });
    }

    const { displayName: name, folded } = normaliseDisplayName(displayName);
    const lookup = emailHash(config.tokenSecret, email);
    const now = clock.now();

    // Hash BEFORE the uniqueness lookups.
    //
    // The email-collision check used to throw first, so a registered address answered in
    // 0.0 ms and a fresh one paid the 21.8 ms scrypt cost — a 21.7 ms gap that turns signup
    // into the account-enumeration oracle §8 forbids, exactly the one signin and recovery are
    // hardened against. The cost is that a refused signup still runs a KDF, which is the point.
    const passwordHash = hashPassword(password);
    const accountId = ulid(now);

    if (await store.accounts.byNameFolded(folded)) throw new ApiError('NAME_TAKEN', 'That name is taken.');
    // An existing address is reported as a name conflict would not be: signup cannot say
    // "that email is registered" without becoming the enumeration oracle §8 forbids, so it
    // returns the generic credential failure and the recovery flow is the way back in.
    if (await store.accounts.byEmailHash(lookup)) {
      throw new ApiError('AUTH_INVALID_CREDENTIALS', 'We could not complete that sign-up.');
    }

    // The stored pre-auth row is the source of truth (§3a.3 Storage); the receipt proves the
    // caller is entitled to it. When the row has aged out, the signature is still ours and
    // still carries the decision, so the decision survives rather than silently reverting to
    // undecided — which would be collecting a "no" the player never gave.
    const preAuth = await store.preAuthConsent.get(clientSessionId);
    const decision = preAuth && !preAuth.migratedAt ? preAuth : consent;

    // INTEGRATION NOTE: three of the fields below — `passwordHash`, `roles`, `nameChangedAt` —
    // have no column in `db-schema.md` §2, which assumes the provider holds credentials (D1)
    // and does not model roles or the §9 cooldown clock. They are written here because
    // auth.md §9 and §10 require them and this module cannot invent schema. Either §2 gains
    // the three columns or credentials move to the provider; both are contract decisions.
    const newActor = { ...playerActor(accountId), accountId, roles: ['player'] };
    const correlation = correlationFor(correlationId, now);
    const { result } = await internalise(() => outbox.commit({ correlationId: correlation, actor: newActor }, async (tx, emit) => {
      // §3a.1 says signup CONSUMES the receipt. It did not: the `n` nonce was minted, signed,
      // and never looked at again, so one age-gate pass created accounts without limit — three
      // on three client sessions in the reviewer's run. Recorded inside the transaction so a
      // signup that fails does not burn the receipt, and recorded BEFORE the account so two
      // concurrent presentations cannot both get past it.
      await consumeEligibilityNonce(eligibility, accountId, tx);

      const account = await createAccountRow({
        accountId,
        status: 'active',
        emailHash: lookup,
        passwordHash,
        displayName: name,
        displayNameFolded: folded,
        roles: ['player'],
        eligibilityVerdict: true,
        eligibilityPolicyVer: eligibility.policyVersion,
        eligibilityDecidedAt: eligibility.decidedAt,
        emailVerifiedAt: null,
        termsVersionAccepted: null,
        termsAcceptedAt: null,
        consentTelemetry: decision.telemetryPersonal,
        consentPolicyVer: decision.policyVersion,
        consentDecidedAt: decision.decidedAt,
        privacy: {},
        nameChangedAt: null,
        createdAt: iso(now),
        updatedAt: iso(now),
      }, tx);

      if (preAuth && !preAuth.migratedAt) await store.preAuthConsent.markMigrated(clientSessionId, iso(now), tx);

      await emit({
        type: 'account.created',
        actor: newActor,
        subject: { kind: 'account', id: accountId },
        payload: { displayName: name, eligibilityPolicyVersion: eligibility.policyVersion },
        occurredAt: iso(now),
      });

      const issued = await sessions.start({ accountId, roles: ['player'], ip, userAgent }, tx, emit);

      await audit.record({
        actor: newActor,
        action: 'account.signup',
        // No authenticated actor exists before signup, and the account being created is the
        // only party to the action. audit.js allows this exactly for an unprivileged actor
        // acting on itself and refuses it for anything else.
        capability: null,
        subject: { kind: 'account', id: accountId },
        reasonCode: 'account_self_service',
        after: { displayName: name, status: 'active' },
        summaryKeys: ['displayName', 'status'],
        correlationId: correlation,
      }, tx);

      return { account, issued };
    }));

    const verificationToken = ephemeral.issue('verification', accountId, opaqueToken(), VERIFICATION_TTL_MS);
    await mailer?.sendVerification?.({ email, token: verificationToken, correlationId });

    return {
      accessToken: result.issued.accessToken,
      expiresAt: result.issued.expiresAt,
      refreshToken: result.issued.refreshToken,
      session: result.issued.session,
      profile: projectProfile(result.account),
      // Account-scoped, replacing the session-scoped one on subsequent telemetry batches.
      consentReceipt: accountConsentReceipt(result.account),
      verificationToken,      // returned to the caller of the service, never to the client
    };
  }

  // ------------------------------------------------------------------------------- signin

  async function signin({ email, password, ip = null, userAgent = null, correlationId = null }) {
    const lookup = email ? emailHash(config.tokenSecret, email) : null;
    limiter.enforceAuth({ ip, subject: lookup });
    requireString(email, 'email');
    requireString(password, 'password', { min: 1, max: 200 });

    const account = await store.accounts.byEmailHash(lookup);
    // Verify against a real hash even when there is no account, so a nonexistent address does
    // not answer in a millisecond while a real one takes the full scrypt cost.
    const ok = verifyPassword(password, account ? account.passwordHash : DUMMY_PASSWORD_HASH);
    if (!account || !ok) throw new ApiError('AUTH_INVALID_CREDENTIALS', 'That email or password is incorrect.');
    if (account.status === 'banned' || account.status === 'restricted') {
      throw new ApiError('AUTH_ACCOUNT_LOCKED', 'This account is locked.');
    }

    const roles = account.roles ?? ['player'];
    const actor = { ...playerActor(account.accountId, roles), accountId: account.accountId, roles };
    const correlation = correlationFor(correlationId, clock.now());
    const { result: issued } = await internalise(() => outbox.commit(
      { correlationId: correlation, actor },
      async (tx, emit) => {
        const started = await sessions.start({ accountId: account.accountId, roles, ip, userAgent }, tx, emit);
        await audit.record({
          actor,
          action: 'account.signin',
          capability: null,                 // the credential is the authorization; see signup
          subject: { kind: 'account', id: account.accountId },
          reasonCode: 'account_self_service',
          after: { sessionId: started.session.sessionId },
          summaryKeys: ['sessionId'],
          correlationId: correlation,
        }, tx);
        return started;
      },
    ));

    return {
      accessToken: issued.accessToken,
      expiresAt: issued.expiresAt,
      refreshToken: issued.refreshToken,
      session: issued.session,
      profile: projectProfile(account),
      // §3a.3: returned here too, or a returning player has no declared way to obtain one.
      consentReceipt: accountConsentReceipt(account),
    };
  }

  // ----------------------------------------------------------------------------- recovery

  /**
   * Always 202, whether or not the account exists, and in the same amount of time.
   *
   * The response is the same object on both paths and the caller cannot branch on it. The
   * only observable that could still differ is the clock, which `RECOVERY_FLOOR_MS` removes.
   */
  async function recoveryStart({ email, ip = null, correlationId = null }) {
    const startedAt = process.hrtime.bigint();
    const lookup = email ? emailHash(config.tokenSecret, email) : null;
    limiter.enforceAuth({ ip, subject: lookup });

    try {
      requireString(email, 'email');
      const account = lookup ? await store.accounts.byEmailHash(lookup) : null;
      // A token is minted either way. The throwaway one for a nonexistent address costs the
      // same work and is discarded, so the two paths differ only in where the result goes.
      const raw = opaqueToken();
      const subjectId = account ? account.accountId : `absent:${lookup}`;
      ephemeral.issue('recovery', subjectId, raw, RECOVERY_TTL_MS);
      if (account) await mailer?.sendRecovery?.({ email, token: raw, correlationId });
      logger.info('auth.recovery.start', { correlationId, delivered: !!account });
      return { accepted: true, recoveryToken: account ? raw : null };
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      if (elapsedMs < RECOVERY_FLOOR_MS) await sleep(RECOVERY_FLOOR_MS - elapsedMs);
    }
  }

  /** Completing recovery revokes **every** session — otherwise the attacker's stays live. */
  async function recoveryComplete({ token, newPassword, ip = null, correlationId = null }) {
    // §9 lists recovery in the auth class; only `recovery/start` enforced it, so the half of
    // the flow that actually changes a password was the unlimited one.
    limiter.enforceAuth({ ip, subject: null });
    requireString(newPassword, 'newPassword', { min: 10, max: 200 });
    const claim = ephemeral.consume('recovery', token);
    if (!claim.ok) {
      if (claim.reason === 'expired') {
        throw new ApiError('AUTH_RECOVERY_TOKEN_EXPIRED', 'That reset link expired. Start again.');
      }
      throw new ApiError('AUTH_RECOVERY_TOKEN_INVALID', 'That reset link is no longer valid. Start again.');
    }
    const account = await store.accounts.byId(claim.accountId);
    if (!account) throw new ApiError('AUTH_RECOVERY_TOKEN_INVALID', 'That reset link is no longer valid. Start again.');

    // The account holder is the actor: proving control of the single-use token is the
    // authorization, and there is no session to derive an actor from.
    const actor = { ...playerActor(account.accountId, account.roles), accountId: account.accountId, roles: account.roles ?? ['player'] };
    await updateAccount(actor, 'account.recovery_complete', {
      passwordHash: hashPassword(newPassword), updatedAt: iso(clock.now()),
    }, {
      summaryKeys: ['status', 'updatedAt'], reasonCode: 'account_recovery', correlationId, capability: null,
    });
    ephemeral.invalidateAll('recovery', account.accountId);
    await sessions.revokeAll({ accountId: account.accountId, reason: 'recovery-completed', correlationId });
    return { accountId: account.accountId };
  }

  // ------------------------------------------------------------------------- verification

  async function verificationResend({ actor, ip = null, correlationId = null }) {
    // §9: resend sends mail and mints a credential on every call. Unlimited, it is both a free
    // mailer and a way to invalidate the link a player is holding, over and over.
    limiter.enforceAuth({ ip, subject: actor?.accountId ?? null });
    requireCapability(actor, 'account:update', { accountId: actor.accountId });
    const account = await store.accounts.byId(actor.accountId);
    if (!account) throw new ApiError('NOT_FOUND', 'No such account.');
    const raw = ephemeral.issue('verification', account.accountId, opaqueToken(), VERIFICATION_TTL_MS);
    await mailer?.sendVerification?.({ accountId: account.accountId, token: raw, correlationId });
    return { accepted: true, verificationToken: raw };
  }

  /**
   * Verification has its **own** codes.
   *
   * It previously reused the recovery ones, whose documented UI obligation is "restart
   * recovery" — so a mistyped verification link would have dropped the player into a password
   * reset. `AUTH_VERIFICATION_TOKEN_INVALID` / `_EXPIRED` route to "resend verification".
   */
  async function verificationComplete({ actor, token, correlationId = null }) {
    requireCapability(actor, 'account:update', { accountId: actor.accountId });
    // PEEK, then compare, then consume.
    //
    // It used to consume first and compare afterwards, so any authenticated account could burn
    // any other account's verification link by pasting it: single-use means the owner's link
    // was then permanently dead, with no error anyone could see and no way to distinguish it
    // from an expired one. Ownership is checked before anything is spent.
    const seen = ephemeral.peek('verification', token);
    if (!seen.ok || seen.accountId !== actor.accountId) {
      if (seen.reason === 'expired') {
        throw new ApiError('AUTH_VERIFICATION_TOKEN_EXPIRED', 'That verification link expired. Send a new one.');
      }
      throw new ApiError('AUTH_VERIFICATION_TOKEN_INVALID', 'That verification link is no longer valid. Send a new one.');
    }
    const claim = ephemeral.consume('verification', token);
    if (!claim.ok || claim.accountId !== actor.accountId) {
      // Only reachable if something else spent it between the peek and here.
      throw new ApiError('AUTH_VERIFICATION_TOKEN_INVALID', 'That verification link is no longer valid. Send a new one.');
    }
    await updateAccount(actor, 'account.verify', { emailVerifiedAt: iso(clock.now()) }, {
      summaryKeys: ['emailVerifiedAt'], reasonCode: 'account_self_service', correlationId,
    });
    logger.info('auth.verification.completed', { correlationId, accountId: actor.accountId });
  }

  // ------------------------------------------------------------------------------- terms

  function termsGet() {
    return {
      version: config.termsVersion,
      url: `${config.termsBaseUrl ?? '/legal/terms'}/v${config.termsVersion}`,
      publishedAt: config.termsPublishedAt ?? new Date(0).toISOString(),
    };
  }

  async function termsAccept({ actor, version, correlationId = null }) {
    requireCapability(actor, 'account:update', { accountId: actor.accountId });
    const current = termsGet();
    // Accepting a stale version is a conflict, not a validation error: the client's copy was
    // right when it loaded, and `details` carries what it needs to re-present.
    if (version !== current.version) {
      throw new ApiError('CONFLICT', 'The terms have been updated.', {
        details: { currentVersion: current.version, url: current.url, publishedAt: current.publishedAt },
      });
    }
    await updateAccount(actor, 'account.terms_accept', {
      termsVersionAccepted: current.version, termsAcceptedAt: iso(clock.now()),
    }, {
      summaryKeys: ['termsVersionAccepted', 'termsAcceptedAt'],
      reasonCode: 'account_self_service', correlationId,
    });
  }

  // ------------------------------------------------------------------------ display names

  /**
   * The policy behind `PATCH /v1/profile/me`. The profile module owns the endpoint; the rules
   * live here because they are identity rules, and having two implementations of confusable
   * folding is having one that is wrong.
   */
  async function changeDisplayName({ actor, displayName, correlationId = null }) {
    requireCapability(actor, 'profile:update', { accountId: actor.accountId });
    const account = await store.accounts.byId(actor.accountId);
    if (!account) throw new ApiError('NOT_FOUND', 'No such account.');
    const { displayName: name, folded } = normaliseDisplayName(displayName);
    const now = clock.now();

    const foldChanged = folded !== account.displayNameFolded;
    if (foldChanged) {
      const holder = await store.accounts.byNameFolded(folded);
      if (holder && holder.accountId !== account.accountId) throw new ApiError('NAME_TAKEN', 'That name is taken.');
      assertCooldown(account.nameChangedAt, now);
    }

    const patch = { displayName: name, displayNameFolded: folded, updatedAt: iso(now) };
    // A case-only edit skips the cooldown check — the name is the same name — so it must not
    // restart the cooldown clock either. It did, which meant `ada` → `Ada` bought another 30
    // days of lockout for a change the §9 rule does not consider a change at all.
    if (foldChanged) patch.nameChangedAt = iso(now);

    const updated = await updateAccountWithEvent(actor, patch, {
      action: 'account.name_change',
      capability: 'profile:update',
      reasonCode: 'account_self_service',
      correlationId,
      summaryKeys: ['displayName'],
      spec: {
        type: 'account.name_changed',
        actor: playerActor(account.accountId, actor.roles),
        subject: { kind: 'account', id: account.accountId },
        payload: { previousName: account.displayName, displayName: name },
        occurredAt: iso(now),
      },
    });
    return projectProfile(updated);
  }

  return {
    projectProfile,
    eligibilityPreflight,
    getConsent, putConsent,
    signup, signin,
    recoveryStart, recoveryComplete,
    verificationResend, verificationComplete,
    termsGet, termsAccept,
    changeDisplayName,
  };
}
