/**
 * Profile, settings, and career stats — the P1 verification.
 *
 * Every claim is paired with its failing control: an assertion that something is refused is
 * worthless without the neighbouring assertion that the legitimate version of the same call
 * goes through, because a service that refuses everything passes the first half of this file.
 *
 * The store is faked here and only here (`platform/src/core/store.js` is another agent's), so
 * these are service-level proofs against the documented store surface, not database proofs.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createProfileModule } from '../src/modules/profile/index.js';
import { createMemoryStore } from '../src/core/store/memory.js';
import { normalizePrivacy } from '../src/modules/profile/profile.js';
import {
  resolveMatchStats, careerDelta, timePlayedSec, emptyTotals, addTotals, deriveRatios,
  CAREER_KEYS, idempotencyKeyFor, STAT_DEFINITION_VERSION,
} from '../src/modules/profile/stats.js';
import { parseSettingsInventory } from '../src/modules/profile/settingsVocabularyParser.js';
import { VOCABULARY } from '../src/modules/profile/vocabulary.generated.js';

const here = dirname(fileURLToPath(import.meta.url));
const INVENTORY = resolve(here, '../../docs/design/settings-inventory.md');

let failures = 0;
const ok = (name) => console.log(`  ok   ${name}`);
const bad = (name, detail) => { failures++; console.log(`  FAIL ${name}\n       ${detail}`); };
const expect = (condition, name, detail = '') => (condition ? ok(name) : bad(name, detail));

async function expectCode(fn, code, name) {
  try {
    await fn();
    bad(name, `expected ${code}, nothing was thrown`);
    return null;
  } catch (err) {
    if (err.code === code) { ok(name); return err; }
    bad(name, `expected ${code}, got ${err.code || err.message}`);
    return err;
  }
}

async function expectNoThrow(fn, name) {
  try { const v = await fn(); ok(name); return v; }
  catch (err) { bad(name, `threw ${err.code || err.message}`); return null; }
}

// ------------------------------------------------------------------ fake store

/**
 * Columns `accounts` actually has (migrations 0001 + 0008, mirrored from the memory adapter's
 * ACCOUNT_COLUMNS). The fake enforces them for the same reason the memory adapter does: a fake
 * that shrugs at a column no schema declares is how a write to `nameChangeAvailableAt` passed
 * every test while doing nothing at all.
 */
const ACCOUNT_COLUMNS = new Set([
  'accountId', 'status', 'emailHash', 'displayName', 'displayNameFolded',
  'passwordHash', 'roles', 'nameChangedAt',
  'eligibilityVerdict', 'eligibilityPolicyVer', 'eligibilityDecidedAt',
  'emailVerifiedAt', 'termsVersionAccepted', 'termsAcceptedAt',
  'consentTelemetry', 'consentPolicyVer', 'consentDecidedAt',
  'privacy', 'createdAt', 'updatedAt', 'deletedAt',
]);

function makeStore() {
  const accounts = new Map();
  const profiles = new Map();
  const statRows = new Map();        // `${account}|${mode}|${sdv}`
  const weaponRows = new Map();      // `${account}|${mode}|${weapon}|${sdv}`
  const matches = [];                // newest last; listForAccount reverses
  const idem = new Map();            // `${key}|${actorId}`

  const key = (...p) => p.join('|');

  // The documented adapter serialises every transaction (store/memory.js). Without that here,
  // "the same result submitted ten times concurrently" would be testing the fake's interleaving
  // rather than the service's idempotency.
  let chain = Promise.resolve();

  return {
    _accounts: accounts, _matches: matches, _idem: idem,
    async tx(fn) {
      const run = chain.then(() => fn({ fake: true }));
      chain = run.then(() => {}, () => {});
      return run;
    },

    accounts: {
      async byId(id) { return accounts.get(id) || null; },
      async byNameFolded(folded) {
        for (const a of accounts.values()) if (a.displayNameFolded === folded) return a;
        return null;
      },
      async update(id, patch) {
        for (const k of Object.keys(patch || {})) {
          if (!ACCOUNT_COLUMNS.has(k)) throw new Error(`Unknown column for accounts: ${k}`);
        }
        const a = { ...accounts.get(id), ...patch };
        accounts.set(id, a);
        return a;
      },
    },

    // §5.2/§5.4 replay storage. First writer wins; the same key with a different request hash
    // is refused rather than overwritten (store.js).
    idempotency: {
      async get(k, actorId) { return idem.get(key(k, actorId)) || null; },
      async put(row) {
        const k = key(row.key, row.actorId);
        const cur = idem.get(k);
        if (cur) {
          if (cur.requestHash !== row.requestHash) throw new Error('IDEMPOTENCY_KEY_REUSED');
          return cur;
        }
        idem.set(k, row);
        return row;
      },
    },

    profiles: {
      async byAccountId(id) { return profiles.get(id) || null; },
      // Patchable columns only, and `updated_at` is the adapter's to stamp — same rules as
      // store/memory.js, so a service that patches a column the schema does not have fails here.
      async upsert(id, patch) {
        for (const k of Object.keys(patch || {})) {
          if (!['roamingSettings', 'legacyImport', 'settingsVersion'].includes(k)) {
            throw new Error(`Unknown column for profiles: ${k}`);
          }
        }
        const p = {
          accountId: id, roamingSettings: null, legacyImport: null, settingsVersion: 1,
          ...(profiles.get(id) || {}), ...patch,
          updatedAt: new Date().toISOString(),
        };
        profiles.set(id, p);
        return p;
      },
    },

    stats: {
      async get(a, mode, sdv) { return statRows.get(key(a, mode, sdv)) || null; },
      async applyDelta(a, mode, sdv, delta) {
        const k = key(a, mode, sdv);
        const row = statRows.get(k) || { accountId: a, mode, statDefinitionVersion: sdv, ...emptyTotals() };
        for (const f of CAREER_KEYS) row[f] = (row[f] || 0) + (delta[f] || 0);
        statRows.set(k, row);
        return row;
      },
      async listForAccount(a) { return [...statRows.values()].filter((r) => r.accountId === a); },
    },

    weaponStats: {
      async applyDelta(a, mode, weaponId, sdv, delta) {
        const k = key(a, mode, weaponId, sdv);
        const row = weaponRows.get(k)
          || { accountId: a, mode, weaponId, statDefinitionVersion: sdv, shots: 0, hits: 0, kills: 0, headshots: 0 };
        for (const f of ['shots', 'hits', 'kills', 'headshots']) row[f] += delta[f] || 0;
        weaponRows.set(k, row);
        return row;
      },
      // Filters by mode exactly as the memory adapter does: `undefined` means every mode, and
      // any other value is matched literally. A fake that ignored the argument is what let
      // `mode: 'all'` reach the adapter as a literal filter and match nothing.
      async listForAccount(a, mode) {
        return [...weaponRows.values()]
          .filter((r) => r.accountId === a && (mode === undefined || r.mode === mode));
      },
    },

    matches: {
      async record(result) { matches.push(result); return result; },
      async listForAccount(a, { limit = 200, cursor = null } = {}) {
        const rows = [];
        for (const m of [...matches].reverse()) {
          const p = (m.players || []).find((x) => x.accountId === a);
          if (!p) continue;
          rows.push({
            matchId: m.matchId, mode: m.mode, status: m.status,
            mapId: m.mapId, mapVersion: m.mapVersion, endedAt: m.endedAt,
            winnerTeam: m.winnerTeam, teamScores: m.teamScores,
            statDefinitionVersion: m.statDefinitionVersion,
            participant: { team: p.team, stats: p },
          });
        }
        const start = cursor ? Number(cursor) : 0;
        const page = rows.slice(start, start + limit);
        return { items: page, nextCursor: start + limit < rows.length ? String(start + limit) : null };
      },
    },
  };
}

const ACCOUNT = '01JPROFILEACCOUNT0000000AA';
const OTHER = '01JPROFILEACCOUNT0000000BB';

function seed(store) {
  // Only real columns. `moderationStatus`/`activeSanctions` were never in any schema, so
  // seeding them here would have kept the ghost-field bug invisible.
  store._accounts.set(ACCOUNT, {
    accountId: ACCOUNT, status: 'active', displayName: 'Mawdev', displayNameFolded: 'mawdev',
    createdAt: '2026-01-01T00:00:00.000Z', nameChangedAt: null,
    privacy: { presenceVisibility: 'everyone', statsVisibility: 'everyone' },
    consentTelemetry: true, consentPolicyVer: 1, consentDecidedAt: '2026-01-01T00:00:00.000Z',
  });
  store._accounts.set(OTHER, {
    accountId: OTHER, status: 'active', displayName: 'Quiet', displayNameFolded: 'quiet',
    createdAt: '2026-01-02T00:00:00.000Z', nameChangedAt: null,
    privacy: { presenceVisibility: 'nobody', statsVisibility: 'nobody' },
    consentTelemetry: null, consentPolicyVer: null, consentDecidedAt: null,
  });
}

const ctxFor = (accountId, extra = {}) => ({
  actor: accountId ? { kind: 'user', accountId } : null,
  params: {}, body: {}, headers: {}, query: new URLSearchParams(),
  correlationId: 'test', ...extra,
});

// ------------------------------------------------------------------ 1. vocabulary

console.log('\nSettings vocabulary is generated from the inventory');

const parsed = parseSettingsInventory(readFileSync(INVENTORY, 'utf8'));
expect(JSON.stringify(parsed) === JSON.stringify(VOCABULARY),
  'vocabulary.generated.js is current with design/settings-inventory.md',
  'regenerate: node platform/src/modules/profile/generateVocabulary.mjs');
expect(VOCABULARY.vocabularyVersion === 1, 'vocabulary version is 1',
  String(VOCABULARY.vocabularyVersion));
expect(Object.keys(VOCABULARY.keybinds).length === 31,
  'all 31 canonical binding action IDs are present (http-api.md §11.9)',
  String(Object.keys(VOCABULARY.keybinds).length));
expect(VOCABULARY.roam.fov.min === 60 && VOCABULARY.roam.fov.max === 120,
  'FOV range comes from the inventory (60–120), not the retired §11.9 table',
  JSON.stringify(VOCABULARY.roam.fov));
expect(!!VOCABULARY.roam.adsSensitivity && !VOCABULARY.roam.adsSensitivityScale,
  'the canonical key is adsSensitivity, not the drifted adsSensitivityScale');
expect(VOCABULARY.scopes.masterVolume === 'DEVICE' && !VOCABULARY.roam.masterVolume,
  'volume controls are DEVICE scope and absent from the roaming set');

// ------------------------------------------------------------------ 2. settings

console.log('\nRoaming settings — If-Match, scope, and range');

{
  const store = makeStore();
  seed(store);
  const mod = createProfileModule({ store, logger: { debug() {} } });

  const initial = await mod.settings.read(ACCOUNT);
  expect(initial.version === 1 && initial.values.fov === 85,
    'unset settings read as version 1 at inventory defaults', JSON.stringify(initial.values.fov));

  // If-Match is required. CONFLICT (409), never 428 — http-api.md §3a.4.
  const missing = await expectCode(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: 1, values: { fov: 100 } }, undefined),
    'CONFLICT', 'PUT without If-Match is refused');
  expect(missing?.status === 409 && missing?.details.reason === 'if-match-required',
    'the refusal is 409 with reason if-match-required, never 428',
    `${missing?.status} ${JSON.stringify(missing?.details)}`);

  // Failing control: the same write WITH If-Match succeeds.
  const written = await expectNoThrow(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: 1, values: { fov: 100 } }, '"1"'),
    'the same PUT with a matching If-Match is accepted');
  expect(written?.version === 2 && written?.values.fov === 100,
    'an accepted write bumps the version and stores the exact value',
    JSON.stringify({ v: written?.version, fov: written?.values.fov }));

  // Stale If-Match returns 409 carrying the current state so the UI can merge.
  const stale = await expectCode(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: 1, values: { fov: 110 } }, '"1"'),
    'CONFLICT', 'a stale If-Match is refused');
  expect(stale?.details.currentVersion === 2 && stale?.details.values.fov === 100,
    'the 409 carries the current version and current values',
    JSON.stringify(stale?.details));

  const after = await mod.settings.read(ACCOUNT);
  expect(after.values.fov === 100, 'the refused stale write changed nothing', String(after.values.fov));

  // Scope: a DEVICE key is rejected, a ROAM key is accepted.
  const deviceKey = await expectCode(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: 1, values: { masterVolume: 50 } }, '"2"'),
    'VALIDATION_FAILED', 'a DEVICE-scoped key (masterVolume) is rejected');
  expect(deviceKey?.details.fields[0].reason === 'scope-not-roaming'
      && deviceKey?.details.fields[0].scope === 'DEVICE',
    'the rejection names the offending scope rather than calling it unknown',
    JSON.stringify(deviceKey?.details.fields));

  await expectCode(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: 1, values: { botCount: 7 } }, '"2"'),
    'VALIDATION_FAILED', 'a PRACTICE-scoped key (botCount) is rejected');

  const roamKey = await expectNoThrow(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: 1, values: { sensitivity: 1.25 } }, '"2"'),
    'a ROAM-scoped key (sensitivity) is accepted');
  expect(roamKey?.values.sensitivity === 1.25, 'the ROAM value is stored verbatim',
    String(roamKey?.values.sensitivity));

  // Out of range is REJECTED, not clamped.
  const outOfRange = await expectCode(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: 1, values: { fov: 200 } }, '"3"'),
    'VALIDATION_FAILED', 'an out-of-range value (fov 200) is rejected');
  expect(outOfRange?.details.fields[0].reason === 'range',
    'the rejection reason is range', JSON.stringify(outOfRange?.details.fields));
  const notClamped = await mod.settings.read(ACCOUNT);
  expect(notClamped.values.fov !== 120 && notClamped.values.fov !== 200,
    'the out-of-range value was not clamped to the maximum and not stored',
    String(notClamped.values.fov));

  await expectCode(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: 1, values: { fov: 85.5 } }, '"3"'),
    'VALIDATION_FAILED', 'an off-step value (fov 85.5, step 1) is rejected');
  await expectCode(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: 1, values: { crosshairStyle: 'sparkle' } }, '"3"'),
    'VALIDATION_FAILED', 'a value outside an enum is rejected');
  await expectNoThrow(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: 1, values: { fov: 120 } }, '"3"'),
    'the maximum in-range value (fov 120) is accepted');

  // Keybinds: canonical action IDs, primary plus optional secondary.
  const binds = await expectNoThrow(
    () => mod.settings.replace(ACCOUNT, {
      schemaVersion: 1,
      values: { keybinds: { crouch: { primary: 'ControlLeft', secondary: 'KeyC' },
                            jump: { primary: 'Space', secondary: null } } },
    }, '"4"'),
    'keybinds keyed by canonical action IDs with primary + optional secondary are accepted');
  expect(binds?.values.keybinds.crouch.secondary === 'KeyC',
    'the secondary binding survives the round trip', JSON.stringify(binds?.values.keybinds.crouch));

  await expectCode(
    () => mod.settings.replace(ACCOUNT, {
      schemaVersion: 1, values: { keybinds: { crouchSlide: { primary: 'KeyC' } } },
    }, '"5"'),
    'VALIDATION_FAILED', 'a non-canonical binding action ID is rejected');
  await expectCode(
    () => mod.settings.replace(ACCOUNT, {
      schemaVersion: 1, values: { keybinds: { pause: { primary: 'KeyP' } } },
    }, '"5"'),
    'VALIDATION_FAILED', 'rebinding the reserved pause action is rejected');
  await expectCode(
    () => mod.settings.replace(ACCOUNT, {
      schemaVersion: 1,
      values: { keybinds: { fire: { primary: 'Mouse1' }, melee: { primary: 'Mouse1' } } },
    }, '"5"'),
    'VALIDATION_FAILED', 'two actions bound to the same code is rejected as a conflict');

  // The ETag the contract puts on the wire.
  const res = await mod.handlers.getSettings(ctxFor(ACCOUNT));
  expect(res.headers.ETag === '"5"' && res.body.version === 5,
    'GET settings returns an ETag matching the row version', JSON.stringify(res.headers));
}

// ------------------------------------------------------------------ 3. privacy

console.log('\nPrivacy — hidden is null, never 403');

{
  const store = makeStore();
  seed(store);
  const mod = createProfileModule({ store, logger: { debug() {} } });

  const ctx = ctxFor(ACCOUNT, { params: { accountId: OTHER }, query: new URLSearchParams() });
  const hidden = await expectNoThrow(() => mod.handlers.getStats(ctx),
    'stats for a subject with statsVisibility=nobody do not throw');
  expect(hidden?.totals === null && hidden?.weapons === null,
    'the hidden career fields are null, not 403', JSON.stringify(hidden));

  const hiddenProfile = await mod.profiles.getPublicProfile(OTHER, ACCOUNT);
  expect(hiddenProfile.stats === null && hiddenProfile.presence === null
      && hiddenProfile.moderation === null && hiddenProfile.displayName === 'Quiet',
    'the public projection nulls hidden fields and still returns the visible ones',
    JSON.stringify(hiddenProfile));

  // Failing control: a public subject shows the same fields populated, and the owner sees their own.
  const visible = await mod.handlers.getStats(
    ctxFor(OTHER, { params: { accountId: ACCOUNT }, query: new URLSearchParams() }));
  expect(visible.totals !== null, 'a subject with statsVisibility=everyone returns real counters',
    JSON.stringify(visible.totals));
  const own = await mod.profiles.getPublicProfile(OTHER, OTHER);
  expect(own.moderation !== null && own.consent === null,
    'the owner sees their own moderation state, and undecided consent projects as null',
    JSON.stringify({ moderation: own.moderation, consent: own.consent }));

  const me = await mod.profiles.getOwnProfile(ACCOUNT);
  expect(me.consent && me.consent.telemetryPersonal === true && me.consent.policyVersion === 1,
    'consent projects from the typed columns as an object', JSON.stringify(me.consent));
  expect(me.moderation.status === 'clear' && me.privacy.statsVisibility === 'everyone',
    'own profile carries privacy and moderation state', JSON.stringify(me));

  await expectCode(() => mod.profiles.getPublicProfile('01JNOSUCHACCOUNT000000000A', ACCOUNT),
    'NOT_FOUND', 'a subject that does not exist is 404');
}

// ------------------------------------------------------------------ 4. contested cases

console.log('\nmatch-result.md §3.1 contested cases');

const roster = [
  { accountId: 'A', team: 'alpha', joinedAt: '2026-08-19T00:00:00.000Z' },
  { accountId: 'B', team: 'alpha', joinedAt: '2026-08-19T00:00:00.000Z' },
  { accountId: 'V', team: 'bravo', joinedAt: '2026-08-19T00:00:00.000Z' },
];
const byId = (rows, id) => rows.find((r) => r.accountId === id);

{
  // Two killing blows on the same tick: first applied takes the kill, the other an assist.
  const rows = resolveMatchStats({ roster, events: [
    { type: 'damage', tick: 100, attacker: 'A', victim: 'V', amount: 60 },
    { type: 'damage', tick: 100, attacker: 'B', victim: 'V', amount: 60 },
    { type: 'kill', tick: 100, attacker: 'A', victim: 'V', source: 'weapon', weaponId: 'ar_vector' },
    { type: 'kill', tick: 100, attacker: 'B', victim: 'V', source: 'weapon', weaponId: 'ar_vector' },
  ] });
  const a = byId(rows, 'A'); const b = byId(rows, 'B'); const v = byId(rows, 'V');
  expect(a.kills === 1 && b.kills === 0, 'simultaneous blows: only the first applied gets the kill',
    `A=${a.kills} B=${b.kills}`);
  expect(b.assists === 1 && a.assists === 0, 'the second blow becomes an assist',
    `A=${a.assists} B=${b.assists}`);
  expect(v.deaths === 1, 'the victim dies exactly once', String(v.deaths));

  // Failing control: without the trade, the same log with one blow gives no assist to B.
  const solo = resolveMatchStats({ roster, events: [
    { type: 'kill', tick: 100, attacker: 'A', victim: 'V', source: 'weapon' },
  ] });
  expect(byId(solo, 'B').assists === 0 && byId(solo, 'A').kills === 1,
    'control: an uncontested kill awards no assist',
    JSON.stringify({ b: byId(solo, 'B').assists, a: byId(solo, 'A').kills }));
}

{
  // One assist maximum per victim per death, however much damage and however many paths.
  const rows = resolveMatchStats({ roster, events: [
    { type: 'damage', tick: 10, attacker: 'B', victim: 'V', amount: 30 },
    { type: 'damage', tick: 11, attacker: 'B', victim: 'V', amount: 30 },
    { type: 'damage', tick: 12, attacker: 'B', victim: 'V', amount: 30 },
    { type: 'kill', tick: 13, attacker: 'A', victim: 'V', source: 'weapon' },
    { type: 'kill', tick: 13, attacker: 'B', victim: 'V', source: 'weapon' },
  ] });
  expect(byId(rows, 'B').assists === 1,
    'three damage events plus a trade blow are still one assist',
    String(byId(rows, 'B').assists));

  // Failing control: after a respawn, the next death earns a second assist.
  const twoLives = resolveMatchStats({ roster, events: [
    { type: 'damage', tick: 10, attacker: 'B', victim: 'V', amount: 30 },
    { type: 'kill', tick: 13, attacker: 'A', victim: 'V', source: 'weapon' },
    { type: 'respawn', tick: 200, actor: 'V' },
    { type: 'damage', tick: 210, attacker: 'B', victim: 'V', amount: 30 },
    { type: 'kill', tick: 213, attacker: 'A', victim: 'V', source: 'weapon' },
  ] });
  expect(byId(twoLives, 'B').assists === 2 && byId(twoLives, 'V').deaths === 2,
    'control: a second life earns a second assist',
    JSON.stringify({ a: byId(twoLives, 'B').assists, d: byId(twoLives, 'V').deaths }));
}

{
  // DoT resolving after the attacker disconnected still credits the attacker.
  const rows = resolveMatchStats({ roster, events: [
    { type: 'damage', tick: 10, attacker: 'A', victim: 'V', amount: 40 },
    { type: 'disconnect', tick: 20, actor: 'A', at: '2026-08-19T00:05:00.000Z' },
    { type: 'kill', tick: 30, attacker: 'A', victim: 'V', source: 'dot', weaponId: 'grenade' },
  ] });
  const a = byId(rows, 'A');
  expect(a.kills === 1 && a.disconnected === true,
    'DoT after disconnect: the attacker keeps the kill', JSON.stringify({ k: a.kills, d: a.disconnected }));
  expect(byId(rows, 'V').deaths === 1, 'the DoT death is a death', String(byId(rows, 'V').deaths));
}

{
  // Disconnect mid-air, die on landing: the death counts and disconnected is true.
  const rows = resolveMatchStats({ roster, events: [
    { type: 'disconnect', tick: 5, actor: 'V', at: '2026-08-19T00:02:00.000Z' },
    { type: 'kill', tick: 9, attacker: null, victim: 'V', source: 'world' },
  ] });
  const v = byId(rows, 'V');
  expect(v.deaths === 1 && v.disconnected === true && v.suicides === 1,
    'disconnect mid-air then die on landing: death counted, disconnected true',
    JSON.stringify({ d: v.deaths, dc: v.disconnected, s: v.suicides }));
  expect(byId(rows, 'A').kills === 0, 'a world death credits nobody', String(byId(rows, 'A').kills));
}

{
  // Killstreak hardware kill goes to the owner, not the hardware and not the last shooter.
  const rows = resolveMatchStats({ roster, events: [
    { type: 'kill', tick: 40, attacker: 'turret:1', owner: 'A', victim: 'V', source: 'killstreak' },
  ] });
  expect(byId(rows, 'A').kills === 1, 'killstreak hardware kill is credited to its owner',
    String(byId(rows, 'A').kills));
  const orphan = resolveMatchStats({ roster, events: [
    { type: 'kill', tick: 40, attacker: 'turret:1', victim: 'V', source: 'killstreak' },
  ] });
  expect(byId(orphan, 'A').kills === 0 && byId(orphan, 'V').deaths === 1,
    'control: hardware with no owner credits nobody, and the death still counts',
    JSON.stringify({ a: byId(orphan, 'A').kills, v: byId(orphan, 'V').deaths }));
}

{
  // Team kill by a player who then leaves: retained.
  const rows = resolveMatchStats({ roster, events: [
    { type: 'kill', tick: 50, attacker: 'A', victim: 'B', source: 'weapon' },
    { type: 'disconnect', tick: 51, actor: 'A', at: '2026-08-19T00:06:00.000Z' },
  ] });
  const a = byId(rows, 'A');
  expect(a.teamKills === 1 && a.kills === 0,
    'team kill is a teamKill and never a kill', JSON.stringify({ tk: a.teamKills, k: a.kills }));
  expect(a.disconnected === true && a.teamKills === 1,
    'leaving does not erase the team kill', JSON.stringify(a.teamKills));
  expect(byId(rows, 'B').deaths === 1 && byId(rows, 'B').suicides === 0,
    "the team-killed player's death counts and is not a suicide",
    JSON.stringify(byId(rows, 'B')));
}

{
  // Round ends mid-plant: no plant, no partial credit.
  const interrupted = resolveMatchStats({ roster, events: [
    { type: 'plant', tick: 60, actor: 'A', completed: false },
  ] });
  expect(byId(interrupted, 'A').plants === 0, 'an interrupted plant is zero plants',
    String(byId(interrupted, 'A').plants));
  const completed = resolveMatchStats({ roster, events: [
    { type: 'plant', tick: 60, actor: 'A', completed: true },
    { type: 'defuse', tick: 70, actor: 'V', completed: true },
  ] });
  expect(byId(completed, 'A').plants === 1 && byId(completed, 'V').defuses === 1,
    'control: a completed plant and defuse each count once',
    JSON.stringify({ p: byId(completed, 'A').plants, d: byId(completed, 'V').defuses }));
}

{
  // Backfilled TDM player: timePlayedSec from join, roundsPlayed unaffected (TDM has no rounds).
  const rows = resolveMatchStats({ roster, events: [
    { type: 'shot', tick: 80, actor: 'A', weaponId: 'ar_vector', hit: true },
  ] });
  expect(byId(rows, 'A').roundsPlayed === 0, 'TDM emits no roundStart, so roundsPlayed stays 0',
    String(byId(rows, 'A').roundsPlayed));
  const backfill = { accountId: 'A', team: 'alpha', joinedAt: '2026-08-19T00:05:00.000Z' };
  const secs = timePlayedSec(backfill, { startedAt: '2026-08-19T00:00:00.000Z', endedAt: '2026-08-19T00:10:00.000Z' });
  expect(secs === 300, 'a backfilled player is timed from join, not from match start', String(secs));
  const full = timePlayedSec({ accountId: 'B', team: 'alpha' },
    { startedAt: '2026-08-19T00:00:00.000Z', endedAt: '2026-08-19T00:10:00.000Z' });
  expect(full === 600, 'control: a player present throughout is timed from match start', String(full));

  // Rounds mode: present at round start is what counts.
  const bombRows = resolveMatchStats({ roster, events: [
    { type: 'roundStart', tick: 0, index: 0, present: ['A', 'V'] },
    { type: 'roundStart', tick: 500, index: 1, present: ['A', 'B', 'V'] },
  ] });
  expect(byId(bombRows, 'A').roundsPlayed === 2 && byId(bombRows, 'B').roundsPlayed === 1,
    'roundsPlayed counts rounds where the player was present at round start',
    JSON.stringify({ a: byId(bombRows, 'A').roundsPlayed, b: byId(bombRows, 'B').roundsPlayed }));
}

{
  // Accuracy and damage inputs: one shot, one hit, overkill excluded.
  const rows = resolveMatchStats({ roster, events: [
    { type: 'shot', tick: 1, actor: 'A', weaponId: 'ar_vector', hit: true },
    { type: 'shot', tick: 2, actor: 'A', weaponId: 'ar_vector', hit: false },
    { type: 'damage', tick: 1, attacker: 'A', victim: 'V', amount: 120, overkill: 20 },
    { type: 'damage', tick: 3, attacker: 'A', victim: 'B', amount: 50 },
  ] });
  const a = byId(rows, 'A');
  expect(a.shotsFired === 2 && a.shotsHit === 1 && a.weapons.ar_vector.shots === 2,
    'shots are counted per trigger pull and per weapon', JSON.stringify(a.weapons));
  expect(a.damageDealt === 100,
    'damage excludes overkill past 0 health and excludes team damage', String(a.damageDealt));
}

// ------------------------------------------------------------------ 5. career application

console.log('\nCareer aggregation — service-only, recomputable, status-aware');

function matchResult({ matchId, status, winnerTeam, outcomeReason, players, mode = 'tdm' }) {
  return {
    matchId, status, mode,
    // `region` is NOT NULL on `matches` (0004) — the real adapter refuses a result without one.
    region: 'yyz',
    mapId: 'the-square', mapVersion: '1.0.0',
    statDefinitionVersion: '1.0.0',
    terminationReason: status, outcomeReason,
    invalidationReason: status === 'invalidated' ? 'cheat-detected' : null,
    winnerTeam, teamScores: { alpha: 75, bravo: 40 },
    startedAt: '2026-08-19T00:00:00.000Z', endedAt: '2026-08-19T00:10:00.000Z',
    players,
  };
}

function playerRow(accountId, team, over = {}) {
  const base = {
    accountId, team,
    kills: 10, deaths: 5, assists: 3, suicides: 0, teamKills: 0,
    headshots: 2, shotsFired: 100, shotsHit: 40, damageDealt: 1200,
    plants: 1, defuses: 0, roundsPlayed: 0, timePlayedSec: 600,
    score: 1400, disconnected: false, abandoned: false,
    weapons: { ar_vector: { shots: 100, hits: 40, kills: 10, headshots: 2 } },
  };
  return { ...base, ...over };
}

{
  const store = makeStore();
  seed(store);
  const mod = createProfileModule({ store, logger: { debug() {} } });
  const service = { kind: 'service', serviceId: 'match-server' };

  // A modified client cannot write stats directly.
  await expectCode(() => mod.stats.applyMatchResult({
    actor: { kind: 'user', accountId: ACCOUNT },
    result: matchResult({ matchId: 'M0', status: 'completed', winnerTeam: 'alpha',
      outcomeReason: 'timer', players: [playerRow(ACCOUNT, 'alpha')] }),
  }), 'AUTH_FORBIDDEN', 'a player-authenticated actor cannot apply a match result');

  await expectCode(() => mod.profiles.patchProfile(ACCOUNT, { kills: 9999 }),
    'VALIDATION_FAILED', 'PATCH /profile/me rejects a stat field outright');
  await expectCode(() => mod.profiles.patchProfile(ACCOUNT, { displayName: 'Legit', kills: 9999 }),
    'VALIDATION_FAILED', 'a stat field smuggled alongside a legal field is still rejected');

  const before = await mod.stats.getCareer(ACCOUNT, 'tdm');
  expect(before.totals.kills === 0, 'the refused writes left the career at zero',
    String(before.totals.kills));

  // Failing control: display name alone goes through, and a service actor can apply.
  const renamed = await expectNoThrow(() => mod.profiles.patchProfile(ACCOUNT, { displayName: 'Legit' }),
    'PATCH with only a display name is accepted');
  expect(renamed?.displayName === 'Legit', 'the display name changed', renamed?.displayName);
  await expectCode(() => mod.profiles.patchProfile(ACCOUNT, { displayName: 'Quiet' }),
    'NAME_TAKEN', "a name another account holds is refused");

  await expectNoThrow(() => mod.stats.applyMatchResult({
    actor: service,
    result: matchResult({ matchId: 'M1', status: 'completed', winnerTeam: 'alpha',
      outcomeReason: 'timer', players: [playerRow(ACCOUNT, 'alpha')] }),
  }), 'a service actor applies a completed result');

  const afterOne = await mod.stats.getCareer(ACCOUNT, 'tdm');
  expect(afterOne.totals.kills === 10 && afterOne.totals.wins === 1 && afterOne.totals.matches === 1,
    'the completed match aggregated', JSON.stringify(afterOne.totals));
  expect(afterOne.totals.score === undefined && !('score' in afterOne.totals),
    'score is not a career counter (match-result.md §6)', JSON.stringify(Object.keys(afterOne.totals)));

  // Invalidated: recorded, not aggregated.
  await mod.stats.applyMatchResult({
    actor: service,
    result: matchResult({ matchId: 'M2', status: 'invalidated', winnerTeam: null,
      outcomeReason: 'no-contest', players: [playerRow(ACCOUNT, 'alpha', { kills: 99 })] }),
  });
  const afterInvalid = await mod.stats.getCareer(ACCOUNT, 'tdm');
  expect(afterInvalid.totals.kills === 10 && afterInvalid.totals.matches === 1,
    'an invalidated match does not aggregate', JSON.stringify(afterInvalid.totals));
  expect(store._matches.some((m) => m.matchId === 'M2'),
    'the invalidated match is still recorded');
  const hist = await mod.stats.history(ACCOUNT, { limit: 10 });
  expect(hist.items.some((i) => i.matchId === 'M2' && i.status === 'invalidated' && i.result === null),
    'the invalidated match appears in history with a null result',
    JSON.stringify(hist.items.map((i) => [i.matchId, i.status, i.result])));

  // Aborted WITH a winner does count W/L (§4.2).
  await mod.stats.applyMatchResult({
    actor: service,
    result: matchResult({ matchId: 'M3', status: 'aborted', winnerTeam: 'bravo',
      outcomeReason: 'forfeit', players: [playerRow(ACCOUNT, 'alpha', { kills: 4, deaths: 7 })] }),
  });
  const afterAbort = await mod.stats.getCareer(ACCOUNT, 'tdm');
  expect(afterAbort.totals.losses === 1 && afterAbort.totals.matches === 2,
    'an aborted match with a winner counts W/L', JSON.stringify(afterAbort.totals));

  // Aborted no-contest: NOT aggregated at all. match-result.md §4.0's matrix reads
  // "Not counted" and bomb-rules §9 says such a match is "recorded but not aggregated" — the
  // record exists, the career does not move. This check previously asserted the opposite and
  // passed, which is worse than no check: it defended the behaviour the contract forbids.
  const beforeNoContest = await mod.stats.getCareer(ACCOUNT, 'tdm');
  await mod.stats.applyMatchResult({
    actor: service,
    result: matchResult({ matchId: 'M4', status: 'aborted', winnerTeam: null,
      outcomeReason: 'no-contest', players: [playerRow(ACCOUNT, 'alpha', { kills: 1, deaths: 1 })] }),
  });
  const afterNoContest = await mod.stats.getCareer(ACCOUNT, 'tdm');
  expect(afterNoContest.totals.matches === beforeNoContest.totals.matches
      && afterNoContest.totals.kills === beforeNoContest.totals.kills,
    'a no-contest abort is NOT aggregated at all (§4.0: Not counted)',
    `${JSON.stringify(beforeNoContest.totals)} -> ${JSON.stringify(afterNoContest.totals)}`);

  // A bomb draw, to prove draws exist and modes are separate.
  await mod.stats.applyMatchResult({
    actor: service,
    result: matchResult({ matchId: 'M5', status: 'completed', winnerTeam: 'draw', mode: 'bomb',
      outcomeReason: 'timer', players: [playerRow(ACCOUNT, 'alpha', { roundsPlayed: 12 })] }),
  });
  const bomb = await mod.stats.getCareer(ACCOUNT, 'bomb');
  const tdm = await mod.stats.getCareer(ACCOUNT, 'tdm');
  expect(bomb.totals.draws === 1 && tdm.totals.draws === 0,
    'a 6-6 bomb match is a draw and does not leak into TDM totals',
    JSON.stringify({ bomb: bomb.totals.draws, tdm: tdm.totals.draws }));

  // §6 reconciliation: recompute from history equals the stored totals.
  for (const mode of ['tdm', 'bomb', 'all']) {
    const stored = await mod.stats.getCareer(ACCOUNT, mode);
    const recomputed = await mod.stats.recomputeCareer(ACCOUNT, mode);
    // `all` is per-mode on BOTH sides (§11.5 forbids a cross-mode sum), so reconcile per mode.
    if (mode === 'all') {
      expect(JSON.stringify(stored.modes) === JSON.stringify(recomputed.modes),
        'career recomputed from history equals stored totals (all, per-mode)',
        `${JSON.stringify(stored.modes)}\n       vs ${JSON.stringify(recomputed.modes)}`);
      continue;
    }
    expect(JSON.stringify(stored.totals) === JSON.stringify(recomputed.totals),
      `career totals recomputed from history equal stored totals (${mode})`,
      `${JSON.stringify(stored.totals)}\n       vs ${JSON.stringify(recomputed.totals)}`);
    expect(JSON.stringify(stored.weapons) === JSON.stringify(recomputed.weapons),
      `weapon totals recompute equally (${mode})`,
      `${JSON.stringify(stored.weapons)} vs ${JSON.stringify(recomputed.weapons)}`);
  }

  // Failing control for the reconciliation check: corrupt the stored row and the check must fail.
  await store.stats.applyDelta(ACCOUNT, 'tdm', '1.0.0', { ...emptyTotals(), kills: 500 });
  const corrupted = await mod.stats.getCareer(ACCOUNT, 'tdm');
  const recheck = await mod.stats.recomputeCareer(ACCOUNT, 'tdm');
  expect(corrupted.totals.kills !== recheck.totals.kills,
    'control: a directly written stat row is caught by the recompute',
    `${corrupted.totals.kills} vs ${recheck.totals.kills}`);

  // Derived values are computed, never stored.
  const ratios = deriveRatios(recheck.totals);
  expect(!('kd' in recheck.totals) && !('accuracy' in recheck.totals) && !('winRate' in recheck.totals),
    'no ratio is stored on the counters', JSON.stringify(Object.keys(recheck.totals)));
  expect(Math.abs(ratios.accuracy - recheck.totals.shotsHit / recheck.totals.shotsFired) < 1e-9
      && Math.abs(ratios.kd - recheck.totals.kills / recheck.totals.deaths) < 1e-9,
    'K/D and accuracy are derived at read time from the counters', JSON.stringify(ratios));
  expect(deriveRatios(emptyTotals()).winRate === 0 && deriveRatios(emptyTotals()).kd === 0,
    'the derivations do not divide by zero on an empty career');
}

// ------------------------------------------------------------------ 6. resolver -> career

console.log('\nResolved events feed the career unchanged');

{
  const rows = resolveMatchStats({ roster, events: [
    { type: 'shot', tick: 1, actor: 'A', weaponId: 'ar_vector', hit: true },
    { type: 'damage', tick: 1, attacker: 'A', victim: 'V', amount: 100 },
    { type: 'kill', tick: 1, attacker: 'A', victim: 'V', source: 'weapon', weaponId: 'ar_vector', headshot: true },
  ] });
  const delta = careerDelta(byId(rows, 'A'), { status: 'completed', winnerTeam: 'alpha' });
  const totals = addTotals(emptyTotals(), delta);
  expect(totals.kills === 1 && totals.headshots === 1 && totals.wins === 1 && totals.matches === 1,
    'a resolved event log becomes exactly one career delta', JSON.stringify(totals));
  expect(careerDelta(byId(rows, 'A'), { status: 'invalidated', winnerTeam: 'alpha' }) === null,
    'careerDelta refuses to produce a delta for an invalidated match');
}

// ------------------------------------------------------------------ 7. migration

console.log('\nProgression migration — one-time, unverified, non-authoritative');

{
  const store = makeStore();
  seed(store);
  const mod = createProfileModule({ store, logger: { debug() {} } });
  const service = { kind: 'service', serviceId: 'match-server' };

  await mod.stats.applyMatchResult({
    actor: service,
    result: matchResult({ matchId: 'S1', status: 'completed', winnerTeam: 'alpha',
      outcomeReason: 'timer', players: [playerRow(ACCOUNT, 'alpha')] }),
  });
  const authoritative = await mod.stats.getCareer(ACCOUNT, 'tdm');

  const blob = {
    schema: 1, xp: 250000,
    lifetime: { kills: 99999, deaths: 1, wins: 4000, matches: 4000, shotsFired: 10, shotsHit: 10 },
    weapons: { ar_vector: { xp: 5, kills: 99999, headshots: 5, shotsFired: 5, shotsHit: 5 } },
    challenges: { veteran: { done: true, claimedAt: 1 } },
  };
  const imported = await expectNoThrow(() => mod.migration.importLegacyProgression(ACCOUNT, blob),
    'the local progression blob imports');
  expect(imported?.verified === false, 'the import is flagged unverified',
    JSON.stringify(imported?.verified));
  expect(imported?.data.lifetime.kills === 99999 && imported?.data.challenges[0] === 'veteran',
    'the import preserves the local numbers for display', JSON.stringify(imported?.data.lifetime.kills));

  const afterImport = await mod.stats.getCareer(ACCOUNT, 'tdm');
  expect(JSON.stringify(afterImport.totals) === JSON.stringify(authoritative.totals),
    'the import never overwrites server-authoritative career totals',
    `${JSON.stringify(afterImport.totals)} vs ${JSON.stringify(authoritative.totals)}`);
  const recomputed = await mod.stats.recomputeCareer(ACCOUNT, 'tdm');
  expect(JSON.stringify(recomputed.totals) === JSON.stringify(afterImport.totals),
    'career totals stay recomputable from history after an import',
    JSON.stringify(recomputed.totals));

  const second = await mod.migration.importLegacyProgression(ACCOUNT, {
    lifetime: { kills: 5 }, weapons: {}, challenges: {},
  });
  expect(second.alreadyImported === true && second.data.lifetime.kills === 99999,
    'a second import returns the first rather than adding to it',
    JSON.stringify({ again: second.alreadyImported, kills: second.data.lifetime.kills }));

  const junk = await mod.migration.importLegacyProgression(OTHER, {
    lifetime: { kills: 'lots', deaths: -5 }, weapons: { 42: 'nope' }, xp: NaN,
  });
  expect(junk.data.lifetime.kills === 0 && junk.data.lifetime.deaths === 0 && junk.data.xp === 0,
    'control: a hostile blob coerces to zeros instead of throwing or storing garbage',
    JSON.stringify(junk.data.lifetime));
}

// ------------------------------------------------------------------ 8. idempotency (§5)

console.log('\nmatch-result.md §5 — a retry applies once');

{
  const store = makeStore();
  seed(store);
  const mod = createProfileModule({ store, logger: { debug() {} } });
  const service = { kind: 'service', serviceId: 'match-server' };
  const result = matchResult({ matchId: 'IDEM1', status: 'completed', winnerTeam: 'alpha',
    outcomeReason: 'timer', players: [playerRow(ACCOUNT, 'alpha')] });

  const first = await mod.stats.applyMatchResult({ actor: service, result });
  const second = await mod.stats.applyMatchResult({ actor: service, result });
  const afterTwo = await mod.stats.getCareer(ACCOUNT, 'tdm');
  expect(afterTwo.totals.kills === 10 && afterTwo.totals.matches === 1 && afterTwo.totals.wins === 1,
    'the identical result submitted twice is applied exactly once', JSON.stringify(afterTwo.totals));
  expect(JSON.stringify(first) === JSON.stringify(second),
    '§5.4: the replay returns the STORED response rather than a fresh application',
    `${JSON.stringify(first)} vs ${JSON.stringify(second)}`);
  expect(store._matches.filter((m) => m.matchId === 'IDEM1').length === 1,
    'the immutable match record is written once, not once per retry',
    String(store._matches.filter((m) => m.matchId === 'IDEM1').length));
  expect(store._idem.size === 1 && [...store._idem.values()][0].key === idempotencyKeyFor('IDEM1'),
    '§5.2: the key is derived from the matchId, so a retry is inherently the same key',
    JSON.stringify([...store._idem.values()].map((r) => r.key)));

  // §8.1: submit the identical payload ten times concurrently.
  await Promise.all(Array.from({ length: 10 },
    () => mod.stats.applyMatchResult({ actor: service, result })));
  const afterTen = await mod.stats.getCareer(ACCOUNT, 'tdm');
  expect(JSON.stringify(afterTen.totals) === JSON.stringify(afterTwo.totals),
    'ten concurrent duplicate submissions change nothing', JSON.stringify(afterTen.totals));
  const recomputed = await mod.stats.recomputeCareer(ACCOUNT, 'tdm');
  expect(JSON.stringify(recomputed.totals) === JSON.stringify(afterTen.totals),
    '§6: the recompute still equals the stored totals after the retries',
    `${JSON.stringify(recomputed.totals)}\n       vs ${JSON.stringify(afterTen.totals)}`);

  // §5.5: a DIFFERENT payload for a finalised match is a conflict, not a second truth.
  await expectCode(() => mod.stats.applyMatchResult({
    actor: service,
    result: { ...result, players: [playerRow(ACCOUNT, 'alpha', { kills: 99 })] },
  }), 'CONFLICT', 'a different payload for a finalised match is refused');
  const afterConflict = await mod.stats.getCareer(ACCOUNT, 'tdm');
  expect(afterConflict.totals.kills === 10, 'the refused re-submission changed nothing',
    String(afterConflict.totals.kills));

  await expectCode(() => mod.stats.applyMatchResult({
    actor: service, result, idempotencyKey: 'whatever-i-like',
  }), 'VALIDATION_FAILED', 'an Idempotency-Key that is not match-result:<matchId> is refused');

  // CONTROL: a different match still applies, so the deduplication is per match and not a
  // service that has simply stopped accepting results.
  await expectNoThrow(() => mod.stats.applyMatchResult({
    actor: service,
    result: matchResult({ matchId: 'IDEM2', status: 'completed', winnerTeam: 'alpha',
      outcomeReason: 'timer', players: [playerRow(ACCOUNT, 'alpha', { kills: 3 })] }),
  }), 'CONTROL: a different matchId applies normally');
  const afterSecond = await mod.stats.getCareer(ACCOUNT, 'tdm');
  expect(afterSecond.totals.kills === 13 && afterSecond.totals.matches === 2,
    'CONTROL: the second, genuinely different match aggregated', JSON.stringify(afterSecond.totals));
}

// The same proof against the real adapter, whose `matches` surface is being added separately.
{
  const store = createMemoryStore({ storage: 'memory' });
  if (typeof store.matches?.record === 'function' && typeof store.matches?.listForAccount === 'function') {
    const account = await store.accounts.create({
      accountId: ACCOUNT, displayName: 'Mawdev', displayNameFolded: 'mawdev',
    });
    const mod = createProfileModule({ store, logger: { debug() {} } });
    const service = { kind: 'service', serviceId: 'match-server' };
    const result = matchResult({ matchId: 'REALIDEM1', status: 'completed', winnerTeam: 'alpha',
      outcomeReason: 'timer', players: [playerRow(account.accountId, 'alpha')] });

    await mod.stats.applyMatchResult({ actor: service, result });
    await Promise.all(Array.from({ length: 10 },
      () => mod.stats.applyMatchResult({ actor: service, result })));
    const totals = await mod.stats.getCareer(account.accountId, 'tdm');
    expect(totals.totals.kills === 10 && totals.totals.matches === 1,
      'REAL STORE: eleven submissions of one result apply it once', JSON.stringify(totals.totals));
    await expectCode(() => mod.stats.applyMatchResult({
      actor: service, result: { ...result, teamScores: { alpha: 1, bravo: 0 } },
    }), 'CONFLICT', 'REAL STORE: a different payload for the same match is refused');
  } else {
    console.log('  ---- store.matches is not on the adapter yet; the real-store idempotency '
      + 'proof did not run (fake-store proof above still applies)');
  }
  await store.close();
}

// ------------------------------------------------------------------ 9. the §4.0 status matrix

console.log('\nmatch-result.md §4.0 — only a terminal status aggregates');

{
  const player = playerRow(ACCOUNT, 'alpha');
  for (const status of ['pending', 'in-progress', 'allocated', undefined, null, 'Completed']) {
    await expectCode(() => careerDelta(player, { status, winnerTeam: 'alpha' }),
      'VALIDATION_FAILED', `careerDelta refuses status ${JSON.stringify(status)}`);
  }
  // CONTROL: the three terminal statuses behave as the matrix says.
  expect(careerDelta(player, { status: 'completed', winnerTeam: 'alpha' })?.wins === 1,
    'CONTROL: a completed match still mints a win');
  expect(careerDelta(player, { status: 'aborted', winnerTeam: 'bravo', outcomeReason: 'forfeit' })?.losses === 1,
    'CONTROL: an aborted forfeit still mints a loss');
  expect(careerDelta(player, { status: 'invalidated', winnerTeam: null }) === null,
    'CONTROL: an invalidated match still returns no delta');

  // The matrix invariants themselves.
  await expectCode(() => careerDelta(player, { status: 'completed', winnerTeam: null }),
    'VALIDATION_FAILED', 'a completed match with no winner violates the matrix');
  await expectCode(() => careerDelta(player, { status: 'completed', winnerTeam: 'alpha', outcomeReason: 'forfeit' }),
    'VALIDATION_FAILED', 'a completed match cannot end by forfeit');
  await expectCode(() => careerDelta(player, { status: 'aborted', winnerTeam: 'draw', outcomeReason: 'forfeit' }),
    'VALIDATION_FAILED', 'an aborted match is never a draw');
  await expectCode(() => careerDelta(player, { status: 'aborted', winnerTeam: 'alpha', outcomeReason: 'no-contest' }),
    'VALIDATION_FAILED', 'a no-contest abort cannot carry a winner');
  await expectCode(() => careerDelta(player, {
    status: 'completed', winnerTeam: 'alpha', outcomeReason: 'timer', invalidationReason: 'cheat-detected',
  }), 'VALIDATION_FAILED', 'a completed match cannot carry an invalidation reason');
  await expectCode(() => careerDelta(player, {
    status: 'completed', winnerTeam: 'alpha', terminationReason: 'aborted', outcomeReason: 'timer',
  }), 'VALIDATION_FAILED', 'terminationReason must agree with status');

  // And through the write path: a non-terminal status applies nothing and records nothing.
  const store = makeStore();
  seed(store);
  const mod = createProfileModule({ store, logger: { debug() {} } });
  const service = { kind: 'service', serviceId: 'match-server' };
  await expectCode(() => mod.stats.applyMatchResult({
    actor: service,
    result: { ...matchResult({ matchId: 'P1', status: 'completed', winnerTeam: 'alpha',
      outcomeReason: 'timer', players: [playerRow(ACCOUNT, 'alpha')] }),
      status: 'pending', terminationReason: 'pending' },
  }), 'VALIDATION_FAILED', 'applyMatchResult refuses a pending result outright');
  const totals = await mod.stats.getCareer(ACCOUNT, 'tdm');
  expect(totals.totals.matches === 0 && store._matches.length === 0,
    'the refused pending result minted neither a career match nor a record',
    JSON.stringify({ matches: totals.totals.matches, recorded: store._matches.length }));

  // §6 reconciliation is only meaningful if both paths agree on what aggregates. `pending` is
  // skipped by the recompute, so the incremental path must refuse it rather than count it.
  await expectNoThrow(() => mod.stats.applyMatchResult({
    actor: service,
    result: matchResult({ matchId: 'P2', status: 'completed', winnerTeam: 'alpha',
      outcomeReason: 'timer', players: [playerRow(ACCOUNT, 'alpha')] }),
  }), 'CONTROL: the same result with status completed applies');
  const stored = await mod.stats.getCareer(ACCOUNT, 'tdm');
  const recomputed = await mod.stats.recomputeCareer(ACCOUNT, 'tdm');
  expect(JSON.stringify(stored.totals) === JSON.stringify(recomputed.totals),
    'the incremental path and the recompute agree on exactly one match',
    `${JSON.stringify(stored.totals)}\n       vs ${JSON.stringify(recomputed.totals)}`);
}

// ------------------------------------------------------------------ 10. display name

console.log('\nDisplay-name change writes a column that exists, and the cooldown fires');

{
  const store = makeStore();
  seed(store);
  let t = Date.parse('2026-08-19T00:00:00.000Z');
  const clock = { now: () => t };
  const mod = createProfileModule({ store, clock, logger: { debug() {} } });

  const before = await mod.profiles.getOwnProfile(ACCOUNT);
  expect(before.flags.nameChangeAvailableAt === null,
    'an account that never changed its name has no cooldown', JSON.stringify(before.flags));

  const renamed = await expectNoThrow(() => mod.profiles.patchProfile(ACCOUNT, { displayName: 'Renamed' }),
    'the display name change goes through');
  const row = store._accounts.get(ACCOUNT);
  expect(row.nameChangedAt === new Date(t).toISOString(),
    'the change stamps name_changed_at — the column migration 0008 declares', String(row.nameChangedAt));
  expect(!('nameChangeAvailableAt' in row),
    'nothing writes nameChangeAvailableAt, which is a column in no schema',
    JSON.stringify(Object.keys(row)));
  expect(renamed?.flags.nameChangeAvailableAt === new Date(t + 30 * 24 * 3600e3).toISOString(),
    'nameChangeAvailableAt is DERIVED at read time as name_changed_at + 30 days',
    JSON.stringify(renamed?.flags));

  // The cooldown is now reachable, which it never was while the read side was undefined.
  t += 29 * 24 * 3600e3;
  const cooling = await expectCode(() => mod.profiles.patchProfile(ACCOUNT, { displayName: 'Again' }),
    'NAME_CHANGE_COOLDOWN', 'a second change inside 30 days is refused');
  expect(cooling?.retryAfterMs === 24 * 3600e3,
    'the refusal carries the real time remaining', String(cooling?.retryAfterMs));
  expect(store._accounts.get(ACCOUNT).displayName === 'Renamed',
    'the refused change did not rename the account', store._accounts.get(ACCOUNT).displayName);

  // CONTROL: past the cooldown the same change is accepted, so the refusal is the 30 days and
  // not a rename path that has stopped working.
  t += 2 * 24 * 3600e3;
  const later = await expectNoThrow(() => mod.profiles.patchProfile(ACCOUNT, { displayName: 'Again' }),
    'CONTROL: the same change past the cooldown is accepted');
  expect(later?.displayName === 'Again' && store._accounts.get(ACCOUNT).nameChangedAt === new Date(t).toISOString(),
    'CONTROL: the accepted change re-stamps name_changed_at',
    JSON.stringify({ name: later?.displayName, at: store._accounts.get(ACCOUNT).nameChangedAt }));

  // Moderation comes from accounts.status (0001), not from a field nothing writes.
  store._accounts.set(OTHER, { ...store._accounts.get(OTHER), status: 'restricted' });
  const restricted = await mod.profiles.getOwnProfile(OTHER);
  expect(restricted.moderation.status === 'restricted' && Array.isArray(restricted.moderation.activeSanctions),
    'moderation status projects from accounts.status', JSON.stringify(restricted.moderation));
  const clear = await mod.profiles.getOwnProfile(ACCOUNT);
  expect(clear.moderation.status === 'clear', 'CONTROL: an active account is clear',
    JSON.stringify(clear.moderation));

  // statDefinitionVersion is the stats service's, not a column on the account.
  const view = await mod.profiles.getPublicProfile(ACCOUNT, ACCOUNT);
  expect(view.stats.statDefinitionVersion === STAT_DEFINITION_VERSION,
    'the public projection reports the real stat definition version, never undefined',
    JSON.stringify(view.stats));
  expect('presence' in view && view.presence === null,
    'presence has no column, so the key is present and honestly null', JSON.stringify(view.presence));
}

// ------------------------------------------------------------------ 11. If-Match is a CAS

console.log('\nhttp-api.md §11.2 — If-Match is compare-and-set, not read-then-write');

{
  const store = createMemoryStore({ storage: 'memory' });
  const account = await store.accounts.create({
    accountId: ACCOUNT, displayName: 'Racer', displayNameFolded: 'racer',
  });
  const mod = createProfileModule({ store, logger: { debug() {} } });

  // Two writers, both holding the same fresh ETag. One must win and one must be told.
  const [a, b] = await Promise.allSettled([
    mod.settings.replace(account.accountId, { schemaVersion: 1, values: { fov: 100 } }, '"1"'),
    mod.settings.replace(account.accountId, { schemaVersion: 1, values: { fov: 110 } }, '"1"'),
  ]);
  const winners = [a, b].filter((r) => r.status === 'fulfilled');
  const losers = [a, b].filter((r) => r.status === 'rejected');
  expect(winners.length === 1 && losers.length === 1,
    'exactly one of two concurrent writers with the same If-Match succeeds',
    JSON.stringify([a.status, b.status]));
  expect(losers[0]?.reason?.code === 'CONFLICT' && losers[0]?.reason?.status === 409,
    'the loser is told with a 409, not silently discarded',
    `${losers[0]?.reason?.code} ${losers[0]?.reason?.status}`);

  const final = await mod.settings.read(account.accountId);
  expect(final.version === 2, 'exactly one version was consumed by the pair', String(final.version));
  expect(final.values.fov === winners[0].value.values.fov,
    'the stored value is the winner\'s, and the loser wrote nothing',
    `${final.values.fov} vs ${winners[0].value.values.fov}`);

  // CONTROL: sequential writes, each with the current ETag, both land.
  const next = await mod.settings.replace(account.accountId, { schemaVersion: 1, values: { fov: 95 } }, '"2"');
  expect(next.version === 3 && next.values.fov === 95,
    'CONTROL: a write with the current version is accepted', JSON.stringify({ v: next.version, fov: next.values.fov }));
  await expectCode(
    () => mod.settings.replace(account.accountId, { schemaVersion: 1, values: { fov: 90 } }, '"2"'),
    'CONFLICT', 'CONTROL: the now-stale version is refused');
  await store.close();
}

// ------------------------------------------------------------------ 12. privacy fails closed

console.log('\nPrivacy fails CLOSED — an unrecognised visibility hides, never publishes');

{
  for (const bad of ['friends', 'NOBODY', 'Everyone', null, undefined, 42, '']) {
    expect(normalizePrivacy({ statsVisibility: bad, presenceVisibility: 'everyone' }).statsVisibility === 'nobody',
      `statsVisibility ${JSON.stringify(bad)} normalises to nobody, not everyone`);
  }
  expect(normalizePrivacy({}).statsVisibility === 'nobody' && normalizePrivacy(null).presenceVisibility === 'nobody',
    'a missing or unreadable privacy blob hides rather than publishes');
  // CONTROL: the documented members survive untouched, so this is not a blanket "hide all".
  expect(normalizePrivacy({ statsVisibility: 'everyone', presenceVisibility: 'friends' }).statsVisibility === 'everyone'
      && normalizePrivacy({ statsVisibility: 'everyone', presenceVisibility: 'friends' }).presenceVisibility === 'friends',
    'CONTROL: recognised visibilities are preserved exactly');

  // End to end: a subject whose stored blob says "friends" does not leak a career.
  const store = makeStore();
  seed(store);
  store._accounts.set(OTHER, {
    ...store._accounts.get(OTHER),
    privacy: { presenceVisibility: 'friends', statsVisibility: 'friends' },
  });
  const mod = createProfileModule({ store, logger: { debug() {} } });
  const leaked = await mod.handlers.getStats(
    ctxFor(ACCOUNT, { params: { accountId: OTHER }, query: new URLSearchParams() }));
  expect(leaked.totals === null && leaked.weapons === null,
    'a statsVisibility the enum does not contain hides the career', JSON.stringify(leaked));
  // CONTROL: the same call for a subject who really did choose `everyone` returns counters.
  const shown = await mod.handlers.getStats(
    ctxFor(OTHER, { params: { accountId: ACCOUNT }, query: new URLSearchParams() }));
  expect(shown.totals !== null, 'CONTROL: an explicit everyone still returns counters');
}

// ------------------------------------------------------------------ 13. mode=all weapons

console.log('\n§11.5 — mode=all is the default, and it must carry the weapon breakdown');

{
  const store = makeStore();
  seed(store);
  const mod = createProfileModule({ store, logger: { debug() {} } });
  const service = { kind: 'service', serviceId: 'match-server' };

  await mod.stats.applyMatchResult({ actor: service,
    result: matchResult({ matchId: 'W1', status: 'completed', winnerTeam: 'alpha',
      outcomeReason: 'timer', players: [playerRow(ACCOUNT, 'alpha')] }) });
  await mod.stats.applyMatchResult({ actor: service,
    result: matchResult({ matchId: 'W2', status: 'completed', winnerTeam: 'alpha', mode: 'bomb',
      outcomeReason: 'timer', players: [playerRow(ACCOUNT, 'alpha')] }) });

  const all = await mod.stats.getCareer(ACCOUNT, 'all');
  // This previously asserted that `all` SUMS weapon rows across modes — the precise thing
  // §11.5 forbids ("does not sum across modes — a combined K/D over two rulesets with
  // different death semantics is a number that means nothing"). The check passed and defended
  // the violation.
  expect(all.modes?.tdm?.weapons?.ar_vector?.kills === 10
      && all.modes?.bomb?.weapons?.ar_vector?.kills === 10
      && all.weapons === undefined && all.totals === undefined,
    'mode=all returns PER-MODE weapon rows and never a cross-mode sum',
    JSON.stringify(all));
  const tdm = await mod.stats.getCareer(ACCOUNT, 'tdm');
  expect(tdm.weapons.ar_vector?.kills === 10,
    'CONTROL: a real mode filter still returns only that mode\'s weapon rows', JSON.stringify(tdm.weapons));

  // The default view of the endpoint is the one that was permanently empty.
  const view = await mod.handlers.getStats(
    ctxFor(OTHER, { params: { accountId: ACCOUNT }, query: new URLSearchParams() }));
  expect(Object.keys(view.modes?.tdm?.weapons || {}).length > 0
      && Object.keys(view.modes?.bomb?.weapons || {}).length > 0,
    'GET /v1/profile/:id/stats with no mode returns populated PER-MODE weapon maps',
    JSON.stringify(view));
}

// ------------------------------------------------------------------ 14. binding vocabulary

console.log('\n§11.9 — the binding vocabulary is an allowlist, not an object lookup');

{
  const store = makeStore();
  seed(store);
  const mod = createProfileModule({ store, logger: { debug() {} } });

  for (const action of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    const err = await expectCode(() => mod.settings.replace(ACCOUNT, {
      schemaVersion: 1, values: { keybinds: JSON.parse(`{"${action}": {"primary": "KeyB"}}`) },
    }, '"1"'), 'VALIDATION_FAILED', `the inherited member "${action}" is not a binding action`);
    expect(err?.details.fields[0].reason === 'unknown-binding-action',
      `"${action}" is rejected as unknown, not accepted as a definition`,
      JSON.stringify(err?.details.fields));
  }
  const settingsKey = await expectCode(() => mod.settings.replace(ACCOUNT, {
    schemaVersion: 1, values: { constructor: 1 },
  }, '"1"'), 'VALIDATION_FAILED', 'an inherited member is not a roaming settings key either');
  expect(settingsKey?.details.fields[0].reason === 'unknown-key',
    'and it is reported as an unknown key rather than a scope violation',
    JSON.stringify(settingsKey?.details.fields));

  const state = await mod.settings.read(ACCOUNT);
  expect(state.version === 1 && Object.keys(state.values.keybinds ?? {}).length === 0,
    'none of the refused writes stored anything', JSON.stringify(state.values.keybinds));

  // CONTROL: a canonical action ID with the same value shape is accepted.
  const good = await expectNoThrow(() => mod.settings.replace(ACCOUNT, {
    schemaVersion: 1, values: { keybinds: { crouch: { primary: 'KeyB' } } },
  }, '"1"'), 'CONTROL: a canonical binding action with the same shape is accepted');
  expect(good?.values.keybinds.crouch.primary === 'KeyB', 'CONTROL: and it is stored verbatim',
    JSON.stringify(good?.values.keybinds));

  expect(Object.getPrototypeOf(VOCABULARY.keybinds) === null
      && Object.getPrototypeOf(VOCABULARY.roam) === null
      && Object.getPrototypeOf(VOCABULARY.scopes) === null,
    'the vocabulary lookup maps have no prototype to answer for keys they do not contain');
}

// ------------------------------------------------------------------ 15. resolver defects

console.log('\n§3 — an unrostered enemy is not a suicide, and a round restores life');

{
  // A killstreak kill submitted without its owner: an enemy turret is an ENEMY attacker.
  const orphan = resolveMatchStats({ roster, events: [
    { type: 'kill', tick: 40, attacker: 'turret:1', victim: 'V', source: 'killstreak' },
  ] });
  const v = byId(orphan, 'V');
  expect(v.deaths === 1 && v.suicides === 0,
    'a killstreak kill with no owner is a death and NOT the victim\'s suicide',
    JSON.stringify({ deaths: v.deaths, suicides: v.suicides }));
  expect(byId(orphan, 'A').kills === 0 && byId(orphan, 'B').kills === 0,
    'and no rostered player is credited for it',
    JSON.stringify({ a: byId(orphan, 'A').kills, b: byId(orphan, 'B').kills }));

  // CONTROL: a genuine self-inflicted death is still a suicide.
  const real = resolveMatchStats({ roster, events: [
    { type: 'kill', tick: 40, attacker: 'V', victim: 'V', source: 'self' },
  ] });
  expect(byId(real, 'V').suicides === 1 && byId(real, 'V').deaths === 1,
    'CONTROL: a self-inflicted death is still a suicide',
    JSON.stringify(byId(real, 'V')));

  // Bomb: rounds, not respawns, restore players. A second round's kill and death must count.
  const bomb = resolveMatchStats({ roster, events: [
    { type: 'roundStart', tick: 0, index: 0, present: ['A', 'B', 'V'] },
    { type: 'kill', tick: 50, attacker: 'A', victim: 'V', source: 'weapon', weaponId: 'ar_vector' },
    { type: 'roundStart', tick: 600, index: 1, present: ['A', 'B', 'V'] },
    { type: 'kill', tick: 650, attacker: 'A', victim: 'V', source: 'weapon', weaponId: 'ar_vector' },
    { type: 'roundStart', tick: 1200, index: 2, present: ['A', 'B', 'V'] },
    { type: 'damage', tick: 1240, attacker: 'B', victim: 'V', amount: 40 },
    { type: 'kill', tick: 1250, attacker: 'A', victim: 'V', source: 'weapon', weaponId: 'ar_vector' },
  ] });
  expect(byId(bomb, 'V').deaths === 3 && byId(bomb, 'A').kills === 3,
    'every round\'s kill and death counts, not just the first',
    JSON.stringify({ deaths: byId(bomb, 'V').deaths, kills: byId(bomb, 'A').kills }));
  expect(byId(bomb, 'A').weapons.ar_vector.kills === 3,
    'and the per-weapon breakdown agrees', JSON.stringify(byId(bomb, 'A').weapons));
  expect(byId(bomb, 'B').assists === 1,
    'a new round is a new assist budget, so the third round\'s assist is awarded',
    String(byId(bomb, 'B').assists));

  // CONTROL: without the round transition the corpse rule still holds — a second blow on a
  // player who never came back is not a second death.
  const corpse = resolveMatchStats({ roster, events: [
    { type: 'kill', tick: 50, attacker: 'A', victim: 'V', source: 'weapon' },
    { type: 'kill', tick: 650, attacker: 'A', victim: 'V', source: 'weapon' },
  ] });
  expect(byId(corpse, 'V').deaths === 1 && byId(corpse, 'A').kills === 1,
    'CONTROL: with no respawn and no round transition, the second blow is not a stat',
    JSON.stringify({ deaths: byId(corpse, 'V').deaths, kills: byId(corpse, 'A').kills }));
}

console.log('');
if (failures) {
  console.log(`${failures} FAILURE${failures === 1 ? '' : 'S'}\n`);
  process.exit(1);
}
console.log('all profile checks passed\n');
