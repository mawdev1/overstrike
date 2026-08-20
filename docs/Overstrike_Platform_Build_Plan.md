# OVERSTRIKE — Platform Build Plan

**Companion to:** `Overstrike_Platform_Roadmap.docx`
**Plan version:** 2.0
**Prepared:** August 19, 2026
**Execution model:** Two autonomous engineering lanes running in parallel — **Claude Code (backend)** and **Codex (frontend)** — plus a human owner for product, art, security, finance, and legal approvals.

---

## PART 0 — HOW TO USE THIS DOCUMENT

### 0.1 This document is a contract between two agents

This plan is written to be read simultaneously by two AI engineering agents working on the same repository at the same time. Every unit of work in this document carries an owner tag:

| Tag | Owner | Meaning |
|---|---|---|
| **[CC]** | Claude Code | Backend, authoritative simulation, netcode, services, database, security, financial correctness, infrastructure, verification harnesses |
| **[CX]** | Codex | Frontend, rendering, UI/UX, art direction, client presentation, menus, HUD, portals, admin/creator/marketplace interfaces |
| **[BOTH]** | Both lanes | A shared contract or an integration handshake. Neither lane starts dependent work until this is signed off |
| **[HUMAN]** | Human owner | Decisions that cannot safely be delegated: product scope, balance sign-off, art direction, security review, provider selection, legal/compliance approval, go/no-go |

**Rule:** if a task is not tagged, it is not ready to be worked. Escalate it to the human owner instead of guessing the owner.

### 0.2 The single rule that prevents collisions

> **A file has exactly one writing lane. Ever. No exceptions.**

Both agents may *read* the entire repository. Only the owning lane may *write* a given path. This is what makes simultaneous work safe without merge negotiation. The complete ownership map is Section 1.4 and it is normative — if a path is not listed there, it is unowned and must be assigned by the human owner before either lane touches it.

When a lane needs a change inside the other lane's territory, it does **not** make the edit. It files a request (Section 0.4).

### 0.3 Branch and commit protocol

| Rule | Claude Code | Codex |
|---|---|---|
| Branch prefix | `be/<phase>-<slug>` | `fe/<phase>-<slug>` |
| Base branch | `master` | `master` |
| Rebase cadence | Before every push | Before every push |
| May commit paths | Only `[CC]`-owned paths | Only `[CX]`-owned paths |
| Commit message prefix | `be:` | `fe:` |
| Direct commits to `master` | Never | Never |

A pull request that touches a path owned by the other lane is invalid and must be split, regardless of how small the change is. This includes "obvious" fixes, formatting, and typo corrections.

### 0.4 Cross-lane request channel

Two files, one writer each. This is deliberate — a single shared request file would itself become a merge conflict.

| File | Written by | Read by |
|---|---|---|
| `docs/handoff/requests-to-backend.md` | **Codex only** | Claude Code |
| `docs/handoff/requests-to-frontend.md` | **Claude Code only** | Codex |
| `docs/status/backend.md` | **Claude Code only** | Codex, human |
| `docs/status/frontend.md` | **Codex only** | Claude Code, human |
| `docs/contracts/**` | **Claude Code only** (author of record) | Codex |
| This build plan | **Human owner only** | Both |

Request entry format (append-only, newest at the bottom):

```
### REQ-<lane>-<nnn> — <one-line title>
- Phase: P3
- Blocking: yes | no
- Needed by: <date or gate>
- Contract affected: contracts/http-api.md §4.2
- Ask: <precise description of the behaviour or field needed>
- Proposed shape: <JSON / signature / example>
- Requester's workaround until then: <what the lane is doing meanwhile>
- Status: OPEN | ACCEPTED | REJECTED | DONE
```

The receiving lane updates only the `Status:` line — it is the one exception to single-writer, and it is safe because it is a single-token edit on a line the writer never re-touches. If the receiving lane rejects, it appends the reason in a `- Response:` line.

### 0.5 Contract-first sequencing

Neither lane may build against an interface that does not yet exist in `docs/contracts/`. The order is always:

1. **[CC]** writes the contract (schema, endpoint, event, wire format) into `docs/contracts/`.
2. **[BOTH]** review it; Codex confirms it is sufficient for the UI it must build.
3. **[CC]** ships a *stub implementation* that returns contract-valid fake data behind a feature flag.
4. **[CX]** builds against the stub. **[CC]** replaces the stub with the real implementation.
5. Neither lane changes the contract without a versioned amendment (Section 0.6).

Step 3 is what allows the lanes to run at full speed at the same time. A stub is not optional work — it is the deliverable that unblocks the other lane, and it is scheduled explicitly in every phase below.

### 0.6 Contract change protocol

Contracts are versioned. Once a contract is marked `FROZEN` in its header, changes follow this path:

- **Additive change** (new optional field, new endpoint, new event type): allowed. Bump the minor version, note it in the contract changelog, notify via the request channel. No coordination stop.
- **Breaking change** (removed/renamed field, changed type, changed semantics): requires a `CCR` (Contract Change Request) entry in `docs/contracts/CHANGELOG.md`, human owner approval, a major version bump, and a dual-support window where both shapes are accepted for at least one phase.
- **Wire protocol** (`src/net/protocol.js`): every change bumps `PROTOCOL_VERSION`. Incompatible clients must be rejected at handshake with a clean upgrade message, never allowed to corrupt state. This is a roadmap requirement, not a nicety.

### 0.7 Definition of done (applies to every task in this plan)

A task is done when all of the following are true. Partial completion is reported as in-progress, never as done.

1. The code is merged to `master` and CI is green.
2. Its verification script exists and passes (`[CC]` tasks: a `scripts/*.mjs` harness or platform test; `[CX]` tasks: a browser harness assertion or screenshot check).
3. Its canonical telemetry events are emitted (from P1 onward — a feature without its events is not finished).
4. Its feature flag exists and has been toggled off and back on without error, for anything in the risk list (Section 9.2).
5. The owning lane has updated its status file.
6. Anything that changed a contract has the contract updated in the same PR.

---

## PART 1 — OWNERSHIP AND STARTING POSITION

### 1.1 Verified current state of the repository

This plan is grounded in the repository as it stands today, not on assumption. Measured facts:

- Approximately **39,000 lines of JavaScript across 53 modules** in `src/`, plus a dedicated server in `server/`.
- Vanilla ES modules + three.js 0.185 + Vite. **No external art or audio assets** — every texture, model, sound, and music cue is generated procedurally at runtime.
- A binding architecture contract already exists at `ARCHITECTURE.md`: fixed 1/120 s simulation step, single mutable `game` object, systems reach each other through `game` rather than importing each other.
- A **Node/WebSocket dedicated server** (`server/index.js`) running the same deterministic simulation headless, with `GameServer` (`src/net/server.js`) handling sessions, commands, snapshots, and broadcast.
- **Authoritative netcode already present:** binary command/snapshot protocol with delta baselines (`src/net/protocol.js`), client prediction and reconciliation (`src/net/prediction.js`), interpolation with a 100 ms delay (`src/net/client.js`), lag compensation (`src/net/lagcomp.js`), remote avatars (`src/net/avatars.js`), and a session layer (`src/net/session.js`).
- **Modes: TDM only.** `src/game/modes.js` exports a frozen table containing exactly one ruleset. There is no Bomb mode.
- **Map: MERIDIAN**, a Mediterranean coastal military compound (`src/world/level.js`), with navigation grid (`src/world/navGrid.js`), props, collision, and interiors. There is no map called The Square yet.
- **Deployment scaffolding exists:** `Dockerfile`, `Dockerfile.gameserver`, `fly.toml`, `fly.gameserver.toml`, `nginx.conf`.
- **Verification culture is strong and unusual:** no unit-test suite by design; instead ~70 harness scripts in `scripts/` boot the real build in headless Chromium and assert measured numbers. `npm run ci` chains static check, sim, TDM, map, collision, stair, headless, net, ws, feedback, and server tests.

**Gaps that define this plan's work:**

| Gap | Consequence |
|---|---|
| Progression lives in `localStorage` (`src/game/progression.js`) | No durable identity; stats are client-authoritative and trivially forged |
| No accounts, authentication, or sessions | Cannot ship a returning-player loop, which is the entire G1 gate |
| No database, no platform API | Nothing persists server-side |
| No presence, lobby, room, or server browser | The SOCOM-style social loop does not exist at all |
| No Bomb mode | Half of the Multiplayer Alpha proof scope is missing |
| One match per server process, self-restarting | No orchestration, no capacity, no regions, no draining |
| No canonical event stream, audit, or admin tooling | G0 unmet; nothing downstream can be operated safely |
| No anti-cheat evidence, reports, moderation, or sanctions | Cannot open to strangers |

### 1.2 What this plan deliberately does *not* do

The roadmap froze mode breadth. This plan enforces that freeze:

- **No** FFA, Gun Game, Domination, Kill Confirmed, or Battle Royale work until G1 and G2 pass. If those rulesets are re-added to `modes.js` before then, it is a scope violation.
- **No** blockchain, wallet, marketplace, or creator *implementation* before G2 — design and paper contracts only.
- **No** Extraction implementation before G2.
- **No** voice chat before moderation, reporting, and privacy controls exist.

### 1.3 Lane responsibility model

| Dimension | **[CC] Claude Code** | **[CX] Codex** |
|---|---|---|
| Owns truth about | Simulation, combat, netcode, match results, persistence, money, permissions | What the player sees, hears, and clicks |
| Primary languages/areas | Node services, PostgreSQL, WebSocket protocol, deterministic sim, workers, CI harnesses | three.js scenes, DOM/canvas UI, shaders, procedural art/audio, layout, accessibility |
| Security posture | Assumes the client is hostile and modified | Assumes the server may reject anything; never encodes authority locally |
| Failure mode to avoid | Shipping a fast path that bypasses validation or the ledger | Shipping UI that treats client state as authoritative or blocks on a network call |
| Test style | Headless harnesses asserting measured numbers; property/idempotency tests | Browser harnesses, screenshot comparison, interaction and a11y assertions |

**Hard boundaries neither lane crosses:**

- **[CX]** never writes to `src/net/**`, `src/core/**` (except where noted), `src/game/**`, `src/ai/**`, `src/player/player.js`, `src/weapons/ballistics.js`, `src/weapons/weaponSystem.js`, `src/weapons/weaponDefs.js`, `src/world/navGrid.js`, `server/**`, or `platform/**`.
- **[CC]** never writes to `src/ui/**`, `src/fx/**`, `src/audio/**`, `src/weapons/viewmodel.js`, `src/player/playerCamera.js`, `src/world/level.js`, `src/world/props.js`, `src/styles.css`, or `web/**`.

### 1.4 Normative file ownership map

This table is the authority. Both lanes must obey it literally.

| Path | Owner | Notes |
|---|---|---|
| `src/core/game.js` | **[CC]** | The `game` object and lifecycle. CX requests new fields via the request channel |
| `src/core/engine.js` | **[CC]** | Fixed-step loop, substeps |
| `src/core/input.js` | **[CX]** | Input capture and rebinding are player-facing |
| `src/core/settings.js` | **[CX]** | Client settings and persistence UX |
| `src/core/events.js` | **[CC]** | Event bus |
| `src/core/rng.js`, `mathUtils.js`, `snapshot.js` | **[CC]** | Determinism-critical |
| `src/core/presenter.js` | **[CC]** | Headless/recording presenter is server-side infrastructure |
| `src/core/assets.js` | **[CX]** | Procedural asset generation is art |
| `src/net/**` | **[CC]** | All of it, including `session.js` and `client.js`. CX consumes the facade in §A.1 |
| `src/game/match.js`, `modes.js`, `spawner.js`, `killstreaks.js` | **[CC]** | Authoritative rules |
| `src/game/progression.js` | **[CC]** | Migrates from `localStorage` to the profile service in P1 |
| `src/ai/**` | **[CC]** | Bots run headless on the server |
| `src/player/player.js` | **[CC]** | Movement simulation |
| `src/player/playerCamera.js` | **[CX]** | Camera feel and presentation |
| `src/weapons/ballistics.js`, `weaponSystem.js`, `weaponDefs.js`, `projectiles.js` | **[CC]** | Simulation and balance data |
| `src/weapons/viewmodel.js` | **[CX]** | Viewmodel animation and presentation |
| `src/world/world.js` | **[CC]** | Collision and world query API |
| `src/world/navGrid.js` | **[CC]** | Nav bake and pathfinding |
| `src/world/level.js`, `src/world/props.js` | **[CX]** | Geometry and art authoring — see the map protocol in §3.3 |
| `src/fx/**`, `src/audio/**` | **[CX]** | Presentation |
| `src/ui/**` | **[CX]** | All HUD, menus, scoreboard, killfeed, minimap |
| `src/ui/shell/**` *(new)* | **[CX]** | Sign-in, server browser, lobby, profile, results — the out-of-match app shell |
| `src/main.js`, `index.html`, `src/styles.css` | **[CX]** | Client entry and styling |
| `server/**` | **[CC]** | Dedicated match server process |
| `platform/**` *(new)* | **[CC]** | Control plane: API, DB, workers, admin backend |
| `web/admin/**`, `web/creator/**` *(new)* | **[CX]** | Admin Portal and Creator Portal frontends |
| `scripts/*.mjs` (sim/net/server/map/collision) | **[CC]** | Simulation and network harnesses |
| `scripts/ui*.mjs`, `beauty.mjs`, `scopeshot.mjs`, screenshot harnesses | **[CX]** | Presentation harnesses |
| `docs/contracts/**` | **[CC]** | Author of record; CX reviews and requests |
| `docs/handoff/requests-to-backend.md` | **[CX]** | Single writer |
| `docs/handoff/requests-to-frontend.md` | **[CC]** | Single writer |
| `docs/status/backend.md` | **[CC]** | Single writer |
| `docs/status/frontend.md` | **[CX]** | Single writer |
| `ARCHITECTURE.md` | **[CC]** | Binding contract; amendments need human approval |
| `README.md` | **[CC]** | With a CX-owned section marked by HTML comment fences |
| `package.json` | **[CC]** | CX requests script/dependency additions via the channel |
| `Dockerfile*`, `fly*.toml`, `nginx.conf`, CI config | **[CC]** | Infrastructure |

**Contested-path resolutions, stated explicitly so neither lane has to guess:**

- `src/net/session.js` is **[CC]** even though it runs in the browser, because it is protocol-coupled. Codex talks to it only through the facade contract (§A.1) and never reaches into its internals.
- `src/world/level.js` is **[CX]** even though the server loads it, because it is fundamentally art authoring. The server's dependency is protected by the **map data contract** (§3.3) and enforced by CC-owned harnesses that fail the build if geometry breaks collision, navigation, spawns, or objective volumes.
- `package.json` is **[CC]** because dependency and script changes are the single most conflict-prone file in a two-agent repo. Codex requests additions; Claude Code applies them within one working session.

---

## PART 2 — TARGET ARCHITECTURE

### 2.1 Deployable boundaries

Do not start with a microservice fleet. Start with three deployables and a database, structured so domains can be extracted later without rewriting behaviour.

| Boundary | Process | Owns | Lane |
|---|---|---|---|
| **Browser client** | Static bundle via Vite/nginx | Rendering, input, menus, prediction, presentation-only state | **[CX]** |
| **Match server** | `server/index.js`, one match per process | Combat truth, movement validation, round state, objective state, match result | **[CC]** |
| **Platform control plane** | `platform/` modular Node service | Accounts, sessions, profiles, stats, presence, lobby/rooms, allocation, results ingestion, moderation, admin commands, later: agents/ledger/marketplace/creator | **[CC]** |
| **Worker** | `platform/worker` | Result settlement retries, reconciliation, lease expiry, fraud scans, cleanup, notifications, dead-letter handling | **[CC]** |
| **PostgreSQL** | Managed instance | Durable state, immutable ledger rows, outbox events, audit records, idempotency keys | **[CC]** |
| **External providers** | Third party | Player-controlled wallet, payment/payout rail, chain settlement, KYC where required | **[CC]** + **[HUMAN]** |

Redis, a warehouse, and dedicated queues are introduced when measured load requires them — not as prerequisites.

### 2.2 The one architectural rule that outranks the others

> **The chain is never in the game loop, and the database is never in the tick.**

The match server accepts a validated snapshot at match start, runs the match on its own, and settles afterward through an idempotent result submission. No platform call, wallet call, or chain call may sit inside `fixedUpdate`. Any design that violates this is rejected regardless of convenience.

### 2.3 Correlation identity

Every request, command, match, and job carries a correlation ID from the moment a player action begins until the last downstream record is written. `[CC]` establishes the envelope in P1; `[CX]` propagates it on every HTTP and WebSocket call from the client. A player action that cannot be followed end to end across client → match server → platform → audit is an incomplete feature.
---

## PART 3 — PHASE PLAN

### 3.0 Phase map and gate alignment

Sprints are two weeks. Bands are sequencing estimates for two full-time agent lanes plus a human owner, and exclude legal turnaround, provider approval, and community testing.

| Phase | Title | Band | Roadmap gate | Entry condition |
|---|---|---:|---|---|
| **P0** | Contract freeze | 1 sprint | — | Immediate |
| **P1** | Operational foundation: identity, persistence, events | 2–3 sprints | **G0** | P0 contracts frozen |
| **P2** | Presence, rooms, teams, green-up | 2–3 sprints | — | P1 auth + profile live |
| **P3** | The Square + Bomb mode | 4–6 sprints | — | P0 map + mode contracts frozen (runs parallel to P1/P2) |
| **P4** | Match results, stats, reconnect | 2 sprints | **G1** | P2 + P3 integrated |
| **P5** | Public Alpha readiness | 4–6 sprints | **G2** | G1 passed |
| **P6** | Extraction vertical slice → Alpha | 6–9 sprints | **G3** | G2 passed |
| **P7** | Agent Platform v0 | 3–4 sprints | **G4** | Stable inventory/loadout/deploy APIs |
| **P8** | XO commerce and wallets | 4–6 sprints | **G5** | Ledger design + legal review |
| **P9** | Owned assets and marketplace | 4–5 sprints | **G6** | G5 + stable item registry |
| **P10** | Creator Portal | 4–5 sprints | **G7** | Item registry + XO ledger |
| **P11** | Sponsorships and Prize Reserve | 3–4 sprints | **G8** | The Square + finance + legal approval |

**Critical path:** P0 → P1 → P2 → P4 → P5. P3 runs in parallel from day one because The Square is a long-lead art and design item and must not become the thing that holds up G1.

---

## P0 — CONTRACT FREEZE

**Goal:** produce every interface both lanes will build against, so that from P1 onward the lanes never block each other. Nothing in P0 is optional; a missing contract in P0 becomes a two-week stall in P2.

**Duration:** 1 sprint. **Exit gate G0A:** every contract below exists in `docs/contracts/`, is marked `FROZEN`, and Codex has confirmed in `docs/status/frontend.md` that each is sufficient to build its UI.

### P0.1 Contracts authored — **[CC]**

| # | Contract file | Must specify |
|---|---|---|
| 1 | `contracts/http-api.md` | Every platform REST endpoint for P1–P4: auth, profile, stats, presence, rooms, results. Method, path, auth requirement, request/response schema, error codes, idempotency behaviour, rate limits, pagination |
| 2 | `contracts/errors.md` | Canonical error envelope: `code`, `message`, `correlationId`, `retryable`, `details`. A closed enumeration of error codes so the UI can branch on code and never on message text |
| 3 | `contracts/auth.md` | Token format and lifetime, refresh semantics, session revocation, device/session listing, logout-all, what the client stores and where, what happens on 401 vs 403 |
| 4 | `contracts/realtime-lobby.md` | The lobby WebSocket: connect/auth handshake, presence events, roster deltas, team change, ready state, countdown, launch handoff, chat, pings, heartbeat, reconnect |
| 5 | `contracts/wire-protocol.md` | Formalises the existing binary protocol: `PROTOCOL_VERSION`, message kinds, command encoding, snapshot delta/baseline rules, event kinds, version negotiation, rejection behaviour |
| 6 | `contracts/net-facade.md` | The **only** surface Codex uses to talk to netcode (see §A.1). Method signatures, emitted UI events, guaranteed state shape, error/disconnect states |
| 7 | `contracts/match-result.md` | Canonical stat definitions and the immutable result record (see §A.3) |
| 8 | `contracts/event-envelope.md` | The canonical platform event envelope (see §A.4) plus the initial event catalogue |
| 9 | `contracts/map-data.md` | The map data contract: what `level.js` must export so the server can collide, navigate, spawn, and run objectives (see §3.3) |
| 10 | `contracts/bomb-rules.md` | The complete Bomb ruleset (see §3.4) |
| 11 | `contracts/db-schema.md` | Initial PostgreSQL schema: accounts, sessions, profiles, stats, matches, match_participants, events_outbox, audit_log, idempotency_keys, sanctions, reports |
| 12 | `contracts/telemetry.md` | Client and server telemetry: what is measured, event names, sampling, retention class, privacy class |
| 13 | `contracts/feature-flags.md` | Flag naming, evaluation surface, default states, and which flags are kill switches |

### P0.2 Design specifications authored — **[CX]**

| # | Deliverable | Must specify |
|---|---|---|
| 1 | `docs/design/first-run-flow.md` | Landing → sign-in → display name → essential settings → server browser → lobby → green up → first match → results → return to lobby. Every screen, every state, every error state |
| 2 | `docs/design/shell-ia.md` | Information architecture for the out-of-match shell: navigation model, screen inventory, state machine, loading/empty/error/offline states for each screen |
| 3 | `docs/design/square-artdirection.md` | The Square's visual identity: palette, materials, landmark, signage language, time of day, readability rules for team identification |
| 4 | `docs/design/hud-bomb.md` | Bomb HUD: round timer, bomb carrier indicator, plant/defuse progress, site markers, alive counts, spectator UI, round-transition presentation |
| 5 | `docs/design/accessibility.md` | Colour-independent team/objective encoding, text sizing, subtitle plan, motion/shake reduction, rebinding coverage, minimum contrast targets |
| 6 | `docs/design/settings-inventory.md` | Complete settings list with ranges and defaults: mouse sensitivity, ADS sensitivity, FOV, rebinding, audio sliders, crosshair, HUD options, network diagnostics |

### P0.3 Joint decisions — **[BOTH]** + **[HUMAN]**

| Decision | Who decides | Why it must be now |
|---|---|---|
| Auth provider: self-hosted vs managed identity | **[HUMAN]** with CC recommendation | Determines P1 week 1 work and the entire session model |
| Database host and region topology | **[HUMAN]** with CC recommendation | Determines migration tooling and P5 regional design |
| The Square's competitive dimensions envelope (playspace bounds, target spawn-to-contact time, target rotation time) | **[HUMAN]** with CX + CC | Geometry authored against the wrong timing envelope is thrown away |
| Bomb round format: round count, round length, plant/defuse timers, overtime, side switch | **[HUMAN]** with CC | Ruleset drives both sim and HUD |
| Supported browser/device matrix | **[HUMAN]** with CX | Determines what CX tests and what the client refuses to run on |
| Age/eligibility policy baseline | **[HUMAN]** + legal | Blocks profile data collection design |

### P0.4 Repository preparation — **[CC]**

- Create `docs/contracts/`, `docs/handoff/`, `docs/status/`, `docs/design/` with the single-writer files pre-created and a header stating the owner.
- Add `docs/contracts/CHANGELOG.md` with the CCR format.
- Add a CI check that **fails a PR whose changed paths span both lanes' territory**, using the ownership map as data. This mechanically enforces Section 0.2 rather than relying on discipline.
- Add a CI check that a PR touching `src/net/protocol.js` also bumps `PROTOCOL_VERSION`.
- Mark the existing `docs/Overstrike_Build_Plan.md` as superseded by this document.

### P0 exit checklist

- [ ] All 13 contracts exist and are `FROZEN` — **[CC]**
- [ ] All 6 design specs exist — **[CX]**
- [ ] Codex has confirmed contract sufficiency in its status file — **[CX]**
- [ ] Cross-lane CI guard is live and has been proven to fail a deliberately mixed PR — **[CC]**
- [ ] All six P0.3 decisions are recorded with a named decider and a date — **[HUMAN]**

---

## P1 — OPERATIONAL FOUNDATION (Gate G0)

**Goal:** a player has a real, durable, server-side identity, and every meaningful action in the system produces a canonical event and an audit trail. This is the roadmap's G0 and nothing downstream is safe without it.

**Duration:** 2–3 sprints.

### P1.A Backend — **[CC]**

**A1. Platform service skeleton**
- Create `platform/` as a modular Node service: `platform/src/modules/<domain>/`, one module per domain, with explicit inter-module interfaces and no cross-module database reads.
- HTTP layer with request validation, structured logging, correlation ID middleware, error envelope per `contracts/errors.md`, health endpoints that distinguish process health from dependency health.
- Config via environment with a typed schema; fail fast on missing config rather than defaulting silently.
- Verification: `scripts/platformtest.mjs` — boots the service, asserts health, error envelope shape, correlation propagation, and config failure behaviour.

**A2. PostgreSQL and migrations**
- Versioned, forward-only migrations with a rehearsal path against a production-like staging database.
- Initial schema per `contracts/db-schema.md`. Every table has `created_at`, `updated_at`, and where relevant a soft-delete or status column rather than destructive deletes.
- `idempotency_keys` table from day one — not added later when it hurts.
- Verification: migration up/down rehearsal in CI on a scratch database; a schema-drift check that fails if the running schema diverges from migrations.

**A3. Accounts, authentication, sessions**
- Sign-up, sign-in, sign-out, refresh, logout-all, session listing with device/IP/last-seen, individual session revocation.
- Password handling per current best practice, or delegated entirely to the chosen provider; no bespoke cryptography.
- Display-name policy: uniqueness rule, reserved names, profanity/impersonation screening hook, change cooldown, change history retained for moderation.
- Verified account recovery path that cannot be used to bypass security controls, designed now even if the email channel ships later.
- Rate limiting on every auth endpoint, with lockout/backoff that cannot be used to lock out a victim indefinitely.
- Verification: `scripts/authtest.mjs` — token lifetime, refresh rotation, revocation takes effect immediately, expired/forged tokens rejected, rate limits enforced, recovery path cannot escalate.

**A4. Player profile and persistent stats**
- Profile: account ID, display name, created date, settings that must roam, moderation state, privacy state.
- Career stats schema covering TDM and Bomb per `contracts/match-result.md`: kills, deaths, assists, suicides, team kills, shots, hits, headshots, damage, wins, losses, plants, defuses, rounds, matches, playtime, per-weapon breakdown.
- **Migrate `src/game/progression.js` off `localStorage`** to server-authoritative reads with a local cache that is explicitly labelled as a cache and never trusted for scoring. Provide a one-time client-side import path for existing local progress, flagged as unverified.
- Verification: `scripts/profiletest.mjs` — profile survives session loss; a modified client cannot write stats directly; stat writes are rejected without a valid match result.

**A5. Canonical event stream and outbox**
- Implement the event envelope from `contracts/event-envelope.md`.
- Transactional outbox: domain state change and its event are written in the same transaction; a relay publishes them at-least-once with ordering per entity and dead-letter handling.
- Initial catalogue: `account.created`, `session.started`, `session.revoked`, `profile.updated`, `match.started`, `match.completed`, `admin.action.executed`, `config.changed`, `sanction.applied`.
- Verification: `scripts/eventtest.mjs` — no state change without its event; crash between write and publish still delivers; duplicate delivery is safe for every consumer.

**A6. Audit log and RBAC**
- Roles: player, support, moderator, finance, developer, superadmin, service account. Least privilege, scoped tokens, no shared admin credentials.
- Every privileged mutation is an explicit command carrying actor, role, reason code, correlation ID, before/after summary — written to an immutable audit table.
- Verification: `scripts/audittest.mjs` — a privileged mutation without a reason code is rejected; audit rows cannot be updated or deleted by the application role.

**A7. Observability baseline**
- Structured JSON logs, distributed traces across client → match server → platform, service metrics, alert routing, and an incident timeline view.
- Client error and crash reporting ingestion endpoint (CX ships the sender).
- Verification: a synthetic player action is followed end to end by correlation ID across all three tiers, demonstrated in the phase review.

**A8. Stubs for Codex (scheduled deliverable, not a side effect)**
- Ship contract-valid stub responses for every P2 endpoint — presence, room list, room state, roster, ready — behind flag `platform.lobby.stub`. Stubs return deterministic fake data so CX can build the entire server browser and lobby UI before the real lobby exists.
- Ship a stub lobby WebSocket that emits the full event sequence of a lobby session on a timer.

### P1.B Frontend — **[CX]**

**B1. App shell architecture**
- Create `src/ui/shell/` — the out-of-match application: routing/state machine, screen container, global loading/error/offline handling, session context.
- The shell must be able to run with the game engine unloaded, so a signed-in player browsing servers is not paying the cost of a live three.js scene.
- Verification: `scripts/uishell.mjs` — every screen renders in isolation with loading, empty, error, and offline states.

**B2. Platform HTTP client**
- A single typed client for the platform API: correlation ID generation and propagation, auth token attachment, refresh-on-401 with a single-flight guard, typed errors mapped from `contracts/errors.md`, timeouts, retry policy that never retries non-idempotent calls.
- **Never** encode business rules client-side. The client displays what the server says.
- Verification: assertions for token refresh under concurrency, retry safety, and correct behaviour when the platform is unreachable.

**B3. Authentication and account screens**
- Sign-up, sign-in, sign-out, display-name selection with live availability and policy feedback, session/device list with revoke, logout-all, account recovery entry point, and clear messaging for every failure code.
- Session persistence across reload and across tabs, with a defined behaviour when a session is revoked while the tab is open.

**B4. Profile and career screens**
- Career overview, per-mode stats, per-weapon breakdown, match history list with a match detail view — all built against the P1.A8 stubs and switched to live data with no UI change.

**B5. Settings system completion**
- Implement the full `settings-inventory.md`: mouse and ADS sensitivity, FOV, complete key rebinding, audio sliders, crosshair customisation, HUD options, and a network diagnostics panel showing ping, jitter, loss, and correction rate once P2 exposes them.
- Settings that must roam are written through the profile service; local-only settings stay local and are labelled as such.

**B6. Client telemetry and crash reporting**
- Emit the client half of `contracts/telemetry.md`: time-to-first-match, sign-in funnel steps, lobby abandonment, connection failures, settings friction, unhandled errors, WebGL context loss.
- Respect the privacy class of each event; never send raw personal data that the contract does not authorise.

### P1 handshake points — **[BOTH]**

| # | When | What |
|---|---|---|
| H1.1 | Start of sprint 1 | CC ships stub endpoints; CX confirms they unblock B3/B4 |
| H1.2 | Mid-phase | Live auth replaces stub auth; CX switches the flag and reports breakage through the request channel only |
| H1.3 | End of phase | Correlation ID walk-through: a CX-initiated action is traced by CC through every tier |

### P1 exit — Gate G0

- [ ] A player signs up, signs out, returns on another device, and recovers the same profile
- [ ] Stats are server-authoritative; a modified client cannot write them
- [ ] Every state change emits its canonical event; the outbox survives a crash
- [ ] Every privileged action is audited with actor, reason, and correlation ID
- [ ] Logs, traces, and metrics exist across all three tiers with shared correlation IDs
- [ ] Migrations can be rehearsed on staging and rolled forward on production
- [ ] `localStorage` is no longer the authority for anything that affects scoring or identity

---

## P2 — PRESENCE, ROOMS, TEAMS, GREEN-UP

**Goal:** the SOCOM-style social loop. A player sees who is online, browses rooms, joins one, picks a team, greens up, and the same roster transitions into an authoritative match.

**Duration:** 2–3 sprints. Depends on P1 auth and profile.

### P2.A Backend — **[CC]**

**A1. Presence service**
- States: offline, online, in-lobby, in-match, plus joinability. Heartbeat-driven with a defined staleness timeout, so a crashed client does not appear online forever.
- Roster discovery: online player list, recent players, lobby roster, with hooks reserved for friends later.
- Privacy-aware: presence visibility respects account privacy settings from day one rather than being retrofitted.

**A2. Room lifecycle service**
- Deterministic lifecycle: create → advertise → reserve → launch → return-to-lobby → idle-expire → destroy. Every transition is a logged event.
- Room metadata published to the browser: map, mode, player count, capacity, region, ping estimate, status, join eligibility, password/private flag if in scope.
- Slot reservation with a TTL so a player who starts joining and stalls does not hold a slot indefinitely, and a race between two joiners cannot oversubscribe.
- **No zombie rooms**: an unreachable or crashed match server's rooms are reaped and de-advertised. Prove this with an injected-failure test, not by inspection.

**A3. Teams and readiness**
- Authoritative team assignment for Alpha and Bravo with capacity enforcement and optional balancing; the server, not the client, decides whether a switch is legal.
- Ready ("green up") state per player, published to every member with a clear green/grey state. Ready is cleared on roster change, team change, or loadout change so nobody is launched into a match they did not consent to in its current shape.
- Launch: all required players ready → countdown → roster frozen → match server allocated → session tokens issued → the *same roster* transitions in. A player who drops during countdown aborts or re-arms the countdown per an explicit rule, never silently.

**A4. Match server allocation (v0)**
- Separate lobby intent from match-server allocation. Track capacity per instance and per region. `server/index.js` gains a control interface so the platform can request a match, receive a connect address, and be told when the match ends.
- Match servers register, heartbeat, report capacity, and drain on request. This is the seed of P5's orchestration and is built now so P5 is hardening rather than rewriting.

**A5. Lobby realtime channel**
- Authenticated WebSocket per `contracts/realtime-lobby.md`: roster deltas, presence, team changes, ready changes, countdown ticks, launch handoff, chat, quick pings/canned callouts, heartbeat, and reconnect with state resync.
- Text chat with rate limits, length limits, a moderation hook, and per-player mute. **Voice is out of scope** until P5's moderation and privacy work lands.

**A6. Session handoff to the match server**
- A short-lived, single-use, room-scoped token. The match server validates it against the platform and refuses unauthenticated or replayed connections. Duplicate sessions for the same account are resolved by an explicit rule, never by allowing two live entities.

**A7. Verification**
- `scripts/lobbytest.mjs`: room lifecycle including every failure transition; slot reservation races; oversubscription attempts; ready-state invalidation rules; countdown abort; roster integrity from lobby to match.
- `scripts/presencetest.mjs`: staleness reaping, privacy filtering, churn under load.
- Fault injection: kill a match server mid-countdown, mid-match, and mid-handoff; assert no zombie rooms, no duplicate identities, no stuck players.

### P2.B Frontend — **[CX]**

**B1. Server browser**
- Live room list with map, mode, players/capacity, region, ping, status, and join eligibility. Sorting, filtering, refresh behaviour, and an honest empty state that explains *why* it is empty (no rooms vs cannot reach platform).
- Ping display must be measured and labelled, not invented.

**B2. Lobby room screen**
- Roster with team columns, ready indicators that are legible without relying on colour alone, host/owner indication, capacity, map/mode summary, and countdown.
- Team join/switch with optimistic feedback that reconciles to the server's decision and clearly reverts if the server refuses.
- Green-up control with an unmistakable state, plus a visible reason when readiness is cleared by a roster or loadout change.
- Loadout configuration inside the lobby without starting the match.

**B3. Lobby communication**
- Text chat with mute, report entry point, rate-limit feedback, and history that does not leak across rooms.
- Quick tactical pings / canned callouts with a fast input path (radial or hotkey) that works during matches as well.

**B4. Transition and results loop**
- Countdown → loading → match handoff → post-match scoreboard → return to lobby, with the roster preserved and a clear path to a rematch.
- Every failure in that chain has a designed screen: allocation failed, server unreachable, kicked, version mismatch, match aborted.

**B5. Connection state UX**
- A single, honest connection indicator covering platform, lobby socket, and match socket. Reconnect attempts are visible, bounded, and cancellable.
- Version mismatch produces a clean upgrade message, per the roadmap's protocol-compatibility rule.

### P2 handshake points — **[BOTH]**

| # | When | What |
|---|---|---|
| H2.1 | Sprint 1 start | Lobby WebSocket stub emits a full scripted session; CX builds against it |
| H2.2 | Sprint 2 | Live lobby replaces the stub behind the flag; both lanes run a joint two-client manual session |
| H2.3 | Phase end | Six-player joint test: browse, join, switch teams, green up, launch, return, rematch |

### P2 exit

- [ ] Two real clients see each other's presence, join the same room, pick teams, green up, and launch together
- [ ] Room state is authoritative; a modified client cannot force a team, a slot, or a launch
- [ ] Killing a match server produces no zombie rooms and no stuck players
- [ ] Reconnecting to the lobby restores correct state
- [ ] Chat, mute, ping, and report entry points work and are rate-limited
---

## P3 — THE SQUARE + BOMB MODE

**Goal:** replace MERIDIAN with The Square as the competitive home map, and add Bomb as the second and final Alpha mode. This phase runs **in parallel with P1 and P2 from day one** because map quality is the longest-lead item in the whole program.

**Duration:** 4–6 sprints, overlapping.

This is the phase with the highest collision risk, because geometry is authored by Codex but consumed by Claude Code's simulation. §3.3 exists specifically to make that safe.

### 3.3 The map data contract — **[BOTH]**, authored by **[CC]**

`src/world/level.js` is **[CX]**-owned. The server depends on it. The dependency is mediated by a contract, an artifact, and a guard:

**The contract.** `level.js` must export a stable, documented structure that includes:

| Export | Consumed by | Rule |
|---|---|---|
| Collision geometry | `src/world/world.js` **[CC]** | Convex volumes or the existing collision primitives only. No renderer-only meshes may participate in collision |
| Spawn markers | `src/game/spawner.js` **[CC]** | Named, team-tagged, with facing and a protection volume. Minimum count per team defined in the contract |
| Objective volumes | Bomb ruleset **[CC]** | A-site and B-site plant volumes, defuse volumes, and bomb-carrier-relevant zones, each with an ID that never changes once shipped |
| Named callout regions | HUD **[CX]**, evidence **[CC]** | Every region named once, in one place, used by both the UI and the match evidence record |
| Nav bake input | `src/world/navGrid.js` **[CC]** | Walkable surface tagging, stair/mantle affordances, and explicit "not walkable" volumes |
| Performance budget metadata | Both | Draw call, triangle, material, and light budgets per sector |

**The artifact.** Geometry changes require re-running the nav bake. The bake script is **[CC]**-owned; its *output* is committed by **[CX]** in the same PR as the geometry change. So Codex runs a CC-owned tool and commits its output — no cross-lane file writing occurs.

**The guard.** These CC-owned harnesses must pass on every PR that touches `level.js` or `props.js`, and they are what makes CX-owned geometry safe:

| Harness | Proves |
|---|---|
| `scripts/maptest.mjs` | Every exported structure conforms to the contract; every objective ID resolves; every spawn is valid |
| `scripts/collisiontest.mjs` | No player-passable wall; no geometry a player can fall through or get stuck inside |
| `scripts/stairtest.mjs` | Every stair, ramp, and mantle is traversable on foot |
| `scripts/vertprobe.mjs` | Every intended upper floor and rooftop is reachable; no unreachable playspace |
| `scripts/mapbalance.mjs` | Route timings, sightline lengths, and site symmetry fall inside the envelope agreed in P0.3 |
| `scripts/navtest` (extend) | Nav bake produces no phantom nodes and no unreachable regions |
| `scripts/geomtest.mjs` | Performance budgets are met on the supported hardware profile |

**This is a lesson already learned in this repository.** Previous map work produced unreachable upper floors, nav nodes floating underground, and a probe that asserted nothing. The guard harnesses are not ceremony; they are the reason geometry authoring can be delegated to a separate lane at all. Any harness that can pass while asserting nothing is a defect in the harness.

### 3.4 The Bomb ruleset — **[CC]**, decided with **[HUMAN]**

`contracts/bomb-rules.md` must pin down, before any code:

- Round count, round length, side switch point, overtime rule, match win condition.
- Bomb spawn/carrier rules: who starts with it, what happens on carrier death, drop and pickup rules, and whether it can be moved between sites.
- Plant: eligible volumes, plant duration, interruption behaviour, what the plant does to the round timer.
- Defuse: duration, kit or no kit, interruption behaviour, partial-progress rules.
- No-respawn flow: elimination, the exact win conditions (elimination vs objective vs timer), and their precedence.
- Spectating: who a dead player may spectate, what information the spectator view exposes, and the anti-abuse rule that prevents a dead player relaying live information outside the team.
- Backfill: **Bomb does not silently inject players into an active competitive round.** This is a roadmap requirement.
- Disconnect and abandon: what happens to a round, a match, and the result record when a player leaves, and when a team drops below a threshold.

### P3.A Backend — **[CC]**

**A1. Bomb ruleset implementation**
- Extend `src/game/modes.js` with the Bomb ruleset and `src/game/match.js` with round state, round transitions, and match-series logic. TDM and Bomb are the only entries; the freeze holds.
- Round state machine is server-authoritative and fully deterministic under the fixed 1/120 s step.
- Plant/defuse are server-validated interactions: position inside the volume, line of sight/state preconditions, duration accumulated on the server, interruption on the server. The client only requests and displays.
- Elimination tracking, spectator eligibility, and round-end resolution with a single, ordered end-of-round sequence — the same discipline the existing TDM round-end already enforces.
- Verification: `scripts/bombtest.mjs` — every win condition and precedence rule; plant/defuse interruption at every boundary; carrier death and pickup; round transitions; no double-award on a simultaneous plant and elimination; determinism across two identical runs.

**A2. Spawn system**
- TDM dynamic spawn scoring using enemy distance and visibility, recent death locations, teammate positions, and combat pressure. Bomb uses fixed protected team spawns per the ruleset.
- Verification: extend `scripts/mapbalance.mjs` to report immediate repeat-death rate, spawn-flip-into-enemy rate, and first-death location distribution. These are numbers with thresholds, not impressions.

**A3. Map systems support**
- Update `world.js`, `navGrid.js`, and `spawner.js` to consume the P3.3 contract from The Square.
- Bot navigation and cover nodes on the new geometry, so bots remain useful for testing and for filling rooms.
- Retire MERIDIAN from the mode rotation once The Square passes its guards; keep it available as a test fixture so existing harnesses retain a stable comparison target.

**A4. Protocol and evidence extensions**
- Add Bomb-specific entity/event fields to the wire protocol (round state, plant progress, carrier flag, alive counts) with a `PROTOCOL_VERSION` bump and clean rejection of old clients.
- Extend the match evidence record with objective events: plant, defuse, carrier changes, round starts/ends.

### P3.B Frontend — **[CX]**

**B1. The Square — geometry and art**
- Author the map to the P0.3 dimensional envelope and the `square-artdirection.md` identity: an original urban combat district with a central plaza, dense interiors, alleys, multiple approach routes, bounded verticality, and two distinct bomb sites with separated lanes.
- Original geometry, landmarks, naming, and proportions. Design *principles* may be borrowed from the classics; layouts, names, and art may not.
- Build it to be **dual-use from the start**: tightly bounded for TDM/Bomb now, with the boundary implemented as a removable competitive barrier layer rather than as baked geometry, so P6 can embed the same district in the extraction world without re-authoring it.
- Reserve — but do not implement — the commercial placement anchors from the roadmap: storefronts on major routes, wall/billboard surfaces, rooftop signage, and an event-sponsor position. Anchors are named empty transforms; P11 fills them.

**B2. Map iteration loop**
- Run the CC-owned guard harnesses locally before every push. Treat `mapbalance.mjs` output as the design feedback signal: route timings, sightline distribution, site win rates from bot matches.
- Commit the nav bake output alongside every geometry change.

**B3. Bomb presentation**
- Bomb HUD per `hud-bomb.md`: round timer, score by round, alive counts, bomb carrier indicator, plant and defuse progress with server-driven progress (never client-simulated), site markers, and round-transition sequences.
- Spectator camera and spectator UI honouring the information limits set in the ruleset.
- Objective and team indicators that do not depend on colour alone.

**B4. Callouts and minimap**
- Minimap and compass updated for The Square, using exactly the callout names from the map data contract so players, HUD, and match evidence all use one vocabulary.

**B5. Performance**
- Occlusion and LOD strategy hitting the geomtest budgets on the supported browser matrix. Frame time, draw calls, and triangle counts are reported numbers, not claims.

### P3 handshake points — **[BOTH]**

| # | When | What |
|---|---|---|
| H3.1 | Before geometry starts | Map data contract frozen; CC ships a graybox stub level that satisfies it so CC can build Bomb against real structures immediately |
| H3.2 | Continuous | CX pushes geometry; CC guards run in CI; failures come back through the request channel with the failing harness output |
| H3.3 | Mid-phase | First full bot Bomb match on The Square, driven by `bombtest.mjs` |
| H3.4 | Phase end | Human playtest with real players on The Square, both modes, with `mapbalance.mjs` evidence attached |

### P3 exit

- [ ] The Square passes every guard harness: map, collision, stair, vert, nav, balance, geom
- [ ] Bomb is fully server-authoritative and deterministic; every win condition tested
- [ ] Bots navigate The Square and play both modes
- [ ] Route timings, sightlines, and site outcomes sit inside the agreed envelope
- [ ] The competitive boundary is a removable layer, not baked geometry
- [ ] MERIDIAN is retired from rotation and retained as a fixture

---

## P4 — MATCH RESULTS, STATS, RECONNECT (Gate G1)

**Goal:** close the loop. A match produces an immutable, authoritative result that updates career stats exactly once, and a player who drops can come back.

**Duration:** 2 sprints. Entry: P2 and P3 integrated.

### P4.A Backend — **[CC]**

**A1. Immutable match records**
- Every match gets a `matchId` at allocation, not at completion. The result record carries: matchId, ruleset version, server build, map version, region, roster with team and account IDs, per-player stats, round-by-round outcomes for Bomb, start/end timestamps, and termination reason.
- Canonical stat definitions from `contracts/match-result.md` are the single source of truth — kills, assists, suicides, team kills, plants, defuses, wins, losses, disconnects, abandons, invalidated matches. Ambiguity here becomes an unresolvable support ticket later.

**A2. Idempotent finalisation**
- Result submission uses an idempotency key derived from the matchId. Retries, reconnects, duplicate messages, and worker re-runs cannot award stats twice. This is a roadmap requirement stated explicitly and it must be *tested by deliberate duplicate submission*, not assumed.
- Submission is transactional with the stat update and the `match.completed` event via the outbox.
- If the platform is unavailable at match end, the match server durably queues the result and the worker retries with backoff; the match server never blocks players on it.

**A3. Failure semantics — defined before launch, per the roadmap**
- Player disconnects mid-match; player abandons; whole team leaves; room owner leaves; match server crashes mid-round; result service unavailable; a Bomb round interrupted mid-plant. Each has a written, implemented, tested outcome.
- Invalidated matches are recorded as invalidated with a reason, not silently dropped.

**A4. Reconnect**
- Grace period per mode, session replacement rules, and state restoration. A brief disconnect must not corrupt room or round state or duplicate a player identity.
- Verification: `scripts/reconnecttest.mjs` — disconnect and return inside and outside the grace window, in TDM and mid-Bomb-round, with duplicate-session attempts.

**A5. Match evidence**
- Compact authoritative evidence per match: event timeline, key position and combat samples, rule version, server build, roster, result, and anti-cheat flags — sufficient to reconstruct the result without any client input, and to later evolve into replay tooling.
- Retention class and duration defined in `contracts/telemetry.md` and reviewed for privacy.

### P4.B Frontend — **[CX]**

**B1. End-of-match experience**
- Full scoreboard with the canonical stat set, mode-appropriate columns, round history for Bomb, personal performance summary, and progression changes — all read from the server result, never computed locally.
- Return-to-lobby with roster preserved, and a rematch path.

**B2. Career and history**
- Career screens switched from P1 stubs to live data. Match history with a detail view showing the authoritative record for that match.

**B3. Reconnect UX**
- A player who drops sees an honest reconnect state with a countdown against the actual grace period, a cancel option, and a correct outcome message when the window expires.

**B4. Network diagnostics**
- Expose the measured values the P5 quality contract will formalise: RTT, jitter, loss, correction/reconciliation rate, and snapshot health. Visible to the player and attachable to a bug report.

### P4 exit — **Gate G1 (Multiplayer Alpha)**

The roadmap's G1 in full. All must be true:

- [ ] A new player signs in, sees online players and joinable rooms, joins The Square, picks a team, greens up
- [ ] They complete a full **TDM** match with remote players
- [ ] They complete a full **Bomb** match with remote players
- [ ] They return to the lobby with the roster intact
- [ ] They reconnect successfully after a drop, where the rules allow it
- [ ] They sign back in later — different session, different device — and see accurate career and match statistics
- [ ] Stats are provably written exactly once under duplicate submission
- [ ] The result is reconstructable from server evidence alone

**Until G1 passes, mode breadth stays frozen. A failure here is a reason to fix, never a reason to add.**

---

## P5 — PUBLIC ALPHA READINESS (Gate G2)

**Goal:** turn a working multiplayer game into a public-ready multiplayer service. No new modes. No new gameplay scope. Hardening only.

**Duration:** 4–6 sprints.

### P5.A Networking quality contract — **[CC]**

Implement and measure every row of the roadmap's contract. Each becomes a threshold with a number, derived from Alpha data and then enforced in CI.

| Area | Implementation | Verification |
|---|---|---|
| Authority | Server authoritative for movement validation, damage, ammo, score, objectives, round state, results | A deliberately modified client cannot grant itself position, damage, ammo, score, or objective progress. Prove with an actual cheating client in the harness |
| Prediction & reconciliation | Bounded server reconciliation with observable correction metrics | Correction rate and magnitude are measured and reported, not hidden as rubber-banding |
| Interpolation & jitter | Explicit interpolation and jitter buffer strategy for remote players | Playtests remain readable across the latency/jitter/loss profiles |
| Lag compensation | Bounded server-side rewind for hitscan | High latency cannot produce unlimited rewind or a systematic advantage; bound is enforced and tested at the boundary |
| Reconnect & duplicate sessions | Grace period, replacement rules, per-mode state restoration | No corrupted round state, no duplicate identity |
| Backfill | TDM configurable; Bomb never mid-round | Room rules visible to players and enforced server-side |
| Protocol compatibility | Versioned protocol and rule set | Incompatible clients fail cleanly with an upgrade message |
| Test matrix | Automated RTT, jitter, loss, throttle, and brief-disconnect scenarios | `scripts/netmatrix.mjs` runs the full matrix on every release candidate and publishes playable/degraded/fail classifications |

### P5.B Server orchestration and capacity — **[CC]**

- **Regions:** explicit regions with real latency measurement, surfaced in the server browser. No single opaque global pool.
- **Allocation and autoscaling:** capacity tracked per region and per instance; scale up, drain, and fail without manual database edits.
- **Deploy draining:** instances scheduled for deploy stop receiving new matches; existing matches finish or follow an explicit maintenance policy.
- **Health and failover:** health checks distinguish lobby, realtime, database, and dependency failures. Unhealthy instances stop receiving players and alert operations.
- **Capacity telemetry:** CCU, rooms, matches, instance utilisation, bandwidth, queue/join failures, regional headroom — enough for operations to answer "can we admit more players safely?"

### P5.C Anti-cheat, abuse protection, evidence — **[CC]**

- Assume the browser client is inspectable and modifiable. Security comes from server authority, not obscurity.
- Server validation of movement deltas and speed, fire cadence, ammo and reload state, damage, health, team and objective transitions, impossible state changes, malformed messages, and message rates.
- API and realtime rate limits, schema validation on every message, authentication on every privileged channel, replay protection where needed, and DDoS/abuse controls at the edge.
- Suspicion and risk scoring with progressive review. **No single heuristic auto-bans permanently** — a roadmap requirement, and a good one.
- Sanction workflow: warn, mute, temporary restriction, ban, with appeal, evidence links, and full audit.
- Verification: `scripts/cheattest.mjs` — a suite of hostile clients, each attempting one documented exploit class, each expected to be rejected and flagged.

### P5.D Account security, privacy, player safety — **[CC]** backend, **[CX]** surfaces

| Area | **[CC]** | **[CX]** |
|---|---|---|
| Sessions | Refresh/expiry, device list, logout-all, immediate revocation | Session management screen, revocation UX |
| Recovery | Verified recovery path, display-name policy, impersonation rules | Recovery flow, name-change UX with policy feedback |
| Wallet linking boundary | Signed proof on link/unlink, audited high-risk changes *(boundary only in P5; implementation in P8)* | Placeholder surface only |
| Privacy lifecycle | Data minimisation, purpose/consent records, retention, access/export, deletion, incident process | Consent screens, data export request, deletion request, privacy settings |
| Age architecture | Age/eligibility policy enforced before sensitive data collection; cash-equivalent XO prize rules kept separately restricted | Age gate UX appropriate to the policy |
| Reports & moderation | Report intake, sanction history, appeals, evidence links, moderator tooling | In-game report flow, mute/block, report status |
| Communications | Text chat and pings hardened. **Voice deferred** until moderation and privacy support it | Chat/ping UX, mute lists |

The roadmap's Canadian privacy note applies: children under 13 generally cannot provide valid consent on their own, and the exact age/consent/parental-control model must be reviewed for the jurisdictions actually served. **[HUMAN]** + legal own that decision; both lanes implement whatever it produces.

### P5.E First-session UX and accessibility — **[CX]**

- Implement the complete first-run path from `first-run-flow.md` end to end, with no developer assistance required at any step.
- Optional low-friction firing range or short controls tutorial — **not** a blocker to play.
- Full FPS control expectations shipped: sensitivity, ADS sensitivity, FOV, rebinding, audio, crosshair, HUD, and clear network/error messaging.
- Accessibility: team and objective indicators that never rely on colour alone, readable text sizing, subtitles where used, reduced camera shake and motion options.
- Supported-browser gate: unsupported clients fail clearly and early with an explanation, rather than rendering a broken scene.
- KPIs instrumented and reported: first-match completion, time-to-first-match, lobby abandonment, connection failures, settings friction.

### P5.F QA, release engineering, disaster recovery — **[CC]** owns, **[CX]** contributes browser matrix

| Area | Minimum system | Readiness test |
|---|---|---|
| CI quality gate | Existing harness suite plus the new platform/auth/lobby/bomb/reconnect/cheat tests on every releasable build | A failed critical test blocks promotion — mechanically, not by convention |
| Network simulation | Automated latency, jitter, loss, throttling, reconnect, duplicate-message, out-of-order scenarios | Known failure cases reproduce before production |
| Load & soak | Concurrent room/match joins, sustained matches, presence churn, result writes, telemetry load | Target concurrency runs for hours without unacceptable error, memory, or latency growth |
| Browser/device matrix **[CX]** | Defined supported desktop browsers/OS; WebGL, input, and network behaviour tested | Unsupported clients fail clearly; supported clients are regression-tested |
| Staging & migrations | Production-like staging, versioned migrations, backwards-compatible rollout | A schema change is rehearsed before production |
| Deploy & rollback | Versioned artifacts, health-gated deploy, draining, fast rollback, feature flags | A bad release is contained without editing player data |
| Backups & restore | Automated backups, documented restore, RPO/RTO targets | **A restore drill is performed and its result recorded.** Backups that have never been restored are not backups |
| Incident runbooks | Severity levels, ownership, alert routing, player comms, kill switches, post-incident review | The team can rehearse an auth outage, a lobby outage, and a database failure |

### P5.G Operations tooling — **[CC]** backend, **[CX]** Admin Portal frontend

- **[CC]**: Admin API — player lookup, unified player timeline, match lookup, session revocation, sanction application, feature-flag and kill-switch control, all RBAC-scoped, reason-coded, and audited.
- **[CX]**: `web/admin/**` — read-heavy Command Center v0: live game view (players online, active matches, server health, incident banner, flag state), player/support timeline, moderation queues, and tightly scoped mutations behind explicit confirmation.
- Support must be able to reconstruct what happened to a player **without querying raw production tables**. That is the acceptance test.

### P5 exit — **Gate G2 (Public Alpha Readiness)**

Every roadmap gate row must be true:

- [ ] **Gameplay/network:** authoritative TDM and Bomb on The Square pass the defined latency/loss/reconnect tests with accurate results
- [ ] **Capacity:** regional orchestration with capacity telemetry, health checks, draining, and load/soak evidence
- [ ] **Security/anti-cheat:** server validation, rate limits, reports, match evidence, sanctions, abuse monitoring all operational
- [ ] **Identity/privacy:** recovery, revocation, privacy lifecycle, age policy, deletion/export, wallet-link controls defined and tested
- [ ] **Operations:** logs/traces/alerts, Admin Portal lookup, runbooks, kill switches, support reconstruction work end to end
- [ ] **Release/recovery:** staging, migrations, rollback, backups, **restore drill exercised**, deploy procedure rehearsed
- [ ] **UX:** a new player reaches and completes a first match unaided, on a supported browser, with accessibility basics in place

**Gate rule, verbatim from the roadmap:** Public Alpha is a readiness decision, not a date. If a critical control fails, keep the test population limited while fixing it rather than widening access.
---

## P6 — EXTRACTION ALPHA (Gate G3)

**Entry: G2 has passed.** Not before. Extraction reuses the proven networking, identity, presence, results, anti-cheat, orchestration, and observability foundations rather than rebuilding them.

**Duration:** 6–9 sprints, split into a vertical slice then an expansion.

### P6.1 Vertical slice first

Build the thinnest complete loop on a graybox world before any art: prepare → deploy → loot → fight → die or extract → settle. If the settlement is wrong, no amount of map quality saves it.

### P6.A Backend — **[CC]**

| Area | Work |
|---|---|
| Run model | Run state distinct from permanent inventory. A run has an ID, a roster, a start snapshot, and a terminal outcome: extracted, died, disconnected, aborted |
| Inventory service | Permanent inventory, loadouts, durability, attachments, run locks. Fast reads; never blocked on wallet latency |
| Deployment | Lock selected inventory, snapshot ownership, validate equipment server-side, create authoritative run state |
| Loot | Loot tables by POI, container, event, difficulty, rarity. Run inventory recorded separately from permanent inventory. **Normal raids do not distribute XO at launch** |
| Death | Loss rules applied server-side; eligible run inventory transferred or dropped |
| Extraction | Variable/conditional exits with rules; validation that the player was genuinely in a valid exit under valid conditions |
| Settlement | Idempotent, transactional, event-emitting. A retry never duplicates loot. Reuses the P4 idempotency machinery |
| Sector streaming | Server-side interest management and relevance zones so a large world does not broadcast everything to everyone |
| AI populations | Activated by sector and difficulty profile |
| Anti-cheat | Extraction-specific validation: impossible loot acquisition, teleport-to-exit, inventory desync, extraction without presence |

**Verification:** `scripts/extracttest.mjs` — every terminal outcome settles correctly; duplicate settlement is a no-op; a killed player loses exactly what the rules say; a disconnect mid-run resolves deterministically; loot tables produce the intended distributions over a large sample.

### P6.B Frontend — **[CX]**

| Area | Work |
|---|---|
| Extraction world | Large map: one cohesive playspace, sectors, 6–10 named POIs, micro-zones, extraction points, dynamic event locations |
| The Square as POI | Remove the competitive boundary layer; embed the same district in the world. This is why P3.B1 built the boundary as removable |
| Loadout & inventory UI | Pre-run loadout, inventory management, item detail, durability, insurance surfaces |
| In-run HUD | Run timer, extraction markers and states, carried-value awareness, threat feedback, sector transitions |
| Death & extraction screens | What was lost, what was kept, what settled — presented from the server's settlement record |
| Post-run | Repair, upgrade, redeploy loop entry points |

### P6 exit — Gate G3

- [ ] A player selects a loadout, deploys, loots, fights, dies or extracts, and receives correct persistent inventory outcomes
- [ ] Settlement is idempotent under deliberate duplicate submission
- [ ] The Square functions as both the competitive map and an extraction POI from one source of geometry

---

## P7 — AGENT PLATFORM v0 (Gate G4)

**Entry:** stable inventory, loadout, and deployment APIs.

### P7.A Backend — **[CC]**

- **Agent Gateway:** authentication, capability scoping, budgets, cooldowns, validation, audit. The gateway decides what is allowed **regardless of what the model claims** — model reasoning context is separated from authorization.
- **Tool surface** per the roadmap: inventory read/inspect/equip, market get-prices/buy/sell, upgrades repair/craft, deployment queue/deploy/set-risk-profile, creator create/list/manage, wallet balance/approve-budget/claim.
- **Policy engine:** per-agent permissions (read-only → full delegated), XO limits per transaction/day/strategy/category, protected-item flags, risk profiles, human approval gates above value thresholds, instant revoke.
- **Credential handling:** prefer provider OAuth or scoped tokens; if users supply model API keys, encrypt at rest, restrict service access, never expose to the client, and provide immediate revoke/delete.
- **Idempotency and cancellation** on every value-changing action. A retry must not duplicate a purchase, listing, transfer, upgrade, or deployment.
- **Prompt-injection containment:** marketplace descriptions, creator metadata, chat, item names, and any player-controlled text are untrusted. No text from game content can grant tools, permissions, budget, or secrets.
- **Audit:** provider/model, policy version, tool request, validation result, approval, cost, transaction IDs, outcome — without retaining unnecessary sensitive prompt content indefinitely.
- **Cost limits independent of economic limits:** request, token/compute, transaction, and daily spend budgets are separate controls.

**Verification:** `scripts/agenttest.mjs` — permission escalation attempts fail; budget caps hold under concurrency; injected instructions in item names and chat cannot expand scope; retries do not duplicate; revoke takes effect immediately mid-flight.

### P7.B Frontend — **[CX]**

- **Agent Center:** connect a model provider, choose a permission preset, configure budgets, set risk profile, flag protected items, and view the complete action history with reasons and outcomes.
- **Approval queue:** pending high-value actions with enough context to approve or reject confidently.
- **Emergency revoke** reachable in one action from anywhere in the agent UI.

### P7 exit — Gate G4

- [ ] A connected LLM inspects inventory, configures a loadout, applies policies, and queues an operator **without bypassing permissions**
- [ ] Every delegated action is attributable to player, agent, model, policy version, and resulting transaction

---

## P8 — XO COMMERCE AND WALLETS (Gate G5)

**Entry:** ledger design complete, legal/compliance discovery done. **[HUMAN]** + legal gate this phase.

### P8.A Backend — **[CC]**

- **Financial ledger:** double-entry concepts, immutable rows, durable transaction IDs, asset, amount, business reason, actor, status, timestamps, linked item/order/prize IDs, and external wallet/chain references. **No direct balance mutation ever** — corrections are compensating entries with actor, reason, approval, and audit.
- **Separation of concerns** exactly as the roadmap specifies: match server never waits on chain confirmation; inventory service never depends on wallet latency for reads; the XO ledger is not a player deposit account and does not expose unrestricted spend authority to agents.
- **Wallet boundary:** prefer player-controlled Exodus wallets and approved payment/payout rails over Overstrike custody. Signed proof on link/unlink; audited high-risk changes; a compromised game session cannot silently replace a wallet.
- **Reconciliation:** automated, with human review of exceptions before value-equivalent release. Accounting exports and period-close support.
- **Tax and invoicing:** sponsor invoices, creator payout statements, purchase receipts, refunds/credits, settlement references, fair-market-value and exchange-rate inputs with source timestamps, GST/HST modelled as explicit order fields rather than buried in item pricing.
- **Fraud/risk:** multi-accounting, farming, bot abuse, collusion, market manipulation, suspicious transfers, payout holds. Detection and holds exist **before** meaningful XO rewards, not after.

### P8.B Frontend — **[CX]**

- Wallet linking UX with signed-proof flow and clear risk messaging; purchase flow; transaction history; receipts; payout status; budget and spend visibility.
- Commerce surfaces that never block gameplay on a settlement call.

### P8 exit — Gate G5

- [ ] Purchases, fees, and wallet-linked transaction records reconcile reliably outside the match
- [ ] Overstrike is not acting as an unnecessary custodial balance provider
- [ ] **Ordinary gameplay remains non-cash**

---

## P9 — OWNED ASSETS AND MARKETPLACE (Gate G6)

### P9.A Backend — **[CC]**
- Item registry with one stable item ID spanning gameplay and ownership. Identity, ownership, gameplay, history, and market data classes per the roadmap's item identity model.
- Blockchain registry integration for verifiable ownership, transfers, provenance, and scarcity — **indexed into a game mirror**, never queried in the match loop.
- Marketplace: listings, bids, history, royalties, fees, atomic settlement. The marketplace never modifies match state directly.
- Post-sale recall capability: provenance preserved while rendering/use can be disabled, with a defined refund/substitution policy.

### P9.B Frontend — **[CX]**
- Marketplace UI: browse, item detail with provenance and history, list, buy, sell, price history, royalty disclosure.
- Item inspection showing the story of an item — kills, extractions, tournament use, ownership lineage.

### P9 exit — Gate G6
- [ ] Selected guns and apparel have stable digital identities, provenance, and tradeable ownership mapping
- [ ] Marketplace settlement is atomic and reconciled

---

## P10 — CREATOR PORTAL (Gate G7)

### P10.A Backend — **[CC]**
- Submission pipeline: fee capture, submission record, automated validation (file, dimensions, texture/material, polygon, animation, shader, memory, performance budgets), quarantine before assets reach production clients, moderation with reason codes, appeal, and audit trail.
- Rights declaration capture, IP complaint/takedown workflow with evidence preservation, versioning where material changes create a new reviewed asset rather than silently mutating a sold item.
- Creator settlement: revenue share, royalties, payables, payout statements, and fraud/payout-hold integration.
- Cosmetic safety rules enforced server-side: silhouette, team readability, hitbox, animation, material/visibility, audio, and performance constraints, so a paid item can never hide a player or produce deceptive combat cues.
- If functional creator items are ever enabled: constrained archetypes with a power budget, plus an AI/simulation balance reviewer scoring a proposal against its class before moderation. **[HUMAN]** approves any move in this direction.

### P10.B Frontend — **[CX]**
- `web/creator/**`: template selection, upload/design, live 3D preview with the real in-game shading, metadata and edition configuration, fee payment, validation results, moderation dialogue, publishing, and earnings analytics.

### P10 exit — Gate G7
- [ ] A creator spends XO, submits a valid cosmetic, passes moderation, publishes, and earns from a purchase
- [ ] No published cosmetic can affect competitive readability or combat outcome

---

## P11 — SPONSORSHIPS AND PRIZE RESERVE (Gate G8)

### P11.A Backend — **[CC]**
- Sponsor inventory as timed leases against the anchors reserved in P3.B1: storefront, wall/billboard, rooftop, event sponsor, district presenting sponsor. Leases, not permanent ownership of map geometry, so the world can be rebalanced.
- Impression methodology: a placement counts only when genuinely viewable — rendered, in frustum, sufficient size/visibility, minimum exposure time. Unique/repeat frequency reported without exposing unnecessary personal data.
- Fraud filtering excluding bots, test accounts, duplicate telemetry, and impossible view patterns from billable metrics.
- Campaign identity on every placement: campaign, creative, slot, map, start/end, pricing. Connects telemetry to contracts and invoices.
- **10% Prize Reserve accounting:** qualifying-revenue rule defined contractually, earmarked in the ledger, publicly visible where useful, with **no automatic on-match payout**. Distribution only through approved programs with published rules, eligibility, and payout controls.
- Make-good and refund handling for outages, underdelivery, and rejected creative.

### P11.B Frontend — **[CX]**
- In-world placement rendering that respects competitive readability and performance budgets.
- Sponsor-facing reporting surfaces and the public Prize Reserve display.

### P11 exit — Gate G8
- [ ] The Square has controlled sponsor and creator inventory
- [ ] 10% Prize Reserve accounting is auditable
- [ ] Normal gameplay remains non-cash
- [ ] Any XO prize program launches only under approved rules and payout controls — **[HUMAN]** + legal sign-off required

### P11 launch staging — **[HUMAN]** owns, both lanes implement

The roadmap's three-stage model is binding: **Stage 1 commerce first** (wallet linking, creator purchases, cosmetics, creation fees, storefront leases, sponsor campaigns; reserve accumulates but does not pay out) → **Stage 2 vetted skill competitions** (free entry, fixed disclosed prizes, published rules, strong anti-cheat) → **Stage 3 controlled expansion** (ladders, creator contests, community events), each added only after jurisdiction, chance/skill, KYC, tax, age, anti-fraud, and payout review.

Ontario-safe guardrails carry through unchanged: no paid-entry or player-staked XO competitions at launch; no random XO loot or per-kill XO in ordinary matchmaking; ordinary Extraction rewards stay items/XP/OP/resources in Stage 1; 18+ for cash-equivalent prizes initially; standardised competitive loadouts where practical so purchased assets never determine prize outcomes.

---

## PART 4 — CROSS-CUTTING WORKSTREAMS

These run continuously rather than as phases. Both lanes contribute; ownership is per item.

### 4.1 Platform foundation — **[CC]**
Canonical event schema and versioning, correlation strategy, structured logging, tracing, feature flags, remote config, jobs framework with idempotency/retry/dead-letter, secrets management, and the audit model. Established in P1; extended by every phase that follows. **A feature is not done until its events exist.**

### 4.2 Data and metrics — **[CC]** pipeline, **[BOTH]** definitions
KPI dictionary with versioned definitions so both lanes and the human owner use the same numbers. Warehouse pipeline after the multiplayer event stream is producing trustworthy data — not before. Gameplay analytics (heatmaps, kill/death density, route usage, site outcomes, round length, weapon range, spawn quality) feed CX's map iteration directly.

### 4.3 Unit economics — **[CC]** instrumentation, **[HUMAN]** decisions
Cost per concurrent player, match-server cost/hour, rooms per instance, bandwidth per player-minute, regional utilisation, telemetry and retention costs, model cost per agent action, moderation cost per submission, sponsor gross margin, marketplace take rate. These set pricing, free-tier limits, retention windows, agent quotas, and regional scaling.

### 4.4 Competitive integrity policy — **[CC]** enforcement, **[HUMAN]** policy
Written before any monetisation ships and enforced server-side: TDM and Bomb outcomes never depend on purchased combat power; the server, not the client or wallet, decides which item attributes are active in a ruleset; prize-bearing events use server-enforced rules and standardised functional loadouts where practical; creator cosmetics respect silhouette, readability, hitbox, animation, visibility, audio, and performance constraints.

### 4.5 Legal and compliance — **[HUMAN]**
The Ontario review package covering XO flows, age/eligibility, privacy, competition rules, creator payouts, marketplace transfers, taxes, sponsor reserve accounting, and payout controls. Reference points: Criminal Code s.206, Competition Bureau promotional contest guidance, FINTRAC MSB guidance for virtual-currency exchange/transfer, AGCO skill-vs-lottery materials, OPC privacy/consent guidance, CRA crypto-asset GST/HST and tax obligations. Both lanes implement whatever this produces; neither lane makes a compliance judgement call on its own.

---

## PART 5 — VERIFICATION STRATEGY

### 5.1 The existing culture is the right one

This repository already rejects unit tests in favour of booting the real build headless and asserting measured numbers. That decision holds and extends. New harnesses follow the same rules:

1. **Assert numbers, not absence of exceptions.** A harness that can pass while proving nothing is a defect. This has already happened in this repository — a ground check that asserted nothing, a map probe that tested its own parapet. Every new harness must be shown to fail when the thing it guards is deliberately broken.
2. **Prove the negative case.** For every "X works" assertion, add the control case that must fail.
3. **Idempotency is tested by deliberate duplication**, never by reading the code.
4. **Security is tested by a hostile client**, never by inspecting the validator.

### 5.2 Harness ownership

| Suite | Command | Owner |
|---|---|---|
| Static + sim + TDM + map + collision + stair + headless + net + ws + feedback + server | `npm run ci` | **[CC]** |
| Browser: determinism, present, smoke, mp, combat | `npm run ci:browser` | **[CC]** with **[CX]** for present/smoke assertions |
| Bomb ruleset | `scripts/bombtest.mjs` | **[CC]** |
| Auth, profile, lobby, presence, reconnect, events, audit, platform | `scripts/*test.mjs` | **[CC]** |
| Cheat suite | `scripts/cheattest.mjs` | **[CC]** |
| Network matrix | `scripts/netmatrix.mjs` | **[CC]** |
| Map guards | maptest, collisiontest, stairtest, vertprobe, mapbalance, geomtest | **[CC]** authored, **[CX]** run before every geometry push |
| UI shell, screens, states | `scripts/uishell.mjs` | **[CX]** |
| Visual regression | `scripts/beauty.mjs`, screenshot comparison | **[CX]** |
| Accessibility | contrast, colour-independence, rebinding coverage | **[CX]** |
| Load and soak | **[CC]** | **[CC]** |

### 5.3 CI promotion rules
- A failing critical test blocks promotion mechanically. No override path that a lane can use unilaterally.
- The cross-lane path guard (P0.4) runs on every PR.
- Any PR touching `src/net/protocol.js` must bump `PROTOCOL_VERSION`.
- Any PR touching `src/world/level.js` or `props.js` must include a fresh nav bake and pass all map guards.
- Headless Chromium rasterises through SwiftShader, so **reported frame rate is meaningless**. The numbers that matter are CPU simulation cost per fixed step, draw calls, triangles, and heap growth. Do not let a lane claim a performance result from a frame rate in CI.

---

## PART 6 — RISK REGISTER

### 6.1 Program risks

| # | Risk | Impact | Mitigation | Owner |
|---|---|---|---|---|
| R1 | Scope creep back into extra modes before G1 | Delays the only proof that matters | `modes.js` freeze enforced by `tdmtest`/`bombtest` asserting the mode table contains exactly two entries | **[CC]** |
| R2 | The Square becomes the schedule | G1 slips indefinitely | P3 runs parallel from day one; graybox stub level lets Bomb be built before art exists | **[BOTH]** |
| R3 | Two lanes edit the same file | Merge pain, lost work, silent regressions | Single-writer ownership map plus a mechanical CI path guard | **[CC]** |
| R4 | Codex blocked waiting on backend | Half the team idles | Stubs are scheduled deliverables in every phase, not favours | **[CC]** |
| R5 | Claude Code builds APIs the UI cannot use | Rework | Codex must sign off contract sufficiency before `FROZEN` | **[CX]** |
| R6 | Harnesses that pass while asserting nothing | False confidence — already happened here | Every harness must be demonstrated to fail against a deliberately broken build | **[CC]** |
| R7 | Progression migration loses player data | Trust damage | Import path with unverified flag, dual-read window, no destructive local wipe | **[CC]** |
| R8 | Geometry change silently breaks nav or collision | Unplayable map shipped | Map guards mandatory on every geometry PR; nav bake committed with the change | **[BOTH]** |

### 6.2 Systems that must have a kill switch before their phase ships

Trading, XO spend, payouts, agent deployment, agent spend, creator publishing, sponsor campaign activation, prize programs, marketplace settlement, wallet linking, chat, and backfill. Each independently disableable, each tested off-and-on, each listed in `contracts/feature-flags.md`.

### 6.3 Technical risks

| # | Risk | Mitigation |
|---|---|---|
| T1 | Platform call leaks into the fixed tick | Architectural review plus a CI check that `platform/` is not importable from `src/core`, `src/game`, `src/player`, or `src/weapons` |
| T2 | Client-authoritative state creeps back in | Cheat suite grows a case for every new player-affecting field |
| T3 | Duplicate stat/loot/XO awards | Idempotency keys from P1; duplicate-submission tests mandatory for every value-bearing path |
| T4 | Protocol drift between client and server | Version bump enforced in CI; handshake rejects mismatches cleanly |
| T5 | Regional latency measured badly, so the browser lies | Real measurement, labelled, with the methodology documented |
| T6 | Prompt injection through player-controlled text (P7+) | Authorization decided by the gateway, never by model output; injection cases in `agenttest.mjs` |

---

## PART 7 — OPERATING CADENCE

| Ritual | Frequency | Participants | Output |
|---|---|---|---|
| Status refresh | Every working session | Each lane, separately | `docs/status/<lane>.md` updated: done, in progress, blocked, requests open |
| Request sweep | Daily | Each lane reads the other's request file | Status lines updated; blocking requests answered same day |
| Contract review | Per contract, before `FROZEN` | **[BOTH]** + **[HUMAN]** | Signed-off contract |
| Integration handshake | At each `H<n>.<n>` point | **[BOTH]** | Joint test run and a written result |
| Gate review | At each G-gate | **[BOTH]** + **[HUMAN]** | Explicit pass/fail against the checklist, recorded with a date |
| Playtest | Weekly from P3 | **[HUMAN]** + both lanes | Recorded observations plus `mapbalance` evidence |

**Blocking-request SLA:** a request marked `Blocking: yes` gets a status change within one working session. If it cannot be satisfied, the receiving lane proposes a workaround in the same response so the requesting lane never sits idle.

---

## APPENDIX A — KEY CONTRACT SKELETONS

These are the shapes both lanes build against. Full detail lives in `docs/contracts/`; these skeletons exist so neither lane has to wait for the full document to start reasoning.

### A.1 Net facade — the only surface Codex uses to reach netcode

Owned by **[CC]** in `src/net/`. Codex never imports anything else from `src/net/`.

```js
// Connection lifecycle
netFacade.connect({ roomId, sessionToken })   // -> Promise<void>, rejects with a typed error
netFacade.disconnect(reason)
netFacade.state                                // 'idle'|'connecting'|'live'|'reconnecting'|'closed'|'version-mismatch'

// Outbound intent (never authority)
netFacade.sendLoadout({ primary, secondary })
netFacade.requestInteraction(kind)             // plant, defuse, pickup — a request, not a result

// Inbound, read-only views for rendering
netFacade.localEntity                          // predicted local state
netFacade.remoteEntities                       // interpolated
netFacade.matchState                           // phase, score, round, timers, alive counts, objective state
netFacade.netStats                             // rtt, jitter, loss, correctionRate, snapshotAge

// Events for the UI
netFacade.on('welcome' | 'snapshot' | 'event' | 'matchState' | 'disconnected' | 'versionMismatch', fn)
```

**Rule:** every field above is server-derived or explicitly labelled as prediction. The UI renders it; it never decides it.

### A.2 Platform HTTP shape

```
POST   /v1/auth/signup | /signin | /refresh | /signout | /signout-all
GET    /v1/auth/sessions            DELETE /v1/auth/sessions/:id
GET    /v1/profile/me               PATCH  /v1/profile/me
GET    /v1/profile/:id/stats        GET    /v1/profile/:id/matches
GET    /v1/presence/online
GET    /v1/rooms                    POST   /v1/rooms/:id/join | /leave | /team | /ready
GET    /v1/matches/:matchId
POST   /v1/reports
GET    /v1/config/flags
```

Every response carries `correlationId`. Every error follows `contracts/errors.md`. Every non-idempotent POST accepts an `Idempotency-Key` header.

### A.3 Match result record

```json
{
  "matchId": "…", "rulesetVersion": "…", "serverBuild": "…", "mapVersion": "…",
  "region": "…", "mode": "tdm|bomb",
  "startedAt": "…", "endedAt": "…", "terminationReason": "completed|aborted|invalidated",
  "roster": [{ "accountId": "…", "team": "alpha|bravo", "joinedAt": "…", "leftAt": null }],
  "teamScores": { "alpha": 0, "bravo": 0 },
  "rounds": [{ "index": 0, "winner": "alpha", "reason": "elimination|defuse|detonation|timer" }],
  "players": [{
    "accountId": "…", "kills": 0, "deaths": 0, "assists": 0, "suicides": 0, "teamKills": 0,
    "shots": 0, "hits": 0, "headshots": 0, "damageDealt": 0, "plants": 0, "defuses": 0,
    "roundsPlayed": 0, "timePlayedSec": 0, "disconnected": false, "abandoned": false,
    "weapons": { "<weaponId>": { "shots": 0, "hits": 0, "kills": 0 } }
  }],
  "evidenceRef": "…"
}
```

Stat definitions are canonical and versioned. Changing a definition is a breaking contract change requiring a CCR.

### A.4 Canonical event envelope

```json
{
  "eventId": "uuid", "type": "match.completed", "version": 1,
  "occurredAt": "ISO-8601", "correlationId": "…", "causationId": "…",
  "actor": { "kind": "player|service|admin|agent", "id": "…", "role": "…" },
  "subject": { "kind": "match|account|item|room|campaign", "id": "…" },
  "payload": { },
  "privacyClass": "public|internal|personal|sensitive",
  "retentionClass": "short|standard|audit|financial"
}
```

Initial domains and examples follow the roadmap: gameplay (`match.started`, `player.killed`, `objective.planted`, `objective.defused`, `match.completed`), economy (`item.created`, `market.sale.completed`, `prize.reserve.credited`), creator/sponsor (`creator.item.submitted`, `storefront.leased`, `sponsor.impression.recorded`), agents/admin (`agent.action.requested`, `admin.action.executed`, `sanction.applied`, `config.changed`).

---

## APPENDIX B — QUICK REFERENCE FOR EACH LANE

### B.1 Claude Code — start here

1. Read `ARCHITECTURE.md`. It is binding.
2. Your territory is Section 1.4, `[CC]` rows only. Never write outside it.
3. Your first job every phase is the **contracts**, your second is the **stubs** that unblock Codex, your third is the real implementation.
4. Read `docs/handoff/requests-to-backend.md` at the start of every session. Answer blocking requests first.
5. Write your status to `docs/status/backend.md` at the end of every session.
6. Never ship a feature without its verification harness, its canonical events, and its feature flag.
7. Assume the client is hostile. Server authority, not obscurity.

### B.2 Codex — start here

1. Read `ARCHITECTURE.md` and `docs/contracts/net-facade.md`. You talk to netcode through the facade and nothing else.
2. Your territory is Section 1.4, `[CX]` rows only. Never write outside it.
3. Build against stubs. If a stub does not exist, file a request — do not build the backend yourself.
4. Before every geometry push, run the map guards and commit the nav bake output.
5. Read `docs/handoff/requests-to-frontend.md` at the start of every session.
6. Write your status to `docs/status/frontend.md` at the end of every session.
7. Never encode a rule the server owns. Display what the server says, including when it says no.

### B.3 The five things that break a two-lane build

1. Writing a file you do not own — even a one-character fix.
2. Building against a contract that is not `FROZEN`.
3. Shipping a backend change without a stub the other lane can use.
4. Changing a stat definition, a wire field, or an error code without a CCR.
5. Marking a task done when its harness, events, or flag do not exist.

---

## APPENDIX C — GATE SUMMARY

| Gate | Name | Phase | One-line definition of done |
|---|---|---|---|
| **G0A** | Contract freeze | P0 | Every interface both lanes need exists and is frozen |
| **G0** | Operational foundation | P1 | Durable identity, canonical events, audit, observability, server-authoritative stats |
| **G1** | Multiplayer Alpha | P4 | Sign in → presence → browse → join → team → green up → TDM **and** Bomb on The Square → results → return → accurate persistent stats |
| **G2** | Public Alpha readiness | P5 | Networking, capacity, anti-cheat, privacy, operations, release/recovery, and UX all pass the readiness gate |
| **G3** | Extraction vertical slice | P6 | Deploy → loot → fight → die or extract → correct persistent settlement |
| **G4** | Agent delegation | P7 | An LLM manages inventory, loadout, policy, and deployment without bypassing permissions |
| **G5** | XO settlement | P8 | Commerce reconciles outside the match without unnecessary custody |
| **G6** | Owned assets | P9 | Stable identities, provenance, atomic marketplace settlement |
| **G7** | Creator launch | P10 | Spend XO → submit → moderate → publish → earn |
| **G8** | Safe commercial launch | P11 | Sponsor inventory, auditable 10% Prize Reserve, non-cash ordinary play, approved prize rules only |

---

## CLOSING RULE

The roadmap's definition of success governs every decision in this plan:

> **Overstrike should feel like a great FPS even if a player ignores the economy, wallet, NFTs, creators, and agents.** Those systems should deepen ownership, persistence, automation, and community rather than compensate for weak gameplay.

If a phase in this plan is ever in tension with that sentence, the sentence wins.
