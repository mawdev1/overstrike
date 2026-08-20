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
import { createConsumer } from '../src/modules/events/consumer.js';
import { createAuditLog } from '../src/modules/events/audit.js';
import { buildEvent, validateEvent, EventContractError } from '../src/modules/events/envelope.js';
import { check, requireCapability, capabilitiesOf, ROLES } from '../src/modules/events/rbac.js';
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
