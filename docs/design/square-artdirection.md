# The Square art direction

**Owner:** Codex (`[CX]`)  
**Phase:** P0  
**Version:** 0.2
**Status:** Dimensions envelope accepted; ready for art-direction approval
**Last updated:** 2026-08-19

## Creative thesis

The Square is a contemporary civic-commercial district built around a public plaza and a vertical signal landmark. It should read in one silent frame: pale mineral streets, oxidized copper infrastructure, deep shaded arcades, a bright central beacon, and two contrasting civic functions on opposite sides of the plaza.

The mood is “public place adapted under pressure,” not a generic military base. Security barriers, temporary communications equipment, shutters, repair scaffolds, and evacuation markings sit on top of ordinary shops, municipal rooms, apartments, transit access, and service alleys. Combat geometry must still look like architecture with a reason to exist.

The design is original. Existing competitive maps may inform abstract principles—legible lanes, looped routes, landmarks, bounded sightlines—but not layout, naming, proportions, or decoration.

## Relationship to current MERIDIAN

The current map is an 86 x 86 m Mediterranean compound with three lanes, 18 spawn points, a central market hall, old-town and harbour identities, and measured sightline work. It is a useful technical fixture, not The Square. Do not rename it or reuse its callout identity.

Reusable lessons:

- Runtime procedural geometry/material construction and instancing.
- A central landmark that supports orientation from multiple lanes.
- Lane-specific material families without creating extra draw calls.
- Multiple cross-connections and rooms with more than one entrance.
- Guard-driven work on collision, vertical reachability, sightlines, and spawns.

The Square receives its own map ID, version, callouts, objective volumes, boundary layer, performance metadata, and nav-bake artifact under `contracts/map-data.md`.

## Competitive dimensions envelope

The P0.3 D3 envelope is accepted as the binding geometry target. Contract guards must use
these same values before final geometry begins:

| Measure | Alpha target | How it is verified |
|---|---:|---|
| Competitive footprint | 88 m × 88 m (`EDGE = 44`), ±5% | Exported bounds |
| Spawn to first credible contact | 9–14 s; teams within 15% | `mapbalance.mjs` route samples |
| Spawn to nearest bomb site | 12–16 s; teams within 15% | Route timing samples |
| A↔B defender rotation | 16–22 s; teams within 15% | Route timing samples excluding exploits |
| Longest deliberate sightline | ≤48 m, hard ceiling | Eye-height ray probe |
| Accessible combat levels | 3 usable levels; rooftops bounded | Vertical reachability report |

The envelope comes from `docs/decisions/P0-decisions.md` §D3. The art programme—plaza,
two distinct sites, dense interiors, and route identity—must fit it without weakening the
guard values. `REQ-CX-002` supplies measured A↔B timing once the graybox exists.

## District plan

The map is organized around four memorable spaces rather than three visually interchangeable lanes:

1. **The Square** — open central plaza with broken cover, a dry fountain/planter edge, shaded colonnade, and the Signal Spire.
2. **Civic Wing** — stone records hall and service court; controlled interiors, high windows, strong defensive corners. Recommended Bomb Site A identity.
3. **Market Row** — narrow shopfronts, fabric canopies, back rooms, and a delivery alley; dense short-range rotations.
4. **Transit Works** — glass/steel station entrance, maintenance trench, loading access, and utility mezzanine. Recommended Bomb Site B identity.

Each route must have a plain-language purpose:

- Fast exposed plaza route.
- Medium arcade/interior route with frequent lateral exits.
- Slower covered service route that trades time for concealment.
- Limited upper connector that offers information and angle variety, not permanent dominance.

No route should require recognizing a texture alone. Silhouette, sky exposure, floor material, signage form, and landmark relationship combine to orient the player.

## Landmark: Signal Spire

The Signal Spire is a narrow civic clock/communications mast rising from the plaza edge, not its exact center. It provides:

- A unique skyline silhouette visible from all primary ground routes.
- A lit vertical band that indicates plaza orientation without displaying match state.
- A clock face or segmented civic display readable as shape, not relied upon for timing.
- A protected base that functions as cover without becoming a head-glitch ring.

The spire is not playable high ground and contains no collision detail that encourages climbing. It does not carry permanent sponsor art; a separate named event-sponsor anchor may be reserved nearby.

## Palette and materials

All values are starting targets for procedural materials and must be evaluated in the actual tone-mapped scene.

| Role | Color family | Starting value | Material notes |
|---|---|---:|---|
| Sunlit masonry | warm limestone | `#C8B99E` | Matte, low-frequency aggregate variation |
| Shade masonry | smoke taupe | `#746E68` | Preserve silhouette; never crush to black |
| Paving | pale graphite | `#777B79` | Directional joints support navigation |
| Civic accent | oxidized copper | `#3F8C83` | Spire, civic trim, sparse wayfinding |
| Market accent | saffron cloth | `#D69A36` | Canopies and hanging markers, not team state |
| Transit accent | enamel cobalt | `#356C92` | Frames, tiles, route signage |
| Security layer | oxide red | `#A6483F` | Barriers/warnings; distinct shape from enemy UI |
| Vegetation | dusty olive | `#647052` | Sparse planters; no sightline-obscuring foliage |
| Night/shadow fill | slate blue | `#39434D` | Ambient fill, readable against uniforms |
| Neutral UI signage | bone white | `#E6E0D3` | High-value labels with dark backing |

Large surfaces use restrained value variation, edge wear, joint rhythm, and structural breaks. High-frequency noise is avoided at player silhouette height. Glass is limited, consistently framed, and never communicates passability through transparency alone.

## Time of day and lighting

**Direction:** late afternoon after rain, with the sun low enough to give façades shape but high enough to avoid severe glare and black interiors.

- Warm key light from the west; cool, soft sky fill.
- Dampness appears as controlled darker patches and muted reflections, not full mirror streets.
- Interior portals receive authored fill so players at a threshold can read silhouettes both ways.
- No volumetric fog in competitive lanes unless guard measurements prove no loss of target readability.
- The Signal Spire and transit lighting provide orientation, not flashing spectacle.
- Objective and team readability must survive shadows, post-processing off, low shadow quality, and color-vision deficiencies.

## Signage and callout language

Signage uses a fictional municipal system with short English callouts and consistent icon families. Decorative text may use a secondary invented local script only when it cannot be mistaken for an instruction.

| Family | Shape | Usage |
|---|---|---|
| Civic | circle seal + vertical rule | records hall, services, plaza maps |
| Market | hanging rectangular blade | shops and arcade entries |
| Transit | horizontal band + route number | station and service routes |
| Site A | solid triangle + `A` | objective path/site only |
| Site B | double-bar square + `B` | objective path/site only |
| Exit/service | outlined chevron | non-objective circulation |

Final callout names come from one map-data export and are consumed unchanged by HUD, minimap, compass, telemetry/evidence, accessibility labels, and player-facing documentation. Decorative signs must not introduce competing names.

## Team and objective readability

World art does not encode Alpha/Bravo ownership because sides switch in Bomb. Team presentation belongs to server-driven UI and character presentation.

- **Alpha:** upward chevron icon plus approved Alpha color.
- **Bravo:** split horizontal bar icon plus approved Bravo color.
- **Site A:** triangle geometry/pattern and spoken “Site A.”
- **Site B:** double-bar square geometry/pattern and spoken “Site B.”
- Friendly/enemy markers combine word/icon, outline treatment, and color.
- Site markers retain their shape in monochrome, low saturation, reduced effects, and when partially occluded.
- Red oxide architecture must not match the final enemy-danger UI value closely enough to cause false recognition.

## Bomb-site identities

### Site A — Civic Archive

- Formal stone interior/service court with a triangular floor medallion and tall file stacks or protected civic cases.
- Strong orthogonal cover, two main entrances, and one riskier information opening.
- Warm limestone/oxidized copper material family.
- Plant volume boundary is visually explainable but not a glowing arena painted into the floor.

### Site B — Transit Control

- Enamel tile, steel frames, machinery plinths, and a partial overhead route board.
- More broken cover and a longer retake sightline than A, balanced by multiple approach breaks.
- Cobalt/graphite family with the double-bar square motif.
- Any glass around the site uses consistent intact/broken/passable language.

Objective volumes, valid plant surfaces, defuse regions, and stable IDs are backend-authored contract data. Art conforms to those volumes; it never creates a second client-only interpretation.

## Geometry and gameplay-readability rules

- Competitive barriers are a named, removable layer. The extraction version embeds the same district after that layer is disabled.
- Every room has at least two intentional exits unless it is explicitly a dead-end risk/reward pocket.
- Cover exposes recognizable body portions and avoids one-pixel/head-only firing gaps.
- Stair, mantle, window, and doorway dimensions use the movement contract with tolerance, not minimum-edge values.
- Repeated props never alter contracted objective, spawn-protection, or navigation volumes unpredictably.
- Traversable versus blocked doors have distinct silhouettes and collision-consistent treatments.
- Player-reachable roofs are visually distinct from backdrop roofs.
- Commercial anchors do not alter sightlines, collision, cover, navigational contrast, or objective readability.

## Reserved commercial anchors

Create named empty transforms only; no live commercial system ships in P3.

- `sponsor.event.plaza-east`
- `sponsor.rooftop.transit`
- `sponsor.billboard.market-north`
- `storefront.market.01` through the approved finite storefront count
- `storefront.civic.01` through the approved finite storefront count

Each anchor declares maximum dimensions, view direction, safe material/emissive limits, fallback creative, and whether it is visible from a spawn or objective. Human commercial/design approval is required before the catalog is frozen.

## Procedural-art and performance budget

No external art/audio assets are introduced. Geometry, textures, signs, and material variation are generated at runtime and deterministic for a given map version.

Binding whole-scene ceiling from `ARCHITECTURE.md`:

- Fewer than 220 draw calls.
- Fewer than 450,000 triangles.
- Shared/cached materials; repeated props use instancing.
- One tightly fitted 2048² directional shadow map.

Recommended The Square art allocation:

| Category | Draw calls | Triangles |
|---|---:|---:|
| Structural/world | <= 80 | <= 220k |
| Repeated props/signs | <= 35 | <= 90k |
| Objective/competitive boundary layers | <= 15 | <= 35k |
| Dynamic characters/weapons/FX reserve | >= 70 remaining | >= 105k remaining |

These allocations are planning budgets; `geomtest.mjs` reports actual scene totals and the stricter measured limit wins.

## Review plates and acceptance evidence

Before art direction is approved, capture consistent views with UI off and on:

1. Each team spawn looking inward.
2. Plaza from all four approaches.
3. Site A and Site B from attacker and defender entries.
4. Each upper position and its counter-angle.
5. All major interiors looking toward sun and away from sun.
6. Low-quality shadows/post-processing off.
7. Three color-vision simulations plus grayscale.
8. 1280 x 720 and 1920 x 1080 gameplay views.

Final acceptance additionally requires every map/collision/stair/vertical/nav/balance/geometry guard, route timing within the approved P0.3 envelope, and a human playtest in both TDM and Bomb.

## Open approvals

- Human art owner: creative thesis, palette, Signal Spire, and late-afternoon lighting.
- Backend + human: Bomb site volumes/rules and side-switch behavior.
- Backend: frozen map-data structure, stable IDs, callout export, nav-bake artifact format, and performance metadata.
- Human commercial/design: finite reserved-anchor catalog; placeholders only until P11.
