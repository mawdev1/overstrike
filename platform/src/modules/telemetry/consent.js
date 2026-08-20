/**
 * The consent receipt.  contracts/http-api.md §3a.3, contracts/telemetry.md §3.4.
 *
 * "The response carries a signed `receipt`, without which the server cannot tell a consented
 * pre-auth batch from an unconsented one." The receipt is opaque to the client and verified
 * here on every batch that carries personal-class events.
 *
 * It is signed and SUBJECT-BOUND. An unbound receipt is a bearer token for someone else's
 * consent: lift it from one browser, replay it from another, and the second visitor's personal
 * telemetry is accepted under a decision they never made.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * @param {object} opts
 * @param {string} opts.secret   signing key; per-environment, never checked in
 * @param {{now: () => number}} [opts.clock]
 * @param {number} [opts.ttlMs]  §3a.4 stores signed-out consent with a 30-day TTL
 * @param {number} [opts.policyVersion]  the CURRENT consent policy version
 *   (`config.consentPolicyVersion`, default 1). A receipt records the version of the policy the
 *   subject actually agreed to; when the policy changes, the old agreement is not an agreement
 *   to the new one, so it must stop being accepted rather than quietly carry over.
 */
export function createConsentReceipts({
  secret, clock = Date, ttlMs = 30 * 24 * 60 * 60 * 1000, policyVersion = 1,
}) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('createConsentReceipts: a secret of at least 16 characters is required');
  }

  const sign = (body) => b64url(createHmac('sha256', secret).update(body).digest());

  /** Issued by the onboarding consent endpoint; reproduced here so telemetry is testable alone. */
  function issue({ subject, subjectId, telemetryPersonal, policyVersion: version = policyVersion }) {
    const claims = {
      subject, subjectId, telemetryPersonal, policyVersion: version,
      decidedAt: new Date(clock.now()).toISOString(),
      expiresAt: new Date(clock.now() + ttlMs).toISOString(),
    };
    const body = b64url(JSON.stringify(claims));
    return `${body}.${sign(body)}`;
  }

  /**
   * @returns {{ok: true, claims: object} | {ok: false, reason: string}}
   *
   * `expect` binds the receipt to the batch: the account when authenticated, the
   * clientSessionId when not. `clientSessionId` is non-authoritative for authorization (§3.3),
   * and it is not used as one here — it only has to match what the receipt was issued for.
   */
  function verify(receipt, expect = {}) {
    if (typeof receipt !== 'string' || !receipt.includes('.')) return { ok: false, reason: 'receipt_malformed' };
    const idx = receipt.lastIndexOf('.');
    const body = receipt.slice(0, idx);
    const mac = receipt.slice(idx + 1);

    const expected = Buffer.from(sign(body));
    const given = Buffer.from(mac);
    // Constant-time, and length-checked first because timingSafeEqual throws on a mismatch.
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return { ok: false, reason: 'receipt_signature_invalid' };
    }

    let claims;
    try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
    catch { return { ok: false, reason: 'receipt_malformed' }; }

    if (claims.telemetryPersonal !== true) return { ok: false, reason: 'consent_declined' };

    // An unparseable expiry is NaN, and every comparison with NaN is false — so the bare
    // `<= now` check made a receipt claiming `expiresAt: "soon"` (or omitting it) a receipt
    // that never expires. An expiry we cannot read is not an expiry, so the receipt fails.
    const expiresAt = Date.parse(claims.expiresAt);
    if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'receipt_expiry_invalid' };
    if (expiresAt <= clock.now()) return { ok: false, reason: 'receipt_expired' };

    // §3.4 gates personal telemetry on a decision about a specific policy. Consent to policy 1
    // is not consent to policy 2, and a signature only proves we issued the receipt — it says
    // nothing about which policy the subject was shown.
    if (claims.policyVersion !== policyVersion) {
      return { ok: false, reason: 'receipt_policy_stale' };
    }

    if (expect.accountId) {
      if (claims.subject !== 'account' || claims.subjectId !== expect.accountId) {
        return { ok: false, reason: 'receipt_subject_mismatch' };
      }
    } else if (expect.clientSessionId) {
      if (claims.subject !== 'client-session' || claims.subjectId !== expect.clientSessionId) {
        return { ok: false, reason: 'receipt_subject_mismatch' };
      }
    } else {
      // Personal events with neither an account nor a client session have nothing to bind to,
      // so there is no way to know the receipt belongs to this sender.
      return { ok: false, reason: 'receipt_unbound' };
    }

    return { ok: true, claims };
  }

  return { issue, verify };
}
