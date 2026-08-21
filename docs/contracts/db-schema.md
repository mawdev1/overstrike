# Contract 11 — Database schema

| | |
|---|---|
| **Status** | `FROZEN` — amendments follow CHANGELOG.md |
| **Version** | 2.1.0 |
| **Engine** | PostgreSQL — **Supabase, primary region `ca-central-1` (Toronto)** (D2) |
| **Owner** | [CC] Claude Code |
| **Scope** | P1–P5. Economy, ownership, creator, and agent tables are later contracts |

---

## 0. Host and topology (D2)

**Supabase Postgres, primary region `ca-central-1` (Toronto).** Reasoning in
[`../decisions/P0-decisions.md`](../decisions/P0-decisions.md) §D2; the short form is that the
roadmap's entire compliance frame is Ontario (AGCO, FINTRAC, OPC, CRA), and keeping player
personal data resident in Canada removes a cross-border transfer question from the P5 privacy
review before it is asked. It is also far more expensive to fix after launch than to choose now.

**Match servers are a separate decision and stay on Fly**, regional and independent of the
database — initially `yyz`, `ord`, `iad`, expanding by *measured* demand rather than by
guessing at a map.

That split is deliberate. Match servers are latency-bound and must sit near players; the
database is consistency-bound and must sit in one place. Coupling them forces one into the
wrong location.

**This costs gameplay nothing**, because Build Plan §2.2 already forbids a database round trip
inside the tick. A 40 ms Toronto round trip from an `iad` match server is irrelevant precisely
because gameplay never waits on it. Anything that would make that latency matter is a design
error, not a hosting problem.

Identity lives in the same database (D1, Supabase Auth), so the `accounts` ↔ `sessions` ↔
`player_stats` joins below stay inside one engine instead of spanning a vendor boundary.

## 1. Principles

1. **Forward-only migrations.** Versioned, rehearsed on staging, never edited after merge.
2. **No destructive deletes on anything auditable.** Status columns and soft deletes; a row
   that vanishes takes its history with it.
3. **`created_at` and `updated_at` on every table**, UTC, database-generated.
4. **ULIDs as primary keys**, stored as `text` (26 chars) or `bytea`. Time-sortable, so an
   index scan is roughly chronological and pagination is stable — unlike UUIDv4.
5. **Money and value-bearing quantities are never floats.** `numeric`, always. (Relevant from
   P8; stated now so nobody sets the precedent.)
6. **Foreign keys are declared.** Referential integrity in the application layer is
   referential integrity that is one bug away from absent.
7. **The analytics workload never touches these tables.** It reads the event stream and the
   warehouse (`event-envelope.md`).

## 2. Identity

```sql
accounts(
  account_id        text primary key,
  status            text not null default 'active',   -- active|restricted|banned|deleted
  email_hash        text unique,          -- lookup and uniqueness; never the address itself
  email             text,                 -- PERSONAL. Transactional mail only (migration 0019)
  display_name      text not null,
  -- Credentials and authorisation. `password_hash` is null when identity is delegated to the
  -- provider (D1, Supabase Auth); it exists so a self-hosted fallback does not need a schema
  -- change, and so the column is never invented ad hoc at the write site.
  password_hash     text,
  identity_provider text,                -- `supabase` in production; null for local test only
  identity_subject  text,                -- opaque provider user id; never a provider token
  roles             text[] not null default '{player}',
  name_changed_at   timestamptz,
  display_name_folded text not null unique,  -- NFKC + case + confusable folding (auth.md §9)
  -- Onboarding state, typed rather than free JSON (REQ-CC-022). These gate access and
  -- carry legal weight; a jsonb blob cannot be constrained, indexed, or migrated safely.
  eligibility_verdict     boolean,
  eligibility_policy_ver  int,
  eligibility_decided_at  timestamptz,
  email_verified_at       timestamptz,
  terms_version_accepted  int,
  terms_accepted_at       timestamptz,
  consent_telemetry       boolean,          -- null = undecided
  consent_policy_ver      int,
  consent_decided_at      timestamptz,
  privacy           jsonb not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
)

`identity_provider` and `identity_subject` are an all-or-nothing pair and unique together.
Production rows use that pair and keep `password_hash` null. The non-production local-test
provider does the inverse. No API projection, event, or audit summary exposes either credential
field.

account_name_history(account_id, previous_name, changed_at, changed_by, reason)

-- Signed-out consent, before an account exists (http-api.md §3a.3). 30-day TTL, deleted on
-- migration at signup. Never joined to an account except by the receipt presented at signup.
pre_auth_consent(
  client_session_id text primary key,
  telemetry_personal boolean not null,
  policy_version     int not null,
  decided_at         timestamptz not null,
  expires_at         timestamptz not null,
  migrated_at        timestamptz          -- always null; see below
)

sessions(
  session_id text primary key, account_id text references accounts,
  device_label text, user_agent_class text, ip_class text,   -- CLASS, never a raw address
  created_at timestamptz, last_seen_at timestamptz,
  revoked_at timestamptz, revoked_reason text,
  refresh_family_id text not null      -- rotation family; reuse revokes the whole family
)
```

**No birthdate column, deliberately.** The eligibility preflight (`http-api.md` §3a.1)
evaluates a date of birth and discards it; only the verdict, its policy version, and the
decision time are stored. The most sensitive field in the funnel is never persisted, which is
also the cheapest possible answer to a deletion request about it.

`consent_telemetry` is nullable because **null means undecided**, which is distinct from a
recorded "no". An account predating the policy has no decision, and is treated as no consent
until it makes one.

**`pre_auth_consent.migrated_at` is always null (1.6.0).** The §3a.3 lifecycle is a DELETE —
"deleted on migration at signup, or on expiry" — and the application implements exactly that:
signup removes the row inside the same transaction that writes the decision onto the account,
and a janitor removes the rows that expire without one. The column was written by an earlier
implementation that stamped it and kept the row, which reads as absent and retains as present;
for a consent record those are not the same thing. The column and its partial index survive
because dropping a column is a CCR, and because forcing it to null on every write keeps a row
arriving from a backfill with a stamp on it from making a live decision read as already-carried.
No writer sets it.

`roles` is on the account rather than a join table because P1 has seven fixed roles and no
role metadata; a join table would be three queries to answer a question one column answers.
It becomes a table when roles gain scopes or expiry, not before.

`name_changed_at` backs the 30-day cooldown in `auth.md` §9. Deriving it from
`account_name_history` would work until the first account that has never renamed, which has no
row to derive from.

`display_name_folded` carries the uniqueness constraint, not `display_name`. Enforcing on the
raw name lets `Ada` and `Аdа` (Cyrillic А) coexist, which is the cheapest impersonation attack
available and lands squarely on a game that later has a marketplace.

`ip_class` is a region, not an address — per `auth.md` §3, a session list is readable by
whoever holds the account, including someone who just stole it.

## 3. Profile and stats

```sql
profiles(account_id primary key references accounts,
         roaming_settings jsonb, settings_version int not null default 1, updated_at)

player_stats(
  account_id text references accounts,
  mode text not null,                    -- tdm|bomb
  stat_definition_version text not null, -- match-result.md §4
  kills bigint, deaths bigint, assists bigint, suicides bigint, team_kills bigint,
  headshots bigint, shots_fired bigint, shots_hit bigint, damage_dealt bigint,
  plants bigint, defuses bigint,
  matches bigint, wins bigint, losses bigint, draws bigint,   -- draws: REQ-CC-019
  rounds_played bigint, time_played_sec bigint,
  updated_at timestamptz,
  primary key (account_id, mode, stat_definition_version)
)

player_weapon_stats(account_id, mode, weapon_id, stat_definition_version,
                    shots, hits, kills, headshots,
                    primary key (account_id, mode, weapon_id, stat_definition_version))
```

`draws` exists because the HTTP career surface returns it and Bomb can genuinely draw at 6-6
(`bomb-rules.md` §2.1a). A returned field with no column is a field that reads zero forever.

`stat_definition_version` is part of the weapon-stats key for the same reason it is part of
`player_stats`: a definition change must not silently rewrite historical per-weapon accuracy.

**Counters only. No stored ratios.** K/D, accuracy, and win rate are computed at read time;
a stored ratio goes stale and then disagrees with its own inputs, and only one of the two is
right.

`stat_definition_version` in the key is what lets definitions change without silently
rewriting history (`match-result.md` §4).

## 4. Rooms and matches

```sql
rooms(room_id primary key, owner_account_id, region, map_id, mode, capacity,
      status,           -- open|countdown|in-progress|closing|destroyed
      settings jsonb, created_at, updated_at, destroyed_at, destroyed_reason)

room_members(room_id, account_id, team, ready, loadout jsonb,
             joined_at, left_at, primary key (room_id, account_id))

chat_messages(
  message_id primary key, room_id references rooms, sender_account_id references accounts,
  text, created_at, expires_at,
  removed_at, removed_by, removal_reason,
  check (removal metadata is either all null or all present)
)
create index on chat_messages(expires_at) where removed_at is null;
create index on chat_messages(room_id, created_at);

-- reports adds nullable chat_message_id references chat_messages(message_id). The duplicate
-- incident key is (reporter,subject,match_id,chat_message_id,category) NULLS NOT DISTINCT.
-- The runtime verifies sender==subject and historical room membership at message time.

match_servers(server_id primary key, region, address, capacity, in_use,
              status,          -- registering|healthy|draining|unhealthy|gone
              build, last_heartbeat_at)

match_tickets(
  jti primary key, account_id references accounts, room_id references rooms,
  match_id references matches, expires_at, consumed_at null, created_at
)
-- Admission is a single atomic UPDATE where consumed_at is null and expires_at > now.
-- The HMAC is only the portable claim envelope; this durable row is the replay authority,
-- so a game-server restart or two concurrent verifiers cannot reuse the same jti.
-- Both consumed and never-consumed rows are deleted 24 hours after expires_at. `consumed_at`
-- is the sole one-way state transition: ticket rows are immutable admission receipts rather
-- than mutable domain records, so the ordinary updated_at rule does not apply.

matches(
  match_id primary key, room_id, region, server_id,
  map_id, map_version, mode, ruleset_version, stat_definition_version, server_build,
  status,               -- allocated|in-progress|completed|aborted|invalidated
  termination_reason text, outcome_reason text, invalidation_reason text,
  winner_team text,     -- 'alpha'|'bravo'|'draw'|null — null is NOT draw (match-result.md §4.0)
  rules_snapshot jsonb not null,   -- immutable ruleset copy; a result without it is
                                   -- uninterpretable once the ruleset is retuned
  team_scores jsonb, rounds jsonb, evidence_ref text,
  allocated_at, started_at, ended_at, result_applied_at,

  -- The match-result.md §4.0 outcome matrix, as CHECK constraints. Migrations 0012, 0013, 0016.
  check (status in ('allocated','in-progress','completed','aborted','invalidated')),
  -- termination_reason repeats status on a terminal row, and is null before one.
  check (status in ('allocated','in-progress') = (termination_reason is null)),
  -- outcome_reason is closed per status; a non-terminal row carries none.
  check (
    (status in ('allocated','in-progress') and outcome_reason is null and winner_team is null)
    or (status = 'completed' and outcome_reason in ('elimination','defuse','detonation','timer'))
    or (status = 'aborted'   and outcome_reason in ('forfeit','abandon','no-contest'))
    or (status = 'invalidated' and outcome_reason = 'no-contest')),
  -- A DRAW is the regulation timer expiring and nothing else (0016).
  check (winner_team is distinct from 'draw' or outcome_reason = 'timer'),
  -- forfeit/abandon carry a winner; no-contest and invalidation carry none.
  check (outcome_reason not in ('forfeit','abandon') or winner_team in ('alpha','bravo')),
  check (outcome_reason <> 'no-contest' or winner_team is null),
  -- invalidation_reason is non-null from the enum iff the row is invalidated.
  check ((status = 'invalidated') = (invalidation_reason is not null)),
  check (invalidation_reason is null
         or invalidation_reason in ('cheat-detected','server-fault','roster-fault','admin-review')),
  -- A terminal row is COMPLETE (0013): every §4.2 key required on one is non-null and
  -- non-blank — ruleset_version, stat_definition_version, server_build, map_id, map_version,
  -- region, started_at, ended_at, team_scores, rounds, evidence_ref.
  check (status in ('allocated','in-progress')
         or (started_at is not null and ended_at is not null
             and team_scores is not null and rounds is not null and evidence_ref is not null)),
  check (mode in ('tdm','bomb')),
  -- Nothing has been applied to a career before the match finalised (0012).
  check (result_applied_at is null or status in ('completed','aborted','invalidated'))
)

match_participants(match_id, account_id, team, joined_at, left_at,
                   disconnected bool, abandoned bool, stats jsonb,
                   primary key (match_id, account_id))
```

`matches` rows are created at **allocation**, not completion — a match that dies before its
first tick still has an id, which is the only way the crash is attributable
(`match-result.md` §4).

**The `matches` CHECK constraints are the §4.0 union, not a suggestion (REQ-CC-044).** They were
in the migrations and not in this contract, so the schema published here permitted rows the
canonical union forbids — a completed match carrying an invalidation reason, a drawn
elimination, an aborted no-contest with a winner, a terminal row with no `ended_at`. A reader
generating a fixture from this section produced data the database would refuse. The application
validates the same rules in one shared function (`core/store.js`) before writing; the constraints
are the backstop for everything that reaches the table another way — a repair script, a backfill,
a psql session at 2am.

`match_participants.stats` is `jsonb` deliberately: the stat set evolves per mode and per
definition version, and a wide sparse column-per-stat table would need a migration for every
new mode. Career aggregates in §3 are typed columns; the per-match record is a document.

## 5. Platform infrastructure

```sql
events_outbox(
  event_id primary key, event_type, event_version int,
  subject_kind, subject_id,          -- ordering key (event-envelope.md §3)
  correlation_id, causation_id,
  actor jsonb, payload jsonb,
  privacy_class, retention_class,
  schema_ref text not null,          -- REQ-CC-019: event-envelope.md §2 requires it on the wire,
                                     -- so it must be storable, not re-derived at publish time
  occurred_at, recorded_at,
  published_at timestamptz,          -- null = not yet relayed
  attempts int default 0, last_error text, dead_lettered_at timestamptz
)
create index on events_outbox (published_at) where published_at is null;
create index on events_outbox (subject_kind, subject_id, occurred_at);

audit_log(
  audit_id primary key, actor_kind, actor_id, actor_role,
  action, subject_kind, subject_id,
  reason_code text not null,         -- NOT NULL: an unexplained privileged action is a defect
  before_summary jsonb, after_summary jsonb,
  correlation_id, created_at
)

idempotency_keys(
  key text, actor_id text, request_hash text,
  response_status int, response_body jsonb,
  created_at,
  expires_at timestamptz,            -- NULL = permanent (http-api.md §8); otherwise swept
  primary key (key, actor_id)
)

feature_flags(flag_key primary key, enabled bool, rollout jsonb,
              is_kill_switch bool default false, updated_by, updated_at)
```

**`audit_log` is append-only at the database level**, not by convention: the application role
is granted `INSERT` and `SELECT` and nothing else. An audit table the app can `UPDATE` is a
table an attacker with app credentials can rewrite, and then it proves nothing.

The partial index on `published_at IS NULL` is what keeps the outbox relay cheap as the table
grows to millions of published rows.

**`idempotency_keys.expires_at` is nullable, and NULL means permanent (1.6.0).** `http-api.md`
§8 sets the retention — "24 h for gameplay, permanent for value-bearing operations" — which is
two classes, and the column was `NOT NULL`, so only one of them could be written down. A
value-bearing row would have had to invent a far-future sentinel that a sweep would eventually
believe. A sweep now exists (`store.idempotency.sweepExpired`, run hourly by the composition
root) and skips NULL explicitly; before it there was no sweep at all, so every row — including
the burnt eligibility-receipt nonces `auth/service.js` records in this table because there is no
`eligibility_receipts` table — was retained forever with an expiry column nothing read.
Migration `0017`. P1 writes no permanent rows; the point is that the first one can say so.

## 6. Moderation

```sql
reports(report_id primary key, reporter_account_id, subject_account_id,
        match_id, category, description, evidence_ref,
        status, resolution, resolved_by, resolved_at, created_at)

sanctions(sanction_id primary key, account_id, kind,       -- warn|mute|restrict|ban
          reason_code, issued_by, issued_at, expires_at,
          lifted_at, lifted_by, appeal_status, evidence_ref)
```

Sanctions are never deleted — lifting sets `lifted_at`. Sanction history is the input to
progressive review, and a deleted sanction resets a repeat offender to a first offence.

## 7. Retention and deletion

| Class | Retention | On account deletion |
|---|---|---|
| `short` | 30 days | Erased |
| `standard` | 13 months | Erased or pseudonymised |
| `audit` | 7 years | **Pseudonymised, retained** |
| `financial` | Per statutory requirement | **Pseudonymised, retained** |

Deletion replaces the account identifier with a durable pseudonym and erases personal fields.
It does **not** delete audit or financial rows: a moderation or financial record that vanishes
when its subject asks is neither auditable nor lawful in most regimes. `event-envelope.md` §7
states the same rule for events; they must not diverge.

## 8. Migrations

- Forward-only, sequentially numbered, one concern each.
- Every migration rehearsed against a production-like staging database before production.
- Additive first: add column → backfill → switch reads → drop old, across separate deploys.
  A rename in one migration is an outage on any rollback.
- A schema-drift check fails CI when the running schema diverges from the migration history.
- Rollback is a **new forward migration**, never an edited old one.

## 9. Verification — `scripts/dbtest.mjs`

1. Every migration applies to an empty database and to a seeded one.
2. Drift check catches a manually altered column.
3. The application role cannot `UPDATE` or `DELETE` `audit_log`.
4. Outbox rows are written in the same transaction as their state change.
5. Idempotency replay returns the stored response without re-execution.
6. Confusable display names collide on `display_name_folded`.
7. Account deletion erases personal fields and pseudonymises audit rows.
8. Career aggregates recomputed from `match_participants` equal `player_stats`.
