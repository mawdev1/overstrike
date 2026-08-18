import * as THREE from 'three';
import {
  clamp, lerp, damp, DEG, PITCH_LIMIT, dirFromAngles, anglesFromDir,
} from '../core/mathUtils.js';

/* ════════════════════════════════════════════════════════════════════════════
   CAMERA TUNING TABLE — the "feel" constants. All angles in DEGREES here and
   converted once at use; all distances in metres; all rates in 1/s for `damp`.
   ────────────────────────────────────────────────────────────────────────────
   LOOK
     SENS_BASE        0.00130  rad per raw mouse pixel at sensitivity 1.0
                               (≈ 17 cm/360° at 800 DPI with the default 0.9)
     Pitch clamped to ±PITCH_LIMIT (1.5533 rad = 89°) from mathUtils.
     ADS sensitivity  settings.adsSensitivity, blended in by adsAmount, then
     multiplied by tan(fov/2) / tan(baseFov/2) so a degree of wrist movement
     covers the same on-screen distance zoomed or not. The sprint/slide FOV
     widen is deliberately EXCLUDED from that ratio — only ADS should retune
     sensitivity, otherwise sprinting would change your aim feel.

   VIEW BOB (figure-eight, lissajous 1:2)
     BOB_AMP          0.0340 m  peak lateral offset at walk speed
     BOB_WAVE         2.990 rad per metre travelled (one full 8 every ~2.1 m,
                               i.e. locked to the footstep cadence)
     BOB_ROLL         0.420°   roll component
     BOB_PITCH        0.220°   pitch component (runs at 2× the roll frequency)
     BOB_ADS_CUT      0.860    fraction of bob removed at full ADS
     BOB_CROUCH_MUL   0.550
     Subtlety is the point: peak displacement is ~3 cm and <0.5° of rotation.

   SWAY
     SWAY_IDLE        0.300°   low-frequency breathing drift (world camera)
     SWAY_IDLE_VIEW   1.150°   the same drift, amplified on the viewmodel
     SWAY_GAIN        0.350    radians of lag per radian of mouse movement
     SWAY_RECOVER    12.0      1/s return
     SWAY_MAX         0.105 rad (6°) clamp
     SWAY_WORLD_FRAC  0.100    only a tenth of the lag reaches the world camera,
                               so fast turns whip without adding real latency.

   RECOIL / SCOPE SWAY / BREATH
     All moved to `player.js` TUNE, alongside `_updateAim`/`_updateScopeSway` — they
     move player.yaw/pitch (the AIM ballistics fires along), so they had to become
     simulation, running on the fixed clock without a camera. `Player.addRecoil(...)`
     is the entry point (DEGREES for the two kicks, METRES for a punch it forwards
     here — `recoilPunch()` below — since the punch alone is genuinely decorative).
     What's left in this file's tuning is only the punch spring itself:
     PUNCH_GAIN/K/C/MAX — camera pushed back along its own -forward, never the aim.

   SCREEN SHAKE
     SHAKE_POS        0.060 m and SHAKE_ROLL 0.900° at amount 1.0, quadratic decay.

   IMPACT / STANCE
     The landing spring, the stair-step smoothing, the crouch eye-height catch-up
     and the slide dip are NOT here — they moved to `player.js` TUNE, because they
     move the EYE, and the eye is where bullets come from. See the note there.
     SLIDE_ROLL       6.500°  roll carved into the slide direction
     SLIDE_FOV        4.000°  fov widen at full slide
     SPRINT_ROLL      1.150°
     SPRINT_FOV       6.000°
     STRAFE_ROLL      0.550°
     LEAN_ROLL        7.000°  at full 0.32 m lean
     MANTLE_ROLL      5.500° / MANTLE_PITCH 4.500° — the hand-plant arc
     MELEE_ROLL       4.000° / MELEE_YAW 3.200° — the swipe

   ADS
     ADS_EASE         1 - (1-t)^2.4  (snappy, settles into the sight)
     VIEW_FOV_BASE   70.0 / VIEW_FOV_ADS 62.0 — the viewmodel camera stays wide
                               so the gun never fish-eyes when the world zooms.
     FOV_RATE        22.0      1/s smoothing on the sprint/slide fov widen only.
                               The ADS portion is NOT damped — it is driven
                               straight off adsAmount so a gun aims in exactly
                               its own `adsTime`.

   DEATH CAMERA
     DEATH_ORBIT      0.320 rad/s, DEATH_RADIUS 2.4 m, DEATH_HEIGHT 1.35 m,
     DEATH_ROLL       8.000°, all eased in exponentially from the moment of death.
   ════════════════════════════════════════════════════════════════════════════ */
const T = {
  SENS_BASE: 0.0013,

  BOB_AMP: 0.034,
  BOB_WAVE: 2.99,
  BOB_ROLL: 0.42,
  BOB_PITCH: 0.22,
  BOB_ADS_CUT: 0.86,
  BOB_CROUCH_MUL: 0.55,
  BOB_REF_SPEED: 4.6,
  BOB_RATE: 9,

  SWAY_IDLE: 0.3,
  SWAY_IDLE_VIEW: 1.15,
  SWAY_GAIN: 0.35,
  SWAY_RECOVER: 12,
  SWAY_MAX: 0.105,
  SWAY_WORLD_FRAC: 0.1,

  // RECOIL_SCALE/SNAP/RECOVER/PERMANENT/MAX_DEG moved to player.js TUNE — they move
  // the AIM (baseYaw/basePitch/recoilYaw/recoilPitch), not the camera. PUNCH_* stay
  // here: the recoil push-back spring is purely decorative, see `recoilPunch()`.
  PUNCH_GAIN: 31,
  PUNCH_K: 240,
  PUNCH_C: 22,
  PUNCH_MAX: 0.14,

  SHAKE_POS: 0.06,
  SHAKE_ROLL: 0.9,

  SLIDE_ROLL: 6.5,
  SLIDE_FOV: 4,
  SPRINT_ROLL: 1.15,
  SPRINT_FOV: 6,
  STRAFE_ROLL: 0.55,
  LEAN_ROLL: 7,
  LEAN_REF: 0.32,

  MANTLE_ROLL: 5.5,
  MANTLE_PITCH: 4.5,
  MANTLE_SHIFT: 0.07,

  MELEE_ROLL: 4,
  MELEE_YAW: 3.2,
  MELEE_TIME: 0.28,

  // DAMAGE_PITCH/YAW (the aim-moving flinch) moved to player.js TUNE. DAMAGE_PUNCH
  // stays: it's the camera-only punch reaction, see `damageFlinch()`.
  DAMAGE_PUNCH: 0.035,

  ADS_POW: 2.4,
  VIEW_FOV_BASE: 70,
  VIEW_FOV_ADS: 62,
  FOV_RATE: 22,
  FOV_REF: 85,

  // SCOPE_SWAY* / SCOPE_ADS_IN / BREATH_* moved to player.js TUNE with
  // `_updateScopeSway` — they move the AIM (scopeSwayYaw/Pitch), not the camera.

  DEATH_ORBIT: 0.32,
  DEATH_RADIUS: 2.4,
  DEATH_HEIGHT: 1.35,
  DEATH_ROLL: 8,
  DEATH_RATE: 4.5,
  DEATH_AIM_RATE: 3.2,
};

// ── module-scope scratch: this file allocates nothing per frame ─────────────
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _q = new THREE.Quaternion();
const _off = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _look = new THREE.Vector3();
const _angles = { yaw: 0, pitch: 0 };

/** Snappy ease used for ADS — fast off the mark, settles into the sight. */
const adsEase = (t) => 1 - Math.pow(1 - t, T.ADS_POW);

/**
 * Owns the entire camera: mouse look, bob, sway, recoil, shake, stance tilt,
 * ADS field of view and the death camera. It is the only thing that writes to
 * `game.camera` and `engine.viewCamera`.
 *
 * Split of responsibilities:
 *  - Mouse look is resolved by `Player._lookDeltaToRadians` (once per rendered frame,
 *    at full mouse resolution — never divided across fixed substeps) and applied here
 *    only via `_writeAngles()`, called from `Player.applyCommand`. This class does not
 *    read `game.input` itself.
 *  - `fixedUpdate(dt)`— recoil integration only. It runs at 1/120 alongside the
 *                       weapon that produced the kick, so spray patterns are
 *                       deterministic regardless of frame rate.
 *  - `update(dtFrame)`— everything visual, all of it frame-rate independent via
 *                       `damp`, then the final write to the two cameras.
 */
export class PlayerCamera {
  constructor(game, player) {
    this.game = game;
    this.player = player;

    // Aim (baseYaw/basePitch, recoil, scope sway) lives on `player` now — see
    // player.js TUNE's "aim state" note. This class only composes the RENDERED view of
    // it (interpolated recoil/sway, see `update()`) plus the genuinely decorative
    // terms below, none of which move a bullet.
    this.punch = 0;
    this.punchVel = 0;

    this.lagYaw = 0;
    this.lagPitch = 0;
    this._lookDX = 0;
    this._lookDY = 0;

    this.bobPhase = 0;
    this.bobAmp = 0;
    /** Time base for the low-frequency idle drift below — camera-only, faded out
     * through a scope by `feel`. NOT the scope sway itself, which moved to
     * `player.scopeSwayYaw/Pitch` (aim-affecting, so it needed the fixed clock and
     * `game.time` as its base instead — see `Player._updateScopeSway`). */
    this.swayTime = 0;

    this.shakeAmp = 0;
    this.shakeTime = 0;
    this.shakeDur = 1;
    this.shakeSeed = 0;


    this.slideTilt = 0;
    this.strafeRoll = 0;
    this.leanRoll = 0;
    this.mantleT = 1;
    this.mantleDur = 0.35;
    this.mantleSide = 1;
    this.meleeT = 1;

    this.worldFov = game.settings.get('fov');
    this.adsFovOnly = this.worldFov;
    this.fovWiden = 0;
    this.viewFov = T.VIEW_FOV_BASE;
    /** Published for the viewmodel, which owns `viewCamera.fov` — see `_updateFov`. */
    this.viewFovScale = 1;

    /** Published for the viewmodel: view-space sway in radians + recoil punch. */
    this.viewSwayYaw = 0;
    this.viewSwayPitch = 0;
    this.viewRoll = 0;

    this.deathCam = false;
    this.deathT = 0;
    this.deathAngle = 0;
    this.deathRoll = 0;
    this.deathYaw = 0;
    this.deathPitch = 0;
    this.deathPos = new THREE.Vector3();
    this.deathTarget = new THREE.Vector3();
    this.hasKiller = false;

  }

  reset() {
    this.punch = this.punchVel = 0;
    this.lagYaw = this.lagPitch = 0;
    this._lookDX = this._lookDY = 0;
    this.bobPhase = 0;
    this.bobAmp = 0;
    this.swayTime = 0;
    this.shakeAmp = 0;
    this.shakeTime = 0;
    this.slideTilt = 0;
    this.strafeRoll = 0;
    this.leanRoll = 0;
    this.mantleT = 1;
    this.meleeT = 1;
    this.worldFov = this.game.settings.get('fov');
    this.adsFovOnly = this.worldFov;
    this.fovWiden = 0;
    this.viewFov = T.VIEW_FOV_BASE;
    this.endDeathCam();
  }

  // ═══════════════════════════════════════════════════════════════════ look ══
  //
  // Mouse integration used to live here as `updateLook()`, reading `game.input`/
  // `game.settings` directly. It moved to `Player._lookDeltaToRadians`, which computes
  // the identical transform but writes the result into a command instead of mutating
  // `baseYaw`/`basePitch` itself — `Player.applyCommand` does that now, from
  // `cmd.deltaYaw`/`cmd.deltaPitch`, so a remote player's command (once one exists) is
  // indistinguishable from a local one by the time it reaches this class. Nothing here
  // reads `game.input`/`game.settings` any more.

  // ══════════════════════════════════════════════════════════════ impulses ═══
  //
  // Recoil and damage flinch are simulation now (see player.js `addRecoil`/
  // `damageKick`) — what's left here is the purely decorative reaction: the camera
  // push-back spring and shake, neither of which moves player.yaw/pitch.

  /** Camera push-back along its own -forward. METRES, see weaponDefs `recoil.kick`. */
  recoilPunch(punchMetres) {
    this.punchVel += clamp(punchMetres, -0.5, 0.5) * T.PUNCH_GAIN;
  }

  /** Explosions and heavy weapons. `amount` ~0..1.5, `duration` in seconds. */
  shake(amount, duration = 0.35) {
    const a = Math.abs(amount || 0);
    if (a <= 0) return;
    // Overlapping shakes take the stronger envelope rather than summing to mush.
    if (a >= this.shakeAmp * clamp(this.shakeTime / this.shakeDur, 0, 1)) {
      this.shakeAmp = a;
      this.shakeDur = Math.max(0.05, duration);
      this.shakeTime = this.shakeDur;
      this.shakeSeed = (this.shakeSeed + 17.13) % 1000;
    }
  }

  /** Alias so `fx.screenShake()` can route here verbatim. */
  screenShake(amount, duration) { this.shake(amount, duration); }

  startSlide() {
    // The dip as you drop into it is an eye spring and lives on the player; this is
    // just the kick that goes with it.
    this.shake(0.12, 0.18);
  }

  endSlide() { /* the tilt springs back on its own via damp() */ }

  startMantle(duration, height) {
    this.mantleT = 0;
    this.mantleDur = Math.max(0.05, duration);
    this.mantleSide = height > 1.0 ? 1 : -1;   // plant the far hand on tall ledges
  }

  meleeKick() { this.meleeT = 0; }

  /** Camera-only reaction to taking damage: a punch (view space, toward the attacker's
   * side) plus a shake. The aim-moving part of a flinch is `player.damageKick()`. */
  damageFlinch(magnitude = 1) {
    const m = clamp(magnitude, 0, 1.6);
    this.punchVel += T.DAMAGE_PUNCH * m * T.PUNCH_GAIN;
    this.shake(0.18 * m, 0.22);
  }

  startDeathCam(killerPos) {
    this.deathCam = true;
    this.deathT = 0;
    this.deathAngle = this.player.baseYaw + Math.PI;
    this.deathYaw = this.player.yaw;
    this.deathPitch = this.player.pitch;
    this.deathRoll = 0;
    this.player.getEyePosition(this.deathPos);
    this.hasKiller = !!killerPos;
    if (killerPos) this.deathTarget.set(killerPos.x, killerPos.y + 1.1, killerPos.z);
    else {
      dirFromAngles(this.player.yaw, 0, _look);
      this.deathTarget.copy(this.player.position).addScaledVector(_look, 4).setY(this.player.position.y + 1.1);
    }
  }

  endDeathCam() {
    this.deathCam = false;
    this.deathT = 0;
  }

  // ═════════════════════════════════════════════════════════════════ visual ══

  update(dt) {
    const p = this.player;
    const game = this.game;
    if (!p || game.state === 'boot') return;

    this.swayTime += dt;
    this._updateFov(dt);

    if (this.deathCam) {
      this._updateDeathCam(dt);
      return;
    }

    // ── mouse-driven lag (consume the frame's applied look delta) ──
    this.lagYaw = damp(this.lagYaw, 0, T.SWAY_RECOVER, dt) - this._lookDX * T.SWAY_GAIN;
    this.lagPitch = damp(this.lagPitch, 0, T.SWAY_RECOVER, dt) - this._lookDY * T.SWAY_GAIN;
    this.lagYaw = clamp(this.lagYaw, -T.SWAY_MAX, T.SWAY_MAX);
    this.lagPitch = clamp(this.lagPitch, -T.SWAY_MAX, T.SWAY_MAX);
    this._lookDX = 0;
    this._lookDY = 0;

    // ── low-frequency idle drift ──
    const adsCut = 1 - clamp(p.adsAmount, 0, 1) * 0.8;
    const dr1 = Math.sin(this.swayTime * 0.73) * Math.cos(this.swayTime * 0.41);
    const dr2 = Math.sin(this.swayTime * 0.53 + 1.7);
    const idleYaw = dr1 * T.SWAY_IDLE * DEG * adsCut;
    const idlePitch = dr2 * T.SWAY_IDLE * 0.7 * DEG * adsCut;

    // ── figure-eight view bob, locked to distance travelled ──
    const grounded = p.grounded && p.moveState !== 'mantle';
    const speed = p.moveSpeed;
    if (grounded && speed > 0.4) this.bobPhase += speed * T.BOB_WAVE * dt;
    const stance = lerp(1, T.BOB_CROUCH_MUL, p.crouchFrac) * (1 - p.slideAmount * 0.85);
    const targetAmp = (grounded && speed > 0.4)
      ? T.BOB_AMP * clamp(speed / T.BOB_REF_SPEED, 0, 1.6) * stance * (1 - clamp(p.adsAmount, 0, 1) * T.BOB_ADS_CUT)
      : 0;
    this.bobAmp = damp(this.bobAmp, targetAmp, T.BOB_RATE, dt);
    const bobK = this.bobAmp / T.BOB_AMP;
    const bobX = Math.sin(this.bobPhase) * this.bobAmp;
    const bobY = Math.sin(this.bobPhase * 2) * this.bobAmp * 0.55;
    const bobRoll = Math.sin(this.bobPhase) * T.BOB_ROLL * DEG * bobK;
    const bobPitch = Math.sin(this.bobPhase * 2) * T.BOB_PITCH * DEG * bobK;

    // ── recoil punch spring (camera pushed back along its own -forward) ──
    this.punchVel += (-T.PUNCH_K * this.punch - T.PUNCH_C * this.punchVel) * dt;
    this.punch = clamp(this.punch + this.punchVel * dt, -T.PUNCH_MAX, T.PUNCH_MAX);

    // ── screen shake ──
    let shakeX = 0, shakeY = 0, shakeRoll = 0;
    if (this.shakeTime > 0) {
      this.shakeTime -= dt;
      const k = clamp(this.shakeTime / this.shakeDur, 0, 1);
      const a = this.shakeAmp * k * k;
      const st = (this.shakeDur - this.shakeTime) + this.shakeSeed;
      shakeX = Math.sin(st * 61.7) * Math.sin(st * 23.1) * a * T.SHAKE_POS;
      shakeY = Math.sin(st * 47.3 + 1.9) * a * T.SHAKE_POS;
      shakeRoll = Math.sin(st * 39.1 + 0.7) * a * T.SHAKE_ROLL * DEG;
      if (this.shakeTime <= 0) { this.shakeTime = 0; this.shakeAmp = 0; }
    }

    // ── stance roll: lean + slide carve + sprint + strafe bank ──
    const leanFrac = clamp(p.lean / T.LEAN_REF, -1, 1);
    this.leanRoll = damp(this.leanRoll, -leanFrac * T.LEAN_ROLL * DEG, 14, dt);

    const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
    let slideLateral = 0;
    if (p.slideAmount > 0) {
      slideLateral = clamp((p.slideDir.x * rx + p.slideDir.z * rz) * 2.2, -1, 1);
    }
    const slideRollTarget = -(slideLateral * 0.65 + p.wishRight * 0.35) * T.SLIDE_ROLL * DEG * p.slideAmount;
    this.slideTilt = damp(this.slideTilt, slideRollTarget, 9, dt);

    const strafeTarget = -p.wishRight * T.STRAFE_ROLL * DEG
      - p.wishRight * T.SPRINT_ROLL * DEG * p.sprintRamp;
    this.strafeRoll = damp(this.strafeRoll, strafeTarget, 7, dt);

    // ── mantle hand-plant ──
    let mantleRoll = 0, mantlePitch = 0, mantleShift = 0;
    if (this.mantleT < 1) {
      this.mantleT = Math.min(1, this.mantleT + dt / this.mantleDur);
      const arc = Math.sin(this.mantleT * Math.PI);
      mantleRoll = arc * T.MANTLE_ROLL * DEG * this.mantleSide;
      mantlePitch = -arc * T.MANTLE_PITCH * DEG;
      mantleShift = arc * T.MANTLE_SHIFT * this.mantleSide;
    }

    // ── melee swipe ──
    let meleeRoll = 0, meleeYaw = 0;
    if (this.meleeT < 1) {
      this.meleeT = Math.min(1, this.meleeT + dt / T.MELEE_TIME);
      const a = Math.sin(this.meleeT * Math.PI) * (1 - this.meleeT * 0.35);
      meleeRoll = -a * T.MELEE_ROLL * DEG;
      meleeYaw = a * T.MELEE_YAW * DEG;
    }

    // ── compose ──
    // Everything in these two sums is a FEEL term: it moves the camera without moving
    // the aim, so it is also, strictly, a lie about where the bullet is going. At 85°
    // that lie is a fraction of the crosshair's own gap and nobody can see it. Behind a
    // 6× scope, one twentieth of a degree is 2.5 px and the reticle visibly does not
    // agree with the impact — so the whole lot is faded out as the sight picture
    // arrives. The wander the scope needs instead comes from `Player._updateScopeSway`,
    // which moves the AIM, and therefore moves the camera and the bullet together.
    const feel = 1 - clamp(p.scopeAim, 0, 1);
    const worldLagYaw = this.lagYaw * T.SWAY_WORLD_FRAC;
    const worldLagPitch = this.lagPitch * T.SWAY_WORLD_FRAC;

    // Recoil and scope sway update on the 120 Hz fixed clock; rendering can run well
    // past that. Reading `p.yaw`/`p.pitch` straight would stair-step the fastest-moving
    // thing on screen during a spray. Interpolating the WHOLE angle would add a tick of
    // latency to mouse look, which is unacceptable — so only the recoil+sway component
    // is interpolated, between what it was at the end of the previous tick
    // (`prevRecoilYaw` etc.) and what it is now, by how far the render clock has drifted
    // past the last tick (`game.accumAlpha`). `baseYaw`/`basePitch` (mouse) are added
    // fresh, at full resolution, un-interpolated.
    //
    // Scoped weapons render un-interpolated (alpha=1): a sniper's recoil is one large
    // kick, not a spray, so the un-smoothed tick value is invisible as a stair-step and
    // sway is slow enough that 120 Hz sampling is already smooth — while an
    // interpolated reticle would visibly disagree with the impact through the scope,
    // which is exactly the lie `feel` above exists to prevent.
    const alpha = this.player.weapon?.def?.scoped ? 1 : game.accumAlpha;
    const aimYaw = p.baseYaw + lerp(p.prevRecoilYaw + p.prevScopeSwayYaw, p.recoilYaw + p.scopeSwayYaw, alpha);
    const aimPitch = clamp(
      p.basePitch + lerp(p.prevRecoilPitch + p.prevScopeSwayPitch, p.recoilPitch + p.scopeSwayPitch, alpha),
      -PITCH_LIMIT, PITCH_LIMIT,
    );

    const yaw = aimYaw + (worldLagYaw + idleYaw + meleeYaw) * feel;
    const pitch = clamp(
      aimPitch + (worldLagPitch + idlePitch + bobPitch + mantlePitch) * feel,
      -PITCH_LIMIT - 0.05, PITCH_LIMIT + 0.05,
    );
    const roll = this.leanRoll + this.slideTilt + this.strafeRoll + bobRoll
      + shakeRoll + mantleRoll + meleeRoll;

    // The eye itself is simulation, not presentation: `Player` integrates the crouch
    // smoothing, the stair step and the landing spring on the fixed step, and
    // `getEyePosition()` composes them. Rendering from exactly that point is what makes
    // the crosshair honest — it is also where `weaponSystem.getFireOrigin` starts the
    // bullet, so the two cannot disagree.
    //
    // What is left below is the genuinely decorative part — bob, shake, mantle shift and
    // punch — which stays camera-only and never moves the bullet. Bob and shake already
    // scale down with ADS (BOB_ADS_CUT, adsCut), so the disagreement is smallest exactly
    // when precision matters.
    p.getEyePosition(_pos);

    _e.set(pitch, yaw, roll, 'YXZ');
    _q.setFromEuler(_e);
    _off.set(bobX + shakeX + mantleShift, bobY + shakeY, this.punch);
    _off.applyQuaternion(_q);
    _pos.add(_off);

    this._writeCameras(_pos, _e, _q, roll, idleYaw, idlePitch);
    game.audio?.setListener?.(_pos, _fwd, _up);
  }

  _updateFov(dt) {
    const s = this.game.settings;
    const p = this.player;
    const engine = this.game.engine;
    const baseFov = s.get('fov');

    const ads = clamp(p.adsAmount, 0, 1);
    const e = adsEase(ads);
    // Driven DIRECTLY off the eased ads amount, not damped: `adsAmount` already
    // ramps over the weapon's adsTime, and adding a second smoothing stage here
    // would make every gun feel slower to aim than its own stat sheet says.
    this.adsFovOnly = lerp(baseFov, p.adsFov, e);

    // Only the stance widen is smoothed — it has no authored duration of its own.
    const widen = (T.SPRINT_FOV * p.sprintRamp + T.SLIDE_FOV * p.slideAmount) * (1 - ads);
    this.fovWiden = damp(this.fovWiden, this.deathCam ? 0 : widen, T.FOV_RATE, dt);
    this.worldFov = this.deathCam ? baseFov : this.adsFovOnly + this.fovWiden;
    engine?.setRenderFov?.(this.worldFov);

    // The viewmodel camera stays wide so the gun never fish-eyes; it only
    // narrows a little on ADS so the sight still fills the screen.
    //
    // OWNERSHIP: the viewmodel writes `viewCamera.fov` itself, because only it knows
    // the equipped weapon's `vmFovAds` (a 6x scope pulls the model in much further
    // than a red dot). We publish the player's fov-setting scale for it to apply, and
    // only drive the camera ourselves when no viewmodel is up — otherwise the two
    // systems would overwrite each other every frame and the near-plane clip on a
    // scoped weapon would flicker.
    this.viewFovScale = 1 + (baseFov - T.FOV_REF) / T.FOV_REF * 0.35;
    this.viewFov = lerp(T.VIEW_FOV_BASE, T.VIEW_FOV_ADS, e) * this.viewFovScale;
    const vc = engine?.viewCamera;
    if (vc && !this.game.weapons?.viewmodel?.current && Math.abs(vc.fov - this.viewFov) > 0.01) {
      vc.fov = this.viewFov;
      vc.updateProjectionMatrix();
    }
  }

  _updateDeathCam(dt) {
    const p = this.player;
    this.deathT += dt;

    // Ease out and away from the body while orbiting slowly toward the killer.
    const grow = 1 - Math.exp(-this.deathT * 1.1);
    const a = this.deathAngle + this.deathT * T.DEATH_ORBIT;
    const r = T.DEATH_RADIUS * grow;
    _look.set(
      p.position.x + Math.sin(a) * r,
      p.position.y + lerp(p.eyeHeight, T.DEATH_HEIGHT, grow),
      p.position.z + Math.cos(a) * r,
    );
    const k = 1 - Math.exp(-T.DEATH_RATE * dt);
    this.deathPos.x += (_look.x - this.deathPos.x) * k;
    this.deathPos.y += (_look.y - this.deathPos.y) * k;
    this.deathPos.z += (_look.z - this.deathPos.z) * k;

    // Look at the killer if we know one, otherwise back at our own corpse.
    if (this.hasKiller) _look.copy(this.deathTarget);
    else _look.set(p.position.x, p.position.y + 0.9, p.position.z);
    _look.sub(this.deathPos);
    if (_look.lengthSq() < 1e-6) _look.set(0, 0, -1);
    else _look.normalize();
    anglesFromDir(_look, _angles);

    const ka = 1 - Math.exp(-T.DEATH_AIM_RATE * dt);
    this.deathYaw += (_angles.yaw - this.deathYaw
      - Math.round((_angles.yaw - this.deathYaw) / (Math.PI * 2)) * Math.PI * 2) * ka;
    this.deathPitch += (_angles.pitch - this.deathPitch) * ka;
    this.deathRoll = damp(this.deathRoll, T.DEATH_ROLL * DEG, 1.5, dt);

    _e.set(this.deathPitch, this.deathYaw, this.deathRoll, 'YXZ');
    _q.setFromEuler(_e);
    _pos.copy(this.deathPos);
    this._writeCameras(_pos, _e, _q, this.deathRoll, 0, 0);
    this.game.audio?.setListener?.(_pos, _fwd, _up);
  }

  /**
   * Final write. The world camera gets the composed transform; the viewmodel
   * camera sits at the origin of its own scene with the SAME orientation plus
   * the full (un-attenuated) sway lag, which is what makes the gun trail behind
   * a fast turn.
   */
  _writeCameras(pos, euler, quat, roll, idleYaw, idlePitch) {
    const cam = this.game.camera ?? this.game.engine?.camera;
    if (cam) {
      cam.position.copy(pos);
      cam.rotation.set(euler.x, euler.y, euler.z);
      cam.updateMatrixWorld();
    }

    // Sway applied only to the viewmodel: the remaining 90% of the mouse lag
    // that the world camera did not take, plus the amplified idle drift.
    const idleBoost = (T.SWAY_IDLE_VIEW - T.SWAY_IDLE) / T.SWAY_IDLE;
    this.viewSwayYaw = this.lagYaw * (1 - T.SWAY_WORLD_FRAC) + idleYaw * idleBoost;
    this.viewSwayPitch = this.lagPitch * (1 - T.SWAY_WORLD_FRAC) + idlePitch * idleBoost;
    this.viewRoll = roll;

    const vc = this.game.engine?.viewCamera;
    if (vc) {
      vc.position.set(0, 0, 0);
      vc.rotation.set(
        euler.x + this.viewSwayPitch,
        euler.y + this.viewSwayYaw,
        euler.z,
      );
      vc.updateMatrixWorld();
    }

    _fwd.set(0, 0, -1).applyQuaternion(quat);
    _up.set(0, 1, 0).applyQuaternion(quat);
  }

  dispose() { /* nothing retained */ }
}

export { T as CAMERA_TUNE };
