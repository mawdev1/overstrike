-- 0018 — apply 0009's append-only guarantee to the role the app ACTUALLY connects as.
--   db-schema.md §5, §9.3. Supersedes 0009's grant block; 0009 is not edited (forward-only).
--
-- 0009 is right about the property and wrong about how to reach it on a managed database.
-- It hard-codes the role name `overstrike_app` and creates it when missing, which needs
-- CREATEROLE. No managed Postgres grants that to a customer role: on Fly Managed Postgres the
-- application connects as `schema_admin`, which cannot CREATE ROLE at all — and the platform's
-- own user names may not even contain an underscore, so `overstrike_app` is not a name that
-- service can produce. 0009 therefore fails its own precondition and aborts the deployment,
-- which is the correct behaviour and also a dead end.
--
-- The property 0009 is protecting does not depend on the NAME. It is:
--
--     the role the application connects as must hold INSERT and SELECT on audit_log,
--     and must NOT hold UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER on it.
--
-- So this migration reads the role from `overstrike.app_role`, a session setting the runner
-- publishes from PLATFORM_APP_ROLE (default `overstrike_app`, so an existing deployment that
-- already ran 0009 is unchanged). The value arrives as a PARAMETER to set_config and is quoted
-- here with quote_ident, so a role name is never concatenated into SQL.
--
-- ============================ OPERATOR NOTE, still load-bearing ============================
-- This does NOT make it safe for the app to connect as the table owner. An owner re-grants to
-- itself and disables its own triggers, and no grant below can stop that. Migrations must run
-- as the owner (MIGRATION_DATABASE_URL) and the app must connect as a different, non-owner
-- role (DATABASE_URL). This migration ASSERTS that they differ and fails if they do not, so
-- the requirement is enforced at deploy time rather than remembered.
-- =========================================================================================

do $$
declare
  app_role text := current_setting('overstrike.app_role', true);
  owner    text := current_user;
  bad      text;
begin
  if app_role is null or app_role = '' then
    raise exception 'migrate 0018: overstrike.app_role is not set; the runner must publish it';
  end if;

  if not exists (select 1 from pg_roles where rolname = app_role) then
    raise exception
      'migrate 0018: role % does not exist. Create it first — on a managed database use that '
      'provider''s user API (it cannot be created from here without CREATEROLE), then set '
      'PLATFORM_APP_ROLE to its name.', app_role;
  end if;

  -- The owner/app separation, asserted rather than documented. If the app connects as the
  -- role running migrations, everything below is decoration and the deployment should stop.
  if app_role = owner then
    raise exception
      'migrate 0018: the application role (%) is the role running migrations. audit_log '
      'cannot be append-only against its own owner: an owner re-grants to itself and can '
      'disable its own triggers. Run migrations as the owner via MIGRATION_DATABASE_URL and '
      'point DATABASE_URL at a separate, non-owner role.', app_role;
  end if;

  -- Revoke along the whole INHERITANCE CHAIN, not just from the app role.
  --
  -- This is the part 0009 could not have known it needed, because it invented a NOLOGIN role
  -- that inherited nothing. A managed provider hands you a login user that is a MEMBER of a
  -- built-in group — on Fly, `overstrike-app` is a member of `writer`, which holds UPDATE and
  -- DELETE on every table. `has_table_privilege` follows role membership, so revoking from the
  -- app role alone changes nothing observable: the privilege is still held, via the group.
  --
  -- That is exactly what happened on the first deployment attempt. The revoke below ran, and
  -- the assertion at the bottom of this file caught it:
  --
  --     migrate 0018: overstrike-app still holds UPDATE, DELETE on audit_log
  --
  -- which is the difference between a migration that asserts and one that reports success.
  --
  -- So: every role the app role inherits privileges from (pg_has_role ... 'USAGE' includes the
  -- role itself), except the table owner and any superuser, loses the mutating privileges on
  -- THIS ONE TABLE. Scoped to audit_log, so a shared group role keeps every other privilege it
  -- has. An operator sharing `writer` with another application should know that this narrows
  -- that group's rights on audit_log specifically — which is the intent, since the point is
  -- that nothing but the owner may rewrite the audit trail.
  execute 'revoke all on audit_log from public';
  for bad in
    select quote_ident(rolname) from pg_roles
     where pg_has_role(app_role, oid, 'USAGE')
       and rolname <> owner
       and not rolsuper
  loop
    execute 'revoke update, delete, truncate, references, trigger on audit_log from ' || bad;
  end loop;
  execute format('grant insert, select on audit_log to %I', app_role);

  -- Prove it, in the same transaction as the grant. A migration that asserts nothing is a
  -- migration that can silently do nothing — which is exactly how 0007 shipped green.
  select string_agg(priv, ', ') into bad
    from unnest(array['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as priv
   where has_table_privilege(app_role, 'audit_log', priv);
  if bad is not null then
    raise exception 'migrate 0018: % still holds % on audit_log', app_role, bad;
  end if;

  if not has_table_privilege(app_role, 'audit_log', 'INSERT')
     or not has_table_privilege(app_role, 'audit_log', 'SELECT') then
    raise exception 'migrate 0018: % cannot insert into or read audit_log', app_role;
  end if;
end;
$$;
