/**
 * Platform suite runner.
 *
 * Runs every platform/test/*.mjs and fails on the first non-zero exit. Discovery is by
 * directory listing rather than a hand-maintained list, so a new suite is picked up by
 * existing, not by remembering to register it — the failure mode of a curated list is a test
 * that runs nowhere and is believed to be running.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'platform', 'test');

const suites = readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort();
if (!suites.length) { console.error('platformtest: no suites found — that is a failure, not a pass'); process.exit(1); }

let failed = 0;
let checks = 0;
for (const suite of suites) {
  const res = spawnSync(process.execPath, [path.join(dir, suite)], { encoding: 'utf8' });
  const ok = res.status === 0;
  checks += (res.stdout.match(/^ {2}ok/gm) || []).length;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${suite}`);
  if (!ok) {
    failed++;
    /**
     * Print the FAILING lines, not the last 25.
     *
     * A tail is the wrong 25 lines: a suite that fails in the middle and then passes another
     * hundred checks reports twenty-five `ok`s and the word FAILURE. That is exactly what CI
     * showed for profiletest — a failure whose cause had scrolled off, reproducible nowhere
     * because nobody could see what it was.
     *
     * Each failing check plus the lines under it (suites print detail on the following line),
     * then a short tail for the summary. stderr is kept whole: a thrown error is the one case
     * where the last lines really are the interesting ones.
     */
    const lines = res.stdout.split('\n');
    const failing = [];
    lines.forEach((line, i) => {
      if (!/^ {2}FAIL/.test(line)) return;
      failing.push(line);
      for (let j = i + 1; j < Math.min(i + 3, lines.length) && !/^ {2}(ok|FAIL)/.test(lines[j]); j++) {
        failing.push(lines[j]);
      }
    });
    // No `FAIL` line at all means the suite died rather than reported — the tail is all there is.
    process.stdout.write(failing.length
      ? `${failing.join('\n')}\n${lines.slice(-3).join('\n')}`
      : lines.slice(-25).join('\n'));
    process.stdout.write(res.stderr);
  }
}

console.log(`\n${checks} checks across ${suites.length} suites, ${failed} failing`);
process.exit(failed ? 1 : 0);
