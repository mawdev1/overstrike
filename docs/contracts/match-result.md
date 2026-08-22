# Contract 7 — Match result and canonical stats

| | |
|---|---|
| **Status** | `FROZEN` — amendments follow CHANGELOG.md |
| **Version** | 2.1.0 |
| **Owner** | [CC] Claude Code |
| **Consumers** | Match server, platform, profile/stats, Admin Portal, [CX] scoreboard and career screens |

---

## 1. Why definitions come before code

"Kills" sounds unambiguous until a team kill, a suicide by grenade, a kill by a killstreak, a
kill traded on the same tick, and a kill by a player who disconnected before it resolved all
land in the same match. If those are decided in the implementation, each service decides
differently and the numbers stop reconciling — and every disagreement becomes a support
ticket nobody can settle.

The definitions in §3 are **canonical and versioned**. Changing one is a breaking amendment
requiring a CCR, because it silently rewrites the meaning of every historical row.

## 2. Current state

`src/game/match.js` already keeps a per-entity stat row: `kills, deaths, assists, score,
streak, bestStreak, headshots, longshots, longestShot, shotsFired, shotsHit, damageDealt,
captures, defends, confirms, denies, streaksEarned, tier`, and a `SCORE` table
(`kill 100, headshot 50, assist 25, revenge 75, longshot 150, doubleKill 100, tripleKill 200,
multiKill 300, teamKillPenalty −100, suicidePenalty −50`).

**That row is in-memory and per-match.** It is the right shape; it has no durable home, no
canonical definitions, and no path to a profile. This contract gives it all three.

Fields not in the current row and required by this contract: `suicides`, `teamKills`,
`plants`, `defuses`, `roundsPlayed`, `timePlayedSec`, per-weapon breakdown, `disconnected`,
`abandoned`.

## 3. Canonical definitions

| Stat | Definition | Explicitly |
|---|---|---|
| `kills` | Killing blow on an **enemy** entity | Excludes team kills and suicides. **Includes** kills by the player's killstreak hardware — it is credited to its owner (`_resolveAttacker`) |
| `deaths` | Any death, cause irrelevant | Includes suicides, team kills by a teammate, world deaths, and deaths while disconnecting |
| `assists` | Damaged the victim within the assist window and did not land the killing blow | One assist maximum per victim per death, regardless of how much damage |
| `suicides` | Death with no enemy attacker, or self-inflicted | Also increments `deaths` |
| `teamKills` | Killing blow on a **teammate** | Increments the victim's `deaths`, **not** the killer's `kills` |
| `headshots` | Killing blow to the head hitbox | Subset of `kills`, never counted separately in K/D |
| `shotsFired` | Discrete trigger pulls that consumed ammo | A 3-round burst is 3. A shotgun shell is 1 |
| `shotsHit` | Shots landing ≥1 damage on any entity | Once per shot, not per pellet — `_hitThisShot` already enforces this |
| `damageDealt` | Total damage to enemies, post-mitigation | Excludes team damage and self-damage. Excludes overkill past 0 health |
| `plants` | Completed bomb plants | Interrupted plants count zero. Partial progress is never partial credit |
| `defuses` | Completed defuses | Same |
| `roundsPlayed` | Rounds where present at round start | Bomb only |
| `timePlayedSec` | Seconds connected and in the match | Excludes lobby and post-match |
| `score` | Sum of `SCORE` awards | Per-match only. **Not** summed into career |
| `disconnected` | Left before match end, did not return | |
| `abandoned` | Left before match end while their team was losing, past the abandon threshold | Sanctionable; `disconnected` alone is not |

### 3.1 Contested cases — decided here, once

| Case | Ruling |
|---|---|
| Two players land killing blows on the same tick | The **first applied** in server order gets the kill; the other gets an assist. Never two kills |
| Victim dies to damage-over-time after the attacker disconnects | Attacker still gets the kill. Attribution is to the damage source, not the connection |
| Player disconnects mid-air and dies on landing | Death counts. `disconnected: true` |
| Killstreak hardware kill | Kill to the owner |
| Team kill by a player who then leaves | Team kill retained; leaving does not erase it |
| Round ends mid-plant | No plant. No partial credit |
| Match invalidated | Stats recorded on the match record, **not** applied to career |
| Backfilled TDM player | `timePlayedSec` from join; `roundsPlayed` unaffected (TDM has no rounds) |

## 4. Result record

### 4.0 The outcome matrix — every legal terminal tuple (REQ-CC-044)

**This section did not exist.** `wire-protocol.md` §8.9, `net-facade.md` §5.3 and §8,
`bomb-rules.md` §9 and the platform's own `core/store.js` all cite "the `match-result.md` §4.0
matrix" as the authority for which `(status, outcomeReason, winnerTeam)` tuples exist. Four
documents deferred to a section number, and the rule they deferred to lived only in §4.2's
invariant table under a different name. It is written here once, and §4.2 now refines it rather
than restating it.

| `status` | `terminationReason` | `outcomeReason` | `winnerTeam` | `invalidationReason` | Aggregates (§6) |
|---|---|---|---|---|---|
| `completed` | `completed` | `elimination` \| `defuse` \| `detonation` | `alpha` \| `bravo` | null | yes |
| `completed` | `completed` | `timer` | `alpha` \| `bravo` \| `draw` | null | yes |
| `aborted` | `aborted` | `forfeit` | `alpha` \| `bravo` | null | yes |
| `aborted` | `aborted` | `abandon` | `alpha` \| `bravo` | null | yes |
| `aborted` | `aborted` | `no-contest` | **null** | null | **no** |
| `invalidated` | `invalidated` | `no-contest` | **null** | non-null, from the enum | **no** |

Six rows, and nothing else is a match. Three properties are load-bearing:

- **`draw` implies `timer`.** A draw is regulation expiring at 6-6 with no overtime in Alpha
  (`bomb-rules.md` §2.1a). There is no other way for a `completed` match to have no winner, so
  a drawn elimination is two facts that cannot both be true. The earlier table permitted it
  beside every other completed reason; `wire-protocol.md` §8.9 has always forbidden it, and the
  platform refuses it in one shared validator and in a database `CHECK`.
- **An aborted match can have a winner.** A forfeit is the commonest abnormal ending and the
  team that stayed earns the win. `winnerTeam: null` means *no winner*, never *draw*.
- **`terminationReason` repeats `status`.** They are two names for one fact, kept because both
  appear on the wire; a record where they disagree carries two truths and is refused.

### The record

Written once per match, immutable thereafter. The complete shape is Build Plan §A.3; the
binding additions:

```jsonc
{
  "matchId": "01J…",              // assigned at ALLOCATION, not completion
  "status": "completed|aborted|invalidated",   // REQUIRED discriminant of the §4.2 union
  "rulesetVersion": "bomb-1.0.0",
  // Immutable copy of the ruleset, discriminated by mode (REQ-CC-019, REQ-CC-025)
  "rulesSnapshot": {
    // mode "bomb":
    // mode "bomb" — every key present:
    "killLimit": null,
    "roundsToWin": 7, "maxRounds": 12, "sideSwitchAfter": 6,
    "roundLengthSec": 105, "bombTimerSec": 40, "defuseSec": 7, "plantSec": 3,
    "freezeSec": 8, "overtime": false

    // mode "tdm" — the same keys, discriminated:
    // { "killLimit": 75,
    //   "roundsToWin": null, "maxRounds": null, "sideSwitchAfter": null,
    //   "roundLengthSec": null, "bombTimerSec": null, "defuseSec": null,
    //   "plantSec": null, "freezeSec": null, "overtime": null }
  },
  "statDefinitionVersion": "1.0.0",  // which definitions in §3 produced these numbers
  "serverBuild": "…", "mapId": "the-square", "mapVersion": "1.0.0", "region": "yyz",
  "mode": "tdm|bomb",
  "startedAt": "…", "endedAt": "…",
  "terminationReason": "completed|aborted|invalidated",
  "outcomeReason": "elimination|defuse|detonation|timer|forfeit|abandon|no-contest",
  "invalidationReason": "cheat-detected|server-fault|roster-fault|admin-review|null",
  "roster": [ { "accountId": "…", "team": "alpha|bravo", "joinedAt": "…", "leftAt": null } ],
  "teamScores": { "alpha": 0, "bravo": 0 },
  "rounds": [ { "index": 0, "winner": "alpha", "reason": "elimination|defuse|detonation|timer" } ],
  "winnerTeam": "alpha|bravo|draw|null",
  "players": [ /* §4.1 */ ],
  "evidenceRef": "…"
}
```

### 4.1 Serialized player and round shapes (REQ-CC-006)

The previous placeholder comment was not buildable. Exact, every key required:

```jsonc
"players": [ {
  "accountId": "…", "displayName": "…",
  "team": "alpha|bravo",
  "role": "attacker|defender|null",      // starting role; rounds carry per-round roles
  "kills": 0, "deaths": 0, "assists": 0, "suicides": 0, "teamKills": 0,
  "headshots": 0, "shotsFired": 0, "shotsHit": 0, "damageDealt": 0,
  "plants": 0, "defuses": 0,
  "roundsPlayed": 0, "timePlayedSec": 0,
  "score": 0,
  "disconnected": false, "abandoned": false,
  "joinedAt": "…", "leftAt": null,
  "weapons": { "<weaponId>": { "shots": 0, "hits": 0, "kills": 0, "headshots": 0 } }
} ]

"rounds": [ {
  "index": 0,
  "winner": "alpha|bravo",
  "reason": "elimination|defuse|detonation|timer",
  "startedAt": "…", "endedAt": "…",
  "roles": { "alpha": "attacker|defender", "bravo": "attacker|defender" },
  "plant":  { "accountId": "…", "site": "A|B", "at": "…" } | null,
  "defuse": { "accountId": "…", "at": "…" } | null
} ]
```

`status` is required on every variant and is what a client branches on; `terminationReason`
and `outcomeReason` then describe how and why. `winnerTeam` is `draw` when regulation ends 6-6
(`bomb-rules.md` §2.1a — no overtime in Alpha), and `null` **only when the match had no winner
at all** — a no-contest or an invalidation. An
aborted match ended by forfeit or abandon carries a real winner; see the §4.0 matrix, which
this sentence used to contradict. Per-player win/loss is derived from
`winnerTeam` and the player's team; it is not stored per player, because storing it twice
means it can disagree with itself.

`roles` is per round because the side switch means a player attacks in some rounds and defends
in others. Deriving it from the starting role plus the switch point works right up until the
switch rule changes, and then every historical match silently reinterprets.

Objective actors (`plant.accountId`, `defuse.accountId`) are always present in the stored
record. Whether they are **returned** depends on the projection rule in §4.2.

**The nested types, named once.** Storage and HTTP both use these and neither redefines them:

| Type | Definition |
|---|---|
| `RulesSnapshot` | The `rulesSnapshot` object in §4, discriminated by `mode`. Every key present in both variants; Bomb keys are null in TDM and `killLimit` is null in Bomb |
| `RosterEntry` | `{ accountId, team: "alpha"\|"bravo", joinedAt, leftAt: string\|null }` |
| `TeamScores` | `{ alpha: int ≥ 0, bravo: int ≥ 0 }` — exactly these two keys |
| `Round` | The round object above, every key required |
| `PlayerStats` | The player object above, every key required, `weapons` keyed by weapon id |

`roster` and `players` are two projections of the **same participant set**, not independently
valid arrays. They contain exactly the same unique `accountId` values, and the `team` for each
account is identical in both. Array order need not match. A missing row or team disagreement is
`VALIDATION_FAILED`; persistence must never answer 2xx and later reconstruct a different roster.

### 4.2 `TerminalResult` — the exact response union (REQ-CC-040)

No ellipses, no "every other field", no comment standing in for a variant. `GET
/v1/matches/:matchId` returns exactly one of four shapes, discriminated by `status`.

**`TerminalResult`** is the shared field set — every key present in all three terminal
variants:

```jsonc
{
  "matchId": "…", "status": "completed|aborted|invalidated",
  "rulesetVersion": "…", "statDefinitionVersion": "…",
  "rulesSnapshot": RulesSnapshot,
  "serverBuild": "…", "mapId": "…", "mapVersion": "…", "region": "…",
  "mode": "tdm|bomb",
  "startedAt": "…", "endedAt": "…",
  "terminationReason": "completed|aborted|invalidated",
  "outcomeReason": "elimination|defuse|detonation|timer|forfeit|abandon|no-contest",
  "winnerTeam": "alpha|bravo|draw|null",
  "invalidationReason": "cheat-detected|server-fault|roster-fault|admin-review|null",
  "roster": RosterEntry[], "teamScores": TeamScores,
  "rounds": Round[], "players": PlayerStats[],
  "evidenceRef": "…",
  "correlationId": "…"
}
```

The four nested types are the ones named in §4.1, used here and by storage without a second
definition. They previously stood as `{ … }` and `[ … ]` in this block, which is the same
"every other field" placeholder this section exists to remove — a reader could not tell whether
a key was omitted for brevity or genuinely absent.

`invalidationReason` is a **closed enum or null** — it was previously fixed to null in the base
record while the invalidated variant required it non-null, with no type stated.

Status-dependent invariants, refining the §4.0 matrix. This is what makes the union checkable
rather than decorative:

| `status` | `terminationReason` | `outcomeReason` | `winnerTeam` | `invalidationReason` |
|---|---|---|---|---|
| `completed` | `completed` | elimination \| defuse \| detonation | `alpha` \| `bravo` — **never `draw`** | **null** |
| `completed` | `completed` | `timer` | `alpha` \| `bravo` \| `draw` | **null** |
| `aborted` | `aborted` | forfeit \| abandon \| no-contest | `alpha` \| `bravo` **if** forfeit/abandon; **null** if no-contest | **null** |
| `invalidated` | `invalidated` | `no-contest` | **null** | **non-null**, from the enum |

**`winnerTeam: "draw"` requires `outcomeReason: "timer"`, and only `timer`.** The `completed`
row used to be one line permitting `draw` beside every reason, which made a drawn elimination
representable here and forbidden by `wire-protocol.md` §8.9 two contracts away.

#### The authorized round projection (REQ-CC-043)

§4.1 says objective actors are always stored and that whether they are *returned* is decided
here. It is decided here:

| Caller | `rounds[].plant` / `.defuse` | `evidenceRef` |
|---|---|---|
| Service | actor id as stored | as stored |
| Participant in the match | actor id as stored | **null** |
| Anyone else (and only when **every** participant publishes their career) | the object, with `accountId: null` | **null** |
| Anyone else, any participant hiding their career | `404 NOT_FOUND` | — |

The shape never changes: a redacted plant is `{ accountId: null, site, at }`, not a missing
`plant`, so one renderer handles every caller and an absent key stays a bug. "Every
participant" is deliberate — a match record names ten people, there is no per-match privacy
setting, and one player's `statsVisibility: nobody` is not overridden by nine teammates who
chose otherwise. `evidenceRef` (§7) is the input to a cheat review; handing it to the
participants of a match hands it to whoever they are protecting.

Plus the non-terminal fourth shape, which shares only its identifiers:

```jsonc
// status: "pending" — allocated, live, or ended and awaiting persistence
{ "matchId": "…", "status": "pending",
  "mode": "tdm|bomb|extraction",   // 2.1.0: a run pending settlement is this same shape (§4.4)
  "mapId": "…", "mapVersion": "…",
  "startedAt": "…"|null,      // null while ALLOCATED; the real timestamp once the match starts
  "endedAt": "…"|null,        // null until it ends; the real timestamp once ended and queued
  "retryAfterMs": 2000,
  "correlationId": "…" }
```

**Three stored rows project as `pending`, and the two nullable timestamps are what tell them
apart (REQ-CC-044).** `startedAt` was fixed to a timestamp here while an allocated row has none
by definition, so the one state the platform creates first was the one the response could not
express.

| Stored `status` | `startedAt` | `endedAt` | Means | Produced by |
|---|---|---|---|---|
| `allocated` | null | null | The id exists; the server has not started the match | Allocation (`db-schema.md` §4: the row is created at allocation) |
| `in-progress` | set | null | **Live** | The match server reporting first tick |
| `in-progress` | set | set | Ended; the result is queued and not yet submitted | The match server ending the match, before `POST …/result` |

All three carry both keys with an explicit null rather than omitting one, so a missing key stays
a bug rather than becoming a fourth state. All three answer `retryAfterMs`, because a client
cannot act on the difference — it waits either way. A row that has reached a terminal status
projects as terminal whether or not the career application has been stamped: `result_applied_at`
(§6) is a fact about the career, not about the result.

| Case | Response |
|---|---|
| Allocated / live / ended-and-queued | `200`, `pending`, per the table above |
| Completed / aborted / invalidated | `200`, the matching `TerminalResult` refinement |
| Never existed | `404 NOT_FOUND` |
| Exists, caller not a participant, privacy forbids | `404 NOT_FOUND` — **not 403**, which would confirm the match exists |

`correlationId` is present on **every** variant, per §1. It previously appeared on the
invalidated example alone.

A `pending` response never invites the browser to submit anything. Result submission is
service-only (§5), and no field in it hints otherwise.

### 4.3 History summary — a discriminated union too (REQ-CC-040)

`GET /v1/profile/:id/matches` permits `status: "pending"` but its item shape fixed `endedAt` to
a timestamp and always supplied `result` and `playerSummary`, so it could not represent the
live pending state its own detail endpoint defines.

```jsonc
// terminal item — status completed | aborted | invalidated
{ "matchId": "…", "status": "completed",
  "mode": "bomb", "mapId": "the-square", "mapVersion": "1.0.0",
  "endedAt": "…",                          // always present
  "result": "win|loss|draw|null",           // null iff winnerTeam is null
  "teamScores": { "alpha": 7, "bravo": 5 },
  "playerSummary": { "kills": 0, "deaths": 0, "assists": 0, "score": 0 } }

// pending item
{ "matchId": "…", "status": "pending",
  "mode": "bomb", "mapId": "the-square", "mapVersion": "1.0.0",
  "endedAt": "…"|null,
  "result": null, "teamScores": null, "playerSummary": null }
```

A pending entry carries **null** for every outcome field rather than omitting them, so one
renderer handles both and a missing key is always a bug rather than a state.

### 4.4 `RunTerminalResult` — the extraction run-result projection (2.1.0, additive — REQ-CC-072)

A run is a `matches` row with `mode='extraction'` (`settlement.md` §2), read through the same
`GET /v1/matches/:matchId`. It cannot be a `TerminalResult` refinement: `settlement.md` §2
deliberately leaves `outcome_reason`, `winner_team`, `team_scores`, and `rounds` null for a run,
and per-participant truth lives in `match_participants.stats` as settlement writes it. So a
terminal `mode='extraction'` row returns a **fifth shape**, discriminated by `mode` — a client
that sees `status ∈ {completed, aborted}` branches on `mode` before assuming the §4.2 field set:

```jsonc
{
  "matchId": "…",
  "status": "completed|aborted",     // §2 of settlement.md: a run is never `invalidated` in this version
  "mode": "extraction",              // the discriminant for this shape
  "mapId": "…", "mapVersion": "…", "region": "…", "serverBuild": "…"|null,
  "startedAt": "…", "endedAt": "…",
  "roster": RosterEntry[],           // team is null — a run has no alpha/bravo
  "settlement": {
    "runLevelException": { "exceptionId": "…", "trigger": "…" } | null,
                                      // settlement.md §7.1's run-level trigger; null when none
    "participants": [ {
      "accountId": "…",
      "settlementStatus": "ended|settled|exception-open|exception-resolved",  // settlement.md §3
      "outcome": "extracted|died|aborted|server-failure" | null,  // null iff not yet applied
                                      // (`ended`) or no outcome was applied (`exception-open`,
                                      // or an exception resolved as void)
      "exitId": "…"|null,            // non-null iff outcome is "extracted"
      "deathCause": "…"|null,        // non-null iff outcome is "died"
      "exceptionId": "…"|null,       // non-null iff an exception is currently OPEN for this
                                      // participant — settlement clears it on resolution
      "trigger": "…"|null            // settlement.md §7.1's row name; non-null iff exception-open
    } ]
  },
  "evidenceRef": "…"|null,           // §7's rule unchanged: real for a service caller, null otherwise
  "correlationId": "…"
}
```

Rules:

- **The PvP-only keys are absent, not null-stuffed**: no `winnerTeam`, `outcomeReason`,
  `terminationReason`, `teamScores`, `rounds`, `rulesSnapshot`, `players`,
  `invalidationReason`, `rulesetVersion`, or `statDefinitionVersion`. None has a defined
  extraction meaning (`settlement.md` §2), and a fabricated null teaches a renderer to read a
  key that never carries information. `settlement` is, symmetrically, absent from every
  `tdm|bomb` response.
- `settlement.participants[]` covers the **full roster**. A participant the raid server never
  submitted (settlement.md §7.1's missing-participant trigger) appears with its stored stats
  state — `ended` if stamped, and `settlementStatus` reads as `"ended"` when the stats carry no
  settlement keys at all on a terminal row, so the client's four-state vocabulary is total.
- `runLevelException` mirrors `settlement.md` §5.3's response field, read back from the open
  run-level `settlement_exceptions` row (accountId null); null once resolved or when none was
  opened.
- Access rules are §4.2's unchanged: service / participant / everyone-published, 404 otherwise,
  `evidenceRef` service-only.
- A **non-terminal** run row projects as §4.2's `pending` shape with `mode: "extraction"` —
  same three stored-row states, same `retryAfterMs` contract. P3-10's retry-safe presentation
  polls it exactly as a PvP results screen does.

This is additive (2.0.0 → 2.1.0, no CCR): a new discriminant value and a new shape behind it;
no existing `tdm|bomb` response changes by a byte. The submission side is not here —
`RunResult` submission is `settlement.md` §5's `POST /v1/runs/:runId/result`, service-only;
this section is only the browser-readable projection of what settlement wrote.

## 5. Submission and idempotency

```
POST /v1/matches/:matchId/result        [SERVICE ONLY]
Idempotency-Key: match-result:<matchId>
```

1. Service-authenticated. **Never browser-reachable** — a client that can post results owns
   the leaderboard.
2. Idempotency key derived from `matchId`, so a retry is inherently the same key.
3. Result write, career stat application, and the outbox event are **one transaction**. The
   event type follows §4.0 — `match.completed`, `match.aborted`, or `match.invalidated`. It is
   not always `match.completed`; the catalogue distinguishes them and so must the writer. Partial application is the failure mode that produces stats nobody can
   reconcile.
4. Replay with the same payload returns the stored response without re-applying.
5. Replay with a *different* payload for a finalised match → `CONFLICT`. A match finalises
   once; a second, different truth is a bug or an attack.
6. If the platform is unavailable, the match server **durably queues** and the worker retries
   with backoff. Players are never held at a results screen waiting on it.

### 5.1 `AuthoritativeResultSubmissionV1` — the request body (REQ-CC-043)

The body was specified as "the full §4 record", which is a reference to a section containing the
`pending` variant, the response-only correlation envelope, and three response tables. A producer
could not tell which of those it was being asked for.

`POST /v1/matches/:matchId/result` accepts exactly:

```json
{ "result": "ResultSubmission", "evidence": "AuthoritativeEvidenceV1" }
```

The wrapper has exactly `result` and `evidence`; both are objects and unknown wrapper keys are
refused. A flat result is not accepted over HTTP. Internal historical import code may call the
stats service with a non-digest legacy reference, but that is not a deployed transport shape.

**`ResultSubmission` is exactly the `TerminalResult` field set of §4.2**, minus `correlationId`,
plus the two allocation identifiers the row keeps:

- every §4.2 key, at the types §4.2 gives them, satisfying one §4.0 row;
- optional `roomId` and `serverId` — facts about the match, known at allocation;
- **no** `correlationId`, `retryAfterMs`, `resultAppliedAt` or `applied`. Those are response
  fields. A submission carrying one is refused rather than ignored, because a key the platform
  drops silently is a key the sender believes was honoured. The request's correlation id travels
  in the `X-Correlation-Id` header like every other request (`http-api.md` §1);
- **no unknown keys at all**, for the same reason.

`AuthoritativeEvidenceV1` is the immutable server record containing exact `authority`,
`terminalSummary`, `participants`, `roundSummary`, `combatSummary`, `connectionSummary`,
`roster`, `result`, and bounded `eventTimeline`, `objectives`, `combatSamples`,
`connectionFacts`, and `antiCheatFlags` sections plus zero-valued drop counters. `evidenceRef`
is `sha256:` plus the shared recursively key-sorted JSON digest. The platform independently
reconstructs `ResultSubmission` (minus `evidenceRef`) from the authority/summary sections and
refuses a digest mismatch, reconstruction mismatch, truncation, or unknown shape. Match,
evidence, career deltas, idempotency, and terminal/result-applied outbox events commit in one
transaction. The evidence row is append-only and resolves `evidenceRef` after server release.

Three identifiers must agree, and the path is authoritative:

| Identifier | Rule |
|---|---|
| `:matchId` in the path | Authoritative. The stored row is this one |
| `matchId` in the body | Must equal the path. Otherwise a payload could finalise a different match under a non-matching key |
| `Idempotency-Key` | Exactly `match-result:<matchId>`. A header that disagrees is a caller bug and not a second competing key — accepting it lets one match finalise twice |

`status` must be terminal. A `pending` body is not a variant of this type: §4.2's pending shape
is something the platform *answers*, never something a producer submits, and nothing in it
hints otherwise.

Errors: `VALIDATION_FAILED` for any of the above, with `details.fields[]` naming the offending
path (`players[2].weapons.ar_vector.kills`) per `errors.md` §3; `CONFLICT` for a second,
different result for a finalised match; `AUTH_FORBIDDEN` for a non-service caller.

### 5.2 Invalidation is a submission-time decision (REQ-CC-044)

`status: "invalidated"` is accepted **only as a match's first and only terminal result** — the
anti-cheat or roster fault was known before the result was written. There is deliberately no
administrative path that invalidates an already-`completed` match, and a resubmission attempting
it is refused by §5's rule 5 like any other second truth.

This is a restriction, not an oversight, and it is recorded because the catalogue lists
`match.invalidated` with an `admin` actor. An honest administrative invalidation needs two
things that do not exist in this phase: an **append-only command** that preserves the original
result rather than overwriting it, and a **compensating career delta** that reverses what was
already applied. An edge added without both would move a career with nothing recording that it
did, and reverse nothing — worse than refusing, because the career would no longer reconcile
with the history §6 recomputes it from. When the command lands it adds a compensation
transition and a reversal delta together or not at all.

## 6. Career aggregation

- Career totals are derived from applied match results, never written directly.
- `score` does not aggregate — per-match score is a pacing device, not a career number.
- Derived values (K/D, accuracy, win rate) are computed at read time from stored counters.
  Storing a ratio means storing something that goes stale and disagrees with its inputs.
- Career totals must be **recomputable from scratch** from the match history. That recompute
  is the reconciliation check, and it runs as a scheduled job from P5.

### 6.1 The aggregation matrix (REQ-CC-044)

One row per §4.0 outcome. "Invalidated matches do not aggregate" was the only rule stated, so
forfeit, abandon and no-contest were left to inference — and `bomb-rules.md` §9 inferred
differently, which is how one lane ships a career total the other lane's ruleset says should
not exist.

| §4.0 outcome | Counters (kills, deaths, …) | `matches` | W/L/D |
|---|---|---|---|
| `completed`, any reason | applied | +1 | from `winnerTeam` and the player's team |
| `aborted` / `forfeit` | applied | +1 | the team that stayed **wins**; the team that quit **loses** |
| `aborted` / `abandon` | applied | +1 | as forfeit |
| `aborted` / `no-contest` | **not applied** | +0 | none |
| `invalidated` | **not applied** | +0 | none |

A no-contest and an invalidation are **recorded and not aggregated**: the match record is
immutable evidence either way, and neither produced a result anyone earned. A forfeit is the
opposite case and the distinction matters to players — the opponents who stayed won a match,
and the player who quit lost one.

**`result_applied_at`** (`db-schema.md` §4) is stamped in the same transaction as the career
application, on **every** terminal submission — including the two rows that aggregate nothing.
It records that the application step ran and completed, not that a career changed. Without that
distinction "ended, queued" and "ended, applied with nothing to apply" are the same row, and a
retry cannot tell whether it is a duplicate or a resumption.

**`match.result_applied`** is emitted from that same transaction, once per terminal submission,
after the status event (`match.completed` / `match.aborted` / `match.invalidated`). It carries
`accountsAffected`, which is `0` for an intentional skip. The status event says the match
ended; this one says the career side-effects are done — and a career applied with no event
explaining it is the state the outbox pattern exists to make impossible.

## 7. Evidence

`evidenceRef` points at the compact authoritative record: event timeline, key position and
combat samples, ruleset version, server build, roster, result, anti-cheat flags.

**The bar: the result must be reconstructable from evidence alone, with no client input.**
That is what makes a cheat report reviewable and a stat dispute settleable. Retention and
privacy class in `telemetry.md`.

## 8. Verification — `scripts/resulttest.mjs`

Each with its failing control:

1. Duplicate submission applies stats **once**. Submit the identical payload 10× concurrently.
2. Different payload for a finalised match is rejected.
3. Career totals recomputed from history equal the stored totals.
4. Every §3.1 contested case resolves as specified.
5. An invalidated match records but does not aggregate.
6. A crash between result write and event publish still delivers the event (outbox).
7. The result is reconstructable from evidence with the client's report discarded.
8. A browser-origin request to the result endpoint is refused.
