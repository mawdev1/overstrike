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
import { ApiError } from '../../core/errors.js';
import { STAT_DEFINITION_VERSION } from './stats.js';

const NAME_MIN = 3;
const NAME_MAX = 16;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]*[A-Za-z0-9]$/;

/** auth.md §9 folding: NFKC + case fold. Uniqueness is enforced on this, not the raw name. */
export function foldName(name) {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

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
   * §4 `PATCH /v1/profile/me` — display name only in this service. Stats are absent from the
   * accepted field set on purpose: they change through `applyMatchResult` or not at all, and
   * an unknown field is rejected rather than ignored so a client cannot believe it wrote one.
   */
  async function patchProfile(accountId, patch) {
    const allowed = new Set(['displayName']);
    const unknown = Object.keys(patch || {}).filter((k) => !allowed.has(k));
    if (unknown.length) {
      throw new ApiError('VALIDATION_FAILED', 'Unknown profile fields.', {
        details: { fields: unknown.map((key) => ({ key, reason: 'unknown-field' })) },
      });
    }
    if (!('displayName' in (patch || {}))) {
      throw new ApiError('VALIDATION_FAILED', 'Nothing to change.', {
        details: { fields: [{ key: 'displayName', reason: 'required' }] },
      });
    }

    const account = await requireAccount(accountId);
    const name = String(patch.displayName ?? '').normalize('NFKC').trim();
    if (name.length < NAME_MIN || name.length > NAME_MAX || !NAME_RE.test(name)) {
      throw new ApiError('NAME_POLICY_VIOLATION', 'That display name is not allowed.', {
        details: { min: NAME_MIN, max: NAME_MAX },
      });
    }

    const folded = foldName(name);
    if (folded !== foldName(account.displayName || '')) {
      const taken = await store.accounts.byNameFolded(folded);
      if (taken && taken.accountId !== accountId) {
        throw new ApiError('NAME_TAKEN', 'That name is taken.');
      }
      const now = clock.now();
      const availableAt = nameChangeAvailableAt(account, nameChangeCooldownMs);
      const availableAtMs = availableAt === null ? 0 : Date.parse(availableAt);
      if (availableAtMs > now) {
        throw new ApiError('NAME_CHANGE_COOLDOWN', 'You changed your name too recently.', {
          retryAfterMs: availableAtMs - now,
          details: { availableAt },
        });
      }
      // `name_changed_at` is the column that exists (0008). The availability instant is derived
      // from it on the way out, so there is one fact stored and one place it can be wrong.
      await store.accounts.update(accountId, {
        displayName: name,
        displayNameFolded: folded,
        nameChangedAt: new Date(now).toISOString(),
      });
    }
    return getOwnProfile(accountId);
  }

  /**
   * §4 `GET /v1/profile/:accountId` — public projection, filtered by the SUBJECT's privacy.
   *
   * A hidden field is null. The owner viewing themselves sees everything, because privacy is
   * about other people.
   */
  async function getPublicProfile(subjectId, viewerId) {
    const account = await requireAccount(subjectId);
    const privacy = normalizePrivacy(account.privacy);
    const isSelf = subjectId === viewerId;

    const statsVisible = isSelf || privacy.statsVisibility === 'everyone';
    const presenceVisible = isSelf || privacy.presenceVisibility === 'everyone';

    return {
      accountId: account.accountId,
      displayName: account.displayName,
      createdAt: account.createdAt,
      // Every key present in both states so one renderer handles both and a missing key is a
      // bug rather than a state (the §4.3 convention, applied here for the same reason).
      statsVisible,
      // The definitions that produced the counters are a property of the stats service, not a
      // column on the account — `accounts.stat_definition_version` does not exist.
      stats: statsVisible ? { statDefinitionVersion: STAT_DEFINITION_VERSION } : null,
      presence: presenceVisible && readPresence ? (await readPresence(subjectId)) ?? null : null,
      // Moderation state is owner-only; a public banner is a pillory, not a product feature.
      moderation: isSelf ? projectModeration(account, await sanctionsFor(subjectId)) : null,
      consent: isSelf ? projectConsent(account) : null,
    };
  }

  return { getOwnProfile, patchProfile, getPublicProfile };
}
