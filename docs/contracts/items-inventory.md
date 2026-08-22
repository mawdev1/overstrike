# Contract 15 — Items and inventory

| | |
|---|---|
| **Status** | `FROZEN` |
| **Version** | 1.0.0 |
| **Owner** | [CC] Claude Code |
| **Scope** | P3–P4. Marketplace, chain provenance, and creator ownership are `P7-01`'s contract |
| **Consumers** | Platform, match server (deployment/settlement), [CX] loadout and raid HUD, Admin Portal |

---

## 1. Why this precedes P3-02

`P3-02`'s deployment reservation and `P3-03`'s run/permanent split both need one settled
answer to "what is an item, what is an instance of one, who owns it right now, and what stops
it being used twice" before either can be written. Deciding that per-caller produces the
canonical P3 failure mode this contract exists to prevent: a definitions table with no
instance table, an instance with two owners for one tick, or a run item mutated after the
match that created it already committed a result against it.

This is `P3-01`'s contract. Its definition of done, verbatim from the Build Plan, is the
acceptance bar for §7: **"Constraints prevent double-equip, concurrent deployment, duplicated
items, and mutation of locked run items."**

## 2. Definitions vs instances — the split everything else depends on

**A definition is the catalog entry.** One row per item *type* — `rifle_ak74`, not any
particular AK-74. Definitions are authored data (`P3-11`), not created by gameplay, and never
reference an owner.

**An instance is a specific item that exists somewhere.** Two players holding the "same" rifle
hold two different instances of the same definition. Instances are what gets owned, equipped,
locked, looted, and lost.

**Not every definition needs unique instances.** A stackable definition (ammo, consumables)
tracks a quantity against an owner; a unique/serialized definition (weapons, gear with
individual state) always has one row per physical item, even at quantity 1, because it may
later carry attachments or a durability value (`P4-04`) that two "identical" copies must be
able to disagree on.

```
item_definitions(
  item_id           text primary key,        -- e.g. 'rifle_ak74'
  class             text not null,            -- weapon|gear|consumable|material|cosmetic
  slot              text,                     -- primary|secondary|melee|helmet|vest|backpack|
                                               -- rig|consumable|null (unequippable class)
  rarity_tier       text not null,            -- common|uncommon|rare|epic|legendary
  stackable         boolean not null,          -- true => quantity-tracked, false => serialized
  max_stack         int,                       -- null when not stackable
  base_stats        jsonb not null default '{}',  -- damage, capacity, weight, etc. — authored,
                                                    -- read-only at runtime (P3-11 data, not P4 upgrades)
  durability_max    int,                       -- null = item has no durability model (most of P3).
                                                -- P4-04 placeholder: column exists now so the
                                                -- P4 repair/upgrade loop is additive, not a migration
                                                -- that retrofits every existing instance row
  tradable          boolean not null default false,   -- gates P7-03; false for all P3/P4 data
  content_version   int not null default 1,    -- bumps when base_stats/slot/class changes meaning
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  check (class in ('weapon','gear','consumable','material','cosmetic')),
  check (slot is null or slot in ('primary','secondary','melee','helmet','vest','backpack',
                                   'rig','consumable')),
  check (rarity_tier in ('common','uncommon','rare','epic','legendary'))
)

item_instances(
  instance_id       text primary key,          -- ULID
  item_id           text not null references item_definitions,
  owner_account_id  text references accounts,  -- null only while status='in_transit' (§5)
  quantity          int not null default 1,    -- 1 for non-stackable; >=1 for stackable rows
  durability        int,                        -- null unless item_definitions.durability_max
                                                 -- is set; P4-04 placeholder, unused meaning in P3
  attachments       jsonb not null default '[]',  -- P4+; empty in P3/P4-04 scope
  location          text not null,              -- 'permanent'|'run'|'world'|'container'
  run_id            text references matches,    -- non-null iff location='run' (§5 CHECK)
  container_id      text references world_loot_containers,  -- P3-03's table; non-null iff
                                               -- location in ('world','container') (§5 CHECK).
                                               -- 'container' = sealed, not individually visible;
                                               -- 'world' = loose and interactable (extraction-match.md §3.1)
  locked            boolean not null default false,  -- true iff reserved into an active deployment (§6)
  locked_by_deployment_id text references deployment_reservations,  -- P3-02's table; null unless locked
  status            text not null default 'active',  -- active|consumed|destroyed|lost|merged —
                                               -- "deployed" is not a status; a locked instance
                                               -- stays status='active' with locked=true (§5, §6.2)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  check (quantity >= 1),
  check ((item_instances.locked) = (locked_by_deployment_id is not null)),
  check (location in ('permanent','run','world','container')),
  check (location = 'run' or run_id is null),
  check (location <> 'run' or run_id is not null),
  check (location in ('world','container') or container_id is null),
  check (location not in ('world','container') or container_id is not null),
  check (status in ('active','consumed','destroyed','lost','merged'))
)
create index on item_instances(owner_account_id, location) where status = 'active';
create index on item_instances(run_id) where location = 'run';

-- Stackable rows collapse: at most one active, unlocked instance row per
-- (owner_account_id, item_id, location, run_id, container_id) for stackable definitions.
-- Enforced by a partial unique index, not application discipline, because two concurrent
-- pickups of the same consumable must not race into two rows that both look correct.
--
-- container_id is part of the key, not an omission: §2's own CHECKs force run_id to NULL for
-- every location other than 'run', so a key of (owner, item_id, location, run_id) alone
-- collapses to (NULL, item_id, 'container', '') for every sealed container in every concurrent
-- raid in the game — the bulk container-roll INSERT in extraction-match.md §3.1 would violate
-- its own uniqueness the first time two ammo-bearing containers existed anywhere at once.
-- container_id restores the missing scope: it is non-null for exactly 'world' and 'container'
-- rows (§2's CHECK above), so each sealed container and each world spawn-group collapses
-- independently, the way each run already collapses independently on run_id, and each owner's
-- permanent stack already collapses independently on owner_account_id.
create unique index item_instances_stackable_collapse
  on item_instances(owner_account_id, item_id, location, coalesce(run_id, ''), coalesce(container_id, ''))
  where status = 'active' and locked = false;
```

**Why `class`, `slot`, `rarity_tier`, and `status` are CHECK-enforced, not just SQL-commented
enums.** `location` (below) and every status column in this document are enforced by a CHECK,
not a comment, because authored data (`P3-11`) is exactly the place a typo reaches runtime
silently otherwise — and `class`/`slot` are especially exposed to it: `class = 'consumable'`
(the broad item category) and `slot = 'consumable'` (the single equippable quick-item key) are
the same word meaning two different things in the same row, which is precisely the kind of
authored-data mistake a CHECK catches at insert time and a comment does not. `item_instances.
status` gets the same treatment for the same reason, not a weaker one: it is not authored data,
but every invariant in §9 and the lock/unlock mechanism in §6.4 is built directly on it being
exactly one of a closed set of values, and a runtime writer typo there (`'consumeed'`,
`'lost '`) is exactly as silent without a CHECK as an authored typo would be. The enum is also
deliberately narrower than an earlier draft: it does **not** include `deployed` — §5's state
machine and §6.2's lock never write that value anywhere; a locked instance stays
`status='active'` with `locked=true` for the duration of the lock (§6.2, §6.4), so "deployed" as
a status would be a dead enum member with no writer, which is worse than not enumerating it —
it invites an implementer to wire a write path for a state that must never exist.

**Why `owner_account_id` is nullable.** A world-spawned or container item (`P3-03`) has no
owner until picked up; `location = 'world'` or `'container'` is exactly that state, and §5's
state machine is what keeps a null owner from meaning "orphaned" instead of "not yet claimed."

**Why `container_id` points at `extraction-match.md`'s (`P3-03`) table rather than staying an
unaddressed `location='container'` row.** The same forward reference this contract already
makes to `deployment_reservations` below: `location` alone can say an instance is sitting in
*some* container, never *which one*, and "which one" is exactly what a container-open or a
pickup needs to resolve. This contract reserves the column and its CHECK; `extraction-match.md`
owns `world_loot_containers` itself and every write into `container_id`.

**Why `locked_by_deployment_id` points at `P3-02`'s table rather than a boolean plus a
comment.** A lock with no referent is unauditable — nothing can answer "locked by what" without
grepping logs. The FK is what makes §7's "mutation of a locked run item" constraint
mechanically checkable rather than a code-review convention.

## 3. Loadouts

A loadout is a named, saved slot configuration a player prepares before deployment
(`P3-08` UI). It references instances, not definitions — equipping is binding a specific item,
not a type.

```sql
loadouts(
  loadout_id        text primary key,          -- ULID
  account_id        text not null references accounts,
  name              text not null,
  slots             jsonb not null,             -- {"primary": instance_id, "secondary": ..., ...}
  is_default        boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
)
create unique index loadouts_one_default on loadouts(account_id) where is_default;
```

`slots` is `jsonb` rather than a fixed-column table for the same reason `match_participants.stats`
is (`db-schema.md` §4): the slot set is small and stable *in P3* but is exactly the kind of
thing a future gear tier adds a slot to, and a wide sparse column table would need a migration
for every one.

### 3.1 Validation rules (checked on save and again on deployment reservation, `P3-02`)

1. **Ownership.** Every `instance_id` in `slots` must have `owner_account_id = account_id`,
   `location = 'permanent'`, `status = 'active'`, `locked = false`.
2. **Slot match.** The instance's `item_definitions.slot` must equal the key it is placed
   under. A helmet cannot occupy `primary`.
3. **One instance, one slot.** An `instance_id` appears at most once across all of one
   loadout's `slots` — a single physical rifle cannot fill both `primary` and `secondary`
   simultaneously (§6's double-equip case, saved-loadout form).
4. **No duplicate save-time double-equip across a player's own loadouts.** Saving loadout B
   with an instance already locked into loadout A's active deployment fails validation at
   deployment time (§6.2), not at save time — two *saved* loadouts may both reference the same
   idle instance; only one may ever be the one that deploys with it locked.
5. A definition with `slot = null` (ammo, materials, and any bulk consumable authored without
   a `slot`) can never appear in `slots`; it belongs in run inventory (`P3-03`), not a loadout.
   This is distinct from a definition with `slot = 'consumable'` (a single quick-item key,
   e.g. a med-kit bound to the loadout's `consumable` slot in §7's example) — that one *is*
   equippable, by the same rules 1–4 as any other slot.

**How a `slot = null` definition ever reaches a raid, given rule 5.** It doesn't, at
deployment. Nothing in `loadouts.slots` can reference one (rule 5), and `deployment.md`
§4.1's signed snapshot carries "one entry per locked instance" — locked instances are
exactly a loadout's slots (§6.2) — so the opening run inventory (§4 below) never contains a
`slot = null` item. This is intentional for the P3 scope this contract and `P3-02`/`P3-03`
cover: a player deploys with only their equipped gear (one instance per named slot, including
the single `consumable`-slot quick-item) and finds every stackable — ammo, materials, bulk
consumables — as world/container loot (`P3-03`) once the raid is live. A "bring your own
ammo/stock" pre-raid stash is out of scope for this contract; it would need a second seeding
path alongside the loadout (a stash selection step in the deployment flow, `deployment.md`'s
to define) and is left for a later phase to decide, not implied by anything written here.

Validation failure returns `LOADOUT_INVALID_SLOT`, `LOADOUT_ITEM_NOT_OWNED`, or
`LOADOUT_DUPLICATE_INSTANCE` (§8) — never a silent partial save, per `http-api.md` §1's "no
endpoint returns a partial success."

## 4. Permanent inventory vs run inventory

**Permanent inventory** (`location = 'permanent'`) is every instance a player owns between
raids. It is the only location a loadout may reference (§3.1 rule 1) and the only location
that survives indefinitely.

**Run inventory** (`location = 'run'`, `run_id` set) exists only for the lifetime of one
deployment. It is seeded from the locked loadout at deployment (`P3-02`) — equipped gear
only, per §3.1 rule 5 — and is otherwise empty at raid start; every stackable (ammo,
materials, bulk consumables) is where in-raid pickups (`P3-03` world loot, containers) land
while the raid is live. It has exactly two exits, both server-decided, never client-declared:

- **Extract** (`P3-03`/`P3-04`): every surviving `location = 'run'` instance for that
  `run_id` transitions to `location = 'permanent'`, `run_id = null`. This is the "converted to
  permanent on extract" half of `P3-03/04`'s definition of done.
- **Death or abort** (`P3-03`/`P3-04`): every surviving `location = 'run'` instance for that
  `run_id` transitions to `status = 'lost'`. Lost rows are retained, not deleted — `db-schema.md`
  §1's "no destructive deletes on anything auditable" applies to inventory the same as to
  match rows, and a lost item is the input a dispute or an anti-cheat review needs.

A run instance is never directly equippable back into a loadout while `location = 'run'` —
§3.1 rule 1 already excludes it — which is what makes "exists only for one deployment" true
mechanically instead of by convention: there is no code path that reads a run row as loadout
material.

## 5. Instance state machine

```
        (loot spawn / P3-11 data,          (crafted / awarded / purchased —
         P3-03 world/container)             P4/P7, out of P3 scope)
                 │                                      │
                 ▼                                      ▼
             location='world'                    location='permanent'
             owner=null, status='active'          owner=X, status='active'
                 │  pickup (P3-03)                       │
                 ▼                                       │
             location='run', run_id=R                    │
             owner=X, status='active'                     │
                 │                                        │
    ┌────────────┼─────────────────────┐                  │
    ▼            ▼                     ▼                  │
 drop/loot    consumed/destroyed    extract (P3-04)        │
 by another   (used up / broken     ─────────────────►  location='permanent'
 player       in-raid)              status='active'      run_id=null, status='active'
    │            │                                            ▲
    ▼            ▼                                            │
 status=       status=                                        │
 'active'      'consumed'/                          equip into loadout (§3, §6)
 (new owner,   'destroyed'                                    │
  same run)    (terminal)                                     ▼
                                                        locked=true,
    death/abort of run R (P3-04)                       locked_by_deployment_id=D
    (any status='active' row still in run R)                  │
                 │                                    deployment resolves
                 ▼                                    (extract/death/abort, P3-02/03/04)
            status='lost' (terminal)                          │
                                                                ▼
                                                        locked=false,
                                                        locked_by_deployment_id=null
```

**Status is append-mostly, not append-only.** `active` is the only non-terminal status and the
only one that can transition further — including locked-and-back (`locked` flips true then
false while `status` stays `'active'` the whole time, §6.2/§6.4), and `run`-and-back via
extract — or to a terminal status. `consumed`, `destroyed`, `merged`, and `lost` are terminal —
no writer ever transitions out of them, enforced the same way `matches.status` terminality is
enforced in `db-schema.md` §4: a CHECK plus one shared application function
(`platform/store/items.js`, mirroring `core/store.js`'s pattern), never an ad hoc `UPDATE`.

`merged` exists for stackable collapse: when a pickup would create a second active row that
§2's partial unique index forbids, the mover's quantity folds into the existing row and the
mover's own row transitions to `merged` — a terminal status with an audit trail, rather than a
delete that leaves no trace of where the quantity went.

## 6. Item locks (`P3-01`'s definition of done, mapped to mechanism)

`locked` and `locked_by_deployment_id` (§2) are the single mechanism behind all four
constraints the Build Plan names. Each is enforced by exactly one of: a CHECK constraint, a
unique index, or an atomic conditional UPDATE — never application-layer discipline alone,
following `db-schema.md` §1 rule 6.

### 6.1 Double-equip

An instance can occupy at most one loadout slot at a time by construction (§3.1 rule 3 is a
save-time check on `loadouts.slots`); it can be *locked into an active deployment* at most
once because locking is a single-row conditional update (§6.2) gated on `locked = false`.
Two loadouts may both reference an idle instance (§3.1 rule 4) — that is not double-equip,
because only a lock, not a save, commits an instance to a deployment.

### 6.2 Concurrent deployment of the same item

`P3-02`'s reservation locks every instance a deployment needs in one transaction:

```sql
UPDATE item_instances
SET locked = true, locked_by_deployment_id = $deployment_id, updated_at = now()
WHERE instance_id = ANY($instance_ids)
  AND owner_account_id = $account_id
  AND location = 'permanent'
  AND status = 'active'
  AND locked = false;
-- Reservation succeeds iff rowcount = length($instance_ids). A short count means at least
-- one instance was already locked by a concurrent deployment attempt (or is no longer
-- eligible) — the whole reservation rolls back. Partial locks are not a valid state; there is
-- no code path that reads a deployment as reserved without every one of its instances locked.
```

This is the mechanism, not merely the intent: two concurrent deployment attempts racing on
the same instance both issue this UPDATE, at most one can flip `locked = false → true` per
row, and the loser's rowcount mismatch is what makes "cannot deploy the same item into two
matches" a database guarantee rather than a race the application hopes it wins.

### 6.3 Duplication

No code path creates an `item_instances` row from an existing one except §5's `merged`
collapse, which is a quantity fold into a pre-existing row, not a copy — the mover's row still
terminates. Every other creation path (loot spawn, purchase, craft, admin grant) originates
from outside the instance table (world/container generation, `P4`/`P7` economy, Admin
Portal), never from reading another instance. `events_outbox` (`db-schema.md` §5) carries one
`item.created` event per creation, in the same transaction as the INSERT.

**`item.created`'s wire shape, specified here because it isn't specified anywhere else yet.**
`event-envelope.md` §6's P1–P4 catalogue table does not list `item.created` — the name appears
only in that section's prose note ("later phases extend this: economy (`item.created`, …)"),
with none of the four columns (`actor`/`subject`/`privacyClass`/`retentionClass`) every
catalogued event has. `event-envelope.md` is `FROZEN`, so this contract cannot add a table row
to it; instead, this is the authoritative shape until an `event-envelope.md` CCR adds the
catalogue row, and this contract's writer is bound by it now, in P3:

| Field | Value |
|---|---|
| `type` | `item.created` |
| `actor` | `{ "kind": "service", "id": "<subsystem>", "role": "loot-spawn\|economy\|craft" }` for a system-originated creation (world/container roll, `P3-03`; `P4`/`P7` economy); `{ "kind": "admin", "id": "<admin_account_id>", "role": "grant" }` for an Admin Portal grant. Never `player` — no player-initiated call creates an instance directly; a purchase or craft is the *service* completing a player's request, and the player's action is what `correlationId` carries |
| `subject` | `{ "kind": "item", "id": "<instance_id>" }` |
| `privacyClass` | `internal` — an item instance is not personal data on its own; ownership already lives in `owner_account_id` outside the envelope |
| `retentionClass` | `audit` — the same bar `db-schema.md` §5 sets for any row a dispute or anti-cheat review needs to reconstruct, matching §4's "lost rows are retained, not deleted" treatment of the instances this event describes |

This is a real cross-contract dependency, not a settled reservation: the next `event-envelope.
md` revision should promote this row into its §6 table verbatim so the two documents agree by
construction rather than by cross-reference. Until then, a duplicate-looking pair of rows with
two different `eventId`s and two different `correlationId`s is two legitimate creations; a
duplicate-looking pair sharing one `correlationId` is the defect this is designed to make
visible in the event stream, not just preventable at write time.

### 6.4 Mutation of a locked run item

Any write to `item_instances` that changes `item_id`, `quantity`, `attachments`,
`durability`, or `status` on a row where `locked = true` is rejected — the shared write
function checks `locked` before applying any mutation other than the lock/unlock transition
itself, and returns `ITEM_LOCKED` (§8) rather than silently no-op'ing. `location` and `run_id`
*do* change under lock — a locked instance is exactly the one that moves from `permanent` to
`run` at deployment start (`P3-02`) and, on extract, back — but that transition is driven by
the deployment lifecycle itself (§6.2's writer), never by an arbitrary caller, and it is the
same transaction that eventually clears the lock. A locked instance's identity and contents
cannot drift out from under a deployment that has already computed a snapshot against them —
which is exactly what `P3-02`'s signed inventory snapshot needs to stay true after it is
signed.

## 7. API surface

Base path `/v1`, conventions per `http-api.md` §1 (correlation ID, idempotency, error
envelope, no partial success). All endpoints require `Authorization: Bearer` unless noted.

| Method & path | Purpose |
|---|---|
| `GET /v1/inventory` | List the caller's `location='permanent'` instances, paginated (`http-api.md` §10) |
| `GET /v1/inventory/:instanceId` | One instance, with its `item_definitions` row inlined |
| `GET /v1/loadouts` | List the caller's loadouts |
| `POST /v1/loadouts` | Create a loadout. `Idempotency-Key` required (`http-api.md` §8) |
| `PATCH /v1/loadouts/:loadoutId` | Update slots/name/default. `Idempotency-Key` required |
| `DELETE /v1/loadouts/:loadoutId` | Delete (hard — loadouts are not auditable state, unlike instances) |
| `POST /v1/loadouts/:loadoutId/set-default` | Mark default; clears any other default for the account |

**Deleting a loadout a reservation still points at — an open cross-contract gap, not a settled
guarantee.** `deployment.md` §2 declares `deployment_reservations.loadout_id text references
loadouts`, and as that contract is currently written this FK carries **no `ON DELETE` clause**,
which defaults to `RESTRICT`/`NO ACTION` in Postgres. As both documents stand today, `DELETE
/v1/loadouts/:loadoutId` on a loadout that any reservation — active *or* historical — has ever
pointed at fails with an FK violation. This section previously asserted the opposite (that the
delete "never fails") by unilaterally describing `deployment.md`'s FK as `ON DELETE SET NULL`
without that change actually being reflected in the contract that owns the table; that was an
assertion made in the wrong document and is corrected here.

The intended shape is still the same, and the reasoning for it still holds:
`deployment_reservations.loadout_id` is a read convenience — "which loadout this reservation
was built from" — not the lock's authority. §6.2's atomic lock lives entirely on
`item_instances.locked`/`locked_by_deployment_id`, and `deployment.md` §2 already says as much
of `instance_ids` ("if the two ever disagree, `item_instances.locked_by_deployment_id` is
authoritative"). Deleting the source loadout cannot un-equip or unlock anything it already
locked, so there is no correctness reason for the delete to fail. But making it not fail
requires `deployment.md` §2 to actually declare `ON DELETE SET NULL` on that FK — a change this
contract cannot make unilaterally in someone else's schema. Until `deployment.md` lands that
change:

- `DELETE /v1/loadouts/:loadoutId` on a loadout with no reservation history behaves exactly as
  documented — an unconditional hard delete.
- `DELETE /v1/loadouts/:loadoutId` on a loadout any reservation ever referenced fails today with
  a foreign-key violation, not the `LOADOUT_*` error family in §8 — that is a `deployment.md`
  schema constraint surfacing through this endpoint, not an error this contract defines.

This is carried forward as an open item in §10 rather than resolved here, because the fix lives
in `deployment.md`'s table definition, not in this endpoint's logic.

```jsonc
// POST /v1/loadouts request
{
  "name": "Raid kit A",
  "slots": { "primary": "01J…", "helmet": "01J…", "consumable": "01J…" }
}

// 200 response
{
  "loadoutId": "01J…",
  "name": "Raid kit A",
  "slots": { "primary": "01J…", "helmet": "01J…", "consumable": "01J…" },
  "isDefault": false,
  "correlationId": "01J…"
}
```

Deployment reservation (`POST /v1/deployments`, the endpoint that performs §6.2's lock) and
the signed snapshot it returns are `P3-02`'s contract, not this one — this contract stops at
"a loadout is valid and its instances are lockable" and hands off exactly that precondition.

## 8. Error codes (additive to `errors.md` §3, closed enumeration per that contract's §2)

| Code | HTTP | Meaning |
|---|---:|---|
| `LOADOUT_INVALID_SLOT` | 400 | An instance's definition slot does not match its key in `slots` |
| `LOADOUT_ITEM_NOT_OWNED` | 400 | Referenced instance is not `owner=caller, location='permanent', status='active'` |
| `LOADOUT_DUPLICATE_INSTANCE` | 400 | Same `instance_id` used twice in one loadout's `slots` |
| `ITEM_LOCKED` | 409 | Write attempted on an instance with `locked = true` (§6.4) |
| `ITEM_NOT_STACKABLE` | 400 | A quantity-changing operation targeted a non-stackable instance |
| `ITEM_ALREADY_DEPLOYED` | 409 | Reservation attempted on an instance already `locked = true` under a different deployment (§6.2) |

## 9. Invariants a test suite asserts

1. **No instance has two owners.** For every `instance_id`, at most one row exists (instances
   are rows, not append logs) and `owner_account_id` is exactly one account or null (§5
   world/container states only).
2. **No stackable definition has two active, unlocked rows for the same
   `(owner, item_id, location, run_id, container_id)`.** The partial unique index (§2) — proven
   by a concurrent-pickup test that actually races two writers on the same container/run, not
   just the constraint's presence, and a second test that races two writers on two *different*
   containers and asserts both rows are allowed to exist — the gap this index was previously
   missing (§2's note) would only be caught by the second test:
   a schema constraint is not proof until something tries to violate it and fails.
3. **`locked = true` implies `locked_by_deployment_id` references a real `deployment_reservations`
   row with `status in ('reserved', 'consumed')`** — never `'released'` or `'expired'`, per
   `deployment.md`'s actual state machine (§2/§5.4 there) — **and every instance that
   deployment's snapshot names is `locked = true`**, never a partial lock set (§6.2). This is
   deliberately a one-directional implication, not an "iff": `deployment.md` §5.4 states a
   `consumed` reservation's `status` never changes again, even after `P3-04` settlement clears
   `locked = false` on its instances (`settlement.md` §8's "clears `locked`/
   `locked_by_deployment_id` in the same UPDATE as the terminal disposition"). So a `status =
   'consumed'` reservation exists in two real states this invariant must not conflate — mid-raid
   (its instances `locked = true`) and post-settlement (the same reservation, `status` still
   `'consumed'`, its instances now `locked = false`) — and only the first satisfies this
   invariant's implication in the forward direction; `status = 'consumed'` alone never implies
   `locked = true`. `'reserved'` and `'consumed'` are exactly the two statuses under which
   `items-inventory.md`/`deployment.md`'s writers guarantee a lock is held; `'released'` and
   `'expired'` are exactly the two statuses those same writers guarantee were set in the same
   transaction that cleared the lock (`deployment.md` §5's abort/timeout/expiry/manual paths,
   all of which set `released`, and the expiry sweep, which sets `expired`) — that pairing, not a generic
   "terminal" label this contract cannot itself define against `deployment_reservations`'
   four-value enum, is what this invariant tests.
4. **A locked instance's `item_id`, `quantity`, `attachments`, and `durability` are byte-identical
   before lock and after unlock** unless the unlock is the extract/death/abort transition that
   owns the row at that moment (§6.4) — asserted by attempting a mutation while the row is
   locked and confirming rejection, then diffing the row before and after the legitimate
   transition. A replay test alone would not catch this: it proves the *happy path* round-trips,
   not that an illegitimate write in between was refused.
5. **Every `run` instance belongs to exactly one match** (`run_id` non-null and FK-valid) and
   **no `run` instance outlives its match past settlement** — after `P3-04`'s settlement writes,
   zero rows remain `location='run', run_id=<that match>`; each is `permanent` or `lost`.
6. **No duplication**: total quantity of a stackable definition across all non-terminal rows
   for an account only increases via a creation event (§6.3) with a fresh `correlationId`, never
   via a lock/unlock, deploy/extract, or drop/pickup cycle — asserted by summing quantities
   before and after each transition class.
7. **Loadout validation (§3.1) rejects every one of its five listed cases**, including the
   save-vs-deploy distinction in rule 4 (two loadouts may share an idle instance; only one may
   ever lock it).
8. **Idempotent replay of `POST /v1/loadouts` and `PATCH /v1/loadouts/:id`** returns the stored
   response and performs no second write, per `http-api.md` §8 — direct instance of the same
   invariant already required of every other value-bearing endpoint.

## 10. Open items for `P3-02`/`P3-03`/`P3-04`

- The exact shape of the signed deployment snapshot (what it commits to, what key signs it,
  how the match server verifies it without a wallet/DB round trip) is `P3-02`'s to specify —
  this contract only guarantees the instances it locks are locked correctly.
- World/container loot generation (spawn tables, POI tags) is `P3-03`/`P3-11`'s to specify;
  this contract only defines the `location='world'|'container'` states those systems write
  into.
- `durability` and `attachments` are placeholders honored by this schema (nullable, unused in
  P3) and given real semantics in `P4-04`. No P3 code path sets `durability` to a non-null
  value or reads it for anything.
- `deployment.md` §2's `deployment_reservations.loadout_id` FK needs an `ON DELETE SET NULL`
  clause added to its own table definition before §7's "loadout delete never fails" behavior is
  actually true; until then `DELETE /v1/loadouts/:loadoutId` on a referenced loadout fails on
  the FK, and that reconciliation is `deployment.md`'s to make, not something this contract can
  fix by asserting it.
- §6.3's `item.created` field mapping (actor/subject/privacy/retention) is this contract's
  provisional specification of an event `event-envelope.md` §6 does not yet catalogue.
  `event-envelope.md` is `FROZEN`; promoting that mapping into its §6 table is a follow-up CCR
  against that contract, not this one.
