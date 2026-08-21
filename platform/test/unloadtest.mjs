/** Focused lifetime proof for telemetry.md §3.3.1's scoped unload credential. */
import { createMemoryStore } from '../src/core/store/memory.js';
import { createUnloadIngress } from '../src/modules/telemetry/unload.js';

let now = Date.parse('2026-08-20T12:00:00.000Z');
const store = createMemoryStore();
const accountId = '01M0D000000000000000000001';
const sessionId = '01M0D000000000000000000002';
await store.accounts.create({ accountId, status: 'active', emailHash: 'hash',
  displayName: 'Unload Test', displayNameFolded: 'unload test', roles: ['player'],
  createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() });
await store.sessions.create({ sessionId, accountId, refreshFamilyId: 'family',
  createdAt: new Date(now).toISOString(), lastSeenAt: new Date(now).toISOString() });
const ingress = createUnloadIngress({
  config: { tokenSecret: 'test-secret-that-is-long-enough', env: 'test' },
  clock: { now: () => now }, store,
  service: { async ingest() { throw new Error('not used'); } },
});
const cookie = ingress.setCookie(ingress.issue({ accountId, sessionId })).split(';')[0];
const ctx = { headers: { cookie } };
const live = await ingress.actorFrom(ctx);
if (live?.accountId !== accountId || live?.sessionId !== sessionId) {
  throw new Error('a freshly issued credential did not bind its active session');
}
console.log('  ok   a fresh unload credential binds the active platform session');
now += 15 * 60 * 1000;
if (await ingress.actorFrom(ctx) !== null) {
  throw new Error('an unload credential remained authoritative at its exact expiry');
}
console.log('  ok   unload identity expires at exactly 15 minutes');
await store.close();
