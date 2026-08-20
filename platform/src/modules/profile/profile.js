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

const NAME_MIN = 3;
const NAME_MAX = 16;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]*[A-Za-z0-9]$/;

/** auth.md §9 folding: NFKC + case fold. Uniqueness is enforced on this, not the raw name. */
export function foldName(name) {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

const DEFAULT_PRIVACY = { presenceVisibility: 'everyone', statsVisibility: 'everyone' };

/** Stored privacy is a jsonb blob; unknown or missing members fall back rather than throw. */
export function normalizePrivacy(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const presence = ['everyone', 'friends', 'nobody'].includes(p.presenceVisibility)
    ? p.presenceVisibility : DEFAULT_PRIVACY.presenceVisibility;
  const stats = ['everyone', 'nobody'].includes(p.statsVisibility)
    ? p.statsVisibility : DEFAULT_PRIVACY.statsVisibility;
  return { presenceVisibility: presence, statsVisibility: stats };
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

function projectModeration(account) {
  return {
    status: account.moderationStatus || 'clear',
    activeSanctions: account.activeSanctions || [],
  };
}

export function createProfileService({ store, clock = Date, nameChangeCooldownMs = 30 * 24 * 3600e3 }) {
  async function requireAccount(accountId) {
    const account = await store.accounts.byId(accountId);
    if (!account || account.deletedAt) throw new ApiError('NOT_FOUND', 'No such account.');
    return account;
  }

  /** §4 `GET /v1/profile/me`. Everything the owner is entitled to see about themselves. */
  async function getOwnProfile(accountId) {
    const account = await requireAccount(accountId);
    return {
      accountId: account.accountId,
      displayName: account.displayName,
      createdAt: account.createdAt,
      privacy: normalizePrivacy(account.privacy),
      consent: projectConsent(account),
      moderation: projectModeration(account),
      flags: { nameChangeAvailableAt: account.nameChangeAvailableAt ?? null },
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
      const availableAt = account.nameChangeAvailableAt ? Date.parse(account.nameChangeAvailableAt) : 0;
      if (Number.isFinite(availableAt) && availableAt > now) {
        throw new ApiError('NAME_CHANGE_COOLDOWN', 'You changed your name too recently.', {
          retryAfterMs: availableAt - now,
          details: { availableAt: account.nameChangeAvailableAt },
        });
      }
      await store.accounts.update(accountId, {
        displayName: name,
        displayNameFolded: folded,
        nameChangeAvailableAt: new Date(now + nameChangeCooldownMs).toISOString(),
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
      stats: statsVisible ? { statDefinitionVersion: account.statDefinitionVersion ?? null } : null,
      presence: presenceVisible ? (account.presence ?? null) : null,
      // Moderation state is owner-only; a public banner is a pillory, not a product feature.
      moderation: isSelf ? projectModeration(account) : null,
      consent: isSelf ? projectConsent(account) : null,
    };
  }

  return { getOwnProfile, patchProfile, getPublicProfile };
}
