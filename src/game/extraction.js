import { createRNG } from '../core/rng.js';
import { FIXED_DT } from '../core/mathUtils.js';
import { hmacSha256, utf8, readUint32BE, stableJson, sha256Hex } from '../core/hash.js';

/**
 * OVERSTRIKE — the Extraction raid server.
 *
 * Implements `docs/contracts/extraction-match.md` v1.0.0 (FROZEN). Every rule below cites the
 * section it comes from; if this file and the contract disagree, the contract wins and this
 * file is the bug — same posture `bomb.js`'s header states for `bomb-rules.md`.
 *
 * ── What this module owns, and what it explicitly does not (§0, §5) ─────────────────────
 * This is the raid-server mechanism for §1's participant phase machine, §3's world/run loot
 * (containers, pickup, drop), §4's extraction exits, and §6/§7's `RunResult`/evidence
 * construction. It does NOT own:
 *  - `items-inventory.md`'s instance schema or lock mechanism — this module manipulates an
 *    in-memory projection of `item_instances` rows using the exact guard predicates the
 *    contract's SQL statements specify (§3.2, §3.2.1, §3.3), so the persistence layer that
 *    eventually backs this with real `UPDATE`s has one behaviour to match, not two.
 *  - `deployment.md`'s reservation/snapshot/admission — callers invoke `spawnParticipant`
 *    only once that contract's admission has already happened and loadout instances are
 *    already locked at `location='run'`.
 *  - `settlement.md`'s item disposition on `died`/`aborted`/`extracted` (§5 table) — this
 *    module only produces the `RunResult` that tells settlement what to do; it never itself
 *    sets `status='lost'` or moves anything to `location='permanent'`.
 *
 * ── Determinism (§3.1.1) ──────────────────────────────────────────────────────────────────
 * Static container contents are pure functions of `(runSeed, containerId, lootTableId)` via
 * the pinned `hash()`/`roll()` algorithm — HMAC-SHA256 keyed by the run seed, low 32 bits
 * seed a `mulberry32` PRNG, entries sampled in fixed ascending-`id` order. Two `ExtractionRun`
 * instances built from identical inputs produce byte-identical loot, phase logs and evidence.
 *
 * ── Server authority ──────────────────────────────────────────────────────────────────────
 * Every state transition here is driven by the raid server calling these methods from its own
 * tick loop and its own combat/geometry resolution (§4.1's "validated every server tick" —
 * this module does the validating; the caller supplies the per-tick facts: positions, held
 * interact keys, and death events from wherever the engine's own weapons/collision step
 * decided them). There is no client-trusted input anywhere in this file.
 */

// ────────────────────────────────────────────────────────────────────────────── loot rolls

function checkBox(box, where) {
  if (!box || typeof box !== 'object') throw new Error(`${where}: exit has no volume`);
  const { min, max } = box;
  for (const p of [min, max]) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      throw new Error(`${where}: volume corner is not a finite point`);
    }
  }
  if (min.x > max.x || min.y > max.y || min.z > max.z) {
    throw new Error(`${where}: volume has min > max on an axis`);
  }
  return { min: { x: min.x, y: min.y, z: min.z }, max: { x: max.x, y: max.y, z: max.z } };
}

function inBox(box, p) {
  return p.x >= box.min.x && p.x <= box.max.x
    && p.y >= box.min.y && p.y <= box.max.y
    && p.z >= box.min.z && p.z <= box.max.z;
}

/**
 * §3.1.1 step 1: `hash(runSeed, containerId)` — HMAC-SHA256(key=runSeed, message=containerId),
 * first 8 bytes read big-endian as a uint64, of which only the low 32 bits are used to seed
 * the PRNG (step 2). Returned as that low-32 value directly since nothing here needs the
 * high bits.
 */
export function containerSeed(runSeed, containerId) {
  const digest = hmacSha256(utf8(String(runSeed)), utf8(String(containerId)));
  return readUint32BE(digest, 4); // bytes [4..8) of the first 8 = low 32 bits of the uint64
}

/**
 * §3.1.1 step 2: seed a `mulberry32` PRNG with `seed`, walk `table.entries` in fixed ascending
 * `id` order, sample each entry independently against its own authored `weight` (treated as a
 * per-entry inclusion probability, per the contract's "sampling per entry against its
 * authored weight"). Pure function of `(table, seed)` — no wall clock, no counter, no I/O.
 */
export function rollLootTable(table, seed) {
  if (!table || !Array.isArray(table.entries)) return [];
  const rng = createRNG(seed);
  const entries = [...table.entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out = [];
  for (const entry of entries) {
    if (rng() < entry.weight) {
      out.push({ itemId: entry.itemId, quantity: entry.quantity ?? 1, stackable: !!entry.stackable });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────── the run object

/** §1 table. Terminal phases: extracted, dead, aborted. */
const TERMINAL_PHASES = new Set(['extracted', 'dead', 'aborted']);

export class ExtractionRun {
  /**
   * @param {object} opts
   * @param {string} opts.runId               `matches.match_id` (§6)
   * @param {string} opts.runSeed             §3.1.1 — pins every static container's contents
   * @param {string} [opts.lootTableVersion]  §3.1.1 — recorded, not itself consumed here
   * @param {string} [opts.serverBuild]
   * @param {string[]} [opts.sectorSet]
   * @param {import('./sectorInterest.js').SectorInterest} [opts.sectorInterest]  sector-interest.md
   *   §6 — when supplied, `openContainer`/`pickup` refuse `'off-sector'` for a target whose
   *   server-recorded sector is outside the actor's own last-known relevant set. Omitted (or a
   *   `SectorInterest` with no sectors authored) is a no-op, matching every map today.
   * @param {object} [opts.lootTables]        `{ [lootTableId]: { entries: [{id, itemId, weight, quantity, stackable}] } }`
   * @param {object} [opts.itemDefs]          `{ [itemId]: { stackable } }` — items-inventory.md §2 definitions this run cares about
   * @param {object[]} [opts.exits]           `ExtractionExit[]` (§4)
   * @param {object[]} [opts.containers]      `{ containerId, tier, lootTableId, position }[]` — static containers, rolled at construction (§3.1 "spinning-up")
   * @param {object[]} [opts.participants]    `{ accountId, squadId, loadoutInstances }[]`
   * @param {number} [opts.reconnectGraceSeconds] §2 table — default matches `auth.md` §7 / `bomb-rules.md` §9's 90s
   * @param {number} [opts.hardTimeoutSeconds]
   */
  constructor(opts = {}) {
    if (!opts.runId) throw new Error('extraction: runId is required');
    if (!opts.runSeed) throw new Error('extraction: runSeed is required');
    this.runId = opts.runId;
    this.runSeed = opts.runSeed;
    this.lootTableVersion = opts.lootTableVersion ?? null;
    this.serverBuild = opts.serverBuild ?? 'dev';
    this.sectorSet = opts.sectorSet ?? [];
    this.sectorInterest = opts.sectorInterest ?? null;
    /** accountId -> last feet position `tick()` was called with (§6: "server's own sector
     * membership record for the acting entity ... derived from server-simulated position",
     * never from the command payload). */
    this._lastPositions = new Map();
    this.lootTables = opts.lootTables ?? {};
    this.itemDefs = opts.itemDefs ?? {};
    this.reconnectGraceSeconds = opts.reconnectGraceSeconds ?? 90;
    this.hardTimeoutSeconds = opts.hardTimeoutSeconds ?? null;

    /** §1.1 spinning-up -> active -> collapsing -> ended */
    this.phase = 'spinning-up';
    this.elapsedTicks = 0;
    this.startedAt = opts.startedAt ?? new Date().toISOString();
    this.endedAt = null;

    /** exitId -> compiled exit (§4) */
    this.exits = new Map();
    for (const ex of (opts.exits ?? [])) this._registerExit(ex);

    /** instanceId -> row — the in-memory `item_instances` projection this contract owns (§3, §5) */
    this.instances = new Map();
    /** containerId -> row (§3.1) */
    this.containers = new Map();
    this._containerSeq = 0;

    /** accountId -> participant record (§1) */
    this.participants = new Map();
    for (const p of (opts.participants ?? [])) this._registerParticipant(p);

    /** Ordered domain event log (§8), same role `bomb.js`'s `this.events` plays. */
    this.events = [];
    /** §7 `lootEvents` — ordered by tick, the sole producer of this evidence stream. */
    this.lootEvents = [];
    /** §7 `deathFacts`. */
    this.deathFacts = [];
    /** Bounded refusal log, mirroring `bomb.js`'s `_refusals`. */
    this._refusals = [];

    for (const c of (opts.containers ?? [])) this._registerStaticContainer(c);

    // §1.1: loot is seeded at spinning-up; the run is then immediately accepting deploys.
    this.phase = 'active';
    this._emit('extraction.run.started', {});
  }

  // ───────────────────────────────────────────────────────────────────────── small accessors

  _p(accountId) {
    const p = this.participants.get(accountId);
    if (!p) throw new Error(`extraction: unknown participant ${accountId}`);
    return p;
  }

  isAlive(accountId) {
    const p = this.participants.get(accountId);
    return !!p && (p.phase === 'raid' || p.phase === 'extracting');
  }

  _emit(type, data = {}) {
    const row = { type, tick: this.elapsedTicks, ...data };
    this.events.push(row);
    return row;
  }

  _refuse(accountId, action, reason) {
    const row = { accountId, action, reason, tick: this.elapsedTicks };
    this._refusals.push(row);
    if (this._refusals.length > 256) this._refusals.shift();
    return { ok: false, reason };
  }

  _lootEvent({ accountId, instanceId = null, containerId = null, containerKind = null, action }) {
    const row = { tick: this.elapsedTicks, accountId, instanceId, containerId, containerKind, action };
    this.lootEvents.push(row);
    return row;
  }

  _logPhase(p) {
    p.phaseLog.push({ tick: this.elapsedTicks, phase: p.phase });
  }

  // ────────────────────────────────────────────────────────────────────────── registration

  _registerExit(ex) {
    if (!ex || typeof ex.id !== 'string' || ex.id === '') throw new Error('extraction: exit has no id');
    if (this.exits.has(ex.id)) throw new Error(`extraction: duplicate exit id "${ex.id}"`);
    const volume = checkBox(ex.volume, `extraction: exit "${ex.id}"`);
    const durationTicks = Math.max(1, Math.round((ex.durationSeconds ?? 5) / FIXED_DT));
    this.exits.set(ex.id, {
      id: ex.id,
      volume,
      requiresItemDefId: ex.requiresItemDefId ?? null,
      requiresSquadCount: ex.requiresSquadCount ?? null,
      activeWindow: ex.activeWindow ?? null,
      durationTicks,
    });
  }

  _registerParticipant({ accountId, squadId, loadoutInstances }) {
    if (this.participants.has(accountId)) throw new Error(`extraction: duplicate participant ${accountId}`);
    this.participants.set(accountId, {
      accountId,
      squadId: squadId ?? accountId,
      phase: 'deploy',
      connected: true,
      disconnectedAtTick: null,
      spawnedAtTick: null,
      pickupCount: 0,
      extracting: null, // { exitId, progressTicks }
      outcome: null,
      exitId: null,
      deathCause: null,
      lastKnownState: null,
      phaseLog: [],
      loadoutInstances: loadoutInstances ?? [],
    });
  }

  /**
   * §3.1: roll every static container's contents once, at spinning-up, deterministically
   * from `(runSeed, containerId, lootTableId)`. Never lazily on first open.
   */
  _registerStaticContainer({ containerId, tier = null, lootTableId = null, position }) {
    if (this.containers.has(containerId)) throw new Error(`extraction: duplicate container ${containerId}`);
    this.containers.set(containerId, {
      containerId, runId: this.runId, kind: 'static', tier, lootTableId,
      position: position ?? { x: 0, y: 0, z: 0 },
      state: 'sealed', openedByAccountId: null, openedAt: null,
    });
    const table = lootTableId != null ? this.lootTables[lootTableId] : null;
    const seed = containerSeed(this.runSeed, containerId);
    const contents = table ? rollLootTable(table, seed) : [];
    contents.forEach((item, idx) => {
      const instanceId = `${containerId}:${idx}`;
      this.instances.set(instanceId, {
        instanceId, itemId: item.itemId, quantity: item.quantity, stackable: item.stackable,
        location: 'container', containerId, runId: null, ownerAccountId: null,
        status: 'active', locked: false,
      });
    });
  }

  _newContainerId() {
    this._containerSeq += 1;
    return `${this.runId}:drop:${this._containerSeq}`;
  }

  // ──────────────────────────────────────────────────────────────────────────── §1 spawning

  /**
   * §1's `deploy -> raid` transition — this contract's mechanism, invoked once
   * `deployment.md` §4.5 step 4 has already admitted the participant and locked their
   * loadout instances at `location='run'`. Seeding those rows here (rather than trusting the
   * caller already did it) keeps this module self-contained and testable; a real deployment
   * pipeline performs the same seeding in its own transaction before calling this.
   */
  spawnParticipant(accountId) {
    const p = this._p(accountId);
    if (p.phase !== 'deploy') return this._refuse(accountId, 'spawn', 'wrongPhase');
    p.phase = 'raid';
    p.spawnedAtTick = this.elapsedTicks;
    for (const inst of p.loadoutInstances) {
      this.instances.set(inst.instanceId, {
        instanceId: inst.instanceId, itemId: inst.itemId, quantity: inst.quantity ?? 1,
        stackable: !!inst.stackable, location: 'run', containerId: null, runId: this.runId,
        ownerAccountId: accountId, status: 'active', locked: true,
      });
    }
    this._logPhase(p);
    this._emit('extraction.participant.spawned', { accountId });
    return { ok: true };
  }

  // ──────────────────────────────────────────────────────────────────────────── §3.2 pickup

  /** Phase gate shared by open/pickup/drop (§3.2, §3.3: "the phase check... excludes extracting"). */
  _requireRaidPhase(accountId, action) {
    const p = this.participants.get(accountId);
    if (!p) throw new Error(`extraction: unknown participant ${accountId}`);
    if (p.phase !== 'raid') { this._refuse(accountId, action, 'wrongPhase'); return null; }
    return p;
  }

  /**
   * sector-interest.md §6 — "any command that claims an interaction happened ... is
   * validated against the server's own sector membership record for the acting entity ...
   * not against any sector or position the client asserts." Refuses when the target's
   * server-recorded position resolves to a sector outside the actor's own relevant set
   * (§5.1: own sector + neighbours). A no-op (never refuses) when `sectorInterest` is not
   * supplied, has no sectors authored, or either position is unknown — sector gating is
   * additive on top of every other check, never a substitute for them.
   */
  _sectorRefusal(accountId, targetPosition) {
    const si = this.sectorInterest;
    if (!si || !si.hasSectors() || !targetPosition) return null;
    const actorPos = this._lastPositions.get(accountId);
    if (!actorPos) return null;
    const actorSector = si.sectorOf(actorPos);
    const targetSector = si.sectorOf(targetPosition);
    if (!actorSector || !targetSector) return null;
    return si.isRelevantTo(actorSector, targetSector) ? null : 'off-sector';
  }

  /** §3.2 — open a sealed static container: player alive, phase raid, container sealed. */
  openContainer(accountId, containerId) {
    const p = this._requireRaidPhase(accountId, 'openContainer');
    if (!p) return { ok: false, reason: 'wrongPhase' };
    const c = this.containers.get(containerId);
    if (!c) return this._refuse(accountId, 'openContainer', 'noSuchContainer');
    const sectorReason = this._sectorRefusal(accountId, c.position);
    if (sectorReason) return this._refuse(accountId, 'openContainer', sectorReason);
    if (c.state !== 'sealed') return this._refuse(accountId, 'openContainer', 'alreadyOpened');
    c.state = 'opened';
    c.openedByAccountId = accountId;
    c.openedAt = this.elapsedTicks;
    for (const inst of this.instances.values()) {
      if (inst.containerId === containerId && inst.location === 'container') inst.location = 'world';
    }
    this._lootEvent({ accountId, containerId, containerKind: c.kind, action: 'opened' });
    this._emit('extraction.container.opened', { accountId, containerId });
    return { ok: true };
  }

  /**
   * §3.2 (plain path) / §3.2.1 (stackable merge path). The pickup `UPDATE`'s
   * `WHERE location='world' AND owner_account_id IS NULL AND status='active'` guard is
   * exactly `rowcount === 0` here too: this is a single-threaded, ordered simulation, so
   * "two players reaching for the same instance on the same tick" resolves to whichever
   * `pickup()` call the caller made first — there is no real race to lose, which is the same
   * outcome the SQL guard produces, just by construction rather than by database isolation.
   */
  pickup(accountId, instanceId) {
    const p = this._requireRaidPhase(accountId, 'pickup');
    if (!p) return { ok: false, reason: 'wrongPhase' };
    const inst = this.instances.get(instanceId);
    if (!inst || inst.location !== 'world' || inst.ownerAccountId != null || inst.status !== 'active') {
      return this._refuse(accountId, 'pickup', 'unavailable');
    }
    const sourceContainerId = inst.containerId;
    const sectorReason = this._sectorRefusal(accountId, this.containers.get(sourceContainerId)?.position);
    if (sectorReason) return this._refuse(accountId, 'pickup', sectorReason);
    const sourceKind = sourceContainerId ? this.containers.get(sourceContainerId)?.kind ?? null : null;
    const stackable = !!(this.itemDefs[inst.itemId]?.stackable ?? inst.stackable);
    let merged = false;
    if (stackable) {
      const existing = [...this.instances.values()].find((o) => o !== inst
        && o.ownerAccountId === accountId && o.itemId === inst.itemId
        && o.location === 'run' && o.runId === this.runId
        && o.status === 'active' && o.locked === false);
      if (existing) {
        inst.location = 'run';
        inst.runId = this.runId;
        inst.containerId = null;
        inst.ownerAccountId = accountId;
        inst.status = 'merged';
        existing.quantity += inst.quantity;
        merged = true;
      }
    }
    if (!merged) {
      inst.location = 'run';
      inst.runId = this.runId;
      inst.containerId = null;
      inst.ownerAccountId = accountId;
      inst.status = 'active';
    }
    p.pickupCount += 1;
    this._lootEvent({
      accountId, instanceId, containerId: sourceContainerId, containerKind: sourceKind, action: 'picked_up',
    });
    return { ok: true, merged };
  }

  // ────────────────────────────────────────────────────────────────────────────── §3.3 drop

  /** §3.3 — a currently-locked (loadout) row cannot be dropped; only run-acquired/unlocked loot can. */
  drop(accountId, instanceId, position) {
    const p = this._requireRaidPhase(accountId, 'drop');
    if (!p) return { ok: false, reason: 'wrongPhase' };
    const inst = this.instances.get(instanceId);
    if (!inst || inst.location !== 'run' || inst.runId !== this.runId
      || inst.ownerAccountId !== accountId || inst.locked !== false || inst.status !== 'active') {
      return this._refuse(accountId, 'drop', 'unavailable');
    }
    const containerId = this._newContainerId();
    this.containers.set(containerId, {
      containerId, runId: this.runId, kind: 'dropped', tier: null, lootTableId: null,
      position: position ?? { x: 0, y: 0, z: 0 }, state: 'opened',
      openedByAccountId: null, openedAt: null,
    });
    inst.location = 'world';
    inst.containerId = containerId;
    inst.runId = null;
    inst.ownerAccountId = null;
    this._lootEvent({ accountId, instanceId, containerId, containerKind: 'dropped', action: 'dropped' });
    this._emit('extraction.item.dropped', { accountId, instanceId, containerId });
    return { ok: true, containerId };
  }

  // ─────────────────────────────────────────────────────────────────────────── §4 exit exit

  /** Every `location='run'` row a participant currently holds — §4.1's completion freeze target. */
  _runInstancesOf(accountId) {
    const out = [];
    for (const inst of this.instances.values()) {
      if (inst.ownerAccountId === accountId && inst.location === 'run' && inst.runId === this.runId
        && inst.status === 'active') out.push(inst);
    }
    return out;
  }

  /** §4's declared conditions — item present, squad count, active window. All must hold. */
  _conditionsHold(exit, accountId, inVolumeByExit) {
    if (exit.activeWindow) {
      const [start, end] = exit.activeWindow;
      if (this.elapsedTicks < start || this.elapsedTicks > end) return false;
    }
    if (exit.requiresItemDefId) {
      const has = this._runInstancesOf(accountId).some((i) => i.itemId === exit.requiresItemDefId);
      if (!has) return false;
    }
    if (exit.requiresSquadCount) {
      const squadId = this._p(accountId).squadId;
      const set = inVolumeByExit.get(exit.id);
      let count = 0;
      for (const other of set) if (this.participants.get(other).squadId === squadId) count += 1;
      if (count < exit.requiresSquadCount) return false;
    }
    return true;
  }

  /**
   * §4.1 — the whole channel mechanism, run once per server tick for every participant.
   *
   * @param {Map<string, {x:number,y:number,z:number}>} positions  accountId -> feet position
   * @param {Map<string, boolean>} interactHeld                    accountId -> interact key held this tick
   */
  tick({ positions = new Map(), interactHeld = new Map() } = {}) {
    // §6 — the server-authoritative position record `openContainer`/`pickup` validate the
    // actor's sector against. Updated here, every tick, from the same per-tick position facts
    // the caller already supplies for the exit channel machine below — never from a claim
    // made on the interact command itself.
    for (const [accountId, pos] of positions) this._lastPositions.set(accountId, pos);

    // 1. Who is standing in which exit's volume this tick — needed before any single
    //    participant's condition check, since requiresSquadCount depends on everyone at once.
    const inVolumeByExit = new Map();
    for (const exitId of this.exits.keys()) inVolumeByExit.set(exitId, new Set());
    for (const [accountId] of this.participants) {
      if (!this.isAlive(accountId)) continue;
      const pos = positions.get(accountId);
      if (!pos) continue;
      for (const exit of this.exits.values()) {
        if (inBox(exit.volume, pos)) inVolumeByExit.get(exit.id).add(accountId);
      }
    }

    // 2. Per-participant channel state machine.
    for (const [accountId, p] of this.participants) {
      if (!p.connected) continue;
      if (p.phase !== 'raid' && p.phase !== 'extracting') continue;
      const pos = positions.get(accountId) ?? null;
      const held = interactHeld.get(accountId) === true;

      if (p.phase === 'extracting') {
        const exit = this.exits.get(p.extracting.exitId);
        const stillValid = pos !== null && inBox(exit.volume, pos) && held
          && this._conditionsHold(exit, accountId, inVolumeByExit);
        if (!stillValid) {
          // §4.1: "Progress resets to zero on interrupt — no partial credit, no resume."
          p.extracting = null;
          p.phase = 'raid';
          this._logPhase(p);
          continue;
        }
        p.extracting.progressTicks += 1;
        if (p.extracting.progressTicks >= exit.durationTicks) this._completeExtraction(p, exit);
        continue;
      }

      // phase === 'raid': did a channel just become eligible to start?
      if (!pos || !held) continue;
      for (const exit of this.exits.values()) {
        if (!inBox(exit.volume, pos)) continue;
        if (!this._conditionsHold(exit, accountId, inVolumeByExit)) continue;
        p.phase = 'extracting';
        p.extracting = { exitId: exit.id, progressTicks: 1 };
        this._logPhase(p);
        if (p.extracting.progressTicks >= exit.durationTicks) this._completeExtraction(p, exit);
        break; // one exit's channel at a time
      }
    }

    // 3. §2 — disconnect-past-grace becomes `aborted`.
    for (const [, p] of this.participants) {
      if ((p.phase === 'raid' || p.phase === 'extracting')
        && !p.connected && p.disconnectedAtTick != null) {
        if ((this.elapsedTicks - p.disconnectedAtTick) * FIXED_DT > this.reconnectGraceSeconds) {
          p.extracting = null;
          p.phase = 'aborted';
          p.outcome = 'aborted';
          this._logPhase(p);
        }
      }
    }

    // 4. §1.1 — hard timeout forces every still-live participant to `aborted`, run -> ended.
    if (this.hardTimeoutSeconds != null && this.phase !== 'ended'
      && this.elapsedTicks * FIXED_DT >= this.hardTimeoutSeconds) {
      this._forceEndOnTimeout();
    }

    this.elapsedTicks += 1;
  }

  _completeExtraction(p, exit) {
    p.phase = 'extracted';
    p.outcome = 'extracted';
    p.exitId = exit.id;
    p.extracting = null;
    for (const inst of this._runInstancesOf(p.accountId)) inst.locked = true; // §4.1 "frozen"
    this._logPhase(p);
    this._emit('extraction.exit.completed', { accountId: p.accountId, exitId: exit.id });
  }

  // ─────────────────────────────────────────────────────────────────────── §2 death / abort

  /** Health reaches zero (§1). `cause` is the closed enum §6 wants: player|ai|environment. */
  reportDeath(accountId, { cause, position = null } = {}) {
    const p = this._p(accountId);
    if (p.phase !== 'raid' && p.phase !== 'extracting') return this._refuse(accountId, 'death', 'wrongPhase');
    p.phase = 'dead';
    p.outcome = 'died';
    p.deathCause = cause;
    p.extracting = null;
    this._logPhase(p);
    this.deathFacts.push({ accountId, position, cause });
    return { ok: true };
  }

  disconnect(accountId) {
    const p = this._p(accountId);
    p.connected = false;
    p.disconnectedAtTick = this.elapsedTicks;
  }

  reconnect(accountId) {
    const p = this._p(accountId);
    if (p.phase === 'raid' || p.phase === 'extracting') {
      p.connected = true;
      p.disconnectedAtTick = null;
    }
  }

  /**
   * §2's raid-server-fault row. Only permitted with a trustworthy last phase (participant
   * actually reached `raid`, and isn't already terminal) — otherwise this contract must
   * decline to submit anything for the account, per §2's table and §6's acceptance bar.
   */
  reportServerFailure(accountId) {
    const p = this._p(accountId);
    if (p.spawnedAtTick == null || TERMINAL_PHASES.has(p.phase) || p.phase === 'deploy') {
      return { ok: false, reason: 'no-trustworthy-state' };
    }
    const phase = p.phase === 'extracting' ? 'at-exit' : (p.pickupCount > 0 ? 'looting' : 'not-looted');
    p.lastKnownState = { phase, exitId: p.phase === 'extracting' ? p.extracting.exitId : null };
    p.outcome = 'server-failure';
    return { ok: true, lastKnownState: p.lastKnownState };
  }

  // ─────────────────────────────────────────────────────────────────────────── §1.1 run end

  beginCollapsing() {
    if (this.phase === 'active') this.phase = 'collapsing';
  }

  allTerminal() {
    for (const p of this.participants.values()) {
      if (p.spawnedAtTick == null) continue; // never spawned -> not this contract's concern (§2)
      if (!TERMINAL_PHASES.has(p.phase)) return false;
    }
    return true;
  }

  _forceEndOnTimeout() {
    for (const [, p] of this.participants) {
      if (p.phase === 'raid' || p.phase === 'extracting') {
        p.extracting = null;
        p.phase = 'aborted';
        p.outcome = 'aborted';
        this._logPhase(p);
      }
    }
    this.end();
  }

  /** Normal or timeout-forced conclusion (§1.1 `ended`). Idempotent. */
  end() {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.endedAt = new Date().toISOString();
    this._emit('extraction.run.ended', {});
  }

  // ───────────────────────────────────────────────────────────────────── §6/§7 result output

  /**
   * §6's computation table, restated as code: never sets more than one of
   * `exitId`/`deathCause`/`lastKnownState`, and always sets exactly the one the outcome
   * requires. Only participants who actually spawned (reached `raid`) appear (§6:
   * "deploy-only participants never appear").
   */
  buildRunResult() {
    const participants = [];
    for (const p of this.participants.values()) {
      if (p.spawnedAtTick == null || p.outcome == null) continue;
      const row = { accountId: p.accountId, outcome: p.outcome };
      if (p.outcome === 'extracted') row.exitId = p.exitId;
      else if (p.outcome === 'died') row.deathCause = p.deathCause;
      else if (p.outcome === 'server-failure') row.lastKnownState = p.lastKnownState;
      participants.push(row);
    }
    return {
      runId: this.runId,
      participants,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      serverBuild: this.serverBuild,
      sectorSet: this.sectorSet,
      evidenceRef: this.buildEvidenceRef(),
    };
  }

  /** §7's evidence record — reconstructable from server-side facts alone. */
  buildEvidence() {
    const participants = [];
    for (const p of this.participants.values()) {
      if (p.spawnedAtTick == null) continue;
      participants.push({ accountId: p.accountId, phaseLog: p.phaseLog });
    }
    return {
      runId: this.runId,
      runSeed: this.runSeed,
      participants,
      lootEvents: this.lootEvents,
      deathFacts: this.deathFacts,
    };
  }

  buildEvidenceRef() {
    return sha256Hex(utf8(stableJson(this.buildEvidence())));
  }
}
