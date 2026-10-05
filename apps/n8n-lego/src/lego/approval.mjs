/**
 * Approval foundation — the fail-closed decision boundary (P2.19).
 *
 * PUBLIC CONTRACT: ai.approval@1.0.0 (owner: manager).
 *
 * Consequential actions do not proceed here by default. An approval is a
 * bounded record: who asked (actor), for what (action), within which scope,
 * at what risk, and — only after an explicit resolve — what was decided
 * (granted | denied, or expired by the clock). Every read-side evaluation is
 * fail-closed: unknown approval, unknown decision, pending state, expired
 * deadline, scope mismatch and identity mismatch all answer DENY. There is no
 * implicit grant, no auto-grant, no silent grant and no authority inheritance.
 *
 * WHAT THIS IS NOT: an executor. The foundation decides; it never runs a
 * shell, a filesystem action, a process or a credential. It consumes the
 * Agent Machine's waiting boundary dependency-side: P2.16's machine carries
 * an approvalReference and stays fail-closed (cancel-only exit) — resolution
 * of that reference lives HERE, without touching ai.agent-machine@1.1.0.
 *
 * Vocabulary (fields, decisions, risk levels) is quoted from
 * manifest/ai-foundation.json through the ai.foundation accessors; operations
 * and permissions are the domain-declared ones from manifest/domains.json.
 *
 * Owner of the contract: manager. Implementation: agent-1 (P2.19).
 */
import { randomUUID } from 'node:crypto';

import { AI_FOUNDATION, RISK_LEVELS } from './ai-foundation.mjs';

/* ---------------------------------------------------------------- contract */

const CANONICAL_FIELDS = Object.freeze([...AI_FOUNDATION.approval.fields]);

export const APPROVAL_CONTRACT = Object.freeze({
  id: "ai.approval",
  version: '1.0.0',
  owner: 'manager',
  /** Canonical eight quoted from manifest/ai-foundation.json, plus the P2.19
   *  request-side fields the Master Prompt requires (first publication absorbs
   *  them): scope, state, contextReference, expiresAt, approver. */
  fields: Object.freeze([
    ...CANONICAL_FIELDS,
    'scope',
    'state',
    'contextReference',
    'expiresAt',
    'approver',
  ]),
  canonicalFields: CANONICAL_FIELDS,
});

export const APPROVAL_CONTRACT_VERSION = APPROVAL_CONTRACT.version;
export const APPROVAL_FIELDS = APPROVAL_CONTRACT.fields;

/** Canonical decision vocabulary (approval.decision): granted | denied | expired. */
export const APPROVAL_DECISIONS = Object.freeze([...AI_FOUNDATION.approval.decision]);
/** Canonical actions that require approval, quoted — not extended. */
export const APPROVAL_ACTIONS = Object.freeze([...AI_FOUNDATION.approval.actionsRequiringApproval]);

/**
 * Record states. The Artifact-style descriptor lists declared/requested/
 * pending/granted/denied/expired; the minimal lifecycle the Master Prompt
 * orders is requested → granted | denied (+ expired for the fail-closed
 * clock). `declared` is descriptor-level and `pending` would duplicate
 * `requested`, so neither is a record state.
 */
export const APPROVAL_STATES = Object.freeze(['requested', 'granted', 'denied', 'expired']);

/** Domain-declared operations + permissions (manifest/domains.json). */
export const APPROVAL_OPERATIONS = Object.freeze(['request', 'resolve', 'inspect']);
export const APPROVAL_PERMISSIONS = Object.freeze([
  'ai:approval:read',
  'ai:approval:request',
  'ai:approval:resolve',
]);

export const APPROVAL_LIMITS = Object.freeze({
  maxApprovals: 256,
  maxIdentifierLength: 64,
  maxActionLength: 128,
  maxActorLength: 128,
  maxScopeLength: 128,
  maxReasonLength: 64,
  maxReferenceIdLength: 128,
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const REFERENCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SENSITIVE_TEXT = /(?:BEGIN\s+(?:RSA|OPENSSH|PRIVATE)\s+KEY|(?:^|\W)sk-[a-z0-9]{8,}|(?:^|\W)ghp_[a-z0-9]{8,}|(?:^|\W)github_pat_[a-z0-9_]{8,}|Bearer\s+[a-z0-9._-]+)/i;

/* ------------------------------------------------------------------ errors */

export class ApprovalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details = {}) {
  throw new ApprovalError('lego.contract_violation', message, details);
}

/* -------------------------------------------------------------- primitives */

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
    fail(`${field} must match ${ID_RE} (1..${APPROVAL_LIMITS.maxIdentifierLength} characters)`);
  }
  return value;
}

function assertReference(value, field, { nullable = true } = {}) {
  if (value === undefined || value === null) {
    if (nullable) return null;
    fail(`${field} is required`);
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > APPROVAL_LIMITS.maxReferenceIdLength || !REFERENCE_ID_RE.test(value)) {
    fail(`${field} must be an opaque reference of 1..${APPROVAL_LIMITS.maxReferenceIdLength} characters`);
  }
  if (SENSITIVE_TEXT.test(value)) fail(`${field} carries secret-shaped material`, { field });
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
    fail(`${field} carries secret-shaped material — approvals never record credentials or tokens`, { field });
  }
  return value;
}

function isoOf(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`${field} must be an ISO timestamp`);
  }
  return new Date(value).toISOString();
}

/* --------------------------------------------------------------- foundation */

function makeFoundation(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  // Canonical identity mechanism (same as the envelope): randomness is fine
  // when it is the repository default AND injectable for deterministic tests.
  const newId = options.newId ?? (() => randomUUID());
  const limits = Object.freeze({ ...APPROVAL_LIMITS, ...(options.limits ?? {}) });
  if (typeof now !== 'function') fail('now must be a function returning an ISO timestamp');
  if (typeof newId !== 'function') fail('newId must be a function returning an identifier');

  const store = new Map();

  function clock() {
    const value = now();
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('now() must return an ISO timestamp');
    return new Date(value).toISOString();
  }

  function load(approvalId, operation) {
    const record = store.get(approvalId);
    if (!record) fail(`unknown approval '${approvalId}' (${operation})`, { approvalId, operation });
    return record;
  }

  function expiredByClock(record, at) {
    if (record.expiresAt === null) return false;
    return Date.parse(at) >= Date.parse(record.expiresAt);
  }

  function placeExpired(record, at) {
    if (record.state === 'expired') return record;
    const expired = Object.freeze({
      ...record,
      state: 'expired',
      decision: 'expired',
      resolvedAt: record.resolvedAt ?? at,
      reason: record.reason ?? 'expired',
    });
    store.set(record.approvalId, expired);
    return expired;
  }

  const foundation = {
    /**
     * Raise an approval request. `scope` is REQUIRED: an approval with no
     * boundary would be a global permission waiting to happen.
     */
    request(input) {
      assertPlainObject(input, 'request input');
      const {
        approvalId, action, actor, risk, scope,
        contextReference = null, expiresAt = null, idempotencyKey = null,
      } = input;
      assertId(approvalId, 'approvalId');
      if (store.has(approvalId)) {
        fail(`approval '${approvalId}' was already requested — duplicate requests are refused`, { approvalId });
      }
      if (store.size >= limits.maxApprovals) {
        fail(`approval foundation is bounded at ${limits.maxApprovals} records`, { limit: 'maxApprovals' });
      }
      const safeAction = assertText(action, 'action', limits.maxActionLength);
      const safeActor = assertText(actor, 'actor', limits.maxActorLength);
      if (typeof risk !== 'string' || !RISK_LEVELS.includes(risk)) {
        fail(`risk must be one of ${RISK_LEVELS.join(', ')}`, { risk });
      }
      const safeScope = assertText(scope, 'scope', limits.maxScopeLength);
      const safeContext = assertReference(contextReference, 'contextReference');
      const requestedAt = clock();
      const safeExpiresAt = isoOf(expiresAt, 'expiresAt');
      if (safeExpiresAt !== null && Date.parse(safeExpiresAt) <= Date.parse(requestedAt)) {
        fail('expiresAt must be after requestedAt — a request born expired is malformed', {
          requestedAt,
          expiresAt: safeExpiresAt,
        });
      }
      if (idempotencyKey !== undefined && idempotencyKey !== null) assertReference(idempotencyKey, 'idempotencyKey');
      const record = Object.freeze({
        approvalId,
        action: safeAction,
        actor: safeActor,
        risk,
        scope: safeScope,
        state: 'requested',
        contextReference: safeContext,
        requestedAt,
        expiresAt: safeExpiresAt,
        resolvedAt: null,
        decision: null,
        approver: null,
        reason: null,
      });
      store.set(approvalId, record);
      return freezeDeep({ ...record });
    },

    /**
     * Record a decision. Only granted | denied are resolutions; `expired`
     * arrives from the clock, never from a caller claiming it. A replay of
     * the SAME decision is idempotent; a different second decision is refused.
     */
    resolve(input) {
      assertPlainObject(input, 'resolve input');
      const { approvalId, decision, approver, reason = null } = input;
      assertId(approvalId, 'approvalId');
      const record = load(approvalId, 'resolve');
      if (decision !== 'granted' && decision !== 'denied') {
        fail(`decision must be one of granted, denied — received '${String(decision)}' (fail-closed: unknown decisions are never treated as allow)`, {
          decision: decision ?? null,
        });
      }
      const safeApprover = assertText(approver, 'approver', limits.maxActorLength);
      const safeReason = reason === null || reason === undefined ? null : assertText(reason, 'reason', limits.maxReasonLength, { nullable: true });
      const at = clock();

      if (expiredByClock(record, at)) {
        placeExpired(record, at);
        fail(`approval '${approvalId}' expired at ${record.expiresAt} — resolution refused (fail-closed deny)`, {
          approvalId,
          expiresAt: record.expiresAt,
        });
      }
      if (record.state !== 'requested') {
        if (record.state === decision) {
          // Deterministic replay: the same decision again changes nothing.
          return freezeDeep({ ...record });
        }
        fail(`approval '${approvalId}' is already '${record.state}' — a different second decision is refused`, {
          approvalId,
          state: record.state,
          decision,
        });
      }
      const resolved = Object.freeze({
        ...record,
        state: decision,
        decision,
        resolvedAt: at,
        approver: safeApprover,
        reason: safeReason,
      });
      store.set(approvalId, resolved);
      return freezeDeep({ ...resolved });
    },

    /** Read a record. Unknown → null (inspection is not evaluation). */
    inspect(approvalId) {
      assertId(approvalId, 'approvalId');
      const record = store.get(approvalId);
      if (!record) return null;
      const at = clock();
      const live = expiredByClock(record, at) ? placeExpired(record, at) : record;
      return freezeDeep({ ...live });
    },

    /**
     * The fail-closed decision boundary. ALLOW is only ever the explicit
     * outcome of a granted, unexpired, scope-matched, identity-matched
     * record — every other answer is DENY with a stable reason.
     *
     * @returns {{ approvalId: string, decision: 'granted'|'denied', reason: string|null, state: string }}
     */
    evaluate(approvalId, { identity = null, scope = null } = {}) {
      assertId(approvalId, 'approvalId');
      const at = clock();
      const answer = (reason, record = null) => Object.freeze({
        approvalId,
        decision: 'denied',
        reason,
        state: record ? record.state : 'unknown',
      });
      if (identity !== null && (typeof identity !== 'string' || identity.length === 0)) fail('identity must be a non-empty string when presented');
      if (scope !== null && (typeof scope !== 'string' || scope.length === 0)) fail('scope must be a non-empty string when presented');
      let record = store.get(approvalId);
      if (!record) return answer('unknown-approval');
      if (expiredByClock(record, at)) record = placeExpired(record, at);
      if (!APPROVAL_STATES.includes(record.state)) return answer('unknown-decision', record);
      if (record.decision !== null && !APPROVAL_DECISIONS.includes(record.decision)) return answer('unknown-decision', record);
      if (record.state === 'expired') return answer('expired', record);
      if (record.state !== 'granted' || record.decision !== 'granted') {
        const reason = record.state === 'requested'
          ? 'not-granted'
          : (record.state === 'denied' ? (record.reason ?? 'denied') : record.state);
        return answer(reason, record);
      }
      if (identity !== null && identity !== record.actor) return answer('identity-mismatch', record);
      if (scope !== null && scope !== record.scope) return answer('scope-mismatch', record);
      return Object.freeze({ approvalId, decision: 'granted', reason: null, state: 'granted' });
    },

    /**
     * Dependency-side waiting resolution (P2.17/P2.16 boundary consumer):
     * bind a waiting Agent Machine's approvalReference to this foundation's
     * decision WITHOUT touching ai.agent-machine@1.1.0. The machine stays
     * fail-closed (its only exit is still cancel); what resolves here is the
     * approval dependency it carries.
     *
     * Unknown approval → resolved:false / denied (§12: unknown approval DENY).
     */
    resolveWaiting({ machineReference, approvalReference, identity = null, scope = null } = {}) {
      assertPlainObject({ machineReference, approvalReference }, 'resolveWaiting input');
      const safeMachine = assertReference(machineReference, 'machineReference', { nullable: false });
      const safeApproval = assertReference(approvalReference, 'approvalReference', { nullable: false });
      const result = foundation.evaluate(safeApproval, { identity, scope });
      const record = store.get(safeApproval) ?? null;
      return Object.freeze({
        machineReference: safeMachine,
        approvalReference: safeApproval,
        resolved: result.decision === 'granted',
        decision: result.decision,
        reason: result.reason,
        resolvedAt: record ? record.resolvedAt : null,
      });
    },

    get size() {
      return store.size;
    },
    clear() {
      store.clear();
    },
  };
  return foundation;
}

/**
 * Create an approval foundation instance.
 * @param {{ now?: () => string, newId?: () => string, limits?: object }} [options]
 */
export function createApprovalFoundation(options = {}) {
  return makeFoundation(options);
}
