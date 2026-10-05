/**
 * P5.1 — Security kernel: error type and decision vocabulary.
 *
 * PUBLIC CONTRACT (`auth.principal`, v1.0.0, owner: agent-1).
 *
 * WHY THIS FILE EXISTS: a security kernel that can invent its own failure
 * vocabulary silently forks the error contract. This module makes that
 * impossible *by construction* rather than by review: `SecurityError` refuses to
 * be constructed with any code that is not published in
 * `contracts/errors.contract.json`. The same trick P2.27 used for
 * `PluginRuntimeError` (foundation rule F16), applied to the security plane.
 *
 * TWO DIFFERENT FAILURE MODES, deliberately not conflated:
 *
 *  1. **Malformed input** — a caller handed us something that cannot possibly
 *     describe a principal. This THROWS. We refuse to build an object that
 *     carries authority, because a half-built snapshot that later evaluates to
 *     ALLOW is the exact bug a security plane exists to prevent.
 *  2. **A well-formed request that is not permitted** — this returns a DENY
 *     *decision* (see `decision.mjs`). Decisions are values, never exceptions,
 *     so the hot path has no control flow to get wrong and a caller cannot turn
 *     a denial into a crash-loop.
 *
 * Failing closed therefore means: never produce an authority-bearing object from
 * bad input, and never turn "unknown" into ALLOW.
 */
import { isErrorCode, statusForCode } from '../../lego/errors.mjs';

/**
 * The canonical decision vocabulary. Exactly three outcomes, and only one of
 * them grants anything:
 *
 *  - `ALLOW`       — evaluated against current authority and permitted.
 *  - `DENY`        — evaluated and not permitted, or authority could not be
 *                    established. The default, and the answer to every unknown.
 *  - `RE_EVALUATE` — the presented authority is *stale*, not wrong. The caller
 *                    must re-resolve the principal/tenant/policy version and ask
 *                    again. It is never a grant, and it must never be silently
 *                    promoted to ALLOW by a TTL expiring.
 */
export const SECURITY_DECISION = Object.freeze({
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  RE_EVALUATE: 'RE_EVALUATE',
});

/**
 * Reason codes for a decision. Every value is a PUBLISHED error code — the
 * vocabulary below is a *mapping*, not a new namespace. `assertSecurityReason`
 * is called by the test suite so a reason cannot drift away from the contract.
 */
export const SECURITY_REASON = Object.freeze({
  /** No principal at all: anonymous request against a protected resource. */
  NO_PRINCIPAL: 'auth.unauthorized',
  /** A principal exists but lacks the permission/capability for this action. */
  PERMISSION_DENIED: 'auth.forbidden',
  /**
   * The permission is not part of the canonical vocabulary at all — a typo'd or
   * invented scope. Denied like a routine denial, but reported distinctly in
   * `details` (unknownPermission: true) so a broken grant cannot masquerade as
   * an ordinary "user lacks this scope". This is the P5.3 critical invariant.
   */
  UNKNOWN_PERMISSION: 'auth.forbidden',
  /** Requested capability is not available to this principal at all. */
  CAPABILITY_UNAVAILABLE: 'lego.capability_unavailable',
  /** Tenant of the request does not match the tenant of the resource. */
  TENANT_MISMATCH: 'auth.forbidden',
  /** Presented SecurityStamp is stale; authority must be re-resolved. */
  STALE_AUTHORITY: 'lego.version_incompatible',
  /** A version is impossible (ahead of current) — forged or corrupted. */
  INVALID_AUTHORITY: 'lego.contract_violation',
  /** Session expired or revoked. */
  SESSION_INVALID: 'auth.unauthorized',
  /** Approval required and absent, expired, or mismatched. */
  APPROVAL_MISMATCH: 'auth.forbidden',
  /** Input could not be parsed into a valid security object. */
  MALFORMED_INPUT: 'lego.contract_violation',
  /** Required authority is unavailable (no key, no broker, no policy). */
  AUTHORITY_UNAVAILABLE: 'lego.unavailable',
});

/**
 * Throws unless `reason` is one of the SECURITY_REASON values. Used by the
 * contract test to prove the mapping still points at published codes.
 *
 * @param {string} reason
 * @returns {true}
 */
export function assertSecurityReason(reason) {
  const known = Object.values(SECURITY_REASON);
  if (!known.includes(reason)) {
    throw new SecurityError('lego.contract_violation', `unknown security reason ${JSON.stringify(reason)}`);
  }
  return true;
}

/**
 * The security plane's error type. Construction fails if `code` is not a
 * published error code, so a typo in a denial path is a boot-time failure
 * instead of an unrecognised status in production.
 */
export class SecurityError extends Error {
  /**
   * @param {string} code published error code (see contracts/errors.contract.json)
   * @param {string} message human-readable, must not contain secrets
   * @param {{ details?: object }} [options] structured, secret-free details
   */
  constructor(code, message, { details } = {}) {
    if (!isErrorCode(code)) {
      // Deliberately NOT a SecurityError: this is a programming error, and
      // throwing the real type here would recurse into this same check.
      throw new TypeError(`SecurityError: '${code}' is not a published error code`);
    }
    super(message);
    this.name = 'SecurityError';
    this.code = code;
    this.status = statusForCode(code);
    if (details !== undefined) this.details = Object.freeze({ ...details });
    Object.freeze(this);
  }
}
