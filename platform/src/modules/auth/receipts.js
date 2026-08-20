/**
 * Signed receipts: eligibility and consent.  contracts/http-api.md §3a.1, §3a.3.
 *
 * A receipt is how a decision made at one step is proved at a later step without the later
 * step trusting the client's word for it, and without the earlier step's *input* surviving.
 * The eligibility receipt carries a verdict and a policy version. It does not carry the
 * birthdate, the computed age, or the minimum age, because a signed token is readable by
 * anyone holding it — base64 is not a privacy control.
 */
import { ApiError } from '../../core/errors.js';
import { sign, verify } from './crypto.js';
import { ulid } from '../../core/ids.js';

export const ELIGIBILITY_TTL_MS = 30 * 60 * 1000;

export function createReceipts({ config, clock }) {
  const secret = config.tokenSecret;
  const eligibilityPolicyVersion = config.eligibilityPolicyVersion ?? 1;

  return {
    eligibilityPolicyVersion,

    /**
     * Mint an eligibility receipt.
     *
     * `jurisdiction` is bound in so a receipt obtained under a permissive jurisdiction cannot
     * be presented under a stricter one; `nonce` exists so two receipts minted in the same
     * millisecond are distinguishable in a log.
     */
    issueEligibility({ verdict, jurisdiction }) {
      const issuedAt = clock.now();
      const expiresAt = issuedAt + ELIGIBILITY_TTL_MS;
      const token = sign(secret, {
        k: 'eligibility',
        v: verdict,
        pv: eligibilityPolicyVersion,
        j: jurisdiction ?? null,
        iat: issuedAt,
        exp: expiresAt,
        n: ulid(issuedAt),
      });
      return { receipt: token, expiresAt: new Date(expiresAt).toISOString(), policyVersion: eligibilityPolicyVersion };
    },

    /**
     * Consume one at signup.
     *
     * Every failure mode — forged, expired, wrong policy version, wrong kind — is the same
     * code, `ELIGIBILITY_RECEIPT_INVALID`, whose UI obligation is "restart the age gate".
     * Distinguishing them would tell a forger which part of the forgery to fix.
     */
    consumeEligibility(receipt) {
      const bad = () => new ApiError('ELIGIBILITY_RECEIPT_INVALID',
        'That age check is no longer valid. Please start again.');
      const claims = verify(secret, receipt);
      if (!claims || claims.k !== 'eligibility') throw bad();
      if (claims.pv !== eligibilityPolicyVersion) throw bad();
      if (clock.now() >= claims.exp) throw bad();
      if (claims.v !== true) {
        throw new ApiError('AUTH_ELIGIBILITY_DENIED', 'You are not eligible for an account.',
          { details: { category: 'under-minimum-age' } });
      }
      return { policyVersion: claims.pv, jurisdiction: claims.j, decidedAt: new Date(claims.iat).toISOString() };
    },

    /**
     * Consent receipt. Replayed on telemetry batches carrying personal-class events, so the
     * collector can tell a consented pre-auth batch from an unconsented one without a lookup.
     */
    issueConsent({ subject, subjectId, telemetryPersonal, policyVersion, decidedAt }) {
      return sign(secret, {
        k: 'consent',
        s: subject,            // 'account' | 'client-session'
        sid: subjectId,
        tp: !!telemetryPersonal,
        pv: policyVersion,
        dat: new Date(decidedAt).toISOString(),
      });
    },

    /** Returns the claims, or null. Callers decide which failure code fits their endpoint. */
    readConsent(receipt) {
      const claims = verify(secret, receipt);
      if (!claims || claims.k !== 'consent') return null;
      return {
        subject: claims.s,
        subjectId: claims.sid,
        telemetryPersonal: claims.tp,
        policyVersion: claims.pv,
        decidedAt: claims.dat,
      };
    },
  };
}
