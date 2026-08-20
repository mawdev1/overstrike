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
 *   node scripts/lanecheck.mjs --base=master   # every change since a base ref (CI)
 *   node scripts/lanecheck.mjs --files=a,b,c    # explicit list, for testing the guard
 *   node scripts/lanecheck.mjs --expect-fail    # invert the exit code (self-test)
 */
import { execFileSync } from 'node:child_process';
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

function changedFiles() {
  const explicit = arg('files');
  if (explicit) return explicit.split(',').map((s) => s.trim()).filter(Boolean);

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
  const tracked = git('ls-files', '--', file).trim() !== '';
  if (!tracked) return false;

  const base = arg('base');
  const range = base ? [`${git('merge-base', base, 'HEAD').trim()}..HEAD`] : ['HEAD'];
  const diff = git('diff', '--unified=0', ...range, '--', file);
  const touched = diff
    .split('\n')
    .filter((l) => (l.startsWith('+') || l.startsWith('-')) && !/^(\+\+\+|---)/.test(l))
    .map((l) => l.slice(1).trim());
  if (touched.length === 0) return false;
  const allowed = cfg.statusLineException.allowedLinePrefixes;
  return touched.every((l) => allowed.some((p) => l.startsWith(p)));
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
  const base = arg('base');
  const range = base ? [`${git('merge-base', base, 'HEAD').trim()}..HEAD`] : ['HEAD'];
  const diff = git('diff', '--unified=0', ...range, '--', pv.constantFile);
  const bumped = diff
    .split('\n')
    .some((l) => l.startsWith('+') && !l.startsWith('+++') && l.includes(pv.constantName));
  if (!bumped) {
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
