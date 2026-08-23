/**
 * Site outcomes, measured — REDEFINED for symmetric demolition (`bomb-rules.md` §13.9,
 * amendment 2.0.0). The §7.1-derived "attack win rate per site, 45–55%" is dead: every
 * round involves both sites, either team may take the neutral bomb, and each team defends
 * its OWN site. What this harness now measures, in the order §13.9 lists it:
 *
 *   1. HOME-DEFENSE WIN RATE PER SITE — of the decided (non-draw) rounds in which a plant
 *      happened at site S or the round's fighting was attributed to S (bot commitment,
 *      §B below), the share won by S's OWNER that round (`record.homeSites`). Balanced =
 *      45–55% per site, Wilson-gated three-valued exactly as before. This is the direct
 *      successor of the old attack-rate number: it answers "can each team defend its own
 *      site", which is what the owner's design makes the balance question.
 *   2. FIRST-POSSESSION SHARE — the share of rounds in which team 0 takes the first pickup
 *      of the neutral bomb. Balanced = 50±5%. This measures neutral-spawn fairness
 *      (spawn-to-bomb-spawn route symmetry), a quantity that did not exist before.
 *   3. PLANT RATE gate, retained unchanged (≥40% of rounds reach a completed plant, hard
 *      fail below) — plus its new sibling: DRAW RATE is printed, and a draw rate above 20%
 *      is escalated, because a symmetric mode that mostly times out is a mode where nobody
 *      can convert possession.
 *   4. ATTRIBUTION reads the bots' live committed state, as before — but the old
 *      "whole squad names one site" assertion becomes PER-TEAM: each team has exactly one
 *      legal target (the enemy's home, `rules.targetSiteOf(team)`), so the assertion is
 *      now "every committed attacker on team T names T's target", which is simpler and
 *      stronger than the old memo check.
 *
 * ── What "a round attributed to site S" means now ────────────────────────────────────
 *
 * Still NOT "a round in which the bomb was planted at S" alone — that conditions away the
 * rounds the defense won before a plant, which are exactly the defense's wins (the same
 * bias §1 of the old header documented; it has not gone anywhere). A planted round is
 * attributed to its plant site. A DECIDED round with no plant is attributed to the site
 * that drew the majority of pre-plant committed-attacker ticks (roles `carry`/`planting`/
 * `escort`, each of which names the actor's one legal target site). A decided round with
 * no plant and no committed-attacker majority — a pure bomb-contest round ended by
 * elimination mid-map, or a tie — is genuinely about neither site and is excluded from the
 * per-site denominator, counted and printed. `contest` has no site by construction and
 * `defend`/`retake`/`defusing`/`postplant` describe the OTHER side of the same fight, so
 * only the carry/escort family attributes.
 *
 * The commitment is read from the bots' own live state (`bot.objectiveRole` /
 * `bot.objectiveSite`), never recomputed from seed arithmetic — a copy of the planner's
 * formula would keep agreeing with itself after the planner changed. §B separately asserts
 * the per-team target discipline (point 4) that lets any one bot's state stand for its team.
 *
 * ── ABSENT vs PARTIAL (unchanged rule, new probe) ────────────────────────────────────
 *
 * ABSENCE IS DECIDED BY A CAPABILITY PROBE, NOT BY THE SAMPLE — a tree without the bots'
 * Bomb objective layer and a tree whose layer is 100% broken produce the identical empty
 * sample, and they are opposite verdicts (schedule vs regression; the total shape is the
 * likely shape of a real regression). The probe now asks for `_applyBombObjective`,
 * `_setObjective` and `_defendHome` — `_bombSite` (the old per-round site memo) was
 * REMOVED by the symmetric rewrite, §13.11: there is exactly one legal target per team, so
 * the memo has nothing left to memoise. The previous revision of this file probed for
 * `_bombSite` and therefore reported the layer absent on a tree where it is alive and
 * well; that is the failure mode this paragraph exists to prevent recurring.
 *
 * On a tree that HAS the layer, an empty sample is a hard failure with no ticket on it.
 * Genuine absence is PENDING, names `src/ai/botManager.js`, and is fatal under `--strict`.
 *
 * ── Envelope breaches are PENDING, not FAIL (unchanged) ──────────────────────────────
 *
 * A band number outside its envelope on The Square is joint map/bots work (the geometry
 * lane is redesigning the-square's geometry right now); every assertion about OUR OWN code
 * (matches complete, bots plant, per-team discipline holds, replays identical) stays a
 * hard failure at any sample size. `--strict` makes envelope breaches fatal; it is NOT
 * used by `ci` (`npm run siteoutcome` is `--matches=200`, no strict) — it exists so the
 * bands can be PROVEN failable (the degrade runs below) and so the gate can be switched on
 * in one place once the-square's redesign lands and the envelope numbers settle. The
 * previous package.json ran ci strict; with the 2.0.0 baselines void and the geometry in
 * another worktree, that would fail every backend commit on the map lane's open work,
 * which is the exact outcome the paragraph above exists to prevent. Wilson three-valued
 * verdicts (INSIDE / BREACH-decisive / INCONCLUSIVE) are retained exactly as before: only
 * a breach whose whole 95% interval clears the band escalates.
 *
 * ── The ≥200-match result ────────────────────────────────────────────────────────────
 *
 * RESULT-200 (2026-08-20, attacker/defender ruleset) is VOID — §13.9 voids all baselines
 * for regeneration after implementation; those figures measured a flow that no longer
 * exists. Current baseline:
 *
 *   RESULT-200-SYM (2026-08-23, `--matches=200`, seed0 760001, The Square v1.0.0,
 *   symmetric demolition per bomb-rules 2.0.0):
 *
 *     200 series · 1,984 rounds · 59 s wall at 10 concurrent
 *     plant rate                 43.0%  (853/1984)             → over the 40% floor, thinly
 *     draw rate                   1.2%  (23/1984, all `timer`) → far under the 20% ceiling
 *     first possession, team 0   97.9%  (1941/1983, CI 97.1–98.4) → DECISIVE BREACH of 50±5
 *     site A home-defense        43.2%  (316/731,  CI 39.7–46.8)  → outside, INCONCLUSIVE
 *     site B home-defense        51.4%  (632/1229, CI 48.6–54.2)  → inside 45–55
 *     A/B asymmetry               8.2 points                      → inside 10
 *     unattributed decided rounds 1/1961
 *
 *   The first-possession figure is the headline: team 0 reaches the neutral bomb first in
 *   ~98% of rounds, so the spawn-to-bomb-spawn routes are grossly asymmetric — precisely
 *   the quantity this metric was created to see, invisible under the old ruleset. It is
 *   escalated as PENDING against the-square's geometry redesign (in flight in another
 *   worktree; the derived midpoint bomb spawn and/or team spawn routes need to equalise).
 *   It also poisons the per-site read: team 0 nearly always carries, so site B (team 0's
 *   usual target before the switch) sees 735 of the 853 plants. Both per-site numbers and
 *   the plant rate should be treated as provisional until first possession is near 50%.
 *   Regenerate with `npm run siteoutcome` whenever the map, the bots or the ruleset move;
 *   the numbers are a joint property of all three.
 *
 *   node scripts/siteoutcome.mjs --matches=200
 *   node scripts/siteoutcome.mjs --matches=40 --jobs=8
 *   node scripts/siteoutcome.mjs --matches=40 --jobs=8 --strict --degrade=site-a-shrink
 *   node scripts/siteoutcome.mjs --matches=40 --jobs=8 --strict --degrade=site-a-nodefuse
 *   node scripts/siteoutcome.mjs --matches=40 --jobs=8 --strict --degrade=site-a-swallow
 *
 * The degradations still edit the REAL map manifest (`world.manifest.objectives`), site B
 * untouched as the in-run control — their expected signatures under the NEW metrics:
 * `shrink` (12 cm plant volume at A) starves the plant rate toward the 40% floor and/or
 * the draw-rate ceiling; `nodefuse` (a defuse volume nobody can stand in at A) makes every
 * bomb planted at A undefusable, so A's OWNER loses every planted-at-A round and A's
 * home-defense rate craters LOW; `swallow` (plant volume = whole map at A) lets whoever
 * targets A plant from spawn, the same collapse from the other door.
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.join(HERE, 'siteoutcome.mjs');

const ARGV = process.argv.slice(2);
const flag = (k) => ARGV.includes(`--${k}`);
const opt = (k, d = null) => {
  const hit = ARGV.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

/** §13.9.1: 45–55% home-defense win rate per site. */
const BAND_LO = 0.45;
const BAND_HI = 0.55;
/** §13.9.2: first-possession share for team 0, 50±5% over the full sample. */
const POSSESS_LO = 0.45;
const POSSESS_HI = 0.55;
/**
 * §13.9.3, retained: below this share of rounds reaching a completed plant, the win rates
 * are a statement about the round clock rather than about the sites. Catches "bots cannot
 * plant at all", not the balance between planting and being stopped.
 */
const PLANT_RATE_MIN = 0.40;
/** §13.9.3, new: a symmetric mode that mostly times out converts nothing. Escalated above this. */
const DRAW_RATE_MAX = 0.20;
/**
 * A legal series is 7–12 rounds: first-to-7 ends no earlier than round 7, `maxRounds` caps
 * at 12, and §13.6's drawn rounds count toward the cap without moving `roundWins`.
 */
const ROUNDS_MIN = 7;
const ROUNDS_MAX = 12;

// ─────────────────────────────────────────────────────────────────── child: one match
if (flag('child')) {
  const seed = Number(opt('seed', '1'));
  const degrade = opt('degrade', '');
  try {
    const rows = await runMatch(seed, degrade);
    process.send({ ok: true, seed, ...rows });
  } catch (e) {
    process.send({ ok: false, seed, error: `${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}` });
  }
  process.exit(0);
}

/**
 * Play one full autonomous Bomb series on The Square and return its round records.
 *
 * The player entity is disconnected before the first Bomb tick (`noteDisconnect`), the same
 * thing `bombbottest.mjs` does, so every kill, pickup, plant and defuse in the sample
 * belongs to an autonomous bot and no human-shaped entity stands still in a spawn skewing
 * a side — which matters twice as much now that first possession is itself a metric.
 */
async function runMatch(seed, degrade) {
  const { Game } = await import('../src/core/game.js');
  const { NullPresenter } = await import('../src/core/presenter.js');
  const { FIXED_DT } = await import('../src/core/mathUtils.js');

  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter(), mapId: 'the-square' });

  /**
   * Does the capability this harness measures THROUGH exist in this tree at all?
   * Structural, never derived from the sample (see the header). `_bombSite` is gone by
   * design — probing for it is how the previous revision broke.
   */
  const bm = game.bots;
  const capability = {
    applyBombObjective: typeof bm?._applyBombObjective === 'function',
    setObjective: typeof bm?._setObjective === 'function',
    defendHome: typeof bm?._defendHome === 'function',
  };

  const degradeNote = applyDegrade(game, degrade);

  game.startMatch({ mode: 'bomb', botCount: 11, difficulty: 'regular', seed });
  game.match.phase = 'live';
  game.match.countdown = 0;
  const rules = game.match.bombRules;
  rules.noteDisconnect(game.player);

  /**
   * Roles that name the actor's one legal TARGET site while attacking it (§13.11).
   * `contest` carries no site by construction; `defend`/`retake`/`defusing`/`postplant`
   * describe the other side of the same fight and must not double-count it.
   */
  const ATTACK_ROLES = new Set(['carry', 'planting', 'escort']);
  const firstPickupBy = new Map();   // roundIndex -> team (0|1) that took the first pickup
  const pressureBy = new Map();      // roundIndex -> Map(site id -> pre-plant committed-attacker ticks)
  const namedBy = new Map();         // roundIndex -> [Set, Set] sites named by each team's ATTACK_ROLES bots

  // A whole series, bounded. The bound is a hang detector, not a sample cut-off: a run that
  // hits it is reported as a failure, never folded into the statistics.
  const MAX_TICKS = 120 * 60 * 35;
  let ticks = 0;
  while (rules.series === null && ticks < MAX_TICKS) {
    game._fixedUpdate(FIXED_DT);
    ticks++;
    if (!rules.liveRound) continue;
    const ri = rules.roundIndex;
    // §13.9.2 first possession: the first tick the neutral bomb is carried this round.
    if (rules.bomb.state === 'carried' && !firstPickupBy.has(ri)) {
      const carrier = game.entityById?.(rules.bomb.carrierId);
      if (carrier && (carrier.team === 0 || carrier.team === 1)) firstPickupBy.set(ri, carrier.team);
    }
    // Pre-plant only. After the plant both squads converge on the bomb's site by
    // construction, so counting those ticks would report the plant back to itself.
    if (rules.phase !== 'live') continue;
    let pressure = pressureBy.get(ri);
    if (!pressure) { pressure = new Map(); pressureBy.set(ri, pressure); }
    let named = namedBy.get(ri);
    if (!named) { named = [new Set(), new Set()]; namedBy.set(ri, named); }
    for (const bot of game.bots.bots) {
      if (!bot.alive || !rules.isAlive(bot)) continue;
      if (!ATTACK_ROLES.has(bot.objectiveRole)) continue;
      if (typeof bot.objectiveSite !== 'string' || bot.objectiveSite === '') continue;
      pressure.set(bot.objectiveSite, (pressure.get(bot.objectiveSite) ?? 0) + 1);
      named[bot.team === 1 ? 1 : 0].add(bot.objectiveSite);
    }
  }

  // Plants are read from the ROUND RECORDS, not from `rules.events`: the event log is
  // capped and shifts, so a long series silently loses its early plants.
  const rounds = rules.rounds.map((r, i) => {
    const named = namedBy.get(i) ?? [new Set(), new Set()];
    return {
      round: r.round,
      winnerTeam: r.winnerTeam,                    // -1 is a §13.6 drawn round
      reason: r.reason,
      homeSites: { 0: r.homeSites[0], 1: r.homeSites[1] },
      plantedByTeam: r.plantedByTeam,
      planted: r.planted === true,
      plantSite: typeof r.site === 'string' ? r.site : null,
      firstPickupTeam: firstPickupBy.get(i) ?? -1, // -1: nobody ever picked it up
      // Pre-plant committed-attacker ticks per target site — the attribution evidence.
      pressure: Object.fromEntries(pressureBy.get(i) ?? []),
      // Sites named by each team's committed attackers. §13.9.4: each set must be a subset
      // of { that team's one legal target }, or the attribution below is invalid.
      namedSites: [[...named[0]].sort(), [...named[1]].sort()],
    };
  });

  const out = {
    finished: rules.series !== null,
    ticks,
    capability,
    siteIds: [...rules.siteIds],
    rounds,
    degradeNote,
    // The whole ordered outcome, for the replay check. A count would pass a run that
    // reached the same tally down a different road, which is what a replay would not do.
    signature: rounds.map((r) => `${r.round}:${r.homeSites[0]}>${r.homeSites[1]}:${r.firstPickupTeam}:${r.winnerTeam}:${r.reason}:${r.plantSite}:${r.plantedByTeam}`).join('|'),
  };
  game.dispose?.();
  return out;
}

/**
 * Degrade a REAL input: the map manifest's objective volume for site A.
 *
 * `world.manifest` is the normalised object every consumer reads — `BombRules` compiles its
 * site table from it, `botManager` aims at `plant`'s centre, and the HUD names it. Editing
 * the volume here is the same edit a map author would make, which is the point: the guard
 * has to be able to fail on a real map defect. Site B stays the in-run control.
 */
function applyDegrade(game, degrade) {
  if (!degrade) return null;
  const objectives = game.world.manifest?.objectives;
  if (!Array.isArray(objectives) || objectives.length === 0) {
    throw new Error(`--degrade=${degrade}: the map declares no objective volumes to degrade`);
  }
  const siteA = objectives.find((o) => o.site === 'A' && o.kind === 'plant');
  if (!siteA) throw new Error(`--degrade=${degrade}: no plant volume for site A`);
  const c = {
    x: (siteA.box.min.x + siteA.box.max.x) / 2,
    y: siteA.box.min.y,
    z: (siteA.box.min.z + siteA.box.max.z) / 2,
  };
  if (degrade === 'site-a-shrink') {
    // A plant volume a player cannot reliably stand inside. Still well formed (maptest's
    // §3.3 rule), still on the ground, simply too small to use.
    siteA.box.min.set(c.x - 0.06, c.y, c.z - 0.06);
    siteA.box.max.set(c.x + 0.06, c.y + 2.4, c.z + 0.06);
    return 'site A plant volume shrunk to 12 cm';
  }
  if (degrade === 'site-a-nodefuse') {
    // §3.3 lets a site declare a defuse volume distinct from its plant volume; this one
    // declares a defuse volume nobody can stand in, so a bomb planted at A can never be
    // defused — under symmetric rules A's OWNER loses every planted-at-A round and A's
    // home-defense rate collapses LOW (the old ruleset read this same defect as attack-high).
    objectives.push({
      id: 'site-A-defuse', kind: 'defuse', site: 'A', requiresGround: true,
      box: {
        min: siteA.box.min.clone().set(c.x - 0.05, c.y, c.z - 0.05),
        max: siteA.box.max.clone().set(c.x + 0.05, c.y + 0.1, c.z + 0.05),
      },
    });
    return 'site A given a 10 cm defuse volume — a planted bomb there cannot be defused';
  }
  if (degrade === 'site-a-swallow') {
    // The opposite defect: a plant volume so large the team targeting A is standing in it
    // at the pickup, so they plant the moment they carry and A's owner must cross the map.
    const b = game.world.manifest.bounds;
    siteA.box.min.set(b.min.x, 0, b.min.z);
    siteA.box.max.set(b.max.x, 2.4, b.max.z);
    return 'site A plant volume enlarged to the whole map';
  }
  throw new Error(`--degrade names a known degradation; '${degrade}' is not one`);
}

// ───────────────────────────────────────────────────────────────────── parent: the run
const MATCHES = Math.max(1, Number(opt('matches', '6')));
const JOBS = Math.max(1, Math.min(MATCHES, Number(opt('jobs', String(Math.max(1, Math.min(os.cpus().length, MATCHES)))))));
const SEED0 = Number(opt('seed0', '760001'));
const DEGRADE = opt('degrade', '');
const STRICT = flag('strict');

let failures = 0;
const ok = (n, d = '') => console.log(`  ok   ${n}${d ? `\n       ${d}` : ''}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };
const note = (n) => console.log(`  --   ${n}`);
/**
 * Loud, named, non-fatal unless `--strict` — and it must SAY WHOSE work it is waiting on.
 * A balance-envelope breach is joint map/bots work (the geometry lane holds the-square
 * right now); a missing objective layer is `src/ai/botManager.js`. Stamping the wrong
 * lane's ticket on a defect is worse than printing nothing.
 */
const pending = (n, d, owner = 'the-square geometry ([CX] worktree) / bots objective planner ([CC]) — joint balance envelope') => {
  if (STRICT) { failures++; console.log(`  FAIL ${n}\n       ${d}\n       owner: ${owner}`); return; }
  console.log(`  PENDING  ${n}: ${d} — ${owner}.`);
};

function runChild(seed) {
  return new Promise((resolve) => {
    const args = ['--child', `--seed=${seed}`];
    if (DEGRADE) args.push(`--degrade=${DEGRADE}`);
    const child = fork(SELF, args, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    let payload = null;
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('message', (m) => { payload = m; });
    child.on('exit', (code) => {
      if (payload) resolve(payload);
      else resolve({ ok: false, seed, error: `child exited ${code} without a result\n${stderr.trim().split('\n').slice(-4).join('\n')}` });
    });
  });
}

/** Run `seeds` across at most JOBS child processes at a time. */
async function runPool(seeds) {
  const out = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= seeds.length) return;
      out[i] = await runChild(seeds[i]);
      done++;
      // Only on a terminal: in a CI log this would be 200 lines of carriage returns.
      if (process.stdout.isTTY) process.stdout.write(`\r  … ${done}/${seeds.length} matches`);
    }
  };
  await Promise.all(Array.from({ length: JOBS }, worker));
  if (process.stdout.isTTY) process.stdout.write(`\r${' '.repeat(40)}\r`);
  return out;
}

/**
 * Wilson score interval — the reason a small sample can be reported honestly instead of
 * being dressed up as a measurement. The normal approximation collapses at the extremes a
 * degraded map produces, and reporting `0% ± 0%` there would be the worst possible answer.
 */
function wilson(k, n, z = 1.96) {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (c - s) / d), hi: Math.min(1, (c + s) / d) };
}

/**
 * The three-valued band verdict, shared by every envelope number in this file:
 * INSIDE → ok; outside with the whole 95% interval clear of the band → BREACH (escalated
 * via `pending`); outside but overlapping → INCONCLUSIVE (printed with advice, exit 0).
 */
function bandVerdict(label, k, n, lo, hi, describe) {
  const p = n ? k / n : 0;
  const ci = wilson(k, n);
  const pct = (x) => (x * 100).toFixed(1);
  if (p >= lo && p <= hi) { ok(`${label} ${pct(p)}% is inside ${pct(lo)}–${pct(hi)}%`); return; }
  const decisive = ci.hi < lo || ci.lo > hi;
  if (decisive) {
    pending(`${label} is inside ${pct(lo)}–${pct(hi)}%`,
      `${pct(p)}% (${k}/${n}), 95% CI ${pct(ci.lo)}–${pct(ci.hi)}% — ${describe(p)}, and the interval clears the band`);
  } else {
    note(`${label} ${pct(p)}% is outside ${pct(lo)}–${pct(hi)}% but INCONCLUSIVE at n=${n}`
      + ` (95% CI ${pct(ci.lo)}–${pct(ci.hi)}%) — this sample cannot police a ±5 point band; run --matches=200`);
  }
}

const seeds = Array.from({ length: MATCHES }, (_, i) => SEED0 + i * 7919);
console.log(`\nsite outcomes (symmetric demolition, bomb-rules §13.9) — ${MATCHES} full Bomb series on the-square, ${JOBS} concurrent`
  + `${DEGRADE ? `, DEGRADED: ${DEGRADE}` : ''}${STRICT ? ', strict' : ''}`);
const t0 = Date.now();
const results = await runPool(seeds);
const wall = (Date.now() - t0) / 1000;

// ── A. every match has to have actually happened ─────────────────────────────────────
const broken = results.filter((r) => r.ok !== true);
if (broken.length === 0) ok(`all ${MATCHES} matches ran`);
else bad('every match ran to completion', `${broken.length} failed:\n       ${broken.slice(0, 3).map((r) => `seed ${r.seed}: ${r.error}`).join('\n       ')}`);
const good = results.filter((r) => r.ok === true);
if (good.length === 0) {
  console.log('\n1 FAILED — no match produced a result, so nothing below could be measured');
  process.exit(1);
}
if (DEGRADE) note(`degradation in effect: ${good[0].degradeNote}`);

const unfinished = good.filter((r) => r.finished !== true);
if (unfinished.length === 0) ok(`every series reached matchEnd inside the tick budget`);
else bad('every series reaches matchEnd inside the tick budget', `${unfinished.length} hit the 35-minute hang bound`);

const rounds = good.flatMap((r) => r.rounds);
const badLen = good.filter((r) => r.rounds.length < ROUNDS_MIN || r.rounds.length > ROUNDS_MAX);
if (badLen.length === 0) ok(`${rounds.length} rounds over ${good.length} series, every series ${ROUNDS_MIN}–${ROUNDS_MAX} rounds`);
else bad('every series is a legal length', `${badLen.length} outside ${ROUNDS_MIN}–${ROUNDS_MAX}: ${badLen.slice(0, 4).map((r) => r.rounds.length).join(',')}`);

// ── B. the measurement is meaningful before any of it is reported ────────────────────
console.log('');
const siteIds = [...new Set(good.flatMap((r) => r.siteIds))].sort();
if (siteIds.length === 2) ok(`the map declares 2 bomb sites: ${siteIds.join(', ')}`);
else bad('the map declares exactly two bomb sites', `declared: ${siteIds.join(', ') || '(none)'} — symmetric demolition is defined over exactly two (§13.1/§13.12.19)`);

/**
 * ABSENT is a schedule; PARTIAL is a defect — decided by the capability probe, never by
 * the sample (full rationale in the header). The probe matches the SYMMETRIC planner's
 * surface; `_bombSite` no longer exists and is deliberately not asked for.
 */
const capable = good.filter((r) => r.capability?.applyBombObjective === true
  && r.capability?.setObjective === true && r.capability?.defendHome === true);
const CAPABLE = capable.length === good.length;
const ABSENT = capable.length === 0;

if (!CAPABLE && !ABSENT) {
  bad('every match agrees on whether the bots\' Bomb objective layer exists',
    `${capable.length}/${good.length} children found it — the sample mixes two trees and nothing below can be attributed`);
}

const planted = rounds.filter((r) => r.planted && r.plantSite !== null);
const decided = rounds.filter((r) => r.winnerTeam === 0 || r.winnerTeam === 1);
const draws = rounds.filter((r) => r.winnerTeam === -1);

/** Attribute one round to a site per the header's rule, or null. */
function attributeRound(r) {
  if (r.planted && r.plantSite !== null) return r.plantSite;
  const entries = Object.entries(r.pressure ?? {});
  if (entries.length === 0) return null;
  entries.sort((a, b) => b[1] - a[1]);
  if (entries.length > 1 && entries[0][1] === entries[1][1]) return null; // tie: neither site's round
  return entries[0][0];
}

if (rounds.length === 0) {
  bad('the sample contains rounds', '0 rounds — every statistic below would be computed over an empty set');
} else if (ABSENT) {
  pending('the bots\' Bomb objective layer is present in this tree',
    `botManager exposes no _applyBombObjective/_setObjective/_defendHome, so no bot can take a Bomb`
    + ` objective role and no round can be attributed (${rounds.length} rounds, ${planted.length} plants).`
    + ' No rate is reported: a distribution over zero attributed rounds is not a measurement.'
    + ' The moment the layer lands, an empty sample becomes a FAILURE',
    'src/ai/botManager.js ([CC], another session) — the objective layer has not landed');
}

/**
 * §13.9.4 per-team target discipline: every committed attacker on team T names T's ONE
 * legal target — the enemy's home site that round (`record.homeSites`). This replaces the
 * old whole-squad-one-site memo assertion, and it is the property that lets a round's
 * pressure evidence be attributed at all.
 */
if (!ABSENT && rounds.length > 0) {
  const violations = [];
  for (const r of rounds) {
    for (const team of [0, 1]) {
      const target = r.homeSites[team === 0 ? 1 : 0];
      const namedT = r.namedSites[team];
      if (namedT.some((s) => s !== target)) {
        violations.push(`round ${r.round}: team ${team} committed to ${namedT.join('+')}, target is ${target}`);
      }
    }
  }
  const committedRounds = rounds.filter((r) => r.namedSites[0].length > 0 || r.namedSites[1].length > 0);
  if (violations.length === 0 && committedRounds.length > 0) {
    ok(`in all ${committedRounds.length} rounds with committed attackers, every committed bot named its team's one legal target`);
  } else if (committedRounds.length === 0) {
    bad('the sample contains committed-attacker evidence',
      `not one bot ever held a carry/planting/escort role across ${rounds.length} rounds, on a tree that HAS the objective layer`);
  } else {
    bad('every committed attacker names its team\'s one legal target site',
      `${violations.length} violations, e.g. ${violations[0]} — the pressure evidence cannot attribute rounds to sites`);
  }
}

// §13.9.3 plant-rate gate, retained unchanged — a hard failure, it is our code's job.
const plantRate = rounds.length ? planted.length / rounds.length : 0;
console.log(`  plant rate ${(plantRate * 100).toFixed(1)}% (${planted.length}/${rounds.length} rounds reached a completed plant)`);
if (rounds.length === 0 || ABSENT) {
  // already reported above; do not also assert a rate over nothing
} else if (plantRate >= PLANT_RATE_MIN) {
  ok(`bots plant often enough for the win rates to be about the sites (≥ ${(PLANT_RATE_MIN * 100).toFixed(0)}%)`);
} else {
  bad('bots plant often enough for the win rates to be about the sites',
    `${(plantRate * 100).toFixed(1)}% < ${(PLANT_RATE_MIN * 100).toFixed(0)}% — with plants this rare the rounds are decided by the round clock and elimination, so the numbers below measure the timer, not the sites`);
}

// §13.9.3 draw rate — new. Printed always; above 20% it is escalated: a symmetric mode
// that mostly times out is a mode where nobody can convert possession.
const drawRate = rounds.length ? draws.length / rounds.length : 0;
console.log(`  draw rate ${(drawRate * 100).toFixed(1)}% (${draws.length}/${rounds.length} rounds ended ${draws.length ? `drawn — reasons: ${[...new Set(draws.map((r) => r.reason))].join(', ')}` : 'drawn'})`);
if (!ABSENT && rounds.length > 0) {
  if (drawRate <= DRAW_RATE_MAX) {
    ok(`the draw rate is at or under ${(DRAW_RATE_MAX * 100).toFixed(0)}%`);
  } else {
    pending(`the draw rate is at or under ${(DRAW_RATE_MAX * 100).toFixed(0)}%`,
      `${(drawRate * 100).toFixed(1)}% of rounds ended drawn — nobody converts possession into a plant or a wipe often enough`);
  }
}

/**
 * Everything §C needs in order to be a measurement rather than a decoration. §2's old
 * promise stands: the distribution is gated BEFORE it is reported, and a number known to
 * be meaningless is not improved by printing it with a caveat.
 */
const blockers = [];
if (rounds.length === 0) blockers.push('the sample contains no rounds');
if (ABSENT) blockers.push('the bots\' Bomb objective layer is not present in this tree, so no round is attributed to a site');
if (!CAPABLE && !ABSENT) blockers.push('the children disagree about whether the objective layer exists');
if (siteIds.length !== 2) blockers.push(`the map declares ${siteIds.length} bomb site(s); symmetric demolition needs exactly 2`);
if (!ABSENT && rounds.length > 0 && plantRate < PLANT_RATE_MIN) {
  blockers.push(`the plant rate ${(plantRate * 100).toFixed(1)}% is under the ${(PLANT_RATE_MIN * 100).toFixed(0)}% floor,`
    + ' so the rounds were decided by the clock and elimination rather than by the sites');
}

// ── C. the §13.9 distribution ────────────────────────────────────────────────────────
console.log('');
if (blockers.length > 0) {
  console.log('  no home-defense or first-possession rate is reported — the gates above say it would not be a measurement:');
  for (const b of blockers) console.log(`     · ${b}`);
} else {
  // §13.9.2 first-possession share — 50±5% for team 0, over the FULL sample (draws
  // included: who reached the bomb first is a fact of every round that had a pickup).
  const picked = rounds.filter((r) => r.firstPickupTeam === 0 || r.firstPickupTeam === 1);
  const neverPicked = rounds.length - picked.length;
  const team0First = picked.filter((r) => r.firstPickupTeam === 0).length;
  console.log(`  first possession: team 0 took first pickup in ${team0First}/${picked.length} rounds`
    + `${neverPicked ? ` (${neverPicked} rounds nobody ever picked the bomb up)` : ''}`);
  if (picked.length === 0) {
    bad('the bomb gets picked up', 'not one pickup in the whole sample, on a tree that HAS the objective layer');
  } else {
    if (neverPicked > rounds.length * 0.05) {
      bad('the neutral bomb is contested in (nearly) every round',
        `${neverPicked}/${rounds.length} rounds ended with the bomb never picked up — the contest layer is not reaching it`);
    }
    bandVerdict('team 0 first-possession share', team0First, picked.length, POSSESS_LO, POSSESS_HI,
      (p) => p < POSSESS_LO ? 'team 1 reaches the neutral bomb first too often — the spawn-to-bomb routes are asymmetric'
        : 'team 0 reaches the neutral bomb first too often — the spawn-to-bomb routes are asymmetric');
  }

  // §13.9.1 home-defense win rate per site, over DECIDED attributed rounds.
  console.log('');
  console.log('  home-defense win rate per site (§13.9.1: 45–55%)');
  const attributed = decided.map((r) => ({ r, site: attributeRound(r) }));
  const unattributed = attributed.filter((a) => a.site === null).length;
  if (unattributed > 0) {
    note(`${unattributed}/${decided.length} decided rounds attributed to neither site (no plant, no committed-attacker majority) — excluded from the per-site denominators`);
  }
  const perSite = [];
  for (const site of siteIds) {
    const rs = attributed.filter((a) => a.site === site);
    const ownerWins = rs.filter(({ r }) => {
      const owner = r.homeSites[0] === site ? 0 : r.homeSites[1] === site ? 1 : -1;
      return owner !== -1 && r.winnerTeam === owner;
    }).length;
    const n = rs.length;
    const p = n ? ownerWins / n : 0;
    const ci = wilson(ownerWins, n);
    const sitePlants = rs.filter(({ r }) => r.planted).length;
    perSite.push({ site, n, ownerWins, p, ci });
    console.log(`     site ${site}: defense ${(p * 100).toFixed(1)}%  attack ${((1 - p) * 100).toFixed(1)}%`
      + `   (${ownerWins}/${n} decided rounds won by ${site}'s owner, 95% CI ${(ci.lo * 100).toFixed(1)}–${(ci.hi * 100).toFixed(1)}%,`
      + ` ${sitePlants} planted)`);
  }

  const emptySites = perSite.filter((s) => s.n === 0);
  if (emptySites.length === 0) ok('every declared site had decided rounds attributed to it');
  else bad('every declared site was fought over', `${emptySites.map((s) => s.site).join(', ')} drew 0 attributed rounds — a band check over 0 rounds passes vacuously`);

  for (const s of perSite) {
    if (s.n === 0) continue;
    bandVerdict(`site ${s.site} home-defense win rate`, s.ownerWins, s.n, BAND_LO, BAND_HI,
      (p) => p < BAND_LO ? `${s.site} cannot be held by its owner` : `${s.site} cannot be broken by its attackers`);
  }

  // Symmetry between the two sites is a separate question from either site's own band:
  // both at 44% is an everyone-attacks-too-well problem; 44% and 56% is one broken site.
  if (perSite.length === 2 && perSite[0].n > 0 && perSite[1].n > 0) {
    const gap = Math.abs(perSite[0].p - perSite[1].p);
    console.log(`  A/B asymmetry ${(gap * 100).toFixed(1)} points`);
    if (gap <= 0.10) ok(`the two sites' defense rates are within 10 points of each other`);
    else pending('the two sites\' defense rates are within 10 points of each other', `${(gap * 100).toFixed(1)} points apart`);
  }
}

// ── D. replay identity ───────────────────────────────────────────────────────────────
//
// Two matches at the same seed must produce the same ordered round outcomes — including
// first possession, which is new in the signature: a contested same-tick pickup resolves
// nearest-then-lowest-id (§13.12.14) and must replay identically.
console.log('');
{
  const a = await runChild(seeds[0]);
  const b = await runChild(seeds[0]);
  if (a.ok !== true || b.ok !== true) {
    bad('the replay pair ran', (a.ok !== true ? a.error : b.error));
  } else if (typeof a.signature !== 'string' || a.signature.length === 0) {
    bad('the replay pair produced round records to compare', `seed ${seeds[0]} produced none`);
  } else if (a.signature === b.signature) {
    ok(`two runs at seed ${seeds[0]} produced an identical ${a.rounds.length}-round outcome sequence (winners, plants, first possession)`);
  } else {
    const xs = a.signature.split('|');
    const ys = (b.signature ?? '').split('|');
    let at = 'length only';
    for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
      if (xs[i] !== ys[i]) { at = `round ${i + 1}: '${xs[i]}' vs '${ys[i]}'`; break; }
    }
    bad('two runs at the same seed produce an identical round outcome sequence', at);
  }
}

console.log(`\n  ${MATCHES} matches in ${wall.toFixed(0)} s wall (${JOBS} concurrent), ${rounds.length} rounds`);
if (MATCHES < 200) {
  note(`§13.9 asks for ≥200 matches; this run used ${MATCHES}. The band verdicts above are marked INCONCLUSIVE where the sample cannot settle them.`);
}
console.log(failures ? `\n${failures} FAILED` : '\nsite outcome report complete');
process.exit(failures ? 1 : 0);
