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

   RECOIL
     addRecoil(pitchKick, yawKick, punch) takes DEGREES for the two kicks and
     METRES for the punch — i.e. `weaponDefs.recoil.up / .side / .kick` can be
     passed straight through.
     RECOIL_SCALE     2.900    global multiplier (the review dial)
     RECOIL_SNAP     38.0      1/s — how fast the view reaches the new kick
     RECOIL_RECOVER   7.500    default 1/s return (overridden by def.recoil.recovery)
     RECOIL_PERMANENT 0.120    fraction of every kick that is NEVER recovered.
                               This is folded straight into the base aim angles,
                               so the recovered part returns EXACTLY to where the
                               player was aiming and only the permanent climb
                               remains — that is what makes a spray pattern real.

     SCALE and PERMANENT are a matched pair. What the player must FIGHT is
     `SCALE * PERMANENT * recoil.up` per shot; what the player FEELS is
     `SCALE * (1 - PERMANENT) * recoil.up`. The old 1.15 / 0.30 gave the VK-7
     a 0.60° total kick — 6 px on a 1080p screen, i.e. invisible — while the
     drift it demanded you correct was already right. So the pair was re-solved
     to hold the permanent term constant (0.345 × up, was 0.345 × up) and triple
     the transient: per-shot kick now runs 1.02° on the K-6 KESTREL up to 8.2°
     on the AX-70 REAVER, which is the whole point of having ten guns.
     RECOIL_MAX_DEG  22.0      per-call sanity clamp

   SCREEN SHAKE
     SHAKE_POS        0.060 m and SHAKE_ROLL 0.900° at amount 1.0, quadratic decay.

   IMPACT / STANCE
     LAND_K         165 / LAND_C 18.5   critically-ish damped landing spring
     LAND_GAIN        0.360 spring velocity per (m/s) of impact → a 6 m fall
                               dips the eye ~0.17 m; LAND_MAX 0.240 caps it
     STEP_SMOOTH     33.0      1/s — a stair step-up is hidden and caught up
                               over ~90 ms so the eye never jolts
     SLIDE_DIP        0.130 m extra camera drop while sliding
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

  RECOIL_SCALE: 2.9,
  RECOIL_SNAP: 38,
  RECOIL_RECOVER: 7.5,
  RECOIL_PERMANENT: 0.12,
  RECOIL_MAX_DEG: 22,
  PUNCH_GAIN: 31,
  PUNCH_K: 240,
  PUNCH_C: 22,
  PUNCH_MAX: 0.14,

  SHAKE_POS: 0.06,
  SHAKE_ROLL: 0.9,

  LAND_K: 165,
  LAND_C: 18.5,
  LAND_GAIN: 0.36,
  LAND_MAX: 0.24,
  LAND_MIN_IMPACT: 1.4,

  STEP_SMOOTH: 33,
  STEP_MAX: 0.55,

  SLIDE_DIP: 0.13,
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

  DAMAGE_PITCH: 2.6,
  DAMAGE_YAW: 2.2,
  DAMAGE_PUNCH: 0.035,

  ADS_POW: 2.4,
  VIEW_FOV_BASE: 70,
  VIEW_FOV_ADS: 62,
  FOV_RATE: 22,
  FOV_REF: 85,

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
const _lookDelta = { x: 0, y: 0 };

/** Snappy ease used for ADS — fast off the mark, settles into the sight. */
const adsEase = (t) => 1 - Math.pow(1 - t, T.ADS_POW);

/**
 * Owns the entire camera: mouse look, bob, sway, recoil, shake, stance tilt,
 * ADS field of view and the death camera. It is the only thing that writes to
 * `game.camera` and `engine.viewCamera`.
 *
 * Split of responsibilities:
 *  - `updateLook()`   — called exactly ONCE per rendered frame (pumped from the
 *                       first fixed substep by Player so that the same frame's
 *                       simulation already sees the new yaw). Mouse deltas are
 *                       therefore never divided across substeps and never
 *                       quantised to 120 Hz; a 500 Hz mouse's full accumulated
 *                       delta lands in one integration.
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

    // Authoritative player-controlled angles. `player.yaw/pitch` is always
    // these PLUS the un-recovered recoil offset, so what ballistics fires is
    // exactly what the screen shows.
    this.baseYaw = 0;
    this.basePitch = 0;

    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.recoilPitchTarget = 0;
    this.recoilYawTarget = 0;

    this.punch = 0;
    this.punchVel = 0;

    this.lagYaw = 0;
    this.lagPitch = 0;
    this._lookDX = 0;
    this._lookDY = 0;

    this.bobPhase = 0;
    this.bobAmp = 0;
    this.swayTime = 0;

    this.shakeAmp = 0;
    this.shakeTime = 0;
    this.shakeDur = 1;
    this.shakeSeed = 0;

    this.landOffset = 0;
    this.landVel = 0;
    this.stepOffset = 0;

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

    this._eyeVisual = player.eyeHeight;
  }

  reset() {
    this.baseYaw = this.player.yaw;
    this.basePitch = this.player.pitch;
    this.recoilPitch = this.recoilYaw = 0;
    this.recoilPitchTarget = this.recoilYawTarget = 0;
    this.punch = this.punchVel = 0;
    this.lagYaw = this.lagPitch = 0;
    this._lookDX = this._lookDY = 0;
    this.bobPhase = 0;
    this.bobAmp = 0;
    this.shakeAmp = 0;
    this.shakeTime = 0;
    this.landOffset = this.landVel = 0;
    this.stepOffset = 0;
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
    this._eyeVisual = this.player.eyeHeight;
  }

  setAngles(yaw, pitch) {
    this.baseYaw = yaw;
    this.basePitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.recoilPitch = this.recoilYaw = 0;
    this.recoilPitchTarget = this.recoilYawTarget = 0;
    this._writeAngles();
  }

  // ═══════════════════════════════════════════════════════════════════ look ══

  /**
   * Integrate mouse movement. Called once per rendered frame — never per fixed
   * step — so the input is applied at full mouse resolution.
   */
  updateLook() {
    const game = this.game;
    const input = game.input;
    input.consumeLook(_lookDelta);

    const playable = game.state === 'playing' && !game.paused && input.locked && this.player.alive;
    if (!playable) {
      // Drain and discard: re-entering the game must not replay stale motion.
      this._writeAngles();
      return;
    }

    const s = game.settings;
    // Zoom-compensated sensitivity. The ratio uses the ADS-only fov so that the
    // sprint/slide fov widen never changes how aiming feels.
    const baseFov = s.get('fov');
    const ratio = Math.tan(this.adsFovOnly * 0.5 * DEG) / Math.tan(baseFov * 0.5 * DEG);
    const adsMul = lerp(1, s.get('adsSensitivity'), clamp(this.player.adsAmount, 0, 1));
    const sens = T.SENS_BASE * s.get('sensitivity') * adsMul * ratio;

    const dYaw = -_lookDelta.x * sens;
    const dPitch = (s.get('invertY') ? _lookDelta.y : -_lookDelta.y) * sens;

    this.baseYaw += dYaw;
    this.basePitch = clamp(this.basePitch + dPitch, -PITCH_LIMIT, PITCH_LIMIT);

    // Keep yaw in a sane range so long sessions never lose float precision.
    if (this.baseYaw > Math.PI * 4) this.baseYaw -= Math.PI * 4;
    else if (this.baseYaw < -Math.PI * 4) this.baseYaw += Math.PI * 4;

    // Banked for the sway/lag pass, consumed once in update().
    this._lookDX += dYaw;
    this._lookDY += dPitch;

    this._writeAngles();
  }

  /** player.yaw/pitch = player intent + un-recovered recoil. */
  _writeAngles() {
    const p = this.player;
    p.yaw = this.baseYaw + this.recoilYaw;
    p.pitch = clamp(this.basePitch + this.recoilPitch, -PITCH_LIMIT, PITCH_LIMIT);
  }

  // ═════════════════════════════════════════════════════════════════ recoil ══

  /**
   * @param {number} pitchKick upward kick in DEGREES (weaponDefs `recoil.up`)
   * @param {number} yawKick   sideways kick in DEGREES (`recoil.side`, signed)
   * @param {number} punch     view punch in METRES (`recoil.kick`)
   */
  addRecoil(pitchKick, yawKick, punch = 0) {
    const maxK = T.RECOIL_MAX_DEG;
    const p = clamp(pitchKick || 0, -maxK, maxK) * DEG * T.RECOIL_SCALE;
    const y = clamp(yawKick || 0, -maxK, maxK) * DEG * T.RECOIL_SCALE;
    this._addRecoilRad(p, y, T.RECOIL_PERMANENT);
    if (punch) this.punchVel += clamp(punch, -0.5, 0.5) * T.PUNCH_GAIN;
  }

  /**
   * `permanentFrac` of the kick is written straight into the base aim angles
   * and therefore never recovers; the remainder decays back to zero, returning
   * the view to exactly where the player was pointing.
   */
  _addRecoilRad(pitchRad, yawRad, permanentFrac) {
    const f = clamp(permanentFrac, 0, 1);
    if (f > 0) {
      this.basePitch = clamp(this.basePitch + pitchRad * f, -PITCH_LIMIT, PITCH_LIMIT);
      this.baseYaw += yawRad * f;
    }
    this.recoilPitchTarget += pitchRad * (1 - f);
    this.recoilYawTarget += yawRad * (1 - f);
    // Never let a pathological burst throw the view past the pitch limit.
    this.recoilPitchTarget = clamp(this.recoilPitchTarget, -0.6, 0.6);
    this.recoilYawTarget = clamp(this.recoilYawTarget, -0.6, 0.6);
    this._writeAngles();
  }

  get _recoilRecovery() {
    const r = this.player.weapon?.def?.recoil?.recovery;
    return (typeof r === 'number' && r > 0.1) ? r : T.RECOIL_RECOVER;
  }

  // ══════════════════════════════════════════════════════════════ impulses ═══

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

  /** Stair step-up/down hiding. `dy` is the vertical teleport the solver did. */
  addStepOffset(dy) {
    this.stepOffset = clamp(this.stepOffset + dy, -T.STEP_MAX, T.STEP_MAX);
  }

  land(impactSpeed) {
    if (impactSpeed < T.LAND_MIN_IMPACT) return;
    this.landVel += impactSpeed * T.LAND_GAIN;
  }

  startSlide() {
    this.landVel += 1.1;               // a small dip as you drop into it
    this.shake(0.12, 0.18);
  }

  endSlide() { /* the tilt springs back on its own via damp() */ }

  startMantle(duration, height) {
    this.mantleT = 0;
    this.mantleDur = Math.max(0.05, duration);
    this.mantleSide = height > 1.0 ? 1 : -1;   // plant the far hand on tall ledges
  }

  meleeKick() { this.meleeT = 0; }

  /**
   * Flinch. Routed through the recoil system with ZERO permanent component, so
   * it genuinely moves your aim (the player can fight it) and then returns
   * exactly to where they were pointing.
   */
  damageKick(dirWorld, magnitude = 1) {
    const m = clamp(magnitude, 0, 1.6);
    // Lateral component of the attacker direction, in view space.
    const rx = Math.cos(this.baseYaw), rz = -Math.sin(this.baseYaw);
    const side = dirWorld ? clamp(dirWorld.x * rx + dirWorld.z * rz, -1, 1) : 0;
    // Punched AWAY from the damage: hit from the left, the view snaps right.
    this._addRecoilRad(T.DAMAGE_PITCH * DEG * m, -side * T.DAMAGE_YAW * DEG * m, 0);
    this.punchVel += T.DAMAGE_PUNCH * m * T.PUNCH_GAIN;
    this.shake(0.18 * m, 0.22);
  }

  startDeathCam(killerPos) {
    this.deathCam = true;
    this.deathT = 0;
    this.deathAngle = this.baseYaw + Math.PI;
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

  // ═══════════════════════════════════════════════════════════ simulation ════

  fixedUpdate(dt) {
    // Recoil lives on the fixed clock so that a spray pattern is identical at
    // 30 fps and 300 fps.
    const rec = this._recoilRecovery;
    this.recoilPitch = damp(this.recoilPitch, this.recoilPitchTarget, T.RECOIL_SNAP, dt);
    this.recoilYaw = damp(this.recoilYaw, this.recoilYawTarget, T.RECOIL_SNAP, dt);
    this.recoilPitchTarget = damp(this.recoilPitchTarget, 0, rec, dt);
    this.recoilYawTarget = damp(this.recoilYawTarget, 0, rec, dt);
    if (Math.abs(this.recoilPitchTarget) < 1e-5) this.recoilPitchTarget = 0;
    if (Math.abs(this.recoilYawTarget) < 1e-5) this.recoilYawTarget = 0;
    this._writeAngles();
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

    // ── landing spring + slide dip ──
    this.landVel += (-T.LAND_K * this.landOffset - T.LAND_C * this.landVel) * dt;
    this.landOffset = clamp(this.landOffset + this.landVel * dt, -0.06, T.LAND_MAX);
    const slideDip = T.SLIDE_DIP * p.slideAmount;

    // ── stair smoothing ──
    this.stepOffset = damp(this.stepOffset, 0, T.STEP_SMOOTH, dt);
    if (Math.abs(this.stepOffset) < 1e-4) this.stepOffset = 0;

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
    const worldLagYaw = this.lagYaw * T.SWAY_WORLD_FRAC;
    const worldLagPitch = this.lagPitch * T.SWAY_WORLD_FRAC;

    const yaw = p.yaw + worldLagYaw + idleYaw + meleeYaw;
    const pitch = clamp(
      p.pitch + worldLagPitch + idlePitch + bobPitch + mantlePitch,
      -PITCH_LIMIT - 0.05, PITCH_LIMIT + 0.05,
    );
    const roll = this.leanRoll + this.slideTilt + this.strafeRoll + bobRoll
      + shakeRoll + mantleRoll + meleeRoll;

    // Visual eye height gets its own smoothing on top of the simulated one so a
    // crouch transition reads as a body movement, not a teleport.
    this._eyeVisual = damp(this._eyeVisual, p.eyeHeight, 18, dt);

    _pos.set(
      p.position.x + rx * p.lean,
      p.position.y + this._eyeVisual - this.stepOffset - this.landOffset - slideDip,
      p.position.z + rz * p.lean,
    );

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
