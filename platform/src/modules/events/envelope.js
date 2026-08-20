/**
 * The canonical envelope.  contracts/event-envelope.md §2.
 *
 * One builder, one validator. Every platform event in the system is constructed here, so the
 * shape cannot drift per domain — which is the entire reason §1 pays for this in P0 rather
 * than reconciling eight formats in P4.
 */
import { ulid, isUlid } from '../../core/ids.js';
import {
  ACTOR_KINDS, SUBJECT_KINDS, PRIVACY_CLASSES, RETENTION_CLASSES,
  lookup, isWellNamed, schemaRefFor,
} from './catalogue.js';

/**
 * A defect, not a request failure.
 *
 * Deliberately NOT an ApiError: an unregistered event type or a blank actor is a bug in the
 * emitting code that a deploy fixes. Dressing it as a 400 would let it reach production
 * disguised as someone else's bad input.
 */
export class EventContractError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'EventContractError';
    this.details = details;
  }
}

const bad = (message, details) => { throw new EventContractError(message, details); };

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isIsoInstant = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v))
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v);

/**
 * Build a validated envelope.
 *
 * `privacyClass` and `retentionClass` are taken from the catalogue and are refused if the
 * caller supplies a different value — a per-call-site override is how a `sensitive` event
 * becomes `internal` on the one path that found the classification inconvenient.
 */
export function buildEvent(spec, { clock = Date, defaults = {} } = {}) {
  if (!isPlainObject(spec)) bad('buildEvent: spec must be an object');

  const type = spec.type;
  if (!isWellNamed(type)) {
    bad('buildEvent: event type is not <domain>.<entity>.<past-tense-verb>', { type });
  }
  const entry = lookup(type);
  // §6 + §8: consumers may ignore an unknown type, but a PRODUCER may never invent one. The
  // catalogue is the review gate; emitting around it is how the warehouse gets two spellings.
  if (!entry) bad('buildEvent: event type is not in the catalogue', { type });

  const version = spec.version === undefined ? entry.versions[entry.versions.length - 1] : spec.version;
  if (!entry.versions.includes(version)) {
    bad('buildEvent: unsupported version for type', { type, version, supported: entry.versions });
  }

  const actor = spec.actor;
  if (!isPlainObject(actor) || !ACTOR_KINDS.includes(actor.kind)) {
    bad('buildEvent: actor.kind must be one of ' + ACTOR_KINDS.join('|'), { type, actor });
  }
  if (!entry.actors.includes(actor.kind)) {
    bad('buildEvent: actor kind not permitted for this type', { type, kind: actor.kind, allowed: entry.actors });
  }
  // §2: "Never blank — 'it just happened' is not attribution." `system` still names its job.
  if (typeof actor.id !== 'string' || actor.id.length === 0) {
    bad('buildEvent: actor.id is required; an unattributed event is not auditable', { type });
  }

  const subject = spec.subject;
  if (!isPlainObject(subject) || !SUBJECT_KINDS.includes(subject.kind)) {
    bad('buildEvent: subject.kind must be one of ' + SUBJECT_KINDS.join('|'), { type, subject });
  }
  if (!entry.subjects.includes(subject.kind)) {
    bad('buildEvent: subject kind not permitted for this type', { type, kind: subject.kind, allowed: entry.subjects });
  }
  if (typeof subject.id !== 'string' || subject.id.length === 0) {
    // Without a subject id there is no ordering key at all (§3), so the event is unorderable.
    bad('buildEvent: subject.id is required; it is the ordering key', { type });
  }

  if (spec.payload !== undefined && !isPlainObject(spec.payload)) {
    bad('buildEvent: payload must be an object', { type });
  }

  const correlationId = spec.correlationId ?? defaults.correlationId;
  if (typeof correlationId !== 'string' || correlationId.length === 0) {
    // §2: this is what makes a support investigation possible. An event without one is a fact
    // nobody can place in a sequence of player actions.
    bad('buildEvent: correlationId is required', { type });
  }

  const causationId = spec.causationId ?? defaults.causationId ?? null;
  if (causationId !== null && !isUlid(causationId)) {
    bad('buildEvent: causationId must be a ULID event id or null', { type, causationId });
  }

  for (const [field, value] of [['privacyClass', spec.privacyClass], ['retentionClass', spec.retentionClass]]) {
    if (value === undefined) continue;
    const expected = field === 'privacyClass' ? entry.privacyClass : entry.retentionClass;
    if (value !== expected) {
      bad(`buildEvent: ${field} is derived from the catalogue and may not be overridden`,
        { type, supplied: value, expected });
    }
  }

  const recordedAt = new Date(clock.now()).toISOString();
  const occurredAt = spec.occurredAt ?? recordedAt;
  if (!isIsoInstant(occurredAt)) {
    bad('buildEvent: occurredAt must be an ISO-8601 UTC instant', { type, occurredAt });
  }

  const event = {
    eventId: spec.eventId ?? ulid(clock.now()),
    type,
    version,
    occurredAt,
    recordedAt,
    correlationId,
    causationId,
    actor: { kind: actor.kind, id: actor.id, role: actor.role ?? null },
    subject: { kind: subject.kind, id: subject.id },
    payload: spec.payload ?? {},
    privacyClass: entry.privacyClass,
    retentionClass: entry.retentionClass,
    schemaRef: schemaRefFor(type, version),
  };
  if (!isUlid(event.eventId)) bad('buildEvent: eventId must be a ULID', { eventId: event.eventId });
  return event;
}

/**
 * Validate an envelope that arrived from somewhere else (a relay replay, a stored row, a peer
 * service). Returns a list of problems rather than throwing, because a consumer inspecting a
 * malformed row should be able to dead-letter it instead of dying.
 */
export function validateEvent(event) {
  const problems = [];
  if (!isPlainObject(event)) return ['event is not an object'];
  if (!isUlid(event.eventId)) problems.push('eventId is not a ULID');
  const entry = lookup(event.type);
  if (!entry) problems.push(`type ${event.type} is not in the catalogue`);
  else {
    if (!entry.versions.includes(event.version)) problems.push('version is not supported for type');
    if (event.privacyClass !== entry.privacyClass) problems.push('privacyClass does not match the catalogue');
    if (event.retentionClass !== entry.retentionClass) problems.push('retentionClass does not match the catalogue');
    if (event.schemaRef !== schemaRefFor(event.type, event.version)) problems.push('schemaRef does not match type/version');
  }
  if (!PRIVACY_CLASSES.includes(event.privacyClass)) problems.push('privacyClass is not a known class');
  if (!RETENTION_CLASSES.includes(event.retentionClass)) problems.push('retentionClass is not a known class');
  if (!isPlainObject(event.actor) || !event.actor.id) problems.push('actor is missing or unattributed');
  if (!isPlainObject(event.subject) || !event.subject.id) problems.push('subject is missing or has no id');
  if (!isIsoInstant(event.occurredAt)) problems.push('occurredAt is not an ISO instant');
  if (!isIsoInstant(event.recordedAt)) problems.push('recordedAt is not an ISO instant');
  if (!event.correlationId) problems.push('correlationId is missing');
  return problems;
}

/** §3: the ordering key. Not global — two matches have no relationship to each other. */
export const orderingKey = (event) => `${event.subject.kind}:${event.subject.id}`;

/**
 * Envelope <-> `events_outbox` row (db-schema.md §5).
 *
 * The table flattens `type`/`version`/`subject` into columns so the ordering index
 * `(subject_kind, subject_id, occurred_at)` and the partial index on `published_at IS NULL`
 * are index scans rather than JSON extraction. The wire shape stays §2's, so the mapping lives
 * here — once, at the boundary — instead of every consumer learning the column names.
 */
export function toRow(event) {
  return {
    eventId: event.eventId,
    eventType: event.type,
    eventVersion: event.version,
    subjectKind: event.subject.kind,
    subjectId: event.subject.id,
    correlationId: event.correlationId,
    causationId: event.causationId,
    actor: event.actor,
    payload: event.payload,
    privacyClass: event.privacyClass,
    retentionClass: event.retentionClass,
    // Stored, not re-derived at publish time (REQ-CC-019): a ref computed later is a ref that
    // silently changes meaning when the derivation rule does.
    schemaRef: event.schemaRef,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
  };
}

export function fromRow(row) {
  return {
    eventId: row.eventId,
    type: row.eventType,
    version: row.eventVersion,
    occurredAt: row.occurredAt,
    recordedAt: row.recordedAt,
    correlationId: row.correlationId,
    causationId: row.causationId ?? null,
    actor: row.actor,
    subject: { kind: row.subjectKind, id: row.subjectId },
    payload: row.payload ?? {},
    privacyClass: row.privacyClass,
    retentionClass: row.retentionClass,
    schemaRef: row.schemaRef,
  };
}
