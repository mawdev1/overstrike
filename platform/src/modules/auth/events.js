/**
 * Platform events emitted by auth.  contracts/event-envelope.md §2, §4, §6.
 *
 * Always through the outbox, always inside the caller's transaction. Publishing from
 * application code after the commit is the crash window that produces state no event
 * explains, and nothing afterwards knows the event is missing.
 */
import { ulid } from '../../core/ids.js';

/** Privacy and retention classes are fixed per type by §6. They are not a call-site choice. */
const CATALOGUE = {
  'account.created':       { privacyClass: 'personal', retentionClass: 'audit' },
  'account.name_changed':  { privacyClass: 'personal', retentionClass: 'audit' },
  'session.started':       { privacyClass: 'personal', retentionClass: 'standard' },
  'session.revoked':       { privacyClass: 'personal', retentionClass: 'audit' },
  'session.reuse_detected': { privacyClass: 'personal', retentionClass: 'audit' },
};

export function makeEvent(type, { actor, subject, payload = {}, correlationId = null, causationId = null, occurredAt }) {
  const spec = CATALOGUE[type];
  if (!spec) throw new Error(`auth: event type not in the catalogue: ${type}`);
  const at = new Date(occurredAt).toISOString();
  return {
    eventId: ulid(),
    type,
    version: 1,
    occurredAt: at,
    recordedAt: at,
    correlationId,
    causationId,
    actor,
    subject,
    payload,
    privacyClass: spec.privacyClass,
    retentionClass: spec.retentionClass,
    schemaRef: `events/${type}/v1`,
  };
}

export const emit = (store, event, tx) => store.outbox.insert(event, tx);
