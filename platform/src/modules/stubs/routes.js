/**
 * The stub route table — the base behaviour every scenario starts from.
 * contracts/http-api.md §3–§7 and §11.1–§11.9.
 *
 * These handlers are stateful: `PUT /v1/onboarding/consent` records a decision that
 * `POST /v1/auth/signup` then migrates onto the account, terms acceptance compares versions,
 * verification flips a flag that gates the gameplay routes, settings round-trip through a
 * versioned store, and room mutations change the room the next `GET` returns. A scenario in
 * `scenarios.js` layers *faults and variants* on top of this; it does not reimplement the happy
 * path, so there is exactly one definition of what a correct response looks like.
 *
 * **Prerequisites are enforced, not assumed.** The approved order in §3a is a sequence the
 * client "cannot skip ahead or reorder", so signup refuses a receipt it never issued and consent
 * refuses a visitor whose eligibility was never established. A fixture that accepts an invented
 * receipt teaches the shell that the preceding screens are optional.
 *
 * Auth class per row is `P`/`A`/`S` from §2 and is ENFORCED in `gates.js` before a handler runs.
 */
import { ApiError } from '../../core/errors.js';
import { validateRoamingSettings, defaultRoamingValues, SCHEMA_VERSION } from '../profile/settings.js';
// The platform's own slot vocabulary, not a copy: two lists is two places for a slot to drift.
import { EQUIPPABLE_SLOTS } from '../inventory/index.js';
import * as fx from './fixtures.js';
import * as rooms from './rooms.js';
import * as accounts from './accounts.js';
import { stubToken, stubUlid } from './ids.js';

const okBody = (body) => ({ status: 200, body });
const created = (body) => ({ status: 201, body });
const accepted = (body = {}) => ({ status: 202, body });
const noContent = () => ({ status: 204, body: null });

const CONSENT_POLICY_VERSION = 1;

/** `If-Match: "7"` — quotes and the weak marker optional, `*` means "whatever is there now". */
const IF_MATCH_RE = /^(?:W\/)?"?(\d+)"?$/;

function validationFailed(fields) {
  return new ApiError('VALIDATION_FAILED', 'Some fields need attention.', {
    details: { fields },
  });
}

/** §11.8 signup body. `clientSessionId` and `consentReceipt` are REQUIRED, not optional. */
function requireFields(body, names) {
  const missing = names.filter((n) => body[n] === undefined || body[n] === null || body[n] === '');
  if (missing.length) {
    throw validationFailed(missing.map((path) => ({ path, rule: 'required', message: 'This field is required.' })));
  }
}

/** §10 pagination. Cursor-based only — offset pagination double-counts under concurrent insert. */
function paginate(items, query) {
  const limitRaw = query.limit;
  let limit = 25;
  if (limitRaw !== undefined) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw validationFailed([{ path: 'limit', rule: 'range', message: 'limit is 1–100.' }]);
    }
  }
  const start = query.cursor ? Number(query.cursor) : 0;
  if (!Number.isInteger(start) || start < 0) {
    throw validationFailed([{ path: 'cursor', rule: 'format', message: 'cursor is opaque; pass one the server issued.' }]);
  }
  const page = items.slice(start, start + limit);
  const next = start + limit < items.length ? String(start + limit) : null;
  return { items: page, nextCursor: next };
}

/** The account-scoped consent projection for a profile, or null when undecided. */
function consentProjection(state) {
  if (!state.consent) return null;
  return {
    telemetryPersonal: state.consent.telemetryPersonal,
    policyVersion: state.consent.policyVersion,
    decidedAt: state.consent.decidedAt,
  };
}

/** The §4 profile object, with the setup discriminator derived from the session's own state. */
function profileFor(state, overrides = {}) {
  return fx.profileMe({
    consent: consentProjection(state),
    moderation: state.moderation,
    displayName: state.displayName,
    setupNextStep: fx.setupNextStepFor(state),
    ...overrides,
  });
}

/**
 * The session this tab holds, as `§11.8` shapes it.
 *
 * `sessionId` is the tab's own id from the account scope — one of the ids
 * `GET /v1/auth/sessions` lists. It used to be minted from the clock, so the id signin handed
 * back appeared in no session list and "revoke the session I am using" was unexpressible.
 */
function sessionBlock(ctx) {
  return {
    sessionId: ctx.sessionId,
    deviceLabel: ctx.sessionId === fx.CURRENT_SESSION_ID ? 'Chrome on macOS' : 'Firefox on Windows',
    createdAt: ctx.clock.now(),
  };
}

/**
 * The access token for this tab, at this generation.
 *
 * Seeded by the tab's SESSION id, not just the generation: two tabs of one account were handed
 * the identical string, so revoking either session invalidated both — and the account could
 * never demonstrate the one behaviour the session screen is for. The session id is
 * position-derived (accounts.js), so this is still identical on replay.
 */
const accessTokenFor = (ctx) => stubToken('access', `access:${ctx.sessionId}:${ctx.state.tokenGeneration}`);

function authPayload(ctx, { status }) {
  const { clock, state } = ctx;
  const accessToken = accessTokenFor(ctx);
  state.issuedTokens.push(accessToken);
  // Registered on the ACCOUNT, so the gate can tell a token this layer minted from one a
  // client typed, and so a revocation in another tab reaches this one.
  accounts.issueToken(ctx.account, accessToken, ctx.sessionId);
  const body = {
    accessToken,
    expiresAt: clock.plus(ctx.accessTokenTtlMs),
    session: sessionBlock(ctx),
    profile: profileFor(state),
    // §3a.3: signup AND signin return the account-scoped receipt; null means undecided.
    consentReceipt: state.consent ? state.consent.accountReceipt : null,
  };
  return { status, body };
}

/** The room this request names, or `ROOM_NOT_FOUND`. */
const room = (ctx) => rooms.roomFor(ctx.state, ctx.params.id);

/** §11.4 and §6: a mutation requires membership, and says so with the contracted code. */
function requireMembership(r) {
  const me = rooms.localMember(r);
  if (!me) throw new ApiError('NOT_IN_ROOM', 'You are not in that room.');
  return me;
}

// ── P3 item helpers ─────────────────────────────────────────────────────────────────────────

/** The per-session item state, seeded lazily so scenarios that never touch items pay nothing. */
function itemsStateOf(ctx) {
  if (!ctx.state.items) ctx.state.items = fx.itemsState();
  return ctx.state.items;
}

/** §8: Idempotency-Key is REQUIRED on the P3 writes — same refusal shape as the real routes. */
function requireIdempotencyKey(ctx) {
  const raw = ctx.headers['idempotency-key'];
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key is required on this request.', {
      details: { fields: [{ key: 'Idempotency-Key', reason: 'required' }] },
    });
  }
  return raw.trim();
}

function requireLoadoutName(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 100) {
    throw new ApiError('VALIDATION_FAILED', 'A loadout needs a name (1–100 characters).', {
      details: { fields: [{ key: 'name', reason: name ? 'too-long' : 'required' }] },
    });
  }
  return name.trim();
}

/** items-inventory.md §3.1 rules 1/2/3/5, over the session's own instances. */
function validateLoadoutSlots(st, slots) {
  if (slots === null || typeof slots !== 'object' || Array.isArray(slots)) {
    throw validationFailed([{ path: 'slots', rule: 'object', message: 'slots is slot -> instanceId.' }]);
  }
  const seen = new Set();
  for (const [slotKey, instanceId] of Object.entries(slots)) {
    if (instanceId == null) continue;
    if (!EQUIPPABLE_SLOTS.includes(slotKey)) {
      throw new ApiError('LOADOUT_INVALID_SLOT', `${slotKey} is not an equippable slot.`,
        { details: { slot: slotKey } });
    }
    if (seen.has(instanceId)) {
      throw new ApiError('LOADOUT_DUPLICATE_INSTANCE', `Instance ${instanceId} used twice in one loadout.`,
        { details: { instanceId } });
    }
    seen.add(instanceId);
    const row = st.instances[instanceId];
    if (!row || row.location !== 'permanent' || row.status !== 'active' || row.locked) {
      throw new ApiError('LOADOUT_ITEM_NOT_OWNED', `Instance ${instanceId} is not owned and idle.`,
        { details: { instanceId } });
    }
    if (fx.itemDefinition(row.itemId).slot !== slotKey) {
      throw new ApiError('LOADOUT_INVALID_SLOT', `Instance ${instanceId} does not fit slot ${slotKey}.`,
        { details: { instanceId, slot: slotKey } });
    }
  }
  return { ...slots };
}

export const ROUTES = [
  // ── §3 auth ───────────────────────────────────────────────────────────────────────────────
  { method: 'POST', path: '/v1/auth/signup', auth: 'P', handler(ctx) {
    requireFields(ctx.body, ['email', 'password', 'displayName', 'eligibilityReceipt',
      'clientSessionId', 'consentReceipt']);
    const { state } = ctx;
    // §3a: "The client may navigate back, but it cannot skip ahead or reorder these calls."
    // The receipts are the evidence that the preceding screens actually happened, so they are
    // compared against what this session was issued rather than merely being present.
    if (!state.eligible) {
      throw new ApiError('AUTH_ELIGIBILITY_REQUIRED', 'Complete the age check first.');
    }
    if (ctx.body.eligibilityReceipt !== state.eligibilityReceipt) {
      throw new ApiError('ELIGIBILITY_RECEIPT_INVALID', 'Your age check expired. Please start again.');
    }
    if (!state.consent) {
      throw validationFailed([{ path: 'consentReceipt', rule: 'prerequisite',
        message: 'Answer the telemetry question before creating an account.' }]);
    }
    if (ctx.body.consentReceipt !== state.consent.sessionReceipt) {
      throw validationFailed([{ path: 'consentReceipt', rule: 'receipt',
        message: 'That consent receipt was not issued to this client session.' }]);
    }
    // Migration (§3a.3): the signed-out decision becomes account-scoped and gets a new receipt.
    state.consent.subject = 'account';
    state.consent.accountReceipt = stubToken('consent-account', `consent:account:${ctx.scenario}`);
    state.consentMigrated = true;
    state.signedUp = true;
    state.displayName = ctx.body.displayName;
    state.tokenIssuedAt = ctx.clock.nowMs();
    return authPayload(ctx, { status: 201 });
  } },

  { method: 'POST', path: '/v1/auth/signin', auth: 'P', handler(ctx) {
    requireFields(ctx.body, ['email', 'password']);
    ctx.state.signedUp = true;
    ctx.state.tokenIssuedAt = ctx.clock.nowMs();
    return authPayload(ctx, { status: 200 });
  } },

  // §11.1: empty body. The refresh credential travels only as an httpOnly cookie, so there is
  // nothing here for XSS to read and nothing for the client to forward.
  { method: 'POST', path: '/v1/auth/refresh', auth: 'P', handler(ctx) {
    ctx.state.tokenGeneration++;
    ctx.state.tokenIssuedAt = ctx.clock.nowMs();
    const accessToken = accessTokenFor(ctx);
    ctx.state.issuedTokens.push(accessToken);
    accounts.issueToken(ctx.account, accessToken, ctx.sessionId);
    return okBody({
      accessToken,
      expiresAt: ctx.clock.plus(ctx.accessTokenTtlMs),
      session: sessionBlock(ctx),
    });
  } },

  // §3: signout revokes "the current session only", signout-all "every session including the
  // caller's". Both write to the ACCOUNT, so the other tab sees them — which is what makes
  // cross-tab revocation, a designed shell state, reachable at all.
  { method: 'POST', path: '/v1/auth/signout', auth: 'A', handler(ctx) {
    accounts.revokeSession(ctx.account, ctx.sessionId);
    return noContent();
  } },
  { method: 'POST', path: '/v1/auth/signout-all', auth: 'A', handler(ctx) {
    accounts.revokeAll(ctx.account);
    return noContent();
  } },
  { method: 'GET', path: '/v1/auth/sessions', auth: 'A', handler(ctx) {
    return okBody({ sessions: accounts.sessionList(ctx.account, ctx.sessionId) });
  } },
  { method: 'DELETE', path: '/v1/auth/sessions/:id', auth: 'A', handler(ctx) {
    // §11.8: NOT_FOUND is a documented outcome. Answering 204 for an id that was never a session
    // tells the UI a revocation happened that did not.
    const known = fx.sessionsList().some((s) => s.sessionId === ctx.params.id);
    if (!known || accounts.isRevoked(ctx.account, ctx.params.id)) {
      throw new ApiError('NOT_FOUND', 'That session no longer exists.');
    }
    accounts.revokeSession(ctx.account, ctx.params.id);
    return noContent();
  } },

  /**
   * §3b `POST /v1/auth/display-name/check` — availability preflight (REQ-CC-046).
   *
   * The shell has to give live feedback while the player types, and the only authoritative
   * answer used to be the mutation itself. Three properties are load-bearing and all three are
   * implemented here rather than described:
   *
   *   1. **It reveals nothing about the holder.** A taken name answers
   *      `{ available: false, policy: null }` and nothing else — no account id, no profile link.
   *      Policy is evaluated FIRST, so a refused name never discloses whether it also exists.
   *   2. **The client does not reproduce the ruleset.** The server names the rule that refused;
   *      the candidate is not scored client-side (design/first-run-flow.md §3).
   *   3. **It is advisory.** Nothing is reserved. Signup and rename stay authoritative and can
   *      still lose the race, so the shell keeps its NAME_TAKEN path.
   */
  { method: 'POST', path: '/v1/auth/display-name/check', auth: 'P', handler(ctx) {
    if (typeof ctx.body.displayName !== 'string') {
      throw validationFailed([{ path: 'displayName', rule: 'string', message: 'Type a name to check.' }]);
    }
    // §9 name-check class. Counted on the normalised virtual clock, so a scenario can reach the
    // limit deterministically instead of by racing a real one.
    ctx.state.nameCheckTimes = ctx.state.nameCheckTimes
      .filter((t) => ctx.clock.nowMs() - t < 60 * 1000);
    ctx.state.nameCheckTimes.push(ctx.clock.nowMs());
    if (ctx.state.nameCheckTimes.length > fx.NAME_CHECK_PER_MINUTE) {
      throw new ApiError('RATE_LIMITED', 'Too many name checks. Try again shortly.',
        { retryAfterMs: 60 * 1000 });
    }
    return okBody(fx.displayNameVerdict(ctx.body.displayName));
  } },

  // Always 202, whether or not the account exists — the response is the same either way, or it
  // becomes an account-existence oracle.
  { method: 'POST', path: '/v1/auth/recovery/start', auth: 'P', handler(ctx) {
    requireFields(ctx.body, ['email']);
    ctx.state.recoveryStarted = true;
    return accepted();
  } },
  { method: 'POST', path: '/v1/auth/recovery/complete', auth: 'P', handler(ctx) {
    requireFields(ctx.body, ['token', 'newPassword']);
    return noContent();
  } },

  // ── §3a onboarding ────────────────────────────────────────────────────────────────────────
  { method: 'POST', path: '/v1/onboarding/eligibility', auth: 'P', handler(ctx) {
    requireFields(ctx.body, ['dateOfBirth', 'jurisdiction']);
    ctx.state.eligible = true;
    ctx.state.eligibilityReceipt = stubToken('eligibility', `eligibility:${ctx.scenario}`);
    return okBody({
      eligible: true,
      receipt: ctx.state.eligibilityReceipt,
      expiresAt: ctx.clock.plus(30 * 60 * 1000),
      // §3a.1: `minimumAge` is deliberately absent. Publishing the number the gate tests
      // against is how the next attempt clears it.
      policyVersion: CONSENT_POLICY_VERSION,
    });
  } },

  { method: 'GET', path: '/v1/onboarding/consent', auth: 'P', handler(ctx) {
    // 204 when undecided: there is no decision to report, and inventing `telemetryPersonal:
    // false` would be recording a decline nobody made.
    if (!ctx.state.consent) return noContent();
    const c = ctx.state.consent;
    return okBody({
      telemetryPersonal: c.telemetryPersonal,
      policyVersion: c.policyVersion,
      decidedAt: c.decidedAt,
      subject: c.subject,
      receipt: c.subject === 'account' ? c.accountReceipt : c.sessionReceipt,
    });
  } },

  { method: 'PUT', path: '/v1/onboarding/consent', auth: 'P', handler(ctx) {
    const { body, state } = ctx;
    if (typeof body.telemetryPersonal !== 'boolean') {
      throw validationFailed([{ path: 'telemetryPersonal', rule: 'boolean', message: 'Answer is required.' }]);
    }
    // §3a.3: required when signed out, ignored when authenticated — the account is the
    // stronger subject.
    const authenticated = ctx.authenticated || state.signedUp;
    if (!authenticated && !body.clientSessionId) {
      throw validationFailed([{ path: 'clientSessionId', rule: 'required', message: 'Required while signed out.' }]);
    }
    // "Consent, asked ONLY of eligible visitors" (§3a): eligibility precedes consent so that a
    // visitor who cannot give it is never asked. A signed-out consent write with no eligibility
    // on record is a client that skipped the gate.
    if (!authenticated && !state.eligible) {
      throw new ApiError('AUTH_ELIGIBILITY_REQUIRED', 'Complete the age check first.');
    }
    const subject = authenticated ? 'account' : 'client-session';
    state.consent = {
      telemetryPersonal: body.telemetryPersonal,
      policyVersion: body.policyVersion ?? CONSENT_POLICY_VERSION,
      decidedAt: ctx.clock.now(),
      subject,
      sessionReceipt: stubToken('consent-session', `consent:session:${ctx.scenario}`),
      accountReceipt: stubToken('consent-account', `consent:account:${ctx.scenario}`),
    };
    return okBody({
      telemetryPersonal: state.consent.telemetryPersonal,
      policyVersion: state.consent.policyVersion,
      decidedAt: state.consent.decidedAt,
      subject,
      receipt: subject === 'account' ? state.consent.accountReceipt : state.consent.sessionReceipt,
    });
  } },

  { method: 'POST', path: '/v1/onboarding/verify/resend', auth: 'A', handler(ctx) {
    ctx.state.verifyResends++;
    return accepted();
  } },

  { method: 'POST', path: '/v1/onboarding/verify/complete', auth: 'A', handler(ctx) {
    requireFields(ctx.body, ['token']);
    ctx.state.verified = true;
    return noContent();
  } },

  { method: 'GET', path: '/v1/onboarding/terms', auth: 'P', handler(ctx) {
    return okBody({
      version: ctx.state.termsVersion,
      url: `${fx.TERMS_URL}/v${ctx.state.termsVersion}`,
      publishedAt: ctx.clock.fromEpoch(-30 * 24 * 3600 * 1000),
    });
  } },

  { method: 'POST', path: '/v1/onboarding/terms/accept', auth: 'A', handler(ctx) {
    requireFields(ctx.body, ['version']);
    const current = ctx.state.termsVersion;
    if (ctx.body.version !== current) {
      throw new ApiError('CONFLICT', 'The terms have been updated since you last read them.', {
        details: {
          currentVersion: current,
          url: `${fx.TERMS_URL}/v${current}`,
          publishedAt: ctx.clock.fromEpoch(-30 * 24 * 3600 * 1000),
        },
      });
    }
    ctx.state.termsAccepted = true;
    return noContent();
  } },

  // ── §4 profile ────────────────────────────────────────────────────────────────────────────
  { method: 'GET', path: '/v1/profile/me', auth: 'A', handler(ctx) {
    return okBody(profileFor(ctx.state));
  } },

  { method: 'PATCH', path: '/v1/profile/me', auth: 'A', handler(ctx) {
    if (ctx.body.displayName !== undefined && typeof ctx.body.displayName !== 'string') {
      throw validationFailed([{ path: 'displayName', rule: 'string', message: 'Display name must be text.' }]);
    }
    if (ctx.body.displayName) ctx.state.displayName = ctx.body.displayName;
    return okBody(profileFor(ctx.state));
  } },

  /**
   * §11.2. `values` round-trips: what a PUT stores is what the next GET returns, at a version
   * that advanced by one, with the `ETag` the next `If-Match` has to carry. The previous handler
   * ignored the body entirely and returned four fixed values, so a settings screen built against
   * it could never discover that its writes did nothing.
   */
  { method: 'GET', path: '/v1/profile/me/settings', auth: 'A', handler(ctx) {
    const s = ctx.state.settings;
    return {
      status: 200,
      headers: { ETag: `"${s.version}"` },
      body: {
        schemaVersion: SCHEMA_VERSION,
        version: s.version,
        values: s.values,
        updatedAt: s.updatedAt,
      },
    };
  } },

  { method: 'PUT', path: '/v1/profile/me/settings', auth: 'A', handler(ctx) {
    const s = ctx.state.settings;
    const ifMatch = ctx.headers['if-match'];
    // §3a.4: a missing `If-Match` is CONFLICT with a reason, never 428. One code, one status,
    // or the client cannot branch on status at all.
    if (!ifMatch) {
      throw new ApiError('CONFLICT', 'Settings require an If-Match header.', { details: { reason: 'if-match-required' } });
    }
    const raw = String(ifMatch).trim();
    const parsed = IF_MATCH_RE.test(raw) ? Number(raw.replace(/[W/"]/g, '')) : NaN;
    const want = raw === '*' ? s.version : parsed;
    if (Number.isNaN(want)) {
      throw new ApiError('CONFLICT', 'If-Match is not a settings version.', { details: { reason: 'if-match-required' } });
    }
    if (want !== s.version) {
      // The 409 returns the current server state so the UI can merge rather than re-fetch.
      throw new ApiError('CONFLICT', 'These settings changed on another device.', {
        details: { currentVersion: s.version, values: s.values },
      });
    }
    if (ctx.body.schemaVersion !== SCHEMA_VERSION) {
      throw validationFailed([{ path: 'schemaVersion', rule: 'unsupported',
        message: `Settings schema version ${SCHEMA_VERSION} is the only one this build accepts.` }]);
    }
    // §11.9: a DEVICE, SESSION or PRACTICE key, or a value outside its range/step/enum, is
    // REJECTED — never clamped, because a clamped setting is one the player did not choose and
    // cannot see they did not get. Validated by the platform's generated validator, so the stub
    // cannot accept a shape the real endpoint refuses.
    const { errors } = validateRoamingSettings(ctx.body.values);
    if (errors.length) {
      throw validationFailed(errors.map((e) => ({ ...e, path: e.key, rule: e.reason, message: 'This setting was rejected.' })));
    }
    // Full replace: an absent ROAM key reverts to its documented default, or a reset-to-default
    // would be unexpressible.
    const merged = { ...defaultRoamingValues(), ...ctx.body.values };
    merged.keybinds = ctx.body.values.keybinds ?? {};
    s.values = merged;
    s.version++;
    s.updatedAt = ctx.clock.now();
    ctx.state.essentialSettingsDone = true;
    return {
      status: 200,
      headers: { ETag: `"${s.version}"` },
      body: { schemaVersion: SCHEMA_VERSION, version: s.version, values: s.values, updatedAt: s.updatedAt },
    };
  } },

  { method: 'GET', path: '/v1/profile/:accountId/stats', auth: 'A', handler(ctx) {
    const mode = ctx.query.mode ?? 'all';
    if (!['tdm', 'bomb', 'all'].includes(mode)) {
      throw validationFailed([{ path: 'mode', rule: 'enum', message: 'mode is tdm, bomb, or all.' }]);
    }
    const scale = ctx.state.emptyCareer ? 0 : 1;
    // §11.8: `all` does NOT sum across modes — a combined K/D over two rulesets with different
    // death semantics is a number that means nothing.
    if (mode === 'all') {
      return okBody({ modes: { tdm: fx.statsTotals('tdm', { scale }), bomb: fx.statsTotals('bomb', { scale }) } });
    }
    return okBody(fx.statsTotals(mode, { scale }));
  } },

  { method: 'GET', path: '/v1/profile/:accountId/matches', auth: 'A', handler(ctx) {
    const items = ctx.state.emptyCareer ? [] : fx.historyItems();
    return okBody(paginate(items, ctx.query));
  } },

  { method: 'GET', path: '/v1/profile/:accountId', auth: 'A', handler(ctx) {
    // The caller's own public projection is how a reloaded shell discovers it is still in a
    // lobby (design/first-run-flow.md, "Active lobby membership → Lobby resync screen"):
    // `presence.roomId` is the only contracted place that room id survives a reload.
    if (ctx.params.accountId === fx.ACCOUNT_ID) {
      return okBody(fx.selfProfile({
        displayName: ctx.state.displayName,
        statsVisible: !ctx.state.privacyFiltered,
        activeRoomId: ctx.state.activeRoomId,
      }));
    }
    return okBody(fx.publicProfile({
      statsVisible: !ctx.state.privacyFiltered,
      presenceVisible: !ctx.state.privacyFiltered,
    }));
  } },

  // ── §5 presence ───────────────────────────────────────────────────────────────────────────
  { method: 'GET', path: '/v1/presence/online', auth: 'A', handler(ctx) {
    return okBody(paginate(fx.presenceItems(), ctx.query));
  } },
  { method: 'GET', path: '/v1/presence/recent', auth: 'A', handler(ctx) {
    return okBody(paginate(fx.presenceItems().slice(0, 2), ctx.query));
  } },

  // ── §6 rooms ──────────────────────────────────────────────────────────────────────────────
  { method: 'GET', path: '/v1/rooms', auth: 'A', handler(ctx) {
    const allowed = new Set(['region', 'mode', 'hasSpace', 'limit', 'cursor']);
    // §6: unknown parameters are rejected rather than ignored, so a typo in a filter is a
    // visible failure and not a silently wider result set.
    for (const key of Object.keys(ctx.query)) {
      if (!allowed.has(key)) {
        throw validationFailed([{ path: key, rule: 'unknown', message: 'Unknown query parameter.' }]);
      }
    }
    const rtt = fx.parseRegionRtt(ctx.headers['x-region-rtt']);
    let list = fx.ROOM_IDS.map((id) => rooms.core(rooms.roomFor(ctx.state, id), { rtt }));
    if (ctx.query.region) list = list.filter((r) => r.region === ctx.query.region);
    if (ctx.query.mode) list = list.filter((r) => r.mode === ctx.query.mode);
    if (ctx.query.hasSpace === 'true') list = list.filter((r) => r.playerCount < r.capacity);
    return okBody(paginate(list, ctx.query));
  } },

  { method: 'POST', path: '/v1/rooms', auth: 'A', handler(ctx) {
    requireFields(ctx.body, ['name', 'region', 'mapId', 'mode', 'capacity']);
    if (!['tdm', 'bomb'].includes(ctx.body.mode)) {
      throw validationFailed([{ path: 'mode', rule: 'enum', message: 'mode is tdm or bomb.' }]);
    }
    const roomId = stubUlid(`room:created:${ctx.scenario}`, ctx.clock.nowMs());
    const index = ctx.body.mode === 'bomb' ? 1 : 0;
    const res = fx.reservation(ctx.clock, `create:${ctx.scenario}`);
    // Creating a room joins it (§11.3a), so the created room is adopted into session state and
    // its id resolves on every later request — the previous handler minted an id that came back
    // as room A's fixture on the next GET.
    const createdRoom = rooms.adoptRoom(ctx.state, {
      roomId,
      index,
      core: fx.roomCore(index, {
        roomId,
        overrides: {
          name: ctx.body.name, region: ctx.body.region, capacity: ctx.body.capacity,
          playerCount: 1, status: 'open', joinable: true, joinBlockedReason: null,
          hasPassword: Boolean(ctx.body.password), ownerAccountId: fx.ACCOUNT_ID,
        },
      }),
      roster: fx.roster(index, { count: 1, roomId }),
      countdown: null,
      frozen: false,
    });
    createdRoom.roster[0].isOwner = true;
    ctx.state.activeRoomId = roomId;
    return created({
      room: rooms.core(createdRoom),
      roster: createdRoom.roster.map((m) => ({ ...m })),
      countdown: null,
      ...res,
    });
  } },

  { method: 'GET', path: '/v1/rooms/:id', auth: 'A', handler(ctx) {
    const rtt = fx.parseRegionRtt(ctx.headers['x-region-rtt']);
    return okBody(rooms.detail(room(ctx), { rtt }));
  } },

  { method: 'POST', path: '/v1/rooms/:id/join', auth: 'A', handler(ctx) {
    const r = room(ctx);
    if (!rooms.localMember(r)) {
      rooms.assertJoinable(r);
      r.roster.push(fx.joiningMember(r.roomId, r.roster.length));
      // §7: a join changes the shape of the match everyone else consented to.
      rooms.clearReady(r);
    }
    ctx.state.activeRoomId = r.roomId;
    return okBody(fx.reservation(ctx.clock, `join:${ctx.scenario}`));
  } },

  { method: 'POST', path: '/v1/rooms/:id/leave', auth: 'A', handler(ctx) {
    // Idempotent by nature: 204 even if not a member (§11.8).
    const r = room(ctx);
    r.roster = r.roster.filter((m) => !m.isLocal);
    if (ctx.state.activeRoomId === r.roomId) ctx.state.activeRoomId = null;
    return noContent();
  } },

  { method: 'POST', path: '/v1/rooms/:id/team', auth: 'A', handler(ctx) {
    if (!['alpha', 'bravo', 'auto'].includes(ctx.body.team)) {
      throw validationFailed([{ path: 'team', rule: 'enum', message: 'team is alpha, bravo, or auto.' }]);
    }
    const r = room(ctx);
    const me = requireMembership(r);
    if (r.frozen) throw new ApiError('TEAM_SWITCH_FORBIDDEN', 'The roster is locked for launch.');
    // The server decides; `auto` is a preference, so it resolves to the smaller side.
    const want = ctx.body.team === 'auto'
      ? (r.roster.filter((m) => m.team === 'alpha').length
        <= r.roster.filter((m) => m.team === 'bravo').length ? 'alpha' : 'bravo')
      : ctx.body.team;
    const already = r.roster.filter((m) => m.team === want && !m.isLocal).length;
    if (already >= r.core.capacity / 2) throw new ApiError('TEAM_FULL', 'That team is full.');
    me.team = want;
    rooms.clearReady(r);          // §7: any team change clears readiness
    return okBody(rooms.detail(r));
  } },

  { method: 'POST', path: '/v1/rooms/:id/ready', auth: 'A', handler(ctx) {
    if (typeof ctx.body.ready !== 'boolean') {
      throw validationFailed([{ path: 'ready', rule: 'boolean', message: 'ready must be true or false.' }]);
    }
    const r = room(ctx);
    requireMembership(r).ready = ctx.body.ready;
    return okBody(rooms.detail(r));
  } },

  { method: 'POST', path: '/v1/rooms/:id/loadout', auth: 'A', handler(ctx) {
    const { primaryIdx, secondaryIdx } = ctx.body;
    if (!Number.isInteger(primaryIdx) || !Number.isInteger(secondaryIdx)
        || primaryIdx < 0 || primaryIdx > 5 || secondaryIdx < 0 || secondaryIdx > 3) {
      throw validationFailed([{ path: 'primaryIdx', rule: 'range', message: 'Index out of range for this ruleset.' }]);
    }
    const r = room(ctx);
    const me = requireMembership(r);
    me.loadout = { primaryIdx, secondaryIdx };
    me.ready = false;             // §7: the readying player changing loadout clears their ready
    return okBody(rooms.detail(r));
  } },

  { method: 'POST', path: '/v1/rooms/:id/launch', auth: 'A', handler(ctx) {
    const r = room(ctx);
    requireMembership(r);
    rooms.assertLaunchable(r);    // owner-only, and 409 unless every required player is ready
    rooms.startCountdown(r, ctx.clock);
    return accepted();
  } },

  { method: 'POST', path: '/v1/rooms/:id/reconnect-ticket', auth: 'A', handler(ctx) {
    const r = room(ctx);
    // §6: "Requires an authenticated account that still holds a seat in the room. It does not
    // create membership" — so a non-member gets a refusal, not a ticket into a room they left.
    requireMembership(r);
    const res = fx.reservation(ctx.clock, `reconnect:${ctx.scenario}`);
    return okBody({
      lobbySocketUrl: res.lobbySocketUrl,
      lobbyTicket: res.lobbyTicket,
      expiresAt: res.expiresAt,
      graceEndsAt: ctx.clock.plus(90 * 1000),
    });
  } },

  // ── §7 matches, reports, config ───────────────────────────────────────────────────────────
  // §7.1: reload discovery. 204 means no held match — the default for a signed-in account that
  // is not in one.
  { method: 'GET', path: '/v1/matches/active', auth: 'A', handler: () => noContent() },

  { method: 'GET', path: '/v1/matches/:matchId', auth: 'A', handler(ctx) {
    return okBody(fx.terminalResult(ctx.params.matchId, {
      status: 'completed', outcomeReason: 'defuse', winnerTeam: 'alpha',
    }));
  } },

  { method: 'POST', path: '/v1/matches/:matchId/reconnect-ticket', auth: 'A', handler(ctx) {
    return okBody({
      handoff: fx.matchHandoff(ctx.params.matchId, ctx.clock),
      graceEndsAt: ctx.clock.plus(90 * 1000),
      // The client converts against `serverNow`, never its own clock: a client counting down
      // from its own drop timestamp disagrees with the server about when its seat expires.
      serverNow: ctx.clock.now(),
    });
  } },

  { method: 'POST', path: '/v1/reports', auth: 'A', handler(ctx) {
    requireFields(ctx.body, ['subjectAccountId', 'category']);
    const categories = ['cheating', 'harassment', 'offensive-name', 'griefing', 'other'];
    if (!categories.includes(ctx.body.category)) {
      throw validationFailed([{ path: 'category', rule: 'enum', message: 'Unknown report category.' }]);
    }
    return created({ reportId: stubUlid(`report:${ctx.scenario}`, ctx.clock.nowMs()) });
  } },

  { method: 'GET', path: '/v1/config/flags', auth: 'A', handler(ctx) {
    return {
      status: 200,
      headers: { 'Cache-Control': 'max-age=60' },
      body: {
        version: 41,
        evaluatedAt: ctx.clock.now(),
        expiresAt: ctx.clock.plus(60 * 1000),
        flags: fx.clientFlags(),
      },
    };
  } },

  { method: 'GET', path: '/v1/config/regions', auth: 'P', handler: () => okBody({ regions: fx.REGIONS }) },

  // ── P3: inventory, loadouts, deployments ────────────────────────────────────────────────
  // items-inventory.md §7 and deployment.md §7, stateful like the rooms above: a reservation
  // locks the instances it names and an abort unlocks them, so the loadout editor and the
  // deploy flow can be exercised end to end against fixtures. The S-marked rows
  // (verify-snapshot, timeout release, run-result, the exception queue) are deliberately
  // ABSENT for the same reason POST /v1/matches/:matchId/result is: their entire security
  // property is that the shell cannot reach them.

  { method: 'GET', path: '/v1/inventory', auth: 'A', handler(ctx) {
    const st = itemsStateOf(ctx);
    const rows = Object.values(st.instances)
      .filter((r) => r.location === 'permanent' && r.status === 'active')
      .sort((a, b) => a.instanceId.localeCompare(b.instanceId));
    const page = paginate(rows, ctx.query);
    return okBody({ items: page.items.map(fx.itemInstanceBody), nextCursor: page.nextCursor });
  } },

  { method: 'GET', path: '/v1/inventory/:instanceId', auth: 'A', handler(ctx) {
    const row = itemsStateOf(ctx).instances[ctx.params.instanceId];
    if (!row) throw new ApiError('NOT_FOUND', 'No such instance.');
    return okBody(fx.itemInstanceBody(row));
  } },

  { method: 'GET', path: '/v1/loadouts', auth: 'A', handler(ctx) {
    return okBody({ loadouts: itemsStateOf(ctx).loadouts.map(fx.loadoutBody) });
  } },

  { method: 'POST', path: '/v1/loadouts', auth: 'A', handler(ctx) {
    requireIdempotencyKey(ctx);
    const st = itemsStateOf(ctx);
    const name = requireLoadoutName(ctx.body.name);
    const slots = validateLoadoutSlots(st, ctx.body.slots ?? {});
    const row = {
      loadoutId: stubUlid(`loadout:new:${ctx.scenario}:${st.loadouts.length}`, ctx.clock.nowMs()),
      name, slots, isDefault: false,
    };
    st.loadouts.push(row);
    return okBody(fx.loadoutBody(row));
  } },

  { method: 'PATCH', path: '/v1/loadouts/:loadoutId', auth: 'A', handler(ctx) {
    requireIdempotencyKey(ctx);
    const st = itemsStateOf(ctx);
    const row = st.loadouts.find((l) => l.loadoutId === ctx.params.loadoutId);
    if (!row) throw new ApiError('NOT_FOUND', 'No such loadout.');
    if ('name' in ctx.body) row.name = requireLoadoutName(ctx.body.name);
    if ('slots' in ctx.body) row.slots = validateLoadoutSlots(st, ctx.body.slots ?? {});
    if (ctx.body.isDefault === true) {
      for (const other of st.loadouts) other.isDefault = other === row;
    }
    return okBody(fx.loadoutBody(row));
  } },

  { method: 'DELETE', path: '/v1/loadouts/:loadoutId', auth: 'A', handler(ctx) {
    const st = itemsStateOf(ctx);
    const at = st.loadouts.findIndex((l) => l.loadoutId === ctx.params.loadoutId);
    if (at === -1) throw new ApiError('NOT_FOUND', 'No such loadout.');
    st.loadouts.splice(at, 1);
    return noContent();
  } },

  { method: 'POST', path: '/v1/loadouts/:loadoutId/set-default', auth: 'A', handler(ctx) {
    const st = itemsStateOf(ctx);
    const row = st.loadouts.find((l) => l.loadoutId === ctx.params.loadoutId);
    if (!row) throw new ApiError('NOT_FOUND', 'No such loadout.');
    for (const other of st.loadouts) other.isDefault = other === row;
    return okBody(fx.loadoutBody(row));
  } },

  // deployment.md §7: exactly one of loadoutId / non-empty instanceIds. Locks what it reserves,
  // so a second reservation naming the same instance answers the §3 409 with the per-instance
  // breakdown, and an abort genuinely frees it.
  { method: 'POST', path: '/v1/deployments', auth: 'A', handler(ctx) {
    requireIdempotencyKey(ctx);
    const st = itemsStateOf(ctx);
    const { loadoutId = null, instanceIds = null, roomId = null } = ctx.body;
    const hasLoadout = loadoutId !== null && loadoutId !== undefined;
    const hasInstances = instanceIds !== null && instanceIds !== undefined;
    if (hasLoadout === hasInstances || (hasInstances && (!Array.isArray(instanceIds) || instanceIds.length === 0))) {
      throw new ApiError('DEPLOYMENT_REQUEST_INVALID',
        'Exactly one of loadoutId or a non-empty instanceIds is required.',
        { details: { fields: ['loadoutId', 'instanceIds'] } });
    }
    let candidateIds;
    if (hasLoadout) {
      const loadout = st.loadouts.find((l) => l.loadoutId === loadoutId);
      if (!loadout) throw new ApiError('NOT_FOUND', 'No such loadout.');
      candidateIds = EQUIPPABLE_SLOTS.map((slot) => loadout.slots[slot]).filter((v) => v != null);
      if (candidateIds.length === 0) {
        throw new ApiError('DEPLOYMENT_REQUEST_INVALID', 'That loadout has no equipped slots.',
          { details: { fields: ['loadoutId'] } });
      }
    } else {
      candidateIds = instanceIds;
      const seenSlot = new Map();
      for (const id of candidateIds) {
        const row = st.instances[id];
        if (!row) continue;   // rule 1 catches it at lock time, as the real module does
        const slot = fx.itemDefinition(row.itemId).slot;
        if (slot == null) {
          throw new ApiError('LOADOUT_INVALID_SLOT', `Instance ${id} has no equippable slot.`,
            { details: { instanceId: id } });
        }
        if (seenSlot.has(slot)) {
          throw new ApiError('LOADOUT_DUPLICATE_INSTANCE',
            `Instances ${seenSlot.get(slot)} and ${id} both target slot ${slot}.`,
            { details: { instanceId: id, slot, conflictsWith: seenSlot.get(slot) } });
        }
        seenSlot.set(slot, id);
      }
    }
    const conflicting = candidateIds
      .filter((id) => {
        const row = st.instances[id];
        return !row || row.location !== 'permanent' || row.status !== 'active' || row.locked;
      })
      .map((id) => ({ instanceId: id,
        reason: st.instances[id]?.locked ? 'ITEM_ALREADY_DEPLOYED' : 'LOADOUT_ITEM_NOT_OWNED' }));
    if (conflicting.length > 0) {
      throw new ApiError('DEPLOYMENT_RESERVATION_CONFLICT', 'One or more instances could not be locked.',
        { details: { conflictingInstances: conflicting } });
    }
    st.reservationsIssued += 1;
    const reservationId = stubUlid(`deployment:new:${ctx.scenario}:${st.reservationsIssued}`, ctx.clock.nowMs());
    for (const id of candidateIds) {
      st.instances[id].locked = true;
      st.instances[id].lockedByDeploymentId = reservationId;
    }
    const expiresAt = ctx.clock.plus(90 * 1000);   // §2.2's TTL
    st.reservations[reservationId] = { instanceIds: candidateIds, roomId, expiresAt, status: 'reserved' };
    return okBody({ reservationId, instanceIds: candidateIds, expiresAt });
  } },

  { method: 'DELETE', path: '/v1/deployments/:reservationId', auth: 'A', handler(ctx) {
    const st = itemsStateOf(ctx);
    const reservationId = ctx.params.reservationId;
    // The pre-seeded raid's reservation is already consumed (§5.4): aborting it now would
    // desync a match server that already spawned the entity.
    if (reservationId === fx.ACTIVE_DEPLOYMENT_ID) {
      throw new ApiError('DEPLOYMENT_ALREADY_CONSUMED', 'This deployment already started a run.');
    }
    const reservation = st.reservations[reservationId];
    if (!reservation) throw new ApiError('NOT_FOUND', 'No such reservation.');
    if (reservation.status === 'reserved') {
      reservation.status = 'released';
      for (const id of reservation.instanceIds) {
        const row = st.instances[id];
        if (row && row.lockedByDeploymentId === reservationId) {
          row.locked = false;
          row.lockedByDeploymentId = null;
        }
      }
    }
    return noContent();   // idempotent: already-released is success, same as rooms/:id/leave
  } },

  // Build-exempt exactly as core/http.js exempts them: a liveness probe is not a game client
  // and has no build to compare against a floor.
  { method: 'GET', path: '/v1/health', auth: 'P', requireBuild: false, handler: () => okBody({ ok: true }) },
  { method: 'GET', path: '/v1/health/ready', auth: 'S', requireBuild: false,
    handler: () => okBody({ ok: true, dependencies: { db: 'up', flags: 'up' } }) },

  // `POST /v1/matches/:matchId/result` is deliberately ABSENT. It is service-only and never
  // browser-reachable (§7); stubbing it would put a route in the shell's reach whose entire
  // security property is that the shell cannot reach it.
];

export { okBody, created, accepted, noContent, validationFailed, consentProjection, profileFor };
