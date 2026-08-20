/**
 * Transactional mail — verification and account recovery.  contracts/auth.md §3, §6.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────
 * `auth/index.js` has taken a `mailer` dependency since P1 and it was always `null`. Every send
 * site is `await mailer?.sendVerification?.(…)`, so with no mailer the optional-call chain made
 * the whole thing a silent no-op: signup minted a verification token, wrote it nowhere a player
 * could reach, and returned 201. The deployed onboarding step 5 asked for "the code from your
 * verification message" that nothing had ever sent.
 *
 * ── This module never throws ─────────────────────────────────────────────────────────────
 * Signup awaits the send AFTER its transaction commits. A mailer that threw would fail the
 * response for an account that already exists — the player sees an error, retries, and hits
 * EMAIL_TAKEN on their own account. So every failure here is caught, logged at error level with
 * the correlation id, and reported through the return value. Undeliverable mail is recoverable
 * (the player resends); a failed signup for a created account is not.
 *
 * ── Tokens are secrets ───────────────────────────────────────────────────────────────────
 * A verification or recovery token IS the credential — anyone holding it can verify the address
 * or take the account. The `log` transport prints it, which is correct for development and
 * catastrophic in production, so it REFUSES to start when `env === 'production'`. Choosing a
 * transport that writes credentials to a log aggregator has to be a decision someone makes on
 * purpose, not a default they inherit.
 */
import { ApiError } from '../../core/errors.js';

/** Providers this module can speak to. `log` is development-only and enforced as such. */
export const TRANSPORTS = Object.freeze(['log', 'resend', 'none']);

const TEXT = {
  verification: ({ link, token, appName }) => ({
    subject: `Verify your ${appName} account`,
    text: [
      `Welcome to ${appName}.`,
      '',
      'Verify this address to finish setting up your account:',
      link,
      '',
      'If the link does not work, enter this code in the app:',
      token,
      '',
      'This code expires in 24 hours. If you did not create an account, ignore this message.',
    ].join('\n'),
  }),
  recovery: ({ link, token, appName }) => ({
    subject: `Reset your ${appName} password`,
    text: [
      `Someone asked to reset the password for this ${appName} account.`,
      '',
      'If it was you, use this link:',
      link,
      '',
      'Or enter this code in the app:',
      token,
      '',
      // auth.md §6: recovery must not confirm whether an address has an account. The MESSAGE is
      // only ever sent to a real one, so it may speak plainly — it is the HTTP response that
      // stays identical either way.
      'This code expires in one hour. If it was not you, nothing has changed and you can ignore',
      'this message.',
    ].join('\n'),
  }),
};

/**
 * Resend's REST API. Chosen because it needs no dependency — one `fetch` with a bearer token —
 * and this platform builds its HTTP by hand rather than pulling in a client for every service.
 * Any provider with a JSON send endpoint fits the same shape; the transport name is the seam.
 */
async function sendViaResend({ apiKey, apiUrl, from, to, subject, text, fetchImpl }) {
  const res = await fetchImpl(apiUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  if (!res.ok) {
    // The provider's body usually says WHY (unverified sending domain, bad key). Carry it into
    // the log: "mail failed" without the reason costs an hour every time.
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch { /* body already consumed or empty */ }
    throw new Error(`resend responded ${res.status}: ${detail}`);
  }
  let id = null;
  try { id = (await res.json())?.id ?? null; } catch { /* a 2xx without a JSON body is still sent */ }
  return { id };
}

export function createMailer({ config = {}, logger = null, fetchImpl = globalThis.fetch } = {}) {
  const transport = config.mailTransport || 'none';
  if (!TRANSPORTS.includes(transport)) {
    throw new Error(`PLATFORM_MAIL_TRANSPORT must be one of ${TRANSPORTS.join(', ')}, got "${transport}"`);
  }
  // See the header: a transport that prints credentials must not be reachable by inheriting a
  // default in production.
  if (transport === 'log' && config.env === 'production') {
    throw new Error(
      'PLATFORM_MAIL_TRANSPORT=log writes verification and recovery TOKENS to the log, and those '
      + 'tokens are credentials. Refusing to start in production. Use `resend` with '
      + 'PLATFORM_MAIL_API_KEY, or `none` to disable mail deliberately.');
  }
  if (transport === 'resend' && !config.mailApiKey) {
    throw new Error('PLATFORM_MAIL_TRANSPORT=resend requires PLATFORM_MAIL_API_KEY');
  }
  if (transport !== 'none' && !config.mailFrom) {
    throw new Error(`PLATFORM_MAIL_TRANSPORT=${transport} requires PLATFORM_MAIL_FROM`);
  }

  const appName = config.appName || 'Overstrike';
  const baseUrl = String(config.publicBaseUrl || '').replace(/\/$/, '');

  /**
   * The link a player clicks. Empty when no public base URL is configured, in which case the
   * message still carries the code — a mail with a broken `undefined/onboarding/verify` link in
   * it is worse than one with no link at all.
   */
  function linkFor(kind, token) {
    if (!baseUrl) return null;
    const path = kind === 'recovery' ? '/auth/recover' : '/onboarding/verify';
    return `${baseUrl}${path}?token=${encodeURIComponent(token)}`;
  }

  async function deliver(kind, { email, token, correlationId = null }) {
    if (transport === 'none') return { delivered: false, reason: 'transport_disabled' };
    if (typeof email !== 'string' || !email) {
      logger?.error?.('mail.no_recipient', { kind, correlationId });
      return { delivered: false, reason: 'no_recipient' };
    }
    const link = linkFor(kind, token);
    const { subject, text } = TEXT[kind]({ link: link || '(open the app and enter the code)', token, appName });

    try {
      if (transport === 'log') {
        logger?.info?.('mail.log_transport', { kind, to: email, correlationId, link, token });
        return { delivered: true, transport, id: null };
      }
      const { id } = await sendViaResend({
        apiKey: config.mailApiKey,
        apiUrl: config.mailApiUrl || 'https://api.resend.com/emails',
        from: config.mailFrom, to: email, subject, text, fetchImpl,
      });
      // The RECIPIENT is logged, the token never is. An address in a log is a support tool; a
      // token in a log is a credential leak with a retention policy attached.
      logger?.info?.('mail.sent', { kind, to: email, correlationId, providerId: id });
      return { delivered: true, transport, id };
    } catch (err) {
      logger?.error?.('mail.failed', { kind, to: email, correlationId, message: err.message });
      return { delivered: false, reason: 'transport_error', message: err.message };
    }
  }

  return {
    transport,
    /** `{ email, token, correlationId }` — `accountId` is accepted and ignored. */
    sendVerification: (args) => deliver('verification', args),
    sendRecovery: (args) => deliver('recovery', args),
    /**
     * For `/v1/health/ready` to report mail as a dependency once it matters. Not wired into
     * readiness yet: a provider outage should not take the platform out of the load balancer
     * when everything except one email still works.
     */
    describe: () => ({ transport, from: config.mailFrom || null, hasKey: Boolean(config.mailApiKey) }),
  };
}

/** Thrown by the routes layer when mail is required and disabled. Kept here with its reason. */
export function mailDisabledError() {
  return new ApiError('SERVICE_UNAVAILABLE', 'Verification mail is not available right now.',
    { retryable: true });
}
