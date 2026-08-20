/**
 * Career stats.  match-result.md §3, §3.1, §4.1, §6.
 *
 * Three properties this file exists to hold:
 *
 *  1. **Counters only.** No stored K/D, accuracy, or win rate. A stored ratio goes stale and
 *     then disagrees with its own inputs, and only one of the two is right (db-schema.md §3).
 *     `deriveRatios` computes them at read time and nothing writes them.
 *  2. **Stats are never client-writable.** `applyMatchResult` refuses any actor that is not
 *     service-authenticated, and the profile PATCH surface has no stat fields at all. A client
 *     that can post results owns the leaderboard (§5.1).
 *  3. **Recomputable from history.** `recomputeCareer` rebuilds the totals from
 *     `match_participants` alone; §6 makes that the reconciliation check, so it is a real
 *     function here rather than a promise about P5.
 *
 * Store surface used (db-schema.md §3–§4), all optional-`tx` per store.js rule 4:
 *   stats.get / stats.applyDelta / stats.listForAccount
 *   weaponStats.applyDelta / weaponStats.listForAccount
 *   matches.record(result, tx)                       — the immutable result row + participants
 *   matches.listForAccount(accountId, opts, tx)      — history, newest first
 *   idempotency.get(key, actorId, tx) / idempotency.put(row, tx)   — §5.2/§5.4 replay
 */
import { createHash } from 'node:crypto';
import { ApiError } from '../../core/errors.js';

/** Exactly the typed columns of `player_stats` minus the identity key. `score` is absent by
 * design: §3 says per-match score is a pacing device and does not aggregate. */
export const CAREER_KEYS = [
  'kills', 'deaths', 'assists', 'suicides', 'teamKills',
  'headshots', 'shotsFired', 'shotsHit', 'damageDealt',
  'plants', 'defuses',
  'matches', 'wins', 'losses', 'draws',
  'roundsPlayed', 'timePlayedSec',
];

export const WEAPON_KEYS = ['shots', 'hits', 'kills', 'headshots'];

export const STAT_DEFINITION_VERSION = '1.0.0';

/** §2 score table. Per-match only; never summed into a career total. */
const SCORE = { kill: 100, headshot: 50, assist: 25, teamKillPenalty: -100, suicidePenalty: -50 };

export function emptyTotals() {
  const t = {};
  for (const k of CAREER_KEYS) t[k] = 0;
  return t;
}

/**
 * The read-time derivations. Returned to callers that want them (the career screen); never
 * persisted, never part of the §11.5 response — that response is counters only.
 */
export function deriveRatios(totals) {
  const kd = totals.deaths > 0 ? totals.kills / totals.deaths : totals.kills;
  const accuracy = totals.shotsFired > 0 ? totals.shotsHit / totals.shotsFired : 0;
  const winRate = totals.matches > 0 ? totals.wins / totals.matches : 0;
  return { kd, accuracy, winRate };
}

// ---------------------------------------------------------------- event resolution

function blankPlayer(accountId, entry) {
  return {
    accountId,
    team: entry.team,
    kills: 0, deaths: 0, assists: 0, suicides: 0, teamKills: 0,
    headshots: 0, shotsFired: 0, shotsHit: 0, damageDealt: 0,
    plants: 0, defuses: 0,
    roundsPlayed: 0, timePlayedSec: 0,
    score: 0,
    disconnected: false,
    abandoned: !!entry.abandoned,
    joinedAt: entry.joinedAt ?? null,
    leftAt: entry.leftAt ?? null,
    weapons: {},
  };
}

function weaponRow(player, weaponId) {
  if (!weaponId) return null;
  return (player.weapons[weaponId] ||= { shots: 0, hits: 0, kills: 0, headshots: 0 });
}

/**
 * Turn an ordered server event log into the §4.1 per-player rows, applying every §3.1 ruling.
 *
 * The rulings live HERE and not in the caller because §1 is explicit that deciding them at the
 * call site is how two services end up with two different numbers for the same match.
 *
 * Event shapes (server order is the array order; `tick` is the server tick):
 *   { type:'shot',       tick, actor, weaponId, hit }
 *   { type:'damage',     tick, attacker|null, victim, amount, overkill? }
 *   { type:'kill',       tick, attacker|null, victim, weaponId?, headshot?,
 *                        source:'weapon'|'killstreak'|'dot'|'world'|'self', owner? }
 *   { type:'plant'|'defuse', tick, actor, completed }
 *   { type:'roundStart', tick, index, present:[accountId] }
 *   { type:'disconnect', tick, actor }
 *   { type:'respawn',    tick, actor }
 */
export function resolveMatchStats({ roster, events = [], assistWindowTicks = 320 }) {
  const team = new Map();
  const players = new Map();
  for (const entry of roster) {
    team.set(entry.accountId, entry.team);
    players.set(entry.accountId, blankPlayer(entry.accountId, entry));
  }
  const get = (id) => (id && players.has(id) ? players.get(id) : null);

  // Per-victim life state: who damaged them, and whether they are already dead this tick.
  const life = new Map();
  const lifeOf = (id) => {
    if (!life.has(id)) {
      life.set(id, { contributors: new Map(), deadAtTick: null, killerId: null, assisted: new Set() });
    }
    return life.get(id);
  };
  /** A new life: not dead, no killer, no carried-over damage, a fresh assist budget. */
  const resetLife = (id) => {
    const st = lifeOf(id);
    st.deadAtTick = null;
    st.killerId = null;
    st.contributors.clear();
    st.assisted.clear();
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'shot': {
        const p = get(ev.actor);
        if (!p) break;
        p.shotsFired += 1;                       // §3: one per trigger pull that consumed ammo
        const w = weaponRow(p, ev.weaponId);
        if (w) w.shots += 1;
        if (ev.hit) {                            // §3: once per shot, not per pellet
          p.shotsHit += 1;
          if (w) w.hits += 1;
        }
        break;
      }

      case 'damage': {
        const victim = get(ev.victim);
        if (!victim) break;
        const attacker = get(ev.attacker);
        if (!attacker || attacker === victim) break;
        const enemy = team.get(ev.attacker) !== team.get(ev.victim);
        // §3: damage excludes team damage, self damage, and overkill past 0 health.
        if (enemy) attacker.damageDealt += Math.max(0, (ev.amount || 0) - (ev.overkill || 0));
        // Assist eligibility tracks damage regardless of sign of team, but only enemies can
        // ever be awarded one, so record only enemy contributions.
        if (enemy) lifeOf(ev.victim).contributors.set(ev.attacker, ev.tick);
        break;
      }

      case 'kill': {
        const victim = get(ev.victim);
        if (!victim) break;
        const st = lifeOf(ev.victim);

        // §3.1 killstreak hardware: attribution follows the owner, not the machine.
        const attackerId = ev.source === 'killstreak' ? (ev.owner ?? ev.attacker) : ev.attacker;
        const attacker = get(attackerId);

        // §3.1 two killing blows on the same tick: the FIRST APPLIED in server order takes the
        // kill; the second takes an assist. Never two kills, and never a second death.
        if (st.deadAtTick !== null) {
          // The trade assist is subject to the same "one assist per victim per death" cap as a
          // damage assist — the trading player usually damaged the victim too, and awarding
          // both paths would pay them twice for one death.
          if (st.deadAtTick === ev.tick && attacker && attacker !== victim
              && team.get(attackerId) !== team.get(ev.victim)
              && attackerId !== st.killerId && !st.assisted.has(attackerId)) {
            attacker.assists += 1;
            attacker.score += SCORE.assist;
            st.assisted.add(attackerId);
          }
          break;   // a later blow on an un-respawned corpse is not a stat at all
        }
        st.deadAtTick = ev.tick;
        st.killerId = attackerId ?? null;

        victim.deaths += 1;                     // §3: any death, cause irrelevant

        // §3: a suicide is a death with NO ENEMY ATTACKER, or a self-inflicted one. An
        // attacker id we cannot resolve to a roster row — killstreak hardware submitted
        // without its `owner`, an entity purged from the roster — is still an enemy attacker,
        // so it is not a suicide. Booking it as one fabricates a suicide and loses a kill.
        const selfInflicted = !attackerId || attackerId === ev.victim
          || ev.source === 'self' || ev.source === 'world';
        if (selfInflicted) {
          victim.suicides += 1;
          victim.score += SCORE.suicidePenalty;
        } else if (!attacker) {
          // An enemy killed them and nobody on the roster can be credited. The death stands,
          // no suicide is invented, and no kill is awarded to a row that does not exist.
        } else if (team.get(attackerId) === team.get(ev.victim)) {
          // §3.1: a team kill by a player who then leaves is retained. Nothing in the
          // disconnect path removes it, which is the whole point of applying it here.
          attacker.teamKills += 1;
          attacker.score += SCORE.teamKillPenalty;
        } else {
          // §3.1: damage-over-time resolving after the attacker disconnected still credits the
          // attacker — attribution is to the damage source, not to the connection.
          attacker.kills += 1;
          attacker.score += SCORE.kill;
          if (ev.headshot) { attacker.headshots += 1; attacker.score += SCORE.headshot; }
          const w = weaponRow(attacker, ev.weaponId);
          if (w) { w.kills += 1; if (ev.headshot) w.headshots += 1; }
        }

        // §3: one assist maximum per victim per death, to everyone who damaged them inside the
        // window and did not land the killing blow.
        for (const [contributor, at] of st.contributors) {
          if (contributor === attackerId) continue;
          if (ev.tick - at > assistWindowTicks) continue;
          const c = get(contributor);
          if (!c) continue;
          if (st.assisted.has(contributor)) continue;
          c.assists += 1;
          c.score += SCORE.assist;
          st.assisted.add(contributor);
        }
        st.contributors.clear();
        break;
      }

      case 'respawn': {
        resetLife(ev.actor);
        break;
      }

      case 'plant':
      case 'defuse': {
        const p = get(ev.actor);
        // §3.1 round ends mid-plant: no plant, no partial credit. Only `completed` counts.
        if (!p || !ev.completed) break;
        if (ev.type === 'plant') p.plants += 1; else p.defuses += 1;
        break;
      }

      case 'roundStart': {
        // §3: present at round start. A backfilled player joining mid-round gets nothing for
        // that round, and TDM emits no roundStart at all, so `roundsPlayed` stays 0 there.
        for (const id of ev.present || []) {
          const p = get(id);
          if (p) p.roundsPlayed += 1;
        }
        // A round transition, not a respawn, is what restores players in Bomb. Without this
        // reset every player stays flagged dead from their first death for the rest of the
        // match, and from then on their deaths — and their killers' kills — are dropped as
        // "a later blow on an un-respawned corpse". Reset the whole roster: a player absent
        // from `present` emits no events, so resetting them changes nothing.
        for (const id of players.keys()) resetLife(id);
        break;
      }

      case 'disconnect': {
        const p = get(ev.actor);
        // §3.1 disconnects mid-air and dies on landing: the death is counted by the kill event
        // that follows; this flag only records that they left and did not return.
        if (p) { p.disconnected = true; if (p.leftAt === null) p.leftAt = ev.at ?? null; }
        break;
      }

      default: break;
    }
  }

  return [...players.values()];
}

/** §3: seconds connected and in the match, excluding lobby and post-match. */
export function timePlayedSec(entry, { startedAt, endedAt }) {
  const from = Date.parse(entry.joinedAt ?? startedAt);
  const to = Date.parse(entry.leftAt ?? endedAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  return Math.round((to - from) / 1000);
}

// ---------------------------------------------------------------- career aggregation

/** win|loss|draw|null for one player, derived — never stored per player (§4.1). */
export function resultFor(winnerTeam, playerTeam) {
  if (winnerTeam === null || winnerTeam === undefined) return null;
  if (winnerTeam === 'draw') return 'draw';
  return winnerTeam === playerTeam ? 'win' : 'loss';
}

/** §4.2: the three terminal statuses. `pending` is not one of them, and neither is anything
 * a caller invented — the union is closed or it is decoration. */
export const TERMINAL_STATUSES = ['completed', 'aborted', 'invalidated'];

/** The §4.0 matrix, executable. One row per status; every cell is checkable. */
const OUTCOME_REASONS = {
  completed: ['elimination', 'defuse', 'detonation', 'timer'],
  aborted: ['forfeit', 'abandon', 'no-contest'],
  invalidated: ['no-contest'],
};
const INVALIDATION_REASONS = ['cheat-detected', 'server-fault', 'roster-fault', 'admin-review'];

/**
 * Validate one result against the §4.0 status matrix.
 *
 * Fields the caller did not supply are not invented — `recomputeCareer` reads history rows that
 * carry `status` and `winnerTeam` and nothing else — but every field that IS present must agree
 * with the row for its status. That is what makes the union checkable rather than decorative.
 *
 * @returns {Array<object>} field-level problems, empty when the result is well-formed
 */
export function outcomeProblems(result) {
  const { status, winnerTeam = null, outcomeReason, invalidationReason, terminationReason } = result || {};
  const problems = [];
  if (!TERMINAL_STATUSES.includes(status)) {
    return [{ key: 'status', reason: 'enum', allowed: TERMINAL_STATUSES, got: status ?? null }];
  }
  if (terminationReason !== undefined && terminationReason !== null && terminationReason !== status) {
    problems.push({ key: 'terminationReason', reason: 'must-equal-status', expected: status, got: terminationReason });
  }
  if (outcomeReason !== undefined && !OUTCOME_REASONS[status].includes(outcomeReason)) {
    problems.push({ key: 'outcomeReason', reason: 'enum', allowed: OUTCOME_REASONS[status], got: outcomeReason });
  }

  // winnerTeam, per row. `draw` exists only for a completed match; an abort is never a draw.
  if (status === 'completed') {
    if (!['alpha', 'bravo', 'draw'].includes(winnerTeam)) {
      problems.push({ key: 'winnerTeam', reason: 'enum', allowed: ['alpha', 'bravo', 'draw'], got: winnerTeam });
    }
  } else if (status === 'aborted') {
    if (outcomeReason === 'no-contest') {
      if (winnerTeam !== null) problems.push({ key: 'winnerTeam', reason: 'must-be-null', got: winnerTeam });
    } else if (outcomeReason === 'forfeit' || outcomeReason === 'abandon') {
      if (!['alpha', 'bravo'].includes(winnerTeam)) {
        problems.push({ key: 'winnerTeam', reason: 'enum', allowed: ['alpha', 'bravo'], got: winnerTeam });
      }
    } else if (![null, 'alpha', 'bravo'].includes(winnerTeam)) {
      problems.push({ key: 'winnerTeam', reason: 'enum', allowed: ['alpha', 'bravo', null], got: winnerTeam });
    }
  } else if (winnerTeam !== null) {
    problems.push({ key: 'winnerTeam', reason: 'must-be-null', got: winnerTeam });
  }

  // invalidationReason is non-null from the enum for `invalidated`, and null for everything
  // else. A completed match carrying "cheat-detected" is two truths in one row.
  if (status === 'invalidated') {
    if (invalidationReason !== undefined && !INVALIDATION_REASONS.includes(invalidationReason)) {
      problems.push({ key: 'invalidationReason', reason: 'enum', allowed: INVALIDATION_REASONS, got: invalidationReason ?? null });
    }
  } else if (invalidationReason !== undefined && invalidationReason !== null) {
    problems.push({ key: 'invalidationReason', reason: 'must-be-null', got: invalidationReason });
  }
  return problems;
}

/** Throwing form, for the write path. §4.0 violations are malformed submissions, not variants. */
export function assertTerminalResult(result) {
  const problems = outcomeProblems(result);
  if (problems.length) {
    throw new ApiError('VALIDATION_FAILED', 'The match result does not satisfy the §4.0 status matrix.', {
      details: { fields: problems },
    });
  }
}

/**
 * The per-player career delta for one match.
 *
 * `null` means "does not aggregate" — §3.1 and §6: an invalidated match is recorded on the
 * match record and never applied to a career.
 *
 * A status outside the §4.2 union THROWS rather than aggregating. Treating "anything that is
 * not literally invalidated" as aggregatable minted a career match and a win out of `pending`,
 * `allocated`, and `undefined` — and disagreed by construction with `recomputeCareer`, which
 * skips pending, so the §6 reconciliation check could never hold.
 *
 * An **aborted** match is NOT invalidated. If it ended by forfeit or abandon it carries a real
 * winner (§4.2), and that W/L counts: the player who quit still lost, and the opponents who
 * stayed still won.
 */
export function careerDelta(player, result) {
  const { status, winnerTeam } = result || {};
  // Checked before the matrix: an invalidated match never aggregates, whatever else it carries.
  if (status === 'invalidated') return null;
  assertTerminalResult(result);

  const delta = emptyTotals();
  for (const k of CAREER_KEYS) {
    if (k === 'matches' || k === 'wins' || k === 'losses' || k === 'draws') continue;
    delta[k] = Number(player[k] || 0);
  }
  delta.matches = 1;
  const outcome = resultFor(winnerTeam, player.team);
  if (outcome === 'win') delta.wins = 1;
  else if (outcome === 'loss') delta.losses = 1;
  else if (outcome === 'draw') delta.draws = 1;
  // outcome === null (no-contest) counts as a match played with no W/L/D, because the stats are
  // real and the outcome is not.
  return delta;
}

export function addTotals(into, delta) {
  for (const k of CAREER_KEYS) into[k] = (into[k] || 0) + (delta[k] || 0);
  return into;
}

/** §5.2: "Idempotency key derived from matchId, so a retry is inherently the same key." */
export const idempotencyKeyFor = (matchId) => `match-result:${matchId}`;

/**
 * The idempotency row is keyed by (key, actorId) in the store. The actor is pinned to one
 * constant rather than the submitting service instance: the endpoint is service-only, and
 * keying on the instance would make a retry from a *different* worker a different key, which
 * is exactly the retry the deduplication exists for.
 */
const RESULT_ACTOR = 'service:match-result';

/** A result row is immutable forever; the replay window only has to outlive the retry queue. */
const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Key order must not change the hash, or a re-serialised retry looks like a different truth. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export const resultHash = (result) => createHash('sha256').update(stableStringify(result)).digest('hex');

export function createStatsService({ store, clock = Date }) {
  /**
   * Apply one terminal result. SERVICE ONLY (§5.1) — this is the single door career numbers
   * come through, and it is closed to anything holding a player token.
   *
   * §5.3–§5.5: the record, the career application, and the idempotency row are ONE transaction.
   * A replay with the same payload returns the stored response without re-applying; a replay
   * with a different payload for a finalised match is a CONFLICT, because a match finalises
   * once and a second, different truth is a bug or an attack.
   */
  async function applyMatchResult({ actor, result, idempotencyKey = null }) {
    if (!actor || actor.kind !== 'service') {
      throw new ApiError('AUTH_FORBIDDEN', 'Match results are service-submitted only.', {
        details: { reason: 'service-only' },
      });
    }
    if (!result || !result.matchId || !result.status) {
      throw new ApiError('VALIDATION_FAILED', 'A match result needs a matchId and a status.');
    }
    const key = idempotencyKeyFor(result.matchId);
    // §5.2 fixes the key's derivation, so a header that disagrees is a caller bug and not a
    // second, competing key — accepting it would let one match finalise twice under two keys.
    if (idempotencyKey !== null && idempotencyKey !== undefined && idempotencyKey !== key) {
      throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key must be match-result:<matchId>.', {
        details: { fields: [{ key: 'Idempotency-Key', reason: 'derived-key-mismatch', expected: key }] },
      });
    }
    assertTerminalResult(result);
    const sdv = result.statDefinitionVersion || STAT_DEFINITION_VERSION;
    const requestHash = resultHash(result);

    return store.tx(async (tx) => {
      // Read INSIDE the transaction. Checking outside it is a read-then-write race, and the
      // two racers are precisely the duplicate submissions this check exists to collapse.
      const prior = await store.idempotency.get(key, RESULT_ACTOR, tx);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          throw new ApiError('CONFLICT', 'This match was already finalised with a different result.', {
            details: { matchId: result.matchId, reason: 'result-already-finalised' },
          });
        }
        return prior.responseBody;      // §5.4: the stored response, and nothing re-applied
      }

      // Recorded whatever the status — an invalidated match still has an immutable record, it
      // simply never reaches a career total.
      await store.matches.record(result, tx);

      const applied = [];
      for (const player of result.players || []) {
        const delta = careerDelta(player, result);
        if (!delta) continue;
        await store.stats.applyDelta(player.accountId, result.mode, sdv, delta, tx);
        for (const [weaponId, w] of Object.entries(player.weapons || {})) {
          await store.weaponStats.applyDelta(player.accountId, result.mode, weaponId, sdv, {
            shots: w.shots || 0, hits: w.hits || 0,
            kills: w.kills || 0, headshots: w.headshots || 0,
          }, tx);
        }
        applied.push(player.accountId);
      }

      const appliedAt = new Date(clock.now()).toISOString();
      const response = { matchId: result.matchId, status: result.status, applied, appliedAt };
      // Same transaction as the write above: a crash between them would leave a career applied
      // with nothing recording that it was, and the retry would apply it a second time.
      await store.idempotency.put({
        key, actorId: RESULT_ACTOR, requestHash,
        responseStatus: 200, responseBody: response,
        createdAt: appliedAt,
        expiresAt: new Date(clock.now() + IDEMPOTENCY_TTL_MS).toISOString(),
      }, tx);
      return response;
    });
  }

  /** §11.5: counters only. No K/D, no accuracy, no win rate in the response. */
  async function getCareer(accountId, mode = 'all', sdv = STAT_DEFINITION_VERSION) {
    const rows = await store.stats.listForAccount(accountId);
    const totals = emptyTotals();
    for (const row of rows) {
      if (row.statDefinitionVersion !== sdv) continue;
      if (mode !== 'all' && row.mode !== mode) continue;
      addTotals(totals, row);
    }
    const weapons = {};
    // `all` is this endpoint's DEFAULT, and it is not a mode. Passing it down as a mode filter
    // matched no row, so every per-weapon number on the default career view was empty.
    const modeFilter = mode === 'all' ? undefined : mode;
    for (const w of await store.weaponStats.listForAccount(accountId, modeFilter)) {
      if (w.statDefinitionVersion !== sdv) continue;
      if (mode !== 'all' && w.mode !== mode) continue;
      const into = (weapons[w.weaponId] ||= { shots: 0, hits: 0, kills: 0, headshots: 0 });
      for (const k of WEAPON_KEYS) into[k] += w[k] || 0;
    }
    return { accountId, mode, statDefinitionVersion: sdv, totals, weapons };
  }

  /**
   * §6: rebuild the career from match history alone. The reconciliation check — if this
   * disagrees with `getCareer`, an application was partial and the stored total is wrong.
   */
  async function recomputeCareer(accountId, mode = 'all', sdv = STAT_DEFINITION_VERSION) {
    const totals = emptyTotals();
    const weapons = {};
    let cursor = null;
    do {
      const page = await store.matches.listForAccount(accountId, { limit: 200, cursor });
      for (const item of page.items) {
        if (item.status === 'invalidated') continue;      // recorded, never aggregated
        if (item.status === 'pending') continue;          // not terminal, nothing to apply yet
        if ((item.statDefinitionVersion || STAT_DEFINITION_VERSION) !== sdv) continue;
        if (mode !== 'all' && item.mode !== mode) continue;
        const p = item.participant;
        if (!p) continue;
        const delta = careerDelta({ ...p.stats, team: p.team }, item);
        if (!delta) continue;
        addTotals(totals, delta);
        for (const [weaponId, w] of Object.entries(p.stats.weapons || {})) {
          const into = (weapons[weaponId] ||= { shots: 0, hits: 0, kills: 0, headshots: 0 });
          for (const k of WEAPON_KEYS) into[k] += w[k] || 0;
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { accountId, mode, statDefinitionVersion: sdv, totals, weapons };
  }

  /** §4.3 history union: a pending item carries null for every outcome field, never omits. */
  async function history(accountId, { limit = 25, cursor = null } = {}) {
    const page = await store.matches.listForAccount(accountId, { limit, cursor });
    const items = page.items.map((m) => {
      if (m.status === 'pending') {
        return {
          matchId: m.matchId, status: 'pending',
          mode: m.mode, mapId: m.mapId, mapVersion: m.mapVersion,
          endedAt: m.endedAt ?? null,
          result: null, teamScores: null, playerSummary: null,
        };
      }
      const s = m.participant?.stats || {};
      return {
        matchId: m.matchId, status: m.status,
        mode: m.mode, mapId: m.mapId, mapVersion: m.mapVersion,
        endedAt: m.endedAt,
        result: resultFor(m.winnerTeam, m.participant?.team),
        teamScores: m.teamScores ?? null,
        playerSummary: {
          kills: s.kills || 0, deaths: s.deaths || 0,
          assists: s.assists || 0, score: s.score || 0,
        },
      };
    });
    return { items, nextCursor: page.nextCursor ?? null };
  }

  return { applyMatchResult, getCareer, recomputeCareer, history };
}
