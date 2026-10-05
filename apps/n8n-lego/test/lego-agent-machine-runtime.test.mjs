/**
 * P2.17 — Agent Machine Runtime Foundation tests.
 * §19 matrix: contract ops delegation (9 ops, never close), graph patterns,
 * bounded concurrency, cancellation + cascade, deadline / budget-exhausted,
 * idempotency, backpressure, failure isolation, the 6 universal agent events,
 * and a structured audit trail — against a local in-memory provider only.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import {
  createAgentMachineManager,
  AgentMachineError,
  AGENT_MACHINE_EVENT_TYPES,
  validateAgentGraph,
} from '../src/lego/agent-machine.mjs';
import {
  createAgentMachineRuntime,
  RUNTIME_LIMITS,
  AgentMachineRuntimeError,
  evaluateRunCondition,
} from '../src/lego/agent-machine-runtime.mjs';

const MANIFEST = JSON.parse(readFileSync(
  new URL('../src/lego/manifest/agent-machine.json', import.meta.url),
  'utf8',
));
const AI_PACK = JSON.parse(readFileSync(
  new URL('../src/lego/manifest/ai-lego-set.json', import.meta.url),
  'utf8',
));

let seq = 0;
function machineId(label = 'runtime') {
  seq += 1;
  return `${label}-${seq}`;
}

function makeRuntime(options = {}) {
  return createAgentMachineRuntime({
    clock: options.clock ?? {},
    limits: options.limits ?? {},
    onNode: options.onNode ?? null,
    onAudit: options.onAudit ?? null,
    onEvent: options.onEvent ?? null,
    manager: options.manager ?? createAgentMachineManager(),
    evaluateCondition: options.evaluateCondition ?? evaluateRunCondition,
  });
}

function created(runtime, extra = {}) {
  const id = extra.machineId ?? machineId();
  const machine = runtime.create({
    machineId: id,
    taskId: extra.taskId ?? `task-${id}`.slice(0, 64),
    agentId: extra.agentId ?? 'agent-1',
    sessionReference: extra.sessionReference ?? 'session-runtime-1',
    budgets: { maxSteps: 32, maxDurationMs: 300000, maxReferences: 8 },
    ...extra.input,
  });
  return machine.machineId;
}

function seqGraph(ids) {
  return {
    nodes: ids.map((id, index) => ({
      id,
      kind: index === 0 ? 'sequential' : 'sequential',
      dependsOn: index === 0 ? [] : [ids[index - 1]],
    })),
  };
}

/* ---------------------------------------------- 1. contract-op delegation */

describe('runtime delegates every contract op and never invents close', () => {
  test('the 9 lifecycle ops are reachable through the runtime surface', () => {
    const runtime = makeRuntime();
    for (const op of ['create', 'describe', 'prepare', 'start', 'step', 'pause', 'resume', 'delegate', 'cancel']) {
      assert.equal(typeof runtime[op], 'function', `runtime exposes ${op}`);
    }
    assert.equal(runtime.close, undefined, 'the runtime has no close');
    assert.equal(Object.isFrozen(runtime), true, 'the runtime surface is frozen');
    assert.equal(runtime.manager.close, undefined, 'the delegated manager has no close either');
  });

  test('create → prepare → start → step → pause → resume → completed through the runtime', () => {
    const runtime = makeRuntime();
    const id = machineId();
    const machine = runtime.create({
      machineId: id,
      taskId: 'task-ops',
      agentId: 'agent-1',
      sessionReference: 'session-ops',
      budgets: { maxSteps: 32, maxDurationMs: 300000, maxReferences: 8 },
    });
    assert.equal(machine.lifecycle, 'created');
    assert.equal(runtime.describe({ machineId: id }).machineId, id);
    runtime.prepare({ machineId: id, expectedVersion: machine.version });
    let rec = runtime.describe({ machineId: id });
    assert.equal(rec.lifecycle, 'ready');
    runtime.start({ machineId: id, expectedVersion: rec.version });
    rec = runtime.describe({ machineId: id });
    assert.equal(rec.lifecycle, 'running');
    runtime.pause({ machineId: id, expectedVersion: rec.version });
    assert.equal(runtime.describe({ machineId: id }).lifecycle, 'paused');
    rec = runtime.describe({ machineId: id });
    runtime.resume({ machineId: id, expectedVersion: rec.version });
    rec = runtime.describe({ machineId: id });
    runtime.step({
      machineId: id,
      expectedVersion: rec.version,
      sequence: rec.stepCount + 1,
      stepId: 'done-1',
      result: { outcome: 'succeeded', final: true },
    });
    assert.equal(runtime.describe({ machineId: id }).lifecycle, 'completed');
  });

  test('delegate through the runtime records an edge with narrowed grants', () => {
    const runtime = makeRuntime();
    const id = created(runtime, { input: { capabilityScope: ['ai.agent-delegation'], budgets: { maxSteps: 32, maxDurationMs: 300000, maxReferences: 8, maxChildren: 1 } } });
    runtime.start({ machineId: id, expectedVersion: runtime.describe({ machineId: id }).version });
    runtime.delegate({
      machineId: id,
      expectedVersion: runtime.describe({ machineId: id }).version,
      delegationId: 'delegation-runtime-1',
      childAgentId: 'child-runtime-1',
      grants: ['ai.agent-delegation'],
    });
    const rec = runtime.describe({ machineId: id });
    assert.equal(rec.delegations.length, 1);
    assert.deepEqual([...rec.delegations[0].grants], ['ai.agent-delegation']);
    const delegated = runtime.listEvents({ machineId: id }).map((event) => event.type);
    assert.ok(delegated.includes('agent.delegated'), 'delegation event emitted');
  });

  test('the runtime and its manager keep the full frozen 1.1.0 surface', () => {
    const runtime = makeRuntime();
    assert.equal(runtime.manager.contract, '1.1.0');
    assert.equal(runtime.manager.limits.maxChildren, 16, 'bounded delegation edges');
    assert.equal(runtime.manager.limits.maxTasksPerAgent, 64, 'bounded tasks per agent');
    assert.equal(runtime.manager.limits.maxCapabilityScope, 32, 'bounded capability list');
    assert.equal(runtime.manager.provider.size, 0);
    assert.equal(MANIFEST.version, '1.1.0');
    const agentMachineLego = AI_PACK.lego.find((entry) => entry.id === 'agent-machine');
    assert.equal(agentMachineLego.status, 'contract-only', 'the AI set keeps agent-machine contract-only');
    assert.equal(validateAgentGraph({
      nodes: [{ id: 'n1', kind: 'sequential', dependsOn: [] }],
    }) !== undefined, true, 'contract validator still answers graphs');
    assert.equal(Object.isFrozen(RUNTIME_LIMITS), true);
    assert.equal(typeof AgentMachineRuntimeError, 'function');
  });
});

/* ------------------------------------------------------- 2. graph patterns */

describe('graph execution patterns', () => {
  test('sequential graph runs in dependency order to completion', async () => {
    const order = [];
    const runtime = makeRuntime({
      onNode: async ({ node }) => {
        order.push(node.id);
        return { outcome: 'succeeded' };
      },
    });
    const id = created(runtime);
    const result = await runtime.run(id, seqGraph(['n1', 'n2', 'n3']));
    assert.equal(result.status, 'completed');
    assert.deepEqual(order, ['n1', 'n2', 'n3']);
    const rec = runtime.describe({ machineId: id });
    assert.equal(rec.lifecycle, 'completed');
    assert.equal(rec.stepCount, 3);
    assert.equal(rec.steps.at(-1).final, true);
  });

  test('parallel wave overlaps inside the slot ceiling', async () => {
    let active = 0;
    let peak = 0;
    const runtime = makeRuntime({
      limits: { maxConcurrency: 4 },
      onNode: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => { setTimeout(resolve, 25); });
        active -= 1;
        return { outcome: 'succeeded' };
      },
    });
    const id = created(runtime);
    const result = await runtime.run(id, {
      nodes: [
        { id: 'root', kind: 'sequential', dependsOn: [] },
        { id: 'p1', kind: 'parallel', dependsOn: ['root'] },
        { id: 'p2', kind: 'parallel', dependsOn: ['root'] },
        { id: 'p3', kind: 'parallel', dependsOn: ['root'] },
      ],
    });
    assert.equal(result.status, 'completed');
    assert.ok(peak >= 2, `handlers overlapped (peak=${peak})`);
    assert.ok(peak <= 4, 'peak stayed inside maxConcurrency');
  });

  test('branch condition true runs the path; false prunes it fail-closed', async () => {
    const ran = [];
    const runtime = makeRuntime({
      onNode: async ({ node }) => {
        ran.push(node.id);
        return { outcome: 'succeeded' };
      },
    });
    const open = created(runtime);
    const openResult = await runtime.run(open, {
      nodes: [
        { id: 'start', kind: 'sequential', dependsOn: [] },
        { id: 'gate', kind: 'branch', dependsOn: ['start'], condition: 'ready' },
        { id: 'after', kind: 'sequential', dependsOn: ['gate'] },
      ],
    }, { facts: { ready: true } });
    assert.equal(openResult.status, 'completed');
    assert.deepEqual(ran, ['start', 'gate', 'after']);

    ran.length = 0;
    const closed = created(runtime);
    const closedResult = await runtime.run(closed, {
      nodes: [
        { id: 'start', kind: 'sequential', dependsOn: [] },
        { id: 'gate', kind: 'branch', dependsOn: ['start'], condition: 'ready' },
        { id: 'after', kind: 'sequential', dependsOn: ['gate'] },
        { id: 'bypass', kind: 'sequential', dependsOn: ['start'] },
      ],
    }, { facts: {} });
    assert.equal(closedResult.status, 'completed');
    assert.ok(!ran.includes('gate'), 'gated branch did not run');
    assert.ok(!ran.includes('after'), 'gated path pruned');
    assert.ok(ran.includes('bypass'), 'the ungated path still ran');
    const rec = runtime.describe({ machineId: closed });
    const outcomes = rec.steps.map((step) => [step.inputReference, step.outcome]);
    assert.ok(outcomes.some(([node, outcome]) => node === 'bypass' && outcome === 'succeeded'));
  });

  test('fan-out bounds and fan-in/join degree are enforced end-to-end', async () => {
    const runtime = makeRuntime({ onNode: async () => ({ outcome: 'succeeded' }) });
    const id = created(runtime);
    const result = await runtime.run(id, {
      nodes: [
        { id: 'seed', kind: 'fan-out', dependsOn: [] },
        { id: 'w1', kind: 'parallel', dependsOn: ['seed'] },
        { id: 'w2', kind: 'parallel', dependsOn: ['seed'] },
        { id: 'w3', kind: 'parallel', dependsOn: ['seed'] },
        { id: 'merge', kind: 'join', dependsOn: ['w1', 'w2', 'w3'] },
        { id: 'tail', kind: 'fan-in', dependsOn: ['merge', 'w3'] },
      ],
    });
    assert.equal(result.status, 'completed');
    const rec = runtime.describe({ machineId: id });
    assert.equal(rec.stepCount, 6);
    assert.equal(rec.lifecycle, 'completed');
  });

  test('join settles after skipped inputs too — a pruned branch cannot deadlock the graph', async () => {
    const runtime = makeRuntime({
      onNode: async ({ node }) => {
        if (node.id === 'gate') return { outcome: 'succeeded' };
        return { outcome: 'succeeded' };
      },
    });
    const id = created(runtime);
    const result = await runtime.run(id, {
      nodes: [
        { id: 'seed', kind: 'sequential', dependsOn: [] },
        { id: 'gate', kind: 'branch', dependsOn: ['seed'], condition: 'never' },
        { id: 'gated', kind: 'sequential', dependsOn: ['gate'] },
        { id: 'direct', kind: 'sequential', dependsOn: ['seed'] },
        { id: 'join', kind: 'join', dependsOn: ['gated', 'direct'] },
      ],
    }, { facts: {} });
    assert.equal(result.status, 'completed');
    const rec = runtime.describe({ machineId: id });
    assert.ok(!rec.steps.some((step) => step.inputReference === 'gated'), 'pruned node never stepped');
    assert.ok(rec.steps.some((step) => step.inputReference === 'join' && step.outcome === 'succeeded'));
  });

  test('retry node: bounded attempts recover, exhausted attempts fail the machine', async () => {
    let attempts = 0;
    const flaky = makeRuntime({
      onNode: async ({ node, attempt }) => {
        if (node.kind === 'retry') {
          attempts = attempt;
          if (attempt < 3) throw new Error('transient');
        }
        return { outcome: 'succeeded' };
      },
    });
    const ok = created(flaky);
    const okResult = await flaky.run(ok, {
      nodes: [
        { id: 'first', kind: 'sequential', dependsOn: [] },
        { id: 'flaky', kind: 'retry', dependsOn: ['first'], retry: { attempts: 3 } },
      ],
    });
    assert.equal(okResult.status, 'completed');
    assert.equal(attempts, 3, 'third attempt succeeded');

    const failRuntime = makeRuntime({
      onNode: async () => { throw new Error('always fails'); },
    });
    const doomed = created(failRuntime);
    const failResult = await failRuntime.run(doomed, {
      nodes: [{ id: 'doomed', kind: 'retry', dependsOn: [], retry: { attempts: 2 } }],
    });
    assert.equal(failResult.status, 'failed');
    assert.equal(failResult.failure.code, 'step-failed');
    assert.equal(failRuntime.describe({ machineId: doomed }).lifecycle, 'failed');
  });

  test('approval-required stops the run waiting — cancel-only, never a fabricated resume', async () => {
    const runtime = makeRuntime({
      onNode: async ({ node }) => (node.id === 'risky'
        ? { outcome: 'approval-required', approvalReference: 'approval-node-1' }
        : { outcome: 'succeeded' }),
    });
    const id = created(runtime);
    const result = await runtime.run(id, {
      nodes: [
        { id: 'prep', kind: 'sequential', dependsOn: [] },
        { id: 'risky', kind: 'sequential', dependsOn: ['prep'] },
      ],
    });
    assert.equal(result.status, 'waiting');
    const rec = runtime.describe({ machineId: id });
    assert.equal(rec.lifecycle, 'waiting');
    assert.throws(
      () => runtime.resume({ machineId: id, expectedVersion: rec.version }),
      /approval|waiting/i,
      'waiting stays fail-closed for resume',
    );
    const cancelled = runtime.cancel({ machineId: id, expectedVersion: rec.version });
    assert.equal(cancelled.lifecycle, 'cancelled');
  });

  test('cyclic and invalid graphs are refused before any execution', async () => {
    const runtime = makeRuntime();
    const id = created(runtime);
    await assert.rejects(
      runtime.run(id, {
        nodes: [
          { id: 'a', kind: 'sequential', dependsOn: ['b'] },
          { id: 'b', kind: 'sequential', dependsOn: ['a'] },
        ],
      }),
      (error) => error instanceof AgentMachineError && /cycle/i.test(error.message),
      'the contract validator rejects cycles',
    );
    assert.equal(runtime.describe({ machineId: id }).lifecycle, 'created', 'no partial execution');
  });
});

/* --------------------------------------- 3. bounded concurrency + cascade */

describe('bounded concurrency, cancellation and deadlines', () => {
  test('maxConcurrency is a hard ceiling over ready work', async () => {
    let active = 0;
    let peak = 0;
    const runtime = makeRuntime({
      limits: { maxConcurrency: 2 },
      onNode: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => { setTimeout(resolve, 15); });
        active -= 1;
        return { outcome: 'succeeded' };
      },
    });
    const id = created(runtime);
    const result = await runtime.run(id, {
      nodes: [
        { id: 'seed', kind: 'sequential', dependsOn: [] },
        { id: 's1', kind: 'parallel', dependsOn: ['seed'] },
        { id: 's2', kind: 'parallel', dependsOn: ['seed'] },
        { id: 's3', kind: 'parallel', dependsOn: ['seed'] },
        { id: 's4', kind: 'parallel', dependsOn: ['seed'] },
        { id: 's5', kind: 'parallel', dependsOn: ['seed'] },
        { id: 's6', kind: 'parallel', dependsOn: ['seed'] },
      ],
    });
    assert.equal(result.status, 'completed');
    assert.ok(peak <= 2, `peak concurrency ${peak} stayed within the ceiling`);
    assert.equal(peak, 2, 'the ceiling was actually exercised');
  });

  test('cancel during execution stops queued work, is idempotent, cascades to state', async () => {
    const executed = [];
    let runtime;
    runtime = makeRuntime({
      onNode: async ({ node }) => {
        executed.push(node.id);
        if (node.id === 'slow') {
          await new Promise((resolve) => { setTimeout(resolve, 30); });
        }
        return { outcome: 'succeeded' };
      },
    });
    const id = created(runtime);
    const running = runtime.run(id, {
      nodes: [
        { id: 'slow', kind: 'sequential', dependsOn: [] },
        { id: 'next', kind: 'sequential', dependsOn: ['slow'] },
        { id: 'tail', kind: 'sequential', dependsOn: ['next'] },
      ],
    });
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    const rec = runtime.describe({ machineId: id });
    const first = runtime.cancel({ machineId: id, expectedVersion: rec.version });
    assert.equal(first.lifecycle, 'cancelled');
    const second = runtime.cancel({ machineId: id, expectedVersion: first.version });
    assert.equal(second.lifecycle, 'cancelled', 'duplicate cancel is idempotent');
    const result = await running;
    assert.equal(result.status, 'cancelled');
    await new Promise((resolve) => { setTimeout(resolve, 5); });
    assert.ok(!executed.includes('tail'), 'queued work never ran after cancel');
    const finalRec = runtime.describe({ machineId: id });
    assert.equal(finalRec.lifecycle, 'cancelled');
    assert.throws(
      () => runtime.start({ machineId: id, expectedVersion: finalRec.version }),
      /terminal/i,
      'cancelled is terminal',
    );
  });

  test('duration deadline becomes budget-exhausted(maxDurationMs), not a hang', async () => {
    const runtime = makeRuntime({
      onNode: async () => {
        await new Promise((resolve) => { setTimeout(resolve, 60); });
        return { outcome: 'succeeded' };
      },
    });
    const id = created(runtime, {
      input: { budgets: { maxDurationMs: 20, maxSteps: 32, maxReferences: 8 } },
    });
    const result = await runtime.run(id, seqGraph(['slow1', 'slow2']));
    assert.equal(result.status, 'failed');
    assert.equal(result.failure.code, 'budget-exhausted');
    assert.equal(result.failure.budget, 'maxDurationMs');
    const rec = runtime.describe({ machineId: id });
    assert.equal(rec.lifecycle, 'failed');
    assert.equal(rec.failure.code, 'budget-exhausted');
  });

  test('step ceiling becomes budget-exhausted(maxSteps) as a terminal state', async () => {
    const runtime = makeRuntime({ onNode: async () => ({ outcome: 'succeeded' }) });
    const id = created(runtime, { input: { budgets: { maxSteps: 1, maxDurationMs: 300000, maxReferences: 8 } } });
    const result = await runtime.run(id, seqGraph(['one', 'two']));
    assert.equal(result.status, 'failed');
    assert.equal(result.failure.code, 'budget-exhausted');
    assert.equal(result.failure.budget, 'maxSteps');
    const rec = runtime.describe({ machineId: id });
    assert.equal(rec.lifecycle, 'failed');
    assert.throws(
      () => runtime.step({
        machineId: id,
        expectedVersion: rec.version,
        sequence: rec.stepCount + 1,
        stepId: 'post-budget',
        result: { outcome: 'succeeded', final: true },
      }),
      /budget|failed|running/i,
      'budget-exhausted is stable and terminal: further steps are refused',
    );
  });
});

/* ------------------------------------------ 4. idempotency + backpressure */

describe('idempotency and backpressure', () => {
  test('duplicate submissions with the same dedupe key return the first result', () => {
    const runtime = makeRuntime();
    const id = machineId();
    const createInput = {
      machineId: id,
      taskId: 'task-idem',
      agentId: 'agent-1',
      sessionReference: 'session-idem',
      budgets: { maxSteps: 32, maxDurationMs: 300000, maxReferences: 8 },
      dedupeKey: 'create-1',
    };
    const first = runtime.create(createInput);
    const second = runtime.create(createInput);
    assert.equal(second.machineId, first.machineId);
    assert.equal(second.version, first.version, 'duplicate create did not re-execute');
    assert.equal(runtime.manager.count, 1, 'exactly one machine exists');

    let rec = runtime.describe({ machineId: id });
    rec = runtime.start({ machineId: id, expectedVersion: rec.version, dedupeKey: 'start-1' });
    const again = runtime.start({ machineId: id, expectedVersion: 1, dedupeKey: 'start-1' });
    assert.equal(again.version, rec.version, 'stale duplicate suppressed by dedupe key');

    rec = runtime.describe({ machineId: id });
    const stepInput = {
      machineId: id,
      expectedVersion: rec.version,
      sequence: rec.stepCount + 1,
      stepId: 'idem-step',
      result: { outcome: 'succeeded', final: true },
      dedupeKey: 'step-1',
    };
    const stepA = runtime.step(stepInput);
    const stepB = runtime.step(stepInput);
    assert.equal(stepA.stepCount, stepB.stepCount, 'duplicate step returned cached result');
    assert.equal(runtime.describe({ machineId: id }).stepCount, 1, 'the step executed once');
  });

  test('without a dedupe key, contract stale-version conflicts still surface', () => {
    const runtime = makeRuntime();
    const id = created(runtime);
    const rec = runtime.start({ machineId: id, expectedVersion: runtime.describe({ machineId: id }).version });
    assert.equal(rec.lifecycle, 'running');
    assert.throws(
      () => runtime.step({
        machineId: id,
        expectedVersion: 1,
        sequence: 1,
        stepId: 'stale-1',
        result: { outcome: 'succeeded', final: false },
      }),
      (error) => error instanceof AgentMachineError && /stale|version/i.test(error.message),
      'real conflicts are never papered over',
    );
  });

  test('idempotent lifecycle ops stay idempotent through the runtime wrapper', () => {
    const runtime = makeRuntime();
    const id = created(runtime);
    let rec = runtime.start({ machineId: id, expectedVersion: runtime.describe({ machineId: id }).version });
    const startedTwice = runtime.start({ machineId: id, expectedVersion: 1 });
    assert.equal(startedTwice.lifecycle, 'running', 'start of a running machine is a no-op');
    runtime.pause({ machineId: id, expectedVersion: runtime.describe({ machineId: id }).version });
    const pausedTwice = runtime.pause({ machineId: id, expectedVersion: 1 });
    assert.equal(pausedTwice.lifecycle, 'paused');
    runtime.resume({ machineId: id, expectedVersion: runtime.describe({ machineId: id }).version });
    const resumedTwice = runtime.resume({ machineId: id, expectedVersion: 1 });
    assert.equal(resumedTwice.lifecycle, 'running');
    rec = runtime.describe({ machineId: id });
    runtime.cancel({ machineId: id, expectedVersion: rec.version });
    const cancelledTwice = runtime.cancel({ machineId: id, expectedVersion: 99 });
    assert.equal(cancelledTwice.lifecycle, 'cancelled');
    assert.equal(runtime.manager.count, 1, 'still exactly one machine — no corruption');
  });

  test('backpressure: an oversized graph is rejected at admission', async () => {
    const runtime = makeRuntime({ limits: { maxQueued: 2 } });
    const id = created(runtime);
    await assert.rejects(
      runtime.run(id, seqGraph(['a', 'b', 'c'])),
      (error) => error instanceof AgentMachineRuntimeError && error.code === 'lego.backpressure',
      'oversized run refused before execution',
    );
    assert.equal(runtime.describe({ machineId: id }).lifecycle, 'created', 'machine untouched');
    assert.throws(
      () => createAgentMachineRuntime({ limits: { maxQueued: 0 } }),
      (error) => error instanceof AgentMachineRuntimeError && error.code === 'lego.contract_violation',
      'limits cannot be widened past sanity',
    );
  });
});

/* ------------------------- 5. failure isolation + events + audit (§19 tail) */

describe('failure isolation, universal events and audit', () => {
  test('a failed machine never disturbs a neighbour running on the same runtime', async () => {
    const runtime = makeRuntime({
      onNode: async ({ machineId, node }) => {
        if (machineId.startsWith('victim') && node.id === 'boom') throw new Error('boom');
        return { outcome: 'succeeded' };
      },
    });
    const victim = created(runtime, { machineId: machineId('victim') });
    const healthy = created(runtime, { machineId: machineId('healthy') });
    const [failedRun, okRun] = await Promise.all([
      runtime.run(victim, seqGraph(['ok1', 'boom', 'after'])),
      runtime.run(healthy, seqGraph(['h1', 'h2'])),
    ]);
    assert.equal(failedRun.status, 'failed');
    assert.equal(okRun.status, 'completed');
    assert.equal(runtime.describe({ machineId: healthy }).lifecycle, 'completed');
    assert.equal(runtime.describe({ machineId: victim }).lifecycle, 'failed');
  });

  test('all 6 universal agent events are emitted across runtime operations', () => {
    const runtime = makeRuntime();
    const done = created(runtime, { machineId: machineId('ev-done'), input: { capabilityScope: ['ai.agent-delegation'], budgets: { maxSteps: 32, maxDurationMs: 300000, maxReferences: 8, maxChildren: 1 } } });
    let rec = runtime.describe({ machineId: done });
    rec = runtime.start({ machineId: done, expectedVersion: rec.version });
    runtime.delegate({
      machineId: done,
      expectedVersion: rec.version,
      delegationId: 'delegation-ev',
      childAgentId: 'child-ev',
      grants: ['ai.agent-delegation'],
    });
    rec = runtime.describe({ machineId: done });
    runtime.step({
      machineId: done,
      expectedVersion: rec.version,
      sequence: rec.stepCount + 1,
      stepId: 'fin',
      result: { outcome: 'succeeded', final: true },
    });

    const failing = created(runtime, { machineId: machineId('ev-fail') });
    let frec = runtime.start({ machineId: failing, expectedVersion: runtime.describe({ machineId: failing }).version });
    runtime.step({
      machineId: failing,
      expectedVersion: frec.version,
      sequence: 1,
      stepId: 'bad',
      result: { outcome: 'failed', final: false, errorReference: 'error/x' },
    });

    const cancelling = created(runtime, { machineId: machineId('ev-cancel') });
    const crec = runtime.start({ machineId: cancelling, expectedVersion: runtime.describe({ machineId: cancelling }).version });
    runtime.cancel({ machineId: cancelling, expectedVersion: crec.version });

    const types = new Set(runtime.listEvents().map((event) => event.type));
    for (const expected of AGENT_MACHINE_EVENT_TYPES) {
      assert.ok(types.has(expected), `emitted ${expected}`);
    }
    assert.equal(types.size, 6, 'exactly the published vocabulary');
    for (const event of runtime.listEvents()) {
      assert.equal(event.contract, 'ai.agent-machine');
      assert.equal(typeof event.correlationId, 'string');
      assert.equal(event.machineId, event.correlationId, 'correlation equals the machine');
      assert.ok(event.sessionId === null || typeof event.sessionId === 'string');
    }
    const auditOps = new Set(runtime.listAudit().map((entry) => entry.op));
    for (const op of ['create', 'start', 'step', 'cancel']) {
      assert.ok(auditOps.has(op), `audit records ${op}`);
    }
    assert.ok(runtime.stats().events > 0 && runtime.stats().audit > 0);
  });

  test('events never leak across sessions and never duplicate per machine', async () => {
    const runtime = makeRuntime({ onNode: async () => ({ outcome: 'succeeded' }) });
    const alpha = created(runtime, { sessionReference: 'session-alpha', machineId: machineId('alpha') });
    const beta = created(runtime, { sessionReference: 'session-beta', machineId: machineId('beta') });
    await runtime.run(alpha, seqGraph(['a1']));
    await runtime.run(beta, seqGraph(['b1']));
    const alphaEvents = runtime.listEvents({ machineId: alpha });
    const betaEvents = runtime.listEvents({ machineId: beta });
    assert.ok(alphaEvents.every((event) => event.sessionId === 'session-alpha'));
    assert.ok(betaEvents.every((event) => event.sessionId === 'session-beta'));
    assert.ok(alphaEvents.every((event) => event.machineId === alpha));
    const alphaTypes = alphaEvents.map((event) => event.type);
    assert.equal(new Set(alphaTypes).size, alphaTypes.length, 'no duplicate derived events');
    assert.deepEqual(alphaTypes, ['agent.created', 'agent.started', 'agent.completed']);
  });

  test('audit is structured, bounded, and carries no hidden reasoning', async () => {
    const seen = [];
    const runtime = makeRuntime({
      limits: { maxAuditEntries: 8 },
      onAudit: (entry) => { seen.push(entry); },
      onNode: async () => ({ outcome: 'succeeded' }),
    });
    for (let index = 0; index < 12; index += 1) {
      const id = created(runtime);
      await runtime.run(id, seqGraph(['only']));
    }
    const trail = runtime.listAudit();
    assert.ok(trail.length <= 8, `audit bounded to 8 entries (got ${trail.length})`);
    assert.equal(seen.length > 0, true, 'streaming audit sink received entries');
    for (const entry of trail) {
      assert.equal(typeof entry.op, 'string');
      assert.equal(typeof entry.at, 'string');
      assert.ok(!('reasoning' in entry) && !('thought' in entry) && !('rationale' in entry),
        'audit never records hidden reasoning');
    }
    const stats = runtime.stats();
    assert.ok(stats.audit <= 8);
    assert.equal(stats.activeRuns, 0, 'no run leaked');
  });

  test('events stay bounded with an honest drop counter', () => {
    const runtime = makeRuntime({ limits: { maxEvents: 4 } });
    for (let index = 0; index < 6; index += 1) {
      created(runtime);
    }
    const stats = runtime.stats();
    assert.equal(stats.events, 4, 'event buffer bounded');
    assert.equal(stats.eventsDropped, 2, 'drops are counted, never hidden');
  });

  test('pause during a run holds the schedule until resume', async () => {
    const order = [];
    const runtime = makeRuntime({
      onNode: async ({ node }) => {
        order.push(node.id);
        if (node.id === 'first') {
          await new Promise((resolve) => { setTimeout(resolve, 40); });
        }
        return { outcome: 'succeeded' };
      },
    });
    const id = created(runtime);
    const runPromise = runtime.run(id, seqGraph(['first', 'second', 'third']));
    await new Promise((resolve) => { setTimeout(resolve, 8); });
    const rec = runtime.describe({ machineId: id });
    if (rec.lifecycle === 'running') {
      runtime.pause({ machineId: id, expectedVersion: rec.version });
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      const paused = runtime.describe({ machineId: id });
      assert.equal(paused.lifecycle, 'paused', 'the run holds while paused');
      runtime.resume({ machineId: id, expectedVersion: paused.version });
    }
    const result = await runPromise;
    assert.equal(result.status, 'completed');
    assert.deepEqual(order, ['first', 'second', 'third']);
  });
});
