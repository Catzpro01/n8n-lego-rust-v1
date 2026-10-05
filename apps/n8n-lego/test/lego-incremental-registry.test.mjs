/**
 * P6.13 — Incremental registry compilation + the discovery/runtime split.
 * Contract `registry.incremental@0.1.0`.
 *
 * Matrix: the plan as a value, the reuse ledger with its digest-stability claim,
 * the EQUIVALENCE PROOF against a full compile (the reason the cheaper path is
 * trustworthy), removals as data rather than tombstones, the two views and the
 * facts each one is not allowed to carry, and the scope walls.
 *
 * Epochs are real: P6.2 compiles them from P6.1 declarations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileRegistryEpoch } from '../src/lego/registry-compiler.mjs';
import {
  CHANGE_KINDS,
  DISCOVERY_FIELDS,
  INCREMENTAL_REGISTRY_CONTRACT,
  INCREMENTAL_REGISTRY_CONTRACT_VERSION,
  INCREMENTAL_REGISTRY_INPUT_SCHEMA_VERSION,
  INCREMENTAL_REGISTRY_OPERATIONS,
  INCREMENTAL_REGISTRY_PERMISSIONS,
  INCREMENTAL_REGISTRY_REASONS,
  INCREMENTAL_REGISTRY_RULES,
  INCREMENTAL_REGISTRY_SCHEMA_VERSION,
  IncrementalRegistryError,
  REGISTRY_VIEWS,
  RUNTIME_FIELDS,
  applyRegistryChanges,
  createIncrementalState,
  describeIncremental,
  explainIncremental,
  isEpochView,
  isIncrementalState,
  planRegistryChanges,
  projectEpochView,
  registryCompilerIdentity,
  reuseReport,
  verifyEpochView,
  verifyIncremental,
} from '../src/lego/incremental-registry.mjs';

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

const BASE = [
  declaration('n8n-nodes-base.httpRequest', 4.4),
  declaration('n8n-nodes-base.set', 3.4),
  declaration('n8n-nodes-base.if', 2.2),
];
const SLACK = declaration('n8n-nodes-base.slack', 2.1);
const EPOCH = compileRegistryEpoch({ declarations: BASE, source: 'p6.13-test' });
const state = () => createIncrementalState(EPOCH);
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

test('the contract identifies itself, is versioned and declares its operations', () => {
  assert.equal(INCREMENTAL_REGISTRY_CONTRACT, 'registry.incremental@0.1.0');
  assert.equal(INCREMENTAL_REGISTRY_CONTRACT_VERSION, '0.1.0');
  assert.equal(INCREMENTAL_REGISTRY_SCHEMA_VERSION, 1);
  assert.equal(INCREMENTAL_REGISTRY_INPUT_SCHEMA_VERSION, 1);
  assert.deepEqual([...INCREMENTAL_REGISTRY_OPERATIONS], ['plan', 'apply', 'verify', 'project', 'describe']);
  assert.deepEqual([...INCREMENTAL_REGISTRY_PERMISSIONS], ['node:read']);
  assert.deepEqual([...CHANGE_KINDS], ['added', 'recompiled', 'reused', 'removed']);
  assert.deepEqual([...REGISTRY_VIEWS], ['discovery', 'runtime']);
  assert.deepEqual([...DISCOVERY_FIELDS], ['identity', 'type', 'typeVersion', 'displayName', 'group', 'description', 'capabilities', 'trustClass']);
  assert.deepEqual([...RUNTIME_FIELDS], ['identity', 'digest', 'runtimeLocality', 'capabilities', 'resourceProfile']);
  for (const reason of INCREMENTAL_REGISTRY_REASONS) assert.match(reason, /^registry\.incremental\.[a-z_]+$/);
  assert.equal(Object.isFrozen(INCREMENTAL_REGISTRY_RULES), true);
  assert.match(INCREMENTAL_REGISTRY_RULES.equivalence, /guess with better latency/);
  assert.match(INCREMENTAL_REGISTRY_RULES.reuse, /byte for byte/);
  assert.deepEqual({ ...registryCompilerIdentity() }, { contract: 'registry.compiler@0.1.0', version: '0.1.0' });
});

/* --------------------------------------------------------------------- state */

test('a state adopts an epoch: its declarations, their digests, its number', () => {
  const subject = state();
  assert.equal(isIncrementalState(subject), true);
  assert.equal(subject.epochNumber, EPOCH.epochNumber);
  assert.equal(subject.epochDigest, EPOCH.epochDigest);
  assert.deepEqual(Object.keys(subject.declarations), [...EPOCH.identities].sort());
  assert.equal(subject.digests['n8n-nodes-base.set@3.4'], EPOCH.byIdentity['n8n-nodes-base.set@3.4'].digest);
  assert.deepEqual([...subject.changes], []);
  assert.equal(Object.isFrozen(subject), true);
  assert.equal(Object.isFrozen(subject.declarations), true);
  throwsWith(() => createIncrementalState({ epochNumber: 1 }), 'registry.incremental.epoch');
  throwsWith(() => createIncrementalState(null), 'registry.incremental.epoch');
  throwsWith(() => planRegistryChanges({}, []), 'lego.contract_violation');
  throwsWith(() => reuseReport({}), 'lego.contract_violation');
});

/* ---------------------------------------------------------------------- plan */

test('the plan is a value: added, changed, reused, removed', () => {
  const added = planRegistryChanges(state(), [...BASE, SLACK]);
  assert.equal(added.ok, true);
  assert.deepEqual([...added.added], ['n8n-nodes-base.slack@2.1']);
  assert.deepEqual([...added.reused], ['n8n-nodes-base.httpRequest@4.4', 'n8n-nodes-base.if@2.2', 'n8n-nodes-base.set@3.4']);
  assert.deepEqual([...added.changed], []);
  assert.deepEqual([...added.removed], []);
  assert.equal(added.unchanged, false);
  assert.equal(added.desiredCount, 4);

  const changed = planRegistryChanges(state(), [BASE[0], declaration('n8n-nodes-base.set', 3.4, { trustClass: 'community' }), BASE[2]]);
  assert.deepEqual([...changed.changed], ['n8n-nodes-base.set@3.4']);
  assert.deepEqual([...changed.reused], ['n8n-nodes-base.httpRequest@4.4', 'n8n-nodes-base.if@2.2']);

  const removed = planRegistryChanges(state(), [BASE[0], BASE[1]]);
  assert.deepEqual([...removed.removed], ['n8n-nodes-base.if@2.2']);
  assert.equal(planRegistryChanges(state(), BASE).unchanged, true);

  const duplicated = planRegistryChanges(state(), [BASE[0], BASE[0]]);
  assert.equal(duplicated.ok, false);
  assert.equal(duplicated.reason, 'registry.incremental.input');
  assert.match(duplicated.message, /refuses duplicates/);
  throwsWith(() => planRegistryChanges(state(), 'nope'), 'registry.incremental.input');
  throwsWith(() => planRegistryChanges(state(), [{ type: 'n8n-nodes-base.set' }]), 'registry.incremental.input');
});

/* --------------------------------------------------------------------- apply */

test('an incremental compile produces the next epoch and a reuse ledger', () => {
  const result = applyRegistryChanges(state(), { declarations: [...BASE, SLACK], epochNumber: 2, source: 'add-slack' });
  assert.equal(result.ok, true);
  assert.equal(result.epoch.epochNumber, 2);
  assert.equal(result.epoch.count, 4);
  assert.equal(result.ledger.added, 1);
  assert.equal(result.ledger.reused, 3);
  assert.equal(result.ledger.recompiled, 0);
  assert.equal(result.ledger.removed, 0);
  assert.equal(result.ledger.reusedDigestStable, true);
  assert.deepEqual([...result.ledger.divergent], []);
  const reused = result.ledger.changes.filter((change) => change.kind === 'reused');
  assert.equal(reused.length, 3);
  for (const change of reused) {
    assert.equal(change.previousDigest, change.digest, 'a reused identity keeps the digest it had');
    assert.equal(change.reusedDigest, true);
  }
  const identities = result.ledger.changes.map((change) => change.identity);
  assert.deepEqual(identities, [...identities].sort());
  assert.equal(Object.isFrozen(result.ledger.changes), true);
  assert.equal(result.state.epochNumber, 2);
  assert.equal(result.state.changes.length, 4);
  assert.equal(result.state.digests['n8n-nodes-base.set@3.4'], state().digests['n8n-nodes-base.set@3.4']);
});

test('recompiles and removals are named, and an unchanged set is refused as noise', () => {
  const recompiled = applyRegistryChanges(state(), {
    declarations: [BASE[0], declaration('n8n-nodes-base.set', 3.4, { trustClass: 'community' }), BASE[2]],
    epochNumber: 2, source: 'retrust-set',
  });
  assert.equal(recompiled.ledger.recompiled, 1);
  assert.equal(recompiled.ledger.changes.find((change) => change.kind === 'recompiled').identity, 'n8n-nodes-base.set@3.4');
  assert.equal(recompiled.state.declarations['n8n-nodes-base.set@3.4'].trustClass, 'community');

  const removed = applyRegistryChanges(state(), { declarations: [BASE[0], BASE[1]], epochNumber: 2, source: 'drop-if' });
  assert.equal(removed.ledger.removed, 1);
  assert.equal(removed.state.declarations['n8n-nodes-base.if@2.2'], undefined);
  assert.equal(removed.epoch.count, 2);

  const noop = applyRegistryChanges(state(), { declarations: BASE, epochNumber: 2, source: 'noop' });
  assert.equal(noop.ok, false);
  assert.equal(noop.reason, 'registry.incremental.unchanged');
  assert.match(noop.message, /noise/);
  assert.equal(noop.epoch, null);
});

test('the epoch number must increase, the source must be named, and refusals keep one shape', () => {
  throwsWith(() => applyRegistryChanges(state(), { declarations: [...BASE, SLACK], epochNumber: EPOCH.epochNumber, source: 's' }), 'registry.incremental.number');
  throwsWith(() => applyRegistryChanges(state(), { declarations: [...BASE, SLACK], epochNumber: 1.5, source: 's' }), 'registry.incremental.number');
  throwsWith(() => applyRegistryChanges(state(), { declarations: [...BASE, SLACK], epochNumber: 2 }), 'registry.incremental.input');
  const refused = applyRegistryChanges(state(), { declarations: [SLACK, SLACK], epochNumber: 2, source: 'dup' });
  assert.equal(refused.ok, false);
  assert.equal(refused.epoch, null);
  assert.equal(refused.reason, 'registry.incremental.input');
  assert.equal(typeof refused.message, 'string');
  assert.equal(Object.isFrozen(refused), true);
});

/* -------------------------------------------------------------- equivalence */

test('an incremental epoch equals a full compile of the same declarations', () => {
  const applied = applyRegistryChanges(state(), { declarations: [...BASE, SLACK], epochNumber: 2, source: 'add-slack' });
  const verdict = verifyIncremental(applied.state, [...BASE, SLACK], { epochNumber: 2, source: 'add-slack' });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.equivalent, true);
  assert.equal(verdict.expected, verdict.actual);
  assert.equal(verdict.expected, applied.epoch.epochDigest);
  assert.equal(verdict.message, null);

  const different = verifyIncremental(applied.state, BASE, { epochNumber: 2, source: 'add-slack' });
  assert.equal(different.ok, false);
  assert.equal(different.equivalent, false);
  assert.equal(different.reason, 'registry.incremental.equivalence');
  assert.match(different.message, /not a path/);

  const otherNumber = verifyIncremental(applied.state, [...BASE, SLACK], { epochNumber: 3, source: 'add-slack' });
  assert.equal(otherNumber.reason, 'registry.incremental.number');

  const impossible = verifyIncremental(applied.state, [{ type: 'x' }], { epochNumber: 2, source: 'add-slack' });
  assert.equal(impossible.ok, false);
  assert.equal(impossible.equivalent, false);
  throwsWith(() => verifyIncremental(applied.state, 'nope'), 'registry.incremental.input');
});

test('the reuse report measures what the cheaper path actually saved', () => {
  const applied = applyRegistryChanges(state(), { declarations: [...BASE, SLACK], epochNumber: 2, source: 'add-slack' });
  const report = reuseReport(applied.state);
  assert.equal(report.byKind.added, 1);
  assert.equal(report.byKind.reused, 3);
  assert.equal(report.total, 4);
  assert.equal(report.touched, 1);
  assert.equal(Math.abs(report.reuseRatio - 0.75) < 1e-9, true);
  assert.equal(report.reusedDigestStable, true);
  assert.deepEqual([...report.reusedIdentities], ['n8n-nodes-base.httpRequest@4.4', 'n8n-nodes-base.if@2.2', 'n8n-nodes-base.set@3.4']);
  const adopted = reuseReport(state());
  assert.equal(adopted.total, 0);
  assert.equal(adopted.reuseRatio, null, 'nothing was compiled, so nothing was saved: null, not a flattering 1.0');
});

/* -------------------------------------------------------------------- views */

test('the discovery view carries metadata and never the bytes', () => {
  const view = projectEpochView(EPOCH, 'discovery');
  assert.equal(isEpochView(view), true);
  assert.equal(view.view, 'discovery');
  assert.equal(view.epochDigest, EPOCH.epochDigest);
  assert.equal(view.count, 3);
  assert.deepEqual([...view.fields], ['identity', 'type', 'typeVersion', 'displayName', 'group', 'description', 'capabilities', 'trustClass']);
  for (const entry of view.entries) {
    assert.equal(typeof entry.displayName, 'string');
    assert.equal(entry.digest, undefined, 'an editor does not need the bytes');
    assert.equal(entry.resourceProfile, undefined, 'an editor does not need the resource profile');
    assert.equal(entry.runtimeLocality, undefined);
  }
  assert.match(view.viewDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(view.entries), true);
});

test('the runtime view carries execution facts and never the prose', () => {
  const view = projectEpochView(EPOCH, 'runtime');
  assert.equal(view.view, 'runtime');
  assert.deepEqual([...view.fields], ['identity', 'digest', 'runtimeLocality', 'capabilities', 'resourceProfile']);
  for (const entry of view.entries) {
    assert.equal(typeof entry.digest, 'string');
    assert.equal(typeof entry.runtimeLocality, 'string');
    assert.equal(entry.displayName, undefined, 'a worker does not need the prose');
    assert.equal(entry.group, undefined);
    assert.equal(entry.description, undefined);
  }
  const set = view.entries.find((entry) => entry.identity === 'n8n-nodes-base.set@3.4');
  assert.equal(set.digest, EPOCH.byIdentity['n8n-nodes-base.set@3.4'].digest);
  assert.equal(set.resourceProfile.cpu, 'low');
});

test('a view is a projection of one epoch, and both directions are checkable', () => {
  const discovery = projectEpochView(EPOCH, 'discovery');
  const runtime = projectEpochView(EPOCH, 'runtime');
  assert.notEqual(discovery.viewDigest, runtime.viewDigest, 'two projections of one epoch are two documents');
  assert.equal(verifyEpochView(discovery, EPOCH).ok, true);
  assert.equal(verifyEpochView(runtime, EPOCH).ok, true);
  const second = compileRegistryEpoch({ declarations: [...BASE, SLACK], epochNumber: 2, source: 'p6.13-test' });
  const stale = verifyEpochView(discovery, second);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'registry.incremental.view');
  assert.match(stale.message, /not a projection of anything|does not match this epoch/);
  throwsWith(() => projectEpochView(EPOCH, 'vibes'), 'registry.incremental.view');
  throwsWith(() => projectEpochView({ ok: true }, 'runtime'), 'registry.incremental.epoch');
  throwsWith(() => verifyEpochView({ ok: true }, EPOCH), 'registry.incremental.view');
  const identities = discovery.entries.map((entry) => entry.identity);
  assert.deepEqual(identities, [...identities].sort());
});

/* ------------------------------------------------------------ reads, guards */

test('describing and explaining an incremental epoch reports what it cost', () => {
  const applied = applyRegistryChanges(state(), { declarations: [...BASE, SLACK], epochNumber: 2, source: 'add-slack' });
  const described = describeIncremental(applied.state);
  assert.equal(described.nodeCount, 4);
  assert.equal(described.byKind.added, 1);
  assert.equal(described.byKind.reused, 3);
  assert.equal(described.reusedDigestStable, true);
  assert.equal(described.source, 'add-slack');
  assert.equal(Object.isFrozen(described), true);
  assert.match(explainIncremental(applied.state), /3 reused/);
  assert.match(explainIncremental(applied), /incremental compile accepted/);
  assert.match(explainIncremental(applied), /digests stable: true/);
  const noop = applyRegistryChanges(state(), { declarations: BASE, epochNumber: 2, source: 'noop' });
  assert.match(explainIncremental(noop), /nothing changed/);
  throwsWith(() => explainIncremental({ nope: true }), 'lego.contract_violation');
  throwsWith(() => explainIncremental(null), 'lego.contract_violation');
});

test('the error type is exported, and a refusal is data rather than an exception', () => {
  const error = new IncrementalRegistryError('x');
  assert.equal(error instanceof Error, true);
  assert.equal(error.code, 'lego.contract_violation');
  assert.equal(Object.isFrozen(error.meta), true);
  assert.doesNotThrow(() => applyRegistryChanges(state(), { declarations: BASE, epochNumber: 2, source: 'noop' }));
  assert.doesNotThrow(() => verifyIncremental(state(), [{ type: 'x' }], { epochNumber: 2, source: 's' }));
});

/* ---------------------------------------------------------------- scope walls */

test('P6.13 is pure: the only node import is the hash, and there is no I/O', () => {
  const source = readFileSync(new URL('../src/lego/incremental-registry.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.', 'fetch(']) {
    assert.equal(code.includes(forbidden), false, `the incremental registry must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false);
  assert.ok(code.includes("from './registry-compiler.mjs'"), 'the compiler is reused, not re-implemented');
});

test('P6.13 stays inside its walls: compile only, never publish, roll back or serve', () => {
  const source = readFileSync(new URL('../src/lego/incremental-registry.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['publishRegistryEpoch(', 'rollbackRegistryEpoch(', 'freezeRegistryEpoch(', 'node-residency', 'runtime-lease', 'node-health', 'node-lifecycle', 'resolution-manifest', 'supply-chain', 'capability-compiler', 'spawn', 'node:vm']) {
    assert.equal(code.includes(forbidden), false, `P6.13 must not reach into ${forbidden}: publishing and serving belong to other contracts`);
  }
  assert.match(INCREMENTAL_REGISTRY_RULES.authority, /not publishing one/);
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'registry.incremental');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, INCREMENTAL_REGISTRY_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/incremental-registry.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-incremental-registry.test.mjs']);
  for (const name of ['createIncrementalState', 'planRegistryChanges', 'applyRegistryChanges', 'verifyIncremental', 'projectEpochView', 'verifyEpochView']) {
    assert.equal(rows[0].exports['src/lego/incremental-registry.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'registry.compiler', 'package.transaction', 'registry.closure', 'node.resolution', 'runtime.lease', 'node.residency', 'node.capability', 'node.semantics', 'node.lifecycle', 'node.health', 'node.supply-chain']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.13 must not re-version ${id}`);
  }
  assert.equal(
    lock.contracts.find((contract) => contract.id === 'registry.compiler').version,
    '0.1.0',
    'P6.13 adds a contract instead of bumping the compiler: the compiler\'s job did not change',
  );
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/incremental-registry.mjs'));
});
