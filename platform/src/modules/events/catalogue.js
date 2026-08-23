/**
 * The event catalogue.  contracts/event-envelope.md §6.
 *
 * The registry is the contract made executable. An event type that is not in this table cannot
 * be emitted — not rejected at runtime with a warning, but refused as a programming error,
 * because the alternative is a warehouse full of `match.complete` alongside `match.completed`
 * and no way to tell which one a report should have counted.
 *
 * Privacy and retention live here, not at the call site. §7 makes them drive export, deletion,
 * and lifecycle; a caller that could pass its own would eventually pass the convenient one.
 */

/** §2: the closed set of actor kinds. `system` is for scheduled work, never for "unknown". */
export const ACTOR_KINDS = ['player', 'service', 'admin', 'agent', 'system'];

/** §2: the closed set of subject kinds. Ordering (§3) is keyed on (kind, id). */
export const SUBJECT_KINDS = ['match', 'account', 'room', 'item', 'campaign', 'session', 'chat-message'];

export const PRIVACY_CLASSES = ['public', 'internal', 'personal', 'sensitive'];
export const RETENTION_CLASSES = ['short', 'standard', 'audit', 'financial'];

/** Rows whose subject is `*` in §6 accept any subject kind — admin and config act on anything. */
const ANY_SUBJECT = SUBJECT_KINDS;

const def = (type, versions, actors, subjects, privacyClass, retentionClass) =>
  [type, { type, versions, actors, subjects, privacyClass, retentionClass }];

/**
 * P1–P4, verbatim from §6. `versions` is a list because §8 requires two versions of a type to
 * be accepted simultaneously for at least one phase; a single `version: 1` field would make
 * that migration a breaking edit here.
 */
export const CATALOGUE = new Map([
  def('account.created',        [1], ['player'],           ['account'], 'personal',  'audit'),
  def('account.name_changed',   [1], ['player', 'admin'],  ['account'], 'personal',  'audit'),
  def('session.started',        [1], ['player'],           ['session'], 'personal',  'standard'),
  def('session.revoked',        [1], ['player', 'admin'],  ['session'], 'personal',  'audit'),
  def('session.reuse_detected', [1], ['system'],           ['session'], 'personal',  'audit'),
  def('profile.updated',        [1], ['player'],           ['account'], 'personal',  'standard'),
  def('presence.changed',       [1], ['player'],           ['account'], 'internal',  'short'),
  def('room.created',           [1], ['player'],           ['room'],    'internal',  'standard'),
  def('room.joined',            [1], ['player'],           ['room'],    'internal',  'standard'),
  def('room.left',              [1], ['player'],           ['room'],    'internal',  'standard'),
  def('room.team_changed',      [1], ['player', 'system'], ['room'],    'internal',  'standard'),
  def('room.ready_changed',     [1], ['player'],           ['room'],    'internal',  'short'),
  def('room.launch_requested',  [1], ['player'],           ['room'],    'internal',  'standard'),
  def('room.destroyed',         [1], ['system'],           ['room'],    'internal',  'standard'),
  def('match.allocated',        [1], ['service'],          ['match'],   'internal',  'standard'),
  def('match.started',          [1], ['service'],          ['match'],   'public',    'standard'),
  def('match.completed',        [1], ['service'],          ['match'],   'public',    'audit'),
  def('match.aborted',          [1], ['service'],          ['match'],   'public',    'audit'),
  def('match.invalidated',      [1], ['service', 'admin'], ['match'],   'internal',  'audit'),
  def('match.result_applied',   [1], ['service'],          ['match'],   'internal',  'audit'),
  def('player.killed',          [1], ['service'],          ['match'],   'public',    'standard'),
  def('objective.planted',      [1], ['service'],          ['match'],   'public',    'standard'),
  def('objective.defused',      [1], ['service'],          ['match'],   'public',    'standard'),
  def('report.submitted',       [1], ['player'],           ['account'], 'sensitive', 'audit'),
  def('chat.removed',           [1], ['service', 'admin'], ['chat-message'], 'sensitive', 'audit'),
  def('sanction.applied',       [1], ['admin'],            ['account'], 'sensitive', 'audit'),
  def('sanction.lifted',        [1], ['admin'],            ['account'], 'sensitive', 'audit'),
  def('admin.action.executed',  [1], ['admin'],            ANY_SUBJECT, 'sensitive', 'audit'),
  def('config.changed',         [1], ['admin'],            ANY_SUBJECT, 'internal',  'audit'),
  def('flag.toggled',           [1], ['admin', 'system'],  ANY_SUBJECT, 'internal',  'audit'),

  // settlement.md §9 (P3-04, additive). `subject.kind` is `match` throughout — a run IS a
  // `matches` row (settlement.md §2) — so ordering follows §3's per-subject rule automatically.
  def('run.ended',              [1], ['service'],          ['match'],   'internal',  'standard'),
  def('run.settled',            [1], ['service'],          ['match'],   'internal',  'audit'),
  def('run.exception.opened',   [1], ['system', 'service'], ['match'],  'internal',  'audit'),
  def('run.exception.resolved', [1], ['admin'],             ['match'],  'internal',  'audit'),

  // items-inventory.md §6.3 (P3-01, additive; event-envelope.md is FROZEN, so that contract's
  // own table is the authoritative shape until an amendment promotes the row). Never `player` —
  // no player-initiated call creates an instance directly; a purchase or craft is the service
  // completing a player's request, and the player's action is what `correlationId` carries.
  def('item.created',           [1], ['service', 'admin', 'system'], ['item'], 'internal', 'audit'),

  // deployment.md §6 (P3-02, additive, same pending-amendment posture). `deployment.released`
  // additionally admits `service`: §5.2's timeout release and §5.3's expiry sweep are reported
  // by a named service actor (`match-server`, `deployment-sweep`) — the contract's `system`
  // column describes the same non-player originator, and a named service is the stronger
  // attribution of the two (event-envelope.md §2).
  def('deployment.reserved',          [1], ['player'],                       ['account'], 'internal', 'standard'),
  def('deployment.released',          [1], ['player', 'system', 'service'],  ['account'], 'internal', 'standard'),
  def('deployment.snapshot.issued',   [1], ['service'],                      ['match'],   'internal', 'standard'),
  def('deployment.snapshot.consumed', [1], ['service'],                      ['match'],   'internal', 'audit'),
  def('deployment.snapshot.rejected', [1], ['service'],                      ['match'],   'internal', 'audit'),

  // progression-economy.md §10 (P4-04, additive, same pending-amendment posture as item.created/
  // deployment.* above). `op` is deliberately its own domain, not `progression` — a consumer
  // filtering for "every currency movement" subscribes to one prefix (§10's own reasoning,
  // mirroring `run.*` vs `extraction.*`). `op.earned` is always service-attributed (an award is
  // the platform crediting a run outcome, never a player action); `op.spent`/`item.repaired`/
  // `item.upgraded` are player-attributed (a player-initiated repair/upgrade spend).
  def('op.earned',               [1], ['service'],  ['account'], 'internal', 'audit'),
  def('op.spent',                [1], ['player'],   ['account'], 'internal', 'audit'),
  def('progression.xp.earned',   [1], ['service'],  ['account'], 'internal', 'standard'),
  def('item.repaired',           [1], ['player'],   ['item'],    'internal', 'standard'),
  def('item.upgraded',           [1], ['player'],   ['item'],    'internal', 'standard'),
]);

/** §5: `<domain>.<entity>.<past-tense-verb>`, lowercase, dot-separated, two or three parts. */
const NAME_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*){1,2}$/;

export const isRegistered = (type) => CATALOGUE.has(type);
export const lookup = (type) => CATALOGUE.get(type) || null;
export const isWellNamed = (type) => typeof type === 'string' && NAME_RE.test(type);

/** §2: `events/<type>/v<version>`. Derived, never supplied — a hand-written ref drifts. */
export const schemaRefFor = (type, version) => `events/${type}/v${version}`;
