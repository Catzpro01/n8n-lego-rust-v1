/**
 * Backend LEGO foundation — P2.27 capability / permission policy.
 *
 * PUBLIC CONTRACT (`lego.plugin-runtime`, v0.3.0, owner: agent-1).
 *
 * The §10/§11 security core, as functions: **deny-by-default**, explicit
 * grants only, no wildcards, no authority inheritance by nesting. Two
 * vocabularies meet here without either being forked:
 *
 *  1. **Foundation OS-capabilities** (`network`, `filesystem`, `subprocess`,
 *     `secrets`, `native`, `env`) stay governed by `foundation.mjs`
 *     `isCapabilityAllowed` against a *ceiling trust level* derived from the
 *     plugin's trust class (below). `foundation.json` remains canonical.
 *  2. **Domain capabilities** (namespaced tokens like `memory.read`) are not
 *     in the foundation set and are NEVER default-granted: they pass only on
 *     an exact explicit grant.
 *
 * The trust-class → foundation-level ceiling is the documented meeting point
 * of the two axes (isolation posture → provenance grants):
 *
 * ```text
 * CORE → core (full defaults)   TRUSTED → verified (network default)
 * ISOLATED → community (none)   SANDBOXED → untrusted (none)
 * ```
 *
 * More isolation never buys more authority: a SANDBOXED plugin cannot become
 * privileged by nesting inside a CORE caller — delegation is attenuated
 * (§11 `grant(B) <= grant(A)`), not inherited.
 */
import {
  CAPABILITIES,
  TRUST_LEVELS,
  isCapabilityAllowed,
} from './foundation.mjs';
import { PluginRuntimeError, PLUGIN_TRUST_CLASSES } from './plugin-runtime.mjs';

/**
 * Trust class (isolation posture) → the foundation trust level that acts as
 * the capability *ceiling*. Monotonic: more isolation ⇒ weaker defaults.
 */
export const TRUST_CLASS_CAPABILITY_CEILING = Object.freeze({
  CORE: 'core',
  TRUSTED: 'verified',
  ISOLATED: 'community',
  SANDBOXED: 'untrusted',
});

/** Bounds — grant lists are small, explicit, and never unbounded (§63). */
export const PLUGIN_GRANTS_MAX = Object.freeze({ grants: 64, delegationRequests: 64, tokenLength: 64 });

const TOKEN_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

const violation = (message, details) => new PluginRuntimeError('lego.contract_violation', message, { details });

function assertToken(token, where) {
  if (typeof token !== 'string' || token.length === 0 || token.length > PLUGIN_GRANTS_MAX.tokenLength) {
    throw violation(`${where} must be a string of length [1, ${PLUGIN_GRANTS_MAX.tokenLength}]`, { where, token });
  }
  if (!TOKEN_RE.test(token)) {
    throw violation(`${where} '${token}' is not a capability-shaped token (aclimit: lowercase dotted/kebab)`, {
      where,
      token,
    });
  }
}

/**
 * Validate a grant list. Fail-closed: wildcards (`*`, `all`, suffix `.*`)
 * cannot even be *stated* — an authority that can be written as "everything"
 * is exactly what deny-by-default forbids.
 *
 * @param {string[]} grants
 */
export function normalizeGrants(grants, where = 'grants') {
  if (!Array.isArray(grants)) throw violation(`${where} must be an array`, { where });
  if (grants.length > PLUGIN_GRANTS_MAX.grants) {
    throw violation(`${where} exceeds ${PLUGIN_GRANTS_MAX.grants} entries`, { where, count: grants.length });
  }
  const seen = [];
  for (const grant of grants) {
    if (typeof grant === 'string' && (grant === '*' || grant === 'all' || grant.endsWith('.*') || grant.includes('*'))) {
      throw violation(`${where} may not contain wildcard authority '${grant}'`, { where, grant });
    }
    assertToken(grant, where);
    if (seen.includes(grant)) throw violation(`${where} repeats '${grant}'`, { where, grant });
    seen.push(grant);
  }
  return Object.freeze([...seen]);
}

/** Is this token one of the six canonical foundation OS-capabilities? */
export function isFoundationCapability(token) {
  return CAPABILITIES.includes(token);
}

function ceilingFor(trustClass) {
  if (typeof trustClass !== 'string' || !PLUGIN_TRUST_CLASSES.includes(trustClass)) {
    throw violation(`trustClass must be one of ${PLUGIN_TRUST_CLASSES.join('/')}`, {
      trustClass,
      declared: PLUGIN_TRUST_CLASSES,
    });
  }
  const ceiling = TRUST_CLASS_CAPABILITY_CEILING[trustClass];
  if (!TRUST_LEVELS.includes(ceiling)) {
    // Construction bug, not user input — but fail closed anyway.
    throw violation(`trust class '${trustClass}' has no published ceiling level`, { trustClass, ceiling });
  }
  return ceiling;
}

/**
 * Evaluate ONE capability for a trust class under explicit grants.
 * Returns a frozen, explainable verdict — never a bare boolean — so a denial
 * can always say why (operator model, design §20).
 *
 * @param {{ trustClass: string, capability: string, grants?: string[] }} request
 * @returns {{ granted: boolean, via: 'foundation-default' | 'explicit-grant' | 'denied',
 *             reason: string, capability: string, trustClass: string }}
 */
export function evaluateCapability({ trustClass, capability, grants = [] }) {
  const ceiling = ceilingFor(trustClass);
  assertToken(capability, 'capability');
  const normalized = normalizeGrants(grants);

  if (isFoundationCapability(capability)) {
    // Foundation verdict: explicit grant OR ceiling default — foundation.mjs
    // owns the semantics, we only pick the level.
    const verdict = isCapabilityAllowed(ceiling, capability, { granted: [...normalized] });
    return Object.freeze({
      granted: verdict.allowed,
      via: verdict.allowed ? (normalized.includes(capability) ? 'explicit-grant' : 'foundation-default') : 'denied',
      reason: `foundation level '${ceiling}' (ceiling of ${trustClass}): ${verdict.reason}`,
      capability,
      trustClass,
    });
  }

  // Domain capability: deny-by-default, exact explicit grant only.
  if (normalized.includes(capability)) {
    return Object.freeze({
      granted: true,
      via: 'explicit-grant',
      reason: `domain capability '${capability}' explicitly granted`,
      capability,
      trustClass,
    });
  }
  return Object.freeze({
    granted: false,
    via: 'denied',
    reason: `domain capability '${capability}' has no explicit grant for trust class ${trustClass} (deny-by-default; ceiling ${ceiling} does not cover domain tokens)`,
    capability,
    trustClass,
  });
}

/**
 * The §10 pipeline for a whole manifest: requested → policy → grant/deny.
 *
 * @param {{ trustClass: string, requestedCapabilities: string[] }} manifest
 * @param {{ grants?: string[] }} [context]
 * @returns {{ granted: string[], denied: Array<{ capability: string, reason: string }> }}
 */
export function evaluateManifestPolicy(manifest, { grants = [] } = {}) {
  if (manifest === null || typeof manifest !== 'object') throw violation('manifest must be an object');
  ceilingFor(manifest.trustClass); // validates the class first
  if (!Array.isArray(manifest.requestedCapabilities)) {
    throw violation('manifest.requestedCapabilities must be an array');
  }
  const normalized = normalizeGrants(grants, 'context.grants');
  const granted = [];
  const denied = [];
  for (const capability of manifest.requestedCapabilities) {
    const verdict = evaluateCapability({ trustClass: manifest.trustClass, capability, grants: [...normalized] });
    if (verdict.granted) granted.push(capability);
    else denied.push(Object.freeze({ capability, reason: verdict.reason }));
  }
  return Object.freeze({
    granted: Object.freeze(granted),
    denied: Object.freeze(denied),
  });
}

/**
 * Permission assertion for an operation: allowed → returns `true`, denied →
 * throws `lego.access_denied` carrying the explainable reason.
 *
 * @param {{ trustClass: string, capability: string, grants?: string[] }} request
 */
export function assertCapability(request) {
  const verdict = evaluateCapability(request);
  if (!verdict.granted) {
    throw new PluginRuntimeError('lego.access_denied', verdict.reason, {
      details: { capability: verdict.capability, trustClass: verdict.trustClass, via: verdict.via },
    });
  }
  return true;
}

/**
 * §11 no-authority-inheritance: what a child may hold is the INTERSECTION of
 * what the child asks and what the parent actually holds. Anything the child
 * asks beyond the parent is *stripped*, reported, and never granted — nesting
 * cannot mint authority.
 *
 * @param {string[]} parentGrants
 * @param {string[]} childRequested
 * @returns {{ granted: string[], stripped: string[] }}
 */
export function attenuateDelegation(parentGrants, childRequested) {
  const parent = normalizeGrants(parentGrants, 'parentGrants');
  const child = normalizeGrants(childRequested, 'childRequested');
  if (child.length > PLUGIN_GRANTS_MAX.delegationRequests) {
    throw violation(`childRequested exceeds ${PLUGIN_GRANTS_MAX.delegationRequests} entries`, { count: child.length });
  }
  const granted = child.filter((token) => parent.includes(token));
  const stripped = child.filter((token) => !parent.includes(token));
  return Object.freeze({
    granted: Object.freeze(granted),
    stripped: Object.freeze(stripped),
  });
}
