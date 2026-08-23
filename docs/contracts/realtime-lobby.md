# Contract 4 — Lobby realtime channel

| | |
|---|---|
| **Status** | `FROZEN` — amendments follow CHANGELOG.md |
| **Version** | 1.12.0 |
| **Owner** | [CC] Claude Code |
| **Consumers** | [CX] shell UI, presence service, room service |

---

## 1. Shape

One authenticated WebSocket per client, opened after `POST /v1/rooms/:id/join` returns a
reservation. **JSON, not binary** — unlike the match protocol. This channel carries tens of
messages a minute, not thousands a second; the debuggability is worth more than the bytes.

```js
new WebSocket('wss://<lobby>/v1/lobby', [
  'overstrike-lobby-v1',
  `overstrike-ticket.${lobbyTicket}`,
])
```

The ticket comes from the join reservation, is single-use, and expires with the reservation.
Opening the socket is what converts a reservation into a seat. It is carried in the WebSocket
subprotocol header, never the URL, so browser history, proxy access logs, referrers, and copied
addresses cannot capture it. Servers may accept the historical `?ticket=` form only during the
compatibility window; shipping clients must not send it.

## 2. Envelope

```json
{ "t": "roster.delta", "seq": 41, "ts": "2026-08-19T18:42:03.221Z", "correlationId": "01J…", "d": { } }

// Client → server adds W3C trace context beside the durable correlation id:
{ "t": "launch.request", "correlationId": "01J…",
  "traceparent": "00-<32 lowercase hex>-<16 lowercase hex>-01", "d": { } }
```

- `seq` is per-connection and monotonic. **A gap means state was missed** — the client must
  send `state.resync` rather than guessing.
- Client→server frames carry a client-generated `correlationId`; the reply and every
  resulting event carry it back.
- Client→server frames SHOULD carry a valid W3C `traceparent`. The platform preserves its trace
  id through match allocation/status/release and the game server's terminal span; it never puts
  trace context in the public handoff or session ticket. A missing value derives a stable trace
  from `correlationId` for older clients. A present malformed/zero trace is a protocol error,
  never silently accepted under a different trace.
- Unknown `t` is ignored by both sides, so additive message types do not need a version bump.

## 3. Handshake

```
→ open with ticket subprotocol
← lobby.welcome { … }      ← complete state, see below
```

`lobby.welcome` carries **complete** state. There is no "fetch the rest over REST" step — a
client that has the welcome can render the whole lobby. Every later message is a delta
against it.

**Exact shape.** `state.snapshot` carries the identical `d` payload with
`"t": "state.snapshot"` — the envelope type differs so a reducer can tell a resync from a first
connect rather than inferring it from `seq`.

```jsonc
{ "t": "lobby.welcome", "seq": 0, "ts": "…", "correlationId": "…",
  "d": {
    "protocol": 1,
    "serverTime": "…",          // wall clock, ISO-8601 (wire-protocol.md §8.10)
    "heartbeatMs": 15000,
    "graceMs": 90000,
    "you": { "accountId": "…", "team": "alpha|bravo|unassigned",
             "ready": false, "isOwner": false, "seatHeldUntil": null },
    "room":      { /* RoomCore      — http-api.md §11.3 */ },
    "roster":    [ /* RosterMember  — http-api.md §11.3 */ ],
    "countdown": null,          // or CountdownState
    "chatHistory": [ /* ChatMessage, most recent 50, this room only */ ],
    "mutedAccountIds": [ /* persisted per-member delivery exclusions */ ],
    "pingCatalog": { "version": 1, "kinds": ["attack-a", "attack-b", "defend-a", "defend-b", "regroup", "enemy-spotted"] },
    "loadoutCatalog": { "version": "alpha-1", "primary": [ /* LoadoutItem */ ],
                        "secondary": [ /* LoadoutItem */ ] }
  } }
```

**The components are shared; the envelopes are not (REQ-CC-015).** This block used to claim it
matched the REST detail response "exactly", which was never true — REST wraps room, roster and
countdown together with `correlationId`, while here they sit under `d` with correlation on the
frame. `RoomCore`, `RoomSettings`, `RosterMember`, and `CountdownState` are defined once in
`http-api.md` §11.3 and embedded by both. `d.you` is realtime-only: it is per-connection state,
which a cacheable REST resource has no business carrying.

```jsonc
// ChatMessage
{ "id": "…", "accountId": "…", "displayName": "…",
  "text": "…",              // ≤ 200 chars, already policy-filtered
  "ts": "…", "filtered": false }
```

Fatal failures close the socket with a reserved code and the exact ErrorCode string as the
WebSocket close reason (the close control frame is limited to 123 UTF-8 bytes, so it does not
carry an `errors.md` JSON envelope): bad ticket
(`SESSION_TOKEN_INVALID`), expired reservation (`SLOT_RESERVATION_EXPIRED`), room gone
(`ROOM_NOT_FOUND`), full (`ROOM_FULL`), sanctioned (`SANCTIONED`).

Reserved close mapping: `4001 SESSION_TOKEN_INVALID`, `4002 SLOT_RESERVATION_EXPIRED`,
`4003 ROOM_NOT_FOUND`, `4004 ROOM_FULL`, `4005 SANCTIONED`, `4006 ROOM_REMOVED`,
`4007 ROOM_CLOSED`, `4008 AUTH_SESSION_REPLACED`, `4009 RECONNECT_GRACE_EXPIRED`, and
`4010 PROTOCOL_VERSION_MISMATCH`. Clients map an unreserved close to `CLIENT_NETWORK`.

## 4. Server → client

| `t` | Payload | Notes |
|---|---|---|
| `lobby.welcome` | full state | Once, at open |
| `roster.delta` | `{ added: RosterMember[], updated: RosterMember[], removed: accountId[] }` — full members on add/update, **ids only** on remove | Never a full roster after welcome, except after `state.resync` |
| `presence.delta` | `{ accountId, state: 'online'\|'in-lobby'\|'in-match'\|'offline', joinable: bool, roomId: string\|null }` | Out-of-room presence for the online list |
| `room.updated` | `Partial<RoomCore>` over the closed mutable set in `http-api.md` §11.3 — `settings` replaced wholesale | Never carries `roomId`, `mapId`, `mapVersion`, `mode`, `rulesetVersion` or `build`: those are immutable for a live room |
| `team.changed` | `{ accountId, team, byServer }` | `byServer: true` when balancing moved them, so the UI can explain it |
| `ready.changed` | `{ accountId, ready, clearedReason? }` | `clearedReason` ∈ `roster-change`, `team-change`, `loadout-change`, `room-change` |
| `countdown.started` | `{ endsAt, requiredReady, currentReady }` | |
| `countdown.tick` | `{ remainingMs }` | 1 Hz. The UI animates between ticks; it does not invent the end time |
| `countdown.aborted` | `{ reason, byAccountId? }` | `reason` ∈ `player-left`, `player-unready`, `team-imbalance`, `allocation-failed`, `owner-cancelled` |
| `match.allocating` | `{ }` | Allocation started — may take seconds |
| `match.ready` | see §6.1 — carries **all** static match metadata | **The handoff.** See §6 |
| `match.failed` | `errors.md` payload | `MATCH_ALLOCATION_FAILED`, `MATCH_SERVER_UNREACHABLE` |
| `chat.message` | `{ id, accountId, displayName, text (≤200 chars), ts, filtered: bool }` | Already policy-filtered; `filtered` marks server-redacted text |
| `chat.removed` | `{ id, reason }` | Moderation retraction |
| `ping.placed` | `{ accountId, kind, target? }` | Canned callouts |
| `mute.changed` | `{ accountId, muted }` | Authoritative acknowledgement; persisted into reconnect snapshots |
| `state.snapshot` | full state | Only in reply to `state.resync` |
| `error` | `errors.md` payload | Non-fatal; fatal errors close the socket |
| `heartbeat` | `{ serverTime }` | Every `heartbeatMs` |

## 5. Client → server

| `t` | Payload | Rate limit |
|---|---|---|
| `team.request` | `{ team: "alpha"\|"bravo"\|"auto" }` | 6/min |
| `ready.set` | `{ ready: bool }` | 20/min |
| `loadout.set` | `{ primaryIdx, secondaryIdx }` | 20/min |
| `launch.request` | `{ }` | 6/min, owner only |
| `chat.send` | `{ text }` | 10/30 s, 200 chars |
| `ping.send` | `{ kind, target? }` | 12/min |
| `mute.set` | `{ accountId, muted }` | 20/min |
| `state.resync` | `{ lastSeq }` | 3/min |
| `heartbeat.ack` | `{ }` | — |
| `leave` | `{ }` | — |

**Every one of these is a request.** The server's answering event is the truth. `ready.set`
does not make the player ready; the `ready.changed` that follows does. Codex may render
optimistically, but must reconcile to — and visibly revert on — the server's answer.

Exceeding a limit returns `error` with `CHAT_RATE_LIMITED` or `RATE_LIMITED`; it does not
close the socket. Sustained abuse does.

Ping `kind` is the closed `pingCatalog.kinds` union. `target`, when present, is exactly either
`{ kind: "site", site: "A"|"B" }` or
`{ kind: "world", x: number, y: number, z: number }`, with every coordinate in ±1000 m.
Loadout indices must name an `eligible: true` item in the corresponding welcome catalog.

## 6. The launch handshake

This is the sequence that turns a lobby into a match, and the roadmap's G1 gate runs straight
through it.

```
client  launch.request
server  validates: every required player ready, teams legal, room open
server  countdown.started        roster FROZEN — joins refused from here
server  countdown.tick × n
server  match.allocating
server  match.ready { matchId, serverUrl, sessionTicket }   → to each member individually
client  opens the match socket with sessionTicket   (wire-protocol.md)
server  room.updated { status: "in-progress" }
```

### 6.1 `match.ready` payload (REQ-CC-018)

The binary welcome cannot economically carry map ids, version strings, and policy objects, and
`net-facade.md` §5.1 needs all of them as static fields. They come from **this JSON handoff**,
not from `MSG_WELCOME`:

```jsonc
{ "matchId": "…", "serverUrl": "wss://…",
  "sessionTicket": "…", "expiresAt": "…",
  "reconnectGraceMs": 90000,
  "mapId": "the-square", "mapVersion": "1.0.0",
  "mode": "bomb", "rulesetVersion": "bomb-1.0.0",
  "region": "yyz", "serverBuild": "…", "protocolVersion": 3,
  "series": { "roundsToWin": 7, "maxRounds": 12, "sideSwitchAfter": 6, "overtime": false },
  "spectatorPolicyVersion": 1,      // booleans are phase-derived — net-facade.md §5.1.0a
  "sites": [ { "id": "site-A", "site": "A", "callout": "Fountain",
               "center": { "x": 0, "y": 0, "z": 0 },
               "box": { "min": {…}, "max": {…} } } ] }
```

`sites` is the canonical projection of `map-data.md` §3.3 objective volumes joined to their
§3.4 callout regions — computed server-side from the map manifest so the client never has to
load level geometry to label a site.

The binary `MSG_WELCOME` keeps only what changes per connection or per match restart:
ids, seed, kill limit, mode, flags, tick rate.

Binding rules:

1. **The roster freezes at `countdown.started`**, not at `match.ready`. Otherwise a player who
   joins during the countdown reaches a match server that was sized without them.
2. **Countdown abort policy (REQ-CC-011).** "Per an explicit configured rule" was not a rule,
   it was a placeholder in two places. The rule:

   | Trigger during countdown | Outcome |
   |---|---|
   | Ready count drops below `requiredReady` | `countdown.aborted`, reason `player-unready` or `player-left`. Readiness is **not** cleared — the remaining players stay green so a re-launch is one click |
   | Player leaves but ready count still meets `requiredReady` | Countdown **continues**. The roster is already frozen; a departure that does not break the threshold does not punish everyone |
   | Team balance becomes illegal | `countdown.aborted`, reason `team-imbalance`, readiness cleared |
   | Owner cancels | `countdown.aborted`, reason `owner-cancelled`, readiness preserved |
   | Allocation fails | `countdown.aborted`, reason `allocation-failed`, readiness cleared (§6 rule 4) |

   The countdown never silently re-arms. An abort is always announced with its reason.
3. `sessionTicket` is per-account, single-use, 60 s (`auth.md` §6). One player's ticket cannot
   admit another.
4. If allocation fails, everyone gets `match.failed` and the room returns to `open` with
   readiness cleared. Players are never left staring at a countdown that already died.
5. Members who never connect within the ticket TTL are dropped from the match roster, and the
   match starts without them rather than hanging.

## 7. Readiness invalidation

Ready is cleared, with `clearedReason`, whenever:

- a player joins or leaves the room (`roster-change`)
- any player changes team (`team-change`)
- the readying player changes loadout (`loadout-change`)
- room mode, map, or capacity changes (`room-change`)

Nobody is launched into a match whose shape changed after they consented to it. The UI must
show *why* readiness dropped — an unexplained green light going grey reads as a bug.

## 8. Reconnect

The socket is expected to drop.

**Corrected by REQ-CC-003.** This section previously said the client could present "the same
ticket, or a fresh one from `GET /v1/rooms/:id`". Both were impossible: the ticket is
single-use and consumed at §3, and that endpoint returns no ticket. The real flow:

```
socket drops
  → POST /v1/rooms/:id/reconnect-ticket        (authenticated, seat still held)
      200 → { lobbyTicket, expiresAt, graceEndsAt }
      409 → RECONNECT_GRACE_EXPIRED  → seat gone, re-join normally
  → open the socket with the NEW ticket subprotocol (never a URL query)
  → state.resync { lastSeq }
  ← state.snapshot   (full state, §3 shape)
```

| Rule | Value |
|---|---|
| Grace window | `graceMs` from the welcome (90 s, `bomb-rules.md` §2) |
| Attempts | Max 5, exponential backoff from 1 s with jitter, cap 15 s |
| Ticket | Fresh and single-use every attempt. **Never cache or replay a consumed one** |
| Seat | Held for the whole window; `connection: "reconnecting"` is broadcast to the roster |
| Heartbeat | 15 s; two missed heartbeats start the grace window |
| On expiry | Seat released, `RECONNECT_GRACE_EXPIRED`, roster delta removes the player |
| While the room's match is live | The grace window does **not** run. A member who is IN the match has no lobby socket by design — they closed it to enter the match server, which holds their seat and publishes its own grace through `/control/status` — so the lobby seat is held for the whole match and `POST /v1/rooms/:id/reconnect-ticket` keeps succeeding. Applying the flat window here evicted every member of a live match 90 s in, and the last eviction destroyed the room in the middle of its own match |

Heartbeat-driven staleness is also what **drives presence expiry**, so a crashed client stops
showing as online within one grace period rather than forever.

A `seq` gap on resync means state was missed; the client must take `state.snapshot` as
authoritative and discard local deltas rather than merging.

## 9. Chat rules

- Rate-limited, length-limited, policy-filtered **server-side**. A client-side filter is a
  display convenience and is never the enforcement point.
- History does not cross rooms. Joining a room does not reveal what was said before.
- `chat.removed` lets moderation retract a message that already shipped.
- Mute is client-applied for display, **and** server-enforced for delivery — a muted player's
  messages are not sent to the muter at all, so a modified client cannot un-mute someone.
- Every accepted message is policy-filtered server-side, assigned a ULID, and retained in the
  internal `chat_messages` evidence store per `telemetry.md` §5. New room joins never receive
  persisted history. `POST /v1/reports` may carry that `chatMessageId`; the platform verifies
  the message sender is the reported subject and the reporter belongs to its room. Moderation
  removal persists actor/reason/time before broadcasting `chat.removed`; removal never erases
  report evidence early.
- **Voice is out of scope** until P5 moderation and privacy land.

## 10. Stub

`lobby.stub` replays deterministic timelines with no server. Every branch a lobby screen can
reach has one (REQ-CC-041):

| Scenario | Covers |
|---|---|
| `happy-path` | join → roster → team → ready → countdown → `match.ready` |
| `player-joins-mid` | `roster.delta` add during lobby |
| `team-full` / `ready-cleared` | Refused switch; readiness invalidation with `clearedReason` |
| `countdown-abort-unready` | Abort below `requiredReady`, readiness preserved |
| `countdown-continues` | A leaver that does **not** break the threshold; countdown runs on |
| `countdown-abort-imbalance` | Abort with readiness cleared |
| `allocation-failed` | `match.failed`, room returns to `open` |
| `room-closed` | `room.updated` → `closing` → socket close with `ROOM_CLOSED` |
| `kicked` | `ROOM_REMOVED` with reason; no auto-rejoin |
| `disconnect-resync` | Drop → reconnect-ticket → `state.resync` → `state.snapshot` |
| `reconnect-grace-exhausted` | 5 attempts, backoff, then `RECONNECT_GRACE_EXPIRED` |
| `handoff-version-mismatch` | `match.ready` → match socket → `PROTOCOL_VERSION_MISMATCH` |
| `sanctioned` / `chat-flood` | `SANCTIONED`; `CHAT_RATE_LIMITED` without socket close |
