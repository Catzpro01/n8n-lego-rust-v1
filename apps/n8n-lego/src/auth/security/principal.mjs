/**
 * P5.1 — Security kernel: PrincipalSnapshot.
 *
 * PUBLIC CONTRACT (`auth.principal`, v1.0.0, owner: agent-1).
 *
 * A **PrincipalSnapshot** is the answer to "who is making this request, and what
 * are they allowed to do", pre-computed on the control path and then carried
 * cheaply down the hot path. It is the boundary between the two halves of the
 * plane:
 *
 * ```text
 * CONTROL PATH  authenticate → mutate security state → increment version
 *               (expensive: identity store, role lookup, scope compilation)
 * HOT PATH      request → snapshot → tenant check → compiled authorization
 *               (cheap: no I/O, no decryption, no profile)
 * ```
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY: an email, a name, settings, a role
 * catalog, or anything else from the user record. A snapshot that smuggles a
 * profile into the execution path is how a security plane turns into a data
 * leak, so the constructor rejects unknown keys outright — handing it a stored
 * user object is an error, not a convenience.
 *
 * It also does not *derive* permissions. The canonical role → scope map lives in
 * `compat/scopes.mjs` (extracted from pinned n8n `@n8n/permissions`) and stays
 * there; this module receives an already-compiled permission list. Compiling
 * here would create the second scope map the architecture forbids.
 */
import { createHash } from 'node:crypto';
import { SecurityError, SECURITY_REASON } from './security-error.mjs';

/** The four principal kinds the plane recognises. Anything else is rejected. */
export const PRINCIPAL_TYPES = Object.freeze(['user', 'service', 'api-key', 'agent']);

/** How the principal proved itself. Distinct from strength: method is a fact. */
export const AUTH_METHODS = Object.freeze([
  'password',
  'api-key',
  'service-credential',
  'mfa',
  'step-up',
  'none',
]);

/**
 * Assurance ladder, weakest first. Ordered so a step-up requirement can be
 * checked with one comparison instead of a lookup table per route:
 * a caller requiring `mfa` accepts `mfa` and `step-up`, never `password`.
 */
export const AUTH_STRENGTHS = Object.freeze(['none', 'password', 'api-key', 'mfa', 'step-up']);

/** Single-tenant deployments use this and stay on the cheapest valid path. */
export const DEFAULT_TENANT = 'default';

/**
 * Hard bounds. A snapshot is built once per authentication and then read many
 * times, so these are generous relative to any real principal but finite — an
 * unbounded permission list is an unbounded allocation on a path an attacker can
 * reach by asking for a token.
 */
export const PRINCIPAL_BOUNDS = Object.freeze({
  idLength: 128,
  permissions: 512,
  permissionLength: 96,
});

/**
 * `resource:action`, as the canonical n8n permission strings are actually
 * shaped. Both halves start lowercase and may use internal camelCase, digits or
 * hyphens.
 *
 * CAMELCASE IS REQUIRED, NOT TOLERATED. The original pattern here was
 * `^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$`, which is lowercase-only — and it rejected
 * 65 of the 122 permissions (53%) in the real extracted n8n vocabulary:
 * `aiAssistant:manage`, `annotationTag:create`, `chatHubAgent:read`,
 * `credential:shareGlobally`, and so on. A principal compiled from a real global
 * role could not be constructed at all. P5.3, which loads the actual universe,
 * is what exposed it.
 *
 * The pattern still rejects spaces, a missing colon, an uppercase first letter,
 * a leading digit, punctuation and surrounding whitespace — the unknown-permission
 * check against the registry is the real gate, but this rejects malformed input
 * before it ever gets that far.
 */
const SCOPE_SHAPE = /^[a-z][a-zA-Z0-9-]*:[a-z][a-zA-Z0-9-]*$/;

/** Exact key whitelist. Anything beyond these is a rejected field, not ignored. */
const ALLOWED_KEYS = Object.freeze([
  'principalId',
  'identityId',
  'tenantId',
  'principalType',
  'authMethod',
  'authStrength',
  'permissions',
  'permissionSetId',
  'principalVersion',
  'sessionId',
  'issuedAt',
  'expiresAt',
  'permissionUniverse',
]);

function fail(message, details) {
  throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, message, { details });
}

function requireId(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} must be a non-empty string`, { field });
  }
  if (value.length > PRINCIPAL_BOUNDS.idLength) {
    fail(`${field} exceeds ${PRINCIPAL_BOUNDS.idLength} characters`, { field, length: value.length });
  }
  return value;
}

function requireOneOf(value, vocabulary, field) {
  if (!vocabulary.includes(value)) {
    fail(`${field} must be one of ${vocabulary.join(', ')}`, { field, value: String(value) });
  }
  return value;
}

/**
 * Validates and normalises a permission list: shape-checked, deduplicated and
 * sorted so two principals holding the same permissions in a different order
 * compile to the same `permissionSetId` (and therefore share a cache entry).
 *
 * `universe`, when supplied, is the set of permissions this deployment actually
 * publishes. Passing it makes "unknown permission" a rejection rather than a
 * silently inert string — the fail-closed behaviour Issue #214 requires — without
 * this module owning a copy of the role/scope map.
 *
 * @param {unknown} permissions
 * @param {ReadonlySet<string>|null} universe
 * @returns {string[]} sorted, deduplicated
 */
export function compilePermissions(permissions, universe = null) {
  if (!Array.isArray(permissions)) {
    fail('permissions must be an array (use [] for a principal with no permissions)', {
      got: typeof permissions,
    });
  }
  if (permissions.length > PRINCIPAL_BOUNDS.permissions) {
    fail(`permissions exceeds ${PRINCIPAL_BOUNDS.permissions} entries`, { count: permissions.length });
  }
  const seen = new Set();
  for (const permission of permissions) {
    if (typeof permission !== 'string' || !SCOPE_SHAPE.test(permission)) {
      fail('permission must be a lowercase resource:action string', { permission: String(permission) });
    }
    if (permission.length > PRINCIPAL_BOUNDS.permissionLength) {
      fail('permission is too long', { permission: permission.slice(0, 32), length: permission.length });
    }
    // Unknown permission fails closed. An unrecognised scope that evaluates to
    // "no match" is indistinguishable from a typo'd grant, so refuse it here.
    if (universe && !universe.has(permission)) {
      fail('permission is not in the declared permission universe', { permission });
    }
    seen.add(permission);
  }
  return [...seen].sort();
}

/**
 * Deterministic identifier for a compiled permission set. Two snapshots with the
 * same permissions produce the same id, which is what lets the authorization
 * cache key on the set rather than on the principal.
 *
 * @param {string[]} sortedPermissions
 * @returns {string} 16 hex characters
 */
export function permissionSetIdFor(sortedPermissions) {
  return createHash('sha256').update(sortedPermissions.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Builds an immutable PrincipalSnapshot. Throws `SecurityError` on any malformed
 * or unknown input — it never returns a partially valid snapshot.
 *
 * @param {object} input
 * @param {string} input.principalId
 * @param {string} input.identityId
 * @param {string} [input.tenantId] defaults to `default`
 * @param {string} input.principalType one of PRINCIPAL_TYPES
 * @param {string} input.authMethod one of AUTH_METHODS
 * @param {string} input.authStrength one of AUTH_STRENGTHS
 * @param {string[]} input.permissions compiled scope list (`[]` = none)
 * @param {number} input.principalVersion non-negative integer
 * @param {string} [input.sessionId]
 * @param {number} [input.issuedAt] defaults to now
 * @param {number} [input.expiresAt] must be after issuedAt
 * @param {ReadonlySet<string>|null} [input.permissionUniverse] enables unknown-scope rejection
 * @returns {Readonly<object>} frozen snapshot
 */
export function createPrincipalSnapshot(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('principal input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.includes(key)) {
      // Rejecting rather than ignoring is the point: this is what stops a caller
      // passing a whole user record and having it ride along into execution.
      fail(`unexpected field '${key}' — a PrincipalSnapshot carries no profile data`, { field: key });
    }
  }

  const principalType = requireOneOf(input.principalType, PRINCIPAL_TYPES, 'principalType');
  const authMethod = requireOneOf(input.authMethod, AUTH_METHODS, 'authMethod');
  const authStrength = requireOneOf(input.authStrength, AUTH_STRENGTHS, 'authStrength');

  // `none` strength is only coherent with the `none` method; anything else means
  // the caller believes it authenticated someone without saying how.
  if ((authStrength === 'none') !== (authMethod === 'none')) {
    fail("authStrength 'none' requires authMethod 'none' and vice versa", { authMethod, authStrength });
  }

  const principalVersion = input.principalVersion;
  if (!Number.isInteger(principalVersion) || principalVersion < 0) {
    fail('principalVersion must be a non-negative integer', { principalVersion: String(principalVersion) });
  }

  const issuedAt = input.issuedAt ?? Date.now();
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) {
    fail('issuedAt must be a finite number', { issuedAt: String(issuedAt) });
  }
  // `null` is an explicit "no expiry bound" and is accepted; `undefined` means
  // "not supplied". Only a supplied non-null value is validated, and it must be
  // after issuedAt — a TTL that is already in the past is a malformed principal,
  // not an expired one worth constructing.
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    if (typeof input.expiresAt !== 'number' || !Number.isFinite(input.expiresAt)) {
      fail('expiresAt must be a finite number, or null for no expiry bound', {
        expiresAt: String(input.expiresAt),
      });
    }
    if (input.expiresAt <= issuedAt) {
      fail('expiresAt must be after issuedAt', { issuedAt, expiresAt: input.expiresAt });
    }
  }

  const permissions = compilePermissions(input.permissions ?? [], input.permissionUniverse ?? null);
  const tenantId = input.tenantId === undefined ? DEFAULT_TENANT : requireId(input.tenantId, 'tenantId');

  return Object.freeze({
    principalId: requireId(input.principalId, 'principalId'),
    identityId: requireId(input.identityId, 'identityId'),
    tenantId,
    principalType,
    authMethod,
    authStrength,
    permissions: Object.freeze(permissions),
    permissionSetId: input.permissionSetId ?? permissionSetIdFor(permissions),
    principalVersion,
    sessionId: input.sessionId === undefined ? null : requireId(input.sessionId, 'sessionId'),
    issuedAt,
    expiresAt: input.expiresAt ?? null,
  });
}

/**
 * Structural type guard. Never throws, so it is safe to use on values that
 * crossed a process or serialization boundary.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPrincipalSnapshot(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    PRINCIPAL_TYPES.includes(value.principalType) &&
    AUTH_METHODS.includes(value.authMethod) &&
    AUTH_STRENGTHS.includes(value.authStrength) &&
    typeof value.principalId === 'string' &&
    typeof value.tenantId === 'string' &&
    Array.isArray(value.permissions) &&
    Number.isInteger(value.principalVersion)
  );
}

/** Numeric rank of an auth strength, for `>=` comparisons at step-up checks. */
export function authStrengthRank(strength) {
  const index = AUTH_STRENGTHS.indexOf(strength);
  return index === -1 ? -1 : index;
}

/**
 * Does this snapshot satisfy a required minimum strength? Unknown strength on
 * either side is a refusal, not a pass.
 *
 * @param {Readonly<object>} snapshot
 * @param {string} requiredStrength
 * @returns {boolean}
 */
export function meetsAuthStrength(snapshot, requiredStrength) {
  const required = authStrengthRank(requiredStrength);
  if (required < 0) return false;
  const actual = authStrengthRank(snapshot?.authStrength);
  if (actual < 0) return false;
  return actual >= required;
}

/**
 * Expiry check. Note that expiry is a *bound*, never the correctness mechanism:
 * a snapshot inside its TTL can still be stale, and that is what the
 * SecurityStamp version tuple decides (see `security-stamp.mjs`).
 *
 * @param {Readonly<object>} snapshot
 * @param {number} [now]
 * @returns {boolean}
 */
export function isPrincipalExpired(snapshot, now = Date.now()) {
  if (!isPrincipalSnapshot(snapshot)) return true;
  if (snapshot.expiresAt === null) return false;
  return now >= snapshot.expiresAt;
}

/**
 * Membership test against the compiled permission set. A linear scan over a
 * bounded, sorted array is faster than a Set for realistic permission counts and
 * allocates nothing.
 *
 * @param {Readonly<object>} snapshot
 * @param {string} permission
 * @returns {boolean}
 */
export function hasPermission(snapshot, permission) {
  if (!isPrincipalSnapshot(snapshot) || typeof permission !== 'string') return false;
  return snapshot.permissions.includes(permission);
}
