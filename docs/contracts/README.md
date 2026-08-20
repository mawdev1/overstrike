# Overstrike contracts

Every interface the two engineering lanes build against. Authored by **[CC] Claude Code**;
reviewed by **[CX] Codex** before anything is marked `FROZEN`.

**Why this directory exists.** Claude Code and Codex work this repository at the same time.
Neither may build against an interface that is not written down here first, because the
alternative — inferring the other lane's shape from its code — is how two agents produce a
system that compiles and does not work.

## Status vocabulary

| Status | Meaning |
|---|---|
| `DRAFT` | Being written. Nobody builds against it |
| `REVIEW` | Complete and awaiting Codex sufficiency sign-off and/or a human decision |
| `FROZEN` | Signed off. Build against it. Changes now follow the amendment rules below |
| `SUPERSEDED` | Replaced; the header names the replacement |

A contract in `REVIEW` that is blocked on a human decision names the decision in its header
and marks the affected sections `PENDING DECISION`. Everything *not* pending is still
buildable — a single open question does not freeze a whole document.

## Amendment rules (Build Plan §0.6)

- **Additive** (new optional field, new endpoint, new event type): allowed. Bump the minor
  version, add a `CHANGELOG.md` line, mention it in the request channel. No coordination stop.
- **Breaking** (removed/renamed field, changed type, changed semantics): a `CCR` entry in
  `CHANGELOG.md`, human owner approval, a major version bump, and a dual-support window of at
  least one phase where both shapes are accepted.
- **Wire protocol**: every change bumps `PROTOCOL_VERSION`. Enforced by `scripts/lanecheck.mjs`.

## Index

| # | Contract | Status | Covers |
|---|---|---|---|
| 1 | [`http-api.md`](http-api.md) | FROZEN | Platform REST surface for P1–P4 |
| 2 | [`errors.md`](errors.md) | FROZEN | Error envelope and the closed error-code enumeration |
| 3 | [`auth.md`](auth.md) | FROZEN | Tokens, sessions, revocation, recovery |
| 4 | [`realtime-lobby.md`](realtime-lobby.md) | FROZEN | Lobby WebSocket: presence, roster, teams, ready, launch |
| 5 | [`wire-protocol.md`](wire-protocol.md) | FROZEN | The binary match protocol, as it exists and as it must change |
| 6 | [`net-facade.md`](net-facade.md) | FROZEN | The only surface Codex uses to reach netcode |
| 7 | [`match-result.md`](match-result.md) | FROZEN | Canonical stat definitions and the immutable result record |
| 8 | [`event-envelope.md`](event-envelope.md) | FROZEN | Canonical platform event envelope and catalogue |
| 9 | [`map-data.md`](map-data.md) | FROZEN | What `level.js` must export for the server to consume |
| 10 | [`bomb-rules.md`](bomb-rules.md) | FROZEN | The Bomb ruleset |
| 11 | [`db-schema.md`](db-schema.md) | FROZEN | Initial PostgreSQL schema |
| 12 | [`telemetry.md`](telemetry.md) | FROZEN 1.8.0 | Client and server telemetry, privacy and retention classes |
| 13 | [`feature-flags.md`](feature-flags.md) | FROZEN | Flag naming, evaluation, defaults, kill switches |

**All 13 contracts are FROZEN at 1.7.0** (2026-08-20), on the human owner's instruction to
proceed without a further review round. Frozen means buildable and stable, not immutable:
additive amendments bump the minor version, breaking ones need a CCR and a dual-support
window. `REQ-CC-042`…`053` remain open and will land as ordinary amendments — see
[`CHANGELOG.md`](CHANGELOG.md) for what is known-open and how severe each is.

One caveat carried forward: `auth.md` §11 (age and eligibility) is a **working default**, not a
legal position, and needs professional review before P8 and P11. Nothing outside those phases
should read the eligibility flag.

## Reading order

- **Codex, first session:** `net-facade.md` → `errors.md` → `http-api.md` → `realtime-lobby.md` → `map-data.md`.
- **Claude Code, first session:** `db-schema.md` → `auth.md` → `event-envelope.md` → `match-result.md`.
