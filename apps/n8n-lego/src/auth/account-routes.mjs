/**
 * AUTH LEGO — account security routes (P5.6).
 *
 * Password change, password recovery, MFA enrolment/disable and the login
 * second factor, on the upstream n8n wire contract (paths, bodies, status codes
 * and messages from the pinned reference controllers: `me.controller`,
 * `password-reset.controller`, `mfa.controller`, `auth.controller`).
 *
 * The security primitives live in `auth/security/` and are HTTP-free; this
 * module is only the boundary that maps them onto requests:
 *
 *   abuse-control.mjs   bounded rate limits + failure back-off
 *   password-hash.mjs   scrypt agility, upstream password policy
 *   reset-token.mjs     single-use, bounded, fingerprint-bound reset tokens
 *   mfa.mjs             TOTP / recovery codes / MFA state machine
 *   step-up.mjs         declared auth strength per sensitive operation
 *   credential-vault    seals the TOTP secret (P5.5 key lineage)
 *
 * Every authority change (password, e-mail, MFA on/off, reset) advances the
 * user's security version, which kills every existing session, and then issues
 * one fresh session to the caller — the upstream behaviour (its JWT hash covers
 * email+password+MFA) made explicit and revocable.
 */
import { HttpError, badRequest, forbidden, notFound, unauthorized } from '../compat/error.mjs';
import { sendData } from '../compat/response.mjs';
import { publicUser, requireUser } from '../compat/auth-context.mjs';
import {
  authenticate,
  bumpSecurityVersion,
  createSession,
  currentSession,
  hashPassword,
  verifyPassword,
} from '../auth.mjs';
import { ABUSE_POLICY, RATE_LIMIT_MESSAGE, abuseKey, createFailureBackoff, createRateLimiter } from './security/abuse-control.mjs';
import { passwordPolicyViolation } from './security/password-hash.mjs';
import { RESET_TOKEN_VERDICT, createResetTokenStore, credentialFingerprint } from './security/reset-token.mjs';
import {
  MFA_EVENTS,
  MFA_STATES,
  TOTP_WINDOW,
  consumeRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  mfaSecretRecord,
  mfaStateOf,
  mfaTransition,
  totpUri,
  verifyTotp,
} from './security/mfa.mjs';
import { PROOF, evaluateStepUp } from './security/step-up.mjs';

/** Upstream `AuthError('MFA Error', 998)`: the editor shows the code prompt on this. */
export const MFA_REQUIRED_CODE = 998;
/** Upstream `BadRequestError('MFA code expired…', 997)`. */
export const MFA_EXPIRED_CODE = 997;

/**
 * Process-local account-security state: limiters, back-off, reset tokens.
 * Every structure is bounded (see abuse-control.mjs / reset-token.mjs).
 */
export function createAccountSecurity({ resetTtlMs, maxKeys = ABUSE_POLICY.maxKeys } = {}) {
  const limiter = (policy) => createRateLimiter({ ...policy, maxKeys });
  return {
    limits: {
      loginIp: limiter(ABUSE_POLICY.loginIp),
      loginAccount: limiter(ABUSE_POLICY.loginAccount),
      forgotIp: limiter(ABUSE_POLICY.forgotIp),
      forgotAccount: limiter(ABUSE_POLICY.forgotAccount),
      resetIp: limiter(ABUSE_POLICY.resetIp),
      userAction: limiter(ABUSE_POLICY.userAction),
    },
    backoff: createFailureBackoff({ maxKeys }),
    resetTokens: createResetTokenStore(resetTtlMs ? { ttlMs: resetTtlMs } : {}),
  };
}

/* ----------------------------------------------------------------- helpers */

/**
 * The peer address. Deliberately NOT `X-Forwarded-For`: this server has no
 * trusted-proxy configuration, and a spoofable header would let a client pick
 * a fresh rate-limit key per request.
 */
export function clientIp(req) {
  return req?.socket?.remoteAddress ?? 'unknown';
}

function throttle(limiter, key) {
  if (!limiter.hit(key).allowed) throw new HttpError(429, RATE_LIMIT_MESSAGE);
}

function stepUpOrThrow(operation, input, message) {
  const verdict = evaluateStepUp(operation, input);
  if (!verdict.ok) throw forbidden(message ?? 'Additional authentication is required for this operation');
  return verdict;
}

function requireVault(vault) {
  // Fail closed: without the vault an MFA secret can be neither sealed nor
  // opened, so nothing MFA-related may proceed (and no plaintext fallback).
  if (!vault) throw new HttpError(503, 'Credential vault unavailable', { code: 'lego.unavailable' });
  return vault;
}

/** Open the sealed MFA material of a user: `{ totp, recoveryCodes? }`. */
function openMfa(vault, user) {
  if (!user?.mfa?.secret) return null;
  try {
    return requireVault(vault).open(mfaSecretRecord(user));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'Two-factor secret unavailable', { code: 'lego.unavailable' });
  }
}

function sealMfa(vault, user, material) {
  return requireVault(vault).sealSecret(mfaSecretRecord(user), material);
}

/**
 * Check a TOTP for a user and, on success, record the step so the same code
 * cannot be used again (replay). Returns true/false; never throws on a wrong code.
 */
function acceptTotp(ctx, vault, user, code, { window = TOTP_WINDOW.standard, record = true } = {}) {
  const material = openMfa(vault, user);
  if (!material?.totp) return false;
  const verdict = verifyTotp(material.totp, code, { window, lastUsedStep: user.mfa?.lastUsedStep ?? null });
  if (!verdict.ok) return false;
  if (record) {
    ctx.store.users.update(user.id, (current) => ({ ...current, mfa: { ...current.mfa, lastUsedStep: verdict.step } }));
  }
  return true;
}

/** Consume a recovery code (enabled: stored digests; pending: sealed plaintext). */
function acceptRecoveryCode(ctx, vault, user, code) {
  const state = mfaStateOf(user);
  if (state === MFA_STATES.ENABLED) {
    const { ok, remaining } = consumeRecoveryCode(user.mfa?.recoveryCodes, code);
    if (!ok) return false;
    // Persist the removal BEFORE granting anything: a replay finds it gone.
    ctx.store.users.update(user.id, (current) => ({ ...current, mfa: { ...current.mfa, recoveryCodes: remaining } }));
    return true;
  }
  if (state === MFA_STATES.PENDING) {
    const material = openMfa(vault, user);
    return consumeRecoveryCode((material?.recoveryCodes ?? []).map(hashRecoveryCode), code).ok;
  }
  return false;
}

/**
 * Kill every session of the user (security version bump), then issue ONE new
 * session for the caller. Returns the Set-Cookie headers.
 */
function reissueSession(ctx, user, authStrength) {
  bumpSecurityVersion(user.id);
  const { cookie, csrfCookie } = createSession(user, ctx.config, { authStrength });
  return [cookie, csrfCookie];
}

function sessionOf(ctx) {
  return currentSession(ctx.config, ctx.req) ?? { authStrength: 'none' };
}

/* ------------------------------------------------------------------- login */

/**
 * `POST /rest/login` with abuse controls and the second factor.
 *
 * Order matches upstream `auth.controller.login`: rate limits, password, then
 * MFA (998 when enrolled and no code given). Unknown accounts and wrong
 * passwords get the same answer, the same scrypt cost and the same counters.
 */
export function login(ctx, { security, vault }) {
  const { email, emailOrLdapLoginId, password, mfaCode, mfaRecoveryCode } = ctx.body ?? {};
  throttle(security.limits.loginIp, abuseKey('ip', clientIp(ctx.req), ctx.config.secret));
  const identifier = email ?? emailOrLdapLoginId;
  if (!identifier || !password) throw badRequest('Email and password are required');
  const accountKey = abuseKey('login-account', identifier, ctx.config.secret);
  throttle(security.limits.loginAccount, accountKey);
  if (security.backoff.check(accountKey).locked) throw new HttpError(429, RATE_LIMIT_MESSAGE);

  const user = authenticate(ctx.store, identifier, password);
  if (!user) {
    security.backoff.recordFailure(accountKey);
    throw unauthorized();
  }
  const enrolled = mfaStateOf(user) === MFA_STATES.ENABLED;
  if (enrolled) {
    if (!mfaCode && !mfaRecoveryCode) throw new HttpError(401, 'MFA Error', { code: MFA_REQUIRED_CODE });
    const ok = mfaCode ? acceptTotp(ctx, vault, user, mfaCode) : acceptRecoveryCode(ctx, vault, user, mfaRecoveryCode);
    if (!ok) {
      security.backoff.recordFailure(accountKey);
      throw new HttpError(401, 'Invalid mfa token or recovery code');
    }
  }
  security.backoff.recordSuccess(accountKey);
  const fresh = ctx.store.users.get(user.id) ?? user;
  const { cookie, csrfCookie } = createSession(fresh, ctx.config, { authStrength: enrolled ? 'mfa' : 'password' });
  sendData(ctx.res, publicUser(fresh, ctx.config, { mfaAuthenticated: enrolled }), {
    headers: { 'set-cookie': [cookie, csrfCookie] },
  });
}

/* ----------------------------------------------------------- e-mail change */

/**
 * Guard for `PATCH /rest/me` when the e-mail changes — upstream
 * `me.controller.validateChangingUserEmail`. Before P5.6 the e-mail could be
 * changed with the session alone, which turns a stolen session into a full
 * account takeover (change e-mail, then reset the password).
 *
 * @returns {boolean} true when the e-mail is changing (caller must reissue the session)
 */
export function guardEmailChange(ctx, { security, vault }, user) {
  const requested = typeof ctx.body?.email === 'string' ? ctx.body.email.trim().toLowerCase() : null;
  if (requested === null || requested === user.email) return false;
  throttle(security.limits.userAction, abuseKey('user-action', user.id, ctx.config.secret));
  const enrolled = mfaStateOf(user) === MFA_STATES.ENABLED;
  const proofs = [];
  if (enrolled) {
    if (!ctx.body?.mfaCode) throw badRequest('Two-factor code is required to change email');
    if (!acceptTotp(ctx, vault, user, ctx.body.mfaCode)) throw forbidden('Invalid two-factor code.');
    proofs.push(PROOF.TOTP);
  } else {
    const { currentPassword } = ctx.body ?? {};
    if (!currentPassword || typeof currentPassword !== 'string') throw badRequest('Current password is required to change email');
    if (!verifyPassword(currentPassword, user.password)) {
      throw badRequest('Unable to update profile. Please check your credentials and try again.');
    }
    proofs.push(PROOF.CURRENT_PASSWORD);
  }
  stepUpOrThrow('account.email.change', { sessionStrength: sessionOf(ctx).authStrength, enrolled, proofs });
  if (ctx.store.users.find((other) => other.email === requested && other.id !== user.id)) {
    throw badRequest('Unable to update profile. Please check your credentials and try again.');
  }
  return true;
}

/* ------------------------------------------------------------------ routes */

/**
 * @param {object} options
 * @param {object} options.logger
 * @param {object|null} options.vault P5.5 credential vault (seals TOTP secrets)
 * @param {object} options.security  state from createAccountSecurity()
 * @param {{ passwordReset(input: { email: string, firstName: string, passwordResetUrl: string }): Promise<void> }|null} [options.delivery]
 *   password-reset delivery port. Absent => the upstream "email not set up" 500.
 */
export function accountRoutes({ logger, vault, security, delivery = null }) {
  const userKey = (ctx, user) => abuseKey('user-action', user.id, ctx.config.secret);
  const fingerprintOf = (ctx) => (userId) => {
    const user = ctx.store.users.get(userId);
    return user ? credentialFingerprint(user, ctx.config.secret) : null;
  };

  return [
    /* ------------------------------------------------------ password change */
    {
      method: 'PATCH',
      path: '/rest/me/password',
      handler: (ctx) => {
        const user = requireUser(ctx);
        throttle(security.limits.userAction, userKey(ctx, user));
        const { currentPassword, newPassword, mfaCode } = ctx.body ?? {};
        if (!user.password) throw badRequest('Requesting user not set up.');
        if (typeof currentPassword !== 'string' || !verifyPassword(currentPassword, user.password)) {
          throw badRequest('Provided current password is incorrect.');
        }
        const violation = passwordPolicyViolation(newPassword);
        if (violation) throw badRequest(violation);
        const enrolled = mfaStateOf(user) === MFA_STATES.ENABLED;
        const proofs = [PROOF.CURRENT_PASSWORD];
        if (enrolled) {
          if (typeof mfaCode !== 'string') throw badRequest('Two-factor code is required to change password.');
          if (!acceptTotp(ctx, vault, user, mfaCode)) throw forbidden('Invalid two-factor code.');
          proofs.push(PROOF.TOTP);
        }
        const session = sessionOf(ctx);
        stepUpOrThrow('account.password.change', { sessionStrength: session.authStrength, enrolled, proofs });
        const updated = ctx.store.users.update(user.id, { password: hashPassword(newPassword), updatedAt: new Date().toISOString() });
        security.resetTokens.revokeForUser(user.id);
        const cookies = reissueSession(ctx, updated, session.authStrength === 'mfa' ? 'mfa' : 'password');
        logger.info('auth.password-changed', { userId: user.id });
        sendData(ctx.res, { success: true }, { headers: { 'set-cookie': cookies } });
      },
    },

    /* ----------------------------------------------------- password recovery */
    {
      method: 'POST',
      path: '/rest/forgot-password',
      public: true,
      handler: (ctx) => {
        throttle(security.limits.forgotIp, abuseKey('ip', clientIp(ctx.req), ctx.config.secret));
        const email = typeof ctx.body?.email === 'string' ? ctx.body.email.trim().toLowerCase() : '';
        if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) throw badRequest('Invalid email address');
        throttle(security.limits.forgotAccount, abuseKey('forgot-account', email, ctx.config.secret));
        if (!delivery) {
          // Upstream answers exactly this when SMTP is not configured — before
          // any lookup, so it is identical for every address.
          throw new HttpError(500, 'Email sending must be set up in order to request a password reset email');
        }
        // ENUMERATION RESISTANCE: the response is the same empty 200 whether or
        // not the account exists, and delivery is NOT awaited, so latency does
        // not depend on the answer either.
        const user = ctx.store.users.find((candidate) => candidate.email === email);
        if (user && user.password) {
          const { token } = security.resetTokens.issue({ userId: user.id, fingerprint: credentialFingerprint(user, ctx.config.secret) });
          const url = new URL('change-password', `${String(ctx.config.publicUrl).replace(/\/+$/, '')}/`);
          url.searchParams.append('token', token);
          url.searchParams.append('mfaEnabled', String(mfaStateOf(user) === MFA_STATES.ENABLED));
          Promise.resolve()
            .then(() => delivery.passwordReset({ email: user.email, firstName: user.firstName ?? '', passwordResetUrl: url.toString() }))
            // Never log the URL: it IS the credential.
            .catch(() => logger.warn('auth.password-reset-delivery-failed', { userId: user.id }));
          logger.info('auth.password-reset-requested', { userId: user.id });
        }
        sendData(ctx.res, undefined);
      },
    },
    {
      method: 'GET',
      path: '/rest/resolve-password-token',
      public: true,
      handler: (ctx) => {
        throttle(security.limits.resetIp, abuseKey('ip', clientIp(ctx.req), ctx.config.secret));
        const { token } = ctx.query ?? {};
        if (typeof token !== 'string' || token === '') throw badRequest('Token is required');
        const { verdict } = security.resetTokens.resolve(token, fingerprintOf(ctx));
        // One answer for unknown, expired, used and stale: nothing to learn.
        if (verdict !== RESET_TOKEN_VERDICT.OK) throw notFound('');
        sendData(ctx.res, undefined);
      },
    },
    {
      method: 'POST',
      path: '/rest/change-password',
      public: true,
      handler: (ctx) => {
        throttle(security.limits.resetIp, abuseKey('ip', clientIp(ctx.req), ctx.config.secret));
        const { token, password, mfaCode } = ctx.body ?? {};
        if (typeof token !== 'string' || token === '') throw badRequest('Token is required');
        const violation = passwordPolicyViolation(password);
        if (violation) throw badRequest(violation);
        // Resolve first WITHOUT consuming: a missing MFA code must not burn the
        // link (upstream lets the user retry with the code).
        const probe = security.resetTokens.resolve(token, fingerprintOf(ctx));
        if (probe.verdict !== RESET_TOKEN_VERDICT.OK) throw notFound('');
        const user = ctx.store.users.get(probe.userId);
        if (!user) throw notFound('');
        const enrolled = mfaStateOf(user) === MFA_STATES.ENABLED;
        const proofs = [PROOF.RESET_TOKEN];
        if (enrolled) {
          if (!mfaCode) throw badRequest('If MFA enabled, mfaCode is required.');
          if (!acceptTotp(ctx, vault, user, mfaCode)) throw badRequest('Invalid MFA token.');
          proofs.push(PROOF.TOTP);
        }
        stepUpOrThrow('account.password.reset', { sessionStrength: 'none', enrolled, proofs });
        // SINGLE USE: consumed atomically (no await between resolve and here,
        // and consume deletes before returning). A replay gets the same 404.
        const consumed = security.resetTokens.consume(token, fingerprintOf(ctx));
        if (consumed.verdict !== RESET_TOKEN_VERDICT.OK || consumed.userId !== user.id) throw notFound('');
        const updated = ctx.store.users.update(user.id, { password: hashPassword(password), updatedAt: new Date().toISOString() });
        const cookies = reissueSession(ctx, updated, enrolled ? 'mfa' : 'password');
        logger.info('auth.password-reset-completed', { userId: user.id });
        sendData(ctx.res, undefined, { headers: { 'set-cookie': cookies } });
      },
    },

    /* ------------------------------------------------------------------ MFA */
    {
      method: 'POST',
      path: '/rest/mfa/can-enable',
      handler: (ctx) => {
        requireUser(ctx);
        sendData(ctx.res, undefined);
      },
    },
    {
      method: 'GET',
      path: '/rest/mfa/qr',
      handler: (ctx) => {
        const user = requireUser(ctx);
        const state = mfaStateOf(user);
        if (state === MFA_STATES.ENABLED) {
          throw badRequest('MFA already enabled. Disable it to generate new secret and recovery codes');
        }
        stepUpOrThrow('account.mfa.setup', { sessionStrength: sessionOf(ctx).authStrength, enrolled: false, proofs: [] });
        const next = mfaTransition(state, MFA_EVENTS.SETUP);
        if (state === MFA_STATES.PENDING) {
          const material = openMfa(vault, user);
          if (material?.totp && Array.isArray(material.recoveryCodes) && material.recoveryCodes.length) {
            return sendData(ctx.res, {
              secret: material.totp,
              recoveryCodes: material.recoveryCodes,
              qrCode: totpUri({ secret: material.totp, label: user.email }),
            });
          }
        }
        const totp = generateTotpSecret();
        const recoveryCodes = generateRecoveryCodes();
        const sealed = sealMfa(vault, user, { totp, recoveryCodes });
        ctx.store.users.update(user.id, (current) => ({
          ...current,
          mfa: { state: next, secret: sealed, recoveryCodes: [], lastUsedStep: null },
        }));
        sendData(ctx.res, { secret: totp, recoveryCodes, qrCode: totpUri({ secret: totp, label: user.email }) });
      },
    },
    {
      method: 'POST',
      path: '/rest/mfa/enable',
      handler: (ctx) => {
        const user = requireUser(ctx);
        throttle(security.limits.userAction, userKey(ctx, user));
        const { mfaCode = null } = ctx.body ?? {};
        if (!mfaCode) throw badRequest('Token is required to enable MFA feature');
        const state = mfaStateOf(user);
        if (state === MFA_STATES.ENABLED) throw badRequest('MFA already enabled');
        const material = state === MFA_STATES.PENDING ? openMfa(vault, user) : null;
        if (!material?.totp || !Array.isArray(material.recoveryCodes) || material.recoveryCodes.length === 0) {
          throw badRequest('Cannot enable MFA without generating secret and recovery codes');
        }
        const verdict = verifyTotp(material.totp, mfaCode, { window: TOTP_WINDOW.enrolment, lastUsedStep: user.mfa?.lastUsedStep ?? null });
        if (!verdict.ok) {
          throw new HttpError(400, 'MFA code expired. Close the modal and enable MFA again', { code: MFA_EXPIRED_CODE });
        }
        stepUpOrThrow('account.mfa.enable', { sessionStrength: sessionOf(ctx).authStrength, enrolled: false, proofs: [PROOF.TOTP] });
        const next = mfaTransition(state, MFA_EVENTS.ENABLE);
        // Once enabled the recovery codes are kept only as digests; the
        // envelope is resealed holding the TOTP secret alone.
        const sealed = sealMfa(vault, user, { totp: material.totp });
        const updated = ctx.store.users.update(user.id, (current) => ({
          ...current,
          mfa: { state: next, secret: sealed, recoveryCodes: material.recoveryCodes.map(hashRecoveryCode), lastUsedStep: verdict.step },
        }));
        security.resetTokens.revokeForUser(user.id);
        const cookies = reissueSession(ctx, updated, 'mfa');
        logger.info('auth.mfa-enabled', { userId: user.id });
        sendData(ctx.res, undefined, { headers: { 'set-cookie': cookies } });
      },
    },
    {
      method: 'POST',
      path: '/rest/mfa/disable',
      handler: (ctx) => {
        const user = requireUser(ctx);
        throttle(security.limits.resetIp, abuseKey('ip', clientIp(ctx.req), ctx.config.secret));
        throttle(security.limits.userAction, userKey(ctx, user));
        const { mfaCode, mfaRecoveryCode } = ctx.body ?? {};
        const codeGiven = typeof mfaCode === 'string' && mfaCode !== '';
        const recoveryGiven = typeof mfaRecoveryCode === 'string' && mfaRecoveryCode !== '';
        if (codeGiven === recoveryGiven) {
          throw badRequest('Either MFA code or recovery code is required to disable MFA feature');
        }
        const state = mfaStateOf(user);
        if (codeGiven && (state === MFA_STATES.DISABLED || !acceptTotp(ctx, vault, user, mfaCode))) {
          throw forbidden('Invalid two-factor code.');
        }
        if (recoveryGiven && (state === MFA_STATES.DISABLED || !acceptRecoveryCode(ctx, vault, user, mfaRecoveryCode))) {
          throw forbidden('Invalid MFA recovery code');
        }
        stepUpOrThrow('account.mfa.disable', {
          sessionStrength: sessionOf(ctx).authStrength,
          enrolled: state === MFA_STATES.ENABLED,
          proofs: [codeGiven ? PROOF.TOTP : PROOF.RECOVERY_CODE],
        });
        mfaTransition(state, MFA_EVENTS.DISABLE);
        const updated = ctx.store.users.update(user.id, (current) => {
          const { mfa: _dropped, ...rest } = current;
          return { ...rest, mfa: { state: MFA_STATES.DISABLED } };
        });
        security.resetTokens.revokeForUser(user.id);
        const cookies = reissueSession(ctx, updated, 'password');
        logger.info('auth.mfa-disabled', { userId: user.id, method: codeGiven ? 'mfaCode' : 'recoveryCode' });
        sendData(ctx.res, undefined, { headers: { 'set-cookie': cookies } });
      },
    },
    {
      // Checks a code without changing anything. It deliberately does NOT
      // record the step: the editor's setup modal verifies a code and then
      // sends the SAME code to /mfa/enable.
      method: 'POST',
      path: '/rest/mfa/verify',
      handler: (ctx) => {
        const user = requireUser(ctx);
        throttle(security.limits.userAction, userKey(ctx, user));
        const { mfaCode } = ctx.body ?? {};
        const material = openMfa(vault, user);
        if (!mfaCode) throw badRequest('MFA code is required to enable MFA feature');
        if (!material?.totp) throw badRequest('No MFA secret se for this user');
        if (!acceptTotp(ctx, vault, user, mfaCode, { record: false })) throw badRequest('MFA secret could not be verified');
        sendData(ctx.res, undefined);
      },
    },
  ];
}
