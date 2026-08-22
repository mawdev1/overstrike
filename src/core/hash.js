/**
 * Pure-JS SHA-256 / HMAC-SHA256 and a stable-JSON canonicalizer.
 *
 * `extraction.js` (`docs/contracts/extraction-match.md` §3.1.1) needs a deterministic,
 * dependency-free HMAC-SHA256 to derive per-container loot seeds, and a stable digest for
 * `evidenceRef` (§7) — the same role `platform/src/shared/evidenceDigest.js` plays for match
 * evidence, duplicated here rather than imported because `src/game/**` is bundled for the
 * browser by Vite and must never pull in `node:crypto` or a platform-only package.
 *
 * No external dependency, no Node built-in — `TextEncoder`/`DataView`/`Uint8Array` are the
 * only primitives used, all available in both the browser and Node.
 */

// eslint-disable-next-line no-bitwise
const rotr = (x, n) => (x >>> n) | (x << (32 - n));

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

/** FIPS 180-4 SHA-256 over a `Uint8Array`, returning a 32-byte `Uint8Array`. */
export function sha256(msg) {
  const ml = msg.length;
  const withPad = (((ml + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(withPad);
  buf.set(msg);
  buf[ml] = 0x80;
  const dv = new DataView(buf.buffer);
  const bitLenHi = Math.floor((ml * 8) / 0x100000000);
  const bitLenLo = (ml * 8) >>> 0;
  dv.setUint32(withPad - 8, bitLenHi, false);
  dv.setUint32(withPad - 4, bitLenLo, false);

  const h = H0.slice();
  const w = new Uint32Array(64);
  for (let offset = 0; offset < withPad; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i] >>> 0, false);
  return out;
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** RFC 2104 HMAC-SHA256. `key`/`msg` are `Uint8Array`s; returns a 32-byte `Uint8Array`. */
export function hmacSha256(key, msg) {
  const blockSize = 64;
  let k = key;
  if (k.length > blockSize) k = sha256(k);
  if (k.length < blockSize) {
    const padded = new Uint8Array(blockSize);
    padded.set(k);
    k = padded;
  }
  const opad = new Uint8Array(blockSize);
  const ipad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    opad[i] = k[i] ^ 0x5c;
    ipad[i] = k[i] ^ 0x36;
  }
  const inner = sha256(concatBytes(ipad, msg));
  return sha256(concatBytes(opad, inner));
}

export const utf8 = (str) => new TextEncoder().encode(str);
export const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Big-endian uint32 read at `offset` from a byte array — used to pull the low 32 bits. */
export function readUint32BE(bytes, offset) {
  return (((bytes[offset] << 24) | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0);
}

/**
 * Deterministic canonical JSON: object keys sorted, no whitespace. Two independently built
 * evidence records with the same content always digest identically regardless of insertion
 * order — the property `extraction-match.md` §7 / §9.7-8 verification relies on.
 */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256Hex = (bytes) => toHex(sha256(bytes));
