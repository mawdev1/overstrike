# OVERSTRIKE — Architecture Contract

**This document is binding.** Every module must conform exactly. Do not change signatures
listed here without approval. If a signature seems wrong, implement it as specified and
note the concern in your report.

Stack: vanilla ES modules + three.js 0.185 + Vite. No frameworks. No external assets —
**all art, audio and textures are generated procedurally at runtime.**

---

## 1. Conventions

- **Units:** 1 unit = 1 metre. Y is up. Default forward is `-Z`.
- **Angles:** radians. `yaw` rotates about +Y (0 = facing -Z, increasing = turning left).
  `pitch` about the local X axis, clamped to ±1.5533 (89°). Positive pitch = looking up.
- **Direction from yaw/pitch:**
  `dir = (-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch))`
- **Player metrics:** radius `0.36`, stand height `1.8`, crouch height `1.1`,
  eye offset from feet: stand `1.62`, crouch `0.95`. Feet position is the entity origin.
- **Gravity:** `-22` u/s² (game-feel, not realistic). Terminal fall `-60`.
- **Time:** simulation runs at a **fixed 1/120 s** step with an accumulator; max 6 substeps
  per frame. Rendering is once per rAF frame. `dt` passed to `fixedUpdate` is ALWAYS
  `1/120`. Visual-only systems get real frame delta in `update(dtFrame)`.
- **Naming:** camelCase for functions/vars, PascalCase for classes, SCREAMING_SNAKE for
  constant tables. Files are camelCase.
- **No `THREE` global.** Always `import * as THREE from 'three'`.
- **Never** call `new THREE.Vector3()` inside a per-frame hot loop. Use module-scope scratch
  vectors (`const _v1 = new THREE.Vector3()`).

---

## 2. The `game` object

A single mutable object created by `src/core/game.js` and passed to every system's
constructor and update. Systems must not import each other directly for runtime access —
reach through `game`. (Importing types/constants/pure helpers is fine.)

```js
game = {
  // core
  renderer, scene, camera,        // THREE.WebGLRenderer / Scene / PerspectiveCamera
  engine,                         // Engine instance (src/core/engine.js)
  input,                          // Input instance
  settings,                       // Settings instance
  bus,                            // EventBus instance
  rng,                            // seeded RNG: rng() -> [0,1), rng.range(a,b), rng.int(n), rng.pick(arr)

  // world
  world,                          // World instance (level + collision)  src/world/world.js
  nav,                            // NavGrid instance                    src/world/navGrid.js

  // actors
  player,                         // Player instance                     src/player/player.js
  bots,                           // BotManager instance                 src/ai/botManager.js

  // subsystems
  weapons,                        // WeaponSystem instance               src/weapons/weaponSystem.js
  projectiles,                    // ProjectileSystem (grenades etc.)    src/weapons/projectiles.js
  fx,                             // FX facade                           src/fx/fx.js
  audio,                          // AudioEngine                         src/audio/audio.js
  hud,                            // HUD                                 src/ui/hud.js
  menu,                           // Menu                                src/ui/menu.js
  match,                          // Match (mode rules/score)            src/game/match.js

  // runtime state
  time: 0,          // seconds since match start, advances only while playing
  frame: 0,         // frame counter
  paused: false,
  state: 'menu',    // 'menu' | 'playing' | 'paused' | 'gameover'
  debug: false,
}
```

### System lifecycle
Every system class implements as many of these as it needs (all optional except `constructor`):

```js
class Foo {
  constructor(game) {}
  async init() {}                 // async setup (build meshes, decode audio, etc.)
  reset() {}                      // called on match (re)start — return to clean state
  fixedUpdate(dt) {}              // dt === 1/120, simulation only
  update(dtFrame) {}              // visual/interp only, real frame delta (clamped to 0.1)
  dispose() {}
}
```

---

## 3. Event bus

`game.bus` — `on(name, fn) -> unsubscribe`, `off(name, fn)`, `emit(name, payload)`.
Payloads are plain objects. **Canonical events (do not invent variants):**

| event | payload |
|---|---|
| `damage` | `{ target, attacker, amount, hitPart, point, normal, weaponId, headshot }` |
| `kill` | `{ victim, attacker, weaponId, headshot, distance }` |
| `shot` | `{ shooter, weaponId, origin, dir, isPlayer }` |
| `hit` | `{ shooter, target, point, normal, headshot, surface }`  — for hitmarkers |
| `impact` | `{ point, normal, surface, weaponId }` — surface hit, no entity |
| `reloadStart` / `reloadEnd` | `{ shooter, weaponId }` |
| `weaponSwitch` | `{ shooter, weaponId }` |
| `explosion` | `{ point, radius, damage, attacker, weaponId }` |
| `spawn` | `{ entity }` |
| `playerDamaged` | `{ amount, dirWorld }` — for the directional damage indicator |
| `matchStart` | `{ mode:'tdm', killLimit, scores }` |
| `roundEnd` / `matchEnd` | final immutable result, in that order; `matchEnd` opens After Action |
| `killstreak` | `{ entity, count }` |
| `notice` | `{ text, sub, duration }` — big centre-screen text |

`hitPart` ∈ `'head' | 'torso' | 'limb'`.
`surface` ∈ `'concrete' | 'metal' | 'wood' | 'dirt' | 'glass' | 'flesh' | 'sand'`.

---

## 4. Entity contract

Player and Bots are both **entities** and must expose this identical shape so weapons,
damage, AI and HUD treat them uniformly:

```js
entity = {
  id: number,             // unique
  isPlayer: boolean,
  team: 0 | 1,
  alive: boolean,
  name: string,

  position: THREE.Vector3,   // FEET position
  velocity: THREE.Vector3,
  yaw: number, pitch: number,
  height: number,            // current collision height (1.8 stand / 1.1 crouch, lerped)
  radius: 0.36,
  eyeHeight: number,         // current eye offset from feet

  health: number, maxHealth: number,
  armor: number,

  // combat
  applyDamage(amount, info),   // info: { attacker, hitPart, point, normal, weaponId }
  die(info),
  getEyePosition(out),         // THREE.Vector3 -> out, returns out
  getAimDirection(out),        // normalized, returns out

  // hitboxes — array, tested in order by ballistics
  hitboxes: [ { part:'head'|'torso'|'limb', offset:THREE.Vector3, size:THREE.Vector3 } ],
  // offset is relative to FEET position, size is full extents (an OBB rotated by yaw)

  weapon,                      // current WeaponInstance or null
  stats: { kills, deaths, score, streak },
}
```

Damage multipliers: head `×4.2`, torso `×1.0`, limb `×0.82`. Applied by `ballistics`,
not by the entity.

---

## 5. World / collision API — `src/world/world.js`

```js
class World {
  // Static geometry is a list of AABBs plus a THREE.Group of visual meshes.
  boxes: Array<{ min:Vec3, max:Vec3, surface:string }>   // broadphase-indexed internally

  addBox(min, max, surface)                 // register collider
  build()                                   // finalize spatial hash — call after all addBox

  // Swept capsule-ish (AABB-approximated) move-and-slide.
  // Mutates nothing; returns a result object (pooled — copy what you keep).
  move(position, velocity, radius, height, dt) -> {
    position: Vec3,      // new feet position
    velocity: Vec3,      // post-slide velocity
    grounded: boolean,
    groundNormal: Vec3,
    hitWall: boolean,
    wallNormal: Vec3,    // for wall-slide / slide-jump feel
    steppedUp: boolean,
  }

  // Ray vs static world.
  raycast(origin, dir, maxDist) -> null | { point:Vec3, normal:Vec3, distance, surface }

  // Line-of-sight helper (static geometry only), used heavily by AI — must be fast.
  losClear(fromVec3, toVec3) -> boolean

  // Spawn data, produced by the level
  spawnPoints: Array<{ position:Vec3, yaw:number, team:0|1|-1 }>   // -1 = any
  bounds: { min:Vec3, max:Vec3 }
}
```

`move()` performs: gravity is applied by the CALLER before calling. World does
axis-separated sweep + slide, with step-up of ≤ `0.55` when grounded.

---

## 6. Ballistics API — `src/weapons/ballistics.js`

```js
// Single hitscan shot against world + all entities. Handles falloff, headshots,
// penetration (max 1 thin surface), emits 'hit'/'impact'/'damage', spawns fx + decals.
fireHitscan(game, {
  shooter, weaponId, origin, dir, damage, range,
  falloffStart, falloffEnd, falloffMin,   // damage multiplier lerps 1 -> falloffMin
  penetration,                            // 0..1, 0 = none
  tracer: boolean,
}) -> { hitEntity, point, distance, headshot }

// Ray vs one entity's OBB hitboxes.
raycastEntity(entity, origin, dir, maxDist) -> null | { distance, part, point, normal }

// Ray vs all live entities except `exclude`.
raycastEntities(game, origin, dir, maxDist, exclude) -> null | { entity, distance, part, point, normal }
```

---

## 7. Weapons — `src/weapons/weaponDefs.js`

Every weapon is a plain data object. **Required fields** (add more freely, never remove):

```js
{
  id:'ar_vector', name:'VK-7 VECTOR', class:'ar'|'smg'|'sniper'|'shotgun'|'lmg'|'pistol'|'launcher',
  damage: 32, rpm: 720, magSize: 30, reserve: 210,
  fireMode: 'auto'|'semi'|'burst', burstCount: 3, burstDelay: 0.09,
  pellets: 1,                          // >1 for shotguns
  spreadHip: 2.4, spreadAds: 0.35,     // degrees, cone half-angle
  spreadMoveMul: 1.9, spreadAirMul: 2.6, spreadCrouchMul: 0.75,
  recoil: { up: 0.55, side: 0.22, kick: 0.06, recovery: 7.5, pattern: [[x,y],...] | null },
  adsTime: 0.22, adsFov: 52, adsSpeedMul: 0.62,
  reloadTime: 2.1, reloadEmptyTime: 2.65, switchTime: 0.55,
  range: 120, falloffStart: 28, falloffEnd: 70, falloffMin: 0.55,
  penetration: 0.4,
  headshotMul: 4.2,                    // overrides the global if present
  moveSpeedMul: 0.95,
  viewmodel: { ...shape params consumed by viewmodel.js },
  audio: { fire:'rifle', reload:'mech', tail:'indoor' },
  unlockLevel: 1,
}
```

Export `WEAPONS` (object keyed by id) and `WEAPON_LIST` (array).

`WeaponInstance` (from `weaponSystem.js`) exposes:
`{ def, ammo, reserve, state ('idle'|'firing'|'reloading'|'switching'), adsAmount (0..1),
  tryFire(), stopFire(), reload(), fixedUpdate(dt), canFire() }`

---

## 8. FX facade — `src/fx/fx.js`

All effects are **pooled**. No allocation after `init()`. Never exceed the caps.

```js
class FX {
  muzzleFlash(position, dir, scale)
  tracer(from, to, speed, width, color)
  impact(point, normal, surface)        // sparks/dust/debris chosen by surface
  bloodSpray(point, normal, amount)
  decal(point, normal, surface, size)   // pooled, cap 256, oldest recycled
  explosion(point, radius)
  smokeTrail(from, to)
  shellEject(position, dir, kind)
  screenShake(amount, duration)         // routes to game.player.camera
  update(dtFrame)
}
```

---

## 9. Audio — `src/audio/audio.js`

100% procedural WebAudio (no files). Must not start until first user gesture.

```js
class AudioEngine {
  async init()
  resume()                                    // call on first click/keypress
  play(name, { position, volume, rate, delay }) -> voice   // position => 3D panned
  playUI(name, { volume, rate })
  setListener(position, forward, up)
  stopAll()
  setVolume(master, sfx, music)
}
```
Required sound names: `rifle`, `smg`, `sniper`, `shotgun`, `pistol`, `lmg`, `dryfire`,
`magOut`, `magIn`, `boltBack`, `boltForward`, `switch`, `impactConcrete`, `impactMetal`,
`impactDirt`, `impactWood`, `impactGlass`, `fleshHit`, `headshot`, `hitmarker`,
`explosion`, `grenadeBounce`, `pinPull`, `footstepConcrete`, `footstepDirt`, `land`,
`jump`, `hurt`, `death`, `killConfirm`, `uiClick`, `uiHover`, `uiBack`, `matchStart`,
`matchEnd`, `whizby`, `reloadTail`, `lowAmmo`, `streakReady`.

---

## 10. HUD — `src/ui/hud.js`

DOM overlay (not canvas) for crispness, except the minimap which is a `<canvas>`.
Root element id `#hud`. All HUD elements live under it. Must implement:
`setAmmo`, `setHealth`, `setWeapon`, `hitmarker(headshot)`, `killfeed(entry)`,
`damageIndicator(dirWorld)`, `notice(text, sub, dur)`, `setCrosshairSpread(px)`,
`setScore(a,b)`, `setTimer(seconds)`, `minimap` (drawn each frame), `lowHealthVignette(t)`.

---

## 11. Performance budget

- Target **120 fps** on an integrated GPU at 1080p; never dip below 60.
- Draw calls < 220. Triangles < 450k. Use `InstancedMesh` for repeated props.
- Zero per-frame allocations in `fixedUpdate` / `update` hot paths (scratch vectors).
- All materials shared/cached in `src/core/assets.js`. Never create a material per object.
- Shadow map: single directional cascade, 2048², tightly fitted to the play space.

---

## 12. File ownership

Do not edit files you do not own. If you need a change in another file, report it.

| Owner | Files |
|---|---|
| CORE (lead) | `index.html`, `vite.config.js`, `src/main.js`, `src/core/*` |
| WORLD | `src/world/world.js`, `src/world/level.js`, `src/world/props.js` |
| NAV+AI | `src/world/navGrid.js`, `src/ai/*` |
| MOVEMENT | `src/player/player.js`, `src/player/playerCamera.js` |
| WEAPONS | `src/weapons/*` |
| FX | `src/fx/*` |
| AUDIO | `src/audio/*` |
| UI | `src/ui/*`, `src/styles.css` |
| GAMEPLAY | `src/game/*` |
