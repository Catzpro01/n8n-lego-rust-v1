/**
 * Users and sessions.
 *
 * Same shape as n8n: an owner account, email + password login, and a session
 * cookie (`n8n-auth`) that the editor sends with every REST call. Passwords are
 * scrypt-hashed; the session token is HMAC-signed with the instance secret so a
 * restart does not log everybody out.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  createSession as createSessionRecord,
  createSessionStore,
  revokeAllSessions,
  revokeSession,
  rotateSession,
  sessionTokenPayload,
  validateSession,
} from './auth/security/session.mjs';
import {
  csrfCookieHeader,
  evaluateCsrf,
  issueCsrfToken,
} from './auth/security/csrf.mjs';
import {
  hashPassword as hashWithPolicy,
  needsRehash,
  verifyAgainstDummy,
  verifyPassword as verifyWithPolicy,
} from './auth/security/password-hash.mjs';
import { MFA_STATES, mfaStateOf } from './auth/security/mfa.mjs';

export const SESSION_COOKIE = 'n8n-auth';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * P5.2 — process-local session state.
 *
 * WHY PROCESS-LOCAL: a session is revocable authority, and this store is the
 * only thing that makes revocation possible. It is deliberately NOT persisted —
 * a restart invalidates every session, which is the safe direction to fail.
 * Persisting it would mean a session could survive the process that was supposed
 * to be able to kill it.
 *
 * It is also **bounded** (see SESSION_POLICY.maxSessions), so a session flood
 * costs bounded memory rather than unbounded growth.
 */
const SESSION_STORE = createSessionStore();

/**
 * Per-user authority version. Bumping it invalidates every session issued
 * before the bump — the hook a password change, account disable or "log out
 * everywhere" uses. Tracked here alongside the session store for the same
 * reason: it is revocation state, not user data.
 */
const SECURITY_VERSIONS = new Map();

/** Reads the authority version currently in force for a user (default 0). */
export function securityVersionFor(userId) {
  return SECURITY_VERSIONS.get(userId) ?? 0;
}

/**
 * Invalidates every session for a user by advancing their authority version.
 * Sessions at or after the new version survive; older ones die on next use.
 *
 * @param {string} userId
 * @returns {number} the new authority version
 */
export function bumpSecurityVersion(userId) {
  const next = securityVersionFor(userId) + 1;
  SECURITY_VERSIONS.set(userId, next);
  revokeAllSessions(SESSION_STORE, { userId, belowVersion: next });
  return next;
}

/**
 * P5.6: hashing lives in `auth/security/password-hash.mjs` (algorithm agility,
 * rehash-on-success). These two exports keep their pre-P5.6 signatures and,
 * under the current policy, byte-compatible output (`scrypt$salt$hash`).
 */
export function hashPassword(password) {
  return hashWithPolicy(password);
}

export function verifyPassword(password, stored) {
  return verifyWithPolicy(password, stored);
}

export function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (signature.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (key === '') continue;
    out[key] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function sessionCookieHeader(token, { secure }) {
  const attributes = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Issues a session.
 *
 * P5.2 CHANGED THE TOKEN SHAPE — and that is the point of the slice.
 *
 * ```text
 * before   { sub, iat, exp }   a bearer token: unforgeable, but unrevocable
 * after    { sid, ver, exp }   a pointer into server-side revocable state
 * ```
 *
 * The old token asserted "I am user X" and stayed true until it expired, so
 * logout, password change and account disable could not actually cut a session
 * short. The new token carries only a session id, a version and an expiry; the
 * authority lives in the record behind it and can be killed at any time.
 *
 * UPGRADE CONSEQUENCE (documented, not hidden): tokens issued before this change
 * carry no `sid`, so they cannot be revoked or looked up. They are therefore
 * rejected — every user is signed out exactly once when this lands. Failing
 * closed is the only defensible answer for a credential the server cannot kill.
 *
 * @param {object} user stored user record
 * @param {object} config runtime config
 * @returns {{ token: string, cookie: string, csrfCookie: string, csrfToken: string, sessionId: string }}
 */
export function createSession(user, config, { authStrength = 'password' } = {}) {
  const session = createSessionRecord(SESSION_STORE, {
    userId: user.id,
    securityVersion: securityVersionFor(user.id),
    authStrength,
  });
  const token = signToken(sessionTokenPayload(session), config.secret);
  const secure = config.protocol === 'https';
  const csrfToken = issueCsrfToken(session.sessionId, config.secret);
  return {
    token,
    cookie: sessionCookieHeader(token, { secure }),
    csrfCookie: csrfCookieHeader(csrfToken, { secure }),
    csrfToken,
    sessionId: session.sessionId,
  };
}

/**
 * Resolves the signed-in user from the request cookie, **validating the session
 * record** rather than trusting the token alone.
 *
 * The token proves the cookie was issued by us and has not been tampered with;
 * the record proves it has not since been rotated, revoked or outrun by an
 * authority bump. Both must hold.
 *
 * This is one O(1) map lookup per HTTP request. It is deliberately NOT called
 * per workflow-node execution — a request resolves to a principal once at the
 * boundary and execution runs on that already-validated projection.
 */
export function currentUser(store, config, req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const payload = verifyToken(token, config.secret);
  if (!payload) return null;

  // A pre-P5.2 token (`sub`-shaped) names no session, so it cannot be checked
  // for revocation. Refuse it rather than honour authority we cannot revoke.
  if (typeof payload.sid !== 'string' || payload.sid === '') return null;

  // Two-phase on purpose: the authority version is keyed by user, and the user
  // is only known from the session record. So resolve the record first without
  // sliding its idle window, then re-validate with the version in force.
  const probe = validateSession(SESSION_STORE, payload.sid, { touch: false });
  if (!probe.valid) return null;
  const { userId } = probe.session;

  const verdict = validateSession(SESSION_STORE, payload.sid, {
    securityVersion: securityVersionFor(userId),
  });
  if (!verdict.valid) return null;

  // The session — not the token — is the source of the user id.
  return store.users.get(userId);
}

/**
 * Resolves the session carrying a request, without loading a user. Used by the
 * CSRF boundary, which needs to know whether there is ambient authority to
 * protect before any route runs.
 *
 * @returns {{ sessionId: string, userId: string, authStrength: string, authTime: number }|null}
 */
export function currentSession(config, req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const payload = verifyToken(token, config.secret);
  if (!payload || typeof payload.sid !== 'string' || payload.sid === '') return null;
  const verdict = validateSession(SESSION_STORE, payload.sid, { touch: false });
  if (!verdict.valid) return null;
  return {
    sessionId: verdict.session.sessionId,
    userId: verdict.session.userId,
    authStrength: verdict.session.authStrength ?? 'password',
    authTime: verdict.session.authTime ?? verdict.session.createdAt,
  };
}

/** Revokes the session behind a request — what logout actually does now. */
export function revokeCurrentSession(config, req) {
  const session = currentSession(config, req);
  if (!session) return false;
  return revokeSession(SESSION_STORE, session.sessionId);
}

/**
 * Kills every session for a user and advances their authority version so any
 * session issued before this moment stops working.
 *
 * @returns {{ revoked: number, securityVersion: number }}
 */
export function revokeAllSessionsForUser(userId) {
  const securityVersion = bumpSecurityVersion(userId);
  return { revoked: revokeAllSessions(SESSION_STORE, { userId }), securityVersion };
}

/** Rotates the session behind a request (fixation defence). Returns a new token. */
export function rotateCurrentSession(config, req) {
  const session = currentSession(config, req);
  if (!session) return null;
  const next = rotateSession(SESSION_STORE, session.sessionId, {
    securityVersion: securityVersionFor(session.userId),
  });
  const token = signToken(sessionTokenPayload(next), config.secret);
  return {
    token,
    cookie: sessionCookieHeader(token, { secure: config.protocol === 'https' }),
    sessionId: next.sessionId,
  };
}

/** Test/operator introspection. Never exposes token material. */
export function sessionStore() {
  return SESSION_STORE;
}

/**
 * P5.2 — the CSRF decision for one request, resolved against the live session.
 *
 * Returns the verdict rather than throwing, so the composition root decides how
 * to surface it. Nothing happens for safe methods or when there is no session.
 *
 * @param {object} config runtime config
 * @param {object} req node request
 * @returns {{ allowed: boolean, verdict: string, reasonCode: string|null }}
 */
export function checkCsrf(config, req) {
  const session = currentSession(config, req);
  const configured = [config.publicUrl, `http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`];
  // Same-origin is allowed by definition: a request whose Origin matches the
  // Host it was sent to is not cross-site. Deriving this from the request (not
  // from config) is what makes the check correct when the server is bound to an
  // ephemeral port, as it is under test and behind a port-forwarding proxy.
  const host = req.headers?.host;
  const sameOrigin = [];
  if (typeof host === 'string' && host !== '') {
    sameOrigin.push(`http://${host}`, `https://${host}`);
  }
  const allowed = [...configured, ...sameOrigin]
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return evaluateCsrf(
    { method: req.method ?? 'GET', headers: req.headers ?? {} },
    {
      allowedOrigins: allowed,
      sessionId: session?.sessionId ?? null,
      secret: config.secret,
    },
  );
}

export function hasOwner(store) {
  return store.users.all().some((user) => user.role === 'global:owner');
}

export function ownerExists(store) {
  return hasOwner(store);
}

export function createOwner(store, { email, firstName, lastName, password }) {
  return store.users.insert({
    id: randomBytes(8).toString('hex'),
    email: String(email).toLowerCase(),
    firstName: firstName ?? '',
    lastName: lastName ?? '',
    role: 'global:owner',
    password: hashPassword(password),
    isPending: false,
    createdAt: new Date().toISOString(),
    settings: {},
  });
}

/**
 * The editor reads a lot of user fields; anything missing shows up as a broken
 * avatar or a blank "personal project" label, so the full shape is returned.
 */
export function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName ?? '',
    lastName: user.lastName ?? '',
    role: user.role ?? 'global:owner',
    isPending: user.isPending ?? false,
    isOwner: user.role === 'global:owner',
    settings: user.settings ?? {},
    disabled: false,
    // P5.6: real MFA state. Only the boolean leaves the server — never the
    // sealed secret, the recovery-code digests or the replay step.
    mfaEnabled: mfaStateOf(user) === MFA_STATES.ENABLED,
    personalizationAnswers: null,
    createdAt: user.createdAt ?? new Date().toISOString(),
    updatedAt: user.updatedAt ?? user.createdAt ?? new Date().toISOString(),
    signInType: 'email',
  };
}

/**
 * Password check for login.
 *
 * P5.6:
 *   - an unknown account burns the same scrypt cost as a known one, so the
 *     response time does not reveal which e-mail addresses exist;
 *   - rehash-on-success: when the stored hash was made under older parameters
 *     it is upgraded now, with the password the user just proved. Nobody is
 *     forced through a reset. (Dormant while the policy equals the legacy
 *     parameters — see password-hash.mjs.)
 */
export function authenticate(store, email, password) {
  const normalized = String(email ?? '').trim().toLowerCase();
  const user = store.users.find((candidate) => candidate.email === normalized);
  if (!user) return verifyAgainstDummy(password) && null;
  if (!verifyPassword(password, user.password)) return null;
  if (needsRehash(user.password)) {
    return store.users.update(user.id, { password: hashPassword(password), updatedAt: new Date().toISOString() }) ?? user;
  }
  return user;
}
