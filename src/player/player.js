import * as THREE from 'three';
import { clamp, lerp, damp, dirFromAngles, PITCH_LIMIT, DEG } from '../core/mathUtils.js';
import { PlayerCamera, CAMERA_TUNE } from './playerCamera.js';
import { defineSnapshot } from '../core/snapshot.js';

/* ════════════════════════════════════════════════════════════════════════════
   TUNING TABLE — every number that shapes movement feel lives here.
   Units: metres, seconds, u/s, u/s². Tweak in review; nothing else is magic.
   ────────────────────────────────────────────────────────────────────────────
   GROUND
     WALK_SPEED        4.60   base ground speed
     SPRINT_SPEED      7.20   top sprint speed (reached after SPRINT_RAMP)
     CROUCH_SPEED      2.50   fully-crouched speed
     BACK_MUL          0.87   speed scale when the wish dir is backwards
     STRAFE_MUL        0.94   speed scale for pure lateral movement
     GROUND_ACCEL     65.0    u/s² at WALK speed, scaled by (wishSpeed/4.6).
                              It has to scale: friction runs every step, so a
                              fixed acceleration would pin ground speed at
                              accel/friction (5.4 u/s) and sprint could never
                              reach 7.2. Scaling also makes time-to-top-speed
                              identical in every stance — measured 0.133 s to
                              95 %, and the last 0.5 u/s snaps instantly.
     GROUND_FRICTION  12.0    1/s Quake-style friction
     STOP_SPEED        1.35   friction floor: below this you decelerate at a
                              constant 16 u/s², so a full stop takes 0.17 s —
                              crisp, but not a hard snap to zero

   AIR (Quake/CPMA derived — expressive but strictly bounded)
     AIR_ACCEL         2.60   coefficient, multiplied by wishSpeed →
                              ~12 u/s² effective at walk speed
     AIR_STRAFE_ACCEL 44.0    u/s² applied only when the wish dir is PURE lateral
     AIR_STRAFE_WISH   0.95   wishSpeed cap for the above — this is the
                              "strafe-jump-friendly projection": you can convert
                              turn into speed, but only ~1 u/s worth per air step
     AIR_MAX_SPEED    11.0    hard horizontal ceiling while airborne
     LAND_SPEED_CAP    8.60   horizontal speed is clamped to this the instant you
                              touch ground → bunny-hopping cannot compound.
                              Verified: 40 consecutive perfect strafe-jumps peak
                              at 10.1 u/s in the air and 8.60 on the ground, i.e.
                              a 19 % reward over sprinting and a hard ceiling.
                              Same value as SLIDE_JUMP_MAX, on purpose.

   JUMP
     JUMP_SPEED        7.10   instant impulse (apex 1.15 m, 0.65 s hang)
     COYOTE_TIME       0.110  jump still allowed this long after leaving ground
     JUMP_BUFFER       0.140  jump pressed this long before landing still fires

   SPRINT
     SPRINT_RAMP       0.220  s to ramp the speed target walk → sprint
     SPRINT_OUT_DELAY  0.180  s after sprint ends before you may fire (CoD feel)

   CROUCH
     STAND_HEIGHT      1.80 / CROUCH_HEIGHT 1.10
     STAND_EYE         1.62 / CROUCH_EYE    0.95
     CROUCH_TIME       0.140  s for the full 0.70 m height transition
     Ceiling probed with 5 upward rays before standing.

   SLIDE (signature move)
     SLIDE_SPEED       9.50   entry burst
     SLIDE_TIME        0.900  max duration
     SLIDE_FRICTION    1.55   1/s exponential decay of slide speed
     SLIDE_END_SPEED   3.20   drops out of the slide below this
     SLIDE_TURN_RATE   1.55   rad/s of steering authority (reduced on purpose)
     SLIDE_COOLDOWN    1.100  s after the slide ends before another may start
     SLIDE_JUMP_KEEP   0.88   fraction of slide speed carried into a slide-jump
     SLIDE_JUMP_MAX    8.60   and its hard cap

   MANTLE / VAULT
     MANTLE_MIN_H      0.55 / MANTLE_MAX_H 1.35   ledge height window, measured
                              from the FEET — so a jump lets you pull over a
                              1.5–2.0 m ledge, but never a featureless wall
     MANTLE_TIME       0.350  scripted motion length
     MANTLE_COOLDOWN   0.300  s — plus one mantle per airborne period, so this
                              can never become a wall-climb
     MANTLE_EXIT_SPEED 2.20   forward speed handed back on completion

   LEAN
     LEAN_DIST         0.320  m of peek
     LEAN_RATE        11.0    1/s approach
     (roll of 7° lives in playerCamera)

   GRAVITY / FALLING
     GRAVITY         -22.0    per the architecture contract
     TERMINAL        -60.0
     FALL_SAFE         6.00   m — no damage at or below
     FALL_LETHAL      16.00   m — 100 damage at or above
     FALL_CURVE        1.28   exponent between the two

   FOOTSTEPS
     STEP_DISTANCE     2.05   m of travel per step (→ speed-dependent interval)
     STEP_DISTANCE_CROUCH 2.60
     Loudness broadcast on the `noise` bus event: sprint 1.0, walk 0.55,
     crouch 0 (silent — no event emitted at all).

   HEALTH
     MAX_HEALTH      100
     REGEN_DELAY       4.20   s without taking damage
     REGEN_RATE       28.0    hp/s
     ARMOR_ABSORB      0.65   fraction of incoming damage eaten by armour

   MELEE
     MELEE_COOLDOWN    0.75 s, blocks firing for 0.55 s.
     Reach, arc and damage live on `WEAPONS.melee_knife` in weaponDefs and are
     applied by ballistics — this file owns the timing only, so that the damage
     gate (`damageScale`) can never be skipped by a second implementation.
     MELEE_RANGE is kept solely for the early-boot wall-scuff fallback.
   ════════════════════════════════════════════════════════════════════════════ */
const TUNE = {
  WALK_SPEED: 4.6,
  SPRINT_SPEED: 7.2,
  CROUCH_SPEED: 2.5,
  BACK_MUL: 0.87,
  STRAFE_MUL: 0.94,
  GROUND_ACCEL: 65,
  GROUND_FRICTION: 12,
  STOP_SPEED: 1.35,

  AIR_ACCEL: 2.6,
  AIR_STRAFE_ACCEL: 44,
  AIR_STRAFE_WISH: 0.95,
  AIR_MAX_SPEED: 11,
  LAND_SPEED_CAP: 8.6,

  JUMP_SPEED: 7.1,
  COYOTE_TIME: 0.11,
  JUMP_BUFFER: 0.14,

  SPRINT_RAMP: 0.22,
  SPRINT_OUT_DELAY: 0.18,
  SPRINT_MIN_FORWARD: 0.15,

  STAND_HEIGHT: 1.8,
  CROUCH_HEIGHT: 1.1,
  STAND_EYE: 1.62,
  CROUCH_EYE: 0.95,
  CROUCH_TIME: 0.14,

  SLIDE_SPEED: 9.5,
  SLIDE_TIME: 0.9,
  SLIDE_FRICTION: 1.55,
  SLIDE_END_SPEED: 3.2,
  SLIDE_TURN_RATE: 1.55,
  SLIDE_COOLDOWN: 1.1,
  SLIDE_JUMP_KEEP: 0.88,
  SLIDE_JUMP_MAX: 8.6,
  SLIDE_MIN_ENTRY_SPEED: 4.1,

  // 0.55 exactly meets world.move()'s step-up limit, so there is no dead band
  // of ledges that are too tall to step and too short to vault.
  MANTLE_MIN_H: 0.55,
  MANTLE_MAX_H: 1.35,
  MANTLE_TIME: 0.35,
  MANTLE_COOLDOWN: 0.3,
  MANTLE_EXIT_SPEED: 2.2,
  MANTLE_REACH: 0.55,

  LEAN_DIST: 0.32,
  LEAN_RATE: 11,
  LEAN_CLEAR_PAD: 0.3,

  GRAVITY: -22,
  TERMINAL: -60,
  FALL_SAFE: 6,
  FALL_LETHAL: 16,
  FALL_CURVE: 1.28,

  STEP_DISTANCE: 2.05,
  STEP_DISTANCE_CROUCH: 2.6,

  MAX_HEALTH: 100,
  REGEN_DELAY: 4.2,
  REGEN_RATE: 28,
  ARMOR_ABSORB: 0.65,

  MELEE_RANGE: 2.2,
  MELEE_COOLDOWN: 0.75,
  MELEE_LOCKOUT: 0.55,

  GRENADE_COOLDOWN: 0.9,
  GRENADE_COUNT: 2,

  RADIUS: 0.36,

  // ── eye springs ───────────────────────────────────────────────────────────────────
  // These used to live in PlayerCamera and were integrated on the render clock. They
  // are not decoration: they are how the eye catches up with things the SOLVER did —
  // a stair step-up is an instantaneous vertical teleport, a landing is an impact
  // speed, a crouch is a height change. The eye has to lag them or the view snaps.
  //
  // They live here now because the eye is where bullets come from (`getEyePosition`,
  // and `weaponSystem.getFireOrigin` through it). Left in the camera, the shot origin
  // either ignored them — so the bullet left from a point up to 0.24 m from the one
  // the player was looking through, at every range, since the offset is a parallel
  // translation of the ray — or had to be read back off the render camera, which is
  // frame-rate dependent and does not exist on a server. Integrated here on the fixed
  // step they are deterministic, and the camera and the bullet agree by construction.
  EYE_SMOOTH: 18,           // 1/s — crouch/stand eye-height catch-up
  STEP_SMOOTH: 33,          // 1/s — a stair step-up is hidden and caught up
  STEP_MAX: 0.55,           // m — matches the solver's MAX_STEP_HEIGHT
  LAND_K: 165,              // landing spring stiffness
  LAND_C: 18.5,             // ...and damping — critically-ish damped
  LAND_GAIN: 0.36,          // spring velocity per (m/s) of impact
  LAND_MAX: 0.24,           // m — cap on the landing dip
  LAND_MIN_IMPACT: 1.4,     // m/s below which a landing does not register
  SLIDE_DIP: 0.13,          // m — extra eye drop while sliding
  SLIDE_ENTRY_DIP: 1.1,     // spring velocity injected when a slide starts

  // ── aim state ─────────────────────────────────────────────────────────────────────
  // Recoil and scope sway. These used to live entirely on PlayerCamera, integrated on
  // the render clock — moved here for the same reason the eye springs were: they move
  // player.yaw/pitch, which ballistics fires along, so they must run on a headless
  // server with no camera/render clock at all. What PlayerCamera keeps is only the
  // genuinely decorative remainder: the recoil PUNCH spring (camera pushed back along
  // its own -forward, never moves the aim) and damage shake.
  RECOIL_SCALE: 2.9,        // global multiplier
  RECOIL_SNAP: 38,          // 1/s — how fast the view reaches the new kick
  RECOIL_RECOVER: 7.5,      // default 1/s return (overridden by def.recoil.recovery)
  RECOIL_PERMANENT: 0.12,   // fraction of every kick that is NEVER recovered
  RECOIL_MAX_DEG: 22,       // per-call sanity clamp
  DAMAGE_PITCH: 2.6,        // degrees, flinch — see damageKick()
  DAMAGE_YAW: 2.2,
  // SCOPE — see `_updateScopeSway`. Amplitude is in DEGREES at full magnification and
  // is scaled per weapon by `def.scopeSwayMul`.
  SCOPE_SWAY: 0.36,
  SCOPE_SWAY_RATE: 8,
  SCOPE_ADS_IN: 0.40,        // adsAmount at which scope sway starts to come in
  BREATH_HOLD_MUL: 0.13,     // sway multiplier while the breath is held
  BREATH_GASP_MUL: 2.10,     // and immediately after it runs out
  BREATH_GASP_TIME: 1.10,
  BREATH_REFILL: 0.60,       // refill rate as a fraction of the drain rate
};

/** Fallbacks used when no weapon is equipped or a def field is missing. */
const WEAPON_FALLBACK = {
  adsTime: 0.24,
  adsFov: 55,
  adsSpeedMul: 0.62,
  moveSpeedMul: 1.0,
};

// ── module-scope scratch — nothing in the hot path allocates ────────────────
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _dirScratch = new THREE.Vector3();
const _DOWN = new THREE.Vector3(0, -1, 0);
const _UP = new THREE.Vector3(0, 1, 0);
const _lookOut = { x: 0, y: 0 };

// Probe offsets (unit circle) used for the stand-up ceiling check.
const _PROBE_X = [0, 0.72, -0.72, 0, 0];
const _PROBE_Z = [0, 0, 0, 0.72, -0.72];

/**
 * What `_buildLocalCommand` returns while not playing (menu, paused): every edge and
 * look delta off. Held state is a SEPARATE object — see `EMPTY_HELD` and
 * `_refreshHeldState` — because held state is refreshed every fixed substep, not
 * frame-gated like this one.
 */
const EMPTY_COMMAND = {
  crouchPressed: false,
  jump: false, reload: false, melee: false, grenade: false, interact: false,
  inspect: false, killstreak: false, lastWeapon: false, slot: -1,
  sprintDown: false, sprintUp: false, wheel: 0,
  firePressed: false, aimButtonPressed: false,
  deltaYaw: 0, deltaPitch: 0,
};

/** What `_refreshHeldState` sets while not playing (menu, paused). Everything off. */
const EMPTY_HELD = {
  wishForward: 0, wishRight: 0,
  crouchHeld: false, toggleAdsMode: false, aimButtonHeld: false,
  fireHeld: false, sprintKeyHeld: false, breathHold: false,
  leanKeyHeld: false, leanRightKeyHeld: false,
};

// Candidate method names on systems written by other engineers. We never assume
// a single spelling — the first callable match wins, missing ones degrade to no-op.
const M_SWITCH = ['switchTo', 'switchSlot', 'equipSlot', 'selectSlot', 'equip'];
const M_CURRENT = ['currentWeapon', 'weaponFor', 'getWeapon', 'instanceFor'];
const M_LOADOUT = ['createLoadout', 'giveLoadout', 'spawnLoadout', 'equipDefault'];
const M_STREAK = ['useKillstreak', 'activateKillstreak', 'triggerKillstreak'];
const M_DEATH = ['onPlayerDeath', 'onEntityDeath', 'reportDeath'];

/** Call the first method in `names` that actually exists. Never throws. */
function callAny(obj, names, a, b, c, d) {
  if (!obj) return undefined;
  for (let i = 0; i < names.length; i++) {
    const fn = obj[names[i]];
    if (typeof fn === 'function') {
      try {
        return fn.call(obj, a, b, c, d);
      } catch (err) {
        console.warn(`[player] ${names[i]}() threw`, err);
        return undefined;
      }
    }
  }
  return undefined;
}

/** Quake-style friction with a constant-deceleration floor for crisp stops. */
function applyFriction(vel, friction, stopSpeed, dt) {
  const sp = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  if (sp < 1e-4) { vel.x = 0; vel.z = 0; return; }
  const control = sp < stopSpeed ? stopSpeed : sp;
  let ns = sp - control * friction * dt;
  if (ns < 0) ns = 0;
  const s = ns / sp;
  vel.x *= s;
  vel.z *= s;
}

/** Accelerate toward wishDir, never exceeding wishSpeed along that axis. */
function accelerate(vel, wx, wz, wishSpeed, accel, dt) {
  const cur = vel.x * wx + vel.z * wz;
  const add = wishSpeed - cur;
  if (add <= 0) return;
  let a = accel * dt;
  if (a > add) a = add;
  vel.x += wx * a;
  vel.z += wz * a;
}

/**
 * The player. Implements the §4 entity contract exactly; weapons, ballistics,
 * AI and the HUD treat it identically to a bot.
 *
 * Simulation lives in `fixedUpdate(dt)` (always 1/120). Mouse look and every
 * visual are handled by `PlayerCamera`, driven from `update(dtFrame)` — except
 * that the look integration is *pulled forward* to the first fixed substep of
 * each frame (see `_pumpLocalCommand`) so the very step that moves you already knows
 * where you are aiming. Look is still applied exactly once per frame, so it is
 * never quantised to the 120 Hz grid.
 */
export class Player {
  constructor(game) {
    this.game = game;

    // ── entity contract ──
    this.id = game.allocEntityId();
    this.isPlayer = true;
    this.team = 0;
    this.alive = true;
    this.name = 'OPERATOR';

    this.position = new THREE.Vector3(0, 0, 0);   // FEET
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.yaw = 0;
    this.pitch = 0;

    // Aim state — see TUNE. `yaw`/`pitch` above (the §4 contract fields ballistics
    // fires along) are ALWAYS `baseYaw/basePitch + recoil + scopeSway`, written by
    // `_writeAngles()`. `baseYaw`/`basePitch` is the mouse-driven part, updated once
    // per frame at full resolution by `applyCommand`; recoil and sway are simulation,
    // integrated on the fixed clock by `_updateAim`.
    this.baseYaw = 0;
    this.basePitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.recoilPitchTarget = 0;
    this.recoilYawTarget = 0;
    this.scopeSwayYaw = 0;
    this.scopeSwayPitch = 0;
    /** 1 = full lungful, 0 = out of breath. Published for the HUD's breath meter. */
    this.breath = 1;
    this.breathHolding = false;
    this.breathGasp = 0;
    /**
     * 0..1 — how much of the sight picture is up. Published for PlayerCamera's `feel`
     * fade (positional/angular camera lies fade out as truth-through-a-scope arrives)
     * and for the render-aim interpolation alpha override — see `PlayerCamera.update`.
     */
    this.scopeAim = 0;
    /**
     * Snapshotted at the top of every fixed tick, BEFORE this tick touches recoil or
     * sway — i.e. they hold the END of the PREVIOUS tick's values. `PlayerCamera`
     * interpolates between these and the current values by the render clock's fraction
     * of a tick, so recoil/sway are smooth at any refresh rate without adding latency
     * to `baseYaw`/`basePitch` (which are never interpolated — they already update
     * every frame at full mouse resolution).
     */
    this.prevRecoilYaw = 0;
    this.prevRecoilPitch = 0;
    this.prevScopeSwayYaw = 0;
    this.prevScopeSwayPitch = 0;

    this.height = TUNE.STAND_HEIGHT;
    this.radius = TUNE.RADIUS;
    this.eyeHeight = TUNE.STAND_EYE;

    // Eye springs — see TUNE. `eyeSmooth` trails `eyeHeight`; `eyeStep` and `eyeLand`
    // are subtracted from it. `getEyePosition()` is the only thing that composes them.
    this.eyeSmooth = TUNE.STAND_EYE;
    this.eyeStep = 0;
    this.eyeLand = 0;
    this.eyeLandVel = 0;

    this.health = TUNE.MAX_HEALTH;
    this.maxHealth = TUNE.MAX_HEALTH;
    this.armor = 0;

    this.hitboxes = [
      { part: 'head', offset: new THREE.Vector3(0, 1.66, 0), size: new THREE.Vector3(0.30, 0.30, 0.30) },
      { part: 'torso', offset: new THREE.Vector3(0, 1.10, 0), size: new THREE.Vector3(0.56, 0.76, 0.38) },
      { part: 'limb', offset: new THREE.Vector3(0, 0.36, 0), size: new THREE.Vector3(0.52, 0.72, 0.34) },
    ];

    this.weapon = null;
    this.stats = { kills: 0, deaths: 0, score: 0, streak: 0 };

    // ── movement state ──
    /** @type {'ground'|'air'|'slide'|'mantle'} */
    this.moveState = 'air';
    this.grounded = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.moveSpeed = 0;            // current horizontal speed (HUD / crosshair)
    this.wishForward = 0;
    this.wishRight = 0;

    this.sprinting = false;
    this.sprintRamp = 0;
    this.crouchHeld = false;
    this.crouchFrac = 0;           // 0 = standing, 1 = fully crouched
    this.slideAmount = 0;          // 0..1 slide intensity, for the camera
    this.slideTimer = 0;
    this.slideDir = new THREE.Vector3(0, 0, -1);
    this.lean = 0;                 // signed metres, +right

    this.wantsAds = false;
    this.adsToggle = false;
    /** Backing store for `grenades` used only before the loadout exists. */
    this._grenadeFallback = TUNE.GRENADE_COUNT;

    this._lastGroundedAt = -99;
    this._jumpBufferAt = -99;
    this._slideCooldownUntil = -99;
    this._mantleCooldownUntil = -99;
    this._mantleUsedInAir = false;
    this._mantleT = 0;
    this._mantleFrom = new THREE.Vector3();
    this._mantleTo = new THREE.Vector3();
    this._mantleDir = new THREE.Vector3(0, 0, -1);
    this._airPeakY = 0;
    this._stepAccum = 0;
    this._lastDamageAt = -99;
    this._meleeReadyAt = 0;
    this._grenadeReadyAt = 0;
    this._fireReadyAt = 0;
    this._sprintInterrupted = false;
    this._wasFiring = false;
    this._lookFrame = -1;
    this._deathAt = 0;

    /**
     * Held-state, resolved once per rendered frame by `_buildLocalCommand` and read by
     * every fixed substep of that frame — see `applyCommand`. Values are stable across
     * a frame's substeps regardless (the JS event loop cannot change `game.input`
     * mid-frame), so caching them here instead of re-reading `game.input` per substep
     * changes nothing about behaviour; it only moves the read out of simulation code.
     */
    this._held = {
      wishForward: 0, wishRight: 0,
      crouchHeld: false, toggleAdsMode: false, sprintKeyHeld: false, breathHold: false,
      fireHeld: false, aimButtonHeld: false,
      leanKeyHeld: false, leanRightKeyHeld: false,
    };
    /**
     * Local-only, client-side bookkeeping for the crouch/ADS toggle SETTINGS — see
     * `_buildLocalCommand`. `_localCrouchToggle` is the actual flip-flop state;
     * `_localToggleAdsMode` just caches `settings.get('toggleAds')` once per frame
     * (instead of `_refreshHeldState` re-reading `game.settings` every substep) so both
     * settings-dependent held values are resolved on the same cadence.
     */
    this._localCrouchToggle = false;
    this._localToggleAdsMode = false;

    /** Edge-triggered input latched once per frame — see `applyCommand`. */
    this._edge = {
      jump: false, crouch: false, reload: false, melee: false, grenade: false,
      interact: false, inspect: false, killstreak: false, lastWeapon: false,
      slot: -1, sprintDown: false, sprintUp: false,
      fire: false, aim: false, wheel: 0,
    };
    /**
     * Was fire pressed THIS RENDERED FRAME — read by Match (skip the respawn
     * countdown) and Killstreaks (confirm an airstrike mark), both of which run AFTER
     * Player in game._fixedUpdate's system order (nav, player, bots, weapons,
     * projectiles, match). It must NOT live in `_edge`: that is cleared at the end of
     * EVERY substep, before those two systems get a turn in the SAME substep, so they
     * would never see it. `input.firePressed` (what they read before this refactor) is
     * itself frame-scoped — cleared once per rendered frame by `Input.endFrame()` — so
     * this field matches that lifetime: overwritten fresh every frame in
     * `_buildLocalCommand`, never cleared mid-frame.
     */
    this._firePressedThisFrame = false;

    this.camera = new PlayerCamera(game, this);
  }

  async init() {
    this._resolveSpawn();
    this.camera.reset();
    this._refreshWeapon(true);
  }

  reset() {
    this.stats.kills = 0;
    this.stats.deaths = 0;
    this.stats.score = 0;
    this.stats.streak = 0;
    this.respawn();
  }

  // ═══════════════════════════════════════════════════════════════ contract ══

  /**
   * Lethal count. There is exactly ONE grenade resource in the game and the weapon
   * system owns it (`loadout.equipment.lethalCount`) — this is a view onto it, kept
   * because the HUD and every existing caller read `player.grenades`. Two independent
   * counters for the same pouch is how one press ends up spending two grenades.
   */
  get grenades() {
    const lo = this.game.weapons?.getLoadout?.(this);
    return lo ? lo.equipment.lethalCount : this._grenadeFallback;
  }

  set grenades(n) {
    const v = Math.max(0, Math.floor(n) || 0);
    this._grenadeFallback = v;
    const lo = this.game.weapons?.getLoadout?.(this);
    if (lo) lo.equipment.lethalCount = v;
  }

  /**
   * The eye: where the player looks from, and where their bullets leave from. Includes
   * the eye springs, so it is the same point the camera renders from — see TUNE.
   */
  getEyePosition(out) {
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    return out.set(
      this.position.x + rx * this.lean,
      this.position.y + this.eyeSmooth - this.eyeStep - this.eyeLand - this.slideDip,
      this.position.z + rz * this.lean,
    );
  }

  /** Extra eye drop while sliding. Pure function of sim state, so nothing to integrate. */
  get slideDip() { return TUNE.SLIDE_DIP * this.slideAmount; }

  /** Stair step-up/down hiding. `dy` is the vertical teleport the solver just did. */
  addEyeStep(dy) {
    this.eyeStep = clamp(this.eyeStep + dy, -TUNE.STEP_MAX, TUNE.STEP_MAX);
  }

  /** Kick the landing spring. `impactSpeed` is the downward speed at touchdown. */
  addLandImpact(impactSpeed) {
    if (impactSpeed < TUNE.LAND_MIN_IMPACT) return;
    this.eyeLandVel += impactSpeed * TUNE.LAND_GAIN;
  }

  /**
   * Integrate the eye springs. Runs on the fixed step for everyone, alive or dead, so
   * the eye is a pure function of the tick sequence.
   */
  _updateEyeSprings(dt) {
    this.eyeSmooth = damp(this.eyeSmooth, this.eyeHeight, TUNE.EYE_SMOOTH, dt);
    this.eyeLandVel += (-TUNE.LAND_K * this.eyeLand - TUNE.LAND_C * this.eyeLandVel) * dt;
    this.eyeLand = clamp(this.eyeLand + this.eyeLandVel * dt, -0.06, TUNE.LAND_MAX);
    this.eyeStep = damp(this.eyeStep, 0, TUNE.STEP_SMOOTH, dt);
    if (Math.abs(this.eyeStep) < 1e-4) this.eyeStep = 0;
  }

  getAimDirection(out) {
    return dirFromAngles(this.yaw, this.pitch, out);
  }

  // ═══════════════════════════════════════════════════════════════════════ aim ══

  /** Snap the aim to an absolute yaw/pitch — spawn/respawn only. Clears all recoil/sway. */
  setAngles(yaw, pitch) {
    this.baseYaw = yaw;
    this.basePitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.recoilPitch = this.recoilYaw = 0;
    this.recoilPitchTarget = this.recoilYawTarget = 0;
    this.scopeSwayYaw = this.scopeSwayPitch = 0;
    this.prevRecoilYaw = this.prevRecoilPitch = 0;
    this.prevScopeSwayYaw = this.prevScopeSwayPitch = 0;
    this._writeAngles();
  }

  /** yaw/pitch = mouse intent + un-recovered recoil + scope sway. */
  _writeAngles() {
    this.yaw = this.baseYaw + this.recoilYaw + this.scopeSwayYaw;
    this.pitch = clamp(this.basePitch + this.recoilPitch + this.scopeSwayPitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  get _recoilRecovery() {
    const r = this.weapon?.def?.recoil?.recovery;
    return (typeof r === 'number' && r > 0.1) ? r : TUNE.RECOIL_RECOVER;
  }

  /**
   * @param {number} pitchKick upward kick in DEGREES (weaponDefs `recoil.up`)
   * @param {number} yawKick   sideways kick in DEGREES (`recoil.side`, signed)
   * @param {number} punch     view punch in METRES (`recoil.kick`) — camera-only, see
   *                           `game.present.cameraRecoilPunch`.
   */
  addRecoil(pitchKick, yawKick, punch = 0) {
    const maxK = TUNE.RECOIL_MAX_DEG;
    const p = clamp(pitchKick || 0, -maxK, maxK) * DEG * TUNE.RECOIL_SCALE;
    const y = clamp(yawKick || 0, -maxK, maxK) * DEG * TUNE.RECOIL_SCALE;
    this._addRecoilRad(p, y, TUNE.RECOIL_PERMANENT);
    if (punch) this.game.present.cameraRecoilPunch(this, clamp(punch, -0.5, 0.5));
  }

  /**
   * `permanentFrac` of the kick is written straight into the base aim angles and
   * therefore never recovers; the remainder decays back to zero, returning the aim to
   * exactly where the player was pointing.
   */
  _addRecoilRad(pitchRad, yawRad, permanentFrac) {
    const f = clamp(permanentFrac, 0, 1);
    if (f > 0) {
      this.basePitch = clamp(this.basePitch + pitchRad * f, -PITCH_LIMIT, PITCH_LIMIT);
      this.baseYaw += yawRad * f;
    }
    this.recoilPitchTarget += pitchRad * (1 - f);
    this.recoilYawTarget += yawRad * (1 - f);
    // Never let a pathological burst throw the aim past the pitch limit.
    this.recoilPitchTarget = clamp(this.recoilPitchTarget, -0.6, 0.6);
    this.recoilYawTarget = clamp(this.recoilYawTarget, -0.6, 0.6);
    this._writeAngles();
  }

  /**
   * Flinch. Routed through the recoil system with ZERO permanent component, so it
   * genuinely moves the player's aim (they can fight it) and then returns exactly to
   * where they were pointing. The visual punch/shake reaction is presentation.
   */
  damageKick(dirWorld, magnitude = 1) {
    const m = clamp(magnitude, 0, 1.6);
    // Lateral component of the attacker direction, in view space.
    const rx = Math.cos(this.baseYaw), rz = -Math.sin(this.baseYaw);
    const side = dirWorld ? clamp(dirWorld.x * rx + dirWorld.z * rz, -1, 1) : 0;
    // Punched AWAY from the damage: hit from the left, the aim snaps right.
    this._addRecoilRad(TUNE.DAMAGE_PITCH * DEG * m, -side * TUNE.DAMAGE_YAW * DEG * m, 0);
    this.game.present.cameraDamageFlinch(this, m);
  }

  /** Called first thing in `fixedUpdate`, before anything this tick can touch aim. */
  _snapshotAim() {
    this.prevRecoilYaw = this.recoilYaw;
    this.prevRecoilPitch = this.recoilPitch;
    this.prevScopeSwayYaw = this.scopeSwayYaw;
    this.prevScopeSwayPitch = this.scopeSwayPitch;
  }

  /**
   * Recoil decay + scope sway, on the fixed clock. Called after `_updateWeapon()` so
   * this tick's fire (if any) has already pushed the recoil TARGET via `addRecoil`
   * before the decay step chases it — the snapshot taken in `_snapshotAim()` at the top
   * of the tick is what makes that kick visible as "current" rather than "previous" to
   * the render-side interpolation.
   */
  _updateAim(dt) {
    const rec = this._recoilRecovery;
    this.recoilPitch = damp(this.recoilPitch, this.recoilPitchTarget, TUNE.RECOIL_SNAP, dt);
    this.recoilYaw = damp(this.recoilYaw, this.recoilYawTarget, TUNE.RECOIL_SNAP, dt);
    this.recoilPitchTarget = damp(this.recoilPitchTarget, 0, rec, dt);
    this.recoilYawTarget = damp(this.recoilYawTarget, 0, rec, dt);
    if (Math.abs(this.recoilPitchTarget) < 1e-5) this.recoilPitchTarget = 0;
    if (Math.abs(this.recoilYawTarget) < 1e-5) this.recoilYawTarget = 0;

    this._updateScopeSway(dt);
    this._writeAngles();
  }

  /**
   * Scoped-weapon hold: the low-frequency wander of a rifle held against a shoulder,
   * and the breath you hold to stop it.
   *
   * `weaponDefs` carries `scopeSwayMul`/`breathHoldTime`; this is what reads them.
   * Amplitude is deliberately modest — at the REAVER's 22° field of view, 0.36° x 1.6 is
   * about 2% of the screen height, enough to make a 200 m headshot a decision rather
   * than a formality, small enough that it never feels like the rifle is fighting you.
   *
   * `breathHold` comes from the command (`_held.breathHold`, resolved from the sprint
   * key while scoped — sprinting cancels ADS, so the key is otherwise dead in this
   * state), never read from `game.input` directly. Run the lungs dry and you gasp: sway
   * spikes above baseline for a second, so spamming it is worse than timing it.
   *
   * This used to run on the render clock (`PlayerCamera.update(dtFrame)`), using
   * `camera.swayTime += dtFrame` as the waveform's time base. Moved to the fixed clock
   * because it writes into `yaw`/`pitch` — ballistics fires along it — so it must be
   * deterministic and must run without a render loop. `game.time` (tick-derived) is the
   * waveform's time base now; the one behavioural change is that sway now genuinely
   * freezes while paused instead of continuing to drift, which is the more honest
   * reading of "paused".
   */
  _updateScopeSway(dt) {
    const def = this.weapon?.def;
    const scoped = !!def?.scoped && this.alive;

    // Everything below this line is scoped-only. Off the sniper it is one property
    // chain and a compare, then a decay that reaches exact zero and stops.
    if (!scoped) {
      this.scopeAim = 0;
      if (this.scopeSwayYaw === 0 && this.scopeSwayPitch === 0 && this.breath === 1
        && this.breathGasp === 0) return;
      this.breathHolding = false;
      this.breathGasp = Math.max(0, this.breathGasp - dt);
      this.breath = Math.min(1, this.breath + dt * 0.7);
      this.scopeSwayYaw = damp(this.scopeSwayYaw, 0, TUNE.SCOPE_SWAY_RATE, dt);
      this.scopeSwayPitch = damp(this.scopeSwayPitch, 0, TUNE.SCOPE_SWAY_RATE, dt);
      if (Math.abs(this.scopeSwayYaw) < 1e-6) this.scopeSwayYaw = 0;
      if (Math.abs(this.scopeSwayPitch) < 1e-6) this.scopeSwayPitch = 0;
      return;
    }

    const amt = clamp((clamp(this.adsAmount, 0, 1) - TUNE.SCOPE_ADS_IN) / (1 - TUNE.SCOPE_ADS_IN), 0, 1);
    this.scopeAim = amt;

    // ── breath ──
    const holdTime = Math.max(0.4, def.breathHoldTime || 2.5);
    const wantHold = amt > 0.5 && this._held.breathHold;
    if (wantHold && this.breath > 0) {
      this.breathHolding = true;
      this.breath = Math.max(0, this.breath - dt / holdTime);
      if (this.breath <= 0) this.breathGasp = TUNE.BREATH_GASP_TIME;
    } else {
      this.breathHolding = false;
      this.breath = Math.min(1, this.breath + dt * TUNE.BREATH_REFILL / holdTime);
      this.breathGasp = Math.max(0, this.breathGasp - dt);
    }

    // ── sway ──
    const gasp = lerp(1, TUNE.BREATH_GASP_MUL, clamp(this.breathGasp / TUNE.BREATH_GASP_TIME, 0, 1));
    const hold = this.breathHolding ? TUNE.BREATH_HOLD_MUL : 1;
    const a = TUNE.SCOPE_SWAY * DEG * amt * (def.scopeSwayMul ?? 1) * hold * gasp;
    const t = this.game.time;
    // Two incommensurable frequencies per axis: the drift never repeats, so it cannot
    // be learned and timed the way a single sine can.
    const ty = (Math.sin(t * 0.61) * 0.70 + Math.sin(t * 1.43 + 2.1) * 0.30) * a;
    const tp = (Math.sin(t * 0.87 + 1.1) * 0.65 + Math.sin(t * 1.97 + 0.4) * 0.35) * a * 0.78;
    this.scopeSwayYaw = damp(this.scopeSwayYaw, ty, TUNE.SCOPE_SWAY_RATE, dt);
    this.scopeSwayPitch = damp(this.scopeSwayPitch, tp, TUNE.SCOPE_SWAY_RATE, dt);
  }

  /**
   * @param {number} amount already multiplied by the hit-part modifier by ballistics.
   * @param {{attacker?:object, hitPart?:string, point?:THREE.Vector3, normal?:THREE.Vector3, weaponId?:string}} [info]
   * @returns {number} damage actually taken.
   */
  applyDamage(amount, info) {
    if (!this.alive || !(amount > 0)) return 0;

    // Armour eats a fraction until depleted.
    let dmg = amount;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, dmg * TUNE.ARMOR_ABSORB);
      this.armor -= absorbed;
      dmg -= absorbed;
    }

    this.health -= dmg;
    this._lastDamageAt = this.game.time;

    // World-space direction from us TO the attacker, for the HUD arc indicator.
    // Freshly allocated: damage is rare and the HUD keeps the vector.
    const dirWorld = new THREE.Vector3();
    const src = info?.attacker?.position ?? info?.point ?? null;
    if (src) {
      dirWorld.set(src.x - this.position.x, 0, src.z - this.position.z);
      if (dirWorld.lengthSq() < 1e-6) dirWorld.set(0, 0, -1);
      else dirWorld.normalize();
    } else {
      // No attacker (fall damage / world hazard) — point at our own feet.
      dirWorld.set(0, -1, 0);
    }

    this.game.bus?.emit('playerDamaged', { amount: dmg, dirWorld });
    this.game.present.flashDamage(clamp(dmg / 55, 0.12, 1), this);
    // Aim-moving (sim) and presentation-only (punch/shake) — see damageKick(). Called
    // directly, not through game.present: the sim half must run without a presenter.
    this.damageKick(dirWorld, clamp(dmg / 40, 0.15, 1.4));
    this.game.present.play('hurt', { volume: clamp(0.45 + dmg / 90, 0.45, 1) });

    if (this.health <= 0) {
      this.health = 0;
      this.die(info);
    }
    return dmg;
  }

  /** Kill the player. Ballistics owns the `kill` event — we never duplicate it. */
  die(info) {
    if (!this.alive) return;
    this.alive = false;
    this.health = 0;
    this.moveState = 'air';
    this.slideTimer = 0;
    this.slideAmount = 0;
    this.lean = 0;
    this.sprinting = false;
    this.sprintRamp = 0;
    this.wantsAds = false;
    this.adsToggle = false;
    this.stats.deaths++;
    this.stats.streak = 0;
    this._deathAt = this.game.time;

    this.weapon?.stopFire?.();
    // Explicitly drop the aim as well. `_readInput` is the only other caller of `setAds`
    // and it does not run while dead, so without this the gun stays aimed in through the
    // death cam — previously masked by `die()` zeroing Player's own copy of `adsAmount`,
    // which no longer exists now that the weapon owns it.
    this.weapon?.setAds?.(false);
    this.game.present.play('death', { volume: 0.9 });

    const killer = info?.attacker ?? null;
    this.game.present.cameraStartDeathCam(this, killer && killer !== this ? killer.position : null);

    // The match owns respawn/score rules. Tell it both ways it may be listening.
    callAny(this.game.match, M_DEATH, this, info);
    this.game.bus?.emit('playerDied', { entity: this, attacker: killer, info: info ?? null });
  }

  // ═══════════════════════════════════════════════════════════════ spawning ══

  _resolveSpawn() {
    const pts = this.game.world?.spawnPoints;
    if (!pts || pts.length === 0) {
      this.position.set(0, 1.2, 0);
      return;
    }
    // Prefer our team's spawns, then any.
    let best = null;
    let count = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.team !== -1 && p.team !== this.team) continue;
      count++;
      if (this.game.rng ? this.game.rng() < 1 / count : !best) best = p;
    }
    if (!best) best = pts[0];
    this.position.copy(best.position);
    this.yaw = best.yaw ?? 0;
    this.pitch = 0;
  }

  respawn(point) {
    if (point) {
      this.position.copy(point.position);
      this.yaw = point.yaw ?? 0;
      this.pitch = 0;
    } else {
      this._resolveSpawn();
    }

    this.alive = true;
    this.health = this.maxHealth;
    this.armor = 0;
    this.velocity.set(0, 0, 0);
    this.height = TUNE.STAND_HEIGHT;
    this.eyeHeight = TUNE.STAND_EYE;
    // Springs start settled: a respawn must not damp the eye up from wherever the
    // corpse left it, or you spawn looking out of your own knees.
    this.eyeSmooth = TUNE.STAND_EYE;
    this.eyeStep = 0;
    this.eyeLand = 0;
    this.eyeLandVel = 0;
    this.crouchHeld = false;
    this._localCrouchToggle = false;
    this.crouchFrac = 0;
    this.moveState = 'air';
    this.grounded = false;
    this.groundNormal.set(0, 1, 0);
    this.sprinting = false;
    this.sprintRamp = 0;
    this.slideTimer = 0;
    this.slideAmount = 0;
    this.lean = 0;
    this.wantsAds = false;
    this.adsToggle = false;
    this.grenades = TUNE.GRENADE_COUNT;
    this.moveSpeed = 0;
    this._airPeakY = this.position.y;
    this._stepAccum = 0;
    this._lastDamageAt = -99;
    this._fireReadyAt = 0;
    this._meleeReadyAt = 0;
    this._grenadeReadyAt = 0;
    this._slideCooldownUntil = -99;
    this._mantleCooldownUntil = -99;
    this._mantleUsedInAir = false;
    this._sprintInterrupted = false;
    this._wasFiring = false;

    this.game.present.cameraEndDeathCam(this);
    this.setAngles(this.yaw, this.pitch);
    this._updateHitboxes();
    this._refreshWeapon(true);
    this.game.bus?.emit('spawn', { entity: this });
  }

  // ════════════════════════════════════════════════════════════════ weapons ══

  _refreshWeapon(requestLoadout = false) {
    const ws = this.game.weapons;
    if (!ws) return;
    if (requestLoadout) callAny(ws, M_LOADOUT, this);
    const w = callAny(ws, M_CURRENT, this);
    if (w && typeof w === 'object') this.weapon = w;
    else if (!this.weapon && ws.playerWeapon) this.weapon = ws.playerWeapon;
  }

  /** Weapon def with safe fallbacks — the weapon system may still be booting. */
  get _def() {
    return this.weapon?.def ?? WEAPON_FALLBACK;
  }

  /**
   * How far into the sight picture we are, 0..1. Read by movement speed, look
   * sensitivity, scope sway, camera FOV and the scope shader.
   *
   * Owned by the WeaponInstance, and derived here rather than stored. Player used to
   * integrate its own copy and then reconcile against the weapon's every tick through a
   * self-correcting handshake (`_lastWeaponAds`) that existed because nobody had decided
   * who owned the value. The weapon always won in practice — `weapons.fixedUpdate` runs
   * after `player.fixedUpdate`, so it recomputed `adsAmount` after every write Player
   * made — which means this getter returns exactly what shipped, with one integrator
   * instead of two.
   *
   * It has to be the weapon that owns it: bots share WeaponInstance and have no
   * player-side integrator, and the two disagreed anyway (Player's was linear and
   * asymmetric, the weapon's is `1-(1-raw)^2` and symmetric) while feeding different
   * consumers, so a one-tick lag between them was observable.
   *
   * For snapshot/restore this is the point: `adsAmount` is now one field with one owner,
   * appearing once in the weapon's manifest rather than twice with a handshake to keep
   * them agreeing.
   */
  get adsAmount() {
    return this.weapon ? clamp(this.weapon.adsAmount, 0, 1) : 0;
  }

  get adsTime() {
    const t = this._def.adsTime;
    return typeof t === 'number' && t > 0.01 ? t : WEAPON_FALLBACK.adsTime;
  }

  get adsFov() {
    const f = this._def.adsFov;
    return typeof f === 'number' && f > 5 ? f : WEAPON_FALLBACK.adsFov;
  }

  // ══════════════════════════════════════════════════════ frame entrypoints ══

  /**
   * Build and apply this tick's command exactly once per rendered frame. Pumped from
   * the first fixed substep so movement in that same frame uses fresh input (zero added
   * latency), and from `update()` as a fallback for frames that ran no substep at all
   * (>120 fps, or while paused).
   *
   * This is the ONLY place local input is read. `_buildLocalCommand` is the seam a
   * networked build replaces: a remote player's command arrives over the wire instead
   * of being built from `game.input` here, and `applyCommand` cannot tell the
   * difference — it never touches `game.input` or `game.settings` itself.
   */
  _pumpLocalCommand() {
    // In multiplayer the SESSION builds and applies the command, once per tick, and then
    // runs the step. Building another one here from the same input would apply the frame's
    // mouse delta a second time — the look would move at double rate, and only in
    // multiplayer, which is a miserable thing to track down.
    if (this.game.net) return;
    // No local input device means nothing local to build. An authoritative server applies
    // commands it RECEIVED, straight through `applyCommand`, and never runs this path —
    // so its absence is the normal case there, not a failure.
    if (!this.game.input) return;
    if (this._lookFrame === this.game.frame) return;
    this._lookFrame = this.game.frame;
    this.applyCommand(this._buildLocalCommand());
  }

  /**
   * Resolve this tick's local input into a command. Every settings-dependent
   * button→intent mapping (toggle vs hold, autoSprint) is decided HERE, not in
   * `applyCommand` — `game.settings` is this machine's own settings, meaningless for a
   * remote player's command, so the resolution has to happen before the command exists.
   *
   * The look delta is likewise resolved to radians here (sensitivity, ADS zoom
   * compensation, invertY) rather than sent as raw pixels — see `_lookDeltaToRadians`.
   *
   * `firePressed` doubles as the resolve-respawn-early and confirm-airstrike-mark input
   * (see `applyCommand`'s edge dispatch and `Match._updateRespawns`/`Killstreaks`, which
   * used to read `game.input.firePressed` directly): one raw edge, several consumers.
   */
  _buildLocalCommand() {
    const g = this.game;
    const cmd = this._cmdScratch || (this._cmdScratch = {});
    if (g.state !== 'playing' || g.paused) {
      g.input.consumeWheel?.();
      Object.assign(cmd, EMPTY_COMMAND);
      this._firePressedThisFrame = false;
      return cmd;
    }
    const i = g.input;
    const s = g.settings;

    let mf = 0, mr = 0;
    if (i.isDown('forward')) mf += 1;
    if (i.isDown('back')) mf -= 1;
    if (i.isDown('right')) mr += 1;
    if (i.isDown('left')) mr -= 1;
    if (mf !== 0 && mr !== 0) { const k = Math.SQRT1_2; mf *= k; mr *= k; }
    cmd.wishForward = mf;
    cmd.wishRight = mr;

    cmd.jump = i.wasPressed('jump');
    cmd.reload = i.wasPressed('reload');
    cmd.melee = i.wasPressed('melee');
    cmd.grenade = i.wasPressed('grenade');
    cmd.interact = i.wasPressed('interact');
    cmd.inspect = i.wasPressed('inspect');
    cmd.killstreak = i.wasPressed('killstreak');
    cmd.lastWeapon = i.wasPressed('lastWeapon');
    cmd.slot = i.wasPressed('weapon1') ? 0 : i.wasPressed('weapon2') ? 1 : i.wasPressed('weapon3') ? 2 : -1;
    cmd.sprintDown = i.wasPressed('sprint');
    cmd.sprintUp = i.wasReleased('sprint');
    cmd.wheel = i.consumeWheel?.() ?? 0;
    cmd.firePressed = i.firePressed;
    cmd.aimButtonPressed = i.aimPressed;
    this._firePressedThisFrame = i.firePressed;

    // Crouch's "just engaged" edge (drives slide entry). The toggle FLIP has to happen
    // here, once per frame, because it is driven by `wasPressed` — a genuinely
    // frame-scoped edge (see the class doc on `Input`). `_refreshHeldState` below only
    // READS `_localCrouchToggle` every substep; it must not also flip it, or a 6-substep
    // frame would flip the toggle up to six times instead of once.
    const crouchKeyPressed = i.wasPressed('crouch');
    if (s.get('toggleCrouch')) {
      if (crouchKeyPressed) this._localCrouchToggle = !this._localCrouchToggle;
      cmd.crouchPressed = crouchKeyPressed && this._localCrouchToggle;
    } else {
      cmd.crouchPressed = crouchKeyPressed;
    }

    this._localToggleAdsMode = s.get('toggleAds');

    cmd.deltaYaw = 0;
    cmd.deltaPitch = 0;
    this._lookDeltaToRadians(cmd);

    return cmd;
  }

  /**
   * Held button/axis state, refreshed every FIXED SUBSTEP (not frame-gated like
   * `_buildLocalCommand`). `game.input` is a live, always-current source with no
   * staleness to worry about — re-deriving `wishForward` six times in one rendered
   * frame produces the same value each time, so there is no reason to cache it behind
   * the frame gate the way edges and mouse-look genuinely require:
   *   - Edges (`wasPressed`) are cleared once per RENDERED frame by `Input.endFrame()`,
   *     so reading them every substep would fire one action per substep instead of once.
   *   - Mouse look is deliberately consumed once per frame at full resolution.
   * Held state has neither problem, and reading it once per frame instead of every
   * substep is actively wrong on a server or test harness that drives `_fixedUpdate`
   * without a render loop incrementing `game.frame` — the frame gate would then never
   * open again after the first tick, freezing movement and fire input.
   */
  _refreshHeldState() {
    const g = this.game;
    const h = this._held;
    // Same as `_pumpLocalCommand`: with no input device the held state comes from the
    // applied command instead, so leave it alone rather than clearing it — clearing it
    // every substep would stamp out the movement a received command just asked for.
    if (!g.input) return;
    if (g.state !== 'playing' || g.paused) { Object.assign(h, EMPTY_HELD); return; }
    const i = g.input;
    const s = g.settings;

    let mf = 0, mr = 0;
    if (i.isDown('forward')) mf += 1;
    if (i.isDown('back')) mf -= 1;
    if (i.isDown('right')) mr += 1;
    if (i.isDown('left')) mr -= 1;
    if (mf !== 0 && mr !== 0) { const k = Math.SQRT1_2; mf *= k; mr *= k; }
    h.wishForward = mf;
    h.wishRight = mr;

    if (s.get('toggleCrouch')) {
      // The toggle itself only flips on the press EDGE, so it lives in
      // `_buildLocalCommand` (frame-gated, sees `wasPressed` exactly once) — this just
      // reads the current toggle state every substep, same as any other held value.
      h.crouchHeld = this._localCrouchToggle;
    } else {
      h.crouchHeld = i.isDown('crouch');
    }

    // See `_buildLocalCommand`'s comment: the ADS toggle flip/clear needs THIS tick's
    // sim state (adsBlocked), so only the mode + raw button are resolved here; the
    // flip itself happens in `_readInput`. `_localToggleAdsMode` is cached once per
    // frame in `_buildLocalCommand`, not re-read from `game.settings` here, so this
    // matches `_localCrouchToggle`'s cadence exactly.
    h.toggleAdsMode = this._localToggleAdsMode;
    h.aimButtonHeld = i.aim;

    h.fireHeld = i.fire;
    h.sprintKeyHeld = s.get('autoSprint') ? true : i.isDown('sprint');
    h.breathHold = i.isDown('sprint');
    h.leanKeyHeld = i.isDown('lean');
    h.leanRightKeyHeld = i.isDown('right');
  }

  /**
   * Raw mouse pixels → yaw/pitch radians for this tick, written into `cmd.deltaYaw`/
   * `cmd.deltaPitch`. Exactly the transform `PlayerCamera.updateLook()` used to do
   * inline; moved here so the camera never reads `game.input`/`game.settings` itself.
   */
  _lookDeltaToRadians(cmd) {
    const g = this.game;
    const input = g.input;
    input.consumeLook(_lookOut);

    const playable = g.state === 'playing' && !g.paused && input.locked && this.alive;
    if (!playable) return;   // drain and discard — re-entering the game must not replay stale motion

    const s = g.settings;
    const cam = this.camera;
    // Zoom-compensated sensitivity. The ratio uses the ADS-only fov so that the
    // sprint/slide fov widen never changes how aiming feels.
    const baseFov = s.get('fov');
    const ratio = Math.tan(cam.adsFovOnly * 0.5 * DEG) / Math.tan(baseFov * 0.5 * DEG);
    const adsMul = lerp(1, s.get('adsSensitivity'), clamp(this.adsAmount, 0, 1));
    const sens = CAMERA_TUNE.SENS_BASE * s.get('sensitivity') * adsMul * ratio;

    cmd.deltaYaw = -_lookOut.x * sens;
    cmd.deltaPitch = (s.get('invertY') ? _lookOut.y : -_lookOut.y) * sens;
  }

  /**
   * Apply one command's EDGES and LOOK delta. Called once per rendered frame (see
   * `_pumpLocalCommand`) — held state is a separate, per-substep concern, refreshed by
   * `_refreshHeldState` for exactly the reasons explained there. Between them, nothing
   * else in `fixedUpdate` reads `game.input`.
   */
  applyCommand(cmd) {
    this.baseYaw += cmd.deltaYaw;
    this.basePitch = clamp(this.basePitch + cmd.deltaPitch, -PITCH_LIMIT, PITCH_LIMIT);
    if (this.baseYaw > Math.PI * 4) this.baseYaw -= Math.PI * 4;
    else if (this.baseYaw < -Math.PI * 4) this.baseYaw += Math.PI * 4;
    // Banked for the camera's sway/lag pass, consumed once in camera.update().
    this.camera._lookDX += cmd.deltaYaw;
    this.camera._lookDY += cmd.deltaPitch;
    this._writeAngles();

    const e = this._edge;
    e.jump = cmd.jump; e.crouch = cmd.crouchPressed; e.reload = cmd.reload;
    e.melee = cmd.melee; e.grenade = cmd.grenade; e.interact = cmd.interact;
    e.inspect = cmd.inspect; e.killstreak = cmd.killstreak; e.lastWeapon = cmd.lastWeapon;
    e.slot = cmd.slot; e.sprintDown = cmd.sprintDown; e.sprintUp = cmd.sprintUp;
    e.fire = cmd.firePressed; e.aim = cmd.aimButtonPressed;
    e.wheel += cmd.wheel;
  }

  _clearEdges() {
    const e = this._edge;
    e.jump = false; e.crouch = false; e.reload = false; e.melee = false;
    e.grenade = false; e.interact = false; e.inspect = false; e.killstreak = false;
    e.lastWeapon = false; e.slot = -1; e.sprintDown = false; e.sprintUp = false;
    e.fire = false; e.aim = false; e.wheel = 0;
  }

  fixedUpdate(dt) {
    this._pumpLocalCommand();
    this._refreshHeldState();
    this._snapshotAim();
    if (!this.game.world) return;

    if (!this.alive) {
      this._deadFixedUpdate(dt);
      this._updateEyeSprings(dt);
      this._updateAim(dt);
      this._clearEdges();
      return;
    }

    this._readInput(dt);
    this._updateStance(dt);

    if (this.moveState === 'mantle') {
      this._mantleStep(dt);
    } else {
      this._jumpStep();
      if (this.moveState !== 'mantle') this._moveStep(dt);
    }

    this._updateLean(dt);
    this._updateWeapon();
    this._updateHealth(dt);
    this._updateEyeSprings(dt);
    this._updateHitboxes();
    this._updateAim(dt);
    this._clearEdges();
  }

  update(dtFrame) {
    this._pumpLocalCommand();
    this.camera.update(dtFrame);
  }

  _deadFixedUpdate(dt) {
    // Ragdoll-lite: keep the corpse honest so the death camera has a body to
    // orbit, but stop steering it.
    this.velocity.y = Math.max(TUNE.TERMINAL, this.velocity.y + TUNE.GRAVITY * dt);
    applyFriction(this.velocity, 6, TUNE.STOP_SPEED, dt);
    const res = this.game.world.move(this.position, this.velocity, this.radius, TUNE.CROUCH_HEIGHT, dt);
    this.position.copy(res.position);
    this.velocity.copy(res.velocity);
    this.grounded = res.grounded;
    this.height = damp(this.height, TUNE.CROUCH_HEIGHT, 9, dt);
    this.eyeHeight = this._eyeForHeight(this.height);
  }

  // ══════════════════════════════════════════════════════════════════ input ══

  /**
   * Consume this frame's command (latched into `this._held`/`this._edge` by
   * `applyCommand`) every fixed substep. No `game.input`/`game.settings` reads below —
   * everything settings-dependent (toggle/hold mapping) was already resolved when the
   * command was built; what's left here is arbitration that needs THIS TICK's sim
   * state (sprint/ADS mutual exclusion, ADS blocked by sprinting/mantling/dying), which
   * the command builder cannot know in advance.
   */
  _readInput(dt) {
    const h = this._held;
    const e = this._edge;

    let mf = h.wishForward, mr = h.wishRight;
    this.wishForward = mf;
    this.wishRight = mr;

    // ── crouch — already fully resolved by the command builder ──
    this.crouchHeld = h.crouchHeld;

    // ── sprint arbitration ──
    // Sprint and ADS are mutually exclusive; the most recent intent wins.
    if (h.toggleAdsMode && e.aim) this.adsToggle = !this.adsToggle;
    if (e.aim || e.fire) this._sprintInterrupted = true;
    if (e.sprintDown || e.sprintUp) this._sprintInterrupted = false;
    // Once the trigger and the aim button are both released, sprinting is free
    // again without demanding a fresh key press.
    if (this._sprintInterrupted && !h.fireHeld && !h.aimButtonHeld &&
        !(h.toggleAdsMode && this.adsToggle)) {
      this._sprintInterrupted = false;
    }

    const sprintKey = h.sprintKeyHeld;
    const wasSprinting = this.sprinting;
    this.sprinting =
      this.alive &&
      sprintKey &&
      mf > TUNE.SPRINT_MIN_FORWARD &&
      !this.crouchHeld &&
      !this._sprintInterrupted &&
      this.moveState !== 'mantle' &&
      this.moveState !== 'slide' &&
      (this.grounded || this.game.time - this._lastGroundedAt < 0.35);

    if (this.sprinting) {
      this.sprintRamp = Math.min(1, this.sprintRamp + dt / TUNE.SPRINT_RAMP);
    } else {
      if (wasSprinting && this.sprintRamp > 0.3) {
        // Sprint-out delay: the gun has to come back up before it can fire.
        this._fireReadyAt = Math.max(this._fireReadyAt, this.game.time + TUNE.SPRINT_OUT_DELAY);
      }
      this.sprintRamp = Math.max(0, this.sprintRamp - dt / (TUNE.SPRINT_RAMP * 0.55));
    }

    // ── slide entry — `e.crouch` is already the "just engaged" edge ──
    if (e.crouch) this._tryStartSlide();

    // ── ADS ──
    const adsHeld = h.toggleAdsMode ? this.adsToggle : h.aimButtonHeld;
    const adsBlocked = this.sprinting || this.moveState === 'mantle' || !this.alive;
    this.wantsAds = !!adsHeld && !adsBlocked;
    if (adsBlocked && h.toggleAdsMode) this.adsToggle = false;

    // Intent only. The WeaponInstance owns `adsAmount` and integrates it (see the
    // `adsAmount` getter) — the player says whether it wants to be aiming, and the gun
    // decides how far in it actually is.
    this.weapon?.setAds(this.wantsAds);
  }

  // ═════════════════════════════════════════════════════════════════ stance ══

  _eyeForHeight(h) {
    const t = clamp((h - TUNE.CROUCH_HEIGHT) / (TUNE.STAND_HEIGHT - TUNE.CROUCH_HEIGHT), 0, 1);
    return lerp(TUNE.CROUCH_EYE, TUNE.STAND_EYE, t);
  }

  /** Five upward rays: you cannot stand up inside geometry. */
  _canStand() {
    const need = TUNE.STAND_HEIGHT - this.height + 0.06;
    if (need <= 0) return true;
    const world = this.game.world;
    const r = this.radius;
    for (let i = 0; i < _PROBE_X.length; i++) {
      _v1.set(
        this.position.x + _PROBE_X[i] * r,
        this.position.y + Math.max(0.05, this.height - 0.05),
        this.position.z + _PROBE_Z[i] * r,
      );
      if (world.raycast(_v1, _UP, need)) return false;
    }
    return true;
  }

  _updateStance(dt) {
    const sliding = this.moveState === 'slide';
    // A slide that ends early (wall, speed loss) must still let the camera dip
    // recover smoothly instead of leaving `slideAmount` stuck mid-value.
    if (!sliding && this.slideAmount > 0) {
      this.slideAmount = Math.max(0, this.slideAmount - dt / 0.25);
    }

    const wantCrouch = this.crouchHeld || sliding;
    let target = wantCrouch ? TUNE.CROUCH_HEIGHT : TUNE.STAND_HEIGHT;
    if (!wantCrouch && this.height < TUNE.STAND_HEIGHT - 1e-3 && !this._canStand()) {
      target = this.height; // ceiling above — stay down
    }

    const rate = (TUNE.STAND_HEIGHT - TUNE.CROUCH_HEIGHT) / TUNE.CROUCH_TIME;
    const step = rate * dt;
    if (this.height < target) this.height = Math.min(target, this.height + step);
    else if (this.height > target) this.height = Math.max(target, this.height - step);

    this.eyeHeight = this._eyeForHeight(this.height);
    this.crouchFrac = clamp(
      (TUNE.STAND_HEIGHT - this.height) / (TUNE.STAND_HEIGHT - TUNE.CROUCH_HEIGHT), 0, 1,
    );
  }

  // ══════════════════════════════════════════════════════════════════ slide ══

  _tryStartSlide() {
    if (this.moveState !== 'ground') return;
    if (this.game.time < this._slideCooldownUntil) return;
    if (this.sprintRamp < 0.55) return;
    const sp = Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);
    if (sp < TUNE.SLIDE_MIN_ENTRY_SPEED) return;

    this.moveState = 'slide';
    this.slideTimer = TUNE.SLIDE_TIME;
    this.slideAmount = 1;
    this.sprinting = false;
    this.sprintRamp = 0;
    this.lean = 0;

    // Burst along current travel (fall back to facing when nearly still).
    if (sp > 0.5) this.slideDir.set(this.velocity.x / sp, 0, this.velocity.z / sp);
    else this.slideDir.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const boost = Math.max(sp, TUNE.SLIDE_SPEED);
    this.velocity.x = this.slideDir.x * boost;
    this.velocity.z = this.slideDir.z * boost;

    // Follow-through on the entry. `slideAmount` snaps 0 → 1 in a single tick, so
    // `slideDip` teleports the eye down 13 cm; this impulse is what makes that read as a
    // body dropping into the slide rather than a cut. Injected directly rather than
    // through addLandImpact(), which floors below LAND_MIN_IMPACT and would swallow it.
    this.eyeLandVel += TUNE.SLIDE_ENTRY_DIP;

    this.game.present.cameraStartSlide(this);
    this.game.present.play('footstepConcrete', {
      position: this.position, volume: 0.85, rate: 0.42,
    });
    this._emitNoise(0.85);
  }

  _endSlide(fromJump) {
    if (this.moveState !== 'slide') return;
    this.moveState = this.grounded ? 'ground' : 'air';
    this.slideTimer = 0;
    this._slideCooldownUntil = this.game.time + TUNE.SLIDE_COOLDOWN;
    if (!fromJump) this._sprintInterrupted = false;
    this.camera.endSlide();
  }

  _slideStep(dt) {
    this.slideTimer -= dt;
    this.slideAmount = clamp(this.slideTimer / TUNE.SLIDE_TIME, 0, 1);

    // Reduced steering: carve the slide direction rather than accelerate it.
    const mf = this.wishForward, mr = this.wishRight;
    if (mf !== 0 || mr !== 0) {
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
      let wx = fx * mf + rx * mr;
      let wz = fz * mf + rz * mr;
      const wl = Math.sqrt(wx * wx + wz * wz);
      if (wl > 1e-4) {
        wx /= wl; wz /= wl;
        const cross = this.slideDir.x * wz - this.slideDir.z * wx;
        const dot = clamp(this.slideDir.x * wx + this.slideDir.z * wz, -1, 1);
        const ang = Math.atan2(cross, dot);
        const maxStep = TUNE.SLIDE_TURN_RATE * dt;
        const turn = clamp(ang, -maxStep, maxStep);
        const c = Math.cos(turn), s = Math.sin(turn);
        const nx = this.slideDir.x * c - this.slideDir.z * s;
        const nz = this.slideDir.x * s + this.slideDir.z * c;
        this.slideDir.set(nx, 0, nz);
      }
    }

    let sp = Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);
    sp *= Math.exp(-TUNE.SLIDE_FRICTION * dt);
    this.velocity.x = this.slideDir.x * sp;
    this.velocity.z = this.slideDir.z * sp;

    if (this.slideTimer <= 0 || sp < TUNE.SLIDE_END_SPEED || !this.grounded) this._endSlide(false);
  }

  // ═══════════════════════════════════════════════════════════ jump / vault ══

  _jumpStep() {
    const t = this.game.time;
    if (this._edge.jump) this._jumpBufferAt = t;
    const buffered = t - this._jumpBufferAt <= TUNE.JUMP_BUFFER;
    if (!buffered) return;

    // 1. A ledge in front always beats a plain jump — that is what makes vaults
    //    feel automatic instead of fiddly.
    if (this._tryMantle()) { this._jumpBufferAt = -99; return; }

    // 2. Slide-jump: cancel the slide but keep most of the momentum.
    if (this.moveState === 'slide') {
      const sp = Math.min(
        TUNE.SLIDE_JUMP_MAX,
        Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z) * TUNE.SLIDE_JUMP_KEEP,
      );
      this.velocity.x = this.slideDir.x * sp;
      this.velocity.z = this.slideDir.z * sp;
      this.velocity.y = TUNE.JUMP_SPEED * 0.94;
      this._endSlide(true);
      this._leaveGround();
      this._jumpBufferAt = -99;
      this.game.present.play('jump', { position: this.position, volume: 0.75 });
      this._emitNoise(0.7);
      return;
    }

    // 3. Normal jump with coyote time.
    if (this.grounded || t - this._lastGroundedAt <= TUNE.COYOTE_TIME) {
      this.velocity.y = TUNE.JUMP_SPEED;
      this._leaveGround();
      this._jumpBufferAt = -99;
      this.game.present.play('jump', { position: this.position, volume: 0.6 });
      this._emitNoise(0.6);
    }
  }

  _leaveGround() {
    this.grounded = false;
    this.moveState = 'air';
    this._airPeakY = this.position.y;
    this._lastGroundedAt = -99;
  }

  /**
   * Ledge detection. Three probes: a low forward ray to find the wall, a
   * downward ray past it to find the ledge top, and an upward ray on the ledge
   * to prove there is room to stand. Guarded so it can never become a climb.
   */
  _tryMantle() {
    const t = this.game.time;
    if (t < this._mantleCooldownUntil) return false;
    if (!this.grounded && this._mantleUsedInAir) return false;
    if (this.wishForward <= TUNE.SPRINT_MIN_FORWARD) return false; // must be pushing into it
    if (this.moveState === 'slide') return false;

    const world = this.game.world;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    _dirScratch.set(fx, 0, fz);

    // (a) wall in front, near-vertical.
    _v1.set(this.position.x, this.position.y + 0.30, this.position.z);
    const wall = world.raycast(_v1, _dirScratch, this.radius + TUNE.MANTLE_REACH);
    if (!wall || Math.abs(wall.normal.y) > 0.45) return false;

    // (b) ledge top, probing down just past the wall face.
    const reach = this.radius + 0.42;
    _v2.set(
      this.position.x + fx * reach,
      this.position.y + TUNE.MANTLE_MAX_H + 0.55,
      this.position.z + fz * reach,
    );
    const top = world.raycast(_v2, _DOWN, TUNE.MANTLE_MAX_H + 0.6);
    if (!top || top.normal.y < 0.6) return false;

    const h = top.point.y - this.position.y;
    if (h < TUNE.MANTLE_MIN_H || h > TUNE.MANTLE_MAX_H) return false;

    // (c) clearance above the ledge for a CROUCHED body — because that is the body we
    // now deliver.
    //
    // The original defect was real: this gate asked for crouch clearance and then handed
    // back a standing capsule, so a ledge with 1.3 m of headroom left the body embedded
    // in the ceiling (1,066 of 11,072 sampled landings) for `_depenetrate` to shove out.
    //
    // Raising the gate to STAND_HEIGHT fixed that and cost far more than it looked:
    // MERIDIAN's window openings are 1.35 m tall, so it silently deleted every
    // window-vault route on the map — 27 ledges, ten ground sills, ten first-floor sills,
    // the warehouse sills and the market-stall roofs. The map is built around those; the
    // author cut and glazed the openings deliberately.
    //
    // So keep the crouch gate and fix the real bug at the other end: crouch on commit
    // (see below). You pull through the window crouched and stand up when there is room,
    // which is what this threshold was always trying to express.
    _v3.set(top.point.x, top.point.y + 0.06, top.point.z);
    if (world.raycast(_v3, _UP, TUNE.CROUCH_HEIGHT + 0.15)) return false;

    // Commit — crouched.
    //
    // This is the half that was actually broken. The gate above only ever promised a
    // crouched body's worth of headroom, and `_mantleStep` never touched `height`, so the
    // climb delivered a 1.8 m capsule into a space cleared for 1.25 m. Crouching on
    // commit makes the delivered body match the space that was checked; `_updateStance`
    // and `_canStand` already handle standing back up the moment there is room, so this
    // costs nothing where the ledge is open and is exactly right where it is not.
    this.height = TUNE.CROUCH_HEIGHT;
    this.eyeHeight = this._eyeForHeight(this.height);
    this.moveState = 'mantle';
    this._mantleT = 0;
    this._mantleFrom.copy(this.position);
    this._mantleTo.set(
      top.point.x + fx * 0.18,
      top.point.y + 0.02,
      top.point.z + fz * 0.18,
    );
    this._mantleDir.set(fx, 0, fz);
    this.velocity.set(0, 0, 0);
    this.sprinting = false;
    this.lean = 0;
    this.slideAmount = 0;
    this._mantleUsedInAir = true;
    this.weapon?.stopFire?.();

    this.game.present.cameraStartMantle(this, TUNE.MANTLE_TIME, h);
    this.game.bus?.emit('mantle', { entity: this, height: h, duration: TUNE.MANTLE_TIME });
    this.game.present.play('land', { position: this.position, volume: 0.35, rate: 1.35 });
    this._emitNoise(0.6);
    return true;
  }

  _mantleStep(dt) {
    this._mantleT += dt / TUNE.MANTLE_TIME;
    const t = clamp(this._mantleT, 0, 1);

    // Vertical leads (ease-out), horizontal follows (ease-in) — you pop up onto
    // the lip and then step over it, which is what sells the hand-plant.
    const vy = 1 - (1 - t) * (1 - t);
    const hz = t * t * (3 - 2 * t) * t;   // smoothstep × t, biased late

    this.position.x = lerp(this._mantleFrom.x, this._mantleTo.x, hz);
    this.position.z = lerp(this._mantleFrom.z, this._mantleTo.z, hz);
    this.position.y = lerp(this._mantleFrom.y, this._mantleTo.y, vy);
    this.velocity.set(0, 0, 0);
    this.moveSpeed = 0;

    if (t >= 1) {
      this.moveState = 'ground';
      this.grounded = true;
      this._lastGroundedAt = this.game.time;
      this._airPeakY = this.position.y;
      this._mantleCooldownUntil = this.game.time + TUNE.MANTLE_COOLDOWN;
      this.velocity.set(
        this._mantleDir.x * TUNE.MANTLE_EXIT_SPEED, 0, this._mantleDir.z * TUNE.MANTLE_EXIT_SPEED,
      );
    }
  }

  // ═════════════════════════════════════════════════════════════════ motion ══

  _moveStep(dt) {
    const vel = this.velocity;
    const sliding = this.moveState === 'slide';

    // Wish direction in world space from yaw.
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const mf = this.wishForward, mr = this.wishRight;
    let wx = fx * mf + rx * mr;
    let wz = fz * mf + rz * mr;
    const wlen = Math.sqrt(wx * wx + wz * wz);
    if (wlen > 1e-4) { wx /= wlen; wz /= wlen; } else { wx = 0; wz = 0; }

    // Target speed for this stance/weapon/direction.
    let wishSpeed = 0;
    if (wlen > 1e-4) {
      wishSpeed = lerp(TUNE.WALK_SPEED, TUNE.SPRINT_SPEED, this.sprintRamp);
      wishSpeed = lerp(wishSpeed, TUNE.CROUCH_SPEED, this.crouchFrac);
      if (mf < -0.05) wishSpeed *= TUNE.BACK_MUL;
      else if (Math.abs(mf) < 0.05) wishSpeed *= TUNE.STRAFE_MUL;

      const mm = this._def.moveSpeedMul;
      if (typeof mm === 'number' && mm > 0) wishSpeed *= mm;
      if (this.adsAmount > 0) {
        const am = this._def.adsSpeedMul;
        wishSpeed *= lerp(1, (typeof am === 'number' && am > 0) ? am : WEAPON_FALLBACK.adsSpeedMul, this.adsAmount);
      }
      wishSpeed *= Math.min(1, wlen);
    }

    if (sliding) {
      this._slideStep(dt);
    } else if (this.grounded) {
      applyFriction(vel, TUNE.GROUND_FRICTION, TUNE.STOP_SPEED, dt);
      if (wishSpeed > 0) {
        // Acceleration scales with the speed target. Friction is always on, so a
        // FIXED acceleration would cap ground speed at accel/friction (5.4 u/s)
        // and sprint could never reach 7.2. Scaling keeps the quoted 65 u/s² at
        // walk speed and gives a constant time-to-top-speed at every stance.
        accelerate(vel, wx, wz, wishSpeed, TUNE.GROUND_ACCEL * (wishSpeed / TUNE.WALK_SPEED), dt);
      }
    } else if (wishSpeed > 0) {
      // Quake-style air control. A PURE lateral wish gets the CPMA treatment —
      // high accel against a tiny wishSpeed cap. That is the strafe-jump
      // projection: turning converts into speed, but only ~1 u/s per step.
      if (Math.abs(mf) < 0.02 && Math.abs(mr) > 0.02) {
        accelerate(vel, wx, wz, Math.min(wishSpeed, TUNE.AIR_STRAFE_WISH), TUNE.AIR_STRAFE_ACCEL, dt);
      } else {
        accelerate(vel, wx, wz, wishSpeed, TUNE.AIR_ACCEL * wishSpeed, dt);
      }
      const hs = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
      if (hs > TUNE.AIR_MAX_SPEED) {
        const k = TUNE.AIR_MAX_SPEED / hs;
        vel.x *= k; vel.z *= k;
      }
    }

    // Gravity is the caller's job per §5.
    if (!this.grounded || vel.y > 0) {
      vel.y += TUNE.GRAVITY * dt;
      if (vel.y < TUNE.TERMINAL) vel.y = TUNE.TERMINAL;
    } else {
      vel.y = -2; // keep us pinned to slopes/steps without accumulating fall speed
    }

    const wasGrounded = this.grounded;
    const prevY = this.position.y;
    const impactVy = vel.y;

    const res = this.game.world.move(this.position, vel, this.radius, this.height, dt);
    this.position.copy(res.position);
    vel.copy(res.velocity);
    this.grounded = res.grounded;
    if (res.groundNormal) this.groundNormal.copy(res.groundNormal);

    // Stair smoothing — the collision solver teleports us up, the camera lags
    // the visual eye behind it and catches up over ~90 ms.
    const dy = this.position.y - prevY;
    if (res.steppedUp) {
      this.addEyeStep(dy);
    } else if (wasGrounded && this.grounded && dy < -0.02 && dy > -0.6) {
      this.addEyeStep(dy);
    }

    if (this.grounded) {
      if (!wasGrounded) this._onLand(impactVy, prevY);
      this._lastGroundedAt = this.game.time;
      this._mantleUsedInAir = false;
      if (this.moveState !== 'slide') this.moveState = 'ground';
      this._airPeakY = this.position.y;
    } else {
      if (wasGrounded && this.moveState !== 'slide') {
        this.moveState = 'air';
        this._airPeakY = this.position.y;
      }
      if (this.position.y > this._airPeakY) this._airPeakY = this.position.y;
    }

    if (res.hitWall && this.moveState === 'slide') {
      // Scraping a wall kills a slide fast rather than sticking to it.
      this.slideTimer = Math.min(this.slideTimer, 0.12);
    }

    this.moveSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    this._updateFootsteps(dt);
  }

  _onLand(impactVy, prevY) {
    // Hard cap on horizontal speed the moment we touch down: bunny-hopping can
    // preserve speed but can never compound it.
    const hs = Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);
    if (hs > TUNE.LAND_SPEED_CAP) {
      const k = TUNE.LAND_SPEED_CAP / hs;
      this.velocity.x *= k;
      this.velocity.z *= k;
    }

    const impact = Math.max(0, -impactVy);
    const fall = Math.max(0, this._airPeakY - Math.min(prevY, this.position.y));

    this.addLandImpact(impact);
    if (impact > 1.4) {
      this.game.present.play('land', {
        position: this.position,
        volume: clamp(0.25 + impact / 16, 0.25, 1),
        rate: 1 - clamp(impact / 60, 0, 0.2),
      });
      this._emitNoise(clamp(impact / 12, 0.25, 1));
    }

    if (fall > TUNE.FALL_SAFE) {
      const t = clamp((fall - TUNE.FALL_SAFE) / (TUNE.FALL_LETHAL - TUNE.FALL_SAFE), 0, 1);
      const dmg = Math.round(TUNE.MAX_HEALTH * Math.pow(t, TUNE.FALL_CURVE));
      if (dmg > 0) this.applyDamage(dmg, { attacker: null, hitPart: 'limb', weaponId: 'fall' });
    }
    this._airPeakY = this.position.y;
  }

  // ══════════════════════════════════════════════════════════════ footsteps ══

  _updateFootsteps(dt) {
    if (!this.grounded || this.moveState === 'mantle') return;
    if (this.moveState === 'slide') return;   // sliding has its own scrape
    if (this.moveSpeed < 0.55) {
      // Prime the accumulator so the first step off a standstill lands quickly
      // (~0.6 m) rather than after a full stride.
      this._stepAccum = Math.max(this._stepAccum, this._stepDistance() * 0.72);
      return;
    }
    this._stepAccum += this.moveSpeed * dt;
    const d = this._stepDistance();
    if (this._stepAccum >= d) {
      this._stepAccum -= d;
      this._footstep();
    }
  }

  _stepDistance() {
    return lerp(TUNE.STEP_DISTANCE, TUNE.STEP_DISTANCE_CROUCH, this.crouchFrac);
  }

  _footstep() {
    // Surface directly beneath the feet decides the sample.
    let surface = 'concrete';
    _v1.set(this.position.x, this.position.y + 0.25, this.position.z);
    const hit = this.game.world?.raycast(_v1, _DOWN, 0.7);
    if (hit?.surface) surface = hit.surface;
    const soft = surface === 'dirt' || surface === 'sand';
    const name = soft ? 'footstepDirt' : 'footstepConcrete';

    // Stance decides both the mix level and how far the AI hears it.
    const crouched = this.crouchFrac > 0.6;
    const sprinting = this.sprintRamp > 0.5;
    const volume = crouched ? 0.20 : sprinting ? 1.0 : 0.62;
    const loudness = crouched ? 0 : sprinting ? 1.0 : 0.55;

    // Audio pitch variance only — presentation, so it draws from fxRng rather than
    // the gameplay stream. `_emitNoise` below is the sim-relevant part of a footstep.
    const rate = 0.94 + this.game.fxRng() * 0.12;
    this.game.present.play(name, { position: this.position, volume, rate });

    if (loudness > 0) this._emitNoise(loudness);
  }

  /**
   * Broadcast an audible event the AI can react to. The position is a fresh
   * vector because listeners keep it; noises are rare (a few per second at
   * most) so this never touches a per-frame allocation budget.
   */
  _emitNoise(loudness) {
    if (!(loudness > 0)) return;
    this.game.bus?.emit('noise', {
      type: 'footstep',
      entity: this,
      team: this.team,
      position: new THREE.Vector3(this.position.x, this.position.y, this.position.z),
      loudness,
    });
  }

  // ═══════════════════════════════════════════════════════════════════ lean ══

  _updateLean(dt) {
    const h = this._held;
    let dir = 0;
    const blocked = this.sprinting || this.moveState === 'slide' || this.moveState === 'mantle';
    if (!blocked && h.leanKeyHeld) {
      // One bind, two directions: the strafe keys pick the side while Q is held
      // (left is the default, matching the muscle memory of a single peek key).
      dir = h.leanRightKeyHeld ? 1 : -1;
    }

    let allowed = TUNE.LEAN_DIST;
    if (dir !== 0) {
      const rx = Math.cos(this.yaw) * dir, rz = -Math.sin(this.yaw) * dir;
      _dirScratch.set(rx, 0, rz);
      _v1.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
      const hit = this.game.world?.raycast(_v1, _dirScratch, TUNE.LEAN_DIST + TUNE.LEAN_CLEAR_PAD);
      if (hit) allowed = clamp(hit.distance - TUNE.LEAN_CLEAR_PAD, 0, TUNE.LEAN_DIST);
    }

    this.lean = damp(this.lean, dir * allowed, TUNE.LEAN_RATE, dt);
    if (Math.abs(this.lean) < 1e-4) this.lean = 0;
  }

  // ════════════════════════════════════════════════════════ weapon handling ══

  _updateWeapon() {
    const h = this._held;
    const t = this.game.time;
    const e = this._edge;
    this._refreshWeapon(false);
    const w = this.weapon;

    if (e.melee) this._melee();
    if (e.grenade) this._throwGrenade();
    if (e.killstreak) callAny(this.game.match, M_STREAK, this);
    if (e.inspect) this.game.bus?.emit('inspect', { entity: this });
    if (e.interact) this._interact();

    if (e.slot >= 0) this._switchSlot(e.slot);
    else if (e.lastWeapon || e.wheel !== 0) this._switchSlot(-1);

    if (!w) return;

    if (e.reload) w.reload?.();

    const canFire =
      this.alive &&
      this.moveState !== 'mantle' &&
      !this.sprinting &&
      t >= this._fireReadyAt;

    if (h.fireHeld && canFire) {
      w.tryFire?.();
      this._wasFiring = true;
    } else if (this._wasFiring && !h.fireHeld) {
      w.stopFire?.();
      this._wasFiring = false;
    } else if (!canFire && this._wasFiring) {
      w.stopFire?.();
      this._wasFiring = false;
    }
  }

  _switchSlot(slot) {
    const ws = this.game.weapons;
    if (!ws) return;
    const r = callAny(ws, M_SWITCH, this, slot);
    if (r && typeof r === 'object' && r.def) this.weapon = r;
    else this._refreshWeapon(false);
  }

  _interact() {
    const world = this.game.world;
    if (!world) return;
    this.getEyePosition(_v1);
    this.getAimDirection(_dirScratch);
    const hit = world.raycast(_v1, _dirScratch, 2.5);
    this.game.bus?.emit('interact', { entity: this, hit: hit ?? null });
  }

  /**
   * Throw the lethal. The pouch, the projectile spawn and the HUD update all belong
   * to the weapon system; we only own the cooldown and the feedback, so there is one
   * counter and one throw per press.
   */
  _throwGrenade() {
    const t = this.game.time;
    if (t < this._grenadeReadyAt || !this.alive) return;
    if (this.moveState === 'mantle') return;
    const ws = this.game.weapons;
    if (typeof ws?.throwGrenade !== 'function') return;
    if (!ws.throwGrenade(this, 'lethal', 1)) return;

    this._grenadeReadyAt = t + TUNE.GRENADE_COOLDOWN;
    this.game.present.play('pinPull', { volume: 0.8 });
    this.game.bus?.emit('grenadeThrow', { entity: this, remaining: this.grenades });
  }

  /**
   * Short heavy melee.
   *
   * We own the timing — cooldown, the fire lockout, the camera swipe — and nothing
   * else. The swing itself goes through `WeaponSystem.meleeAttack`, which resolves it
   * on the frame the blade actually crosses via `ballistics.meleeSweep` +
   * `applyMeleeDamage`. That matters because `applyMeleeDamage` is where
   * `damageScale()` runs, and `damageScale()` is the single gate for spawn protection,
   * the pre-round freeze and friendly fire. A hand-rolled sweep here duplicated the
   * search and skipped the gate, so a knife killed through spawn protection and before
   * the countdown had finished.
   */
  _melee() {
    const t = this.game.time;
    if (t < this._meleeReadyAt || !this.alive || this.moveState === 'mantle') return;
    this._meleeReadyAt = t + TUNE.MELEE_COOLDOWN;
    this._fireReadyAt = Math.max(this._fireReadyAt, t + TUNE.MELEE_LOCKOUT);

    this.game.bus?.emit('melee', { entity: this, shooter: this });
    this.game.present.cameraMeleeKick(this);

    // Audio, viewmodel swing and the gated hit all live behind this one call.
    if (typeof this.game.weapons?.meleeAttack === 'function') {
      this.game.weapons.meleeAttack(this);
      return;
    }

    // No weapon system yet (early boot): still scuff the wall so the swing reads.
    this.getEyePosition(_v1);
    this.getAimDirection(_dirScratch);
    const hit = this.game.world?.raycast(_v1, _dirScratch, TUNE.MELEE_RANGE);
    if (hit) {
      this.game.present.impact(hit.point, hit.normal, hit.surface);
      this.game.bus?.emit('impact', {
        point: hit.point, normal: hit.normal, surface: hit.surface, weaponId: 'melee',
      });
    }
  }

  // ═════════════════════════════════════════════════════════════════ health ══

  _updateHealth(dt) {
    if (!this.alive) return;
    if (this.health >= this.maxHealth) return;
    if (this.game.time - this._lastDamageAt < TUNE.REGEN_DELAY) return;
    this.health = Math.min(this.maxHealth, this.health + TUNE.REGEN_RATE * dt);
  }

  // ═══════════════════════════════════════════════════════════════ hitboxes ══

  /**
   * Boxes scale with the current (lerped) collision height so a crouching or
   * sliding player is genuinely a smaller target. The head also carries the
   * lean offset — peeking exposes you, as it must.
   *
   * `offset` is treated as LOCAL to the entity (the OBB is rotated by yaw per
   * §4), which is the only self-consistent reading for a non-zero lateral term.
   */
  _updateHitboxes() {
    const h = this.height;
    const k = h / TUNE.STAND_HEIGHT;
    const hb = this.hitboxes;

    hb[0].offset.set(this.lean, h * 0.922, 0);
    hb[0].size.set(0.30, 0.30 * k, 0.30);

    hb[1].offset.set(this.lean * 0.35, h * 0.611, 0);
    hb[1].size.set(0.56, 0.422 * h, 0.38);

    hb[2].offset.set(0, h * 0.20, 0);
    hb[2].size.set(0.52, 0.40 * h, 0.34);
  }

  dispose() {
    this.camera.dispose();
  }
}

export { TUNE as PLAYER_TUNE };

/**
 * What has to be saved to replay a tick on this player.
 *
 * Kept next to the class deliberately: the manifest only works if it is updated when a
 * field is added, and the odds of that improve when the two are in the same file. If you
 * add a field to the constructor, add it here too — and if you are not sure which list it
 * belongs in, `ignore` with a reason is a real answer, but silence is not. `audit()` in
 * scripts/determinism.mjs fails on any field that appears in neither.
 */
export const PLAYER_SNAPSHOT = defineSnapshot('Player', {
  vec3s: [
    'position', 'velocity', 'groundNormal', 'slideDir',
    // The mantle is a scripted interpolation between two fixed points; drop them and a
    // rewound mantle finishes somewhere else.
    '_mantleFrom', '_mantleTo', '_mantleDir',
  ],

  objects: {
    // Reused in place, so they must be copied key-by-key rather than by reference.
    stats: ['kills', 'deaths', 'score', 'streak'],
    _held: [
      'wishForward', 'wishRight', 'crouchHeld', 'toggleAdsMode', 'sprintKeyHeld',
      'breathHold', 'fireHeld', 'aimButtonHeld', 'leanKeyHeld', 'leanRightKeyHeld',
    ],
    _edge: [
      'jump', 'crouch', 'reload', 'melee', 'grenade', 'interact', 'inspect', 'killstreak',
      'lastWeapon', 'slot', 'sprintDown', 'sprintUp', 'fire', 'aim', 'wheel',
    ],
  },

  scalars: [
    'team', 'alive', 'health', 'armor',

    // Aim. `yaw`/`pitch` are recomposed by `_writeAngles` from the three below them, but
    // are stored anyway: they are what ballistics reads, and a restore that leaves them
    // stale for even one tick fires a bullet along the wrong line.
    'yaw', 'pitch',
    'baseYaw', 'basePitch',
    'recoilPitch', 'recoilYaw', 'recoilPitchTarget', 'recoilYawTarget',
    'scopeSwayYaw', 'scopeSwayPitch',
    'breath', 'breathHolding', 'breathGasp', 'scopeAim',
    // The interpolation endpoints. Only the renderer reads them, but they are written by
    // the tick, so a replay that skipped them would render differently from the original.
    'prevRecoilYaw', 'prevRecoilPitch', 'prevScopeSwayYaw', 'prevScopeSwayPitch',

    // Stance and the eye springs. The springs are simulation, not decoration: the eye
    // position IS the fire origin, so a missed spring moves where bullets come from.
    'height', 'eyeHeight', 'eyeSmooth', 'eyeStep', 'eyeLand', 'eyeLandVel',

    // Movement. `moveSpeed` and `crouchFrac` are recomputed every LIVE tick but not on
    // the dead path, and `moveSpeed` is force-zeroed while mantling, so they are state.
    'moveState', 'grounded', 'moveSpeed', 'wishForward', 'wishRight',
    'sprinting', 'sprintRamp', 'crouchHeld', 'crouchFrac',
    'slideAmount', 'slideTimer', 'lean',
    'wantsAds', 'adsToggle',
    '_grenadeFallback',

    // Deadlines. Floats in seconds compared against `game.time`, which is derived from
    // the integer tick and so is exactly reproducible. Coyote time turns on an epsilon
    // here — mispredict `_lastGroundedAt` and the player gets or loses a whole jump.
    '_lastGroundedAt', '_jumpBufferAt', '_slideCooldownUntil', '_mantleCooldownUntil',
    '_lastDamageAt', '_meleeReadyAt', '_grenadeReadyAt', '_fireReadyAt', '_deathAt',
    '_mantleUsedInAir', '_mantleT', '_airPeakY', '_stepAccum',

    '_sprintInterrupted', '_wasFiring',

    // Command bookkeeping. `_firePressedThisFrame` is genuinely sim-visible: Match reads
    // it to skip the respawn countdown and Killstreaks to confirm an airstrike, both
    // later in the same tick.
    '_localCrouchToggle', '_localToggleAdsMode', '_firePressedThisFrame',
  ],

  ignore: [
    'game',                 // system reference
    'camera',               // PlayerCamera — presentation only, never touches sim state
    'id', 'isPlayer', 'name',
    'radius', 'maxHealth',  // constants
    // Derived from height + lean — but NOT continuously: `_updateHitboxes` runs at the
    // end of a LIVE fixedUpdate only, so a corpse keeps standing-height boxes while
    // `_deadFixedUpdate` goes on shrinking `height`. Restoring height without recomputing
    // therefore leaves the boxes describing the wrong body. Harmless today (rayVsEntity
    // bails on !alive, and respawn recomputes), but a Phase 7 lag-comp rewind that
    // restores and immediately raycasts would test the current tick's volumes against a
    // rewound transform. Whoever rewinds must call `_updateHitboxes()` after restoring.
    'hitboxes',
    'weapon',               // a WeaponInstance reference; its state is WEAPON_SNAPSHOT,
                            // and which one is equipped lives in the loadout index
    '_cmdScratch',          // reused scratch for the locally built command
    '_lookFrame',           // gate against game.frame, which does not advance in a replay
  ],
});
