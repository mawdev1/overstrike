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

  // SCOPE — see `_updateScopeSway`. Amplitude is in DEGREES at full magnification and
  // is scaled per weapon by `def.scopeSwayMul`.
  SCOPE_SWAY: 0.36,
  SCOPE_SWAY_RATE: 8,
  SCOPE_ADS_IN: 0.40,        // adsAmount at which scope sway starts to come in
  BREATH_HOLD_MUL: 0.13,     // sway multiplier while the breath is held
  BREATH_GASP_MUL: 2.10,     // and immediately after it runs out
  BREATH_GASP_TIME: 1.10,
  BREATH_REFILL: 0.60,       // refill rate as a fraction of the drain rate

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

    // ── scope hold ──
    // Scope sway is folded into `_writeAngles`, i.e. into the AIM, not into the camera
    // on top of the aim. That is not a detail: `ballistics` fires along `player.yaw/
    // pitch`, so sway added to the camera alone would put the reticle somewhere the
    // bullet does not go. Sway the aim and the two can never disagree.
    this.scopeSwayYaw = 0;
    this.scopeSwayPitch = 0;
    /** 1 = a full lungful, 0 = out of breath. Published for the HUD's breath meter. */
    this.breath = 1;
    this.breathHolding = false;
    this.breathGasp = 0;
    /**
     * 0..1 — how much of the sight picture is up, as far as the camera is concerned.
     * Fades out the feel-only camera offsets so that behind glass, screen centre IS the
     * bullet path. See the `feel` term in `update()`.
     */
    this.scopeAim = 0;

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
    this.slideTilt = 0;
    this.strafeRoll = 0;
    this.leanRoll = 0;
    this.mantleT = 1;
    this.meleeT = 1;
    this.scopeSwayYaw = this.scopeSwayPitch = 0;
    this.scopeAim = 0;
    this.breath = 1;
    this.breathHolding = false;
    this.breathGasp = 0;
    this.worldFov = this.game.settings.get('fov');
    this.adsFovOnly = this.worldFov;
    this.fovWiden = 0;
    this.viewFov = T.VIEW_FOV_BASE;
    this.endDeathCam();
    this.swayTime = 0;
  }

  setAngles(yaw, pitch) {
    this.baseYaw = yaw;
    this.basePitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    this.recoilPitch = this.recoilYaw = 0;
    this.recoilPitchTarget = this.recoilYawTarget = 0;
    this.scopeSwayYaw = this.scopeSwayPitch = 0;
    this._writeAngles();
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

  /** player.yaw/pitch = player intent + un-recovered recoil + scope sway. */
  _writeAngles() {
    const p = this.player;
    p.yaw = this.baseYaw + this.recoilYaw + this.scopeSwayYaw;
    p.pitch = clamp(this.basePitch + this.recoilPitch + this.scopeSwayPitch, -PITCH_LIMIT, PITCH_LIMIT);
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
    this._updateScopeSway(dt);

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
    // arrives. The wander the scope needs instead comes from `_updateScopeSway`, which
    // moves the AIM, and therefore moves the camera and the bullet together.
    const feel = 1 - clamp(this.scopeAim, 0, 1);
    const worldLagYaw = this.lagYaw * T.SWAY_WORLD_FRAC;
    const worldLagPitch = this.lagPitch * T.SWAY_WORLD_FRAC;

    const yaw = p.yaw + (worldLagYaw + idleYaw + meleeYaw) * feel;
    const pitch = clamp(
      p.pitch + (worldLagPitch + idlePitch + bobPitch + mantlePitch) * feel,
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

  /**
   * Scoped-weapon hold: the low-frequency wander of a rifle held against a shoulder,
   * and the breath you hold to stop it.
   *
   * `weaponDefs` has carried `scopeSwayMul` and `breathHoldTime` since the guns were
   * authored; this is what finally reads them. Amplitude is deliberately modest — at the
   * REAVER's 22° field of view, 0.36° × 1.6 is about 2 % of the screen height, enough to
   * make a 200 m headshot a decision rather than a formality, small enough that it never
   * feels like the rifle is fighting you.
   *
   * Holding the sprint key while scoped holds your breath (the sprint key is otherwise
   * dead in this state — sprinting cancels ADS). Run the lungs dry and you gasp: sway
   * spikes above baseline for a second, so spamming it is worse than timing it.
   */
  _updateScopeSway(dt) {
    const p = this.player;
    const game = this.game;
    const def = p.weapon?.def;
    const scoped = !!def?.scoped
      && p.alive && !this.deathCam && !game.paused && game.state === 'playing';

    // Everything below this line is scoped-only. Off the sniper it is one property
    // chain and a compare, then a decay that reaches exact zero and stops.
    if (!scoped) {
      this.scopeAim = 0;
      if (this.scopeSwayYaw === 0 && this.scopeSwayPitch === 0 && this.breath === 1
        && this.breathGasp === 0) return;
      this.breathHolding = false;
      this.breathGasp = Math.max(0, this.breathGasp - dt);
      this.breath = Math.min(1, this.breath + dt * 0.7);
      this.scopeSwayYaw = damp(this.scopeSwayYaw, 0, T.SCOPE_SWAY_RATE, dt);
      this.scopeSwayPitch = damp(this.scopeSwayPitch, 0, T.SCOPE_SWAY_RATE, dt);
      if (Math.abs(this.scopeSwayYaw) < 1e-6) this.scopeSwayYaw = 0;
      if (Math.abs(this.scopeSwayPitch) < 1e-6) this.scopeSwayPitch = 0;
      this._writeAngles();
      return;
    }

    const amt = clamp((clamp(p.adsAmount, 0, 1) - T.SCOPE_ADS_IN) / (1 - T.SCOPE_ADS_IN), 0, 1);
    this.scopeAim = amt;

    // ── breath ──
    const holdTime = Math.max(0.4, def.breathHoldTime || 2.5);
    const wantHold = amt > 0.5 && !!game.input?.isDown?.('sprint');
    if (wantHold && this.breath > 0) {
      this.breathHolding = true;
      this.breath = Math.max(0, this.breath - dt / holdTime);
      if (this.breath <= 0) this.breathGasp = T.BREATH_GASP_TIME;
    } else {
      this.breathHolding = false;
      this.breath = Math.min(1, this.breath + dt * T.BREATH_REFILL / holdTime);
      this.breathGasp = Math.max(0, this.breathGasp - dt);
    }

    // ── sway ──
    const gasp = lerp(1, T.BREATH_GASP_MUL, clamp(this.breathGasp / T.BREATH_GASP_TIME, 0, 1));
    const hold = this.breathHolding ? T.BREATH_HOLD_MUL : 1;
    const a = T.SCOPE_SWAY * DEG * amt * (def.scopeSwayMul ?? 1) * hold * gasp;
    const t = this.swayTime;
    // Two incommensurable frequencies per axis: the drift never repeats, so it cannot
    // be learned and timed the way a single sine can.
    const ty = (Math.sin(t * 0.61) * 0.70 + Math.sin(t * 1.43 + 2.1) * 0.30) * a;
    const tp = (Math.sin(t * 0.87 + 1.1) * 0.65 + Math.sin(t * 1.97 + 0.4) * 0.35) * a * 0.78;
    this.scopeSwayYaw = damp(this.scopeSwayYaw, ty, T.SCOPE_SWAY_RATE, dt);
    this.scopeSwayPitch = damp(this.scopeSwayPitch, tp, T.SCOPE_SWAY_RATE, dt);
    this._writeAngles();
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
