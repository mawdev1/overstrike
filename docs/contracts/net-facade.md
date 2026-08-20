# Contract 6 — Net facade

| | |
|---|---|
| **Status** | `REVIEW` — amended per Codex review; awaiting re-sign-off |
| **Version** | 1.7.0 |
| **Implements** | `src/net/facade.js` (new, P2) over `MultiplayerSession` / `NetClient` |
| **Owner** | [CC] Claude Code |
| **Consumer** | [CX] Codex — **this is the only part of `src/net/` Codex may import** |

---

## 1. Why this exists

`src/net/**` is Claude Code's territory, but it runs in the browser and the UI must read it.
Without a stated surface, Codex ends up reaching into `session.entities`, `client.snapshots`,
or prediction internals — and then every netcode change breaks the HUD, and neither lane can
move without the other.

So: one object, one import, everything the UI needs, nothing it does not.

```js
import { net } from '../net/facade.js';   // the ONLY legal import from src/net/ for [CX]
```

**Codex must not import** `protocol.js`, `client.js`, `session.js`, `prediction.js`,
`lagcomp.js`, `transport.js`, or `avatars.js`. If something needed is missing from the
facade, that is a `REQ-CC-nnn` in `docs/handoff/requests-to-backend.md`, not a reach-through.

## 2. The rule this surface encodes

> **Every field here is server-derived or explicitly labelled as prediction. The UI renders
> it. The UI never decides it.**

There is no method on this facade that makes something true. `requestInteraction('plant')`
does not plant the bomb — it asks. The plant becomes true when a snapshot says it did. A UI
that draws a completed plant because the player held the key is a UI that lies, and under
loss it lies in the player's favour, which is the exact shape of a cheat.

## 3. Connection lifecycle

```js
await net.connect(handoff)   // handoff is the MatchHandoff from realtime-lobby.md §6.1,
                            // passed through UNMODIFIED — see §3.1
net.disconnect(reason)
net.state   // 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed' | 'version-mismatch' | 'rejected'
```

### 3.1 `MatchHandoff` — the descriptor the facade needs (REQ-CC-023)

`connect()` previously took `{ url, roomId, sessionTicket }`, which meant the static fields
§5.1 promises — map, ruleset, region, build, series, spectator policy, sites — had **no way
into the facade at all**. They arrive in `match.ready`; nothing carried them across.

`connect()` now takes that message whole:

```js
MatchHandoff = {
  matchId, serverUrl, sessionTicket, expiresAt, reconnectGraceMs,
  mapId, mapVersion, mode, rulesetVersion,
  region, serverBuild, protocolVersion,
  series, sites,
  spectatorPolicyVersion,     // NOT the booleans — see below
}
```

Pass `match.ready`'s payload through unmodified. The facade stores it as the **immutable
descriptor** and merges it into `matchState`; nothing in it changes for the life of the match.

**The handoff carries no spectator booleans (REQ-CC-029).** It used to carry all three while
§5.1.0a recomputed two of them per phase — an immutable descriptor and a phase-derived value
cannot both be the source. It now carries only `spectatorPolicyVersion`, and every boolean in
`matchState.localPlayer.spectatorPolicy` is derived from that version's phase table. One
producer, no overlap.

**`matchState.matchId` comes from here**, and is required — without it the facade cannot even
form the reconnect URL, which is the endpoint that keeps a dropped player in the match. It is
a field of the §5.1 schema, not prose about one: the source table cannot add a key the shape
does not have (REQ-CC-035).

**Reload safety.** The descriptor is what a reconnect must restore, so
`POST /v1/matches/:matchId/reconnect-ticket` returns the identical `MatchHandoff` alongside
the fresh ticket. A player who reloads the page has lost the original `match.ready` and would
otherwise reconnect into a match whose map and rules it cannot name.

### 3.2 Connection states

`connect()` rejects with a typed error from `errors.md`. The states Codex must design screens
for, and what each means:

| State | Meaning | UI obligation |
|---|---|---|
| `idle` | Never connected | — |
| `connecting` | Socket open, welcome not yet received | Loading, cancellable |
| `live` | Welcome received, snapshots flowing | The match |
| `reconnecting` | Dropped inside the grace window, retrying | Countdown against the **real** grace period from `net.reconnect`, cancel available |
| `closed` | Ended, deliberately or past the grace window | Result or failure screen with reason |
| `version-mismatch` | Client protocol older/newer than server | Clean upgrade message. **Never** retry — retrying cannot succeed |
| `rejected` | Auth/token/capacity refusal | Reason-specific message from the typed error |

## 4. Outbound — intent only

```js
net.sendLoadout({ primaryIdx, secondaryIdx })   // fire-and-forget, server may refuse
net.requestInteraction(kind)                    // 'plant' | 'defuse'  — Alpha scope
```

Input itself does **not** go through the facade. `src/core/input.js` (Codex) feeds the
existing command pipeline; the facade does not re-wrap 120 Hz input.

**`pickup` and `interact` are not in the Alpha facade (REQ-CC-024).** They were listed here
while `MSG_MATCHSTATE` progress and the refusal enum covered only plant and defuse, so a UI
calling them had no defined response. Bomb pickup is contact-range with no cast time
(`bomb-rules.md` §5) and needs no request at all. They return when something needs them.

`requestInteraction` returns nothing. Progress and completion arrive in `matchState` and as
snapshot events. There is deliberately no promise to await — awaiting an interaction is how
a UI ends up believing its own optimism.

## 5. Inbound — read-only views

```js
net.localEntity      // predicted local state; the ONLY predicted value on this surface
net.remoteEntities   // Map<id, interpolated entity> — interpolated INTERP_DELAY_MS behind
net.matchState       // authoritative; see §5.1
net.netStats         // measured; see §5.2
net.reconnect        // see §5.4 — { graceEndsAt, attempt, maxAttempts, canCancel } | null
```

All are live views, re-read per frame. Nothing here is a snapshot Codex should cache across
frames; entity objects are pooled and their contents change under you.

### 5.1 `matchState`

**Expanded by REQ-CC-005.** Authoritative in full. Fields marked ¹ arrive with P3.

```js
{
  version: 1,
  matchId: string,            // REQUIRED. From MatchHandoff on first connect, and from the
                              // reconnect-ticket handoff after active-match discovery.
                              // Stable for the facade's lifetime; identical to the id in
                              // MSG_OUTCOME (wire §8.9) and in the result record.
  serverNow: number,          // ms, server clock — offset local time against THIS
  sampledAt: number,          // ms, local receipt; (serverNow - sampledAt) is the offset
  mode: 'tdm' | 'bomb',
  mapId: 'the-square', mapVersion: '1.0.0',
  rulesetVersion: 'bomb-1.0.0',
  region: 'yyz', serverBuild: string, protocolVersion: number,

  phase: 'warmup'|'freeze'|'live'|'planted'|'roundEnd'|'matchEnd',
  phaseEndsAt: number | null,   // server clock; the UI derives the countdown, never a local timer

  teams: {
    alpha: { score: number, alive: number|null, role: 'attacker'|'defender'|null },  // ¹role
    bravo: { score: number, alive: number|null, role: 'attacker'|'defender'|null },
  },
  killLimit: number | null,     // TDM

  series: {                                            // ¹
    roundsToWin: 7, maxRounds: 12,
    sideSwitchAfter: 6, sideSwitched: boolean,
    overtime: false,                                   // always false in Alpha (bomb-rules.md §2.2)
  } | null,
  round: { index: number, endsAt: number|null } | null,  // ¹

  bomb: {                                              // ¹
    state: 'none'|'carried'|'dropped'|'planted'|'defused'|'detonated',
    carrierId: number|null,     // null when unknown to you — see §5.1.1
    siteId: 'A'|'B'|null,
    position: { x, y, z } | null,   // null iff bombPositionVisible == 0 (wire §8.6).
                                    // ALWAYS null while state is 'carried' — a carried bomb's
                                    // location is the carrier's; use carrierId.
                                    // Never inferred from zero coordinates
  } | null,

  interaction: {                                       // ¹
    kind: 'none'|'plant'|'defuse',
    actorId: number|null,
    progress: number,           // 0..1, SERVER-driven. Never advance this locally
  } | null,

  sites: [ { id: 'site-A', site: 'A', callout: 'Fountain',
             center: {x,y,z}, box: {min,max} } ] | null,   // from match.ready §6.1

  localPlayer: {
    entityId: number, team: 'alpha'|'bravo'|'unassigned',
    role: 'attacker'|'defender'|null,
    alive: boolean, isSpectating: boolean, spectatingId: number|null,
    spectatorPolicy: { canSpectateEnemies: false,
                       canFreeCam: boolean,        // phase-derived, see below
                       canUseTeamChat: boolean },  // phase-derived, see below
  },
}
```

**`interaction.progress` is server-driven and must never be smoothed or extrapolated.** A plant
bar that keeps filling through a dropped packet tells the player they are safe when the server
already cancelled the plant.

**Timers are derived from `phaseEndsAt` against the server clock, not counted down locally.**
A local countdown drifts through a stall and then disagrees with the round it is describing.

#### 5.1.0 Clock domains — do not mix them

`serverNow` and `phaseEndsAt` are **server** monotonic time; `sampledAt` is **client**
`performance.now()`. Subtracting one from the other is meaningless. The correct derivation:

```js
remainingMs = (phaseEndsAt - serverNow) - (performance.now() - sampledAt);
```

Both terms of the first subtraction come from the same clock; `sampledAt` only ages the sample
locally. The facade reconstructs `serverNow` from the u32 `serverTimeMs` on the wire, handling
the 49.7-day wrap — full rules in `wire-protocol.md` §8.10.

#### 5.1.0a Spectator policy is derived per phase, not frozen at handoff

`match.ready` carries `spectatorPolicyVersion` and nothing else; **all three booleans are
derived** from that version's table below. Freezing them at handoff would have kept a dead
player locked out of free camera for the whole match, which `bomb-rules.md` §8 explicitly
allows at round end.

Policy version 1 (`canSpectateEnemies` is `false` in every phase for all of Alpha):

| Phase | `canFreeCam` | `canUseTeamChat` |
|---|---|---|
| `live`, `planted` | `false` | `false` while dead — the relay rule |
| `roundEnd`, `matchEnd` | `true` | `true` |
| `warmup`, `freeze` | `true` | `true` |

The server enforces all three regardless; the facade exposes them so the UI does not offer a
control the server will refuse.

#### 5.1.1 `bomb.carrierId` may be `null` and that is not an error

The server filters the carrier per recipient (`wire-protocol.md` §8.8): teammates always see
it, enemies only under line of sight. `null` means *not visible to you*, not *unknown*. The UI
renders absence, and must never fall back to "last known carrier" — that reconstructs the
wallhack the filtering exists to prevent.

### 5.2 `netStats`

**Expanded by REQ-CC-005.** Measured values with their sampling window attached, because a
number without one cannot be compared against a threshold.

```js
{
  sampledAt: number, windowMs: 5000,
  region: string, serverBuild: string, protocolVersion: number,
  rttMs: number, jitterMs: number, lossPct: number,
  correctionRatePerSec: number,     // reconciliation corrections per second
  correctionMagnitudeM: number,     // p95 positional correction, metres
  snapshotAgeMs: number, receiveRateHz: number,
  baselineState: 'synced'|'keyframe-pending'|'lost',
  keyframes: number, discarded: number,
}
```

Units are in the names on purpose. These feed the P1 diagnostics panel and the P5 quality
contract; the facade reports them as measured and does not smooth them into looking better.

### 5.3 Typed event payloads

Event names alone were not buildable. Each carries:

**Every field below has a named wire source.** A facade field with no source is a field the
client cannot have, and REQ-CC-012 correctly caught three of them.

| Event | Payload | Wire source |
|---|---|---|
| `welcome` | `{ clientId, entityId, matchSeed, killLimit, mode, isReconnect, isSpectator, protocolVersion, serverTickRateHz }` | `MSG_WELCOME` v2 (§8.4) |
| `matchState` | the §5.1 object | `MSG_MATCHSTATE` (§8.6) for live state; **`match.ready` (`realtime-lobby.md` §6.1) for every static field** — map, ruleset, region, build, series, spectator policy, sites |
| `stateChange` | `{ from, to, reason }` | Facade-local; `reason` from `MSG_REJECT` or socket close |
| `disconnected` | `{ reason, code, retryable, graceEndsAt: null }` | Socket close + `MSG_REJECT` (§8.3). **`graceEndsAt` is always `null` here** — a closed socket cannot deliver it; the value arrives later on `reconnectUpdate` |
| `reconnectUpdate` | `{ graceEndsAt, attempt, maxAttempts, canCancel }` | The `reconnect-ticket` HTTP response — the only authority for the deadline |
| `versionMismatch` | `{ clientVersion, serverVersion }` | `MSG_REJECT` (§8.3) |
| `interactionRefused` | `{ kind, reason }` | **`interactRefused` event (§8.7 kind 20)** — its own kind, because a refusal is not a cancellation |
| `roundEnded` | `{ roundIndex, winner, reason, scoreAlpha, scoreBravo, actorId }` | **`MSG_OUTCOME` scope 1** (§8.9) |
| `matchEnded` | `{ matchId, winner: 'alpha'\|'bravo'\|'draw'\|null, outcomeReason, terminationReason, scoreAlpha, scoreBravo, roundsPlayed }` — **`outcomeReason`**, the same name and enum as the result record; `reason` is round-level only | **`MSG_OUTCOME` scope 2** (§8.9). `winner: null` only when the match had **no** winner — an aborted forfeit/abandon carries a real winner (`match-result.md` §4.0). `null` and `'draw'` are different facts |
| `bombStateChanged` | `{ from, to, actorId, siteId }` | `MSG_MATCHSTATE` bomb fields + §8.7 events |

**`interactionRefused` maps from `interactRefused` (kind 20) and from nothing else.** An
earlier paragraph here mapped it from the *cancellation* enum, which was wrong twice over: a
cancellation is not a refusal, and the cancel enum has no value for `not-carrier` or
`already-planted`. `kind` comes from flags bits 1–5, `reason` from `amount` (`wire-protocol.md`
§8.7).

Cancellations surface separately as `bombStateChanged` and the `plantCancel`/`defuseCancel`
wire events — a plant that was interrupted is a different thing to report than one that was
never allowed to start.

`requestInteraction` still returns nothing (§4). Refusal arrives as `interactionRefused`, which
is what lets the UI distinguish "the server said no" from "the packet is still in flight" —
a promise would collapse those two into one silent case.

### 5.4 `net.reconnect`

```js
{ graceEndsAt: number,      // CLIENT monotonic ms, converted — see below
  attempt: number, maxAttempts: number, canCancel: boolean } | null
```

**Clock conversion (REQ-CC-023).** HTTP returns `graceEndsAt` as **ISO-8601 wall clock**;
every other facade time is a number. The facade converts once, on receipt:

```js
graceEndsAt = performance.now() + (Date.parse(httpGraceEndsAt) - Date.parse(httpServerNow));
```

The response carries `serverNow` for exactly this subtraction, so the result never depends on
the client's clock being correct — only on it running at the right rate.

**Retry policy** is not hardcoded in the facade. `maxAttempts` and `canCancel` come from the
policy block below, defaulting to the same values as the lobby (`realtime-lobby.md` §8):

| Parameter | Value |
|---|---|
| `maxAttempts` | 5 |
| Backoff | Exponential from 1 s, ×2, jittered, cap 15 s |
| `canCancel` | `true` — the player may abandon the match rather than wait |
| Ticket | Fresh per attempt; never replay a consumed one |

Until the first `reconnectUpdate` arrives, `net.reconnect` is `null` and the UI shows an
indeterminate reconnecting state — not a countdown against a number it guessed.

`graceEndsAt` is the server's authoritative deadline, so the countdown a player sees is the
real one rather than an optimistic guess.

**Where it comes from, since a dropped socket carries nothing (REQ-CC-018).** The initial
budget is `reconnectGraceMs` in `match.ready` (§6.1). On a drop the facade calls
`POST /v1/matches/:matchId/reconnect-ticket`, which returns both a fresh single-use ticket and
the authoritative `graceEndsAt`. The match ticket is single-use exactly like the lobby one, so
without that endpoint `reconnecting` was a state the client could enter and never leave.

## 6. Subscribing

```js
const off = net.on(type, fn)   // returns an unsubscribe function
```

**§5.3 is the canonical event table.** This section previously carried a second, older table
that had drifted out of step with it — a stale `welcome` payload, and `disconnected` missing
`graceEndsAt`. REQ-CC-012 was right that two tables means one of them is wrong; there is now
one, in §5.3.

Two additional low-level events not in §5.3, because they carry no domain payload:

| Type | Payload | Fires |
|---|---|---|
| `snapshot` | `{ tick, keyframe }` | Each accepted snapshot |
| `event` | one decoded wire event (`EV_KINDS`, `wire-protocol.md` §5.2 and §8.7) | As they arrive |

Handlers must not throw. A throwing handler is caught, logged with the correlation ID, and
unsubscribed — the netcode does not stop because a HUD widget has a bug.

## 7. What is deliberately absent

| Not exposed | Because |
|---|---|
| Raw snapshots / baselines | Delta and baseline management is the netcode's problem |
| Prediction internals, replay buffers | Touching them from the UI breaks reconciliation |
| Lag-comp hitboxes | Server-side only; a client that knows them can build a cheat |
| Direct entity mutation | Everything visible is server-derived |
| Anything about other players beyond `ENTITY_FIELDS` | If it is not on the wire, the UI cannot have it — that is the anti-cheat boundary, not an oversight |

## 8. Stub

`net.__stub(scenario)` drives the whole surface from a scripted timeline with no server,
behind flag `net.facade.stub`. Scenarios: `tdm-basic`, `bomb-round`, `high-latency`,
`packet-loss`, `reconnect-success`, `reconnect-timeout`, `version-mismatch`, `rejected`.

Codex builds and tests every §3 state against this without a running match server. Shipped
in P1 per Build Plan §0.5 step 3.
