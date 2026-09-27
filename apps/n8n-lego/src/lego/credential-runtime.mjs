/**
 * P5-M02 / P6-S05 — the ONE canonical credential runtime path.
 *
 * Chain (REQ-0005 sections 6-7):
 *   workflow node -> credentialRef -> SecretRef -> P2.27 Secret Broker
 *     -> credential resolution -> node handler (Authorization header).
 *
 * There is exactly one broker (createSecretBroker via createSecretRefAuthority)
 * and exactly one SecretRef semantics (auth/security/secret-ref.mjs). This
 * module is the resolution step that hands RESOLVED material to a node handler
 * for the duration of one request; it never invents a second credential path
 * and never stores raw material outside the broker lifetime.
 *
 * Failure mapping (closed, explicit — never an empty success):
 *   CREDENTIAL_MISSING       — unknown credential id / nothing to resolve
 *   CREDENTIAL_UNAUTHORIZED  — SecretRef policy refusal (not_authorized, binding
 *                              mismatches)
 *   CREDENTIAL_INVALID       — material unusable after release
 *   CREDENTIAL_MALFORMED_REF — malformed reference
 *   CREDENTIAL_BROKER_FAILURE— no_material / already_redeemed / broker error
 *
 * Rust parity (REQ-0005 section 16): the resolve() contract is
 * `resolve({ credentialRef, node }) -> { kind: 'bearer'|'header', token }` or a
 * thrown error with one of the codes above — JSON-shape portable.
 */

export const CREDENTIAL_RESOLUTION_ERRORS = Object.freeze({
  MISSING: 'CREDENTIAL_MISSING',
  UNAUTHORIZED: 'CREDENTIAL_UNAUTHORIZED',
  INVALID: 'CREDENTIAL_INVALID',
  MALFORMED_REF: 'CREDENTIAL_MALFORMED_REF',
  BROKER_FAILURE: 'CREDENTIAL_BROKER_FAILURE',
});

export class CredentialResolutionError extends Error {
  constructor(code, message, { reason = null } = {}) {
    super(message);
    this.name = 'CredentialResolutionError';
    this.code = code;
    this.reason = reason;
  }
}

const POLICY_REFUSALS = Object.freeze([
  'ref.not_authorized',
  'ref.tenant_mismatch',
  'ref.credential_mismatch',
  'ref.version_mismatch',
  'ref.request_mismatch',
  'ref.audience_mismatch',
  'ref.capability_mismatch',
]);

/**
 * Build the credential runtime over a SecretRef authority (the mint/redeem
 * layer over the P2.27 broker) and a credential record store.
 *
 * @param {object} options
 * @param {object} options.authority  createSecretRefAuthority(...) instance
 * @param {Map<string, object>|object} options.store  credential records by id
 *        (records carry metadata + material for materialOf; the store is the
 *        vault-side mapping, never exposed to node output)
 * @param {() => string} [options.requestId]  per-resolution request id source
 * @param {(event: string, detail: object) => void} [options.onEvent]
 */
export function createCredentialRuntime({ authority, store, requestId, onEvent = null, audience = 'httpRequest', capability = 'cap.http', principal = null, capabilityGrants = null } = {}) {
  if (!authority || typeof authority.mint !== 'function' || typeof authority.redeem !== 'function') {
    throw new TypeError('createCredentialRuntime requires a SecretRef authority with mint/redeem');
  }
  if (!(store instanceof Map) && (store === null || typeof store !== 'object')) {
    throw new TypeError('createCredentialRuntime requires a credential store (Map or object by id)');
  }
  const records = store instanceof Map ? store : new Map(Object.entries(store));
  let sequence = 0;
  const nextRequestId = requestId ?? (() => `credreq_${(sequence += 1).toString(36)}`);
  const listeners = typeof onEvent === 'function' ? [onEvent] : [];
  const emit = (event, detail) => {
    for (const listener of listeners) listener(event, detail);
  };

  function recordOf(credentialRef) {
    const id = typeof credentialRef === 'string' ? credentialRef : credentialRef?.id;
    if (typeof id !== 'string' || id === '') {
      throw new CredentialResolutionError(CREDENTIAL_RESOLUTION_ERRORS.MISSING, 'credentialRef must be a non-empty id');
    }
    const record = records.get(id) ?? null;
    if (record === null) {
      throw new CredentialResolutionError(CREDENTIAL_RESOLUTION_ERRORS.MISSING, `credential ${id} is not in the store`, { reason: 'not_found' });
    }
    return { id, record };
  }

  function kindOf(record, authentication) {
    // The runtime decides the kind from the record type (reference tokens).
    if (record.type === 'httpBearerAuth') return 'bearer';
    if (record.type === 'httpHeaderAuth') return 'header';
    if (authentication) return authentication;
    return record.authKind ?? 'bearer';
  }

  return Object.freeze({
    /**
     * Resolve a credentialRef to usable material for ONE request. The material
     * lives inside a single-use SecretRef redeemed immediately; the ref is
     * bound to this request id and the httpRequest audience.
     */
    resolve({ credentialRef, node = null, authentication = null, principal: principalOverride = null, tenantId = 'default', capabilityGrants: grantsOverride = null } = {}) {
      const grantsToUse = grantsOverride ?? capabilityGrants ?? [capability];
      const principalToUse = principalOverride ?? principal;
      const { id, record } = recordOf(credentialRef);
      const reqId = nextRequestId();
      let ref;
      try {
        ref = authority.mint({
          principal: principalToUse,
          credential: {
            id,
            credentialVersion: record.credentialVersion ?? 1,
            data: record.data ?? {},
            type: record.type,
          },
          requestId: reqId,
          audience,
          capability,
          permission: 'credential:read',
          tenantId: record.tenantId ?? tenantId,
          capabilityGrants: grantsToUse,
        });
      } catch (error) {
        const reason = error?.reason ?? error?.message ?? 'mint_failed';
        if (POLICY_REFUSALS.includes(reason)) {
          throw new CredentialResolutionError(CREDENTIAL_RESOLUTION_ERRORS.UNAUTHORIZED, 'secret ref mint refused', { reason });
        }
        if (reason === 'ref.malformed') {
          throw new CredentialResolutionError(CREDENTIAL_RESOLUTION_ERRORS.MALFORMED_REF, 'secret ref malformed', { reason });
        }
        throw new CredentialResolutionError(CREDENTIAL_RESOLUTION_ERRORS.BROKER_FAILURE, 'secret broker mint failed', { reason: String(reason).slice(0, 64) });
      }

      let material;
      try {
        material = authority.redeem(ref, { requestId: reqId, audience, capability });
      } catch (error) {
        const reason = error?.reason ?? error?.message ?? 'redeem_failed';
        if (POLICY_REFUSALS.includes(reason)) {
          throw new CredentialResolutionError(CREDENTIAL_RESOLUTION_ERRORS.UNAUTHORIZED, 'secret ref redeem refused', { reason });
        }
        if (reason === 'ref.malformed') {
          throw new CredentialResolutionError(CREDENTIAL_RESOLUTION_ERRORS.MALFORMED_REF, 'secret ref malformed', { reason });
        }
        throw new CredentialResolutionError(CREDENTIAL_RESOLUTION_ERRORS.BROKER_FAILURE, 'secret broker failed to release material', { reason: String(reason).slice(0, 64) });
      }

      // materialOf returns a JSON envelope { value, name? } for header auth, or
      // the raw token string for bearer - accept both, explicitly.
      let token = null;
      if (typeof material === 'string') {
        try {
          const parsed = JSON.parse(material);
          token = typeof parsed?.value === 'string' ? parsed.value : material;
        } catch {
          token = material;
        }
      } else if (material && typeof material === 'object' && typeof material.value === 'string') {
        token = material.value;
      }
      if (typeof token !== 'string' || token === '') {
        throw new CredentialResolutionError(CREDENTIAL_RESOLUTION_ERRORS.INVALID, 'released material carries no usable token');
      }
      const kind = kindOf(record, authentication);
      if (kind !== 'bearer' && kind !== 'header') {
        throw new CredentialResolutionError(CREDENTIAL_RESOLUTION_ERRORS.INVALID, `unsupported credential kind ${String(kind).slice(0, 32)}`);
      }
      emit('credential-resolved', { credentialId: id, kind, requestId: reqId });
      return Object.freeze({ kind, token, credentialId: id });
    },
    /** The seam shape handed to createNodeRegistry({ credentials }). */
    asContext() {
      return Object.freeze({
        resolve: (args) => this.resolve(args),
      });
    },
  });
}
