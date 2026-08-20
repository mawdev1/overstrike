/**
 * Profile.  http-api.md §4, §3a.3, db-schema.md §2.
 *
 * Two decisions this file encodes rather than re-derives per call site:
 *
 *  1. **`consent` is projected from the typed columns**, never from `accounts.privacy`. §3a.3
 *     supersedes the sketch that put it in the JSON blob: a legally significant decision
 *     belongs in constrained columns, and `null` means UNDECIDED, which is not the same as a
 *     recorded "no". The field is object-or-null and never absent.
 *  2. **A hidden field is `null`, never a 403.** Privacy filtering that answers 403 tells the
 *     caller the field exists and is worth hiding, which is the same leak with an error code
 *     on it. The public projection always returns 200 with the visible subset; only a subject
 *     that does not exist is a 404.
 */
import { createHash } from 'node:crypto';
import { ApiError } from '../../core/errors.js';
import { STAT_DEFINITION_VERSION } from './stats.js';

// The 3–16 length rule lives with the rest of the name policy in `auth/names.js` (auth.md §9).
// The copies that used to sit here named the same numbers a second time and were enforced by
// nothing, which is how a second, weaker policy starts.

/** §8: gameplay keys are retained 24 h. Nothing on this endpoint is value-bearing. */
const IDEMPOTENCY_TTL_MS = 24 * 3600e3;

/**
 * Display-name policy lives in ONE place: `auth/names.js`.  auth.md §9.
 *
 * This module previously carried its own `foldName` — NFKC plus lowercase, no confusable
 * folding, no script restriction — and it owns `PATCH /v1/profile/me`, the endpoint players
 * actually rename through. Two folding implementations for one uniqueness constraint is the
 * failure auth.md §9 warns about: the weaker one decides, and the constraint is only as strong
 * as the weakest writer. An ASCII-only regex here happened to mask it, which is luck, not a
 * design.
 *
 * Re-exported so existing importers keep working while there is exactly one implementation.
 */
import { fold as foldName, normaliseDisplayName } from '../auth/names.js';

// Re-exported so existing importers keep working while there is exactly one implementation.
export { foldName, normaliseDisplayName };

/** §4: the two closed enums. `friends` exists for presence and NOT for stats. */
const PRESENCE_VISIBILITY = ['everyone', 'friends', 'nobody'];
const STATS_VISIBILITY = ['everyone', 'nobody'];

/**
 * Stored privacy is a jsonb blob, so anything can be in it: a value from a newer client, a
 * mis-cased `NOBODY`, a `friends` the stats enum does not have, a null from a half-written row.
 *
 * An unrecognised visibility falls to the MOST RESTRICTIVE member of its enum, never to
 * `everyone`. Failing open here publishes a career the subject asked us to hide, and does it
 * silently — the subject sees their own setting and has no way to learn it was not honoured.
 */
export function normalizePrivacy(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    presenceVisibility: PRESENCE_VISIBILITY.includes(p.presenceVisibility)
      ? p.presenceVisibility : 'nobody',
    statsVisibility: STATS_VISIBILITY.includes(p.statsVisibility)
      ? p.statsVisibility : 'nobody',
  };
}

const PRIVACY_ENUMS = {
  presenceVisibility: PRESENCE_VISIBILITY,
  statsVisibility: STATS_VISIBILITY,
};

/**
 * Validate a submitted `privacy` patch against the two closed §4 enums.
 *
 * A WRITE is rejected, not folded to the most restrictive member. `normalizePrivacy` fails
 * closed because it is reading a jsonb blob that may hold anything and still has to answer;
 * a write has an author who can be told. Silently storing `nobody` when the client asked for
 * `friends` is the clamped-setting failure from §11.9 wearing a privacy costume: the player
 * sees a value they did not choose and cannot tell that they did not get it.
 *
 * @returns {{errors: Array<object>, value: object}} — `value` is the patch to merge.
 */
export function validatePrivacyPatch(raw) {
  const errors = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: [{ key: 'privacy', reason: 'type', expected: 'object' }], value: {} };
  }
  const value = {};
  for (const [key, given] of Object.entries(raw)) {
    // Own-property lookup: `privacy: { "toString": … }` must not find a member on the
    // prototype chain and treat it as a documented field.
    if (!Object.hasOwn(PRIVACY_ENUMS, key)) {
      errors.push({ key: `privacy.${key}`, reason: 'unknown-field' });
      continue;
    }
    const allowed = PRIVACY_ENUMS[key];
    if (!allowed.includes(given)) {
      errors.push({ key: `privacy.${key}`, reason: 'enum', allowed, got: given });
      continue;
    }
    value[key] = given;
  }
  return { errors, value };
}

/**
 * Key-sorted JSON, so `{a:1,b:2}` and `{b:2,a:1}` are the SAME request under §8.
 *
 * `JSON.stringify` preserves insertion order, and a client that serialises its patch from an
 * object literal has no contract with us about that order. Hashing the raw text would make a
 * genuine retry look like key reuse and answer a correct client with 409.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  // KNOWN LIVE SURVIVOR (scripts/mutatetest.mjs), deliberately not claimed equivalent.
  //
  // Deleting this line makes the serialiser non-injective: an array and an object with the same
  // numeric keys both render as `{"0":…,"1":…}`, so two different §8 payloads share one
  // `requestHash` and the second is answered with the first's stored response instead of
  // IDEMPOTENCY_KEY_REUSED. That is the same hole `resultHash` had in profile/stats.js, where it
  // IS reachable and is now tested.
  //
  // It is not tested HERE because no patch that reaches `patchRequestHash` can contain an array:
  // the hash is only ever taken of a payload that then executes and is stored, `patchProfile`
  // accepts exactly `displayName` and `privacy`, and `validatePrivacyPatch` has already refused
  // a non-object `privacy` by this point. That makes the mutant unreachable today — which is a
  // statement about two validators upstream, not about this function, so it is recorded as a
  // survivor rather than dressed up as an equivalent mutant. Widen the accepted patch set and
  // this line needs a test, not a re-reading of this comment.
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * §8 `requestHash`. Scoped by endpoint as well as payload: the key is stored under
 * `(key, actor)`, and the same client may legitimately use one key for one logical operation
 * across endpoints — a bare payload hash would let `PATCH /profile/me` replay the response of
 * whatever else was submitted under that key first.
 */
const patchRequestHash = (patch) =>
  createHash('sha256').update(`PATCH /v1/profile/me\n${stableStringify(patch ?? {})}`).digest('hex');

/** §3a.3: object-or-null, from `consent_telemetry` / `consent_policy_ver` / `consent_decided_at`. */
export function projectConsent(account) {
  if (account.consentTelemetry === null || account.consentTelemetry === undefined) return null;
  return {
    telemetryPersonal: !!account.consentTelemetry,
    policyVersion: account.consentPolicyVer ?? null,
    decidedAt: account.consentDecidedAt ?? null,
  };
}

/**
 * §4 moderation state, from columns that exist.
 *
 * `accounts.moderation_status` and `accounts.active_sanctions` are in no schema — reading them
 * returned `undefined` forever, which the `||` then dressed up as a clean account. The real
 * source is `accounts.status` (0001, `active|restricted|banned|deleted`) for the summary, and
 * the `sanctions` table (0006) for the list. The store has no sanctions accessor yet, so the
 * list is supplied by an injected reader when one exists and is an honest empty array when it
 * does not — an empty list is at least a state the schema can produce.
 */
const MODERATION_STATUS = {
  active: 'clear', restricted: 'restricted', banned: 'banned', deleted: 'banned',
};

function projectModeration(account, activeSanctions = []) {
  return {
    status: MODERATION_STATUS[account.status] ?? 'clear',
    activeSanctions,
  };
}

/**
 * §4 `flags.nameChangeAvailableAt` is DERIVED, not stored. The stored column is
 * `accounts.name_changed_at` (migration 0008); the availability instant is that plus the
 * cooldown. Storing the derived instant is what broke the feature — it was written to a column
 * no schema declares, so the read side was permanently undefined and the cooldown never fired.
 */
export function nameChangeAvailableAt(account, cooldownMs) {
  const changedAt = Date.parse(account?.nameChangedAt ?? '');
  if (!Number.isFinite(changedAt)) return null;      // never changed: available now
  return new Date(changedAt + cooldownMs).toISOString();
}

export function createProfileService({
  store, clock = Date, nameChangeCooldownMs = 30 * 24 * 3600e3,
  // Presence is a live lobby-socket value (§5) and has no column; a reader is injected when a
  // presence service exists. Defaulting to null keeps the key present without inventing state.
  readPresence = null,
  readActiveSanctions = null,
  /**
   * The canonical rename, `auth.service.changeDisplayName`, injected by the composition root.
   *
   * A rename is an identity change: auth.md §9 requires the previous name to be retained for
   * impersonation review, §10 requires the audit row, and `account.name_changed` is a
   * catalogued event type. All three are written by that one function. Reimplementing the
   * store write here — which is what this service used to do — produced a rename with no
   * event, no audit row and no history, and a second copy of the folding rules to drift.
   */
  changeDisplayName = null,
}) {
  async function requireAccount(accountId) {
    const account = await store.accounts.byId(accountId);
    if (!account || account.deletedAt) throw new ApiError('NOT_FOUND', 'No such account.');
    return account;
  }

  const sanctionsFor = async (accountId) => (readActiveSanctions ? await readActiveSanctions(accountId) : []);

  /** §4 `GET /v1/profile/me`. Everything the owner is entitled to see about themselves. */
  async function getOwnProfile(accountId) {
    const account = await requireAccount(accountId);
    return {
      accountId: account.accountId,
      displayName: account.displayName,
      createdAt: account.createdAt,
      privacy: normalizePrivacy(account.privacy),
      consent: projectConsent(account),
      moderation: projectModeration(account, await sanctionsFor(accountId)),
      flags: { nameChangeAvailableAt: nameChangeAvailableAt(account, nameChangeCooldownMs) },
    };
  }

  /**
   * The actor a capability check reads (`events/rbac.js`).
   *
   * Handlers hand over the authenticated actor. Internal callers and tests hold only an
   * account id, and for those the actor is synthesised at the LOWEST privilege that can do
   * the job — one `player` role, targeting itself. Synthesising anything else here would be
   * this module minting authority it was not given.
   */
  function actorFor(actorOrId) {
    if (actorOrId && typeof actorOrId === 'object') {
      if (!actorOrId.accountId) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
      return actorOrId;
    }
    if (!actorOrId) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
    return { kind: 'player', id: actorOrId, accountId: actorOrId, role: 'player', roles: ['player'] };
  }

  /**
   * §4 / §11.8 `PATCH /v1/profile/me` — `{ displayName?, privacy? }`.
   *
   * `privacy` is patchable and used not to be: the allowlist named `displayName` alone, so the
   * two visibility settings §4 documents as writable were answered `unknown-field` and a
   * player had no way to hide their career at all. Stats stay absent from the accepted set on
   * purpose — they change through `applyMatchResult` or not at all — and an unknown field is
   * rejected rather than ignored so a client cannot believe it wrote one.
   *
   * §8: `Idempotency-Key` is honoured here rather than in the handler because the replay has
   * to be atomic with the write it replays. Same key + same payload returns the STORED
   * response without re-executing; same key + a different payload is `IDEMPOTENCY_KEY_REUSED`.
   */
  async function patchProfile(actorOrId, patch, { idempotencyKey = null, correlationId = null } = {}) {
    const actor = actorFor(actorOrId);
    const accountId = actor.accountId;

    const allowed = new Set(['displayName', 'privacy']);
    const unknown = Object.keys(patch || {}).filter((k) => !allowed.has(k));
    if (unknown.length) {
      throw new ApiError('VALIDATION_FAILED', 'Unknown profile fields.', {
        details: { fields: unknown.map((key) => ({ key, reason: 'unknown-field' })) },
      });
    }
    const wantsName = 'displayName' in (patch || {});
    const wantsPrivacy = 'privacy' in (patch || {});
    if (!wantsName && !wantsPrivacy) {
      throw new ApiError('VALIDATION_FAILED', 'Nothing to change.', {
        details: { fields: [{ key: 'displayName', reason: 'required' }] },
      });
    }

    // Validate BEFORE the idempotency row is consulted: a request that could never execute
    // must not consume a key, or the client's retry of the corrected request is refused as
    // reuse of a key that never did anything.
    const privacyPatch = wantsPrivacy ? validatePrivacyPatch(patch.privacy) : { errors: [], value: {} };
    if (privacyPatch.errors.length) {
      throw new ApiError('VALIDATION_FAILED', 'One or more privacy settings were rejected.', {
        details: { fields: privacyPatch.errors },
      });
    }
    await requireAccount(accountId);

    if (!idempotencyKey) return execute();

    const requestHash = patchRequestHash(patch);
    // One transaction around read-decide-write: without it two retries that arrive together
    // both find no prior row and both execute, which is the duplicate the key exists to stop.
    return store.tx(async (tx) => {
      // Serialise on the key BEFORE reading it — the same fix `applyMatchResult` needed.
      //
      // A transaction alone is not enough. `idempotency.get` takes no lock, and there is no row
      // to lock on the first attempt anyway, so on Postgres ten concurrent retries of one key
      // all read `prior = null` inside their own transactions and all execute. The rename then
      // runs N times (N-1 of them answering NAME_CHANGE_COOLDOWN to a client that sent one
      // request), and `idempotency.put`'s first-writer-wins turns the losers' correct retry
      // into IDEMPOTENCY_KEY_REUSED. `acquire` is a transaction-scoped advisory lock on
      // Postgres and a documented no-op on memory, where every transaction is already
      // serialised — so the guard is expressed once, here, rather than per adapter.
      if (store.idempotency.acquire) await store.idempotency.acquire(idempotencyKey, accountId, tx);
      const prior = await store.idempotency.get(idempotencyKey, accountId, tx);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'That idempotency key was used for a different request.', {
            details: { key: idempotencyKey },
          });
        }
        return prior.responseBody;      // §8: the stored response, not a re-execution
      }
      const response = await execute(tx);
      await store.idempotency.put({
        key: idempotencyKey,
        actorId: accountId,
        requestHash,
        responseStatus: 200,
        responseBody: response,
        createdAt: new Date(clock.now()).toISOString(),
        expiresAt: new Date(clock.now() + IDEMPOTENCY_TTL_MS).toISOString(),
      }, tx);
      return response;
    });

    async function execute(tx) {
      if (wantsPrivacy) {
        // A PATCH is partial: a body naming only `statsVisibility` must not reset presence to
        // a default the player never chose. Merged onto the normalised current value, which
        // is also where a junk stored blob is repaired rather than carried forward.
        const account = await requireAccount(accountId);
        await store.accounts.update(accountId, {
          privacy: { ...normalizePrivacy(account.privacy), ...privacyPatch.value },
        }, tx);
      }
      if (wantsName) {
        if (!changeDisplayName) {
          // Refusing beats renaming without the §10 audit row, the `account.name_changed`
          // event, and the retained previous name auth.md §9 requires for impersonation
          // review. A rename we cannot account for is one we are not permitted to perform.
          throw new ApiError('SERVICE_UNAVAILABLE', 'Renaming is unavailable right now.', {
            details: { reason: 'identity-service-unavailable' },
          });
        }
        await changeDisplayName({ actor, displayName: patch.displayName, correlationId });
      }
      return getOwnProfile(accountId);
    }
  }

  /**
   * Whether a viewer may see the subject's stats and presence.
   *
   * Deliberately NOT a response field. §11.8 closes the public projection to five keys, and a
   * `statsVisible` flag riding along in the body both breaks that schema and announces the
   * subject's setting to everyone who asks. The endpoints that need the decision — stats and
   * match history — call this.
   */
  async function visibilityFor(subjectId, viewerId) {
    const account = await requireAccount(subjectId);
    const privacy = normalizePrivacy(account.privacy);
    const isSelf = subjectId === viewerId;
    return {
      isSelf,
      // The owner sees everything about themselves: privacy is about other people.
      stats: isSelf || privacy.statsVisibility === 'everyone',
      presence: isSelf || privacy.presenceVisibility === 'everyone',
    };
  }

  /**
   * §4 / §11.8 `GET /v1/profile/:accountId` — the public projection, and it is a CLOSED
   * schema: `accountId`, `displayName`, `createdAt`, `stats`, `presence`. Nothing else.
   *
   * It used to return `moderation`, `consent` and a `statsVisible` flag as well. `moderation`
   * and `consent` were self-only and so leaked nothing to a stranger, but a closed schema that
   * grows fields for one caller is a schema no client can rely on, and both are already served
   * by `GET /profile/me`, which is the endpoint that owns them. `statsVisible` was worse: it
   * published the setting whose whole purpose is not to be published.
   *
   * A hidden field is null — never omitted, never a 403, both of which disclose that the
   * setting exists and is set.
   */
  async function getPublicProfile(subjectId, viewerId) {
    const account = await requireAccount(subjectId);
    const visible = await visibilityFor(subjectId, viewerId);

    return {
      accountId: account.accountId,
      displayName: account.displayName,
      createdAt: account.createdAt,
      // The definitions that produced the counters are a property of the stats service, not a
      // column on the account — `accounts.stat_definition_version` does not exist.
      stats: visible.stats ? { statDefinitionVersion: STAT_DEFINITION_VERSION } : null,
      presence: visible.presence && readPresence ? (await readPresence(subjectId)) ?? null : null,
    };
  }

  return { getOwnProfile, patchProfile, getPublicProfile, visibilityFor };
}
