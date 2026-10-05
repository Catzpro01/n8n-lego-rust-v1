/**
 * P2.16 Agent Machine LEGO contract and bounded-execution-foundation tests.
 *
 * ai.agent-machine@1.1.0 — RE-DERIVED from the frozen P2.16 1.1.0
 * specification (additive over the locked 1.0.0 publication) after the
 * original local-only commits proved unavailable on GitHub.
 *
 * These tests exercise only the published ai.agent-machine surface. They prove
 * that Agent Machine owns one canonical bounded execution state machine —
 * machine/agent/task identity, lifecycle (incl. ready), step bookkeeping,
 * budgets, bounded delegation bookkeeping, bounded graph validation, event
 * derivation and deterministic transitions — while consuming Context, Session,
 * Memory and Workspace by opaque reference only and refusing to become an
 * engine, a shell or a privilege escalation.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  AGENT_GRAPH_LIMITS,
  AGENT_GRAPH_NODE_KINDS,
  AGENT_MACHINE_CONTRACT,
  AGENT_MACHINE_CONTRACT_VERSION,
  AGENT_MACHINE_EVENT_TYPES,
  AGENT_MACHINE_EXECUTOR_KINDS,
  AGENT_MACHINE_FIELDS,
  AGENT_MACHINE_LIMITS,
  AGENT_MACHINE_LIFECYCLE,
  AGENT_MACHINE_LIFECYCLE_STATES,
  AGENT_MACHINE_OPERATION_PERMISSIONS,
  AGENT_MACHINE_OPERATIONS,
  AGENT_MACHINE_PERMISSIONS,
  AGENT_MACHINE_STEP_OUTCOMES,
  AgentMachineError,
  InMemoryAgentMachineProvider,
  agentMachineOperationPermission,
  assertAgentMachinePermission,
  createAgentMachineManager,
  createAgentMachineProvider,
  deriveAgentMachineEvents,
  validateAgentGraph,
} from '../src/lego/agent-machine.mjs';
import { loadRegistry } from '../src/lego/registry.mjs';

const manifest = JSON.parse(readFileSync(new URL('../src/lego/manifest/agent-machine.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
const registry = loadRegistry({ reload: true });
const BUDGETS = { maxSteps: 4, maxDurationMs: 600000, maxContinuationBytes: 64, maxReferences: 8 };
const fresh = (options = {}) => createAgentMachineManager({
  now: (() => {
    let tick = 0;
    return () => `2026-09-22T00:00:0${tick++ % 10}.000Z`;
  })(),
  ...options,
});
const create = (manager, machineId, extra = {}) => manager.create({
  machineId,
  taskId: `task-${machineId}`,
  agentId: `agent-${machineId}`,
  budgets: { ...BUDGETS },
  metadata: { label: machineId },
  ...extra,
});
const start = (manager, machineId, version = 1) => manager.start({ machineId, expectedVersion: version });
const step = (manager, machineId, version, stepId, sequence, result, extra = {}) => manager.step({
  machineId, expectedVersion: version, stepId, sequence, result, ...extra,
});
const codeOf = (error) => (error instanceof AgentMachineError ? error.code : null);
const EXPECTED_OPERATIONS = [
  'agentMachine.create', 'agentMachine.describe', 'agentMachine.prepare', 'agentMachine.start',
  'agentMachine.step', 'agentMachine.pause', 'agentMachine.resume', 'agentMachine.delegate',
  'agentMachine.cancel',
];
const EXPECTED_PERMISSIONS = ['ai:agent:create', 'ai:agent:invoke', 'ai:agent:control', 'ai:agent:read', 'ai:agent:delegate'];
const EXPECTED_STATES = ['created', 'ready', 'running', 'waiting', 'paused', 'completed', 'failed', 'cancelled'];
const EXPECTED_FIELDS = [
  'agentId', 'budgets', 'capabilityScope', 'contextReference', 'createdAt', 'delegations',
  'executorKind', 'failure', 'lifecycle', 'machineId', 'metadata', 'sessionReference',
  'startedAt', 'stepCount', 'steps', 'taskId', 'updatedAt', 'version', 'workspaceReference',
];

/* -------------------------------------------------------------- contract */

test('the contract has one identity, version and bounded published surface', () => {
  assert.equal(AGENT_MACHINE_CONTRACT.id, 'ai.agent-machine');
  assert.equal(AGENT_MACHINE_CONTRACT_VERSION, '1.1.0');
  assert.equal(AGENT_MACHINE_CONTRACT.owner, 'manager');
  assert.deepEqual([...AGENT_MACHINE_OPERATIONS], EXPECTED_OPERATIONS);
  assert.equal(AGENT_MACHINE_OPERATIONS.includes('agentMachine.close'), false, 'close is not part of P2.16 1.1.0');
  assert.deepEqual([...AGENT_MACHINE_PERMISSIONS], EXPECTED_PERMISSIONS);
  assert.deepEqual([...AGENT_MACHINE_LIFECYCLE_STATES], EXPECTED_STATES);
  assert.deepEqual([...AGENT_MACHINE_STEP_OUTCOMES], ['succeeded', 'failed', 'cancelled', 'approval-required']);
  assert.deepEqual([...AGENT_MACHINE_EXECUTOR_KINDS], ['IN_MEMORY', 'EXTERNAL']);
  assert.deepEqual([...AGENT_MACHINE_FIELDS].sort(), EXPECTED_FIELDS);
  assert.equal(manifest.contract, AGENT_MACHINE_CONTRACT.id);
  assert.equal(manifest.version, AGENT_MACHINE_CONTRACT_VERSION);
  assert.equal(manifest.status, 'implemented');
  assert.equal(manifest.operations.length, 9);
  assert.equal(manifest.permissions.includes('ai:agent:delegate'), true,
    '1.1.0 publishes the bounded ai:agent:delegate bookkeeping permission');
  assert.equal(manifest.notScope.some((entry) => entry.includes('the agent loop')), true);
});

test('the lifecycle is the canonical agent vocabulary with fail-closed waiting', () => {
  assert.equal(AGENT_MACHINE_LIFECYCLE.initial, 'created');
  assert.deepEqual([...AGENT_MACHINE_LIFECYCLE.terminal], ['completed', 'failed', 'cancelled']);
  for (const state of AGENT_MACHINE_LIFECYCLE_STATES) {
    assert.ok(AGENT_MACHINE_LIFECYCLE.transitions[state], `${state} declares its exits`);
  }
  assert.deepEqual([...AGENT_MACHINE_LIFECYCLE.transitions.created], ['ready', 'running', 'cancelled'],
    'created can be prepared to ready, started directly (1.0.0 flow unchanged) or cancelled');
  assert.deepEqual([...AGENT_MACHINE_LIFECYCLE.transitions.ready], ['running', 'cancelled']);
  assert.deepEqual([...AGENT_MACHINE_LIFECYCLE.transitions.waiting], ['cancelled'],
    'waiting has exactly one exit: cancel (approval resolution is the ai.approval boundary)');
  assert.deepEqual([...AGENT_MACHINE_LIFECYCLE.transitions.completed], []);
  assert.deepEqual([...AGENT_MACHINE_LIFECYCLE.transitions.failed], []);
  assert.deepEqual([...AGENT_MACHINE_LIFECYCLE.transitions.cancelled], []);
});

test('budgets are bounded and unlimited is not a value', () => {
  assert.equal(AGENT_MACHINE_LIMITS.maxSteps, 64);
  assert.equal(AGENT_MACHINE_LIMITS.maxDurationMs, 10 * 60 * 1000);
  assert.equal(AGENT_MACHINE_LIMITS.maxContinuationBytes, 64 * 1024);
  assert.equal(AGENT_MACHINE_LIMITS.maxReferences, 8);
  assert.equal(AGENT_MACHINE_LIMITS.maxChildren, 16, '1.1.0 bounds delegation edges per machine');
  assert.equal(AGENT_MACHINE_LIMITS.maxTasksPerAgent, 64, '1.1.0 bounds machines per agent identity');
  assert.equal(AGENT_MACHINE_LIMITS.maxCapabilityScope, 32, '1.1.0 bounds the capability list');
  for (const value of Object.values(AGENT_MACHINE_LIMITS)) {
    assert.ok(Number.isFinite(value) && value > 0, 'every ceiling is a positive finite number');
  }
});

test('the registry locks the contract exactly once and the capability matches the contract', () => {
  const rows = registry.contractLock.contracts.filter((contract) => contract.id === 'ai.agent-machine');
  assert.equal(rows.length, 1, 'exactly one locked ai.agent-machine row');
  assert.equal(rows[0].version, '1.1.0');
  assert.equal(rows[0].domain, 'ai-foundation');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual([...rows[0].operations], EXPECTED_OPERATIONS, 'the lock row carries the nine canonical operations');
  assert.deepEqual([...rows[0].permissions], EXPECTED_PERMISSIONS, 'the lock row carries the five canonical permissions');
  const domain = registry.byId.get('ai-foundation');
  assert.ok(domain.paths.includes('src/lego/agent-machine.mjs'), 'the module is claimed by one domain');
  assert.ok(domain.paths.includes('src/lego/manifest/agent-machine.json'), 'the manifest is claimed by one domain');
  assert.ok(domain.public.includes('src/lego/agent-machine.mjs'));
  const capability = domain.capabilities.find((entry) => entry.id === 'ai.agent-machine');
  assert.ok(capability, 'the capability registry declares ai.agent-machine');
  assert.equal(capability.status, 'implemented');
  assert.deepEqual(capability.operations.map((entry) => `agentMachine.${entry.name}`), [...AGENT_MACHINE_OPERATIONS]);
  assert.deepEqual(capability.permissions, [...AGENT_MACHINE_PERMISSIONS]);
  assert.equal(capability.availability, 'available');
});

test('the provider seam is bounded and explicit, and nothing executes work in it', () => {
  const provider = createAgentMachineProvider();
  assert.ok(provider instanceof InMemoryAgentMachineProvider);
  assert.equal(provider.supports('IN_MEMORY'), true);
  assert.equal(provider.supports('EXTERNAL'), false);
  assert.equal(provider.size, 0);
  const manager = fresh();
  assert.deepEqual(
    Object.keys(manager).filter((key) => typeof manager[key] === 'function'),
    ['create', 'describe', 'prepare', 'start', 'step', 'pause', 'resume', 'delegate', 'cancel', 'clear'],
  );
  for (const forbidden of ['execute', 'run', 'invoke', 'spawn', 'shell', 'send', 'stream', 'artifact', 'close']) {
    assert.equal(typeof manager[forbidden], 'undefined', `no ${forbidden} authority is published`);
  }
});

/* ------------------------------------------------------------- lifecycle */

test('the valid lifecycle path reaches each terminal state deterministically', () => {
  const manager = fresh();
  create(manager, 'am-completed');
  assert.equal(start(manager, 'am-completed').lifecycle, 'running');
  const done = step(manager, 'am-completed', 2, 's1', 1, { outcome: 'succeeded', final: true });
  assert.equal(done.lifecycle, 'completed');

  create(manager, 'am-failed');
  start(manager, 'am-failed');
  const failed = step(manager, 'am-failed', 2, 's1', 1, { outcome: 'failed', errorReference: 'err:1' });
  assert.equal(failed.lifecycle, 'failed');
  assert.deepEqual(failed.failure, { code: 'step-failed', stepId: 's1', errorReference: 'err:1' });

  create(manager, 'am-cancelled');
  start(manager, 'am-cancelled');
  assert.equal(manager.cancel({ machineId: 'am-cancelled', expectedVersion: 2 }).lifecycle, 'cancelled');
});

test('invalid transitions fail closed with a stable error', () => {
  const manager = fresh();
  create(manager, 'am-x');
  // pause/resume are not valid from created.
  for (const operation of ['pause', 'resume']) {
    assert.throws(
      () => manager[operation]({ machineId: 'am-x', expectedVersion: 1 }),
      (error) => codeOf(error) === 'lego.interaction_mismatch',
      `${operation} from created must fail`,
    );
  }
  start(manager, 'am-x');
  // start from running is the idempotent no-op, not an error.
  assert.equal(manager.start({ machineId: 'am-x', expectedVersion: 2 }).lifecycle, 'running');
  // cancel from running is valid.
  const cancelled = manager.cancel({ machineId: 'am-x', expectedVersion: 2 });
  assert.equal(cancelled.lifecycle, 'cancelled');
  // terminal machines accept no mutation other than the idempotent cancel.
  assert.equal(manager.cancel({ machineId: 'am-x', expectedVersion: 3 }).lifecycle, 'cancelled');
  for (const operation of ['start', 'pause', 'resume', 'prepare']) {
    assert.throws(
      () => manager[operation]({ machineId: 'am-x', expectedVersion: 3 }),
      (error) => codeOf(error) === 'lego.interaction_mismatch',
      `${operation} on a terminal machine must fail`,
    );
  }
  assert.throws(
    () => step(manager, 'am-x', 3, 's1', 1, { outcome: 'succeeded' }),
    (error) => codeOf(error) === 'lego.interaction_mismatch',
    'a step after cancellation must fail',
  );
});

test('unknown identities fail closed for mutations and resolve to null for reads', () => {
  const manager = fresh();
  assert.equal(manager.describe({ machineId: 'am-ghost' }), null);
  for (const call of [
    () => start(manager, 'am-ghost', 1),
    () => manager.prepare({ machineId: 'am-ghost', expectedVersion: 1 }),
    () => manager.pause({ machineId: 'am-ghost', expectedVersion: 1 }),
    () => manager.resume({ machineId: 'am-ghost', expectedVersion: 1 }),
    () => manager.delegate({ machineId: 'am-ghost', expectedVersion: 1, delegationId: 'd1', childAgentId: 'child-1', grants: ['ai.context'] }),
    () => manager.cancel({ machineId: 'am-ghost', expectedVersion: 1 }),
    () => step(manager, 'am-ghost', 1, 's1', 1, { outcome: 'succeeded' }),
  ]) {
    assert.throws(call, (error) => codeOf(error) === 'storage.not_found');
  }
});

/* ------------------------------------------------------------- execution */

test('a step is one bounded record with identity, sequence, references and budget', () => {
  const manager = createAgentMachineManager({ now: () => '2026-09-22T00:00:00.000Z' });
  manager.create({ machineId: 'am-step', taskId: 'task-am-step', agentId: 'agent-am-step', budgets: { ...BUDGETS }, metadata: { label: 'am-step' }, sessionReference: 'sess-1', contextReference: 'ctx-1', workspaceReference: 'ws-1' });
  const started = start(manager, 'am-step');
  const record = step(manager, 'am-step', started.version, 's1', 1, {
    outcome: 'succeeded',
    final: true,
    resultReference: 'res:1',
    continuation: 'bounded-state',
  }, { inputReference: 'ctx-1:load' });
  assert.equal(record.lifecycle, 'completed');
  assert.equal(record.stepCount, 1);
  assert.deepEqual(record.steps, [{
    stepId: 's1',
    sequence: 1,
    inputReference: 'ctx-1:load',
    approvalReference: null,
    outcome: 'succeeded',
    final: true,
    resultReference: 'res:1',
    errorReference: null,
    continuation: 'bounded-state',
    recordedAt: record.updatedAt,
  }]);
});

test('step sequencing is explicit: stale, out-of-order and duplicate steps are conflicts', () => {
  const manager = fresh();
  create(manager, 'am-seq');
  start(manager, 'am-seq');
  step(manager, 'am-seq', 2, 's1', 1, { outcome: 'succeeded' });
  assert.throws(
    () => step(manager, 'am-seq', 3, 's2', 1, { outcome: 'succeeded' }),
    (error) => codeOf(error) === 'storage.conflict' && error.details.expectedSequence === 2,
    'reusing sequence 1 must be a conflict',
  );
  assert.throws(
    () => step(manager, 'am-seq', 3, 's3', 3, { outcome: 'succeeded' }),
    (error) => codeOf(error) === 'storage.conflict',
    'skipping ahead must be a conflict',
  );
  step(manager, 'am-seq', 3, 's2', 2, { outcome: 'succeeded' });
  assert.throws(
    () => step(manager, 'am-seq', 4, 's2', 3, { outcome: 'succeeded' }),
    (error) => codeOf(error) === 'storage.conflict',
    'a duplicate stepId must be a conflict',
  );
});

test('budget exhaustion is a stable error and a stable terminal failure', () => {
  const manager = fresh();
  create(manager, 'am-budget', { budgets: { ...BUDGETS, maxSteps: 1 } });
  start(manager, 'am-budget');
  step(manager, 'am-budget', 2, 's1', 1, { outcome: 'succeeded' });
  assert.throws(
    () => step(manager, 'am-budget', 3, 's2', 2, { outcome: 'succeeded' }),
    (error) => codeOf(error) === 'lego.contract_violation' && error.details.budget === 'maxSteps',
  );
  const exhausted = manager.describe({ machineId: 'am-budget' });
  assert.equal(exhausted.lifecycle, 'failed');
  assert.deepEqual(exhausted.failure, { code: 'budget-exhausted', budget: 'maxSteps', stepId: 's2' });
});

test('the duration budget bounds the execution window', () => {
  let tick = 0;
  const manager = createAgentMachineManager({
    now: () => `2026-09-22T00:00:${String(tick).padStart(2, '0')}.000Z`,
    limits: { ...AGENT_MACHINE_LIMITS },
  });
  manager.create({ machineId: 'am-dur', taskId: 't', agentId: 'agent-t', budgets: { ...BUDGETS, maxDurationMs: 1000 } });
  manager.start({ machineId: 'am-dur', expectedVersion: 1 });
  tick = 5; // 5 seconds later: beyond the 1 second budget
  assert.throws(
    () => manager.step({ machineId: 'am-dur', expectedVersion: 2, stepId: 's1', sequence: 1, result: { outcome: 'succeeded' } }),
    (error) => codeOf(error) === 'lego.contract_violation' && error.details.budget === 'maxDurationMs',
  );
  assert.equal(manager.describe({ machineId: 'am-dur' }).failure.code, 'budget-exhausted');
});

test('continuation size and per-step reference counts are bounded', () => {
  const manager = fresh();
  create(manager, 'am-continuation', { budgets: { ...BUDGETS, maxContinuationBytes: 8 } });
  start(manager, 'am-continuation');
  assert.throws(
    () => step(manager, 'am-continuation', 2, 's1', 1, { outcome: 'succeeded', continuation: 'longer than eight bytes' }),
    (error) => codeOf(error) === 'lego.contract_violation' && /continuation/.test(error.message),
  );
  create(manager, 'am-refs', { budgets: { ...BUDGETS, maxReferences: 3 } });
  start(manager, 'am-refs');
  assert.throws(
    () => step(manager, 'am-refs', 2, 's1', 1, {
      outcome: 'succeeded', resultReference: 'r:1', errorReference: 'r:2',
    }, { inputReference: 'r:3', approvalReference: 'r:4' }),
    (error) => codeOf(error) === 'lego.contract_violation' && /reference budget/.test(error.message),
  );
});

test('budget declarations are validated at create and clamped to the ceilings', () => {
  const manager = fresh();
  for (const budgets of [
    {},
    { maxSteps: 0 },
    { maxSteps: -1 },
    { maxSteps: 1.5 },
    { maxSteps: 'many' },
    { maxSteps: AGENT_MACHINE_LIMITS.maxSteps + 1 },
    { maxChildren: AGENT_MACHINE_LIMITS.maxChildren + 1 },
    { maxTasksPerAgent: AGENT_MACHINE_LIMITS.maxTasksPerAgent + 1 },
    { maxDurationMs: 1, maxContinuationBytes: 1, maxReferences: 1, unknown: 1 },
  ]) {
    assert.throws(() => create(manager, 'am-bad-budget', { budgets }), (error) => codeOf(error) === 'lego.contract_violation');
  }
  create(manager, 'am-clamped', { budgets: { maxSteps: AGENT_MACHINE_LIMITS.maxSteps, maxDurationMs: AGENT_MACHINE_LIMITS.maxDurationMs, maxContinuationBytes: AGENT_MACHINE_LIMITS.maxContinuationBytes, maxReferences: AGENT_MACHINE_LIMITS.maxReferences, maxChildren: AGENT_MACHINE_LIMITS.maxChildren, maxTasksPerAgent: AGENT_MACHINE_LIMITS.maxTasksPerAgent } });
  assert.equal(manager.describe({ machineId: 'am-clamped' }).budgets.maxSteps, AGENT_MACHINE_LIMITS.maxSteps);
  assert.equal(manager.describe({ machineId: 'am-clamped' }).budgets.maxChildren, AGENT_MACHINE_LIMITS.maxChildren);
  assert.equal(manager.describe({ machineId: 'am-clamped' }).budgets.maxTasksPerAgent, AGENT_MACHINE_LIMITS.maxTasksPerAgent);
});

test('an approval-required step is fail-closed: reference mandatory, waiting bounded', () => {
  const manager = fresh();
  create(manager, 'am-approval');
  start(manager, 'am-approval');
  assert.throws(
    () => step(manager, 'am-approval', 2, 's1', 1, { outcome: 'approval-required' }),
    (error) => codeOf(error) === 'lego.contract_violation' && /approvalReference/.test(error.message),
  );
  const waiting = step(manager, 'am-approval', 2, 's1', 1, { outcome: 'approval-required' }, { approvalReference: 'approval-1' });
  assert.equal(waiting.lifecycle, 'waiting');
  assert.equal(waiting.steps[0].approvalReference, 'approval-1');
  for (const operation of ['pause', 'resume', 'start', 'prepare']) {
    assert.throws(
      () => manager[operation]({ machineId: 'am-approval', expectedVersion: 3 }),
      (error) => codeOf(error) === 'lego.interaction_mismatch',
      `${operation} from waiting must fail`,
    );
  }
  const cancelled = manager.cancel({ machineId: 'am-approval', expectedVersion: 3 });
  assert.equal(cancelled.lifecycle, 'cancelled');
});

test('a step outcome is recorded data, not an error: failure is never faked into success', () => {
  const manager = fresh();
  create(manager, 'am-outcome');
  start(manager, 'am-outcome');
  const failed = step(manager, 'am-outcome', 2, 's1', 1, { outcome: 'failed', errorReference: 'err:1' });
  assert.equal(failed.lifecycle, 'failed');
  assert.equal(failed.failure.code, 'step-failed');
  assert.equal(failed.steps[0].outcome, 'failed');
  create(manager, 'am-outcome-2');
  start(manager, 'am-outcome-2');
  const reportedCancel = step(manager, 'am-outcome-2', 2, 's1', 1, { outcome: 'cancelled' });
  assert.equal(reportedCancel.lifecycle, 'cancelled');
});

/* ------------------------------------------------------ context / session */

test('Context and Session are held as opaque references, never redefined or driven', () => {
  const manager = fresh();
  const record = create(manager, 'am-refs', {
    sessionReference: 'sess-1',
    contextReference: 'ctx-1',
    workspaceReference: 'ws-1',
  });
  assert.equal(record.sessionReference, 'sess-1');
  assert.equal(record.contextReference, 'ctx-1');
  assert.equal(record.workspaceReference, 'ws-1');
  // references are validated, never dereferenced: the machine knows nothing of their lifecycles
  const surface = JSON.stringify(Object.keys(record));
  for (const foreign of ['contextLifecycle', 'sessionLifecycle', 'workspaceLifecycle', 'memory', 'transcript']) {
    assert.ok(!surface.includes(foreign), `no ${foreign} state is absorbed`);
  }
  for (const bad of ['../escape', '/host/path', 'x'.repeat(AGENT_MACHINE_LIMITS.maxReferenceIdLength + 1), '']) {
    assert.throws(
      () => create(manager, `am-bad-ref-${bad.length}-${bad.slice(0, 1)}`, { sessionReference: bad, contextReference: bad, workspaceReference: bad }),
      (error) => codeOf(error) === 'lego.contract_violation',
      `reference ${JSON.stringify(bad)} must fail closed`,
    );
  }
  // absent references are the explicit null, never an empty string
  const absent = create(manager, 'am-no-refs');
  assert.equal(absent.sessionReference, null);
  assert.equal(absent.contextReference, null);
  assert.equal(absent.workspaceReference, null);
});

test('Memory stays out of execution bookkeeping entirely', () => {
  const manager = fresh();
  const record = create(manager, 'am-no-memory');
  const surface = JSON.stringify(record);
  for (const word of ['memoryId', 'remember', 'recall', 'forget', 'memoryScope']) {
    assert.ok(!surface.includes(word), `no ${word} in the execution foundation`);
  }
  const moduleSource = readFileSync(new URL('../src/lego/agent-machine.mjs', import.meta.url), 'utf8');
  assert.ok(!/import\s+[\s\S]*?from\s+['"]\.\/(memory|context|agent-session|workspace)\.mjs['"]/.test(moduleSource),
    'Agent Machine imports no other AI contract module: references are opaque strings, not dependencies');
});

/* ------------------------------------------------------------- isolation */

test('machine A can never return or mutate machine B', () => {
  const manager = fresh();
  create(manager, 'am-a', { metadata: { who: 'a' } });
  create(manager, 'am-b', { metadata: { who: 'b' } });
  start(manager, 'am-a');
  const a = manager.describe({ machineId: 'am-a' });
  const b = manager.describe({ machineId: 'am-b' });
  assert.equal(a.metadata.who, 'a');
  assert.equal(b.metadata.who, 'b');
  assert.equal(a.lifecycle, 'running');
  assert.equal(b.lifecycle, 'created');
  // a step reported against A with A's version cannot touch B's state
  step(manager, 'am-a', a.version, 's1', 1, { outcome: 'succeeded' });
  const bAfter = manager.describe({ machineId: 'am-b' });
  assert.equal(bAfter.lifecycle, 'created');
  assert.equal(bAfter.stepCount, 0);
  assert.equal(bAfter.version, b.version);
});

test('identities are exact: a near-identical machineId is a different, absent identity', () => {
  const manager = fresh();
  create(manager, 'am-task-1');
  assert.ok(manager.describe({ machineId: 'am-task-1' }), 'the exact identity resolves');
  assert.equal(manager.describe({ machineId: 'am-task-1' }).taskId, 'task-am-task-1');
  assert.equal(manager.describe({ machineId: 'am-task-2' }), null, 'a different identity is absent, never a fallback');
});

test('two managers over two providers are fully isolated', () => {
  const one = fresh();
  const two = fresh();
  create(one, 'shared-id', { metadata: { side: 'one' } });
  create(two, 'shared-id', { metadata: { side: 'two' } });
  assert.equal(one.describe({ machineId: 'shared-id' }).metadata.side, 'one');
  assert.equal(two.describe({ machineId: 'shared-id' }).metadata.side, 'two');
  assert.equal(one.count, 1);
  assert.equal(two.count, 1);
});

/* ----------------------------------------------------------- determinism */

test('same valid input produces a stable result; same invalid transition a stable error', () => {
  const run = () => {
    const manager = fresh();
    create(manager, 'am-deterministic');
    const started = start(manager, 'am-deterministic');
    const done = step(manager, 'am-deterministic', started.version, 's1', 1, { outcome: 'succeeded', final: true });
    return JSON.stringify({ lifecycle: done.lifecycle, version: done.version, steps: done.steps.length });
  };
  assert.equal(run(), run(), 'two identical executions book the identical state');
  const manager = fresh();
  create(manager, 'am-deterministic');
  const invalid = () => manager.pause({ machineId: 'am-deterministic', expectedVersion: 1 });
  let first = null;
  let second = null;
  try { invalid(); } catch (error) { first = codeOf(error); }
  try { invalid(); } catch (error) { second = codeOf(error); }
  assert.equal(first, 'lego.interaction_mismatch');
  assert.equal(first, second, 'the same invalid transition always produces the same stable error');
});

test('optimistic concurrency: a stale expectedVersion is a deterministic conflict', () => {
  const manager = fresh();
  create(manager, 'am-version');
  start(manager, 'am-version');
  assert.throws(
    () => manager.pause({ machineId: 'am-version', expectedVersion: 1 }),
    (error) => codeOf(error) === 'storage.conflict' && error.details.actual === 2 && error.details.expected === 1,
  );
  assert.equal(manager.describe({ machineId: 'am-version' }).lifecycle, 'running', 'the stale caller changed nothing');
  const paused = manager.pause({ machineId: 'am-version', expectedVersion: 2 });
  assert.equal(paused.lifecycle, 'paused');
});

test('duplicate idempotent operations are stable no-ops', () => {
  const manager = fresh();
  create(manager, 'am-idempotent');
  const prepared = manager.prepare({ machineId: 'am-idempotent', expectedVersion: 1 });
  assert.equal(prepared.lifecycle, 'ready');
  assert.equal(manager.prepare({ machineId: 'am-idempotent', expectedVersion: 99 }).lifecycle, 'ready',
    'prepare is idempotent on ready without touching the version');
  const started = manager.start({ machineId: 'am-idempotent', expectedVersion: prepared.version });
  assert.equal(started.lifecycle, 'running');
  assert.equal(manager.start({ machineId: 'am-idempotent', expectedVersion: 99 }).lifecycle, 'running');
  const paused = manager.pause({ machineId: 'am-idempotent', expectedVersion: started.version });
  assert.equal(manager.pause({ machineId: 'am-idempotent', expectedVersion: 99 }).lifecycle, 'paused');
  const resumed = manager.resume({ machineId: 'am-idempotent', expectedVersion: paused.version });
  assert.equal(manager.resume({ machineId: 'am-idempotent', expectedVersion: 99 }).lifecycle, 'running');
  const cancelled = manager.cancel({ machineId: 'am-idempotent', expectedVersion: resumed.version });
  assert.equal(manager.cancel({ machineId: 'am-idempotent', expectedVersion: 99 }).lifecycle, 'cancelled');
});

/* ------------------------------------------------------- validation rules */

test('identities, kinds and metadata fail closed', () => {
  const manager = fresh();
  for (const machineId of ['', 'bad id', '/host/path', 'x'.repeat(AGENT_MACHINE_LIMITS.maxIdentifierLength + 1), null]) {
    assert.throws(
      () => create(manager, machineId),
      (error) => codeOf(error) === 'lego.contract_violation',
      `machineId ${String(machineId)} must fail closed`,
    );
  }
  assert.throws(() => create(manager, 'am-kind', { executorKind: 'SHELL' }), (error) => codeOf(error) === 'lego.contract_violation');
  assert.throws(() => create(manager, 'am-meta', { metadata: { command: 'rm -rf /' } }), (error) => /forbidden/.test(error.message));
  assert.throws(() => create(manager, 'am-meta-2', { metadata: { token: 'abc' } }), (error) => /forbidden/.test(error.message));
  assert.throws(
    () => create(manager, 'am-meta-3', { metadata: { a: { b: { c: { d: { e: 'deep' } } } } } }),
    (error) => codeOf(error) === 'lego.contract_violation',
  );
});

test('the store is bounded: the machine ceiling is enforced deterministically', () => {
  const manager = fresh({ limits: { ...AGENT_MACHINE_LIMITS, maxMachines: 2 } });
  create(manager, 'am-fill-1');
  create(manager, 'am-fill-2');
  assert.throws(
    () => create(manager, 'am-fill-3'),
    (error) => codeOf(error) === 'lego.contract_violation' && /bounded machine limit/.test(error.message),
  );
  assert.equal(manager.count, 2);
});

test('an unsupported executor kind is unavailable, not silently coerced', () => {
  const manager = fresh();
  assert.throws(
    () => create(manager, 'am-external', { executorKind: 'EXTERNAL' }),
    (error) => codeOf(error) === 'lego.unavailable',
    'the default provider supports IN_MEMORY only',
  );
  const custom = new InMemoryAgentMachineProvider();
  custom.supports = (kind) => kind === 'EXTERNAL';
  const externalManager = fresh({ provider: custom });
  const external = create(externalManager, 'am-external', { executorKind: 'EXTERNAL' });
  assert.equal(external.executorKind, 'EXTERNAL', 'an explicit provider may serve a declared kind');
  assert.throws(
    () => create(externalManager, 'am-in-memory', { executorKind: 'IN_MEMORY' }),
    (error) => codeOf(error) === 'lego.unavailable',
  );
});

test('a provider missing the seam surface is refused', () => {
  assert.throws(
    () => createAgentMachineManager({ provider: { put() {}, get() {} } }),
    (error) => codeOf(error) === 'lego.contract_violation',
  );
});

test('the manifest, module and lock tell one story', () => {
  assert.deepEqual(manifest.lifecycle.states, [...AGENT_MACHINE_LIFECYCLE_STATES]);
  assert.deepEqual(manifest.lifecycle.transitions.created, [...AGENT_MACHINE_LIFECYCLE.transitions.created]);
  assert.deepEqual(manifest.lifecycle.transitions.ready, [...AGENT_MACHINE_LIFECYCLE.transitions.ready]);
  assert.deepEqual(manifest.lifecycle.transitions.waiting, [...AGENT_MACHINE_LIFECYCLE.transitions.waiting]);
  assert.deepEqual(manifest.operations.map((entry) => entry.name), [...AGENT_MACHINE_OPERATIONS]);
  assert.deepEqual(manifest.permissions, [...AGENT_MACHINE_PERMISSIONS]);
  assert.deepEqual(manifest.limits, AGENT_MACHINE_LIMITS);
  assert.equal(manifest.approvalBoundary.contract, 'ai.approval');
  assert.equal(manifest.ownership.domain, 'ai-foundation');
  const rows = lock.contracts.filter((row) => row.id === 'ai.agent-machine');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, '1.1.0');
  const exportNames = rows[0].exports['src/lego/agent-machine.mjs'];
  assert.equal(exportNames.length, 23, 'the lock row names the 23 published exports');
  assert.deepEqual([...AGENT_GRAPH_NODE_KINDS], ['sequential', 'parallel', 'branch', 'fan-out', 'fan-in', 'join', 'retry']);
  assert.deepEqual({ ...AGENT_GRAPH_LIMITS }, { maxNodes: 128, maxDependencies: 16, maxRetryAttempts: 8 });
});

/* ------------------------------------------- 1.1.0: identity separation */

test('machine, agent and task identity are three distinct bounded fields', () => {
  const manager = fresh();
  const record = manager.create({
    machineId: 'am-ident', taskId: 'task-ident', agentId: 'agent-ident',
    budgets: { ...BUDGETS }, metadata: {},
  });
  assert.equal(record.machineId, 'am-ident');
  assert.equal(record.taskId, 'task-ident');
  assert.equal(record.agentId, 'agent-ident');
  assert.equal(new Set([record.machineId, record.taskId, record.agentId]).size, 3,
    'all three identities are distinct values');
  // agentId is required: it can never silently alias another identity.
  for (const missing of [{ agentId: undefined }, { agentId: null }, { agentId: '' }, { agentId: 'bad agent' }]) {
    assert.throws(
      () => manager.create({ machineId: 'am-ident-2', taskId: 'task-ident-2', budgets: { ...BUDGETS }, ...missing }),
      (error) => codeOf(error) === 'lego.contract_violation',
      `agentId ${JSON.stringify(missing.agentId)} must fail closed`,
    );
  }
});

test('capability scope is validated against the lego-foundation capability registry', () => {
  const manager = fresh();
  const record = create(manager, 'am-scope', { capabilityScope: ['ai.context', 'ai.agent-machine'] });
  assert.deepEqual([...record.capabilityScope], ['ai.context', 'ai.agent-machine'],
    'known registry capabilities are stored as the bounded scope');
  for (const capabilityScope of [
    ['ai.definitely-not-published'],
    ['workflow.crud', 'workflow.crud'],
    Array.from({ length: 33 }, (_, i) => `cap-${i}`),
    'ai.context',
    [42],
  ]) {
    assert.throws(
      () => create(manager, `am-scope-bad-${JSON.stringify(capabilityScope).length}`, { capabilityScope }),
      (error) => codeOf(error) === 'lego.contract_violation',
      `${JSON.stringify(capabilityScope)} must fail closed`,
    );
  }
  // absent scope is the explicit empty list, never a wildcard
  assert.deepEqual([...create(manager, 'am-scope-default').capabilityScope], []);
});

/* ------------------------------------------------ 1.1.0: prepare / ready */

test('prepare moves created to ready and keeps optimistic concurrency', () => {
  const manager = fresh();
  create(manager, 'am-ready');
  // a version the machine is not at is a deterministic conflict, never a silent transition
  assert.throws(
    () => manager.prepare({ machineId: 'am-ready', expectedVersion: 7 }),
    (error) => codeOf(error) === 'storage.conflict' && error.details.actual === 1 && error.details.expected === 7,
    'a stale prepare is a deterministic conflict, not a silent double-transition',
  );
  assert.equal(manager.describe({ machineId: 'am-ready' }).lifecycle, 'created', 'the stale caller changed nothing');
  const prepared = manager.prepare({ machineId: 'am-ready', expectedVersion: 1 });
  assert.equal(prepared.lifecycle, 'ready');
  assert.equal(prepared.version, 2);
  assert.equal(manager.prepare({ machineId: 'am-ready', expectedVersion: 1 }).lifecycle, 'ready',
    'prepare on ready is the idempotent no-op, consistent with start/pause/resume/cancel');
});

test('prepare is refused outside created: running, paused, waiting and terminal cannot prepare', () => {
  const manager = fresh();
  create(manager, 'am-ready-bad');
  start(manager, 'am-ready-bad');
  assert.throws(
    () => manager.prepare({ machineId: 'am-ready-bad', expectedVersion: 2 }),
    (error) => codeOf(error) === 'lego.interaction_mismatch',
    'prepare from running fails closed',
  );
  manager.pause({ machineId: 'am-ready-bad', expectedVersion: 2 });
  assert.throws(
    () => manager.prepare({ machineId: 'am-ready-bad', expectedVersion: 3 }),
    (error) => codeOf(error) === 'lego.interaction_mismatch',
    'prepare from paused fails closed',
  );
  create(manager, 'am-ready-terminal');
  manager.cancel({ machineId: 'am-ready-terminal', expectedVersion: 1 });
  assert.throws(
    () => manager.prepare({ machineId: 'am-ready-terminal', expectedVersion: 2 }),
    (error) => codeOf(error) === 'lego.interaction_mismatch',
    'prepare from a terminal state fails closed',
  );
});

test('start accepts both created and ready, preserving the 1.0.0 direct-start flow', () => {
  const manager = fresh();
  create(manager, 'am-direct');
  assert.equal(start(manager, 'am-direct').lifecycle, 'running',
    'created -> running stays legal: every 1.0.0 flow is unchanged');
  create(manager, 'am-via-ready');
  manager.prepare({ machineId: 'am-via-ready', expectedVersion: 1 });
  const started = manager.start({ machineId: 'am-via-ready', expectedVersion: 2 });
  assert.equal(started.lifecycle, 'running');
  assert.ok(started.startedAt, 'starting records the bounded startedAt timestamp');
});

test('a ready machine holds its state: no step, valid cancel, no pause', () => {
  const manager = fresh();
  create(manager, 'am-ready-hold');
  const prepared = manager.prepare({ machineId: 'am-ready-hold', expectedVersion: 1 });
  assert.throws(
    () => step(manager, 'am-ready-hold', prepared.version, 's1', 1, { outcome: 'succeeded' }),
    (error) => codeOf(error) === 'lego.interaction_mismatch',
    'a step before start fails closed',
  );
  assert.throws(
    () => manager.pause({ machineId: 'am-ready-hold', expectedVersion: prepared.version }),
    (error) => codeOf(error) === 'lego.interaction_mismatch',
    'pause from ready fails closed (running is the only pausable state)',
  );
  const cancelled = manager.cancel({ machineId: 'am-ready-hold', expectedVersion: prepared.version });
  assert.equal(cancelled.lifecycle, 'cancelled');
});

/* ------------------------------------- 1.1.0: operation/permission surface */

test('every operation maps to exactly one canonical permission and unknown operations fail', () => {
  assert.deepEqual({ ...AGENT_MACHINE_OPERATION_PERMISSIONS }, {
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
  for (const operation of AGENT_MACHINE_OPERATIONS) {
    const permission = agentMachineOperationPermission(operation);
    assert.ok(AGENT_MACHINE_PERMISSIONS.includes(permission), `${operation} maps into the published permission set`);
  }
  for (const operation of ['agentMachine.close', 'agentMachine.execute', 'execute', '', null]) {
    assert.throws(
      () => agentMachineOperationPermission(operation),
      (error) => codeOf(error) === 'lego.contract_violation',
      `${String(operation)} must fail closed`,
    );
  }
});

test('permission assertions are fail-closed: held, missing and malformed all behave deterministically', () => {
  assert.equal(assertAgentMachinePermission('agentMachine.step', ['ai:agent:invoke']), true);
  assert.equal(assertAgentMachinePermission('agentMachine.delegate', ['ai:agent:delegate', 'ai:agent:read']), true);
  assert.throws(
    () => assertAgentMachinePermission('agentMachine.delegate', ['ai:agent:invoke']),
    (error) => codeOf(error) === 'lego.contract_violation' && error.details.required === 'ai:agent:delegate',
    'delegate without ai:agent:delegate is refused',
  );
  assert.throws(
    () => assertAgentMachinePermission('agentMachine.create', []),
    (error) => codeOf(error) === 'lego.contract_violation',
    'an empty held list grants nothing',
  );
  assert.throws(
    () => assertAgentMachinePermission('agentMachine.step', 'ai:agent:invoke'),
    (error) => codeOf(error) === 'lego.contract_violation',
    'a malformed held list is refused',
  );
  assert.throws(
    () => assertAgentMachinePermission('agentMachine.close', ['ai:agent:invoke']),
    (error) => codeOf(error) === 'lego.contract_violation' && /unknown/.test(error.message),
    'close is not an operation of this contract',
  );
});

/* --------------------------------------------- 1.1.0: bounded delegation */

test('delegate records one bounded, narrowed edge with clamped budget and deadline', () => {
  const manager = fresh();
  create(manager, 'am-del', {
    capabilityScope: ['ai.context', 'ai.skill'],
    budgets: { ...BUDGETS, maxSteps: 10, maxChildren: 4 },
  });
  manager.start({ machineId: 'am-del', expectedVersion: 1 });
  const delegated = manager.delegate({
    machineId: 'am-del',
    expectedVersion: 2,
    delegationId: 'del-1',
    childAgentId: 'child-researcher',
    grants: ['ai.context'],
    budget: { maxSteps: 100 },
    deadline: '2026-09-23T00:00:00.000Z',
  });
  assert.equal(delegated.delegations.length, 1);
  const edge = delegated.delegations[0];
  assert.equal(edge.delegationId, 'del-1');
  assert.equal(edge.childAgentId, 'child-researcher');
  assert.deepEqual([...edge.grants], ['ai.context'], 'grants are the explicit narrowed subset');
  assert.equal(edge.budget.maxSteps, 10, 'child budget is clamped to the parent ceiling, never widened');
  assert.ok(Date.parse(edge.deadline) <= Date.parse('2026-09-23T00:00:00.000Z') + 1,
    'a deadline inside the parent window is honoured');
  assert.equal(delegated.version, 3, 'a delegation edge is a versioned mutation');
});

test('delegate refuses grants outside the capability scope: no inheritance, no escalation', () => {
  const manager = fresh();
  create(manager, 'am-del-narrow', {
    capabilityScope: ['ai.context'],
    budgets: { ...BUDGETS, maxChildren: 4 },
  });
  manager.start({ machineId: 'am-del-narrow', expectedVersion: 1 });
  for (const grants of [
    ['ai.memory'],
    ['ai.context', 'ai.model-gateway'],
    [],
    ['not a capability'],
    ['ai.context', 'ai.context'],
  ]) {
    assert.throws(
      () => manager.delegate({
        machineId: 'am-del-narrow', expectedVersion: 2,
        delegationId: `del-bad-${JSON.stringify(grants).length}`, childAgentId: 'child-1', grants,
      }),
      (error) => codeOf(error) === 'lego.contract_violation',
      `grants ${JSON.stringify(grants)} must fail closed`,
    );
  }
  assert.equal(manager.describe({ machineId: 'am-del-narrow' }).delegations.length, 0, 'no edge was recorded');
});

test('maxChildren bounds delegation edges and is reported as a budget failure', () => {
  const manager = fresh();
  create(manager, 'am-del-cap', {
    capabilityScope: ['ai.context'],
    budgets: { ...BUDGETS, maxChildren: 2 },
  });
  manager.prepare({ machineId: 'am-del-cap', expectedVersion: 1 });
  manager.delegate({
    machineId: 'am-del-cap', expectedVersion: 2,
    delegationId: 'del-a', childAgentId: 'child-a', grants: ['ai.context'],
  });
  manager.delegate({
    machineId: 'am-del-cap', expectedVersion: 3,
    delegationId: 'del-b', childAgentId: 'child-b', grants: ['ai.context'],
  });
  assert.throws(
    () => manager.delegate({
      machineId: 'am-del-cap', expectedVersion: 4,
      delegationId: 'del-c', childAgentId: 'child-c', grants: ['ai.context'],
    }),
    (error) => codeOf(error) === 'lego.contract_violation'
      && error.details.budget === 'maxChildren'
      && error.details.limit === 2,
    'the third edge exceeds the declared maxChildren budget',
  );
  assert.equal(manager.describe({ machineId: 'am-del-cap' }).delegations.length, 2);
  // undeclared maxChildren is 0: delegation is opt-in, never a silent default.
  create(manager, 'am-del-nodefault', { capabilityScope: ['ai.context'] });
  manager.prepare({ machineId: 'am-del-nodefault', expectedVersion: 1 });
  assert.throws(
    () => manager.delegate({
      machineId: 'am-del-nodefault', expectedVersion: 2,
      delegationId: 'del-x', childAgentId: 'child-x', grants: ['ai.context'],
    }),
    (error) => codeOf(error) === 'lego.contract_violation' && error.details.budget === 'maxChildren',
    'without a declared maxChildren budget no edge may be booked',
  );
});

test('delegation lifecycle, deadline clamp and duplicate edges fail closed', () => {
  const manager = fresh();
  create(manager, 'am-del-life', {
    capabilityScope: ['ai.context'],
    budgets: { ...BUDGETS, maxChildren: 4 },
  });
  // not ready yet: created cannot delegate
  assert.throws(
    () => manager.delegate({
      machineId: 'am-del-life', expectedVersion: 1,
      delegationId: 'del-early', childAgentId: 'child-1', grants: ['ai.context'],
    }),
    (error) => codeOf(error) === 'lego.interaction_mismatch',
    'created cannot delegate',
  );
  manager.prepare({ machineId: 'am-del-life', expectedVersion: 1 });
  manager.start({ machineId: 'am-del-life', expectedVersion: 2 });
  const first = manager.delegate({
    machineId: 'am-del-life', expectedVersion: 3,
    delegationId: 'del-ok', childAgentId: 'child-1', grants: ['ai.context'],
    deadline: '2027-01-01T00:00:00.000Z',
  });
  const parentDeadline = Date.parse(first.startedAt) + first.budgets.maxDurationMs;
  assert.ok(Date.parse(first.delegations[0].deadline) <= parentDeadline,
    'a far deadline is clamped to the parent deadline');
  assert.throws(
    () => manager.delegate({
      machineId: 'am-del-life', expectedVersion: 4,
      delegationId: 'del-ok', childAgentId: 'child-2', grants: ['ai.context'],
    }),
    (error) => codeOf(error) === 'storage.conflict',
    'a duplicate delegationId is a conflict',
  );
  assert.throws(
    () => manager.delegate({
      machineId: 'am-del-life', expectedVersion: 4,
      delegationId: 'del-self', childAgentId: 'agent-am-del-life', grants: ['ai.context'],
    }),
    (error) => codeOf(error) === 'lego.contract_violation' && /own agent/.test(error.message),
    'a machine never delegates to its own agent identity',
  );
  assert.throws(
    () => manager.delegate({
      machineId: 'am-del-life', expectedVersion: 4,
      delegationId: 'del-bad-deadline', childAgentId: 'child-3', grants: ['ai.context'],
      deadline: 'never',
    }),
    (error) => codeOf(error) === 'lego.contract_violation' && /deadline/.test(error.message),
    'a malformed deadline fails closed',
  );
  // a waiting machine cannot book new edges
  step(manager, 'am-del-life', 4, 's1', 1, { outcome: 'approval-required' }, { approvalReference: 'approval-1' });
  assert.equal(manager.describe({ machineId: 'am-del-life' }).lifecycle, 'waiting');
  assert.throws(
    () => manager.delegate({
      machineId: 'am-del-life', expectedVersion: 5,
      delegationId: 'del-late', childAgentId: 'child-4', grants: ['ai.context'],
    }),
    (error) => codeOf(error) === 'lego.interaction_mismatch',
    'waiting cannot delegate',
  );
});

test('maxTasksPerAgent bounds the machines one agent identity may hold', () => {
  const manager = fresh();
  create(manager, 'am-agent-1', { agentId: 'agent-solo', budgets: { ...BUDGETS, maxTasksPerAgent: 1 } });
  assert.throws(
    () => create(manager, 'am-agent-2', { agentId: 'agent-solo', budgets: { ...BUDGETS, maxTasksPerAgent: 1 } }),
    (error) => codeOf(error) === 'lego.contract_violation'
      && error.details.budget === 'maxTasksPerAgent'
      && error.details.limit === 1,
    'a single-task agent never holds two machines',
  );
  // a different agent identity is unaffected
  create(manager, 'am-agent-3', { agentId: 'agent-other', budgets: { ...BUDGETS, maxTasksPerAgent: 1 } });
  assert.equal(manager.count, 2);
});

/* ------------------------------------------------ 1.1.0: graph validation */

test('a bounded sequential graph validates with one entry and deterministic counts', () => {
  const result = validateAgentGraph({
    nodes: [
      { id: 'start', kind: 'sequential', dependsOn: [] },
      { id: 'middle', kind: 'sequential', dependsOn: ['start'] },
      { id: 'end', kind: 'sequential', dependsOn: ['middle'] },
    ],
  });
  assert.equal(result.entry, 'start');
  assert.equal(result.nodeCount, 3);
  assert.equal(result.edgeCount, 2);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.nodes));
});

test('parallel and branch graphs validate as bounded representation, never execution', () => {
  const result = validateAgentGraph({
    nodes: [
      { id: 'entry', kind: 'sequential', dependsOn: [] },
      { id: 'split', kind: 'parallel', dependsOn: ['entry'] },
      { id: 'left', kind: 'branch', condition: 'flag.on', dependsOn: ['split'] },
      { id: 'right', kind: 'branch', condition: 'flag.off', dependsOn: ['split'] },
      { id: 'exit', kind: 'join', dependsOn: ['left', 'right'] },
    ],
  });
  assert.equal(result.entry, 'entry');
  assert.equal(result.nodeCount, 5);
  // condition is branch-only
  assert.throws(
    () => validateAgentGraph({
      nodes: [
        { id: 'a', kind: 'sequential', dependsOn: [] },
        { id: 'b', kind: 'sequential', condition: 'nope', dependsOn: ['a'] },
      ],
    }),
    (error) => codeOf(error) === 'lego.contract_violation' && /condition on non-branch/.test(error.message),
  );
});

test('fan-out, fan-in and join enforce their degree floors and the fan ceiling', () => {
  const ok = validateAgentGraph({
    nodes: [
      { id: 'source', kind: 'fan-out', dependsOn: [] },
      { id: 'w1', kind: 'sequential', dependsOn: ['source'] },
      { id: 'w2', kind: 'sequential', dependsOn: ['source'] },
      { id: 'collector', kind: 'fan-in', dependsOn: ['w1', 'w2'] },
      { id: 'joined', kind: 'join', dependsOn: ['collector', 'w2'] },
    ],
  });
  assert.equal(ok.entry, 'source');
  assert.equal(ok.nodeCount, 5);
  // a fan-out with a single dependent is not a fan-out
  assert.throws(
    () => validateAgentGraph({
      nodes: [
        { id: 'src', kind: 'fan-out', dependsOn: [] },
        { id: 'only', kind: 'sequential', dependsOn: ['src'] },
      ],
    }),
    (error) => codeOf(error) === 'lego.contract_violation' && /fan-out/.test(error.message),
  );
  // a fan-in with a single dependency is not a fan-in
  assert.throws(
    () => validateAgentGraph({
      nodes: [
        { id: 'a', kind: 'sequential', dependsOn: [] },
        { id: 'b', kind: 'sequential', dependsOn: ['a'] },
        { id: 'c', kind: 'fan-in', dependsOn: ['b'] },
      ],
    }),
    (error) => codeOf(error) === 'lego.contract_violation' && /fan-in/.test(error.message),
  );
  // out-degree ceiling: 17 dependents exceed maxDependencies
  const wide = Array.from({ length: 18 }, (_, i) => ({ id: `n${i}`, kind: 'sequential', dependsOn: i === 0 ? [] : ['n0'] }));
  assert.throws(
    () => validateAgentGraph({ nodes: wide }),
    (error) => codeOf(error) === 'lego.contract_violation' && /fans out/.test(error.message),
    'unbounded fan-out is rejected',
  );
});

test('retry nodes carry a bounded attempts ceiling of 1..8', () => {
  const ok = validateAgentGraph({
    nodes: [
      { id: 'a', kind: 'sequential', dependsOn: [] },
      { id: 'r', kind: 'retry', retry: { attempts: 8 }, dependsOn: ['a'] },
      { id: 'z', kind: 'sequential', dependsOn: ['r'] },
    ],
  });
  assert.equal(ok.entry, 'a');
  for (const attempts of [0, 9, -1, 2.5, 'three']) {
    assert.throws(
      () => validateAgentGraph({
        nodes: [
          { id: 'a', kind: 'sequential', dependsOn: [] },
          { id: 'r', kind: 'retry', retry: { attempts }, dependsOn: ['a'] },
        ],
      }),
      (error) => codeOf(error) === 'lego.contract_violation' && /retry\.attempts/.test(error.message),
      `attempts ${String(attempts)} must fail closed`,
    );
  }
  assert.throws(
    () => validateAgentGraph({
      nodes: [
        { id: 'a', kind: 'sequential', dependsOn: [] },
        { id: 'r', kind: 'retry', dependsOn: ['a'] },
      ],
    }),
    (error) => codeOf(error) === 'lego.contract_violation' && /retry/.test(error.message),
    'a retry node without a bounded retry block is invalid',
  );
  assert.throws(
    () => validateAgentGraph({
      nodes: [
        { id: 'a', kind: 'sequential', dependsOn: [] },
        { id: 'b', kind: 'sequential', retry: { attempts: 2 }, dependsOn: ['a'] },
      ],
    }),
    (error) => codeOf(error) === 'lego.contract_violation' && /non-retry kind/.test(error.message),
    'retry declarations live only on retry nodes',
  );
});

test('cyclic, self-referential and dangling graphs are rejected', () => {
  assert.throws(
    () => validateAgentGraph({
      nodes: [
        { id: 'a', kind: 'sequential', dependsOn: ['b'] },
        { id: 'b', kind: 'sequential', dependsOn: ['a'] },
      ],
    }),
    (error) => codeOf(error) === 'lego.contract_violation' && /cycle/.test(error.message),
    'a cycle is rejected',
  );
  assert.throws(
    () => validateAgentGraph({
      nodes: [{ id: 'a', kind: 'sequential', dependsOn: ['a'] }],
    }),
    (error) => codeOf(error) === 'lego.contract_violation' && /depends on itself/.test(error.message),
    'a self-dependency is rejected before cycle search',
  );
  assert.throws(
    () => validateAgentGraph({
      nodes: [
        { id: 'a', kind: 'sequential', dependsOn: [] },
        { id: 'b', kind: 'sequential', dependsOn: ['ghost'] },
      ],
    }),
    (error) => codeOf(error) === 'lego.contract_violation' && /unknown node/.test(error.message),
    'a dangling reference is rejected',
  );
});

test('entry count, node ceiling, dependency ceiling and unknown kinds fail closed', () => {
  // two entries
  assert.throws(
    () => validateAgentGraph({
      nodes: [
        { id: 'e1', kind: 'sequential', dependsOn: [] },
        { id: 'e2', kind: 'sequential', dependsOn: [] },
      ],
    }),
    (error) => codeOf(error) === 'lego.contract_violation' && /exactly one entry/.test(error.message),
    'a second entry node is rejected',
  );
  // empty graph
  assert.throws(
    () => validateAgentGraph({ nodes: [] }),
    (error) => codeOf(error) === 'lego.contract_violation' && /at least one/.test(error.message),
  );
  // node ceiling
  const tooMany = Array.from({ length: 129 }, (_, i) => ({ id: `n${i}`, kind: 'sequential', dependsOn: i === 0 ? [] : [`n${i - 1}`] }));
  assert.throws(
    () => validateAgentGraph({ nodes: tooMany }),
    (error) => codeOf(error) === 'lego.contract_violation' && /node ceiling/.test(error.message),
    'more than 128 nodes is unbounded expansion',
  );
  // dependency ceiling on one node
  const deepDeps = {
    nodes: [
      { id: 'hub', kind: 'sequential', dependsOn: Array.from({ length: 17 }, (_, i) => `h${i}`) },
    ],
  };
  assert.throws(
    () => validateAgentGraph({ nodes: [{ id: 'root', kind: 'sequential', dependsOn: [] }, { id: 'hub', kind: 'parallel', dependsOn: ['root', ...Array.from({ length: 17 }, (_, i) => `x${i}`)] }] }),
    (error) => codeOf(error) === 'lego.contract_violation' && (/dependency ceiling/.test(error.message) || /unknown node/.test(error.message)),
    'more than 16 dependencies on one node is rejected structurally',
  );
  // unknown kind
  assert.throws(
    () => validateAgentGraph({
      nodes: [
        { id: 'a', kind: 'sequential', dependsOn: [] },
        { id: 'b', kind: 'while-loop', dependsOn: ['a'] },
      ],
    }),
    (error) => codeOf(error) === 'lego.contract_violation' && /kind must be one of/.test(error.message),
  );
  // unknown top-level field
  assert.throws(
    () => validateAgentGraph({ nodes: [{ id: 'a', kind: 'sequential', dependsOn: [] }], scheduler: 'unbounded' }),
    (error) => codeOf(error) === 'lego.contract_violation' && /non-public field/.test(error.message),
  );
});

test('graphs never carry permission, grant or inheritance fields: escalation is rejected', () => {
  for (const key of ['permissions', 'grants', 'inherit', 'authority', 'capabilityScope']) {
    assert.throws(
      () => validateAgentGraph({
        nodes: [
          { id: 'a', kind: 'sequential', dependsOn: [] },
          { id: 'b', kind: 'sequential', dependsOn: ['a'], [key]: ['ai:agent:invoke'] },
        ],
      }),
      (error) => codeOf(error) === 'lego.contract_violation'
        && (/authority field/.test(error.message) || /non-public field/.test(error.message)),
      `node field '${key}' must be rejected`,
    );
  }
  assert.throws(
    () => validateAgentGraph({ nodes: [{ id: 'a', kind: 'sequential', inherits: ['parent'] }] }),
    (error) => codeOf(error) === 'lego.contract_violation',
    'top-level authority fields are refused too',
  );
});

/* --------------------------------------------- 1.1.0: event derivation */

test('events derive deterministically for the created, started and completed path', () => {
  const manager = createAgentMachineManager({ now: () => '2026-09-22T00:00:00.000Z' });
  const record = create(manager, 'am-events', { sessionReference: 'sess-7' });
  const started = start(manager, 'am-events');
  const done = step(manager, 'am-events', started.version, 's1', 1, { outcome: 'succeeded', final: true });
  const events = deriveAgentMachineEvents(done);
  assert.deepEqual(events.map((event) => event.type), ['agent.created', 'agent.started', 'agent.completed']);
  const again = deriveAgentMachineEvents(done);
  assert.deepEqual(events.map((event) => JSON.stringify(event)), again.map((event) => JSON.stringify(event)),
    'derivation is deterministic for the same record');
  assert.equal(events[0].occurredAt, record.createdAt);
  assert.equal(events[1].occurredAt, done.startedAt);
  assert.equal(events[2].occurredAt, done.updatedAt);
});

test('events cover delegated, failed and cancelled outcomes with the six published types only', () => {
  const manager = fresh();
  create(manager, 'am-ev-del', {
    capabilityScope: ['ai.context'],
    budgets: { ...BUDGETS, maxChildren: 2 },
    sessionReference: 'sess-9',
  });
  manager.start({ machineId: 'am-ev-del', expectedVersion: 1 });
  manager.delegate({
    machineId: 'am-ev-del', expectedVersion: 2,
    delegationId: 'del-1', childAgentId: 'child-1', grants: ['ai.context'],
  });
  const withEdge = manager.describe({ machineId: 'am-ev-del' });
  const delegatedTypes = deriveAgentMachineEvents(withEdge).map((event) => event.type);
  assert.deepEqual(delegatedTypes, ['agent.created', 'agent.started', 'agent.delegated']);
  const edgeEvent = deriveAgentMachineEvents(withEdge)[2];
  assert.equal(edgeEvent.childAgentId, 'child-1');
  assert.deepEqual([...edgeEvent.grants], ['ai.context']);

  const failed = step(manager, 'am-ev-del', 3, 's1', 1, { outcome: 'failed', errorReference: 'err:9' });
  assert.deepEqual(deriveAgentMachineEvents(failed).map((event) => event.type),
    ['agent.created', 'agent.started', 'agent.delegated', 'agent.failed']);
  const failureEvent = deriveAgentMachineEvents(failed)[3];
  assert.deepEqual({ ...failureEvent.failure }, { code: 'step-failed', stepId: 's1', errorReference: 'err:9' });

  create(manager, 'am-ev-cancel');
  const cancelled = manager.cancel({ machineId: 'am-ev-cancel', expectedVersion: 1 });
  assert.deepEqual(deriveAgentMachineEvents(cancelled).map((event) => event.type), ['agent.created', 'agent.cancelled']);
  for (const type of ['agent.created', 'agent.started', 'agent.delegated', 'agent.completed', 'agent.failed', 'agent.cancelled']) {
    assert.ok(AGENT_MACHINE_EVENT_TYPES.includes(type), `${type} is published`);
  }
  assert.equal(AGENT_MACHINE_EVENT_TYPES.length, 6, 'exactly six derived event types');
});

test('events are session-scoped, correlation-aware and sanitized: no payload, no secret, no reasoning', () => {
  const manager = fresh();
  const record = create(manager, 'am-ev-safe', {
    sessionReference: 'sess-safe',
    metadata: { label: 'internal-note' },
  });
  const events = deriveAgentMachineEvents(record);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.sessionId, 'sess-safe', 'the session id is the opaque sessionReference');
  assert.equal(event.correlationId, 'am-ev-safe', 'correlation is the machine identity');
  assert.equal(event.causationId, null, 'causation stays null until a causation contract publishes it');
  assert.equal(event.contract, 'ai.agent-machine');
  assert.equal(event.contractVersion, '1.1.0');
  const serialized = JSON.stringify(event);
  for (const forbidden of ['internal-note', 'metadata', 'continuation', 'steps', 'reasoning', 'secret', 'token', 'command']) {
    assert.equal(serialized.includes(forbidden), false, `'${forbidden}' never enters an event`);
  }
  // a record with no session yields an explicit null session id, never a fabricated one
  const unsessoned = deriveAgentMachineEvents(create(manager, 'am-ev-nosess'));
  assert.equal(unsessoned[0].sessionId, null);
  // waiting/paused/ready produce only the base events — no invented types
  start(manager, 'am-ev-safe');
  const running = manager.describe({ machineId: 'am-ev-safe' });
  const paused = manager.pause({ machineId: 'am-ev-safe', expectedVersion: running.version });
  assert.deepEqual(deriveAgentMachineEvents(paused).map((entry) => entry.type), ['agent.created', 'agent.started']);
  const ready = create(manager, 'am-ev-ready');
  assert.deepEqual(deriveAgentMachineEvents(ready).map((entry) => entry.type), ['agent.created']);
  assert.throws(
    () => deriveAgentMachineEvents({ machineId: 'am', taskId: 't', agentId: 42, lifecycle: 'created', createdAt: '2026-09-22T00:00:00.000Z' }),
    (error) => codeOf(error) === 'lego.contract_violation',
    'a malformed record fails closed instead of producing loose events',
  );
});

/* ------------------------------------------- 1.1.0: acceptance sweep */

test('duplicate identities are conflicts: the store never overwrites a machine', () => {
  const manager = fresh();
  const first = create(manager, 'am-dup', { metadata: { generation: 1 } });
  assert.equal(first.version, 1);
  assert.throws(
    () => create(manager, 'am-dup', { metadata: { generation: 2 } }),
    (error) => codeOf(error) === 'storage.conflict' && error.details.machineId === 'am-dup',
    'the second create with the same machineId is a conflict',
  );
  assert.equal(manager.describe({ machineId: 'am-dup' }).metadata.generation, 1,
    'the original record is untouched: no silent overwrite');
  assert.equal(manager.count, 1);
});

test('graph validation never mutates the input graph', () => {
  const graph = {
    nodes: [
      { id: 'a', kind: 'sequential', dependsOn: [] },
      { id: 'b', kind: 'parallel', dependsOn: ['a'] },
      { id: 'c', kind: 'sequential', dependsOn: ['a'] },
      { id: 'd', kind: 'join', dependsOn: ['b', 'c'] },
    ],
  };
  const before = JSON.stringify(graph);
  const result = validateAgentGraph(graph);
  assert.equal(JSON.stringify(graph), before, 'the caller’s graph is byte-identical after validation (Kahn runs on a copy)');
  assert.equal(result.entry, 'a');
  assert.throws(() => { result.nodes[0].kind = 'mutated'; }, TypeError, 'the summary nodes are frozen');
});

test('the published surface carries no close, send, stream, artifact or execute operation anywhere', () => {
  const forbiddenOps = ['close', 'send', 'stream', 'artifact', 'execute'];
  for (const name of forbiddenOps) {
    assert.equal(AGENT_MACHINE_OPERATIONS.includes(`agentMachine.${name}`), false,
      `operations never publish agentMachine.${name}`);
    assert.equal(Object.keys(AGENT_MACHINE_OPERATION_PERMISSIONS).some((op) => op.endsWith(`.${name}`)), false,
      `the permission map never maps agentMachine.${name}`);
    assert.equal(manifest.operations.some((entry) => entry.name === `agentMachine.${name}`), false,
      `the manifest never publishes ${name}`);
    const lockRow = lock.contracts.find((row) => row.id === 'ai.agent-machine');
    assert.equal(lockRow.operations.includes(`agentMachine.${name}`), false,
      `the lock row never publishes ${name}`);
    const capability = registry.byId.get('ai-foundation').capabilities.find((entry) => entry.id === 'ai.agent-machine');
    assert.equal(capability.operations.some((entry) => entry.name === name), false,
      `the capability registry never publishes ${name}`);
  }
  assert.equal(AGENT_MACHINE_OPERATIONS.includes('agentMachine.prepare'), true, 'prepare is canonical in 1.1.0');
  assert.equal(AGENT_MACHINE_OPERATIONS.includes('agentMachine.delegate'), true, 'delegate is canonical in 1.1.0');
});

test('a delegation edge is exact bounded metadata: no child runtime handle, no execution surface', () => {
  const manager = fresh();
  create(manager, 'am-del-shape', {
    capabilityScope: ['ai.context'],
    budgets: { ...BUDGETS, maxChildren: 4 },
  });
  manager.start({ machineId: 'am-del-shape', expectedVersion: 1 });
  const after = manager.delegate({
    machineId: 'am-del-shape', expectedVersion: 2,
    delegationId: 'del-shape', childAgentId: 'child-shape', grants: ['ai.context'],
    budget: { maxSteps: 2 },
  });
  const edge = after.delegations[0];
  assert.deepEqual(Object.keys(edge).sort(), ['budget', 'childAgentId', 'createdAt', 'deadline', 'delegationId', 'grants'],
    'an edge exposes exactly its six bounded fields');
  const serialized = JSON.stringify(after);
  for (const forbidden of ['spawn', 'shell', 'command', 'credential', 'endpoint', 'provider', 'execute']) {
    assert.equal(serialized.includes(forbidden), false, `'${forbidden}' never appears in a delegated record`);
  }
  // the provider stored the parent record only — no child record was created
  assert.equal(manager.count, 1);
  assert.equal(manager.describe({ machineId: 'am-del-shape' }).delegations.length, 1);
});

test('the full bounded story runs deterministically: ready, start, delegate, step, complete', () => {
  const run = () => {
    const manager = fresh();
    create(manager, 'am-story', {
      capabilityScope: ['ai.context'],
      budgets: { ...BUDGETS, maxChildren: 2 },
      sessionReference: 'sess-story',
    });
    const prepared = manager.prepare({ machineId: 'am-story', expectedVersion: 1 });
    const started = manager.start({ machineId: 'am-story', expectedVersion: prepared.version });
    const delegated = manager.delegate({
      machineId: 'am-story', expectedVersion: started.version,
      delegationId: 'del-story', childAgentId: 'child-story', grants: ['ai.context'],
    });
    const done = step(manager, 'am-story', delegated.version, 's1', 1, { outcome: 'succeeded', final: true });
    const events = deriveAgentMachineEvents(done).map((event) => event.type);
    return JSON.stringify({
      lifecycle: done.lifecycle,
      version: done.version,
      stepCount: done.stepCount,
      delegations: done.delegations.length,
      events,
      sessionId: done.sessionReference,
    });
  };
  const first = run();
  assert.equal(first, run(), 'two identical bounded stories book the identical state and events');
  const parsed = JSON.parse(first);
  assert.equal(parsed.lifecycle, 'completed');
  assert.equal(parsed.events.join(','), 'agent.created,agent.started,agent.delegated,agent.completed');
  assert.equal(parsed.sessionId, 'sess-story');
  assert.equal(parsed.delegations, 1);
  assert.equal(parsed.stepCount, 1);
});
