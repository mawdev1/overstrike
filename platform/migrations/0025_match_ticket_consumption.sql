-- Durable single-use admission: a game-server restart must not make an old HMAC replayable.
create table if not exists match_tickets (
  jti text primary key,
  account_id text not null references accounts(account_id),
  room_id text not null references rooms(room_id),
  match_id text not null references matches(match_id),
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  created_at timestamptz not null default now()
);
create index if not exists match_tickets_expiry_idx on match_tickets(expires_at);
