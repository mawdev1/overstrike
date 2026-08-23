# Contract 19 — Progression, Operations Points, and the redeploy loop

| | |
|---|---|
| **Status** | `FROZEN` |
| **Version** | 1.0.0 |
| **Owner** | [CC] Claude Code |
| **Scope** | P4-04. Real-money currency, wallets, marketplace, and XO are out of scope — see §1 |
| **Depends on** | `items-inventory.md` (`DRAFT` 1.0.0, P3-01) for `item_instances`/`durability`/`attachments`; `deployment.md` (`DRAFT` 1.0.0, P3-02) for the reservation flow this loop reuses unmodified; `settlement.md` (`FROZEN` 1.0.0, P3-04) for the `RunResult` shape OP is computed from; `event-envelope.md` (`FROZEN` 1.4.0) for the outbox pattern; `db-schema.md` (`FROZEN` 2.1.0) for schema conventions; `http-api.md` (`FROZEN` 2.2.0) for endpoint conventions; `errors.md` (`FROZEN` 1.8.0) for the error envelope |
| **Consumers** | Platform, settlement (P3-04, the point OP is minted), match server (repair/upgrade has no runtime effect), [CX] loadout/repair/upgrade UI, redeploy screen, Admin Portal |

---

## 1. Why this is not XO, and why that has to be load-bearing, not just a name

The Build Plan's G2A gate is explicit: **"The game is compelling without wallets, NFTs,
agents, creators, or XO rewards."** Stage 1 (P0–P4) has no real-money currency, no chain, no
marketplace. If this contract's ledger could be confused with XO — same table shape, same
event names, a code path an implementer could accidentally wire to a future payout — every
review of P4 would have to re-litigate "is this actually XO." So the separation is structural,
not naming:

- The currency is **OP — Operations Points**. Every table, column, event type, and error code
  below spells it `op` / `OP`, never `xo`/`XO`/`credits`/`currency`/`tokens` in isolation. A
  grep for `xo` across this contract's schema and event catalogue returns nothing.
- OP has **no exchange rate to anything**. It is not purchasable, not withdrawable, not
  transferable between accounts, and this contract defines no conversion path to or from XO —
  that is `P7`'s territory, if it ever happens, and would need its own CCR against this
  contract, not an inference from it.
- OP is minted **only** by `settlement.md`'s `run.settled` transaction (§3) — never by
  purchase, admin grant excepted (§3.4), never by a client claim.
- This contract's definition of done, verbatim from the Build Plan: **"progression rewards,
  repairs/upgrades using non-XO test currency, and redeploy loop; XP/OP support repeat play;
  no Stage 1 activity emits XO."** §9's invariants are written directly against that sentence.

## 2. What this contract owns, and what it hands off

Three existing contracts already own the systems this one composes with; nothing below
re-derives their territory:

- **`items-inventory.md` (15, P3-01)** owns `item_instances`/`item_definitions`, the
  `durability`/`attachments` placeholder fields (its §10: "given real semantics in P4-04"),
  and the instance state machine. This contract is the amendment that gives `durability` its
  first real writer (§5) and defines `attachments`' first real element shape for upgrade tiers
  (§6). It does not touch `location`, `status`, or the lock mechanism.
- **`deployment.md` (16, P3-02)** owns reservation, the signed snapshot, and admission. The
  redeploy loop (§7) is an explicit statement that this contract adds **zero** new deployment
  mechanism — "spend OP, then call `POST /v1/deployments` exactly as documented" is the whole
  redeploy story.
- **`settlement.md` (17, P3-04)** owns `RunResult` and the settlement transaction. This
  contract is `settlement.md`'s **second consumer** of the same transaction (§3) — OP minting
  and XP award ride inside the existing per-participant settlement transaction, not a second
  transaction racing it.

What is left, and is this contract's actual scope:

1. **The OP ledger** — a server-authoritative balance and an append-only transaction log,
   idempotent by construction (§3).
2. **Earning OP and XP from a run** — the reward formula against `RunResult`'s existing shape,
   per settlement outcome (§3.1–§3.2).
3. **Repair** — real mechanics against `items-inventory.md`'s `durability` placeholder: how
   durability depletes, what repair costs, and what a `durability=0` item cannot do (§5).
4. **Upgrade** — a bounded stat-tier progression per item instance, OP-gated, against
   `attachments` (§6).
5. **The redeploy loop** — post-run: repair/upgrade, requeue, reusing `deployment.md`'s
   reservation flow unmodified (§7).
6. **Level, not just balance** — XP and account level, so "repeat play" has a second, slower
   progression axis alongside the immediately-spendable OP balance (§4).

## 3. The OP ledger

### 3.1 Schema

```sql
op_ledger(
  entry_id          text primary key,           -- ULID
  account_id        text not null references accounts,
  delta             int not null,                -- positive = credit, negative = debit
  balance_after     int not null,                -- snapshot, so a support query never
                                                   -- has to replay the whole log to answer
                                                   -- "what was the balance after this entry"
  reason            text not null,                -- closed enum, §3.3
  run_id            text references matches,      -- non-null iff reason in
                                                   -- ('run-reward','run-objective','run-survival')
  instance_id       text references item_instances,  -- non-null iff reason in
                                                   -- ('repair','upgrade')
  correlation_id    text not null,                -- event-envelope.md §2 — same id as the
                                                   -- events_outbox row this entry commits with
  idempotency_key   text not null,                -- see §3.2
  created_at        timestamptz not null default now(),

  check (reason in ('run-reward','run-objective','run-survival','repair','upgrade',
                     'admin-grant','admin-adjustment')),
  check (reason not in ('run-reward','run-objective','run-survival') or run_id is not null),
  check (reason not in ('repair','upgrade') or instance_id is not null),
  check (balance_after >= 0)
)
create unique index op_ledger_idempotency on op_ledger(idempotency_key);
create index on op_ledger(account_id, created_at);
create index on op_ledger(run_id) where run_id is not null;

accounts_progression(
  account_id        text primary key references accounts,
  op_balance         int not null default 0,
  xp                int not null default 0,
  level             int not null default 1,
  updated_at         timestamptz not null default now(),

  check (op_balance >= 0),
  check (xp >= 0),
  check (level >= 1)
)
```

**Why a balance column *and* a full log, not one or the other.** `db-schema.md` §1's "no
destructive deletes on anything auditable" applies here exactly as it does to
`item_instances`: a balance-only design cannot answer "why does this account have 340 OP" or
detect a double-credit after the fact — the exact failure mode `items-inventory.md` §9
invariant 6 exists to make provable for items, restated here for currency. `accounts_
progression.op_balance` is a materialized view of `op_ledger`, kept in sync in the same
transaction as every ledger write (§3.2), never computed by summing the log at read time —
that would make every balance read an O(n) scan, the same reasoning `match_participants.stats`
gives for not deriving state from an event replay on every read.

**Why `balance_after` is stored per-row, not derived.** A reviewer investigating one entry
needs the balance at that moment without re-summing everything before it — the same
"snapshot, not a replay requirement" posture `deployment.md` §4.2 takes for the signed
snapshot's frozen `durability`/`attachments` fields.

**Why `op_balance` has a `>= 0` CHECK and nothing here defines an overdraft.** Every debit path
in this contract (§5.3 repair, §6.3 upgrade) is a conditional `UPDATE` gated on sufficient
balance, mirroring `items-inventory.md` §6.2's atomic lock pattern exactly — a debit that
would take the balance negative simply does not match its own `WHERE` clause and the caller
gets `OP_INSUFFICIENT_BALANCE` (§8), never a negative balance that has to be reconciled after
the fact.

### 3.2 Idempotency — reusing `event-envelope.md`'s outbox, not a second mechanism

**Every OP ledger write commits in the same transaction as the state change it is paying for,
and the same transaction as its `events_outbox` row** — `event-envelope.md` §4's binding rule,
applied to currency exactly as `settlement.md` §6 already applies it to item disposition:

```
BEGIN
  UPDATE accounts_progression SET op_balance = op_balance + $delta, updated_at = now()
    WHERE account_id = $accountId AND op_balance + $delta >= 0;
  -- rowcount 0 ⇒ ROLLBACK, return OP_INSUFFICIENT_BALANCE (debit) or a logic defect (credit,
  -- which can never fail this predicate since a credit only raises the balance)
  INSERT INTO op_ledger (…, idempotency_key) VALUES (…, $idempotencyKey);
  -- idempotency_key's unique index is the actual replay guard — see below
  INSERT INTO events_outbox (…);   -- op.earned or op.spent, §10
COMMIT
```

`idempotency_key` is **derived, not caller-supplied**, for every reason this contract mints or
spends OP:

| Reason | `idempotency_key` |
|---|---|
| `run-reward` / `run-objective` / `run-survival` | `op-award:<runId>:<accountId>:<reason>` — one row per run/account/reason ever, mirroring `settlement.md` §5's `run-result:<runId>` derivation |
| `repair` | `op-repair:<instanceId>:<repairAttemptId>` — `repairAttemptId` is the client-supplied `Idempotency-Key` on `POST /v1/items/:instanceId/repair` (`http-api.md` §8), namespaced so a repair replay can never collide with a different endpoint's key |
| `upgrade` | `op-upgrade:<instanceId>:<upgradeAttemptId>` — same construction, `POST /v1/items/:instanceId/upgrade` |
| `admin-grant` / `admin-adjustment` | `op-admin:<adminActionId>` — the Admin Portal action's own idempotency id (`auth.md` §10) |

A retry with the same key hits `op_ledger_idempotency`'s unique index, the `INSERT` fails, the
transaction rolls back to a savepoint before it, and the handler returns the **stored** entry's
result — the identical replay contract `http-api.md` §8 already states for every value-bearing
endpoint, expressed here at the ledger-row level instead of the whole-request level because a
run's three reward reasons (§3.1) need independent idempotency, not one key for the whole
settlement.

**Why this rides inside `settlement.md`'s existing transaction rather than a second one.**
`settlement.md` §6 already states "One transaction per participant... no `item_instances`
mutation is ever issued from application code after a commit and outside this transaction."
OP award for a run is data derived from the same `RunResult` that transaction is already
committing — adding a second, independently-committing transaction for the OP side of the same
outcome reintroduces exactly the "commit both or neither" hazard `event-envelope.md` §4 exists
to prevent. §3.1 below specifies the reward computation; mechanically, its `UPDATE`/`INSERT`
statements are additional statements inside `settlement.md` §6's existing `BEGIN…COMMIT` block,
for the three real dispositions only (never for `void`, §3.1) — not a new transaction boundary.

### 3.3 Earning OP from a run

Computed once per participant, at the moment `settlement.md` §6's transaction determines
`$outcome`, using fields that transaction already has in hand — no second read of `RunResult`,
no second query:

| `reason` | Fires when | Amount |
|---|---|---|
| `run-reward` | `outcome = 'extracted'` (settlement.md §4) | `BASE_EXTRACT_OP` (data, P4-11-equivalent tuning, default 50) |
| `run-objective` | Once per completed dynamic event/objective this participant is credited for during the run (P4-02's event system marks completion; this contract only reads the count, it does not define what an objective is) | `PER_OBJECTIVE_OP` (data, default 15) × objective count |
| `run-survival` | `outcome in ('extracted','died')` — i.e. the participant actually spawned and played, as opposed to `aborted` before meaningful engagement | `SURVIVAL_TIME_OP` (data, default 1) × `floor(survivedSeconds / 60)`, capped at `MAX_SURVIVAL_OP` (data, default 30) so idling in a dormant sector cannot out-earn extracting |

**`died` and `aborted` earn no `run-reward`.** A full loss of run inventory (`settlement.md`
§4) is already the raid's own penalty; layering an additional OP forfeiture on top would be a
second, undocumented penalty this contract does not define — `died`/`aborted` participants earn
only what §3.3's `run-survival` row credits (nothing, for `aborted`, and only the survival-time
component for `died`), never `run-reward` or `run-objective`.

**`server-failure` earns exactly what the resolved disposition earns** — §6.1 of
`settlement.md` already resolves a `server-failure` outcome to one of the three real
dispositions before any `item_instances` write; the same resolved value is what this table's
`outcome` column above reads. A `void` exception resolution (`settlement.md` §6.1) earns
**nothing** — no `item_instances` mutation happens for `void`, and this contract adds no OP
mutation either; the three `op_ledger` rows this section defines are only ever inserted
alongside a real disposition, mirroring `settlement.md` §6.1's "no `item_instances` mutation…
not executed at all" for the identical branch.

`survivedSeconds` and the objective count are raid-server-observed facts already present in
`RunResult`/`evidenceRef` (`extraction-match.md` §6/§7) — this contract adds no new field to
either shape; it reads what P4-02's event system and the existing `startedAt`/`endedAt` already
carry.

### 3.4 XP

XP is credited in the **same** transaction, same idempotency construction, same three reasons
as OP (`xp-reward`/`xp-objective`/`xp-survival` mirror §3.3's rows one-for-one, sharing the
`reason` semantics but a separate `XP_PER_*` tuning table) — but XP has **no ledger table**.
There is no repair/upgrade spend of XP, no admin adjustment scoped to a single instance, and
therefore no need for `op_ledger`'s per-entry audit shape; `accounts_progression.xp` is
credited directly:

```sql
UPDATE accounts_progression SET xp = xp + $xpDelta, level = $computedLevel, updated_at = now()
  WHERE account_id = $accountId;
INSERT INTO events_outbox (…);   -- progression.xp.earned, §10 — carries $xpDelta and level-up
                                  -- flag if $computedLevel > the row's prior level
```

`$computedLevel` is `LEVEL_CURVE(xp)` — a monotonic, deterministic function of total XP (data,
P4-11-equivalent tuning; this contract does not fix the curve's shape, only that it is a pure
function of `xp` alone, so level is always derivable and never drifts from a separately
incremented counter). Level currently has **no mechanical effect** in this contract — no
unlock, no stat change — it exists because the Build Plan's DoD names "XP/OP support repeat
play" as two things, not one, and a currency alone does not answer "am I making progress" the
way a level does. A future phase may attach unlocks to level; this contract reserves the
column and computation, nothing more (§11).

Admin grants (`admin-grant`) and corrections (`admin-adjustment`) exist for the identical
operational reason `settlement.md` §7.4's exception resolution exists for items — a support
case where the automatic path under- or over-credited OP. Both go through `op_ledger` with
`opAdminActionId`-derived idempotency (§3.2), require non-blank `resolution_notes`-equivalent
justification (`db-schema.md` §5's `audit_log.reason_code` pattern, same posture
`settlement.md` §7.3 takes for `resolution_notes`), and are audited exactly as any other
privileged action (`auth.md` §10).

## 4. Level and XP — read surface

```
GET /v1/progression        -- caller's own accounts_progression row, plus a paginated
                            -- recent-entries slice of op_ledger (http-api.md §10 cursor shape)
```

```jsonc
// 200 response
{
  "accountId": "01J…",
  "opBalance": 340,
  "xp": 1250,
  "level": 4,
  "recentLedger": {
    "items": [
      { "entryId": "01J…", "delta": 50, "balanceAfter": 340, "reason": "run-reward",
        "runId": "01J…", "createdAt": "…" }
    ],
    "nextCursor": null,
    "correlationId": "01J…"
  },
  "correlationId": "01J…"
}
```

No endpoint returns another account's `op_balance`/`xp`/`level` outside Admin Portal (`auth.md`
§10 role gate) — a leaderboard or squad-visible progression surface is a P4-05/P4-06
presentation concern this contract does not specify.

## 5. Repair — real mechanics against `items-inventory.md`'s durability placeholder

### 5.1 What durability means, now that it has a writer

`items-inventory.md` §2 declares `item_instances.durability` nullable, "P4-04 placeholder,
unused meaning in P3," gated on `item_definitions.durability_max` being non-null. This contract
is that amendment:

- `item_definitions.durability_max` is set (by data, P3-11-equivalent authoring) for every
  `weapon` and `gear`-class definition; remains `null` for `consumable`/`material`/`cosmetic` —
  those have no durability model, per `items-inventory.md`'s own wording, and this contract does
  not extend one to them.
- A non-stackable instance of such a definition starts at `durability = durability_max` at
  creation (loot spawn, craft, admin grant — `items-inventory.md` §6.3's creation paths; this
  contract adds no new creation path).
- **Depletion is server-computed at settlement, not during the raid.** `extraction-match.md`
  §5's "what this contract does not decide" table is unchanged by this amendment — the raid
  server still never mutates `item_instances` outside its documented pickup/drop paths (that
  contract's own §9.9 invariant). Durability loss is instead computed once, at the moment
  `settlement.md` §6's transaction converts a surviving `location='run'` instance to
  `location='permanent'` on `extracted` (the only disposition where the instance survives to
  need a durability value going forward — a `lost` instance's durability is moot, §5's table
  already governs that path and this contract adds no write to it):

  ```sql
  UPDATE item_instances
  SET durability = GREATEST(0, durability - $depletionAmount), updated_at = now()
  WHERE instance_id = ANY($surviving_run_instance_ids)  -- settlement.md §6's own step-2 read,
                                                          -- reused verbatim: every surviving
                                                          -- location='run' row for this
                                                          -- participant, not only equipped
                                                          -- loadout slots — a weapon picked up
                                                          -- mid-raid and carried to the exit
                                                          -- depletes exactly the same as one
                                                          -- deployed with
    AND durability IS NOT NULL;
  -- Same transaction as settlement.md §6's location='permanent' UPDATE — one write, not two
  -- competing writers touching the same row for the same event.
  ```

  `$depletionAmount` is `DURABILITY_LOSS_PER_RUN` (data, default: a flat amount per raid
  survived while equipped, not per shot fired — this contract deliberately does not model
  per-shot or per-hit durability loss; that would require a raid-server write path this
  contract does not add, and `extraction-match.md`'s existing boundary already forbids one).
  This is a **deliberate simplification** or the P4 slice, recorded rather than hidden: a
  richer per-action durability model is a later amendment to both this contract and
  `extraction-match.md`'s §9.9 invariant, not something P4-04 needs to ship.
- **Why settlement, not the raid server, is the writer.** `items-inventory.md` §6.4 already
  forbids any mutation of a locked instance's `durability` except the transition that owns the
  row at that moment — settlement's own extract transition is exactly that owning transition
  (§6.4's own carve-out: "that transition is driven by the deployment lifecycle itself... never
  by an arbitrary caller"). Depleting durability inside the same `UPDATE` that clears the lock
  is the only write site consistent with that CHECK without amending `items-inventory.md` §6.4
  itself.

### 5.2 What `durability = 0` means

A `durability = 0` instance is **not** `status='destroyed'` — it remains `active`,
`location='permanent'`, fully visible in inventory, but:

- **Cannot be placed in a loadout slot.** This contract amends `items-inventory.md` §3.1's
  validation rule 1 additively: an instance with non-null `durability_max` and
  `durability = 0` fails loadout save/deploy validation with a new code, `ITEM_BROKEN` (§8) —
  additive to that contract's closed rule-1 check, not a rewrite of it. An instance whose
  definition has `durability_max = null` is never subject to this check, exactly as it is
  already exempt from every other durability-shaped rule.
- **Can still be repaired** (§5.3) — brokenness is not terminal, unlike `items-inventory.md`
  §5's status terminality; `durability` is a mutable int field, not a status.

### 5.3 Repair endpoint

```
POST /v1/items/:instanceId/repair       Idempotency-Key required (http-api.md §8)
```

```jsonc
// request — no body fields; the target instance and caller-derived cost are server-computed
{}

// 200 response
{
  "instanceId": "01J…",
  "durability": 100,
  "durabilityMax": 100,
  "opSpent": 20,
  "opBalance": 320,
  "correlationId": "01J…"
}
```

Server-side, one transaction, same shape as every other conditional-update-plus-outbox pattern
in this contract:

```sql
-- 1. Validate: instance owned by caller, location='permanent', status='active',
--    locked=false (items-inventory.md §6.1's ownership/lock predicates, reused verbatim —
--    a locked instance cannot be repaired for the identical reason it cannot be mutated at
--    all, §6.4), durability_max is not null, durability < durability_max.
--    Any failure: 400 ITEM_NOT_REPAIRABLE (§8), no write.
-- 2. cost = REPAIR_COST_PER_POINT (data, default 1) * (durability_max - durability)
--    -- full repair to max in one call; this contract does not offer partial repair
--    -- amounts, keeping the endpoint idempotent-by-full-state rather than needing a
--    -- caller-supplied "how much" that could itself replay inconsistently.
BEGIN
  UPDATE accounts_progression SET op_balance = op_balance - $cost, updated_at = now()
    WHERE account_id = $accountId AND op_balance >= $cost;
  -- rowcount 0 ⇒ ROLLBACK, 402 OP_INSUFFICIENT_BALANCE
  UPDATE item_instances SET durability = durability_max, updated_at = now()
    WHERE instance_id = $instanceId AND locked = false;
  -- locked=false re-checked here, not just in step 1's read — the same read-then-write race
  -- items-inventory.md §6.2's lock UPDATE exists to close, applied to repair instead of
  -- deployment. rowcount 0 here (instance got locked between step 1 and here) ⇒ ROLLBACK the
  -- whole transaction including the OP debit, 409 ITEM_LOCKED (items-inventory.md §8, reused)
  INSERT INTO op_ledger (…, reason='repair', instance_id=$instanceId, …);
  INSERT INTO events_outbox (…);   -- item.repaired, §10
COMMIT
```

Repair never changes `item_id`, `attachments`, `location`, or `status` — only `durability`,
exactly as `items-inventory.md` §6.4 permits for an unlocked row.

## 6. Upgrade — a bounded stat-tier progression, OP-gated

### 6.1 What an upgrade is

An upgrade is a **tier increment on one instance**, stored in `items-inventory.md`'s existing
`attachments` field — that contract declares it `jsonb not null default '[]'`, "P4+; empty in
P3/P4-04 scope" (§2) and "given real semantics in P4-04" (§10). This contract is that amendment,
additive to the empty-array default, not a new column:

```jsonc
// item_instances.attachments, after this amendment — an array of at most one upgrade entry
// per instance in this slice (bounded, per §6.2)
[
  { "kind": "upgrade", "tier": 2, "appliedAt": "2026-08-23T…" }
]
```

`attachments` remains a `jsonb` array (not a single object) because `items-inventory.md`'s own
comment already anticipates a future where an instance carries more than one attachment kind
(a scope, a stock) alongside an upgrade tier — this contract's amendment adds exactly one
recognized element shape (`kind: "upgrade"`) to that array without foreclosing others.

### 6.2 Tier bounds

Every upgradeable definition (same `weapon`/`gear` class gate as durability, §5.1) declares
`maxUpgradeTier` in its authored data (P3-11-equivalent), default 3 for the P4 slice. An
instance's upgrade tier is `0` (no `attachments` entry of `kind: "upgrade"`) through
`maxUpgradeTier`, monotonically increasing, **never decreasing** — there is no downgrade
endpoint in this contract; an upgrade is a one-way spend, the same "no compensating-delta
mechanism" posture `settlement.md` §3 states for its own terminal states.

Each tier scales `item_definitions.base_stats` by a per-definition, per-tier authored
multiplier table (data, not this contract's to author) — this contract fixes only that the
scaling is **read-only computed from `(base_stats, tier)` at the point a loadout or run
inventory snapshot needs the effective stats**, never written back into `base_stats` itself.
`items-inventory.md` §2 already states `base_stats` is "authored, read-only at runtime" — this
amendment does not change that; `tier` is what varies per-instance, `base_stats` stays exactly
what P3-11 authored.

### 6.3 Upgrade endpoint

```
POST /v1/items/:instanceId/upgrade       Idempotency-Key required (http-api.md §8)
```

```jsonc
// request
{}

// 200 response
{
  "instanceId": "01J…",
  "tier": 2,
  "maxUpgradeTier": 3,
  "opSpent": 120,
  "opBalance": 200,
  "correlationId": "01J…"
}
```

Same transactional shape as repair (§5.3), substituting the upgrade write:

```sql
-- 1. Validate: ownership/location/status/locked, same predicates as repair (§5.3 step 1).
--    Additionally: current tier < maxUpgradeTier (else 400 ITEM_MAX_TIER, §8), and
--    durability > 0 if the definition has a durability model (a broken item cannot be
--    upgraded — §5.2's ITEM_BROKEN reused, since upgrading a broken item is exactly as
--    nonsensical as equipping one).
-- 2. cost = UPGRADE_COST_TABLE[definitionId][currentTier + 1]  -- data, monotonically
--    increasing per tier so later tiers cost more, same shape repair's linear cost takes
--    but per-definition-authored rather than a flat formula, since tier value varies by item.
BEGIN
  UPDATE accounts_progression SET op_balance = op_balance - $cost, updated_at = now()
    WHERE account_id = $accountId AND op_balance >= $cost;
  -- rowcount 0 ⇒ ROLLBACK, 402 OP_INSUFFICIENT_BALANCE
  UPDATE item_instances
    SET attachments = jsonb_set(
          COALESCE(attachments, '[]') - upgrade_entry_index,  -- remove any prior upgrade entry
          '{999}',                                             -- append
          jsonb_build_object('kind','upgrade','tier',$newTier,'appliedAt', now()),
          true),
        updated_at = now()
    WHERE instance_id = $instanceId AND locked = false;
  -- locked=false re-checked at write time, identical race-close reasoning to repair (§5.3)
  -- rowcount 0 ⇒ ROLLBACK including the OP debit, 409 ITEM_LOCKED
  INSERT INTO op_ledger (…, reason='upgrade', instance_id=$instanceId, …);
  INSERT INTO events_outbox (…);   -- item.upgraded, §10
COMMIT
```

(`upgrade_entry_index`/the exact `jsonb` splice is an implementation detail of "replace the one
`kind:"upgrade"` element" — the invariant this section actually requires is that `attachments`
holds **at most one** `kind: "upgrade"` element per instance, ever, per §6.2's bound; §9's
invariants assert that, not the specific `jsonb` operators used to maintain it.)

## 7. The redeploy loop

**This contract adds no new deployment mechanism.** Post-run, the flow is:

1. `settlement.md` §6 settles the participant (extract/death/abort), crediting OP/XP inside
   the same transaction (§3.2–§3.4). The player is back at the loadout/inventory screen with an
   unlocked, `location='permanent'` inventory — every surviving item, plus whatever OP/XP this
   run earned.
2. **Repair/upgrade** (§5.3, §6.3), zero or more calls, entirely optional, entirely between
   raids — the player spends newly-earned OP against durability that depleted (§5.1) or a tier
   they can now afford (§6.2).
3. **Requeue.** `POST /v1/deployments` (`deployment.md` §7), unmodified — same loadout-or-ad-hoc
   shape, same reservation/lock/TTL mechanics, same signed snapshot at match allocation. The
   only observable difference from a first deployment is that the loadout being reserved may
   now reference a repaired or upgraded instance; `deployment.md` §2.1's reservation `UPDATE`
   already locks whatever `item_instances` row exists at reservation time — it has no notion of
   "first deploy" vs. "redeploy" to begin with, so nothing in that contract needs to change for
   this loop to work.

**Why this is a loop and not just two independent features.** OP earned in step 1 funds step 2,
which changes what step 3 locks in — the same instance, carried across raids, is what makes
"XP/OP support repeat play" (the Build Plan's own DoD wording) true mechanically rather than
descriptively: nothing about the mechanism forces a player to earn-then-spend-then-requeue in
one sitting, but every piece exists because the next raid consumes what the last one paid for.

## 8. Error codes (additive to `errors.md` §3, closed enumeration per that contract's §2)

| Code | HTTP | Meaning |
|---|---:|---|
| `OP_INSUFFICIENT_BALANCE` | 402 | Repair/upgrade cost exceeds `accounts_progression.op_balance` at debit time (§5.3, §6.3) |
| `ITEM_NOT_REPAIRABLE` | 400 | Target instance is not owned/permanent/active/unlocked, has no `durability_max`, or is already at full durability (§5.3) |
| `ITEM_BROKEN` | 400 | `durability = 0` instance placed in a loadout slot (`items-inventory.md` §3.1, additive) or targeted by `POST …/upgrade` (§6.3) |
| `ITEM_MAX_TIER` | 400 | `POST …/upgrade` targeted an instance already at `maxUpgradeTier` (§6.3) |

`402` (Payment Required) is used deliberately rather than `403` — this is the one place in the
Overstrike contract set an insufficient-funds condition exists, and `errors.md` §3's existing
`Platform`/`Validation` sections have no prior HTTP-code precedent for it to conflict with;
landing in `errors.md`'s closed enumeration is an additive amendment (new codes only) once this
contract reaches `REVIEW`, the identical posture `deployment.md` §8 and `settlement.md` §7.3
already take toward the same document.

`ITEM_LOCKED` (repair/upgrade racing a deployment reservation) and `LOADOUT_ITEM_NOT_OWNED`
(target instance not the caller's) are **reused from `items-inventory.md` §8 verbatim** — this
contract does not redefine either.

## 9. Invariants a test suite asserts

1. **No Stage-1 activity emits an event, table row, or field named `xo`/`XO`** — asserted by a
   static scan of this contract's schema (§3.1, §5–§6), event catalogue (§10), and error codes
   (§8) for the literal string, case-insensitive, outside of prose explicitly contrasting OP
   with XO. This is the direct, mechanical form of the Build Plan's "no Stage 1 activity emits
   XO."
2. **OP balance never goes negative** — `accounts_progression.op_balance`'s CHECK (§3.1) plus a
   concurrency test: two concurrent repair/upgrade calls racing the same account's balance down
   to exactly the cost of one of them leave the loser with `OP_INSUFFICIENT_BALANCE` and zero
   balance change, never a negative balance and never a double-debit.
3. **Every `op_ledger` row's `balance_after` matches `accounts_progression.op_balance` computed
   by summing every prior delta for that account** — proves the materialized column and the log
   never drift, the identical class of invariant `items-inventory.md` §9 invariant 1 states for
   ownership.
4. **A run awards each of `run-reward`/`run-objective`/`run-survival` at most once per
   `(runId, accountId)`** — the `op_ledger_idempotency` unique index (§3.1) enforced by a
   concurrent-replay test racing two identical settlement retries, mirroring
   `settlement.md` §10 test 1's shape exactly.
5. **A `void` exception resolution mints no OP and awards no XP** — mirrors
   `settlement.md` §10 test 14's item-side assertion, applied to the reward side of the same
   transaction (§3.3).
6. **Repair and upgrade are refused on a locked instance**, and neither ever leaves a partial
   state — an OP debit with no matching `item_instances` write, or vice versa — asserted by
   racing a deployment reservation against a repair/upgrade call on the same instance and
   confirming exactly one of the two operations lands (§5.3, §6.3).
7. **A `durability = 0` instance cannot be placed in a loadout slot** (`ITEM_BROKEN`), and
   **can** be repaired back above zero and then placed — asserted end to end: break, attempt
   loadout save (refused), repair, attempt again (accepted).
8. **Upgrade tier never exceeds `maxUpgradeTier`** and **never decreases** — asserted by
   attempting `maxUpgradeTier + 1` upgrade calls and confirming the last is refused
   `ITEM_MAX_TIER`, and by confirming no endpoint in this contract accepts a tier argument that
   could set tier below its current value.
9. **`attachments` holds at most one `kind: "upgrade"` element per instance** after any number
   of successful upgrade calls — asserted by upgrading an instance through every tier and
   inspecting `attachments` length at each step.
10. **Durability depletion happens exactly once per extracted run**, in the same transaction as
    `settlement.md` §6's `location='permanent'` conversion — asserted by a crash-injection test
    between the two `UPDATE`s (they are the same statement group in the same transaction, so a
    crash before commit leaves neither applied, never one without the other) and by confirming
    a `died`/`aborted` disposition never touches `durability` at all.
11. **The redeploy loop needs zero `deployment.md` changes** — asserted by running
    `deploytest.mjs` (`deployment.md` §9) unmodified against an account that has repaired/
    upgraded between two deployments and confirming every existing assertion still holds,
    proving §7's "no new deployment mechanism" claim rather than merely stating it.

## 10. Events (additive to `event-envelope.md` §6, pending that contract's own amendment)

| Type | Actor | Subject | Payload highlights | Privacy | Retention |
|---|---|---|---|---|---|
| `op.earned` | service | account | `entryId`, `runId`, `reason`, `delta`, `balanceAfter` | internal | audit |
| `op.spent` | player | account | `entryId`, `reason`, `instanceId`, `delta`, `balanceAfter` | internal | audit |
| `progression.xp.earned` | service | account | `runId`, `xpDelta`, `level`, `leveledUp` (bool) | internal | standard |
| `item.repaired` | player | item | `instanceId`, `durability`, `opSpent` | internal | standard |
| `item.upgraded` | player | item | `instanceId`, `tier`, `opSpent` | internal | standard |

`audit` retention on both `op.*` events matches `db-schema.md` §7's reasoning for
`settlement.md`'s `run.settled`/exception events (§9 there) — a currency-moving record is
exactly the class of fact a dispute or an anti-cheat review needs, restated here for the same
reason `items-inventory.md` §6.3 gives `item.created` the identical `audit` retention. `item.*`
and `progression.xp.earned` are `standard` — cosmetic/progress signals with no currency or
possession implication of their own, the same tier `event-envelope.md` §6's existing catalogue
already uses for non-audit gameplay events.

Naming follows `event-envelope.md` §5 (`<domain>.<entity>.<past-tense-verb>`). `op.earned`/
`op.spent` deliberately use `op` as the domain (not `progression`) so a consumer filtering for
"every currency movement" can subscribe to one prefix — mirroring why `extraction-match.md` §8
keeps `extraction.*` separate from `settlement.md`'s `run.*` prefix: two producers, two
questions, two prefixes.

## 11. Open items

- **Level's mechanical effect is unspecified** (§3.4) — this contract fixes only that level is
  a pure function of XP; whether a future phase attaches an unlock, a cosmetic, or nothing at
  all is not decided here.
- **Durability depletion is flat-per-run, not per-action** (§5.1) — a richer model needs an
  `extraction-match.md` amendment to its §9.9 invariant (currently: the raid server issues no
  `item_instances` write outside pickup/drop) before a raid-server-side depletion write could
  ever be added; this contract does not propose that amendment, only records the dependency.
- **`UPGRADE_COST_TABLE`, `REPAIR_COST_PER_POINT`, `BASE_EXTRACT_OP`, `PER_OBJECTIVE_OP`,
  `SURVIVAL_TIME_OP`, `MAX_SURVIVAL_OP`, `DURABILITY_LOSS_PER_RUN`, `LEVEL_CURVE`,
  `maxUpgradeTier`, per-tier stat multipliers** are all data (P3-11-equivalent authoring), not
  fixed by this contract — §3.3/§5.1/§6.2/§6.3 name the shape and the defaults used for initial
  tuning, not the final balance, matching the mechanism/parameter split `sector-interest.md`
  §8 and `bomb-rules.md` §2 already take for their own tunables.
- **`items-inventory.md`'s §3.1 loadout-validation amendment (`ITEM_BROKEN`) and its
  `attachments` upgrade-entry shape (§6.1) are proposed here, additive, pending that contract's
  own amendment process** once both contracts are past `DRAFT` — the identical posture
  `extraction-match.md` §0 already takes toward its own `container_id` addition to that same
  table.
