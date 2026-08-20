# Contract 5 — Wire protocol

| | |
|---|---|
| **Status** | `REVIEW` — amended per Codex review; awaiting re-sign-off |
| **Version** | 1.1.0 |
| **Implements** | `src/net/protocol.js`, `src/net/client.js`, `src/net/server.js` |
| **Owner** | [CC] Claude Code |
| **Consumers** | Match server, `NetClient`, `MultiplayerSession` |

This contract **describes the protocol that already exists** and states the changes P2–P5
require. It is written from the implementation, not from an intention: where the code and a
plan disagreed, the code is recorded here as the truth and the gap is called out.

---

## 1. Shape

Binary, little-endian, hand-rolled, over a WebSocket. Two directions with different shapes:

```
client -> server    MSG_COMMANDS   batch of ~30-byte commands, one per fixed step
client -> server    MSG_LOADOUT    3 bytes, on join and on change
server -> client    MSG_WELCOME    15 bytes, on join and on every match restart
server -> client    MSG_SNAPSHOT   entity deltas + events, every SNAPSHOT_INTERVAL ticks
```

Transport is reliable and ordered. That is load-bearing: events are neither delta-coded nor
resent, because a WebSocket delivers them exactly once.

## 2. The rule the whole protocol answers to

> **A command must mean exactly the same thing on both machines.**

The client predicts a command's effect locally; the server later applies the same command
authoritatively. If the two read different values out of the same bytes, prediction is wrong
on every command and reconciliation spends its life correcting a difference the network did
not cause.

Two consequences, both already implemented, both binding on any future change:

- **Movement direction is an enum, not quantised floats.** `wishForward`/`wishRight` take
  only nine values (neutral plus eight compass directions, diagonals pre-scaled by
  `Math.SQRT1_2`). Quantising to a byte and dividing on the far side reproduces
  `0.7071067811865476` as something slightly different, and a movement integrator fed a
  slightly different direction 120 times a second diverges visibly within seconds.
- **The client must predict with wire values, not memory values.** `quantiseCommand()`
  forces a command through the wire's value space *without sending it*, because `deltaYaw`
  is a float64 in memory and a float32 on the wire. Predicting with the float64 leaves a
  tiny angular error on every command that accumulates into a permanent aim disagreement.

**Any new field is subject to both rules.** A continuous value that both sides must agree on
exactly is an enum or is passed through `quantiseCommand`.

## 3. Message types

| Const | Value | Direction | Bytes |
|---|---:|---|---|
| `MSG_COMMANDS` | 1 | c→s | `6 + n × 30` |
| `MSG_SNAPSHOT` | 2 | s→c | variable |
| `MSG_WELCOME` | 3 | s→c | 15 |
| `MSG_LOADOUT` | 4 | c→s | 3 |

## 4. Commands (c→s)

Header: `u8 type`, `u8 flags (reserved, 0)`, `u32 count`. Then `count × 30` bytes:

| Offset | Type | Field |
|---:|---|---|
| 0 | u32 | `seq` |
| 4 | u32 | `tick` |
| 8 | u8 | move direction index into `MOVE_DIRS` |
| 9 | u16 | edge bits → `EDGE_BITS` |
| 11 | u8 | held bits → `HELD_BITS` |
| 12 | i8 | `slot` (−1 = none) |
| 13 | i8 | `wheel`, clamped ±127 |
| 14 | f32 | `deltaYaw` |
| 18 | f32 | `deltaPitch` |
| 22 | f32 | `baseYaw` — checksum, not source of truth |
| 26 | f32 | `basePitch` — checksum, not source of truth |

**`EDGE_BITS` and `HELD_BITS` order is part of the wire format. Append, never insert.**
The bit index *is* the meaning; inserting a field silently reassigns every field after it.

**Absolute aim is a checksum.** Deltas alone are lossy under packet loss: one dropped command
and the server's aim is permanently offset from the client's with nothing to notice. The
server compares `baseYaw`/`basePitch` and, past a threshold, snaps and tells the client.

### 4.1 Hostile input — already handled, must stay handled

`MAX_COMMANDS_PER_BATCH = 16` is checked **before the length arithmetic and before a single
allocation**. This is not a guideline. Without it, one 100 MiB frame declares ~3.5 million
commands and `decodeCommands` allocates an object for each before any queue cap applies:
measured at 500k that is 536 ms of blocked event loop and 739 MB of heap — an OOM kill on a
512 MB server, ending the match for everyone from a single packet. The byte-length check
cannot substitute: a correctly-sized 100 MiB frame passes it and *is* the attack.

Every float from the wire passes through a finiteness check. `applyCommand` does
`baseYaw += deltaYaw`, so one NaN turns the sender's yaw, then their position, then the
snapshot every other client decodes and interpolates, then their stored lag-comp hitboxes,
all into NaN. Zero is the substitute; it means "no input".

**Rule for new fields:** every scalar read from the wire is bounds-checked or finiteness-
checked at decode. No exceptions, including for fields "the client would never send wrong".

## 5. Snapshots (s→c)

Header: `u8 type`, `u8 keyframe`, `u32 tick`, `u32 baseTick`, `u32 lastCommandSeq`,
`u32 entityCount`. Then per entity: `u32 id`, `u32 fieldMask`, then only the changed fields
in `ENTITY_FIELDS` order.

`ENTITY_FIELDS`: `x y z` (f32), `yaw pitch` (f32), `vx vy vz` (f32), `health armor` (u16),
`height lean` (f32), `flags` (u8), `team` (u8), `weaponIdx` (u8), `ammo` (u16).

This is deliberately much smaller than the snapshot manifest: it is what a client needs to
**draw** and to reason about someone else, not what a replay needs to reproduce them. The
local player's own state comes from prediction.

**The baseline is the last snapshot the client acknowledged, not the last one sent.** The
server cannot assume a packet arrived; coding against an unacknowledged baseline turns one
lost packet into a permanently corrupt view. A client whose acknowledged baseline the server
no longer holds must be sent a keyframe.

Field comparison uses `Object.is`, so a field that becomes NaN is transmitted once rather
than comparing unequal forever and re-sending every tick.

### 5.1 Entity flags

`F_ALIVE 1`, `F_CROUCH 2`, `F_SPRINT 4`, `F_SLIDE 8`, `F_FIRING 16`, `F_ADS 32`, `F_RELOAD 64`.
One bit spare in the byte.

### 5.2 Events

`EV_KINDS`: `hitmarker kill fire damaged death respawn explosion blood flash roundEnd`.
**Appended, never reordered — the wire code is the index.**

Per event: `u8 kind`, `u8 flags` (bit 0 headshot, bits 1–5 weapon index, bit 6 absorbed),
`u32 entityId|killerId`, `u32 victimId`, `u16 amount`, then `f32 x y z` for spatial kinds
(`fire damaged explosion blood flash`).

The event count is **omitted entirely when there are no events**. Most snapshots carry none,
and a delta for an entity that did not move is 26 bytes — spending 2 of them on a zero every
time is an 8% tax on the most common packet in the protocol. Decoders treat "no bytes left"
and "count of zero" identically.

Entity state alone cannot express feedback: a hitmarker is not a property of anybody's
position, it is a thing that happened once, to one player, at one instant. The first version
of this protocol carried no events, which is why a networked shot landed on the server and
the shooter saw nothing at all.

## 6. Welcome (s→c) — 15 bytes

| Offset | Type | Field |
|---:|---|---|
| 0 | u8 | `MSG_WELCOME` |
| 1 | u32 | `clientId` |
| 5 | u32 | `entityId` |
| 9 | u32 | `matchSeed` |
| 13 | u16 | `killLimit` |

Re-sent on every match restart, because `startMatch` rolls a new seed — so this is an
assignment, not a one-time handshake. The seed matters: without it the client's RNG diverges
from the server's and the player's own tracers and impact decals point where the bullet did
not go.

## 7. Known gaps — P2 deliverables

**All five are now specified in §8.** This section states *what* is missing from the
protocol as it exists today; §8 states the exact bytes that close each one.

These are **not** implemented today. They are contract requirements, and the roadmap's
public-alpha gate depends on them.

| # | Gap | Requirement |
|---|---|---|
| **G1** | **No version negotiation.** The welcome carries no version; the client infers server capability from `byteLength`, which works only while every change is a pure append | `MSG_WELCOME` gains `PROTOCOL_VERSION`. A mismatch fails the connection cleanly with an upgrade message and never proceeds to decode |
| **G2** | **No authentication.** `addClient` accepts any socket; there is no session token, so anyone who can reach the port is a player with an entity | The match server requires the single-use, room-scoped session token from `realtime-lobby.md` §6, validated against the platform before an entity is created |
| **G3** | **No Bomb state on the wire.** No round phase, plant progress, carrier flag, or alive counts | Added per `bomb-rules.md`, as appended entity fields and appended event kinds. `PROTOCOL_VERSION` → 2 |
| **G4** | **No reconnect identity.** A returning player is a new client with a new entity | Session replacement rules per `auth.md` §5; a reconnect inside the grace window rebinds to the existing entity rather than duplicating it |
| **G5** | **No protocol-level rate limit.** `MAX_COMMANDS_PER_BATCH` bounds one packet, not packets per second | Per-connection message-rate and byte-rate limits, per `http-api.md` §9 |

## 8. Protocol v2 — exact layout

**Added by REQ-CC-004.** §7 listed the gaps as prose; a contract cannot freeze on a list of
intentions. This is the byte layout. `PROTOCOL_VERSION` becomes **2** only when all of it lands
— partial adoption is what version negotiation exists to prevent.

### 8.1 New message types

| Const | Value | Direction | Bytes |
|---|---:|---|---|
| `MSG_HELLO` | 5 | c→s | 4 + `n` (ticket) |
| `MSG_REJECT` | 6 | s→c | 4 + `n` (reason) |
| `MSG_MATCHSTATE` | 7 | s→c | 28 |

### 8.2 `MSG_HELLO` — authenticated handshake (closes G1 + G2)

**The first frame on the socket.** Anything else before it closes the connection.

| Offset | Type | Field |
|---:|---|---|
| 0 | u8 | `MSG_HELLO` |
| 1 | u16 | `protocolVersion` |
| 3 | u8 | ticket byte length (≤ 255) |
| 4 | bytes | session ticket, UTF-8 (`auth.md` §6) |

Server behaviour, in this order — **the version check precedes the ticket check**, because a
mismatched client cannot be trusted to have encoded the ticket the way we read it:

1. `protocolVersion !== PROTOCOL_VERSION` → `MSG_REJECT(PROTOCOL_VERSION_MISMATCH)`, close.
2. Ticket invalid, consumed, expired, or wrong room → `MSG_REJECT(SESSION_TOKEN_INVALID)`, close.
3. Account already has a live entity in this match → replace per `auth.md` §7, and send
   `MSG_REJECT(AUTH_SESSION_REPLACED)` to the **old** socket.
4. Otherwise consume the ticket, create or rebind the entity, send `MSG_WELCOME`.

No entity exists before step 4. An unauthenticated socket can never cause allocation.

### 8.3 `MSG_REJECT`

| Offset | Type | Field |
|---:|---|---|
| 0 | u8 | `MSG_REJECT` |
| 1 | u16 | server `PROTOCOL_VERSION` |
| 3 | u8 | reason code length |
| 4 | bytes | `errors.md` code, UTF-8 (e.g. `PROTOCOL_VERSION_MISMATCH`) |

Carrying the server's version lets the client say *which* build to upgrade to instead of a bare
failure. The socket closes immediately after; the client must not retry a rejection.

### 8.4 `MSG_WELCOME` v2 — 21 bytes

| Offset | Type | Field | v1? |
|---:|---|---|---|
| 0 | u8 | `MSG_WELCOME` | yes |
| 1 | u32 | `clientId` | yes |
| 5 | u32 | `entityId` | yes |
| 9 | u32 | `matchSeed` | yes |
| 13 | u16 | `killLimit` | yes |
| 15 | u16 | `protocolVersion` | **new** |
| 17 | u8 | `mode` (0 tdm, 1 bomb) | **new** |
| 18 | u8 | `flags` — bit 0 `isReconnect`, bit 1 `isSpectator` | **new** |
| 19 | u16 | `serverTickRateHz` | **new** |

Still re-sent on match restart. `isReconnect` tells the client it rebound to an existing entity
rather than spawning, so it restores rather than resets its local view.

### 8.5 The flag-bit problem — resolved

`F_ALIVE`…`F_RELOAD` occupy bits 0–6; **one bit remains and Bomb needs two states**
(planting, defusing) plus a progress value. Squeezing both in is impossible, and progress does
not belong in a flag byte anyway.

So interaction is **an appended entity field, not a flag**:

```js
ENTITY_FIELDS.push(['interact', 'u8'])   // append only, index 16
```

| Bits | Meaning |
|---|---|
| 0–1 | kind: `0` none, `1` plant, `2` defuse, `3` reserved |
| 2–7 | progress, 0–63 → `progress / 63` |

One byte carries both states *and* progress, bit 7 of `flags` stays spare for a future boolean,
and delta coding means it costs nothing on any tick where it does not change — which is almost
all of them. 6-bit progress is ~1.6% granularity, far finer than a progress bar can show.

**The client renders `interact` progress directly and never advances it locally**
(`net-facade.md` §5.1). A bar that keeps filling through a dropped packet tells the player they
are safe when the server has already cancelled the plant.

### 8.6 `MSG_MATCHSTATE` — 28 bytes, sent on change only

Not per tick, and not inside the snapshot: match state changes a few times a round while
snapshots go out at `SNAPSHOT_INTERVAL`, so folding it in would resend unchanged bytes
thousands of times a match.

| Offset | Type | Field |
|---:|---|---|
| 0 | u8 | `MSG_MATCHSTATE` |
| 1 | u8 | `phase` — 0 warmup, 1 freeze, 2 live, 3 planted, 4 roundEnd, 5 matchEnd |
| 2 | u8 | `roundIndex` |
| 3 | u8 | `localRole` — 0 none, 1 attacker, 2 defender |
| 4 | u16 | `scoreAlpha` |
| 6 | u16 | `scoreBravo` |
| 8 | u16 | `phaseRemainingMs / 100` — deciseconds, 0–6553.5 s |
| 10 | u8 | `aliveAlpha` |
| 11 | u8 | `aliveBravo` |
| 12 | u8 | `bombState` — 0 none, 1 carried, 2 dropped, 3 planted, 4 defused, 5 detonated |
| 13 | u32 | `bombCarrierId` (0 = none) |
| 17 | u8 | `bombSite` — 0 none, 1 A, 2 B |
| 18 | u32 | `interactActorId` (0 = none) |
| 22 | u8 | `interactProgress` 0–63 |
| 23 | u8 | `sideSwitched` — 0/1 |
| 24 | u32 | `serverTimeMs` (low 32 bits) |

**Null sentinels are explicit**: entity id `0` is never a valid entity, and `0` on an enum is
always "none". A decoder never has to distinguish absent from zero.

`serverTimeMs` is what the client offsets its clock against, so a round timer stays honest
across a stall instead of drifting with local `performance.now()`.

### 8.7 Appended event kinds

Appended to `EV_KINDS` **in this order** — the wire code is the index:

```
10 plantStart      11 plantComplete    12 plantCancel
13 defuseStart     14 defuseComplete   15 defuseCancel
16 bombDropped     17 bombPickedUp     18 bombDetonated
19 roundStart
```

All reuse the existing 12-byte event header. `entityId` is the actor; `amount` carries the
cancel reason for `plantCancel`/`defuseCancel` (0 released, 1 left volume, 2 died, 3 round
ended). None are spatial, so none carry a vec3 — except that `bombDropped` and `bombDetonated`
**are** added to `EV_VEC3` and `EV_SPATIAL`, because both have a world position and both are
cullable by distance.

### 8.8 Carrier visibility

`bombCarrierId` in `MSG_MATCHSTATE` is **filtered per recipient**: teammates always see it;
enemies receive `0` unless the carrier is currently in their snapshot set via line of sight
(`bomb-rules.md` §5). Filtering happens server-side, per client, at send time.

Sending the true carrier to everyone and hiding it in the UI would be a wallhack shipped in the
protocol — the exact class of mistake §2 of `errors.md` and the anti-cheat model exist to
prevent. If it is not on the wire, the client cannot cheat with it.

### 8.9 Malformed and unknown handling

| Case | Behaviour |
|---|---|
| Unknown message type | Ignored. Additive types must not break an older peer mid-match |
| Known type, wrong length | Connection closed. A truncated frame means a desynced stream |
| `interact` kind `3` | Treated as `0`. Reserved values are never rendered |
| Enum out of range | Clamped to `0` (none), and counted as an anti-cheat signal |
| Event kind > `EV_KINDS.length` | Skipped, and the rest of the event block is abandoned — variable-size events make resynchronisation impossible |

## 9. Change rules

1. Any change to this file's shape bumps `PROTOCOL_VERSION`. Enforced by `scripts/lanecheck.mjs`.
2. `EDGE_BITS`, `HELD_BITS`, `ENTITY_FIELDS`, `EV_KINDS`, `MOVE_DIRS` are **append-only**.
3. A new continuous field that both sides must agree on exactly is an enum, or goes through
   `quantiseCommand`.
4. Every wire scalar is bounds- or finiteness-checked at decode.
5. New fields are additive with a keyframe fallback; a client that does not understand a
   field must be rejected at handshake, not fed bytes it will misread.
6. `scripts/nettest.mjs` and `scripts/wstest.mjs` must cover any new message type in the same
   change, including its malformed and hostile cases.
