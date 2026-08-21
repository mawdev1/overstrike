# Contract 5 — Wire protocol

| | |
|---|---|
| **Status** | `FROZEN` — amendments follow CHANGELOG.md |
| **Version** | 1.9.0 |
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

Protocol v2 adds `MSG_HELLO` (5), `MSG_REJECT` (6), `MSG_MATCHSTATE` (7), and `MSG_OUTCOME` (8).
Protocol v3 adds the coordinate-free client `MSG_TACTICAL_PING` (9) intent and the
server-positioned, same-team-only `MSG_TACTICAL_PING_EVENT` (10).
— see §8.

## 4. Commands (c→s)

Header: `u8 type`, `u8 flags (reserved, 0)`, `u32 count`. Then `count × 31` bytes:

| Offset | Type | Field |
|---:|---|---|
| 0 | u32 | `seq` |
| 4 | u32 | `tick` |
| 8 | u8 | move direction index into `MOVE_DIRS` |
| 9 | u16 | edge bits → `EDGE_BITS` |
| 11 | u16 | held bits → `HELD_BITS` — **u8 before v3** |
| 13 | i8 | `slot` (−1 = none) |
| 14 | i8 | `wheel`, clamped ±127 |
| 15 | f32 | `deltaYaw` |
| 19 | f32 | `deltaPitch` |
| 23 | f32 | `baseYaw` — checksum, not source of truth |
| 27 | f32 | `basePitch` — checksum, not source of truth |

**`EDGE_BITS` and `HELD_BITS` order is part of the wire format. Append, never insert.**
The bit index *is* the meaning; inserting a field silently reassigns every field after it.
Both tables are bounds-checked against their 16-bit field at import: a ninth held field was
unaddable before v3, and a seventeenth would encode as `false` forever with no error at all.

### 4.2 The held field is a u16 from v3 — `interactHeld` (REQ-CC-041)

`bomb-rules.md` §6.4 requires the plant key **held continuously**, and no field on the wire
could say so. `interact` is `EDGE_BITS` bit 5 — a press — and `HELD_BITS` was 8 entries in a
`setUint8`, full. `server.js` read the edge as a hold, so a key held for the full 3 s of a
plant produced one `true` and then `false` on ~360 consecutive commands: progress reset every
tick and **a human could never plant or defuse**. Bots were unaffected because `botManager.js`
calls `BombRules.requestInteract` in-process and never encodes a command.

`interactHeld` is `HELD_BITS` **bit 8**, and the held field widens u8 → u16 at offset 11.

**No pre-existing bit moved (§7 G3).** The wire is little-endian, so bits 0–7 of the u16 *are*
byte 11 — the same offset with the same value the u8 had — and bits 0–7 keep their indices.
What moves is everything after: `slot` 12→13, `wheel` 13→14, the four floats 14/18/22/26 →
15/19/23/27, and `COMMAND_BYTES` 30 → 31.

**Why moving those offsets is legal here and would not be in a snapshot.** A command batch has
never been decodable by prefix: `decodeCommands` requires `6 + n × COMMAND_BYTES` **exactly**
and throws otherwise, so no peer has ever read a command by reading a prefix of it and no
older peer can misread a longer one — it is refused at the handshake by `MSG_HELLO` /
`MSG_REJECT` before any command is decoded. `MSG_WELCOME` is the opposite case, which is why
v1's 15 bytes are still a strict prefix of v2's 21.

**Why not `flags` bit 7.** That spare bit (§5.1, §8.5) is in the per-entity `flags` byte of a
**snapshot** — server→client. A hold is a client→server fact, and the only spare bit going the
other way is the `MSG_COMMANDS` header's reserved `flags`, which is **per batch**, not per
command: a batch carries 1–16 commands from different ticks, and the whole point of §6.4 is
that each tick states whether the key was still down. A per-batch bit could not say that.

**Why not a spare `EDGE_BITS` bit.** Three are free, and it would have cost zero bytes — but
`EDGE_BITS` means "went down this frame", cleared by `Input.endFrame()` once per rendered
frame. A hold in that table would be a field whose value contradicts the table's name and the
decoder's contract, and the next reader would treat it as an edge exactly as `server.js` did.

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
| `MSG_MATCHSTATE` | 7 | s→c | 41 |
| `MSG_OUTCOME` | 8 | s→c | 32 |
| `MSG_TACTICAL_PING` | 9 | c→s | 2 |
| `MSG_TACTICAL_PING_EVENT` | 10 | s→c | 18 |

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
| 13 | u16 | `killLimit` — **`0` in Bomb** | yes |
| 15 | u16 | `protocolVersion` | **new** |
| 17 | u8 | `mode` (0 tdm, 1 bomb) | **new** |
| 18 | u8 | `flags` — bit 0 `isReconnect`, bit 1 `isSpectator` | **new** |
| 19 | u16 | `serverTickRateHz` | **new** |

Still re-sent on match restart. `isReconnect` tells the client it rebound to an existing entity
rather than spawning, so it restores rather than resets its local view.

**`killLimit` is `0` in Bomb, and `0` means "not applicable" (REQ-CC-021).** `RoomSettings`
represents the same absence as `null`, which a u16 cannot express. Decoders map `0` → `null`
when `mode` is bomb. A kill limit of zero is not otherwise reachable — `normalizeKillLimit`
clamps to `MIN_KILL_LIMIT = 1` — so the sentinel is unambiguous.

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

### 8.6 `MSG_MATCHSTATE` — 41 bytes, sent on change only

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
| 28 | u8 | `bombPositionVisible` — 0 hidden, 1 present |
| 29 | f32 | `bombX` |
| 33 | f32 | `bombY` |
| 37 | f32 | `bombZ` |

**`bombPositionVisible` is the presence signal, not the coordinates (REQ-CC-030).** The
previous rule wrote zeroes when hidden, but `(0, 0, 0)` is a perfectly valid world position —
the canonical site example in `map-data.md` uses an origin centre — so a decoder could not tell
a hidden bomb from one sitting at the origin. `bombState` cannot stand in either, because every
recipient still learns `dropped`/`planted`; only the *coordinates* are filtered.

The flag means **"position is meaningful *and* authorised"** — both conditions, not just the
second (REQ-CC-036). Encoder invariant, in order:

```
1. bombState is 'dropped' or 'planted' ?   no  → visible = 0   (nothing meaningful to send)
2. recipient authorised for it ?           no  → visible = 0
3. otherwise                                   → visible = 1, coordinates follow
```

**Step 1 is what was missing.** The rule previously said attackers *always* receive
`visible = 1`, while the coordinates were only meaningful for `dropped`/`planted` — so during
`carried` an attacker got `visible = 1` with zero coordinates, and the mapping below then
exposed that as a real position at the world origin. The bit has to be false whenever the
position is not a thing that exists.

A carried bomb's location is the **carrier's** location: the carrier is a visible entity in
the snapshot, and `bomb.carrierId` names them. `bomb.position` stays `null` in that state.

Coordinates are read **only** when the flag is 1, and map to `bomb.position: null` when it is
0. One byte, no in-band sentinel, no valid position excluded.

**Authorisation (step 2, REQ-CC-024)** follows the same rule as `bombCarrierId` (§8.8):
attackers always; defenders only when the bomb is **planted** (its position is then public —
they must find it to defuse) or when a dropped bomb is in their line of sight. Sending true coordinates to everyone
and hiding them in the UI would be a wallhack shipped in the protocol.

**Bomb position is state, not an event (REQ-CC-018).** `bombDropped` (§8.7) fires once; a
client that reconnects or resyncs after it has fired would never learn where the bomb is. It
lives in the state message so every snapshot of the world is complete on its own. Meaningful
when `bombState` is `dropped` or `planted`; zero otherwise.

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
19 roundStart      20 interactRefused
```

**`interactRefused` is separate from the cancel kinds (REQ-CC-018).** A cancellation ends
something that had started; a refusal means it never started — wrong phase, not the carrier,
already planted. The facade previously sourced `interactionRefused` from `plantCancel`, which
cannot express a precondition that was never met. It carries **both** the requested kind and the reason, because the facade needs
`{ kind, reason }` and `amount` alone cannot produce it:

| Field | Carries |
|---|---|
| flags bits 1–5 | requested kind — `1` plant, `2` defuse (the same encoding as `interact`) |
| `amount` | reason — `0` not-eligible, `1` wrong-phase, `2` outside-volume, `3` not-carrier, `4` already-planted |

Sent only to the refused player.

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

### 8.9 `MSG_OUTCOME` — round and match results (REQ-CC-012)

`net-facade.md` promised `roundEnded` and `matchEnded` payloads carrying identifiers and
reasons that **existed nowhere on the wire**: `MSG_MATCHSTATE` has no `matchId`, no winner, and
no reason field, so the facade was documenting data the client could not have. Phase alone
cannot substitute — it says a round ended, not who won or why.

| Offset | Type | Field |
|---:|---|---|
| 0 | u8 | `MSG_OUTCOME` |
| 1 | u8 | `scope` — 1 round, 2 match |
| 2 | u8 | `roundIndex` (255 = not applicable) |
| 3 | u8 | `winner` — 0 **none/undecided**, 1 alpha, 2 bravo, 3 draw |
| 4 | u8 | `reason` — see below |
| 5 | u8 | `terminationReason` — 0 completed, 1 aborted, 2 invalidated (match scope only) |
| 6 | u16 | `scoreAlpha` |
| 8 | u16 | `scoreBravo` |
| 10 | u16 | `roundsPlayed` |
| 12 | u32 | `actorId` — planter, defuser, or 0 |
| 16 | bytes[16] | `matchId`, the ULID's 16 raw bytes |

`reason` (`outcomeReason` everywhere else — one name, one enum): `0` elimination, `1` defuse,
`2` detonation, `3` timer, `4` forfeit, `5` abandon, `6` no-contest.

**`winner: 0` is "no winner", not "draw" (REQ-CC-019).** Draw is `3`. The two are different
facts and the earlier encoding could not tell them apart: an aborted or invalidated match has
no winner at all, which `match-result.md` represents as `winnerTeam: null`, while a 6-6 finish
is a genuine draw. Collapsing them would have made every invalidated match look like a tie in
the results screen and in career stats.

Every row of the `match-result.md` §4.0 matrix, with no row omitted (REQ-CC-031):

| `winner` | `terminationReason` | `reason` | `winnerTeam` |
|---|---|---|---|
| 1 or 2 | 0 completed | elimination / defuse / detonation / timer | `"alpha"` / `"bravo"` |
| 3 | 0 completed | timer | `"draw"` |
| **1 or 2** | **1 aborted** | **forfeit** | **`"alpha"` / `"bravo"`** |
| **1 or 2** | **1 aborted** | **abandon** | **`"alpha"` / `"bravo"`** |
| 0 | 1 aborted | no-contest | `null` |
| 0 | 2 invalidated | no-contest | `null` |

The two bold rows were missing. **An aborted match can have a winner** — a forfeit is the most
common abnormal ending and the winning team earns the win. `winner: 0` means no winner;
`winner: 3` means draw; they are different facts.

An earlier sentence here stated the opposite — that `forfeit`/`abandon` pair with a decided
winner *and* that every aborted match has none — sitting immediately above the rows that permit
it. It is deleted; this table is the only statement of the rule in this contract.

`matchId` travels as 16 raw bytes rather than its 26-character text form — a ULID is a 128-bit
value, and sending it as text would cost 10 extra bytes on a message that already carries
everything the results screen needs.

Sent once per round end and once per match end, immediately before the corresponding
`MSG_MATCHSTATE` phase change, so a client that renders on outcome always has the state to go
with it.

### 8.9.1 Tactical ping intent and event (P2.B3)

The two-byte client intent is `{ type:u8=9, kind:u8 }`, where kind is the closed vocabulary
`location=0`, `danger=1`, `objective=2`. It carries no position or target. The server accepts
at most one ping per player per 1,500 ms and only from a living, authenticated entity.

The 18-byte server event is `{ type:u8=10, senderId:u32, kind:u8, x:f32, y:f32, z:f32 }`.
Coordinates come from the authoritative server entity at acceptance time. The event is sent
only to authenticated entities on the sender's team (including the sender); the opposing team
receives no frame. Invalid kinds, dead senders, and rate-window attempts are inert.

### 8.10 Clock domains (REQ-CC-012)

Three different clocks appear across these contracts and conflating them produces timers that
drift or jump:

| Value | Domain | Epoch | Wraps? |
|---|---|---|---|
| `serverTimeMs` (`MSG_MATCHSTATE`) | Server monotonic | Server process start | **Yes — u32, every 49.7 days** |
| `serverNow` (`net-facade.md` §5.1) | Server monotonic, reconstructed to 53-bit | Same | No |
| `sampledAt` (facade) | **Client** `performance.now()` | Client page load | No |
| `phaseEndsAt`, `endsAt` (facade, lobby) | Server monotonic, reconstructed | Same as `serverNow` | No |
| `occurredAt`, `ts` (HTTP, lobby JSON) | Wall clock, ISO-8601 UTC | Unix epoch | No |

**Never compare across domains.** `phaseEndsAt - sampledAt` is meaningless: one is server time,
the other client time. The UI computes remaining time as `phaseEndsAt - serverNow`, where both
sides come from the same server clock, and uses `sampledAt` only to age the sample locally:

```
remainingMs = (phaseEndsAt - serverNow) - (performance.now() - sampledAt)
```

**u32 wrap reconstruction.** `serverTimeMs` is the low 32 bits of a monotonic millisecond
counter. The facade reconstructs a continuous 53-bit value:

```js
if (raw < (prevRaw - 0x8000_0000)) epoch += 0x1_0000_0000;   // forward wrap
serverNow = epoch + raw;
```

The half-range comparison distinguishes a wrap from an out-of-order packet: a genuine wrap
appears as a drop of nearly 2³² ms, while reordering moves the value by milliseconds. A match
lasting 49.7 days is not the case this handles — a *server* running that long is.

### 8.11 Malformed and unknown handling

| Case | Behaviour |
|---|---|
| Unknown message type | Ignored. Additive types must not break an older peer mid-match |
| Known type, wrong length | Connection closed. A truncated frame means a desynced stream |
| `interact` kind `3` | Treated as `0`. Reserved values are never rendered |
| Enum out of range | Clamped to `0` (none), and counted as an anti-cheat signal |
| Event kind **`>= EV_KINDS.length`** | Skipped, and the rest of the event block is abandoned — variable-size events make resynchronisation impossible |

**The comparison is `>=`, not `>` (REQ-CC-038).** Wire codes are zero-based indices into
`EV_KINDS`, so the first invalid code *is* `EV_KINDS.length`. Writing `>` let exactly that
value through the guard and into `EV_KINDS[code]`, which yields `undefined` — at the decoder's
untrusted-input boundary, where every other check in this contract is deliberate about
bounds. Off-by-one at a trust boundary is the one place it is never cosmetic.

Decoder tests must include both boundary vectors: the **last valid** appended kind
(`interactRefused`, currently 20) and the **first invalid** (`EV_KINDS.length`, currently 21).

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
