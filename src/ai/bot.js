import * as THREE from 'three';
import {
  clamp, lerp, damp, angleDelta, moveAngleTowards,
  dirFromAngles, yawTo, spreadDir, DEG, PITCH_LIMIT,
} from '../core/mathUtils.js';
import { BotModel } from './botModel.js';
import { createRNG, mixSeed } from '../core/rng.js';

// Systems written in parallel — namespace imports so a missing named export
// degrades to `undefined` instead of exploding the whole module graph.
import * as Ballistics from '../weapons/ballistics.js';
import * as WeaponDefs from '../weapons/weaponDefs.js';
import { ARMOR_ABSORB } from '../core/mathUtils.js';

/**
 * Bot — an ARCHITECTURE.md §4 entity with a layered AI.
 *
 * Three clocks:
 *   fixedUpdate(dt)  120 Hz — aim convergence, trigger, steering, physics.
 *   think(dt)        15–30 Hz, staggered by BotManager — senses (the LOS
 *                    raycasts live here), state transitions, path requests.
 *   update(dtFrame)  per rAF — the visual model only.
 *
 * The important design rule for feel: a bot never knows anything the world
 * hasn't told it. Position comes from vision (cone + LOS) or hearing; when
 * both fail it pushes to a *last known position* and searches. There is no
 * wallhack path anywhere in this file.
 */

const GRAVITY = -22;
const TERMINAL_FALL = -60;
const BODY_RADIUS = 0.36;
const STAND_HEIGHT = 1.8;
const CROUCH_HEIGHT = 1.1;
const EYE_STAND = 1.62;
const EYE_CROUCH = 0.95;
const JUMP_VELOCITY = 7.6;

const SPEED_SPRINT = 6.3;
const SPEED_RUN = 4.9;
const SPEED_COMBAT = 3.5;
const SPEED_CROUCH = 2.0;

const WAYPOINT_RADIUS = 0.85;
// Vertical half-window on `arrived()`. Storeys on this map are ~4 m; the path follower
// already tolerates 1.6 m of step per waypoint, so anything past that is another floor.
const ARRIVE_VERTICAL = 1.8;
// How often a short-range destination pick reaches for a floor ABOVE the bot instead of
// the one it is standing on. Tuned by measurement, not taste: the target is bots using
// upper floors and roofs for a meaningful slice of a match without abandoning the
// ground, where most of the map and most of the fighting is. See scripts/vertprobe.mjs.
const HIGH_GROUND_REPOSITION = 0.45;
const HIGH_GROUND_FLANK = 0.40;      // scaled by persona.flank (0.40 .. 1.70)
// How long a bot will keep walking toward a floor above it before the state machine is
// allowed to send it somewhere else. Measured: without a lock, a vertical leg survived
// 1.7 s on average — 142 of 145 legs were overwritten by the next `investigate` or
// `engage` think tick, which is why bots that were CHOOSING roofs still never reached
// one. Scaled by how far the stairs are, because a flight of stairs across the map is
// not the same commitment as the one in this room.
const CLIMB_COMMIT_MIN = 4.0;
const CLIMB_COMMIT_MAX = 13.0;
// A visible enemy beyond this cancels nothing: breaking off to take the high ground on
// a distant contact is a manoeuvre, not a lapse. Inside it, the fight is here and now
// and walking upstairs would just be a bot ignoring someone shooting at it.
const CLIMB_BREAK_RANGE = 16;

/**
 * States in which taking high ground is never worth delaying the decision at hand.
 *
 * A bot that has decided to shoot, take cover, push or retreat has a reason that beats
 * repositioning for a view. Letting the climb lock outrank these swallowed a quarter of
 * all combat movement.
 */
const CLIMB_YIELD_STATES = new Set(['engage', 'takeCover', 'retreat', 'pushOrFlank']);
const REPATH_INTERVAL = 1.15;
const STUCK_WINDOW = 1.2;
const STUCK_DISTANCE = 0.32;

/**
 * Difficulty curves. Recruit is beatable; veteran is lethal but never perfect.
 *
 * DESIGN RULE: difficulty must never decide *whether* a bot notices you. Every
 * tier gets essentially the same eyes and ears (`visionRange`, `fovDeg`,
 * `hearMul`, `commsMul`) so a player standing in the open is found reliably at
 * recruit and at veteran alike. What scales is the *quality* of the fight:
 * reaction time, aim error and how fast it converges, burst discipline, cover
 * discipline, push aggression and armour. A recruit finds you in the same few
 * seconds a veteran does, then sprays 6° wide and gives you the trade.
 *
 * COVER DISCIPLINE RUNS THE OTHER WAY, and this was the single biggest thing
 * wrong with the old curve: `coverBias` used to RISE with skill, so the better
 * a bot was the more of the fight it spent behind a crate. Measured over four
 * seeds, veterans held line of sight to an exposed player 16% of the time while
 * recruits managed 22% — the accuracy gradient existed but the behaviour
 * gradient cancelled it, and damage came out flat and random. A veteran does
 * not cower: they break for cover LESS readily (low `coverBias`), need far more
 * incoming fire before they do (`suppressCrouch`), sit there for a shorter
 * beat (`coverHold`) and peek out of it more often (`peekBias`). Panicking into
 * a wall and staying there is the rookie behaviour.
 */
export const DIFFICULTY = {
  recruit: {
    reactMin: 0.44, reactMax: 0.66,
    aimErrorDeg: 6.4, aimSettleDeg: 1.95, converge: 0.78, jitterDeg: 0.82,
    sprayInMul: 2.3, sprayInTime: 0.58,
    visionRange: 60, fovDeg: 109, hearMul: 0.92,
    burstMul: 0.68, restMul: 1.85,
    coverBias: 0.55, pushBias: 0.34, grenadeChance: 0.05,
    turnRate: 4.0, leadFactor: 0.30,
    retreatHealth: 0.34, memoryTime: 5.5, peekBias: 0.35,
    suppressCrouch: 0.40, health: 100, armor: 0,
    commsMul: 0.80, commsSmear: 6.0, coverHold: 1.50, sweepUrgency: 1.0,
    weaponSpreadMul: 1.15, standoffMul: 1.45, fireMoveMul: 0.92,
  },
  regular: {
    reactMin: 0.28, reactMax: 0.40,
    aimErrorDeg: 4.4, aimSettleDeg: 1.15, converge: 1.5, jitterDeg: 0.55,
    sprayInMul: 1.8, sprayInTime: 0.42,
    visionRange: 61, fovDeg: 110, hearMul: 1.0,
    burstMul: 0.95, restMul: 1.20,
    coverBias: 0.48, pushBias: 0.44, grenadeChance: 0.12,
    turnRate: 5.6, leadFactor: 0.55,
    retreatHealth: 0.28, memoryTime: 7.0, peekBias: 0.5,
    suppressCrouch: 0.52, health: 100, armor: 0,
    commsMul: 0.92, commsSmear: 4.0, coverHold: 1.15, sweepUrgency: 1.02,
    weaponSpreadMul: 1.00, standoffMul: 1.20, fireMoveMul: 0.70,
  },
  hardened: {
    reactMin: 0.17, reactMax: 0.25,
    aimErrorDeg: 3.1, aimSettleDeg: 0.62, converge: 2.4, jitterDeg: 0.38,
    sprayInMul: 1.5, sprayInTime: 0.30,
    visionRange: 62, fovDeg: 111, hearMul: 1.08,
    burstMul: 1.15, restMul: 0.88,
    coverBias: 0.42, pushBias: 0.58, grenadeChance: 0.2,
    turnRate: 7.2, leadFactor: 0.78,
    retreatHealth: 0.22, memoryTime: 8.5, peekBias: 0.65,
    suppressCrouch: 0.65, health: 100, armor: 25,
    commsMul: 1.0, commsSmear: 2.6, coverHold: 0.85, sweepUrgency: 1.05,
    weaponSpreadMul: 0.92, standoffMul: 1.00, fireMoveMul: 0.48,
  },
  veteran: {
    reactMin: 0.12, reactMax: 0.19,
    aimErrorDeg: 2.3, aimSettleDeg: 0.34, converge: 3.4, jitterDeg: 0.26,
    sprayInMul: 1.35, sprayInTime: 0.22,
    visionRange: 63, fovDeg: 112, hearMul: 1.15,
    burstMul: 1.35, restMul: 0.70,
    coverBias: 0.36, pushBias: 0.72, grenadeChance: 0.3,
    turnRate: 9.0, leadFactor: 0.95,
    retreatHealth: 0.18, memoryTime: 10, peekBias: 0.8,
    suppressCrouch: 0.78, health: 100, armor: 50,
    commsMul: 1.0, commsSmear: 1.6, coverHold: 0.62, sweepUrgency: 1.08,
    weaponSpreadMul: 0.85, standoffMul: 0.80, fireMoveMul: 0.32,
  },
};

/**
 * Persistent per-bot temperament, assigned once by BotManager and kept across
 * respawns. Difficulty says how *good* a soldier is; personality says what kind
 * of soldier they are. Multipliers ride on top of the difficulty curve so a
 * recruit pusher is still a recruit — just one that comes at you.
 *
 *   push      — willingness to close on a lost contact instead of holding
 *   cover     — how readily a firefight is broken off to reach cover
 *   coverHold — how long cover is worth sitting in before peeking/pushing
 *   peek      — peek frequency while in cover
 *   range     — preferred engagement distance, x the weapon class ideal
 *   sweep     — patrol urgency: how far and how hungrily they hunt
 *   flank     — how wide an arc they take approaching a contact
 *   speed     — small gait variation so a squad does not move as one animal
 */
export const PERSONALITIES = {
  pusher:  { push: 1.60, cover: 0.60, coverHold: 0.68, peek: 1.30, range: 0.70, sweep: 1.20, flank: 0.40, speed: 1.05 },
  flanker: { push: 1.30, cover: 0.90, coverHold: 0.85, peek: 1.10, range: 0.95, sweep: 1.30, flank: 1.70, speed: 1.02 },
  holder:  { push: 0.60, cover: 1.45, coverHold: 1.30, peek: 0.85, range: 1.35, sweep: 0.85, flank: 0.55, speed: 0.96 },
  roamer:  { push: 1.05, cover: 0.92, coverHold: 0.95, peek: 1.05, range: 1.00, sweep: 1.50, flank: 1.00, speed: 1.04 },
};
export const PERSONALITY_NAMES = ['pusher', 'flanker', 'holder', 'roamer'];

/** Per weapon-class engagement doctrine. */
const CLASS_PROFILE = {
  ar: { ideal: 24, tooClose: 4, burst: [3, 6], rest: [0.26, 0.52], spreadMul: 1.0 },
  smg: { ideal: 12, tooClose: 2, burst: [5, 9], rest: [0.20, 0.40], spreadMul: 1.05 },
  lmg: { ideal: 26, tooClose: 5, burst: [6, 12], rest: [0.34, 0.70], spreadMul: 1.15 },
  sniper: { ideal: 46, tooClose: 15, burst: [1, 1], rest: [0.95, 1.8], spreadMul: 0.65 },
  shotgun: { ideal: 7, tooClose: 1, burst: [1, 2], rest: [0.5, 0.85], spreadMul: 1.0 },
  pistol: { ideal: 13, tooClose: 2, burst: [2, 4], rest: [0.34, 0.68], spreadMul: 1.0 },
  launcher: { ideal: 22, tooClose: 9, burst: [1, 1], rest: [1.3, 2.2], spreadMul: 0.8 },
};
const DEFAULT_PROFILE = CLASS_PROFILE.ar;

/** Weapon classes a bot may carry as a primary. */
const PRIMARY_CLASSES = new Set(['ar', 'smg', 'lmg', 'sniper', 'shotgun', 'pistol']);

/**
 * Class weights per personality. A uniform roll over every primary put two
 * snipers and a pistol in a four-bot lobby often enough that the *weapon dice*
 * dominated how aggressive a team looked — a sniper fires one round every 1.5 s,
 * an SMG fires fifteen. Weighting by temperament both cuts that variance and
 * makes the personality legible: the guy rushing you has a shotgun.
 */
const CLASS_WEIGHTS = {
  pusher:  { ar: 4, smg: 5, lmg: 1, shotgun: 2, sniper: 0, pistol: 0 },
  flanker: { ar: 5, smg: 5, lmg: 1, shotgun: 0, sniper: 0, pistol: 0 },
  // Only the cautious holder ever picks up a long gun, and even then rarely:
  // a sniper puts out roughly a tenth of an SMG's fire, so two of them in a
  // four-bot team is the difference between a firefight and a stalemate.
  holder:  { ar: 5, smg: 1, lmg: 3, shotgun: 0, sniper: 2, pistol: 0 },
  roamer:  { ar: 6, smg: 3, lmg: 1, shotgun: 0, sniper: 0, pistol: 0 },
};

// -------------------------------------------------------------- scratch
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();

/**
 * Minimal stand-in used only if `game.weapons` exposes no instance factory we
 * recognise. Implements the documented WeaponInstance surface (§7) so nothing
 * downstream has to care which one it got.
 */
class FallbackWeapon {
  constructor(game, def, owner) {
    this.game = game;
    this.def = def;
    this.owner = owner;
    this.ammo = def.magSize ?? 30;
    this.reserve = def.reserve ?? 180;
    this.state = 'idle';
    this.adsAmount = 0;
    this._isFallback = true;
    this._cool = 0;
    this._reloadT = 0;
  }

  canFire() { return this.state !== 'reloading' && this.ammo > 0 && this._cool <= 0; }

  tryFire() {
    if (!this.canFire()) return false;
    this.ammo--;
    this._cool = 60 / (this.def.rpm || 600);
    this.state = 'firing';
    return true;
  }

  stopFire() { if (this.state === 'firing') this.state = 'idle'; }

  reload() {
    const mag = this.def.magSize ?? 30;
    if (this.state === 'reloading' || this.ammo >= mag || this.reserve <= 0) return false;
    this.state = 'reloading';
    this._reloadT = this.ammo === 0
      ? (this.def.reloadEmptyTime ?? 2.6)
      : (this.def.reloadTime ?? 2.1);
    this.game.bus?.emit('reloadStart', { shooter: this.owner, weaponId: this.def.id });
    return true;
  }

  fixedUpdate(dt) {
    if (this._cool > 0) this._cool -= dt;
    if (this.state !== 'reloading') return;
    this._reloadT -= dt;
    if (this._reloadT > 0) return;
    const mag = this.def.magSize ?? 30;
    const take = Math.min(mag - this.ammo, this.reserve);
    this.ammo += take;
    this.reserve -= take;
    this.state = 'idle';
    this.game.bus?.emit('reloadEnd', { shooter: this.owner, weaponId: this.def.id });
  }
}

// ---------------------------------------------------------------- states
//
// Every state is { enter, think, exit }. `think` returns the name of the next
// state or null to stay. Nothing here reaches into the fixed step — states set
// intent (move target, stance, fire permission) and fixedUpdate executes it.

const STATES = {
  idle: {
    enter(b) {
      b.clearPath();
      b.moveMode = 'walk';
      b.wantFire = false;
      b.stateTimer = b.rng.range(0.8, 2.6);
    },
    think(b) {
      if (b.hasContact()) return 'engage';
      if (b.investigateConfidence > 0.15) return 'investigate';
      if (b.stateTimer <= 0) return 'patrol';
      b.lookAround(0.5);
      return null;
    },
  },

  /**
   * PATROL IS A HUNT, NOT A STROLL.
   *
   * The destination comes from the team sweep board (BotManager.pickSweepPoint),
   * which scores every point of interest on the map by how contested it is, how
   * close it sits to the enemy team's likely positions, how recently a teammate
   * covered it, and how hot the last radio contact was. A bot that has seen
   * nothing does not orbit its spawn — it walks into the enemy half looking for
   * someone to shoot, and it does not stop walking when it gets there.
   */
  patrol: {
    enter(b) {
      b.moveMode = 'run';
      b.wantFire = false;
      b.wantCrouch = false;
      b.stateTimer = b.rng.range(14, 22);
      b.patrolHold = 0;
      b.patrolPause = b.rng.range(0.35, 1.5) / (b.persona.sweep * b.cfg.sweepUrgency);
      b.pickPatrolDestination();
    },
    think(b, dt) {
      if (b.hasContact()) return 'engage';
      if (b.investigateConfidence > 0.15) return 'investigate';

      if (!b.hasDestination) {
        b.pickPatrolDestination();
        if (!b.hasDestination) return 'idle';
      }

      if (b.arrived()) {
        // Clear the corner we just walked into, then immediately take the next
        // leg. Standing still is what made the old patrol a coin flip.
        b.patrolHold += dt;
        b.moveMode = 'walk';
        b.lookAround(1.0);
        if (b.patrolHold > b.patrolPause) {
          b.patrolHold = 0;
          b.patrolPause = b.rng.range(0.35, 1.5) / (b.persona.sweep * b.cfg.sweepUrgency);
          b.pickPatrolDestination();
        }
        return null;
      }

      if (b.stateTimer <= 0) {
        // The leg is taking too long (blocked, or the board has moved on).
        b.stateTimer = b.rng.range(14, 22);
        b.pickPatrolDestination();
      }
      b.moveMode = b.distanceToDestination() > 8 ? 'sprint' : 'run';
      return null;
    },
  },

  investigate: {
    enter(b) {
      b.moveMode = 'run';
      b.wantFire = false;
      b.wantCrouch = false;
      b.setDestination(b.investigatePoint, 2.0);
      // Budget the walk by how far the lead actually is — a called contact
      // across the map used to expire before the bot got halfway there.
      b.stateTimer = clamp(b.distanceToDestination() / 4.2 + 3.5, 5, 18);
      b.searchHold = 0;
    },
    think(b, dt) {
      if (b.hasContact()) return 'engage';
      b.investigateConfidence = Math.max(0, b.investigateConfidence - dt * 0.09);
      if (b.arrived() || !b.hasDestination) {
        b.searchHold += dt;
        b.moveMode = 'walk';
        b.lookAround(1.1);
        if (b.searchHold > b.rng.range(1.2, 2.4)) {
          b.investigateConfidence = 0;
          return 'patrol';
        }
        return null;
      }
      if (b.stateTimer <= 0) { b.investigateConfidence = 0; return 'patrol'; }
      b.moveMode = b.distanceToDestination() > 10 ? 'sprint' : 'run';
      return null;
    },
  },

  engage: {
    enter(b) {
      b.moveMode = 'combat';
      b.wantFire = true;
      b.stateTimer = b.rng.range(1.6, 3.4);
      b.pickStrafe();
      b.clearPath();
    },
    think(b, dt) {
      const t = b.target;
      if (!t || !t.alive) { b.wantFire = false; return b.investigateConfidence > 0.1 ? 'investigate' : 'patrol'; }
      if (b.needsReload()) return 'reload';
      if (b.health <= b.maxHealth * b.cfg.retreatHealth && b.rng.chance(0.7)) return 'retreat';

      const dist = b.distanceToTargetPos();

      // Frag the last known position the moment they break line of sight —
      // evaluated before any transition so the opportunity is never skipped.
      if (!b.targetVisible && b.timeSinceSeen > 0.8) b.tryGrenade(dist);

      if (!b.targetVisible) {
        if (b.timeSinceSeen > b.cfg.memoryTime) { b.forgetTarget(); return 'investigate'; }
        // 1.3 s was short enough that any target ducking behind a crate sent the
        // bot off on a flank instead of holding the angle it already had, so
        // engage occupancy collapsed into pushOrFlank. Hold the angle first.
        if (b.timeSinceSeen > 2.1) {
          // Losing sight is a cue to move, and pushing is the default unless
          // cover is both wanted and off cooldown.
          if (b.coverCooldown > 0 || b.rng() < b.pushBias) return 'pushOrFlank';
          return 'takeCover';
        }
      } else if (b.suppression > b.cfg.suppressCrouch && b.coverCooldown <= 0
        && b.rng() < b.coverBias) {
        return 'takeCover';
      }

      // -- range management
      const prof = b.profile;
      const ideal = b.idealRange;
      if (!b.targetVisible && b.timeSinceSeen > 0.45) {
        // They stepped behind something. Sliding a couple of metres to a cell
        // that can see where they went keeps the fight alive; standing in place
        // waiting for the memory to expire is what turned engagements into
        // long walks between them.
        b.regainAngle();
      } else if (dist > ideal * 1.25 && b.timeSinceSeen < 2) {
        b.moveMode = 'run';
        b.setDestination(b.lastKnown, 3.5);
      } else if (b.targetVisible && dist < Math.max(prof.tooClose, ideal * 0.45)) {
        // Break contact back out to a workable range. `ideal` already carries
        // the tier's standoff, so a rookie gives ground a rifle-length earlier
        // than a veteran does — the difference between "beatable" and "in your
        // face with a shotgun" without touching anyone's aim.
        b.backpedal(Math.max(prof.tooClose + 3, ideal * 0.7));
      } else {
        b.clearPath();
        b.moveMode = 'combat';
      }

      // -- strafe/peek so they never stand still trading
      if (b.strafeTimer <= 0) b.pickStrafe();
      b.wantCrouch = b.suppression > 0.75 && b.nearCover();
      return null;
    },
    exit(b) { b.strafeDir = 0; },
  },

  pushOrFlank: {
    enter(b) {
      b.moveMode = 'run';
      b.wantFire = true;
      b.wantCrouch = false;
      b.stateTimer = b.rng.range(4.5, 8);
      b.pickFlankDestination();
    },
    think(b) {
      if (b.needsReload()) return 'reload';
      if (b.health <= b.maxHealth * b.cfg.retreatHealth * 0.8) return 'retreat';
      if (b.targetVisible && b.reactionReady()) return 'engage';
      if (!b.target && b.investigateConfidence > 0.15) return 'investigate';
      if (!b.targetVisible && b.timeSinceSeen > 1.0) b.tryGrenade(b.distanceToTargetPos());
      if (b.stateTimer <= 0 || b.arrived() || !b.hasDestination) {
        return b.timeSinceSeen > b.cfg.memoryTime ? 'investigate' : 'engage';
      }
      b.moveMode = b.distanceToDestination() > 10 ? 'sprint' : 'run';
      return null;
    },
  },

  /**
   * COVER IS A BEAT, NOT A HOME.
   *
   * The old version could park a bot behind a crate for the rest of the round:
   * its exit test only ran once `inCover` became true, and `inCover` only became
   * true once the path finished. So a cover point that was never reached meant a
   * bot that never left. Now `coverBudget` burns down every think tick no matter
   * what the pathfinder is doing, and when it hits zero the bot pushes or
   * re-engages — no exceptions.
   *
   * The cycle inside the budget is: reach cover -> hold (crouched, suppressed)
   * -> peek (step to a cell that actually has the angle, stand, shoot) -> drop
   * back -> repeat. Losing the target for long enough while peeking abandons the
   * cover early and goes hunting.
   */
  takeCover: {
    enter(b) {
      b.moveMode = 'run';
      b.wantFire = true;
      b.coverBudget = b.rng.range(2.4, 4.4) * b.persona.coverHold * b.cfg.coverHold;
      b.stateTimer = b.coverBudget + 4;
      b.peekTimer = b.rng.range(0.3, 0.8);
      b.peeking = false;
      b.inCover = false;
      b.coverFailed = !b.pickCoverDestination();
    },
    think(b, dt) {
      b.coverBudget -= dt;
      if (b.coverFailed) return 'reposition';
      if (b.needsReload() && b.inCover) return 'reload';
      if (b.health <= b.maxHealth * b.cfg.retreatHealth * 0.75) return 'retreat';

      if (!b.inCover && (b.arrived() || !b.hasDestination)) {
        b.inCover = true;
        b.clearPath();
      }

      // Hard timeout — this is the whole fix for cover stickiness.
      if (b.coverBudget <= 0 || b.stateTimer <= 0) {
        return (!b.targetVisible || b.rng() < b.pushBias) ? 'pushOrFlank' : 'engage';
      }

      if (!b.inCover) { b.moveMode = 'run'; return null; }

      b.moveMode = 'combat';
      b.peekTimer -= dt;
      if (b.peekTimer <= 0) {
        b.peeking = !b.peeking;
        const pk = clamp(b.peekBias, 0.2, 1);
        b.peekTimer = b.peeking
          ? b.rng.range(0.75, 1.7) * (0.6 + pk * 0.8)     // time spent exposed
          : b.rng.range(0.35, 1.0) / (0.4 + pk);          // time spent hidden
        b.applyPeekOffset();
        if (b.peeking) b.peekOut(); else b.holdCover();
      }
      // Crouched behind cover while suppressed, standing to shoot when peeking.
      b.wantCrouch = !b.peeking && b.suppression > 0.25;
      b.wantFire = true;
      if (!b.targetVisible && b.timeSinceSeen > 0.8) b.tryGrenade(b.distanceToTargetPos());
      // Peeked and found nothing: the fight has moved, so move with it.
      if (b.peeking && b.timeSinceSeen > 2.6) return 'pushOrFlank';
      return null;
    },
    exit(b) {
      b.inCover = false;
      b.peeking = false;
      b.wantCrouch = false;
      b.peekOffset = 0;
      // Stops engage <-> takeCover ping-ponging on every suppression spike.
      b.coverCooldown = b.rng.range(2.5, 5.0);
    },
  },

  reposition: {
    enter(b) {
      b.moveMode = 'run';
      b.wantFire = true;
      b.wantCrouch = false;
      b.stateTimer = b.rng.range(2.0, 4.0);
      b.pickRepositionDestination();
    },
    think(b) {
      if (b.needsReload()) return 'reload';
      if (b.targetVisible && b.reactionReady() && b.rng.chance(0.6)) return 'engage';
      if (b.stateTimer <= 0 || b.arrived() || !b.hasDestination) {
        return b.hasContact() ? 'engage' : 'patrol';
      }
      return null;
    },
  },

  reload: {
    enter(b) {
      b.wantFire = false;
      b.startReload();
      b.stateTimer = 4.5;
      // Back off toward cover while the mag is out — never reload in the open.
      if (b.target && b.targetVisible) b.backpedal(9);
      b.moveMode = 'combat';
    },
    think(b) {
      if (b.reloadDone() || b.stateTimer <= 0) {
        if (b.hasContact()) return 'engage';
        if (b.investigateConfidence > 0.15) return 'investigate';
        return 'patrol';
      }
      return null;
    },
    exit(b) { b.wantFire = true; },
  },

  retreat: {
    enter(b) {
      b.moveMode = 'sprint';
      b.wantFire = false;
      b.wantCrouch = false;
      b.stateTimer = b.rng.range(4, 7);
      b.pickRetreatDestination();
    },
    think(b) {
      if (b.needsReload()) b.startReload();
      const healthy = b.health > b.maxHealth * (b.cfg.retreatHealth + 0.28);
      if (healthy && (b.arrived() || b.stateTimer <= 0)) {
        return b.hasContact() ? 'engage' : 'patrol';
      }
      if (b.stateTimer <= 0 && (b.arrived() || !b.hasDestination)) {
        // Cornered with nowhere to run — turn and fight.
        return b.hasContact() ? 'engage' : 'takeCover';
      }
      // Fire back over the shoulder if they are right behind us.
      b.wantFire = b.targetVisible && b.distanceToTargetPos() < 12;
      return null;
    },
  },

  dead: {
    enter(b) {
      b.wantFire = false;
      b.wantCrouch = false;
      b.clearPath();
      b.velocity.set(0, 0, 0);
    },
    think() { return null; },
  },
};

// ------------------------------------------------------------------- Bot

export class Bot {
  constructor(game, team = 1, name = 'BOT') {
    this.game = game;

    // ---- §4 entity contract
    this.id = game.allocEntityId();
    this.isPlayer = false;
    // Its own stream from the outset. Aliasing `game.rng` here meant a bot that somehow
    // missed `_configureRoster` would silently share the global stream — the exact
    // coupling per-bot streams exist to prevent, and invisible because it still works.
    // BotManager re-seeds this from the match seed and roster slot; this is the floor.
    this.rng = createRNG(mixSeed(game?.matchSeed ?? 0, this.id));
    this.team = team === 0 ? 0 : 1;
    this.alive = false;
    this.name = name;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.height = STAND_HEIGHT;
    this.radius = BODY_RADIUS;
    this.eyeHeight = EYE_STAND;

    this.health = 100;
    this.maxHealth = 100;
    this.armor = 0;

    this.hitboxes = [
      { part: 'head', offset: new THREE.Vector3(), size: new THREE.Vector3() },
      { part: 'torso', offset: new THREE.Vector3(), size: new THREE.Vector3() },
      { part: 'limb', offset: new THREE.Vector3(), size: new THREE.Vector3() },
      { part: 'limb', offset: new THREE.Vector3(), size: new THREE.Vector3() },
    ];
    this._syncHitboxes();

    this.weapon = null;
    this.stats = { kills: 0, deaths: 0, score: 0, streak: 0 };

    // ---- difficulty + temperament
    this.cfg = DIFFICULTY.regular;
    this.profile = DEFAULT_PROFILE;
    this.ffa = false;
    this.personaName = 'roamer';
    this.persona = PERSONALITIES.roamer;

    // ---- perception
    this.target = null;
    this.targetVisible = false;
    this.lastKnown = new THREE.Vector3();
    this.lastKnownVel = new THREE.Vector3();
    this.timeSinceSeen = 999;
    this.suspicion = 0;
    this.suppression = 0;
    this.investigatePoint = new THREE.Vector3();
    this.investigateConfidence = 0;
    this.lastDamageTime = -999;

    // ---- state machine
    this.state = 'idle';
    this.stateTimer = 0;
    this.searchHold = 0;
    this.peekTimer = 0;
    this.peeking = false;
    this.peekOffset = 0;
    this.inCover = false;
    this.coverFailed = false;
    this.coverBudget = 0;
    this.coverCooldown = 0;
    this.patrolHold = 0;
    this.patrolPause = 1;
    this._poiClaim = -1;
    this._lastReport = -999;

    // ---- movement
    this.grounded = false;
    this.moveMode = 'walk';
    this.wantCrouch = false;
    this.crouching = false;
    this.wantJump = false;
    this.path = [];
    this.pathLen = 0;
    this.pathIdx = 0;
    this.destination = new THREE.Vector3();
    this.hasDestination = false;
    this.destTolerance = WAYPOINT_RADIUS;
    this.repathTimer = 0;
    this.pathPending = false;
    this._pathDest = new THREE.Vector3();
    this.climbGoal = new THREE.Vector3();
    this.climbLock = 0;
    this._separation = new THREE.Vector3();
    this.strafeDir = 0;
    this.strafeTimer = 0;
    this._lookYaw = 0;
    this._lookTimer = 0;

    // ---- stuck detection
    this._stuckSample = new THREE.Vector3();
    this._stuckTimer = 0;
    this._stuckLevel = 0;
    this._sidestepTimer = 0;
    this._sidestepSign = 1;
    this._wedgeTimer = 0;
    this._wedged = false;

    // ---- combat
    this.wantFire = false;
    this._reactTimer = 0;
    this._errMag = 0;
    this._errYaw = 0;
    this._errPitch = 0;
    this._errSpin = 0;
    this._sprayIn = 0;
    // NOTE: deliberately NOT seeded from game.rng here. Bots are constructed
    // lazily and reused between matches, so a constructor-time draw makes the
    // number of RNG consumers depend on whether a match has been played before —
    // which is exactly how the same seed stopped reproducing a match. All
    // per-bot randomisation happens in spawn(), which runs identically every
    // time. (Same rule applies in botModel.js.)
    this._jitPhase = 0;
    this._burstLeft = 0;
    this._restTimer = 0;
    this._triggerHeld = false;
    this._extShotSeen = false;
    this._grenades = 2;
    this._grenadeCd = 6;
    this._aimYawTarget = 0;
    this._aimPitchTarget = 0;
    this._aimHeightFrac = 0.66;
    this._hitWall = false;

    // ---- misc
    this.respawnAt = 0;
    this.deathTime = -999;
    this._everSpawned = false;
    this.thinkPhase = 0;
    this.thinkStride = 8;
    this.anim = { aim: 0, reload: 0, deathYaw: 0 };
    this._shotPayload = {
      shooter: this, weaponId: null,
      origin: new THREE.Vector3(), dir: new THREE.Vector3(), isPlayer: false,
    };
    this._deadEmitted = false;

    this.color = null;            // set by BotManager from TEAM_COLORS
    // The rig is a rendering resource, not an effect, so a no-op presenter cannot make it
    // free — it has to not be built. Every other `this.model` access in this file is
    // already optional-chained or behind a null check, so a headless bot just has none.
    this.model = game.present?.visual === false ? null : new BotModel(game, this.team);
    this.model?.setVisible(false);
  }

  /** Rebuild the model if the bot changed teams (colourways are baked in). */
  ensureTeamModel() {
    if (this.game.present?.visual === false) return;
    if (this.model && !this.model.disposed && this.model.team === this.team) return;
    this.model?.dispose();
    this.model = new BotModel(this.game, this.team);
    this.model.setVisible(false);
  }

  // ------------------------------------------------------- entity contract

  getEyePosition(out) {
    return out.set(this.position.x, this.position.y + this.eyeHeight, this.position.z);
  }

  getAimDirection(out) {
    return dirFromAngles(this.yaw, this.pitch, out);
  }

  /**
   * `amount` already carries the ballistics hit multipliers (§4). We never emit
   * `damage` here — ballistics owns that event.
   */
  applyDamage(amount, info = {}) {
    if (!this.alive || amount <= 0) return 0;
    let dmg = amount;
    if (this.armor > 0) {
      // The SAME constant the player's armour uses. It was 0.55 here against 0.65 there —
      // one mechanic, two numbers, so identical armour absorbed differently depending on
      // who was wearing it. (Armour itself is deliberate: only `hardened` and `veteran`
      // grant any, as an opt-in difficulty lever. `regular`, which is what the dedicated
      // server runs, gives bots none at all.)
      const absorbed = Math.min(this.armor, dmg * ARMOR_ABSORB);
      this.armor -= absorbed;
      dmg -= absorbed;
    }
    this.health -= dmg;
    this.lastDamageTime = this.game.time;
    this.suppression = Math.min(1.6, this.suppression + 0.55);

    // Getting shot is information: react to the attacker even if unseen.
    const atk = info.attacker;
    if (atk && atk !== this && this.isEnemy(atk)) {
      this.suspicion = 1;
      if (!this.target || !this.targetVisible) {
        this.target = atk;
        this.lastKnown.copy(atk.position);
        this.timeSinceSeen = Math.min(this.timeSinceSeen, 0.35);
        this.investigatePoint.copy(atk.position);
        this.investigateConfidence = 0.9;
      }
      // Aim error spikes when you get hit — being shot at ruins your aim.
      this._errMag = Math.max(this._errMag, this.cfg.aimErrorDeg * DEG * 0.6);
      // "Taking fire, grid ..." — a wounded teammate is the loudest contact
      // report there is, and it is the one that turns a lone duel into a fight.
      this.callContact(atk, 0.85);
    }

    if (this.model) {
      const dirYaw = info.point
        ? yawTo(info.point, this.position)
        : this.yaw + Math.PI;
      this.model.hitReaction(clamp(dmg / 45, 0.25, 1), dirYaw);
    }

    if (this.health <= 0) {
      this.health = 0;
      this.die(info);
    } else if (this.state !== 'engage' && this.state !== 'takeCover' && this.state !== 'retreat') {
      this.setState(this.target && this.targetVisible ? 'engage' : 'takeCover');
    }
    return dmg;
  }

  die(info = {}) {
    if (!this.alive) return;
    this.alive = false;
    this.health = 0;
    this.deathTime = this.game.time;
    this.velocity.set(0, 0, 0);
    this.wantFire = false;
    this.weapon?.stopFire?.();
    this.stats.deaths++;
    this.stats.streak = 0;
    this.game.bots?.releaseSweepClaim?.(this);

    // Direction the body is pushed: away from the shot, or straight back.
    let deathYaw = this.yaw + Math.PI;
    if (info.point) deathYaw = yawTo(info.point, this.position);
    else if (info.attacker) deathYaw = yawTo(info.attacker.position, this.position);
    this.anim.deathYaw = deathYaw;

    this.setState('dead');

    // `kill` is not emitted by ballistics (§6 lists hit/impact/damage only), so
    // the entity is the single choke point for it — grenades, falls and bullets
    // all funnel through die().
    if (!this._deadEmitted) {
      this._deadEmitted = true;
      const atk = info.attacker || null;
      this.game.bus?.emit('kill', {
        victim: this,
        attacker: atk,
        weaponId: info.weaponId ?? null,
        headshot: !!info.headshot || info.hitPart === 'head',
        distance: atk?.position ? atk.position.distanceTo(this.position) : 0,
      });
    }
  }

  isEnemy(other) {
    if (!other || other === this || other.alive === false) return false;
    if (this.ffa) return true;
    return other.team !== this.team;
  }

  // ------------------------------------------------------------ life cycle

  configure(difficulty, ffa) {
    this.cfg = DIFFICULTY[difficulty] || DIFFICULTY.regular;
    this.ffa = !!ffa;
    this.maxHealth = this.cfg.health;
  }

  /** Persistent temperament. Set once per lobby by BotManager; survives death. */
  setPersonality(name) {
    this.personaName = PERSONALITIES[name] ? name : 'roamer';
    this.persona = PERSONALITIES[this.personaName];
  }

  // --- difficulty x personality, the only numbers behaviour should read ------
  get pushBias() { return clamp(this.cfg.pushBias * this.persona.push, 0, 0.95); }
  get coverBias() { return clamp(this.cfg.coverBias * this.persona.cover, 0, 0.95); }
  get peekBias() { return clamp(this.cfg.peekBias * this.persona.peek, 0.15, 1); }
  get idealRange() {
    return this.profile.ideal * this.persona.range * (this.cfg.standoffMul ?? 1);
  }

  spawn(position, yaw = 0) {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.alive = true;
    this._deadEmitted = false;
    this.deathTime = -999;
    this.health = this.maxHealth;
    this.armor = this.cfg.armor;
    this.height = STAND_HEIGHT;
    this.eyeHeight = EYE_STAND;
    this.crouching = false;
    this.wantCrouch = false;
    this.grounded = false;

    this.target = null;
    this.targetVisible = false;
    this.timeSinceSeen = 999;
    this.suspicion = 0;
    this.suppression = 0;
    this.investigateConfidence = 0;
    this.lastDamageTime = -999;

    this._reactTimer = 0;
    this._errMag = this.cfg.aimErrorDeg * DEG;
    this._jitPhase = this.rng() * 100;
    this._sprayIn = 0;
    this._burstLeft = 0;
    this._restTimer = 0;
    this._grenades = 2;
    this._grenadeCd = this.rng.range(2.5, 8);
    this._stuckTimer = 0;
    this._stuckLevel = 0;
    this._sidestepTimer = 0;
    this._wedgeTimer = 0;
    this._wedged = false;
    this._stuckSample.copy(position);
    this.coverCooldown = 0;
    this.coverBudget = 0;
    this._lastReport = -999;
    this.game.bots?.releaseSweepClaim?.(this);

    this.clearPath();
    // Cleared here as well as in `deactivate()`. `fixedUpdate` early-returns for dead
    // bots, so the timer does not decay while dead and a lock taken just before dying
    // survived the respawn with seconds still on it.
    this.climbLock = 0;
    this.climbGoal.set(0, 0, 0);

    this._syncHitboxes();
    // Match assigns teams (§ Match._assignTeams) after BotManager builds the
    // roster, so the colourway is only guaranteed correct at placement time.
    this.ensureTeamModel();
    this.equipWeapon();

    this.model?.respawn(yaw);
    this.model?.setVisible(true);
    this.setState('patrol');
    this._everSpawned = true;
    this._lastThinkTime = this.game.time;
    this.game.bus?.emit('spawn', { entity: this });
  }

  /**
   * Take the bot out of the world without killing it — no `kill` event, no
   * death animation, no score. Used at match reset so `Match.begin` is the one
   * and only authority that places entities: BotManager builds the roster,
   * Match decides where everyone stands. Placing in both is what made the same
   * seed produce a different number of spawn scorings each match.
   *
   * It is also the ONLY place a bot is wound back to its constructor state, and bots
   * are pooled — `_resizeRoster` reuses the same instances match after match. So this
   * must clear EVERY volatile field, not just the ones a reader thinks matter. It used
   * to clear a dozen, and the rest (`lastKnown`, `investigatePoint`, the aim-error
   * triple, `_coverOut`, the stuck/strafe timers …) survived into the next match. None
   * of them are read on tick 1, which is why it looked harmless — but each is read
   * later on a path that runs before anything overwrites it (`lastKnown` the moment
   * memory outlives sight, `_coverOut[0]` whenever `coverPointsNear` returns none),
   * so the same seed produced different bot behaviour depending on what the previous
   * match happened to leave behind. Anything added to the constructor belongs here.
   */
  deactivate() {
    this.alive = false;
    this._everSpawned = false;
    this._deadEmitted = false;
    this.health = 0;
    this.armor = 0;
    this.velocity.set(0, 0, 0);
    this.deathTime = -999;
    this.respawnAt = 0;

    // ---- pose
    this.pitch = 0;
    this.height = STAND_HEIGHT;
    this.eyeHeight = EYE_STAND;
    this.crouching = false;
    this.grounded = false;
    this._syncHitboxes();

    // ---- perception
    this.target = null;
    this.targetVisible = false;
    this.lastKnown.set(0, 0, 0);
    this.lastKnownVel.set(0, 0, 0);
    this.timeSinceSeen = 999;
    this.suspicion = 0;
    this.suppression = 0;
    this.investigatePoint.set(0, 0, 0);
    this.investigateConfidence = 0;
    this.lastDamageTime = -999;

    // ---- state machine
    this.state = 'idle';
    this.stateTimer = 0;
    this.searchHold = 0;
    this.peekTimer = 0;
    this.peeking = false;
    this.peekOffset = 0;
    this.inCover = false;
    this.coverFailed = false;
    this.coverBudget = 0;
    this.coverCooldown = 0;
    this.patrolHold = 0;
    this.patrolPause = 1;
    this._lastReport = -999;

    // ---- movement
    this.moveMode = 'walk';
    this.wantCrouch = false;
    this.wantJump = false;
    this.destination.set(0, 0, 0);
    this.destTolerance = WAYPOINT_RADIUS;
    this.repathTimer = 0;
    this._pathDest.set(0, 0, 0);
    // Bots are pooled across matches, so a live climb commitment would otherwise
    // survive into the next one and make the sim a function of match history.
    this.climbGoal.set(0, 0, 0);
    this.climbLock = 0;
    this._separation.set(0, 0, 0);
    this.strafeDir = 0;
    this.strafeTimer = 0;
    this._lookYaw = 0;
    this._lookTimer = 0;
    this.weapon?.stopFire?.();
    this.clearPath();
    this.game.bots?.releaseSweepClaim?.(this);

    // ---- stuck detection
    this._stuckSample.set(0, 0, 0);
    this._stuckTimer = 0;
    this._stuckLevel = 0;
    this._sidestepTimer = 0;
    this._sidestepSign = 1;
    this._wedgeTimer = 0;
    this._wedged = false;

    // ---- combat
    this.wantFire = false;
    this._reactTimer = 0;
    this._errMag = 0;
    this._errYaw = 0;
    this._errPitch = 0;
    this._errSpin = 0;
    this._sprayIn = 0;
    this._jitPhase = 0;
    this._burstLeft = 0;
    this._restTimer = 0;
    this._triggerHeld = false;
    this._extShotSeen = false;
    this._grenades = 2;
    this._grenadeCd = 6;
    this._aimYawTarget = 0;
    this._aimPitchTarget = 0;
    this._aimHeightFrac = 0.66;
    this._hitWall = false;
    // Scratch that outlives the match it was filled in. `_selectCover` falls back to
    // `_coverOut[0]` when the nav query returns nothing, which would otherwise hand a
    // bot a cover point from the previous match.
    if (this._coverOut) this._coverOut.length = 0;

    this._lastThinkTime = 0;
    this.anim.aim = 0;
    this.anim.reload = 0;
    this.anim.deathYaw = 0;
    this.model?.setVisible(false);
  }

  dispose() {
    this.model?.dispose();
    this.model = null;
    this.weapon = null;
    this.target = null;
    this.path.length = 0;
  }

  // ---------------------------------------------------------------- weapon

  equipWeapon() {
    const def = this._pickWeaponDef();
    if (!def) { this.weapon = null; this.profile = DEFAULT_PROFILE; return; }
    this.weapon = this._createWeaponInstance(def);
    this.profile = CLASS_PROFILE[def.class] || DEFAULT_PROFILE;
    if (this.weapon) {
      this.game.bus?.emit('weaponSwitch', { shooter: this, weaponId: def.id });
    }
  }

  _pickWeaponDef() {
    const list = Array.isArray(WeaponDefs.WEAPON_LIST) ? WeaponDefs.WEAPON_LIST : null;
    if (!list || list.length === 0) return null;
    // WEAPON_LIST also carries knives, grenades and launchers. Rolling one of
    // those as a bot's PRIMARY produced a soldier who walked around the map
    // never firing a shot — which read as "the AI is passive" and was in fact
    // "the AI is holding a smoke grenade". Only real primaries qualify.
    const pool = list.filter((w) => w && PRIMARY_CLASSES.has(w.class));
    if (!pool.length) {
      const fallback = list.filter((w) => w && w.class !== 'launcher');
      return this.rng.pick(fallback.length ? fallback : list) || list[0];
    }

    // Weighted roll over CLASSES, spread evenly across the defs inside each
    // class — so adding a third AR to the game does not make ARs three times as
    // likely, it just gives AR bots a third option.
    const weights = CLASS_WEIGHTS[this.personaName] || CLASS_WEIGHTS.roamer;
    const counts = this._classCounts || (this._classCounts = new Map());
    counts.clear();
    for (let i = 0; i < pool.length; i++) {
      counts.set(pool[i].class, (counts.get(pool[i].class) || 0) + 1);
    }
    const weightOf = (w) => (weights[w.class] ?? 1) / (counts.get(w.class) || 1);

    let total = 0;
    for (let i = 0; i < pool.length; i++) total += weightOf(pool[i]);
    if (total <= 0) return this.rng.pick(pool) || pool[0];
    let roll = this.rng() * total;
    for (let i = 0; i < pool.length; i++) {
      roll -= weightOf(pool[i]);
      if (roll <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  _createWeaponInstance(def) {
    const ws = this.game.weapons;
    if (ws && typeof ws.giveLoadout === 'function' && typeof ws.current === 'function') {
      // WeaponSystem owns per-entity instances: hand it a loadout, then read back the
      // equipped instance. This puts bots on exactly the same fire-rate, spread, recoil
      // and reload timing code as the player.
      try {
        const secondary = WeaponDefs.WEAPONS?.pistol_viper ? 'pistol_viper' : null;
        const ids = secondary && def.id !== secondary ? [def.id, secondary] : [def.id];
        ws.giveLoadout(this, ids);
        const w = ws.current(this);
        if (w && typeof w.tryFire === 'function') return w;
      } catch (err) {
        console.warn('[bot] WeaponSystem.giveLoadout failed, using fallback', err);
      }
    }
    return new FallbackWeapon(this.game, def, this);
  }

  needsReload() {
    const w = this.weapon;
    if (!w) return false;
    if (w.state === 'reloading') return false;
    if (typeof w.ammo !== 'number') return false;
    if (w.ammo === 0) return (w.reserve ?? 1) > 0;
    // Top off during a lull rather than mid-fight.
    const mag = w.def?.magSize ?? 30;
    return w.ammo <= Math.max(1, mag * 0.22) && !this.targetVisible && (w.reserve ?? 0) > 0;
  }

  startReload() { this.weapon?.reload?.(); }

  reloadDone() {
    const w = this.weapon;
    if (!w) return true;
    return w.state !== 'reloading' && (typeof w.ammo !== 'number' || w.ammo > 0);
  }

  /** Called by BotManager when a `shot` event names this bot as the shooter. */
  noteExternalShot() { this._extShotSeen = true; }

  // ------------------------------------------------------------ perception

  hasContact() { return !!(this.target && this.target.alive && this.timeSinceSeen < 1.2); }

  reactionReady() { return this._reactTimer <= 0; }

  distanceToTargetPos() {
    const p = this.targetVisible && this.target ? this.target.position : this.lastKnown;
    return Math.hypot(p.x - this.position.x, p.z - this.position.z);
  }

  forgetTarget() {
    if (this.target) this.investigatePoint.copy(this.lastKnown);
    this.investigateConfidence = Math.max(this.investigateConfidence, 0.6);
    this.target = null;
    this.targetVisible = false;
    this.timeSinceSeen = 999;
  }

  /**
   * Hearing. `kind` is 'shot' | 'explosion' | 'footstep'; the caller has already
   * decided the source is audible in principle, we apply range + confidence.
   */
  onHeard(point, kind, sourceTeamHostile = true) {
    if (!this.alive) return;
    const cfg = this.cfg;
    // Gunfire carries across most of an 86 m map — a firefight two blocks away
    // is the single most reliable way for the rest of the lobby to find the
    // fight, so these are deliberately generous.
    let range = 58;
    let weight = 0.8;
    if (kind === 'explosion') { range = 72; weight = 0.95; }
    else if (kind === 'footstep') { range = 14; weight = 0.5; }
    range *= cfg.hearMul;

    const dist = this.position.distanceTo(point);
    if (dist > range) return;

    const confidence = (1 - dist / range) * weight * (sourceTeamHostile ? 1 : 0.35);
    if (confidence <= this.investigateConfidence) {
      this.suspicion = Math.max(this.suspicion, confidence * 0.5);
      return;
    }
    this.investigateConfidence = confidence;
    this.investigatePoint.copy(point);
    // Sound localisation is imprecise — smear it, more so the further away.
    const smear = clamp(dist * 0.12, 0.5, 4.5);
    this.investigatePoint.x += this.rng.gauss() * smear;
    this.investigatePoint.z += this.rng.gauss() * smear;
    this.suspicion = Math.max(this.suspicion, confidence);

    if (kind !== 'footstep' && dist < 22) this.suppression = Math.min(1.6, this.suppression + 0.2);
    if (this.state === 'idle' || this.state === 'patrol') this.setState('investigate');
  }

  /** Full sensory sweep — the only place LOS raycasts happen. */
  _sense(dt) {
    const cfg = this.cfg;
    this.timeSinceSeen += dt;
    this.suspicion = Math.max(0, this.suspicion - dt * 0.16);
    this.suppression = Math.max(0, this.suppression - dt * 0.55);
    // Slow global bleed so a sound heard during a firefight does not stay a
    // valid lead forever; `investigate` decays it much faster on top of this.
    this.investigateConfidence = Math.max(0, this.investigateConfidence - dt * 0.045);

    const ents = this.game.entities;
    // Score every candidate cheaply, then raycast at most the best two. This is
    // what keeps LOS cost flat: <= 4 world.losClear calls per think, no matter
    // how many enemies are on screen.
    let c1 = null, s1 = Infinity;
    let c2 = null, s2 = Infinity;
    let c3 = null, s3 = Infinity;

    const eye = this.getEyePosition(_v1);

    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!this.isEnemy(e)) continue;
      const dx = e.position.x - this.position.x;
      const dz = e.position.z - this.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > cfg.visionRange * cfg.visionRange) continue;
      const dist = Math.sqrt(d2);

      // -- footsteps first (no LOS needed)
      const spd = e.velocity ? Math.hypot(e.velocity.x, e.velocity.z) : 0;
      const crouched = (e.height ?? STAND_HEIGHT) < 1.45;
      if (spd > 3.1 && !crouched && dist < 14 * cfg.hearMul) {
        this.onHeard(e.position, 'footstep', true);
      }

      // -- vision cone
      const desiredYaw = yawTo(this.position, e.position);
      const off = Math.abs(angleDelta(this.yaw, desiredYaw));
      const fovHalf = (cfg.fovDeg * 0.5) * DEG;
      // Alerted bots effectively check their flanks more.
      const alertBonus = (this.suspicion > 0.4 || this.state === 'engage') ? 0.32 : 0;
      if (off > fovHalf + alertBonus) continue;

      // Crouched and/or motionless targets are harder to pick out.
      let effRange = cfg.visionRange;
      if (crouched) effRange *= 0.74;
      if (spd < 0.4) effRange *= 0.93;   // motionless is harder to pick out, not invisible
      if (e === this.target && this.timeSinceSeen < 2) effRange *= 1.25;  // tracking is easier
      if (dist > effRange) continue;

      // Score: prefer near + centred, strongly prefer the current target.
      const score = dist + off * 12 - (e === this.target ? 14 : 0);
      if (score < s1) { c3 = c2; s3 = s2; c2 = c1; s2 = s1; c1 = e; s1 = score; }
      else if (score < s2) { c3 = c2; s3 = s2; c2 = e; s2 = score; }
      else if (score < s3) { c3 = e; s3 = score; }
    }

    // Three candidates, not two: in a crowded midfield the two nearest bodies
    // are often teammates' targets standing between us and the one enemy that
    // is actually exposed, and that enemy never got a LOS test. Still <= 6
    // world.losClear calls per think regardless of lobby size.
    let best = null;
    if (c1 && this._losToEntity(eye, c1)) best = c1;
    else if (c2 && this._losToEntity(eye, c2)) best = c2;
    else if (c3 && this._losToEntity(eye, c3)) best = c3;

    if (best) {
      const isNew = best !== this.target;
      if (isNew || this.timeSinceSeen > 1.6) this._acquire(best);
      this.target = best;
      this.targetVisible = true;
      this.timeSinceSeen = 0;
      this.lastKnown.copy(best.position);
      if (best.velocity) this.lastKnownVel.copy(best.velocity);
      this.suspicion = 1;
      // Keep the squad's lead fresh while the fight lasts, not just on acquire.
      if (this.game.time - this._lastReport > 2.5) this.callContact(best, 1);
    } else {
      this.targetVisible = false;
      // Dead-reckon the last known position for a moment so pushes feel smart.
      if (this.target && this.timeSinceSeen < 0.75) {
        this.lastKnown.addScaledVector(this.lastKnownVel, dt * 0.6);
      }
      if (this.target && (!this.target.alive || this.timeSinceSeen > cfg.memoryTime)) {
        this.forgetTarget();
      }
    }
  }

  _losToEntity(eye, e) {
    const world = this.game.world;
    if (!world || !world.losClear) return true;
    // Two probes: the eyes (peeking over cover) and the chest.
    if (e.getEyePosition) e.getEyePosition(_v2);
    else _v2.set(e.position.x, e.position.y + (e.eyeHeight ?? EYE_STAND), e.position.z);
    if (world.losClear(eye, _v2)) return true;
    _v3.set(e.position.x, e.position.y + (e.height ?? STAND_HEIGHT) * 0.6, e.position.z);
    return world.losClear(eye, _v3);
  }

  _acquire(e) {
    const cfg = this.cfg;
    // Where on the body this bot commits to aiming for the engagement. Better
    // bots aim higher up the chest and occasionally go for the head — but the
    // aim-error cone still decides whether they actually get it.
    const headChance = cfg.converge > 3 ? 0.20 : cfg.converge > 2 ? 0.11 : 0.04;
    this._aimHeightFrac = this.rng.chance(headChance) ? 0.90 : this.rng.range(0.58, 0.72);
    this._reactTimer = this.rng.range(cfg.reactMin, cfg.reactMax);
    this._errMag = cfg.aimErrorDeg * DEG;
    this._errSpin = this.rng.range(-2.4, 2.4);
    this._errYaw = this.rng.gauss() * 0.6;
    this._errPitch = this.rng.gauss() * 0.6;
    this._sprayIn = 1;
    this._burstLeft = 0;
    this._restTimer = this.rng.range(0, 0.08);
    if (e && e.position) this.lastKnown.copy(e.position);
    this.callContact(e, 1);
  }

  /**
   * Radio the contact to the squad through the team blackboard. Rate-limited so
   * a long firefight is a handful of calls, not one per think tick.
   */
  callContact(enemy, strength = 1) {
    if (!enemy) return;
    const now = this.game.time;
    if (now - this._lastReport < 1.2) return;
    this._lastReport = now;
    this.game.bots?.reportContact?.(this, enemy, strength);
  }

  /**
   * Inbound half of the blackboard: a teammate has called a contact. We do NOT
   * hand the bot a target (that would be a wallhack) — we hand it a lead worth
   * walking to, smeared by how good this difficulty's comms are, and let its own
   * eyes close the loop.
   */
  receiveContactCall(point, enemy, strength) {
    if (!this.alive || !point) return;
    if (this.targetVisible) return;                    // already busy
    const s = clamp(strength * (this.cfg.commsMul ?? 1), 0, 1);
    if (s <= 0.05 || s <= this.investigateConfidence * 0.95) return;

    this.investigateConfidence = s;
    this.investigatePoint.copy(point);
    const smear = (this.cfg.commsSmear ?? 3) * (1 - s * 0.7);
    this.investigatePoint.x += this.rng.gauss() * smear;
    this.investigatePoint.z += this.rng.gauss() * smear;
    this.suspicion = Math.max(this.suspicion, s);

    if (this.state === 'idle' || this.state === 'patrol') this.setState('investigate');
    else if (this.state === 'investigate') {
      this.setDestination(this.investigatePoint, 2.0);
      this.stateTimer = Math.max(this.stateTimer,
        clamp(this.distanceToDestination() / 4.2 + 3.5, 5, 18));
    }
  }

  // ----------------------------------------------------------------- think
  //
  // Called by BotManager on a staggered schedule (see thinkStride).

  think(dt) {
    if (!this.alive) return;
    this._sense(dt);
    this._computeSeparation();

    this.stateTimer -= dt;
    this.repathTimer -= dt;
    if (this.coverCooldown > 0) this.coverCooldown -= dt;

    // A bot that genuinely cannot make progress abandons the goal outright
    // rather than grinding against the same corner (see _updateStuck).
    if (this._wedged) {
      this._wedged = false;
      this.clearPath();
      if (this.state === 'patrol' || this.state === 'investigate') this.pickPatrolDestination();
      else this.setState('reposition');
    }

    const def = STATES[this.state] || STATES.idle;
    const next = def.think ? def.think(this, dt) : null;
    if (next && next !== this.state) this.setState(next);

    // Out-of-combat trickle regen so `retreat` means something.
    if (this.game.time - this.lastDamageTime > 4.5 && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + 14 * dt);
    }

    // Combat is worth thinking about more often than a patrol route.
    this.thinkStride = (this.state === 'engage' || this.state === 'takeCover'
      || this.state === 'pushOrFlank') ? 4 : 8;
  }

  setState(name) {
    if (!STATES[name] || name === this.state) return;
    const prev = STATES[this.state];
    prev?.exit?.(this);
    this.prevState = this.state;
    this.state = name;
    STATES[name].enter?.(this);
  }

  // -------------------------------------------------------------- fixed step

  fixedUpdate(dt) {
    if (this.weapon?._isFallback) this.weapon.fixedUpdate(dt);

    if (!this.alive) {
      // Bodies still fall to the floor.
      this._integrate(dt, 0, 0, 0);
      return;
    }

    if (this._reactTimer > 0) this._reactTimer -= dt;
    if (this._restTimer > 0) this._restTimer -= dt;
    if (this._sprayIn > 0) this._sprayIn = Math.max(0, this._sprayIn - dt / this.cfg.sprayInTime);
    if (this._grenadeCd > 0) this._grenadeCd -= dt;
    if (this.strafeTimer > 0) this.strafeTimer -= dt;
    if (this._sidestepTimer > 0) this._sidestepTimer -= dt;
    if (this._lookTimer > 0) this._lookTimer -= dt;
    if (this.climbLock > 0) {
      this.climbLock -= dt;
      const done = Math.abs(this.position.y - this.climbGoal.y) < 1.5;
      const pressed = this.targetVisible && this.target
        && this.position.distanceToSquared(this.target.position) < CLIMB_BREAK_RANGE * CLIMB_BREAK_RANGE;
      const hurt = this.game.time - this.lastDamageTime < 1.5;
      // Dropped the moment the bot has anything better to do, or has stopped making
      // progress. 10.5% of climb commits resolve to an A* best-partial that ends several
      // metres below the goal; for those, neither the arrival test nor the `done` test
      // above can ever fire, so without this the bot walked into a wall for the whole
      // lock and the stuck recovery could not help it.
      const fighting = CLIMB_YIELD_STATES.has(this.state);
      const wedged = this._stuckLevel > 0 || !this.hasPath();
      if (done || pressed || hurt || fighting || wedged) this.climbLock = 0;
    }

    this._updateStance(dt);
    this._updateAim(dt);
    this._updateFiring(dt);
    this._updateMovement(dt);
    this._updateStuck(dt);
    this._syncHitboxes();
  }

  _updateStance(dt) {
    const targetH = this.wantCrouch ? CROUCH_HEIGHT : STAND_HEIGHT;
    this.height = damp(this.height, targetH, 13, dt);
    if (Math.abs(this.height - targetH) < 0.01) this.height = targetH;
    this.crouching = this.height < 1.45;
    const t = clamp((this.height - CROUCH_HEIGHT) / (STAND_HEIGHT - CROUCH_HEIGHT), 0, 1);
    this.eyeHeight = lerp(EYE_CROUCH, EYE_STAND, t);
  }

  // ------------------------------------------------------------------- aim

  _updateAim(dt) {
    const cfg = this.cfg;
    const eye = this.getEyePosition(_v1);
    let aimYaw = this.yaw;
    let aimPitch = this.pitch;
    let turn = cfg.turnRate;

    const t = this.target;
    if (t && (this.targetVisible || this.timeSinceSeen < cfg.memoryTime)) {
      // -- aim point (with lead)
      if (this.targetVisible) {
        _v2.copy(t.position);
        _v2.y += (t.height ?? STAND_HEIGHT) * this._aimHeightFrac;
        if (t.velocity) {
          const dist = eye.distanceTo(_v2);
          const bulletTime = clamp(dist / 480, 0, 0.14);   // hitscan, but lead the *reaction*
          const leadT = (bulletTime + 0.09) * cfg.leadFactor;
          _v2.x += t.velocity.x * leadT * 2.4;
          _v2.z += t.velocity.z * leadT * 2.4;
        }
      } else {
        _v2.copy(this.lastKnown);
        _v2.y += 1.1;
      }

      aimYaw = yawTo(eye, _v2);
      const flat = Math.hypot(_v2.x - eye.x, _v2.z - eye.z);
      aimPitch = Math.atan2(_v2.y - eye.y, Math.max(0.05, flat));

      // -- converging error
      const tspd = t.velocity ? Math.hypot(t.velocity.x, t.velocity.z) : 0;
      const stillness = clamp(1 - tspd / 6.5, 0.12, 1);
      const settle = cfg.aimSettleDeg * DEG * lerp(2.6, 1.0, stillness);
      const rate = cfg.converge * lerp(0.5, 1.7, stillness) * (this.targetVisible ? 1 : 0.25);
      this._errMag = damp(this._errMag, settle, rate, dt);

      this._errSpin += dt * 0.7;
      const spin = this._errSpin;
      let mag = this._errMag * lerp(1, cfg.sprayInMul, this._sprayIn);
      if (this.crouching) mag *= 0.82;
      if (this.suppression > 0.5) mag *= 1 + (this.suppression - 0.5) * 0.6;

      const ex = Math.cos(spin) * this._errYaw + Math.sin(spin * 1.31) * 0.35;
      const ey = Math.sin(spin) * this._errPitch + Math.cos(spin * 0.83) * 0.28;
      aimYaw += ex * mag;
      aimPitch += ey * mag * 0.65;

      // -- ongoing hand jitter, never zero
      this._jitPhase += dt * 7.1;
      const jit = cfg.jitterDeg * DEG;
      aimYaw += Math.sin(this._jitPhase) * jit;
      aimPitch += Math.sin(this._jitPhase * 0.71 + 1.7) * jit * 0.6;

      // Snap harder for big corrections, but slow while still reacting.
      const off = Math.abs(angleDelta(this.yaw, aimYaw));
      turn = cfg.turnRate * (1 + Math.min(2.2, off * 1.6));
      if (this._reactTimer > 0) turn *= 0.35;
    } else if (this.hasPath() || this.hasDestination) {
      // Face where we are going, glancing around a little.
      const wp = this.currentWaypoint();
      if (wp) aimYaw = yawTo(this.position, wp);
      aimYaw += this._lookYaw;
      aimPitch = damp(this.pitch, 0, 4, dt);
      turn = cfg.turnRate * 0.7;
    } else {
      aimYaw = this.yaw + this._lookYaw;
      aimPitch = damp(this.pitch, 0, 4, dt);
      turn = cfg.turnRate * 0.5;
    }

    if (this.peekOffset !== 0) aimYaw += this.peekOffset * 0.18;

    this.yaw = moveAngleTowards(this.yaw, aimYaw, turn * dt);
    this.pitch = clamp(
      this.pitch + clamp(aimPitch - this.pitch, -turn * dt, turn * dt),
      -PITCH_LIMIT, PITCH_LIMIT,
    );
    this._aimYawTarget = aimYaw;
    this._aimPitchTarget = aimPitch;
  }

  lookAround(strength) {
    if (this._lookTimer > 0) return;
    this._lookTimer = this.rng.range(0.6, 1.8);
    this._lookYaw = this.rng.range(-1.1, 1.1) * strength;
  }

  // ---------------------------------------------------------------- firing

  _updateFiring(dt) {
    const w = this.weapon;
    if (!w) return;

    if (!this.wantFire || !this.alive) {
      if (this._triggerHeld) { w.stopFire?.(); this._triggerHeld = false; }
      return;
    }
    if (this._reactTimer > 0 || this._restTimer > 0) {
      if (this._triggerHeld) { w.stopFire?.(); this._triggerHeld = false; }
      return;
    }
    if (w.state === 'reloading' || w.state === 'switching') return;

    // Only shoot at something we can actually see, and only when pointed at it.
    if (!this.targetVisible || !this.target) {
      if (this._triggerHeld) { w.stopFire?.(); this._triggerHeld = false; }
      return;
    }
    const aimOff = Math.abs(angleDelta(this.yaw, this._aimYawTarget));
    if (aimOff > 0.16) return;

    const dist = this.position.distanceTo(this.target.position);
    const maxRange = (w.def?.range ?? 100) * 0.95;
    if (dist > maxRange) return;

    if (this._burstLeft <= 0) {
      const prof = this.profile;
      const near = clamp(1 - dist / (prof.ideal * 2), 0, 1);
      const lo = prof.burst[0], hi = prof.burst[1];
      const n = Math.round(lerp(lo, hi, near) * this.cfg.burstMul);
      this._burstLeft = Math.max(1, n);
    }

    if (this._pullTrigger()) {
      this._triggerHeld = true;
      this._burstLeft--;
      if (this._burstLeft <= 0) {
        const prof = this.profile;
        this._restTimer = this.rng.range(prof.rest[0], prof.rest[1]) * this.cfg.restMul;
        w.stopFire?.();
        this._triggerHeld = false;
      }
    }
  }

  _pullTrigger() {
    const w = this.weapon;
    if (typeof w.canFire === 'function' && !w.canFire()) return false;

    const before = typeof w.ammo === 'number' ? w.ammo : -1;
    this._extShotSeen = false;
    let ret = false;
    try { ret = w.tryFire ? w.tryFire() : false; } catch { return false; }
    const after = typeof w.ammo === 'number' ? w.ammo : -1;

    const fired = (before >= 0 && after >= 0) ? after < before : ret === true;
    if (!fired) {
      // Semi and burst weapons LATCH on the pull and only unlatch on release
      // (weaponSystem.js: `_triggerLatched`). A bot that only ever pulls fires
      // exactly one round for the rest of the match and then stands in the open
      // looking passive — which is what half the roster was doing, since four of
      // the ten primaries are semi-auto. Take the finger off the trigger
      // whenever a pull produced nothing so the next tick is a fresh pull.
      //
      // Auto weapons are deliberately excluded: their failed pulls are just the
      // rate-of-fire cooldown, and releasing would reset `shotsThisTrigger` and
      // hand the bot a recoil pattern that never climbs.
      if ((w.def?.fireMode ?? 'auto') !== 'auto') {
        w.stopFire?.();
        this._triggerHeld = false;
      }
      return false;
    }

    // If the weapon system already ran ballistics for us (it emitted `shot`),
    // do not fire a second bullet.
    if (!this._extShotSeen) this._fireBallistics();
    return true;
  }

  _fireBallistics() {
    const w = this.weapon;
    const def = w?.def || {};
    const game = this.game;
    const origin = this.getEyePosition(_v1);
    const dir = this.getAimDirection(_v2);

    // How steadily this tier holds the weapon itself. Without this the gun's own
    // cone (~1.3° for a rifle) swamped the aim model for the good tiers, so
    // hardened and veteran shot almost identically — the difficulty curve
    // existed on paper and not in the damage. Kept modest on purpose: even a
    // veteran's cone stays well inside human, and diagaim's error distribution
    // is the check on that.
    let base = (def.spreadHip ?? 2.2) * (this.profile.spreadMul || 1)
      * (this.cfg.weaponSpreadMul ?? 1);
    if (this.crouching) base *= def.spreadCrouchMul ?? 0.75;
    if (!this.grounded) base *= def.spreadAirMul ?? 2.4;

    // Planted vs running, blended CONTINUOUSLY on speed rather than switched at
    // a threshold. This is where fire discipline turns into damage: a planted
    // bot shoots an effectively aimed-down-sights cone, a jogging one eats the
    // weapon's full move penalty, and `fireMoveMul` (see _desiredSpeed) decides
    // how much each tier slows down to take the shot. A hard threshold made the
    // whole difference land on one side of a cliff.
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const moveT = clamp(speed / SPEED_COMBAT, 0, 1);
    const planted = lerp(base, def.spreadAds ?? 0.4, 0.55);
    const running = base * (def.spreadMoveMul ?? 1.7);
    let spreadDeg = lerp(planted, running, moveT);

    const pellets = Math.max(1, def.pellets ?? 1);
    const fire = Ballistics.fireHitscan;
    if (typeof fire === 'function') {
      for (let p = 0; p < pellets; p++) {
        spreadDir(dir, spreadDeg * DEG, this.rng, _v3);
        try {
          fire(game, {
            shooter: this,
            weaponId: def.id,
            origin,
            dir: _v3,
            damage: def.damage ?? 28,
            range: def.range ?? 110,
            falloffStart: def.falloffStart ?? 25,
            falloffEnd: def.falloffEnd ?? 65,
            falloffMin: def.falloffMin ?? 0.55,
            penetration: def.penetration ?? 0,
            tracer: p === 0,
          });
        } catch (err) {
          console.error('[bot] fireHitscan failed', err);
          break;
        }
      }
    }

    // Canonical event (§3). The payload's vectors are pooled — copy what you keep.
    const pl = this._shotPayload;
    pl.weaponId = def.id;
    pl.origin.copy(origin);
    pl.dir.copy(dir);
    game.bus?.emit('shot', pl);

    // Only when WE ran the shot — otherwise the weapon system owns presentation.
    game.present.muzzleFlash(origin, dir, 0.9, this, WeaponDefs.WEAPON_WIRE_IDX.get(def.id) ?? 0);
    game.present.play(def.audio?.fire ?? 'rifle', { position: origin, volume: 0.9 });
    game.nav?.addDanger?.(this.position, 0.5, 5);
  }

  /** Lob a frag at the last known position when the target is behind cover. */
  tryGrenade(dist) {
    if (this._grenadeCd > 0 || this._grenades <= 0 || !this.alive) return false;
    if (dist < 8 || dist > 28) return false;
    if (!this.rng.chance(this.cfg.grenadeChance)) { this._grenadeCd = this.rng.range(1.5, 3.5); return false; }

    const origin = this.getEyePosition(_v1);
    _v2.copy(this.lastKnown).sub(origin);
    const flat = Math.hypot(_v2.x, _v2.z);
    _v2.y += flat * 0.45 + 0.6;    // loft it into an arc
    _v2.normalize();
    const power = clamp(flat / 26, 0.35, 1);

    try {
      this.game.projectiles?.throwGrenade?.(this, origin, _v2, power);
    } catch (err) {
      console.warn('[bot] throwGrenade signature mismatch', err);
    }
    this._grenades--;
    this._grenadeCd = this.rng.range(15, 28);
    return true;
  }

  // -------------------------------------------------------------- movement

  hasPath() { return this.pathLen > 0 && this.pathIdx < this.pathLen; }

  clearPath() {
    this.pathLen = 0;
    this.pathIdx = 0;
    this.hasDestination = false;
    this.pathPending = false;
  }

  currentWaypoint() {
    if (this.hasPath()) return this.path[this.pathIdx];
    // Path exhausted (or never found) but we still have somewhere to be —
    // steer straight at it until we are inside the tolerance.
    if (this.hasDestination && !this.arrived()) return this.destination;
    return null;
  }

  /**
   * Arrival is a 3D question on a map with floors above floors.
   *
   * This used to test XZ only, which is fine on a street and quietly fatal anywhere
   * else: a bot standing on the market hall's GROUND floor is within 1.8 m — measured
   * flat — of a point of interest on its ROOF, so it declared itself arrived, the team
   * board marked the roof as swept, and it walked off to the next leg without ever
   * touching a stair. Every rooftop and mezzanine destination the AI was handed
   * resolved that way, which is why they were never visited.
   *
   * The vertical gate is one storey minus a bit: loose enough that stairs, kerbs and
   * the 1.6 m the path follower already tolerates never trip it, tight enough that a
   * different floor is a different place.
   */
  arrived() {
    if (!this.hasDestination) return true;
    const dx = this.destination.x - this.position.x;
    const dz = this.destination.z - this.position.z;
    if (dx * dx + dz * dz >= this.destTolerance * this.destTolerance) return false;
    return Math.abs(this.destination.y - this.position.y) < ARRIVE_VERTICAL;
  }

  distanceToDestination() {
    if (!this.hasDestination) return 0;
    return Math.hypot(this.destination.x - this.position.x, this.destination.z - this.position.z);
  }

  setDestination(point, tolerance = WAYPOINT_RADIUS) {
    // Re-path only when it can change the answer. States call setDestination
    // every think tick, and re-running A* for a destination that has not moved
    // is pure waste — especially for a cross-layer goal, which is the one
    // search expensive enough to show up in a frame.
    // A climb in progress outranks a PATROL decision — but never a fighting one.
    //
    // The lock exists because every other destination pick resolves to the bot's current
    // floor, so the first think tick after the stairs came into view used to pull the bot
    // straight back off them. Letting it outrank everything was much too strong: measured,
    // it swallowed 24% of `engage` and 23% of `takeCover` destination requests, so roughly
    // one time in four a bot decided it needed cover and then simply did not go. Bots
    // motionless for six seconds or more went from 1 window to 21.
    //
    // Combat states are exempt. A bot that has decided to shoot, take cover, push or run
    // has a reason that beats sightseeing, and the `stuck` recovery path is exempt for the
    // same reason — it recovers via `pickPatrolDestination`, which the guard was
    // swallowing, so a wedged bot could not free itself for the whole lock.
    if (this.climbLock > 0 && this.climbGoal.distanceToSquared(point) > 1
      && !CLIMB_YIELD_STATES.has(this.state) && this._stuckLevel === 0) return;
    const moved = this.hasDestination ? this.destination.distanceToSquared(point) : Infinity;
    this.destination.copy(point);
    this.destTolerance = tolerance;
    this.hasDestination = true;
    const stale = this.repathTimer <= 0;
    if (!this.hasPath() || moved > 4 || (stale && this._pathDest.distanceToSquared(point) > 1)) {
      this.requestPath(point);
    }
  }

  requestPath(point) {
    this._pathDest.copy(point);
    this.pathPending = true;
    this.repathTimer = REPATH_INTERVAL;
  }

  /** Run by BotManager under a global per-tick pathfinding budget. */
  servicePath() {
    if (!this.pathPending) return false;
    this.pathPending = false;
    const nav = this.game.nav;
    if (!nav || !nav.ready) { this.pathLen = 0; return false; }
    let n = nav.findPath(this.position, this._pathDest, this.path);
    if (n > 2) n = nav.smoothPath(this.path, n);
    this.pathLen = n;
    this.pathIdx = 0;
    // path[0] is the cell we are already standing on — skip it.
    if (n > 1 && this.path[0].distanceToSquared(this.position) < 1.2) this.pathIdx = 1;
    // No route at all: drop the destination so the state machine picks another.
    if (n === 0) { this.hasDestination = false; this.climbLock = 0; }
    return n > 0;
  }

  _advancePath() {
    while (this.hasPath()) {
      const wp = this.path[this.pathIdx];
      const dx = wp.x - this.position.x;
      const dz = wp.z - this.position.z;
      const dy = Math.abs(wp.y - this.position.y);
      if (dx * dx + dz * dz < WAYPOINT_RADIUS * WAYPOINT_RADIUS && dy < 1.6) this.pathIdx++;
      else break;
    }
  }

  _desiredSpeed() {
    let base;
    if (this.crouching) base = SPEED_CROUCH;
    else if (this.moveMode === 'sprint') base = SPEED_SPRINT;
    else if (this.moveMode === 'combat') base = SPEED_COMBAT;
    else if (this.moveMode === 'walk') base = SPEED_RUN * 0.6;
    else base = SPEED_RUN;

    // FIRE DISCIPLINE. Actively shooting at something you can see is the moment
    // to stop dancing and take the shot. How much a bot slows is the single
    // sharpest difficulty dial in the whole file, because the weapon's own
    // move-spread penalty is ~1.9x: a veteran plants and shoots an ADS-tight
    // cone, a recruit keeps jogging and sprays. Before this, better bots pushed
    // and flanked MORE, so they spent more of every fight at full move spread —
    // which is why measured hit rate came out flat across all four tiers.
    if (this.wantFire && this.targetVisible && this._reactTimer <= 0 && this._restTimer <= 0) {
      base *= this.cfg.fireMoveMul ?? 1;
    }

    // Small persistent gait variation so a squad does not move as one animal.
    return base * (this.weapon?.def?.moveSpeedMul ?? 1) * this.persona.speed;
  }

  _updateMovement(dt) {
    this._advancePath();

    let dirX = 0, dirZ = 0;
    const wp = this.currentWaypoint();
    if (wp) {
      dirX = wp.x - this.position.x;
      dirZ = wp.z - this.position.z;
      const len = Math.hypot(dirX, dirZ);
      if (len > 0.001) { dirX /= len; dirZ /= len; }
      else { dirX = 0; dirZ = 0; }

      // Jump only for a genuine small step-up the world cannot walk us over.
      const rise = wp.y - this.position.y;
      if (this.grounded && rise > 0.58 && rise < 1.35 && len < 1.8) this.wantJump = true;
    }

    // -- combat strafing: orbit the target instead of standing in the open
    const mayStrafe = this.state === 'engage' || this.state === 'takeCover';
    if (mayStrafe && this.strafeDir !== 0 && this.target
      && (this.targetVisible || this.timeSinceSeen < 1.5)) {
      const ty = yawTo(this.position, this.targetVisible ? this.target.position : this.lastKnown);
      const sx = -Math.sin(ty + Math.PI * 0.5) * this.strafeDir;
      const sz = -Math.cos(ty + Math.PI * 0.5) * this.strafeDir;
      const strafeWeight = wp ? 0.45 : 1.0;
      dirX += sx * strafeWeight;
      dirZ += sz * strafeWeight;
    }

    // -- local avoidance
    dirX += this._separation.x;
    dirZ += this._separation.z;

    // -- stuck side-step
    if (this._sidestepTimer > 0) {
      const px = -dirZ * this._sidestepSign;
      const pz = dirX * this._sidestepSign;
      dirX += px * 1.4;
      dirZ += pz * 1.4;
    }

    const len2 = Math.hypot(dirX, dirZ);
    if (len2 > 0.001) { dirX /= len2; dirZ /= len2; }
    else { dirX = 0; dirZ = 0; }

    const wantsToMove = !!wp || (mayStrafe && this.strafeDir !== 0) || this._sidestepTimer > 0;
    const speed = wantsToMove && len2 > 0.001 ? this._desiredSpeed() : 0;
    const accel = this.grounded ? 26 : 6;
    const tx = dirX * speed;
    const tz = dirZ * speed;
    this.velocity.x = damp(this.velocity.x, tx, accel, dt);
    this.velocity.z = damp(this.velocity.z, tz, accel, dt);

    let jumpV = 0;
    if (this.wantJump && this.grounded) { jumpV = JUMP_VELOCITY; this.wantJump = false; }
    this._integrate(dt, this.velocity.x, this.velocity.z, jumpV);
  }

  _integrate(dt, vx, vz, jumpV) {
    const world = this.game.world;
    this.velocity.x = vx;
    this.velocity.z = vz;
    if (jumpV) this.velocity.y = jumpV;
    // Gravity is applied by the caller (§5).
    this.velocity.y = Math.max(TERMINAL_FALL, this.velocity.y + GRAVITY * dt);

    if (!world || !world.move) {
      this.position.addScaledVector(this.velocity, dt);
      return;
    }
    const res = world.move(this.position, this.velocity, this.radius, this.height, dt);
    if (!res) return;
    // The result object is pooled — copy immediately.
    this.position.copy(res.position);
    this.velocity.copy(res.velocity);
    this.grounded = !!res.grounded;
    this._hitWall = !!res.hitWall;
    if (this.grounded && this.velocity.y < 0) this.velocity.y = 0;
  }

  _computeSeparation() {
    this._separation.set(0, 0, 0);
    const mgr = this.game.bots;
    if (!mgr || !mgr.bots) return;
    const list = mgr.bots;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === this || !o.alive) continue;
      const dx = this.position.x - o.position.x;
      const dz = this.position.z - o.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 2.56 || d2 < 1e-5) continue;      // 1.6 m
      const d = Math.sqrt(d2);
      const w = (1.6 - d) / 1.6;
      this._separation.x += (dx / d) * w;
      this._separation.z += (dz / d) * w;
    }
    const l = Math.hypot(this._separation.x, this._separation.z);
    if (l > 1) { this._separation.x /= l; this._separation.z /= l; }
    this._separation.multiplyScalar(0.85);
  }

  _updateStuck(dt) {
    if (!this.hasDestination && this.strafeDir === 0) {
      this._stuckTimer = 0; this._stuckLevel = 0; this._wedgeTimer = 0; return;
    }
    this._stuckTimer += dt;
    if (this._stuckTimer < STUCK_WINDOW) return;

    const moved = this.position.distanceTo(this._stuckSample);
    this._stuckSample.copy(this.position);
    this._stuckTimer = 0;
    if (moved > STUCK_DISTANCE) { this._stuckLevel = 0; this._wedgeTimer = 0; return; }

    // Escalation ladder below handles the ordinary cases. This is the backstop:
    // if nothing has worked for ~6 s the goal itself is unreachable, so drop it
    // and let think() choose a different one. A bot can be briefly blocked; it
    // can never be permanently wedged.
    this._wedgeTimer += STUCK_WINDOW;
    if (this._wedgeTimer >= 6) {
      this._wedgeTimer = 0;
      this._stuckLevel = 0;
      this._wedged = true;
      this.hasDestination = false;
      this.pathLen = 0;
      this.pathIdx = 0;
      return;
    }

    this._stuckLevel++;
    if (this._stuckLevel === 1) {
      // 1) the path is probably stale.
      this.repathTimer = 0;
      if (this.hasDestination) this.requestPath(this.destination);
    } else if (this._stuckLevel === 2) {
      // 2) shoulder against geometry — slide along it.
      this._sidestepSign = this.rng.sign();
      this._sidestepTimer = 0.9;
      this.wantJump = this.grounded;
    } else {
      // 3) last resort: a short nudge onto the nearest walkable cell. Capped at
      //    0.6 m so it reads as shuffling free, never as a teleport.
      const nav = this.game.nav;
      const p = nav?.nearestWalkable?.(this.position, _v4);
      if (p) {
        _v5.copy(p).sub(this.position);
        _v5.y = 0;
        const d = _v5.length();
        if (d > 0.05) {
          _v5.multiplyScalar(Math.min(0.6, d) / d);
          this.position.add(_v5);
        }
      }
      this.velocity.set(0, this.velocity.y, 0);
      this._stuckLevel = 0;
      this.repathTimer = 0;
      if (this.hasDestination) this.requestPath(this.destination);
    }
  }

  // ------------------------------------------------------- destination picks

  /**
   * The sweep leg. First choice is always the team board, which is what turns
   * patrol from a random walk into a coordinated hunt: it knows which points of
   * interest are contested, which sit in the enemy's half, which a teammate is
   * already covering and where the last contact was called. The nav-local
   * fallback only runs if there is no manager or the board is empty.
   */
  pickPatrolDestination() {
    const mgr = this.game.bots;
    if (mgr?.pickSweepPoint && mgr.pickSweepPoint(this, _v4)) {
      // A sweep leg onto another floor is the one that needs protecting: it is long,
      // and the walk to the stairs looks exactly like a walk to nowhere until the bot
      // is on them. Committing to it is what makes the board's rooftop points real.
      if (!this.commitClimb(_v4, 1.8)) this.setDestination(_v4, 1.8);
      return;
    }
    const nav = this.game.nav;
    if (!nav?.ready) { this.hasDestination = false; return; }
    const anchor = this.investigateConfidence > 0.2 ? this.investigatePoint : this.position;
    const p = nav.randomPointNear(anchor, this.rng.range(18, 34), _v4, this.rng);
    if (p) this.setDestination(p, 1.8);
    else this.hasDestination = false;
  }

  /**
   * Commit to a destination on another floor: set it, and refuse to be talked out of
   * it for a few seconds (CLIMB_COMMIT_MIN..MAX, by distance) unless a target appears.
   */
  commitClimb(point, tolerance) {
    if (point.y - this.position.y < 2) return false;
    this.climbLock = 0;                 // so setDestination below is not self-blocked
    this.setDestination(point, tolerance);
    if (!this.hasDestination) return false;
    this.climbGoal.copy(point);
    const flat = Math.hypot(point.x - this.position.x, point.z - this.position.z);
    this.climbLock = clamp(CLIMB_COMMIT_MIN + flat / 3.5, CLIMB_COMMIT_MIN, CLIMB_COMMIT_MAX);
    return true;
  }

  pickRepositionDestination() {
    const nav = this.game.nav;
    if (!nav?.ready) { this.hasDestination = false; return; }
    // Repositioning is the cheapest chance the AI gets to change FLOOR: it is a short
    // leg, so unlike a cross-map patrol it survives long enough to be walked. Without
    // this every reposition resolved to the layer the bot was already standing on and
    // the only way up was a patrol leg that combat always interrupted.
    if (this.rng.chance(HIGH_GROUND_REPOSITION) && nav.elevatedPointNear) {
      const up = nav.elevatedPointNear(this.position, 10, 2.2, _v4, this.rng);
      if (up && this.commitClimb(up, 1.2)) return;
    }
    const p = nav.randomPointNear(this.position, this.rng.range(4, 10), _v4, this.rng);
    if (p) this.setDestination(p, 1.2);
    else this.hasDestination = false;
  }

  pickRetreatDestination() {
    const nav = this.game.nav;
    if (!nav?.ready) { this.hasDestination = false; return; }
    // Run away from the last known threat position.
    _v5.copy(this.position).sub(this.lastKnown);
    _v5.y = 0;
    if (_v5.lengthSq() < 0.01) _v5.set(this.rng.range(-1, 1), 0, this.rng.range(-1, 1));
    _v5.normalize().multiplyScalar(this.rng.range(12, 20));
    _v6.copy(this.position).add(_v5);
    const p = nav.nearestWalkable(_v6, _v4, true) || nav.randomPointNear(this.position, 14, _v4, this.rng);
    if (p) this.setDestination(p, 1.8);
    else this.hasDestination = false;
  }

  pickFlankDestination() {
    const nav = this.game.nav;
    if (!nav?.ready) { this.hasDestination = false; return; }
    // Approach the last known position from an angle, not down the sightline.
    _v5.copy(this.lastKnown).sub(this.position);
    _v5.y = 0;
    const dist = _v5.length();
    if (dist < 0.5) { this.pickRepositionDestination(); return; }
    _v5.normalize();
    // Lane assignment from the blackboard: teammates converging on the same
    // contact get slots 0, -1, +1, -2, +2 ... so the squad arrives on a spread
    // of angles instead of stacking into one doorway.
    const slot = this.game.bots?.approachSlot?.(this) ?? 0;
    const side = slot === 0 ? this.rng.sign() : Math.sign(slot);
    const spread = 1 + Math.abs(slot) * 0.65;
    const lateral = clamp(dist * 0.35 * this.persona.flank * spread, 3, 12) * side;
    // How far short of the contact the flank point sits. This used to be a flat
    // 35% of the distance, which meant a "push" from 30 m ended 25 m away — a
    // long walk that closed nothing, and the more aggressive the tier the more
    // of the fight it spent walking. Aggression now shortens the standoff, so
    // pushing actually means arriving.
    const back = clamp(dist * 0.25 * (1.35 - this.pushBias), 1.5, 7);
    _v6.set(
      this.lastKnown.x - _v5.x * back - _v5.z * lateral,
      this.lastKnown.y,
      this.lastKnown.z - _v5.z * back + _v5.x * lateral,
    );
    // Take the high ground into the contact when there is one to take. A balcony over
    // the flank point is the same manoeuvre as a wide angle on the floor, one storey
    // up, and it is what puts bots on roofs during a fight rather than only on patrol.
    if (this.rng.chance(HIGH_GROUND_FLANK * this.persona.flank) && nav.elevatedPointNear) {
      const up = nav.elevatedPointNear(_v6, 9, 2.2, _v4, this.rng);
      if (up && this.commitClimb(up, 1.6)) return;
    }
    const p = nav.nearestWalkable(_v6, _v4, true);
    if (p) this.setDestination(p, 1.6);
    else this.setDestination(this.lastKnown, 2.2);
  }

  pickCoverDestination() {
    const nav = this.game.nav;
    if (!nav?.ready) return false;
    // Cover is measured against the threat's EYE, not its feet.
    if (this.targetVisible && this.target?.getEyePosition) this.target.getEyePosition(_v6);
    else {
      const src = this.targetVisible && this.target ? this.target.position : this.lastKnown;
      _v6.set(src.x, src.y + EYE_STAND, src.z);
    }
    this._coverOut = this._coverOut || [];
    const n = nav.coverPointsNear(this.position, _v6, 13, this._coverOut, 3);
    if (n <= 0) return false;
    const pick = this._coverOut[this.rng.int(Math.min(n, 2))] || this._coverOut[0];
    this.setDestination(pick, 1.0);
    return true;
  }

  nearCover() {
    const nav = this.game.nav;
    return !!nav?.coverDirAt?.(this.position, _v4);
  }

  /** While holding cover, lean the aim out and back to slice the angle. */
  applyPeekOffset() {
    this.peekOffset = this.peeking ? (this.rng() < 0.5 ? -1 : 1) * 0.6 : 0;
  }

  /**
   * Step out of cover onto a cell that can actually see the last known position.
   * Leaning the aim is not enough — if the crate blocks the angle the bot needs
   * to physically clear it, which is what makes a peek a threat instead of a
   * pose. Falls back to a small nudge along the cover normal.
   */
  peekOut() {
    const nav = this.game.nav;
    const src = this.targetVisible && this.target ? this.target.position : this.lastKnown;
    _v6.set(src.x, src.y + EYE_STAND, src.z);
    const p = nav?.visiblePointNear?.(this.position, _v6, 4.5, _v4);
    if (p) { this.setDestination(p, 0.9); return; }
    // No clean angle nearby — sidle out along the cover face instead.
    const cd = nav?.coverDirAt?.(this.position, _v5);
    if (!cd) return;
    _v6.set(this.position.x - cd.z * 1.6 * this.peekOffset,
      this.position.y,
      this.position.z + cd.x * 1.6 * this.peekOffset);
    const q = nav?.nearestWalkable?.(_v6, _v4);
    if (q) this.setDestination(q, 0.8);
  }

  /** Drop back behind the cover point and stop moving. */
  holdCover() { this.clearPath(); }

  /**
   * Slide onto a nearby cell that can see the last known position. Same query
   * as peekOut but used mid-engagement, so a target that ducks behind a crate
   * is answered by taking the angle rather than by walking away.
   */
  regainAngle() {
    const nav = this.game.nav;
    this.moveMode = 'combat';
    _v6.set(this.lastKnown.x, this.lastKnown.y + EYE_STAND, this.lastKnown.z);
    // The radius stays at 6. Widening it to 13 looked obviously right and measured inert:
    // `visiblePointNear` keeps only the 64 nearest candidates in a fixed buffer and
    // LOS-tests the 10 nearest of those, so at CELL = 0.75 the tested set is capped at a
    // ~3.4 m ring and the radius stops mattering. Over 6000 real (searcher, target) pairs
    // on this map: identical 26.0% success rate, ZERO cases where 13 m found a cell 6 m
    // missed, and 4.12x the scan cost. If this needs to reach further, the lever is the
    // candidate cap in `navGrid.visiblePointNear`, not this number.
    const p = nav?.visiblePointNear?.(this.position, _v6, 6, _v4);
    if (p) { this.setDestination(p, 1.0); return; }

    // Nothing nearby can see it. Walk AT the last known position rather than doing
    // nothing: the old code simply returned, so the bot stood still until its 7 s memory
    // expired and it dropped to `investigate` — which reads, from the other end of the
    // room, exactly like an enemy that has stopped playing. Pushing is also the right
    // instinct; the sightline is usually restored a couple of metres later.
    this.setDestination(this.lastKnown, 1.0);
  }

  pickStrafe() {
    this.strafeDir = this.rng() < 0.5 ? -1 : 1;
    this.strafeTimer = this.rng.range(0.55, 1.5);
    // Occasionally plant and shoot rather than dancing forever.
    if (this.rng.chance(0.22)) { this.strafeDir = 0; this.strafeTimer = this.rng.range(0.4, 0.9); }
  }

  backpedal(distance) {
    const nav = this.game.nav;
    _v5.copy(this.position).sub(this.lastKnown);
    _v5.y = 0;
    if (_v5.lengthSq() < 0.01) return;
    _v5.normalize().multiplyScalar(distance);
    _v6.copy(this.position).add(_v5);
    const p = nav?.nearestWalkable?.(_v6, _v4);
    if (p) this.setDestination(p, 1.4);
  }

  // ------------------------------------------------------------- hitboxes

  _syncHitboxes() {
    const h = this.height;
    const hb = this.hitboxes;
    hb[0].offset.set(0, h - 0.14, 0);
    hb[0].size.set(0.30, 0.28, 0.30);
    hb[1].offset.set(0, h * 0.655, 0);
    hb[1].size.set(0.50, h * 0.47, 0.34);
    hb[2].offset.set(0, h * 0.24, 0);
    hb[2].size.set(0.44, h * 0.48, 0.34);
    hb[3].offset.set(0, h * 0.66, 0);
    hb[3].size.set(0.80, h * 0.28, 0.30);
  }

  // ----------------------------------------------------------------- visual

  update(dtFrame) {
    if (!this.model) return;
    const engaged = this.state === 'engage' || this.state === 'takeCover'
      || this.state === 'pushOrFlank' || this.state === 'reload';
    this.anim.aim = this.alive
      ? (engaged ? 1 : (this.investigateConfidence > 0.2 ? 0.45 : 0))
      : 0;
    this.anim.reload = this.weapon?.state === 'reloading' ? 1 : 0;
    this.model.update(dtFrame, this);
  }
}

export default Bot;
