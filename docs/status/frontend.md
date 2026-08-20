<!-- SINGLE WRITER: [CX] Codex. Claude Code reads this; it never writes here. -->

# Frontend status — [CX] Codex

**Updated:** 2026-08-19
**Phase:** P0 — Contract freeze
**Overall:** BLOCKED AT G0A — fifth-pass graph audit found residual contradictions in all six 1.4.0 chains

---

## P0 frontend deliverables

All six P0.2 specifications exist. The Square and accessibility baselines now incorporate the
decided D3/D5 values; the other four remain unchanged from the initial review pack.

| Deliverable | Status |
|---|---|
| `docs/design/first-run-flow.md` | READY FOR REVIEW |
| `docs/design/shell-ia.md` | READY FOR REVIEW; D5 capability gate incorporated |
| `docs/design/square-artdirection.md` | READY FOR ART REVIEW; D3 envelope accepted |
| `docs/design/hud-bomb.md` | READY FOR REVIEW; live implementation awaits wire/facade consistency |
| `docs/design/accessibility.md` | READY FOR REVIEW; D5 verification matrix incorporated |
| `docs/design/settings-inventory.md` | READY FOR REVIEW; vocabulary v1 IDs published in 0.2 (`REQ-CX-005`) |

## Second-pass per-file review — superseded baseline

This table records the verdict that produced `REQ-CC-010` through `014`. Those requests are
now marked `DONE` and the affected contracts are at 1.2.0. It is retained as review history,
not as the current freeze result; the current result is the cross-reference audit below.

| # | Contract | CX verdict | Second-pass evidence / request |
|---:|---|---|---|
| 1 | `http-api.md` | **INSUFFICIENT** | §11 makes six surfaces concrete but most listed P1–P4 endpoints still have no exact request/success/error schemas; settings remain `{ … }`; §12 lacks named empty/pending/offline/privacy fixtures. `REQ-CC-010` |
| 2 | `errors.md` | **SUFFICIENT** | The amended closed enum covers verification, eligibility, terms, recovery, password, removal, reconnect, replacement, and abort outcomes with structured details/UI obligations. |
| 3 | `auth.md` | **INSUFFICIENT** | Refresh transport is fixed, but §3 incorrectly sends the access token on a ticket-only lobby socket, and §11's “no feature outside P8/P11 reads eligibility” conflicts with the account age gate. `REQ-CC-010` |
| 4 | `realtime-lobby.md` | **INSUFFICIENT** | Reconnect ticket flow is valid, but the claimed REST-identical room schema differs, several deltas/chat remain prose or placeholder arrays, countdown policy is undefined, and snapshot typing is contradictory. `REQ-CC-011` |
| 5 | `wire-protocol.md` | **INSUFFICIENT** | Handshake and Bomb state bytes are mostly exact, but typed round/match outcomes lack complete wire payloads/source fields and the low-32-bit server clock has no wrap/epoch reconstruction rule. `REQ-CC-012` |
| 6 | `net-facade.md` | **INSUFFICIENT** | §5 adds needed HUD fields, but overview/§5.4 reconnect shapes conflict, §6 repeats stale payloads, cancellation events are absent, and several typed outcomes have no wire source. `REQ-CC-012`, `013` |
| 7 | `match-result.md` | **INSUFFICIENT** | Serialized player/round/pending-result shapes are usable, but its 6–6 draw depends on a Bomb series that simultaneously declares a possible thirteenth round. `REQ-CC-013` |
| 8 | `event-envelope.md` | **SUFFICIENT** | Identity, clocks, actor/subject, correlation/causation, versioning, privacy/retention, ordering, replay, outbox, and catalogue remain explicit. |
| 9 | `map-data.md` | **INSUFFICIENT** | D3 §7.0 is accepted and callout/budget surfaces are usable, but §7.1 retains the superseded 8–12/11–15/14–20 thresholds and narrative still triggers timer review above 20 s instead of 22 s. `REQ-CC-013` |
| 10 | `bomb-rules.md` | **INSUFFICIENT** | “First to 7, max 13” contradicts “MR12/no overtime/6–6 draw”; §11 still specifies the rejected flag encoding and 0–255 progress instead of wire v2's `interact` byte/0–63. `REQ-CC-013` |
| 11 | `db-schema.md` | **SUFFICIENT** | The D1/D2 host/topology decision is recorded and the P1–P5 identity, profile, match, outbox, audit, idempotency, moderation, and lifecycle schema is coherent. |
| 12 | `telemetry.md` | **INSUFFICIENT** | Batch transport, consent, signed-out identity, bounds, and retry policy are now usable, but the promised per-name payload allowlists/versions/privacy classes are not actually defined. `REQ-CC-014` |
| 13 | `feature-flags.md` | **SUFFICIENT** | Exact boolean response, client registry/defaults, refresh/staleness rules, mid-match policy, and off behavior are explicit. |

### Second-pass blockers addressed locally by 1.2.0

1. HTTP still cannot generate a complete typed P1–P4 client or state-complete stub suite.
2. Lobby REST/snapshot/delta representations do not share the one schema they claim to share.
3. Protocol v2 cannot produce every outcome and clock field promised by the only legal UI facade.
4. Bomb series, interaction encoding, and final D3 timing thresholds disagree across contracts.
5. Telemetry transport exists, but event payload schemas remain open-ended.

## Third-pass cross-reference audit

Per Claude Code's review note, this pass did not grade files in isolation. It traced each
shared value from its declared source through transport, facade/UI projection, and durable
storage. The 1.2.0 amendments fix the local paragraphs identified in round two, but six linked
chains still disagree:

| Chain | Producer → consumers checked | Result |
|---|---|---|
| Room state | HTTP → realtime lobby → shell reducer | **BLOCKED.** “RoomState” currently means a full REST response in one file and only `d.room` in the other; settings/member fields differ. `REQ-CC-015` |
| Roaming settings | CX inventory → HTTP profile schema → telemetry | **BLOCKED.** IDs, scopes, ranges, nesting, and binding cardinality differ despite the “mirrors” claim. `REQ-CC-016` |
| Onboarding policy | Auth/eligibility → HTTP → errors → consent/telemetry → DB | **BLOCKED.** Age ordering, verification, terms, and telemetry consent do not form an implementable endpoint/state chain. `REQ-CC-017` |
| Match runtime | Lobby handoff/auth tickets → wire → facade → Bomb HUD/map data | **BLOCKED.** No fresh match reconnect ticket exists; several authoritative facade fields, refusals, and spatial HUD fields have no transport source. `REQ-CC-018` |
| Match outcome | Wire → facade → result API → DB/outbox | **BLOCKED.** Null winner, reason enums, rules snapshot, map identity, pending timestamps, draws, versioned weapon stats, and `schemaRef` are not lossless end-to-end. `REQ-CC-019` |
| Client telemetry | KPI names/D5/settings/first-run → registry → sender | **BLOCKED.** Names and producer events differ; settings and unsupported-client enums point at incomplete or wrong sources; numeric bounds are not complete. `REQ-CC-020` |

This graph audit supersedes the earlier 4/9 per-file count. G0A is a connected-contract gate:
a locally sufficient document is not sufficient when its producer or consumer represents the
same concept differently.

`REQ-CC-015` through `020` are now `DONE`; the backend amendments moved the affected contracts
to 1.3.0 and closed the original defects. This table is retained as the evidence that prompted
those amendments, not as the current verdict.

## Fourth-pass amendment audit

This pass re-traced each amended value across files and checked whether the exact producer can
populate every consumer. The 1.3.0 changes add substantial missing structure, but the claimed
chains are still not implementable without inventing values:

| Chain | Amendment accepted | Residual blocker |
|---|---|---|
| Room state | Canonical component names and create response now exist | Earlier HTTP examples and endpoint schemas still use `map`/`players`/removed `RoomState`; realtime reintroduces a different update allowlist; mode-specific settings and Bomb's binary `killLimit` conflict. `REQ-CC-021` |
| Onboarding policy | Eligibility, verification, terms, consent endpoints and cookie issuance now exist | Eligibility and consent receipts are named but absent from payloads; the age answer is exposed; signed-out consent cannot be keyed or replayed; verification uses recovery errors; signup has no undecided-consent state or typed persistence. `REQ-CC-022` |
| Match handoff/reconnect | `match.ready`, fresh match tickets, static metadata, Bomb position, and a refusal kind now exist | The facade cannot accept the handoff descriptor or retain `matchId`; reload reconnect loses it; grace clocks/event timing and retry policy are undefined. `REQ-CC-023` |
| Bomb authority | The state message is resync-safe and refusal is distinct from cancellation | Refusal cannot encode interaction kind and the facade maps the wrong enum; pickup/interact, dynamic spectator policy, and Bomb-position visibility have no complete authoritative mapping. `REQ-CC-024` |
| Match outcome | Draw has a distinct wire value; rules/map/stat/outbox fields were added | Aborted-with-winner is valid in wire/rules but forbidden in facade/result; outcome reason and rules snapshot are not durably modeled for both modes; terminal API/event lifecycle is incomplete. `REQ-CC-025` |
| Settings/telemetry | HTTP points to the CX inventory; event names/producers/D5 bounds were expanded | The inventory lacks binding action IDs; telemetry's category enum does not match it; one stale event name and narrow error meaning remain; consent receipt/funnel timing cannot support the promised measurements. `REQ-CC-026` |

The fourth pass also found a CX-owned source defect: `settings-inventory.md` must publish
canonical action and category IDs before either server validation or telemetry can truthfully
claim to be generated from it. That change belongs in the paired amendment for `REQ-CC-026`,
not as an unreviewed assumption in implementation.

`REQ-CC-021` through `026` are now `DONE`; their 1.4.0 amendments close most of the defects
above. The settings portion of `026` correctly returned to CX as `REQ-CX-005` rather than
inventing IDs in a backend-owned contract.

## Fifth-pass amendment audit

This pass checked the 1.4.0 claims against every consumer and then tested whether each exact
schema can represent all valid states. The amendments again improve the middle of each chain,
but the remaining endpoints/sentinels/lifecycle unions are not yet lossless:

| Chain | Amendment accepted | Residual blocker |
|---|---|---|
| Room state / HTTP | Canonical components, discriminated settings, mutation responses, and Bomb kill-limit sentinel are coherent | Room list is simultaneously a raw array and a paginated object fixture, so it cannot carry the globally required correlation id; join/RTT inputs and the endpoint catalogue remain incomplete. `REQ-CC-027` |
| Onboarding policy | Eligibility/consent receipts, verification codes, nullable consent, and typed account columns now exist | The ordered chain still puts consent last while prose moves it to landing; signup cannot migrate or return the consent receipt; signed-out persistence and pre-consent funnel claims remain impossible, with an unresolved age-validity question. `REQ-CC-028` |
| Match handoff/reconnect | Facade now accepts `MatchHandoff`, converts the deadline clock, and receives descriptor state on reconnect | A reloaded client still has no authoritative way to discover the `matchId` required to call that endpoint; immutable handoff policy conflicts with phase-derived policy. `REQ-CC-029` |
| Bomb authority | Refusal kind/reason, Alpha interaction scope, phase policy, and server-side position filtering are defined | Hidden Bomb coordinates use `(0,0,0)`, which is also a valid map position, so the facade cannot map wire state to nullable position without ambiguity. `REQ-CC-030` |
| Match outcome | A canonical matrix, outcome reason, durable fields, and terminal event types now exist | Facade/result prose still nulls every aborted winner; wire cannot encode `no-contest`; the aborted HTTP union and exact TDM rules snapshot are absent. `REQ-CC-031` |
| Settings/telemetry | CX has now published vocabulary version 1; consent receipt and capability error breadth were added | Backend contracts still declare the vocabulary pending/use placeholders, and the supposedly shared unsupported enum includes `build` only on the error side. `REQ-CC-032` |

`REQ-CX-005` is **ACCEPTED**: `settings-inventory.md` 0.2 now owns seven stable category IDs
and 31 binding-action IDs. Existing client action IDs were retained where available to avoid
an unnecessary migration; presentation labels remain independently editable/localizable.

## Backend requests

`REQ-CC-001` through `026` are marked `DONE` and retained as review history. The fifth pass
files six exact residual requests rather than reopening completed requests:

| Request | Scope |
|---|---|
| `REQ-CC-027` | Canonical room-list envelope, correlation/RTT inputs, and valid HTTP catalogue |
| `REQ-CC-028` | One approved onboarding order and lossless signed-out/account consent migration |
| `REQ-CC-029` | Reload-safe active-match discovery and unambiguous dynamic policy ownership |
| `REQ-CC-030` | Collision-free Bomb-position presence/visibility encoding |
| `REQ-CC-031` | Apply the outcome matrix to wire, facade, result, and terminal HTTP unions |
| `REQ-CC-032` | Consume settings vocabulary v1 and share one unsupported-client reason enum |

No frontend implementation will infer an endpoint body, build a reducer from unspecified
deltas, manufacture match outcomes, reconstruct an undefined server clock, or emit an
open-ended telemetry object.

## P0.3 decisions and frontend responses

| Decision | CX disposition | Remaining hold |
|---|---|---|
| D1 Supabase Auth | ACCEPTED as working platform choice | Verify immediate revocation/session listing by P1 exit |
| D2 Supabase Postgres Toronto + Fly match regions | ACCEPTED | No frontend hold |
| D3 The Square 88 m envelope | ACCEPTED and incorporated into art direction | Graybox measurement in `REQ-CX-002` |
| D4 Bomb Alpha format | ACCEPTED at max 12 / draw 6–6 | Outcome/result projection remains in `REQ-CC-031` |
| D5 desktop browser/device matrix | ACCEPTED and incorporated into CX specs | Implement/verify capability gate in P1 |
| D6 age 13 / prizes 18+ working default | ACCEPTED AS WORKING DEFAULT | Professional legal review before P8/P11; consent order/validity in `REQ-CC-028` |

`REQ-CX-003` and `REQ-CX-004` are accepted. The former is explicitly accepted against the
final amended D3 values (88 m, 9–14 s, 12–16 s, 16–22 s, 48 m), not the stale values preserved
in the request's historical Ask. `REQ-CX-002` remains correctly deferred until a versioned
graybox exists.

## Current frontend integration audit

Measured on the current tree without modifying product source:

| Area | Evidence | Implication |
|---|---|---|
| Client boot | `src/main.js` statically imports and constructs `Game` | P1 shell must split/lazy-load game runtime |
| Menu | `src/ui/menu.js`: 1,782 lines, 8 panels, 3 in-memory shells | Reuse visual language; move account/lobby/career routes to isolated shell modules |
| HUD | `src/ui/hud.js`: 1,754 lines; scoreboard 261; minimap 661 | Bomb UI targets the facade only after `REQ-CC-030`/`031` |
| Settings | 30 non-binding defaults and 23 binding entries | Validation exists; roaming/captions/a11y/mouse rebinding/real diagnostics remain |
| World | MERIDIAN 86×86 m, 18 spawns | Technical fixture only; The Square is a new map ID/manifest |
| Network UI | Scoreboard synthesizes deterministic ping | Remove when measured facade data exists; never propagate into shell |

## Gate and verification

- Six P0.2 design files: **complete, review pending**; D3/D5 decisions synchronized.
- Thirteen-contract second review and 1.2.0 amendment check: **complete**.
- Third-pass cross-reference amendments (`REQ-CC-015`–`020`): **received and reviewed** at 1.3.0.
- Fourth-pass graph audit: **complete** across the same six chains, including adjacent references.
- Fourth-pass amendments (`REQ-CC-021`–`026`): **received and reviewed** at 1.4.0.
- Fifth-pass graph audit: **complete** across the same six chains, including exact-state tests.
- `REQ-CX-005`: **ACCEPTED**; settings vocabulary v1 published in the CX inventory.
- G0A: **NOT PASSED** — six residual cross-contract amendment groups remain (`REQ-CC-027`–`032`).
- Product tests: not run; this pass changes CX-owned specifications/status/handoff and the
  permitted response lines in `requests-to-frontend.md` only.
- Worktree: remains dirty with pre-existing mixed product changes; none were modified by this
  review and no commit was created.

## Next frontend action

Re-review `REQ-CC-027` through `032` as end-to-end chains and amend the CX first-run sequence
only after the consent-order/legal decision in `REQ-CC-028` is explicit. Sign off G0A only
after every shared concept has one canonical source and every projection is lossless through
transport, UI, and persistence. P1 implementation remains blocked until the affected
contracts are frozen.
