<!-- SINGLE WRITER: [CX] Codex. Claude Code reads this; it never writes here. -->

# Frontend status — [CX] Codex

**Updated:** 2026-08-19  
**Phase:** P0 — Contract freeze  
**Overall:** IN PROGRESS — design pack complete; contract review complete; amendments and human decisions pending

---

## P0 frontend deliverables

All six P0.2 design specifications exist at version 0.1 and are ready for product/contract
review:

| Deliverable | Status |
|---|---|
| `docs/design/first-run-flow.md` | READY FOR REVIEW |
| `docs/design/shell-ia.md` | READY FOR REVIEW |
| `docs/design/square-artdirection.md` | READY FOR REVIEW |
| `docs/design/hud-bomb.md` | READY FOR REVIEW; aligned to server-only progress/no damage interruption |
| `docs/design/accessibility.md` | READY FOR REVIEW |
| `docs/design/settings-inventory.md` | READY FOR REVIEW |

The specs include the current-client audit, information architecture, loading/empty/error/
offline variants, authoritative data boundaries, accessibility targets, settings scopes, The
Square identity, and Bomb HUD fixtures.

## P0 contract review — response to REQ-CX-001

Every contract was read end-to-end and checked against the six design specifications and the
P0 “must specify” criteria. Three surfaces are sufficient for frontend purposes (two still
carry human holds); ten need exact amendments before Codex can implement against them. Nine
requests cover those ten contracts because `REQ-CC-001` resolves the shared HTTP/auth conflict.

| # | Contract | CX verdict | Evidence / request |
|---:|---|---|---|
| 1 | `http-api.md` | **INSUFFICIENT** | Most endpoints have notes rather than exact request/response/error schemas; settings, result-pending, telemetry, flags, and lobby reconnect are incomplete. `REQ-CC-001`, `003`, `006`, `008`, `009` |
| 2 | `errors.md` | **INSUFFICIENT** | Closed enum omits designed policy/recovery/replacement/kick/reconnect/abort outcomes; `AUTH_SESSION_REPLACED` is already referenced elsewhere but absent. `REQ-CC-002` |
| 3 | `auth.md` | **INSUFFICIENT** | Token model is sound, but refresh cookie-only semantics contradict `http-api.md` “in body”; policy decisions remain pending. `REQ-CC-001`, `002`; P0.3 #1/#6 hold |
| 4 | `realtime-lobby.md` | **INSUFFICIENT** | Full state uses placeholders; reconnect cannot reuse a consumed single-use ticket and no fresh-ticket endpoint exists. `REQ-CC-003` |
| 5 | `wire-protocol.md` | **INSUFFICIENT** | Current v1 is precise, but required auth/version/reconnect/Bomb v2 is only a list of future gaps, not a frozen byte contract. `REQ-CC-004` |
| 6 | `net-facade.md` | **INSUFFICIENT** | Correct ownership boundary, but Bomb roles/overtime/interaction/refusal/freshness, typed events, reconnect policy, and measured diagnostic metadata are missing. `REQ-CC-005` |
| 7 | `match-result.md` | **INSUFFICIENT** | Canonical stat definitions are strong; serialized `players`/`weapons` are placeholders and result-pending/history presentation states are unspecified. `REQ-CC-006` |
| 8 | `event-envelope.md` | **SUFFICIENT** | Identity, time, actor/subject, correlation/causation, schema version, privacy/retention, ordering, replay, and initial catalogue are explicit. |
| 9 | `map-data.md` | **INSUFFICIENT** | Spawn/objective/callout/nav surfaces are directly usable, but the sample budget (900 draw calls/1.4m triangles) contradicts binding architecture limits (<220/<450k). `REQ-CC-007` |
| 10 | `bomb-rules.md` | **SUFFICIENT — HUMAN HOLD** | Rules, precedence, interaction, visibility, spectator, disconnect, scoring, and verification semantics are buildable. Exact parameters/initial side/overtime/kit choice await P0.3 #4 and must then be frozen. Wire/facade representation remains separately insufficient. |
| 11 | `db-schema.md` | **SUFFICIENT — HUMAN HOLD** | Identity/profile/settings/stats/matches/outbox/audit/idempotency/moderation and lifecycle are coherent for UI consumers. Host/region decision P0.3 #2 still blocks freeze/implementation planning. |
| 12 | `telemetry.md` | **INSUFFICIENT** | Metrics/privacy/retention are named, but no client endpoint, event/batch schema, consent behavior, or signed-out funnel identity exists. `REQ-CC-008` |
| 13 | `feature-flags.md` | **INSUFFICIENT** | Server principles/defaults are sound; exact client response, visible keys, refresh/staleness semantics, and shell/diagnostics presentation flags are absent. `REQ-CC-009` |

### Cross-contract contradictions that must not freeze

1. `auth.md` stores/sends refresh credentials only as an httpOnly cookie; `http-api.md` says
   the refresh token is in the request body.
2. `realtime-lobby.md` consumes a single-use lobby ticket on open, then suggests reusing that
   ticket on reconnect or obtaining one from an endpoint that does not return it.
3. `map-data.md` gives performance budget values over 3× the binding triangle ceiling and
   over 4× the binding draw-call ceiling.
4. `auth.md` names `AUTH_SESSION_REPLACED`, but the supposedly closed `errors.md` enumeration
   does not define it.
5. `bomb-rules.md` requires both planting and defusing representation while the proposed
   entity-flag byte has only one spare bit; protocol v2 does not resolve the encoding.

## Backend requests

Nine blocking amendments are open in `docs/handoff/requests-to-backend.md`:

| Request | Scope |
|---|---|
| `REQ-CC-001` | Complete HTTP schemas and refresh transport |
| `REQ-CC-002` | Closed frontend error vocabulary |
| `REQ-CC-003` | Lobby state and reconnect ticket flow |
| `REQ-CC-004` | Exact protocol-v2 Bomb/rejection layout |
| `REQ-CC-005` | Complete net facade and diagnostics |
| `REQ-CC-006` | Exact result/pending-result UI schema |
| `REQ-CC-007` | Map budget alignment and measurement conditions |
| `REQ-CC-008` | Client telemetry endpoint/schema/signed-out identity |
| `REQ-CC-009` | Client-visible flag evaluation surface |

No frontend implementation will reach into `src/net/**`, derive missing server rules, parse
messages for branching, fabricate diagnostics, or build typed clients from placeholders.

## P0.3 human decisions

No item is approved until a named human decider and date are recorded.

| Decision | Recommendation / CX input | Status |
|---|---|---|
| Auth provider | Accept backend recommendation: managed identity | PENDING HUMAN |
| Database host/region topology | Backend/human decision required | PENDING HUMAN |
| The Square envelope | Recommend 88–104 m footprint, 10–16 s spawn-to-contact, 18–28 s safe rotation; see `square-artdirection.md` | PENDING HUMAN + CC REVIEW |
| Bomb format | Rules contract is sound; decide first-to-7/max-13, 1:45 rounds, plant/defuse/kit, 40 s provisional timer, overtime, and initial side. Final timer follows measured A↔B rotation | PENDING HUMAN |
| Browser/device matrix | Recommend desktop keyboard/mouse; current + previous Chrome/Edge/Firefox on Windows 11 and Safari/Chrome on macOS, subject to measured support | PENDING HUMAN |
| Age/eligibility baseline | Legal/product decision required before account data UI freezes | PENDING HUMAN/LEGAL |

## REQ-CX-002 — Square rotation evidence

Open and correctly deferred. No graybox The Square exists and `map-data.md` plus the P0.3
dimensions envelope are not frozen, so reporting a measured A↔B rotation now would measure
MERIDIAN or invented geometry. Once the graybox and guard inputs exist, Codex will run
`mapbalance.mjs`, report both-team A↔B timings with `MAP_VERSION`, and use the evidence to
review the final Bomb timer.

## Current frontend integration audit

Measured on the current tree without modifying product source:

| Area | Evidence | Implication |
|---|---|---|
| Client boot | `src/main.js` statically imports and constructs `Game` | P1 shell must split/lazy-load game runtime |
| Menu | `src/ui/menu.js`: 1,782 lines, 8 panels, 3 in-memory shells | Reuse visual language; move account/lobby/career routes to isolated shell modules |
| HUD | `src/ui/hud.js`: 1,754 lines; scoreboard 261; minimap 661 | Bomb UI targets the facade only after `REQ-CC-005` |
| Settings | 30 non-binding defaults and 23 binding entries | Validation exists; roaming/captions/a11y/mouse rebinding/real diagnostics remain |
| World | MERIDIAN 86×86 m, 18 spawns | Technical fixture only; The Square is a new map ID/manifest |
| Network UI | Scoreboard synthesizes deterministic ping | Remove when measured facade data exists; never propagate into shell |

## Gate and verification

- Six P0.2 design files: **complete, review pending**.
- Thirteen-contract read/review: **complete**.
- Contract sufficiency: **3 sufficient / 10 insufficient** (two sufficient contracts retain
  human holds; auth also retains human holds).
- G0A: **NOT PASSED** — nine backend amendments and six P0.3 decisions remain.
- Documentation validation: 13 verdict rows, 9 backend requests, no conflict/stale scaffold
  markers; explicit CX file set passes `lanecheck` (8 files, CC:0/CX:8). The only CC-owned
  file touched was the permitted `Status`/`Response` carve-out in `requests-to-frontend.md`.
- Product tests: not run; this session changes CX-owned documentation only.
- Worktree: remains on dirty `master` with pre-existing mixed-lane changes; no branch or
  commit was created to avoid absorbing unrelated work.

## Next frontend action

Re-review each accepted backend amendment against the exact request, update the verdict row,
and sign off only when all nine insufficient contracts are exact and internally consistent.
After the human decisions land, incorporate them into the design specs and run the G0A
checklist. P1 implementation starts only against frozen contracts and contract-valid stubs.
