/**
 * P5.6 — multi-factor authentication: TOTP, recovery codes, state machine.
 *
 * COMPATIBILITY WITH THE PINNED n8n REFERENCE
 *   - TOTP per RFC 6238 with the `otpauth` defaults upstream uses: HMAC-SHA1,
 *     6 digits, 30 s period, 20-byte secret, RFC 4648 base32 (no padding).
 *     Any authenticator app enrolled against upstream n8n works here.
 *   - `otpauth://` URI in the exact `OTPAuth.TOTP#toString()` layout.
 *   - verification windows: ±2 steps for login/verify/disable, ±10 when
 *     enabling (upstream `verifySecret({ window: 10 })`, tolerating a slow
 *     first scan).
 *   - ten recovery codes, each a v4 UUID (upstream `generateRecoveryCodes`).
 *
 * STRONGER THAN UPSTREAM, ON PURPOSE (each is a subset of what upstream
 * accepts, so no legitimate flow breaks):
 *   - TOTP REPLAY: the last accepted time step is stored and a code for that
 *     step or an earlier one is refused. Upstream accepts the same code again
 *     for its whole window.
 *   - RECOVERY CODES are stored as SHA-256 digests once MFA is enabled, not as
 *     reversible ciphertext, and a code is removed the moment it is accepted.
 *     Replaying a recovery code fails.
 *   - The TOTP secret is sealed with the P5.5 credential vault (authenticated
 *     envelope, key lineage, rotation) — not a second crypto stack.
 *
 * STATE MACHINE (the only legal transitions):
 *
 *     disabled --setup--> pending --setup--> pending   (same secret re-shown)
 *     pending  --enable--> enabled                     (valid TOTP proven)
 *     enabled  --disable--> disabled                   (TOTP or recovery code)
 *     pending  --disable--> disabled                   (abandon enrolment)
 *
 * Anything else throws. `enabled --setup` is refused so a stolen session cannot
 * silently re-enrol a new authenticator over the victim's.
 */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { SecurityError, SECURITY_REASON } from './security-error.mjs';

export const TOTP = Object.freeze({ digits: 6, periodSeconds: 30, secretBytes: 20, algorithm: 'SHA1', issuer: 'n8n' });

/** Verification windows (in time steps either side), upstream values. */
export const TOTP_WINDOW = Object.freeze({ standard: 2, enrolment: 10, max: 10 });

export const RECOVERY_CODE_COUNT = 10;

export const MFA_STATES = Object.freeze({ DISABLED: 'disabled', PENDING: 'pending', ENABLED: 'enabled' });

export const MFA_EVENTS = Object.freeze({ SETUP: 'setup', ENABLE: 'enable', DISABLE: 'disable' });

/** Record type used as the AAD `type` when the vault seals an MFA secret. */
export const MFA_SECRET_TYPE = 'n8n-lego/mfa-totp';

const TRANSITIONS = Object.freeze({
  [MFA_STATES.DISABLED]: Object.freeze({ [MFA_EVENTS.SETUP]: MFA_STATES.PENDING }),
  [MFA_STATES.PENDING]: Object.freeze({
    [MFA_EVENTS.SETUP]: MFA_STATES.PENDING,
    [MFA_EVENTS.ENABLE]: MFA_STATES.ENABLED,
    [MFA_EVENTS.DISABLE]: MFA_STATES.DISABLED,
  }),
  [MFA_STATES.ENABLED]: Object.freeze({ [MFA_EVENTS.DISABLE]: MFA_STATES.DISABLED }),
});

/** Next state, or throws `invalid-transition`. */
export function mfaTransition(state, event) {
  const next = TRANSITIONS[state]?.[event];
  if (!next) {
    throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, `MFA cannot '${event}' from '${state}'`, {
      details: { reason: 'invalid-transition', state: String(state), event: String(event) },
    });
  }
  return next;
}

/** The MFA state of a stored user (absent => disabled). */
export function mfaStateOf(user) {
  const state = user?.mfa?.state;
  return state === MFA_STATES.PENDING || state === MFA_STATES.ENABLED ? state : MFA_STATES.DISABLED;
}

/* ------------------------------------------------------------------ base32 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Tolerates lower case, spaces and '=' padding (what users paste). Throws on anything else. */
export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=]/g, '');
  if (clean.length === 0 || clean.length > 128) throw new TypeError('base32 secret has a bad length');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new TypeError('base32 secret has an invalid character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/* -------------------------------------------------------------------- TOTP */

export function generateTotpSecret() {
  return base32Encode(randomBytes(TOTP.secretBytes));
}

/** HOTP (RFC 4226) for one counter value. */
export function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 10 ** TOTP.digits).padStart(TOTP.digits, '0');
}

export const timeStep = (now = Date.now()) => Math.floor(now / 1000 / TOTP.periodSeconds);

/** The code for `now` (used by tests and the operator self-check; never logged). */
export function totpAt(secretBase32, now = Date.now()) {
  return hotp(secretBase32, timeStep(now));
}

/**
 * Verify a TOTP code with a bounded window and replay protection.
 *
 * Every step in the window is computed and compared in constant time, and the
 * loop never exits early, so the position of a match does not leak through
 * timing.
 *
 * @param {string} secretBase32
 * @param {unknown} code
 * @param {object} [options]
 * @param {number} [options.window] steps either side (0..TOTP_WINDOW.max)
 * @param {number|null} [options.lastUsedStep] refuse this step and earlier
 * @param {number} [options.now]
 * @returns {{ ok: boolean, step: number|null, reason: string|null }}
 */
export function verifyTotp(secretBase32, code, { window = TOTP_WINDOW.standard, lastUsedStep = null, now = Date.now() } = {}) {
  if (!Number.isInteger(window) || window < 0 || window > TOTP_WINDOW.max) throw new TypeError('TOTP window out of bounds');
  const presented = typeof code === 'string' ? code.replace(/\s/g, '') : typeof code === 'number' ? String(code) : '';
  if (!/^\d{6}$/.test(presented)) return { ok: false, step: null, reason: 'malformed' };
  const current = timeStep(now);
  const presentedBuffer = Buffer.from(presented);
  let matched = null;
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    if (step < 0) continue;
    const expected = Buffer.from(hotp(secretBase32, step));
    if (timingSafeEqual(expected, presentedBuffer) && matched === null) matched = step;
  }
  if (matched === null) return { ok: false, step: null, reason: 'mismatch' };
  if (Number.isInteger(lastUsedStep) && matched <= lastUsedStep) return { ok: false, step: matched, reason: 'replay' };
  return { ok: true, step: matched, reason: null };
}

/** `OTPAuth.TOTP#toString()` layout, which upstream returns as `qrCode`. */
export function totpUri({ secret, label, issuer = TOTP.issuer }) {
  const e = encodeURIComponent;
  return (
    `otpauth://totp/${e(issuer)}:${e(label)}?issuer=${e(issuer)}&secret=${e(secret)}` +
    `&algorithm=${TOTP.algorithm}&digits=${TOTP.digits}&period=${TOTP.periodSeconds}`
  );
}

/* ---------------------------------------------------------- recovery codes */

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  return Array.from({ length: count }, () => randomUUID());
}

/** Digest of a recovery code. Codes carry 122 random bits, so a plain SHA-256 suffices. */
export function hashRecoveryCode(code) {
  return createHash('sha256').update(String(code).trim().toLowerCase()).digest('base64url');
}

/**
 * Check a presented recovery code against stored digests. Constant-time per
 * comparison and it always walks the whole list.
 *
 * @returns {{ ok: boolean, remaining: string[] }} `remaining` omits the used code
 */
export function consumeRecoveryCode(digests, code) {
  const list = Array.isArray(digests) ? digests : [];
  if (typeof code !== 'string' || code.trim() === '' || code.length > 64) return { ok: false, remaining: list };
  const presented = Buffer.from(hashRecoveryCode(code));
  let index = -1;
  for (let i = 0; i < list.length; i += 1) {
    const stored = Buffer.from(String(list[i]));
    if (stored.length === presented.length && timingSafeEqual(stored, presented) && index === -1) index = i;
  }
  if (index === -1) return { ok: false, remaining: list };
  return { ok: true, remaining: list.filter((_, i) => i !== index) };
}

/* ----------------------------------------------------- vault integration */

/** The vault binding for a user's MFA secret: AAD pins tenant, user and purpose. */
export function mfaSecretRecord(user) {
  return {
    id: `user:${user.id}`,
    tenantId: typeof user.tenantId === 'string' && user.tenantId !== '' ? user.tenantId : 'default',
    type: MFA_SECRET_TYPE,
    secret: user.mfa?.secret,
  };
}

/**
 * A collection-shaped VIEW over the users collection that exposes each sealed
 * MFA secret as a vault record. Handing this to the vault's rotate / recover /
 * verify alongside the credentials collection keeps MFA secrets on the SAME key
 * lineage — so retiring a key after rotation can never strand an authenticator.
 *
 * `update` maps a vault transform back onto `user.mfa.secret` and touches
 * nothing else on the user.
 */
export function mfaSecretCollection(users) {
  const prefix = 'user:';
  return {
    all() {
      return users
        .all()
        .filter((user) => user?.mfa?.secret !== undefined && user?.mfa?.secret !== null)
        .map((user) => mfaSecretRecord(user));
    },
    update(id, transform) {
      if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
      return users.update(id.slice(prefix.length), (user) => {
        const next = transform(mfaSecretRecord(user));
        return { ...user, mfa: { ...user.mfa, secret: next.secret } };
      });
    },
  };
}
