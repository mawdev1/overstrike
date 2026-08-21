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
// The real outbox, not a spy: §5.3 requires the result, the career and the event to be ONE
// transaction, and a spy that records calls cannot tell whether they committed together.
import { createOutbox } from '../src/modules/events/outbox.js';
import { createAuthModule } from '../src/modules/auth/index.js';
import { loadConfig } from '../src/core/config.js';
import { normalizePrivacy, validatePrivacyPatch } from '../src/modules/profile/profile.js';
import {
  resolveMatchStats, careerDelta, timePlayedSec, emptyTotals, addTotals, deriveRatios,
  CAREER_KEYS, idempotencyKeyFor, resultHash, STAT_DEFINITION_VERSION,
} from '../src/modules/profile/stats.js';
import { validateRoamingSettings } from '../src/modules/profile/settings.js';
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
  const events = [];                 // events_outbox rows

  const key = (...p) => p.join('|');

  // The documented adapter serialises every transaction (store/memory.js). Without that here,
  // "the same result submitted ten times concurrently" would be testing the fake's interleaving
  // rather than the service's idempotency.
  let chain = Promise.resolve();

  return {
    _accounts: accounts, _matches: matches, _idem: idem, _events: events,

    // §5.3 makes the outbox a wiring REQUIREMENT of the stats service — a career applied with
    // no event is the state the outbox pattern exists to make impossible — so the fake has to
    // hold one. A fake without it could only test the mode the contract forbids.
    outbox: {
      async insert(row) { events.push(row); return row; },
    },

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
      async record(result) { matches.push({ ...result, resultAppliedAt: null }); return result; },
      async byId(id) { return matches.find((m) => m.matchId === id) || null; },
      // Mirrors the adapter: a second application is refused rather than silently re-stamped,
      // because "the career already moved for this match" is the fact the §5 idempotency row
      // and this column both exist to record.
      async markResultApplied(matchId, at) {
        const m = matches.find((x) => x.matchId === matchId);
        if (!m) throw new Error(`No such match: ${matchId}`);
        if (m.resultAppliedAt) throw new Error(`Result already applied: ${matchId}`);
        m.resultAppliedAt = at;
      },
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

/** The real modules log; the suite's output is the assertions, not their debug stream. */
const silent = { debug() {}, info() {}, warn() {}, error() {}, child() { return silent; } };

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

/**
 * Every module in this file is constructed WITH an outbox.
 *
 * `createStatsService` now refuses to construct without one (match-result.md §5.3): a
 * deployment missing it applied careers with no durable trace and nothing said so. These
 * constructions used to omit it, which meant the suite's default configuration was the one
 * configuration the contract does not permit.
 */
const moduleWith = (store, extra = {}) => {
  const mod = createProfileModule({
    store, logger: silent, outbox: createOutbox({ store, logger: null }), ...extra,
  });
  // Most service-level fixtures predate the HTTP header. Keep them explicit about the same
  // derived key without obscuring the raw boundary proof below.
  const raw = mod.stats.applyMatchResult;
  mod.stats.applyMatchResultRaw = raw;
  mod.stats.applyMatchResult = (args) => raw({
    ...args,
    idempotencyKey: args?.idempotencyKey
      ?? (args?.result?.matchId ? idempotencyKeyFor(args.result.matchId) : null),
  });
  return mod;
};

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
  const mod = moduleWith(store);

  const initial = await mod.settings.read(ACCOUNT);
  expect(initial.version === 1 && initial.values.fov === 85,
    'unset settings read as version 1 at inventory defaults', JSON.stringify(initial.values.fov));
  expect(typeof initial.updatedAt === 'string' && !Number.isNaN(Date.parse(initial.updatedAt)),
    'unset settings still expose the contract-required stable updatedAt instant');

  // If-Match is required. CONFLICT (409), never 428 — http-api.md §3a.4.
  const missing = await expectCode(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: 1, values: { fov: 100 } }, undefined),
    'CONFLICT', 'PUT without If-Match is refused');
  expect(missing?.status === 409 && missing?.details.reason === 'if-match-required',
    'the refusal is 409 with reason if-match-required, never 428',
    `${missing?.status} ${JSON.stringify(missing?.details)}`);

  // `*` is REFUSED. It means "any existing representation", and settings always have one, so
  // it is a compare-and-set that can never fail — last-write-wins wearing an If-Match header,
  // which is the silently discarded rebind §11.2 exists to prevent. It used to succeed
  // unconditionally, so a client sending `*` believed it was protected and was not.
  const wildcard = await expectCode(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: 1, values: { fov: 100 } }, '*'),
    'VALIDATION_FAILED', 'If-Match: * is refused, not treated as a match');
  expect(wildcard?.status === 400 && wildcard?.details?.fields?.[0]?.reason === 'wildcard-not-supported',
    'the refusal says the wildcard is the problem', JSON.stringify(wildcard?.details));

  // A malformed header is its own answer. Reporting `if-match-required` for a header that WAS
  // sent tells the client to add something it already added.
  const malformed = await expectCode(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: 1, values: { fov: 100 } }, 'banana'),
    'VALIDATION_FAILED', 'a malformed If-Match is refused as malformed, not as absent');
  expect(malformed?.details?.fields?.[0]?.reason === 'malformed',
    'and it is not reported as if-match-required', JSON.stringify(malformed?.details));

  const unchanged = await mod.settings.read(ACCOUNT);
  expect(unchanged.version === 1 && unchanged.values.fov === 85,
    'neither refused write stored anything or consumed a version',
    JSON.stringify({ v: unchanged.version, fov: unchanged.values.fov }));

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

  /**
   * Every handler reads the account id from the AUTHENTICATED ACTOR, never from the path or the
   * body, and refuses when there is none.
   *
   * Over HTTP the auth middleware puts the actor there, so this refusal only ever fires for a
   * request that reached a handler without one — a route mounted without `mw`, or a handler
   * called directly. That is precisely the mistake worth failing loudly on: without it,
   * `ctx.actor?.accountId` is `undefined` and the handler goes to the store with it, which for
   * `getOwnProfile` is a 404 for "not signed in" and for `getSettings` is a 200 carrying the
   * documented DEFAULTS to an unauthenticated caller.
   */
  for (const [name, handler] of [
    ['getOwnProfile', mod.handlers.getOwnProfile],
    ['getSettings', mod.handlers.getSettings],
    ['getStats', mod.handlers.getStats],
    ['getActiveMatch', mod.handlers.getActiveMatch],
  ]) {
    await expectCode(() => handler(ctxFor(null, { params: { accountId: ACCOUNT } })),
      'AUTH_REQUIRED', `${name} with no authenticated actor is AUTH_REQUIRED`);
  }
  // CONTROL: the same handler with an actor answers, so the four refusals are about the missing
  // actor and not about handlers that have stopped working.
  const signedIn = await expectNoThrow(() => mod.handlers.getOwnProfile(ctxFor(ACCOUNT)),
    'control: the same handler with an authenticated actor answers');
  expect(signedIn?.accountId === ACCOUNT,
    'control: and it answers for the ACTOR, not for anything in the path',
    JSON.stringify(signedIn?.accountId));

  /**
   * §11.5's `mode` is a closed set. An unknown one is REFUSED rather than passed to the store:
   * `mode=ctf` reaching `getCareer` matches no stat row, so the player is told they have a
   * career of zeroes in a mode that does not exist — a 200 for a request that was wrong.
   */
  for (const mode of ['ctf', 'ALL', 'tdm,bomb']) {
    const err = await expectCode(
      () => mod.handlers.getStats(ctxFor(ACCOUNT, {
        params: { accountId: ACCOUNT }, query: new URLSearchParams(`mode=${mode}`),
      })),
      'VALIDATION_FAILED', `mode=${JSON.stringify(mode)} is refused as an unknown mode`);
    expect(err?.details?.fields?.[0]?.key === 'mode' && err?.details?.fields?.[0]?.reason === 'enum',
      `  …naming mode and the enum rule`, JSON.stringify(err?.details));
  }
  // CONTROL: each member of the set answers.
  for (const mode of ['tdm', 'bomb', 'all']) {
    const got = await expectNoThrow(() => mod.handlers.getStats(ctxFor(ACCOUNT, {
      params: { accountId: ACCOUNT }, query: new URLSearchParams(`mode=${mode}`),
    })), `control: mode=${mode} is answered`);
    expect(got?.accountId === ACCOUNT,
      `control: and the ${mode} career is for the subject asked for`, JSON.stringify(got?.accountId));
  }
}

// --------------------------------------------------- 2a. each rejection names its own rule

/**
 * §11.9's rejections, one rule at a time.
 *
 * The block above proves the settings service refuses malformed writes. It does NOT prove which
 * rule refused them, and for a validator that is nearly the whole question: a family of
 * assertions that all say `VALIDATION_FAILED` is satisfied by ONE surviving check, and the rest
 * of the validator can be deleted line by line without a single test going red. Deleting the
 * boolean type check, the number type check, the colour check, the keybind-shape checks and the
 * reserved-code check left every assertion in this file green — and three of those five do not
 * merely mis-report, they ACCEPT: `fov: "100"` compared as a string, satisfied the range and the
 * step, and was stored as a string; `crosshairColor: "red"` was stored; `Escape` was bound to
 * crouch.
 *
 * So each rejection below is asserted as an exact `(key, reason)` pair, and each is paired with
 * the accepted value of the same setting.
 */
console.log('\ndesign/settings-inventory.md §11.9 — every rejection names its own key and rule');

{
  /** Exactly one error, on exactly that key, for exactly that reason — nothing weaker. */
  const onlyError = (values, key, reason, label, extra = () => true) => {
    const { errors } = validateRoamingSettings(values);
    const hit = errors.length === 1 && errors[0].key === key && errors[0].reason === reason
      && extra(errors[0]);
    expect(hit, label, JSON.stringify(errors));
  };
  const accepts = (values, label) => {
    const { errors } = validateRoamingSettings(values);
    expect(errors.length === 0, label, JSON.stringify(errors));
  };

  // `values` itself must be a plain object. Each of the three non-objects fails differently
  // without the guard: `null` throws, `[]` validates clean, a string validates its characters.
  for (const [bad, label] of [[null, 'null'], [[], 'an array'], ['fov=100', 'a string'], [7, 'a number']]) {
    onlyError(bad, 'values', 'type', `a values payload that is ${label} is refused on 'values' itself`,
      (e) => e.expected === 'object');
  }

  onlyError({ invertY: 'yes' }, 'invertY', 'type',
    'a boolean setting given a string is a TYPE error on that key', (e) => e.expected === 'boolean');
  onlyError({ invertY: 1 }, 'invertY', 'type', 'a boolean setting given 1 is a type error too');
  accepts({ invertY: true }, 'control: the same boolean setting given a boolean is accepted');

  // The number check is the one with teeth: without it `"100"` is compared with `<` and `>`
  // against the range, coerces, passes the step, and is stored — a string in a numeric column.
  onlyError({ fov: '100' }, 'fov', 'type',
    'a numeric setting sent as a STRING is a type error, not a value inside the range',
    (e) => e.expected === 'number');
  onlyError({ fov: Number.NaN }, 'fov', 'type', 'NaN is a type error, not an off-step value');
  onlyError({ fov: Number.POSITIVE_INFINITY }, 'fov', 'type', 'Infinity is a type error, not a range error');
  onlyError({ fov: 200 }, 'fov', 'range', 'an in-type value outside the range is a RANGE error',
    (e) => e.min === 60 && e.max === 120 && e.got === 200);
  onlyError({ fov: 85.5 }, 'fov', 'step', 'an in-range value off the step is a STEP error',
    (e) => e.step === 1 && e.got === 85.5);
  accepts({ fov: 85 }, 'control: the same setting on-step and in-range is accepted');

  onlyError({ crosshairStyle: 'sparkle' }, 'crosshairStyle', 'enum',
    'a value outside an enum is an ENUM error carrying the allowed set',
    (e) => Array.isArray(e.allowed) && e.allowed.includes('dot') && e.got === 'sparkle');
  accepts({ crosshairStyle: 'dot' }, 'control: an enum member is accepted');

  onlyError({ crosshairColor: 'red' }, 'crosshairColor', 'color',
    'a colour that is not #RRGGBB is a COLOUR error', (e) => e.got === 'red');
  onlyError({ crosshairColor: '#GGGGGG' }, 'crosshairColor', 'color',
    'six non-hex characters behind a # is still a colour error');
  onlyError({ crosshairColor: '#8EF7C' }, 'crosshairColor', 'color',
    'a five-digit hex colour is a colour error');
  onlyError({ crosshairColor: 0x8EF7C4 }, 'crosshairColor', 'color',
    'a colour sent as a number is a colour error');
  accepts({ crosshairColor: '#8ef7c4' }, 'control: a lower-case #RRGGBB colour is accepted');

  // ── keybinds ────────────────────────────────────────────────────────────────────────
  onlyError({ keybinds: [] }, 'keybinds', 'type',
    'a keybinds ARRAY is refused — an empty one otherwise validates clean and is stored',
    (e) => e.expected === 'object');
  onlyError({ keybinds: null }, 'keybinds', 'type', 'a null keybinds is refused, not dereferenced');
  onlyError({ keybinds: 'KeyC' }, 'keybinds', 'type', 'a keybinds string is refused');
  onlyError({ keybinds: { crouch: [] } }, 'keybinds.crouch', 'type',
    'a bind ENTRY that is an array is refused on that action',
    (e) => e.expected === '{primary, secondary?}');

  onlyError({ keybinds: { crouch: { primary: 'KeyC', tertiary: 'KeyX' } } },
    'keybinds.crouch.tertiary', 'unknown-field',
    'an unknown slot on a bind entry is refused, naming the slot');
  onlyError({ keybinds: { crouch: { secondary: 'KeyC' } } },
    'keybinds.crouch.primary', 'required',
    'a bind entry with no primary is refused — a secondary alone is a binding nobody can press');
  onlyError({ keybinds: { crouch: { primary: 'Escape' } } },
    'keybinds.crouch.primary', 'reserved-code',
    'binding a RESERVED browser code is refused as reserved, not merely as invalid',
    (e) => e.got === 'Escape');
  onlyError({ keybinds: { crouch: { primary: 'F12' } } },
    'keybinds.crouch.primary', 'reserved-code', 'F12 is reserved too');
  onlyError({ keybinds: { crouch: { secondary: 'MetaLeft', primary: 'KeyC' } } },
    'keybinds.crouch.secondary', 'reserved-code', 'and the SECONDARY slot is checked as well');
  onlyError({ keybinds: { crouch: { primary: 'KeyQQ' } } },
    'keybinds.crouch.primary', 'invalid-code',
    'a code outside the wire vocabulary is INVALID, which is a different answer from reserved');
  accepts({ keybinds: { crouch: { primary: 'KeyC', secondary: null } } },
    'control: a well-formed bind with an unbound secondary is accepted');
  accepts({ keybinds: {} }, 'control: an empty keybinds object is accepted');

  /**
   * `onStep` short-circuits when the spec carries no step increment. The inventory's number rows
   * all declare one today, so this is reached through the `vocab` parameter the validator takes
   * for exactly this reason — the alternative is that a continuous setting added to the
   * inventory tomorrow rejects EVERY value, because `(value - min) / 0` is Infinity and the
   * comparison against its own rounding is false for all of them.
   */
  const continuousVocab = {
    roam: { smoothing: { kind: 'number', min: 0, max: 1, step: 0, default: 0.5 } },
    keybinds: Object.create(null), scopes: {},
  };
  const continuous = validateRoamingSettings({ smoothing: 0.37194 }, continuousVocab);
  expect(continuous.errors.length === 0,
    'a number spec with no step increment accepts any in-range value, rather than rejecting all',
    JSON.stringify(continuous.errors));
  const stillRanged = validateRoamingSettings({ smoothing: 4 }, continuousVocab);
  expect(stillRanged.errors.length === 1 && stillRanged.errors[0].reason === 'range',
    'control: and the RANGE on that same spec is still enforced',
    JSON.stringify(stillRanged.errors));
}

{
  /**
   * The two service-level refusals that run before the validator, each of which had a test
   * asserting only that something was thrown.
   */
  const store = makeStore();
  seed(store);
  const mod = moduleWith(store);

  // An If-Match header that is present but EMPTY (or all whitespace) is the absent case, not the
  // malformed one: there is no version in it to compare, so the answer is §11.2's
  // `if-match-required` CONFLICT and not a 400 telling the client its header is unreadable.
  for (const header of ['', '   ', '\t']) {
    const err = await expectCode(
      () => mod.settings.replace(ACCOUNT, { schemaVersion: 1, values: { fov: 100 } }, header),
      'CONFLICT', `an If-Match of ${JSON.stringify(header)} is the required-header refusal`);
    expect(err?.details?.reason === 'if-match-required',
      `  …and it says so: reason is if-match-required, not malformed`,
      JSON.stringify(err?.details));
  }
  // CONTROL: a header that was sent and cannot be read is the OTHER answer, so the two cases
  // stay distinguishable to the client that has to decide what to do next.
  const malformed = await expectCode(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: 1, values: { fov: 100 } }, 'banana'),
    'VALIDATION_FAILED', 'control: a non-empty unreadable If-Match is VALIDATION_FAILED');
  expect(malformed?.details?.fields?.[0]?.key === 'If-Match'
      && malformed?.details?.fields?.[0]?.reason === 'malformed',
    '  …naming the header and calling it malformed', JSON.stringify(malformed?.details));

  // The schema version is checked AFTER If-Match and BEFORE the values, and it is a refusal:
  // without it a payload declaring a schema this build has never seen is validated against V1's
  // vocabulary and stored as if it were V1.
  const wrongSchema = await expectCode(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: 2, values: { fov: 100 } }, '"1"'),
    'VALIDATION_FAILED', 'a settings write declaring an unsupported schemaVersion is refused');
  expect(wrongSchema?.details?.fields?.[0]?.key === 'schemaVersion'
      && wrongSchema?.details?.fields?.[0]?.reason === 'unsupported'
      && wrongSchema?.details?.fields?.[0]?.expected === 1,
    '  …naming schemaVersion, the rule, and the version this build supports',
    JSON.stringify(wrongSchema?.details));
  await expectCode(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: undefined, values: { fov: 100 } }, '"1"'),
    'VALIDATION_FAILED', 'a settings write with no schemaVersion at all is refused');
  const untouched = await mod.settings.read(ACCOUNT);
  expect(untouched.version === 1 && untouched.values.fov !== 100,
    'and none of the refused writes advanced the version or stored a value',
    JSON.stringify({ v: untouched.version, fov: untouched.values.fov }));

  // CONTROL: the same values with the supported schema version go through.
  const good = await expectNoThrow(
    () => mod.settings.replace(ACCOUNT, { schemaVersion: 1, values: { fov: 100 } }, '"1"'),
    'control: the same write declaring schemaVersion 1 is accepted');
  expect(good?.version === 2 && good?.values.fov === 100,
    'control: and it advanced the version and stored the value',
    JSON.stringify({ v: good?.version, fov: good?.values.fov }));
}

// ------------------------------------------------------------------ 3. privacy

console.log('\nPrivacy — hidden is null, never 403');

{
  const store = makeStore();
  seed(store);
  const mod = moduleWith(store);

  const ctx = ctxFor(ACCOUNT, { params: { accountId: OTHER }, query: new URLSearchParams() });
  const hidden = await expectNoThrow(() => mod.handlers.getStats(ctx),
    'stats for a subject with statsVisibility=nobody do not throw');
  // The default mode is `all`, whose CONTRACTED shape is per-mode (`modes: { tdm, bomb }`) and
  // carries no top-level `totals` at all (§11.5). This check used to assert `totals === null`
  // on that response, which the old ad-hoc hidden object satisfied and the contracted one
  // cannot — so the suite was defending a shape no typed client could consume. The claim
  // "hidden is null counters, never a 403" is now made against the shape the contract states.
  expect(hidden?.modes?.tdm?.totals === null && hidden?.modes?.bomb?.totals === null
      && hidden?.modes?.tdm?.weapons === null,
    'the hidden career is per-mode null counters, not a 403 and not another shape',
    JSON.stringify(hidden));
  const hiddenOneMode = await mod.handlers.getStats(ctxFor(ACCOUNT, {
    params: { accountId: OTHER }, query: new URLSearchParams('mode=tdm') }));
  expect(hiddenOneMode.totals === null && hiddenOneMode.weapons === null
      && hiddenOneMode.mode === 'tdm',
    'and a single-mode hidden career is the §11.5 shape with null counters',
    JSON.stringify(hiddenOneMode));

  const hiddenProfile = await mod.profiles.getPublicProfile(OTHER, ACCOUNT);
  expect(hiddenProfile.stats === null && hiddenProfile.presence === null
      && hiddenProfile.displayName === 'Quiet',
    'the public projection nulls hidden fields and still returns the visible ones',
    JSON.stringify(hiddenProfile));

  // §11.8 closes this schema to five keys. This check previously asserted that the projection
  // ALSO carried `moderation`, `consent` and a `statsVisible` flag, which is the contract
  // violation stated as an expectation: `statsVisible` publishes the very setting the subject
  // asked us to respect, and the other two belong to `GET /profile/me`, which already returns
  // them. The assertion is now the closed field set itself.
  expect(JSON.stringify(Object.keys(hiddenProfile).sort())
      === JSON.stringify(['accountId', 'createdAt', 'displayName', 'presence', 'stats']),
    'the public projection carries EXACTLY the §11.8 fields and no others',
    JSON.stringify(Object.keys(hiddenProfile)));
  const selfProfile = await mod.profiles.getPublicProfile(ACCOUNT, ACCOUNT);
  expect(JSON.stringify(Object.keys(selfProfile).sort())
      === JSON.stringify(['accountId', 'createdAt', 'displayName', 'presence', 'stats']),
    'CONTROL: the schema does not grow extra keys for the owner either',
    JSON.stringify(Object.keys(selfProfile)));
  expect(!('statsVisible' in selfProfile) && !('statsVisible' in hiddenProfile),
    'the subject\'s visibility setting is never a field of the public body');

  // Failing control: a public subject shows the same fields populated, and the owner sees their own.
  const visible = await mod.handlers.getStats(
    ctxFor(OTHER, { params: { accountId: ACCOUNT }, query: new URLSearchParams() }));
  // Against the per-mode shape, and by KEY SET as well as by value: `visible.totals !== null`
  // was true of `undefined`, so it passed for a response with no counters in it at all.
  expect(visible.modes?.tdm?.totals !== null && visible.modes?.bomb?.totals !== null,
    'a subject with statsVisibility=everyone returns real counters',
    JSON.stringify(visible));
  expect(JSON.stringify(Object.keys(visible).sort()) === JSON.stringify(Object.keys(hidden).sort()),
    'the hidden and visible careers are the SAME shape, differing only in the counters',
    `${JSON.stringify(Object.keys(visible))} vs ${JSON.stringify(Object.keys(hidden))}`);
  // Moderation and consent are OWN-profile fields (§4). Asserting them on the public
  // projection is what kept them in a schema §11.8 closes; the claim itself is still worth
  // making, so it is made against the endpoint that owns them.
  const own = await mod.profiles.getOwnProfile(OTHER);
  expect(own.moderation !== null && own.consent === null,
    'the owner sees their own moderation state, and undecided consent projects as null',
    JSON.stringify({ moderation: own.moderation, consent: own.consent }));
  const visibility = await mod.profiles.visibilityFor(OTHER, OTHER);
  expect(visibility.stats === true && visibility.presence === true,
    'the owner viewing themselves sees everything: privacy is about other people',
    JSON.stringify(visibility));
  const strangerView = await mod.profiles.visibilityFor(OTHER, ACCOUNT);
  expect(strangerView.stats === false && strangerView.presence === false,
    'CONTROL: a stranger gets the subject\'s real setting', JSON.stringify(strangerView));

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

{
  /**
   * §3's per-weapon breakdown is keyed BY WEAPON, and not every event has one: a fall, a world
   * kill, a killstreak resolving without hardware and a melee all arrive with no `weaponId`.
   * Those produce no weapon row — not a row under the key `undefined`, which is what an absent
   * id becomes when it is used as an object key, and which `weaponStats.applyDelta` would then
   * write to `weapon_stats` as a weapon nobody can name or ever remove.
   */
  const unattributed = resolveMatchStats({ roster, events: [
    { type: 'shot', tick: 1, actor: 'A', hit: true },
    { type: 'kill', tick: 2, attacker: 'A', victim: 'V', source: 'weapon', headshot: true },
  ] });
  const a = byId(unattributed, 'A');
  expect(Object.keys(a.weapons).length === 0,
    'an event with no weaponId adds no weapon row — and never one called "undefined"',
    JSON.stringify(Object.keys(a.weapons)));
  expect(a.shotsFired === 1 && a.shotsHit === 1 && a.kills === 1 && a.headshots === 1,
    '  …while the player-level counters for the same events are unaffected',
    JSON.stringify({ s: a.shotsFired, h: a.shotsHit, k: a.kills, hs: a.headshots }));

  // CONTROL: the identical events WITH a weapon id do produce exactly one breakdown, so the
  // emptiness above is about the missing id and not about a resolver that has stopped
  // attributing weapons at all.
  const attributed = resolveMatchStats({ roster, events: [
    { type: 'shot', tick: 1, actor: 'A', weaponId: 'ar_vector', hit: true },
    { type: 'kill', tick: 2, attacker: 'A', victim: 'V', source: 'weapon', weaponId: 'ar_vector', headshot: true },
  ] });
  const w = byId(attributed, 'A').weapons;
  expect(Object.keys(w).length === 1 && w.ar_vector.shots === 1 && w.ar_vector.hits === 1
      && w.ar_vector.kills === 1 && w.ar_vector.headshots === 1,
    'control: the same events with a weaponId produce exactly one breakdown, fully counted',
    JSON.stringify(w));
}

{
  /**
   * Events naming somebody the ROSTER does not contain.
   *
   * A server event log is not a closed world: it names turrets, killstreak hardware, bots
   * purged from the roster, and — for environment damage — no attacker at all. Every handler
   * in the resolver therefore resolves an id through `get()` and stops if it cannot, and each
   * of those four stops was unasserted: deleting any one of them left the suite green while it
   * either credited a stat to a row that is not in the result or threw a TypeError on `null`.
   *
   * The assertion is the SPECIFIC number the contract gives — a counter that stays 0 and a
   * weapon breakdown that is never created — not "it did not crash".
   */
  const ghostShooter = resolveMatchStats({ roster, events: [
    { type: 'shot', tick: 1, actor: 'turret:1', weaponId: 'ar_vector', hit: true },
  ] });
  expect(ghostShooter.length === 3
      && ghostShooter.every((r) => r.shotsFired === 0 && r.shotsHit === 0),
    'a shot by somebody not on the roster is nobody\'s shot',
    JSON.stringify(ghostShooter.map((r) => [r.accountId, r.shotsFired])));

  const ghostVictimDamage = resolveMatchStats({ roster, events: [
    { type: 'damage', tick: 1, attacker: 'A', victim: 'turret:1', amount: 80 },
  ] });
  expect(byId(ghostVictimDamage, 'A').damageDealt === 0,
    'damage to something not on the roster is not damage dealt to a player',
    String(byId(ghostVictimDamage, 'A').damageDealt));

  // Environment damage: `attacker: null`. Nobody is credited, and — the part that matters for
  // the assist ledger — it does not enter the victim's contributor list, so the next player to
  // finish them off does not hand an assist to the environment.
  const worldDamage = resolveMatchStats({ roster, events: [
    { type: 'damage', tick: 1, attacker: null, victim: 'V', amount: 80 },
    { type: 'kill', tick: 2, attacker: 'A', victim: 'V', source: 'weapon' },
  ] });
  expect(worldDamage.every((r) => r.damageDealt === 0),
    'environment damage with no attacker is credited to nobody',
    JSON.stringify(worldDamage.map((r) => [r.accountId, r.damageDealt])));
  expect(worldDamage.every((r) => r.assists === 0) && byId(worldDamage, 'A').kills === 1,
    'and it buys nobody an assist on the kill that follows',
    JSON.stringify(worldDamage.map((r) => [r.accountId, r.assists])));

  // Self-damage is the other half of the same guard: an attacker who is their own victim adds
  // nothing to their own damageDealt and does not become their own assist contributor.
  const selfDamage = resolveMatchStats({ roster, events: [
    { type: 'damage', tick: 1, attacker: 'V', victim: 'V', amount: 40 },
    { type: 'kill', tick: 2, attacker: 'A', victim: 'V', source: 'weapon' },
  ] });
  expect(byId(selfDamage, 'V').damageDealt === 0 && byId(selfDamage, 'V').assists === 0,
    'self damage is neither damage dealt nor an assist on one\'s own death',
    JSON.stringify({ d: byId(selfDamage, 'V').damageDealt, a: byId(selfDamage, 'V').assists }));

  const ghostVictimKill = resolveMatchStats({ roster, events: [
    { type: 'kill', tick: 1, attacker: 'A', victim: 'turret:1', source: 'weapon', weaponId: 'ar_vector' },
  ] });
  const killer = byId(ghostVictimKill, 'A');
  expect(killer.kills === 0 && killer.weapons.ar_vector === undefined,
    'destroying something that is not a rostered player is not a kill, and mints no weapon row',
    JSON.stringify({ k: killer.kills, w: Object.keys(killer.weapons) }));

  // CONTROL: the identical logs with rostered ids produce the stats the guards suppressed
  // above, so none of the five is consistent with a resolver that has stopped counting.
  const real = resolveMatchStats({ roster, events: [
    { type: 'shot', tick: 1, actor: 'A', weaponId: 'ar_vector', hit: true },
    { type: 'damage', tick: 1, attacker: 'A', victim: 'V', amount: 80 },
    { type: 'kill', tick: 2, attacker: 'A', victim: 'V', source: 'weapon', weaponId: 'ar_vector' },
  ] });
  const realA = byId(real, 'A');
  expect(realA.shotsFired === 1 && realA.damageDealt === 80 && realA.kills === 1
      && realA.weapons.ar_vector.kills === 1,
    'control: the same three events between rostered players count exactly once each',
    JSON.stringify({ s: realA.shotsFired, d: realA.damageDealt, k: realA.kills }));
}

{
  /**
   * §3's assist WINDOW. Damage that is older than `assistWindowTicks` at the moment of the kill
   * is not an assist — otherwise a player who chipped somebody at the start of the round is paid
   * for a death two minutes later that they had nothing to do with.
   *
   * The pair below straddles the boundary at the default 320 ticks: 400 ticks earlier earns
   * nothing, 320 ticks earlier (the boundary is `>`, so 320 is still inside) earns one.
   */
  const stale = resolveMatchStats({ roster, events: [
    { type: 'damage', tick: 100, attacker: 'B', victim: 'V', amount: 60 },
    { type: 'kill', tick: 500, attacker: 'A', victim: 'V', source: 'weapon' },
  ] });
  expect(byId(stale, 'B').assists === 0,
    'damage 400 ticks before the kill is outside the assist window and earns nothing',
    String(byId(stale, 'B').assists));
  expect(byId(stale, 'A').kills === 1 && byId(stale, 'V').deaths === 1,
    '  …while the kill and the death themselves are unaffected',
    JSON.stringify({ k: byId(stale, 'A').kills, d: byId(stale, 'V').deaths }));

  const inside = resolveMatchStats({ roster, events: [
    { type: 'damage', tick: 180, attacker: 'B', victim: 'V', amount: 60 },
    { type: 'kill', tick: 500, attacker: 'A', victim: 'V', source: 'weapon' },
  ] });
  expect(byId(inside, 'B').assists === 1,
    'control: damage exactly 320 ticks before the kill is inside the window and earns one',
    String(byId(inside, 'B').assists));

  // And the window is the caller's parameter, not a constant: the same stale log with a wider
  // window does award the assist, which is what proves the comparison reads the argument.
  const widened = resolveMatchStats({ roster, assistWindowTicks: 400, events: [
    { type: 'damage', tick: 100, attacker: 'B', victim: 'V', amount: 60 },
    { type: 'kill', tick: 500, attacker: 'A', victim: 'V', source: 'weapon' },
  ] });
  expect(byId(widened, 'B').assists === 1,
    'control: the same log with assistWindowTicks=400 does award the assist',
    String(byId(widened, 'B').assists));
}

{
  /**
   * §3 `timePlayedSec`: seconds connected and in the match. The guard returns 0 rather than a
   * number for the three inputs that have no answer — an unparseable timestamp, a missing one,
   * and a `leftAt` before the `joinedAt`. Without it those produce `NaN` and `-600`, and a NaN
   * or a negative reaching `applyDelta` corrupts a career total that nothing later recomputes
   * back to sanity.
   */
  const span = { startedAt: '2026-08-19T00:00:00.000Z', endedAt: '2026-08-19T00:10:00.000Z' };
  expect(timePlayedSec({ joinedAt: 'banana' }, span) === 0,
    'an unparseable joinedAt is 0 seconds, not NaN',
    String(timePlayedSec({ joinedAt: 'banana' }, span)));
  expect(timePlayedSec({}, { startedAt: span.startedAt, endedAt: undefined }) === 0,
    'a match with no endedAt is 0 seconds, not NaN',
    String(timePlayedSec({}, { startedAt: span.startedAt, endedAt: undefined })));
  expect(timePlayedSec({ joinedAt: span.endedAt, leftAt: span.startedAt }, span) === 0,
    'a leftAt before the joinedAt is 0 seconds, never a negative time played',
    String(timePlayedSec({ joinedAt: span.endedAt, leftAt: span.startedAt }, span)));
  // CONTROL: the well-formed span still measures. (The `to === from` case is not asserted
  // separately: `Math.round(0 / 1000)` is 0 either way, so it cannot distinguish anything.)
  expect(timePlayedSec({ joinedAt: span.startedAt, leftAt: span.endedAt }, span) === 600,
    'control: a well-formed join/leave pair is still measured', String(timePlayedSec({}, span)));
}

// ------------------------------------------------------------------ 5. career application

console.log('\nCareer aggregation — service-only, recomputable, status-aware');

const STARTED_AT = '2026-08-19T00:00:00.000Z';
const ENDED_AT = '2026-08-19T00:10:00.000Z';

/**
 * `rulesSnapshot` is discriminated by mode and carries EVERY key of its variant (§4).
 *
 * This fixture used to be `{ scoreLimit: 75 }` — a key no variant has, and eight keys short of
 * either. It passed because `rulesSnapshot` was only checked for being an object, which is the
 * defect the nested validator now closes; a fixture that stays wrong here would only prove the
 * validator can be satisfied by a snapshot nobody can interpret in a year.
 */
const TDM_RULES = {
  killLimit: 75,
  roundsToWin: null, maxRounds: null, sideSwitchAfter: null, roundLengthSec: null,
  bombTimerSec: null, defuseSec: null, plantSec: null, freezeSec: null, overtime: null,
};
const BOMB_RULES = {
  killLimit: null,
  roundsToWin: 7, maxRounds: 12, sideSwitchAfter: 6, roundLengthSec: 105,
  bombTimerSec: 40, defuseSec: 7, plantSec: 3, freezeSec: 8, overtime: false,
};

function matchResult({ matchId, status, winnerTeam, outcomeReason, players, mode = 'tdm' }) {
  return {
    matchId, status, mode,
    // `region` is NOT NULL on `matches` (0004) — the real adapter refuses a result without one.
    region: 'yyz',
    mapId: 'the-square', mapVersion: '1.0.0',
    statDefinitionVersion: '1.0.0',
    // The rest of the §4.2 TerminalResult. The real adapter refuses a result missing any of
    // them, so a fixture that omits them is a fixture the shipping store would never accept.
    rulesetVersion: '1.0.0', serverBuild: 'test-build', evidenceRef: `ev:${matchId}`,
    rulesSnapshot: mode === 'bomb' ? { ...BOMB_RULES } : { ...TDM_RULES },
    // §4.1 roster entries are a closed shape: account, team, joined, left.
    roster: players.map((p) => ({
      accountId: p.accountId, team: p.team, joinedAt: p.joinedAt, leftAt: p.leftAt,
    })),
    rounds: [],
    terminationReason: status, outcomeReason,
    invalidationReason: status === 'invalidated' ? 'cheat-detected' : null,
    winnerTeam, teamScores: { alpha: 75, bravo: 40 },
    startedAt: STARTED_AT, endedAt: ENDED_AT,
    players,
  };
}

function playerRow(accountId, team, over = {}) {
  const base = {
    accountId,
    // §4.1 requires every key on a submitted player row. `displayName`, `role`, `joinedAt` and
    // `leftAt` were absent from this fixture, so the suite's idea of a player row was four keys
    // short of the contract's and no test could have noticed.
    displayName: `Player-${accountId.slice(-4)}`,
    team, role: null,
    kills: 10, deaths: 5, assists: 3, suicides: 0, teamKills: 0,
    headshots: 2, shotsFired: 100, shotsHit: 40, damageDealt: 1200,
    plants: 1, defuses: 0, roundsPlayed: 0, timePlayedSec: 600,
    score: 1400, disconnected: false, abandoned: false,
    joinedAt: STARTED_AT, leftAt: null,
    weapons: { ar_vector: { shots: 100, hits: 40, kills: 10, headshots: 2 } },
  };
  return { ...base, ...over };
}

{
  const store = makeStore();
  seed(store);
  const mod = moduleWith(store);
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

  // Failing control: a legal field goes through, and a service actor can apply. The rename
  // control moved to §10, which runs against the real store — a rename now goes through
  // `auth.service.changeDisplayName`, and that writes an event and an audit row, neither of
  // which this fake can accept.
  const relaxed = await expectNoThrow(
    () => mod.profiles.patchProfile(ACCOUNT, { privacy: { statsVisibility: 'nobody' } }),
    'PATCH with only a contracted field is accepted');
  expect(relaxed?.privacy.statsVisibility === 'nobody', 'the accepted field changed',
    JSON.stringify(relaxed?.privacy));

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

{
  /**
   * §4.1/§4.0: `matches`, `wins`, `losses` and `draws` are the LEDGER columns. They are derived
   * from the match's `winnerTeam` and the player's team, and are never read off the submitted
   * row — a row is a record of one match and cannot carry a career.
   *
   * `careerDelta` copies every other counter across verbatim, so the exclusion is one line, and
   * deleting it leaked whichever ledger field the outcome did not overwrite: a WIN wrote
   * `wins: 1` over the claim but carried the row's `losses: 3` and `draws: 2` straight into the
   * career. Asserting all four is the point — asserting only `wins` passes on the mutant.
   */
  const claiming = { ...playerRow(ACCOUNT, 'alpha'), matches: 9, wins: 5, losses: 3, draws: 2 };
  const won = careerDelta(claiming, { status: 'completed', winnerTeam: 'alpha' });
  expect(won.matches === 1 && won.wins === 1 && won.losses === 0 && won.draws === 0,
    'a win contributes exactly one match and one win, whatever ledger the row claims',
    JSON.stringify({ m: won.matches, w: won.wins, l: won.losses, d: won.draws }));
  const lost = careerDelta(claiming, { status: 'completed', winnerTeam: 'bravo' });
  expect(lost.matches === 1 && lost.wins === 0 && lost.losses === 1 && lost.draws === 0,
    'a loss contributes exactly one match and one loss, and no claimed wins',
    JSON.stringify({ m: lost.matches, w: lost.wins, l: lost.losses, d: lost.draws }));
  const drew = careerDelta(claiming,
    { status: 'completed', winnerTeam: 'draw', outcomeReason: 'timer' });
  expect(drew.matches === 1 && drew.wins === 0 && drew.losses === 0 && drew.draws === 1,
    'a draw contributes exactly one match and one draw, and no claimed wins or losses',
    JSON.stringify({ m: drew.matches, w: drew.wins, l: drew.losses, d: drew.draws }));
  // CONTROL: the non-ledger counters on the SAME row are copied across untouched, so the
  // exclusion above is about four named fields and not about a delta that has stopped copying.
  expect(won.kills === 10 && won.deaths === 5 && won.timePlayedSec === 600,
    'control: every non-ledger counter is copied from the row verbatim',
    JSON.stringify({ k: won.kills, d: won.deaths, t: won.timePlayedSec }));
}

{
  /**
   * §5.5 rests entirely on `resultHash`: two submissions for one match are "the same truth"
   * if and only if their hashes agree. The serialiser therefore has to be INJECTIVE over the
   * shapes a result can take, and the array branch is what keeps it so — without it an array
   * is serialised through the object branch as `{"0":…,"1":…}`, which is byte-for-byte what an
   * object with those numeric keys produces. Two different payloads then hash the same, and the
   * second one is accepted as a replay of the first instead of refused as a second truth.
   */
  const asArray = resultHash({ roster: ['A', 'B'] });
  const asIndexObject = resultHash({ roster: { 0: 'A', 1: 'B' } });
  expect(asArray !== asIndexObject,
    'a roster ARRAY and an object with the same indices do not hash alike',
    `${asArray.slice(0, 12)} vs ${asIndexObject.slice(0, 12)}`);
  const roundsArray = resultHash({ rounds: [{ index: 0, winner: 'alpha' }] });
  const roundsObject = resultHash({ rounds: { 0: { index: 0, winner: 'alpha' } } });
  expect(roundsArray !== roundsObject,
    'and the same holds nested, where §4.1\'s arrays actually live',
    `${roundsArray.slice(0, 12)} vs ${roundsObject.slice(0, 12)}`);
  // CONTROL: the hash is still stable under re-serialisation — key order must not change it,
  // or every retry from a different worker would look like a second, different truth.
  expect(resultHash({ a: 1, b: [2, 3] }) === resultHash({ b: [2, 3], a: 1 }),
    'control: key order does not change the hash');
  expect(resultHash({ roster: ['A', 'B'] }) !== resultHash({ roster: ['B', 'A'] }),
    'control: element ORDER does change it — a reordered roster is a different result');
}

{
  /**
   * The two things `applyMatchResult` must establish before it touches the store, and the one
   * thing `getCareer` must establish before it adds a row to a total.
   */
  const store = makeStore();
  seed(store);
  const mod = moduleWith(store);
  const service = { kind: 'service', serviceId: 'match-server' };

  // A submission with NO RESULT AT ALL is a VALIDATION_FAILED, not a TypeError. The idempotency
  // key is derived from `result.matchId` on the line below the guard, so without it a null body
  // dereferences null and the caller gets a 500 for a request it could have been told to fix —
  // and a 500 on the result endpoint is a match server that will retry the same broken payload.
  await expectCode(() => mod.stats.applyMatchResult({ actor: service, result: null }),
    'VALIDATION_FAILED', 'a submission with a null result is a VALIDATION_FAILED, not a crash');
  await expectCode(() => mod.stats.applyMatchResult({ actor: service }),
    'VALIDATION_FAILED', 'a submission with no result at all is a VALIDATION_FAILED, not a crash');
  expect(store._matches.length === 0 && store._idem.size === 0,
    'and neither of them recorded a match or burned an idempotency key',
    JSON.stringify({ m: store._matches.length, i: store._idem.size }));

  // CONTROL: the well-formed submission goes through the same door.
  await expectNoThrow(() => mod.stats.applyMatchResult({
    actor: service,
    result: matchResult({ matchId: 'SDV1', status: 'completed', winnerTeam: 'alpha',
      outcomeReason: 'timer', players: [playerRow(ACCOUNT, 'alpha')] }),
  }), 'control: a complete result from the same service actor applies');

  /**
   * §3/§11.5: a career total is the sum of the rows for ONE stat definition version. The
   * version is what makes a counter comparable to itself over time — when the definition of a
   * headshot changes, the old rows stay on disk under the old version and are not summed into
   * the new career, because a total that mixes two definitions is a number with no meaning and
   * no way to be recomputed back.
   *
   * `stats.listForAccount` and `weaponStats.listForAccount` both hand back every version they
   * hold (db-schema.md §3), so the filter is the service's, and these are the assertions that
   * hold it: a fat 1.5.0 row is written directly beside the 1.0.0 one and must not show up.
   */
  await store.stats.applyDelta(ACCOUNT, 'tdm', '1.5.0', { ...emptyTotals(), kills: 777, matches: 9 });
  await store.weaponStats.applyDelta(ACCOUNT, 'tdm', 'ar_vector', '1.5.0',
    { shots: 55, hits: 55, kills: 55, headshots: 55 });

  const career = await mod.stats.getCareer(ACCOUNT, 'tdm');
  expect(career.statDefinitionVersion === STAT_DEFINITION_VERSION,
    'the career answers for the current stat definition version',
    String(career.statDefinitionVersion));
  expect(career.totals.kills === 10 && career.totals.matches === 1,
    'a row written under another stat definition version is not summed into the career',
    JSON.stringify({ kills: career.totals.kills, matches: career.totals.matches }));
  expect(career.weapons.ar_vector.kills === 10 && career.weapons.ar_vector.shots === 100,
    'and neither is a weapon row written under another version',
    JSON.stringify(career.weapons.ar_vector));

  // CONTROL: ask for 1.5.0 and the fat row is exactly what comes back, so the two assertions
  // above are about the version filter and not about rows that were never stored.
  const legacy = await mod.stats.getCareer(ACCOUNT, 'tdm', '1.5.0');
  expect(legacy.totals.kills === 777 && legacy.totals.matches === 9,
    'control: the 1.5.0 career is the 1.5.0 row, read by asking for that version',
    JSON.stringify({ kills: legacy.totals.kills, matches: legacy.totals.matches }));
  expect(legacy.weapons.ar_vector.kills === 55,
    'control: and its weapon breakdown likewise', JSON.stringify(legacy.weapons.ar_vector));
}

// ------------------------------------------------------------------ 7. migration

console.log('\nProgression migration — one-time, unverified, non-authoritative');

{
  const store = makeStore();
  seed(store);
  const mod = moduleWith(store);
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
  // A weapon row that is not an object is DROPPED, not coerced into an all-zero weapon: `null`
  // would be dereferenced key by key, and `7` would silently mint `{ kills: 0, … }` for a
  // weapon the player never fired. The surviving key proves the loop kept going.
  expect(Object.keys(junk.data.weapons).length === 0,
    'a weapons entry that is not an object is dropped rather than dereferenced or zero-filled',
    JSON.stringify(junk.data.weapons));
  // A THIRD account: `OTHER` has already imported, and a second import returns the first.
  const THIRD = '01JPROFILEACCOUNT0000000CD';
  store._accounts.set(THIRD, {
    accountId: THIRD, status: 'active', displayName: 'Third', displayNameFolded: 'third',
    createdAt: '2026-01-03T00:00:00.000Z', nameChangedAt: null,
    privacy: { presenceVisibility: 'nobody', statsVisibility: 'nobody' },
  });
  const mixedWeapons = await mod.migration.importLegacyProgression(THIRD, {
    weapons: { ar_vector: { kills: 3 }, smg_hush: null, lmg_ox: 7, dmr_pin: 'nope' },
  });
  expect(Object.keys(mixedWeapons.data.weapons).join(',') === 'ar_vector'
      && mixedWeapons.data.weapons.ar_vector.kills === 3,
    'control: the well-formed weapon beside them survives, so the drop is per-row',
    JSON.stringify(mixedWeapons.data.weapons));

  // An account that is not there — or is deleted — cannot import anything. Without the check
  // the import writes a `profiles` row for an account id nothing else in the platform knows,
  // and a deleted player's progression comes back on top of the erasure.
  await expectCode(() => mod.migration.importLegacyProgression('01JNOSUCHACCOUNT000000000A', { xp: 1 }),
    'NOT_FOUND', 'a progression import for an account that does not exist is NOT_FOUND');
  const gone = '01JDELETEDACCOUNT0000000CC';
  store._accounts.set(gone, {
    accountId: gone, status: 'deleted', displayName: null, displayNameFolded: null,
    createdAt: '2026-01-01T00:00:00.000Z', deletedAt: '2026-06-01T00:00:00.000Z',
  });
  await expectCode(() => mod.migration.importLegacyProgression(gone, { xp: 1 }),
    'NOT_FOUND', 'a progression import for a DELETED account is NOT_FOUND, not a resurrection');
  // CONTROL: the same blob for a live account is accepted, so the two refusals are about the
  // account and not about an import path that has stopped accepting anything.
  const live = await expectNoThrow(
    () => mod.migration.importLegacyProgression(ACCOUNT, { xp: 1 }),
    'control: the same import for a live account is accepted');
  expect(live?.verified === false, 'control: and it is still flagged unverified',
    JSON.stringify(live?.verified));
}

// ------------------------------------------------------------------ 8. idempotency (§5)

console.log('\nmatch-result.md §5 — a retry applies once');

{
  const store = makeStore();
  seed(store);
  const mod = moduleWith(store);
  const service = { kind: 'service', serviceId: 'match-server' };
  const result = matchResult({ matchId: 'IDEM1', status: 'completed', winnerTeam: 'alpha',
    outcomeReason: 'timer', players: [playerRow(ACCOUNT, 'alpha')] });

  const first = await mod.stats.applyMatchResult({ actor: service, result });
  const second = await mod.stats.applyMatchResult({ actor: service, result });
  const afterTwo = await mod.stats.getCareer(ACCOUNT, 'tdm');
  expect(afterTwo.totals.kills === 10 && afterTwo.totals.matches === 1 && afterTwo.totals.wins === 1,
    'the identical result submitted twice is applied exactly once', JSON.stringify(afterTwo.totals));
  expect(first.applied === true && second.applied === false
      && JSON.stringify({ ...first, applied: null }) === JSON.stringify({ ...second, applied: null }),
    '§5.4: the replay returns the STORED response, with applied:false because THIS call did not apply',
    `${JSON.stringify(first)} vs ${JSON.stringify(second)}`);
  expect(store._matches.filter((m) => m.matchId === 'IDEM1').length === 1,
    'the immutable match record is written once, not once per retry',
    String(store._matches.filter((m) => m.matchId === 'IDEM1').length));
  expect(store._idem.size === 1 && [...store._idem.values()][0].key === idempotencyKeyFor('IDEM1'),
    '§5.2: the key is derived from the matchId, so a retry is inherently the same key',
    JSON.stringify([...store._idem.values()].map((r) => r.key)));
  const idemRow = [...store._idem.values()][0];
  expect(Date.parse(idemRow.expiresAt) - Date.parse(idemRow.createdAt) === 24 * 3600e3,
    'http-api.md §8: a gameplay idempotency row is retained for exactly 24 hours',
    `${idemRow.createdAt} -> ${idemRow.expiresAt}`);

  /**
   * The same rule with a clock that MOVES, which is what turned the check above into a flake.
   *
   * `createdAt` and `expiresAt` were each sampled from `clock.now()`, with every database write
   * of the transaction in between. Against the memory adapter that gap is usually zero
   * milliseconds and the check passed; against real PostgreSQL it sometimes was not, and CI
   * failed intermittently for weeks with no local reproduction. The window was also genuinely
   * longer than the 24 hours §8 states, by however long the writes happened to take.
   *
   * A clock that advances on every read makes the defect deterministic: with two samples this
   * cannot produce exactly 24h, so the only way to pass is to derive one field from the other.
   */
  {
    const movingStore = makeStore();
    seed(movingStore);
    let tick = Date.parse('2026-08-21T12:00:00.000Z');
    const movingClock = { now: () => (tick += 7) };
    const movingMod = moduleWith(movingStore, { clock: movingClock });
    await movingMod.stats.applyMatchResult({ actor: service,
      result: matchResult({ matchId: 'IDEMCLK', status: 'completed', winnerTeam: 'alpha',
        outcomeReason: 'timer', players: [playerRow(ACCOUNT, 'alpha')] }) });
    const movingRow = [...movingStore._idem.values()][0];
    expect(Date.parse(movingRow.expiresAt) - Date.parse(movingRow.createdAt) === 24 * 3600e3,
      'the 24-hour window holds even when the clock advances mid-transaction',
      `${movingRow.createdAt} -> ${movingRow.expiresAt}`);
  }

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

  const missing = await expectCode(() => mod.stats.applyMatchResultRaw({ actor: service, result }),
    'VALIDATION_FAILED', 'the service boundary refuses an omitted Idempotency-Key');
  expect(missing?.details?.fields?.[0]?.reason === 'required',
    'the omitted-key refusal names the required invariant', JSON.stringify(missing?.details));

  await expectCode(() => mod.stats.applyMatchResult({
    actor: service,
    result: { ...result, roster: result.roster.map((entry) => ({ ...entry, team: 'bravo' })) },
  }), 'VALIDATION_FAILED', 'a roster team that contradicts its player row is refused');
  await expectCode(() => mod.stats.applyMatchResult({
    actor: service,
    result: { ...result, roster: [] },
  }), 'VALIDATION_FAILED', 'a player without a one-to-one roster entry is refused');

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
    const mod = moduleWith(store);
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
  const mod = moduleWith(store);
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

console.log('\nA rename goes through the canonical identity path, with its event and audit row');

{
  // The REAL store and the REAL auth service. A rename is an identity change: auth.md §9
  // requires the previous name to be retained for impersonation review and §10 requires the
  // audit row, and both are written by `auth.service.changeDisplayName`. Proving that means
  // proving rows exist in `events_outbox` and `audit_log`, which only the real adapter has.
  const store = createMemoryStore({ storage: 'memory' });
  let t = Date.parse('2026-08-19T00:00:00.000Z');
  const clock = { now: () => t };
  const config = loadConfig({ PLATFORM_TOKEN_SECRET: 'test-secret-not-a-real-one' });
  const auth = createAuthModule({ store, config, logger: silent, clock });
  const mod = moduleWith(store, { clock, identity: auth.service });

  await store.accounts.create({
    accountId: ACCOUNT, displayName: 'Mawdev', displayNameFolded: 'mawdev',
    createdAt: new Date(t).toISOString(),
  });
  await store.accounts.create({
    accountId: OTHER, displayName: 'Quiet', displayNameFolded: 'quiet',
    createdAt: new Date(t).toISOString(),
  });

  const before = await mod.profiles.getOwnProfile(ACCOUNT);
  expect(before.flags.nameChangeAvailableAt === null,
    'an account that never changed its name has no cooldown', JSON.stringify(before.flags));

  const renamed = await expectNoThrow(() => mod.profiles.patchProfile(ACCOUNT, { displayName: 'Renamed' }),
    'the display name change goes through');
  const row = await store.accounts.byId(ACCOUNT);
  expect(row.nameChangedAt === new Date(t).toISOString(),
    'the change stamps name_changed_at — the column migration 0008 declares', String(row.nameChangedAt));
  expect(row.displayName === 'Renamed' && row.displayNameFolded === 'renamed',
    'the folded name is re-derived by the shared implementation, not by a second copy',
    JSON.stringify({ n: row.displayName, f: row.displayNameFolded }));
  expect(renamed?.flags.nameChangeAvailableAt === new Date(t + 30 * 24 * 3600e3).toISOString(),
    'nameChangeAvailableAt is DERIVED at read time as name_changed_at + 30 days',
    JSON.stringify(renamed?.flags));

  // auth.md §9 history + §10 audit. The old rename wrote the account row and nothing else, so
  // a moderator reviewing an impersonation report had no record that the name ever changed and
  // no record of what it changed FROM.
  const events = await store.outbox.claimUnpublished(1000);
  const nameEvent = events.find((e) => e.eventType === 'account.name_changed');
  expect(!!nameEvent, 'the rename emits the catalogued account.name_changed event',
    JSON.stringify(events.map((e) => e.eventType)));
  expect(nameEvent?.payload?.previousName === 'Mawdev' && nameEvent?.payload?.displayName === 'Renamed',
    'the event carries the PREVIOUS name, which is the retained history (auth.md §9)',
    JSON.stringify(nameEvent?.payload));
  expect(nameEvent?.subjectId === ACCOUNT && nameEvent?.privacyClass === 'personal',
    'the history row is personal-class and subject to the account, never public',
    JSON.stringify({ s: nameEvent?.subjectId, p: nameEvent?.privacyClass }));
  const audits = await store.audit.list({ subjectId: ACCOUNT, limit: 100 });
  const nameAudit = audits.find((a) => a.action === 'account.name_change');
  expect(!!nameAudit && nameAudit.actorId === ACCOUNT,
    'the rename writes the §10 audit row, naming the actor',
    JSON.stringify(audits.map((a) => a.action)));
  expect(nameAudit?.beforeSummary?.displayName === 'Mawdev'
      && nameAudit?.afterSummary?.displayName === 'Renamed',
    'the audit row records what the name changed from and to',
    JSON.stringify({ b: nameAudit?.beforeSummary, a: nameAudit?.afterSummary }));

  // The cooldown is reachable, and it is the canonical one — the profile service no longer
  // carries its own copy of the 30 days to disagree with `auth/names.js`.
  t += 29 * 24 * 3600e3;
  const cooling = await expectCode(() => mod.profiles.patchProfile(ACCOUNT, { displayName: 'Again' }),
    'NAME_CHANGE_COOLDOWN', 'a second change inside 30 days is refused');
  expect(cooling?.retryAfterMs === 24 * 3600e3,
    'the refusal carries the real time remaining', String(cooling?.retryAfterMs));
  expect((await store.accounts.byId(ACCOUNT)).displayName === 'Renamed',
    'the refused change did not rename the account');
  await expectCode(() => mod.profiles.patchProfile(ACCOUNT, { displayName: 'Quiet' }),
    'NAME_TAKEN', 'a name another account holds is refused');

  // CONTROL: past the cooldown the same change is accepted, so the refusal is the 30 days and
  // not a rename path that has stopped working.
  t += 2 * 24 * 3600e3;
  const later = await expectNoThrow(() => mod.profiles.patchProfile(ACCOUNT, { displayName: 'Again' }),
    'CONTROL: the same change past the cooldown is accepted');
  const after = await store.accounts.byId(ACCOUNT);
  expect(later?.displayName === 'Again' && after.nameChangedAt === new Date(t).toISOString(),
    'CONTROL: the accepted change re-stamps name_changed_at',
    JSON.stringify({ name: later?.displayName, at: after.nameChangedAt }));
  const renames = (await store.outbox.claimUnpublished(1000))
    .filter((e) => e.eventType === 'account.name_changed');
  expect(renames.length === 2, 'CONTROL: one event per accepted rename, and none for a refused one',
    String(renames.length));

  // FAILING CONTROL for the delegation itself: with no identity service wired, a rename is
  // REFUSED rather than performed with no event, no audit row and no history. That refusal is
  // what makes "the rename is written by exactly one implementation" enforceable.
  const orphan = moduleWith(store, { clock });
  await expectCode(() => orphan.profiles.patchProfile(ACCOUNT, { displayName: 'Nameless' }),
    'SERVICE_UNAVAILABLE', 'a module with no identity service refuses to rename');
  expect((await store.accounts.byId(ACCOUNT)).displayName === 'Again',
    'and the refused rename wrote nothing');

  // Moderation comes from accounts.status (0001), not from a field nothing writes.
  await store.accounts.update(OTHER, { status: 'restricted' });
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

  auth.stop();
  await store.close();
}

// ------------------------------------------------------------ 11a. the service's If-Match check

// This block was titled "If-Match is compare-and-set, not read-then-write" and tested the
// opposite: every check in it passes with the adapter CAS deleted outright, because what it
// exercises is the service's own read-then-write pre-check in profile/settings.js — the very
// thing the old title said it was not. It is worth keeping, so it is kept under an honest
// name; §11b below is the part the old title claimed.
console.log('\nhttp-api.md §11.2 — the settings service validates If-Match against the stored version');

{
  const store = createMemoryStore({ storage: 'memory' });
  const account = await store.accounts.create({
    accountId: ACCOUNT, displayName: 'Racer', displayNameFolded: 'racer',
  });
  const mod = moduleWith(store);

  // Two writers, both holding the same fresh ETag. One must win and one must be told.
  //
  // On this path the transaction's serialisation plus the pre-check are enough, so this pair
  // says nothing about the adapter CAS — it says the SERVICE returns 409 rather than 200 to
  // the loser, and that the loser's values are not what ends up stored. That is a real claim
  // and this is the right place for it. The claim it is NOT making is §11b's.
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

// -------------------------------------------------- 11b. the write is conditional on the version

// The claim §11a cannot make: that the version the service validated is re-compared BY THE
// WRITE. A read-then-write check can only see the world as it was when it ran; the whole point
// of §11.2 is the window after it.
//
// The store here is a REAL memory store and the service is the real service — only the
// INTERLEAVING is injected. A competing write lands between the pre-check and the write, which
// is precisely the state the pre-check has already stopped being able to see. Delete
// `store.profiles.upsertIfVersion` from settings.js (it falls back to a plain upsert) or delete
// the comparison from the adapter, and this block fails: the request is answered 200 and the
// competing writer's rebind is gone.
//
// The adapter method itself is proved directly, against both adapters including real
// PostgreSQL, in platform/test/storetest.mjs §8a. This is only the delegation.
console.log('\nhttp-api.md §11.2 — the settings write is conditional on the version it validated');

{
  const store = createMemoryStore({ storage: 'memory' });
  const account = await store.accounts.create({
    accountId: ACCOUNT, displayName: 'Racer', displayNameFolded: 'racer',
  });
  // A known pre-race value, so "nothing was written" is a row we can name rather than the
  // absence of one.
  await store.profiles.upsert(account.accountId, { roamingSettings: { fov: 100 }, settingsVersion: 1 });

  const realCas = store.profiles.upsertIfVersion.bind(store.profiles);
  let interleaved = 0;
  store.profiles.upsertIfVersion = async (accountId, expectedVersion, patch, tx) => {
    if (interleaved++ === 0) {
      // The other device, getting in after our If-Match was validated and before we wrote.
      await store.profiles.upsert(accountId, { roamingSettings: { fov: 44 }, settingsVersion: 2 }, tx);
    }
    return realCas(accountId, expectedVersion, patch, tx);
  };
  const mod = moduleWith(store);

  await expectCode(
    () => mod.settings.replace(account.accountId, { schemaVersion: 1, values: { fov: 105 } }, '"1"'),
    'CONFLICT', 'a writer that loses the race AFTER its If-Match was validated is still refused');
  // Without this the check above would also pass if the service never reached the CAS and the
  // request failed for some entirely unrelated reason.
  expect(interleaved === 1, 'the service reached the adapter CAS exactly once',
    `upsertIfVersion was called ${interleaved} time(s)`);
  // The refusal rolls the whole transaction back, injected write included, so the row is
  // exactly what it was before the request. With the CAS gone it reads version 2, fov 105.
  const after = await mod.settings.read(account.accountId);
  expect(after.version === 1 && after.values.fov === 100,
    'the refused writer stored nothing and consumed no version',
    JSON.stringify({ version: after.version, fov: after.values.fov }));

  // CONTROL: with no interleaving the same service, store and version accept the write, so the
  // refusal above is about losing the race and not about a settings path that has stopped
  // working. `interleaved` is 1 now, so the injection no longer fires.
  const won = await mod.settings.replace(account.accountId, { schemaVersion: 1, values: { fov: 77 } }, '"1"');
  expect(won.version === 2 && won.values.fov === 77,
    'CONTROL: an uncontested write with the current version is accepted',
    JSON.stringify({ version: won.version, fov: won.values.fov }));
  expect(interleaved === 2, 'CONTROL: and it went through the adapter CAS too',
    `upsertIfVersion was called ${interleaved} time(s)`);
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
  const mod = moduleWith(store);
  const leaked = await mod.handlers.getStats(
    ctxFor(ACCOUNT, { params: { accountId: OTHER }, query: new URLSearchParams() }));
  // Per-mode, because `mode=all` is the default and its hidden form is the §11.5 per-mode shape
  // with null counters (see the note in §3 above).
  expect(leaked.modes?.tdm?.totals === null && leaked.modes?.bomb?.weapons === null,
    'a statsVisibility the enum does not contain hides the career', JSON.stringify(leaked));
  // CONTROL: the same call for a subject who really did choose `everyone` returns counters.
  const shown = await mod.handlers.getStats(
    ctxFor(OTHER, { params: { accountId: ACCOUNT }, query: new URLSearchParams() }));
  // `shown.totals !== null` was the assertion here, and it passed for a response that carries no
  // `totals` key at all — `undefined !== null` — which is exactly what `mode=all` returns, since
  // its counters live under `modes.tdm` / `modes.bomb`. It would have gone on passing if the
  // visible projection had stopped returning counters entirely. The counters are named.
  const visibleTdm = shown.modes?.tdm?.totals;
  expect(visibleTdm !== null && typeof visibleTdm === 'object'
      && CAREER_KEYS.every((k) => typeof visibleTdm[k] === 'number'),
    'CONTROL: an explicit everyone returns real per-mode counters, one number per career key',
    JSON.stringify(shown));
  expect(shown.modes?.bomb?.totals && typeof shown.modes.bomb.totals.matches === 'number',
    'CONTROL: and the other mode is counters too, not a null stand-in',
    JSON.stringify(shown.modes?.bomb?.totals));
}

// ------------------------------------------- 12a. the patch surface's own refusals

console.log('\nhttp-api.md §4/§11.8 — PATCH /profile/me identifies its caller and its change');

{
  const store = makeStore();
  seed(store);
  const mod = moduleWith(store);

  /**
   * §4's `privacy` is an OBJECT of two enum members. A patch whose `privacy` is not an object is
   * refused on `privacy` itself — each of the four shapes below fails a different way without
   * the check: `null` is dereferenced, `[]` validates clean and merges nothing while answering
   * 200 to a player who thinks they just changed their visibility, and a string is walked
   * character by character.
   */
  for (const [bad, label] of [[null, 'null'], [[], 'an array'], ['everyone', 'a string'], [3, 'a number']]) {
    const { errors } = validatePrivacyPatch(bad);
    expect(errors.length === 1 && errors[0].key === 'privacy' && errors[0].reason === 'type'
        && errors[0].expected === 'object',
      `a privacy patch that is ${label} is a type error on 'privacy' itself`, JSON.stringify(errors));
  }
  // CONTROL: the object form validates and yields the patch to merge.
  const goodPatch = validatePrivacyPatch({ statsVisibility: 'everyone' });
  expect(goodPatch.errors.length === 0 && goodPatch.value.statsVisibility === 'everyone',
    'control: an object of documented members validates and is returned as the merge patch',
    JSON.stringify(goodPatch));

  /**
   * Every patch is performed AS somebody, and that somebody comes from the authenticated actor.
   * An actor object with no `accountId`, and a caller that passed nothing at all, are both
   * AUTH_REQUIRED — not a store lookup for `undefined`, which answers NOT_FOUND and tells a
   * signed-out client that the account it never named does not exist.
   */
  for (const [who, label] of [
    [{ kind: 'user' }, 'an actor object carrying no accountId'],
    [{ kind: 'user', accountId: null }, 'an actor whose accountId is null'],
    [{ kind: 'user', accountId: '' }, 'an actor whose accountId is empty'],
    [null, 'a null actor'],
    [undefined, 'no actor at all'],
    ['', 'an empty account id'],
  ]) {
    await expectCode(() => mod.profiles.patchProfile(who, { privacy: { statsVisibility: 'everyone' } }),
      'AUTH_REQUIRED', `a PATCH by ${label} is AUTH_REQUIRED`);
  }
  // CONTROL: both accepted actor forms — the full actor and the bare account id internal
  // callers hold — go through, so the six refusals are about identity and not about a patch
  // surface that refuses everyone.
  const byActor = await expectNoThrow(
    () => mod.profiles.patchProfile({ kind: 'user', accountId: ACCOUNT },
      { privacy: { statsVisibility: 'nobody' } }),
    'control: a full actor object with an accountId may patch');
  expect(byActor?.privacy.statsVisibility === 'nobody',
    'control: and the change landed', JSON.stringify(byActor?.privacy));
  const byId = await expectNoThrow(
    () => mod.profiles.patchProfile(ACCOUNT, { privacy: { statsVisibility: 'everyone' } }),
    'control: a bare account id may patch too');
  expect(byId?.privacy.statsVisibility === 'everyone',
    'control: and that change landed as well', JSON.stringify(byId?.privacy));

  /**
   * A patch that names no writable field is refused rather than answered 200. `{}` and
   * `{ privacy: undefined }` are the two ways a client builds one by accident, and both used to
   * run to completion: no branch executed, the current profile came back, and the client learned
   * its no-op request had succeeded — including, with an `Idempotency-Key`, burning that key on
   * a request that did nothing.
   */
  for (const [empty, label] of [[{}, 'an empty patch'], [undefined, 'no patch at all']]) {
    const err = await expectCode(() => mod.profiles.patchProfile(ACCOUNT, empty),
      'VALIDATION_FAILED', `${label} is refused as having nothing to change`);
    expect(err?.details?.fields?.[0]?.reason === 'required',
      `  …and says a field is required`, JSON.stringify(err?.details));
  }
  // CONTROL: a patch naming one writable field is accepted — the refusal is about the empty
  // body, not about a `privacy`-only patch being rejected for lacking a displayName.
  const onlyPrivacy = await expectNoThrow(
    () => mod.profiles.patchProfile(ACCOUNT, { privacy: { presenceVisibility: 'friends' } }),
    'control: a patch naming only privacy is accepted');
  expect(onlyPrivacy?.privacy.presenceVisibility === 'friends'
      && onlyPrivacy?.privacy.statsVisibility === 'everyone',
    'control: and it is a PARTIAL patch — the field it did not name is unchanged',
    JSON.stringify(onlyPrivacy?.privacy));
}

// ------------------------------------------------------------------ 13. mode=all weapons

console.log('\n§11.5 — mode=all is the default, and it must carry the weapon breakdown');

{
  const store = makeStore();
  seed(store);
  const mod = moduleWith(store);
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
  const mod = moduleWith(store);

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

// ------------------------------------------------------------------ 16. privacy is patchable

console.log('\n§4/§11.8 — privacy is a PATCHABLE field, validated against the closed enums');

{
  const store = createMemoryStore({ storage: 'memory' });
  const mod = moduleWith(store);
  await store.accounts.create({
    accountId: ACCOUNT, displayName: 'Mawdev', displayNameFolded: 'mawdev',
    privacy: { presenceVisibility: 'everyone', statsVisibility: 'everyone' },
  });

  // The whole point: §4 documents `privacy` as patchable and the handler allowlisted
  // `displayName` alone, so the only two settings a player has for hiding themselves were
  // answered `unknown-field` — there was no way to become private at all.
  const hidden = await expectNoThrow(
    () => mod.profiles.patchProfile(ACCOUNT, { privacy: { statsVisibility: 'nobody' } }),
    'PATCH { privacy: { statsVisibility } } is accepted');
  expect(hidden?.privacy.statsVisibility === 'nobody',
    'the response reports the new setting', JSON.stringify(hidden?.privacy));
  expect(hidden?.privacy.presenceVisibility === 'everyone',
    'a partial patch leaves the OTHER visibility alone rather than resetting it to a default',
    JSON.stringify(hidden?.privacy));
  const stored = await store.accounts.byId(ACCOUNT);
  expect(stored.privacy.statsVisibility === 'nobody' && stored.privacy.presenceVisibility === 'everyone',
    'and it is what is stored, in the jsonb column the schema declares',
    JSON.stringify(stored.privacy));

  // The subject really is hidden now, through the endpoint a stranger uses.
  const strangerSees = await mod.profiles.getPublicProfile(ACCOUNT, OTHER);
  expect(strangerSees.stats === null, 'a stranger now sees a null career',
    JSON.stringify(strangerSees.stats));

  // `friends` is a PRESENCE member and not a stats member. The enums are closed and separate.
  const wrongEnum = await expectCode(
    () => mod.profiles.patchProfile(ACCOUNT, { privacy: { statsVisibility: 'friends' } }),
    'VALIDATION_FAILED', 'statsVisibility: friends is refused — that member is presence-only');
  expect(wrongEnum?.details?.fields?.[0]?.key === 'privacy.statsVisibility'
      && wrongEnum?.details?.fields?.[0]?.reason === 'enum',
    'the refusal names the field and the closed enum', JSON.stringify(wrongEnum?.details.fields));
  await expectCode(
    () => mod.profiles.patchProfile(ACCOUNT, { privacy: { statsVisibility: 'NOBODY' } }),
    'VALIDATION_FAILED', 'a mis-cased member is refused rather than guessed at');
  await expectCode(
    () => mod.profiles.patchProfile(ACCOUNT, { privacy: { showEmail: true } }),
    'VALIDATION_FAILED', 'a privacy field the contract does not define is refused');
  await expectCode(
    () => mod.profiles.patchProfile(ACCOUNT, { privacy: 'public' }),
    'VALIDATION_FAILED', 'a privacy value that is not an object is refused');

  // A REJECTED write stores nothing — the failing control for every refusal above.
  const untouched = await store.accounts.byId(ACCOUNT);
  expect(untouched.privacy.statsVisibility === 'nobody' && untouched.privacy.presenceVisibility === 'everyone',
    'none of the refused privacy writes changed the stored value', JSON.stringify(untouched.privacy));

  // CONTROL: `friends` on the field that DOES have it is accepted, so this is not a service
  // that refuses everything it does not already hold.
  const friends = await expectNoThrow(
    () => mod.profiles.patchProfile(ACCOUNT, { privacy: { presenceVisibility: 'friends' } }),
    'CONTROL: presenceVisibility: friends is accepted — that member is presence\'s');
  expect(friends?.privacy.presenceVisibility === 'friends', 'and it is stored',
    JSON.stringify(friends?.privacy));

  // A write is REJECTED, but a READ of a junk stored blob still fails CLOSED. Both rules hold
  // at once, and the second is what protects a subject whose row was written before the first.
  await store.accounts.update(ACCOUNT, { privacy: { statsVisibility: 'friends', presenceVisibility: 'sometimes' } });
  const junkRead = await mod.profiles.getOwnProfile(ACCOUNT);
  expect(junkRead.privacy.statsVisibility === 'nobody' && junkRead.privacy.presenceVisibility === 'nobody',
    'an unrecognised STORED visibility still reads as the most restrictive member',
    JSON.stringify(junkRead.privacy));
  expect(validatePrivacyPatch({ statsVisibility: 'friends' }).errors.length === 1
      && normalizePrivacy({ statsVisibility: 'friends' }).statsVisibility === 'nobody',
    'the write rejects what the read folds shut — a clamped write would hide the same value '
    + 'without telling the author, which is the §11.9 clamping failure in a privacy setting');

  await store.close();
}

// ------------------------------------------------------------------ 17. §8 idempotency

console.log('\nhttp-api.md §8 — Idempotency-Key on PATCH /profile/me');

{
  const store = createMemoryStore({ storage: 'memory' });
  const mod = moduleWith(store);
  await store.accounts.create({
    accountId: ACCOUNT, displayName: 'Mawdev', displayNameFolded: 'mawdev',
    privacy: { presenceVisibility: 'everyone', statsVisibility: 'everyone' },
  });

  const body = { privacy: { statsVisibility: 'nobody' } };
  const first = await mod.profiles.patchProfile(ACCOUNT, body, { idempotencyKey: 'K1' });
  // The retry must not re-execute. Proven by moving the underlying row between the two calls:
  // a re-execution would overwrite it, the stored response cannot.
  await store.accounts.update(ACCOUNT, {
    privacy: { statsVisibility: 'everyone', presenceVisibility: 'everyone' },
  });
  const replay = await mod.profiles.patchProfile(ACCOUNT, { privacy: { statsVisibility: 'nobody' } }, { idempotencyKey: 'K1' });
  expect(JSON.stringify(replay) === JSON.stringify(first),
    'a replay with the same key and payload returns the STORED response',
    `${JSON.stringify(replay)}\n       vs ${JSON.stringify(first)}`);
  expect((await store.accounts.byId(ACCOUNT)).privacy.statsVisibility === 'everyone',
    'and it did not re-execute: the row the replay would have rewritten is untouched');

  // Key order in the body is not identity: `{a,b}` and `{b,a}` are the same request.
  const reordered = await mod.profiles.patchProfile(ACCOUNT,
    { privacy: { statsVisibility: 'nobody' } }, { idempotencyKey: 'K1' });
  expect(JSON.stringify(reordered) === JSON.stringify(first),
    'the request hash is order-independent, so a re-serialised retry is still a retry');

  // Same key, different payload — the dangerous case.
  const reused = await expectCode(
    () => mod.profiles.patchProfile(ACCOUNT, { privacy: { presenceVisibility: 'nobody' } }, { idempotencyKey: 'K1' }),
    'IDEMPOTENCY_KEY_REUSED', 'the same key with a different payload is refused');
  expect(reused?.status === 409, 'and it is a 409', String(reused?.status));
  expect((await store.accounts.byId(ACCOUNT)).privacy.presenceVisibility === 'everyone',
    'the refused reuse executed nothing');

  // CONTROL: a genuinely different request under a different key executes normally, so this is
  // not an endpoint that has simply stopped writing.
  const second = await expectNoThrow(
    () => mod.profiles.patchProfile(ACCOUNT, { privacy: { presenceVisibility: 'nobody' } }, { idempotencyKey: 'K2' }),
    'CONTROL: a different key with a different payload executes');
  expect(second?.privacy.presenceVisibility === 'nobody'
      && (await store.accounts.byId(ACCOUNT)).privacy.presenceVisibility === 'nobody',
    'CONTROL: and the write landed', JSON.stringify(second?.privacy));

  // Ten concurrent retries of one request apply once.
  await store.accounts.update(ACCOUNT, { privacy: { statsVisibility: 'everyone', presenceVisibility: 'everyone' } });
  const burst = await Promise.all(Array.from({ length: 10 },
    () => mod.profiles.patchProfile(ACCOUNT, { privacy: { statsVisibility: 'nobody' } }, { idempotencyKey: 'K3' })));
  expect(burst.every((r) => JSON.stringify(r) === JSON.stringify(burst[0])),
    'ten concurrent retries under one key all return the same response');

  // §8 says the header is REQUIRED, and that is a statement about the request, so the handler
  // is where it is enforced. The handler ignored it entirely.
  const noKey = await expectCode(
    () => mod.handlers.patchOwnProfile(ctxFor(ACCOUNT, { body: { privacy: { statsVisibility: 'nobody' } } })),
    'VALIDATION_FAILED', 'PATCH /profile/me with no Idempotency-Key is refused');
  expect(noKey?.details?.fields?.[0]?.key === 'Idempotency-Key' && noKey?.details?.fields?.[0]?.reason === 'required',
    'the refusal names the missing header', JSON.stringify(noKey?.details));

  // CONTROL: the same handler call WITH the header goes through.
  const viaHandler = await expectNoThrow(() => mod.handlers.patchOwnProfile(ctxFor(ACCOUNT, {
    body: { privacy: { presenceVisibility: 'friends' } },
    headers: { 'idempotency-key': 'H1' },
  })), 'CONTROL: the same call with an Idempotency-Key is accepted');
  expect(viaHandler?.privacy.presenceVisibility === 'friends',
    'CONTROL: and it applied', JSON.stringify(viaHandler?.privacy));

  await store.close();
}

// ------------------------------------------------------------------ 18. hidden vs empty history

console.log('\n§11.8 — a hidden history is distinguishable from an empty one');

{
  const store = makeStore();
  seed(store);
  const mod = moduleWith(store);

  // OTHER hides their career; ACCOUNT is public and has simply never finished a match. These
  // used to be the same response — `{ items: [], nextCursor: null }` for both — so a client
  // could not tell "no matches yet" from "this player keeps their history private", and
  // neither could anyone reading a support ticket about it.
  const privateHistory = await mod.handlers.getMatches(
    ctxFor(ACCOUNT, { params: { accountId: OTHER }, query: new URLSearchParams() }));
  const emptyHistory = await mod.handlers.getMatches(
    ctxFor(OTHER, { params: { accountId: ACCOUNT }, query: new URLSearchParams() }));
  expect(privateHistory.items === null,
    'a privacy-hidden history is null items — present, never omitted, never a 403',
    JSON.stringify(privateHistory));
  expect(Array.isArray(emptyHistory.items) && emptyHistory.items.length === 0,
    'CONTROL: a visible but empty history is an empty ARRAY', JSON.stringify(emptyHistory));
  expect(JSON.stringify(privateHistory) !== JSON.stringify(emptyHistory),
    'the two states are distinguishable at all',
    `${JSON.stringify(privateHistory)} vs ${JSON.stringify(emptyHistory)}`);
}

// ------------------------------------------------------------------ 19. pre-auth consent TTL

console.log('\n§3a.3 — signed-out consent expires on the injected clock, and is DELETED');

{
  // The real adapter with a real fake clock. The expiry check used to call `Date.now()`
  // directly, so a test that advanced its own clock was not exercising the adapter's path at
  // all — it was waiting for wall-clock time that never came.
  let t = Date.parse('2026-08-19T00:00:00.000Z');
  const store = createMemoryStore({ storage: 'memory' }, { now: () => new Date(t) });
  const TTL = 30 * 24 * 3600e3;
  const csid = '01JCLIENTSESSION000000000A';
  await store.preAuthConsent.put({
    clientSessionId: csid, telemetryPersonal: true, policyVersion: 1,
    decidedAt: new Date(t).toISOString(), expiresAt: new Date(t + TTL).toISOString(),
  });

  // CONTROL first: inside the 30 days the decision is returned. Without this, the expiry proof
  // below would also pass against a `get` that returns null for everything.
  t += TTL - 1000;
  const live = await store.preAuthConsent.get(csid);
  expect(live?.telemetryPersonal === true,
    'CONTROL: a decision inside its 30 days is still returned', JSON.stringify(live));

  t += 2000;                                  // now past expiresAt
  const expired = await store.preAuthConsent.get(csid);
  expect(expired === null, 'an expired decision is not returned', JSON.stringify(expired));

  // And it is GONE, not merely filtered. A consent record still on disk past its TTL is a
  // retention problem, and "we hold it but decline to look at it" is not deletion. Read back
  // with the clock wound BACK, so a surviving row would answer.
  t -= TTL;
  const resurrected = await store.preAuthConsent.get(csid);
  expect(resurrected === null,
    'the expired row was deleted, not hidden behind a read filter — it does not come back '
    + 'when the clock is wound back', JSON.stringify(resurrected));
  expect((await store.preAuthConsent.deleteFor(csid)) === false,
    'and the row genuinely is not in the table any more — there is nothing left to delete');

  // CONTROL: a fresh decision for the same client session works, so expiry deleted one row
  // rather than breaking the surface.
  await store.preAuthConsent.put({
    clientSessionId: csid, telemetryPersonal: false, policyVersion: 1,
    decidedAt: new Date(t).toISOString(), expiresAt: new Date(t + TTL).toISOString(),
  });
  expect((await store.preAuthConsent.get(csid))?.telemetryPersonal === false,
    'CONTROL: a new decision under the same client session is stored and returned');

  await store.close();
}

// ------------------------------------------------------------------ 17. the result lifecycle,
// end to end, on the REAL memory adapter
//
// Everything here runs against `createMemoryStore`, not the fake at the top of this file: the
// six defects below were all in the store surface or in what the service does with it, and a
// fake written from the same misunderstanding as the code cannot see any of them.

console.log('\nmatch-result.md §4/§5 — the result lifecycle on the real adapter');

{
  const t0 = Date.parse('2026-08-20T12:00:00.000Z');
  let t = t0;
  const store = createMemoryStore({ storage: 'memory' }, { now: () => new Date(t) });
  const outbox = createOutbox({ store, clock: { now: () => t }, logger: null });
  const account = await store.accounts.create({
    accountId: '01JLIFECYCLEACCOUNT00000AA', displayName: 'Lifer', displayNameFolded: 'lifer',
  });
  // The service shares the store's clock, so the stamp the row carries and the instant the
  // assertion expects come from one source rather than two that drift by a millisecond.
  const mod = moduleWith(store, { clock: { now: () => t }, outbox });
  const service = { kind: 'service', serviceId: 'match-server' };
  const player = playerRow(account.accountId, 'alpha');

  // --- 1. allocated → terminal, the normal lifecycle ------------------------------------
  // §4: matchId is assigned at ALLOCATION, so the row exists before the result does. The store
  // treated any existing row as CONFLICT, which made this — the only lifecycle the contract
  // describes — the one path that could not complete.
  const MATCH = '01JLIFECYCLEMATCH0000000AA';
  await expectNoThrow(() => store.matches.record({
    matchId: MATCH, status: 'allocated', mode: 'tdm', mapId: 'the-square', mapVersion: '1.0.0',
    region: 'yyz', rulesSnapshot: { ...TDM_RULES }, players: [{ accountId: account.accountId, team: 'alpha' }],
  }), 'a match row is allocated before a ball is fired');

  const result = matchResult({ matchId: MATCH, status: 'completed', winnerTeam: 'alpha',
    outcomeReason: 'timer', players: [player] });
  const applied = await expectNoThrow(() => mod.stats.applyMatchResult({
    actor: service, result, correlationId: 'corr-lifecycle',
  }), 'the allocated match finalises through applyMatchResult');
  expect(applied?.applied === true && applied.status === 'completed',
    'the finalise reports that THIS call applied it', JSON.stringify(applied));

  // --- 2. result_applied_at is persisted ------------------------------------------------
  const row = await store.matches.byId(MATCH);
  expect(row?.resultAppliedAt === new Date(t0).toISOString(),
    'result_applied_at is persisted on the match row (db-schema.md §4)',
    JSON.stringify(row?.resultAppliedAt));
  expect(row?.status === 'completed' && row.winnerTeam === 'alpha',
    'the row holds the terminal result it finalised with', JSON.stringify(row?.status));

  // CONTROL: a match that ended but has not been applied has a NULL stamp, so the column
  // distinguishes the two states rather than being stamped on everything.
  const QUEUED = '01JLIFECYCLEMATCH0000000BB';
  await store.matches.record({
    matchId: QUEUED, status: 'in-progress', mode: 'tdm', mapId: 'the-square', mapVersion: '1.0.0',
    region: 'yyz', rulesSnapshot: { ...TDM_RULES }, startedAt: new Date(t0 - 600e3).toISOString(),
    endedAt: new Date(t0 - 1e3).toISOString(), players: [{ accountId: account.accountId, team: 'alpha' }],
  });
  const queuedRow = await store.matches.byId(QUEUED);
  expect(queuedRow?.resultAppliedAt === null && queuedRow.endedAt !== null,
    'CONTROL: an ended-but-unapplied match has endedAt and a null result_applied_at',
    JSON.stringify({ e: queuedRow?.endedAt, a: queuedRow?.resultAppliedAt }));

  // --- 3. the terminal status event, per §4.0 -------------------------------------------
  const staged = await store.outbox.claimUnpublished(50);
  const forMatch = staged.filter((e) => e.subjectId === MATCH).map((e) => e.eventType);
  expect(forMatch.includes('match.completed') && forMatch.includes('match.result_applied'),
    '§4.0: a completed match emits match.completed ALONGSIDE match.result_applied',
    JSON.stringify(forMatch));
  const completedEvent = staged.find((e) => e.eventType === 'match.completed');
  expect(completedEvent?.correlationId === 'corr-lifecycle',
    'the terminal event carries the submission correlation id', completedEvent?.correlationId);
  const payload = typeof completedEvent?.payload === 'string'
    ? JSON.parse(completedEvent.payload) : completedEvent?.payload;
  expect(payload?.winnerTeam === 'alpha' && payload.outcomeReason === 'timer'
      && payload.terminationReason === 'completed',
    'the terminal event carries the §4.0 outcome, not just an id', JSON.stringify(payload));

  // CONTROL: the event type follows the STATUS. If it were hard-coded to match.completed — which
  // is what it was — an abort and an invalidation would both announce themselves as a completed
  // match, and every consumer of the catalogue's three distinct types would be wrong.
  for (const [matchId, status, over, expected] of [
    ['01JLIFECYCLEMATCH0000000CC', 'aborted',
      { outcomeReason: 'forfeit', winnerTeam: 'bravo' }, 'match.aborted'],
    ['01JLIFECYCLEMATCH0000000DD', 'invalidated',
      { outcomeReason: 'no-contest', winnerTeam: null }, 'match.invalidated'],
  ]) {
    t += 1000;
    await mod.stats.applyMatchResult({
      actor: service,
      result: matchResult({ matchId, status, players: [playerRow(account.accountId, 'alpha')], ...over }),
    });
    const events = (await store.outbox.claimUnpublished(200))
      .filter((e) => e.subjectId === matchId).map((e) => e.eventType);
    expect(events.includes(expected) && !events.includes('match.completed'),
      `CONTROL: status ${status} emits ${expected} and NOT match.completed`, JSON.stringify(events));
  }

  // --- 4. an incomplete terminal result is refused --------------------------------------
  // §4.2 has no optional keys. A result missing one used to be stored as a finished match.
  for (const field of ['rulesSnapshot', 'endedAt', 'evidenceRef', 'players', 'roster',
    'teamScores', 'rounds', 'serverBuild', 'rulesetVersion', 'winnerTeam']) {
    const partial = matchResult({ matchId: `01JPARTIAL${field.slice(0, 12).toUpperCase().padEnd(16, '0')}`,
      status: 'completed', winnerTeam: 'alpha', outcomeReason: 'timer',
      players: [playerRow(account.accountId, 'alpha')] });
    delete partial[field];
    const err = await expectCode(() => mod.stats.applyMatchResult({ actor: service, result: partial }),
      'VALIDATION_FAILED', `a submitted result with no ${field} is refused`);
    expect((err?.details?.fields || []).some((f) => f.key === field),
      `the refusal names ${field}`, JSON.stringify(err?.details?.fields));
  }
  // CONTROL: the same result with every field present applies, so the refusals are about the
  // missing field and not about a service that has stopped accepting results.
  await expectNoThrow(() => mod.stats.applyMatchResult({
    actor: service,
    result: matchResult({ matchId: '01JPARTIALCONTROL00000000', status: 'completed',
      winnerTeam: 'alpha', outcomeReason: 'timer', players: [playerRow(account.accountId, 'alpha')] }),
  }), 'CONTROL: the complete result applies');

  // --- 5. the §4.2 detail projection ----------------------------------------------------
  //
  // Every call passes a VIEWER. `getMatch` authorises now (§4.2: "caller not a participant,
  // privacy forbids → 404"), and it fails closed when no viewer is supplied — a projection that
  // answered anyone who asked was the defect, so a test that keeps calling it without a caller
  // would be asserting the defect.
  const viewer = { kind: 'player', accountId: account.accountId };
  const terminal = await mod.stats.getMatch(MATCH, { viewer, correlationId: 'corr-detail' });
  const TERMINAL_KEYS = ['matchId', 'status', 'rulesetVersion', 'statDefinitionVersion',
    'rulesSnapshot', 'serverBuild', 'mapId', 'mapVersion', 'region', 'mode', 'startedAt',
    'endedAt', 'terminationReason', 'outcomeReason', 'winnerTeam', 'invalidationReason',
    'roster', 'teamScores', 'rounds', 'players', 'evidenceRef', 'correlationId'];
  expect(JSON.stringify(Object.keys(terminal).sort()) === JSON.stringify([...TERMINAL_KEYS].sort()),
    'the terminal projection is EXACTLY the §4.2 TerminalResult field set',
    JSON.stringify(Object.keys(terminal).sort()));
  expect(terminal.status === 'completed' && terminal.correlationId === 'corr-detail'
      && terminal.invalidationReason === null && terminal.roster.length === 1
      && terminal.players[0].kills === player.kills,
    'the terminal projection carries the discriminant, the roster and the players',
    JSON.stringify({ s: terminal.status, r: terminal.roster.length }));

  const pending = await mod.stats.getMatch(QUEUED, { viewer, correlationId: 'corr-pending' });
  const PENDING_KEYS = ['matchId', 'status', 'mode', 'mapId', 'mapVersion', 'startedAt',
    'endedAt', 'retryAfterMs', 'correlationId'];
  expect(JSON.stringify(Object.keys(pending).sort()) === JSON.stringify([...PENDING_KEYS].sort()),
    'the pending projection is EXACTLY the §4.2 pending field set',
    JSON.stringify(Object.keys(pending).sort()));
  expect(pending.status === 'pending' && pending.endedAt !== null && pending.retryAfterMs > 0
      && pending.correlationId === 'corr-pending',
    '§4.2: an ended, queued match is pending WITH an endedAt', JSON.stringify(pending));

  // CONTROL: `endedAt` is null only while LIVE. Without this the "ended, queued" case above
  // proves nothing — a projection that always returned a timestamp would pass it.
  const LIVE = '01JLIFECYCLEMATCH0000000EE';
  await store.matches.record({
    matchId: LIVE, status: 'in-progress', mode: 'bomb', mapId: 'the-square', mapVersion: '1.0.0',
    region: 'yyz', rulesSnapshot: { ...BOMB_RULES }, startedAt: new Date(t).toISOString(),
    players: [{ accountId: account.accountId, team: 'alpha' }],
  });
  const live = await mod.stats.getMatch(LIVE, { viewer, correlationId: 'corr-live' });
  expect(live.status === 'pending' && live.endedAt === null,
    'CONTROL: a live match is pending with endedAt null', JSON.stringify(live));
  // §4.2: a match nobody can see and a match that never existed are the same answer.
  await expectCode(() => mod.stats.getMatch('01JNOSUCHMATCH0000000000A', { viewer }), 'NOT_FOUND',
    'a match that never existed is NOT_FOUND, not an empty terminal shape');
  // The same answer, byte for byte, for a match that exists and is not the caller's to read.
  await expectCode(() => mod.stats.getMatch(MATCH,
    { viewer: { kind: 'player', accountId: '01JSTRANGER000000000000AA' } }), 'NOT_FOUND',
    'a stranger reading a private participant\'s match gets the SAME NOT_FOUND, never a 403');
  await expectCode(() => mod.stats.getMatch(MATCH), 'NOT_FOUND',
    'and a call with no viewer at all is refused rather than defaulted to visible');
  expect(terminal.evidenceRef === null,
    '§7: evidenceRef is withheld from a player — present as null, never omitted',
    JSON.stringify(terminal.evidenceRef));

  // --- 6. pagination is validated, not clamped ------------------------------------------
  for (const limit of [0, -1, 101, 2.5, '25']) {
    await expectCode(() => mod.stats.history(account.accountId, { limit }),
      'VALIDATION_FAILED', `history refuses limit ${JSON.stringify(limit)}`);
  }
  for (const cursor of ['', 'no spaces allowed', 42, {}]) {
    await expectCode(() => mod.stats.history(account.accountId, { cursor }),
      'VALIDATION_FAILED', `history refuses cursor ${JSON.stringify(cursor)}`);
  }
  // CONTROLS: the legal boundaries page normally, and the §4.3 union still holds.
  const page = await expectNoThrow(() => mod.stats.history(account.accountId, { limit: 1 }),
    'CONTROL: limit 1 pages');
  await expectNoThrow(() => mod.stats.history(account.accountId, { limit: 100 }),
    'CONTROL: limit 100 — the §10 maximum — pages');
  await expectNoThrow(() => mod.stats.history(account.accountId), 'CONTROL: no arguments pages');
  if (page?.nextCursor) {
    await expectNoThrow(() => mod.stats.history(account.accountId, { limit: 1, cursor: page.nextCursor }),
      'CONTROL: the cursor the page handed back is accepted');
  }
  const pendingItem = (await mod.stats.history(account.accountId, { limit: 100 }))
    .items.find((i) => i.matchId === LIVE);
  expect(pendingItem && pendingItem.status === 'pending' && pendingItem.result === null
      && pendingItem.teamScores === null && pendingItem.playerSummary === null
      && 'endedAt' in pendingItem,
    '§4.3: a pending history item carries null for every outcome field and omits none',
    JSON.stringify(pendingItem));

  // §11.5/§6: `mode=all` is per-mode on both the stored and the recomputed side. Nothing sums
  // across modes, and the reconciliation compares like with like.
  const stored = await mod.stats.getCareer(account.accountId, 'all');
  const recomputed = await mod.stats.recomputeCareer(account.accountId, 'all');
  expect(!('totals' in stored) && !!stored.modes?.tdm && !!stored.modes?.bomb,
    'mode=all returns per-mode objects and never a cross-mode sum', JSON.stringify(Object.keys(stored)));
  expect(JSON.stringify(stored.modes) === JSON.stringify(recomputed.modes),
    '§6: the recompute from history equals the stored totals, per mode',
    `${JSON.stringify(stored.modes)}\n       vs ${JSON.stringify(recomputed.modes)}`);

  await store.close();
}

console.log('');
if (failures) {
  console.log(`${failures} FAILURE${failures === 1 ? '' : 'S'}\n`);
  process.exit(1);
}
console.log('all profile checks passed\n');
