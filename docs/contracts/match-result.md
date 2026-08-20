# Contract 7 — Match result and canonical stats

| | |
|---|---|
| **Status** | `REVIEW` — amended per Codex review; awaiting re-sign-off |
| **Version** | 1.7.0 |
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
  "invalidationReason": null,
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
record. Whether they are **returned** depends on §4.2.

### 4.2 `TerminalResult` — the exact response union (REQ-CC-040)

No ellipses, no "every other field", no comment standing in for a variant. `GET
/v1/matches/:matchId` returns exactly one of four shapes, discriminated by `status`.

**`TerminalResult`** is the shared field set — every key present in all three terminal
variants:

```jsonc
{
  "matchId": "…", "status": "completed|aborted|invalidated",
  "rulesetVersion": "…", "statDefinitionVersion": "…", "rulesSnapshot": { … },
  "serverBuild": "…", "mapId": "…", "mapVersion": "…", "region": "…",
  "mode": "tdm|bomb",
  "startedAt": "…", "endedAt": "…",
  "terminationReason": "completed|aborted|invalidated",
  "outcomeReason": "elimination|defuse|detonation|timer|forfeit|abandon|no-contest",
  "winnerTeam": "alpha|bravo|draw|null",
  "invalidationReason": "cheat-detected|server-fault|roster-fault|admin-review|null",
  "roster": [ … ], "teamScores": { … }, "rounds": [ … ], "players": [ … ],
  "evidenceRef": "…",
  "correlationId": "…"
}
```

`invalidationReason` is a **closed enum or null** — it was previously fixed to null in the base
record while the invalidated variant required it non-null, with no type stated.

Status-dependent invariants, which is what makes the union checkable rather than decorative:

| `status` | `terminationReason` | `outcomeReason` | `winnerTeam` | `invalidationReason` |
|---|---|---|---|---|
| `completed` | `completed` | elimination \| defuse \| detonation \| timer | `alpha` \| `bravo` \| `draw` | **null** |
| `aborted` | `aborted` | forfeit \| abandon \| no-contest | `alpha` \| `bravo` **if** forfeit/abandon; **null** if no-contest | **null** |
| `invalidated` | `invalidated` | `no-contest` | **null** | **non-null**, from the enum |

Plus the non-terminal fourth shape, which shares only its identifiers:

```jsonc
// status: "pending" — live, or ended and awaiting persistence
{ "matchId": "…", "status": "pending",
  "mode": "tdm|bomb", "mapId": "…", "mapVersion": "…",
  "startedAt": "…",
  "endedAt": "…"|null,        // null while LIVE; the real timestamp once ended and queued
  "retryAfterMs": 2000,
  "correlationId": "…" }
```

| Case | Response |
|---|---|
| Live | `200`, `pending`, `endedAt: null` |
| Ended, result queued | `200`, `pending`, `endedAt` set |
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

## 6. Career aggregation

- Career totals are derived from applied match results, never written directly.
- `score` does not aggregate — per-match score is a pacing device, not a career number.
- Derived values (K/D, accuracy, win rate) are computed at read time from stored counters.
  Storing a ratio means storing something that goes stale and disagrees with its inputs.
- Invalidated matches do not aggregate.
- Career totals must be **recomputable from scratch** from the match history. That recompute
  is the reconciliation check, and it runs as a scheduled job from P5.

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
