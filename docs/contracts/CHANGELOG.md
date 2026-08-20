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
