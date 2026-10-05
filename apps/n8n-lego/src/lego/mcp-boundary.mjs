/**
 * MCP vs Agent Control boundary — the four-state declaration (P2.20).
 *
 * PUBLIC CONTRACT: ai.mcp-boundary@1.0.0 (owner: manager).
 *
 * This module declares EXACTLY where MCP interoperability ends and Agent
 * Control authority begins. It is a boundary contract and a state machine —
 * nothing more. There is no MCP server, no MCP client, no adapter runtime, no
 * SDK, no daemon, no socket and no network call anywhere in this file; the
 * future adapter (P3/FUTURE) binds HERE, it does not live here.
 *
 * THE FOUR STATES (quoted from manifest/ai-foundation.json#mcp.states)
 * -------------------------------------------------------------------
 *   declared           known as a declaration; no authority implied
 *   permission-required  known, but not exposed until an explicit decision
 *   exposed            explicitly exposed after the permission gate passes
 *   blocked            prohibited, unknown, invalid or denied (fail-closed)
 *
 * The roadmap names permission-required / exposed / blocked and requires four
 * declared states; no authoritative fourth state existed in the repository, so
 * the least-privileged semantic `declared` is the only addition (Master Prompt
 * P2.20 §9). Names like trusted / authorized / available / active / allowed /
 * connected are NOT boundary vocabulary and never appear as states.
 *
 * THE ABSOLUTE AUTHORITY RULE
 * ---------------------------
 * MCP exposure NEVER implies Agent Control authority, and Agent Control
 * authority NEVER implies MCP exposure. Declaring a server is not trusting it;
 * declaring a capability is not exposing it; exposing a capability grants no
 * agent permission. Every transition is explicit and driven by the documented
 * permission gate — there is no export-everything switch and no inference from
 * names, descriptions, transports, server identities or providers.
 *
 * Vocabulary (states, concepts, roles, gate order, authority/fail-closed
 * rules) is quoted from manifest/ai-foundation.json through the
 * ai.foundation accessors; operations and permissions are the domain-declared
 * ones from manifest/domains.json. Permission satisfaction is delegated to
 * ai.approval@1.0.0 (P2.19) by dependency injection — this module never
 * re-implements approval semantics and never reads agent permissions.
 *
 * Owner of the contract: manager. Implementation: agent-1 (P2.20).
 */
import { AI_FOUNDATION } from './ai-foundation.mjs';

/* ---------------------------------------------------------------- contract */

export const MCP_BOUNDARY_CONTRACT = Object.freeze({
  id: "ai.mcp-boundary",
  version: '1.0.0',
  owner: 'manager',
  /** Canonical declaration fields, quoted from the mcp block of the manifest. */
  fields: Object.freeze([
    'serverId',
    'kind',
    'state',
    'provenance',
    'declaredAt',
    'capabilities',
    'capabilityId',
    'requiresApproval',
    'requiresPermission',
    'mappedCapability',
    'descriptionRef',
    'reason',
  ]),
});

export const MCP_BOUNDARY_CONTRACT_VERSION = MCP_BOUNDARY_CONTRACT.version;
export const MCP_BOUNDARY_FIELDS = MCP_BOUNDARY_CONTRACT.fields;

/** The four canonical boundary states — quoted, never extended here. */
export const MCP_BOUNDARY_STATES = Object.freeze([...AI_FOUNDATION.mcp.states]);

/** MCP capability kinds (tool | resource | prompt) — quoted, subset of concepts. */
export const MCP_CAPABILITY_KINDS = Object.freeze([...AI_FOUNDATION.mcp.capabilityKinds]);

/** MCP roles (mcp-server | mcp-client) — quoted from mcp.roles. */
export const MCP_ROLE_KINDS = Object.freeze(Object.keys(AI_FOUNDATION.mcp.roles));

/** Domain-declared operations + permissions (manifest/domains.json). */
export const MCP_BOUNDARY_OPERATIONS = Object.freeze(['declare', 'evaluate', 'revoke', 'inspect']);
export const MCP_BOUNDARY_PERMISSIONS = Object.freeze([
  'ai:mcp:read',
  'ai:mcp:declare',
  'ai:mcp:expose',
]);

export const MCP_BOUNDARY_LIMITS = Object.freeze({
  maxServers: 64,
  maxCapabilitiesPerServer: 32,
  maxIdentifierLength: 64,
  maxProvenanceLength: 160,
  maxDescriptionRefLength: 128,
  maxReasonLength: 64,
  maxPermissionLength: 96,
});

/** The explicit transition graph — quoted from mcp.transitions (§25). */
export const MCP_BOUNDARY_TRANSITIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(AI_FOUNDATION.mcp.transitions).map(([from, to]) => [from, Object.freeze([...to])]),
  ),
);

/** The permission gate, in canonical order — quoted from mcp.permissionGate. */
export const MCP_PERMISSION_GATE = Object.freeze([...AI_FOUNDATION.mcp.permissionGate]);

/* ------------------------------------------------------------------ errors */

export class McpBoundaryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'McpBoundaryError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details = {}) {
  throw new McpBoundaryError('lego.contract_violation', message, details);
}

/* -------------------------------------------------------------- primitives */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const REFERENCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PERMISSION_RE = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/;
const ABSOLUTE_PATH_RE = /^(?:\/|~\/|[A-Za-z]:[\\/])/;
const TRAVERSAL_RE = /(^|\/)\.\.(\/|$)/;
const SENSITIVE_TEXT = /(?:BEGIN\s+(?:RSA|OPENSSH|PRIVATE)\s+KEY|(?:^|\W)sk-[a-z0-9]{8,}|(?:^|\W)ghp_[a-z0-9]{8,}|(?:^|\W)github_pat_[a-z0-9_]{8,}|Bearer\s+[a-z0-9._-]+)/i;

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be a plain object`);
  return value;
}

function assertId(value, field) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    fail(`${field} must match ${ID_RE} (1..${MCP_BOUNDARY_LIMITS.maxIdentifierLength} characters)`);
  }
  return value;
}

function assertText(value, field, maxLength, { required = true, nullable = false } = {}) {
  if (value === undefined || value === null) {
    if (required && !nullable) fail(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    fail(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  if (SENSITIVE_TEXT.test(value)) {
    fail(`${field} carries secret-shaped material — MCP boundary declarations never record credentials or tokens`, { field });
  }
  return value;
}

function assertOpaqueRef(value, field) {
  if (value === undefined || value === null) return null;
  const ref = assertText(value, field, MCP_BOUNDARY_LIMITS.maxDescriptionRefLength, { nullable: true });
  if (ref === null) return null;
  if (TRAVERSAL_RE.test(ref) || ABSOLUTE_PATH_RE.test(ref)) {
    fail(`${field} must be an opaque reference — path-shaped values (../, absolute, ~/ or drive letters) are refused`, { field });
  }
  if (ref.includes('\0')) fail(`${field} must not contain NUL bytes`, { field });
  return ref;
}

function assertPermission(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > MCP_BOUNDARY_LIMITS.maxPermissionLength) {
    fail(`${field} must be a non-empty namespaced permission string of at most ${MCP_BOUNDARY_LIMITS.maxPermissionLength} characters`);
  }
  if (SENSITIVE_TEXT.test(value)) fail(`${field} carries secret-shaped material`, { field });
  if (!PERMISSION_RE.test(value)) {
    fail(`${field} must be a namespaced permission (e.g. group:name) — received '${value}'`, { field });
  }
  return value;
}

function assertIso(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

/* -------------------------------------------------------------- foundation */

function makeBoundary(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const approval = options.approval ?? null;
  if (typeof now !== 'function') fail('now must be a function returning an ISO timestamp');
  if (approval !== null && (typeof approval !== 'object' || typeof approval.evaluate !== 'function')) {
    fail('approval must expose an evaluate(approvalId, {identity, scope}) function (ai.approval@1.0.0)');
  }
  const limits = Object.freeze({ ...MCP_BOUNDARY_LIMITS, ...(options.limits ?? {}) });

  function clock() {
    const value = now();
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('now() must return an ISO timestamp');
    return new Date(value).toISOString();
  }

  /** serverId -> { record, caps: Map<capabilityId, record> } */
  const servers = new Map();

  function outcome(serverId, capabilityId, state, reason, changed, approvalReference = null) {
    if (!MCP_BOUNDARY_STATES.includes(state)) fail(`internal: outcome state '${state}' is not a canonical boundary state`);
    return Object.freeze({ serverId, capabilityId, state, reason, changed, approvalReference });
  }

  function applyTransition(capability, next, reason) {
    const allowed = MCP_BOUNDARY_TRANSITIONS[capability.state] ?? [];
    if (capability.state === next) {
      capability.reason = reason;
      return false; // no edge traversed
    }
    if (!allowed.includes(next)) {
      fail(`invalid state transition '${capability.state}' -> '${next}' for capability '${capability.capabilityId}'`, {
        from: capability.state,
        to: next,
        allowed,
      });
    }
    capability.state = next;
    capability.reason = reason;
    return true;
  }

  function serverView(server) {
    return freezeDeep({
      serverId: server.serverId,
      kind: server.kind,
      state: server.state,
      provenance: server.provenance,
      declaredAt: server.declaredAt,
      capabilities: [...server.caps.values()].map((cap) => ({
        capabilityId: cap.capabilityId,
        kind: cap.kind,
        state: cap.state,
        requiresApproval: cap.requiresApproval,
        requiresPermission: cap.requiresPermission,
        mappedCapability: cap.mappedCapability,
        descriptionRef: cap.descriptionRef,
        provenance: cap.provenance,
        declaredAt: cap.declaredAt,
        reason: cap.reason,
      })),
    });
  }

  const boundary = {
    /**
     * Declare one MCP server and its EXPLICIT capability export list.
     * Every capability starts at `declared` — declaration grants nothing.
     */
    declare(input) {
      assertPlainObject(input, 'declare input');
      const { serverId, kind, provenance, capabilities } = input;
      assertId(serverId, 'serverId');
      if (servers.has(serverId)) {
        fail(`server '${serverId}' was already declared — duplicate declarations are refused`, { serverId });
      }
      if (servers.size >= limits.maxServers) {
        fail(`MCP boundary is bounded at ${limits.maxServers} servers`, { limit: 'maxServers' });
      }
      if (typeof kind !== 'string' || !MCP_ROLE_KINDS.includes(kind)) {
        fail(`kind must be one of ${MCP_ROLE_KINDS.join(', ')} — received '${String(kind)}'`, { kind });
      }
      const safeProvenance = assertText(provenance, 'provenance', limits.maxProvenanceLength);
      if (!Array.isArray(capabilities) || capabilities.length === 0) {
        fail('capabilities must be a non-empty array — an empty or missing export list is malformed (individual, explicit export only)');
      }
      if (capabilities.length > limits.maxCapabilitiesPerServer) {
        fail(`capabilities is bounded at ${limits.maxCapabilitiesPerServer} entries per server`, { limit: 'maxCapabilitiesPerServer' });
      }

      const declaredAt = clock();
      const caps = new Map();
      for (const raw of capabilities) {
        assertPlainObject(raw, 'capability declaration');
        const capabilityId = assertId(raw.capabilityId, 'capabilityId');
        if (caps.has(capabilityId)) {
          fail(`capability '${capabilityId}' is declared twice on server '${serverId}'`, { capabilityId });
        }
        if (typeof raw.kind !== 'string' || !MCP_CAPABILITY_KINDS.includes(raw.kind)) {
          fail(`capability kind must be one of ${MCP_CAPABILITY_KINDS.join(', ')} — received '${String(raw.kind)}'`, { capabilityId, kind: raw.kind });
        }
        if (typeof raw.requiresApproval !== 'boolean') {
          fail('requiresApproval must be an explicit boolean — no default is inferred', { capabilityId });
        }
        const requiresPermission = assertPermission(raw.requiresPermission, 'requiresPermission');
        const mappedCapability = assertId(raw.mappedCapability, 'mappedCapability');
        const descriptionRef = assertOpaqueRef(raw.descriptionRef, 'descriptionRef');
        const capProvenance = raw.provenance === undefined
          ? safeProvenance
          : assertText(raw.provenance, 'provenance', limits.maxProvenanceLength);
        // Capability records stay internally mutable so the transition guard
        // can move them along the canonical graph; every READ path freezes a
        // view (serverView), so callers only ever see immutable snapshots.
        caps.set(capabilityId, {
          capabilityId,
          kind: raw.kind,
          state: 'declared',
          requiresApproval: raw.requiresApproval,
          requiresPermission,
          mappedCapability,
          descriptionRef,
          provenance: capProvenance,
          declaredAt,
          reason: 'declared',
        });
      }

      const record = Object.freeze({
        serverId,
        kind,
        state: 'declared',
        provenance: safeProvenance,
        declaredAt,
        caps,
      });
      servers.set(serverId, record);
      return serverView(record);
    },

    /**
     * Run the canonical permission gate against one declared capability.
     * Fail-closed: unknown server / unknown capability / permission claims /
     * non-granted approvals all answer `blocked` (or `permission-required`
     * while a decision is genuinely pending). Exposure is never inferred.
     *
     * @returns {{serverId, capabilityId, state, reason, changed, approvalReference}}
     */
    evaluate(input) {
      assertPlainObject(input, 'evaluate input');
      const {
        serverId, capabilityId,
        approvalReference = null, identity = null, scope = null,
        permission = null,
      } = input;
      assertId(serverId, 'serverId');
      assertId(capabilityId, 'capabilityId');
      if (approvalReference !== null) assertId(approvalReference, 'approvalReference');
      if (identity !== null) assertText(identity, 'identity', limits.maxIdentifierLength);
      if (scope !== null) assertText(scope, 'scope', limits.maxIdentifierLength);

      // Gate step 1: is the server declared?
      const server = servers.get(serverId);
      if (!server) return outcome(serverId, capabilityId, 'blocked', 'unknown-server', false);
      if (server.state === 'blocked') {
        return outcome(serverId, capabilityId, 'blocked', 'server-blocked', false);
      }
      // Gate step 2: is the capability declared?
      const cap = server.caps.get(capabilityId);
      if (!cap) return outcome(serverId, capabilityId, 'blocked', 'unknown-capability', false);
      if (cap.state === 'blocked') {
        return outcome(serverId, capabilityId, 'blocked', cap.reason ?? 'blocked', false);
      }
      // A caller-claimed permission is NEVER evidence at this boundary —
      // unknown/unverifiable permissions fail closed (§17/§18). Checked after
      // the declaration steps so the canonical gate order stays intact.
      if (permission !== null && permission !== undefined) {
        assertPermission(permission, 'permission');
        applyTransition(cap, 'blocked', 'unknown-permission');
        return outcome(serverId, capabilityId, 'blocked', 'unknown-permission', true);
      }
      // Gate step 3: is the capability supported?
      if (!MCP_CAPABILITY_KINDS.includes(cap.kind)) {
        const changed = applyTransition(cap, 'blocked', 'unsupported-capability');
        return outcome(serverId, capabilityId, 'blocked', 'unsupported-capability', changed);
      }
      if (cap.state === 'exposed') {
        return outcome(serverId, capabilityId, 'exposed', 'already-exposed', false, approvalReference);
      }

      const permissionRequired = cap.requiresApproval === true || cap.requiresPermission !== null;
      // Gate step 4/5/6: is permission required, and has an explicit grant
      // been presented (via ai.approval@1.0.0 only)?
      if (!permissionRequired) {
        const changed = applyTransition(cap, 'exposed', 'permission-not-required');
        return outcome(serverId, capabilityId, 'exposed', 'permission-not-required', changed, null);
      }
      if (approvalReference === null) {
        const changed = cap.state === 'declared'
          ? applyTransition(cap, 'permission-required', 'permission-required')
          : false;
        return outcome(serverId, capabilityId, 'permission-required', 'permission-required', changed, null);
      }
      if (approval === null) {
        // Fail closed as a contract violation: the gate cannot pass without
        // its approval evaluator, and silently exposing would be an implicit grant.
        fail('approval foundation not wired — a permission-gated capability cannot be evaluated without ai.approval@1.0.0', {
          serverId,
          capabilityId,
        });
      }
      const verdict = approval.evaluate(approvalReference, { identity, scope });
      if (verdict.decision === 'granted') {
        const changed = applyTransition(cap, 'exposed', 'approval-granted');
        return outcome(serverId, capabilityId, 'exposed', 'approval-granted', changed, approvalReference);
      }
      if (verdict.reason === 'not-granted') {
        // Genuinely pending: permission-required, not blocked (§25 keeps the
        // decision edge open) — and definitely not exposed.
        const changed = cap.state === 'declared'
          ? applyTransition(cap, 'permission-required', 'not-granted')
          : false;
        return outcome(serverId, capabilityId, 'permission-required', 'not-granted', changed, approvalReference);
      }
      // denied / expired / unknown-approval / scope-mismatch / identity-mismatch
      const reason = verdict.reason ?? 'denied';
      const changed = applyTransition(cap, 'blocked', reason);
      return outcome(serverId, capabilityId, 'blocked', reason, changed, approvalReference);
    },

    /**
     * Explicit revocation / blocking. `capabilityId: null` blocks the whole
     * server and cascades. Unknown targets are rejected (an explicit op on a
     * target that does not exist is malformed intent, not a gate answer).
     */
    revoke(input) {
      assertPlainObject(input, 'revoke input');
      const { serverId, capabilityId = null, reason = null } = input;
      assertId(serverId, 'serverId');
      const safeReason = reason === null || reason === undefined
        ? null
        : assertText(reason, 'reason', limits.maxReasonLength, { nullable: true });
      const server = servers.get(serverId);
      if (!server) fail(`unknown server '${serverId}' — revoke only operates on declared servers`, { serverId });

      if (capabilityId === null || capabilityId === undefined) {
        // Server-level block: explicit, cascading, idempotent. Every capability
        // walks the transition guard so `blocked` stays the only reachable
        // terminal state, and evaluate enforces server-blocked on read.
        const alreadyBlocked = server.state === 'blocked';
        if (!alreadyBlocked) {
          for (const cap of server.caps.values()) {
            if (cap.state !== 'blocked' && (MCP_BOUNDARY_TRANSITIONS[cap.state] ?? []).includes('blocked')) {
              cap.state = 'blocked';
              cap.reason = safeReason ?? 'server-blocked';
            }
          }
          servers.set(serverId, Object.freeze({ ...server, state: 'blocked' }));
        }
        return freezeDeep({
          serverId,
          capabilityId: null,
          state: 'blocked',
          blocked: server.caps.size,
          reason: safeReason ?? 'server-blocked',
          changed: !alreadyBlocked,
        });
      }

      assertId(capabilityId, 'capabilityId');
      const cap = server.caps.get(capabilityId);
      if (!cap) fail(`unknown capability '${capabilityId}' on server '${serverId}'`, { serverId, capabilityId });
      if (cap.state === 'blocked') {
        return freezeDeep({
          serverId,
          capabilityId,
          state: 'blocked',
          reason: cap.reason ?? 'blocked',
          changed: false,
        });
      }
      // Transition guard: every path to blocked must be a declared edge.
      const allowed = MCP_BOUNDARY_TRANSITIONS[cap.state] ?? [];
      if (!allowed.includes('blocked')) {
        fail(`invalid state transition '${cap.state}' -> 'blocked' for capability '${capabilityId}'`, { from: cap.state });
      }
      cap.state = 'blocked';
      cap.reason = safeReason ?? 'revoked';
      return freezeDeep({
        serverId,
        capabilityId,
        state: 'blocked',
        reason: cap.reason,
        changed: true,
      });
    },

    /** Read a declaration. Unknown server → null (inspection is not evaluation). */
    inspect(serverId) {
      assertId(serverId, 'serverId');
      const server = servers.get(serverId);
      if (!server) return null;
      return serverView(server);
    },

    get size() {
      return servers.size;
    },
    clear() {
      servers.clear();
    },
  };
  return boundary;
}

/**
 * Create an MCP boundary declaration instance.
 * @param {{ now?: () => string, approval?: {evaluate: Function}, limits?: object }} [options]
 */
export function createMcpBoundary(options = {}) {
  return makeBoundary(options);
}
