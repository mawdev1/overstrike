/**
 * Events module.  contracts/event-envelope.md.
 *
 * The one import surface for platform events. Nothing outside this module builds an envelope
 * by hand or writes to `events_outbox` directly — §4's guarantee is only as strong as the
 * narrowest way to bypass it.
 */
export {
  CATALOGUE, ACTOR_KINDS, SUBJECT_KINDS, PRIVACY_CLASSES, RETENTION_CLASSES,
  isRegistered, lookup, isWellNamed, schemaRefFor,
} from './catalogue.js';
export { buildEvent, validateEvent, orderingKey, toRow, fromRow, EventContractError } from './envelope.js';
export { createOutbox } from './outbox.js';
export { createRelay } from './relay.js';
export { createConsumer, createMemoryDedupe } from './consumer.js';
export { createAuditLog, summarise, REASON_CODES } from './audit.js';
export { ROLES, ELEVATED_ROLES, check, can, requireCapability, capabilitiesOf, isSharedIdentity } from './rbac.js';
