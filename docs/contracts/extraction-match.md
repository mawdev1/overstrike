# Contract 18 — Extraction raid state, world/run loot, and containers

| | |
|---|---|
| **Status** | `FROZEN` |
| **Version** | 1.0.0 |
| **Owner** | [CC] Claude Code |
| **Depends on** | `items-inventory.md` (`DRAFT` 1.0.0, P3-01) for the instance state machine; `deployment.md` (`DRAFT` 1.0.0, P3-02) for how a participant enters `raid` with `location='run'` instances already seeded and locked; `settlement.md` (`DRAFT` 1.0.0, P3-04) for the `RunResult` wire shape this contract submits and everything that happens to items after submission |
| **Consumers** | Match server (`src/game/**`), settlement (P3-04, reads what this contract submits), [CX] raid HUD (P3-09) |

---

## 0. What this contract owns, and what it hands off

Three siblings already exist and this document does not re-derive any of their territory:

- **`items-inventory.md` (15, P3-01)** owns `item_definitions`/`item_instances`, the
  `location`/`status` state machine, and the item-lock mechanism.
- **`deployment.md` (16, P3-02)** owns everything up to and including spawning a participant
  into the raid: reservation, the signed snapshot, and the atomic transition (its §4.5 step 4)
  that seeds `location='run', run_id=<this run>` for every locked loadout instance. **The
  `deploy` phase named in this contract's own state machine (§2) is that contract's mechanism,
  referenced here, not re-specified.**
- **`settlement.md` (17, P3-04)** owns everything from the moment a participant's run ends:
  the `RunResult` submission endpoint (`POST /v1/runs/:runId/result`), its exact request shape,
  the settlement transaction that converts or loses `item_instances` rows, and the exception
  queue. **This contract does not define a competing result endpoint, outcome enum, or item
  mutation. It is `settlement.md`'s producer** — everything below exists to determine, correctly
  and deterministically, what `RunResult` this raid server submits.

What is left, and is this contract's actual scope:

1. The participant-visible phase machine during `raid`/`extracting` (§2), sitting between
   deployment admission and settlement submission.
2. World loot and containers — spawn, tiers, pickup, drop (§3). Neither sibling contract
   touches this; `items-inventory.md` §10 explicitly delegates it here.
3. Determining, from raid-server-observed facts, which of `settlement.md` §4's four outcomes
   applies to a given participant, and constructing the exact `RunResult` payload (§4–§6).
4. Extraction exit validation (§5).

**Open items this contract adds to the two already carried by its siblings** (`settlement.md`
§2's `outcome_reason` CHECK amendment; `items-inventory.md`'s delegation above): a
`world_loot_containers` table and one additive column on `item_instances` (§3.1) — proposed
here, to be folded into `items-inventory.md` before either leaves `DRAFT`, per that contract's
own note that container modeling is this contract's to specify; a documented convention for
`match_participants.team` carrying `squadId` under `mode='extraction'` (§1.2); two additive
columns on `matches` for run-scoped determinism inputs (§3.1.1); two further `db-schema.md`
`matches` CHECK amendments this contract's own mechanism depends on that neither sibling
contract currently lists (§0.1 below); and, external to this contract's own siblings, a
dependency on `deployment.md` to carry `squadId` from wherever it is assigned through to the
reservation and on into `match_participants.team` at admission (§1.2) — flagged here, not
resolved here, since reservation shape is `deployment.md`'s territory.

### 0.1 The full `db-schema.md` `matches` amendment set

`settlement.md` §2's open item names one required amendment (the `outcome_reason`/`winner_team`
CHECK needs a `mode='extraction'` branch). That is necessary but not sufficient — a `matches`
row with `mode='extraction'` cannot exist at all, let alone reach `completed`, without two more
amendments this contract is the one to name because they are exactly the CHECKs its own
mechanism (§1.1's run lifecycle, §3.1.1's determinism inputs) runs into. All three are additive
disjuncts gated on `mode='extraction'` — none narrows what a `tdm`/`bomb` row is already allowed
to be:

1. **`check (mode in ('tdm','bomb'))` must admit `'extraction'`.** This is the precondition for
   the other two — no `matches` row with `mode='extraction'` can be inserted at **allocation**
   (`db-schema.md` §4's "created at allocation, not completion") before this one lands, which
   means it blocks every phase in §1.1's table, not just `completed`. Proposed:
   `check (mode in ('tdm','bomb','extraction'))`.
2. **The `outcome_reason`/`winner_team` CHECK** (`db-schema.md` §4) needs the
   `mode='extraction'` disjunct `settlement.md` §2 already scopes: `outcome_reason is null and
   winner_team is null` permitted on a `completed` (and `aborted`) row when `mode='extraction'`.
   Restated here only so this contract's own enumeration of what blocks an extraction row from
   reaching `completed` is complete — `settlement.md` §2 remains the normative text for this one
   amendment, this contract does not compete with it.
3. **The terminal-row-COMPLETE CHECK** (`db-schema.md` §4: "every §4.2 key required on one is
   non-null... `team_scores`, `rounds`, `evidence_ref`") has no `mode='extraction'` branch either,
   and unlike item 2 it is not on either sibling's open-items list yet. `team_scores` and
   `rounds` are PvP-only fields — §1.1 of this contract already establishes that a run's outcome
   lives in `match_participants.stats`, not on the `matches` row, so an extraction row never
   populates either column, and the unamended CHECK would permanently refuse `status='completed'`
   on every extraction run. Proposed amendment, additive to the existing disjunct:
   ```sql
   check (status in ('allocated','in-progress')
          or (started_at is not null and ended_at is not null and evidence_ref is not null
              and (mode = 'extraction' or (team_scores is not null and rounds is not null))))
   ```
   `started_at`, `ended_at`, and `evidence_ref` stay required for every mode — §1.1's `ended`
   phase and §7's `evidenceRef` construction both still apply to a run exactly as they do to a
   match.

All three amendments must land in `db-schema.md` before this contract or `settlement.md` leaves
`DRAFT` — items 1 and 3 are this contract's to carry since nothing else names them; item 2
remains `settlement.md`'s to carry, cross-referenced here so the full set is enumerated in one
place rather than split silently across two `DRAFT` contracts.

## 1. Participant state machine

One **participant** entry per `(runId, accountId)` inside a **run** (`settlement.md` §2: a
`matches` row, `mode='extraction'`). Every participant belongs to exactly one **squad** (§1.2);
each member has an independent phase and an independent terminal outcome — build plan P3-09
"squad/status" is presentational, and `settlement.md` §6 already requires that one participant's
outcome never blocks or leaks into another's settlement.

```
       (deployment.md §4.5 step 4 — admission)
deploy ────────────────────────────────────────► raid → extracting → extracted
                                                     │       ↑
                                                     │       └── interrupted, back to raid
                                                     ├────────────────────► dead
      (any phase) ─────────────────────────────────────────────────────► aborted
```

| Phase | Entered when | Behaviour | Owned by |
|---|---|---|---|
| `deploy` | Reservation exists, snapshot not yet consumed | No world presence | `deployment.md` §2–§4 |
| `raid` | `deployment.md` §4.5 step 4 completes: entity spawned, loadout instances at `location='run'`, `locked=true` | Free movement, loot interaction, combat. §3–§5 govern | This contract |
| `extracting` | Player enters an exit volume and its conditions are met (§5) | Extraction channel runs. Still killable | This contract |
| `extracted` | Extraction channel completes | Terminal. Raid server submits `RunResult` with `outcome: "extracted"` (§6) | This contract → `settlement.md` §4 |
| `dead` | Health reaches 0 in `raid` or `extracting` | Terminal. Raid server submits `outcome: "died"` (§6) | This contract → `settlement.md` §4 |
| `aborted` | Disconnect past grace, or raid hard timeout, in `raid`/`extracting` | Terminal. Raid server submits `outcome: "aborted"` (§4, §6) | This contract → `settlement.md` §4 |

Not shown as a fifth row because it isn't a phase this contract's state machine passes through:
a raid-server-detected fault it cannot itself resolve (crash mid-tick, sector unload fault)
submits `outcome: "server-failure"` with `lastKnownState` (§6.2) instead of forcing the
participant through one of the rows above — `settlement.md` §4.1 rules it from that state, and
this contract's job is only to report the last phase accurately, never to guess which of
`extracted`/`died`/`aborted` it "really" was.

Transitions are server-driven only. The client requests (move into a volume, hold an interact
key); the server decides the phase — same authority split as `bomb-rules.md` §6–§7's
plant/defuse: the client renders server-driven progress and never simulates its own.

### 1.1 Run lifecycle (shared, not per-participant)

```
spinning-up → active → collapsing → ended
```

| Phase | Meaning | `matches.status` |
|---|---|---|
| `spinning-up` | Sector and loot seeded (§3.2) from the run seed. Accepting deploys within a join window | `allocated` |
| `active` | Normal play. New deploys accepted per P3-05 sector rules | `in-progress` |
| `collapsing` | Hard-timeout warning window. Exits remain valid; no new deploys | `in-progress` |
| `ended` | Every participant has reached a terminal phase, or the hard timeout elapsed and any still-`raid`/`extracting` participants were force-ended with `outcome: "aborted"` | `completed` \| `aborted` (`settlement.md` §2 — `outcome_reason`/`winner_team` stay null for `mode='extraction'`) |

`spinning-up`/`collapsing`/`ended` durations and the join window are data (P3-11), not ruled
here — mirroring `bomb-rules.md` §2's split between mechanism (this contract) and parameters
(data/human).

**Which of `completed`/`aborted` applies to `matches.status` at `ended`, when participants split
outcomes:** a mixed squad — one member `extracted`, another `dead`, a third individually
`aborted` by disconnect — is the *expected* shape of a normal run, not evidence the run itself
failed. `matches.status` is a run-level "did the raid server conclude this run through its own
mechanism" bit, never a per-participant aggregate; the real outcome mix lives where
`settlement.md` §2 already puts it, in each participant's `RunResult.outcome`
(`match_participants.stats`). Concretely:

- **`completed`** — the run reached `ended` through normal server operation, regardless of the
  per-participant outcome mix. This includes the hard-timeout branch: a timeout forcing
  still-`raid`/`extracting` participants to individual `outcome: "aborted"` is ordinary run
  mechanics (§1.1's own `ended` row), not a run-level fault, so it still reads as `completed`.
- **`aborted`** — reserved for run-level faults, not individual participant ones: (a) the run
  never had any participant reach `raid` (every deploy was released before spawn, per §2's
  `deploy`-disconnect note — nothing for settlement to process, same posture as a PvP
  no-contest), or (b) the raid-server-fault path in §2's table applies to the whole run (it
  cannot itself determine outcomes for the remaining participants and has no trustworthy last
  state to fall back on for any of them).

A single participant's individually-`aborted` phase (§2) never by itself moves `matches.status`
to `aborted` — that would conflate one squad member quitting with the raid server failing to do
its job, which is exactly the ambiguity `settlement.md` §2 already refuses to let
`outcome_reason`/`winner_team` paper over for extraction rows.

### 1.2 Squads

A **squad** is the group a participant queued and deployed with — solo play is a squad of size
one. Formation (queueing, invites, ready-check) happens upstream, in the lobby/matchmaking flow
that precedes `deployment.md`'s reservation; **this contract does not own or specify that flow**,
only the identifier it produces and this contract's own consumption of it.

**A run does not equal one squad.** One `matches` row (`mode='extraction'`) can host several
squads deployed into the same sector set concurrently — nothing in §1's per-`(runId,
accountId)` participant model, or in `settlement.md` §2's independent per-participant
settlement, requires or assumes a 1:1 run↔squad relationship. `requiresSquadCount` (§4) counts
members of *one* squad in a volume together; it says nothing about how many squads share the
run.

**Schema representation:** every participant carries a `squadId` (text, ULID) — a squadmate of
one participant is any other participant in the same run with the same `squadId`. Rather than
add a new column, this contract proposes reusing `match_participants.team`
(`db-schema.md` §4): under `mode='extraction'`, that column holds `squadId` instead of an
`'alpha'|'bravo'` team label. This is compatible today with no migration — unlike
`matches.winner_team`, `match_participants.team` carries no CHECK constraint restricting its
values (`db-schema.md` §4), so the reuse is a documented convention, not a schema change. (This
is one of the open items §0 tracks toward `REVIEW`.)

**What this contract still cannot resolve on its own:** `squadId` has to exist *before*
`deployment.md`'s reservation is created, and that contract's reservation row (`deployment.md`
§2) has no field to carry it through to admission-time `match_participants` insertion today.
That is a `deployment.md` amendment this contract cannot make unilaterally — recorded as a
dependency (§0), the same posture this contract already takes toward `items-inventory.md`'s
container addition.

## 2. Why "aborted" needs raid-server judgment, not a client's word

`settlement.md` §4 defines `aborted` as one disposition (lose everything, same as `died`) but
deliberately does not enumerate *why* a participant ended up there — that judgment belongs to
whichever system observed it, which is this contract:

| Situation | Outcome this contract submits |
|---|---|
| Disconnect during `raid`/`extracting`, no reconnect within grace (`auth.md` §7 window, same grace `bomb-rules.md` §9 uses) | `aborted` |
| Run hard timeout elapses while the participant is still `raid` or `extracting` | `aborted` |
| Raid server itself faults (crash, sector unload) before it can determine which of the above applies, but a recent, trustworthy heartbeat names the participant's last phase | `server-failure`, `lastKnownState` from that heartbeat |
| Raid server faults with **no** trustworthy last state | Not submitted at all — `settlement.md` §7.2's stall detector is the correct backstop, not a guess dressed up as `server-failure` (§4.1 forbids exactly that) |

Disconnect and timeout are scored as `aborted` — a full loss, same as death — on purpose: a
participant who quits or stalls to avoid a loss they're about to take gets the loss anyway. A
disconnect during `deploy` (before the participant's entity ever spawns) is not covered by this
table — `deployment.md` §5.1 releases the reservation, `location` never left `permanent`, and
there is no participant row for this contract to report on.

## 3. World and run loot

Run inventory is exactly what `items-inventory.md` §4 says it is: `item_instances` rows with
`location='run', run_id=<this run>, owner_account_id=<accountId>`. Nothing here is a parallel
ledger — every piece of loot in a raid, whether it started in a participant's loadout or was
picked up mid-raid, is a real instance row, subject to the same lock and duplication guarantees
`items-inventory.md` §9 already proves.

### 3.1 Containers

A **container** is the abstraction backing world-placed and player-dropped loot. It is not an
`item_instances` row — it groups the instances sitting at one place.

```sql
world_loot_containers(
  container_id       text primary key,           -- ULID
  run_id             text not null references matches,
  kind               text not null,               -- 'static'|'dropped'
  tier               int,                          -- 1|2 for this slice; null for 'dropped'
  loot_table_id      text,                         -- null for 'dropped'
  position           jsonb not null,               -- {x,y,z}
  state              text not null default 'sealed',  -- sealed|opened
  opened_by_account_id text references accounts,
  opened_at          timestamptz,
  created_at         timestamptz not null default now(),

  check (kind in ('static','dropped')),
  check (state in ('sealed','opened')),
  check (kind <> 'dropped' or state = 'opened')   -- a drop is never sealed; nothing to hide
)
```

**Addition proposed to `items-inventory.md`'s `item_instances`** (additive — both contracts are
`DRAFT`): a nullable `container_id text references world_loot_containers`, non-null iff
`location in ('world','container')`. `location='container'` means the instance sits inside a
`sealed` container and is not individually visible to any client; `location='world'` means it
is loose and interactable — either because its container was `opened`, or it is a `dropped`
container's contents (always `world`, per the CHECK above).

**Death does not spawn loot.** `settlement.md` §4 sends every surviving run-location instance to
`status='lost'` on `died`/`aborted` — not to `location='world'`. There is no death pile in this
slice, nothing a squadmate or another player can loot off a corpse. That is a real gap for a
future PvP-looting pass (P4+), recorded rather than designed around: reintroducing it here would
need a schema change neither sibling contract currently supports (a `'lost-but-lootable'`
disposition `settlement.md` §4 explicitly says it does not add a third of).

**All `static` container contents are rolled at `spinning-up`, deterministically, from the run
seed:** `contents = roll(lootTableId, hash(runSeed, containerId))`, creating `item_instances`
rows at `location='container', container_id, owner_account_id=null, status='active'`
immediately. Rolling once for the whole run — not lazily on first open — means the outcome is
reproducible from `(runSeed, sectorVersion, lootTableVersion)` alone, with no dependency on
tick-of-open order. Contents are never revealed to any client before the container transitions
to `opened`; rolling early is an internal determinism property, not an early reveal.

#### 3.1.1 Determinism inputs — storage and the pinned algorithm

The three values above live in exactly one place each, so "reproduce this run's loot" is never
a guess about which system's copy is authoritative:

| Value | Storage | Set when |
|---|---|---|
| `runSeed` | **Additive column `matches.run_seed text not null`** (proposed here, §0) | Run allocation — before `spinning-up` starts, so every static container rolls against the same seed |
| `sectorVersion` | **Not a new column** — `matches.map_version` (`db-schema.md` §4), already required non-null on every row. Sector footprints are authored as part of map data (`sector-interest.md` §3: "declared in map data... the same authoring shape `map-data.md` already uses"), so a map version already pins them; a separate column would be a second name for the same fact |
| `lootTableVersion` | **Additive column `matches.loot_table_version text not null`** (proposed here, §0) | Run allocation, alongside `run_seed` — pins which loot-table definitions (weights, tiers, contents) this run rolled against, independent of code deploys that may retune tables between runs |

`roll()`/`hash()`, pinned rather than left implementation-defined (same posture `deployment.md`
§4.1 takes naming HMAC-SHA256 for the snapshot signature, rather than "a signature"):

1. `hash(runSeed, containerId) = HMAC-SHA256(key = runSeed, message = containerId)`, first 8
   bytes read big-endian as a `uint64` — the per-container seed. Keyed (not a plain digest) so
   two different runs sharing a coincidentally-similar `containerId` space never correlate.
2. `roll(lootTableId, seed)` seeds a `mulberry32` PRNG (single `uint32` state, no external
   dependency, already deterministic across Node/browser) with the low 32 bits of that `uint64`,
   then walks the `lootTableVersion`-pinned table's entries **in a fixed order** — ascending by
   the entry's own stable `id`, never insertion or iteration order — sampling per entry against
   its authored weight. Fixed entry order is what makes two independent rolls agree bit-for-bit;
   an unordered walk would let two conforming implementations disagree on nothing but iteration
   order and still call it correct.

Both are pure functions of their inputs — no wall-clock, no counter, no I/O — which is what
§9.7's "reproducible... across two independent rolls" verification control is actually testing.

### 3.2 Pickup — server authority

A pickup is one atomic conditional `UPDATE`, the same pattern `items-inventory.md` §6.2 uses to
make concurrent deployment a database guarantee rather than an application race. This is the
non-stackable path — a serialized weapon or gear item, where the picked-up row simply becomes
the participant's run-location row:

```sql
UPDATE item_instances
SET location = 'run', run_id = $run_id, container_id = null,
    owner_account_id = $account_id, updated_at = now()
WHERE instance_id = $instance_id
  AND location = 'world'
  AND owner_account_id IS NULL
  AND status = 'active';
-- Pickup succeeds iff rowcount = 1. rowcount = 0 means the instance was already picked up
-- (by anyone, including this same player double-clicking) or its container was never opened —
-- both refused the identical way, per bomb-rules.md's "no partial credit" posture.
-- container_id = null is required, not cosmetic: items-inventory.md §2's own CHECK
-- (location in ('world','container') or container_id is null) rejects this row the moment
-- location flips to 'run' unless container_id is cleared in the same statement — a world- or
-- container-located row always carries a non-null container_id under that same CHECK, so
-- leaving it untouched here is not underspecified, it is a write Postgres refuses.
```

Opening a `sealed` static container is the precondition, validated first: player alive, phase
`raid`, in interact range, container `state='sealed'`. On success, `UPDATE world_loot_containers
SET state='opened', opened_by_account_id, opened_at` and every instance it holds flips
`location: 'container' → 'world'` **in the same transaction** — this makes contents visible, not
yet owned; a subsequent pickup per instance is still required. **Two players opening one
container on the same tick**: the `state='sealed'` guard in the container `UPDATE`'s `WHERE`
clause means only the first-applied transaction can flip it; the second finds `rowcount=0` and
is refused — identical resolution to `match-result.md` §3.1's simultaneous-kill tie-break, and
to `items-inventory.md` §6.2's concurrent-lock case.

**Two players reaching for one already-`world` instance on the same tick**: the pickup `UPDATE`
above is the guard — `location='world'` in its `WHERE` clause means only the first-applied
pickup can flip it to `run`; the second finds `rowcount=0`. One instance, one owner, ever — the
same invariant `items-inventory.md` §9 invariant 1 already asserts for the whole table.

#### 3.2.1 Pickup of a stackable item — merge, not a second row

Ammo and consumables are `stackable` definitions (`items-inventory.md` §2), explicitly routed
through world/container loot by that contract's §3.1 rule 5. The plain `UPDATE` above is wrong
for them whenever the participant already holds an active, unlocked run-location row of the same
`item_id`: flipping the picked-up row to `location='run', run_id=$run_id` would create a *second*
active, unlocked row for `(owner_account_id, item_id, 'run', run_id, '')`, colliding with
`items-inventory.md` §2's `item_instances_stackable_collapse` partial unique index and aborting
the transaction with a `unique_violation` rather than completing the pickup.

`items-inventory.md` §5 already defines the `merged` terminal status for exactly this case; this
contract invokes it, in one transaction, as a single statement so the merge-or-not decision and
the quantity fold are atomic with the pickup itself:

```sql
WITH picked AS (
  UPDATE item_instances
  SET location = 'run', run_id = $run_id, container_id = null,
      owner_account_id = $account_id, updated_at = now(),
      status = CASE WHEN EXISTS (
        SELECT 1 FROM item_instances existing
        WHERE existing.owner_account_id = $account_id
          AND existing.item_id = item_instances.item_id
          AND existing.location = 'run' AND existing.run_id = $run_id
          AND existing.status = 'active' AND existing.locked = false
      ) THEN 'merged' ELSE 'active' END
  WHERE instance_id = $instance_id
    AND location = 'world' AND owner_account_id IS NULL AND status = 'active'
  RETURNING instance_id, item_id, quantity, status
)
UPDATE item_instances existing
SET quantity = existing.quantity + picked.quantity, updated_at = now()
FROM picked
WHERE picked.status = 'merged'
  AND existing.owner_account_id = $account_id AND existing.item_id = picked.item_id
  AND existing.location = 'run' AND existing.run_id = $run_id
  AND existing.status = 'active' AND existing.locked = false
  AND existing.instance_id <> picked.instance_id;
-- The picked-up row's own quantity is preserved on its now-'merged' row (items-inventory.md §5:
-- "a terminal status with an audit trail, rather than a delete that leaves no trace of where the
-- quantity went") — only the existing stack's row gains it. If no existing stack row was found,
-- `picked.status = 'active'` and the second statement's WHERE never matches: the row simply
-- becomes the participant's first run-location stack of that item, identical in effect to the
-- non-stackable path above.
--
-- The EXISTS check and the pickup UPDATE share one statement, but a second concurrent pickup of
-- a different world instance of the same item can still race past the EXISTS check before either
-- commits. That race is not this statement's job to close — item_instances_stackable_collapse
-- (items-inventory.md §2) is the backstop of record: the loser's transaction aborts on
-- unique_violation and the caller retries the pickup, which then observes the winner's row via
-- EXISTS and takes the merge branch. The index is authoritative; this statement is the
-- optimistic common-case path, the same posture items-inventory.md §6.2 already takes toward its
-- own lock UPDATE.
```

This merge path applies only when the picked-up instance's `item_definitions.stackable = true`
(`items-inventory.md` §2); the raid server checks that flag before choosing between this
statement and the plain `UPDATE` in §3.2. A non-stackable pickup always uses the plain path.

### 3.3 Drop — server authority

```sql
-- 1. Create the dropped container.
INSERT INTO world_loot_containers (container_id, run_id, kind, position, state)
VALUES ($new_id, $run_id, 'dropped', $player_position, 'opened');
-- 2. Move the instance into it.
UPDATE item_instances
SET location = 'world', container_id = $new_id, run_id = null, owner_account_id = null,
    updated_at = now()
WHERE instance_id = $instance_id
  AND location = 'run' AND run_id = $run_id AND owner_account_id = $account_id
  AND locked = false AND status = 'active';
-- run_id = null is required, not cosmetic: items-inventory.md §2's own CHECK
-- (location = 'run' or run_id is null) rejects this row the moment location leaves 'run' unless
-- run_id is cleared in the same statement — the mirror image of §3.2's container_id fix above,
-- same class of bug in the opposite direction.
```

`locked = false` in the guard matters: a currently-`locked` loadout instance cannot be dropped
by this path — `items-inventory.md` §6.4 already forbids any mutation of a locked row besides
the deployment/settlement transitions that own it, and drop is neither. Only run-acquired loot
and already-unlocked instances can move. Dropping is permitted only in `raid` — the phase check
in both pickup and drop preconditions excludes `extracting`, so a channel in progress can't race
a drop against the extraction outcome.

## 4. Extraction exits

An exit is a volume plus zero or more conditions, data-authored (P3-11 — build plan calls for
two conditional exits in this slice) against this mechanism. `volume` is not a new shape: it is
`map-data.md` §3.3's objective-volume box idiom, verbatim — an axis-aligned box, the same
convention `sector-interest.md` §3 already points to for its own sector footprints ("the same
authoring shape `map-data.md` already uses for spawn/objective volumes"). An extraction exit is
authored exactly like a Bomb `kind: 'zone'` objective volume, just consumed by this contract's
mechanism instead of `bomb-rules.md`'s:

```
ExtractionExit = {
  id,                               // stable forever once shipped, per map-data.md §3.3's convention
  volume: { min: Vector3, max: Vector3 },  // map-data.md §3.3's box idiom
  requiresItemDefId?: string,      // must be present among the participant's location='run' instances
  requiresSquadCount?: int,        // that many participants sharing one squadId (§1.2) in the volume at once
  activeWindow?: [startTick, endTick]  // run-relative; null = always active
}
```

"Feet inside the exit volume" (§4.1, condition 2) uses the identical ground convention
`map-data.md` §3.3 already establishes for its own `box` volumes — no separate containment rule
to define here.

### 4.1 Channel

Preconditions, validated **every server tick** the channel is running — not just at start,
because a condition that only needs to be true once is not a condition, it's a formality:

1. Phase `raid`, alive.
2. Feet inside the exit volume.
3. Every declared condition on the exit currently holds (item present, squad count met, window
   open).
4. Interact key held continuously (same input model as `bomb-rules.md` §6.4).

Interrupted by: releasing the key, leaving the volume, any condition becoming false, or death.
**Progress resets to zero on interrupt — no partial credit, no resume** — identical rule to
plant/defuse (`bomb-rules.md` §6, §7), for the identical reason: a resumable channel makes "how
much progress carries over" a second thing implementations disagree about.

Channel duration is a parameter per exit (data, P3-11; mechanism only, here — same split as
§1.1 and `bomb-rules.md` §2). On completion: phase → `extracted`, `extraction.exit.completed`
emitted with `exitId`, the participant's `location='run'` instance set frozen — nothing further
can pick up, drop, or otherwise change it before `RunResult` submission (§6).

## 5. What this contract does **not** decide

To keep the boundary with `settlement.md` unambiguous:

| Question | Answer, and where it's answered |
|---|---|
| What happens to a participant's items on `died`/`aborted`? | Every surviving `location='run'` row → `status='lost'` — `settlement.md` §4, applied in its §6 transaction. This contract never mutates `item_instances` for a loss |
| What happens on `extracted`? | Every surviving `location='run'` row → `location='permanent', run_id=null` — same, `settlement.md` §4/§6 |
| Is any item protected from loss? | No — `items-inventory.md` has no protection field, and `settlement.md` §4 applies its disposition uniformly across every surviving row regardless of whether it entered via loadout or pickup. If protection is wanted later it is `items-inventory.md`'s amendment to make, not something this contract can honor unilaterally |
| Who clears the item lock? | `settlement.md` §6, in the same transaction as the terminal disposition — this contract never touches `locked`/`locked_by_deployment_id` |
| Who decides an ambiguous/contested settlement? | `settlement.md` §7's exception queue. This contract's only obligation is to submit a `RunResult` (§6) that is honest about what it actually knows, including declining to claim `server-failure` when it can't back it with `lastKnownState` (§2) |

## 6. Submitting the `RunResult`

The wire shape, endpoint, idempotency rules, and everything after submission are
`settlement.md` §5/§6 verbatim — this section states how this contract's raid server computes
each field, not a second definition of the shape itself.

```
POST /v1/runs/:runId/result       [SERVICE ONLY — settlement.md §5]
```

| `RunResult` field (`settlement.md` §5.1) | How this contract computes it |
|---|---|
| `runId` | `matches.match_id` this raid instance was allocated (`deployment.md` §4.3) |
| `participants[].accountId` | Every account that reached `raid` (i.e., a spawn actually happened — `deploy`-only participants never appear, per §2's `deploy`-disconnect ruling) |
| `participants[].outcome` | `extracted` at §4.1 channel completion; `died` at zero-health; `aborted` per §2's table; `server-failure` only with a backing `lastKnownState` (§2, `settlement.md` §4.1) |
| `participants[].exitId` | The `ExtractionExit.id` (§4) that completed the channel — required iff `outcome='extracted'` |
| `participants[].deathCause` | Closed enum `player`\|`ai`\|`environment`, from the raid server's own combat resolution — required iff `outcome='died'` |
| `participants[].lastKnownState` | `{ phase, exitId }` from the most recent tick this participant was known-good: `phase='at-exit'` while `extracting`; `phase='looting'` while `raid` with ≥1 completed pickup; `phase='not-looted'` while `raid` with zero pickups. Required iff `outcome='server-failure'` — see §2 for when this contract is and is not permitted to claim it |
| `startedAt`/`endedAt`, `serverBuild`, `sectorSet` | Raid server's own run bookkeeping, same posture as `match-result.md` §4's equivalent fields |
| `evidenceRef` | This contract's own construction, §7 |

**§4.1's outcome matrix, restated as a computation table, is the acceptance bar for this
section**: given the phase-machine state this contract already maintains (§1, §2), producing
each `RunResult` field is a direct read, never an inference the raid server has to make up on
the spot.

## 7. Evidence

`evidenceRef` points at the raid's compact authoritative record, same construction
`match-result.md` §7 requires for a match: reconstructable from server-side facts alone, with no
client input. For a run, that record additionally carries the `lootEvents` timeline this
contract is the sole producer of:

```jsonc
{
  "runId": "…", "runSeed": "…",             // reproduces every static container's contents (§3.1)
  "participants": [ { "accountId": "…", "phaseLog": [ { "tick": 0, "phase": "raid" }, … ] } ],
  "lootEvents": [
    { "tick": 0, "accountId": "…", "instanceId": "…", "containerId": "…",
      "containerKind": "static|dropped", "action": "opened|picked_up|dropped" }
  ],
  "deathFacts": [ { "accountId": "…", "position": { "x": 0, "y": 0, "z": 0 }, "cause": "player|ai|environment" } ]
}
```

`lootEvents` ordered by tick is what makes a duplicated-container claim or a disputed pickup
reconstructable after the fact — the same role `match-result.md` §7's event timeline plays for a
disputed kill. `settlement.md` §7.1 already checks `evidenceRef` digest/reconstruction failure as
an ambiguity trigger; this is the record that check runs against.

## 8. Events

`<domain>.<entity>.<past-tense-verb>`, per `event-envelope.md` §5 — additive to that contract's
catalogue, same posture `deployment.md` §6 and `settlement.md` §9 already take for their own new
types:

| Type | Actor | Subject | Privacy | Retention |
|---|---|---|---|---|
| `extraction.run.started` / `extraction.run.ended` | service | match | internal | standard |
| `extraction.participant.spawned` | service | match | internal | standard |
| `extraction.container.opened` | player | match | internal | standard |
| `extraction.item.dropped` | player | match | internal | standard |
| `extraction.exit.completed` | player | match | internal | standard |

`subject.kind` is `match` throughout (a run is a `matches` row, `settlement.md` §2), so ordering
follows `event-envelope.md` §3's per-subject rule automatically. Not `run.*` —
`settlement.md` §9 already claims `run.ended`/`run.settled`/`run.exception.*` for the
settlement-side lifecycle; this catalogue's `extraction.*` prefix keeps the two producers'
event types from colliding on name while sharing the same `subject.kind`.

**`extraction.run.ended` and `settlement.md`'s `run.ended` are two different events about the
same run, not two names for one moment — `settlement.md` §5.2 is the normative statement of the
boundary, restated here so this contract's own producer role is equally explicit:**

| | `extraction.run.ended` (this contract) | `run.ended` (`settlement.md` §9) |
|---|---|---|
| Producer | The raid server (P3-03), this contract | The platform, at the `POST /v1/runs/:runId/result` handler (`settlement.md` §5.2) — **not** the raid server |
| Fires when | §1.1's run-lifecycle reaches `ended` — this contract's own participant/run phase machine concludes | A `RunResult` submission is received for the run, before any of `settlement.md` §6's per-participant settlement transactions run |
| Says | "The raid server's job is done; here is what it observed" | "The platform has the terminal record and settlement is starting" |
| Consumers | Raid-server-adjacent observers of this contract's own lifecycle — the raid HUD, this contract's own evidence/telemetry tooling | `settlement.md`'s own machinery and its consumers (P3-10 post-run presentation, Admin Portal) |

**Order is causal, not merely conventional:** `extraction.run.ended` always precedes `run.ended`,
because the platform cannot receive a `RunResult` submission (`settlement.md` §5.2's trigger)
before this contract's raid server has reached `ended` and constructed one (§6 of this
contract). A consumer that needs "the raid is over" reacts to `extraction.run.ended`; a consumer
that needs "settlement has started for this run" reacts to `run.ended` — neither event is a
substitute for the other, and this contract's own consumers (§8's table above) are never
expected to listen for `run.ended` instead.

## 9. Verification — `scripts/extractiontest.mjs` (to be written alongside implementation)

Each with its failing control, mirroring `bomb-rules.md` §12's pattern:

1. Every §1/§1.1 phase transition, in isolation, including the illegal ones refused.
2. Two players opening one container on the same tick: first-applied wins, second refused
   (§3.2).
3. Two players picking up the same already-`world` instance on the same tick: same resolution,
   one owner ever.
4. Extraction channel interrupted at every boundary: first tick, last tick, one tick before
   completion, by volume-exit, by condition-false, by death. Progress resets, no partial credit.
5. Every §2 aborted case (disconnect-past-grace, hard timeout) produces `outcome: "aborted"`;
   a raid-server fault with a trustworthy last phase produces `outcome: "server-failure"` with
   a `lastKnownState` that matches §6's computation table; a fault with no trustworthy last
   phase produces **no submission** at all, leaving `settlement.md` §7.2's stall detector to
   open the exception.
6. A `RunResult` this contract constructs never sets more than one of `exitId`/`deathCause`/
   `lastKnownState` non-null, and always sets exactly the one §5.1 requires for its `outcome`.
7. Static container contents are reproducible from `(runSeed, sectorVersion, lootTableVersion,
   containerId)` alone across two independent rolls (§3.1, §3.1.1) — including a roll performed
   against `matches.map_version` and `matches.loot_table_version` read back from storage, not
   from values still held in memory from the original roll.
8. `evidenceRef` is reconstructable from `lootEvents`/`phaseLog`/`deathFacts` alone (§7), with no
   client-supplied input accepted anywhere in the chain.
9. This contract never issues an `item_instances` write outside §3.2/§3.2.1/§3.3's pickup/drop
   paths — asserted by diffing every `item_instances` row touched during a full run against those
   statements' predicates, confirming §5's boundary holds in practice, not just on paper.
10. **Determinism:** two identical runs from one run seed and one input stream produce identical
    loot events, identical phase logs, and identical evidence.
11. Every §3.2/§3.3 write leaves the row `items-inventory.md` §2's CHECKs would accept — in
    particular, no pickup ever leaves a `location='run'` row with a non-null `container_id`, and
    no drop ever leaves a `location='world'` row with a non-null `run_id` — asserted by running
    each CHECK expression against every row touched, not merely by not observing a Postgres
    rejection in a happy-path test.
12. Stackable pickup (§3.2.1): picking up a second world instance of an item the participant
    already holds at `location='run'` for the same run produces exactly one active row for that
    `(owner, item_id, run)` with the summed quantity, and the picked-up row transitions to
    `status='merged'` with its own quantity field unchanged (`items-inventory.md` §5). Two
    concurrent pickups of two different world instances of the same stackable item, by the same
    participant, still leave exactly one active row after both complete — the loser's
    `unique_violation` retry (§3.2.1) takes the merge branch, not a second active row.
