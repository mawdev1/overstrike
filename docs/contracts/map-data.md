# Contract 9 — Map data

| | |
|---|---|
| **Status** | `FROZEN` — amendments follow CHANGELOG.md |
| **Version** | 1.3.0 |
| **Owner** | [CC] Claude Code (contract) |
| **Producer** | [CX] Codex — `src/world/level.js`, `src/world/props.js` |
| **Consumers** | `world.js`, `navGrid.js`, `spawner.js`, `match.js`, Bomb ruleset, minimap, evidence |

---

## 1. The problem this solves

`src/world/level.js` is **Codex-owned** because it is fundamentally art authoring. The server
depends on it for collision, navigation, spawns, and — from P3 — objective volumes. That is a
cross-lane dependency on the critical path, and Build Plan §1.4 resolves it not by moving the
file but by putting a contract, an artifact, and a guard around it.

**This is a lesson already paid for in this repository.** Prior map work shipped unreachable
upper floors, nav nodes floating underground (46% phantoms at one point), a warehouse roof
that could not be reached on foot, 25 open parapet corners, and a ground check that asserted
nothing. The guards in §6 are not ceremony. They are the reason geometry can be delegated to
a separate lane at all.

## 2. Current producer surface

`buildLevel(game, world)` builds the level by calling `world.addBox(min, max, surface)` /
`addBoxRaw(...)`, `world.setBounds(min, max)`, and `placeSpawns(world)`, which pushes into
`world.spawnPoints` as `{ position: Vector3, yaw: number, team: number }`.

`world.build()` then compiles the boxes into a flat spatial hash;
`world._faceSpawnsIntoTheOpen()` re-aims any spawn whose forward view is blocked within 3.5 m,
because hand-authored yaws drift as geometry moves and spawning nose-first into a wall is the
worst possible first second of a life.

**What exists:** collision boxes, bounds, spawn markers, surface tags.
**What does not exist and this contract requires:** objective volumes, named callout regions,
explicit walkability tagging, map versioning, and performance budget metadata.

## 3. Required exports

`level.js` must export, in addition to `buildLevel`:

```js
export const MAP_ID = 'the-square';
export const MAP_VERSION = '1.0.0';   // bumped on ANY change affecting §3.2–§3.5 or §3.7
export const MAP_MANIFEST = { bounds, spawns, objectives, callouts, navHints, budgets,
  sectors /* §3.7 — required for raid maps, optional otherwise */ };
```

`MAP_VERSION` appears in every match result (`match-result.md` §4). A balance argument about
matches played on different geometry is unresolvable without it.

### 3.1 Collision

Axis-aligned boxes via the existing `addBox` path. Binding rules:

- **Renderer-only meshes never participate in collision.** Decorative geometry that is not
  added as a box does not block, and geometry added as a box always blocks. No third state.
- Every box carries a `surface` tag (drives footsteps, impact FX, and penetration).
- Glass is tagged transparent: it blocks movement but not line of sight.
- No box may be authored with `min > max` on any axis; the guard rejects it rather than
  letting the spatial hash silently drop it.

### 3.2 Spawns

```js
{ id: 'alpha-yard-3', position: Vector3, yaw: number,
  team: 0 | 1 | -1,           // -1 = any
  group: 'alpha-main' | 'bravo-main' | 'contested-north' | …,
  protectionRadius: 4.0,
  modes: ['tdm', 'bomb'] }
```

| Rule | Value |
|---|---|
| Minimum per team, TDM | 8, spread across ≥3 groups |
| Minimum per team, Bomb | 1 protected group of ≥5 adjacent points |
| Every spawn | Standing clearance for the player capsule (r 0.36, h 1.8), on walkable ground |
| Every spawn | Reachable from every objective volume by the nav graph |
| `id` | Stable forever once shipped. Evidence and analytics reference it |

`group` is what the TDM dynamic spawn scorer selects between; individual points are chosen
within a group. Without groups the scorer either flips players across the map or repeatedly
picks the same point.

### 3.3 Objective volumes — **required for Bomb (P3)**

```js
{ id: 'site-A',                  // NEVER changes once shipped
  kind: 'plant' | 'defuse' | 'zone',
  site: 'A' | 'B',
  box: { min: Vector3, max: Vector3 },
  requiresGround: true }
```

- Plant volumes must contain standing-clear space and be visible from ≥2 approach routes.
- Plant and defuse volumes for a site may differ; if defuse is omitted it defaults to the
  plant volume.
- `id` is referenced by the ruleset, the HUD, evidence, and analytics. Renaming one silently
  rewrites history — it is a breaking change requiring a CCR.

### 3.4 Callout regions — **one vocabulary, used everywhere**

```js
{ id: 'plaza-fountain', name: 'Fountain',
  box: { min, max }, priority: 0 }
```

The **same** names are used by the minimap, the HUD, canned callouts, match evidence, and map
analytics. Two vocabularies means a player says "fountain", the evidence says "region 14", and
the analytics says "plaza-3" — and nobody can talk about the map.

Regions may overlap; `priority` resolves. Every point inside `bounds` that a player can stand
on must resolve to exactly one region. The guard checks coverage — an unnamed area is a place
players cannot talk about.

### 3.5 Nav hints

Consumed by `navGrid.bake()`:

```js
{ walkable: [box…],        // force-walkable (thin ledges the raster misses)
  blocked:  [box…],        // force-unwalkable (decorative ledges, sills)
  links:    [{ from: Vector3, to: Vector3, kind: 'stair'|'mantle'|'drop' }],
  cover:    [{ position: Vector3, facing: number }] }
```

`blocked` matters more than it looks: without it the baker happily marks window sills and
parapet caps walkable, bots path onto them, and the map analytics count them as playspace.
That is exactly the phantom-node failure this repository has already shipped once.

### 3.6 Budgets

**Amended by REQ-CC-007.** The previous example (`drawCalls: 900, triangles: 1_400_000`) was
wrong — it contradicted `ARCHITECTURE.md` §11, which is binding and sets the whole-scene
ceiling at **fewer than 220 draw calls and 450,000 triangles**. Those numbers were invented
without checking the binding document. Authoring to them would have produced a map roughly 4×
and 3× over budget, discovered only when `geomtest` ran.

`budgets` declares a **map-only allocation**, not a scene ceiling. The level is one contributor
to a frame that also draws characters, viewmodels, FX, and UI, so the map is allocated a share
and the rest is reserved:

```js
budgets: {
  profileId: 'ref-integrated-1080p',
  drawCalls: 140,      // of the binding < 220 whole-scene ceiling
  triangles: 300_000,  // of the binding < 450k whole-scene ceiling
  materials: 48,
  lights: 6,
  colliders: 1200,     // collision only — no render cost, bounded by query performance
}
```

| Consumer | Draw calls | Triangles |
|---|---:|---:|
| **Map (this allocation)** | **140** | **300k** |
| Characters, up to 12 | 40 | 90k |
| Viewmodel | 12 | 40k |
| FX, decals, tracers | 20 | 15k |
| Headroom | 8 | 5k |
| **Whole scene** | **< 220** ✓ | **< 450k** ✓ |

**Counting conditions** — a budget without them is unfalsifiable:

| Condition | Value |
|---|---|
| `profileId` | `ref-integrated-1080p` — integrated GPU, 1920×1080, render scale 1.0 |
| Measured | After a 3 s warm-up, over a 10 s window, across the `beauty.mjs` viewpoints |
| Statistic | p95 of per-frame counts, not the mean — the mean hides the worst view |
| Shadow pass | **Counted.** The single directional cascade's draw calls count against the map allocation |
| Depth/prepass | Counted if present |
| Culled geometry | Not counted — the budget is what is submitted, not what exists |

**Two separate assertions, and both must pass.** `geomtest.mjs` checks the map allocation
above *and* independently asserts the `ARCHITECTURE.md` §11 whole-scene ceiling with a full
match running. A map that fits its allocation while the scene still breaches 220 draw calls is
a failure — the binding number is the scene, and the allocation is only how we get there.

Colliders carry no render cost; their bound exists because `world.build()`'s spatial hash and
every `move`/`raycast`/`losClear` query scale with box count.

### 3.7 Sectors — **required for raid maps** (1.3.0, per `sector-interest.md` §3.1)

Added in 1.3.0 as the additive amendment `sector-interest.md` §3.1 specifies verbatim (P3-06's
deliverable). `MAP_MANIFEST` gains one top-level key, `sectors` — an array of:

```js
{ id: 'square',                        // stable forever, never an index
  box: { min: Vector3, max: Vector3 }, // authoring shape identical to objectives/callouts
  neighbours: ['north-yard', 'east-docks'],  // sector IDs sharing a traversable boundary
  populationCap: 12,                   // max concurrent AI entities (sector-interest.md §4.3)
  baseThinkStride: 8 }                 // this sector's `active`-state think stride baseline
```

Binding rules, matching the shipped reader (`src/world/world.js`'s `buildManifest`):

- **Optional for pre-P3-06 maps; required for raid (extraction) maps.** An absent `sectors`
  key on a map authored before this amendment is **schedule, not a gap**: the reader records
  `provenance.sectors = 'declared'` only when the key is present and deliberately records
  nothing when it is absent, so `manifestGaps()` does not turn red on the competitive maps
  that predate raids. Absent ≠ partial manifest. A raid map without sectors, by contrast, is
  a non-conforming raid map — `sectortest.mjs` is its guard.
- Each entry must carry `id` and a well-formed `box`; a malformed entry is dropped by the
  same volume reader objectives and callouts use, not repaired.
- Reader defaults when a per-sector key is absent: `neighbours` → `[]`,
  `populationCap` → unbounded (`Infinity`), `baseThinkStride` → `8`. Authored raid maps
  should declare all three; the defaults exist so a partially-authored sector fails loudly in
  `sectortest` rather than crashing the reader.
- Sector boxes must tile the playable bounds with **no gaps and no overlap**, and
  `neighbours` must be symmetric (`sector-interest.md` §3).
- **`MAP_VERSION` bumps on any `sectors` change** — the §3 comment now includes §3.7 in its
  "bumped on ANY change" list. This is what makes `sector-interest.md` §3.2's `sectorVersion`
  rule hold: a run's `sectorVersion` IS the deployed map's `MAP_VERSION`; there is no separate
  sector-only version counter. `sectorSet` is `MAP_MANIFEST.sectors.map(s => s.id)` at raid
  start.

Producer and reader both shipped ahead of this text (`src/world/level.js` exports
`EXTRACTION_SECTORS` on the 'square-extraction' manifest in exactly this shape;
`src/world/world.js` parses it); this section is the contract landing that reconciles the
frozen text with them — additive, minor bump, no CCR, per this contract's own amendment rules.

## 4. The artifact — nav bake

Geometry changes require re-baking navigation. The bake tool is **[CC]-owned**; its **output
is committed by [CX]** in the same PR as the geometry change.

```bash
node scripts/navbake.mjs --map=the-square --out=src/world/navdata/the-square.json
```

Codex runs a Claude-Code-owned tool and commits its output. **No cross-lane file write ever
occurs** — which is the whole point of the arrangement.

A PR touching `level.js` or `props.js` without a corresponding bake artifact change is
flagged by `scripts/lanecheck.mjs` and fails the map guards.

## 5. The competitive boundary must be removable

The Square is dual-use: bounded for TDM/Bomb now, embedded in the extraction world in P6.

**The boundary is a separate, tagged, removable layer — not baked into the district geometry.**

```js
export const COMPETITIVE_BOUNDARY = [ /* boxes tagged 'boundary' */ ];
```

Building the boundary into walls means re-authoring the entire district for P6. Tagging it
means deleting a layer. This costs nothing now and saves a phase later.

## 6. Guards — must pass on every geometry PR

| Harness | Proves |
|---|---|
| `scripts/maptest.mjs` | Manifest conforms; every objective/callout/spawn id resolves; no malformed boxes |
| `scripts/collisiontest.mjs` | No player-passable wall; nothing to fall through or get stuck in |
| `scripts/stairtest.mjs` | Every stair, ramp, and mantle traversable on foot |
| `scripts/vertprobe.mjs` | Every intended upper floor and rooftop reachable; no unreachable playspace |
| `scripts/navtest.mjs` | No phantom nodes; no unreachable walkable regions; bake matches geometry |
| `scripts/mapbalance.mjs` | Route timings, sightlines, site symmetry inside the P0.3 envelope |
| `scripts/geomtest.mjs` | §3.6 budgets met |

**Every guard must be demonstrated to fail against a deliberately broken map.** A guard that
cannot fail is a guard that is not guarding — this repository has shipped one, and the whole
delegation model rests on these not being decorative.

## 7. Balance signals from `mapbalance.mjs`

Numbers, with thresholds, not impressions. These are Codex's design feedback loop.

### 7.0 The Square dimensional envelope — **DECIDED** (D3)

Grounded in the code: MERIDIAN is 86 m × 86 m (`EDGE = 43`); the player walks 4.6 m/s and
sprints 7.2 m/s. Reasoning in [`../decisions/P0-decisions.md`](../decisions/P0-decisions.md) §D3.

| Parameter | Target | Tolerance |
|---|---|---|
| Bounded playspace | **88 m × 88 m** (`EDGE = 44`) | ±5% |
| Spawn → first contact | **9–14 s** | Both teams within 15% |
| Spawn → nearest site | **12–16 s** | Both teams within 15% |
| A↔B rotation, defender side | **16–22 s** | Both teams within 15% |
| Longest sightline | **≤ 48 m** | Hard ceiling |
| Vertical playspace | 3 usable levels, rooftops bounded | — |

**88 m settles a genuine disagreement.** The first pass set 80 m ±10% (`EDGE` 36–44 = 72–88 m);
Codex's art direction called for 88–104 m. The two bands touch at exactly one value, and that
value is binding here — see `P0-decisions.md` §D3.1 for the full reasoning. Neither spec had to
be relaxed to reach it.

Comparable to MERIDIAN's 86 m, which keeps the existing performance and collision baselines a
meaningful comparison rather than a different class of map.

The 48 m sightline ceiling is hard: at 88 m playspace a 48 m lane already spans more than half
the map, and anything longer is an angle that decides rounds by itself.

**This feeds the bomb timer.** 22 s worst-case rotation + 7 s defuse = 29 s minimum, so the
40 s timer retains 11 s of fighting margin (`bomb-rules.md` §2.1). That margin is thinner than
it was at 80 m, which makes REQ-CX-002's measurement matter more, not less.

**The rotation figure feeds the Bomb timer** (`bomb-rules.md` §2.1). If measured rotation
exceeds **22 s**, the timer moves rather than the geometry — see `REQ-CX-002`.

### 7.1 Thresholds

| Signal | Threshold |
|---|---|
| Spawn-to-first-contact, per group | 9–14 s (§7.0) |
| Spawn-to-site, both sites | 12–16 s, within 15% of each other |
| Rotation time A↔B, both teams | 16–22 s, within 15% |
| Immediate repeat-death rate (TDM) | < 5% of deaths within 10 s of the spawn point |
| Spawn-flip-into-enemy rate | < 2% of spawns with an enemy inside 15 m and line of sight |
| Sightline length distribution | Long/medium/close all represented; no single uncontested angle covering both sites |
| Site win rate (bot matches, ≥200) | 45–55% attack/defend per site |
| Route usage distribution | No mandatory doorway carrying >40% of traffic |

## 8. Changing a shipped map

| Change | Requires |
|---|---|
| Cosmetic only, no collision | `MAP_VERSION` patch bump |
| Collision, spawns, nav | Minor bump, fresh bake, all guards |
| Objective volume moved/renamed | **Major bump + CCR.** Rewrites the meaning of history |
| Callout renamed | Major bump + CCR. Evidence and analytics reference it |

## 9. Retiring MERIDIAN

MERIDIAN leaves rotation when The Square passes every guard, and is **retained as a test
fixture**. The existing harnesses have years of comparison data against it; deleting it throws
away every performance and collision baseline in the repository.
