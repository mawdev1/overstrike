# P0.3 decisions

| | |
|---|---|
| **Status** | `DECIDED` — working defaults, delegated |
| **Date** | 2026-08-19 |
| **Decided by** | Claude Code, under explicit delegation from the human owner ("go with what you think is best") |
| **Unblocks** | `auth.md` §2 §11, `bomb-rules.md` §2, `db-schema.md`, `map-data.md` §7, `telemetry.md` §3 |

---

## How to read this

The Build Plan assigns these six to the human owner. They were delegated, so they are decided
here with the reasoning written down — which matters more than usual, because a delegated
decision has to be reversible by someone who was not in the room.

Each carries a **reversal cost**: how expensive it is to change later. Cheap ones are decided
firmly. Expensive ones are decided conservatively, in the direction that keeps options open.

**D6 (age and eligibility) is a working default, not a legal position.** It exists to unblock
schema and profile design. The binding policy needs professional review before P8 (XO
commerce) and P11 (prizes), and the jurisdictions actually served determine the rest. Nothing
downstream should treat it as settled law.

---

## D1 — Authentication provider: **managed, Supabase Auth**

**Reversal cost: moderate.** Contained behind `auth.md`'s provider-independent token model.

Self-hosted credentials means owning password hashing, reset flows, lockout, breach
monitoring, and the incident when one of them is wrong. That is a solved problem with
expensive failure modes and no product differentiation, and P1 has better uses for its first
week.

Among managed options:

| Option | Why not |
|---|---|
| Auth0 | Pricing punishes free-to-play MAU curves badly |
| Clerk | Excellent, but strongly UI-opinionated — it fights a game that generates its own art |
| Cognito | Cheap, painful DX, weak session-management primitives |
| **Supabase Auth** | **Chosen** |

Reasons, in order of weight:

1. **Postgres-native.** D2 puts the platform on Postgres regardless; Supabase keeps identity
   rows adjacent to game rows, so the `accounts` ↔ `sessions` ↔ `player_stats` joins in
   `db-schema.md` stay in one database instead of spanning a vendor boundary.
2. **A real escape hatch.** Supabase is self-hostable. If the managed tier stops fitting, the
   exit is an infrastructure migration, not an identity rewrite. That is worth more than any
   feature on the comparison grid, because vendor lock-in on *identity* is the worst kind.
3. **MAU pricing survives free-to-play.** The roadmap's model is free entry with a large
   population of light users. Per-MAU pricing that assumes SaaS seats does not survive it.
4. Its JWT + rotating-refresh model maps cleanly onto the two-token contract in `auth.md` §3
   without fighting the design.
5. Tiebreaker: a Supabase connector is already configured in this environment, suggesting an
   existing account and familiarity.

**Binding regardless of provider:** `auth.md` §3–§10 stand as written. The access token stays
out of `localStorage`, refresh rotates with reuse detection, revocation is immediate, and the
match-server handoff uses our own single-use tickets — **not** provider tokens. A provider
outage must not be able to hand out match access.

**Reversal trigger:** if Supabase Auth cannot express immediate session revocation (§5) or
per-session device listing, revisit before P1 ends — those are gate requirements, not
preferences.

---

## D2 — Database: **Supabase Postgres, primary `ca-central-1` (Toronto)**

**Reversal cost: high for the region, moderate for the host.**

Coherent with D1: one vendor for identity and durable state, one connection story, no
cross-vendor join.

**Region choice is the load-bearing part.** Toronto, because:

1. The roadmap's entire compliance frame is Ontario — AGCO, FINTRAC, OPC, CRA. Keeping player
   personal data resident in Canada removes a cross-border transfer question from the P5
   privacy review and the P8 legal package before it is asked.
2. The initial player population is nearest Toronto.
3. Cross-border data transfer is far more expensive to fix after launch than to choose now.

**Match servers are a separate decision and stay on Fly** (`fly.toml`, `fly.gameserver.toml`
already exist), regional and independent of the database. This is deliberate: match servers
are latency-bound and must sit near players, while the database is consistency-bound and must
sit in one place. Coupling them would force one of the two into the wrong location.

Initial match regions: **`yyz` (Toronto), `ord` (Chicago), `iad` (Virginia)** — expanding by
*measured* demand, per Build Plan §P5.B, not by guessing at a map.

**Binding:** the platform never puts a database round trip inside the tick (Build Plan §2.2).
A 40 ms Toronto round trip from an `iad` match server is irrelevant to gameplay precisely
because gameplay never waits on it.

---

## D3 — The Square: dimensional envelope

**Reversal cost: very high.** Geometry authored to the wrong envelope is re-authored, not
adjusted. This is the decision most worth getting approximately right now.

Grounded in the code rather than taste — MERIDIAN is **86 m × 86 m** (`EDGE = 43`), and the
player walks **4.6 m/s**, sprints **7.2 m/s**.

**Amended after Codex review — see §D3.1.** Final values:

| Parameter | Target | Tolerance |
|---|---|---|
| Bounded playspace | **88 m × 88 m** (`EDGE = 44`) | ±5% |
| Spawn → first contact | **9–14 s** | Both teams within 15% |
| Spawn → nearest site | **12–16 s** | Both teams within 15% |
| A↔B rotation, defender side | **16–22 s** | Both teams within 15% |
| Longest sightline | **≤ 48 m** | Hard ceiling |
| Vertical playspace | 3 usable levels; rooftops bounded | — |

**Why slightly smaller than MERIDIAN.** MERIDIAN is a general-purpose FPS map. The Square is a
competitive map for two modes, and compactness is what makes route knowledge valuable and
rotations tense. 80 m is comparable to the classics this map is meant to sit beside.

**Why 45 m caps sightlines.** At 80 m playspace, a 45 m lane already spans more than half the
map. Anything longer becomes an angle that decides rounds on its own, which §7 of
`map-data.md` explicitly tests against.

### D3.1 — Resolving the Codex disagreement

My first pass set **80 m** with a 14–20 s rotation. Codex independently recommended
**88–104 m** with an 18–28 s rotation, from the art direction in `square-artdirection.md`.
A real disagreement on the highest-reversal-cost decision in the program, so it needed
resolving on evidence rather than seniority.

**88 m is the only value both specifications already permit.** My 80 m carried a ±10%
tolerance, i.e. `EDGE` 36–44, or 72–88 m. Codex's range starts at 88 m. The bands touch at
exactly one point, and that point is the answer — not a split difference, but the single
figure neither spec has to be relaxed to accept.

Weighing the substance rather than just the arithmetic:

- **Codex has the stronger claim on the lower bound.** It has actually laid out the district —
  plaza, two sites with distinct identities, dense interiors, separated lanes. If that
  programme does not fit in 80 m, the compression lands on interiors, and interior density is
  precisely what makes the map worth learning.
- **I have the stronger claim on the upper bound.** At 104 m with a 28 s rotation, the bomb
  timer must rise to ~45–50 s (28 + 7 = 35 s minimum), rounds slow down, and a compact
  competitive map quietly becomes a mid-size one. The whole argument for tightness weakens.
- 88 m also sits just under MERIDIAN's 86 m… marginally over it, in fact, which means the
  existing performance and collision baselines remain a meaningful comparison rather than a
  different class of map.

**Consequence for the bomb timer:** worst-case rotation rises from 20 s to 22 s, so the
minimum viable timer becomes 22 + 7 = **29 s**. At 40 s that leaves **11 s** of fighting
margin instead of 13 s. Still comfortably viable, so **the timer stays at 40 s** — but the
margin is now thinner, and REQ-CX-002's measurement matters more than it did.

Had Codex's full 104 m been adopted, 40 s would not have survived contact with the map. That
is the argument being had at the right time: on paper, before geometry exists.

**These numbers validate the D4 bomb timer** — see below. That link is the reason both
decisions had to be made together.

---

## D4 — Bomb parameters

**Reversal cost: low.** Configuration, not geometry. Decided firmly and tuned from playtests.

| Parameter | Value | Reasoning |
|---|---|---|
| Rounds to win | **7** (first to 7, max 13) | MR12. Long enough to reward adaptation, short enough for a browser session |
| Side switch | **After round 6** | Both sides attack and defend equally |
| Round length | **1:45** pre-plant | |
| Freeze time | **8 s** | Positioning, not buying — there is no buy economy |
| Plant duration | **3.0 s** | |
| Defuse duration | **7.0 s** | |
| **Defuse kit** | **None in Alpha** | No buy economy exists. A kit without an economy is an arbitrary spawn privilege, and adding one later is additive |
| **Bomb timer** | **40 s** | See below |
| Round-end delay | **5 s** | |
| **Overtime** | **None — 6-6 is a draw** | See below |
| Reconnect grace | **90 s** | |
| Abandon threshold | 2 consecutive rounds absent | |

**The bomb timer is the parameter that had to be derived, not chosen.** It must exceed a full
rotation plus a defuse, or defenders can never retake and the mode collapses into a plant
race:

```
worst-case rotation (D3)     20 s
defuse                        7 s
                             ────
minimum viable timer         27 s
chosen                       40 s   →  13 s of margin to win the site fight
```

13 s is enough to contest a site and not enough to walk in unopposed. If D3's rotation
measures longer than 20 s on real geometry, **the timer moves, not the map** — that is the
cheaper correction, and REQ-CX-002 is the request that will produce the measurement.

**No overtime in Alpha, and a 6-6 draw.** Overtime needs a rule set of its own — round count,
side switching, sudden death, and in most games an economy reset that does not exist here.
The roadmap's instruction is to prove two modes work, not to ship a complete competitive
ruleset. A draw is unsatisfying; an under-specified overtime is a bug factory. Overtime is
additive and can land any time after G1.

---

## D5 — Supported browser and device matrix

**Reversal cost: low to widen, moderate to narrow.** Decided narrow, because narrowing after
launch takes support away from players who had it.

**Desktop only. No mobile, no tablet.** The control scheme is mouse-and-keyboard and the
roadmap's first-session KPIs assume it.

| Tier | Support |
|---|---|
| **Supported** | Chrome / Edge (Chromium) — latest 2 major; Firefox — latest 2 major; Safari 17+ |
| **OS** | Windows 10+, macOS 13+, Linux (Chromium/Firefox) |
| **Required** | WebGL2, pointer lock, WebSocket binary frames, ~2 GB VRAM, 8 GB RAM, dual core |
| **Unsupported** | Everything else — including mobile browsers and WebGL1-only devices |

**An unsupported client must fail early, clearly, and before rendering a broken scene**
(`errors.md` `UNSUPPORTED_CLIENT`, `telemetry.md` §3.1). A game that half-loads and then
stutters is a worse experience than one that says plainly it will not run here.

Safari 17 is included but is the tier most likely to produce WebGL and audio-timing defects.
It gets explicit regression coverage in P5's browser matrix; if it cannot hold frame time on
the reference hardware, dropping it is a P5 decision made from measurements, not now from
apprehension.

---

## D6 — Age and eligibility baseline — **WORKING DEFAULT, NEEDS LEGAL REVIEW**

**Reversal cost: high.** Age policy shapes data collection, consent records, and prize
eligibility, and it is the one item here with genuine legal exposure.

| Rule | Default |
|---|---|
| Minimum account age | **13** |
| Under-13 | Not eligible. No account, no data collected beyond what refusal requires |
| Cash-equivalent XO prizes | **18+**, as a separate stricter flag |
| Collection method | **Neutral age gate** — a date of birth entered without the target age shown. Never a "yes I am over 13" checkbox, which teaches the answer |
| Storage | An explicit eligibility record, not an inference re-derived from a birthdate left in a form |
| Re-verification | Required before any cash-equivalent prize payout, independent of the account flag |

Reasoning: the OPC's position is that children under 13 generally cannot give valid consent
on their own. Setting the floor at 13 avoids building a parental-consent apparatus for a
population the game is not designed for, and the roadmap already keeps cash-equivalent prizes
behind a stricter gate.

**What still needs a professional review, before P8 and P11:**

- Whether 13 is right for every jurisdiction actually served, and what changes if not.
- Whether age assurance beyond self-declaration is required for the prize path.
- How this interacts with KYC on the payout rail.
- Retention and deletion obligations specific to minors' data.

Until that review lands, **build to this default and do not deepen the dependency on it.**
Specifically: no feature outside P8/P11 should read the eligibility flag, so that changing it
stays a schema-and-policy change rather than a product change.

---

## Consequences

| Contract | Change |
|---|---|
| `auth.md` | §2 resolved to D1; §11 resolved to D6 with the review caveat retained |
| `db-schema.md` | Host and region resolved to D2 |
| `bomb-rules.md` | §2 resolved to D4; timer derivation recorded |
| `map-data.md` | §7 thresholds resolved to D3 |
| `telemetry.md` | §3 browser matrix resolved to D5 |

Remaining G0A blocker: **REQ-CX-001**, the Codex contract sufficiency sign-off. Not decided
here — that gate belongs to the other lane, and freezing contracts on its behalf would defeat
the review it exists to provide.
