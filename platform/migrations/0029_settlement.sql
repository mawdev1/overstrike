-- 0029 — P3-04 settlement.  contracts/settlement.md §0 item 1, §7.3.
--
-- Three amendments settlement.md §0 asks of `db-schema.md` (FROZEN, so the amendment lands
-- here rather than editing 0004/0012/0013 in place), plus the new `settlement_exceptions`
-- table settlement.md §7.3 specifies. All four are additive: no existing row for mode 'tdm' or
-- 'bomb' changes shape or meaning, and every CHECK below reduces to exactly its prior
-- expression when `mode <> 'extraction'`.
--
-- A fourth amendment beyond what settlement.md §0 item 1.3 names explicitly: that item only
-- flags `team_scores`/`rounds` as needing an extraction disjunct in the terminal-completeness
-- CHECK. `extraction-match.md` §5.1/§6 (the actual `RunResult` producer, read against this
-- migration per this work item's brief) supplies no `rulesetVersion`, no
-- `statDefinitionVersion`, and no `mapVersion` — a run has no ruleset to snapshot and no stat
-- definition version, and its sector set (not a single map) is what `RunResult.sectorSet`
-- carries instead. Requiring those three columns non-null on a terminal extraction row would
-- block every real run from ever reaching `completed`/`aborted`, which is the kind of
-- day-one-blocking gap `db-schema.md` §4's own note says these CHECKs exist to catch rather
-- than hide. Recorded here rather than assumed silently, per the posture settlement.md §0
-- already takes toward its other two open items.

-- ── 1. matches.mode: 'extraction' joins the enum ────────────────────────────────────────────
alter table matches drop constraint matches_mode_enum;
alter table matches add constraint matches_mode_enum check (mode in ('tdm', 'bomb', 'extraction'));

-- ── 2. matches_outcome_matrix: an extraction disjunct ───────────────────────────────────────
-- settlement.md §2: outcome_reason/winner_team/invalidation_reason stay null for a run at every
-- status — there is no team and no single winner, and a run is never invalidated in this
-- version. The PvP branches (the `case status when …` below) are untouched.
alter table matches drop constraint matches_outcome_matrix;
alter table matches add constraint matches_outcome_matrix check (
  case when mode = 'extraction' then
    -- No team and no single winner (settlement.md §2); ended_at's non-null-on-terminal
    -- requirement is matches_terminal_complete's job below, not restated here.
    outcome_reason is null
    and winner_team is null
    and invalidation_reason is null
  else
    case status
      when 'completed' then
        termination_reason = 'completed'
        and outcome_reason is not null
        and outcome_reason in ('elimination', 'defuse', 'detonation', 'timer')
        and winner_team is not null
        and winner_team in ('alpha', 'bravo', 'draw')
        and invalidation_reason is null
        and ended_at is not null
      when 'aborted' then
        termination_reason = 'aborted'
        and outcome_reason is not null
        and outcome_reason in ('forfeit', 'abandon', 'no-contest')
        and (case
               when outcome_reason = 'no-contest' then winner_team is null
               else winner_team is not null and winner_team in ('alpha', 'bravo')
             end)
        and invalidation_reason is null
        and ended_at is not null
      when 'invalidated' then
        termination_reason = 'invalidated'
        and outcome_reason = 'no-contest'
        and winner_team is null
        and invalidation_reason is not null
        and invalidation_reason in ('cheat-detected', 'server-fault', 'roster-fault', 'admin-review')
        and ended_at is not null
      else
        termination_reason is null
        and outcome_reason is null
        and winner_team is null
        and invalidation_reason is null
    end
  end
);

-- ── 3. matches_terminal_complete / matches_nonempty_text: an extraction disjunct ────────────
-- team_scores/rounds are settlement.md §2's deliberate nulls for a run (no per-run shape).
-- ruleset_version/stat_definition_version/map_version are this migration's own extension of
-- that reasoning (see header) — extraction-match.md's RunResult supplies none of the three.
-- What a run DOES supply and must still satisfy non-null/non-empty: server_build, map_id,
-- region, started_at, ended_at, evidence_ref.
alter table matches drop constraint matches_terminal_complete;
alter table matches add constraint matches_terminal_complete check (
  status not in ('completed', 'aborted', 'invalidated')
  or (
    case when mode = 'extraction' then
      server_build is not null
      and map_id     is not null
      and region      is not null
      and started_at  is not null
      and ended_at    is not null
      and evidence_ref is not null
    else
      ruleset_version         is not null
      and stat_definition_version is not null
      and server_build        is not null
      and map_id              is not null
      and map_version         is not null
      and region              is not null
      and started_at          is not null
      and ended_at            is not null
      and team_scores         is not null
      and rounds               is not null
      and evidence_ref        is not null
    end
  )
);

alter table matches drop constraint matches_nonempty_text;
alter table matches add constraint matches_nonempty_text check (
  status not in ('completed', 'aborted', 'invalidated')
  or (
    case when mode = 'extraction' then
      length(trim(server_build)) > 0
      and length(trim(map_id)) > 0
      and length(trim(region)) > 0
      and length(trim(evidence_ref)) > 0
    else
      length(trim(ruleset_version)) > 0
      and length(trim(stat_definition_version)) > 0
      and length(trim(server_build)) > 0
      and length(trim(map_id)) > 0
      and length(trim(map_version)) > 0
      and length(trim(region)) > 0
      and length(trim(evidence_ref)) > 0
    end
  )
);

-- ── 4. settlement_exceptions.  settlement.md §7.3, verbatim ─────────────────────────────────
create table settlement_exceptions (
  exception_id     text primary key,
  run_id           text not null references matches (match_id),
  -- null iff run-level (settlement.md §7.1's last row), not participant-level.
  account_id       text references accounts (account_id),
  trigger          text not null,
  status           text not null default 'open' check (status in ('open', 'in-review', 'resolved')),
  opened_at        timestamptz not null default now(),
  opened_by        text not null,
  evidence_snapshot jsonb not null,
  assigned_to      text,
  reviewed_at      timestamptz,
  reviewed_by      text,
  resolution       text check (resolution in ('settle-as-extracted', 'settle-as-died', 'settle-as-aborted', 'void')),
  resolution_notes text,
  resolution_evidence_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger settlement_exceptions_updated_at before update on settlement_exceptions
  for each row execute function set_updated_at();

create index settlement_exceptions_open_idx on settlement_exceptions (status) where status <> 'resolved';
create index settlement_exceptions_run_idx on settlement_exceptions (run_id);
