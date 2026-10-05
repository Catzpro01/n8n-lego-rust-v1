/**
 * P6.6 — Runtime lease + side-by-side upgrade. Contract `runtime.lease@0.1.0`.
 *
 * Matrix: registration (including the refusal to reuse a retired epoch NUMBER
 * with different content), admission rules (a draining or retired epoch takes no
 * new work while everything inside keeps running), derived lease identity and
 * idempotent re-acquire/release, the drain → retire gate (retire needs a drain,
 * and needs zero outstanding leases, and the refusal names who is holding it),
 * side-by-side serving of several epochs, the table sequence instead of a clock,
 * and the scope walls.
 *
 * Epochs are real: they come from P6.2, built from P6.1 declarations.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileRegistryEpoch } from '../src/lego/registry-compiler.mjs';
import {
  EPOCH_SERVING_STATES,
  LEASE_STATES,
  RUNTIME_LEASE_CONTRACT,
  RUNTIME_LEASE_CONTRACT_VERSION,
  RUNTIME_LEASE_INPUT_SCHEMA_VERSION,
  RUNTIME_LEASE_OPERATIONS,
  RUNTIME_LEASE_PERMISSIONS,
  RUNTIME_LEASE_REASONS,
  RUNTIME_LEASE_RULES,
  RUNTIME_LEASE_SCHEMA_VERSION,
  RuntimeLeaseError,
  acquireLease,
  activeExecutions,
  createLeaseTable,
  describeLeaseTable,
  drainEpoch,
  drainingEpochs,
  epochsHeldBy,
  formatLeaseTable,
  isFullyDrained,
  isLeaseTable,
  leasesOfExecution,
  outstandingLeases,
  registerEpoch,
  releaseLease,
  retireEpoch,
  servingEpochs,
} from '../src/lego/runtime-lease.mjs';

const declaration = (typeVersion, digestChar) => ({
  type: 'n8n-nodes-base.httpRequest',
  typeVersion,
  package: 'n8n-nodes-base',
  packageVersion: '2.9.1',
  vendor: 'n8n',
  contractVersion: '1.0.0',
  implementationVersion: '1.0.0',
  digest: `sha256:${digestChar.repeat(64)}`,
  provenance: { kind: 'package-registry', source: 'npm:n8n-nodes-base@2.9.1' },
  capabilities: ['network'],
  trustClass: 'core',
  runtimeLocality: 'js-compat',
  resourceProfile: { cpu: 'low', memory: 'medium', disk: 'none', network: true, concurrency: 'parallel-safe', startup: 'fast' },
  compatibility: { contractRange: '^1.0.0', portabilityTargets: ['JS'] },
  lifecycle: 'declared',
  health: 'unknown',
  discovery: { displayName: 'HTTP Request', group: 'input', description: '' },
});

const epochOf = (declarations, source, parent = null) => {
  const epoch = parent
    ? compileRegistryEpoch({ declarations, source, epochNumber: parent.epochNumber + 1, parent })
    : compileRegistryEpoch({ declarations, source });
  assert.equal(epoch.ok, true, `fixture epoch must compile: ${JSON.stringify(epoch.errors ?? [])}`);
  return epoch;
};

const E1 = epochOf([declaration(4, 'a')], 'catalog:one');
const E2 = epochOf([declaration(4, 'a'), declaration(5, 'b')], 'catalog:two', E1);
const E3 = epochOf([declaration(4, 'a'), declaration(5, 'b'), declaration(6, 'c')], 'catalog:three', E2);

/** A table with E1 and E2 registered for serving. */
const servingTable = () => registerEpoch(registerEpoch(createLeaseTable(), E1), E2);
const lease = (table, executionId, epoch = E1) => {
  const result = acquireLease(table, { executionId, epoch });
  assert.equal(result.ok, true, `expected a lease for ${executionId}: ${result.reason}`);
  return result;
};

/* ---------------------------------------------------------------- contract */

test('the contract identifies itself, is versioned and declares its states', () => {
  assert.equal(RUNTIME_LEASE_CONTRACT, 'runtime.lease@0.1.0');
  assert.equal(RUNTIME_LEASE_CONTRACT_VERSION, '0.1.0');
  assert.equal(RUNTIME_LEASE_SCHEMA_VERSION, 1);
  assert.deepEqual([...RUNTIME_LEASE_OPERATIONS], ['lease', 'release', 'drain', 'retire', 'describe']);
  assert.deepEqual([...EPOCH_SERVING_STATES], ['serving', 'draining', 'retired']);
  assert.deepEqual([...LEASE_STATES], ['active', 'released']);
  assert.ok(RUNTIME_LEASE_PERMISSIONS.every((word) => typeof word === 'string'));
  assert.equal(RUNTIME_LEASE_INPUT_SCHEMA_VERSION, 1);
});

test('the refusal vocabulary is closed, prefixed and free of duplicates', () => {
  assert.ok(RUNTIME_LEASE_REASONS.length >= 6);
  assert.equal(new Set(RUNTIME_LEASE_REASONS).size, RUNTIME_LEASE_REASONS.length);
  assert.ok(RUNTIME_LEASE_REASONS.every((reason) => reason.startsWith('lease.')));
  assert.match(RUNTIME_LEASE_RULES.digest, /DIGEST/);
  assert.match(RUNTIME_LEASE_RULES.gate, /names who is still holding it/);
  assert.match(RUNTIME_LEASE_RULES.order, /draining comes before retiring/);
});

/* ----------------------------------------------------------------- table */

test('a fresh table is empty, frozen and carries a sequence instead of a clock', () => {
  const table = createLeaseTable();
  assert.equal(table.sequence, 0);
  assert.deepEqual(Object.keys(table.serving), []);
  assert.deepEqual(Object.keys(table.leases), []);
  assert.ok(isLeaseTable(table));
  assert.ok(Object.isFrozen(table));
  assert.equal(Object.hasOwn(table, 'now'), false);
  assert.equal(Object.hasOwn(table, 'createdAt'), false);
  for (const fn of [describeLeaseTable, servingEpochs, drainingEpochs, isFullyDrained, activeExecutions, formatLeaseTable]) {
    assert.throws(() => fn({ ok: true }), RuntimeLeaseError, `${fn.name} must refuse a forged table`);
  }
  assert.equal(isLeaseTable({ ...table }), false, 'a shallow copy is not a table');
  assert.equal(isLeaseTable(JSON.parse(JSON.stringify(table))), false);
});

test('registration is idempotent and refuses an epoch this contract did not compile', () => {
  const once = registerEpoch(createLeaseTable(), E1);
  const twice = registerEpoch(once, E1);
  assert.equal(twice, once, 'registering the same epoch twice changes nothing');
  assert.deepEqual(servingEpochs(once).map((entry) => entry.epochNumber), [1]);
  assert.throws(() => registerEpoch(createLeaseTable(), { ok: true, epochNumber: 1, epochDigest: 'x' }), RuntimeLeaseError);
  assert.throws(() => registerEpoch(createLeaseTable(), E1.byIdentity), RuntimeLeaseError);
});

test('a retired epoch number cannot be reused by different content', () => {
  let table = drainEpoch(registerEpoch(createLeaseTable(), E1), E1).table;
  table = retireEpoch(table, E1).table;
  const impostor = epochOf([declaration(9, 'd')], 'catalog:impostor');
  assert.equal(impostor.epochNumber, E1.epochNumber, 'the fixture reuses the number on purpose');
  assert.notEqual(impostor.epochDigest, E1.epochDigest);
  assert.throws(() => registerEpoch(table, impostor), (error) => error.meta.code === 'lease.digest');
  // Re-registering the epoch that was retired under the same digest is allowed
  // (a restart re-registers what it already had) and stays retired.
  assert.equal(registerEpoch(table, E1), table);
});

/* ----------------------------------------------------------------- lease */

test('a lease names the epoch digest it runs under, not a version or a pointer', () => {
  const { table, lease: held } = lease(servingTable(), 'exec-1');
  assert.equal(held.epochDigest, E1.epochDigest);
  assert.equal(held.epochNumber, E1.epochNumber);
  assert.equal(held.source ?? held.epochSource, E1.source);
  assert.equal(held.state, 'active');
  assert.equal(table.sequence, 3, 'two registrations and one admission');
  assert.equal(table.admitted, 1);
  assert.ok(Object.isFrozen(held));
});

test('a lease id is derived, so a retried acquire is the same lease, not a second one', () => {
  const first = lease(servingTable(), 'exec-1');
  const again = acquireLease(first.table, { executionId: 'exec-1', epoch: E1 });
  assert.equal(again.ok, true);
  assert.equal(again.reason, 'already-held');
  assert.equal(again.lease.leaseId, first.lease.leaseId);
  assert.equal(again.table.admitted, 1, 'a re-acquire is not a new admission');
  const differentEpoch = acquireLease(first.table, { executionId: 'exec-1', epoch: E2 });
  assert.notEqual(differentEpoch.lease.leaseId, first.lease.leaseId, 'the same execution under two epochs is two leases');
  assert.equal(leasesOfExecution(differentEpoch.table, 'exec-1').length, 2);
});

test('an anonymous lease is refused and an unregistered epoch is not leasable', () => {
  assert.throws(() => acquireLease(servingTable(), { epoch: E1 }), (error) => error.meta.code === 'lease.execution');
  assert.throws(() => acquireLease(servingTable(), { executionId: ' ', epoch: E1 }), (error) => error.meta.code === 'lease.execution');
  assert.throws(() => acquireLease(servingTable(), { executionId: 'exec-1', epoch: E3 }), (error) => {
    assert.equal(error.meta.code, 'lease.epoch');
    assert.match(error.message, /work nobody is counting/);
    return true;
  });
  assert.throws(() => acquireLease(servingTable(), { executionId: 'exec-1' }), RuntimeLeaseError);
});

test('releasing is idempotent, and releasing an unknown lease is reported', () => {
  const first = lease(servingTable(), 'exec-1');
  const released = releaseLease(first.table, first.lease);
  assert.equal(released.ok, true);
  assert.equal(released.lease.state, 'released');
  assert.equal(outstandingLeases(released.table, E1).length, 0);
  const again = releaseLease(released.table, first.lease);
  assert.equal(again.reason, 'already-released');
  assert.equal(again.table, released.table, 'releasing twice changes nothing');
  assert.equal(outstandingLeases(released.table, E1.epochDigest).length, 0);
  const unknown = releaseLease(released.table, 'lease:missing');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'lease.unknown');
  assert.throws(() => releaseLease(released.table, null), RuntimeLeaseError);
});

/* ----------------------------------------------------------- drain/retire */

test('draining stops new work while everything already inside keeps running', () => {
  const first = lease(servingTable(), 'exec-1');
  const drained = drainEpoch(first.table, E1);
  assert.equal(drained.ok, true);
  assert.equal(drained.reason, 'draining');
  assert.deepEqual(drained.outstanding.map((entry) => entry.executionId), ['exec-1']);

  const refused = acquireLease(drained.table, { executionId: 'exec-2', epoch: E1 });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'lease.state');
  assert.equal(refused.error.state, 'draining');
  assert.match(refused.error.message, /everything already inside keeps running/);

  // The lease that was already held is untouched, and the new epoch takes new work.
  assert.equal(outstandingLeases(drained.table, E1).length, 1);
  assert.equal(acquireLease(drained.table, { executionId: 'exec-2', epoch: E2 }).ok, true);
  assert.equal(drainingEpochs(drained.table)[0].outstanding, 1);
  assert.equal(isFullyDrained(drained.table), false);
  assert.equal(isFullyDrained(releaseLease(drained.table, first.lease).table), true);
});

test('draining an empty epoch says so, and draining twice is a no-op', () => {
  const drained = drainEpoch(servingTable(), E1);
  assert.equal(drained.reason, 'drained-empty');
  assert.deepEqual([...drained.outstanding], []);
  const again = drainEpoch(drained.table, E1);
  assert.equal(again.reason, 'already-draining');
  assert.equal(again.table, drained.table);
  assert.equal(again.drained, false);
});

test('draining or retiring an epoch that was never registered is refused', () => {
  assert.throws(() => drainEpoch(servingTable(), E3), (error) => error.meta.code === 'lease.epoch');
  assert.throws(() => retireEpoch(servingTable(), E3), (error) => error.meta.code === 'lease.epoch');
});

test('an epoch is drained before it is retired — a deploy is not a race', () => {
  const refused = retireEpoch(servingTable(), E1);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'lease.state');
  assert.match(refused.error.message, /drain it before retiring/);
});

test('retirement is gated on the leases and names who is still holding the epoch', () => {
  const first = lease(servingTable(), 'exec-1');
  const second = lease(first.table, 'exec-2');
  const drained = drainEpoch(second.table, E1);
  const blocked = retireEpoch(drained.table, E1);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'lease.outstanding');
  assert.deepEqual([...blocked.error.outstanding], ['exec-1', 'exec-2']);
  assert.match(blocked.error.message, /2 executions still running/);
  assert.equal(describeLeaseTable(blocked.table).refused, 1);

  const one = releaseLease(drained.table, first.lease).table;
  assert.equal(retireEpoch(one, E1).reason, 'lease.outstanding', 'one holder is still a holder');
  const none = releaseLease(one, second.lease).table;
  const retired = retireEpoch(none, E1);
  assert.equal(retired.ok, true);
  assert.equal(retired.retired, true);
  assert.equal(retired.table.retirements, 1);
  assert.deepEqual(describeLeaseTable(retired.table).retired.map((entry) => entry.epochNumber), [1]);
});

test('retiring twice is a no-op and a retired epoch takes no new work', () => {
  const drained = drainEpoch(servingTable(), E1);
  const retired = retireEpoch(drained.table, E1);
  const again = retireEpoch(retired.table, E1);
  assert.equal(again.reason, 'already-retired');
  assert.equal(again.table, retired.table);
  const refused = acquireLease(retired.table, { executionId: 'exec-9', epoch: E1 });
  assert.equal(refused.reason, 'lease.state');
  assert.equal(refused.error.state, 'retired');
  assert.match(refused.error.message, /takes no new work/);
  // And a second drain of a retired epoch is honest about it.
  assert.equal(drainEpoch(retired.table, E1).reason, 'already-retired');
});

/* ------------------------------------------------------------- side by side */

test('side-by-side: the old epoch serves in-flight work while the new one takes new work', () => {
  const inFlight = lease(servingTable(), 'exec-old', E1);
  const newWork = lease(inFlight.table, 'exec-new', E2);
  const described = describeLeaseTable(newWork.table);
  assert.deepEqual(described.serving.map((entry) => entry.epochNumber), [1, 2]);
  assert.equal(described.activeLeases, 2);
  assert.equal(described.activeByEpoch[E1.epochDigest], 1);
  assert.equal(described.activeByEpoch[E2.epochDigest], 1);
  assert.deepEqual(described.draining, []);
  assert.equal(described.drained, true, 'nothing is draining, so a deploy would be free to finish');
  assert.equal(activeExecutions(newWork.table).length, 2);

  // Draining the old epoch does not touch the new one.
  const drained = drainEpoch(newWork.table, E1);
  assert.deepEqual(servingEpochs(drained.table).map((entry) => entry.epochNumber), [2]);
  assert.equal(acquireLease(drained.table, { executionId: 'exec-older', epoch: E1 }).reason, 'lease.state');
  assert.equal(acquireLease(drained.table, { executionId: 'exec-newer', epoch: E2 }).ok, true);
  assert.equal(isFullyDrained(drained.table), false);
  assert.equal(isFullyDrained(releaseLease(drained.table, inFlight.lease).table), true);
});

test('epochsHeldBy answers what a rollback must respect', () => {
  const one = lease(servingTable(), 'exec-1', E1);
  const two = lease(one.table, 'exec-2', E2);
  const three = lease(two.table, 'exec-3', E2);
  assert.deepEqual([...epochsHeldBy(three.table, ['exec-2', 'exec-3'])], [E2.epochDigest]);
  assert.deepEqual([...epochsHeldBy(three.table, ['exec-1'])], [E1.epochDigest]);
  assert.deepEqual([...epochsHeldBy(three.table, ['exec-1', 'exec-2'])].sort(), [E1.epochDigest, E2.epochDigest].sort());
  assert.deepEqual([...epochsHeldBy(three.table, new Set(['nobody']))], []);
  assert.throws(() => epochsHeldBy(three.table, 'exec-1'), RuntimeLeaseError);
});

/* ------------------------------------------------------------------ reads */

test('describe and format summarize the table without a clock', () => {
  const first = lease(servingTable(), 'exec-1');
  const drained = drainEpoch(first.table, E1);
  const described = describeLeaseTable(drained.table);
  assert.equal(described.contract, RUNTIME_LEASE_CONTRACT);
  assert.equal(described.sequence, drained.table.sequence);
  assert.equal(described.draining[0].epochNumber, 1);
  assert.equal(described.draining[0].outstanding, 1);
  assert.equal(described.drained, false);
  assert.equal(described.leases, 1);
  assert.equal(described.admitted, 1);
  assert.ok(Object.isFrozen(described) && Object.isFrozen(described.serving));
  assert.equal(formatLeaseTable(drained.table), 'leases: 1 active / 1 draining / 0 retired — 2 epochs known');
});

test('the table sequence is monotonic and independent of the operations that move it fast', () => {
  let table = servingTable();
  const seen = [table.sequence];
  const step = (result) => { assert.equal(result.table.sequence, table.sequence + 1, 'every operation advances the sequence by exactly one'); table = result.table; seen.push(table.sequence); };
  step(lease(table, 'exec-1'));
  step(releaseLease(table, leasesOfExecution(table, 'exec-1')[0]));
  step(drainEpoch(table, E1));
  step(retireEpoch(table, E1));
  assert.deepEqual(seen, [2, 3, 4, 5, 6]);
  assert.deepEqual([...seen].sort((a, b) => a - b), seen, 'never decreasing');
});

test('the same operation sequence produces the same table on any host', () => {
  const run = () => {
    let table = servingTable();
    table = lease(table, 'exec-1').table;
    table = drainEpoch(table, E1).table;
    table = releaseLease(table, leasesOfExecution(table, 'exec-1')[0]).table;
    return retireEpoch(table, E1).table;
  };
  const a = run();
  const b = run();
  assert.deepEqual(describeLeaseTable(a), describeLeaseTable(b));
  assert.equal(a.sequence, b.sequence);
});

/* ------------------------------------------------------------ scope walls */

test('P6.6 publishes exactly one contract row and leaves the rest of P6 alone', () => {
  const lock = JSON.parse(readFileSync(new URL('../src/lego/contracts/contract-lock.json', import.meta.url)));
  const rows = lock.contracts.filter((contract) => contract.id === 'runtime.lease');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].version, RUNTIME_LEASE_CONTRACT_VERSION);
  assert.equal(rows[0].domain, 'node-registry');
  assert.deepEqual(rows[0].surface, ['src/lego/runtime-lease.mjs']);
  for (const [id, version] of [['node.registry', '0.1.0'], ['registry.compiler', '0.1.0'], ['package.transaction', '0.1.0'], ['registry.closure', '0.1.0'], ['node.resolution', '0.1.0']]) {
    assert.equal(lock.contracts.find((contract) => contract.id === id).version, version, `P6.6 must not re-version ${id}`);
  }
  const domain = JSON.parse(readFileSync(new URL('../src/lego/manifest/domains.json', import.meta.url)))
    .domains.find((entry) => entry.id === 'node-registry');
  assert.equal(domain.contract.id, 'node.portability');
  assert.ok(domain.paths.includes('src/lego/runtime-lease.mjs'));
});

test('P6.6 is pure: no clock, no filesystem, no network, no execution', () => {
  const source = readFileSync(new URL('../src/lego/runtime-lease.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['node:fs', 'node:net', 'node:http', 'node:os', 'node:child_process', 'process.', 'Math.random', 'setTimeout', 'performance.']) {
    assert.equal(code.includes(forbidden), false, `runtime lease must not reference ${forbidden}`);
  }
  assert.equal(/\bnew Date\b|\bDate\.now\b/.test(code), false, 'a lease table that reads a clock is not reproducible');
  assert.equal(code.includes('foundation.mjs'), false, 'the foundation accessor stays outside the published surface (gate rule R4)');
  assert.match(source, /from '\.\/registry-compiler\.mjs'/);
  for (const other of ['execution-ir', 'bounded-frontier', 'workflow-graph', 'resource-guard', 'node-portability']) {
    assert.equal(code.includes(other), false, `P6.6 must not reach into ${other}`);
  }
});

test('P6.6 scope walls: no residency, capability, health, quarantine or canary', () => {
  const names = Object.keys({
    RUNTIME_LEASE_CONTRACT, RUNTIME_LEASE_OPERATIONS, RUNTIME_LEASE_PERMISSIONS, RUNTIME_LEASE_SCHEMA_VERSION,
    RUNTIME_LEASE_REASONS, RUNTIME_LEASE_RULES, EPOCH_SERVING_STATES, LEASE_STATES, RuntimeLeaseError,
    createLeaseTable, isLeaseTable, registerEpoch, acquireLease, releaseLease, drainEpoch, retireEpoch,
    outstandingLeases, servingEpochs, drainingEpochs, isFullyDrained, describeLeaseTable, formatLeaseTable,
    leasesOfExecution, activeExecutions, epochsHeldBy,
  }).join(' ');
  for (const later of ['residency', 'capabilit', 'quarantine', 'health', 'canary', 'attest', 'sbom', 'fingerprint', 'provenance']) {
    assert.equal(new RegExp(later, 'i').test(names), false, `${later} belongs to a later milestone`);
  }
});
