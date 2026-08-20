# Contract 12 — Telemetry

| | |
|---|---|
| **Status** | `REVIEW` — amended per Codex review; awaiting re-sign-off |
| **Version** | 1.2.0 |
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

| Metric | Definition |
|---|---|
| `signin.step` | Each first-run step reached: landing, signup, name, settings, browser, lobby, ready, match, results |
| `time_to_first_match_sec` | First landing → first match `live`. The headline onboarding number |
| `first_match_completed` | Whether the first match was played to its end |
| `lobby_abandoned` | Left a lobby before launch, with the last state reached |
| `connection_failure` | Failed connect, by `errors.md` code and stage |
| `settings_friction` | Opened settings during the first session, and which panel |
| `unsupported_client` | Blocked by the browser matrix, with the reason |

### 3.1.1 Supported browser and device matrix — **DECIDED** (D5)

`unsupported_client` is measured against this. Reasoning in
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

{ "clientSessionId": "01J…",     // client-generated ULID, non-authoritative
  "schemaVersion": 1,
  "events": [ {
    "name": "signin.step",
    "version": 1,
    "occurredAt": "…",
    "correlationId": "…",
    "payload": { "step": "display-name" }
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
| `signin.step` | 1 | personal | `{ step }` — `landing`\|`signup`\|`signin`\|`display-name`\|`settings`\|`browser`\|`lobby`\|`ready`\|`match`\|`results` |
| `session.first_match_completed` | 1 | personal | `{ completed: bool, mode, timeToFirstMatchSec: 0–86400 }` |
| `lobby.abandoned` | 1 | personal | `{ lastState }` — `browsing`\|`joining`\|`in-lobby`\|`countdown`; `dwellSec: 0–86400` |
| `connection.failure` | 1 | personal | `{ stage, code }` — stage `platform`\|`lobby`\|`match`; code from `errors.md` |
| `settings.friction` | 1 | personal | `{ panel, duringFirstSession: bool }` — panel from §11.9's key set |
| `client.unsupported` | 1 | internal | `{ reason, browser, browserMajor, os }` — reason `webgl2`\|`browser-version`\|`os`\|`memory`\|`pointer-lock` |
| `client.fps` | 1 | internal | `{ p50: 0–1000, p01: 0–1000, windowSec: 1–600 }` |
| `client.frame_time` | 1 | internal | `{ p50Ms, p95Ms, p99Ms }` each 0–10000 |
| `client.webgl_context_lost` | 1 | internal | `{ recovered: bool, uptimeSec }` |
| `client.error` | 1 | internal | `{ errorClass, fatal: bool }` — **class only, never the raw message** |
| `client.asset_build` | 1 | internal | `{ ms: 0–600000 }` |
| `client.heap` | 1 | internal | `{ usedMb: 0–65536, sampledAtSec }` |
| `client.net_health` | 1 | internal | `{ rttMs, jitterMs, lossPct: 0–100, correctionRatePerSec, snapshotAgeMs }` |

Units are in the key names. Every numeric field has stated bounds, and a value outside them is
rejected rather than clamped — a 900 000 ms frame time is a bug in the sender, and silently
clamping it to the ceiling hides that bug in the dashboard.

`client.error.errorClass` is a closed set maintained alongside the client error handler
(`webgl-init`, `asset-decode`, `net-decode`, `unhandled-rejection`, `render-loop`, `other`).
Raw error strings are never sent: they routinely contain player-authored content such as
display names and chat.

Adding an event is additive — a new row plus a version. Changing an existing payload's meaning
is a CCR, because the warehouse already has rows under the old interpretation.

### 3.4 Consent and eligibility gating

| Class | Gate |
|---|---|
| `internal` health and performance | Sent always. No personal data, needed to keep the game running |
| `personal` funnel and KPI | Requires the privacy consent state from `auth.md` §11 / `http-api.md` §4 |
| Before any consent decision | Only `internal` class is sent |

A player who declines consent still produces `internal` telemetry, because refusing to
diagnose a crash is not a privacy win for anyone. They produce no `personal` events at all.

### 3.5 Privacy rules for client telemetry

- No raw chat text, display names of *other* players, IP addresses, or precise geolocation.
- Error messages are classified to a known set before sending; raw strings can contain
  player-authored content.
- Every batch carries the correlation ID and `clientSessionId`, and nothing else identifying.
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
| Funnel/KPI | personal | standard (13 mo) |
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
