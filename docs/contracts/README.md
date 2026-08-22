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
| 1 | [`http-api.md`](http-api.md) | FROZEN 2.1.0 | Platform REST surface for P1–P4 |
| 2 | [`errors.md`](errors.md) | FROZEN 1.8.0 | Error envelope and the closed error-code enumeration |
| 3 | [`auth.md`](auth.md) | FROZEN 1.7.0 | Tokens, sessions, revocation, recovery |
| 4 | [`realtime-lobby.md`](realtime-lobby.md) | FROZEN 1.11.0 | Lobby WebSocket: presence, roster, teams, ready, launch |
| 5 | [`wire-protocol.md`](wire-protocol.md) | FROZEN 1.10.0 | The binary match protocol, as it exists and as it must change |
| 6 | [`net-facade.md`](net-facade.md) | FROZEN 1.11.0 | The only surface Codex uses to reach netcode |
| 7 | [`match-result.md`](match-result.md) | FROZEN 2.0.0 | Canonical stat definitions and the immutable result record |
| 8 | [`event-envelope.md`](event-envelope.md) | FROZEN 1.4.0 | Canonical platform event envelope and catalogue |
| 9 | [`map-data.md`](map-data.md) | FROZEN 1.2.0 | What `level.js` must export for the server to consume |
| 10 | [`bomb-rules.md`](bomb-rules.md) | FROZEN 1.7.0 | The Bomb ruleset |
| 11 | [`db-schema.md`](db-schema.md) | FROZEN 2.1.0 | Initial PostgreSQL schema |
| 12 | [`telemetry.md`](telemetry.md) | FROZEN 2.1.0 | Client and server telemetry, privacy and retention classes |
| 13 | [`feature-flags.md`](feature-flags.md) | FROZEN 1.1.0 | Flag naming, evaluation, defaults, kill switches |

**All 13 contracts are FROZEN; their current individual versions are authoritative in the
index above.** The initial freeze occurred on 2026-08-20 and later additive amendments have
advanced individual versions. Frozen means buildable and stable, not immutable: additive
amendments bump the minor version, while breaking changes need a CCR and a dual-support
window. [`CHANGELOG.md`](CHANGELOG.md) records the exact provenance.

One caveat carried forward: `auth.md` §11 (age and eligibility) is a **working default**, not a
legal position, and needs professional review before P8 and P11. Nothing outside those phases
should read the eligibility flag.

## Reading order

- **Codex, first session:** `net-facade.md` → `errors.md` → `http-api.md` → `realtime-lobby.md` → `map-data.md`.
- **Claude Code, first session:** `db-schema.md` → `auth.md` → `event-envelope.md` → `match-result.md`.
