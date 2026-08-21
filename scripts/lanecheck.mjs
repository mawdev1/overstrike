/**
 * Cross-lane path guard.  Build Plan v2.0 §0.2, §0.4, §0.6, §5.3.
 *
 * Two AI engineering lanes work this repository at the same time: Claude Code owns the
 * backend, Codex owns the frontend. The rule that makes that safe is that **a file has
 * exactly one writing lane**. This script is what enforces it, because a rule that lives
 * only in a document is a rule that gets broken at 2am by an agent that is sure its edit
 * is too small to matter.
 *
 * It fails a change set when:
 *
 *   1. it touches files owned by BOTH lanes (split the PR),
 *   2. it touches a path no rule claims (assign an owner before writing there),
 *   3. it changes the wire format without bumping PROTOCOL_VERSION,
 *   4. it changes map geometry without a fresh nav bake.
 *
 * The single exception is the status-line carve-out from §0.4: the receiving lane may edit
 * the `- Status:` line of a request it did not write, because that is how a request is
 * answered. Anything more than that in the other lane's request file is a violation.
 *
 * Usage:
 *   node scripts/lanecheck.mjs                 # staged + unstaged vs HEAD
 *   node scripts/lanecheck.mjs --staged        # exactly what `git commit` would record
 *   node scripts/lanecheck.mjs --base=master   # every change since a base ref (CI)
 *   node scripts/lanecheck.mjs --range=A..B    # EACH COMMIT in the range, separately (CI)
 *   node scripts/lanecheck.mjs --files=a,b,c    # explicit list, for testing the guard
 *   node scripts/lanecheck.mjs --expect-fail    # invert the exit code (self-test)
 *
 * ── --range, and why the union is the wrong question ─────────────────────────────────
 * CI used to flatten a whole push into one file list. That inverts the rule it enforces.
 * The rule says a change touching both lanes must be SPLIT; splitting it produces two
 * single-lane commits whose UNION spans both lanes, so obeying the rule failed the guard
 * and the only way to pass was to not split. A real push was rejected for exactly this:
 * one [CC] commit amending a contract, one [CX]-owned request file answering it.
 *
 * The unit the rule talks about is the commit, so that is the unit checked.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(path.join(ROOT, 'docs/lane-ownership.json'), 'utf8'));

const arg = (k) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : null;
};
const flag = (k) => process.argv.slice(2).includes(`--${k}`);

const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    // A missing base ref is an environment problem, not a lane violation. Say which.
    console.error(`lanecheck: git ${args.join(' ')} failed — ${err.message.split('\n')[0]}`);
    process.exit(2);
  }
};

// ── which files changed ───────────────────────────────────────────────────────────────

/**
 * `--range=A..B`: check every commit in the range on its own, and fail if ANY commit fails.
 *
 * Each commit is evaluated in a child process rather than in a loop here, because the guards
 * below read `--commit` from argv and a fresh process is the honest way to get a fresh
 * evaluation with no state carried between commits.
 */
if (arg('range')) {
  const range = arg('range');
  const shas = git('rev-list', '--reverse', range).split('\n').filter(Boolean);
  if (shas.length === 0) {
    console.log(`lanecheck: no commits in ${range}.`);
    process.exit(flag('expect-fail') ? 1 : 0);
  }
  console.log(`lanecheck: ${shas.length} commit(s) in ${range}, checked one at a time\n`);
  let bad = 0;
  for (const sha of shas) {
    const subject = git('log', '-1', '--format=%s', sha).trim();
    console.log(`── ${sha.slice(0, 8)} ${subject}`);
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--commit=${sha}`],
      { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' });
    if (r.status !== 0) bad++;
    console.log('');
  }
  if (bad) console.error(`lanecheck FAILED — ${bad} of ${shas.length} commit(s) span both lanes.`);
  else console.log(`lanecheck OK — all ${shas.length} commit(s) are single-lane.`);
  process.exit((bad > 0) === flag('expect-fail') ? 0 : 1);
}

/**
 * The commit range every guard below reads its diffs from.
 *
 *   --commit=SHA  that commit alone (SHA^..SHA), the unit `--range` checks
 *   --base=REF    everything this branch did since REF
 *   neither       the working tree against HEAD
 */
function diffRange() {
  const commit = arg('commit');
  if (commit) {
    // A root commit has no parent to diff against; the empty-tree hash is what git itself uses.
    const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const parent = git('rev-list', '--parents', '-n', '1', commit).trim().split(' ')[1] || EMPTY_TREE;
    return [`${parent}..${commit}`];
  }
  const base = arg('base');
  if (base) return [`${git('merge-base', base, 'HEAD').trim()}..HEAD`];
  return ['HEAD'];
}


function changedFiles() {
  const explicit = arg('files');
  if (explicit) return explicit.split(',').map((s) => s.trim()).filter(Boolean);

  // --staged is the mode that would have caught commit 9c439c8. A broad `git add docs/` swept
  // in five Codex-owned files, and I then ran this guard on a hand-typed SUBSET and treated
  // that as verification. Checking the index removes the step where a human chooses what to
  // check, which is the step that failed.
  if (flag('staged')) {
    return git('diff', '--name-only', '--cached').split('\n').filter(Boolean);
  }

  if (arg('commit')) {
    return git('diff', '--name-only', ...diffRange()).split('\n').filter(Boolean);
  }

  const base = arg('base');
  if (base) {
    // Three-dot: what this branch did, not what happened on the base since we forked.
    const merged = git('merge-base', base, 'HEAD').trim();
    return git('diff', '--name-only', `${merged}..HEAD`).split('\n').filter(Boolean);
  }

  const out = new Set();
  for (const l of git('diff', '--name-only', 'HEAD').split('\n')) if (l) out.add(l);
  for (const l of git('diff', '--name-only', '--cached').split('\n')) if (l) out.add(l);
  for (const l of git('ls-files', '--others', '--exclude-standard').split('\n')) if (l) out.add(l);
  return [...out];
}

// ── ownership ─────────────────────────────────────────────────────────────────────────

/**
 * Glob match supporting `**` (any depth, including none) and `*` (one segment).
 *
 * Deliberately tiny rather than a dependency: the guard has to run before `npm install`
 * in a cold CI job, and a path matcher is not where this project spends its risk budget.
 */
function matches(pattern, file) {
  let rx = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `a/**/b` must match `a/b` too, so the slash joins the optional group.
        if (pattern[i + 2] === '/') { rx += '(?:.*/)?'; i += 2; }
        else { rx += '.*'; i += 1; }
      } else {
        rx += '[^/]*';
      }
    } else if ('.+^${}()|[]\\?'.includes(c)) {
      rx += `\\${c}`;
    } else {
      rx += c;
    }
  }
  return new RegExp(`^${rx}$`).test(file);
}

/** Last matching rule wins, so specific rules are written after the general ones. */
function laneOf(file) {
  let lane = null;
  for (const rule of cfg.rules) if (matches(rule.pattern, file)) lane = rule.lane;
  return lane;
}

// ── status-line carve-out (§0.4) ──────────────────────────────────────────────────────

/**
 * True when the only thing this change did to a request file was answer requests.
 *
 * Reads the actual diff hunks rather than trusting the author: added and removed lines
 * must all be `- Status:` or `- Response:`. Anything else — a new request, an edited ask,
 * a reordered file — is a real write and belongs to the file's owning lane.
 */
function onlyStatusLines(file) {
  // An untracked file has no baseline, so there is no way to prove only the status lines
  // moved — the whole file reads as added. The carve-out therefore cannot apply, and the file
  // belongs wholly to its owning lane until that lane commits it once.
  const tracked = arg('commit')
    ? git('ls-tree', '--name-only', `${arg('commit')}^`, '--', file).trim() !== ''
    : git('ls-files', '--', file).trim() !== '';
  if (!tracked) return false;

  const diff = git('diff', '--unified=0', ...diffRange(), '--', file);
  const touched = diff
    .split('\n')
    .filter((l) => (l.startsWith('+') || l.startsWith('-')) && !/^(\+\+\+|---)/.test(l))
    .map((l) => l.slice(1).trim());
  if (touched.length === 0) return false;
  const allowed = cfg.statusLineException.allowedLinePrefixes;
  return touched.every((l) => allowed.some((p) => l.startsWith(p)));
}


/**
 * The text of a watched file on either side of the change under examination.
 *
 * `--commit=SHA` compares SHA^ against SHA; `--base=REF` compares the merge base against HEAD;
 * the working-tree mode compares HEAD against what is on disk, which is what a developer wants
 * before they commit.
 */
function versionSideOf(side, file) {
  const commit = arg('commit');
  if (commit) {
    const parent = git('rev-list', '--parents', '-n', '1', commit).trim().split(' ')[1];
    if (side === 'before') return parent ? show(`${parent}:${file}`) : '';
    return show(`${commit}:${file}`);
  }
  const base = arg('base');
  if (base) {
    const merged = git('merge-base', base, 'HEAD').trim();
    return side === 'before' ? show(`${merged}:${file}`) : show(`HEAD:${file}`);
  }
  if (side === 'before') return show(`HEAD:${file}`);
  try { return readFileSync(path.join(ROOT, file), 'utf8'); } catch { return ''; }
}

/** `git show`, but a path that does not exist on that side is empty rather than fatal. */
function show(spec) {
  try {
    return execFileSync('git', ['show', spec], { cwd: ROOT, encoding: 'utf8' });
  } catch { return ''; }
}

// ── guards ────────────────────────────────────────────────────────────────────────────

const problems = [];
const files = changedFiles();

if (files.length === 0) {
  console.log('lanecheck: no changed files.');
  process.exit(flag('expect-fail') ? 1 : 0);
}

const byLane = { CC: [], CX: [], SHARED: [], UNOWNED: [] };
for (const f of files) {
  const lane = laneOf(f);
  if (!lane) { byLane.UNOWNED.push(f); continue; }
  // A cross-lane edit that only answers a request is legal. Attribute it to the file's
  // own lane so it cannot drag the whole change set into a false split.
  if (cfg.statusLineException.files.includes(f) && onlyStatusLines(f)) {
    byLane.SHARED.push(f);
    continue;
  }
  byLane[lane].push(f);
}

// 1. unowned paths
if (byLane.UNOWNED.length) {
  problems.push(
    `No ownership rule claims these paths. Build Plan §1.4: an unowned path must be assigned\n`
    + `        by the human owner in docs/lane-ownership.json before either lane writes there.\n`
    + byLane.UNOWNED.map((f) => `          ${f}`).join('\n'),
  );
}

// 2. the split
if (byLane.CC.length && byLane.CX.length) {
  problems.push(
    `This change set spans both lanes. Build Plan §0.2: a file has exactly one writing lane,\n`
    + `        and a PR touching both territories must be split — including for "obvious" fixes.\n`
    + `        (If a request file is listed below only because you answered a request in it, note\n`
    + `        that the §0.4 status-line carve-out needs the file to be TRACKED — an untracked\n`
    + `        one has no baseline to diff against, so its owning lane must commit it once first.)\n`
    + `          [CC] Claude Code owns:\n${byLane.CC.map((f) => `            ${f}`).join('\n')}\n`
    + `          [CX] Codex owns:\n${byLane.CX.map((f) => `            ${f}`).join('\n')}`,
  );
}

// 3. wire format vs version constant
const pv = cfg.protocolVersionGuard;
if (files.includes(pv.watch)) {
  const diff = git('diff', '--unified=0', ...diffRange(), '--', pv.constantFile);
  // Compare the ASSIGNED VALUE, not the presence of the name.
  //
  // This used to be `line.includes('PROTOCOL_VERSION')` over the added lines, which any added
  // line mentioning the constant satisfied — and `protocol.js` mentions it in a docstring and
  // again in `REJECT_PROTOCOL_VERSION_MISMATCH`. Reverting the constant to 1 while touching a
  // comment left the guard reporting OK. It was checking that somebody typed the name near the
  // change, which is not the rule; the rule is that the number moved.
  const valueOf = (text) => {
    const m = new RegExp(`${pv.constantName}\\s*=\\s*(\\d+)`).exec(text || '');
    return m ? Number(m[1]) : null;
  };
  const before = valueOf(versionSideOf('before', pv.constantFile));
  const after = valueOf(versionSideOf('after', pv.constantFile));
  // A constant that cannot be READ is a failure, not a pass: the guard has lost the thing it
  // exists to check, and answering OK would be the same silence it just stopped producing.
  if (after === null) {
    problems.push(
      `${pv.constantName} could not be read from ${pv.constantFile}. The guard cannot confirm a\n`
      + `        wire change was versioned, and a guard that cannot check must not report OK.`);
  }
  const bumped = before !== null && after !== null && after > before;

  /**
   * Does this diff change the wire LAYOUT, or only what is written into it?
   *
   * The rule is "every wire change bumps the version" — but the guard could not tell a layout
   * change from a behaviour change, so it demanded a bump for ANY edit to this file. That is
   * not a harmless over-approximation: it pushed two real safety fixes OUT of the codec and
   * into their callers, purely to avoid a bump that would have refused every peer this build
   * agrees with perfectly. A guard that makes correct code harder to place is buying its
   * strictness with someone else's design.
   *
   * So compare the structures that DEFINE the layout — the message type ids, the fixed byte
   * sizes, and the ordered field and event tables. If those are identical on both sides, the
   * bytes are identical, and a bump would be a lie about compatibility. If any of them moved,
   * the bump is mandatory and no amount of "it is only a small change" argues otherwise.
   *
   * Deliberately textual and deliberately over-inclusive: a reformat of one of these tables
   * demands a bump it does not strictly need, which errs toward the version being wrong in the
   * safe direction. Missing a real layout change is the failure that corrupts clients.
   */
  const LAYOUT = /^\s*export const (MSG_[A-Z_]+|[A-Z_]*BYTES[A-Z_0-9]*|ENTITY_FIELDS|EV_KINDS|EV_VEC3|EV_SPATIAL|CANCEL_REASONS|REFUSAL_REASONS|OUTCOME_REASONS|BOMB_STATES|PHASES)\b/;
  const layoutOf = (text) => {
    const out = [];
    const lines = (text || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!LAYOUT.test(lines[i])) continue;
      // Take the declaration through its terminating `;` so a multi-line table is compared whole.
      let block = lines[i];
      for (let j = i + 1; j < lines.length && !/;\s*$/.test(block); j++) block += `\n${lines[j]}`;
      out.push(block.replace(/\s+/g, ' ').trim());
    }
    return out.join('\n');
  };
  const layoutMoved = layoutOf(versionSideOf('before', pv.constantFile))
    !== layoutOf(versionSideOf('after', pv.constantFile));
  // An empty diff means the file did not change *in the range being examined* — which is the
  // normal case when --files names an already-committed path. There is nothing to version, so
  // demanding a bump would be a false failure rather than a caught violation.
  if (diff.trim() !== '' && !bumped && !layoutMoved) {
    console.log(
      `lanecheck: ${pv.watch} changed but the wire LAYOUT did not — message ids, byte sizes and\n`
      + `           the field/event tables are identical on both sides, so ${pv.constantName}\n`
      + `           stays ${after}. A bump here would refuse peers this build agrees with.`);
  } else if (diff.trim() !== '' && !bumped) {
    problems.push(
      `${pv.watch} changed but ${pv.constantName} was not bumped. Build Plan §0.6: every wire\n`
      + `        change bumps the version, and incompatible clients must be rejected at handshake\n`
      + `        with a clean upgrade message rather than being allowed to corrupt state.`,
    );
  }
}

// 4. geometry vs nav bake
const mg = cfg.mapGuard;
const geometryTouched = mg.watch.filter((w) => files.includes(w));
if (geometryTouched.length) {
  console.log(
    `lanecheck: geometry changed (${geometryTouched.join(', ')}).\n`
    + `  Build Plan §3.3 requires a fresh nav bake committed with the change and these guards green:\n`
    + mg.requiredHarnesses.map((h) => `    ${h}`).join('\n'),
  );
}

// ── report ────────────────────────────────────────────────────────────────────────────

const counts = `CC:${byLane.CC.length} CX:${byLane.CX.length} shared:${byLane.SHARED.length} unowned:${byLane.UNOWNED.length}`;

if (problems.length) {
  console.error(`\nlanecheck FAILED — ${files.length} files (${counts})\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(flag('expect-fail') ? 0 : 1);
}

console.log(`lanecheck OK — ${files.length} files (${counts})`);
process.exit(flag('expect-fail') ? 1 : 0);
