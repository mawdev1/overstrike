/**
 * Visuals for the players and bots this client does NOT simulate.
 *
 * A remote entity arrives as interpolated snapshot state — a position, an aim, a health
 * and a few flags. It has no `Bot`, no AI, no movement integrator, and deliberately so:
 * the server owns it, and anything this machine simulated on its behalf would be a second
 * opinion fighting the snapshots that are the actual truth.
 *
 * `BotModel` only reads seven fields off whatever it is handed — position, yaw, pitch,
 * velocity, height, alive, anim — so a plain object carrying those drives the existing rig
 * with no changes to it. That is the whole trick here: the renderer already had no idea
 * what a Bot was.
 *
 * Velocity is DERIVED rather than taken from the wire. The rig uses it to pick a walk
 * animation and to lean the body into a turn, and the interpolated position it is being
 * drawn at is the honest source for that — a snapshot's instantaneous velocity is from a
 * different moment than the position being rendered, so using it makes the legs disagree
 * with the motion.
 */
import * as THREE from 'three';
import { BotModel } from '../ai/botModel.js';

class Avatar {
  constructor(game, team) {
    this.model = new BotModel(game, team);
    this.model.setVisible(true);
    this.team = team;
    // The duck for BotModel.update. Same field names a Bot exposes.
    this.state = {
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      yaw: 0, pitch: 0, height: 1.8, alive: true,
      anim: { aim: 0, reload: 0, deathYaw: 0 },
    };
    this._lastPos = new THREE.Vector3();
    this._havePos = false;
    this._wasAlive = true;
  }

  dispose() { this.model?.dispose(); this.model = null; }
}

export class RemoteAvatars {
  constructor(game) {
    this.game = game;
    this.avatars = new Map();
  }

  /**
   * Sync the rigs to the session's interpolated remote states.
   *
   * @param {Map} remotes  from `MultiplayerSession.updateRemotes()`
   * @param {number} dt    render delta
   */
  update(remotes, dt) {
    const seen = new Set();

    for (const r of remotes.values()) {
      seen.add(r.id);
      let av = this.avatars.get(r.id);
      // A team change means a different colourway, which is baked into the rig — so the
      // rig is rebuilt rather than recoloured, exactly as `Bot.ensureTeamModel` does.
      if (av && av.team !== r.team) { av.dispose(); av = null; this.avatars.delete(r.id); }
      if (!av) {
        av = new Avatar(this.game, r.team);
        this.avatars.set(r.id, av);
      }

      const st = av.state;
      st.position.set(r.x, r.y, r.z);
      if (av._havePos && dt > 0) {
        st.velocity.subVectors(st.position, av._lastPos).divideScalar(dt);
      }
      av._lastPos.copy(st.position);
      av._havePos = true;

      st.yaw = r.yaw;
      st.pitch = r.pitch;
      st.height = r.crouching ? 1.15 : 1.8;

      // The rig reads these three and nothing wrote them. `BotModel` blends `aim` into a
      // shouldered stance, `reload` into the reload, and `deathYaw` decides which way a
      // body falls — so every remote player stood with their weapon at rest whatever they
      // were doing, never visibly reloaded, and every corpse fell the same way. All three
      // now come off flag bits that were already free in the snapshot.
      st.anim.aim = (r.ads || r.firing) ? 1 : 0;
      st.anim.reload = r.reloading ? 1 : 0;
      // Captured on the transition, from the yaw they were facing when they went down.
      if (av._wasAlive && !r.alive) st.anim.deathYaw = r.yaw;
      av._wasAlive = r.alive;
      st.alive = r.alive;

      av.model.setVisible(true);
      av.model.update(dt, st);
    }

    // Gone from the snapshot means gone from the match. Dispose rather than hide: the
    // rigs share instanced buffers and a hidden one still holds its slot.
    for (const [id, av] of this.avatars) {
      if (!seen.has(id)) { av.dispose(); this.avatars.delete(id); }
    }
  }

  dispose() {
    for (const av of this.avatars.values()) av.dispose();
    this.avatars.clear();
  }
}
