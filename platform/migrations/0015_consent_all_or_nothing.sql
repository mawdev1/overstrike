-- 0015 — a consent decision is whole or it does not exist.  db-schema.md §2, http-api.md §3a.3.
--
-- The three consent columns are one record split across three nullable columns, and nothing
-- said they move together. So `consent_telemetry = true, consent_policy_ver = null` was a legal
-- row — a recorded "yes" to no policy, at no time.
--
-- That row is not merely untidy: §4 types the profile field as
-- `{ telemetryPersonal, policyVersion, decidedAt } | null`, an exact union with no partial
-- member. `projectConsent` keys off `consent_telemetry` alone, so a half-written row serialises
-- as an object whose `policyVersion` is null — a shape the contract does not have, handed to a
-- client that has no branch for it. And a consent record that cannot say which policy was
-- agreed, or when, is worthless in the one situation it exists for.
--
-- The application writes all three together today. This is the defence that survives a
-- backfill, an admin console, or the next writer — the same argument 0012 and 0013 make.
--
-- Numbered 0015 deliberately: another lane may land 0014, and the runner refuses to apply a
-- migration older than one already applied rather than silently interleaving them.

alter table accounts
  -- 0 = undecided (null means UNDECIDED, which is not a recorded "no" — db-schema.md §2),
  -- 3 = a complete decision. There is nothing in between for the union to serialise.
  add constraint accounts_consent_all_or_nothing check (
    num_nonnulls(consent_telemetry, consent_policy_ver, consent_decided_at) in (0, 3)
  );
