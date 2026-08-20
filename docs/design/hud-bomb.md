# Bomb HUD specification

**Owner:** Codex (`[CX]`)  
**Phase:** P0  
**Version:** 0.2
**Status:** Ready for Bomb-rules and net-facade contract review  
**Last updated:** 2026-08-19

## Objective

Present a server-authoritative, no-respawn Bomb match clearly at combat speed. The HUD answers five questions without opening the scoreboard:

1. What round/phase is this?
2. How much authoritative time remains?
3. How many players are alive on each team?
4. Where is the bomb and who may act on it?
5. Am I planting, defusing, spectating, reconnecting, or waiting for the server?

The HUD never decides carrier, site eligibility, interaction validity, progress, elimination, round outcome, score, or timing.

## Data boundary

Bomb presentation consumes the frozen facade directly plus a small presentation projection;
it does not invent a second gameplay schema. The binding inputs are:

```text
net.state, net.reconnect, net.netStats
matchState.matchId, mode, mapId, mapVersion, rulesetVersion
matchState.serverNow, sampledAt, phase, phaseEndsAt
matchState.series, round, teams
matchState.bomb: state, carrierId, siteId, position|null
matchState.interaction: kind, actorId, progress
matchState.sites[]: id, site, callout, center, box
matchState.localPlayer: entityId, team, role, alive, isSpectating, spectatingId,
                        spectatorPolicy
roundEnded, matchEnded, bombStateChanged, interactionRefused and decoded Bomb events
```

Labels, icon keys, callout-distance presentation, and derived `isCarrier` are client view
models. They never become alternate authority. In particular, `bomb.position` is always null
while carried and whenever the position-presence rule filters it; the HUD never reconstructs
one from zero coordinates or stale entities.

Required events include round countdown/start/end, side switch, bomb assigned/dropped/picked up, plant started/interrupted/completed, defuse started/interrupted/completed, alive-count change, spectator target/policy change, reconnect state, and match end.

Progress values and timers are display samples from the server. A clock may count down from
an authoritative server time/expiry within a contracted freshness tolerance. Plant/defuse
progress never interpolates or extrapolates: it holds the most recent server sample, stops on
stale data, and never emits completion because its animation reached 100%.

## Information hierarchy and layout

### Top center — round strip

Persistent during live play:

- Alpha round score and upward-chevron team icon.
- Round number / overtime label.
- Bravo round score and split-bar team icon.
- Authoritative round clock.
- Alive counts directly under each team score, using person icon plus number.

The clock receives urgency treatment only at a threshold supplied or derivable from the frozen rules contract. Urgency uses weight/icon and a single non-looping cue in addition to color.

### World/compass layer — sites and bomb

- Site A: triangle icon + `A` + contracted callout/distance.
- Site B: double-bar square icon + `B` + contracted callout/distance.
- Occluded markers receive a distinct outline; offscreen markers clamp to the safe edge with direction.
- The bomb uses a unique case icon. Carrier, dropped, and planted treatments are visually distinct.
- Markers obey the server’s information policy. The client never derives hidden enemy bomb position from local entities or old snapshots.

### Center lower — interaction

Plant/defuse interaction and automatic-pickup guidance appear close to the reticle but below
the target area:

- Verb + target: `PLANT — SITE A`, `DEFUSE`, `RECOVER BOMB`.
- Current binding.
- Server-driven progress bar with numeric seconds only if the rules contract exposes a truthful remaining duration.
- Interruption/refusal explanation from a canonical code: moved, released, death, invalid
  site, blocked, round ended, connection stale, or other contracted reason. Taking damage
  alone does not interrupt under `bomb-rules.md` 1.0.0.

Only the local actor sees full interaction progress unless spectator policy explicitly permits teammates to see it.

`RECOVER BOMB` is guidance, not a third interaction request. Alpha pickup is automatic at
contact range; the facade accepts only `requestInteraction('plant'|'defuse')`, and state/event
updates confirm any pickup.

### Lower left/right — existing combat HUD

Health/armor, weapon/ammo, equipment, killfeed, damage direction, and hit confirmation retain their TDM positions. Bomb information cannot cover the reticle, hitmarker, reload state, or low-health warnings.

### Tab scoreboard

Bomb scoreboard adds:

- Current series score and side/role labels.
- Alive/dead state without color alone.
- Plants and defuses from authoritative stats.
- Connection/reconnect status from measured data.
- Round history compact strip.

It does not show fake ping. A value is displayed only when the net facade supplies a measured value and freshness.

## Bomb-state matrix

| Server state | Local carrier | Team HUD | World markers | Interaction/status |
|---|---|---|---|---|
| Pre-round/freeze | Assigned/not assigned | Round and side intro; alive roster locked | Sites visible per policy; bomb assignment shown when known | Movement/interaction unavailable reason |
| Live, carried | Yes | Persistent carrier case next to local status | Sites; no redundant bomb marker over self | Site prompt only inside eligible contracted state |
| Live, teammate carries | No | Teammate carrier icon/name if policy permits | Carrier marker according to team policy | `ESCORT CARRIER` contextual notice at most once |
| Live, dropped | No | Dropped case status | Contracted bomb location/callout for eligible viewers | Pickup prompt only when server says eligible |
| Planting | Actor | Clock remains visible | Active site emphasized by its unique shape | Authoritative plant progress; stale connection freezes presentation |
| Planted | Any | Round clock treatment changes exactly as rules contract specifies | Planted site locked as primary objective | Bomb timer/state plus defuse eligibility |
| Defusing | Actor | Alive/score remain visible | Planted site remains primary | Authoritative defuse progress; no client-side completion |
| Round resolving | Any | Final alive counts and server outcome | Markers de-emphasized | One outcome card with reason |
| Side switch | Any | Old/new roles shown explicitly | Sites keep A/B identities | Input remains unavailable until next round state |
| Overtime | Any | `OVERTIME` and current rule variant | Normal policy | Rules-summary entry available from scoreboard |
| Match ended | Any | Final series outcome | Objective markers removed | Transition to authoritative results |

## Round-transition presentation

Transitions are short, interruptible by reconnect/fatal state, and reduced-motion safe.

1. **Round start:** round number, attacking/defending role word, team shape, objective sentence. Maximum recommended hold 1.5 s; contract timing controls actual availability.
2. **Bomb assignment:** carrier receives an unmistakable case icon, text, and optional non-verbal cue. Teammates see the permitted carrier cue.
3. **Round end:** `ROUND WON`, `ROUND LOST`, or `ROUND DRAW` plus canonical reason (`TARGET DESTROYED`, `BOMB DEFUSED`, `TEAM ELIMINATED`, `TIME EXPIRED`, or contracted equivalent). Never infer the reason from local observations.
4. **Side switch:** both role labels exchange visibly; team colors/icons do not swap identities.
5. **Match end:** series outcome and transition to result-pending/complete shell state.

Simultaneous events are serialized in server event order. A late plant/elimination never produces two conflicting win banners.

## Spectator HUD

When the local player is dead:

- Combat controls are replaced by `SPECTATING`, target identity, team shape, previous/next permitted target bindings, and any server-provided respawn statement (normally `NO RESPAWN THIS ROUND`).
- The top round strip and alive counts remain.
- Site/bomb information is filtered by `spectatorPolicy`; the UI does not retain markers seen before death if the policy removes them.
- Enemy outlines, third-person free camera, enemy equipment, hidden minimap positions, and unrestricted camera travel are absent unless the frozen rules explicitly allow them.
- If no target is eligible, use an approved fixed/team-safe camera and explain why cycling is unavailable.
- Chat/ping permissions reflect server policy and clearly identify team-only scope.

The backend contract must define anti-ghosting information limits. The frontend can enforce presentation but cannot prevent out-of-band communication.

## Connection and stale-state behavior

| Condition | HUD behavior |
|---|---|
| Snapshot delayed/degraded | Connection indicator; continue last known discrete state, mark time/progress as estimating only within contracted tolerance |
| State freshness exceeded | Freeze progress and clock presentation with `SYNCING`; do not show false completion |
| Match socket lost | Full reconnect veil that keeps last frame non-interactive, actual grace expiry, attempt count, cancel if allowed |
| Reconnected | Apply full server snapshot before hiding veil; no replay of stale banners/audio |
| Grace expired | Server outcome message, then valid lobby/results destination |
| Protocol mismatch | Stop connection; clean required-upgrade screen |
| Server abort | `MATCH ABORTED` with canonical reason and result status |

## Visual and accessibility language

- Alpha always combines approved color with upward chevron; Bravo with split horizontal bar.
- Site A always combines color with solid triangle; Site B with double-bar square.
- Carrier, dropped, planted, and defuse icons differ by silhouette and text.
- Essential HUD text is at least 16 CSS px at 100% HUD scale on the minimum supported viewport; secondary labels at least 14 CSS px.
- Text and icons maintain at least 4.5:1 normal-text and 3:1 large-text/non-text contrast against their dynamic backing treatment.
- Progress bars include a text/action label and state word. Color/animation is supplementary.
- Objective sounds use distinct envelopes and optional captions such as `[BOMB DROPPED]`, `[PLANTING]`, `[BOMB PLANTED]`, and `[DEFUSING]` when permitted by information policy.
- Reduced motion replaces slides/scale punches with short opacity changes; camera shake is separately adjustable.
- HUD scale from 70–160% must preserve hierarchy. At 200% browser zoom, secondary decorations collapse before essential state.

## Audio cue constraints

Every cue is generated procedurally at runtime. Cues must be unique enough to distinguish assignment, drop, pickup, plant complete, defuse start, defuse complete, urgency, round win/loss, and side switch. A cue never reveals information the player is not allowed to see. Critical meaning also appears as text/icon; audio alone is never required.

## Failure and refusal copy

Canonical codes map to short action-oriented labels. Examples below are presentation intent, not a closed code enumeration:

| Semantic outcome | HUD copy |
|---|---|
| Not inside site | `ENTER A PLANT ZONE` |
| Wrong role/no bomb | `BOMB REQUIRED` |
| Interaction interrupted | `PLANT INTERRUPTED` / `DEFUSE INTERRUPTED` |
| State already resolved | `ROUND ALREADY RESOLVED` |
| Connection too stale | `SYNCING — ACTION PAUSED` |
| Spectator target forbidden | `TARGET NOT AVAILABLE` |

The final mapping waits for `errors.md` and `bomb-rules.md`; the UI never parses backend prose.

## Fixture and screenshot matrix

`scripts/uishell.mjs` or a dedicated CX-owned Bomb HUD visual harness must render at minimum:

- Pre-round attacker and defender.
- Carrier self, teammate carrier, dropped bomb, and both sites.
- Plant 0%, 50%, 99%, interrupted, and complete.
- Planted idle; defuse 0%, 50%, 99%, interrupted, and complete.
- One-versus-one, eliminated local player, eligible spectator, no eligible target.
- Round won/lost/draw for every canonical reason and a side switch.
- Regulation and every approved overtime state.
- Degraded, stale, reconnecting, grace expired, aborted, protocol mismatch.
- 1280 x 720, 1920 x 1080, 21:9, HUD 70/100/160%, 200% zoom.
- Reduced motion, grayscale, and approved color-vision simulations.

Assertions verify text/state/icon combinations, server sample correction, focus/pointer behavior during overlays, and absence of client-generated completion.

## Contract review checklist

The HUD cannot be frozen until the following are answered in backend-owned contracts:

- Complete round/series state machine, precedence, and timing.
- Stable site IDs and callouts.
- Side/role and overtime representation.
- Bomb visibility rules for alive, dead, and spectator clients.
- Interaction eligibility/refusal and authoritative progress fields.
- Clock semantics before and after plant.
- Ordered event/reconnect snapshot behavior.
- Round outcome reason enumeration.
- Measured network state/freshness fields.
- UI-safe rules summary/version.
