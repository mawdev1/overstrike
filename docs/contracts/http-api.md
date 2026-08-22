# Contract 1 — Platform HTTP API

| | |
|---|---|
| **Status** | `FROZEN` — amendments follow CHANGELOG.md |
| **Version** | 2.2.0 |
| **Scope** | Phases P1–P4. Extraction, agent, economy, creator surfaces are later contracts |
| **Owner** | [CC] Claude Code |
| **Consumers** | [CX] client HTTP layer, match server, Admin Portal |

---

## 1. Conventions

- Base path `/v1`. Breaking changes mint `/v2`; additive changes do not.
- JSON in, JSON out, UTF-8. `Content-Type: application/json`.
- Every request carries `X-Correlation-Id` (client-generated ULID); the server echoes it and
  puts it in every log line and event the request causes. If absent, the server generates one
  and returns it — but a client that omits it cannot correlate its own bug reports.
- Client HTTP requests also carry W3C `traceparent`. The platform propagates the same trace and
  correlation through match-control calls. Correlation-only lobby frames deterministically map
  back to that trace; trace context is never put in player tickets or business payloads.
- Every request carries `X-Client-Build`. Below the supported floor → `UNSUPPORTED_CLIENT`.
- Errors follow `errors.md` without exception.
- Timestamps are ISO-8601 UTC with milliseconds. IDs are ULIDs as strings.
- **No endpoint returns a partial success.** A 2xx means the whole operation happened. An
  endpoint's owning contract may declare, explicitly and in its own text, an atomic unit smaller
  than the whole request — for example one participant of a multi-participant submission. When it
  does, a 2xx means every declared unit reached its own defined terminal state, not that every
  unit's effects were identical; the endpoint's contract states the per-unit terminal states this
  can mean. This is an explicit opt-in an endpoint's contract must state, not a default any
  endpoint gets by omission — an endpoint that says nothing about a sub-request atomic unit is
  still held to "the whole operation happened." (`settlement.md` §5.3, `POST
  /v1/runs/:runId/result`, is the first and so-far only endpoint that declares one.)

## 2. Authentication

`Authorization: Bearer <accessToken>`. Token model in `auth.md`. Endpoints below are marked
**A** (authentication required), **P** (public), or **S** (service-to-service only, mTLS or a
service token — never reachable from a browser).

## 3. Auth endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/auth/signup` | P | Rate limited hard. Returns tokens + profile |
| POST | `/v1/auth/signin` | P | Same failure envelope whether the account exists or not |
| POST | `/v1/auth/refresh` | P | **Empty body.** Refresh travels only as an httpOnly cookie — see §11.1 |
| POST | `/v1/auth/signout` | A | Revokes the current session only |
| POST | `/v1/auth/signout-all` | A | Revokes every session including the caller's |
| GET | `/v1/auth/sessions` | A | Device, IP class, user agent class, created, lastSeen, current |
| DELETE | `/v1/auth/sessions/:id` | A | Revoke one; effective immediately, not at next expiry |
| POST | `/v1/auth/recovery/start` | P | Always 202, whether or not the account exists |
| POST | `/v1/auth/recovery/complete` | P | Consumes a single-use token; revokes all sessions |
| POST | `/v1/auth/display-name/check` | P | **Added by REQ-CC-046.** Availability preflight. Rate limited. Advisory — see §3b |

**`/v1/auth/sessions` returns an IP *class* (country/region), not a raw address.** A session
list is readable by anyone who has the account, including someone who just stole it; handing
them the owner's home IP makes a compromise worse.

## 3a. Onboarding: eligibility, verification, terms, consent (REQ-CC-017)

Four gates stood between a visitor and a first match, each referenced by some contract and
**none of them implemented**: `auth.md` required eligibility before sensitive data while signup
posted a birthdate with everything else; `errors.md` routed `AUTH_VERIFICATION_REQUIRED` and
`AUTH_TERMS_ACCEPTANCE_REQUIRED` to UI states no endpoint could clear; and `telemetry.md`
gated personal events on a consent state that lived nowhere. The chain, in order:

**The approved order (REQ-CC-028).** This is the one order recorded here, in `auth.md` §11,
in `telemetry.md` §3.4, and in `design/first-run-flow.md`:

```
1. landing                            → internal-class telemetry only (see §3a.5)
2. POST /v1/onboarding/eligibility    → age gate. No account, no birthdate retained
3. PUT  /v1/onboarding/consent        → telemetry consent, asked ONLY of eligible visitors
4. POST /v1/auth/signup               → account created; consent migrated; refresh cookie set
5. POST /v1/onboarding/verify/...     → clears AUTH_VERIFICATION_REQUIRED
6. GET/POST /v1/onboarding/terms      → clears AUTH_TERMS_ACCEPTANCE_REQUIRED
```

**Eligibility precedes consent, deliberately.** `auth.md` §11 records that under-13 visitors
generally cannot give valid consent alone, so asking for consent first would mean soliciting it
from exactly the people who cannot give it. Gating first means we never ask.

The cost is that steps 1 and 2 happen before any consent decision exists, so they cannot emit
personal-class telemetry — see §3a.5. That is a real limitation, stated rather than papered
over.

**This ordering rides on the D6 working default and needs the same legal review.** Whether a
13-year-old's own consent is sufficient in every jurisdiction served is a question for that
review, not for this contract.

### 3a.1 Eligibility preflight — **no birthdate is stored**

```http
POST /v1/onboarding/eligibility      P
{ "dateOfBirth": "1994-03-02", "jurisdiction": "CA-ON" }

200 → { "eligible": true,
        "receipt": "opaque-signed-token",     // carries the verdict, policy version, expiry
        "expiresAt": "…",                     // 30 minutes
        "policyVersion": 1,
        "correlationId": "…" }
403 → AUTH_ELIGIBILITY_DENIED, details: { "category": "under-minimum-age" }
```

**`minimumAge` is not returned (REQ-CC-022).** The gate is neutral — it must not reveal the
number it is testing against, or the next attempt simply clears it. The earlier success
response published `13`, which defeated the neutrality the gate exists for. `policyVersion`
identifies which rule ran without saying what the rule is.

The **receipt** is opaque and signed, binds the verdict to a policy version, and expires in
30 minutes. Signup consumes it; a client cannot mint one, and one obtained for a different
jurisdiction or policy version is rejected.

The birthdate is evaluated and **discarded**; only the derived boolean and the policy version
are persisted, at signup. This is why the preflight is separate from signup: `auth.md` §11
requires eligibility *before* sensitive data is collected, and the cleanest way to honour that
is to never store the most sensitive field at all. `details.category` never echoes the date or
the computed age.

Signup therefore takes `{ email, password, displayName, eligibilityReceipt, clientSessionId,
consentReceipt }` — **no `dateOfBirth`**. `clientSessionId` and `consentReceipt` are **required, not optional** (REQ-CC-034): the
approved order always reaches a consent decision before signup, so a signup without them is a
client that skipped a step. They migrate the signed-out decision onto the new account, and
signup returns a fresh account-scoped `consentReceipt` that replaces the session-scoped one on
subsequent telemetry batches.

The only exception is an account created before this policy version existed; such accounts
carry `consent: null` (undecided) and are prompted on next sign-in. There is no exception for
new signups.

Signup errors include **`ELIGIBILITY_RECEIPT_INVALID`** — expired, forged, or issued against a
different policy version.

### 3a.2 Verification and terms

```http
POST /v1/onboarding/verify/resend     A   → 202
POST /v1/onboarding/verify/complete   A   { "token" } → 204
   errors: AUTH_VERIFICATION_TOKEN_INVALID · AUTH_VERIFICATION_TOKEN_EXPIRED

GET  /v1/onboarding/terms             P   → { "version", "url", "publishedAt", "correlationId" }
POST /v1/onboarding/terms/accept      A   { "version" } → 204
   errors: CONFLICT — details: { "currentVersion", "url", "publishedAt" }
```

**Verification has its own error codes (REQ-CC-022).** It previously reused the recovery
codes, whose documented UI obligation is "restart recovery" — so a failed email verification
would have sent the player into a password-reset flow.

**Every 204 in this contract returns `X-Correlation-Id`.** A body-less success is still an
event someone will need to trace, and it is the only place the id can travel.

### 3a.3 Consent — a distinct record

Consent is **not** eligibility and **not** profile visibility. Conflating them was the original
error: `telemetry.md` pointed at "auth §11 / HTTP §4", which define age and who can see a
profile — neither is a decision about analytics.

```http
GET /v1/onboarding/consent    auth OPTIONAL   ?clientSessionId=01J…
PUT /v1/onboarding/consent    auth OPTIONAL
{ "telemetryPersonal": bool, "policyVersion": int, "clientSessionId": "01J…" }

→ { "telemetryPersonal": bool, "policyVersion": int, "decidedAt": "…",
    "currentPolicyVersion": int,           // ALWAYS present, never null — the version in force
    "subject": "account|client-session",
    "receipt": "opaque-signed-token",      // replayed on batches carrying PERSONAL events (§3.5)
    "correlationId": "…" }
```

**`policyVersion` and `currentPolicyVersion` are different facts.** `policyVersion` is the
version the player DECIDED under and is `null` while undecided; `currentPolicyVersion` is the
version in force and is always an integer.

Both are needed because `PUT` requires `policyVersion` in its body, and before this key existed
nothing in the API told a caller which version to send. A signed-out client had no declared way
to obtain it — the deployed shell disabled both consent buttons for exactly that reason, so
onboarding stopped at the privacy step with nothing to click and no error to report.

They are separate keys rather than one field that falls back, because filling the decided field
with the current version claims a decision nobody made, and `decidedAt: null` beside
`policyVersion: 1` is a contradiction the reader has to unpick. It also makes staleness legible:
a non-null `decidedAt` with `policyVersion < currentPolicyVersion` means "decided, under an
older policy" — precisely when a client should ask again.

`clientSessionId` is **required when signed out** and ignored when authenticated — the account
is the stronger subject. The response carries a signed `receipt`, without which the server
cannot tell a consented pre-auth batch from an unconsented one.

**The receipt is required on batches carrying personal-class events, not on every batch**
(REQ-CC-039). An internal-only pre-consent batch carries no receipt and no `clientSessionId` —
`telemetry.md` §3.5.1. An earlier line here said "every batch", contradicting that.

**Sign-in returns the account-scoped receipt.** `POST /v1/auth/signin` includes
`consentReceipt` (or `null` when consent is undecided) in its success body, exactly as signup
does. Without it a returning player had no declared way to obtain one and would have had to
guess at calling `GET /v1/onboarding/consent`, which is not a contract.

Auth-optional because the funnel starts before an account exists. Signed out, the decision is
keyed to `clientSessionId`; at signup the decision migrates to the account and a new
account-scoped receipt is issued.

**Consent is captured after eligibility and before signup**, per the approved order above.
An earlier draft placed it at landing; that is superseded, because it would have asked for
consent before establishing that the visitor can give it (REQ-CC-034).

`consent: null` in a profile means **undecided** — an account predating this policy version has
no decision recorded and is treated as no consent. The profile field is explicitly
**object-or-null**, never absent.

**Storage.** The typed columns in `db-schema.md` §2 (`consent_telemetry`,
`consent_policy_ver`, `consent_decided_at`) are the source of truth. `accounts.privacy` holds
visibility only; the §3a.3 sketch that put consent inside it is superseded, because a legally
significant decision belongs in constrained columns rather than a JSON blob nothing validates.

**Signed-out consent** is stored keyed by `clientSessionId` with a **30-day TTL**, holding the
decision, policy version, and decision time. It is deleted on migration at signup, or on
expiry. It is not an account and is never joined to one except by the receipt presented at
signup.

### 3a.5 What is intentionally unmeasurable (REQ-CC-028)

Steps 1 and 2 precede the consent decision, so their events cannot be personal-class. Rather
than claim a complete funnel:

| Step | Class | Linkage |
|---|---|---|
| `landing`, `eligibility`, `consent` | **internal** | **Unlinked aggregate counts.** No `clientSessionId`, no reused correlation id (`telemetry.md` §3.5.1) |
| `signup` onward | personal, if consented | Linked by `clientSessionId`, then by account |

So funnel **volume** at the top is measurable; per-visitor **paths** through those steps are
not, `time_to_first_match_sec` is measured from **signup**, and **decline rate is not
measurable at all** — the consent screen is counted, the answer never is. `telemetry.md` §3.1
and §3.5.1 state the same limits, so the two documents cannot drift apart on what the KPI
means.

**Until a decision exists, personal-class events are dropped, not queued.** Queuing them
against a later "yes" would mean collecting first and asking afterwards. `internal`-class
events flow throughout (`telemetry.md` §3.4) — declining analytics is not a reason to stop
being able to diagnose a crash.

### 3a.4 Two conventions this fixes

- **`VALIDATION_FAILED` is always HTTP 400.** §11.2 returned 428 for a missing `If-Match`; that
  is now `CONFLICT` (409) with `details.reason: "if-match-required"`. One code, one status, or
  the client cannot branch on status at all.
- **Signup and signin set the refresh cookie.** `Set-Cookie: os_rt=…; Secure; HttpOnly;
  SameSite=Lax; Path=/v1/auth` — stated because §11.1 described rotation on refresh without
  ever saying where the first cookie comes from.

## 3b. Display-name availability — a preflight, not a reservation (REQ-CC-046)

`design/first-run-flow.md` §3 requires debounced live availability and policy feedback while the
player types, and the only authoritative answer this API had was the mutation: you discovered a
name was taken by trying to create the account with it. The screen was unbuildable, and the
alternative — reproducing the ruleset client-side — is the one thing that section forbids.

```http
POST /v1/auth/display-name/check      P   (a bearer token is accepted and changes nothing)
{ "displayName": "Nova Prime" }

200 → { "available": true,  "policy": null, "correlationId": "…" }                  // free
200 → { "available": false, "policy": null, "correlationId": "…" }                  // taken
200 → { "available": false, "policy": { "rule": "impersonation" }, "correlationId": "…" }
400 → VALIDATION_FAILED        // `displayName` absent or not a string
429 → RATE_LIMITED             // with `retryAfterMs`; see §9
503 → SERVICE_UNAVAILABLE      // the check is down; the field stays usable
```

**The body is exactly `{ available, policy, correlationId }`.** `policy` is object-or-null and
never absent: `null` means no rule refused the candidate. When a rule did, it is
`{ "rule": … }` from the closed set `length · charset · reserved · impersonation · profanity ·
confusable` — the id of the rule that refused, and nothing else. The ruleset itself is never
published, or the next attempt simply routes around it, which is the same reason §3a.1 withholds
`minimumAge`.

**Normalisation is the server's.** The client sends the raw candidate. The server applies NFKC,
trims outer whitespace, collapses internal runs to one space, and case-folds for the uniqueness
comparison; the verdict describes that normalised form. A client that normalised first would hold
a second copy of the rule, and the two would disagree the first time either changed.

**Policy is evaluated before existence.** A name that fails policy answers with the rule whether
or not it is also taken — otherwise the endpoint becomes a directory of which reserved names are
in use.

**The enumeration boundary.** A taken name answers `available: false` with `policy: null` and
nothing more. No account id, no display of the holder, no distinguishable shape, and no separate
code: `taken` and `free` differ in one boolean. A session list already refuses to hand over a raw
IP for the same reason — this endpoint is public, and public plus enumerable is a scraped user
directory.

**It is advisory and reserves nothing.** `POST /v1/auth/signup` and `PATCH /v1/profile/me` remain
the only authority. A name that checks free can be taken between the check and the submit, so the
client MUST still handle `NAME_TAKEN` and `NAME_POLICY_VIOLATION` on the mutation. A preflight
that reserved the name would let anyone hold the whole namespace by typing in a box.

**Cooldown is not reported here.** `NAME_CHANGE_COOLDOWN` is a property of the *account*, not of
the candidate, and it is already `flags.nameChangeAvailableAt` in §4. Answering it from a public
endpoint keyed by a name would leak account state to whoever guessed the name.

## 4. Profile and stats

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/profile/me` | A | Full own profile, including privacy and moderation state |
| PATCH | `/v1/profile/me` | A | Display name, roaming settings. Idempotency key required |
| GET | `/v1/profile/:accountId` | A | Public projection, filtered by the subject's privacy settings |
| GET | `/v1/profile/:accountId/stats` | A | `?mode=tdm\|bomb\|all`. Canonical definitions in `match-result.md` |
| GET | `/v1/profile/:accountId/matches` | A | Paginated history, newest first. Includes `aborted` entries |
| GET | `/v1/profile/me/settings` | A | Roaming settings only |
| PUT | `/v1/profile/me/settings` | A | Full replace; `If-Match` on the settings version |
| POST | `/v1/profile/me/progression-import` | A | One-time inert import of the legacy practice blob; never authoritative stats |

`GET /v1/profile/me` response:

```json
{
  "accountId": "01J…", "displayName": "…", "createdAt": "…",
  "privacy": { "presenceVisibility": "everyone|friends|nobody",
               "statsVisibility": "everyone|nobody" },
  // Object-or-null, never absent. null = undecided (§3a.3). Projected from the typed
  // columns in db-schema.md §2, which are the source of truth — not from `privacy`.
  "consent": { "telemetryPersonal": bool, "policyVersion": int, "decidedAt": "…" } | null,
  "moderation": { "status": "clear|restricted|banned", "activeSanctions": [] },
  // `setupNextStep` added by REQ-CC-045. The first incomplete account-policy step, or null.
  "flags": { "nameChangeAvailableAt": "…" | null,
             "setupNextStep": "eligibility|consent|display-name|verify|terms|essential-settings" | null },
  "correlationId": "…"
}
```

**`flags.setupNextStep` (REQ-CC-045).** `design/first-run-flow.md` says the shell "resumes at the
first incomplete account-policy step returned by the platform", and nothing in this contract
returned one — so a returning half-onboarded player could only discover the step by provoking a
403 from a gameplay route it had no reason to call. §11 says anything not stated is forbidden, so
the field could not simply be added by an implementation either.

It is the first incomplete step of the §3a approved order, or `null` when setup is complete. It
rides in `flags` because signup, signin and `GET /v1/profile/me` all embed this object, which
makes the first authenticated response the client already makes the one that answers the
question. It is a *hint for routing*, not an authorisation: the gate codes in `errors.md`
(`AUTH_VERIFICATION_REQUIRED`, `AUTH_TERMS_ACCEPTANCE_REQUIRED`) remain what actually enforces
the order, and a client that ignores this field is refused exactly as before.

**Client settings that must roam** are stored here. Machine-specific ones (resolution,
graphics quality, audio device) stay local — roaming a monitor resolution to a different
machine is a bug, not a feature.

### 4.1 Legacy practice import

The old `overstrike.progress.v1` localStorage value is hostile client-authored data. An
authenticated client may send it once without deleting or promoting its local practice copy:

```http
POST /v1/profile/me/progression-import
{ "progress": { /* parsed legacy blob */ } }

200 → { "source": "localStorage:overstrike.progress.v1",
        "verified": false,
        "importedAt": "…",
        "data": { "schema": int, "xp": int, "lifetime": {…},
                  "weapons": {…}, "challenges": [string] },
        "alreadyImported": bool,
        "correlationId": "…" }
```

The first normalized record is returned on every retry (`alreadyImported:true` thereafter).
It is stored separately from `player_stats`/`player_weapon_stats`, is never merged into career,
rank, unlock, matchmaking or result authority, and can only be labelled as unverified offline
history. Unknown blob keys are dropped; client values are bounded by the ordinary request limit.

## 5. Presence

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/presence/online` | A | Paginated. Filtered by each subject's `presenceVisibility` |
| GET | `/v1/presence/recent` | A | Recently-played-with, for the future friends hook |

Live presence updates come over the lobby socket (`realtime-lobby.md`). This REST surface is
the initial load only; **polling it is a contract violation** and will be rate limited.

## 6. Rooms and lobby

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/rooms` | A | `?region=&mode=&hasSpace=`. Live metadata |
| GET | `/v1/rooms/:id` | A | Full room state including roster |
| POST | `/v1/rooms` | A | Create. Idempotency key required |
| POST | `/v1/rooms/:id/join` | A | Reserves a slot, returns a reservation with a TTL |
| POST | `/v1/rooms/:id/leave` | A | Idempotent by nature |
| POST | `/v1/rooms/:id/team` | A | `{ team: "alpha"\|"bravo"\|"auto" }`. Server decides |
| POST | `/v1/rooms/:id/ready` | A | `{ ready: bool }`. Cleared by roster/team/loadout change |
| POST | `/v1/rooms/:id/loadout` | A | `{ primaryIdx, secondaryIdx }` |
| POST | `/v1/rooms/:id/launch` | A | Owner-only. 409 unless every required player is ready |
| POST | `/v1/rooms/:id/reconnect-ticket` | A | **Added by REQ-CC-003.** Issues a fresh single-use lobby ticket to a member whose seat is still held |

`POST /v1/rooms/:id/reconnect-ticket` exists because the join ticket is **consumed** when the
lobby socket opens, so there was no legal way to reconnect — the contract previously told the
client to reuse a spent ticket or fetch one from an endpoint that does not return one. Both
were impossible.

```json
200 → { "lobbySocketUrl": "wss://…", "lobbyTicket": "…", "expiresAt": "…",
        "graceEndsAt": "…", "correlationId": "…" }
409 → RECONNECT_GRACE_EXPIRED   // seat released; re-join normally
404 → ROOM_NOT_FOUND
403 → ROOM_REMOVED | SANCTIONED
```

Requires an authenticated account that still **holds a seat** in the room. It does not create
membership, so it cannot be used to jump a queue or re-enter a room the player has left.

`GET /v1/rooms` returns the **paginated envelope** every list endpoint uses (§10), carrying
`RoomCore` items as defined in §11.3 — no roster, no separate field list here:

```json
{ "items": [ /* RoomCore */ ], "nextCursor": "…"|null, "correlationId": "…" }
```

Query: `?region=&mode=&hasSpace=&limit=&cursor=`. `hasSpace` is a boolean;
`region` and `mode` are closed enums; unknown parameters are rejected rather than ignored.
`rttSource` briefly appeared in this list with no type or meaning and is removed —
`X-Region-Rtt` (§11.6) is the only RTT input (REQ-CC-033).

A bare `RoomCore[]` was declared here for one round, which contradicted §1 (every response
carries `correlationId`), §10 (lists are `{ items, nextCursor }`), and the `browser-empty`
fixture that already returned the wrapper (REQ-CC-027).

`POST /v1/rooms/:id/join` returns a reservation, not a seat:

```json
{ "reservationId": "…", "expiresAt": "…",
  "lobbySocketUrl": "wss://…", "lobbyTicket": "…", "correlationId": "…" }
```

The client must open the lobby socket with `lobbyTicket` before `expiresAt` or the slot is
released. This is what prevents a stalled joiner from holding a slot forever, and what makes
two simultaneous joiners for one seat resolve deterministically.

## 7. Matches, reports, config

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/matches/:matchId` | A | Authoritative result. `match-result.md` |
| POST | `/v1/matches/:matchId/result` | **S** | Match server → platform. Idempotent. Never browser-reachable |
| POST | `/v1/matches/:matchId/reconnect-ticket` | A | Fresh single-use match ticket while the entity is still held |
| GET | `/v1/matches/active` | A | **REQ-CC-029.** The caller's currently-held match, for reload discovery |
| POST | `/v1/reports` | A | Player report; returns a reference |
| GET | `/v1/config/flags` | A | Client-visible flags only. `feature-flags.md` §3.1 |
| GET | `/v1/config/regions` | P | Region list with probe endpoints |
| POST | `/v1/telemetry/client` | P/A | Ordinary batch; auth optional. Exact privacy/receipt rules in `telemetry.md` §3.3 |
| POST | `/v1/telemetry/unload/credential` | A | Rotates the endpoint-scoped unload cookie; `204` |
| POST | `/v1/telemetry/unload` | P | Beacon-only ingress; exact global-header exception in `telemetry.md` §3.3.1 |
| GET | `/v1/health` | P | Liveness. No dependency detail |
| GET | `/v1/health/ready` | **S** | Readiness, per dependency |
| GET | `/v1/ops/metrics` | **S** | Bounded service counters/latency and outbox/alert signals |
| GET | `/v1/ops/incidents/:correlationId` | **S** | Redacted correlated event/audit/span timeline |

The config and health rows previously sat outside this table, orphaned below the prose that
followed it (REQ-CC-027).

**`POST /v1/matches/:matchId/result` is service-only.** If a browser can reach it, the client
can write its own stats, and the entire G1 gate is decorative.

`POST /v1/matches/:matchId/reconnect-ticket` is the match-socket analogue of the lobby's §6
endpoint, and exists for the same reason: the session ticket is consumed at `MSG_HELLO`, so
without a way to mint another, a dropped client could never rejoin its own live match.

```json
200 → { "handoff": { /* the complete MatchHandoff from realtime-lobby.md §6.1,
                       so a reloaded client recovers map, rules, sites and policy */ },
        "graceEndsAt": "…",      // ISO-8601 wall clock
        "serverNow": "…",        // ISO-8601 — the client converts against this, never its own clock
        "correlationId": "…" }
409 → RECONNECT_GRACE_EXPIRED     // entity released; the match continues without you
404 → NOT_FOUND                   // no such match, or you were never in it
```

`graceEndsAt` is authoritative here and nowhere else: a dropped socket cannot deliver it, and a
client counting down from its own drop timestamp would disagree with the server about when its
seat expires.

### 7.1 `GET /v1/matches/active` — reload discovery (REQ-CC-029)

The reconnect endpoint restores everything **once the client knows `matchId`** — and a page
reload loses `match.ready`, so it does not. This is the missing first step.

```json
200 → { "matchId": "…", "roomId": "…", "graceEndsAt": "…", "serverNow": "…",
        "correlationId": "…" }
204 → no held match
```

Authenticated, derived server-side from the account's held entity. The client asks "am I in a
match?" rather than remembering across a reload, so nothing depends on client persistence
surviving a crash, a new tab, or a different device.

`matchId` is not a secret and needs no protection, but it is also not something the client
should have to store: the server already knows, and asking is one request.

```json
// GET /v1/health        → { "ok": true, "correlationId": "…" }
// GET /v1/health/ready  → { "ok": true, "dependencies": { "db": "up|down", … }, "correlationId": "…" }
```

Health responses carry `correlationId` like every other response (§1); they previously omitted
it.

The operations endpoints are service-only and read-only. Metrics use route templates rather
than player/account paths. Incident lookup returns durable event/audit metadata plus bounded
recent spans from client, platform, and match server; it never returns event payloads, actor
identifiers, email, chat, credentials, provider bodies, or the alert webhook URL. Recent spans
are diagnostic and process-local; the outbox and audit rows are the durable timeline facts.

The unload ingress is the only exception to §1's header carriage. It validates exact
`correlationId`, `clientBuild`, and unique `deliveryId` equivalents in its JSON body because
`navigator.sendBeacon` cannot set the two global headers. That exception does not waive the
build floor, consent-subject binding, batch limit, closed event registry, or server-side actor
derivation. The credential endpoint uses the normal authenticated header contract.

## 8. Idempotency

Every non-idempotent POST accepts `Idempotency-Key`. Required on: `PATCH /profile/me`,
`POST /rooms`, `POST /rooms/:id/join`, `POST /matches/:id/result`, and every value-bearing
endpoint from P8 onward.

- First use: execute, store `(key, actor, requestHash, response, status)`, return.
- Replay, same hash: return the **stored** response. Do not re-execute.
- Replay, different hash: `IDEMPOTENCY_KEY_REUSED`.
- Retention: 24 h for gameplay, permanent for value-bearing operations.
- A request that fails with 5xx stores nothing, so a retry genuinely re-executes.

## 9. Rate limits

| Class | Limit | Applies to |
|---|---|---|
| Auth | 10/min per IP, 5/min per account | signup, signin, refresh, recovery |
| Read | 120/min per account | GET |
| Write | 30/min per account | POST/PATCH/PUT/DELETE |
| Room actions | 20/min per account | join/leave/team/ready |
| Name check | 20/min per client session, 60/min per IP | `POST /v1/auth/display-name/check` (§3b) |
| Reports | 10/hour per account | reports |
| Service | Uncapped, mTLS-gated | S endpoints |

Exceeded → `RATE_LIMITED` or `AUTH_RATE_LIMITED` with `retryAfterMs`. Limits are enforced at
the edge **and** in the service — the edge can be bypassed.

The name-check class is sized for a **debounced** field: at a 400 ms debounce a player cannot
reach 20/min by typing, while a per-keystroke implementation will, which is the intended
feedback. It is a separate class because it is public and unauthenticated — putting it in the
Auth class would let name checks exhaust the same bucket sign-in needs.

## 10. Pagination

Cursor-based. `?limit=` (default 25, max 100) and `?cursor=`. Response, **including
`correlationId` like every other response** (§1):

```json
{ "items": [ … ], "nextCursor": "…"|null, "correlationId": "…" }
```
 No offset pagination anywhere — it double-counts
and skips rows under concurrent insert, which for a match history is a support ticket.

## 11. Exact schemas

**Added by REQ-CC-001.** §3–§7 gave methods, paths, and notes; that is not enough to build a
typed client without guessing, so the shapes are fixed here. Anything not stated is forbidden
rather than optional — a client may reject an unexpected field.

Conventions: `null` means present-and-empty; an omitted key is a contract violation. Every
success response carries `correlationId`.

### 11.1 Refresh transport — the contradiction, resolved

This contract previously said the refresh token was "in body" while `auth.md` §3 said it was
an httpOnly cookie. **The cookie is correct**; the body reference was an error. The point of
the two-token model is that the refresh credential is unreachable from JavaScript, and a
credential the page can put in a request body is a credential XSS can steal.

```http
POST /v1/auth/refresh
Cookie: os_rt=<opaque>;  Secure; HttpOnly; SameSite=Lax; Path=/v1/auth
(empty body)

200 → { "accessToken": "…", "expiresAt": "…",
        "session": { "sessionId": "…", "deviceLabel": "…", "createdAt": "…" },
        "correlationId": "…" }
      Set-Cookie: os_rt=<new opaque>   ← rotates on every refresh
401 → AUTH_TOKEN_INVALID | AUTH_SESSION_REVOKED | AUTH_SESSION_REPLACED
```

The client never reads, stores, or forwards `os_rt`. Reuse of a rotated cookie revokes the
whole family (`auth.md` §3).

### 11.2 Settings — versioned, with optimistic concurrency

```http
GET /v1/profile/me/settings
200 → { "schemaVersion": 1, "version": 7, "values": { … },
        "updatedAt": "…", "correlationId": "…" }
      ETag: "7"

PUT /v1/profile/me/settings
If-Match: "7"
{ "schemaVersion": 1, "values": { … } }
200 → { "schemaVersion": 1, "version": 8, "values": { … }, "updatedAt": "…", "correlationId": "…" }
409 → CONFLICT, details: { "currentVersion": 9, "values": { … } }
409 → CONFLICT, details: { "reason": "if-match-required" }   // never 428 — see §3a.4
```

`If-Match` is **required**. Settings roam across devices, so two tabs racing is the normal
case, not the exotic one; last-write-wins would silently discard a rebind the player just made.
The 409 returns the current server state so the UI can merge rather than re-fetch.

`schemaVersion` is the shape of `values`; `version` is the row's revision counter.

### 11.3 Room components (REQ-CC-015)

The previous version claimed REST and realtime shared one `RoomState` "field for field". They
did not, and could not: the REST detail response wraps room fields together with `roster`,
`countdown`, and `correlationId`, while the lobby socket puts room fields in `d.room`, keeps
roster and countdown beside it, and carries correlation on the envelope. Two different
envelopes around the same data is correct design; claiming they were the same object was not.

So the **components** are canonical and shared; the **responses** that embed them are not.

```jsonc
// ── RoomCore ───────────────────────────────────────────────────────────────
{ "roomId": "…", "name": "…", "region": "yyz",
  "mapId": "the-square", "mapVersion": "1.0.0",
  "mode": "tdm|bomb", "rulesetVersion": "bomb-1.0.0", "build": "…",
  "status": "open|countdown|in-progress|closing",
  "capacity": 12, "playerCount": 6,
  "joinable": true,
  "joinBlockedReason": null,        // full|in-progress|closing|password|sanctioned|
                                    // region-restricted|build-mismatch|banned-from-room
  "hasPassword": false,
  "ownerAccountId": "…",
  "estimatedRttMs": 24,             // null when unmeasured (§11.6)
  "settings": { /* RoomSettings */ } }

// ── RoomSettings — discriminated by RoomCore.mode ──────────────────────────
// mode: "tdm"
{ "killLimit": 75,
  "roundsToWin": null, "maxRounds": null, "roundLengthSec": null,
  "backfill": true, "requiredReady": 8, "minPlayers": 2 }

// mode: "bomb"
{ "killLimit": null,
  "roundsToWin": 7, "maxRounds": 12, "roundLengthSec": 105,
  "backfill": false,                // Bomb never backfills mid-round (bomb-rules.md §9)
  "requiredReady": 8, "minPlayers": 2 }

// ── RosterMember ───────────────────────────────────────────────────────────
{ "accountId": "…", "displayName": "…",
  "team": "alpha|bravo|unassigned",
  "ready": false, "isOwner": false, "isLocal": false,
  "connection": "connected|reconnecting|disconnected",
  "estimatedRttMs": 24,             // null when unmeasured
  "loadout": { "primaryIdx": 0, "secondaryIdx": 3 },
  "joinedAt": "…" }

// ── CountdownState ─────────────────────────────────────────────────────────
{ "endsAt": "…", "requiredReady": 8, "currentReady": 6 }
```

Mode-specific keys are **present and null** in the other mode rather than omitted, so one
parser handles both without key-existence checks. The single earlier example combined a TDM
`killLimit` with live Bomb fields while claiming the opposite, so both are now written out
(REQ-CC-021).

Two responses embed those components:

| Response | Shape | Used by |
|---|---|---|
| `RoomDetailResponse` | `{ ...RoomCore, roster: RosterMember[], countdown: CountdownState\|null, correlationId }` | `GET /v1/rooms/:id`, `POST /rooms/:id/{team,ready,loadout}` |
| `RoomRealtimeState` | `{ room: RoomCore, roster: RosterMember[], countdown: CountdownState\|null, you: {…} }` inside the socket envelope | `lobby.welcome.d`, `state.snapshot.d` |

`GET /v1/rooms` carries `RoomCore` items and **no roster** — a browser listing forty rooms does
not need four hundred roster entries, and sending them makes the list slow at exactly the
moment it should feel instant. **Its response envelope is defined once, in §6**; this section
defines the components only, and deliberately does not restate the wrapper (REQ-CC-033).

**`room.updated` is `Partial<RoomCore>`** restricted to exactly this closed set — the
**mutable** keys, and no others:

```
name · status · capacity · playerCount · joinable · joinBlockedReason · settings · ownerAccountId
```
`settings` is replaced **wholesale** when any part of it changes — a partial settings patch
would need per-key null semantics that collide with the present-and-null rule above. `roomId`,
`mapId`, `mapVersion`, `mode`, `rulesetVersion`, and `build` never change for a live room; a
room needing different ones is a different room.

### 11.3a `CreateRoomResponse`

`POST /v1/rooms` returned "RoomState + reservation", which is not a shape. It is:

```jsonc
201 → { "room": { /* RoomCore */ },
        "roster": [ /* the creator */ ],
        "countdown": null,
        "reservationId": "…", "expiresAt": "…",
        "lobbySocketUrl": "wss://…", "lobbyTicket": "…",
        "correlationId": "…" }
```

Creating a room joins it, so the creator receives the same reservation fields as §11.4 and
follows the identical path to the socket. There is no separate create-then-join step to get
wrong.

### 11.4 Join

```http
POST /v1/rooms/:id/join
Idempotency-Key: …
{ "password": "…" | null, "preferredTeam": "alpha|bravo|auto" }

200 → { "reservationId": "…", "expiresAt": "…",
        "lobbySocketUrl": "wss://…", "lobbyTicket": "…",
        "correlationId": "…" }
401 → ROOM_PASSWORD_REQUIRED
403 → ROOM_PASSWORD_INVALID | SANCTIONED | ROOM_REMOVED
409 → ROOM_FULL | ROOM_CLOSED | ROOM_IN_PROGRESS
```

`preferredTeam` is a preference. The server assigns, and the lobby socket's `team.changed` is
the truth (`realtime-lobby.md` §5).

### 11.5 Stats and history

```json
// GET /v1/profile/:id/stats?mode=bomb
{ "accountId": "…", "mode": "bomb", "statDefinitionVersion": "1.0.0",
  "totals": { "kills": 0, "deaths": 0, "assists": 0, "suicides": 0, "teamKills": 0,
              "headshots": 0, "shotsFired": 0, "shotsHit": 0, "damageDealt": 0,
              "plants": 0, "defuses": 0, "matches": 0, "wins": 0, "losses": 0,
              "draws": 0, "roundsPlayed": 0, "timePlayedSec": 0 },
  "weapons": { "<weaponId>": { "shots": 0, "hits": 0, "kills": 0, "headshots": 0 } },
  "correlationId": "…" }
```

**No derived values.** K/D, accuracy, and win rate are computed by the client from these
counters (`match-result.md` §6). Shipping both a counter and its ratio guarantees they
eventually disagree, and only one is right.

```json
// GET /v1/profile/:id/matches?limit=25&cursor=…
{ "items": [ HistorySummary ],              // match-result.md §4.3 — the discriminated union
  "nextCursor": "…" | null, "correlationId": "…" }
```

**`HistorySummary` is `match-result.md` §4.3 and is not restated here (REQ-CC-043).** This
section carried the pre-1.7 item shape: `status` already included `pending`, while `endedAt` was
fixed to a timestamp and `result`, `teamScores` and `playerSummary` were always supplied — so
the one status the union added could not be serialised by the schema that admitted it. §4.3
publishes both variants exactly, a pending item carrying explicit `null` for every outcome field
rather than omitting them.

The paging envelope (`items`, `nextCursor`, `correlationId`) is this contract's, per §10. The
item shape is `match-result.md`'s, and a duplicate copy of it here is what drifted.

### 11.6 Region probes

```json
// GET /v1/config/regions
{ "regions": [ { "id": "yyz", "label": "Toronto",
                 "probeUrl": "https://yyz.probe…/ping", "available": true } ],
  "correlationId": "…" }
```

The client measures RTT itself against `probeUrl` (3 samples, median) and submits the results
with the room query as a **header**, not a body — `GET` has no body:

```http
GET /v1/rooms?region=yyz
X-Region-Rtt: yyz=24,ord=41,iad=58
```

Closed format: `region=integerMs` pairs, comma-separated, max 8 regions, each 0–5000. Malformed
or absent → `estimatedRttMs: null` on every returned room, and the UI shows the ping as unknown.

**The server never invents a ping from geography** — a fabricated latency number is worse than
an absent one, because the player trusts it. The header is client-measured and therefore
advisory: it affects display and sort order only, never allocation or authorisation.

### 11.7 Flags

See `feature-flags.md` §3.1 for the exact `GET /v1/config/flags` response.

### 11.8 Remaining endpoint schemas (REQ-CC-010)

§11.1–11.7 covered the endpoints with unusual semantics. These are the rest, so no endpoint is
left to inference.

```jsonc
// POST /v1/auth/signup
//   { "email", "password", "displayName", "eligibilityReceipt",
//     "clientSessionId", "consentReceipt" }   ← REQUIRED: the approved order always
//                                                decides consent before signup
//   dateOfBirth is NOT sent here — see §3a.1; it never leaves the preflight
// POST /v1/auth/signin   { "email", "password" }
201/200 → { "accessToken", "expiresAt", "session": { "sessionId", "deviceLabel", "createdAt" },
            "profile": { /* §4 GET /profile/me */ },
            "consentReceipt": "…"|null,          ← account-scoped; null = undecided
            "correlationId" }
  errors: VALIDATION_FAILED · AUTH_INVALID_CREDENTIALS · AUTH_RATE_LIMITED ·
          NAME_TAKEN · NAME_POLICY_VIOLATION · AUTH_ELIGIBILITY_DENIED ·
          ELIGIBILITY_RECEIPT_INVALID

// POST /v1/auth/signout        {} → 204
// POST /v1/auth/signout-all    {} → 204          (both clear the refresh cookie)

// GET /v1/auth/sessions
200 → { "sessions": [ { "sessionId", "deviceLabel", "userAgentClass", "ipClass",
                        "createdAt", "lastSeenAt", "isCurrent" } ], "correlationId" }
// DELETE /v1/auth/sessions/:id → 204 · NOT_FOUND · AUTH_FORBIDDEN

// POST /v1/auth/recovery/start     { "email" } → 202 { "correlationId" }   (always 202)
// POST /v1/auth/recovery/complete  { "token", "newPassword" } → 204
  errors: AUTH_RECOVERY_TOKEN_INVALID · AUTH_RECOVERY_TOKEN_EXPIRED · VALIDATION_FAILED

// PATCH /v1/profile/me   { "displayName"?, "privacy"? }   Idempotency-Key required
200 → the §4 profile object
  errors: NAME_TAKEN · NAME_POLICY_VIOLATION · NAME_CHANGE_COOLDOWN · VALIDATION_FAILED

// GET /v1/profile/:accountId          public projection
200 → { "accountId", "displayName", "createdAt",
        "stats": ModeStats (§11.5) | null, // null when statsVisibility forbids it
        "presence": { … } | null,     // null when presenceVisibility forbids it
        "correlationId" }
  A privacy-hidden field is null. It is never omitted, and never a 403 — both would
  disclose that the setting exists and is set.

The public-profile `stats` object is exactly one single-mode §11.5 projection (TDM in Alpha),
not an open summary object. The dedicated stats endpoint remains the mode-selectable source;
both surfaces call the same service projection, so their counters cannot diverge. Unknown
nested fields are a protocol violation.

// GET /v1/presence/online?limit=&cursor=
200 → { "items": [ { "accountId", "displayName",
                     "state": "online|in-lobby|in-match",
                     "joinable": bool, "roomId": string|null } ],
        "nextCursor", "correlationId" }

// POST /v1/rooms   { "name", "region", "mapId", "mode", "capacity", "password"?, "settings"? }
201 → CreateRoomResponse (§11.3a)

// POST /v1/rooms/:id/leave    {} → 204   (idempotent; 204 even if not a member)
// POST /v1/rooms/:id/team     { "team": "alpha"|"bravo"|"auto" } → 200 RoomDetailResponse
//   errors: TEAM_FULL · TEAM_SWITCH_FORBIDDEN · NOT_IN_ROOM
// POST /v1/rooms/:id/ready    { "ready": bool } → 200 RoomDetailResponse
// POST /v1/rooms/:id/loadout  { "primaryIdx", "secondaryIdx" } → 200 RoomDetailResponse
//   errors: VALIDATION_FAILED (index out of range for the ruleset)
// POST /v1/rooms/:id/launch   {} → 202 { "correlationId" }
//   errors: AUTH_FORBIDDEN (not owner) · CONFLICT (not all ready) · ROOM_IN_PROGRESS

// POST /v1/reports  { "subjectAccountId", "category", "matchId"?, "chatMessageId"?, "description"? }
201 → { "reportId", "correlationId" }
  category ∈ cheating | harassment | offensive-name | griefing | other
  A supplied chatMessageId is accepted only when it belongs to subjectAccountId and the
  reporter was a member of that message's room when it was sent. Both failures are NOT_FOUND
  so report evidence cannot be used to enumerate another room's messages.
  errors: REPORT_DUPLICATE · RATE_LIMITED · VALIDATION_FAILED · NOT_FOUND

// GET /v1/health, /v1/health/ready → defined once in §7.1; not restated here

// POST /v1/matches/:matchId/result   [S]  Idempotency-Key: match-result:<matchId>
  body: AuthoritativeResultSubmissionV1 (match-result.md §5.1), exactly
        { "result": ResultSubmission, "evidence": AuthoritativeEvidenceV1 }.
        Flat results, unknown wrapper keys, response-only keys, digest mismatches and
        non-reconstructable/truncated evidence are refused, not ignored.
        Path :matchId wins over body matchId; Idempotency-Key must be the derived one.
  200 → { "matchId", "status", "applied": bool, "resultAppliedAt",
          "appliedToCount": int, "correlationId" }   // applied:false = idempotent replay
  errors: CONFLICT (finalised with a different payload) · VALIDATION_FAILED · AUTH_FORBIDDEN
```

**The result body is `AuthoritativeResultSubmissionV1`, not "the §4 record" (REQ-CC-043).** §4 contains the
pending variant and the response-only correlation envelope as well, so the old reference asked a
producer to send a section rather than a type. `appliedToCount` is `0` for the outcomes
`match-result.md` §6.1 does not aggregate, and `resultAppliedAt` is stamped on every terminal
submission including those — it records that the application ran, not that a career changed.

**`?mode=all` on stats** returns `{ "modes": { "tdm": {…}, "bomb": {…} }, "correlationId" }`,
each value being the §11.5 body. It does **not** sum across modes — a combined K/D over two
rulesets with different death semantics is a number that means nothing.

### 11.9 Roaming settings — `RoamingSettingsV1` (REQ-CC-016)

**This section no longer contains a table, deliberately.** It previously carried a hand-written
allowlist that claimed to mirror `design/settings-inventory.md` and did not: it renamed
`adsSensitivity` to `adsSensitivityScale`, narrowed FOV from 60–120 to 70–110, invented a
`voice` audio channel, collapsed primary/secondary bindings to a single action→code map, and
put the volume controls in roaming scope. Duplicating a table is what produced that drift, so
the duplicate is gone.

**`design/settings-inventory.md` is the single source of truth for settings.** It is
Codex-owned, and this contract defers to it.

```
RoamingSettingsV1  ≡  exactly the rows of design/settings-inventory.md whose Scope is ROAM,
                      keyed by their canonical IDs, with that document's
                      type, range, step, enum and default.
```

| Scope in the inventory | Server behaviour |
|---|---|
| `ROAM` | Stored and returned by §11.2. The complete set, no additions |
| `DEVICE` | **Rejected** with `VALIDATION_FAILED`. Local only — render scale, quality, frame cap, and **all volume controls**, because they depend on the physical machine |
| `SESSION` | Rejected. Live measured values, never persisted |
| `PRACTICE` | Rejected. Offline practice setup; the server room owns the online equivalents |

Volume being `DEVICE` is the clearest case: roaming a master volume from a desktop with
speakers to a laptop is a setting arriving wrong on a machine that had it right.

**Bindings** carry primary **and optional secondary** per action, as the inventory specifies
(`Crouch/slide` ships `Left Ctrl` + `C`). A single action→code map cannot express that:

```jsonc
"keybinds": { "<bindingActionId>": { "primary": "ControlLeft", "secondary": "KeyC" },
              "<bindingActionId>": { "primary": "Space",       "secondary": null } }
```

**`RoamingSettingsV1` consumes settings vocabulary version 1** (REQ-CC-032). Keys are the
inventory's ROAM setting IDs; `keybinds` keys are its 31 canonical binding action IDs. The
validator is generated from that vocabulary and this contract restates none of it — the
placeholder IDs that used to sit here were invented, did not match, and are gone.

A key outside vocabulary v1, or a value outside its stated range, step, or enum, is rejected.
`schemaVersion: 1` means `RoamingSettingsV1` against vocabulary version 1; a vocabulary bump
that adds a ROAM row is additive, and one that renames or removes an ID is a CCR against both
documents.

**Validation** is generated from the inventory rather than hand-maintained here, so a change to
a range in the design doc cannot silently disagree with the server. A key outside the ROAM set,
or a value outside its stated range, step, or enum, is rejected — never clamped, because a
clamped setting is a setting the player did not choose and cannot see they did not get.

`schemaVersion` (§11.2) is `1` for `RoamingSettingsV1`. Adding a ROAM row is additive within
the version; removing or retyping one is a CCR against both documents.

### 11.10 Stub scenarios — stateful, and coverage-mapped (REQ-CC-041)

Build Plan §0.5 makes stubs the exit condition for this phase, so "a fixture exists" is not the
bar: **every designed screen state must be reachable deterministically.** Single-response
fixtures cannot express a multi-request transition — verification pending *then* accepted,
consent decided *then* migrated at signup — and `?__stub=error:CODE` cannot model a sequence at
all.

Scenarios are therefore **stateful**: selected by `X-Stub-Scenario`, keyed per
`clientSessionId`, and advanced by the requests the client actually makes. Same scenario, same
sequence, same responses, every run.

**Send `X-Client-Session-Id` on every request in a scenario.** The key falls back to
`clientSessionId` in the query or body, so supplying it on only some requests splits one
timeline into two and the transitions never fire.

**Two tabs of one account: `X-Stub-Account-Id` (REQ-CC-045).** Scenario state is per client
session, which is right for a timeline and wrong for an account — so a session revoked in one tab
stayed live in the other, `signout-all` signed out one tab, and cross-tab revocation, a designed
`/sessions` state, was unreachable. Client sessions sending the same `X-Stub-Account-Id` share
the account-scoped state: the session list, revocations, and which access tokens exist. Absent,
a tab is its own account.

It is declared rather than inferred because every scenario seeds the same fixture account, so the
layer cannot tell two tabs from two replays by looking at the requests — and if it assumed
*shared*, a replay would inherit the previous run's revocations and stop being byte-identical,
which is the determinism this section requires.

The table below is **32 scenarios**; three join refusals previously shared one row, which made
the count read as 31 and is the kind of miscount a coverage test catches by enumerating rather
than trusting prose.

| Scenario | Timeline |
|---|---|
| `default` | Signed-in account, 3 rooms across 2 regions, 20 terminal matches |
| `onboarding-happy` | eligibility ✓ → consent accept → signup (migrates receipt) → verify pending → verify ✓ → terms ✓ → shell |
| `onboarding-eligibility-denied` | eligibility → `AUTH_ELIGIBILITY_DENIED`, terminal |
| `onboarding-consent-declined` | eligibility ✓ → consent decline → signup ✓ → receipt marks personal telemetry unauthorised |
| `onboarding-verify-invalid` | …→ verify → `AUTH_VERIFICATION_TOKEN_INVALID` → resend → ✓ |
| `onboarding-verify-expired` | …→ verify → `AUTH_VERIFICATION_TOKEN_EXPIRED` → resend → ✓ |
| `onboarding-terms-conflict` | …→ terms accept v1 → `CONFLICT` with v2 → accept v2 → ✓ |
| `onboarding-receipt-invalid` | eligibility ✓ → consent ✓ → signup → `ELIGIBILITY_RECEIPT_INVALID` |
| `account-pre-policy` | Signed-in, `consent: null`; consent prompt on first personal action |
| `browser-empty` | `{ items: [], nextCursor: null, correlationId }` |
| `browser-unreachable` | `SERVICE_UNAVAILABLE` on room endpoints only; auth unaffected |
| `room-full` | Join → `ROOM_FULL` |
| `room-in-progress` | Join → `ROOM_IN_PROGRESS` |
| `room-password` | Join → `ROOM_PASSWORD_REQUIRED`, then succeeds with any non-empty password |
| `match-active-none` | `GET /v1/matches/active` → 204 |
| `match-active-reconnect` | active → 200 with `matchId` → reconnect-ticket → 200 with handoff + `graceEndsAt` |
| `match-active-grace-expired` | active → 200 → reconnect-ticket → `RECONNECT_GRACE_EXPIRED` |
| `result-pending-live` | `pending`, `endedAt: null`, 3 polls, then `completed` |
| `result-pending-queued` | `pending`, `endedAt` set, 2 polls, then `completed` |
| `result-aborted-forfeit` | `aborted` / `forfeit` / `winnerTeam: "alpha"` |
| `result-aborted-nocontest` | `aborted` / `no-contest` / `winnerTeam: null` |
| `result-invalidated` | `invalidated` / `no-contest` / null winner / non-null `invalidationReason` |
| `result-draw` | `completed` / `timer` / `winnerTeam: "draw"` |
| `history-mixed` | Terminal **and** pending items, so the §4.3 union is exercised |
| `history-empty` | Zero matches, zero career totals |
| `privacy-filtered` | `stats: null`, `presence: null` |
| `sanctioned` | `SANCTIONED` on join and chat; profile readable |
| `name-taken` | Signup and rename → `NAME_TAKEN` |
| `session-revoked` | Third authenticated call → `AUTH_SESSION_REVOKED` |
| `token-expiry` | Access token expires after 30 s, exercising single-flight refresh |
| `slow` | Every response delayed 2 s |
| `offline` | Transport-layer failure on every request |

### 11.11 Coverage map

Which scenario owns which route's states, so coverage is **auditable rather than inferred from
names** (`design/shell-ia.md` route hierarchy):

| Route | Owning scenarios |
|---|---|
| `/welcome` | `default`, `offline`, `slow` |
| `/auth/sign-in` | `default`, `session-revoked`, `token-expiry`, `account-pre-policy` |
| `/auth/create-account` | `onboarding-happy`, `name-taken`, `onboarding-receipt-invalid` |
| `/onboarding/eligibility` | `onboarding-happy`, `onboarding-eligibility-denied` |
| `/onboarding/consent` | `onboarding-happy`, `onboarding-consent-declined` |
| `/onboarding/verify` | `onboarding-verify-invalid`, `onboarding-verify-expired` |
| `/onboarding/terms` | `onboarding-happy`, `onboarding-terms-conflict` |
| `/play/rooms` | `default`, `browser-empty`, `browser-unreachable`, `slow` |
| `/room/:roomId` | `room-full`, `room-in-progress`, `room-password`, `sanctioned` |
| Match reconnect | `match-active-none`, `match-active-reconnect`, `match-active-grace-expired` |
| `/career/overview` | `default`, `history-empty`, `privacy-filtered` |
| `/career/modes`, history | `history-mixed`, `result-pending-live`, `result-pending-queued` |
| Results screen | `result-aborted-forfeit`, `result-aborted-nocontest`, `result-invalidated`, `result-draw` |

A CX acceptance row with no owning scenario is a gap in this table, not in the UI — file a
`REQ-CC` and it gets a scenario.

#### 11.11.1 Route × variant — the complete matrix (REQ-CC-045)

The table above owns **13** of the **27** addressable routes in `design/shell-ia.md`, and names
no variant for any of them. So `/auth/recover`, `/onboarding/display-name`,
`/onboarding/essential-settings`, `/play/rooms/:roomId`, `/room/:roomId/roster`,
`/room/:roomId/loadout`, `/room/:roomId/chat`, `/career/modes`, `/career/weapons`,
`/career/matches`, `/career/matches/:matchId`, `/settings/:category`, `/sessions`,
`/match/loading` and `/system/:condition` had no owning scenario at all, and none of the 13 said
which of the five required variants — loading, empty, recoverable error, offline/stale,
terminal/policy — each owner served. A coverage map that cannot be diffed against the screen
inventory is a claim, not coverage.

Every cell is a **runnable** owner: an HTTP scenario from §11.10, a `lobby:` timeline from
`realtime-lobby.md` §10, or `n/a` for a state that cannot truthfully occur for that screen
(`shell-ia.md`: "`Not applicable` means the state cannot truthfully occur"). The reasons are
listed under the table, and `platform/test/stubtest.mjs` parses this matrix, requires an owner or
a reason for every cell, and runs the request sequence behind each one. **A row here with no
owner fails the build.**

| Route | loading | empty | error | offline | policy |
|---|---|---|---|---|---|
| `/welcome` | `slow` | n/a | `system-maintenance` | `offline` | `unsupported-client` |
| `/auth/sign-in` | `slow` | n/a | `signin-invalid-credentials` | `offline` | `signin-incomplete-setup` |
| `/auth/create-account` | `slow` | n/a | `onboarding-receipt-invalid` | `offline` | `onboarding-eligibility-denied` |
| `/auth/recover` | `slow` | n/a | `recovery-token-invalid` | `offline` | `recovery-token-expired` |
| `/onboarding/eligibility` | `slow` | n/a | `default` | `offline` | `onboarding-eligibility-denied` |
| `/onboarding/consent` | `slow` | `onboarding-happy` | `onboarding-happy` | `offline` | `onboarding-consent-declined` |
| `/onboarding/display-name` | `slow` | n/a | `name-check-unavailable` | `offline` | `name-policy-violation` |
| `/onboarding/verify` | `slow` | n/a | `onboarding-verify-invalid` | `offline` | `onboarding-verify-expired` |
| `/onboarding/terms` | `slow` | n/a | `onboarding-terms-conflict` | `offline` | `signin-incomplete-setup` |
| `/onboarding/essential-settings` | `slow` | `default` | `default` | `offline` | n/a |
| `/play/rooms` | `slow` | `browser-empty` | `browser-unreachable` | `offline` | `system-maintenance` |
| `/play/rooms/:roomId` | `slow` | `default` | `browser-unreachable` | `offline` | `room-full` |
| `/room/:roomId` | `lobby:disconnect-resync` | `default` | `room-password` | `offline` | `sanctioned` |
| `/room/:roomId/roster` | `lobby:player-joins-mid` | `default` | `lobby:team-full` | `offline` | `lobby:kicked` |
| `/room/:roomId/loadout` | `slow` | n/a | `default` | `offline` | `room-in-progress` |
| `/room/:roomId/chat` | `lobby:disconnect-resync` | n/a | `lobby:chat-flood` | `offline` | `lobby:sanctioned` |
| `/career/overview` | `slow` | `history-empty` | `career-unavailable` | `offline` | `privacy-filtered` |
| `/career/modes` | `slow` | `history-empty` | `career-unavailable` | `offline` | `privacy-filtered` |
| `/career/weapons` | `slow` | `history-empty` | `career-unavailable` | `offline` | `privacy-filtered` |
| `/career/matches` | `slow` | `history-empty` | `career-unavailable` | `offline` | `history-mixed` |
| `/career/matches/:matchId` | `result-pending-live` | n/a | `match-not-found` | `offline` | `result-invalidated` |
| `/settings/:category` | `slow` | `default` | `default` | `offline` | `settings-conflict` |
| `/sessions` | `slow` | `sessions-current-only` | `default` | `offline` | `default` |
| `/match/loading` | `lobby:happy-path` | n/a | `lobby:allocation-failed` | `offline` | `lobby:handoff-version-mismatch` |
| `/match/reconnect` | `match-active-reconnect` | `match-active-none` | `lobby:reconnect-grace-exhausted` | `offline` | `match-active-grace-expired` |
| `/results/:matchId` | `result-pending-queued` | n/a | `career-unavailable` | `offline` | `result-aborted-nocontest` |
| `/system/:condition` | `slow` | n/a | `system-maintenance` | `offline` | `unsupported-client` |

Why each `n/a` is not a missing fixture:

- **A form has no empty state.** `/auth/sign-in`, `/auth/create-account`, `/auth/recover`,
  `/onboarding/eligibility`, `/onboarding/display-name` and `/onboarding/verify` are inputs
  awaiting a submission; a form with no request outstanding is the initial state, not a server
  response.
- **`/welcome`** is static content — there is no collection to be empty.
- **`/onboarding/terms`** always has a current version; an absent one is an outage, not empty.
- **`/onboarding/essential-settings`** has no terminal state: every control it shows has a later
  home in `/settings/:category`, so there is nothing to refuse.
- **`/room/:roomId/loadout`** always has a current selection, and **`/room/:roomId/chat`** with no
  history is a normal welcome payload rather than a distinct screen.
- **`/career/matches/:matchId`, `/results/:matchId`, `/match/loading`, `/system/:condition`** are
  each reached with an identifier or a condition: the record is found or it is not.

## 12. Stub mode

Behind `platform.api.stub`, every P1–P4 endpoint returns contract-valid deterministic
fixtures: a seeded account, 3 rooms across 2 regions, a 12-player roster, 20 matches of
history, and error fixtures reachable with `?__stub=error:CODE`. Shipped in P1 per Build Plan
§0.5 step 3, so Codex builds the whole shell before the services exist.
