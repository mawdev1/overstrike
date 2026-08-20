# First-run flow

**Owner:** Codex (`[CX]`)  
**Phase:** P0  
**Version:** 0.2
**Status:** Ready for product and contract review  
**Last updated:** 2026-08-19

## Purpose

Take a new desktop player from arrival to a completed first match without developer help. The flow must keep platform, lobby, and match-server state honest; it never implies that a pending request succeeded and never computes an authoritative result in the browser.

The approved new-account path is:

`Landing -> Eligibility -> Telemetry consent -> Account details -> Display name and signup -> Verify -> Terms -> Essential setup -> Server browser -> Room lobby -> Green up -> Loading/handoff -> Match -> Results -> Return to lobby`

This ordering is the D6 working default recorded by `http-api.md` §3a and `auth.md` §11.
Eligibility comes before consent so an ineligible visitor is never asked to consent. Landing,
eligibility, and the consent screen may emit only unlinked internal aggregate counts; linked
personal telemetry starts at signup and only after an affirmative decision. The sign-in branch remains available
from landing and resumes at the first incomplete account-policy step returned by the platform.

Bomb is not forced as the first match. The browser may recommend an eligible TDM room with open slots; the player may choose either Alpha mode when rooms exist.

## Flow-wide rules

- A persistent step indicator appears only during account setup. It is not shown in the server browser or lobby.
- Back preserves completed, non-secret fields. Passwords, recovery codes, and expired room reservations are never restored.
- Submit controls show an in-place pending state and cannot be submitted twice.
- UI branches on canonical error `code`, never on server message text.
- The platform response, lobby snapshot, launch handoff, and match result are the sources of truth for their respective screens.
- Offline is a first-class state. The player may change local settings while offline but cannot enter a room or match.
- Session revocation, maintenance, and required-upgrade states interrupt the flow wherever they occur and offer only valid recovery actions.
- Keyboard focus moves to the screen heading after navigation and to the error summary after a failed submit. Restored screens return focus to the initiating control.
- Closing or reloading the tab resumes at the earliest safe state: signed-out landing, account setup, browser, current room, reconnect, or results. It never fabricates a room or match from stale local state.

## Screen flow

### 1. Landing and compatibility check

**Purpose:** establish product context, validate the client, and choose sign-in or account creation before loading the three.js game engine.

**Primary UI**

- OVERSTRIKE identity and a plain-language “desktop tactical FPS” description.
- `SIGN IN` and `CREATE ACCOUNT` actions.
- Links to accessibility/settings, privacy, terms, service status, and support.
- Build version and environment in a low-emphasis footer.

**States**

| State | Presentation | Valid actions |
|---|---|---|
| Checking | Short compatibility check with determinate items; no fake percentage | Accessibility/settings remains available |
| Supported | Entry actions enabled | Sign in, create account |
| Unsupported browser | Names the failed capability and supported matrix | Learn more, copy diagnostics |
| Required update | Current and required versions shown | Reload/update only |
| Maintenance | Server-provided summary and retry guidance | Retry, service status |
| Platform offline | Local compatibility result retained | Retry, local settings |

WebGL/game-engine initialization is deferred until launch. Failure to create a renderer therefore belongs to the loading/handoff screen, not initial account browsing.

### 2. Eligibility, consent, and account access

`CREATE ACCOUNT` runs one ordered gate sequence. The client may navigate back, but it cannot
skip ahead or reorder these calls:

1. Submit date of birth and jurisdiction to the eligibility preflight. The client does not
   retain the birthdate after the response and carries only the opaque eligibility receipt.
2. If eligible, present the versioned telemetry-consent decision. A decline is valid and does
   not prevent account creation; personal telemetry remains disabled.
3. Collect account credentials, then collect the display name on the next screen.
4. Submit the credentials and display name together with the eligibility receipt,
   `clientSessionId`, and consent receipt. Replace the signed-out consent receipt with the
   account-scoped receipt returned by signup.
5. Complete account verification.
6. Read and accept the current terms version.

The landing and eligibility steps are intentionally not linkable into a per-visitor funnel.
The UI does not queue their personal events and replay them after consent.

**Sign in fields:** identifier, password, show/hide password.  
**Create-account fields:** identifier, password, and password confirmation. Display name is
collected on the next screen and sent in the same signup request. Age and telemetry consent
are separate preceding gates, not fields inside signup.

**States and errors**

- Initial, field validation, submitting, success.
- Invalid credentials uses a neutral message that does not disclose account existence.
- Rate limited shows a server-provided retry time when available.
- Account restricted, verification required, age/region ineligible, and terms update each have a dedicated explanation and allowed next action.
- Network interruption keeps the identifier and clears secret fields only when their security lifetime expires.
- A 401 during an authenticated step invokes the auth refresh policy once; failure returns here with “session ended.” A 403 is displayed as a permission/policy refusal and is not retried.

Account recovery begins from this screen and returns here after completion. It does not silently sign the player in unless the authentication contract explicitly guarantees that behavior.

### 3. Display name

**Purpose:** collect the public identity used by rooms, teams, scoreboards, reports, and
results, then submit the complete signup request assembled across screens 2–3.

**UI and behavior**

- One display-name field with length guidance and an example, not a pre-filled suggestion that could be submitted accidentally.
- Availability/policy checks are debounced; the final submit sends credentials, display name,
  eligibility receipt, client-session ID, and consent receipt together and always relies on
  the authoritative server response.
- Availability states: unchecked, checking, available, unavailable, policy refusal, cooldown, service unavailable.
- Policy refusals use an actionable reason code when the contract permits it. The client does not reproduce a profanity or impersonation ruleset.
- The player can sign out without completing the step.

### 4. Essential setup

This is a short first-match setup, not the full settings catalog. Every control includes `USE RECOMMENDED` and can be changed later.

| Control | Initial value | Notes |
|---|---|---|
| Mouse sensitivity | `0.90` | Live preview without pointer lock; numeric value shown |
| ADS sensitivity | `0.75x` | Explained as a multiplier |
| Field of view | `85°` vertical | Preview diagram; no forced camera animation |
| Master volume | `80%` | Preview requires a user gesture |
| Subtitles | `On` | Includes speaker/effect labels when relevant |
| Reduced motion | OS preference, otherwise `Off` | Explicitly covers menu motion and camera shake reduction |

The player may open complete controls/accessibility settings. `CONTINUE` remains visible and returns to this step. Local settings save immediately; roaming settings queue until the profile endpoint confirms them and retain a visible unsynced state on failure.

### 5. Server browser

**Purpose:** find a real, joinable room using measured information.

**Default presentation**

- Room rows show name/ID, The Square, TDM or Bomb, players/capacity, region, measured ping, room status, and join eligibility.
- Default sort: joinable first, then measured latency, then occupancy. No unmeasured latency is displayed as a number.
- Filters: mode, region, joinable, has space, and text search. Reset is one action.
- A first-run callout explains room, team, and green-up in three short steps and can be dismissed permanently.

**States**

| State | Message/action |
|---|---|
| Loading | Stable row skeletons; refresh control disabled |
| Results | Last-updated time and refresh behavior shown |
| No rooms | “No rooms match” with reset filters, or “No rooms are active” with create/quick-join only if contracted |
| Platform unreachable | Connection error, retry, and service status; never presented as an empty list |
| Stale | Existing rows dimmed and labelled stale; joining disabled until refreshed |
| Rate limited | Countdown to allowed refresh |
| Auth expired | One refresh attempt, then return to sign in |

Selecting a room opens details without reserving a slot. `JOIN` creates the reservation. Full, password-required, version-incompatible, restricted, in-progress Bomb, and high-latency conditions are explicit before the request.

### 6. Join reservation and room lobby

The transition to a room has visible steps: `Requesting slot -> Joining room channel -> Synchronizing roster -> Ready`. A cancel action is available until the server marks the reservation committed.

**Lobby layout**

- Room summary: map, mode, region, measured ping, status, capacity, and rules version.
- Alpha and Bravo roster columns. Each row includes display name, self marker, host marker, network state, and a ready word/icon in addition to color.
- Team join/switch controls. Optimistic feedback is permitted only as a pending treatment; the roster moves when the authoritative snapshot/delta confirms it.
- Loadout drawer, text chat, mute/report entry points, leave-room action, and a single connection indicator.
- `GREEN UP` becomes `READY — SELECT TO CANCEL` after acknowledgement. A server-provided reason appears whenever readiness is unavailable or cleared.

**Lobby edge cases**

- Slot expired: automatically retry the idempotent join once as required by `errors.md`; if
  it expires again, return to room details with refreshed occupancy. A full room returns
  directly to details and is never retried as though capacity were a transient client error.
- Team full/balance refusal: restore the authoritative team and announce the refusal.
- Ready cleared by roster, team, rules, or loadout change: remove ready styling and announce the server-provided reason.
- Room closed/host left: follow the authoritative lifecycle; do not assume host migration.
- Lobby socket loss: retain the last snapshot as stale, disable mutations, show bounded reconnect attempts, then offer browser/exit.
- Kicked/restricted/version mismatch: leave the room and display a dedicated terminal explanation.
- Bomb round active: spectate/join-next-round appears only when the room contract explicitly allows it; never silently backfill.

### 7. Green-up, countdown, and loading/handoff

The countdown is rendered from lobby events. It stops or re-arms when the server says so. The client never launches because its own timer reached zero.

Loading has named stages without invented progress:

1. Roster locked.
2. Match server allocated.
3. Session accepted.
4. The Square geometry prepared.
5. Waiting for authoritative match start.

Failures have dedicated outcomes: allocation failed, allocation timed out, match server unreachable, handoff token expired/replayed, protocol mismatch, renderer/WebGL failure, player removed, and match aborted. Retry is shown only when the error contract marks it safe; otherwise return to the preserved lobby or browser as directed by the server.

### 8. First match

- A compact, dismissible onboarding layer identifies movement, aim/fire, scoreboard, current objective, and how to open settings. It does not pause a networked match.
- TDM onboarding explains team kill limit. Bomb onboarding explains no respawn, the two sites, carrier marker, plant/defuse interaction, and spectator limits using server-authored rules text.
- Prompts always use current bindings.
- Connection degradation and reconnect states remain visible without covering the reticle or objective progress.
- The client never advances objective progress, score, alive count, round state, or match end locally.

### 9. Results and return to lobby

**Results source:** immutable server match result. While finalization is pending, the screen says `RESULT PENDING` and does not estimate career totals.

**Content**

- Outcome, mode/map, termination reason, authoritative team/round score.
- Mode-appropriate scoreboard and personal performance.
- Bomb round history when applicable.
- Progression changes separated into confirmed, pending, and unavailable states.
- `RETURN TO LOBBY` primary action; `REMATCH` appears only after the lobby confirms eligibility.

**States:** loading result, complete, settlement/stat update pending, invalidated/aborted, platform unavailable with durable match result, kicked after match, and lobby no longer exists. If lobby recovery fails, the valid fallback is the browser—not a reconstructed local room.

## Resume and cross-tab behavior

| Saved state | Resume destination |
|---|---|
| No session | Landing/sign in |
| Session; profile incomplete | First incomplete account step |
| Session; no room | Server browser |
| Active lobby membership | Lobby resync screen, then authoritative room |
| Server reports an active held match | Call `GET /v1/matches/active`, then obtain a fresh single-use reconnect ticket and show the server expiry |
| Match ended; result available | Results, then lobby recovery |
| Revoked/expired session | Sign in with “session ended” context |

Only one tab may own an active match connection for the account. Other tabs display the server’s duplicate-session decision and may browse only if the auth/session contract permits it.

## Telemetry and privacy

Emit only events authorized by `contracts/telemetry.md`: flow step viewed/completed/failed, time to first match, settings friction, room join failure, lobby abandonment, handoff failure, first-match completion, and return-to-lobby outcome. Landing, eligibility, and the consent screen produce only the contract's unlinked internal aggregate events; `flow.step` is not used for them. Signup and later personal events carry the required receipt and `clientSessionId` after an affirmative decision; a decline emits no personal events. Request correlation IDs propagate through platform actions, while each unlinked `funnel.preconsent` event uses a fresh ID that is never reused from its request or another event. Raw password, birthdate, chat, display-name candidate, IP, or free-form server message is never included unless a contract explicitly classifies and permits it.

## Acceptance checklist

- Every numbered screen renders in loading, success, recoverable error, terminal error, and offline variants where applicable.
- A keyboard-only player can complete the full flow and never loses visible focus.
- Required fields and failures are announced without relying on color or animation.
- Reloading at every transition reaches a safe resume destination.
- Double submit, delayed response, stale room, revoked session, and disconnect paths do not create contradictory UI.
- The three.js engine is not loaded while landing, authenticating, browsing, or waiting in a lobby.
- A six-player test can sign in, join, pick teams, ready, launch, finish, and return with the same roster.

## Contract dependencies

This design cannot be frozen until `http-api.md`, `errors.md`, `auth.md`, `realtime-lobby.md`, `net-facade.md`, `match-result.md`, `telemetry.md`, and `feature-flags.md` exist and cover every state above.
