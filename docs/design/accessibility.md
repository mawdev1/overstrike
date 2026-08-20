# Accessibility specification

**Owner:** Codex (`[CX]`)  
**Phase:** P0  
**Version:** 0.2
**Status:** Supported-device matrix accepted; ready for product/accessibility review
**Last updated:** 2026-08-19

## Standard and scope

Target WCAG 2.2 AA for the out-of-match shell, account flows, settings, lobbies, results, and all conventional web controls. Real-time first-person combat has modality constraints, but essential objective, team, connection, damage, and interaction information must still be available without relying on one color, sound, or animation.

Alpha is desktop keyboard/mouse on the D5 browser matrix. Controller, touch gameplay,
console, and screen-reader operation of live 3D combat are not claimed until implemented and
tested. Unsupported input/device combinations receive a clear compatibility message rather
than a broken flow.

## Non-negotiable principles

- Never use color alone for team, objective, ready, validation, connection, rarity, danger, or result status.
- Never use audio alone for an objective transition, error, or required action.
- Never require animation/motion to understand a transition.
- Never replace native semantic controls with generic clickable elements.
- Never trap a keyboard user in pointer lock, a modal, a tab set, or a rebinding capture.
- Never announce high-frequency combat telemetry through a live region.
- Accessibility settings are reachable before sign-in and before the game engine loads.
- The saved reduced-motion preference is applied before first paint to avoid a motion flash.

## Visual requirements

### Contrast

| Content | Minimum target |
|---|---:|
| Normal text under 24 CSS px (or under ~18.5 px bold) | 4.5:1 |
| Large text | 3:1 |
| Essential icons, focus rings, input borders, graph lines, progress indicators | 3:1 against adjacent color |
| Disabled/decorative content | Exempt, but must not resemble enabled essential content |

Dynamic HUD text receives a backing plate, shadow/outline, or adaptive treatment proven against the brightest and darkest approved world frames. Contrast is measured from screenshots, not inferred from palette values.

### Text and scale

- Essential HUD labels/numbers: minimum 16 CSS px at 100% HUD scale on the minimum supported viewport.
- Secondary HUD labels: minimum 14 CSS px.
- Shell body/form text: minimum 16 CSS px; helper text minimum 14 CSS px.
- Line height: at least 1.4 for body/form copy and 1.2 for short HUD labels.
- No essential text is baked into procedural textures; DOM text remains selectable/semantic where applicable.
- Shell remains operable at 200% browser zoom and 320 CSS px effective width through reflow/scroll, even if match entry is unsupported at that width.
- HUD scale supports 70–160%. Essential content remains on-screen; decoration collapses first.
- Text size has `Small`, `Default`, `Large`, and `Extra large` presets; this is separate from HUD scale.

### Team and objective encoding

| Concept | Color-independent token |
|---|---|
| Alpha | Upward chevron + `ALPHA` |
| Bravo | Split horizontal bar + `BRAVO` |
| Site A | Solid triangle + `A` + spoken/text “Site A” |
| Site B | Double-bar square + `B` + spoken/text “Site B” |
| Ready | Check icon + `READY`; not ready uses hollow circle + `NOT READY` |
| Connected | Link/check icon + state word |
| Degraded/reconnecting | Broken/pulsed link shape + state word/time |
| Win/loss/draw | Trophy/downward result marker/equal sign + complete word |

The icon and wording remain stable across world marker, lobby, scoreboard, HUD, results, and captions. Team colors never swap when attacking/defending sides switch.

Color-vision presets may adjust approved UI hues, but shape/text remains the primary guarantee. Test deuteranopia, protanopia, tritanopia, low saturation, and grayscale; do not claim medical correction.

### Focus

- Focus ring is at least 2 CSS px with a 1 CSS px separation/offset and 3:1 contrast across each component background.
- `:focus-visible` distinguishes keyboard focus; global `outline: none` is acceptable only when a stronger replacement is guaranteed.
- Hover, selected, active, disabled, and focus states are distinguishable from each other.

## Keyboard and input

### Shell

- Logical DOM order matches visual/reading order.
- Tab/Shift+Tab reaches every interactive element once. Arrow keys are reserved for composite controls that follow an announced pattern.
- Enter/Space activates buttons; links use Enter; Escape closes the top dismissible layer or follows a clearly documented game pause/back action.
- Route changes focus the new `h1`; submit failures focus a linked error summary; closing a dialog/drawer restores focus to the opener.
- Modal dialogs trap focus, label title/body, and offer an explicit cancel except for true terminal states.
- Session timeout/revocation and connection changes do not steal focus unless continued interaction would be unsafe.

### Gameplay and rebinding

- All gameplay keyboard actions in `settings-inventory.md` are rebindable, including movement, combat, interaction, scoreboard, chat/ping, weapon selection, and spectating.
- Fire/aim bindings support mouse-button reassignment within browser capability.
- Rebinding capture always offers cancel and timeout; reserved browser/OS shortcuts are refused with an explanation.
- Conflicts are shown before applying. The default policy swaps or unbinds only after explicit confirmation.
- Prompts resolve the current binding, never hard-code `E`, `R`, or `TAB`.
- Pointer lock is requested only from a user gesture. Refusal returns the player to an operable UI with an explanation.
- Losing focus clears held input and presents the correct pause/reconnect behavior; it never leaves an action stuck.
- Toggle options exist for aim and crouch. Auto-sprint is available; hold remains the default where specified.

## Motion, flashing, and camera comfort

### Reduced motion

`Reduce motion` disables or replaces:

- Menu background loops, parallax, panel slides, zoom punches, and looping pulses.
- Non-essential scoreboard/result counting animation.
- Decorative weapon/menu camera drift.
- Large round-transition motion; use a short opacity transition.
- View bob and weapon sway according to their independent intensity settings.

Informational combat feedback such as hitmarkers or damage direction may remain but must use the least motion needed and respect separate intensity settings.

### Independent intensity controls

- Camera shake: 0–100%, default 100% pending playtest; reduced-motion preset sets 25%.
- View bob: 0–100%, default 60%; reduced-motion preset sets 0%.
- Weapon sway: 0–100%, default 100%; reduced-motion preset sets 35%.
- Damage vignette: Off/Low/Full, default Full; critical health retains a text/icon alternative.
- Flash effect intensity: 0–100%, default 100%; 0% uses a high-contrast status veil without a full-white flash.
- Screen effect intensity (chromatic aberration/grain): 0–100%, default controlled by graphics settings.

No effect flashes more than three times per second across a one-second interval. Brightness transitions are evaluated in objective/killstreak/connection states. Where a gameplay effect needs a stricter safety review, the safer effect is the default.

## Audio, captions, and subtitles

### Audio controls

Independent master, effects, music, UI, and dialogue/announcer sliders with mute at 0%. Voice-chat controls remain absent until voice ships with moderation/privacy support.

### Subtitle/caption model

- `Subtitles`: Off/On, default On for first-run recommendation.
- `Closed captions`: Off/On, default Off; adds meaningful non-speech game cues.
- Speaker/effect label, direction arrow/word, and distance category (`NEAR`, `MID`, `FAR`) are available only when that information is already legitimately audible to the player.
- Maximum two simultaneous caption rows, newest below; critical objective cue supersedes ambient cues.
- Caption background opacity 40–100%, default 75%; text size follows subtitle-size setting.
- Captions identify `[BOMB DROPPED]`, `[BOMB PLANTED]`, `[DEFUSING]`, round outcome, teammate ping, and relevant connection warnings subject to information policy.
- Spatial audio cue captions never expose an occluded/hidden event beyond the audio system’s authorized perception.

Menus provide non-audio confirmation for volume previews and do not auto-play audio before a user gesture.

## Cognitive clarity and timing

- One primary action per onboarding screen; secondary actions remain predictable.
- Error copy states what happened, whether anything was saved, and the next valid action.
- Server error `code`, not message text, selects the presentation. Raw debug details are hidden behind copy diagnostics.
- Countdown, reservation expiry, reconnect grace, rate limit, and maintenance times come from the authoritative contract. Player-controlled actions can be cancelled where policy allows.
- No important notification disappears before it can be read. Toasts remain at least 5 seconds or until replaced and are duplicated in a notification/history surface when consequential.
- Forms retain non-secret valid data after failure and summarize all errors at once.
- Destructive or value-affecting actions require explicit, specific confirmation; generic “Are you sure?” is insufficient.

## Screen-reader and semantic scope

The entire out-of-match shell is screen-reader operable:

- Semantic landmarks, heading hierarchy, labelled forms, descriptions, error associations, tables with headers, and status regions.
- Room roster and scoreboard provide accessible table/list equivalents.
- Sort direction, filtering, ready state, team, host, connection, and eligibility have accessible names.
- Route and submit outcomes use restrained polite/assertive live regions.
- Canvas/3D content has a concise accessible name and an alternative description of current match mode/objective, but live combat is not claimed screen-reader playable in Alpha.
- `#hud` cannot remain globally `aria-hidden="true"` once it contains essential menu/spectator/status content; P3 must choose selective hidden nodes and restrained summaries.

High-frequency ammo, health, aim, movement, hit, and killfeed changes are not continuously announced. Players may request an on-demand status summary through a bindable action if product approves it.

## Network and failure accessibility

- Connectivity state always includes text: `CONNECTED`, `DEGRADED`, `RECONNECTING 2/5`, `OFFLINE`, or a contracted equivalent.
- Reconnect status includes actual remaining grace time when supplied, cancel behavior, and final outcome.
- Loading skeletons do not pulse under reduced motion.
- Offline/stale content is marked in text and mutation controls are disabled with reasons.
- Unsupported browser/device checks list the failed capability and supported alternatives; they do not simply say “something went wrong.”

## Current-state audit

Strengths already present:

- Native buttons/inputs in the current menu.
- Visible `:focus-visible` treatments.
- ARIA pressed/selected/value text on several custom settings controls.
- An alert dialog and polite live region.
- Width/height responsive rules and a reduced-motion media query.
- Validated, remappable keyboard action map.

Gaps to close:

- `index.html` marks the entire HUD `aria-hidden="true"`.
- No semantic app-shell landmarks or route-level focus management.
- No captions/subtitles, color-vision presets, text-size setting, effect-intensity settings, or complete audio channels.
- Mouse combat actions are not part of the rebinding map.
- No documented contrast measurements against dynamic world frames.
- No tested 200% zoom/reflow acceptance.
- Current scoreboard displays deterministic synthetic ping; accessibility requires measured, labelled status rather than plausible fiction.
- Reduced motion intentionally leaves several combat effects intact but currently has no independent intensity controls.

## Verification matrix

The D5 minimum matrix is Chrome/Edge latest two major versions, Firefox latest two major
versions, and Safari 17+ on Windows 10+, macOS 13+, and Linux where the selected browser is
available. Match entry requires WebGL2, pointer lock, binary WebSocket frames, dual-core CPU,
8 GB RAM, and approximately 2 GB VRAM. Mobile and tablets are unsupported. Keyboard-only and
mouse/pointer-lock paths are tested on every supported browser; screen-reader combinations
cover the semantic shell rather than claiming live-combat operation.

Automated checks:

- Static semantic/accessibility scan for every shell fixture state.
- Keyboard traversal and focus assertions.
- Contrast sampling from representative shell and HUD screenshots.
- 200% zoom, 1280 x 720, short viewport, and ultrawide screenshot checks.
- Reduced-motion assertion before first animated paint.
- Grayscale and three color-vision simulation snapshots.
- Caption overflow, simultaneous cue priority, and no-information-leak fixtures.

Human checks:

- Keyboard-only first-run through return-to-lobby.
- Screen reader completion of sign-in, browser, lobby, settings, and results.
- Low-vision zoom/text/HUD scale review.
- Motion/flash review with all reductions enabled and disabled.
- Color-independent recognition of teams, sites, ready, connection, and outcomes.

## Acceptance checklist

- Shell meets WCAG 2.2 AA checks with documented exceptions, owner, and remediation date.
- Every essential state is represented by at least two of color, text, shape, pattern, or sound—with text/shape required for silent use.
- Complete first-run is keyboard operable and survives 200% zoom.
- All gameplay prompts use current bindings; rebinding has no keyboard trap.
- Reduced motion and intensity settings take effect without restarting the app.
- Objective captions do not leak hidden information.
- Contrast evidence exists for the brightest/darkest approved map views.
- Supported/unsupported device behavior matches the human-approved matrix.

## Open approvals

- Human product/accessibility owner: live-combat accessibility claim and any WCAG exceptions.
- Human art owner: final team/objective palette after shape-independent testing.
- Backend: authorized spectator/objective information and error/timing fields.
