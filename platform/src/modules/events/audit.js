/**
 * The audit log.  contracts/db-schema.md §5, contracts/auth.md §10.
 *
 * Every privileged mutation, with actor, role, reason code, before/after summary, and the
 * correlation id. `reason_code` is NOT NULL in the schema and required here: an unexplained
 * privileged action is a defect, and "the admin did it" is not an explanation anyone can act
 * on six months later during an appeal.
 *
 * Append-only. This module exposes `record` and `list` and nothing else — there is no update
 * and no delete to call, matching the database grant. An audit table the app can rewrite
 * proves nothing.
 */
import { ulid } from '../../core/ids.js';
import { EventContractError } from './envelope.js';
import { ACTOR_KINDS } from './catalogue.js';
import { ROLES, isSharedIdentity, ELEVATED_ROLES, requireCapability } from './rbac.js';

/**
 * Reason codes. A closed set, because free text drifts into "cleanup" and "per ticket" and
 * then no query can group by why. Extending it is a one-line change plus a review.
 */
export const REASON_CODES = new Set([
  'policy_violation',        // sanction applied against published rules
  'appeal_upheld',           // sanction lifted after appeal
  'appeal_rejected',
  'sanction_expired',
  'support_request',         // acting at the account holder's request
  'account_recovery',
  'security_incident',       // compromised credentials, token reuse, abuse response
  'fraud_review',
  'legal_request',
  'data_subject_request',    // export or deletion
  'match_integrity',         // invalidation, cheat review
  'operational_maintenance', // migration, backfill, flag change during an incident
  'config_rollout',
  'kill_switch',
  'account_self_service',    // the account holder acting on their own account: signup, signin,
                             // signout, name change, consent, verification, terms
  'test_fixture',            // non-production only; present so tests never invent a real reason
]);

const MAX_SUMMARY_KEYS = 32;

/**
 * Which role may be recorded under which actor kind.
 *
 * The row previously defaulted `actorKind` to `'admin'` and never compared it to the role, so a
 * `player`-role actor was written into the trail as an admin. A trail whose two attribution
 * columns can disagree is a trail that cannot be queried for "what did the admins do".
 */
const KINDS_FOR_ROLE = {
  player: ['player'],
  service: ['service', 'system'],
  support: ['admin'],
  moderator: ['admin'],
  finance: ['admin'],
  developer: ['admin'],
  superadmin: ['admin'],
};

/**
 * The capability an action implies: `sanction.apply` → `sanction:apply`.
 *
 * Derived rather than passed, because a caller that supplies both the action and the
 * capability it is checked against is a caller that can name a capability it holds while
 * performing an action it does not. An entry may still pass `capability` explicitly, but only
 * to *narrow* — and `capability: null` is reserved for unprivileged self-service (see below).
 */
export function capabilityForAction(action) {
  const dot = String(action).lastIndexOf('.');
  if (dot <= 0) return null;
  return `${action.slice(0, dot)}:${action.slice(dot + 1)}`;
}

/**
 * Summarise a row for the trail.
 *
 * A summary, not a dump: the audit record explains what changed, and copying whole rows into
 * it turns an access-controlled log into a second copy of the personal data it describes.
 */
export function summarise(obj, keys) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj !== 'object') return { value: obj };
  const picked = {};
  const source = keys && keys.length ? keys : Object.keys(obj).slice(0, MAX_SUMMARY_KEYS);
  for (const k of source) {
    if (!(k in obj)) continue;
    const v = obj[k];
    picked[k] = (v && typeof v === 'object') ? '[object]' : v;
  }
  return picked;
}

export function createAuditLog({ store, clock = Date, logger = null }) {
  /**
   * Write one audit row.
   *
   * `tx` is optional but expected: a privileged mutation and its audit row belong in the same
   * transaction for the same reason its event does (event-envelope.md §4). Passing it enrols
   * the insert; omitting it records an action that may not have happened.
   */
  async function record(entry, tx = undefined) {
    const { actor, action, subject, target, reasonCode, before, after, correlationId, summaryKeys } = entry || {};

    if (!actor || typeof actor !== 'object') {
      throw new EventContractError('audit.record: actor is required');
    }
    if (typeof actor.id !== 'string' || !actor.id) {
      throw new EventContractError('audit.record: actor.id is required; an unattributed action is not auditable');
    }
    if (!ROLES.includes(actor.role)) {
      throw new EventContractError('audit.record: actor.role must be a contract role', { role: actor.role });
    }
    if (!ACTOR_KINDS.includes(actor.kind)) {
      // No default. `actorKind` used to fall back to `'admin'`, which meant every caller that
      // forgot the field produced a row asserting an administrator did the work.
      throw new EventContractError('audit.record: actor.kind must be one of ' + ACTOR_KINDS.join('|'),
        { kind: actor.kind });
    }
    if (!KINDS_FOR_ROLE[actor.role].includes(actor.kind)) {
      throw new EventContractError('audit.record: actor.kind and actor.role disagree',
        { kind: actor.kind, role: actor.role });
    }
    if (ELEVATED_ROLES.includes(actor.role) && isSharedIdentity(actor.id)) {
      // auth.md §10: no shared admin accounts. Refusing at write time is the only enforcement
      // point that survives someone adding a new admin path later.
      throw new EventContractError('audit.record: shared admin identity refused; the row would identify nobody',
        { actorId: actor.id });
    }
    if (typeof action !== 'string' || !action) {
      throw new EventContractError('audit.record: action is required');
    }
    if (!subject || typeof subject.kind !== 'string' || typeof subject.id !== 'string' || !subject.id) {
      throw new EventContractError('audit.record: subject.kind and subject.id are required', { action });
    }
    if (typeof reasonCode !== 'string' || !REASON_CODES.has(reasonCode)) {
      // NOT NULL in the schema, and a closed set here. This is the field that makes the trail
      // answerable rather than merely complete.
      throw new EventContractError('audit.record: reasonCode is required and must be a known code',
        { action, reasonCode });
    }
    if (typeof correlationId !== 'string' || !correlationId) {
      throw new EventContractError('audit.record: correlationId is required', { action });
    }
    if (ELEVATED_ROLES.includes(actor.role) && actor.mfa !== true) {
      // §10: elevated roles require a separate authentication factor. Enforcing it here as
      // well as in `check()` means a privileged row cannot be written by a path that skipped
      // the capability check entirely.
      throw new EventContractError('audit.record: an elevated role must have presented a second factor',
        { role: actor.role, action });
    }

    // The capability, asserted BEFORE the row is written. The trail previously accepted any
    // (actor, action) pair the caller cared to assemble, so it recorded actions the actor
    // could not have performed — which makes every row in it a claim rather than a fact.
    const capability = entry.capability !== undefined ? entry.capability : capabilityForAction(action);
    const scopeTarget = target ?? (subject.kind === 'account' ? { accountId: subject.id } : { id: subject.id });
    if (capability === null) {
      // The one opt-out, and it is deliberately unusable for anything privileged: an
      // unprivileged actor acting on itself. Signup and signin have no capability to check
      // because they have no authenticated actor yet, and a `player` acting on its own account
      // is exactly what the `self` scope already means.
      const selfId = scopeTarget.accountId ?? scopeTarget.id ?? null;
      const unprivileged = actor.role === 'player' || (actor.kind === 'system' && actor.role === 'service');
      if (!unprivileged || (actor.role === 'player' && selfId !== actor.id && selfId !== actor.accountId)) {
        throw new EventContractError(
          'audit.record: only an unprivileged self-service action may be recorded without a capability',
          { action, role: actor.role });
      }
    } else {
      requireCapability(actor, capability, scopeTarget);
    }

    const row = {
      auditId: ulid(clock.now()),
      actorKind: actor.kind,
      actorId: actor.id,
      actorRole: actor.role,
      action,
      subjectKind: subject.kind,
      subjectId: subject.id,
      reasonCode,
      beforeSummary: summarise(before ?? null, summaryKeys),
      afterSummary: summarise(after ?? null, summaryKeys),
      correlationId,
      createdAt: new Date(clock.now()).toISOString(),
    };

    await store.audit.insert(row, tx);
    if (logger) {
      logger.info('audit.recorded', {
        correlationId, auditId: row.auditId, action, actorRole: row.actorRole,
        actorId: row.actorId, subjectKind: row.subjectKind, subjectId: row.subjectId, reasonCode,
      });
    }
    return row;
  }

  /**
   * Record the audit row AND its platform event in one transaction.
   *
   * The two answer different questions — the audit log is the operator's trail, the event is
   * the consumer's fact — and a privileged action that produces one without the other leaves
   * either the warehouse or the investigation blind.
   */
  async function recordWithEvent(outbox, ctx, entry, spec, work = null) {
    return outbox.commit({
      correlationId: ctx.correlationId, actor: ctx.eventActor ?? ctx.actor, causationId: ctx.causationId,
    }, async (tx, emit) => {
      // `work` is the state change itself, run in the same transaction as its event and its
      // audit row. Without it a caller has to open a second transaction, and then the mutation
      // can commit while the row that explains it rolls back — the exact split §4 forbids for
      // events and §10 assumes cannot happen for the trail.
      const result = work ? await work(tx) : undefined;
      const event = await emit(typeof spec === 'function' ? spec(result) : spec);
      const row = await record({
        ...(typeof entry === 'function' ? entry(result) : entry),
        correlationId: ctx.correlationId, actor: ctx.actor,
      }, tx);
      return { row, event, result };
    });
  }

  const list = (filter = {}, tx = undefined) => store.audit.list(filter, tx);

  // No update, no delete, on purpose. See the header.
  return { record, recordWithEvent, list };
}
