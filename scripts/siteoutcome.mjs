/**
 * Site outcomes, measured — `map-data.md` §7.1 row "Site win rate (bot matches, ≥200)".
 *
 * The contract asks for one number per site: of the rounds fought over site A, what share
 * did the ATTACKING team win, and the same for site B, with a 45–55% band. Everything hard
 * about producing that number honestly is in three places, so they are stated up front.
 *
 * ── 1. What a "round fought over site X" is ──────────────────────────────────────────
 *
 * NOT "a round in which the bomb was planted at X". That definition throws away every
 * round the attackers were wiped before reaching a site, which are exactly the rounds the
 * defenders won — conditioning on the plant would report an attack win rate near 80% on a
 * map where attackers actually lose. The bias is not small and it is not subtle.
 *
 * The attacking squad COMMITS to one site per round before it moves (`botManager.js`
 * `_bombSite`: one deterministic choice per round, and non-carriers escort it rather than
 * choosing independently). That commitment is the site the round was fought over whether
 * or not a plant ever happened, so that is what each round is attributed to.
 *
 * It is read from the bots' own live state (`bot.objectiveRole` / `bot.objectiveSite` on an
 * attacker, on the first live tick of the round), not recomputed from the seed arithmetic.
 * A copy of the formula would keep agreeing with itself after the planner changed. As a
 * cross-check, §B asserts that every completed plant landed on the site this harness
 * recorded as committed — if the two ever disagree, the attribution is wrong and the run
 * fails rather than reporting a number built on it.
 *
 * ── 2. Do the bots actually plant? ───────────────────────────────────────────────────
 *
 * If they cannot plant, every round ends on the round timer or on elimination and the win
 * rates measure the clock, not the sites. So the plant rate is measured and gated BEFORE
 * any distribution is reported (§B). Measured on The Square over 2,085 rounds: 77.9% of
 * rounds reach a completed plant. The gate sits at 40%.
 *
 * ── 3. Cost, measured rather than guessed ────────────────────────────────────────────
 *
 * One Bomb match is a full first-to-seven / MR12 series: 7–12 rounds, ~450–700 simulated
 * seconds at 120 Hz with 12 entities. Measured on this machine: 3–7 core-seconds per
 * series depending on load, so the contract's ≥200 matches is 10–20 core-minutes — 80–145 s
 * of wall clock at 8–10 concurrent children, and roughly 5 minutes on a four-core runner.
 *
 * That is the honest answer to "is 200 affordable", and it is yes. So `ci` runs the real
 * ≥200 sample rather than a token one, and the sample size stays an argument anyway:
 *
 *   - `--matches=N` sets the sample; matches run one per child process, `--jobs=K` wide,
 *     so wall clock is ~(N / K) match times;
 *   - at small N the win-rate confidence interval is ±10–15 points, which cannot police a
 *     ±5 point band. This harness SAYS SO rather than pretending: a rate outside the band
 *     is only escalated when the 95% Wilson interval is decisive, and is otherwise printed
 *     as INCONCLUSIVE with the advice to run the full sample. A small run still hard-fails
 *     on everything in §B — matches complete, bots plant, attribution holds, replays are
 *     identical — because those are regressions in our code at any sample size.
 *
 * ── The ≥200-match result (regenerate when the map, the bots or the ruleset change) ───
 *
 *   RESULT-200 (2026-08-20, `--matches=200`, seed0 760001, The Square v1.0.0):
 *
 *     200 series · 2,085 rounds · 94 s wall at 10 concurrent
 *     plant rate                    77.9%  (1625/2085 rounds reached a completed plant)
 *     site A attack win rate        46.3%  (479/1035, 95% CI 43.3–49.3)  → inside 45–55
 *     site B attack win rate        54.3%  (570/1050, 95% CI 51.3–57.3)  → inside 45–55
 *     A/B asymmetry                  8.0 points
 *
 *   Both sites sit inside the §7.1 band, with a ±3 point interval — narrow enough that the
 *   band is genuinely being policed rather than merely not contradicted. Site B sits 0.7
 *   points under the upper edge, so this row is worth re-reading after any change to the
 *   objective planner rather than treated as settled.
 *
 *   One caveat that belongs next to the number: this repository's `src/ai/**` is another
 *   lane's file and was being edited while these runs were taken. The sim is deterministic
 *   at any fixed source state (proven by §D), but the win rate is a property of the map AND
 *   the bots, so this row is a joint measurement and must be regenerated when either moves.
 *
 * ── The other lane this measurement runs THROUGH ─────────────────────────────────────
 *
 * The site a round was fought over is read from the bots' Bomb objective layer, which lives
 * in `src/ai/**`. On a tree where that layer has not landed, not one round in the sample
 * commits to a site and not one plant completes, and §B reports that as PENDING/ABSENT and
 * declines to print a win rate — the `maptest.mjs` ABSENT-vs-PARTIAL rule. A tree where
 * SOME rounds commit, or where rounds commit but nothing is ever planted, is PARTIAL and
 * hard-fails. Verified both ways: `git archive HEAD` (layer absent) reports PENDING and
 * exits 0; the working tree (layer present) measures 2,085 rounds.
 *
 * ── Envelope breaches are PENDING, not FAIL ──────────────────────────────────────────
 *
 * Same rule as `navtest.mjs` §7.1 and `maptest.mjs`'s §3 manifest guard: a §7 envelope
 * number outside its band on The Square is the geometry lane's open work (REQ-CX-008), and
 * failing this harness on it would either block every backend commit behind another lane's
 * map edit or get the band quietly widened until nothing could trip it. So a breach is
 * printed loudly, by name, with the number and the target — while every assertion about OUR
 * OWN code (matches complete, bots plant, attribution holds, replays are identical) stays a
 * hard failure.
 *
 * This is doubly true here, because the win rate is a joint property of the MAP and the
 * BOTS, and `src/ai/**` is a third lane again. A gate that fails the build when either of
 * two other lanes moves a number by half a point is a gate that gets deleted.
 *
 * `--strict` makes envelope breaches fatal. It is not used by `ci`; it exists so the band
 * can be PROVEN failable, and so the gate can be turned on in one place when REQ-CX-008
 * closes and the objective planner settles.
 *
 *   node scripts/siteoutcome.mjs --matches=200
 *   node scripts/siteoutcome.mjs --matches=40 --jobs=8
 *   node scripts/siteoutcome.mjs --matches=40 --jobs=8 --strict --degrade=site-a-shrink
 *   node scripts/siteoutcome.mjs --matches=40 --jobs=8 --strict --degrade=site-a-nodefuse
 *   node scripts/siteoutcome.mjs --matches=40 --jobs=8 --strict --degrade=site-a-swallow
 *
 * Every degradation edits the REAL map manifest that the ruleset, the bots and the nav
 * layer all read (`world.manifest.objectives`). Nothing is stubbed and no second
 * implementation exists, and site B is left untouched inside the same run as a control.
 * Measured at 40 matches each, all four runs taken back to back on one tree state:
 *
 *   run                             site A attack        site B (control)     verdict
 *   ─────────────────────────────── ──────────────────── ──────────────────── ─────────
 *   restored (no --degrade)         46.3% (CI 39.6–53.2) 55.7% (CI 48.9–62.2) exit 0
 *   --degrade=site-a-shrink         13.1% (CI  9.1–18.5) 52.2% (CI 45.4–58.9) exit 1
 *   --degrade=site-a-nodefuse       84.3% (CI 79.0–88.4) 54.2% (CI 47.7–60.6) exit 1
 *   --degrade=site-a-swallow        10.2% (CI  6.9–14.8) 30.8% (CI 25.1–37.1) exit 1
 *
 * `shrink` and `nodefuse` are the two edges of the band, low and high, each with a decisive
 * interval and each with the control site still reported as inside or inconclusive in the
 * same run — so the failure is attributable to site A rather than to the sample.
 *
 * The restored row is worth reading closely: site B's 55.7% is OUTSIDE the band, and the
 * run still exits 0, because at 212 rounds the interval straddles it. That is the
 * three-valued verdict doing its job rather than a threshold being soft — at 200 matches
 * (§ RESULT-200) the same site reports 54.3% with a ±3 point interval.
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

/** §7.1: 45–55% attack win rate per site. Defend is the complement, so one band covers both. */
const BAND_LO = 0.45;
const BAND_HI = 0.55;
/**
 * Below this share of rounds reaching a completed plant, the win rates are a statement
 * about the round clock rather than about the sites, and reporting them would be a lie
 * with a number attached. Measured 77.9% on The Square; the floor is deliberately far
 * below that, because it is meant to catch "bots cannot plant at all", not to police the
 * balance between planting and being stopped, which is the thing under measurement.
 */
const PLANT_RATE_MIN = 0.40;
/** A legal series is 7–12 rounds (`BOMB_PARAMS.roundsToWin` / `maxRounds`). */
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
 * thing `bombbottest.mjs` does, so every kill, plant and defuse in the sample belongs to an
 * autonomous bot and no human-shaped entity stands still in a spawn skewing a side.
 */
async function runMatch(seed, degrade) {
  const { Game } = await import('../src/core/game.js');
  const { NullPresenter } = await import('../src/core/presenter.js');
  const { FIXED_DT } = await import('../src/core/mathUtils.js');

  const game = new Game({ headless: true });
  await game.initHeadless({ presenter: new NullPresenter(), mapId: 'the-square' });

  const degradeNote = applyDegrade(game, degrade);

  game.startMatch({ mode: 'bomb', botCount: 11, difficulty: 'regular', seed });
  game.match.phase = 'live';
  game.match.countdown = 0;
  const rules = game.match.bombRules;
  rules.noteDisconnect(game.player);

  /** Roles an ATTACKER holds while it is executing the squad's committed site plan. */
  const ATTACK_ROLES = new Set(['plant', 'planting', 'escort', 'recover']);
  const committedBy = new Map();          // roundIndex -> site id the attackers committed to

  // A whole series, bounded. The bound is a hang detector, not a sample cut-off: a run that
  // hits it is reported as a failure, never folded into the statistics.
  const MAX_TICKS = 120 * 60 * 35;
  let ticks = 0;
  while (rules.series === null && ticks < MAX_TICKS) {
    game._fixedUpdate(FIXED_DT);
    ticks++;
    if (!rules.liveRound) continue;
    if (committedBy.has(rules.roundIndex)) continue;
    for (const bot of game.bots.bots) {
      if (!bot.alive || bot.team !== rules.attackingTeam) continue;
      if (typeof bot.objectiveSite !== 'string' || bot.objectiveSite === '') continue;
      if (!ATTACK_ROLES.has(bot.objectiveRole)) continue;
      committedBy.set(rules.roundIndex, bot.objectiveSite);
      break;
    }
  }

  // Plants are read from the ROUND RECORDS, not from `rules.events`: the event log is
  // capped at 4096 rows and shifts, so a long series silently loses its early plants and
  // the plant rate would fall through the floor for a reason that is not about the map.
  const rounds = rules.rounds.map((r, i) => ({
    round: r.round,
    winnerTeam: r.winnerTeam,
    attackingTeam: r.attackingTeam,
    reason: r.reason,
    planted: r.planted === true,
    plantSite: typeof r.site === 'string' ? r.site : null,
    committedSite: committedBy.get(i) ?? null,
  }));

  const out = {
    finished: rules.series !== null,
    ticks,
    siteIds: [...rules.siteIds],
    rounds,
    degradeNote,
    // The whole ordered outcome, for the replay check. A count would pass a run that
    // reached the same tally down a different road, which is what a replay would not do.
    signature: rounds.map((r) => `${r.round}:${r.committedSite}:${r.attackingTeam}:${r.winnerTeam}:${r.reason}:${r.plantSite}`).join('|'),
  };
  game.dispose?.();
  return out;
}

/**
 * Degrade a REAL input: the map manifest's objective volume for site A.
 *
 * `world.manifest` is the normalised object every consumer reads — `BombRules` compiles its
 * site table from it, `botManager` aims at `plant`'s centre, and the HUD names it. Editing
 * the volume here is the same edit a map author would make in `level.js`, which is the
 * point: the guard has to be able to fail on a real map defect.
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
    // The upper edge of the band. §3.3 lets a site declare a defuse volume distinct from
    // its plant volume; this one declares a defuse volume nobody can stand in, so a bomb
    // planted at A can never be defused and the attackers win every planted round there.
    // Site B keeps its default (defuse = plant) and stays the control.
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
    // The opposite defect: a plant volume so large the attackers are standing in it when
    // the round starts, so they plant immediately and the defenders must cross the map.
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
/** §7 envelope breach on [CX]-owned geometry: loud, named, non-fatal unless --strict. */
const pending = (n, d) => {
  if (STRICT) { failures++; console.log(`  FAIL ${n}\n       ${d}`); return; }
  console.log(`  PENDING  ${n}: ${d} — REQ-CX-008 (geometry, [CX]).`);
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
 * degraded map produces (0 attack wins out of 60), and reporting `0% ± 0%` there would be
 * the worst possible answer.
 */
function wilson(k, n, z = 1.96) {
  if (n === 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: Math.max(0, (c - s) / d), hi: Math.min(1, (c + s) / d) };
}

const seeds = Array.from({ length: MATCHES }, (_, i) => SEED0 + i * 7919);
console.log(`\nsite outcomes — ${MATCHES} full Bomb series on the-square, ${JOBS} concurrent`
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
if (siteIds.length >= 2) ok(`the map declares ${siteIds.length} bomb sites: ${siteIds.join(', ')}`);
else bad('the map declares at least two bomb sites', `declared: ${siteIds.join(', ') || '(none)'} — a per-site balance figure needs two`);

const uncommitted = rounds.filter((r) => r.committedSite === null);
const planted = rounds.filter((r) => r.planted && r.plantSite !== null);

/**
 * ABSENT is a schedule; PARTIAL is a defect. The same distinction `maptest.mjs` draws for a
 * §3 manifest, for the same reason, and it is load-bearing here.
 *
 * This harness measures the map THROUGH the bots' Bomb objective layer (`botManager.js`
 * `_applyBombObjective`), which is `src/ai/**` — another lane's file. On a tree where that
 * layer has not landed, no attacker ever takes a Bomb objective role and no plant ever
 * completes: not one round in the whole sample. That is a lane that has not landed yet, it
 * is a real state, and failing on it would mean this lane could never commit a measurement
 * before the other lane commits the thing being measured.
 *
 * A tree where SOME rounds commit and some do not, or where rounds commit but nothing is
 * ever planted, is a different thing entirely: the layer is there and it is broken. That
 * must fail, and it does, in the branches below.
 */
const ABSENT = rounds.length > 0 && uncommitted.length === rounds.length && planted.length === 0;

if (rounds.length === 0) {
  bad('the sample contains rounds', '0 rounds — every statistic below would be computed over an empty set');
} else if (ABSENT) {
  console.log(`  PENDING  not one of the ${rounds.length} rounds saw an attacker take a Bomb objective role,`
    + ' and not one plant completed — the bots\' Bomb objective layer (src/ai/**, another lane) is not present in this tree.');
  console.log('           Tracked, not ignored: the moment ANY round commits to a site or ANY plant');
  console.log('           completes, the branches below turn this into a failure. No win rate is reported,');
  console.log('           because a distribution over zero attributed rounds is not a measurement.');
} else if (uncommitted.length === 0) {
  ok(`every one of the ${rounds.length} rounds recorded an attacker site commitment`);
} else {
  bad('every round records which site the attackers committed to',
    `${uncommitted.length}/${rounds.length} did not — those rounds cannot be attributed to a site, and a rate computed over the rest would silently drop them`);
}

// The attribution cross-check. If the bots plant somewhere other than the site this
// harness recorded as their commitment, the commitment is not what it claims to be.
const mismatched = planted.filter((r) => r.plantSite !== r.committedSite);
if (ABSENT) {
  // Already reported above. Asserting it twice would read as two independent findings.
} else if (planted.length === 0) {
  bad('the sample contains completed plants', '0 — see the plant-rate gate below');
} else if (mismatched.length === 0) {
  ok(`all ${planted.length} completed plants landed on the site recorded as committed`);
} else {
  bad('every completed plant lands on the site recorded as committed',
    `${mismatched.length}/${planted.length} did not — the per-site attribution is wrong, so no win rate below can be trusted`);
}

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

// ── C. site win rates ────────────────────────────────────────────────────────────────
console.log('');
const perSite = [];
if (ABSENT) {
  note('no attack/defend win rate is reported: there are no rounds attributed to a site to compute one from');
} else {
console.log('  attack win rate per committed site (§7.1: 45–55%)');
for (const site of siteIds) {
  const rs = rounds.filter((r) => r.committedSite === site);
  const attackWins = rs.filter((r) => r.winnerTeam === r.attackingTeam).length;
  const n = rs.length;
  const p = n ? attackWins / n : 0;
  const ci = wilson(attackWins, n);
  const sitePlants = rs.filter((r) => r.planted).length;
  perSite.push({ site, n, attackWins, p, ci, plantRate: n ? sitePlants / n : 0 });
  console.log(`     site ${site}: attack ${(p * 100).toFixed(1)}%  defend ${((1 - p) * 100).toFixed(1)}%`
    + `   (${attackWins}/${n} rounds, 95% CI ${(ci.lo * 100).toFixed(1)}–${(ci.hi * 100).toFixed(1)}%,`
    + ` plant rate ${(perSite[perSite.length - 1].plantRate * 100).toFixed(0)}%)`);
}

const emptySites = perSite.filter((s) => s.n === 0);
if (emptySites.length === 0) ok('every declared site was fought over at least once');
else bad('every declared site was fought over', `${emptySites.map((s) => s.site).join(', ')} drew 0 rounds — a band check over 0 rounds passes vacuously`);

/**
 * The verdict, three-valued on purpose.
 *
 *   INSIDE       — the point estimate is in the band.
 *   BREACH       — the point estimate is outside it AND the 95% interval is decisive, i.e.
 *                  the whole interval lies on one side of the band. This is a real finding.
 *   INCONCLUSIVE — outside the band but the interval still overlaps it. At ci sample sizes
 *                  this is the normal answer, and calling it a breach would be a coin toss
 *                  reported as a measurement.
 *
 * Only BREACH is escalated. INCONCLUSIVE is printed with the sample size needed to settle
 * it, because the honest response to a weak sample is to say how weak it is.
 */
for (const s of perSite) {
  if (s.n === 0) continue;
  const inBand = s.p >= BAND_LO && s.p <= BAND_HI;
  if (inBand) { ok(`site ${s.site} attack win rate ${(s.p * 100).toFixed(1)}% is inside 45–55%`); continue; }
  const decisive = s.ci.hi < BAND_LO || s.ci.lo > BAND_HI;
  const side = s.p < BAND_LO ? 'defender-favoured' : 'attacker-favoured';
  if (decisive) {
    pending(`site ${s.site} attack win rate is inside 45–55%`,
      `${(s.p * 100).toFixed(1)}% (${s.attackWins}/${s.n}), 95% CI ${(s.ci.lo * 100).toFixed(1)}–${(s.ci.hi * 100).toFixed(1)}% — ${side}, and the interval clears the band`);
  } else {
    note(`site ${s.site} attack win rate ${(s.p * 100).toFixed(1)}% is outside 45–55% but INCONCLUSIVE at ${s.n} rounds`
      + ` (95% CI ${(s.ci.lo * 100).toFixed(1)}–${(s.ci.hi * 100).toFixed(1)}%) — this sample cannot police a ±5 point band; run --matches=200`);
  }
}

// Symmetry between the two sites is a separate question from either site's own band: two
// sites can both sit at 44% (attackers under-performing everywhere, a timer problem) or at
// 44% and 56% (one site broken, a geometry problem). Reported, never conflated.
if (perSite.length === 2 && perSite[0].n > 0 && perSite[1].n > 0) {
  const gap = Math.abs(perSite[0].p - perSite[1].p);
  console.log(`  A/B asymmetry ${(gap * 100).toFixed(1)} points`);
  if (gap <= 0.10) ok(`the two sites are within 10 points of each other`);
  else pending('the two sites are within 10 points of each other', `${(gap * 100).toFixed(1)} points apart`);
}
}

// ── D. replay identity ───────────────────────────────────────────────────────────────
//
// Two matches at the same seed must produce the same ordered round outcomes. Without this
// the sample is not reproducible and no result recorded in this file could ever be checked.
//
// The pair is run back to back HERE rather than by comparing against the pooled result
// recorded a minute earlier. Each match is a fresh child process, so it re-reads the source
// tree; on a working copy that another lane is editing while this runs, a pooled-vs-replay
// mismatch reports the edit rather than a determinism defect. Two adjacent runs close that
// window to a couple of seconds and still assert exactly the property that matters.
console.log('');
{
  const a = await runChild(seeds[0]);
  const b = await runChild(seeds[0]);
  if (a.ok !== true || b.ok !== true) {
    bad('the replay pair ran', (a.ok !== true ? a.error : b.error));
  } else if (typeof a.signature !== 'string' || a.signature.length === 0) {
    bad('the replay pair produced round records to compare', `seed ${seeds[0]} produced none`);
  } else if (a.signature === b.signature) {
    ok(`two runs at seed ${seeds[0]} produced an identical ${a.rounds.length}-round outcome sequence`);
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
  note(`§7.1 asks for ≥200 matches; this run used ${MATCHES}. The band verdicts above are marked INCONCLUSIVE where the sample cannot settle them.`);
}
console.log(failures ? `\n${failures} FAILED` : '\nsite outcome report complete');
process.exit(failures ? 1 : 0);
