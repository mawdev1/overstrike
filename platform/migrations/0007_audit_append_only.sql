-- 0007 — audit_log is append-only at the database level.  contracts/db-schema.md §5, §9.3.
--
-- Two mechanisms, because they fail differently.
--
-- The grant is the real control: the application role holds INSERT and SELECT and nothing
-- else, so an attacker holding application credentials cannot rewrite the record of what they
-- did. An audit table the app can UPDATE proves nothing about the app.
--
-- The trigger is the belt-and-braces one: grants are per-role and a migration cannot know
-- every role a deployment will create (a superuser, a migration role, a future analytics
-- role). The trigger refuses the statement regardless of who issues it, so an audit row is
-- immutable even when someone connects as the owner.

create or replace function audit_log_is_append_only() returns trigger as $$
begin
  raise exception 'audit_log is append-only: % is not permitted', tg_op
    using errcode = 'restrict_violation';
end;
$$ language plpgsql;

create trigger audit_log_no_update before update on audit_log
  for each statement execute function audit_log_is_append_only();

create trigger audit_log_no_delete before delete on audit_log
  for each statement execute function audit_log_is_append_only();

-- Truncate bypasses row and statement DELETE triggers, so it needs its own.
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function audit_log_is_append_only();

-- Grants, applied only if the application role exists. A migration that fails on a machine
-- without the deployment's roles is a migration nobody can run locally, and a schema that
-- only applies in one environment is not a schema anyone has tested.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'overstrike_app') then
    revoke all on audit_log from overstrike_app;
    grant insert, select on audit_log to overstrike_app;
  end if;
end;
$$;
