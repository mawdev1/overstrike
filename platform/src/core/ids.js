/**
 * ULIDs.  contracts/db-schema.md §1 rule 4.
 *
 * Time-sortable, so an index scan is roughly chronological and cursor pagination is stable
 * under concurrent insert — which UUIDv4 is not, and which for a match history is the
 * difference between "newest first" and "newest first, mostly".
 *
 * Crockford base32, 48 bits of time + 80 bits of randomness, 26 characters.
 */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';   // no I, L, O, U — unambiguous by design

let lastMs = -1;
let lastRandom = null;

function encodeTime(ms, len) {
  let out = '';
  for (let i = len - 1; i >= 0; i--) { out = ALPHABET[ms % 32] + out; ms = Math.floor(ms / 32); }
  return out;
}

function encodeRandom(bytes) {
  // 80 bits -> 16 chars. Read 5 bits at a time from a 10-byte buffer.
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 16; i++) { out = ALPHABET[Number(bits & 31n)] + out; bits >>= 5n; }
  return out;
}

/**
 * Monotonic within a millisecond: two ULIDs minted in the same tick still sort in creation
 * order, because the random component is incremented rather than re-rolled. Without this,
 * ids created in one loop iteration sort arbitrarily among themselves.
 */
export function ulid(nowMs = Date.now()) {
  if (nowMs === lastMs && lastRandom) {
    const buf = Buffer.from(lastRandom);
    for (let i = buf.length - 1; i >= 0; i--) { if (buf[i]++ !== 255) break; }
    lastRandom = buf;
  } else {
    lastMs = nowMs;
    lastRandom = randomBytes(10);
  }
  return encodeTime(nowMs, 10) + encodeRandom(lastRandom);
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const isUlid = (s) => typeof s === 'string' && ULID_RE.test(s);
