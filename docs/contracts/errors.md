# Contract 2 — Error envelope

| | |
|---|---|
| **Status** | `FROZEN` — amendments follow CHANGELOG.md |
| **Version** | 1.6.0 |
| **Owner** | [CC] Claude Code |
| **Consumers** | Every platform endpoint, the lobby socket, the client HTTP layer |

---

## 1. Envelope

Every non-2xx response from the platform, and every error frame on the lobby socket, is
exactly this shape. No endpoint invents its own.

```json
{
  "error": {
    "code": "AUTH_TOKEN_EXPIRED",
    "message": "Your session expired. Sign in again.",
    "correlationId": "01J8X2K9P3QW7V…",
    "retryable": false,
    "retryAfterMs": null,
    "details": { }
  }
}
```

| Field | Rule |
|---|---|
| `code` | From the closed enumeration in §3. **The UI branches on this and never on `message`** |
| `message` | Human-readable, safe to display, never contains internal detail, stack, SQL, or a hostname |
| `correlationId` | Always present, always the same id the request carried. This is what support asks for |
| `retryable` | Whether retrying the identical request could succeed. Not a suggestion to retry — see §4 |
| `retryAfterMs` | Present when `retryable` and the server knows a delay. Null otherwise |
| `details` | Structured, per-code. Validation errors carry `fields`. Never free text the UI must parse |

## 2. Why the code is closed

An open error vocabulary means the UI eventually matches on `message`, and then a copy edit
in the backend breaks a screen in the frontend. The enumeration below is the contract; adding
a code is an additive amendment, changing what one *means* is breaking.

## 3. Codes

### Authentication and session — 401 unless noted

| Code | HTTP | Meaning | UI obligation |
|---|---:|---|---|
| `AUTH_REQUIRED` | 401 | No credentials presented | Route to sign-in |
| `AUTH_INVALID_CREDENTIALS` | 401 | Wrong identifier or secret | Generic failure. **Must not** reveal which was wrong |
| `AUTH_TOKEN_EXPIRED` | 401 | Access token past expiry | Refresh once, then sign-in. See `auth.md` §4 |
| `AUTH_TOKEN_INVALID` | 401 | Malformed, forged, or unknown token | Clear local session, sign-in |
| `AUTH_SESSION_REVOKED` | 401 | Session explicitly revoked | Sign-in, with "signed out on another device" |
| `AUTH_RATE_LIMITED` | 429 | Too many attempts | Show `retryAfterMs`. Never auto-retry auth |
| `AUTH_ACCOUNT_LOCKED` | 423 | Locked by protection or moderation | Recovery/appeal path, no retry |
| `AUTH_FORBIDDEN` | 403 | Authenticated but not permitted | No retry, no sign-in prompt |
| `AUTH_SESSION_REPLACED` | 401 | A newer connection for this account replaced this one (`auth.md` §7) | "Signed in elsewhere." **Never auto-reconnect** — the two clients would fight |
| `AUTH_VERIFICATION_REQUIRED` | 403 | Account exists but is unverified | Route to verification; `details.channel` |
| `AUTH_ELIGIBILITY_REQUIRED` | 403 | Age/eligibility record missing | Route to the age gate |
| `AUTH_ELIGIBILITY_DENIED` | 403 | Failed eligibility for this action | Terminal. `details.category` only — **never the stored birthdate** |
| `AUTH_TERMS_ACCEPTANCE_REQUIRED` | 403 | Updated terms unaccepted | Route to acceptance; `details.version` |
| `AUTH_RECOVERY_TOKEN_INVALID` | 400 | Recovery token bad, used, or superseded | Restart recovery |
| `AUTH_VERIFICATION_TOKEN_INVALID` | 400 | Verification token bad, used, or superseded | **Resend verification** — not recovery |
| `AUTH_VERIFICATION_TOKEN_EXPIRED` | 400 | Verification token past TTL | Resend verification |
| `ELIGIBILITY_RECEIPT_INVALID` | 400 | Signup receipt bad, expired, or for another policy version | Restart the age gate |
| `CONSENT_RECEIPT_INVALID` | 400 | Telemetry consent receipt absent, malformed, badly signed, expired, issued for a stale policy version, or bound to another subject | **Route to consent** (`http-api.md` §3a.3) and replace the receipt. `details.reason` narrows it. Never surfaced as a batch failure — `telemetry.md` §3.3 carries it on the 202 |
| `AUTH_RECOVERY_TOKEN_EXPIRED` | 400 | Past its 30-minute TTL | Restart recovery |

### Validation and request

| Code | HTTP | Meaning |
|---|---:|---|
| `VALIDATION_FAILED` | 400 | Body/query failed schema. `details.fields[]` gives `{ path, rule, message }` |
| `NOT_FOUND` | 404 | Subject does not exist, or is not visible to this caller |
| `CONFLICT` | 409 | State conflict; `details.reason` narrows it |
| `IDEMPOTENCY_KEY_REUSED` | 409 | Same key, different payload. See `http-api.md` §8 |
| `PAYLOAD_TOO_LARGE` | 413 | Over the endpoint limit |
| `RATE_LIMITED` | 429 | General rate limit; honour `retryAfterMs` |
| `UNSUPPORTED_CLIENT` | 426 | Client build or capability outside the D5 matrix. `details.reason` is `UnsupportedReason` (§3.1). Upgrade/unsupported message, never retry |

### Profile and identity

| Code | HTTP | Meaning |
|---|---:|---|
| `NAME_TAKEN` | 409 | Display name in use |
| `NAME_POLICY_VIOLATION` | 422 | Fails policy; `details.rule` names which |
| `NAME_CHANGE_COOLDOWN` | 429 | Too soon; `details.availableAt` |

### Lobby and match

| Code | HTTP | Meaning | UI obligation |
|---|---:|---|---|
| `ROOM_NOT_FOUND` | 404 | Gone or never existed | Return to browser, refresh |
| `ROOM_FULL` | 409 | No slot | Stay in browser, offer another room |
| `ROOM_CLOSED` | 409 | Not accepting joins | Same |
| `ROOM_IN_PROGRESS` | 409 | Live and backfill not permitted — **the normal Bomb case** | Explain rather than presenting as an error |
| `TEAM_FULL` | 409 | Requested team at capacity | Revert the optimistic switch |
| `TEAM_SWITCH_FORBIDDEN` | 403 | Balance or phase forbids it | Revert, explain |
| `SLOT_RESERVATION_EXPIRED` | 409 | Held too long before completing | Re-attempt join once, automatically |
| `NOT_IN_ROOM` | 409 | Action requires membership | Resync room state |
| `MATCH_ALLOCATION_FAILED` | 503 | No capacity in region | Retryable; offer another region |
| `MATCH_SERVER_UNREACHABLE` | 503 | Allocated but not connectable | Retryable once, then return to lobby |
| `SESSION_TOKEN_INVALID` | 401 | Handoff token bad, used, or expired | Return to lobby and re-join |
| `PROTOCOL_VERSION_MISMATCH` | 426 | Wire version disagreement | Upgrade message. **Never retry** |
| `ROOM_PASSWORD_REQUIRED` | 401 | Private room, no password given | Prompt |
| `ROOM_PASSWORD_INVALID` | 403 | Wrong password | Re-prompt. Rate-limited per room |
| `ROOM_REMOVED` | 403 | Kicked or removed by owner/moderation | Return to browser. `details.reason`, `details.until` if temporary. **No auto-rejoin** |
| `RECONNECT_GRACE_EXPIRED` | 409 | Returned after the grace window | Seat released; re-join subject to backfill rules |
| `MATCH_ABORTED` | 409 | Match ended abnormally (`match-result.md` §4) | Results screen with `details.terminationReason` |

### 3.1 `UnsupportedReason` — one enum, two consumers

Defined once here and consumed unchanged by `telemetry.md` §3.3.1 `client.unsupported.reason`.
Neither side restates it.

```
build · browser-version · os-version · webgl2 · pointer-lock
websocket-binary · memory · vram · cpu-cores · mobile-or-tablet
```

`build` is in the set because the build floor is a real failure mode with its own error branch;
it was previously in the error's list and missing from the event's, so the one failure the
server rejects most often could not be measured (REQ-CC-032).

### Reconnect and session codes — required `details`

These carry the destination the client must act on, so the UI never has to guess:

```json
{ "code": "RECONNECT_GRACE_EXPIRED",
  "details": { "graceEndsAt": "…", "roomId": "…", "rejoinable": false, "reason": "grace-expired" } }
```

`AUTH_SESSION_REPLACED` carries `{ "replacedAt": "…", "byDeviceLabel": "…" }`. It is the one
auth code that must **never** trigger an automatic reconnect: the replacement is authoritative,
and retrying produces two clients taking the session from each other in a loop.

### Moderation and safety

| Code | HTTP | Meaning |
|---|---:|---|
| `SANCTIONED` | 403 | Restricted by a sanction; `details.sanction` gives kind, expiry, appeal path |
| `CHAT_RATE_LIMITED` | 429 | Message rate exceeded |
| `CHAT_BLOCKED` | 403 | Chat withdrawn by sanction |
| `REPORT_DUPLICATE` | 409 | Already reported this subject for this incident |

### Platform

| Code | HTTP | Meaning | UI obligation |
|---|---:|---|---|
| `INTERNAL_ERROR` | 500 | Unhandled. **Never leaks detail** | Generic message **plus the correlation ID** |
| `SERVICE_UNAVAILABLE` | 503 | Dependency down or shedding load | Retryable with backoff |
| `MAINTENANCE` | 503 | Planned; `details.until` | Maintenance screen, no retry storm |
| `FEATURE_DISABLED` | 403 | Kill switch off. See `feature-flags.md` | Explain unavailability. **Not** an error state |

## 4. Retry rules

`retryable: true` means retrying *could* succeed. It does not license a retry loop.

1. Never auto-retry a non-idempotent request without an idempotency key (`http-api.md` §8).
2. Never auto-retry any `AUTH_*` code except one refresh on `AUTH_TOKEN_EXPIRED`.
3. Never retry `PROTOCOL_VERSION_MISMATCH`, `UNSUPPORTED_CLIENT`, or `MAINTENANCE`.
4. Honour `retryAfterMs` exactly; if absent, exponential backoff from 500 ms, cap 30 s,
   with jitter — a synchronised retry storm after an outage is a second outage.
5. Cap automatic attempts at 3, then surface it. A silent forever-retry reads to the player
   as a frozen game.

## 5. Server obligations

- Log every error with its correlation ID, code, route, actor, and cause. The cause stays in
  the log; the response carries only the envelope.
- `INTERNAL_ERROR` never carries a stack, SQL fragment, hostname, dependency name, or raw
  exception message — in any environment, because environments get misconfigured.
- Emit `correlationId` on **success** responses too, so a support ticket about a request that
  "worked but did the wrong thing" is traceable.
- An error path that cannot produce a correlation ID is a bug in the middleware, not an
  acceptable degradation.
