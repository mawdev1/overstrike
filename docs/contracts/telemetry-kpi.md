# Contract 21 — P4-05 KPI dashboards and definitions

| | |
|---|---|
| **Status** | `FROZEN` |
| **Version** | 1.0.0 |
| **Owner** | [CC] Claude Code |
| **Depends on** | `event-envelope.md` (8, `FROZEN` 1.4.0) for the catalogue this contract reads, not extends; `telemetry.md` (12, `FROZEN` 2.1.0) for the client-side funnel/crash streams this contract composes with rather than duplicates; `deployment.md` (16, `DRAFT` 1.0.0) and `settlement.md` (17, `FROZEN` 1.0.0) for the extraction-run lifecycle events this contract's dashboards are computed FROM |
| **Consumers** | Admin Portal / operator dashboards, Build Plan P4-05's gate evidence, P4-07's human-only Alpha triage |

---

## 1. What this contract is, and is not

Build Plan P4-05: "Instrument funnels, heatmaps, weapon/loot/extraction balance, queue health,
abandonment, and crashes… KPI definitions and dashboards answer where runs fail, why players
leave, and how value flows." The funnel/heatmap **analysis** — drawing conclusions from real
usage data — is explicitly human-only for this campaign (P4-07 gate), same posture
`dynamic-events.md` §10 already states for its own observability surface. **This contract
defines what to measure and how to compute it. It contains no finding, because no usage data
exists yet** — P4-07 has not run.

It is also not a new pipeline. `event-envelope.md` §1 already made that call once: "the
alternative is each subsystem inventing its own analytics format." Every number below is a
read over events `deployment.md`, `settlement.md`, and `telemetry.md` already emit, or an
additive, non-breaking enrichment of one of them (§3.5). No new event type is defined here, no
new ingestion endpoint, no new warehouse.

## 2. Why the run-failure funnel needed no new instrumentation

The obvious-looking gap — "where do extraction runs die: deploy, loot, combat, or exit?" —
turns out to already be answered by events landed for P3-02/P3-04, once read as a funnel rather
than as independent per-domain facts:

| Funnel stage | Answered by | Meaning |
|---|---|---|
| **deploy** | `deployment.reserved` vs `deployment.released` (`deployment.md` §6) | A reservation that never became a run — refused before spawn. `releasedReason` (`abort`\|`timeout`\|`expiry`) is the sub-cause |
| **raid** (loot/combat, undifferentiated) | `deployment.snapshot.consumed` (admitted into the run) vs `run.settled` `outcome` `died`\|`aborted` (`settlement.md` §9) | Reached the sector but did not extract |
| **exit** | `run.settled` `outcome` `extracted` | Reached a validated exit before the run ended |

**Loot vs. combat is not distinguishable in this version**, and this contract does not invent a
distinguishing signal: `settlement.md` §5.1's `RunResult` wire shape is `FROZEN`, closed-key
validated (`settlement/index.js`'s `assertRunResultShape`), and carries no in-raid stage marker
for the `died`/`aborted` outcomes (only `server-failure`'s `lastKnownState.phase` — `not-looted`
\| `looting` \| `at-exit` — has one, per §4.1's conservative resolution already folding that
signal into `died`/`aborted`/`extracted` before it reaches `run.settled`). Recorded as an open
item (§8), not worked around: extending the wire contract is a `settlement.md` CCR, not a P4-05
instrumentation change, and a fabricated stage field would answer the funnel question with a
guess dressed as data — exactly what `extraction-match.md` §4.1 already refuses to do for
`server-failure` itself.

## 3. Run-failure funnel — `kpi.extractionFunnel(since?)`

`platform/src/modules/telemetry/kpi.js`. Reads `deployment.reserved`, `deployment.released`,
`deployment.snapshot.consumed`, `run.settled` from `store.outbox.listByType` (§7 — new, minimal
store method, no new table).

```jsonc
{
  "windowSince": "2026-08-01T00:00:00.000Z" | null,
  "deploy":   { "reserved": 812, "released": 47 },
  "raid":     { "admitted": 765, "byOutcome": { "died": 210, "aborted": 34, "extracted": 521 } },
  "exit":     { "extracted": 521 }
}
```

`raid.admitted` and the sum of `raid.byOutcome` can disagree in a live window — a run whose
`RunResult` has not yet been submitted (§5's `ended` window, `settlement.md` §3) is admitted but
not yet counted in any outcome. That gap is real information (an in-flight or stalled
settlement, §5 of this contract), not a bug in the count.

## 4. Abandonment points — `kpi.abandonment(since?)`

Build Plan: "why players leave." Three stages a participant can leave from, each backed by an
event already emitted for a different reason (§2's table) and re-read here as an abandonment
signal:

| Stage | Source | What it counts |
|---|---|---|
| Pre-lobby / pre-deploy | `telemetry.md` §3.1 `lobby.abandoned` (client-class, personal) | Left before ready/launch. **Not queryable from this contract's store** — it lives in the external warehouse `telemetry.md` §3.3 writes to (`sink.write`, not `events_outbox`), by design (§3's own privacy-class split). Listed here for dashboard completeness, not implemented by `kpi.js` |
| Deploy-stage | `deployment.released`, grouped by `releasedReason` | Reservation dropped before a run ever started — `abort` (player-initiated), `timeout` (match-server-reported), `expiry` (sweep backstop) |
| Raid-stage | `run.settled` `outcome === 'aborted'` | Disconnect past grace or hard timeout while `raid`/`extracting` — `extraction-match.md` §2's "quit or stall gets the loss anyway" case |
| Settlement-stage | `run.exception.opened` `trigger === 'stall'` | A terminal run whose `RunResult` never arrived (`settlement.md` §7.2's stall detector) — the player is gone and the system does not yet know how their run ended |

```jsonc
{
  "windowSince": null,
  "deployStage": { "abort": 12, "timeout": 30, "expiry": 5 },
  "raidStage": { "aborted": 34 },
  "settlementStage": { "stall": 2 }
}
```

## 5. Queue health — `kpi.queueHealth(since?)`

`deployment.md` §2's reservation **is** the extraction queue — there is no separate ticket
table to instrument. Health is admission vs. drop over the same reservation lifecycle §3/§4
already read:

```jsonc
{ "windowSince": null, "reserved": 812, "admitted": 765, "rejected": 3, "released": 47,
  "admissionRate": 0.942 }
```

`admissionRate` is `null`, never `0` or `NaN`, over an empty window — an empty window answers
"no data," not "0% admission," and collapsing the two would make a quiet hour read as an
outage. Latency (time-to-admit) is a deliberate non-goal of this version: `deployment.reserved`
and `deployment.snapshot.consumed` share no per-request correlation id today (`deployment.md`'s
`correlationId` is set per-call, not carried through the reservation row), so a wait-time
computation would have to join on `accountId`+time-proximity — a heuristic, not a measurement.
Recorded as an open item (§8) rather than shipped as an approximate number with no error bar.

## 6. Weapon/loot/extraction balance signals — `kpi.extractionBalance(since?)`

```jsonc
{
  "windowSince": null,
  "exitCounts": { "exit_north": 340, "exit_south": 181 },
  "deathCauseCounts": { "ai": 140, "player": 58, "environment": 12 },
  "instances": { "converted": 2104, "lost": 892 }
}
```

- **Extraction balance** (`exitCounts`) — which exits players actually use, straight off
  `run.settled.exitId` (§3.5 below adds this field; it did not exist on the payload before this
  contract).
- **Death-cause balance** (`deathCauseCounts`) — off `run.settled.deathCause` (same addition).
- **Loot volume balance** (`instances.converted`/`.lost`) — total instance counts moved by
  settlement (`settlement.md` §4's disposition), already on the payload, previously computed
  and then discarded rather than emitted.

### 6.1 Per-item (weapon) balance — explicit gap, not attempted

`run.settled` carries instance **counts**, never item identities — `settlement.md` §6's
disposition transaction (`inventoryService.settleRunInstances`) operates on a whole
participant's run inventory as a batch and was never required to report per-`itemId` detail
back to the caller. Answering "which weapon extracts most" needs one of: (a) a
`settlement.md`-owned enrichment of that return value (a CCR against a `FROZEN` contract,
outside this campaign's authority to make unilaterally), or (b) a direct aggregate query over
`item_instances` grouped by `(item_id, status)` for `location` history a run touched — a query
this contract's `kpi.js` does not add, because `items-inventory.md` defines no such
history-preserving read path today (a converted/lost row's `item_id` is still on the row, but
nothing indexes "every instance that was ever `location='run', run_id=X`" once its `run_id` is
cleared on conversion). Recorded here as the honest state of the gap — not fabricated, not
silently dropped.

## 7. Dashboard-query surface — `platform/src/modules/telemetry/kpiRoutes.js`

Four service-gated `GET` endpoints, same auth posture `settlement.md`'s exception-queue routes
already take (`settlement/routes.js`'s header note: real admin sessions are an additive change
to these routes, not a reshape) — this is explicitly "a lightweight… surface… not a BI
product" (task scope), not a new auth model:

```
GET /v1/admin/kpi/extraction-funnel?since=<ISO instant>     [SERVICE ONLY]
GET /v1/admin/kpi/abandonment?since=<ISO instant>            [SERVICE ONLY]
GET /v1/admin/kpi/queue-health?since=<ISO instant>            [SERVICE ONLY]
GET /v1/admin/kpi/extraction-balance?since=<ISO instant>      [SERVICE ONLY]
```

`since` is optional; when present it is validated as a real ISO-8601 UTC instant (same check
`event-envelope.md`'s own `isIsoInstant` uses) and rejected otherwise rather than silently
ignored. Backed by a new, minimal store method: `store.outbox.listByType(type, {since, limit})`
on both the memory and Postgres adapters, mirroring the existing `outbox.list()` shape and its
500-row cap — a dashboard query is bounded reads over the existing `events_outbox` table, never
a full scan and never a second table.

## 8. Open items

1. **Loot/combat sub-stage inside `raid`** (§2) — not resolvable without a `settlement.md` wire
   amendment; not attempted here.
2. **Per-item (weapon) balance** (§6.1) — same reasoning, a different contract's surface.
3. **Queue latency** (§5) — no shared correlation id between `deployment.reserved` and
   `deployment.snapshot.consumed` today; a heuristic join was rejected in favor of shipping no
   number rather than an unreliable one.
4. **Pre-lobby abandonment dashboard integration** (§4) — `lobby.abandoned` lives in the
   external client-telemetry warehouse (`telemetry.md` §3.3's `sink`), which this platform
   store cannot query; listed for dashboard completeness only.
5. **`dynamic-events.md` §9's `dynamicEvent.*` catalogue** — that contract's own instrumentation
   surface, additive to this one once P4-02's implementation lands; not duplicated here.

## 9. Verification — `platform/test/kpitest.mjs`

1. `run.settled`, emitted through a real `submitRunResult` call (not a hand-built envelope),
   carries `exitId` on an `extracted` outcome and `null` on the others; carries `deathCause` on
   `died` and `null` on the others.
2. `extractionFunnel` splits deploy/raid/exit correctly against seeded events, and `since`
   excludes events before the window boundary while keeping events at it.
3. `abandonment` groups deploy-stage drops by `releasedReason`, counts only `aborted` raid
   outcomes, and counts only `stall`-triggered exceptions for the settlement stage.
4. `queueHealth` reports `admissionRate: null` on an empty window (not `NaN`/`0`) and the
   correct ratio once events exist.
5. `extractionBalance` splits exit and death-cause counts and sums instance dispositions
   correctly.
6. `createKpiService` refuses a store with no `outbox.listByType`.
