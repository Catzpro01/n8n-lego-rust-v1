/**
 * P5.4 — SecretRef: how a runtime secret is allowed to leave storage.
 *
 * HARD RULE FROM #217: P5 owns whether access is allowed; the P2.27 Secret
 * Broker owns safe release. This file is therefore NOT a second broker — it is
 * a thin authorization-aware layer over `createSecretBroker`. It decides
 * *whether* a reference may be minted and *whether* it may be redeemed, and
 * delegates every property of safe release (single use, TTL, bound live set,
 * non-guessable token) to the broker that already has them.
 *
 * What this layer adds on top of the broker, all of it authorization-derived:
 *   - P5.3 `authorize()` runs before anything is issued (default deny)
 *   - tenant binding      — a ref cannot cross a tenant
 *   - credential binding  — id AND version, so a rotated credential invalidates
 *   - request binding     — a ref minted for one request cannot be replayed
 *   - audience binding    — the consumer named at mint must be the redeemer
 *   - capability binding  — the capability held at mint must still be presented
 *
 * The broker independently enforces single use, expiry and operation match, so
 * every binding above is checked twice: once by the policy layer, once by the
 * release layer.
 */

import { createSecretBroker, PLUGIN_SECRET_LIMITS } from '../../lego/plugin-secrets.mjs';
import { authorize } from './authorization.mjs';

/** The broker caps the operation label; every binding is encoded into it. */
const OPERATION_MAX = PLUGIN_SECRET_LIMITS.operationMaxLength;
const PLUGIN_ID_MAX = PLUGIN_SECRET_LIMITS.pluginIdMaxLength;

export const SECRET_REF_LIMITS = Object.freeze({
  operationMaxLength: OPERATION_MAX,
  audienceMaxLength: PLUGIN_ID_MAX,
  credentialIdMaxLength: 32,
  requestIdMaxLength: 40,
  capabilityMaxLength: 32,
  tenantIdMaxLength: 64,
  minTtlMs: 1,
  maxTtlMs: PLUGIN_SECRET_LIMITS.maxTtlMs,
  defaultTtlMs: PLUGIN_SECRET_LIMITS.defaultTtlMs,
});

/** Reasons a mint or a redeem is refused. None of them are exceptions in normal flow. */
export const REF_DENIAL = Object.freeze({
  NOT_AUTHORIZED: 'ref.not_authorized',
  TENANT_MISMATCH: 'ref.tenant_mismatch',
  CREDENTIAL_MISMATCH: 'ref.credential_mismatch',
  VERSION_MISMATCH: 'ref.version_mismatch',
  REQUEST_MISMATCH: 'ref.request_mismatch',
  AUDIENCE_MISMATCH: 'ref.audience_mismatch',
  CAPABILITY_MISMATCH: 'ref.capability_mismatch',
  ALREADY_REDEEMED: 'ref.already_redeemed',
  MALFORMED_REF: 'ref.malformed',
  NO_MATERIAL: 'ref.no_material',
});

class SecretRefDenied extends Error {
  constructor(reason, detail = {}) {
    super(reason);
    this.name = 'SecretRefDenied';
    this.reason = reason;
    this.detail = detail;
  }
}

export { SecretRefDenied };

function requireBoundedString(value, field, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new SecretRefDenied(REF_DENIAL.MALFORMED_REF, { field, max });
  }
  return value;
}

/**
 * Encodes every binding into the broker's operation label so the broker's own
 * operation-match check enforces them a second time.
 *
 * @param {object} b the bindings
 * @returns {string}
 */
function operationLabel(b) {
  return `c:${b.credentialId}@${b.credentialVersion}:${b.capability}:${b.requestId}`;
}

/**
 * Creates a SecretRef authority over a P2.27 broker.
 *
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {(credential: object) => string} [options.materialOf]
 *   Returns the serialized runtime secret for a credential. Called only after
 *   authorization has passed, i.e. only at the boundary.
 * @param {object|null} [options.registry] P5.3 permission registry
 * @param {number} [options.defaultTtlMs]
 * @param {number} [options.maxLive]
 * @param {(type: string, detail: object) => void} [options.onEvent]
 * @param {() => string} [options.refIdFactory]
 */
export function createSecretRefAuthority({
  now = Date.now,
  materialOf = null,
  registry = null,
  defaultTtlMs = SECRET_REF_LIMITS.defaultTtlMs,
  maxLive = PLUGIN_SECRET_LIMITS.maxLive,
  onEvent = null,
  refIdFactory = null,
} = {}) {
  if (typeof materialOf !== 'function') {
    throw new TypeError('createSecretRefAuthority requires materialOf(credential) -> string');
  }

  /**
   * The broker's `source` is invoked inside `issue()`, so the material supplier
   * is staged for exactly the duration of that synchronous call. Single-threaded
   * and never awaiting — there is no window in which the wrong supplier is live.
   *
   * @type {Map<string, () => string>}
   */
  const staged = new Map();

  const broker = createSecretBroker({
    now,
    maxLive,
    defaultTtlMs,
    onEvent,
    source: (operation) => {
      const supplier = staged.get(operation);
      if (!supplier) {
        throw new Error('secret ref issued outside an authorized mint');
      }
      return supplier();
    },
  });

  /** Refs already redeemed, so a replay fails before it reaches the broker. */
  const redeemed = new Set();
  let sequence = 0;

  const nextRefId =
    refIdFactory ??
    (() => `sref_${(sequence += 1).toString(36)}_${Math.random().toString(36).slice(2, 12)}`);

  /**
   * Decide whether a reference may be minted, and mint it. Returns a descriptor
   * that contains NO secret material — the material stays inside the broker
   * until a matching `redeem`.
   *
   * @param {object} request
   * @returns {object} frozen ref descriptor
   * @throws {SecretRefDenied} on every refusal
   */
  function mint({
    principal = null,
    credential = null,
    requestId,
    audience,
    capability,
    permission = 'credential:read',
    tenantId = null,
    ttlMs = defaultTtlMs,
    context = null,
    // Capability grants belong to the REQUEST, not to the PrincipalSnapshot:
    // a snapshot deliberately carries no profile data (P5.1 invariant).
    capabilityGrants = [],
  } = {}) {
    const credentialId = requireBoundedString(credential?.id, 'credentialId', SECRET_REF_LIMITS.credentialIdMaxLength);
    const boundRequestId = requireBoundedString(requestId, 'requestId', SECRET_REF_LIMITS.requestIdMaxLength);
    const boundAudience = requireBoundedString(audience, 'audience', SECRET_REF_LIMITS.audienceMaxLength);
    const boundCapability = requireBoundedString(capability, 'capability', SECRET_REF_LIMITS.capabilityMaxLength);

    const credentialVersion = credential?.credentialVersion ?? 1;
    if (!Number.isInteger(credentialVersion) || credentialVersion < 1) {
      throw new SecretRefDenied(REF_DENIAL.MALFORMED_REF, { field: 'credentialVersion' });
    }

    // 1. P5.3 decides. Default deny — an unknown permission, a missing scope,
    //    a tenant mismatch or a missing capability all fail here.
    const decision = authorize(
      {
        principal,
        action: permission,
        resourceType: 'credential',
        resourceId: credentialId,
        resourceTenantId: credential?.tenantId ?? tenantId,
        capability: boundCapability,
        capabilityGrants,
      },
      { registry, context },
    );
    if (decision.allowed !== true) {
      throw new SecretRefDenied(REF_DENIAL.NOT_AUTHORIZED, {
        // P5.3 names its denial `reasonCode`, with a human-readable `why` in
        // `details.reason`. Report both so an operator can tell a missing scope
        // from an unknown permission without reading the engine's source.
        reasonCode: decision.reasonCode,
        why: decision.details?.reason ?? null,
        permission,
        credentialId,
      });
    }

    // 2. Tenant binding. The principal's tenant and the credential's tenant must
    //    agree; `default` is not a wildcard (P5.3 invariant).
    const principalTenant = principal?.tenantId ?? null;
    const credentialTenant = credential?.tenantId ?? tenantId ?? null;
    if (credentialTenant !== null && principalTenant !== null && credentialTenant !== principalTenant) {
      throw new SecretRefDenied(REF_DENIAL.TENANT_MISMATCH, { principalTenant, credentialTenant });
    }

    // 3. Stage the material supplier, then let the broker own safe release.
    const operation = operationLabel({
      credentialId,
      credentialVersion,
      capability: boundCapability,
      requestId: boundRequestId,
    });
    if (operation.length > OPERATION_MAX) {
      throw new SecretRefDenied(REF_DENIAL.MALFORMED_REF, {
        field: 'operation',
        length: operation.length,
        max: OPERATION_MAX,
      });
    }

    staged.set(operation, () => materialOf(credential));
    let grant;
    try {
      grant = broker.issue({ pluginId: boundAudience, operation, ttlMs });
    } catch (error) {
      // 'lego.unavailable' from a credential with no material is a legitimate
      // refusal, not a crash — surface it as a denial with the broker's reason.
      throw new SecretRefDenied(REF_DENIAL.NO_MATERIAL, { message: error?.message });
    } finally {
      staged.delete(operation);
    }

    const ref = Object.freeze({
      refId: nextRefId(),
      // The broker token is the release handle. It is not the material.
      token: grant.token,
      credentialId,
      credentialVersion,
      requestId: boundRequestId,
      audience: boundAudience,
      capability: boundCapability,
      tenantId: credentialTenant,
      operation,
      expiresAt: grant.expiresAt,
      ttlMs: grant.ttlMs,
    });

    if (onEvent) onEvent('credential.secret-ref-minted', { refId: ref.refId, credentialId, audience: boundAudience });
    return ref;
  }

  /**
   * Redeem a reference for its material, exactly once.
   *
   * @param {object} ref
   * @param {object} presented what the redeemer claims
   * @returns {string} the material
   * @throws {SecretRefDenied}
   */
  function redeem(ref, { requestId, audience, capability, credentialVersion = null } = {}) {
    if (!ref || typeof ref !== 'object' || typeof ref.token !== 'string') {
      throw new SecretRefDenied(REF_DENIAL.MALFORMED_REF, {});
    }
    if (redeemed.has(ref.refId)) {
      throw new SecretRefDenied(REF_DENIAL.ALREADY_REDEEMED, { refId: ref.refId });
    }
    if (requestId !== ref.requestId) {
      throw new SecretRefDenied(REF_DENIAL.REQUEST_MISMATCH, { expected: ref.requestId, presented: requestId });
    }
    if (audience !== ref.audience) {
      throw new SecretRefDenied(REF_DENIAL.AUDIENCE_MISMATCH, { expected: ref.audience, presented: audience });
    }
    if (capability !== ref.capability) {
      throw new SecretRefDenied(REF_DENIAL.CAPABILITY_MISMATCH, { expected: ref.capability, presented: capability });
    }
    if (credentialVersion !== null && credentialVersion !== ref.credentialVersion) {
      throw new SecretRefDenied(REF_DENIAL.VERSION_MISMATCH, { expected: ref.credentialVersion, presented: credentialVersion });
    }

    redeemed.add(ref.refId);
    try {
      // Single use and expiry are the broker's job. A second call finds nothing.
      const material = broker.resolve(ref.token, ref.operation);
      if (onEvent) onEvent('credential.secret-ref-redeemed', { refId: ref.refId, credentialId: ref.credentialId });
      return material;
    } catch (error) {
      throw new SecretRefDenied(REF_DENIAL.ALREADY_REDEEMED, {
        refId: ref.refId,
        message: error?.message,
      });
    }
  }

  return Object.freeze({
    mint,
    redeem,
    /** Cancel an unredeemed reference (e.g. the request was aborted). */
    revoke: (ref) => {
      if (!ref || typeof ref.token !== 'string') return false;
      redeemed.add(ref.refId);
      return broker.revoke(ref.token);
    },
    sweep: () => broker.sweep(),
    liveCount: () => broker.liveCount(),
    inspect: (token) => broker.inspect(token),
  });
}
