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
 */
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

        const selfInflicted = !attacker || attackerId === ev.victim
          || ev.source === 'self' || ev.source === 'world';
        if (selfInflicted) {
          // §3: a death with no enemy attacker is a suicide, and still a death.
          victim.suicides += 1;
          victim.score += SCORE.suicidePenalty;
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
        const st = lifeOf(ev.actor);
        st.deadAtTick = null;
        st.killerId = null;
        st.contributors.clear();
        st.assisted.clear();     // a new life is a new assist budget
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

/**
 * The per-player career delta for one match.
 *
 * `null` means "does not aggregate" — §3.1 and §6: an invalidated match is recorded on the
 * match record and never applied to a career.
 *
 * An **aborted** match is NOT invalidated. If it ended by forfeit or abandon it carries a real
 * winner (§4.2), and that W/L counts: the player who quit still lost, and the opponents who
 * stayed still won.
 */
export function careerDelta(player, { status, winnerTeam }) {
  if (status === 'invalidated') return null;

  const delta = emptyTotals();
  for (const k of CAREER_KEYS) {
    if (k === 'matches' || k === 'wins' || k === 'losses' || k === 'draws') continue;
    delta[k] = Number(player[k] || 0);
  }
  delta.matches = 1;
  const result = resultFor(winnerTeam, player.team);
  if (result === 'win') delta.wins = 1;
  else if (result === 'loss') delta.losses = 1;
  else if (result === 'draw') delta.draws = 1;
  // result === null (no-contest) counts as a match played with no W/L/D, because the stats are
  // real and the outcome is not.
  return delta;
}

export function addTotals(into, delta) {
  for (const k of CAREER_KEYS) into[k] = (into[k] || 0) + (delta[k] || 0);
  return into;
}

export function createStatsService({ store, clock = Date }) {
  /**
   * Apply one terminal result. SERVICE ONLY (§5.1) — this is the single door career numbers
   * come through, and it is closed to anything holding a player token.
   */
  async function applyMatchResult({ actor, result }) {
    if (!actor || actor.kind !== 'service') {
      throw new ApiError('AUTH_FORBIDDEN', 'Match results are service-submitted only.', {
        details: { reason: 'service-only' },
      });
    }
    if (!result || !result.matchId || !result.status) {
      throw new ApiError('VALIDATION_FAILED', 'A match result needs a matchId and a status.');
    }
    const sdv = result.statDefinitionVersion || STAT_DEFINITION_VERSION;

    return store.tx(async (tx) => {
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
      return { matchId: result.matchId, status: result.status, applied, appliedAt: new Date(clock.now()).toISOString() };
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
    for (const w of await store.weaponStats.listForAccount(accountId, mode)) {
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
