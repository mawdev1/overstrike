-- P3-02 — atomic deployment reservation and the signed inventory snapshot's replay ledger.
--   contracts/deployment.md §2, §4.4.
--
-- This migration also lands the FK 0027 deliberately left as a forward reference:
-- item_instances.locked_by_deployment_id -> deployment_reservations(reservation_id).
-- items-inventory.md's migration header names exactly this file as the one that adds it
-- ("the FK added by whichever migration creates the referenced table").
--
-- deployment.md §0's second open item: matches.mode's CHECK (db-schema.md §4) does not yet
-- admit 'extraction'. match_id/run_id here are plain FKs to `matches` regardless — the column
-- and the FK are valid today against any matches row (tdm/bomb); the CHECK amendment that
-- admits 'extraction' rows is a separate, not-yet-landed migration this one does not attempt.

create table deployment_reservations (
  reservation_id     text primary key,
  account_id         text not null references accounts (account_id),
  loadout_id         text references loadouts (loadout_id),
  room_id            text references rooms (room_id),
  match_id           text references matches (match_id),
  instance_ids       text[] not null,
  status             text not null default 'reserved'
                       check (status in ('reserved','consumed','released','expired')),
  reserved_at        timestamptz not null default now(),
  expires_at         timestamptz not null,
  consumed_at        timestamptz,
  released_at        timestamptz,
  released_reason    text
                       check (released_reason is null or released_reason in
                         ('abort','timeout','expiry','manual','superseded')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- §2: the biconditional covers BOTH terminal-with-timestamp statuses ('released','expired'),
  -- not just 'released' — see the contract's own note on why an earlier single-status draft of
  -- this CHECK would reject the expiry sweep's own UPDATE.
  check ((status in ('released','expired')) = (released_at is not null)),
  check (status not in ('released','expired') or released_reason is not null)
);
create trigger deployment_reservations_updated_at before update on deployment_reservations
  for each row execute function set_updated_at();

-- The expiry sweep (§5.3) scans exactly this set; the account lookup ("does this account have a
-- live reservation") is the other hot path a lobby/deploy flow takes.
create index deployment_reservations_sweep_idx
  on deployment_reservations (expires_at) where status = 'reserved';
create index deployment_reservations_account_idx
  on deployment_reservations (account_id, status);

alter table item_instances
  add constraint item_instances_locked_by_deployment_id_fkey
  foreign key (locked_by_deployment_id) references deployment_reservations (reservation_id);

-- §4.4 — replay protection. Mirrors match_tickets (db-schema.md §4) exactly: the signature is
-- a portable claim, this row is the replay authority. `expires_at` is independent of the
-- reservation's own 90s TTL (§2.2) — the snapshot's window is 60s, matching the auth.md §6
-- session ticket it travels beside (§4.3).
create table deployment_snapshots (
  snapshot_id    text primary key,
  reservation_id text not null references deployment_reservations (reservation_id),
  match_id       text not null references matches (match_id),
  issued_at      timestamptz not null,
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index deployment_snapshots_reservation_idx on deployment_snapshots (reservation_id);
