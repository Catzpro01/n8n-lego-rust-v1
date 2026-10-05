/**
 * P5.2 — CSRF boundary.
 *
 * PUBLIC CONTRACT (`auth.session`, v1.0.0, owner: agent-1).
 *
 * THE PROBLEM: the `n8n-auth` session cookie is sent by the browser on every
 * request to this origin, including requests a *third-party* page triggers. The
 * baseline has no CSRF defence at all, so any external page could make the
 * editor perform state-changing actions as the signed-in user.
 *
 * TWO CHECKS, only one of which is always on — and the reason is a hard
 * compatibility constraint:
 *
 *  1. **Origin/Referer validation — ALWAYS ENFORCED for state changes.**
 *     A cross-site page cannot forge `Origin`. Combined with the `SameSite=Lax`
 *     cookie attribute (already set by the session cookie), this is what
 *     actually stops CSRF against this deployment.
 *
 *  2. **Double-submit token — OPT-IN (`requireToken`).** A value in a custom
 *     header must match a value in a readable cookie; a third-party page can
 *     cause a cookie to be *sent* but cannot *read* it to echo it.
 *
 * WHY THE TOKEN IS NOT ON BY DEFAULT — this was decided by a failing CI run,
 * not by preference. The editor is the **pinned upstream n8n UI**: it is the
 * declared compatibility surface, and it has no knowledge of a bespoke
 * `x-n8n-csrf-token` header. Enforcing the token broke the real product:
 *
 * ```text
 * FAIL  save the workflow — no successful save request (["POST /rest/workflows 403", ×6])
 * FAIL  execute the workflow — POST /run -> 403
 * ```
 *
 * Demanding a header the shipped editor does not send is not defence, it is an
 * outage. So the token remains available for first-party and machine clients
 * (see P5.7) that opt into it, while the editor is protected by the origin
 * check it already satisfies.
 *
 * SAFE METHODS (GET/HEAD/OPTIONS) are exempt: they must not mutate state, and
 * the editor's initial page load carries no token.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SecurityError, SECURITY_REASON } from './security-error.mjs';

/** Methods that must not mutate state, and so are not CSRF-protected. */
export const SAFE_METHODS = Object.freeze(['GET', 'HEAD', 'OPTIONS']);

/** The CSRF cookie and the header that must echo it. */
export const CSRF_COOKIE = 'n8n-csrf';
export const CSRF_HEADER = 'x-n8n-csrf-token';

/** Reasons a CSRF check refuses, mapped onto published error codes. */
export const CSRF_VERDICT = Object.freeze({
  /** Safe method, or no session to protect — nothing to forge. */
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  OK: 'OK',
  /** Origin/Referer present and pointing somewhere else. */
  ORIGIN_MISMATCH: 'ORIGIN_MISMATCH',
  /** State-changing request with no Origin and no Referer to judge. */
  MISSING_ORIGIN: 'MISSING_ORIGIN',
  /** A token was issued but the header is absent or does not match. */
  TOKEN_MISMATCH: 'TOKEN_MISMATCH',
});

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Issues a double-submit token bound to one session.
 *
 * The token is `sessionId` signed with the instance secret, so it cannot be
 * minted by an attacker who only knows the session id (which is itself only
 * ever in an HttpOnly cookie).
 *
 * @param {string} sessionId
 * @param {string} secret instance secret
 * @returns {string}
 */
export function issueCsrfToken(sessionId, secret) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, 'a CSRF token requires a sessionId');
  }
  const nonce = randomBytes(16).toString('hex');
  const mac = createHmac('sha256', secret).update(`${sessionId}.${nonce}`).digest('base64url');
  return `${nonce}.${mac}`;
}

/**
 * Verifies a presented token against the session it was issued for.
 *
 * @param {string|null|undefined} token value from the header
 * @param {string} sessionId
 * @param {string} secret
 * @returns {boolean}
 */
export function verifyCsrfToken(token, sessionId, secret) {
  if (typeof token !== 'string' || token === '' || !token.includes('.')) return false;
  if (typeof sessionId !== 'string' || sessionId === '') return false;
  const [nonce, mac] = token.split('.');
  if (!nonce || !mac) return false;
  const expected = createHmac('sha256', secret).update(`${sessionId}.${nonce}`).digest('base64url');
  return safeEqual(mac, expected);
}

/** Parses cookies from a raw header, same shape as the auth module's helper. */
export function parseCookieHeader(header) {
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

/**
 * Normalises an Origin/Referer value to its `scheme://host[:port]` origin so a
 * string comparison is meaningful. Returns null for anything unparseable.
 */
export function normalizeOrigin(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * The CSRF decision for one request.
 *
 * @param {object} request
 * @param {string} request.method
 * @param {object} request.headers raw header map (case-insensitive lookup applied)
 * @param {object} [options]
 * @param {string[]} [options.allowedOrigins] origins permitted for state changes
 * @param {string} [options.sessionId] current session, enables the token check
 * @param {string} [options.secret] instance secret, for token verification
 * @param {boolean} [options.requireToken] also demand a matching token (default true when a session is present)
 * @returns {{ allowed: boolean, verdict: string, reasonCode: string|null }}
 */
export function evaluateCsrf(request, options = {}) {
  const { allowedOrigins = [], sessionId = null, secret = null, requireToken = false } = options;
  const method = String(request?.method ?? 'GET').toUpperCase();
  const headers = request?.headers ?? {};
  const header = (name) => headers[name] ?? headers[name.toLowerCase()];

  const ok = (verdict) => Object.freeze({ allowed: true, verdict, reasonCode: null });
  const deny = (verdict, reasonCode) => Object.freeze({ allowed: false, verdict, reasonCode });

  // A safe method must not mutate state; if a route mutates on GET, that is a
  // routing bug to fix, not something CSRF policy should paper over.
  if (SAFE_METHODS.includes(method)) return ok(CSRF_VERDICT.NOT_APPLICABLE);
  // With no session there is no ambient authority to abuse.
  if (!sessionId) return ok(CSRF_VERDICT.NOT_APPLICABLE);

  const origin = normalizeOrigin(header('origin'));
  const referer = normalizeOrigin(header('referer'));
  const presented = origin ?? referer;

  if (presented === null) {
    // State-changing request with neither header. Browsers always send Origin
    // on cross-origin state changes, so absence means a non-browser client or a
    // stripped proxy — refuse rather than guess.
    return deny(CSRF_VERDICT.MISSING_ORIGIN, SECURITY_REASON.MALFORMED_INPUT);
  }
  if (!allowedOrigins.includes(presented)) {
    return deny(CSRF_VERDICT.ORIGIN_MISMATCH, SECURITY_REASON.PERMISSION_DENIED);
  }

  // The double-submit check is OPT-IN. It is not demanded from the pinned n8n
  // editor, which cannot send a header it has never heard of — see the module
  // header for the CI failure that settled this.
  if (requireToken) {
    const cookieToken = parseCookieHeader(header('cookie'))[CSRF_COOKIE];
    const headerToken = header(CSRF_HEADER);
    const signatureValid = cookieToken ? verifyCsrfToken(cookieToken, sessionId, secret) : false;
    if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken) || !signatureValid) {
      return deny(CSRF_VERDICT.TOKEN_MISMATCH, SECURITY_REASON.PERMISSION_DENIED);
    }
  }

  return ok(CSRF_VERDICT.OK);
}

/** The Set-Cookie value that seeds the double-submit token (readable by JS). */
export function csrfCookieHeader(token, { secure = false } = {}) {
  const attributes = [`${CSRF_COOKIE}=${token}`, 'Path=/', 'SameSite=Lax'];
  if (secure) attributes.push('Secure');
  // Deliberately NOT HttpOnly: the editor must read this value to echo it in the
  // header. It carries no authority of its own — session identity stays in the
  // HttpOnly `n8n-auth` cookie.
  return attributes.join('; ');
}
