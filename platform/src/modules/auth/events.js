/**
 * Platform events emitted by auth.  contracts/event-envelope.md §2, §4, §6.
 *
 * Always through the outbox, always inside the caller's transaction. Publishing from
 * application code after the commit is the crash window that produces state no event
 * explains, and nothing afterwards knows the event is missing.
 *
 * **This file used to hand-build envelopes and insert them raw.** It carried its own copy of
 * the §6 catalogue, produced a §2 envelope (`type`, `version`, `subject`) and passed it
 * straight to `store.outbox.insert`, which takes a §5 ROW (`eventType`, `eventVersion`,
 * `subjectKind`, `subjectId`). Every auth write path therefore died at the first event with
 * `Unknown column for events_outbox: type` — signup included. `envelope.js` has exported
 * `toRow()` for exactly this mapping the whole time, and `events/outbox.js` is the one place
 * allowed to call it, so auth now goes through the outbox rather than around it.
 *
 * What is left here is the two things auth genuinely owns: the actor shapes its events carry,
 * and the guarantee that a unit of work always has a correlation id to be found by.
 */
import { ulid } from '../../core/ids.js';

/** The player whose own action this is. `role` is the primary role on the access token. */
export const playerActor = (accountId, roles = ['player']) =>
  ({ kind: 'player', id: accountId, role: roles[0] ?? 'player' });

/**
 * Auth acting on its own initiative — refresh-token reuse detection, and nothing else.
 * §2: `system` still names its job. "auth" is a job; blank is not attribution.
 */
export const SYSTEM_ACTOR = { kind: 'system', id: 'auth', role: 'service', serviceName: 'auth' };

/**
 * Every event requires a correlation id (§2), and a service called outside HTTP has none.
 *
 * A synthesised id is worse than the request's own and far better than the alternatives, which
 * are dropping the event or failing the write: an event nobody can place in a sequence is
 * still a fact, and the id is at least unique to this unit of work.
 */
export const correlationFor = (correlationId, nowMs) =>
  (typeof correlationId === 'string' && correlationId ? correlationId : ulid(nowMs));
