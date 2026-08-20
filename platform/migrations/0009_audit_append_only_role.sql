-- 0009 — make the audit_log append-only guarantee real as deployed.  db-schema.md §5, §9.3.
--
-- 0007 declared two mechanisms and shipped one. Its grant block was wrapped in
-- `if exists (select 1 from pg_roles where rolname = 'overstrike_app')`, and that role does not
-- exist in any environment — so the block was a no-op everywhere, and the role the application
-- actually connects as kept UPDATE, DELETE and TRUNCATE on audit_log. The trigger alone does
-- not close that: the table's OWNER may run
--
--     alter table audit_log disable trigger all;
--     delete from audit_log where ...;
--
-- which is exactly the sequence an attacker holding application credentials would run, and the
-- credentials are the owner's whenever DATABASE_URL is the role that ran the migrations.
--
-- 0007 is not edited — migrations are forward-only and its checksum is recorded. This file
-- supersedes its grant block, and it FAILS LOUDLY rather than skipping.
--
-- ============================ OPERATOR NOTE, load-bearing ============================
-- The application's DATABASE_URL MUST be a role that is NOT the owner of these tables and NOT
-- a superuser: `overstrike_app`, or a login role granted `overstrike_app`. Migrations run as
-- the owner, from a separate URL. If the app connects as the owner, everything below is
-- decoration — an owner can re-grant to itself and disable its own triggers, and no schema
-- object can prevent that.
-- =====================================================================================

-- AMENDED before this file had ever applied anywhere. See 0018.
--
-- This migration hard-codes `overstrike_app` and creates it when missing, which needs
-- CREATEROLE. No managed Postgres grants that: on Fly Managed Postgres the customer connects
-- as `schema_admin`, which cannot CREATE ROLE, and that platform's user names may not even
-- contain an underscore — so `overstrike_app` is a name it cannot produce. This file therefore
-- failed its own precondition and aborted the first real deployment of the platform, at 0009,
-- with 0001-0008 applied.
--
-- Editing an applied migration is forbidden here and that rule is not being bent: `select
-- version from schema_migrations` was checked against the one database that had ever run this
-- runner and returned 1-8. This file had applied NOWHERE, so no recorded checksum exists to
-- invalidate. The amendment is confined to the role-creation block; the grants and assertions
-- below are untouched.
--
-- When `overstrike.app_role` names a different role, everything here defers to 0018, which
-- does the same work against the configured name. The default path is unchanged, so a
-- deployment that CAN create `overstrike_app` behaves exactly as before.
do $$
declare
  app_role text := coalesce(nullif(current_setting('overstrike.app_role', true), ''), 'overstrike_app');
begin
  if app_role <> 'overstrike_app' then
    raise notice 'migrate 0009: overstrike.app_role is %, deferring to 0018', app_role;
    return;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'overstrike_app') then
    begin
      create role overstrike_app nologin;
    exception when insufficient_privilege then
      raise exception
        'migrate 0009: role overstrike_app is missing and this role cannot create it. '
        'Create it once as a superuser: CREATE ROLE overstrike_app NOLOGIN; or set '
        'PLATFORM_APP_ROLE to a role your provider CAN create and let 0018 handle it.';
    end;
  end if;
end;
$$;

-- PUBLIC is revoked first: a privilege held via PUBLIC is held by every role, including the
-- one the app connects as, and revoking it from the app role alone would leave it in place.
revoke all on audit_log from public;

do $$
declare
  app_role text := coalesce(nullif(current_setting('overstrike.app_role', true), ''), 'overstrike_app');
begin
  if app_role <> 'overstrike_app' then return; end if;   -- 0018 grants against the real role
  execute 'revoke all on audit_log from overstrike_app';
  execute 'grant insert, select on audit_log to overstrike_app';
end;
$$;

-- And prove it, in the same transaction as the grant. A migration that asserts nothing is a
-- migration that can silently do nothing — which is precisely how 0007 shipped green.
do $$
declare
  bad text;
begin
  if coalesce(nullif(current_setting('overstrike.app_role', true), ''), 'overstrike_app')
     <> 'overstrike_app' then
    return;                                              -- 0018 asserts against the real role
  end if;
  if not exists (select 1 from pg_roles where rolname = 'overstrike_app') then
    raise exception 'migrate 0009: overstrike_app still does not exist after creating it';
  end if;

  select string_agg(priv, ', ') into bad
    from unnest(array['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as priv
   where has_table_privilege('overstrike_app', 'audit_log', priv);
  if bad is not null then
    raise exception 'migrate 0009: overstrike_app still holds % on audit_log', bad;
  end if;

  if not has_table_privilege('overstrike_app', 'audit_log', 'INSERT')
     or not has_table_privilege('overstrike_app', 'audit_log', 'SELECT') then
    raise exception 'migrate 0009: overstrike_app cannot insert into or read audit_log';
  end if;
end;
$$;
