/**
 * Presentation port — see ARCHITECTURE.md §8-10 for what `fx`/`audio`/`hud` are.
 *
 * Simulation code (player, weapons, ballistics, projectiles, killstreaks) must never
 * call `game.audio`/`game.fx`/`game.hud`/`game.engine.flashDamage`/a camera "feel"
 * method directly — it calls `game.present.*` instead. Two implementations:
 *
 *   `LivePresenter`  forwards to the real subsystems. Used whenever they exist.
 *   `NullPresenter`  every method is empty. Installed on a headless server (no audio,
 *                    no fx, no DOM) and during reconciliation replay, so re-running a
 *                    tick to correct a misprediction does not re-trigger a gunshot the
 *                    player already heard once.
 *
 * Why a port and not a flag: `game._safe` (core/game.js) silences a system for the rest
 * of the session on its first throw, so a bug in a `if (suppressed)` branch would look
 * like "the player stopped responding a few minutes in", not a crash. And several call
 * sites interleave a presentation effect with a genuine sim mutation in the same
 * function (`_applyRecoil` writes `recoilPitch`/`recoilYaw` — sim, bots read it — then
 * kicks the camera — presentation, in the next few lines) — a flag guarding the whole
 * function would have to be threaded through by hand at every such site anyway. Routing
 * through an object makes the classification structural: anything reached through
 * `game.present` is presentation *by construction*, and it costs nothing extra to keep
 * working correctly wherever sim and presentation share a function.
 *
 * Every method takes exactly the arguments the underlying call needed. Camera "feel"
 * methods take the entity first, because only the player has a `PlayerCamera` — bots
 * have none, and the null check belongs in one place, not at every call site.
 */

export class LivePresenter {
  /**
   * True when something is actually being drawn.
   *
   * Systems that build RENDERING RESOURCES rather than emit effects — bot rigs are the
   * only case — need to know whether to build them at all, and a per-call no-op cannot
   * express that: the cost is the construction, not the call. Ask this rather than
   * `typeof document`, which is true under jsdom and any DOM shim and so answers the
   * wrong question in exactly the environments where it matters.
   */
  visual = true;

  constructor(game) { this.game = game; }

  // ── audio ──────────────────────────────────────────────────────────────────────
  play(name, opts) { this.game.audio?.play?.(name, opts); }
  playUI(name, opts) { this.game.audio?.playUI?.(name, opts); }
  setListener(position, forward, up) { this.game.audio?.setListener?.(position, forward, up); }

  // ── fx ─────────────────────────────────────────────────────────────────────────
  muzzleFlash(position, dir, scale) { this.game.fx?.muzzleFlash?.(position, dir, scale); }
  tracer(from, to, speed, width, color) { this.game.fx?.tracer?.(from, to, speed, width, color); }
  impact(point, normal, surface) { this.game.fx?.impact?.(point, normal, surface); }
  bloodSpray(point, normal, amount) { this.game.fx?.bloodSpray?.(point, normal, amount); }
  explosion(point, radius) { this.game.fx?.explosion?.(point, radius); }
  smokeTrail(from, to) { this.game.fx?.smokeTrail?.(from, to); }
  shellEject(position, dir, kind) { this.game.fx?.shellEject?.(position, dir, kind); }
  flashbang(amount, duration) { this.game.fx?.flashbang?.(amount, duration); }
  /** Also the camera shake path: `FX.screenShake` routes to `game.player.camera` (§8). */
  screenShake(amount, duration) { this.game.fx?.screenShake?.(amount, duration); }

  // ── engine ─────────────────────────────────────────────────────────────────────
  flashDamage(amount) { this.game.engine?.flashDamage?.(amount); }

  // ── hud ────────────────────────────────────────────────────────────────────────
  hitmarker(headshot) { this.game.hud?.hitmarker?.(headshot); }
  setAmmo(ammo, reserve) { this.game.hud?.setAmmo?.(ammo, reserve); }
  setWeapon(def) { this.game.hud?.setWeapon?.(def); }
  setEquipment(lethal, tactical) { this.game.hud?.setEquipment?.(lethal, tactical); }
  setCrosshairSpread(px) { this.game.hud?.setCrosshairSpread?.(px); }
  killfeed(evt) { this.game.hud?.killfeed?.(evt); }
  deathScreen(evt) { this.game.hud?.deathScreen?.(evt); }

  // ── camera feel (player only — bots have no PlayerCamera) ────────────────────
  //
  // Recoil and damage flinch USED to be entirely camera methods routed through here.
  // Both actually move the player's AIM (baked into player.yaw/pitch, which ballistics
  // fires along), which is simulation and must run whether or not a presenter/camera
  // exists — so that part moved onto `Player` directly (`addRecoil`/`damageKick`,
  // called unconditionally, never through this port). What's left here is only the
  // genuinely decorative remainder: the camera's recoil-punch spring and its damage
  // shake, neither of which moves a bullet.
  cameraStartDeathCam(entity, killerPos) { entity.camera?.startDeathCam?.(killerPos); }
  cameraEndDeathCam(entity) { entity.camera?.endDeathCam?.(); }
  cameraStartSlide(entity) { entity.camera?.startSlide?.(); }
  cameraStartMantle(entity, duration, height) { entity.camera?.startMantle?.(duration, height); }
  cameraMeleeKick(entity) { entity.camera?.meleeKick?.(); }
  /** Camera push-back spring only — METRES, see weaponDefs `recoil.kick`. */
  cameraRecoilPunch(entity, punchMetres) { entity.camera?.recoilPunch?.(punchMetres); }
  /** Camera shake-and-punch reaction to taking damage. */
  cameraDamageFlinch(entity, magnitude) { entity.camera?.damageFlinch?.(magnitude); }
}

/** Every method above, emptied. See the module doc for why this exists. */
export class NullPresenter {
  visual = false;

  play() {} playUI() {} setListener() {}
  muzzleFlash() {} tracer() {} impact() {} bloodSpray() {} explosion() {}
  smokeTrail() {} shellEject() {} flashbang() {} screenShake() {}
  flashDamage() {}
  hitmarker() {} setAmmo() {} setWeapon() {} setEquipment() {} setCrosshairSpread() {}
  killfeed() {} deathScreen() {}
  cameraStartDeathCam() {} cameraEndDeathCam() {}
  cameraStartSlide() {} cameraStartMantle() {} cameraMeleeKick() {}
  cameraRecoilPunch() {} cameraDamageFlinch() {}
}
