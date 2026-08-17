/**
 * Static sanity pass over the source tree:
 *  1. every .js file parses as an ES module
 *  2. every relative import resolves to a real file
 *  3. no file imports a bare specifier other than the ones we actually depend on
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const ALLOWED_BARE = [/^three$/, /^three\/addons\//];

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = await walk(SRC);
const errors = [];
let importCount = 0;

for (const f of files) {
  const rel = path.relative(ROOT, f);

  try {
    await exec(process.execPath, ['--check', f]);
  } catch (err) {
    errors.push(`${rel}\n    SYNTAX: ${(err.stderr || err.message).split('\n').slice(0, 6).join('\n    ')}`);
    continue;
  }

  const src = await readFile(f, 'utf8');
  const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    importCount++;
    if (spec.startsWith('.')) {
      const target = path.resolve(path.dirname(f), spec);
      if (!existsSync(target)) {
        errors.push(`${rel}\n    MISSING IMPORT: "${spec}" -> ${path.relative(ROOT, target)}`);
      }
    } else if (!ALLOWED_BARE.some((r) => r.test(spec))) {
      errors.push(`${rel}\n    DISALLOWED BARE IMPORT: "${spec}"`);
    }
  }

  const st = await stat(f);
  if (st.size === 0) errors.push(`${rel}\n    EMPTY FILE`);
}

if (errors.length) {
  console.error(`\n✗ ${errors.length} problem(s) across ${files.length} files:\n`);
  for (const e of errors) console.error('  ' + e + '\n');
  process.exit(1);
}
console.log(`✓ ${files.length} modules parsed, ${importCount} imports resolved.`);
