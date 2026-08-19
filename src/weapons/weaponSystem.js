import * as THREE from 'three';
import { clamp, damp, DEG, spreadDir } from '../core/mathUtils.js';
import { WEAPONS, getWeapon, DEFAULT_LOADOUT, MELEE, fireInterval } from './weaponDefs.js';
import { addressedRNG, hashRandom } from '../core/rng.js';
import { fireHitscan, meleeSweep, applyMeleeDamage } from './ballistics.js';
import { Viewmodel } from './viewmodel.js';
import { defineSnapshot } from '../core/snapshot.js';

/**
 * OVERSTRIKE — weapon system.  (ARCHITECTURE.md §7)
 *
 * `WeaponInstance` is the whole gun: a fixed-step state machine that owns ammo, timing,
 * spread, bloom and recoil. Bots and the player run the SAME instance code — the only
 * difference is where the aim comes from and whether a viewmodel is attached. If it
 * feels good in your hands it behaves identically in theirs.
 *
 * Timing rules:
 *  - Every timer is advanced by the fixed 1/120 s step; nothing reads frame delta.
 *  - Fire cadence accumulates its remainder (`fireTimer += interval`, never `= interval`)
 *    so 720 rpm is exactly 12.000 rounds per second rather than 10 (which is what you
 *    get if you quantise an 83.3 ms interval to an 8.3 ms tick).
 */

const STATE_IDLE = 'idle';
const STATE_FIRING = 'firing';
const STATE_RELOADING = 'reloading';
const STATE_SWITCHING = 'switching';
const STATE_EMPTY = 'empty';

/** Above this horizontal speed the movement spread penalty is at full strength. */
const FULL_MOVE_SPEED = 6.0;

// ------------------------------------------------------------------ scratch

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _spread = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _eject = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _tmp = new THREE.Vector3();

// ==================================================================== WeaponInstance

export class WeaponInstance {
  /**
   * @param {WeaponSystem} system
   * @param {object} def   entry from weaponDefs
   * @param {object} owner entity (player or bot)
   */
  constructor(system, def, owner) {
    this.system = system;
    this.game = system.game;
    this.def = def;
    this.owner = owner;

    this.ammo = def.magSize;
    this.reserve = def.reserve;

    this.state = STATE_IDLE;
    this.adsAmount = 0;          // eased 0..1 — read by camera, viewmodel and spread
    this.adsRaw = 0;             // linear 0..1 progress
    this.wantAds = false;

    this.interval = fireInterval(def);
    this.fireTimer = 0;          // seconds until the next round may leave
    this.stateTimer = 0;         // remaining reload / switch time
    this.stateDuration = 0;
    this.rechamberTimer = 0;     // bolt / pump lockout

    this.triggerDown = false;
    this._triggerLatched = false;
    this.burstRemaining = 0;
    this.burstTimer = 0;

    this.reloadIsEmpty = false;
    this.reloadProgress = 0;

    this.bloom = 0;              // extra cone in degrees from sustained fire
    this.patternIndex = 0;
    this.sinceLastShot = 999;
    this.shotsThisTrigger = 0;

    // Recoil the OWNER is carrying right now (radians). The player's camera consumes
    // this via addRecoil; bots add it to their aim so their bursts climb like ours.
    this.recoilPitch = 0;
    this.recoilYaw = 0;

    this.equipped = false;
    this.viewmodel = null;       // set by the system for the local player only
    this._dryTimer = 0;
    this._lastFireTime = -999;
    this.shotsFired = 0;
  }

  // ------------------------------------------------------------- lifecycle

  /** Fresh gun: full mag, full reserve, no state. */
  reset() {
    this.ammo = this.def.magSize;
    this.reserve = this.def.reserve;
    this.state = STATE_IDLE;
    this.adsAmount = this.adsRaw = 0;
    this.wantAds = false;
    this.fireTimer = 0;
    this.stateTimer = 0;
    this.stateDuration = 0;
    this.rechamberTimer = 0;
    this.triggerDown = false;
    this._triggerLatched = false;
    this.burstRemaining = 0;
    this.burstTimer = 0;
    this.bloom = 0;
    this.patternIndex = 0;
    this.recoilPitch = this.recoilYaw = 0;
    this.sinceLastShot = 999;
    this.shotsFired = 0;
  }

  /** Called when this weapon comes into the owner's hands. */
  onEquip() {
    this.equipped = true;
    this.state = STATE_SWITCHING;
    this.stateDuration = this.def.raiseTime ?? this.def.switchTime;
    this.stateTimer = this.stateDuration;
    this.triggerDown = false;
    this._triggerLatched = true;   // require a fresh pull after a swap
    this.burstRemaining = 0;
    this.bloom = 0;
    this.fireTimer = Math.max(this.fireTimer, 0);
    this.viewmodel?.onSwitchIn(this.stateDuration);
  }

  onHolster() {
    this.equipped = false;
    this.wantAds = false;
    this.triggerDown = false;
    this.burstRemaining = 0;
    if (this.state === STATE_RELOADING) this.cancelReload(false);
    this.state = STATE_IDLE;
  }

  // ------------------------------------------------------------- queries

  get isEmpty() { return this.ammo <= 0; }
  get totalAmmo() { return this.ammo + this.reserve; }
  get isReloading() { return this.state === STATE_RELOADING; }
  get isSwitching() { return this.state === STATE_SWITCHING; }
  /** 0..1 — how far through the current reload/switch we are (for the HUD bar). */
  get stateProgress() {
    return this.stateDuration > 0 ? 1 - this.stateTimer / this.stateDuration : 1;
  }

  canFire() {
    if (!this.equipped) return false;
    if (this.ammo <= 0) return false;
    if (this.fireTimer > 0 || this.rechamberTimer > 0) return false;
    if (this.state === STATE_SWITCHING) return false;
    if (this.state === STATE_RELOADING) return false;
    if (this.owner?.sprinting && !this.def.canFireSprinting) return false;
    return true;
  }

  /**
   * Current cone HALF-ANGLE in degrees, everything folded in.
   * The HUD sizes the crosshair straight off this number.
   */
  getCurrentSpread() {
    const d = this.def;
    const o = this.owner;
    let base = d.spreadHip + (d.spreadAds - d.spreadHip) * this.adsAmount;

    let mul = 1;
    if (o) {
      const vx = o.velocity?.x || 0, vz = o.velocity?.z || 0;
      const speed = Math.sqrt(vx * vx + vz * vz);
      const airborne = o.grounded === false;
      if (airborne) {
        mul *= d.spreadAirMul;
      } else if (speed > 0.15) {
        const f = clamp(speed / FULL_MOVE_SPEED, 0, 1);
        mul *= 1 + (d.spreadMoveMul - 1) * f;
      }
      const crouching = o.crouching ?? (o.height !== undefined && o.height < 1.4);
      if (crouching && !airborne) mul *= d.spreadCrouchMul;
    }
    // ADS pulls the movement penalty back toward nothing — that is the whole point of it.
    mul = 1 + (mul - 1) * (1 - this.adsAmount * 0.72);

    return base * mul + this.bloom;
  }

  /** Recoil the AI should add to its aim this tick (radians). */
  getAimOffset(out) {
    out.pitch = this.recoilPitch;
    out.yaw = this.recoilYaw;
    return out;
  }

  // ------------------------------------------------------------- inputs

  /**
   * Trigger held / pulled. Call every fixed step while the button is down; the latch
   * makes semi-auto and burst require a fresh pull without the caller tracking edges.
   * @returns {boolean} true if a round left the barrel on this call
   */
  tryFire() {
    this.triggerDown = true;

    // Firing with rounds in the mag cancels a reload — the classic panic-out.
    if (this.state === STATE_RELOADING) {
      if (this.ammo > 0 && !this._triggerLatched) this.cancelReload(true);
      else return false;
    }
    if (this.state === STATE_SWITCHING) return false;

    if (this.ammo <= 0) {
      if (!this._triggerLatched) {
        this._triggerLatched = true;
        this._dryFire();
      }
      return false;
    }

    const mode = this.def.fireMode;
    if (mode === 'auto') {
      if (this.canFire()) { this._fireRound(); return true; }
      return false;
    }

    if (mode === 'burst') {
      if (this._triggerLatched || this.burstRemaining > 0) return false;
      if (!this.canFire()) return false;
      this._triggerLatched = true;
      this.burstRemaining = Math.max(1, this.def.burstCount);
      this.burstTimer = 0;
      this._fireRound();
      this.burstRemaining--;
      this.burstTimer = this.def.burstDelay;
      return true;
    }

    // semi
    if (this._triggerLatched) return false;
    this._triggerLatched = true;
    if (!this.canFire()) return false;
    this._fireRound();
    return true;
  }

  /** Trigger released. */
  stopFire() {
    this.triggerDown = false;
    this._triggerLatched = false;
    this.shotsThisTrigger = 0;
    if (this.state === STATE_FIRING) this.state = this.ammo > 0 ? STATE_IDLE : STATE_EMPTY;
  }

  /** Start a reload if one makes sense. */
  reload() {
    const d = this.def;
    if (!this.equipped) return false;
    if (d.magSize <= 0) return false;
    if (this.state === STATE_RELOADING || this.state === STATE_SWITCHING) return false;
    if (this.ammo >= d.magSize || this.reserve <= 0) return false;
    if (this.owner?.sprinting) return false;

    this.reloadIsEmpty = this.ammo <= 0;
    this.stateDuration = this.reloadIsEmpty ? d.reloadEmptyTime : d.reloadTime;
    this.stateTimer = this.stateDuration;
    this.state = STATE_RELOADING;
    this.burstRemaining = 0;
    this.wantAds = false;

    if (this.viewmodel) {
      // The viewmodel owns the staged audio so magOut/magIn land on the animation.
      this.viewmodel.onReloadStart(this.stateDuration, this.reloadIsEmpty);
    } else {
      this.game.present.play('magOut', { position: this._ownerPos(_tmp), volume: 0.7 });
      this.game.present.play('magIn', {
        position: this._ownerPos(_tmp), volume: 0.7, delay: this.stateDuration * 0.55,
      });
    }
    this.game.bus?.emit('reloadStart', { shooter: this.owner, weaponId: d.id });
    return true;
  }

  /** Abort an in-progress reload (sprint, weapon swap, or firing with ammo left). */
  cancelReload(notify = true) {
    if (this.state !== STATE_RELOADING) return;
    this.state = this.ammo > 0 ? STATE_IDLE : STATE_EMPTY;
    this.stateTimer = 0;
    this.viewmodel?.onReloadCancel();
    if (notify) this.game.bus?.emit('reloadEnd', { shooter: this.owner, weaponId: this.def.id, cancelled: true });
  }

  setAds(on) {
    this.wantAds = !!on && this.state !== STATE_RELOADING && !this.owner?.sprinting;
  }

  // ------------------------------------------------------------- simulation

  fixedUpdate(dt) {
    this.sinceLastShot += dt;
    if (this.fireTimer > 0) this.fireTimer -= dt;
    if (this.rechamberTimer > 0) this.rechamberTimer -= dt;
    if (this._dryTimer > 0) this._dryTimer -= dt;

    // --- ADS easing.
    // `adsRaw` is exact linear progress over the def's `adsTime`; `adsAmount` is the
    // curve everyone downstream reads. Deliberately an ease-OUT rather than a
    // smoothstep: a smoothstep leaves at zero slope, so the first third of every
    // aim-in did almost nothing and a 0.17 s SMG still felt like a quarter second.
    // This is at 50 % by 29 % of the way through and still lands exactly on 0 and 1,
    // which is what keeps the optic alignment pixel-exact at full ADS.
    const adsTime = Math.max(0.01, this.def.adsTime);
    const target = this.wantAds && this.equipped && this.state !== STATE_RELOADING
      && this.state !== STATE_SWITCHING && !this.owner?.sprinting ? 1 : 0;
    const step = dt / adsTime;
    if (this.adsRaw < target) this.adsRaw = Math.min(target, this.adsRaw + step);
    else if (this.adsRaw > target) this.adsRaw = Math.max(target, this.adsRaw - step);
    const inv = 1 - this.adsRaw;
    this.adsAmount = 1 - inv * inv;

    // --- bloom recovery
    if (this.bloom > 0) this.bloom = damp(this.bloom, 0, this.def.bloomRecovery || 3, dt);

    // --- carried recoil decays back toward zero
    const rec = this.def.recoil.recovery || 7;
    this.recoilPitch = damp(this.recoilPitch, 0, rec, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, rec, dt);

    // --- pattern reset after a pause
    if (this.sinceLastShot > (this.def.recoil.resetTime || 0.35)) {
      this.patternIndex = 0;
      this.shotsThisTrigger = 0;
    }

    switch (this.state) {
      case STATE_RELOADING: {
        if (this.owner?.sprinting) { this.cancelReload(); break; }
        this.stateTimer -= dt;
        this.reloadProgress = this.stateProgress;
        if (this.stateTimer <= 0) this._finishReload();
        break;
      }
      case STATE_SWITCHING: {
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) {
          this.stateTimer = 0;
          this.state = this.ammo > 0 ? STATE_IDLE : STATE_EMPTY;
        }
        break;
      }
      default: break;
    }

    // --- burst continuation runs independently of the trigger
    if (this.burstRemaining > 0) {
      this.burstTimer -= dt;
      if (this.burstTimer <= 0 && this.state !== STATE_RELOADING && this.state !== STATE_SWITCHING) {
        if (this.ammo > 0) {
          this._fireRound();
          this.burstRemaining--;
          this.burstTimer += this.def.burstDelay;
        } else {
          this.burstRemaining = 0;
        }
      }
    }

    // --- auto-reload the instant the mag runs dry (CoD behaviour; cancellable)
    if (this.ammo <= 0 && this.state !== STATE_RELOADING && this.state !== STATE_SWITCHING) {
      this.state = STATE_EMPTY;
      if (this.def.magSize > 0 && this.reserve > 0 && this.equipped
        && this.def.autoReloadOnEmpty !== false && !this.owner?.sprinting) {
        this.reload();
      }
    }

    if (this.state === STATE_FIRING && this.sinceLastShot > this.interval * 1.6) {
      this.state = this.ammo > 0 ? STATE_IDLE : STATE_EMPTY;
    }
  }

  // ------------------------------------------------------------- internals

  _ownerPos(out) {
    const o = this.owner;
    if (!o) return out.set(0, 0, 0);
    if (typeof o.getEyePosition === 'function') return o.getEyePosition(out);
    return out.copy(o.position);
  }

  _dryFire() {
    if (this._dryTimer > 0) return;
    this._dryTimer = 0.25;
    this.game.present.play('dryfire', { position: this._ownerPos(_tmp), volume: 0.7 });
    if (this.reserve > 0 && this.def.magSize > 0) this.reload();
  }

  _finishReload() {
    const d = this.def;
    const need = d.magSize - this.ammo;
    const take = Math.min(need, this.reserve);
    this.ammo += take;
    this.reserve -= take;
    this.state = this.ammo > 0 ? STATE_IDLE : STATE_EMPTY;
    this.stateTimer = 0;
    this.reloadProgress = 1;
    this.game.present.play('reloadTail', { position: this._ownerPos(_tmp), volume: 0.6 });
    this.game.bus?.emit('reloadEnd', { shooter: this.owner, weaponId: d.id, cancelled: false });
    if (this.owner?.isPlayer) this.game.present.setAmmo(this.ammo, this.reserve);
  }

  /**
   * One round leaves the barrel. This is the hot path: no allocations, no branches that
   * depend on frame rate.
   */
  _fireRound() {
    const d = this.def;
    const game = this.game;
    const owner = this.owner;

    this.ammo--;
    this.shotsFired++;
    this.shotsThisTrigger++;
    this.state = STATE_FIRING;
    this.sinceLastShot = 0;
    this._lastFireTime = game.time;

    // Exact cadence: carry the remainder so the tick grid never eats rate.
    this.fireTimer += this.interval;
    if (this.fireTimer < 0) this.fireTimer = this.interval;
    if (d.rechamberTime) this.rechamberTimer = d.rechamberTime;

    // ---- origin: the eye, so what you see is what you hit
    this.system.getFireOrigin(owner, _origin);
    this.system.getFireDirection(owner, _dir);

    // ---- muzzle: where the streak and the flash actually come from
    const hasMuzzle = this.system.getMuzzleWorld(this, _muzzle);

    const spreadDeg = this.getCurrentSpread();
    const spreadRad = spreadDeg * DEG;
    const pellets = Math.max(1, d.pellets || 1);
    const tracerEvery = d.tracerEvery || 0;
    const wantTracer = tracerEvery > 0 && (this.shotsFired % tracerEvery) === 0;

    // Index-addressed, not drawn from the shared stream. A predicting client cannot know
    // how many times `game.rng` was called on the server between its own shots — bots
    // thinking, other players firing — so a streamed draw gives the same shot a different
    // spread on each machine. Addressing it by (shooter, shot, pellet) makes it the same
    // number everywhere, computed in any order. See rng.js `hashRandom`.
    const shotRng = addressedRNG(game.matchSeed, (owner?.id ?? 0) * 65537 + this.shotsFired, 1);
    for (let p = 0; p < pellets; p++) {
      if (spreadRad > 0) spreadDir(_dir, spreadRad, shotRng, _spread);
      else _spread.copy(_dir);

      const r = fireHitscan(game, {
        shooter: owner,
        weaponId: d.id,
        origin: _origin,
        dir: _spread,
        damage: d.damage,
        range: d.range,
        falloffStart: d.falloffStart,
        falloffEnd: d.falloffEnd,
        falloffMin: d.falloffMin,
        penetration: d.penetration,
        headshotMul: d.headshotMul,
        tracer: pellets > 1 ? (p === 0 && tracerEvery > 0) : wantTracer,
        tracerFrom: hasMuzzle ? _muzzle : null,
        tracerColor: d.tracerColor,
        tracerWidth: d.class === 'sniper' ? 0.03 : 0.018,
        emitShot: p === 0,
        decalSize: d.class === 'shotgun' ? 0.09 : 0.16,
      });

      if (r.hitEntity && owner?.isPlayer) {
        game.present.hitmarker(r.headshot);
        game.present.playUI(r.headshot ? 'headshot' : 'hitmarker', { volume: 0.6 });
      }
    }

    this._applyRecoil();
    this._feedback(hasMuzzle);

    if (owner?.isPlayer) {
      game.present.setAmmo(this.ammo, this.reserve);
      if (this.ammo > 0 && this.ammo <= Math.max(3, Math.floor(d.magSize * 0.15))) {
        game.present.playUI('lowAmmo', { volume: 0.35 });
      }
    }
  }

  /** Advance the hand-authored pattern and push the kick into the owner's aim. */
  _applyRecoil() {
    const rc = this.def.recoil;
    const pat = rc.pattern;
    const rng = this.game.rng;

    let px = 0, py = 1;
    if (pat && pat.length) {
      const e = pat[this.patternIndex % pat.length];
      px = e[0];
      py = e[1];
      this.patternIndex++;
    }

    // A few percent of noise keeps a memorised pattern from being a laser.
    // Same reasoning as the spread above: addressed by (shooter, shot), so the client's
    // predicted recoil and the server's authoritative recoil are the same number. This
    // one matters even more — recoil moves the aim the NEXT shot fires along, so a
    // divergence here compounds across a whole spray.
    const jitter = 1 + (hashRandom(this.game.matchSeed,
      (this.owner?.id ?? 0) * 65537 + this.shotsFired, 2) - 0.5) * 0.14;
    const adsMul = 1 - this.adsAmount * 0.28;
    const crouchMul = (this.owner?.crouching ?? false) ? 0.86 : 1;
    const scale = jitter * adsMul * crouchMul;

    // Patterns and `recoil.up/.side` are authored in DEGREES per shot.
    const pitchDeg = py * rc.up * scale;
    // +x in the pattern means the muzzle walks RIGHT; yaw increases turning LEFT (§1).
    const yawDeg = -px * rc.side * scale;

    // Bots carry the kick in radians on the WEAPON instance (they add it straight to
    // their aim angles each think() — see getAimOffset()). This is a separate, simpler
    // accumulator from the player's own aim recoil below; bots don't need the spring/
    // permanent-climb feel, only the raw offset.
    this.recoilPitch += pitchDeg * DEG;
    this.recoilYaw += yawDeg * DEG;

    // The player's AIM recoil (permanent climb + decaying spring, baked into
    // player.yaw/pitch so ballistics fires along it) is sim-critical — it must run
    // whether or not a camera/presenter exists, exactly like the weapon-instance
    // accumulator above is for bots. `Player.addRecoil` runs this unconditionally and
    // only reaches into the presenter itself for the punch, which is pure visual.
    // Bots have no `addRecoil` method, so this is a safe no-op for them.
    this.owner?.addRecoil?.(pitchDeg, yawDeg, rc.kick, rc.recovery);

    this.bloom = Math.min(
      this.def.bloomMax || 0,
      this.bloom + (this.def.bloomPerShot || 0) * (1 - this.adsAmount * (1 - (this.def.bloomAdsMul ?? 1))),
    );
  }

  /** Flash, light, sound, shell, viewmodel kick. */
  _feedback(hasMuzzle) {
    const game = this.game;
    const d = this.def;

    if (hasMuzzle) {
      game.present.muzzleFlash(_muzzle, _dir, d.class === 'sniper' || d.class === 'lmg' ? 1.35 : 1.0);
    }

    // Audio pitch variance only — presentation, drawn from fxRng, not the gameplay stream.
    game.present.play(d.audio.fire, {
      position: hasMuzzle ? _muzzle : _origin,
      volume: 1,
      rate: 0.97 + game.fxRng() * 0.06,
    });

    if (this.viewmodel) {
      this.viewmodel.onFire(1);
      if (this.viewmodel.getEjectWorldPosition(_eject)) {
        game.present.shellEject(_eject, _dir, d.viewmodel?.shell || 'rifle');
      }
    } else {
      // Bots still throw brass so a firefight reads from across the map.
      this.system.getEjectWorld(this, _eject);
      game.present.shellEject(_eject, _dir, d.viewmodel?.shell || 'rifle');
    }
  }

  /** Ammo top-up (kill reward, pickup). Returns rounds actually taken. */
  addAmmo(rounds) {
    const cap = this.def.reserve;
    const before = this.reserve;
    this.reserve = Math.min(cap, this.reserve + rounds);
    return this.reserve - before;
  }
}

// ==================================================================== WeaponSystem

export class WeaponSystem {
  constructor(game) {
    this.game = game;

    /** entity -> { weapons:WeaponInstance[], index, lastIndex, equipment } */
    this.loadouts = new Map();

    this.viewmodel = null;
    // A pending holster->raise lives on the LOADOUT, not here: it is per-entity state,
    // and a single system-wide slot meant one entity starting a switch cancelled
    // another's mid-flight. Latent today only because nothing but the player switches.
    // `{ idx, timer }` — flat, so it can be snapshotted; see _commitSwitch.
    //
    // `_meleeTimer`/`_meleeEntity` are written and decremented but read by nothing:
    // Player._meleeReadyAt owns the real cooldown. Dead state, kept only because the
    // audit scripts poke them; deliberately NOT snapshotted.
    this._meleeTimer = 0;
    this._meleeEntity = null;
    this._crosshairPx = -1;
    this._unsub = [];
  }

  async init() {
    this.viewmodel = new Viewmodel(this.game);
    await this.viewmodel.init();

    const bus = this.game.bus;
    // Taking a hit shoves the gun off aim — the flinch every shooter recognises.
    this._unsub.push(bus.on('damage', (e) => {
      if (e.target && e.target.isPlayer) this.viewmodel?.onFlinch(clamp(e.amount / 45, 0.2, 1));
    }));
    // A kill tops your reserve up so a good streak is not ended by an empty pouch.
    this._unsub.push(bus.on('kill', (e) => {
      if (e.attacker && e.attacker !== e.victim) this.grantKillAmmo(e.attacker);
    }));
    // Inspect is announced on the bus by Player.applyCommand, so the animation has
    // exactly one trigger.
    this._unsub.push(bus.on('inspect', (e) => {
      if (!e || !e.entity || e.entity.isPlayer) this.viewmodel?.onInspect();
    }));
  }

  // ------------------------------------------------------------- loadouts

  /**
   * Hand an entity a set of weapons. The first is equipped immediately.
   * @param {object} entity
   * @param {string[]} ids weapon ids from weaponDefs
   */
  giveLoadout(entity, ids = DEFAULT_LOADOUT) {
    if (!entity) return null;
    const list = [];
    for (let i = 0; i < ids.length; i++) {
      const def = getWeapon(ids[i]);
      if (!def || def.class === 'grenade') continue;
      list.push(new WeaponInstance(this, def, entity));
    }
    if (list.length === 0) list.push(new WeaponInstance(this, WEAPONS.ar_vector, entity));

    const lo = {
      weapons: list,
      index: -1,
      lastIndex: list.length > 1 ? 1 : 0,
      equipment: { lethal: 'frag', lethalCount: 2, tactical: 'flash', tacticalCount: 2 },
      melee: new WeaponInstance(this, MELEE, entity),
      switchPending: null,          // { idx, timer } while a holster->raise is in flight
    };
    this.loadouts.set(entity, lo);
    this.switchTo(entity, 0, true);
    return lo;
  }

  getLoadout(entity) { return this.loadouts.get(entity) || null; }

  /** Current WeaponInstance for an entity (also mirrored onto `entity.weapon`, §4). */
  current(entity) {
    const lo = this.loadouts.get(entity);
    return lo && lo.index >= 0 ? lo.weapons[lo.index] : null;
  }

  /**
   * Switch to loadout slot `idx`. Honours the outgoing weapon's switchTime (holster)
   * followed by the incoming weapon's raiseTime.
   */
  switchTo(entity, idx, instant = false) {
    const lo = this.loadouts.get(entity);
    if (!lo) return false;
    idx = ((idx % lo.weapons.length) + lo.weapons.length) % lo.weapons.length;
    if (idx === lo.index) return false;

    const prev = lo.index >= 0 ? lo.weapons[lo.index] : null;

    if (instant || !prev) {
      lo.switchPending = null;
      this._commitSwitch(entity, idx);
      return true;
    }

    // Lower the old gun first, then raise the new one.
    prev.state = STATE_SWITCHING;
    prev.stateDuration = prev.def.switchTime;
    prev.stateTimer = prev.def.switchTime;
    prev.wantAds = false;
    prev.triggerDown = false;
    if (prev.viewmodel) prev.viewmodel.onSwitchOut(prev.def.switchTime);
    lo.switchPending = { idx, timer: prev.def.switchTime };
    return true;
  }

  /**
   * Finish a switch to slot `idx`.
   *
   * Used to be a closure stored on the pending record, which made the pending switch
   * unsnapshotable — a function cannot be serialised or rebuilt from a field list, so a
   * rewind across a weapon switch was impossible. Everything it captured (`prev`, `next`,
   * `lo`) is derivable from `(entity, idx)`, and `prev` read from `lo.index` here is the
   * same instance it would have captured: `index` only moves in this method, so it still
   * holds the outgoing slot when this runs.
   */
  _commitSwitch(entity, idx) {
    const lo = this.loadouts.get(entity);
    if (!lo) return;
    const prev = lo.index >= 0 ? lo.weapons[lo.index] : null;
    const next = lo.weapons[idx];
    if (!next) return;
    if (prev) prev.onHolster();
    lo.lastIndex = lo.index >= 0 ? lo.index : idx;
    lo.index = idx;
    entity.weapon = next;
    if (entity.isPlayer) {
      next.viewmodel = this.viewmodel;
      this.viewmodel?.setWeapon(next.def);
      this.game.present.setWeapon(next.def);
      this.game.present.setAmmo(next.ammo, next.reserve);
    }
    next.onEquip();
    this.game.bus?.emit('weaponSwitch', { shooter: entity, weaponId: next.def.id });
    this.game.present.play('switch', { position: entity.position, volume: 0.7 });
  }

  nextWeapon(entity) {
    const lo = this.loadouts.get(entity);
    if (!lo) return false;
    return this.switchTo(entity, lo.index + 1);
  }

  prevWeapon(entity) {
    const lo = this.loadouts.get(entity);
    if (!lo) return false;
    return this.switchTo(entity, lo.index - 1);
  }

  lastWeapon(entity) {
    const lo = this.loadouts.get(entity);
    if (!lo) return false;
    return this.switchTo(entity, lo.lastIndex);
  }

  // ------------------------------------------------------------- geometry

  /**
   * Where a shot starts: the contract eye position (§4), for every entity including the
   * local player.
   *
   * This used to read `game.camera` for the player, so the bullet left exactly where the
   * crosshair was looking. The intent was right and the mechanism was backwards: the
   * render camera is composed from bob, step, land and shake, all integrated on the
   * VARIABLE frame clock, so the shot origin was frame-rate dependent — two clients at
   * 60 and 240 fps fired from different heights mid-landing — and no headless simulation
   * can reproduce it, because it has no camera.
   *
   * The dependency is now inverted. The eye springs that used to displace the camera —
   * crouch smoothing, stair step-up, the landing spring, the slide dip — are simulation
   * and live on `Player`, integrated on the fixed step, so `getEyePosition()` already
   * includes them. `PlayerCamera` renders from exactly this point and adds only bob,
   * shake and punch, which are decoration and never move a bullet.
   */
  getFireOrigin(entity, out) {
    if (entity && typeof entity.getEyePosition === 'function') return entity.getEyePosition(out);
    return out.copy(entity?.position || _tmp.set(0, 0, 0));
  }

  getFireDirection(entity, out) {
    if (entity && typeof entity.getAimDirection === 'function') return entity.getAimDirection(out).normalize();
    if (this.game.camera) return this.game.camera.getWorldDirection(out);
    return out.set(0, 0, -1);
  }

  /**
   * World-space muzzle. For the player this comes from the viewmodel (transformed out of
   * the view camera's space into the world), which is the classic FPS detail: the shot
   * is traced from the eye but the tracer and flash leave the actual barrel.
   * @returns {boolean} true if `out` was written
   */
  getMuzzleWorld(inst, out) {
    if (inst.viewmodel && inst.viewmodel.getMuzzleWorldPosition(out)) return true;
    return this._approxMuzzle(inst, out, 0.55, -0.06, 0.16);
  }

  getEjectWorld(inst, out) {
    if (inst.viewmodel && inst.viewmodel.getEjectWorldPosition(out)) return true;
    return this._approxMuzzle(inst, out, 0.18, -0.02, 0.14);
  }

  /** Rough muzzle for bots (and a fallback if the viewmodel is not up yet). */
  _approxMuzzle(inst, out, fwd, down, side) {
    const e = inst.owner;
    if (!e) return false;
    this.getFireOrigin(e, out);
    this.getFireDirection(e, _tmp);
    _right.crossVectors(_tmp, _up);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    out.addScaledVector(_tmp, fwd).addScaledVector(_right, side * (inst.def.viewmodel?.ejectSide ?? 1));
    out.y += down;
    return true;
  }

  // ------------------------------------------------------------- equipment

  /**
   * Throw the entity's lethal/tactical.
   * @param {object} entity
   * @param {'lethal'|'tactical'} slot
   * @param {number} power 0..1 — 0 is a gentle lob at your feet, 1 a full overhand throw
   * @param {number} cooked seconds already burned off the fuse
   */
  throwGrenade(entity, slot = 'lethal', power = 1, cooked = 0) {
    const lo = this.loadouts.get(entity);
    if (!lo) return false;
    const countKey = slot === 'tactical' ? 'tacticalCount' : 'lethalCount';
    if (lo.equipment[countKey] <= 0) return false;
    const id = slot === 'tactical' ? lo.equipment.tactical : lo.equipment.lethal;
    const def = WEAPONS[id];
    if (!def || !def.projectile) return false;
    if (!this.game.projectiles?.throwGrenade) return false;

    this.getFireOrigin(entity, _origin);
    this.getFireDirection(entity, _dir);
    _origin.addScaledVector(_dir, 0.35);

    const ok = this.game.projectiles.throwGrenade(entity, _origin, _dir, clamp(power, 0, 1), def, cooked);
    if (!ok) return false;
    lo.equipment[countKey]--;
    this.viewmodel?.onThrow?.();
    if (entity.isPlayer) this.game.present.setEquipment(lo.equipment.lethalCount, lo.equipment.tacticalCount);
    return true;
  }

  /**
   * Quick knife, independent of the weapon in hand. This is the ONLY melee
   * implementation in the game: `Player._melee` owns the cooldown and the camera
   * swipe and then calls straight through to here, so `applyMeleeDamage` — and with
   * it `damageScale`'s spawn protection, pre-round freeze and friendly-fire rules —
   * cannot be skipped by a second hand-rolled sweep.
   *
   * The sweep resolves on the button, not at the end of the wind-up: the animation
   * still winds up and swings, but a knife that only registered 110 ms later meant a
   * hit the attacker had already earned could be taken away by the target strafing
   * during the animation. The visual lead-in is a `viewmodel` concern.
   */
  meleeAttack(entity) {
    if (!entity || !entity.alive) return false;
    const d = MELEE;
    this._meleeTimer = d.meleeDuration;
    this._meleeEntity = entity;
    if (entity.isPlayer) this.viewmodel?.onMelee(d.meleeDuration);
    this.game.present.play('switch', { position: entity.position, volume: 0.55, rate: 1.5 });
    this._resolveMelee(entity);
    return true;
  }

  _resolveMelee(entity) {
    const d = MELEE;
    // Deliberately the CONTRACT eye position, not `getFireOrigin`. A knife is a body
    // action, not a shot down the crosshair: sourcing it from the render camera would
    // make the reach depend on view bob, lean and screen shake, and on a frame the
    // camera had not been written yet it would swing from wherever the camera last was.
    if (typeof entity.getEyePosition === 'function') entity.getEyePosition(_origin);
    else _origin.copy(entity.position);
    this.getFireDirection(entity, _dir);
    const hit = meleeSweep(this.game, entity, _origin, _dir, d.range, d.meleeRadius);
    if (!hit) return;
    applyMeleeDamage(this.game, entity, hit, d.damage, d.id);
    if (entity.isPlayer) {
      this.game.present.hitmarker(false);
      this.game.present.playUI('hitmarker', { volume: 0.7 });
    }
  }

  /** Reward for a kill: a fresh magazine's worth of reserve, capped. */
  grantKillAmmo(entity) {
    const inst = this.current(entity);
    if (!inst) return;
    inst.addAmmo(Math.ceil(inst.def.magSize * 0.5));
    if (entity.isPlayer) this.game.present.setAmmo(inst.ammo, inst.reserve);
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Match restart. Loadouts are NOT wiped — player/bots are reset before us in
   * `game.systems` order and may already have re-issued theirs. We only rewind state.
   */
  reset() {
    for (const lo of this.loadouts.values()) {
      for (const w of lo.weapons) w.reset();
      lo.melee?.reset();
      lo.equipment.lethalCount = 2;
      lo.equipment.tacticalCount = 2;
      const cur = lo.index >= 0 ? lo.weapons[lo.index] : null;
      if (cur) { cur.equipped = true; cur.state = STATE_IDLE; }
      lo.switchPending = null;
    }
    this._meleeTimer = 0;
    this._meleeEntity = null;
    this.viewmodel?.reset();
  }

  /** Drop an entity's loadout entirely (bot removed from the match). */
  remove(entity) {
    this.loadouts.delete(entity);
    if (entity) entity.weapon = null;
  }

  fixedUpdate(dt) {
    // --- melee re-swing lock (the hit itself resolved on the button)
    if (this._meleeTimer > 0) this._meleeTimer -= dt;

    for (const [entity, lo] of this.loadouts) {
      // --- pending holster -> raise, per entity
      const sp = lo.switchPending;
      if (sp) {
        sp.timer -= dt;
        if (sp.timer <= 0) {
          lo.switchPending = null;
          this._commitSwitch(entity, sp.idx);
        }
      }
      const inst = lo.index >= 0 ? lo.weapons[lo.index] : null;
      if (inst) inst.fixedUpdate(dt);
    }
  }

  /** Direct slot key — unlike `switchTo` it does not wrap, so "3" on a 2-gun kit is a no-op. */
  _slot(entity, idx) {
    const lo = this.loadouts.get(entity);
    if (!lo || idx >= lo.weapons.length) return false;
    return this.switchTo(entity, idx);
  }

  /** Visual-only: viewmodel animation and the dynamic crosshair. */
  update(dtFrame) {
    const p = this.game.player;
    const inst = p ? this.current(p) : null;

    if (this.viewmodel) {
      this.viewmodel.update(dtFrame, inst, p);
    }

    if (inst && this.game.hud?.setCrosshairSpread) {
      const px = this._spreadToPixels(inst.getCurrentSpread());
      if (Math.abs(px - this._crosshairPx) > 0.4) {
        this._crosshairPx = px;
        this.game.present.setCrosshairSpread(px);
      }
    }
  }

  /** Cone half-angle (deg) -> crosshair gap in CSS pixels at the current FOV. */
  _spreadToPixels(deg) {
    const cam = this.game.camera;
    const h = (this.game.engine?.canvas?.clientHeight) || globalThis.window?.innerHeight || 1080;
    const fov = (cam?.fov || 85) * DEG;
    const halfPlane = Math.tan(fov * 0.5);
    if (halfPlane <= 0) return 0;
    return clamp((Math.tan(deg * DEG) / halfPlane) * (h * 0.5), 2, h * 0.45);
  }

  dispose() {
    for (const un of this._unsub) un();
    this._unsub.length = 0;
    this.viewmodel?.dispose();
    this.loadouts.clear();
  }
}

/**
 * What has to be saved to replay a tick on a weapon.
 *
 * Timing is the reason this exists. One tick of slip changes `patternIndex`, and the
 * hand-authored spray pattern the player memorised stops working — which reads as the gun
 * being broken rather than as a network artefact. Every timer here is carried for the same
 * reason: `fireTimer` accumulates a sub-tick remainder, so it cannot be reconstructed from
 * the tick number alone.
 *
 * Add a field to WeaponInstance, add it here. `audit()` in scripts/determinism.mjs fails
 * on any field that is neither captured nor ignored.
 */
export const WEAPON_SNAPSHOT = defineSnapshot('WeaponInstance', {
  scalars: [
    'ammo', 'reserve', 'state', 'equipped',

    // ADS. Sole owner of this quantity since the Player-side handshake was deleted:
    // `adsRaw` is the linear integrator, `adsAmount` the eased curve read by spread,
    // recoil scale, movement speed, sensitivity, camera FOV and the scope shader.
    'adsAmount', 'adsRaw', 'wantAds',

    // Timers, all seconds. `fireTimer` carries a remainder across ticks; `rechamberTimer`
    // gates canFire; `stateTimer`/`stateDuration` are the reload and switch clocks.
    'fireTimer', 'stateTimer', 'stateDuration', 'rechamberTimer', '_dryTimer',

    // Trigger state. `_triggerLatched` is the semi/burst fresh-pull latch — lose it on a
    // replay and a semi-auto fires twice for one click.
    'triggerDown', '_triggerLatched', 'burstRemaining', 'burstTimer',

    'reloadIsEmpty', 'reloadProgress',

    // Accuracy state. `bloom` feeds the spread cone and `patternIndex` indexes the recoil
    // pattern, so these two decide where a bullet goes.
    'bloom', 'patternIndex', 'sinceLastShot', 'shotsThisTrigger',

    // Carried recoil, which bots add to their aim via getAimOffset.
    'recoilPitch', 'recoilYaw',

    // Neither of these currently changes an outcome — `_lastFireTime` is written and read
    // nowhere, and `shotsFired` only picks which shots get a tracer. Carried anyway: they
    // are cheap, they make a replay bit-identical rather than merely equivalent, and the
    // day someone reads one it is already correct.
    '_lastFireTime', 'shotsFired',
  ],

  ignore: [
    'system', 'game', 'owner',   // references
    'def',                       // shared immutable weapon definition
    'viewmodel',                 // presentation
    'interval',                  // derived constant, fireInterval(def)
  ],
});

/**
 * The loadout's own scalars. Small, but every one of them is load-bearing.
 *
 * `index` decides which instance is `entity.weapon`, so losing it silently changes which
 * gun the player is holding. `equipment.lethalCount` is the ONE grenade counter in the
 * game — `Player.grenades` is an accessor onto it, not a field, so it is invisible to the
 * Player manifest and would otherwise go unsnapshotted entirely: replay a tick containing
 * a throw and the player pays for it twice.
 */
export const LOADOUT_SNAPSHOT = defineSnapshot('Loadout', {
  scalars: ['index', 'lastIndex'],
  objects: {
    // The counts are what a tick consumes. The `lethal`/`tactical` ids are fixed for the
    // life of the loadout and were originally left out for that reason — but "does not
    // change today" is a weaker guarantee than carrying two strings, and leaving them out
    // meant a restored loadout was not actually equal to the captured one. Carry them.
    equipment: ['lethal', 'lethalCount', 'tactical', 'tacticalCount'],
  },
  ignore: [
    'weapons', 'melee',     // arrays / instances — handled by saveLoadout below
    'switchPending',        // ditto: nullable sub-record
  ],
});

/**
 * Capture an entity's whole weapon state: the loadout scalars, EVERY instance in it, the
 * melee instance, and any switch in flight.
 *
 * Snapshotting only the equipped weapon is not enough. Holstered instances are frozen by
 * `fixedUpdate` (it ticks the current one only), but they are still MUTATED by switching:
 * `onHolster` writes `equipped`/`wantAds`/`triggerDown`/`burstRemaining`/`state` and can
 * cancel a reload, `onEquip` writes `state`/`stateTimer`/`stateDuration`/`_triggerLatched`
 * /`bloom`. A replayed tick containing a switch would otherwise corrupt the other gun
 * permanently, with nothing to restore it from.
 */
export function saveLoadout(lo, out) {
  const o = out || {};
  LOADOUT_SNAPSHOT.save(lo, o);

  const arr = o.weapons || (o.weapons = []);
  for (let i = 0; i < lo.weapons.length; i++) arr[i] = WEAPON_SNAPSHOT.save(lo.weapons[i], arr[i]);
  arr.length = lo.weapons.length;

  o.melee = lo.melee ? WEAPON_SNAPSHOT.save(lo.melee, o.melee) : null;

  const sp = lo.switchPending;
  const t = o.switchPending || (o.switchPending = { active: false, idx: 0, timer: 0 });
  t.active = !!sp;
  t.idx = sp ? sp.idx : 0;
  t.timer = sp ? sp.timer : 0;

  return o;
}

/**
 * Inverse of `saveLoadout`. Instances are written in place, never replaced.
 *
 * Also re-points `entity.weapon`, which is not optional bookkeeping: `lo.index` decides
 * which instance is equipped, but most of the game reads `entity.weapon` rather than
 * calling `current()`. Restoring one without the other leaves the entity holding a gun
 * the loadout says it is not holding, and nothing fails loudly.
 */
export function restoreLoadout(lo, snap) {
  // A length mismatch means this snapshot came from a different loadout. Half-applying it
  // would leave `index` pointing at a weapon that does not exist, so refuse it instead —
  // silently restoring 2 of 3 weapons is the kind of thing that surfaces as an
  // unreproducible desync rather than as an error.
  if (lo.weapons.length !== snap.weapons.length) {
    throw new Error(`Loadout restore: snapshot has ${snap.weapons.length} weapons, loadout has ${lo.weapons.length} — this snapshot is not from this loadout`);
  }
  LOADOUT_SNAPSHOT.restore(lo, snap);
  const n = lo.weapons.length;
  for (let i = 0; i < n; i++) WEAPON_SNAPSHOT.restore(lo.weapons[i], snap.weapons[i]);
  // Symmetric with the length check above: silently skipping when only one side has a
  // melee instance would restore a loadout that is not the one captured.
  if (!lo.melee !== !snap.melee) {
    throw new Error('Loadout restore: melee instance present on one side only — this snapshot is not from this loadout');
  }
  if (lo.melee) WEAPON_SNAPSHOT.restore(lo.melee, snap.melee);

  // The instances carry their owner, so this needs no extra argument.
  const owner = lo.weapons[0]?.owner;
  if (owner) owner.weapon = lo.index >= 0 ? lo.weapons[lo.index] : null;

  const s = snap.switchPending;
  if (!s || !s.active) lo.switchPending = null;
  else if (lo.switchPending) { lo.switchPending.idx = s.idx; lo.switchPending.timer = s.timer; }
  else lo.switchPending = { idx: s.idx, timer: s.timer };

  return lo;
}

/** Field-by-field comparison of two loadout snapshots, for the bit-equality harness. */
export function diffLoadout(a, b) {
  const list = LOADOUT_SNAPSHOT.diff(a, b);
  const n = Math.min(a.weapons.length, b.weapons.length);
  for (let i = 0; i < n; i++) {
    for (const f of WEAPON_SNAPSHOT.diff(a.weapons[i], b.weapons[i])) list.push(`weapons[${i}].${f}`);
  }
  if (a.weapons.length !== b.weapons.length) list.push('weapons.length');
  if (a.melee && b.melee) {
    for (const f of WEAPON_SNAPSHOT.diff(a.melee, b.melee)) list.push(`melee.${f}`);
  }
  const x = a.switchPending, y = b.switchPending;
  if (x.active !== y.active || (x.active && (x.idx !== y.idx || !Object.is(x.timer, y.timer)))) {
    list.push('switchPending');
  }
  return list;
}
