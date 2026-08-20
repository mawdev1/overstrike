# Out-of-match shell information architecture

**Owner:** Codex (`[CX]`)  
**Phase:** P0  
**Version:** 0.1  
**Status:** Ready for product and contract review  
**Last updated:** 2026-08-19

## Objective

Define a browser application shell that owns account, profile, room, lobby, settings, and post-match presentation while the three.js game engine remains unloaded. The shell presents authoritative platform/lobby/match data; it does not own gameplay or service rules.

## Top-level model

The application has three runtime boundaries:

| Boundary | Loaded when | Owns |
|---|---|---|
| App shell | Initial page load | Routing, session presentation, platform client, global errors, offline state, settings UI |
| Lobby realtime | While joined/resyncing | Authoritative room snapshot/deltas, chat, countdown, launch handoff |
| Game runtime | Loading, active match, reconnect | three.js, HUD, input/pointer lock, match-net facade |

The app shell survives game-runtime creation and disposal. Returning from a match reuses the existing shell and lobby context rather than reloading the page.

## Route hierarchy

```text
/
├── /welcome
├── /auth
│   ├── /sign-in
│   ├── /create-account
│   └── /recover
├── /onboarding
│   ├── /display-name
│   └── /essential-settings
├── /play
│   ├── /rooms
│   └── /rooms/:roomId
├── /room/:roomId
│   ├── /roster
│   ├── /loadout
│   └── /chat
├── /career
│   ├── /overview
│   ├── /modes
│   ├── /weapons
│   ├── /matches
│   └── /matches/:matchId
├── /settings/:category
├── /sessions
├── /match/loading
├── /match/reconnect
├── /results/:matchId
└── /system/:condition
```

Routes are logical and may be represented with the History API; URLs must survive reload. Secrets, access tokens, reservation tokens, and handoff tokens never appear in URLs.

## Navigation model

### Signed out

Header: product identity. Main actions: Sign in, Create account. Footer: accessibility/settings, status, privacy, terms, support.

### Signed in, no room

Persistent primary navigation:

1. Play
2. Career
3. Loadout
4. Settings

Account menu: display name, sessions/devices, privacy, sign out. Current connectivity is always present but low emphasis while healthy.

### In a room

Room context replaces primary “Play” content and is persistent until the server confirms leave/close. Career remains read-only; Loadout opens as a room-aware drawer; Settings remains available. Leaving a room is explicit.

### Match transition and match

Normal shell navigation is inert during accepted handoff. Only loading status, accessibility essentials, diagnostics, and cancel/return actions permitted by the contract remain. During play, the game HUD/pause menu owns presentation. The shell stays mounted but hidden and non-interactive.

### Results

Results preserve room context. Return to lobby is primary; Career and match detail are secondary. If room recovery fails, Play/rooms becomes the primary destination.

## Application state machine

```text
BOOT
  -> SIGNED_OUT
  -> AUTHENTICATING
  -> ONBOARDING
  -> BROWSING
  -> JOINING_ROOM
  -> IN_ROOM
  -> LAUNCHING
  -> IN_MATCH
  -> RECONNECTING_MATCH
  -> RESULTS
  -> RETURNING_TO_ROOM

Any authenticated state -> SESSION_REFRESHING -> prior state | SIGNED_OUT
Any networked state -> DEGRADED/OFFLINE -> resync prior state | safe fallback
Any state -> UPDATE_REQUIRED | MAINTENANCE when directed by the platform
```

Transitions occur only after the owning service acknowledges them. UI may show pending intent, but pending intent does not mutate authoritative state.

## State ownership

| State slice | Source of truth | Client persistence |
|---|---|---|
| Session/authentication | Auth contract/platform | Contract-approved credential only; never in URL |
| Profile/display identity | Profile API | Read cache with freshness metadata |
| Room list | Platform API | Memory cache; stale rows labelled and non-joinable |
| Room membership/roster/ready | Lobby snapshot and ordered deltas | Last snapshot for stale presentation only |
| Match launch | Lobby handoff | Memory only, shortest practical lifetime |
| Match state | Net facade/match server | No authoritative local persistence |
| Result/career stats | Result/profile APIs | Read cache; pending state distinct from final |
| Local settings | `Settings` | Local storage, validated on read |
| Roaming settings | Profile API | Local cache plus explicit sync status |

## Screen inventory and required variants

Every data screen is implemented as an isolated view with a state fixture. `Not applicable` means the state cannot truthfully occur for that screen.

| Screen | Loading | Empty | Recoverable error | Offline/stale | Terminal/policy |
|---|---|---|---|---|---|
| Welcome/compatibility | Capability check | N/A | Retry check | Local-only entry | Unsupported/update required |
| Sign in/create | Submit pending | Initial form | Rate limit/network | Cannot submit | Restricted/ineligible |
| Recovery | Submit/check pending | Initial form | Expired/rate limit | Cannot submit | Completed/invalid request |
| Display name | Availability/submit | Initial field | Service/policy retry | Cannot submit | Account restriction |
| Essential settings | Roaming load/save | Defaults | Unsynced changes | Local changes allowed | N/A |
| Server browser | Skeleton rows | No rooms/no filter matches | Fetch failed | Stale list, join disabled | Maintenance/update |
| Room details | Details fetch | Room gone | Refresh/join failed | Last details stale | Ineligible/version/full |
| Lobby | Snapshot/resync | Empty team slots | Mutation refused | Frozen stale snapshot | Kicked/closed |
| Career overview | Skeleton | No matches | Retry | Cached and dated | Profile unavailable |
| Match history/detail | Skeleton | No history | Retry/not found | Cached and dated | Redacted/invalidated |
| Sessions/devices | Skeleton | Current session only | Revoke failed | Read-only cached | Session revoked |
| Loading/handoff | Named stages | N/A | Safe retry if allowed | Bounded reconnect | Protocol/renderer failure |
| Match reconnect | Server grace countdown | N/A | Retry within grace | Connection lost | Grace expired/replaced |
| Results | Result pending | N/A | Stats settlement pending | Durable result, platform offline | Invalidated/aborted |

## Global layers

Layer order from least to most interruptive:

1. Screen content.
2. Non-modal toast region for confirmed background outcomes.
3. Connection/status banner.
4. Drawer (loadout, filters, diagnostics).
5. Confirmation dialog.
6. Session-ended, update-required, maintenance, or fatal compatibility takeover.

Only one modal dialog may be open. Focus is trapped within it, Escape follows the stated cancellation policy, and focus returns to the opener. Toasts never contain the only copy of an error and do not steal focus.

## Connection presentation

One connection component summarizes three channels without conflating them:

| Channel | States |
|---|---|
| Platform HTTP | online, degraded, offline, maintenance |
| Lobby realtime | disconnected, connecting, synchronized, stale, reconnecting, closed |
| Match socket | idle, connecting, live, degraded, reconnecting, ended |

The compact indicator shows the worst relevant state. Expanding it reveals each channel, last successful contact, bounded retry progress, measured diagnostics when contracted, and a cancel action where safe. “Online” is never inferred merely from `navigator.onLine`.

## Responsive layout

P0 recommends desktop keyboard/mouse as the Alpha support scope, pending human approval of the browser/device matrix.

- `>= 1280 x 720`: fully supported target; primary navigation rail plus content.
- `1024–1279 CSS px`: compact rail; two-column content stacks without hiding actions.
- `< 1024 CSS px` or touch-only: compatibility warning until explicitly supported. Account recovery and legal pages remain operable; match entry is blocked only if the approved matrix says so.
- Very wide layouts cap reading measure; UI chrome may expand, tables do not stretch indefinitely.
- Zoom to 200% must preserve reading and action order through reflow/scroll.

## Accessibility and interaction

- One `main` landmark and one visible `h1` per screen; navigation and account controls have explicit landmarks.
- Route changes announce the new screen title once.
- All actions are native buttons/links/inputs. Roving focus is used only for true composite widgets such as tabs.
- Keyboard and pointer interaction share the same state machine. Current bindings are shown for game actions.
- Color never carries room eligibility, team, ready, connection, or validation state alone.
- Reduced motion is applied before the first shell paint from the OS preference or saved local value.
- Errors appear beside the field and in a linked summary; focus moves to the summary after submit.
- Loading indicators expose accessible names and do not announce every animated tick.

## Current-client integration audit

Measured on 2026-08-19:

| Surface | Current implementation | P1 implication |
|---|---|---|
| Entry | `src/main.js` imports and constructs `Game` immediately | Split shell bootstrap from lazy game-runtime import |
| Menu | `src/ui/menu.js`, 1,782 lines; panels: dossier, situation, play, loadout, settings, controls, credits, results | Reuse visual language, but move out-of-match screens into isolated `src/ui/shell/` modules |
| HUD | `src/ui/hud.js`, 1,754 lines plus scoreboard/minimap modules | Keep game-only; consume match data through the frozen net facade |
| Settings | 30 non-binding defaults plus 23 default keyboard binding entries in `src/core/settings.js` | Add schema version, local/roaming split, and missing accessibility/network fields |
| Routing | In-memory `Menu.shell` (`main`, `pause`, `end`) and `Menu.panel`; no URL routing | Add reload-safe shell routes; retain pause HUD flow inside game runtime |
| Connectivity | No platform/lobby shell; scoreboard currently synthesizes display ping | Remove invented network values when measured facade data is available |
| Responsive/a11y | Width/height breakpoints, visible focus, ARIA on controls, reduced-motion CSS already exist | Preserve these strengths; add focus restoration, screen landmarks, state fixtures, and full text/contrast validation |
| World | MERIDIAN is an 86 x 86 m, three-lane Mediterranean map with 18 spawns | The Square must be a separately contracted map identity; do not silently relabel current geometry |

The current mixed menu is retained until the shell can replace one complete route at a time behind a feature flag. The game runtime remains the owner of pause, in-match settings, HUD, and immediate results transition until the post-match result handoff is integrated.

## Verification contract for `scripts/uishell.mjs`

The browser harness must be able to mount every route without constructing `Game`, inject deterministic state fixtures, and assert:

- loading, empty, error, offline/stale, and success variants;
- keyboard traversal, focus destination, dialog containment, and Escape behavior;
- no duplicate submission under repeated activation;
- auth refresh single-flight behavior as exposed by the platform client;
- route reload and safe resume;
- reduced-motion and 200% zoom layouts;
- no load of three.js/game modules before `/match/loading`;
- no fabricated success, ping, room, roster, match, or result values.

## Contract dependencies

The IA requires all P0 frontend-facing contracts, especially `auth.md`, `http-api.md`, `errors.md`, `realtime-lobby.md`, `net-facade.md`, `match-result.md`, `telemetry.md`, and `feature-flags.md`. Route names are client-owned; resource fields, transitions, permissions, retries, and terminal outcomes are contract-owned.
