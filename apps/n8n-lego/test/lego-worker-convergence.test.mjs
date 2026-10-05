/**
 * P6.14 — Worker registry convergence + handshake.
 * Contract `node.worker-convergence@0.1.0`.
 *
 * Matrix: the four decisions and no fifth, the behind/divergent distinction (the
 * reason this contract exists), the ahead-is-not-an-upgrade rule, the view rule
 * that makes MATCH meaningful to a pool, the plan as ordered data, the fleet view,
 * and the scope walls.
 *
 * Epochs are real: P6.2 compiles them and P6.13 projects their runtime view.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileRegistryEpoch } from '../src/lego/registry-compiler.mjs';
import { projectEpochView } from '../src/lego/incremental-registry.mjs';
import {
  CONVERGENCE_DECISIONS,
  CONVERGENCE_STEPS,
  WORKER_CONVERGENCE_CONTRACT,
  WORKER_CONVERGENCE_CONTRACT_VERSION,
  WORKER_CONVERGENCE_INPUT_SCHEMA_VERSION,
  WORKER_CONVERGENCE_OPERATIONS,
  WORKER_CONVERGENCE_PERMISSIONS,
  WORKER_CONVERGENCE_REASONS,
  WORKER_CONVERGENCE_RULES,
  WORKER_CONVERGENCE_SCHEMA_VERSION,
  WorkerConvergenceError,
  convergeWorker,
  coordinatorBinding,
  describeFleet,
  explainHandshake,
  handshake,
  isWorkerBinding,
  workerBinding,
} from '../src/lego/worker-convergence.mjs';

/* ------------------------------------------------------------------ fixtures */

const declaration = (type, typeVersion, overrides = {}) => ({
  type,
  typeVersion,
  package: type.split('.')[0],
  packageVersion: '1.0.0',
  vendor: 'n8n',
  contractVersion: '0.1.0',
  implementationVersion: '0.1.0',
  digest: `sha256:${'a'.repeat(64)}`,
  provenance: { kind: 'package-registry', source: 'npm:n8n-nodes-base@1.0.0' },
  capabilities: ['network'],
  trustClass: 'core',
  runtimeLocality: 'js-compat',
  resourceProfile: { cpu: 'low', memory: 'medium', disk: 'none', network: true, concurrency: 'parallel-safe', startup: 'fast' },
  compatibility: { contractRange: '^0.1.0', portabilityTargets: ['JS'] },
  lifecycle: 'declared',
  health: 'unknown',
  discovery: { displayName: type, group: 'transform', description: `about ${type}` },
  ...overrides,
});

const SET = declaration('n8n-nodes-base.set', 3.4);
const IF = declaration('n8n-nodes-base.if', 2.2);
const SLACK = declaration('n8n-nodes-base.slack', 2.1);
const EPOCH_1 = compileRegistryEpoch({ declarations: [SET, IF], source: 'p6.14-test-1' });
const EPOCH_2 = compileRegistryEpoch({ declarations: [SET, IF, SLACK], epochNumber: 2, source: 'p6.14-test-2' });
const COORDINATOR = coordinatorBinding(EPOCH_2);
const digestsOf = (epoch) => Object.fromEntries(epoch.identities.map((identity) => [identity, epoch.byIdentity[identity].digest]));
const viewDigestOf = (epoch, view = 'runtime') => projectEpochView(epoch, view).viewDigest;

const bindingFor = (epoch, overrides = {}) => workerBinding({
  workerId: 'worker-1',
  epochNumber: epoch.epochNumber,
  epochDigest: epoch.epochDigest,
  runtimeViewDigest: viewDigestOf(epoch),
  identityDigests: digestsOf(epoch),
  ...overrides,
});

const codeOf = (error) => [error.code, error.meta?.code, error.meta?.field].filter(Boolean);
const throwsWith = (fn, codes) => {
  const want = [].concat(codes);
  assert.throws(fn, (error) => {
    assert.ok(
      codeOf(error).some((code) => want.includes(code)),
      `expected ${want.join('|')}, got ${codeOf(error).join('|')}: ${error.message}`,
    );
    return true;
  });
};

/* ---------------------------------------------------------- contract surface */

test('the contract identifies itself: four decisions, seven steps, no fifth answer', () => {
  assert.equal(WORKER_CONVERGENCE_CONTRACT, 'node.worker-convergence@0.1.0');
  assert.equal(WORKER_CONVERGENCE_CONTRACT_VERSION, '0.1.0');
  assert.equal(WORKER_CONVERGENCE_SCHEMA_VERSION, 1);
  assert.equal(WORKER_CONVERGENCE_INPUT_SCHEMA_VERSION, 1);
  assert.deepEqual([...WORKER_CONVERGENCE_OPERATIONS], ['bind', 'handshake', 'converge', 'describe']);
  assert.deepEqual([...WORKER_CONVERGENCE_PERMISSIONS], ['node:read']);
  assert.deepEqual([...CONVERGENCE_DECISIONS], ['MATCH', 'UPGRADE_REQUIRED', 'MISMATCH', 'UNAVAILABLE']);
  assert.equal(CONVERGENCE_STEPS.length, 7);
  for (const reason of WORKER_CONVERGENCE_REASONS) assert.match(reason, /^convergence\.[a-z_]+$/, 'the reasons live in this contract\'s own namespace, not the worker domain\'s error namespace');
  assert.equal(Object.isFrozen(WORKER_CONVERGENCE_RULES), true);
  assert.match(WORKER_CONVERGENCE_RULES.behind, /correctness or supply-chain problem/);
  assert.match(WORKER_CONVERGENCE_RULES.ahead, /higher|HIGHER/);
  assert.match(WORKER_CONVERGENCE_RULES.view, /no view reported/);
  assert.match(WORKER_CONVERGENCE_RULES.authority, /never permission to serve/);
});

/* ------------------------------------------------------------------ binding */

test('a coordinator binding is an epoch flattened into comparable digests', () => {
  assert.equal(COORDINATOR.epochNumber, 2);
  assert.equal(COORDINATOR.epochDigest, EPOCH_2.epochDigest);
  assert.equal(COORDINATOR.coordinatorId, 'registry');
  assert.equal(COORDINATOR.identityDigests['n8n-nodes-base.set@3.4'], EPOCH_2.byIdentity['n8n-nodes-base.set@3.4'].digest);
  assert.deepEqual([...COORDINATOR.identities], [...EPOCH_2.identities].sort());
  assert.equal(COORDINATOR.runtimeViewDigest, viewDigestOf(EPOCH_2));
  assert.equal(Object.isFrozen(COORDINATOR.identityDigests), true);
  assert.equal(coordinatorBinding(EPOCH_2, { coordinatorId: 'edge-a' }).coordinatorId, 'edge-a');
  throwsWith(() => coordinatorBinding({ epochNumber: 1 }), 'convergence.epoch');
  throwsWith(() => coordinatorBinding(EPOCH_2, { coordinatorId: '  ' }), 'convergence.input');
});

test('a worker binding is data, digested, and accepts the epoch digest as published', () => {
  const binding = bindingFor(EPOCH_1);
  assert.equal(isWorkerBinding(binding), true);
  assert.equal(binding.workerId, 'worker-1');
  assert.equal(binding.epochDigest, EPOCH_1.epochDigest, 'registry.compiler publishes a bare 64-hex epoch digest and the binding keeps that form');
  assert.match(binding.epochDigest, /^[0-9a-f]{64}$/);
  assert.match(binding.bindingDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(binding.runtimeViewDigest, viewDigestOf(EPOCH_1));
  assert.equal(Object.isFrozen(binding), true);
  const prefixed = workerBinding({ workerId: 'w', epochNumber: 1, epochDigest: `sha256:${EPOCH_1.epochDigest}`, identityDigests: digestsOf(EPOCH_1) });
  assert.equal(prefixed.epochDigest, EPOCH_1.epochDigest, 'either spelling is accepted, the epoch\'s own form is stored');
  assert.equal(
    workerBinding({ workerId: 'w', epochNumber: 1, epochDigest: EPOCH_1.epochDigest, identityDigests: digestsOf(EPOCH_1) }).bindingDigest,
    prefixed.bindingDigest,
    'the same worker binds the same way however the digest was spelled',
  );
  throwsWith(() => workerBinding({ workerId: '', epochNumber: 1, epochDigest: EPOCH_1.epochDigest }), 'convergence.binding');
  throwsWith(() => workerBinding({ workerId: 'w', epochNumber: 0, epochDigest: EPOCH_1.epochDigest }), 'convergence.binding');
  throwsWith(() => workerBinding({ workerId: 'w', epochNumber: 1, epochDigest: 'epoch-1' }), 'convergence.binding');
  throwsWith(() => workerBinding({ workerId: 'w', epochNumber: 1, epochDigest: EPOCH_1.epochDigest, identityDigests: { x: 'nope' } }), 'convergence.binding');
  throwsWith(() => workerBinding({ workerId: 'w', epochNumber: 1, epochDigest: EPOCH_1.epochDigest, runtimes: 'JS' }), 'convergence.binding');
  throwsWith(() => handshake({}, COORDINATOR), 'lego.contract_violation');
  throwsWith(() => handshake(binding, {}), 'convergence.binding');
});

/* ------------------------------------------------------------------- MATCH */

test('MATCH means nothing to bring forward: no steps at all', () => {
  const outcome = handshake(bindingFor(EPOCH_2, { workerId: 'worker-fresh' }), COORDINATOR);
  assert.equal(outcome.decision, 'MATCH');
  assert.equal(outcome.ok, true);
  assert.deepEqual([...outcome.steps], []);
  assert.equal(outcome.workerId, 'worker-fresh');
  assert.match(explainHandshake(outcome), /nothing to do/);
});

test('MATCH requires the epoch AND the reported runtime view', () => {
  const noView = bindingFor(EPOCH_2, { runtimeViewDigest: null });
  const outcome = handshake(noView, COORDINATOR);
  assert.equal(outcome.decision, 'UPGRADE_REQUIRED', '"no view reported" is a question, not an agreement');
  assert.equal(outcome.detail.viewReported, false);
  assert.deepEqual(outcome.steps.map((entry) => entry.step), ['request-runtime-view', 'reverify-views']);
  assert.match(outcome.message, /cannot be pooled/);

  const staleView = bindingFor(EPOCH_2, { runtimeViewDigest: viewDigestOf(EPOCH_1) });
  const staleOutcome = handshake(staleView, COORDINATOR);
  assert.equal(staleOutcome.decision, 'UPGRADE_REQUIRED');
  assert.equal(staleOutcome.detail.viewReported, true);
  assert.deepEqual([...staleOutcome.detail.missing], [], 'the epoch is complete; only the view is stale');
});

/* --------------------------------------------------------- UPGRADE_REQUIRED */

test('behind and consistent is the only case that moves a worker forward', () => {
  const outcome = handshake(bindingFor(EPOCH_1, { workerId: 'worker-behind' }), COORDINATOR);
  assert.equal(outcome.decision, 'UPGRADE_REQUIRED');
  assert.equal(outcome.detail.reason, 'convergence.behind');
  assert.equal(outcome.detail.fromEpochNumber, 1);
  assert.equal(outcome.detail.toEpochNumber, 2);
  assert.deepEqual([...outcome.detail.missing], ['n8n-nodes-base.slack@2.1']);
  assert.equal(outcome.detail.shared.length, 2);
  assert.deepEqual(outcome.steps.map((entry) => entry.step), ['apply-registry-changes', 'reverify-views']);
  assert.deepEqual(outcome.steps.map((entry) => entry.order), [0, 1]);
  assert.match(explainHandshake(outcome), /1 identity\(ies\) to bring forward/);
});

test('a worker with nothing loses the delta and asks for the epoch', () => {
  const cold = workerBinding({
    workerId: 'worker-cold', epochNumber: 1, epochDigest: `sha256:${'0'.repeat(64)}`, identityDigests: {},
  });
  const outcome = handshake(cold, COORDINATOR);
  assert.equal(outcome.decision, 'UPGRADE_REQUIRED');
  assert.deepEqual(outcome.steps.map((entry) => entry.step), ['request-full-epoch', 'reverify-views']);
  assert.equal(outcome.detail.missing.length, 3);
});

/* ---------------------------------------------------------------- MISMATCH */

test('an identity the epoch does not contain is divergence, not lag', () => {
  const fabricated = bindingFor(EPOCH_1, {
    workerId: 'worker-fabricated',
    identityDigests: { ...digestsOf(EPOCH_1), 'n8n-nodes-evil.node@1.0': `sha256:${'9'.repeat(64)}` },
  });
  const outcome = handshake(fabricated, COORDINATOR);
  assert.equal(outcome.decision, 'MISMATCH');
  assert.equal(outcome.detail.reason, 'convergence.unknown_identity');
  assert.deepEqual([...outcome.detail.identities], ['n8n-nodes-evil.node@1.0']);
  assert.deepEqual(outcome.steps.map((entry) => entry.step), ['refuse-service', 'escalate-to-operator']);
  assert.match(explainHandshake(outcome), /diverges/);
});

test('one disagreement outranks any amount of lag', () => {
  const divergent = bindingFor(EPOCH_1, {
    workerId: 'worker-divergent',
    epochDigest: `sha256:${'1'.repeat(64)}`,
    identityDigests: { 'n8n-nodes-base.set@3.4': `sha256:${'7'.repeat(64)}`, 'n8n-nodes-base.if@2.2': digestsOf(EPOCH_1)['n8n-nodes-base.if@2.2'] },
  });
  const outcome = handshake(divergent, COORDINATOR);
  assert.equal(outcome.decision, 'MISMATCH');
  assert.equal(outcome.detail.reason, 'convergence.divergence');
  assert.deepEqual([...outcome.detail.identities], ['n8n-nodes-base.set@3.4']);
  assert.match(outcome.message, /however far behind it also happens to be/);
});

test('a worker ahead of the coordinator is a mismatch, not an upgrade', () => {
  const ahead = bindingFor(EPOCH_2, {
    workerId: 'worker-ahead',
    epochNumber: EPOCH_2.epochNumber + 5,
    epochDigest: `sha256:${'2'.repeat(64)}`,
  });
  const outcome = handshake(ahead, COORDINATOR);
  assert.equal(outcome.decision, 'MISMATCH');
  assert.equal(outcome.detail.reason, 'convergence.ahead');
  assert.equal(outcome.detail.workerEpochNumber, EPOCH_2.epochNumber + 5);
  assert.equal(outcome.detail.coordinatorEpochNumber, EPOCH_2.epochNumber);
  assert.match(outcome.message, /rewrite a history without asking why/);
});

test('the same epoch number with a different digest is a contradiction', () => {
  const contradiction = bindingFor(EPOCH_2, { workerId: 'worker-liar', epochDigest: `sha256:${'3'.repeat(64)}` });
  const outcome = handshake(contradiction, COORDINATOR);
  assert.equal(outcome.decision, 'MISMATCH');
  assert.match(outcome.message, /contradiction, not a lag/);
});

/* --------------------------------------------------------------- UNAVAILABLE */

test('UNAVAILABLE is a decision, and it blames the target rather than the worker', () => {
  const worker = bindingFor(EPOCH_1, { workerId: 'worker-waiting' });
  const noTarget = handshake(worker, null);
  assert.equal(noTarget.ok, false);
  assert.equal(noTarget.decision, 'UNAVAILABLE', 'a refusal is still one of the four answers');
  assert.equal(noTarget.reason, 'convergence.unavailable');
  assert.match(noTarget.message, /not because the worker is suspect/);
  assert.deepEqual(noTarget.steps.map((entry) => entry.step), ['refuse-service', 'retry-when-serving']);
  assert.match(explainHandshake(noTarget), /refused/);

  const notServing = handshake(worker, COORDINATOR, { serving: false });
  assert.equal(notServing.decision, 'UNAVAILABLE');
  assert.match(notServing.message, /downgrade nobody asked for/);
});

/* ----------------------------------------------------------------- converge */

test('convergeWorker returns the plan and, only when it applies, the epoch', () => {
  const upgradable = convergeWorker(bindingFor(EPOCH_1, { workerId: 'worker-behind' }), EPOCH_2);
  assert.equal(upgradable.ok, true);
  assert.equal(upgradable.decision, 'UPGRADE_REQUIRED');
  assert.equal(upgradable.epoch, EPOCH_2);
  assert.equal(upgradable.coordinator.epochDigest, EPOCH_2.epochDigest);
  assert.equal(upgradable.outcome.detail.missing.length, 1);

  const matched = convergeWorker(bindingFor(EPOCH_2, { workerId: 'worker-fresh' }), EPOCH_2);
  assert.equal(matched.ok, true);
  assert.equal(matched.decision, 'MATCH');
  assert.equal(matched.epoch, null, 'a match hands back no epoch: there is nothing to send');

  const diverged = convergeWorker(bindingFor(EPOCH_1, {
    workerId: 'worker-divergent',
    identityDigests: { ...digestsOf(EPOCH_1), 'n8n-nodes-evil.node@1.0': `sha256:${'9'.repeat(64)}` },
  }), EPOCH_2);
  assert.equal(diverged.ok, false);
  assert.equal(diverged.decision, 'MISMATCH');
  assert.equal(diverged.epoch, null, 'a divergent worker is never handed an epoch to converge onto');

  const nothing = convergeWorker(bindingFor(EPOCH_1, { workerId: 'worker-waiting' }), null);
  assert.equal(nothing.decision, 'UNAVAILABLE');
  assert.equal(nothing.epoch, null);
  assert.equal(nothing.coordinator, null);
  throwsWith(() => convergeWorker({}, EPOCH_2), 'lego.contract_violation');
});

/* ---------------------------------------------------------------- describe */

test('the fleet view names who needs a human', () => {
  const match = handshake(bindingFor(EPOCH_2, { workerId: 'w-match' }), COORDINATOR);
  const behind = handshake(bindingFor(EPOCH_1, { workerId: 'w-behind' }), COORDINATOR);
  const unknown = handshake(bindingFor(EPOCH_1, {
    workerId: 'w-unknown', identityDigests: { ...digestsOf(EPOCH_1), 'n8n-nodes-evil.node@1.0': `sha256:${'9'.repeat(64)}` },
  }), COORDINATOR);
  const ahead = handshake(bindingFor(EPOCH_2, { workerId: 'w-ahead', epochNumber: 9, epochDigest: `sha256:${'2'.repeat(64)}` }), COORDINATOR);
  const noTarget = handshake(bindingFor(EPOCH_1, { workerId: 'w-nothing' }), null);
  const viewOnly = handshake(bindingFor(EPOCH_2, { workerId: 'w-view', runtimeViewDigest: null }), COORDINATOR);

  const fleet = describeFleet([match, behind, unknown, ahead, noTarget, viewOnly]);
  assert.equal(fleet.workerCount, 6);
  assert.equal(fleet.converged, 1);
  assert.equal(fleet.upgradable, 2);
  assert.equal(fleet.diverged, 2);
  assert.equal(fleet.unavailable, 1);
  assert.deepEqual(fleet.attention.map((entry) => entry.reason), ['convergence.unknown_identity', 'convergence.ahead', 'convergence.unavailable']);
  assert.equal(Object.isFrozen(fleet.attention), true);
  assert.equal(describeFleet([]).workerCount, 0);
  throwsWith(() => describeFleet('nope'), 'convergence.input');
  throwsWith(() => describeFleet([{ decision: 'MAYBE' }]), 'convergence.input');
});

test('the error type is exported, and a refusal is data rather than an exception', () => {
  const error = new WorkerConvergenceError('x');
  assert.equal(error instanceof Error, true);
  assert.equal(error.code, 'lego.contract_violation');
  assert.equal(Object.isFrozen(error.meta), true);
  assert.doesNotThrow(() => handshake(bindingFor(EPOCH_1, { workerId: 'w' }), null));
  assert.doesNotThrow(() => handshake(bindingFor(EPOCH_1, { workerId: 'w' }), COORDINATOR, { serving: false }));
  throwsWith(() => explainHandshake({ nope: true }), 'lego.contract_violation');
  throwsWith(() => explainHandshake(null), 'lego.contract_violation');
});

/* -------------------------------------------------------------- scope walls */

test('P6.14 is pure: the only node import is the hash, and nothing is transported', () => {
  const source = readFileSync(new URL('../src/lego/worker-convergence.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(']) {
    assert.equal(code.includes(forbidden), false, `the handshake must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  assert.ok(code.includes("from './registry-compiler.mjs'"), 'the epoch guard is P6.2\'s, reused');
  assert.ok(code.includes("from './incremental-registry.mjs'"), 'the runtime view is P6.13\'s, reused rather than re-derived');
});

test('P6.14 stays inside its walls: it converges, it does not serve, pool or repair', () => {
  const source = readFileSync(new URL('../src/lego/worker-convergence.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['./runtime-lease.mjs', './node-residency.mjs', './node-health.mjs', './node-lifecycle.mjs', './capability-compiler.mjs', './supply-chain.mjs', 'publishRegistryEpoch(', 'compileRegistryEpoch(', 'spawn', 'node:vm', 'worker_threads']) {
    assert.equal(code.includes(forbidden), false, `P6.14 must not reach into ${forbidden}: leasing, health, pooling and repair belong to other contracts`);
  }
  assert.match(WORKER_CONVERGENCE_RULES.plan, /not a transport/);
});

/* -------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'node.worker-convergence');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, WORKER_CONVERGENCE_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/worker-convergence.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-worker-convergence.test.mjs']);
  for (const name of ['workerBinding', 'coordinatorBinding', 'handshake', 'convergeWorker', 'describeFleet']) {
    assert.equal(rows[0].exports['src/lego/worker-convergence.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'registry.compiler', 'package.transaction', 'registry.closure', 'node.resolution', 'runtime.lease', 'node.residency', 'node.capability', 'node.semantics', 'node.lifecycle', 'node.health', 'node.supply-chain', 'registry.incremental']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.14 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/worker-convergence.mjs'));
});
