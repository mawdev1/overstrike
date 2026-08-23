/**
 * The map-version drift guard.
 *
 * Three packages independently name a map's version:
 *   1. `src/world/level.js`         — the map itself (`MAP_VERSION`), read via the registry.
 *   2. `server/index.js`            — `SUPPORTED_MAPS`, now DERIVED from the registry.
 *   3. `platform/.../lobby/index.js`— `ROOM_MAPS`, a separate package, still a literal.
 *
 * (3) cannot import (1): `platform` is its own package and must not pull the browser client's
 * module graph (three.js) into the API server. So it stays a hand-kept copy — and a hand-kept
 * copy is exactly what broke production on 2026-08-23: `ROOM_MAPS` was bumped to `3.0.0` for
 * THE CROSSING while the server still said `1.0.0`, and since `/control/allocate` refuses on a
 * version mismatch, EVERY launch on the game's main map died with MATCH_ALLOCATION_FAILED.
 * Nothing caught it because no test compared the two numbers.
 *
 * This does. It is cheap, it has no dependencies, and it fails loudly.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMapEntry } from '../src/world/world.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;
const check = (cond, label, detail = '') => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}`); if (detail) console.log(`       ${detail}`); }
};

console.log('\nmap version agreement across packages');

// ── the platform's ROOM_MAPS, read as text (importing it would boot the whole module) ──────
const lobbySrc = readFileSync(join(root, 'platform/src/modules/lobby/index.js'), 'utf8');
const roomMapsBlock = lobbySrc.slice(lobbySrc.indexOf('const ROOM_MAPS'));
const roomMaps = {};
// Each entry looks like:  'the-square': Object.freeze({ mapVersion: '3.0.0', …
const entryRe = /'?([a-z0-9-]+)'?:\s*Object\.freeze\(\{\s*(?:\/\/[^\n]*\n\s*)*[^}]*?mapVersion:\s*'([^']+)'/gs;
for (const m of roomMapsBlock.matchAll(entryRe)) roomMaps[m[1]] = m[2];

check(Object.keys(roomMaps).length > 0,
  'ROOM_MAPS parsed out of the platform lobby module',
  'the regex found no entries — if the table was restructured, update this guard');

// ── the server's hostable list, read as text for the same reason ───────────────────────────
const serverSrc = readFileSync(join(root, 'server/index.js'), 'utf8');
const hostableMatch = serverSrc.match(/const HOSTABLE_MAPS = \[([^\]]+)\]/);
check(Boolean(hostableMatch), 'HOSTABLE_MAPS parsed out of server/index.js');
const hostable = hostableMatch ? [...hostableMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];

// ── every map the lobby can create must be hostable, at the SAME version the map declares ──
for (const [mapId, lobbyVersion] of Object.entries(roomMaps)) {
  const entry = getMapEntry(mapId);
  check(Boolean(entry), `lobby map '${mapId}' is a registered map`);
  if (!entry) continue;

  check(lobbyVersion === entry.version,
    `lobby ROOM_MAPS['${mapId}'].mapVersion matches the map's own MAP_VERSION`,
    `lobby says ${lobbyVersion}, ${mapId} declares ${entry.version} — /control/allocate refuses on `
    + 'mismatch, so this makes the map unlaunchable in production');

  check(hostable.includes(mapId),
    `the game server is willing to host '${mapId}'`,
    `HOSTABLE_MAPS is [${hostable.join(', ')}] — a room the lobby can create but no server will host `
    + 'fails allocation for every player who tries it');
}

// ── and nothing hostable should name a map that no longer exists ───────────────────────────
for (const mapId of hostable) {
  check(Boolean(getMapEntry(mapId)), `hostable map '${mapId}' is still registered`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
