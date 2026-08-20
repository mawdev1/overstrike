/**
 * Display-name policy.  contracts/auth.md §9.
 *
 * Two names that a player cannot tell apart are the same name. That is the whole design: the
 * uniqueness key is a *fold*, not the string, because impersonating a known player with a
 * homoglyph is the cheapest social attack there is and it lands on a game that gets a
 * marketplace in P8.
 */
import { ApiError } from '../../core/errors.js';

export const MIN_LENGTH = 3;
export const MAX_LENGTH = 16;
export const COOLDOWN_MS = 30 * 24 * 3600 * 1000;

/**
 * Unicode letters/digits, `_`, `-`, single interior spaces.
 *
 * Written as groups separated by single spaces rather than as "no double space" so leading,
 * trailing, and doubled spaces are all rejected by the same rule instead of three checks that
 * can disagree.
 */
const CHARSET = /^[\p{L}\p{N}_-]+(?: [\p{L}\p{N}_-]+)*$/u;

/**
 * Homoglyph folding table — the UTS #39 confusable classes that actually get used against a
 * player-name field. Cyrillic and Greek carry the attack because they render identically to
 * Latin in every UI font we ship.
 */
const CONFUSABLES = new Map(Object.entries({
  // Cyrillic
  'а': 'a', 'в': 'b', 'е': 'e', 'ѕ': 's', 'і': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h',
  'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ԁ': 'd', 'ɡ': 'g', 'һ': 'h',
  'ӏ': 'l', 'ԛ': 'q', 'ԝ': 'w',
  // Greek
  'α': 'a', 'β': 'b', 'ε': 'e', 'ζ': 'z', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o',
  'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ϲ': 'c', 'ϳ': 'j',
}));

/**
 * Leet substitutions, applied **only** to the reserved-word check.
 *
 * Deliberately not part of the uniqueness fold. Uniqueness folding must be conservative,
 * because a false collision permanently denies a legitimate name — collapsing digits into
 * letters would make `Player1` and `Playerl` the same person. Reserved matching has the
 * opposite risk profile: the cost of an over-eager match is one refused name, and `adm1n`
 * costs an attacker nothing.
 */
const LEET = new Map(Object.entries({ '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' }));

/** Names nobody may hold, because holding one is a claim of authority. */
const RESERVED = new Set([
  'admin', 'administrator', 'moderator', 'mod', 'support', 'helpdesk', 'help', 'staff',
  'system', 'root', 'owner', 'official', 'overstrike', 'security', 'billing', 'finance',
  'superadmin', 'service', 'anonymous', 'deleted', 'null', 'undefined',
]);

/**
 * The uniqueness key.
 *
 * NFKC first (so full-width and ligature forms collapse), then homoglyphs, then case. The
 * order matters: folding case before NFKC leaves compatibility forms unfolded.
 */
export function fold(name) {
  const normalised = String(name).normalize('NFKC').toLowerCase();
  let out = '';
  for (const ch of normalised) out += CONFUSABLES.get(ch) ?? ch;
  return out.normalize('NFKC');
}

/** Reserved matching ignores separators and leet, so `a-d-m-1-n` is not a way around the list. */
function reservedKey(folded) {
  let out = '';
  for (const ch of folded.replace(/[\s_-]/gu, '')) out += LEET.get(ch) ?? ch;
  return out;
}

/**
 * Validate and return `{ displayName, folded }`.
 *
 * Throws `NAME_POLICY_VIOLATION` with `details.rule` naming which rule failed — the UI has to
 * be able to say *why* without matching on prose.
 */
export function normaliseDisplayName(raw) {
  if (typeof raw !== 'string') {
    throw new ApiError('VALIDATION_FAILED', 'A display name is required.',
      { details: { fields: [{ path: 'displayName', rule: 'required', message: 'Required.' }] } });
  }
  const displayName = raw.normalize('NFKC').trim();
  const chars = [...displayName].length;
  if (chars < MIN_LENGTH || chars > MAX_LENGTH) {
    throw new ApiError('NAME_POLICY_VIOLATION', `Names are ${MIN_LENGTH}–${MAX_LENGTH} characters.`,
      { details: { rule: 'length' } });
  }
  if (!CHARSET.test(displayName)) {
    throw new ApiError('NAME_POLICY_VIOLATION',
      'Names use letters, numbers, underscore, hyphen, and single spaces.',
      { details: { rule: 'charset' } });
  }
  const folded = fold(displayName);
  if (RESERVED.has(reservedKey(folded))) {
    throw new ApiError('NAME_POLICY_VIOLATION', 'That name is reserved.', { details: { rule: 'reserved' } });
  }
  return { displayName, folded };
}

/** 30 days between changes. Throws with `details.availableAt`, which the UI displays. */
export function assertCooldown(lastChangedAt, nowMs) {
  if (!lastChangedAt) return;
  const last = new Date(lastChangedAt).getTime();
  const availableAtMs = last + COOLDOWN_MS;
  if (nowMs < availableAtMs) {
    throw new ApiError('NAME_CHANGE_COOLDOWN', 'You changed your name recently.', {
      details: { availableAt: new Date(availableAtMs).toISOString() },
      retryAfterMs: availableAtMs - nowMs,
    });
  }
}
