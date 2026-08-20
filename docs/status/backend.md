<!-- SINGLE WRITER: [CC] Claude Code. Codex reads this; it never writes here. -->

# Backend status — [CC] Claude Code

Updated at the end of every working session, per Build Plan §7.

---

## 2026-08-19 — P0 contract freeze, Claude Code track

### Done

**All 13 contracts authored** in `docs/contracts/`, at `1.0.0`, status `REVIEW`:

| # | Contract | Note |
|---|---|---|
| 1 | `http-api.md` | P1–P4 REST surface, idempotency, rate limits, stub mode |
| 2 | `errors.md` | Closed error-code enumeration + retry rules |
| 3 | `auth.md` | Two-token model, rotation, revocation, handoff tickets ¹ |
| 4 | `realtime-lobby.md` | Lobby socket, launch handshake, readiness invalidation |
| 5 | `wire-protocol.md` | The protocol **as it exists**, plus 5 named gaps |
| 6 | `net-facade.md` | The only `src/net/` surface Codex may import |
| 7 | `match-result.md` | Canonical stat definitions incl. contested cases |
| 8 | `event-envelope.md` | Envelope, transactional outbox, catalogue |
| 9 | `map-data.md` | Makes CX-owned geometry safe for the server |
| 10 | `bomb-rules.md` | Full ruleset; win-condition precedence ¹ |
| 11 | `db-schema.md` | Initial PostgreSQL schema ¹ |
| 12 | `telemetry.md` | Three pipelines kept distinct; privacy/retention classes |
| 13 | `feature-flags.md` | Flags vs kill switches; registry |

¹ contains a section blocked on a P0.3 human decision.

**Repo preparation:**
- `docs/contracts/`, `docs/handoff/`, `docs/status/`, `docs/design/` created with single-writer
  headers naming the owning lane.
- `docs/contracts/CHANGELOG.md` with the CCR format.
- `docs/lane-ownership.json` — machine-readable Build Plan §1.4.
- `scripts/lanecheck.mjs` — the cross-lane CI guard.
- `PROTOCOL_VERSION` added to `src/net/protocol.js`.
- `docs/Overstrike_Build_Plan.md` marked superseded; v2.0 copied to
  `docs/Overstrike_Platform_Build_Plan.md` so the reference resolves inside the repo.
- `npm run lanecheck` added.

**Not** added to `npm run ci`. Without `--base` it inspects the working tree, and the tree
currently carries pre-existing uncommitted work across both lanes — wiring it into `ci` would
fail every run for a reason that is not a lane violation. CI calls it per-PR as
`node scripts/lanecheck.mjs --base=master`, which is the form it was designed for. Local use
before a push is the same command.

**Guard proven to fail**, per Build Plan §5.1 — a guard that cannot fail is not guarding:

| Case | Result |
|---|---|
| CC-only change set | passes |
| CX-only change set | passes (+ geometry reminder) |
| Mixed CC + CX | **fails**, names the offending files per lane |
| Unowned path | **fails**, points at the ownership map |
| `protocol.js` without a version bump | **fails** |

### One sanctioned ownership exception, stated so it is not repeated

Creating the scaffolding meant this lane wrote two **Codex-owned** files:
`docs/handoff/requests-to-backend.md` and `docs/status/frontend.md`. Build Plan §P0.4 assigns
that scaffolding to [CC] explicitly — the files have to exist before Codex can write to them.

**It is a one-time exception and it is now closed.** From here those two files are Codex-only,
and `scripts/lanecheck.mjs` will fail any further backend change touching them beyond the
`- Status:` carve-out. Codex may overwrite both wholesale without discussion.

### Findings worth the human owner's attention

1. **The match server has no authentication at all.** `GameServer.addClient` accepts any
   socket and creates an entity; `MSG_WELCOME` carries ids and a seed, no token, no version.
   Anyone who can reach the port is a player. Recorded as `wire-protocol.md` §7 G2, closed in
   P2 by the session-ticket handoff in `auth.md` §6. It is not exploitable at present only
   because nothing is publicly deployed.

2. **The wire protocol was unversioned.** The client inferred server capability from message
   `byteLength`, which works only while every change is a pure append. `PROTOCOL_VERSION` now
   exists so the CI guard has something to enforce, but **negotiation is not implemented** —
   a mismatched client is still not rejected. P2, gap G1.

3. **`level.js` exports none of the objective or callout data Bomb needs.** It has collision,
   bounds, and `{position, yaw, team}` spawns. Objective volumes, named callout regions,
   explicit walkability tagging, and map versioning are all new. This is P3's real starting
   cost and it lands on the Codex lane — worth knowing before P3 is scheduled.

4. **Stat definitions did not exist anywhere.** `match.js` keeps a good in-memory row but has
   no `suicides`, `teamKills`, `plants`, `defuses`, `roundsPlayed`, `timePlayedSec`, or
   per-weapon breakdown, and no notion of a definition version. `match-result.md` §3.1 now
   rules on nine contested cases that would otherwise each have been decided twice, differently.

### P0.3 decisions — RESOLVED (delegated to this lane)

All six recorded with reasoning and reversal costs in
[`docs/decisions/P0-decisions.md`](../decisions/P0-decisions.md), and propagated into the
contracts. No `PENDING DECISION` sections remain.

| # | Decision | Resolution | Reversal cost |
|---|---|---|---|
| 1 | Auth provider | **Supabase Auth** — Postgres-native, self-hostable escape hatch, MAU pricing that survives free-to-play | Moderate |
| 2 | Database + regions | **Supabase Postgres `ca-central-1`** (Toronto); match servers stay on Fly `yyz`/`ord`/`iad` | High (region) |
| 3 | The Square envelope | **80 m × 80 m**, 14–20 s rotation, 45 m sightline ceiling | **Very high** |
| 4 | Bomb parameters | MR12, no defuse kit, **40 s timer**, no overtime in Alpha | Low |
| 5 | Browser matrix | Desktop only; Chromium/Firefox latest 2, Safari 17+; WebGL2 | Low |
| 6 | Age baseline | **13** account / **18+** prizes — a *working default*, not a legal position | High |

Two notes the human owner should read even though the decisions were delegated:

- **D3 and D4 are coupled and were decided together.** The bomb timer is *derived* from the
  map rotation envelope, not chosen: 20 s worst-case rotation + 7 s defuse = 27 s minimum,
  40 s chosen for 13 s of fighting margin. Set it below that and defenders can never retake,
  and the mode collapses into a plant race. If measured rotation exceeds 20 s on real
  geometry, **the timer moves, not the map** — the far cheaper correction.
- **D6 still needs a professional review before P8 and P11.** It is decided far enough to
  unblock schema and profile design and no further. To keep it cheap to revise, no feature
  outside P8/P11 may read the eligibility flag.

### Still blocked — the other lane

`REQ-CX-001`, the Codex contract sufficiency sign-off, is the only remaining G0A blocker.
**Contracts stay in `REVIEW` until it lands.** This lane deliberately did not freeze them:
that gate exists to catch backend APIs the frontend cannot actually use, and self-certifying
it would remove the only check on that failure mode.

### Open requests

- `REQ-CX-001` — contract sufficiency sign-off. **Blocking G0A.**
- `REQ-CX-002` — measured A↔B rotation, to confirm or move the 40 s bomb timer.
- `REQ-CX-003` — the map envelope is fixed; build The Square to it.
- `REQ-CX-004` — browser matrix decided; the client must gate on capability before rendering.

### Next session

1. **P1.A1** platform service skeleton — `platform/` modular Node service, correlation-ID
   middleware, error envelope, health endpoints that separate process health from dependency
   health.
2. **P1.A2** Supabase project, migration tooling, and the `db-schema.md` initial migration.
3. **P1.A8 stubs early, not last.** They are what lets Codex build the entire shell before the
   services exist; Build Plan §0.5 makes them a scheduled deliverable rather than a favour.
   Ordering: `platform.api.stub` → `lobby.stub` → `net.facade.stub`.
