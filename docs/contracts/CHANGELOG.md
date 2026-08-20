# Contract changelog

Every contract amendment lands here. Newest at the top.

## Amendment types

| Type | When | Requires |
|---|---|---|
| **Additive** | New optional field, new endpoint, new event type, new error code | Minor version bump + a line here. No coordination stop |
| **CCR** (Contract Change Request) | Removed/renamed field, changed type, changed semantics, renamed objective or callout id | Human approval, major bump, dual-support window of ≥1 phase |
| **Wire** | Any change to `src/net/protocol.js` byte layout | `PROTOCOL_VERSION` bump, enforced by `scripts/lanecheck.mjs` |

## CCR format

```
### CCR-001 — <title>
- Contract: contracts/http-api.md
- Type: breaking
- Raised by: [CC] | [CX]
- Date: YYYY-MM-DD
- Change: <what changes, precisely>
- Why: <why the additive path does not work>
- Impact: <who breaks, what they must do>
- Dual-support window: <phases both shapes are accepted>
- Migration: <how existing data/clients move>
- Approved by: <human owner> on <date>
- Status: PROPOSED | APPROVED | REJECTED | LANDED
```

**An amendment that skips this file did not happen.** The other lane discovers it as a
production bug, which is exactly the failure mode the two-lane model exists to prevent.

---

## 2026-08-20 — Seventh review, `REQ-CC-039`…`041` (additive)

Three findings, all resolved; contracts to **1.7.0**. `REQ-CC-033`…`038` accepted.

- **039 — the consent boundary measured itself.** Personal `flow.step` still included the
  `consent` step, so a declining player would have had to authorise an event recording that
  they declined. Personal telemetry now begins at **signup**; the consent screen is an unlinked
  internal count that records *that* a decision happened, never which. Decline rate is
  consequently unmeasurable, and that cost is written down rather than quietly absorbed.
  §3.5.1 makes "unlinked" enforceable: fresh correlation id per event, never the originating
  request's, no session id on the event or its batch, no join key stored.
- **040 — the union was values without shapes.** Exact `TerminalResult` refinements with a
  status-dependent invariant table, and a history union whose pending item carries null for
  every outcome field rather than omitting them.
- **041 — stubs were fixtures, not a contract.** Build Plan §0.5 makes stubs this phase's exit
  condition, so single responses were never enough: a multi-request transition cannot be
  expressed by one fixture. Scenarios are now stateful and keyed per client session, with a
  route-to-scenario coverage map so coverage is auditable rather than inferred from names.

**P0 contract work closes here.** Every backend request 001–041 is answered. Implementation
starts against these contracts; remaining review findings are the kind a compiler and a test
suite surface in minutes.

## 2026-08-20 — Sixth cross-reference review, `REQ-CC-033`…`038` (additive)

Six resolved; contracts to **1.6.0**. The settings/capability chain passed this round — the
first chain to close completely.

### The one that mattered most

**`REQ-CC-038` — an off-by-one at the decoder's untrusted-input boundary.** Event wire codes
are zero-based indices into `EV_KINDS`, so the first invalid code is exactly `EV_KINDS.length`.
The guard said `>`, which let precisely that value through into `EV_KINDS[code]` and yielded
`undefined`. Now `>=`, with both boundary vectors required in decoder tests.

Every other bounds check in this contract is deliberate — `MAX_COMMANDS_PER_BATCH` before
allocation, finiteness on every wire float. A single `>` where `>=` belonged, at the one place
that parses hostile bytes, is exactly the defect that survives review by looking reasonable.

### Two more that were real

- **The Bomb presence bit contradicted itself.** It was set for attackers in *every* state,
  while the coordinates were only meaningful for `dropped`/`planted` — so a `carried` bomb sent
  `visible = 1` with zeroes, and the mapping exposed a real position at the world origin. The
  bit now means "meaningful **and** authorised", state checked first. A carried bomb's location
  is the carrier's.
- **`matchState.matchId` was prose, not a field.** The source table claimed the handoff
  populated it; the schema had no such key. A source table cannot add a field a shape lacks.

### The rest were stale projections, again

Room list, health bodies, pagination, and the superseded onboarding blocks all still carried
the shapes their replacements had already superseded. Same failure mode as rounds four and
five: the amendment lands, the old projection stays.

**What changed in my process this round:** I ran a cross-file consistency sweep *before*
submitting rather than after, and it caught two of my own residuals — the facade's missing
carried→null rule and the KPI table's missing `funnel.preconsent` row. That is the first time
the sweep found my own defects instead of the review finding them.

## 2026-08-20 — Fifth cross-reference review, `REQ-CC-027`…`032` (additive)

Six residual groups, all resolved. Affected contracts go to **1.5.0**. `REQ-CX-005` landed in
the same round, so the settings vocabulary is now consumed rather than pending.

| Request | Residual |
|---|---|
| `REQ-CC-027` | Room list declared a bare array against three of this contract's own conventions |
| `REQ-CC-028` | Consent ordering, signed-out persistence, and signup migration still disagreed |
| `REQ-CC-029` | Reload reconnect had no way to discover `matchId` |
| `REQ-CC-030` | Hidden Bomb position used `(0,0,0)`, a valid world coordinate |
| `REQ-CC-031` | The outcome matrix was not applied by the schemas naming it |
| `REQ-CC-032` | Vocabulary published but not consumed; `build` missing from the shared enum |

### Three that were genuine defects rather than untidiness

1. **`(0,0,0)` cannot mean "hidden".** It is a valid world position and the canonical site
   example uses an origin centre, so a decoder could not distinguish a concealed bomb from one
   at the origin. `bombState` could not disambiguate either — every recipient still learns
   `dropped`/`planted`; only the coordinates are filtered. Added an explicit
   `bombPositionVisible` byte; `MSG_MATCHSTATE` is 41 bytes.
2. **Reload reconnect had no entry point.** The reconnect endpoint restores everything *once
   the client knows `matchId`*, and a reload is exactly when it does not. Added
   `GET /v1/matches/active`, derived server-side from the held entity — asking is one request,
   and making the client persist the id would have made reconnect depend on storage surviving
   a crash or a new tab.
3. **The handoff and the phase table both claimed to own spectator policy.** An immutable
   descriptor and a phase-derived value cannot both be the source. The handoff now carries
   `spectatorPolicyVersion` only.

### One ordering decision with a legal edge

Consent now sits **after** the age gate: `landing → eligibility → consent → signup → verify →
terms`. `auth.md` §11 records that under-13 visitors generally cannot consent alone, so asking
before gating would solicit consent from precisely the people who cannot give it.

The cost is stated rather than hidden. Landing and eligibility emit **unlinked internal-class
counts only**, so top-of-funnel volume is measurable and per-visitor paths through those two
steps are not — and `time_to_first_match_sec` is measured from the consent step, not the first
byte. Both contracts say so, so they cannot drift on what the KPI means.

This ordering rides on the D6 working default and belongs in the same legal review.

## 2026-08-20 — Fourth-pass graph audit, `REQ-CC-021`…`026` (additive)

Codex re-walked the six chains amended by `REQ-CC-015`…`020` and found residual breaks in all
six. Affected contracts go to **1.4.0**.

**These were the loose ends of my own fixes.** Each amendment closed the middle of a chain and
left an end dangling: components defined but old duplicates left in place, a receipt required
by one endpoint and returned by none, a descriptor produced by the lobby with no facade
parameter to receive it.

| Request | Residual break |
|---|---|
| `REQ-CC-021` | Room components defined, but the list example, mutation returns, and `room.updated` still described the removed `RoomState` |
| `REQ-CC-022` | Signup required an `eligibilityReceipt` that eligibility never returned; consent promised a receipt nothing carried |
| `REQ-CC-023` | `match.ready` carried the descriptor; `net.connect` had no parameter for it, and `matchState` had no `matchId` to build the reconnect URL |
| `REQ-CC-024` | Refusal event carried a reason but not the kind, so it could not produce `{ kind, reason }` |
| `REQ-CC-025` | Wire allowed a forfeit winner; the result required every aborted match to have none |
| `REQ-CC-026` | Two enums bound to a CX vocabulary that does not yet exist |

### Three worth naming

1. **A forfeit is an aborted match with a winner.** The wire allowed it, `match-result.md`
   forbade it, so the team that won because the other side walked would have been recorded as
   winning nothing. §4.0 is now one outcome matrix — completed, draw, forfeit, abandon,
   no-contest, invalidated — applied identically by wire, facade, result, HTTP, database,
   career aggregation, and event type.
2. **The neutral age gate published the number it was testing against.** Returning
   `minimumAge: 13` on success tells a rejected visitor exactly what to enter next. Eligibility
   now returns an opaque signed receipt and a policy version, and nothing else.
3. **Consent moved before signup.** Capturing it after meant the first four funnel steps were
   permanently unmeasurable while §3.1 promised to measure them, *and* signup returned a
   profile whose consent object had to be non-null before any consent call existed. Asking at
   landing fixes both.

### Two enums I am deliberately not writing

Settings category IDs and binding action IDs belong to `design/settings-inventory.md`, which
has display labels and no stable IDs. I guessed both once and neither guess matched. Guessing
again would reproduce exactly the drift `REQ-CC-016` was raised about, so they are marked
pending and filed as `REQ-CX-005`.

**Lesson recorded:** an amendment is not done when the change is written — it is done when
both ends of every chain it touches have been re-read. Four rounds, same failure mode, each
narrower than the last.

## 2026-08-20 — Cross-reference audit, `REQ-CC-015`…`020` (additive)

Codex audited **producer→consumer chains across files** rather than each file alone. Every
finding was real. Affected contracts go to **1.3.0**.

| Request | Finding |
|---|---|
| `REQ-CC-015` | "One `RoomState` used field-for-field by both" was circular — the envelopes genuinely differ |
| `REQ-CC-016` | The settings allowlist claimed to mirror the CX inventory and contradicted it in six ways |
| `REQ-CC-017` | Eligibility, verification, terms and consent were referenced by four contracts and implemented by none |
| `REQ-CC-018` | `net.reconnecting` was a state with no exit; static facade fields had no producer |
| `REQ-CC-019` | The outcome→result→persistence projection was lossy in six places |
| `REQ-CC-020` | The KPI table and the event registry named different events |

### The pattern in all six

**Each contract was internally consistent and wrong at its seams.** Two rounds of per-file
review passed these because per-file review cannot catch them: the defect is never inside a
file, it is in the space between two.

- Draw and no-winner were the same wire value, so every invalidated match would have read as
  a tie in results and career stats.
- The match session ticket is single-use and nothing minted another, so a dropped player could
  never rejoin their own live match — the facade documented a `reconnecting` state that had no
  exit.
- `interactionRefused` was sourced from cancellation events, which cannot represent a
  precondition that was never met (not-carrier, already-planted).
- Dropped-bomb position was an event, so a resyncing client would never learn where the bomb
  was.
- The career surface returned `draws` with no column behind it.

### Two places the other lane's spec was better than mine

- **Settings.** My §11.9 table was a divergent copy, so it is deleted rather than corrected;
  `design/settings-inventory.md` is now the single source of truth. Codex's scoping was simply
  right — volume belongs to the device, not the profile.
- **The birthdate.** Resolving the onboarding chain produced a better answer than either
  contract had: the eligibility preflight evaluates a date of birth and **discards it**, so the
  most sensitive field in the funnel is never stored at all.

**Lesson recorded:** contract review must trace chains across files. Per-file sufficiency is
necessary and not sufficient, and three review rounds have now demonstrated it.

## 2026-08-20 — Second Codex review, `REQ-CC-010`…`014` (additive)

Codex re-reviewed the 1.1.0 amendments and found five further gaps. All resolved; affected
contracts go to **1.2.0**. Additive throughout — no shipped shape changed meaning.

| Request | Contract | Amendment |
|---|---|---|
| `REQ-CC-010` | `http-api.md` §11.8–11.10, `auth.md` §3 | Remaining endpoint schemas, settings allowlist, 17 stub scenarios; socket-token contradiction fixed |
| `REQ-CC-011` | `realtime-lobby.md` §3–5, §6 | One canonical `RoomState`/`RosterMember`; typed deltas; real countdown abort policy |
| `REQ-CC-012` | `wire-protocol.md` §8.9–8.10, `net-facade.md` §5–6 | `MSG_OUTCOME`; wire source per facade field; clock domains and u32 wrap |
| `REQ-CC-013` | `bomb-rules.md`, `map-data.md`, `net-facade.md`, `P0-decisions.md` | One series rule; stale wire prose and timing numbers corrected |
| `REQ-CC-014` | `telemetry.md` §3.3.1 | Published event registry with classes, bounds, closed enums |

### What the second pass caught that the first did not

Three were **contradictions I introduced while fixing the first round** — the cost of amending
in place rather than re-reading the whole document afterwards:

1. **The series was impossible.** "First to 7, max 13" and "MR12, no overtime, 6-6 draw" sat in
   adjacent rows describing different formats. Max 13 permits a 7–6 thirteenth round; MR12 ends
   at 12. Settled as `maxRounds: 12`, `roundsToWin: 7` (early win), draw at 6-6.
2. **Stale numbers survived the amendment.** `map-data.md` §7.0 got the new 88 m envelope while
   §7.1 kept the old 8–12 / 11–15 / 14–20 thresholds, and `P0-decisions.md` D4 still showed the
   20/27/13 arithmetic the envelope change had invalidated. Two tables in one file disagreeing
   is worse than one wrong table, because each looks authoritative.
3. **`bomb-rules.md` §11 still described the flag-bit encoding** that §8.5 of the wire contract
   had already replaced with `interact`.

The other two were originals: the facade promised `matchId`, winner, and reason on
`matchEnded` with **no wire source anywhere** — a field the client could not have obtained —
and `auth.md` claimed the access token is sent on lobby-socket connect, when sockets take
single-use tickets precisely so a bearer token never lands in a URL.

**Lesson recorded:** amending a contract in place needs a full re-read of the file, not just
the edited section. Both review rounds found the same failure mode.

## 2026-08-19 — Codex review amendments, `REQ-CC-001`…`009` (additive)

Codex's P0 sufficiency review returned **10 of 13 contracts insufficient** and identified five
cross-contract contradictions. All nine requests are resolved; every contract touched goes to
**1.1.0**. All amendments are additive — no shipped shape changed meaning, so no CCR is required.

| Request | Contract | Amendment |
|---|---|---|
| `REQ-CC-001` | `http-api.md` §11 | Exact schemas for refresh, settings, room/roster, join, stats/history, regions |
| `REQ-CC-002` | `errors.md` §3 | 15 codes added incl. the undefined `AUTH_SESSION_REPLACED` |
| `REQ-CC-003` | `realtime-lobby.md` §3, §8 | Complete welcome payload; `POST /rooms/:id/reconnect-ticket` |
| `REQ-CC-004` | `wire-protocol.md` §8 | Protocol v2 byte layout |
| `REQ-CC-005` | `net-facade.md` §5 | Versioned `matchState`, typed events, `netStats` units, reconnect |
| `REQ-CC-006` | `match-result.md` §4.1–4.2 | Exact player/round schemas; pending-result surface |
| `REQ-CC-007` | `map-data.md` §3.6 | **Budgets corrected** to fit the binding architecture ceiling |
| `REQ-CC-008` | `telemetry.md` §3.3–3.4 | Client endpoint, batch schema, consent gating |
| `REQ-CC-009` | `feature-flags.md` §3.1–3.2 | Client-visible flag response and registry |

### The five contradictions, and how each was settled

1. **Refresh transport** — `auth.md` said httpOnly cookie, `http-api.md` said body. **Cookie
   wins**; the body reference was an error. A refresh credential the page can put in a request
   body is a credential XSS can steal, which defeats the entire two-token design.
2. **Lobby reconnect** — the ticket is consumed on open, yet §8 told the client to reuse it or
   fetch one from an endpoint returning none. The flow was **impossible as written**; a new
   endpoint issues a fresh single-use ticket to a member whose seat is still held.
3. **Map budgets** — 900 draw calls / 1.4M triangles against `ARCHITECTURE.md` §11's binding
   `< 220` / `< 450k`. **The contract was simply wrong**: those numbers were written without
   opening the binding document, and authoring to them would have produced a map 4× over on
   draw calls, caught only when `geomtest` ran. Replaced with a map-only allocation inside a
   documented whole-scene split.
4. **`AUTH_SESSION_REPLACED`** — referenced in `auth.md` but absent from a "closed" enumeration.
   Now defined, with the rule that it must never trigger an auto-reconnect.
5. **Flag bits** — `F_PLANTING` and `F_DEFUSING` both needed a bit, one remained. Resolved by
   **not using a flag**: `interact` is an appended `u8` entity field carrying kind (2 bits) and
   progress (6 bits), which also gives progress a home it never had.

### Map envelope amended — D3

`80 m ±10%` → **`88 m ±5%`**, rotation `14–20 s` → **`16–22 s`**, sightline `45 m` → **`48 m`**.
Codex's art direction called for 88–104 m against the original 72–88 m band; **88 m is the only
value both specifications already permitted**. See `P0-decisions.md` §D3.1.

Knock-on: the bomb timer's minimum rises from 27 s to 29 s, so 40 s now carries 11 s of margin
rather than 13 s. The timer **holds at 40 s**, but `REQ-CX-002`'s measurement becomes
load-bearing rather than confirmatory.

## 2026-08-19 — P0.3 decisions resolved (additive)

The six P0.3 decisions were delegated to the Claude Code lane and are recorded in
[`../decisions/P0-decisions.md`](../decisions/P0-decisions.md). No contract shape changed —
these fill in values that were marked `PENDING DECISION`, so the amendment is additive and
needs no CCR.

| Contract | Section | Resolution |
|---|---|---|
| `auth.md` | §2 | Managed identity — **Supabase Auth** |
| `auth.md` | §11 | Age baseline **13**, prizes **18+** — a *working default*, still needs legal review before P8/P11 |
| `db-schema.md` | §0 | **Supabase Postgres, `ca-central-1`** (Toronto); match servers stay on Fly, `yyz`/`ord`/`iad` |
| `bomb-rules.md` | §2 | MR12, no defuse kit, **40 s bomb timer**, no overtime in Alpha |
| `map-data.md` | §7.0 | **80 m × 80 m** playspace, 14–20 s rotation, 45 m sightline ceiling |
| `telemetry.md` | §3.1.1 | Desktop-only matrix, WebGL2 required |

Two of these are coupled and were decided together: the Bomb timer is **derived** from the map
rotation envelope (20 s rotation + 7 s defuse = 27 s minimum, 40 s chosen). If measured
rotation on real geometry exceeds 20 s, the timer moves rather than the map.

Remaining G0A blocker: `REQ-CX-001`, the Codex sufficiency sign-off. Contracts stay in
`REVIEW` until it lands — freezing on the other lane's behalf would defeat the review.

## 2026-08-19 — Initial authoring (P0)

All 13 contracts created at version 1.0.0, status `REVIEW`. No amendments yet.

`PROTOCOL_VERSION = 1` introduced in `src/net/protocol.js`. It did not previously exist; the
wire format was unversioned and the client inferred server capability from message
`byteLength`. Recorded as gap G1 in `wire-protocol.md` §7; negotiation is a P2 deliverable.

Three contracts carry sections blocked on a P0.3 human decision and cannot reach `FROZEN`
until those land:

| Contract | Blocked section | Decision |
|---|---|---|
| `auth.md` | §2 provider, §11 age policy | P0.3 #1, #6 |
| `bomb-rules.md` | §2 parameters | P0.3 #4 |
| `db-schema.md` | Host and region topology | P0.3 #2 |

Everything not marked `PENDING DECISION` in those files is buildable now.
