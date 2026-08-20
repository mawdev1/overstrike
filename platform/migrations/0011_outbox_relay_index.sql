-- 0011 — an index the relay's actual query can use.  event-envelope.md §3, §4.
--
-- The relay runs, every poll:
--
--   select * from events_outbox
--    where published_at is null and dead_lettered_at is null
--    order by occurred_at, event_id
--    limit $1 [for update skip locked]
--
-- 0005's `events_outbox_unpublished_idx on (published_at) where published_at is null` cannot
-- serve it. The indexed column is a constant across the whole partial index, so it carries no
-- ordering, and the dead-lettered rows are not excluded. EXPLAIN shows a bitmap scan of every
-- unpublished row followed by a top-N heapsort — work proportional to the backlog, on every
-- poll, which is worst exactly when the relay is behind and the backlog is large. Dead-letters
-- never clear, so that floor rises permanently.
--
-- Indexing the ORDER BY key under the full predicate turns the poll into an index scan of the
-- first N entries: bounded by the page size instead of by the backlog.

create index if not exists events_outbox_relay_idx
  on events_outbox (occurred_at, event_id)
  where published_at is null and dead_lettered_at is null;

-- The old index has no remaining query: it only ever answered this one, worse. Keeping it
-- costs an extra write on every outbox insert and update for nothing.
drop index if exists events_outbox_unpublished_idx;
