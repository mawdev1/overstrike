import { createHmac, timingSafeEqual } from 'node:crypto';
import { liveWeaponId } from '../platform/src/shared/liveCatalog.js';

/** Release allocation seats which never converted their original handoff before its TTL. */
export function expireUnjoinedSeats(roster, at = Date.now()) {
  if (!(roster instanceof Map) || !Number.isFinite(Number(at))) return 0;
  let released = 0;
  for (const seat of roster.values()) {
    if (seat.joined || seat.released || !Number.isFinite(Number(seat.connectBy))
      || Number(seat.connectBy) > Number(at)) continue;
    seat.released = true;
    seat.connected = false;
    released++;
  }
  return released;
}

/** Verify and atomically consume the compact P2 match ticket minted by the platform. */
export function createMatchTicketVerifier({ secret, clock = Date.now, matchId = null, roomId = null,
  consume = null } = {}) {
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('match ticket secret is required');
  const consumed = new Set();
  let boundMatchId = matchId;
  let boundRoomId = roomId;
  const pinnedMatchId = matchId;
  const pinnedRoomId = roomId;
  function verify(raw) {
    if (typeof raw !== 'string' || raw.length > 2048) return null;
    const parts = raw.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const expected = createHmac('sha256', secret).update(parts[0]).digest();
    let supplied;
    try { supplied = Buffer.from(parts[1], 'base64url'); } catch { return null; }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
    const fields = parts[0].split('~');
    if (fields.length !== 10 || fields[0] !== '1') return null;
    const claims = {
      v: 1, jti: fields[1], sub: fields[2], roomId: fields[3], matchId: fields[4],
      exp: Number.parseInt(fields[5], 36), mode: fields[6] === 'b' ? 'bomb' : fields[6] === 't' ? 'tdm' : null,
      team: fields[7] === 'a' ? 'alpha' : fields[7] === 'b' ? 'bravo' : fields[7] === 'u' ? 'unassigned' : null,
      primaryIdx: Number.parseInt(fields[8], 36), secondaryIdx: Number.parseInt(fields[9], 36),
    };
    if (typeof claims.jti !== 'string' || typeof claims.sub !== 'string'
      || typeof claims.roomId !== 'string' || typeof claims.matchId !== 'string' || !claims.mode || !claims.team
      || !Number.isInteger(claims.primaryIdx) || claims.primaryIdx < 0 || claims.primaryIdx > 255
      || !Number.isInteger(claims.secondaryIdx) || claims.secondaryIdx < 0 || claims.secondaryIdx > 255
      || !liveWeaponId('primary', claims.primaryIdx) || !liveWeaponId('secondary', claims.secondaryIdx)
      || !Number.isFinite(claims.exp) || Number(clock()) >= claims.exp
      || (boundMatchId && claims.matchId !== boundMatchId)
      || (boundRoomId && claims.roomId !== boundRoomId)
      || consumed.has(claims.jti)) return null;
    // A generic Alpha process becomes one match authority at the first valid ticket. Only an
    // authenticated release may clear that binding for a later allocation.
    const accept = () => {
      // Re-check after a remote consume resolves: concurrent HELLOs in one process must not
      // both pass even if a faulty remote adapter answers both calls.
      if (consumed.has(claims.jti)) return null;
      boundMatchId ||= claims.matchId;
      boundRoomId ||= claims.roomId;
      consumed.add(claims.jti);
      return Object.freeze(claims);
    };
    if (typeof consume === 'function') return Promise.resolve(consume(claims)).then((ok) => ok ? accept() : null, () => null);
    return accept();
  }
  verify.bindAllocation = ({ matchId: nextMatchId, roomId: nextRoomId } = {}) => {
    if (!nextMatchId || !nextRoomId
      || (pinnedMatchId && nextMatchId !== pinnedMatchId)
      || (pinnedRoomId && nextRoomId !== pinnedRoomId)
      || (boundMatchId && boundMatchId !== nextMatchId)
      || (boundRoomId && boundRoomId !== nextRoomId)) return false;
    boundMatchId = nextMatchId;
    boundRoomId = nextRoomId;
    return true;
  };
  verify.releaseAllocation = (releasedMatchId) => {
    if (!releasedMatchId || boundMatchId !== releasedMatchId) return false;
    if (!pinnedMatchId) boundMatchId = null;
    if (!pinnedRoomId) boundRoomId = null;
    consumed.clear();
    return true;
  };
  return verify;
}
