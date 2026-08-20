/**
 * Storage interface.  contracts/db-schema.md.
 *
 * One interface, two adapters: `memory` for tests and local work, `postgres` for real. Every
 * module codes against this and never against a driver, so the whole platform is testable
 * without a database and the Postgres adapter can be swapped or profiled independently.
 *
 * Rules every adapter must honour, because they are contract, not implementation detail:
 *
 *  1. `tx(fn)` is a real transaction. The outbox pattern (event-envelope.md §4) depends on a
 *     state change and its event committing together or not at all; an adapter that fakes it
 *     silently breaks the one guarantee the event stream rests on.
 *  2. `audit.insert` is append-only. No update, no delete, at the adapter level.
 *  3. Reads never return internal driver objects — plain data only, so a caller cannot
 *     accidentally depend on a Postgres row shape.
 *  4. Every method takes an optional trailing `tx` handle. Passing it enrols the call in that
 *     transaction; omitting it runs standalone.
 */

/**
 * @typedef {object} Store
 *
 * @property {(fn: (tx: any) => Promise<any>) => Promise<any>} tx
 *   Run `fn` inside a transaction. Rolls back on throw, commits otherwise.
 *
 * @property {object} accounts
 *   create(row, tx) -> account
 *   byId(accountId, tx) -> account|null
 *   byEmailHash(hash, tx) -> account|null
 *   byNameFolded(folded, tx) -> account|null
 *   update(accountId, patch, tx) -> account
 *
 * @property {object} sessions
 *   create(row, tx) -> session
 *   byId(sessionId, tx) -> session|null
 *   listForAccount(accountId, tx) -> session[]
 *   revoke(sessionId, reason, at, tx) -> void
 *   revokeAllForAccount(accountId, reason, at, tx) -> number
 *   revokeFamily(familyId, reason, at, tx) -> number
 *
 * @property {object} refreshTokens
 *   create(row, tx) -> token           // { tokenId, familyId, accountId, sessionId, expiresAt, usedAt }
 *   byId(tokenId, tx) -> token|null
 *   markUsed(tokenId, at, tx) -> void
 *
 * @property {object} profiles
 *   upsert(accountId, patch, tx) -> profile
 *   byAccountId(accountId, tx) -> profile|null
 *
 * @property {object} stats
 *   get(accountId, mode, statDefinitionVersion, tx) -> row|null
 *   applyDelta(accountId, mode, statDefinitionVersion, delta, tx) -> row
 *   listForAccount(accountId, tx) -> row[]
 *
 * @property {object} weaponStats
 *   applyDelta(accountId, mode, weaponId, statDefinitionVersion, delta, tx) -> row
 *   listForAccount(accountId, mode, tx) -> row[]
 *
 * @property {object} preAuthConsent
 *   put(row, tx) -> row                // { clientSessionId, telemetryPersonal, policyVersion, decidedAt, expiresAt }
 *   get(clientSessionId, tx) -> row|null
 *   markMigrated(clientSessionId, at, tx) -> void
 *
 * @property {object} outbox
 *   insert(event, tx) -> event         // MUST be callable inside tx
 *   claimUnpublished(limit, tx) -> event[]
 *   markPublished(eventIds, at, tx) -> void
 *   recordFailure(eventId, error, tx) -> void
 *   deadLetter(eventId, at, tx) -> void
 *
 * @property {object} audit
 *   insert(row, tx) -> row             // append-only; no update/delete exists on purpose
 *   list(filter, tx) -> row[]
 *
 * @property {object} idempotency
 *   get(key, actorId, tx) -> row|null
 *   put(row, tx) -> row
 *
 * @property {object} flags
 *   all(tx) -> row[]
 *   get(key, tx) -> row|null
 *   set(key, patch, tx) -> row
 *
 * @property {() => Promise<{ok: boolean, detail?: string}>} health
 * @property {() => Promise<void>} close
 */

/** Adapter registry. `createStore` picks one from config; nothing else imports an adapter. */
export async function createStore(config, deps = {}) {
  if (config.storage === 'memory') {
    const { createMemoryStore } = await import('./store/memory.js');
    return createMemoryStore(config, deps);
  }
  if (config.storage === 'postgres') {
    const { createPostgresStore } = await import('./store/postgres.js');
    return createPostgresStore(config, deps);
  }
  throw new Error(`unknown storage adapter: ${config.storage}`);
}
