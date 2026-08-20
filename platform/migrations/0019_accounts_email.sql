-- 0019 — store the email address, because this platform IS the identity provider.
--   db-schema.md §2, auth.md §3, contracts/telemetry.md privacy classes.
--
-- 0001 stores `email_hash` and says, in a comment, "the address itself lives with the auth
-- provider". That was true of the plan: decision D1 chose Supabase Auth, and `password_hash`
-- exists in 0001 only "so a self-hosted fallback does not need a schema change".
--
-- The fallback is what shipped. Signup writes a scrypt hash into `password_hash`, signin
-- verifies it, sessions are minted here. There is no external provider, so the address is held
-- by nobody, and every transactional mail this platform owes a player has no recipient:
--
--   - verification RESEND (auth.md §3) had only an accountId to work from, so the one action a
--     player takes when the first message never arrived could not send a second one.
--   - any future security notice — "your password was changed", "a new device signed in" —
--     has the same problem, and those are the messages an account system must be able to send.
--
-- Signup and recovery-start happened to work only because the address was in the request body
-- at that moment. That is not storage; it is a value passing through.
--
-- ── Privacy ─────────────────────────────────────────────────────────────────────────────
-- This column is PERSONAL class. It is deliberately NOT added to any projection: §11.8 closes
-- `/v1/profile/me` to five keys and this is not one of them, `audit_log` records actor ids
-- rather than addresses, and the events in `events_outbox` carry account ids. It is readable
-- by the platform to address a message, and by nothing else.
--
-- Retention follows the account: deleting an account deletes the row that holds this. There is
-- no separate lifetime to forget to enforce.
--
-- `email_hash` STAYS and stays unique. It remains the lookup and uniqueness key, so the
-- address is never the thing an attacker enumerates against, and a case or unicode variation
-- cannot create a second account — the hash is computed over the normalised form.

alter table accounts add column if not exists email text;

comment on column accounts.email is
  'PERSONAL class (telemetry.md). The address transactional mail is sent to. Lookup and '
  'uniqueness use email_hash, never this column. Never projected into an API response.';
