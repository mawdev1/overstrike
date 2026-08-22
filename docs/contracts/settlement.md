# Contract 17 — Post-run settlement and the exception queue

| | |
|---|---|
| **Status** | `FROZEN` |
| **Version** | 1.0.0 |
| **Owner** | [CC] Claude Code |
| **Consumers** | Raid server (P3-03), platform, [CX] post-run settlement presentation (P3-10), Admin Portal |
| **Depends on** | `db-schema.md` (2.1.0; migration 0029 additionally landed the `mode='extraction'` CHECK amendments, §0), `event-envelope.md` (1.4.0), `match-result.md` (2.0.0) for idiom, `http-api.md` (`FROZEN` 2.2.0) §1 for the response-envelope convention this contract's endpoint uses (§0, §5.3), `items-inventory.md` (`DRAFT` 1.0.0, P3-01) for the instance state machine settlement drives, `deployment.md` (`DRAFT` 1.0.0, P3-02) for how a run's `item_instances` locks were acquired |

---

## 0. Status

`FROZEN`, `1.0.0`. It composes directly with `items-inventory.md`, itself still `DRAFT`; if
that contract's §4/§5/§6 shapes change before it reaches `REVIEW`, §6 and §8 here move with it —
that composition risk is not gated on this contract's own status. Three open items were carried
in the original draft of this section, each an amendment to a document this contract cannot
itself edit (`db-schema.md` and `http-api.md` are both `FROZEN`). All three have since been
investigated to a close, following a fix round after an adversarial review found this section
still read `DRAFT` under a header that already said `FROZEN`. Recorded here rather than silently
resolved:

1. **`db-schema.md`'s mode-conditional `matches` CHECK amendments — landed.** Migration
   `platform/migrations/0029_settlement.sql` extends `mode` to include `'extraction'`, adds the
   `mode='extraction'` disjunct to the outcome/status CHECK, and adds the `mode='extraction'`
   disjunct to the terminal-completeness CHECK that drops the `team_scores`/`rounds`
   non-null requirement for a run — matching all three sub-items originally listed here exactly,
   plus the additive `settlement_exceptions` table (§7.3) and one amendment not originally named:
   a run also has no `ruleset_version`/`stat_definition_version`/`map_version` to snapshot, so the
   migration disjuncts those out of the terminal-completeness CHECK for `mode='extraction'` too
   (see the migration's own header comment for why). `db-schema.md`'s own §4 prose still shows the
   pre-0029 CHECK text — that document's body has not been updated to narrate the amendment its
   own migration directory already contains, which is a `db-schema.md` housekeeping gap, not a
   blocker on this contract: the migration is what the database actually enforces, and it is what
   this contract is written against.
2. **`http-api.md` §1's partial-success carve-out — landed.** `settlement.md` §5.3's reading (a
   2xx from `POST /v1/runs/:runId/result` means every participant reached a terminal disposition,
   not that every participant's items moved) is real, shipped behavior
   (`platform/src/modules/settlement/index.js`), not a hypothetical this contract was asking
   permission for in the abstract. `http-api.md` 2.2.0 (additive; `CHANGELOG.md` 2026-08-22) adds
   the carve-out sentence §5.3 needed: an endpoint's owning contract may declare an atomic unit
   smaller than the whole request, in which case a 2xx means every declared unit reached its own
   terminal state. This endpoint is the sentence's sole current example.
3. **`http-api.md` §8's idempotency-hash scoping for sub-request atomic units — not landed;
   accepted as a non-blocking deviation, not pursued.** Investigation found the premise
   incomplete: §8 describes a generic whole-request idempotency layer, but no such layer exists in
   the codebase — `applyMatchResult` (`match-result.md` §5, `platform/src/modules/profile/stats.js`)
   and `submitRunResult` (§5, `platform/src/modules/settlement/index.js`) each perform their own
   hash comparison inline, in their own transaction, and each throws `CONFLICT` directly on a
   differing-hash replay — never `IDEMPOTENCY_KEY_REUSED`, which nothing in either module emits.
   `submitRunResult`'s comparison is scoped to the whole `RunResult` payload, exactly as
   `applyMatchResult`'s is scoped to the whole match result: a differing-hash replay against an
   idempotency row already stored (i.e., every participant already resolved) is `CONFLICT` for the
   whole request, not per-participant. §7.1's race trigger (two differing-payload submissions
   arriving before either commits) does not go through this comparison at all — neither submission
   finds a stored idempotency row yet, so both proceed into §6's per-participant transactions,
   where the transaction-level and row-level idempotency already described in §6 resolves the race
   without needing §8 scoping. The one scenario the proposed amendment would have changed — a
   differing-hash retry against an *already-fully-resolved* run, where only one participant's
   field actually differs — is not reachable by anything §5 or §7 requires this contract to do
   differently in that case, and `match-result.md` has shipped the identical whole-request
   construction without needing this amendment. §5 rule 4 and §7.1 below are corrected to describe
   this contract's actual, shipped behavior rather than a behavior gated on an amendment that was
   investigated and found unnecessary.

## 1. Why settlement is not "the same thing as match-result, renamed"

`match-result.md` settles a **team outcome** — two rosters, one winner, career counters that
only ever add. A run settles a **per-participant possession outcome** — which specific item
instances a participant carries back out of a raid — and it moves items, which
`match-result.md` never does. A duplicated match-result application double-counts a stat that
self-heals on the next recompute (`match-result.md` §6). A duplicated settlement **converts or
destroys an item twice**, and `items-inventory.md` §9 invariant 6 makes that specific failure
the one its whole schema is built to make provable, not just preventable.

The house idempotency mechanism is `event-envelope.md`'s transactional outbox, reused here
exactly as `match-result.md` §5 reuses it for match results. What is new is not the mechanism —
it is that settlement is the first place an idempotent write must call into another domain's
own idempotent write (`item_instances` transitions) and commit both or neither, and that
"neither, and we don't know why" needs an operational answer instead of an infinite retry: the
exception queue.

## 2. Terms and where a "run" lives

A **run** is one raid attempt: deploy → loot/fight → terminal event. `items-inventory.md` §2
already commits to this by writing `item_instances.run_id references matches` — a run is a
`matches` row (`db-schema.md` §4), allocated the same way, sharing the same id space, with
`mode` extended to a new value (`'extraction'`, the literal string landed in migration 0029)
rather than a parallel table. This contract does not introduce a `runs` table.

**What does not carry over cleanly:** `matches.status`'s CHECK constraints (`db-schema.md` §4)
close `outcome_reason` to `elimination|defuse|detonation|timer` on `completed` and
`forfeit|abandon|no-contest` on `aborted` — all PvP vocabulary, and none of it is
`extracted|died|server-failure`. This contract does **not** repurpose those columns for
per-participant extraction outcomes. Instead:

- `matches.status` for a run uses only the mode-agnostic values already in the enum —
  `allocated`, `in-progress`, `completed`, `aborted` — meaning "the run ended," not which of
  §4's four outcomes applied to which participant. A run is never `invalidated` in this
  version; that path is out of scope until an anti-cheat case needs it.
- `matches.outcome_reason` and `winner_team` are **left null for `mode='extraction'` rows.**
  There is no team and no single winner; a per-participant field would force one row to hold
  five different truths.
- **Per-participant outcome lives in `match_participants.stats`** (`db-schema.md` §4), which is
  already `jsonb` for exactly this reason — "the stat set evolves per mode... a wide sparse
  column-per-stat table would need a migration for every new mode." §5.1's `RunResult` shape is
  what gets written there, one participant at a time.
- `matches.team_scores` and `matches.rounds` are **left null for `mode='extraction'` rows**, same
  reasoning as `outcome_reason`/`winner_team`: both are PvP-shaped `jsonb` (a per-team score
  object, a per-round record) with no defined extraction meaning, and inventing one to satisfy the
  terminal-row completeness CHECK below would be a fabricated value nothing ever reads. A run's
  per-participant result already lives in `match_participants.stats` (previous bullet);
  `team_scores`/`rounds` gain no analogous per-run shape in this version.

**The `db-schema.md` amendments this contract requires — landed in migration 0029** (§0 item 1
names all three; this is where each was specified before the migration was written):

1. **The `mode` enum.** `check (mode in ('tdm','bomb'))` rejected `mode='extraction'` before any
   other CHECK on the row was evaluated — a run could not be inserted as a `matches` row at all
   until this was lifted. The amendment, landed verbatim in migration 0029: `check (mode in
   ('tdm','bomb','extraction'))`; it touches nothing else.
2. **The `outcome_reason`/status CHECK.** The CHECK in `db-schema.md` §4 that ties
   `outcome_reason` to `status` per-row does not currently have a `mode='extraction'` branch that
   permits `outcome_reason is null` on a `completed`/`aborted` row — today that combination reads
   as violating the "every `completed` row has one of the four PvP reasons" check. The amendment
   is additive (a new disjunct, gated on `mode='extraction'`, permitting `outcome_reason is null`
   and `winner_team is null` regardless of status) and does not touch the PvP branches.
3. **The terminal-row completeness CHECK.** `db-schema.md` §4 requires `team_scores`, `rounds`,
   `evidence_ref`, `started_at`, `ended_at` all non-null on any row with `status` not in
   `('allocated','in-progress')` — i.e. on a completed or aborted **run** too, not just a match.
   `evidence_ref`/`started_at`/`ended_at` are supplied by `RunResult` (§5.1) and need no schema
   change; `team_scores`/`rounds` are deliberately left null for a run (previous bullet), which the
   completeness CHECK as written forbids. The amendment is a `mode='extraction'` disjunct that
   drops `team_scores is not null` and `rounds is not null` from the conjunction for that mode
   only, leaving the PvP branch's requirement on both columns unchanged.

All three shipped in `platform/migrations/0029_settlement.sql`, as specified above; an
implementer never had to discover any of them by hitting a CHECK constraint at write time.

### 2.1 Who writes `matches.status`, `started_at`, `ended_at` for a run

Unlike `outcome_reason`/`winner_team`/`team_scores`/`rounds`, these three columns are not left
null or repurposed — a run uses them exactly as an arena match does
(`match-result.md` §4.2's `pending` table: `allocated` with both null, `in-progress` with
`started_at` set, terminal with both set). `extraction-match.md` (P3-03) depends on this contract
for the run lifecycle, not the reverse (§0), so this contract — not that one — is where the
transition is pinned down, and it is pinned down in §5.2, at the one write site that already
executes ahead of any per-participant settlement: the `POST …/result` submission-received
transaction. See §5.2.

| Term | Meaning |
|---|---|
| `run` | A `matches` row with `mode='extraction'` |
| `RunResult` | The deterministic terminal record P3-03 produces and submits once (§5) |
| run inventory | `item_instances` rows with `location='run', run_id=<the run>` (`items-inventory.md` §4) |
| permanent inventory | `item_instances` rows with `location='permanent'` |
| settlement | The transaction that reads a submitted `RunResult`, applies §4's matrix, and drives every surviving run-location instance to its terminal disposition — or opens an exception instead |
| exception | A run or participant whose settlement did not commit because the correct disposition could not be determined with confidence |

## 3. Run/participant lifecycle

```
matches.status:        allocated → in-progress → completed|aborted
match_participants
  .stats.settlement
  Status (this          (absent)  →  'ended'  →  'settled' | 'exception-open' → 'exception-resolved'
  contract, jsonb key)
```

`matches.status` reaching a terminal value means the raid server says the run is over — it says
nothing about whether items have moved. That is `match_participants.stats.settlementStatus`,
tracked per participant because a squad can split outcomes: one member extracts while another
dies in the same run, and one participant's settlement must never block or partially apply
another's.

| `settlementStatus` | Meaning | Reached by |
|---|---|---|
| *(absent)* | Run not yet ended for this participant | — |
| `ended` | Raid server has a terminal outcome and is submitting or has submitted it | The `POST …/result` submission-received step, §5.2 — not written by the raid server directly and not written by the per-participant settlement transaction of §6 |
| `settled` | `RunResult` accepted, §4 applied, `item_instances` transitions committed **exactly once** | Successful settlement transaction (§6) |
| `exception-open` | Settlement could not commit with confidence | An ambiguity trigger (§7.1) |
| `exception-resolved` | A reviewer's decision applied through the same settlement path (§7.4) | Exception resolution |

`settled` and `exception-resolved` are the only terminal-and-final states. Neither reverses in
this version — the identical constraint `match-result.md` §5.2 states for match invalidation,
for the identical reason: no compensating-delta mechanism exists yet, so nothing is allowed to
need one.

## 4. The outcome matrix

Four legal `RunResult.participants[].outcome` values, matching the Build Plan's P3-04 wording
exactly. Each maps to exactly one of the two dispositions `items-inventory.md` §4 already
defines for run-location instances — settlement does not invent a third.

| `outcome` | Meaning | `item_instances` disposition (`items-inventory.md` §4) |
|---|---|---|
| `extracted` | Participant reached a validated exit (P3-03) before the run ended | Every surviving `location='run', run_id=<this run>, owner_account_id=<this participant>` row: `location='permanent', run_id=null` |
| `died` | Participant's character died, any cause, before extraction | Every such row: `status='lost'` |
| `aborted` | Run ended with the participant neither extracted nor dead — disconnect past grace, voluntary quit, or a run cancelled server-side | Same as `died`: `status='lost'`. `items-inventory.md` §4 draws no distinction between death and abort, and this contract does not add one it has no schema support for |
| `server-failure` | The raid server detected and reported its own fault, with a last-known participant state precise enough to rule | Ruled by the last-known state using **whichever of the three dispositions above** that state matches |

There is no "return the loadout untouched, as if never deployed" disposition — an earlier draft
of this contract proposed one for a zero-loot-exposure abort, and it does not survive contact
with `items-inventory.md` §4, which recognizes exactly two run-exit dispositions
(extract-convert, lose-everything) and no third. A participant who aborted before picking
anything up loses nothing **in effect**, because their run inventory is still exactly their
locked deployment snapshot — but it is still swept through the `died`/`aborted` disposition
(`status='lost'` on rows that happen to be identical to what they deployed with), not returned
by a separate code path. One disposition, applied uniformly, is what makes §9's "no `run`
instance outlives its match past settlement" invariant checkable without a third case to special
case around.

Locked-but-not-yet-deployed permanent-inventory rows are untouched by settlement either way —
their lock clears via the deployment lifecycle itself (`items-inventory.md` §6.4), not via a
settlement disposition, and a permanent-inventory row was never at `location='run'` in the first
place.

### 4.1 `server-failure` is deterministic, not a default

A `server-failure` outcome is only accepted when it carries a `lastKnownState` precise enough to
resolve to exactly one of `extracted`/`died`/`aborted` — it is not permitted to carry less
evidence than a clean outcome and settle anyway. If the raid server cannot produce that (partial
telemetry, a crash before any state was durably recorded, contradictory prior heartbeats), the
submission does not get to claim `server-failure` and rule itself — it fails validation and the
run is picked up by the stall detector (§7.2) instead. "The same action as whichever state it
matches" is a hard match against one of the three §4 rows, not a fourth interpretation.

## 5. `RunResult` submission

```
POST /v1/runs/:runId/result       [SERVICE ONLY]
Idempotency-Key: run-result:<runId>
```

`:runId` is a `matches.match_id` (§2). Same guarantees `match-result.md` §5 states for match
results, restated for runs:

1. Service-authenticated. Never browser-reachable — a client that can post its own run outcome
   grants itself loot.
2. Idempotency key derived from `runId` (`db-schema.md` §5 `idempotency_keys`, keyed
   `(key, actor_id)`, exactly as `match-result.md` uses it) — a retry is inherently the same key.
3. Replay with an identical payload returns the stored response without re-settling.
4. Replay with a **different** payload for a run already fully resolved (every participant
   `settled` or `exception-resolved`) is `CONFLICT` for the whole request — the same
   whole-request-hash-comparison construction `match-result.md` §5 rule 5 uses for matches, and
   for the identical reason: a second, different truth about where items went is a bug or an
   attack, never a correction (§0 item 3 records why this is whole-request, not scoped
   per-participant, and why that is accepted rather than pursued as an amendment). A
   differing-payload retry that arrives **before** the run is fully resolved does not hit this
   comparison at all — no stored idempotency row exists yet for it to differ from — and instead
   proceeds into §6's per-participant transactions, where §7.1's race trigger and the transaction's
   own row-level idempotency are what resolve it.
5. If the platform is unavailable, the raid server durably queues the result and a worker
   retries with backoff (`event-envelope.md` §4). No participant is held at an extraction screen
   waiting on it — P3-10's pending presentation covers this window.
6. Three identifiers must agree, same rule as `match-result.md` §5.1: `:runId` in the path is
   authoritative, `runId` in the body must match it, and `Idempotency-Key` must be exactly
   `run-result:<runId>`.

### 5.1 Request shape

```jsonc
{
  "runId": "01J…",
  "status": "completed|aborted",  // the RUN's own terminal disposition — did it conclude
                                   // normally ("completed") or was it torn down by the raid
                                   // server before that ("aborted": crash, admin kill, allocation
                                   // timeout). Independent of any participant's outcome below;
                                   // §2.1 and §5.2 specify why this is not the top-level
                                   // "outcome" this section otherwise refuses
  "participants": [ {
    "accountId": "…",
    "outcome": "extracted|died|aborted|server-failure",
    "lastKnownState": { "phase": "not-looted|looting|at-exit", "exitId": "…"|null }
                          | null,   // required iff outcome is "server-failure"; §4.1
    "exitId": "…"|null,            // required iff outcome is "extracted"
    "deathCause": "…"|null         // required iff outcome is "died"
  } ],
  "startedAt": "…", "endedAt": "…",
  "serverBuild": "…", "sectorSet": [ "…" ],
  "evidenceRef": "…"              // same construction as match-result.md §7: append-only,
                                   // reconstructable, digest-checked
}
```

Settlement is computed **per participant** — one squad member can extract while another dies in
the same run. There is deliberately no top-level `outcome`: `match-result.md` §4's single
`winnerTeam` exists because Bomb has one winning team; a run has none, and giving this shape a
top-level field that could disagree with its own `participants[]` array is exactly the
two-truths-in-one-row shape `match-result.md` §4.2 refuses for `winnerTeam`/`outcomeReason`. The
top-level `status` field above is not that field in disguise: it cannot disagree with any
participant's `outcome`, because it answers a different question — whether the run itself
concluded, not how any one participant fared inside it. `matches.status` for a run has no
per-participant analogue to disagree with in the first place (§2's bullet list).

Unknown top-level or participant keys are refused, per the same "a key the platform drops
silently is a key the sender believed was honoured" rule `match-result.md` §5.1 states for match
submissions.

### 5.2 The `ended` write — closing the gap between terminal detection and settlement

§3's lifecycle table names `ended` as the state a participant is in from the moment the raid
server has a terminal outcome until settlement resolves it, reached by "Raid server terminal
detection." Nothing else in this contract writes it — §6's transaction writes `settled` (or opens
an exception) directly, never passing through `ended` as a stored row — so this step pins down
where it comes from: **the `POST …/result` handler writes it**, not the raid server directly and
not §6.

Concretely, on receipt of a `RunResult` submission and before any of §6's per-participant
transactions run, the endpoint executes one transaction, scoped to the whole payload rather than
to any one participant (this is the one write in this contract that is intentionally run-level,
not participant-level). This is also the write site §2.1 points to for `matches.status`,
`started_at`, `ended_at`: nothing else in this contract transitions them, so this transaction is
where a run stops being `in-progress`, using the top-level `status`/`startedAt`/`endedAt` fields
§5.1 adds to `RunResult` for exactly this purpose — the same role the match server's own report
plays for an arena match's `pending`→terminal transition (`match-result.md` §4.2):

```
BEGIN
  UPDATE matches
  SET status = $status, started_at = $startedAt, ended_at = $endedAt, updated_at = now()
  WHERE match_id = $runId AND status = 'in-progress';
  -- No-op on replay (already 'completed'/'aborted'; §5 rule 3 covers idempotency). team_scores
  -- and rounds are not written here or anywhere else for a run — §2 leaves them null.
  UPDATE match_participants
  SET stats = stats || jsonb_build_object('settlementStatus', 'ended')
  WHERE match_id = $runId AND account_id = ANY($submittedAccountIds)
    AND stats->>'settlementStatus' IS NULL;   -- no-op on replay; §5 rule 3 covers idempotency
  INSERT INTO events_outbox …   -- run.ended (event-envelope.md catalogue addition, §9), once
                                 -- per run, guarded by the same run-result:<runId> idempotency
                                 -- key as everything else this endpoint does
COMMIT
```

The `matches` UPDATE and the `run.ended` event commit in the same transaction as the
`settlementStatus: 'ended'` stamp, so a crash cannot leave the run row `in-progress` while
participants already read `ended` (or vice versa) — the same "commit both or neither" discipline
§1 states for settlement generally, applied one step earlier, to the write that makes the run
terminal in the first place. The §7.2 stall detector's precondition
(`matches.status in ('completed','aborted')`) is a postcondition of this transaction, not an
assumption borrowed from elsewhere in the system.

This is why `run.ended`'s subject is the run, not a participant: it is the platform's
acknowledgement that a terminal `RunResult` has arrived for this run, emitted once, ahead of and
independent of how each individual participant's settlement resolves. `extraction-match.md`
(P3-03) is not this event's emitter — its own §8 catalogue deliberately uses the `extraction.*`
prefix (`extraction.run.ended`, not `run.ended`) to avoid colliding with this contract's
settlement-side lifecycle, precisely because `run.ended` is emitted here, by the platform, not by
the raid server. The raid server's role stops at submitting the `RunResult`; everything from
`ended` onward is this contract's responsibility, and this step is where that responsibility
starts.

If §6's per-participant transaction for a given account then commits `settled` or opens an
exception, `ended` is superseded per §3's table on the very next stats read — it is not a value
this endpoint's response reports back (§5.3 reports the post-§6 state only), it exists so a crash
between submission-received and every participant resolving does not present as *(absent)*,
which the stall detector (§7.2) would otherwise have no way to distinguish from a `RunResult`
that never arrived at all.

### 5.3 Response shape

`match-result.md` §4.2 establishes `correlationId`/`retryAfterMs`/`resultAppliedAt`/`applied` as
response-only fields for a single binary outcome. This endpoint has no single outcome to report —
§5.1 already refuses a top-level `outcome` for the same reason `match-result.md` §4.2 refuses a
top-level field that could disagree with its own array — so the response is a per-participant
array instead, on the same 200 either way:

```jsonc
// 200 OK — always, once every participant in the payload has reached a recorded terminal
// disposition; this endpoint never returns a 2xx with a participant left unresolved
{
  "runId": "01J…",
  "correlationId": "…",              // http-api.md §1; echoes X-Correlation-Id or the generated one
  "resultAppliedAt": "…",            // when this submission's writes (§5.2 + every §6 transaction
                                      // it triggered) all completed — same role as
                                      // match-result.md §6's result_applied_at, extended to a batch
  "runLevelException": { "exceptionId": "…", "trigger": "…" } | null,
                                      // non-null iff §7.1's run-level trigger (a submitted
                                      // match_participants row missing from participants[])
                                      // fired for this submission. A missing account can never
                                      // appear as an entry in participants[] below, so this is
                                      // the only field through which the caller learns a
                                      // run-level exception was opened — participants[] alone
                                      // cannot represent it
  "participants": [ {
    "accountId": "…",
    "settlementStatus": "settled" | "exception-open",
    "outcome": "extracted|died|aborted|server-failure" | null,  // the applied outcome; null iff
                                                                  // exception-open, since no
                                                                  // outcome was applied
    "exceptionId": "…" | null,       // settlement_exceptions.exception_id; null iff settled
    "trigger": "…" | null            // §7.1's row name; null iff settled
  } ]
}
```

**Why this is not the partial-success `http-api.md` §1 forbids.** §1's rule is written against an
endpoint whose atomic unit is the whole request. This endpoint's atomic unit, stated in §6, is one
participant: "one transaction per participant, not one per run." A 2xx here means *every*
participant named in the payload reached one of its two legal terminal dispositions —
`settled` or `exception-open` — not that every participant's items moved. An exception is not a
failure this contract left dangling; it is the correctly-recorded outcome for an ambiguous
participant (§7), as final, for now, as `settled` is for an unambiguous one. Nothing is left
unresolved, nothing is retried silently, and nothing is reported as having succeeded when it did
not: "the whole operation" for a per-participant endpoint like this one is "every declared unit
reached its defined terminal sub-state," not "every unit settled."

This reading is now stated directly in `http-api.md` §1 (2.2.0, additive, `CHANGELOG.md`
2026-08-22): an endpoint's owning contract may declare, in its own text, an atomic unit smaller
than the whole request, in which case a 2xx means every declared unit reached its own terminal
state rather than that the request produced one single outcome. This section is that declaration
for this endpoint (§0 item 2).

Individual validation failures (a malformed payload, a `runId` mismatch, an unknown key) are
refused per the usual `errors.md` rules before any participant is processed, exactly as
`match-result.md` §5.1 refuses them — that is a whole-request failure, not a partial one, and §1's
rule applies to it unmodified.

## 6. The settlement transaction

Runs after §5.2's run-level `ended` write has committed. **One transaction per participant**,
not one per run — a mixed-outcome squad must not let one participant's failure block or
partially apply the others. Each participant's settlement is independently atomic and
independently idempotent; `matches.status` for the run becomes fully settled only once every
participant has reached `settled` or `exception-resolved`.

```
BEGIN
  -- 1. Re-validate the §7.1 ambiguity triggers against this participant's row. Any trigger
  --    firing here aborts the transaction and opens an exception (§7) instead.
  -- 2. Read every item_instances row WHERE location='run' AND run_id=$runId
  --    AND owner_account_id=$accountId AND status='active'
  --    (terminal-status rows — consumed/destroyed already mid-raid — are untouched; only
  --    "surviving" rows are swept, per items-inventory.md §4's own wording). `locked` is
  --    expected true on every one of these — deployment.md §4.5 step 4 leaves it true for the
  --    raid's duration and its own §5.4 names settlement as the transition that clears it, not
  --    a race settlement is discovering. Settlement clears the lock in the same UPDATE that
  --    changes the row's terminal disposition, never as a separate write.
  UPDATE item_instances
  SET location = 'permanent', run_id = null,
      locked = false, locked_by_deployment_id = null, updated_at = now()   -- outcome = extracted
  -- or
  SET status = 'lost',
      locked = false, locked_by_deployment_id = null, updated_at = now()  -- outcome = died | aborted
  WHERE instance_id = ANY($surviving_run_instance_ids);
  -- This UPDATE is the shared write function items-inventory.md §5 requires for every status
  -- transition (platform/store/items.js, mirroring core/store.js) — not an ad hoc query here.
  UPDATE match_participants
  SET stats = stats || jsonb_build_object('settlementStatus', 'settled', 'outcome', $outcome, …)
  WHERE match_id = $runId AND account_id = $accountId;
  INSERT INTO events_outbox …   -- run.settled (event-envelope.md catalogue addition, §9)
COMMIT
```

This is `event-envelope.md` §4's outbox pattern applied to a settlement instead of a generic
state change: the `item_instances` transition and its event commit together, and a crash between
commit and publish still delivers the event because the relay is at-least-once by construction.
No `item_instances` mutation is ever issued from application code after a commit and outside
this transaction — the same discipline `match-result.md` §5.3 states for career application,
here extended to items because items are the thing that can be duplicated or destroyed.

Both branches of the `UPDATE` are naturally idempotent **at the row level**: a retry that finds
the row already `location='permanent'` (or already `status='lost'`) matches zero rows on a
second pass rather than re-applying, because the `WHERE` clause's `location='run'`/`status='active'`
predicate is no longer true for a row already moved. The transaction's own idempotency (§5 rules
3–4) is what decides *whether* to retry the UPDATE at all — the UPDATE's own predicate is what
makes a retry safe rather than a second conversion if it runs anyway.

### 6.1 Resolution, and the `void` branch

§7.4 step 4 says exception resolution "re-enters the exact settlement transaction of §6." That is
true for three of the four `resolution` values and not the fourth, and this section is where that
third branch — never a fourth `item_instances` disposition, per §4 — is made explicit rather than
left for an implementer to infer from §7.4's prose alone.

**`resolution` ∈ `{settle-as-extracted, settle-as-died, settle-as-aborted}`.** §6's transaction
runs exactly as written above, with the resolved value substituted for `$outcome` and the
resolved-from participant's surviving run-location rows as `$surviving_run_instance_ids`. One
difference from a first-pass settlement: `match_participants.stats` is written with
`settlementStatus: 'exception-resolved'`, not `'settled'` — §3's table reserves `'settled'` for a
disposition the automatic path reached without review, and a resolved exception is never that,
even when the outcome it lands on is identical to what automatic evaluation would have produced.
`outcome` is set to the resolved value. The transaction emits `run.settled` (§9) — the item
side-effect genuinely happened, so the event that reports it is unchanged — and, in the same
transaction, transitions the `settlement_exceptions` row to `resolved` and emits
`run.exception.resolved` (the administrative audit trail of the review itself, distinct from the
item side-effect). Both events commit together with the `item_instances` UPDATE and the
`match_participants` UPDATE, under the same one-transaction discipline as every other write in
this contract.

**`resolution = void`.** §6's `item_instances` UPDATE (step 2 of the transaction) is not executed
at all — not "runs and matches zero rows," an explicit skipped branch, because void means no
participant disposition applies (§7.4 step 5), and running the UPDATE with no legal `$outcome` to
substitute would have nothing to key its `WHERE`/`SET` off. `match_participants.stats` is written
with `settlementStatus: 'exception-resolved'`, `outcome: null` — the participant reaches the same
terminal `settlementStatus` a real disposition would, but `outcome` stays `null` because none was
applied, mirroring §5.3's response convention that `outcome` is `null` exactly when nothing was
applied. The transaction transitions `settlement_exceptions` to `resolved` and emits
`run.exception.resolved` only — `run.settled` is not emitted for this participant, because no item
side-effect occurred for it to report. `resolution_notes` is still required non-blank (§7.3):
"we decided not to act" is itself the fact this audit trail exists to record.

All four branches share one property: exactly one of `run.settled` / `run.exception.resolved`
(for void) — or both (for the three real dispositions) — is emitted per resolved participant, and
`settlement_exceptions.status` reaches `resolved` in the same transaction as whichever
`match_participants` write applies. No branch leaves the exception row and the participant row
disagreeing about whether resolution happened.

## 7. The exception queue

### 7.1 Ambiguity triggers

A participant's settlement opens an exception when **any** of these hold, checked before any
`item_instances` write is issued:

| Trigger | Example |
|---|---|
| `server-failure` with no matching `lastKnownState` | §4.1 |
| Two `RunResult` submissions for the same `runId` with different payloads for the same participant, neither a pure retry | §5 rule 4 catches the case where the run is already fully resolved; this row catches it when both arrive before either commits, per §0 item 3 |
| A surviving run-location row's `owner_account_id` does not match the participant being settled, or a row named in evidence cannot be found at `location='run', run_id=<this run>` at all | The evidence and the instance table disagree |
| `evidenceRef` digest mismatch or reconstruction failure (same check `match-result.md` §5.1 runs for matches) | Evidence tampering or a truncated write |
| The stall detector (§7.2) fires | No `RunResult` ever arrives |
| A surviving run-location row's `locked_by_deployment_id` does not resolve to a `deployment.md` `deployment_reservations` row with `status='consumed', match_id=<this run>, account_id=<this participant>` | Expected is `locked=true` pointing at exactly that reservation (`deployment.md` §4.5/§5.4) — anything else means the lock and the run disagree about which deployment put the item there, and settlement is not the place to guess which one is stale |
| **Run-level** — a submitted `RunResult.participants[]` omits an account that has a `match_participants` row for this run (deployed but never reported on) | No participant to attribute the ambiguity to: the gap is in the submission itself, not in any one account's outcome |

Every trigger above the last row is checked against one participant's data and, on firing, opens
a **participant-level** exception: `account_id` is that participant's, per §7.3. The last row is
the one case this contract produces a **run-level** exception for (`account_id null`, per §7.3) —
it is checked once per submission, against the full roster, not against any single participant's
row, because a missing participant is not that participant's ambiguity to own. This is not dead
schema: it is `settlement_exceptions.account_id`'s one populated-null branch, and no other trigger
in this table is meant to produce one.

Nothing on this list is "settle it anyway and let stats reconcile later," because unlike a
career counter, a converted or lost item instance is not derivable from history if the rule that
moved it was wrong — `match-result.md` §6's recompute guarantee has no analogue here. The
exception queue exists precisely because this domain cannot lean on the recompute safety net the
stats domain has.

### 7.2 The stall detector

A run in `matches.status='completed'|'aborted'` with a participant still lacking any
`settlementStatus` after a configured timeout (`SETTLEMENT_STALL_MS`, platform config, not
hardcoded) opens an exception automatically rather than leaving the participant's run inventory
unresolved indefinitely. A silently un-settled participant is not a safer failure mode than an
open exception — it is the same failure with worse visibility, the exact outcome
`event-envelope.md` §3 calls "the worst outcome available" for a dropped event, applied here to
a dropped settlement.

### 7.3 `settlement_exceptions` — schema

```sql
settlement_exceptions(
  exception_id     text primary key,              -- ULID
  run_id           text not null references matches,
  account_id       text references accounts,       -- null iff run-level, not participant-level
  trigger          text not null,                   -- one of §7.1's rows, closed enum
  status           text not null default 'open',    -- open|in-review|resolved
  opened_at        timestamptz not null default now(),
  opened_by        text not null,                   -- 'system' for automatic triggers
  evidence_snapshot jsonb not null,                  -- the RunResult/evidenceRef state at open
                                                     -- time, frozen so a later mutation can't
                                                     -- rewrite what was actually ambiguous
  assigned_to      text,
  reviewed_at      timestamptz,
  reviewed_by      text,
  resolution       text,         -- 'settle-as-extracted'|'settle-as-died'|'settle-as-aborted'|'void'
                                  -- closed enum, §7.4 — deliberately the same three item
                                  -- dispositions §4 already defines, plus void
  resolution_notes text,         -- required non-blank when resolution is set
                                  -- (db-schema.md §5 audit_log's reason_code pattern)
  resolution_evidence_ref text,  -- what the reviewer based the call on, beyond the frozen snapshot
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)
create index on settlement_exceptions (status) where status <> 'resolved';
create index on settlement_exceptions (run_id);
```

A new table this contract requires as an additive `db-schema.md` amendment when P3-04 lands —
named here so the shape is fixed before the migration is written, in the order `db-schema.md`
§4's own note says the `matches` CHECK constraints should have been specified in the first time.

### 7.4 Resolution flow — operationally, what "hold for review" means

1. **Open.** A trigger fires (§7.1/§7.2). The participant's `settlementStatus` is
   `exception-open`, never `settled` by assumption. No `item_instances` row for that participant
   is converted or lost yet.
2. **Queryable.** `settlement_exceptions` is a normal table — Admin Portal or a support operator
   lists open exceptions filtered by `run_id`, `account_id`, `trigger`, or age. This is the
   entire meaning of "queryable exception queue" in the DoD: one table, not a side channel.
3. **In review.** An operator claims it, optimistic-locked on `updated_at` so two operators cannot
   resolve the same exception — the identical double-write hazard this whole contract exists to
   prevent, one layer up, made mechanical the same way `deployment.md` §2.1/§3 and this
   contract's own §6 `UPDATE` make their concurrency guarantees mechanical rather than prose:

   ```sql
   UPDATE settlement_exceptions
   SET assigned_to = $operatorId, status = 'in-review', updated_at = now()
   WHERE exception_id = $exceptionId AND updated_at = $expectedUpdatedAt
     AND status = 'open';
   -- Zero rows affected means someone else claimed or resolved it since the operator's last
   -- read (or it was never 'open'); the client re-reads and the operator retries deliberately,
   -- never a silent overwrite of the other operator's claim.
   ```
4. **Resolved.** The operator records a `resolution` (one of §4's three dispositions, or `void`)
   and non-blank `resolution_notes`. For the three real dispositions, resolution **re-enters the
   exact settlement transaction of §6** with the resolved disposition substituted for the
   ambiguous `outcome` — it does not bypass §6, it supplies the missing input to it. `void` takes
   the third branch instead — see §6.1 for exactly what each branch writes and emits; both are
   "the settlement path" this step refers to, not two different mechanisms.
5. `void` settles nothing — used only when the run itself is found invalid (a test run, a
   duplicate allocation) and no participant disposition should apply. It still requires
   `resolution_notes` and still writes the terminal `run.exception.resolved` event (§9), because
   "we decided not to act" is itself a fact that must be recorded. §6.1 specifies the exact write:
   no `item_instances` mutation, `settlementStatus: 'exception-resolved'`, `outcome: null`, and
   `run.exception.resolved` without a matching `run.settled`.
6. Every transition in this flow is covered by `audit_log` (`db-schema.md` §5):
   `actor_kind: 'admin'`, `subject_kind: 'settlement_exception'`.

No SLA is encoded in this contract — that is an operations decision for a runbook, not a data
contract.

## 8. Composition with `items-inventory.md` and `deployment.md`

Settlement is a **caller** of the mechanisms those two contracts already specify, not an
alternate definition of either:

| What settlement does | What it relies on |
|---|---|
| Reads every surviving `location='run', run_id=<run>` row for a participant | `items-inventory.md` §2's schema and §4's "every surviving `location='run'` instance" wording — settlement does not invent a third query shape |
| Writes `location='permanent'`/`run_id=null` on extract, `status='lost'` on death/abort | `items-inventory.md` §4's two dispositions, verbatim. Settlement adds no third |
| Uses `platform/store/items.js` as the sole write path | `items-inventory.md` §5: "no writer ever transitions out of them [terminal statuses]... enforced... one shared application function," named there for exactly this caller |
| Clears `locked`/`locked_by_deployment_id` in the same UPDATE as the terminal disposition | `deployment.md` §5.4, verbatim: "[release] from that point is P3-04's concern... and clears `locked`/`locked_by_deployment_id` in that same transaction." Settlement does not treat a locked row as suspicious — it is the expected state deployment.md §4.5 step 4 leaves it in until exactly this transaction |
| Treats a surviving row whose `locked_by_deployment_id` does **not** resolve to a `consumed` reservation for this run/participant as an ambiguity trigger (§7.1) | `deployment.md` §2: the reservation row is the readable metadata, but `item_instances.locked_by_deployment_id` is what a concurrent write actually contends on — a mismatch here means the lock and the run disagree about provenance, which settlement is not positioned to arbitrate |
| Never touches `deployment_reservations.status` itself | `deployment.md` §5.4 leaves a consumed reservation `status='consumed'` permanently; settlement's business is the instances it locked, not the reservation record |
| Expects `items-inventory.md` §9 invariant 5 to hold after every settlement commits: zero `location='run', run_id=<that run>` rows remain, each `permanent` or `lost` | This is the postcondition settlement exists to guarantee, stated once in the sibling contract and not restated with different words here |

Nothing here asks either sibling contract for a capability it does not already describe. If a
capacity limit, an insured/protected-item mechanic, or a third exit disposition is added to
permanent inventory in a later phase, it is `items-inventory.md`'s amendment to make, and this
table is either confirmed unchanged or this contract amends alongside it — not resolved by
either lane inferring the other's shape from its code, the exact failure `README.md` names as
the reason this directory exists.

## 9. Event catalogue additions (`event-envelope.md` §6, additive)

| Type | Actor | Subject | Privacy | Retention |
|---|---|---|---|---|
| `run.ended` | service | match | internal | standard |
| `run.settled` | service | match | internal | audit |
| `run.exception.opened` | system/service | match | internal | audit |
| `run.exception.resolved` | admin | match | internal | audit |

`subject.kind` is `match` (§2 — a run is a `matches` row), so ordering follows
`event-envelope.md` §3's per-subject rule automatically: every event about one run, in order,
same as an arena match's events today. `run.settled` carries `accountsAffected` and the
per-participant disposition list, mirroring `match.result_applied`'s role in `match-result.md`
§6 — the status event says the run ended; this one says the item side-effects are done. `audit`
retention on the exception events matches `db-schema.md` §7: a held or overridden loot outcome
is a moderation-adjacent record that must not vanish when its subject asks.

## 10. Verification — `scripts/settlementtest.mjs`

Each with its failing control, mirroring `match-result.md` §8's shape for the run domain:

1. Duplicate `RunResult` submission settles inventory **once** per participant. Submit the
   identical payload 10× concurrently.
2. Different payload for an already-`settled` participant is rejected (`CONFLICT`), inventory
   unchanged.
3. `extracted` converts every surviving run-location row to `permanent`; `died` and `aborted`
   both move every surviving row to `lost`; nothing else changes `location` or `status`.
4. Every §7.1 trigger opens an exception and commits **no** `item_instances` mutation.
5. The stall detector opens an exception for a participant stuck without a `settlementStatus`
   past the timeout, and does not do so before it.
6. Exception resolution settles through the same §6 transaction — verified by asserting only
   one `run.settled` participant-disposition exists even when resolution follows an opened
   exception.
7. A crash between the settlement commit and the outbox publish still delivers `run.settled`
   (same control as `event-envelope.md` §9.2, applied here).
8. A mixed-outcome squad (one `extracted`, one triggers §7.1 mid-transaction) leaves the
   extracted participant settled and the other in `exception-open` — never both blocked on each
   other.
9. After settlement, `items-inventory.md` §9 invariant 5 holds: zero `location='run',
   run_id=<that run>` rows remain for a fully settled run.
10. A browser-origin request to `POST /v1/runs/:runId/result` is refused.
11. A mixed-outcome submission's response (§5.3) is `200` with a `participants[]` array whose
    entries carry `settlementStatus: 'settled'` for the extracted/died/aborted participants and
    `settlementStatus: 'exception-open'` (with `exceptionId`/`trigger` set) for the ambiguous one
    — never a non-2xx status for the request as a whole.
12. Every participant named in a submitted payload has `settlementStatus: 'ended'` (§5.2)
    immediately after submission is received, before any §6 transaction for that run has
    necessarily committed — asserted by pausing §6 mid-run and reading `match_participants` for
    an unresolved participant.
13. A `RunResult` that omits a participant with a `match_participants` row for the run opens a
    **run-level** exception — `settlement_exceptions.account_id is null` — and does not open a
    participant-level exception for any other row in the same submission (§7.1's last row). The
    §5.3 response's `runLevelException` field is non-null with the matching `exceptionId`/
    `trigger`; a submission with no missing participant returns `runLevelException: null`.
14. A `void` resolution (§6.1) commits **no** `item_instances` mutation, sets
    `settlementStatus: 'exception-resolved'` with `outcome: null` on `match_participants`, and
    emits `run.exception.resolved` without a matching `run.settled` for that participant — unlike
    the three real-disposition resolutions, which emit both.
