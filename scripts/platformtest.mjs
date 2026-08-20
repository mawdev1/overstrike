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
  if (!ok) { failed++; process.stdout.write(res.stdout.split('\n').slice(-25).join('\n')); process.stdout.write(res.stderr); }
}

console.log(`\n${checks} checks across ${suites.length} suites, ${failed} failing`);
process.exit(failed ? 1 : 0);
