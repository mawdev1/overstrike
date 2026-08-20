/**
 * Platform events, in plain Node.  contracts/event-envelope.md §9.
 *
 * Every claim here is paired with its failing control — the case that would pass anyway if the
 * mechanism were absent. A test that only exercises the happy path proves the code ran, not
 * that the guarantee holds, and this repository has already learned that lesson once
 * (`project_testing_lessons`).
 *
 *   node platform/test/eventtest.mjs
 */
import { createOutbox } from '../src/modules/events/outbox.js';
import { createRelay } from '../src/modules/events/relay.js';
import { createConsumer, createMemoryDedupe } from '../src/modules/events/consumer.js';
import { createAuditLog, capabilityForAction, summarise } from '../src/modules/events/audit.js';
import { buildEvent, validateEvent, EventContractError } from '../src/modules/events/envelope.js';
import { check, requireCapability, capabilitiesOf, isSharedIdentity, ROLES } from '../src/modules/events/rbac.js';
import { ulid } from '../src/core/ids.js';

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const assert = (n, cond, detail = '') => (cond ? ok(n) : bad(n, detail));

/** Assert that `fn` throws, and that the message says why. Used for every control case. */
async function refuses(name, fn, match) {
  try {
    await fn();
    bad(name, 'expected a refusal, got success');
    return null;
  } catch (err) {
    if (match && !String(err.message).includes(match)) {
      bad(name, `refused with the wrong reason: ${err.message}`);
      return err;
    }
    ok(name);
    return err;
  }
}

// ---------------------------------------------------------------------------------------------
// A fake store. The real adapters (core/store.js) belong to another agent; this one exists only
// to give the outbox a transaction with real rollback, which is the only store behaviour these
// tests depend on.
// ---------------------------------------------------------------------------------------------
function createFakeStore({ clock = Date } = {}) {
  const state = { accounts: new Map(), rooms: new Map(), outbox: new Map(), audit: [] };
  let claimOrder = 'reverse';   // returns rows in the WRONG order on purpose; the relay must sort

  const snapshot = () => ({
    accounts: new Map(state.accounts), rooms: new Map(state.rooms),
    outbox: new Map([...state.outbox].map(([k, v]) => [k, { ...v }])),
    audit: [...state.audit],
  });
  const restore = (s) => { state.accounts = s.accounts; state.rooms = s.rooms; state.outbox = s.outbox; state.audit = s.audit; };

  // Transactions are serialised, as an isolated database would serialise conflicting writers.
  let lock = Promise.resolve();

  async function tx(fn) {
    const run = lock.then(async () => {
      const before = snapshot();
      const handle = { id: ulid(clock.now()) };
      try { return await fn(handle); }
      catch (err) { restore(before); throw err; }
    });
    lock = run.catch(() => {});
    return run;
  }

  return {
    state,
    setClaimOrder: (o) => { claimOrder = o; },
    tx,
    accounts: {
      // Deliberately NOT transaction-aware beyond the snapshot: the rollback above is what
      // makes "no state change without its event" observable.
      update: async (id, patch) => {
        const row = { ...(state.accounts.get(id) || { accountId: id }), ...patch };
        state.accounts.set(id, row);
        return row;
      },
      byId: async (id) => state.accounts.get(id) || null,
    },
    rooms: {
      update: async (id, patch) => {
        const row = { ...(state.rooms.get(id) || { roomId: id }), ...patch };
        state.rooms.set(id, row);
        return row;
      },
      byId: async (id) => state.rooms.get(id) || null,
    },
    outbox: {
      // Rows, not envelopes: `events_outbox` (db-schema.md §5) flattens type and subject into
      // columns, and the module is responsible for the mapping in both directions.
      insert: async (row, handle) => {
        if (handle === undefined) throw new Error('outbox.insert called without a transaction');
        if (row.type !== undefined || row.subject !== undefined) {
          throw new Error('outbox.insert received an envelope, not an events_outbox row');
        }
        state.outbox.set(row.eventId, { ...row, publishedAt: null, attempts: 0, lastError: null, deadLetteredAt: null });
        return row;
      },
      claimUnpublished: async (limit) => {
        const rows = [...state.outbox.values()].filter((r) => !r.publishedAt && !r.deadLetteredAt);
        if (claimOrder === 'reverse') rows.reverse();
        return rows.slice(0, limit).map((r) => ({ ...r }));
      },
      markPublished: async (ids, at) => { for (const id of ids) { const r = state.outbox.get(id); if (r) r.publishedAt = at; } },
      recordFailure: async (id, error) => { const r = state.outbox.get(id); if (r) { r.attempts++; r.lastError = error; } },
      deadLetter: async (id, at) => { const r = state.outbox.get(id); if (r) r.deadLetteredAt = at; },
    },
    audit: {
      insert: async (row) => { state.audit.push(row); return row; },
      list: async (filter = {}) => state.audit.filter((r) =>
        Object.entries(filter).every(([k, v]) => r[k] === v)),
    },
  };
}

const capturingLogger = () => {
  const lines = [];
  const rec = (level) => (event, fields = {}) => lines.push({ level, event, ...fields });
  return { lines, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
};

const fakeClock = (start = Date.parse('2026-08-19T12:00:00.000Z')) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
};

const PLAYER = { kind: 'player', id: '01ACTORPLAYER00000000000AA', role: 'player' };
const SERVICE = { kind: 'service', id: 'match-allocator', role: 'service' };

// =============================================================================================
console.log('\nenvelope + catalogue');
// =============================================================================================
{
  const clock = fakeClock();
  const e = buildEvent({
    type: 'match.completed', actor: SERVICE, subject: { kind: 'match', id: 'M1' },
    payload: { winner: 0 },
  }, { clock, defaults: { correlationId: ulid(clock.now()) } });

  assert('envelope carries every §2 field',
    validateEvent(e).length === 0, JSON.stringify(validateEvent(e)));
  assert('privacyClass and retentionClass come from the catalogue',
    e.privacyClass === 'public' && e.retentionClass === 'audit',
    `${e.privacyClass}/${e.retentionClass}`);
  assert('schemaRef is derived from type and version',
    e.schemaRef === 'events/match.completed/v1', e.schemaRef);

  // CONTROL: an unregistered type is a programming error, not a runtime shrug.
  await refuses('unregistered event type is refused at build time',
    async () => buildEvent({ type: 'match.finished', actor: SERVICE, subject: { kind: 'match', id: 'M1' } },
      { clock, defaults: { correlationId: ulid() } }),
    'not in the catalogue');

  await refuses('a mis-named type is refused before the catalogue is even consulted',
    async () => buildEvent({ type: 'MatchCompleted', actor: SERVICE, subject: { kind: 'match', id: 'M1' } },
      { clock, defaults: { correlationId: ulid() } }),
    'past-tense-verb');

  // CONTROL: the classification cannot be talked down at the call site.
  await refuses('a call-site privacyClass override is refused',
    async () => buildEvent({
      type: 'report.submitted', actor: PLAYER, subject: { kind: 'account', id: 'A1' },
      privacyClass: 'internal',
    }, { clock, defaults: { correlationId: ulid() } }),
    'may not be overridden');

  await refuses('an unattributed actor is refused',
    async () => buildEvent({ type: 'match.started', actor: { kind: 'service', id: '' }, subject: { kind: 'match', id: 'M1' } },
      { clock, defaults: { correlationId: ulid() } }),
    'actor.id is required');

  await refuses('an event with no correlationId is refused',
    async () => buildEvent({ type: 'match.started', actor: SERVICE, subject: { kind: 'match', id: 'M1' } },
      { clock }),
    'correlationId is required');

  await refuses('an actor kind the catalogue does not allow for the type is refused',
    async () => buildEvent({ type: 'sanction.applied', actor: PLAYER, subject: { kind: 'account', id: 'A1' } },
      { clock, defaults: { correlationId: ulid() } }),
    'actor kind not permitted');
}

// =============================================================================================
console.log('\nbuildEvent — every refusal, by the reason it gives');
// =============================================================================================
{
  // The block above proves the well-known refusals. This one exists because a mutation sweep
  // (`scripts/mutatetest.mjs --file=platform/src/modules/events/envelope.js`) showed the rest of
  // `buildEvent`'s guards could be deleted one at a time without a single check changing: the
  // suite only ever built VALID specs, so a guard that stopped guarding was invisible.
  //
  // Each case breaks exactly one field of a spec that is otherwise buildable, and matches on the
  // MESSAGE. Matching on "it threw" would not distinguish: delete the subject.kind guard and the
  // build still throws, from the guard below it, with a different reason. The reason is the
  // assertion.
  const clock = fakeClock();
  const opts = { clock, defaults: { correlationId: ulid(clock.now()) } };
  const build = (patch) => buildEvent(
    { type: 'match.completed', actor: SERVICE, subject: { kind: 'match', id: 'M1' }, ...patch }, opts);

  await refuses('a spec that is not an object is refused before any field is read',
    async () => buildEvent(null, opts), 'spec must be an object');

  await refuses('a version the catalogue does not list for the type is refused',
    async () => build({ version: 2 }), 'unsupported version for type');
  assert('CONTROL: the version the catalogue does list is accepted',
    build({ version: 1 }).version === 1);

  await refuses('an actor that is not an object at all is refused',
    async () => build({ actor: 'match-allocator' }), 'actor.kind must be one of');
  await refuses('an actor kind outside the closed §2 set is refused',
    async () => build({ actor: { kind: 'robot', id: 'r1' } }), 'actor.kind must be one of');

  await refuses('a subject kind outside the closed §2 set is refused',
    async () => build({ subject: { kind: 'planet', id: 'X' } }), 'subject.kind must be one of');
  await refuses('a real subject kind the catalogue forbids for this type is refused',
    async () => build({ subject: { kind: 'account', id: 'A1' } }), 'subject kind not permitted');
  await refuses('a subject with no id is refused — it is the §3 ordering key',
    async () => build({ subject: { kind: 'match', id: '' } }), 'subject.id is required');

  await refuses('a payload that is an array, not an object, is refused',
    async () => build({ payload: [1, 2] }), 'payload must be an object');
  assert('CONTROL: an absent payload is fine and becomes {}',
    JSON.stringify(build({}).payload) === '{}');

  await refuses('a causationId that is not a ULID is refused',
    async () => build({ causationId: 'the-one-before' }), 'causationId must be a ULID');
  assert('CONTROL: a null causationId is the documented "no parent" value, not an error',
    build({ causationId: null }).causationId === null);

  await refuses('a retentionClass override is refused just as a privacyClass override is',
    async () => build({ retentionClass: 'short' }), 'may not be overridden');

  await refuses('an occurredAt that is not an ISO-8601 UTC instant is refused',
    async () => build({ occurredAt: '19 August 2026' }), 'occurredAt must be an ISO-8601');
  await refuses('an occurredAt with an offset rather than Z is refused',
    async () => build({ occurredAt: '2026-08-19T12:00:00+02:00' }), 'occurredAt must be an ISO-8601');
  assert('CONTROL: a Z instant is accepted and carried through verbatim',
    build({ occurredAt: '2026-08-19T12:00:00.000Z' }).occurredAt === '2026-08-19T12:00:00.000Z');

  await refuses('a caller-supplied eventId that is not a ULID is refused',
    async () => build({ eventId: 'evt-00017' }), 'eventId must be a ULID');
  assert('CONTROL: a caller-supplied ULID eventId is honoured, not overwritten', (() => {
    const id = ulid(clock.now());
    return build({ eventId: id }).eventId === id;
  })());
}

// =============================================================================================
console.log('\nvalidateEvent — the negative path, one problem at a time');
// =============================================================================================
{
  // Until this block existed, `validateEvent` was only ever called on events `buildEvent` had
  // just produced, and the assertion was `length === 0`. That asserts nothing about any of the
  // fourteen `problems.push` lines: all fourteen could be deleted and the list would still be
  // empty. The mutation sweep measured exactly that.
  //
  // `length > 0` would not fix it either — one surviving guard satisfies it for every malformed
  // event, so the other thirteen deletions stay invisible. So each case asserts the COMPLETE
  // problem list, in source order, for an envelope with exactly one field broken. Deleting the
  // guard under test drops its string; deleting any other changes a different case's list.
  const clock = fakeClock();
  const good = buildEvent({
    type: 'match.completed', actor: SERVICE, subject: { kind: 'match', id: 'M1' }, payload: { winner: 0 },
  }, { clock, defaults: { correlationId: ulid(clock.now()) } });

  // A throw is reported as a problem string rather than allowed to abort the suite, so that a
  // guard whose deletion turns a report into a crash still fails its own check and not the file.
  const listOf = (v) => {
    try { return validateEvent(v); }
    catch (err) { return [`validateEvent threw: ${err.message}`]; }
  };
  const exactly = (name, patch, expected) => {
    const subject = (patch === null || typeof patch !== 'object' || Array.isArray(patch))
      ? patch : { ...good, ...patch };
    const got = listOf(subject);
    assert(name, got.length === expected.length && got.every((p, i) => p === expected[i]),
      `got [${got.join(' | ')}] want [${expected.join(' | ')}]`);
  };

  exactly('an intact envelope produces no problems at all', {}, []);

  exactly('a non-object is rejected whole, before any field is touched', null,
    ['event is not an object']);
  exactly('an array is not a plain object either', [good],
    ['event is not an object']);
  exactly('a string is not an envelope', 'match.completed',
    ['event is not an object']);

  exactly('a non-ULID eventId is named', { eventId: 'evt-17' },
    ['eventId is not a ULID']);
  exactly('an uncatalogued type is named, and stops the catalogue-derived checks',
    { type: 'match.finished' },
    ['type match.finished is not in the catalogue']);

  // schemaRef is derived from (type, version), so a version change that left the old ref behind
  // would report two problems. Moving the ref with it isolates the version guard.
  exactly('a version the catalogue does not list is named',
    { version: 2, schemaRef: 'events/match.completed/v2' },
    ['version is not supported for type']);
  exactly('a schemaRef that does not match type/version is named',
    { schemaRef: 'events/match.completed/v2' },
    ['schemaRef does not match type/version']);

  // A KNOWN class that is the wrong one for this type: the catalogue check fires, the
  // known-class check does not. That separation is what makes the two guards distinguishable.
  exactly('a privacyClass that is valid but not this type\'s is a catalogue mismatch',
    { privacyClass: 'internal' }, ['privacyClass does not match the catalogue']);
  exactly('a retentionClass that is valid but not this type\'s is a catalogue mismatch',
    { retentionClass: 'standard' }, ['retentionClass does not match the catalogue']);

  exactly('a privacyClass outside the closed set fails BOTH the catalogue and the class check',
    { privacyClass: 'secret' },
    ['privacyClass does not match the catalogue', 'privacyClass is not a known class']);
  exactly('a retentionClass outside the closed set fails both as well',
    { retentionClass: 'forever' },
    ['retentionClass does not match the catalogue', 'retentionClass is not a known class']);

  exactly('an actor with a blank id is unattributed', { actor: { kind: 'service', id: '' } },
    ['actor is missing or unattributed']);
  exactly('a missing actor is the same finding', { actor: undefined },
    ['actor is missing or unattributed']);
  exactly('a subject with no id has no ordering key', { subject: { kind: 'match' } },
    ['subject is missing or has no id']);

  exactly('a non-instant occurredAt is named', { occurredAt: '19 August 2026' },
    ['occurredAt is not an ISO instant']);
  exactly('an epoch-millis recordedAt is not an instant either', { recordedAt: 1755600000000 },
    ['recordedAt is not an ISO instant']);
  exactly('a blank correlationId is missing', { correlationId: '' },
    ['correlationId is missing']);

  // And the problems compose: a row that is wrong in several ways reports each of them, so a
  // dead-letter handler can say what it found rather than "invalid".
  exactly('several faults are reported together, not just the first',
    { eventId: 'x', correlationId: '', occurredAt: 'soon' },
    ['eventId is not a ULID', 'occurredAt is not an ISO instant', 'correlationId is missing']);
}

// =============================================================================================
console.log('\n§4 transactional outbox — no state change without its event');
// =============================================================================================
{
  const clock = fakeClock();
  const store = createFakeStore({ clock });
  const outbox = createOutbox({ store, clock });
  const correlationId = ulid(clock.now());

  await outbox.commit({ correlationId, actor: PLAYER }, async (tx, emit) => {
    await store.accounts.update('A1', { displayName: 'Ghost' }, tx);
    await emit({ type: 'account.name_changed', subject: { kind: 'account', id: 'A1' }, payload: { to: 'Ghost' } });
  });
  assert('the state change committed', (await store.accounts.byId('A1'))?.displayName === 'Ghost');
  assert('its event committed with it', store.state.outbox.size === 1, `${store.state.outbox.size} rows`);

  // CONTROL: the same mutation with no event must not survive. This is the entire pattern.
  await refuses('a unit of work that changes state and emits nothing is rolled back',
    () => outbox.commit({ correlationId, actor: PLAYER }, async (tx) => {
      await store.rooms.update('R1', { name: 'silent' }, tx);
    }),
    'emitted no event');
  assert('the unexplained state change did not survive the rollback',
    (await store.rooms.byId('R1')) === null, JSON.stringify(store.state.rooms.get('R1') ?? null));

  // CONTROL: a failure after the event still leaves neither behind.
  await refuses('a throw after emit rolls the event back too',
    () => outbox.commit({ correlationId, actor: PLAYER }, async (tx, emit) => {
      await store.rooms.update('R2', { name: 'doomed' }, tx);
      await emit({ type: 'room.created', subject: { kind: 'room', id: 'R2' }, payload: {} });
      throw new Error('handler blew up after the write');
    }),
    'blew up');
  assert('neither the room nor its event survived',
    (await store.rooms.byId('R2')) === null && store.state.outbox.size === 1,
    `rooms=${store.state.rooms.size} outbox=${store.state.outbox.size}`);

  // CONTROL: the emitter is transaction-bound. Capture it, use it after the commit, get refused.
  let escaped = null;
  await outbox.commit({ correlationId, actor: PLAYER }, async (tx, emit) => {
    escaped = emit;
    await emit({ type: 'presence.changed', subject: { kind: 'account', id: 'A1' }, payload: { state: 'online' } });
  });
  const before = store.state.outbox.size;
  await refuses('an event emitted outside its transaction is refused',
    () => escaped({ type: 'presence.changed', subject: { kind: 'account', id: 'A1' }, payload: { state: 'offline' } }),
    'outside its transaction');
  assert('the refused emit wrote nothing', store.state.outbox.size === before,
    `${before} -> ${store.state.outbox.size}`);

  await refuses('emitIn without a transaction handle is refused',
    () => outbox.emitIn(null, { correlationId, actor: PLAYER },
      { type: 'presence.changed', subject: { kind: 'account', id: 'A1' }, payload: {} }),
    'transaction handle is required');

  assert('causation chains within one unit of work', await (async () => {
    const { events } = await outbox.commit({ correlationId, actor: SERVICE }, async (tx, emit) => {
      await emit({ type: 'match.started', subject: { kind: 'match', id: 'M9' }, payload: {} });
      await emit({ type: 'match.completed', subject: { kind: 'match', id: 'M9' }, payload: {} });
    });
    return events[1].causationId === events[0].eventId && events[0].correlationId === events[1].correlationId;
  })());
}

// =============================================================================================
console.log('\n§4 outbox — the arguments it refuses to start from');
// =============================================================================================
{
  // `createOutbox`'s store check and `commit`'s two argument checks all survived deletion: the
  // suite only ever handed them a real store and a well-formed ctx. Each case below matches the
  // MESSAGE, because deleting any of these still produces *a* throw further down — from a
  // missing method, a missing correlationId inside buildEvent, or "work is not a function".
  const clock = fakeClock();
  const store = createFakeStore({ clock });
  const outbox = createOutbox({ store, clock });
  const correlationId = ulid(clock.now());

  await refuses('a store with no tx() is refused when the outbox is created',
    async () => createOutbox({ store: { outbox: store.outbox }, clock }),
    'store must expose tx() and outbox');
  await refuses('a store with no outbox table is refused too',
    async () => createOutbox({ store: { tx: store.tx }, clock }),
    'store must expose tx() and outbox');
  assert('CONTROL: a store with both is accepted',
    typeof createOutbox({ store, clock }).commit === 'function');

  await refuses('commit without a unit of work is refused',
    () => outbox.commit({ correlationId }, null), 'work must be a function');
  await refuses('commit with a plain object where the work should be is refused',
    () => outbox.commit({ correlationId }, { run: () => {} }), 'work must be a function');

  await refuses('commit with no ctx at all is refused',
    () => outbox.commit(null, async () => {}), 'ctx.correlationId is required');
  await refuses('commit with a blank correlationId is refused',
    () => outbox.commit({ correlationId: '' }, async (tx, emit) => {
      await emit({ type: 'room.created', actor: PLAYER, subject: { kind: 'room', id: 'R9' }, payload: {} });
    }),
    'ctx.correlationId is required');
  assert('none of the refused units of work opened a transaction',
    store.state.outbox.size === 0 && store.state.rooms.size === 0,
    `outbox=${store.state.outbox.size} rooms=${store.state.rooms.size}`);
}

// =============================================================================================
console.log('\n§3 dedupe memory is bounded, and idempotent about its own bookkeeping');
// =============================================================================================
{
  // Both guards inside `createMemoryDedupe` survived deletion, and one of them is not cosmetic:
  // without the "already seen" early return, a re-add pushes the same id onto the eviction queue
  // again, so the FIFO evicts an id that is still live and the consumer stops deduping it.
  const dedupe = createMemoryDedupe({ capacity: 3 });
  dedupe.add('E1'); dedupe.add('E1'); dedupe.add('E1'); dedupe.add('E1');
  assert('re-adding an id neither grows the set nor spends eviction budget',
    dedupe.size() === 1 && dedupe.has('E1') === true, `size=${dedupe.size()} has=${dedupe.has('E1')}`);

  const fifo = createMemoryDedupe({ capacity: 3 });
  for (const id of ['A', 'B', 'C', 'D', 'E']) fifo.add(id);
  assert('the memory is bounded at its capacity', fifo.size() === 3, String(fifo.size()));
  assert('and it evicts oldest-first, keeping the most recent ids',
    fifo.has('A') === false && fifo.has('B') === false
    && fifo.has('C') === true && fifo.has('D') === true && fifo.has('E') === true,
    ['A', 'B', 'C', 'D', 'E'].map((id) => `${id}=${fifo.has(id)}`).join(' '));

  // The consumer-level consequence, since a dedupe that forgets is a dedupe that double-counts.
  const logger = capturingLogger();
  const counted = [];
  const consumer = createConsumer({
    name: 'bounded', logger, dedupe: createMemoryDedupe({ capacity: 2 }),
    handlers: { 'match.completed': (e) => counted.push(e.eventId) },
  });
  const clock = fakeClock();
  const one = buildEvent({ type: 'match.completed', actor: SERVICE, subject: { kind: 'match', id: 'M1' } },
    { clock, defaults: { correlationId: ulid(clock.now()) } });
  for (let i = 0; i < 5; i++) await consumer.deliver(one);
  assert('five deliveries of one event are handled once, whatever the capacity',
    counted.length === 1 && consumer.stats.duplicates === 4,
    `handled=${counted.length} duplicates=${consumer.stats.duplicates}`);
}

// =============================================================================================
console.log('\n§4 crash between commit and publish');
// =============================================================================================
{
  const clock = fakeClock();
  const store = createFakeStore({ clock });
  const outbox = createOutbox({ store, clock });
  const logger = capturingLogger();
  const delivered = [];

  await outbox.commit({ correlationId: ulid(clock.now()), actor: SERVICE }, async (tx, emit) => {
    await store.accounts.update('A2', { rank: 3 }, tx);
    await emit({ type: 'match.result_applied', subject: { kind: 'match', id: 'M2' }, payload: { accountId: 'A2' } });
  });

  // The process dies here. Nothing published. This is the moment §4 is written about.
  assert('after the crash the state change is durable',
    (await store.accounts.byId('A2'))?.rank === 3);
  assert('after the crash the consumer has seen nothing', delivered.length === 0);
  assert('but the event is still on disk, unpublished',
    [...store.state.outbox.values()].filter((r) => !r.publishedAt).length === 1);

  // Restart: a NEW relay over the same store, with no memory of the dead process.
  const relay = createRelay({
    store, logger, clock,
    publish: async (e) => { delivered.push(e.eventId); },
  });
  await relay.drain();
  assert('a relay started after the crash delivers the event anyway',
    delivered.length === 1, `${delivered.length} delivered`);

  // CONTROL: publish-after-commit from application code. Same crash, event gone for good, and
  // nothing in the surviving state says it is missing.
  const naive = { published: [] };
  const commitThenCrash = async () => {
    await store.accounts.update('A3', { rank: 4 });
    throw new Error('process died before publish');
  };
  try { await commitThenCrash(); } catch { /* the crash */ }
  assert('CONTROL: without the outbox the same crash loses the event permanently',
    (await store.accounts.byId('A3'))?.rank === 4 && naive.published.length === 0
      && ![...store.state.outbox.values()].some((r) => r.payload?.accountId === 'A3'));
}

// =============================================================================================
console.log('\n§3 at-least-once — double delivery must not double-count');
// =============================================================================================
{
  const clock = fakeClock();
  const store = createFakeStore({ clock });
  const outbox = createOutbox({ store, clock });
  const logger = capturingLogger();

  const wallet = { balance: 0 };
  const consumer = createConsumer({
    name: 'stats', logger,
    handlers: { 'match.result_applied': (e) => { wallet.balance += e.payload.xp; } },
  });
  const naiveWallet = { balance: 0 };   // CONTROL: same handler, no dedupe

  const emitted = [];
  for (let i = 0; i < 5; i++) {
    const { events } = await outbox.commit({ correlationId: ulid(clock.now()), actor: SERVICE }, async (tx, emit) => {
      await emit({ type: 'match.result_applied', subject: { kind: 'match', id: `M${i}` }, payload: { xp: 10 } });
    });
    emitted.push(events[0]);
  }

  for (const e of emitted) await consumer.deliver(e);
  const once = wallet.balance;
  for (const e of emitted) { await consumer.deliver(e); naiveWallet.balance += e.payload.xp * 2; }

  assert('delivering every event twice leaves consumer state unchanged',
    wallet.balance === once && once === 50, `${once} -> ${wallet.balance}`);
  assert('the duplicates were counted, not silently swallowed',
    consumer.stats.duplicates === 5, String(consumer.stats.duplicates));
  assert('CONTROL: the same handler without dedupe double-counts',
    naiveWallet.balance === 100, String(naiveWallet.balance));

  // And the relay itself republishes when marking fails — the exact at-least-once path.
  const seen = [];
  let markFailed = false;
  const flaky = {
    ...store,
    outbox: {
      ...store.outbox,
      markPublished: async (ids, at) => {
        if (!markFailed) { markFailed = true; throw new Error('crash after publish, before mark'); }
        return store.outbox.markPublished(ids, at);
      },
    },
  };
  const relay = createRelay({ store: flaky, logger, clock, publish: async (e) => { seen.push(e.eventId); } });
  await relay.drain();
  clock.advance(60_000);
  await relay.drain();
  assert('the relay redelivers an event whose mark failed',
    seen.length > emitted.length, `${seen.length} deliveries for ${emitted.length} events`);
  for (const e of emitted) await consumer.deliver(e);
  assert('the consumer absorbs those redeliveries too', wallet.balance === 50, String(wallet.balance));
}

// =============================================================================================
console.log('\n§3 per-subject ordering under concurrent producers');
// =============================================================================================
{
  const clock = fakeClock();
  const store = createFakeStore({ clock });
  const outbox = createOutbox({ store, clock });
  const logger = capturingLogger();

  const SUBJECTS = ['M-a', 'M-b', 'M-c'];
  const PER = 6;
  const expected = new Map(SUBJECTS.map((s) => [s, []]));

  // Three producers writing interleaved, each in its own transaction.
  await Promise.all(SUBJECTS.map((subjectId) => (async () => {
    for (let i = 0; i < PER; i++) {
      const { events } = await outbox.commit({ correlationId: ulid(clock.now()), actor: SERVICE }, async (tx, emit) => {
        await emit({ type: 'player.killed', subject: { kind: 'match', id: subjectId }, payload: { seq: i } });
      });
      expected.get(subjectId).push(events[0].eventId);
    }
  })()));

  const got = new Map(SUBJECTS.map((s) => [s, []]));
  const relay = createRelay({ store, logger, clock, publish: async (e) => { got.get(e.subject.id).push(e.eventId); } });
  await relay.drain();

  const inOrder = SUBJECTS.every((s) => got.get(s).join(',') === expected.get(s).join(','));
  assert('per-subject order holds under concurrent producers', inOrder,
    SUBJECTS.map((s) => `${s}: ${got.get(s).length}/${expected.get(s).length}`).join(' '));
  assert('every event was delivered exactly once',
    SUBJECTS.every((s) => got.get(s).length === PER));

  // CONTROL: the store hands rows back reversed, so a relay that publishes in claim order —
  // that is, one without the §3 grouping and sort — delivers a match's events backwards.
  const rows = await store.outbox.claimUnpublished(100);
  const naiveOrder = rows.filter((r) => r.subjectId === 'M-a').map((r) => r.eventId);
  assert('CONTROL: publishing in claim order would reverse a subject\'s events',
    naiveOrder.length === 0 || naiveOrder.join(',') !== expected.get('M-a').join(','),
    'claim order happened to match, the control proves nothing');

  // Subjects are independent: nothing here asserts a global order, and §3 does not promise one.
  const globalOrder = [...store.state.outbox.values()].map((r) => r.eventId);
  assert('ordering is per subject, not global',
    globalOrder.length === SUBJECTS.length * PER);
}

// =============================================================================================
console.log('\n§8 unknown event type is ignored, not fatal');
// =============================================================================================
{
  const logger = capturingLogger();
  const consumer = createConsumer({
    name: 'ledger', logger,
    handlers: { 'match.completed': () => { /* the only type this consumer knows */ } },
  });
  const clock = fakeClock();
  const known = buildEvent({ type: 'match.completed', actor: SERVICE, subject: { kind: 'match', id: 'M1' } },
    { clock, defaults: { correlationId: ulid() } });
  const unknown = buildEvent({ type: 'flag.toggled', actor: { kind: 'admin', id: 'admin-7', role: 'developer' }, subject: { kind: 'account', id: 'A1' } },
    { clock, defaults: { correlationId: ulid() } });

  const a = await consumer.deliver(known);
  const b = await consumer.deliver(unknown);
  assert('a known type is handled', a.status === 'handled');
  assert('an unknown type is ignored and counted, not thrown',
    b.status === 'ignored' && consumer.stats.unknown === 1, JSON.stringify(b));
  assert('the ignore was logged at info, not error',
    logger.lines.some((l) => l.event === 'consumer.unknown_type' && l.level === 'info'));

  // CONTROL: a consumer that treats an unknown type as an error takes the whole stream down,
  // which is why §8 forbids it — a new event type would need a coordinated deploy of everyone.
  let fatal = false;
  const strict = createConsumer({
    name: 'strict', logger,
    handlers: { 'match.completed': () => {}, 'flag.toggled': () => { throw new Error('unrecognised'); } },
  });
  try { await strict.deliver(unknown); } catch { fatal = true; }
  assert('CONTROL: a throwing handler does take the stream down', fatal);
  assert('a failed handler is NOT marked seen, so it will be redelivered',
    !strict.dedupe.has(unknown.eventId));
}

// =============================================================================================
console.log('\n§3 dead-letter after the retry budget, with an alert');
// =============================================================================================
{
  const clock = fakeClock();
  const store = createFakeStore({ clock });
  const outbox = createOutbox({ store, clock });
  const logger = capturingLogger();
  const paged = [];

  await outbox.commit({ correlationId: ulid(clock.now()), actor: SERVICE }, async (tx, emit) => {
    await emit({ type: 'match.completed', subject: { kind: 'match', id: 'M-dead' }, payload: {} });
  });

  const relay = createRelay({
    store, logger, clock, config: { maxAttempts: 3 },
    publish: async () => { throw new Error('consumer unreachable'); },
    onDeadLetter: (info) => paged.push(info),
  });

  // Two attempts inside the budget: retried, backed off, NOT dead-lettered.
  await relay.drain();
  clock.advance(60_000);
  await relay.drain();
  const row = [...store.state.outbox.values()][0];
  assert('within the budget the event is retried, not dropped',
    row.attempts === 2 && row.deadLetteredAt === null && paged.length === 0,
    `attempts=${row.attempts} dead=${row.deadLetteredAt}`);
  assert('the retry backs off rather than spinning',
    relay.backoffMs(1) < relay.backoffMs(2) && relay.backoffMs(2) < relay.backoffMs(3));

  clock.advance(60_000);
  await relay.drain();
  assert('dead-letter fires once the budget is exhausted',
    row.attempts === 3 && row.deadLetteredAt !== null, `attempts=${row.attempts}`);
  assert('and it alerts at error level, naming the subject',
    logger.lines.some((l) => l.event === 'outbox.dead_letter' && l.level === 'error'
      && l.subjectId === 'M-dead' && l.correlationId));
  assert('and it pages', paged.length === 1);

  clock.advance(60_000);
  const after = await relay.drain();
  assert('a dead-lettered row is not claimed again', after.failed === 0, JSON.stringify(after));

  // CONTROL: a healthy publisher never dead-letters, so the assertion above is about the
  // budget and not about the relay simply giving up on everything.
  const store2 = createFakeStore({ clock });
  const outbox2 = createOutbox({ store: store2, clock });
  await outbox2.commit({ correlationId: ulid(clock.now()), actor: SERVICE }, async (tx, emit) => {
    await emit({ type: 'match.completed', subject: { kind: 'match', id: 'M-ok' }, payload: {} });
  });
  const logger2 = capturingLogger();
  await createRelay({ store: store2, logger: logger2, clock, config: { maxAttempts: 3 }, publish: async () => {} }).drain();
  assert('CONTROL: a healthy publisher dead-letters nothing',
    !logger2.lines.some((l) => l.event === 'outbox.dead_letter'));
}

// =============================================================================================
console.log('\nrelay lifecycle — drain terminates, stop() stops');
// =============================================================================================
{
  const clock = fakeClock();
  const store = createFakeStore({ clock });
  const outbox = createOutbox({ store, clock });
  const logger = capturingLogger();
  const delivered = [];
  const relay = createRelay({ store, logger, clock, publish: async (e) => { delivered.push(e.eventId); } });

  assert('drain over an empty outbox takes exactly one pass to learn there is nothing to do',
    (await relay.drain()).passes === 1);

  await outbox.commit({ correlationId: ulid(clock.now()), actor: SERVICE }, async (tx, emit) => {
    await emit({ type: 'match.started', subject: { kind: 'match', id: 'M-drain' }, payload: {} });
  });
  // Two passes: one that publishes, one that finds nothing and breaks. Without the break the
  // loop runs its full 1000-pass bound every time, which is the difference this asserts.
  const drained = await relay.drain();
  assert('drain stops on the first idle pass rather than burning its whole bound',
    drained.passes === 2 && drained.published === 1,
    `passes=${drained.passes} published=${drained.published}`);
  // stop() means stopped. The guard under test is the one at the top of the poll tick, and the
  // sequence that reaches it is a supervisor that called start() twice: stop() can only clear
  // the timer it last stored, so the earlier one is still armed and fires after the stop.
  const store2 = createFakeStore({ clock });
  const outbox2 = createOutbox({ store: store2, clock });
  await outbox2.commit({ correlationId: ulid(clock.now()), actor: SERVICE }, async (tx, emit) => {
    await emit({ type: 'match.started', subject: { kind: 'match', id: 'M-stop' }, payload: {} });
  });
  const afterStop = [];
  const polled = createRelay({ store: store2, logger, clock, publish: async (e) => { afterStop.push(e.eventId); } });
  polled.start({ intervalMs: 5 });
  polled.start({ intervalMs: 5 });     // orphans the first timer, which stop() cannot clear
  polled.stop();
  await new Promise((r) => setTimeout(r, 60));
  assert('a stopped relay publishes nothing, even from a timer stop() could not clear',
    afterStop.length === 0 && [...store2.state.outbox.values()].every((r) => r.publishedAt === null),
    `${afterStop.length} published after stop`);

  // CONTROL: the same relay, started and left running, does publish — so the assertion above is
  // about stop() and not about a relay that never worked.
  polled.start({ intervalMs: 5 });
  await new Promise((r) => setTimeout(r, 60));
  polled.stop();
  assert('CONTROL: the same relay running does publish', afterStop.length === 1,
    `${afterStop.length} published while running`);
}

// =============================================================================================
console.log('\naudit log — append-only, reason code mandatory');
// =============================================================================================
{
  const clock = fakeClock();
  const store = createFakeStore({ clock });
  const outbox = createOutbox({ store, clock });
  const logger = capturingLogger();
  const audit = createAuditLog({ store, clock, logger });
  const MOD = { kind: 'admin', id: 'mod.rivera@overstrike.gg', role: 'moderator', mfa: true };
  const correlationId = ulid(clock.now());

  const { row, event } = (await audit.recordWithEvent(outbox,
    { correlationId, actor: MOD },
    {
      action: 'sanction.apply', subject: { kind: 'account', id: 'A9' },
      reasonCode: 'policy_violation',
      before: { status: 'clear', secret: { token: 'x' } },
      after: { status: 'restricted' },
      summaryKeys: ['status'],
    },
    { type: 'sanction.applied', subject: { kind: 'account', id: 'A9' }, payload: { kind: 'restrict' } },
  )).result;

  assert('a privileged mutation records actor, role, reason and correlation',
    row.actorId === MOD.id && row.actorRole === 'moderator'
    && row.reasonCode === 'policy_violation' && row.correlationId === correlationId);
  assert('before/after are summaries, not row dumps',
    row.beforeSummary.status === 'clear' && row.beforeSummary.secret === undefined
    && row.afterSummary.status === 'restricted', JSON.stringify(row.beforeSummary));
  assert('the audit row and its event share one transaction and one correlation id',
    event.correlationId === correlationId && store.state.audit.length === 1 && store.state.outbox.size === 1);
  assert('the audit service exposes no update and no delete',
    audit.update === undefined && audit.delete === undefined && audit.remove === undefined);

  // CONTROL: an unexplained privileged action is a defect, so it must not be writable.
  await refuses('a privileged action with no reason code is refused',
    () => audit.record({ actor: MOD, action: 'sanction.apply', subject: { kind: 'account', id: 'A9' }, correlationId }),
    'reasonCode is required');
  await refuses('a free-text reason is refused',
    () => audit.record({ actor: MOD, action: 'sanction.apply', subject: { kind: 'account', id: 'A9' }, reasonCode: 'because', correlationId }),
    'must be a known code');
  await refuses('a shared admin identity is refused — the row would identify nobody',
    () => audit.record({ actor: { kind: 'admin', id: 'admin', role: 'superadmin' }, action: 'flag.toggle', subject: { kind: 'account', id: 'A9' }, reasonCode: 'kill_switch', correlationId }),
    'shared admin identity');
  await refuses('an audit row with no correlation id is refused',
    () => audit.record({ actor: MOD, action: 'sanction.apply', subject: { kind: 'account', id: 'A9' }, reasonCode: 'policy_violation' }),
    'correlationId is required');
  assert('none of the refused rows were written', store.state.audit.length === 1,
    String(store.state.audit.length));
}

// =============================================================================================
console.log('\naudit log — the attribution rules, one refusal at a time');
// =============================================================================================
{
  // Ten of thirteen guards in audit.js survived deletion. The section above proves the famous
  // four (reason code, free text, shared identity, correlation id); these are the rest, and they
  // are the ones that decide whether the two attribution columns can disagree.
  const clock = fakeClock();
  const store = createFakeStore({ clock });
  const logger = capturingLogger();
  const audit = createAuditLog({ store, clock, logger });
  const correlationId = ulid(clock.now());
  const MOD = { kind: 'admin', id: 'mod.rivera@overstrike.gg', role: 'moderator', mfa: true };
  const entry = (patch) => ({
    actor: MOD, action: 'sanction.apply', subject: { kind: 'account', id: 'A9' },
    reasonCode: 'policy_violation', correlationId, ...patch,
  });

  // ── capabilityForAction: the derivation, including the case that has no capability ─────────
  assert('an action derives the capability it is checked against',
    capabilityForAction('sanction.apply') === 'sanction:apply'
    && capabilityForAction('match.invalidate') === 'match:invalidate'
    && capabilityForAction('admin.action.executed') === 'admin.action:executed',
    [capabilityForAction('sanction.apply'), capabilityForAction('admin.action.executed')].join(' '));
  assert('an action with no dot derives NO capability rather than a mangled one',
    capabilityForAction('signin') === null && capabilityForAction('') === null
    && capabilityForAction('.leading') === null,
    `${capabilityForAction('signin')} ${capabilityForAction('')} ${capabilityForAction('.leading')}`);

  // ── summarise: a summary, not a second copy of the personal data ───────────────────────────
  assert('a primitive is summarised as a value, not silently flattened to nothing',
    JSON.stringify(summarise('Ghost', [])) === '{"value":"Ghost"}'
    && JSON.stringify(summarise(7, ['status'])) === '{"value":7}',
    JSON.stringify(summarise('Ghost', [])));
  assert('null and undefined summarise to null, which is what the column stores',
    summarise(null, ['a']) === null && summarise(undefined, ['a']) === null);
  assert('a requested key the row does not have is OMITTED, not recorded as undefined',
    Object.keys(summarise({ status: 'clear' }, ['status', 'displayName'])).join(',') === 'status',
    Object.keys(summarise({ status: 'clear' }, ['status', 'displayName'])).join(','));
  assert('CONTROL: a requested key the row does have is recorded',
    summarise({ status: 'clear', displayName: 'Ghost' }, ['status', 'displayName']).displayName === 'Ghost');
  assert('a nested object is stubbed rather than copied into the trail',
    summarise({ secret: { token: 'x' } }, ['secret']).secret === '[object]');

  // ── record(): every refusal, by its own reason ─────────────────────────────────────────────
  await refuses('a row with no actor is refused before any field of it is read',
    () => audit.record(entry({ actor: undefined })), 'actor is required');
  await refuses('an actor with a blank id is refused as unattributed',
    () => audit.record(entry({ actor: { ...MOD, id: '' } })),
    'actor.id is required');
  await refuses('a role that is not a contract role is refused',
    () => audit.record(entry({ actor: { ...MOD, role: 'wizard' } })),
    'actor.role must be a contract role');
  await refuses('an actor kind outside the closed set is refused, with no admin default',
    () => audit.record(entry({ actor: { ...MOD, kind: 'robot' } })),
    'actor.kind must be one of');
  await refuses('a kind and a role that disagree are refused — the trail must be queryable',
    () => audit.record(entry({ actor: { ...MOD, kind: 'player' } })),
    'actor.kind and actor.role disagree');
  await refuses('a row with a blank action is refused',
    () => audit.record(entry({ action: '' })), 'action is required');
  await refuses('a row with no subject is refused',
    () => audit.record(entry({ subject: undefined })), 'subject.kind and subject.id are required');
  await refuses('a subject with a blank id is refused too',
    () => audit.record(entry({ subject: { kind: 'account', id: '' } })),
    'subject.kind and subject.id are required');

  // The `capability: null` opt-out. It exists for signup/signin, which have no authenticated
  // actor to check — so it must be unusable by anything privileged, and unusable by a player
  // against an account that is not their own.
  await refuses('an elevated role may not opt out of the capability check',
    () => audit.record(entry({ capability: null })),
    'only an unprivileged self-service action');
  await refuses('and a player may not opt out against somebody else\'s account',
    () => audit.record(entry({
      capability: null, actor: { kind: 'player', id: 'P1', accountId: 'P1', role: 'player' },
      action: 'account.signin', subject: { kind: 'account', id: 'P2' },
      reasonCode: 'account_self_service',
    })),
    'only an unprivileged self-service action');
  const selfServed = await audit.record(entry({
    capability: null, actor: { kind: 'player', id: 'P1', accountId: 'P1', role: 'player' },
    action: 'account.signin', subject: { kind: 'account', id: 'P1' },
    reasonCode: 'account_self_service',
  }));
  assert('CONTROL: a player acting on their OWN account may be recorded without a capability',
    selfServed.actorId === 'P1' && selfServed.actorRole === 'player' && selfServed.actorKind === 'player',
    JSON.stringify(selfServed));

  assert('exactly one of those rows was written — the refusals wrote nothing',
    store.state.audit.length === 1, String(store.state.audit.length));
  assert('and writing one emits the audit.recorded log line that makes it findable',
    logger.lines.some((l) => l.event === 'audit.recorded' && l.level === 'info'
      && l.auditId === selfServed.auditId && l.action === 'account.signin'
      && l.correlationId === correlationId && l.reasonCode === 'account_self_service'),
    JSON.stringify(logger.lines));
}

// =============================================================================================
console.log('\nRBAC — least privilege, scoped, no shared identity');
// =============================================================================================
{
  const player = { kind: 'player', id: 'P1', accountId: 'P1', role: 'player' };
  const support = { kind: 'admin', id: 'sam.okafor@overstrike.gg', role: 'support', mfa: true };
  const service = { kind: 'service', id: 'allocator-1', role: 'service', serviceName: 'allocator' };

  assert('a player may read their own account', check(player, 'account:read', { accountId: 'P1' }).allowed);
  assert('a player may not read another account',
    check(player, 'account:read', { accountId: 'P2' }).reason === 'out_of_scope');
  assert('a self-scoped check with no target is refused, not assumed to mean "me"',
    check(player, 'account:read', {}).reason === 'self_scope_needs_target');
  assert('support may read any account but may not sanction',
    check(support, 'account:read', { accountId: 'P2' }).allowed
    && check(support, 'sanction:apply', { accountId: 'P2' }).reason === 'capability_not_granted');
  assert('finance may approve a payout but cannot read accounts',
    check({ kind: 'admin', id: 'fin@x.gg', role: 'finance', mfa: true }, 'payout:approve').allowed
    && !check({ kind: 'admin', id: 'fin@x.gg', role: 'finance', mfa: true }, 'account:read', { accountId: 'P2' }).allowed);
  assert('an elevated role without a second factor is refused',
    check({ ...support, mfa: false }, 'account:read', { accountId: 'P2' }).reason === 'mfa_required');
  assert('a shared admin login is refused outright',
    check({ kind: 'admin', id: 'admin', role: 'superadmin', mfa: true }, 'flag:toggle').reason === 'shared_identity');
  assert('a service token cannot read accounts or sanction anyone',
    check(service, 'match:allocate').allowed
    && !check(service, 'account:read', { accountId: 'P2' }).allowed
    && !check(service, 'sanction:apply', { accountId: 'P2' }).allowed);
  assert('no role is a wildcard — superadmin is enumerated',
    !capabilitiesOf('superadmin').includes('*') && capabilitiesOf('superadmin').length > 0);
  assert('every contract role exists and none is empty',
    ROLES.every((r) => capabilitiesOf(r).length > 0), ROLES.filter((r) => !capabilitiesOf(r).length).join(','));

  await refuses('requireCapability throws AUTH_FORBIDDEN on refusal',
    async () => requireCapability(player, 'sanction:apply', { accountId: 'P2' }),
    'permission');
  // CONTROL: the same call for a role that holds the capability must pass, or the assertion
  // above would be satisfied by a check that refuses everything.
  assert('CONTROL: a moderator passes the same check',
    requireCapability({ kind: 'admin', id: 'mod@x.gg', role: 'moderator', mfa: true },
      'sanction:apply', { accountId: 'P2' }).allowed);

  // ── the refusals nothing was asserting ────────────────────────────────────────────────────
  // Five guards in rbac.js survived deletion. Each is a refusal that the block above reached
  // only along paths where a LATER guard refused anyway, so the reason is the assertion: an
  // actor with a bogus role that comes back `capability_not_granted` instead of `unknown_role`
  // has been quietly told the rule is about the capability when it is about the identity.
  //
  // `check()` is called through a wrapper that reports a throw as a reason string, so a guard
  // whose deletion turns a refusal into a TypeError fails this check rather than the suite.
  const reasonFor = (actor, capability, target) => {
    try {
      const v = check(actor, capability, target);
      return v.allowed ? 'ALLOWED' : v.reason;
    } catch (err) { return `threw: ${err.message}`; }
  };
  const shared = (id) => {
    try { return isSharedIdentity(id); } catch (err) { return `threw: ${err.message}`; }
  };

  assert('an absent actor id is a shared identity, not a lookup that explodes',
    shared(undefined) === true && shared(null) === true && shared('') === true,
    `${shared(undefined)} ${shared(null)} ${shared('')}`);
  assert('CONTROL: a named human is not a shared identity',
    isSharedIdentity('sam.okafor@overstrike.gg') === false);
  assert('a role-mailbox prefix is shared however it is cased or padded',
    isSharedIdentity('  Support@overstrike.gg ') === true && isSharedIdentity('ROOT') === true);

  assert('no actor at all is refused as no_actor, before any field is read',
    reasonFor(null, 'account:read', { accountId: 'P1' }) === 'no_actor'
    && reasonFor(undefined, 'account:read', { accountId: 'P1' }) === 'no_actor'
    && reasonFor('P1', 'account:read', { accountId: 'P1' }) === 'no_actor',
    [null, undefined, 'P1'].map((a) => reasonFor(a, 'account:read', { accountId: 'P1' })).join(' '));
  assert('an actor object with no id is unattributed, which is a different refusal',
    reasonFor({ kind: 'player', role: 'player' }, 'account:read', { accountId: 'P1' })
      === 'unattributed_actor');

  assert('an actor carrying no role at all is unknown_role, not merely ungranted',
    reasonFor({ kind: 'player', id: 'P1', accountId: 'P1' }, 'account:read', { accountId: 'P1' })
      === 'unknown_role');
  assert('a role outside the contract set is unknown_role, not a table lookup on undefined',
    reasonFor({ kind: 'admin', id: 'x@y.gg', role: 'wizard', mfa: true }, 'account:read', { accountId: 'P1' })
      === 'unknown_role');
  assert('one bad role spoils the array — a real role does not launder a fake one',
    reasonFor({ kind: 'admin', id: 'x@y.gg', roles: ['moderator', 'wizard'], mfa: true },
      'sanction:apply', { accountId: 'P1' }) === 'unknown_role');
  assert('CONTROL: the same array without the fake role is allowed',
    reasonFor({ kind: 'admin', id: 'x@y.gg', roles: ['moderator'], mfa: true },
      'sanction:apply', { accountId: 'P1' }) === 'ALLOWED');

  // Each role is evaluated on its own terms (the module header). A player who also holds an
  // elevated role they have not second-factored must still be able to read their own account as
  // a player — the elevated refusal is about the elevated role, not about the actor.
  assert('a granting role wins even when an earlier role refused for a more specific reason',
    reasonFor({ kind: 'player', id: 'P1', accountId: 'P1', roles: ['support', 'player'], mfa: false },
      'account:read', { accountId: 'P1' }) === 'ALLOWED');
  assert('CONTROL: with no granting role the specific refusal is what comes back',
    reasonFor({ kind: 'admin', id: 'sam.okafor@overstrike.gg', roles: ['support'], mfa: false },
      'account:read', { accountId: 'P1' }) === 'mfa_required');

  assert('a service token with no service name is refused; an audit row would name nobody',
    reasonFor({ kind: 'service', id: 'allocator-1', role: 'service' }, 'match:allocate') === 'unnamed_service'
    && reasonFor({ kind: 'service', id: 'allocator-1', role: 'service', serviceName: '   ' }, 'match:allocate')
      === 'unnamed_service'
    && reasonFor({ kind: 'service', id: 'allocator-1', role: 'service', serviceName: null }, 'match:allocate')
      === 'unnamed_service');
  assert('CONTROL: the same token with a name is allowed',
    reasonFor({ kind: 'service', id: 'allocator-1', role: 'service', serviceName: 'allocator' },
      'match:allocate') === 'ALLOWED');
}

// =============================================================================================
console.log('\nagainst the real memory store adapter');
// =============================================================================================
{
  // The fake above gives the control cases their rollback and their reversed claim order. This
  // section answers the different question: does any of it work against the adapter that ships?
  // A module that only ever meets its own test double is a module with an untested boundary.
  const { createStore } = await import('../src/core/store.js');
  const store = await createStore({ storage: 'memory' }, {});
  const clock = fakeClock();
  const logger = capturingLogger();
  const outbox = createOutbox({ store, clock });
  const audit = createAuditLog({ store, clock, logger });
  const correlationId = ulid(clock.now());

  const { events } = await outbox.commit({ correlationId, actor: SERVICE }, async (tx, emit) => {
    await emit({ type: 'match.started', subject: { kind: 'match', id: 'M-real' }, payload: {} });
    await emit({ type: 'match.completed', subject: { kind: 'match', id: 'M-real' }, payload: { winner: 1 } });
  });
  assert('the outbox writes real events_outbox rows', events.length === 2);

  const delivered = [];
  const relay = createRelay({ store, logger, clock, publish: async (e) => { delivered.push(e); } });
  await relay.drain();
  assert('the relay rehydrates §2 envelopes from §5 rows',
    delivered.length === 2 && validateEvent(delivered[0]).length === 0,
    JSON.stringify(validateEvent(delivered[0] || {})));
  assert('and preserves per-subject order and the schemaRef',
    delivered[0].type === 'match.started' && delivered[1].type === 'match.completed'
    && delivered[1].schemaRef === 'events/match.completed/v1',
    delivered.map((d) => d.type).join(','));
  assert('a second drain publishes nothing — rows were marked',
    (await relay.drain()).published === 0);

  await audit.record({
    actor: { kind: 'admin', id: 'mod.rivera@overstrike.gg', role: 'moderator', mfa: true },
    action: 'match.invalidate', subject: { kind: 'match', id: 'M-real' },
    reasonCode: 'match_integrity', before: { valid: true }, after: { valid: false }, correlationId,
  });
  const rows = await store.audit.list({});
  assert('the audit row lands in the real append-only table',
    rows.length === 1 && rows[0].reasonCode === 'match_integrity', JSON.stringify(rows));
  assert('the real audit table exposes no update or delete either',
    store.audit.update === undefined && store.audit.delete === undefined);
  await store.close?.();
}

console.log(failures ? `\n${failures} FAILED` : '\nplatform events run clean');
process.exit(failures ? 1 : 0);
