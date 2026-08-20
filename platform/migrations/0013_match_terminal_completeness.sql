-- 0013: a terminal match row must be COMPLETE, and `mode` must be a mode we ship.
--
-- 0012 put the §4.0 outcome matrix in the table and stopped there, constraining four columns.
-- Its own header says it exists to protect against "a migration, a backfill, an admin console
-- or a second service" — and those writers could still insert a `completed` match with a null
-- ruleset_version, a null evidence_ref, no team_scores, no rounds, and `mode = 'chess'`.
-- `stats.getMatch` then rendered that row as a §4.2 TerminalResult, so the union's guarantee
-- held only for rows the application happened to write.
--
-- The application validator is correct today; this is the defence that survives the day
-- something writes around it.

alter table matches
  -- Every §4.2 key that is required on a terminal row and merely absent on an allocated one.
  -- Written as an implication so allocated/in-progress rows are unaffected: the constraint
  -- says nothing at all until the row claims to be terminal.
  add constraint matches_terminal_complete check (
    status not in ('completed', 'aborted', 'invalidated')
    or (
      ruleset_version         is not null
      and stat_definition_version is not null
      and server_build        is not null
      and map_id              is not null
      and map_version         is not null
      and region              is not null
      and started_at          is not null
      and ended_at            is not null
      and team_scores         is not null
      and rounds              is not null
      and evidence_ref        is not null
    )
  );

alter table matches
  -- §4 fixes the mode union at the two modes the Alpha freeze ships. Without this the column
  -- is free text, and a row reading `mode = 'chess'` projects as a valid TerminalResult.
  add constraint matches_mode_enum check (mode in ('tdm', 'bomb'));

alter table matches
  -- Empty string is not a value; it is a null wearing a disguise, and it passes every
  -- `is not null` test above.
  add constraint matches_nonempty_text check (
    status not in ('completed', 'aborted', 'invalidated')
    or (
      length(trim(ruleset_version)) > 0
      and length(trim(stat_definition_version)) > 0
      and length(trim(server_build)) > 0
      and length(trim(map_id)) > 0
      and length(trim(map_version)) > 0
      and length(trim(region)) > 0
      and length(trim(evidence_ref)) > 0
    )
  );
