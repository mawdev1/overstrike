/**
 * Release notes, drafted — P4-06.
 *
 * Simple, not clever: diffs two git refs' `docs/contracts/CHANGELOG.md` and `package.json`
 * `version` field, and drafts a release-notes markdown document from what changed. It does
 * not invent content, does not summarize with a model, and does not touch either file — it
 * reads two trees with `git show <ref>:<path>` and reshapes what is already there.
 *
 * The changelog is append-at-top (newest entry first, per its own house convention — see any
 * existing `## ` heading in `docs/contracts/CHANGELOG.md`), so "what's new since <from>" is:
 * every `## ` section present in `<to>`'s file that is not present verbatim in `<from>`'s
 * file, read off the top until the first section that already existed at `<from>`. A commit
 * log between the two refs is appended as a supplementary, unfiltered list (grouped by the
 * `[TAG]` lane prefix this repo's commit subjects already use, when present) — it is not a
 * substitute for the changelog section, which is the authored, human-readable record.
 *
 * Every git invocation below uses `execFile` with an argv array (never a shell string), so
 * ref/path arguments cannot be interpreted as shell syntax.
 *
 * Usage:
 *   node scripts/releasenotes.mjs --from=<ref> [--to=<ref>]   draft to stdout (--to default: HEAD)
 *   node scripts/releasenotes.mjs --from=<ref> --out=<path>    write the draft to a file
 *
 * <ref> is anything `git show <ref>:<path>` accepts (a tag, branch, commit sha, HEAD~N).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';

const runGit = promisify(execFile);

const args = Object.fromEntries(
  process.argv.slice(2)
    .map((a) => a.match(/^--([^=]+)(?:=(.*))?$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2] ?? true]),
);

if (typeof args.from !== 'string' || !args.from) {
  console.error('usage: node scripts/releasenotes.mjs --from=<ref> [--to=<ref>] [--out=<path>]');
  process.exit(2);
}
const fromRef = args.from;
const toRef = typeof args.to === 'string' ? args.to : 'HEAD';

async function showFile(ref, path) {
  try {
    const { stdout } = await runGit('git', ['show', `${ref}:${path}`]);
    return stdout;
  } catch (err) {
    if (/does not exist|exists on disk, but not in/.test(err.stderr || '')) return null;
    throw new Error(`git show ${ref}:${path} failed — ${(err.stderr || err.message).trim()}`);
  }
}

function readVersion(packageJsonText) {
  if (!packageJsonText) return null;
  try {
    return JSON.parse(packageJsonText).version ?? null;
  } catch {
    return null;
  }
}

/** Split a `## `-headed markdown doc into [{ heading, body, full }], top to bottom. */
function splitSections(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current);
      current = { heading: line.slice(3).trim(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
    // lines before the first `## ` (the doc's `# ` title) are dropped — not a dated entry
  }
  if (current) sections.push(current);
  return sections.map((s) => ({ heading: s.heading, full: s.lines.join('\n').trimEnd() }));
}

async function main() {
  const [fromPkg, toPkg, fromChangelog, toChangelog] = await Promise.all([
    showFile(fromRef, 'package.json'),
    showFile(toRef, 'package.json'),
    showFile(fromRef, 'docs/contracts/CHANGELOG.md'),
    showFile(toRef, 'docs/contracts/CHANGELOG.md'),
  ]);

  const fromVersion = readVersion(fromPkg);
  const toVersion = readVersion(toPkg);

  const fromSections = splitSections(fromChangelog);
  const toSections = splitSections(toChangelog);
  const fromHeadings = new Set(fromSections.map((s) => s.heading));

  const newSections = [];
  for (const s of toSections) {
    if (fromHeadings.has(s.heading)) break; // reached content that already existed at `from`
    newSections.push(s);
  }

  // Supplementary commit list, `from..to`, grouped by leading `[TAG]` in the subject.
  let commitLines = [];
  try {
    const { stdout } = await runGit('git', ['log', '--pretty=format:%s', `${fromRef}..${toRef}`]);
    commitLines = stdout.split('\n').filter(Boolean);
  } catch (err) {
    commitLines = [`(commit log unavailable: ${(err.stderr || err.message).trim()})`];
  }
  const grouped = new Map(); // tag -> [subject]
  const untagged = [];
  for (const subject of commitLines) {
    const m = subject.match(/^\[([A-Z]+)\]\s*(.*)$/);
    if (m) {
      const [, tag, rest] = m;
      if (!grouped.has(tag)) grouped.set(tag, []);
      grouped.get(tag).push(rest || subject);
    } else {
      untagged.push(subject);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  out.push(`# Release notes — draft (${fromRef} → ${toRef})`);
  out.push('');
  out.push(`Generated ${today} by \`scripts/releasenotes.mjs\`. Draft, not authored copy —`);
  out.push('review before publishing.');
  out.push('');
  out.push('## Version');
  out.push('');
  if (fromVersion && toVersion) {
    out.push(`\`package.json\` version: \`${fromVersion}\` → \`${toVersion}\`${fromVersion === toVersion ? '  (unchanged)' : ''}`);
  } else {
    out.push(`\`package.json\` version: from=\`${fromVersion ?? 'not found'}\` to=\`${toVersion ?? 'not found'}\``);
  }
  out.push('');
  out.push('## Changelog entries since ' + fromRef);
  out.push('');
  if (newSections.length === 0) {
    out.push('_No new `docs/contracts/CHANGELOG.md` sections between these refs._');
  } else {
    for (const s of newSections) out.push(s.full, '');
  }
  out.push('## Commits ' + `\`${fromRef}..${toRef}\`` + ` (${commitLines.length})`);
  out.push('');
  if (commitLines.length === 0) {
    out.push('_No commits in range._');
  } else {
    for (const [tag, subjects] of [...grouped.entries()].sort()) {
      out.push(`### ${tag} (${subjects.length})`);
      for (const s of subjects) out.push(`- ${s}`);
      out.push('');
    }
    if (untagged.length) {
      out.push(`### untagged (${untagged.length})`);
      for (const s of untagged) out.push(`- ${s}`);
      out.push('');
    }
  }

  const draft = out.join('\n').trimEnd() + '\n';

  if (typeof args.out === 'string') {
    await writeFile(args.out, draft, 'utf8');
    console.log(`wrote ${args.out} (${draft.length} bytes)`);
  } else {
    process.stdout.write(draft);
  }
}

await main();
