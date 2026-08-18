import * as THREE from 'three';
import { clamp, damp, lerp, smoothstep, DEG } from '../core/mathUtils.js';
import { ATMOSPHERE } from '../core/assets.js';

/**
 * OVERSTRIKE — telescopic sight picture.
 *
 * ── WHY THIS IS AN OVERLAY AND NOT A PICTURE-IN-PICTURE ───────────────────────
 * A "real" scope is a second camera rendering the world through the ocular lens into a
 * render target. It costs one extra scene traversal per frame: another ~200 draw calls,
 * another frustum cull, another full vertex+fragment pass, and — because the viewpoint
 * is a few centimetres from the main camera and the FOV is tiny — it produces an image
 * that is *pixel for pixel indistinguishable* from simply narrowing the main camera's
 * FOV. §11 budgets 220 draw calls for the entire frame; a PiP would blow that on its own
 * for zero visible gain.
 *
 * So the main camera provides the magnification (it already does — `adsFov` is 22° on the
 * REAVER, a genuine 4.7× over the 85° default) and this module supplies everything that
 * makes a magnified image read as *glass*: the circular aperture, the scope body outside
 * it, the eye-relief shadow that slides around as the rifle breathes, lateral colour
 * error at the edge of the lens, and a glint when the objective catches the sun. This is
 * exactly what Call of Duty and Battlefield do, and for exactly this reason.
 *
 * ── WHERE THE WORK HAPPENS ───────────────────────────────────────────────────
 * Nowhere new. The composite pass (`engine.js`) is the ONLY fullscreen blit at the end of
 * the frame — it owns bloom compositing, tone mapping and the output transfer as well —
 * and the sight picture is folded into it behind a *uniform* branch, so when `uScope` is
 * 0 the block is skipped by every fragment coherently and the scope costs literally
 * nothing: no extra pass, no extra render target, no extra bandwidth. Measured at 0.00 ms
 * un-scoped and ~0.07-0.13 ms scoped at 1600x900 on an RX 7600 XT (scripts/scopeshot.mjs
 * A/B's the shader branch against itself with everything else held identical).
 *
 * The reticle itself is NOT drawn here. It lives in the HUD as an SVG (see `hud.js`),
 * because the composer runs at `renderScale` — at 0.6 a shader-drawn reticle would be
 * resampled and soft, and a reticle you cannot see a hairline of is not a reticle. The
 * HUD draws it at native device resolution, dead centre, at a fixed screen size that does
 * not scale with the view. Both agree on the aperture because both express it in screen
 * HALF-HEIGHTS (`apertureR`), which three's fixed-vertical-FOV convention makes
 * aspect-independent.
 *
 * ── THE RETICLE IS WHERE THE BULLET GOES ─────────────────────────────────────
 * `ballistics` fires along `player.getAimDirection()`, i.e. `player.yaw/pitch`. The world
 * camera composes from the same `player.yaw/pitch`. Scope sway is therefore added by
 * `PlayerCamera._writeAngles` to the *aim itself* rather than to the camera on top of the
 * aim — sway the camera alone and the crosshair would lie. That leaves screen centre and
 * the bullet path IDENTICAL, not merely close: `scripts/scopeshot.mjs` projects the point
 * the live aim ray hits back through the live camera once per rendered frame and reports
 * the disagreement in pixels. Over 260 consecutive frames of sway, breathing, mouse lag,
 * bolt cycling and six live rounds it measures 0.000 px — on the REAVER (6×, 40 px per
 * degree) and on the MERIDIAN (3.5×) alike.
 */

const SUN = ATMOSPHERE.sunDir;

// ── module-scope scratch: this file allocates nothing per frame (§1) ─────────
const _sun = new THREE.Vector3();
const _eye = new THREE.Vector3();

const T = {
  /**
   * adsAmount at which the sight picture starts to appear / is fully formed.
   *
   * This window used to be 0.52 → 0.96, i.e. the last HALF of the aim-in, and it was
   * wrong. Cross-fading an aperture over an un-magnified world for a fifth of a second
   * does not read as a scope coming up; it reads as a translucent grey circle and a
   * ghost cross floating over the scene, which is exactly what it looked like. Every
   * shipped game snaps the optic in over a couple of frames at the very end of the
   * aim-in, while the FOV is already most of the way down and the rifle is already on
   * the axis, so there is nothing left to cross-fade against. 0.76 → 0.97 of a 0.44 s
   * aim-in is ~90 ms, floored at MIN_RISE below.
   */
  FADE_IN: 0.76,
  FADE_OUT: 0.97,

  /** Aperture radius in screen half-heights: tighter glass for more magnification. */
  R_BASE: 0.955,
  R_PER_MAG: 0.0285,
  R_MIN: 0.66,
  R_MAX: 0.90,

  /**
   * The sight picture may never appear in less than this many seconds — a floor on the
   * rate, not a delay. On the normal path the fade window above already takes ~90 ms of
   * the REAVER's 0.44 s aim-in, so this is barely binding; it exists for the case where a
   * weapon is swapped back in with its ADS progress already at 1 (the player never let go
   * of the aim button), which would otherwise slam the whole optic on screen in one frame.
   */
  MIN_RISE: 0.09,

  /** Aperture edge width in half-heights at full scope, and while focusing in. */
  EDGE_SHARP: 0.0045,
  EDGE_SOFT: 0.075,

  /** Eye-relief shadow: how far the black ring may slide, in half-heights. */
  SHIFT_SWAY: 0.55,     // per radian of scope sway
  SHIFT_LAG: 1.30,      // per radian of mouse lag
  SHIFT_BREATH: 0.026,  // breathing bob amplitude
  SHIFT_RECOIL: 0.62,   // per radian of un-recovered recoil
  SHIFT_MAX: 0.115,
  SHIFT_RATE: 15,

  /** Glint. */
  GLINT_SPREAD: 2.5,
  GLINT_RATE: 5.5,

  /**
   * Muzzle flash, as seen through the glass.
   *
   * The viewmodel's flash card is NOT it: that card is authored for a 70° hip camera and
   * the view camera is at 30° when the REAVER is scoped, so the same quad covers the
   * whole ocular in white. `ViewLayerPass` therefore stops drawing the view scene once
   * the sight picture has taken over (see engine.js) and this term replaces it — a short
   * warm bounce low in the glass, which is where the muzzle is relative to the optical
   * axis, and which is all a shooter actually sees at 6×.
   */
  FLASH_DECAY: 13,
};

/**
 * Owns the scoped-sight state and writes it into the composite pass's uniforms.
 * Constructed by `Engine`; updated once per rendered frame from `Engine.update`, i.e.
 * after every system's `update()` has run, so it reads a settled camera.
 */
export class ScopeFX {
  constructor(game, engine) {
    this.game = game;
    this.engine = engine;

    /** 0..1 — how much sight picture is on screen. THE guard for everything. */
    this.amount = 0;
    /** Aperture radius in screen half-heights. HUD sizes the reticle from this. */
    this.apertureR = T.R_MAX;
    /** True once anything at all is being drawn. */
    this.active = false;

    this.shiftX = 0;
    this.shiftY = 0;
    this.glintX = 0;
    this.glintY = 0;
    this.glintI = 0;
    /** 0..1 — muzzle bounce inside the glass, kicked by the player's own shot. */
    this.flash = 0;

    this._def = null;
    this._losT = 0;
    this._los = 0;

    this._onShot = (e) => {
      // Only the local player's own barrel. A bot firing across the map does not light
      // up the inside of your ocular.
      if (e?.isPlayer && this.active) this.flash = 1;
    };
    this._unsub = game.bus?.on?.('shot', this._onShot) || null;
  }

  /** Wipe every transient. Called on match reset, death, pause and weapon swap. */
  reset() {
    this.amount = 0;
    this.active = false;
    this.shiftX = this.shiftY = 0;
    this.glintI = 0;
    this.flash = 0;
    this._los = 0;
    this._losT = 0;
    this._def = null;
    this._write(0);
  }

  /**
   * @param {number} dtFrame real frame delta
   */
  update(dtFrame) {
    const dt = clamp(dtFrame, 0, 0.1);
    const game = this.game;
    const p = game.player;
    const cam = p?.camera;

    // ── the early-out. Everything below this line is scoped-only cost. ────────
    const def = p?.weapon?.def || null;
    const playable = !!p && p.alive && !game.paused
      && (game.state === 'playing' || game.state === 'paused')
      && !cam?.deathCam;
    const scoped = !!def?.scoped && playable;

    if (def !== this._def) {
      // A swap must never leave the previous weapon's glass on screen for a frame.
      this._def = def;
      this.amount = 0;
      this.shiftX = this.shiftY = 0;
      this.glintI = 0;
      this.flash = 0;
      this._los = 0;
    }

    if (!scoped) {
      if (!this.active) return;               // steady state: one branch, then out
      this.amount = 0;
      this.active = false;
      this.shiftX = this.shiftY = 0;
      this.glintI = 0;
      this.flash = 0;
      this._write(0);
      return;
    }

    // ── fade, matched to the ADS ease so the glass arrives with the sight ────
    const ads = clamp(p.adsAmount, 0, 1);
    const raw = clamp((ads - T.FADE_IN) / (T.FADE_OUT - T.FADE_IN), 0, 1);
    this.amount = Math.min(smoothstep(raw), this.amount + dt / T.MIN_RISE);
    if (this.amount <= 0.0005) {
      if (this.active) { this.active = false; this.flash = 0; this._write(0); }
      return;
    }
    this.active = true;
    this.flash = damp(this.flash, 0, T.FLASH_DECAY, dt);
    if (this.flash < 0.002) this.flash = 0;

    // ── aperture ─────────────────────────────────────────────────────────────
    const mag = def.viewmodel?.optic?.mag || 4;
    this.apertureR = clamp(T.R_BASE - T.R_PER_MAG * mag, T.R_MIN, T.R_MAX);

    // Focusing in: the tube opens up from a slightly wide, soft ring into crisp glass.
    // Kept tight (1.06, not the old 1.34) because the fade is now ~90 ms — a ring that
    // sweeps a long way in that time is a wipe, not an optic settling.
    const focus = 1 - this.amount;
    const edge = lerp(T.EDGE_SHARP, T.EDGE_SOFT, focus * focus);
    const radius = this.apertureR * lerp(1, 1.06, focus * focus);
    const haze = focus * focus * 0.85;

    // ── eye-relief shadow ────────────────────────────────────────────────────
    // The single biggest tell that a scope is real: your eye is never perfectly on the
    // optical axis, so the black ring is never perfectly concentric, and it moves.
    // Sway and recoil are aim state now (see player.js) — they move player.yaw/pitch,
    // not the camera. Only the mouse-lag term below is still a genuine camera field.
    const swayY = p?.scopeSwayYaw || 0;
    const swayP = p?.scopeSwayPitch || 0;
    const lagY = cam?.lagYaw || 0;
    const lagP = cam?.lagPitch || 0;
    const breath = cam ? Math.sin(cam.swayTime * 1.42) : 0;
    const breathAmp = T.SHIFT_BREATH * (p?.breathHolding ? 0.15 : 1);
    // Un-recovered recoil throws the sight picture; on a bolt gun this is the whole
    // "you lose the target on every shot" beat.
    const recP = p?.recoilPitch || 0;
    const recY = p?.recoilYaw || 0;

    let tx = -(swayY * T.SHIFT_SWAY + lagY * T.SHIFT_LAG + recY * T.SHIFT_RECOIL);
    let ty = (swayP * T.SHIFT_SWAY + lagP * T.SHIFT_LAG + recP * T.SHIFT_RECOIL)
      + breath * breathAmp;
    const m = Math.sqrt(tx * tx + ty * ty);
    if (m > T.SHIFT_MAX) { const k = T.SHIFT_MAX / m; tx *= k; ty *= k; }
    this.shiftX = damp(this.shiftX, tx * this.amount, T.SHIFT_RATE, dt);
    this.shiftY = damp(this.shiftY, ty * this.amount, T.SHIFT_RATE, dt);

    // ── lens glint ───────────────────────────────────────────────────────────
    this._updateGlint(dt, p);

    this._write(this.amount, radius, edge, haze);
  }

  /**
   * Where the sun lands in aperture space, and whether anything is in the way.
   * `q = (component / -z) / tan(fov/2)` — the same half-height space the shader uses,
   * so the glint tracks the aperture exactly at any FOV or aspect ratio.
   */
  _updateGlint(dt, p) {
    const cam = this.game.camera;
    if (!cam) { this.glintI = damp(this.glintI, 0, T.GLINT_RATE, dt); return; }

    _sun.copy(SUN).transformDirection(cam.matrixWorldInverse);
    let target = 0;
    if (_sun.z < -0.001) {
      const tanH = Math.tan(cam.fov * 0.5 * DEG);
      this.glintX = (_sun.x / -_sun.z) / tanH;
      this.glintY = (_sun.y / -_sun.z) / tanH;
      const d = Math.hypot(this.glintX, this.glintY);
      if (d < T.GLINT_SPREAD) {
        // One ray, three times a second, only while scoped. Sky occlusion matters:
        // a scope glinting through a wall reads as a bug, not as glass.
        this._losT -= dt;
        if (this._losT <= 0) {
          this._losT = 0.3;
          p.getEyePosition(_eye);
          this._los = this.game.world?.raycast?.(_eye, SUN, 90) ? 0 : 1;
        }
        target = (1 - smoothstep(clamp(d / T.GLINT_SPREAD, 0, 1))) * this._los * this.amount;
      }
    }
    this.glintI = damp(this.glintI, target, T.GLINT_RATE, dt);
  }

  /**
   * Push into the live composite uniforms. Re-read every frame rather than cached,
   * because `Engine._rebuildGpuResources` builds a whole new composer (and therefore a
   * whole new cloned uniform block) after a WebGL context loss — caching the object
   * would leave the scope writing into a dead pass forever after a driver reset.
   */
  _write(amount, radius = this.apertureR, edge = T.EDGE_SHARP, haze = 0) {
    const u = this.engine?.compositePass?.uniforms;
    if (!u || !u.uScope) return;
    u.uScope.value = amount;
    if (amount <= 0) return;
    u.uScopeGeom.value.set(radius, edge, haze, this.flash);
    u.uScopeShift.value.set(this.shiftX, this.shiftY);
    u.uScopeGlint.value.set(this.glintX, this.glintY, this.glintI);
  }

  dispose() {
    this._write(0);
    this._unsub?.();
    this._unsub = null;
    this._def = null;
  }
}
