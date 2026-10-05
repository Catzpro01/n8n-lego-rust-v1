/**
 * P2.17 — Agent Machine Runtime Foundation (contract 1.1.0).
 *
 * A bounded, local execution runtime over the frozen Agent Machine contract:
 * it delegates every lifecycle operation to the contract manager (the 9 ops —
 * the runtime itself can never invent `close`), validates graphs through the
 * contract's `validateAgentGraph`, and adds only execution mechanics:
 *
 *   - bounded concurrency (level scheduling with a hard slot ceiling),
 *   - retry with a hard attempt ceiling,
 *   - deadline enforcement (the contract's `budget-exhausted` terminal state),
 *   - idempotent duplicate submissions (dedupe-key operation log, bounded),
 *   - backpressure (graph admission rejects oversized runs),
 *   - failure isolation (a failed node fails THIS machine only),
 *   - cancellation propagation (idempotent cancel stops queued work),
 *   - Universal Agent Event emission via the contract's `deriveAgentMachineEvents`,
 *   - a structured audit trail that records operations — never chain-of-thought.
 *
 * Deliberately outside this module (fail-closed, no code paths): production
 * external-agent runtime, shell or filesystem executors, credential
 * management, model inference, MCP, the universal bridge, provider
 * implementations, and any unbounded subprocess. Node handlers are injected
 * by the embedder; without one, every node succeeds as a bounded no-op.
 */

import {
  createAgentMachineManager,
  validateAgentGraph,
  deriveAgentMachineEvents,
  AgentMachineError,
} from './agent-machine.mjs';

/** Runtime bounds. Values may only TIGHTEN these ceilings, never raise them. */
export const RUNTIME_LIMITS = Object.freeze({
  maxConcurrency: 8,
  maxQueued: 128,
  maxEvents: 2048,
  maxAuditEntries: 512,
  maxOperationLog: 1024,
  maxRetryAttempts: 8,
  maxPausePollMs: 50,
});

export const RUNTIME_AUDIT_OPS = Object.freeze([
  'create', 'prepare', 'start', 'step', 'pause', 'resume', 'delegate', 'cancel',
  'run.start', 'run.node', 'run.retry', 'run.end', 'step.skipped',
  'budget.exhausted', 'duplicate.suppressed',
]);

export class AgentMachineRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AgentMachineRuntimeError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/**
 * Fail-closed default condition evaluator. A condition is a fact key; it
 * passes only when the run facts hold that key with a truthy marker. Unknown
 * conditions are false — a branch never opens on speculation.
 */
export function evaluateRunCondition(condition, facts) {
  if (typeof condition !== 'string' || condition === '') return false;
  if (!Object.hasOwn(facts, condition)) return false;
  const value = facts[condition];
  return value === true || value === 'true';
}

function assertIntCeiling(value, ceiling, name) {
  if (!Number.isInteger(value) || value < 1 || value > ceiling) {
    throw new AgentMachineRuntimeError(
      'lego.contract_violation',
      `runtime ${name} must be an integer in [1, ${ceiling}]`,
      { name, ceiling },
    );
  }
  return value;
}

function stripRuntimeKeys(input) {
  if (input === null || typeof input !== 'object') return input;
  const { dedupeKey, ...rest } = input;
  return rest;
}

function isTerminalLifecycle(lifecycle) {
  return lifecycle === 'completed' || lifecycle === 'failed' || lifecycle === 'cancelled';
}

function retryAttemptsOf(node) {
  const retry = node.retry;
  if (retry === undefined || retry === null) return 1;
  if (typeof retry === 'number') return retry;
  if (typeof retry === 'object') {
    const declared = retry.maxAttempts ?? retry.attempts ?? 1;
    if (typeof declared === 'number') return declared;
  }
  return 1;
}

/**
 * Create a bounded agent-machine runtime. Every option is injectable so the
 * runtime itself stays a pure contract-conformance layer: clock, manager,
 * node handler, condition evaluator, event sink and audit sink.
 */
export function createAgentMachineRuntime(options = {}) {
  const {
    manager = createAgentMachineManager(),
    clock = {},
    limits = {},
    onNode = null,
    evaluateCondition = evaluateRunCondition,
    onAudit = null,
    onEvent = null,
  } = options;

  const now = typeof clock.now === 'function' ? clock.now : () => Date.now();
  const sleep = typeof clock.sleep === 'function'
    ? clock.sleep
    : (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  const cfg = Object.freeze({
    maxConcurrency: assertIntCeiling(limits.maxConcurrency ?? RUNTIME_LIMITS.maxConcurrency, RUNTIME_LIMITS.maxConcurrency, 'maxConcurrency'),
    maxQueued: assertIntCeiling(limits.maxQueued ?? RUNTIME_LIMITS.maxQueued, RUNTIME_LIMITS.maxQueued, 'maxQueued'),
    maxEvents: assertIntCeiling(limits.maxEvents ?? RUNTIME_LIMITS.maxEvents, RUNTIME_LIMITS.maxEvents, 'maxEvents'),
    maxAuditEntries: assertIntCeiling(limits.maxAuditEntries ?? RUNTIME_LIMITS.maxAuditEntries, RUNTIME_LIMITS.maxAuditEntries, 'maxAuditEntries'),
    maxOperationLog: assertIntCeiling(limits.maxOperationLog ?? RUNTIME_LIMITS.maxOperationLog, RUNTIME_LIMITS.maxOperationLog, 'maxOperationLog'),
    maxRetryAttempts: assertIntCeiling(limits.maxRetryAttempts ?? RUNTIME_LIMITS.maxRetryAttempts, RUNTIME_LIMITS.maxRetryAttempts, 'maxRetryAttempts'),
    maxPausePollMs: assertIntCeiling(limits.maxPausePollMs ?? RUNTIME_LIMITS.maxPausePollMs, RUNTIME_LIMITS.maxPausePollMs, 'maxPausePollMs'),
  });

  const events = [];
  let eventsDropped = 0;
  const auditTrail = [];
  const operationLog = new Map();
  const emittedCursors = new Map();
  const executions = new Map();

  function pushEvent(event) {
    if (events.length >= cfg.maxEvents) {
      eventsDropped += 1;
      return;
    }
    events.push(Object.freeze(event));
    if (typeof onEvent === 'function') onEvent(event);
  }

  function recordAudit(entry) {
    const row = Object.freeze({
      at: new Date(now()).toISOString(),
      ...entry,
    });
    if (auditTrail.length >= cfg.maxAuditEntries) auditTrail.shift();
    auditTrail.push(row);
    if (typeof onAudit === 'function') onAudit(row);
  }

  /** Emit only contract events that were not emitted for this machine yet. */
  function emitFor(machine) {
    const cursor = emittedCursors.get(machine.machineId) ?? 0;
    const derived = deriveAgentMachineEvents(machine);
    for (let index = cursor; index < derived.length; index += 1) pushEvent(derived[index]);
    emittedCursors.set(machine.machineId, derived.length);
  }

  /**
   * Bounded idempotency: the same operation submitted again with the same
   * dedupe key returns the first result without re-executing it. Without a
   * dedupe key, contract semantics apply unchanged (stale versions conflict).
   */
  function logged(op, target, dedupeKey, invoke) {
    if (dedupeKey === undefined || dedupeKey === null || dedupeKey === '') {
      return invoke();
    }
    const key = `${op}|${target ?? ''}|${dedupeKey}`;
    if (operationLog.has(key)) {
      recordAudit({ op: 'duplicate.suppressed', targetOp: op, machineId: target });
      return operationLog.get(key);
    }
    const result = invoke();
    if (operationLog.size >= cfg.maxOperationLog) {
      operationLog.delete(operationLog.keys().next().value);
    }
    operationLog.set(key, result);
    return result;
  }

  function describeMachine(machineId) {
    return manager.describe({ machineId });
  }

  /* ------------------------------------------------- contract-op delegation */

  function create(input) {
    const payload = stripRuntimeKeys(input);
    return logged('create', payload?.machineId, input?.dedupeKey, () => {
      const machine = manager.create(payload);
      emitFor(machine);
      recordAudit({
        op: 'create',
        machineId: machine.machineId,
        sessionId: machine.sessionReference,
        lifecycle: machine.lifecycle,
      });
      return machine;
    });
  }

  function passthrough(opName, input) {
    const payload = stripRuntimeKeys(input);
    return logged(opName, payload?.machineId, input?.dedupeKey, () => {
      const machine = manager[opName](payload);
      emitFor(machine);
      recordAudit({
        op: opName,
        machineId: machine.machineId,
        lifecycle: machine.lifecycle,
      });
      return machine;
    });
  }

  function describe(input) {
    return manager.describe(stripRuntimeKeys(input));
  }

  function list() {
    return manager.provider.list();
  }

  /* ------------------------------------------------------- run-loop helpers */

  function tripDurationBudget(machineId) {
    // The manager records the terminal budget-exhausted failure itself when a
    // step observes an exceeded duration budget; a probe step makes it fire.
    const rec = describeMachine(machineId);
    if (rec.lifecycle !== 'running') return describeMachine(machineId);
    try {
      manager.step({
        machineId,
        expectedVersion: rec.version,
        sequence: rec.stepCount + 1,
        stepId: `budget-probe-${rec.stepCount + 1}`,
        result: { outcome: 'succeeded', final: false },
      });
    } catch (error) {
      recordAudit({
        op: 'budget.exhausted',
        machineId,
        budget: error instanceof AgentMachineError ? (error.details?.budget ?? 'maxDurationMs') : 'maxDurationMs',
      });
    }
    const after = describeMachine(machineId);
    emitFor(after);
    return after;
  }

  async function waitWhilePaused(machineId, exec) {
    for (;;) {
      if (exec.cancelled) return describeMachine(machineId);
      const rec = describeMachine(machineId);
      if (rec.lifecycle !== 'paused') return rec;
      const startedAt = Date.parse(rec.startedAt ?? rec.createdAt);
      if (Number.isFinite(startedAt) && now() - startedAt >= rec.budgets.maxDurationMs) {
        const resumed = manager.resume({ machineId, expectedVersion: rec.version });
        emitFor(resumed);
        return tripDurationBudget(machineId);
      }
      await sleep(cfg.maxPausePollMs);
    }
  }

  async function runNode(node, nodeHandler, facts) {
    const ceiling = Math.min(
      typeof node.retry === 'number' ? node.retry : retryAttemptsOf(node),
      cfg.maxRetryAttempts,
    );
    const attempts = Math.max(1, Math.min(ceiling, cfg.maxRetryAttempts));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const outcome = nodeHandler
          ? await nodeHandler({
            machineId: facts.machineId,
            node,
            attempt,
            facts: facts.facts,
            results: facts.results,
          })
          : undefined;
        if (outcome !== null && typeof outcome === 'object' && typeof outcome.outcome === 'string') {
          return { handled: true, ...outcome };
        }
        return { handled: true, outcome: 'succeeded' };
      } catch (error) {
        recordAudit({
          op: 'run.retry',
          machineId: facts.machineId,
          node: node.id,
          attempt,
          code: 'handler_error',
        });
        if (attempt === attempts) {
          return {
            handled: true,
            outcome: 'failed',
            errorReference: `node-failed/${node.id}`.slice(0, 128),
          };
        }
      }
    }
    return { handled: true, outcome: 'failed', errorReference: `node-failed/${node.id}`.slice(0, 128) };
  }

  /**
   * Execute a graph against a machine. The machine must exist and be startable
   * (created/ready/paused/running); terminal or waiting machines settle to
   * their existing state. Returns a bounded run result — never throws for
   * node outcomes (failure is a state, not an escape), throws only for
   * admission errors (invalid graph, backpressure).
   */
  async function run(machineId, graph, runOptions = {}) {
    validateAgentGraph(graph);
    const nodes = graph.nodes.map((node) => ({ ...node }));
    if (nodes.length > cfg.maxQueued) {
      recordAudit({ op: 'run.start', machineId, admitted: false, nodeCount: nodes.length });
      throw new AgentMachineRuntimeError(
        'lego.backpressure',
        `graph has ${nodes.length} nodes; the bounded queue accepts at most ${cfg.maxQueued}`,
        { nodeCount: nodes.length, maxQueued: cfg.maxQueued },
      );
    }

    const nodeHandler = runOptions.onNode ?? onNode;
    const conditionEval = runOptions.evaluateCondition ?? evaluateCondition;
    const exec = { cancelled: false };
    executions.set(machineId, exec);
    recordAudit({ op: 'run.start', machineId, nodeCount: nodes.length });

    const state = new Map(nodes.map((node) => [node.id, 'pending']));
    const results = new Map();
    const runFacts = runOptions.facts ?? {};
    let stepChain = Promise.resolve();
    let failure = null;
    let status = 'running';

    function recordStep(node, outcome, extra = {}) {
      const final = extra.final === true;
      stepChain = stepChain.then(async () => {
        if (exec.cancelled) {
          recordAudit({ op: 'step.skipped', machineId, node: node.id, reason: 'cancelled' });
          return null;
        }
        let rec;
        // A paused machine still owes this step: wait for resume (bounded by
        // the run loop's own cancellation and duration budget) instead of
        // dropping the record.
        for (;;) {
          try {
            rec = describeMachine(machineId);
          } catch (error) {
            return null;
          }
          if (exec.cancelled) {
            recordAudit({ op: 'step.skipped', machineId, node: node.id, reason: 'cancelled' });
            return null;
          }
          if (rec.lifecycle === 'paused') {
            await sleep(cfg.maxPausePollMs);
            continue;
          }
          break;
        }
        if (rec.lifecycle !== 'running') {
          recordAudit({ op: 'step.skipped', machineId, node: node.id, reason: rec.lifecycle });
          return rec;
        }
        try {
          const next = manager.step({
            machineId,
            expectedVersion: rec.version,
            sequence: rec.stepCount + 1,
            stepId: `run-${rec.stepCount + 1}-${node.id}`.slice(0, 64),
            inputReference: node.id,
            approvalReference: extra.approvalReference,
            result: {
              outcome,
              final,
              resultReference: extra.resultReference,
              errorReference: extra.errorReference,
            },
          });
          emitFor(next);
          recordAudit({ op: 'step', machineId, node: node.id, outcome, final });
          return next;
        } catch (error) {
          if (error instanceof AgentMachineError && /budget-exhausted/.test(error.message)) {
            recordAudit({ op: 'budget.exhausted', machineId, budget: error.details?.budget ?? 'unknown' });
            emitFor(describeMachine(machineId));
            failure = { code: 'budget-exhausted', budget: error.details?.budget ?? 'unknown' };
            status = 'failed';
            return null;
          }
          throw error;
        }
      });
      return stepChain;
    }

    function settled(nodeId) {
      const value = state.get(nodeId);
      return value === 'succeeded' || value === 'skipped';
    }

    try {
      let machine = describeMachine(machineId);
      if (machine.lifecycle === 'created' || machine.lifecycle === 'ready') {
        machine = manager.start({ machineId, expectedVersion: machine.version });
        emitFor(machine);
        recordAudit({ op: 'start', machineId, lifecycle: machine.lifecycle, via: 'run' });
      } else if (machine.lifecycle === 'paused') {
        const resumed = manager.resume({ machineId, expectedVersion: machine.version });
        emitFor(resumed);
        recordAudit({ op: 'resume', machineId, via: 'run' });
        machine = resumed;
      }

      for (;;) {
        if (exec.cancelled) { status = 'cancelled'; break; }
        machine = describeMachine(machineId);
        if (machine.lifecycle === 'cancelled') { status = 'cancelled'; break; }
        if (machine.lifecycle === 'failed') {
          status = 'failed';
          failure = machine.failure ?? { code: 'step-failed' };
          break;
        }
        if (machine.lifecycle === 'waiting') { status = 'waiting'; break; }
        if (machine.lifecycle === 'completed') { status = 'completed'; break; }
        if (machine.lifecycle === 'paused') {
          const afterPause = await waitWhilePaused(machineId, exec);
          if (afterPause.lifecycle === 'failed') {
            status = 'failed';
            failure = afterPause.failure ?? { code: 'budget-exhausted', budget: 'maxDurationMs' };
            break;
          }
          if (afterPause.lifecycle === 'cancelled') { status = 'cancelled'; break; }
          continue;
        }

        const startedAt = Date.parse(machine.startedAt ?? machine.createdAt);
        if (Number.isFinite(startedAt) && now() - startedAt >= machine.budgets.maxDurationMs) {
          machine = tripDurationBudget(machineId);
          status = machine.lifecycle === 'failed' ? 'failed' : status;
          failure = machine.failure ?? failure;
          if (machine.lifecycle !== 'running') break;
        }

        const pending = nodes.filter((node) => state.get(node.id) === 'pending');
        if (pending.length === 0) {
          // Every node settled without a final record (e.g. the whole graph was
          // pruned fail-closed): close the machine honestly with one explicit
          // run-level final step rather than leaving it running forever.
          if (machine.lifecycle === 'running' && status === 'running') {
            const rec = describeMachine(machineId);
            if (rec.lifecycle === 'running') {
              const done = manager.step({
                machineId,
                expectedVersion: rec.version,
                sequence: rec.stepCount + 1,
                stepId: `run-close-${rec.stepCount + 1}`.slice(0, 64),
                result: { outcome: 'succeeded', final: true, resultReference: 'runtime/all-settled' },
              });
              emitFor(done);
              recordAudit({ op: 'run.end', machineId, note: 'all nodes settled' });
              status = 'completed';
            }
          }
          break;
        }

        const failedNode = nodes.find((node) => state.get(node.id) === 'failed');
        if (failedNode) { status = 'failed'; break; }

        const ready = pending.filter((node) => (node.dependsOn ?? []).every(settled));
        if (ready.length === 0) {
          // Validation forbids cycles, so this can only be an upstream skip.
          for (const node of pending) state.set(node.id, 'skipped');
          break;
        }

        const wave = ready.slice(0, cfg.maxConcurrency);
        const remainingAfterWave = pending.length - wave.length;

        // Bounded concurrency: evaluate the condition per node, then run the
        // wave's handlers in parallel within the slot ceiling.
        const admitted = [];
        for (const node of wave) {
          const deps = node.dependsOn ?? [];
          const branchSkipsDeps = node.condition !== undefined && deps.length > 0
            ? deps.some((depId) => state.get(depId) === 'skipped')
            : false;
          const upstreamSkipped = deps.some((depId) => state.get(depId) === 'skipped');
          const gate = node.condition !== undefined
            ? !conditionEval(node.condition, { ...runFacts, ...Object.fromEntries(results) })
            : false;
          if (node.kind === 'branch' && gate) {
            state.set(node.id, 'skipped');
            recordAudit({ op: 'run.node', machineId, node: node.id, outcome: 'skipped' });
            continue;
          }
          if (upstreamSkipped && node.kind !== 'join') {
            state.set(node.id, 'skipped');
            recordAudit({ op: 'run.node', machineId, node: node.id, outcome: 'skipped' });
            continue;
          }
          if (branchSkipsDeps && node.kind !== 'join') {
            state.set(node.id, 'skipped');
            continue;
          }
          admitted.push(node);
        }

        const outcomes = await Promise.all(admitted.map(async (node) => {
          state.set(node.id, 'running');
          const outcome = await runNode(node, nodeHandler, {
            machineId,
            facts: runFacts,
            results,
          });
          return { node, outcome };
        }));

        // Serialize step recording (the contract's sequence is linear).
        const waveSettled = outcomes.filter((entry) => state.get(entry.node.id) === 'running');
        const finalIndex = remainingAfterWave === 0 && waveSettled.length > 0 ? waveSettled.length - 1 : -1;
        for (let index = 0; index < outcomes.length; index += 1) {
          const { node, outcome } = outcomes[index];
          if (state.get(node.id) !== 'running') continue;
          if (outcome.handled && outcome.outcome !== 'succeeded' && outcome.outcome !== 'failed'
            && outcome.outcome !== 'approval-required' && outcome.outcome !== 'cancelled') {
            state.set(node.id, 'failed');
            recordAudit({ op: 'run.node', machineId, node: node.id, outcome: 'invalid_outcome' });
            failure = { code: 'step-failed', stepId: node.id, errorReference: `invalid-outcome/${node.id}` };
            await recordStep(node, 'failed', { errorReference: `invalid-outcome/${node.id}`.slice(0, 128) });
            status = 'failed';
            break;
          }
          const stepOutcome = outcome.outcome;
          if (stepOutcome === 'failed') {
            state.set(node.id, 'failed');
            failure = {
              code: 'step-failed',
              stepId: node.id,
              errorReference: outcome.errorReference ?? `node-failed/${node.id}`.slice(0, 128),
            };
            recordAudit({ op: 'run.node', machineId, node: node.id, outcome: 'failed' });
            await recordStep(node, 'failed', { errorReference: failure.errorReference });
            status = 'failed';
            break;
          }
          if (stepOutcome === 'cancelled') {
            state.set(node.id, 'skipped');
            exec.cancelled = true;
            await recordStep(node, 'cancelled');
            status = 'cancelled';
            break;
          }
          if (stepOutcome === 'approval-required') {
            results.set(node.id, outcome.result ?? null);
            state.set(node.id, 'waiting');
            recordAudit({ op: 'run.node', machineId, node: node.id, outcome: 'approval-required' });
            await recordStep(node, 'approval-required', {
              approvalReference: outcome.approvalReference,
              final: false,
            });
            status = 'waiting';
            break;
          }
          results.set(node.id, outcome.result ?? null);
          state.set(node.id, 'succeeded');
          recordAudit({ op: 'run.node', machineId, node: node.id, outcome: 'succeeded' });
          const isFinal = index === finalIndex
            && outcomes.length === waveSettled.length
            && [...state.values()].every((value) => value !== 'pending' && value !== 'running');
          await recordStep(node, 'succeeded', {
            final: isFinal,
            resultReference: outcome.resultReference,
          });
          if (isFinal) status = 'completed';
        }

        if (status === 'waiting' || status === 'cancelled') break;
        if (status === 'failed') break;
        if (status === 'completed') break;
      }

      await stepChain;
      const finalMachine = describeMachine(machineId);
      if (finalMachine.lifecycle === 'completed') status = 'completed';
      if (finalMachine.lifecycle === 'failed') {
        status = 'failed';
        failure = finalMachine.failure ?? failure ?? { code: 'step-failed' };
      }
      if (finalMachine.lifecycle === 'cancelled') status = 'cancelled';
      if (finalMachine.lifecycle === 'waiting') status = 'waiting';

      recordAudit({ op: 'run.end', machineId, status, failure: failure?.code ?? null });
      return Object.freeze({
        machineId,
        status,
        failure: failure ? Object.freeze({ ...failure }) : null,
        steps: finalMachine.stepCount,
        results: Object.freeze(Object.fromEntries(results)),
        events: events.length,
        eventsDropped,
      });
    } finally {
      executions.delete(machineId);
    }
  }

  /**
   * Cancellation through the runtime: idempotent at the contract level and
   * cooperative for any live run loop (queued work stops promptly).
   */
  function cancel(input) {
    const payload = typeof input === 'string' ? { machineId: input } : stripRuntimeKeys(input);
    const exec = executions.get(payload.machineId);
    if (exec) exec.cancelled = true;
    return passthrough('cancel', payload);
  }

  function listEvents(filter = {}) {
    if (filter.machineId === undefined) return [...events];
    return events.filter((event) => event.machineId === filter.machineId);
  }

  function listAudit() {
    return [...auditTrail];
  }

  function stats() {
    return Object.freeze({
      events: events.length,
      eventsDropped,
      audit: auditTrail.length,
      operationLog: operationLog.size,
      activeRuns: executions.size,
    });
  }

  return Object.freeze({
    limits: cfg,
    manager,
    // contract ops
    create,
    describe,
    prepare: (input) => passthrough('prepare', input),
    start: (input) => passthrough('start', input),
    step: (input) => passthrough('step', input),
    pause: (input) => passthrough('pause', input),
    resume: (input) => passthrough('resume', input),
    delegate: (input) => passthrough('delegate', input),
    cancel,
    // bounded execution
    run,
    list,
    listEvents,
    listAudit,
    stats,
  });
}
