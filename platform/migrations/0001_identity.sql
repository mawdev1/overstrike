-- 0001 — identity.  contracts/db-schema.md §2.
--
-- Forward-only. Once this file is merged it is never edited; a correction is a new migration.
-- An edited migration means the schema a developer gets from a fresh apply and the schema
-- production got from the original apply are different, and nothing tells you which is running.

-- Every table carries updated_at and the database owns it. An application-set updated_at is
-- an updated_at that is wrong the first time someone writes a row from a script.
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create table accounts (
  account_id              text primary key,
  status                  text not null default 'active'
                            check (status in ('active','restricted','banned','deleted')),
  email_hash              text unique,          -- lookup only; the address lives with the auth provider
  display_name            text not null,
  -- Uniqueness is on the folded name, not the raw one. Enforcing on display_name lets
  -- 'Ada' and 'Аdа' (Cyrillic А) coexist, which is the cheapest impersonation attack there is.
  display_name_folded     text not null unique,

  -- Onboarding state, typed rather than free JSON (REQ-CC-022). These gate access and carry
  -- legal weight; a jsonb blob cannot be constrained, indexed, or migrated safely.
  eligibility_verdict     boolean,
  eligibility_policy_ver  int,
  eligibility_decided_at  timestamptz,
  email_verified_at       timestamptz,
  terms_version_accepted  int,
  terms_accepted_at       timestamptz,
  -- NULL means undecided, which is not the same as a recorded 'no'. An account predating the
  -- policy has made no decision and is treated as no consent until it makes one.
  consent_telemetry       boolean,
  consent_policy_ver      int,
  consent_decided_at      timestamptz,

  privacy                 jsonb not null default '{}',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz
);

-- There is deliberately NO birthdate column. The eligibility preflight (http-api.md §3a.1)
-- evaluates a date of birth and discards it; only the verdict, its policy version and the
-- decision time are stored. The most sensitive field in the funnel is never persisted, which
-- is also the cheapest possible answer to a deletion request about it.

create trigger accounts_updated_at before update on accounts
  for each row execute function set_updated_at();

-- Soft delete, not DELETE: a row that vanishes takes its history with it (§1 rule 2).
create index accounts_status_idx on accounts (status) where deleted_at is null;

create table account_name_history (
  account_id     text not null references accounts (account_id),
  previous_name  text not null,
  changed_at     timestamptz not null default now(),
  changed_by     text,
  reason         text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (account_id, changed_at)
);

create trigger account_name_history_updated_at before update on account_name_history
  for each row execute function set_updated_at();

-- Signed-out consent, recorded before an account exists (http-api.md §3a.3). 30-day TTL,
-- deleted on migration at signup. Never joined to an account except by the receipt presented
-- at signup, so there is no account_id column and there must not be one.
create table pre_auth_consent (
  client_session_id  text primary key,
  telemetry_personal boolean not null,
  policy_version     int not null,
  decided_at         timestamptz not null,
  expires_at         timestamptz not null,
  migrated_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger pre_auth_consent_updated_at before update on pre_auth_consent
  for each row execute function set_updated_at();

create index pre_auth_consent_expiry_idx on pre_auth_consent (expires_at)
  where migrated_at is null;
