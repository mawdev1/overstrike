/**
 * The request preconditions every stub response must clear first.
 * contracts/http-api.md §1 (X-Client-Build), §2 (auth classes), contracts/errors.md §3.
 *
 * The stub layer intercepts BEFORE routing — deliberately, because it has to answer P2 surfaces
 * the platform has not built yet (core/http.js, "The stub layer runs BEFORE routing"). The cost
 * of that position is that a stub request skips the §1 build check and every auth middleware,
 * so the fixture layer accepted requests production refuses.
 *
 * That is not a cosmetic gap. A fixture that answers a request with no `X-Client-Build` teaches
 * the client that the header is optional; a fixture that answers an `A` endpoint with no
 * credential teaches it that the endpoint is public. Both are lessons the shell unlearns on the
 * day it points at the real services, which is the one day the stub existed to make boring.
 *
 * So the same two checks run here, in the same order, producing the same codes: build first
 * (an unsupported client is unsupported whether or not it is signed in), then the auth class the
 * route declares.
 */
import { ApiError } from '../../core/errors.js';
import { isWellFormedBuild } from '../../core/http.js';

/** Tokens this layer mints. Anything else is a token we did not issue — production says so too. */
const STUB_ACCESS_PREFIX = 'stub.access.';

/**
 * Numeric build comparison, matching core/http.js.
 *
 * `'1.10.0' < '1.2.0'` as strings, which locks out every client past 1.9.x. Format is validated
 * before this runs, so every component parses.
 */
function belowFloor(build, floor) {
  const a = String(build).split('.').map(Number);
  const b = String(floor).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = Number.isInteger(a[i]) ? a[i] : 0;
    const y = Number.isInteger(b[i]) ? b[i] : 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * §1: "Every request carries `X-Client-Build`. Below the supported floor is UNSUPPORTED_CLIENT."
 *
 * Absent and malformed are both refusals, not passes: a check that is skipped when the header is
 * missing is a floor bypassed by omitting the header, and a numeric prefix like `2garbage`
 * otherwise sails past a floor of 2.
 *
 * `/v1/health` and `/v1/health/ready` are exempt, exactly as `core/http.js` exempts them — a
 * liveness probe is not a game client and has no build.
 */
export function checkClientBuild(headers, { requireBuild = true, minClientBuild = null } = {}) {
  if (requireBuild === false) return;
  const build = headers['x-client-build'];
  if (!isWellFormedBuild(build)) {
    throw new ApiError('UNSUPPORTED_CLIENT', 'Please update the game to continue.',
      { details: { reason: 'build' } });
  }
  if (minClientBuild === null || minClientBuild === undefined) return;
  if (!isWellFormedBuild(minClientBuild)) {
    // A floor we cannot parse cannot be enforced, and calling that "no floor" is a
    // misconfiguration that silently disables the gate.
    throw new ApiError('SERVICE_UNAVAILABLE', 'Client version policy is misconfigured.',
      { details: { reason: 'floor-malformed' } });
  }
  if (belowFloor(build, minClientBuild)) {
    throw new ApiError('UNSUPPORTED_CLIENT', 'Please update the game to continue.',
      { details: { reason: 'build' } });
  }
}

/**
 * The bearer token on this request, or null. Throws when one is presented and is not ours.
 *
 * **The shape is not the credential.** Checking only the `stub.access.` prefix meant any
 * hand-typed `stub.access.anything` was honoured, so the layer accepted a token it never
 * minted — precisely the forgery production refuses. `verify` is the registry of tokens this
 * layer actually issued; it is a required argument at every call site, because defaulting it
 * would silently restore the prefix check that was the bug.
 */
function bearer(headers, verify) {
  const header = headers.authorization;
  if (typeof header !== 'string' || header === '') return null;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  // A credential we cannot read is not a credential we can trust. Production answers
  // AUTH_TOKEN_INVALID here and so does this, or the shell never builds the "clear the session
  // and sign in" path at all.
  if (!match || !match[1].startsWith(STUB_ACCESS_PREFIX)) {
    throw new ApiError('AUTH_TOKEN_INVALID', 'Your session is not valid. Sign in again.');
  }
  const token = match[1];
  const claims = verify(token);
  // Unknown and forged are one answer, deliberately: errors.md routes AUTH_TOKEN_INVALID to
  // "clear local session, sign-in" for both, and distinguishing them would be an oracle.
  if (!claims) throw new ApiError('AUTH_TOKEN_INVALID', 'Your session is not valid. Sign in again.');
  // A session revoked in another tab is revoked here too. That is the entire reason revocations
  // live on the account rather than on the client session (accounts.js).
  if (claims.revoked) {
    throw new ApiError('AUTH_SESSION_REVOKED', 'You were signed out on another device.');
  }
  return token;
}

/**
 * §2: **A** authenticated, **P** public, **S** service-to-service only.
 *
 * `S` fails closed on a shared token, matching `app.js` requireServiceCaller: until mTLS
 * lands, an S endpoint refuses everything without it. `GET /v1/health/ready` is the only S row
 * the stub serves, and `POST /matches/:id/result` is absent from the table entirely.
 *
 * @param verify {(token: string) => ({ sessionId: string, revoked: boolean }|null)}
 *   The issued-token registry — see `bearer`.
 * @returns {{ token: string|null, authenticated: boolean }}
 */
export function checkAuthClass(headers, authClass, { serviceToken = null, verify } = {}) {
  const token = bearer(headers, verify);  // validated even on P routes: junk is junk everywhere
  if (authClass === 'S') {
    const presented = headers['x-service-token'];
    if (!serviceToken || typeof presented !== 'string' || presented !== serviceToken) {
      throw new ApiError('AUTH_FORBIDDEN', 'This endpoint is not available to clients.');
    }
    return { token, authenticated: false };
  }
  if (authClass === 'A' && token === null) {
    throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
  }
  return { token, authenticated: token !== null };
}

export { STUB_ACCESS_PREFIX };
