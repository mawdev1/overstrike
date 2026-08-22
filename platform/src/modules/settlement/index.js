/**
 * P3-04 — idempotent post-run settlement and the exception queue.
 *
 * contracts/settlement.md, migration 0029. This module is `profile/stats.js`'s
 * `applyMatchResult` sibling for a RUN instead of a MATCH: same house idempotency mechanism
 * (`event-envelope.md` §4's transactional outbox, reused exactly as `match-result.md` §5
 * reuses it — §1), same "service-only, replay-safe, differing-payload-is-CONFLICT" shape, but
 * for a per-participant possession outcome instead of a whole-request team outcome.
 *
 * ── Why this is NOT one `store.tx` the way `applyMatchResult` is (§1, §6) ───────────────────
 * A match result has one outcome; a run has one PER PARTICIPANT — a squad can split. So instead
 * of one transaction:
 *
 *   1. ONE transaction for §5.2's "ended" write: `matches.status` leaves `in-progress`, every
 *      named participant is stamped `settlementStatus: 'ended'`, and `run.ended` is emitted —
 *      genuinely run-level, done once per submission.
 *   2. ONE transaction PER PARTICIPANT for §6's settlement disposition (or §7's exception) —
 *      "must never block or partially apply another's."
 *
 * ── The two-store limitation (§1's "commit both or neither"), and why it stays open ─────────
 * `item_instances` lives in the inventory module's own pool; `matches`/`match_participants`/
 * `settlement_exceptions` live in the core store's pool. This is `deployment/index.js`'s own
 * documented limitation (see that file's header) applied to a second module: a single SQL
 * transaction spanning both is not available without deeper platform wiring this module does
 * not introduce. §6's settlement therefore runs as item disposition FIRST (inventory's own
 * transaction), then the `match_participants` stats write + `run.settled` event SECOND (the
 * core store's transaction, fully outbox-guarded). This ordering is deliberate: the item
 * UPDATE's own `WHERE location='run' AND status='active'` makes it naturally idempotent at the
 * row level (§6's own text) — a retry that finds the row already moved matches zero rows rather
 * than re-converting it — so a crash between the two steps is recoverable by retry. What is NOT
 * fully closed: a crash in that exact window leaves the participant `ended` with items already
 * moved and no `match_participants` row saying so yet. `checkStalls` (§7.2) is the backstop for
 * exactly that window, the same role a stall detector plays in `settlement.md` for a `RunResult`
 * that never arrives at all. Recorded here rather than assumed silently, the same posture
 * `deployment/index.js`'s header takes toward its own identical limitation.
 *
 * ── Drift from the contract's literal request shape, and why (task brief: "reconcile drift") ─
 * `settlement.md` §5.1 requires a top-level `status: "completed"|"aborted"` on every submitted
 * `RunResult`. `src/game/extraction.js`'s `buildRunResult()` — the actual P3-03 producer, read
 * against this module per this work item's brief — does not emit that field: its phase machine
 * tracks `ended`, not completed-vs-aborted. `deriveRunStatus` below is the documented stand-in:
 * it uses a caller-supplied `status` when present (validated against the enum) and otherwise
 * derives it from `extraction-match.md` §1.1's own stated rule — `aborted` when no participant
 * ever reached `raid` (an empty `participants[]`), `completed` otherwise. This never overrides
 * a value the caller actually supplied; it fills a gap `buildRunResult()` currently leaves.
 *
 * ── `server-failure`'s phase→outcome mapping (§4.1, a genuine contract gap) ──────────────────
 * §4 says a `server-failure` outcome is "ruled by the last-known state using whichever of the
 * three dispositions above that state matches," but neither `settlement.md` nor
 * `extraction-match.md` states the phase→disposition mapping itself — `lastKnownState.phase` is
 * one of `not-looted|looting|at-exit`, none of which is spelled `extracted`/`died`/`aborted`.
 * This module commits to one explicit, conservative reading: `phase==='at-exit'` WITH an
 * `exitId` present resolves to `extracted` (the closest available signal to a completed
 * extraction); every other phase resolves to `aborted` (full loss — the same "quit or stall to
 * avoid a loss gets the loss anyway" posture `extraction-match.md` §2 states for disconnect and
 * timeout). Recorded here as a documented resolution of an underspecified rule, not a silent
 * guess.
 */
import { createHash } from 'node:crypto';
import { ApiError } from '../../core/errors.js';

export const idempotencyKeyFor = (runId) => `run-result:${runId}`;

/** Pinned, not per-instance — the endpoint is service-only and a retry from a different worker
 * must land on the same idempotency key `match-result.md`'s equivalent constant already pins. */
const RESULT_ACTOR = 'service:run-result';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const RUN_STATUSES = ['completed', 'aborted'];
const OUTCOMES = ['extracted', 'died', 'aborted', 'server-failure'];
const PHASES = ['not-looted', 'looting', 'at-exit'];
const DEATH_CAUSES = ['player', 'ai', 'environment'];

const RUN_TOP_KEYS = new Set([
  'runId', 'status', 'participants', 'startedAt', 'endedAt', 'serverBuild', 'sectorSet', 'evidenceRef',
]);
const PARTICIPANT_KEYS = new Set(['accountId', 'outcome', 'exitId', 'deathCause', 'lastKnownState']);

/** Key order must not change the hash, or a re-serialised retry looks like a different truth. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
export const runResultHash = (runResult) => createHash('sha256').update(stableStringify(runResult)).digest('hex');

function fieldProblem(key, reason, extra = {}) {
  return { key, reason, ...extra };
}

/**
 * §5.1's shape check, plus this module's `status` back-fill (see header). Throws
 * VALIDATION_FAILED with `details.fields[]` naming the offending path, same convention
 * `match-result.md`'s submission validator uses.
 */
function assertRunResultShape(runResult) {
  const problems = [];
  if (!runResult || typeof runResult !== 'object' || Array.isArray(runResult)) {
    throw new ApiError('VALIDATION_FAILED', 'A run result must be an object.');
  }
  for (const k of Object.keys(runResult)) {
    if (!RUN_TOP_KEYS.has(k)) problems.push(fieldProblem(k, 'unknown-key'));
  }
  if (typeof runResult.runId !== 'string' || !runResult.runId) problems.push(fieldProblem('runId', 'required'));
  if (runResult.status !== undefined && !RUN_STATUSES.includes(runResult.status)) {
    problems.push(fieldProblem('status', 'enum', { allowed: RUN_STATUSES }));
  }
  if (!Array.isArray(runResult.participants)) {
    problems.push(fieldProblem('participants', 'required-array'));
  } else {
    runResult.participants.forEach((p, i) => {
      const path = (k) => `participants[${i}].${k}`;
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        problems.push(fieldProblem(path('*'), 'required-object'));
        return;
      }
      for (const k of Object.keys(p)) {
        if (!PARTICIPANT_KEYS.has(k)) problems.push(fieldProblem(path(k), 'unknown-key'));
      }
      if (typeof p.accountId !== 'string' || !p.accountId) problems.push(fieldProblem(path('accountId'), 'required'));
      if (!OUTCOMES.includes(p.outcome)) problems.push(fieldProblem(path('outcome'), 'enum', { allowed: OUTCOMES }));
      if (p.outcome === 'extracted' && (typeof p.exitId !== 'string' || !p.exitId)) {
        problems.push(fieldProblem(path('exitId'), 'required-iff-extracted'));
      }
      if (p.outcome === 'died' && !DEATH_CAUSES.includes(p.deathCause)) {
        problems.push(fieldProblem(path('deathCause'), 'required-iff-died', { allowed: DEATH_CAUSES }));
      }
      if (p.outcome === 'server-failure') {
        const lks = p.lastKnownState;
        if (!lks || typeof lks !== 'object' || !PHASES.includes(lks.phase)) {
          problems.push(fieldProblem(path('lastKnownState'), 'required-iff-server-failure', { allowed: PHASES }));
        }
      }
    });
  }
  for (const k of ['startedAt', 'endedAt', 'serverBuild', 'evidenceRef']) {
    if (typeof runResult[k] !== 'string' || !runResult[k]) problems.push(fieldProblem(k, 'required'));
  }
  if (problems.length) {
    throw new ApiError('VALIDATION_FAILED', 'The run result is not a valid RunResult (settlement.md §5.1).', {
      details: { fields: problems },
    });
  }
}

/** See the module header's "drift" note. Never overrides a caller-supplied `status`. */
function deriveRunStatus(runResult) {
  if (runResult.status) return runResult.status;
  return runResult.participants.length === 0 ? 'aborted' : 'completed';
}

/** See the module header's "server-failure's phase→outcome mapping" note. */
function resolveOutcome(participant) {
  if (participant.outcome !== 'server-failure') return participant.outcome;
  const { phase, exitId } = participant.lastKnownState;
  return phase === 'at-exit' && exitId ? 'extracted' : 'aborted';
}

/** §4's matrix: extracted converts to permanent; died/aborted (and server-failure resolved to
 * either) both lose everything. Never a third disposition (§4's own text). */
function dispositionFor(resolvedOutcomeValue) {
  return resolvedOutcomeValue === 'extracted' ? 'permanent' : 'lost';
}

/**
 * @param outbox  REQUIRED, same reasoning `profile/stats.js` states for its own: a settlement
 *   applied with no event is exactly the state the outbox pattern exists to make impossible,
 *   and here the state being applied can duplicate or destroy an item (§1) — a stricter failure
 *   mode than a career counter that self-heals on recompute.
 */
export function createSettlementService({ store, inventoryService, outbox, clock = Date }) {
  if (!store) throw new Error('createSettlementService: store is required');
  if (!inventoryService) throw new Error('createSettlementService: inventoryService is required');
  if (!outbox || typeof outbox.emitIn !== 'function') {
    throw new Error('createSettlementService requires an outbox (settlement.md §1/§6).');
  }
  const nowIso = () => new Date(clock.now()).toISOString();

  // ------------------------------------------------------------------------------------ §6/§7

  /**
   * One participant's settlement, exactly one transaction, independently idempotent — §3's
   * lifecycle table read as code. Called both by first-pass submission and by §7.4 exception
   * resolution (with `forcedOutcome`/`exceptionId` supplied).
   */
  async function settleParticipant(runId, participant, {
    correlationId, forcedOutcome = null, resolvingExceptionId = null, reviewedBy = null,
    // Present only when called from §7.4 exception resolution for a real disposition — folds
    // the exception row's terminal write into THIS SAME outbox.commit transaction (§6.1) rather
    // than a second, independent one. See resolveException below.
    resolutionDetails = null,
  } = {}) {
    const accountId = participant.accountId;

    // Natural, participant-level idempotency (module header, "the two-store limitation"): a
    // retry — whether from the outer idempotency-key replay or from a crash before it — finds
    // the participant already at a terminal or open disposition and returns it unchanged,
    // rather than re-running the item mutation or re-emitting an event.
    const current = await store.matches.getParticipant(runId, accountId);
    const status = current?.stats?.settlementStatus;
    if (!resolvingExceptionId && status === 'settled') {
      return { accountId, settlementStatus: 'settled', outcome: current.stats.outcome ?? null,
        exceptionId: null, trigger: null };
    }
    if (!resolvingExceptionId && status === 'exception-resolved') {
      return { accountId, settlementStatus: 'exception-resolved', outcome: current.stats.outcome ?? null,
        exceptionId: current.stats.exceptionId ?? null, trigger: null };
    }
    if (!resolvingExceptionId && status === 'exception-open') {
      return { accountId, settlementStatus: 'exception-open', outcome: null,
        exceptionId: current.stats.exceptionId ?? null, trigger: current.stats.trigger ?? null };
    }

    const resolved = forcedOutcome ?? resolveOutcome(participant);

    // §7.1's lock-mismatch trigger, checked before any item_instances write is issued. The
    // deployment-reservation cross-check §7.1's own row also names is deferred — this module
    // checks the one invariant it can see without a second cross-module store dependency: every
    // surviving row this settlement is about to move should still carry the raid-duration lock
    // `deployment.md` §4.5 step 4 leaves in place, per that contract's own "settlement is not a
    // race settlement is discovering" framing.
    if (!resolvingExceptionId) {
      const surviving = (await inventoryService.listRunInventory(runId))
        .filter((r) => r.ownerAccountId === accountId && r.status === 'active');
      const mismatched = surviving.filter((r) => !r.locked);
      if (mismatched.length > 0) {
        return openParticipantException(runId, accountId, {
          trigger: 'lock-mismatch', correlationId,
          evidenceSnapshot: { participant, mismatchedInstanceIds: mismatched.map((r) => r.instanceId) },
        });
      }
    }

    const disposition = dispositionFor(resolved);
    let settledInstances = [];
    if (disposition) {
      settledInstances = await inventoryService.settleRunInstances({ runId, accountId, disposition });
    }

    const statsPatch = {
      settlementStatus: resolvingExceptionId ? 'exception-resolved' : 'settled',
      outcome: resolved,
    };
    if (resolvingExceptionId) statsPatch.exceptionId = null;

    const ctx = { correlationId: correlationId || runId, actor: { kind: 'service', id: RESULT_ACTOR, role: 'service' } };
    await outbox.commit(ctx, async (tx, emit) => {
      // The `match_participants` write and its `run.settled` event are the one atomic unit §1
      // requires for THIS store's half of the settlement (the item_instances half already
      // committed above — see the module header's "two-store limitation" note).
      await store.matches.mergeParticipantStats(runId, accountId, statsPatch, tx);
      await emit({
        type: 'run.settled',
        subject: { kind: 'match', id: runId },
        payload: {
          accountId, outcome: resolved,
          instancesConverted: disposition === 'permanent' ? settledInstances.length : 0,
          instancesLost: disposition === 'lost' ? settledInstances.length : 0,
          resolvedFromExceptionId: resolvingExceptionId,
        },
      });

      // §6.1 — a resolved-exception disposition commits its `settlement_exceptions` write and
      // `run.exception.resolved` event in this SAME transaction, not a second independent
      // `outbox.commit`. Two commits left a real gap: a crash between them (or two racing
      // resolutions of the same exception) could leave `match_participants` settled with the
      // exception row still 'in-review', or vice versa. `store.settlementExceptions.resolve`'s
      // own `WHERE status = 'in-review'` guard (mirroring auth/sessions.js's `markUsed`) is what
      // makes a second, concurrent resolution of the same exception fail here rather than
      // silently re-emitting `run.settled` and clobbering the first operator's audit trail.
      if (resolutionDetails) {
        await store.settlementExceptions.resolve({
          exceptionId: resolvingExceptionId,
          resolution: resolutionDetails.resolution,
          resolutionNotes: resolutionDetails.resolutionNotes,
          resolutionEvidenceRef: resolutionDetails.resolutionEvidenceRef,
          reviewedBy,
        }, tx);
        await emit({
          type: 'run.exception.resolved',
          subject: { kind: 'match', id: runId },
          payload: { accountId, exceptionId: resolvingExceptionId, resolution: resolutionDetails.resolution },
          actor: { kind: 'admin', id: reviewedBy, role: 'admin' },
        });
      }
    });

    return { accountId, settlementStatus: statsPatch.settlementStatus, outcome: resolved,
      exceptionId: null, trigger: null };
  }

  async function openParticipantException(runId, accountId, { trigger, correlationId, evidenceSnapshot }) {
    const ctx = { correlationId: correlationId || runId, actor: { kind: 'system', id: 'system:settlement', role: 'system' } };
    let exceptionId = null;
    await outbox.commit(ctx, async (tx, emit) => {
      const row = await store.settlementExceptions.open({
        runId, accountId, trigger, openedBy: 'system', evidenceSnapshot: evidenceSnapshot ?? {},
      }, tx);
      exceptionId = row.exceptionId;
      await store.matches.mergeParticipantStats(runId, accountId, {
        settlementStatus: 'exception-open', outcome: null, exceptionId, trigger,
      }, tx);
      await emit({
        type: 'run.exception.opened',
        subject: { kind: 'match', id: runId },
        payload: { accountId, trigger, exceptionId },
      });
    });
    return { accountId, settlementStatus: 'exception-open', outcome: null, exceptionId, trigger };
  }

  async function openRunLevelException(runId, { correlationId, missingAccountIds }) {
    const ctx = { correlationId: correlationId || runId, actor: { kind: 'system', id: 'system:settlement', role: 'system' } };
    let row = null;
    await outbox.commit(ctx, async (tx, emit) => {
      row = await store.settlementExceptions.open({
        runId, accountId: null, trigger: 'missing-participant', openedBy: 'system',
        evidenceSnapshot: { missingAccountIds },
      }, tx);
      await emit({
        type: 'run.exception.opened',
        subject: { kind: 'match', id: runId },
        payload: { accountId: null, trigger: 'missing-participant', exceptionId: row.exceptionId },
      });
    });
    return { exceptionId: row.exceptionId, trigger: 'missing-participant' };
  }

  // ------------------------------------------------------------------------------------- §5

  /**
   * `POST /v1/runs/:runId/result` (§5), as a service call. Service-only, idempotent, per
   * -participant — see the module header for exactly how and why it differs from
   * `applyMatchResult`'s single transaction.
   */
  async function submitRunResult({ actor, runResult, idempotencyKey = null, correlationId = null }) {
    if (!actor || actor.kind !== 'service') {
      throw new ApiError('AUTH_FORBIDDEN', 'Run results are service-submitted only.', {
        details: { reason: 'service-only' },
      });
    }
    assertRunResultShape(runResult);
    const status = deriveRunStatus(runResult);
    const key = idempotencyKeyFor(runResult.runId);
    if (idempotencyKey !== key) {
      throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key must be run-result:<runId>.', {
        details: { fields: [{ key: 'Idempotency-Key',
          reason: idempotencyKey === null || idempotencyKey === undefined ? 'required' : 'derived-key-mismatch',
          expected: key }] },
      });
    }
    const requestHash = runResultHash({ ...runResult, status });

    // §5.2's ended-write: one transaction, run-level, ahead of any per-participant settlement.
    // The whole-request idempotency check (§5 rules 2-4) lives in the SAME transaction, so a
    // concurrent duplicate submission serialises on it exactly as `applyMatchResult` does.
    const { result: gate } = await outbox.commit(
      {
        correlationId: correlationId || runResult.runId,
        actor: { kind: 'service', id: RESULT_ACTOR, role: 'service' },
        // A replay (see below) changes no state and emits nothing — `outbox.commit` requires at
        // least one event by default, and that default is right for every OTHER caller in this
        // module. This is the one call site where "no event" is a legitimate outcome, not a bug
        // the default exists to catch.
        requireEvent: false,
      },
      async (tx, emit) => {
        if (store.idempotency.acquire) await store.idempotency.acquire(key, RESULT_ACTOR, tx);
        const prior = await store.idempotency.get(key, RESULT_ACTOR, tx);
        if (prior) {
          if (prior.requestHash !== requestHash) {
            throw new ApiError('CONFLICT', 'This run was already submitted with a different result.', {
              details: { runId: runResult.runId, reason: 'run-already-finalised' },
            });
          }
          return { replay: true, responseBody: prior.responseBody };
        }

        const accountIds = runResult.participants.map((p) => p.accountId);
        await store.matches.transitionRunEnded(runResult.runId, {
          status, startedAt: runResult.startedAt, endedAt: runResult.endedAt,
        }, tx);
        await store.matches.markParticipantsEnded(runResult.runId, accountIds, tx);

        // §7.1's run-level trigger: a submitted match_participants row with no entry in
        // `participants[]`. Checked once per submission against the full roster.
        const runRow = await store.matches.byId(runResult.runId, tx);
        const submitted = new Set(accountIds);
        const missing = (runRow?.participants ?? [])
          .map((p) => p.accountId).filter((id) => !submitted.has(id));

        await emit({
          type: 'run.ended',
          subject: { kind: 'match', id: runResult.runId },
          payload: { status, participantCount: accountIds.length },
        });

        return { replay: false, missing };
      },
    );

    if (gate.replay) return gate.responseBody;

    let runLevelException = null;
    if (gate.missing.length > 0) {
      const opened = await openRunLevelException(runResult.runId, { correlationId, missingAccountIds: gate.missing });
      runLevelException = opened;
    }

    const participants = [];
    for (const p of runResult.participants) {
      // eslint-disable-next-line no-await-in-loop -- §6: one transaction per participant, in
      // submission order, deliberately sequential so one participant's failure cannot corrupt
      // another's — a `Promise.all` here would interleave independent item_instances writes
      // with no benefit, since each is already its own transaction.
      participants.push(await settleParticipant(runResult.runId, p, { correlationId }));
    }

    const responseBody = {
      runId: runResult.runId,
      correlationId: correlationId || runResult.runId,
      resultAppliedAt: nowIso(),
      runLevelException,
      participants,
    };

    // Written LAST, once every participant transaction has committed — see the module header's
    // "two-store limitation" for why this cannot be the same transaction as the ended-write.
    await store.tx(async (tx) => {
      await store.idempotency.put({
        key, actorId: RESULT_ACTOR, requestHash,
        responseStatus: 200, responseBody,
        createdAt: responseBody.resultAppliedAt,
        expiresAt: new Date(Date.parse(responseBody.resultAppliedAt) + IDEMPOTENCY_TTL_MS).toISOString(),
      }, tx);
    });

    return responseBody;
  }

  // -------------------------------------------------------------------------------- §7.2, §7.4

  /**
   * §7.2's stall detector. Not wired to a scheduler here — that is a runbook/ops decision
   * (§7.4's "no SLA is encoded in this contract") — but the mechanism itself is real: every
   * participant of a terminal run with no `settlementStatus` at all, past `timeoutMs`, gets an
   * exception opened rather than staying silently unresolved forever.
   */
  async function checkStalls({ timeoutMs, correlationId = null }) {
    const candidates = await store.matches.listUnsettledRunParticipants();
    const nowMs = clock.now();
    const opened = [];
    for (const c of candidates) {
      const endedMs = Date.parse(c.endedAt ?? '');
      if (!Number.isFinite(endedMs) || nowMs - endedMs < timeoutMs) continue;
      // eslint-disable-next-line no-await-in-loop -- see submitRunResult's identical note.
      const already = await store.settlementExceptions.listOpenForParticipant(c.matchId, c.accountId);
      if (already.length > 0) continue;
      // eslint-disable-next-line no-await-in-loop
      opened.push(await openParticipantException(c.matchId, c.accountId, {
        trigger: 'stall', correlationId, evidenceSnapshot: { endedAt: c.endedAt, timeoutMs },
      }));
    }
    return opened;
  }

  /**
   * §7.4 steps 3-4 — claim, then resolve. Two calls rather than one: the optimistic lock (step
   * 3) is what a real operator UI does before deciding, and collapsing them would make the
   * "someone else claimed it since your last read" race untestable.
   */
  async function claimException({ exceptionId, operatorId, expectedUpdatedAt }) {
    const claimed = await store.settlementExceptions.claim({ exceptionId, operatorId, expectedUpdatedAt });
    if (!claimed) {
      throw new ApiError('CONFLICT', 'That exception was claimed or resolved since it was last read.', {
        details: { exceptionId, reason: 'stale-claim' },
      });
    }
    return claimed;
  }

  /**
   * §7.4 step 4 / §6.1 — the three real dispositions re-enter §6's settlement transaction with
   * the resolved outcome; `void` takes the explicit third branch §6.1 specifies (no
   * `item_instances` mutation, `outcome: null`, `run.settled` never emitted for this
   * participant).
   */
  async function resolveException({ exceptionId, resolution, resolutionNotes, resolutionEvidenceRef = null,
    reviewedBy, correlationId = null }) {
    if (!resolutionNotes || typeof resolutionNotes !== 'string' || !resolutionNotes.trim()) {
      throw new ApiError('VALIDATION_FAILED', 'resolutionNotes is required and must be non-blank (§7.3/§7.4).');
    }
    const exception = await store.settlementExceptions.byId(exceptionId);
    if (!exception) throw new ApiError('NOT_FOUND', 'No such settlement exception.', { details: { exceptionId } });
    if (exception.accountId === null) {
      throw new ApiError('VALIDATION_FAILED', 'A run-level exception has no participant to resolve through §6.', {
        details: { exceptionId, reason: 'run-level-not-participant-resolvable' },
      });
    }
    // §7.4 step 3's optimistic lock, enforced here too: `claimException` moves the row to
    // 'in-review', and resolving is only valid from that state. Without this, two concurrent (or
    // retried) calls for the same exceptionId both proceed — `settleParticipant` re-runs
    // (re-emitting a second `run.settled` and rewriting `match_participants.stats`) and the
    // second resolve clobbers the first operator's `resolutionNotes`/`reviewedBy`/`reviewedAt`.
    // This is the fast, readable check; `store.settlementExceptions.resolve`'s own conditional
    // UPDATE is the DB-level guard that still holds under a genuine race this read can't see.
    if (exception.status !== 'in-review') {
      throw new ApiError('CONFLICT', 'That exception is not in review (already resolved, or not yet claimed).', {
        details: { exceptionId, status: exception.status, reason: 'not-in-review' },
      });
    }

    if (resolution === 'void') {
      const ctx = { correlationId: correlationId || exception.runId,
        actor: { kind: 'admin', id: reviewedBy, role: 'admin' } };
      await outbox.commit(ctx, async (tx, emit) => {
        await store.matches.mergeParticipantStats(exception.runId, exception.accountId, {
          settlementStatus: 'exception-resolved', outcome: null, exceptionId: null,
        }, tx);
        await store.settlementExceptions.resolve({
          exceptionId, resolution: 'void', resolutionNotes, resolutionEvidenceRef, reviewedBy,
        }, tx);
        await emit({
          type: 'run.exception.resolved',
          subject: { kind: 'match', id: exception.runId },
          payload: { accountId: exception.accountId, exceptionId, resolution: 'void' },
        });
      });
      return { accountId: exception.accountId, settlementStatus: 'exception-resolved', outcome: null,
        exceptionId, trigger: null };
    }

    const resolvedOutcomeMap = {
      'settle-as-extracted': 'extracted', 'settle-as-died': 'died', 'settle-as-aborted': 'aborted',
    };
    const forcedOutcome = resolvedOutcomeMap[resolution];
    if (!forcedOutcome) {
      throw new ApiError('VALIDATION_FAILED', 'Unknown resolution.', {
        details: { resolution, allowed: [...Object.keys(resolvedOutcomeMap), 'void'] },
      });
    }
    // §6.1 — one transaction, not two: `resolutionDetails` tells `settleParticipant` to fold the
    // `settlement_exceptions` write and `run.exception.resolved` event into its OWN
    // `outbox.commit` (see that function), rather than this call returning and a second,
    // independent `outbox.commit` running after it. A crash (or a losing racer against
    // `store.settlementExceptions.resolve`'s conditional UPDATE) can no longer leave the
    // participant settled with the exception row still 'in-review', or the reverse.
    const result = await settleParticipant(exception.runId, { accountId: exception.accountId }, {
      correlationId, forcedOutcome, resolvingExceptionId: exceptionId, reviewedBy,
      resolutionDetails: { resolution, resolutionNotes, resolutionEvidenceRef },
    });

    return result;
  }

  return { submitRunResult, checkStalls, claimException, resolveException };
}

export { registerSettlementRoutes } from './routes.js';
