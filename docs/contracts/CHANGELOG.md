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

## 2026-08-20 — `match-result.md` 1.8.0, `http-api.md` 1.10.0, `telemetry.md` 1.10.0, `errors.md` 1.6.0, `net-facade.md` 1.9.0, `bomb-rules.md` 1.7.0, `db-schema.md` 1.7.0 (additive) — REQ-CC-043 and REQ-CC-044 closed, REQ-CC-042 finished

Seven contracts, one amendment, because the findings were one defect wearing seven hats: a rule
written in one place and *referenced* in six, where the reference had drifted or the referent had
never been written at all.

**The section four contracts cited did not exist.** `wire-protocol.md` §8.9, `net-facade.md`
§5.3 and §8, `bomb-rules.md` §9 and `platform/src/core/store.js` all cite "the
`match-result.md` §4.0 outcome matrix" as the authority for which `(status, outcomeReason,
winnerTeam)` tuples are legal. There was no §4.0. The rule lived in §4.2's invariant table under
another name, so five citations pointed at a section number and the sixth — the code — had
copied the rule out. §4.0 now publishes the six-row matrix once, and §4.2 refines it.

**`draw` implies `timer`, everywhere now.** The §4.2 table permitted `winnerTeam: "draw"` beside
elimination, defuse and detonation. `wire-protocol.md` §8.9 has forbidden that since v2 landed,
and commit `60f059e` put the rule in the store validator and in a database `CHECK` — but not in
this contract, so the document a client generates types from still said a drawn elimination was
representable. Written down here at last.

**`ResultSubmission` (§5.1).** `http-api.md` §11.8 asked producers for "the full
`match-result.md` §4 record" — a section containing the pending variant, the response-only
correlation envelope and three response tables. It is now a named type: the §4.2 field set,
terminal status only, without `correlationId`/`retryAfterMs`, plus optional `roomId`/`serverId`,
with the path/body/idempotency-key binding stated. The platform now **refuses** an unknown or
response-only key rather than dropping it, because a key we silently ignore is a key the sender
believes we honoured.

**The three pending sub-states (§4.2).** `startedAt` was fixed to a timestamp while an
`allocated` row has none by definition, so the first state the platform creates was the one the
response could not express. It is nullable, and the table now names all three rows —
`allocated`, live, ended-and-queued — with the two timestamps that distinguish them and the
transition that produces each.

**The authorized round projection (§4.2).** §4.1 said objective actors are always stored and
that whether they are returned "depends on §4.2"; §4.2 said nothing about them. It now gives the
exact per-caller table, including that a redacted plant is `{ accountId: null, … }` and never a
missing key.

**Invalidation is submission-time only (§5.2), and that is a restriction we are writing down
rather than a gap we are hiding.** `event-envelope.md` §6 catalogues `match.invalidated` with an
`admin` actor and no command can produce one. An honest administrative invalidation needs an
append-only command plus a compensating career delta; neither exists in this phase, so a
completed match has no outgoing transition and a second submission is refused. The two things it
would need are named so the next person does not add half of them.

**The aggregation matrix (§6.1).** §6 said only "invalidated matches do not aggregate", so
forfeit, abandon and no-contest were inference — and `bomb-rules.md` §9 inferred differently.
One row per §4.0 outcome now, plus what `result_applied_at` means on a submission that
aggregates nothing (the application ran; no career changed) and when `match.result_applied` is
emitted.

**`bomb-rules.md` §9** now names `outcomeReason: forfeit` for a team dropping to zero connected,
where it previously said only that "the remaining team wins" — a sentence from which a producer
cannot construct a legal §4.0 tuple. `forfeit` and not `abandon`: the rule fires on an
observable fact about the match, while `abandon` is a per-player sanction judgement.

**`net-facade.md` §5.3: `matchEnded` is PROVISIONAL.** The facade claimed the outcome carried
everything the results screen needs. It carries everything the *wire* has, and no wire field
holds an invalidation reason. Rather than change the protocol for a value that arrives after the
match server has stopped talking to the client, the socket result is declared provisional and
the results screen must fetch `GET /v1/matches/:matchId` — mandatory before rendering anything
about an invalidated match.

**`http-api.md` §11.5** stops restating the history item and defers to `match-result.md` §4.3.
The copy here was the pre-1.7 shape: it admitted `status: "pending"` while fixing `endedAt` to a
timestamp and always supplying `result`/`teamScores`/`playerSummary`, so the one status the
union added could not be serialised by the schema that admitted it.

**`db-schema.md` §4** publishes the `matches` CHECK constraints. They were in migrations 0012,
0013 and 0016 and not in the contract, so the schema as published permitted rows the union
forbids and a reader generating a fixture from it produced data the database refuses.

**`errors.md` 1.6.0 adds `CONSENT_RECEIPT_INVALID`** and `telemetry.md` §3.3 carries it on the
202 as `consentReceiptError` (REQ-CC-042). An expired, forged or subject-mismatched consent
receipt silently discarded every personal event in the batch and the reason went to a server
log; the client saw `{accepted: 0}` and had no way to tell which of a dozen causes it was
looking at, so the one recovery available to it — going back to consent — was unreachable. A
*valid* receipt recording a decline is deliberately not this error: the player answered, and
must not be asked again.

**Two smaller REQ-CC-042 residues.** `telemetry.md` §3.3 now binds "the batch's correlation id"
to the `X-Correlation-Id` request header, which §3.5.1 had been forbidding reuse of without
anything defining it. And the "nine steps × three outcomes" count in §3.2 was written when the
`flow.step` enum had nine entries; it has eleven.

**One defect this round was in the code, not the document.** `funnel.preconsent` carried
`retentionClass: 'standard'` in `platform/src/modules/telemetry/registry.js` while §5's
amendment giving it its own **internal, short (30 d)** row had already landed. The amendment
was made in the contract and not in the implementation, so an unlinked pre-consent count was
being kept thirteen times longer than the contract said — a retention breach that reads as a
one-word typo. `platform/test/contracttest.mjs` now parses §5's stream table and compares it
with the registry, so the two cannot diverge again silently.

**How these were found, and the new suite.** Every claim above was verified by opening the file,
not by reading the commit that claimed to have fixed it — two of the twelve had been reported
fixed and were not. `platform/test/contracttest.mjs` is the durable version of that check: each
assertion **parses** the normative sentence out of the contract and then drives the real platform
over a real socket to assert the behaviour that sentence promises. A check that only parsed the
document would pass on prose nobody implemented; one that only drove the service would pass on
an implementation nobody documented. It went red 29 / green 0.

Additive throughout: no field is removed or retyped and no stored value changes meaning.
Refusing unknown and response-only keys on `POST /v1/matches/:matchId/result` is the one
behaviour change, and it tightens a service-only endpoint against payloads no correct producer
sends.

## 2026-08-20 — `db-schema.md` 1.6.0 (additive) — consent and idempotency retention

Two records with a contracted life that nothing ever ended.

**`pre_auth_consent` is deleted at signup, not stamped.** `http-api.md` §3a.3 says the
signed-out row "is deleted on migration at signup, or on expiry", and `db-schema.md` §2 and
migration `0001` both repeat it. The implementation stamped `migrated_at` and kept the row.
Reads treated a stamped row as absent, so the decision was correctly ignored — and retained,
for the whole remainder of its 30-day TTL, as a standalone consent record keyed by a client
session, sitting beside the account it had already been copied onto. A record we have decided
to stop reading is not a record we have deleted; that distinction is the entire subject matter
of a retention obligation. `markMigrated` is replaced by `deleteFor` on both adapters. The
column and its partial index stay — dropping a column is a CCR, and both adapters still force
it to null on write so a backfilled row carrying a stamp cannot make a live decision read as
already-carried. §2 now says the column is always null and why.

**`idempotency_keys.expires_at` is nullable, and NULL means permanent.** `http-api.md` §8 sets
two retention classes — "24 h for gameplay, permanent for value-bearing operations" — and the
column was `NOT NULL`, so the second could not be expressed at all; a value-bearing row would
have needed a far-future sentinel a sweep would eventually honour. Worse, there was no sweep:
every writer stamped `expires_at` and nothing ever read it again, so the declared retention was
a column rather than a policy and the table kept a row forever for every profile PATCH, every
match result, and every burnt eligibility-receipt nonce. The nonce rows are onboarding
evidence. `store.idempotency.sweepExpired` now exists on both adapters, skips NULL, and is run
hourly by the composition root — deliberately NOT paired with an expiry check on read, because
honouring a row slightly past its window costs nothing while refusing it re-executes a write
the client already believes happened.

Migration `0017_idempotency_retention.sql`.

Additive: no field is removed or retyped, no stored value changes meaning, and a `NOT NULL`
becoming nullable cannot break a writer that was already supplying a value.

## 2026-08-20 — `net-facade.md` 1.8.0 (additive) — §8 scenario table, and a correction

**A claim I made twice was false, and this entry exists to say so.** Answering `REQ-CC-041` I
wrote that the facade stub section had gained Bomb carried/dropped-visible/dropped-hidden/
planted scenarios and one per outcome-matrix row. Answering `REQ-CC-045` I repeated it as
established fact to argue a reviewer finding was mistaken. `git log -S` confirms those strings
never existed in the file: I described an amendment I had not made, and then cited it.

§8 now actually carries the table — 18 scenarios covering every §4.0 outcome-matrix row, all
four Bomb position states, the per-phase spectator policy, and the terminal handshake failures.
The stub layer already implements them; only the contract was missing.

Additive: no existing scenario name or shape changed.

The lesson is narrower than "check your work". Describing an edit and making it are separate
acts, and a response written from intention rather than from the file is indistinguishable from
one written from the file — until someone greps.

## 2026-08-20 — `http-api.md` 1.9.0, `telemetry.md` 1.9.0 (additive) — REQ-CC-042 contradictions closed

**Version collision, recorded because it happened.** This amendment and the display-name
preflight below were written concurrently and both claimed `http-api.md` 1.8.0. The other
landed first, so this one is 1.9.0. Two amendments silently sharing a version is precisely
what this file exists to make visible, and it is only visible because both were written down.

Five stale projections that survived the 1.7 canonical rewrite, each located with a file:line
by an implementing agent rather than by reading. Same failure mode as every earlier round: the
canonical section was corrected and a duplicate copy elsewhere was not — and a duplicate that
disagrees is worse than no duplicate, because both look authoritative.

- `telemetry.md` §3.1 said personal `flow.step` runs "from `consent` onward". It begins at
  **`signup`**, matching the registry, §3.5 and `http-api.md` §3a.5. `consent` belongs to
  `funnel.preconsent`.
- `http-api.md` §3a.3 said the receipt is "replayed on every telemetry batch". It is replayed on
  batches carrying **personal** events; §3.5 and §11 already said so and this line contradicted
  them.
- `consent` was typed as the literal `true` in three places, so a recorded **decline** had no
  member of the union — the one answer we most need to store could not serialise. Now `bool`.
- `consentReceipt` was appended as a second object after a closed success body. It is a key
  **inside** the signup/signin success object, which is what the service returns.
- One `Funnel/KPI | personal` retention row covered `funnel.preconsent`. Preconsent now has its
  own row — **internal, short (30 d)** — because §5 requires every stream to declare both
  classes and an internal-unlinked event was inheriting a personal one.

All additive: no shipped field changed shape or meaning. Typing `consent.telemetryPersonal` as
`bool` widens a union that could not previously express a decline, which the implementation was
already capable of producing.

## 2026-08-20 — `http-api.md` 1.8.0 (additive) — display-name preflight, resume step, full coverage matrix

Three amendments, all additive, all raised by the H1.1 stub review. **No shipped shape changed
meaning**: every field named below is new, and nothing that existed was renamed, retyped, or
given a different sense.

**1. `POST /v1/auth/display-name/check` — new §3b (`REQ-CC-046`).** P1 B3 and the frozen
`design/first-run-flow.md` §3 both require debounced live availability with policy feedback, and
this API exposed only mutation-time `NAME_TAKEN` / `NAME_POLICY_VIOLATION`. The display-name
screen was therefore unbuildable without the client reproducing the ruleset — the one thing that
section forbids. One rate-limited endpoint, an exact `{ available, policy }` body, server-side
normalisation, and four properties written down because each is load-bearing: policy is evaluated
before existence, a taken name reveals nothing about who holds it, nothing is reserved, and
signup/rename stay authoritative and may still lose the race. Cooldown is deliberately **not**
answered here — it is account state, not a property of the candidate, and it already rides in
§4 `flags.nameChangeAvailableAt`.

**2. `flags.setupNextStep` in §4 (`REQ-CC-045`).** `first-run-flow.md` says the shell "resumes at
the first incomplete account-policy step returned by the platform" and no response returned one,
so a returning half-onboarded player could only find the step by provoking a 403 from a gameplay
route it had no reason to call. §11's "anything not stated is forbidden" meant an implementation
could not simply add it either. It is a routing hint; the `errors.md` gate codes remain what
actually enforces the order.

**3. §11.11.1 — the route × variant matrix (`REQ-CC-045`).** §11.11 owned 13 of the 27 routes
`design/shell-ia.md` declares and named no variant for any of them, so 14 routes and every
loading/empty/error/offline/policy state had no owning scenario. The new matrix gives every cell
either a runnable scenario, a lobby timeline, or an `n/a` with its reason, and
`platform/test/stubtest.mjs` parses it: a row with no owner fails the build rather than being
discovered as a missing screen.

**§11.10 gains `X-Stub-Account-Id`**, the stub-only header that groups two client sessions into
one account. Without it the session list, revocations and `signout-all` lived once per tab, so
cross-tab revocation — a state `shell-ia.md` requires the `/sessions` screen to render — could
not be produced at all.

**§9 gains one row** for the name-check class. It is separate from the Auth class deliberately:
the check is public and unauthenticated, and sharing a bucket with sign-in would let name checks
exhaust the limit sign-in depends on.

**Two things this amendment does NOT do, recorded so they are not mistaken for done.**
`net-facade.md` §8 names eight generic timelines and none of the Bomb-visibility,
outcome-matrix or spectator-policy-phase rows an earlier response to `REQ-CC-045` claimed were
already there; the stub implements them and declares them as extras, but naming them in §8 is a
further additive amendment. And `realtime-lobby.md` §10's catalogue is unchanged.

## 2026-08-20 — `telemetry.md` 1.8.0 (additive) — internal records carry no identity

**Provenance defect, recorded because it was mine.** §3.5.0 landed in commit `9c439c8` with no
version bump and no entry here — an amendment to a FROZEN contract, made one commit after I
wrote the rule that every amendment lands in this file. "An amendment that skips this file did
not happen"; this one nearly did.

The change itself (`REQ-CC-055`): the contract asserted both that `internal` carries no personal
data and that `accountId` is bearer-derived, without saying which events the second applied to,
so an authenticated `client.fps` was stored linked to an account and still labelled internal.

§3.5.0 now states one rule: an internal-class record is persisted with `accountId: null` and
`clientSessionId: null` even when the request is authenticated, retaining only the request
correlation id. Additive — no shipped field changed shape or meaning; a field that was
sometimes populated is now always null, which no consumer can have depended on without
depending on the leak.

Reclassifying crash and performance events as `personal` was the alternative and was rejected:
it would put ordinary crash reporting behind consent, so a player who declines analytics also
stops us diagnosing the crash that lost them the match.

## 2026-08-20 — ALL 13 CONTRACTS FROZEN at 1.7.0

Frozen on the human owner's explicit instruction not to wait for a further review round
("Don't wait for the final approval from Codex, we need to proceed").

**This is a decision to proceed, not a claim of perfection.** Seven review rounds produced 41
answered requests and the findings were still narrowing rather than stopping — round seven
returned three, and the eighth (`REQ-CC-042`…`053`) returns twelve, several probing commits
that have since been superseded. The judgement is that the remaining findings are the kind an
implementation surfaces in minutes, and that a frozen-but-amendable contract unblocks two lanes
where a perfect-but-open one blocks both.

### What FROZEN means here

- **Buildable now.** The other lane may generate types, reducers and clients against these
  documents and treat them as stable.
- **Amendable, not immutable.** Additive changes bump the minor version and land with a
  changelog line, exactly as before. Breaking changes need a CCR and a dual-support window.
  Nothing about the amendment path changes.
- **Open findings stay open.** `REQ-CC-042`…`053` are not closed by this freeze. They are
  tracked, several are already fixed in code, and each will land as a normal amendment.

### Known-open at freeze, with honest severity

| Request | Severity at freeze |
|---|---|
| `042`, `043`, `044` | Stale duplicate projections and unreachable lifecycle states. Real, and none blocks a client that builds to the canonical section rather than the stale copy |
| `045`, `046`, `050` | Stub coverage gaps and a missing display-name check endpoint. These genuinely limit what the shell can build; the stub layer is now MOUNTED, which was the hard blocker |
| `047` | **Fixed at freeze** — the lane map assigned a CX-owned file to CC |
| `048`, `051` | **Largely fixed at freeze** — probed against `681a116`, which predates the cookie, header, build-floor, correlation and assembly-test work |
| `049`, `052`, `053` | Real-store and privacy invariants. Substantially fixed; residue tracked |

Freezing with known-open findings is a deliberate trade. The alternative — an eighth round
before either lane may build — has a worse expected outcome than amending under implementation
pressure, because implementation is what has been finding the defects that review missed.

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
