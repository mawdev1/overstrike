import * as THREE from 'three';
import { WEAPON_LIST } from '../weapons/weaponDefs.js';

/**
 * OVERSTRIKE — game modes.
 *
 * Each mode is a self-contained rule object. The Match is the referee: it owns the clock,
 * the stat book and respawns; the mode owns *what scoring means*. Modes are stateless
 * singletons — all mutable state lives in `match.modeState`, which the Match clears on
 * every `begin()`, so a mode object can never leak state between matches.
 *
 * Contract (every mode):
 *   id, name, description, teamBased, scoreLimit, timeLimit, hudLabels
 *   init(match)                 — build any props/state (optional)
 *   cleanup(match)              — tear them down (optional)
 *   onSpawn(match, entity)      — an entity just (re)entered the world
 *   onKill(match, payload)      — canonical `kill` payload, already stat-booked
 *   onTick(match, dt)           — fixed 1/120 step
 *   checkEnd(match)             — null | { winner, winnerTeam, winnerEntity, reason }
 *   hudScores(match, out)       — fills [left, right] for hud.setScore
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

export const TEAM_COLORS = [0x4ea6ff, 0xff7a3c];
export const TEAM_NAMES = ['ALPHA', 'BRAVO'];

const MINUTES = (m) => m * 60;

// ---------------------------------------------------------------- shared helpers

/**
 * The selectable firearms. `WEAPON_LIST` (pure data, §7) is the source of truth; a
 * curated list published by the weapon system wins if one ever appears.
 * @returns {Array<object>}
 */
export function getWeaponDefs(game) {
  const w = game?.weapons;
  const cand = w?.list ?? w?.WEAPON_LIST ?? w?.weaponDefs ?? null;
  if (Array.isArray(cand) && cand.length) return cand;
  if (cand && typeof cand === 'object') {
    const vals = Object.values(cand);
    if (vals.length) return vals;
  }
  return WEAPON_LIST;
}

/** Class ordering for the gun-game ladder: start weak and close, finish precise. */
const CLASS_RANK = { pistol: 0, shotgun: 1, smg: 2, ar: 3, lmg: 4, launcher: 5, sniper: 6 };

/**
 * Every weapon in the game, ordered into a sensible progression.
 * Cached per def-list identity so we sort once, not once per kill.
 */
let _ladderCache = null;
let _ladderSrc = null;
let _ladderLen = -1;
export function getWeaponLadder(game) {
  const defs = getWeaponDefs(game);
  if (game?.weapons === _ladderSrc && defs.length === _ladderLen && _ladderCache) return _ladderCache;
  const list = defs.filter((d) => d && d.id && d.class !== 'grenade' && d.class !== 'melee');
  list.sort((a, b) => {
    const ra = CLASS_RANK[a.class] ?? 9;
    const rb = CLASS_RANK[b.class] ?? 9;
    if (ra !== rb) return ra - rb;
    return (a.damage || 0) - (b.damage || 0);
  });
  _ladderSrc = game?.weapons ?? null;
  _ladderLen = defs.length;
  _ladderCache = list.map((d) => d.id);
  return _ladderCache;
}

/**
 * Put `weaponId` in `entity`'s hands. The weapon system owns the real API; we try the
 * documented-ish names in order and always announce the result on the bus so viewmodel,
 * HUD and audio stay in sync regardless of which path took.
 * @returns {boolean} true if something plausibly happened.
 */
export function equipWeapon(game, entity, weaponId) {
  if (!game || !entity || !weaponId) return false;
  const w = game.weapons;
  const _equip = [weaponId];
  if (w) {
    // The real path: giveLoadout() builds the instance, equips slot 0 instantly and
    // announces `weaponSwitch` itself. Works for the player and for bots.
    if (typeof w.giveLoadout === 'function') {
      if (w.giveLoadout(entity, _equip)) return true;
    }
    if (typeof w.giveWeapon === 'function' && w.giveWeapon(entity, weaponId) !== false) {
      game.bus?.emit('weaponSwitch', { shooter: entity, weaponId });
      return true;
    }
    for (const n of ['createInstance', 'create', 'makeInstance', 'instantiate']) {
      if (typeof w[n] !== 'function') continue;
      try {
        const inst = w[n](weaponId, entity);
        if (inst && typeof inst.tryFire === 'function') {
          entity.weapon = inst;
          game.bus?.emit('weaponSwitch', { shooter: entity, weaponId });
          return true;
        }
      } catch { /* signature mismatch — keep probing */ }
    }
  }
  // Last resort: swap the def under whatever instance the entity is already holding
  // (bots fall back to a local stand-in weapon). Gun game still functions.
  const inst = entity.weapon;
  const def = getWeaponDefs(game).find((d) => d && d.id === weaponId);
  if (inst && def) {
    inst.def = def;
    inst.ammo = def.magSize ?? inst.ammo;
    inst.reserve = def.reserve ?? inst.reserve;
    game.bus?.emit('weaponSwitch', { shooter: entity, weaponId });
    return true;
  }
  return false;
}

function weaponName(game, id) {
  const defs = getWeaponDefs(game);
  for (const d of defs) if (d && d.id === id) return d.name || id;
  return id || 'WEAPON';
}

/** Standard "score limit or clock" ending for team modes. */
function endByTeamScore(match, limit) {
  const s = match.scores;
  if (s[0] >= limit) return { winner: 0, winnerTeam: 0, winnerEntity: null, reason: 'score' };
  if (s[1] >= limit) return { winner: 1, winnerTeam: 1, winnerEntity: null, reason: 'score' };
  if (match.timeRemaining <= 0) {
    if (s[0] === s[1]) return { winner: -1, winnerTeam: -1, winnerEntity: null, reason: 'draw' };
    const t = s[0] > s[1] ? 0 : 1;
    return { winner: t, winnerTeam: t, winnerEntity: null, reason: 'time' };
  }
  return null;
}

/** Standard "first to N kills or clock" ending for free-for-all modes. */
function endByBestPlayer(match, limit, statKey = 'kills') {
  let best = null;
  let bestVal = -1;
  let tie = false;
  for (const e of match.game.entities) {
    const st = match.statsFor(e);
    if (!st) continue;
    const v = st[statKey] || 0;
    if (v > bestVal) { bestVal = v; best = e; tie = false; }
    else if (v === bestVal) tie = true;
  }
  if (best && limit > 0 && bestVal >= limit) {
    return { winner: best, winnerTeam: -1, winnerEntity: best, reason: 'score' };
  }
  if (match.timeRemaining <= 0) {
    if (!best || tie) return { winner: -1, winnerTeam: -1, winnerEntity: best, reason: 'time' };
    return { winner: best, winnerTeam: -1, winnerEntity: best, reason: 'time' };
  }
  return null;
}

// ------------------------------------------------------------------------ TDM

const TDM = {
  id: 'tdm',
  name: 'TEAM DEATHMATCH',
  description: 'Two squads. First to 75 eliminations takes it.',
  teamBased: true,
  scoreLimit: 75,
  timeLimit: MINUTES(10),
  hudLabels: { left: TEAM_NAMES[0], right: TEAM_NAMES[1], metric: 'KILLS', objective: 'ELIMINATE THE ENEMY TEAM' },

  init() {},
  cleanup() {},
  onSpawn() {},

  onKill(match, p) {
    const a = p.attacker;
    const v = p.victim;
    if (!a || !v) return;
    if (a === v) { match.addTeamScore(v.team, -1); return; }
    if (a.team === v.team) { match.addTeamScore(a.team, -1); return; }
    match.addTeamScore(a.team, 1);
  },

  onTick() {},
  checkEnd(match) { return endByTeamScore(match, this.scoreLimit); },
  hudScores(match, out) { out[0] = match.scores[0]; out[1] = match.scores[1]; return out; },
};

// ------------------------------------------------------------------------ FFA

const FFA = {
  id: 'ffa',
  name: 'FREE-FOR-ALL',
  description: 'Everyone is hostile. First to 30 kills wins.',
  teamBased: false,
  scoreLimit: 30,
  timeLimit: MINUTES(10),
  hudLabels: { left: 'YOU', right: 'BEST', metric: 'KILLS', objective: 'KILL EVERYONE' },

  init() {},
  cleanup() {},
  onSpawn() {},

  onKill(match, p) {
    // Personal kill counts are the score in FFA; the Match already booked them.
    // Suicides cost you one so you cannot farm the clock by falling off the map.
    if (p.attacker === p.victim || !p.attacker) {
      const st = match.statsFor(p.victim);
      if (st) st.kills = Math.max(0, st.kills - 1);
    }
  },

  onTick() {},
  checkEnd(match) { return endByBestPlayer(match, this.scoreLimit, 'kills'); },

  hudScores(match, out) {
    const mine = match.statsFor(match.game.player)?.kills ?? 0;
    let best = 0;
    for (const e of match.game.entities) {
      if (e === match.game.player) continue;
      const st = match.statsFor(e);
      if (st && st.kills > best) best = st.kills;
    }
    out[0] = mine; out[1] = best;
    return out;
  },
};

// -------------------------------------------------------------------- GUN GAME

const GUNGAME = {
  id: 'gungame',
  name: 'GUN GAME',
  description: 'Every kill promotes you. Work through the whole arsenal to win.',
  teamBased: false,
  scoreLimit: 0, // derived from the ladder length at init
  timeLimit: MINUTES(10),
  hudLabels: { left: 'YOU', right: 'BEST', metric: 'TIER', objective: 'ADVANCE THROUGH EVERY WEAPON' },

  init(match) {
    const st = match.modeState;
    st.ladder = getWeaponLadder(match.game);
    st.tiers = new Map(); // entity.id -> tier index
    this.scoreLimit = st.ladder.length;
  },

  cleanup(match) {
    match.modeState.tiers?.clear();
  },

  tierOf(match, entity) {
    return match.modeState.tiers?.get(entity.id) ?? 0;
  },

  onSpawn(match, entity) {
    const st = match.modeState;
    if (!st.ladder || st.ladder.length === 0) return;
    if (!st.tiers.has(entity.id)) st.tiers.set(entity.id, 0);
    const tier = Math.min(st.tiers.get(entity.id), st.ladder.length - 1);
    equipWeapon(match.game, entity, st.ladder[tier]);
  },

  onKill(match, p) {
    const st = match.modeState;
    const a = p.attacker;
    if (!a || a === p.victim || !st.ladder || st.ladder.length === 0) return;

    const tier = Math.min((st.tiers.get(a.id) ?? 0) + 1, st.ladder.length);
    st.tiers.set(a.id, tier);
    // Mirror the tier into the stat book so the scoreboard and checkEnd can read it.
    const stats = match.statsFor(a);
    if (stats) stats.tier = tier;

    if (tier >= st.ladder.length) return; // won — checkEnd picks it up this frame

    const id = st.ladder[tier];
    if (a.alive) equipWeapon(match.game, a, id);
    if (a.isPlayer) {
      match.notice('PROMOTED', `${weaponName(match.game, id)}  ·  ${tier + 1}/${st.ladder.length}`, 1.5);
      match.game.audio?.play('switch', { volume: 0.8 });
    }
  },

  onTick() {},

  checkEnd(match) {
    const st = match.modeState;
    const len = st.ladder?.length ?? 0;
    if (len === 0) return match.timeRemaining <= 0
      ? { winner: -1, winnerTeam: -1, winnerEntity: null, reason: 'time' } : null;
    for (const e of match.game.entities) {
      if ((st.tiers.get(e.id) ?? 0) >= len) {
        return { winner: e, winnerTeam: -1, winnerEntity: e, reason: 'score' };
      }
    }
    return endByBestPlayer(match, 0, 'tier');
  },

  hudScores(match, out) {
    const st = match.modeState;
    out[0] = (st.tiers?.get(match.game.player?.id) ?? 0) + 1;
    let best = 0;
    for (const e of match.game.entities) {
      if (e === match.game.player) continue;
      const t = st.tiers?.get(e.id) ?? 0;
      if (t > best) best = t;
    }
    out[1] = best + 1;
    return out;
  },
};

// ------------------------------------------------------------------ DOMINATION

const ZONE_RADIUS = 5.0;
const ZONE_HEIGHT = 3.2;
const CAP_TIME = 7.0;          // seconds, solo
const CAP_DECAY = 0.35;        // progress lost per second when nobody is capping
const SCORE_TICK = 3.0;        // seconds between point ticks
const ZONE_LETTERS = ['A', 'B', 'C'];

const DOMINATION = {
  id: 'domination',
  name: 'DOMINATION',
  description: 'Capture and hold A, B and C. Points tick for every zone you own.',
  teamBased: true,
  scoreLimit: 200,
  timeLimit: MINUTES(10),
  hudLabels: { left: TEAM_NAMES[0], right: TEAM_NAMES[1], metric: 'SCORE', objective: 'CAPTURE AND HOLD THE OBJECTIVES' },

  init(match) {
    const st = match.modeState;
    st.zones = this._placeZones(match);
    st.tickTimer = 0;
    this._buildGfx(match, st.zones);
  },

  cleanup(match) {
    const gfx = match.modeState.gfx;
    if (gfx?.group?.parent) gfx.group.parent.remove(gfx.group);
  },

  /** Farthest-point sample over spawn points + open space so zones straddle the map. */
  _placeZones(match) {
    const world = match.game.world;
    const cands = [];
    const pts = world?.spawnPoints;
    if (Array.isArray(pts)) {
      for (const p of pts) if (p?.position) cands.push(_v1.copy(p.position).clone());
    }
    const sampled = match.spawner?.sampleOpenSpace?.(24);
    if (Array.isArray(sampled)) for (const p of sampled) cands.push(p.clone ? p.clone() : new THREE.Vector3(p.x, p.y, p.z));

    const b = world?.bounds;
    const centre = new THREE.Vector3();
    if (b?.min && b?.max) centre.copy(b.min).add(b.max).multiplyScalar(0.5);
    if (cands.length < 3) {
      // Degenerate level data: fall back to a line through the centre so the mode
      // still plays rather than crashing.
      const span = b?.max ? Math.max(8, (b.max.x - b.min.x) * 0.28) : 14;
      cands.length = 0;
      cands.push(new THREE.Vector3(centre.x - span, centre.y, centre.z));
      cands.push(new THREE.Vector3(centre.x, centre.y, centre.z));
      cands.push(new THREE.Vector3(centre.x + span, centre.y, centre.z));
    }

    // B: closest to the middle of the play space.
    let bIdx = 0;
    let bBest = Infinity;
    for (let i = 0; i < cands.length; i++) {
      const d = cands[i].distanceToSquared(centre);
      if (d < bBest) { bBest = d; bIdx = i; }
    }
    const B = cands[bIdx];

    // A: farthest from B.
    let aIdx = -1;
    let aBest = -1;
    for (let i = 0; i < cands.length; i++) {
      if (i === bIdx) continue;
      const d = cands[i].distanceToSquared(B);
      if (d > aBest) { aBest = d; aIdx = i; }
    }
    const A = cands[aIdx >= 0 ? aIdx : bIdx];

    // C: far from both, and preferably on the opposite side of B from A.
    _v2.copy(A).sub(B).setY(0);
    if (_v2.lengthSq() > 1e-4) _v2.normalize();
    let cIdx = -1;
    let cBest = -Infinity;
    for (let i = 0; i < cands.length; i++) {
      if (i === bIdx || i === aIdx) continue;
      const p = cands[i];
      const spread = Math.min(p.distanceTo(A), p.distanceTo(B));
      _v3.copy(p).sub(B).setY(0);
      const opposite = _v3.lengthSq() > 1e-4 ? -_v3.normalize().dot(_v2) : 0;
      const s = spread + opposite * 14;
      if (s > cBest) { cBest = s; cIdx = i; }
    }
    const C = cands[cIdx >= 0 ? cIdx : bIdx];

    return [A, B, C].map((pos, i) => ({
      letter: ZONE_LETTERS[i],
      position: pos.clone(),
      owner: -1,
      capTeam: -1,
      progress: 0,
      contested: false,
      counts: [0, 0],
    }));
  },

  _buildGfx(match, zones) {
    const st = match.modeState;
    let gfx = this._gfx;
    if (!gfx) {
      // One shared open cylinder + three materials = three draw calls for the objective.
      const geo = new THREE.CylinderGeometry(ZONE_RADIUS, ZONE_RADIUS, ZONE_HEIGHT, 22, 1, true);
      const group = new THREE.Group();
      group.name = 'dominationZones';
      const meshes = [];
      for (let i = 0; i < 3; i++) {
        const mat = new THREE.MeshBasicMaterial({
          color: 0xbfc7cf,
          transparent: true,
          opacity: 0.22,
          side: THREE.DoubleSide,
          depthWrite: false,
          fog: false,
        });
        const m = new THREE.Mesh(geo, mat);
        m.matrixAutoUpdate = false;
        m.renderOrder = 2;
        group.add(m);
        meshes.push(m);
      }
      gfx = this._gfx = { geo, group, meshes, lastOwner: [-2, -2, -2] };
    }
    for (let i = 0; i < 3; i++) {
      const m = gfx.meshes[i];
      const z = zones[i];
      m.position.set(z.position.x, z.position.y + ZONE_HEIGHT * 0.5, z.position.z);
      m.updateMatrix();
      gfx.lastOwner[i] = -2;
    }
    match.game.scene?.add(gfx.group);
    st.gfx = gfx;
  },

  onSpawn() {},

  onKill(match, p) {
    // Kills are worth personal score only; the objective drives the team score.
    if (p.attacker && p.attacker !== p.victim && match.areEnemies(p.attacker, p.victim)) {
      const zone = this._zoneAt(match, p.victim.position);
      if (zone && zone.owner === p.attacker.team) {
        match.addScore(p.attacker, 50, 'DEFEND');
        const st = match.statsFor(p.attacker);
        if (st) st.defends = (st.defends || 0) + 1;
      }
    }
  },

  _zoneAt(match, pos) {
    const zones = match.modeState.zones;
    if (!zones || !pos) return null;
    for (const z of zones) {
      const dx = pos.x - z.position.x;
      const dz = pos.z - z.position.z;
      const dy = pos.y - z.position.y;
      if (dx * dx + dz * dz <= ZONE_RADIUS * ZONE_RADIUS && dy > -2 && dy < ZONE_HEIGHT) return z;
    }
    return null;
  },

  onTick(match, dt) {
    const st = match.modeState;
    const zones = st.zones;
    if (!zones) return;

    const ents = match.game.entities;
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      z.counts[0] = 0;
      z.counts[1] = 0;
      for (let e = 0; e < ents.length; e++) {
        const ent = ents[e];
        if (!ent.alive) continue;
        const t = ent.team === 1 ? 1 : 0;
        const dx = ent.position.x - z.position.x;
        const dz = ent.position.z - z.position.z;
        const dy = ent.position.y - z.position.y;
        if (dy < -2 || dy > ZONE_HEIGHT) continue;
        if (dx * dx + dz * dz > ZONE_RADIUS * ZONE_RADIUS) continue;
        z.counts[t]++;
      }

      const a = z.counts[0];
      const b = z.counts[1];
      z.contested = a > 0 && b > 0;

      if (z.contested || (a === 0 && b === 0)) {
        z.progress = Math.max(0, z.progress - CAP_DECAY * dt);
        if (z.progress === 0) z.capTeam = -1;
        continue;
      }

      const team = a > 0 ? 0 : 1;
      const count = a > 0 ? a : b;
      if (team === z.owner) {
        // Owners standing on their own point just bleed off any enemy progress.
        z.progress = Math.max(0, z.progress - CAP_DECAY * 2 * dt);
        if (z.progress === 0) z.capTeam = -1;
        continue;
      }
      if (z.capTeam !== team) { z.capTeam = team; z.progress = 0; }
      const speed = Math.min(2.2, 1 + 0.6 * (count - 1));
      z.progress += (dt / CAP_TIME) * speed;
      if (z.progress >= 1) {
        const prevOwner = z.owner;
        z.owner = team;
        z.progress = 0;
        z.capTeam = -1;
        this._onCaptured(match, z, team, prevOwner);
      }
    }

    // Score ticks.
    st.tickTimer += dt;
    if (st.tickTimer >= SCORE_TICK) {
      st.tickTimer -= SCORE_TICK;
      let owned0 = 0;
      let owned1 = 0;
      for (const z of zones) {
        if (z.owner === 0) owned0++;
        else if (z.owner === 1) owned1++;
      }
      if (owned0) match.addTeamScore(0, owned0);
      if (owned1) match.addTeamScore(1, owned1);
    }

    this._syncGfx(match, zones);
  },

  _onCaptured(match, zone, team, prevOwner) {
    const ents = match.game.entities;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e.alive || (e.team === 1 ? 1 : 0) !== team) continue;
      const dx = e.position.x - zone.position.x;
      const dz = e.position.z - zone.position.z;
      if (dx * dx + dz * dz > ZONE_RADIUS * ZONE_RADIUS) continue;
      match.addScore(e, 200, 'CAPTURE');
      const st = match.statsFor(e);
      if (st) st.captures = (st.captures || 0) + 1;
    }
    const mine = team === match.playerTeam;
    match.notice(
      mine ? `${zone.letter} CAPTURED` : `${zone.letter} LOST`,
      mine ? 'Objective secured' : 'The enemy took the point',
      1.6,
    );
    match.game.audio?.play(mine ? 'killConfirm' : 'lowAmmo', { volume: 0.7 });
    if (prevOwner === -1 && !mine) match.game.fx?.screenShake?.(0.05, 0.2);
  },

  _syncGfx(match, zones) {
    const gfx = match.modeState.gfx;
    if (!gfx) return;
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i];
      // Encode "who owns it / who's capping" into one comparable key so we only touch
      // the material when something actually changed.
      const key = z.owner * 10 + (z.contested ? 5 : (z.capTeam + 2));
      if (gfx.lastOwner[i] === key) continue;
      gfx.lastOwner[i] = key;
      const mat = gfx.meshes[i].material;
      if (z.contested) mat.color.setHex(0xf2e14b);
      else if (z.owner >= 0) mat.color.setHex(TEAM_COLORS[z.owner]);
      else if (z.capTeam >= 0) mat.color.setHex(TEAM_COLORS[z.capTeam]);
      else mat.color.setHex(0xbfc7cf);
      mat.opacity = z.owner >= 0 ? 0.3 : 0.2;
    }
  },

  /** For the HUD: [{ letter, owner, progress, contested }] */
  getZoneStates(match) { return match.modeState.zones || null; },

  checkEnd(match) { return endByTeamScore(match, this.scoreLimit); },
  hudScores(match, out) { out[0] = match.scores[0]; out[1] = match.scores[1]; return out; },
};

// -------------------------------------------------------------- KILL CONFIRMED

const TAG_LIFETIME = 30;
const TAG_PICKUP_RADIUS = 1.8;
const TAG_MAX = 32;

const KILLCONFIRMED = {
  id: 'killconfirmed',
  name: 'KILL CONFIRMED',
  description: 'Kills mean nothing until you collect the tag. Deny your own.',
  teamBased: true,
  scoreLimit: 65,
  timeLimit: MINUTES(10),
  hudLabels: { left: TEAM_NAMES[0], right: TEAM_NAMES[1], metric: 'CONFIRMED', objective: 'COLLECT ENEMY TAGS · DENY YOUR OWN' },

  init(match) {
    const st = match.modeState;
    st.tags = [];
    for (let i = 0; i < TAG_MAX; i++) {
      st.tags.push({ active: false, team: 0, born: 0, position: new THREE.Vector3() });
    }
    st.tagBob = 0;
    this._buildGfx(match);
  },

  cleanup(match) {
    const gfx = match.modeState.gfx;
    if (gfx?.group?.parent) gfx.group.parent.remove(gfx.group);
  },

  _buildGfx(match) {
    let gfx = this._gfx;
    if (!gfx) {
      const geo = new THREE.OctahedronGeometry(0.24, 0);
      const group = new THREE.Group();
      group.name = 'killConfirmedTags';
      const meshes = [];
      for (let t = 0; t < 2; t++) {
        const mat = new THREE.MeshBasicMaterial({ color: TEAM_COLORS[t], fog: false });
        const im = new THREE.InstancedMesh(geo, mat, TAG_MAX);
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        im.frustumCulled = false;
        im.count = 0;
        group.add(im);
        meshes.push(im);
      }
      gfx = this._gfx = { geo, group, meshes };
    }
    gfx.meshes[0].count = 0;
    gfx.meshes[1].count = 0;
    match.game.scene?.add(gfx.group);
    match.modeState.gfx = gfx;
  },

  onSpawn() {},

  onKill(match, p) {
    const st = match.modeState;
    if (!st.tags) return;
    const v = p.victim;
    if (!v) return;
    let slot = null;
    let oldest = null;
    for (const t of st.tags) {
      if (!t.active) { slot = t; break; }
      if (!oldest || t.born < oldest.born) oldest = t;
    }
    if (!slot) slot = oldest;
    if (!slot) return;
    slot.active = true;
    slot.team = v.team === 1 ? 1 : 0;
    slot.born = match.elapsed;
    slot.position.set(v.position.x, v.position.y + 0.4, v.position.z);
  },

  onTick(match, dt) {
    const st = match.modeState;
    const tags = st.tags;
    if (!tags) return;
    st.tagBob += dt;

    const ents = match.game.entities;
    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i];
      if (!tag.active) continue;
      if (match.elapsed - tag.born > TAG_LIFETIME) { tag.active = false; continue; }
      for (let e = 0; e < ents.length; e++) {
        const ent = ents[e];
        if (!ent.alive) continue;
        const dx = ent.position.x - tag.position.x;
        const dz = ent.position.z - tag.position.z;
        const dy = ent.position.y + 0.9 - tag.position.y;
        if (dx * dx + dz * dz > TAG_PICKUP_RADIUS * TAG_PICKUP_RADIUS) continue;
        if (dy < -2.2 || dy > 2.5) continue;
        tag.active = false;
        this._collect(match, ent, tag);
        break;
      }
    }
    this._syncGfx(match, tags, st.tagBob);
  },

  _collect(match, entity, tag) {
    const team = entity.team === 1 ? 1 : 0;
    const stats = match.statsFor(entity);
    const isMine = team === match.playerTeam;
    if (team !== tag.team) {
      match.addTeamScore(team, 1);
      match.addScore(entity, 50, 'CONFIRMED');
      if (stats) stats.confirms = (stats.confirms || 0) + 1;
      if (entity.isPlayer) match.game.audio?.play('killConfirm', { volume: 0.9 });
      else if (isMine) match.game.audio?.play('killConfirm', { volume: 0.35, position: entity.position });
    } else {
      match.addScore(entity, 75, 'DENIED');
      if (stats) stats.denies = (stats.denies || 0) + 1;
      if (entity.isPlayer) match.game.audio?.play('hitmarker', { volume: 0.8, rate: 0.8 });
    }
  },

  _syncGfx(match, tags, bob) {
    const gfx = match.modeState.gfx;
    if (!gfx) return;
    let n0 = 0;
    let n1 = 0;
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      if (!t.active) continue;
      const im = gfx.meshes[t.team];
      const idx = t.team === 0 ? n0++ : n1++;
      const y = t.position.y + Math.sin(bob * 2.4 + i) * 0.09;
      _quat.setFromAxisAngle(_up, bob * 1.6 + i);
      _v1.set(t.position.x, y, t.position.z);
      _m4.compose(_v1, _quat, _scale);
      im.setMatrixAt(idx, _m4);
    }
    gfx.meshes[0].count = n0;
    gfx.meshes[1].count = n1;
    if (n0) gfx.meshes[0].instanceMatrix.needsUpdate = true;
    if (n1) gfx.meshes[1].instanceMatrix.needsUpdate = true;
  },

  checkEnd(match) { return endByTeamScore(match, this.scoreLimit); },
  hudScores(match, out) { out[0] = match.scores[0]; out[1] = match.scores[1]; return out; },
};

// ---------------------------------------------------------------------- table

export const MODES = {
  [TDM.id]: TDM,
  [FFA.id]: FFA,
  [GUNGAME.id]: GUNGAME,
  [DOMINATION.id]: DOMINATION,
  [KILLCONFIRMED.id]: KILLCONFIRMED,
};

export const MODE_LIST = [TDM, FFA, GUNGAME, DOMINATION, KILLCONFIRMED];

// Several systems stringify whatever `match.mode` happens to be (BotManager derives its
// roster from it, the menu labels with it). Make that produce the id, not [object Object].
for (const m of MODE_LIST) {
  Object.defineProperty(m, 'toString', { value: function () { return this.id; }, enumerable: false });
}

export const DEFAULT_MODE = TDM.id;

export function getMode(id) {
  return MODES[id] || MODES[DEFAULT_MODE];
}
