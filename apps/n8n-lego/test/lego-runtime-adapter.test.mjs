/**
 * P2.21 — Runtime Adapter & Harness Stack tests.
 *
 * Proves the contract-preserving seam (explicit provider registration, EXTERNAL
 * fail-closed, lifecycle translation), CONTRACT COMPATIBILITY via differential
 * replay against the real P2.16 host (same tests, same semantics, only the
 * provider seam swapped), and the deterministic in-process harness scenarios
 * (lifecycle/cancel/deadline/backpressure/retry/isolation/events/correlation/
 * causation/approval/artifact). No network, no shell, no filesystem, no MCP,
 * no model, no timers.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  RUNTIME_ADAPTER_CONTRACT,
  RUNTIME_ADAPTER_CONTRACT_VERSION,
  RUNTIME_ADAPTER_FIELDS,
  RUNTIME_ADAPTER_OPERATIONS,
  RUNTIME_ADAPTER_PERMISSIONS,
  ADAPTER_CAPABILITIES,
  ADAPTER_LOCALITIES,
  ADAPTER_EXECUTOR_KINDS,
  ADAPTER_AGENT_MACHINE_VERSION,
  ADAPTER_RUNTIME_CONTRACT,
  ADAPTER_AVAILABILITIES,
  RUNTIME_LIFECYCLE_TRANSLATION,
  ADAPTER_LIMITS,
  RuntimeAdapterError,
  createRuntimeRegistry,
  createRuntimeAdapter,
  createSimulatedRuntime,
  createAdapterHarness,
} from '../src/lego/runtime-adapter.mjs';
import {
  AGENT_MACHINE_CONTRACT_VERSION,
  AGENT_MACHINE_EXECUTOR_KINDS,
  AGENT_MACHINE_LIFECYCLE_STATES,
  AGENT_MACHINE_OPERATIONS,
  createAgentMachineManager,
} from '../src/lego/agent-machine.mjs';
import { AI_FOUNDATION, AGENT_EVENT_TYPES } from '../src/lego/ai-foundation.mjs';
import { createApprovalFoundation } from '../src/lego/approval.mjs';

const MODULE_SRC = readFileSync(new URL('../src/lego/runtime-adapter.mjs', import.meta.url), 'utf8');
const LOCK = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url), 'utf8'));
const LEGO_SET = JSON.parse(readFileSync(new URL('../src/lego/manifest/ai-lego-set.json', import.meta.url), 'utf8'));
const DOMAINS = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url), 'utf8'));

const BUDGETS = { maxSteps: 4, maxDurationMs: 600000, maxContinuationBytes: 64, maxReferences: 8 };

const tickClock = (start = '2026-09-23T00:00:00.000Z') => {
  let t = Date.parse(start);
  const fn = () => new Date(t).toISOString();
  fn.advance = (ms) => { t += ms; return fn(); };
  return fn;
};
const counterIds = (prefix = 'id') => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

const freshRegistry = (options = {}) => createRuntimeRegistry({ now: tickClock(), newId: counterIds('reg'), ...options });

const freshSim = (options = {}) => createSimulatedRuntime({ runtimeId: 'sim-1', now: tickClock(), ...options });

const wired = (options = {}) => {
  const registry = freshRegistry(options.registry);
  const sim = freshSim(options.sim);
  const declaration = { ...sim.declaration(), ...(options.declaration ?? {}) };
  registry.register(declaration);
  const now = tickClock('2026-09-22T00:00:00.000Z');
  const adapter = createRuntimeAdapter({
    registry, runtimeId: declaration.runtimeId, runtime: options.runtime === null ? null : sim, now, newId: counterIds('adv'),
  });
  return { registry, sim, adapter, now };
};

const caught = (block) => {
  try { block(); } catch (error) { return error; }
  throw new Error('expected a throw, got none');
};

/* ------------------------------------------------------- contract surface */

test('the contract is ai.runtime-adapter@1.1.0, owner manager, id double-quoted, created exactly once', () => {
  assert.equal(RUNTIME_ADAPTER_CONTRACT.id, "ai.runtime-adapter");
  // P2.25 DELIBERATE EDIT: MINOR bump for the additive external-runtime surface (src/lego/external-runtime.mjs);
  // the seam's operations, gates and behaviour are unchanged.
  assert.equal(RUNTIME_ADAPTER_CONTRACT_VERSION, '1.1.0');
  assert.equal(RUNTIME_ADAPTER_CONTRACT.owner, 'manager');
  assert.match(MODULE_SRC, /id:\s*"ai\.runtime-adapter"/, 'contract ids are double-quoted (F16 convention)');
  assert.equal(LOCK.contracts.filter((row) => row.id === 'ai.runtime-adapter').length, 1, 'exactly one canonical row');
  assert.equal(LOCK.contracts.filter((row) => row.id === 'ai.agent-runtime').length, 0, 'ai.agent-runtime is NOT duplicated into a lock row (the lifecycle contract stays vocabulary)');
});

test('the contract-lock row names real exports, real ops, the real test file — 26 rows total', () => {
  const row = LOCK.contracts.find((r) => r.id === 'ai.runtime-adapter');
  assert.equal(row.version, '1.1.0');
  assert.equal(row.owner, 'manager');
  assert.equal(row.domain, 'ai-foundation');
  assert.equal(row.status, 'implemented');
  assert.deepEqual([...row.operations], [...RUNTIME_ADAPTER_OPERATIONS]);
  // P9.1 envelope + P3 optimizer are merged; P9.2 structured-log adds row 42.
  assert.equal(LOCK.contracts.length, 100, 'rows through P3 Slice A persistent logical graph (thirty-third); P3 Slice D adds the thirty-fourth (execution.frontier); P3 Slice E adds the thirty-fifth (execution.state-stream); P3 Slice H adds the thirty-sixth (workflow.dna); P3 Slice J the thirty-seventh (execution.ir); P3 Slice L the thirty-eighth (compatibility.oracle); P3 Slice M the thirty-ninth (execution.guard); P3 Slice K the forty-first (execution.optimizer) — P6.1 adds node.registry@0.1.0; P6.2 adds registry.compiler@0.1.0; P6.3 adds package.transaction@0.1.0; P6.4 adds registry.closure@0.1.0; P6.5 adds node.resolution@0.1.0; P6.6 adds runtime.lease@0.1.0; P6.7 adds node.residency@0.1.0; P6.8 adds node.capability@0.1.0; P6.9 adds node.semantics@0.1.0; P6.10 adds node.lifecycle@0.1.0; P6.11 adds node.health@0.1.0; P6.12 adds node.supply-chain@0.1.0; P6.13 adds registry.incremental@0.1.0; P6.14 adds node.worker-convergence@0.1.0; P6.15 adds node.acceptance@0.1.0; P6.16 adds registry.integrity@0.1.0; P6.17 adds node.admission@0.1.0; P6.18 adds node.sbom@0.1.0; P6.19 adds node.canary@0.1.0; P6.20 adds node.revocation@0.1.0; P6.21 adds node.io@0.1.0; P6.22 adds runtime.jit@0.1.0; P6.23 adds runtime.cancel@0.1.0; P6.24 adds runtime.pool@0.1.0; P6.25 adds node.abi@0.1.0; P6.26 adds runtime.wasm-cache@0.1.0; P6.27 adds node.provenance@0.1.0; P6.28 adds registry.freshness@0.1.0; P6.29 adds node.namespace@0.1.0; P6.30 adds registry.repair@0.1.0; P6.31 adds registry.acceptance@0.1.0; count-pins say 76; P2.27.1 adds lego.plugin-runtime@0.1.0 (seventy-sixth); P5.1 adds the ninety-fifth (auth.principal)'); // P9 integration (Agent 1): P9.5-P9.22 add 18 observability.* rows on top of protected main 76 -> 94 (union, zero id collisions); P9 was developed on 24032a0c (57 rows). P5.2 adds the ninety-sixth (auth.session). P5.3 adds the ninety-seventh (auth.authorization). P5.5 adds the ninety-eighth (auth.credential-crypto). P5.6 adds the ninety-ninth (auth.account-security). P5.7 adds the hundredth (auth.machine-identity).
  const exported = row.exports['src/lego/runtime-adapter.mjs'].slice().sort();
  assert.deepEqual(exported, Object.keys({
    RUNTIME_ADAPTER_CONTRACT: 1, RUNTIME_ADAPTER_CONTRACT_VERSION: 1, RUNTIME_ADAPTER_FIELDS: 1,
    RUNTIME_ADAPTER_OPERATIONS: 1, RUNTIME_ADAPTER_PERMISSIONS: 1, ADAPTER_CAPABILITIES: 1,
    ADAPTER_LOCALITIES: 1, ADAPTER_EXECUTOR_KINDS: 1, ADAPTER_AGENT_MACHINE_VERSION: 1,
    ADAPTER_RUNTIME_CONTRACT: 1, ADAPTER_AVAILABILITIES: 1, RUNTIME_LIFECYCLE_TRANSLATION: 1,
    ADAPTER_LIMITS: 1, RuntimeAdapterError: 1, createRuntimeRegistry: 1, createRuntimeAdapter: 1,
    createSimulatedRuntime: 1, createAdapterHarness: 1,
  }).sort());
  assert.ok(row.tests.every((p) => p.endsWith('.mjs')));
  assert.ok(/fail[\s-]?closed/i.test(row.notes) && row.notes.includes('EXTERNAL'));
});

test('capabilities, localities, executor kinds, availabilities and versions are quoted — none invented', () => {
  const meta = AI_FOUNDATION.agentRuntime.runtimeMetadata;
  assert.deepEqual([...ADAPTER_CAPABILITIES], [...Object.keys(meta.supports), 'artifacts']);
  assert.deepEqual([...ADAPTER_LOCALITIES], [...meta.locality]);
  assert.deepEqual([...ADAPTER_EXECUTOR_KINDS], [...AGENT_MACHINE_EXECUTOR_KINDS]);
  assert.equal(ADAPTER_AGENT_MACHINE_VERSION, AGENT_MACHINE_CONTRACT_VERSION);
  assert.equal(ADAPTER_AGENT_MACHINE_VERSION, '1.1.0');
  assert.equal(ADAPTER_RUNTIME_CONTRACT, 'ai.agent-runtime@1.0.0', 'quoted from the official LEGO versioning');
  const lego = LEGO_SET.lego.find((l) => l.id === 'runtime-adapter');
  assert.deepEqual([...ADAPTER_AVAILABILITIES], [...lego.degradation]);
  assert.deepEqual([...RUNTIME_ADAPTER_OPERATIONS].sort(), ['eligibility', 'lookup', 'manager', 'register']);
  assert.ok(ADAPTER_LOCALITIES.includes('in-process') && !ADAPTER_LOCALITIES.includes('simulated') && !ADAPTER_LOCALITIES.includes('external'),
    'transport/locality vocabulary stays canonical — EXTERNAL is an executorKind, not a locality');
});

test('the translation table maps the official runtime vocabulary onto the canonical machine operations only', () => {
  const lego = LEGO_SET.lego.find((l) => l.id === 'runtime-adapter');
  assert.deepEqual(Object.keys(RUNTIME_LIFECYCLE_TRANSLATION).sort(), [...lego.operations].sort(),
    'every official runtime-adapter operation is declared — none added, none dropped');
  for (const [runtimeOp, mapped] of Object.entries(RUNTIME_LIFECYCLE_TRANSLATION)) {
    if (mapped === null) {
      assert.equal(runtimeOp, 'stream', 'only stream is declared-unsupported against 1.1.0');
      continue;
    }
    for (const canonical of mapped) {
      assert.ok(AGENT_MACHINE_OPERATIONS.includes(canonical),
        `${runtimeOp} -> ${canonical} must target a canonical ai.agent-machine@1.1.0 operation`);
    }
  }
  assert.deepEqual(RUNTIME_LIFECYCLE_TRANSLATION.cancel, ['agentMachine.cancel']);
  assert.deepEqual(RUNTIME_LIFECYCLE_TRANSLATION.status, ['agentMachine.describe']);
  assert.deepEqual(RUNTIME_LIFECYCLE_TRANSLATION.connect, [], 'connect is pure seam state');
});

test('the domain capability, lock row and module agree on operations and permissions', () => {
  const domain = DOMAINS.domains.find((d) => d.id === 'ai-foundation');
  const cap = domain.capabilities.find((c) => c.id === 'ai.runtime-adapter');
  assert.ok(cap, 'ai.runtime-adapter is a declared domain capability');
  assert.deepEqual(cap.operations.map((o) => o.name).sort(), [...RUNTIME_ADAPTER_OPERATIONS].sort());
  assert.deepEqual([...cap.permissions].sort(), [...RUNTIME_ADAPTER_PERMISSIONS].sort());
  assert.deepEqual([...cap.interaction], ['call']);
  const row = LOCK.contracts.find((r) => r.id === 'ai.runtime-adapter');
  assert.ok(row.exports['src/lego/runtime-adapter.mjs'].every((name) => MODULE_SRC.includes(`export const ${name}`) || MODULE_SRC.includes(`export class ${name}`) || MODULE_SRC.includes(`export function ${name}`)));
  assert.ok(domain.paths.includes('src/lego/runtime-adapter.mjs'), 'the file is a declared boundary path (arch gate)');
});

test('the official runtime-adapter LEGO stays contract-only with a P2.21 seam statusNote', () => {
  const entry = LEGO_SET.lego.find((l) => l.id === 'runtime-adapter');
  assert.equal(entry.status, 'contract-only');
  assert.equal(entry.owner, 'manager');
  assert.match(entry.statusNote ?? '', /P2\.21 publishes ai\.runtime-adapter@1\.0\.0/);
  assert.match(entry.statusNote ?? '', /ai\.agent-machine@1\.1\.0/);
  assert.deepEqual(entry.contracts, ['ai.agent-runtime'], 'the official lifecycle contract identity is untouched');
  assert.ok(entry.noRewriteRule.includes('NEVER reimplemented'));
});

/* --------------------------------------------- §37 adapter registration */

test('explicit provider registration → lookup returns the frozen declaration', () => {
  const registry = freshRegistry();
  const record = registry.register({
    runtimeId: 'run-a', contract: ADAPTER_RUNTIME_CONTRACT, executorKinds: ['EXTERNAL'],
    capabilities: ['cancellation', 'artifacts'], locality: 'local-network', availability: 'available', providerId: 'prov-1',
  });
  assert.equal(record.runtimeId, 'run-a');
  assert.equal(record.contract, ADAPTER_RUNTIME_CONTRACT);
  assert.ok(Object.isFrozen(record));
  const found = registry.lookup('run-a');
  assert.deepEqual(found, record);
  assert.equal(registry.lookup('ghost'), null, 'lookup is not eligibility — unknown is null');
  assert.equal(registry.size, 1);
});

test('duplicate registration, unknown capability, invalid locality/availability and missing EXTERNAL are all rejected', () => {
  const registry = freshRegistry();
  const base = {
    runtimeId: 'run-x', contract: ADAPTER_RUNTIME_CONTRACT, executorKinds: ['EXTERNAL'],
    capabilities: ['cancellation'], locality: 'in-process',
  };
  registry.register(base);
  assert.throws(() => registry.register(base), (e) => e instanceof RuntimeAdapterError && /already registered/.test(e.message));
  assert.throws(() => registry.register({ ...base, runtimeId: 'run-y', capabilities: ['shell-exec'] }),
    (e) => e instanceof RuntimeAdapterError && /not in the canonical vocabulary/.test(e.message),
    'unknown capability fails closed at registration');
  assert.throws(() => registry.register({ ...base, runtimeId: 'run-y', locality: 'external-zone' }),
    (e) => e instanceof RuntimeAdapterError && /locality must be one of/.test(e.message));
  assert.throws(() => registry.register({ ...base, runtimeId: 'run-y', availability: 'always-on' }),
    (e) => e instanceof RuntimeAdapterError && /availability must be one of/.test(e.message));
  assert.throws(() => registry.register({ ...base, runtimeId: 'run-y', executorKinds: ['IN_MEMORY'] }),
    (e) => e instanceof RuntimeAdapterError && /must include EXTERNAL/.test(e.message));
  assert.throws(() => registry.register({ ...base, runtimeId: 'run-y', executorKinds: ['SHELL'] }),
    (e) => e instanceof RuntimeAdapterError && /not in the canonical vocabulary/.test(e.message));
  assert.throws(() => registry.register({ ...base, runtimeId: 'run-y', contract: 'ai.agent-runtime@2.0.0' }),
    (e) => e instanceof RuntimeAdapterError && /unsupported contract/.test(e.message),
    'unsupported contract version fails closed');
  assert.throws(() => registry.register({ ...base, runtimeId: 'run-y', capabilities: ['cancellation', 'ghp_abcdefghijklmnop'] }),
    (e) => e instanceof RuntimeAdapterError && /secret-shaped|not in the canonical vocabulary/.test(e.message));
});

test('eligibility answers fail-closed with stable reasons for every unknown/invalid condition', () => {
  const registry = freshRegistry();
  assert.equal(registry.eligibility('ghost', { executorKind: 'EXTERNAL' }).reason, 'unknown-provider');
  registry.register({
    runtimeId: 'run-b', contract: ADAPTER_RUNTIME_CONTRACT, executorKinds: ['EXTERNAL'],
    capabilities: ['cancellation'], locality: 'remote', availability: 'available',
  });
  assert.equal(registry.eligibility('run-b', { executorKind: 'EXTERNAL' }).eligible, true);
  assert.equal(registry.eligibility('run-b', { executorKind: 'SHELL' }).reason, 'unknown-executor-kind');
  assert.equal(registry.eligibility('run-b', { executorKind: 'IN_MEMORY' }).reason, 'unsupported-executor-kind');
  assert.equal(registry.eligibility('run-b', { operation: 'agentMachine.close' }).reason, 'unsupported-operation',
    'no close operation exists in 1.1.0 — unknown operations fail closed');
  assert.equal(registry.eligibility('run-b', { operation: 'agentMachine.start' }).eligible, true);
  assert.equal(registry.eligibility('run-b', { capability: 'stream' }).reason, 'missing-capability',
    'known vocabulary the runtime never declared is still missing-capability');
  assert.equal(registry.eligibility('run-b', { capability: 'teleport' }).reason, 'missing-capability');
  const registry2 = freshRegistry();
  registry2.register({ ...{ contract: ADAPTER_RUNTIME_CONTRACT, executorKinds: ['EXTERNAL'], capabilities: ['cancellation'], locality: 'in-process' }, runtimeId: 'run-z', availability: 'version-incompatible' });
  assert.equal(registry2.eligibility('run-z', { executorKind: 'EXTERNAL' }).reason, 'unavailable');
});

test('the registry is bounded — capacity refusal is deterministic', () => {
  const registry = freshRegistry({ limits: { maxRuntimes: 1 } });
  registry.register({ runtimeId: 'run-1', contract: ADAPTER_RUNTIME_CONTRACT, executorKinds: ['EXTERNAL'], capabilities: ['cancellation'], locality: 'in-process' });
  assert.throws(() => registry.register({ runtimeId: 'run-2', contract: ADAPTER_RUNTIME_CONTRACT, executorKinds: ['EXTERNAL'], capabilities: ['cancellation'], locality: 'in-process' }),
    (e) => e instanceof RuntimeAdapterError && /bounded at 1 runtimes/.test(e.message));
});

test('adapter binding demands an explicit registration — unknown provider refuses at construction', () => {
  const registry = freshRegistry();
  assert.throws(
    () => createRuntimeAdapter({ registry, runtimeId: 'run-ghost' }),
    (e) => e instanceof RuntimeAdapterError && /not explicitly registered/.test(e.message),
  );
  assert.throws(() => createRuntimeAdapter({ registry: {}, runtimeId: 'run-1' }),
    (e) => e instanceof RuntimeAdapterError && /registry must expose/.test(e.message));
});

/* ------------------------------------- §10/§25 EXTERNAL executorKind fail-closed */

test('EXTERNAL without eligible provider fails closed through the P2.16 unavailable path', () => {
  const registry = freshRegistry();
  registry.register({ runtimeId: 'run-degraded', contract: ADAPTER_RUNTIME_CONTRACT, executorKinds: ['EXTERNAL'], capabilities: ['cancellation'], locality: 'in-process', availability: 'version-incompatible' });
  const adapter = createRuntimeAdapter({ registry, runtimeId: 'run-degraded', now: tickClock(), newId: counterIds('adv') });
  assert.equal(adapter.provider.supports('EXTERNAL'), false, 'declared-but-unavailable runtime is not eligible');
  const manager = adapter.manager();
  const error = caught(() => manager.create({
    machineId: 'mach-x', taskId: 'task-x', agentId: 'agent-x', executorKind: 'EXTERNAL', budgets: { ...BUDGETS },
  }));
  assert.equal(error.code, 'lego.unavailable');
  assert.match(error.message, /provider does not support executor kind 'EXTERNAL'/);
  // Unknown kinds never pass either.
  assert.equal(adapter.provider.supports('SHELL'), false);
  const err2 = caught(() => manager.create({
    machineId: 'mach-y', taskId: 'task-y', agentId: 'agent-y', executorKind: 'SHELL', budgets: { ...BUDGETS },
  }));
  assert.equal(err2.code, 'lego.contract_violation');
  assert.match(err2.message, /executorKind must be one of IN_MEMORY, EXTERNAL/);
  // The default P2.16 provider still refuses EXTERNAL (unchanged contract host).
  const plain = createAgentMachineManager({ now: tickClock() });
  const err3 = caught(() => plain.create({
    machineId: 'mach-z', taskId: 'task-z', agentId: 'agent-z', executorKind: 'EXTERNAL', budgets: { ...BUDGETS },
  }));
  assert.equal(err3.code, 'lego.unavailable');
});

test('EXTERNAL succeeds only with an eligible, explicitly registered provider', () => {
  const { adapter } = wired();
  assert.equal(adapter.provider.supports('EXTERNAL'), true);
  assert.equal(adapter.provider.supports('IN_MEMORY'), true);
  const machine = adapter.manager().create({
    machineId: 'mach-e', taskId: 'task-e', agentId: 'agent-e', executorKind: 'EXTERNAL', budgets: { ...BUDGETS },
  });
  assert.equal(machine.executorKind, 'EXTERNAL');
  assert.equal(machine.lifecycle, 'created');
  assert.equal(adapter.eligible({ executorKind: 'EXTERNAL' }).eligible, true);
});

test('provider surface is the declared seam only — records, never payloads or authority', () => {
  const { adapter } = wired();
  const provider = adapter.provider;
  for (const member of ['supports', 'put', 'get', 'list']) {
    assert.equal(typeof provider[member], 'function', member);
  }
  const forbidden = ['exec', 'spawn', 'shell', 'command', 'credential', 'endpoint', 'fetch', 'download', 'upload', 'readFile', 'writeFile'];
  for (const word of forbidden) {
    assert.ok(!(word in provider), `provider must not expose '${word}'`);
  }
  provider.put({ machineId: 'mach-p', lifecycle: 'created' });
  const back = provider.get('mach-p');
  assert.deepEqual(back, { machineId: 'mach-p', lifecycle: 'created' });
  assert.equal(provider.list().length, 1);
});

/* ----------------------------- §38 contract compatibility (differential) */

const CONTRACT_REPLAY = [
  { op: 'create', input: { machineId: 'mach-d', taskId: 'task-d', agentId: 'agent-d', budgets: { ...BUDGETS }, metadata: { label: 'd' } } },
  { op: 'create', input: { machineId: 'mach-d', taskId: 'task-d', agentId: 'agent-d', budgets: { ...BUDGETS } } }, // conflict (duplicate)
  { op: 'describe', input: { machineId: 'ghost' } }, // null (read-side absent)
  { op: 'cancel', input: { machineId: 'ghost', expectedVersion: 1 } }, // storage.not_found on a mutation
  { op: 'prepare', input: { machineId: 'mach-d', expectedVersion: 1 } }, // v1 → v2 ready
  { op: 'prepare', input: { machineId: 'mach-d', expectedVersion: 2 } }, // idempotent on ready (stays v2)
  { op: 'start', input: { machineId: 'mach-d', expectedVersion: 2 } }, // v2 → v3 running
  { op: 'start', input: { machineId: 'mach-d', expectedVersion: 3 } }, // idempotent on running (stays v3)
  { op: 'step', input: { machineId: 'mach-d', expectedVersion: 3, stepId: 's-x', sequence: 9, result: { outcome: 'succeeded' } } }, // stale sequence → conflict
  { op: 'step', input: { machineId: 'mach-d', expectedVersion: 3, stepId: 's-1', sequence: 1, result: { outcome: 'approval-required' } } }, // missing approvalReference → contract_violation
  { op: 'step', input: { machineId: 'mach-d', expectedVersion: 3, stepId: 's-1', sequence: 1, approvalReference: 'apr-pin', result: { outcome: 'approval-required', final: false } } }, // v3 → v4 waiting
  { op: 'resume', input: { machineId: 'mach-d', expectedVersion: 4 } }, // waiting pin message (fail-closed)
  { op: 'cancel', input: { machineId: 'mach-d', expectedVersion: 4 } }, // v4 → v5 cancelled (the only waiting exit)
  { op: 'cancel', input: { machineId: 'mach-d', expectedVersion: 5 } }, // idempotent on cancelled
  { op: 'step', input: { machineId: 'mach-d', expectedVersion: 5, stepId: 's-2', sequence: 2, result: { outcome: 'succeeded' } } }, // terminal refuse
  { op: 'describe', input: { machineId: 'mach-d' } },
];

const replay = (buildManager) => {
  const manager = buildManager();
  const errors = [];
  const errorMessages = [];
  const lifecycles = {};
  let last = null;
  for (const { op, input } of CONTRACT_REPLAY) {
    try {
      const out = manager[op](input);
      if (out && out.machineId) { lifecycles[out.machineId] = out.lifecycle; last = out; }
      if (op === 'describe' && out === null) last = null;
    } catch (error) {
      errors.push({ op, code: error.code });
      errorMessages.push(String(error.message));
    }
    if (input?.machineId) {
      const current = manager.describe({ machineId: input.machineId });
      if (current) lifecycles[current.machineId] = current.lifecycle;
    }
  }
  return { lifecycles, errors, errorMessages, last };
};

test('the adapter-backed manager exposes EXACTLY the P2.16 manager surface — no new operation', () => {
  const { adapter } = wired();
  const adapted = adapter.manager();
  const plain = createAgentMachineManager({ now: tickClock() });
  assert.deepEqual(Object.keys(adapted).sort(), Object.keys(plain).sort());
  for (const op of ['create', 'describe', 'prepare', 'start', 'step', 'pause', 'resume', 'delegate', 'cancel']) {
    assert.equal(typeof adapted[op], 'function', op);
  }
  assert.equal('close' in adapted, false, 'no close operation is added');
  assert.equal(Object.keys(adapted).filter((k) => typeof adapted[k] === 'function').length,
    Object.keys(plain).filter((k) => typeof adapted[k] === 'function').length);
});

test('P2.16 contract replay through the adapter is byte-identical to the default host (same tests, same semantics)', () => {
  const baseline = replay(() => createAgentMachineManager({ now: tickClock('2026-09-22T00:00:00.000Z') }));
  const { adapter } = wired();
  const adapted = replay(() => adapter.manager());
  assert.deepEqual(adapted.lifecycles, baseline.lifecycles, 'same state meanings');
  assert.deepEqual(adapted.errors, baseline.errors, 'same error codes on the same inputs');
  assert.deepEqual(adapted.errorMessages, baseline.errorMessages, 'same pinned messages (incl. the waiting resume pin)');
  assert.deepEqual(adapted.last, baseline.last, 'same public record shape and version trail');
  // The known P2.16 pins really are present in both.
  for (const side of [baseline, adapted]) {
    assert.ok(side.errorMessages.some((m) => /waiting on an approval reference; P2\.16 has no approval resolution, so it can only be cancelled \(fail-closed\)/.test(m)),
      'the pinned waiting-resume message is identical through the adapter');
    assert.ok(side.errors.some((e) => e.code === 'storage.conflict'));
    assert.ok(side.errors.some((e) => e.code === 'lego.contract_violation'));
    assert.ok(side.errors.some((e) => e.code === 'storage.not_found'));
  }
});

test('lifecycle vocabulary and step outcomes stay canonical on adapter-created machines', () => {
  const { adapter } = wired();
  const manager = adapter.manager();
  const machine = manager.create({ machineId: 'mach-v', taskId: 'task-v', agentId: 'agent-v', budgets: { ...BUDGETS } });
  assert.ok(AGENT_MACHINE_LIFECYCLE_STATES.includes(machine.lifecycle));
  assert.equal(machine.executorKind, 'IN_MEMORY', 'default kind is unchanged');
  manager.prepare({ machineId: 'mach-v', expectedVersion: 1 });
  const running = manager.start({ machineId: 'mach-v', expectedVersion: 2 });
  assert.ok(AGENT_MACHINE_LIFECYCLE_STATES.includes(running.lifecycle));
  assert.equal(ADAPTER_AGENT_MACHINE_VERSION, AGENT_MACHINE_CONTRACT_VERSION, 'the adapter serves 1.1.0 — it never forks the version');
});

test('the adapter never adds a lifecycle, task, budget, permission or event vocabulary of its own', () => {
  const { adapter } = wired();
  const machine = adapter.manager().create({ machineId: 'mach-n', taskId: 'task-n', agentId: 'agent-n', budgets: { ...BUDGETS } });
  assert.deepEqual(Object.keys(machine).sort(), [
    'agentId', 'budgets', 'capabilityScope', 'contextReference', 'createdAt', 'delegations', 'updatedAt',
    'executorKind', 'failure', 'lifecycle', 'machineId', 'metadata', 'sessionReference', 'startedAt',
    'stepCount', 'steps', 'taskId', 'version', 'workspaceReference',
  ].sort(), 'the public record is the P2.16 record — adapter adds no field');
});

/* ---------------------------------------------------- §39 harness scenarios */

const harnessOf = (options = {}) => {
  const wiredUp = wired(options);
  const harness = createAdapterHarness({ adapter: wiredUp.adapter, clock: wiredUp.adapter.clock });
  return { ...wiredUp, harness };
};

test('lifecycle scenario: create → prepare → start → dispatchStep runs deterministically', () => {
  const { harness } = harnessOf({ sim: { responses: [{ outcome: 'succeeded', final: false, resultReference: 'art://step-1' }] } });
  const result = harness.run({
    scenarioId: 'sc-lifecycle',
    operations: [
      { op: 'create', input: { machineId: 'mach-l', taskId: 'task-l', agentId: 'agent-l', executorKind: 'EXTERNAL', budgets: { ...BUDGETS } } },
      { op: 'prepare', input: { machineId: 'mach-l', expectedVersion: 1 } },
      { op: 'start', input: { machineId: 'mach-l', expectedVersion: 2 } },
      { op: 'dispatchStep', machineId: 'mach-l' },
    ],
    expected: { lifecycle: { 'mach-l': 'running' }, errors: [], retryAttempts: 0 },
  });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.actual.lifecycle['mach-l'], 'running');
});

test('cancel scenario: idempotent cancel corrupts nothing and propagates to the runtime seam', () => {
  const { harness, adapter } = harnessOf();
  const result = harness.run({
    scenarioId: 'sc-cancel',
    operations: [
      { op: 'create', input: { machineId: 'mach-c', taskId: 'task-c', agentId: 'agent-c', executorKind: 'EXTERNAL', budgets: { ...BUDGETS } } },
      { op: 'start', input: { machineId: 'mach-c', expectedVersion: 1 } },
      { op: 'cancel', input: { machineId: 'mach-c', expectedVersion: 2 } },
      { op: 'cancel', input: { machineId: 'mach-c', expectedVersion: 3 } },
      { op: 'cancel', input: { machineId: 'mach-c', expectedVersion: 3 } },
      { op: 'signalCancel', machineId: 'mach-c' },
      { op: 'signalCancel', machineId: 'mach-c' },
    ],
    expected: {
      lifecycle: { 'mach-c': 'cancelled' },
      errors: [],
      cancellations: ['mach-c'],
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.deepEqual(adapter.runtimeCancelledList(), ['mach-c'], 'repeated signals stay idempotent at the seam');
  const signals = [
    adapter.signalCancellation({ machineId: 'mach-c' }),
    adapter.signalCancellation({ machineId: 'mach-c' }),
    adapter.signalCancellation({ machineId: 'mach-c' }),
  ];
  for (const signal of signals) assert.equal(signal.propagated, true);
  assert.equal(signals[1].already, true, 'subsequent signals report already — never a corrupting re-transition');
});

test('deadline scenario: the clock advances deterministically, the deadline is never extended, budget-exhausted is terminal', () => {
  const { harness, adapter } = harnessOf();
  const budgets = { ...BUDGETS, maxDurationMs: 1000 };
  const started = harness.run({
    scenarioId: 'sc-deadline-setup',
    operations: [
      { op: 'create', input: { machineId: 'mach-dl', taskId: 'task-dl', agentId: 'agent-dl', executorKind: 'EXTERNAL', budgets } },
      { op: 'prepare', input: { machineId: 'mach-dl', expectedVersion: 1 } },
      { op: 'start', input: { machineId: 'mach-dl', expectedVersion: 2 } },
    ],
    expected: { lifecycle: { 'mach-dl': 'running' }, errors: [] },
  });
  assert.equal(started.ok, true, JSON.stringify(started.problems));
  const before = adapter.manager().describe({ machineId: 'mach-dl' });
  const result = harness.run({
    scenarioId: 'sc-deadline',
    operations: [
      { op: 'advance', ms: 2000 },
      { op: 'dispatchStep', machineId: 'mach-dl' },
    ],
    expected: {
      lifecycle: { 'mach-dl': 'failed' },
      errors: [{ op: 'dispatchStep', code: 'lego.contract_violation' }],
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  const after = adapter.manager().describe({ machineId: 'mach-dl' });
  assert.equal(after.failure?.code, 'budget-exhausted');
  assert.equal(after.failure?.budget, 'maxDurationMs');
  assert.equal(after.startedAt, before.startedAt, 'the deadline anchor is not extended by the adapter');
  assert.ok(result.actual.errorMessages.some((m) => /budget-exhausted/.test(m)));
});

test('backpressure scenario: the event outbox is bounded — overflow is a deterministic refusal, never a grow-forever queue', () => {
  const { harness, adapter } = harnessOf();
  const max = ADAPTER_LIMITS.maxPendingEvents;
  const operations = [];
  for (let i = 0; i < max + 1; i += 1) {
    operations.push({ op: 'forwardEvent', type: 'runtime.connected', correlationId: `cor-${i}` });
  }
  const result = harness.run({
    scenarioId: 'sc-backpressure',
    operations,
    expected: { errors: [], outboxAccepted: false, dropped: 1 },
  });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(adapter.outbox().length, max, 'exactly the bound is held');
  assert.equal(adapter.stats().dropped, 1);
  assert.equal(adapter.stats().maxPendingEvents, max);
});

test('retry scenario (success): bounded retries converge to final success', () => {
  const { harness } = harnessOf({
    sim: { responses: [{ failure: true }, { failure: true }, { outcome: 'succeeded', final: false, resultReference: 'art://recovered' }] },
  });
  const result = harness.run({
    scenarioId: 'sc-retry-ok',
    operations: [
      { op: 'create', input: { machineId: 'mach-r', taskId: 'task-r', agentId: 'agent-r', executorKind: 'EXTERNAL', budgets: { ...BUDGETS } } },
      { op: 'start', input: { machineId: 'mach-r', expectedVersion: 1 } },
      { op: 'dispatchStep', machineId: 'mach-r', maxAttempts: 3 },
    ],
    expected: { lifecycle: { 'mach-r': 'running' }, errors: [], retryAttempts: 2 },
  });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.actual.retryAttempts, 2, 'two failures then success — pulls bounded at maxRetryAttempts');
});

test('retry scenario (exhaustion): the bounded failure is delivered — never an unbounded retry loop', () => {
  const { harness } = harnessOf({ sim: { responses: [{ failure: true }, { failure: true }, { failure: true }, { failure: true }, { outcome: 'succeeded' }] } });
  const result = harness.run({
    scenarioId: 'sc-retry-fail',
    operations: [
      { op: 'create', input: { machineId: 'mach-rf', taskId: 'task-rf', agentId: 'agent-rf', executorKind: 'EXTERNAL', budgets: { ...BUDGETS } } },
      { op: 'start', input: { machineId: 'mach-rf', expectedVersion: 1 } },
      { op: 'dispatchStep', machineId: 'mach-rf', maxAttempts: 3 },
    ],
    expected: { lifecycle: { 'mach-rf': 'failed' }, errors: [], retryAttempts: 2 },
  });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  const simPulled = 3;
  assert.ok(result.actual.lifecycle['mach-rf'] === 'failed', 'bounded failure reached the canonical contract');
  void simPulled;
});

test('failure isolation: one machine fails, the unrelated machine keeps running', () => {
  const { harness, adapter } = harnessOf({
    sim: { responses: [{ failure: true, final: true }, { outcome: 'succeeded', final: false }] },
  });
  const result = harness.run({
    scenarioId: 'sc-isolation',
    operations: [
      { op: 'create', input: { machineId: 'mach-a', taskId: 'task-a', agentId: 'agent-a', executorKind: 'EXTERNAL', budgets: { ...BUDGETS } } },
      { op: 'create', input: { machineId: 'mach-b', taskId: 'task-b', agentId: 'agent-b', executorKind: 'EXTERNAL', budgets: { ...BUDGETS } } },
      { op: 'start', input: { machineId: 'mach-a', expectedVersion: 1 } },
      { op: 'start', input: { machineId: 'mach-b', expectedVersion: 1 } },
      { op: 'dispatchStep', machineId: 'mach-a' },
      { op: 'dispatchStep', machineId: 'mach-b' },
    ],
    expected: { lifecycle: { 'mach-a': 'failed', 'mach-b': 'running' }, errors: [] },
  });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  const b = adapter.manager().describe({ machineId: 'mach-b' });
  assert.equal(b.lifecycle, 'running');
  assert.equal(b.failure, null, 'the failing sibling left no residue on mach-b');
});

test('events: runtime events forward only canonical types; unknown types are rejected', () => {
  const { harness, adapter } = harnessOf();
  const result = harness.run({
    scenarioId: 'sc-events',
    operations: [
      { op: 'forwardEvent', type: 'runtime.connected', correlationId: 'cor-1' },
      { op: 'forwardEvent', type: 'runtime.unavailable', correlationId: 'cor-2', causationId: 'cor-1' },
    ],
    expected: { errors: [], events: ['runtime.connected', 'runtime.unavailable'] },
  });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  for (const event of adapter.outbox()) {
    assert.ok(AGENT_EVENT_TYPES.includes(event.type), `${event.type} is canonical`);
  }
  const error = caught(() => adapter.forwardEvent({ type: 'mcp.connected' }));
  assert.equal(error.code, 'lego.contract_violation');
  assert.match(error.message, /not in the canonical agent event vocabulary/);
});

test('correlation and causation propagate through the adapter, generated when absent', () => {
  const { harness, adapter } = harnessOf();
  harness.run({
    scenarioId: 'sc-correlation',
    operations: [
      { op: 'forwardEvent', type: 'runtime.connected', correlationId: 'root-1' },
      { op: 'forwardEvent', type: 'runtime.disconnected', correlationId: 'child-1', causationId: 'root-1' },
      { op: 'forwardEvent', type: 'runtime.unavailable' },
    ],
    expected: { errors: [] },
  });
  const [first, second, third] = adapter.outbox();
  assert.equal(first.correlationId, 'root-1');
  assert.equal(first.causationId, null, 'roots carry no causation');
  assert.equal(second.causationId, 'root-1', 'causation chain preserved through the seam');
  assert.equal(second.correlationId, 'child-1');
  assert.ok(third.correlationId && third.correlationId.length > 0, 'absent correlationId is generated deterministically (injected factory)');
  assert.ok(first.at && !Number.isNaN(Date.parse(first.at)));
});

test('approval boundary: the adapter neither resolves nor bypasses P2.19 approvals', () => {
  const approval = createApprovalFoundation({ now: tickClock() });
  approval.request({ approvalId: 'apr-adv', action: 'push code', actor: 'agent-1', risk: 'high', scope: 'repo:main' });
  const { harness, adapter } = harnessOf({ sim: { responses: [{ outcome: 'approval-required', approvalReference: 'apr-adv', final: false }] } });
  harness.run({
    scenarioId: 'sc-approval',
    operations: [
      { op: 'create', input: { machineId: 'mach-ap', taskId: 'task-ap', agentId: 'agent-ap', executorKind: 'EXTERNAL', budgets: { ...BUDGETS } } },
      { op: 'start', input: { machineId: 'mach-ap', expectedVersion: 1 } },
      { op: 'dispatchStep', machineId: 'mach-ap' },
    ],
    expected: { lifecycle: { 'mach-ap': 'waiting' }, errors: [] },
  });
  // Dependency-side resolution is P2.19's job — the adapter does not touch it.
  approval.resolve({ approvalId: 'apr-adv', decision: 'denied', approver: 'manager-1', reason: 'policy' });
  const verdict = approval.evaluate('apr-adv', { identity: 'agent-1', scope: 'repo:main' });
  assert.equal(verdict.decision, 'denied');
  assert.equal(verdict.reason, 'policy');
  assert.equal(adapter.manager().describe({ machineId: 'mach-ap' }).lifecycle, 'waiting',
    'the machine stays fail-closed waiting; cancel remains its only exit');
  // Denied approval never un-blocks anything at the adapter — static import check below.
  assert.ok(!MODULE_SRC.includes("from './approval.mjs'"), 'the adapter cannot import the approval foundation — no bypass path exists');
});

test('artifact boundary: opaque references flow through; path-shaped responses are refused at the seam', () => {
  const { harness, adapter } = harnessOf({
    sim: { responses: [{ outcome: 'succeeded', final: false, resultReference: 'art://opaque-42' }] },
  });
  harness.run({
    scenarioId: 'sc-artifact',
    operations: [
      { op: 'create', input: { machineId: 'mach-art', taskId: 'task-art', agentId: 'agent-art', executorKind: 'EXTERNAL', budgets: { ...BUDGETS } } },
      { op: 'start', input: { machineId: 'mach-art', expectedVersion: 1 } },
      { op: 'dispatchStep', machineId: 'mach-art' },
    ],
    expected: { errors: [], lifecycle: { 'mach-art': 'running' } },
  });
  const record = adapter.manager().describe({ machineId: 'mach-art' });
  assert.equal(record.steps[0].resultReference, 'art://opaque-42', 'the artifact reference stays opaque end-to-end');

  const pathSim = createSimulatedRuntime({ runtimeId: 'sim-path', responses: [{ outcome: 'succeeded', resultReference: '/etc/passwd' }] });
  const registry = freshRegistry();
  registry.register(pathSim.declaration());
  const pathAdapter = createRuntimeAdapter({ registry, runtimeId: 'sim-path', runtime: pathSim, now: tickClock(), newId: counterIds('adv') });
  const manager = pathAdapter.manager();
  const machine = manager.create({ machineId: 'mach-ps', taskId: 'task-ps', agentId: 'agent-ps', executorKind: 'EXTERNAL', budgets: { ...BUDGETS } });
  manager.prepare({ machineId: 'mach-ps', expectedVersion: machine.version });
  manager.start({ machineId: 'mach-ps', expectedVersion: 2 });
  const error = caught(() => pathAdapter.pullStep({ machineId: 'mach-ps' }));
  assert.ok(error instanceof RuntimeAdapterError);
  assert.match(error.message, /path-shaped values are refused at the adapter seam/);

  const traversalSim = createSimulatedRuntime({ runtimeId: 'sim-trav', responses: [{ outcome: 'succeeded', resultReference: '../secrets/key.pem' }] });
  const registry2 = freshRegistry();
  registry2.register(traversalSim.declaration());
  const travAdapter = createRuntimeAdapter({ registry: registry2, runtimeId: 'sim-trav', runtime: traversalSim, now: tickClock(), newId: counterIds('adv') });
  const m2 = travAdapter.manager();
  const mach2 = m2.create({ machineId: 'mach-ts', taskId: 'task-ts', agentId: 'agent-ts', executorKind: 'EXTERNAL', budgets: { ...BUDGETS } });
  m2.prepare({ machineId: 'mach-ts', expectedVersion: mach2.version });
  m2.start({ machineId: 'mach-ts', expectedVersion: 2 });
  assert.throws(() => travAdapter.pullStep({ machineId: 'mach-ts' }), (e) => e instanceof RuntimeAdapterError && /path-shaped/.test(e.message));
});

test('translation: declared-unsupported and unknown runtime operations both fail closed', () => {
  const { adapter } = wired();
  assert.deepEqual(adapter.translate('cancel'), ['agentMachine.cancel']);
  assert.deepEqual(adapter.translate('start'), ['agentMachine.create', 'agentMachine.prepare', 'agentMachine.start']);
  const unsupported = caught(() => adapter.translate('stream'));
  assert.ok(unsupported instanceof RuntimeAdapterError && /unsupported operations fail closed/.test(unsupported.message));
  const unknown = caught(() => adapter.translate('teleport'));
  assert.ok(unknown instanceof RuntimeAdapterError && /unknown runtime operation/.test(unknown.message));
});

test('pullStep without a runtime seam or on a non-running machine fails closed', () => {
  const registry = freshRegistry();
  registry.register({ runtimeId: 'run-seamless', contract: ADAPTER_RUNTIME_CONTRACT, executorKinds: ['EXTERNAL'], capabilities: ['cancellation'], locality: 'in-process' });
  const adapter = createRuntimeAdapter({ registry, runtimeId: 'run-seamless', runtime: null, now: tickClock(), newId: counterIds('adv') });
  const error = caught(() => adapter.pullStep({ machineId: 'mach-q' }));
  assert.ok(error instanceof RuntimeAdapterError && /no runtime seam/.test(error.message));
  assert.deepEqual(adapter.signalCancellation({ machineId: 'mach-q' }), { machineId: 'mach-q', propagated: false, reason: 'no-runtime-seam' });
});

test('a runtime that declares no cancellation gets an honest {propagated:false} — never a fake cancel', () => {
  const registry = freshRegistry();
  const sim = createSimulatedRuntime({ runtimeId: 'sim-nocancel', supports: { cancellation: false } });
  registry.register(sim.declaration());
  const adapter = createRuntimeAdapter({ registry, runtimeId: 'sim-nocancel', runtime: sim, now: tickClock(), newId: counterIds('adv') });
  const signal = adapter.signalCancellation({ machineId: 'mach-nc' });
  assert.equal(signal.propagated, false);
  assert.equal(signal.reason, 'missing-capability');
  assert.deepEqual(sim.cancelledMachines(), []);
  assert.equal(adapter.eligible({ capability: 'cancellation' }).reason, 'missing-capability');
});

test('the harness is deterministic: identical scenarios over identical injections produce identical results', () => {
  const scenario = {
    scenarioId: 'sc-determinism',
    operations: [
      { op: 'create', input: { machineId: 'mach-det', taskId: 'task-det', agentId: 'agent-det', executorKind: 'EXTERNAL', budgets: { ...BUDGETS } } },
      { op: 'prepare', input: { machineId: 'mach-det', expectedVersion: 1 } },
      { op: 'start', input: { machineId: 'mach-det', expectedVersion: 2 } },
      { op: 'advance', ms: 500 },
      { op: 'forwardEvent', type: 'runtime.connected', correlationId: 'fixed-1' },
      { op: 'cancel', input: { machineId: 'mach-det', expectedVersion: 3 } },
    ],
    expected: { lifecycle: { 'mach-det': 'cancelled' }, errors: [], events: ['runtime.connected'] },
  };
  const runOnce = () => {
    const { harness, adapter } = harnessOf();
    const result = harness.run(scenario);
    return {
      ok: result.ok,
      actual: JSON.parse(JSON.stringify({ ...result.actual, lastForward: undefined })),
      records: JSON.parse(JSON.stringify(adapter.manager().describe({ machineId: 'mach-det' }))),
    };
  };
  const first = runOnce();
  const second = runOnce();
  assert.equal(first.ok, true);
  assert.deepEqual(second, first, 'clock, ids, response order — everything is injected; nothing races');
});

test('harness rejects unknown operations and undeclarative scenarios without branching on test specifics', () => {
  const { harness } = harnessOf();
  const result = harness.run({
    scenarioId: 'sc-unknown-op',
    operations: [{ op: 'launchMissiles', target: 'x' }],
    expected: { errors: [{ op: 'launchMissiles', code: 'lego.contract_violation' }] },
  });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.throws(() => harness.run({ scenarioId: 'sc-empty', operations: [] }), (e) => e instanceof RuntimeAdapterError);
  assert.throws(() => harness.run({ operations: [{ op: 'advance', ms: 1 }] }), (e) => e instanceof RuntimeAdapterError);
});

/* --------------------------------------------- §41 security & scope proofs */

test('the module imports only the contract host, vocabulary and node:crypto — no authority surface', () => {
  const imports = [...MODULE_SRC.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./agent-machine.mjs', './ai-foundation.mjs', 'node:crypto']);
  const forbidden = [
    /from\s+'node:(child_process|fs|net|http|https|tls|dgram|dns|worker_threads)'/,
    /from\s+['"]node:fs['"]/, /\bexec(File|Sync)?\s*\(/, /\bspawn(Sync)?\s*\(/,
    /setTimeout\s*\(/, /setInterval\s*\(/, /fetch\s*\(/, /WebSocket/,
    /McpHttpClient|McpServer|McpClient|@modelcontextprotocol/i,
    /openai|anthropic|completions?|promptTemplate/i,
    /from\s+'\.\/(approval|audit|artifact|transport-kernel|envelope|interaction|agent-machine-runtime)\.mjs'/,
  ];
  for (const re of forbidden) assert.ok(!re.test(MODULE_SRC), `forbidden surface matched: ${re}`);
});

test('registration and events never carry credentials, endpoints, commands or hidden reasoning', () => {
  const registry = freshRegistry();
  const record = registry.register({
    runtimeId: 'run-safe', contract: ADAPTER_RUNTIME_CONTRACT, executorKinds: ['EXTERNAL'],
    capabilities: ['cancellation'], locality: 'in-process', providerId: 'prov-safe',
    credential: 'ghp_abcdefghijklmnop', endpoint: 'https://internal', command: 'rm -rf /',
  });
  const flat = JSON.stringify(record);
  assert.ok(!('credential' in record) && !('endpoint' in record) && !('command' in record),
    'unknown fields are never copied into the declaration');
  assert.ok(!/ghp_|Bearer |sk-|password/i.test(flat));
  const registry2 = freshRegistry();
  assert.throws(() => registry2.register({
    runtimeId: 'run-leak', contract: ADAPTER_RUNTIME_CONTRACT, executorKinds: ['EXTERNAL'],
    capabilities: ['cancellation'], locality: 'in-process', providerId: 'Bearer abc.def.ghi',
  }), (e) => e instanceof RuntimeAdapterError && /secret-shaped/.test(e.message));
  const { adapter } = wired();
  assert.throws(() => adapter.forwardEvent({ type: 'runtime.connected', detail: 'token ghp_abcdefghijklmnop' }),
    (e) => e instanceof RuntimeAdapterError && /secret-shaped/.test(e.message));
});

test('the adapter grants no permissions and leaks no hidden reasoning into records or events', () => {
  const { adapter } = wired();
  const machine = adapter.manager().create({ machineId: 'mach-sec', taskId: 'task-sec', agentId: 'agent-sec', budgets: { ...BUDGETS }, metadata: { label: 'clean' } });
  const flat = JSON.stringify(machine);
  assert.ok(!/chain-of-thought|hidden[-_]?prompt|reasoning|"permissions"|"grants"/i.test(flat));
  adapter.forwardEvent({ type: 'runtime.connected', detail: 'connected' });
  const eventFlat = JSON.stringify(adapter.outbox());
  assert.ok(!/chain-of-thought|hidden[-_]?prompt|"reasoning"/i.test(eventFlat));
  assert.deepEqual([...RUNTIME_ADAPTER_PERMISSIONS], ['ai:adapter:read', 'ai:adapter:register', 'ai:adapter:dispatch'],
    'the adapter declares its own permissions — it never hands out ai:agent:* authority');
});

test('the public export surface is exactly the published lock list — no hidden helper', () => {
  const surface = Object.keys({
    RUNTIME_ADAPTER_CONTRACT: 1, RUNTIME_ADAPTER_CONTRACT_VERSION: 1, RUNTIME_ADAPTER_FIELDS: 1,
    RUNTIME_ADAPTER_OPERATIONS: 1, RUNTIME_ADAPTER_PERMISSIONS: 1, ADAPTER_CAPABILITIES: 1,
    ADAPTER_LOCALITIES: 1, ADAPTER_EXECUTOR_KINDS: 1, ADAPTER_AGENT_MACHINE_VERSION: 1,
    ADAPTER_RUNTIME_CONTRACT: 1, ADAPTER_AVAILABILITIES: 1, RUNTIME_LIFECYCLE_TRANSLATION: 1,
    ADAPTER_LIMITS: 1, RuntimeAdapterError: 1, createRuntimeRegistry: 1, createRuntimeAdapter: 1,
    createSimulatedRuntime: 1, createAdapterHarness: 1,
  });
  const row = LOCK.contracts.find((r) => r.id === 'ai.runtime-adapter');
  assert.deepEqual(row.exports['src/lego/runtime-adapter.mjs'].slice().sort(), surface.sort());
});
