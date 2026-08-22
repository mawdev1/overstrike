# Contract 14 — Sector interest and AI activation budgets

| | |
|---|---|
| **Status** | `FROZEN` |
| **Version** | 1.0.0 |
| **Owner** | [CC] Claude Code |
| **Consumers** | Extraction match server (`src/game/**`, `src/net/server.js`), Codex sector streaming (P3-07, contract only) |

---

## 1. Why this exists

P3 turns one small arena into a raid across multiple sectors — The Square plus two
adjoining sectors at first, more at P4-01. Two things break if sectors are treated as
cosmetic labels on an otherwise-flat world:

1. **Network cost.** The arena shooter's `_broadcastSnapshot` sends every entity to every
   client every tick (§6 of this contract). That is affordable at 80m × 80m and a dozen
   bots. It is not affordable across a multi-sector raid map with a much larger population
   of loot, containers, and AI — most of which no player is anywhere near. Sectors are the
   unit interest is computed at, the same way `EVENT_RANGE_M` already culls events by
   distance.
2. **Simulation cost and fairness.** `BotManager`'s think/path budget (`src/ai/botManager.js`)
   is sized for one always-active roster. A raid map has many sectors and must not run full
   AI simulation in sectors nobody has entered — both because it is wasted CPU and because
   an idle sector's bots should not be able to accrue state (movement, aggro, loot pulls)
   that a player later benefits from or is ambushed by without ever having been observed
   converging.

This contract exists before P3-06 (map) and P3-07 (client streaming) start, per the lane
split: Codex builds sector geometry and client streaming *against* this document rather
than inferring server behaviour from `server.js`.

## 2. Relationship to the existing arena systems

This is additive to, not a replacement for, what already ships:

- `EVENT_RANGE_M` / `EVENT_RANGE_SQ` (`server.js`) already cull spatial events by a flat
  90 m radius per recipient. Sector interest is the coarse-grained filter applied *before*
  that: an entity or event in a sector the client has no relevance to is never considered,
  regardless of raw distance. The 90 m event cull continues to apply *within* sectors the
  client is relevant to — sector interest does not loosen it.
- `_bombPositionAuthorised` is the existing precedent for "authorise the recipient against
  the fact, not against where the client claims to be." §7 below is the same pattern
  generalised from one flag (bomb carrier) to loot/combat actions across sectors.
- `BotManager`'s per-bot `thinkStride`/`thinkPhase` and `PATH_BUDGET` round-robin are the
  existing precedent for "the expensive part is throttled globally, keyed to the
  simulation clock, never to render frames." §4 below extends that same shape from "one
  roster" to "one budget per active sector."

Nothing in `botManager.js` is sector-aware yet — `_buildSweepBoard` scores one map's worth
of POIs for exactly two teams. P3-05's implementation adds a sector key to the roster and
the sweep board; it does not replace the stride/budget machinery described in that file's
header comment.

## 3. Sector definition and boundaries

- A **sector** is a named, server-authoritative **axis-aligned box** volume of the raid map:
  `box: { min: Vector3, max: Vector3 }`, the exact same shape `map-data.md` §3.3/§3.4 already
  use for objective volumes and callout regions. This is a deliberate correction from an
  earlier draft of this contract, which described sectors as a polygon footprint plus a
  separate Y range — **no such polygon-authoring primitive exists anywhere in `map-data.md`
  today**, and inventing one here would require its own `maptest.mjs`/`navtest.mjs` guard
  work that is not scoped in this contract, P3-06, or the Build Plan. Sectors are AABBs,
  full stop; `min`/`max` already carry the Y range as their `y` components, so there is no
  separate Y-range field. A "sector" is therefore authored identically to an objective
  volume, just with a different manifest key (§3.1) and a neighbour/population annotation
  (below) that objective volumes don't carry. If a future phase needs a non-box footprint,
  that is a breaking change to this contract and to `map-data.md` alike, not an additive one.
  Sector IDs are short stable strings (e.g. `square`, `north-yard`, `warehouse`), never array
  indices — P4-01 adds sectors and an index would renumber everything downstream.
- Sectors **tile the playable map with no gaps and no overlap** at ground level. Every point
  a player or bot can stand is in exactly one sector. This is a hard authoring constraint
  the server validates at map load: an unowned or double-owned point is a load-time error,
  not a runtime one — the same posture `map-data.md` takes on nav bake integrity. Because
  sectors are boxes (above), "no gaps and no overlap" is checked the same way `map-data.md`
  §3.4 already checks callout-region coverage over `bounds` — box-vs-box, not polygon-vs-polygon.
- Each sector declares its **neighbour set** (sector IDs sharing a traversable boundary).
  Neighbours matter for two things: (a) the pre-activation ring in §4.2, and (b) the
  "adjacent sector" relevance grant in §5.2 for a player standing near a boundary.
- A **transition zone**: a shared strip up to 6 m wide either side of a sector boundary
  edge, where a player is simultaneously relevant-in-both-sectors (§5.2). This avoids a
  hard interest cliff exactly on the line players and bots cross most often.
- Sector membership is computed from **entity footprint**, not a single point: an entity
  is in a sector if its position (feet, matching `map-data.md`'s ground convention) resolves
  inside that sector's box. Containers and static loot use their placement point. This is
  server-computed on placement and re-evaluated on every entity move; no entity is ever
  client-declared to be in a sector (see §7).

### 3.1 Where sectors live in map data, and the exact manifest shape

Sectors are an **additive amendment to `map-data.md`**, following that contract's own
amendment rules (§ its header: `FROZEN` — amendments follow `CHANGELOG.md`, new field, minor
version bump, no CCR). `MAP_MANIFEST` (`map-data.md` §3, currently
`{ bounds, spawns, objectives, callouts, navHints, budgets }`) gains one new top-level key:

```js
export const MAP_MANIFEST = {
  bounds, spawns, objectives, callouts, navHints, budgets,
  sectors,   // new in this amendment — see shape below
};
```

`sectors` is an array of:

```js
{
  id: 'square',                        // stable forever, never an index (see above)
  box: { min: Vector3, max: Vector3 }, // authoring shape identical to objectives/callouts
  neighbours: ['north-yard', 'warehouse'],  // sector IDs sharing a traversable boundary
  populationCap: 12,                   // max concurrent AI entities (§4.3)
  baseThinkStride: 8,                  // this sector's `active`-state think stride baseline
}
```

P3-06 (Codex) is the producer of this amendment: it adds the `sectors` array to
`MAP_MANIFEST`, bumps `MAP_VERSION`'s minor version (this is additive per `map-data.md`'s own
rules — no new field type, no removed/renamed field, no CCR required), and adds the
corresponding `CHANGELOG.md` line, exactly as `map-data.md`'s own amendment process requires
for any other additive change to that manifest. This contract does not itself amend
`map-data.md` — it specifies the exact shape P3-06 must produce, so a P3-06 implementer has
zero ambiguity about the field name, per-sector keys, or which version bumps.

### 3.2 `sectorVersion` and `sectorSet` (shared vocabulary with `extraction-match.md`)

`extraction-match.md` uses these two terms as if already defined here; this contract is
where they are defined, since sector identity/versioning belongs to contract 14:

- **`sectorVersion`** is `map-data.md`'s own `MAP_VERSION` at the time a raid was deployed.
  Sectors are not independently versioned — they are one field inside `MAP_MANIFEST`, and
  `MAP_VERSION` already bumps on **any** change affecting §3.2–§3.5 of `map-data.md`, which
  after this amendment includes the `sectors` array. A raid run's `sectorVersion` is
  therefore just the deployed map's `MAP_VERSION`, captured once at raid start for
  deterministic reproduction (`extraction-match.md` §"reproducible from `(runSeed,
  sectorVersion, lootTableVersion)`"). There is no separate sector-only version counter.
- **`sectorSet`** is the ordered list of sector `id`s (§3.1) present in the `MAP_MANIFEST`
  the raid was deployed against — i.e. `MAP_MANIFEST.sectors.map(s => s.id)` at raid start.
  It is run bookkeeping (`extraction-match.md`'s `startedAt`/`endedAt`/`sectorSet` fields),
  recorded once and not mutated during the run, since §7 defers dynamic sector re-tiling.

## 4. Per-sector AI budget allocation and scaling rule

### 4.1 Sector activation states

Every sector is in exactly one state, transitioned by the server only:

**"Relevant player" is formally §5.1's relevant-sector-set holder, not a new concept.** A
player counts as relevant to a sector — for the purposes of `dormant`/`warming`/`active`
below — exactly when that sector is a member of some connected client's relevant sector set
(§5.1), computed identically to network relevance, including §5.1's own dead/spectating
rules:

- A **spectating client** counts as a relevant player for the sector its spectated
  entity/player currently occupies (or, if unassigned, the sector it last held while alive)
  — the same mapping §5.1 already defines for network relevance. This is a deliberate
  consequence of "mirror §5.1 by design": a client that would be shown a sector's contents
  is also a client whose presence can keep that sector warm/active. A wiped squad that stays
  spectating a living teammate therefore keeps holding that teammate's sector active exactly
  as long as the living teammate does — the squad itself contributes nothing extra.
- **A dead player's own corpse is not a relevant player.** Death disconnects the *dead*
  entity from relevance; what keeps a sector warm afterward is only the surviving client's
  spectator assignment (above), which decays the moment that assignment's own sector does.
  A fully wiped squad (no surviving spectatable entity, or spectating nothing) has **no**
  relevant player in that sector at all — the sector is not held active; it drops through
  the normal `SECTOR_COOLDOWN_S` grace period below like any other last-exit, never
  indefinitely.

**Caveat — this rests on a post-death client state Extraction has not yet defined.** The
three bullets above describe what this contract *needs* a spectating client to mean
(a connection that is still present and mapped to one sector, via a `spectatingId`-shaped
assignment, after its own entity dies) but neither sibling contract currently defines that
state for Extraction:

- `extraction-match.md` §1 marks `dead` **terminal** — health reaching 0 immediately produces
  a `RunResult` submission (`outcome: "died"`) to `settlement.md`. That contract's state
  machine has no row describing what the participant's *connection* does after `dead`: whether
  it stays attached to the raid server in some observer capacity, or whether termination of the
  participant phase implies the client is expected to leave the run server entirely (e.g. drop
  to a lobby/results screen) with nothing left for sector interest to compute against.
- `net-facade.md`'s `isSpectating`/`spectatingId`/`spectatorPolicy` model (its `matchState`
  shape and `spectatorPolicyVersion` phase table) is written entirely against Bomb/TDM: two
  fixed teams (`alpha`/`bravo`), round phases, and a policy keyed to round state. It says
  nothing about a squad-based mode with no rounds and no `alpha`/`bravo` teams, and is not
  stated to extend to Extraction.
- This contract therefore cannot itself say whether the "spectating client" it leans on in the
  bullets above exists as a real, connected post-death state in Extraction, what sector such a
  client's `spectatingId` would resolve through, or how `spectatorPolicyVersion` (if it even
  applies outside Bomb/TDM) gates it. **Until one of `extraction-match.md` or `net-facade.md`
  is amended to define post-death connection/spectate state for Extraction, this section's
  spectating-client bullets are the sector-interest team's own working assumption of what that
  state will look like, not a behaviour any other contract currently guarantees.** An
  implementation building §4.1 today must treat "no surviving spectatable entity, or
  spectating nothing" (above) as the safe default for *any* dead participant whose connection
  fate is not otherwise pinned down, until that amendment lands.

| State | Meaning |
|---|---|
| `dormant` | No relevant player within the sector or its warm ring (§4.2). AI entities exist as data (position, health, loadout) but do not `think()`, do not path, do not fire, and do not move. |
| `warming` | A relevant player has entered the neighbour ring but not the sector itself. AI in this sector is activated at a reduced budget (§4.3) so it is not a statue the instant a player steps across the line. |
| `active` | A relevant player is inside the sector or its transition zone. Full budget (§4.3) applies. |

A sector drops from `active`/`warming` back toward `dormant` after `SECTOR_COOLDOWN_S`
(default 8 s, tunable, mirrors the shape of `RESPAWN_DELAY` in `botManager.js` — a fixed
grace period rather than an instant cutoff) with no relevant player, not immediately on
last-exit. This prevents state thrashing for a player pacing a boundary.

### 4.2 The warm ring

`warming` exists because `dormant` AI is fully inert (§4.1) and a raid full of statues that
snap awake exactly on a sector line reads as a bug, not a budget. The warm ring is a
sector's declared neighbour set (§3) — no separate distance parameter, no second geometry
to author. A sector warms when a relevant player is `active` in any neighbour, and only
that sector's *directly adjacent* neighbours warm — warming does not cascade past one hop.

### 4.3 Budget scaling rule

The server holds one global AI think/path budget, sized the same way `botManager.js`
already documents (§ its header comment: ~1.5 ms at 120 Hz for the arena roster). Extraction
raids scale that budget **by sector activation state**, not by raising the global number,
because the point of sectoring is that total simulated population no longer has to fit in
one flat roster's budget:

- `dormant` sector: **0** think ticks, **0** path searches. Entities are frozen data.
- `warming` sector: think stride is **doubled** relative to that sector's configured base
  (e.g. base stride 8 → 16 fixed steps between thinks) and path search share is **halved**.
  Bots in a warming sector sense and can start reacting, but slower and coarser — enough to
  not feel dead the moment a player crosses in, not enough to fight at full strength before
  the player has actually arrived.
- `active` sector: full budget, per-bot stride/phase-offset exactly as `botManager.js`
  already implements (§ its header comment) — this contract does not change in-sector AI
  behaviour, only which sectors run it.

The path-search round-robin (`PATH_BUDGET` per `PATH_INTERVAL` ticks) is **shared across all
active+warming sectors**, served round-robin the same way it already is served round-robin
across bots — a sector with more relevant AI does not starve a smaller one, exactly as one
bot cannot starve another today.

**Population cap, not just a think cap:** each sector additionally declares a max concurrent
AI population, `populationCap` (§3.1, Codex-authored, server-enforced) so an `active` sector
cannot spike the global budget by having more entities placed in it than the tick budget
assumes. This is the sector-scoped analogue of `MAX_BOTS` in `botManager.js`.

**Overflow behavior:** a spawn or sector-to-sector transfer that would put a sector's live AI
count over its `populationCap` is **refused outright** — the spawn/transfer does not happen,
full stop. There is no queueing and no eviction of existing occupants to make room:

- **Refused, not queued.** The requesting subsystem (raid director spawn logic, or a bot
  crossing into a neighbouring sector) must treat this the same way `botManager.js`'s
  `clamp(..., 0, MAX_BOTS)` already treats an over-request — the excess simply does not
  spawn — rather than holding a pending spawn to retry later. A deferred/retried spawn would
  reintroduce exactly the timing nondeterminism `match-result.md`'s "deterministic run
  results" convention exists to prevent.
- **No eviction.** An existing occupant of a full sector is never force-moved, force-killed,
  or force-transferred out to admit a new arrival. `populationCap` bounds *arrivals*, not
  standing residents.
- This applies uniformly regardless of the sector's activation state (§4.1) — a `dormant`
  sector still enforces its cap against entities placed in it at map load / loot-tier
  resolution, even though none of them are thinking yet.

### 4.4 What is explicitly not sector-scaled

`fixedUpdate()` (steering + `world.move`) for an entity that exists still runs every tick
regardless of sector state — `botManager.js`'s own header comment is explicit that this cost
is "the same per-entity cost the player pays" and is not part of the think/path budget. A
`dormant`-sector bot therefore still needs a defined position; §4.1's "frozen data" means no
steering input is generated for it (it does not move), not that its transform update is
special-cased. This keeps one authoritative movement/collision code path rather than a
sector-conditional one.

## 5. Network relevance culling by sector

### 5.1 Relevance set

Each connected client has a **relevant sector set**: the sector its own entity currently
occupies, plus every sector directly adjacent to it (§3 neighbour set), plus any sector it
is inside the transition zone of. This mirrors §4.2's warm ring by design — a client is
network-relevant to exactly the sectors its presence would also warm AI in, so "what a
player can be shown" and "what a player's presence activates" stay the same boundary rather
than drifting into two different notions of nearby.

A dead or spectating client's relevant set is the sector of the entity/player they are
currently spectating (or their last-alive sector if unassigned), never the whole map — dying
does not grant map-wide vision.

### 5.2 What `_broadcastSnapshot` sends

Applied as a filter stage *before* the existing per-recipient event filtering
(`EVENT_RANGE_SQ`, `_bombPositionAuthorised`) described in §2, using the same
per-session loop shape already in `server.js`:

- **Entities:** only entities whose current sector (§3) is in the recipient's relevant set
  are included in that recipient's `wire` entity list. An entity leaving a client's relevant
  set is *removed* from that client's next snapshot the same tick it leaves — `encodeSnapshot`
  already deltas against a baseline, so this is expressed the same way a death or disconnect
  already is, not a new wire concept.
- **Loot/container state:** container contents, world-loot pickups, and their remaining
  quantity/despawn timers are included only for sectors in the relevant set. A client is
  never sent the contents of a container in a sector it has no relevance to.
- **Events:** the existing `EV_SPATIAL` distance cull (§2) is additionally gated on sector
  relevance — an event whose origin sector is outside the recipient's relevant set is
  dropped before distance is even checked, the same "drop, don't zero" posture
  `_bombPositionAuthorised` already established for the bomb (§2, and worked example in
  `server.js`'s own commentary on why a filtered fact is dropped rather than sent as a
  false zero value).
- **AI in `dormant`/`warming` sectors:** per §4.1, a `dormant` sector's AI is frozen and
  therefore cheap to omit or include; it is still filtered out under this section like any
  other off-relevance entity, so a client gets no early information (position, presence,
  count) about AI in a sector it has not reached.

### 5.3 What a client never receives

- The exact position, health, or loadout of any entity — player or AI — in a sector outside
  its relevant set.
- Container/loot contents for a sector outside its relevant set (existence of the sector
  itself, from static map data loaded at connect time, is not gated — only its live
  contents are).
- Combat feedback events (`shot`, `explosion`, `kill`, hitmarkers) whose origin sector is
  outside its relevant set, even if the raw distance would otherwise pass `EVENT_RANGE_SQ`.
  Sector relevance is checked first specifically to prevent the case a flat distance cull
  cannot: two sectors that are geometrically close (across a wall, floor, or chasm) but not
  neighbours, where distance alone would leak intel through geometry that blocks play.

## 6. Server-side check: refusing an off-sector claim

This is the enforcement half of P3-05's definition of done — "no off-sector combat or loot
can be client-forced" — and follows the same shape as the existing objective-refusal path
(`server.js`, the `interactRefused`/`_wireReason` machinery already described in §2): the
server decides, a refusal is recorded as evidence, and a refusal is a private fact sent only
to the actor who attempted it, never broadcast.

**Rule:** any command that claims an interaction happened at a position or against an entity
— pickup, container open, item drop, plant/defuse-equivalent extraction actions, and any
damage/kill attribution — is validated against the **server's own sector membership record**
for the acting entity (§3, computed server-side on every move, never trusted from the
command payload), not against any sector or position the client asserts.

Validation order, mirroring `_bombPositionAuthorised`'s existing two-question shape
("is this recipient authorised for it?" / "otherwise, hidden/refused"):

1. **Where is the actor, really?** The server's last-computed sector for the acting entity
   (§3), derived from server-simulated position, is authoritative. A command's own claimed
   position is used only as the target of physical validation (range, line of sight,
   cooldown) — never as evidence of which sector the actor is in.
2. **Is the target (loot, container, combat victim) in a sector the actor is currently
   `active` or transition-zone-relevant to (§5.1)?** If the target entity/container's
   server-recorded sector is outside the actor's own relevant set, the action is refused
   before any further physics check runs. This is the actual "no off-sector combat or loot"
   gate: it is impossible to land a hit or complete a pickup against something the server
   itself would not currently be showing that client, because §5 already would not have
   sent it to them.
3. **Refuse, don't silently drop.** A refusal is recorded through the same evidence path
   (§2's `_record`) with a reason distinct from existing refusal reasons — `off-sector` is
   added to the wire refusal-reason table (`REFUSAL_REASONS`, `src/net/protocol.js`) as an
   **additive** amendment, following the amendment rules in `README.md` — and sent only to
   the refused actor, exactly as `interactRefused` already is. It is never broadcast, since
   broadcasting it would itself leak "something exists over there" to the rest of the
   server, the same information §5.3 exists to withhold.

   **This is a wire-protocol change, not just a `README.md`-additive one — `PROTOCOL_VERSION`
   bumps.** `REFUSAL_REASONS` is one of the exported names `scripts/lanecheck.mjs`'s `LAYOUT`
   regex watches (alongside `MSG_*`, `*BYTES*`, `ENTITY_FIELDS`, `EV_KINDS`, `EV_VEC3`,
   `EV_SPATIAL`, `CANCEL_REASONS`, `OUTCOME_REASONS`, `BOMB_STATES`, `PHASES`) precisely
   because appending to it changes what a `reasonIndex` byte on the wire decodes to for
   clients that don't yet know about the new entry. `wire-protocol.md` §"amendment rules" is
   explicit that *any* change to that file's shape bumps `PROTOCOL_VERSION`, and its own G3
   precedent (`bomb-rules.md`'s appended entity fields and event kinds landing as
   `PROTOCOL_VERSION` → 2) is the same append-only-array-growth case as this one. So: this
   contract's `README.md`-additive posture (minor version bump, `CHANGELOG.md` line, no CCR)
   governs *this contract's own* version, but the `REFUSAL_REASONS` change itself must
   additionally follow `wire-protocol.md`'s process — a `PROTOCOL_VERSION` bump, landed in
   `wire-protocol.md` itself and enforced by `scripts/lanecheck.mjs` — before P3-05's
   implementation ships it. This is not optional groundwork left to the implementer to
   discover: `off-sector` does not reach the wire until that bump lands.

   **Ordering constraint:** `REFUSAL_REASONS` is a positional array —
   `reasonIndex`/`EV_REFUSED`'s wire decode in `src/net/protocol.js` encodes a reason as its
   array index, not its string. `off-sector` **must be appended after the last existing
   entry** (currently `['not-eligible', 'wrong-phase', 'outside-volume', 'not-carrier',
   'already-planted']`, so `off-sector` lands at index 5), never inserted by category or
   alphabetically. Inserting anywhere but the end silently renumbers every existing refusal
   reason already encoded on the wire and in stored evidence — an additive amendment to this
   array is additive only if it is append-only.
4. **A dormant-sector target cannot be hit at all.** Because §4.1 gives `dormant`-sector AI
   no `think()`/damage-processing path and §5.2 never sends dormant-sector entities to any
   client, a claimed hit against one fails at ordinary entity-lookup (the server has no live
   combat state to apply it to) before this section's sector check is even reached. This
   check exists for the case ordinary lookup would not catch: an `active`-sector target the
   *attacker* has no relevance to, e.g. a claimed hit across a sector boundary the attacker
   has not crossed, or against an entity another player made relevant to *them* but not to
   this attacker.

**What this does not do:** it does not re-validate physical plausibility (range, LOS,
timing) — those checks already exist per-action-type and are unchanged. This section adds
exactly one new gate, sector relevance, ahead of them.

## 7. Non-goals / explicitly deferred

- **Dynamic sector re-tiling** (sectors that split/merge at runtime, e.g. a collapsing
  floor) is out of scope for P3; sectors are static per map load.
- **Per-sector tick rate** (simulating a whole sector, not just its AI, at a reduced
  frequency) is not part of this contract — §4.4 keeps entity movement/collision on one
  code path at the normal tick rate. Only AI *thinking* scales.
- **Client-authoritative sector prediction** (the client guessing which sector it will enter
  next to pre-warm its own rendering) is a Codex/P3-07 client concern and has no bearing on
  server relevance — the server's relevant set (§5.1) is computed from server state only and
  is never advanced early on a client's say-so.

## 8. Open questions (non-blocking)

None of the below block building against §3–§7; they are P3-06/P4-01 tuning inputs.

- `SECTOR_COOLDOWN_S` default (8 s) is a starting value pending measurement against real
  sector sizes from P3-06, the same way `bomb-rules.md`'s 40 s timer was derived from
  measured map rotation rather than picked first.
- Whether sector population caps (§4.3) are authored per-sector or derived from footprint
  area is left to P3-06/P3-11 data authoring; this contract only requires that a cap exists
  and is enforced.
