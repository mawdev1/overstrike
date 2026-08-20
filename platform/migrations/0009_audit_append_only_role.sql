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

-- Create the role if it is missing. NOLOGIN on purpose: it is the privilege set, and each
-- deployment grants it to its own login role with its own credential.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'overstrike_app') then
    begin
      create role overstrike_app nologin;
    exception when insufficient_privilege then
      raise exception
        'migrate 0009: role overstrike_app is missing and this role cannot create it. '
        'Create it once as a superuser: CREATE ROLE overstrike_app NOLOGIN; '
        'then re-run migrations.';
    end;
  end if;
end;
$$;

-- PUBLIC is revoked first: a privilege held via PUBLIC is held by every role, including the
-- one the app connects as, and revoking it from the app role alone would leave it in place.
revoke all on audit_log from public;
revoke all on audit_log from overstrike_app;
grant insert, select on audit_log to overstrike_app;

-- And prove it, in the same transaction as the grant. A migration that asserts nothing is a
-- migration that can silently do nothing — which is precisely how 0007 shipped green.
do $$
declare
  bad text;
begin
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
