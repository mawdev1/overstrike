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
import { resolveMatchStats, careerDelta, timePlayedSec, emptyTotals, addTotals, deriveRatios, CAREER_KEYS }
  from '../src/modules/profile/stats.js';
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

function makeStore() {
  const accounts = new Map();
  const profiles = new Map();
  const statRows = new Map();        // `${account}|${mode}|${sdv}`
  const weaponRows = new Map();      // `${account}|${mode}|${weapon}|${sdv}`
  const matches = [];                // newest last; listForAccount reverses

  const key = (...p) => p.join('|');

  return {
    _accounts: accounts, _matches: matches,
    async tx(fn) { return fn({ fake: true }); },

    accounts: {
      async byId(id) { return accounts.get(id) || null; },
      async byNameFolded(folded) {
        for (const a of accounts.values()) if (a.displayNameFolded === folded) return a;
        return null;
      },
      async update(id, patch) {
        const a = { ...accounts.get(id), ...patch };
        accounts.set(id, a);
        return a;
      },
    },

    profiles: {
      async byAccountId(id) { return profiles.get(id) || null; },
      async upsert(id, patch) {
        const p = { accountId: id, ...(profiles.get(id) || {}), ...patch };
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
      async listForAccount(a) { return [...weaponRows.values()].filter((r) => r.accountId === a); },
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
  store._accounts.set(ACCOUNT, {
    accountId: ACCOUNT, displayName: 'Mawdev', displayNameFolded: 'mawdev',
    createdAt: '2026-01-01T00:00:00.000Z',
    privacy: { presenceVisibility: 'everyone', statsVisibility: 'everyone' },
    consentTelemetry: true, consentPolicyVer: 1, consentDecidedAt: '2026-01-01T00:00:00.000Z',
    moderationStatus: 'clear', activeSanctions: [],
  });
  store._accounts.set(OTHER, {
    accountId: OTHER, displayName: 'Quiet', displayNameFolded: 'quiet',
    createdAt: '2026-01-02T00:00:00.000Z',
    privacy: { presenceVisibility: 'nobody', statsVisibility: 'nobody' },
    consentTelemetry: null, consentPolicyVer: null, consentDecidedAt: null,
    moderationStatus: 'clear', activeSanctions: [],
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

  // Aborted no-contest: stats and a match played, but no W/L/D.
  await mod.stats.applyMatchResult({
    actor: service,
    result: matchResult({ matchId: 'M4', status: 'aborted', winnerTeam: null,
      outcomeReason: 'no-contest', players: [playerRow(ACCOUNT, 'alpha', { kills: 1, deaths: 1 })] }),
  });
  const afterNoContest = await mod.stats.getCareer(ACCOUNT, 'tdm');
  expect(afterNoContest.totals.matches === 3
      && afterNoContest.totals.wins + afterNoContest.totals.losses + afterNoContest.totals.draws === 2,
    'a no-contest abort counts a match played with no W/L/D',
    JSON.stringify(afterNoContest.totals));

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

console.log('');
if (failures) {
  console.log(`${failures} FAILURE${failures === 1 ? '' : 'S'}\n`);
  process.exit(1);
}
console.log('all profile checks passed\n');
