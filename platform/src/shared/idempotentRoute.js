/**
 * Route-level idempotency, shared by the P3 write endpoints.  contracts/http-api.md §8.
 *
 * `PATCH /v1/profile/me` and `POST /v1/matches/:matchId/result` each implement §8 inside their
 * own service, because their state and their idempotency rows commit in one transaction on one
 * store. The P3 modules cannot do that: loadouts and reservations live in the inventory /
 * deployment module's own store while `idempotency_keys` lives in the core store — the same
 * two-store limitation `modules/deployment/index.js`'s header documents for its own writes. So
 * the §8 mechanics live here, once, at the HTTP layer: serialise on the key, replay the stored
 * response for an identical retry, refuse a different request under a reused key.
 *
 * What the split costs, stated rather than hidden: the domain write and the idempotency row are
 * two commits. A crash between them re-executes on retry — for a loadout create that is a
 * second (identical) loadout row, for a reservation it is refused by the instance locks the
 * first attempt took. Both are recoverable states; a silently replayed *different* request is
 * not, and that is the case this helper exists to make impossible.
 *
 * `cacheableErrorCodes` implements deployment.md §7's note that the 409
 * `DEPLOYMENT_RESERVATION_CONFLICT` is cached under its key like any non-5xx response: a
 * byte-identical replay returns the stored refusal without re-attempting the lock. The stored
 * form is the ApiError's parts, not a serialised envelope, so the replayed response still
 * carries the *replay's* correlation id, per §1's one-id-per-response rule.
 */
import { createHash } from 'node:crypto';
import { ApiError } from '../core/errors.js';

const GAMEPLAY_TTL_MS = 24 * 60 * 60 * 1000; // §8: 24 h for gameplay operations

/** Key order must not change the hash, or a re-serialised retry looks like a different request. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export const requestHashOf = (request) => createHash('sha256').update(stableStringify(request)).digest('hex');

/**
 * §8: `Idempotency-Key` is REQUIRED on this request. Enforced at the HTTP edge, same reasoning
 * as the profile module's copy of this check: "required" is a statement about the request.
 */
export function requireIdempotencyKey(ctx) {
  const raw = ctx.headers?.['idempotency-key'];
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (!key || key.length > 200) {
    throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key is required on this request.', {
      details: { fields: [{ key: 'Idempotency-Key', reason: key ? 'too-long' : 'required' }] },
    });
  }
  return key;
}

/**
 * Run `execute()` once per (key, actor, request).
 *
 * @param coreStore  the core store — owns `idempotency_keys` and the transaction the
 *                   read-decide-write runs in.
 * @param {{ key: string, actorId: string, request: any, clock?: { now: () => number },
 *           cacheableErrorCodes?: string[] }} opts
 * @param {() => Promise<any>} execute  the domain write; its return value is the stored (and
 *                   replayed) response body.
 */
export async function withIdempotency(coreStore, opts, execute) {
  const { key, actorId, request, clock = { now: () => Date.now() }, cacheableErrorCodes = [] } = opts;
  const requestHash = requestHashOf(request);

  const outcome = await coreStore.tx(async (tx) => {
    // Serialise on the key BEFORE reading it — the same fix `patchProfile` and
    // `applyMatchResult` both needed: without the advisory lock, N concurrent retries of one
    // key all read `prior = null` and all execute.
    if (coreStore.idempotency.acquire) await coreStore.idempotency.acquire(key, actorId, tx);
    const prior = await coreStore.idempotency.get(key, actorId, tx);
    if (prior) {
      if (prior.requestHash !== requestHash) {
        throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'That idempotency key was used for a different request.', {
          details: { key },
        });
      }
      // A stored refusal replays as the refusal it was — rebuilt so the envelope carries the
      // replay's correlation id rather than a stale one baked into a stored body.
      const stored = prior.responseBody;
      if (stored && stored.__cachedError) {
        const e = stored.__cachedError;
        throw new ApiError(e.code, e.message, { details: e.details ?? {} });
      }
      return { response: stored };      // §8: the stored response, not a re-execution
    }

    const store = async (responseBody, responseStatus) => {
      const createdAt = new Date(clock.now()).toISOString();
      await coreStore.idempotency.put({
        key, actorId, requestHash, responseStatus, responseBody,
        createdAt, expiresAt: new Date(clock.now() + GAMEPLAY_TTL_MS).toISOString(),
      }, tx);
    };

    try {
      const response = await execute();
      await store(response ?? null, 200);
      return { response };
    } catch (err) {
      if (err instanceof ApiError && cacheableErrorCodes.includes(err.code)) {
        // Stored, then rethrown AFTER the transaction commits — a throw inside `tx` rolls the
        // stored row back with it, which would make the cached refusal a row that never was.
        await store({ __cachedError: { code: err.code, message: err.message, details: err.details ?? {} } },
          err.status);
        return { rethrow: err };
      }
      throw err;
    }
  });

  if (outcome.rethrow) throw outcome.rethrow;
  return outcome.response;
}
