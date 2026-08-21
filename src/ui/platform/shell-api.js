import { createUlid } from './ids.js';
import { PlatformClientError } from './errors.js';

const encode = encodeURIComponent;

function query(path, payload, keys) {
  const params = new URLSearchParams();
  for (const key of keys) {
    const value = payload?.[key];
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

const bodyWith = (source, keys) => Object.fromEntries(keys
  .filter((key) => source?.[key] !== undefined)
  .map((key) => [key, source[key]]));

function shellRoom(room) {
  if (!room || typeof room !== 'object') return room;
  return {
    ...room,
    id: room.roomId,
    map: room.mapId,
    occupancy: `${room.playerCount} / ${room.capacity}`,
  };
}

function shellMatch(match) {
  if (!match || typeof match !== 'object') return match;
  return { ...match, id: match.matchId };
}

function teamValue(value) {
  if (value === 'A') return 'alpha';
  if (value === 'B') return 'bravo';
  return value;
}

/**
 * Named operations consumed by the out-of-match shell. This is a shape adapter only: every
 * network call below maps to a frozen HTTP endpoint. Lobby chat remains a WebSocket concern
 * and is deliberately not fabricated as an HTTP operation.
 *
 * @param {{client: import('./client.js').PlatformClient,
 * telemetry?: import('./telemetry.js').TelemetryClient|null, settings?: object|null,
 * ulid?: () => string}} options
 */
export function createShellApi({ client, telemetry = null, settings = null, ulid = createUlid } = {}) {
  if (!client) throw new TypeError('createShellApi requires a PlatformClient.');
  let ownProfile = null;
  let settingsEtag = null;
  const data = async (path, options) => {
    const response = await client.request(path, options);
    const body = response.data;
    if (response.status !== 204
      && (!body || typeof body !== 'object' || Array.isArray(body))) {
      throw new PlatformClientError('CLIENT_PROTOCOL',
        'The platform returned an invalid success projection.', {
          correlationId: response.correlationId,
        });
    }
    return body;
  };
  const key = (operation) => `shell:${operation}:${ulid()}`;
  const protocol = (correlationId) => {
    throw new PlatformClientError('CLIENT_PROTOCOL',
      'The platform returned an invalid success projection.', { correlationId });
  };

  const rememberAuth = (result) => {
    ownProfile = result?.profile || ownProfile;
    const consent = result?.profile?.consent;
    if (telemetry && consent === null) telemetry.setConsent({ telemetryPersonal: null });
    else if (telemetry && consent && result.consentReceipt) {
      telemetry.setConsent({
        telemetryPersonal: consent.telemetryPersonal,
        receipt: result.consentReceipt,
      });
    }
    return result;
  };

  const settingsProjection = (body, etag) => ({
    ...body,
    bindings: body?.values?.keybinds || {},
    etag: etag || (Number.isInteger(body?.version) ? `"${body.version}"` : null),
  });

  const getOwnProfile = async () => {
    ownProfile = await data('/v1/profile/me');
    if (typeof ownProfile.accountId !== 'string') protocol(ownProfile.correlationId);
    return ownProfile;
  };

  const getOwnStats = async (mode = 'all') => {
    const profile = ownProfile || await getOwnProfile();
    return data(`/v1/profile/${encode(profile.accountId)}/stats?mode=${encode(mode)}`);
  };

  const operations = {
    getFlags() { return data('/v1/config/flags'); },

    async checkEligibility(payload = {}) {
      return data('/v1/onboarding/eligibility', {
        method: 'POST', auth: false,
        body: { dateOfBirth: payload.dateOfBirth ?? payload.birthdate, jurisdiction: payload.jurisdiction },
        maxAttempts: 1,
      });
    },

    async getConsent() {
      const signedOut = !client.sessionState?.authenticated;
      if (signedOut && !telemetry?.getClientSessionId?.()) {
        throw new TypeError('Signed-out consent requires a telemetry client session id.');
      }
      const path = signedOut
        ? `/v1/onboarding/consent?clientSessionId=${encode(telemetry?.getClientSessionId?.() || '')}`
        : '/v1/onboarding/consent';
      const result = await data(path, { auth: !signedOut });
      telemetry?.setConsent({
        telemetryPersonal: result.telemetryPersonal,
        receipt: result.receipt,
      });
      return result;
    },

    async setConsent(payload = {}) {
      const signedOut = !client.sessionState?.authenticated;
      if (signedOut && !telemetry?.getClientSessionId?.()) {
        throw new TypeError('Signed-out consent requires a telemetry client session id.');
      }
      const result = await data('/v1/onboarding/consent', {
        method: 'PUT', auth: !signedOut,
        body: {
          telemetryPersonal: payload.telemetryPersonal ?? payload.allowed,
          policyVersion: payload.policyVersion,
          clientSessionId: telemetry?.getClientSessionId?.(),
        },
      });
      telemetry?.setConsent({ telemetryPersonal: result.telemetryPersonal, receipt: result.receipt });
      return result;
    },

    checkDisplayName(payload = {}) {
      return data('/v1/auth/display-name/check', {
        method: 'POST', auth: false, body: { displayName: payload.displayName }, maxAttempts: 1,
      });
    },

    async signIn(payload = {}) {
      const result = (await client.signIn({
        email: payload.email ?? payload.identifier, password: payload.password,
      })).data;
      return rememberAuth(result);
    },

    async signUp(payload = {}) {
      const clientSessionId = payload.clientSessionId || telemetry?.getClientSessionId?.();
      if (!clientSessionId) throw new TypeError('Signup requires a clientSessionId.');
      const result = (await client.signUp({
        email: payload.email,
        password: payload.password,
        displayName: payload.displayName,
        eligibilityReceipt: payload.eligibilityReceipt,
        clientSessionId,
        consentReceipt: payload.consentReceipt,
      })).data;
      return rememberAuth(result);
    },

    startRecovery(payload = {}) {
      return data('/v1/auth/recovery/start', {
        method: 'POST', auth: false, body: { email: payload.email ?? payload.identifier }, maxAttempts: 1,
      });
    },

    completeRecovery(payload = {}) {
      return data('/v1/auth/recovery/complete', {
        method: 'POST', auth: false,
        body: { token: payload.token, newPassword: payload.newPassword }, maxAttempts: 1,
      });
    },

    completeVerification(payload = {}) {
      return data('/v1/onboarding/verify/complete', {
        method: 'POST', body: { token: payload.token }, maxAttempts: 1,
      });
    },

    resendVerification() {
      return data('/v1/onboarding/verify/resend', { method: 'POST', body: {}, maxAttempts: 1 });
    },

    getTerms() { return data('/v1/onboarding/terms', { auth: false }); },
    acceptTerms(payload = {}) {
      return data('/v1/onboarding/terms/accept', {
        method: 'POST', body: { version: payload.version }, maxAttempts: 1,
      });
    },

    async getProfile() {
      const profile = await getOwnProfile();
      try {
        const publicProjection = await data(`/v1/profile/${encode(profile.accountId)}`);
        return { ...profile, presence: publicProjection.presence ?? null };
      } catch {
        // Presence is a privacy-filtered routing hint, never identity authority. An unavailable
        // public projection must not turn a valid cookie refresh into an auth failure.
        return profile;
      }
    },
    updateProfile(payload = {}) {
      return data('/v1/profile/me', {
        method: 'PATCH', body: bodyWith(payload, ['displayName', 'privacy']),
        idempotencyKey: payload.idempotencyKey || key('profile'),
      });
    },

    async listRooms(payload = {}) {
      const headers = {};
      if (payload.regionRtt) headers['X-Region-Rtt'] = payload.regionRtt;
      const result = await data(query('/v1/rooms', payload,
        ['region', 'mode', 'hasSpace', 'limit', 'cursor']), { headers });
      if (!Array.isArray(result.items)) protocol(result.correlationId);
      const fetchedAt = new Date().toISOString();
      const response = { ...result, fetchedAt, items: result.items.map(shellRoom), rooms: result.items.map(shellRoom) };
      // Presence and room cursors are independent opaque namespaces. Load the initial
      // privacy-filtered presence projection once; room pagination must never replay its cursor
      // into the presence endpoint or overwrite a previously valid presence list.
      if (!payload.cursor) {
        response.online = [];
        response.presenceUnavailable = false;
        try {
          const presence = await data(query('/v1/presence/online', payload, ['limit']));
          if (!Array.isArray(presence.items)) protocol(presence.correlationId);
          response.online = presence.items;
        } catch {
          response.presenceUnavailable = true;
        }
      }
      return response;
    },

    getOnlinePresence(payload = {}) {
      return data(query('/v1/presence/online', payload, ['limit', 'cursor']));
    },

    createRoom(payload = {}) {
      return data('/v1/rooms', {
        method: 'POST',
        body: bodyWith(payload, ['name', 'region', 'mapId', 'mode', 'capacity', 'password', 'settings']),
        idempotencyKey: payload.idempotencyKey || key('create-room'),
        maxAttempts: 1,
      });
    },

    async getRoom(payload = {}) {
      return shellRoom(await data(`/v1/rooms/${encode(payload.roomId)}`));
    },

    async getLobbySnapshot(payload = {}) {
      const result = await data(`/v1/rooms/${encode(payload.roomId)}`);
      return {
        room: shellRoom(result), members: result.roster, roster: result.roster,
        countdown: result.countdown,
        selfReady: result.roster?.find((member) => member.isLocal)?.ready ?? false,
        correlationId: result.correlationId,
      };
    },

    async joinRoom(payload = {}) {
      const result = await data(`/v1/rooms/${encode(payload.roomId)}/join`, {
        method: 'POST',
        body: { password: payload.password ?? null, preferredTeam: teamValue(payload.preferredTeam) || 'auto' },
        idempotencyKey: payload.idempotencyKey || key('join-room'),
        signal: payload.signal,
      });
      // The frozen response is a reservation and does not repeat the path id. The shell needs
      // it for navigation, so retain the already-known request value without claiming a new
      // backend response field.
      return { ...result, roomId: payload.roomId };
    },

    leaveRoom(payload = {}) {
      return data(`/v1/rooms/${encode(payload.roomId)}/leave`, {
        method: 'POST', body: {}, idempotent: true,
      });
    },

    setTeam(payload = {}) {
      return data(`/v1/rooms/${encode(payload.roomId)}/team`, {
        method: 'POST', body: { team: teamValue(payload.team) }, maxAttempts: 1,
      });
    },

    setReady(payload = {}) {
      return data(`/v1/rooms/${encode(payload.roomId)}/ready`, {
        method: 'POST', body: { ready: payload.ready }, maxAttempts: 1,
      });
    },

    setLoadout(payload = {}) {
      return data(`/v1/rooms/${encode(payload.roomId)}/loadout`, {
        method: 'POST', body: { primaryIdx: payload.primaryIdx, secondaryIdx: payload.secondaryIdx },
        maxAttempts: 1,
      });
    },

    launchRoom(payload = {}) {
      return data(`/v1/rooms/${encode(payload.roomId)}/launch`, {
        method: 'POST', body: {}, maxAttempts: 1,
      });
    },

    reconnectRoom(payload = {}) {
      return data(`/v1/rooms/${encode(payload.roomId)}/reconnect-ticket`, {
        method: 'POST', body: {}, maxAttempts: 1,
      });
    },

    async getCareerOverview() {
      const result = await getOwnStats('all');
      if (!result.modes || typeof result.modes !== 'object' || Array.isArray(result.modes)) {
        protocol(result.correlationId);
      }
      // The frozen contract forbids summing modes. Expose them; combined cards stay unavailable.
      return { modes: result.modes, matchesPlayed: null, wins: null, winRate: null,
        correlationId: result.correlationId };
    },

    async getCareerModes() {
      const result = await getOwnStats('all');
      if (!result.modes || typeof result.modes !== 'object' || Array.isArray(result.modes)) {
        protocol(result.correlationId);
      }
      return {
        modes: Object.entries(result.modes).map(([id, stats]) => ({
          id, name: id === 'tdm' ? 'Team deathmatch' : id === 'bomb' ? 'Bomb' : id,
          ...stats.totals,
          winRate: stats.totals.matches ? stats.totals.wins / stats.totals.matches : null,
        })),
        correlationId: result.correlationId,
      };
    },

    async getCareerWeapons() {
      const result = await getOwnStats('all');
      if (!result.modes || typeof result.modes !== 'object' || Array.isArray(result.modes)) {
        protocol(result.correlationId);
      }
      const weapons = [];
      for (const [mode, stats] of Object.entries(result.modes)) {
        for (const [id, counters] of Object.entries(stats.weapons)) {
          weapons.push({
            id: `${mode}:${id}`,
            name: id,
            mode,
            ...counters,
            eliminations: counters.kills,
            accuracy: counters.shots > 0 ? counters.hits / counters.shots : null,
          });
        }
      }
      return { weapons, correlationId: result.correlationId };
    },

    async listMatches(payload = {}) {
      const profile = ownProfile || await getOwnProfile();
      const result = await data(query(`/v1/profile/${encode(profile.accountId)}/matches`, payload,
        ['limit', 'cursor']));
      if (!Array.isArray(result.items)) protocol(result.correlationId);
      return { ...result, items: result.items.map(shellMatch), matches: result.items.map(shellMatch) };
    },

    async getMatch(payload = {}) {
      return shellMatch(await data(`/v1/matches/${encode(payload.matchId)}`));
    },

    async getResult(payload = {}) {
      const result = shellMatch(await data(`/v1/matches/${encode(payload.matchId)}`));
      return { result, correlationId: result.correlationId };
    },

    getActiveMatch() { return data('/v1/matches/active'); },
    async reconnectMatch(payload = {}) {
      const active = payload.matchId ? { matchId: payload.matchId } : await data('/v1/matches/active');
      if (!active?.matchId) return active;
      return data(`/v1/matches/${encode(active.matchId)}/reconnect-ticket`, {
        method: 'POST', body: {}, maxAttempts: 1,
      });
    },

    async listSessions() {
      const result = await data('/v1/auth/sessions');
      if (!Array.isArray(result.sessions)) protocol(result.correlationId);
      return {
        ...result,
        sessions: result.sessions.map((session) => ({
          ...session, id: session.sessionId, device: session.deviceLabel, current: session.isCurrent,
        })),
      };
    },

    async revokeSession(payload = {}) {
      const result = await data(`/v1/auth/sessions/${encode(payload.sessionId)}`, { method: 'DELETE' });
      client.session?.announceRevocation?.(payload.sessionId, 'revoked-by-user');
      return result;
    },

    async signOutAll() {
      const result = await client.signOut({ all: true });
      telemetry?.setConsent({ telemetryPersonal: null });
      return result;
    },

    async signOut() {
      const result = await client.signOut({ all: false });
      telemetry?.setConsent({ telemetryPersonal: null });
      return result;
    },

    async getSettings() {
      const response = await client.request('/v1/profile/me/settings');
      if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)
        || !Number.isInteger(response.data.schemaVersion)
        || !Number.isInteger(response.data.version)
        || !response.data.values || typeof response.data.values !== 'object'
        || Array.isArray(response.data.values)) protocol(response.correlationId);
      settingsEtag = response.headers.get('ETag');
      const projection = settingsProjection(response.data, settingsEtag);
      settings?.hydrate?.(response.data);
      return projection;
    },

    async saveSettings(payload = {}) {
      const etag = payload.etag
        || (Number.isInteger(payload.version) ? `"${payload.version}"` : null)
        || settingsEtag;
      try {
        const response = await client.request('/v1/profile/me/settings', {
          method: 'PUT',
          headers: etag ? { 'If-Match': etag } : {},
          body: { schemaVersion: payload.schemaVersion ?? 1, values: payload.values },
        });
        settingsEtag = response.headers.get('ETag');
        return settingsProjection(response.data, settingsEtag);
      } catch (error) {
        if (error?.code === 'CONFLICT' && Number.isInteger(error.details?.currentVersion)
          && error.details?.values) {
          settingsEtag = `"${error.details.currentVersion}"`;
          return {
            conflict: true,
            current: settingsProjection({
              schemaVersion: payload.schemaVersion ?? 1,
              version: error.details.currentVersion,
              values: error.details.values,
              updatedAt: null,
              correlationId: error.correlationId,
            }, `"${error.details.currentVersion}"`),
          };
        }
        throw error;
      }
    },
  };

  return Object.freeze({
    ...operations,
    perform(operation, payload) {
      const fn = operations[operation];
      if (typeof fn !== 'function') throw new TypeError(`Unknown shell operation: ${operation}`);
      return fn(payload);
    },
  });
}
