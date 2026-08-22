/**
 * Inventory and loadout routes.  contracts/items-inventory.md §7, http-api.md §1/§8/§10.
 *
 * Handlers translate a request into a service call and a service result into the documented
 * body — the rules live in `index.js` (the P3-01 service), same split as the profile module.
 * Auth middleware is supplied by the server wiring so the module stays testable without an
 * auth module present.
 */
import { ApiError } from '../../core/errors.js';
import { requireIdempotencyKey, withIdempotency } from '../../shared/idempotentRoute.js';

/** Handlers must never read an account id from the body — that is an impersonation surface. */
function actorId(ctx) {
  const id = ctx.actor?.accountId;
  if (!id) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
  return id;
}

/** §7's response shape for a loadout — accountId stays server-side, timestamps are not stated. */
const loadoutBody = (row) => ({
  loadoutId: row.loadoutId, name: row.name, slots: row.slots, isDefault: row.isDefault,
});

/**
 * The wire projection of a definition/instance pair. CLOSED shapes, agreed with the shell
 * stream (src/ui/platform/shell-api.js validates every key): server-side columns —
 * `ownerAccountId` (the caller's own id), `attachments`, `containerId`, `baseStats`,
 * `tradable`, `contentVersion`, timestamps — do not travel. `definition` is inlined on every
 * instance, not only the single-item endpoint: a list of bare rows cannot render a name, slot
 * or rarity at all (a cross-stream agreement recorded in shell-api.js, honoured here).
 */
const definitionBody = (def) => ({
  itemId: def.itemId,
  class: def.class,
  slot: def.slot ?? null,
  rarityTier: def.rarityTier,
  stackable: !!def.stackable,
  maxStack: def.stackable ? (def.maxStack ?? null) : null,
  durabilityMax: def.durabilityMax ?? null,
});

const instanceBody = (row, def) => ({
  instanceId: row.instanceId,
  itemId: row.itemId,
  quantity: row.quantity,
  durability: row.durability ?? null,
  location: row.location,
  runId: row.runId ?? null,
  locked: !!row.locked,
  lockedByDeploymentId: row.lockedByDeploymentId ?? null,
  status: row.status,
  definition: definitionBody(def),
});

/**
 * §10: `?limit=` (default 25, max 100) and an opaque `?cursor=`. Invalid values are REJECTED,
 * not corrected — clamping teaches a client its request was fine (see profile's getMatches).
 */
function pageParams(ctx) {
  const rawLimit = ctx.query.get('limit');
  let limit = 25;
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit)) {
      throw new ApiError('VALIDATION_FAILED', 'limit must be an integer.', {
        details: { fields: [{ key: 'limit', reason: 'format' }] },
      });
    }
    limit = Number(rawLimit);
    if (limit < 1 || limit > 100) {
      throw new ApiError('VALIDATION_FAILED', 'limit is 1–100.', {
        details: { fields: [{ key: 'limit', reason: 'range' }] },
      });
    }
  }
  // `?cursor=` with no value is a UI that always appends the parameter, not a malformed cursor.
  const cursor = ctx.query.get('cursor') || null;
  return { limit, cursor };
}

function validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 100) {
    throw new ApiError('VALIDATION_FAILED', 'A loadout needs a name (1–100 characters).', {
      details: { fields: [{ key: 'name', reason: !name ? 'required' : 'too-long' }] },
    });
  }
  return name.trim();
}

function validateSlotsShape(slots) {
  if (slots === undefined) return {};
  if (slots === null || typeof slots !== 'object' || Array.isArray(slots)) {
    throw new ApiError('VALIDATION_FAILED', 'slots must be an object of slot -> instanceId.', {
      details: { fields: [{ key: 'slots', reason: 'object' }] },
    });
  }
  return slots;
}

export function registerInventoryRoutes(router, { service, coreStore, auth }) {
  const mw = auth ? { middleware: [auth] } : {};

  const handlers = {
    /** §7 `GET /v1/inventory` — the caller's permanent instances, cursor-paginated. */
    async listInventory(ctx) {
      const { limit, cursor } = pageParams(ctx);
      // Sorted by instanceId (a ULID, so creation-ordered) and cursored on it: cursor
      // pagination per §10, never offset — an instance settled mid-scroll must not shift rows.
      const all = (await service.listPermanentInventory(actorId(ctx)))
        .sort((a, b) => a.instanceId.localeCompare(b.instanceId));
      const start = cursor ? all.findIndex((r) => r.instanceId > cursor) : 0;
      // A cursor past the end is a fully-consumed listing, not an error.
      const page = start === -1 ? [] : all.slice(start, start + limit);
      const nextCursor = start !== -1 && start + limit < all.length
        ? page[page.length - 1].instanceId : null;
      // One definition read per distinct itemId in the page, not per row.
      const defs = new Map();
      for (const row of page) {
        // eslint-disable-next-line no-await-in-loop -- one read per distinct definition, ordered
        if (!defs.has(row.itemId)) defs.set(row.itemId, await service.getDefinition(row.itemId));
      }
      return { items: page.map((row) => instanceBody(row, defs.get(row.itemId))), nextCursor };
    },

    /** §7 `GET /v1/inventory/:instanceId` — one instance with its definition row inlined. */
    async getInstance(ctx) {
      const accountId = actorId(ctx);
      const instance = await service.getInstance(ctx.params.instanceId);
      // Not-yours and not-there collapse to one answer, so a probe cannot enumerate other
      // players' instance ids — same reasoning as deployment.md §7's ownership 404.
      if (!instance || instance.ownerAccountId !== accountId) {
        throw new ApiError('NOT_FOUND', 'No such instance.');
      }
      return instanceBody(instance, await service.getDefinition(instance.itemId));
    },

    /** §7 `GET /v1/loadouts`. */
    async listLoadouts(ctx) {
      const rows = await service.listLoadouts(actorId(ctx));
      return { loadouts: rows.map(loadoutBody) };
    },

    /** §7 `POST /v1/loadouts` — Idempotency-Key required (§8). */
    async createLoadout(ctx) {
      const accountId = actorId(ctx);
      const key = requireIdempotencyKey(ctx);
      const name = validateName(ctx.body?.name);
      const slots = validateSlotsShape(ctx.body?.slots);
      return withIdempotency(coreStore, {
        key, actorId: accountId,
        request: { op: 'loadout-create', name, slots },
        clock: { now: () => ctx.deps.clock() },
      }, async () => loadoutBody(await service.createLoadout(accountId, { name, slots })));
    },

    /** §7 `PATCH /v1/loadouts/:loadoutId` — Idempotency-Key required (§8). */
    async updateLoadout(ctx) {
      const accountId = actorId(ctx);
      const key = requireIdempotencyKey(ctx);
      const loadoutId = ctx.params.loadoutId;
      const allowed = new Set(['name', 'slots', 'isDefault']);
      const unknown = Object.keys(ctx.body ?? {}).filter((k) => !allowed.has(k));
      if (unknown.length) {
        throw new ApiError('VALIDATION_FAILED', 'Unknown loadout fields.', {
          details: { fields: unknown.map((k) => ({ key: k, reason: 'unknown-field' })) },
        });
      }
      const patch = {};
      if ('name' in ctx.body) patch.name = validateName(ctx.body.name);
      if ('slots' in ctx.body) patch.slots = validateSlotsShape(ctx.body.slots);
      if ('isDefault' in ctx.body) {
        if (typeof ctx.body.isDefault !== 'boolean') {
          throw new ApiError('VALIDATION_FAILED', 'isDefault must be a boolean.', {
            details: { fields: [{ key: 'isDefault', reason: 'boolean' }] },
          });
        }
        patch.isDefault = ctx.body.isDefault;
      }
      if (Object.keys(patch).length === 0) {
        throw new ApiError('VALIDATION_FAILED', 'Nothing to change.', {
          details: { fields: [{ key: 'name', reason: 'required' }] },
        });
      }
      return withIdempotency(coreStore, {
        key, actorId: accountId,
        request: { op: 'loadout-update', loadoutId, patch },
        clock: { now: () => ctx.deps.clock() },
      }, async () => loadoutBody(await service.updateLoadout(accountId, loadoutId, patch)));
    },

    /** §7 `DELETE /v1/loadouts/:loadoutId` — hard delete; loadouts are not auditable state. */
    async deleteLoadout(ctx) {
      await service.deleteLoadout(actorId(ctx), ctx.params.loadoutId);
      // 204: undefined is how core/http.js writes one.
      return undefined;
    },

    /** §7 `POST /v1/loadouts/:loadoutId/set-default` — clears any other default. */
    async setDefault(ctx) {
      return loadoutBody(await service.setDefaultLoadout(actorId(ctx), ctx.params.loadoutId));
    },
  };

  router.get('/v1/inventory', handlers.listInventory, mw);
  router.get('/v1/inventory/:instanceId', handlers.getInstance, mw);
  router.get('/v1/loadouts', handlers.listLoadouts, mw);
  router.post('/v1/loadouts', handlers.createLoadout, mw);
  router.patch('/v1/loadouts/:loadoutId', handlers.updateLoadout, mw);
  router.delete('/v1/loadouts/:loadoutId', handlers.deleteLoadout, mw);
  router.post('/v1/loadouts/:loadoutId/set-default', handlers.setDefault, mw);
  return router;
}
