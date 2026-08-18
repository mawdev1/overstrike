import * as THREE from 'three';
import { assets } from '../core/assets.js';
import { clamp } from '../core/mathUtils.js';
import { applyExplosionDamage } from './ballistics.js';
import { FRAG } from './weaponDefs.js';

/**
 * OVERSTRIKE — projectiles (grenades, tacticals, and anything else that flies).
 *
 * Fully pooled: every projectile, mesh and smoke cloud is allocated once in `init()` and
 * recycled forever. `fixedUpdate` does not allocate.
 *
 * Grenade physics is a swept segment against `world.raycast` each step, with a reflection
 * that splits into normal (restitution) and tangential (friction) components, then a roll
 * phase once the thing is slow and on the floor. That combination is what makes a frag
 * feel like an object rather than a particle: it clatters off a doorframe, skitters, and
 * settles somewhere you can read.
 */

const MAX_PROJECTILES = 40;
const MAX_SMOKE = 6;
const SKIN = 0.03;              // keeps the collision sphere off the surface
const REST_SPEED = 0.55;        // below this, on a floor, we switch to rolling
const SLEEP_SPEED = 0.12;
const WARN_INTERVAL = 1 / 15;   // HUD grenade indicator refresh
// Metres of flight between rocket exhaust puffs. Matches the internal step of
// fx.smokeTrail(), which is the spacing its 1.76 m sprites were sized to overlap at.
const TRAIL_STEP = 1.1;

// ------------------------------------------------------------------ scratch

const _v = new THREE.Vector3();
const _step = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _hitNormal = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _toBlast = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

const _warnEvt = { id: 0, kind: 'frag', position: new THREE.Vector3(), distance: 0, fuse: 0, owner: null, friendly: false };
const _flashEvt = { amount: 0, duration: 0, position: new THREE.Vector3() };
const _smokeEvt = { id: 0, position: new THREE.Vector3(), radius: 0, duration: 0 };

let _nextId = 1;

// ==================================================================== system

export class ProjectileSystem {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'projectiles';

    /** @type {Array} pooled projectile records */
    this.pool = [];
    /** @type {Array} pooled smoke clouds — also read by the AI for vision blocking */
    this.smokeClouds = [];

    this._warnTimer = 0;
    this._geoms = [];
  }

  async init() {
    this.game.scene.add(this.group);

    // Shared geometry: a faceted ball for frags, a can for tacticals, a dart for rockets.
    const ball = new THREE.IcosahedronGeometry(1, 0);
    const can = new THREE.CylinderGeometry(1, 1, 2, 8, 1, false);
    const dart = new THREE.ConeGeometry(1, 3, 6);
    this._geoms.push(ball, can, dart);

    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const mesh = new THREE.Mesh(ball, assets.mat('gunPolymer'));
      mesh.visible = false;
      mesh.castShadow = false;
      this.group.add(mesh);

      this.pool.push({
        id: 0,
        active: false,
        kind: 'frag',
        def: null,
        proj: null,
        owner: null,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        angVel: new THREE.Vector3(),
        fuse: 0,
        age: 0,
        radius: 0.055,
        resting: false,
        bounces: 0,
        trailFrom: new THREE.Vector3(),   // last point a smoke puff was laid at
        mesh,
        geoms: { ball, can, dart },
      });
    }

    for (let i = 0; i < MAX_SMOKE; i++) {
      this.smokeClouds.push({
        id: 0, active: false, position: new THREE.Vector3(),
        radius: 0, targetRadius: 0, t: 0, duration: 0, growTime: 1,
        puffAccum: 0, puffRate: 6, owner: null,
      });
    }
  }

  reset() {
    for (const p of this.pool) { p.active = false; p.mesh.visible = false; }
    for (const c of this.smokeClouds) {
      if (c.active) {
        _smokeEvt.id = c.id;
        _smokeEvt.position.copy(c.position);
        _smokeEvt.radius = c.radius;
        _smokeEvt.duration = 0;
        this.game.bus?.emit('smokeEnd', _smokeEvt);
      }
      c.active = false;
    }
    this._warnTimer = 0;
  }

  // ------------------------------------------------------------- spawning

  _acquire() {
    for (let i = 0; i < this.pool.length; i++) if (!this.pool[i].active) return this.pool[i];
    // Everything is live — recycle whichever has been alive longest.
    let oldest = this.pool[0];
    for (let i = 1; i < this.pool.length; i++) if (this.pool[i].age > oldest.age) oldest = this.pool[i];
    return oldest;
  }

  /**
   * Throw a grenade.
   * @param {object} owner entity throwing it
   * @param {THREE.Vector3} origin release point (usually eye + a little forward)
   * @param {THREE.Vector3} dir normalised aim direction
   * @param {number} power 0..1 — a drop at your feet through to a full overhand throw
   * @param {object} def weapon def with a `.projectile` block (defaults to FRAG)
   * @param {number} cooked seconds already burned off the fuse before release
   * @returns {boolean}
   */
  throwGrenade(owner, origin, dir, power = 1, def = FRAG, cooked = 0) {
    const d = def?.projectile ? def : FRAG;
    const pr = d.projectile;
    const p = this._acquire();

    const speed = pr.throwSpeedMin + (pr.throwSpeed - pr.throwSpeedMin) * clamp(power, 0, 1);
    p.id = _nextId++;
    p.active = true;
    p.kind = pr.kind;
    p.def = d;
    p.proj = pr;
    p.owner = owner || null;
    p.pos.copy(origin);
    p.vel.copy(dir).normalize().multiplyScalar(speed);
    p.vel.y += speed * (pr.upBias || 0);
    // Inherit the thrower's momentum — sprinting throws go further, as they should.
    if (owner?.velocity) p.vel.addScaledVector(owner.velocity, 0.55);
    // Tumble is mesh rotation only (see the fixedUpdate loop below) — never read by
    // position, velocity, bounce or damage — so it draws from fxRng, not the gameplay
    // stream. Originally left on game.rng on the mistaken assumption that "physics-
    // shaped" meant sim-critical; it is cosmetic exactly like the fire-sound pitch.
    p.angVel.set(
      (this.game.fxRng() - 0.5) * (pr.spin || 10),
      (this.game.fxRng() - 0.5) * (pr.spin || 10),
      (this.game.fxRng() - 0.5) * (pr.spin || 10),
    );
    p.fuse = Math.max(0.08, (pr.fuse || 3) - cooked);
    p.age = 0;
    p.radius = pr.radiusMesh || 0.055;
    p.resting = false;
    p.bounces = 0;
    p.trailFrom.copy(origin);

    this._dressMesh(p);
    p.mesh.position.copy(p.pos);
    p.mesh.visible = true;

    this.game.present.play('pinPull', { position: origin, volume: 0.8 });
    return true;
  }

  /**
   * Generic projectile spawn for weapon classes that fire something with a body
   * (launchers, under-barrel tubes). Anything with a `def.projectile` block works.
   */
  spawnProjectile(owner, def, origin, dir, speedOverride = 0) {
    const pr = def?.projectile;
    if (!pr) return false;
    const p = this._acquire();
    const speed = speedOverride || pr.speed || pr.throwSpeed || 45;

    p.id = _nextId++;
    p.active = true;
    p.kind = pr.kind || 'rocket';
    p.def = def;
    p.proj = pr;
    p.owner = owner || null;
    p.pos.copy(origin);
    p.vel.copy(dir).normalize().multiplyScalar(speed);
    p.angVel.set(0, 0, pr.spin || 0);
    p.fuse = pr.fuse ?? 8;
    p.age = 0;
    p.radius = pr.radiusMesh || 0.07;
    p.resting = false;
    p.bounces = 0;
    p.trailFrom.copy(origin);

    this._dressMesh(p);
    p.mesh.position.copy(p.pos);
    p.mesh.visible = true;
    return true;
  }

  _dressMesh(p) {
    const m = p.mesh;
    if (p.kind === 'rocket') {
      m.geometry = p.geoms.dart;
      m.material = assets.mat('gunmetal');
      m.scale.set(p.radius, p.radius * 1.4, p.radius);
    } else if (p.kind === 'smoke' || p.kind === 'flash') {
      m.geometry = p.geoms.can;
      m.material = assets.mat('gunmetal');
      m.scale.set(p.radius, p.radius * 1.25, p.radius);
    } else {
      m.geometry = p.geoms.ball;
      m.material = assets.mat('gunPolymer');
      m.scale.setScalar(p.radius);
    }
    m.rotation.set(0, 0, 0);
  }

  // ------------------------------------------------------------- simulation

  fixedUpdate(dt) {
    const world = this.game.world;

    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i];
      if (!p.active) continue;
      const pr = p.proj;
      p.age += dt;

      // ---- fuse
      p.fuse -= dt;
      if (p.fuse <= 0) { this._detonate(p); continue; }

      if (!p.resting) {
        if (p.kind !== 'rocket') p.vel.y += (pr.gravity ?? -22) * dt;

        _step.copy(p.vel).multiplyScalar(dt);
        let travel = _step.length();

        if (travel > 1e-6) {
          _dir.copy(_step).divideScalar(travel);

          // Rockets kill on contact with a body, so test entities first.
          if (pr.detonateOnImpact) {
            const hitEnt = this._segmentEntity(p, _dir, travel + p.radius);
            if (hitEnt) {
              p.pos.copy(_hitPoint);
              p.mesh.position.copy(p.pos);
              this._detonate(p);
              continue;
            }
          }

          const hit = world?.raycast?.(p.pos, _dir, travel + p.radius + SKIN);
          if (hit) {
            _hitPoint.copy(hit.point);
            _hitNormal.copy(hit.normal);
            const surface = hit.surface || 'concrete';

            if (pr.detonateOnImpact) {
              p.pos.copy(_hitPoint).addScaledVector(_hitNormal, 0.05);
              p.mesh.position.copy(p.pos);
              this._detonate(p);
              continue;
            }

            // Land just short of the wall, then reflect.
            const stop = Math.max(0, hit.distance - p.radius - SKIN);
            p.pos.addScaledVector(_dir, stop);
            p.pos.addScaledVector(_hitNormal, SKIN);

            const vn = p.vel.dot(_hitNormal);
            const impact = Math.abs(vn);
            // v' = (v - n*vn) * friction  -  n*vn*restitution
            p.vel.addScaledVector(_hitNormal, -vn);       // tangential only
            p.vel.multiplyScalar(pr.friction ?? 0.68);
            p.vel.addScaledVector(_hitNormal, -vn * (pr.restitution ?? 0.32));
            p.bounces++;
            p.angVel.multiplyScalar(0.72);

            if (impact > 1.2) {
              // Audio pitch variance only — presentation, drawn from fxRng.
              this.game.present.play('grenadeBounce', {
                position: p.pos,
                volume: clamp(impact / 12, 0.18, 0.9),
                rate: 0.9 + this.game.fxRng() * 0.3,
              });
              this.game.bus?.emit('grenadeBounce', { position: p.pos, surface, kind: p.kind });
            }

            // Settle: slow, on something floor-like -> roll, then sleep.
            if (_hitNormal.y > 0.55 && p.vel.lengthSq() < REST_SPEED * REST_SPEED) {
              p.vel.multiplyScalar(0.4);
              if (p.vel.lengthSq() < SLEEP_SPEED * SLEEP_SPEED) {
                p.vel.set(0, 0, 0);
                p.angVel.multiplyScalar(0.2);
                p.resting = true;
              }
            }
          } else {
            p.pos.add(_step);
          }
        }
      }

      p.mesh.position.copy(p.pos);

      // Rocket exhaust trail, rate-limited by DISTANCE FLOWN, not by step.
      //
      // This used to fire every fixed step: 120 calls/s, each one clamped by
      // smokeTrail() to at least one puff, so a single rocket laid 120-240 sprites per
      // second and held 130-480 of them alive at 1.76 m each. Those are the biggest
      // blended quads in the game and they sit right in front of the camera. One puff
      // per TRAIL_STEP metres is the density smokeTrail() itself was written for, and
      // it makes the trail resolution independent of frame rate as a bonus.
      if (p.kind === 'rocket') {
        if (p.trailFrom.distanceToSquared(p.pos) >= TRAIL_STEP * TRAIL_STEP) {
          this.game.present.smokeTrail(p.trailFrom, p.pos);
          p.trailFrom.copy(p.pos);
        }
      }
    }

    this._updateSmoke(dt);
    this._updateWarnings(dt);
  }

  /** Ray vs entities for contact-fused projectiles. Writes `_hitPoint`. */
  _segmentEntity(p, dir, dist) {
    const ents = this.game.entities;
    let best = Infinity, found = null;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e || !e.alive || e === p.owner) continue;
      const h = e.height || 1.8;
      _a.set(e.position.x, e.position.y + h * 0.5, e.position.z);
      _b.copy(_a).sub(p.pos);
      const along = _b.dot(dir);
      if (along < 0 || along > dist) continue;
      _v.copy(p.pos).addScaledVector(dir, along);
      const d = _v.distanceTo(_a);
      if (d > (e.radius || 0.36) + p.radius) continue;
      if (along >= best) continue;
      best = along;
      found = e;
      _hitPoint.copy(_v);
    }
    return found;
  }

  // ------------------------------------------------------------- detonation

  _detonate(p) {
    const pr = p.proj;
    const game = this.game;
    p.active = false;
    p.mesh.visible = false;

    switch (p.kind) {
      case 'smoke': this._popSmoke(p); break;
      case 'flash': this._popFlash(p); break;
      default: this._popExplosive(p); break;
    }

    // Tell the HUD its indicator is done with this one.
    if (pr.warnRadius > 0) {
      _warnEvt.id = p.id;
      _warnEvt.kind = p.kind;
      _warnEvt.position.copy(p.pos);
      _warnEvt.distance = 0;
      _warnEvt.fuse = 0;
      _warnEvt.owner = p.owner;
      _warnEvt.friendly = false;
      game.bus?.emit('grenadeWarningEnd', _warnEvt);
    }
  }

  _popExplosive(p) {
    const pr = p.proj;
    const game = this.game;

    applyExplosionDamage(game, {
      point: p.pos,
      radius: pr.radius,
      damage: pr.damage,
      attacker: p.owner,
      weaponId: p.def?.id || 'frag',
      falloff: pr.falloffPow ?? 1.35,
      selfMul: pr.selfDamageMul ?? 1,
    });

    // fx.explosion() already lays the scorch decal on the real ground it probes for
    // (fx.js), so no second decal here — that one landed at the burst's mid-air origin
    // and cost a second slot of the 256-slot ring per detonation.
    game.present.explosion(p.pos, pr.radius);
    // No `audio.play('explosion')` here either. `applyExplosionDamage()` above emits the
    // canonical `explosion` bus event unconditionally, and the audio engine's handler
    // plays the boom off it at priority 100 — louder and better defended than this call
    // was. See the note in fx.explosion(): between the three of them a single frag was
    // granting three voices out of a six-voice cap.

    // Shake scales with how close the player is and whether a wall is in the way.
    const player = game.player;
    if (player?.alive && pr.shakeAmount > 0) {
      if (typeof player.getEyePosition === 'function') player.getEyePosition(_eye);
      else _eye.copy(player.position);
      const d = _eye.distanceTo(p.pos);
      const falloff = clamp(1 - d / (pr.radius * 2.6), 0, 1);
      if (falloff > 0.01) {
        game.present.screenShake(pr.shakeAmount * falloff, pr.shakeDuration);
        game.present.flashDamage(falloff * 0.25);
      }
    }
  }

  _popFlash(p) {
    const pr = p.proj;
    const game = this.game;
    const world = game.world;

    game.present.explosion(p.pos, pr.radius * 0.25);
    game.present.play('explosion', { position: p.pos, volume: 0.9, rate: 1.7 });

    // Small concussive damage so a flash at your feet is not entirely free.
    if (pr.damage > 0) {
      applyExplosionDamage(game, {
        point: p.pos, radius: pr.radius * 0.25, damage: pr.damage,
        attacker: p.owner, weaponId: p.def?.id || 'flash', falloff: 1.6,
      });
    }

    const ents = game.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e || !e.alive) continue;
      if (typeof e.getEyePosition === 'function') e.getEyePosition(_eye);
      else _eye.set(e.position.x, e.position.y + 1.6, e.position.z);

      const dist = _eye.distanceTo(p.pos);
      if (dist > pr.radius) continue;
      // Line of sight is the entire contract: a wall or a corner saves you.
      if (world?.losClear && !world.losClear(p.pos, _eye)) continue;

      _toBlast.copy(p.pos).sub(_eye).normalize();
      let facing = 1;
      if (typeof e.getAimDirection === 'function') {
        e.getAimDirection(_aim);
        facing = clamp((_aim.dot(_toBlast) + 0.25) / 1.25, 0, 1);
      }
      const prox = 1 - clamp(dist / pr.radius, 0, 1);
      const t = clamp(facing * 0.72 + prox * 0.28, 0, 1) * (0.35 + prox * 0.65);
      const blind = pr.blindMin + (pr.blindMax - pr.blindMin) * t;
      if (blind <= 0.05) continue;

      e.blind = Math.max(e.blind || 0, blind);
      e.deaf = Math.max(e.deaf || 0, Math.min(pr.deafTime || 0, blind * 1.4));

      if (e.isPlayer) {
        _flashEvt.amount = clamp(t, 0, 1);
        _flashEvt.duration = blind;
        _flashEvt.position.copy(p.pos);
        game.bus?.emit('flashbang', _flashEvt);
        game.present.flashbang(clamp(t, 0, 1), blind);
        game.present.play('explosion', { position: _eye, volume: 0.5, rate: 0.35 });
      }
    }
  }

  _popSmoke(p) {
    const pr = p.proj;
    let cloud = null;
    for (const c of this.smokeClouds) if (!c.active) { cloud = c; break; }
    if (!cloud) {
      cloud = this.smokeClouds[0];
      for (const c of this.smokeClouds) if (c.t > cloud.t) cloud = c;
    }
    cloud.id = p.id;
    cloud.active = true;
    cloud.position.copy(p.pos);
    cloud.position.y += 0.35;
    cloud.radius = 0.4;
    cloud.targetRadius = pr.radius;
    cloud.duration = pr.duration || 12;
    cloud.growTime = pr.growTime || 1.6;
    cloud.t = 0;
    cloud.puffAccum = 0;
    cloud.owner = p.owner;
    cloud.puffRate = pr.puffRate || 6;

    this.game.present.play('explosion', { position: p.pos, volume: 0.35, rate: 0.4 });
    _smokeEvt.id = cloud.id;
    _smokeEvt.position.copy(cloud.position);
    _smokeEvt.radius = cloud.targetRadius;
    _smokeEvt.duration = cloud.duration;
    this.game.bus?.emit('smokeStart', _smokeEvt);
  }

  _updateSmoke(dt) {
    for (const c of this.smokeClouds) {
      if (!c.active) continue;
      c.t += dt;
      const grow = clamp(c.t / c.growTime, 0, 1);
      const fade = clamp((c.duration - c.t) / 2.5, 0, 1);
      c.radius = c.targetRadius * grow * (0.35 + fade * 0.65);

      // Puff position spread is presentation-only (visual scatter, no gameplay effect),
      // so it draws from fxRng rather than the gameplay stream.
      c.puffAccum += dt * c.puffRate * fade;
      while (c.puffAccum >= 1) {
        c.puffAccum -= 1;
        const rng = this.game.fxRng;
        const r = c.radius * 0.8;
        _a.set(
          c.position.x + rng.range(-r, r),
          c.position.y + rng.range(-r * 0.4, r * 0.7),
          c.position.z + rng.range(-r, r),
        );
        _b.copy(_a);
        _b.y += 0.6;
        this.game.present.smokeTrail(_a, _b);
      }

      if (c.t >= c.duration) {
        c.active = false;
        _smokeEvt.id = c.id;
        _smokeEvt.position.copy(c.position);
        _smokeEvt.radius = 0;
        _smokeEvt.duration = 0;
        this.game.bus?.emit('smokeEnd', _smokeEvt);
      }
    }
  }

  /**
   * Does a smoke cloud block this line? Used by the AI so bots respect a screen instead
   * of shooting straight through it.
   */
  smokeBlocks(from, to) {
    for (const c of this.smokeClouds) {
      if (!c.active || c.radius < 0.5) continue;
      _a.copy(to).sub(from);
      const len = _a.length();
      if (len < 1e-4) continue;
      _a.divideScalar(len);
      _b.copy(c.position).sub(from);
      const along = clamp(_b.dot(_a), 0, len);
      _v.copy(from).addScaledVector(_a, along);
      if (_v.distanceTo(c.position) < c.radius * 0.85) return true;
    }
    return false;
  }

  /** Throttled HUD indicator for live grenades near the player. */
  _updateWarnings(dt) {
    this._warnTimer -= dt;
    if (this._warnTimer > 0) return;
    this._warnTimer = WARN_INTERVAL;

    const player = this.game.player;
    if (!player || !player.alive) return;
    if (typeof player.getEyePosition === 'function') player.getEyePosition(_eye);
    else _eye.copy(player.position);

    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i];
      if (!p.active) continue;
      const warnR = p.proj.warnRadius || 0;
      if (warnR <= 0) continue;
      const d = _eye.distanceTo(p.pos);
      if (d > warnR) continue;

      _warnEvt.id = p.id;
      _warnEvt.kind = p.kind;
      _warnEvt.position.copy(p.pos);
      _warnEvt.distance = d;
      _warnEvt.fuse = p.fuse;
      _warnEvt.owner = p.owner;
      _warnEvt.friendly = !!(p.owner && p.owner.team === player.team);
      this.game.bus?.emit('grenadeWarning', _warnEvt);
    }
  }

  /** Visual-only tumble, so a grenade spins smoothly regardless of the sim rate. */
  update(dtFrame) {
    const dt = clamp(dtFrame, 0, 0.1);
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i];
      if (!p.active || p.resting) continue;
      if (p.kind === 'rocket') {
        _v.copy(p.vel);
        if (_v.lengthSq() > 1e-6) {
          p.mesh.lookAt(_v.add(p.mesh.position));
          p.mesh.rotateX(-Math.PI / 2);
        }
      } else {
        p.mesh.rotation.x += p.angVel.x * dt;
        p.mesh.rotation.y += p.angVel.y * dt;
        p.mesh.rotation.z += p.angVel.z * dt;
      }
    }
  }

  /** How many live grenades an entity has in the air (used by the AI to avoid spamming). */
  countLive(owner) {
    let n = 0;
    for (const p of this.pool) if (p.active && p.owner === owner) n++;
    return n;
  }

  dispose() {
    for (const g of this._geoms) g.dispose();
    this._geoms.length = 0;
    this.group.parent?.remove(this.group);
    this.pool.length = 0;
  }
}
