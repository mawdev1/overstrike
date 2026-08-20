/**
 * Deterministic identifiers for the stub layer.  contracts/db-schema.md §1 rule 4.
 *
 * `core/ids.js` mints real ULIDs from `Date.now()` and `randomBytes`, which is correct for the
 * platform and fatal here: both halves are different on every run, so a scenario replayed twice
 * would differ in every id it returns.
 *
 * These ids are the same 26-character Crockford base32 shape and pass `core/ids.js` `isUlid`,
 * but the randomness is replaced by a hash of a caller-supplied seed string. Same seed, same
 * id, forever. The seed is always derived from the scenario and the step within it — never from
 * the `clientSessionId`, because a response containing anything session-derived would differ
 * between two fresh sessions replaying the same scenario.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // no I, L, O, U — same table as core/ids.js

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

/** xorshift32, seeded from the text. Not cryptographic; it only has to be repeatable. */
function* stream(seedText) {
  let x = fnv1a(seedText) || 0x9e3779b9;
  for (;;) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    yield x;
  }
}

function encodeTime(ms) {
  let out = '';
  let v = ms;
  for (let i = 0; i < 10; i++) { out = ALPHABET[v % 32] + out; v = Math.floor(v / 32); }
  return out;
}

/** A ULID-shaped id: 10 chars of timestamp, 16 chars derived from `seedText`. */
export function stubUlid(seedText, atMs) {
  const gen = stream(seedText);
  let out = encodeTime(atMs);
  for (let i = 0; i < 16; i++) out += ALPHABET[gen.next().value % 32];
  return out;
}

/**
 * An opaque token — receipts, tickets, access tokens.
 *
 * The contract says only that these are opaque and signed, so the stub makes them readable on
 * purpose: a developer reading a network log should be able to tell an eligibility receipt from
 * a lobby ticket without decoding anything. They carry no secret because they protect nothing.
 */
export function stubToken(kind, seedText) {
  return `stub.${kind}.${fnv1a(seedText).toString(32)}`;
}
