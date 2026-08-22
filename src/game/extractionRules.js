import { ExtractionRun } from './extraction.js';
import {
  LOOT_TABLES, EXTRACTION_ITEM_DEFS, ITEM_DEFINITIONS, LOOT_TABLE_VERSION, RUN_RULES,
} from './extractionContent.js';
import { getMapEntry } from '../world/world.js';
import { FIXED_DT } from '../core/mathUtils.js';

/**
 * OVERSTRIKE — the client raid runtime (P3-05/P3-07 slice, REQ-CC-073).
 *
 * The adapter between the referee's lifecycle (`match.js`) and the extraction raid server
 * (`extraction.js`, extraction-match.md FROZEN 1.0.0) — the exact role `BombRules` plays for
 * `bomb-rules.md`, and bound into the loop the same way: constructed by the mode's `init`,
 * ticked from the mode's `onTick` (i.e. from `Game._fixedUpdate` via `Match.fixedUpdate`),
 * torn down by the mode's `cleanup`.
 *
 * What it owns:
 *  - Building the `ExtractionRun` from THE authoritative positional set — the map registry
 *    entry's `EXTRACTION_EXITS` / `LOOT_CONTAINERS` (REQ-CC-075: placements are map data) —
 *    plus the P3-11 catalog (`extractionContent.js`) for loot tables, item defs and run rules.
 *  - Feeding the run its per-tick facts from the SIMULATION's own state: entity positions and
 *    the held interact key (`entity._held.interactHeld` — the same held-intent field the wire
 *    carries for Bomb, so a networked entity feeds this identically to a local one). Nothing
 *    here reads `game.input`; the player controller resolved it into the command already.
 *  - Routing the interact EDGE (the `interact` bus event `Player._interact` emits from the
 *    same command path) into `openContainer`/`pickup` intents, and exposing a `drop` intent.
 *  - The `raid` bus topic: loot/channel outcomes in the raid projection's typed-event
 *    vocabulary (`src/ui/raid/model.js` — `lootRefused` with `extraction.js`'s literal refusal
 *    reasons, `pickedUp`/`dropped`/`containerOpened`/`exitCompleted`/`channelInterrupted`).
 *  - `raidView()`: the documented v1 sample the raid HUD projects. Sealed-container contents
 *    never appear in it (§3.1) — sealed nearby caches list zero items at the SOURCE, so the
 *    projection's own drop-them guard is a second fence, not the only one.
 *
 * What it deliberately does not own: settlement (`RunResult` is handed to the match result for
 * whatever consumes it), persistence, deployment admission, and the AI. Bots on a raid map
 * remain ordinary combatants — they populate the map through `sectorInterest` exactly as in
 * any mode, and are NOT run participants; giving them a loot-then-exit objective is P3-05
 * follow-up work that must not be smuggled in through a rules adapter.
 */

/** How close (m) a container must be for an interact press / the nearby HUD card. */
const INTERACT_RANGE = 2.75;
const NEARBY_RANGE = 3.5;

const MS_PER_TICK = FIXED_DT * 1000;

/** itemId -> catalog row, for rarity/slot enrichment of HUD rows. Data lookup only. */
const CATALOG = new Map(ITEM_DEFINITIONS.map((d) => [d.itemId, d]));

const dist2 = (a, b) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};

export class ExtractionRules {
  constructor(match) {
    this.match = match;
    const game = match.game;
    this.game = game;

    // REQ-CC-075: the map registry entry is the sole positional authority. A map that
    // declares no exits cannot host a raid — throw here, at `startMatch`, exactly as
    // `BombRules` throws on a map with no objective volumes (see `bombAvailable`).
    const mod = getMapEntry(game.world?.mapId)?.module;
    const exits = mod?.EXTRACTION_EXITS;
    const containers = mod?.LOOT_CONTAINERS;
    if (!Array.isArray(exits) || exits.length === 0) {
      throw new Error(`extraction: map '${game.world?.mapId}' declares no EXTRACTION_EXITS — it cannot host a raid`);
    }

    /** The local participant. One per client runtime; a dedicated raid server adds more. */
    this.localAccountId = 'acct:local';
    /** accountId -> simulation entity whose server-side state feeds the run each tick. */
    this.entities = new Map();
    if (game.player) this.entities.set(this.localAccountId, game.player);

    const seed = (game.matchSeed ?? 0) >>> 0;
    this.hardTimeoutSeconds = RUN_RULES.hardTimeoutSeconds;
    this.run = new ExtractionRun({
      runId: `run-local-${seed}`,
      // §3.1.1 — the run seed IS the match seed, so two `startMatch({seed})` calls roll
      // byte-identical containers. Determinism is asserted by `scripts/raidtest.mjs`.
      runSeed: `seed-${seed}`,
      lootTableVersion: LOOT_TABLE_VERSION,
      serverBuild: 'local',
      sectorSet: (game.world?.manifest?.sectors ?? []).map((s) => s.id),
      sectorInterest: game.sectorInterest ?? null,
      lootTables: LOOT_TABLES,
      itemDefs: EXTRACTION_ITEM_DEFS,
      exits,
      containers,
      participants: game.player
        ? [{ accountId: this.localAccountId, squadId: 'squad:local', loadoutInstances: [] }]
        : [],
      reconnectGraceSeconds: RUN_RULES.reconnectGraceSeconds,
      hardTimeoutSeconds: this.hardTimeoutSeconds,
    });

    // §1 deploy -> raid. Local play has no deployment.md admission step in front of it; the
    // participant is admitted the moment the match begins, holding no locked loadout rows.
    if (game.player) this.run.spawnParticipant(this.localAccountId);

    // Reused per-tick maps — this runs at 120 Hz (§11, no per-tick allocation).
    this._positions = new Map();
    this._held = new Map();
    this._channelBefore = new Map();

    this._unsub = [];
    // The interact EDGE, from the existing input->sim path: `Player._updateWeapon` consumes
    // `cmd.interact` and emits this event. Same field a received network command carries.
    this._unsub.push(game.bus.on('interact', (p) => this._onInteract(p?.entity)));
  }

  dispose() {
    for (const u of this._unsub) u?.();
    this._unsub.length = 0;
  }

  _accountOf(entity) {
    for (const [acct, e] of this.entities) if (e === entity) return acct;
    return null;
  }

  _emitRaid(row) {
    this.game.bus.emit('raid', row);
  }

  // ─────────────────────────────────────────────────────────────── per-tick facts (§4.1)

  /** One fixed 1/120 s step. Called from the mode's `onTick`, i.e. `Match.fixedUpdate`. */
  tick() {
    const run = this.run;
    if (run.phase === 'ended') return;

    // §1.1 collapsing — RUN_RULES' warning window before the hard timeout.
    if (run.phase === 'active'
      && run.elapsedTicks * FIXED_DT >= this.hardTimeoutSeconds - RUN_RULES.collapseWarningSeconds) {
      run.beginCollapsing();
    }

    const positions = this._positions;
    const held = this._held;
    const before = this._channelBefore;
    positions.clear();
    held.clear();
    before.clear();
    for (const [acct, e] of this.entities) {
      if (!e) continue;
      positions.set(acct, e.position);
      // Held intent from the entity's resolved command state — never from `game.input`.
      held.set(acct, e.alive === true && e._held?.interactHeld === true);
      const p = run.participants.get(acct);
      if (p) before.set(acct, p.phase);
    }

    run.tick({ positions, interactHeld: held });

    // Channel transitions -> typed events for the HUD. The run's own event log records the
    // completion; the interruption is a transition only this diff can see (§4.1 "progress
    // resets to zero on interrupt").
    for (const [acct, prevPhase] of before) {
      const p = run.participants.get(acct);
      if (!p) continue;
      if (prevPhase === 'extracting' && p.phase === 'raid') {
        this._emitRaid({ type: 'channelInterrupted', accountId: acct });
      } else if (prevPhase !== 'extracted' && p.phase === 'extracted') {
        this._emitRaid({ type: 'exitCompleted', accountId: acct, exitId: p.exitId });
      }
    }
  }

  // ───────────────────────────────────────────────────────────────────── intents (§3, §4)

  /** Containers within `range` of a point, nearest first. */
  _nearestContainer(point, range) {
    let best = null;
    let bestD = range * range;
    for (const c of this.run.containers.values()) {
      const d = dist2(c.position, point);
      if (d <= bestD) { best = c; bestD = d; }
    }
    return best;
  }

  /** World instances sitting in a container, in stable insertion order. */
  _worldItemsIn(containerId) {
    const out = [];
    for (const inst of this.run.instances.values()) {
      if (inst.containerId === containerId && inst.location === 'world' && inst.status === 'active') out.push(inst);
    }
    return out;
  }

  /**
   * The interact edge: open the nearest sealed cache, otherwise take the first item from
   * the nearest opened one. Every outcome is the SERVER's answer — a refusal is reported in
   * `extraction.js`'s own reason vocabulary, never re-judged here.
   */
  _onInteract(entity) {
    const acct = entity ? this._accountOf(entity) : null;
    if (!acct) return;
    const c = this._nearestContainer(entity.position, INTERACT_RANGE);
    if (!c) return;
    if (c.state === 'sealed') {
      const res = this.run.openContainer(acct, c.containerId);
      this._emitRaid(res.ok
        ? { type: 'containerOpened', accountId: acct, containerId: c.containerId }
        : { type: 'lootRefused', accountId: acct, action: 'openContainer', reason: res.reason, containerId: c.containerId });
      return;
    }
    const items = this._worldItemsIn(c.containerId);
    if (items.length === 0) return;
    const res = this.run.pickup(acct, items[0].instanceId);
    this._emitRaid(res.ok
      ? { type: 'pickedUp', accountId: acct, instanceId: items[0].instanceId, merged: res.merged === true }
      : { type: 'lootRefused', accountId: acct, action: 'pickup', reason: res.reason, instanceId: items[0].instanceId });
  }

  /** §3.3 drop intent, at the entity's own server-side position. */
  drop(entity, instanceId) {
    const acct = entity ? this._accountOf(entity) : null;
    if (!acct) return { ok: false, reason: 'wrongPhase' };
    const p = entity.position;
    const res = this.run.drop(acct, instanceId, { x: p.x, y: p.y, z: p.z });
    this._emitRaid(res.ok
      ? { type: 'dropped', accountId: acct, instanceId, containerId: res.containerId }
      : { type: 'lootRefused', accountId: acct, action: 'drop', reason: res.reason, instanceId });
    return res;
  }

  // ─────────────────────────────────────────────────────────────────────── deaths (§1, §2)

  /** Referee-reported kill. Only run participants concern the run; bots are combatants. */
  onKill(victim, attacker) {
    const acct = victim ? this._accountOf(victim) : null;
    if (!acct || !this.run.isAlive(acct)) return;
    const cause = !attacker || attacker === victim ? 'environment' : attacker.isPlayer ? 'player' : 'ai';
    const p = victim.position;
    this.run.reportDeath(acct, { cause, position: { x: p.x, y: p.y, z: p.z } });
  }

  // ──────────────────────────────────────────────────────────────────────────── match end

  /**
   * The mode's `checkEnd`. Local slice: the run resolves when the local participant reaches
   * a terminal phase (§1) or the run itself ends (§1.1 hard timeout). `winnerTeam` speaks
   * the referee's team vocabulary only so `Match._end` computes win/loss honestly — a raid
   * has no winning team, and `decorateResult` blanks the winner name for that reason.
   */
  checkEnd() {
    const run = this.run;
    const player = this.game.player;
    const playerTeam = player?.team ?? 0;
    const opposition = playerTeam === 0 ? 1 : 0;
    const p = run.participants.get(this.localAccountId);
    if (p) {
      if (p.phase === 'extracted') {
        run.end();
        return { winner: playerTeam, winnerTeam: playerTeam, winnerEntity: player ?? null, reason: 'extracted' };
      }
      if (p.phase === 'dead') {
        run.end();
        return { winner: opposition, winnerTeam: opposition, winnerEntity: null, reason: 'died' };
      }
      if (p.phase === 'aborted') {
        run.end();
        return { winner: opposition, winnerTeam: opposition, winnerEntity: null, reason: 'aborted' };
      }
    }
    if (run.phase === 'ended') {
      return { winner: opposition, winnerTeam: opposition, winnerEntity: null, reason: 'aborted' };
    }
    return null;
  }

  // ──────────────────────────────────────────────────────────── raidView() — the v1 sample

  _inventoryRow(inst) {
    const def = CATALOG.get(inst.itemId);
    return {
      instanceId: inst.instanceId,
      itemId: inst.itemId,
      quantity: inst.quantity,
      stackable: inst.stackable === true,
      rarityTier: def?.rarityTier ?? 'common',
      slot: def?.slot ?? null,
      locked: inst.locked === true,
    };
  }

  _exitRow(exit, playerPos) {
    const conditions = {};
    if (exit.activeWindow) {
      conditions.window = {
        opensAt: exit.activeWindow[0] * MS_PER_TICK,
        closesAt: exit.activeWindow[1] * MS_PER_TICK,
      };
    }
    if (exit.requiresItemDefId) conditions.requiresItem = { itemId: exit.requiresItemDefId };
    if (exit.requiresSquadCount) {
      let present = 0;
      for (const [acct, e] of this.entities) {
        if (!e || !this.run.isAlive(acct)) continue;
        const b = exit.volume;
        const q = e.position;
        if (q.x >= b.min.x && q.x <= b.max.x && q.y >= b.min.y && q.y <= b.max.y
          && q.z >= b.min.z && q.z <= b.max.z) present += 1;
      }
      conditions.squad = { required: exit.requiresSquadCount, present };
    }
    const centre = {
      x: (exit.volume.min.x + exit.volume.max.x) / 2,
      y: (exit.volume.min.y + exit.volume.max.y) / 2,
      z: (exit.volume.min.z + exit.volume.max.z) / 2,
    };
    return {
      id: exit.id,
      label: exit.id.replace(/^exit-/, '').replaceAll('-', ' ').toUpperCase(),
      distanceM: playerPos ? Math.round(Math.sqrt(dist2(centre, playerPos)) * 10) / 10 : null,
      durationSeconds: exit.durationTicks * FIXED_DT,
      conditions,
    };
  }

  /**
   * The documented v1 raid-state sample (`src/ui/raid/model.js` header; fixture shape in
   * `src/ui/raid/fixtures.js`). Server-driven throughout: channel progress is the run's own
   * ratio, clocks are the run clock in ms, and a sealed container carries NO item rows.
   */
  raidView() {
    const run = this.run;
    const player = this.game.player;
    const p = run.participants.get(this.localAccountId);
    if (!p) return null;
    const nowMs = run.elapsedTicks * MS_PER_TICK;
    const playerPos = player?.position ?? null;

    const runInventory = [];
    for (const inst of run.instances.values()) {
      if (inst.ownerAccountId === this.localAccountId && inst.location === 'run'
        && inst.runId === run.runId && inst.status === 'active') {
        runInventory.push(this._inventoryRow(inst));
      }
    }

    let extracting = null;
    if (p.phase === 'extracting' && p.extracting) {
      const exit = run.exits.get(p.extracting.exitId);
      extracting = {
        exitId: p.extracting.exitId,
        progress: exit ? Math.min(1, p.extracting.progressTicks / exit.durationTicks) : 0,
      };
    }

    let nearby = { container: null, items: [] };
    const alive = p.phase === 'raid' || p.phase === 'extracting';
    if (alive && playerPos) {
      const c = this._nearestContainer(playerPos, NEARBY_RANGE);
      if (c) {
        nearby = {
          container: { containerId: c.containerId, kind: c.kind, tier: c.tier, state: c.state },
          // §3.1 — a sealed cache reveals nothing. Enforced at the source, not only in the
          // projection's own defensive drop.
          items: c.state === 'sealed' ? [] : this._worldItemsIn(c.containerId).map((i) => this._inventoryRow(i)),
        };
      }
    }

    return {
      version: 1,
      runId: run.runId,
      phase: run.phase === 'spinning-up' ? 'active' : run.phase,
      serverNow: nowMs,
      sampledAt: nowMs,
      hardTimeoutAt: this.hardTimeoutSeconds * 1000,
      localParticipant: {
        accountId: this.localAccountId,
        phase: p.phase,
        outcome: p.outcome,
        extracting,
      },
      runInventory,
      exits: [...run.exits.values()].map((exit) => this._exitRow(exit, playerPos)),
      nearby,
    };
  }
}
