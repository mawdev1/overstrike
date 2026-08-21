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

### Codex review amendments — COMPLETE

Codex returned **10 of 13 contracts insufficient** with five cross-contract contradictions.
All nine requests (`REQ-CC-001`…`009`) are resolved and marked `DONE` with responses; every
amended contract is at **1.1.0**. Detail in `docs/contracts/CHANGELOG.md`.

Three of the five were real defects, not misreadings:

1. **Refresh transport contradicted itself** — `auth.md` said httpOnly cookie, `http-api.md`
   said body. The cookie is correct and the body reference was an error; a refresh credential
   the page can put in a request body is one XSS can steal, which defeats the two-token design.
2. **The lobby reconnect flow was impossible** — the ticket is consumed on socket open, yet the
   contract told the client to reuse it or fetch one from an endpoint that returns none.
3. **The map budgets were 4× over the binding ceiling** — I wrote 900 draw calls / 1.4M
   triangles without opening `ARCHITECTURE.md` §11, which binds `< 220` / `< 450k`. Authoring
   to those numbers would have produced a map that only failed at `geomtest`.

The other two — `AUTH_SESSION_REPLACED` missing from a "closed" enum, and two Bomb states
needing one remaining flag bit — were also correct.

### Map envelope — disagreement resolved at 88 m

Codex's art direction called for 88–104 m; my first pass was 80 m ±10% (72–88 m). **The bands
touch at exactly one value.** 88 m is not a split difference — it is the only figure neither
spec has to be relaxed to accept. Reasoning in `P0-decisions.md` §D3.1.

Knock-on: worst-case rotation 20 s → 22 s, so the bomb timer's floor rises to 29 s and 40 s now
carries 11 s of margin rather than 13 s. The timer holds, but `REQ-CX-002`'s measurement is now
load-bearing rather than confirmatory. Codex's full 104 m would have broken 40 s outright.

### Deployment state

Committed in two lane-clean commits — `b59a982` (fe) and `a148a09` (be) — each passing
`lanecheck` on its own file set. Nothing of the pre-existing uncommitted working tree was swept
in; 28 modified files from prior sessions remain untouched.

**Not pushed.** `origin/master` is 62 commits behind local, so publishing P0 would also publish
the entire multiplayer phase history. That is well outside P0's scope and is a human decision.

---

## 2026-08-21 — P3.A findings that cross into the net lane

**Two open defects live in `src/net/**`, which another CC session is editing right now.**
Recorded here rather than fixed, because editing those files under an in-flight session is how
two lanes produce a tree neither one tested. Both were found by adversarial re-review and both
reproduce at HEAD.

### D1 — nothing in the shipping game can plant or defuse

CORRECTED 2026-08-21, and the correction narrows it rather than dismissing it. At the time this
was written `requestInteract` had no production caller at all. It now has one: `botManager.js`
calls it, so **bots genuinely plant and defuse** — 30 plants and 13 defuses over 38 rounds,
measured. The ruleset is reachable and exercised server-side, which is where the contract puts
the authority.

What is still missing is the **client request path**. `bomb.js`'s own header says "a client
REQUESTS an interaction (`requestInteract`) and the server decides"; there is no route from a
human player's key to that call. `player.js:1928` routes the interact edge to
`_interact()`, which raycasts the world and emits a bus `interact` event nothing subscribes to
the bomb, and `src/net/server.js` never reads `cmd.interact`.

So Bomb is playable by bots and **unplayable by a human**. The `interact` wire byte and every
`REFUSAL_REASONS` value are still proved only against harness-invented calls, because no client
ever sends the request that would produce them. `bombtest.mjs` and `wstest.mjs` call `rules.requestInteract` directly.
That is the same failure `server.js`'s own `normaliseObjective` comment already documents: the
test hand-fed the shape the test invented, so producer and consumer were never connected.

544 passing checks describe a ruleset the game cannot reach.

**A STRUCTURAL BLOCKER sits behind it.** §6.4 requires the plant key **held continuously**, and
the wire has nowhere to say so. `HELD_BITS` (`protocol.js:284`) is exactly 8 entries written with
`setUint8` — full — and `interact` lives in `EDGE_BITS`, a press. A continuously-held plant needs
a 9th held bit, which is a LAYOUT change and therefore `PROTOCOL_VERSION` → 3. It cannot be
routed correctly without that.

The in-flight net work routes `cmd.interact` as `if (cmd.interact) requestInteract else
releaseInteract`. That treats an edge as a hold: a held key produces one `true` and then `false`
on every later command, so `_resetProgress` fires every tick and a plant can never complete. It
is the right instinct against a wire that cannot express the requirement.

### D3 — the wire and the result record disagree on every `roundsToWin` series

`src/net/server.js:1356` maps `roundsToWin` to the constant `'elimination'`. `modes.js:155`
maps the same fact to the **deciding round's own** reason. On `bombresult`'s own timer-decided
control: result record `timer`, wire `elimination`.

`wire-protocol.md` §8.9: "`reason` (`outcomeReason` everywhere else — one name, one enum)."
`match-result.md` §4.2: "a record where they disagree carries two truths and is refused."

This is the earlier fix MOVING the defect rather than removing it. The `modes.js` comment argues
at length that a constant "would report a series clinched by a detonation as an elimination,
which is exactly the two-truths-in-one-row §4.2 refuses" — and the server's independent table
then does precisely that. Invisible to the suites because `bombresult` asserts only result
records and never a decoded frame.

### Also open, from the same review
- `bombDetonated` is in `EV_VEC3`/`EV_SPATIAL` but `bomb.js:800` emits no `x/y/z`, so it encodes
  as the origin AND is distance-culled against the origin — clients more than 90 m from world
  (0,0,0) never receive it.
- A malformed hello is refused with `PROTOCOL_VERSION_MISMATCH`; §8.11 calls this a framing
  error, so the client shows an upgrade prompt for a length bug.
- Once D1's routing lands, `interactRefused` shares the 4096-row evidence budget with objective
  facts and drops the NEWEST on overflow. One client holding an invalid interact key fills it in
  ~34 s, after which every later plant, defuse and outcome is lost — against §7's "the result
  must be reconstructable from evidence alone".

---

## 2026-08-20 — P1 backend, and what the green suite was not measuring

### Where it stands

All 13 contracts are **FROZEN** (the human owner instructed proceeding without a further
review round). `master` is pushed and CI is green on three jobs: **1368 checks on memory,
1631 against real PostgreSQL**, migrations replayed as a no-op. Both Fly apps are live; the
game server has cycled 84 matches with zero ticks behind.

`/v1/matches/*` is mounted and its result payloads are validated to the leaf. Consent and
idempotency retention now have actual sweeps. Contract amendments this session: `match-result`
1.8.0, `http-api` 1.10.0, `telemetry` 1.10.0, `errors` 1.6.0, `net-facade` 1.9.0, `bomb-rules`
1.7.0, `db-schema` 1.7.0.

### The finding that matters more than the fixes

A mutation sweep — delete one guard line, re-run the suite — found that **146 of 253 guards in
`platform/src/**` can be deleted while the suite still reports every check green.**

That number is the honest summary of this lane's testing to date. The suite is unusually
explicit about why each test exists; what it did not have is any mechanism that fails when a
guard stops guarding. Concretely, with the suite fully green:

- deleting one line in `app.js` makes the platform **accept personal telemetry from a player
  who explicitly declined it**. There is a decline test, but it builds its own verifier — and
  the composition root replaces that verifier with a different one. The only decline assertion
  in the repository exercised code that is never deployed.
- `dateOfBirth: "banana"` returns `eligible: true` **and a signed receipt** that signup accepts.
- a test titled "If-Match is compare-and-set, not read-then-write" passed with the CAS deleted,
  including both of its controls, because it exercised the service pre-check — read-then-write,
  the exact thing its title denied.

### Three claims this lane made that were false

Recorded here because the pattern is the point, not the individual errors.

1. `net-facade.md` §8 was said, twice, to name the Bomb-position and outcome-matrix scenarios,
   the second time to overrule a reviewer who had checked. `git log -S` shows those strings
   never existed in the file.
2. `REQ-CC-042.5` was answered as fixed after reading the amended contract. The contract was
   right; `telemetry/registry.js` still carried the wrong retention class for pre-consent
   funnel data.
3. `REQ-CC-052` claimed If-Match was "verified with 8 concurrent writers on both adapters".
   No such test existed. The adapter it described was meanwhile diverging: on PostgreSQL a CAS
   against a version no row had **inserted** a row carrying the patch's own version.

The common shape: a claim written from intention rather than from the file, and a green suite
that could not contradict it. `match-result.md` §4.0 — cited by number in four documents and
one source file — had never been written at all.

### What changed structurally

- `contracttest.mjs` parses the normative sentence out of a contract **and** drives the real
  app over a real socket. A document and an implementation can no longer agree on paper.
- `citest.mjs` fails if `npm run ci` names a file git does not track. `npm run ci` had passed
  only on the one machine holding an untracked `tdmtest.mjs`, three times running, and the
  workflow never called `npm run ci` at all.
- `lanecheck --range` checks each commit separately. The union check inverted its own rule:
  §0.2 demands a mixed change be split, and a correct split fails a union check.
- `pgtest` is in CI with `CI=1`, so a missing database fails rather than skips. `pg` was in no
  package.json and no lockfile — it survived locally as an unsaved `node_modules` entry.

### Open

- The mutation survivors are being closed in file-partitioned batches; the sweep is becoming a
  permanent harness rather than a one-off.
- `changeDisplayName` has no per-account serialisation, so two concurrent renames both pass the
  30-day cooldown check. `display_name_folded` is `unique`, so the database backstops
  NAME_TAKEN — nothing backstops the cooldown.
- 13 of 16 auth HTTP routes have no test calling them. They work when driven by hand; this is a
  guard gap, not a live defect.
- `auth.md` §11 (age and eligibility) remains a **working default, not a legal position**, and
  needs professional review before P8 and P11.

### Still blocked — the other lane

`REQ-CX-001`, the Codex contract sufficiency sign-off, is the only remaining G0A blocker.
**Contracts stay in `REVIEW` until it lands.** This lane deliberately did not freeze them:
that gate exists to catch backend APIs the frontend cannot actually use, and self-certifying
it would remove the only check on that failure mode.

---

## 2026-08-20 — P0/P1 closure audit after REQ-CC-045–061

This entry supersedes the old “Open” lists above as current executable status; the historical
findings remain because they explain why the proofs exist.

### Executable closure

- `REQ-CC-045`, `046`, `048`, `050`–`053`, and `058`–`061` are `DONE` with exact responses in
  `requests-to-backend.md`. The result boundary, profile/store parity, mounted stateful stubs,
  deployed auth/telemetry assembly, telemetry subject/privacy rules, unload transport, Vite
  reachability and client transport codes all have executable negative and positive controls.
- D1 now matches the recorded decision. Production has only the Supabase REST adapter and refuses
  the local scrypt provider. Provider identity uses the constrained `identity_provider` /
  `identity_subject` pair from migration 0021; provider tokens are never platform sessions.
  `email_confirm:true` is deliberate because Overstrike owns the separate verification/setup
  gate. Unknown local-test accounts still pay dummy-KDF work. Signup compensation preserves the
  original failure, and recovery is a reserved-token resumable saga rather than an uncompensated
  provider-first update with a spent link.
- Telemetry unload has one design, not the prior contradictory pair: same-origin Beacon to
  `/v1/telemetry/unload`. Its cookie is endpoint-scoped/httpOnly/Strict, current-nonce rotated,
  expires at 15 minutes, and revalidates the live unrevoked platform session on every use.
  Build/correlation/delivery metadata is body-validated, `deliveryId` is transactionally reserved,
  client body identity is ignored, signed-out personal remains receipt/session-bound, and internal
  remains identity-free. Normal delivery still waits for `202`; unload explicitly uses the
  response-independent at-most-once trade recorded in telemetry 2.0.

### Evidence run on this tree

- `node scripts/platformtest.mjs`: **2,494 checks, 15 suites, zero failures** on memory.
- PostgreSQL platform aggregate within `node scripts/pgtest.mjs`: 23 migrations through 0024
  applied, **2,918 checks, 15 suites, zero failures** on PostgreSQL 16. The same run's separate
  P2 second-room lobby assertion is tracked below and is not counted as P0/P1 evidence.
- `node scripts/viteproxytest.mjs`: Chromium drove the Vite `/v1` proxy through a stateful
  scenario across navigation, exact correlation echo, scoped Secure/httpOnly cookie carriage and
  reload refresh.
- `identitytest.mjs`: **13/13** Supabase admin-create/password-grant/update/delete shapes,
  `email_confirm:true`, provider-subject binding, generic 5xx mapping, no service-role material in
  errors, production local-provider refusal, and dummy-KDF unknown-user work.

One initial aggregate run hit the existing wall-clock-sensitive two-second stub delay assertion;
the isolated suite immediately passed and the complete clean rerun above passed. This is recorded
as a test flake rather than erased or counted as a product failure.

### P0 and P1 gates — exact remaining evidence

| Gate | Current truth |
|---|---|
| P0 contracts/design/guard | 13 contract headers are frozen, six CX design documents exist, and the lane guard has deliberate-failure evidence. |
| P0 contract sufficiency | The CX status file contains historical blocker tables but no new explicit final sufficiency attestation after REQ-CC-045–061. Do not infer a human/CX sign-off from backend green tests. |
| P0 decisions | D1–D5 are recorded working decisions. D6 remains a working engineering default and still requires professional legal review before P8/P11; this entry does not declare that review complete. |
| H1.1 | Backend/browser proof is executable and green through Vite. A current CX acceptance statement is still separate review evidence. |
| H1.2 | Local and PostgreSQL auth/profile/telemetry switching is executable. A live production Supabase switch is externally blocked because the deployed platform has no provider URL/service-role secret. |
| H1.3 | Executable local and PostgreSQL lobby acceptance sends an explicit client W3C trace on one six-client launch, retains that trace through platform allocation/control and game-server spans, joins the durable `match.allocated` outbox event by correlation, and reads it through the service-only redacted incident timeline. The code/evidence gate is complete; deployed alert delivery remains the external hold below. |
| P1 observability exit | Code-complete: bounded service metrics, route-template latency, health/outbox/dead-letter/5xx alert signals, service-auth platform and game-server metrics, and a correlation-indexed incident timeline are executable. The timeline omits payloads and actor/subject IDs; trace attributes are closed/redacted. Production readiness intentionally reports alerts down until the secret webhook is configured and probed. |
| P1 migration exit | PostgreSQL 16 scratch rehearsal and forward replay are green. Production rollout remains a deployment action. |

### Required production identity configuration

The platform must receive all three values; none may be replaced with the local provider:

```text
PLATFORM_IDENTITY_PROVIDER=supabase
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<secret>
PLATFORM_MAIL_TRANSPORT=resend
PLATFORM_MAIL_FROM=Overstrike <accounts@<verified-domain>>
PLATFORM_MAIL_API_KEY=<secret>
PLATFORM_ALERT_WEBHOOK_URL=https://<incident-relay>/<secret-route>
```

Fail-closed boot was rechecked twice: production without the provider selector reports
`PLATFORM_IDENTITY_PROVIDER=supabase is required in production`; selecting Supabase without its
two credentials reports `SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the Supabase
identity provider`. No fallback is installed or permitted.

Supabase provider compensation now treats only 2xx and 404 deletes as success; transport, 5xx,
and other refusals are surfaced and logged without masking the original signup failure. The
production identity readiness probe also audits provider users carrying Overstrike account
metadata and reports orphan/mismatched subjects by count, never address or provider credential.
This prevents a failed database commit plus failed delete from being reported as reconciled.

### Identity cutover correction — REQ-CC-070

The initial closure above missed existing rows. The production audit found nine accounts, all with
legacy `password_hash` values and null provider subjects. Enabling the configured Supabase adapter
would therefore strand all nine: signin could not bind the returned Supabase user and recovery
could not name a provider user to update.

The code path is now closed without weakening D1. `npm run identity:cutover` is dry-run by default;
`-- --apply` provisions/resumes exact account-bound provider users, assigns a random undisclosed
credential, transactionally records the Supabase subject while clearing the old KDF and revoking
sessions, and requires the ordinary recovery flow. Database failure compensates a new provider
user, and an interrupted run adopts only a user whose provider metadata names that same account.
Production boot queries all live identities and refuses any remaining local hash, non-Supabase
provider, or missing subject.

This is **code-complete but operationally blocked**. The Supabase project and
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` do not exist on the Fly app, so no provider users have
been created and the nine production rows have not been changed. Required deployment sequence:
configure Resend, prove verification and recovery canaries from its verified domain, apply
migration 0021, capture a blocker-free dry-run, run explicit apply in a maintenance window,
capture the zero-candidate post-run, then deploy the Supabase-only process. The Fly app currently
has no mail transport/API-key/From secrets, so the cutover would leave every migrated user with an
unknowable password and no recovery path. Until both provider and mail evidence exist, H1.2's live
provider switch and the platform deployment remain open.

The updated aggregate counts above include nine focused cutover state-machine/production-boot
checks, six mail-security/configuration checks, and memory/PostgreSQL identity-readiness
conformance. A later full `pgtest` invocation passed the then-current platform portion, then failed
in the concurrently edited P2 lobby
normal-completion/rematch acceptance. That P2 failure is not counted as P0/P1 green evidence and
does not alter this lane's external Supabase deployment block.

### 2026-08-21 P1 client/authority/observability closure addendum

- The shell client now applies closed success validators before UI/session mutation across auth,
  consent, flags, own/public profile, settings, room list/detail/create/join/mutations, career,
  active/reconnect match and terminal-result surfaces. Unknown, omitted and wrong-typed 2xx
  projections become `CLIENT_PROTOCOL`; protocol failures are no longer swallowed by optional
  presence loading.
- `overstrike.progress.v1` is explicitly practice/unverified authority. Authenticated network
  entry swaps it out before `Game` construction for a mode-scoped server career projection;
  local match award/write paths are disabled, server weapon/career totals are displayed, and
  network exit restores the unchanged practice blob. The authenticated one-shot legacy import
  preserves that blob, stores only the separate `verified:false` inert projection, and never
  merges it into career/result authority.
- The production runtime deduplicates facade `matchEnded`, carries its exact match/status/reason
  and server-derived completion/mode into `restoreShell`, and passes the shell-owned first-match
  marker. A forged/local `toMenu` payload cannot claim a completed network match.
- Browser proof: `uishell` passes **1,283 assertions**, including modified-localStorage isolation
  and the exact production `onExit` shape. `viteproxytest` passes the real Vite proxy/cookie/
  correlation/reload path. `lobbytest` proves a supplied trace across client, platform, game
  server and durable event while asserting the incident response contains no subject ID.

External holds remain exact: no Supabase project/provider secrets, no Resend From/API secret or
verification/recovery delivery canary, nine legacy accounts not yet cut over, no alert-webhook
secret/delivery probe, and D6 professional legal review still required before P8/P11. No deploy
may turn any of those into a local-production fallback or a claimed human sign-off.

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
