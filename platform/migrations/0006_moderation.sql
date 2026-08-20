-- 0006 — reports and sanctions.  contracts/db-schema.md §6.

create table reports (
  report_id          text primary key,
  reporter_account_id text not null references accounts (account_id),
  subject_account_id  text not null references accounts (account_id),
  match_id           text references matches (match_id),
  category           text not null,
  description        text,
  evidence_ref       text,
  status             text not null default 'open'
                       check (status in ('open','triaged','actioned','dismissed','duplicate')),
  resolution         text,
  resolved_by        text,
  resolved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- A reporter filing the same subject for the same match twice is a duplicate, not two
  -- signals; counting it twice inflates exactly the metric that triggers review.
  constraint reports_no_duplicate unique (reporter_account_id, subject_account_id, match_id, category)
);

create trigger reports_updated_at before update on reports
  for each row execute function set_updated_at();

create index reports_open_idx on reports (status, created_at) where resolved_at is null;

-- Sanctions are never deleted. Lifting sets lifted_at. Sanction history is the input to
-- progressive review, and a deleted sanction resets a repeat offender to a first offence.
create table sanctions (
  sanction_id   text primary key,
  account_id    text not null references accounts (account_id),
  kind          text not null check (kind in ('warn','mute','restrict','ban')),
  reason_code   text not null,
  issued_by     text not null,
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz,                -- null = indefinite
  lifted_at     timestamptz,
  lifted_by     text,
  appeal_status text,
  evidence_ref  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger sanctions_updated_at before update on sanctions
  for each row execute function set_updated_at();

-- The enforcement question is always "what is live for this account right now", so index that
-- and not the whole history.
create index sanctions_active_idx on sanctions (account_id, kind) where lifted_at is null;
