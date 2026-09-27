/**
 * P5-M06 (#85) — password-recovery mail: deterministic composition + delivery
 * through the injected MailTransport (DEC-0028 rev 2, option A).
 *
 * The recovery surface itself (`POST /rest/forgot-password`, the reset-token
 * primitive and its enumeration-resistant answer) is P5-M03 work and stays in
 * account-routes.mjs. This module is only the mail half:
 *
 *   composePasswordResetMail()       pure: pinned input -> frozen message
 *   createPasswordResetDelivery()    adapter: the `delivery` port account-routes
 *                                    consumes (`{ passwordReset(input) }`)
 *
 * Composition is deterministic (same input, byte-identical message), the
 * subject is pinned to upstream's (`user-management-mailer.ts` sends
 * "n8n password reset"), and the input shape is upstream's `PasswordResetData`
 * ({ email, firstName, passwordResetUrl }) — no provider-specific field appears
 * anywhere in the pipeline.
 *
 * Failure behavior (zero silent failure): transport failures propagate as
 * `MailTransportError` with a closed code; a foreign throw is wrapped into
 * `UNAVAILABLE` so the caller's error model stays closed. The route layer's
 * fire-and-forget catch turns that into an explicit `auth.password-reset-delivery-failed`
 * warning — never a swallowed promise. Logs carry the outcome (messageId) and
 * never the message body: the reset URL IS the credential.
 */
import {
  MAIL_TRANSPORT_REASON,
  MailTransportError,
  assertMailTransport,
  freezeMailMessage,
  isMailTransportError,
} from './security/mail-transport.mjs';

/** Pinned upstream subject (reference/n8n user-management-mailer.ts `passwordReset`). */
export const PASSWORD_RESET_MAIL_SUBJECT = 'n8n password reset';

/**
 * Deterministic recovery-mail composition: pure values in, frozen values out.
 * The body carries the reset URL verbatim — it is the credential and must reach
 * the recipient — but nothing here logs or persists it.
 *
 * @param {{ email: string, firstName?: string, passwordResetUrl: string }} input
 *   upstream `PasswordResetData`
 * @returns {Readonly<{ to: string, subject: string, text: string }>}
 */
export function composePasswordResetMail(input) {
  const bad = (why) => {
    throw new MailTransportError(MAIL_TRANSPORT_REASON.INVALID_MESSAGE, `invalid password-reset mail input: ${why}`);
  };
  if (typeof input !== 'object' || input === null) bad('not an object');
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (!email) bad('email must be a non-empty string');
  const url = typeof input.passwordResetUrl === 'string' ? input.passwordResetUrl.trim() : '';
  if (!url) bad('passwordResetUrl must be a non-empty string');
  const firstName = typeof input.firstName === 'string' ? input.firstName.trim() : '';
  const name = firstName || 'there';
  // Byte-stable template: fixed lines, fixed order, no timestamps, no ids.
  const text = [
    `Hello ${name},`,
    '',
    'A password reset was requested for your n8n account.',
    'Open the link below to choose a new password:',
    '',
    url,
    '',
    'The link is valid for 20 minutes and can be used once.',
    'If you did not request this, you can ignore this email.',
  ].join('\n');
  return freezeMailMessage({ to: email, subject: PASSWORD_RESET_MAIL_SUBJECT, text });
}

/**
 * The `delivery` port for accountRoutes(): composes the recovery mail and sends
 * it through the injected transport. Rollback: drop this binding (delivery =
 * null) and the route answers with the pinned upstream "email not set up" 500
 * again — reset-token history is untouched either way.
 *
 * @param {object} options
 * @param {{ send: Function }} options.transport a MailTransport (asserted)
 * @param {{ info: Function, warn?: Function }} options.logger outcome-only logging
 */
export function createPasswordResetDelivery({ transport, logger }) {
  assertMailTransport(transport);
  if (!logger || typeof logger.info !== 'function') {
    throw new TypeError('password-reset delivery requires a logger with info()');
  }
  return Object.freeze({
    /**
     * @param {{ email: string, firstName?: string, passwordResetUrl: string }} input
     * @returns {Promise<Readonly<{ messageId: string, accepted: readonly string[] }>>}
     */
    async passwordReset(input) {
      const message = composePasswordResetMail(input);
      let outcome;
      try {
        outcome = await transport.send(message);
      } catch (error) {
        if (isMailTransportError(error)) throw error;
        // Closed model: a foreign failure is an unavailable transport. The
        // foreign message may carry provider internals — it is not copied.
        throw new MailTransportError(MAIL_TRANSPORT_REASON.UNAVAILABLE, 'mail transport failed');
      }
      // Outcome only — never the body (it carries the reset URL).
      logger.info('mail.password-reset-sent', { messageId: outcome.messageId });
      return outcome;
    },
  });
}
