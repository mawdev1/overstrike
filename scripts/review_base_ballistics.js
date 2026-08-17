import * as THREE from 'three';
import { clamp } from '../src/core/mathUtils.js';

/**
 * OVERSTRIKE — hitscan ballistics.  (ARCHITECTURE.md §6)
 *
 * Everything in this file is allocation-free after module load. Rays are traced with
 * module-scope scratch vectors and every result object is pooled and reused, so a
 * 1000 rpm LMG spraying eight bots costs the garbage collector nothing.
 *
 * >>> ALL RETURNED OBJECTS ARE POOLED, and so are the bus payloads and the `info`
 * >>> object handed to `entity.applyDamage`. Read what you need synchronously; copy
 * >>> anything you intend to keep past the call. (Same contract as `world.move`, §5.)
 *
 * Trace order for a single shot:
 *   1. ray vs static world           -> wall distance + surface
 *   2. ray vs every live entity OBB  -> nearest hitbox, nearest-first, head wins ties
 *   3. whichever is closer wins — you can never shoot through a wall
 *   4. on a wall hit with penetration > 0, probe ~0.35 m for an exit face and, if the
 *      surface is thin, continue the ray ONCE with damage * penetration
 */

// ------------------------------------------------------------------ tuning

/** How far past an impact we look for the far side of a wall. */
const PENETRATION_PROBE = 0.35;
/** Nudge used to lift ray origins off surfaces so we never re-hit the face we exited. */
const EPS = 0.002;
/** A shot passing this close to the player's head plays a supersonic crack. */
const WHIZBY_RADIUS = 2.5;
/** Speed of sound-ish delay so a distant crack arrives late. */
const WHIZBY_SPEED = 340;

const SURFACE_SOUND = {
  concrete: 'impactConcrete',
  metal: 'impactMetal',
  wood: 'impactWood',
  dirt: 'impactDirt',
  sand: 'impactDirt',
  glass: 'impactGlass',
  flesh: 'fleshHit',
};

// ------------------------------------------------------------------ scratch

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _point = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _wallPoint = new THREE.Vector3();
const _wallNormal = new THREE.Vector3();
const _exitPoint = new THREE.Vector3();
const _exitNormal = new THREE.Vector3();
const _probeOrigin = new THREE.Vector3();
const _probeDir = new THREE.Vector3();
const _tracerFrom = new THREE.Vector3();
const _tracerTo = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _center = new THREE.Vector3();
const _tmp = new THREE.Vector3();

/** Pooled hit records. */
const _entHit = { distance: 0, part: 'torso', point: new THREE.Vector3(), normal: new THREE.Vector3() };
const _entsHit = { entity: null, distance: 0, part: 'torso', point: new THREE.Vector3(), normal: new THREE.Vector3() };
const _shotResult = {
  hitEntity: null, point: new THREE.Vector3(), distance: 0, headshot: false,
  part: null, surface: null, penetrated: false, damageDealt: 0, killed: false,
};

/** Payload objects reused for bus emissions (the bus dispatches synchronously). */
const _evShot = { shooter: null, weaponId: '', origin: new THREE.Vector3(), dir: new THREE.Vector3(), isPlayer: false };
const _evHit = { shooter: null, target: null, point: new THREE.Vector3(), normal: new THREE.Vector3(), headshot: false, surface: 'flesh' };
const _evImpact = { point: new THREE.Vector3(), normal: new THREE.Vector3(), surface: 'concrete', weaponId: '' };
const _evDamage = {
  target: null, attacker: null, amount: 0, hitPart: 'torso',
  point: new THREE.Vector3(), normal: new THREE.Vector3(), weaponId: '', headshot: false,
};
const _evExplosion = { point: new THREE.Vector3(), radius: 0, damage: 0, attacker: null, weaponId: '' };

// Local OBB working values (avoids returning tuples).
let _obbT = 0, _obbAxis = 0, _obbSign = 1;

// ------------------------------------------------------------------ hitbox maths

const HIT_MUL = { head: 4.2, torso: 1.0, limb: 0.82 };

/**
 * Ray vs one oriented box. The box is `hb.size` (full extents) centred on
 * `entity.position + hb.offset`, rotated about +Y by `entity.yaw`.
 *
 * Writes the entry distance / face axis / face sign into module locals and returns
 * true on a hit. Unrolled per axis so nothing is indexed or allocated.
 */
function rayOBB(entity, hb, ox, oy, oz, dx, dy, dz, maxDist) {
  const c = Math.cos(entity.yaw), s = Math.sin(entity.yaw);
  const px = ox - entity.position.x;
  const py = oy - entity.position.y;
  const pz = oz - entity.position.z;

  // World -> entity local: inverse of Ry(yaw).
  const lox = c * px - s * pz;
  const loy = py;
  const loz = s * px + c * pz;
  const ldx = c * dx - s * dz;
  const ldy = dy;
  const ldz = s * dx + c * dz;

  const hx = hb.size.x * 0.5, hy = hb.size.y * 0.5, hz = hb.size.z * 0.5;
  let tmin = -Infinity, tmax = Infinity;
  let axis = 0, sign = -1;

  // --- X slab
  if (ldx > -1e-8 && ldx < 1e-8) {
    if (lox < hb.offset.x - hx || lox > hb.offset.x + hx) return false;
  } else {
    const inv = 1 / ldx;
    let t1 = (hb.offset.x - hx - lox) * inv;
    let t2 = (hb.offset.x + hx - lox) * inv;
    let sg = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
    if (t1 > tmin) { tmin = t1; axis = 0; sign = sg; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  // --- Y slab
  if (ldy > -1e-8 && ldy < 1e-8) {
    if (loy < hb.offset.y - hy || loy > hb.offset.y + hy) return false;
  } else {
    const inv = 1 / ldy;
    let t1 = (hb.offset.y - hy - loy) * inv;
    let t2 = (hb.offset.y + hy - loy) * inv;
    let sg = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
    if (t1 > tmin) { tmin = t1; axis = 1; sign = sg; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  // --- Z slab
  if (ldz > -1e-8 && ldz < 1e-8) {
    if (loz < hb.offset.z - hz || loz > hb.offset.z + hz) return false;
  } else {
    const inv = 1 / ldz;
    let t1 = (hb.offset.z - hz - loz) * inv;
    let t2 = (hb.offset.z + hz - loz) * inv;
    let sg = -1;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sg = 1; }
    if (t1 > tmin) { tmin = t1; axis = 2; sign = sg; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }

  if (tmax < 0) return false;
  const t = tmin < 0 ? 0 : tmin;
  if (t > maxDist) return false;

  _obbT = t;
  _obbAxis = axis;
  _obbSign = sign;
  return true;
}

/** Rotate the local face normal recorded by rayOBB back into world space. */
function obbNormalToWorld(entity, out) {
  const c = Math.cos(entity.yaw), s = Math.sin(entity.yaw);
  if (_obbAxis === 0) out.set(c * _obbSign, 0, -s * _obbSign);
  else if (_obbAxis === 1) out.set(0, _obbSign, 0);
  else out.set(s * _obbSign, 0, c * _obbSign);
  return out;
}

/**
 * Ray vs one entity's OBB hitboxes.  (ARCHITECTURE.md §6)
 * Boxes are tested nearest-first; on a tie the more valuable part wins so a head that
 * shares a face with the torso still reads as a headshot.
 *
 * @returns {null | {distance:number, part:string, point:THREE.Vector3, normal:THREE.Vector3}} POOLED
 */
export function raycastEntity(entity, origin, dir, maxDist) {
  if (!entity || !entity.alive || !entity.hitboxes) return null;

  let bestT = Infinity, bestPart = null, bestAxis = 0, bestSign = 1;
  const boxes = entity.hitboxes;
  for (let i = 0; i < boxes.length; i++) {
    const hb = boxes[i];
    if (!rayOBB(entity, hb, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist)) continue;
    const better = _obbT < bestT - 1e-4
      || (_obbT < bestT + 1e-4 && (HIT_MUL[hb.part] ?? 1) > (HIT_MUL[bestPart] ?? 0));
    if (better) {
      bestT = _obbT;
      bestPart = hb.part;
      bestAxis = _obbAxis;
      bestSign = _obbSign;
    }
  }
  if (bestPart === null) return null;

  _obbAxis = bestAxis; _obbSign = bestSign;
  _entHit.distance = bestT;
  _entHit.part = bestPart;
  _entHit.point.copy(origin).addScaledVector(dir, bestT);
  obbNormalToWorld(entity, _entHit.normal);
  return _entHit;
}

/**
 * Ray vs every live entity except `exclude`.  (ARCHITECTURE.md §6)
 * @returns {null | {entity, distance, part, point, normal}} POOLED
 */
export function raycastEntities(game, origin, dir, maxDist, exclude) {
  const ents = game.entities;
  let best = Infinity;
  let found = false;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (e === exclude || !e.alive) continue;
    const h = raycastEntity(e, origin, dir, best < maxDist ? best : maxDist);
    if (!h || h.distance >= best) continue;
    best = h.distance;
    found = true;
    _entsHit.entity = e;
    _entsHit.distance = h.distance;
    _entsHit.part = h.part;
    _entsHit.point.copy(h.point);
    _entsHit.normal.copy(h.normal);
  }
  return found ? _entsHit : null;
}

// ------------------------------------------------------------------ damage gate

/**
 * The single place that decides whether damage is allowed to land at all.
 *
 * Everything that can hurt an entity (bullets, explosions, melee) multiplies by this, so
 * spawn protection and friendly fire can never be bypassed by one code path forgetting.
 * Returns a multiplier, normally 1.
 */
export function damageScale(game, attacker, target) {
  if (!target || target.alive === false) return 0;

  // Spawn protection — owned by Match, cancelled the instant the entity fires.
  const match = game.match;
  if (match) {
    const mul = match.damageMultiplierFor?.(target);
    if (typeof mul === 'number' && mul <= 0) return 0;
    // Pre-round freeze: nobody may deal damage before the countdown ends.
    if (attacker && match.canFire?.(attacker) === false) return 0;
  }

  if (!attacker || attacker === target) return 1;

  // Friendly fire is off in team modes. FFA gives every entity a unique team, so the
  // same-team test naturally never fires there.
  const teamBased = match?.mode?.teamBased ?? match?.teamBased ?? true;
  if (teamBased && attacker.team != null && attacker.team === target.team) return 0;

  return 1;
}

// ------------------------------------------------------------------ damage curve

/** 1.0 up to falloffStart, lerping to falloffMin at falloffEnd, floored after. */
export function falloffMultiplier(dist, falloffStart, falloffEnd, falloffMin) {
  if (!(falloffEnd > falloffStart)) return dist <= falloffStart ? 1 : falloffMin;
  if (dist <= falloffStart) return 1;
  if (dist >= falloffEnd) return falloffMin;
  const t = (dist - falloffStart) / (falloffEnd - falloffStart);
  return 1 + (falloffMin - 1) * t;
}

// ------------------------------------------------------------------ world probing

/** Cheap wrapper that copies the world's pooled raycast result into our scratch. */
let _wallDist = 0, _wallSurface = 'concrete', _wallHit = false;
function traceWorld(game, origin, dir, maxDist) {
  _wallHit = false;
  const w = game.world;
  if (!w || typeof w.raycast !== 'function') return false;
  const r = w.raycast(origin, dir, maxDist);
  if (!r) return false;
  _wallHit = true;
  _wallDist = r.distance;
  _wallSurface = r.surface || 'concrete';
  _wallPoint.copy(r.point);
  _wallNormal.copy(r.normal);
  return true;
}

/**
 * Is the surface we just hit thin enough to shoot through?
 *
 * We start `PENETRATION_PROBE` metres past the impact and cast BACK along the ray. The
 * first face we meet is the far side of the wall — and its normal points along the
 * bullet's travel, which is exactly what distinguishes it from the entry face we would
 * meet if the wall were thicker than the probe. Writes the exit point/normal on success.
 */
function probeExit(game, dirX, dirY, dirZ) {
  const w = game.world;
  if (!w || typeof w.raycast !== 'function') return false;
  const probe = PENETRATION_PROBE + EPS;
  _probeOrigin.set(
    _wallPoint.x + dirX * probe,
    _wallPoint.y + dirY * probe,
    _wallPoint.z + dirZ * probe,
  );
  _probeDir.set(-dirX, -dirY, -dirZ);
  const r = w.raycast(_probeOrigin, _probeDir, probe);
  if (!r) return false;                                   // still inside solid => too thick
  // Exit faces point downrange; the entry face points back at us.
  const facing = r.normal.x * dirX + r.normal.y * dirY + r.normal.z * dirZ;
  if (facing <= 0.05) return false;
  const thickness = probe - r.distance;
  if (thickness <= 1e-3 || thickness > PENETRATION_PROBE) return false;
  _exitPoint.copy(r.point);
  _exitNormal.copy(r.normal);
  return true;
}

// ------------------------------------------------------------------ feedback

function surfaceSound(surface) {
  return SURFACE_SOUND[surface] || 'impactConcrete';
}

function spawnImpact(game, weaponId, point, normal, surface, decalSize) {
  game.fx?.impact?.(point, normal, surface);
  game.fx?.decal?.(point, normal, surface, decalSize);
  game.audio?.play?.(surfaceSound(surface), { position: point, volume: 0.85 });
  _evImpact.point.copy(point);
  _evImpact.normal.copy(normal);
  _evImpact.surface = surface;
  _evImpact.weaponId = weaponId;
  game.bus?.emit('impact', _evImpact);
}

/**
 * Supersonic crack for rounds that pass near the player without hitting them.
 * Distance from the player's eye to the shot segment, clamped to the traced length.
 */
function whizby(game, shooter, ox, oy, oz, dx, dy, dz, length, hitPlayer) {
  const p = game.player;
  if (!p || !p.alive || p === shooter || hitPlayer) return;
  if (typeof p.getEyePosition !== 'function') return;
  p.getEyePosition(_eye);
  _rel.set(_eye.x - ox, _eye.y - oy, _eye.z - oz);
  let t = _rel.x * dx + _rel.y * dy + _rel.z * dz;
  if (t < 0) t = 0; else if (t > length) t = length;
  const cx = _rel.x - dx * t, cy = _rel.y - dy * t, cz = _rel.z - dz * t;
  const d2 = cx * cx + cy * cy + cz * cz;
  if (d2 > WHIZBY_RADIUS * WHIZBY_RADIUS) return;
  const d = Math.sqrt(d2);
  _tmp.set(ox + dx * t, oy + dy * t, oz + dz * t);
  game.audio?.play?.('whizby', {
    position: _tmp,
    volume: clamp(1 - d / WHIZBY_RADIUS, 0.15, 1) * 0.9,
    rate: 0.9 + (1 - d / WHIZBY_RADIUS) * 0.35,
    delay: t / WHIZBY_SPEED,
  });
}

// ------------------------------------------------------------------ fireHitscan

/**
 * One hitscan round.  (ARCHITECTURE.md §6)
 *
 * @param {object} game
 * @param {object} o
 *   shooter, weaponId, origin, dir, damage, range,
 *   falloffStart, falloffEnd, falloffMin, penetration, tracer
 * Optional extras used by weaponSystem:
 *   headshotMul  — overrides the global 4.2
 *   tracerFrom   — world-space muzzle position, so the streak leaves the barrel and
 *                  not the player's eyeball (the shot itself still starts at the eye)
 *   tracerColor, tracerWidth, tracerSpeed
 *   emitShot     — false for pellets 2..n of a shotgun blast
 *   decalSize
 * @returns {{hitEntity, point:THREE.Vector3, distance:number, headshot:boolean}} POOLED
 */
export function fireHitscan(game, o) {
  const shooter = o.shooter || null;
  const weaponId = o.weaponId || '';
  const range = o.range ?? 120;
  const penetration = o.penetration ?? 0;
  const headMul = o.headshotMul ?? HIT_MUL.head;

  _origin.copy(o.origin);
  _dir.copy(o.dir).normalize();

  const res = _shotResult;
  res.hitEntity = null;
  res.point.copy(_origin).addScaledVector(_dir, range);
  res.distance = range;
  res.headshot = false;
  res.part = null;
  res.surface = null;
  res.penetrated = false;
  res.damageDealt = 0;
  res.killed = false;

  if (o.emitShot !== false) {
    _evShot.shooter = shooter;
    _evShot.weaponId = weaponId;
    _evShot.origin.copy(_origin);
    _evShot.dir.copy(_dir);
    _evShot.isPlayer = !!(shooter && shooter.isPlayer);
    game.bus?.emit('shot', _evShot);
  }

  // Tracer always leaves the muzzle, never the eye.
  if (o.tracerFrom) _tracerFrom.copy(o.tracerFrom); else _tracerFrom.copy(_origin);

  let damage = o.damage ?? 30;
  let segOriginX = _origin.x, segOriginY = _origin.y, segOriginZ = _origin.z;
  let remaining = range;
  let travelled = 0;
  let segment = 0;
  let hitPlayer = false;
  let endSet = false;

  // Up to two segments: the shot, and one continuation through a thin surface.
  while (segment < 2) {
    _origin.set(segOriginX, segOriginY, segOriginZ);
    const wall = traceWorld(game, _origin, _dir, remaining);
    const wallDist = wall ? _wallDist : Infinity;
    const wallSurface = wall ? _wallSurface : 'concrete';
    if (wall) { _point.copy(_wallPoint); _normal.copy(_wallNormal); }

    let ent = raycastEntities(game, _origin, _dir, Math.min(remaining, wallDist), shooter);

    // A target we are not allowed to hurt (teammate, spawn-protected, already dead)
    // must not register as a hit at all — otherwise the shooter gets a hitmarker and
    // a blood spray for a bullet that did nothing. The round passes through instead.
    if (ent && damageScale(game, shooter, ent.entity) <= 0) ent = null;

    if (ent && ent.distance <= wallDist) {
      // ---------------------------------------------------------- entity hit
      const target = ent.entity;
      const dist = travelled + ent.distance;
      const mul = falloffMultiplier(dist, o.falloffStart ?? range, o.falloffEnd ?? range, o.falloffMin ?? 1);
      const partMul = ent.part === 'head' ? headMul : (HIT_MUL[ent.part] ?? 1);
      const amount = damage * mul * partMul;
      const headshot = ent.part === 'head';

      res.hitEntity = target;
      res.point.copy(ent.point);
      res.distance = dist;
      res.headshot = headshot;
      res.part = ent.part;
      res.surface = 'flesh';
      res.damageDealt = amount;
      if (target === game.player) hitPlayer = true;

      _tracerTo.copy(ent.point);
      endSet = true;

      game.fx?.bloodSpray?.(ent.point, ent.normal, clamp(amount / 45, 0.3, 2.2));
      game.audio?.play?.(headshot ? 'headshot' : 'fleshHit', { position: ent.point, volume: 0.95 });

      _evHit.shooter = shooter;
      _evHit.target = target;
      _evHit.point.copy(ent.point);
      _evHit.normal.copy(ent.normal);
      _evHit.headshot = headshot;
      _evHit.surface = 'flesh';
      game.bus?.emit('hit', _evHit);

      _evDamage.target = target;
      _evDamage.attacker = shooter;
      _evDamage.amount = amount;
      _evDamage.hitPart = ent.part;
      _evDamage.point.copy(ent.point);
      _evDamage.normal.copy(ent.normal);
      _evDamage.weaponId = weaponId;
      _evDamage.headshot = headshot;
      game.bus?.emit('damage', _evDamage);

      const wasAlive = target.alive;
      target.applyDamage?.(amount, _evDamage);
      res.killed = wasAlive && !target.alive;
      break;
    }

    if (wall) {
      // ------------------------------------------------------------ wall hit
      const dist = travelled + wallDist;
      res.point.copy(_point);
      res.distance = dist;
      res.surface = wallSurface;
      _tracerTo.copy(_point);
      endSet = true;

      spawnImpact(game, weaponId, _point, _normal, wallSurface, o.decalSize ?? 0.16);

      const canPunch = penetration > 0 && segment === 0 && remaining - wallDist > 0.5;
      if (canPunch && probeExit(game, _dir.x, _dir.y, _dir.z)) {
        // Exit spall on the far side, then carry on with reduced damage.
        spawnImpact(game, weaponId, _exitPoint, _exitNormal, wallSurface, (o.decalSize ?? 0.16) * 1.25);
        damage *= penetration;
        const consumed = _exitPoint.distanceTo(_point) + wallDist;
        travelled += consumed;
        remaining -= consumed + EPS;
        segOriginX = _exitPoint.x + _dir.x * EPS;
        segOriginY = _exitPoint.y + _dir.y * EPS;
        segOriginZ = _exitPoint.z + _dir.z * EPS;
        res.penetrated = true;
        segment++;
        if (remaining > 0.25) continue;
      }
      break;
    }

    // --------------------------------------------------------- nothing hit
    res.point.set(
      segOriginX + _dir.x * remaining,
      segOriginY + _dir.y * remaining,
      segOriginZ + _dir.z * remaining,
    );
    res.distance = travelled + remaining;
    _tracerTo.copy(res.point);
    endSet = true;
    break;
  }

  if (!endSet) _tracerTo.copy(res.point);

  if (o.tracer) {
    game.fx?.tracer?.(
      _tracerFrom, _tracerTo,
      o.tracerSpeed ?? 340,
      o.tracerWidth ?? 0.02,
      o.tracerColor ?? 0xffd08a,
    );
  }

  whizby(game, shooter, o.origin.x, o.origin.y, o.origin.z, _dir.x, _dir.y, _dir.z, res.distance, hitPlayer);

  return res;
}

// ------------------------------------------------------------------ explosions

const _expCenter = new THREE.Vector3();
const _expHead = new THREE.Vector3();
const _expFeet = new THREE.Vector3();
const _expDirWorld = new THREE.Vector3();

/**
 * Radial damage with line-of-sight occlusion — a wall protects you.
 *
 * Three probes per entity (chest, head, feet) so crouching behind a low crate reduces
 * exposure instead of flipping it on/off, which is what makes grenade play readable.
 *
 * @param {object} game
 * @param {{point:THREE.Vector3, radius:number, damage:number, attacker:object,
 *          weaponId:string, falloff?:number, selfMul?:number}} o
 * @returns {number} number of entities damaged
 */
export function applyExplosionDamage(game, o) {
  const point = o.point;
  const radius = Math.max(0.01, o.radius ?? 5);
  const baseDamage = o.damage ?? 100;
  const attacker = o.attacker ?? null;
  const weaponId = o.weaponId ?? 'frag';
  const pow = o.falloff ?? 1.35;
  const selfMul = o.selfMul ?? 1;

  _evExplosion.point.copy(point);
  _evExplosion.radius = radius;
  _evExplosion.damage = baseDamage;
  _evExplosion.attacker = attacker;
  _evExplosion.weaponId = weaponId;
  game.bus?.emit('explosion', _evExplosion);

  const ents = game.entities;
  const world = game.world;
  let count = 0;

  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e || !e.alive) continue;

    const h = e.height || 1.8;
    _expCenter.set(e.position.x, e.position.y + h * 0.55, e.position.z);
    const dist = _expCenter.distanceTo(point);
    if (dist > radius) continue;

    // Exposure: how many of the three probes can see the blast.
    let exposure = 0;
    if (!world || typeof world.losClear !== 'function') {
      exposure = 1;
    } else {
      _expHead.set(e.position.x, e.position.y + h * 0.92, e.position.z);
      _expFeet.set(e.position.x, e.position.y + 0.18, e.position.z);
      if (world.losClear(point, _expCenter)) exposure += 0.5;
      if (world.losClear(point, _expHead)) exposure += 0.25;
      if (world.losClear(point, _expFeet)) exposure += 0.25;
    }
    if (exposure <= 0) continue;

    const t = clamp(dist / radius, 0, 1);
    let amount = baseDamage * Math.pow(1 - t, pow) * exposure;
    // Self-damage is always allowed (that is what selfMul is for); everything else
    // goes through the shared gate so spawn protection and friendly fire hold.
    if (e === attacker) amount *= selfMul;
    else amount *= damageScale(game, attacker, e);
    if (amount < 1) continue;

    _expDirWorld.copy(_expCenter).sub(point);
    if (_expDirWorld.lengthSq() < 1e-6) _expDirWorld.set(0, 1, 0);
    _expDirWorld.normalize();

    _evDamage.target = e;
    _evDamage.attacker = attacker;
    _evDamage.amount = amount;
    _evDamage.hitPart = 'torso';
    _evDamage.point.copy(_expCenter);
    _evDamage.normal.copy(_expDirWorld);
    _evDamage.weaponId = weaponId;
    _evDamage.headshot = false;
    game.bus?.emit('damage', _evDamage);

    e.applyDamage?.(amount, _evDamage);
    count++;
  }

  return count;
}

/**
 * Swept-sphere melee test — a short forgiving cone rather than a pinpoint ray, so a
 * knife lunge connects the way players expect it to.
 * @returns {null|{entity, distance, part, point, normal}} POOLED
 */
export function meleeSweep(game, attacker, origin, dir, reach, radius) {
  // A direct ray first (cheap, exact), then widen with a few offset probes.
  let hit = raycastEntities(game, origin, dir, reach, attacker);
  if (hit) return hit;

  const ents = game.entities;
  let best = Infinity;
  let found = null;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (e === attacker || !e || !e.alive) continue;
    const h = e.height || 1.8;
    _center.set(e.position.x, e.position.y + h * 0.5, e.position.z);
    _rel.copy(_center).sub(origin);
    const along = _rel.dot(dir);
    if (along < -0.2 || along > reach) continue;
    _tmp.copy(origin).addScaledVector(dir, clamp(along, 0, reach));
    const d = _tmp.distanceTo(_center);
    if (d > radius + (e.radius || 0.36)) continue;
    if (along >= best) continue;
    best = along;
    _entsHit.entity = e;
    _entsHit.distance = along;
    _entsHit.part = 'torso';
    _entsHit.point.copy(_tmp);
    _entsHit.normal.copy(dir).multiplyScalar(-1);
    found = _entsHit;
  }
  return found;
}

/** Apply a melee hit found by `meleeSweep` (kept here so damage routing lives in one file). */
export function applyMeleeDamage(game, attacker, hit, amount, weaponId) {
  if (!hit || !hit.entity) return 0;
  const target = hit.entity;
  amount *= damageScale(game, attacker, target);
  if (amount <= 0) return 0;
  game.fx?.bloodSpray?.(hit.point, hit.normal, 2.0);
  game.audio?.play?.('fleshHit', { position: hit.point, volume: 1.0 });

  _evHit.shooter = attacker;
  _evHit.target = target;
  _evHit.point.copy(hit.point);
  _evHit.normal.copy(hit.normal);
  _evHit.headshot = false;
  _evHit.surface = 'flesh';
  game.bus?.emit('hit', _evHit);

  _evDamage.target = target;
  _evDamage.attacker = attacker;
  _evDamage.amount = amount;
  _evDamage.hitPart = 'torso';
  _evDamage.point.copy(hit.point);
  _evDamage.normal.copy(hit.normal);
  _evDamage.weaponId = weaponId;
  _evDamage.headshot = false;
  game.bus?.emit('damage', _evDamage);

  target.applyDamage?.(amount, _evDamage);
  return amount;
}

