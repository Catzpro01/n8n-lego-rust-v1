/**
 * Agent Machine LEGO — bounded execution foundation (P2.16).
 *
 * PUBLIC CONTRACT: ai.agent-machine@1.1.0 (owner: manager), additive over the
 * locked 1.0.0 publication. RE-DERIVED from the frozen P2.16 1.1.0
 * specification after the original local-only commits proved unavailable on
 * GitHub; never recovered byte-for-byte.
 *
 * This module owns one canonical Agent Machine contract: the bounded identity
 * (machine, agent and task), lifecycle (incl. the machine-level `ready`
 * state), step bookkeeping, first-class budgets, bounded delegation
 * bookkeeping, bounded execution-graph validation, Universal Agent Event
 * derivation and deterministic state transitions. It consumes the established
 * ai.context, ai.agent-session, ai.memory and ai.workspace contracts by
 * REFERENCE ONLY — it holds opaque references and never redefines or drives
 * their lifecycles. Capability scope is validated against the lego-foundation
 * capability registry (src/lego/registry.mjs); unknown capabilities fail
 * closed.
 *
 * It is a foundation, not an engine: nothing here executes a step. Steps are
 * bounded, caller-reported records validated against identity, sequence,
 * budget and lifecycle rules. Delegation is bookkeeping/orchestration
 * metadata only: bounded edges with explicit narrowed grants, never
 * permission inheritance and never child execution. A replaceable
 * executor/provider seam (`InMemoryAgentMachineProvider` default) owns record
 * storage; a future executor satisfies the same contract without changing
 * this module.
 *
 * Deliberately absent: the agent loop, model inference, tool execution,
 * child-agent spawning/execution, parallel runtime, shell, filesystem,
 * process, MCP, credentials, close operation and Rust. Those belong to later
 * milestones and other contracts.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getCapability } from './registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(HERE, "manifest", "agent-machine.json");

const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

export const AGENT_MACHINE_CONTRACT = Object.freeze({
  id: "ai.agent-machine",
  version: '1.1.0',
  owner: 'manager',
  fields: Object.freeze([
    'machineId', 'taskId', 'agentId', 'executorKind', 'lifecycle',
    'sessionReference', 'contextReference', 'workspaceReference',
    'capabilityScope', 'budgets', 'metadata', 'steps', 'stepCount',
    'delegations', 'failure', 'version', 'createdAt', 'updatedAt',
    'startedAt',
  ]),
});

export const AGENT_MACHINE_CONTRACT_VERSION = AGENT_MACHINE_CONTRACT.version;

/**
 * Executor kinds are DECLARATIONS, not authority. The provider must explicitly
 * support the requested kind; the core never infers shell, filesystem, process
 * or remote execution from it. IN_MEMORY is the bounded default; EXTERNAL
 * names a replaceable external executor without selecting one.
 */
export const AGENT_MACHINE_EXECUTOR_KINDS = Object.freeze(['IN_MEMORY', 'EXTERNAL']);

/**
 * Lifecycle vocabulary is the canonical agent vocabulary already declared by
 * the AI set and used by ai.agent-session@1.0.0, plus the machine-level
 * `ready` state introduced by agentMachine.prepare in 1.1.0. created -> running
 * stays legal (1.0.0 flows unchanged). Waiting is entered only by an
 * approval-required step and left only by cancel: approval RESOLUTION is the
 * ai.approval contract's boundary, not this one, and fail-closed means an
 * unresolved approval never advances the machine.
 */
export const AGENT_MACHINE_LIFECYCLE = Object.freeze({
  states: Object.freeze(['created', 'ready', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled']),
  initial: 'created',
  terminal: Object.freeze(['completed', 'failed', 'cancelled']),
  transitions: Object.freeze({
    created: Object.freeze(['ready', 'running', 'cancelled']),
    ready: Object.freeze(['running', 'cancelled']),
    running: Object.freeze(['waiting', 'paused', 'completed', 'failed', 'cancelled']),
    waiting: Object.freeze(['cancelled']),
    paused: Object.freeze(['running', 'cancelled']),
    completed: Object.freeze([]),
    failed: Object.freeze([]),
    cancelled: Object.freeze([]),
  }),
});

export const AGENT_MACHINE_LIFECYCLE_STATES = AGENT_MACHINE_LIFECYCLE.states;

/**
 * Exactly nine published operations — the canonical P2.16 1.1.0 surface.
 * create/describe/prepare/delegate/start/step/pause/resume/cancel. There is
 * deliberately NO `close` operation: close belongs to the future
 * ai.agent-runtime full loop, which builds on this foundation. start/step
 * carry ai:agent:invoke because they advance execution state;
 * prepare/pause/resume/cancel carry ai:agent:control; delegate carries
 * ai:agent:delegate (bounded bookkeeping, never execution); describe carries
 * ai:agent:read; create carries ai:agent:create.
 */
export const AGENT_MACHINE_OPERATIONS = Object.freeze([
  "agentMachine.create",
  "agentMachine.describe",
  "agentMachine.prepare",
  "agentMachine.start",
  "agentMachine.step",
  "agentMachine.pause",
  "agentMachine.resume",
  "agentMachine.delegate",
  "agentMachine.cancel",
]);

export const AGENT_MACHINE_PERMISSIONS = Object.freeze([
  'ai:agent:create',
  'ai:agent:invoke',
  'ai:agent:control',
  'ai:agent:read',
  'ai:agent:delegate',
]);

/**
 * Operation -> permission map. Fail-closed: every operation names exactly one
 * canonical permission, and any unknown operation is refused rather than
 * defaulted.
 */
export const AGENT_MACHINE_OPERATION_PERMISSIONS = Object.freeze({
  'agentMachine.create': 'ai:agent:create',
  'agentMachine.describe': 'ai:agent:read',
  'agentMachine.prepare': 'ai:agent:control',
  'agentMachine.start': 'ai:agent:invoke',
  'agentMachine.step': 'ai:agent:invoke',
  'agentMachine.pause': 'ai:agent:control',
  'agentMachine.resume': 'ai:agent:control',
  'agentMachine.delegate': 'ai:agent:delegate',
  'agentMachine.cancel': 'ai:agent:control',
});

/** Resolve the single canonical permission for an operation (fail-closed). */
export function agentMachineOperationPermission(operation) {
  if (typeof operation !== 'string' || !Object.prototype.hasOwnProperty.call(AGENT_MACHINE_OPERATION_PERMISSIONS, operation)) {
    fail(`unknown agent machine operation '${String(operation)}'`, { operation });
  }
  return AGENT_MACHINE_OPERATION_PERMISSIONS[operation];
}

/**
 * Fail-closed permission assertion: the held permission list must contain the
 * operation's canonical permission. Missing permission, unknown operation or a
 * malformed held list is always a contract violation — never a default grant.
 */
export function assertAgentMachinePermission(operation, heldPermissions) {
  const required = agentMachineOperationPermission(operation);
  if (!Array.isArray(heldPermissions)) {
    fail(`${operation} requires a held permission list`, { operation, required });
  }
  if (!heldPermissions.includes(required)) {
    fail(`${operation} requires permission '${required}' (fail-closed)`, { operation, required });
  }
  return true;
}

/**
 * Universal Agent Event types derived from the bounded record. Six types,
 * session-scoped and reference-only: derivation never invents payload,
 * reasoning or secret material.
 */
export const AGENT_MACHINE_EVENT_TYPES = Object.freeze([
  'agent.created',
  'agent.started',
  'agent.delegated',
  'agent.completed',
  'agent.failed',
  'agent.cancelled',
]);

/**
 * Bounded execution-graph vocabulary. Representation and validation only —
 * never execution. `branch` is the canonical decision node (conditional
 * routing). Fan-out/fan-in/join/retry carry explicit degree and ceiling
 * rules; cycles, unknown kinds, dangling references and permission-bearing
 * nodes are rejected fail-closed.
 */
export const AGENT_GRAPH_NODE_KINDS = Object.freeze([
  'sequential',
  'parallel',
  'branch',
  'fan-out',
  'fan-in',
  'join',
  'retry',
]);

/** Global graph bounds. Nothing in P2.16 validates or runs past these. */
export const AGENT_GRAPH_LIMITS = Object.freeze({
  maxNodes: 128,
  maxDependencies: 16,
  maxRetryAttempts: 8,
});

/**
 * Step outcomes: what a bounded step report may say happened. `succeeded`
 * ends the machine only when the step is final; `failed` and `cancelled` are
 * terminal; `approval-required` moves the machine to waiting and MUST carry
 * an approvalReference (fail-closed: an approval requirement with no
 * reference to the ai.approval record that gates it is invalid input).
 */
export const AGENT_MACHINE_STEP_OUTCOMES = Object.freeze([
  'succeeded', 'failed', 'cancelled', 'approval-required',
]);

export const AGENT_MACHINE_FIELDS = AGENT_MACHINE_CONTRACT.fields;

/**
 * Global bounds. Per-machine budgets are declared at create and clamped to
 * these: an execution can never exceed them, and budget exhaustion is a
 * stable terminal condition (failure code budget-exhausted), never an
 * unbounded continuation. 1.1.0 adds maxChildren (bounded delegation edges),
 * maxTasksPerAgent (bounded machines per agent identity) and
 * maxCapabilityScope (bounded capability list).
 */
export const AGENT_MACHINE_LIMITS = Object.freeze({
  maxMachines: 256,
  maxIdentifierLength: 64,
  maxReferenceIdLength: 128,
  maxMetadataBytes: 16 * 1024,
  maxMetadataKeys: 32,
  maxMetadataDepth: 4,
  maxMetadataKeyLength: 64,
  maxSteps: 64,
  maxDurationMs: 10 * 60 * 1000,
  maxContinuationBytes: 64 * 1024,
  maxReferences: 8,
  maxChildren: 16,
  maxTasksPerAgent: 64,
  maxCapabilityScope: 32,
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const REFERENCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const FORBIDDEN_KEY = /(?:credential|secret|password|token|cookie|authorization|api[-_]?key|private[-_]?key|host[-_]?path|filesystem|terminal|process|command|shell|mcp|runtime|provider)/i;
const AUTHORITY_KEY = /^(?:permission|permissions|grant|grants|inherit|inheritance|authority|capabilityScope)$/i;

export class AgentMachineError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AgentMachineError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(message, details = {}) {
  throw new AgentMachineError('lego.contract_violation', message, details);
}

function notFound(machineId) {
  throw new AgentMachineError('storage.not_found', `agent machine '${machineId}' does not exist`, { machineId });
}

function conflict(message, details = {}) {
  throw new AgentMachineError('storage.conflict', message, details);
}

function unavailable(message, details = {}) {
  throw new AgentMachineError('lego.unavailable', message, details);
}

function transition(message, details = {}) {
  throw new AgentMachineError('lego.interaction_mismatch', message, details);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

function stableJson(value) {
  return JSON.stringify(value);
}

function bytes(value) {
  return Buffer.byteLength(stableJson(value), 'utf8');
}

function iso(now) {
  const value = now();
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('now() must return an ISO timestamp');
  return value;
}

function assertPlainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be a plain object`);
}

function assertId(value, field, pattern = ID_RE, max = AGENT_MACHINE_LIMITS.maxIdentifierLength) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || !pattern.test(value)) {
    fail(`${field} must be an opaque identifier matching ${pattern} and be 1..${max} characters`);
  }
}

function assertReference(value, field, limits) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > limits.maxReferenceIdLength || !REFERENCE_ID_RE.test(value)) {
    fail(`${field} must be an opaque reference of 1..${limits.maxReferenceIdLength} characters`);
  }
  return value;
}

function validateJsonValue(value, path, depth, limits, seen = new Set()) {
  if (depth > limits.maxMetadataDepth) fail(`${path} exceeds metadata nesting depth ${limits.maxMetadataDepth}`, { limit: limits.maxMetadataDepth });
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== 'object') fail(`${path} contains unsupported value type '${typeof value}'`);
  if (seen.has(value)) fail(`${path} contains a cyclic value`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) validateJsonValue(value[i], `${path}[${i}]`, depth + 1, limits, seen);
  } else {
    const keys = Object.keys(value);
    if (keys.length > limits.maxMetadataKeys) fail(`${path} exceeds metadata key limit ${limits.maxMetadataKeys}`, { limit: limits.maxMetadataKeys });
    for (const key of keys) {
      if (key.length === 0 || key.length > limits.maxMetadataKeyLength) fail(`${path} has a metadata key longer than ${limits.maxMetadataKeyLength} characters`);
      if (FORBIDDEN_KEY.test(key)) fail(`${path}.${key} is forbidden: Agent Machine metadata cannot carry authority, credentials or runtime handles`);
      validateJsonValue(value[key], `${path}.${key}`, depth + 1, limits, seen);
    }
  }
  seen.delete(value);
}

function validateMetadata(metadata, limits) {
  assertPlainObject(metadata, 'metadata');
  validateJsonValue(metadata, 'metadata', 0, limits);
  const safe = clone(metadata);
  const size = bytes(safe);
  if (size > limits.maxMetadataBytes) fail(`metadata exceeds ${limits.maxMetadataBytes} bytes`, { size, limit: limits.maxMetadataBytes });
  return safe;
}

function validateBudgets(budgets, limits) {
  assertPlainObject(budgets, 'budgets');
  const entries = Object.entries(budgets);
  if (entries.length === 0) fail('budgets must declare at least one bounded dimension');
  const declared = {
    maxSteps: 0,
    maxDurationMs: 0,
    maxContinuationBytes: 0,
    maxReferences: 0,
    maxChildren: 0,
    maxTasksPerAgent: 0,
  };
  for (const [key, value] of entries) {
    if (!Object.keys(declared).includes(key)) fail(`budgets declares unknown dimension '${key}'`);
    if (!Number.isInteger(value) || value <= 0) fail(`budgets.${key} must be a positive integer`);
    const ceiling = limits[key];
    if (value > ceiling) fail(`budgets.${key} exceeds the bounded ceiling ${ceiling}`, { value, limit: ceiling });
    declared[key] = value;
  }
  return Object.freeze(declared);
}

/**
 * Capability scope: a bounded list of capability ids from the
 * lego-foundation capability registry. Unknown ids, duplicates and
 * overlong lists all fail closed — a machine never widens its scope by
 * declaring something the registry does not publish.
 */
function validateCapabilityScope(capabilityScope, limits) {
  if (capabilityScope === undefined) return Object.freeze([]);
  if (!Array.isArray(capabilityScope)) fail('capabilityScope must be an array of registry capability ids');
  if (capabilityScope.length > limits.maxCapabilityScope) {
    fail(`capabilityScope exceeds the bounded ceiling ${limits.maxCapabilityScope}`, { limit: limits.maxCapabilityScope });
  }
  const seen = new Set();
  for (const entry of capabilityScope) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > limits.maxIdentifierLength) {
      fail('capabilityScope entries must be opaque capability identifiers');
    }
    if (seen.has(entry)) fail(`capabilityScope repeats capability '${entry}'`, { capability: entry });
    if (getCapability(entry) === null) fail(`capabilityScope names unknown capability '${entry}' (fail-closed against the lego-foundation capability registry)`, { capability: entry });
    seen.add(entry);
  }
  return Object.freeze([...capabilityScope]);
}

function assertLifecycleState(lifecycle) {
  if (!AGENT_MACHINE_LIFECYCLE_STATES.includes(lifecycle)) {
    fail(`lifecycle must be one of ${AGENT_MACHINE_LIFECYCLE_STATES.join(', ')}`);
  }
}

function assertStepOutcome(outcome) {
  if (!AGENT_MACHINE_STEP_OUTCOMES.includes(outcome)) {
    fail(`step result.outcome must be one of ${AGENT_MACHINE_STEP_OUTCOMES.join(', ')}`);
  }
}

function terminalOf(record) {
  return AGENT_MACHINE_LIFECYCLE.terminal.includes(record.lifecycle);
}

function publicMachine(record) {
  return freezeDeep(clone(record));
}

// ---------------------------------------------------------------------------
// Bounded execution-graph validation (representation only, never execution)
// ---------------------------------------------------------------------------

const GRAPH_NODE_KEY_ALLOWLIST = new Set(['id', 'kind', 'dependsOn', 'retry', 'condition']);

/**
 * Validate a bounded execution graph: sequential, parallel, branch,
 * fan-out, fan-in, join and bounded retry. Rejects cycles, dangling
 * references, self-dependencies, duplicate ids, unknown kinds, unbounded
 * fan-out, multiple or missing entries, retry beyond the ceiling and any
 * node that tries to declare permission/authority fields — a graph grants
 * nothing and executes nothing.
 *
 * Returns a frozen summary { nodes, nodeCount, edgeCount, entry }.
 */
export function validateAgentGraph(graph) {
  assertPlainObject(graph, 'graph');
  for (const key of Object.keys(graph)) {
    if (key !== 'nodes') fail(`graph declares non-public field '${key}'`, { key });
  }
  if (!Array.isArray(graph.nodes)) fail('graph.nodes must be an array');
  if (graph.nodes.length === 0) fail('graph.nodes must contain at least one node');
  if (graph.nodes.length > AGENT_GRAPH_LIMITS.maxNodes) {
    fail(`graph exceeds the node ceiling ${AGENT_GRAPH_LIMITS.maxNodes}`, { limit: AGENT_GRAPH_LIMITS.maxNodes });
  }

  const seenIds = new Set();
  const nodes = graph.nodes.map((node, index) => {
    assertPlainObject(node, `graph.nodes[${index}]`);
    for (const key of Object.keys(node)) {
      if (AUTHORITY_KEY.test(key)) {
        fail(`graph node '${index}' declares authority field '${key}': a graph never carries permissions, grants or inheritance (fail-closed)`, { key });
      }
      if (!GRAPH_NODE_KEY_ALLOWLIST.has(key)) {
        fail(`graph.nodes[${index}] declares non-public field '${key}'`, { key });
      }
    }
    assertId(node.id, `graph.nodes[${index}].id`);
    if (seenIds.has(node.id)) fail(`graph repeats node id '${node.id}'`, { nodeId: node.id });
    seenIds.add(node.id);
    if (!AGENT_GRAPH_NODE_KINDS.includes(node.kind)) {
      fail(`graph.nodes[${index}].kind must be one of ${AGENT_GRAPH_NODE_KINDS.join(', ')}`, { kind: node.kind });
    }
    const dependsOn = node.dependsOn === undefined ? [] : node.dependsOn;
    if (!Array.isArray(dependsOn)) fail(`graph.nodes[${index}].dependsOn must be an array`);
    if (dependsOn.length > AGENT_GRAPH_LIMITS.maxDependencies) {
      fail(`graph.nodes[${index}] exceeds the dependency ceiling ${AGENT_GRAPH_LIMITS.maxDependencies}`, { limit: AGENT_GRAPH_LIMITS.maxDependencies });
    }
    const depSeen = new Set();
    for (const dep of dependsOn) {
      if (typeof dep !== 'string') fail(`graph.nodes[${index}].dependsOn entries must be node ids`);
      if (dep === node.id) fail(`graph node '${node.id}' depends on itself`, { nodeId: node.id });
      if (depSeen.has(dep)) fail(`graph.nodes[${index}] repeats dependency '${dep}'`, { dependency: dep });
      depSeen.add(dep);
    }
    if (node.kind === 'retry') {
      const retry = node.retry;
      assertPlainObject(retry, `graph.nodes[${index}].retry`);
      for (const key of Object.keys(retry)) {
        if (key !== 'attempts') fail(`graph.nodes[${index}].retry declares non-public field '${key}'`, { key });
      }
      const attempts = retry.attempts;
      if (!Number.isInteger(attempts) || attempts < 1 || attempts > AGENT_GRAPH_LIMITS.maxRetryAttempts) {
        fail(`graph.nodes[${index}].retry.attempts must be an integer of 1..${AGENT_GRAPH_LIMITS.maxRetryAttempts} (bounded retry)`, {
          limit: AGENT_GRAPH_LIMITS.maxRetryAttempts,
        });
      }
    } else if (node.retry !== undefined) {
      fail(`graph.nodes[${index}] declares retry on non-retry kind '${node.kind}'`, { kind: node.kind });
    }
    if (node.condition !== undefined) {
      if (node.kind !== 'branch') fail(`graph.nodes[${index}] declares condition on non-branch kind '${node.kind}'`, { kind: node.kind });
      if (typeof node.condition !== 'string' || node.condition.length === 0 || node.condition.length > AGENT_MACHINE_LIMITS.maxIdentifierLength) {
        fail(`graph.nodes[${index}].condition must be a bounded identifier string`);
      }
    }
    return Object.freeze({
      id: node.id,
      kind: node.kind,
      dependsOn: Object.freeze([...dependsOn]),
      ...(node.kind === 'retry' ? { retry: Object.freeze({ attempts: node.retry.attempts }) } : {}),
      ...(node.condition !== undefined ? { condition: node.condition } : {}),
    });
  });

  // Every dependency must resolve to a declared node.
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (!seenIds.has(dep)) fail(`graph node '${node.id}' depends on unknown node '${dep}'`, { nodeId: node.id, dependency: dep });
    }
  }

  // Bounded fan-out: out-degree of every node is capped by the dependency
  // ceiling, so no node can expand without bound.
  const outDegree = new Map(nodes.map((node) => [node.id, 0]));
  const inDegree = new Map(nodes.map((node) => [node.id, node.dependsOn.length]));
  for (const node of nodes) {
    for (const dep of node.dependsOn) outDegree.set(dep, outDegree.get(dep) + 1);
  }
  for (const node of nodes) {
    const out = outDegree.get(node.id);
    if (out > AGENT_GRAPH_LIMITS.maxDependencies) {
      fail(`graph node '${node.id}' fans out to ${out} nodes, beyond the ceiling ${AGENT_GRAPH_LIMITS.maxDependencies}`, {
        nodeId: node.id, limit: AGENT_GRAPH_LIMITS.maxDependencies,
      });
    }
  }

  // Cycle detection on a COPY of the indegrees (Kahn): the input graph is
  // never mutated, and a cyclic graph is rejected rather than partially run.
  const remaining = new Map(inDegree);
  const queue = nodes.filter((node) => remaining.get(node.id) === 0).map((node) => node.id);
  let processed = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    processed += 1;
    for (const node of nodes) {
      if (node.dependsOn.includes(current)) {
        const next = remaining.get(node.id) - 1;
        remaining.set(node.id, next);
        if (next === 0) queue.push(node.id);
      }
    }
  }
  if (processed !== nodes.length) fail('graph contains a cycle (bounded validation rejects cyclic graphs)');

  // Exactly one entry node.
  const entries = nodes.filter((node) => node.dependsOn.length === 0);
  if (entries.length !== 1) {
    fail(`graph must have exactly one entry node, found ${entries.length}`, { entries: entries.length });
  }

  // Kind degree rules: fan-out needs >= 2 dependents; fan-in and join need
  // >= 2 dependencies. (A degree of 1 is not a fan or a join.)
  for (const node of nodes) {
    if (node.kind === 'fan-out' && outDegree.get(node.id) <= 1) {
      fail(`fan-out node '${node.id}' must depend on nothing and fan out to at least 2 nodes`, { nodeId: node.id });
    }
    if ((node.kind === 'fan-in' || node.kind === 'join') && node.dependsOn.length <= 1) {
      fail(`${node.kind} node '${node.id}' must combine at least 2 dependencies`, { nodeId: node.id });
    }
  }

  const entry = entries[0].id;
  const edgeCount = nodes.reduce((total, node) => total + node.dependsOn.length, 0);
  return Object.freeze({
    nodes: Object.freeze(nodes),
    nodeCount: nodes.length,
    edgeCount,
    entry,
  });
}

// ---------------------------------------------------------------------------
// Universal Agent Event derivation (session-scoped, reference-only)
// ---------------------------------------------------------------------------

/**
 * Derive the Universal Agent Events implied by a bounded machine record.
 * Deterministic, sanitized and session-scoped: the session id is the opaque
 * sessionReference, correlation is the machineId, causation stays null until
 * a causation contract publishes it, and no metadata, step payload,
 * continuation, reasoning or secret ever enters an event.
 */
export function deriveAgentMachineEvents(record) {
  assertPlainObject(record, 'agent machine record');
  assertId(record.machineId, 'machineId');
  assertId(record.taskId, 'taskId');
  assertId(record.agentId, 'agentId');
  assertLifecycleState(record.lifecycle);
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) {
    fail('record.createdAt must be an ISO timestamp');
  }
  const sessionId = record.sessionReference === undefined ? null : record.sessionReference;
  if (sessionId !== null) assertReference(sessionId, 'sessionReference', AGENT_MACHINE_LIMITS);

  const base = Object.freeze({
    contract: 'ai.agent-machine',
    contractVersion: AGENT_MACHINE_CONTRACT_VERSION,
    machineId: record.machineId,
    agentId: record.agentId,
    taskId: record.taskId,
    sessionId,
    correlationId: record.machineId,
    causationId: null,
  });
  const events = [];
  const push = (type, occurredAt, extra = {}) => {
    if (!AGENT_MACHINE_EVENT_TYPES.includes(type)) fail(`unknown agent machine event type '${type}'`);
    if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) fail(`${type} requires a valid occurredAt timestamp`);
    events.push(Object.freeze({ ...base, type, occurredAt, ...extra }));
  };

  push('agent.created', record.createdAt);
  if (record.startedAt !== undefined && record.startedAt !== null) push('agent.started', record.startedAt);

  if (Array.isArray(record.delegations)) {
    for (const edge of record.delegations) {
      assertPlainObject(edge, 'delegation edge');
      push('agent.delegated', edge.createdAt, {
        childAgentId: edge.childAgentId,
        grants: Object.freeze([...(edge.grants ?? [])]),
      });
    }
  }

  if (record.lifecycle === 'completed') push('agent.completed', record.updatedAt);
  if (record.lifecycle === 'failed') {
    push('agent.failed', record.updatedAt, {
      failure: record.failure === null || record.failure === undefined ? null : Object.freeze(clone(record.failure)),
    });
  }
  if (record.lifecycle === 'cancelled') push('agent.cancelled', record.updatedAt);

  for (const event of events) {
    if (!AGENT_MACHINE_EVENT_TYPES.includes(event.type)) fail('derived event type outside the published vocabulary');
  }
  return Object.freeze(events);
}

// ---------------------------------------------------------------------------
// Provider / executor seam
// ---------------------------------------------------------------------------

/**
 * Minimal provider seam. The provider stores opaque Agent Machine records
 * only: it never receives a step payload to execute, a command, a path, a
 * credential or a runtime handle. `supports(kind)` is mandatory so executor
 * capabilities cannot become implicit Agent Machine capabilities. The default
 * provider is bounded, in-memory and process-local — it claims no durability
 * and no execution.
 */
export class InMemoryAgentMachineProvider {
  constructor() {
    this.store = new Map();
  }

  supports(kind) {
    return kind === 'IN_MEMORY';
  }

  put(record) {
    this.store.set(record.machineId, clone(record));
  }

  get(machineId) {
    const record = this.store.get(machineId);
    return record ? clone(record) : null;
  }

  list() {
    return Array.from(this.store.values()).map(clone);
  }

  clear() {
    this.store.clear();
  }

  get size() {
    return this.store.size;
  }
}

function makeManager(options = {}) {
  const provider = options.provider ?? new InMemoryAgentMachineProvider();
  const now = options.now ?? (() => new Date().toISOString());
  const limits = Object.freeze({ ...AGENT_MACHINE_LIMITS, ...(options.limits ?? {}) });

  if (typeof provider.supports !== 'function' || typeof provider.put !== 'function'
    || typeof provider.get !== 'function' || typeof provider.list !== 'function') {
    fail('provider must implement { supports, put, get, list }');
  }

  function get(machineId) {
    assertId(machineId, 'machineId');
    return provider.get(machineId);
  }

  function load(machineId, operation) {
    const record = get(machineId);
    if (!record) notFound(machineId);
    assertLifecycleState(record.lifecycle);
    return record;
  }

  /** Optimistic concurrency: every mutation must name the version it read. */
  function assertVersion(record, input, operation) {
    const expected = input.expectedVersion;
    if (!Number.isInteger(expected) || expected < 1) {
      fail(`${operation} requires expectedVersion, the machine version the caller last read`);
    }
    if (expected !== record.version) {
      conflict(`${operation} received a stale expectedVersion: machine '${record.machineId}' is at version ${record.version}, the caller expected ${expected}`, {
        machineId: record.machineId,
        actual: record.version,
        expected,
      });
    }
  }

  function commit(record, timestamp) {
    const next = { ...record, version: record.version + 1, updatedAt: timestamp };
    provider.put(next);
    return next;
  }

  function assertKind(kind) {
    if (typeof kind !== 'string' || !AGENT_MACHINE_EXECUTOR_KINDS.includes(kind)) {
      fail(`executorKind must be one of ${AGENT_MACHINE_EXECUTOR_KINDS.join(', ')}`);
    }
  }

  function create(input) {
    assertPlainObject(input, 'create input');
    const {
      machineId,
      taskId,
      agentId,
      executorKind = 'IN_MEMORY',
      sessionReference,
      contextReference,
      workspaceReference,
      capabilityScope,
      budgets,
      metadata = {},
    } = input;
    assertId(machineId, 'machineId');
    assertId(taskId, 'taskId');
    assertId(agentId, 'agentId');
    assertKind(executorKind);
    assertReference(sessionReference, 'sessionReference', limits);
    assertReference(contextReference, 'contextReference', limits);
    assertReference(workspaceReference, 'workspaceReference', limits);
    const safeCapabilityScope = validateCapabilityScope(capabilityScope, limits);
    const safeBudgets = validateBudgets(budgets, limits);
    const safeMetadata = validateMetadata(metadata, limits);
    const existing = get(machineId);
    if (existing) conflict(`agent machine '${machineId}' already exists`, { machineId });
    if (provider.list().length >= limits.maxMachines) {
      fail('agent machine store has reached its bounded machine limit', { limit: limits.maxMachines });
    }
    // maxTasksPerAgent: one agent identity never holds more machines (tasks)
    // than its declared bound (or the global ceiling when undeclared).
    const taskBound = safeBudgets.maxTasksPerAgent > 0 ? safeBudgets.maxTasksPerAgent : limits.maxTasksPerAgent;
    const agentTaskCount = provider.list().filter((entry) => entry.agentId === agentId).length;
    if (agentTaskCount >= taskBound) {
      fail(`agent '${agentId}' has reached its bounded task ceiling ${taskBound}`, {
        budget: 'maxTasksPerAgent', agentId, limit: taskBound,
      });
    }
    if (!provider.supports(executorKind)) {
      unavailable(`provider does not support executor kind '${executorKind}'`, { executorKind });
    }
    const timestamp = iso(now);
    const record = {
      machineId,
      taskId,
      agentId,
      executorKind,
      lifecycle: 'created',
      sessionReference: sessionReference ?? null,
      contextReference: contextReference ?? null,
      workspaceReference: workspaceReference ?? null,
      capabilityScope: safeCapabilityScope,
      budgets: safeBudgets,
      metadata: safeMetadata,
      steps: [],
      stepCount: 0,
      delegations: [],
      startedAt: null,
      failure: null,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    provider.put(record);
    return publicMachine(record);
  }

  function describe(input) {
    assertPlainObject(input, 'describe input');
    assertId(input.machineId, 'machineId');
    const record = get(input.machineId);
    return record ? publicMachine(record) : null;
  }

  function prepare(input) {
    assertPlainObject(input, 'prepare input');
    const record = load(input.machineId, 'prepare');
    // Idempotent: a ready machine stays ready.
    if (record.lifecycle === 'ready') return publicMachine(record);
    assertVersion(record, input, 'agentMachine.prepare');
    if (terminalOf(record)) transition(`terminal agent machine '${record.machineId}' (${record.lifecycle}) cannot be prepared`, { machineId: record.machineId, lifecycle: record.lifecycle });
    if (record.lifecycle !== 'created') transition(`agent machine '${record.machineId}' cannot be prepared from '${record.lifecycle}'`, { machineId: record.machineId, lifecycle: record.lifecycle });
    const next = commit({ ...record, lifecycle: 'ready' }, iso(now));
    return publicMachine(next);
  }

  function start(input) {
    assertPlainObject(input, 'start input');
    const record = load(input.machineId, 'start');
    // Idempotent: a running machine stays running.
    if (record.lifecycle === 'running') return publicMachine(record);
    assertVersion(record, input, 'agentMachine.start');
    if (terminalOf(record)) transition(`terminal agent machine '${record.machineId}' (${record.lifecycle}) cannot be started`, { machineId: record.machineId, lifecycle: record.lifecycle });
    if (record.lifecycle !== 'created' && record.lifecycle !== 'ready') {
      transition(`agent machine '${record.machineId}' cannot be started from '${record.lifecycle}'`, { machineId: record.machineId, lifecycle: record.lifecycle });
    }
    const next = commit({ ...record, lifecycle: 'running', startedAt: iso(now) }, iso(now));
    return publicMachine(next);
  }

  function step(input) {
    assertPlainObject(input, 'step input');
    const record = load(input.machineId, 'step');
    if (record.lifecycle !== 'running') {
      transition(`agent machine '${record.machineId}' is '${record.lifecycle}'; a step is accepted only while running`, { machineId: record.machineId, lifecycle: record.lifecycle });
    }
    assertVersion(record, input, 'agentMachine.step');
    const {
      stepId,
      sequence,
      inputReference,
      approvalReference,
      result,
    } = input;
    assertId(stepId, 'stepId');
    if (record.steps.some((entry) => entry.stepId === stepId)) {
      conflict(`step '${stepId}' was already recorded for machine '${record.machineId}'`, { machineId: record.machineId, stepId });
    }
    const expectedSequence = record.stepCount + 1;
    if (!Number.isInteger(sequence) || sequence !== expectedSequence) {
      conflict(`step sequence must be ${expectedSequence} for machine '${record.machineId}'; a stale or duplicate submission is refused`, {
        machineId: record.machineId,
        expectedSequence,
        received: sequence ?? null,
      });
    }
    const safeInputReference = assertReference(inputReference, 'inputReference', limits);
    const safeApprovalReference = assertReference(approvalReference, 'approvalReference', limits);
    assertPlainObject(result, 'result');
    const {
      outcome,
      final = false,
      resultReference,
      errorReference,
      continuation,
    } = result;
    assertStepOutcome(outcome);
    if (typeof final !== 'boolean') fail('result.final must be a boolean');
    const safeResultReference = assertReference(resultReference, 'result.resultReference', limits);
    const safeErrorReference = assertReference(errorReference, 'result.errorReference', limits);
    let safeContinuation = null;
    if (continuation !== undefined) {
      if (typeof continuation !== 'string') fail('result.continuation must be a bounded string');
      const size = Buffer.byteLength(continuation, 'utf8');
      if (size > record.budgets.maxContinuationBytes) {
        fail(`result.continuation exceeds the machine continuation budget ${record.budgets.maxContinuationBytes} bytes`, { size, limit: record.budgets.maxContinuationBytes });
      }
      safeContinuation = continuation;
    }
    const referenceCount = [safeInputReference, safeApprovalReference, safeResultReference, safeErrorReference].filter((value) => value !== null).length;
    if (referenceCount > record.budgets.maxReferences) {
      fail(`step references exceed the machine reference budget ${record.budgets.maxReferences}`, { count: referenceCount, limit: record.budgets.maxReferences });
    }
    if (outcome === 'approval-required' && safeApprovalReference === null) {
      fail('an approval-required step must carry an approvalReference to the ai.approval record that gates it (fail-closed)');
    }

    // Budget gates: exhausted budget is a stable terminal failure, never a
    // rejected call that leaves the machine pretending it can continue.
    if (record.stepCount >= record.budgets.maxSteps) {
      commit({
        ...record,
        lifecycle: 'failed',
        failure: { code: 'budget-exhausted', budget: 'maxSteps', stepId },
      }, iso(now));
      fail(`step '${stepId}' exceeds the machine step budget: machine '${record.machineId}' is now terminally failed (budget-exhausted)`, {
        machineId: record.machineId,
        budget: 'maxSteps',
        limit: record.budgets.maxSteps,
      });
    }
    const elapsedMs = Date.parse(iso(now)) - Date.parse(record.startedAt);
    if (elapsedMs >= record.budgets.maxDurationMs) {
      commit({
        ...record,
        lifecycle: 'failed',
        failure: { code: 'budget-exhausted', budget: 'maxDurationMs', stepId },
      }, iso(now));
      fail(`step '${stepId}' exceeds the machine duration budget: machine '${record.machineId}' is now terminally failed (budget-exhausted)`, {
        machineId: record.machineId,
        budget: 'maxDurationMs',
        limit: record.budgets.maxDurationMs,
      });
    }

    const stepRecord = {
      stepId,
      sequence: expectedSequence,
      inputReference: safeInputReference,
      approvalReference: safeApprovalReference,
      outcome,
      final,
      resultReference: safeResultReference,
      errorReference: safeErrorReference,
      continuation: safeContinuation,
      recordedAt: iso(now),
    };
    let lifecycle = record.lifecycle;
    let failure = record.failure;
    if (outcome === 'succeeded') {
      if (final) {
        lifecycle = 'completed';
      }
    } else if (outcome === 'failed') {
      lifecycle = 'failed';
      failure = { code: 'step-failed', stepId, errorReference: safeErrorReference };
    } else if (outcome === 'cancelled') {
      lifecycle = 'cancelled';
    } else {
      lifecycle = 'waiting';
    }
    const next = commit({
      ...record,
      lifecycle,
      failure,
      steps: [...record.steps, stepRecord],
      stepCount: record.stepCount + 1,
    }, iso(now));
    return publicMachine(next);
  }

  function pause(input) {
    assertPlainObject(input, 'pause input');
    const record = load(input.machineId, 'pause');
    // Idempotent: a paused machine stays paused.
    if (record.lifecycle === 'paused') return publicMachine(record);
    assertVersion(record, input, 'agentMachine.pause');
    if (record.lifecycle !== 'running') {
      transition(`agent machine '${record.machineId}' cannot be paused from '${record.lifecycle}'`, { machineId: record.machineId, lifecycle: record.lifecycle });
    }
    const next = commit({ ...record, lifecycle: 'paused' }, iso(now));
    return publicMachine(next);
  }

  function resume(input) {
    assertPlainObject(input, 'resume input');
    const record = load(input.machineId, 'resume');
    // Idempotent: a running machine stays running.
    if (record.lifecycle === 'running') return publicMachine(record);
    assertVersion(record, input, 'agentMachine.resume');
    if (terminalOf(record)) transition(`terminal agent machine '${record.machineId}' (${record.lifecycle}) cannot be resumed`, { machineId: record.machineId, lifecycle: record.lifecycle });
    if (record.lifecycle === 'waiting') {
      transition(`agent machine '${record.machineId}' is waiting on an approval reference; P2.16 has no approval resolution, so it can only be cancelled (fail-closed)`, { machineId: record.machineId, lifecycle: record.lifecycle });
    }
    if (record.lifecycle !== 'paused') transition(`agent machine '${record.machineId}' cannot be resumed from '${record.lifecycle}'`, { machineId: record.machineId, lifecycle: record.lifecycle });
    const next = commit({ ...record, lifecycle: 'running' }, iso(now));
    return publicMachine(next);
  }

  /**
   * Bounded delegation bookkeeping: one explicit, narrowed edge. Grants are
   * a non-empty subset of THIS machine's capabilityScope — never inherited,
   * never widened, never a permission the parent does not hold. Child budget
   * dimensions are clamped to the parent's declared budgets and the child
   * deadline is clamped to the parent deadline. maxChildren bounds the edge
   * count (undeclared = 0 edges: delegation is opt-in and fail-closed).
   */
  function delegate(input) {
    assertPlainObject(input, 'delegate input');
    const record = load(input.machineId, 'delegate');
    if (record.lifecycle !== 'ready' && record.lifecycle !== 'running') {
      transition(`agent machine '${record.machineId}' is '${record.lifecycle}'; delegation bookkeeping is accepted only while ready or running`, {
        machineId: record.machineId, lifecycle: record.lifecycle,
      });
    }
    assertVersion(record, input, 'agentMachine.delegate');
    const { delegationId, childAgentId, grants, budget, deadline } = input;
    assertId(delegationId, 'delegationId');
    assertId(childAgentId, 'childAgentId');
    if (childAgentId === record.agentId) fail('a machine cannot delegate to its own agent identity', { agentId: record.agentId });
    if (record.delegations.some((edge) => edge.delegationId === delegationId)) {
      conflict(`delegation '${delegationId}' was already recorded for machine '${record.machineId}'`, { machineId: record.machineId, delegationId });
    }
    if (!Array.isArray(grants) || grants.length === 0) {
      fail('delegation grants must be a non-empty array of narrowed capability ids (fail-closed)', { delegationId });
    }
    const grantSeen = new Set();
    for (const grant of grants) {
      if (typeof grant !== 'string' || grant.length === 0 || grant.length > limits.maxIdentifierLength) {
        fail('delegation grants must be opaque capability identifiers', { delegationId });
      }
      if (grantSeen.has(grant)) fail(`delegation repeats grant '${grant}'`, { delegationId, grant });
      if (!record.capabilityScope.includes(grant)) {
        fail(`delegation grant '${grant}' is not in the machine capability scope: grants are an explicit narrowed subset, never inherited`, {
          delegationId, grant,
        });
      }
      grantSeen.add(grant);
    }
    // maxChildren is a per-machine budget: undeclared (0) means no edges.
    if (record.delegations.length >= record.budgets.maxChildren) {
      fail(`machine '${record.machineId}' has reached its delegation budget maxChildren ${record.budgets.maxChildren}`, {
        budget: 'maxChildren', machineId: record.machineId, limit: record.budgets.maxChildren,
      });
    }
    // Child budget: declared dimensions are clamped to the parent's budgets.
    let childBudget = {};
    if (budget !== undefined) {
      assertPlainObject(budget, 'delegation budget');
      const parentDims = ['maxSteps', 'maxDurationMs', 'maxContinuationBytes', 'maxReferences', 'maxChildren', 'maxTasksPerAgent'];
      for (const [key, value] of Object.entries(budget)) {
        if (!parentDims.includes(key)) fail(`delegation budget declares unknown dimension '${key}'`, { key });
        if (!Number.isInteger(value) || value <= 0) fail(`delegation budget.${key} must be a positive integer`, { key });
        childBudget[key] = Math.min(value, record.budgets[key]);
      }
    }
    // Child deadline: clamped to the parent deadline (start/creation + duration budget).
    const parentBase = Date.parse(record.startedAt ?? record.createdAt);
    const parentDeadline = parentBase + record.budgets.maxDurationMs;
    let childDeadline = parentDeadline;
    if (deadline !== undefined) {
      if (typeof deadline !== 'string' || Number.isNaN(Date.parse(deadline))) {
        fail('delegation deadline must be an ISO timestamp');
      }
      childDeadline = Math.min(Date.parse(deadline), parentDeadline);
    }
    const edge = Object.freeze({
      delegationId,
      childAgentId,
      grants: Object.freeze([...grants]),
      budget: Object.freeze({ ...childBudget }),
      deadline: new Date(childDeadline).toISOString(),
      createdAt: iso(now),
    });
    const next = commit({ ...record, delegations: [...record.delegations, edge] }, iso(now));
    return publicMachine(next);
  }

  function cancel(input) {
    assertPlainObject(input, 'cancel input');
    const record = load(input.machineId, 'cancel');
    // Idempotent: a cancelled machine stays cancelled.
    if (record.lifecycle === 'cancelled') return publicMachine(record);
    assertVersion(record, input, 'agentMachine.cancel');
    if (terminalOf(record)) {
      transition(`terminal agent machine '${record.machineId}' is '${record.lifecycle}'; it cannot be cancelled into another outcome`, { machineId: record.machineId, lifecycle: record.lifecycle });
    }
    const next = commit({ ...record, lifecycle: 'cancelled' }, iso(now));
    return publicMachine(next);
  }

  return Object.freeze({
    contract: AGENT_MACHINE_CONTRACT_VERSION,
    limits,
    provider,
    create,
    describe,
    prepare,
    start,
    step,
    pause,
    resume,
    delegate,
    cancel,
    get count() { return provider.list().length; },
    clear: () => provider.clear?.(),
  });
}

export function createAgentMachineManager(options = {}) {
  return makeManager(options);
}

export const createAgentMachineProvider = () => new InMemoryAgentMachineProvider();
export const AGENT_MACHINE_MANIFEST = Object.freeze(clone(MANIFEST));
