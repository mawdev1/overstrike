/** Identity-provider seam. Production is Supabase; the local KDF exists only for dev/test. */
import { ApiError } from '../../core/errors.js';
import { hashPassword, verifyPassword } from './crypto.js';

export function createLocalIdentityProvider({ hashImpl = hashPassword, verifyImpl = verifyPassword } = {}) {
  // A missing account must pay the same KDF work as an existing one. Keep the dummy record
  // inside the provider so callers cannot accidentally re-open the enumeration oracle by
  // passing null straight to verifyPassword (which correctly fails fast on malformed data).
  const dummyPasswordHash = hashImpl('local-provider-dummy-password-never-used');
  return {
    kind: 'local-test',
    async create({ password }) {
      return { passwordHash: hashImpl(password), identityProvider: null, identitySubject: null };
    },
    async verify({ password, reference }) {
      return verifyImpl(password, reference || dummyPasswordHash);
    },
    async replace({ password }) {
      return { passwordHash: hashImpl(password), identityProvider: null, identitySubject: null };
    },
    async remove() {},
    async health() { return { ok: true, detail: 'local-test' }; },
  };
}

const subjectFrom = ({ subject, reference }) => subject
  || (typeof reference === 'string' && reference.startsWith('supabase:') ? reference.slice(9) : null);

export function createSupabaseIdentityProvider({ config, fetchImpl = fetch }) {
  const base = String(config.supabaseAuthUrl || '').replace(/\/$/, '');
  const key = config.supabaseServiceRoleKey;
  if (!base || !key) throw new Error('auth: Supabase URL and service-role key are required');
  const headers = { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' };
  const request = async (path, init) => {
    let res;
    try { res = await fetchImpl(`${base}${path}`, { ...init, headers: { ...headers, ...init?.headers } }); }
    catch (cause) { throw new ApiError('SERVICE_UNAVAILABLE', 'Identity service is unavailable.', { cause }); }
    let body = null;
    try { body = await res.json(); } catch { /* error mapping stays generic */ }
    return { res, body };
  };
  return {
    kind: 'supabase',
    async create({ email, password, accountId }) {
      const { res, body } = await request('/auth/v1/admin/users', {
        // The platform, not Supabase, owns the verification/setup gate. The provider identity
        // must therefore be usable while Overstrike still reports verification incomplete.
        method: 'POST', body: JSON.stringify({ email, password, email_confirm: true,
          app_metadata: { overstrike_account_id: accountId } }),
      });
      if (!res.ok || typeof body?.id !== 'string') {
        if (res.status >= 500) throw new ApiError('SERVICE_UNAVAILABLE', 'Identity service is unavailable.');
        throw new ApiError('AUTH_INVALID_CREDENTIALS', 'We could not complete that sign-up.');
      }
      return { passwordHash: null, identityProvider: 'supabase', identitySubject: body.id };
    },
    async verify({ email, password, subject, reference }) {
      const id = subjectFrom({ subject, reference });
      const { res, body } = await request('/auth/v1/token?grant_type=password', {
        method: 'POST', body: JSON.stringify({ email, password }),
      });
      if (res.status >= 500) {
        throw new ApiError('SERVICE_UNAVAILABLE', 'Identity service is unavailable.');
      }
      return res.ok && body?.user?.id === id;
    },
    async replace({ password, subject, reference }) {
      const id = subjectFrom({ subject, reference });
      if (!id) throw new ApiError('AUTH_RECOVERY_TOKEN_INVALID', 'That reset link is no longer valid. Start again.');
      const { res } = await request(`/auth/v1/admin/users/${encodeURIComponent(id)}`, {
        method: 'PUT', body: JSON.stringify({ password }),
      });
      if (!res.ok) throw new ApiError('SERVICE_UNAVAILABLE', 'Identity service is unavailable.');
      return { passwordHash: null, identityProvider: 'supabase', identitySubject: id };
    },
    async remove({ subject, reference }) {
      const id = subjectFrom({ subject, reference });
      if (!id) return;
      const { res } = await request(`/auth/v1/admin/users/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      // DELETE is idempotent: an earlier compensation may already have succeeded even if its
      // response was lost. Every other refusal is observable so signup cannot report a clean
      // rollback while leaving an orphan that makes the next provider create fail.
      if (res.ok || res.status === 404) return;
      throw new ApiError('SERVICE_UNAVAILABLE', 'Identity service compensation failed.');
    },
    async health({ accountById } = {}) {
      if (typeof accountById !== 'function') return { ok: false, detail: 'account lookup unavailable' };
      const users = [];
      const pageSize = 1000;
      for (let page = 1; page <= 1000; page++) {
        const { res, body } = await request(`/auth/v1/admin/users?page=${page}&per_page=${pageSize}`, {
          method: 'GET',
        });
        if (!res.ok || !Array.isArray(body?.users)) {
          return { ok: false, detail: 'provider audit unavailable' };
        }
        users.push(...body.users);
        if (body.users.length < pageSize) break;
        // Refuse a silently partial readiness verdict if a pathological provider response
        // fills every bounded page. "Healthy" must mean every provider identity was audited.
        if (page === 1000) return { ok: false, detail: 'provider audit incomplete' };
      }
      let orphanCount = 0;
      let mismatchCount = 0;
      for (const user of users) {
        const accountId = user?.app_metadata?.overstrike_account_id;
        if (typeof accountId !== 'string' || !accountId) continue;
        const account = await accountById(accountId);
        if (!account || account.deletedAt) orphanCount++;
        else if (account.identityProvider !== 'supabase' || account.identitySubject !== user.id) {
          mismatchCount++;
        }
      }
      return { ok: orphanCount === 0 && mismatchCount === 0,
        detail: orphanCount || mismatchCount ? 'provider identity reconciliation required' : 'reconciled',
        orphanCount, mismatchCount };
    },
  };
}

export function createIdentityProvider({ config, fetchImpl } = {}) {
  if (config?.identityProvider === 'supabase') return createSupabaseIdentityProvider({ config, fetchImpl });
  if (config?.env === 'production') throw new Error('auth: the local identity provider is forbidden in production');
  return createLocalIdentityProvider();
}
