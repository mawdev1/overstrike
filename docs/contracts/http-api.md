# Contract 1 — Platform HTTP API

| | |
|---|---|
| **Status** | `REVIEW` — amended per Codex review; awaiting re-sign-off |
| **Version** | 1.2.0 |
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
- Every request carries `X-Client-Build`. Below the supported floor → `UNSUPPORTED_CLIENT`.
- Errors follow `errors.md` without exception.
- Timestamps are ISO-8601 UTC with milliseconds. IDs are ULIDs as strings.
- **No endpoint returns a partial success.** A 2xx means the whole operation happened.

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

**`/v1/auth/sessions` returns an IP *class* (country/region), not a raw address.** A session
list is readable by anyone who has the account, including someone who just stole it; handing
them the owner's home IP makes a compromise worse.

## 4. Profile and stats

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/profile/me` | A | Full own profile, including privacy and moderation state |
| PATCH | `/v1/profile/me` | A | Display name, roaming settings. Idempotency key required |
| GET | `/v1/profile/:accountId` | A | Public projection, filtered by the subject's privacy settings |
| GET | `/v1/profile/:accountId/stats` | A | `?mode=tdm\|bomb\|all`. Canonical definitions in `match-result.md` |
| GET | `/v1/profile/:accountId/matches` | A | Paginated history, newest first |
| GET | `/v1/profile/me/settings` | A | Roaming settings only |
| PUT | `/v1/profile/me/settings` | A | Full replace; `If-Match` on the settings version |

`GET /v1/profile/me` response:

```json
{
  "accountId": "01J…", "displayName": "…", "createdAt": "…",
  "privacy": { "presenceVisibility": "everyone|friends|nobody", "statsVisibility": "everyone|nobody" },
  "moderation": { "status": "clear|restricted|banned", "activeSanctions": [] },
  "flags": { "nameChangeAvailableAt": "…" },
  "correlationId": "…"
}
```

**Client settings that must roam** are stored here. Machine-specific ones (resolution,
graphics quality, audio device) stay local — roaming a monitor resolution to a different
machine is a bug, not a feature.

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

Room summary in `GET /v1/rooms`:

```json
{
  "roomId": "01J…", "name": "…", "region": "yyz",
  "map": "the-square", "mode": "tdm|bomb",
  "players": 6, "capacity": 12,
  "status": "open|countdown|in-progress|closing",
  "joinable": true, "joinBlockedReason": null,
  "estimatedRttMs": 24, "hasPassword": false, "build": "…"
}
```

`estimatedRttMs` is **measured**, from the client's most recent region probe — not guessed
from geography. If it has not been measured, it is `null` and the UI shows it as unknown.
A ping number the browser invented is worse than no ping number.

`POST /v1/rooms/:id/join` returns a reservation, not a seat:

```json
{ "reservationId": "…", "expiresAt": "…", "lobbySocketUrl": "wss://…", "lobbyTicket": "…" }
```

The client must open the lobby socket with `lobbyTicket` before `expiresAt` or the slot is
released. This is what prevents a stalled joiner from holding a slot forever, and what makes
two simultaneous joiners for one seat resolve deterministically.

## 7. Matches, reports, config

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/matches/:matchId` | A | Authoritative result. `match-result.md` |
| POST | `/v1/matches/:matchId/result` | **S** | Match server → platform. Idempotent. Never browser-reachable |
| POST | `/v1/reports` | A | Player report; returns a reference |
| GET | `/v1/config/flags` | A | Client-visible flags only. `feature-flags.md` |
| GET | `/v1/config/regions` | P | Region list with probe endpoints |
| GET | `/v1/health` | P | Liveness. No dependency detail |
| GET | `/v1/health/ready` | **S** | Readiness, per dependency |

**`POST /v1/matches/:matchId/result` is service-only.** If a browser can reach it, the client
can write its own stats, and the entire G1 gate is decorative.

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
| Reports | 10/hour per account | reports |
| Service | Uncapped, mTLS-gated | S endpoints |

Exceeded → `RATE_LIMITED` or `AUTH_RATE_LIMITED` with `retryAfterMs`. Limits are enforced at
the edge **and** in the service — the edge can be bypassed.

## 10. Pagination

Cursor-based. `?limit=` (default 25, max 100) and `?cursor=`. Response:
`{ "items": [...], "nextCursor": "…"|null }`. No offset pagination anywhere — it double-counts
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
428 → VALIDATION_FAILED when If-Match is absent
```

`If-Match` is **required**. Settings roam across devices, so two tabs racing is the normal
case, not the exotic one; last-write-wins would silently discard a rebind the player just made.
The 409 returns the current server state so the UI can merge rather than re-fetch.

`schemaVersion` is the shape of `values`; `version` is the row's revision counter.

### 11.3 Room detail and roster

```json
{ "roomId": "…", "name": "…", "region": "yyz", "map": "the-square", "mapVersion": "1.0.0",
  "mode": "tdm|bomb", "rulesetVersion": "bomb-1.0.0", "build": "…",
  "status": "open|countdown|in-progress|closing",
  "capacity": 12, "playerCount": 6,
  "joinable": true,
  "joinBlockedReason": null,
  "hasPassword": false,
  "ownerAccountId": "…",
  "settings": { "killLimit": 75, "roundsToWin": 7, "backfill": true },
  "roster": [ {
      "accountId": "…", "displayName": "…",
      "team": "alpha|bravo|unassigned",
      "ready": false, "isOwner": false, "isLocal": false,
      "connection": "connected|reconnecting|disconnected",
      "estimatedRttMs": 24,
      "loadout": { "primaryIdx": 0, "secondaryIdx": 3 }
  } ],
  "countdown": null,
  "correlationId": "…" }
```

`joinBlockedReason` is a closed enum, so the UI branches rather than parses:
`full`, `in-progress`, `closing`, `password`, `sanctioned`, `region-restricted`,
`build-mismatch`, `banned-from-room`.

`countdown`, when active: `{ "endsAt": "…", "requiredReady": 8, "currentReady": 6 }`.

### 11.4 Join

```http
POST /v1/rooms/:id/join
Idempotency-Key: …
{ "password": "…" | null, "preferredTeam": "alpha|bravo|auto" }

200 → { "reservationId": "…", "expiresAt": "…",
        "lobbySocketUrl": "wss://…", "lobbyTicket": "…", "correlationId": "…" }
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
{ "items": [ { "matchId": "…", "mode": "bomb", "map": "the-square",
               "endedAt": "…", "status": "completed|aborted|invalidated|pending",
               "result": "win|loss|draw|null",
               "teamScores": { "alpha": 7, "bravo": 5 },
               "playerSummary": { "kills": 0, "deaths": 0, "assists": 0, "score": 0 } } ],
  "nextCursor": "…" | null, "correlationId": "…" }
```

### 11.6 Region probes

```json
// GET /v1/config/regions
{ "regions": [ { "id": "yyz", "label": "Toronto",
                 "probeUrl": "https://yyz.probe…/ping", "available": true } ],
  "correlationId": "…" }
```

The client measures RTT itself against `probeUrl` (3 samples, median) and sends the result as
`estimatedRttMs` on room queries. **The server never invents a ping from geography** — a
fabricated latency number is worse than an absent one, because the player trusts it.

### 11.7 Flags

See `feature-flags.md` §3.1 for the exact `GET /v1/config/flags` response.

### 11.8 Remaining endpoint schemas (REQ-CC-010)

§11.1–11.7 covered the endpoints with unusual semantics. These are the rest, so no endpoint is
left to inference.

```jsonc
// POST /v1/auth/signup   { "email", "password", "displayName", "dateOfBirth" }
// POST /v1/auth/signin   { "email", "password" }
201/200 → { "accessToken", "expiresAt", "session": { "sessionId", "deviceLabel", "createdAt" },
            "profile": { /* §4 GET /profile/me */ }, "correlationId" }
  errors: VALIDATION_FAILED · AUTH_INVALID_CREDENTIALS · AUTH_RATE_LIMITED ·
          NAME_TAKEN · NAME_POLICY_VIOLATION · AUTH_ELIGIBILITY_DENIED

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
        "stats": { … } | null,        // null when statsVisibility forbids it
        "presence": { … } | null,     // null when presenceVisibility forbids it
        "correlationId" }
  A privacy-hidden field is null. It is never omitted, and never a 403 — both would
  disclose that the setting exists and is set.

// GET /v1/presence/online?limit=&cursor=
200 → { "items": [ { "accountId", "displayName",
                     "state": "online|in-lobby|in-match",
                     "joinable": bool, "roomId": string|null } ],
        "nextCursor", "correlationId" }

// POST /v1/rooms   { "name", "region", "map", "mode", "capacity", "password"?, "settings"? }
201 → RoomState + reservation (as §11.4)

// POST /v1/rooms/:id/leave    {} → 204   (idempotent; 204 even if not a member)
// POST /v1/rooms/:id/team     { "team": "alpha"|"bravo"|"auto" } → 200 RoomState
//   errors: TEAM_FULL · TEAM_SWITCH_FORBIDDEN · NOT_IN_ROOM
// POST /v1/rooms/:id/ready    { "ready": bool } → 200 RoomState
// POST /v1/rooms/:id/loadout  { "primaryIdx", "secondaryIdx" } → 200 RoomState
//   errors: VALIDATION_FAILED (index out of range for the ruleset)
// POST /v1/rooms/:id/launch   {} → 202 { "correlationId" }
//   errors: AUTH_FORBIDDEN (not owner) · CONFLICT (not all ready) · ROOM_IN_PROGRESS

// POST /v1/reports  { "subjectAccountId", "category", "matchId"?, "description"? }
201 → { "reportId", "correlationId" }
  category ∈ cheating | harassment | offensive-name | griefing | other
  errors: REPORT_DUPLICATE · RATE_LIMITED · VALIDATION_FAILED

// GET /v1/health        → 200 { "ok": true }              (no dependency detail, ever)
// GET /v1/health/ready  → 200 { "ok", "dependencies": { "db": "up|down", … } }   [S]

// POST /v1/matches/:matchId/result   [S]  Idempotency-Key: match-result:<matchId>
  body: the full match-result.md §4 record
  200 → { "applied": bool, "correlationId" }     // applied:false = idempotent replay
  errors: CONFLICT (finalised with a different payload) · VALIDATION_FAILED
```

**`?mode=all` on stats** returns `{ "modes": { "tdm": {…}, "bomb": {…} }, "correlationId" }`,
each value being the §11.5 body. It does **not** sum across modes — a combined K/D over two
rulesets with different death semantics is a number that means nothing.

### 11.9 Roaming settings — the allowlist

`values` in §11.2 is a closed object, not free-form. It mirrors `docs/design/settings-inventory.md`;
anything outside it is rejected with `VALIDATION_FAILED` rather than stored.

| Key | Type | Range | Roams? |
|---|---|---|---|
| `sensitivity` | number | 0.05–10.0 | yes |
| `adsSensitivityScale` | number | 0.1–2.0 | yes |
| `fov` | integer | 70–110 | yes |
| `invertY` | boolean | — | yes |
| `crosshair` | object | `{ style, size 1–10, thickness 1–5, gap 0–10, colorHex, dot }` | yes |
| `hud` | object | `{ scale 0.75–1.5, showKillfeed, showMinimap, showDamageNumbers }` | yes |
| `audio` | object | `{ master, sfx, music, voice }` each 0–1 | yes |
| `accessibility` | object | `{ reduceShake, reduceMotion, subtitles, colorblindMode, textScale 1.0–1.5 }` | yes |
| `keybinds` | object | action → code, from a closed action list | yes |
| `network.showDiagnostics` | boolean | — | yes |
| resolution, graphics quality, audio device, display | — | — | **no — local only** |

The bottom row is the reason the allowlist exists: roaming a monitor resolution or a GPU
quality preset to a different machine is a bug that looks like a feature until someone signs in
on a laptop.

### 11.10 Stub scenarios (REQ-CC-010)

§12's single populated fixture cannot express an empty server browser, a pending result, or a
privacy-filtered profile — and reusing a populated fixture as an "empty" state is how a UI ships
with an empty state nobody ever saw. Deterministic named scenarios, selected by the
`X-Stub-Scenario` request header (ignored in production):

| Scenario | Produces |
|---|---|
| `default` | Signed-in account, 3 rooms across 2 regions, 20 matches of history |
| `first-run` | No account; signup/signin succeed; empty history |
| `browser-empty` | `GET /v1/rooms` → `{ items: [], nextCursor: null }` |
| `browser-unreachable` | `SERVICE_UNAVAILABLE` on room endpoints only; auth still works |
| `room-full` | Join returns `ROOM_FULL` |
| `room-in-progress` | Join returns `ROOM_IN_PROGRESS` |
| `room-password` | Join returns `ROOM_PASSWORD_REQUIRED`, then succeeds with any non-empty password |
| `result-pending` | `GET /v1/matches/:id` → `status: "pending"` for 3 calls, then completed |
| `result-invalidated` | `status: "invalidated"` |
| `history-empty` | Career totals all zero, no matches |
| `privacy-filtered` | `GET /v1/profile/:id` with `stats: null, presence: null` |
| `sanctioned` | `SANCTIONED` on room join and chat; profile still readable |
| `name-taken` | Signup and name change return `NAME_TAKEN` |
| `session-revoked` | Third authenticated call returns `AUTH_SESSION_REVOKED` |
| `token-expiry` | Access token expires after 30 s so refresh can be exercised |
| `slow` | Every response delayed 2 s, for loading states |
| `offline` | Every request fails at the transport layer |

Each is deterministic: the same scenario returns the same data every run, so a screenshot test
is stable. `?__stub=error:CODE` remains available for one-off error injection.

## 12. Stub mode

Behind `platform.api.stub`, every P1–P4 endpoint returns contract-valid deterministic
fixtures: a seeded account, 3 rooms across 2 regions, a 12-player roster, 20 matches of
history, and error fixtures reachable with `?__stub=error:CODE`. Shipped in P1 per Build Plan
§0.5 step 3, so Codex builds the whole shell before the services exist.
