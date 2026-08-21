-- Canonical match evidence is retained under the digest carried by the terminal result.
-- It is deliberately append-only: changing or deleting the body would make evidence_ref
-- resolve to a different truth after the match result and career application had committed.
create table if not exists match_evidence (
  match_id text primary key references matches(match_id) on delete restrict,
  evidence_ref text not null unique check (evidence_ref ~ '^sha256:[0-9a-f]{64}$'),
  evidence jsonb not null,
  created_at timestamptz not null default now()
);

create or replace function reject_match_evidence_mutation()
returns trigger language plpgsql as $$
begin
  raise sqlstate '23001' using message = 'match_evidence is append-only';
end;
$$;

drop trigger if exists match_evidence_append_only on match_evidence;
create trigger match_evidence_append_only
before update or delete on match_evidence
for each row execute function reject_match_evidence_mutation();
