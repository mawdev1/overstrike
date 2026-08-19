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
  /** `kill` upgrades it to the kill variant — the one that tells you they went down. */
  hitmarker(headshot, _owner, kill) { this.game.hud?.hitmarker?.(headshot, kill); }
  setAmmo(ammo, reserve) { this.game.hud?.setAmmo?.(ammo, reserve); }
  setWeapon(def) { this.game.hud?.setWeapon?.(def); }
  setEquipment(lethal, tactical) { this.game.hud?.setEquipment?.(lethal, tactical); }
  setCrosshairSpread(px) { this.game.hud?.setCrosshairSpread?.(px); }
  killfeed(evt) { this.game.hud?.killfeed?.(evt); }
  deathScreen(evt, _owner) { this.game.hud?.deathScreen?.(evt); }

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

/**
 * A presenter that WRITES DOWN what it was asked to present, instead of doing it.
 *
 * This is the server's presenter, and it exists because of the sharpest bug in the whole
 * multiplayer conversion: a shot fired by a networked client resolves on the SERVER, where
 * `game.present` was a `NullPresenter`. The hit landed, the damage applied, the score
 * moved — and then `present.hitmarker()` did nothing, because there is no HUD in a Node
 * process. Nothing was ever sent to the client that fired. The player saw no hitmarker, no
 * hit sound, no blood, and reported, entirely reasonably, that "none of the shots are
 * hitting the enemies". They were all hitting.
 *
 * The presentation port already draws the line in exactly the right place — everything
 * reached through `game.present` is feedback, by construction — so the fix is not to
 * special-case combat, it is to make the server's presenter a RECORDER and let the wire
 * carry what it recorded to the machine that owns the screen.
 *
 * Events are plain objects with string kinds, deliberately: `core/` must not know the wire
 * format, and `net/protocol.js` is where kinds become bytes. Two audiences:
 *
 *   `to` set    — for one entity's client only (your hitmarker, your damage flash)
 *   `to` null   — for everyone (a gunshot, a death, the killfeed)
 */
export class RecordingPresenter extends NullPresenter {
  visual = false;

  constructor() {
    super();
    /** @type {Array<{kind: string, to: number|null, [k: string]: any}>} */
    this.events = [];
  }

  /** Drop everything recorded. The server calls this once per tick, after draining. */
  clear() { this.events.length = 0; }

  _push(kind, to, extra) { this.events.push(Object.assign({ kind, to: to ?? null }, extra)); }

  // ── the shooter's own confirmation ─────────────────────────────────────────────
  hitmarker(headshot, owner) { this._push('hitmarker', owner?.id, { headshot: !!headshot }); }

  // ── everyone's ─────────────────────────────────────────────────────────────────
  killfeed(evt) {
    this._push('kill', null, {
      // `evt.killer` is a NAME string in this event — the entity ref is `attacker`.
      killerId: evt?.attacker?.id ?? 0,
      victimId: evt?.victim?.id ?? 0,
      headshot: !!evt?.headshot,
    });
  }

  /**
   * A gunshot, as a discrete event.
   *
   * The snapshot already carries an `F_FIRING` flag, and it is not enough: snapshots go out
   * at 30 Hz while a rifle fires at 12.5 rounds/second and a semi-auto tap lasts one tick.
   * Sampling a boolean at 30 Hz drops shots and merges bursts, so remote guns flickered
   * instead of firing. An event per shot is the only thing that reproduces the cadence the
   * shooter actually pulled.
   */
  muzzleFlash(position, dir, scale, owner) {
    this._push('fire', null, {
      entityId: owner?.id ?? 0,
      x: position?.x ?? 0, y: position?.y ?? 0, z: position?.z ?? 0,
    });
  }

  // ── the victim's ───────────────────────────────────────────────────────────────
  //
  // Routed by ENTITY, not by "the player": on a server every one of these is somebody's,
  // and the one thing that must never happen is showing a damage flash to the wrong client.
  flashDamage(amount, owner) { this._push('damaged', owner?.id, { amount: Math.round(amount ?? 0) }); }
  /**
   * `deathScreen(null, owner)` is the CLEAR — the respawn, not a death. It must be routed
   * to the one client that respawned; letting a null event fall through to `to: null` would
   * broadcast "you died" to the entire server every time anybody came back.
   */
  deathScreen(evt, owner) {
    if (!evt) { this._push('respawn', owner?.id, {}); return; }
    if (evt.victim?.id == null) return;
    this._push('death', evt.victim.id, { killerId: evt.killer?.id ?? 0 });
  }
}
