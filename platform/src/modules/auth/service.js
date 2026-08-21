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
import { emailHash, opaqueToken } from './crypto.js';
import { createLocalIdentityProvider } from './identity.js';
import { nameChangeAvailableAt, setupNextStepForAccount } from '../profile/profile.js';
import { normaliseDisplayName, assertCooldown } from './names.js';
import { playerActor, correlationFor } from './events.js';
import { internalise } from './faults.js';
import { mailDisabledError } from '../mail/index.js';

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

/**
 * The advisory-lock key a rename serialises on, scoped to one account.
 *
 * Not an idempotency key — it is passed through `store.idempotency.acquire` because that is
 * where the transaction-scoped advisory lock lives (see `postgres.js`), and a second way to
 * take the same kind of lock would be a second place to get it wrong. It is a constant rather
 * than a caller-supplied string so that every rename of one account contends on ONE key; the
 * account id is the other half of the lock identity and is supplied at the call site.
 */
export const NAME_CHANGE_LOCK = 'account:display-name';

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
    sleep = defaultSleep, mailer = null, identity = createLocalIdentityProvider(),
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
  async function projectProfile(account) {
    const profile = await store.profiles?.byAccountId?.(account.accountId);
    const projectedAccount = { ...account, roamingSettings: profile?.roamingSettings ?? null };
    return {
      accountId: account.accountId,
      displayName: account.displayName,
      createdAt: account.createdAt,
      consent: account.consentTelemetry == null ? null : {
        telemetryPersonal: account.consentTelemetry,
        policyVersion: account.consentPolicyVer,
        decidedAt: account.consentDecidedAt,
      },
      privacy: {
        presenceVisibility: account.privacy?.presenceVisibility ?? 'everyone',
        statsVisibility: account.privacy?.statsVisibility ?? 'everyone',
      },
      moderation: {
        status: account.status === 'restricted' ? 'restricted'
          : ['banned', 'deleted'].includes(account.status) ? 'banned' : 'clear',
        activeSanctions: [],
      },
      flags: {
        nameChangeAvailableAt: nameChangeAvailableAt(account, 30 * 24 * 3600e3),
        setupNextStep: setupNextStepForAccount(projectedAccount, config.termsVersion,
          { emailVerificationRequired: config.emailVerificationRequired !== false }),
      },
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
  async function updateAccountWithEvent(actor, patch, { action, capability = 'account:update', reasonCode, correlationId, summaryKeys, spec, alsoInTransaction = null, tx: openTx = undefined }) {
    // `openTx` is for a caller that has already opened the transaction and taken a lock in it
    // — the rename does. Reading `before` on the pool instead would read around that
    // transaction's own uncommitted writes, so the audit row's `before` would describe a state
    // that never existed. Undefined for every other caller, which reads on the pool as before.
    const before = await store.accounts.byId(actor.accountId, openTx);
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
      // `alsoInTransaction` is for the row that has to commit WITH the account change and its
      // event — the §9 name history is the case. A second transaction for it would commit a
      // rename whose history insert then rolled back, which is precisely the rename an
      // impersonation review would come looking for.
      async (tx) => {
        const updated = await store.accounts.update(actor.accountId, patch, tx);
        if (alsoInTransaction) await alsoInTransaction(updated, tx);
        return updated;
      },
    ));
    // `recordWithEvent` -> `outbox.commit` returns { result: { row, event, result }, events }.
    // Destructuring one level yielded the wrapper, so callers got { row, event, result } where
    // they expected the updated account — which left `sid` off the consent receipt entirely,
    // producing an UNBOUND receipt: a bearer token for someone else's consent.
    return result.result;
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
  /**
   * The consent decision, and — separately — the policy version a decision would be made UNDER.
   *
   * `policyVersion` is the version the player DECIDED under, and it is null while undecided.
   * That is correct and it left a client unable to act: `PUT /v1/onboarding/consent` requires
   * `policyVersion`, and nothing in the API told the caller which version was in force. The
   * deployed shell disabled both consent buttons because it had no version to submit, so
   * onboarding stopped dead at step 2 with no error and nothing to click.
   *
   * `currentPolicyVersion` is that missing fact. It is always present, never null, and is
   * deliberately a SEPARATE key rather than a fallback value in `policyVersion` — filling the
   * decided field with the current version would claim a decision that has not been made, and
   * `decidedAt: null` beside `policyVersion: 1` is a contradiction a reader has to unpick.
   *
   * A stale decision is now legible too: `policyVersion < currentPolicyVersion` with a
   * non-null `decidedAt` means "decided, under an older policy", which is exactly when a
   * client should re-ask.
   */
  async function getConsent({ actor = null, clientSessionId = null }) {
    const currentPolicyVersion = config.consentPolicyVersion;
    if (actor) {
      const account = await store.accounts.byId(actor.accountId);
      if (!account) throw new ApiError('NOT_FOUND', 'No such account.');
      if (account.consentTelemetry == null) {
        return {
          telemetryPersonal: null, policyVersion: null, decidedAt: null,
          currentPolicyVersion, subject: 'account', receipt: null,
        };
      }
      return {
        telemetryPersonal: account.consentTelemetry,
        policyVersion: account.consentPolicyVer,
        decidedAt: account.consentDecidedAt,
        currentPolicyVersion,
        subject: 'account',
        receipt: accountConsentReceipt(account),
      };
    }
    requireString(clientSessionId, 'clientSessionId');
    const row = await store.preAuthConsent.get(clientSessionId);
    if (!row || row.migratedAt) {
      return {
        telemetryPersonal: null, policyVersion: null, decidedAt: null,
        currentPolicyVersion, subject: 'client-session', receipt: null,
      };
    }
    return {
      telemetryPersonal: row.telemetryPersonal,
      policyVersion: row.policyVersion,
      decidedAt: row.decidedAt,
      currentPolicyVersion,
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
      // `migratedAt` is not a column a caller may write. Nothing stamps it any more — signup
      // deletes the row (§3a.3) — and the adapters force it to null on write, so a row that
      // arrives with a stamp cannot make a live decision read as already-carried.
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
      //
      // EQUIVALENT MUTANT, measured — this line and the `byEmailHash` pre-check below it are
      // each other's backstop, so deleting EITHER ONE changes nothing observable. The suite
      // runs the memory adapter, which serialises every transaction, so the only reachable way
      // to make `accounts.create` raise CONFLICT from signup is a duplicate address — and the
      // pre-check refuses that first with the identical `AUTH_INVALID_CREDENTIALS` / "We could
      // not complete that sign-up." Measured by deleting each line on its own in a copied tree
      // and driving a duplicate-address signup: byte-identical error code, message, details and
      // outbox/audit row counts in all three runs.
      //
      // It is NOT redundant, and must not be removed with the pre-check: the case it exists for
      // is the RACE — two signups on one address arriving together on Postgres, where the
      // pre-check passes for both and the unique index refuses the loser. That case cannot be
      // produced on the adapter the suite runs, which is why nothing here kills it.
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

    // Ask the configured identity provider BEFORE the uniqueness lookups. For the local-test
    // adapter this retains the KDF timing equalisation; in production Supabase is the only
    // component that handles the password. The returned value is a provider reference, never
    // a Supabase token. The legacy `password_hash` column stores that opaque reference when
    // identity is delegated and a scrypt record only outside production.
    //
    // The email-collision check used to throw first, so a registered address answered in
    // 0.0 ms and a fresh one paid the 21.8 ms scrypt cost — a 21.7 ms gap that turns signup
    // into the account-enumeration oracle §8 forbids, exactly the one signin and recovery are
    // hardened against. The cost is that a refused signup still runs a KDF, which is the point.
    const accountId = ulid(now);
    const credential = await identity.create({ email, password, accountId });
    const cleanupIdentity = async () => {
      try {
        await identity.remove({ reference: credential.passwordHash,
          subject: credential.identitySubject });
      } catch (cleanupError) {
        // Compensation is observable but never replaces the real signup outcome.
        logger?.error?.('auth.identity.compensation_failed', {
          accountId, provider: identity.kind, cause: String(cleanupError?.message || cleanupError),
        });
      }
    };

    if (await store.accounts.byNameFolded(folded)) {
      await cleanupIdentity();
      throw new ApiError('NAME_TAKEN', 'That name is taken.');
    }
    // An existing address is reported as a name conflict would not be: signup cannot say
    // "that email is registered" without becoming the enumeration oracle §8 forbids, so it
    // returns the generic credential failure and the recovery flow is the way back in.
    //
    // EQUIVALENT MUTANT, measured — see the note on `createAccountRow`'s CONFLICT branch, which
    // is this line's backstop and which this line is the backstop for. Deleting this check
    // sends a duplicate address into `accounts.create`, whose CONFLICT that branch translates
    // into the same `AUTH_INVALID_CREDENTIALS` with the same message; deleting that branch
    // leaves this check to refuse first. Measured both ways on a copied tree: identical code,
    // message, details and outbox/audit counts. Kept as the fast path — the refusal belongs
    // to signup's own rules rather than to whichever adapter is mounted, and one of the two
    // must survive or §8's oracle opens.
    if (await store.accounts.byEmailHash(lookup)) {
      await cleanupIdentity();
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
    let committed = false;
    let result;
    try {
      ({ result } = await internalise(() => outbox.commit({ correlationId: correlation, actor: newActor }, async (tx, emit) => {
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
        // PERSONAL class (0019). Stored so this platform can address the mail it owes the
        // player; lookup and uniqueness still go through `emailHash`, never this.
        email,
        passwordHash: credential.passwordHash,
        identityProvider: credential.identityProvider,
        identitySubject: credential.identitySubject,
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

      // §3a.3: the signed-out row "is deleted on migration at signup, or on expiry". It used to
      // be stamped `migrated_at` and kept, which reads as absent and retains as present — the
      // decision now lives on the account, and the second copy is a consent record keyed by a
      // client session with nothing left to authorise. Inside the transaction, so a signup that
      // rolls back does not destroy the decision it failed to carry over.
      if (preAuth) await store.preAuthConsent.deleteFor(clientSessionId, tx);

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
      })));
      committed = true;
    } finally {
      // A provider user without a platform account cannot sign in and cannot be recovered.
      // Compensate any failed database/outbox transaction instead of leaking that orphan.
      if (!committed) {
        await cleanupIdentity();
      }
    }

    const verificationToken = ephemeral.issue('verification', accountId, opaqueToken(), VERIFICATION_TTL_MS);
    await mailer?.sendVerification?.({ email, token: verificationToken, correlationId });

    return {
      accessToken: result.issued.accessToken,
      expiresAt: result.issued.expiresAt,
      refreshToken: result.issued.refreshToken,
      session: result.issued.session,
      profile: await projectProfile(result.account),
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
    const ok = await identity.verify({
      email, password, reference: account ? account.passwordHash : null,
      subject: account?.identitySubject ?? null,
    });
    if (!account || !ok) throw new ApiError('AUTH_INVALID_CREDENTIALS', 'That email or password is incorrect.');
    if (account.status !== 'active') {
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
      profile: await projectProfile(account),
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
    const claim = ephemeral.reserve('recovery', token);
    if (!claim.ok) {
      if (claim.reason === 'expired') {
        throw new ApiError('AUTH_RECOVERY_TOKEN_EXPIRED', 'That reset link expired. Start again.');
      }
      throw new ApiError('AUTH_RECOVERY_TOKEN_INVALID', 'That reset link is no longer valid. Start again.');
    }
    const account = await store.accounts.byId(claim.accountId);
    if (!account) {
      claim.complete();
      throw new ApiError('AUTH_RECOVERY_TOKEN_INVALID', 'That reset link is no longer valid. Start again.');
    }

    // The account holder is the actor: proving control of the single-use token is the
    // authorization, and there is no session to derive an actor from.
    const actor = { ...playerActor(account.accountId, account.roles), accountId: account.accountId, roles: account.roles ?? ['player'] };
    try {
      const replacement = await identity.replace({
        password: newPassword, reference: account.passwordHash,
        subject: account.identitySubject, email: account.email,
      });
      await updateAccount(actor, 'account.recovery_complete', {
        passwordHash: replacement.passwordHash,
        identityProvider: replacement.identityProvider,
        identitySubject: replacement.identitySubject,
        updatedAt: iso(clock.now()),
      }, {
        summaryKeys: ['status', 'updatedAt'], reasonCode: 'account_recovery', correlationId, capability: null,
      });
      await sessions.revokeAll({ accountId: account.accountId, reason: 'recovery-completed', correlationId });
      claim.complete();
      return { accountId: account.accountId };
    } catch (error) {
      // Provider replacement precedes the local commit. It cannot be rolled back without the
      // old password, so keep the exclusive token retryable: the operation is an idempotent
      // resumable saga, not a half-completed reset with a permanently spent link.
      claim.release();
      throw error;
    }
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
    // The EMAIL, not just the accountId: a mailer given only an account id has no recipient and
    // silently delivers nothing. This path is the one a player uses when the first message never
    // arrived, so it is the worst one to have quietly send nowhere.
    const sent = await mailer?.sendVerification?.({
      accountId: account.accountId, email: account.email, token: raw, correlationId,
    });
    // The RETURN VALUE, not just the call.
    //
    // This awaited the send and discarded the result, so `accepted: true` was reported no matter
    // what happened — including a `none` transport, where the honest answer is that nothing was
    // sent and nothing ever will be. Live, that made "Resend code" a button reporting success
    // forever while no message existed; `mail/index.js` exported `mailDisabledError` for this
    // case and nothing had ever called it.
    //
    // Only `transport_disabled` refuses. A `transport_error` is a provider hiccup on a token
    // that has already been minted and remains valid, so it stays 202 and is logged — the player
    // can press the button again, which is the whole purpose of this route.
    if (sent && sent.delivered === false && sent.reason === 'transport_disabled') {
      throw mailDisabledError();
    }
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

/**
 * Map an internal policy rule id onto http-api.md §3b's CLOSED set.
 *
 * §3b publishes exactly `length · charset · reserved · impersonation · profanity · confusable`.
 * `names.js` raises `mixed-script` for a name whose characters cannot come from one script,
 * which §9 describes as homoglyph impersonation — the same refusal under the name this endpoint
 * is contracted to use. Mapping it here keeps the wire inside its closed set without renaming
 * the internal rule, which other callers already assert on.
 *
 * An unmapped id passes through rather than being swallowed: a rule outside the set is a real
 * contract violation, and it should be visible in a response and a test, not silently recoded.
 */
const CONTRACT_RULES = { 'mixed-script': 'impersonation' };
function contractRule(rule) {
  return CONTRACT_RULES[rule] || rule || 'charset';
}

  // ------------------------------------------------------------------------ display names

  /**
   * The policy behind `PATCH /v1/profile/me`. The profile module owns the endpoint; the rules
   * live here because they are identity rules, and having two implementations of confusable
   * folding is having one that is wrong.
   */
  /**
   * §3b availability preflight for `POST /v1/auth/display-name/check`.
   *
   * The screen it serves was unbuildable without it: §9 forbids reproducing the name ruleset
   * client-side, so the only way to learn a name was taken was to attempt the account and read
   * the failure. The endpoint was fully specified in http-api.md §3b, called by the shell, and
   * mounted nowhere — the deployed display-name step answered "No such endpoint." into its own
   * availability field.
   *
   * POLICY IS EVALUATED BEFORE EXISTENCE, per §3b: a name that fails policy reports the rule
   * whether or not it is also taken, because answering "taken" for reserved names turns this
   * into a directory of which reserved names exist.
   *
   * The body is exactly `{ available, policy }` — the caller adds `correlationId`. `policy` is
   * object-or-null and never absent; the ruleset itself is never published, for the same reason
   * §3a.1 withholds `minimumAge`: a published rule is a rule the next attempt routes around.
   */
  async function checkDisplayName({ displayName }) {
    let normalised;
    try {
      normalised = normaliseDisplayName(displayName);
    } catch (err) {
      // An absent or non-string candidate is a malformed REQUEST (400), not a refused name.
      // A refused name is a 200 with a verdict — the field stays usable and the player is told
      // which rule refused, which is the entire point of the endpoint.
      if (err?.code === 'NAME_POLICY_VIOLATION') {
        return { available: false, policy: { rule: contractRule(err.details?.rule) } };
      }
      throw err;
    }
    const holder = await store.accounts.byNameFolded(normalised.folded);
    return { available: !holder, policy: null };
  }

  async function changeDisplayName({ actor, displayName, correlationId = null }) {
    requireCapability(actor, 'profile:update', { accountId: actor.accountId });
    // Normalisation and the §9 name policy are decided on the INPUT and need no account, so
    // they run before the lock is taken — a request that could never be applied should not
    // queue behind one that can.
    const { displayName: name, folded } = normaliseDisplayName(displayName);

    // ── Everything below is ONE serialised read-decide-write, per account ────────────────
    //
    // It was not. The account was read, `assertCooldown` was checked against the row it
    // returned, and the write happened in a separate transaction opened further down — with
    // nothing holding the three together. Two renames that arrive at once both read
    // `nameChangedAt: null`, both pass the cooldown check, and both write: a 30-day rule
    // bypassed by sending two requests instead of one, and two `account_name_history` rows
    // retained for a change §9 permits once. Ten concurrent requests landed three renames
    // against a real database.
    //
    // `display_name_folded` is UNIQUE, so the database refuses two racers who pick the SAME
    // name. Nothing refuses two racers who pick DIFFERENT ones, and a uniqueness constraint
    // was never the cooldown's enforcement — it just happened to hide the race whenever the
    // test used one name.
    //
    // The lock is the transaction-scoped advisory lock `profile.js` takes around its
    // idempotency key and `postgres.js` documents on `idempotency.acquire`: it needs no row to
    // exist, it is released on commit or rollback so a crash cannot strand it, and it is a
    // documented no-op on the memory adapter, where every transaction is already serialised.
    // Expressed once here rather than per adapter. The key is the ACCOUNT, so two different
    // accounts renaming at the same time do not queue behind each other.
    //
    // `store.tx` is reentrant, so when the profile module has already opened a transaction for
    // its idempotency key this joins it rather than taking a second connection — and the lock
    // ordering (idempotency key, then account) is the same on every path, so it cannot deadlock.
    return store.tx(async (tx) => {
      if (store.idempotency?.acquire) {
        await store.idempotency.acquire(NAME_CHANGE_LOCK, actor.accountId, tx);
      }
      // Read AFTER the lock, and inside the transaction. A read taken before it, or outside
      // it, is the stale row the whole guard exists to not decide on.
      const account = await store.accounts.byId(actor.accountId, tx);
      if (!account) throw new ApiError('NOT_FOUND', 'No such account.');
      const now = clock.now();

      const foldChanged = folded !== account.displayNameFolded;
      if (foldChanged) {
        const holder = await store.accounts.byNameFolded(folded, tx);
        if (holder && holder.accountId !== account.accountId) throw new ApiError('NAME_TAKEN', 'That name is taken.');
        assertCooldown(account.nameChangedAt, now);
      }

      return applyRename({ actor, account, name, folded, foldChanged, now, correlationId, tx });
    });
  }

  /**
   * The write half of `changeDisplayName`, run inside its lock. Separated only so the
   * serialised section above reads as the read-decide-write it is.
   */
  async function applyRename({ actor, account, name, folded, foldChanged, now, correlationId, tx }) {
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
      // The transaction the lock is held in. `store.tx` is reentrant, so the event, the audit
      // row and the history insert all enrol in it rather than opening a second one.
      tx,
      spec: {
        type: 'account.name_changed',
        actor: playerActor(account.accountId, actor.roles),
        subject: { kind: 'account', id: account.accountId },
        payload: { previousName: account.displayName, displayName: name },
        occurredAt: iso(now),
      },
      /**
       * auth.md §9 History: "Retained for moderation and impersonation review."
       *
       * `account_name_history` has existed since migration 0001 and nothing ever wrote it, so
       * the only record of a previous name was the `account.name_changed` event — a stream
       * with its own retention, published to consumers, and not a table a moderator can query.
       * The event says a rename happened; this is the record that survives to answer "what was
       * this account called before".
       *
       * Written in the SAME transaction as the account row and the event, so the three cannot
       * disagree. Skipped when the rendered name is unchanged: a no-op rename has no previous
       * name to retain, and (account_id, changed_at) is the primary key, so a stream of
       * identical writes at one instant would collide for no reason.
       */
      alsoInTransaction: name === account.displayName ? null : async (_updated, innerTx) => {
        await store.accountNameHistory.insert({
          accountId: account.accountId,
          previousName: account.displayName,
          changedAt: iso(now),
          // The actor, which is not always the subject: a §10 moderator rename must name the
          // moderator, or the row cannot answer who did it.
          changedBy: actor.id ?? actor.accountId ?? null,
          reason: 'account_self_service',
        }, innerTx);
      },
    });
    return projectProfile(updated);
  }

  /**
   * The §9 history, for moderation and impersonation review.  auth.md §9, §10.
   *
   * Guarded by `account:read`, which is the capability that already means "may look at this
   * account": `player` holds it scoped to `self`, and `support`, `moderator` and `superadmin`
   * hold it for anyone. §9 says the history is "not publicly visible", and this is what makes
   * that true — it is deliberately not a field of the public projection (http-api.md §11.8
   * closes that schema to five keys) and not reachable without a capability check.
   */
  async function nameHistory({ actor, accountId = null, limit = 100 }) {
    const subjectId = accountId ?? actor?.accountId ?? null;
    if (!subjectId) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
    requireCapability(actor, 'account:read', { accountId: subjectId });
    return store.accountNameHistory.listForAccount(subjectId, { limit });
  }

  // ------------------------------------------------------------------ retention: the sweep

  /**
   * Delete pre-auth consent rows past their 30-day TTL.  http-api.md §3a.3.
   *
   * Expiry was enforced on read only, which answers correctly and retains forever: a row
   * nobody ever reads again is never deleted, and it is a consent record — evidence of a
   * legally significant answer — held past the life the contract grants it. Retention is an
   * obligation, not a cache policy, so something has to run on a clock. `auth/index.js` starts
   * that timer; this is also callable directly by a janitor or an ops task.
   *
   * @returns {Promise<number>} rows deleted.
   */
  async function sweepPreAuthConsent() {
    const removed = await store.preAuthConsent.sweepExpired(iso(clock.now()));
    if (removed) logger?.info?.('consent.sweep', { removed });
    return removed;
  }

  return {
    projectProfile,
    eligibilityPreflight,
    getConsent, putConsent,
    signup, signin,
    recoveryStart, recoveryComplete,
    verificationResend, verificationComplete,
    termsGet, termsAccept,
    changeDisplayName, checkDisplayName, nameHistory,
    sweepPreAuthConsent,
  };
}
