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

/**
 * Wire format version.
 *
 * Bumped by ANY change to the shape of the bytes in this file: a new message type, a field
 * appended to `ENTITY_FIELDS`, a kind appended to `EV_KINDS`, a changed command layout.
 * `scripts/lanecheck.mjs` fails a change set that edits this file without touching this
 * constant, because a wire change that ships without a version is a client and a server
 * quietly disagreeing about what a byte means.
 *
 * **Version 2 — negotiated.** `MSG_HELLO` (§8.2) is the client's opening frame and carries the
 * version it was built against; `MSG_WELCOME` (§8.4) carries the server's back. A mismatch is
 * answered with `MSG_REJECT(PROTOCOL_VERSION_MISMATCH)` and a closed socket, in that order,
 * before any state is decoded — which is the whole point. Until v2 the client inferred server
 * capability from `byteLength`, which works only while every change is a pure append, and an
 * older client was never rejected at all: it decoded whatever it was sent and diverged silently.
 *
 * v2 also lands the Bomb wire (`bomb-rules.md` §11, spelled out in `wire-protocol.md` §8): the
 * appended `interact` entity field, eleven appended event kinds, `MSG_MATCHSTATE` with its
 * per-recipient bomb-position filter, and `MSG_OUTCOME`.
 */
export const PROTOCOL_VERSION = 2;

// ── message types ─────────────────────────────────────────────────────────────────────
export const MSG_COMMANDS = 1;
export const MSG_SNAPSHOT = 2;
export const MSG_WELCOME = 3;
/**
 * Client -> server: which two guns this player picked.
 *
 * Nothing carried the loadout, so the server armed every client with the default
 * `ar_vector` no matter what they chose in the armoury. Once the trigger reached the
 * server that became the visible bug: pick the DMR and the client shows one aimed shot
 * while the server empties 34 full-auto rounds — wrong damage, wrong fire rate, wrong
 * falloff, wrong magazine, and a crosshair up to 4.2 degrees off the authoritative gun
 * (110 cm at 15 m).
 *
 * Two bytes of weapon index, sent on join and whenever the pick changes. Not folded into
 * the command, which goes out 120 times a second and would carry it for no reason.
 */
export const MSG_LOADOUT = 4;

export function encodeLoadout(primaryIdx, secondaryIdx) {
  const buf = new ArrayBuffer(3);
  const v = new DataView(buf);
  v.setUint8(0, MSG_LOADOUT);
  v.setUint8(1, primaryIdx & 0xff);
  v.setUint8(2, secondaryIdx & 0xff);
  return buf;
}

export function decodeLoadout(buf) {
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG_LOADOUT) return null;
  return [v.getUint8(1), v.getUint8(2)];
}

// ── protocol v2 message types (wire-protocol.md §8.1) ─────────────────────────────────
/** c→s, the first frame on the socket: the version this client speaks, and its ticket. */
export const MSG_HELLO = 5;
/** s→c, terminal: why the connection was refused, and which version the server speaks. */
export const MSG_REJECT = 6;
/** s→c, on change only: round phase, scores, bomb state, objective progress. 41 bytes. */
export const MSG_MATCHSTATE = 7;
/** s→c, once per round end and once per match end: who won, why, and of which match. */
export const MSG_OUTCOME = 8;

/** `errors.md` codes this layer can produce. Strings, because that is what the wire carries. */
export const REJECT_PROTOCOL_VERSION_MISMATCH = 'PROTOCOL_VERSION_MISMATCH';
export const REJECT_SESSION_TOKEN_INVALID = 'SESSION_TOKEN_INVALID';
export const REJECT_AUTH_SESSION_REPLACED = 'AUTH_SESSION_REPLACED';

const _utf8enc = new TextEncoder();
const _utf8dec = new TextDecoder();

/** Longest byte string either `MSG_HELLO` or `MSG_REJECT` can carry — the length is a u8. */
export const MAX_HELLO_TICKET_BYTES = 255;

/**
 * `MSG_HELLO` — 4 + n bytes (§8.2).
 *
 * | 0 | u8    | MSG_HELLO |
 * | 1 | u16   | protocolVersion |
 * | 3 | u8    | ticket byte length |
 * | 4 | bytes | session ticket, UTF-8 |
 *
 * The version sits BEFORE the ticket on purpose: the server checks it first, because a client
 * that disagrees about the layout cannot be trusted to have encoded the ticket where we read it.
 */
export function encodeHello(protocolVersion = PROTOCOL_VERSION, ticket = '') {
  const bytes = _utf8enc.encode(String(ticket ?? ''));
  if (bytes.length > MAX_HELLO_TICKET_BYTES) {
    throw new Error(`session ticket is ${bytes.length} bytes, limit is ${MAX_HELLO_TICKET_BYTES}`);
  }
  const buf = new ArrayBuffer(4 + bytes.length);
  const v = new DataView(buf);
  v.setUint8(0, MSG_HELLO);
  v.setUint16(1, protocolVersion & 0xffff, true);
  v.setUint8(3, bytes.length);
  new Uint8Array(buf, 4).set(bytes);
  return buf;
}

/**
 * Returns `{ protocolVersion, ticket }`, or `null` if this is not a well-formed hello.
 *
 * `null` rather than a throw, and a LENGTH CHECK rather than a trusting read: the declared
 * ticket length is attacker-controlled, and §8.11 says a known type at the wrong length closes
 * the connection. A short frame that claimed 255 bytes would otherwise read whatever followed.
 */
export function decodeHello(buf) {
  if (buf.byteLength < 4) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG_HELLO) return null;
  const n = v.getUint8(3);
  if (buf.byteLength !== 4 + n) return null;
  return {
    protocolVersion: v.getUint16(1, true),
    ticket: n === 0 ? '' : _utf8dec.decode(new Uint8Array(buf, 4, n)),
  };
}

/**
 * `MSG_REJECT` — 4 + n bytes (§8.3).
 *
 * | 0 | u8    | MSG_REJECT |
 * | 1 | u16   | the SERVER's PROTOCOL_VERSION |
 * | 3 | u8    | reason code length |
 * | 4 | bytes | `errors.md` code, UTF-8 |
 *
 * The server's version rides along so the client can say *which* build to upgrade to instead of
 * failing bare. The socket closes immediately afterwards and the client must never retry.
 */
export function encodeReject(reason, serverVersion = PROTOCOL_VERSION) {
  const bytes = _utf8enc.encode(String(reason ?? '').slice(0, MAX_HELLO_TICKET_BYTES));
  const buf = new ArrayBuffer(4 + bytes.length);
  const v = new DataView(buf);
  v.setUint8(0, MSG_REJECT);
  v.setUint16(1, serverVersion & 0xffff, true);
  v.setUint8(3, bytes.length);
  new Uint8Array(buf, 4).set(bytes);
  return buf;
}

export function decodeReject(buf) {
  if (buf.byteLength < 4) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG_REJECT) return null;
  const n = v.getUint8(3);
  if (buf.byteLength !== 4 + n) return null;
  return {
    serverVersion: v.getUint16(1, true),
    reason: n === 0 ? '' : _utf8dec.decode(new Uint8Array(buf, 4, n)),
  };
}

/** Human-readable upgrade line for a rejected handshake. The client shows this, not a code. */
export function upgradeMessage(serverVersion, clientVersion = PROTOCOL_VERSION) {
  if (serverVersion > clientVersion) {
    return `This build speaks wire protocol v${clientVersion}; the server speaks v${serverVersion}. Reload to update.`;
  }
  if (serverVersion < clientVersion) {
    return `This build speaks wire protocol v${clientVersion}; the server is still on v${serverVersion}. Try another server.`;
  }
  return `Wire protocol v${clientVersion}.`;
}

// ── welcome (s→c) ─────────────────────────────────────────────────────────────────────

/** `mode` on the wire. Index is the value — append only. */
export const WIRE_MODES = ['tdm', 'bomb'];
/** `MSG_WELCOME` flag bits (§8.4). */
export const W_RECONNECT = 1 << 0;
export const W_SPECTATOR = 1 << 1;

export const WELCOME_BYTES_V1 = 15;
export const WELCOME_BYTES_V2 = 21;

/**
 * `MSG_WELCOME` v2 — 21 bytes (§8.4). The v1 fields keep their v1 offsets, exactly.
 *
 * | 0 | u8  | MSG_WELCOME |   | 13 | u16 | killLimit — 0 in Bomb |
 * | 1 | u32 | clientId    |   | 15 | u16 | protocolVersion       |
 * | 5 | u32 | entityId    |   | 17 | u8  | mode (0 tdm, 1 bomb)  |
 * | 9 | u32 | matchSeed   |   | 18 | u8  | flags                 |
 * |   |     |             |   | 19 | u16 | serverTickRateHz      |
 *
 * Still re-sent on match restart — `startMatch` rolls a new seed and shot spread is addressed
 * by it — so this is an assignment, not a one-time handshake.
 */
export function encodeWelcome({
  clientId = 0, entityId = 0, matchSeed = 0, killLimit = 0,
  protocolVersion = PROTOCOL_VERSION, mode = 'tdm', flags = 0, serverTickRateHz = 120,
} = {}) {
  const buf = new ArrayBuffer(WELCOME_BYTES_V2);
  const v = new DataView(buf);
  v.setUint8(0, MSG_WELCOME);
  v.setUint32(1, clientId >>> 0, true);
  v.setUint32(5, entityId >>> 0, true);
  v.setUint32(9, matchSeed >>> 0, true);
  v.setUint16(13, clampU16(killLimit), true);
  v.setUint16(15, protocolVersion & 0xffff, true);
  const modeIdx = typeof mode === 'number' ? mode : WIRE_MODES.indexOf(mode);
  v.setUint8(17, modeIdx >= 0 ? modeIdx : 0);
  v.setUint8(18, flags & 0xff);
  v.setUint16(19, clampU16(serverTickRateHz), true);
  return buf;
}

/**
 * Decode a welcome of EITHER length.
 *
 * A v1 server sends 15 bytes and its fields are still read; `protocolVersion` then comes back
 * `null`, which is a client's signal that it is talking to something that predates negotiation.
 * That is the append-only rule paying for itself: the old layout is a strict prefix of the new.
 */
export function decodeWelcome(buf) {
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG_WELCOME) return null;
  const n = buf.byteLength;
  const out = {
    clientId: v.getUint32(1, true),
    entityId: v.getUint32(5, true),
    matchSeed: n >= 13 ? v.getUint32(9, true) : null,
    killLimit: n >= 15 ? v.getUint16(13, true) : null,
    protocolVersion: null,
    mode: null,
    isReconnect: false,
    isSpectator: false,
    serverTickRateHz: null,
  };
  if (n >= WELCOME_BYTES_V2) {
    out.protocolVersion = v.getUint16(15, true);
    out.mode = WIRE_MODES[v.getUint8(17)] ?? WIRE_MODES[0];
    const flags = v.getUint8(18);
    out.isReconnect = (flags & W_RECONNECT) !== 0;
    out.isSpectator = (flags & W_SPECTATOR) !== 0;
    out.serverTickRateHz = v.getUint16(19, true);
    // §8.4: `killLimit` is 0 in Bomb, and 0 means "not applicable" — `RoomSettings` says
    // `null` and a u16 cannot. `normalizeKillLimit` clamps to 1, so the sentinel is
    // unambiguous. Mapped here so no consumer has to remember the rule.
    if (out.mode === 'bomb' && out.killLimit === 0) out.killLimit = null;
  }
  return out;
}

const clampU16 = (x) => Math.max(0, Math.min(65535, Math.round(Number(x) || 0)));
const clampU8 = (x) => Math.max(0, Math.min(255, Math.round(Number(x) || 0)));
/** Enums out of range clamp to 0 = "none" (§8.11), never to whatever the byte happened to say. */
const clampEnum = (x, table) => ((x | 0) >= 0 && (x | 0) < table.length ? (x | 0) : 0);

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

/** A reason as an index, from either an index or one of the table's names. */
function reasonIndex(reason, table) {
  if (typeof reason === 'string') {
    const i = table.indexOf(reason);
    return i >= 0 ? i : 0;
  }
  const n = reason | 0;
  return n >= 0 && n < table.length ? n : 0;
}

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
  /**
   * Planting / defusing, and how far through it (§8.5). Index 16 — APPENDED, and it had to be.
   *
   * `F_ALIVE`…`F_RELOAD` occupy bits 0–6 of `flags`; one bit was left and Bomb needs two
   * states plus a progress value. So interaction is a field, not a flag: bits 0–1 are the
   * kind (0 none, 1 plant, 2 defuse, 3 reserved) and bits 2–7 are progress 0–63. One byte
   * carries both, `flags` bit 7 stays spare for a future boolean, and delta coding means it
   * costs nothing on the overwhelming majority of ticks where it does not change.
   *
   * Six bits of progress is ~1.6% granularity — far finer than a progress bar can show.
   */
  ['interact', 'u8'],
];

/** `interact` kinds, in wire order. The index IS the value. */
export const INTERACT_KINDS = ['none', 'plant', 'defuse'];
/** Bits 0–1 hold a two-bit kind, so `3` is expressible and reserved. §8.11: treat it as none. */
export const INTERACT_RESERVED = 3;
/** Progress is six bits: 0–63 inclusive. */
export const INTERACT_PROGRESS_MAX = 63;

/**
 * Pack a kind and a 0–63 progress into the `interact` byte.
 *
 * `kind` may be an index or a name. Progress is clamped, not wrapped: a progress of 64 that
 * wrapped to 0 would read as "just started" at the exact moment a plant completes.
 */
export function packInteract(kind = 0, progress = 0) {
  const k = typeof kind === 'string' ? Math.max(0, INTERACT_KINDS.indexOf(kind)) : (kind | 0);
  const safeKind = k === INTERACT_RESERVED || k < 0 || k > INTERACT_RESERVED ? 0 : k;
  const p = Math.max(0, Math.min(INTERACT_PROGRESS_MAX, Math.round(Number(progress) || 0)));
  return (safeKind & 3) | (p << 2);
}

/** The inverse. A reserved kind decodes as `none` and is never rendered (§8.11). */
export function unpackInteract(byte) {
  const b = (byte | 0) & 0xff;
  const raw = b & 3;
  const kind = raw === INTERACT_RESERVED ? 0 : raw;
  const progress = (b >> 2) & INTERACT_PROGRESS_MAX;
  return {
    kind,
    kindName: INTERACT_KINDS[kind],
    reserved: raw === INTERACT_RESERVED,
    progress,
    /** 0..1, for a bar. Server-driven — the client renders it and never advances it. */
    progressFrac: progress / INTERACT_PROGRESS_MAX,
  };
}

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
export const EV_KINDS = [
  'hitmarker', 'kill', 'fire', 'damaged', 'death', 'respawn',
  // Appended, never reordered — the wire code IS the index.
  'explosion', 'blood', 'flash',
  'roundEnd',
  // ── Bomb, protocol v2 (§8.7). Codes 10–20, in exactly this order. ──
  'plantStart', 'plantComplete', 'plantCancel',
  'defuseStart', 'defuseComplete', 'defuseCancel',
  'bombDropped', 'bombPickedUp', 'bombDetonated',
  'roundStart', 'interactRefused',
];
const EV_CODE = new Map(EV_KINDS.map((k, i) => [k, i]));
/**
 * Kinds carrying a vec3: a muzzle, a blast centre, a splash of blood, or the direction a
 * hit came from. Everything spatial, which is also exactly the set the server can cull by
 * distance before sending.
 *
 * `bombDropped` and `bombDetonated` join it in v2: both have a real world position and both
 * are cullable by distance. The other nine Bomb kinds are facts about a round, not places.
 */
const EV_VEC3 = new Set(
  ['fire', 'damaged', 'explosion', 'blood', 'flash', 'bombDropped', 'bombDetonated']
    .map((k) => EV_CODE.get(k)),
);
/** Spatial kinds worth culling: nobody needs a muzzle flash from across the map. */
export const EV_SPATIAL = new Set(['fire', 'explosion', 'blood', 'bombDropped', 'bombDetonated']);

/**
 * `plantCancel` / `defuseCancel` reasons, carried in `amount` (§8.7). Index is the value.
 *
 * A cancellation ends something that HAD started. A refusal below means it never started at
 * all — a different fact, which is why `interactRefused` is a separate kind.
 */
export const CANCEL_REASONS = ['released', 'left-volume', 'died', 'round-ended'];
/** `interactRefused` reasons, carried in `amount` (§8.7). */
export const REFUSAL_REASONS = [
  'not-eligible', 'wrong-phase', 'outside-volume', 'not-carrier', 'already-planted',
];
const EV_CANCEL = new Set([EV_CODE.get('plantCancel'), EV_CODE.get('defuseCancel')]);
const EV_REFUSED = EV_CODE.get('interactRefused');

/** The wire code for a kind name, or `undefined`. Exposed so callers can assert on it. */
export const evCode = (kind) => EV_CODE.get(kind);

/**
 * Non-spatial Bomb kinds whose `entityId` slot is the ACTOR, not a killer.
 *
 * The first `u32` of an event header means "killer" on a kill and "entity" on everything
 * spatial; on these it is the planter, defuser or picker-up. Named rather than left as
 * `killerId`, because a consumer reading `killerId` off a `plantComplete` is reading a field
 * whose name lies about what it holds.
 */
const BOMB_ACTOR_KINDS = new Set(
  ['plantStart', 'plantComplete', 'defuseStart', 'defuseComplete', 'bombPickedUp', 'roundStart']
    .map((k) => EV_CODE.get(k)),
);

export const F_ALIVE = 1 << 0;
export const F_CROUCH = 1 << 1;
export const F_SPRINT = 1 << 2;
export const F_SLIDE = 1 << 3;
export const F_FIRING = 1 << 4;
/**
 * Aiming down sights, and reloading.
 *
 * Free: the flags byte had three spare bits. Remote rigs read `anim.aim` and `anim.reload`
 * to shoulder the weapon and play the reload, and `avatars.js` built that object once and
 * never wrote to it again — so every remote player stood with their gun at rest, firing
 * from the hip, all match, and never visibly reloaded. Two bits fix both.
 */
export const F_ADS = 1 << 5;
export const F_RELOAD = 1 << 6;

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
    // bit 0 is the headshot flag; bits 1-5 carry a weapon index on a gunshot, so a remote
    // rifle, shotgun and sniper do not all play the same sound. Free — the byte was there.
    //
    // On `interactRefused` those same five bits carry the REQUESTED kind instead (§8.7), in
    // the same 0/1/2 encoding as `interact`. The facade needs `{ kind, reason }` and `amount`
    // alone cannot produce both, so the kind rides in the flags byte that already existed.
    const sub = code === EV_REFUSED ? (ev.requestedKind ?? 0) : (ev.weaponIdx ?? 0);
    v.setUint8(o, (ev.headshot ? 1 : 0) | ((sub & 0x1f) << 1) | (ev.absorbed ? 0x40 : 0)); o += 1;
    v.setUint32(o, (ev.entityId ?? ev.killerId ?? 0) >>> 0, true); o += 4;
    v.setUint32(o, (ev.victimId ?? 0) >>> 0, true); o += 4;
    // `amount` doubles as the reason on the three kinds that have one. Names are accepted as
    // well as indices so a caller never has to hard-code `2` for "died".
    let amount = ev.amount ?? 0;
    if (EV_CANCEL.has(code)) amount = reasonIndex(ev.reason ?? ev.amount, CANCEL_REASONS);
    else if (code === EV_REFUSED) amount = reasonIndex(ev.reason ?? ev.amount, REFUSAL_REASONS);
    v.setUint16(o, Math.max(0, Math.min(65535, amount)), true); o += 2;
    if (EV_VEC3.has(code)) {
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
      // `>=`, not `>` (§8.11). Wire codes are zero-based indices into `EV_KINDS`, so the FIRST
      // invalid code is `EV_KINDS.length` — `>` let exactly that value through into
      // `EV_KINDS[code]`, which is `undefined`, at the decoder's untrusted-input boundary.
      //
      // And the whole remaining event block is abandoned rather than skipped past: events are
      // variable-size (spatial kinds carry twelve extra bytes), so an unknown code means the
      // decoder no longer knows where the next one starts. Guessing resynchronises onto
      // garbage; stopping loses events this build could not have rendered anyway.
      if (code >= EV_KINDS.length) { snap.truncatedEvents = true; break; }
      const fl = v.getUint8(o); o += 1;
      const headshot = (fl & 1) === 1;
      const weaponIdx = (fl >> 1) & 0x1f;
      const absorbed = (fl & 0x40) !== 0;
      const a = v.getUint32(o, true); o += 4;
      const victimId = v.getUint32(o, true); o += 4;
      const amount = v.getUint16(o, true); o += 2;
      const ev = { kind: EV_KINDS[code], headshot, weaponIdx, absorbed, victimId, amount };
      if (EV_VEC3.has(code)) {
        ev.entityId = a;
        ev.x = v.getFloat32(o, true); o += 4;
        ev.y = v.getFloat32(o, true); o += 4;
        ev.z = v.getFloat32(o, true); o += 4;
      } else {
        ev.killerId = a;
      }
      // §8.7. The three kinds that carry a reason expose it by name as well as by index, so a
      // consumer never has to remember that 2 means "died" in one table and "outside-volume"
      // in the other. `entityId` is the actor on every Bomb kind.
      if (EV_CANCEL.has(code)) {
        ev.entityId = a;
        ev.reason = amount;
        ev.reasonName = CANCEL_REASONS[amount] ?? 'unknown';
      } else if (code === EV_REFUSED) {
        ev.entityId = a;
        ev.requestedKind = weaponIdx === INTERACT_RESERVED || weaponIdx >= INTERACT_KINDS.length
          ? 0 : weaponIdx;
        ev.requestedKindName = INTERACT_KINDS[ev.requestedKind];
        ev.reason = amount;
        ev.reasonName = REFUSAL_REASONS[amount] ?? 'unknown';
      } else if (BOMB_ACTOR_KINDS.has(code)) {
        ev.entityId = a;
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
  if ((e.weapon?.adsAmount ?? 0) > 0.5) flags |= F_ADS;
  if (e.weapon?.reloadTimer > 0 || e.weapon?.isReloading) flags |= F_RELOAD;
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
    /**
     * The Bomb ruleset writes `entity.objective = { kind, progress }` (progress 0..1) while a
     * plant or defuse is accumulating, and clears it otherwise. Read here rather than derived,
     * because progress accumulates on the SERVER at the fixed step and the client renders it —
     * §8.5 and `net-facade.md` §5.1: a bar that keeps filling through a dropped packet tells
     * the player they are safe when the server has already cancelled the plant.
     */
    interact: packInteract(
      e.objective?.kind ?? 0,
      Math.round((e.objective?.progress ?? 0) * INTERACT_PROGRESS_MAX),
    ),
  };
}

// ── match state (s→c) ─────────────────────────────────────────────────────────────────

/** Round phases, in wire order (§8.6). Index is the value. */
export const PHASES = ['warmup', 'freeze', 'live', 'planted', 'roundEnd', 'matchEnd'];
/** The local player's side this round. `none` covers spectators and unassigned. */
export const ROLES = ['none', 'attacker', 'defender'];
/** Bomb states, in wire order. */
export const BOMB_STATES = ['none', 'carried', 'dropped', 'planted', 'defused', 'detonated'];
/** Site ids, in wire order. `0` is "no site", which is not the same as site A. */
export const BOMB_SITES = [null, 'A', 'B'];

export const MATCHSTATE_BYTES = 41;

/**
 * The two bomb states whose POSITION is a thing that exists (§8.6, step 1).
 *
 * While the bomb is `carried` its location is the carrier's — `bombCarrierId` names them and
 * they are an entity in the snapshot — so `bomb.position` is null and the visibility bit must
 * be false. The rule previously said attackers *always* see `visible = 1`, which during
 * `carried` published a real-looking position at the world origin.
 */
const POSITIONED_BOMB_STATES = new Set(['dropped', 'planted']);

/**
 * `MSG_MATCHSTATE` — 41 bytes (§8.6). Sent on change, not per tick.
 *
 * | off | type | field                    | | off | type | field                  |
 * |----:|------|--------------------------| |----:|------|------------------------|
 * |   0 | u8   | MSG_MATCHSTATE           | |  17 | u8   | bombSite               |
 * |   1 | u8   | phase                    | |  18 | u32  | interactActorId        |
 * |   2 | u8   | roundIndex               | |  22 | u8   | interactProgress 0–63  |
 * |   3 | u8   | localRole                | |  23 | u8   | sideSwitched           |
 * |   4 | u16  | scoreAlpha               | |  24 | u32  | serverTimeMs (low 32)  |
 * |   6 | u16  | scoreBravo               | |  28 | u8   | bombPositionVisible    |
 * |   8 | u16  | phaseRemaining, decisec  | |  29 | f32  | bombX                  |
 * |  10 | u8   | aliveAlpha               | |  33 | f32  | bombY                  |
 * |  11 | u8   | aliveBravo               | |  37 | f32  | bombZ                  |
 * |  12 | u8   | bombState                |
 * |  13 | u32  | bombCarrierId (0 = none) |
 *
 * Not folded into the snapshot: match state changes a few times a round while snapshots go out
 * every `SNAPSHOT_INTERVAL` ticks, so folding it in would resend unchanged bytes thousands of
 * times a match.
 *
 * **`bombPositionVisible` is the presence signal, not the coordinates.** `(0, 0, 0)` is a
 * perfectly valid world position — `map-data.md`'s canonical site example is centred on the
 * origin — so zeroes cannot mean "hidden". `bombState` cannot stand in either: every recipient
 * still learns `dropped`/`planted`, and only the coordinates are filtered. The flag means
 * "the position is meaningful AND you are authorised for it", both conditions.
 *
 * The caller passes `bombPosition: null` for either failure, and this writes zeroes into the
 * three float slots. That is safe precisely because the flag is what a decoder reads first —
 * `decodeMatchState` never touches those twelve bytes when the flag is 0.
 */
export function encodeMatchState(s = {}) {
  const buf = new ArrayBuffer(MATCHSTATE_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG_MATCHSTATE);
  v.setUint8(1, enumIndex(s.phase, PHASES));
  v.setUint8(2, clampU8(s.roundIndex));
  v.setUint8(3, enumIndex(s.localRole, ROLES));
  v.setUint16(4, clampU16(s.scoreAlpha), true);
  v.setUint16(6, clampU16(s.scoreBravo), true);
  // Deciseconds: a u16 of milliseconds would wrap at 65.5 s, which is shorter than a Bomb
  // round. At 100 ms granularity it covers 6553.5 s and no HUD can show finer.
  v.setUint16(8, clampU16(Math.round((Number(s.phaseRemainingMs) || 0) / 100)), true);
  v.setUint8(10, clampU8(s.aliveAlpha));
  v.setUint8(11, clampU8(s.aliveBravo));
  const bombState = enumIndex(s.bombState, BOMB_STATES);
  v.setUint8(12, bombState);
  v.setUint32(13, (s.bombCarrierId ?? 0) >>> 0, true);
  v.setUint8(17, siteIndex(s.bombSite));
  v.setUint32(18, (s.interactActorId ?? 0) >>> 0, true);
  v.setUint8(22, Math.max(0, Math.min(INTERACT_PROGRESS_MAX, Math.round(Number(s.interactProgress) || 0))));
  v.setUint8(23, s.sideSwitched ? 1 : 0);
  v.setUint32(24, (Number(s.serverTimeMs) || 0) >>> 0, true);

  const p = s.bombPosition;
  // Step 1 then step 2, in that order. A position that does not exist is hidden from
  // everyone, including the attackers who are always authorised for one that does.
  const meaningful = POSITIONED_BOMB_STATES.has(BOMB_STATES[bombState]);
  const visible = meaningful && !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
  v.setUint8(28, visible ? 1 : 0);
  v.setFloat32(29, visible ? p.x : 0, true);
  v.setFloat32(33, visible ? p.y : 0, true);
  v.setFloat32(37, visible ? p.z : 0, true);
  return buf;
}

export function decodeMatchState(buf) {
  if (buf.byteLength !== MATCHSTATE_BYTES) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG_MATCHSTATE) return null;

  const phase = clampEnum(v.getUint8(1), PHASES);
  const localRole = clampEnum(v.getUint8(3), ROLES);
  const bombState = clampEnum(v.getUint8(12), BOMB_STATES);
  const site = clampEnum(v.getUint8(17), BOMB_SITES);
  const carrierId = v.getUint32(13, true);
  const actorId = v.getUint32(18, true);
  const progress = v.getUint8(22) & INTERACT_PROGRESS_MAX;
  const visible = v.getUint8(28) === 1;

  return {
    type: 'matchState',
    phase: PHASES[phase],
    phaseIndex: phase,
    roundIndex: v.getUint8(2),
    localRole: ROLES[localRole],
    scoreAlpha: v.getUint16(4, true),
    scoreBravo: v.getUint16(6, true),
    phaseRemainingMs: v.getUint16(8, true) * 100,
    aliveAlpha: v.getUint8(10),
    aliveBravo: v.getUint8(11),
    bombState: BOMB_STATES[bombState],
    // `0` is never a valid entity id, so absent and zero are the same fact and a decoder
    // never has to tell them apart. `null` means "not visible to you" (§5.1.1 of the
    // facade contract), which the UI renders as absence and must never fill in from memory.
    bombCarrierId: carrierId === 0 ? null : carrierId,
    bombSite: BOMB_SITES[site],
    interactActorId: actorId === 0 ? null : actorId,
    interactProgress: progress,
    interactProgressFrac: progress / INTERACT_PROGRESS_MAX,
    sideSwitched: v.getUint8(23) === 1,
    serverTimeMs: v.getUint32(24, true),
    bombPositionVisible: visible,
    // The twelve coordinate bytes are read ONLY when the flag is set. The key is always
    // present and is `null` when it is not, so no consumer can mistake a hidden bomb for one
    // sitting at the origin, and none has to test for a missing key.
    bombPosition: visible
      ? { x: v.getFloat32(29, true), y: v.getFloat32(33, true), z: v.getFloat32(37, true) }
      : null,
  };
}

// ── outcome (s→c) ─────────────────────────────────────────────────────────────────────

/** `scope` (§8.9). */
export const OUTCOME_SCOPES = [null, 'round', 'match'];
/** `winner`. **`0` is "no winner", not "draw" — draw is `3`.** They are different facts. */
export const OUTCOME_WINNERS = ['none', 'alpha', 'bravo', 'draw'];
/** `reason`, spelled `outcomeReason` everywhere else. One name, one enum. */
export const OUTCOME_REASONS = [
  'elimination', 'defuse', 'detonation', 'timer', 'forfeit', 'abandon', 'no-contest',
];
/** `terminationReason`, match scope only. */
export const TERMINATION_REASONS = ['completed', 'aborted', 'invalidated'];
/** `roundIndex` sentinel for match-scope outcomes, which are not about one round. */
export const ROUND_INDEX_NA = 255;

export const OUTCOME_BYTES = 32;

/**
 * `MSG_OUTCOME` — 32 bytes (§8.9).
 *
 * | 0 | u8 | MSG_OUTCOME | | 5 | u8  | terminationReason |
 * | 1 | u8 | scope       | | 6 | u16 | scoreAlpha        |
 * | 2 | u8 | roundIndex  | | 8 | u16 | scoreBravo        |
 * | 3 | u8 | winner      | |10 | u16 | roundsPlayed      |
 * | 4 | u8 | reason      | |12 | u32 | actorId           |
 * |   |    |             | |16 | b16 | matchId, the ULID's raw bytes |
 *
 * `net-facade.md` promised `roundEnded`/`matchEnded` payloads carrying identifiers and reasons
 * that existed nowhere on the wire — `MSG_MATCHSTATE` has no matchId, no winner and no reason,
 * so the facade was documenting data the client could not have. Phase cannot substitute: it
 * says a round ended, not who won or why.
 *
 * `matchId` travels as 16 raw bytes rather than its 26-character text form: a ULID is a 128-bit
 * value, and sending it as text would cost 10 extra bytes on every one of these.
 */
export function encodeOutcome(o = {}) {
  const buf = new ArrayBuffer(OUTCOME_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG_OUTCOME);
  v.setUint8(1, enumIndex(o.scope, OUTCOME_SCOPES));
  v.setUint8(2, o.roundIndex == null ? ROUND_INDEX_NA : clampU8(o.roundIndex));
  v.setUint8(3, enumIndex(o.winner, OUTCOME_WINNERS));
  v.setUint8(4, enumIndex(o.reason ?? o.outcomeReason, OUTCOME_REASONS));
  v.setUint8(5, enumIndex(o.terminationReason, TERMINATION_REASONS));
  v.setUint16(6, clampU16(o.scoreAlpha), true);
  v.setUint16(8, clampU16(o.scoreBravo), true);
  v.setUint16(10, clampU16(o.roundsPlayed), true);
  v.setUint32(12, (o.actorId ?? 0) >>> 0, true);
  new Uint8Array(buf, 16, 16).set(matchIdBytes(o.matchId));
  return buf;
}

export function decodeOutcome(buf) {
  if (buf.byteLength !== OUTCOME_BYTES) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== MSG_OUTCOME) return null;
  const scope = clampEnum(v.getUint8(1), OUTCOME_SCOPES);
  const roundIdx = v.getUint8(2);
  const winner = clampEnum(v.getUint8(3), OUTCOME_WINNERS);
  const actorId = v.getUint32(12, true);
  const raw = new Uint8Array(buf.slice(16, 32));
  return {
    type: 'outcome',
    scope: OUTCOME_SCOPES[scope],
    roundIndex: roundIdx === ROUND_INDEX_NA ? null : roundIdx,
    winner: OUTCOME_WINNERS[winner],
    // `match-result.md` §4.0 spells `winner: 0` as `winnerTeam: null` and `winner: 3` as
    // `"draw"`. Collapsing the two would make every invalidated match look like a tie.
    winnerTeam: winner === 0 ? null : OUTCOME_WINNERS[winner],
    reason: OUTCOME_REASONS[clampEnum(v.getUint8(4), OUTCOME_REASONS)],
    terminationReason: TERMINATION_REASONS[clampEnum(v.getUint8(5), TERMINATION_REASONS)],
    scoreAlpha: v.getUint16(6, true),
    scoreBravo: v.getUint16(8, true),
    roundsPlayed: v.getUint16(10, true),
    actorId: actorId === 0 ? null : actorId,
    matchIdBytes: raw,
    matchId: ulidFromBytes(raw),
  };
}

// ── shared encode helpers ─────────────────────────────────────────────────────────────

/** An enum value from either a name or an index. Anything unrecognised is 0 ("none"). */
function enumIndex(value, table) {
  if (typeof value === 'string') {
    const i = table.indexOf(value);
    return i >= 0 ? i : 0;
  }
  const n = value | 0;
  return n >= 0 && n < table.length ? n : 0;
}

/** Site ids are `null | 'A' | 'B'`, so `indexOf(null)` genuinely means index 0. */
function siteIndex(site) {
  if (site == null) return 0;
  if (typeof site === 'number') return site >= 0 && site < BOMB_SITES.length ? site : 0;
  // `map-data.md` writes sites as `site-A`; the wire carries just the letter.
  const letter = String(site).replace(/^site-/, '').toUpperCase();
  const i = BOMB_SITES.indexOf(letter);
  return i > 0 ? i : 0;
}

/** Crockford base32, as ULIDs use. */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID's 16 raw bytes, from raw bytes or from its 26-character text form. */
export function matchIdBytes(matchId) {
  const out = new Uint8Array(16);
  if (!matchId) return out;
  if (matchId instanceof Uint8Array) { out.set(matchId.subarray(0, 16)); return out; }
  if (matchId instanceof ArrayBuffer) { out.set(new Uint8Array(matchId).subarray(0, 16)); return out; }
  const text = String(matchId).toUpperCase();
  if (text.length !== 26) return out;
  // 26 characters x 5 bits = 130 bits; the leading character contributes only its low 3.
  let bit = -2;
  for (let i = 0; i < 26; i++) {
    const val = ULID_ALPHABET.indexOf(text[i]);
    if (val < 0) return new Uint8Array(16);
    for (let b = 4; b >= 0; b--) {
      if (bit >= 0) {
        if ((val >> b) & 1) out[bit >> 3] |= 0x80 >> (bit & 7);
      }
      bit++;
    }
  }
  return out;
}

/** The inverse: 16 bytes back to the canonical 26-character text form. */
export function ulidFromBytes(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  let acc = 0;
  let bits = 2;                      // two synthetic leading zero bits, so 128 -> 130
  for (let i = 0; i < 16; i++) {
    acc = (acc << 8) | b[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ULID_ALPHABET[(acc >> bits) & 31];
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}
