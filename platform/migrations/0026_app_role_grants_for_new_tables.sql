-- 0026 — grant the app role the tables that were created AFTER 0018 ran, and stop this
--        happening again.  db-schema.md §5, §9.3.
--
-- ── The defect ───────────────────────────────────────────────────────────────────────────
-- 0018 enumerates writes per table rather than relying on an ambient group role, which is the
-- right design and the reason audit_log can be append-only at all. What it could not do is
-- cover tables that did not exist yet. It ran a `for ... in select tablename from pg_tables`
-- loop ONCE, against the schema as it stood at 0018.
--
-- Every migration after it created tables nobody granted:
--
--     0022 match_evidence, 0024 chat_messages, 0025 match_tickets
--
-- The application connects as a non-owner role with no ambient write privilege — deliberately —
-- so those tables were simply unreachable. Found in production, not in a test:
--
--     {"event":"lobby.sweep.failed","errorCode":"INTERNAL_ERROR","errorClass":"ApiError"}
--
-- every fifteen seconds, because the lobby sweep opens with `chat_messages.purgeExpired` and
-- `match_tickets.purgeExpired`. The same cause made every match launch fail at the durable
-- commit that writes `match_tickets`, so no player could start a game while the deployment
-- reported itself healthy in every other respect. `permission denied for table chat_messages`
-- was the whole story, and nothing surfaced it: the store wraps a driver error as
-- INTERNAL_ERROR, and the logger correctly refuses to print exception text.
--
-- ── Why a loop AND default privileges ────────────────────────────────────────────────────
-- The loop repairs the tables that exist now. ALTER DEFAULT PRIVILEGES is what stops the next
-- migration re-creating the same hole: it applies to tables created LATER by the owner role,
-- so a future `create table` is reachable by the app without anyone remembering this file.
--
-- Default privileges are attached to the ROLE THAT CREATES the object, which is why this must
-- run as the migration owner — the same role every migration runs as. It does not retroactively
-- affect existing tables, hence both halves.
--
-- audit_log keeps its exclusion in the loop. It is deliberately NOT excluded from the default
-- privileges, because default privileges cannot apply to a table that already exists, and the
-- assertion at the bottom fails the deploy if its append-only property ever slips anyway.
--
-- ── Why the assertion is the important part ──────────────────────────────────────────────
-- The grants below would have been written by hand as a one-off SQL fix in about a minute. The
-- reason this is a migration with a check in it is that the one-off fixes nothing structural:
-- the next table added would be unreachable in exactly the same way, discovered the same way,
-- in production. The final loop asserts that EVERY table in the schema is actually usable by
-- the app role, so a future migration that adds a table and forgets its grant fails at deploy
-- time with the table named, instead of at 3am with a permission error the logger will not
-- print.

do $$
declare
  app_role text := current_setting('overstrike.app_role', true);
  owner    text := current_user;
  item     text;
  missing  text;
begin
  if app_role is null or app_role = '' then
    raise exception 'migrate 0026: overstrike.app_role is not set; the runner must publish it';
  end if;

  if not exists (select 1 from pg_roles where rolname = app_role) then
    raise exception 'migrate 0026: role % does not exist', app_role;
  end if;

  -- Same owner/app separation 0018 asserts. Repeated rather than assumed: this file grants
  -- privileges, and a grant from a role to itself proves nothing.
  if app_role = owner then
    raise exception
      'migrate 0026: the application role (%) is the role running migrations. Run migrations '
      'as the owner via MIGRATION_DATABASE_URL and point DATABASE_URL at a non-owner role.',
      app_role;
  end if;

  -- Repair: every table that exists today, except the append-only one.
  for item in
    select quote_ident(tablename) from pg_tables
     where schemaname = 'public' and tablename <> 'audit_log'
  loop
    execute 'grant select, insert, update, delete on ' || item || ' to ' || quote_ident(app_role);
  end loop;

  for item in
    select quote_ident(sequencename) from pg_sequences where schemaname = 'public'
  loop
    execute 'grant usage, select on sequence ' || item || ' to ' || quote_ident(app_role);
  end loop;

  -- Prevent recurrence: tables and sequences created later by this owner are granted on
  -- creation. `for role owner` is explicit rather than implied by the session, so re-running
  -- under a different superuser session cannot silently attach the default to the wrong role.
  execute format(
    'alter default privileges for role %I in schema public '
    'grant select, insert, update, delete on tables to %I', owner, app_role);
  execute format(
    'alter default privileges for role %I in schema public '
    'grant usage, select on sequences to %I', owner, app_role);

  -- ── The assertion, which is the point of the file ──────────────────────────────────────
  -- Names the offending tables rather than reporting a count, so the failure tells whoever
  -- reads it what to add.
  -- SCHEMA-QUALIFIED, and filtered in a subquery that is materialised before the privilege
  -- calls run.
  --
  -- Written as one flat query with `where schemaname = 'public' and not has_table_privilege(...)`
  -- this fails on a fresh database with `relation "sql_features" does not exist`. Nothing is
  -- wrong with the filter; SQL simply does not promise that a WHERE conjunct is evaluated before
  -- its neighbours, so the planner is free to call has_table_privilege on an information_schema
  -- row first. An unqualified name is then resolved against search_path, where it is not
  -- visible, and the function raises rather than returning false.
  --
  -- Production happened to plan it the other way and passed, which is the worst version of this
  -- bug: green where it ran, broken on every new environment. `offset 0` is an optimisation
  -- fence that stops the outer predicate being pulled into the subquery, and the qualified name
  -- means resolution never depends on search_path at all.
  select string_agg(name, ', ' order by name) into missing
    from (select tablename as name, 'public.' || quote_ident(tablename) as ref
            from pg_tables
           where schemaname = 'public' and tablename <> 'audit_log'
           offset 0) t
   where not (has_table_privilege(app_role, ref, 'SELECT')
          and has_table_privilege(app_role, ref, 'INSERT')
          and has_table_privilege(app_role, ref, 'UPDATE')
          and has_table_privilege(app_role, ref, 'DELETE'));
  if missing is not null then
    raise exception
      'migrate 0026: % cannot fully use these tables: %. A migration added them without a '
      'grant; add it there rather than repairing by hand.', app_role, missing;
  end if;

  -- audit_log is unchanged by all of the above — restated here so this file cannot be the one
  -- that quietly widens it.
  select string_agg(priv, ', ') into missing
    from unnest(array['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as priv
   where has_table_privilege(app_role, 'public.audit_log', priv);
  if missing is not null then
    raise exception 'migrate 0026: % now holds % on audit_log; it must stay append-only',
      app_role, missing;
  end if;

  if not has_table_privilege(app_role, 'public.audit_log', 'INSERT')
     or not has_table_privilege(app_role, 'public.audit_log', 'SELECT') then
    raise exception 'migrate 0026: % cannot insert into or read audit_log', app_role;
  end if;
end;
$$;
