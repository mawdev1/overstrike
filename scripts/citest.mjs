/**
 * Every script `npm run ci` invokes must exist IN THE REPOSITORY.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────
 * Three times now, `npm run ci` has referenced `scripts/tdmtest.mjs`, a file that is not
 * tracked by git. It sits untracked in one working tree, so `npm run ci` passes there and
 * aborts with MODULE_NOT_FOUND for everyone else and from every fresh clone. It was backed
 * out twice (efe2aa6, 50159eb) and came back.
 *
 * The reason it keeps coming back is that the only way to notice is to run the command
 * somewhere other than the machine that has the file — and the machine that has the file is
 * the machine that runs the command. A green `npm run ci` was reported to the human owner on
 * exactly that basis, which is the failure this guard exists to make impossible: the claim was
 * not a lie about the exit code, it was an exit code that meant something different than the
 * person reporting it thought.
 *
 * The GitHub workflow never called `npm run ci`, so CI itself stayed green throughout. That is
 * its own lesson: the local aggregate command and the protected path have to agree, or "I ran
 * the suite" and "the suite runs" are separate facts.
 *
 * Usage: node scripts/citest.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const tracked = new Set(
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean),
);

/** Every `.mjs`/`.js` path a script line names, including via `npm run` indirection. */
function filesFor(name, seen = new Set()) {
  if (seen.has(name)) return [];          // a script that runs itself would otherwise not return
  seen.add(name);
  const body = pkg.scripts?.[name];
  if (body === undefined) return [{ missingScript: name }];

  const out = [];
  for (const token of body.split(/\s+/)) {
    if (/^(scripts|platform|server|src)\/.+\.(mjs|js)$/.test(token)) out.push({ file: token });
  }
  // `npm run x` chains: follow it, so a hole two levels down is still found.
  for (const m of body.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) out.push(...filesFor(m[1], seen));
  return out;
}

const problems = [];
let checked = 0;

for (const entry of filesFor('ci')) {
  if (entry.missingScript) {
    problems.push(`npm run ci reaches "${entry.missingScript}", which package.json does not define`);
    continue;
  }
  checked++;
  if (!tracked.has(entry.file)) {
    problems.push(
      `${entry.file} is NOT tracked by git.\n`
      + `        npm run ci invokes it, so it passes only where an untracked copy happens to\n`
      + `        exist. Commit the file, or take it out of the ci script — but do not leave the\n`
      + `        aggregate command depending on something a fresh clone does not have.`,
    );
  }
}

if (problems.length) {
  console.error(`\ncitest FAILED — ${problems.length} problem(s) in the ci script\n`);
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log(`citest OK — all ${checked} scripts reachable from \`npm run ci\` are tracked by git.`);
