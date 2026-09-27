/**
 * P5-M06 (#85) — MailTransport: provider-neutral injected transport contract.
 *
 * DEC-0028 rev 2 (ACTIVE, decidedBy OWNER, selectedOption A-injected-transport):
 * mail transport is host IO and follows the repo's standard split —
 *
 *   PURE VALUES IN, FROZEN VALUES OUT; THE HOST DOES THE IO.
 *
 * The product ships NO SMTP client and NO mail-provider SDK. P5-M06 sends
 * recovery mail by calling an injected transport; tests inject a recording fake;
 * operators wire SMTP relays or provider-API adapters outside the product
 * bundle (at the composition root, see server.mjs). Nothing here opens a
 * socket — the two adapters shipped below are a console sink (dev default,
 * logging through the injected logger) and a recording fake (tests).
 *
 * Closed error model (mirrors the P5.1 SecurityError trick): `MailTransportError`
 * refuses any code that is not in `MAIL_TRANSPORT_REASON`, and every reason is
 * an already-published error code (contracts/errors.contract.json) — the
 * vocabulary below is a MAPPING, not a new namespace, so the error contract's
 * surface does not change and a typo in a failure path is a boot-time failure
 * instead of an unrecognised status in production.
 *
 * Zero silent failure: `send` either resolves with a frozen outcome naming every
 * accepted recipient, or throws `MailTransportError`. A partially accepted send
 * is a REFUSED failure carrying `details.rejected` — mail that did not reach
 * everyone is not a success.
 *
 * Secrets: the reset URL inside `text` IS the credential. No adapter here may
 * write it verbatim into a log or record — `redactMailSecrets` masks `token=`
 * query parameters and every log path runs the body through it.
 */
import { randomBytes } from 'node:crypto';
import { isErrorCode, statusForCode } from '../../lego/errors.mjs';

/**
 * Failure reasons, each an already-published error code. Closed on purpose:
 * a transport cannot invent a failure the callers' error model does not know.
 *
 *   INVALID_MESSAGE  contract misuse: malformed message value passed to send
 *   UNAVAILABLE      transport/provider unreachable (connection refused, down)
 *   TIMEOUT          the send exceeded its deadline
 *   REFUSED          the relay accepted the connection but refused delivery
 */
export const MAIL_TRANSPORT_REASON = Object.freeze({
  INVALID_MESSAGE: 'lego.contract_violation',
  UNAVAILABLE: 'lego.unavailable',
  TIMEOUT: 'lego.deadline_exceeded',
  REFUSED: 'lego.access_denied',
});

/**
 * Throws unless `reason` is one of the MAIL_TRANSPORT_REASON values. Used by
 * the contract test to prove the mapping still points at published codes.
 *
 * @param {string} reason
 * @returns {true}
 */
export function assertMailTransportReason(reason) {
  const known = Object.values(MAIL_TRANSPORT_REASON);
  if (!known.includes(reason)) {
    throw new TypeError(`MailTransportError: '${reason}' is not a published mail-transport reason`);
  }
  return true;
}

/** @param {unknown} error */
export function isMailTransportError(error) {
  return error instanceof MailTransportError;
}

/**
 * The transport's error type. Construction fails unless `code` is one of the
 * closed MAIL_TRANSPORT_REASON values (which are themselves published codes),
 * so the failure vocabulary cannot drift.
 */
export class MailTransportError extends Error {
  /**
   * @param {string} code one of MAIL_TRANSPORT_REASON's values
   * @param {string} message human-readable, must not contain secrets
   * @param {{ details?: object }} [options] structured, secret-free details
   */
  constructor(code, message, { details } = {}) {
    // Deliberately NOT a MailTransportError: a wrong code is a programming
    // error, and throwing the real type here would recurse into this check.
    if (!isErrorCode(code) || !Object.values(MAIL_TRANSPORT_REASON).includes(code)) {
      throw new TypeError(`MailTransportError: '${code}' is not a published mail-transport reason`);
    }
    super(message);
    this.name = 'MailTransportError';
    this.code = code;
    this.status = statusForCode(code);
    if (details !== undefined) this.details = Object.freeze({ ...details });
    Object.freeze(this);
  }
}

const TO_PATTERN = /^[^\s@]+@[^\s@]+$/;

/**
 * Validate and freeze a mail message: pure values in, frozen values out.
 * Only the provider-neutral keys survive (`to`, `subject`, `text`, optional
 * `html`) — no provider-specific field can enter the contract through here.
 *
 * @param {{ to: string, subject: string, text: string, html?: string }} message
 * @returns {Readonly<{ to: string, subject: string, text: string, html?: string }>}
 */
export function freezeMailMessage(message) {
  const bad = (why) => {
    throw new MailTransportError(MAIL_TRANSPORT_REASON.INVALID_MESSAGE, `invalid mail message: ${why}`);
  };
  if (typeof message !== 'object' || message === null) bad('not an object');
  const to = typeof message.to === 'string' ? message.to.trim() : '';
  if (!to || to.length > 254 || !TO_PATTERN.test(to)) bad('to must be a single e-mail address');
  const subject = typeof message.subject === 'string' ? message.subject.trim() : '';
  if (!subject) bad('subject must be a non-empty string');
  if (typeof message.text !== 'string' || message.text.length === 0) bad('text must be a non-empty string');
  /** @type {{ to: string, subject: string, text: string, html?: string }} */
  const frozen = { to, subject, text: message.text };
  if (message.html !== undefined) {
    if (typeof message.html !== 'string' || message.html.length === 0) bad('html must be a non-empty string when present');
    frozen.html = message.html;
  }
  return Object.freeze(frozen);
}

/**
 * Mask credential-bearing `token=` query parameters anywhere in a string.
 * Applied to every body an adapter logs. The message that goes to the transport
 * keeps the real URL — only log sinks see this view.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactMailSecrets(text) {
  return String(text).replace(/([?&](?:token|apiKey|apikey)=)[^&\s"']+/gi, '$1[REDACTED]');
}

/**
 * Throws unless `transport` satisfies the MailTransport contract (a `send`
 * function). Returns the transport for composition convenience.
 *
 * @param {{ send: (message: object) => Promise<object> }} transport
 */
export function assertMailTransport(transport) {
  if (typeof transport !== 'object' || transport === null || typeof transport.send !== 'function') {
    throw new TypeError('mail transport must be an object with a send(message) function');
  }
  return transport;
}

/**
 * Dev-default console transport: the message goes to the injected logger
 * (metadata verbatim, body only ever redacted) and nowhere else — no network,
 * no provider, no persistence. A deployment that needs real delivery injects
 * its own adapter at the composition root instead of replacing this file.
 *
 * @param {{ info: Function, warn?: Function, debug?: Function }} logger
 */
export function createConsoleMailTransport({ logger }) {
  if (!logger || typeof logger.info !== 'function') {
    throw new TypeError('console mail transport requires a logger with info()');
  }
  return Object.freeze({
    /**
     * @param {{ to: string, subject: string, text: string, html?: string }} message
     * @returns {Promise<Readonly<{ messageId: string, accepted: readonly string[] }>>}
     */
    async send(message) {
      const frozen = freezeMailMessage(message);
      const messageId = `console-${randomBytes(9).toString('base64url')}`;
      // The body is the credential carrier: only the redacted view is logged.
      logger.info('mail.console', {
        messageId,
        to: frozen.to,
        subject: frozen.subject,
        text: redactMailSecrets(frozen.text),
      });
      return Object.freeze({ messageId, accepted: Object.freeze([frozen.to]) });
    },
  });
}

/**
 * Recording fake transport for tests and CI (DEC-0028: "tests use a recording
 * fake transport"). Keeps every message in closure memory, can queue typed
 * failures, and does no IO.
 *
 * @param {{ onSend?: (message: object, outcome: object) => unknown }} [options]
 */
export function createRecordingMailTransport({ onSend } = {}) {
  /** @type {ReturnType<typeof freezeMailMessage>[]} */
  const messages = [];
  /** @type {{ code: string, message: string, details?: object }|null} */
  let nextFailure = null;
  return Object.freeze({
    /**
     * @param {{ to: string, subject: string, text: string, html?: string }} message
     * @returns {Promise<Readonly<{ messageId: string, accepted: readonly string[] }>>}
     */
    async send(message) {
      const frozen = freezeMailMessage(message);
      if (nextFailure) {
        const failure = nextFailure;
        nextFailure = null;
        throw new MailTransportError(failure.code, failure.message, { details: failure.details });
      }
      messages.push(frozen);
      const outcome = Object.freeze({
        messageId: `rec-${String(messages.length).padStart(4, '0')}`,
        accepted: Object.freeze([frozen.to]),
      });
      if (onSend) await onSend(frozen, outcome);
      return outcome;
    },
    /** Frozen snapshot of everything recorded so far. */
    messages() {
      return Object.freeze([...messages]);
    },
    /** Queue one typed failure for the next send() (single use). */
    failNext(code, message, details) {
      assertMailTransportReason(code);
      nextFailure = { code, message: String(message), details };
    },
  });
}
