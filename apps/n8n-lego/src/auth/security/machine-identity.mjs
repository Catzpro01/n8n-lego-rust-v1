/**
 * P5.7 — Machine identity: API-key principals, service principals, agent
 * delegation, tenant security policy inputs and the authority chain
 *
 *     principal → capability → authorization → risk/approval inputs → execution
 *
 * HTTP-free, storage-free, network-free. Every function is a pure decision over
 * values the caller loaded; nothing here reads a store, a clock it was not
 * given, or a secret.
 *
 * THREE THINGS STAY SEPARATE (Issue #220 critical invariant):
 *
 *   Authentication  proves WHICH principal is calling (api-key.mjs verifies a
 *                   key; this module turns a verified record into a snapshot).
 *   Authorization   decides whether that principal holds the permission — the
 *                   P5.3 engine (`authorize`), reused, not re-implemented.
 *   Approval        decides whether a human signed off on a consequential act —
 *                   the manager-owned `ai.approval` foundation, reached through
 *                   an injected port. P5 produces the request INPUT and consumes
 *                   the fail-closed `evaluate` answer; it never stores, resolves
 *                   or defaults an approval.
 *
 * NO EXTRA AUTHORITY. A machine identity's permissions are always a subset of
 * what its accountable human may grant at the moment of the request:
 *   - key / service scopes ∩ the owner's CURRENT grantable scopes (a demotion
 *     shrinks every key immediately);
 *   - a delegated agent holds a subset of its parent, never outlives it, never
 *     changes tenant, never exceeds the parent's auth strength, and cannot
 *     re-delegate past a bounded depth.
 * `identityId` on every machine snapshot is the accountable human; the machine
 * is `principalId`. Nothing about being an agent adds a permission.
 *
 * NO PERSONAL CREDENTIAL FOR WORKERS. A service principal authenticates with its
 * own service credential (`audience: service-principal`), never with a user's
 * password, session cookie or personal API key.
 */
import { authorize, DECISION } from './authorization.mjs';
import {
  AUTH_STRENGTHS,
  DEFAULT_TENANT,
  authStrengthRank,
  createPrincipalSnapshot,
  isPrincipalSnapshot,
} from './principal.mjs';
import { SecurityError, SECURITY_REASON } from './security-error.mjs';
import {
  API_KEY_AUDIENCE,
  API_KEY_POLICY,
  API_KEY_PREFIX,
  attenuateScopes,
  effectiveScopes,
  generateApiKey,
} from './api-key.mjs';

/** Issue #220: "service principal model for workers/agents/MCP/gateway". */
export const SERVICE_PRINCIPAL_KINDS = Object.freeze(['worker', 'agent', 'mcp', 'gateway']);

export const MACHINE_IDENTITY_LIMITS = Object.freeze({
  maxServicePrincipalsPerOwner: 20,
  maxDelegationDepth: 3,
  maxDelegationTtlMs: 24 * 60 * 60 * 1000,
  maxScopeReferenceLength: 128,
});

/** Outcomes of the authority chain. `approval-required` is not an allow. */
export const MACHINE_OUTCOME = Object.freeze({
  ALLOW: 'allow',
  DENY: 'deny',
  APPROVAL_REQUIRED: 'approval-required',
});

/** Audit event types. Payloads carry references and reasons only. */
export const MACHINE_AUDIT_EVENTS = Object.freeze([
  'api-key.created',
  'api-key.updated',
  'api-key.revoked',
  'api-key.denied',
  'service-principal.created',
  'service-principal.revoked',
  'service-principal.transferred',
  'service-principal.denied',
  'delegation.granted',
  'delegation.denied',
  'machine-action.approval-required',
  'machine-action.denied',
]);

const AUDIT_FIELDS = Object.freeze([
  'tenantId',
  'principalRef',
  'ownerRef',
  'keyRef',
  'kind',
  'reason',
  'action',
  'outcome',
  'scopeCount',
  'approvalRef',
  // Accountability changed on both sides of a transfer, so the audit row names
  // both owners rather than only the new one.
  'fromRef', 'toRef',
]);

function deny(code, message, details) {
  throw new SecurityError(code, message, { details });
}

/* ------------------------------------------------------ tenant policy input */

/**
 * Tenant security policy — the INPUT tenant-aware decisions read. P5.7 does not
 * provision tenants (P10); it defines the shape, validates it and applies it.
 *
 * @param {object} [input]
 * @param {{ approvalActions?: readonly string[] }} [vocabulary] canonical approval
 *   actions (from `ai.approval`), required when approval actions are listed —
 *   so a policy cannot invent an approval vocabulary of its own.
 * @returns {Readonly<object>}
 */
export function createTenantSecurityPolicy(input = {}, { approvalActions = null } = {}) {
  const tenantId = input.tenantId ?? DEFAULT_TENANT;
  if (typeof tenantId !== 'string' || tenantId === '' || tenantId.length > 128) {
    deny(SECURITY_REASON.MALFORMED_INPUT, 'tenantId must be a short non-empty string', { field: 'tenantId' });
  }
  const policyVersion = input.policyVersion ?? 0;
  if (!Number.isInteger(policyVersion) || policyVersion < 0) {
    deny(SECURITY_REASON.MALFORMED_INPUT, 'policyVersion must be a non-negative integer', { field: 'policyVersion' });
  }
  const apiKeys = input.apiKeys ?? {};
  const maxTtlSeconds = apiKeys.maxTtlSeconds ?? null;
  if (maxTtlSeconds !== null && (!Number.isInteger(maxTtlSeconds) || maxTtlSeconds < 60)) {
    deny(SECURITY_REASON.MALFORMED_INPUT, 'apiKeys.maxTtlSeconds must be an integer of at least 60, or null', { field: 'apiKeys.maxTtlSeconds' });
  }
  const services = input.servicePrincipals ?? {};
  const kinds = services.kinds ?? SERVICE_PRINCIPAL_KINDS;
  for (const kind of kinds) {
    if (!SERVICE_PRINCIPAL_KINDS.includes(kind)) {
      deny(SECURITY_REASON.MALFORMED_INPUT, `unknown service principal kind '${kind}'`, { field: 'servicePrincipals.kinds' });
    }
  }
  const agents = input.agents ?? {};
  const maxDelegationDepth = agents.maxDelegationDepth ?? MACHINE_IDENTITY_LIMITS.maxDelegationDepth;
  if (!Number.isInteger(maxDelegationDepth) || maxDelegationDepth < 0 || maxDelegationDepth > MACHINE_IDENTITY_LIMITS.maxDelegationDepth) {
    deny(SECURITY_REASON.MALFORMED_INPUT, `agents.maxDelegationDepth must be 0..${MACHINE_IDENTITY_LIMITS.maxDelegationDepth}`, { field: 'agents.maxDelegationDepth' });
  }
  const approvalRequiredActions = [...new Set(agents.approvalRequiredActions ?? [])];
  if (approvalRequiredActions.length > 0) {
    if (!Array.isArray(approvalActions) || approvalActions.length === 0) {
      deny(SECURITY_REASON.MALFORMED_INPUT, 'approval-required actions need the canonical approval vocabulary', { field: 'agents.approvalRequiredActions' });
    }
    for (const action of approvalRequiredActions) {
      if (!approvalActions.includes(action)) {
        deny(SECURITY_REASON.MALFORMED_INPUT, `'${action}' is not a canonical approval action`, { field: 'agents.approvalRequiredActions' });
      }
    }
  }
  const approvalPrincipalTypes = agents.approvalPrincipalTypes ?? ['agent', 'service'];
  for (const type of approvalPrincipalTypes) {
    if (!['api-key', 'service', 'agent'].includes(type)) {
      deny(SECURITY_REASON.MALFORMED_INPUT, `approval cannot target principal type '${type}'`, { field: 'agents.approvalPrincipalTypes' });
    }
  }
  const risk = agents.risk ?? 'high';
  return Object.freeze({
    tenantId,
    policyVersion,
    apiKeys: Object.freeze({ enabled: apiKeys.enabled !== false, requireExpiry: apiKeys.requireExpiry === true, maxTtlSeconds }),
    servicePrincipals: Object.freeze({ enabled: services.enabled !== false, kinds: Object.freeze([...kinds]) }),
    agents: Object.freeze({
      maxDelegationDepth,
      approvalRequiredActions: Object.freeze(approvalRequiredActions),
      approvalPrincipalTypes: Object.freeze([...approvalPrincipalTypes]),
      risk,
    }),
  });
}

/** The single-tenant default: keys and services allowed, no forced approvals. */
export const DEFAULT_TENANT_SECURITY_POLICY = createTenantSecurityPolicy();

/**
 * Checks a key/credential expiry against tenant policy. Returns an upstream-
 * style message, or null when acceptable.
 *
 * @param {Readonly<object>} policy
 * @param {{ expiresAt: number|null, now?: number }} input expiresAt in unix SECONDS
 */
export function keyPolicyViolation(policy, { expiresAt, now = Date.now() }) {
  if (!policy.apiKeys.enabled) return 'API keys are disabled for this tenant';
  if (expiresAt !== null && expiresAt !== undefined) {
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= now / 1000) {
      return 'Expiration date must be in the future or null';
    }
  }
  if (policy.apiKeys.requireExpiry && (expiresAt === null || expiresAt === undefined)) {
    return 'This tenant requires API keys to expire';
  }
  if (policy.apiKeys.maxTtlSeconds !== null && expiresAt !== null && expiresAt !== undefined) {
    if (expiresAt - now / 1000 > policy.apiKeys.maxTtlSeconds) return 'Expiration exceeds the maximum key lifetime for this tenant';
  }
  return null;
}

/* -------------------------------------------------------- machine principal */

function ownerTenant(owner) {
  return typeof owner?.tenantId === 'string' && owner.tenantId !== '' ? owner.tenantId : DEFAULT_TENANT;
}

/**
 * Turns a VERIFIED key or service-credential record into a PrincipalSnapshot.
 * The caller has already checked the digest and the lifecycle verdict.
 *
 * @param {object} input
 * @param {object} input.record          stored key / service principal record
 * @param {object} input.owner           the accountable user record (loaded, not trusted for more than id/tenant)
 * @param {'api-key'|'service'} input.kind
 * @param {Iterable<string>} input.ownerGrantable what the owner may grant NOW
 * @param {ReadonlySet<string>} input.universe the canonical API-key universe
 * @param {number} input.principalVersion the owner's authority version
 * @param {number} [input.now]
 * @returns {Readonly<object>} PrincipalSnapshot
 */
export function machinePrincipal({ record, owner, kind, ownerGrantable, universe, principalVersion, now = Date.now() }) {
  if (!record || !owner) deny(SECURITY_REASON.NO_PRINCIPAL, 'a machine principal needs a verified record and its owner');
  if (!(universe instanceof Set) || universe.size === 0) {
    deny(SECURITY_REASON.AUTHORITY_UNAVAILABLE, 'the API-key permission universe is unavailable');
  }
  const tenantId = record.tenantId ?? DEFAULT_TENANT;
  if (tenantId !== ownerTenant(owner)) {
    deny(SECURITY_REASON.TENANT_MISMATCH, 'a machine identity cannot act outside its owner\'s tenant', { reason: 'owner-tenant-mismatch' });
  }
  const isService = kind === 'service';
  const principalType = isService ? (record.kind === 'agent' ? 'agent' : 'service') : 'api-key';
  return createPrincipalSnapshot({
    principalId: `${isService ? 'svc' : 'apikey'}:${record.id}`,
    identityId: owner.id,
    tenantId,
    principalType,
    authMethod: isService ? 'service-credential' : 'api-key',
    authStrength: 'api-key',
    permissions: effectiveScopes(record.scopes, ownerGrantable),
    principalVersion,
    issuedAt: now,
    expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt * 1000 : null,
    permissionUniverse: universe,
  });
}

/* ------------------------------------------------------- service principals */

/**
 * Creates a service principal record plus its one-time credential.
 *
 * @param {object} input
 * @param {string} input.id
 * @param {object} input.owner       accountable user record
 * @param {string} input.kind        one of SERVICE_PRINCIPAL_KINDS
 * @param {string} input.label
 * @param {string} [input.tenantId]  must equal the owner's tenant
 * @param {string[]} input.scopes    must be a subset of ownerGrantable
 * @param {Iterable<string>} input.ownerGrantable
 * @param {number|null} [input.expiresAt] unix seconds
 * @param {Readonly<object>} [input.policy]
 * @param {number} [input.existing]  how many the owner already has (bound)
 * @param {number} [input.now]
 * @returns {{ record: Readonly<object>, raw: string }}
 */
export function createServicePrincipalRecord({
  id,
  owner,
  kind,
  label,
  tenantId,
  scopes,
  ownerGrantable,
  expiresAt = null,
  policy = DEFAULT_TENANT_SECURITY_POLICY,
  existing = 0,
  now = Date.now(),
}) {
  if (!policy.servicePrincipals.enabled) deny(SECURITY_REASON.CAPABILITY_UNAVAILABLE, 'service principals are disabled for this tenant');
  if (!policy.servicePrincipals.kinds.includes(kind)) {
    deny(SECURITY_REASON.MALFORMED_INPUT, `service principal kind must be one of ${policy.servicePrincipals.kinds.join(', ')}`, { field: 'kind' });
  }
  if (typeof label !== 'string' || label.trim() === '' || label.length > API_KEY_POLICY.maxLabelLength) {
    deny(SECURITY_REASON.MALFORMED_INPUT, `label must be 1..${API_KEY_POLICY.maxLabelLength} characters`, { field: 'label' });
  }
  if (existing >= MACHINE_IDENTITY_LIMITS.maxServicePrincipalsPerOwner) {
    deny(SECURITY_REASON.MALFORMED_INPUT, `at most ${MACHINE_IDENTITY_LIMITS.maxServicePrincipalsPerOwner} service principals per owner`, { limit: 'maxServicePrincipalsPerOwner' });
  }
  const tenant = tenantId ?? ownerTenant(owner);
  if (tenant !== ownerTenant(owner) || tenant !== policy.tenantId) {
    deny(SECURITY_REASON.TENANT_MISMATCH, 'a service principal is bound to its owner\'s tenant', { reason: 'cross-tenant-create' });
  }
  const attenuated = attenuateScopes(scopes, ownerGrantable);
  if (!attenuated.ok) {
    deny(SECURITY_REASON.PERMISSION_DENIED, 'a service principal cannot hold scopes its owner cannot grant', {
      reason: 'scope-escalation',
      escalated: attenuated.escalated.slice(0, 16),
    });
  }
  const violation = keyPolicyViolation(policy, { expiresAt, now });
  if (violation) deny(SECURITY_REASON.MALFORMED_INPUT, violation, { field: 'expiresAt' });
  const credential = generateApiKey({ ownerId: owner.id, keyId: id });
  const at = new Date(now).toISOString();
  return {
    raw: credential.raw,
    record: Object.freeze({
      id,
      kind,
      label: label.trim(),
      tenantId: tenant,
      scopes: Object.freeze(attenuated.scopes),
      audience: API_KEY_AUDIENCE.SERVICE,
      digest: credential.digest,
      hint: credential.hint,
      createdAt: at,
      updatedAt: at,
      expiresAt: expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
    }),
  };
}

/* --------------------------------------------------------------- delegation */

function capStrength(parentStrength) {
  // A delegated machine never exceeds its parent, and never carries an
  // interactive strength (mfa / step-up) it did not itself prove.
  const cap = authStrengthRank('api-key');
  const rank = authStrengthRank(parentStrength);
  return AUTH_STRENGTHS[Math.min(rank, cap)];
}

/**
 * Delegates a subset of a parent's authority to an agent (or service).
 *
 * @param {Readonly<object>} parent PrincipalSnapshot of the delegator
 * @param {object} input
 * @param {string} input.principalId        the agent's id
 * @param {'agent'|'service'} [input.principalType]
 * @param {string[]} input.permissions      must be a subset of the parent's
 * @param {number} input.ttlMs              bounded by policy and by the parent
 * @param {string} [input.tenantId]         must equal the parent's tenant
 * @param {Readonly<object>|null} [input.parentGrant] the parent's own grant, when the parent is itself delegated
 * @param {Readonly<object>} [input.policy]
 * @param {string} input.grantId
 * @param {number} [input.now]
 * @returns {{ principal: Readonly<object>, grant: Readonly<object> }}
 */
export function delegate(parent, {
  principalId,
  principalType = 'agent',
  permissions,
  ttlMs,
  tenantId,
  parentGrant = null,
  policy = DEFAULT_TENANT_SECURITY_POLICY,
  grantId,
  now = Date.now(),
}) {
  if (!isPrincipalSnapshot(parent)) deny(SECURITY_REASON.NO_PRINCIPAL, 'delegation requires a valid parent principal');
  if (typeof parent.expiresAt === 'number' && now >= parent.expiresAt) {
    deny(SECURITY_REASON.SESSION_INVALID, 'an expired principal cannot delegate', { reason: 'parent-expired' });
  }
  if (parent.authStrength === 'none') deny(SECURITY_REASON.NO_PRINCIPAL, 'an unauthenticated principal cannot delegate');
  if (!['agent', 'service'].includes(principalType)) {
    deny(SECURITY_REASON.MALFORMED_INPUT, 'a delegate is an agent or a service', { field: 'principalType' });
  }
  if (parentGrant !== null && parentGrant.principalId !== parent.principalId) {
    deny(SECURITY_REASON.MALFORMED_INPUT, 'the parent grant does not belong to the parent principal', { reason: 'grant-principal-mismatch' });
  }
  const depth = (parentGrant?.depth ?? 0) + 1;
  if (depth > policy.agents.maxDelegationDepth) {
    deny(SECURITY_REASON.PERMISSION_DENIED, `delegation depth is bounded at ${policy.agents.maxDelegationDepth}`, { reason: 'delegation-depth', depth });
  }
  const tenant = tenantId ?? parent.tenantId;
  if (tenant !== parent.tenantId) {
    deny(SECURITY_REASON.TENANT_MISMATCH, 'delegation cannot cross a tenant boundary', { reason: 'cross-tenant-delegation' });
  }
  const attenuated = attenuateScopes(permissions, parent.permissions);
  if (!attenuated.ok) {
    deny(SECURITY_REASON.PERMISSION_DENIED, 'a delegate cannot hold permissions its parent does not hold', {
      reason: 'delegation-escalation',
      escalated: attenuated.escalated.slice(0, 16),
    });
  }
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MACHINE_IDENTITY_LIMITS.maxDelegationTtlMs) {
    deny(SECURITY_REASON.MALFORMED_INPUT, `ttlMs must be 1..${MACHINE_IDENTITY_LIMITS.maxDelegationTtlMs}`, { field: 'ttlMs' });
  }
  const expiresAt = typeof parent.expiresAt === 'number' ? Math.min(now + ttlMs, parent.expiresAt) : now + ttlMs;
  const principal = createPrincipalSnapshot({
    principalId,
    identityId: parent.identityId,
    tenantId: tenant,
    principalType,
    authMethod: 'service-credential',
    authStrength: capStrength(parent.authStrength),
    permissions: attenuated.scopes,
    principalVersion: parent.principalVersion,
    issuedAt: now,
    expiresAt,
    // The parent's own permissions ARE the universe for the child: a second,
    // independent subset check inside the constructor.
    permissionUniverse: new Set(parent.permissions),
  });
  const grant = Object.freeze({
    grantId,
    principalId,
    parentPrincipalId: parent.principalId,
    rootIdentityId: parent.identityId,
    tenantId: tenant,
    depth,
    permissions: principal.permissions,
    issuedAt: now,
    expiresAt,
  });
  return { principal, grant };
}

/* ---------------------------------------------------------- authority chain */

function scopeReference(resourceType, resourceId) {
  const ref = `${resourceType ?? 'resource'}:${resourceId ?? '*'}`;
  return ref.length > MACHINE_IDENTITY_LIMITS.maxScopeReferenceLength ? ref.slice(0, MACHINE_IDENTITY_LIMITS.maxScopeReferenceLength) : ref;
}

/**
 * The authority chain for one machine action.
 *
 *   1. authorization (P5.3 `authorize`): permission, tenant, capability,
 *      expiry, strength. A DENY here ends the chain — approval can never turn
 *      a missing permission into an allow.
 *   2. risk/approval input: when tenant policy marks the canonical action as
 *      approval-required for this principal type, the answer is
 *      `approval-required` with the request INPUT for `ai.approval.request`.
 *   3. with an approvalId: the port's fail-closed `evaluate` decides; the
 *      grant is fed back into `authorize` as its approval input, bound to this
 *      action and resource (confused-deputy guard).
 *
 * @param {object} input
 * @param {Readonly<object>} input.principal
 * @param {string} input.action                 canonical permission
 * @param {string} [input.resourceType]
 * @param {string} [input.resourceId]
 * @param {string} [input.resourceTenantId]
 * @param {string} [input.capability]
 * @param {string[]} [input.capabilityGrants]
 * @param {string} [input.approvalAction]       canonical ai.approval action, e.g. 'execute workflow'
 * @param {string} [input.approvalId]
 * @param {Readonly<object>} [input.policy]
 * @param {number} [input.now]
 * @param {object} [ports]
 * @param {Readonly<object>} [ports.registry]  permission registry for the principal's universe
 * @param {{ evaluate(id: string, q: { identity: string, scope: string }): { decision: string, reason: string|null } }|null} [ports.approvals]
 * @returns {Readonly<object>}
 */
export function decideMachineAction(input, { registry = null, approvals = null } = {}) {
  const policy = input.policy ?? DEFAULT_TENANT_SECURITY_POLICY;
  const request = {
    principal: input.principal,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    resourceTenantId: input.resourceTenantId,
    capability: input.capability,
    capabilityGrants: input.capabilityGrants,
    now: input.now,
  };
  const first = authorize(request, { registry });
  if (first.decision === DECISION.DENY) {
    return Object.freeze({ outcome: MACHINE_OUTCOME.DENY, reasonCode: first.reasonCode, decision: first, approvalRequest: null });
  }
  const principalType = input.principal.principalType;
  const needsApproval =
    typeof input.approvalAction === 'string' &&
    policy.agents.approvalRequiredActions.includes(input.approvalAction) &&
    policy.agents.approvalPrincipalTypes.includes(principalType);
  if (!needsApproval) {
    return Object.freeze({ outcome: MACHINE_OUTCOME.ALLOW, reasonCode: null, decision: first, approvalRequest: null });
  }
  const scope = scopeReference(input.resourceType, input.resourceId);
  if (typeof input.approvalId !== 'string' || input.approvalId === '') {
    return Object.freeze({
      outcome: MACHINE_OUTCOME.APPROVAL_REQUIRED,
      reasonCode: SECURITY_REASON.APPROVAL_MISMATCH,
      decision: first,
      approvalRequest: Object.freeze({ action: input.approvalAction, actor: input.principal.principalId, risk: policy.agents.risk, scope }),
    });
  }
  if (!approvals || typeof approvals.evaluate !== 'function') {
    // Fail closed: an approval was required and nobody can check it.
    return Object.freeze({ outcome: MACHINE_OUTCOME.DENY, reasonCode: SECURITY_REASON.APPROVAL_MISMATCH, decision: first, approvalRequest: null, approvalReason: 'approval-unavailable' });
  }
  const answer = approvals.evaluate(input.approvalId, { identity: input.principal.principalId, scope });
  const second = authorize(
    {
      ...request,
      approval: { granted: answer?.decision === 'granted', action: input.action, resourceId: input.resourceId },
    },
    { registry },
  );
  if (second.decision === DECISION.ALLOW) {
    return Object.freeze({ outcome: MACHINE_OUTCOME.ALLOW, reasonCode: null, decision: second, approvalRequest: null, approvalRef: input.approvalId });
  }
  return Object.freeze({
    outcome: MACHINE_OUTCOME.DENY,
    reasonCode: second.reasonCode,
    decision: second,
    approvalRequest: null,
    approvalReason: answer?.reason ?? 'not-granted',
  });
}

/* -------------------------------------------------------------------- audit */

/**
 * Builds an audit event with references and reasons only. Rejects any value
 * shaped like a credential, so a careless caller cannot put a key into an
 * audit line. The caller hands the event to the existing logger/observability
 * sink — P5.7 adds no audit store.
 *
 * @param {string} type one of MACHINE_AUDIT_EVENTS
 * @param {object} fields subset of the audit field whitelist
 * @param {number} [now]
 * @returns {Readonly<object>}
 */
export function machineAuditEvent(type, fields = {}, now = Date.now()) {
  if (!MACHINE_AUDIT_EVENTS.includes(type)) deny(SECURITY_REASON.MALFORMED_INPUT, `unknown machine audit event '${type}'`);
  const event = { type, at: new Date(now).toISOString() };
  for (const [key, value] of Object.entries(fields)) {
    if (!AUDIT_FIELDS.includes(key)) deny(SECURITY_REASON.MALFORMED_INPUT, `audit field '${key}' is not a reference field`, { field: key });
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      if (value.includes(API_KEY_PREFIX) || value.length > 160) {
        deny(SECURITY_REASON.MALFORMED_INPUT, `audit field '${key}' looks like credential material`, { field: key });
      }
    } else if (typeof value !== 'number' || !Number.isFinite(value)) {
      deny(SECURITY_REASON.MALFORMED_INPUT, `audit field '${key}' must be a string or a number`, { field: key });
    }
    event[key] = value;
  }
  return Object.freeze(event);
}
