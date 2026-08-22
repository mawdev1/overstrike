/**
 * Sector interest and AI activation budgets — `docs/contracts/sector-interest.md` (contract 14).
 *
 * Extends the shape `botManager.js` already established for the arena roster (a global
 * think/path budget, throttled by stride and round-robin — see that file's own header
 * comment) from "one roster" to "one budget per active sector", and extends `server.js`'s
 * existing spatial cull (`EVENT_RANGE_SQ`, `_bombPositionAuthorised`) from a flat distance
 * check to a coarser sector-relevance filter applied before it.
 *
 * This module knows nothing about entities, sessions, or bots — it is pure sector geometry
 * and activation-state bookkeeping, fed plain `{x,y,z}` positions and sector ids by callers
 * (`src/net/server.js`, `src/ai/botManager.js`). That keeps it independently testable and
 * keeps the "one relevant sector set" rule (contract §2) honest: both consumers read the
 * SAME instance rather than deriving their own notion of "nearby".
 *
 * Inert by design when no sectors are authored (`hasSectors() === false`, e.g. every map
 * today, since P3-06 is the sectors producer and has not landed yet): every method below
 * degrades to "everything is relevant, nothing is gated", which is exactly current arena
 * behaviour. Nothing in this module invents sector data — see `src/world/world.js`'s
 * `buildManifest`, which reads `MAP_MANIFEST.sectors` the same declared/missing way it
 * already reads objectives and callouts.
 */

/** §4.1. */
export const SECTOR_STATE = Object.freeze({
  DORMANT: 'dormant',
  WARMING: 'warming',
  ACTIVE: 'active',
});

/** §4.1 — "a fixed grace period rather than an instant cutoff", mirrors RESPAWN_DELAY's shape. */
export const SECTOR_COOLDOWN_S = 8;

/** §3 — "a shared strip up to 6 m wide either side of a sector boundary edge". */
export const TRANSITION_ZONE_M = 6;

/** §4.3 — warming think stride multiplier ("doubled relative to that sector's configured base"). */
const WARMING_STRIDE_MULT = 2;
/** §4.3 — warming path-search share ("halved"). */
const WARMING_PATH_SHARE = 0.5;

/** Distance from a point to an AABB; 0 if the point is inside. */
function distanceToBox(box, p) {
  const dx = Math.max(box.min.x - p.x, 0, p.x - box.max.x);
  const dy = Math.max(box.min.y - p.y, 0, p.y - box.max.y);
  const dz = Math.max(box.min.z - p.z, 0, p.z - box.max.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function insideBox(box, p) {
  return p.x >= box.min.x && p.x <= box.max.x
    && p.y >= box.min.y && p.y <= box.max.y
    && p.z >= box.min.z && p.z <= box.max.z;
}

export class SectorInterest {
  /**
   * @param {Array<{id:string, box:{min,max}, neighbours?:string[], populationCap?:number,
   *   baseThinkStride?:number}>} sectors — `MAP_MANIFEST.sectors` shape (§3.1), or empty/absent.
   */
  constructor(sectors = []) {
    /** @type {Array<object>} */
    this.sectors = Array.isArray(sectors) ? sectors : [];
    this._byId = new Map(this.sectors.map((s) => [s.id, s]));
    /** @type {Map<string,string>} sector id -> SECTOR_STATE */
    this.state = new Map();
    /** @type {Map<string,number>} sector id -> sim time it last qualified active/warming */
    this._lastElevated = new Map();
    for (const s of this.sectors) {
      this.state.set(s.id, SECTOR_STATE.DORMANT);
      this._lastElevated.set(s.id, -Infinity);
    }
  }

  hasSectors() {
    return this.sectors.length > 0;
  }

  sectorById(id) {
    return this._byId.get(id) ?? null;
  }

  neighboursOf(id) {
    return this._byId.get(id)?.neighbours ?? [];
  }

  /** §3 — entity footprint membership. Returns a sector id, or null if outside all sectors
   * (including when no sectors are authored at all). */
  sectorOf(position) {
    if (!position) return null;
    for (const s of this.sectors) {
      if (insideBox(s.box, position)) return s.id;
    }
    return null;
  }

  /**
   * §4.1 / §5.1 — the set of sectors a position's presence counts as "active" in: the
   * sector it occupies, plus any neighbour whose shared boundary it is within the
   * transition zone of. Empty if the position resolves to no sector.
   */
  occupiedSectorsFor(position) {
    const own = this.sectorOf(position);
    const out = new Set();
    if (!own) return out;
    out.add(own);
    for (const nId of this.neighboursOf(own)) {
      const n = this._byId.get(nId);
      if (n && distanceToBox(n.box, position) <= TRANSITION_ZONE_M) out.add(nId);
    }
    return out;
  }

  /**
   * §5.1 — a client's relevant sector set: its own sector plus every directly adjacent
   * neighbour (the transition-zone clause in §5.1 is already a subset of "every adjacent
   * neighbour", so no separate check is needed here). Returns an empty set for a position
   * outside every sector. When no sectors are authored, callers should treat relevance as
   * unconditional (`hasSectors() === false`) rather than call this.
   */
  relevantSetFor(position) {
    const own = this.sectorOf(position);
    const out = new Set();
    if (!own) return out;
    out.add(own);
    for (const nId of this.neighboursOf(own)) out.add(nId);
    return out;
  }

  /**
   * §5.1/§6 — is `toSectorId` relevant to a client/actor whose own sector is `fromSectorId`?
   * True unconditionally when no sectors are authored (module is inert). `fromSectorId`
   * being unresolved (actor outside every sector — should not happen for a server-tracked
   * entity, but never trust it) refuses everything rather than granting blanket relevance.
   */
  isRelevantTo(fromSectorId, toSectorId) {
    if (!this.hasSectors()) return true;
    if (!fromSectorId || !toSectorId) return false;
    if (fromSectorId === toSectorId) return true;
    return this.neighboursOf(fromSectorId).includes(toSectorId);
  }

  /**
   * §4.1/§4.2 — advance activation state for every sector given the union of sectors
   * currently "occupied" (§4.1's active trigger — see `occupiedSectorsFor`) by relevant
   * players this tick. `now` is the simulation clock (never render frames, matching
   * `botManager.js`'s own rule).
   *
   * @param {number} now
   * @param {Set<string>} occupied
   */
  tick(now, occupied) {
    if (!this.hasSectors()) return;
    for (const s of this.sectors) {
      const id = s.id;
      let want;
      if (occupied.has(id)) {
        want = SECTOR_STATE.ACTIVE;
      } else {
        want = (s.neighbours ?? []).some((n) => occupied.has(n))
          ? SECTOR_STATE.WARMING
          : SECTOR_STATE.DORMANT;
      }
      if (want !== SECTOR_STATE.DORMANT) {
        this._lastElevated.set(id, now);
        this.state.set(id, want);
      } else {
        const last = this._lastElevated.get(id) ?? -Infinity;
        if (now - last >= SECTOR_COOLDOWN_S) this.state.set(id, SECTOR_STATE.DORMANT);
        // else: still inside the cooldown grace period — hold the current elevated state.
      }
    }
  }

  stateOf(id) {
    return this.state.get(id) ?? SECTOR_STATE.DORMANT;
  }

  // ---------------------------------------------------------------- §4.3 budget scaling

  /** §4.3 — `dormant` sectors get zero think ticks. True for an unauthored sector id too. */
  thinkEnabled(sectorId) {
    if (!this.hasSectors()) return true;
    return this.stateOf(sectorId) !== SECTOR_STATE.DORMANT;
  }

  /** §4.3 — warming doubles the sector's configured base stride; active/dormant use base. */
  thinkStrideFor(sectorId, baseStride) {
    if (!this.hasSectors()) return baseStride;
    return this.stateOf(sectorId) === SECTOR_STATE.WARMING
      ? baseStride * WARMING_STRIDE_MULT
      : baseStride;
  }

  /** §4.3 — warming halves path-search share; used as a weight in the shared round-robin. */
  pathShareFor(sectorId) {
    if (!this.hasSectors()) return 1;
    return this.stateOf(sectorId) === SECTOR_STATE.WARMING ? WARMING_PATH_SHARE : 1;
  }

  /**
   * §4.3 overflow rule — "refused outright... no queueing and no eviction". `currentCount`
   * is the caller's own live count for that sector; this function only compares against the
   * declared cap. A sector with no declared cap (or an unauthored id) never refuses.
   */
  canAdmit(sectorId, currentCount) {
    const s = this._byId.get(sectorId);
    const cap = s?.populationCap;
    if (!Number.isFinite(cap)) return true;
    return currentCount < cap;
  }
}

export default SectorInterest;
