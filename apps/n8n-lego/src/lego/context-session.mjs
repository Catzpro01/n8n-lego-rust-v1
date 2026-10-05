/**
 * Context & Session LEGO — bounded local lifecycle and continuation foundation (P2.13).
 *
 * PUBLIC CONTRACTS:
 *   - ai.context@1.0.0
 *   - ai.agent-session@1.0.0
 *
 * This module deliberately implements state mechanics, not an AI runtime. It has
 * no model/provider calls, no transcript store, no Memory store, no Workspace
 * authority and no execution loop. Context is what is loaded now; Memory is a
 * later LEGO for what survives context replacement.
 *
 * The two contracts share one implementation module because they form one LEGO,
 * while their public vocabulary remains distinct. The thin public contract
 * modules (context.mjs and agent-session.mjs) expose the exact locked surfaces.
 */
import { createHash } from 'node:crypto';

export const CONTEXT_CONTRACT = Object.freeze({
  id: "ai.context",
  version: '1.0.0',
  owner: 'manager',
  scopes: Object.freeze(['GLOBAL', 'WORKFLOW', 'NODE', 'EXECUTION', 'EVENT', 'AGENT', 'TASK']),
  fields: Object.freeze([
    'contextId', 'scope', 'parent', 'snapshot', 'version', 'source',
    'dependencies', 'size', 'checksum',
  ]),
});
export const CONTEXT_CONTRACT_VERSION = CONTEXT_CONTRACT.version;
export const CONTEXT_SCOPES = CONTEXT_CONTRACT.scopes;
export const CONTEXT_OPERATIONS = Object.freeze([
  'load', 'compact', 'rollover', 'rehydrate', 'verify',
]);

const SESSION_TRANSITIONS = Object.freeze({
  created: Object.freeze(['running', 'waiting', 'cancelled']),
  running: Object.freeze(['waiting', 'paused', 'completed', 'failed', 'cancelled']),
  waiting: Object.freeze(['running', 'paused', 'completed', 'failed', 'cancelled']),
  paused: Object.freeze(['running', 'cancelled']),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export const AGENT_SESSION_CONTRACT = Object.freeze({
  id: 'ai.agent-session',
  version: '1.0.0',
  owner: 'manager',
  fields: Object.freeze([
    'sessionId', 'agentId', 'parentSessionId', 'taskId', 'workflowId',
    'executionId', 'runtimeId', 'status', 'createdAt', 'updatedAt',
    'contextRef', 'artifactRef', 'traceRef',
  ]),
  states: Object.freeze([
    'created', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled',
  ]),
});
export const AGENT_SESSION_CONTRACT_VERSION = AGENT_SESSION_CONTRACT.version;
export const AGENT_SESSION_STATES = AGENT_SESSION_CONTRACT.states;
export const AGENT_SESSION_OPERATIONS = Object.freeze(['create', 'status', 'close']);
export const AGENT_SESSION_TRANSITIONS = SESSION_TRANSITIONS;

export const CONTEXT_MANAGER_STATES = Object.freeze(['NORMAL', 'PREPARE', 'ROLLOVER']);
export const CONTINUATION_PACKAGE_VERSION = '1.0.0';
export const CONTINUATION_FIELDS = Object.freeze([
  'identity',
  'objective',
  'plan',
  'completedWork',
  'unfinishedWork',
  'constraints',
  'decisions',
  'activeEntities',
  'toolStateReferences',
  'artifacts',
  'importantReferences',
  'errors',
  'unresolvedQuestions',
  'compressedHistory',
]);
export const CONTINUATION_VERIFICATION = Object.freeze(['verified', 'degraded', 'failed']);

const MAX_ID_LENGTH = 128;
const DEFAULT_LIMITS = Object.freeze({
  maxContextBytes: 256 * 1024,
  maxContinuationBytes: 128 * 1024,
  maxStateBytes: 1024 * 1024,
});
const SENSITIVE_KEY = /(?:credential|secret|password|passwd|token|cookie|authorization|api[-_]?key|private[-_]?key|hidden[-_]?prompt|raw[-_]?prompt|chain[-_]?of[-_]?thought|reasoning|model[-_]?thought|transcript|messages?|host[-_]?path|filesystem|terminal|capability[-_]?grant|permission[-_]?grant)/i;
const SENSITIVE_TEXT = /(?:BEGIN\s+(?:RSA|OPENSSH|PRIVATE)\s+KEY|(?:^|\W)sk-[a-z0-9]{8,}|(?:^|\W)ghp_[a-z0-9]{8,}|Bearer\s+[a-z0-9._-]+)/i;
const ABSOLUTE_HOST_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|root|tmp|var|etc|Users|private)\b)/;
const REF_KEYS = new Set(['id', 'ref', 'uri', 'kind', 'checksum', 'version', 'contextId', 'sessionId', 'artifactId', 'traceId']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class ContextSessionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ContextSessionError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details = {}) {
  throw new ContextSessionError('lego.contract_violation', message, details);
}

function invalidTransition(message, details = {}) {
  throw new ContextSessionError('lego.interaction_mismatch', message, details);
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('state contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  fail(`state contains unsupported value type '${typeof value}'`);
}

function stableJson(value) {
  return JSON.stringify(canonical(value));
}

function bytes(value) {
  return Buffer.byteLength(stableJson(value), 'utf8');
}

function checksum(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`);
}

function assertAllowedFields(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${field}.${key} is not allowed by the published contract`, { field: key });
  }
}

function assertId(value, field) {
  if (typeof value !== 'string' || !ID_RE.test(value) || value.length > MAX_ID_LENGTH) {
    fail(`${field} must be a bounded identifier`, { field });
  }
  return value;
}

function assertSafeValue(value, path = '$', { referencesOnly = false } = {}) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) fail(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value === 'string') {
    if (value.length > 16_384) fail(`${path} contains an unbounded string`);
    if (SENSITIVE_TEXT.test(value)) fail(`${path} contains a credential-like value`);
    if (ABSOLUTE_HOST_PATH.test(value)) fail(`${path} contains an arbitrary host path`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 2048) fail(`${path} contains an unbounded array`);
    value.forEach((child, index) => assertSafeValue(child, `${path}[${index}]`, { referencesOnly }));
    return;
  }
  if (typeof value !== 'object') fail(`${path} contains an unsupported value type`);
  const keys = Object.keys(value);
  if (keys.length > 128) fail(`${path} contains too many fields`);
  for (const key of keys) {
    if (SENSITIVE_KEY.test(key)) fail(`${path}.${key} is not allowed in bounded context/session state`, { field: key });
    if (referencesOnly && !REF_KEYS.has(key)) fail(`${path}.${key} is not an allowed reference field`, { field: key });
    assertSafeValue(value[key], `${path}.${key}`, { referencesOnly });
  }
}

function assertBounded(value, limit, kind) {
  const size = bytes(value);
  if (size > limit) fail(`${kind} exceeds its bounded limit`, { kind, size, limit });
  return size;
}

function normalizeRef(value, field) {
  if (value === null || value === undefined) return null;
  assertSafeValue(value, field, { referencesOnly: typeof value === 'object' });
  if (typeof value === 'string') {
    if (value.length === 0 || value.length > MAX_ID_LENGTH) fail(`${field} must be a bounded reference`);
    return value;
  }
  return clone(value);
}

function normalizeRefList(value, field) {
  if (value === null || value === undefined) return null;
  const list = Array.isArray(value) ? value : [value];
  if (list.length > 256) fail(`${field} contains too many references`);
  return list.map((item) => normalizeRef(item, field));
}

function iso(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (Number.isNaN(date.valueOf())) fail('clock returned an invalid timestamp');
  return date.toISOString();
}

function normalizeLimits(limits = {}) {
  const out = { ...DEFAULT_LIMITS, ...limits };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isInteger(out[key]) || out[key] <= 0) fail(`${key} must be a positive integer`);
  }
  return Object.freeze(out);
}

function normalizeParent(parent) {
  if (parent === null || parent === undefined) return null;
  if (typeof parent === 'string') return { contextId: assertId(parent, 'parent') };
  assertPlainObject(parent, 'parent');
  assertSafeValue(parent, 'parent', { referencesOnly: true });
  return {
    contextId: assertId(parent.contextId ?? parent.id ?? parent.ref, 'parent.contextId'),
    ...(parent.checksum ? { checksum: parent.checksum } : {}),
  };
}

function contextRef(record) {
  return record ? {
    contextId: record.contextId,
    version: record.version,
    checksum: record.checksum,
  } : null;
}

function contextChecksumInput(record, snapshotData) {
  return {
    contextId: record.contextId,
    scope: record.scope,
    parent: record.parent,
    parentChecksum: record.parentChecksum,
    snapshot: {
      snapshotId: record.snapshot.snapshotId,
      version: record.snapshot.version,
      data: snapshotData,
    },
    version: record.version,
    source: record.source,
    dependencies: record.dependencies,
    size: record.size,
  };
}

function publicContext(record, snapshotData = undefined, select = []) {
  if (!record) return null;
  const result = {
    contextId: record.contextId,
    scope: record.scope,
    parent: record.parent,
    snapshot: {
      ...record.snapshot,
      ...(record.parentChecksum ? { parentChecksum: record.parentChecksum } : {}),
      ...(snapshotData === undefined ? {} : { data: clone(snapshotData), selectedKeys: [...select] }),
    },
    version: record.version,
    source: record.source,
    dependencies: clone(record.dependencies),
    size: record.size,
    checksum: record.checksum,
  };
  return freezeDeep(result);
}

function publicSession(record) {
  return freezeDeep(clone(record));
}

function requiredContinuationFields(input) {
  const missing = CONTINUATION_FIELDS.filter((field) => input[field] === undefined);
  if (missing.length > 0) fail(`continuation package is missing required state: ${missing.join(', ')}`, { missing });
}

function normalizeContinuation(input, { session = null, context = null, now = () => new Date().toISOString(), limits = DEFAULT_LIMITS } = {}) {
  assertPlainObject(input, 'continuation');
  requiredContinuationFields(input);
  assertSafeValue(input, 'continuation');
  assertPlainObject(input.identity, 'continuation.identity');
  const identity = { ...clone(input.identity) };
  if (!identity.sessionId) fail('continuation.identity.sessionId is required');
  if (!identity.contextId) fail('continuation.identity.contextId is required');
  assertId(identity.sessionId, 'continuation.identity.sessionId');
  assertId(identity.contextId, 'continuation.identity.contextId');
  if (session) {
    if (identity.sessionId !== session.sessionId) fail('continuation identity does not match its source session', { expected: session.sessionId, actual: identity.sessionId });
    if (identity.agentId && identity.agentId !== session.agentId) fail('continuation identity agentId does not match its source session');
  }
  if (context) {
    if (identity.contextId !== context.contextId) fail('continuation identity does not match its source context', { expected: context.contextId, actual: identity.contextId });
    if (identity.contextChecksum && identity.contextChecksum !== context.checksum) fail('continuation identity context checksum does not match its source context');
    identity.contextChecksum = context.checksum;
  }
  identity.agentId ??= session?.agentId ?? null;
  const packageWithoutIntegrity = {
    packageVersion: CONTINUATION_PACKAGE_VERSION,
    continuationId: input.continuationId ?? null,
    identity,
    ...Object.fromEntries(CONTINUATION_FIELDS.filter((field) => field !== 'identity').map((field) => [field, clone(input[field])])),
    createdAt: input.createdAt ?? iso(now),
  };
  if (packageWithoutIntegrity.continuationId !== null) assertId(packageWithoutIntegrity.continuationId, 'continuationId');
  const size = bytes(packageWithoutIntegrity);
  if (size > limits.maxContinuationBytes) fail('continuation package exceeds its bounded limit', { size, limit: limits.maxContinuationBytes });
  const packageRecord = {
    ...packageWithoutIntegrity,
    size,
    checksum: checksum(packageWithoutIntegrity),
  };
  return freezeDeep(packageRecord);
}

function verifyPackageShape(packageRecord, limits = DEFAULT_LIMITS) {
  const reasons = [];
  if (!packageRecord || typeof packageRecord !== 'object' || Array.isArray(packageRecord)) {
    return { status: 'failed', reasons: ['package is not an object'], checksumValid: false };
  }
  for (const field of ['packageVersion', 'identity', 'checksum', 'size', ...CONTINUATION_FIELDS]) {
    if (packageRecord[field] === undefined) reasons.push(`missing:${field}`);
  }
  if (packageRecord.packageVersion !== CONTINUATION_PACKAGE_VERSION) reasons.push('version-incompatible');
  const identity = packageRecord.identity;
  if (!identity || typeof identity !== 'object' || !identity.sessionId || !identity.contextId) reasons.push('identity-incomplete');
  let checksumValid = false;
  if (typeof packageRecord.checksum === 'string') {
    const { checksum: ignored, size: ignoredSize, ...withoutIntegrity } = packageRecord;
    checksumValid = checksum(withoutIntegrity) === packageRecord.checksum;
    if (!checksumValid) reasons.push('checksum-mismatch');
  }
  if (Number.isInteger(packageRecord.size)) {
    const { size: ignoredSize, checksum: ignoredChecksum, ...withoutIntegrity } = packageRecord;
    const actualSize = bytes(withoutIntegrity);
    if (actualSize !== packageRecord.size) reasons.push('size-mismatch');
    if (actualSize > limits.maxContinuationBytes) reasons.push('bounded-limit-exceeded');
  } else reasons.push('size-invalid');
  try {
    assertSafeValue(packageRecord, 'continuation');
  } catch (error) {
    reasons.push(`unsafe-state:${error.message}`);
  }
  // Reference availability is intentionally a visible degraded state. It is
  // not repaired or replaced with payload data, and it does not invalidate the
  // package's identity or checksum.
  if (stableJson(packageRecord).includes('"availability":"degraded"')) reasons.push('optional-reference-degraded');
  const status = reasons.some((reason) => ['identity-incomplete', 'checksum-mismatch', 'size-mismatch', 'size-invalid', 'bounded-limit-exceeded', 'unsafe-state'].some((prefix) => reason.startsWith(prefix)))
    ? 'failed'
    : reasons.length > 0 ? 'degraded' : 'verified';
  return { status, reasons, checksumValid };
}

export function verifyContinuationPackage(packageRecord, options = {}) {
  const limits = normalizeLimits(options.limits ?? {});
  const result = verifyPackageShape(packageRecord, limits);
  return freezeDeep({ ...result, package: result.status === 'failed' ? null : clone(packageRecord) });
}

function makeManager(options = {}) {
  const limits = normalizeLimits(options.limits);
  const prepareThreshold = options.prepareThreshold ?? 0.8;
  if (typeof prepareThreshold !== 'number' || prepareThreshold <= 0 || prepareThreshold >= 1) {
    fail('prepareThreshold must be between 0 and 1; rollover must leave serialization headroom');
  }
  const now = options.now ?? (() => new Date().toISOString());
  const contexts = new Map();
  const contextData = new Map();
  const sessions = new Map();
  const continuations = new Map();
  let sequence = 0;
  let managerState = 'NORMAL';
  let stateHistory = ['NORMAL'];
  let observedContextId = null;

  const nextId = (prefix, requested) => {
    if (requested !== undefined && requested !== null) return assertId(requested, `${prefix}Id`);
    sequence += 1;
    return `${prefix}-${sequence}`;
  };

  const stateSize = () => bytes({
    contexts: [...contexts.values()],
    sessions: [...sessions.values()],
    continuations: [...continuations.values()],
  });
  const ensureStateBounded = () => {
    const size = stateSize();
    if (size > limits.maxStateBytes) fail('context/session state exceeds its bounded limit', { size, limit: limits.maxStateBytes });
    return size;
  };
  const setState = (next) => {
    const current = managerState;
    const legal = { NORMAL: ['PREPARE'], PREPARE: ['ROLLOVER'], ROLLOVER: ['NORMAL'] };
    if (!legal[current].includes(next)) invalidTransition(`context manager cannot move ${current} -> ${next}`, { current, next });
    managerState = next;
    stateHistory.push(next);
  };

  function createContext(input = {}) {
    assertPlainObject(input, 'context');
    assertAllowedFields(input, new Set(['contextId', 'scope', 'parent', 'snapshot', 'snapshotData', 'snapshotId', 'version', 'source', 'dependencies']), 'context');
    const contextId = nextId('context', input.contextId);
    if (contexts.has(contextId)) fail(`context '${contextId}' is already registered`);
    const scope = input.scope;
    if (!CONTEXT_SCOPES.includes(scope)) fail(`context scope '${scope}' is invalid`, { scope, allowed: CONTEXT_SCOPES });
    const parentInput = normalizeParent(input.parent);
    const parentRecord = parentInput ? contexts.get(parentInput.contextId) : null;
    if (parentInput && !parentRecord) fail(`parent context '${parentInput.contextId}' does not exist`, { parent: parentInput.contextId });
    if (parentInput?.checksum && parentInput.checksum !== parentRecord.checksum) fail('parent context checksum does not match its registered snapshot');
    const version = input.version ?? 1;
    if (!Number.isInteger(version) || version < 1) fail('context version must be a positive integer');
    const dependencies = normalizeRefList(input.dependencies ?? [], 'dependencies') ?? [];
    const snapshotData = input.snapshotData !== undefined
      ? clone(input.snapshotData)
      : (input.snapshot !== undefined && typeof input.snapshot === 'object' && !input.snapshot.snapshotId ? clone(input.snapshot) : {});
    assertSafeValue(snapshotData, 'snapshotData');
    const snapshotId = input.snapshotId ?? `${contextId}:snapshot:${version}`;
    assertId(snapshotId, 'snapshotId');
    const source = input.source ?? 'local';
    if (typeof source !== 'string' || source.length === 0 || source.length > 256) fail('context source must be a bounded string');
    assertSafeValue(source, 'source');
    const record = {
      contextId,
      scope,
      parent: parentInput?.contextId ?? null,
      parentChecksum: parentRecord?.checksum ?? null,
      snapshot: { snapshotId, version },
      version,
      source,
      dependencies,
      size: 0,
      checksum: null,
    };
    record.size = assertBounded(snapshotData, limits.maxContextBytes, 'context snapshot');
    record.checksum = checksum(contextChecksumInput(record, snapshotData));
    contexts.set(contextId, record);
    contextData.set(contextId, snapshotData);
    ensureStateBounded();
    return publicContext(record);
  }

  function getContext(contextId) {
    return publicContext(contexts.get(contextId));
  }

  function loadContext(contextId, options = {}) {
    const record = contexts.get(contextId);
    if (!record) return null;
    const select = options.select ?? [];
    if (!Array.isArray(select) || select.some((key) => typeof key !== 'string' || key.length > 128)) fail('context load select must be a bounded list of field names');
    if (select.includes('*')) fail('context load requires selective keys; wildcard loading is not supported');
    const data = contextData.get(contextId) ?? {};
    const selected = {};
    for (const key of select) {
      if (Object.prototype.hasOwnProperty.call(data, key)) selected[key] = clone(data[key]);
    }
    return publicContext(record, selected, select);
  }

  function compactContext(contextId, options = {}) {
    const current = contexts.get(contextId);
    if (!current) fail(`context '${contextId}' does not exist`);
    if (options.snapshotData === undefined) fail('compaction requires an explicit bounded snapshotData; it never dumps the prior context');
    const next = createContext({
      contextId: options.contextId,
      scope: current.scope,
      parent: { contextId: current.contextId, checksum: current.checksum },
      snapshotData: options.snapshotData,
      snapshotId: options.snapshotId,
      version: current.version + 1,
      source: options.source ?? 'compaction',
      dependencies: options.dependencies ?? current.dependencies,
    });
    return next;
  }

  function createSession(input = {}) {
    assertPlainObject(input, 'session');
    assertAllowedFields(input, new Set(['sessionId', 'agentId', 'parentSessionId', 'taskId', 'workflowId', 'executionId', 'runtimeId', 'status', 'createdAt', 'updatedAt', 'contextRef', 'contextId', 'artifactRef', 'traceRef']), 'session');
    const sessionId = nextId('session', input.sessionId);
    if (sessions.has(sessionId)) fail(`session '${sessionId}' is already registered`);
    const agentId = assertId(input.agentId, 'agentId');
    const parentSessionId = input.parentSessionId ?? null;
    if (parentSessionId !== null) {
      assertId(parentSessionId, 'parentSessionId');
      if (!sessions.has(parentSessionId)) fail(`parent session '${parentSessionId}' does not exist`);
      if (parentSessionId === sessionId) fail('a session cannot be its own parent');
    }
    const contextInput = input.contextRef ?? input.contextId ?? null;
    let context = null;
    if (contextInput) {
      const contextId = typeof contextInput === 'string' ? contextInput : contextInput.contextId;
      context = contexts.get(assertId(contextId, 'contextRef.contextId'));
      if (!context) fail(`context '${contextId}' does not exist`);
      if (typeof contextInput === 'object' && contextInput.checksum && contextInput.checksum !== context.checksum) fail('session contextRef checksum does not match context');
    }
    const status = input.status ?? 'created';
    if (!AGENT_SESSION_STATES.includes(status)) fail(`session status '${status}' is invalid`);
    const timestamp = iso(now);
    const record = {
      sessionId,
      agentId,
      parentSessionId,
      taskId: input.taskId == null ? null : assertId(input.taskId, 'taskId'),
      workflowId: input.workflowId == null ? null : assertId(input.workflowId, 'workflowId'),
      executionId: input.executionId == null ? null : assertId(input.executionId, 'executionId'),
      runtimeId: input.runtimeId == null ? null : assertId(input.runtimeId, 'runtimeId'),
      status,
      createdAt: input.createdAt ?? timestamp,
      updatedAt: input.updatedAt ?? timestamp,
      contextRef: contextRef(context),
      artifactRef: normalizeRefList(input.artifactRef, 'artifactRef'),
      traceRef: normalizeRefList(input.traceRef, 'traceRef'),
    };
    assertSafeValue(record, 'session');
    sessions.set(sessionId, record);
    ensureStateBounded();
    return publicSession(record);
  }

  function getSession(sessionId) {
    return publicSession(sessions.get(sessionId) ?? null) || null;
  }

  function transitionSession(sessionId, status) {
    const record = sessions.get(sessionId);
    if (!record) fail(`session '${sessionId}' does not exist`);
    if (!AGENT_SESSION_STATES.includes(status)) fail(`session status '${status}' is invalid`);
    if (!AGENT_SESSION_TRANSITIONS[record.status].includes(status)) {
      invalidTransition(`session '${sessionId}' cannot move ${record.status} -> ${status}`, {
        sessionId, from: record.status, to: status, allowed: AGENT_SESSION_TRANSITIONS[record.status],
      });
    }
    record.status = status;
    record.updatedAt = iso(now);
    ensureStateBounded();
    return publicSession(record);
  }

  /**
   * Closes a bounded session with an explicit terminal outcome. Cancellation and
   * failure are outcomes, not hidden execution behavior; a repeated close with
   * the same outcome is idempotent, while changing a terminal outcome fails.
   */
  function closeSession(sessionId, options = {}) {
    assertPlainObject(options, 'close');
    assertAllowedFields(options, new Set(['status']), 'close');
    const record = sessions.get(sessionId);
    if (!record) fail(`session '${sessionId}' does not exist`);
    const status = options.status ?? 'completed';
    if (!['completed', 'failed', 'cancelled'].includes(status)) {
      fail(`close status '${status}' is not terminal`, { allowed: ['completed', 'failed', 'cancelled'] });
    }
    if (['completed', 'failed', 'cancelled'].includes(record.status)) {
      if (record.status !== status) {
        invalidTransition(`session '${sessionId}' is already closed as ${record.status}`, {
          sessionId, from: record.status, to: status,
        });
      }
      return publicSession(record);
    }
    return transitionSession(sessionId, status);
  }

  function buildContinuation(sessionId, input = {}) {
    const session = sessions.get(sessionId);
    if (!session) fail(`session '${sessionId}' does not exist`);
    const context = session.contextRef ? contexts.get(session.contextRef.contextId) : null;
    if (!context) fail('continuation requires a session with a registered context reference');
    const supplied = input.continuationPackage ?? input.continuation ?? input;
    const identity = {
      ...(supplied.identity ?? {}),
      sessionId,
      contextId: context.contextId,
      contextChecksum: context.checksum,
      agentId: session.agentId,
      ...(session.taskId ? { taskId: session.taskId } : {}),
      ...(session.workflowId ? { workflowId: session.workflowId } : {}),
      ...(session.executionId ? { executionId: session.executionId } : {}),
      ...(session.runtimeId ? { runtimeId: session.runtimeId } : {}),
    };
    const packageInput = { ...supplied, identity };
    const result = normalizeContinuation(packageInput, { session, context, now, limits });
    const continuationId = result.continuationId ?? nextId('continuation');
    // Integrity covers the complete serializable package except the two
    // integrity fields themselves. This makes verification deterministic and
    // avoids a circular checksum/size calculation.
    const { checksum: ignoredChecksum, size: ignoredSize, ...body } = { ...result, continuationId };
    const size = bytes(body);
    if (size > limits.maxContinuationBytes) {
      fail('continuation package exceeds its bounded limit', { size, limit: limits.maxContinuationBytes });
    }
    const finalized = { ...body, size, checksum: checksum(body) };
    return freezeDeep(finalized);
  }

  function verifyContinuity(packageRecord, sourceContext, nextContext) {
    const packageVerification = verifyContinuationPackage(packageRecord, { limits });
    const reasons = [...packageVerification.reasons];
    if (!sourceContext || !nextContext) reasons.push('context-reference-missing');
    if (sourceContext && packageRecord?.identity?.contextId !== sourceContext.contextId) reasons.push('source-context-id-mismatch');
    if (sourceContext && packageRecord?.identity?.contextChecksum !== sourceContext.checksum) reasons.push('source-context-checksum-mismatch');
    if (sourceContext && nextContext.parent !== sourceContext.contextId) reasons.push('next-context-parent-mismatch');
    if (sourceContext && nextContext.parentChecksum !== sourceContext.checksum) reasons.push('next-context-parent-checksum-mismatch');
    let status = packageVerification.status;
    if (reasons.some((reason) => /mismatch|missing|checksum|identity|size|unsafe|bounded/.test(reason))) status = 'failed';
    else if (reasons.length > 0) status = 'degraded';
    return freezeDeep({ status, reasons, checksumValid: packageVerification.checksumValid });
  }

  function rehydrateContinuation(packageRecord, options = {}) {
    const verification = verifyContinuationPackage(packageRecord, { limits });
    if (verification.status === 'failed') {
      throw new ContextSessionError('lego.contract_violation', 'continuation verification failed; state was not silently repaired', { verification });
    }
    const identity = packageRecord.identity;
    const contextId = options.contextId ?? identity.contextId;
    const context = contexts.get(contextId);
    if (!context) {
      throw new ContextSessionError('lego.contract_violation', 'continuation context identity is not registered', {
        verification: { ...verification, status: 'failed', reasons: [...verification.reasons, 'context-reference-missing'] },
      });
    }
    const sessionId = options.sessionId ?? nextId('session');
    const session = createSession({
      sessionId,
      agentId: options.agentId ?? identity.agentId,
      parentSessionId: options.parentSessionId ?? identity.sessionId,
      taskId: options.taskId ?? identity.taskId ?? null,
      workflowId: options.workflowId ?? identity.workflowId ?? null,
      executionId: options.executionId ?? identity.executionId ?? null,
      runtimeId: options.runtimeId ?? identity.runtimeId ?? null,
      contextRef: contextId,
    });
    continuations.set(packageRecord.continuationId, clone(packageRecord));
    ensureStateBounded();
    return freezeDeep({ session, continuation: clone(packageRecord), verification });
  }

  function observe(contextId, measurement = {}) {
    if (!contexts.has(contextId)) fail(`context '${contextId}' does not exist`);
    assertPlainObject(measurement, 'usage measurement');
    if (Object.keys(measurement).some((key) => /token|maxTokens|tokenLimit|tokenCount/i.test(key))) {
      fail('context rollover is driven by declared utilization, not an exact token-limit counter');
    }
    const utilization = measurement.utilization ?? measurement.utilizationRatio;
    if (typeof utilization !== 'number' || !Number.isFinite(utilization) || utilization < 0 || utilization > 1) {
      fail('usage measurement must provide utilization in the range 0..1');
    }
    observedContextId = contextId;
    if (utilization >= prepareThreshold && managerState === 'NORMAL') setState('PREPARE');
    return freezeDeep({ state: managerState, contextId, utilization, threshold: prepareThreshold, triggered: utilization >= prepareThreshold });
  }

  function rollover(sessionId, input = {}) {
    const session = sessions.get(sessionId);
    if (!session) fail(`session '${sessionId}' does not exist`);
    if (!session.contextRef) fail('rollover requires a session context reference');
    if (!['created', 'running', 'waiting', 'paused'].includes(session.status)) {
      invalidTransition(`session '${sessionId}' cannot roll over from ${session.status}`);
    }
    if (managerState === 'NORMAL') setState('PREPARE');
    if (managerState !== 'PREPARE') invalidTransition(`context manager cannot roll over from ${managerState}`);
    const sourceContext = contexts.get(session.contextRef.contextId);
    const packageRecord = buildContinuation(sessionId, input);
    setState('ROLLOVER');
    try {
      const compactedSnapshotData = input.compactedSnapshotData ?? {
        continuationRef: { continuationId: packageRecord.continuationId, checksum: packageRecord.checksum },
        objective: clone(packageRecord.objective),
        plan: clone(packageRecord.plan),
        unfinishedWork: clone(packageRecord.unfinishedWork),
        activeEntities: clone(packageRecord.activeEntities),
      };
      assertSafeValue(compactedSnapshotData, 'compactedSnapshotData');
      const nextContext = compactContext(sourceContext.contextId, {
        contextId: input.nextContextId,
        snapshotData: compactedSnapshotData,
        source: 'rollover',
      });
      const nextSessionId = input.nextSessionId ?? null;
      const nextSession = rehydrateContinuation(packageRecord, {
        sessionId: nextSessionId,
        contextId: nextContext.contextId,
        agentId: session.agentId,
        parentSessionId: session.sessionId,
        taskId: session.taskId,
        workflowId: session.workflowId,
        executionId: session.executionId,
        runtimeId: session.runtimeId,
      });
      const continuity = verifyContinuity(packageRecord, sourceContext, contexts.get(nextContext.contextId));
      if (continuity.status === 'failed') {
        throw new ContextSessionError('lego.contract_violation', 'continuity verification failed; rollover is not silently accepted', { continuity });
      }
      if (session.status !== 'created') {
        session.status = 'completed';
        session.updatedAt = iso(now);
      }
      continuations.set(packageRecord.continuationId, clone(packageRecord));
      const result = freezeDeep({
        state: 'ROLLOVER',
        finalState: 'NORMAL',
        previousSession: publicSession(session),
        previousContext: publicContext(sourceContext),
        continuation: clone(packageRecord),
        nextContext,
        nextSession: nextSession.session,
        verification: continuity,
        continuationVerification: nextSession.verification,
        linked: true,
        observedContextId,
      });
      setState('NORMAL');
      ensureStateBounded();
      return result;
    } catch (error) {
      // Failed rollover is never presented as a successful reset. Return to the
      // monitoring state so a caller can inspect the error and retry explicitly.
      if (managerState === 'ROLLOVER') setState('NORMAL');
      throw error;
    }
  }

  function status() {
    return freezeDeep({
      state: managerState,
      stateHistory: [...stateHistory],
      observedContextId,
      contextCount: contexts.size,
      sessionCount: sessions.size,
      continuationCount: continuations.size,
      limits,
      prepareThreshold,
    });
  }

  return {
    contract: Object.freeze({ context: CONTEXT_CONTRACT_VERSION, session: AGENT_SESSION_CONTRACT_VERSION }),
    limits,
    prepareThreshold,
    get state() { return managerState; },
    get contexts() { return contexts.size; },
    get sessions() { return sessions.size; },
    createContext,
    getContext,
    loadContext,
    compactContext,
    createSession,
    getSession,
    transitionSession,
    closeSession,
    buildContinuation,
    verifyContinuation: (packageRecord) => verifyContinuationPackage(packageRecord, { limits }),
    rehydrateContinuation,
    observe,
    rollover,
    status,
  };
}

export function createContextSessionManager(options = {}) {
  return makeManager(options);
}

export const createContextManager = createContextSessionManager;
