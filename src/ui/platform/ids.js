const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;

/** @param {number} value @param {number} length */
function encodeBase32(value, length) {
  let remaining = value;
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result = ENCODING[remaining % 32] + result;
    remaining = Math.floor(remaining / 32);
  }
  return result;
}

/** @param {Crypto} cryptoImpl */
function randomPart(cryptoImpl) {
  const bytes = new Uint8Array(RANDOM_LENGTH);
  cryptoImpl.getRandomValues(bytes);
  let result = '';
  for (const byte of bytes) result += ENCODING[byte & 31];
  return result;
}

/**
 * Browser-safe ULID generator for request and event correlation. Tokens are uppercase
 * Crockford base32 and therefore accepted by the platform's strict ULID parser.
 *
 * @param {{now?: () => number, crypto?: Crypto}} [options]
 */
export function createUlidFactory(options = {}) {
  const now = options.now || Date.now;
  const cryptoImpl = options.crypto || globalThis.crypto;
  if (!cryptoImpl?.getRandomValues) throw new Error('Secure random generation is unavailable.');

  return () => {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 281474976710655) {
      throw new RangeError('ULID timestamp is outside the 48-bit range.');
    }
    return encodeBase32(timestamp, TIME_LENGTH) + randomPart(cryptoImpl);
  };
}

export const createUlid = createUlidFactory();

export const isUlid = (value) =>
  typeof value === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
