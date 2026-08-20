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
 *   matches.record(result, tx)                       — allocate the row, or finalise it (§4)
 *   matches.markResultApplied(matchId, at, tx)       — stamp result_applied_at in the same tx
 *   matches.byId(matchId, tx)                        — the §4.2 detail projection's source
 *   matches.listForAccount(accountId, opts, tx)      — history, newest first
 *   idempotency.get(key, actorId, tx) / idempotency.put(row, tx)   — §5.2/§5.4 replay
 */
import { createHash } from 'node:crypto';
import { ApiError } from '../../core/errors.js';
import {
  TERMINAL_MATCH_STATUSES, OUTCOME_REASONS, INVALIDATION_REASONS,
  matchOutcomeProblems, submittableResultProblems, assertPageArgs,
  PAGE_LIMIT_MAX, toHistoryMatchStatus,
} from '../../core/store.js';

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
    // §4.1 requires both on a submitted player row, and they are properties of the ROSTER, not
    // of the event log. Carried through so a resolver output is a submittable row rather than
    // one the endpoint refuses for two fields the resolver never had the chance to supply.
    displayName: entry.displayName ?? null,
    team: entry.team,
    role: entry.role ?? null,
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

/**
 * §4.2: the three terminal statuses, and the §4.0 matrix that constrains them.
 *
 * Both come from `core/store.js` rather than being restated here. They were restated here, and a
 * second copy of a matrix is how a result the store accepts becomes a result the career refuses
 * — with the two disagreeing silently, because nothing compares them.
 */
export const TERMINAL_STATUSES = TERMINAL_MATCH_STATUSES;
export { OUTCOME_REASONS, INVALIDATION_REASONS };

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
  return matchOutcomeProblems(result);
}

/** Throwing form, for the aggregation path. §4.0 violations are malformed, not variants. */
export function assertTerminalResult(result) {
  const problems = outcomeProblems(result);
  if (problems.length) {
    throw new ApiError('VALIDATION_FAILED', 'The match result does not satisfy the §4.0 status matrix.', {
      details: { fields: problems },
    });
  }
}

/**
 * The stricter form for the SUBMISSION path: the complete §4.2 required field set, the matrix,
 * and every nested §4.1 shape. A submission is a whole record; the aggregation path sees history
 * rows that carry a subset by design, which is why these are two functions and not one.
 *
 * The nested half is what was missing. Top-level validation was exact while `players[]`,
 * `rounds[]`, `roster[]`, `weapons{}`, `teamScores` and `rulesSnapshot` accepted unknown keys,
 * wrong types and missing fields — so a match server could submit `{ kills: "10" }`, a
 * `rulesSnapshot` of `{ scoreLimit: 75 }` and a round with no roles, and the platform stored all
 * three as a finished match. The error names the offending PATH (`players[2].weapons.ar_vector
 * .kills`), because "VALIDATION_FAILED" against a payload with sixty nested numbers in it is not
 * a diagnosis.
 */
export function assertSubmittableResult(result) {
  const problems = submittableResultProblems(result);
  if (problems.length) {
    throw new ApiError('VALIDATION_FAILED', 'The match result is not a valid §4.2 TerminalResult.', {
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
  const outcome = resultFor(winnerTeam, player.team);
  // §4.0's matrix reads "Not counted" for no-contest, and bomb-rules §9 says such a match is
  // "recorded but not aggregated". An earlier comment here argued a no-contest was still a
  // match played — that is a defensible design and it is not the one the contract states, and
  // the contract is what the other lane builds against.
  if (outcome === null) return null;

  delta.matches = 1;
  if (outcome === 'win') delta.wins = 1;
  else if (outcome === 'loss') delta.losses = 1;
  else if (outcome === 'draw') delta.draws = 1;
  return delta;
}

export function addTotals(into, delta) {
  for (const k of CAREER_KEYS) into[k] = (into[k] || 0) + (delta[k] || 0);
  return into;
}

/**
 * §4.0/§5.3: each terminal status has its own catalogued event. The catalogue distinguishes
 * them (event-envelope.md §6) and so must the writer — "always match.completed" would tell every
 * consumer that a forfeit and a cheat invalidation were the same thing.
 */
const TERMINAL_EVENT_TYPES = Object.assign(Object.create(null), {
  completed: 'match.completed',
  aborted: 'match.aborted',
  invalidated: 'match.invalidated',
});

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

/** §4.2's pending variant: how long a client waits before asking for the result again. */
const PENDING_RETRY_AFTER_MS = 2000;

/** realtime-lobby.md §2/§7: the reconnect grace window, 90 s from the drop. */
const RECONNECT_GRACE_MS = 90_000;

/** Key order must not change the hash, or a re-serialised retry looks like a different truth. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export const resultHash = (result) => createHash('sha256').update(stableStringify(result)).digest('hex');

/**
 * @param outbox  REQUIRED. §5.3 makes the result write, the career application and the event one
 *   transaction, and the event is the only durable trace that a career moved. Optional, it was a
 *   deployment mode: a process wired without one applied careers silently, and the absence was
 *   invisible until someone asked why the audit trail had a hole in it. A missing outbox is a
 *   wiring error, and wiring errors belong at construction where they stop the process, not at
 *   the first result of the night.
 * @param visibilityFor  `(subjectId, viewerId) -> { stats, presence, isSelf }` from the profile
 *   service. Absent, `getMatch` refuses every non-participant — fail closed, because the
 *   alternative is a privacy rule that is enforced only when a dependency happens to be wired.
 */
export function createStatsService({ store, clock = Date, outbox, visibilityFor = null }) {
  if (!outbox || typeof outbox.emitIn !== 'function') {
    throw new Error('createStatsService requires an outbox: a career applied with no event is '
      + 'the state the outbox pattern exists to make impossible (match-result.md §5.3)');
  }
  /**
   * Apply one terminal result. SERVICE ONLY (§5.1) — this is the single door career numbers
   * come through, and it is closed to anything holding a player token.
   *
   * §5.3–§5.5: the record, the career application, and the idempotency row are ONE transaction.
   * A replay with the same payload returns the stored response without re-applying; a replay
   * with a different payload for a finalised match is a CONFLICT, because a match finalises
   * once and a second, different truth is a bug or an attack.
   *
   * INVALIDATION IS A SUBMISSION-TIME DECISION ONLY. `status: 'invalidated'` is accepted here as
   * a match's first and only terminal result — the anti-cheat or roster fault was known before
   * the result was written. Re-submitting a FINALISED match as invalidated is refused by §5.5
   * like any other second truth, and there is no other door: no admin command invalidates a
   * completed match, because doing it honestly needs an append-only command plus a compensating
   * career delta to reverse what was already applied, and neither exists in this phase (see
   * MATCH_STATUS_TRANSITIONS in core/store.js). Refusing is the failure mode that loses nothing;
   * a silent forward-only edit would leave a career that no longer reconciles with its history.
   */
  async function applyMatchResult({ actor, result, idempotencyKey = null, correlationId = null }) {
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
    // The COMPLETE §4.2 check, not just the matrix: a submission missing `rulesSnapshot`,
    // `endedAt` or `players` used to be stored as a finished match, and the row it left behind
    // is one the detail endpoint cannot render and the recompute cannot interpret.
    assertSubmittableResult(result);
    const sdv = result.statDefinitionVersion || STAT_DEFINITION_VERSION;
    const requestHash = resultHash(result);

    return store.tx(async (tx) => {
      // Read INSIDE the transaction. Checking outside it is a read-then-write race, and the
      // two racers are precisely the duplicate submissions this check exists to collapse.
      // Serialise on the key BEFORE reading it. Without this every concurrent submission
      // reads `prior = null` and proceeds, and §5.4's "return the stored response" becomes a
      // primary-key collision reported as §5.5's different-payload CONFLICT.
      if (store.idempotency.acquire) await store.idempotency.acquire(key, RESULT_ACTOR, tx);
      const prior = await store.idempotency.get(key, RESULT_ACTOR, tx);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          throw new ApiError('CONFLICT', 'This match was already finalised with a different result.', {
            details: { matchId: result.matchId, reason: 'result-already-finalised' },
          });
        }
        // §5.4 returns the STORED response, and §5's `applied` answers "did THIS call apply".
        // Returning the stored `true` told a retrying match server it had just applied a
        // result it had not, which is the one thing idempotency exists to stop it believing.
        return { ...prior.responseBody, applied: false };
      }

      // Recorded whatever the status — an invalidated match still has an immutable record, it
      // simply never reaches a career total.
      await store.matches.record(result, tx);

      const appliedTo = [];
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
        appliedTo.push(player.accountId);
      }

      const resultAppliedAt = new Date(clock.now()).toISOString();
      // db-schema.md §4 declares `result_applied_at` and nothing wrote it, so a match that had
      // ended and a match whose career application committed were the same row — the exact
      // distinction §4.2's pending-vs-terminal projection and §5's replay both rest on. Stamped
      // in THIS transaction: a stamp that can commit without the application it records is a
      // claim the recompute cannot check.
      await store.matches.markResultApplied(result.matchId, resultAppliedAt, tx);

      // §5: the contract's response is `{ applied: bool }` — did this call apply, or was it a
      // replay. An array of account ids answered a different question and broke every typed
      // client, and it also leaked the roster to a caller that had not asked for it.
      const response = {
        matchId: result.matchId,
        status: result.status,
        applied: true,
        resultAppliedAt,
        appliedToCount: appliedTo.length,
      };

      // event-envelope.md §6 catalogues `match.result_applied` and nothing emitted it, so the
      // one transition that changes a career left no durable trace. Emitted in THIS
      // transaction: a career applied with no event explaining it is the exact state the
      // outbox pattern exists to make impossible.
      const ctx = {
        correlationId: correlationId || result.matchId,
        actor: { kind: 'service', id: RESULT_ACTOR, role: 'service' },
      };
      // §5.3 and §4.0: the terminal event follows the STATUS — `match.completed`,
      // `match.aborted` or `match.invalidated`. Only `match.result_applied` was emitted, so
      // three catalogued public/audit events (event-envelope.md §6) were produced by nothing
      // at all, and every consumer of "a match finished" saw an empty stream. It goes first
      // because the match ending is what causes the career application, not the reverse.
      await outbox.emitIn(tx, ctx, {
        type: TERMINAL_EVENT_TYPES[result.status],
        subject: { kind: 'match', id: result.matchId },
        payload: {
          status: result.status,
          mode: result.mode,
          mapId: result.mapId,
          terminationReason: result.terminationReason ?? result.status,
          outcomeReason: result.outcomeReason ?? null,
          winnerTeam: result.winnerTeam ?? null,
          invalidationReason: result.invalidationReason ?? null,
          teamScores: result.teamScores ?? null,
          startedAt: result.startedAt ?? null,
          endedAt: result.endedAt ?? null,
        },
      });
      await outbox.emitIn(tx, ctx, {
        type: 'match.result_applied',
        subject: { kind: 'match', id: result.matchId },
        payload: {
          status: result.status,
          outcomeReason: result.outcomeReason ?? null,
          winnerTeam: result.winnerTeam ?? null,
          accountsAffected: appliedTo.length,
          resultAppliedAt,
        },
      });
      // Same transaction as the write above: a crash between them would leave a career applied
      // with nothing recording that it was, and the retry would apply it a second time.
      await store.idempotency.put({
        key, actorId: RESULT_ACTOR, requestHash,
        responseStatus: 200, responseBody: response,
        createdAt: resultAppliedAt,
        expiresAt: new Date(clock.now() + IDEMPOTENCY_TTL_MS).toISOString(),
      }, tx);
      return response;
    });
  }

  /** §11.5: counters only. No K/D, no accuracy, no win rate in the response. */
  async function getCareerForMode(accountId, mode, sdv) {
    const rows = await store.stats.listForAccount(accountId);
    const totals = emptyTotals();
    for (const row of rows) {
      if (row.statDefinitionVersion !== sdv) continue;
      if (row.mode !== mode) continue;
      addTotals(totals, row);
    }
    const weapons = {};
    for (const w of await store.weaponStats.listForAccount(accountId, mode)) {
      if (w.statDefinitionVersion !== sdv) continue;
      if (w.mode !== mode) continue;
      const into = (weapons[w.weaponId] ||= { shots: 0, hits: 0, kills: 0, headshots: 0 });
      for (const k of WEAPON_KEYS) into[k] += w[k] || 0;
    }
    return { accountId, mode, statDefinitionVersion: sdv, totals, weapons };
  }

  /**
   * `mode=all` returns PER-MODE objects, never a flat sum.  http-api.md §11.5.
   *
   * The contract is explicit that it "does not sum across modes — a combined K/D over two
   * rulesets with different death semantics is a number that means nothing". This returned a
   * single merged `totals`, which is precisely that number, and it is the default shape of the
   * career endpoint so it was the one most clients would have consumed.
   */
  async function getCareer(accountId, mode = 'all', sdv = STAT_DEFINITION_VERSION) {
    if (mode === 'all') {
      const [tdm, bomb] = await Promise.all([
        getCareerForMode(accountId, 'tdm', sdv),
        getCareerForMode(accountId, 'bomb', sdv),
      ]);
      return { accountId, statDefinitionVersion: sdv, modes: { tdm, bomb } };
    }
    return getCareerForMode(accountId, mode, sdv);
  }

  /**
   * §6: rebuild the career from match history alone. The reconciliation check — if this
   * disagrees with `getCareer`, an application was partial and the stored total is wrong.
   */
  async function recomputeCareer(accountId, mode = 'all', sdv = STAT_DEFINITION_VERSION) {
    // §6's reconciliation compares this against `getCareer`, so the two must return the SAME
    // shape for the same argument. When `getCareer('all')` became per-mode and this did not,
    // the check compared a nested object against a flat one and could never agree — a
    // reconciliation that cannot pass is a reconciliation that proves nothing.
    if (mode === 'all') {
      const [tdm, bomb] = await Promise.all([
        recomputeCareer(accountId, 'tdm', sdv),
        recomputeCareer(accountId, 'bomb', sdv),
      ]);
      return { accountId, statDefinitionVersion: sdv, modes: { tdm, bomb } };
    }
    return recomputeForMode(accountId, mode, sdv);
  }

  async function recomputeForMode(accountId, mode, sdv) {
    const totals = emptyTotals();
    const weapons = {};
    let cursor = null;
    do {
      // PAGE_LIMIT_MAX, not a larger number of its own: §10 fixes the maximum page, and a caller
      // that exceeds it now gets VALIDATION_FAILED rather than a silently clamped page.
      const page = await store.matches.listForAccount(accountId, { limit: PAGE_LIMIT_MAX, cursor });
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

  /**
   * §4.2 `GET /v1/matches/:matchId` — the exact response union, built here rather than in a
   * handler so one projection serves every caller.
   *
   * Four shapes discriminated by `status`, no more and no fewer keys than the union lists.
   * `correlationId` is on every variant (§4.2), and the terminal refinements carry the whole
   * record including the roster derived from the participants.
   *
   * The three non-terminal states, which §4.2's table left to inference and which the client
   * must be able to tell apart from ONE response — it has no other source:
   *
   * | stored status | startedAt | endedAt | means |
   * |---|---|---|---|
   * | `allocated`   | null      | null    | the id exists, the server has not started the match |
   * | `in-progress` | set       | null    | LIVE |
   * | `in-progress` | set       | set     | ended, the result is queued and not yet submitted |
   *
   * All three are `pending` with `retryAfterMs`, because a client cannot act on the difference —
   * it waits either way. All three carry both keys with an explicit null rather than omitting
   * one, so a missing key stays a bug rather than becoming a fourth state. A row that has
   * reached a terminal status projects as terminal whether or not the career application has
   * been stamped: `result_applied_at` is a fact about the career, not about the result.
   */
  async function getMatch(matchId, { viewer = null, correlationId = null } = {}) {
    const row = typeof matchId === 'string' && matchId ? await store.matches.byId(matchId) : null;
    // §4.2: never-existed and not-a-participant-and-privacy-forbids are the SAME answer. One
    // error object, raised from one place, so the two cannot drift into being distinguishable
    // by message, by `details`, or by how long they take to arrive.
    const notFound = () => new ApiError('NOT_FOUND', 'No such match.', { details: { matchId } });
    if (!row) throw notFound();
    const participants = row.participants || [];
    const access = await accessFor(participants, viewer);
    if (!access.allowed) throw notFound();
    if (toHistoryMatchStatus(row.status) === 'pending') {
      return {
        matchId: row.matchId,
        status: 'pending',
        mode: row.mode,
        mapId: row.mapId,
        mapVersion: row.mapVersion ?? null,
        startedAt: row.startedAt ?? null,
        // Null while LIVE; the real timestamp once ended and queued (§4.2). Not defaulted to
        // "now" and not omitted: a missing key here is what made the two states unreadable.
        endedAt: row.endedAt ?? null,
        retryAfterMs: PENDING_RETRY_AFTER_MS,
        correlationId,
      };
    }
    return {
      matchId: row.matchId,
      status: row.status,
      rulesetVersion: row.rulesetVersion,
      statDefinitionVersion: row.statDefinitionVersion,
      rulesSnapshot: row.rulesSnapshot,
      serverBuild: row.serverBuild,
      mapId: row.mapId,
      mapVersion: row.mapVersion,
      region: row.region,
      mode: row.mode,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      terminationReason: row.terminationReason,
      outcomeReason: row.outcomeReason,
      winnerTeam: row.winnerTeam ?? null,
      invalidationReason: row.invalidationReason ?? null,
      // The roster is derived from `match_participants` (db-schema.md §4) rather than stored a
      // second time, so it cannot disagree with the players it would have duplicated.
      roster: participants.map((p) => ({
        accountId: p.accountId, team: p.team ?? null,
        joinedAt: p.joinedAt ?? null, leftAt: p.leftAt ?? null,
      })),
      teamScores: row.teamScores,
      // §4.1: "Objective actors are always present in the stored record. Whether they are
      // RETURNED depends on §4.2." This is that hinge — a stranger reading a public match gets
      // the round, the reason and the timing, and not who planted.
      rounds: access.participant ? (row.rounds ?? []) : withoutObjectiveActors(row.rounds),
      players: participants.map((p) => p.stats),
      // §7: `evidenceRef` points at the internal authoritative record — the event timeline,
      // position and combat samples, and anti-cheat flags. It is the input to a cheat review,
      // not a field a player is owed, and handing it to the participants of a match hands it to
      // whoever they are protecting. Present as null (§11.8's convention for a withheld field,
      // never omitted) for every player caller; real only for a service caller, which is the
      // only caller that has to reconstruct a result from it.
      evidenceRef: access.service ? row.evidenceRef : null,
      correlationId,
    };
  }

  /**
   * Who may read a match, and what they may read of it.  §4.2.
   *
   * Three answers, and the refusal is a 404 rather than a 403 at the call site above:
   *
   *  - a SERVICE caller sees everything, including `evidenceRef` (§7);
   *  - a PARTICIPANT sees the whole record except `evidenceRef`;
   *  - anyone else sees it only if EVERY participant publishes their career, and then without
   *    the objective actors.
   *
   * "Every participant" is deliberate. A match record is joint: it names ten people, their
   * teams, their kills and when they left. There is no per-match privacy setting to consult, so
   * the only defensible reading of "privacy forbids" is that one player's `statsVisibility:
   * nobody` is not overridden by nine teammates who chose otherwise. The alternative — publish
   * the record if anyone in it is public — makes the setting worthless to the person who set it,
   * since they cannot control who they are matched with.
   */
  async function accessFor(participants, viewer) {
    if (viewer && viewer.kind === 'service') return { allowed: true, service: true, participant: true };
    const viewerId = viewer && typeof viewer === 'object' ? (viewer.accountId ?? null) : viewer ?? null;
    // No viewer is not "an anonymous viewer": it is a caller that forgot to pass one. Fail
    // closed, or the authorization is enforced only where someone remembered it.
    if (typeof viewerId !== 'string' || !viewerId) return { allowed: false };
    if (participants.some((p) => p.accountId === viewerId)) {
      return { allowed: true, service: false, participant: true };
    }
    // A row with no participants at all — an allocation whose roster has not landed — has
    // nobody to authorise against, so nobody outside the platform reads it.
    if (!participants.length || !visibilityFor) return { allowed: false };
    for (const p of participants) {
      let visible = null;
      // A participant whose account has since been deleted cannot consent to anything, and a
      // throw here must not become a 500 that also confirms the match exists.
      try { visible = await visibilityFor(p.accountId, viewerId); } catch { return { allowed: false }; }
      if (!visible?.stats) return { allowed: false };
    }
    return { allowed: true, service: false, participant: false };
  }

  /** Keep the round, drop who did it. The shape is unchanged; the actor id becomes null. */
  function withoutObjectiveActors(rounds) {
    return (rounds ?? []).map((round) => ({
      ...round,
      plant: round.plant ? { ...round.plant, accountId: null } : (round.plant ?? null),
      defuse: round.defuse ? { ...round.defuse, accountId: null } : (round.defuse ?? null),
    }));
  }

  /**
   * §7.1 `GET /v1/matches/active` — "am I in a match?", answered server-side.
   *
   * The caller's newest non-terminal match, or null. Derived from `match_participants` rather
   * than from anything the client remembers, because a reload is precisely when the client
   * remembers nothing (REQ-CC-029).
   *
   * `graceEndsAt` is the reconnect window (realtime-lobby.md §2: `graceMs`, 90 s) measured from
   * the last fact the PLATFORM holds — the roster's `leftAt` if they have dropped, otherwise
   * now, since a still-seated player's seat is held at least that long. The authoritative
   * countdown for a ticket is minted by `POST /matches/:id/reconnect-ticket` (§7); this endpoint
   * exists to tell the client which match to ask about, and answering with a plausible number
   * from the wrong clock would be worse than the extra request.
   */
  async function activeMatchFor(accountId) {
    if (typeof accountId !== 'string' || !accountId) return null;
    const page = await store.matches.listForAccount(accountId, { limit: PAGE_LIMIT_MAX, cursor: null });
    const held = page.items.find((m) => m.status === 'pending');
    if (!held) return null;
    const nowMs = clock.now();
    const leftAtMs = Date.parse(held.participant?.leftAt ?? '');
    const from = Number.isFinite(leftAtMs) ? leftAtMs : nowMs;
    return {
      matchId: held.matchId,
      roomId: held.roomId ?? null,
      graceEndsAt: new Date(from + RECONNECT_GRACE_MS).toISOString(),
      serverNow: new Date(nowMs).toISOString(),
    };
  }

  /**
   * §4.3 history union: a pending item carries null for every outcome field, never omits.
   *
   * The page arguments are VALIDATED (§10) rather than clamped — `limit=0` quietly becoming 25
   * and a malformed cursor quietly becoming "from the top" both return a plausible page for a
   * request that was wrong, which is how a paging bug survives.
   */
  async function history(accountId, pageArgs = {}) {
    const { limit, cursor } = assertPageArgs(pageArgs);
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

  /**
   * §11.5/§4.3: what a career looks like when privacy forbids it.
   *
   * The SAME shape, with the counters null. It was an ad-hoc object — `{ accountId, mode: 'all',
   * totals: null, weapons: null }` — which for `mode=all` is not the contracted response at all:
   * the visible answer is per-mode `modes: { tdm, bomb }` and carries no `mode` key, so a client
   * reading a hidden career got a shape its type never described and could only crash on. Built
   * here, beside the visible projection, because that is the only way the two stay the same
   * shape when one of them changes.
   */
  function hiddenCareer(accountId, mode, sdv = STAT_DEFINITION_VERSION) {
    const blank = (m) => ({ accountId, mode: m, statDefinitionVersion: sdv, totals: null, weapons: null });
    if (mode === 'all') {
      return { accountId, statDefinitionVersion: sdv, modes: { tdm: blank('tdm'), bomb: blank('bomb') } };
    }
    return blank(mode);
  }

  return { applyMatchResult, getCareer, hiddenCareer, recomputeCareer, history, getMatch, activeMatchFor };
}
