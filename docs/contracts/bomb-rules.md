# Contract 10 — Bomb ruleset

| | |
|---|---|
| **Status** | `FROZEN` — amendments follow CHANGELOG.md |
| **Version** | 2.0.0 — **§13 (symmetric demolition) supersedes the attacker/defender flow in §3–§7 and parts of §4, §5, §10–§12.** Read §13 first; earlier sections stand except where §13 names them |
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

> **Amended (1.8.0, P3):** Bomb remains the second and final **competitive** (Alpha) mode;
> nothing above changes. The P3 vertical slice adds `extraction-match.md`'s
> `mode='extraction'` — already `FROZEN` and already admitted at the schema level
> (`db-schema.md`'s `matches.mode` CHECK, `match-result.md` 2.1.0 §4.4) — as the table's
> **third and final** entry, out of the competitive rotation. The freeze mechanism is
> unchanged: `tdmtest.mjs`/`bombtest.mjs` assert the table verbatim
> (`tdm, bomb, extraction`), so a fourth mode — or any competitive third — still fails CI.

## 2. Parameters — **DECIDED** (D4)

Every rule in this contract holds for any values here; these are the numbers. Reasoning:
[`../decisions/P0-decisions.md`](../decisions/P0-decisions.md) §D4.

| Parameter | Value | Note |
|---|---|---|
| Rounds to win | **7** | Early win. A team reaching 7 ends the match immediately |
| Regulation rounds | **12** (`maxRounds: 12`) | MR12. 6-6 after 12 is a draw |
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

**If measured rotation on real geometry exceeds 22 s, the timer moves — not the map.** That is
by far the cheaper correction. `REQ-CX-002` is the request that produces the measurement from
`mapbalance.mjs` once graybox geometry exists.

### 2.1a Series semantics — one internally consistent rule (REQ-CC-013)

The earlier wording said both "first to 7, **max 13**" and "MR12, no overtime, 6-6 draw".
Those cannot both hold: max 13 permits a 7–6 thirteenth round, while MR12 ends after 12. The
contract was describing two different formats in adjacent rows.

**The Alpha series, stated once:**

```
maxRounds:   12        regulation, always
roundsToWin:  7        early win — reaching 7 ends the match immediately
6-6 after 12:          DRAW
```

| Situation | Outcome |
|---|---|
| A team reaches 7 at any point | Match ends immediately, that team wins. Remaining rounds are not played |
| After 12 rounds, 7–5 or wider | Winner already decided at round 7 by the rule above |
| After 12 rounds, 6–6 | **Draw.** `winnerTeam: "draw"` |
| Side switch | After round 6, so each side plays 6 attacking and 6 defending |

7 is reachable by round 12 at the latest (7–5), so the early-win rule and the 12-round cap
never conflict. `maxRounds: 12` is the value that appears in `net-facade.md` §5.1 `series`,
in the room `settings` block (`http-api.md` §11.3), and in the result record.

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
| Team drops to zero connected | Match ends, `terminationReason: aborted`, **`outcomeReason: forfeit`**, `winnerTeam` = the remaining team; stats recorded **and aggregated** (`match-result.md` §6.1). `forfeit` rather than `abandon` because the rule fires on the whole team being gone, which is an observable fact about the match; `abandon` is a per-player sanction judgement about *why* they left (§3 `abandoned`) and is not something the server decides from a connection count |
| Both teams drop to zero | Match **`aborted`** with `outcomeReason: no-contest` and `winnerTeam: null`; stats recorded but not aggregated. **Not `invalidated`** — invalidation is a review decision, not an outcome the server reaches on its own (`match-result.md` §4.0) |

## 10. Scoring

Per-round outcome drives the series. Individual stats per `match-result.md` §3.
`plants` and `defuses` count **completions only**.

Score awards extend the existing `SCORE` table with `plant`, `defuse`, `roundWin`, and
`clutch`. Values are balance, and belong to the human owner alongside §2.

## 11. Wire additions — `PROTOCOL_VERSION` → 2

Per `wire-protocol.md` §7 G3, all appended, never inserted:

**This list is the wire contract's §8, restated. If they disagree, §8 wins.**

- **Bomb position** `bombPositionVisible` + `bombX/Y/Z` in `MSG_MATCHSTATE`, per-recipient
  filtered (§8.6, §8.8). Coordinates are read only when the flag is set.
- **`interactRefused`** event kind 20, carrying requested kind and refusal reason (§8.7).
- **No new entity flag bit.** Planting and defusing ride in the appended `interact` u8 field
  (`wire-protocol.md` §8.5): bits 0–1 kind (0 none, 1 plant, 2 defuse), bits 2–7 progress 0–63.
  Two states plus progress in one byte, and flags bit 7 stays spare.
- Match state: round index, round phase, alive counts, bomb state, carrier id, site id,
  objective progress (0–63, from `interact`) and progress actor.
- Event kinds appended to `EV_KINDS`: `plantStart`, `plantComplete`, `plantCancel`,
  `defuseStart`, `defuseComplete`, `defuseCancel`, `bombDropped`, `bombPickedUp`,
  `bombDetonated`, `roundStart`, **`interactRefused`** (kind 20).

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

---

## 13. Amendment 2.0.0 — Symmetric demolition (CCR-002, owner-directed)

> **Owner directive (verbatim, on record):** *"I want the bomb to start in the middle of the
> map and players have to pick it up first. Then each side has their own plant site to defend.
> If dropped, the other team can pick it up and plant at the other site. Much more fun that
> way."*

This is a **breaking** amendment: it replaces the attacker/defender bomb flow with symmetric
(SOCOM-style) demolition. There is no new mode id — `bomb` changes playstyle. Everything in
§1–§12 that this section does not name **still holds unchanged**: parameters and durations
(§2, except the timer-expiry outcome), the phase list (§3), plant/defuse mechanics and
server-side accumulation (§6, §7), no-respawn and spectator limits (§8), backfill and
disconnect rules (§9), and the wire encoding (§11 — see §13.8, deliberately no
`PROTOCOL_VERSION` bump).

### 13.1 Roles: home site and target site

There are no attackers and defenders. Each team has:

- a **home site** — the site it defends and the only site it may defuse at;
- a **target site** — the enemy's home site, the only site it may plant at.

**Assignment is deterministic:** sites sorted by id (the order `compileObjectives` already
fixes). Before the side switch, team 0's home is the **first** site, team 1's home the
second. The §2 side switch after round 6 **swaps home sites** instead of swapping
attack/defense — it stays, because map geometry may still favour one site and each team must
defend each site for 6 rounds. A manifest MAY override the initial assignment with an
optional `homeSites: { '0': siteId, '1': siteId }` key (additive, `map-data.md`); absent it,
the sorted-order default applies. A map with more or fewer than **exactly two** plant sites
cannot host symmetric Bomb — refuse at match start, loudly, same policy as no sites at all.

Ownership is **derivable by any consumer** from (site order, `roundIndex`,
`sideSwitchAfterRound`) — all already on the wire or in the handoff (`MatchHandoff.sites`).
That is why §13.8 needs no new wire field.

### 13.2 Neutral bomb spawn

- **One** bomb per round. At `freeze` it is placed at the **neutral spawn point** in state
  `dropped`, `carrierId: -1`. Nobody starts carrying it. `_giveBombToRandomAttacker` and its
  per-round RNG draw are removed (determinism unaffected; nothing else read that stream).
- **Manifest source:** a new OPTIONAL `map-data.md` §3.3 objective kind **`bombSpawn`**
  (a point `{ x, y, z }`, or a box whose centre is used). At most one per map.
- **Derived default** (maps that declare none): the **midpoint of the two plant-volume
  centres** — not the bounds centre, because "middle of the map" in play terms is the point
  equidistant from the two things being fought over, and the bounds centre of an asymmetric
  bounding box can sit nearer one site. `bomb.lastValid` initialises to this point, so §5
  out-of-bounds recovery can never lose the bomb before first pickup. If the derived point is
  inside solid geometry, out-of-bounds recovery rules apply as for any drop; the GEOMETRY
  lane is expected to declare an explicit `bombSpawn` for any map where the midpoint is bad.
- The reader lives in `src/world/world.js` (CC lane) with `provenance.bombSpawn`
  `declared` / `derived`.

### 13.3 Pickup, carry, drop — both teams (§5 delta)

§5's table changes exactly two rows; the rest (carrier death drops at position, out-of-bounds
return, carrier disconnect drops, freely carryable, teammate-always/enemy-LOS carrier
visibility) is reused verbatim:

| Rule | Was | Now |
|---|---|---|
| Pickup | Any **attacker** | Any **living player of either team**, contact-range, no cast time |
| Defender contact | Cannot pick up | Row deleted — there are no defenders |

- **Contested pickup is deterministic:** when players of both teams are in range on the same
  tick, the **nearest** wins; exact distance ties resolve to the **lowest entity id**. (The
  current `_updateBomb` loop keeps the *last* equal-distance candidate — the implementation
  must make the tie-break explicit.)
- Pickup is possible only in `live` and `planted` phases — during `freeze` the bomb sits
  visible at the spawn and the round opens with a fair race.
- A **dropped/neutral** bomb's position is visible to **both** teams at all times
  (`bombPositionVisible` set for every recipient while `state === 'dropped'`). It is the
  shared objective; hiding it rewards stalling. This is server-side filter *policy*, not a
  wire-shape change. Carrier visibility is unchanged (§5): teammates always, enemies by LOS.
- Carrier death/disconnect: unchanged — drops at the body, now contestable by both teams.

### 13.4 Plant and defuse eligibility (§6, §7 delta)

Mechanics (server-side accumulation, hold-to-act, reset on interrupt, no stacking, 3.0 s /
7.0 s) are unchanged. Only the *who/where* preconditions change:

- **Plant:** any living player carrying the bomb, feet inside **their target site's** plant
  volume (the enemy's home). Planting at your **own** home site is refused with the internal
  reason **`wrongSite`**, which maps on the wire to the existing **`not-eligible`**
  (`RULESET_REFUSAL_REASON` in `src/net/server.js`). **`REFUSAL_REASONS` does not grow** —
  the internal `REFUSE` table is ruleset-local, the positional wire enum is untouched, and
  `PROTOCOL_VERSION` does not bump. (If a future consumer needs to distinguish `wrongSite`
  from other `not-eligible` refusals on the wire, THAT is a positional-enum append and a
  `PROTOCOL_VERSION` bump — do not smuggle it in.)
- **Defuse: the site owner only** — the team whose **home** site the bomb is planted at.
  Since a plant can only happen at the planter's target site, this is always exactly "the
  team that did not plant", but the rule is *stated* as ownership because that is the fact a
  player can see on the map. Justification: symmetric demolition's defensive identity is "my
  site, my problem" — letting the planting team defuse serves no play (they would only
  cancel their own plant) and letting anyone defuse anywhere dissolves the meaning of a home
  site. Wrong-team defuse attempts refuse `wrongTeam` → `not-eligible`, as today.

### 13.5 Win conditions and precedence (§4 delta)

The precedence *structure* survives; the team labels are rewritten and one outcome changes.

**Pre-plant, in order:**

1. Bomb planted → `planted`. Phase change, not a win. (Unchanged.)
2. A team fully eliminated → **the other team wins** (`elimination`). (Already symmetric.)
3. Round timer expires with no plant → **DRAW ROUND**: `winnerTeam: -1`, reason `timer`,
   neither team's `roundWins` increments. *Justification:* the old rule paid defenders for
   the clock running out, and there are no defenders. Awarding the timer to the team in
   possession invites the carrier to grab the bomb and hide — the exact degenerate play a
   neutral objective must not reward. A drawn round punishes passivity equally and pushes
   both teams toward the plant. **This is the one forced change to series structure — see
   §13.6.**

**Post-plant, in order (unchanged in shape):**

1. Bomb defused → **site owner wins** (`defuse`).
2. Bomb timer expires → **planting team wins** (`detonation`).
3. Site-owning team fully eliminated → **planting team wins** (`elimination`); the bomb
   still detonates for presentation.
4. **Planting team fully eliminated does NOT win the round for the site owner.** The bomb is
   planted; they must defuse it. Still the load-bearing rule, now stated in owner terms.

**Simultaneity rules (§4) carry over verbatim** — defuse beats timer expiry on the same
tick; a defuse completing on the tick its actor dies still completes.

### 13.6 Series structure — the forced delta (§2.1a)

`roundsToWin: 7`, `maxRounds: 12`, side switch after round 6, round timer, freeze, round-end
delay: **all unchanged.** What §13.5's drawn round forces:

| Situation | Outcome |
|---|---|
| A team reaches 7 wins | Match ends immediately, that team wins (unchanged) |
| After 12 rounds, unequal wins (draws having eaten rounds, e.g. 5–4–3 drawn) | **The team with more round wins takes the match**, `reason: 'roundWins'` — new, forced: 7 is no longer guaranteed reachable by round 12 |
| After 12 rounds, equal wins (6–6, 5–5, …) | **Draw**, as today |

Drawn rounds append to `rounds[]` with `winnerTeam: -1` and count toward `maxRounds`. No
score, no `roundWin` award, no clutch for a drawn round. `match.scores` still mirrors
`roundWins`.

### 13.7 Round record, evidence, stats (§10 / `match-result.md` delta)

- Round record: `attackingTeam` is **removed**; add `homeSites: { '0': siteId, '1': siteId }`
  (this round's ownership) and `plantedByTeam: 0 | 1 | null`. `winnerTeam` admits `-1`.
- `roundStart` evidence drops `attackingTeam`, carries `homeSites`. `sideSwitch` evidence
  carries the new `homeSites`. Everything else (`plantStart`…`interactRefused`) unchanged.
- Per-player `plants` / `defuses` definitions unchanged (completions only) — they are simply
  now earnable by **both** teams. Team aggregates become symmetric.
- `match-result.md` needs its own amendment (CC checklist): per-round
  `roles: { alpha, bravo }` (`attacker|defender`) becomes
  `homeSites: { alpha: siteId, bravo: siteId }`; the per-player starting `role` field is
  emitted as `null` (already legal in its type). That amendment follows its own CHANGELOG
  entry; this section is the requirement, not the edit.

### 13.8 Wire and facade — deliberately no `PROTOCOL_VERSION` bump

- `EV_KINDS`, `REFUSAL_REASONS`, `CANCEL_REASONS`, the `interact` byte, `MSG_MATCHSTATE`
  layout: **untouched.** Kinds `plant`/`defuse` keep their codes; refusals reuse
  `not-eligible` (§13.4); event headers are unchanged.
- `net-facade.md`'s `role: 'attacker'|'defender'|null` fields are served **`null`** — already
  legal in the frozen type. Consumers derive ownership per §13.1 from `MatchHandoff.sites`
  order + round index; no per-tick ownership field is added.
- Per-recipient bomb-position filtering policy changes for the `dropped` state (§13.3) —
  policy, not shape.
- If any implementation step finds it truly cannot avoid a wire change, that is a
  **stop-and-flag**: it bumps `PROTOCOL_VERSION` and must come back through CHANGELOG.

### 13.9 The siteoutcome harness — what "balanced" now means

The §7.1-derived "attack win rate per site, 45–55%" is dead: every round involves both sites
and both teams may attack. `scripts/siteoutcome.mjs` is redefined to measure:

1. **Home-defense win rate per site:** of the *decided* (non-draw) rounds in which a plant
   happened **or** the round's fighting was attributed to site S (bot commitment, same
   attribution discipline the harness already documents), the share won by S's **owner**.
   Balanced = each site's defense rate in **45–55%**, Wilson-gated exactly as today.
   This is the direct successor of the old number: it now answers "can each team defend its
   own site", which is what the owner's design makes the balance question.
2. **First-possession share:** the share of rounds in which team 0 takes first pickup.
   Balanced = **50±5%** over the full sample — this measures neutral-spawn fairness
   (spawn-to-bomb-spawn route symmetry), a quantity that did not exist before.
3. **Plant rate** gate: retained unchanged (≥40% of rounds reach a plant) — with a new
   sibling: **draw rate** is printed, and a draw rate above **20%** is escalated, because a
   symmetric mode that mostly times out is a mode where nobody can convert possession.
4. Attribution (§B) reads the bots' live committed state as today; the "same site for the
   whole squad" assertion becomes per-team (each team has exactly one possible target, which
   *simplifies* it).

RESULT-200 baselines are void; regenerate after implementation.

### 13.10 HUD (`src/ui/bomb` model vocabulary — CX lane requirement)

`bomb.state` vocabulary is unchanged (`none|carried|dropped|planted|defused|detonated`) —
neutral-at-spawn is `dropped`. The **role** vocabulary is replaced:

- `role` arrives `null`; `roleLabel` ("ATTACKER"/"DEFENDER"/"ROLE PENDING") is replaced by a
  home-site label (e.g. "DEFEND B / HIT A"), derived per §13.1.
- New state the HUD must speak: **neutral/dropped bomb** — "bomb up for grabs" marker,
  visible to both teams (§13.3), plus which team currently carries (teammate vs enemy
  carrier tint already exists; a `carrierTeam` derivation replaces the role-based one).
- Prompt gating changes from role-based to context-based: plant prompt = local player
  carries AND is at their target site; defuse prompt = local team's home site is planted.
- Carrying the bomb near your **own** site must NOT show a plant prompt (that is the
  `wrongSite` → `not-eligible` refusal, and the HUD should not invite it).

### 13.11 Bots (objective AI requirements — CC lane)

The planner's attacker/defender split is replaced by per-team objective states, all
deterministic per (seed, round, team): **contest** (race to the neutral/dropped bomb),
**escort/carry** (deliver to the fixed target site — site commitment logic simplifies: there
is exactly one legal target), **defend-home**, **retake/defuse** (own site planted), and
**post-plant hold** (planted at enemy site). Which bots contest vs defend at round start
must be a deterministic split (id parity is fine, as `lurk` is today). The old
"commit to a site" memoisation survives only as the escort route choice.

### 13.12 Verification delta (`scripts/bombtest.mjs`)

§12's list survives with labels rewritten, plus these new non-negotiable cases:

13. Neutral spawn: bomb `dropped` at the manifest/derived point at every freeze; no carrier.
14. Both teams can pick up; contested same-tick pickup resolves nearest-then-lowest-id,
    identically across two seeded runs.
15. Plant refused at own home site with `wrongSite` (wire: `not-eligible`); accepted at the
    target site; both before AND after the side switch (ownership swap proven).
16. Defuse accepted only for the site owner; refused `wrongTeam` for the planting team.
17. Pre-plant timer expiry → drawn round; neither `roundWins` moves; series arithmetic with
    draws (more-wins-after-12 victory, equal-wins draw).
18. Post-plant: planting team wiped does NOT end the round (rule §13.5.4, both directions).
19. Manifest `bombSpawn` honoured when declared; midpoint derived when absent; a map with
    ≠2 sites refused at match start.
