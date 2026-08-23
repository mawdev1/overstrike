-- P4-04 — progression, the OP ledger, and repair/upgrade.  contracts/progression-economy.md §3, §6.

create table accounts_progression (
  account_id  text primary key references accounts (account_id),
  op_balance  int not null default 0,
  xp          int not null default 0,
  level       int not null default 1,
  updated_at  timestamptz not null default now(),

  check (op_balance >= 0),
  check (xp >= 0),
  check (level >= 1)
);
create trigger accounts_progression_updated_at before update on accounts_progression
  for each row execute function set_updated_at();

-- run_id/instance_id reference matches/item_instances directly (progression-economy.md §3.1's
-- own schema) — this is the same physical database every other P3/P4 module's tables live in,
-- the "two-store limitation" documented in deployment/settlement's module headers is a
-- pooling/transaction-boundary convention, not a separate database, so these FKs are valid.
create table op_ledger (
  entry_id         text primary key,
  account_id       text not null references accounts (account_id),
  delta            int not null,
  balance_after    int not null,
  reason           text not null,
  run_id           text references matches (match_id),
  instance_id      text references item_instances (instance_id),
  correlation_id   text not null,
  idempotency_key  text not null,
  created_at       timestamptz not null default now(),

  check (reason in ('run-reward','run-objective','run-survival','repair','upgrade',
                     'admin-grant','admin-adjustment')),
  check (reason not in ('run-reward','run-objective','run-survival') or run_id is not null),
  check (reason not in ('repair','upgrade') or instance_id is not null),
  check (balance_after >= 0)
);
create unique index op_ledger_idempotency on op_ledger(idempotency_key);
create index op_ledger_account_idx on op_ledger(account_id, created_at);
create index op_ledger_run_idx on op_ledger(run_id) where run_id is not null;

-- §6.2's per-definition upgrade bound. Nullable: a definition with no authored value has no
-- upgrade path (upgrade always refused, same posture durability_max=null already takes for
-- repair) rather than silently defaulting to some number nobody chose.
alter table item_definitions add column max_upgrade_tier int check (max_upgrade_tier is null or max_upgrade_tier >= 0);
