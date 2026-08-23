# Contract 20 — Dynamic events, locked zones, and the AI population director

| | |
|---|---|
| **Status** | `FROZEN` |
| **Version** | 1.0.0 |
| **Owner** | [CC] Claude Code |
| **Depends on** | `sector-interest.md` (14, `FROZEN` 1.0.0) for sector identity, activation state, and the AI think/path budget this contract scales, not replaces; `items-inventory.md` (15, `FROZEN` 1.0.0) for the item/instance system a key is built from; `extraction-match.md` (18, `FROZEN` 1.0.0) for `world_loot_containers`, the loot-roll algorithm, and the raid phase machine an event lives inside; `event-envelope.md` (8, `FROZEN` 1.4.0) for the event catalogue this contract extends; `feature-flags.md` (13, `FROZEN` 1.3.0) for the kill-switch shape §8.4 reuses; `db-schema.md` (11, `FROZEN` 2.1.0) for the migration this contract's schema lands in; `wire-protocol.md` (5, `FROZEN`) for the `REFUSAL_REASONS`/`PROTOCOL_VERSION` amendment §4 requires before implementation ships |
| **Consumers** | Match server (`src/game/**`), `BotManager` (`src/ai/botManager.js`), [CX] event/HUD presentation (contract only — no client behaviour specified here), P4-05 dashboards (observability surface, §9) |

---

## 1. Why this exists

P4-02's definition of done, verbatim from the Build Plan: dynamic events, locked zones with
keys/missions, rarity curves, and an AI population director must be **"server-authoritative,
tunable, observable, and bounded by performance and reward budgets."** Four words, four
places this contract answers them: §6 authority, §8 tuning, §9 observability, §7.4/§8.3
budgets.

This is additive to three systems that already ship, not a fourth parallel one:

- **`sector-interest.md`** already gives every sector a `populationCap`, a `baseThinkStride`,
  and a three-state activation machine (`dormant`/`warming`/`active`) that throttles AI
  think/path cost to where players actually are. A dynamic event that spawned its own AI
  outside that machine would reintroduce exactly the "statues that snap awake" and "unbounded
  simulation cost" problems §4 of that contract exists to prevent. The population director
  (§7) is a **client of** that budget, never a second source of think ticks.
- **`extraction-match.md`** already owns `world_loot_containers`, the deterministic
  `roll(lootTableId, seed)` algorithm, and the pickup/drop transactions. An event's loot is a
  container under that same mechanism with one additive `kind` value (§5), not a new loot
  pipeline.
- **`items-inventory.md`** already owns the item state machine, including a `consumed`
  terminal status. A key is a `material`-class item definition like `keycard_transit` — this
  contract does not invent a second notion of "an item that unlocks something."
- **`src/game/extractionContent.js`'s existing `AI_PROFILES`** already carry a
  `budget: { maxActivePerSector, maxActiveTotal }` shape per profile (`scav-patrol`,
  `sentinel-elite`) with a comment stating a profile "can never author MORE simulation than
  the server budgets, only how the budgeted population behaves." The population director
  (§7) is the mechanism that comment was written in anticipation of: it is the thing that
  decides, at runtime, which profile mix a sector runs and how hard, inside the caps that
  already exist. It does not add a new budget concept; it operationalizes one already declared
  but previously unconsumed.

## 2. Scope discipline (Build Plan hard constraint for this campaign)

P4-01 (map/sector expansion) and P4-03 (presentation polish) are out of scope for this work.
This contract therefore contains **zero new coordinates, volumes, or geometry**. Every spatial
reference below resolves through an id already declared in shipped map/content data:

- **Sector ids**: `square`, `north-yard`, `east-docks` — `EXTRACTION_SECTORS`
  (`src/world/level.js`, `sector-interest.md` §3.1's shape).
- **Anchor container ids**: the 9 rows already in `SQUARE_EXTRACTION.LOOT_CONTAINERS`
  (`src/world/level.js`) — `c-square-fountain`, `c-square-transit`, `c-square-archive`
  (sector `square`); `c-warehouse-mezz`, `c-warehouse-floor`, `c-container-alley` (sector
  `north-yard`); `c-customs-shed`, `c-pier-walk`, `c-quay-open` (sector `east-docks`). An
  event's spawn point is **always** one of these nine existing positions, referenced by id —
  this contract never authors a `position` field.
- **POI ids**: `POI_TAGS` (`src/game/extractionContent.js`) — `poi-fountain`, `poi-arcade`,
  `poi-alley`, `poi-tunnel`, `poi-archive`, `poi-transit` — used only for tagging/weighting
  (§8.1), never as a second source of position.

If a future phase wants an event anchored somewhere none of the above names, that is a
`map-data.md`/P4-01 amendment to make first — not something this contract can express by
inventing a box.

## 3. Event types

Two types, meeting P4-02's "at minimum" bar. Both are authored `DynamicEventDefinition` rows
(§8.1) resolved against one of the anchors in §2; neither introduces a new item-state or
container mechanism beyond what §5/§6 describe.

### 3.1 `cache_drop` — timed high-value loot event

An existing anchor container is, for the event's `activeWindow` (run-relative ticks, same
idiom as `ExtractionExit.activeWindow`), re-rolled against a richer loot table than its
static tier normally uses and flagged as an event container so it is announced (§4.1) rather
than discovered cold. It despawns — reverts to an ordinary sealed/opened container at its
original tier, contents re-rolled back to the anchor's normal `lootTableId` — if never opened
before the window closes. This is the "risk the player takes by not going" half of P4-02's
loot pressure: value is visible and time-boxed, not hidden and permanent.

### 3.2 `locked_zone` — key/mission event

An existing anchor container (or a small named cluster of anchors sharing one sector, §2) is
placed in a new `locked` container state (§5) that the ordinary "open a sealed container"
path (`extraction-match.md` §3.2) refuses until a **key** — a `material`-class,
non-stackable, `consumed`-on-use item instance of the exact `item_id` the event definition
names — is presented by the opening player. A key is loot: it drops, at low weight, from
ordinary loot tables or from a different `cache_drop` event elsewhere in the run, so reaching
a `locked_zone` is itself a small mission (find the key, then travel to the zone) built
entirely out of mechanism `extraction-match.md` and `items-inventory.md` already define — no
new item-transfer or objective-progress primitive.

## 4. Event lifecycle

### 4.1 State machine

Server-driven only, mirroring `extraction-match.md` §1's own posture ("the client renders
server-driven progress and never simulates its own") applied to an event instead of a
plant/defuse channel:

```
scheduled ──► announced ──► active ──┬──► resolved ──► despawned
                                      └──► expired  ──► despawned
      (any state) ─────────────────────────────────────────► despawned  (run reaches `ended`)
```

| State | Entered when | Meaning | Owned by |
|---|---|---|---|
| `scheduled` | `spinning-up` (§6.1) | Event exists as data (anchor, rarity, window) — not yet visible to any client, same posture `extraction-match.md` §3.1 gives an unrolled container before its run starts | This contract |
| `announced` | `activeWindow.start - EVENT_ANNOUNCE_LEAD_S` (§8.3) | Visible to sector-relevant clients (`sector-interest.md` §5) as upcoming; container mechanism (§5) not yet engaged | This contract |
| `active` | `activeWindow.start` | Container is live per §5 (`cache_drop`: richer roll; `locked_zone`: `state='locked'`, gate engaged). Population director (§7) counts it toward `pressure` | This contract |
| `resolved` | `cache_drop` opened, or `locked_zone` unlocked (§5) | Terminal (success). No further state changes | This contract → §9's `dynamicEvent.resolved` |
| `expired` | `activeWindow.end` reached with no `resolved` | Terminal (failure). Container reverts per §3.1/§3.2 | This contract → §9's `dynamicEvent.expired` |
| `despawned` | Immediately after `resolved`/`expired` is processed, or at run `ended` for any non-terminal event | Fully terminal — the event no longer counts toward §7's `pressure` or §8.3's concurrency caps | This contract |

Transitions are computed from server state only (§6). No client requests a transition; a
client's "open" request is validated against the container mechanism (§5), which is itself
gated by this state machine (`active` required for either event type's open path to exist at
all) — the same one-way authority split `sector-interest.md` §6 and `extraction-match.md` §2
already establish for their own state machines.

### 4.2 Scheduling budget

`MAX_CONCURRENT_EVENTS_PER_RUN` / `MAX_CONCURRENT_EVENTS_PER_SECTOR` (§8.3) count events in
`scheduled`, `announced`, or `active` — not `resolved`/`expired`/`despawned`. A resolved or
expired event frees its budget slot immediately; the next `scheduled` candidate (if any,
within `REWARD_VALUE_BUDGET_PER_RUN`, §8.3) may then advance to `announced`.

## 5. Container-level mechanism (additive to `extraction-match.md` §3.1)

`world_loot_containers.kind` gains one additive value: `'event'`. `state` gains one additive
value: `'locked'`. Two new nullable columns, both `null` unless `kind = 'event'`:

```sql
-- additive to extraction-match.md §3.1's world_loot_containers
ALTER TABLE world_loot_containers
  ADD COLUMN dynamic_event_id  text references dynamic_events,     -- §8.1 (this contract)
  ADD COLUMN requires_item_def_id text references item_definitions(item_id);

-- kind CHECK widens: check (kind in ('static','dropped','event'))
-- state CHECK widens: check (state in ('sealed','opened','locked'))
-- new CHECK: check (dynamic_event_id is not null or kind <> 'event')
-- new CHECK: check (requires_item_def_id is not null or state <> 'locked')
```

- **`cache_drop`** containers use `kind='event'`, `state='sealed'`, `requires_item_def_id
  IS NULL` — opened through the unmodified §3.2 pickup path in `extraction-match.md`, no new
  gate. Their only difference from a static container is `dynamic_event_id` (drives §9) and a
  richer `loot_table_id` (§8.2) for the window they're active (§4.1's `active` state).
- **`locked_zone`** containers use `kind='event'`, `state='locked'` while `active` (§4.1). The
  ordinary "open a sealed container" precondition in `extraction-match.md` §3.2 gains one
  additional branch:

  ```
  -- extraction-match.md §3.2's open precondition, extended:
  -- player alive, phase 'raid', in interact range, AND:
  --   state = 'sealed'                                              (unchanged path), OR
  --   state = 'locked' AND player holds an active, unlocked, run-location
  --     item_instances row with item_id = requires_item_def_id
  UPDATE item_instances SET status = 'consumed', updated_at = now()
  WHERE instance_id = $key_instance_id
    AND owner_account_id = $account_id AND location = 'run' AND run_id = $run_id
    AND item_id = $requires_item_def_id AND status = 'active' AND locked = false;
  -- rowcount = 1 required before the container's own state='locked' → 'opened' UPDATE runs,
  -- in the same transaction — a key that fails to consume never opens the zone, and a zone
  -- that fails to open never consumes the key. Both writes commit together or neither does.
  ```

  This is the same "atomic conditional UPDATE, rowcount decides" idiom `extraction-match.md`
  §3.2/§3.3 already use throughout, applied to one additional row. **The key is consumed**,
  distinct from `ExtractionExit.requiresItemDefId` in `extraction-match.md` §4 which is a
  presence check only — a `locked_zone` key is spent, an exit keycard is not, and this
  contract does not change the exit's behaviour.
- **Refusal**: an open attempt against a `state='locked'` container without a qualifying key
  instance is refused through the existing evidence path (`sector-interest.md` §6's
  `_record`/`interactRefused` precedent), reason `key-required` — proposed as the next
  append-only entry in `REFUSAL_REASONS` (`wire-protocol.md`, currently ending at
  `off-sector`, index 5; `key-required` lands at index 6). Per `wire-protocol.md` §9 and the
  precedent `sector-interest.md` §6 already set for `off-sector`, this is a `PROTOCOL_VERSION`
  bump landed in `wire-protocol.md` itself before implementation ships it — not optional
  groundwork left for later (recorded again in §12).

## 6. Server authority

Every rule in this section exists because a dynamic event is, mechanically, just another
container and another slice of AI population — and both of those already have a client that
cannot be trusted to report its own state (`extraction-match.md` §3.2's "server authority"
heading; `sector-interest.md` §6's off-sector refusal). Nothing here is a new authority
model; it is the existing one applied to two more nouns.

1. **Scheduling is server-only, seeded.** An event's existence, anchor, `activeWindow`, and
   rarity roll (§8.2) are computed once at `spinning-up` (mirroring
   `extraction-match.md` §3.1's "rolled at spinning-up, deterministically, from the run
   seed") from `hash(runSeed, eventSlotId)`, the same keyed-HMAC construction that contract
   already pins for containers. No client ever proposes an event, a rarity, or a spawn point.
2. **State transitions are server-only** (§4.1) — a client can request "open," exactly as it
   already can for any container; it cannot assert "this event is active" or "this zone is
   unlocked." The server's own `dynamic_events.state` is what the open-precondition in §5
   checks, never a client's claim about the event.
3. **Sector membership authorises access**, unchanged from `sector-interest.md` §6: an
   event's container inherits the anchor container's sector, so `sector-interest.md` §5's
   network relevance and §6's off-sector refusal already withhold a locked-zone container's
   existence, contents, and lock state from any client not relevant to that sector. This
   contract adds no second visibility rule — an event a player has no sector relevance to
   is invisible to them for the same reason a static container in that sector already is.
4. **A key is validated against the acting player's own `item_instances` row**, never
   against a claimed inventory. §5's `UPDATE ... WHERE instance_id = $key_instance_id AND
   owner_account_id = $account_id ...` is the entire check; there is no second "does this
   player have the key" query a client's yes/no can substitute for.

## 7. Population director

### 7.1 What it extends and what it must never do

`sector-interest.md` §4.3 already states the budget: `dormant` sectors think zero, `warming`
sectors think at doubled stride/halved path share, `active` sectors think at full per-bot
stride, all bounded by that sector's `populationCap`, with overflow **refused, not queued**.
The director does not touch any of that machinery — it does not add a fourth activation
state, does not raise a `populationCap`, does not create a second think/path budget, and does
not run faster than the sim clock the rest of `botManager.js` is keyed to (its own header
comment: "budgeted on the SIMULATION clock, never on `game.frame`"). What it *does* is decide,
within those unchanged limits, **which of the already-declared `AI_PROFILES` mix a sector's
population draws from while a dynamic event is `active` there** (§4.1) — exactly the decision
`extractionContent.js`'s own `AI_PROFILES.budget` comment says is left to a runtime director.

### 7.2 Trigger and cadence

The director runs on the sim clock at `DIRECTOR_INTERVAL_S` (§8.3, default 5 s — coarser than
`botManager.js`'s per-bot 8/4-step think stride on purpose: population mix is a slow decision,
re-evaluating it every tick would just thrash spawn/despawn requests against §7.3's overflow
rule for no behavioural gain). One director pass, per run:

```
for each sector S in EXTRACTION_SECTORS:
  if S.activationState (sector-interest.md §4.1) is 'dormant': skip — no population decision
                                                                       to make for AI that isn't
                                                                       thinking anyway
  pressure = sum over dynamic_events e where e.sectorId = S.id and e.state = 'active' (§4.1)
             of RARITY_WEIGHT[e.rarityTier]                              -- §8.2's table
  target   = clamp(S.baseline + pressure * DENSITY_PER_PRESSURE,          -- §8.3 knob
                    0, S.populationCap)                                   -- sector-interest.md §3.1
                                                                            hard ceiling, never
                                                                            exceeded
  eliteShare = S.activationState = 'active' ?                             -- §7.3's warming
               clamp(pressure / max(1, S.populationCap), 0, MAX_ELITE_SHARE) : 0  -- exclusion
  eliteCount = min(round(target * eliteShare),
                    AI_PROFILES['sentinel-elite'].budget.maxActivePerSector)   -- profile's own
                                                                                 declared cap,
                                                                                 §1's "never MORE
                                                                                 than the server
                                                                                 budgets"
  request: (target - existing) spawns/transfers at the resulting profile mix,
           via the SAME spawn/transfer path sector-interest.md §4.3 already governs
```

### 7.3 Overflow, decay, and what is deliberately unchanged

- **Refused, not queued** — identical rule to `sector-interest.md` §4.3. A director request
  that would push a sector over `populationCap` is simply not granted in full; the director
  does not retry it next pass beyond recomputing `target` fresh from current state. No pending
  spawn queue exists anywhere in this contract, for the same determinism reason
  `sector-interest.md` §4.3 gives.
- **No eviction.** The director never force-despawns an existing bot to make room for a
  higher-`eliteShare` mix; `target`/`eliteCount` bound *arrivals* exactly as `populationCap`
  already does.
- **Decay, not a cliff.** When `pressure` drops (event resolved/expired/despawned, §4.1),
  `target` drops with it next pass, but existing AI is not mass-despawned — population is
  allowed to fall only through the sector's own ordinary attrition (deaths,
  `RESPAWN_DELAY`-gated respawns choosing the new lower `target`) over
  `EVENT_POPULATION_DECAY_S` (§8.3), the same "fixed grace period rather than an instant
  cutoff" posture `sector-interest.md` §4.1 already applies to `SECTOR_COOLDOWN_S`.
- **`warming` sectors get zero elite bias.** `eliteShare` is only ever applied in `active`
  sectors (§7.2's ternary) — a `warming` sector already runs at halved path share and
  doubled stride (`sector-interest.md` §4.3); raising its elite mix while it is barely
  thinking would make a sector "harder" in a way no player is present yet to observe, which
  is the exact statue problem §4.2 of that contract exists to prevent, applied to difficulty
  instead of presence.
- **Never sector-populationCap-authoring.** The director reads `populationCap` and each
  profile's `budget`; it authors neither. Retuning either is a `map-data.md` (`sectors`) or
  `extractionContent.js` (`AI_PROFILES`) change, not a director runtime decision.

### 7.4 Performance budget

The director pass itself is O(sectors × active events in that sector) per `DIRECTOR_INTERVAL_S`
— at the shipped map's 3 sectors and §8.3's `MAX_CONCURRENT_EVENTS_PER_RUN` (default 4), this
is a handful of comparisons every 5 s of sim time, not a per-tick or per-bot cost. It produces
*requests* consumed by the existing spawn/transfer path; it does not itself run `think()` or
`findPath()`, so it adds nothing to the ~1.5 ms/tick budget `botManager.js`'s header comment
already measures — it only ever changes which profile that budget's population is drawn from.

## 8. Tunable knobs — config surface, not hardcoded constants

Every numeric/behavioural value named in §3–§7 above is a field of `DYNAMIC_EVENTS_CONFIG`,
authored the same way `extractionContent.js`'s `RUN_RULES`/`AI_PROFILES` already are: a
frozen, versioned data export the raid server reads at `spinning-up`, never a constant baked
into `src/game/**` control flow. This mirrors `feature-flags.md`'s own split between mechanism
(this contract) and value (data) — the config below is the "value" half.

### 8.1 Event roster

```js
DynamicEventDefinition = {
  eventSlotId,            // stable id, this run's deterministic seed input (§6.1)
  type: 'cache_drop' | 'locked_zone',
  sectorId,                // one of EXTRACTION_SECTORS ids (§2) — no new sector vocabulary
  anchorContainerId,        // one of the 9 existing LOOT_CONTAINERS ids (§2)
  poiTags?: string[],       // optional weighting filter against POI_TAGS.tags (§2) — advisory,
                             // same "advisory authoring tag" posture POI_TAGS.lootTier already has
  rarityTier,               // common|uncommon|rare|epic|legendary — items-inventory.md §2's
                             // existing closed enum, reused rather than a parallel one
  lootTableId,               // cache_drop only — an existing or event-specific LOOT_TABLES key
  requiresItemDefId,          // locked_zone only — an item_id from ITEM_DEFINITIONS, class='material'
  activeWindow: [startTick, endTick],   // run-relative, ExtractionExit's idiom verbatim
}
```

### 8.2 Rarity curves

`RARITY_CURVE`: a weight table over `rarityTier`, walked by the identical fixed-order,
weighted-sampling algorithm `extraction-match.md` §3.1.1 already pins for loot tables
(ascending stable `id`, `mulberry32` seeded from `hash(runSeed, eventSlotId)`) — **not a new
random source**, the same one, applied to "which rarity does this event slot roll" instead of
"which loot table entry drops." One curve per event type, since a `locked_zone`'s payoff
(gated behind a key + travel) should skew rarer than an unconditional `cache_drop`:

| `rarityTier` | `cache_drop` default weight | `locked_zone` default weight |
|---|---|---|
| `common` | 0.35 | 0.05 |
| `uncommon` | 0.30 | 0.15 |
| `rare` | 0.22 | 0.35 |
| `epic` | 0.11 | 0.35 |
| `legendary` | 0.02 | 0.10 |

`RARITY_WEIGHT[tier]` (§7.2's `pressure` input) is a separate, small integer table —
`{ common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5 }` — deliberately not derived from
the probability weights above: rarity *probability* and rarity's *pull on AI density* are two
different tunables answering two different questions, and collapsing them into one number
would make retuning drop rates silently retune AI pressure too.

### 8.3 Spawn/lifecycle/budget knobs

| Knob | Default | Meaning |
|---|---|---|
| `MAX_CONCURRENT_EVENTS_PER_RUN` | 4 | Hard cap on events in `scheduled`/`announced`/`active` (§4.2) across all sectors |
| `MAX_CONCURRENT_EVENTS_PER_SECTOR` | 2 | Same, scoped to one sector — prevents one sector absorbing the whole run's event budget |
| `EVENT_ANNOUNCE_LEAD_S` | 20 | Sim-time between `announced` and `active` (§4.1) — gives players time to path toward it before the window opens |
| `CACHE_DROP_WINDOW_S` | [180, 300] range | `cache_drop` `activeWindow` length, rolled per event within the range by the same seeded RNG as §8.2 |
| `LOCKED_ZONE_WINDOW_S` | [300, 600] range | Longer — a `locked_zone` requires travel-to-key first, so its window must outlast a `cache_drop`'s |
| `REWARD_VALUE_BUDGET_PER_RUN` | 220 (sum of rolled items' `baseStats.salvageValue`, `items-inventory.md` §2's authored field, plus a fixed 40-per-non-salvage rare/epic/legendary item credit) | The reward-budget half of P4-02's DoD — the scheduler (§6.1) refuses to advance a `spinning-up` event roster whose *expected* value (rarity-weighted) exceeds this; a run does not get an unbounded number of high-rarity slots just because §8.3's count caps allow it |
| `DIRECTOR_INTERVAL_S` | 5 | §7.2 cadence |
| `DENSITY_PER_PRESSURE` | 0.15 × `populationCap` per unit `pressure` | §7.2's `target` slope |
| `MAX_ELITE_SHARE` | 0.5 | §7.2 ceiling on `sentinel-elite` proportion of an event-pressured sector's population |
| `EVENT_POPULATION_DECAY_S` | 25 | §7.3 decay window, deliberately longer than `SECTOR_COOLDOWN_S` (8 s, `sector-interest.md` §4.1) — a population mix should outlast a single player's boundary-pacing, not track it |

### 8.4 Kill switch

`events.dynamic.enabled` — named per `feature-flags.md` §2 (`<domain>.<subject>.<qualifier>`),
default **on**, kill switch **yes**. Off behaviour, following that contract's own "hides the
entry point; never kills what's in progress" rule (§3.2): no event advances past `scheduled`
(§4.1); any event already `announced`/`active` at flip time runs to its own `activeWindow` end
or resolution, then the run's event roster is not replenished. This is the P4-02 emergency
lever if the reward/performance budgets (§8.3, §7.4) prove wrong under real load — the same
posture `match.allocation.enabled` gives the rest of the platform.

## 9. Observability surface

Additive to `event-envelope.md` §6's catalogue, same posture `extraction-match.md` §8 and
`settlement.md` §9 already take for their own new types. `subject.kind` is `match` throughout
— a dynamic event lives inside one run — so per-subject ordering (`event-envelope.md` §3)
holds automatically. Prefix `dynamicEvent.*`, distinct from `extraction.*`
(`extraction-match.md` §8) and `run.*` (`settlement.md` §9), for the same collision-avoidance
reason those two already give each other.

| Type | Actor | Fires when (§4.1) | Payload (beyond the envelope) | Privacy | Retention |
|---|---|---|---|---|---|
| `dynamicEvent.scheduled` | service | `spinning-up` | `eventSlotId, type, sectorId, anchorContainerId, rarityTier, activeWindow` | internal | standard |
| `dynamicEvent.announced` | service | `scheduled → announced` | `eventSlotId` | internal | standard |
| `dynamicEvent.activated` | service | `announced → active` | `eventSlotId` | internal | standard |
| `dynamicEvent.resolved` | player | `active → resolved` | `eventSlotId, accountId, rewardValue` | internal | standard |
| `dynamicEvent.expired` | service | `active → expired` | `eventSlotId` | internal | standard |
| `dynamicEvent.despawned` | service | `resolved`/`expired` → `despawned`, or forced at run `ended` | `eventSlotId` | internal | standard |
| `dynamicEvent.director.adjusted` | service | §7.2 pass changes a sector's `target`/`eliteShare` by more than a no-op | `sectorId, pressure, target, eliteCount, refusedCount` | internal | standard |

`refusedCount` on the director event is what makes §7.3's "refused, not queued" rule
measurable rather than asserted: a sector whose `refusedCount` is consistently nonzero is a
`populationCap` or `DENSITY_PER_PRESSURE` tuned too aggressively for its footprint, and is
exactly the signal P4-05's dashboards need to say so — this contract emits the number, it
does not itself judge it (P4-05's funnel/heatmap analysis is explicitly human-only, per this
campaign's scope note).

**Metrics** (derived from the above, for P4-05's dashboards — instrumentation surface only,
no dashboard content or analysis authored by this contract):

- Active event count per sector over time (from `activated`/`resolved`/`expired`/`despawned`).
- Time-to-first-interaction per event (`activated` → first `resolved`, or "never" if
  `expired`) — the funnel P4-05 needs to tell "nobody found it" from "everyone found it and
  it worked."
- Reward value distributed per run vs. `REWARD_VALUE_BUDGET_PER_RUN` (§8.3) — the budget
  compliance metric, computed directly from `resolved.rewardValue` sums.
- Director `refusedCount` per sector per run (population-budget pressure, above).
- `locked_zone` resolutions with a `deathCause` in the same `phaseLog` window before/after
  (contested-open signal — reuses `extraction-match.md` §7's `evidenceRef` shape, no new
  evidence record).

## 10. Non-goals / explicitly deferred

- **Running an Alpha or drawing conclusions from usage data.** P4-07 (closed Alpha) and the
  funnel/heatmap *analysis* portion of P4-05 are explicitly human-only for this campaign; this
  contract specifies the instrumentation (§9) those humans will read, not a finding.
- **New geometry, volumes, or POIs.** §2 is a hard constraint, not a simplification —
  P4-01/P4-03 own that surface.
- **Missions beyond "find a key, reach a zone."** A richer mission graph (multi-step,
  branching, faction-gated) is a P4+ extension of the same key/consumption mechanism §5
  already provides; this contract's "missions" scope is the single-key case P4-02 names.
- **Client-side event prediction or pre-rendering.** Same posture `sector-interest.md` §7
  already takes toward sector prediction — a Codex/presentation concern with no bearing on
  server authority, deferred to whichever contract eventually specifies the client HUD.
- **Per-event custom AI behaviour.** The population director changes *mix and density*
  (§7), never bot decision logic itself — `Bot`'s state machine (`src/ai/bot.js`) is
  unmodified by this contract.

## 11. Verification — `scripts/dynamiceventstest.mjs` (to be written alongside implementation)

Each with its failing control, mirroring the pattern `extraction-match.md` §9 and
`sector-interest.md` establish:

1. Every §4.1 event state transition, in isolation, including illegal ones refused.
2. A `cache_drop` never opens through any path but the unmodified §3.2 (`extraction-match.md`)
   pickup precondition it inherits; it is drawn from `lootTableId` while `active` and reverts
   to its anchor's original tier/table on `expired`.
3. A `locked_zone` open attempt without a qualifying key is refused with `key-required`
   (§5) and never partially consumes a non-matching item instance.
4. A `locked_zone` open **with** a qualifying key: the key transitions to `status='consumed'`
   and the container to `state='opened'` in the same transaction — verified atomic by forcing
   a mid-transaction fault and asserting neither write survives alone.
5. Two players presenting keys at one `locked_zone` on the same tick: first-applied wins
   (container flips to `opened`), the second is refused — identical resolution shape to
   `extraction-match.md` §3.2's simultaneous-open case.
6. `spinning-up` event roster generation is deterministic and reproducible from
   `(runSeed, sectorVersion, lootTableVersion, eventSlotId)` alone, across two independent
   rolls, per §6.1/§8.2's reuse of `extraction-match.md` §3.1.1's algorithm.
7. §7.2's director never requests a spawn/transfer that would push any sector over its
   `sector-interest.md`-declared `populationCap`, across a swept range of `pressure` values
   including the boundary case `pressure` that would round `target` to exactly `populationCap
   + 1` absent the `clamp`.
8. §7.3 overflow: a director request beyond capacity is refused, not queued — asserted by
   confirming no retry occurs on the next director pass beyond a fresh `target` computation,
   and that no existing bot is evicted.
9. `MAX_ELITE_SHARE` bounds `eliteCount` even when `pressure` alone would imply a higher
   share; `eliteCount` never exceeds `AI_PROFILES['sentinel-elite'].budget.maxActivePerSector`
   even when the sector-level arithmetic alone would allow it.
10. A `warming`-state sector never receives a nonzero `eliteShare` request (§7.3).
11. `REWARD_VALUE_BUDGET_PER_RUN` bounds the scheduler: a swept range of random seeds never
    produces a `spinning-up` roster whose expected rarity-weighted value exceeds the budget.
12. `events.dynamic.enabled = false`: no event advances past `scheduled`; an event already
    `announced`/`active` at flip time runs to its own resolution/expiry unaffected — toggled
    off and back on without error, per `feature-flags.md` §7's own verification rule.
13. Off-sector relevance: a client with no relevance to an event's sector receives none of
    `dynamicEvent.*`'s existence, position, lock state, or contents — reusing
    `sector-interest.md` §5.2's filter stage directly, asserted the same way that contract's
    own suite asserts it for ordinary containers.
14. Determinism end-to-end: two identical runs from one run seed and one input stream produce
    identical event rosters, identical director `target`/`eliteCount` sequences, and identical
    `dynamicEvent.*` event streams.

## 12. Sufficiency check and freeze record

Checked against P4-02's Build Plan definition of done and this document's own dependencies
before marking `FROZEN`:

- **"Server-authoritative"** — §6, backed by §4.1 (state machine, server-only transitions),
  §5 (container gate, atomic conditional UPDATEs), and §7.2's director reading server-only
  `sector-interest.md` activation state. No client-asserted fact appears anywhere in the
  mechanism.
- **"Tunable"** — §8's `DYNAMIC_EVENTS_CONFIG`. Every constant introduced in §3–§7 is listed
  in §8.1–§8.4 as a named, defaulted, authored-data knob, not inlined in prose.
- **"Observable"** — §9's event catalogue and derived metrics, keyed to feed P4-05 without
  performing P4-05's human-only analysis itself (§10).
- **"Bounded by performance and reward budgets"** — §7.4 (director pass cost, tied to the
  existing `botManager.js` budget it never exceeds) and §8.3's `REWARD_VALUE_BUDGET_PER_RUN`
  (economy-side bound), both independently verified in §11 (items 7–11).
- **Locked zones with keys/missions, reusing `items-inventory.md`'s item system** — §3.2, §5.
- **Rarity curves** — §8.2.
- **AI population director extending `sector-interest.md`'s per-sector AI budget** — §7,
  explicit in §7.1 about what it extends and in §7.3 about what it must never override.
- **Scope discipline** — §2 confirmed against `src/world/level.js`'s actually-shipped
  `EXTRACTION_SECTORS`/`LOOT_CONTAINERS` and `src/game/extractionContent.js`'s actually-shipped
  `POI_TAGS`/`AI_PROFILES` (read before authoring, not inferred) — no coordinate, volume, or
  geometry is original to this document.
- **No open `PENDING DECISION` blocks buildability.** The two items below are tuning/sequencing
  notes, not gates — everything else in this document is buildable now, the same "single open
  question does not freeze a whole document" posture `README.md`'s status vocabulary states:
  - `REFUSAL_REASONS: 'key-required'` and its `PROTOCOL_VERSION` bump (§5) must land in
    `wire-protocol.md` before the `locked_zone` gate specifically ships — recorded so it is
    not discovered mid-implementation, exactly as `sector-interest.md` §6 recorded the same
    dependency for `off-sector` before its own implementation shipped.
  - `REWARD_VALUE_BUDGET_PER_RUN`'s default (220) is a starting value pending measurement
    against real run economies once P4-04's progression loop is live — the same
    "tuning input, not blocking" posture `sector-interest.md` §8 already takes toward
    `SECTOR_COOLDOWN_S`.
  - `item_definitions` rows for `locked_zone` keys are not authored here — data authoring
    (`extractionContent.js`) is a downstream content task against this mechanism, the same
    division `items-inventory.md`/`extraction-match.md` already draw between mechanism and
    P3-11-equivalent data.

No section of this contract is marked `PENDING DECISION`. Frozen at 1.0.0.
