# Contract 16 — Deployment reservation and signed inventory snapshot

| | |
|---|---|
| **Status** | `FROZEN` |
| **Version** | 1.0.0 |
| **Owner** | [CC] Claude Code |
| **Consumers** | Platform deployment service, match server, [CX] loadout preparation UI |

---

## 0. Dependency — `items-inventory.md` (P3-01)

This contract is written against `docs/contracts/items-inventory.md` version `1.0.0`
(`DRAFT`), authored in parallel for P3-01. That contract owns `item_instances`,
`item_definitions`, and `loadouts`, and it already anticipates this one: `item_instances.
locked_by_deployment_id` is declared as `references deployment_reservations` (its §2), and its
§6.2 specifies the exact atomic lock mechanism this contract builds on rather than
reinvents. **This contract does not define a second locking mechanism.** It defines the
`deployment_reservations` table `items-inventory.md` already references, the endpoint that
performs its §6.2 lock, and everything downstream of a successful lock: the signed snapshot,
its verification at the match server, and reservation release.

Both contracts are `DRAFT`. If `items-inventory.md` changes shape before reaching `REVIEW`
(field names, the lock mechanism, the state machine in its §5), this contract's §1–§3 need a
reconciliation pass — they are load-bearing on that document's exact schema, not a paraphrase
of it.

**Second, unlanded dependency — `db-schema.md`'s `matches.mode` CHECK.** `deployment_
reservations.match_id` (§2) and `deployment_snapshots.match_id` (§4.4) both assume a `matches`
row can exist for an extraction run, and §4.3/§4.5 step 4 write `location = 'run', run_id =
matchId` on that basis. But `db-schema.md` (`FROZEN 2.1.0`) §4's CHECK constrains `matches.mode
in ('tdm', 'bomb')` — there is no `'extraction'` value yet. This contract cannot bind a
reservation or snapshot to a real `matches` row until that CHECK is amended to admit an
extraction mode; until then, `match_id`/`matchId` here are forward references to a row shape
that does not exist in the frozen schema. `settlement.md` (contract 17, written after and
depending on this one) already names the same unlanded amendment as an open item blocking its
own path out of `DRAFT` — this contract has the identical dependency and is tracking it here
for the same reason: **open item, not yet landed.**

## 1. What P3-02 has to be true

> A match can validate the exact reserved loadout without querying wallets or trusting the
> client.

Two failure modes this rules out:

1. **The match server asks the platform "what does this player own?" mid-match.** That is a
   database round trip inside gameplay, which Build Plan §2.2 forbids, and it is also a race —
   inventory can change between the query and the moment it matters.
2. **The client tells the match server what it's carrying.** A modified client says it deployed
   with the epic rifle. Nothing server-side may take that word for it.

The fix is the same shape as `auth.md` §6 (match server handoff), applied one layer deeper:
platform locks the exact item instances (`items-inventory.md` §6.2), seals them into a
**signed snapshot**, and the match server verifies the signature and never queries anything at
runtime — the same "signature is a portable claim, a database row is the replay authority"
split `auth.md` §6 and `db-schema.md`'s `match_tickets` already use.

## 2. The `deployment_reservations` table

```sql
deployment_reservations(
  reservation_id     text primary key,              -- ULID
  account_id         text not null references accounts,
  loadout_id         text references loadouts,       -- source loadout, null if instances were
                                                       -- passed explicitly (§2.1)
  room_id            text references rooms,          -- lobby this deployment came from
  match_id           text references matches,        -- null until match allocation (§4.3)
  instance_ids       text[] not null,                -- exact item_instances.instance_id rows,
                                                       -- order-stable; denormalized copy for
                                                       -- signing (§4) — authority is
                                                       -- item_instances.locked_by_deployment_id
  status             text not null default 'reserved',
                     -- reserved | consumed | released | expired
  reserved_at        timestamptz not null default now(),
  expires_at         timestamptz not null,            -- reservation TTL, §2.3
  consumed_at        timestamptz,                     -- set when the match server admits the player
  released_at        timestamptz,
  released_reason    text,                            -- abort|timeout|expiry|manual|superseded
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  check (status in ('reserved','consumed','released','expired')),
  check ((status in ('released','expired')) = (released_at is not null)),
  check (status not in ('released','expired') or released_reason is not null),
  check (released_reason is null or released_reason in
    ('abort','timeout','expiry','manual','superseded'))
)
```

**This table holds metadata, not the lock.** The lock is `item_instances.locked = true` plus
`item_instances.locked_by_deployment_id = reservation_id`, per `items-inventory.md` §2 and §6.2.
`instance_ids` here is a read convenience for building the signed snapshot (§4) without a join;
if the two ever disagree, `item_instances.locked_by_deployment_id` is authoritative, because
that column — not this array — is what a concurrent write actually contends on.

**Why the `released_at` biconditional covers `expired`, not just `released`.** §5.3's expiry
sweep sets `status = 'expired', released_at = now()` on the same row, in the same `UPDATE` — an
earlier draft of this CHECK (`(status = 'released') = (released_at is not null)`) made that
statement false = true, which Postgres rejects: every reservation that ever expires would fail
its own backstop's `UPDATE`. `status in ('released','expired')` is the set of terminal states
that carry a release timestamp; `consumed` is terminal too but deliberately has no
`released_at` (§5.4 — a consumed reservation was never released, it was fulfilled). The second
CHECK follows the same widening: `expired` rows get a `released_reason` (`'expiry'`) exactly
like `released` rows do, written by the identical sweep statement.

**Why `released_reason` has its own CHECK.** Same reasoning `items-inventory.md` gives for
`class`/`slot`/`status`: a comment naming the five valid literals (`abort|timeout|expiry|
manual|superseded`) is exactly the kind of authored-string field where a typo in any of §5.1's,
§5.2's, §5.3's, or §5.3a's four writer paths would land silently — a CHECK is what turns that
into an insert-time rejection instead of a runtime surprise discovered later by a query that
expected one of the five literals and got a sixth.

### 2.1 Reservation is one transaction, using `items-inventory.md` §6.2 verbatim

**The ad hoc `instanceIds` path (§7) is validated against all five of `items-inventory.md`
§3.1's rules, not just rule 1.** A saved loadout already satisfies rules 2/3/5 at save time
(that contract's `PATCH /v1/loadouts/:loadoutId` rejects a badly-shaped `slots` object before
it can ever be persisted), so §2.1's reservation `UPDATE` only has rule 1 (ownership/location/
status) left to re-check for that path — inventory can have moved since save. The ad hoc path
has no such prior validation pass, so the handler runs it inline, before §2.1's `UPDATE`,
against the definitions of the candidate instances:

- **Rule 1 (ownership/location/status)** — re-checked anyway by §2.1's `UPDATE ... WHERE`, same
  as the loadout path.
- **Rule 2 (slot match)** — every instance's `item_definitions.slot` must be non-null (rule 5
  below) and each instance's slot key is its own definition's `slot` value; unlike a saved
  loadout there is no caller-supplied slot key to match against, so this rule specializes to
  "the instance is equippable at all."
- **Rule 3 (one instance per slot)** — no two instances in `instanceIds` may share the same
  `item_definitions.slot` value. A request with two `slot = 'primary'` instances is exactly the
  "two rifles both nominally primary" case rule 3 forbids for a saved loadout, and forbidding
  it here closes the gap that would otherwise let the ad hoc path build a loadout shape a saved
  one could never reach.
- **Rule 5 (`slot = null` can never deploy)** — any candidate instance whose definition has
  `slot = null` (ammo, materials, bulk consumables) fails validation outright. This is the rule
  that keeps the ad hoc path from becoming the undefined "bring your own ammo/stock" pre-raid
  stash `items-inventory.md` §3.1 explicitly defers past P3 — without it, `instanceIds` would be
  an unguarded route to exactly that out-of-scope mechanism.

A failure on any of rules 2/3/5 returns `LOADOUT_INVALID_SLOT` (rule 2), `LOADOUT_DUPLICATE_
INSTANCE` (rule 3), or `LOADOUT_INVALID_SLOT` again (rule 5 — a `slot = null` definition has no
valid slot to match, so it is the same code as rule 2's mismatch, not a sixth code) — reusing
`items-inventory.md` §8's codes verbatim, the same reuse this contract already does for
`LOADOUT_ITEM_NOT_OWNED` (§8 below). This check runs and fails before §2.1's `UPDATE` is
attempted — a rule 2/3/5 violation is a request-shape defect, not a locking race, so it is
reported the same way `DEPLOYMENT_REQUEST_INVALID` is: no partial lock is ever attempted for a
request that could never have been valid.

```
BEGIN
  -- The candidate instance set comes from a saved loadout (items-inventory.md §3.1's
  -- validation rules already apply to it) or an explicit instance list for a same-shape
  -- ad hoc deployment, pre-validated against all five §3.1 rules immediately above; either
  -- way every id must already satisfy loadout rule 1 (ownership, location='permanent',
  -- status='active') before this UPDATE is attempted.

  UPDATE item_instances
  SET locked = true, locked_by_deployment_id = $reservation_id, updated_at = now()
  WHERE instance_id = ANY($instance_ids)
    AND owner_account_id = $account_id
    AND location = 'permanent'
    AND status = 'active'
    AND locked = false;
  -- rowcount must equal length($instance_ids); anything less is a partial lock, which
  -- items-inventory.md §6.2 declares is never a valid state.

  -- rowcount matched:
  INSERT INTO deployment_reservations (...)          -- status='reserved'
  INSERT INTO events_outbox (...)                     -- deployment.reserved
COMMIT

  -- rowcount short:
ROLLBACK   -- the UPDATE above reverts too; no partial lock survives (see §3)
```

This is `items-inventory.md` §6.2's mechanism, not a paraphrase of it: the `WHERE locked =
false` predicate is what makes two concurrent reservation attempts on the same instance
resolve to exactly one winner at the database level, and the rowcount check is what turns "some
of the instances locked" into "the whole attempt failed," because a reservation with a
non-empty gap in it is not a coherent thing to sign a snapshot for.

### 2.2 TTL

A reservation is held for **90 seconds** from `reserved_at` — generous over the `auth.md` §6
session ticket's 60 s because deployment additionally waits on match allocation, which the
ticket does not; the two windows are sequential; not nested, not comparable 1:1. A reservation
not `consumed` by `expires_at` is eligible for the expiry sweep (§5.3).

## 3. Reservation conflict — same item, two concurrent deployments

This is the case P3-02's DoD names explicitly: two requests for the same account (two tabs,
two devices, a client retry racing its own timeout) attempt to reserve overlapping instances.

1. Both transactions issue §2.1's `UPDATE`.
2. Postgres serializes row-level writes to the same `item_instances` row: the first to reach it
   flips `locked false → true` and commits; the second's `WHERE locked = false` predicate no
   longer matches that row once the first commits (or the second blocks on the row lock and
   then finds it not-`false` on retry, depending on isolation level — either way, at most one
   write to a given row's `locked` column can be `false → true`).
3. The loser's rowcount is short. Per §2.1, its **entire transaction rolls back** — no partial
   lock, no reservation row, no event. It is exactly as if the losing request never ran.
4. The loser's request returns `DEPLOYMENT_RESERVATION_CONFLICT` (409). To populate
   `details.conflictingInstances`, the handler re-reads (a fresh statement, after its own
   rollback) `SELECT instance_id, locked, locked_by_deployment_id FROM item_instances WHERE
   instance_id = ANY($attempted_ids)` — this is diagnostic detail for the caller, not part of
   the atomicity guarantee, which is already fully decided by step 3.

**No "second reservation wins and evicts the first."** An evicting reservation would let a
faster retry silently steal a slot mid-deployment — the exact race the lock exists to prevent.
The first committed transaction holds the lock until it is consumed, released, or expires.

**Per-instance vs aggregate error.** `items-inventory.md` §8 already defines `ITEM_ALREADY_
DEPLOYED` (409) for "reservation attempted on an instance already `locked = true` under a
different deployment" — that is the per-instance reason. `DEPLOYMENT_RESERVATION_CONFLICT` is
this contract's aggregate: the whole `/v1/deployments` call failed, and `details.
conflictingInstances[]` carries which instances and, per instance, whether the cause was
`ITEM_ALREADY_DEPLOYED` (raced by another deployment, `locked` was already `true`) or
`LOADOUT_ITEM_NOT_OWNED` (the item stopped being eligible between loadout save and deploy —
sold, transferred, or otherwise no longer `owner=caller, location='permanent', status='active'`).
§2.1's `UPDATE` has exactly two ways to fail to touch a row — `locked = false` no longer
matching, or the ownership/location/status predicate no longer matching — so those are the only
two per-instance reasons this handler can distinguish. `items-inventory.md` §8's `ITEM_LOCKED`
is that contract's §6.4 **write-path** code (a mutation attempted on an already-locked
instance's mutable fields); it is never produced by §2.1's reservation `UPDATE`, so it is **not**
a possible `conflictingInstances[].reason` value here — see the corrected list in §8. The client
degrades using the per-instance reasons (drop the contested slot, keep the rest) rather than
retrying blind.

**Cross-account isolation is automatic.** The `UPDATE`'s `owner_account_id = $account_id`
predicate means account A's deployment attempt can never contend with account B's — this
section is entirely about one account racing itself.

## 4. Signed inventory snapshot

### 4.1 What is signed

The snapshot is the **complete, self-contained claim** the match server needs to seed the run
inventory (`items-inventory.md` §4) without ever calling platform again mid-match:

```jsonc
{
  "reservationId": "01J…",
  "accountId": "01J…",
  "matchId": "01J…",          // bound at issuance — see §4.3
  "roomId": "01J…",
  "issuedAt": "2026-08-22T14:03:11.000Z",
  "expiresAt": "2026-08-22T14:04:11.000Z",   // issuedAt + 60s, independent of reservation TTL
  "items": [
    {
      "instanceId": "01J…",
      "itemId": "rifle_ak74",        // item_definitions.item_id
      "slot": "primary",
      "quantity": 1,
      "durability": null,            // frozen at snapshot time; null in P3 per items-inventory.md §10
      "attachments": []              // frozen at snapshot time; empty in P3
    }
    // one entry per locked instance
  ],
  "itemsHash": "sha256:…"       // hash of the items array in slot order — tamper-evidence
                                 // independent of transport, so a partial/reordered replay
                                 // is detectable even before signature verification
}
```

**"Slot order" is `items-inventory.md` §2's `item_definitions.slot` CHECK-enum order** —
`primary, secondary, melee, helmet, vest, backpack, rig, consumable` — the same fixed sequence
that enum already commits to for every other slot-ordered listing in that contract, not
alphabetical and not request/loadout-array order (either of which an ad hoc `instanceIds`
request could vary run to run without changing the deployed set, which would make `itemsHash`
churn on a reorder of an identical loadout — exactly the false-tamper-signal the hash exists to
avoid). The issuer sorts `items[]` into this order before serializing and hashing; a locked
instance whose definition has `slot = null` cannot appear here at all (§2.1's rule 5 pre-check
excludes it before reservation, let alone snapshot issuance). This governs only how the issuer
*constructs* the array for reproducibility (tests, audits, re-issuance); it is not load-bearing
for verification, which checks the HMAC over the payload as actually received (§4.1), not by
independently recomputing `itemsHash` from a re-sorted copy.

Signed with the same platform signing key family used for `auth.md` §6 session tickets
(HMAC-SHA256, server-held secret — no asymmetric requirement, since the only verifier is the
match server, a first-party service, not a public client). The signature covers the entire
canonical (sorted-key) JSON serialization, not just `itemsHash` — `itemsHash` is a cheap
partial-tamper check before the more expensive signature verification, not a substitute for it.

### 4.2 Why gameplay state is frozen into the snapshot, not looked up

`durability`/`attachments`/`quantity` are copied into the snapshot at issuance rather than
referenced by id and re-read at spawn. The match server's contract is "verify a signature and
spawn," never "verify a signature and then query platform for the state that signature was
supposed to certify" — a field that requires a lookup to interpret is not actually sealed. This
is safe specifically because `items-inventory.md` §6.4 rejects any mutation of a `locked`
instance's `item_id`, `quantity`, `attachments`, or `durability` at the write layer — the
snapshot freezes a value that is already contractually frozen by the lock, not a value that
could still be racing underneath it.

### 4.3 Expiry and match binding

- **60-second TTL**, matching the `auth.md` §6 session ticket window the player presents at the
  same moment, to the same match server, in the same admission call.
- `matchId` is bound at issuance, not left generic. A snapshot for match A presented to match
  server B (wrong allocation, stale retry, a cached response) is rejected on the `matchId`
  mismatch alone — cheap rejection first, cryptographic check second, not a substitute for the
  signature, just checked before it.
- Issuance is **after** match allocation (`match.allocated`, `event-envelope.md` §6), not at
  reservation time. A reservation can exist before "which match server" is decided; the
  snapshot cannot, because it commits to one.

### 4.4 Replay protection

Mirrors `match_tickets` (`db-schema.md` §4) exactly: the signature is a **portable claim**, the
database row is the **replay authority**.

```sql
deployment_snapshots(
  snapshot_id    text primary key,      -- ULID, embedded in the signed payload
  reservation_id text not null references deployment_reservations,
  match_id       text not null references matches,
  issued_at      timestamptz not null,
  expires_at     timestamptz not null,
  consumed_at    timestamptz,           -- null until admitted
  created_at     timestamptz not null default now()
)
```

Admission is the same atomic pattern as `match_tickets`: `UPDATE deployment_snapshots SET
consumed_at = now() WHERE snapshot_id = $id AND consumed_at IS NULL AND expires_at > now()`.
Zero rows affected ⇒ reject. A verified-but-already-consumed signature (replay, or two match
server processes racing on the same connection retry) fails here even though the HMAC checks
out — the signature proves authenticity, not freshness or single use; only the database row
proves those. Matches `db-schema.md` §4's rationale verbatim: "a game-server restart or two
concurrent verifiers cannot reuse the same jti."

On rejection: `DEPLOYMENT_SNAPSHOT_INVALID` (401) — bad signature, unknown `snapshot_id`,
already consumed, or expired collapse into one code deliberately, the same reasoning as
`AUTH_INVALID_CREDENTIALS` not distinguishing wrong-username from wrong-password: telling an
attacker which check failed narrows their search.

### 4.5 Verification flow at the match server

```
1. Client connects with (session ticket, deployment snapshot)   -- both single-use, both TTL'd
2. Match server → platform S-endpoint: verify session ticket (auth.md §6, unchanged)
3. Match server → platform S-endpoint: verify deployment snapshot (§7.1)
     a. HMAC check against the canonical payload
     b. matchId in payload == matchId this server was allocated (§4.3)
     c. accountId in payload == accountId the session ticket just authenticated
     d. atomic consume of deployment_snapshots row (§4.4)
4. All four pass, in one transaction:
     - deployment_snapshots.consumed_at = now()               (§4.4)
     - UPDATE deployment_reservations SET status = 'consumed', consumed_at = now()
         WHERE reservation_id = $reservationId AND status = 'reserved'
       -- rowcount 0 here is the race §4.3's independent 60s/90s windows leave open: the
       -- reservation's 90s TTL can elapse and be swept (§5.3) to status='expired' in the gap
       -- between the snapshot's own 60s issuance and this admission call actually landing.
       -- The snapshot's HMAC/replay checks (step 3) say nothing about the reservation row's
       -- current status — they are two different clocks. Rowcount 0 ⇒ ROLLBACK the whole
       -- transaction (the snapshot's atomic consume from step 3d rolls back too — the snapshot
       -- is NOT spent) and return DEPLOYMENT_RESERVATION_EXPIRED (409) from §7.1's
       -- verify-snapshot call, not DEPLOYMENT_SNAPSHOT_INVALID: the signature was genuine and
       -- fresh, the reservation backing it is what expired, and the client behavior differs —
       -- restart deployment (§8), not re-request a snapshot for a reservation that no longer
       -- holds anything.
     - rowcount 1: item_instances: location = 'run', run_id = matchId
         WHERE locked_by_deployment_id = reservationId          (items-inventory.md §4 —
       this is the "run inventory seeded from the locked loadout at deployment" transition;
       `locked` stays true through the raid, cleared only at settlement, §5.4)
     - INSERT events_outbox (deployment.snapshot.consumed)
5. Spawn the entity with items[] (§4.1) as the run inventory's opening state.
   Any check in step 3 fails → connection refused, reservation is NOT auto-released — a
   failed snapshot check is not proof the reservation is abandoned; §5 owns that decision.
   Step 4's rowcount-0 case is different: the reservation is already `expired` (or otherwise
   non-`reserved`) by the time admission was attempted, so there is nothing left to release.
```

Step (c) binding `accountId` across two independently-issued, independently-signed artifacts is
what stops a stolen or replayed snapshot from being presented under someone else's session —
each signature is checked against the other's claims, not just each against itself.

**Step 1's "client connects with" is the wire fact, not the delivery mechanism.** The snapshot
reaches the match server the same way the session ticket does: platform pushes both to the
client together in `realtime-lobby.md` §6.1's `match.ready` frame (a new `deploymentSnapshot`
field, additive to that payload, pending that contract's own amendment — same single-use,
TTL'd shape as `sessionTicket` in the same frame), and the client presents both, unmodified,
at match-socket connect (`wire-protocol.md` `MSG_HELLO`). "Never fetched by the client
directly" (§7) means the client never calls a `GET` to retrieve it and never sees anything it
could tamper with and re-sign — it is opaque, HMAC-sealed cargo the client relays, exactly like
the session ticket it travels beside. §7.1 is the internal call this is checked against.

## 5. Reservation release

A reservation must never hold an item instance hostage past the window where holding it still
serves a live deployment attempt. Every path below only ever touches rows still `status =
'reserved'` — a `consumed` reservation is structurally unreachable here (§5.4).

### 5.1 Abort — deployment cancelled before consumption

Client cancels, room is destroyed, or platform's own allocation fails
(`MATCH_ALLOCATION_FAILED`, 503, `errors.md` §3 — "No capacity in region"). Explicit release:

```
UPDATE deployment_reservations
  SET status = 'released', released_at = now(), released_reason = 'abort'
  WHERE reservation_id = $id AND status = 'reserved'
UPDATE item_instances SET locked = false, locked_by_deployment_id = null
  WHERE locked_by_deployment_id = $id
INSERT INTO events_outbox (...)   -- deployment.released, reason=abort
```

Same transactional-outbox shape as reservation (§2.1) — the state change and its event commit
together, never one without the other (`event-envelope.md` §4). Note there is no `location`
change to undo here: an aborted reservation never reached §4.5 step 4, so the instances never
left `location = 'permanent'`.

### 5.2 Timeout — match server never admits the player

The session-ticket/snapshot pair expires (60 s) well inside the reservation's 90 s window by
design — a timed-out admission attempt still has time to release explicitly rather than falling
through to the passive sweep. §5.3 is the backstop for what this doesn't reach, not the primary
timeout mechanism.

This is the same `UPDATE` as §5.1, called by a different actor, which is what gives
`released_reason` its distinct `timeout` value instead of collapsing into `abort`:

- **`abort`** — the caller is the player (client-initiated `DELETE`, §7) or platform itself
  deciding pre-allocation that the attempt is dead (room destroyed, `MATCH_ALLOCATION_FAILED`).
  The account holding the reservation, or platform on its behalf, gave up on it.
- **`timeout`** — the caller is the match server the deployment was allocated to, reporting
  that its ticket/snapshot admission window (60 s) elapsed with the client never completing
  `MSG_HELLO` (§4.5 never ran, or ran and failed). The match server calls the same release path
  authenticated as a service (not on behalf of the account), and that caller identity is what
  the handler writes as `released_reason`. The reservation didn't get cancelled — admission
  never happened.

Both write through §7.1's internal release call (or the client-facing `DELETE` for the `abort`
case); neither is a distinct SQL statement from §5.1's `UPDATE`, only a distinct value for the
literal being written.

### 5.3 Expiry sweep — the backstop

A scheduled job (same family as the `pre_auth_consent` janitor and the `match_tickets` 24-hour
deletion sweep, `db-schema.md` §2/§4) runs on an interval:

```sql
UPDATE deployment_reservations
  SET status = 'expired', released_at = now(), released_reason = 'expiry'
  WHERE status = 'reserved' AND expires_at < now()
-- same transaction: UPDATE item_instances SET locked=false, locked_by_deployment_id=null
--                    WHERE locked_by_deployment_id = <swept reservation_id>
-- and emit deployment.released
```

This is the actual backstop for every path that doesn't explicitly release — crash, network
partition, an admin killing a match server mid-allocation. **No reservation is unreleasable.**
The sweep interval is a deployment/ops parameter (target: every 10 s, generous against the 90 s
TTL), not a contract number — this document fixes the invariant (nothing outlives `expires_at`
locked), not the polling cadence.

### 5.3a `manual` and `superseded` — the two remaining values

The column comment names five `released_reason` values; §5.1–§5.3 account for `abort`,
`timeout`, and `expiry`. The remaining two exist for callers this contract does not itself
drive, but both write through the identical §5.1 `UPDATE` — no new mechanism, only a new
literal:

- **`manual`** — an operator (`support` or `moderator` role, `auth.md` §10) releases a
  reservation through support tooling, not through §7's player-facing endpoints. This is the
  path for "the automated releases haven't fired and a player is stuck holding a lock" — e.g.
  investigating a report before the 90 s TTL would otherwise expire it anyway. Every such call
  is audited with actor and reason code per `auth.md` §10, same as any other privileged action.
- **`superseded`** — a launch attempt for the same `room_id` is aborted and relaunched
  (`realtime-lobby.md` §6.1 rule 2's `countdown.aborted`) after reservations were already made
  for the dead attempt. Platform releases every `reserved` row for that `room_id` when the
  countdown aborts, so a fresh launch starts from a clean reservation set rather than racing
  the dead attempt's locks. This is **not** the §3 "second reservation evicts the first" case —
  that stays forbidden for two *live, concurrent* attempts. `superseded` only fires once the
  first attempt's own launch has already died server-side; there is no window where both are
  contending for the same instances.

Neither value is exercised by the P3-02 client flow (`POST`/`DELETE /v1/deployments`) — both
are system/operator-initiated, which is why `POST /v1/deployments` and `DELETE
/v1/deployments/:reservationId` never accept `abort`/`timeout`/`manual`/`superseded` as a
request parameter; the reason is always derived server-side from the caller and the trigger,
never client-supplied.

### 5.4 A consumed reservation is never auto-released by this section

Once `status = 'consumed'` (§4.5 succeeded), the reservation's instances are `location = 'run'`
for the raid's duration. Release from that point is `P3-04`'s concern (settlement — extract
transitions the instances to `location = 'permanent'`, death/abort to `status = 'lost'`, both
per `items-inventory.md` §4 — and clears `locked`/`locked_by_deployment_id` in that same
transaction, per its §6.4), not this contract's. §5.1–5.3's `WHERE status = 'reserved'` (or
`= 'reserved' AND expires_at < now()`) clauses make a `consumed` row structurally unreachable
by any `UPDATE` in this section — this isn't a policy this contract has to remember to honor,
it's a predicate that can't match.

## 6. Events (additive to `event-envelope.md` §6, pending that contract's own amendment)

| Type | Actor | Subject | Payload highlights | Privacy | Retention |
|---|---|---|---|---|---|
| `deployment.reserved` | player | account | `reservationId`, `instanceIds`, `expiresAt` | internal | standard |
| `deployment.released` | player/system | account | `reservationId`, `releasedReason` | internal | standard |
| `deployment.snapshot.issued` | service | match | `snapshotId`, `reservationId`, `matchId`, `expiresAt` | internal | standard |
| `deployment.snapshot.consumed` | service | match | `snapshotId`, `accountId` | internal | audit |
| `deployment.snapshot.rejected` | service | match | `reason` (bad-signature\|expired\|already-consumed\|match-mismatch\|account-mismatch) | internal | audit |

`deployment.snapshot.rejected` is `audit`, not `standard` — a rejected admission attempt is
exactly the signal that would surface a forged or replayed snapshot, and the P3-12 failure
matrix should be able to reconstruct it after the fact.

Naming follows `event-envelope.md` §5 (`<domain>.<entity>.<past-tense-verb>`). Landing these in
that contract's catalogue is a normal **additive** amendment (new types, no existing type
changes meaning) once both contracts are past `DRAFT`.

## 7. API surface

Base path `/v1`, conventions per `http-api.md` §1 (correlation ID, idempotency, error
envelope, no partial success). `Authorization: Bearer` required.

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /v1/deployments` | A | Reserve a loadout's instances and lock them (§2.1). `Idempotency-Key` required (`http-api.md` §8) |
| `DELETE /v1/deployments/:reservationId` | A | Explicit client-initiated abort (§5.1) |

```jsonc
// POST /v1/deployments request — exactly one of these two shapes, not both, not neither:
{
  "loadoutId": "01J…",       // preferred: validated against items-inventory.md §3.1 at save time
  "roomId": "01J…"
}
// OR, for an ad hoc deployment not backed by a saved loadout:
{
  "instanceIds": ["01J…", "01J…"],   // non-empty
  "roomId": "01J…"
}

// 200 response
{
  "reservationId": "01J…",
  "instanceIds": ["01J…", "01J…"],
  "expiresAt": "2026-08-22T14:04:41.000Z",
  "correlationId": "01J…"
}

// 400 DEPLOYMENT_REQUEST_INVALID — body shape violation, checked before any DB access:
//   both loadoutId and instanceIds present, neither present, or instanceIds is an empty array.
//   Distinct from LOADOUT_ITEM_NOT_OWNED / ITEM_ALREADY_DEPLOYED, which require a well-shaped
//   body to even evaluate.
{
  "code": "DEPLOYMENT_REQUEST_INVALID",
  "message": "…",
  "correlationId": "01J…",
  "retryable": false,
  "details": { "fields": ["loadoutId", "instanceIds"] }
}

// 409 DEPLOYMENT_RESERVATION_CONFLICT
{
  "code": "DEPLOYMENT_RESERVATION_CONFLICT",
  "message": "…",
  "correlationId": "01J…",
  "retryable": true,
  "details": {
    "conflictingInstances": [
      { "instanceId": "01J…", "reason": "ITEM_ALREADY_DEPLOYED" }
    ]
  }
}
```

**`retryable: true` here means "retry with a new request," not "retry the same request."**
`http-api.md` §8 caches every non-5xx response — including this 409 — under its `Idempotency-
Key`: a byte-identical (same-hash) replay of the original request returns the *stored* 409
again without re-executing anything. "Retry with the remainder" (drop the contested slot,
resubmit) is necessarily a **different** request body — fewer `instanceIds`, or a `loadoutId`
that no longer references the contested slot — and the client MUST mint a **new**
`Idempotency-Key` for it, exactly as it would for any other logically-distinct request under
`http-api.md` §8. Retrying the identical body with the identical key only ever replays the
cached 409; it is not a way to re-attempt the lock.

```jsonc
// DELETE /v1/deployments/:reservationId
// 204, no body — the reservation is `released` (reason='abort') after this call returns,
//   whether this call was the one that released it or it was already `released`/`expired`.
//   Idempotent by nature, same convention as POST /v1/rooms/:id/leave (http-api.md §6): a
//   repeat DELETE on an already-terminal reservation is success, not an error — the caller's
//   desired end state ("this reservation no longer holds anything") already holds.
// 404 NOT_FOUND — no such reservationId, or it belongs to a different account. Both collapse
//   to the same code and body so a probe cannot distinguish "doesn't exist" from "not yours"
//   (same reasoning as http-api.md §7's chatMessageId ownership check).
// 409 DEPLOYMENT_ALREADY_CONSUMED — status = 'consumed'. Not idempotent-success, because the
//   caller's desired end state does NOT already hold: the reservation produced a live run and
//   aborting it now would desync a match server that already spawned the entity. §5.4 owns
//   this reservation from here; the client's path is P3-04 settlement (extract/death/abort),
//   not this endpoint.
{
  "code": "DEPLOYMENT_ALREADY_CONSUMED",
  "message": "…",
  "correlationId": "01J…",
  "retryable": false,
  "details": {}
}
```

The signed snapshot itself (§4) is **not** returned from `POST /v1/deployments` — it does not
exist until match allocation binds a `matchId` (§4.3). It is handed to the match server
internally at handoff, alongside the session ticket (`auth.md` §6), never fetched by the client
directly; the client only ever needs the reservation to exist, not to see its signed form. §7.1
is the concrete call that phrase resolves to.

### 7.1 Internal / service endpoints

These back §4.5's "match server → platform" calls. Mirrors `http-api.md` §7's
`POST /v1/matches/:matchId/result` in shape: **S**-marked, mTLS/service-token gated, never
reachable from a browser origin (`http-api.md` §2).

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /v1/deployments/:reservationId/verify-snapshot` | **S** | Match server → platform: verify a presented snapshot and atomically consume it (§4.5 steps 3–4) |
| `POST /v1/deployments/:reservationId/release` | **S** | Match server → platform: release a reservation whose admission window elapsed without the client completing `MSG_HELLO` (§5.2, `released_reason = 'timeout'`) |

```jsonc
// POST /v1/deployments/:reservationId/verify-snapshot   [S]
// Called once per admission attempt, after the session ticket (auth.md §6) has already
// verified. :reservationId is read from the snapshot payload (§4.1) before this call, purely
// as a routing convenience — the check below re-derives matchId/accountId from the verified
// payload, not from the path segment, so a mismatched path/payload pair fails §4.5 step 3b/3c
// explicitly rather than being silently routed to the wrong reservation.
{
  "matchId": "01J…",           // this match server's own allocated matchId (§4.3)
  "accountId": "01J…",         // from the just-verified session ticket (§4.5 step 2 / 3c)
  "snapshot": {                 // the exact, unmodified payload + signature the client presented
    "payload": { /* §4.1 shape, canonical JSON */ },
    "signature": "…"
  }
}

// 200 → all four §4.5 step-3 checks passed and the snapshot is now consumed
{
  "snapshotId": "01J…",
  "reservationId": "01J…",
  "consumedAt": "2026-08-22T14:03:42.000Z",
  "correlationId": "01J…"
}

// 401 DEPLOYMENT_SNAPSHOT_INVALID → HMAC failure, unknown snapshotId, matchId mismatch,
//   accountId mismatch, already-consumed, or expired — collapsed per §4.4/§8. The match server
//   refuses the connection; it does not distinguish the sub-reason to the client either.

// 409 DEPLOYMENT_RESERVATION_EXPIRED → the snapshot itself verified (step 3 passed) but step
//   4's reservation UPDATE matched zero rows: the reservation backing this snapshot is no
//   longer `status = 'reserved'` (swept to `expired`, or released) by the time admission was
//   attempted (§4.5 step 4). The snapshot's atomic consume rolls back with the rest of the
//   transaction, so this snapshot is NOT spent — but the match server still refuses the
//   connection, because the reservation it would seed the run inventory from no longer holds
//   the lock.
```

```jsonc
// POST /v1/deployments/:reservationId/release   [S]
{ "reason": "timeout" }   // the only value this endpoint accepts — a match server has no
                          // standing to write 'abort' (player-initiated, §7's DELETE) or
                          // 'manual'/'superseded' (operator/platform-initiated, §5.3a); the
                          // caller's service identity is what makes 'timeout' the only literal
                          // this path can produce, not a value in the request the caller chose

// 204 — released now, or already released/expired (idempotent, same convention as DELETE
//        /v1/deployments/:reservationId in §7)
// 409 DEPLOYMENT_ALREADY_CONSUMED — status = 'consumed'; §4.5 already admitted this player on
//        another connection attempt racing this timeout report. Not an error the caller acts
//        on — it means admission succeeded after all.
```

## 8. New error codes (additive to `errors.md`, pending that contract's own amendment)

| Code | HTTP | Meaning | Client behavior |
|---|---:|---|---|
| `DEPLOYMENT_REQUEST_INVALID` | 400 | `POST /v1/deployments` body has both `loadoutId` and `instanceIds`, neither, or an empty `instanceIds` array (§7) | Fix the request; not retryable as-is |
| `DEPLOYMENT_RESERVATION_CONFLICT` | 409 | Aggregate: `POST /v1/deployments` failed because one or more instances could not be locked (§3). Per-instance reasons in `details.conflictingInstances[].reason`, using `items-inventory.md` §8 codes — only `ITEM_ALREADY_DEPLOYED` and `LOADOUT_ITEM_NOT_OWNED` are reachable from §2.1's reservation `UPDATE`; `ITEM_LOCKED` is that contract's §6.4 write-path code and never appears here (§3) | Drop the contested slots or retry with the remainder |
| `DEPLOYMENT_RESERVATION_EXPIRED` | 409 | `POST /v1/deployments/:reservationId/verify-snapshot` (§7.1): the snapshot itself verified, but the reservation it was issued for is no longer `status = 'reserved'` — swept to `expired` (§5.3) or otherwise released in the gap before admission landed (§4.5 step 4) | Restart the deployment flow — the snapshot was genuine, the reservation behind it is gone |
| `DEPLOYMENT_SNAPSHOT_INVALID` | 401 | Snapshot fails signature, match/account binding, or replay check (§4.4) — reasons collapsed deliberately | Return to lobby, re-deploy |
| `DEPLOYMENT_ALREADY_CONSUMED` | 409 | `DELETE /v1/deployments/:reservationId` or §7.1's `/release` targeted a reservation with `status = 'consumed'` (§5.4, §7) | Not a deployment-flow error — the run already started; use P3-04 settlement instead |

These are proposed here because P3-02's DoD requires them; landing in `errors.md`'s closed
enumeration is an additive amendment (new codes only) once this contract and
`items-inventory.md` are both past `DRAFT`. This contract deliberately does **not** duplicate
`items-inventory.md` §8's `ITEM_LOCKED` / `ITEM_ALREADY_DEPLOYED` / `LOADOUT_ITEM_NOT_OWNED` /
`LOADOUT_INVALID_SLOT` / `LOADOUT_DUPLICATE_INSTANCE` — those are that contract's codes, reused
here (except `ITEM_LOCKED`, which is not reachable through this contract's reservation path —
see the `DEPLOYMENT_RESERVATION_CONFLICT` row above): `LOADOUT_ITEM_NOT_OWNED` and `ITEM_
ALREADY_DEPLOYED` as the per-instance detail inside `DEPLOYMENT_RESERVATION_CONFLICT` (§3), and
`LOADOUT_INVALID_SLOT` / `LOADOUT_DUPLICATE_INSTANCE` as the direct response for an ad hoc
`instanceIds` request that fails §2.1's rule 2/3/5 pre-check (§2.1).

## 9. Verification — `scripts/deploytest.mjs` (to be authored with P3-12)

1. Reserving an instance already locked by a concurrent reservation attempt for the same
   account leaves exactly one `reserved` row and one `locked = true` instance set; the loser
   gets `DEPLOYMENT_RESERVATION_CONFLICT` and made zero durable state changes (§3).
2. A released reservation's instances are `locked = false, locked_by_deployment_id = null` and
   immediately re-reservable.
3. A snapshot signed for match A is rejected by a match server allocated to match B.
4. A snapshot presented twice — same process or a different one — is rejected on the second
   attempt (`consumed_at` already set), even with a byte-identical valid signature.
5. A reservation with no explicit release is `expired` and its instances unlocked within one
   sweep interval of `expires_at`, never held indefinitely.
6. A `consumed` reservation is untouched by the expiry sweep or by an abort call arriving late
   (§5.4) — its instances stay `location = 'run', locked = true` until `P3-04` settles them.
7. `durability`/`attachments`/`quantity` inside a verified snapshot match what was true of the
   instance at lock time, and cannot have changed in between because `items-inventory.md` §6.4
   rejects any write to those fields on a locked instance.
8. Two accounts racing on disjoint instances never contend on each other's locks — the `UPDATE`
   in §2.1 is scoped by `owner_account_id`.
9. At snapshot consumption (§4.5 step 4), every locked instance for the reservation moves to
   `location = 'run', run_id = matchId` in the same transaction as `consumed_at` — never a
   partial seed where some instances are `run` and others still `permanent`.
10. The expiry sweep's `UPDATE` (§5.3) succeeds against the `deployment_reservations` CHECK
    constraints — `status = 'expired', released_at = now(), released_reason = 'expiry'` on the
    same row is accepted, not rejected (§2's biconditional covers `expired`, not only
    `released`).
11. An ad hoc `instanceIds` request with two instances sharing the same `item_definitions.slot`
    is rejected `LOADOUT_DUPLICATE_INSTANCE` before §2.1's `UPDATE` runs, and one with any
    `slot = null` instance is rejected `LOADOUT_INVALID_SLOT` the same way — neither reaches the
    lock, and neither leaves a partial reservation.
12. A reservation swept to `expired` in the gap between snapshot issuance and admission is
    rejected `DEPLOYMENT_RESERVATION_EXPIRED` at `verify-snapshot` (§4.5 step 4), and the whole
    admission transaction rolls back — the snapshot's `deployment_snapshots.consumed_at` stays
    null, so this rejected attempt does not itself burn the snapshot's one-time use.
