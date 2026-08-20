-- 0017 — make the §8 idempotency retention expressible, and give the sweep an index to use.
--
-- http-api.md §8: "Retention: 24 h for gameplay, permanent for value-bearing operations."
--
-- Two halves of that sentence were unimplementable against this table:
--
--   1. Nothing ever deleted on `expires_at`. Every writer stamped it — profile PATCH replays,
--      match results, and the burnt eligibility-receipt nonces `auth/service.js` records here
--      because there is no `eligibility_receipts` table — and the column was then never read
--      again by anything. A retention window nothing enforces is a column, not a policy, and
--      the nonce rows in particular are onboarding evidence retained forever by omission.
--      The sweep is `store.idempotency.sweepExpired`, run hourly by the composition root.
--
--   2. `expires_at` was NOT NULL, so the "permanent" class could not be written down at all.
--      A value-bearing operation would have had to invent a sentinel far-future timestamp,
--      which the sweep would eventually honour and delete. NULL now means permanent, and the
--      sweep skips it explicitly (`expires_at is not null and expires_at <= $1`).
--
-- P1 has no value-bearing endpoints, so no row is permanent yet. The point is that the first
-- one can say so, rather than discovering at P8 that the schema has no way to.
--
-- Idempotent: both statements are conditional on the state they change, so re-running the
-- migrator is a no-op.

alter table idempotency_keys alter column expires_at drop not null;

-- The 0005 index is on the whole column. The sweep only ever asks for non-null rows, and a
-- partial index is both smaller and the one the planner can use for exactly that predicate.
create index if not exists idempotency_keys_sweep_idx
  on idempotency_keys (expires_at) where expires_at is not null;
