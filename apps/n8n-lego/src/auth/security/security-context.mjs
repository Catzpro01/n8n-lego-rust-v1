/**
 * P5.1 — Security kernel: SecurityContext.
 *
 * PUBLIC CONTRACT (`auth.principal`, v1.0.0, owner: agent-1).
 *
 * A **SecurityContext** is the request-local, immutable object that execution
 * code actually reads. The distinction from `PrincipalSnapshot` is deliberate:
 *
 *  - the **snapshot** is about the *principal* — cached across requests, keyed
 *    by identity, invalidated by a principal version bump;
 *  - the **context** is about *this request* — it binds that snapshot to a
 *    requestId, a correlationId, a capability reference and the exact authority
 *    versions in force at issue time.
 *
 * Both are frozen. Neither is ever mutated after construction: a security
 * decision that can be changed mid-flight by the code it is guarding is not a
 * decision, it is a suggestion.
 *
 * The context is deliberately *flat and small*. It carries ids and versions, not
 * objects, so it can be passed to P3/P4/P6/AI without dragging a profile, a role
 * catalog or a credential along with it.
 */
import { SecurityError, SECURITY_REASON } from './security-error.mjs';
import { createSecurityStamp, isSecurityStamp } from './security-stamp.mjs';
import { isPrincipalSnapshot } from './principal.mjs';

const CONTEXT_KEYS = Object.freeze([
  'principalId',
  'tenantId',
  'authStrength',
  'permissionSetId',
  'capabilityRef',
  'requestId',
  'correlationId',
  'policyVersion',
  'principalVersion',
  'tenantVersion',
  'sessionVersion',
  'issuedAt',
  'expiresAt',
  'stamp',
]);

function requireString(value, field, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, `${field} is required`, { details: { field } });
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, `${field} must be a non-empty string`, {
      details: { field },
    });
  }
  return value;
}

/**
 * Builds an immutable SecurityContext from an already-validated snapshot.
 *
 * The authority versions come from the snapshot (`principalVersion`) and from
 * the caller's view of current tenant/policy/session state. Passing them
 * explicitly is what lets a cached context be checked for staleness later — see
 * `evaluateStampAuthority`.
 *
 * @param {object} params
 * @param {Readonly<object>} params.principal a validated PrincipalSnapshot
 * @param {string} params.requestId
 * @param {string} [params.correlationId]
 * @param {string} [params.capabilityRef]
 * @param {number} params.tenantVersion
 * @param {number} params.policyVersion
 * @param {number} params.sessionVersion
 * @param {number} [params.issuedAt]
 * @param {number} [params.expiresAt]
 * @returns {Readonly<object>} frozen context
 */
export function createSecurityContext(params) {
  if (params === null || typeof params !== 'object') {
    throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, 'security context input must be an object');
  }
  for (const key of Object.keys(params)) {
    if (!CONTEXT_KEYS.includes(key) && key !== 'principal') {
      throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, `unexpected context field '${key}'`, {
        details: { field: key },
      });
    }
  }

  const principal = params.principal;
  if (!isPrincipalSnapshot(principal)) {
    // Fail closed: no snapshot, no context. An anonymous request must not be
    // able to obtain a context object at all.
    throw new SecurityError(SECURITY_REASON.NO_PRINCIPAL, 'a SecurityContext requires a valid PrincipalSnapshot');
  }

  const issuedAt = params.issuedAt ?? Date.now();
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) {
    throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, 'issuedAt must be a finite number');
  }
  if (params.expiresAt !== undefined && params.expiresAt !== null) {
    if (typeof params.expiresAt !== 'number' || params.expiresAt <= issuedAt) {
      throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, 'expiresAt must be a finite number after issuedAt');
    }
  }

  const stamp = createSecurityStamp({
    principalVersion: principal.principalVersion,
    tenantVersion: params.tenantVersion,
    policyVersion: params.policyVersion,
    sessionVersion: params.sessionVersion,
  });

  return Object.freeze({
    principalId: principal.principalId,
    tenantId: principal.tenantId,
    authStrength: principal.authStrength,
    permissionSetId: principal.permissionSetId,
    capabilityRef: requireString(params.capabilityRef, 'capabilityRef', { optional: true }),
    requestId: requireString(params.requestId, 'requestId'),
    correlationId: requireString(params.correlationId, 'correlationId', { optional: true }),
    policyVersion: stamp.policyVersion,
    principalVersion: stamp.principalVersion,
    tenantVersion: stamp.tenantVersion,
    sessionVersion: stamp.sessionVersion,
    issuedAt,
    expiresAt: params.expiresAt ?? null,
    stamp,
  });
}

/** Structural guard; never throws. */
export function isSecurityContext(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.principalId === 'string' &&
    typeof value.tenantId === 'string' &&
    typeof value.requestId === 'string' &&
    typeof value.permissionSetId === 'string' &&
    isSecurityStamp(value.stamp)
  );
}

/**
 * Throws unless the context is well formed. Cheap enough to call on every
 * request at a trust boundary, and it turns a corrupted context into a refusal
 * instead of a partially-evaluated decision.
 *
 * @param {unknown} context
 * @returns {Readonly<object>} the same context
 */
export function assertSecurityContext(context) {
  if (!isSecurityContext(context)) {
    throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, 'malformed SecurityContext');
  }
  return context;
}

/**
 * Tenant binding check. Single-tenant deployments (`tenantId === 'default'` on
 * both sides) take the first branch and return immediately — the cheapest valid
 * path, as Issue #214 requires.
 *
 * @param {Readonly<object>} context
 * @param {string} resourceTenantId
 * @returns {{ allowed: boolean, reasonCode: string|null }}
 */
export function checkTenantBinding(context, resourceTenantId) {
  if (!isSecurityContext(context) || typeof resourceTenantId !== 'string' || resourceTenantId === '') {
    return Object.freeze({ allowed: false, reasonCode: SECURITY_REASON.MALFORMED_INPUT });
  }
  if (context.tenantId === resourceTenantId) {
    return Object.freeze({ allowed: true, reasonCode: null });
  }
  // A cross-tenant read is a denial, not an exception: the caller learns nothing
  // about whether the resource exists.
  return Object.freeze({ allowed: false, reasonCode: SECURITY_REASON.TENANT_MISMATCH });
}
