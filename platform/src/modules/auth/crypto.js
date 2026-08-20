/**
 * Cryptographic primitives for auth.  contracts/auth.md §3, §8.
 *
 * Everything here is `node:crypto` and nothing else. An auth module is the worst possible
 * place to take a dependency we do not control the supply chain of, and none of the four
 * things we need — an HMAC, a KDF, a CSPRNG, a constant-time compare — is worth a package.
 *
 * One rule runs through the whole file: a comparison on a secret is `timingSafeEqual`, never
 * `===`. A byte-at-a-time compare on a token is a token an attacker can guess a byte at a
 * time, and that is not a theoretical attack against a network service.
 */
import { createHmac, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** scrypt parameters. Cost is deliberate: this is the only defence a leaked hash gets. */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function hmac(secret, data) {
  return createHmac('sha256', secret).update(data).digest();
}

/**
 * Sign a payload into a compact `<body>.<sig>` string.
 *
 * Not JWT. JWT's `alg` header is a negotiation with the attacker about which algorithm to
 * verify with, and every implementation that honoured it has a CVE. Here the algorithm is
 * fixed by the verifier and is not in the token at all.
 */
export function sign(secret, payload) {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(hmac(secret, body))}`;
}

/** Verify and decode. Returns null on anything wrong — malformed, tampered, wrong key. */
export function verify(secret, token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1 || token.indexOf('.', dot + 1) !== -1) return null;
  const body = token.slice(0, dot);
  let sig;
  try { sig = Buffer.from(token.slice(dot + 1), 'base64url'); } catch { return null; }
  const expected = hmac(secret, body);
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(sig, expected)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}

/** A 256-bit opaque handle. Refresh tokens, recovery tokens, verification tokens. */
export const opaqueToken = () => b64u(randomBytes(32));

/**
 * What we store for an opaque token: its SHA-256, never the token itself.
 *
 * A refresh-token table read out of a backup should not be a set of usable credentials. The
 * token has 256 bits of entropy, so a plain hash is enough — there is nothing to brute force
 * and therefore nothing for a KDF to slow down.
 */
export const handleOf = (token) => createHash('sha256').update(String(token)).digest('hex');

/**
 * Email lookup key. Keyed, not a bare hash: `accounts.email_hash` is an unsalted lookup
 * column, and an unkeyed hash of an email address is trivially reversed from a wordlist of
 * addresses. Normalised first so `A@x.com` and `a@x.com ` are the same account.
 */
export const emailHash = (secret, email) =>
  hmac(secret, `email:${String(email).trim().toLowerCase()}`).toString('hex');

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64u(salt)}$${b64u(key)}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, N, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = scryptSync(password, Buffer.from(salt, 'base64url'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
}
