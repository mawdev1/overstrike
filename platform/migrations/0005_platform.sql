-- 0005 — outbox, audit, idempotency, flags.  contracts/db-schema.md §5.

-- The transactional outbox (event-envelope.md §4). Rows are written in the same transaction
-- as the state change they describe, so there is no window in which the change happened and
-- the event did not.
create table events_outbox (
  event_id        text primary key,
  event_type      text not null,
  event_version   int not null default 1,
  -- Ordering key. Delivery is ordered per subject, not globally (event-envelope.md §3).
  subject_kind    text not null,
  subject_id      text not null,
  correlation_id  text,
  causation_id    text,
  actor           jsonb,
  payload         jsonb not null default '{}',
  privacy_class   text not null default 'internal'
                    check (privacy_class in ('public','internal','personal','sensitive')),
  retention_class text not null default 'standard'
                    check (retention_class in ('short','standard','audit','financial')),
  -- REQ-CC-019: the envelope requires schema_ref on the wire, so it must be storable rather
  -- than re-derived at publish time from a type/version pair that may since have moved.
  schema_ref      text not null,
  occurred_at     timestamptz not null default now(),
  recorded_at     timestamptz not null default now(),
  published_at    timestamptz,                     -- null = not yet relayed
  attempts        int not null default 0,
  last_error      text,
  dead_lettered_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create trigger events_outbox_updated_at before update on events_outbox
  for each row execute function set_updated_at();

-- Partial index: this is what keeps the relay's poll cheap once the table holds millions of
-- published rows. A full index on published_at would be scanned past all of them.
create index events_outbox_unpublished_idx on events_outbox (published_at)
  where published_at is null;

create index events_outbox_subject_idx on events_outbox (subject_kind, subject_id, occurred_at);

create table audit_log (
  audit_id       text primary key,
  actor_kind     text not null,
  actor_id       text,
  actor_role     text,
  action         text not null,
  subject_kind   text not null,
  subject_id     text not null,
  -- NOT NULL on purpose: an unexplained privileged action is a defect, and a nullable reason
  -- code is a column that is empty exactly when it matters.
  reason_code    text not null,
  before_summary jsonb,
  after_summary  jsonb,
  correlation_id text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index audit_log_subject_idx on audit_log (subject_kind, subject_id, created_at desc);
create index audit_log_actor_idx on audit_log (actor_id, created_at desc);
-- No updated_at trigger here: nothing updates audit_log. 0007 enforces that.

create table idempotency_keys (
  key             text not null,
  actor_id        text not null,
  -- The hash is what makes the key safe. Without it, a client reusing one key for a different
  -- request gets the previous response back and never learns its second request was dropped.
  request_hash    text not null,
  response_status int,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  primary key (key, actor_id)
);

create trigger idempotency_keys_updated_at before update on idempotency_keys
  for each row execute function set_updated_at();

create index idempotency_keys_expiry_idx on idempotency_keys (expires_at);

create table feature_flags (
  flag_key       text primary key,
  enabled        boolean not null default false,
  rollout        jsonb,
  -- A kill switch is operationally different from a rollout flag: it is flipped under
  -- pressure and must never be gated behind a percentage.
  is_kill_switch boolean not null default false,
  updated_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create trigger feature_flags_updated_at before update on feature_flags
  for each row execute function set_updated_at();
