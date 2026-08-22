/**
 * P3-02 — atomic deployment reservation and the signed inventory snapshot.
 *
 * contracts/deployment.md, migration 0028. Builds on `../inventory/index.js` (P3-01) exactly as
 * that module's own header says to: `reserveInstances`/`releaseInstances`/`moveLockedToRun` are
 * the primitives this module composes into the actual reservation/snapshot/release lifecycle.
 * This module does not re-implement items-inventory.md §6.2's lock — it calls it.
 *
 * ── Drift from the contract's literal pseudocode, and why ──────────────────────────────────
 * `deployment.md` §2.1 writes the reservation as one `BEGIN … COMMIT` touching both
 * `item_instances` and `deployment_reservations`. In this codebase those are two different
 * modules, each with its own self-contained store (inventory/store.js's own Postgres pool,
 * this module's own pool) — the same "self-contained slice" shape `inventory/index.js`'s own
 * header commits to. A single SQL transaction across two independently-pooled stores isn't
 * available without deeper platform wiring that is out of this module's scope, so `reserve()`
 * below does: lock via `inventoryService.reserveInstances` (which is itself atomic — the part
 * that actually contends), then insert the `deployment_reservations` row, and if that second
 * step throws, compensates by releasing the lock it just took. The reverse ordering (insert
 * first, lock second) would leave a reservation row with no real lock behind it, which is the
 * worse failure mode — a reservation that *looks* authoritative but isn't. `verifySnapshot`'s
 * §4.5 step 4 has the identical shape: `deployment_reservations`/`deployment_snapshots` consume
 * atomically against EACH OTHER (both this module's own tables, one real transaction), and the
 * `item_instances` seed-to-run write happens as a best-effort follow-up once that has already
 * committed — by that point the reservation is irreversibly `consumed`, so there is no
 * compensating action left if the follow-up fails; it is logged as a hard failure instead of
 * silently swallowed. This is a real, load-bearing limitation worth flagging in review; closing
 * it properly means either a shared pool/transaction across the two modules or moving both
 * tables under one store.
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../../core/errors.js';
import { ulid as defaultUlid } from '../../core/ids.js';
import { EQUIPPABLE_SLOTS } from '../inventory/index.js';

const clone = (v) => (v === null || v === undefined ? null : structuredClone(v));

/** Deterministic (sorted-key) JSON — what gets hashed and what gets HMAC'd (§4.1). */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function itemsHash(items) {
  return `sha256:${createHash('sha256').update(canonicalJson(items)).digest('hex')}`;
}

function signPayload(secret, payload) {
  return createHmac('sha256', secret).update(canonicalJson(payload)).digest('base64url');
}

function verifySignature(secret, payload, signature) {
  if (typeof signature !== 'string' || signature === '') return false;
  const expected = Buffer.from(signPayload(secret, payload));
  const actual = Buffer.from(signature, 'utf8');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

const slotRank = (slot) => {
  const i = EQUIPPABLE_SLOTS.indexOf(slot);
  return i === -1 ? EQUIPPABLE_SLOTS.length : i;
};

export function createDeploymentService({
  inventoryService, store, emit = null,
  clock = { now: () => Date.now() },
  signingSecret,
  reservationTtlMs = 90_000,   // §2.2
  snapshotTtlMs = 60_000,      // §4.3
}) {
  if (!inventoryService) throw new Error('createDeploymentService: inventoryService is required');
  if (!store) throw new Error('createDeploymentService: store is required');
  if (!signingSecret) throw new Error('createDeploymentService: signingSecret is required');

  const ulid = defaultUlid;
  const iso = (ms) => new Date(ms).toISOString();

  // ---------------------------------------------------------------------------------- events

  function baseEvent(type, { subject, actor, retentionClass, correlationId, payload }) {
    return { type, subject, actor, privacyClass: 'internal', retentionClass, correlationId, payload };
  }

  async function emitEvent(spec) {
    if (emit) await emit(spec);
  }

  // ---------------------------------------------------------------------- §2.1 ad hoc rules

  /**
   * §2.1's ad hoc `instanceIds` pre-check: rules 2 (equippable at all), 3 (no two instances
   * sharing a slot), 5 (`slot = null` can never deploy) — rule 1 (ownership/location/status)
   * is deliberately NOT re-checked here; it is re-checked by `reserveInstances`'s own atomic
   * `UPDATE ... WHERE`, same as the loadout path.  Runs BEFORE any lock is attempted, per §2.1:
   * "a rule 2/3/5 violation is a request-shape defect, not a locking race."
   */
  async function validateAdHocInstances(instanceIds) {
    const seenSlot = new Map();
    for (const instanceId of instanceIds) {
      const instance = await inventoryService.getInstance(instanceId);
      if (!instance) continue; // no definition to check a slot against; rule 1 catches it at lock time
      const definition = await inventoryService.getDefinition(instance.itemId);
      if (!definition || definition.slot == null) {
        throw new ApiError('LOADOUT_INVALID_SLOT',
          `Instance ${instanceId} has no equippable slot.`, { details: { instanceId } });
      }
      if (seenSlot.has(definition.slot)) {
        throw new ApiError('LOADOUT_DUPLICATE_INSTANCE',
          `Instances ${seenSlot.get(definition.slot)} and ${instanceId} both target slot ${definition.slot}.`,
          { details: { instanceId, slot: definition.slot, conflictsWith: seenSlot.get(definition.slot) } });
      }
      seenSlot.set(definition.slot, instanceId);
    }
  }

  // -------------------------------------------------------------------------- §7 POST /v1/deployments

  /**
   * §2.1 / §7. Exactly one of `loadoutId` or `instanceIds` (non-empty). Locks every candidate
   * instance atomically via `inventoryService.reserveInstances`, then records the reservation.
   */
  async function reserve({ accountId, loadoutId = null, instanceIds = null, roomId, correlationId = null }) {
    const hasLoadout = loadoutId != null;
    const hasInstances = instanceIds != null;
    if (hasLoadout === hasInstances || (hasInstances && instanceIds.length === 0)) {
      throw new ApiError('DEPLOYMENT_REQUEST_INVALID',
        'Exactly one of loadoutId or a non-empty instanceIds is required.',
        { details: { fields: ['loadoutId', 'instanceIds'] } });
    }

    let candidateIds;
    if (hasLoadout) {
      const loadout = await inventoryService.store.loadouts.byId(loadoutId);
      if (!loadout || loadout.accountId !== accountId) {
        throw new ApiError('NOT_FOUND', `Loadout ${loadoutId} not found.`);
      }
      // Fixed slot order (§4.1) for a deterministic, reproducible instance list — not load-
      // bearing for the lock itself, only for a stable read.
      candidateIds = EQUIPPABLE_SLOTS.map((slot) => loadout.slots?.[slot]).filter((v) => v != null);
      if (candidateIds.length === 0) {
        throw new ApiError('DEPLOYMENT_REQUEST_INVALID', `Loadout ${loadoutId} has no equipped slots.`,
          { details: { fields: ['loadoutId'] } });
      }
    } else {
      candidateIds = instanceIds;
      await validateAdHocInstances(candidateIds);
    }

    const reservationId = ulid();
    const expiresAt = iso(clock.now() + reservationTtlMs);

    try {
      await inventoryService.reserveInstances({ accountId, instanceIds: candidateIds, deploymentId: reservationId });
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'ITEM_ALREADY_DEPLOYED' || err.code === 'LOADOUT_ITEM_NOT_OWNED')) {
        // §3 — build the per-instance breakdown by re-reading (after the lock attempt's own
        // rollback) exactly the diagnostic §3 step 4 describes, rather than the coarse single
        // reason `reserveInstances` itself throws.
        const conflictingInstances = [];
        for (const instanceId of candidateIds) {
          const instance = await inventoryService.getInstance(instanceId);
          const eligible = instance && instance.ownerAccountId === accountId
            && instance.location === 'permanent' && instance.status === 'active' && !instance.locked;
          if (eligible) continue;
          const reason = instance?.locked ? 'ITEM_ALREADY_DEPLOYED' : 'LOADOUT_ITEM_NOT_OWNED';
          conflictingInstances.push({ instanceId, reason });
        }
        throw new ApiError('DEPLOYMENT_RESERVATION_CONFLICT',
          'One or more instances could not be locked.', { details: { conflictingInstances } });
      }
      throw err;
    }

    try {
      const reservation = await store.reservations.create({
        reservationId, accountId, loadoutId, roomId, instanceIds: candidateIds, expiresAt,
      });
      await emitEvent(baseEvent('deployment.reserved', {
        subject: { kind: 'account', id: accountId }, actor: { kind: 'player', id: accountId },
        retentionClass: 'standard', correlationId,
        payload: { reservationId, instanceIds: candidateIds, expiresAt },
      }));
      return { reservationId: reservation.reservationId, instanceIds: reservation.instanceIds, expiresAt: reservation.expiresAt };
    } catch (err) {
      // The lock succeeded but recording the reservation didn't — compensate rather than leave
      // instances locked with no reservation row to ever release them (§2.1: "no partial lock,
      // no reservation row, no event... exactly as if the losing request never ran").
      await inventoryService.releaseInstances({ deploymentId: reservationId }).catch(() => {});
      throw err;
    }
  }

  // ---------------------------------------------------------------------------------- release

  /** The one release write (§5.1/§5.2/§5.3a): flips the row, then unlocks its instances. */
  async function doRelease(reservationId, reason, { actor, correlationId = null } = {}) {
    const now = iso(clock.now());
    const released = await store.reservations.release(reservationId, reason, now);
    if (!released) return null; // already terminal — nothing to do, idempotent no-op
    await inventoryService.releaseInstances({ deploymentId: reservationId });
    await emitEvent(baseEvent('deployment.released', {
      subject: { kind: 'account', id: released.accountId }, actor,
      retentionClass: 'standard', correlationId,
      payload: { reservationId, releasedReason: reason },
    }));
    return released;
  }

  /** §7 `DELETE /v1/deployments/:reservationId` — client-initiated abort. Idempotent (§7). */
  async function releaseAbort({ accountId, reservationId, correlationId = null }) {
    const reservation = await store.reservations.byId(reservationId);
    if (!reservation || reservation.accountId !== accountId) {
      throw new ApiError('NOT_FOUND', `Reservation ${reservationId} not found.`);
    }
    if (reservation.status === 'consumed') {
      throw new ApiError('DEPLOYMENT_ALREADY_CONSUMED', 'This deployment already started a run.');
    }
    await doRelease(reservationId, 'abort', { actor: { kind: 'player', id: accountId }, correlationId });
    // Already-terminal (released/expired) falls through here too — same 204, no error: the
    // caller's desired end state ("this reservation no longer holds anything") already holds.
  }

  /** §7.1 `POST /v1/deployments/:reservationId/release` [S] — match-server timeout report. */
  async function releaseTimeout({ reservationId, reason = 'timeout', correlationId = null }) {
    if (reason !== 'timeout') {
      throw new ApiError('DEPLOYMENT_REQUEST_INVALID', "This endpoint only accepts reason='timeout'.",
        { details: { fields: ['reason'] } });
    }
    const reservation = await store.reservations.byId(reservationId);
    if (!reservation) throw new ApiError('NOT_FOUND', `Reservation ${reservationId} not found.`);
    if (reservation.status === 'consumed') {
      throw new ApiError('DEPLOYMENT_ALREADY_CONSUMED', 'Admission already succeeded on another attempt.');
    }
    await doRelease(reservationId, 'timeout', { actor: { kind: 'service', id: 'match-server', role: 'timeout' }, correlationId });
  }

  /** §5.3 — the expiry-sweep backstop. Call on an interval; every caller gets the same result. */
  async function sweepExpired() {
    const now = iso(clock.now());
    const swept = await store.reservations.sweepExpired(now);
    for (const reservation of swept) {
      await inventoryService.releaseInstances({ deploymentId: reservation.reservationId });
      await emitEvent(baseEvent('deployment.released', {
        subject: { kind: 'account', id: reservation.accountId },
        actor: { kind: 'service', id: 'deployment-sweep', role: 'expiry' },
        retentionClass: 'standard', correlationId: null,
        payload: { reservationId: reservation.reservationId, releasedReason: 'expiry' },
      }));
    }
    return swept;
  }

  // ------------------------------------------------------------------------------- snapshot

  /**
   * Internal — issued once match allocation binds a `matchId` (§4.3), never client-callable.
   * Builds the signed snapshot (§4.1) and its `deployment_snapshots` replay row (§4.4).
   */
  async function issueSnapshot({ reservationId, matchId, correlationId = null }) {
    const now = clock.now();
    const reservation = await store.reservations.byId(reservationId);
    if (!reservation || reservation.status !== 'reserved') {
      throw new ApiError('DEPLOYMENT_RESERVATION_EXPIRED', 'Reservation is no longer active.');
    }

    await store.reservations.bindMatch(reservationId, matchId, iso(now));

    const items = [];
    for (const instanceId of reservation.instanceIds) {
      const instance = await inventoryService.getInstance(instanceId);
      if (!instance) continue; // shouldn't happen — every locked id is a real row
      const definition = await inventoryService.getDefinition(instance.itemId);
      items.push({
        instanceId, itemId: instance.itemId, slot: definition?.slot ?? null,
        quantity: instance.quantity, durability: instance.durability ?? null,
        attachments: clone(instance.attachments ?? []),
      });
    }
    items.sort((a, b) => slotRank(a.slot) - slotRank(b.slot));

    const payload = {
      reservationId, accountId: reservation.accountId, matchId, roomId: reservation.roomId,
      issuedAt: iso(now), expiresAt: iso(now + snapshotTtlMs),
      items, itemsHash: itemsHash(items),
    };
    const signature = signPayload(signingSecret, payload);

    const snapshot = await store.snapshots.create({
      reservationId, matchId, issuedAt: payload.issuedAt, expiresAt: payload.expiresAt,
    });

    await emitEvent(baseEvent('deployment.snapshot.issued', {
      subject: { kind: 'match', id: matchId }, actor: { kind: 'service', id: 'deployment', role: 'issue' },
      retentionClass: 'standard', correlationId,
      payload: { snapshotId: snapshot.snapshotId, reservationId, matchId, expiresAt: payload.expiresAt },
    }));

    return { snapshotId: snapshot.snapshotId, payload, signature };
  }

  /**
   * §4.5 steps 3–4 / §7.1's `verify-snapshot` [S]. All four checks, then the atomic double
   * consume (snapshot + reservation, this module's own transaction), then the best-effort
   * `item_instances` seed described in this file's header comment.
   */
  async function verifySnapshot({ matchId, accountId, snapshot, correlationId = null }) {
    const { payload, signature } = snapshot ?? {};
    const reject = async (reason) => {
      await emitEvent(baseEvent('deployment.snapshot.rejected', {
        subject: { kind: 'match', id: matchId }, actor: { kind: 'service', id: 'deployment', role: 'verify' },
        retentionClass: 'audit', correlationId, payload: { reason },
      }));
      throw new ApiError('DEPLOYMENT_SNAPSHOT_INVALID', 'Deployment snapshot failed verification.');
    };

    if (!payload || !verifySignature(signingSecret, payload, signature)) return reject('bad-signature');
    if (payload.matchId !== matchId) return reject('match-mismatch');
    if (payload.accountId !== accountId) return reject('account-mismatch');
    if (Date.parse(payload.expiresAt) <= clock.now()) return reject('expired');

    const now = iso(clock.now());
    const outcome = await store.tx(async (t) => {
      const consumedSnapshot = await store.snapshots.consumeForReservation(payload.reservationId, now, t);
      if (!consumedSnapshot) return { rejected: 'already-consumed' };

      const consumedReservation = await store.reservations.consume(payload.reservationId, now, t);
      if (!consumedReservation) {
        // §4.5 step 4's own note: roll the snapshot's consume back, it is NOT spent.
        await store.snapshots.unconsume(consumedSnapshot.snapshotId, t);
        return { expired: true, snapshotId: consumedSnapshot.snapshotId };
      }
      return { snapshotId: consumedSnapshot.snapshotId, reservation: consumedReservation };
    });

    if (outcome.rejected) return reject(outcome.rejected);
    if (outcome.expired) {
      throw new ApiError('DEPLOYMENT_RESERVATION_EXPIRED',
        'The snapshot verified, but its reservation is no longer active.');
    }

    // Best-effort follow-up — see this file's header comment on why this step is not inside
    // the transaction above and what that means on failure.
    await inventoryService.moveLockedToRun({ deploymentId: payload.reservationId, matchId });

    await emitEvent(baseEvent('deployment.snapshot.consumed', {
      subject: { kind: 'match', id: matchId }, actor: { kind: 'service', id: 'deployment', role: 'verify' },
      retentionClass: 'audit', correlationId, payload: { snapshotId: outcome.snapshotId, accountId },
    }));

    return { snapshotId: outcome.snapshotId, reservationId: payload.reservationId, consumedAt: now };
  }

  return {
    store,
    reserve, releaseAbort, releaseTimeout, sweepExpired,
    issueSnapshot, verifySnapshot,
  };
}

export { createMemoryDeploymentStore, createPostgresDeploymentStore } from './store.js';
export { registerDeploymentRoutes } from './routes.js';
