# Settings inventory

**Owner:** Codex (`[CX]`)  
**Phase:** P0  
**Version:** 0.2
**Status:** Ready for product and profile-contract review  
**Last updated:** 2026-08-19

## Purpose

Define every player-facing Alpha setting, its valid values/default, persistence scope, and application behavior. The UI exposes one schema; validation also occurs in `src/core/settings.js`. Stored values are untrusted and never affect authoritative match rules, scoring, inventory, permissions, or network truth.

## Persistence classes

| Class | Meaning | Examples |
|---|---|---|
| `ROAM` | Player preference follows the authenticated profile; local validated cache enables fast/offline startup | Sensitivity, bindings, crosshair, subtitles |
| `DEVICE` | Local to a browser/device because capability or physical setup differs | Render scale, quality, frame cap, volume |
| `SESSION` | Not persisted; live measured state or temporary panel choice | Diagnostics readings, current settings search |
| `PRACTICE` | Local offline/private-practice setup only; never sent as authority for an online room | Bot difficulty/count, local TDM kill limit |

Roaming settings need per-key schema/version and update semantics in the profile contract. Until that exists, the current local store remains a cache only. Device settings never overwrite roaming values from another machine.

## Canonical vocabulary

**Vocabulary version:** `1`. Category and binding-action IDs are transport/storage identifiers,
not display copy. They are lower camel case, are not localized, and remain stable if a label is
retitled. Renaming or reusing a shipped ID requires a coordinated contract change and migration.

| Category ID | Display label |
|---|---|
| `input` | Input |
| `bindings` | Bindings |
| `graphics` | Graphics |
| `audioCaptions` | Audio & captions |
| `crosshairHud` | Crosshair & HUD |
| `accessibility` | Accessibility |
| `network` | Network |

## Input and camera

| Key | Label | Type/range | Default | Scope | Applies |
|---|---|---|---:|---|---|
| `sensitivity` | Mouse sensitivity | 0.05–10.00, step 0.01 | 0.90 | ROAM | Live |
| `adsSensitivity` | ADS sensitivity multiplier | 0.05–4.00x, step 0.01 | 0.75x | ROAM | Live |
| `invertY` | Invert vertical look | Off/On | Off | ROAM | Live |
| `toggleAds` | Aim behavior | Hold/Toggle | Hold | ROAM | Live |
| `toggleCrouch` | Crouch behavior | Hold/Toggle | Hold | ROAM | Live |
| `autoSprint` | Auto sprint | Off/On | Off | ROAM | Live |
| `fov` | Vertical field of view | 60–120°, step 1° | 85° | ROAM | Live |
| `cameraShake` | Camera shake intensity | 0–100%, step 5% | 100% | ROAM | Live |
| `viewBob` | View bob intensity | 0–100%, step 5% | 60% | ROAM | Live |
| `weaponSway` | Weapon sway intensity | 0–100%, step 5% | 100% | ROAM | Live |

Reduced-motion preset proposes camera shake 25%, view bob 0%, and weapon sway 35%. Applying the preset displays the individual changes; later edits do not silently toggle the preset.

## Key and mouse bindings

All actions are `ROAM`, apply live, and have primary plus optional secondary bindings. Defaults shown reflect the current client where present.

| Action ID | Display label | Default primary | Default secondary |
|---|---|---|---|
| `forward` | Move forward | `W` | — |
| `back` | Move back | `S` | — |
| `left` | Strafe left | `A` | — |
| `right` | Strafe right | `D` | — |
| `jump` | Jump | `Space` | — |
| `sprint` | Sprint | `Left Shift` | — |
| `crouch` | Crouch/slide | `Left Ctrl` | `C` |
| `lean` | Lean/contextual lean | `Q` | — |
| `fire` | Fire | `Mouse 1` | — |
| `aim` | Aim | `Mouse 2` | — |
| `reload` | Reload | `R` | — |
| `melee` | Melee | `F` | — |
| `grenade` | Lethal grenade | `G` | — |
| `tacticalEquipment` | Tactical equipment | Unbound | — |
| `interact` | Interact / plant / defuse / pickup | `E` | — |
| `weapon1` | Primary weapon | `1` | — |
| `weapon2` | Secondary weapon | `2` | — |
| `weapon3` | Tertiary/special | `3` | — |
| `nextWeapon` | Next weapon | Mouse wheel down | — |
| `previousWeapon` | Previous weapon | Mouse wheel up | — |
| `lastWeapon` | Last weapon | `V` | — |
| `killstreak` | Killstreak/action slot | `B` | — |
| `inspect` | Inspect weapon | `X` | — |
| `scoreboard` | Scoreboard (hold) | `Tab` | — |
| `textChat` | Open text chat | `Enter` | — |
| `teamChat` | Team chat | `Y` | — |
| `tacticalPing` | Tactical ping / ping wheel | Middle mouse | Unbound |
| `muteCurrentTarget` | Mute current spectator/voice target | Unbound | — |
| `spectatePrevious` | Spectate previous | Left arrow | — |
| `spectateNext` | Spectate next | Right arrow | — |
| `pause` | Pause/back | `Escape` (reserved) | — |

Voice push-to-talk is intentionally absent until voice ships with moderation/privacy controls. `Escape` remains reserved and cannot be rebound. Browser/OS reserved shortcuts are rejected. Binding capture supports keyboard and mouse, cancel, timeout, clear, reset action, reset category, and reset all. Conflicts require an explicit `SWAP`, `UNBIND OTHER`, or `CANCEL`; the client never silently removes a binding.

Prompts use the resolved active binding. Required actions (movement, fire, aim, interact, pause) cannot be left with no usable input without a blocking warning and explicit confirmation where safe.

## Graphics and display

| Key | Label | Type/range | Default | Scope | Applies |
|---|---|---|---|---|---|
| `renderScale` | Render scale | 40–100%, step 5% | 100% | DEVICE | Live |
| `shadows` | Shadows | Off/On | On | DEVICE | Live |
| `shadowQuality` | Shadow quality | Off/Low/High | High | DEVICE | Live |
| `postFx` | Post processing | Off/On | On | DEVICE | Live |
| `filmGrain` | Film grain | 0–100%, step 10% | 100% of authored amount | DEVICE | Live |
| `motionBlur` | Motion blur | Off/On | Off | DEVICE | Live |
| `vignette` | Decorative vignette | Off/On | On | DEVICE | Live |
| `maxFps` | Frame cap | Off/60/75/120/144/165/240 | Off | DEVICE | Live |
| `showFps` | Performance readout | Off/On | On in development; Off for public default | DEVICE | Live |
| `brightness` | UI/world brightness calibration | 80–120%, step 1% | 100% | DEVICE | Live |
| `flashIntensity` | Flash effect intensity | 0–100%, step 10% | 100% | ROAM | Live |
| `screenEffectIntensity` | Grain/aberration effect intensity | 0–100%, step 10% | 100% | ROAM | Live |

`shadows = Off` forces effective `shadowQuality = Off` without destroying the saved quality. `postFx = Off` disables grain/motion-blur/composite effects regardless of child values. Brightness calibration cannot reduce objective/team contrast below the accessibility target.

Fullscreen/window mode and monitor selection are browser/OS-owned and are not promised as game settings. A fullscreen action may be exposed only on supported browsers and must report refusal honestly.

## Audio and captions

| Key | Label | Type/range | Default | Scope | Applies |
|---|---|---|---:|---|---|
| `masterVolume` | Master volume | 0–100%, step 1% | 80% | DEVICE | Live |
| `sfxVolume` | Effects volume | 0–100%, step 1% | 100% | DEVICE | Live |
| `musicVolume` | Music volume | 0–100%, step 1% | 45% | DEVICE | Live |
| `uiVolume` | UI volume | 0–100%, step 1% | 80% | DEVICE | Live |
| `announcerVolume` | Announcer/dialogue volume | 0–100%, step 1% | 100% | DEVICE | Live |
| `subtitles` | Subtitles | Off/On | On | ROAM | Live |
| `closedCaptions` | Non-speech captions | Off/On | Off | ROAM | Live |
| `subtitleSize` | Caption text size | Small/Default/Large/Extra large | Default | ROAM | Live |
| `captionBackground` | Caption backing opacity | 40–100%, step 5% | 75% | ROAM | Live |
| `captionDirection` | Direction labels/arrows | Off/On | On | ROAM | Live |

Audio preview requires a user gesture and has a stop action. Captions obey authorized information policy and never expose a sound the player was not entitled to perceive.

## Crosshair and HUD

| Key | Label | Type/range | Default | Scope | Applies |
|---|---|---|---|---|---|
| `crosshairStyle` | Crosshair style | Dynamic/Static/Dot | Dynamic | ROAM | Live |
| `crosshairColor` | Crosshair color | Approved presets + valid custom hex | `#8EF7C4` | ROAM | Live |
| `crosshairOpacity` | Crosshair opacity | 30–100%, step 5% | 100% | ROAM | Live |
| `crosshairSize` | Crosshair size | 50–200%, step 5% | 100% | ROAM | Live |
| `crosshairThickness` | Crosshair thickness | 1–6 CSS px, step 1 | 2 px | ROAM | Live |
| `crosshairGap` | Crosshair center gap | 0–20 CSS px, step 1 | 6 px | ROAM | Live |
| `crosshairOutline` | High-contrast outline | Off/On | On | ROAM | Live |
| `hudScale` | HUD scale | 70–160%, step 5% | 100% | ROAM | Live |
| `hudTextSize` | HUD text size | Small/Default/Large/Extra large | Default | ROAM | Live |
| `showMinimap` | Minimap | Off/On | On | ROAM | Live |
| `minimapRotation` | Minimap orientation | North up/Player up | Player up | ROAM | Live |
| `showDamageNumbers` | Damage numbers | Off/On | On | ROAM | Live |
| `showKillfeed` | Killfeed | Off/On | On | ROAM | Live |
| `showObjectiveMarkers` | Objective markers | Minimal/Full | Full | ROAM | Live |
| `damageVignette` | Damage/critical vignette | Off/Low/Full | Full | ROAM | Live |
| `colorVisionPreset` | UI color preset | Default/Deuteranopia/Protanopia/Tritanopia | Default | ROAM | Live |
| `reduceMotion` | Reduce motion | Off/On | OS preference on first run | ROAM | Live |

Objective markers cannot be disabled completely in objective modes; `Minimal` retains site shape/letter, carrier/plant state, and required interaction information. Disabling minimap does not remove compass/objective alternatives.

## Network diagnostics

Settings contains one diagnostics panel. Displayed values are read-only `SESSION` data from contracted measured sources, never generated for flavor.

| Field | Presentation |
|---|---|
| Platform | Online/degraded/offline plus last successful request age |
| Lobby socket | Connecting/synchronized/stale/reconnecting/closed |
| Match socket | Connecting/live/degraded/reconnecting/ended |
| Region | Contracted region display name/code |
| RTT/ping | Milliseconds, sample age, and short rolling range |
| Jitter | Milliseconds and sample age |
| Packet loss | Percentage over labelled window |
| Correction rate | Corrections per second/minute over labelled window |
| Correction magnitude | Median and recent maximum when supplied |
| Snapshot health | Receive rate, stale age, baseline/resync state |
| Protocol/build | Client version, protocol version, rules version |
| Correlation ID | Most recent relevant ID with copy action, privacy-safe |

Player control:

- `networkDiagnosticsOverlay`: Off/Compact/Full, default Off, `DEVICE`, live.
- `copyDiagnostics`: action, not a setting; redacts tokens, raw IP, secrets, and non-authorized personal data.

## Local practice and legacy fields

These current values remain available only for offline/private practice until a contracted host configuration surface owns them:

| Current key | Range/default | Disposition |
|---|---|---|
| `difficulty` | Recruit/Regular/Hardened/Veteran; Regular | PRACTICE |
| `botCount` | 0–24 accepted; UI 0–15; 7 | PRACTICE; align accepted/UI range during implementation |
| `killLimit` | 1–500 accepted; UI 5–200 step 5; 75 | PRACTICE; server room rules own online value |
| `mode` | TDM; TDM | PRACTICE; server room owns online mode |
| `loadoutPrimary` | Weapon ID; `ar_vector` | Migrate out of settings into loadout domain |
| `loadoutSecondary` | Weapon ID; `pistol_sidewinder` | Migrate out of settings into loadout domain |

The client may request these values for local practice but cannot submit them as proof of an online match configuration.

## Settings UI behavior

Categories: `Input`, `Bindings`, `Graphics`, `Audio & captions`, `Crosshair & HUD`, `Accessibility`, `Network`.

- Search finds label, synonym, and current binding without changing category state.
- Every row shows scope: `Saved to account`, `This device`, `This session`, or `Practice only`.
- Changes apply live where safe. A five-second revert confirmation is required for any future display setting that could make the interface unusable.
- Reset exists per control and category, plus all settings. Reset preview lists affected scopes and does not reset loadouts/profile data.
- Unsaved/unsynced roaming state is visible. Offline changes remain local and follow the versioned profile conflict policy after reconnect.
- Controls expose name, current value, minimum/maximum where applicable, and formatted accessible value text.
- Numeric ranges accept keyboard fine adjustment and a typed-value path where practical.
- Dependencies disable child controls with an explanation, not by hiding them.

## Validation, migration, and privacy

- Bump the current `overstrike.settings.v1` schema for implementation; migrations are explicit and preserve recognized values.
- Validate every key, type, range, enum, binding code/action, and custom color. Unknown/invalid values are discarded per key, not allowed to corrupt the full store.
- Do not use settings storage for auth tokens, account IDs, match truth, room state, stats, inventory, economy, or moderation state.
- Profile sync uses an allowlist; local-only device capability/diagnostic values never roam.
- Telemetry may record setting category, canonical key, direction of change, and friction outcome only as authorized by `telemetry.md`; no raw bindings or custom colors are needed.
- Cross-tab changes are reconciled through a versioned storage event path and announced only when they alter the visible form.

## Current coverage audit

The current client already implements 30 non-binding default keys and 23 default keyboard binding entries in `src/core/settings.js`, with UI for video, audio, gameplay, HUD, and controls. Values are validated on load/set, local storage absence is handled safely, and settings listeners apply many changes live.

Implementation gaps against this inventory:

- No schema migration/version metadata beyond the storage key name.
- No local-versus-roaming model or sync status.
- No secondary binding slots or mouse-button binding capture.
- No UI/announcer audio channels or captions.
- No camera/effect intensity, text-size, color-vision, caption, or reduced-motion setting (only OS CSS media query).
- Crosshair customization lacks opacity, size, thickness, gap, and outline controls.
- HUD lacks killfeed/objective/minimap-orientation settings.
- Diagnostics values and overlay do not exist; scoreboard ping is synthetic.
- Accepted and displayed bot/kill-limit ranges differ.
- Loadout and online match configuration are stored in the settings object but belong to other domains.

## Acceptance checklist

- Every inventory row has a rendered control/field or an explicit unsupported/coming-later status; no silent placeholders.
- Defaults and ranges match `src/core/settings.js` schema and the generated settings UI.
- Keyboard-only and screen-reader users can inspect, change, reset, cancel, and recover from conflicts.
- Every gameplay prompt updates after a rebind.
- Invalid/corrupt local values and unsupported old versions recover per key without a fatal boot.
- Local, roaming, session, and practice scopes never overwrite one another.
- Online rules/loadout truth is not read from local settings.
- Diagnostics are measured, freshness-labelled, and privacy-redacted.
- Reduced-motion/intensity and caption changes apply live.
- Automated fixtures cover default, changed, invalid, offline-unsynced, sync-conflict, and reset states.

## Contract dependencies

- `http-api.md` / profile schema: roaming read/write, version/conflict semantics.
- `auth.md`: session context for profile sync, cross-tab revocation behavior.
- `net-facade.md`: measured RTT, jitter, loss, correction, snapshot, and protocol health.
- `telemetry.md`: settings-friction event allowlist/privacy.
- `feature-flags.md`: staged settings/shell/diagnostics rollout.
- D5 fixes the supported browser/device/input matrix; the public default for the performance
  readout still needs a human product decision.
