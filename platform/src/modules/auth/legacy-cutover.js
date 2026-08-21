/**
 * One-time local-KDF -> Supabase identity cutover.
 *
 * This deliberately is not a schema migration: database migrations must be deterministic and
 * cannot make a remote identity-provider call. The operator runs the accompanying admin script
 * during a maintenance window after migration 0021 and before enabling the Supabase-only
 * production process.
 */
import { randomBytes } from 'node:crypto';

const normalEmail = (value) => String(value || '').trim().toLowerCase();

/** PostgreSQL adapter used by the operator CLI; exported so the exact SQL is integration-tested. */
export function createLegacyCutoverDb(pool) {
  return {
    async listUnready() {
      const { rows } = await pool.query(`select account_id as "accountId", email,
          password_hash as "passwordHash", identity_provider as "identityProvider",
          identity_subject as "identitySubject"
        from accounts
        where deleted_at is null and status <> 'deleted' and (
          identity_provider is distinct from 'supabase'
          or identity_subject is null
          or password_hash is not null
        )
        order by account_id`);
      return rows;
    },
    async state(accountId) {
      const { rows } = await pool.query(`select account_id as "accountId",
          password_hash as "passwordHash", identity_provider as "identityProvider",
          identity_subject as "identitySubject"
        from accounts where account_id=$1`, [accountId]);
      return rows[0] ?? null;
    },
    async attach({ accountId, expectedPasswordHash, subject }) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rowCount } = await client.query(`update accounts
          set identity_provider='supabase', identity_subject=$3, password_hash=null
          where account_id=$1 and password_hash=$2
            and identity_provider is null and identity_subject is null`,
        [accountId, expectedPasswordHash, subject]);
        if (rowCount) {
          // The random provider password is deliberately unknowable. Existing sessions must not
          // bypass the required recovery step after the cutover.
          await client.query(`update sessions set revoked_at=coalesce(revoked_at, now()),
            revoked_reason=coalesce(revoked_reason, 'identity-provider-cutover')
            where account_id=$1 and revoked_at is null`, [accountId]);
        }
        await client.query('commit');
        return rowCount === 1;
      } catch (error) {
        try { await client.query('rollback'); } catch { /* preserve the real failure */ }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export function createSupabaseLegacyAdmin({ baseUrl, serviceRoleKey, fetchImpl = fetch,
  passwordFactory = () => randomBytes(48).toString('base64url') }) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base || !serviceRoleKey) throw new Error('legacy identity cutover: Supabase credentials are required');
  const headers = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    'content-type': 'application/json',
  };
  const request = async (path, init = {}) => {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        ...init, headers: { ...headers, ...init.headers },
      });
    } catch {
      throw new Error('legacy identity cutover: Supabase is unavailable');
    }
    let body = null;
    try { body = await response.json(); } catch { /* no provider response is logged */ }
    return { response, body };
  };

  async function findByEmail(email) {
    const wanted = normalEmail(email);
    for (let page = 1; page <= 50; page++) {
      const { response, body } = await request(`/auth/v1/admin/users?page=${page}&per_page=200`);
      if (!response.ok || !Array.isArray(body?.users)) {
        throw new Error('legacy identity cutover: Supabase user lookup failed');
      }
      const matches = body.users.filter((user) => normalEmail(user?.email) === wanted);
      if (matches.length > 1) throw new Error('legacy identity cutover: provider email is not unique');
      if (matches.length === 1) return matches[0];
      const lastPage = Number(body.last_page ?? 0);
      if ((lastPage && page >= lastPage) || (!lastPage && body.users.length < 200)) return null;
    }
    throw new Error('legacy identity cutover: Supabase user lookup exceeded its page limit');
  }

  const assertOwned = (user, accountId) => {
    if (user?.app_metadata?.overstrike_account_id !== accountId) {
      // Never adopt a provider identity merely because its email happens to match. That would
      // bind an Overstrike account to identity state created by somebody else.
      throw new Error('legacy identity cutover: matching provider user is not bound to this account');
    }
    if (typeof user.id !== 'string' || !user.id) {
      throw new Error('legacy identity cutover: provider returned an invalid user subject');
    }
    return user.id;
  };

  return {
    async provision({ accountId, email }) {
      const existing = await findByEmail(email);
      if (existing) return { subject: assertOwned(existing, accountId), created: false };

      // Nobody knows this password and it is never returned or logged. The migrated player
      // must use Overstrike's recovery flow, which replaces it through the provider seam.
      const { response, body } = await request('/auth/v1/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email,
          password: passwordFactory(),
          email_confirm: true,
          app_metadata: {
            overstrike_account_id: accountId,
            overstrike_migration: 'legacy-scrypt-cutover-v1',
            password_reset_required: true,
          },
        }),
      });
      if (!response.ok) {
        // A process may have died after creating the provider user but before recording its
        // subject. Re-query makes the operation resumable without ever adopting a foreign user.
        const raced = await findByEmail(email);
        if (raced) return { subject: assertOwned(raced, accountId), created: false };
        throw new Error('legacy identity cutover: Supabase user creation failed');
      }
      return { subject: assertOwned(body, accountId), created: true };
    },

    async remove(subject) {
      const { response } = await request(`/auth/v1/admin/users/${encodeURIComponent(subject)}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('legacy identity cutover: provider compensation failed');
    },
  };
}

function classify(row) {
  const legacy = row?.identityProvider == null && row?.identitySubject == null
    && typeof row?.passwordHash === 'string' && row.passwordHash !== '';
  if (!legacy) return 'invalid';
  if (typeof row.email !== 'string' || !row.email.trim()) return 'missing-email';
  return 'candidate';
}

/**
 * `db` is intentionally tiny so the state machine can be tested without a live production DB:
 *   listUnready(), attach({ accountId, expectedPasswordHash, subject }), state(accountId)
 */
export async function cutoverLegacyIdentities({ db, provider = null, apply = false }) {
  const rows = await db.listUnready();
  const candidates = [];
  const blockers = [];
  for (const row of rows) {
    const kind = classify(row);
    if (kind === 'candidate') candidates.push(row);
    else blockers.push({ accountId: row?.accountId ?? null, reason: kind });
  }
  const base = {
    mode: apply ? 'apply' : 'dry-run',
    candidateCount: candidates.length,
    blockingCount: blockers.length,
    migratedCount: 0,
    resumedCount: 0,
    blockers,
  };
  if (!apply) return base;
  if (!provider) throw new Error('legacy identity cutover: provider is required in apply mode');
  if (blockers.length) {
    throw new Error(`legacy identity cutover: ${blockers.length} unready account(s) cannot be migrated`);
  }

  for (const row of candidates) {
    const provisioned = await provider.provision({ accountId: row.accountId, email: row.email });
    let attached = false;
    try {
      attached = await db.attach({
        accountId: row.accountId,
        expectedPasswordHash: row.passwordHash,
        subject: provisioned.subject,
      });
      if (!attached) {
        const current = await db.state(row.accountId);
        const alreadyDone = current?.identityProvider === 'supabase'
          && current?.identitySubject === provisioned.subject && current?.passwordHash == null;
        if (!alreadyDone) throw new Error('legacy identity cutover: account changed during cutover');
        base.resumedCount += 1;
      } else {
        base.migratedCount += 1;
      }
    } catch (error) {
      // Only delete a user this process created, and never delete it if the database did in
      // fact attach it. An adopted user can be the residue of an earlier interrupted run.
      if (provisioned.created) {
        const current = await db.state(row.accountId).catch(() => null);
        const ownsCurrent = current?.identityProvider === 'supabase'
          && current?.identitySubject === provisioned.subject && current?.passwordHash == null;
        if (!ownsCurrent) {
          try { await provider.remove(provisioned.subject); }
          catch (compensationError) {
            throw new AggregateError([error, compensationError],
              'legacy identity cutover failed and provider compensation also failed');
          }
        }
      }
      throw error;
    }
  }
  return base;
}
