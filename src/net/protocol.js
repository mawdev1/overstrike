/**
 * Wire format.
 *
 * Binary, little-endian, hand-rolled. Two directions with very different shapes:
 *
 *   client -> server   a batch of COMMANDS, one per fixed step, ~30 bytes each
 *   server -> client   a SNAPSHOT of entity state, delta-coded against the last one
 *                      the client acknowledged
 *
 * The rule everything here answers to: **a command must mean exactly the same thing on
 * both machines**. The client predicts the effect of a command locally and the server
 * later applies the same command authoritatively; if the two read different values out of
 * the same bytes, the prediction is wrong every single time and reconciliation spends its
 * life correcting a difference that is not the network's fault.
 *
 * That is why movement direction is an ENUM rather than a pair of quantised floats.
 * `wishForward`/`wishRight` only ever take nine combinations (eight compass directions and
 * neutral), with the diagonals scaled by 1/sqrt2. Quantising that to a byte and dividing
 * on the far side reproduces 0.7071067811865476 as something slightly different, and a
 * movement integrator fed a slightly different direction 120 times a second diverges
 * visibly within seconds. An enum reproduces it exactly, and costs less.
 *
 * Look deltas stay float32 — they are genuinely continuous, and a float32 is what the
 * client must predict with too (see `quantiseCommand`).
 */

// ── message types ─────────────────────────────────────────────────────────────────────
export const MSG_COMMANDS = 1;
export const MSG_SNAPSHOT = 2;
export const MSG_WELCOME = 3;

/** Edge fields, in bit order. Order is part of the wire format — append, never insert. */
export const EDGE_BITS = [
  'jump', 'crouchPressed', 'reload', 'melee', 'grenade', 'interact', 'inspect',
  'killstreak', 'lastWeapon', 'sprintDown', 'sprintUp', 'firePressed', 'aimButtonPressed',
];

/** Held fields, in bit order. Same rule. */
export const HELD_BITS = [
  'crouchHeld', 'toggleAdsMode', 'aimButtonHeld', 'fireHeld',
  'sprintKeyHeld', 'breathHold', 'leanKeyHeld', 'leanRightKeyHeld',
];

/**
 * The nine legal (wishForward, wishRight) pairs.
 *
 * Index 0 is neutral; 1..8 are the compass directions with diagonals pre-scaled. Stored
 * as the exact values `_refreshHeldState` produces, so an encode/decode round trip is the
 * identity rather than an approximation.
 */
const K = Math.SQRT1_2;
export const MOVE_DIRS = [
  [0, 0],
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [K, K], [K, -K], [-K, K], [-K, -K],
];

/** Inverse of MOVE_DIRS, keyed by a rounded pair so float noise cannot miss a bucket. */
const MOVE_INDEX = new Map();
for (let i = 0; i < MOVE_DIRS.length; i++) {
  MOVE_INDEX.set(`${MOVE_DIRS[i][0].toFixed(6)},${MOVE_DIRS[i][1].toFixed(6)}`, i);
}

export function moveDirIndex(wishForward, wishRight) {
  const hit = MOVE_INDEX.get(`${wishForward.toFixed(6)},${wishRight.toFixed(6)}`);
  if (hit !== undefined) return hit;
  // Not one of the nine — a analogue stick, or a bug. Snap to the nearest legal pair
  // rather than inventing a tenth: the far side can only decode what the table holds.
  let best = 0, bestD = Infinity;
  for (let i = 0; i < MOVE_DIRS.length; i++) {
    const dx = MOVE_DIRS[i][0] - wishForward, dy = MOVE_DIRS[i][1] - wishRight;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

export const COMMAND_BYTES = 30;

/**
 * Most commands one packet may carry.
 *
 * A client sends one command per fixed step, batched per rendered frame, plus three
 * resent for redundancy — so four or five is normal and sixteen is already generous.
 *
 * This is a hard limit rather than a guideline because the count is read from the wire.
 * Without it, a single 100 MiB frame declares ~3.5 million commands and `decodeCommands`
 * allocates an object for every one BEFORE any queue cap applies: measured at 500k, that
 * is 536 ms of blocked event loop and 739 MB of heap. On the 512 MB server that is an
 * OOM kill — one hostile packet ends the match for everyone.
 */
export const MAX_COMMANDS_PER_BATCH = 16;

/**
 * Force a command through the wire's value space WITHOUT sending it.
 *
 * The client has to predict using the values the server will decode, not the ones it
 * happened to read from the mouse. `deltaYaw` is a float64 in memory and a float32 on the
 * wire; predicting with the float64 and letting the server apply the float32 leaves a tiny
 * angular difference on every single command, which accumulates into a permanent aim
 * disagreement that reconciliation cannot explain and will keep trying to correct.
 *
 * Call this on a command before feeding it to local prediction.
 */
const _f32 = new Float32Array(1);
export function quantiseCommand(cmd) {
  _f32[0] = cmd.deltaYaw; cmd.deltaYaw = _f32[0];
  _f32[0] = cmd.deltaPitch; cmd.deltaPitch = _f32[0];
  const idx = moveDirIndex(cmd.wishForward || 0, cmd.wishRight || 0);
  cmd.wishForward = MOVE_DIRS[idx][0];
  cmd.wishRight = MOVE_DIRS[idx][1];
  return cmd;
}

/**
 * Encode a batch of commands.
 *
 * Batching is per rendered frame, not per command: at 120 Hz simulation and 60 Hz
 * rendering that is two commands a packet, and the header is paid once. The caller is
 * expected to include the last few already-sent commands as well — see the redundancy note
 * in the transport — so the batch is simply "every command the server may not have yet".
 */
export function encodeCommands(commands) {
  const buf = new ArrayBuffer(6 + commands.length * COMMAND_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG_COMMANDS);
  v.setUint8(1, 0);                          // reserved: flags
  v.setUint32(2, commands.length, true);

  let o = 6;
  for (const c of commands) {
    v.setUint32(o, c.seq >>> 0, true); o += 4;
    v.setUint32(o, c.tick >>> 0, true); o += 4;
    v.setUint8(o, moveDirIndex(c.wishForward || 0, c.wishRight || 0)); o += 1;

    let edges = 0;
    for (let i = 0; i < EDGE_BITS.length; i++) if (c[EDGE_BITS[i]]) edges |= (1 << i);
    v.setUint16(o, edges, true); o += 2;

    let held = 0;
    for (let i = 0; i < HELD_BITS.length; i++) if (c[HELD_BITS[i]]) held |= (1 << i);
    v.setUint8(o, held); o += 1;

    v.setInt8(o, c.slot ?? -1); o += 1;
    v.setInt8(o, Math.max(-127, Math.min(127, c.wheel || 0))); o += 1;
    v.setFloat32(o, c.deltaYaw || 0, true); o += 4;
    v.setFloat32(o, c.deltaPitch || 0, true); o += 4;
    // Absolute aim, as a checksum rather than as the source of truth. Deltas alone are
    // lossy under packet loss: one dropped command and the server's aim is permanently
    // offset from the client's with nothing to notice it. The server compares and, past a
    // threshold, snaps and tells the client.
    v.setFloat32(o, c.baseYaw || 0, true); o += 4;
    v.setFloat32(o, c.basePitch || 0, true); o += 4;
  }
  return buf;
}

/** Wire floats are attacker-controlled; a non-finite one poisons everything downstream. */
const finite = (x) => (Number.isFinite(x) ? x : 0);

export function decodeCommands(buf) {
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG_COMMANDS) throw new Error(`not a command batch (type ${v.getUint8(0)})`);
  const n = v.getUint32(2, true);
  // Checked BEFORE the length arithmetic and before a single allocation. The
  // byte-length check below cannot stand in for this: a correctly-sized 100 MiB frame
  // passes it and is exactly the attack.
  if (n > MAX_COMMANDS_PER_BATCH) {
    throw new Error(`command batch declares ${n} commands, limit is ${MAX_COMMANDS_PER_BATCH}`);
  }
  const expect = 6 + n * COMMAND_BYTES;
  if (v.byteLength !== expect) {
    throw new Error(`command batch is ${v.byteLength} bytes, expected ${expect} for ${n} commands`);
  }

  const out = [];
  let o = 6;
  for (let i = 0; i < n; i++) {
    const cmd = {};
    cmd.seq = v.getUint32(o, true); o += 4;
    cmd.tick = v.getUint32(o, true); o += 4;

    const dir = MOVE_DIRS[v.getUint8(o)] || MOVE_DIRS[0]; o += 1;
    cmd.wishForward = dir[0];
    cmd.wishRight = dir[1];

    const edges = v.getUint16(o, true); o += 2;
    for (let b = 0; b < EDGE_BITS.length; b++) cmd[EDGE_BITS[b]] = !!(edges & (1 << b));

    const held = v.getUint8(o); o += 1;
    for (let b = 0; b < HELD_BITS.length; b++) cmd[HELD_BITS[b]] = !!(held & (1 << b));

    cmd.slot = v.getInt8(o); o += 1;
    cmd.wheel = v.getInt8(o); o += 1;
    // Every float from the wire is checked for finiteness. `applyCommand` does
    // `baseYaw += deltaYaw`, so one NaN turns the sender's yaw, then their position, then
    // the snapshot every OTHER client decodes and interpolates, and then their stored
    // lag-comp hitboxes, all into NaN. Zero is a safe substitute: it means "no input".
    cmd.deltaYaw = finite(v.getFloat32(o, true)); o += 4;
    cmd.deltaPitch = finite(v.getFloat32(o, true)); o += 4;
    cmd.baseYaw = finite(v.getFloat32(o, true)); o += 4;
    cmd.basePitch = finite(v.getFloat32(o, true)); o += 4;
    out.push(cmd);
  }
  return out;
}

// ── snapshots ─────────────────────────────────────────────────────────────────────────

/**
 * Per-entity fields on the wire, in bit order.
 *
 * Deliberately much smaller than the snapshot manifest: this is what a client needs to
 * DRAW and to reason about someone else, not what a replay needs to reproduce them. The
 * local player's own state comes from prediction, not from here.
 */
export const ENTITY_FIELDS = [
  ['x', 'f32'], ['y', 'f32'], ['z', 'f32'],
  ['yaw', 'f32'], ['pitch', 'f32'],
  ['vx', 'f32'], ['vy', 'f32'], ['vz', 'f32'],
  ['health', 'u16'], ['armor', 'u16'],
  ['height', 'f32'], ['lean', 'f32'],
  ['flags', 'u8'],              // alive | crouching | sprinting | sliding
  ['team', 'u8'],
  ['weaponIdx', 'u8'],
  ['ammo', 'u16'],
];

/**
 * Combat feedback, as discrete events riding along with the snapshot.
 *
 * Entity state alone cannot express feedback. A hitmarker is not a property of anybody's
 * position — it is a thing that happened once, to one player, at one instant — and the
 * first version of this protocol carried no events at all, which is why a networked shot
 * landed on the server and the shooter saw nothing whatsoever. See `RecordingPresenter`.
 *
 * These are NOT delta-coded and NOT resent. The transport is a WebSocket, so delivery is
 * reliable and ordered; an event put on the wire arrives exactly once, and redundancy
 * would only buy duplicate hitmarkers.
 */
export const EV_KINDS = ['hitmarker', 'kill', 'fire', 'damaged', 'death', 'respawn'];
const EV_CODE = new Map(EV_KINDS.map((k, i) => [k, i]));
const EV_FIRE = EV_CODE.get('fire');

export const F_ALIVE = 1 << 0;
export const F_CROUCH = 1 << 1;
export const F_SPRINT = 1 << 2;
export const F_SLIDE = 1 << 3;
export const F_FIRING = 1 << 4;

const FIELD_SIZE = { f32: 4, u16: 2, u8: 1 };

/**
 * Delta-code a snapshot against a baseline.
 *
 * Per entity a field mask says which values follow, and only changed fields are written.
 * A standing player costs 4 bytes; a sprinting one costs about 30. The baseline is the
 * last snapshot the client ACKNOWLEDGED, not the last one sent — the server cannot assume
 * a packet arrived, and coding against an unacknowledged baseline turns one lost packet
 * into a permanently corrupt view.
 *
 * `baseline` may be null for a keyframe, in which case every field is sent.
 */
export function encodeSnapshot(snap, baseline) {
  const ents = snap.entities;
  // Worst case: every field of every entity, plus masks and ids.
  const perEnt = 4 + 4 + ENTITY_FIELDS.reduce((a, [, t]) => a + FIELD_SIZE[t], 0);
  const events = snap.events || [];
  const buf = new ArrayBuffer(20 + ents.length * perEnt + 2 + events.length * 24);
  const v = new DataView(buf);

  v.setUint8(0, MSG_SNAPSHOT);
  v.setUint8(1, baseline ? 0 : 1);           // 1 = keyframe
  v.setUint32(2, snap.tick >>> 0, true);
  v.setUint32(6, snap.baseTick >>> 0, true);
  v.setUint32(10, snap.lastCommandSeq >>> 0, true);
  v.setUint32(14, ents.length, true);
  let o = 18;

  const base = new Map();
  if (baseline) for (const e of baseline.entities) base.set(e.id, e);

  for (const e of ents) {
    v.setUint32(o, e.id >>> 0, true); o += 4;
    const maskAt = o; o += 4;
    let mask = 0;
    const prev = base.get(e.id);
    for (let i = 0; i < ENTITY_FIELDS.length; i++) {
      const [name, type] = ENTITY_FIELDS[i];
      const val = e[name] ?? 0;
      // `Object.is` so a field that becomes NaN is still transmitted once rather than
      // comparing unequal forever and re-sending every tick.
      if (prev && Object.is(prev[name] ?? 0, val)) continue;
      mask |= (1 << i);
      if (type === 'f32') { v.setFloat32(o, val, true); o += 4; }
      else if (type === 'u16') { v.setUint16(o, Math.max(0, Math.min(65535, val | 0)), true); o += 2; }
      else { v.setUint8(o, val & 0xff); o += 1; }
    }
    v.setUint32(maskAt, mask, true);
  }

  // Events last, so a decoder stops cleanly at the end of the entity block rather than
  // reading event bytes as entity fields.
  //
  // The count is omitted entirely when there is nothing to say. Most snapshots carry no
  // events, and a delta for an entity that did not move is 26 bytes — spending 2 of them
  // every time on a zero would be a 8% tax on the most common packet in the protocol.
  // `decodeSnapshot` treats "no bytes left" and "a count of zero" identically.
  if (events.length === 0) return buf.slice(0, o);
  v.setUint16(o, Math.min(65535, events.length), true); o += 2;
  for (const ev of events) {
    const code = EV_CODE.get(ev.kind);
    if (code === undefined) continue;
    v.setUint8(o, code); o += 1;
    v.setUint8(o, ev.headshot ? 1 : 0); o += 1;
    v.setUint32(o, (ev.entityId ?? ev.killerId ?? 0) >>> 0, true); o += 4;
    v.setUint32(o, (ev.victimId ?? 0) >>> 0, true); o += 4;
    v.setUint16(o, Math.max(0, Math.min(65535, ev.amount ?? 0)), true); o += 2;
    if (code === EV_FIRE) {
      v.setFloat32(o, ev.x ?? 0, true); o += 4;
      v.setFloat32(o, ev.y ?? 0, true); o += 4;
      v.setFloat32(o, ev.z ?? 0, true); o += 4;
    }
  }
  return buf.slice(0, o);
}

export function decodeSnapshot(buf, baseline) {
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG_SNAPSHOT) throw new Error(`not a snapshot (type ${v.getUint8(0)})`);
  const keyframe = v.getUint8(1) === 1;
  const snap = {
    tick: v.getUint32(2, true),
    baseTick: v.getUint32(6, true),
    lastCommandSeq: v.getUint32(10, true),
    keyframe,
    entities: [],
    events: [],
  };
  const n = v.getUint32(14, true);
  let o = 18;

  const base = new Map();
  if (baseline) for (const e of baseline.entities) base.set(e.id, e);

  for (let i = 0; i < n; i++) {
    const id = v.getUint32(o, true); o += 4;
    const mask = v.getUint32(o, true); o += 4;
    const prev = base.get(id);
    // Unchanged fields come from the baseline. Without one — a keyframe, or a client that
    // has lost its baseline — they default to 0, which is why the server must send a
    // keyframe to any client whose acknowledged baseline it no longer holds.
    const e = { id };
    for (let f = 0; f < ENTITY_FIELDS.length; f++) {
      const [name, type] = ENTITY_FIELDS[f];
      if (mask & (1 << f)) {
        if (type === 'f32') { e[name] = v.getFloat32(o, true); o += 4; }
        else if (type === 'u16') { e[name] = v.getUint16(o, true); o += 2; }
        else { e[name] = v.getUint8(o); o += 1; }
      } else {
        e[name] = prev ? (prev[name] ?? 0) : 0;
      }
    }
    snap.entities.push(e);
  }

  // A snapshot from a server that predates the event block simply ends here.
  if (o + 2 <= buf.byteLength) {
    const m = v.getUint16(o, true); o += 2;
    for (let i = 0; i < m && o < buf.byteLength; i++) {
      const code = v.getUint8(o); o += 1;
      const headshot = v.getUint8(o) === 1; o += 1;
      const a = v.getUint32(o, true); o += 4;
      const victimId = v.getUint32(o, true); o += 4;
      const amount = v.getUint16(o, true); o += 2;
      const ev = { kind: EV_KINDS[code] ?? 'unknown', headshot, victimId, amount };
      if (code === EV_FIRE) {
        ev.entityId = a;
        ev.x = v.getFloat32(o, true); o += 4;
        ev.y = v.getFloat32(o, true); o += 4;
        ev.z = v.getFloat32(o, true); o += 4;
      } else {
        ev.killerId = a;
      }
      snap.events.push(ev);
    }
  }
  return snap;
}

/** Capture the wire view of an entity. The shape `encodeSnapshot` expects. */
export function entityToWire(e, weaponIdx = 0) {
  let flags = 0;
  if (e.alive) flags |= F_ALIVE;
  if (e.crouchFrac > 0.5) flags |= F_CROUCH;
  if (e.sprinting) flags |= F_SPRINT;
  if (e.moveState === 'slide') flags |= F_SLIDE;
  if (e.weapon?.triggerDown) flags |= F_FIRING;
  return {
    id: e.id,
    x: e.position.x, y: e.position.y, z: e.position.z,
    yaw: e.yaw, pitch: e.pitch,
    vx: e.velocity.x, vy: e.velocity.y, vz: e.velocity.z,
    health: Math.max(0, Math.round(e.health)),
    armor: Math.max(0, Math.round(e.armor || 0)),
    height: e.height, lean: e.lean,
    flags, team: e.team ?? 0,
    weaponIdx, ammo: e.weapon?.ammo ?? 0,
  };
}
