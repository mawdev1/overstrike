-- 0010 — profiles.legacy_import.  profile/migration.js, match-result.md §6.
--
-- The one-time import of the offline progression blob writes a `legacyImport` record on the
-- profile. There was no column for it: the memory adapter rejected the write as an unknown
-- column, and Postgres discarded it — the upsert only ever named roaming_settings and
-- settings_version, so the field vanished without an error and `getLegacyImport` returned null
-- forever. A silent discard is the worse of the two failures, because the import then runs
-- again on every request and always reports itself as the first one.
--
-- jsonb and not typed columns, deliberately: this is CLIENT-AUTHORED data (it was writable
-- from a devtools console for the whole offline alpha) that is never promoted into
-- player_stats. It is displayed as "carried over from offline play" and nothing else, so it
-- needs no constraints, no indexes, and no migration when the blob's shape changes.

alter table profiles add column if not exists legacy_import jsonb;

comment on column profiles.legacy_import is
  'One-time import of the client-side progression blob. Unverified client data; never '
  'aggregated into player_stats, never authoritative in a dispute (profile/migration.js).';
