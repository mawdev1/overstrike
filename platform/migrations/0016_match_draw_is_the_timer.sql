-- 0016 — a draw is the regulation timer expiring, and nothing else.
--   contracts/match-result.md §4.1/§4.2, contracts/bomb-rules.md §2.1a.
--
-- 0012 put the §4.0 matrix in the table and permitted `winner_team = 'draw'` beside any of the
-- four completed outcome reasons. Three of those reasons — elimination, defuse, detonation —
-- each name a side that won the round that ended the match, so the row said a match could be
-- simultaneously decided and drawn. §4.1 is explicit that `winnerTeam` is `draw` "when
-- regulation ends 6-6", and bomb-rules §2.1a is explicit that there is no overtime in Alpha, so
-- the timer is the only way a completed match has no winner.
--
-- The consequence of leaving it open is not cosmetic: `resultFor()` maps `draw` to a career
-- draw, so a result claiming a draw by detonation mints a draw for every player in a match that
-- someone actually won, and no later reconciliation can tell which it was.
--
-- The application validator (core/store.js `matchOutcomeProblems`) enforces the same rule. That
-- is not a reason to leave the table permissive, for the reason 0012 gives at length: a
-- migration, a backfill or a second service writes rows the application never sees.

alter table matches
  add constraint matches_draw_is_the_timer check (
    winner_team is distinct from 'draw'
    or outcome_reason = 'timer'
  );
