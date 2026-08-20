-- 0004 — rooms, servers and matches.  contracts/db-schema.md §4.

create table rooms (
  room_id          text primary key,
  owner_account_id text not null references accounts (account_id),
  region           text not null,
  map_id           text not null,
  mode             text not null,
  capacity         int not null,
  status           text not null default 'open'
                     check (status in ('open','countdown','in-progress','closing','destroyed')),
  settings         jsonb not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  destroyed_at     timestamptz,
  destroyed_reason text
);

create trigger rooms_updated_at before update on rooms
  for each row execute function set_updated_at();

create index rooms_open_idx on rooms (region, mode, status) where destroyed_at is null;

-- left_at rather than a delete: who was in the room when it went wrong is the first question
-- any moderation or crash investigation asks.
create table room_members (
  room_id    text not null references rooms (room_id),
  account_id text not null references accounts (account_id),
  team       text,
  ready      boolean not null default false,
  loadout    jsonb,
  joined_at  timestamptz not null default now(),
  left_at    timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (room_id, account_id)
);

create trigger room_members_updated_at before update on room_members
  for each row execute function set_updated_at();

create table match_servers (
  server_id         text primary key,
  region            text not null,
  address           text not null,
  capacity          int not null,
  in_use            int not null default 0,
  status            text not null default 'registering'
                      check (status in ('registering','healthy','draining','unhealthy','gone')),
  build             text,
  last_heartbeat_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger match_servers_updated_at before update on match_servers
  for each row execute function set_updated_at();

create index match_servers_alloc_idx on match_servers (region, status, last_heartbeat_at);

-- Rows are created at ALLOCATION, not completion. A match that dies before its first tick
-- still has an id, which is the only way the crash is attributable (match-result.md §4).
create table matches (
  match_id                text primary key,
  room_id                 text references rooms (room_id),
  region                  text not null,
  server_id               text references match_servers (server_id),
  map_id                  text not null,
  map_version             text,
  mode                    text not null,
  ruleset_version         text,
  stat_definition_version text,
  server_build            text,
  status                  text not null default 'allocated'
                            check (status in ('allocated','in-progress','completed','aborted','invalidated')),
  termination_reason      text,
  outcome_reason          text,
  invalidation_reason     text,
  -- NULL is NOT a draw (match-result.md §4.0). A draw is the literal 'draw'; NULL means the
  -- match has no outcome yet or never got one, and collapsing the two loses the abort.
  winner_team             text check (winner_team in ('alpha','bravo','draw')),
  -- Immutable copy of the ruleset in force. A result without it is uninterpretable the moment
  -- the ruleset is retuned, and it will be retuned.
  rules_snapshot          jsonb not null,
  team_scores             jsonb,
  rounds                  jsonb,
  evidence_ref            text,
  allocated_at            timestamptz not null default now(),
  started_at              timestamptz,
  ended_at                timestamptz,
  result_applied_at       timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create trigger matches_updated_at before update on matches
  for each row execute function set_updated_at();

create index matches_recent_idx on matches (mode, ended_at desc);
create index matches_room_idx on matches (room_id);

-- stats is jsonb deliberately: the stat set evolves per mode and per definition version, and
-- a wide sparse column-per-stat table would need a migration for every new mode. Career
-- aggregates in §3 are typed columns; the per-match record is a document.
create table match_participants (
  match_id     text not null references matches (match_id),
  account_id   text not null references accounts (account_id),
  team         text,
  joined_at    timestamptz not null default now(),
  left_at      timestamptz,
  disconnected boolean not null default false,
  abandoned    boolean not null default false,
  stats        jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (match_id, account_id)
);

create trigger match_participants_updated_at before update on match_participants
  for each row execute function set_updated_at();

create index match_participants_account_idx on match_participants (account_id, joined_at desc);
