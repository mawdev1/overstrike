/**
 * Assert that a built bundle is the bundle we meant to ship.
 *
 * This exists because of a silent production failure that cost a day. `fly deploy` was run
 * without `--build-arg VITE_SERVER_URL=...`, so `src/net/config.js` resolved `SERVER_URL`
 * to '' and `HAS_SERVER` to false. Vite then did exactly what it should: it tree-shook the
 * entire netcode away. The shipped bundle contained no `WebSocket`, no session chunk, no
 * server URL — a perfectly working SINGLE-PLAYER game served from the multiplayer URL.
 *
 * Nothing failed. The build was green, the site loaded, the game played. The only symptom
 * was that the dedicated server sat at `clients: 0` while someone was playing, and the
 * player wondered why the bots were stale — they were on a build one commit behind a bot
 * fix, because they were never talking to the server at all.
 *
 * The lesson is that "the feature is absent" and "the feature is present and working" look
 * identical from outside a bundle. So we look inside it.
 *
 *   node scripts/verifybuild.mjs --dist=dist --expect-server=wss://host
 *   node scripts/verifybuild.mjs --dist=dist --expect-singleplayer
 */
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.length ? v.join('=') : true];
  }),
);

const dist = path.resolve(args.dist || 'dist');
const expectServer = typeof args['expect-server'] === 'string' ? args['expect-server'] : '';
const expectSingle = !!args['expect-singleplayer'];

if (!expectServer && !expectSingle) {
  console.error('verifybuild: pass --expect-server=<url> or --expect-singleplayer');
  process.exit(2);
}
if (!fs.existsSync(dist)) {
  console.error(`verifybuild: no such directory: ${dist}`);
  process.exit(2);
}

/** Every emitted script, source maps excluded — maps carry the original source and would
 *  report the URL as present even when the shipped code has it tree-shaken away. */
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) files.push(p);
  }
})(dist);

const source = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const has = (needle) => source.includes(needle);

let failures = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const bad = (n, d) => { failures++; console.log(`  FAIL ${n}\n       ${d}`); };

console.log(`\nverifying ${path.relative(process.cwd(), dist) || dist} (${files.length} scripts)`);

if (files.length === 0) bad('the build emitted scripts', 'no .js files found — did the build run?');

if (expectServer) {
  if (has(expectServer)) ok(`the server URL is baked in (${expectServer})`);
  else {
    bad('the server URL is baked in',
      `"${expectServer}" appears in NO emitted script. VITE_SERVER_URL was almost certainly\n` +
      '       not set at build time, so this bundle is a SINGLE-PLAYER build. Rebuild with\n' +
      `       VITE_SERVER_URL=${expectServer}`);
  }

  // The URL alone is not proof: a string can survive while the code that uses it does not.
  if (has('WebSocket')) ok('the netcode is present (WebSocket transport shipped)');
  else bad('the netcode is present', 'no "WebSocket" in any emitted script — the net layer was tree-shaken out');
} else {
  if (!has('WebSocket')) ok('single-player build carries no netcode, as intended');
  else bad('single-player build carries no netcode', 'a WebSocket transport was shipped in a build declared single-player');
}

console.log(failures ? `\n${failures} check(s) failed — this bundle is not what was asked for\n` : '\nbundle is what was asked for\n');
process.exit(failures ? 1 : 0);
