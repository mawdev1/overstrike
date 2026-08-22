/**
 * P3 route wiring.  items-inventory.md §7, deployment.md §7/§7.1, settlement.md §5/§7 — over
 * the REAL assembled app, real socket, real routes, no module substituted.
 *
 * The P3 module suites (inventorytest, deploymenttest, settlementtest) prove the services in
 * isolation; the composition-root lesson at the top of apptest.mjs is that isolation is exactly
 * where wiring defects hide. This suite is the HTTP half: every contracted endpoint answers at
 * its contracted path, behind its contracted gate, with its contracted shape — including the
 * one full pipeline (grant → loadout → reserve → snapshot → verify → run-result → settle) that
 * crosses all three modules and the outbox.
 *
 *   node platform/test/p3routestest.mjs
 */
import { loadConfig } from '../src/core/config.js';
import { buildApp } from '../src/app.js';

let passed = 0;
let failed = 0;
const check = (cond, label, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); if (detail) console.log(`       ${detail}`); }
};
const section = (name) => console.log(`\n--- ${name} ---`);

const silent = () => {
  const noop = () => {};
  const l = { debug: noop, info: noop, warn: noop, error: noop };
  l.child = () => l;
  return l;
};

async function withApp(fn, envOverrides = {}) {
  // `process.env` first, same reasoning as apptest: pgtest points this suite at a real
  // database by environment, and a bare literal would silently rebuild it on memory.
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', PLATFORM_PORT: '0', ...envOverrides });
  const app = await buildApp(config, { logger: silent() });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-client-build': '1.0.0', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* the check will say so */ }
    return { status: res.status, body: json, headers: res.headers };
  };
  try { return await fn({ app, call, config }); }
  finally {
    app.stop();
    app.server.closeAllConnections?.();
    await new Promise((r) => app.server.close(r));
  }
}

/** The approved onboarding chain, minimal: yields a bearer token and the account id. */
let identity = 0;
async function onboard(call) {
  const n = ++identity;
  const sid = `01M0EFV571B7VBQCNXHAT5W${String(100 + n).slice(-3)}`;
  const elig = await call('POST', '/v1/onboarding/eligibility',
    { dateOfBirth: '1994-03-02', jurisdiction: 'CA-ON' });
  const consent = await call('PUT', '/v1/onboarding/consent',
    { telemetryPersonal: true, policyVersion: 1, clientSessionId: sid });
  const signup = await call('POST', '/v1/auth/signup', {
    email: `p3player${n}@example.invalid`, password: 'correct horse battery staple',
    displayName: `Vex${n}`,
    eligibilityReceipt: elig.body?.receipt, clientSessionId: sid,
    consentReceipt: consent.body?.receipt,
  });
  const token = signup.body?.accessToken;
  const me = await call('GET', '/v1/profile/me', undefined, { authorization: `Bearer ${token}` });
  return { auth: { authorization: `Bearer ${token}` }, accountId: me.body?.accountId };
}

/** Seed a definition and grant permanent instances through the real service (§6.3's one path). */
async function seedKit(app, accountId) {
  const inv = app.deps.inventory.service;
  const actor = { kind: 'service', id: 'test-seeder', role: 'loot-spawn' };
  const define = async (row) => {
    // Idempotent across withApp sections sharing one database (pgtest): a definition that
    // already exists is the seed this needs, not a failure.
    try { await inv.defineItem(row); } catch { /* already defined */ }
  };
  await define({ itemId: 'rifle_ak74', class: 'weapon', slot: 'primary', rarityTier: 'rare', stackable: false, durabilityMax: 100 });
  await define({ itemId: 'helmet_halfshell', class: 'gear', slot: 'helmet', rarityTier: 'epic', stackable: false, durabilityMax: 40 });
  await define({ itemId: 'medkit_field', class: 'consumable', slot: 'consumable', rarityTier: 'uncommon', stackable: true, maxStack: 3 });
  const grant = async (itemId, quantity = 1) => (await inv.grantItem({
    itemId, ownerAccountId: accountId, quantity, location: 'permanent', actor,
  })).instance;
  return {
    rifle: await grant('rifle_ak74'),
    helmet: await grant('helmet_halfshell'),
    medkit: await grant('medkit_field', 2),
  };
}

const SERVICE = (config) => ({ 'x-service-token': config.serviceToken });

// ── 1. the P3 modules mount, and their client routes are gated ─────────────────────────────
await withApp(async ({ app, call }) => {
  section('mounting and gates');
  for (const name of ['inventory', 'deployment', 'settlement']) {
    check(app.mounted.includes(name), `${name} module mounts`, JSON.stringify(app.mounted));
  }
  const anon = await call('GET', '/v1/inventory');
  check(anon.status === 401, 'GET /v1/inventory refuses an unauthenticated caller', String(anon.status));
  const anonReserve = await call('POST', '/v1/deployments', { instanceIds: ['x'] });
  check(anonReserve.status === 401, 'POST /v1/deployments refuses an unauthenticated caller', String(anonReserve.status));
  const noToken = await call('POST', '/v1/runs/whatever/result', {});
  check(noToken.status === 403 && noToken.body?.error?.code === 'AUTH_FORBIDDEN',
    'POST /v1/runs/:runId/result is service-only', JSON.stringify(noToken.body));
  const noTokenQueue = await call('GET', '/v1/settlement/exceptions');
  check(noTokenQueue.status === 403, 'the exception queue is not client-reachable', String(noTokenQueue.status));
});

// ── 2. inventory listing and inspection ────────────────────────────────────────────────────
await withApp(async ({ app, call }) => {
  section('inventory routes');
  const { auth, accountId } = await onboard(call);
  const empty = await call('GET', '/v1/inventory', undefined, auth);
  check(empty.status === 200 && Array.isArray(empty.body?.items) && empty.body.items.length === 0
    && empty.body.nextCursor === null,
    'an empty inventory is items:[] with a null cursor', JSON.stringify(empty.body));

  const kit = await seedKit(app, accountId);
  const list = await call('GET', '/v1/inventory', undefined, auth);
  check(list.status === 200 && list.body.items.length === 3,
    'granted instances appear in the listing', JSON.stringify(list.body));
  const first = list.body.items[0];
  check(first && typeof first.definition === 'object' && first.definition.itemId === first.itemId,
    'every listed instance carries its definition inlined', JSON.stringify(first));
  check(first && !('ownerAccountId' in first) && !('attachments' in first) && !('createdAt' in first),
    'server-side columns do not travel', JSON.stringify(first));

  const page1 = await call('GET', '/v1/inventory?limit=2', undefined, auth);
  check(page1.body.items.length === 2 && typeof page1.body.nextCursor === 'string',
    'limit=2 pages with a cursor', JSON.stringify(page1.body));
  const page2 = await call('GET', `/v1/inventory?limit=2&cursor=${page1.body.nextCursor}`, undefined, auth);
  check(page2.body.items.length === 1 && page2.body.nextCursor === null,
    'the cursor resumes where the page ended', JSON.stringify(page2.body));
  const badLimit = await call('GET', '/v1/inventory?limit=5000', undefined, auth);
  check(badLimit.status === 400, 'an out-of-range limit is REJECTED, not clamped (§10)', String(badLimit.status));

  const one = await call('GET', `/v1/inventory/${kit.rifle.instanceId}`, undefined, auth);
  check(one.status === 200 && one.body.instanceId === kit.rifle.instanceId
    && one.body.definition?.slot === 'primary',
    'GET /v1/inventory/:instanceId inlines the definition', JSON.stringify(one.body));

  const stranger = await onboard(call);
  const notMine = await call('GET', `/v1/inventory/${kit.rifle.instanceId}`, undefined, stranger.auth);
  check(notMine.status === 404, 'another account\'s instance answers 404, not 403', String(notMine.status));
});

// ── 3. loadout CRUD, idempotency included ─────────────────────────────────────────────────
await withApp(async ({ app, call }) => {
  section('loadout routes');
  const { auth, accountId } = await onboard(call);
  const kit = await seedKit(app, accountId);

  const noKey = await call('POST', '/v1/loadouts', { name: 'Kit', slots: {} }, auth);
  check(noKey.status === 400 && noKey.body?.error?.code === 'VALIDATION_FAILED',
    'POST /v1/loadouts without Idempotency-Key is refused (§8)', JSON.stringify(noKey.body));

  const key = { ...auth, 'idempotency-key': 'loadout-create-1' };
  const body = { name: 'Raid kit A', slots: { primary: kit.rifle.instanceId, helmet: kit.helmet.instanceId } };
  const created = await call('POST', '/v1/loadouts', body, key);
  check(created.status === 200 && typeof created.body.loadoutId === 'string'
    && created.body.isDefault === false && created.body.slots.primary === kit.rifle.instanceId,
    'create returns the contract loadout shape', JSON.stringify(created.body));
  const replay = await call('POST', '/v1/loadouts', body, key);
  check(replay.status === 200 && replay.body.loadoutId === created.body.loadoutId,
    'an identical replay returns the STORED loadout, not a second one', JSON.stringify(replay.body));
  const reused = await call('POST', '/v1/loadouts', { name: 'Different', slots: {} }, key);
  check(reused.status === 409 && reused.body?.error?.code === 'IDEMPOTENCY_KEY_REUSED',
    'the same key with a different request is refused', JSON.stringify(reused.body));

  const badSlot = await call('POST', '/v1/loadouts',
    { name: 'Wrong', slots: { helmet: kit.rifle.instanceId } },
    { ...auth, 'idempotency-key': 'loadout-create-2' });
  check(badSlot.status === 400 && badSlot.body?.error?.code === 'LOADOUT_INVALID_SLOT',
    'a rifle in the helmet slot is LOADOUT_INVALID_SLOT', JSON.stringify(badSlot.body));

  const listed = await call('GET', '/v1/loadouts', undefined, auth);
  check(listed.status === 200 && listed.body.loadouts.length === 1
    && listed.body.loadouts[0].loadoutId === created.body.loadoutId,
    'the loadout lists back', JSON.stringify(listed.body));

  const dflt = await call('POST', `/v1/loadouts/${created.body.loadoutId}/set-default`, {}, auth);
  check(dflt.status === 200 && dflt.body.isDefault === true, 'set-default flips the flag', JSON.stringify(dflt.body));

  const patched = await call('PATCH', `/v1/loadouts/${created.body.loadoutId}`,
    { name: 'Renamed kit' }, { ...auth, 'idempotency-key': 'loadout-patch-1' });
  check(patched.status === 200 && patched.body.name === 'Renamed kit', 'PATCH renames', JSON.stringify(patched.body));

  const gone = await call('DELETE', `/v1/loadouts/${created.body.loadoutId}`, undefined, auth);
  check(gone.status === 204, 'DELETE answers 204', String(gone.status));
  const after = await call('GET', '/v1/loadouts', undefined, auth);
  check(after.body.loadouts.length === 0, 'and the loadout is gone', JSON.stringify(after.body));
});

// ── 4. the full deployment → settlement pipeline over HTTP ────────────────────────────────
await withApp(async ({ app, call, config }) => {
  section('deployment and settlement pipeline');
  const { auth, accountId } = await onboard(call);
  const kit = await seedKit(app, accountId);
  const loadout = (await call('POST', '/v1/loadouts',
    { name: 'Pipeline kit', slots: { primary: kit.rifle.instanceId, helmet: kit.helmet.instanceId } },
    { ...auth, 'idempotency-key': 'pipe-loadout' })).body;

  // Reserve — and prove the §8 replay and the §3 conflict.
  const rkey = { ...auth, 'idempotency-key': 'pipe-reserve' };
  const reserved = await call('POST', '/v1/deployments', { loadoutId: loadout.loadoutId, roomId: null }, rkey);
  check(reserved.status === 200 && typeof reserved.body.reservationId === 'string'
    && reserved.body.instanceIds.length === 2 && typeof reserved.body.expiresAt === 'string',
    'POST /v1/deployments reserves the loadout', JSON.stringify(reserved.body));
  const rifleRow = await app.deps.inventory.service.getInstance(kit.rifle.instanceId);
  check(rifleRow.locked && rifleRow.lockedByDeploymentId === reserved.body.reservationId,
    'the reservation holds the real §6.2 lock', JSON.stringify(rifleRow));

  const rreplay = await call('POST', '/v1/deployments', { loadoutId: loadout.loadoutId, roomId: null }, rkey);
  check(rreplay.status === 200 && rreplay.body.reservationId === reserved.body.reservationId,
    'an identical reserve replay returns the stored reservation', JSON.stringify(rreplay.body));

  const conflict = await call('POST', '/v1/deployments',
    { instanceIds: [kit.rifle.instanceId], roomId: null }, { ...auth, 'idempotency-key': 'pipe-conflict' });
  check(conflict.status === 409 && conflict.body?.error?.code === 'DEPLOYMENT_RESERVATION_CONFLICT'
    && conflict.body.error.details?.conflictingInstances?.[0]?.reason === 'ITEM_ALREADY_DEPLOYED',
    'a second deployment of a locked instance is the §3 409 with the per-instance breakdown',
    JSON.stringify(conflict.body));
  const conflictReplay = await call('POST', '/v1/deployments',
    { instanceIds: [kit.rifle.instanceId], roomId: null }, { ...auth, 'idempotency-key': 'pipe-conflict' });
  check(conflictReplay.status === 409
    && conflictReplay.body?.error?.code === 'DEPLOYMENT_RESERVATION_CONFLICT',
    'the 409 replays from the idempotency cache (§7\'s own note)', JSON.stringify(conflictReplay.body));

  // Bind a match and issue the snapshot (internal — §4.3 says never client-callable, so this
  // step goes through the service exactly as the allocator would).
  const runId = `01M0EFRUN${String(100 + identity).slice(-3)}0000000000000`;
  await app.deps.store.matches.allocateRun({
    matchId: runId, region: 'yyz', mapId: 'sector-7', serverBuild: 'build-1', participants: [accountId],
  });
  const snapshot = await app.deps.deployment.service.issueSnapshot({
    reservationId: reserved.body.reservationId, matchId: runId,
  });

  const noSvc = await call('POST', `/v1/deployments/${reserved.body.reservationId}/verify-snapshot`,
    { matchId: runId, accountId, snapshot: { payload: snapshot.payload, signature: snapshot.signature } });
  check(noSvc.status === 403, 'verify-snapshot refuses a caller without the service token', String(noSvc.status));

  const verified = await call('POST', `/v1/deployments/${reserved.body.reservationId}/verify-snapshot`,
    { matchId: runId, accountId, snapshot: { payload: snapshot.payload, signature: snapshot.signature } },
    SERVICE(config));
  check(verified.status === 200 && verified.body.reservationId === reserved.body.reservationId,
    'the match server verifies and consumes the snapshot over HTTP', JSON.stringify(verified.body));
  const seeded = await app.deps.inventory.service.getInstance(kit.rifle.instanceId);
  check(seeded.location === 'run' && seeded.runId === runId && seeded.locked,
    'consumption seeds the run inventory, lock still held (§4.5 step 4)', JSON.stringify(seeded));

  const again = await call('POST', `/v1/deployments/${reserved.body.reservationId}/verify-snapshot`,
    { matchId: runId, accountId, snapshot: { payload: snapshot.payload, signature: snapshot.signature } },
    SERVICE(config));
  check(again.status === 401 && again.body?.error?.code === 'DEPLOYMENT_SNAPSHOT_INVALID',
    'a replayed snapshot is refused (§4.4)', JSON.stringify(again.body));

  const lateAbort = await call('DELETE', `/v1/deployments/${reserved.body.reservationId}`, undefined, auth);
  check(lateAbort.status === 409 && lateAbort.body?.error?.code === 'DEPLOYMENT_ALREADY_CONSUMED',
    'aborting a consumed reservation is DEPLOYMENT_ALREADY_CONSUMED', JSON.stringify(lateAbort.body));

  // The run ends: the raid server submits the §5.1 RunResult over HTTP.
  const runResult = {
    runId,
    participants: [{ accountId, outcome: 'extracted', exitId: 'exit-north' }],
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    serverBuild: 'build-1', sectorSet: ['sector-7'], evidenceRef: `evidence:${runId}`,
  };
  const idem = { ...SERVICE(config), 'idempotency-key': `run-result:${runId}` };
  const settled = await call('POST', `/v1/runs/${runId}/result`, runResult, idem);
  check(settled.status === 200 && settled.body.participants?.[0]?.settlementStatus === 'settled'
    && settled.body.participants[0].outcome === 'extracted' && settled.body.runLevelException === null,
    'the run result settles the participant (§5.3 shape)', JSON.stringify(settled.body));
  const home = await app.deps.inventory.service.getInstance(kit.rifle.instanceId);
  check(home.location === 'permanent' && !home.locked && home.runId === null,
    'an extracted instance is permanent again with the lock cleared', JSON.stringify(home));

  const wrongKey = await call('POST', `/v1/runs/${runId}/result`, runResult,
    { ...SERVICE(config), 'idempotency-key': 'not-the-derived-key' });
  check(wrongKey.status === 400, 'a non-derived Idempotency-Key is refused (§5 rule 6)', String(wrongKey.status));
  const replayed = await call('POST', `/v1/runs/${runId}/result`, runResult, idem);
  check(replayed.status === 200 && replayed.body.resultAppliedAt === settled.body.resultAppliedAt,
    'an identical resubmission replays the stored response (§5 rule 3)', JSON.stringify(replayed.body));
  const different = await call('POST', `/v1/runs/${runId}/result`,
    { ...runResult, participants: [{ accountId, outcome: 'died', deathCause: 'ai' }] }, idem);
  check(different.status === 409 && different.body?.error?.code === 'CONFLICT',
    'a different truth about a finalised run is CONFLICT (§5 rule 4)', JSON.stringify(different.body));

  const mismatch = await call('POST', `/v1/runs/${runId}/result`,
    { ...runResult, runId: 'someother' }, idem);
  check(mismatch.status === 400, 'a body naming a different run than the path is refused', String(mismatch.status));
});

// ── 5. the exception queue over HTTP ───────────────────────────────────────────────────────
await withApp(async ({ app, call, config }) => {
  section('exception queue');
  const { auth, accountId } = await onboard(call);
  const kit = await seedKit(app, accountId);
  void auth;
  const runId = `01M0EFEXC${String(100 + identity).slice(-3)}0000000000000`;
  await app.deps.store.matches.allocateRun({
    matchId: runId, region: 'yyz', mapId: 'sector-7', serverBuild: 'build-1', participants: [accountId],
  });
  // A surviving run row with NO lock — §7.1's lock-mismatch trigger.
  await app.deps.inventory.service.mutateInstance(kit.rifle.instanceId,
    { location: 'run', runId }, { allowLocked: true });

  const runResult = {
    runId, participants: [{ accountId, outcome: 'extracted', exitId: 'exit-a' }],
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    serverBuild: 'build-1', sectorSet: ['sector-7'], evidenceRef: `evidence:${runId}`,
  };
  const submitted = await call('POST', `/v1/runs/${runId}/result`, runResult,
    { ...SERVICE(config), 'idempotency-key': `run-result:${runId}` });
  check(submitted.status === 200
    && submitted.body.participants?.[0]?.settlementStatus === 'exception-open'
    && submitted.body.participants[0].trigger === 'lock-mismatch',
    'a lock mismatch opens an exception instead of settling', JSON.stringify(submitted.body));
  const exceptionId = submitted.body.participants[0].exceptionId;

  const queue = await call('GET', '/v1/settlement/exceptions?status=open', undefined, SERVICE(config));
  check(queue.status === 200 && queue.body.items.some((e) => e.exceptionId === exceptionId),
    'the queue lists the open exception (§7.4 step 2)', JSON.stringify(queue.body));

  const row = (await call('GET', `/v1/settlement/exceptions/${exceptionId}`, undefined, SERVICE(config))).body;
  const claimed = await call('POST', `/v1/settlement/exceptions/${exceptionId}/claim`,
    { operatorId: 'op-jamie', expectedUpdatedAt: row.updatedAt }, SERVICE(config));
  check(claimed.status === 200 && claimed.body.status === 'in-review',
    'a claim moves the exception to in-review (§7.4 step 3)', JSON.stringify(claimed.body));
  const staleClaim = await call('POST', `/v1/settlement/exceptions/${exceptionId}/claim`,
    { operatorId: 'op-other', expectedUpdatedAt: row.updatedAt }, SERVICE(config));
  check(staleClaim.status === 409, 'a second claim on the stale updatedAt loses', String(staleClaim.status));

  const noNotes = await call('POST', `/v1/settlement/exceptions/${exceptionId}/resolve`,
    { resolution: 'settle-as-extracted', reviewedBy: 'op-jamie' }, SERVICE(config));
  check(noNotes.status === 400, 'resolving without notes is refused (§7.3)', String(noNotes.status));

  const resolved = await call('POST', `/v1/settlement/exceptions/${exceptionId}/resolve`,
    { resolution: 'settle-as-extracted', resolutionNotes: 'evidence matched the extract log',
      reviewedBy: 'op-jamie' }, SERVICE(config));
  check(resolved.status === 200 && resolved.body.settlementStatus === 'exception-resolved'
    && resolved.body.outcome === 'extracted',
    'resolution re-enters §6 with the forced outcome', JSON.stringify(resolved.body));
  const rifle = await app.deps.inventory.service.getInstance(kit.rifle.instanceId);
  check(rifle.location === 'permanent', 'and the item comes home', JSON.stringify(rifle));

  const stalls = await call('POST', '/v1/settlement/stall-check', {}, SERVICE(config));
  check(stalls.status === 200 && Array.isArray(stalls.body.opened),
    'the stall detector runs on demand (§7.2)', JSON.stringify(stalls.body));
});

// ── 6. events land in the REAL outbox ──────────────────────────────────────────────────────
await withApp(async ({ app }) => {
  section('outbox wiring');
  const correlationId = '01M0EFV571B7VBQCNXHATEVT01';
  await app.deps.inventory.service.defineItem({
    itemId: 'medkit_field', class: 'consumable', slot: 'consumable', rarityTier: 'uncommon',
    stackable: true, maxStack: 3,
  }).catch(() => {});
  await app.deps.inventory.service.grantItem({
    itemId: 'medkit_field', ownerAccountId: null, quantity: 1, location: 'world',
    actor: { kind: 'service', id: 'loot-roller', role: 'loot-spawn' }, correlationId,
  });
  const rows = await (app.deps.store.outbox.list?.({ correlationId, limit: 10 }) ?? []);
  check(rows.some((r) => r.eventType === 'item.created' || r.type === 'item.created'),
    'grantItem\'s item.created reaches events_outbox — the module is no longer unwired',
    JSON.stringify(rows));
});

// ── 7. the stub layer answers every new client endpoint ────────────────────────────────────
await withApp(async ({ call }) => {
  section('stub layer');
  const stub = (extra = {}) => ({ 'x-stub-scenario': 'default', ...extra });
  const signin = await call('POST', '/v1/auth/signin',
    { email: 'stub@example.invalid', password: 'correct horse battery staple' }, stub());
  const sAuth = stub({ authorization: `Bearer ${signin.body?.accessToken}` });

  const inv = await call('GET', '/v1/inventory', undefined, sAuth);
  check(inv.status === 200 && inv.body.items.length > 0
    && inv.body.items.every((i) => i.definition && i.definition.itemId === i.itemId),
    'stub GET /v1/inventory serves definition-inlined instances', JSON.stringify(inv.body?.items?.[0]));
  const raidItem = inv.body.items.find((i) => i.location === 'run');
  check(raidItem === undefined, 'the permanent listing never contains run items', JSON.stringify(raidItem));

  const loadouts = await call('GET', '/v1/loadouts', undefined, sAuth);
  check(loadouts.status === 200 && loadouts.body.loadouts.length === 2
    && loadouts.body.loadouts.filter((l) => l.isDefault).length === 1,
    'stub loadouts list with exactly one default', JSON.stringify(loadouts.body));

  const createNoKey = await call('POST', '/v1/loadouts', { name: 'Kit', slots: {} }, sAuth);
  check(createNoKey.status === 400, 'stub loadout create requires Idempotency-Key', String(createNoKey.status));

  const rifleId = inv.body.items.find((i) => i.definition.slot === 'primary')?.instanceId;
  const createRes = await call('POST', '/v1/loadouts',
    { name: 'Stub kit', slots: { primary: rifleId } }, { ...sAuth, 'idempotency-key': 'stub-1' });
  check(createRes.status === 200 && createRes.body.slots.primary === rifleId,
    'stub loadout create round-trips', JSON.stringify(createRes.body));

  const reserve = await call('POST', '/v1/deployments',
    { loadoutId: createRes.body.loadoutId, roomId: null }, { ...sAuth, 'idempotency-key': 'stub-2' });
  check(reserve.status === 200 && reserve.body.instanceIds.includes(rifleId),
    'stub deployment reserves', JSON.stringify(reserve.body));
  const conflict = await call('POST', '/v1/deployments',
    { instanceIds: [rifleId], roomId: null }, { ...sAuth, 'idempotency-key': 'stub-3' });
  check(conflict.status === 409 && conflict.body?.error?.code === 'DEPLOYMENT_RESERVATION_CONFLICT',
    'stub reservation conflict is stateful, not canned', JSON.stringify(conflict.body));
  const abort = await call('DELETE', `/v1/deployments/${reserve.body.reservationId}`, undefined, sAuth);
  check(abort.status === 204, 'stub abort answers 204', String(abort.status));
  const retry = await call('POST', '/v1/deployments',
    { instanceIds: [rifleId], roomId: null }, { ...sAuth, 'idempotency-key': 'stub-4' });
  check(retry.status === 200, 'after the abort the instance is reservable again', JSON.stringify(retry.body));

  const svc = await call('POST', '/v1/runs/some-run/result', {}, stub());
  check(svc.status === 404 || svc.status === 403,
    'the stub never serves the service-only settlement surface', String(svc.status));
});

console.log(`\np3routestest: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
