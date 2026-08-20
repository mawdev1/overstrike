# Contract 12 — Telemetry

| | |
|---|---|
| **Status** | `FROZEN` — amendments follow CHANGELOG.md |
| **Version** | 1.9.0 |
| **Owner** | [CC] Claude Code |
| **Producers** | [CX] client, [CC] match server and platform |

---

## 1. Rule

> **A feature is not done until its telemetry exists.** (Build Plan §0.7 item 3.)

Instrumentation added after the fact measures a system nobody can still change cheaply, and
it is always missing the one field the question needed.

## 2. What goes where

Three pipelines. Confusing them is how the platform ends up inside the tick loop.

| Pipeline | Carries | Scale | Destination |
|---|---|---|---|
| **Wire events** (`wire-protocol.md` §5.2) | Frame-scale combat feedback: hitmarker, kill, fire, blood | 120 Hz-adjacent | The other player's screen. Never persisted |
| **Match evidence** (`match-result.md` §7) | Per-match timeline and samples for reconstruction | Per match | Object storage, `evidenceRef` |
| **Platform events** (`event-envelope.md`) | Durable facts: account, room, match, moderation, admin | Per meaningful action | Outbox → consumers → warehouse |
| **Metrics** | Aggregates: counters, gauges, histograms | Continuous | Metrics backend, never the database |

**Nothing at 120 Hz becomes a platform event.** A `weapon.fired` platform event at tick rate
is tens of thousands of rows per match per player and puts an I/O path inside `fixedUpdate`,
violating Build Plan §2.2.

## 3. Client telemetry — [CX]

Sent in batches, best-effort, never blocking a render or a match. Dropping client telemetry is
always preferable to stuttering.

### 3.1 Funnel and first-session KPIs (P5 gate evidence)

**Names here are the registry names in §3.3.1 (REQ-CC-020).** This table previously used
underscore forms (`first_match_completed`, `lobby_abandoned`) while the registry used dotted
ones, so the two halves of the same contract named different events and neither was wrong on
its own.

| Event | Measures |
|---|---|
| `flow.step` | Each first-run step from **`signup`** onward, with its outcome — the spine of the funnel |
| `funnel.preconsent` | Landing, eligibility, **and the consent screen itself**, as unlinked internal counts. The only lawful measurement of the steps that precede a decision |
| `session.first_match` | Time to first match and whether it completed |
| `lobby.abandoned` | Left before launch, with the last state reached |
| `connection.failure` | Failed connect, by stage and `errors.md` code |
| `room.join_failure` | Join refused, by reason |
| `match.handoff_failure` | Allocation or handoff failed after countdown |
| `match.return_outcome` | How the player left a match and whether they returned to lobby |
| `settings.friction` | Settings opened during the first session, by UI category |
| `client.unsupported` | Blocked by the D5 matrix, with the failing check |

`flow.step` replaces separate viewed/completed/failed events: `first-run-flow.md` needs all
three per step, and nine steps × three outcomes as distinct names would be twenty-seven
registry rows describing one thing.

### 3.1.1 Supported browser and device matrix — **DECIDED** (D5)

`client.unsupported` is measured against this. Reasoning in
[`../decisions/P0-decisions.md`](../decisions/P0-decisions.md) §D5.

| Tier | Support |
|---|---|
| **Browsers** | Chrome / Edge (Chromium) latest 2 major; Firefox latest 2 major; Safari 17+ |
| **OS** | Windows 10+, macOS 13+, Linux (Chromium/Firefox) |
| **Required capabilities** | WebGL2, pointer lock, WebSocket binary frames |
| **Minimum hardware** | Dual core, 8 GB RAM, ~2 GB VRAM |
| **Unsupported** | Everything else, explicitly including mobile browsers, tablets, and WebGL1-only devices |

**Desktop only.** The control scheme is mouse-and-keyboard and the §3.1 KPIs assume it.

An unsupported client must fail **early and clearly**, before rendering a broken scene
(`errors.md` `UNSUPPORTED_CLIENT`). A game that half-loads and then stutters is a worse
experience than one that says plainly it will not run here.

Safari 17 is supported and is the tier most likely to produce WebGL and audio-timing defects.
It gets explicit regression coverage in the P5 browser matrix; dropping it, if it comes to
that, is a P5 decision made from measurements rather than from apprehension now.

### 3.2 Client health

`fps_p50` / `fps_p01`, `frame_time_ms` histogram, `webgl_context_lost`, `unhandled_error`
(message class, not raw text), `asset_build_ms`, `heap_used_mb`, `net.rtt/jitter/loss/
correction_rate/snapshot_age`.

`fps_p01` matters more than the mean: the 1% low is what a player experiences as a stutter,
and an average hides it completely.

### 3.3 Transport and schema (REQ-CC-008)

Metrics were named but had no way to leave the browser. The endpoint:

```http
POST /v1/telemetry/client        auth OPTIONAL
Content-Type: application/json

{ "clientSessionId": "01J…",     // OMITTED on internal-only pre-consent batches (§3.5)
  "consentReceipt": "…",         // from http-api.md §3a.3; REQUIRED for personal-class events
  "schemaVersion": 1,
  "events": [ {
    "name": "flow.step",
    "version": 1,
    "occurredAt": "…",
    "correlationId": "…",
    "payload": { "step": "display-name", "outcome": "completed", "errorCode": null }
  } ] }

202 → { "accepted": 12, "rejected": 0, "correlationId": "…" }
```

**`accountId` is never sent by the client.** It is derived server-side from the bearer token
when present, and is `null` otherwise. The earlier claim that "every batch carries the
correlation ID and `accountId`" could not work: the landing, sign-up, and display-name steps
are the most important events in the funnel and all occur *before* an account exists. A
client-supplied `accountId` would also be an attribution forgery primitive.

`clientSessionId` is what stitches a pre-auth funnel to a post-auth one. It is explicitly
non-authoritative — it identifies a browser session for funnel analysis and is never used for
authorization, rate-limit identity, or anything that matters.

| Rule | Value |
|---|---|
| Batch size | ≤ 50 events, ≤ 64 KB |
| Batch cadence | 10 s, or on `visibilitychange: hidden` |
| Unload delivery | `navigator.sendBeacon`. Never a synchronous XHR — it blocks the tab close |
| Max event age | 30 min. Older events are dropped, not backdated |
| Queue cap | 500 events, then **drop oldest** |
| Retry | Once, after 30 s. Then drop. Telemetry never retries into an outage |
| Failure | Silent. A telemetry failure is never visible to the player and never blocks a frame |
| Unknown `name` | Rejected server-side and counted; the batch still succeeds |
| Missing/invalid `consentReceipt` | Personal-class events in the batch are **rejected**; internal-class still accepted. The batch does not fail as a whole |
| `consentReceipt` on an internal-only batch | **Not required, and should be absent.** A receipt on a batch carrying no personal events is an identifier with no purpose |
| Payload | Per-name **allowlist**. Keys outside it are dropped server-side, not stored-and-filtered |

**Never persisted in the queue:** access tokens, refresh cookies, raw error strings, chat
text, other players' display names, or anything from §3.4's prohibitions. The queue survives a
reload in `sessionStorage`, so anything in it is anything an XSS can read.

### 3.3.1 Event registry (REQ-CC-014)

The allowlist was referenced but never published, which left "allowlisted" meaning nothing.
This is it. **Privacy class is derived server-side from `(name, version)` using this table** —
the client does not send it. A client-supplied class would be a client deciding its own privacy
handling, and a compromised or modified one would simply declare everything `internal`.

Every payload below is closed: unlisted keys are dropped server-side, not stored and filtered.

| `name` | v | Class | Payload |
|---|---:|---|---|
| `flow.step` | 1 | personal | `{ step, outcome }` — step `signup`\|`signin`\|`verify`\|`terms`\|`display-name`\|`settings`\|`browser`\|`lobby`\|`ready`\|`match`\|`results`; outcome `viewed`\|`completed`\|`failed`; `errorCode` required when `failed`, else null. **Begins at `signup`** — every earlier step precedes the decision that authorises personal telemetry (REQ-CC-039) |
| `funnel.preconsent` | 1 | internal | `{ step, outcome }` — step `landing`\|`eligibility`\|`consent`; outcome `viewed`\|`completed`\|`failed`. **Never carries the decision value.** Unlinked — see §3.5.1 |
| `session.first_match` | 1 | personal | `{ completed: bool, mode, timeToFirstMatchSec: 0–86400 }` |
| `lobby.abandoned` | 1 | personal | `{ lastState, dwellSec: 0–86400 }` — lastState `browsing`\|`joining`\|`in-lobby`\|`countdown` |
| `room.join_failure` | 1 | personal | `{ code, joinBlockedReason }` — both closed enums from `errors.md` / `http-api.md` §11.3; `joinBlockedReason` null when the failure was not a block |
| `match.handoff_failure` | 1 | personal | `{ stage, code }` — stage `allocating`\|`ticket`\|`connect`\|`welcome` |
| `match.return_outcome` | 1 | personal | `{ outcome, returnedToLobby: bool }` — outcome `completed`\|`disconnected`\|`kicked`\|`aborted`\|`grace-expired` |
| `connection.failure` | 1 | personal | `{ stage, code }` — stage `platform`\|`lobby`\|`match`; code from `errors.md` |
| `settings.friction` | 1 | personal | `{ category, duringFirstSession: bool }` — `category` is a canonical category ID from settings vocabulary **version 1** (§3.6). Not a settings key, and not a display label |
| `client.unsupported` | 1 | internal | `{ reason, browser, browserMajor, os }` — `reason` is `UnsupportedReason` (`errors.md` §3.1), including `build` |
| `client.fps` | 1 | internal | `{ p50: 0–1000, p01: 0–1000, windowSec: 1–600 }` |
| `client.frame_time` | 1 | internal | `{ p50Ms, p95Ms, p99Ms }` each 0–10000 |
| `client.webgl_context_lost` | 1 | internal | `{ recovered: bool, uptimeSec: 0–604800 }` |
| `client.error` | 1 | internal | `{ errorClass, fatal: bool }` — **class only, never the raw message** |
| `client.asset_build` | 1 | internal | `{ ms: 0–600000 }` |
| `client.heap` | 1 | internal | `{ usedMb: 0–65536, sampledAtSec: 0–604800 }` |
| `client.net_health` | 1 | internal | `{ rttMs: 0–10000, jitterMs: 0–10000, lossPct: 0–100, correctionRatePerSec: 0–1000, snapshotAgeMs: 0–60000 }` |

Every field is required unless its description says otherwise; `null` is permitted only where
explicitly named (`errorCode`, `joinBlockedReason`).

Units are in the key names. Every numeric field has stated bounds, and a value outside them is
rejected rather than clamped — a 900 000 ms frame time is a bug in the sender, and silently
clamping it to the ceiling hides that bug in the dashboard.

`client.error.errorClass` is a closed set maintained alongside the client error handler
(`webgl-init`, `asset-decode`, `net-decode`, `unhandled-rejection`, `render-loop`, `other`).
Raw error strings are never sent: they routinely contain player-authored content such as
display names and chat.

Adding an event is additive — a new row plus a version. Changing an existing payload's meaning
is a CCR, because the warehouse already has rows under the old interpretation.

### 3.5.0 Internal-class records are never account-linked (REQ-CC-055)

This contract said two things that could not both hold: that `internal` carries no personal
data, and that `accountId` is derived server-side from the bearer token. It never said which
events the second applied to, so an authenticated `client.fps` was stored linked to an account
and still labelled internal.

**The rule, stated once:** a record whose `privacyClass` is `internal` is persisted with
`accountId: null` and `clientSessionId: null`, **even when the request is authenticated**. An
account id is personal linkage; a linked record is not internal whatever its class field says.

The request `correlationId` is retained, because it identifies a request rather than a person
and is what lets an operator follow one action across tiers.

The alternative was reclassifying crash and performance events as `personal`. That was
rejected deliberately: it would put ordinary crash reporting behind consent, so a player who
declines analytics also stops us being able to diagnose the crash that loses them the match.

### 3.5.1 What "unlinked" means, enforceably (REQ-CC-039)

"No correlation to any later event" is only real if the correlation ID cannot be the link.
Every other event carries the originating request's id; `funnel.preconsent` must not.

| Rule | Value |
|---|---|
| `correlationId` | **Freshly generated per event.** Never the eligibility or consent request's id, never the batch's, never reused between two `funnel.preconsent` events |
| `clientSessionId` | Absent from the event **and** from any batch containing one (§3.3) |
| Batch mixing | A batch containing `funnel.preconsent` carries **no** personal-class events. The two never travel together |
| Server handling | Stored without any join key. There is no column to correlate on, so the guarantee survives a future query nobody has written yet |

Reusing the eligibility request's correlation ID would have re-linked the visitor through the
server logs of a request they made two screens earlier — which is precisely the linkage the
class exists to prevent.

### 3.6 Bound vocabulary (REQ-CC-032)

`design/settings-inventory.md` **vocabulary version 1** is published and this contract
consumes it. Neither enum is restated here, because restating is what drifted before.

| Enum | Source | Consumed by |
|---|---|---|
| Category IDs (7) | settings vocabulary v1 | `settings.friction.category` |
| Binding action IDs (31) | settings vocabulary v1 | `http-api.md` §11.9 keybind validation |

IDs are transport identifiers, not display copy: not localised, stable across a retitle, and
renaming a shipped one is a coordinated change across `settings-inventory.md`, `http-api.md`,
and this contract.

A `settings.friction` event whose `category` is not in vocabulary v1 is **rejected**, not
stored — the same rule as any other closed enum in §3.3.1.

### 3.4 Consent and eligibility gating

| Class | Gate |
|---|---|
| `internal` health and performance | Sent always. No personal data, needed to keep the game running |
| `personal` funnel and KPI | Requires `consent.telemetryPersonal` from `http-api.md` §3a.3 — a record distinct from eligibility and from profile visibility |
| Before any consent decision | Only `internal` class is sent, **unlinked** — no `clientSessionId`. Personal events are **dropped, not queued**: queuing against a later "yes" is collecting first and asking afterwards |

The landing and eligibility steps therefore contribute aggregate counts and nothing else
(`http-api.md` §3a.5). This is a deliberate limit on what the funnel can answer, not an
oversight — consent is asked after the age gate so it is never solicited from someone who
cannot give it.

A player who declines consent still produces `internal` telemetry, because refusing to
diagnose a crash is not a privacy win for anyone. They produce no `personal` events at all.

### 3.5 Privacy rules for client telemetry

- No raw chat text, display names of *other* players, IP addresses, or precise geolocation.
- Error messages are classified to a known set before sending; raw strings can contain
  player-authored content.
- Every batch carries the correlation ID. **`clientSessionId` is present only when the batch
  contains at least one personal-class event** and a consent decision exists; an internal-only
  pre-consent batch omits it entirely, which is what makes those counts genuinely unlinked
  rather than merely unlabelled (REQ-CC-034). Nothing else identifying is ever carried.
  **The client never sends `accountId`** — it is derived server-side from the bearer token
  (§3.3), which is both why pre-auth funnel events work and why attribution cannot be forged.

## 4. Server telemetry — [CC]

### 4.1 Capacity (the P5 gate needs these to answer "can we admit more players?")

CCU by region, rooms open/in-progress, matches in progress, instance utilisation, bandwidth
per player-minute, join/allocation failure rate by cause, regional headroom, queue depth,
match-server registration and heartbeat health.

### 4.2 Network quality (the P5 quality contract)

Per match and per connection: RTT/jitter/loss distributions, snapshot size and rate,
keyframe rate, discarded/reordered snapshots, correction rate and magnitude, lag-comp rewind
distribution (**with the bound**, so a rewind approaching the cap is visible before it becomes
a complaint), command batch sizes, rejected commands by cause.

### 4.3 Simulation cost

CPU cost per fixed step (p50/p99), substep count, entity count, draw calls, triangles, heap
growth per match.

**Headless Chromium rasterises through SwiftShader, so frame rate reported in CI is
meaningless.** The numbers that matter are simulation cost per fixed step, draw calls,
triangles, and heap growth. No lane may claim a performance result from a CI frame rate.

### 4.4 Anti-cheat signals

Validation rejections by class, movement/speed anomalies, fire-cadence anomalies, ammo/state
desync, impossible transitions, malformed messages, rate-limit trips, suspicion score
distribution. These feed the P5 risk scoring and the progressive-review model — **not**
automatic permanent bans.

## 5. Privacy and retention classes

Every telemetry stream declares both, matching `event-envelope.md` §7.

| Stream | Privacy | Retention |
|---|---|---|
| Funnel/KPI (`flow.step` onward) | personal | standard (13 mo) |
| Pre-consent funnel (`funnel.preconsent`) | **internal** | **short (30 d)** |
| Client health | internal | short (30 d) |
| Capacity/network/sim | internal | standard |
| Anti-cheat signals | sensitive | audit (7 y) |
| Match evidence | internal | **See §6** |
| Chat | sensitive | audit-linked, per moderation retention |

## 6. Match evidence retention — **needs a privacy review before P5**

Evidence enables cheat review, dispute resolution, and stat reconstruction. It is also a
detailed record of what a person did and where they were.

Proposed: **90 days** by default; extended indefinitely when a match is attached to an open
report, sanction, or appeal, and released when that closes.

Sampled, not exhaustive: full event timeline, position samples at a reduced rate, combat
events at full rate. The bar is §7 of `match-result.md` — reconstructable without client
input — not "record everything".

## 7. KPI dictionary

Every metric has one versioned definition, in one place, used by both lanes and the human
owner. Two definitions of "active player" produce two dashboards that disagree and a meeting
that cannot be resolved.

Each entry: name, definition, unit, source stream, owner, version, and — where it is not
obvious — what it explicitly **excludes**.

## 8. Sampling

| Stream | Rate |
|---|---|
| Funnel, errors, anti-cheat, platform events | 100%. Never sampled — sampling a funnel makes it a guess |
| Client health | 100% of sessions, aggregated client-side before send |
| Position samples in evidence | Reduced rate, see §6 |
| Traces | 100% on error, sampled otherwise |

## 9. Verification — `scripts/telemetrytest.mjs`

1. Every P1–P4 feature emits its declared telemetry; a feature without it fails the check.
2. No client telemetry payload contains raw chat, other players' names, or an IP.
3. Retention deletes on schedule; audit-class survives.
4. Evidence attached to an open report is not deleted at 90 days.
5. Correlation IDs join client, match server, and platform for one synthetic action.
6. Telemetry send failure never blocks a render or a match tick — verified by failing the
   endpoint under load and asserting frame time and tick cost are unchanged.
