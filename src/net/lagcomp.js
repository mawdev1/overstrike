/**
 * Lag compensation.
 *
 * A shooter fires at what they can see, which is the world as it was RTT/2 plus their
 * interpolation delay ago — roughly 100-150 ms in the past. If the server tests that shot
 * against the present, a player who was dead-centre on the shooter's screen is no longer
 * there, and the shot misses for reasons the shooter cannot perceive or learn from. So the
 * server rewinds every other entity to the moment the shooter saw, tests, and restores.
 *
 * What gets stored is the COMPUTED HITBOXES, not the transform they came from.
 * `_updateHitboxes` derives box offsets and sizes from `height` and `lean`, both of which
 * are themselves interpolated over several ticks — so recomputing them from a rewound
 * position would need the rewound height and lean too, and would then have to be kept in
 * step with the derivation forever. Storing the boxes makes the rewind exact by
 * construction and immune to that code changing.
 *
 * This also closes the hazard the Phase 3 review flagged: `_updateHitboxes` only runs at
 * the end of a LIVE tick, so restoring a transform and immediately raycasting would test
 * the CURRENT tick's boxes against a rewound position. Nothing here recomputes anything.
 *
 * Cost: 31 floats per entity per tick, 30 ticks deep (250 ms at 120 Hz). For 16 entities
 * that is under 60 KB — a ring rather than a full second, because a rewind further back
 * than a quarter second is a connection nobody can play on anyway.
 */

/** How many ticks of history. 30 at 120 Hz = 250 ms. */
export const HISTORY_TICKS = 30;

/**
 * Most hitboxes any entity has.
 *
 * Player has 3 (head, torso, limb); Bot has 4 — it carries an extra arms box, 0.80 m
 * wide, which is the widest part of the silhouette. An earlier version of this file
 * stored 3 and would have left a bot's arms un-rewound: shots at the edge of a moving
 * bot would have behaved differently from shots at its middle, which is close to
 * unreportable as a bug.
 */
const MAX_BOXES = 4;

/** Floats per entity per tick: 7 scalars + MAX_BOXES x (offset 3 + size 3). */
const STRIDE = 7 + MAX_BOXES * 6;

const OFF_X = 0, OFF_Y = 1, OFF_Z = 2, OFF_YAW = 3;
const OFF_ALIVE = 4, OFF_TEAM = 5, OFF_PROTECT = 6;
const OFF_BOXES = 7;

export class LagCompensation {
  constructor(game, { historyTicks = HISTORY_TICKS } = {}) {
    this.game = game;
    this.historyTicks = historyTicks;
    /** entityId -> Float32Array ring */
    this.rings = new Map();
    /** entityId -> tick of the newest sample, so a stale ring is not mistaken for fresh */
    this.newest = new Map();
    this._restoreBuf = new Map();
    this._rewound = false;
    this.stats = { records: 0, rewinds: 0, missing: 0 };
  }

  _ringFor(id) {
    let r = this.rings.get(id);
    if (!r) {
      r = new Float32Array(this.historyTicks * STRIDE);
      this.rings.set(id, r);
    }
    return r;
  }

  /** Sample every entity. Call once per tick, AFTER the simulation has stepped. */
  record() {
    const g = this.game;
    const tick = g.tick;
    const slot = (tick % this.historyTicks) * STRIDE;
    const ents = g.entities;
    const match = g.match;

    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      const r = this._ringFor(e.id);
      r[slot + OFF_X] = e.position.x;
      r[slot + OFF_Y] = e.position.y;
      r[slot + OFF_Z] = e.position.z;
      r[slot + OFF_YAW] = e.yaw;
      r[slot + OFF_ALIVE] = e.alive ? 1 : 0;
      r[slot + OFF_TEAM] = e.team ?? 0;
      // Spawn protection gates whether a hit may land at all, so it has to be rewound
      // with everything else: a player who WAS protected when the shooter saw them must
      // not be hittable now just because the protection has since lapsed.
      r[slot + OFF_PROTECT] = match?._protect?.get(e.id) ?? -1;

      const hb = e.hitboxes;
      if (hb) {
        if (hb.length > MAX_BOXES && !this._warnedBoxes) {
          this._warnedBoxes = true;
          console.warn(`[lagcomp] ${hb.length} hitboxes on entity ${e.id}, only ${MAX_BOXES} are rewound — raise MAX_BOXES`);
        }
        for (let b = 0; b < MAX_BOXES && b < hb.length; b++) {
          const o = OFF_BOXES + b * 6;
          r[slot + o] = hb[b].offset.x;
          r[slot + o + 1] = hb[b].offset.y;
          r[slot + o + 2] = hb[b].offset.z;
          r[slot + o + 3] = hb[b].size.x;
          r[slot + o + 4] = hb[b].size.y;
          r[slot + o + 5] = hb[b].size.z;
        }
      }
      this.newest.set(e.id, tick);
    }
    this.stats.records++;
  }

  /**
   * Rewind everyone except `shooter` to `tick`, then run `fn`, then restore.
   *
   * The shooter is left alone on purpose: they are already exactly where they believe
   * they are, and their own shot leaves from their own eye. Rewinding them too would
   * move the origin of the ray backwards as well as its targets, which double-counts the
   * latency and makes close-range shots miss behind the target.
   *
   * Restoration runs in a `finally`. A throw inside the callback while the world is
   * rewound would otherwise leave every entity 100 ms in the past permanently, which is
   * a far worse outcome than the original error.
   */
  rewind(tick, shooter, fn) {
    const target = this._clampTick(tick);
    this._enter(target, shooter);
    try {
      return fn();
    } finally {
      this._exit();
    }
  }

  _clampTick(tick) {
    const now = this.game.tick;
    const oldest = now - (this.historyTicks - 1);
    if (tick > now) return now;
    // Older than the ring: clamp rather than refuse. A shot from a client that far behind
    // is going to be judged against a stale world either way; the oldest sample we have
    // is strictly closer to what they saw than the present is.
    if (tick < oldest) return Math.max(0, oldest);
    return tick;
  }

  _enter(tick, shooter) {
    if (this._rewound) throw new Error('LagCompensation: already rewound — rewinds cannot nest');
    const slot = (tick % this.historyTicks) * STRIDE;
    const ents = this.game.entities;
    this._restoreBuf.clear();

    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e === shooter) continue;
      const r = this.rings.get(e.id);
      // No history for this entity — it joined within the last tick. Leaving it at its
      // present position is the only honest option, and the alternative (skipping it
      // entirely) would make a brand-new player unhittable.
      if (!r || this.newest.get(e.id) === undefined) { this.stats.missing++; continue; }

      const saved = {
        x: e.position.x, y: e.position.y, z: e.position.z,
        yaw: e.yaw, alive: e.alive, team: e.team,
        boxes: e.hitboxes ? e.hitboxes.map((b) => ({
          ox: b.offset.x, oy: b.offset.y, oz: b.offset.z,
          sx: b.size.x, sy: b.size.y, sz: b.size.z,
        })) : null,
      };
      this._restoreBuf.set(e, saved);

      e.position.set(r[slot + OFF_X], r[slot + OFF_Y], r[slot + OFF_Z]);
      e.yaw = r[slot + OFF_YAW];
      e.alive = r[slot + OFF_ALIVE] > 0.5;
      // Team is recorded and was never restored, so a friendly-fire test inside a rewind
      // used the PRESENT team — wrong for anyone who changed sides (a rebalance, or a
      // match restart) between the tick the shooter saw and now.
      e.team = r[slot + OFF_TEAM];
      if (e.hitboxes) {
        for (let b = 0; b < MAX_BOXES && b < e.hitboxes.length; b++) {
          const o = OFF_BOXES + b * 6;
          e.hitboxes[b].offset.set(r[slot + o], r[slot + o + 1], r[slot + o + 2]);
          e.hitboxes[b].size.set(r[slot + o + 3], r[slot + o + 4], r[slot + o + 5]);
        }
      }
    }
    this._rewound = true;
    this.stats.rewinds++;
  }

  _exit() {
    for (const [e, s] of this._restoreBuf) {
      e.position.set(s.x, s.y, s.z);
      e.yaw = s.yaw;
      e.alive = s.alive;
      e.team = s.team;
      if (s.boxes && e.hitboxes) {
        for (let b = 0; b < s.boxes.length && b < e.hitboxes.length; b++) {
          const q = s.boxes[b];
          e.hitboxes[b].offset.set(q.ox, q.oy, q.oz);
          e.hitboxes[b].size.set(q.sx, q.sy, q.sz);
        }
      }
    }
    this._restoreBuf.clear();
    this._rewound = false;
  }

  /**
   * Was `entity` spawn-protected at `tick`?
   *
   * Asked separately from the rewind because protection is not a property of the hitbox —
   * a rewound hit can be geometrically perfect and still must not land.
   */
  wasProtected(entity, tick) {
    const r = this.rings.get(entity.id);
    if (!r) return false;
    const slot = (this._clampTick(tick) % this.historyTicks) * STRIDE;
    const until = r[slot + OFF_PROTECT];
    if (until < 0) return false;
    const elapsedThen = tick * (1 / 120);
    return elapsedThen < until;
  }

  /** Drop history for an entity that has left. */
  forget(id) { this.rings.delete(id); this.newest.delete(id); }

  /**
   * The tick a client with this round-trip time was looking at.
   *
   * Their view is behind by half the round trip (the snapshot's travel) plus the
   * interpolation delay they deliberately hold. Both halves are real: leaving out the
   * interpolation delay under-rewinds by ~100 ms, which is most of the error.
   */
  viewTickFor(nowTick, rttMs, interpDelayMs, tickRateHz = 120) {
    const backMs = rttMs * 0.5 + interpDelayMs;
    return Math.max(0, Math.round(nowTick - (backMs / 1000) * tickRateHz));
  }
}
