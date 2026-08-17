import * as THREE from 'three';
import { getWeapon } from '../weapons/weaponDefs.js';

/**
 * OVERSTRIKE — killstreak rewards.
 *
 * Earned by consecutive kills without dying, spent with the `killstreak` input action.
 * Everything here is pooled and preallocated: three sentry rigs and two gunships are
 * built once at init and recycled, and nothing in a per-step path allocates.
 *
 * Ownership note: streak hardware (sentries, gunships) is not part of `game.entities`,
 * so ballistics cannot see it. We therefore resolve incoming fire ourselves off the
 * canonical `shot` and `explosion` events — see `_onShot()` / `_onExplosion()`.
 * Kill credit flows back to the operator through `ownerEntity`, which Match resolves.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

export const STREAKS = {
  uav: {
    id: 'uav',
    name: 'UAV',
    cost: 3,
    duration: 25,
    description: 'Reveals every enemy on the minimap.',
  },
  airstrike: {
    id: 'airstrike',
    name: 'AIRSTRIKE',
    cost: 5,
    duration: 6.5,
    description: 'Mark a heading; a strafing run walks bombs down it.',
  },
  sentry: {
    id: 'sentry',
    name: 'SENTRY GUN',
    cost: 7,
    duration: 45,
    description: 'Auto-targeting turret. Destructible.',
  },
  chopper: {
    id: 'chopper',
    name: 'GUNSHIP',
    cost: 10,
    duration: 30,
    description: 'A circling gunship engages everything hostile.',
  },
};

export const STREAK_LIST = [STREAKS.uav, STREAKS.airstrike, STREAKS.sentry, STREAKS.chopper];

// ---- tuning ---------------------------------------------------------------
const INVENTORY_CAP = 3;

const AIRSTRIKE_DELAY = 2.0;      // seconds between the call and the first bomb
const AIRSTRIKE_BOMBS = 9;
const AIRSTRIKE_SPACING = 6.5;    // metres between impacts
const AIRSTRIKE_INTERVAL = 0.16;  // seconds between impacts
const AIRSTRIKE_RADIUS = 8.0;
const AIRSTRIKE_DAMAGE = 165;
const AIRSTRIKE_MARK_TIMEOUT = 10;

const SENTRY_MAX = 3;
const SENTRY_RANGE = 28;
const SENTRY_HEALTH = 240;
const SENTRY_DPS_INTERVAL = 0.2;
const SENTRY_DAMAGE = 19;
const SENTRY_TURN = 3.4;          // rad/s
const SENTRY_AIM_TOLERANCE = 0.12;
const SENTRY_REACQUIRE = 0.25;

const CHOPPER_MAX = 2;
const CHOPPER_HEIGHT = 24;
const CHOPPER_RADIUS = 34;
const CHOPPER_SPIN = 0.3;         // rad/s around the map
const CHOPPER_BURST = 0.11;
const CHOPPER_DAMAGE = 24;
const CHOPPER_RANGE = 90;
const CHOPPER_ACQUIRE = 0.4;      // seconds between target sweeps

export class Killstreaks {
  constructor(game, match) {
    this.game = game;
    this.match = match;

    /** @type {Map<number, string[]>} entity.id -> earned, unspent streak ids */
    this.inventory = new Map();
    /** UAV expiry time (match elapsed) keyed by raw team id — FFA teams are unique. */
    this._uavEnd = new Map();
    /** @type {{entity:object, id:string, at:number}|null} */
    this._marking = null;
    /** @type {Map<number, number>} bot id -> time it should use its streak */
    this._botUse = new Map();

    this._strikes = [];
    this._sentries = [];
    this._choppers = [];
    this._group = null;
    this._ballistics = null;
    /**
     * Streak hardware is NOT in `game.entities` and never goes through the player/bot id
     * allocator, so its ids must not collide with theirs. Starting at 1 put sentry #1 on
     * exactly the same id as the player (`player.js` also starts at 1), and anything that
     * keys off `shooter.id` — spawn protection above all — then confused the two. Base
     * the hardware space far above any plausible roster.
     */
    this._nextId = 100000;
    this._availTmp = [];

    this._onKillstreak = this._onKillstreak.bind(this);
    this._onShot = this._onShot.bind(this);
    this._onExplosion = this._onExplosion.bind(this);
    this._unsub = [];
  }

  async init() {
    // Ballistics is written by another owner; take it if it is there, otherwise fall
    // back to a direct-damage path so streak hardware still shoots.
    try {
      const mod = await import('../weapons/ballistics.js');
      if (typeof mod?.fireHitscan === 'function') this._ballistics = mod;
    } catch {
      this._ballistics = null;
    }

    this._group = new THREE.Group();
    this._group.name = 'killstreaks';
    this.game.scene?.add(this._group);

    // Two concurrent runs is plenty — one per team.
    for (let i = 0; i < 2; i++) this._strikes.push(this._makeStrike());
    for (let i = 0; i < SENTRY_MAX; i++) this._sentries.push(this._makeSentry());
    for (let i = 0; i < CHOPPER_MAX; i++) this._choppers.push(this._makeChopper());

    const bus = this.game.bus;
    this._unsub.push(bus.on('killstreak', this._onKillstreak));
    this._unsub.push(bus.on('shot', this._onShot));
    this._unsub.push(bus.on('explosion', this._onExplosion));
  }

  reset() {
    this.inventory.clear();
    this._uavEnd.clear();
    this._marking = null;
    this._botUse.clear();
    for (const s of this._strikes) s.active = false;
    for (const s of this._sentries) this._despawnSentry(s, false);
    for (const c of this._choppers) this._despawnChopper(c);
  }

  // ------------------------------------------------------------------ earning

  _onKillstreak(p) {
    const entity = p?.entity;
    const count = p?.count | 0;
    if (!entity) return;
    for (const def of STREAK_LIST) {
      if (def.cost !== count) continue;
      this._grant(entity, def);
    }
  }

  _grant(entity, def) {
    let inv = this.inventory.get(entity.id);
    if (!inv) this.inventory.set(entity.id, (inv = []));
    if (inv.length >= INVENTORY_CAP) inv.shift();
    inv.push(def.id);

    if (entity.isPlayer) {
      this.match?.notice(`${def.name} READY`, `Press [${this._streakKeyLabel()}] to deploy`, 2.2);
      this._sfx('streakReady', 'uiClick', { volume: 0.9 });
    } else if (def.id === 'uav' || def.id === 'airstrike') {
      // Bots only operate the two streaks that do not need a mesh they cannot steer.
      this._botUse.set(entity.id, this.now + 0.8 + (this.game.rng?.() ?? Math.random()) * 2.2);
    }
  }

  /** Whatever the player actually has `killstreak` bound to, for the prompt. */
  _streakKeyLabel() {
    const binds = this.game.settings?.get?.('binds');
    if (binds) {
      for (const code of Object.keys(binds)) {
        if (binds[code] === 'killstreak') return code.replace(/^Key|^Digit/, '') || code;
      }
    }
    return 'B';
  }

  /** Read-only, pooled: the ids this entity can spend right now. */
  getAvailable(entity) {
    if (!entity) return null;
    return this.inventory.get(entity.id) || null;
  }

  /** HUD-friendly view: [{ id, name, cost, count }] — rebuilt only when asked. */
  getAvailableDefs(entity, out = this._availTmp) {
    out.length = 0;
    const inv = this.getAvailable(entity);
    if (!inv) return out;
    for (const id of inv) {
      const def = STREAKS[id];
      if (def) out.push(def);
    }
    return out;
  }

  get now() { return this.match?.elapsed ?? this.game.time ?? 0; }

  uavActive(team) {
    return this.now < (this._uavEnd.get(team) ?? -1);
  }

  uavRemaining(team) {
    return Math.max(0, (this._uavEnd.get(team) ?? -1) - this.now);
  }

  // --------------------------------------------------------------- activation

  /** Spend the oldest earned streak, or a specific one by id. */
  activate(entity, id = null) {
    // Already holding an airstrike marker? The same button confirms it.
    if (this._marking && this._marking.entity === entity) {
      this._confirmAirstrikeMark();
      return true;
    }
    const inv = this.inventory.get(entity?.id);
    if (!inv || inv.length === 0) return false;
    const idx = id ? inv.indexOf(id) : 0;
    if (idx < 0) return false;
    const def = STREAKS[inv[idx]];
    if (!def) { inv.splice(idx, 1); return false; }

    let ok = false;
    switch (def.id) {
      case 'uav': ok = this._startUav(entity, def); break;
      case 'airstrike': ok = this._beginAirstrikeMark(entity, def); break;
      case 'sentry': ok = this._deploySentry(entity, def); break;
      case 'chopper': ok = this._deployChopper(entity, def); break;
      default: ok = false;
    }
    if (ok) {
      inv.splice(idx, 1);
      this.game.bus?.emit('killstreakActivated', {
        entity, id: def.id, name: def.name, team: entity.team, duration: def.duration,
      });
    }
    return ok;
  }

  // ------------------------------------------------------------------- streaks

  _startUav(entity, def) {
    const t = entity.team;
    this._uavEnd.set(t, this.now + def.duration);
    const mine = t === this.match?.playerTeam;
    this.match?.notice(
      mine ? 'UAV ONLINE' : 'ENEMY UAV',
      mine ? 'Enemy positions on the minimap' : 'You are being tracked',
      2.0,
    );
    this._sfx('uav', 'streakReady', { volume: mine ? 0.9 : 0.7 });
    return true;
  }

  _beginAirstrikeMark(entity, def) {
    if (!entity.isPlayer) return this._launchAirstrike(entity, def, null);
    this._marking = { entity, id: def.id, at: this.now };
    this.match?.notice('MARK TARGET', 'Aim and fire to call the run', 2.4);
    this._sfx('pinPull', 'uiClick', { volume: 0.8 });
    return true;
  }

  _confirmAirstrikeMark() {
    const m = this._marking;
    if (!m) return;
    this._marking = null;
    this._launchAirstrike(m.entity, STREAKS.airstrike, null);
  }

  _makeStrike() {
    return {
      active: false, attacker: null, team: 0,
      origin: new THREE.Vector3(), dir: new THREE.Vector3(),
      timer: 0, index: 0, announced: false,
    };
  }

  /**
   * Resolve the aim into a ground corridor and queue the run.
   * @param {object|null} aimPoint optional explicit target (bots pass null).
   */
  _launchAirstrike(entity, def, aimPoint) {
    const run = this._strikes.find((s) => !s.active) || this._strikes[0];
    const world = this.game.world;

    // Heading: where the caller is looking, flattened.
    if (entity.isPlayer && typeof entity.getAimDirection === 'function') {
      entity.getAimDirection(_dir);
    } else {
      _dir.set(-Math.sin(entity.yaw || 0), 0, -Math.cos(entity.yaw || 0));
    }
    _dir.y = 0;
    if (_dir.lengthSq() < 1e-5) _dir.set(0, 0, -1);
    _dir.normalize();

    // Origin: half a corridor short of the marked point, so the run walks *through*
    // what you marked instead of starting on top of it or landing behind it.
    if (aimPoint) _v1.copy(aimPoint);
    else {
      this._eyeOf(entity, _eye);
      if (entity.isPlayer && typeof entity.getAimDirection === 'function') {
        entity.getAimDirection(_v3);
      } else _v3.copy(_dir);
      const hit = world?.raycast?.(_eye, _v3, 160);
      // Open sky: commit to a sane stand-off rather than a mark 100 m past the fight.
      if (hit?.point) _v1.copy(hit.point);
      else _v1.copy(_eye).addScaledVector(_v3, 45);
    }
    _v1.addScaledVector(_dir, -AIRSTRIKE_SPACING * (AIRSTRIKE_BOMBS - 1) * 0.5);
    // Drop to the floor so bombs do not detonate in mid-air.
    _v2.set(_v1.x, _v1.y + 12, _v1.z);
    const ground = world?.raycast?.(_v2, _down, 60);
    if (ground?.point) _v1.y = ground.point.y;

    run.active = true;
    run.attacker = entity;
    run.team = entity.team;
    run.origin.copy(_v1);
    run.dir.copy(_dir);
    run.timer = -AIRSTRIKE_DELAY;
    run.index = 0;
    run.announced = false;

    const mine = entity.team === this.match?.playerTeam;
    this.match?.notice(
      mine ? 'AIRSTRIKE INBOUND' : 'ENEMY AIRSTRIKE',
      mine ? 'Keep your head down' : 'Take cover',
      2.0,
    );
    this._sfx('airstrikeInbound', 'lowAmmo', { volume: 0.8 });
    return true;
  }

  _updateStrikes(dt) {
    for (let i = 0; i < this._strikes.length; i++) {
      const run = this._strikes[i];
      if (!run.active) continue;
      run.timer += dt;
      if (run.timer < 0) continue;
      if (!run.announced) {
        run.announced = true;
        this.game.fx?.screenShake?.(0.08, 0.5);
      }
      while (run.active && run.timer >= run.index * AIRSTRIKE_INTERVAL) {
        const step = run.index;
        _v1.copy(run.origin).addScaledVector(run.dir, step * AIRSTRIKE_SPACING);
        // A touch of lateral wander so the corridor is not a perfect ruler line.
        const jitter = ((this.game.rng?.() ?? Math.random()) - 0.5) * 3.4;
        _v1.x += -run.dir.z * jitter;
        _v1.z += run.dir.x * jitter;
        this._detonate(_v1, AIRSTRIKE_RADIUS, AIRSTRIKE_DAMAGE, run.attacker, 'airstrike');
        run.index++;
        if (run.index >= AIRSTRIKE_BOMBS) { run.active = false; break; }
      }
    }
  }

  _detonate(point, radius, damage, attacker, weaponId) {
    this.game.fx?.explosion?.(point, radius);
    // NO audio here. Every path out of this method raises the canonical `explosion` bus
    // event — `ballistics.applyExplosionDamage()` emits it unconditionally, so does the
    // projectile system's, and so does the fallback at the bottom — and the audio
    // engine's `_onExplosion` handler is the single intended source of the boom (it
    // plays at priority 100 and owns the ducking/deafen response). Playing it here as
    // well granted TWO voices per detonation against a six-voice `VOICE_LIMIT`, so a
    // nine-bomb airstrike burned the budget twice as fast as the audio engineer's voice
    // priority was tuned for. See the matching notes in fx.js and projectiles.js.
    const player = this.game.player;
    if (player?.position) {
      const d = player.position.distanceTo(point);
      if (d < radius * 3.5) this.game.fx?.screenShake?.(Math.max(0.05, 0.55 * (1 - d / (radius * 3.5))), 0.4);
    }

    // Ballistics owns radius damage (falloff, cover checks, the `explosion` event).
    if (typeof this._ballistics?.applyExplosionDamage === 'function') {
      this._ballistics.applyExplosionDamage(this.game, {
        point, radius, damage, attacker, weaponId, falloff: 1.35,
      });
      return;
    }
    const pj = this.game.projectiles;
    if (typeof pj?.applyExplosionDamage === 'function') {
      pj.applyExplosionDamage(point, radius, damage, attacker, weaponId);
      return;
    }

    // Fallback: our own radius damage. Emitting `explosion` keeps every other listener
    // (including our own sentry damage handler) on the canonical path.
    const ents = this.game.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e.alive) continue;
      this._eyeOf(e, _eye);
      const d = _eye.distanceTo(point);
      if (d > radius) continue;
      if (this.game.world?.losClear && !this.game.world.losClear(point, _eye)) continue;
      const falloff = Math.pow(1 - d / radius, 1.3);
      _v3.copy(_eye).sub(point);
      if (_v3.lengthSq() > 1e-6) _v3.normalize(); else _v3.set(0, 1, 0);
      e.applyDamage?.(damage * falloff, {
        attacker, hitPart: 'torso', point, normal: _v3, weaponId,
      });
    }
    this.game.bus?.emit('explosion', { point, radius, damage, attacker, weaponId });
  }

  // ------------------------------------------------------------------- sentry

  _makeSentry() {
    const a = this.game.assets;
    const gunmetal = a?.mat?.('gunmetal') || this._fallbackMat(0x2a2d33);
    const shell = a?.mat?.('metalGreen') || this._fallbackMat(0x4d5b45);

    const g = new THREE.Group();
    const base = new THREE.Mesh(this._geo('sBase', () => new THREE.CylinderGeometry(0.3, 0.38, 0.18, 10)), gunmetal);
    base.position.y = 0.09;
    const post = new THREE.Mesh(this._geo('sPost', () => new THREE.BoxGeometry(0.16, 0.34, 0.16)), gunmetal);
    post.position.y = 0.33;
    const head = new THREE.Group();
    const body = new THREE.Mesh(this._geo('sBody', () => new THREE.BoxGeometry(0.44, 0.3, 0.5)), shell);
    const barrel = new THREE.Mesh(this._geo('sBarrel', () => new THREE.CylinderGeometry(0.05, 0.05, 0.56, 8)), gunmetal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = -0.36;
    head.add(body, barrel);
    head.position.y = 0.62;
    g.add(base, post, head);
    g.visible = false;
    g.castShadow = false;
    this._group?.add(g);

    return {
      id: this._nextId++,
      kind: 'sentry',
      active: false,
      alive: false,
      isPlayer: false,
      name: 'SENTRY',
      team: 0,
      ownerEntity: null,
      position: new THREE.Vector3(),
      yaw: 0,
      pitch: 0,
      health: SENTRY_HEALTH,
      maxHealth: SENTRY_HEALTH,
      life: 0,
      target: null,
      fireTimer: 0,
      acquireTimer: 0,
      mesh: g,
      head,
    };
  }

  /** Shared geometry cache — every sentry/gunship rig reuses the same buffers. */
  _geo(key, factory) {
    this._geos ||= new Map();
    let g = this._geos.get(key);
    if (!g) { g = factory(); this._geos.set(key, g); }
    return g;
  }

  _fallbackMat(color) {
    // One shared material per streak part, created once — never per object.
    this._mats ||= new Map();
    let m = this._mats.get(color);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.6 });
      this._mats.set(color, m);
    }
    return m;
  }

  _deploySentry(entity, def) {
    const s = this._sentries.find((x) => !x.active);
    if (!s) {
      if (entity.isPlayer) this.match?.notice('NO SLOT', 'Too many sentries deployed', 1.4);
      return false;
    }
    // Two metres in front, dropped onto the floor.
    _dir.set(-Math.sin(entity.yaw || 0), 0, -Math.cos(entity.yaw || 0));
    _v1.copy(entity.position).addScaledVector(_dir, 2.0);
    _v2.set(_v1.x, _v1.y + 1.6, _v1.z);
    const ground = this.game.world?.raycast?.(_v2, _down, 6);
    _v1.y = ground?.point ? ground.point.y : entity.position.y;

    s.active = true;
    s.alive = true;
    s.team = entity.team;
    s.ownerEntity = entity;
    s.position.copy(_v1);
    s.yaw = entity.yaw || 0;
    s.pitch = 0;
    s.health = SENTRY_HEALTH;
    s.life = def.duration;
    s.target = null;
    s.fireTimer = 0;
    // Phase-offset the reacquire cycle. Every `_acquire()` walks the whole entity list
    // with a losClear per candidate in range; three sentries deployed on the same step
    // otherwise share a phase for their whole 45 s life and pile all three sweeps onto
    // the same 1/120 s step, forever. Seeded RNG, so the offset is still deterministic.
    s.acquireTimer = (this.game.rng?.() ?? Math.random()) * SENTRY_REACQUIRE;
    s.mesh.position.copy(_v1);
    s.mesh.rotation.y = s.yaw;
    s.mesh.visible = true;

    if (entity.isPlayer) this.match?.notice('SENTRY DEPLOYED', 'Covering your flank', 1.6);
    this._sfx('sentryDeploy', 'switch', { position: _v1, volume: 0.9 });
    return true;
  }

  _despawnSentry(s, explode = true) {
    if (!s.active) return;
    s.active = false;
    s.alive = false;
    s.target = null;
    s.mesh.visible = false;
    if (explode) {
      this.game.fx?.explosion?.(s.position, 3.2);
      // This one STAYS. Unlike `_detonate()`, a sentry wreck does no radius damage and
      // therefore never raises the `explosion` bus event, so the audio engine's handler
      // is never reached on this path — removing the play would make a destroyed turret
      // silent rather than merely single-voiced. Verified by counting `audio.play`
      // grants: 1 per sentry destruction, 1 per sentry expiry, 0 from the bus.
      this._sfx('explosion', 'explosion', { position: s.position, volume: 0.7 });
    }
  }

  _updateSentries(dt) {
    for (let i = 0; i < this._sentries.length; i++) {
      const s = this._sentries[i];
      if (!s.active) continue;
      s.life -= dt;
      if (s.life <= 0) { this._despawnSentry(s, true); continue; }

      s.acquireTimer -= dt;
      if (s.acquireTimer <= 0) {
        s.acquireTimer = SENTRY_REACQUIRE;
        s.target = this._acquire(s, SENTRY_RANGE, 0.9);
      }

      const t = s.target;
      if (!t || !t.alive) { s.target = null; continue; }

      _muzzle.set(s.position.x, s.position.y + 0.62, s.position.z);
      this._eyeOf(t, _eye);
      _v1.copy(_eye).sub(_muzzle);
      const dist = _v1.length();
      if (dist > 1e-3) _v1.multiplyScalar(1 / dist);

      const wantYaw = Math.atan2(-_v1.x, -_v1.z);
      const wantPitch = Math.asin(Math.max(-1, Math.min(1, _v1.y)));
      let d = (wantYaw - s.yaw) % (Math.PI * 2);
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      const step = SENTRY_TURN * dt;
      s.yaw += Math.abs(d) <= step ? d : Math.sign(d) * step;
      s.pitch += (wantPitch - s.pitch) * Math.min(1, dt * 8);
      s.mesh.rotation.y = s.yaw;
      s.head.rotation.x = -s.pitch;

      s.fireTimer -= dt;
      if (Math.abs(d) > SENTRY_AIM_TOLERANCE || s.fireTimer > 0) continue;
      s.fireTimer = SENTRY_DPS_INTERVAL;
      this._fireAt(s, _muzzle, _eye, SENTRY_DAMAGE, 'sentry', 0.02);
      this._sfx('sentryFire', 'smg', { position: _muzzle, volume: 0.55 });
    }
  }

  // ------------------------------------------------------------------ chopper

  _makeChopper() {
    const a = this.game.assets;
    const shell = a?.mat?.('metalGreen') || this._fallbackMat(0x3d4a38);
    const dark = a?.mat?.('gunmetal') || this._fallbackMat(0x22252a);

    const g = new THREE.Group();
    const body = new THREE.Mesh(this._geo('cBody', () => new THREE.BoxGeometry(1.4, 1.2, 3.6)), shell);
    const tail = new THREE.Mesh(this._geo('cTail', () => new THREE.BoxGeometry(0.32, 0.32, 2.6)), shell);
    tail.position.z = 2.9;
    tail.position.y = 0.25;
    const rotor = new THREE.Mesh(this._geo('cRotor', () => new THREE.BoxGeometry(7.4, 0.06, 0.4)), dark);
    rotor.position.y = 0.86;
    const tailRotor = new THREE.Mesh(this._geo('cTailRotor', () => new THREE.BoxGeometry(0.06, 1.2, 0.16)), dark);
    tailRotor.position.set(0.22, 0.55, 4.1);
    g.add(body, tail, rotor, tailRotor);
    g.visible = false;
    this._group?.add(g);

    return {
      id: this._nextId++,
      kind: 'chopper',
      active: false,
      team: 0,
      ownerEntity: null,
      isPlayer: false,
      name: 'GUNSHIP',
      position: new THREE.Vector3(),
      centre: new THREE.Vector3(),
      angle: 0,
      life: 0,
      target: null,
      fireTimer: 0,
      acquireTimer: 0,
      mesh: g,
      rotor,
      tailRotor,
    };
  }

  _deployChopper(entity, def) {
    const c = this._choppers.find((x) => !x.active);
    if (!c) return false;
    const b = this.game.world?.bounds;
    if (b?.min && b?.max) c.centre.set((b.min.x + b.max.x) * 0.5, b.min.y + CHOPPER_HEIGHT, (b.min.z + b.max.z) * 0.5);
    else c.centre.set(0, CHOPPER_HEIGHT, 0);

    c.active = true;
    c.team = entity.team;
    c.ownerEntity = entity;
    c.angle = (this.game.rng?.() ?? Math.random()) * Math.PI * 2;
    c.life = def.duration;
    c.target = null;
    // Same de-clustering as the sentry: two gunships called on the same step must not
    // share an acquire phase (a full entity sweep with LOS) or a burst phase for 30 s.
    c.fireTimer = (this.game.rng?.() ?? Math.random()) * CHOPPER_BURST;
    c.acquireTimer = (this.game.rng?.() ?? Math.random()) * CHOPPER_ACQUIRE;
    c.mesh.visible = true;
    this._placeChopper(c);

    const mine = entity.team === this.match?.playerTeam;
    this.match?.notice(
      mine ? 'GUNSHIP ON STATION' : 'ENEMY GUNSHIP',
      mine ? 'Support overhead' : 'Get inside',
      2.2,
    );
    this._sfx('chopper', 'matchStart', { volume: mine ? 0.8 : 0.9 });
    this.game.fx?.screenShake?.(0.12, 0.8);
    return true;
  }

  _despawnChopper(c) {
    if (!c.active) return;
    c.active = false;
    c.target = null;
    c.mesh.visible = false;
  }

  _placeChopper(c) {
    c.position.set(
      c.centre.x + Math.cos(c.angle) * CHOPPER_RADIUS,
      c.centre.y,
      c.centre.z + Math.sin(c.angle) * CHOPPER_RADIUS,
    );
    c.mesh.position.copy(c.position);
    // Nose along the tangent of the circle.
    c.mesh.rotation.y = -c.angle + Math.PI * 0.5;
  }

  _updateChoppers(dt) {
    for (let i = 0; i < this._choppers.length; i++) {
      const c = this._choppers[i];
      if (!c.active) continue;
      c.life -= dt;
      if (c.life <= 0) { this._despawnChopper(c); continue; }
      c.angle += CHOPPER_SPIN * dt;
      this._placeChopper(c);

      c.acquireTimer -= dt;
      if (c.acquireTimer <= 0) {
        c.acquireTimer = CHOPPER_ACQUIRE;
        c.target = this._acquire(c, CHOPPER_RANGE, 0.35);
      }
      const t = c.target;
      if (!t || !t.alive) continue;

      c.fireTimer -= dt;
      if (c.fireTimer > 0) continue;
      c.fireTimer = CHOPPER_BURST;
      this._eyeOf(t, _eye);
      this._fireAt(c, c.position, _eye, CHOPPER_DAMAGE, 'chopper', 0.045);
      this._sfx('chopper', 'lmg', { position: c.position, volume: 0.5 });
      if (t.isPlayer) this.game.fx?.screenShake?.(0.08, 0.18);
    }
  }

  // -------------------------------------------------------- shared engagement

  /** Nearest hostile with clear LOS from `hw` (sentry/chopper). */
  _acquire(hw, range, minAccuracyDot) {
    const ents = this.game.entities;
    const from = hw.kind === 'sentry'
      ? _v2.set(hw.position.x, hw.position.y + 0.62, hw.position.z)
      : _v2.copy(hw.position);
    let best = null;
    let bestD = range * range;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e.alive) continue;
      if (!this._hostile(hw, e)) continue;
      if (this.match?.isProtected?.(e)) continue;
      const dSq = from.distanceToSquared(e.position);
      if (dSq > bestD) continue;
      this._eyeOf(e, _eye);
      if (this.game.world?.losClear && !this.game.world.losClear(from, _eye)) continue;
      bestD = dSq;
      best = e;
    }
    return best;
  }

  _hostile(hw, e) {
    const m = this.match;
    if (m && typeof m.areEnemies === 'function' && hw.ownerEntity) return m.areEnemies(hw.ownerEntity, e);
    return e.team !== hw.team;
  }

  /**
   * One shot from streak hardware. Uses ballistics when it is available so hitmarkers,
   * blood, decals and the `damage`/`kill` chain all behave exactly like player fire.
   */
  _fireAt(hw, from, to, damage, weaponId, spread) {
    _dir.copy(to).sub(from);
    const dist = _dir.length();
    if (dist < 1e-3) return;
    _dir.multiplyScalar(1 / dist);
    if (spread > 0) {
      const rng = this.game.rng || Math.random;
      _dir.x += ((typeof rng === 'function' ? rng() : Math.random()) - 0.5) * spread;
      _dir.y += ((typeof rng === 'function' ? rng() : Math.random()) - 0.5) * spread;
      _dir.z += ((typeof rng === 'function' ? rng() : Math.random()) - 0.5) * spread;
      _dir.normalize();
    }

    if (this._ballistics) {
      this._ballistics.fireHitscan(this.game, {
        shooter: hw, weaponId, origin: from, dir: _dir,
        damage, range: dist + 8,
        falloffStart: 60, falloffEnd: 140, falloffMin: 0.7,
        penetration: 0, tracer: true,
      });
      return;
    }

    // Fallback: world-blocked direct damage plus a tracer so it still reads on screen.
    const world = this.game.world;
    const hit = world?.raycast?.(from, _dir, dist);
    _v3.copy(from).addScaledVector(_dir, hit?.distance ?? dist);
    this.game.fx?.tracer?.(from, _v3, 420, 0.035, 0xffd9a0);
    if (hit && hit.distance < dist - 0.6) {
      this.game.bus?.emit('impact', { point: hit.point, normal: hit.normal, surface: hit.surface, weaponId });
      return;
    }
    const target = hw.target;
    if (!target?.alive) return;
    this._eyeOf(target, _eye);
    target.applyDamage?.(damage, {
      attacker: hw, hitPart: 'torso', point: _eye, normal: _dir, weaponId,
    });
    this.game.bus?.emit('damage', {
      target, attacker: hw, amount: damage, hitPart: 'torso',
      point: _eye, normal: _dir, weaponId, headshot: false,
    });
  }

  // ------------------------------------------------- incoming damage on hardware

  /**
   * Streak hardware is not in `game.entities`, so ballistics never tests it. Resolve
   * player/bot fire against sentry boxes ourselves off the canonical `shot` event.
   */
  _onShot(p) {
    if (!p?.origin || !p?.dir) return;
    let hitS = null;
    let hitDist = Infinity;
    for (let i = 0; i < this._sentries.length; i++) {
      const s = this._sentries[i];
      if (!s.active) continue;
      const d = this._raySentry(p.origin, p.dir, s);
      if (d >= 0 && d < hitDist) { hitDist = d; hitS = s; }
    }
    if (!hitS) return;
    // Do not let a shot punch through a wall to reach the turret.
    const wall = this.game.world?.raycast?.(p.origin, p.dir, hitDist);
    if (wall && wall.distance < hitDist - 0.05) return;

    const shooter = p.shooter;
    if (shooter && !this._hostile(hitS, shooter) && shooter !== hitS.ownerEntity) return;
    const def = this._weaponDef(p.weaponId);
    const dmg = def?.damage ?? 30;
    _v1.copy(p.origin).addScaledVector(p.dir, hitDist);
    this.game.fx?.impact?.(_v1, p.dir, 'metal');
    this.game.bus?.emit('hit', {
      shooter, target: hitS, point: _v1, normal: p.dir, headshot: false, surface: 'metal',
    });
    this._damageSentry(hitS, dmg, shooter);
  }

  _onExplosion(p) {
    if (!p?.point) return;
    const radius = p.radius || 0;
    for (let i = 0; i < this._sentries.length; i++) {
      const s = this._sentries[i];
      if (!s.active) continue;
      _v1.set(s.position.x, s.position.y + 0.5, s.position.z);
      const d = _v1.distanceTo(p.point);
      if (d > radius) continue;
      this._damageSentry(s, (p.damage || 100) * (1 - d / radius), p.attacker);
    }
  }

  _damageSentry(s, amount, attacker) {
    if (!s.active || amount <= 0) return;
    s.health -= amount;
    if (s.health > 0) return;
    this._despawnSentry(s, true);
    if (attacker?.isPlayer) this.match?.notice('SENTRY DESTROYED', '', 1.1);
    else if (s.ownerEntity?.isPlayer) this.match?.notice('SENTRY DOWN', 'Your turret was destroyed', 1.4);
  }

  /** Ray vs the sentry's box. Returns entry distance or -1. */
  _raySentry(origin, dir, s) {
    const hx = 0.4;
    const hy = 0.95;
    const hz = 0.4;
    const minx = s.position.x - hx;
    const maxx = s.position.x + hx;
    const miny = s.position.y;
    const maxy = s.position.y + hy;
    const minz = s.position.z - hz;
    const maxz = s.position.z + hz;
    const inv = 1 / (dir.x || 1e-9);
    let t1 = (minx - origin.x) * inv;
    let t2 = (maxx - origin.x) * inv;
    let tmin = Math.min(t1, t2);
    let tmax = Math.max(t1, t2);
    const invy = 1 / (dir.y || 1e-9);
    t1 = (miny - origin.y) * invy; t2 = (maxy - origin.y) * invy;
    tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
    const invz = 1 / (dir.z || 1e-9);
    t1 = (minz - origin.z) * invz; t2 = (maxz - origin.z) * invz;
    tmin = Math.max(tmin, Math.min(t1, t2)); tmax = Math.min(tmax, Math.max(t1, t2));
    if (tmax < 0 || tmin > tmax) return -1;
    return tmin < 0 ? 0 : tmin;
  }

  _weaponDef(id) {
    return id ? (getWeapon(id) || null) : null;
  }

  // ------------------------------------------------------------------ ticking

  fixedUpdate(dt) {
    // Activation itself arrives through Match.useKillstreak() — the player controller
    // owns the `killstreak` action and routes it to us, so we never poll input for it
    // and can never double-fire on a single press. The one thing we do watch is the
    // trigger, which confirms an airstrike heading.
    if (this._marking) {
      const input = this.game.input;
      if (input?.firePressed || this.now - this._marking.at > AIRSTRIKE_MARK_TIMEOUT) {
        this._confirmAirstrikeMark();
      }
    }

    // Bot activation.
    if (this._botUse.size > 0) {
      const now = this.now;
      for (const [id, at] of this._botUse) {
        if (now < at) continue;
        this._botUse.delete(id);
        const bot = this._entityById(id);
        if (bot?.alive) this.activate(bot);
      }
    }

    this._updateStrikes(dt);
    this._updateSentries(dt);
    this._updateChoppers(dt);
  }

  update(dtFrame) {
    // Visual-only: rotors.
    for (let i = 0; i < this._choppers.length; i++) {
      const c = this._choppers[i];
      if (!c.active) continue;
      c.rotor.rotation.y += dtFrame * 34;
      c.tailRotor.rotation.x += dtFrame * 46;
    }
  }

  /**
   * Called by Match when an entity dies. Deployed hardware keeps running (that is the
   * point of it), but a streak the player never got to call in is refunded rather than
   * silently swallowed.
   */
  onDeath(entity) {
    if (!entity) return;
    this._botUse.delete(entity.id);
    if (this._marking?.entity === entity) {
      const id = this._marking.id;
      this._marking = null;
      let inv = this.inventory.get(entity.id);
      if (!inv) this.inventory.set(entity.id, (inv = []));
      if (inv.length < INVENTORY_CAP) inv.unshift(id);
      if (entity.isPlayer) this.match?.notice('AIRSTRIKE HELD', 'Call it in when you respawn', 1.4);
    }
  }

  _entityById(id) {
    const ents = this.game.entities;
    for (let i = 0; i < ents.length; i++) if (ents[i].id === id) return ents[i];
    return null;
  }

  _eyeOf(entity, out) {
    if (typeof entity.getEyePosition === 'function') {
      const r = entity.getEyePosition(out);
      if (r) return r;
    }
    return out.set(entity.position.x, entity.position.y + (entity.eyeHeight || 1.62), entity.position.z);
  }

  /** Play `preferred` if the audio engine knows it, otherwise a guaranteed §9 name. */
  _sfx(preferred, fallback, opts) {
    const a = this.game.audio;
    if (!a?.play) return;
    let name = fallback;
    if (typeof a.has === 'function') { if (a.has(preferred)) name = preferred; }
    else if (a.sounds && (a.sounds instanceof Map ? a.sounds.has(preferred) : a.sounds[preferred])) name = preferred;
    try { a.play(name, opts); } catch { /* audio must never break the sim */ }
  }

  dispose() {
    for (const u of this._unsub) u?.();
    this._unsub.length = 0;
    if (this._group?.parent) this._group.parent.remove(this._group);
    if (this._geos) { for (const g of this._geos.values()) g.dispose(); this._geos.clear(); }
    if (this._mats) { for (const m of this._mats.values()) m.dispose(); this._mats.clear(); }
    this._sentries.length = 0;
    this._choppers.length = 0;
    this._strikes.length = 0;
  }
}
