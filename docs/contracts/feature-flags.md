# Contract 13 — Feature flags and kill switches

| | |
|---|---|
| **Status** | `FROZEN` — amendments follow CHANGELOG.md |
| **Version** | 1.3.0 |
| **Owner** | [CC] Claude Code |
| **Consumers** | Platform, match server, [CX] client, Admin Portal |

---

## 1. Two different things

| | Feature flag | Kill switch |
|---|---|---|
| Purpose | Roll a feature out gradually | Turn a subsystem **off** in an incident |
| Default | Off, then on, then removed | **On**; off is the emergency |
| Lifetime | Deleted once the feature ships | Permanent |
| Who flips | Developer | On-call, under an incident |
| Latency | Next evaluation | **Seconds, globally** |

A kill switch that takes a deploy is not a kill switch. Build Plan §6.2 lists the subsystems
that must have one before their phase ships.

## 2. Naming

`<domain>.<subject>.<qualifier>` — lowercase, dot-separated.

```
platform.api.stub          lobby.stub              net.facade.stub
mode.bomb.enabled          map.the_square.enabled
chat.text.enabled          room.backfill.tdm
economy.xo.spend           agent.deploy.enabled
```

Stub flags (`*.stub`) are the Build Plan §0.5 mechanism that lets Codex build against fake
data while Claude Code builds the real thing. They are deleted when the real implementation
ships — a stub flag surviving into production is a way to serve fixtures to players.

## 3. Evaluation

```jsonc
{ "flagKey": "mode.bomb.enabled", "enabled": true,
  "isKillSwitch": false,
  "rollout": { "kind": "all|percent|accounts|regions|builds", "value": … },
  "updatedBy": "…", "updatedAt": "…" }
```

Rules:

1. **Every evaluation has a safe default compiled in.** If the flag service is unreachable,
   the code takes a defined path — never an exception, never undefined behaviour. An outage
   in the flag service must not be an outage in the game.
2. Percentage rollouts bucket on a **stable hash of `accountId`**, so a player does not flip
   between behaviours on refresh.
3. Flags are evaluated **server-side** for anything that matters. `GET /v1/config/flags`
   returns only client-presentational flags; a client-evaluated flag is a client-controlled
   flag, and `mode.bomb.enabled` decided in the browser is not a rule.
4. Every change writes an `audit_log` row and a `flag.toggled` event with actor and reason.
5. Kill switches propagate in seconds — short TTL cache with an invalidation push, not a
   five-minute poll.

### 3.1 The client-visible surface (REQ-CC-009)

The previous shape contained an ellipsis and never said which registry entries the browser
receives. Exact:

```http
GET /v1/config/flags        A

200 → { "version": 41,
        "evaluatedAt": "…",
        "expiresAt": "…",
        "flags": { "shell.diagnostics.panel": true, "mode.bomb.enabled": false },
        "correlationId": "…" }
      Cache-Control: max-age=60
```

`flags` values are **booleans only** — already evaluated server-side for this account, build,
and region. The client receives no rollout percentages, no bucketing rules, and no account
lists. Shipping the rule instead of the answer would let a modified client evaluate itself
into any bucket it likes, which for `mode.bomb.enabled` is not a cosmetic concern.

**Only the keys in §3.2 are returned.** A server-side flag is never exposed, even read-only:
its existence is information about unshipped work.

| Behaviour | Rule |
|---|---|
| Refresh | On sign-in, on `expiresAt`, and on returning to the shell from a match |
| Staleness | Past `expiresAt`, keep serving the last values and refresh in the background. **Never block a screen on a flag fetch** |
| Unreachable | Every key falls back to its compiled-in default (§3, rule 1) |
| Unknown key | Compiled-in default. A key the client does not know is not an error |
| Mid-match change | **Never applied mid-match.** A flag flip must not change rules under a live player; it takes effect at the next match |

### 3.2 Client-visible registry and compiled defaults

| Key | Default | Off behaviour |
|---|---|---|
| `shell.diagnostics.panel` | `true` | Network diagnostics panel hidden from settings |
| `shell.career.enabled` | `true` | Career and history screens route to an unavailable state |
| `shell.serverbrowser.enabled` | `true` | Browser hidden; direct room links still resolve |
| `mode.tdm.enabled` | `true` | TDM hidden in room creation; **live TDM matches finish** |
| `mode.bomb.enabled` | `true` (1.2.0 — §4's "on at P3" executed) | Bomb hidden in room creation; live Bomb matches finish |
| `map.the_square.enabled` | `true` (1.2.0 — §4's "on at P3" executed) | Map hidden in room creation; live matches finish |
| `map.meridian.enabled` | `true` (1.3.0 — MERIDIAN un-retired into the room offering, map-data.md §9) | Map hidden in room creation; live matches finish |
| `chat.text.enabled` | `true` | Chat input hidden, history retained, pings unaffected |
| `chat.pings.enabled` | `true` | Ping control hidden |
| `reports.enabled` | `true` | Report entry points hidden |
| `telemetry.client.enabled` | `true` | Client sender disabled entirely |

**Disabling a flag hides the entry point; it never kills a match in progress.** The distinction
matters: `mode.bomb.enabled = false` means "no new Bomb rooms", not "end the Bomb matches
people are currently playing". Draining is `match.allocation.enabled` (§4), which is the flag
built for that job.

## 4. Registry — P1 to P5

| Flag | Kill switch | Default | Effect when off |
|---|---|---|---|
| `platform.api.stub` | no | off | Real API |
| `lobby.stub` | no | off | Real lobby |
| `net.facade.stub` | no | off | Real netcode |
| `auth.signup.enabled` | **yes** | on | No new accounts; existing sign-in works. The first lever in an abuse wave |
| `auth.recovery.enabled` | **yes** | on | Recovery suspended |
| `presence.enabled` | **yes** | on | Online lists hidden; matches unaffected |
| `lobby.enabled` | **yes** | on | No new rooms; live matches finish |
| `room.create.enabled` | **yes** | on | No new rooms; existing joinable |
| `match.allocation.enabled` | **yes** | on | No new matches; live matches finish. **The drain lever** |
| `mode.tdm.enabled` | yes | on | TDM unavailable |
| `mode.bomb.enabled` | yes | off → on at P3 (flipped, 1.2.0) | Bomb unavailable |
| `map.the_square.enabled` | yes | off → on at P3 (flipped, 1.2.0) | Map unavailable |
| `map.meridian.enabled` | yes | on (born on, 1.3.0 — the map already passed 65 autonomous Bomb rounds in CI before being offered) | Map unavailable |
| `chat.text.enabled` | **yes** | on | Chat disabled globally; pings remain |
| `chat.pings.enabled` | yes | on | Pings disabled |
| `room.backfill.tdm` | no | on | TDM rooms do not backfill |
| `reports.enabled` | no | on | Report intake suspended (**avoid**: it is the safety channel) |
| `telemetry.client.enabled` | yes | on | Client telemetry dropped |
| `evidence.capture.enabled` | yes | on | No match evidence — **anti-cheat review goes blind** |

**`match.allocation.enabled` is the most important flag in the system.** Turning it off drains
the fleet without killing a single live match: new matches stop, existing ones finish. It is
the first move in most incidents and in every deploy.

## 5. Later phases

Every subsystem in Build Plan §6.2 gets a kill switch **before** its phase ships: trading, XO
spend, payouts, agent deployment, agent spend, creator publishing, sponsor campaigns, prize
programs, marketplace settlement, wallet linking.

Value-bearing switches (`economy.*`, `agent.*.spend`, `creator.publish`, `prize.*`) additionally
require **two-person approval** to turn back **on**. Turning them off is always single-person
and always immediate — an incident is not the time to find a second approver.

## 6. Lifecycle

1. Created off, with an owner and an expected removal date.
2. Rolled out: percent → region → all.
3. **Removed** once the feature is stable. A flag nobody removes becomes a branch nobody tests,
   and both paths rot.
4. Kill switches are exempt from removal. They are permanent by design.
5. A non-kill-switch flag older than two phases is reported by CI as debt.

## 7. Verification — `scripts/flagtest.mjs`

1. Every flag has a compiled-in safe default; with the flag service unreachable, every path
   is defined and no request throws.
2. Every kill switch has been toggled **off and back on** without error — the Build Plan §0.7
   done-criterion, tested rather than asserted.
3. `match.allocation.enabled` off: no new matches allocate, live matches finish undisturbed.
4. Percentage bucketing is stable across evaluations for one account.
5. Every toggle writes an audit row and emits `flag.toggled`.
6. A client cannot influence a server-side flag evaluation.
7. Kill-switch propagation is measured and within the stated seconds.
