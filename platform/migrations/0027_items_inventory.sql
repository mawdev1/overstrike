-- P3-01 — item definitions, item instances, loadouts.  contracts/items-inventory.md §2, §3.
--
-- Definitions are authored catalog rows (P3-11); instances are the owned, lockable things
-- gameplay actually touches. See items-inventory.md §2 for why the split exists and §6 for how
-- the lock columns on item_instances are the entire mechanism behind double-equip prevention,
-- concurrent-deployment locking, duplication prevention, and locked-item mutation refusal.
--
-- Two columns are deliberate forward references to tables that do not exist yet:
--   - item_instances.locked_by_deployment_id -> P3-02's deployment_reservations
--   - item_instances.container_id            -> P3-03's world_loot_containers
-- db-schema.md §1 rule 6 wants every FK declared, but a migration cannot reference a table
-- that has not been created. Both columns are plain text here, gated by the same CHECKs the
-- contract specifies (§2), with the FK added by whichever migration creates the referenced
-- table (additive, forward-only, per §8) rather than by editing this file.

create table item_definitions (
  item_id           text primary key,
  class             text not null check (class in ('weapon','gear','consumable','material','cosmetic')),
  slot              text check (slot is null or slot in
                        ('primary','secondary','melee','helmet','vest','backpack','rig','consumable')),
  rarity_tier       text not null check (rarity_tier in ('common','uncommon','rare','epic','legendary')),
  stackable         boolean not null,
  max_stack         int,
  base_stats        jsonb not null default '{}',
  durability_max    int,
  tradable          boolean not null default false,
  content_version   int not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger item_definitions_updated_at before update on item_definitions
  for each row execute function set_updated_at();

create table item_instances (
  instance_id             text primary key,
  item_id                 text not null references item_definitions (item_id),
  owner_account_id        text references accounts (account_id),
  quantity                int not null default 1 check (quantity >= 1),
  durability              int,
  attachments             jsonb not null default '[]',
  location                text not null check (location in ('permanent','run','world','container')),
  run_id                  text references matches (match_id),
  container_id            text,   -- forward ref: P3-03 world_loot_containers (see header)
  locked                  boolean not null default false,
  locked_by_deployment_id text,   -- forward ref: P3-02 deployment_reservations (see header)
  status                  text not null default 'active'
                            check (status in ('active','consumed','destroyed','lost','merged')),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  check (locked = (locked_by_deployment_id is not null)),
  check (location = 'run' or run_id is null),
  check (location <> 'run' or run_id is not null),
  check (location in ('world','container') or container_id is null),
  check (location not in ('world','container') or container_id is not null)
);
create trigger item_instances_updated_at before update on item_instances
  for each row execute function set_updated_at();

create index item_instances_owner_location_idx
  on item_instances(owner_account_id, location) where status = 'active';
create index item_instances_run_idx
  on item_instances(run_id) where location = 'run';

-- §2's stackable collapse: at most one active, unlocked instance row per (owner, item_id,
-- location, run_id, container_id). container_id is part of the key so every sealed container
-- and every world spawn-group collapses independently rather than colliding on the shared
-- NULL every non-run/non-container row would otherwise present (see the contract's own note
-- on why container_id can't be omitted from this index).
create unique index item_instances_stackable_collapse
  on item_instances(owner_account_id, item_id, location, coalesce(run_id, ''), coalesce(container_id, ''))
  where status = 'active' and locked = false;

create table loadouts (
  loadout_id   text primary key,
  account_id   text not null references accounts (account_id),
  name         text not null,
  slots        jsonb not null,
  is_default   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger loadouts_updated_at before update on loadouts
  for each row execute function set_updated_at();

create unique index loadouts_one_default on loadouts(account_id) where is_default;
