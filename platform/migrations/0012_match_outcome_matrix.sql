-- 0012 — the §4.0 outcome matrix and result_applied_at, at the database level.
--   contracts/match-result.md §4.0/§4.2, contracts/db-schema.md §4.
--
-- 0004 declared `status`, the four outcome columns and `result_applied_at`, and constrained
-- exactly one of them (`winner_team`'s enum). Everything else the matrix says — that a completed
-- match has a winner, that an abort is never a draw, that a no-contest carries none, that only
-- an invalidated match has an invalidation reason, that `termination_reason` repeats the status
-- — was left to whichever writer got there first. A row that satisfies none of it is
-- uninterpretable: the detail endpoint cannot render it and the career recompute cannot decide
-- whether it aggregates.
--
-- The adapters validate this too (core/store.js `normaliseMatchResult`). That is not a reason to
-- leave the table permissive: application validation protects the rows an application writes,
-- and a migration, a backfill, an admin console or a second service writes rows it never sees.
--
-- NULL-safety matters more than usual here. `x in (…)` is NULL, not false, when x is NULL, and a
-- CHECK passes on NULL — so every enum test is paired with `is not null` rather than trusting
-- the IN to reject a missing value.

alter table matches add constraint matches_outcome_matrix check (
  case status

    -- completed: a real outcome, a real winner (draw included), no invalidation reason.
    when 'completed' then
      termination_reason = 'completed'
      and outcome_reason is not null
      and outcome_reason in ('elimination', 'defuse', 'detonation', 'timer')
      and winner_team is not null
      and winner_team in ('alpha', 'bravo', 'draw')
      and invalidation_reason is null
      and ended_at is not null

    -- aborted: a forfeit or an abandon is an abort WITH a winner (wire-protocol.md §8.9); a
    -- no-contest has none. An abort is never a draw.
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

    -- invalidated: a review decision. No winner at all, and a reason from the closed enum.
    when 'invalidated' then
      termination_reason = 'invalidated'
      and outcome_reason = 'no-contest'
      and winner_team is null
      and invalidation_reason is not null
      and invalidation_reason in ('cheat-detected', 'server-fault', 'roster-fault', 'admin-review')
      and ended_at is not null

    -- allocated / in-progress: the outcome is not known yet, so carrying one is a row that
    -- contradicts the status sitting beside it. `ended_at` is deliberately unconstrained: a
    -- match that has ended and whose result is still queued is exactly this state (§4.2).
    else
      termination_reason is null
      and outcome_reason is null
      and winner_team is null
      and invalidation_reason is null
  end
);

-- `result_applied_at` answers "did the career application commit". A match that has not
-- finalised has nothing to apply, so a stamp on one is a claim about work that cannot have
-- happened.
alter table matches add constraint matches_result_applied_after_terminal check (
  result_applied_at is null
  or status in ('completed', 'aborted', 'invalidated')
);
