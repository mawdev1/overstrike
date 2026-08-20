/**
 * Roles and capabilities.  contracts/auth.md §10.
 *
 * "A role grants specific scopes, never 'everything below it'." So there is no hierarchy here
 * and no inheritance: each role enumerates its own capabilities in full. That is more lines
 * and it is the point — a hierarchy means adding a capability to `support` silently hands it
 * to `superadmin`, and nobody notices until the audit asks who could have done it.
 *
 * `superadmin` is likewise enumerated rather than wildcarded. A wildcard role cannot be
 * reviewed, because the answer to "what can it do?" is "whatever exists next quarter".
 */
import { ApiError } from '../../core/errors.js';

export const ROLES = [
  'player', 'support', 'moderator', 'finance', 'developer', 'superadmin', 'service',
];

/** Roles that require the §10 second factor and may never be a shared login. */
export const ELEVATED_ROLES = ['support', 'moderator', 'finance', 'developer', 'superadmin'];

/**
 * Scope rules:
 *   'self' — only where the target is the actor's own account/session
 *   'all'  — any target
 * Absent — the role does not have the capability at all. There is no 'deny' entry, because a
 * capability that has to be explicitly denied is a capability someone already granted broadly.
 */
const GRANTS = {
  player: {
    'account:read': 'self',
    'account:update': 'self',
    'account:delete': 'self',
    'session:list': 'self',
    'session:revoke': 'self',
    'profile:update': 'self',
    'room:create': 'all',
    'room:join': 'all',
    'report:submit': 'all',
    'telemetry:ingest': 'all',
  },
  support: {
    // Reads accounts and unsticks sessions. Cannot sanction, cannot touch money, cannot
    // change a display name — those are moderator and finance decisions with their own trail.
    'account:read': 'all',
    'session:list': 'all',
    'session:revoke': 'all',
    'report:read': 'all',
    'audit:read': 'all',
    'match:read': 'all',
  },
  moderator: {
    'account:read': 'all',
    'account:name_change': 'all',
    'report:read': 'all',
    'report:resolve': 'all',
    'sanction:apply': 'all',
    'sanction:lift': 'all',
    'match:read': 'all',
    'match:invalidate': 'all',
    'evidence:read': 'all',
    'audit:read': 'all',
  },
  finance: {
    'finance:read': 'all',
    'payout:approve': 'all',
    'refund:issue': 'all',
    'audit:read': 'all',
    // Deliberately no account:read — a payout is approved against a finance record, not by
    // browsing player profiles.
  },
  developer: {
    'flag:read': 'all',
    'flag:toggle': 'all',
    'config:read': 'all',
    'config:change': 'all',
    'telemetry:read': 'all',
    'audit:read': 'all',
    'match:read': 'all',
  },
  superadmin: {
    'account:read': 'all',
    'account:delete': 'all',
    'session:list': 'all',
    'session:revoke': 'all',
    'report:read': 'all',
    'report:resolve': 'all',
    'sanction:apply': 'all',
    'sanction:lift': 'all',
    'flag:read': 'all',
    'flag:toggle': 'all',
    'config:read': 'all',
    'config:change': 'all',
    'role:grant': 'all',
    'audit:read': 'all',
    'match:read': 'all',
    'match:invalidate': 'all',
    'evidence:read': 'all',
  },
  service: {
    // Per-service, mTLS-bound (§10). A service token cannot read an account or sanction anyone;
    // it does the one job its service exists for.
    'match:allocate': 'all',
    'match:report': 'all',
    'match:read': 'all',
    'event:publish': 'all',
    'telemetry:ingest': 'all',
  },
};

/**
 * Identities that are obviously shared. §10: "an audit row naming a shared login identifies
 * nobody." Checked here rather than at account creation because the check has to hold for
 * tokens minted by any path, including a future one nobody has written yet.
 */
const SHARED_IDENTIFIERS = new Set([
  'admin', 'administrator', 'root', 'ops', 'support', 'shared', 'team', 'service',
  'admin@', 'ops@', 'support@',
]);

export function isSharedIdentity(actorId) {
  if (typeof actorId !== 'string' || actorId.length === 0) return true;
  const folded = actorId.trim().toLowerCase();
  if (SHARED_IDENTIFIERS.has(folded)) return true;
  return [...SHARED_IDENTIFIERS].some((s) => s.endsWith('@') && folded.startsWith(s));
}

/**
 * Can `actor` do `capability` to `target`?
 *
 * Returns a reason on refusal instead of a bare false, so the audit and the log can say which
 * rule refused rather than "forbidden".
 */
export function check(actor, capability, target = {}) {
  if (!actor || typeof actor !== 'object') return { allowed: false, reason: 'no_actor' };
  const role = actor.role;
  if (!ROLES.includes(role)) return { allowed: false, reason: 'unknown_role' };
  if (typeof actor.id !== 'string' || !actor.id) return { allowed: false, reason: 'unattributed_actor' };

  if (ELEVATED_ROLES.includes(role)) {
    if (isSharedIdentity(actor.id)) return { allowed: false, reason: 'shared_identity' };
    // §10: elevated roles require a separate authentication factor. An actor that has not
    // presented one is a normal session, whatever its role column says.
    if (actor.mfa !== true) return { allowed: false, reason: 'mfa_required' };
  }
  if (role === 'service' && actor.serviceName === undefined) {
    return { allowed: false, reason: 'unnamed_service' };
  }

  const scope = GRANTS[role][capability];
  if (!scope) return { allowed: false, reason: 'capability_not_granted' };
  if (scope === 'all') return { allowed: true, scope };

  // 'self': the target must BE the actor. An absent target is refused rather than assumed to
  // mean "me" — a handler that forgot to pass one must not accidentally pass the check.
  const targetId = target.accountId ?? target.id ?? null;
  if (targetId === null) return { allowed: false, reason: 'self_scope_needs_target' };
  if (targetId !== actor.accountId && targetId !== actor.id) {
    return { allowed: false, reason: 'out_of_scope' };
  }
  return { allowed: true, scope };
}

export const can = (actor, capability, target) => check(actor, capability, target).allowed;

/** Throwing form for handlers. AUTH_FORBIDDEN, with the refusing rule in `details`. */
export function requireCapability(actor, capability, target = {}) {
  const verdict = check(actor, capability, target);
  if (!verdict.allowed) {
    throw new ApiError('AUTH_FORBIDDEN', 'You do not have permission to do that.',
      { details: { capability, reason: verdict.reason } });
  }
  return verdict;
}

/** Every capability a role holds. For the admin UI and for the RBAC test's coverage assertions. */
export const capabilitiesOf = (role) => Object.keys(GRANTS[role] || {});
