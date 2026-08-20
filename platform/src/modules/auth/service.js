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
import { emailHash, hashPassword, verifyPassword, opaqueToken } from './crypto.js';
import { normaliseDisplayName, assertCooldown } from './names.js';
import { makeEvent, emit } from './events.js';

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
  const { store, config, clock, logger, sessions, receipts, ephemeral, limiter, sleep = defaultSleep, mailer = null } = deps;
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
  function eligibilityPreflight({ dateOfBirth, jurisdiction = null }) {
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

  async function putConsent({ actor = null, telemetryPersonal, policyVersion, clientSessionId = null }) {
    if (typeof telemetryPersonal !== 'boolean') {
      throw new ApiError('VALIDATION_FAILED', 'A consent decision is required.', {
        details: { fields: [{ path: 'telemetryPersonal', rule: 'boolean', message: 'true or false.' }] },
      });
    }
    const version = Number.isInteger(policyVersion) ? policyVersion : config.consentPolicyVersion;
    const decidedAt = iso(clock.now());

    if (actor) {
      // `clientSessionId` is ignored when authenticated: the account is the stronger subject
      // and letting a request name a different one would be an assignment primitive.
      const account = await store.accounts.update(actor.accountId, {
        consentTelemetry: telemetryPersonal, consentPolicyVer: version, consentDecidedAt: decidedAt,
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
      migratedAt: null,
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

    if (await store.accounts.byNameFolded(folded)) throw new ApiError('NAME_TAKEN', 'That name is taken.');
    // An existing address is reported as a name conflict would not be: signup cannot say
    // "that email is registered" without becoming the enumeration oracle §8 forbids, so it
    // returns the generic credential failure and the recovery flow is the way back in.
    if (await store.accounts.byEmailHash(lookup)) {
      throw new ApiError('AUTH_INVALID_CREDENTIALS', 'We could not complete that sign-up.');
    }

    const accountId = ulid(now);
    const passwordHash = hashPassword(password);

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
    const result = await store.tx(async (tx) => {
      const account = await store.accounts.create({
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

      await emit(store, makeEvent('account.created', {
        actor: { kind: 'player', id: accountId, role: 'player' },
        subject: { kind: 'account', id: accountId },
        payload: { displayName: name, eligibilityPolicyVersion: eligibility.policyVersion },
        correlationId, occurredAt: now,
      }), tx);

      const issued = await sessions.start({ accountId, roles: ['player'], ip, userAgent, correlationId }, tx);
      return { account, issued };
    });

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

    const issued = await store.tx((tx) => sessions.start({
      accountId: account.accountId, roles: account.roles ?? ['player'], ip, userAgent, correlationId,
    }, tx));

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
  async function recoveryComplete({ token, newPassword, correlationId = null }) {
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

    await store.accounts.update(account.accountId, {
      passwordHash: hashPassword(newPassword), updatedAt: iso(clock.now()),
    });
    ephemeral.invalidateAll('recovery', account.accountId);
    await sessions.revokeAll({ accountId: account.accountId, reason: 'recovery-completed', correlationId });
    return { accountId: account.accountId };
  }

  // ------------------------------------------------------------------------- verification

  async function verificationResend({ actor, correlationId = null }) {
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
    const claim = ephemeral.consume('verification', token);
    if (!claim.ok) {
      if (claim.reason === 'expired') {
        throw new ApiError('AUTH_VERIFICATION_TOKEN_EXPIRED', 'That verification link expired. Send a new one.');
      }
      throw new ApiError('AUTH_VERIFICATION_TOKEN_INVALID', 'That verification link is no longer valid. Send a new one.');
    }
    if (claim.accountId !== actor.accountId) {
      throw new ApiError('AUTH_VERIFICATION_TOKEN_INVALID', 'That verification link is no longer valid. Send a new one.');
    }
    await store.accounts.update(actor.accountId, { emailVerifiedAt: iso(clock.now()) });
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

  async function termsAccept({ actor, version }) {
    const current = termsGet();
    // Accepting a stale version is a conflict, not a validation error: the client's copy was
    // right when it loaded, and `details` carries what it needs to re-present.
    if (version !== current.version) {
      throw new ApiError('CONFLICT', 'The terms have been updated.', {
        details: { currentVersion: current.version, url: current.url, publishedAt: current.publishedAt },
      });
    }
    await store.accounts.update(actor.accountId, {
      termsVersionAccepted: current.version, termsAcceptedAt: iso(clock.now()),
    });
  }

  // ------------------------------------------------------------------------ display names

  /**
   * The policy behind `PATCH /v1/profile/me`. The profile module owns the endpoint; the rules
   * live here because they are identity rules, and having two implementations of confusable
   * folding is having one that is wrong.
   */
  async function changeDisplayName({ actor, displayName, correlationId = null }) {
    const account = await store.accounts.byId(actor.accountId);
    if (!account) throw new ApiError('NOT_FOUND', 'No such account.');
    const { displayName: name, folded } = normaliseDisplayName(displayName);
    const now = clock.now();

    if (folded !== account.displayNameFolded) {
      const holder = await store.accounts.byNameFolded(folded);
      if (holder && holder.accountId !== account.accountId) throw new ApiError('NAME_TAKEN', 'That name is taken.');
      assertCooldown(account.nameChangedAt, now);
    }

    return store.tx(async (tx) => {
      const updated = await store.accounts.update(account.accountId, {
        displayName: name, displayNameFolded: folded, nameChangedAt: iso(now), updatedAt: iso(now),
      }, tx);
      await emit(store, makeEvent('account.name_changed', {
        actor: { kind: 'player', id: account.accountId, role: 'player' },
        subject: { kind: 'account', id: account.accountId },
        payload: { previousName: account.displayName, displayName: name },
        correlationId, occurredAt: now,
      }), tx);
      return projectProfile(updated);
    });
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
