> # ⚠️ SUPERSEDED — do not build from this document
>
> **Replaced by:** `Overstrike_Platform_Build_Plan.md` / `.docx` (plan version 2.0), which
> tracks the current `Overstrike_Platform_Roadmap.docx`.
>
> **Why it was replaced:** this plan sequences the Extraction vertical slice (its P3) *before*
> the multiplayer proof is complete. The current roadmap inverts that order — Multiplayer
> Alpha (TDM + Bomb on The Square) → Public Alpha Readiness → Extraction — and freezes mode
> breadth until G1 and G2 pass. Building from the order below would start Extraction several
> phases early.
>
> It also assumes a third OpenCode lane, which the current plan does not use.
>
> Retained for its architecture and non-negotiable-rules sections, which v2.0 carries forward
> largely intact. Superseded 2026-08-19 during P0.

# OVERSTRIKE Platform Build Plan

**Source:** `Overstrike_Platform_Roadmap(2).docx`  
**Plan version:** 1.0 — **SUPERSEDED by 2.0**  
**Prepared:** August 19, 2026  
**Planning basis:** One primary Claude Code lane, one primary Codex lane, and one OpenCode lane working in parallel, with human product, design, security, finance, and legal approvals at the named gates.

## 1. Executive build decision

Overstrike should be built in this order:

1. Freeze the Extraction Alpha rules and shared contracts.
2. Add identity, durable persistence, canonical events, auditability, and basic operations.
3. Production-harden the existing authoritative multiplayer loop.
4. Build a thin end-to-end extraction vertical slice on a graybox map.
5. Expand that slice into The Square and the first polished extraction world.
6. Expose the proven inventory and deployment actions through a safe Agent API.
7. Add the XO ledger and wallet/payment boundary, launching commerce before prizes.
8. Add verifiable asset ownership and the marketplace.
9. Add the Creator Portal and creator settlement.
10. Activate sponsorships, the Prize Reserve, and only then approved prize competitions.

This order keeps blockchain, wallets, LLMs, and financial settlement outside the real-time match loop. It also prevents the team from building agent tools, marketplace flows, or creator workflows against inventory and transaction models that are still changing.

### Delivery ownership

| Owner | Primary responsibility | Examples |
|---|---|---|
| **Claude Code** | Complex backend, authoritative simulation, security, persistence, financial correctness, integrations | Match lifecycle, inventory settlement, service APIs, database schemas, event outbox, Agent Gateway, policy engine, ledger, wallet reconciliation, marketplace transactions, fraud controls |
| **Codex** | Frontend and client-side game experience | Three.js world and The Square, client streaming, loadout and inventory UI, extraction HUD, Agent Center, wallet UX, marketplace, Creator Portal, admin and sponsor interfaces |
| **OpenCode** | Minor, bounded, low-risk work after contracts are stable | Static config, seed data, copy, icons, fixtures, simple validators, test matrices, API examples, documentation, straightforward regression scripts |
| **Human owner** | Product decisions and approvals that cannot safely be delegated | Economy rules, art direction, balance sign-off, security review, provider selection, legal/compliance approval, financial policy, go/no-go decisions |

OpenCode must not own authentication, authorization, authoritative match outcomes, inventory settlement, XO accounting, wallet signing, marketplace settlement, prize eligibility, or other security/value-bearing logic.

## 2. Verified starting point

The current repository is not a blank prototype. It already contains approximately 39,000 lines of JavaScript across 53 modules and has:

- A browser-native Three.js FPS with procedural assets, no external game assets, and a Vite client.
- A Node/WebSocket dedicated server using the same deterministic game simulation.
- Authoritative server movement/combat outcomes, client prediction and reconciliation, snapshot replication, lag compensation, reconnect-era protocol foundations, and remote avatars.
- Ten weapons, bots, progression, and five modes: TDM, FFA, Gun Game, Domination, and Kill Confirmed.
- One current map, Meridian, with navigation, interiors, rooftops, collision, and spawn tooling.
- Extensive simulation, networking, browser, combat, map, and performance harnesses.

The current static check passes, and the loopback network test passes prediction, loss, latency, snapshot, multi-client, and lag-compensation scenarios. The real-WebSocket test could not bind a local port in the restricted planning environment; that is an environment limitation, not evidence of a product failure.

The main platform gaps are equally important:

- Progression is stored in browser `localStorage`; there is no durable player account service.
- There is no production database, account authentication, matchmaking/orchestration service, or persistent inventory service.
- There is no extraction run model, run inventory, death-loss transaction, or idempotent post-match settlement.
- There is no canonical cross-service event envelope, durable event stream/outbox, RBAC, audit service, or operations portal.
- There is no Agent Gateway, XO ledger, wallet integration, blockchain registry, marketplace, Creator Portal, sponsorship service, Prize Reserve implementation, or financial reconciliation system.

### Architecture decision

Do not begin with many independently deployed microservices. Keep the dedicated match server separate, then build the platform control plane as a **modular Node service backed by PostgreSQL**, with strict domain modules and versioned contracts. Use an outbox/event-consumer pattern so high-scale domains can be extracted later without rewriting behavior.

Initial deployable boundaries:

| Boundary | Owns |
|---|---|
| Browser client | Rendering, input, menus, UX, local prediction, presentation-only state |
| Match server | Combat truth, world/run state, loot during a raid, death, extraction validation, match result |
| Platform API/control plane | Accounts, progression, permanent inventory, loadouts, missions, agent policies, creator workflow, marketplace orchestration, admin commands |
| PostgreSQL | Durable game state, immutable ledger entries, outbox events, audit records, idempotency keys |
| Worker process | Settlement, reconciliation, royalties, lease expiry, notifications, fraud scans, retry/dead-letter handling |
| External providers | Player-controlled wallet, approved payment/payout rail, chain settlement, identity/KYC where required |

Redis, a warehouse, and dedicated queues should be introduced when measured load or job isolation requires them, not as Phase 0 prerequisites.

## 3. Non-negotiable system rules

1. **The match server is authoritative.** The client never decides damage, loot ownership, death, extraction success, or the settlement result.
2. **The chain is never in the game loop.** Deployment consumes a validated inventory snapshot; settlement occurs after the raid.
3. **Every value-bearing command is idempotent.** Retries cannot duplicate loot, XO, creator revenue, refunds, prizes, or transfers.
4. **XO is treated as transferable value.** No direct balance edits; corrections use compensating ledger entries with actor, reason, and approval metadata.
5. **Agents receive scoped tools, not database or wallet access.** LLMs set intent; game AI executes combat. High-value and irreversible actions require policy checks and, when configured, human approval.
6. **One stable item ID spans gameplay and ownership.** Extraction inventory ships first; wallet/NFT fields extend the item later without replacing its identity.
7. **Normal gameplay is non-cash at launch.** Raids award XP, OP, items, crafting resources, and progression—not random XO, per-kill XO, or staked prizes.
8. **Risky systems have flags and kill switches.** Trading, XO spend, payouts, agent deployment/spend, creator publishing, sponsor campaigns, and prize programs can be independently disabled.
9. **Privileged mutations are commands, never ad hoc database edits.** Every action carries authentication, authorization, validation, reason code, correlation ID, and immutable audit output.
10. **Telemetry is designed with the feature.** Extraction, economy, creator, sponsor, agent, and admin work is not done until its canonical events and operational metrics exist.

## 4. Program sequence and timing

Use two-week sprints. Estimates are sequencing bands for the stated three-lane team, not fixed commitments. They exclude external legal turnaround, custom art production, third-party provider approval, and large-scale community testing.

| Phase | Target | Estimated band | Start condition | Exit gate |
|---|---|---:|---|---|
| P0 | Scope and contracts | 1 sprint | Immediate | G0A: signed Extraction Alpha product contract |
| P1 | Operational foundation | 2 sprints | P0 core decisions | G0B: identity/event/audit/persistence foundation |
| P2 | Multiplayer production core | 2–3 sprints | P1 auth and telemetry skeleton | G1: stable authenticated remote match |
| P3 | Extraction vertical slice | 4–6 sprints | G1 plus item/run contracts | G2: correct deploy-to-settlement loop |
| P4 | Extraction Alpha expansion | 3–5 sprints | G2 | G2A: externally testable Alpha |
| P5 | Agent Platform v0 | 3–4 sprints | Stable inventory/loadout/deployment APIs | G3: safe delegated inventory and deployment |
| P6 | XO commerce and wallets | 4–6 sprints | Ledger design and provider/legal discovery | G4: reconciled commerce, no ordinary-match payouts |
| P7 | Owned assets and marketplace | 4–5 sprints | G4 and stable item registry | G5: provenance and atomic marketplace settlement |
| P8 | Creator ecosystem | 4–6 sprints | G5 and moderation policy | G6: submit-to-sale-to-royalty loop |
| P9 | Sponsorships and safe prizes | 3–5 sprints | G4, anti-fraud, legal approval | G7: auditable commercial launch |

Expected critical path: approximately **44–58 weeks** to G7 if decisions and providers arrive on time. A credible Extraction Alpha at G2A should be reachable in approximately **24–34 weeks**. Agent API design, wallet/provider discovery, sponsor-slot design, and Creator Portal prototyping may overlap earlier phases, but their production mutations must respect the start conditions above.

## 5. Detailed work breakdown

### P0 — Scope, contracts, and risk closure

**Goal:** Remove decisions that would otherwise force data-model or gameplay rewrites.

| ID | Work item | Owner | Depends on | Definition of done |
|---|---|---|---|---|
| P0-01 | Write the exact prepare → deploy → loot → death/extract → settle state machine | Claude Code | — | Versioned state diagram, commands, failure paths, timeout behavior, and settlement invariants are approved |
| P0-02 | Freeze Extraction Alpha content scope | Human + Codex | — | One graybox slice first; Alpha target defines The Square, surrounding sectors, POI count, raid size, raid duration, party size, AI count, and exits |
| P0-03 | Decide loss, protection, insurance, account-bound, and contraband rules by item class | Human, drafted by Claude Code | P0-01 | Rule table covers death, disconnect, abandonment, server failure, duplicate settlement, and rollback |
| P0-04 | Define stable IDs and shared contract versions | Claude Code | P0-01 | Account, player, item, item-instance, match, run, transaction, wallet-link, agent, creator, listing, campaign, and correlation IDs are specified |
| P0-05 | Define canonical event envelope and naming policy | Claude Code | P0-04 | Required identity, timestamp, source, actor, correlation/causation, schema version, payload, privacy class, and retention fields are approved |
| P0-06 | Produce client information architecture and graybox flows | Codex | P0-01 | Clickable/wireframe flows cover account, loadout, raid HUD, loot, extract, death, post-run, inventory, and reconnect states |
| P0-07 | Create ADR index, decision log, risk register, glossary, and acceptance checklist templates | OpenCode | P0-01–06 | Repository documents exist, link to owners, and contain no unresolved naming conflicts |
| P0-08 | Validate current XO/provider assumptions and prepare Ontario review package | Human legal/finance, supported by Claude Code | P0-04 | Written provider capabilities, custody model, funds-flow diagrams, jurisdiction/age/KYC questions, and explicit prohibited launch flows |

**Gate G0A:** No implementation proceeds on persistent inventory until P0-01 through P0-05 are approved. No XO production implementation proceeds until P0-08 identifies the intended wallet, payment, payout, and custody boundaries.

### P1 — Operational foundation

**Goal:** Create the platform spine every later feature can reuse.

| ID | Work item | Owner | Depends on | Definition of done |
|---|---|---|---|---|
| P1-01 | Create the modular control-plane service and versioned API boundary | Claude Code | G0A | Health/readiness, configuration validation, structured errors, API versioning, and local dev/test boot exist |
| P1-02 | Add PostgreSQL migrations and domain transaction conventions | Claude Code | P1-01 | Repeatable migrations, local/test database flow, transaction helper, unique constraints, UTC policy, and backup/restore notes exist |
| P1-03 | Implement account identity, sessions, service identity, and initial RBAC | Claude Code | P0-04, P1-02 | Authenticated player and service requests, revocation, role checks, and security audit events pass negative tests |
| P1-04 | Implement canonical event writer, transactional outbox, consumer checkpointing, and idempotency | Claude Code | P0-05, P1-02 | A committed domain mutation reliably produces one versioned event; replay and duplicate delivery are safe |
| P1-05 | Add correlation-aware logs, metrics, traces, error reporting, and environment health | Claude Code | P1-01, P1-04 | A request can be followed across API, worker, and match callback; alerts cover availability and failed jobs |
| P1-06 | Add feature flags, remote config, kill-switch registry, and immutable privileged-action audit | Claude Code | P1-03, P1-04 | Sensitive capabilities can be disabled without a client release; actor/reason/before/after are reconstructable |
| P1-07 | Build Admin Portal v0 shell and read-only search/timeline views | Codex | P1-03, mock contracts from P1-04 | Authorized staff can search account/match/event IDs and inspect a correlated timeline; empty/error/loading states are complete |
| P1-08 | Add fixtures, seed scripts, environment examples, event catalog pages, and smoke-test checklists | OpenCode | Contracts from P1-01–06 | New contributors can boot the platform and inspect sample events without undocumented manual steps |

**Gate G0B:** An authenticated test action is persisted, emits a canonical outbox event, appears in the read-only admin timeline, and can be traced end-to-end by correlation ID.

### P2 — Multiplayer production core

**Goal:** Convert the existing technical multiplayer implementation into a dependable platform capability before extraction depends on it.

| ID | Work item | Owner | Depends on | Definition of done |
|---|---|---|---|---|
| P2-01 | Add authenticated match tickets and player identity binding | Claude Code | G0B | Match server accepts short-lived single-use tickets and never trusts a client-supplied account/item identity |
| P2-02 | Implement match allocation, lifecycle registration, result callback, and crash/timeout status | Claude Code | P2-01 | Control plane knows starting/live/ending/settled/failed status and safely handles missing or duplicate callbacks |
| P2-03 | Harden protocol negotiation, reconnect/resume, rate limits, payload bounds, and abuse handling | Claude Code | P2-01 | Compatible versions negotiate; invalid clients fail closed; reconnect and disconnect policies pass soak tests |
| P2-04 | Add authoritative anti-cheat baseline and security telemetry | Claude Code | P2-03 | Movement, fire rate, impossible state, command flood, clock abuse, and suspicious hit patterns produce enforceable signals |
| P2-05 | Build server browser/queue, connect, reconnect, latency, disconnect, maintenance, and update-required UX | Codex | P2-01–03 contracts | The player understands every session state and can recover where policy permits without refreshing blindly |
| P2-06 | Extend remote-player presentation and scoreboard identity | Codex | P2-01 | Account display identity, team, network status, and reconnect state render without trusting client-authored values |
| P2-07 | Add protocol fixtures, compatibility matrix, deployment config, and straightforward regression cases | OpenCode | Stable P2-01–03 contracts | Current and supported protocol fixtures run in CI; runbook covers rollout and rollback |
| P2-08 | Run multi-process load, latency/loss, long-match, restart, and deploy-drain tests | Claude Code | P2-01–07 | Target player count and match duration meet written CPU, memory, bandwidth, correctness, and recovery budgets |

**Gate G1:** At least two authenticated remote players complete a server-authoritative match; results are recorded once; reconnect, deploy, and server-failure behavior match policy; security and operational telemetry are visible.

### P3 — Extraction vertical slice

**Goal:** Prove the complete risk loop with minimal content before building the full world.

The first slice uses a graybox version of The Square plus two adjoining sectors, two loot tiers, two AI profiles, and two conditional extraction exits. It is deliberately smaller than the final Alpha.

| ID | Work item | Owner | Depends on | Definition of done |
|---|---|---|---|---|
| P3-01 | Implement item definitions, item instances, loadouts, permanent inventory, run inventory, and item locks | Claude Code | G0B, P0-03/04 | Constraints prevent double-equip, concurrent deployment, duplicated items, and mutation of locked run items |
| P3-02 | Implement atomic deployment reservation and signed inventory snapshot | Claude Code | P3-01, G1 | A match can validate the exact reserved loadout without querying wallets or trusting the client |
| P3-03 | Add extraction match state, world/run loot, containers, pickup/drop, death-loss, and exit validation | Claude Code | P3-02 | All loot transitions are server-owned and captured in a deterministic run result |
| P3-04 | Implement idempotent post-run settlement and exception queue | Claude Code | P3-03 | Extract/death/abort/server-failure outcomes settle exactly once; ambiguous outcomes hold for review, never guess |
| P3-05 | Add sector interest management and server-side AI activation budgets | Claude Code | G1 | Network relevance and AI simulation scale by sector; no off-sector combat or loot can be client-forced |
| P3-06 | Build graybox The Square and two surrounding extraction sectors | Codex | P0-02, G1 | Original geometry supports central conflict, interiors, alleys, vertical positions, multiple approaches, objective lanes, and clear landmarks |
| P3-07 | Add client sector streaming, LOD/visibility, POI/extraction language, and sponsor-slot placeholders | Codex | P3-05 contract | Streaming stays within frame/memory budgets and placeholders do not affect sightlines or collision unfairly |
| P3-08 | Build persistent inventory and loadout preparation UI | Codex | P3-01 API | Equip, inspect, protect, locked, capacity, durability placeholder, and validation states are understandable and accessible |
| P3-09 | Build raid HUD and interactions | Codex | P3-03 contract | Run inventory, loot compare, capacity, extraction availability/countdown, squad/status, disconnect, death-loss, and warning states work |
| P3-10 | Build post-run settlement presentation | Codex | P3-04 contract | Extracted, lost, protected, progressed, pending-review, and retry-safe results are clearly distinguished |
| P3-11 | Author initial loot tables, POI tags, exit rules, AI profiles, spawn sets, and localization copy | OpenCode | Schemas from P3-03/05 | Validated data covers the thin slice and contains no logic that bypasses server checks |
| P3-12 | Add settlement invariants, failure injection, property/regression tests, and visual smoke flows | Claude Code for invariants; OpenCode for fixtures/scripts; Codex for visual flows | P3-01–11 | Test matrix includes retries, duplicate callbacks, disconnects, full inventory, simultaneous pickup, death during extraction, and server crash |

**Gate G2:** A player selects a loadout, receives a locked deployment snapshot, enters the raid, loots and fights, dies or extracts, and sees the exact correct persistent inventory result. Replaying any network or job message does not create or destroy an extra item.

### P4 — Extraction Alpha expansion and polish

**Goal:** Turn the proven slice into the first externally testable product milestone.

| ID | Work item | Owner | Depends on | Definition of done |
|---|---|---|---|---|
| P4-01 | Expand to the approved sector/POI count and extraction-rule set | Codex client/world; Claude Code authoritative hooks | G2 | The Square is both a bounded competitive map and an embedded high-risk POI; the full Alpha route graph is playable |
| P4-02 | Add dynamic events, locked zones, keys/missions, rarity curves, and AI population director | Claude Code | G2 | Events are server-authoritative, tunable, observable, and bounded by performance and reward budgets |
| P4-03 | Add map presentation, navigation cues, audio/visual identity, accessibility, and performance polish | Codex | P4-01 | The Square is recognizable in clips; extraction information remains legible without removing uncertainty |
| P4-04 | Add progression rewards, repairs/upgrades using non-XO test currency, and redeploy loop | Claude Code backend; Codex UI | G2 | XP/OP/items support repeat play; no Stage 1 activity emits XO |
| P4-05 | Instrument funnels, heatmaps, weapon/loot/extraction balance, queue health, abandonment, and crashes | Claude Code events; Codex client signals | P4-01–04 | KPI definitions and dashboards answer where runs fail, why players leave, and how value flows |
| P4-06 | Create balance datasets, playtest scripts, content checklist, and release notes | OpenCode | Stable P4 systems | Repeatable internal/external playtest package exists |
| P4-07 | Run closed Alpha, triage by severity, and lock the G2A release candidate | All, led by human owner | P4-01–06 | No open item-dupe/loss, authority, crash, spawn-kill, or progression-blocker defects; rollback and incident runbooks are rehearsed |

**Gate G2A:** A representative cohort can repeatedly complete the full Extraction Alpha loop at target performance and reliability. The game is compelling without wallets, NFTs, agents, creators, or XO rewards.

### P5 — Agent Platform v0

**Goal:** Let a player safely delegate strategic account actions after the underlying APIs are proven for humans.

| ID | Work item | Owner | Depends on | Definition of done |
|---|---|---|---|---|
| P5-01 | Publish tool schemas for inventory, inspect item, loadout, mission/deployment, and audit lookup | Claude Code | G2 | Tools use the same versioned domain commands as human UI and have deterministic, bounded responses |
| P5-02 | Build Agent Gateway identity, scoped tokens, capability grants, revocation, cooldowns, and rate limits | Claude Code | P1-03/06, P5-01 | No model connector can bypass player scope or call an undeclared tool |
| P5-03 | Implement policy evaluation for risk profile, protected items, per-action limits, daily limits, and approvals | Claude Code | P3-01, P5-02 | Deny/approve/request-human-approval decisions are deterministic, logged, and tested against bypass attempts |
| P5-04 | Add model-agnostic connector interface and initial supported connectors | Claude Code | P5-02 | Connectors translate model output to validated tool calls and never expose secrets or raw wallet signing capability |
| P5-05 | Add immutable agent action/audit chain and emergency revoke | Claude Code | P5-02/03 | Player, agent, model/tool, policy version, request summary, decision, outcome, correlation ID, and affected entities are reconstructable |
| P5-06 | Build Agent Center UI | Codex | P5-01–05 APIs | Connect/revoke, permission scopes, risk profile, protected items, budgets, approval inbox, activity timeline, and failure explanations are complete |
| P5-07 | Add connector setup help, sample policies, read-only examples, and adversarial evaluation fixtures | OpenCode | Stable tool/policy schemas | Documentation and fixtures cover safe use, prompt injection attempts, malformed output, duplicate actions, and revoked access |
| P5-08 | Roll out read-only → loadout write → deployment in separate flags | Claude Code + Codex | P5-01–07 | Each capability meets error, audit, support, and abuse thresholds before the next is enabled |

**Gate G3:** A connected LLM can inspect inventory, propose/configure a loadout, respect protected-item and risk rules, request approval when required, and queue an operator. It cannot aim, drive combat frame by frame, exceed scope, or use a raw wallet key.

### P6 — XO commerce and wallet boundary

**Goal:** Launch safe, auditable commerce before prizes, peer-to-peer transfers, or ordinary-game rewards.

| ID | Work item | Owner | Depends on | Definition of done |
|---|---|---|---|---|
| P6-01 | Finalize funds-flow, account chart, transaction states, custody boundary, refunds, holds, and adjustment policy | Human finance/legal + Claude Code | P0-08 | Approved written model identifies external and internal sources of truth and prohibited flows |
| P6-02 | Implement append-only double-entry ledger and accounting exports | Claude Code | P6-01, P1-02/04 | Every XO-sensitive business event balances; corrections are compensating entries; concurrency and replay tests pass |
| P6-03 | Implement player-controlled wallet linking with challenge/signature verification | Claude Code | Provider selection, P1-03 | Link/unlink/revoke flows resist replay and account takeover and store no unnecessary signing authority |
| P6-04 | Implement payment intents, webhook verification, settlement state machine, refunds, and reconciliation worker | Claude Code | P6-02/03 | External events are authenticated, idempotent, retried, reconciled, and visible in an exception queue |
| P6-05 | Build wallet onboarding, link, checkout, receipt, pending/failed/reconciled, refund, and history UX | Codex | P6-03/04 contracts | Every external-settlement state is explicit; UX never labels a pending transaction as final |
| P6-06 | Build finance/admin ledger, reconciliation, hold, refund, adjustment-request, and export views | Codex | P6-02/04 | Authorized roles can investigate but cannot silently mutate value; dual approval is shown where policy requires |
| P6-07 | Add transaction fixtures, provider sandbox examples, finance runbooks, and support decision trees | OpenCode | Stable P6 contracts | Happy/failure/duplicate/out-of-order cases are reproducible without live funds |
| P6-08 | Security, finance, privacy, and legal launch review; commerce-only staged rollout | Human reviewers, supported by Claude Code/Codex | P6-01–07 | Wallet commerce is approved; prize, staking, random XO, unrestricted P2P, and agent XO spend remain disabled |

**Gate G4:** A player links a controlled wallet, completes an approved purchase, receives the item once, and sees a transaction that reconciles to the external provider and a balanced internal ledger. Refund and failure paths reconcile without manual balance edits.

### P7 — Owned assets and marketplace

**Goal:** Add provenance and trading without letting chain state control a live match.

| ID | Work item | Owner | Depends on | Definition of done |
|---|---|---|---|---|
| P7-01 | Extend the stable item registry with immutable provenance and mutable gameplay metadata | Claude Code | P3-01, G4 | Identity/creator/edition/mint data is separated from attachments/durability/upgrade state with an explicit metadata policy |
| P7-02 | Build chain/provider indexer and reconciled ownership mirror | Claude Code | P7-01 | Reorg, delayed settlement, transfer, custody-state, and provider outage behavior is defined and replay-safe |
| P7-03 | Implement marketplace listings, reservations, purchase, cancellation, fees, royalties, and atomic item transfer | Claude Code | P6-02/04, P7-01/02 | Item and value cannot diverge; locked/deployed/protected/disputed items cannot be sold; duplicate settlement is harmless |
| P7-04 | Add price history, provenance, rarity/history, trade state, and inventory ownership UX | Codex | P7-01–03 APIs | Players can distinguish game state, wallet ownership, pending transfer, listing lock, and final settlement |
| P7-05 | Build marketplace browse/search/list/buy/sell/cancel flows | Codex | P7-03 | Fees, royalties, total cost, recipient, status, confirmation thresholds, and errors are disclosed before action |
| P7-06 | Add marketplace exception, dispute, fraud-signal, and settlement investigation views | Codex | P7-02/03 | Operations can reconstruct an item/value timeline and place policy-based holds without direct DB edits |
| P7-07 | Add item/listing seed data, metadata examples, fee examples, and regression fixtures | OpenCode | Stable P7 schemas | Fixtures cover deployed, protected, account-bound, stale-owner, pending-chain, cancelled, and disputed items |

**Gate G5:** A selected gun or apparel item has stable identity and provenance, can be listed and bought under policy, transfers exactly once, and remains usable in matches through the fast game inventory mirror without a chain call.

### P8 — Creator ecosystem

**Goal:** Prove the controlled cosmetic creation → fee → validation → moderation → publish → sale → royalty loop.

| ID | Work item | Owner | Depends on | Definition of done |
|---|---|---|---|---|
| P8-01 | Freeze first-wave templates, technical budgets, IP/content policy, edition rules, fee policy, and creator agreement | Human product/legal/art, supported by Codex | G5 | Weapon skins, apparel textures, patches/emblems/banners, charms/stickers/sprays have measurable constraints and rights terms |
| P8-02 | Implement submission, upload, storage isolation, malware/file validation, workflow state, moderation, and publishing backend | Claude Code | P8-01, P1-03/04 | Untrusted files are isolated; every state transition is authorized/audited; rejected content cannot publish |
| P8-03 | Connect XO submission fees, refunds/forfeiture policy, creator payables, revenue share, and royalties | Claude Code | P6-02/04, P7-03, P8-02 | Ledger entries balance and match approved policy across submit, reject, withdraw, publish, sale, refund, and payout hold |
| P8-04 | Implement mint/register and marketplace publish orchestration | Claude Code | P7-01–03, P8-02 | Approval produces one registered asset/listing; retries cannot double-mint or double-publish |
| P8-05 | Build Creator Portal template selection, upload/editor, metadata, collection, edition, and fee UX | Codex | P8-01/02 APIs | Creator sees constraints before upload and a complete cost/rights summary before payment |
| P8-06 | Build live 3D preview and technical validation feedback | Codex | P8-01 | Preview matches in-game material/placement closely enough for approval and reports actionable limit failures |
| P8-07 | Build moderation response, publish status, sales, royalties, payout-hold, and analytics UX | Codex | P8-02–04 | Creator can resolve feedback and understand every financial/workflow state without support intervention |
| P8-08 | Build moderator queue and asset inspection interface | Codex | P8-02 | Reviewers see automated findings, asset preview, rights metadata, history, reason codes, and controlled approve/reject/request-change actions |
| P8-09 | Add template starter files, validation samples, policy copy, rejection reasons, and workflow regression fixtures | OpenCode | Stable P8-01/02 specs | Good and bad submissions cover size, format, performance, metadata, rights, and duplicate-content cases |

**Gate G6:** A creator spends XO, submits a compliant cosmetic, passes automated and human review, publishes one registered item, completes a player sale, and receives a correctly calculated royalty/payable entry.

Gameplay-affecting creator weapons, arbitrary geometry, map modules, and AI-assisted power-budget review are explicitly deferred until cosmetic creation and marketplace balance are proven.

### P9 — Sponsorships, Prize Reserve, and approved competitions

**Goal:** Monetize scarce world inventory safely, keep normal play non-cash, and activate prizes only through approved programs.

| ID | Work item | Owner | Depends on | Definition of done |
|---|---|---|---|---|
| P9-01 | Define The Square inventory catalog, visibility rules, creative policy, lease periods, conflicts, and make-good policy | Human commercial/design + Codex | P4-01/03 | Storefront, billboard, rooftop, event, and presenting-sponsor placements are finite, named, measurable, and removable |
| P9-02 | Implement lease/campaign booking, creative approval, activation/expiry, delivery records, and campaign audit backend | Claude Code | P9-01, P1-04/06 | Overlapping leases are prevented; expiry and kill switches work; every creative/version/date is attributable |
| P9-03 | Implement impression/delivery event definitions and abuse-resistant aggregation | Claude Code | P9-02, P4-05 | Viewability rules are documented; raw events are bounded; sponsor reports reconcile to campaign state |
| P9-04 | Implement Prize Reserve ledger allocation as an earmark, not a player balance or entitlement | Claude Code | P6-02, approved policy | Qualifying revenue automatically creates auditable 90/10 allocations; corrections and cancellations reverse through entries |
| P9-05 | Build in-world sponsor/storefront presentation and graceful fallback | Codex | P9-01/02 | Creative respects gameplay visibility and performance budgets; expired/disabled content disappears without a client patch |
| P9-06 | Build sponsor inventory, campaign, creative review, delivery, reserve-contribution, and reporting UI | Codex | P9-02–04 | Authorized users can book/review/monitor; financial and delivery states are not conflated |
| P9-07 | Add campaign templates, creative specs, sample inventory, report exports, and operations runbooks | OpenCode | Stable P9 contracts | Sales and operations can execute a sandbox campaign without engineering intervention |
| P9-08 | Build free-entry fixed-prize competition service only after approval | Claude Code | G4, G2A, legal approval, anti-cheat readiness | Rules version, eligibility, jurisdiction, age/KYC status, roster, result, holds, approval, payout, tax/report refs, and audit are complete |
| P9-09 | Build competition discovery, rules acceptance, eligibility, standings, prize status, and support UX | Codex | P9-08 | Material rules and prize value appear before entry; ineligible/pending/held/paid states are explicit |
| P9-10 | Run legal, finance, security, anti-cheat, fraud, support, and incident go-live rehearsal | Human reviewers + all agents | P9-01–09 | Written sign-off exists; payout holds, disqualification, cancellation, provider outage, fraud review, and kill switches are rehearsed |

**Gate G7:** The Square supports controlled sponsor/creator inventory; qualifying revenue creates a transparent, balanced Prize Reserve allocation; ordinary play remains non-cash; and any live XO competition is free-entry, fixed/disclosed, skill-focused, jurisdiction-controlled, fraud-reviewed, and specifically approved.

Paid entry, player staking, random XO loot, extraction jackpots, and ordinary per-kill XO remain out of scope unless a later legal/compliance and product review explicitly authorizes a redesigned flow.

## 6. Parallelization map

The lanes can overlap, but only across stable contracts:

| When Claude Code is building… | Codex can build… | OpenCode can safely support… |
|---|---|---|
| Event/auth/platform foundation | Admin shell against mocks; extraction UX prototypes | Glossary, event catalog, fixtures, boot docs |
| Match tickets and lifecycle | Queue/connect/reconnect UX; Square graybox | Protocol matrix, deploy config, regression fixtures |
| Inventory/run/settlement APIs | Loadout, raid HUD, loot, post-run UI against frozen schemas | Loot/AI/exit seed data and test cases |
| Agent Gateway and policy engine | Agent Center with mocked policy outcomes | Connector examples and adversarial evaluation prompts |
| Ledger and wallet reconciliation | Wallet/checkout/finance UI against sandbox contracts | Transaction fixtures and support runbooks |
| Marketplace transactions/indexer | Browse, item detail, provenance, listing UI | Metadata and fee examples |
| Creator workflow backend | Creator preview, upload, moderation, analytics UI | Templates, samples, policy copy |
| Sponsor/competition backend | In-world placements, sponsor console, competition UX | Creative specs, exports, runbooks |

Do not begin frontend implementation from prose alone. Claude Code first publishes the relevant OpenAPI/JSON/event schema and example payloads; Codex confirms UI state coverage; then OpenCode may add fixtures and documentation. Contract changes after that point require a version bump or a coordinated migration.

## 7. Agent handoff and repository workflow

### File ownership

- **Claude Code:** dedicated server, platform API, workers, persistence/migrations, security, server-side contracts, backend tests, infrastructure definitions.
- **Codex:** `src/ui`, client presentation, Three.js world/level presentation, client networking UX, web portals, responsive/accessibility behavior, visual tests.
- **OpenCode:** docs, static data/config, fixtures, examples, low-complexity scripts, release notes, copy changes.
- **Shared/hazardous surfaces:** protocol definitions, item schemas, event schemas, match state, and generated clients get one named owner per task. Never have two agents edit them concurrently.

### Required handoff packet

Every task handoff includes:

1. Task ID and gate served.
2. Contract/schema version and example payloads.
3. Migration and backward-compatibility notes.
4. Feature flag and rollback behavior.
5. Security/value implications.
6. Tests run and evidence.
7. Known gaps and the next unblocked task IDs.

### Integration order

For each vertical feature, merge in this order:

1. Contract and migration.
2. Backend behavior behind a disabled flag.
3. Backend invariant/security tests.
4. Frontend states against the real contract.
5. Fixtures, docs, and simple regression coverage.
6. End-to-end test and observability verification.
7. Staged flag enablement and rollback rehearsal.

## 8. Quality gates that apply to every phase

| Area | Required evidence |
|---|---|
| Correctness | Automated happy, negative, concurrency, retry, and duplicate-delivery tests proportional to risk |
| Authority | Client tampering cannot create a favorable match, item, value, or eligibility outcome |
| Security | Authentication, authorization, input limits, secret handling, dependency review, auditability, and abuse cases checked |
| Reliability | Timeouts, retries, idempotency, dead-letter/exception visibility, backup/recovery, and rollback behavior tested |
| Performance | Written client frame, memory, server tick, bandwidth, API latency, database, queue, and job budgets measured |
| UX | Loading, empty, offline, partial, stale, failed, pending, denied, held, and success states designed |
| Accessibility | Keyboard, focus, contrast, reduced motion, readable error feedback, and non-color-only status cues checked |
| Observability | Events, metrics, logs, correlation IDs, dashboards, alerts, and owner/runbook exist before rollout |
| Privacy/compliance | Data purpose, retention, access roles, export/deletion implications, jurisdiction, and consent reviewed where applicable |
| Rollout | Feature flag, cohort/stage plan, kill switch, rollback, support notes, and incident owner recorded |

Financial, ownership, and prize features add mandatory ledger-balance, reconciliation, fraud-hold, and dual-approval tests. Extraction adds mandatory no-dupe/no-loss settlement invariants. Agent features add scope, budget, approval, protected-asset, revocation, and prompt-injection/adversarial tests.

## 9. Release environments and promotion

1. **Local deterministic:** loopback networking, local platform database, provider mocks, seeded world/content.
2. **Integration:** real WebSockets and processes, migration tests, event outbox/worker, generated UI contract tests.
3. **Staging:** production-like infrastructure, sandbox wallet/payment/provider, synthetic accounts/items/value, load and failure injection.
4. **Closed Alpha:** invite cohort, no live XO prizes, limited commerce only when G4 is approved, enhanced telemetry and support coverage.
5. **Production staged:** internal → small cohort → jurisdiction/provider cohort → general availability, with automated rollback thresholds.

Production data and live-value provider credentials are never used in local or ordinary integration tests.

## 10. Metrics and go/no-go thresholds to set in P0/P1

The human owner must approve numeric targets before G1 and G2. At minimum define:

- Match tick time percentile, bandwidth/player, client frame time, memory, reconnect success, crash-free sessions, and match completion.
- Queue time, spawn-death rate, run duration, extraction rate, abandonment, item gain/loss, settlement latency, settlement exceptions, and duplicate-prevention count.
- Agent tool success/denial/approval rate, revoked-token attempts, policy violations, user overrides, and unintended-action disputes.
- Wallet link success, payment completion, reconciliation lag, refund rate, ledger imbalance count (target zero), exception age, and provider outage impact.
- Marketplace conversion, failed settlement, stale listing, fraud holds, creator GMV, royalty accuracy, moderation time, rejection reasons, and payout age.
- Sponsor delivery, valid impressions, campaign underdelivery, Prize Reserve balance/reconciliation, competition eligibility failure, anti-cheat holds, and payout completion.

Definitions belong in a versioned KPI dictionary; dashboards must link back to those definitions.

## 11. Explicitly deferred work

The following should not distract the team before G7 unless separately funded and approved:

- Battle Royale scale and very high player counts.
- Paid-entry or player-staked competitions.
- Random XO loot, per-kill XO, ordinary raid XO, and Extraction jackpots.
- Arbitrary creator-authored gameplay stats, weapon geometry, or map modules.
- Fully autonomous real-time LLM aim/movement/combat.
- Unrestricted peer-to-peer wallet transfer through an Overstrike-held balance.
- Permanent ownership of map advertising geometry; use timed leases.
- Premature decomposition of the control plane into many independently deployed services.

Bomb/Demolition may be scheduled after G2 because it can reuse no-respawn and objective-state patterns. It becomes a prerequisite only for a Bomb-based prize program, not for Extraction Alpha, agents, or commerce.

## 12. First 30 days

### Week 1

- Claude Code: P0-01, P0-04, and the first draft of P0-05.
- Codex: P0-06 and a measured audit of the current menu/HUD/world integration points.
- OpenCode: P0-07, repository glossary, roadmap-to-task index, and decision templates.
- Human owner: decide P0-02 raid/content bounds and schedule P0-08 legal/finance/provider discovery.

### Week 2

- Claude Code: P0-03 technical rule matrix, control-plane ADR, database/outbox design, and API skeleton plan.
- Codex: graybox information architecture for loadout, raid HUD, extraction, death, and post-run states.
- OpenCode: acceptance checklists, event catalog scaffolding, and test matrix templates.
- Gate review: approve G0A or record named blockers with owners and dates.

### Weeks 3–4

- Claude Code: begin P1-01 through P1-06 in dependency order.
- Codex: begin P1-07 against versioned mocks and start The Square graybox brief without final content production.
- OpenCode: P1-08 only after the foundation contracts stabilize.
- End-of-month demonstration: one authenticated platform mutation persisted, emitted through the outbox, traced by correlation ID, and visible in Admin Portal v0.

## 13. Program definition of success

The program succeeds only if Overstrike remains a strong FPS for a player who ignores wallets, NFTs, creators, agents, and XO. Extraction must be fun and trustworthy first. Platform systems then deepen persistence, ownership, automation, commerce, sponsorship, and creation without weakening server authority, balance, financial integrity, or player trust.

