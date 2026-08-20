-- 0008: account credentials and authorisation columns.
--
-- The auth module needs three fields db-schema.md §2 did not declare, because §2 was written
-- assuming D1 (Supabase Auth) holds credentials entirely. Two of them are ours regardless of
-- provider, and the third is what makes a self-hosted fallback not require a schema change:
--
--   password_hash    null when identity is delegated to the provider
--   roles            auth.md §10; seven fixed roles, no metadata, so a column not a table
--   name_changed_at  auth.md §9's 30-day cooldown, which cannot be derived from
--                    account_name_history for an account that has never renamed
--
-- Forward-only and additive: existing rows take the defaults, no backfill needed.

alter table accounts
  add column if not exists password_hash   text,
  add column if not exists roles           text[] not null default '{player}',
  add column if not exists name_changed_at timestamptz;

-- Every account has at least the player role. A row with an empty array would be an account
-- that can do nothing, which is a bug rather than a state we ever mean.
-- Guarded so the whole file is replayable by hand, which the `if not exists` above already
-- promised. A file that is half idempotent is the one an operator re-runs and breaks.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'accounts_roles_nonempty') then
    alter table accounts add constraint accounts_roles_nonempty check (array_length(roles, 1) >= 1);
  end if;
end $$;
