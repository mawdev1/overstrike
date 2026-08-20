<!-- SINGLE WRITER: [CX] Codex. Claude Code reads this; it never writes here. -->

# Frontend status — [CX] Codex

**Updated:** 2026-08-20
**Phase:** P1 — forced contract freeze; connected-flow acceptance review
**Overall:** BLOCKED AT H1.1/H1.2 — the headers are frozen by explicit override, but stub/live parity, result-submission exactness, auth/consent adapter parity, and P1 CX deliverables do not pass

---

## P0 frontend deliverables

All six P0.2 specifications exist. The Square/accessibility baselines incorporate D3/D5;
first-run, shell, HUD, and settings have been amended to match the approved contract graph.

| Deliverable | Status |
|---|---|
| `docs/design/first-run-flow.md` | READY FOR REVIEW; 0.2 records the approved eligibility → consent → signup sequence and reload discovery |
| `docs/design/shell-ia.md` | READY FOR REVIEW; 0.2 adds the approved eligibility, consent, verification, and terms routes/states |
| `docs/design/square-artdirection.md` | READY FOR ART REVIEW; D3 envelope accepted |
| `docs/design/hud-bomb.md` | READY FOR REVIEW; 0.2 binds its data boundary to the exact facade and automatic pickup rule |
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

## Sixth-pass amendment audit

This pass reviewed the 1.5.0 amendments as connected schemas, then searched every affected
file for older copies of the same response, state, or rule. The canonical changes close the
fifth-pass defects, and the settings/unsupported-reason chain now passes. Five other chains
still have stale projections, and the wire malformed-input table has an independent boundary
error:

| Chain | Amendment accepted | Residual blocker |
|---|---|---|
| Room state / HTTP | §6 now has the paginated room envelope, measured-RTT header, correlation ID, and repaired catalogue | §11.3 still declares a raw array; §11.8 and `browser-empty` omit correlation IDs; `rttSource` remains an undefined accepted query parameter. `REQ-CC-033` |
| Onboarding / telemetry | Eligibility → consent → signup → verify → terms is approved; typed signed-out storage and receipt migration exist | Stale landing-first and `accounts.privacy` prose contradict the order/storage source; signup/profile exact schemas and telemetry batch/registry cannot represent the stated nullable and unlinked states. `REQ-CC-034` |
| Match reconnect | Authenticated active-match discovery and versioned spectator-policy derivation close the reload loop | The facade says `MatchHandoff` supplies required `matchState.matchId`, but the exact state shape omits it. `REQ-CC-035` |
| Bomb authority | The 41-byte state has a collision-free position-presence byte | Attackers are told the position is visible even in carried state, where the same section says coordinates are meaningless/zero, so the facade exposes a false origin position. `REQ-CC-036` |
| Match outcome | Wire now encodes every matrix row and `no-contest`; the result union and TDM snapshot are substantially specified | The full record omits its required status; invalidated has incompatible short/full shapes; stale wire, facade field-name, and Bomb disconnect rules contradict the matrix. `REQ-CC-037` |
| Protocol decoder | Appended event kinds and malformed-input policy are otherwise closed | The range guard uses `>` although valid indices stop at `length - 1`; code `EV_KINDS.length` falls through. `REQ-CC-038` |
| Settings / capability | Vocabulary v1 is consumed without duplicating IDs; `UnsupportedReason` is defined once and includes `build` | **PASS.** No residual cross-file contradiction found in the amended chain. |

The CX-owned first-run flow is now version 0.2 and matches the approved onboarding order. It
also replaces the impossible persisted reconnect-token resume rule with authenticated active-
match discovery followed by issuance of a fresh single-use ticket.

## Seventh-pass amendment audit

The 1.6.0 amendments close `REQ-CC-033` through `038` at the specific fields they changed.
This pass then tested whether the resulting contracts can drive the CX screen and fixture
matrices without inventing a transition or type. Three adjacent gaps remain:

| Chain | Seventh-pass result |
|---|---|
| Room state / HTTP | **PASS.** One paginated room envelope, one RTT header, correlated health responses, and matching empty fixture. |
| Match reconnect | **PASS.** Active-match discovery restores an exact handoff and `matchState.matchId` is now a real required field. |
| Bomb position / decoder | **PASS.** Position presence is meaningful-and-authorized, carried maps to null, and the event-kind boundary is `>= length`. |
| Settings / capability | **PASS.** Vocabulary v1 and the shared unsupported-reason enum remain coherent. |
| Onboarding / telemetry | **BLOCKED.** The personal registry still includes the pre-decision consent step, receipt rules disagree, returning sign-in has no declared receipt path, and “unlinked” correlation is not enforceable. `REQ-CC-039` |
| Match outcome | **BLOCKED.** Matrix values now agree, but the terminal HTTP union still contains placeholders/inconsistent correlation and history cannot represent its own pending state exactly. `REQ-CC-040` |
| Executable stubs | **BLOCKED.** Named scenarios do not cover the stateful onboarding, reload reconnect, lobby terminal, Bomb visibility, and result branches required by the CX screen matrices. `REQ-CC-041` |

Two CX projections were corrected in the same pass: `shell-ia.md` 0.2 now exposes every
approved onboarding route/state, and `hud-bomb.md` 0.2 consumes the exact facade vocabulary
and treats pickup as automatic contact behavior rather than a third interaction request.

## Backend requests

`REQ-CC-001` through `038` are marked `DONE` and retained as review history. The seventh pass
files three executable-contract requests rather than reopening completed requests:

| Request | Scope |
|---|---|
| `REQ-CC-039` | Close consent-step, receipt-acquisition, and unlinked-correlation telemetry rules |
| `REQ-CC-040` | Publish exact terminal-result and pending-history response unions |
| `REQ-CC-041` | Make every contracted CX state reachable through deterministic stateful stubs |

No frontend implementation will infer an endpoint body, build a reducer from unspecified
deltas, manufacture match outcomes, reconstruct an undefined server clock, or emit an
open-ended telemetry object.

## P0.3 decisions and frontend responses

| Decision | CX disposition | Remaining hold |
|---|---|---|
| D1 Supabase Auth | ACCEPTED as working platform choice | Verify immediate revocation/session listing by P1 exit |
| D2 Supabase Postgres Toronto + Fly match regions | ACCEPTED | No frontend hold |
| D3 The Square 88 m envelope | ACCEPTED and incorporated into art direction | Graybox measurement in `REQ-CX-002` |
| D4 Bomb Alpha format | ACCEPTED at max 12 / draw 6–6 | Exact result response projection remains in `REQ-CC-040` |
| D5 desktop browser/device matrix | ACCEPTED and incorporated into CX specs | Implement/verify capability gate in P1 |
| D6 age 13 / prizes 18+ working default | ACCEPTED AS WORKING DEFAULT | Professional legal review before P8/P11; telemetry boundary in `REQ-CC-039` |

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
| HUD | `src/ui/hud.js`: 1,754 lines; scoreboard 261; minimap 661 | Bomb state may target the facade; terminal result UI awaits `REQ-CC-040` |
| Settings | 30 non-binding defaults and 23 binding entries | Validation exists; roaming/captions/a11y/mouse rebinding/real diagnostics remain |
| World | MERIDIAN 86×86 m, 18 spawns | Technical fixture only; The Square is a new map ID/manifest |
| Network UI | Scoreboard synthesizes deterministic ping | Remove when measured facade data exists; never propagate into shell |

## Eighth-pass freeze audit

Three independent reviews traced the 1.7.0 amendments through their repeated schemas,
storage, transport, UI routes, and deterministic stub ownership. The amended canonical
paragraphs improve all three chains, but G0A still cannot pass:

| Chain | Eighth-pass result |
|---|---|
| Onboarding / telemetry | **BLOCKED.** Stale producer prose still begins personal telemetry at consent; a recorded decline cannot serialize through the exact profile example; receipt placement and retention disagree; pre-auth consent has incompatible deletion/migration lifecycles; invalid consent receipts have no typed recovery path. `REQ-CC-042` |
| Match result / history | **BLOCKED.** HTTP history retains the old non-null pending shape; the “exact” terminal union still contains placeholders; wire/facade/submission/redaction projections remain incomplete or contradictory. `REQ-CC-043` |
| Result lifecycle | **BLOCKED.** Allocated and queued-pending states are not both reachable, administrative invalidation has no append-only command, aggregation/no-contest and `match.result_applied` semantics disagree, and DB constraints do not encode the union. `REQ-CC-044` |
| Executable stubs / resume | **BLOCKED.** Seven top-level shell routes and many nested routes have no coverage owner; essential setup, incomplete-policy resume, active-lobby discovery, sessions, settings conflicts, recovery, and system states are unreachable. `REQ-CC-045` |
| Display-name feedback | **BLOCKED.** P1 B3 requires live authoritative availability/policy feedback, but no preflight endpoint or fixture exists. `REQ-CC-046` |
| Required UI harness | **BLOCKED FOR P1 EXIT.** The plan assigns `scripts/ui*.mjs` to CX and requires `scripts/uishell.mjs`, while the machine ownership map assigns that exact path to CC and `package.json` is CC-owned. `REQ-CC-047` |
| P1 HTTP implementation | **BLOCKED FOR LIVE INTEGRATION.** Runtime probing of committed `681a116` shows queued refresh cookies and custom response headers are discarded; build-floor comparison is lexical and required request identity headers are not validated. `REQ-CC-048` |
| P1 module integration | **BLOCKED FOR H1.2.** Real-store probing contradicts the green fake-store auth tests: row shapes disagree, outbox writes use the wrong representation, reuse detection rolls itself back, and auth/telemetry receipts are incompatible. `REQ-CC-049` |
| P1 executable stubs | **BLOCKED FOR H1.1.** The current stub router is unmounted, state identity splits flows, several fixtures violate contracts, no match facade stub exists, and `stubtest` aborts before assertions complete. `REQ-CC-050` |
| P1 deployed assembly | **BLOCKED FOR H1.2/H1.3.** The aggregate green suite has no production composition-root HTTP flow; live telemetry 500s, optional bearer auth is unwired, last-seen cannot advance, and proxy-aware client identity is unused. `REQ-CC-051` |
| Profile/settings/history | **BLOCKED FOR B4/B5.** Real-store probes fail match persistence and profile mutations; settings CAS loses updates, `mode=all` has the forbidden aggregate shape, and required privacy/idempotency semantics are absent. `REQ-CC-052` |
| Telemetry privacy | **BLOCKED FOR B6.** Internal-only linkage is retained outside preconsent, first-match modes are stale, and consent expiry/policy/nullability invariants are unenforced. `REQ-CC-053` |

The CX-owned first-run projection now agrees with the lawful boundary: landing, eligibility,
and the consent screen are unlinked internal counts; linked personal telemetry begins at
signup after affirmative consent. The malformed `@@###` headings for `REQ-CC-039`–`041`
were also repaired in the CX-owned append-only handoff log.

## Ninth-pass frozen-HEAD audit

Three independent reviews re-ran the connected contract and implementation flows at
`08b9862`. The 13 contract headers are now `FROZEN`, but the changelog explicitly records that
freeze as permission to proceed without final Codex approval; it did not amend the open
cross-file findings. The deployed platform suite reports 786 checks across seven suites with
zero failures, but several tests assert stale behavior and the Postgres path is skipped without
`DATABASE_URL`.

| Area | Ninth-pass result |
|---|---|
| Consent / telemetry | **BLOCKED.** A real HTTP probe accepted a personal event for client session B using a receipt issued to session A. Internal-only telemetry still stores account/session linkage; `session.first_match` rejects `bomb` and accepts stale `ffa`; producer prose, receipt placement, retention, and pre-auth lifecycle remain contradictory. `REQ-CC-042`, `053` |
| HTTP / auth assembly | **PARTIAL.** Cookies, ETags, numeric version ordering, refresh-family revocation, telemetry sink/auth wiring, and proxy derivation are fixed. Missing builds are enforced only when a floor is configured, malformed `2garbage` passes floor `2`, invalid-correlation recovery remains undocumented, and session `lastSeenAt` never advances because no adapter implements `touch`. `REQ-CC-048`, `049`, `051` |
| Executable stubs | **BLOCKED.** Interception and offline socket failure work, but delay, auth, prerequisite state, account-shared cross-tab state, correlation consistency, settings round-trip, active-room discovery, name preflight, resume state, and most shell variants do not. The passing stub test parses the incomplete HTTP table rather than the full shell matrix. `REQ-CC-045`, `046`, `050` |
| Result / history lifecycle | **BLOCKED.** An allocated match cannot be finalized because both stores treat the terminal write as a conflicting insert. No-contest results aggregate, result application emits no outbox event, pending/terminal projections remain contradictory, and the result route/exact submission/redaction rules remain absent. `REQ-CC-043`, `044` |
| Profile / settings | **PARTIAL.** Real match-store methods, atomic settings CAS, canonical name folding, and legacy-import storage landed. Wildcard `If-Match`, flat summed `mode=all`, missing privacy/idempotency/history-event behavior, extra public fields, and permissive pagination remain. `REQ-CC-052` |
| CX P1 product | **NOT IMPLEMENTED.** `src/main.js` still statically imports and constructs `Game`; no `src/ui/shell/**` or typed platform client/sender exists. Ownership and the package entry for `scripts/uishell.mjs` are fixed, but the file is absent and `npm run uishell` fails `MODULE_NOT_FOUND`. `REQ-CC-047` itself is satisfied. |

H1.1 therefore fails, and H1.2/H1.3 cannot be accepted. The cross-subject consent-receipt
acceptance is the highest-priority current defect because it breaks the stated privacy boundary,
not merely a presentation fixture.

## Tenth-pass targeted security re-review

At `c13d52f`, `REQ-CC-054` is **functionally accepted**. Deployed memory/socket controls reject
session-A receipt/session-B submission, account-A receipt/account-B bearer, a session receipt on
an authenticated request, and a signed-out personal batch without a subject; matching session
and account controls succeed. The committed suite covers all except the explicit cross-account
negative, which the independent manual HTTP probe passed and should still be added as a
regression vector.

The commit changed only the consent adapter, its assembly tests, and the backend handoff. It did
not alter the remaining contract, stub, result, profile, HTTP, session, or CX shell files.
Accordingly `REQ-CC-042`–`046`, `048`–`053` retain their ninth-pass verdicts. The highest-priority
remaining failures are internal-only telemetry retaining account/session linkage, allocated
matches that cannot finalize, no-contest career aggregation/outbox behavior, and the absent
H1.1 shell fixture matrix. This pass also isolated a result-response contradiction: frozen HTTP
defines `applied` as a boolean and replay as `false`, while the service returns an account-ID
array and replays the original response; no live result route currently exposes either shape.

## Eleventh-pass implementation re-review

At `a6d4b4e`, six corrections are genuine: malformed client builds are rejected when a valid
floor is configured; Bomb replaces the stale FFA/CTF/Search telemetry modes; internal-only
request bodies cannot carry session/receipt linkage; no-contest results no longer aggregate;
visible `mode=all` returns separate TDM/Bomb projections; and a production-wired first result
application emits one `match.result_applied` event. Tests that previously defended three of the
violations were corrected.

The pass remains unaccepted:

- Allocated matches still conflict instead of finalizing, `result_applied_at` is not persisted,
  terminal status events are absent, and result validation accepts incomplete terminal records.
- HTTP says replay returns `applied:false`, while the service replays its stored
  `applied:true` response and adds forbidden response fields. No live result endpoint resolves
  the projection.
- Hidden `mode=all` retains the stale flat shape; privacy PATCH/idempotency, rename events/history,
  wildcard `If-Match`, public projection, and pagination remain off-contract.
- Missing builds still pass under the default null floor, malformed configured floors fail open,
  session last-seen never advances, expired pre-auth consent is returned after 31 days, and the
  chosen delete-on-migration lifecycle/account consent constraint remain absent.
- Authenticated internal-only telemetry persists bearer-derived `accountId`, contradicting the
  stated internal/no-personal-data class. `REQ-CC-055` requests one explicit privacy rule.
- Stub/H1.1 and all CX B1 findings are unchanged; `uishell` remains absent and the game runtime
  is still imported statically.

## Twelfth-pass adapter and provenance re-review

At `9c439c8`, the `REQ-CC-055` runtime rule is accepted: authenticated and anonymous internal
records persist with null account/session identity, linked internal request bodies are rejected,
and personal bearer attribution remains intact. Missing/malformed builds now fail under the
default configuration, malformed floors fail closed, session last-seen advances, and result
replays report `applied:false`. Injected outbox failure also rolls back result, stats,
idempotency, and event state atomically.

The closure remains partial:

- Consent expiry differs by adapter. Memory uses global `Date.now()` rather than its injected
  clock and hides rather than deletes expired rows; Postgres has no expiry predicate and still
  returns them. Signup continues to retain migrated rows, and the account consent triple has no
  all-null/all-non-null constraint.
- Stub interception precedes build/auth validation, so missing, malformed, and below-floor
  builds still receive fixture responses. The stub's own advertised build string violates the
  newly enforced grammar, which is not yet defined in the frozen contract.
- Allocated-to-terminal finalization, persisted `result_applied_at`, terminal status events,
  exact result validation/response/route, hidden-mode privacy, profile idempotency, wildcard
  settings writes, and pagination remain open.
- H1.1/CX B1 remain unchanged: the fixture matrix is incomplete, the shell/harness is absent,
  and the engine is imported statically.
- Commit `9c439c8` mixes ten CC-owned and five CX-owned files, so lanecheck rejects its exact
  file set. It also changes frozen `telemetry.md` without a version or changelog/index amendment.
  `REQ-CC-056` records the required non-destructive provenance/versioning repair.

## Thirteenth-pass lifecycle, stub, and PostgreSQL re-review

At `cb005a5`, the central result lifecycle and most named profile defects are materially fixed.
Allocated rows finalize on both adapters; `result_applied_at` persists; first apply emits the
terminal status event and `match.result_applied`; replay emits neither and returns
`applied:false`; top-level required fields and DB outcome checks reject incomplete records.
Privacy PATCH/idempotency, wildcard settings rejection, pagination validation, exact public
projection, distinguishable hidden history, real stub delay/build gating/prerequisites/room
errors/settings round-trip, and lobby invariants also improved.

The real PostgreSQL harness independently started Postgres 16, applied all 13 migrations, passed
1,283 checks, replayed migrations as a no-op, and removed the container. The memory suite passed
1,055 checks. `REQ-CC-056` provenance repair is accepted: telemetry is versioned 1.8.0 with
README/changelog entries, and every post-`9c439c8` commit is lane-clean.

Remaining blockers:

- Nested result validation accepts malformed rules, scores, rounds, roster/player members,
  response-only fields, and unknown keys; draw+non-timer remains legal. No live result submission
  or match-detail route exists, and the internal detail service has no participant authorization.
- Outbox injection remains optional, allocated pending still serializes `startedAt:null` against
  a timestamp-only contract, and administrative invalidation/queued-pending production remain
  undefined. Original `REQ-CC-043/044` contract contradictions were not amended.
- Hidden `mode=all` still uses the flat shape; hidden-history `items:null` has no contracted union;
  profile idempotency has a Postgres get/execute/put race; rename writes no name-history row.
- Consent expiry is now correct on access in both adapters, but no sweeper removes untouched
  expired rows; signup still retains migrated rows and the account consent triple lacks its DB
  constraint. The original `REQ-CC-042` contradictions remain, and README still says every
  contract is presently 1.7.0 despite telemetry 1.8.0.
- H1.1 still fails: no display-name availability endpoint, code-only coverage not frozen into
  §11.11, client-session-isolated cross-tab state, forged stub tokens, correlation mismatch,
  missing facade, always-enabled non-production stubs, and uncontracted setup/resume fields.
- PostgreSQL and staged lane checks are manual-only. Root `ci` invokes neither and no repository
  workflow exists; `pgtest` exits zero when Docker is unavailable. `REQ-CC-057` makes the protected
  CI path non-skippable.
- CX B1 remains unimplemented: no shell or `uishell` harness, and `Game` is still statically
  imported/constructed.

## Fourteenth-pass connected-contract, CI, and mutation re-review

At committed HEAD `45a4cb7`, the backend has closed several previously central failures. The
live match detail/result routes are mounted and authorised; result objects are validated to the
leaf; allocated rows finalise; draw and terminal matrices are constrained in service and SQL;
result, career, idempotency and both outbox events commit atomically. `REQ-CC-042`'s consent
contract contradictions and `REQ-CC-044`'s reviewed lifecycle/aggregation paths are satisfied.
Real CI enforcement also exists now: root `npm run ci` completed. A clean archive of committed
HEAD passed 1,694 memory checks; its disposable PostgreSQL 16 run applied 16 migrations, passed
2,014 checks, replayed them as a no-op, and removed the container. `check` and `build` passed;
all 14 commits since `cb005a5` pass the authoritative per-commit lane-range guard.

Acceptance still fails on connected behavior:

- The contracted live display-name preflight is still 404. Its stub independently implements a
  weaker policy: it reports long, doubled-space, and mixed-script names available, and stub
  signup accepts the reserved name `admin`, while canonical auth rejects those names. Live
  profile/signup/signin also omit the newly required `flags.setupNextStep`.
- Stub assembly still ignores the default-off `platform.api.stub` flag; `X-Stub-Scenario` enables
  fixtures in every non-production assembly. Stub settings accepts wildcard `If-Match`, and the
  net-facade stub omits required `from` event fields and is not exposed through the contracted
  `net.__stub`/flag surface. Several green coverage cells drive an unrelated endpoint rather
  than the screen state they claim to own; `onboarding-happy` still skips essential settings.
- Match-result submission accepts a missing required `Idempotency-Key`. It also accepts
  contradictory `roster[]` and `players[]`, persists only players, and silently returns a
  different roster. Its idempotency row lasts 30 days against the HTTP contract's 24-hour
  gameplay retention. `REQ-CC-058` records these connected invariants.
- Privacy-hidden career/history return null variants not defined by the frozen exact HTTP
  schemas. Two valid case-only renames in one clock millisecond collide on the name-history
  timestamp primary key.
- PostgreSQL enforces the all-null/all-non-null account-consent triple, but the memory adapter
  accepts partial triples and `db-schema.md` does not publish migration 0015's invariant.
  Managed Supabase Auth is still replaced by bespoke stored scrypt credentials, contrary to the
  frozen authority decision.
- The contract README contradicts its own version table by saying every contract is presently
  1.7.0 and that requests already resolved in this pass remain open. Build/correlation recovery
  grammar and deployed settings ETag/session-touch vectors remain incomplete.
- An evenly distributed mutation sample killed 28 of 40 guard deletions; 12 survived (30%).
  This improves materially on the earlier 54% whole-tree measurement, but the ordinary green
  suite still does not prove every guard. The sample snapshot included the concurrently edited,
  uncommitted backend test file and is therefore evidence about that snapshot, not a clean-HEAD
  score.
- CX B1 is still absent: no `src/ui/shell/**`, no `scripts/uishell.mjs`, and `src/main.js`
  statically imports and constructs `Game`. Consequently the no-engine-before-match gate and
  required shell harness remain untestable.

## Fifteenth-pass adversarial-test and adapter re-review

Committed HEAD `7828938` substantially strengthens the proof surface without closing the P1
integration gates. A clean archive passed 2,393 memory checks. A serial disposable PostgreSQL
16 run passed 2,800 checks, all 16 migrations, and migration replay. An earlier PostgreSQL run
performed concurrently with eight mutation workers produced one auth-test failure; the direct
411-check auth suite and the complete serial rerun both passed, so it is recorded as a
resource-sensitive test flake rather than a reproduced adapter defect. Build/check and all seven
new per-commit lane checks pass; `citest` confirms every root-CI script is tracked.

The new adversarial tests genuinely improve confidence. Match-detail authorization now proves a
viewerless call and an empty roster fail closed, objective-actor redaction is exercised over real
Bomb rounds, and settings assertions identify the exact rejected field/rule. The fresh mutation
sample killed 36 of 40 evenly distributed guard deletions; four survived (10%, down from 30%).
The remaining sampled survivors include two PostgreSQL not-found guards and the active-match 204
projection, so the suite is stronger but still not complete evidence for every guard.

Release-blocking findings remain:

- `REQ-CC-058` reproduces unchanged. A service result without the required
  `Idempotency-Key` applies; contradictory roster/player identities validate and persistence
  silently replaces the submitted roster; the result idempotency TTL remains 30 days against
  the contracted 24-hour gameplay retention.
- Privacy-hidden stats and history still return null variants outside the frozen exact schemas.
  Fresh settings return `updatedAt:null` where §11.2 requires a timestamp. Two valid case-only
  name edits in one millisecond still collide on the name-history timestamp primary key.
- The newly contracted live display-name endpoint remains 404 and the stub's independent policy
  still accepts names canonical auth rejects, including reserved-name signup. Live auth/profile
  still omit `flags.setupNextStep`; the stub remains default-on in every non-production assembly;
  wildcard settings, facade payload/flag wiring, semantically unrelated matrix owners, and the
  skipped essential-settings happy-path remain.
- PostgreSQL enforces the consent triple as all-null/all-non-null, while the memory adapter still
  accepts partial rows and the frozen DB contract omits migration 0015's invariant. Managed
  Supabase Auth remains replaced by locally stored bespoke scrypt credentials.
- HTTP build grammar and invalid-correlation recovery remain code-only. Session touch and live
  settings behavior work, but the requested deployed endpoint assertions remain incomplete.
  The contract README still contradicts its version table and current request statuses.
- CX B1 remains completely absent: no shell directory, no `uishell` file, no lazy engine import,
  and no contracted `net.__stub` surface. H1.1 therefore still fails and H1.2/H1.3 remain
  unaccepted.

## Gate and verification

- Six P0.2 design files: **complete, review pending**; D3/D5 decisions synchronized.
- Thirteen-contract second review and 1.2.0 amendment check: **complete**.
- Third-pass cross-reference amendments (`REQ-CC-015`–`020`): **received and reviewed** at 1.3.0.
- Fourth-pass graph audit: **complete** across the same six chains, including adjacent references.
- Fourth-pass amendments (`REQ-CC-021`–`026`): **received and reviewed** at 1.4.0.
- Fifth-pass graph audit: **complete** across the same six chains, including exact-state tests.
- Fifth-pass amendments (`REQ-CC-027`–`032`): **received and reviewed** at 1.5.0.
- Sixth-pass graph audit: **complete** across canonical schemas and their repeated projections.
- Sixth-pass amendments (`REQ-CC-033`–`038`): **received and accepted** at 1.6.0.
- Seventh-pass executable-contract audit: **complete** across telemetry, result unions, and stub coverage.
- `REQ-CX-005`: **ACCEPTED**; settings vocabulary v1 published in the CX inventory.
- Settings/unsupported-reason chain: **PASSED** after `REQ-CC-032`.
- Eighth-pass 1.7.0 review: **complete; not accepted**. `REQ-CC-042`–`047` filed with exact cross-file and P1 verification requirements.
- P1 HTTP-core integration probe: **failed** cookie, custom-header, build-order, and request-ID invariants; `REQ-CC-048` filed with executable vectors.
- P1 real-object-graph and executable-stub probes: **failed**; `REQ-CC-049`–`050` filed with integration-level acceptance paths.
- P1 deployed profile/settings/telemetry audit: **failed** despite 475 isolated green checks; `REQ-CC-051`–`053` filed with real-store and HTTP acceptance paths.
- Tenth-pass `REQ-CC-054` security re-review: **FUNCTIONALLY ACCEPTED**; one requested cross-account regression vector remains absent from the committed suite.
- Eleventh-pass implementation re-review: **PARTIAL IMPROVEMENT; NOT ACCEPTED**. `REQ-CC-055` filed for bearer-derived identity on internal telemetry.
- Twelfth-pass `REQ-CC-055` runtime review: **ACCEPTED**; adapter expiry and contract-provenance findings remain.
- Thirteenth-pass lifecycle/profile/stub review: **MATERIAL IMPROVEMENT; NOT ACCEPTED**. `REQ-CC-056` accepted; `REQ-CC-057` filed for non-skippable CI enforcement.
- Fourteenth-pass connected-contract/CI review: **MATERIAL IMPROVEMENT; NOT ACCEPTED**.
  `REQ-CC-042`, `044`, and `057` accepted; `REQ-CC-058` filed.
- Fifteenth-pass adversarial/adapter review: **TEST DEPTH IMPROVED; NOT ACCEPTED**.
  `REQ-CC-044` remains accepted; `REQ-CC-043` is materially improved but its downstream
  `REQ-CC-058` invariants remain open; `REQ-CC-052` remains partial.
- Contract entry: technical re-review is **NOT ACCEPTED**. `REQ-CC-043`, `045`, `046`, `048`,
  `049`, `050`, `051`, `052`, `053`, and `058` retain open or partial findings.
- Clean-HEAD platform memory suite: **2,393 checks / 10 suites / 0 failures**.
- Clean-HEAD serial PostgreSQL suite: **2,800 checks / 10 suites / 0 failures**; 16 migrations and no-op replay passed.
- Root `npm run ci`: **PASS**, including real PostgreSQL, simulation, WebSocket, and server lifecycle.
- Mutation sample: **36 killed / 4 survived / 40 guards**; 10% survival on clean committed HEAD.
- Root `npm run check` and `npm run build`: **PASS**.
- `npm run uishell`: **FAIL**, required CX harness missing.
- H1.1: **FAIL**. H1.2/H1.3: **NOT ACCEPTED**.
- Worktree: remains dirty with pre-existing mixed product changes; none were modified by this
  review except this CX-owned status update; no commit was created.

## Next frontend action

The override permits CX to start the isolated shell, lazy runtime boundary, typed client core,
and required `uishell` harness. Do not accept H1.1 fixtures or switch B3–B6 to live platform
surfaces until the open request groups pass as connected flows. Backend priority is the
stub/live display-name and resume parity, result-submission relational/idempotency invariants,
executable route-by-state semantics, consent adapter parity, and the remaining profile contract
variants. CX priority remains B1's isolated shell, lazy runtime boundary, and executable harness.

## P1 CX shell/client implementation and assembled-app review

The CX-owned P1 surface is now implemented in the shared worktree without modifying the
pre-existing dirty game/server files. This supersedes the earlier statements in this status
file that B1 and `uishell` are absent; those statements remain as dated review history.

Delivered:

- B1: a 27-route History API shell with deterministic loading/empty/error/offline/terminal/
  ready fixtures, one main/h1, route focus, modal trapping/restoration, session/connection
  layers, responsive scrolling, reduced motion, and a capability gate. `Game` is no longer a
  static dependency of `src/main.js`; the production build places it in a separate lazy chunk,
  and WebGL context creation begins only from match loading.
- B2: one closed platform client with client ULIDs/build headers, strict correlation agreement,
  memory-only access tokens, httpOnly-cookie refresh, per-tab single-flight plus cross-tab refresh
  serialization, stale-response-safe terminal revocation, cross-tab logout, closed success-shape
  guards, deterministic transport errors, and bounded retry restricted to idempotent or
  idempotency-keyed operations.
- B3/B4: eligibility/consent/signup/verification/terms/essential setup, signin/recovery/signout,
  device-session revocation, reload resume, room/career/mode/weapon/history/detail/results views,
  and stale-response-safe pagination. The shell API maps these operations to frozen HTTP shapes
  and fails closed where the live platform surface is not contracted or implemented.
- B5: all 54 inventory settings plus all 31 configurable binding actions, exact seven categories and
  `ROAM|DEVICE|SESSION|PRACTICE` scopes, local-schema repair/migration, roaming schema v1
  hydration, edit-safe debounced write-through and ETag conflict handling, explicit rebind
  conflict choices, reset previews, reduced-motion preset, cross-tab provenance/reconciliation,
  and exact allowlisted measured-only diagnostics. The shell/controller layer applies every safe
  preference hook; the current local game runtime still consumes only its legacy subset. Newly
  inventoried camera/caption/audio/crosshair/HUD values and later-phase chat/ping/mute/spectator
  bindings that lack a runtime adapter are explicitly labelled pending rather than represented as
  completed live behavior.
- B6: the complete closed client-event registry, consent-gated personal events, permanently
  unlinked internal events, separate 50-event/64-KB batches, a 500-event validated session queue,
  ten-second cadence, 30-minute expiry, one delayed retry, flag-controlled sender, raw-error/PII
  exclusion, and shell abandonment/settings-friction/connection/error/WebGL/unsupported hooks.
  First-match and return-outcome emitters are present but cannot produce authoritative records
  until the CC-owned live match facade supplies the terminal lifecycle projection; local practice
  does not fabricate an online result.

- Client-visible feature flags now use the frozen registry and compiled defaults, refresh after
  authentication/expiry/return, retain stale values during a bounded background retry, hide or
  disable the contracted shell surfaces, and stop/drop telemetry when its kill switch is off.

Assembled-app defects caught during review were repaired before this entry: the shell and HTTP
client now share the same `SessionState`; cookie refresh feeds the authoritative profile into
setup/match/room resume; signed-in settings hydrate before resume where available; hydrated
accessibility preferences reapply to the document; the D5 floor is dual-core/8 GB system RAM;
and a real platform handoff cannot accidentally launch an offline practice match. Only explicit
fixture/local-practice handoffs may load the current local runtime.

D5 enforcement is exact for observable API/pointer/touch/WebGL2/WebSocket signals, Safari 17,
Windows 10, macOS 13, dual-core, and reported 8-GB RAM. Browser APIs do not expose VRAM and omit
RAM on Safari/Firefox, and “latest two” Chrome/Edge/Firefox cannot be derived from a user agent
without an authoritative moving version floor. Those rows remain manual/release-config evidence;
the client reports unknown values honestly and does not claim they were measured.

Verification at the implementation snapshot:

- `npm run uishell`: **PASS — 1,257 assertions**, including every applicable route × fixture
  variant, landmarks/headings/focus, dialog keyboard behavior, 200% zoom, reduced motion,
  no WebGL/game/three before match loading, and one lazy runtime request.
- `node src/ui/platform/platform.test.mjs`: **PASS**, including ten concurrent expired-token
  requests with one refresh, retry/correlation/error exactness, cross-tab revocation, telemetry
  privacy/queue/expiry/retry behavior, and shell-to-contract mappings.
- `npm run check`: **PASS — 74 modules / 201 imports**.
- `npm run build`: **PASS**. Initial shell JS is 160.23 KB; the game runtime is a separate
  819.57 KB lazy chunk.
- `npm run platformtest`: **PASS — 2,393 checks / 10 suites / 0 failures**.
- Scoped lanecheck: **PASS — 32 files: 31 CX, one shared handoff file, 0 CC/unowned files**.

External gates remain honest rather than papered over. `REQ-CC-059` records that browser
`sendBeacon` cannot supply the required build/correlation headers or account bearer subject;
unload delivery therefore stays fail-closed and queued. `REQ-CC-060` records that the repository
has no same-origin Vite-to-platform `/v1` path, so the browser cannot exercise the mounted stub
under the documented development commands. `REQ-CC-061` records the missing closed browser
transport codes needed for honest `connection.failure` telemetry. `REQ-CC-045/046/050/058` and the prior profile/auth
findings still prevent H1.1/H1.2/G0 acceptance. The P1 shell/client/controller slice is complete;
CX P1 overall remains **partial** for the explicitly listed runtime-setting and unmeasurable D5
rows, and the platform gate is **not** claimed complete until the CC dependencies pass.
