# Contract 8 — Canonical event envelope

| | |
|---|---|
| **Status** | `FROZEN` — amendments follow CHANGELOG.md |
| **Version** | 1.4.0 |
| **Owner** | [CC] Claude Code |
| **Consumers** | Every platform service, the worker, audit, analytics, Admin Portal |

---

## 1. Why now, before anything needs it

The roadmap's G0 gate exists because the alternative is each subsystem inventing its own
analytics and audit format, and then nothing reconciles and no player action can be followed
end to end. Defining the envelope in P0 costs a page. Retrofitting it across eight domains
costs a quarter.

**Not the same thing as the in-match event bus.** `src/core/events.js` and the snapshot
`EV_KINDS` are frame-scale gameplay feedback. These are platform events: durable, ordered,
auditable, and consumed outside the tick. Nothing here goes near `fixedUpdate`.

## 2. Envelope

```jsonc
{
  "eventId": "01J…",          // ULID, unique, the idempotency key for consumers
  "type": "match.completed",
  "version": 1,                // schema version of THIS type
  "occurredAt": "2026-08-19T18:42:03.221Z",
  "recordedAt": "2026-08-19T18:42:03.244Z",
  "correlationId": "01J…",     // the originating player action
  "causationId": "01J…",       // the eventId that directly caused this one
  "actor":   { "kind": "player|service|admin|agent|system", "id": "…", "role": "…" },
  "subject": { "kind": "match|account|room|item|campaign|session", "id": "…" },
  "payload": { },
  "privacyClass":   "public|internal|personal|sensitive",
  "retentionClass": "short|standard|audit|financial",
  "schemaRef": "events/match.completed/v1"
}
```

| Field | Rule |
|---|---|
| `eventId` | Consumers dedupe on this. Delivery is at-least-once, so **every consumer must be idempotent** |
| `occurredAt` vs `recordedAt` | When it happened vs when it was persisted. A gap means a queued or replayed event; analytics uses `occurredAt`, ops uses both |
| `correlationId` | Same value across client → match server → platform → worker. This is what makes a support investigation possible |
| `causationId` | Direct parent. Correlation gives the whole tree; causation gives the edge |
| `actor` | Who *caused* it. `system` for scheduled jobs. Never blank — "it just happened" is not attribution |
| `privacyClass` | Drives export, deletion, and what may leave the warehouse |
| `retentionClass` | Drives lifecycle. `audit` and `financial` outlive `standard` by design |

## 3. Ordering and delivery

- **At-least-once**, ordered **per subject** — not globally. Global ordering across a match
  server, a lobby, and a worker is neither achievable nor needed.
- Ordering is by `(subject.kind, subject.id)`. Two events about one match arrive in order;
  two events about different matches have no relationship.
- Consumers dedupe on `eventId` and must tolerate replay. A consumer that double-counts on
  replay is a defect, not an operational caveat.
- Dead-letter after the configured retry budget, with an alert. A silently dropped event is
  the worst outcome available.

## 4. The transactional outbox

**Binding rule: a state change and its event are written in the same database transaction.**

```
BEGIN
  UPDATE …                      -- the state change
  INSERT INTO events_outbox …   -- its event
COMMIT
                                -- a relay publishes, marks published, retries on failure
```

Never publish from application code after a commit. The crash between commit and publish is
not hypothetical — it is the single most common way a system develops state that no event
explains, and it is unrecoverable after the fact because nothing knows the event is missing.

The relay is at-least-once by construction: it may publish, fail before marking, and publish
again. That is why §3 requires idempotent consumers.

## 5. Naming

`<domain>.<entity>.<past-tense-verb>` — lowercase, dot-separated.

Good: `match.completed`, `creator.item.submitted`, `sponsor.impression.recorded`.
Bad: `matchComplete` (tense), `MatchCompleted` (case), `match.complete.v2` (version belongs in
the field), `user.update` (which update?).

**Events are facts that already happened.** There is no `match.completing`. If a command needs
representing, it is `agent.action.requested` — a request that was made, which is itself a fact.

## 6. Catalogue — P1 through P4

| Type | Actor | Subject | Privacy | Retention |
|---|---|---|---|---|
| `account.created` | player | account | personal | audit |
| `account.name_changed` | player/admin | account | personal | audit |
| `session.started` | player | session | personal | standard |
| `session.revoked` | player/admin | session | personal | audit |
| `session.reuse_detected` | system | session | personal | audit |
| `profile.updated` | player | account | personal | standard |
| `presence.changed` | player | account | internal | short |
| `room.created` | player | room | internal | standard |
| `room.joined` / `room.left` | player | room | internal | standard |
| `room.team_changed` | player/system | room | internal | standard |
| `room.ready_changed` | player | room | internal | short |
| `room.launch_requested` | player | room | internal | standard |
| `room.destroyed` | system | room | internal | standard |
| `match.allocated` | service | match | internal | standard |
| `match.started` | service | match | public | standard |
| `match.completed` | service | match | public | audit |
| `match.aborted` | service | match | public | audit |
| `match.invalidated` | service/admin | match | internal | audit |
| `match.result_applied` | service | match | internal | audit |
| `player.killed` | service | match | public | standard |
| `objective.planted` / `objective.defused` | service | match | public | standard |
| `report.submitted` | player | account | sensitive | audit |
| `chat.removed` | service | chat-message | sensitive | audit |
| `sanction.applied` / `sanction.lifted` | admin | account | sensitive | audit |
| `admin.action.executed` | admin | * | sensitive | audit |
| `config.changed` | admin | * | internal | audit |
| `flag.toggled` | admin/system | * | internal | audit |

Later phases extend this: economy (`item.created`, `market.sale.completed`,
`prize.reserve.credited`), creator/sponsor (`creator.item.submitted`, `storefront.leased`,
`sponsor.impression.recorded`), agents (`agent.action.requested/approved/completed`).

### 6.1 Gameplay event volume

`player.killed` and the objective events are per-match-event scale, not per-tick. **Nothing at
120 Hz becomes a platform event.** Frame-scale feedback stays in the snapshot event block
(`wire-protocol.md` §5.2); match evidence (`match-result.md` §7) carries the detailed
timeline. Confusing these two would put the platform pipeline in the tick loop and violate
Build Plan §2.2.

## 7. Privacy classes

| Class | Meaning | Constraints |
|---|---|---|
| `public` | Safe to show any player | Match outcomes, public stats |
| `internal` | Operational, non-personal | Not exported outside the platform |
| `personal` | Identifiable | Included in data export; erased or pseudonymised on deletion |
| `sensitive` | Moderation, safety, financial | Access-controlled to specific roles; every read audited |

Deletion is **not** blanket erasure: an `audit`/`financial` event survives account deletion in
pseudonymised form, because a financial or moderation record that vanishes when its subject
asks is neither auditable nor lawful in most regimes. The account identifier is replaced by a
durable pseudonym; the fact remains.

## 8. Schema evolution

- Additive optional fields: bump nothing, consumers ignore unknown fields.
- Any other change: new `version`, both accepted for at least one phase, CCR required.
- Consumers must never fail on an unknown event type — ignore and continue. A new event type
  must not require a coordinated deploy of every consumer.

## 9. Verification — `scripts/eventtest.mjs`

Each with its failing control:

1. No state change without its event: mutate each P1 domain, assert the outbox row exists in
   the same transaction.
2. Kill the process between commit and publish; the event still arrives.
3. Deliver every event twice; assert every consumer's end state is unchanged.
4. Per-subject ordering holds under concurrent producers.
5. A correlation ID set at the client appears on every downstream event.
6. An unknown event type is ignored, not fatal.
7. Dead-letter fires and alerts after the retry budget.
8. `personal` events appear in a data export; `audit` events survive deletion pseudonymised.
