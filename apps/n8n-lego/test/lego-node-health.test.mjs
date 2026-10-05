/**
 * P6.11 — Health, crash circuit breaker, quarantine. Contract `node.health@0.1.0`.
 *
 * Matrix: derived states with no clock, the breaker's three states and its
 * bounded doubling, the rule that a success which was NOT allowed to happen
 * proves nothing, quarantine outranking every observation, release returning a
 * node to `unknown` rather than to `healthy`, and the scope walls.
 *
 * Epochs are real: they come from P6.2, built from P6.1 declarations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileRegistryEpoch } from '../src/lego/registry-compiler.mjs';
import {
  CIRCUIT_STATES,
  DEFAULT_COOL_OFF_TICKS,
  DEFAULT_FAILURE_THRESHOLD,
  HEALTH_OUTCOMES,
  HEALTH_STATES,
  MAX_COOL_OFF_TICKS,
  NODE_HEALTH_CONTRACT,
  NODE_HEALTH_CONTRACT_VERSION,
  NODE_HEALTH_INPUT_SCHEMA_VERSION,
  NODE_HEALTH_OPERATIONS,
  NODE_HEALTH_PERMISSIONS,
  NODE_HEALTH_REASONS,
  NODE_HEALTH_RULES,
  NODE_HEALTH_SCHEMA_VERSION,
  NodeHealthError,
  QUARANTINE_ORIGINS,
  createHealthTable,
  describeHealth,
  healthOf,
  isHealthTable,
  isQuarantined,
  mayServe,
  quarantineNode,
  recordObservation,
  releaseQuarantine,
  verifyHealthTable,
} from '../src/lego/node-health.mjs';

/* ------------------------------------------------------------------ fixtures */

const A = 'n8n-nodes-base.httpRequest@4.4';
const B = 'n8n-nodes-base.set@3.4';

const declaration = (type, typeVersion) => ({
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
  discovery: { displayName: type, group: 'transform', description: 'x' },
});

const EPOCH = compileRegistryEpoch({
  declarations: [declaration('n8n-nodes-base.httpRequest', 4.4), declaration('n8n-nodes-base.set', 3.4)],
  source: 'p6.11-test',
});

const table = (options) => createHealthTable(EPOCH, options);
const fail = (subject, identity, tick) => recordObservation(subject, identity, { outcome: 'failure', tick }).table;
const succeed = (subject, identity, tick) => recordObservation(subject, identity, { outcome: 'success', tick }).table;
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
const refuses = (result, reason) => {
  assert.equal(result.ok, false, 'expected a refusal, got ok:true');
  assert.equal(result.reason, reason);
  return result;
};

/* ---------------------------------------------------------- contract surface */

test('the contract identifies itself, is versioned and declares its operations', () => {
  assert.equal(NODE_HEALTH_CONTRACT, 'node.health@0.1.0');
  assert.equal(NODE_HEALTH_CONTRACT_VERSION, '0.1.0');
  assert.equal(NODE_HEALTH_SCHEMA_VERSION, 1);
  assert.equal(NODE_HEALTH_INPUT_SCHEMA_VERSION, 1);
  assert.deepEqual([...NODE_HEALTH_OPERATIONS], ['observe', 'mayServe', 'quarantine', 'release', 'describe']);
  assert.deepEqual([...NODE_HEALTH_PERMISSIONS], ['node:read']);
  assert.deepEqual([...CIRCUIT_STATES], ['closed', 'open', 'half-open']);
  assert.deepEqual([...HEALTH_OUTCOMES], ['success', 'failure']);
  assert.deepEqual([...QUARANTINE_ORIGINS], ['operator', 'breaker', 'policy', 'attestation']);
  assert.equal(DEFAULT_FAILURE_THRESHOLD, 3);
  assert.equal(DEFAULT_COOL_OFF_TICKS, 30);
  assert.ok(MAX_COOL_OFF_TICKS > DEFAULT_COOL_OFF_TICKS);
  for (const reason of NODE_HEALTH_REASONS) assert.match(reason, /^health\.[a-z_]+$/);
  assert.equal(Object.isFrozen(NODE_HEALTH_RULES), true);
  assert.match(NODE_HEALTH_RULES.release, /never to healthy/);
  assert.match(NODE_HEALTH_RULES.noClock, /tick is data/);
});

test('the states are P6.1\'s vocabulary, quoted rather than re-invented', async () => {
  const registry = await import('../src/lego/node-registry.mjs');
  assert.deepEqual([...HEALTH_STATES], [...registry.NODE_HEALTH_STATES]);
  assert.deepEqual([...HEALTH_STATES], ['unknown', 'healthy', 'degraded', 'failing', 'quarantined']);
});

/* --------------------------------------------------------------------- table */

test('a table watches one epoch and starts every node unknown', () => {
  const subject = table();
  assert.equal(isHealthTable(subject), true);
  assert.equal(subject.epochDigest, EPOCH.epochDigest);
  assert.equal(subject.threshold, DEFAULT_FAILURE_THRESHOLD);
  assert.equal(subject.coolOffTicks, DEFAULT_COOL_OFF_TICKS);
  assert.deepEqual(Object.keys(subject.entries), [A, B]);
  assert.deepEqual({ ...healthOf(subject, A) }, {
    identity: A,
    state: 'unknown',
    circuit: 'closed',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastOutcome: null,
    lastTick: null,
    coolOffTicks: null,
    openedAtTick: null,
    quarantine: null,
    releasedAt: null,
    observationCount: 0,
  });
  assert.equal(Object.isFrozen(subject), true);
  assert.equal(typeof subject.tableDigest, 'string');
  assert.equal(verifyHealthTable(subject).ok, true);
  assert.equal(verifyHealthTable(subject, EPOCH).ok, true);
});

test('a table needs a compiled epoch, sane thresholds and known identities', () => {
  throwsWith(() => createHealthTable({ epochNumber: 1 }), 'health.epoch');
  throwsWith(() => createHealthTable(null), 'health.epoch');
  throwsWith(() => table({ threshold: 0 }), 'health.input');
  throwsWith(() => table({ threshold: 1.5 }), 'health.input');
  throwsWith(() => table({ coolOffTicks: 0 }), 'health.input');
  throwsWith(() => healthOf(table(), 'n8n-nodes-base.ghost@1'), 'health.identity');
  throwsWith(() => healthOf({ ok: true }, A), 'lego.contract_violation');
  throwsWith(() => recordObservation(table(), A, { outcome: 'maybe', tick: 1 }), 'health.outcome');
  throwsWith(() => recordObservation(table(), A, { outcome: 'failure' }), 'health.tick');
  throwsWith(() => recordObservation(table(), A, { outcome: 'failure', tick: -1 }), 'health.tick');
  throwsWith(() => mayServe(table(), A, {}), 'health.tick');
});

/* -------------------------------------------------------------- observations */

test('a success makes a node healthy and keeps the observation history', () => {
  const result = recordObservation(table(), A, { outcome: 'success', tick: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'healthy');
  assert.equal(result.circuit, 'closed');
  assert.equal(result.reason, null);
  const entry = healthOf(result.table, A);
  assert.equal(entry.lastOutcome, 'success');
  assert.equal(entry.lastTick, 5);
  assert.equal(entry.observationCount, 1);
  assert.equal(entry.consecutiveSuccesses, 1);
  const twice = recordObservation(result.table, A, { outcome: 'success', tick: 6 });
  assert.equal(healthOf(twice.table, A).consecutiveSuccesses, 2);
  assert.equal(entry.observationCount, 1, 'the table handed in is untouched');
});

test('failures degrade, then open the circuit at the threshold, with the retry tick named', () => {
  const first = recordObservation(table(), A, { outcome: 'failure', tick: 1 });
  assert.equal(first.state, 'degraded');
  assert.equal(first.circuit, 'closed');
  assert.equal(first.reason, null);
  assert.match(first.message, /degraded after 1 consecutive failure/);
  const second = recordObservation(first.table, A, { outcome: 'failure', tick: 2 });
  assert.equal(second.state, 'degraded');
  const third = recordObservation(second.table, A, { outcome: 'failure', tick: 3 });
  assert.equal(third.state, 'failing');
  assert.equal(third.circuit, 'open');
  assert.equal(third.reason, 'health.circuit_open');
  assert.match(third.message, /until tick 33/);
  const entry = healthOf(third.table, A);
  assert.equal(entry.consecutiveFailures, 3);
  assert.equal(entry.openedAtTick, 3);
  assert.equal(entry.coolOffTicks, DEFAULT_COOL_OFF_TICKS);
  assert.equal(healthOf(third.table, B).state, 'unknown', 'a neighbour is unaffected');
});

test('the threshold is configurable and the cool-off doubles, bounded', () => {
  const strict = createHealthTable(EPOCH, { threshold: 1, coolOffTicks: 4 });
  const opened = recordObservation(strict, A, { outcome: 'failure', tick: 10 });
  assert.equal(opened.circuit, 'open');
  assert.equal(opened.table.entries[A].coolOffTicks, 4);
  const probeFailed = recordObservation(opened.table, A, { outcome: 'failure', tick: 14 });
  assert.equal(probeFailed.table.entries[A].coolOffTicks, 8, 'a failed probe doubles the cool-off');
  let subject = probeFailed.table;
  let tick = 22;
  for (let round = 0; round < 12; round += 1) {
    const step = recordObservation(subject, A, { outcome: 'failure', tick });
    subject = step.table;
    tick += subject.entries[A].coolOffTicks;
  }
  assert.equal(healthOf(subject, A).coolOffTicks, MAX_COOL_OFF_TICKS, 'the back-off is bounded so a broken node stays visible');
});

/* ---------------------------------------------------------------- mayServe */

test('mayServe refuses an open circuit and names when a probe may be tried', () => {
  const opened = fail(fail(fail(table(), A, 1), A, 2), A, 3);
  const refused = refuses(mayServe(opened, A, { tick: 10 }), 'health.circuit_open');
  assert.equal(refused.retryAtTick, 33);
  assert.equal(refused.probe, false);
  assert.match(refused.message, /broken workflow/);
  const due = mayServe(opened, A, { tick: 33 });
  assert.equal(due.ok, true);
  assert.equal(due.probe, true, 'a probe, and exactly one');
  assert.equal(due.circuit, 'half-open');
  const healthy = mayServe(succeed(table(), B, 1), B, { tick: 2 });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.probe, false);
  assert.equal(healthy.state, 'healthy');
  const unknownNode = mayServe(table(), B, { tick: 1 });
  assert.equal(unknownNode.ok, true, 'unknown is not a refusal: it is unproven, and the runtime decides how to probe');
  assert.equal(unknownNode.state, 'unknown');
});

test('a success that was not allowed to happen does not close the circuit', () => {
  const opened = fail(fail(fail(table(), A, 1), A, 2), A, 3);
  const early = recordObservation(opened, A, { outcome: 'success', tick: 10 });
  assert.equal(early.ok, true);
  assert.equal(early.reason, 'health.circuit_open');
  assert.equal(early.circuit, 'open');
  assert.equal(early.state, 'failing');
  assert.match(early.message, /before its circuit was due \(tick 33\)/);
  assert.equal(healthOf(early.table, A).consecutiveFailures, 3, 'the failure history is not rewritten by an early success');
  assert.equal(healthOf(early.table, A).observationCount, 4);
  assert.equal(healthOf(early.table, A).lastOutcome, 'success');
});

test('a probe that succeeds closes the circuit and the node is healthy again', () => {
  const opened = fail(fail(fail(table(), A, 1), A, 2), A, 3);
  const closed = recordObservation(opened, A, { outcome: 'success', tick: 33 });
  assert.equal(closed.reason, null);
  assert.equal(closed.state, 'healthy');
  assert.equal(closed.circuit, 'closed');
  assert.equal(healthOf(closed.table, A).consecutiveFailures, 0);
  assert.equal(healthOf(closed.table, A).coolOffTicks, null);
  assert.equal(mayServe(closed.table, A, { tick: 34 }).ok, true);
  assert.equal(mayServe(closed.table, A, { tick: 34 }).probe, false);
});

/* --------------------------------------------------------------- quarantine */

test('quarantine records who asked and why, and refuses work', () => {
  const result = quarantineNode(table(), A, { reason: 'crashes the worker', origin: 'operator', tick: 7 });
  assert.equal(result.ok, true);
  const entry = healthOf(result.table, A);
  assert.equal(entry.state, 'quarantined');
  assert.equal(entry.circuit, 'open');
  assert.deepEqual(entry.quarantine, { origin: 'operator', reason: 'crashes the worker', tick: 7, detail: null });
  const refused = refuses(mayServe(result.table, A, { tick: 8 }), 'health.quarantined');
  assert.equal(refused.retryAtTick, null, 'a quarantine does not expire');
  assert.match(refused.message, /only an explicit release ends this/);
  assert.equal(isQuarantined(result.table, A), true);
  assert.equal(isQuarantined(result.table, B), false);
});

test('a quarantine outranks every observation and is not overwritten', () => {
  const quarantined = quarantineNode(table(), A, { reason: 'crashes the worker', tick: 7 }).table;
  const observed = recordObservation(quarantined, A, { outcome: 'success', tick: 9 });
  assert.equal(observed.ok, true);
  assert.equal(observed.changed, false);
  assert.equal(observed.reason, 'health.quarantined');
  assert.match(observed.message, /a success is not a release/);
  assert.equal(healthOf(observed.table, A).state, 'quarantined');
  assert.equal(healthOf(observed.table, A).observationCount, 1, 'the observation is still recorded');
  const again = refuses(quarantineNode(observed.table, A, { reason: 'something else', tick: 10 }), 'health.quarantined');
  assert.match(again.message, /released, not overwritten/);
  const identical = quarantineNode(observed.table, A, { reason: 'crashes the worker', tick: 11 });
  assert.equal(identical.ok, true);
  assert.equal(identical.changed, false);
  throwsWith(() => quarantineNode(table(), A, { reason: 'x', origin: 'vibes', tick: 1 }), 'health.input');
  throwsWith(() => quarantineNode(table(), A, { tick: 1 }), 'health.input');
  throwsWith(() => quarantineNode(table(), A, { reason: 'x' }), 'health.tick');
});

test('release returns a node to unknown, never to healthy', () => {
  const quarantined = quarantineNode(table(), A, { reason: 'crashes the worker', tick: 7 }).table;
  const released = releaseQuarantine(quarantined, A, { reason: 'patched in 4.4.1', tick: 20 });
  assert.equal(released.ok, true);
  assert.equal(healthOf(released.table, A).state, 'unknown');
  assert.equal(healthOf(released.table, A).quarantine, null);
  assert.deepEqual(healthOf(released.table, A).releasedAt, { origin: 'operator', reason: 'patched in 4.4.1', tick: 20 });
  assert.match(released.message, /not to 'healthy'/);
  assert.equal(mayServe(released.table, A, { tick: 21 }).ok, true);
  assert.equal(mayServe(released.table, A, { tick: 21 }).state, 'unknown');
  const nothingToRelease = refuses(releaseQuarantine(released.table, A, { reason: 'again', tick: 22 }), 'health.quarantined');
  assert.match(nothingToRelease.message, /nothing to release/);
  throwsWith(() => releaseQuarantine(quarantined, A, { tick: 1 }), 'health.input');
  throwsWith(() => releaseQuarantine(quarantined, A, { reason: 'x', origin: 'nobody', tick: 1 }), 'health.input');
});

/* ------------------------------------------------------------- reads, verify */

test('describeHealth counts states, open circuits and quarantines', () => {
  let subject = table();
  subject = fail(fail(fail(subject, A, 1), A, 2), A, 3);
  subject = succeed(subject, B, 1);
  const described = describeHealth(subject);
  assert.equal(described.nodeCount, 2);
  assert.deepEqual({ ...described.byState }, { failing: 1, healthy: 1 });
  assert.deepEqual([...described.openCircuits], [A]);
  assert.deepEqual([...described.quarantined], []);
  assert.equal(described.threshold, DEFAULT_FAILURE_THRESHOLD);
  assert.equal(Object.isFrozen(described), true);
  const quarantined = quarantineNode(subject, B, { reason: 'policy', origin: 'policy', tick: 4 });
  const withQuarantine = describeHealth(quarantined.table);
  assert.deepEqual([...withQuarantine.quarantined], [{ identity: B, origin: 'policy', reason: 'policy', tick: 4 }]);
  assert.deepEqual({ ...withQuarantine.byState }, { failing: 1, quarantined: 1 });
});

test('verification catches an edited table and a foreign epoch', () => {
  const subject = succeed(table(), A, 1);
  const forged = Object.freeze({
    ...subject,
    entries: Object.freeze({ ...subject.entries, [A]: Object.freeze({ ...subject.entries[A], state: 'quarantined' }) }),
  });
  const verdict = verifyHealthTable(forged);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'health.table');
  const other = compileRegistryEpoch({ declarations: [declaration('n8n-nodes-base.noOp', 1)], source: 'p6.11-test' });
  const foreign = verifyHealthTable(subject, other);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'health.epoch');
});

test('the error type is exported, and a refusal to serve is data rather than an exception', () => {
  const error = new NodeHealthError('x');
  assert.equal(error instanceof Error, true);
  assert.equal(error.code, 'lego.contract_violation');
  assert.equal(Object.isFrozen(error.meta), true);
  assert.doesNotThrow(() => mayServe(quarantineNode(table(), A, { reason: 'x', tick: 1 }).table, A, { tick: 2 }));
});

/* ------------------------------------------------------------------ scope walls */

test('P6.11 is pure: the only node import is the hash, and there is no I/O or timer', () => {
  const source = readFileSync(new URL('../src/lego/node-health.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'setInterval', 'performance.', 'fetch(']) {
    assert.equal(code.includes(forbidden), false, `the health table must not reference ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/from '(node:[a-z_/]+)'/g)].map((match) => match[1]), ['node:crypto']);
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false, 'health is history: tick is data, and a clock would make it unreproducible');
  assert.ok(code.includes("from './node-registry.mjs'"), 'the state vocabulary is quoted from P6.1');
});

test('P6.11 stays inside its walls: no execution, no lease, no lifecycle, no revocation', () => {
  const source = readFileSync(new URL('../src/lego/node-health.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['runtime-lease', 'node-lifecycle', 'node-residency', 'capability-compiler', 'supply-chain', 'registry-compiler', 'spawn', 'node:vm', 'eval(', 'uninstall(']) {
    assert.equal(code.includes(forbidden), false, `P6.11 must not reach into ${forbidden}: that belongs to a later or different contract`);
  }
  assert.match(NODE_HEALTH_RULES.authority, /per-host operational state/);
});

/* ------------------------------------------------------------------- lock row */

test('the contract-lock row is canonical: one row, version, ops, tests, exports, domain path', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'node.health');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, NODE_HEALTH_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.equal(rows[0].status, 'implemented');
  assert.deepEqual(rows[0].surface, ['src/lego/node-health.mjs']);
  assert.deepEqual(rows[0].tests, ['apps/n8n-lego/test/lego-node-health.test.mjs']);
  for (const name of ['createHealthTable', 'recordObservation', 'mayServe', 'quarantineNode', 'releaseQuarantine', 'verifyHealthTable']) {
    assert.equal(rows[0].exports['src/lego/node-health.mjs'].includes(name), true, `${name} must be locked`);
  }
  for (const id of ['node.registry', 'registry.compiler', 'package.transaction', 'registry.closure', 'node.resolution', 'runtime.lease', 'node.residency', 'node.capability', 'node.semantics', 'node.lifecycle']) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, '0.1.0', `P6.11 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/node-health.mjs'));
});
