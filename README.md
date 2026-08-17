# OVERSTRIKE

A browser-native first-person shooter. No plugins, no downloads, no binary assets — every
texture, weapon model, sound effect and piece of music is generated procedurally at runtime.

Built on vanilla ES modules + [three.js](https://threejs.org) + Vite.

## Running it

```bash
npm install
npm run dev      # http://127.0.0.1:5180
```

Click to lock the mouse. `Esc` pauses.

```bash
npm run build    # production bundle into dist/
npm run preview  # serve the production bundle
npm run check    # static pass: every module parses, every import resolves
npm run smoke    # boots the real game headless, plays it, asserts it works
```

## Verification

There is no unit-test suite. Instead the game is verified by booting the **real build** in
headless Chromium and playing it, because almost every bug worth catching here lives in
the interaction between systems rather than inside one function. Each script drives
`window.__GAME__` directly and reports measured numbers.

| script | what it proves |
|---|---|
| `npm run check` | every module parses as ESM; every import resolves; no stray bare imports |
| `npm run smoke` | boots, starts a match, drives synthetic input, asserts the player moves, guns fire and bots navigate; writes screenshots to `shots/` |
| `node scripts/combat.mjs` | 18 end-to-end assertions: aim → hitscan → damage → kill → score → killfeed → respawn, friendly fire blocked, bots fire and hurt the player, recoil climbs, sim cost |
| `node scripts/aggression.mjs` | bot engagement per difficulty — shots, distinct shooters, hits, damage/s, time-to-first-shot |
| `node scripts/beauty.mjs` | six auto-chosen open viewpoints, same every run, so lighting and art changes are comparable |
| `node scripts/auditK.mjs` | regression guard for every defect the independent audit found, each with a control case |
| `node scripts/auditA…L.mjs` | memory growth, all five modes, numerical edge cases, fixed-timestep behaviour, contract conformance, error paths, per-step cost |
| `node scripts/diag*.mjs` | focused subsystem probes (collision, ballistics, bot aim) |

Headless Chromium rasterises through SwiftShader, so **the frame rate these report is
meaningless**. The numbers that matter are CPU simulation cost per fixed step, draw
calls, triangles and heap growth — all of which the scripts print.

## Controls

| Action | Default |
|---|---|
| Move | `W` `A` `S` `D` |
| Sprint | `Shift` |
| Crouch / Slide | `Ctrl` or `C` (sprint + crouch = slide) |
| Jump / Mantle | `Space` |
| Lean | `Q` |
| Fire | Left mouse |
| Aim down sights | Right mouse |
| Reload | `R` |
| Melee | `F` |
| Grenade | `G` |
| Swap weapon | `1` `2` `3` / `V` for last |
| Killstreak | `B` |
| Inspect weapon | `X` |
| Scoreboard | `Tab` |
| Pause | `Esc` |

All bindings are remappable in **Settings → Controls**.

## What's in it

- **Movement** — acceleration/friction ground model with air control, coyote time, jump
  buffering, sprint ramp with a sprint-out delay, smooth crouch, a momentum slide that
  can be cancelled into a jump, ledge mantling, and peek-leaning.
- **Gunplay** — 10 weapons across six classes, each with a hand-authored learnable recoil
  pattern, hip/ADS spread with per-shot bloom, damage falloff, single-surface penetration,
  and headshot multipliers. Shots originate from the eye; tracers originate from the muzzle.
- **Bots** — vision cones, hearing, target memory and last-known-position pushes, cover
  selection off a baked nav grid, flanking, suppression, grenades, and a human-like aim
  model with reaction delay and converging error. Four difficulty tiers.
- **Map** — "Meridian", a three-lane Mediterranean compound with interiors, rooftops,
  balconies and deliberate cover placement.
- **Modes** — Team Deathmatch, Free-for-All, Gun Game, Domination, Kill Confirmed.
- **Killstreaks** — UAV, Airstrike, Sentry Gun, Chopper Gunner.
- **Progression** — persistent XP, 55 levels, weapon unlocks, lifetime stats and challenges.
- **Presentation** — ACES tonemapping, bloom, film grain, chromatic aberration, dynamic
  crosshair, directional damage indicators, killfeed, radar minimap, and a fully
  synthesised audio stack with convolution reverb, distance filtering and wall occlusion.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) — it is the binding contract between subsystems.
The short version: a single `game` object is passed everywhere, systems talk through an
event bus rather than direct references, simulation runs at a fixed 1/120 s step with an
accumulator, and rendering happens once per animation frame.

```
src/
  core/     engine, game loop, input, settings, events, seeded RNG, procedural assets
  world/    collision + spatial hash, the level, props, nav grid
  player/   movement controller, camera feel
  ai/       bots, bot manager, procedural soldier model
  weapons/  definitions, weapon state machine, ballistics, viewmodels, projectiles
  fx/       pooled particles, decals, tracers
  audio/    Web Audio synthesis, mixing, music
  ui/       HUD, menus, scoreboard, killfeed, minimap
  game/     match rules, modes, spawning, killstreaks, progression
```

## Requirements

WebGL 2 and a desktop-class GPU. Chrome, Edge, Firefox and Safari 16+ are supported.
