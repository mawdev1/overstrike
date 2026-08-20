# Contract 10 — Bomb ruleset

| | |
|---|---|
| **Status** | `REVIEW` — amended per Codex review; awaiting re-sign-off |
| **Version** | 1.1.0 |
| **Owner** | [CC] Claude Code (rules), [HUMAN] (parameters) |
| **Consumers** | `match.js`, `modes.js`, wire protocol, HUD, evidence, analytics |

---

## 1. Scope

Bomb is the **second and final** Alpha mode. TDM proves movement, shooting, hit registration,
respawns, teams, scoring, replication, reconnect, and persistence. Bomb proves round state,
no-respawn play, planting and defusing, spectating, team coordination, objective scoring, and
match-series logic.

`src/game/modes.js` currently exports a frozen one-entry table (`MODES = { tdm }`). It becomes
a two-entry table. **Two entries is the freeze** — `tdmtest.mjs` and `bombtest.mjs` assert the
table's exact contents, so a third mode fails CI. That is deliberate: the roadmap's mode
freeze needs teeth, not goodwill.

## 2. Parameters — **DECIDED** (D4)

Every rule in this contract holds for any values here; these are the numbers. Reasoning:
[`../decisions/P0-decisions.md`](../decisions/P0-decisions.md) §D4.

| Parameter | Value | Note |
|---|---|---|
| Rounds to win | **7** (first to 7, max 13) | MR12 |
| Side switch | **After round 6** | Both teams attack and defend equally |
| Round length | **1:45** | Pre-plant |
| Freeze time | **8 s** | Positioning. There is no buy economy |
| Plant duration | **3.0 s** | |
| Defuse duration | **7.0 s** | |
| **Defuse kit** | **None in Alpha** | Without a buy economy a kit is an arbitrary spawn privilege. Adding one later is additive |
| **Bomb timer** | **40 s** after plant | Derived, not chosen — see below |
| Round-end delay | **5 s** | |
| **Overtime** | **None. 6-6 is a draw** | See below |
| Reconnect grace | **90 s** | Per `auth.md` §7 |
| Abandon threshold | 2 consecutive rounds absent | Drives the `abandoned` stat |

### 2.1 Why the bomb timer is 40 s

This is the one parameter that had to be derived. Set below a full rotation plus a defuse,
defenders can never retake and the mode collapses into a plant race:

```
worst-case A↔B rotation (map-data.md §7.0 envelope)  22 s
defuse                                                7 s
                                                    ─────
minimum viable timer                                 29 s
chosen                                               40 s   → 11 s to win the site fight
```

11 s is enough to contest a site and not enough to walk in unopposed.

**The margin narrowed from 13 s to 11 s** when the map envelope settled at 88 m rather than
80 m (`P0-decisions.md` §D3.1). 40 s still holds, but with less room than the first pass
assumed — so the REQ-CX-002 measurement is now load-bearing rather than confirmatory. Had the
envelope gone to Codex's full 104 m, the minimum would have been 35 s and 40 s would not have
survived.

**If measured rotation on real geometry exceeds 20 s, the timer moves — not the map.** That is
by far the cheaper correction. `REQ-CX-002` is the request that produces the measurement from
`mapbalance.mjs` once graybox geometry exists.

### 2.2 Why no overtime in Alpha

Overtime needs its own ruleset — round count, side switching, sudden death, and in most games
an economy reset that does not exist here. The roadmap's instruction is to prove two modes
work, not to ship a finished competitive ruleset. A draw is unsatisfying; an under-specified
overtime is a bug factory. Overtime is purely additive and can land any time after G1.

## 3. Round state machine

Server-authoritative, deterministic under the fixed 1/120 s step.

```
warmup → freeze → live → [planted] → roundEnd → freeze → … → matchEnd
```

| Phase | Behaviour |
|---|---|
| `warmup` | Pre-match. Free movement, no scoring, respawns on |
| `freeze` | Roster locked, movement restricted, loadouts final, round timer paused |
| `live` | Round timer runs. No respawns. Deaths are eliminations |
| `planted` | Round timer replaced by the bomb timer. **Elimination of attackers no longer wins the round** |
| `roundEnd` | Outcome resolved and recorded, corpses remain, no further scoring |
| `matchEnd` | Series resolved, result submitted |

## 4. Win conditions and precedence

Precedence is explicit because these genuinely collide, and an implementation that resolves
them by evaluation order will resolve them differently after any refactor.

**Pre-plant, in order:**

1. Bomb planted → transition to `planted`. Not a win, a phase change.
2. All attackers eliminated → **defenders win** (`elimination`).
3. All defenders eliminated → **attackers win** (`elimination`).
4. Round timer expires → **defenders win** (`timer`).

**Post-plant, in order:**

1. Bomb defused → **defenders win** (`defuse`).
2. Bomb timer expires → **attackers win** (`detonation`).
3. All defenders eliminated → **attackers win** (`elimination`) — the bomb still detonates for
   presentation, but the round is already decided.
4. **All attackers eliminated does NOT win the round for defenders.** The bomb is planted; they
   must defuse it. This is the single most important rule in the mode and the one most often
   implemented wrong.

**Simultaneity:** if a defuse completes on the same tick the bomb timer expires, **the defuse
wins**. Ties resolve in favour of the action a player took over the passage of time.

If the last defender dies on the same tick a defuse completes, the defuse wins — it completed.

## 5. Bomb object

| Rule | Behaviour |
|---|---|
| Spawn | One random eligible attacker at `freeze` |
| Carrier death | Drops at the death position, on the ground, pickable |
| Pickup | Any attacker, contact-range, no cast time |
| Defender contact | Cannot pick up or move it |
| Out of bounds | Returns to the last valid position. It can never be lost |
| Carrier disconnect | Drops at last position |
| Between sites | Freely carryable until planted |
| Visibility | Carrier flagged to teammates always; to enemies only by line of sight |

## 6. Plant

Preconditions, **all validated server-side**:

1. Attacker, alive, holding the bomb.
2. Feet inside a `plant` objective volume (`map-data.md` §3.3), grounded if `requiresGround`.
3. Round phase is `live`, not `planted`.
4. Plant key held continuously.

- Progress accumulates **on the server**, at the fixed step. The client displays server-driven
  progress and never simulates its own (`net-facade.md` §5.1).
- Interrupted by: releasing the key, leaving the volume, death, or round end. **Progress
  resets to zero — there is no partial credit and no resume.**
- On completion: phase → `planted`, bomb timer starts, `objective.planted` emitted, planter's
  `plants` incremented, all players notified regardless of line of sight.

## 7. Defuse

Preconditions: defender, alive, within the `defuse` volume, phase is `planted`, key held.

- Same server-side accumulation and same reset-on-interrupt rule.
- Multiple defenders do **not** stack. Two defenders defuse at one defuser's rate — otherwise
  a stacked defuse beats any retake timing and the post-plant phase stops meaning anything.
- On completion: defenders win, `objective.defused` emitted, `defuses` incremented.

## 8. No-respawn and spectating

- Death in `live` or `planted` is elimination until the next `freeze`.
- Eliminated players spectate. Alive counts are public to both teams (they are on the wire).

**Spectator information limits** — this is an anti-abuse rule, not a UX preference:

| Rule | Why |
|---|---|
| Dead players may spectate **only their own team's living players** | Spectating an enemy is a live enemy-position feed |
| No free camera during a live round | Same |
| Full free camera at `roundEnd` and `matchEnd` | Round is decided; nothing to leak |
| Dead players cannot use live team chat or pings | The classic relay: die, watch, call out. If voice ships later this becomes a hard requirement, since voice cannot be filtered by the server |

Dead-player chat is delivered at the next `freeze`.

## 9. Backfill and disconnects

**Bomb does not inject players into an active competitive round.** A roadmap requirement,
stated here as the implementation rule:

| Situation | Resolution |
|---|---|
| Join request, match in progress | Refused, `ROOM_IN_PROGRESS`. Not an error — the UI explains it |
| Reconnect inside grace, mid-round | Rebind to the existing entity. If eliminated, return as a spectator |
| Reconnect after grace | Refused until `matchEnd` |
| Disconnect while carrying | Bomb drops at last position |
| Disconnect mid-plant/defuse | Progress resets to zero |
| Team drops below 1 living | Round ends by elimination |
| Team drops to zero connected | Match ends, `terminationReason: aborted`; the remaining team wins |
| Both teams drop to zero | Match `invalidated`; stats recorded but not aggregated |

## 10. Scoring

Per-round outcome drives the series. Individual stats per `match-result.md` §3.
`plants` and `defuses` count **completions only**.

Score awards extend the existing `SCORE` table with `plant`, `defuse`, `roundWin`, and
`clutch`. Values are balance, and belong to the human owner alongside §2.

## 11. Wire additions — `PROTOCOL_VERSION` → 2

Per `wire-protocol.md` §7 G3, all appended, never inserted:

- Entity flag bit: `F_PLANTING` / `F_DEFUSING` (one spare bit remains in the flags byte —
  if both are needed, the byte is full and this becomes a new field, not a squeeze).
- Match state: round index, round phase, alive counts, bomb state, carrier id, site id,
  objective progress (0–255) and progress actor.
- Event kinds appended to `EV_KINDS`: `plantStart`, `plantComplete`, `plantCancel`,
  `defuseStart`, `defuseComplete`, `defuseCancel`, `bombDropped`, `bombPickedUp`,
  `bombDetonated`, `roundStart`.

## 12. Verification — `scripts/bombtest.mjs`

Every rule above, each with its failing control case. Non-negotiable cases:

1. Each §4 win condition, in isolation.
2. **All attackers eliminated post-plant does NOT win for defenders.**
3. Defuse completing on the exact tick the bomb timer expires → defuse wins.
4. Defuse completing on the tick the last defender dies → defuse wins.
5. Plant and defuse interrupted at every boundary: first tick, last tick, one tick before
   completion. Progress resets, no partial credit.
6. Two defenders do not defuse faster than one.
7. Carrier death, pickup, disconnect, out-of-bounds recovery.
8. Round transitions and side switch at the configured round.
9. Reconnect inside and outside grace, alive and eliminated.
10. Backfill refused mid-round.
11. Spectator cannot observe an enemy during a live round.
12. **Determinism:** two identical runs from one seed produce identical round outcomes,
    identical stats, and identical evidence.
