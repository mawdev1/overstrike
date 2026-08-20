# Contract 3 — Authentication and sessions

| | |
|---|---|
| **Status** | `REVIEW` — amended per Codex review; awaiting re-sign-off |
| **Version** | 1.3.0 |
| **Owner** | [CC] Claude Code |
| **Consumers** | Client HTTP layer, lobby socket, match server, Admin Portal |

---

## 1. What this has to be true for

The G1 gate is *"a returning player signs in, and their stats are there."* That sentence is
the whole reason this contract exists, and it sets the bar: identity has to survive a browser
restart, a different device, and a hostile client, because today progression lives in
`localStorage` and is therefore a suggestion.

## 2. Provider — **DECIDED: Supabase Auth** (D1)

Managed, not self-hosted: credential handling is solved, has expensive failure modes, and
offers no product differentiation. Supabase specifically because it is Postgres-native (the
platform is on Postgres regardless), self-hostable if the managed tier stops fitting, and
priced per MAU in a way that survives a free-to-play population. Full reasoning and reversal
triggers: [`../decisions/P0-decisions.md`](../decisions/P0-decisions.md) §D1.

**The rest of this contract is provider-independent and binding regardless.** Three rules the
provider does not get to relax:

1. The access token stays out of `localStorage` (§3), whatever the provider's SDK does by
   default. Most of them default to `localStorage`; that default is wrong for a page that
   renders player-authored names and chat.
2. Refresh rotation with reuse detection (§3) is ours to verify, not assumed from the
   provider's marketing.
3. **The match-server handoff uses our own single-use tickets (§6), never provider tokens.**
   A provider outage must not be able to hand out match access, and a provider token has the
   wrong scope, the wrong lifetime, and far too much authority for a game socket.

**Reversal trigger:** if Supabase Auth cannot express immediate session revocation (§5) or
per-session device listing (§5), revisit before P1 ends. Both are G2 gate requirements, not
preferences.

## 3. Token model

Two tokens. Not one.

| | Access token | Refresh token |
|---|---|---|
| Lifetime | 15 minutes | 30 days, sliding |
| Carries | `accountId`, `sessionId`, roles, issued/expiry | Opaque handle only |
| Sent on | Every API request. **Never on a socket** — see below | Only `/v1/auth/refresh` |
| Stored | Memory. **Never** `localStorage` | httpOnly, Secure, SameSite=Lax cookie |
| Revocable | Denylist by `sessionId` until expiry | Immediately, at the row |

**Sockets take tickets, not tokens (REQ-CC-010).** This table previously said the access token
was sent on lobby-socket connect. It is not, and must not be: the lobby socket accepts only a
single-use lobby ticket (`realtime-lobby.md` §1), and the match socket only a single-use session
ticket (§6). The access token is used to *obtain* those tickets over HTTPS and never travels on
a WebSocket URL, where it would land in proxy logs, browser history, and referrer headers — and
a bearer token in a URL is a bearer token you have published.

**The access token is never written to `localStorage`.** Any XSS in a page that renders
player-authored display names or chat becomes total account takeover, and this game renders
both. Memory plus an httpOnly refresh cookie means an XSS gets at most 15 minutes and cannot
exfiltrate a durable credential.

**Refresh tokens rotate.** Each refresh issues a new one and invalidates the old. Presenting
a *used* refresh token is treated as theft: the entire session family is revoked and a
`session.reuse_detected` event is emitted. A legitimate client never replays one.

## 4. Refresh flow

```
401 AUTH_TOKEN_EXPIRED
  → POST /v1/auth/refresh   (cookie)
      200 → new access token, retry the original request ONCE
      401 → clear local state, route to sign-in
```

Rules for the client:

1. **Single-flight.** Concurrent 401s trigger exactly one refresh; the rest await it. Ten
   parallel requests must not fire ten refreshes — with rotation, nine of them are then
   replaying a used token and the family gets revoked. This is the single most likely
   implementation bug in the whole contract.
2. Retry the original request once. Never loop.
3. Only `AUTH_TOKEN_EXPIRED` triggers refresh. `AUTH_TOKEN_INVALID` and
   `AUTH_SESSION_REVOKED` go straight to sign-in.
4. Never refresh in response to a 403.

## 5. Sessions

A session is a row: `sessionId`, `accountId`, device label, user-agent class, IP class,
`createdAt`, `lastSeenAt`, `revokedAt`, `revokedReason`.

- **Revocation is immediate**, not at next expiry: the access-token denylist is checked on
  every request until the token's natural expiry passes.
- `signout-all` revokes everything including the caller.
- A revoked session drops the lobby socket with `AUTH_SESSION_REVOKED` and ends the match
  connection at the next validation, so a stolen session cannot outlive its revocation inside
  a live match.
- Concurrent sessions are allowed. **Concurrent *match* sessions for one account are not** —
  see §7.

## 6. Match server handoff

The match server must never accept an unauthenticated socket. Today it does
(`wire-protocol.md` §7 G2). The fix:

1. Client launches → platform issues a **session ticket**: single-use, 60 s TTL, scoped to
   `(accountId, roomId, matchServerId)`, signed.
2. Client presents it on match-socket connect.
3. Match server validates with the platform (**S** endpoint), receives `accountId` and the
   authoritative loadout, then creates the entity.
4. Ticket is consumed. Replay → `SESSION_TOKEN_INVALID`.

A ticket is not a bearer credential for anything else. It cannot read a profile, cannot join
another room, and expires in a minute.

## 7. Duplicate sessions and reconnect

**Rule: one live match entity per account, always.** Two entities for one account corrupts
scoring, evidence, and the result record.

| Situation | Resolution |
|---|---|
| Second connect, same account, same match | The **new** connection wins; the old is closed with `AUTH_SESSION_REPLACED`. A player whose network flapped gets in on the new socket, which is the common case |
| Second connect, same account, different match | Rejected `CONFLICT`. Leave the first match first |
| Reconnect inside the grace window | Rebind to the **existing** entity, preserving score, position, and state |
| Reconnect after the grace window | Treated as a new join, subject to the mode's backfill rule — so in Bomb, refused mid-round |

Grace window is per-mode and lives in `bomb-rules.md` / mode config, not here.

## 8. Recovery

- `recovery/start` **always** returns 202 regardless of whether the account exists. Anything
  else is an account-enumeration oracle.
- Recovery tokens: single-use, 30-minute TTL, invalidated by a password change or by a second
  recovery start.
- Completing recovery **revokes every session**. If recovery is being used because of a
  compromise, leaving the attacker's session live defeats it.
- Recovery cannot change the linked wallet, and cannot bypass a moderation hold. (Wallets
  arrive in P8; the boundary is stated now so recovery is not designed into a corner.)

## 9. Display names

| Rule | Value |
|---|---|
| Length | 3–16 characters |
| Charset | Unicode letters/digits, `_`, `-`, single interior spaces. **NFKC-normalised** |
| Uniqueness | Case-insensitive **and confusable-folded**, so `Ada`, `ada`, and `Аdа` (Cyrillic А) cannot coexist |
| Reserved | Admin/support/system terms, per a maintained list |
| Cooldown | 30 days between changes |
| History | Retained for moderation and impersonation review. Not publicly visible |
| Screening | Profanity/impersonation hook at set time, plus retroactive moderation |

Confusable folding is not optional: impersonating a known player with a homoglyph is the
cheapest social attack there is, and it lands directly on a game with a marketplace later.

## 10. Roles

`player`, `support`, `moderator`, `finance`, `developer`, `superadmin`, `service`.

- Least privilege; a role grants specific scopes, never "everything below it".
- Elevated roles require a separate authentication factor.
- Every privileged action is audited with actor, role, reason code, and correlation ID
  (`event-envelope.md`).
- **No shared admin accounts.** An audit row naming a shared login identifies nobody.
- Service tokens are per-service, mTLS-bound, and cannot be presented from a browser origin.

## 11. Age and eligibility — **WORKING DEFAULT** (D6)

**Decided as a working default to unblock schema and profile design. It is not a legal
position, and it needs professional review before P8 (commerce) and P11 (prizes).**

| Rule | Default |
|---|---|
| Minimum account age | **13** |
| Under-13 | Not eligible; no account, no data collected beyond what refusal requires |
| Cash-equivalent XO prizes | **18+**, as a separate stricter flag |
| Collection | **Neutral age gate** — a date of birth entered without the target age displayed. Never a "yes, I am over 13" checkbox, which teaches the answer |
| Re-verification | Required before any cash-equivalent payout, independent of the account flag |

**Until legal review lands, do not deepen the dependency:** no feature outside P8/P11 reads
the eligibility flag, so revising it stays a schema-and-policy change rather than a product
change. Open questions are listed in [`../decisions/P0-decisions.md`](../decisions/P0-decisions.md) §D6.

What this contract fixes regardless of where the policy lands:

- Age/eligibility is captured **before** any sensitive profile data is collected, via the
  §3a.1 preflight that evaluates a birthdate and **discards it**, persisting only the derived
  boolean and policy version —
  which means it may be read and written during account creation. The restriction in D6 is on
  the *separate prize-eligibility flag*, which stays isolated to P8/P11; the account-eligibility
  record itself is a normal part of signup and the profile.
- The eligibility record is a first-class field, not an inference from a birthdate left in a
  form.
- Cash-equivalent XO prize eligibility is a **separate, stricter** flag than account age
  eligibility, and P8/P11 read that flag rather than re-deriving it.
- The OPC position that under-13s generally cannot give valid consent alone shapes the
  default; the jurisdictions actually served determine the rest.

## 12. Verification — `scripts/authtest.mjs`

Must prove, each with its failing control case:

1. Access token expires at 15 minutes, not later.
2. Refresh rotates; a replayed refresh revokes the family and emits `session.reuse_detected`.
3. Ten concurrent 401s produce exactly **one** refresh call.
4. Revocation takes effect on the very next request, not at expiry.
5. A forged/tampered token is rejected.
6. Rate limits fire and `retryAfterMs` is honoured.
7. `recovery/start` is indistinguishable for existing and non-existent accounts — including
   in **response timing**.
8. Recovery completion revokes all sessions.
9. A second match connection for one account replaces rather than duplicates the entity.
10. A match ticket cannot be replayed, cannot be used on another room, and expires.
11. Confusable display names collide.
12. `localStorage` contains no token after a full sign-in, verified in the browser harness.
