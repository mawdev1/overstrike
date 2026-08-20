-- 0003 — profile and career stats.  contracts/db-schema.md §3.

create table profiles (
  account_id       text primary key references accounts (account_id),
  roaming_settings jsonb,
  settings_version int not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create trigger profiles_updated_at before update on profiles
  for each row execute function set_updated_at();

-- Counters only. No stored ratios: K/D, accuracy and win rate are computed at read time,
-- because a stored ratio goes stale and then disagrees with its own inputs, and only one of
-- the two is right.
--
-- stat_definition_version is in the primary key so a definition change starts a new row
-- instead of silently rewriting history (match-result.md §4).
create table player_stats (
  account_id              text not null references accounts (account_id),
  mode                    text not null,          -- tdm|bomb
  stat_definition_version text not null,
  kills           bigint not null default 0,
  deaths          bigint not null default 0,
  assists         bigint not null default 0,
  suicides        bigint not null default 0,
  team_kills      bigint not null default 0,
  headshots       bigint not null default 0,
  shots_fired     bigint not null default 0,
  shots_hit       bigint not null default 0,
  damage_dealt    bigint not null default 0,
  plants          bigint not null default 0,
  defuses         bigint not null default 0,
  matches         bigint not null default 0,
  wins            bigint not null default 0,
  losses          bigint not null default 0,
  -- draws exists because the career surface returns it and Bomb can genuinely draw at 6-6
  -- (bomb-rules.md §2.1a). A returned field with no column is a field that reads zero forever.
  draws           bigint not null default 0,
  rounds_played   bigint not null default 0,
  time_played_sec bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, mode, stat_definition_version)
);

create trigger player_stats_updated_at before update on player_stats
  for each row execute function set_updated_at();

-- stat_definition_version is part of this key for the same reason it is part of player_stats:
-- a definition change must not silently rewrite historical per-weapon accuracy.
create table player_weapon_stats (
  account_id              text not null references accounts (account_id),
  mode                    text not null,
  weapon_id               text not null,
  stat_definition_version text not null,
  shots      bigint not null default 0,
  hits       bigint not null default 0,
  kills      bigint not null default 0,
  headshots  bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, mode, weapon_id, stat_definition_version)
);

create trigger player_weapon_stats_updated_at before update on player_weapon_stats
  for each row execute function set_updated_at();
