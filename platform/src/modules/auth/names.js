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
 * Confusable defence, part 1 of 2: **a name resolves to a single script**.
 *
 * The previous defence was a 36-entry hand table of lowercase Cyrillic and Greek, and a hand
 * table is the wrong shape for this problem: Unicode has confusables for Latin in Armenian,
 * Coptic, Cherokee, Lisu, Osage and more, and enumerating them is a race nobody wins. UTS #39
 * §5.2 gives the durable rule instead — every character of an identifier must be able to come
 * from one script — which refuses `Ravօn` (Latin + Armenian) and `Ⲟnyx` (Coptic + Latin)
 * without either pair ever having to be listed.
 *
 * This is the primary control, chosen over shipping a full `confusables.txt`: the data file is
 * ~6000 mappings that must be re-synced with every Unicode release, and it still would not
 * refuse a *whole-script* impersonation, which the single-script rule does not need to fold at
 * all. Part 2 below then folds the confusables the rule cannot see — the ones that are
 * genuinely Latin.
 */
const SCRIPTS = [
  'Latin', 'Greek', 'Cyrillic', 'Armenian', 'Hebrew', 'Arabic', 'Syriac', 'Thaana',
  'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil', 'Telugu', 'Kannada',
  'Malayalam', 'Sinhala', 'Thai', 'Lao', 'Tibetan', 'Myanmar', 'Georgian', 'Hangul',
  'Ethiopic', 'Cherokee', 'Khmer', 'Mongolian', 'Hiragana', 'Katakana', 'Han', 'Bopomofo',
  'Coptic',
];

/** Script_Extensions, not Script: `ー` and the CJK punctuation belong to several at once. */
const SCRIPT_TESTS = SCRIPTS.map((name) => [name, new RegExp(`\\p{Script_Extensions=${name}}`, 'u')]);
const NEUTRAL = /[\p{Script_Extensions=Common}\p{Script_Extensions=Inherited}]/u;

/**
 * UTS #39 §5.2 augmented script sets. Japanese, Korean and Chinese names legitimately mix
 * scripts, and refusing them would be reading "single script" as "single writing system",
 * which it is not.
 */
const AUGMENTED = [
  new Set(['Han', 'Hiragana', 'Katakana']),
  new Set(['Han', 'Hangul']),
  new Set(['Han', 'Bopomofo']),
];

const scriptsOf = (ch) => {
  const out = new Set();
  for (const [name, re] of SCRIPT_TESTS) if (re.test(ch)) out.add(name);
  return out;
};

/**
 * `{ ok: true }` when every character can come from one script, `{ ok: false }` otherwise.
 * Script-neutral characters (digits, `_`, `-`, space) carry no script and constrain nothing.
 */
export function resolveScript(name) {
  let resolved = null;
  const perChar = [];
  for (const ch of name) {
    if (NEUTRAL.test(ch)) continue;
    const set = scriptsOf(ch);
    // A character in no script this file knows is refused rather than waved through: an
    // allow-list that fails open is not an allow-list.
    if (set.size === 0) return { ok: false, scripts: [] };
    perChar.push(set);
    resolved = resolved === null ? set : new Set([...resolved].filter((s) => set.has(s)));
  }
  if (resolved === null) return { ok: true, scripts: [] };              // digits and separators only
  if (resolved.size > 0) return { ok: true, scripts: [...resolved] };
  for (const allowed of AUGMENTED) {
    if (perChar.every((set) => [...set].some((s) => allowed.has(s)))) {
      return { ok: true, scripts: [...allowed] };
    }
  }
  return { ok: false, scripts: [] };
}

/**
 * Confusable defence, part 2 of 2: fold the look-alikes that ARE Latin.
 *
 * `ɑlpha`, `ᴀʙᴄ` and `Rıch` all resolve to a single script, so §5.2 has nothing to say about
 * them and the fold has to. The Cyrillic and Greek rows stay because a *whole-script* Cyrillic
 * name passes the script rule and must still collide with its Latin twin.
 */
const CONFUSABLES = new Map(Object.entries({
  // Cyrillic
  'а': 'a', 'в': 'b', 'е': 'e', 'ѕ': 's', 'і': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h',
  'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ԁ': 'd', 'һ': 'h',
  'ӏ': 'l', 'ԛ': 'q', 'ԝ': 'w', 'ғ': 'f', 'ԍ': 'g',
  // Greek
  'α': 'a', 'β': 'b', 'ε': 'e', 'ζ': 'z', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o',
  'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ϲ': 'c', 'ϳ': 'j', 'ϱ': 'p', 'ϵ': 'e',
  // Latin small capitals (U+1D00 block and friends). Same script, same glyph shape, and the
  // cheapest way to register `ᴀᴅᴍɪɴ` next to `Admin` before this row existed.
  'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i',
  'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ǫ': 'q', 'ʀ': 'r',
  'ꜱ': 's', 'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z',
  // Latin/IPA letters drawn identically to the ASCII letter they impersonate.
  'ɑ': 'a', 'ᴃ': 'b', 'ɡ': 'g', 'ɥ': 'h', 'ı': 'i', 'ɩ': 'i', 'ȷ': 'j', 'ɭ': 'l', 'ɫ': 'l',
  'ɵ': 'o', 'ɸ': 'o', 'ʁ': 'r', 'ʂ': 's', 'ʈ': 't', 'ʋ': 'v', 'ʍ': 'w', 'ʎ': 'y', 'ʐ': 'z',
  'ǀ': 'l', 'ǃ': 'i', 'ʼ': "'",
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
  // §9: homoglyph impersonation is "the cheapest social attack there is". A name whose
  // characters cannot all come from one script is refused outright rather than folded, because
  // the mixed-script forms are what the fold cannot enumerate.
  if (!resolveScript(displayName).ok) {
    throw new ApiError('NAME_POLICY_VIOLATION', 'Names use characters from a single script.',
      { details: { rule: 'mixed-script' } });
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
