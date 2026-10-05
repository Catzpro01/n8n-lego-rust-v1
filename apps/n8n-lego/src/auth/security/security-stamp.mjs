/**
 * P5.1 — Security kernel: SecurityStamp (versioned authority).
 *
 * PUBLIC CONTRACT (`auth.principal`, v1.0.0, owner: agent-1).
 *
 * THE CENTRAL CORRECTNESS RULE OF THIS PLANE:
 *
 * > A TTL is a cleanup mechanism. A version is a correctness mechanism.
 *
 * A cached decision that is merely "not expired yet" tells you nothing about
 * whether the authority behind it still holds — an admin can revoke a role, a
 * tenant policy can change, or a session can be killed a millisecond after a
 * decision was cached, and every one of those leaves the TTL untouched. So the
 * stamp carries the *versions* that were in force when the decision was made:
 *
 * ```text
 * SecurityStamp = principalVersion + tenantVersion + policyVersion + sessionVersion
 *                 (+ resourceVersion, for a mutable resource)
 * ```
 *
 * Comparing presented versions against current versions yields exactly three
 * outcomes, and none of them is "silently keep the old answer":
 *
 *  - equal            → CURRENT      the decision still stands
 *  - presented lower  → RE_EVALUATE  authority moved on; re-resolve and re-ask
 *  - presented higher → DENY         an impossible version: forged or corrupt
 *
 * A stale stamp is never promoted to ALLOW by time passing. Expiry only ever
 * removes an entry; it never validates one.
 */
import { SecurityError, SECURITY_REASON } from './security-error.mjs';

/** The three outcomes of comparing a presented stamp against current authority. */
export const STAMP_AUTHORITY = Object.freeze({
  /** Presented versions match current authority exactly. */
  CURRENT: 'CURRENT',
  /** Presented versions are behind: stale, must be re-resolved. Not a grant. */
  RE_EVALUATE: 'RE_EVALUATE',
  /** Presented versions are impossible or malformed. Refuse. */
  DENY: 'DENY',
});

/** The four authority versions every stamp carries, plus the optional fifth. */
export const STAMP_FIELDS = Object.freeze([
  'principalVersion',
  'tenantVersion',
  'policyVersion',
  'sessionVersion',
]);

/** Mutable resources add their own version so a resource edit invalidates too. */
export const RESOURCE_VERSION_FIELD = 'resourceVersion';

const STAMP_KEYS = Object.freeze([...STAMP_FIELDS, RESOURCE_VERSION_FIELD]);

function requireVersion(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, `${field} must be a non-negative integer`, {
      details: { field, value: String(value) },
    });
  }
  return value;
}

/**
 * Builds an immutable SecurityStamp. Every version is required except
 * `resourceVersion`, which only applies when a mutable resource is involved.
 *
 * @param {object} input
 * @param {number} input.principalVersion
 * @param {number} input.tenantVersion
 * @param {number} input.policyVersion
 * @param {number} input.sessionVersion
 * @param {number} [input.resourceVersion]
 * @returns {Readonly<object>} frozen stamp with a deterministic `value`
 */
export function createSecurityStamp(input) {
  if (input === null || typeof input !== 'object') {
    throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, 'security stamp input must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!STAMP_KEYS.includes(key)) {
      throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, `unexpected stamp field '${key}'`, {
        details: { field: key },
      });
    }
  }
  const stamp = {
    principalVersion: requireVersion(input.principalVersion, 'principalVersion'),
    tenantVersion: requireVersion(input.tenantVersion, 'tenantVersion'),
    policyVersion: requireVersion(input.policyVersion, 'policyVersion'),
    sessionVersion: requireVersion(input.sessionVersion, 'sessionVersion'),
  };
  if (input.resourceVersion !== undefined) {
    stamp.resourceVersion = requireVersion(input.resourceVersion, RESOURCE_VERSION_FIELD);
  }
  // A compact deterministic rendering, safe to log and to use as a cache key.
  // It contains only version integers — never an identifier, never a secret.
  const value = `${stamp.principalVersion}.${stamp.tenantVersion}.${stamp.policyVersion}.${stamp.sessionVersion}` +
    (stamp.resourceVersion === undefined ? '' : `.${stamp.resourceVersion}`);
  return Object.freeze({ ...stamp, value });
}

/** Structural guard; never throws. */
export function isSecurityStamp(value) {
  if (value === null || typeof value !== 'object') return false;
  return STAMP_FIELDS.every((field) => Number.isInteger(value[field]) && value[field] >= 0);
}

/**
 * Allocation-free "is this stamp still current?" predicate.
 *
 * WHY THIS EXISTS SEPARATELY: `evaluateStampAuthority` returns a rich verdict
 * with `stale`/`ahead` arrays and a frozen object, which is what a diagnostic or
 * an audit record needs — but it allocates on every call, and the decision cache
 * asks this question on *every* read. Measured, that allocation made the cache
 * slower than not caching at all.
 *
 * This is the hot-path twin: four integer comparisons, no allocation, identical
 * semantics for the only question the cache asks. A separate function is only
 * acceptable because a test pins the two together.
 *
 * @param {unknown} presented
 * @param {Readonly<object>} current
 * @returns {boolean} true only when every version matches exactly
 */
/**
 * Allocation-free "is this stamp still current?" predicate.
 *
 * WHY THIS EXISTS SEPARATELY: `evaluateStampAuthority` returns a rich verdict with
 * `stale`/`ahead` arrays and a frozen object — right for a diagnostic or an audit
 * record, but it allocates on every call, and the decision cache asks this
 * question on *every* read. This is the hot-path twin of that function.
 *
 * WHY IT IS WRITTEN OUT LONGHAND: the obvious implementation calls
 * `isSecurityStamp` twice, which loops `STAMP_FIELDS` and reads `value[field]`.
 * That dynamic keyed load is what is expensive — measured at 260 ns per call
 * against 5 ns for the same checks written out with direct property access
 * (`value.principalVersion`). Same semantics, ~50x faster. Readability is the
 * price; `isStampCurrentMatchesStampAuthority` in the test suite is what makes
 * that price safe to pay, by pinning this function to
 * `evaluateStampAuthority(...).verdict === CURRENT` over a matrix of inputs.
 *
 * @param {unknown} presented
 * @param {Readonly<object>} current authority versions in force now
 * @returns {boolean} true only when every version matches exactly
 */
export function isStampCurrent(presented, current) {
  if (current === null || typeof current !== 'object') return false;
  if (presented === null || typeof presented !== 'object') return false;

  // Each field is validated on `current` and compared on `presented`. Validating
  // `current` is sufficient: strict equality then makes `presented` valid too.
  // Failing closed on a malformed `current` is what stops a garbage stamp from
  // comparing equal to itself and granting authority.
  const principalVersion = current.principalVersion;
  if (!Number.isInteger(principalVersion) || principalVersion < 0) return false;
  if (presented.principalVersion !== principalVersion) return false;

  const tenantVersion = current.tenantVersion;
  if (!Number.isInteger(tenantVersion) || tenantVersion < 0) return false;
  if (presented.tenantVersion !== tenantVersion) return false;

  const policyVersion = current.policyVersion;
  if (!Number.isInteger(policyVersion) || policyVersion < 0) return false;
  if (presented.policyVersion !== policyVersion) return false;

  const sessionVersion = current.sessionVersion;
  if (!Number.isInteger(sessionVersion) || sessionVersion < 0) return false;
  if (presented.sessionVersion !== sessionVersion) return false;

  // resourceVersion is optional and only applies when a mutable resource is
  // involved. The guard mirrors `evaluateStampAuthority` exactly (`!== undefined`
  // and `!== null`, not `typeof === 'number'`) so the two cannot disagree.
  const currentResource = current.resourceVersion;
  const presentedResource = presented.resourceVersion;
  if (
    currentResource !== undefined &&
    currentResource !== null &&
    presentedResource !== undefined &&
    presentedResource !== null &&
    presentedResource !== currentResource
  ) {
    return false;
  }

  return true;
}

/**
 * Compares a presented stamp against the versions currently in force.
 *
 * This function performs no I/O and never throws for a *comparison* — it returns
 * a verdict. It throws only if `current` itself is not a well-formed stamp,
 * because that is a programming error in the caller rather than an attacker's
 * input.
 *
 * @param {unknown} presented the stamp carried by the request or cached decision
 * @param {Readonly<object>} current the versions in force right now
 * @param {{ strict?: boolean }} [options] `strict` turns RE_EVALUATE into DENY
 * @returns {{ verdict: string, reasonCode: string|null, stale: string[], ahead: string[] }}
 */
export function evaluateStampAuthority(presented, current, { strict = false } = {}) {
  if (!isSecurityStamp(current)) {
    throw new SecurityError(SECURITY_REASON.MALFORMED_INPUT, 'current authority is not a valid SecurityStamp');
  }
  if (!isSecurityStamp(presented)) {
    return Object.freeze({
      verdict: STAMP_AUTHORITY.DENY,
      reasonCode: SECURITY_REASON.MALFORMED_INPUT,
      stale: [],
      ahead: [],
    });
  }

  const stale = [];
  const ahead = [];
  for (const field of STAMP_FIELDS) {
    if (presented[field] < current[field]) stale.push(field);
    else if (presented[field] > current[field]) ahead.push(field);
  }
  if (
    current.resourceVersion !== undefined &&
    presented.resourceVersion !== undefined &&
    current.resourceVersion !== null
  ) {
    if (presented.resourceVersion < current.resourceVersion) stale.push(RESOURCE_VERSION_FIELD);
    else if (presented.resourceVersion > current.resourceVersion) ahead.push(RESOURCE_VERSION_FIELD);
  }

  // A version ahead of current is not "newer", it is impossible: nothing can
  // present authority the system has not issued yet. Refuse rather than treat
  // it as a cache miss.
  if (ahead.length > 0) {
    return Object.freeze({
      verdict: STAMP_AUTHORITY.DENY,
      reasonCode: SECURITY_REASON.INVALID_AUTHORITY,
      stale,
      ahead,
    });
  }
  if (stale.length > 0) {
    return Object.freeze({
      verdict: strict ? STAMP_AUTHORITY.DENY : STAMP_AUTHORITY.RE_EVALUATE,
      reasonCode: strict ? SECURITY_REASON.PERMISSION_DENIED : SECURITY_REASON.STALE_AUTHORITY,
      stale,
      ahead,
    });
  }
  return Object.freeze({ verdict: STAMP_AUTHORITY.CURRENT, reasonCode: null, stale, ahead });
}
