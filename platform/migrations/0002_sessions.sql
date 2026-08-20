-- 0002 — sessions and refresh tokens.  contracts/db-schema.md §2, contracts/auth.md §3, §5.

create table sessions (
  session_id        text primary key,
  account_id        text not null references accounts (account_id),
  device_label      text,
  -- CLASS, never a raw address or user agent string. A session list is readable by whoever
  -- holds the account, including someone who just stole it (auth.md §3); handing that person
  -- the owner's IP history turns an account takeover into a doxxing.
  user_agent_class  text,
  ip_class          text,
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  revoked_at        timestamptz,
  revoked_reason    text,
  -- Rotation family. Reuse of any refresh token revokes the whole family, which is only
  -- possible if the family is a stored column rather than something inferred from a chain.
  refresh_family_id text not null,
  updated_at        timestamptz not null default now()
);

create trigger sessions_updated_at before update on sessions
  for each row execute function set_updated_at();

create index sessions_account_idx on sessions (account_id) where revoked_at is null;
create index sessions_family_idx on sessions (refresh_family_id);

-- Refresh tokens are their own table rather than a column on sessions: rotation means a
-- session has many tokens over its life, and detecting reuse requires the used ones to still
-- be there. Deleting a spent token deletes the evidence of the replay.
create table refresh_tokens (
  token_id    text primary key,
  family_id   text not null,
  account_id  text not null references accounts (account_id),
  session_id  text not null references sessions (session_id),
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger refresh_tokens_updated_at before update on refresh_tokens
  for each row execute function set_updated_at();

create index refresh_tokens_family_idx on refresh_tokens (family_id);
create index refresh_tokens_session_idx on refresh_tokens (session_id);
