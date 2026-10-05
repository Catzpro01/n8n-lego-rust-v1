/**
 * Runtime Adapter — the contract-preserving seam (P2.21).
 *
 * PUBLIC CONTRACT: ai.runtime-adapter@1.0.0 (owner: manager).
 *
 * An external runtime participates through ONE canonical translation layer;
 * the Agent Machine stays authoritative. This module is the seam plus a
 * deterministic in-process/simulated harness — it is NOT a production
 * external runtime, NOT a scheduler, NOT an MCP implementation and NOT a
 * second Agent Machine.
 *
 *   P2.16 Agent Machine contract (ai.agent-machine@1.1.0)  ← never modified
 *     └─ P2.17 bounded runtime semantics (budgets/deadlines/cancel)
 *          └─ ai.runtime-adapter@1.0.0  ← this seam
 *               └─ provider/runtime implementation seam (supports(kind))
 *                    └─ harness / simulated runtime (deterministic tests)
 *
 * EXTERNAL EXECUTOR KIND (quoted executorKindRule): a kind is a DECLARATION,
 * not an authority. EXTERNAL becomes usable only when —
 *   provider declared → adapter registered → contract supported →
 *   capabilities declared → eligible.
 * Anything unknown/invalid answers FAIL CLOSED (not eligible / refused).
 * There is no wildcard provider, no implicit discovery and no trust by name.
 *
 * CONTRACT COMPATIBILITY: the adapter's manager() IS createAgentMachineManager
 * (the real P2.16 contract host) wired to an adapter provider — the provider
 * seam is exactly the replacement point agent-machine.json declares ("the
 * seam is where a future external executor plugs in; the contract does not
 * change"). Same 9 operations, same lifecycle vocabulary, same errors, same
 * idempotency — re-run unchanged semantics under a different locality.
 *
 * NO authority is granted by adapter selection: no shell, no filesystem, no
 * subprocess, no network, no model inference, no MCP, no permission grants.
 * Vocabulary is quoted from manifest/agent-machine.json, manifest/ai-foundation
 * (runtimeMetadata) and manifest/ai-lego-set.json#runtime-adapter; operations
 * and permissions are the domain-declared ones from manifest/domains.json.
 *
 * Owner of the contract: manager. Implementation: agent-1 (P2.21).
 */
import { randomUUID } from 'node:crypto';

import { AI_FOUNDATION, AGENT_EVENT_TYPES } from './ai-foundation.mjs';
import {
  AGENT_MACHINE_CONTRACT_VERSION,
  AGENT_MACHINE_EXECUTOR_KINDS,
  AGENT_MACHINE_OPERATIONS,
  createAgentMachineManager,
} from './agent-machine.mjs';

/* ---------------------------------------------------------------- contract */

export const RUNTIME_ADAPTER_CONTRACT = Object.freeze({
  id: "ai.runtime-adapter",
  version: '1.1.0',
  owner: 'manager',
  /** Canonical declaration fields — quoted names from runtimeMetadata/agent-machine. */
  fields: Object.freeze([
    'runtimeId',
    'contract',
    'executorKinds',
    'capabilities',
    'locality',
    'availability',
    'providerId',
    'registeredAt',
    'eligible',
    'reason',
  ]),
});

export const RUNTIME_ADAPTER_CONTRACT_VERSION = RUNTIME_ADAPTER_CONTRACT.version;
export const RUNTIME_ADAPTER_FIELDS = RUNTIME_ADAPTER_CONTRACT.fields;

/** Domain-declared operations + permissions (manifest/domains.json). */
export const RUNTIME_ADAPTER_OPERATIONS = Object.freeze(['register', 'lookup', 'eligibility', 'manager']);
export const RUNTIME_ADAPTER_PERMISSIONS = Object.freeze([
  'ai:adapter:read',
  'ai:adapter:register',
  'ai:adapter:dispatch',
]);

/**
 * Capability vocabulary — quoted: runtimeMetadata.supports keys
 * (session/background/stream/cancellation/delegation) plus `artifacts` from
 * the official runtime-adapter LEGO lifecycle. Unknown capability → FAIL CLOSED.
 */
export const ADAPTER_CAPABILITIES = Object.freeze([
  ...Object.keys(AI_FOUNDATION.agentRuntime.runtimeMetadata.supports),
  'artifacts',
]);

/** Runtime locality — quoted from runtimeMetadata.locality. `remote` ≠ EXTERNAL. */
export const ADAPTER_LOCALITIES = Object.freeze([...AI_FOUNDATION.agentRuntime.runtimeMetadata.locality]);

/** Executor kinds — quoted from the Agent Machine contract (IN_MEMORY default, EXTERNAL seam). */
export const ADAPTER_EXECUTOR_KINDS = Object.freeze([...AGENT_MACHINE_EXECUTOR_KINDS]);

/** The Agent Machine contract this seam serves — adapter never changes it. */
export const ADAPTER_AGENT_MACHINE_VERSION = AGENT_MACHINE_CONTRACT_VERSION;

/** The runtime lifecycle contract an external runtime declares (official LEGO versioning). */
export const ADAPTER_RUNTIME_CONTRACT = 'ai.agent-runtime@1.0.0';

/** Availability/degradation answers — quoted from the official runtime-adapter LEGO. */
export const ADAPTER_AVAILABILITIES = Object.freeze(['available', 'capability-unavailable', 'optional-absent', 'version-incompatible']);

/**
 * Lifecycle translation: official runtime-adapter operations → canonical
 * Agent Machine operations. `null` = declared but UNSUPPORTED against
 * ai.agent-machine@1.1.0 (fail-closed); a missing key = unknown operation.
 * `[]` = pure seam state (registration), no manager op. The table translates;
 * it never introduces a second lifecycle vocabulary.
 */
export const RUNTIME_LIFECYCLE_TRANSLATION = Object.freeze({
  connect: Object.freeze([]),
  start: Object.freeze(['agentMachine.create', 'agentMachine.prepare', 'agentMachine.start']),
  send: Object.freeze(['agentMachine.step']),
  stream: null,
  pause: Object.freeze(['agentMachine.pause']),
  resume: Object.freeze(['agentMachine.resume']),
  cancel: Object.freeze(['agentMachine.cancel']),
  status: Object.freeze(['agentMachine.describe']),
  artifact: Object.freeze(['agentMachine.describe']),
  disconnect: Object.freeze([]),
});

export const ADAPTER_LIMITS = Object.freeze({
  maxRuntimes: 16,
  maxPendingEvents: 8,
  maxEvents: 256,
  maxRetryAttempts: 3,
  maxIdentifierLength: 64,
  maxReferenceIdLength: 128,
  maxResponseDetailLength: 128,
});

/* ------------------------------------------------------------------ errors */

export class RuntimeAdapterError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RuntimeAdapterError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details = {}) {
  throw new RuntimeAdapterError('lego.contract_violation', message, details);
}

/* -------------------------------------------------------------- primitives */

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const REFERENCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
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
  if (typeof value === 'string' && SENSITIVE_TEXT.test(value)) {
    fail(`${field} carries secret-shaped material — the runtime adapter never records credentials or tokens`, { field });
  }
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    fail(`${field} must match ${ID_RE} (1..${ADAPTER_LIMITS.maxIdentifierLength} characters)`);
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
    fail(`${field} carries secret-shaped material — the runtime adapter never records credentials or tokens`, { field });
  }
  return value;
}

function assertOpaqueReference(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && (TRAVERSAL_RE.test(value) || ABSOLUTE_PATH_RE.test(value))) {
    fail(`${field} must be an opaque reference — path-shaped values are refused at the adapter seam (no filesystem authority)`, { field });
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > ADAPTER_LIMITS.maxReferenceIdLength
    || !REFERENCE_ID_RE.test(value)) {
    fail(`${field} must be an opaque reference of 1..${ADAPTER_LIMITS.maxReferenceIdLength} characters`, { field });
  }
  if (SENSITIVE_TEXT.test(value)) fail(`${field} carries secret-shaped material`, { field });
  return value;
}

function assertStringArray(value, field, vocabulary, { nonEmpty = true } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0)) {
    fail(`${field} must be a ${nonEmpty ? 'non-empty ' : ''}array`, { field });
  }
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > ADAPTER_LIMITS.maxIdentifierLength) {
      fail(`${field} entries must be bounded identifier strings`, { field, entry: String(entry).slice(0, 64) });
    }
    if (SENSITIVE_TEXT.test(entry)) fail(`${field} carries secret-shaped material`, { field });
    if (vocabulary && !vocabulary.includes(entry)) {
      fail(`${field} contains '${entry}', which is not in the canonical vocabulary [${[...vocabulary].join(', ')}] — unknown values fail closed`, { field, entry });
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

function assertOpaqueDetail(value, field, { nullable = true } = {}) {
  if (value === undefined || value === null) {
    if (nullable) return null;
    fail(`${field} is required`);
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > ADAPTER_LIMITS.maxResponseDetailLength) {
    fail(`${field} must be a bounded string of at most ${ADAPTER_LIMITS.maxResponseDetailLength} characters`, { field });
  }
  if (SENSITIVE_TEXT.test(value)) fail(`${field} carries secret-shaped material`, { field });
  return value;
}

/* --------------------------------------------------------------- registry */

function makeRegistry(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => randomUUID());
  const limits = Object.freeze({ ...ADAPTER_LIMITS, ...(options.limits ?? {}) });
  if (typeof now !== 'function') fail('now must be a function returning an ISO timestamp');
  if (typeof newId !== 'function') fail('newId must be a function returning an identifier');

  const runtimes = new Map();

  function clock() {
    const value = now();
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('now() must return an ISO timestamp');
    return new Date(value).toISOString();
  }

  return Object.freeze({
    /**
     * Explicit provider/runtime registration — the ONLY way a runtime becomes
     * eligible. Unknown shapes are rejected; credentials are refused.
     */
    register(input) {
      assertPlainObject(input, 'register input');
      const {
        runtimeId, contract, executorKinds, capabilities, locality,
        availability = 'available', providerId = null,
      } = input;
      assertId(runtimeId, 'runtimeId');
      if (runtimes.has(runtimeId)) {
        fail(`runtime '${runtimeId}' was already registered — duplicate registration is refused`, { runtimeId });
      }
      if (runtimes.size >= limits.maxRuntimes) {
        fail(`runtime registry is bounded at ${limits.maxRuntimes} runtimes`, { limit: 'maxRuntimes' });
      }
      if (contract !== ADAPTER_RUNTIME_CONTRACT) {
        fail(`unsupported contract '${String(contract)}' — the adapter accepts exactly ${ADAPTER_RUNTIME_CONTRACT} (fail-closed)`, {
          contract: contract ?? null,
          supported: ADAPTER_RUNTIME_CONTRACT,
        });
      }
      const safeKinds = assertStringArray(executorKinds, 'executorKinds', ADAPTER_EXECUTOR_KINDS);
      if (!safeKinds.includes('EXTERNAL')) {
        fail('executorKinds must include EXTERNAL — this registry exists to declare external executors (fail-closed)', {
          executorKinds: safeKinds,
        });
      }
      const safeCapabilities = assertStringArray(capabilities, 'capabilities', ADAPTER_CAPABILITIES);
      if (typeof locality !== 'string' || !ADAPTER_LOCALITIES.includes(locality)) {
        fail(`locality must be one of ${ADAPTER_LOCALITIES.join(', ')} — received '${String(locality)}' (transport and locality are separate dimensions)`, {
          locality: locality ?? null,
        });
      }
      if (typeof availability !== 'string' || !ADAPTER_AVAILABILITIES.includes(availability)) {
        fail(`availability must be one of ${ADAPTER_AVAILABILITIES.join(', ')}`, { availability });
      }
      const safeProviderId = providerId === null || providerId === undefined
        ? null
        : assertId(providerId, 'providerId');
      const record = Object.freeze({
        runtimeId,
        contract: ADAPTER_RUNTIME_CONTRACT,
        executorKinds: Object.freeze([...safeKinds]),
        capabilities: Object.freeze([...safeCapabilities]),
        locality,
        availability,
        providerId: safeProviderId,
        registeredAt: clock(),
        registrationId: newId(),
      });
      runtimes.set(runtimeId, record);
      return freezeDeep({ ...record });
    },

    /** Read a registration. Unknown → null (lookup is not eligibility). */
    lookup(runtimeId) {
      assertId(runtimeId, 'runtimeId');
      const record = runtimes.get(runtimeId);
      return record ? freezeDeep({ ...record }) : null;
    },

    /**
     * The fail-closed eligibility gate. Anything unknown or invalid answers
     * NOT eligible with a stable reason — never a wildcard, never by name.
     */
    eligibility(runtimeId, query = {}) {
      assertId(runtimeId, 'runtimeId');
      assertPlainObject(query, 'eligibility query');
      const { executorKind = null, operation = null, capability = null } = query;
      if (executorKind !== null) assertId(executorKind, 'executorKind');
      if (capability !== null) assertId(capability, 'capability');
      const deny = (reason, extra = {}) => Object.freeze({ runtimeId, eligible: false, reason, ...extra });

      const record = runtimes.get(runtimeId);
      if (!record) return deny('unknown-provider');
      if (record.contract !== ADAPTER_RUNTIME_CONTRACT) return deny('unsupported-contract', { contract: record.contract });
      if (record.availability === 'version-incompatible' || record.availability === 'disabled') {
        return deny('unavailable', { availability: record.availability });
      }
      if (executorKind !== null) {
        if (!ADAPTER_EXECUTOR_KINDS.includes(executorKind)) return deny('unknown-executor-kind', { executorKind });
        if (!record.executorKinds.includes(executorKind)) return deny('unsupported-executor-kind', { executorKind });
      }
      if (operation !== null) {
        if (typeof operation !== 'string' || operation.length === 0) return deny('unsupported-operation', { operation: null });
        if (!AGENT_MACHINE_OPERATIONS.includes(operation)) return deny('unsupported-operation', { operation });
      }
      if (capability !== null) {
        if (!ADAPTER_CAPABILITIES.includes(capability)) return deny('missing-capability', { capability });
        if (!record.capabilities.includes(capability)) return deny('missing-capability', { capability });
      }
      return Object.freeze({ runtimeId, eligible: true, reason: null });
    },

    get size() {
      return runtimes.size;
    },
    clear() {
      runtimes.clear();
    },
  });
}

export function createRuntimeRegistry(options = {}) {
  return makeRegistry(options);
}

/* ----------------------------------------------------------------- adapter */

function makeAdapter(options = {}) {
  const registry = options.registry;
  const runtimeId = options.runtimeId;
  const runtime = options.runtime ?? null;
  const now = options.now ?? (() => new Date().toISOString());
  const newId = options.newId ?? (() => randomUUID());
  const limits = Object.freeze({ ...ADAPTER_LIMITS, ...(options.limits ?? {}) });

  if (!registry || typeof registry.lookup !== 'function' || typeof registry.eligibility !== 'function') {
    fail('registry must expose { lookup, eligibility } (create it with createRuntimeRegistry)');
  }
  assertId(runtimeId, 'runtimeId');
  // §11: adapter creation itself demands an explicit provider registration.
  if (!registry.lookup(runtimeId)) {
    fail(`unknown provider '${runtimeId}' — the adapter refuses to bind to a runtime that is not explicitly registered (fail-closed)`, {
      runtimeId,
    });
  }
  if (typeof now !== 'function') fail('now must be a function returning an ISO timestamp');
  if (typeof newId !== 'function') fail('newId must be a function returning an identifier');
  if (runtime !== null && (typeof runtime !== 'object' || typeof runtime.nextResponse !== 'function')) {
    fail('runtime must expose nextResponse() when supplied (the simulated runtime seam)');
  }

  const clockRef = { now };
  const inner = { store: new Map() };
  const outbox = [];
  let dropped = 0;
  let managerCache = null;

  function clock() {
    const value = clockRef.now();
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('now() must return an ISO timestamp');
    return new Date(value).toISOString();
  }

  /**
   * The provider seam. IN_MEMORY = storage-grade default; EXTERNAL = live
   * eligibility re-checked on every call (registration can never be assumed).
   * Records only — never a payload, command, path, credential or handle.
   */
  const provider = Object.freeze({
    supports(kind) {
      if (kind === 'IN_MEMORY') return true;
      if (kind === 'EXTERNAL') return registry.eligibility(runtimeId, { executorKind: 'EXTERNAL' }).eligible === true;
      return false;
    },
    put(record) {
      inner.store.set(record.machineId, JSON.parse(JSON.stringify(record)));
    },
    get(machineId) {
      const record = inner.store.get(machineId);
      return record ? JSON.parse(JSON.stringify(record)) : null;
    },
    list() {
      return Array.from(inner.store.values()).map((record) => JSON.parse(JSON.stringify(record)));
    },
    clear() {
      inner.store.clear();
    },
    get size() {
      return inner.store.size;
    },
  });

  const adapter = Object.freeze({
    registry,
    runtimeId,
    provider,

    /** The REAL P2.16 contract host, wired through the adapter provider. */
    manager() {
      if (!managerCache) {
        managerCache = createAgentMachineManager({ provider, now: () => clock() });
      }
      return managerCache;
    },

    /** Live eligibility re-check (unknown/unregistered → false, never a wildcard). */
    eligible(query = {}) {
      return registry.eligibility(runtimeId, query);
    },

    /**
     * Translate one official runtime operation to canonical Agent Machine
     * operations. Declared-but-unsupported (`stream`) and unknown operations
     * are both rejected — no silent mapping, no second vocabulary.
     */
    translate(runtimeOperation) {
      if (typeof runtimeOperation !== 'string' || runtimeOperation.length === 0) {
        fail('runtimeOperation must be a non-empty string');
      }
      if (!Object.hasOwn(RUNTIME_LIFECYCLE_TRANSLATION, runtimeOperation)) {
        fail(`unknown runtime operation '${runtimeOperation}' — the translation table declares the official runtime-adapter vocabulary only`, {
          runtimeOperation,
        });
      }
      const mapped = RUNTIME_LIFECYCLE_TRANSLATION[runtimeOperation];
      if (mapped === null) {
        fail(`runtime operation '${runtimeOperation}' has no canonical target in ai.agent-machine@${ADAPTER_AGENT_MACHINE_VERSION} — unsupported operations fail closed`, {
          runtimeOperation,
          contract: `ai.agent-machine@${ADAPTER_AGENT_MACHINE_VERSION}`,
        });
      }
      return mapped;
    },

    /**
     * Pull one deterministic response from the simulated runtime (bounded
     * retry: at most maxRetryAttempts pulls) and feed it into the canonical
     * step contract. Opaque references only — path/secret shapes are refused
     * HERE, at the seam, before they reach the machine.
     */
    pullStep(input = {}) {
      assertPlainObject(input, 'pullStep input');
      const { machineId, stepId = null, approvalReference = null, inputReference = null, maxAttempts = 1 } = input;
      assertId(machineId, 'machineId');
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > limits.maxRetryAttempts) {
        fail(`maxAttempts must be an integer in [1, ${limits.maxRetryAttempts}] — retry is opt-in and bounded`, {
          maxAttempts,
          limit: 'maxRetryAttempts',
        });
      }
      if (!runtime) {
        fail('no runtime seam is bound to this adapter — pullStep requires a simulated/runtime seam (fail-closed)', { runtimeId });
      }
      const eligibility = registry.eligibility(runtimeId, { executorKind: 'EXTERNAL' });
      if (!eligibility.eligible) {
        fail(`runtime '${runtimeId}' is not eligible for external execution (${eligibility.reason}) — fail-closed`, {
          runtimeId,
          reason: eligibility.reason,
        });
      }
      const manager = adapter.manager();
      const record = manager.describe({ machineId });
      if (!record) fail(`agent machine '${machineId}' does not exist`, { machineId });

      let pulls = 0;
      let response;
      for (;;) {
        response = assertPlainObject(runtime.nextResponse({ machineId }), 'runtime response');
        pulls += 1;
        const isFailure = response.failure === true || response.outcome === 'failed';
        if (!isFailure) break;
        // Bounded, opt-in retry: without maxAttempts the first response wins
        // (a scripted failure is a scripted failure — isolation stays honest).
        if (pulls >= maxAttempts) break;
      }

      const outcome = response.failure === true ? 'failed' : response.outcome;
      const safeResultReference = assertOpaqueReference(response.resultReference, 'response.resultReference');
      const safeErrorReference = assertOpaqueReference(response.errorReference, 'response.errorReference');
      const safeInputReference = inputReference === null
        ? assertOpaqueReference(response.inputReference, 'response.inputReference')
        : assertOpaqueReference(inputReference, 'inputReference');
      const safeApproval = approvalReference === null
        ? assertOpaqueReference(response.approvalReference, 'response.approvalReference')
        : assertOpaqueReference(approvalReference, 'approvalReference');
      const safeStepId = stepId === null
        ? `sim-step-${record.stepCount + 1}`.slice(0, limits.maxIdentifierLength)
        : assertId(stepId, 'stepId');

      const next = manager.step({
        machineId,
        expectedVersion: record.version,
        stepId: safeStepId,
        sequence: record.stepCount + 1,
        inputReference: safeInputReference,
        approvalReference: safeApproval,
        result: {
          outcome,
          final: response.final === true,
          resultReference: safeResultReference,
          errorReference: safeErrorReference,
        },
      });
      return freezeDeep({
        machine: next,
        retryAttempts: pulls - 1,
        runtimeResponse: Object.freeze({ outcome, final: response.final === true }),
      });
    },

    /**
     * Cancellation propagation to the seam — idempotent and capability-gated.
     * A runtime that declared no cancellation gets {propagated:false} (never a
     * silent fake cancel), repeated signals never corrupt runtime state.
     */
    signalCancellation(input = {}) {
      assertPlainObject(input, 'signalCancellation input');
      const { machineId } = input;
      assertId(machineId, 'machineId');
      if (!runtime) {
        return freezeDeep({ machineId, propagated: false, reason: 'no-runtime-seam' });
      }
      const declared = typeof runtime.supports === 'object' && runtime.supports !== null
        ? runtime.supports.cancellation === true
        : false;
      const already = typeof runtime.wasCancelled === 'function' ? runtime.wasCancelled(machineId) : false;
      if (!declared) {
        return freezeDeep({ machineId, propagated: false, reason: 'missing-capability' });
      }
      if (typeof runtime.noteCancellation === 'function') runtime.noteCancellation(machineId);
      return freezeDeep({ machineId, propagated: true, already });
    },

    /**
     * Forward ONE canonical event into the bounded outbox. Unknown event
     * types are rejected (fail-closed vocabulary); the outbox itself is
     * bounded — overflow answers {accepted:false} deterministically, never
     * an unbounded queue.
     */
    forwardEvent(input = {}) {
      assertPlainObject(input, 'forwardEvent input');
      const { type, machineId = null, correlationId = null, causationId = null, detail = null } = input;
      if (typeof type !== 'string' || !AGENT_EVENT_TYPES.includes(type)) {
        fail(`event type '${String(type)}' is not in the canonical agent event vocabulary (fail-closed)`, {
          type: type ?? null,
        });
      }
      if (machineId !== null) assertId(machineId, 'machineId');
      const safeCorrelation = correlationId === null ? newId() : assertOpaqueReference(correlationId, 'correlationId');
      const safeCausation = causationId === null ? null : assertOpaqueReference(causationId, 'causationId');
      const safeDetail = assertOpaqueDetail(detail, 'detail');
      if (outbox.length >= limits.maxPendingEvents) {
        dropped += 1;
        return freezeDeep({ accepted: false, reason: 'backpressure', dropped, pending: outbox.length });
      }
      const envelope = Object.freeze({
        type,
        machineId,
        correlationId: safeCorrelation,
        causationId: safeCausation,
        detail: safeDetail,
        at: clock(),
      });
      outbox.push(envelope);
      return freezeDeep({ accepted: true, pending: outbox.length, envelope });
    },

    /** Bounded read of delivered events. */
    outbox() {
      return freezeDeep(outbox.map((event) => ({ ...event })));
    },

    /** Machines whose cancellation reached the simulated runtime seam. */
    runtimeCancelledList() {
      if (runtime && typeof runtime.cancelledMachines === 'function') {
        return runtime.cancelledMachines();
      }
      return [];
    },

    stats() {
      return Object.freeze({
        pending: outbox.length,
        dropped,
        maxPendingEvents: limits.maxPendingEvents,
        runtimeId,
        registered: Boolean(registry.lookup(runtimeId)),
      });
    },

    /** Harness and tests share this clock — advancing it is how time passes. */
    clock: Object.freeze({
      now: () => clock(),
      advance(ms) {
        if (!Number.isFinite(ms) || ms < 0) fail('advance(ms) requires a non-negative number of milliseconds');
        const base = Date.parse(clockRef.now());
        clockRef.now = () => new Date(base + ms).toISOString();
        return clockRef.now();
      },
    }),
  });
  return adapter;
}

export function createRuntimeAdapter(options = {}) {
  return makeAdapter(options);
}

/* -------------------------------------------------------- simulated runtime */

function makeSimulatedRuntime(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const limits = Object.freeze({ ...ADAPTER_LIMITS, ...(options.limits ?? {}) });
  const supports = Object.freeze({
    session: true,
    background: false,
    stream: false,
    cancellation: true,
    delegation: false,
    artifacts: options.artifacts === true,
    ...(options.supports ?? {}),
  });
  const declaredCapabilities = Object.freeze(
    Object.entries(supports)
      .filter(([, value]) => value === true)
      .map(([key]) => key)
      .filter((key) => ADAPTER_CAPABILITIES.includes(key)),
  );
  const queue = [...(options.responses ?? [])];
  const cancellations = new Set();
  const events = [];
  let pulls = 0;

  return Object.freeze({
    runtimeId: options.runtimeId ?? 'sim-runtime',
    supports,
    declaredCapabilities,

    /** Registration payload for the official contract (executorKind EXTERNAL). */
    declaration(providerId = null) {
      return Object.freeze({
        runtimeId: options.runtimeId ?? 'sim-runtime',
        contract: ADAPTER_RUNTIME_CONTRACT,
        executorKinds: ['EXTERNAL'],
        capabilities: [...declaredCapabilities],
        locality: 'in-process',
        availability: 'available',
        providerId,
      });
    },

    /** Deterministic FIFO response — empty queue answers a plain success. */
    nextResponse(context = {}) {
      if (pulls >= limits.maxEvents) {
        fail('simulated runtime response budget exhausted (bounded harness)', { limit: 'maxEvents' });
      }
      pulls += 1;
      const entry = queue.length > 0 ? queue.shift() : { outcome: 'succeeded', final: false };
      if (entry && typeof entry === 'object' && entry.failure === true) {
        return Object.freeze({
          outcome: 'failed',
          final: entry.final === true,
          resultReference: entry.resultReference ?? null,
          errorReference: entry.errorReference ?? 'runtime/simulated-failure',
          approvalReference: entry.approvalReference ?? null,
          inputReference: entry.inputReference ?? null,
          machineId: context.machineId ?? null,
        });
      }
      // outcome shapes are validated by the Agent Machine contract on the way in.
      return Object.freeze({
        outcome: entry.outcome ?? 'succeeded',
        final: entry.final === true,
        resultReference: entry.resultReference ?? null,
        errorReference: entry.errorReference ?? null,
        approvalReference: entry.approvalReference ?? null,
        inputReference: entry.inputReference ?? null,
        machineId: context.machineId ?? null,
      });
    },

    noteCancellation(machineId) {
      cancellations.add(machineId);
      return { propagated: true };
    },
    wasCancelled(machineId) {
      return cancellations.has(machineId);
    },
    cancelledMachines() {
      return [...cancellations].sort();
    },

    emit(type, detail = null) {
      if (events.length >= limits.maxEvents) {
        fail('simulated runtime event budget exhausted (bounded harness)', { limit: 'maxEvents' });
      }
      events.push(Object.freeze({ type, detail, at: now() }));
      return events[events.length - 1];
    },
    emittedEvents() {
      return events.map((event) => ({ ...event }));
    },

    get pulls() {
      return pulls;
    },
  });
}

export function createSimulatedRuntime(options = {}) {
  return makeSimulatedRuntime(options);
}

/* ----------------------------------------------------------------- harness */

const HARNESS_OPS = new Set([
  'create', 'describe', 'prepare', 'start', 'step', 'pause', 'resume', 'delegate', 'cancel',
  'dispatchStep', 'signalCancel', 'forwardEvent', 'advance', 'translate',
]);

function makeHarness(options = {}) {
  const adapter = options.adapter;
  const clock = options.clock;
  if (!adapter || typeof adapter.manager !== 'function') {
    fail('harness requires an adapter created by createRuntimeAdapter');
  }
  if (!clock || typeof clock.now !== 'function' || typeof clock.advance !== 'function') {
    fail('harness requires an injectable clock { now, advance(ms) } — no real timers, ever');
  }
  const manager = adapter.manager();

  /**
   * Run ONE declarative scenario. Semantics live in the scenario data — the
   * runner has no test-specific branches. Errors are captured with their
   * canonical codes; expected values are compared when present.
   */
  function run(scenario) {
    assertPlainObject(scenario, 'scenario');
    const scenarioId = assertId(scenario.scenarioId, 'scenarioId');
    const operations = Array.isArray(scenario.operations) && scenario.operations.length > 0
      ? scenario.operations
      : fail('scenario.operations must be a non-empty array');
    if (operations.length > 128) fail('scenario is bounded at 128 operations', { limit: 128 });

    const errors = [];
    const eventLog = [];
    const lifecycles = Object.create(null);
    let retryAttempts = 0;
    let lastForward = null;
    let lastTranslate = null;

    for (const operation of operations) {
      assertPlainObject(operation, 'scenario operation');
      const { op } = operation;
      if (typeof op !== 'string' || !HARNESS_OPS.has(op)) {
        errors.push({ op: String(op), code: 'lego.contract_violation', message: `unknown harness operation '${String(op)}'` });
        continue;
      }
      try {
        if (op === 'advance') {
          clock.advance(operation.ms);
        } else if (op === 'translate') {
          lastTranslate = adapter.translate(operation.runtimeOperation);
        } else if (op === 'forwardEvent') {
          lastForward = adapter.forwardEvent({
            type: operation.type,
            machineId: operation.machineId ?? null,
            correlationId: operation.correlationId ?? null,
            causationId: operation.causationId ?? null,
            detail: operation.detail ?? null,
          });
          if (lastForward.accepted) eventLog.push(operation.type);
        } else if (op === 'signalCancel') {
          adapter.signalCancellation({ machineId: operation.machineId });
        } else if (op === 'dispatchStep') {
          const outcome = adapter.pullStep({
            machineId: operation.machineId,
            stepId: operation.stepId ?? null,
            approvalReference: operation.approvalReference ?? null,
            inputReference: operation.inputReference ?? null,
            maxAttempts: operation.maxAttempts ?? 1,
          });
          retryAttempts += outcome.retryAttempts;
          lifecycles[operation.machineId] = outcome.machine.lifecycle;
        } else {
          const machine = manager[op](operation.input ?? {});
          if (machine && machine.machineId) lifecycles[machine.machineId] = machine.lifecycle;
        }
      } catch (error) {
        errors.push({
          op,
          code: typeof error?.code === 'string' ? error.code : 'unknown',
          message: String(error?.message ?? error).slice(0, 240),
        });
      }
      // Refresh the observed lifecycle for the subject machine of THIS
      // operation — success or failure — so expected.state reads reality
      // (budget-exhausted, for instance, commits BEFORE it throws).
      const subjectId = operation.machineId ?? operation.input?.machineId;
      if (typeof subjectId === 'string' && subjectId.length > 0) {
        try {
          const current = manager.describe({ machineId: subjectId });
          if (current) lifecycles[current.machineId] = current.lifecycle;
        } catch { /* describe of an absent machine leaves the map untouched */ }
      }
    }

    const actual = Object.freeze({
      lifecycle: Object.freeze({ ...lifecycles }),
      errors: Object.freeze(errors.map((entry) => Object.freeze({ op: entry.op, code: entry.code }))),
      errorMessages: Object.freeze(errors.map((entry) => entry.message)),
      events: Object.freeze([...eventLog]),
      retryAttempts,
      lastForward: lastForward ? freezeDeep({ ...lastForward }) : null,
      lastTranslate: lastTranslate ? Object.freeze([...lastTranslate]) : null,
      outbox: freezeDeep({
        ...adapter.stats(),
        accepted: adapter.outbox().length,
      }),
      cancellations: freezeDeep(
        typeof adapter.runtimeCancelledList === 'function' ? adapter.runtimeCancelledList() : [],
      ),
    });

    const problems = [];
    const expected = scenario.expected ?? null;
    if (expected) {
      assertPlainObject(expected, 'scenario.expected');
      if (expected.lifecycle) {
        for (const [machineId, state] of Object.entries(expected.lifecycle)) {
          if (actual.lifecycle[machineId] !== state) {
            problems.push(`lifecycle of '${machineId}': expected '${state}', actual '${actual.lifecycle[machineId] ?? '(absent)'}'`);
          }
        }
      }
      if (expected.errors) {
        const want = JSON.stringify(expected.errors);
        const got = JSON.stringify(actual.errors);
        if (want !== got) problems.push(`errors: expected ${want}, actual ${got}`);
      }
      if (expected.retryAttempts !== undefined && actual.retryAttempts !== expected.retryAttempts) {
        problems.push(`retryAttempts: expected ${expected.retryAttempts}, actual ${actual.retryAttempts}`);
      }
      if (expected.events) {
        const want = JSON.stringify(expected.events);
        const got = JSON.stringify(actual.events);
        if (want !== got) problems.push(`events: expected ${want}, actual ${got}`);
      }
      if (expected.outboxAccepted !== undefined && lastForward && lastForward.accepted !== expected.outboxAccepted) {
        problems.push(`outboxAccepted: expected ${expected.outboxAccepted}, actual ${lastForward.accepted}`);
      }
      if (expected.dropped !== undefined && adapter.stats().dropped !== expected.dropped) {
        problems.push(`dropped: expected ${expected.dropped}, actual ${adapter.stats().dropped}`);
      }
      if (expected.translated) {
        const want = JSON.stringify(expected.translated);
        const got = JSON.stringify(actual.lastTranslate ?? null);
        if (want !== got) problems.push(`translated: expected ${want}, actual ${got}`);
      }
      if (expected.cancellations) {
        const want = JSON.stringify([...expected.cancellations].sort());
        const got = JSON.stringify(adapter.runtimeCancelledList().slice().sort());
        if (want !== got) problems.push(`cancellations: expected ${want}, actual ${got}`);
      }
    }

    return Object.freeze({
      scenarioId,
      ok: problems.length === 0,
      actual,
      problems: Object.freeze(problems),
    });
  }

  return Object.freeze({ run, adapter });
}

export function createAdapterHarness(options = {}) {
  return makeHarness(options);
}
