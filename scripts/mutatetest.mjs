/**
 * Mutation testing for the platform control plane.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────
 * `platformtest.mjs` reports "1276 checks across 8 suites, 0 failing", and the suites are
 * unusually honest prose — nearly every check says in words why it exists. What none of them
 * has is a mechanism that fails when a guard stops guarding. A green suite proves the code
 * PASSES its tests; it does not prove the tests would notice the code being wrong.
 *
 * An adversarial review measured the gap by hand. It deleted, one at a time, each of the 253
 * single-line guards in `platform/src/**` and re-ran the suite. **146 of 253 deletions — 58% —
 * left the suite fully green.** For those 146 lines, the tests assert nothing about the
 * condition being checked; the line could be removed in a refactor and CI would applaud.
 *
 * Two of the survivors are not stylistic:
 *
 *   - the DEPLOYED consent gate in the telemetry path. Delete its line and the platform
 *     accepts personal-class telemetry from a player who explicitly DECLINED — the entire
 *     point of contracts/telemetry.md §3.4 — and the suite still reports 0 failing.
 *   - date-of-birth validation in the age-gate. Delete its line and `"banana"` yields
 *     `eligible: true` **plus a signed receipt**, and the suite still reports 0 failing.
 *
 * (Those are the review's findings, not this file's. One of the two has since been fixed and
 * one has not — see "What this harness measured" below, which is the point: the standing
 * number is whatever the harness prints today, never what a document remembers.)
 *
 * A survivor is therefore not a style note. It is a precise, located, actionable statement:
 * *this specific guard is unguarded, and here is the file and line*. That is worth having as a
 * button rather than as a one-off sweep someone did once and threw away, which is what this is.
 *
 * ── The mutation operator (deliberately small) ───────────────────────────────────────────
 * This is NOT a general-purpose AST mutator. There is exactly one operator: **delete an
 * early-exit guard**. A guard is
 *
 *   - a single line `if (COND) throw/return/continue/break ...;`
 *   - a single line `if (COND) <one call>;`  — the `if (!ok) bad('...')` / `problems.push(...)`
 *     form, which is an early exit wearing a helper's name
 *   - a single line `if (COND) { <early exit>; }`
 *   - a compact multi-line `if (COND) {` … `}` (up to 12 lines) whose body ENDS the flow with a
 *     throw/return/continue/break and which is not followed by `else`. The whole guard is the
 *     mutation. Requiring the body to be a BARE exit was the first version of this file and it
 *     was wrong: it scored `if (dedupe.has(id)) { stats.duplicates++; return ...; }` as not a
 *     guard, which skipped both real guards in `consumer.js` and kept two trivial ones.
 *
 * Assignments (`if (!list) list = []`) are excluded: deleting one is not "a guard stopped
 * guarding", it is a crash, and a crash the suite catches teaches nothing.
 *
 * Every mutant is syntax-checked before it is run. An unparseable mutant would fail the suite
 * and be scored KILLED, which would silently inflate the kill rate — the single easiest way to
 * make a mutation harness lie. Those are reported as INVALID and excluded from the ratio.
 *
 * ── Isolation ────────────────────────────────────────────────────────────────────────────
 * Two AI lanes edit this repository concurrently. A mutation harness that edited the real
 * working tree would corrupt the other lane's in-flight work, and a crashed run would leave a
 * deleted guard behind in a source file. So each worker gets its own full copy of the tree in
 * the scratchpad, and the real tree is only ever READ.
 *
 * ── What this harness measured on its first run ──────────────────────────────────────────
 * Whole tree, at commit fcd7341 (platformtest: 1368 checks, 9 suites, green), 8 workers:
 *
 *   679 mutants · 314 killed · **365 SURVIVED (54%)** · 15m36s wall clock
 *
 * The operator here is broader than the review's — it also takes the multi-line block form and
 * the `if (!ok) bad(...)` form — so the denominator is 679 rather than 253. The RATE agrees:
 * 54% here against 58% by hand.
 *
 * Of the review's two named defects, ONE still reproduces and one does not, which is the whole
 * argument for running this rather than citing it:
 *
 *   - STILL OPEN. `auth/service.js:46`, the `^\d{4}-\d{2}-\d{2}$` check behind the age gate,
 *     survives — and so does the line below it that rejects an impossible calendar date. Those
 *     two lines are the whole of what stands between `"banana"` and a signed eligibility
 *     receipt, and nothing in 1368 checks notices either of them going away.
 *   - CLOSED. `telemetry/service.js:108`, the §3.4 personal-class consent gate, is now KILLED.
 *     A test landed for it between the review and this file. The neighbouring subject-binding
 *     checks in `telemetry/consent.js` (lines 86-91) still survive, so the receipt-is-a-bearer-
 *     token hole the module header warns about is untested even though the gate above it is not.
 *
 * Worst three files, all in the store layer:
 *
 *   core/store/postgres.js  37/41    core/store.js  34/81    core/store/memory.js  33/61
 *
 * `postgres.js` deserves an asterisk and it is the same asterisk `pgtest.mjs` is about: the
 * suite runs the MEMORY adapter unless `DATABASE_URL` is set, so 37 of those 41 guards are not
 * so much untested as unreached. Sweep them honestly with
 *
 *   DATABASE_URL=... PLATFORM_STORAGE=postgres node scripts/mutatetest.mjs --file=platform/src/core/store
 *
 * ── Thresholds ───────────────────────────────────────────────────────────────────────────
 * `--max-survivors=N` exits non-zero above N, so this can gate CI later. It is deliberately
 * NOT wired into `npm run ci` or the GitHub workflow today: at 365 survivors the gate would be
 * permanently red, and a permanently red gate is a gate everyone learns to ignore.
 *
 *   current:  365 survivors of 679 mutants across platform/src/** (54% survival, fcd7341)
 *   target:   0 survivors in platform/src/modules/events/** and the telemetry consent path
 *             first (those are the ones with a user-visible privacy failure behind them),
 *             then a whole-tree ceiling ratcheted DOWNWARD as tests are added — set
 *             --max-survivors to whatever today's number is, and never let it rise.
 *
 * A number here is only meaningful with the tree it was measured on. The working tree moved
 * while this file was being written — another lane landed `platform/test/coretest.mjs` and
 * `core/ratelimit.js` went from 6 survivors of 7 to 1 of 7 in about twenty minutes. Quote the
 * commit with the number, and see `--tree` below.
 *
 * Usage:
 *   node scripts/mutatetest.mjs                              # whole tree: 679 mutants, ~16 min
 *   node scripts/mutatetest.mjs --file=platform/src/core/ratelimit.js
 *   node scripts/mutatetest.mjs --file=platform/src/modules/events   # a directory prefix
 *   node scripts/mutatetest.mjs --budget=20                  # an even 20-mutant sample of the scope
 *   node scripts/mutatetest.mjs --max-survivors=0            # threshold; non-zero exit above it
 *   node scripts/mutatetest.mjs --jobs=8                     # worker count (default cpus-2)
 *   node scripts/mutatetest.mjs --dry-run                    # list mutants, run nothing
 *   node scripts/mutatetest.mjs --keep                       # leave the sandboxes for inspection
 *   node scripts/mutatetest.mjs --tree=DIR                   # sweep another checkout, not this one
 */
import { execFileSync, spawnSync, fork } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdirSync, symlinkSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '..');

const arg = (k, dflt = null) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : dflt;
};
const flag = (k) => process.argv.slice(2).includes(`--${k}`);

/**
 * The tree to sweep. Normally the working tree; `--tree=DIR` points at another checkout.
 *
 * That option is not decoration. The first run of this harness scored `core/ratelimit.js` at
 * 1 survivor of 7 where the review that motivated the file had recorded 4 of 4 — because
 * between the two measurements another lane added `platform/test/coretest.mjs` with fifteen
 * rate-limit assertions. A mutation score is a property of a TREE AT A MOMENT, and without a
 * way to name the moment, a disagreement is unresolvable and you are left guessing whether
 * your harness is wrong or the world moved. `git archive HEAD | tar -x -C dir` and point here.
 */
const ROOT = arg('tree') ? path.resolve(arg('tree')) : REPO;

const SCRATCH = process.env.MUTATETEST_SCRATCH
  || '/private/tmp/claude-501/-Users-jamie-Desktop-Projects-overstrike/2777cdd2-f7f1-4d35-ba6d-3a6389677463/scratchpad';

/** Everything the platform suite reads. `node_modules` is symlinked, not copied (79 MB). */
const COPY = ['platform', 'docs', 'package.json'];
const SUITE = 'scripts/platformtest.mjs';

// ── finding mutants ───────────────────────────────────────────────────────────────────────

/** `bad(...)`, `problems.push(...)`, `fail(...)` — a guard whose exit is spelled as a call. */
const CALL_STMT = /^[A-Za-z_$][\w$.]*\s*\(.*\)\s*;?$/;

const balance = (s) => {
  let d = 0;
  for (const c of s) { if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--; }
  return d;
};

/** Strip the leading `if (...)` from a line, returning the consequent, or null if unbalanced. */
function consequentOf(line) {
  const t = line.trim();
  if (!t.startsWith('if')) return null;
  const open = t.indexOf('(');
  if (open < 0 || t.slice(2, open).trim() !== '') return null;
  let d = 0;
  for (let i = open; i < t.length; i++) {
    if (t[i] === '(') d++;
    else if (t[i] === ')') { d--; if (d === 0) return t.slice(i + 1).trim(); }
  }
  return null;
}

/**
 * True when a block body leaves the enclosing flow.
 *
 * Not "the body IS a throw" but "the body ENDS the flow", because the common shape is a
 * counter or a log line and then the exit:
 *
 *     if (dedupe.has(event.eventId)) { stats.duplicates++; return { status: 'duplicate' }; }
 *
 * Requiring a bare exit missed exactly those — the first version of this file scored
 * consumer.js as 2 mutants, both weak ones, and skipped the two real guards in `deliver`.
 */
const hasEarlyExit = (body) => /(?:^|[;{]\s*)(?:throw|return|continue|break)\b/.test(body);

const isGuardBody = (s) => hasEarlyExit(s) || CALL_STMT.test(s);

/**
 * All deletable guards in one file, as `{ line, endLine, text }` (1-based, inclusive).
 *
 * Block comments are tracked so a guard quoted in prose is not "mutated"; template literals
 * are tracked for the same reason, because deleting a line out of one is perfectly valid
 * syntax and would be scored as a survivor that is really just an edited string.
 */
function guardsIn(file, from) {
  const src = readFileSync(path.join(from, file), 'utf8');
  const lines = src.split('\n');
  const out = [];
  let inBlockComment = false;
  let inTemplate = false;

  const advanceState = (raw) => {
    // Crude but sufficient: this codebase does not put `/*` inside strings.
    let s = raw;
    if (inBlockComment) {
      const end = s.indexOf('*/');
      if (end < 0) return;
      s = s.slice(end + 2);
      inBlockComment = false;
    }
    const open = s.indexOf('/*');
    if (open >= 0 && s.indexOf('*/', open) < 0) { inBlockComment = true; return; }
    const ticks = (s.replace(/\\`/g, '').match(/`/g) || []).length;
    if (ticks % 2 === 1) inTemplate = !inTemplate;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    const skip = inBlockComment || inTemplate || t.startsWith('//') || t.startsWith('*');
    if (skip || !t.startsWith('if')) { advanceState(raw); continue; }

    const cons = consequentOf(raw);
    if (cons === null) { advanceState(raw); continue; }

    // Form 1 & 2 & 3: the whole guard is on this line.
    if (balance(t) === 0 && /[;}]$/.test(t) && cons !== '') {
      const body = cons.startsWith('{') ? cons.slice(1, cons.lastIndexOf('}')).trim() : cons;
      // `if (x) y = 1;` is an initialiser, not a guard. Deleting it is a crash, not a lesson.
      if (isGuardBody(body) && !/^[\w$.[\]]+\s*(?:[-+*/|&^]?=[^=]|\+\+|--)/.test(body)) {
        // A dangling `if (a)` above us means deleting this line re-parents the next statement,
        // and an `else` below us is left with no `if` at all — `envelope.js:143` is exactly
        // that shape. The syntax gate would catch both, but excluding them here keeps the
        // denominator honest: they are not guards this operator can delete.
        if (!danglingAbove(lines, i) && !elseBelow(lines, i)) {
          out.push({ line: i + 1, endLine: i + 1, text: raw });
        }
      }
      advanceState(raw);
      continue;
    }

    // Form 4: `if (COND) {` opening a compact block that ends the flow.
    if (cons === '{' && balance(t) === 1) {
      const close = findClose(lines, i);
      if (close > 0 && close - i <= 12 && !/^\}\s*else/.test(lines[close].trim())
          && !/^else/.test((lines[close + 1] || '').trim())) {
        const body = lines.slice(i + 1, close).map((l) => l.trim()).filter(Boolean).join(' ');
        // `isGuardBody`, not `hasEarlyExit`: envelope.js writes its guards as
        // `if (!isWellNamed(type)) {\n  bad('...', { type });\n}` where `bad` throws. Scoring
        // only bare exits skipped THIRTEEN real guards in that one file.
        if (isGuardBody(body) && !danglingAbove(lines, i)) {
          out.push({ line: i + 1, endLine: close + 1, text: raw });
        }
      }
    }
    advanceState(raw);
  }
  return out;
}

/** Index of the line closing the block opened on `start`, or -1. */
function findClose(lines, start) {
  let d = 0;
  for (let i = start; i < lines.length; i++) {
    d += balance(lines[i]);
    if (i > start && d === 0) return i;
    if (i === start && d === 0) return -1;
  }
  return -1;
}

/** True when the next code line is an `else`, which this guard's `if` owns. */
function elseBelow(lines, i) {
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j].trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    // Bare `else` only. A leading `}` closes some ENCLOSING block, so that `else` belongs to
    // an outer `if`, not to this one-line guard — excluding those cost 3 real mutants.
    return /^else\b/.test(t);
  }
  return false;
}

/** True when the previous code line is an unbraced `if/for/while/else` header. */
function danglingAbove(lines, i) {
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    return /^(?:\}?\s*else|if\s*\(|for\s*\(|while\s*\()/.test(t) && !/[{;]$/.test(t);
  }
  return false;
}

function sourceFiles(from) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir).sort()) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.js')) out.push(path.relative(from, p));
    }
  };
  walk(path.join(from, 'platform', 'src'));
  return out;
}

/** `--file=` accepts a file, a directory, or a comma-separated list of either. */
function selectedFiles(from) {
  const all = sourceFiles(from);
  const sel = arg('file');
  if (!sel) return all;
  const wanted = sel.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const hit = all.filter((f) => wanted.some((w) => f === w || f.startsWith(`${w}/`)));
  if (!hit.length) {
    console.error(`mutatetest: --file=${sel} matched none of the ${all.length} files under platform/src.`);
    process.exit(2);
  }
  return hit;
}

/** The mutant's source: the file with its guard lines removed. */
function mutate(file, m, from) {
  const lines = readFileSync(path.join(from, file), 'utf8').split('\n');
  lines.splice(m.line - 1, m.endLine - m.line + 1);
  return lines.join('\n');
}

// ── sandboxes ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE snapshot of the tree; every worker is a copy of THAT, not a fresh copy of the repo.
 *
 * The first version copied the repo once per worker. Two lanes edit this repository at the
 * same time, so those eight copies were eight different moments — worker 3 could be running a
 * tree the baseline never validated, and a mid-`cp` write produces a torn tree that fails for
 * reasons having nothing to do with the mutant. Copy once, prove THAT copy green, clone it.
 */
function snapshot(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const item of COPY) {
    execFileSync('cp', ['-R', path.join(ROOT, item), path.join(dir, item)]);
  }
  execFileSync('cp', [path.join(ROOT, SUITE), path.join(dir, SUITE)]);
  linkModules(dir);
  return dir;
}

function cloneSandbox(from, dir) {
  rmSync(dir, { recursive: true, force: true });
  execFileSync('cp', ['-R', from, dir]);
  return dir;
}

/** Symlinked, not copied: 79 MB per worker would dominate the run. */
function linkModules(dir) {
  const link = path.join(dir, 'node_modules');
  if (!existsSync(link)) symlinkSync(path.join(REPO, 'node_modules'), link);
}

/**
 * Run the suite in `dir`. Returns `{ ok, checks, failing, timedOut }`.
 *
 * The timeout is derived from the BASELINE's own duration, not a fixed number. Deleting a
 * guard can leave a socket open or a retry loop unbounded, and the suite then hangs rather
 * than fails. With a flat 300 s ceiling, eight workers spent their time sitting in eight
 * hangs: the whole-tree sweep dropped to ~2.4 mutants/minute, a four-HOUR run for work that
 * takes twenty minutes. A hang is a detection anyway — the suite noticed — so it is scored
 * KILLED and cut short at a generous multiple of how long green takes.
 */
function runSuite(dir, timeoutMs = 300_000) {
  const res = spawnSync(process.execPath, [path.join(dir, SUITE)], {
    cwd: dir, encoding: 'utf8', timeout: timeoutMs,
    env: { ...process.env, MUTATETEST_SANDBOX: '1' },
  });
  const m = (res.stdout || '').match(/(\d+) checks across (\d+) suites, (\d+) failing/);
  return {
    ok: res.status === 0,
    checks: m ? Number(m[1]) : -1,
    failing: m ? Number(m[3]) : -1,
    timedOut: res.status === null,
  };
}

// ── worker mode ───────────────────────────────────────────────────────────────────────────

if (arg('worker')) {
  const dir = arg('worker');
  const timeoutMs = Number(arg('timeout', '300000'));
  const originals = new Map();
  process.on('message', (job) => {
    if (job === 'stop') { process.exit(0); }
    const target = path.join(dir, job.file);
    if (!originals.has(job.file)) originals.set(job.file, readFileSync(target, 'utf8'));
    const started = Date.now();
    try {
      writeFileSync(target, job.source);
      const r = runSuite(dir, timeoutMs);
      process.send({ id: job.id, ...r, ms: Date.now() - started });
    } finally {
      writeFileSync(target, originals.get(job.file));
    }
  });
  process.send('ready');
} else {
  await main();
}

// ── driver ────────────────────────────────────────────────────────────────────────────────

async function main() {
  // --dry-run reads the live tree; a real run reads the snapshot, so that the line numbers
  // printed in the report are the line numbers of the code that was actually tested.
  if (flag('dry-run')) {
    const files = selectedFiles(ROOT);
    const found = files.flatMap((f) => guardsIn(f, ROOT).map((g) => ({ file: f, ...g })));
    console.log(`mutatetest: ${found.length} deletable guards across ${files.length} file(s)`);
    for (const g of found) console.log(`  ${g.file}:${g.line}  ${g.text.trim()}`);
    process.exit(0);
  }

  const base = path.join(SCRATCH, `mutatetest-${process.pid}`);
  const jobs = Math.max(1, Number(arg('jobs', '0')) || (os.cpus().length - 2));

  let workers = [];
  const cleanup = () => {
    for (const w of workers) { try { w.kill(); } catch { /* already gone */ } }
    if (!flag('keep')) rmSync(base, { recursive: true, force: true });
    else console.log(`mutatetest: sandboxes kept at ${base}`);
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });

  const t0 = Date.now();
  let code = 0;
  try {
    mkdirSync(base, { recursive: true });
    const snap = path.join(base, 'snapshot');

    // ── baseline. A harness that reports zero survivors because the suite never really ran
    // is worse than no harness, so the snapshot must be green FIRST, and its check count
    // becomes the number every mutant is compared against.
    //
    // The retry is not politeness. The other lane commits into this tree while we copy, so a
    // red snapshot is usually a torn copy or a genuinely mid-edit tree, and both clear on
    // their own. What must NEVER happen is proceeding from a red baseline: every mutant would
    // score KILLED and the harness would report a flawless test suite.
    let bl = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`mutatetest: snapshotting the tree into ${snap} (attempt ${attempt}/3)`);
      snapshot(snap);
      const blStart = Date.now();
      bl = runSuite(snap);
      bl.ms = Date.now() - blStart;
      if (bl.ok && bl.checks > 0) break;
      console.error(`mutatetest: the UNMUTATED snapshot is not green (ok=${bl.ok} checks=${bl.checks} failing=${bl.failing}).`);
      if (attempt < 3) {
        console.error('mutatetest: another lane is probably mid-edit. Waiting 30s and re-copying.');
        spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},30000)']);
      }
    }
    if (!bl.ok || bl.checks <= 0) {
      console.error('mutatetest: giving up. Every mutant would score KILLED against a red baseline,');
      console.error('mutatetest: which would report a perfect test suite. Get platformtest green first.');
      cleanup();
      process.exit(2);
    }

    const files = selectedFiles(snap);
    const mutants = files.flatMap((f) => guardsIn(f, snap).map((g) => ({ file: f, ...g })));
    // --budget SAMPLES, evenly spaced, rather than taking the first N. The first N mutants are
    // all in whichever file sorts first, so `--budget=20` on the whole tree would have been a
    // deep dive on `app.js` reported as a picture of the platform.
    const budget = Number(arg('budget', '0')) || 0;
    const work = budget > 0 && budget < mutants.length
      ? mutants.filter((_, i) => Math.floor(i * budget / mutants.length)
        !== Math.floor((i + 1) * budget / mutants.length))
      : mutants;
    work.forEach((m, i) => { m.id = i; });
    if (!work.length) { console.log('mutatetest: nothing to mutate.'); cleanup(); process.exit(0); }

    console.log(`mutatetest: ${mutants.length} deletable guards across ${files.length} file(s)`
      + (budget && budget < mutants.length ? `, capped to ${work.length} by --budget` : ''));

    const jobsUsed = Math.min(jobs, work.length);
    // 6x green, floored at 90 s: long enough that a merely slower mutant is not mistaken for
    // a hang, short enough that eight hung workers cost minutes rather than hours.
    const timeoutMs = Math.max(90_000, Math.round(bl.ms * 6));
    console.log(`mutatetest: baseline green — ${bl.checks} checks in ${(bl.ms / 1000).toFixed(1)}s;`
      + ` a mutant is cut off at ${(timeoutMs / 1000).toFixed(0)}s and scored killed.`);
    console.log(`mutatetest: running ${work.length} mutants on ${jobsUsed} worker(s).\n`);
    const dirs = [];
    for (let i = 0; i < jobsUsed; i++) dirs.push(cloneSandbox(snap, path.join(base, `w${i}`)));

    // ── syntax gate. An unparseable mutant fails the suite for the wrong reason.
    for (const m of work) {
      m.source = mutate(m.file, m, snap);
      const probe = path.join(base, `probe-${m.id}.mjs`);
      writeFileSync(probe, m.source);
      m.invalid = spawnSync(process.execPath, ['--check', probe], { encoding: 'utf8' }).status !== 0;
      rmSync(probe, { force: true });
    }
    const runnable = work.filter((m) => !m.invalid);
    const invalid = work.length - runnable.length;
    if (invalid) console.log(`mutatetest: ${invalid} mutant(s) do not parse — excluded, not counted as killed.\n`);

    // ── dispatch. A dynamic queue rather than a static split: with --file and --budget the
    // work is small enough that one unlucky slow chunk would be most of the wall clock.
    const queue = runnable.slice();
    const results = new Map();
    let done = 0;
    await new Promise((resolve) => {
      let live = 0;
      for (const dir of dirs) {
        const w = fork(SELF, [`--worker=${dir}`, `--timeout=${timeoutMs}`], { stdio: 'inherit' });
        workers.push(w);
        live++;
        const next = () => {
          const job = queue.shift();
          if (!job) { w.send('stop'); return; }
          w.send({ id: job.id, file: job.file, source: job.source });
        };
        w.on('message', (msg) => {
          if (msg !== 'ready') {
            results.set(msg.id, msg);
            done++;
            const m = runnable.find((x) => x.id === msg.id);
            const killed = !msg.ok || msg.checks < bl.checks;
            const how = msg.timedOut ? 'hung    ' : (killed ? 'killed  ' : 'SURVIVED');
            process.stdout.write(`  [${String(done).padStart(3)}/${runnable.length}] `
              + `${how} ${m.file}:${m.line}\n`);
          }
          next();
        });
        w.on('exit', () => { if (--live === 0) resolve(); });
      }
    });

    // `report` RETURNS the exit code rather than calling process.exit itself. It used to call
    // it, which skipped this `finally` — so every run left a full copy of the tree per worker
    // behind in the scratchpad, and the harness that exists to keep the working tree clean was
    // quietly filling the disk instead.
    code = report(runnable, results, bl, work, files, Date.now() - t0);
  } finally {
    cleanup();
  }
  process.exit(code);
}

// ── report ────────────────────────────────────────────────────────────────────────────────

/** @returns {number} the process exit code — see the note at the call site. */
function report(runnable, results, bl, work, files, elapsedMs) {
  const survivors = [];
  const killed = [];
  for (const m of runnable) {
    const r = results.get(m.id);
    if (!r) continue;
    // Two ways the suite can notice: it fails, or it stops reaching checks it used to reach.
    // The second matters because a suite that dies early can still exit 0 on the surviving path.
    if (!r.ok || r.checks < bl.checks) {
      killed.push({ ...m, why: r.timedOut ? 'hung' : (r.ok ? `checks ${r.checks}<${bl.checks}` : 'failed') });
    }
    else survivors.push(m);
  }

  const byFile = new Map();
  for (const m of survivors) {
    if (!byFile.has(m.file)) byFile.set(m.file, []);
    byFile.get(m.file).push(m);
  }
  const perFileTotal = new Map();
  for (const m of runnable) perFileTotal.set(m.file, (perFileTotal.get(m.file) || 0) + 1);

  const ranked = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length
    || (b[1].length / perFileTotal.get(b[0])) - (a[1].length / perFileTotal.get(a[0]))
    || a[0].localeCompare(b[0]));

  console.log('\n══ survivors, worst file first ═══════════════════════════════════════════════');
  if (!ranked.length) {
    console.log('  none — every deletable guard in this scope is asserted on by some test.');
  }
  for (const [file, list] of ranked) {
    const total = perFileTotal.get(file);
    console.log(`\n  ${file}  —  ${list.length}/${total} guards survive deletion`);
    for (const m of list.sort((a, b) => a.line - b.line)) {
      console.log(`    ${file}:${m.line}`);
      console.log(`      ${m.text.trim()}`);
    }
  }

  const clean = [...perFileTotal.keys()].filter((f) => !byFile.has(f)).sort();
  if (clean.length) {
    console.log(`\n  fully covered (0 survivors): ${clean.length} file(s)`);
    for (const f of clean) console.log(`    ${f}  (${perFileTotal.get(f)}/${perFileTotal.get(f)} killed)`);
  }

  const invalid = work.length - runnable.length;
  const pct = runnable.length ? Math.round((survivors.length / runnable.length) * 100) : 0;
  console.log('\n══ summary ═══════════════════════════════════════════════════════════════════');
  console.log(`  scope        ${files.length} file(s) under platform/src`);
  console.log(`  mutants      ${runnable.length} run${invalid ? `, ${invalid} unparseable and excluded` : ''}`);
  const hung = killed.filter((k) => k.why === 'hung').length;
  console.log(`  killed       ${killed.length}${hung ? ` (${hung} by hanging the suite rather than failing it)` : ''}`);
  console.log(`  SURVIVED     ${survivors.length}  (${pct}% survival)`);
  console.log(`  baseline     ${bl.checks} checks`);
  console.log(`  wall clock   ${(elapsedMs / 1000).toFixed(1)}s`);

  const max = arg('max-survivors');
  if (max !== null) {
    const limit = Number(max);
    if (survivors.length > limit) {
      console.error(`\nmutatetest FAILED — ${survivors.length} survivors exceeds --max-survivors=${limit}.`);
      console.error('Each line above is a guard no test asserts on. Add the assertion, do not delete the guard.');
      return 1;
    }
    console.log(`\nmutatetest OK — ${survivors.length} survivors, within --max-survivors=${limit}.`);
  }
  return 0;
}
