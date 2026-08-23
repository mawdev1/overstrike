# P4 playtest script — Extraction Alpha

**Owner:** Claude Code (`[CC]`)
**Phase:** P4-06
**Version:** 0.1
**Status:** Draft — scenarios cover P4-01–04 as shipped; §4 (dynamic events) is written against
the FROZEN contract and gated on P4-02 implementation landing
**Last updated:** 2026-08-23

## Purpose

A repeatable, concrete checklist a human playtester runs by hand against a live deploy — not a
substitute for the automated suite (`npm run ci`), which already asserts these systems'
contracts hold. This document is for what automated tests structurally cannot catch: whether
the *loop* feels right, whether a state the server considers correct reads as broken on
screen, and whether a rule that is correct in isolation produces a bad moment in sequence.
Pair every session with `docs/status/backend.md` / `docs/status/frontend.md`'s "known issues"
sections — a repro that matches a listed issue is not a new bug.

Every scenario names the contract section it exercises, so a failure can be filed against the
system that owns it, and the exact `npm run <script>` that already exercises the same mechanism
under automation, so "did the automated suite already know this could happen" is one command
away.

P4-05's funnel/heatmap **analysis** and P4-07's closed Alpha are explicitly human-only — this
script does not run them or manufacture usage data. It is the thing a human runs *during* those
activities.

## Before you start

1. `npm run ci` is green on the build under test. If it is not, playtesting is measuring a
   known-broken build — fix or note the failing check first.
2. Know the branch/commit under test and record it in the session notes (git sha, not just
   "latest").
3. Have at least two client sessions available for anything below marked **multi-client** —
   several scenarios (sector transition under contention, TDM/Bomb) are not meaningfully
   testable solo.
4. Open the browser console. A silent client-side exception is a defect even when the visible
   behavior looks fine — several 2026-08-21 live-deployment faults (`docs/status/backend.md`)
   were found exactly this way, not by anything the UI surfaced.

## How to file a finding

For each defect: scenario id, one-line repro, expected vs. actual, git sha, console/server log
excerpt if any, and whether `npm run ci` should have caught it (if you believe a real automated
gap exists, say so explicitly — that is P4-06 signal, not scope creep, and belongs back in this
document as a new scenario or a note under the relevant one).

---

## 1. Deploy → loot → extract happy path

Contracts: `deployment.md` §2/§7, `extraction-match.md` §1/§3/§4, `settlement.md` §4/§6.
Automated coverage: `npm run extractiontest`, `npm run raidtest`, `npm run uiraid`.

| # | Step | Expected |
|---|---|---|
| 1.1 | From the loadout screen, deploy a saved loadout (or ad hoc instances) into `square-extraction` | `POST /v1/deployments` returns a reservation; UI shows locked items as unavailable elsewhere |
| 1.2 | Enter the raid within the join window (120 s, `RUN_RULES.joinWindowSeconds`) | Client loads the map, spawns with the exact loadout reserved — no substituted or missing items |
| 1.3 | Open a sealed `lt.tier1.cache` container (any of the 6 placed on `square-extraction`) | Roll happens once, server-side; items appear in run inventory; container flips to opened for every client that can see it |
| 1.4 | Open a sealed `lt.tier2.cache` container (3 placed) | Same, richer pool — confirm `keycard_transit` is a real possible roll (may take several tries; it is the rare gate item) |
| 1.5 | Pick up a stackable item (e.g. `ammo_9mm`) you already hold some of | Quantities merge into one stack, not a duplicate row |
| 1.6 | Drop an item, then walk away and back | Item persists on the ground for other players/yourself, not silently deleted |
| 1.7 | Reach `exit-rail-gate` (north-yard) before the 840 s collapse-warning window closes and channel the extraction | Channel completes; run ends `outcome: 'extracted'`; loadout screen shows every surviving carried item now `location='permanent'` |
| 1.8 | Repeat with `exit-ferry-landing` (east-docks) holding a `keycard_transit` | Exit is gated — accepts the key, extraction proceeds identically to 1.7 |
| 1.9 | Attempt `exit-ferry-landing` **without** the key | Exit refuses; no silent partial extraction, no client-side fake success |

## 2. Death-loss

Contracts: `settlement.md` §4 (outcome matrix), `items-inventory.md` §4 (disposition).
Automated coverage: `npm run extractiontest`, `npm run raidtest`.

| # | Step | Expected |
|---|---|---|
| 2.1 | Deploy, loot several items, then die in-run (AI or environmental) | Run ends `outcome: 'died'`; every `location='run'` item for that participant is `status='lost'` — none returned to permanent inventory |
| 2.2 | Deploy and disconnect past the reconnect grace window (90 s, `RUN_RULES.reconnectGraceSeconds`) without extracting | Same disposition as death (`'aborted'`) — confirm the client that reconnects late sees the run already resolved, not a resurrected session |
| 2.3 | Deploy, pick up nothing, then die or abort immediately | Loadout returns as `lost`, not silently "returned untouched" — confirm the starting gear is genuinely gone from the post-run inventory, not just visually reset |
| 2.4 | After 2.1, check whether OP/XP were still credited for survival time / partial progress per `progression-economy.md` §3.3 | Death does not zero out an otherwise-earned OP/XP credit; verify the credited amount matches what was actually accomplished before death, not the extract-tier reward |

## 3. Sector transition

Contracts: `map-data.md` §3.7, `sector-interest.md` §3/§4.
Automated coverage: `npm run sectortest`, `npm run maptest:extraction`, `npm run navtest:extraction`.

`square-extraction` is three sectors — `square`, `north-yard`, `east-docks` — each declaring
its own `populationCap`/`baseThinkStride` and only `square`'s neighbours reaching both others
directly (`north-yard` ↔ `east-docks` is not adjacent).

| # | Step | Expected |
|---|---|---|
| 3.1 | Start in `square`, walk into `north-yard` | No load hitch, pop-in, or seam artifact at the boundary; AI in `north-yard` was not already fully active before you arrived (activation should ramp, not be free) |
| 3.2 | From `north-yard`, walk to `east-docks` via `square` (the only path — they are not adjacent) | Confirm there is no shortcut across the `north-yard`/`east-docks` boundary that the nav data disagrees with |
| 3.3 | **Multi-client:** one player in `square`, another crosses into `east-docks` alone | The lone player's sector activates independently — a bot near the first player should not go idle because the second player entered a different sector, and vice versa |
| 3.4 | Stand exactly on a sector boundary and strafe back and forth rapidly | No visible flicker between activation states, no bot repeatedly snapping awake/asleep, no console errors |
| 3.5 | Check performance (frame time / bot tick cost) crossing into the busiest sector under full population | No spike beyond what `sector-interest.md` §4's budget should bound — note the sector and approximate population if you see one |

## 4. Dynamic event encounter — gated on P4-02 landing in code

Contract: `dynamic-events.md` (FROZEN 1.0.0, `scripts/dynamiceventstest.mjs` "to be written
alongside implementation" per §11). **As of this writing, `dynamicEvent.*` has no runtime
implementation** — this section is written against the frozen contract so it is ready the
moment `src/game/**` ships it, and should be **skipped, not marked failing**, until then. Check
`docs/status/backend.md` for the landing note before running it.

| # | Step | Expected |
|---|---|---|
| 4.1 | Encounter an active `cache_drop` event | Event is announced (not discovered cold, §4.1); the anchor container rolls against a richer table than its static tier; a visible countdown to the event window closing |
| 4.2 | Let a `cache_drop` window expire unopened | Container reverts to its normal tier/table — confirm no residual "event" state lingers client-side |
| 4.3 | Find a key item, travel to its matching `locked_zone`, open it | Container refuses without the key, accepts and consumes it correctly, matches §3.2's "key is loot, not a new primitive" — no separate unlock UI hiding a second mechanism |
| 4.4 | Attempt to open a `locked_zone` with the wrong key or no key | Clean refusal, `key-required` reason surfaced somewhere legible — not a silent no-op |
| 4.5 | Observe AI density/elite share in a sector while an event is `active` there vs. before it started | Density shifts per §7, but never exceeds `sector-interest.md`'s existing `populationCap` or `AI_PROFILES.budget` — this is the property to watch for a regression, not just "did it feel harder" |
| 4.6 | Trip the event kill switch (§8.4), if a flag/tool exists to do so in the build under test | No events schedule; anything already active winds down cleanly, not frozen mid-state |

## 5. TDM / Bomb sanity

Contracts: `bomb-rules.md` (2.0.0, symmetric demolition), `match-result.md`.
Automated coverage: `npm run tdmtest`, `npm run bombtest`, `npm run bombbottest`, `npm run bottest`, `npm run siteoutcome`, `npm run uibomb`, `npm run uilobby`.

These modes are pre-existing and P4 does not change their rules — this section exists so a
playtest session sanity-checks that Alpha packaging (new deploy path, new progression hooks)
did not regress the competitive modes sharing the same client/server.

| # | Step | Expected |
|---|---|---|
| 5.1 | **Multi-client:** create a room, TDM on `the-square` | Room create, ready-up, countdown, and match start all behave — this is the same shell path extraction's deployment loop now shares code with, so a regression here can be an extraction-side change leaking across modes |
| 5.2 | Play a TDM match to completion | Score, win condition, results screen, and return-to-lobby all resolve correctly; OP/XP awarded (if applicable to PvP per `progression-economy.md`) match expectations |
| 5.3 | **Multi-client:** create a room, Bomb on `the-square` or `meridian` | Neutral bomb spawns centre-map; either team can pick it up |
| 5.4 | Plant at the enemy's site, defend your own | Only the site-owning team can defuse a plant at their own site (symmetric rule, §13) |
| 5.5 | Let a round's pre-plant timer expire with the bomb never picked up | Round is a **draw**, not a win for either side (forced consequence of symmetric demolition) |
| 5.6 | Play a full series to its conclusion (first to 7, or 12 rounds) | If 12 rounds pass without a 7-win, the team with more round wins takes the match; equal wins is a draw — confirm the results screen states this correctly rather than defaulting to a coin-flip framing |
| 5.7 | Drop a bomb mid-round (carrier dies) and have the other team pick it up | Bomb is contestable by both teams while dropped, as documented |

---

## Session log template

Copy this block per session:

```
Date:
Git sha:
Build/env (local / staging / deployed URL):
Tester:
Scenarios run: (list §s)
Findings: (id, repro, expected/actual, sha, filed where)
Anything npm run ci should have caught but didn't:
```
