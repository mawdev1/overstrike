/**
 * Account-scoped stub state.  contracts/http-api.md §3, §11.10; contracts/auth.md §3.
 *
 * Scenario state is keyed per `clientSessionId` (§11.10), which is right for a *timeline* and
 * wrong for an *account*: two browser tabs signed into one account are two client sessions, so
 * everything account-shaped lived twice. A session revoked in tab A was still live in tab B,
 * `signout-all` signed out one tab, and the session list in each tab described a different
 * account. Cross-tab revocation is a designed shell state (`design/shell-ia.md` `/sessions`
 * terminal/policy row), and it was unreachable.
 *
 * So there are two scopes now:
 *
 *   - **session scope** (`scenarios.js` `initialState`) — the timeline: which step of onboarding
 *     this tab is on, which rooms it has touched, how many times it has polled.
 *   - **account scope** (here) — what every tab of one signed-in account shares: the session
 *     list, revocations, and the access tokens the layer has actually issued.
 *
 * ── Why the account key is declared rather than inferred ────────────────────────────────────
 * Every scenario seeds the SAME fixture account, so the layer cannot tell "two tabs of one
 * account" from "two unrelated replays of one scenario" by looking at the requests. If it
 * guessed *shared*, replaying a scenario in a live process would inherit the previous replay's
 * revocations and stop being byte-identical — the determinism guarantee §11.10 exists for.
 *
 * The client therefore declares it: `X-Stub-Account-Id` groups client sessions into one account.
 * Absent, it falls back to the client session id, so one tab is one account and a fresh replay
 * is genuinely fresh. Two tabs that want to be one account send the same value.
 */
import { stubUlid } from './ids.js';
import { EPOCH_MS } from './clock.js';
import * as fx from './fixtures.js';

/**
 * Session ids, by the order a tab first appears.
 *
 * Position-derived, never derived from the client session id: a session id that varied with the
 * key would make two fresh replays differ in every auth response. The first two positions are
 * the fixture sessions `GET /v1/auth/sessions` already lists, so the id signin hands back is
 * one the session list actually contains — it previously was not, which made "revoke the
 * session I am using" unexpressible.
 */
const TAB_SESSION_IDS = [fx.CURRENT_SESSION_ID, fx.OTHER_SESSION_ID];

const sessionIdForPosition = (i) => TAB_SESSION_IDS[i]
  ?? stubUlid(`session:tab:${i}`, EPOCH_MS - 3600 * 1000);

export function createAccountState() {
  return {
    /** Client-session keys in first-seen order. The index picks the session id. */
    tabs: [],
    /** Session ids revoked by any tab, plus everything `signout-all` swept. */
    revokedSessions: [],
    /**
     * Every access token this layer minted, and which session it belongs to.
     *
     * This is what makes a forged bearer token fail: production rejects a token it never signed,
     * and a stub that accepts any well-shaped string teaches the shell that its "clear the
     * session and sign in" path is dead code.
     */
    tokens: new Map(),
  };
}

/** The session id for this tab, registering it on first sight. */
export function sessionIdFor(account, tabKey) {
  let index = account.tabs.indexOf(tabKey);
  if (index === -1) { account.tabs.push(tabKey); index = account.tabs.length - 1; }
  return sessionIdForPosition(index);
}

/** Record a token this layer issued, bound to the session that will carry it. */
export function issueToken(account, token, sessionId) {
  account.tokens.set(token, { sessionId });
  return token;
}

/** What we know about a presented token, or null when we never minted it. */
export const tokenClaims = (account, token) => account.tokens.get(token) || null;

export const isRevoked = (account, sessionId) => account.revokedSessions.includes(sessionId);

export function revokeSession(account, sessionId) {
  if (!account.revokedSessions.includes(sessionId)) account.revokedSessions.push(sessionId);
}

/**
 * §3: `signout-all` "Revokes every session including the caller's".
 *
 * Every session the account is known to have — the fixture list and every tab that has signed
 * in — so the tab that pressed the button is signed out along with the others. Revoking all but
 * the caller is a different endpoint.
 */
export function revokeAll(account) {
  for (const s of fx.sessionsList()) revokeSession(account, s.sessionId);
  for (let i = 0; i < account.tabs.length; i++) revokeSession(account, sessionIdForPosition(i));
}

/** §11.8 `GET /v1/auth/sessions`, with `isCurrent` resolved against the calling tab. */
export function sessionList(account, mySessionId) {
  return fx.sessionsList()
    .filter((s) => !isRevoked(account, s.sessionId))
    .map((s) => ({ ...s, isCurrent: s.sessionId === mySessionId }));
}

export { sessionIdForPosition };
