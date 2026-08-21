-- 0020 — P2 live room projection fields. The original P0 tables held only simulation-facing
-- columns; these retain the browser contract and reconnect seat across a platform restart.
alter table rooms add column if not exists name text;
alter table rooms add column if not exists map_version text;
alter table rooms add column if not exists ruleset_version text;
alter table rooms add column if not exists build text;
alter table rooms add column if not exists password_hash text;

alter table room_members add column if not exists display_name text;
alter table room_members add column if not exists is_owner boolean not null default false;
alter table room_members add column if not exists connection text not null default 'connected'
  check (connection in ('connected','reconnecting','disconnected'));
alter table room_members add column if not exists disconnected_at timestamptz;
alter table room_members add column if not exists estimated_rtt_ms int;
alter table room_members add column if not exists muted_account_ids jsonb not null default '[]'::jsonb;

-- SQL UNIQUE normally treats NULLs as distinct, so the original constraint allowed unlimited
-- duplicate no-match reports. A missing incident id is still the same incident key here.
alter table reports drop constraint if exists reports_no_duplicate;
alter table reports add constraint reports_no_duplicate
  unique nulls not distinct (reporter_account_id, subject_account_id, match_id, category);
